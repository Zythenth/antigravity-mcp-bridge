import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError } from './types.js';
import { portableNodeDescriptor, type AvailablePortableNodeDescriptor, type PortableNodeAssetDescriptor, type PortableNodeDescriptor } from './portable-node-descriptor.js';

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
const windowsPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const releaseRepository = 'https://github.com/Zythenth/antigravity-mcp-bridge';
const releaseTag = 'runtime-node-v24.21.0-lpac1-win-x64';
const buildId = 'node-v24.21.0-lpac1-win-x64';
const nodeVersion = '24.21.0';
const libuvVersion = '1.52.1';
const libuvPatch = 'f46e4246b5277fe1c5888b88b24d8b78020dd4f8';
const cacheRepair = ' Remove the affected portable Node build cache manually, then run --prepare-windows-runtime.';
const reparsePointScript = [
  "$ErrorActionPreference='Stop';$PSModuleAutoLoadingPreference='None';",
  "$decoder=[Text.UnicodeEncoding]::new($false,$false,$true);$count=0;",
  "while(($line=[Console]::In.ReadLine())-ne $null){",
  "if($line.Length-eq 0-or $line.Length%4-ne 0-or $line-notmatch '^[A-Za-z0-9+/]+={0,2}$'){throw 'Invalid path record'};",
  "$target=$decoder.GetString([Convert]::FromBase64String($line));if($target.Length-eq 0){throw 'Empty path'};$count++;",
  "$root=[IO.Path]::GetPathRoot($target);if([string]::IsNullOrEmpty($root)){throw 'Path must be absolute'};",
  "$relative=$target.Substring($root.Length);$current=$root;try{$attributes=[IO.File]::GetAttributes($current)}catch{throw 'Could not inspect root'};",
  "if(($attributes-band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'Reparse point'};",
  "foreach($part in ($relative-split '[\\\\/]+')){if($part.Length-eq 0){continue};$current=[IO.Path]::Combine($current,$part);",
  "try{$attributes=[IO.File]::GetAttributes($current)}catch [IO.FileNotFoundException]{break}catch [IO.DirectoryNotFoundException]{break};",
  "if(($attributes-band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'Reparse point'}}};",
  "if($count-eq 0){throw 'Missing paths'};[Console]::Out.Write('{\"safe\":true}')",
].join('');
const reparsePointCommand = Buffer.from(reparsePointScript, 'utf16le').toString('base64');

function fail(code: string, message: string): never {
  throw new BridgeError(code, message);
}

function sameFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.nlink === right.nlink;
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

async function inspectReparsePoints(paths: string[]): Promise<void> {
  if (process.platform !== 'win32' || paths.length === 0) return;
  const started = performance.now();
  let stdout = '', stdoutChars = 0, stderrChars = 0;
  let stopReason: 'timeout' | 'stdout-limit' | 'stderr-limit' | undefined;
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError: boolean }>(resolve => {
    const child = spawn(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', reparsePointCommand], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let spawnError = false;
    const stop = (reason: NonNullable<typeof stopReason>) => { if (!stopReason) { stopReason = reason; child.kill(); } };
    const timer = setTimeout(() => stop('timeout'), 15_000);
    child.stdout.on('data', chunk => {
      const text = String(chunk);
      stdoutChars += text.length;
      stdout = (stdout + text).slice(0, 1024);
      if (stdoutChars > 1024) stop('stdout-limit');
    });
    child.stderr.on('data', chunk => { stderrChars += String(chunk).length; if (stderrChars > 1024) stop('stderr-limit'); });
    child.once('error', () => { clearTimeout(timer); spawnError = true; });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, spawnError }); });
    child.stdin.end(paths.map(value => Buffer.from(value, 'utf16le').toString('base64')).join('\n') + '\n');
  }).catch(() => ({ code: null, signal: null, spawnError: true }));
  if (result.spawnError || stopReason || result.code !== 0 || stdout !== '{"safe":true}') {
    const reason = result.spawnError ? 'spawn-error' : stopReason ?? (result.code !== 0 ? 'exit-nonzero' : 'invalid-safe-output');
    const diagnostics = `reason=${reason}; elapsedMs=${Math.round(performance.now() - started)}; exitCode=${result.code}; signal=${result.signal}; stdoutChars=${stdoutChars}; stderrChars=${stderrChars}; stdoutTruncated=${stdoutChars > 1024}; stderrTruncated=${stderrChars > 1024}`;
    throw new BridgeError('UNSAFE_PORTABLE_NODE_CACHE', 'Portable runtime cache contains a Windows reparse point or could not be safely inspected (' + diagnostics + ')');
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

async function regularCacheFile(file: string, expectedSize?: number): Promise<Awaited<ReturnType<typeof lstat>>> {
  await inspectReparsePoints([file]);
  const info = await lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('PORTABLE_NODE_NOT_PREPARED', 'Portable Node runtime is incomplete; run --prepare-windows-runtime');
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || !Number.isSafeInteger(info.size) || info.size < 0 ||
      (expectedSize !== undefined && info.size !== expectedSize)) {
    fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node cache contains an unsafe or unexpected file.' + cacheRepair);
  }
  return info;
}

async function sha256File(file: string, expectedSize?: number): Promise<string> {
  const before = await regularCacheFile(file, expectedSize);
  const size = Number(before.size);
  if (!Number.isSafeInteger(size) || size < 0) fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node cache file has an invalid size');
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat();
      if (!sameFile(opened, before)) fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node cache file changed while it was verified.' + cacheRepair);
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
    if (!sameFile(after, before)) fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node cache file changed while it was verified.' + cacheRepair);
    return hash.digest('hex');
  } finally { await handle.close(); }
}

async function verifyAsset(root: string, descriptor: AvailablePortableNodeDescriptor, asset: PortableNodeAssetDescriptor): Promise<void> {
  const file = assetPath(root, descriptor, asset);
  if (await sha256File(file, asset.bytes) !== asset.sha256) {
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

async function recoverDeadPreparationLock(file: string): Promise<boolean> {
  await inspectReparsePoints([file]);
  const before = await lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!before) return true;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || Number(before.size) > 512) {
    fail('PORTABLE_NODE_BUSY', 'Portable Node preparation lock is not safe to recover');
  }
  let owner: unknown;
  try { owner = JSON.parse(await readFile(file, 'utf8')) as unknown; }
  catch { fail('PORTABLE_NODE_BUSY', 'Portable Node preparation lock owner is unknown'); }
  const pid = typeof owner === 'object' && owner !== null ? (owner as { pid?: unknown }).pid : undefined;
  if (!Number.isSafeInteger(pid) || typeof pid !== 'number' || pid < 1 || processAlive(pid)) return false;
  const after = await lstat(file).catch(() => undefined);
  if (!after || !sameFile(before, after)) return false;
  await unlink(file);
  return true;
}

async function acquirePreparationLock(root: string, descriptor: AvailablePortableNodeDescriptor): Promise<() => Promise<void>> {
  const file = path.join(root, '.portable-node-' + descriptor.buildId + '-' + descriptor.assets.node.sha256 + '.lock');
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      const expected = await handle.stat();
      await handle.close();
      return async () => {
        await inspectReparsePoints([file]);
        const current = await lstat(file).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        });
        if (!current) fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node preparation lock disappeared before release');
        if (!sameFile(current, expected)) fail('UNSAFE_PORTABLE_NODE_CACHE', 'Portable Node preparation lock was replaced before release');
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
