import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { BridgeError } from './types.js';

const stopping = new WeakSet<ChildProcess>();

export function processError(error: unknown, operation: string): BridgeError {
  if (error instanceof BridgeError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return new BridgeError('AGY_NOT_FOUND', 'agy executable not found');
  if (code === 'EACCES' || code === 'EPERM') return new BridgeError('AGY_PERMISSION_DENIED', 'Permission denied executing agy');
  if (operation === 'stdin') return new BridgeError('CLI_INPUT_FAILED', 'Failed writing input to agy');
  return new BridgeError('AGY_IO_FAILED', 'agy ' + operation + ' failed');
}

export function terminateSubprocess(child: ChildProcess): void {
  if (stopping.has(child) || child.exitCode !== null || child.signalCode !== null) return;
  stopping.add(child);
  let closed = false;
  let killer: ChildProcess | undefined;
  const force = () => { if (!closed) { try { child.kill('SIGKILL'); } catch { /* already exited */ } } };
  const timer = setTimeout(() => { force(); if (killer && killer.exitCode === null && killer.signalCode === null) killer.kill(); }, 3000);
  timer.unref();
  child.once('close', () => { closed = true; clearTimeout(timer); });
  if (process.platform === 'win32' && child.pid) {
    try {
      const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      killer = spawn(executable, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.once('error', force);
      killer.once('close', code => { if (code !== 0) force(); });
    } catch { force(); }
  } else {
    try { child.kill('SIGTERM'); } catch { force(); }
  }
}

export function redactDiagnostic(value: string): string {
  let text = value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[private key redacted]');
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && secret.length >= 8 && /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL/i.test(name)) text = text.split(secret).join('[redacted]');
  }
  return text.replace(/\b(?:AIza[0-9A-Za-z_-]{35}|(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z_]{36,255}|github_pat_[0-9A-Za-z_]{82}|[sr]k_live_[0-9A-Za-z]{24,})\b/g, '[redacted]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]');
}
