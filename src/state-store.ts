import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { BridgeError, type RunOptions, type TaskRecord } from './types.js';
import type { ProjectCopy } from './isolation.js';
import type { BridgeEvent } from './types.js';

const uuid = /^[a-f0-9-]{36}$/;
const snapshotSchema = z.object({
  version: z.literal(1), ownerPid: z.number().int().positive(),
  record: z.object({ taskId: z.string().uuid(), workingDirectory: z.string(), prompt: z.string(),
    status: z.enum(['queued', 'starting', 'running', 'streaming', 'completed', 'failed', 'cancelled', 'timeout']),
    createdAt: z.string().datetime(), completedAt: z.string().datetime().optional(), pid: z.number().int().positive().optional(),
    mode: z.enum(['write', 'read-only']).optional(), integratedAt: z.string().datetime().optional(), discardedAt: z.string().datetime().optional(),
  }).passthrough(),
  options: z.object({ prompt: z.string(), workingDirectory: z.string() }).passthrough(),
  project: z.object({ sourceDirectory: z.string(), copyDirectory: z.string(), gitDirectory: z.string(),
    baseline: z.array(z.tuple([z.string(), z.string().regex(/^[a-f0-9]{64}$/)])), includedFiles: z.array(z.string()),
  }).optional(),
  events: z.array(z.object({ taskId: z.string().uuid(), sequence: z.number().int().positive(), timestamp: z.string(), type: z.string(), data: z.unknown(), raw: z.unknown().optional() })),
  cursor: z.number().int().nonnegative(),
});

export interface StoredTask {
  record: TaskRecord;
  options: RunOptions;
  project?: ProjectCopy;
  ownerPid: number;
  events: BridgeEvent[];
  cursor: number;
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export class StateStore {
  constructor(private readonly directory: string) {
    if (!path.isAbsolute(directory)) throw new BridgeError('INVALID_STATE_DIRECTORY', 'BRIDGE_STATE_DIRECTORY must be absolute');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new BridgeError('INVALID_STATE_DIRECTORY', 'State directory cannot be a link');
  }

  private file(taskId: string): string {
    if (!uuid.test(taskId)) throw new BridgeError('INVALID_STATE', 'Invalid persisted task ID');
    return path.join(this.directory, taskId + '.json');
  }

  save(task: StoredTask): void {
    const target = this.file(task.record.taskId);
    const temporary = target + '.' + randomUUID() + '.tmp';
    const snapshot = { ...task, version: 1, project: task.project && { ...task.project, baseline: [...task.project.baseline] } };
    try {
      writeFileSync(temporary, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temporary, target);
    } finally { rmSync(temporary, { force: true }); }
  }

  load(): StoredTask[] {
    return readdirSync(this.directory).filter(name => uuid.test(name.slice(0, -5)) && name.endsWith('.json')).map(name => {
      const file = path.join(this.directory, name);
      if (lstatSync(file).isSymbolicLink() || lstatSync(file).size > 70_000_000) throw new BridgeError('INVALID_STATE', 'Unsafe persisted task file');
      let data;
      try { data = snapshotSchema.parse(JSON.parse(readFileSync(file, 'utf8'))); }
      catch { throw new BridgeError('INVALID_STATE', 'Invalid persisted task: ' + name); }
      if (data.record.taskId + '.json' !== name || !path.isAbsolute(data.record.workingDirectory) ||
          data.options.workingDirectory !== data.record.workingDirectory || data.options.prompt !== data.record.prompt ||
          data.events.some(event => event.taskId !== data.record.taskId || event.sequence > data.cursor)) {
        throw new BridgeError('INVALID_STATE', 'Persisted task does not match its identity');
      }
      if (data.project) {
        for (const [directory, prefix] of [[data.project.copyDirectory, 'agy-mcp-copy-'], [data.project.gitDirectory, 'agy-mcp-baseline-']]) {
          if (!path.isAbsolute(directory!) || path.relative(os.tmpdir(), path.dirname(directory!)) !== '' || !path.basename(directory!).startsWith(prefix!)) {
            throw new BridgeError('INVALID_STATE', 'Persisted copy is outside bridge temporary storage');
          }
        }
        if (data.project.sourceDirectory !== data.record.workingDirectory) throw new BridgeError('INVALID_STATE', 'Persisted source differs from task');
      }
      return { ...data, record: data.record as unknown as TaskRecord, options: data.options as RunOptions,
        project: data.project && { ...data.project, baseline: new Map(data.project.baseline) } };
    }).sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));
  }

  drop(taskId: string): void { rmSync(this.file(taskId), { force: true }); }

  acquire(name: string): () => void {
    if (!/^[a-zA-Z0-9-]+$/.test(name)) throw new BridgeError('INVALID_STATE', 'Invalid lock name');
    const file = path.join(this.directory, name + '.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
        return () => rmSync(file, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let pid;
        try { pid = JSON.parse(readFileSync(file, 'utf8')).pid as unknown; } catch { /* an incomplete lock remains protected */ }
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1 || processAlive(pid)) {
          throw new BridgeError('STATE_BUSY', 'Another bridge operation owns this task or copy');
        }
        rmSync(file);
      }
    }
    throw new BridgeError('STATE_BUSY', 'Could not acquire bridge state lock');
  }
}
