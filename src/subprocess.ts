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
    if (state.inPrivateKey) {
      if (/-----END [^-]*PRIVATE KEY-----/.test(text)) {
        state.inPrivateKey = false;
      }
      return '[private key redacted]';
    }
    if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(text)) {
      if (/-----END [^-]*PRIVATE KEY-----/.test(text)) {
        state.inPrivateKey = false;
      } else {
        state.inPrivateKey = true;
      }
      return '[private key redacted]';
    }
  }
  text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[private key redacted]')
             .replace(/-----(?:BEGIN|END) [^-]*PRIVATE KEY-----/g, '[private key redacted]');
  text = text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(?:[^/\s:@]+:[^/\s:@]+|[^/\s@]+)@/g, '$1[redacted]@');
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && secret.length >= 8 && /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL/i.test(name)) text = text.split(secret).join('[redacted]');
  }
  return text.replace(/\b(?:AIza[0-9A-Za-z_-]{35}|(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z_]{36,255}|github_pat_[0-9A-Za-z_]{82}|[sr]k_live_[0-9A-Za-z]{24,})\b/g, '[redacted]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]');
}
