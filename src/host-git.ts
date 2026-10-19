import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat, realpath } from 'node:fs/promises';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { BridgeError } from './types.js';
import { terminateSubprocess, redactDiagnostic } from './subprocess.js';

export interface HostGitOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
  excludedRoots?: readonly string[];
  shutdownGraceMs?: number;
  maxOutputBytes?: number;
  onStdoutChunk?: (chunk: Buffer) => void;
}

const MAX_GIT_OUTPUT = 10_000_000;
const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 3250;
// Git for Windows accepts NUL, but rejects the Win32 device spelling from os.devNull.
const GIT_NULL_FILE = process.platform === 'win32' ? 'NUL' : os.devNull;
const MAX_STDERR_LENGTH = 4000;
const TRUNCATION_MARKER = '... [diagnostic truncated]';

function isInsideOrEqual(parent: string, target: string, isWindows: boolean): boolean {
  const normParent = isWindows ? path.resolve(parent).toLowerCase() : path.resolve(parent);
  const normTarget = isWindows ? path.resolve(target).toLowerCase() : path.resolve(target);

  if (normParent === normTarget) return true;

  const rel = path.relative(normParent, normTarget);
  if (rel === '') return true;
  if (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) return true;

  return false;
}

export async function buildSafeGitPath(
  cwd: string,
  rawPath?: string,
  excludedRoots: readonly string[] = []
): Promise<string> {
  const isWindows = process.platform === 'win32';
  let canonicalCwd: string | undefined;
  try {
    canonicalCwd = await realpath(cwd);
  } catch {
    try {
      canonicalCwd = path.resolve(cwd);
    } catch {
      canonicalCwd = undefined;
    }
  }

  const allExcluded: string[] = [path.resolve(cwd)];
  if (canonicalCwd) allExcluded.push(canonicalCwd);
  for (const root of excludedRoots) {
    allExcluded.push(path.resolve(root));
    try {
      allExcluded.push(await realpath(root));
    } catch {
      // ignore
    }
  }

  const pathStr = rawPath ?? process.env.PATH ?? '';
  const entries = pathStr.split(path.delimiter);
  const safeEntries: string[] = [];

  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    if (!path.isAbsolute(entry)) continue;

    // Reject entries inside or equal to cwd or excluded roots by lexical identity
    if (allExcluded.some(root => isInsideOrEqual(root, entry, isWindows))) {
      continue;
    }

    // Reject entries inside or equal to cwd or excluded roots by canonical identity
    let canonicalEntry: string | undefined;
    try {
      canonicalEntry = await realpath(entry);
    } catch {
      // ignore
    }
    if (canonicalEntry && allExcluded.some(root => isInsideOrEqual(root, canonicalEntry, isWindows))) {
      continue;
    }

    safeEntries.push(entry);
  }

  return safeEntries.join(path.delimiter);
}

export async function resolveGitExecutable(
  cwd: string,
  pathEnv?: string,
  excludedRoots: readonly string[] = []
): Promise<string> {
  const safePath = await buildSafeGitPath(cwd, pathEnv, excludedRoots);
  const isWindows = process.platform === 'win32';
  const executableName = isWindows ? 'git.exe' : 'git';

  let canonicalCwd: string | undefined;
  try {
    canonicalCwd = await realpath(cwd);
  } catch {
    try {
      canonicalCwd = path.resolve(cwd);
    } catch {
      canonicalCwd = undefined;
    }
  }

  const allExcluded = [
    path.resolve(cwd),
    ...(canonicalCwd ? [canonicalCwd] : []),
    ...await Promise.all(excludedRoots.flatMap(root => [Promise.resolve(path.resolve(root)), realpath(root).catch(() => path.resolve(root))]))
  ];

  const entries = safePath.split(path.delimiter);

  for (const entry of entries) {
    if (!entry) continue;
    const candidate = path.join(entry, executableName);

    let stats;
    try {
      stats = await stat(candidate);
    } catch {
      continue;
    }

    if (!stats.isFile()) continue;

    if (!isWindows) {
      if ((stats.mode & 0o111) === 0) continue;
    }

    if (allExcluded.some(root => isInsideOrEqual(root, candidate, isWindows))) {
      continue;
    }

    let realCandidate: string;
    try {
      realCandidate = await realpath(candidate);
    } catch {
      continue;
    }

    if (allExcluded.some(root => isInsideOrEqual(root, realCandidate, isWindows))) {
      continue;
    }

    return candidate;
  }

  throw new BridgeError('GIT_OPERATION_FAILED', 'Git executable not found in PATH');
}

export function buildHostGitEnv(
  source: NodeJS.ProcessEnv = process.env,
  allowGlobalConfig = false,
  safePath?: string
): NodeJS.ProcessEnv {
  const isWindows = process.platform === 'win32';
  const env: NodeJS.ProcessEnv = {};

  const allowedUpper = new Set([
    'PATH',
    'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'WINDIR', 'OS',
    'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'NUMBER_OF_PROCESSORS',
    'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
    'PATHEXT',
    'SHELL', 'TERM', 'COLORTERM',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USER', 'LOGNAME', 'USERNAME',
    'TEMP', 'TMP', 'TMPDIR',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_DIRS', 'XDG_DATA_DIRS',
  ]);

  for (const [key, value] of Object.entries(source)) {
    if (key === '__proto__' || typeof value !== 'string') continue;
    const upper = key.toUpperCase();

    if (upper === 'PATH') continue;
    if (upper.startsWith('NODE_') || upper.startsWith('LD_') || upper.startsWith('DYLD_')) continue;
    if (upper === 'GIT_EXEC_PATH' || upper.startsWith('GIT_CONFIG_') || upper === 'GIT_CONFIG_PARAMETERS') continue;
    if (upper === 'GIT_DIR' || upper === 'GIT_WORK_TREE' || upper === 'GIT_INDEX_FILE') continue;
    if (upper === 'GIT_OBJECT_DIRECTORY' || upper === 'GIT_ALTERNATE_OBJECT_DIRECTORIES') continue;
    if (upper === 'GIT_SSH' || upper === 'GIT_SSH_COMMAND' || upper === 'GIT_ASKPASS' || upper === 'SSH_ASKPASS') continue;
    if (upper.startsWith('SSH_')) continue;
    if (upper.includes('TOKEN') || upper.includes('SECRET') || upper.includes('PASSWORD') || upper.includes('PASSWD') || upper.includes('API_KEY') || upper.includes('CREDENTIAL')) continue;
    if (upper.includes('PROXY')) continue;

    if (allowedUpper.has(upper)) {
      env[key] = value;
    }
  }

  if (safePath !== undefined) {
    env.PATH = safePath;
  } else {
    const rawPath = source.PATH ?? (isWindows ? Object.entries(source).find(([k]) => k.toUpperCase() === 'PATH')?.[1] : undefined);
    if (typeof rawPath === 'string') {
      env.PATH = rawPath.split(path.delimiter).map(e => e.trim()).filter(e => e && path.isAbsolute(e)).join(path.delimiter);
    }
  }

  const refFormat = source.GIT_DEFAULT_REF_FORMAT;
  if (refFormat === 'reftable' || refFormat === 'files') {
    env.GIT_DEFAULT_REF_FORMAT = refFormat;
  }

  env.GIT_TERMINAL_PROMPT = '0';

  if (!allowGlobalConfig) {
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = GIT_NULL_FILE;
  }

  if (isWindows && !env.PATHEXT) {
    env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  }

  return env;
}

async function spawnGit(
  gitBinary: string,
  cwd: string,
  args: string[],
  childEnv: NodeJS.ProcessEnv,
  input?: Buffer,
  allowedCodes: number[] = [0],
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  spawnFn: typeof spawn = spawn,
  shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
  maxOutputBytes = MAX_GIT_OUTPUT,
  onStdoutChunk?: (chunk: Buffer) => void
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let childProc: ChildProcessWithoutNullStreams;
    try {
      childProc = spawnFn(gitBinary, args, {
        cwd,
        windowsHide: true,
        stdio: 'pipe',
        env: childEnv,
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      reject(new BridgeError('GIT_OPERATION_FAILED', redactDiagnostic((err as Error).message)));
      return;
    }
    const child: ChildProcessWithoutNullStreams = childProc;

    let settled = false;
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      clearTimeout(timer);
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateSubprocess(child);
      reject(error);
    };

    const settleResolve = (result: Buffer) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const requestTermination = () => {
      terminateSubprocess(child);
      if (!graceTimer && !settled) {
        graceTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          try { child.stdin.destroy(); } catch { /* ignore */ }
          try { child.stdout.destroy(); } catch { /* ignore */ }
          try { child.stderr.destroy(); } catch { /* ignore */ }
          reject(new BridgeError('GIT_CLEANUP_UNVERIFIED', 'Git process termination grace expired while streams remained open'));
        }, shutdownGraceMs);
        graceTimer.unref();
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, timeoutMs);
    timer.unref();

    let ioError: Error | null = null;
    const recordIoError = (error: Error) => {
      if (!ioError) ioError = error;
      requestTermination();
    };

    const chunks: Buffer[] = [];
    let length = 0;
    let stderr = '';
    let stderrTruncated = false;
    const stderrDecoder = new StringDecoder('utf8');
    let overflow = false;
    let sinkError: Error | null = null;

    child.stdout.on('data', (chunk: Buffer) => {
      if (overflow || sinkError) return;
      length += chunk.length;
      if (length > maxOutputBytes) {
        overflow = true;
        requestTermination();
      } else if (onStdoutChunk) {
        try {
          const result: unknown = onStdoutChunk(chunk);
          if (result !== undefined && result !== null && (typeof (result as { then?: unknown }).then === 'function' || result instanceof Promise)) {
            Promise.resolve(result).catch(() => {});
            sinkError = new BridgeError('GIT_OPERATION_FAILED', 'Invalid onStdoutChunk: asynchronous sink is not supported');
            requestTermination();
          }
        } catch (err) {
          sinkError = err instanceof Error ? err : new Error(String(err));
          requestTermination();
        }
      } else {
        chunks.push(chunk);
      }
    });

    const appendStderr = (text: string) => {
      if (stderrTruncated) return;
      if (stderr.length + text.length > MAX_STDERR_LENGTH) {
        stderrTruncated = true;
        // A partial credential at the cutoff cannot be redacted reliably.
        stderr = TRUNCATION_MARKER;
      } else {
        stderr += text;
      }
    };
    child.stderr.on('data', (chunk: Buffer) => appendStderr(stderrDecoder.write(chunk)));

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

    child.once('close', (code, signal) => {
      if (settled) return;
      cleanup();
      appendStderr(stderrDecoder.end());
      if (overflow) {
        settleReject(new BridgeError('ISOLATION_TOO_LARGE', 'Git output exceeds the isolation limit'));
      } else if (timedOut) {
        settleReject(new BridgeError('GIT_OPERATION_FAILED', `Git operation timed out after ${timeoutMs}ms`));
      } else if (sinkError) {
        settleReject(sinkError instanceof BridgeError ? sinkError : new BridgeError('GIT_OPERATION_FAILED', redactDiagnostic(sinkError.message || 'Git output sink error')));
      } else if (ioError) {
        settleReject(new BridgeError('GIT_OPERATION_FAILED', redactDiagnostic(ioError.message || 'Git stream communication error')));
      } else if (!allowedCodes.includes(code ?? -1)) {
        const diag = stderr.trim() || (signal ? 'git terminated with signal ' + signal : 'git exited with code ' + code);
        settleReject(new BridgeError('GIT_OPERATION_FAILED', redactDiagnostic(diag, {})));
      } else {
        settleResolve(onStdoutChunk ? Buffer.alloc(0) : Buffer.concat(chunks));
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

interface CachedAdmission {
  gitBinary: string;
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
}

let cachedAdmission: CachedAdmission | null = null;

export function _resetGitAdmissionCache(): void {
  cachedAdmission = null;
}

export async function ensureGitVersionAdmission(
  gitBinary: string,
  spawnFn: typeof spawn = spawn,
  envSource: NodeJS.ProcessEnv = process.env,
  safePath?: string
): Promise<void> {
  let stats;
  try {
    stats = await stat(gitBinary);
  } catch {
    // Stat failed, proceed without cache
  }

  if (
    spawnFn === spawn &&
    cachedAdmission &&
    stats &&
    cachedAdmission.gitBinary === gitBinary &&
    cachedAdmission.size === stats.size &&
    cachedAdmission.mtimeMs === stats.mtimeMs &&
    cachedAdmission.ino === stats.ino && cachedAdmission.dev === stats.dev
  ) {
    return;
  }

  const checkEnv = buildHostGitEnv(envSource, false, safePath);
  let output: Buffer;
  try {
    output = await spawnGit(
      gitBinary,
      os.tmpdir(),
      ['--version'],
      checkEnv,
      undefined,
      [0],
      10_000,
      spawnFn
    );
  } catch (err) {
    if (err instanceof BridgeError && err.code === 'GIT_CLEANUP_UNVERIFIED') {
      throw err;
    }
    throw new BridgeError('GIT_OPERATION_FAILED', 'Failed to query Git version: ' + redactDiagnostic((err as Error).message));
  }

  const versionText = output.toString('utf8').trim();
  const match = /git\s+version\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(versionText);
  if (!match) {
    throw new BridgeError('GIT_OPERATION_FAILED', `Unable to parse Git version from: ${redactDiagnostic(versionText)}`);
  }

  const major = parseInt(match[1]!, 10);
  const minor = parseInt(match[2]!, 10);

  if (major < 2 || (major === 2 && minor < 32)) {
    throw new BridgeError(
      'GIT_OPERATION_FAILED',
      `Git 2.32.0 or newer is required (found ${versionText}). Older Git versions do not support GIT_CONFIG_GLOBAL for global configuration isolation.`
    );
  }

  if (spawnFn === spawn && stats) {
    cachedAdmission = {
      gitBinary,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ino: stats.ino, dev: stats.dev,
    };
  }
}

function isProtectedConfigKey(rawKey: string): boolean {
  const norm = rawKey.trim().toLowerCase();
  return norm === 'core.fsmonitor' || norm === 'core.hookspath';
}

async function resolveEffectiveExcludesFile(
  cwd: string,
  gitBinary: string,
  envSource: NodeJS.ProcessEnv,
  timeoutMs: number,
  scope: string[],
  spawnFn?: typeof spawn,
  safePath?: string
): Promise<string | undefined> {
  try { await realpath(cwd); }
  catch { return undefined; }

  // Safe bounded config lookup with filtered env, no hooks, no fsmonitor
  const configEnv = buildHostGitEnv(envSource, true, safePath);
  const lookupArgs = [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=' + GIT_NULL_FILE,
    ...scope,
    'config', '--null', '--path', '--get', 'core.excludesfile',
  ];

  let lookupOutput: Buffer | undefined;
  try {
    lookupOutput = await spawnGit(
      gitBinary,
      cwd,
      lookupArgs,
      configEnv,
      undefined,
      [0, 1],
      Math.min(timeoutMs, 10_000),
      spawnFn
    );
  } catch (err) {
    if (err instanceof BridgeError && err.code === 'GIT_CLEANUP_UNVERIFIED') {
      throw err;
    }
    throw new BridgeError('GIT_OPERATION_FAILED', 'Failed to resolve Git configuration: ' + redactDiagnostic((err as Error).message));
  }

  // No configured value: Git still applies its standard XDG/HOME ignore file.
  if (!lookupOutput?.length) return undefined;
  if (lookupOutput[lookupOutput.length - 1] !== 0) {
    throw new BridgeError('GIT_OPERATION_FAILED', 'Invalid core.excludesFile configuration response');
  }
  const value = lookupOutput.subarray(0, -1).toString('utf8');
  // An explicitly empty setting disables the default ignore file.
  return value ? path.resolve(cwd, value) : GIT_NULL_FILE;
}

export async function git(
  cwd: string,
  args: string[],
  input?: Buffer,
  allowedCodes: number[] = [0],
  options?: HostGitOptions
): Promise<Buffer> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new BridgeError('GIT_OPERATION_FAILED', 'Invalid timeoutMs: must be a finite positive number');
  }
  const maxOutputBytes = options?.maxOutputBytes ?? MAX_GIT_OUTPUT;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new BridgeError('GIT_OPERATION_FAILED', 'Invalid maxOutputBytes: must be a positive safe integer');
  }
  if (options?.onStdoutChunk !== undefined && typeof options.onStdoutChunk !== 'function') {
    throw new BridgeError('GIT_OPERATION_FAILED', 'Invalid onStdoutChunk: must be a synchronous function');
  }

  const envSource = options?.env ?? process.env;
  const safePath = await buildSafeGitPath(cwd, envSource.PATH, options?.excludedRoots);
  const gitBinary = await resolveGitExecutable(cwd, safePath, options?.excludedRoots);
  const spawnFn = options?.spawnImpl ?? spawn;

  let command: string | undefined;
  const scope: string[] = [];
  const callerGlobalArgs: string[] = [];
  let restArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--') {
      restArgs = args.slice(i);
      break;
    }

    if (arg === '-c' || arg === '--config-env') {
      const value = args[i + 1];
      if (value === undefined) {
        callerGlobalArgs.push(arg);
        continue;
      }
      i++;
      if (!isProtectedConfigKey(value.split('=')[0]!)) {
        callerGlobalArgs.push(arg, value);
      }
      continue;
    }

    if (arg.startsWith('-c') && arg !== '-c') {
      if (!isProtectedConfigKey(arg.slice(2).split('=')[0]!)) {
        callerGlobalArgs.push(arg);
      }
      continue;
    }

    if (arg.startsWith('--config-env=')) {
      if (!isProtectedConfigKey(arg.slice('--config-env='.length).split('=')[0]!)) {
        callerGlobalArgs.push(arg);
      }
      continue;
    }

    if (['-C', '--git-dir', '--work-tree', '--namespace'].includes(arg)) {
      const value = args[i + 1];
      if (value !== undefined) {
        i++;
        callerGlobalArgs.push(arg, value);
        if (arg === '--git-dir' || arg === '--work-tree') {
          scope.push(arg, value);
        }
      } else {
        callerGlobalArgs.push(arg);
      }
      continue;
    }

    if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
      callerGlobalArgs.push(arg);
      scope.push(arg);
      continue;
    }

    if (arg.startsWith('-')) {
      callerGlobalArgs.push(arg);
      continue;
    }

    command = arg;
    restArgs = args.slice(i);
    break;
  }

  if (command !== 'version' && args[0] !== '--version') {
    await ensureGitVersionAdmission(gitBinary, spawnFn, envSource, safePath);
  }

  const skipLookup = ['config', 'version', 'init', 'clone'].includes(command ?? '') || args[0] === '--version';

  let effectiveExcludes: string | undefined;
  if (!skipLookup) {
    effectiveExcludes = await resolveEffectiveExcludesFile(cwd, gitBinary, envSource, timeoutMs, scope, spawnFn, safePath);
  }

  const safeArgs: string[] = [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=' + GIT_NULL_FILE,
  ];
  if (effectiveExcludes) {
    safeArgs.push('-c', 'core.excludesFile=' + effectiveExcludes);
  }

  safeArgs.push(...callerGlobalArgs, ...restArgs);

  const childEnv = buildHostGitEnv(envSource, false, safePath);

  return spawnGit(
    gitBinary,
    cwd,
    safeArgs,
    childEnv,
    input,
    allowedCodes,
    timeoutMs,
    spawnFn,
    options?.shutdownGraceMs,
    maxOutputBytes,
    options?.onStdoutChunk
  );
}
