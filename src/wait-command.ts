import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { stateDirectoryFrom } from './config.js';
import { processAlive } from './state-store.js';

export const WAIT_EXIT_CODES = {
  completed: 0,
  error: 1,
  failed: 2,
  cancelled: 3,
  timeout: 4,
  question: 5,
  blocker: 6,
  'unknown-task': 7,
  'wait-deadline': 8,
  'owner-stopped': 9,
} as const;

export type WaitOutcome = keyof typeof WAIT_EXIT_CODES;
export const DEFAULT_WAIT_TIMEOUT_SECONDS = 1800;
export const MAX_WAIT_TIMEOUT_SECONDS = 86400;
export const WAIT_POLL_INTERVAL_MS = 500;

const taskIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decimalPattern = /^[0-9]+$/;
const errorCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/;

const waitSnapshotSchema = z.object({
  version: z.literal(1),
  ownerPid: z.number().int().positive(),
  record: z.object({
    taskId: z.string(),
    status: z.enum(['queued', 'starting', 'running', 'streaming', 'completed', 'failed', 'cancelled', 'timeout']),
    error: z.object({ code: z.string() }).passthrough().optional(),
    messageCursor: z.number().int().nonnegative().optional(),
    messages: z.array(z.object({
      sequence: z.number().int().positive(),
      kind: z.enum(['message', 'question', 'blocker', 'final', 'error']),
    }).passthrough()).optional(),
    continuationTaskId: z.string().uuid().optional(),
  }).passthrough(),
}).passthrough();

type WaitSnapshot = z.infer<typeof waitSnapshotSchema>;

export interface WaitCommandInfo {
  argv: string[];
  sh: string;
}

export function waitCommandArgv(stateDirectory: string, entry: string | undefined = process.argv[1], node: string = process.execPath): string[] | undefined {
  if (!entry) return undefined;
  return [node, path.resolve(entry), 'wait', '--state-directory', stateDirectory];
}

export function shellCommand(argv: readonly string[]): string {
  return argv.map(arg => `'${arg.split("'").join("'\\''")}'`).join(' ');
}

export function waitCommandInfo(prefix: readonly string[], taskId?: string): WaitCommandInfo {
  const argv = taskId !== undefined ? [...prefix, taskId] : [...prefix];
  return { argv, sh: shellCommand(argv) };
}

export async function runWaitCommand(args: readonly string[], env: NodeJS.ProcessEnv, write: (line: string) => void, options: { pollIntervalMs?: number } = {}): Promise<number> {
  let taskId: string | null = null;
  let after = 0;
  let timeout = DEFAULT_WAIT_TIMEOUT_SECONDS;
  let stateDirectoryArg: string | undefined;
  let seenPositional = false;
  let seenAfter = false;
  let seenTimeout = false;
  let seenStateDirectory = false;
  let invalidArgs = false;
  let snapshot: WaitSnapshot | undefined;

  const finish = (outcome: WaitOutcome, reason: string | null, cursorOverride?: number): number => {
    const exitCode = WAIT_EXIT_CODES[outcome];
    const record = snapshot?.record;
    write(JSON.stringify({
      taskId,
      outcome,
      exitCode,
      status: record?.status ?? null,
      reason,
      after,
      cursor: cursorOverride ?? (record ? (record.messageCursor ?? 0) : null),
      ...(record?.continuationTaskId ? { continuationTaskId: record.continuationTaskId } : {}),
    }));
    return exitCode;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--after') {
      const value = args[++i];
      const parsed = value !== undefined && decimalPattern.test(value) ? Number(value) : NaN;
      if (seenAfter || value === undefined || !Number.isSafeInteger(parsed) || parsed < 0) invalidArgs = true;
      else after = parsed;
      seenAfter = true;
    } else if (arg === '--timeout') {
      const value = args[++i];
      const parsed = value !== undefined && decimalPattern.test(value) ? Number(value) : NaN;
      if (seenTimeout || value === undefined || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_WAIT_TIMEOUT_SECONDS) invalidArgs = true;
      else timeout = parsed;
      seenTimeout = true;
    } else if (arg === '--state-directory') {
      const value = args[++i];
      if (seenStateDirectory || value === undefined) invalidArgs = true;
      else stateDirectoryArg = value;
      seenStateDirectory = true;
    } else if (arg.startsWith('-') || seenPositional) {
      invalidArgs = true;
    } else {
      seenPositional = true;
      const lower = arg.toLowerCase();
      if (taskIdPattern.test(lower)) taskId = lower;
      else invalidArgs = true;
    }
  }

  if (invalidArgs || taskId === null) return finish('error', 'INVALID_ARGUMENTS');
  const stateDirectory = stateDirectoryArg ?? stateDirectoryFrom(env);
  if (!path.isAbsolute(stateDirectory) || stateDirectory.includes('\0')) {
    return finish('error', 'INVALID_STATE_DIRECTORY');
  }

  const deadline = Date.now() + timeout * 1000;
  const interval = Math.max(1, options.pollIntervalMs ?? WAIT_POLL_INTERVAL_MS);
  const file = path.join(stateDirectory, `${taskId}.json`);
  let lastKey: string | undefined;
  let failures = 0;

  for (;;) {
    let dirStat;
    try {
      dirStat = lstatSync(stateDirectory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return finish('unknown-task', 'TASK_NOT_FOUND');
      return finish('error', 'INVALID_STATE_DIRECTORY');
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      return finish('error', 'INVALID_STATE_DIRECTORY');
    }

    let stat;
    try {
      stat = lstatSync(file, { bigint: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return finish('unknown-task', 'TASK_NOT_FOUND');
      return finish('error', 'INVALID_STATE');
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 70_000_000n) {
      return finish('error', 'INVALID_STATE');
    }

    const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
    if (key !== lastKey || !snapshot) {
      try {
        const parsed = waitSnapshotSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
        if (parsed.record.taskId !== taskId) throw new Error('Task ID mismatch');
        snapshot = parsed;
        lastKey = key;
        failures = 0;
      } catch {
        failures++;
        if (failures >= 3) return finish('error', 'INVALID_STATE');
        if (Date.now() >= deadline) return finish('wait-deadline', 'WAIT_DEADLINE');
        await setTimeout(Math.min(interval, Math.max(1, deadline - Date.now())));
        continue;
      }
    }

    const { record } = snapshot;
    if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled' || record.status === 'timeout') {
      const code = record.error?.code;
      return finish(record.status, record.status === 'failed' && code && errorCodePattern.test(code) ? code : null);
    }

    let promptMessage: { sequence: number; kind: 'question' | 'blocker' } | undefined;
    for (const message of record.messages ?? []) {
      if (message.sequence > after && (message.kind === 'question' || message.kind === 'blocker')) {
        if (!promptMessage || message.sequence < promptMessage.sequence) {
          promptMessage = { sequence: message.sequence, kind: message.kind };
        }
      }
    }
    if (promptMessage) return finish(promptMessage.kind, null, promptMessage.sequence);
    if (!processAlive(snapshot.ownerPid)) return finish('owner-stopped', 'OWNER_STOPPED');
    if (Date.now() >= deadline) return finish('wait-deadline', 'WAIT_DEADLINE');
    await setTimeout(Math.min(interval, Math.max(1, deadline - Date.now())));
  }
}
