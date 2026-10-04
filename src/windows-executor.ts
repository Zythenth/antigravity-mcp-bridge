import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFile, lstat, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { windowsHelperSource } from './windows-helper-source.js';
import { BridgeError } from './types.js';
import type { TestCommand } from './native-tests.js';

const executionSchema = z.object({
  nonce: z.string().uuid(), pid: z.number().int().positive().optional(),
  sandbox: z.literal('windows-lpac').optional(), exitCode: z.number().int().min(0).max(0xffffffff).nullable(),
  error: z.string().optional(), output: z.string().max(4000), truncated: z.boolean(), profileDeleted: z.boolean().optional(),
}).strict();
export type WindowsExecution = z.infer<typeof executionSchema>;
export interface WindowsExecutionOptions {
  timeoutSeconds: number;
  maxRuntimeBytes: number;
  signal?: AbortSignal;
  onProcess?: (child: ChildProcessWithoutNullStreams) => void;
}

async function nativeProcess(executable: string, args: string[], options: WindowsExecutionOptions, input?: string) {
  options.signal?.throwIfAborted();
  const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  options.onProcess?.(child);
  let stdout = '', stderr = '', oversized = false;
  const stop = () => {
    if (input) child.stdin.write(input + '\n', () => {});
    else child.kill();
  };
  options.signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, (options.timeoutSeconds + 10) * 1000);
  child.stdout.on('data', chunk => {
    stdout += String(chunk);
    if (stdout.length > 100000) { oversized = true; child.kill(); }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
  child.stdin.on('error', () => {});
  if (!input) child.stdin.end();
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (oversized) throw new BridgeError('WINDOWS_EXECUTOR_FAILED', 'Native controller output exceeded its limit');
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', stop);
  }
}

async function executablePath(executable: string): Promise<string> {
  const names = path.extname(executable) ? [executable] : [executable + '.exe'];
  const directories = path.isAbsolute(executable) ? [''] : (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) for (const name of names) {
    const candidate = path.resolve(directory, name);
    try { if ((await lstat(candidate)).isFile()) return await realpath(candidate); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw new BridgeError('WINDOWS_EXECUTABLE_NOT_FOUND', 'Test executable was not found: ' + executable);
}

async function stageExecutable(command: TestCommand, runtime: string, maxBytes: number) {
  const original = await executablePath(command.executable);
  if (path.extname(original).toLowerCase() !== '.exe') throw new BridgeError('WINDOWS_EXECUTABLE_UNSUPPORTED', 'The Windows executor currently requires a native .exe');
  const files = [original, ...(await readdir(path.dirname(original))).filter(name => /\.dll$/i.test(name)).map(name => path.join(path.dirname(original), name))];
  let bytes = 0;
  for (const file of files) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new BridgeError('UNSAFE_RUNTIME_PATH', 'Runtime files must be regular files');
    bytes += info.size;
    if (bytes > maxBytes) throw new BridgeError('ISOLATION_TOO_LARGE', 'Runtime exceeds the configured copy byte limit');
    const source = await open(file, 'r');
    try {
      const header = Buffer.alloc(2); const observed = await source.read(header, 0, 2, 0);
      if (observed.bytesRead !== 2 || header.toString('ascii') !== 'MZ') throw new BridgeError('WINDOWS_EXECUTABLE_UNSUPPORTED', 'Runtime executable or DLL has no Windows image header');
    } finally { await source.close(); }
    await copyFile(file, path.join(runtime, path.basename(file)));
  }
  return path.join(runtime, path.basename(original));
}

export async function executeWindowsTest(command: TestCommand, copyDirectory: string, options: WindowsExecutionOptions): Promise<WindowsExecution> {
    if (process.platform !== 'win32') throw new BridgeError('WINDOWS_EXECUTOR_UNAVAILABLE', 'Native Windows execution is only available on Windows');
    const executableName = path.basename(command.executable);
    if (/^(?:\\\\|\/\/)/.test(command.executable) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(executableName) ||
        command.executable.replace(/^[A-Za-z]:[\\/]/, '').includes(':') || command.executable.includes('\0') || command.args.some(arg => arg.includes('\0'))) {
      throw new BridgeError('INVALID_TEST_COMMAND', 'Windows commands cannot use remote paths, device paths, alternate streams or NUL characters');
    }
  const temp = await realpath(os.tmpdir()), cwd = await realpath(copyDirectory);
  if (path.dirname(cwd) !== temp || !path.basename(cwd).startsWith('agy-mcp-copy-') || (await lstat(copyDirectory)).isSymbolicLink()) {
    throw new BridgeError('UNSAFE_PROJECT_PATH', 'Windows tests require an owned project copy');
  }
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!(await lstat(compiler).catch(() => undefined))?.isFile()) throw new BridgeError('WINDOWS_EXECUTOR_UNAVAILABLE', 'The existing Windows .NET Framework compiler is unavailable');
  const controller = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-controller-')));
  const runtime = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-runtime-')));
  try {
    const source = path.join(controller, 'runner.cs'), helper = path.join(controller, 'runner.exe');
    await writeFile(source, windowsHelperSource, { flag: 'wx' });
    const built = await nativeProcess(compiler, ['/nologo', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll', '/nowarn:0649', '/out:' + helper, source], options);
    options.signal?.throwIfAborted();
    if (built.code !== 0) throw new BridgeError('WINDOWS_EXECUTOR_BUILD_FAILED', (built.stdout + built.stderr).slice(-4000));
    const executable = await stageExecutable(command, runtime, options.maxRuntimeBytes);
    const nonce = randomUUID(), systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const request = { nonce, cwd, runtime, executable, args: command.args, timeoutSeconds: options.timeoutSeconds,
      environment: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: runtime + path.delimiter + path.join(systemRoot, 'System32'),
        PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: cwd, TMP: cwd, USERPROFILE: cwd, HOME: cwd, APPDATA: cwd, LOCALAPPDATA: cwd,
        COMSPEC: path.join(systemRoot, 'System32', 'cmd.exe') } };
    const file = path.join(controller, 'request.json');
    await writeFile(file, JSON.stringify(request), { flag: 'wx' });
    const observed = await nativeProcess(helper, [file], options, 'cancel ' + nonce);
    const result = executionSchema.parse(JSON.parse(observed.stdout));
    if (result.nonce !== nonce || result.profileDeleted !== true) throw new BridgeError('WINDOWS_EXECUTION_UNVERIFIED', 'Controller nonce or profile cleanup was not verified');
    if (!result.error && (observed.code !== 0 || result.sandbox !== 'windows-lpac' || result.exitCode === null)) {
      throw new BridgeError('WINDOWS_EXECUTION_UNVERIFIED', 'No verified AppContainer execution result');
    }
    return result;
  } finally {
    for (const [directory, prefix] of [[controller, 'agy-mcp-controller-'], [runtime, 'agy-mcp-runtime-']] as const) {
      if (path.dirname(directory) !== temp || !path.basename(directory).startsWith(prefix) || (await lstat(directory)).isSymbolicLink()) throw new BridgeError('UNSAFE_RUNTIME_PATH', 'Controller cleanup path was replaced');
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}
