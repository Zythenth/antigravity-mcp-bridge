import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeError } from './types.js';

const maxGitOutput = 10_000_000;

export interface ProjectCopy {
  sourceDirectory: string;
  copyDirectory: string;
  gitDirectory: string;
  baseline: Map<string, string>;
  includedFiles: string[];
}

export interface ChangePreview {
  files: Array<{ status: string; path: string }>;
  patch: string;
  sha256: string;
  sourceDirectory: string;
  copyDirectory: string;
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
}

async function git(cwd: string, args: string[], input?: Buffer, allowedCodes = [0]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let length = 0;
    let stderr = '';
    let overflow = false;
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > maxGitOutput) { overflow = true; child.kill(); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    child.once('error', reject);
    child.once('close', code => {
      if (overflow) reject(new BridgeError('ISOLATION_TOO_LARGE', 'Git output exceeds the isolation limit'));
      else if (!allowedCodes.includes(code ?? -1)) reject(new BridgeError('GIT_OPERATION_FAILED', stderr.trim() || 'git exited with code ' + code));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

function splitNull(bytes: Buffer): string[] {
  return bytes.toString('utf8').split('\0').filter(Boolean);
}

function validRelative(input: string): string {
  const value = input.replaceAll('\\', '/').replace(/\/$/, '');
  const parts = value.split('/');
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value) ||
      parts.some(part => !part || part === '.' || part === '..' || part === '.git')) {
    throw new BridgeError('INVALID_INCLUDE_PATH', 'includePaths must contain project-relative files or directories');
  }
  return value;
}

async function checkedPath(root: string, relative: string, mustExist: boolean): Promise<string> {
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

export async function listProjectFiles(sourceDirectory: string): Promise<string[]> {
  let top: string;
  try { top = (await git(sourceDirectory, ['rev-parse', '--show-toplevel'])).toString('utf8').trim(); }
  catch { throw new BridgeError('ISOLATION_REQUIRES_GIT', 'Isolated copies require a Git repository'); }
  if (path.relative(await realpath(top), await realpath(sourceDirectory)) !== '') {
    throw new BridgeError('INVALID_WORKING_DIRECTORY', 'workingDirectory must be the Git repository root');
  }
  const candidates = [...new Set(splitNull(await git(sourceDirectory, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])))];
  if (!candidates.length) return [];
  const ignored = new Set(splitNull(await git(sourceDirectory,
    ['check-ignore', '--no-index', '--stdin', '-z'], Buffer.from(candidates.join('\0') + '\0'), [0, 1])));
  return candidates.filter(file => !ignored.has(file) && !file.split('/').includes('.git')).sort();
}

export async function createProjectCopy(sourceDirectory: string, includePaths?: string[], onCreated?: (project: ProjectCopy) => void): Promise<ProjectCopy> {
  const candidates = await listProjectFiles(sourceDirectory);
  let selected = candidates;
  if (includePaths !== undefined) {
    if (!includePaths.length) throw new BridgeError('INVALID_INCLUDE_PATH', 'includePaths cannot be empty');
    const wanted = includePaths.map(validRelative);
    for (const item of wanted) {
      if (!candidates.some(file => file === item || file.startsWith(item + '/'))) {
        throw new BridgeError('INVALID_INCLUDE_PATH', 'No eligible file matches: ' + item);
      }
    }
    selected = candidates.filter(file => wanted.some(item => file === item || file.startsWith(item + '/')));
  }
  if (!selected.length) throw new BridgeError('ISOLATION_EMPTY', 'No eligible project files to copy');

  const copyDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-copy-'));
  const gitDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-baseline-'));
  const baseline = new Map<string, string>();
  try {
    const project = { sourceDirectory, copyDirectory, gitDirectory, baseline, includedFiles: selected };
    onCreated?.(project);
    for (const relative of selected) {
      const source = await checkedPath(sourceDirectory, relative, true);
      const target = path.join(copyDirectory, ...relative.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      baseline.set(relative, await sha256File(target));
    }
    await git(copyDirectory, ['-c', 'init.templateDir=', 'init', '--bare', '--quiet', gitDirectory]);
    const scope = ['--git-dir=' + gitDirectory, '--work-tree=' + copyDirectory];
    await git(copyDirectory, [...scope, 'add', '-A', '-f', '--', '.']);
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

export async function previewProjectCopy(project: ProjectCopy): Promise<ChangePreview> {
  const scope = ['--git-dir=' + project.gitDirectory, '--work-tree=' + project.copyDirectory];
  await git(project.copyDirectory, [...scope, 'add', '-A', '--', '.']);
  const names = splitNull(await git(project.copyDirectory,
    [...scope, 'diff', '--cached', '--name-status', '--no-renames', '-z', 'HEAD']));
  const files: ChangePreview['files'] = [];
  for (let index = 0; index < names.length; index += 2) {
    const status = names[index]!;
    const relative = validRelative(names[index + 1] || '');
    if (!['A', 'M', 'D'].includes(status)) throw new BridgeError('UNSAFE_PROJECT_PATH', 'Unsupported file change: ' + relative);
    if (status !== 'D') await checkedPath(project.copyDirectory, relative, true);
    files.push({ status, path: relative });
  }
  const bytes = await git(project.copyDirectory, [...scope, 'diff', '--cached', '--binary', '--no-renames', 'HEAD']);
  return {
    files, patch: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex'),
    sourceDirectory: project.sourceDirectory, copyDirectory: project.copyDirectory,
  };
}

export async function verifyReadOnlyCopy(project: ProjectCopy): Promise<void> {
  const seen = new Set<string>();
  async function visit(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative + '/');
      else {
        seen.add(relative);
        if (!entry.isFile() || project.baseline.get(relative) !== await sha256File(path.join(directory, entry.name))) {
          throw new BridgeError('READ_ONLY_VIOLATION', 'Read-only task changed the copy: ' + relative);
        }
      }
    }
  }
  await visit(project.copyDirectory);
  for (const relative of project.baseline.keys()) if (!seen.has(relative)) {
    throw new BridgeError('READ_ONLY_VIOLATION', 'Read-only task deleted: ' + relative);
  }
}

export async function integrateProjectCopy(project: ProjectCopy, expectedSha256: string): Promise<ChangePreview> {
  const preview = await previewProjectCopy(project);
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
