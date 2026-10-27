import { createHash, randomUUID } from 'node:crypto';
import { git, type HostGitOptions } from './host-git.js';
import { isUtf8 } from 'node:buffer';
import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stageProvidedSkills, verifyProvidedSkills, type ProvidedSkill, type StagedSkill } from './skills.js';
import { BridgeError } from './types.js';
import { checkIntegratedText, decodeUtf16, renderLines, replaceInsideRoot, type LfConversion } from './line-endings.js';
import { stageExecutionPolicy, verifyExecutionPolicy, discardExecutionPolicy, EXECUTION_POLICY_PATHS, type StagedExecutionPolicy } from './execution-policy.js';
import type { ResolvedAgentPolicy, McpCatalogEntry } from './agent-policy.js';
import { DEFAULT_PROJECT_LIMITS, type ProjectLimits } from './config.js';
import {
  detectSecretContent,
  isKnownCredentialFile,
  matchProjectRelativeGlob,
  preflightProjectFiles,
  type BlockedPath,
  type PreflightRecord,
  type SecretPreflightResult,
  type SecretScanState,
} from './secret-preflight.js';
import { normalizeSecretExceptionsPolicy } from './hardening-policy.js';

export type { BlockedPath } from './secret-preflight.js';

export interface ExecutionPolicyRequest { policy: ResolvedAgentPolicy; catalog: McpCatalogEntry[]; stateDirectory: string; executionId: string; readOnlyRoots?: readonly string[] }

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
  encodingWarnings?: string[];
}

export const FENCE_MARKER_NAME = 'CLEANUP_UNVERIFIED';

export function getFenceMarkerPath(project: { gitDirectory: string }): string {
  return path.join(project.gitDirectory, FENCE_MARKER_NAME);
}

export async function checkFenceMarker(project: { gitDirectory: string }): Promise<void> {
  const markerPath = getFenceMarkerPath(project);
  let exists = false;
  try {
    await lstat(markerPath);
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      exists = false;
    } else {
      throw new BridgeError('GIT_CLEANUP_UNVERIFIED', 'Failed to inspect cleanup fence marker: ' + ((err as Error).message || String(err)));
    }
  }
  if (exists) {
    throw new BridgeError('GIT_CLEANUP_UNVERIFIED', 'Project copy is fenced due to unverified Git cleanup');
  }
}

export async function writeFenceMarker(project: { gitDirectory: string }): Promise<void> {
  const markerPath = getFenceMarkerPath(project);
  try {
    await writeFile(markerPath, JSON.stringify({ code: 'GIT_CLEANUP_UNVERIFIED', version: 1 }) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (err) {
    throw new BridgeError('GIT_CLEANUP_UNVERIFIED', 'Failed to persist cleanup fence marker: ' + ((err as Error).message || String(err)));
  }
}

// Lists the files rewritten from CRLF to LF for a CLI run and the task that launched it. It lives with the copy, outside
// the CLI's reach, and is written before the first conversion, so a crash at any point still leaves the exact list to restore.
const LINE_ENDINGS_MARKER_NAME = 'LINE_ENDINGS_CONVERTED';

export interface LineEndingConversions { taskId: string; files: LfConversion[]; existingBefore: string[] }

export async function writeLineEndingConversions(project: ProjectCopy, conversions: LineEndingConversions): Promise<void> {
  const files = conversions.files.map(file => ({ path: validRelative(file.path), sha256: file.sha256 }));
  await writeFile(path.join(project.gitDirectory, LINE_ENDINGS_MARKER_NAME),
    JSON.stringify({ version: 1, taskId: conversions.taskId, files, existingBefore: conversions.existingBefore }) + '\n',
    { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
}

export async function readLineEndingConversions(project: ProjectCopy): Promise<LineEndingConversions | undefined> {
  const marker = path.join(project.gitDirectory, LINE_ENDINGS_MARKER_NAME);
  let text: string;
  try {
    const info = await lstat(marker);
    if (!info.isFile() || info.isSymbolicLink()) throw new BridgeError('LINE_ENDINGS_UNRESTORED', 'The line ending conversion record is not a regular file');
    text = await readFile(marker, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let record: { taskId?: unknown; files?: unknown; existingBefore?: unknown } | undefined;
  try { record = JSON.parse(text) as typeof record; } catch { record = undefined; }
  const files = record?.files as Array<{ path?: unknown; sha256?: unknown }> | undefined;
  const existingBefore = record?.existingBefore;
  if (typeof record?.taskId !== 'string' || !Array.isArray(files) || !Array.isArray(existingBefore) || existingBefore.some(item => typeof item !== 'string') ||
      files.some(file => typeof file?.path !== 'string' || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256))) {
    throw new BridgeError('LINE_ENDINGS_UNRESTORED', 'The line ending conversion record is unreadable; discard this copy');
  }
  return { taskId: record.taskId, files: files.map(file => ({ path: validRelative(file.path as string), sha256: file.sha256 as string })),
    existingBefore: existingBefore as string[] };
}

export async function assertLineEndingsRestored(project: ProjectCopy): Promise<void> {
  if (await readLineEndingConversions(project)) {
    throw new BridgeError('LINE_ENDINGS_UNRESTORED', 'Files converted to LF for the CLI have not regained their original line endings; this happens once its processes are confirmed to have ended');
  }
}

export async function clearLineEndingConversions(project: ProjectCopy): Promise<void> {
  await rm(path.join(project.gitDirectory, LINE_ENDINGS_MARKER_NAME), { force: true });
}

export async function verifyManagedCopy(project: ProjectCopy): Promise<void> {
  await checkFenceMarker(project);
  await verifyProvidedSkills(project.copyDirectory, project.providedSkills ?? []);
  if (project.executionPolicy) {
    if (!project.executionStateDirectory) throw new BridgeError('INVALID_AGENT_POLICY', 'Execution policy state binding is missing');
    await verifyExecutionPolicy(project.copyDirectory, project.executionPolicy, project.executionStateDirectory);
  }
}

function managedAuxiliarySet(project: ProjectCopy): Set<string> {
  const paths = new Set<string>(
    (project.providedSkills ?? []).flatMap(skill => skill.files.map(file => validRelative(file.path)))
  );
  if (project.executionPolicy) {
    for (const file of EXECUTION_POLICY_PATHS) paths.add(file);
  }
  return paths;
}

function managedExclusions(project: ProjectCopy): string[] {
  return [...managedAuxiliarySet(project)].map(file => ':(exclude,literal)' + file);
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
  await checkFenceMarker(project);
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

export { git } from './host-git.js';

export async function managedGit(
  project: ProjectCopy,
  cwd: string,
  args: string[],
  input?: Buffer,
  allowedCodes = [0],
  options?: HostGitOptions
): Promise<Buffer> {
  await checkFenceMarker(project);
  const excludedRoots = [
    project.sourceDirectory,
    project.copyDirectory,
    ...(options?.excludedRoots ?? []),
  ];
  try {
    return await git(cwd, args, input, allowedCodes, {
      ...options,
      excludedRoots,
    });
  } catch (error) {
    if (error instanceof BridgeError && error.code === 'GIT_CLEANUP_UNVERIFIED') {
      await writeFenceMarker(project);
    }
    throw error;
  }
}

export function copyGit(project: ProjectCopy, args: string[], input?: Buffer, allowedCodes = [0], options?: HostGitOptions): Promise<Buffer> {
  return managedGit(project, project.copyDirectory, args, input, allowedCodes, options);
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
  errorCode: 'SOURCE_CHANGED' | 'CONTEXT_CHANGED',
  sourceRoot?: string
): Promise<string> {
  if (!record) {
    throw new BridgeError(errorCode, (errorCode === 'SOURCE_CHANGED' ? 'Source changed during copy: ' : 'Context changed during copy: ') + relative);
  }

  const root = sourceRoot ?? path.resolve(source, ...validRelative(relative).split('/').map(() => '..'));
  const srcHandle = await open(source, 'r');
  let dstHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const fstat = await srcHandle.stat();
    await checkedPath(root, relative, true);
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

    const finalStat = await srcHandle.stat();
    await checkedPath(root, relative, true);
    const finalPath = await lstat(source);
    if (finalPath.isSymbolicLink() || !finalPath.isFile() || finalPath.ino !== fstat.ino || finalPath.dev !== fstat.dev ||
        finalPath.size !== fstat.size || finalStat.size !== fstat.size || finalStat.mtimeMs !== fstat.mtimeMs ||
        finalStat.ctimeMs !== fstat.ctimeMs || finalPath.mtimeMs !== fstat.mtimeMs) {
      throw new BridgeError(errorCode, 'File changed during verified copy: ' + relative);
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
  const project: ProjectCopy = { sourceDirectory, copyDirectory, gitDirectory, baseline, includedFiles: selected, blockedFiles: preflight.blocked };
  try {
    onCreated?.(project);
    const budget = { remainingBytes: limits.maxCopyBytes };
    for (const relative of selected) {
      const source = await checkedPath(sourceDirectory, relative, true);
      const target = path.join(copyDirectory, ...relative.split('/'));
      const record = preflight.records.get(relative);
      const hash = await copyVerifiedFile(source, target, relative, record, budget, 'SOURCE_CHANGED', sourceDirectory);
      baseline.set(relative, hash);
    }
    totalBytes = limits.maxCopyBytes - budget.remainingBytes;
    const staged = await stageProvidedSkills(copyDirectory, skills, { ...limits, maxCopyFiles: limits.maxCopyFiles - selected.length, maxCopyBytes: limits.maxCopyBytes - totalBytes });
    if (staged.length) project.providedSkills = staged;
    await verifyProvidedSkills(copyDirectory, staged);
    await copyGit(project, ['-c', 'init.templateDir=', 'init', '--bare', '--quiet', gitDirectory]);
    await treatFilesAsBytes(gitDirectory);
    if (execution) {
      initializingProjects.add(project);
      try {
        await stageProjectExecutionPolicy(project, execution, limits);
      } finally {
        initializingProjects.delete(project);
      }
    }
    await verifyManagedCopy(project);
    const scope = ['--git-dir=' + gitDirectory, '--work-tree=' + copyDirectory];
    await copyGit(project, [...scope, 'add', '-A', '-f', '--', '.', ...managedExclusions(project)]);
    await copyGit(project, [...scope,
      '-c', 'user.name=Bridge Snapshot',
      '-c', 'user.email=bridge@invalid.local',
      'commit', '--quiet', '--allow-empty', '-m', 'baseline',
    ]);
    return project;
  } catch (error) {
    if (error instanceof BridgeError && error.code === 'GIT_CLEANUP_UNVERIFIED') {
      throw error;
    }
    await discardProjectCopy(project);
    throw error;
  }
}

// The baseline, the patch and its application work on the bytes of each file: info/attributes outranks the project's
// .gitattributes, so no line ending, encoding or $Id$ keyword is converted on the way in or out (core.autocrlf stays off
// without system and global configuration). Git may refuse a working-tree-encoding set to false, hence the unspecified state.
async function treatFilesAsBytes(gitDirectory: string): Promise<void> {
  await mkdir(path.join(gitDirectory, 'info'), { recursive: true });
  await writeFile(path.join(gitDirectory, 'info', 'attributes'), '* -text !working-tree-encoding -ident\n', { flag: 'wx', mode: 0o600 });
}

// A changed file goes into the patch as text or as binary the way Git diffs it: as text when its diff attribute is set, as
// binary when it is unset (as with binary), and otherwise as binary only with a NUL byte in its first 8000 bytes. A patch
// that is not UTF-8 cannot be previewed, so text files that are not UTF-8 are refused before a CLI run, which would
// otherwise be lost once it edited one of them.
export async function assertTextIsUtf8(project: ProjectCopy, files: readonly string[]): Promise<void> {
  const nulByFile = new Map<string, boolean>();
  for (const relative of files) {
    const bytes = await readFile(await checkedPath(project.copyDirectory, relative, true));
    if (!isUtf8(bytes)) nulByFile.set(relative, bytes.subarray(0, 8000).includes(0));
  }
  if (!nulByFile.size) return;
  const scope = ['--git-dir=' + project.gitDirectory, '--work-tree=' + project.copyDirectory];
  const output = (await copyGit(project, [...scope, 'check-attr', '-z', '--stdin', 'diff'],
    Buffer.from([...nulByFile.keys()].join('\0') + '\0'))).toString('utf8').split('\0');
  const refused: string[] = [];
  for (let index = 0; index + 2 < output.length; index += 3) {
    const relative = output[index]!, value = output[index + 2]!, nul = nulByFile.get(relative)!;
    let text = value === 'set' || !nul;
    // check-attr prints a diff driver literally named "set" or "unset" like the set and unset states, and with such a
    // driver Git goes by the NUL byte; where the two readings disagree, Git's own diff of the file decides. The ./ prefix
    // keeps a file named "-" from being read as standard input.
    if (value === 'set' ? nul : value === 'unset' && !nul) {
      const numstat = await copyGit(project, [...scope, 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--',
        '/dev/null', './' + relative], undefined, [0, 1]);
      text = !numstat.toString('utf8').startsWith('-\t');
    }
    if (text) refused.push(relative);
  }
  if (!refused.length) return;
  const listed = refused.slice(0, 20).join(', ') + (refused.length > 20 ? ' and ' + (refused.length - 20) + ' more' : '');
  throw new BridgeError('UNSUPPORTED_TEXT_ENCODING', 'The CLI was not started: these text files are not UTF-8, so a change to ' +
    'any of them could not be previewed: ' + listed + '. Mark them as binary in .gitattributes (for example "' + refused[0] +
    ' binary"), leave them out with includePaths, or convert them to UTF-8, then start the task again.');
}

function ensurePatchUtf8RoundTrip(bytes: Buffer): string {
  const patchText = bytes.toString('utf8');
  if (!Buffer.from(patchText, 'utf8').equals(bytes)) {
    throw new BridgeError(
      'UNSUPPORTED_PATCH_ENCODING',
      'Patch contains non-UTF-8 content that cannot safely round-trip. Declare non-UTF-8 files as binary in .gitattributes.'
    );
  }
  return patchText;
}

const initializingProjects = new WeakSet<ProjectCopy>();

interface InspectedBaseline {
  pinnedCommit: string;
  objectFormat: string;
  pinnedTree: string;
  paths: Set<string>;
  blocked: BlockedPath[];
}

async function inspectPrivateBaseline(
  project: ProjectCopy,
  limits: ProjectLimits,
  auxPaths: ReadonlySet<string>
): Promise<InspectedBaseline> {
  const exclusions = (limits.secretExclusions ?? []).filter(Boolean);
  const exceptionsPolicy = normalizeSecretExceptionsPolicy(limits.secretExceptions, 'secretExceptions');
  const namePatterns = exceptionsPolicy.namePatterns;
  const paths = new Set<string>();
  const blockedByPath = new Map<string, BlockedPath>();

  const evaluatePathPolicy = (relPath: string): boolean => {
    if (exclusions.some(pattern => matchProjectRelativeGlob(pattern, relPath))) {
      blockedByPath.set(relPath, { path: relPath, reason: 'SECRET_EXCLUSION' });
      return true;
    }
    const isNameExcepted = namePatterns.some(pattern => matchProjectRelativeGlob(pattern, relPath));
    if (!isNameExcepted && isKnownCredentialFile(relPath)) {
      blockedByPath.set(relPath, { path: relPath, reason: 'SECRET_FILE' });
      return true;
    }
    return false;
  };

  for (const rawBasePath of project.baseline.keys()) {
    const relPath = validRelative(rawBasePath);
    if (auxPaths.has(relPath)) continue;
    paths.add(relPath);
    evaluatePathPolicy(relPath);
  }

  const objectFormat = (await copyGit(project, ['--git-dir=' + project.gitDirectory, 'rev-parse', '--show-object-format'])).toString('utf8').trim();
  if (!['sha1', 'sha256'].includes(objectFormat)) {
    throw new BridgeError('GIT_OPERATION_FAILED', 'Unsupported Git object format: ' + objectFormat);
  }

  if (initializingProjects.has(project)) {
    return {
      pinnedCommit: '',
      objectFormat,
      pinnedTree: '',
      paths,
      blocked: [...blockedByPath.values()],
    };
  }

  const pinnedCommit = (await copyGit(project, ['--git-dir=' + project.gitDirectory, 'rev-parse', '--verify', 'HEAD^{commit}'])).toString('utf8').trim();
  const hashPattern = objectFormat === 'sha256' ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;
  if (!hashPattern.test(pinnedCommit)) {
    throw new BridgeError('GIT_OPERATION_FAILED', 'Invalid commit or tree object identifier');
  }
  const pinnedTree = (await copyGit(project, ['--git-dir=' + project.gitDirectory, 'rev-parse', '--verify', `${pinnedCommit}^{tree}`])).toString('utf8').trim();
  if (!hashPattern.test(pinnedTree)) {
    throw new BridgeError('GIT_OPERATION_FAILED', 'Invalid commit or tree object identifier');
  }

  const lsTreeRaw = await copyGit(project, ['--git-dir=' + project.gitDirectory, 'ls-tree', '-r', '-l', '-z', pinnedCommit]);
  let baselineFileCount = 0;
  let baselineByteCount = 0;
  let offset = 0;
  const entriesToScan: Array<{ path: string; oid: string; size: number }> = [];

  while (offset < lsTreeRaw.length) {
    const nextNull = lsTreeRaw.indexOf(0, offset);
    if (nextNull === -1) throw new BridgeError('GIT_OPERATION_FAILED', 'Unterminated ls-tree record');
    const entryBuf = lsTreeRaw.subarray(offset, nextNull);
    offset = nextNull + 1;
    if (entryBuf.length === 0) continue;

    const tabIdx = entryBuf.indexOf(0x09);
    if (tabIdx === -1) {
      throw new BridgeError('GIT_OPERATION_FAILED', 'Invalid ls-tree output format');
    }

    const meta = entryBuf.subarray(0, tabIdx).toString('utf8').trim();
    const rawRelPath = entryBuf.subarray(tabIdx + 1).toString('utf8');

    const parts = meta.split(/\s+/);
    if (parts.length < 4) {
      throw new BridgeError('GIT_OPERATION_FAILED', 'Invalid ls-tree metadata: ' + meta);
    }
    const mode = parts[0]!;
    const type = parts[1]!;
    const oid = parts[2]!;
    const sizeStr = parts[3]!;

    if (mode !== '100644' && mode !== '100755') {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Baseline contains non-regular file or link: ' + rawRelPath);
    }
    if (type !== 'blob') {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Baseline entry is not a blob: ' + rawRelPath);
    }
    if (!hashPattern.test(oid)) {
      throw new BridgeError('GIT_OPERATION_FAILED', 'Invalid blob object identifier in baseline ls-tree');
    }

    const relPath = validRelative(rawRelPath);
    const size = Number(sizeStr);
    if (!/^\d+$/.test(sizeStr) || !Number.isSafeInteger(size) || size < 0) {
      throw new BridgeError('GIT_OPERATION_FAILED', 'Invalid blob size in baseline ls-tree');
    }

    baselineFileCount++;
    baselineByteCount += size;

    if (baselineFileCount > limits.maxCopyFiles || baselineByteCount > limits.maxCopyBytes) {
      throw new BridgeError('COPY_LIMIT_EXCEEDED', 'Baseline tree exceeds copy limits');
    }

    if (auxPaths.has(relPath)) {
      entriesToScan.push({ path: relPath, oid, size });
      continue;
    }
    paths.add(relPath);
    if (!evaluatePathPolicy(relPath)) {
      entriesToScan.push({ path: relPath, oid, size });
    }
  }

  if (entriesToScan.length > 0) {
    const batchInput = Buffer.from(entriesToScan.map(entry => entry.oid + '\n').join(''), 'utf8');
    const maxOutputBytes = limits.maxCopyBytes + Math.max(65536, entriesToScan.length * 256);
    const CHUNK_OVERLAP = 4 * 1024;
    const SCAN_WINDOW_LIMIT = 64 * 1024;
    let entryIndex = 0;
    let parseMode: 'header' | 'body' | 'newline' = 'header';
    let headerBuf = Buffer.alloc(0);
    let remainingInBlob = 0;
    let prevOverlap = Buffer.alloc(0);
    let scanState: SecretScanState = {};
    let blobHasSecret = false;

    await copyGit(
      project,
      ['--git-dir=' + project.gitDirectory, 'cat-file', '--batch'],
      batchInput,
      [0],
      {
        maxOutputBytes,
        onStdoutChunk: (chunk: Buffer) => {
          let chunkOffset = 0;
          while (chunkOffset < chunk.length) {
            if (entryIndex >= entriesToScan.length) {
              throw new BridgeError('GIT_OPERATION_FAILED', 'Unexpected extra output from git cat-file --batch');
            }
            const currentEntry = entriesToScan[entryIndex]!;
            if (parseMode === 'header') {
              const nlIdx = chunk.indexOf(0x0a, chunkOffset);
              if (nlIdx === -1) {
                const tail = chunk.subarray(chunkOffset);
                headerBuf = headerBuf.length > 0 ? Buffer.concat([headerBuf, tail]) : Buffer.from(tail);
                if (headerBuf.length > 256) {
                  throw new BridgeError('GIT_OPERATION_FAILED', 'Oversized header from git cat-file --batch');
                }
                chunkOffset = chunk.length;
                continue;
              }
              const lineSlice = chunk.subarray(chunkOffset, nlIdx);
              const headerLine = (headerBuf.length > 0 ? Buffer.concat([headerBuf, lineSlice]) : lineSlice).toString('utf8');
              headerBuf = Buffer.alloc(0);
              chunkOffset = nlIdx + 1;
              if (headerLine !== `${currentEntry.oid} blob ${currentEntry.size}`) {
                throw new BridgeError('GIT_OPERATION_FAILED', 'Unexpected blob header from git cat-file --batch');
              }
              remainingInBlob = currentEntry.size;
              prevOverlap = Buffer.alloc(0);
              scanState = {};
              blobHasSecret = false;
              parseMode = remainingInBlob === 0 ? 'newline' : 'body';
              continue;
            }
            if (parseMode === 'body') {
              const take = Math.min(remainingInBlob, chunk.length - chunkOffset, SCAN_WINDOW_LIMIT);
              const slice = chunk.subarray(chunkOffset, chunkOffset + take);
              chunkOffset += take;
              remainingInBlob -= take;
              if (!blobHasSecret) {
                const window = prevOverlap.length > 0 ? Buffer.concat([prevOverlap, slice]) : slice;
                if (detectSecretContent(currentEntry.path, window, scanState)) {
                  blobHasSecret = true;
                } else {
                  const takeOverlap = Math.min(window.length, CHUNK_OVERLAP);
                  prevOverlap = Buffer.from(window.subarray(window.length - takeOverlap));
                }
              }
              if (remainingInBlob === 0) {
                parseMode = 'newline';
              }
              continue;
            }
            if (chunk[chunkOffset] !== 0x0a) {
              throw new BridgeError('GIT_OPERATION_FAILED', 'Missing trailing newline in git cat-file --batch output');
            }
            chunkOffset += 1;
            if (blobHasSecret) {
              blockedByPath.set(currentEntry.path, { path: currentEntry.path, reason: 'SECRET_CONTENT' });
            }
            entryIndex += 1;
            parseMode = 'header';
          }
        },
      }
    );

    if (entryIndex !== entriesToScan.length || parseMode !== 'header' || headerBuf.length !== 0) {
      throw new BridgeError('GIT_OPERATION_FAILED', 'Incomplete output from git cat-file --batch');
    }
  }

  return {
    pinnedCommit,
    objectFormat,
    pinnedTree,
    paths,
    blocked: [...blockedByPath.values()],
  };
}

interface InspectedCopyResult extends SecretPreflightResult {
  baselineCommit: string;
  baselineObjectFormat: string;
  baselineTree: string;
  baselinePaths: Set<string>;
}

async function inspectCopyFiles(project: ProjectCopy, limits: ProjectLimits, rejectGenerated: boolean): Promise<InspectedCopyResult> {
  await assertLineEndingsRestored(project);
  await verifyManagedCopy(project);
  const managed = new Map((project.providedSkills ?? []).flatMap(skill => skill.files.map(file => [validRelative(file.path), file] as const)));
  const auxPaths = managedAuxiliarySet(project);
  const baseline = await inspectPrivateBaseline(project, limits, auxPaths);
  const scope = ['--git-dir=' + project.gitDirectory, '--work-tree=' + project.copyDirectory];
  const gitCandidates = splitNull(await copyGit(project, [...scope, 'ls-files', '--cached', '--others', '--exclude-standard', '-z']));
  const candidates = [...new Set([...gitCandidates, ...baseline.paths])].sort();
  const ignored = new Set<string>();
  if (candidates.length) {
    const input = Buffer.from(candidates.join('\0') + '\0');
    for (const file of splitNull(await copyGit(project, [...scope, 'check-ignore', '--no-index', '--stdin', '-z'], input, [0, 1]))) ignored.add(file);
    for (const file of splitNull(await managedGit(project, project.sourceDirectory, ['check-ignore', '--no-index', '--stdin', '-z'], input, [0, 1]))) ignored.add(file);
  }
  for (const file of ignored) {
    if (baseline.paths.has(file) && !auxPaths.has(file)) throw new BridgeError('CONTEXT_CHANGED', 'Baseline file became ignored: ' + file);
  }
  for (const blocked of baseline.blocked) {
    if (rejectGenerated) {
      throw new BridgeError('BLOCKED_FILE_DETECTED', 'Security policy rejected baseline file (' + blocked.reason + '): ' + blocked.path);
    }
    throw new BridgeError('CONTEXT_CHANGED', 'Baseline file became blocked or unsafe: ' + blocked.path);
  }
  const selected = candidates.filter(file => !auxPaths.has(file) && !ignored.has(file));
  const result = await preflightProjectFiles(project.copyDirectory, selected, limits);
  for (const blocked of result.blocked) {
    const isBaseline = baseline.paths.has(blocked.path);
    if (rejectGenerated) throw new BridgeError('BLOCKED_FILE_DETECTED',
      'Security policy rejected ' + (isBaseline ? 'baseline' : 'generated') + ' file (' + blocked.reason + '): ' + blocked.path);
    if (isBaseline) throw new BridgeError('CONTEXT_CHANGED', 'Baseline file became blocked or unsafe: ' + blocked.path);
  }
  // Auxiliary payloads are pinned independently by their supplied manifest.
  for (const [relative, expected] of managed) {
    const file = await checkedPath(project.copyDirectory, relative, true);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await sha256File(file) !== expected.sha256) {
      throw new BridgeError('PROVIDED_SKILL_CHANGED', 'Provided skill file changed: ' + relative);
    }
    result.records.set(relative, { path: relative, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev, sha256: expected.sha256 });
  }
  let bytes = 0;
  for (const record of result.records.values()) bytes += record.size;
  if (result.records.size > limits.maxCopyFiles || bytes > limits.maxCopyBytes) throw new BridgeError('COPY_LIMIT_EXCEEDED', 'Copy snapshot exceeds configured limits');
  result.eligible = [...result.records.keys()].sort();
  await verifyManagedCopy(project);
  return {
    ...result,
    baselineCommit: baseline.pinnedCommit,
    baselineObjectFormat: baseline.objectFormat,
    baselineTree: baseline.pinnedTree,
    baselinePaths: baseline.paths,
  };
}

function sameRecords(a: Map<string, PreflightRecord>, b: Map<string, PreflightRecord>): boolean {
  return a.size === b.size && [...a].every(([file, record]) => {
    const current = b.get(file);
    return current?.sha256 === record.sha256 && current.size === record.size &&
      current.ino === record.ino && current.dev === record.dev && current.mtimeMs === record.mtimeMs;
  });
}

async function removeVerifiedWorktree(project: ProjectCopy, directory: string, identity: { ino: number; dev: number }): Promise<void> {
  const parent = await realpath(project.gitDirectory);
  const info = await lstat(directory);
  const actual = await realpath(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || path.dirname(actual) !== parent ||
      !path.basename(actual).startsWith('verified-worktree-') || info.ino !== identity.ino || info.dev !== identity.dev) {
    throw new BridgeError('GIT_CLEANUP_UNVERIFIED', 'Verified worktree ownership changed');
  }
  await rm(actual, { recursive: true, force: true });
}

export async function previewProjectCopy(project: ProjectCopy, limits: ProjectLimits = DEFAULT_PROJECT_LIMITS): Promise<ChangePreview> {
  const checked = await inspectCopyFiles(project, limits, true);
  const auxPaths = managedAuxiliarySet(project);
  const exclusions = managedExclusions(project);
  const diffPathspec = ['--', '.', ...exclusions];
  const worktree = await mkdtemp(path.join(project.gitDirectory, 'verified-worktree-'));
  const identity = await lstat(worktree);
  const scope = ['--git-dir=' + project.gitDirectory, '--work-tree=' + worktree];
  const snapshotGit = (args: string[]) => managedGit(project, worktree, [...scope, ...args]);
  try {
    const budget = { remainingBytes: limits.maxCopyBytes };
    for (const relative of checked.eligible) {
      if (auxPaths.has(relative)) continue;
      const source = await checkedPath(project.copyDirectory, relative, true);
      const target = path.join(worktree, ...validRelative(relative).split('/'));
      await copyVerifiedFile(source, target, relative, checked.records.get(relative), budget, 'CONTEXT_CHANGED', project.copyDirectory);
    }
    // Git reads only this owned snapshot after every copied byte matched its scanned digest.
    await snapshotGit(['read-tree', checked.baselineCommit]);
    await snapshotGit(['add', '-A', '--', '.', ...exclusions]);
    const current = await inspectCopyFiles(project, limits, true);
    if (!sameRecords(checked.records, current.records) || checked.baselineCommit !== current.baselineCommit || checked.baselineTree !== current.baselineTree) {
      throw new BridgeError('CONTEXT_CHANGED', 'Copy changed while preparing its patch');
    }
    const names = splitNull(await snapshotGit(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--name-status', '--no-renames', '-z', checked.baselineCommit, ...diffPathspec]));
    if (names.length / 2 > limits.maxChangedFiles) throw new BridgeError('CHANGE_LIMIT_EXCEEDED', 'Changed file limit exceeded');
    const files: ChangePreview['files'] = [];
    for (let index = 0; index < names.length; index += 2) {
      const status = names[index]!;
      const relative = validRelative(names[index + 1] || '');
      if (!['A', 'M', 'D'].includes(status)) throw new BridgeError('UNSAFE_PROJECT_PATH', 'Unsupported file change: ' + relative);
      if (status !== 'D' && !checked.records.has(relative)) throw new BridgeError('CONTEXT_CHANGED', 'Unverified staged file: ' + relative);
      if (status === 'D' && !checked.baselinePaths.has(relative)) throw new BridgeError('CONTEXT_CHANGED', 'Unverified baseline deletion: ' + relative);
      files.push({ status, path: relative });
    }
    const stats = new Map(splitNull(await snapshotGit(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--numstat', '--no-renames', '-z', checked.baselineCommit, ...diffPathspec])).map(line => {
      const [added, removed, ...relative] = line.split('\t');
      return [relative.join('\t'), { insertions: added === '-' ? null : Number(added), deletions: removed === '-' ? null : Number(removed), binary: added === '-' }];
    }));
    const fileSummaries = files.map(file => {
      const stat = stats.get(file.path);
      if (!stat) throw new BridgeError('GIT_OPERATION_FAILED', 'Missing diff statistics for: ' + file.path);
      return { ...file, ...stat };
    });
    // A new UTF-16 file, such as output redirected by Windows PowerShell 5.1, has NUL bytes and reaches the patch as binary.
    const encodingWarnings: string[] = [];
    for (const file of fileSummaries) {
      if (file.status !== 'A' || !file.binary) continue;
      const utf16 = decodeUtf16(await readFile(path.join(worktree, ...file.path.split('/'))));
      if (utf16) encodingWarnings.push(file.path + ': new ' + utf16.encoding + ' text file, carried as binary in the patch; ' +
        'convert it to UTF-8 unless it must stay UTF-16');
    }
    const summary = { filesChanged: files.length, added: files.filter(file => file.status === 'A').length,
      modified: files.filter(file => file.status === 'M').length, deleted: files.filter(file => file.status === 'D').length,
      insertions: fileSummaries.reduce((total, file) => total + (file.insertions ?? 0), 0),
      deletions: fileSummaries.reduce((total, file) => total + (file.deletions ?? 0), 0), binaryFiles: fileSummaries.filter(file => file.binary).length };
    const bytes = await snapshotGit(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', '--no-renames', checked.baselineCommit, ...diffPathspec]);
    const patch = ensurePatchUtf8RoundTrip(bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    try { await snapshotGit(['read-tree', checked.baselineCommit]); }
    catch { await writeFenceMarker(project); throw new BridgeError('GIT_CLEANUP_UNVERIFIED', 'Could not restore private index after patch preparation'); }
    const finalHead = (await copyGit(project, ['--git-dir=' + project.gitDirectory, 'rev-parse', '--verify', 'HEAD^{commit}'])).toString('utf8').trim();
    if (finalHead !== checked.baselineCommit) {
      throw new BridgeError('CONTEXT_CHANGED', 'Copy changed while preparing its patch');
    }
    return { files, fileSummaries, summary, patch, sha256,
      sourceDirectory: project.sourceDirectory, copyDirectory: project.copyDirectory, ...(encodingWarnings.length ? { encodingWarnings } : {}) };
  } catch (error) {
    try { await snapshotGit(['read-tree', checked.baselineCommit]); }
    catch { await writeFenceMarker(project); throw new BridgeError('GIT_CLEANUP_UNVERIFIED', 'Could not restore private index after patch preparation failed'); }
    throw error;
  } finally {
    try { await removeVerifiedWorktree(project, worktree, identity); }
    catch { await writeFenceMarker(project); throw new BridgeError('GIT_CLEANUP_UNVERIFIED', 'Could not remove verified worktree; copy quarantined'); }
  }
}

export async function verifyReadOnlyCopy(project: ProjectCopy, baseline: ReadonlyMap<string, string> = project.baseline): Promise<void> {
  await verifyManagedCopy(project);
  const expected = new Map([...baseline, ...(project.providedSkills ?? []).flatMap(skill => skill.files.map(file => [file.path, file.sha256] as [string, string])), ...(project.executionPolicy?.files ?? []).map(file => [file.path, file.sha256] as [string, string])]);
  const seen = new Set<string>();
  async function visit(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative + '/');
      else {
        seen.add(relative);
        if (!entry.isFile() || expected.get(relative) !== await sha256File(path.join(directory, entry.name))) {
          throw new BridgeError('READ_ONLY_VIOLATION', 'Read-only task changed the copy: ' + relative);
        }
      }
    }
  }
  await visit(project.copyDirectory);
  for (const relative of expected.keys()) if (!seen.has(relative)) {
    throw new BridgeError('READ_ONLY_VIOLATION', 'Read-only task deleted: ' + relative);
  }
}

function extractFilePatch(preview: ChangePreview, file: string): string {
  const index = preview.files.findIndex(change => change.path === file);
  if (index < 0) return '';
  // Both outputs come from the same Git diff and preserve its file order.
  // Match section boundaries rather than decoding Git's quoted path syntax.
  const boundaries = [...preview.patch.matchAll(/^diff --git /gm)].map(match => match.index);
  if (boundaries.length !== preview.files.length) {
    throw new BridgeError('GIT_OPERATION_FAILED', 'Patch sections do not match the verified file list');
  }
  return preview.patch.slice(boundaries[index], boundaries[index + 1] ?? preview.patch.length);
}

export async function readProjectPatch(
  project: ProjectCopy, relative: string, limits: ProjectLimits = DEFAULT_PROJECT_LIMITS, expectedSha256?: string
): Promise<string> {
  // A hash-bound selection must match a path already validated by the preview.
  const file = expectedSha256 === undefined ? validRelative(relative) : relative.replaceAll('\\', '/');
  const preview = await previewProjectCopy(project, limits);
  if (expectedSha256 !== undefined && preview.sha256 !== expectedSha256) throw new BridgeError('REVIEW_CHANGED', 'The patch changed; preview again before reading');
  if (expectedSha256 !== undefined && !preview.files.some(change => change.path === file)) {
    throw new BridgeError('INVALID_PATCH_PATH', 'Select a changed path from the preview');
  }
  return extractFilePatch(preview, file);
}

// Every eligible file the CLI may edit, including files added by earlier runs, without the bridge's managed files.
export async function editableCopyFiles(project: ProjectCopy, limits: ProjectLimits): Promise<string[]> {
  const checked = await inspectCopyFiles(project, limits, false);
  const auxPaths = managedAuxiliarySet(project);
  return checked.eligible.filter(file => !auxPaths.has(file));
}

export async function snapshotCopyFiles(project: ProjectCopy, limits: ProjectLimits): Promise<Map<string, string>> {
  const checked = await inspectCopyFiles(project, limits, false);
  return new Map(checked.eligible.map(file => [file, checked.records.get(file)!.sha256]));
}

export async function forkProjectCopy(project: ProjectCopy, limits: ProjectLimits): Promise<ProjectCopy> {
  const preflight = await inspectCopyFiles(project, limits, false);
  const auxPaths = managedAuxiliarySet(project);
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
    const tempBaselineDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-worktree-'));
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
        await copyVerifiedFile(source, target, relative, record, budget, 'CONTEXT_CHANGED', project.copyDirectory);
        if (!auxPaths.has(relative)) {
          fork.includedFiles.push(relative);
        }
      }

      const pinnedCommit = preflight.baselineCommit;
      const objectFormat = preflight.baselineObjectFormat;
      const pinnedTree = preflight.baselineTree;

      // 3. Restore pinned commit into owned private temporary baseline worktree
      await copyGit(project, [
        '--git-dir=' + project.gitDirectory,
        '--work-tree=' + tempBaselineDir,
        'restore',
        '--source=' + pinnedCommit,
        '--worktree',
        '--',
        '.'
      ]);

      // 4. Initialize fork private bare repo with same object format (inherits supported ref-format from env)
      await copyGit(fork, [
        '-c', 'init.templateDir=',
        'init',
        '--bare',
        '--object-format=' + objectFormat,
        '--quiet',
        gitDirectory
      ]);
      await treatFilesAsBytes(gitDirectory);

      // 5. Stage private baseline worktree and commit with fixed identity
      const forkBaselineScope = ['--git-dir=' + gitDirectory, '--work-tree=' + tempBaselineDir];
      await copyGit(fork, [...forkBaselineScope, 'add', '-A', '-f', '--', '.']);
      await copyGit(fork, [
        ...forkBaselineScope,
        '-c', 'user.name=Bridge Snapshot',
        '-c', 'user.email=bridge@invalid.local',
        'commit', '--quiet', '--allow-empty', '-m', 'baseline'
      ]);

      // 6. Prove its tree equals pinned source tree
      const forkTree = (await copyGit(fork, ['--git-dir=' + gitDirectory, 'rev-parse', '--verify', 'HEAD^{tree}'])).toString('utf8').trim();
      if (forkTree !== pinnedTree) {
        throw new BridgeError('GIT_OPERATION_FAILED', `Fork baseline tree (${forkTree}) does not match source pinned tree (${pinnedTree})`);
      }

      // 7. Read baseline tree into fork worktree index
      await copyGit(fork, ['--git-dir=' + gitDirectory, '--work-tree=' + copyDirectory, 'read-tree', 'HEAD']);
      await fingerprintProjectCopy(fork, limits);
      const finalHead = (await copyGit(project, ['--git-dir=' + project.gitDirectory, 'rev-parse', '--verify', 'HEAD^{commit}'])).toString('utf8').trim();
      if (finalHead !== pinnedCommit) throw new BridgeError('CONTEXT_CHANGED', 'Source baseline HEAD changed during fork');
      return fork;
    } finally {
      const root = await realpath(os.tmpdir());
      const info = await lstat(tempBaselineDir);
      const absolute = await realpath(tempBaselineDir);
      if (info.isSymbolicLink() || !info.isDirectory() || path.relative(root, path.dirname(absolute)) !== '' || !path.basename(absolute).startsWith('agy-mcp-worktree-')) {
        throw new BridgeError('UNSAFE_PROJECT_PATH', 'Private baseline worktree was replaced or escaped temporary storage');
      }
      await rm(absolute, { recursive: true, force: true });
    }
  } catch (error) {
    await discardProjectCopy(fork);
    throw error;
  }
}

export async function fingerprintProjectCopy(project: ProjectCopy, limits: ProjectLimits = DEFAULT_PROJECT_LIMITS): Promise<string> {
  const checked = await inspectCopyFiles(project, limits, false);
  const digest = createHash('sha256');
  for (const relative of checked.eligible) digest.update(relative + '\0' + checked.records.get(relative)!.sha256 + '\0');
  return digest.digest('hex');
}

interface FileImage { bytes: Buffer; mode: number }

async function readIfPresent(file: string): Promise<Buffer | undefined> {
  try { return await readFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

// checkedPath stops at the first missing component; an addition below it goes to the full path once the ancestors are checked.
async function sourcePath(project: ProjectCopy, relative: string): Promise<string> {
  await checkedPath(project.sourceDirectory, relative, false);
  return path.join(project.sourceDirectory, ...relative.split('/'));
}

// The original's permissions stay; only a mode change written in the file's patch sets or clears its executable bits.
function integratedMode(original: number, filePatch: string): number {
  const changed = /^new mode (\d+)$/m.exec(filePatch)?.[1];
  if (changed === undefined) return original;
  return changed === '100755' ? original | ((original & 0o444) >> 2) : original & ~0o111;
}

// A line that changed only its ending counts as changed when its ending is part of the line and as unchanged when it is not.
async function lineEndingOnlyChanges(project: ProjectCopy, area: string, before: string, after: string): Promise<boolean> {
  const directory = path.join(area, 'lines');
  await mkdir(directory, { recursive: true });
  const rendered = [renderLines(before), renderLines(after)];
  const numstat = async (key: 'withEndings' | 'withoutEndings') => {
    await writeFile(path.join(directory, 'before'), rendered[0]![key]);
    await writeFile(path.join(directory, 'after'), rendered[1]![key]);
    return (await managedGit(project, directory, ['--git-dir=' + project.gitDirectory, 'diff', '--no-index', '--no-ext-diff', '--no-textconv',
      '--numstat', '--minimal', '--', 'before', 'after'], undefined, [0, 1])).toString('utf8').split('\t', 2).join('\t');
  };
  return await numstat('withEndings') !== await numstat('withoutEndings');
}

// Applies the patch to copies of the affected originals in a private area, with no line ending conversion, and checks each
// result against the original it would replace. Nothing in the original is touched here.
async function applyInPrivateArea(project: ProjectCopy, preview: ChangePreview, before: ReadonlyMap<string, FileImage | undefined>):
Promise<{ after: Map<string, FileImage>; restoredByteOrderMarks: string[] }> {
  const area = await mkdtemp(path.join(project.gitDirectory, 'verified-worktree-'));
  const identity = await lstat(area);
  try {
    const worktree = path.join(area, 'after');
    await mkdir(worktree);
    for (const [relative, original] of before) {
      if (!original) continue;
      const target = path.join(worktree, ...relative.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, original.bytes, { flag: 'wx' });
    }
    await managedGit(project, worktree, ['-c', 'core.autocrlf=false', '--git-dir=' + project.gitDirectory, '--work-tree=' + worktree,
      'apply', '--binary', '--whitespace=nowarn', '-'], Buffer.from(preview.patch, 'utf8'), [0]);
    const after = new Map<string, FileImage>();
    const restoredByteOrderMarks: string[] = [];
    const problems: string[] = [];
    for (const file of preview.files) {
      if (file.status === 'D') continue;
      const target = path.join(worktree, ...file.path.split('/'));
      const stat = await lstat(target);
      const original = before.get(file.path);
      if (!original) {
        after.set(file.path, { bytes: await readFile(target), mode: stat.mode });
        continue;
      }
      const checked = checkIntegratedText(original.bytes, await readFile(target));
      if (checked.bomRestored) {
        restoredByteOrderMarks.push(file.path);
        await writeFile(target, checked.content);
      }
      const problem = checked.problem ?? (checked.lines && await lineEndingOnlyChanges(project, area, ...checked.lines)
        ? 'line endings changed on lines that were not edited' : undefined);
      if (problem) problems.push(file.path + ': ' + problem);
      after.set(file.path, { bytes: checked.content, mode: integratedMode(original.mode, extractFilePatch(preview, file.path)) });
    }
    if (problems.length) {
      throw new BridgeError('LINE_ENDINGS_CHANGED', 'Integration refused and the original was not changed: ' + problems.join('; ') +
        '. Restore the line endings and BOM of these files in the copy, for example by resuming the task, and preview again, ' +
        'or apply the reviewed patch yourself without line ending conversion.');
    }
    return { after, restoredByteOrderMarks };
  } finally {
    try { await removeVerifiedWorktree(project, area, identity); }
    catch { await writeFenceMarker(project); throw new BridgeError('GIT_CLEANUP_UNVERIFIED', 'Could not remove the integration area; copy quarantined'); }
  }
}

// Each file is replaced atomically once it still holds its pre-image. A deleted file is only moved aside in its folder while
// files are written, so undoing the deletion puts back the same file with its own permissions. If a write fails, every file
// already written that still holds what was written gets its pre-image back before the error is reported.
async function writeIntegration(project: ProjectCopy, files: ChangePreview['files'], before: ReadonlyMap<string, FileImage | undefined>,
  after: ReadonlyMap<string, FileImage>): Promise<string[]> {
  const root = await realpath(project.sourceDirectory);
  const written: ChangePreview['files'] = [];
  const movedAside = new Map<string, string>();
  const relativeToSource = (file: string) => path.relative(project.sourceDirectory, file).split(path.sep).join('/');
  try {
    for (const file of files) {
      const target = await sourcePath(project, file.path);
      const original = before.get(file.path);
      const current = await readIfPresent(target);
      if (original ? !current?.equals(original.bytes) : current !== undefined) {
        throw new BridgeError('SOURCE_CHANGED', 'Source changed during integration: ' + file.path);
      }
      if (file.status === 'D') {
        const aside = path.join(path.dirname(target), '.' + randomUUID() + '.deleted');
        await rename(target, aside);
        movedAside.set(file.path, aside);
      } else {
        await mkdir(path.dirname(target), { recursive: true });
        await replaceInsideRoot(root, target, after.get(file.path)!.bytes, after.get(file.path)!.mode);
      }
      written.push(file);
    }
  } catch (error) {
    if (!written.length && error instanceof BridgeError) throw error;
    const unrestored: string[] = [];
    for (const file of written.reverse()) {
      const aside = movedAside.get(file.path);
      try {
        const target = await sourcePath(project, file.path);
        if (aside) {
          // link refuses a path that exists, so a file created there meanwhile is never replaced; the moved-aside file then stays.
          if (!await link(aside, target).then(() => true, () => false)) { unrestored.push(file.path + ' (kept as ' + relativeToSource(aside) + ')'); continue; }
          await unlink(aside).catch(() => { unrestored.push(relativeToSource(aside) + ' (a second name of ' + file.path + ')'); });
          continue;
        }
        if (!(await readIfPresent(target))?.equals(after.get(file.path)!.bytes)) { unrestored.push(file.path); continue; }
        const original = before.get(file.path);
        if (original) await replaceInsideRoot(root, target, original.bytes, original.mode);
        else await unlink(target);
      } catch { unrestored.push(aside ? file.path + ' (kept as ' + relativeToSource(aside) + ')' : file.path); }
    }
    const cause = error instanceof BridgeError ? error.code : (error as NodeJS.ErrnoException).code ?? 'write error';
    throw new BridgeError('INTEGRATION_FAILED', 'Integration stopped before it finished (' + cause + '); ' + (unrestored.length
      ? 'these files could not get their previous bytes back: ' + unrestored.join(', ')
      : 'the files already written got their previous bytes back, so the original is as it was'));
  }
  // Every file is written, so the integration is complete; a moved-aside file that cannot be removed is reported, not undone.
  const leftovers: string[] = [];
  for (const aside of movedAside.values()) await unlink(aside).catch(() => { leftovers.push(relativeToSource(aside)); });
  return leftovers;
}

// The original changes only after the whole patch was applied and checked elsewhere. A crash of this process while files
// are being written is not recovered here.
export async function integrateProjectCopy(project: ProjectCopy, expectedSha256: string, limits: ProjectLimits = DEFAULT_PROJECT_LIMITS):
Promise<ChangePreview & { restoredByteOrderMarks?: string[]; leftoverFiles?: string[] }> {
  const preview = await previewProjectCopy(project, limits);
  if (!preview.files.length) throw new BridgeError('NO_CHANGES', 'The isolated copy has no changes');
  if (preview.sha256 !== expectedSha256) throw new BridgeError('REVIEW_CHANGED', 'The copy changed after review; preview it again');
  const before = new Map<string, FileImage | undefined>();
  for (const file of preview.files) {
    const source = await sourcePath(project, file.path);
    const expected = project.baseline.get(file.path);
    if (expected) {
      const bytes = await readFile(source).catch(() => undefined);
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) throw new BridgeError('SOURCE_CHANGED', 'Source changed since copy: ' + file.path);
      before.set(file.path, { bytes, mode: (await lstat(source)).mode });
    } else {
      try { await lstat(source); throw new BridgeError('SOURCE_CHANGED', 'Source already has: ' + file.path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      before.set(file.path, undefined);
    }
  }
  const { after, restoredByteOrderMarks } = await applyInPrivateArea(project, preview, before);
  const leftoverFiles = await writeIntegration(project, preview.files, before, after);
  return { ...preview, ...(restoredByteOrderMarks.length ? { restoredByteOrderMarks } : {}), ...(leftoverFiles.length ? { leftoverFiles } : {}) };
}
