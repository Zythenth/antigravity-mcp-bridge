import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError } from './types.js';
import { portableNodeDescriptor, type AvailablePortableNodeDescriptor, type PortableNodeAssetDescriptor, type PortableNodeDescriptor } from './portable-node-descriptor.js';
import { reparseInspectorSource } from './windows-helper-source.js';

export type WindowsNodeRuntime = 'system' | 'portable';

export interface PortableNodeIdentity {
  buildId: string;
  nodeVersion: string;
  libuvVersion: string;
  sha256: string;
}

export interface PortableNodeStatus {
  requestedMode: WindowsNodeRuntime;
  supported: boolean;
  ready: boolean;
  buildId: string;
  nodeVersion: string;
  libuvVersion: string;
  sha256: string | null;
  error?: { code: string; message: string };
}

export interface ResolvedPortableNodeRuntime {
  nodePath: string;
  identity: PortableNodeIdentity;
}

export interface PortableNodePreparationOptions {
  cacheDirectory: string;
  descriptor?: PortableNodeDescriptor;
  fetch?: typeof globalThis.fetch;
}

const downloadTimeoutMs = 60_000;
const redirectLimit = 5;
const maxAssetBytes = { 'node.exe': 256 * 1024 * 1024, LICENSE: 1024 * 1024, 'build.json': 1024 * 1024 } as const;
const githubRedirectHosts = new Set(['github.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com', 'release-assets.githubusercontent.com']);
const releaseRepository = 'https://github.com/Zythenth/antigravity-mcp-bridge';
const releaseTag = 'runtime-node-v24.21.0-lpac1-win-x64';
const buildId = 'node-v24.21.0-lpac1-win-x64';
const nodeVersion = '24.21.0';
const libuvVersion = '1.52.1';
const libuvPatch = 'f46e4246b5277fe1c5888b88b24d8b78020dd4f8';
const cacheRepair = ' Remove the affected portable Node build cache manually, then run --prepare-windows-runtime.';

function fail(code: string, message: string): never {
  throw new BridgeError(code, message);
}

function sameFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.nlink === right.nlink;
}

function sameAssetFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function assetPath(root: string, descriptor: AvailablePortableNodeDescriptor, asset: PortableNodeAssetDescriptor): string {
  return path.join(root, cacheLeafName(descriptor), asset.fileName);
}

export function cacheLeafName(descriptor: AvailablePortableNodeDescriptor): string {
  return descriptor.buildId + '-' + descriptor.assets.node.sha256;
}

function descriptorError(descriptor: PortableNodeDescriptor): BridgeError {
  return new BridgeError('PORTABLE_NODE_DESCRIPTOR_UNAVAILABLE', descriptor.available ? 'Portable Node runtime descriptor is invalid' : descriptor.unavailableReason);
}

function requireDescriptor(value: PortableNodeDescriptor): AvailablePortableNodeDescriptor {
  if (!value.available) throw descriptorError(value);
  const assets = [value.assets.node, value.assets.license, value.assets.buildMetadata];
  const names = ['node.exe', 'LICENSE', 'build.json'];
  if (value.buildId !== buildId || value.releaseTag !== releaseTag || value.releaseRepository !== releaseRepository ||
      value.nodeVersion !== nodeVersion || value.libuvVersion !== libuvVersion || value.libuvPatch !== libuvPatch ||
      value.source.repository !== 'https://github.com/nodejs/node' || value.source.ref !== 'v24.21.0' || value.source.libuvPatch !== libuvPatch ||
      value.platform !== 'win32' || value.arch !== 'x64' || value.moduleAbi !== 137 || assets.some((asset, index) =>
    asset.fileName !== names[index] || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > maxAssetBytes[asset.fileName] ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) || !isGithubReleaseAsset(value, asset))) {
    throw descriptorError(value);
  }
  return value;
}

function isGithubReleaseAsset(descriptor: AvailablePortableNodeDescriptor, asset: PortableNodeAssetDescriptor): boolean {
  let url: URL;
  try { url = new URL(asset.url); } catch { return false; }
  let repository: URL;
  try { repository = new URL(descriptor.releaseRepository); } catch { return false; }
  return repository.protocol === 'https:' && repository.hostname === 'github.com' && repository.username === '' && repository.password === '' &&
    url.protocol === 'https:' && url.hostname === repository.hostname && url.username === '' && url.password === '' && url.search === '' && url.hash === '' &&
    url.pathname === repository.pathname + '/releases/download/' + descriptor.releaseTag + '/' + asset.fileName;
}

function absoluteCacheDirectory(value: string): string {
  if (typeof value !== 'string' || value.includes('\0')) fail('INVALID_PORTABLE_NODE_CACHE', 'Portable Node cache directory must be an absolute local path');
  if (process.platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/.test(value) || /^(?:\\\\|\/\/|\\\\\?\\)/.test(value) || value.slice(2).includes(':') ||
        value.slice(2).split(/[\\/]+/).filter(Boolean).some(part => part === '.' || part === '..')) {
      fail('INVALID_PORTABLE_NODE_CACHE', 'Portable Node cache directory must be an absolute local non-device path');
    }
  } else if (!path.isAbsolute(value)) {
    fail('INVALID_PORTABLE_NODE_CACHE', 'Portable Node cache directory must be absolute');
  }
  const absolute = path.resolve(value);
  if (absolute === path.parse(absolute).root) fail('INVALID_PORTABLE_NODE_CACHE', 'Portable Node cache directory cannot be a volume root');
  return absolute;
}

async function verifyOwnedTemporaryDirectory(directory: string, tempRoot: string, prefix: string): Promise<string> {
  const canonical = await realpath(directory);
  if (path.dirname(canonical) !== tempRoot || !path.basename(canonical).startsWith(prefix) || (await lstat(directory)).isSymbolicLink()) {
    fail('UNSAFE_PORTABLE_NODE_CACHE', 'Temporary directory was replaced or linked');
  }
  return canonical;
}

async function removeOwnedDirectory(directory: string, tempRoot: string, prefix: string, expected: Awaited<ReturnType<typeof lstat>>): Promise<void> {
  const canonical = await realpath(directory).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!canonical) return;
  const current = await lstat(directory);
  if (path.dirname(canonical) !== tempRoot || !path.basename(canonical).startsWith(prefix) || !current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) {
    fail('UNSAFE_PORTABLE_NODE_CACHE', 'Temporary cleanup path escaped its intended location');
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

async function inspectReparsePoints(paths: string[]): Promise<void> {
  if (process.platform !== 'win32' || paths.length === 0) return;
  if (typeof reparseInspectorSource !== 'string' || reparseInspectorSource.length === 0) {
    fail('UNSAFE_PORTABLE_NODE_CACHE', 'Native Windows reparse inspector source is unavailable');
  }
  const started = performance.now();
  // A cold .NET compiler on a fresh machine can take far longer than the inspection itself.
  const compileTimeoutMs = 60_000, runTimeoutMs = 15_000;
  let deadline = started + compileTimeoutMs;
  const timeRemainingMs = () => Math.max(0, Math.round(deadline - performance.now()));

  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!(await lstat(compiler).catch(() => undefined))?.isFile()) {
    fail('UNSAFE_PORTABLE_NODE_CACHE', 'The Windows .NET Framework compiler is unavailable');
  }

  const tempRoot = await realpath(os.tmpdir());
  const directory = await realpath(await mkdtemp(path.join(tempRoot, 'agy-mcp-inspector-')));
  const directoryInfo = await lstat(directory);
  const sourceFile = path.join(directory, 'inspector.cs');
  const exeFile = path.join(directory, 'inspector.exe');

  let stdout = '', stdoutChars = 0, stderrChars = 0;
  let stopReason: 'timeout' | 'stdout-limit' | 'stderr-limit' | 'stream-error' | undefined;
  let executionError: unknown;

  try {
    await verifyOwnedTemporaryDirectory(directory, tempRoot, 'agy-mcp-inspector-');
    await writeFile(sourceFile, reparseInspectorSource, { flag: 'wx', mode: 0o600 });

    const compileTimeout = timeRemainingMs();
    if (compileTimeout <= 0) {
      stopReason = 'timeout';
      throw new BridgeError('UNSAFE_PORTABLE_NODE_CACHE', 'Compilation timed out');
    }

    const compileResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError: boolean }>(resolve => {
      const compileChild = spawn(compiler, ['/nologo', '/target:exe', '/platform:x64', '/nowarn:0649', '/out:' + exeFile, sourceFile], {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let compileSpawnError = false;
      let compileOutputChars = 0;
      const killCompile = (reason: 'timeout' | 'stdout-limit' | 'stream-error') => {
        if (!stopReason) {
          stopReason = reason;
          compileChild.kill();
        }
      };
      const compileTimer = setTimeout(() => killCompile('timeout'), compileTimeout);

      compileChild.stdout.on('data', chunk => {
        compileOutputChars += String(chunk).length;
        if (compileOutputChars > 4000) killCompile('stdout-limit');
      });
      compileChild.stderr.on('data', chunk => {
        compileOutputChars += String(chunk).length;
        if (compileOutputChars > 4000) killCompile('stdout-limit');
      });
      compileChild.stdout.on('error', () => killCompile('stream-error'));
      compileChild.stderr.on('error', () => killCompile('stream-error'));
      compileChild.once('error', () => {
        clearTimeout(compileTimer);
        compileSpawnError = true;
      });
      compileChild.once('close', (code, signal) => {
        clearTimeout(compileTimer);
        resolve({ code, signal, spawnError: compileSpawnError });
      });
    }).catch(() => ({ code: null, signal: null, spawnError: true }));

    if (compileResult.spawnError || stopReason || compileResult.code !== 0) {
      const reason = compileResult.spawnError ? 'spawn-error' : stopReason ?? 'exit-nonzero';
      const diagnostics = `reason=${reason}; elapsedMs=${Math.round(performance.now() - started)}; exitCode=${compileResult.code}; signal=${compileResult.signal}; stdoutChars=0; stderrChars=0; stdoutTruncated=false; stderrTruncated=false`;
      throw new BridgeError('UNSAFE_PORTABLE_NODE_CACHE', 'Portable runtime cache contains a Windows reparse point or could not be safely inspected (' + diagnostics + ')');
    }

    const exeStat = await lstat(exeFile).catch(() => undefined);
    if (!exeStat?.isFile()) {
      const diagnostics = `reason=spawn-error; elapsedMs=${Math.round(performance.now() - started)}; exitCode=null; signal=null; stdoutChars=0; stderrChars=0; stdoutTruncated=false; stderrTruncated=false`;
      throw new BridgeError('UNSAFE_PORTABLE_NODE_CACHE', 'Portable runtime cache contains a Windows reparse point or could not be safely inspected (' + diagnostics + ')');
    }

    deadline = performance.now() + runTimeoutMs;
    const runTimeout = timeRemainingMs();
    if (runTimeout <= 0) {
      stopReason = 'timeout';
      const diagnostics = `reason=timeout; elapsedMs=${Math.round(performance.now() - started)}; exitCode=null; signal=null; stdoutChars=0; stderrChars=0; stdoutTruncated=false; stderrTruncated=false`;
      throw new BridgeError('UNSAFE_PORTABLE_NODE_CACHE', 'Portable runtime cache contains a Windows reparse point or could not be safely inspected (' + diagnostics + ')');
    }

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError: boolean }>(resolve => {
      const child = spawn(exeFile, [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let spawnError = false;
      const stop = (reason: NonNullable<typeof stopReason>) => {
        if (!stopReason) {
          stopReason = reason;
          child.kill();
        }
      };
      const timer = setTimeout(() => stop('timeout'), runTimeout);

      child.stdout.on('data', chunk => {
        const text = String(chunk);
        stdoutChars += text.length;
        stdout = (stdout + text).slice(0, 1024);
        if (stdoutChars > 1024) stop('stdout-limit');
      });
      child.stderr.on('data', chunk => {
        stderrChars += String(chunk).length;
        if (stderrChars > 1024) stop('stderr-limit');
      });

      child.stdin.on('error', () => stop('stream-error'));
      child.stdout.on('error', () => stop('stream-error'));
      child.stderr.on('error', () => stop('stream-error'));

      child.once('error', () => {
        clearTimeout(timer);
        spawnError = true;
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, spawnError });
      });

      child.stdin.end(paths.map(value => Buffer.from(value, 'utf16le').toString('base64')).join('\n') + '\n');
    }).catch(() => ({ code: null, signal: null, spawnError: true }));

    if (result.spawnError || stopReason || result.code !== 0 || stdout !== '{"safe":true}') {
      const reason = result.spawnError ? 'spawn-error' : stopReason ?? (result.code !== 0 ? 'exit-nonzero' : 'invalid-safe-output');
      const diagnostics = `reason=${reason}; elapsedMs=${Math.round(performance.now() - started)}; exitCode=${result.code}; signal=${result.signal}; stdoutChars=${stdoutChars}; stderrChars=${stderrChars}; stdoutTruncated=${stdoutChars > 1024}; stderrTruncated=${stderrChars > 1024}`;
      throw new BridgeError('UNSAFE_PORTABLE_NODE_CACHE', 'Portable runtime cache contains a Windows reparse point or could not be safely inspected (' + diagnostics + ')');
    }
  } catch (error) {
    executionError = error;
  } finally {
    let cleanupError: unknown;
    try {
      await removeOwnedDirectory(directory, tempRoot, 'agy-mcp-inspector-', directoryInfo);
    } catch (error) {
      cleanupError = error;
    }
    if (executionError && cleanupError) {
      throw new AggregateError([executionError, cleanupError], 'Reparse inspection and temporary cleanup failed');
    }
    if (executionError) throw executionError;
    if (cleanupError) throw cleanupError;
  }
}



async function inspectCachePath(value: string, create = false): Promise<void> {
  const absolute = absoluteCacheDirectory(value);
  // Check the existing prefix before mkdir can follow an attacker-controlled junction.
  await inspectReparsePoints([absolute]);
  if (create) await mkdir(absolute, { recursive: true, mode: 0o700 });
  const info = await lstat(absolute).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('PORTABLE_NODE_NOT_PREPARED', 'Portable Node runtime has not been prepared');
    throw error;
  });
  if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node cache must be a regular directory');
  await inspectReparsePoints([absolute]);
}

async function regularCacheFile(file: string, expectedSize?: number, allowMultipleLinks = false): Promise<Awaited<ReturnType<typeof lstat>>> {
  await inspectReparsePoints([file]);
  const info = await lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('PORTABLE_NODE_NOT_PREPARED', 'Portable Node runtime is incomplete; run --prepare-windows-runtime');
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink() || (!allowMultipleLinks && info.nlink > 1) || !Number.isSafeInteger(info.size) || info.size < 0 ||
      (expectedSize !== undefined && info.size !== expectedSize)) {
    fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node cache contains an unsafe or unexpected file.' + cacheRepair);
  }
  return info;
}

async function sha256File(file: string, expectedSize?: number, allowMultipleLinks = false): Promise<string> {
  const before = await regularCacheFile(file, expectedSize, allowMultipleLinks);
  const size = Number(before.size);
  if (!Number.isSafeInteger(size) || size < 0) fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node cache file has an invalid size');
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat();
    if (allowMultipleLinks ? !sameAssetFile(opened, before) : !sameFile(opened, before)) {
      fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node cache file changed while it was verified.' + cacheRepair);
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, size)));
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (bytesRead === 0) fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node cache file was truncated while it was verified.' + cacheRepair);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (allowMultipleLinks ? !sameAssetFile(after, before) : !sameFile(after, before)) {
      fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node cache file changed while it was verified.' + cacheRepair);
    }
    return hash.digest('hex');
  } finally { await handle.close(); }
}

async function verifyAsset(root: string, descriptor: AvailablePortableNodeDescriptor, asset: PortableNodeAssetDescriptor): Promise<void> {
  const file = assetPath(root, descriptor, asset);
  if (await sha256File(file, asset.bytes, true) !== asset.sha256) {
    fail('PORTABLE_NODE_HASH_MISMATCH', 'Portable Node cache asset hash does not match the embedded descriptor.' + cacheRepair);
  }
}

async function verifyCacheLayout(root: string, descriptor: AvailablePortableNodeDescriptor): Promise<void> {
  const leaf = path.join(root, cacheLeafName(descriptor));
  const expected = new Set<string>([descriptor.assets.node.fileName, descriptor.assets.license.fileName, descriptor.assets.buildMetadata.fileName]);
  const entries = await readdir(leaf, { withFileTypes: true });
  if (entries.some(entry => !expected.has(entry.name) || !entry.isFile() || entry.isSymbolicLink())) {
    fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node cache build directory has an unexpected entry.' + cacheRepair);
  }
}

export async function resolvePortableNodeRuntime(cacheDirectory: string, descriptor: PortableNodeDescriptor = portableNodeDescriptor): Promise<ResolvedPortableNodeRuntime> {
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('WINDOWS_RUNTIME_UNSUPPORTED', 'Portable Node runtime is only available on Windows x64');
  const pinned = requireDescriptor(descriptor);
  const root = absoluteCacheDirectory(cacheDirectory);
  await inspectCachePath(root);
  const leaf = path.join(root, cacheLeafName(pinned));
  const leafInfo = await lstat(leaf).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('PORTABLE_NODE_NOT_PREPARED', 'Portable Node runtime is not prepared; run --prepare-windows-runtime');
    throw error;
  });
  if (!leafInfo.isDirectory() || leafInfo.isSymbolicLink()) fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node cache build directory is unsafe.' + cacheRepair);
  await inspectReparsePoints([leaf]);
  await verifyCacheLayout(root, pinned);
  await verifyAsset(root, pinned, pinned.assets.node);
  await verifyAsset(root, pinned, pinned.assets.license);
  await verifyAsset(root, pinned, pinned.assets.buildMetadata);
  return { nodePath: assetPath(root, pinned, pinned.assets.node),
    identity: { buildId: pinned.buildId, nodeVersion: pinned.nodeVersion, libuvVersion: pinned.libuvVersion, sha256: pinned.assets.node.sha256 } };
}

async function fetchAsset(url: URL, fetchImpl: typeof globalThis.fetch, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let redirects = 0; redirects <= redirectLimit; redirects++) {
    if (current.protocol !== 'https:' || current.username !== '' || current.password !== '' || current.hash !== '' || !githubRedirectHosts.has(current.hostname)) {
      fail('PORTABLE_NODE_DOWNLOAD_REJECTED', 'Portable Node download URL or redirect host is not allowed');
    }
    const response = await fetchImpl(current, { redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) fail('PORTABLE_NODE_DOWNLOAD_REJECTED', 'Portable Node download redirect did not include a location');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok || !response.body) fail('PORTABLE_NODE_DOWNLOAD_FAILED', 'Portable Node download returned HTTP ' + response.status);
    return response;
  }
  fail('PORTABLE_NODE_DOWNLOAD_REJECTED', 'Portable Node download exceeded the redirect limit');
}

async function downloadAsset(asset: PortableNodeAssetDescriptor, destination: string, fetchImpl: typeof globalThis.fetch): Promise<void> {
  const url = new URL(asset.url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), downloadTimeoutMs);
  try {
    const response = await fetchAsset(url, fetchImpl, controller.signal);
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== asset.bytes)) {
      fail('PORTABLE_NODE_DOWNLOAD_REJECTED', 'Portable Node download size does not match the embedded descriptor');
    }
    const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      const reader = response.body!.getReader();
      const hash = createHash('sha256');
      let bytes = 0;
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        const chunk = Buffer.from(item.value);
        bytes += chunk.length;
        if (bytes > asset.bytes) fail('PORTABLE_NODE_DOWNLOAD_REJECTED', 'Portable Node download exceeded its embedded size limit');
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const written = await file.write(chunk, offset, chunk.length - offset, bytes - chunk.length + offset);
          if (written.bytesWritten === 0) fail('PORTABLE_NODE_DOWNLOAD_FAILED', 'Portable Node download could not be written completely');
          offset += written.bytesWritten;
        }
      }
      if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) {
        fail('PORTABLE_NODE_HASH_MISMATCH', 'Portable Node download does not match the embedded descriptor');
      }
    } finally { await file.close(); }
  } finally { clearTimeout(timeout); }
}

async function removeOwnedTemporary(root: string, temporary: string): Promise<void> {
  if (path.dirname(temporary) !== root || !path.basename(temporary).startsWith('.portable-node-')) {
    fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node temporary cleanup path escaped its cache directory');
  }
  await inspectReparsePoints([temporary]);
  const info = await lstat(temporary).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node temporary directory was replaced');
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

interface PreparationLockRecord {
  v: 1;
  pid: number;
  nonce: string;
}

const lockRecordVersion = 1;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sameLockFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function parsePreparationLock(content: string): { pid: number; isV1: boolean } | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(content) as unknown; }
  catch { return undefined; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const keys = Object.keys(parsed);

  // Exact legacy format: ONLY { pid }
  if (keys.length === 1 && keys[0] === 'pid') {
    const pid = (parsed as { pid?: unknown }).pid;
    if (Number.isSafeInteger(pid) && typeof pid === 'number' && pid >= 1) {
      return { pid, isV1: false };
    }
    return undefined;
  }

  // Exact v1 format: ONLY { v: 1, pid, nonce }
  if (keys.length === 3 && 'v' in parsed && 'pid' in parsed && 'nonce' in parsed) {
    const record = parsed as Record<string, unknown>;
    if (record.v !== lockRecordVersion) return undefined;
    const pid = record.pid;
    if (!Number.isSafeInteger(pid) || typeof pid !== 'number' || pid < 1) return undefined;
    if (typeof record.nonce !== 'string' || !uuidPattern.test(record.nonce)) return undefined;
    return { pid, isV1: true };
  }

  return undefined;
}

async function readBoundedLockFile(handle: Awaited<ReturnType<typeof open>>, expectedStat: Awaited<ReturnType<typeof lstat>>, expectedBytes: number, limit: number): Promise<string> {
  const openedStat = await handle.stat();
  if (!openedStat.isFile() || openedStat.isSymbolicLink() || !sameLockFile(openedStat, expectedStat)) {
    fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node preparation lock file descriptor is invalid');
  }
  const buffer = Buffer.alloc(Math.min(limit, expectedBytes + 1));
  let totalRead = 0;
  while (totalRead < buffer.length) {
    const { bytesRead } = await handle.read(buffer, totalRead, buffer.length - totalRead, totalRead);
    if (bytesRead === 0) break;
    totalRead += bytesRead;
  }
  if (totalRead !== expectedBytes) {
    fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node preparation lock file size mismatch');
  }
  const afterReadStat = await handle.stat();
  if (!sameLockFile(afterReadStat, expectedStat)) {
    fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node preparation lock changed while reading');
  }
  return buffer.subarray(0, totalRead).toString('utf8');
}

async function recoverDeadPreparationLock(file: string): Promise<boolean> {
  await inspectReparsePoints([file]);
  const before = await lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!before) return true;
  if (!before.isFile() || before.isSymbolicLink() || Number(before.size) <= 0 || Number(before.size) > 512) {
    fail('PORTABLE_NODE_BUSY', 'Portable Node preparation lock is not safe to recover');
  }

  const handle = await open(file, constants.O_RDONLY).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!handle) return true;

  let content: string;
  try {
    content = await readBoundedLockFile(handle, before, Number(before.size), 513);
  } catch (error) {
    fail('PORTABLE_NODE_BUSY', error instanceof Error ? error.message : 'Portable Node preparation lock is not safe to recover');
  } finally {
    await handle.close();
  }

  const record = parsePreparationLock(content);
  if (!record) {
    fail('PORTABLE_NODE_BUSY', 'Portable Node preparation lock owner is unknown');
  }

  // Legacy format (pid-only, no v1 marker): only recoverable when nlink === 1
  if (!record.isV1 && before.nlink > 1) {
    fail('PORTABLE_NODE_BUSY', 'Portable Node preparation lock is not safe to recover');
  }

  if (processAlive(record.pid)) return false;

  const after = await lstat(file).catch(() => undefined);
  if (!after || !sameLockFile(before, after)) return false;
  if (!record.isV1 && after.nlink !== before.nlink) return false;

  await unlink(file);
  return true;
}

async function acquirePreparationLock(root: string, descriptor: AvailablePortableNodeDescriptor): Promise<() => Promise<void>> {
  const file = path.join(root, '.portable-node-' + descriptor.buildId + '-' + descriptor.assets.node.sha256 + '.lock');
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const nonce = randomUUID();
      const record: PreparationLockRecord = { v: lockRecordVersion, pid: process.pid, nonce };
      const lockPayload = JSON.stringify(record);
      const expectedSize = Buffer.byteLength(lockPayload, 'utf8');
      const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      await handle.writeFile(lockPayload);
      const expected = await handle.stat();
      await handle.close();
      return async () => {
        await inspectReparsePoints([file]);
        const current = await lstat(file).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        });
        if (!current) fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node preparation lock disappeared before release');
        if (!current.isFile() || current.isSymbolicLink() || !sameLockFile(current, expected)) {
          fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node preparation lock was replaced before release');
        }

        const readHandle = await open(file, constants.O_RDONLY).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node preparation lock disappeared before release');
          }
          throw error;
        });
        try {
          const readContent = await readBoundedLockFile(readHandle, expected, expectedSize, 513);
          if (readContent !== lockPayload) {
            fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node preparation lock was replaced before release');
          }
        } finally {
          await readHandle.close();
        }

        const finalPathStat = await lstat(file).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node preparation lock disappeared before release');
          }
          throw error;
        });
        if (!finalPathStat.isFile() || finalPathStat.isSymbolicLink() || !sameLockFile(finalPathStat, expected)) {
          fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node preparation lock was replaced before release');
        }

        await unlink(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await recoverDeadPreparationLock(file)) continue;
      try { await resolvePortableNodeRuntime(root, descriptor); return async () => {}; }
      catch (verifyError) {
        if (!(verifyError instanceof BridgeError) || verifyError.code !== 'PORTABLE_NODE_NOT_PREPARED') throw verifyError;
      }
      await delay(250);
    }
  }
  fail('PORTABLE_NODE_BUSY', 'Another process is preparing the portable Node runtime');
}

export async function preparePortableNodeRuntime(options: PortableNodePreparationOptions): Promise<ResolvedPortableNodeRuntime> {
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('WINDOWS_RUNTIME_UNSUPPORTED', 'Portable Node preparation is only available on Windows x64');
  const descriptor = requireDescriptor(options.descriptor ?? portableNodeDescriptor);
  const root = absoluteCacheDirectory(options.cacheDirectory);
  await inspectCachePath(root, true);
  try { return await resolvePortableNodeRuntime(root, descriptor); }
  catch (error) {
    if (!(error instanceof BridgeError) || error.code !== 'PORTABLE_NODE_NOT_PREPARED') throw error;
  }
  const release = await acquirePreparationLock(root, descriptor);
  const temporary = path.join(root, '.portable-node-' + randomUUID());
  try {
    try { return await resolvePortableNodeRuntime(root, descriptor); }
    catch (error) {
      if (!(error instanceof BridgeError) || error.code !== 'PORTABLE_NODE_NOT_PREPARED') throw error;
    }
    await mkdir(temporary, { mode: 0o700 });
    await inspectReparsePoints([temporary]);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    for (const asset of [descriptor.assets.node, descriptor.assets.license, descriptor.assets.buildMetadata]) {
      await downloadAsset(asset, path.join(temporary, asset.fileName), fetchImpl);
    }
    const final = path.join(root, cacheLeafName(descriptor));
    try { await rename(temporary, final); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      try { await lstat(final); }
      catch { throw error; }
    }
    return await resolvePortableNodeRuntime(root, descriptor);
  } finally {
    let cleanupError: unknown;
    try { await removeOwnedTemporary(root, temporary); }
    catch (error) { cleanupError = error; }
    try { await release(); }
    catch (releaseError) {
      if (cleanupError) throw new AggregateError([cleanupError, releaseError], 'Portable Node preparation cleanup and lock release failed');
      throw releaseError;
    }
    if (cleanupError) throw cleanupError;
  }
}

export async function portableNodeStatus(requestedMode: WindowsNodeRuntime, cacheDirectory: string,
  descriptor: PortableNodeDescriptor = portableNodeDescriptor): Promise<PortableNodeStatus> {
  const base = { requestedMode, supported: process.platform === 'win32' && process.arch === 'x64', ready: false, buildId: descriptor.buildId,
    nodeVersion: descriptor.nodeVersion, libuvVersion: descriptor.libuvVersion, sha256: descriptor.available ? descriptor.assets.node.sha256 : null };
  if (!base.supported) return { ...base, error: { code: 'WINDOWS_RUNTIME_UNSUPPORTED', message: 'Portable Node is only supported on Windows x64' } };
  try {
    const runtime = await resolvePortableNodeRuntime(cacheDirectory, descriptor);
    return { ...base, ready: true, sha256: runtime.identity.sha256 };
  } catch (error) {
    return { ...base, error: { code: error instanceof BridgeError ? error.code : 'PORTABLE_NODE_STATUS_FAILED', message: error instanceof Error ? error.message : String(error) } };
  }
}
