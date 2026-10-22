import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export interface ObservedProcess {
  pid: number;
  parentPid: number;
  createdAt: number;
}

export interface ProcessCleanup {
  verified: boolean;
  method: 'process-group' | 'windows-snapshot';
  remaining: ObservedProcess[];
}

export async function listWindowsProcesses(): Promise<ObservedProcess[]> {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())" } }';

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error('Process listing timed out after 15s'));
    }, 15000);
    timer.unref();

    function fail(err: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      reject(err);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_STDOUT_BYTES) {
          fail(new Error('Process listing stdout exceeded 16 MiB'));
          return;
        }
        chunks.push(chunk);
      });
    }

    if (child.stderr) {
      child.stderr.resume();
    }

    child.on('error', (err) => {
      fail(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`Process listing exited with code ${code}`));
        return;
      }
      const output = Buffer.concat(chunks).toString('utf8');
      const lines = output.split(/\r?\n/);
      const processes: ObservedProcess[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 3) continue;
        const pid = Number(parts[0]);
        const parentPid = Number(parts[1]);
        const ftStr = parts[2];
        if (!Number.isInteger(pid) || pid < 0 || !Number.isInteger(parentPid) || parentPid < 0) {
          continue;
        }
        if (!ftStr || !/^\d+$/.test(ftStr)) {
          continue;
        }
        try {
          const ft = BigInt(ftStr);
          const createdAt = Number(ft / 10000n) - 11644473600000;
          if (!Number.isFinite(createdAt)) continue;
          processes.push({ pid, parentPid, createdAt });
        } catch {
          continue;
        }
      }
      resolve(processes);
    });
  });
}

export function ownedProcesses(
  processes: readonly ObservedProcess[],
  rootPid: number,
  spawnedAt: number
): ObservedProcess[] {
  const root = processes.find(p => p.pid === rootPid && p.createdAt >= spawnedAt - 2000);
  const result: ObservedProcess[] = [];
  const visited = new Set<number>();
  const queue: Array<{ pid: number; createdAt: number }> = [];

  if (root) {
    result.push(root);
    visited.add(root.pid);
    queue.push({ pid: root.pid, createdAt: root.createdAt });
  } else {
    visited.add(rootPid);
    queue.push({ pid: rootPid, createdAt: spawnedAt - 2000 });
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    if (!current) break;
    for (const p of processes) {
      if (p.parentPid === current.pid && p.createdAt >= current.createdAt && !visited.has(p.pid)) {
        visited.add(p.pid);
        result.push(p);
        queue.push({ pid: p.pid, createdAt: p.createdAt });
      }
    }
  }

  return result;
}

// Kept referenced: callers await verification during shutdown, when nothing else holds the event loop open.
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function killProcess(pid: number): Promise<void> {
  return new Promise(resolve => {
    try {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
      const child = spawn(taskkill, ['/PID', String(pid), '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
      });
      child.once('error', () => resolve());
      child.once('close', () => resolve());
    } catch {
      resolve();
    }
  });
}

function isProcessAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

export async function reconcileOwnedProcesses(
  root: { pid?: number; spawnedAt: number; processGroup: boolean },
  options?: { graceMs?: number; list?: () => Promise<ObservedProcess[]> }
): Promise<ProcessCleanup> {
  const graceMs = options?.graceMs ?? 3000;

  if (process.platform === 'win32') {
    if (typeof root.pid !== 'number' || root.pid <= 0) {
      return { verified: false, method: 'windows-snapshot', remaining: [] };
    }

    const list = options?.list ?? listWindowsProcesses;
    let targets: ObservedProcess[];
    try {
      const snapshot = await list();
      targets = ownedProcesses(snapshot, root.pid, root.spawnedAt);
    } catch {
      return { verified: false, method: 'windows-snapshot', remaining: [] };
    }

    if (targets.length === 0) {
      return { verified: true, method: 'windows-snapshot', remaining: [] };
    }

    for (const target of targets) {
      await killProcess(target.pid);
    }

    const deadline = Date.now() + graceMs;
    let remaining = targets;

    do {
      if (graceMs > 0) {
        const waitMs = Math.min(250, Math.max(1, deadline - Date.now()));
        await sleep(waitMs);
      }
      let currentList: ObservedProcess[];
      try {
        currentList = await list();
      } catch {
        return { verified: false, method: 'windows-snapshot', remaining };
      }
      remaining = targets.filter(target =>
        currentList.some(p => p.pid === target.pid && Math.abs(p.createdAt - target.createdAt) <= 1)
      );
      if (remaining.length === 0) {
        return { verified: true, method: 'windows-snapshot', remaining: [] };
      }
    } while (Date.now() < deadline);

    return { verified: false, method: 'windows-snapshot', remaining };
  }

  // POSIX
  if (typeof root.pid !== 'number' || root.pid <= 0) {
    return { verified: false, method: 'process-group', remaining: [] };
  }

  const target = root.processGroup ? -root.pid : root.pid;

  if (!isProcessAlive(target)) {
    return { verified: true, method: 'process-group', remaining: [] };
  }

  try {
    process.kill(target, 'SIGKILL');
  } catch {
    // Process already terminated
  }

  const deadline = Date.now() + graceMs;
  do {
    if (graceMs > 0) {
      const waitMs = Math.min(100, Math.max(1, deadline - Date.now()));
      await sleep(waitMs);
    }
    if (!isProcessAlive(target)) {
      return { verified: true, method: 'process-group', remaining: [] };
    }
  } while (Date.now() < deadline);

  return { verified: !isProcessAlive(target), method: 'process-group', remaining: [] };
}
