import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stageProvidedSkills, verifyProvidedSkills, type ProvidedSkill, type StagedSkill } from './skills.js';
import { BridgeError } from './types.js';
import { stageExecutionPolicy, verifyExecutionPolicy, discardExecutionPolicy, EXECUTION_POLICY_PATHS, type StagedExecutionPolicy } from './execution-policy.js';
import type { ResolvedAgentPolicy, McpCatalogEntry } from './agent-policy.js';
import { DEFAULT_PROJECT_LIMITS, type ProjectLimits } from './config.js';
import {
  preflightProjectFiles,
  type BlockedPath,
  type PreflightRecord,
} from './secret-preflight.js';
import { terminateSubprocess, redactDiagnostic } from './subprocess.js';

export type { BlockedPath } from './secret-preflight.js';

const maxGitOutput = 10_000_000;

export interface ExecutionPolicyRequest { policy: ResolvedAgentPolicy; catalog: McpCatalogEntry[]; stateDirectory: string; executionId: string }

export interface ProjectCopy {
  executionPolicy?: StagedExecutionPolicy;
  executionStateDirectory?: string;
  providedSkills?: readonly StagedSkill[];
  sourceDirectory: string;
  copyDirectory: string;
  gitDirectory: string;
  baseline: Map<string, string>;
  includedFiles: string[];
  blockedFiles?: BlockedPath[];
}

export interface ChangePreview {
  files: Array<{ status: string; path: string }>;
  fileSummaries: Array<{ status: string; path: string; insertions: number | null; deletions: number | null; binary: boolean }>;
  summary: { filesChanged: number; added: number; modified: number; deleted: number; insertions: number; deletions: number; binaryFiles: number };
  patch: string;
  sha256: string;
  sourceDirectory: string;
  copyDirectory: string;
}

export async function verifyManagedCopy(project: ProjectCopy): Promise<void> {
  await verifyProvidedSkills(project.copyDirectory, project.providedSkills ?? []);
  if (project.executionPolicy) {
    if (!project.executionStateDirectory) throw new BridgeError('INVALID_AGENT_POLICY', 'Execution policy state binding is missing');
    await verifyExecutionPolicy(project.copyDirectory, project.executionPolicy, project.executionStateDirectory);
  }
}

function executionExclusions(project: ProjectCopy): string[] {
  return project.executionPolicy ? EXECUTION_POLICY_PATHS.map(file => ':(exclude,literal)' + file) : [];
}

export async function stageProjectExecutionPolicy(project: ProjectCopy, request: ExecutionPolicyRequest, limits: ProjectLimits): Promise<void> {
  if (project.executionPolicy) throw new BridgeError('INVALID_AGENT_POLICY', 'The copy already has an execution policy');
  const snapshot = await snapshotCopyFiles(project, limits);
  let bytes = 0;
  for (const file of snapshot.keys()) bytes += (await lstat(await checkedPath(project.copyDirectory, file, true))).size;
  project.executionPolicy = await stageExecutionPolicy(project.copyDirectory, { ...request, skillFiles: (project.providedSkills ?? []).flatMap(skill => skill.files.map(file => file.path)) },
    { ...limits, maxCopyFiles: limits.maxCopyFiles - snapshot.size, maxCopyBytes: limits.maxCopyBytes - bytes });
  project.executionStateDirectory = request.stateDirectory;
}

export async function discardProjectCopy(project: ProjectCopy): Promise<void> {
  const root = await realpath(os.tmpdir());
  const targets = [
    [project.copyDirectory, 'agy-mcp-copy-'],
    [project.gitDirectory, 'agy-mcp-baseline-'],
  ];
  for (const [directory, prefix] of targets) {
    const absolute = path.resolve(directory!);
    if (path.relative(root, await realpath(path.dirname(absolute))) !== '' || !path.basename(absolute).startsWith(prefix!)) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Refusing to delete a directory outside bridge temporary storage');
    }
    const info = await lstat(absolute).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new BridgeError('UNSAFE_PROJECT_PATH', 'Refusing to delete a replaced copy directory');
  }
  for (const [directory] of targets) await rm(path.resolve(directory!), { recursive: true, force: true });
  if (project.executionPolicy) {
    if (!project.executionStateDirectory) throw new BridgeError('INVALID_AGENT_POLICY', 'Private execution storage binding is missing');
    await discardExecutionPolicy(project.executionPolicy, project.executionStateDirectory);
  }
}

export async function git(cwd: string, args: string[], input?: Buffer, allowedCodes = [0]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let childProc: ChildProcessWithoutNullStreams;
    try {
      childProc = spawn('git', args, { cwd, windowsHide: true, stdio: 'pipe' });
    } catch (err) {
      reject(new BridgeError('GIT_OPERATION_FAILED', redactDiagnostic((err as Error).message)));
      return;
    }
    const child: ChildProcessWithoutNullStreams = childProc;

    let settled = false;
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      terminateSubprocess(child);
      reject(error);
    };

    const settleResolve = (result: Buffer) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let ioError: Error | null = null;
    const recordIoError = (error: Error) => {
      if (!ioError) ioError = error;
      terminateSubprocess(child);
    };

    const chunks: Buffer[] = [];
    let length = 0;
    let stderr = '';
    let overflow = false;

    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > maxGitOutput) {
        overflow = true;
        terminateSubprocess(child);
      } else {
        chunks.push(chunk);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });

    child.stdin.on('error', error => {
      recordIoError(error);
    });

    child.stdout.on('error', error => {
      recordIoError(error);
    });

    child.stderr.on('error', error => {
      recordIoError(error);
    });

    child.once('error', error => {
      settleReject(new BridgeError('GIT_OPERATION_FAILED', redactDiagnostic(error.message)));
    });

    child.once('close', code => {
      if (overflow) {
        settleReject(new BridgeError('ISOLATION_TOO_LARGE', 'Git output exceeds the isolation limit'));
      } else if (ioError) {
        settleReject(new BridgeError('GIT_OPERATION_FAILED', redactDiagnostic(ioError.message || 'Git stream communication error')));
      } else if (!allowedCodes.includes(code ?? -1)) {
        const diag = stderr.trim() || 'git exited with code ' + code;
        settleReject(new BridgeError('GIT_OPERATION_FAILED', redactDiagnostic(diag)));
      } else {
        settleResolve(Buffer.concat(chunks));
      }
    });

    if (input !== undefined) {
      try {
        child.stdin.end(input);
      } catch (err) {
        recordIoError(err as Error);
      }
    } else {
      try {
        child.stdin.end();
      } catch (err) {
        recordIoError(err as Error);
      }
    }
  });
}

function splitNull(bytes: Buffer): string[] {
  return bytes.toString('utf8').split('\0').filter(Boolean);
}

const WINDOWS_DEVICE_REGEX = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export function validRelative(input: string): string {
  if (typeof input !== 'string' || !input || input.includes('\0')) {
    throw new BridgeError('INVALID_INCLUDE_PATH', 'Path must be a non-empty string without NUL');
  }
  let norm = input.replaceAll('\\', '/');
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.startsWith('//')) {
    throw new BridgeError('INVALID_INCLUDE_PATH', 'Path must be relative: ' + input);
  }
  if (norm.endsWith('/')) {
    norm = norm.slice(0, -1);
  }
  const parts = norm.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) {
    throw new BridgeError('INVALID_INCLUDE_PATH', 'Path must not contain traversal or empty segments: ' + input);
  }

  // Exact .git is rejected everywhere
  if (parts.some(p => p === '.git')) {
    throw new BridgeError('INVALID_INCLUDE_PATH', 'Path must not contain .git: ' + input);
  }

  // Windows-specific path validations
  if (process.platform === 'win32') {
    if (input.includes(':')) {
      throw new BridgeError('INVALID_INCLUDE_PATH', 'Windows Alternate Data Streams (colons) are forbidden: ' + input);
    }
    for (const part of parts) {
      if (WINDOWS_DEVICE_REGEX.test(part)) {
        throw new BridgeError('INVALID_INCLUDE_PATH', 'Windows reserved device names are forbidden: ' + input);
      }
      if (part.toLowerCase() === '.git' || /^git~\d+$/i.test(part)) {
        throw new BridgeError('INVALID_INCLUDE_PATH', 'Windows .git aliases are forbidden: ' + input);
      }
    }
  }

  return parts.join('/');
}

export async function checkedPath(root: string, relative: string, mustExist: boolean): Promise<string> {
  const parts = validRelative(relative).split('/');
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!mustExist && (error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory()) ||
        (index === parts.length - 1 && mustExist && !info.isFile())) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Project copy cannot use links or non-regular files: ' + relative);
    }
  }
  return current;
}

async function sha256File(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

export async function validateProjectRoot(sourceDirectory: string): Promise<void> {
  let top: string;
  try { top = (await git(sourceDirectory, ['rev-parse', '--show-toplevel'])).toString('utf8').trim(); }
  catch { throw new BridgeError('ISOLATION_REQUIRES_GIT', 'Isolated copies require a Git repository'); }
  if (path.relative(await realpath(top), await realpath(sourceDirectory)) !== '') {
    throw new BridgeError('INVALID_WORKING_DIRECTORY', 'workingDirectory must be the Git repository root');
  }
}

export async function enumerateGitCandidates(sourceDirectory: string): Promise<string[]> {
  await validateProjectRoot(sourceDirectory);
  const candidates = [...new Set(splitNull(await git(sourceDirectory, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])))];
  if (!candidates.length) return [];
  const ignored = new Set(splitNull(await git(sourceDirectory,
    ['check-ignore', '--no-index', '--stdin', '-z'], Buffer.from(candidates.join('\0') + '\0'), [0, 1])));
  return candidates.filter(file => {
    if (ignored.has(file)) return false;
    const parts = file.split('/');
    if (parts.some(p => p === '.git')) return false;
    if (process.platform === 'win32' && parts.some(p => p.toLowerCase() === '.git' || /^git~\d+$/i.test(p))) return false;
    return true;
  }).sort();
}

export async function listProjectFiles(sourceDirectory: string, limits: ProjectLimits = DEFAULT_PROJECT_LIMITS, blockedCollector?: BlockedPath[]): Promise<string[]> {
  const unignored = await enumerateGitCandidates(sourceDirectory);
  if (!unignored.length) return [];
  const preflight = await preflightProjectFiles(sourceDirectory, unignored, limits);
  if (blockedCollector) {
    blockedCollector.push(...preflight.blocked);
  }
  return preflight.eligible.sort();
}

export interface WritableHandle {
  write(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesWritten: number }>;
}

export async function writeAll(handle: WritableHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (bytesWritten <= 0) {
      throw new BridgeError('COPY_WRITE_FAILED', 'Zero progress while writing file');
    }
    offset += bytesWritten;
  }
}

export async function copyVerifiedFile(
  source: string,
  target: string,
  relative: string,
  record: PreflightRecord | undefined,
  budget: { remainingBytes: number },
  errorCode: 'SOURCE_CHANGED' | 'CONTEXT_CHANGED'
): Promise<string> {
  if (!record) {
    throw new BridgeError(errorCode, (errorCode === 'SOURCE_CHANGED' ? 'Source changed during copy: ' : 'Context changed during copy: ') + relative);
  }

  const srcHandle = await open(source, 'r');
  let dstHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const fstat = await srcHandle.stat();
    const currentLstat = await lstat(source);
    if (currentLstat.isSymbolicLink() || !currentLstat.isFile() || !fstat.isFile()) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Project copy cannot use links or non-regular files: ' + relative);
    }
    if (currentLstat.ino !== fstat.ino || currentLstat.dev !== fstat.dev || currentLstat.size !== fstat.size) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Project copy detected file replacement: ' + relative);
    }

    if (fstat.size > budget.remainingBytes) {
      throw new BridgeError('COPY_LIMIT_EXCEEDED', errorCode === 'SOURCE_CHANGED' ? 'Source grew beyond the copy byte limit during copying' : 'Context copy exceeds configured limits');
    }

    if (
      fstat.size !== record.size ||
      (record.ino !== 0 && fstat.ino !== record.ino) ||
      (record.dev !== 0 && fstat.dev !== record.dev)
    ) {
      throw new BridgeError(errorCode, (errorCode === 'SOURCE_CHANGED' ? 'Source changed during copy: ' : 'Context changed during copy: ') + relative);
    }

    await mkdir(path.dirname(target), { recursive: true });
    dstHandle = await open(target, 'w', fstat.mode);

    const CHUNK_SIZE = 64 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK_SIZE);
    const hash = createHash('sha256');
    let copiedBytes = 0;

    for (;;) {
      const { bytesRead } = await srcHandle.read(buf, 0, CHUNK_SIZE, null);
      if (bytesRead === 0) break;
      copiedBytes += bytesRead;
      if (copiedBytes > budget.remainingBytes) {
        throw new BridgeError('COPY_LIMIT_EXCEEDED', errorCode === 'SOURCE_CHANGED' ? 'Source grew beyond the copy byte limit during copying' : 'Context copy exceeds configured limits');
      }
      const slice = buf.subarray(0, bytesRead);
      hash.update(slice);
      await writeAll(dstHandle, slice);
    }

    const sha256 = hash.digest('hex');
    if (sha256 !== record.sha256 || copiedBytes !== record.size) {
      throw new BridgeError(errorCode, (errorCode === 'SOURCE_CHANGED' ? 'Source changed during copy: ' : 'Context changed during copy: ') + relative);
    }

    budget.remainingBytes -= copiedBytes;
    return sha256;
  } finally {
    if (dstHandle) {
      await dstHandle.close().catch(() => {});
    }
    await srcHandle.close().catch(() => {});
  }
}

export async function createProjectCopy(sourceDirectory: string, includePaths?: string[], onCreated?: (project: ProjectCopy) => void, limits: ProjectLimits = DEFAULT_PROJECT_LIMITS, skills: readonly ProvidedSkill[] = [], execution?: ExecutionPolicyRequest): Promise<ProjectCopy> {
  const unignored = await enumerateGitCandidates(sourceDirectory);
  if (!unignored.length) throw new BridgeError('ISOLATION_EMPTY', 'No eligible project files to copy');

  let candidatesToScan: string[];
  if (includePaths !== undefined) {
    if (!includePaths.length) throw new BridgeError('INVALID_INCLUDE_PATH', 'includePaths cannot be empty');
    const wanted = includePaths.map(validRelative);
    for (const item of wanted) {
      if (!unignored.some(file => file === item || file.startsWith(item + '/'))) {
        throw new BridgeError('INVALID_INCLUDE_PATH', 'No eligible file matches: ' + item);
      }
    }
    candidatesToScan = unignored.filter(file => wanted.some(item => file === item || file.startsWith(item + '/')));
  } else {
    candidatesToScan = unignored;
  }

  if (!candidatesToScan.length) throw new BridgeError('ISOLATION_EMPTY', 'No eligible project files to copy');
  if (candidatesToScan.length > limits.maxCopyFiles) {
    throw new BridgeError('COPY_LIMIT_EXCEEDED', `Copy has ${candidatesToScan.length} files; limit is ${limits.maxCopyFiles}. Narrow includePaths.`);
  }

  // Preflight only the selected candidates
  const preflight = await preflightProjectFiles(sourceDirectory, candidatesToScan, limits);
  const selected = preflight.eligible;

  if (includePaths !== undefined) {
    const wanted = includePaths.map(validRelative);
    for (const item of wanted) {
      if (!selected.some(file => file === item || file.startsWith(item + '/'))) {
        throw new BridgeError('INVALID_INCLUDE_PATH', 'No eligible file matches: ' + item);
      }
    }
  }

  if (!selected.length) throw new BridgeError('ISOLATION_EMPTY', 'No eligible project files to copy');
  if (selected.length > limits.maxCopyFiles) {
    throw new BridgeError('COPY_LIMIT_EXCEEDED', `Copy has ${selected.length} files; limit is ${limits.maxCopyFiles}. Narrow includePaths.`);
  }

  let totalBytes = 0;
  for (const relative of selected) {
    totalBytes += (await lstat(await checkedPath(sourceDirectory, relative, true))).size;
    if (totalBytes > limits.maxCopyBytes) throw new BridgeError('COPY_LIMIT_EXCEEDED', `Copy exceeds ${limits.maxCopyBytes} bytes. Narrow includePaths.`);
  }

  const copyDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-copy-'));
  const gitDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-baseline-'));
  const baseline = new Map<string, string>();
  try {
    const project: ProjectCopy = { sourceDirectory, copyDirectory, gitDirectory, baseline, includedFiles: selected, blockedFiles: preflight.blocked };
    onCreated?.(project);
    const budget = { remainingBytes: limits.maxCopyBytes };
    for (const relative of selected) {
      const source = await checkedPath(sourceDirectory, relative, true);
      const target = path.join(copyDirectory, ...relative.split('/'));
      const record = preflight.records.get(relative);
      const hash = await copyVerifiedFile(source, target, relative, record, budget, 'SOURCE_CHANGED');
      baseline.set(relative, hash);
    }
    totalBytes = limits.maxCopyBytes - budget.remainingBytes;
    const staged = await stageProvidedSkills(copyDirectory, skills, { ...limits, maxCopyFiles: limits.maxCopyFiles - selected.length, maxCopyBytes: limits.maxCopyBytes - totalBytes });
    if (staged.length) project.providedSkills = staged;
    await verifyProvidedSkills(copyDirectory, staged);
    if (execution) await stageProjectExecutionPolicy(project, execution, limits);
    await git(copyDirectory, ['-c', 'init.templateDir=', 'init', '--bare', '--quiet', gitDirectory]);
    const scope = ['--git-dir=' + gitDirectory, '--work-tree=' + copyDirectory];
    await git(copyDirectory, [...scope, 'add', '-A', '-f', '--', '.', ...executionExclusions(project)]);
    await git(copyDirectory, [...scope,
      '-c', 'user.name=Bridge Snapshot',
      '-c', 'user.email=bridge@invalid.local',
      '-c', 'core.hooksPath=' + path.join(gitDirectory, 'disabled-hooks'),
      'commit', '--quiet', '--allow-empty', '-m', 'baseline',
    ]);
    return project;
  } catch (error) {
    if (path.dirname(copyDirectory) === os.tmpdir() && path.basename(copyDirectory).startsWith('agy-mcp-copy-')) {
      await rm(copyDirectory, { recursive: true, force: true });
    }
    if (path.dirname(gitDirectory) === os.tmpdir() && path.basename(gitDirectory).startsWith('agy-mcp-baseline-')) {
      await rm(gitDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function previewProjectCopy(project: ProjectCopy, limits: ProjectLimits = DEFAULT_PROJECT_LIMITS): Promise<ChangePreview> {
  await verifyManagedCopy(project);
  const scope = ['--git-dir=' + project.gitDirectory, '--work-tree=' + project.copyDirectory];
  await git(project.copyDirectory, [...scope, 'add', '-A', '--', '.', ...executionExclusions(project)]);
  const names = splitNull(await git(project.copyDirectory,
    [...scope, 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--name-status', '--no-renames', '-z', 'HEAD']));
  if (names.length / 2 > limits.maxChangedFiles) throw new BridgeError('CHANGE_LIMIT_EXCEEDED', `Changed ${names.length / 2} files; limit is ${limits.maxChangedFiles}`);
  const files: ChangePreview['files'] = [];
  for (let index = 0; index < names.length; index += 2) {
    const status = names[index]!;
    const relative = validRelative(names[index + 1] || '');
    if (!['A', 'M', 'D'].includes(status)) throw new BridgeError('UNSAFE_PROJECT_PATH', 'Unsupported file change: ' + relative);
    if (status !== 'D') await checkedPath(project.copyDirectory, relative, true);
    files.push({ status, path: relative });
  }
  const stats = new Map(splitNull(await git(project.copyDirectory,
    [...scope, 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--numstat', '--no-renames', '-z', 'HEAD'])).map(line => {
      const [added, removed, ...relative] = line.split('\t');
      return [relative.join('\t'), { insertions: added === '-' ? null : Number(added), deletions: removed === '-' ? null : Number(removed), binary: added === '-' }];
    }));
  const fileSummaries = files.map(file => {
    const stat = stats.get(file.path);
    if (!stat) throw new BridgeError('GIT_OPERATION_FAILED', 'Missing diff statistics for: ' + file.path);
    return { ...file, ...stat };
  });
  const summary = { filesChanged: files.length, added: files.filter(file => file.status === 'A').length,
    modified: files.filter(file => file.status === 'M').length, deleted: files.filter(file => file.status === 'D').length,
    insertions: fileSummaries.reduce((total, file) => total + (file.insertions ?? 0), 0),
    deletions: fileSummaries.reduce((total, file) => total + (file.deletions ?? 0), 0), binaryFiles: fileSummaries.filter(file => file.binary).length };
  const bytes = await git(project.copyDirectory, [...scope, 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', '--no-renames', 'HEAD']);
  return {
    files, fileSummaries, summary, patch: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex'),
    sourceDirectory: project.sourceDirectory, copyDirectory: project.copyDirectory,
  };
}

export async function verifyReadOnlyCopy(project: ProjectCopy, baseline = new Map([...project.baseline, ...(project.providedSkills ?? []).flatMap(skill => skill.files.map(file => [file.path, file.sha256] as [string, string])), ...(project.executionPolicy?.files ?? []).map(file => [file.path, file.sha256] as [string, string])] )): Promise<void> {
  await verifyManagedCopy(project);
  const seen = new Set<string>();
  async function visit(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative + '/');
      else {
        seen.add(relative);
        if (!entry.isFile() || baseline.get(relative) !== await sha256File(path.join(directory, entry.name))) {
          throw new BridgeError('READ_ONLY_VIOLATION', 'Read-only task changed the copy: ' + relative);
        }
      }
    }
  }
  await visit(project.copyDirectory);
  for (const relative of baseline.keys()) if (!seen.has(relative)) {
    throw new BridgeError('READ_ONLY_VIOLATION', 'Read-only task deleted: ' + relative);
  }
}

export async function readProjectPatch(project: ProjectCopy, relative: string): Promise<string> {
  const file = validRelative(relative);
  return (await git(project.copyDirectory, ['--git-dir=' + project.gitDirectory, '--work-tree=' + project.copyDirectory,
    'diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', '--no-renames', 'HEAD', '--', file])).toString('utf8');
}

export async function snapshotCopyFiles(project: ProjectCopy, limits: ProjectLimits): Promise<Map<string, string>> {
  await verifyManagedCopy(project);
  const hashes = new Map<string, string>();
  let bytes = 0;
  async function visit(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative + '/');
      else {
        const file = await checkedPath(project.copyDirectory, relative, true);
        bytes += (await lstat(file)).size;
        if (hashes.size >= limits.maxCopyFiles || bytes > limits.maxCopyBytes) throw new BridgeError('COPY_LIMIT_EXCEEDED', 'Copy snapshot exceeds configured limits');
        hashes.set(relative, await sha256File(file));
      }
    }
  }
  await visit(project.copyDirectory);
  return hashes;
}

export async function forkProjectCopy(project: ProjectCopy, limits: ProjectLimits): Promise<ProjectCopy> {
  await verifyManagedCopy(project);
  const managed = new Set((project.providedSkills ?? []).flatMap(skill => skill.files.map(file => file.path)));
  const scope = ['--git-dir=' + project.gitDirectory, '--work-tree=' + project.copyDirectory];
  const candidates = [...new Set(splitNull(await git(project.copyDirectory, [...scope, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'])))];
  const ignored = new Set<string>();
  if (candidates.length) {
    const input = Buffer.from(candidates.join('\0') + '\0');
    for (const file of splitNull(await git(project.copyDirectory, [...scope, 'check-ignore', '--no-index', '--stdin', '-z'], input, [0, 1]))) ignored.add(file);
    for (const file of splitNull(await git(project.sourceDirectory, ['check-ignore', '--no-index', '--stdin', '-z'], input, [0, 1]))) ignored.add(file);
  }
  const eligibleCandidates = candidates.filter(file => (!project.executionPolicy || !EXECUTION_POLICY_PATHS.some(managedPath => managedPath === file)) && (!ignored.has(file) || managed.has(file)));
  const preflight = await preflightProjectFiles(project.copyDirectory, eligibleCandidates, limits);
  for (const blocked of preflight.blocked) {
    if (project.baseline.has(blocked.path)) {
      throw new BridgeError('CONTEXT_CHANGED', 'Baseline file became blocked or unsafe: ' + blocked.path);
    }
  }
  const copyDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-copy-'));
  const gitDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-baseline-'));
  const fork: ProjectCopy = {
    ...project,
    executionPolicy: undefined,
    executionStateDirectory: undefined,
    copyDirectory,
    gitDirectory,
    baseline: new Map(project.baseline),
    includedFiles: [],
    blockedFiles: preflight.blocked,
  };
  try {
    const budget = { remainingBytes: limits.maxCopyBytes };
    for (const relative of preflight.eligible) {
      let source: string;
      try { source = await checkedPath(project.copyDirectory, relative, true); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }

      if (fork.includedFiles.length >= limits.maxCopyFiles) {
        throw new BridgeError('COPY_LIMIT_EXCEEDED', 'Context copy exceeds configured limits');
      }

      const target = path.join(copyDirectory, ...validRelative(relative).split('/'));
      const record = preflight.records.get(relative);
      await copyVerifiedFile(source, target, relative, record, budget, 'CONTEXT_CHANGED');
      fork.includedFiles.push(relative);
    }
    await git(copyDirectory, ['-c', 'init.templateDir=', 'clone', '--bare', '--no-hardlinks', '--quiet', project.gitDirectory, gitDirectory]);
    await git(copyDirectory, ['--git-dir=' + gitDirectory, '--work-tree=' + copyDirectory, 'read-tree', 'HEAD']);
    await fingerprintProjectCopy(fork, limits);
    return fork;
  } catch (error) { await discardProjectCopy(fork); throw error; }
}

export async function fingerprintProjectCopy(project: ProjectCopy, limits: ProjectLimits = DEFAULT_PROJECT_LIMITS): Promise<string> {
  await verifyManagedCopy(project);
  const managed = new Set((project.providedSkills ?? []).flatMap(skill => skill.files.map(file => file.path)));
  const scope = ['--git-dir=' + project.gitDirectory, '--work-tree=' + project.copyDirectory];
  const candidates = [...new Set(splitNull(await git(project.copyDirectory, [...scope, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'])))].sort();
  const ignored = new Set(candidates.length ? splitNull(await git(project.copyDirectory,
    [...scope, 'check-ignore', '--no-index', '--stdin', '-z'], Buffer.from(candidates.join('\0') + '\0'), [0, 1])) : []);
  const digest = createHash('sha256');
  let count = 0, bytes = 0;
  for (const relative of candidates.filter(file => (!project.executionPolicy || !EXECUTION_POLICY_PATHS.some(managedPath => managedPath === file)) && (!ignored.has(file) || managed.has(file)))) {
    let file;
    try { file = await checkedPath(project.copyDirectory, relative, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (++count > limits.maxCopyFiles) throw new BridgeError('COPY_LIMIT_EXCEEDED', 'Test snapshot file limit exceeded');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) {
      bytes += chunk.length;
      if (bytes > limits.maxCopyBytes) throw new BridgeError('COPY_LIMIT_EXCEEDED', 'Test snapshot byte limit exceeded');
      hash.update(chunk);
    }
    digest.update(relative + '\0' + hash.digest('hex') + '\0');
  }
  return digest.digest('hex');
}

export async function integrateProjectCopy(project: ProjectCopy, expectedSha256: string, limits: ProjectLimits = DEFAULT_PROJECT_LIMITS): Promise<ChangePreview> {
  const preview = await previewProjectCopy(project, limits);
  if (!preview.files.length) throw new BridgeError('NO_CHANGES', 'The isolated copy has no changes');
  if (preview.sha256 !== expectedSha256) throw new BridgeError('REVIEW_CHANGED', 'The copy changed after review; preview it again');
  for (const file of preview.files) {
    const source = await checkedPath(project.sourceDirectory, file.path, false);
    const expected = project.baseline.get(file.path);
    if (expected) {
      const current = await sha256File(source).catch(() => undefined);
      if (current !== expected) throw new BridgeError('SOURCE_CHANGED', 'Source changed since copy: ' + file.path);
    } else {
      try { await lstat(source); throw new BridgeError('SOURCE_CHANGED', 'Source already has: ' + file.path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  const patch = Buffer.from(preview.patch, 'utf8');
  await git(project.sourceDirectory, ['apply', '--check', '--binary', '-'], patch);
  await git(project.sourceDirectory, ['apply', '--binary', '-'], patch);
  return preview;
}
