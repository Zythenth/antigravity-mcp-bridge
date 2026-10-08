import { constants, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { TestCommand } from './native-tests.js';
import { BridgeError } from './types.js';
import { resolvePortableNodeRuntime, type PortableNodeIdentity, type WindowsNodeRuntime } from './portable-node.js';

const maxInspectionBytes = 128 * 1024;

export interface WindowsRuntimeLimits {
  maxBytes: number;
  maxFiles: number;
}

export interface StagedWindowsCommand {
  executable: string;
  args: string[];
  pathEntries: string[];
  comspec?: string;
  portableNode?: PortableNodeIdentity;
}

export interface WindowsRuntimeSelection {
  mode?: WindowsNodeRuntime;
  portableNodeCacheDirectory?: string;
}

interface CopyState extends WindowsRuntimeLimits {
  runtime: string;
  bytes: number;
  entries: number;
  sources: Map<string, string>;
  targets: Map<string, string>;
  directories: Set<string>;
}

function fail(code: string, message: string): never {
  throw new BridgeError(code, message);
}

function canonicalKey(file: string): string {
  return path.resolve(file).toLocaleLowerCase('en-US');
}

function isUnsafeWindowsPath(value: string): boolean {
  const normalized = value.replaceAll('/', '\\');
  const basename = path.win32.basename(normalized).replace(/[ .]+$/u, '');
  const withoutDrive = normalized.replace(/^[A-Za-z]:\\/, '');
  return normalized.includes('\0') || /^(?:\\\\|\/\/)/u.test(normalized) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(basename) || withoutDrive.includes(':');
}

export function validateWindowsCommand(command: TestCommand): void {
  if (typeof command.executable !== 'string' || !Array.isArray(command.args) ||
      command.executable.length === 0 || command.executable.length > 1000 || command.args.length > 50 ||
      isUnsafeWindowsPath(command.executable) || command.args.some(argument => typeof argument !== 'string' || argument.length > 4000 || argument.includes('\0'))) {
    fail('INVALID_TEST_COMMAND', 'Windows commands cannot use remote paths, device paths, alternate streams or NUL characters');
  }
  const normalized = command.executable.replaceAll('/', '\\');
  if (normalized.split('\\').some(part => part === '.' || part === '..')) {
    fail('INVALID_TEST_COMMAND', 'Windows command paths cannot contain traversal segments');
  }
  if (!path.isAbsolute(command.executable) && /[\\/]/u.test(command.executable)) {
    fail('INVALID_TEST_COMMAND', 'Windows commands must resolve by absolute path or PATH');
  }
}

function validateLimits(limits: WindowsRuntimeLimits): void {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || !Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 1) {
    fail('INVALID_RUNTIME_LIMIT', 'Runtime byte and file limits must be positive safe integers');
  }
}

async function assertSafePath(file: string): Promise<void> {
  const absolute = path.resolve(file);
  const parsed = path.parse(absolute);
  const parts = path.relative(parsed.root, absolute).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail('UNSAFE_RUNTIME_PATH', 'Runtime files and directories cannot use links: ' + file);
  }
}

function isSameFile(observed: Stats, expected: Stats): boolean {
  return observed.dev === expected.dev && observed.ino === expected.ino && observed.size === expected.size && observed.nlink === expected.nlink;
}

async function regularFile(file: string, allowMultipleLinks = false): Promise<Stats> {
  await assertSafePath(file);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) fail('UNSAFE_RUNTIME_PATH', 'Runtime files must be regular files: ' + file);
  if (!allowMultipleLinks && info.nlink > 1) fail('UNSAFE_RUNTIME_PATH', 'Runtime files cannot have multiple hard links: ' + file);
  if (!Number.isSafeInteger(info.size) || info.size < 0) fail('UNSAFE_RUNTIME_PATH', 'Runtime file has an invalid size: ' + file);
  return info;
}

async function readBoundedFile(file: string, limit: number): Promise<Buffer> {
  const expected = await regularFile(file);
  if (expected.size > limit) fail('WINDOWS_NPM_LAYOUT_UNSUPPORTED', 'The npm launcher or manifest exceeds its inspection limit');
  const source = await open(file, 'r');
  try {
    const observed = await source.stat();
    if (!observed.isFile() || observed.nlink > 1 || !isSameFile(observed, expected) || observed.size > limit) {
      fail('WINDOWS_NPM_LAYOUT_UNSUPPORTED', 'The npm launcher or manifest changed while it was inspected');
    }
    const bytes = Buffer.alloc(expected.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await source.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) fail('WINDOWS_NPM_LAYOUT_UNSUPPORTED', 'The npm launcher or manifest was truncated while it was inspected');
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await source.close();
  }
}

function commandNames(executable: string): { kind: 'npm' | 'native'; names: string[] } {
  const basename = path.win32.basename(executable).toLocaleLowerCase('en-US');
  if (basename === 'npm' || basename === 'npm.cmd') {
    return { kind: 'npm', names: [basename === 'npm' ? executable + '.cmd' : executable] };
  }
  const extension = path.extname(executable).toLocaleLowerCase('en-US');
  if (extension === '.cmd' || extension === '.bat') {
    fail('WINDOWS_COMMAND_UNSUPPORTED', 'Only npm.cmd is supported; arbitrary Windows command scripts are not supported');
  }
  if (extension && extension !== '.exe') {
    fail('WINDOWS_EXECUTABLE_UNSUPPORTED', 'The Windows executor requires a native .exe or npm.cmd');
  }
  return { kind: 'native', names: [extension ? executable : executable + '.exe'] };
}

async function resolveCommand(executable: string): Promise<{ file: string; kind: 'npm' | 'native' }> {
  const requested = commandNames(executable);
  const directories = path.isAbsolute(executable) ? [''] : (process.env.PATH || '').split(path.delimiter).filter(directory => directory && path.isAbsolute(directory));
  for (const directory of directories) {
    for (const name of requested.names) {
      const candidate = path.isAbsolute(name) ? path.resolve(name) : path.resolve(directory, name);
      try {
        if (!(await lstat(candidate)).isFile()) continue;
        await regularFile(candidate);
        return { file: candidate, kind: requested.kind };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
        throw error;
      }
    }
  }
  fail('WINDOWS_EXECUTABLE_NOT_FOUND', 'Test executable was not found: ' + executable);
}

function stagedPath(runtime: string, relative: string[]): string {
  const target = path.resolve(runtime, ...relative);
  const prefix = runtime.endsWith(path.sep) ? runtime : runtime + path.sep;
  if (!target.startsWith(prefix)) fail('UNSAFE_RUNTIME_PATH', 'Runtime staging path escaped its owned directory');
  return target;
}

async function stageDirectory(directory: string, state: CopyState): Promise<void> {
  const target = path.resolve(directory);
  if (target === state.runtime) return;
  const prefix = state.runtime.endsWith(path.sep) ? state.runtime : state.runtime + path.sep;
  if (!target.startsWith(prefix)) fail('UNSAFE_RUNTIME_PATH', 'Runtime staging path escaped its owned directory');
  const targetKey = canonicalKey(target);
  if (state.directories.has(targetKey)) return;
  if (state.targets.has(targetKey)) fail('UNSAFE_RUNTIME_PATH', 'A runtime file conflicts with a staging directory');
  const parent = path.dirname(target);
  if (parent === target) fail('UNSAFE_RUNTIME_PATH', 'Runtime staging path escaped its owned directory');
  await stageDirectory(parent, state);
  if (state.entries + 1 > state.maxFiles) fail('ISOLATION_TOO_LARGE', 'Runtime exceeds the configured copy file or byte limit');
  await mkdir(target);
  state.entries++;
  state.directories.add(targetKey);
}

async function stageFile(sourcePath: string, targetPath: string, state: CopyState, requirePe = false, allowMultipleLinks = false,
  expectedSha256?: string): Promise<string> {
  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);
  const sourceKey = canonicalKey(source);
  const targetKey = canonicalKey(target);
  const previousTarget = state.sources.get(sourceKey);
  if (previousTarget !== undefined) {
    if (previousTarget !== targetKey) fail('UNSAFE_RUNTIME_PATH', 'A runtime source was assigned more than one staging path');
    return target;
  }
  const previousSource = state.targets.get(targetKey);
  if (previousSource !== undefined && previousSource !== sourceKey) {
    fail('UNSAFE_RUNTIME_PATH', 'Different runtime sources would overwrite the same staging path');
  }
  const expected = await regularFile(source, allowMultipleLinks);
  if (state.entries + 1 > state.maxFiles || state.bytes + expected.size > state.maxBytes) {
    fail('ISOLATION_TOO_LARGE', 'Runtime exceeds the configured copy file or byte limit');
  }
  await stageDirectory(path.dirname(target), state);
  const sourceHandle = await open(source, 'r');
  let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    const observed = await sourceHandle.stat();
    if (!observed.isFile() || (!allowMultipleLinks && observed.nlink > 1) || !isSameFile(observed, expected)) fail('UNSAFE_RUNTIME_PATH', 'Runtime file changed while it was staged: ' + source);
    if (requirePe) {
      const dosHeader = Buffer.alloc(64);
      const dosRead = await sourceHandle.read(dosHeader, 0, dosHeader.length, 0);
      const peOffset = dosRead.bytesRead === dosHeader.length ? dosHeader.readUInt32LE(0x3c) : 0;
      if (dosHeader.subarray(0, 2).toString('ascii') !== 'MZ' || peOffset < dosHeader.length || peOffset > expected.size - 4) {
        fail('WINDOWS_EXECUTABLE_UNSUPPORTED', 'Runtime executable or DLL has no Windows image header');
      }
      const signature = Buffer.alloc(4);
      const signatureRead = await sourceHandle.read(signature, 0, signature.length, peOffset);
      if (signatureRead.bytesRead !== signature.length || signature.toString('ascii') !== 'PE\0\0') {
        fail('WINDOWS_EXECUTABLE_UNSUPPORTED', 'Runtime executable or DLL has no Windows image header');
      }
    }
    targetHandle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o444);
    created = true;
    const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, expected.size)));
    const hash = expectedSha256 ? createHash('sha256') : undefined;
    let offset = 0;
    while (offset < expected.size) {
      const length = Math.min(buffer.length, expected.size - offset);
      const { bytesRead } = await sourceHandle.read(buffer, 0, length, offset);
      if (bytesRead === 0) fail('UNSAFE_RUNTIME_PATH', 'Runtime file was truncated while it was staged: ' + source);
      hash?.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await targetHandle.write(buffer, written, bytesRead - written, offset + written);
        if (result.bytesWritten === 0) fail('UNSAFE_RUNTIME_PATH', 'Runtime file could not be staged completely: ' + source);
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    const after = await sourceHandle.stat();
    if (!after.isFile() || (!allowMultipleLinks && after.nlink > 1) || !isSameFile(after, expected)) fail('UNSAFE_RUNTIME_PATH', 'Runtime file changed while it was staged: ' + source);
    if (hash && hash.digest('hex') !== expectedSha256) fail('PORTABLE_NODE_HASH_MISMATCH', 'Portable Node cache executable changed while it was staged');
    await chmod(target, 0o444);
    state.entries++;
    state.bytes += expected.size;
    state.sources.set(sourceKey, targetKey);
    state.targets.set(targetKey, sourceKey);
    return target;
  } catch (error) {
    if (created) await unlink(target).catch(() => {});
    throw error;
  } finally {
    await targetHandle?.close();
    await sourceHandle.close();
  }
}

async function hashStagedFile(file: string): Promise<string> {
  const expected = await regularFile(file);
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!isSameFile(opened, expected)) fail('UNSAFE_RUNTIME_PATH', 'Staged runtime file changed while it was verified');
    const hash = createHash('sha256'), buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, expected.size)));
    let offset = 0;
    while (offset < expected.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expected.size - offset), offset);
      if (bytesRead === 0) fail('UNSAFE_RUNTIME_PATH', 'Staged runtime file was truncated while it was verified');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (!isSameFile(await handle.stat(), expected)) fail('UNSAFE_RUNTIME_PATH', 'Staged runtime file changed while it was verified');
    return hash.digest('hex');
  } finally { await handle.close(); }
}

async function stageNativeExecutable(source: string, destination: string, state: CopyState, expectedSha256?: string): Promise<string> {
  const executable = await stageFile(source, destination, state, true, false, expectedSha256);
  if (expectedSha256 && await hashStagedFile(executable) !== expectedSha256) {
    fail('PORTABLE_NODE_HASH_MISMATCH', 'Staged portable Node executable hash does not match the embedded descriptor');
  }
  if (expectedSha256) return executable;
  const directory = path.dirname(source);
  const siblings = await readdir(directory, { withFileTypes: true });
  for (const entry of siblings.sort((left, right) => left.name.localeCompare(right.name, 'en-US'))) {
    if (!/\.dll$/iu.test(entry.name)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) fail('UNSAFE_RUNTIME_PATH', 'Runtime DLLs must be regular files');
    await stageFile(path.join(directory, entry.name), path.join(path.dirname(destination), entry.name), state, true);
  }
  return executable;
}

function npmPathIsOmitted(parts: string[]): boolean {
  const lower = parts.map(part => part.toLocaleLowerCase('en-US'));
  const name = lower.at(-1)!;
  if (lower.some(part => part === 'docs' || part === 'man')) return true;
  if (lower.length === 1 && name === 'cache') return true;
  if (name === '.npmrc' || name === '.netrc' || name === 'credentials' || name === 'credentials.json') return true;
  return name === 'npmrc' && lower.length !== 1;
}

function npmrcContainsSecret(contents: string): boolean {
  return /(?:^|\r?\n)\s*(?:(?:\/\/)[^\s:]+(?::\d+)?\/?:)?(?:_auth(?:token)?|_password|password|token|certfile|keyfile)\s*=/iu.test(contents);
}

async function stageNpmDirectory(source: string, destination: string, state: CopyState, relative: string[] = []): Promise<void> {
  await stageDirectory(destination, state);
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US'))) {
    const childRelative = [...relative, entry.name];
    if (npmPathIsOmitted(childRelative)) continue;
    const childSource = path.join(source, entry.name);
    const childDestination = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) fail('UNSAFE_RUNTIME_PATH', 'npm runtime files and directories cannot use links');
    if (entry.isDirectory()) {
      await stageNpmDirectory(childSource, childDestination, state, childRelative);
    } else if (entry.isFile()) {
      if (childRelative.length === 1 && entry.name.toLocaleLowerCase('en-US') === 'npmrc') {
        const contents = (await readBoundedFile(childSource, maxInspectionBytes)).toString('utf8');
        if (npmrcContainsSecret(contents)) fail('WINDOWS_NPM_LAYOUT_UNSUPPORTED', 'The bundled npm configuration contains credentials');
      }
      await stageFile(childSource, childDestination, state);
    } else {
      fail('UNSAFE_RUNTIME_PATH', 'npm runtime contains an unsupported file type');
    }
  }
}

async function stageSystemCmd(systemRoot: string, runtime: string, state: CopyState): Promise<string> {
  const source = path.join(systemRoot, 'System32', 'cmd.exe');
  return stageFile(source, stagedPath(runtime, ['system32', 'cmd.exe']), state, true, true);
}

async function stageNpm(launcher: string, runtime: string, state: CopyState, args: string[], portableNode?: { nodePath: string; identity: PortableNodeIdentity }): Promise<StagedWindowsCommand> {
  const launcherText = (await readBoundedFile(launcher, maxInspectionBytes)).toString('utf8').replaceAll('/', '\\').toLocaleLowerCase('en-US');
  if (!launcherText.includes('node_modules\\npm\\bin\\npm-cli.js')) {
    fail('WINDOWS_NPM_LAYOUT_UNSUPPORTED', 'The npm launcher does not reference the expected npm-cli.js layout');
  }
  const nodeDirectory = path.dirname(launcher);
  const nodeSource = path.join(nodeDirectory, 'node.exe');
  const npmSource = path.join(nodeDirectory, 'node_modules', 'npm');
  const manifestPath = path.join(npmSource, 'package.json');
  const cliSource = path.join(npmSource, 'bin', 'npm-cli.js');
  let manifest: unknown;
  try {
    manifest = JSON.parse((await readBoundedFile(manifestPath, maxInspectionBytes)).toString('utf8'));
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    fail('WINDOWS_NPM_LAYOUT_UNSUPPORTED', 'The installed npm package manifest is invalid');
  }
  const npmManifest = typeof manifest === 'object' && manifest !== null ? manifest as { bin?: unknown; name?: unknown } : undefined;
  const bin = npmManifest?.bin;
  const npmBin = typeof bin === 'object' && bin !== null ? (bin as Record<string, unknown>).npm : undefined;
  if (npmManifest?.name !== 'npm' ||
      typeof npmBin !== 'string' || npmBin.replaceAll('/', '\\').toLocaleLowerCase('en-US') !== 'bin\\npm-cli.js') {
    fail('WINDOWS_NPM_LAYOUT_UNSUPPORTED', 'The installed npm package name or bin entry is incompatible with staged execution');
  }
  await regularFile(cliSource);
  const node = await stageNativeExecutable(portableNode?.nodePath ?? nodeSource, stagedPath(runtime, ['node.exe']), state, portableNode?.identity.sha256);
  await stageNpmDirectory(npmSource, stagedPath(runtime, ['node_modules', 'npm']), state);
  const cli = stagedPath(runtime, ['node_modules', 'npm', 'bin', 'npm-cli.js']);
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  if (!path.isAbsolute(systemRoot) || isUnsafeWindowsPath(systemRoot)) {
    fail('WINDOWS_EXECUTOR_UNAVAILABLE', 'SystemRoot does not identify a safe Windows system directory');
  }
  const comspec = await stageSystemCmd(systemRoot, runtime, state);
  return { executable: node, args: [cli, ...args], pathEntries: [path.dirname(node)], comspec, portableNode: portableNode?.identity };
}

async function hostNodeIdentity(file: string): Promise<boolean> {
  const [candidate, host] = await Promise.all([regularFile(file), regularFile(process.execPath)]);
  return isSameFile(candidate, host);
}

async function portableNodeForHostRuntime(file: string, selection: WindowsRuntimeSelection): Promise<{ nodePath: string; identity: PortableNodeIdentity } | undefined> {
  if ((selection.mode ?? 'system') !== 'portable' || !await hostNodeIdentity(file)) return undefined;
  const major = Number.parseInt(process.versions.node.split('.')[0] || '', 10);
  if (major !== 24) fail('PORTABLE_NODE_HOST_UNSUPPORTED', 'Portable Node substitution requires the bridge host Node.js major version to be 24');
  if (!selection.portableNodeCacheDirectory) fail('PORTABLE_NODE_NOT_PREPARED', 'Portable Node cache directory was not configured');
  return resolvePortableNodeRuntime(selection.portableNodeCacheDirectory);
}

export async function stageWindowsCommand(command: TestCommand, runtimeDirectory: string, limits: WindowsRuntimeLimits,
  selection: WindowsRuntimeSelection = {}): Promise<StagedWindowsCommand> {
  if (process.platform !== 'win32') fail('WINDOWS_EXECUTOR_UNAVAILABLE', 'Native Windows execution is only available on Windows');
  validateWindowsCommand(command);
  validateLimits(limits);
  const runtime = path.resolve(runtimeDirectory);
  await assertSafePath(runtime);
  const runtimeInfo = await lstat(runtime);
  if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink() || (await readdir(runtime)).length !== 0) {
    fail('UNSAFE_RUNTIME_PATH', 'Windows runtime staging requires an empty owned directory');
  }
  const state: CopyState = { ...limits, runtime, bytes: 0, entries: 0, sources: new Map(), targets: new Map(), directories: new Set() };
  const resolved = await resolveCommand(command.executable);
  if (resolved.kind === 'npm') {
    const adjacentNode = path.join(path.dirname(resolved.file), 'node.exe');
    return stageNpm(resolved.file, runtime, state, command.args, await portableNodeForHostRuntime(adjacentNode, selection));
  }
  const portableNode = await portableNodeForHostRuntime(resolved.file, selection);
  const executable = await stageNativeExecutable(portableNode?.nodePath ?? resolved.file, stagedPath(runtime, [path.basename(resolved.file)]), state, portableNode?.identity.sha256);
  return { executable, args: [...command.args], pathEntries: [path.dirname(executable)], portableNode: portableNode?.identity };
}
