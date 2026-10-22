import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { BridgeError } from './types.js';

const stopping = new WeakSet<ChildProcess>();
const ownedProcessGroups = new WeakSet<ChildProcess>();

export function registerOwnedProcessGroup(child: ChildProcess): void {
  ownedProcessGroups.add(child);
}

export function isOwnedProcessGroup(child: ChildProcess): boolean {
  return ownedProcessGroups.has(child);
}

export function processError(error: unknown, operation: string): BridgeError {
  if (error instanceof BridgeError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return new BridgeError('AGY_NOT_FOUND', 'agy executable not found');
  if (code === 'EACCES' || code === 'EPERM') return new BridgeError('AGY_PERMISSION_DENIED', 'Permission denied executing agy');
  if (operation === 'stdin' || code === 'EPIPE' || code === 'EOF' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END') return new BridgeError('CLI_INPUT_FAILED', 'Failed writing input to agy');
  const message = error instanceof Error ? error.message : String(error);
  return new BridgeError('AGY_IO_FAILED', `agy ${operation} failed: ${message}`);
}

export interface TerminateOptions {
  ownedGroup?: boolean;
  escalationTimeoutMs?: number;
}

export function terminateSubprocess(child: ChildProcess, options?: TerminateOptions): void {
  const isOwned = options?.ownedGroup ?? ownedProcessGroups.has(child);
  if (stopping.has(child)) return;
  if ((child.exitCode != null || child.signalCode != null) && !isOwned) return;
  stopping.add(child);
  let closed = false;
  let killer: ChildProcess | undefined;

  const force = () => {
    if (!closed) {
      if (process.platform === 'win32') {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      } else if (child.pid) {
        if (isOwned) {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
        } else {
          try { child.kill('SIGKILL'); } catch { /* already exited */ }
        }
      } else {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }
    }
  };

  const timeoutMs = options?.escalationTimeoutMs ?? 3000;
  const timer = setTimeout(() => {
    force();
    if (killer && killer.exitCode === null && killer.signalCode === null) {
      try { killer.kill(); } catch { /* already exited */ }
    }
  }, timeoutMs);
  timer.unref();

  const cleanup = () => {
    closed = true;
    clearTimeout(timer);
  };
  child.once('close', cleanup);

  if (process.platform === 'win32') {
    if (child.pid) {
      try {
        const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        killer = spawn(executable, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.once('error', force);
        killer.once('close', code => { if (code !== 0) force(); });
      } catch { force(); }
    } else {
      force();
    }
  } else {
    if (child.pid) {
      if (isOwned) {
        try { process.kill(-child.pid, 'SIGTERM'); }
        catch { try { child.kill('SIGTERM'); } catch { force(); } }
      } else {
        try { child.kill('SIGTERM'); } catch { force(); }
      }
    } else {
      try { child.kill('SIGTERM'); } catch { force(); }
    }
  }
}

export interface RedactionState {
  inPrivateKey?: boolean;
}

export function redactDiagnostic(value: string | undefined | null, state?: RedactionState): string {
  if (!value) return '';
  let text = String(value);
  if (state) {
    // The last delimiter on the line decides whether the following lines are still inside a key.
    const delimiters = [...decodeJsonEscapes(text).matchAll(/-----(BEGIN|END) [^-]*PRIVATE KEY-----/g)];
    const insideBefore = state.inPrivateKey === true;
    if (delimiters.length) state.inPrivateKey = delimiters.at(-1)![1] === 'BEGIN';
    if (insideBefore || delimiters.some(match => match[1] === 'BEGIN')) return '[private key redacted]';
  }
  const redacted = redactText(text);
  // JSON escapes (for example inside message envelopes) can hide a credential from the patterns; the decoded form decides.
  const decoded = decodeJsonEscapes(text);
  if (decoded === text) return redacted;
  const decodedRedacted = redactText(decoded);
  return decodedRedacted === decoded ? redacted : decodedRedacted;
}

function decodeJsonEscapes(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/\\(["\\/])/g, '$1');
}

function redactText(value: string): string {
  let text = value;
  // An opening without its terminator hides the rest of the text, since the key body follows the header.
  // A terminator left without its opening (output truncated from the head) hides everything before it, since the body precedes it.
  text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[private key redacted]')
             .replace(/^[\s\S]*-----END [^-]*PRIVATE KEY-----/, '[private key redacted]');
  text = text.replace(/(:\/\/)(?:[^/\s:@]+:[^/\s:@]+|[^/\s@]+)@/g, '$1[redacted]@');
  for (const secret of environmentSecrets()) text = text.split(secret).join('[redacted]');
  return text.replace(new RegExp(TOKEN_PATTERN, 'g'), '[redacted]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]');
}

const TOKEN_PATTERN = /\b(?:AIza[0-9A-Za-z_-]{35}|(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z_]{36,255}|github_pat_[0-9A-Za-z_]{82}|[sr]k_live_[0-9A-Za-z]{24,})\b/.source;

// Multi-line values are also matched line by line, because streams are redacted one line at a time.
function environmentSecrets(): string[] {
  return Object.entries(process.env).flatMap(([name, secret]) =>
    secret && secret.length >= 8 && /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL/i.test(name)
      ? [secret, ...secret.split(/\r?\n/).filter(line => line !== secret && line.trim().length >= 8)] : [])
    .sort((left, right) => right.length - left.length);
}

// High-confidence formats only: URL userinfo and generic Bearer text stay redacted in diagnostics but do not reject caller input.
export function containsCredential(value: string): boolean {
  return [value, decodeJsonEscapes(value)].some(text => /-----BEGIN [^-]*PRIVATE KEY-----/.test(text) || new RegExp(TOKEN_PATTERN).test(text) ||
    environmentSecrets().some(secret => text.includes(secret)));
}
