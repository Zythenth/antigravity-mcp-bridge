import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { windowsHelperSource } from './windows-helper-source.js';
import { loadConfig } from './config.js';
import { stageWindowsCommand, validateWindowsCommand } from './windows-runtime.js';
import { BridgeError } from './types.js';
import type { TestCommand } from './native-tests.js';
import type { SandboxSelection } from './sandbox-policy.js';
import type { PortableNodeIdentity, WindowsNodeRuntime } from './portable-node.js';

const pathMappingSchema = z.object({ kind: z.enum(['copy', 'runtime', 'scratch']), aliasRoot: z.string().regex(/^[A-Z]:\\$/), physicalRoot: z.string().min(3).max(32767) }).strict();

const executionSchema = z.object({
  nonce: z.string().uuid(), pid: z.number().int().positive().optional(),
  sandbox: z.literal('windows-lpac').optional(), exitCode: z.number().int().min(0).max(0xffffffff).nullable(),
  error: z.string().optional(), output: z.string().max(64000), truncated: z.boolean(), profileDeleted: z.boolean().optional(), aliasesDeleted: z.literal(true),
  pathMappings: z.array(pathMappingSchema).length(3),
}).strict();

const recoverySchema = z.object({ recovered: z.number().int().nonnegative(), active: z.number().int().nonnegative(),
  error: z.string().optional(), output: z.string(), truncated: z.boolean() }).strict();
const libraryRuntime = (() => {
  const config = loadConfig();
  return { mode: config.windowsNodeRuntime, portableNodeCacheDirectory: config.windowsNodeCacheDirectory };
})();

export type WindowsExecution = z.infer<typeof executionSchema> & { portableNode?: PortableNodeIdentity };
export interface WindowsExecutionOptions {
  timeoutSeconds: number;
  maxRuntimeBytes: number;
  maxRuntimeFiles?: number;
  sandbox?: SandboxSelection;
  mode?: 'write' | 'read-only';
  stateDirectory?: string;
  maxFiles?: number;
  protectedPaths?: string[];
  windowsNodeRuntime?: WindowsNodeRuntime;
  portableNodeCacheDirectory?: string;
  signal?: AbortSignal;
  onProcess?: (child: ChildProcessWithoutNullStreams) => void;
}

interface NativeInvocation { code: number | null; stdout: string; stderr: string; }

function verifyPathMappings(result: WindowsExecution, roots: { copy: string; runtime: string; scratch: string }): void {
  const expected = new Map(Object.entries(roots).map(([kind, physicalRoot]) => [kind, path.resolve(physicalRoot).toLocaleLowerCase('en-US')]));
  const aliases = new Set<string>();
  for (const mapping of result.pathMappings) {
    if (expected.get(mapping.kind) !== path.resolve(mapping.physicalRoot).toLocaleLowerCase('en-US')) throw new BridgeError('WINDOWS_EXECUTION_UNVERIFIED', 'Native DOS path mapping did not match an owned execution root');
    if (aliases.has(mapping.aliasRoot)) throw new BridgeError('WINDOWS_EXECUTION_UNVERIFIED', 'Native DOS path mappings reused a drive letter');
    aliases.add(mapping.aliasRoot); expected.delete(mapping.kind);
  }
  if (expected.size !== 0) throw new BridgeError('WINDOWS_EXECUTION_UNVERIFIED', 'Native DOS path mappings were incomplete');
}

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function overlaps(left: string, right: string): boolean { return contains(left, right) || contains(right, left); }

async function ownedDirectory(directory: string, temp: string, prefix: string): Promise<string> {
  const canonical = await realpath(directory);
  if (path.dirname(canonical) !== temp || !path.basename(canonical).startsWith(prefix) || (await lstat(directory)).isSymbolicLink()) {
    throw new BridgeError('UNSAFE_RUNTIME_PATH', 'Windows executor temporary storage was replaced or linked');
  }
  return canonical;
}

async function nativeProcess(executable: string, args: string[], options: WindowsExecutionOptions, input?: string): Promise<NativeInvocation> {
  options.signal?.throwIfAborted();
  const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  options.onProcess?.(child);
  let stdout = '', stderr = '', oversized = false, stopping = false;
  const controllerOutputLimit = Math.max(100000, Math.min(400000, (options.sandbox?.maxOutputChars ?? 4000) * 6 + 12000));
  let hardStop: NodeJS.Timeout | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (input) child.stdin.write(input + '\n', () => {});
    else child.kill();
    hardStop = setTimeout(() => child.kill(), 5000);
    hardStop.unref();
  };
  options.signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, (options.timeoutSeconds + 10) * 1000);
  child.stdout.on('data', chunk => {
    stdout += String(chunk);
    if (stdout.length > controllerOutputLimit) { oversized = true; stop(); }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
  child.stdin.on('error', () => {});
  if (!input) child.stdin.end();
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (oversized) throw new BridgeError('WINDOWS_EXECUTOR_FAILED', 'Native controller output exceeded its limit');
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer); if (hardStop) clearTimeout(hardStop); options.signal?.removeEventListener('abort', stop);
  }
}

async function compileController(temp: string, options: WindowsExecutionOptions): Promise<{ directory: string; helper: string }> {
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!(await lstat(compiler).catch(() => undefined))?.isFile()) throw new BridgeError('WINDOWS_EXECUTOR_UNAVAILABLE', 'The existing Windows .NET Framework compiler is unavailable');
  const directory = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-controller-')));
  const source = path.join(directory, 'runner.cs'), helper = path.join(directory, 'runner.exe');
  try {
    await writeFile(source, windowsHelperSource, { flag: 'wx' });
    const built = await nativeProcess(compiler, ['/nologo', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll', '/nowarn:0649', '/out:' + helper, source], options);
    if (built.code !== 0) throw new BridgeError('WINDOWS_EXECUTOR_BUILD_FAILED', (built.stdout + built.stderr).slice(-4000));
    return { directory, helper };
  } catch (error) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    throw error;
  }
}

async function writeRequest(directory: string, request: unknown): Promise<string> {
  const file = path.join(directory, 'request-' + randomUUID() + '.json');
  await writeFile(file, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  return file;
}

async function removeOwned(directories: Array<readonly [string, string]>, temp: string): Promise<void> {
  const failures: string[] = [];
  for (const [directory, prefix] of directories) {
    try {
      await ownedDirectory(directory, temp, prefix);
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  if (failures.length) throw new BridgeError('UNSAFE_RUNTIME_PATH', failures.join('; '));
}

async function grantPaths(selection: SandboxSelection, protectedPaths: string[], maxFiles: number): Promise<Array<{ path: string; rights: 'read' | 'modify' }>> {
  const protectedCanonical = await Promise.all(protectedPaths.map(async value => {
    try { return await realpath(value); } catch { return path.resolve(value); }
  }));
  const paths = new Map<string, { path: string; rights: 'read' | 'modify' }>();
  const inspect = async (value: string, rights: 'read' | 'modify') => {
    if (!path.isAbsolute(value) || /^(?:\\\\|\/\/)/.test(value) || value.replace(/^[A-Za-z]:[\\/]/, '').includes(':') || value.includes('\0')) {
      throw new BridgeError('INVALID_SANDBOX_PATH', 'Windows permission targets must be local absolute paths');
    }
    const canonical = await realpath(value), root = path.parse(canonical).root;
    if (canonical === root || protectedCanonical.some(blocked => overlaps(blocked, canonical))) {
      throw new BridgeError('SANDBOX_PATH_PROTECTED', 'Windows permission target overlaps a protected path or volume root');
    }
    const relative = path.relative(root, canonical).split(path.sep).filter(Boolean);
    let current = root, entries = 0;
    const walk = async (candidate: string): Promise<void> => {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink > 1)) {
        throw new BridgeError('INVALID_SANDBOX_PATH', 'Windows permission targets cannot contain links, hard links, or non-regular files');
      }
      if (stat.isDirectory()) for (const name of await (await import('node:fs/promises')).readdir(candidate)) {
        if (++entries > maxFiles) throw new BridgeError('SANDBOX_PATH_TOO_LARGE', 'Windows permission directory exceeds its configured file limit');
        await walk(path.join(candidate, name));
      }
    };
    for (const part of relative) { current = path.join(current, part); const stat = await lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory() && current !== canonical) throw new BridgeError('INVALID_SANDBOX_PATH', 'Windows permission target contains a link or non-directory component'); }
    await walk(canonical);
    const key = process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
    const previous = paths.get(key);
    paths.set(key, { path: canonical, rights: previous?.rights === 'modify' || rights === 'modify' ? 'modify' : 'read' });
  };
  for (const value of selection.readPaths) await inspect(value, 'read');
  for (const value of selection.writePaths) await inspect(value, 'modify');
  return [...paths.values()];
}

async function runRecoveryWithController(stateDirectory: string, options: WindowsExecutionOptions): Promise<void> {
  if (process.platform !== 'win32') return;
  const temp = await realpath(os.tmpdir()), controller = await compileController(temp, options);
  try {
    const request = await writeRequest(controller.directory, { action: 'recover', stateDirectory });
    const observed = await nativeProcess(controller.helper, [request], options);
    const result = recoverySchema.parse(JSON.parse(observed.stdout));
    if (observed.code !== 0 || result.error) throw new BridgeError('WINDOWS_EXECUTION_RECOVERY_FAILED', result.error || 'Windows LPAC recovery did not complete');
  } finally { await removeOwned([[controller.directory, 'agy-mcp-controller-']], temp); }
}

export async function recoverWindowsExecutions(stateDirectory: string): Promise<void> {
  const effective = path.resolve(stateDirectory);
  await mkdir(effective, { recursive: true, mode: 0o700 });
  await runRecoveryWithController(effective, { timeoutSeconds: 30, maxRuntimeBytes: 256 * 1024 * 1024 });
}

export async function executeWindowsTest(command: TestCommand, copyDirectory: string, options: WindowsExecutionOptions): Promise<WindowsExecution> {
  if (process.platform !== 'win32') throw new BridgeError('WINDOWS_EXECUTOR_UNAVAILABLE', 'Native Windows execution is only available on Windows');
  validateWindowsCommand(command);
  const selection: SandboxSelection = options.sandbox ?? { readPaths: [], writePaths: [], network: false, childProcesses: true, maxOutputChars: 4000 };
  const mode = options.mode ?? 'write', maxFiles = options.maxFiles ?? 10000;
  const runtimeSelection = { mode: options.windowsNodeRuntime ?? libraryRuntime.mode,
    portableNodeCacheDirectory: options.portableNodeCacheDirectory ?? libraryRuntime.portableNodeCacheDirectory };
  const stateDirectory = path.resolve(options.stateDirectory ?? path.join(os.homedir(), '.antigravity-mcp-bridge'));
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await runRecoveryWithController(stateDirectory, options);
  const temp = await realpath(os.tmpdir()), cwd = await ownedDirectory(copyDirectory, temp, 'agy-mcp-copy-');
  const controller = await compileController(temp, options);
  const runtime = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-runtime-')));
  const scratch = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-scratch-')));
  try {
    const staged = await stageWindowsCommand(command, runtime, { maxBytes: options.maxRuntimeBytes, maxFiles: options.maxRuntimeFiles ?? maxFiles },
      runtimeSelection);
    const grants = await grantPaths(selection, [...(options.protectedPaths ?? []), stateDirectory, runtimeSelection.portableNodeCacheDirectory], maxFiles);
    const nonce = randomUUID(), systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const request = {
      action: mode, nonce, profile: 'agy.test.' + nonce.replaceAll('-', ''), cwd, runtime, scratch, executable: staged.executable, args: staged.args,
      timeoutSeconds: options.timeoutSeconds, maxFiles, maxOutputChars: selection.maxOutputChars, network: selection.network, childProcesses: selection.childProcesses,
      stateDirectory, grants,
      environment: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: [...staged.pathEntries, path.join(systemRoot, 'System32')].join(path.delimiter),
        PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: scratch, TMP: scratch, USERPROFILE: scratch, HOME: scratch, APPDATA: scratch, LOCALAPPDATA: scratch,
        COMSPEC: staged.comspec ?? path.join(systemRoot, 'System32', 'cmd.exe') },
    };
    const file = await writeRequest(controller.directory, request);
    let observed: NativeInvocation;
    try { observed = await nativeProcess(controller.helper, [file], options, 'cancel ' + nonce); }
    finally { await runRecoveryWithController(stateDirectory, { ...options, signal: undefined }); }
    const result = executionSchema.parse(JSON.parse(observed.stdout));
    verifyPathMappings(result, { copy: cwd, runtime, scratch });
    if (result.nonce !== nonce || result.profileDeleted !== true || result.aliasesDeleted !== true || result.output.length > selection.maxOutputChars) throw new BridgeError('WINDOWS_EXECUTION_UNVERIFIED', 'Controller nonce, DOS aliases, output limit, or profile cleanup was not verified');
    if (!result.error && (observed.code !== 0 || result.sandbox !== 'windows-lpac' || result.exitCode === null)) throw new BridgeError('WINDOWS_EXECUTION_UNVERIFIED', 'No verified AppContainer execution result');
    return { ...result, portableNode: staged.portableNode };
  } finally {
    await removeOwned([[scratch, 'agy-mcp-scratch-'], [runtime, 'agy-mcp-runtime-'], [controller.directory, 'agy-mcp-controller-']], temp);
  }
}
