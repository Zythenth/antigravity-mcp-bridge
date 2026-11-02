import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { stateDirectoryFrom, validateStateDirectory } from './config.js';
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
  'unknown-group': 10,
  'group-paused': 11,
  'group-ended': 12,
} as const;

export type WaitOutcome = keyof typeof WAIT_EXIT_CODES;
export const DEFAULT_WAIT_TIMEOUT_SECONDS = 1800;
export const MAX_WAIT_TIMEOUT_SECONDS = 86400;
export const WAIT_POLL_INTERVAL_MS = 500;

const taskIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decimalPattern = /^[0-9]+$/;
const errorCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const maxTaskStateBytes = 70_000_000n;
const maxGroupStateBytes = BigInt(5 * 1024 * 1024);
const maxPositionalTargets = 32;
const maxContinuationHops = 64;

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

const waitGroupSchema = z.object({
  version: z.literal(1),
  groupId: z.string(),
  state: z.enum(['created', 'running', 'paused', 'completed', 'failed', 'cancelled']),
  definition: z.object({
    jobs: z.array(z.object({
      key: z.string(),
    }).passthrough()),
  }).passthrough(),
  nodes: z.record(z.string(), z.object({
    state: z.string(),
    taskId: z.string().uuid().optional(),
  }).passthrough()),
  ownerPid: z.number().int().positive().optional(),
  error: z.object({ code: z.string() }).passthrough().optional(),
}).passthrough();

type WaitGroupSnapshot = z.infer<typeof waitGroupSchema>;

type ReadResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'transient' };

interface FileReader<T> {
  readonly value: T | undefined;
  read(): ReadResult<T>;
}

interface TargetState {
  taskId: string;
  nodeKey?: string;
  after: number;
  snapshot?: WaitSnapshot;
}

function inspectStateDirectory(stateDirectory: string): 'ok' | 'missing' | 'invalid' {
  let dirStat;
  try {
    dirStat = lstatSync(stateDirectory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? 'missing' : 'invalid';
  }
  return dirStat.isSymbolicLink() || !dirStat.isDirectory() ? 'invalid' : 'ok';
}

function createFileReader<T>(
  file: string,
  maxBytes: bigint,
  requireSingleLink: boolean,
  parse: (raw: unknown) => T,
): FileReader<T> {
  let lastKey: string | undefined;
  let current: T | undefined;
  let failures = 0;
  return {
    get value() {
      return current;
    },
    read(): ReadResult<T> {
      let stat;
      try {
        stat = lstatSync(file, { bigint: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'ENOENT' ? { status: 'missing' } : { status: 'invalid' };
      }
      if (stat.isSymbolicLink() || !stat.isFile() || (requireSingleLink && stat.nlink !== 1n) || stat.size > maxBytes) {
        return { status: 'invalid' };
      }
      const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
      if (key !== lastKey || !current) {
        try {
          current = parse(JSON.parse(readFileSync(file, 'utf8')));
          lastKey = key;
          failures = 0;
        } catch {
          failures++;
          return { status: failures >= 3 ? 'invalid' : 'transient' };
        }
      }
      return { status: 'ok', value: current };
    },
  };
}

function createTaskReader(stateDirectory: string, taskId: string): FileReader<WaitSnapshot> {
  return createFileReader(
    path.join(stateDirectory, `${taskId}.json`),
    maxTaskStateBytes,
    false,
    raw => {
      const parsed = waitSnapshotSchema.parse(raw);
      if (parsed.record.taskId !== taskId) throw new Error('Task ID mismatch');
      return parsed;
    },
  );
}

function isTerminalStatus(status: WaitSnapshot['record']['status']): status is 'completed' | 'failed' | 'cancelled' | 'timeout' {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timeout';
}

function failureReason(status: WaitSnapshot['record']['status'], error: WaitSnapshot['record']['error']): string | null {
  const code = error?.code;
  return status === 'failed' && code && errorCodePattern.test(code) ? code : null;
}

function findPromptMessage(record: WaitSnapshot['record'], after: number): { sequence: number; kind: 'question' | 'blocker' } | undefined {
  let promptMessage: { sequence: number; kind: 'question' | 'blocker' } | undefined;
  for (const message of record.messages ?? []) {
    if (message.sequence > after && (message.kind === 'question' || message.kind === 'blocker')) {
      if (!promptMessage || message.sequence < promptMessage.sequence) {
        promptMessage = { sequence: message.sequence, kind: message.kind };
      }
    }
  }
  return promptMessage;
}

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
  let after = 0;
  let timeout = DEFAULT_WAIT_TIMEOUT_SECONDS;
  let stateDirectoryArg: string | undefined;
  let groupId: string | null = null;
  let seenAfter = false;
  let seenTimeout = false;
  let seenStateDirectory = false;
  let seenGroup = false;
  let seenColon = false;
  let invalidArgs = false;
  let positionalCount = 0;
  const parsedPositionals: Array<{ taskId: string; after: number; hasColon: boolean }> = [];
  const seenTaskIds = new Set<string>();

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
    } else if (arg === '--group') {
      const value = args[++i];
      const lower = value?.toLowerCase();
      if (seenGroup || !lower || !taskIdPattern.test(lower)) invalidArgs = true;
      else groupId = lower;
      seenGroup = true;
    } else if (arg.startsWith('-')) {
      invalidArgs = true;
    } else {
      positionalCount++;
      const colon = arg.indexOf(':');
      if (colon !== -1) {
        seenColon = true;
        const lower = arg.slice(0, colon).toLowerCase();
        const afterStr = arg.slice(colon + 1);
        const parsedAfter = decimalPattern.test(afterStr) ? Number(afterStr) : NaN;
        if (!taskIdPattern.test(lower) || !Number.isSafeInteger(parsedAfter) || parsedAfter < 0 || seenTaskIds.has(lower)) {
          invalidArgs = true;
        } else {
          seenTaskIds.add(lower);
          parsedPositionals.push({ taskId: lower, after: parsedAfter, hasColon: true });
        }
      } else {
        const lower = arg.toLowerCase();
        if (!taskIdPattern.test(lower) || seenTaskIds.has(lower)) {
          invalidArgs = true;
        } else {
          seenTaskIds.add(lower);
          parsedPositionals.push({ taskId: lower, after: 0, hasColon: false });
        }
      }
    }
  }

  const useMultiShape = seenGroup || positionalCount > 1 || seenColon;

  if (!useMultiShape) {
    const taskId = parsedPositionals[0]?.taskId ?? null;
    let reader: FileReader<WaitSnapshot> | undefined;

    const finish = (outcome: WaitOutcome, reason: string | null, cursorOverride?: number): number => {
      const exitCode = WAIT_EXIT_CODES[outcome];
      const record = reader?.value?.record;
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

    if (invalidArgs || taskId === null) return finish('error', 'INVALID_ARGUMENTS');
    const stateDirectory = stateDirectoryArg ?? stateDirectoryFrom(env);
    if (!validateStateDirectory(stateDirectory).valid) {
      return finish('error', 'INVALID_STATE_DIRECTORY');
    }

    const deadline = Date.now() + timeout * 1000;
    const interval = Math.max(1, options.pollIntervalMs ?? WAIT_POLL_INTERVAL_MS);
    reader = createTaskReader(stateDirectory, taskId);

    for (;;) {
      const dirStatus = inspectStateDirectory(stateDirectory);
      if (dirStatus === 'missing') return finish('unknown-task', 'TASK_NOT_FOUND');
      if (dirStatus === 'invalid') return finish('error', 'INVALID_STATE_DIRECTORY');

      const res = reader.read();
      if (res.status === 'missing') return finish('unknown-task', 'TASK_NOT_FOUND');
      if (res.status === 'invalid') return finish('error', 'INVALID_STATE');
      if (res.status === 'transient') {
        if (Date.now() >= deadline) return finish('wait-deadline', 'WAIT_DEADLINE');
        await setTimeout(Math.min(interval, Math.max(1, deadline - Date.now())));
        continue;
      }

      const { record } = res.value;
      if (isTerminalStatus(record.status)) {
        return finish(record.status, failureReason(record.status, record.error));
      }

      const promptMessage = findPromptMessage(record, after);
      if (promptMessage) return finish(promptMessage.kind, null, promptMessage.sequence);
      if (!processAlive(res.value.ownerPid)) return finish('owner-stopped', 'OWNER_STOPPED');
      if (Date.now() >= deadline) return finish('wait-deadline', 'WAIT_DEADLINE');
      await setTimeout(Math.min(interval, Math.max(1, deadline - Date.now())));
    }
  }

  let groupSnapshot: WaitGroupSnapshot | undefined;
  let targets: TargetState[] = [];

  const finishMulti = (
    outcome: WaitOutcome,
    reason: string | null,
    cause?: TargetState,
    cursorOverride?: number,
  ): number => {
    const exitCode = WAIT_EXIT_CODES[outcome];
    const causeRecord = cause?.snapshot?.record;
    write(JSON.stringify({
      taskId: cause ? cause.taskId : null,
      groupId,
      outcome,
      exitCode,
      status: causeRecord?.status ?? null,
      groupState: groupSnapshot?.state ?? null,
      reason,
      after: cause ? cause.after : null,
      cursor: cursorOverride ?? (causeRecord ? (causeRecord.messageCursor ?? 0) : null),
      targets: targets.map(target => {
        const record = target.snapshot?.record;
        return {
          taskId: target.taskId,
          ...(target.nodeKey !== undefined ? { nodeKey: target.nodeKey } : {}),
          status: record?.status ?? null,
          after: target.after,
          resumeAfter: (outcome === 'question' || outcome === 'blocker') && cause === target && cursorOverride !== undefined
            ? cursorOverride
            : target.after,
          cursor: record ? (record.messageCursor ?? 0) : null,
          ...(record?.continuationTaskId ? { continuationTaskId: record.continuationTaskId } : {}),
        };
      }),
    }));
    return exitCode;
  };

  if (
    invalidArgs ||
    seenAfter ||
    positionalCount > maxPositionalTargets ||
    (!seenGroup && positionalCount === 0) ||
    (seenGroup && parsedPositionals.some(p => !p.hasColon))
  ) {
    return finishMulti('error', 'INVALID_ARGUMENTS');
  }

  if (!seenGroup) {
    targets = parsedPositionals.map(p => ({ taskId: p.taskId, after: p.after }));
  }
  const seeds = new Map(parsedPositionals.map(p => [p.taskId, p.after]));

  const stateDirectory = stateDirectoryArg ?? stateDirectoryFrom(env);
  if (!validateStateDirectory(stateDirectory).valid) {
    return finishMulti('error', 'INVALID_STATE_DIRECTORY');
  }

  const deadline = Date.now() + timeout * 1000;
  const interval = Math.max(1, options.pollIntervalMs ?? WAIT_POLL_INTERVAL_MS);
  const taskReaders = new Map<string, FileReader<WaitSnapshot>>();
  const getTaskReader = (id: string): FileReader<WaitSnapshot> => {
    let reader = taskReaders.get(id);
    if (!reader) {
      reader = createTaskReader(stateDirectory, id);
      taskReaders.set(id, reader);
    }
    return reader;
  };
  const groupReader = groupId !== null
    ? createFileReader(
        path.join(stateDirectory, `group-${groupId}.json`),
        maxGroupStateBytes,
        true,
        raw => {
          const parsed = waitGroupSchema.parse(raw);
          if (parsed.groupId.toLowerCase() !== groupId) throw new Error('Group ID mismatch');
          return parsed;
        },
      )
    : undefined;

  for (;;) {
    const dirStatus = inspectStateDirectory(stateDirectory);
    if (dirStatus === 'invalid') return finishMulti('error', 'INVALID_STATE_DIRECTORY');
    if (dirStatus === 'missing') {
      if (groupReader) {
        groupSnapshot = undefined;
        targets = [];
        return finishMulti('unknown-group', 'GROUP_NOT_FOUND');
      }
      return finishMulti('unknown-task', 'TASK_NOT_FOUND', targets[0]);
    }

    let transient = false;
    let invalidState = false;
    let missingTarget: TargetState | undefined;

    if (groupReader) {
      const groupRes = groupReader.read();
      if (groupRes.status === 'missing') {
        groupSnapshot = undefined;
        targets = [];
        return finishMulti('unknown-group', 'GROUP_NOT_FOUND');
      }
      if (groupRes.status === 'invalid') return finishMulti('error', 'INVALID_STATE');
      if (groupRes.status === 'transient') {
        if (Date.now() >= deadline) return finishMulti('wait-deadline', 'WAIT_DEADLINE');
        await setTimeout(Math.min(interval, Math.max(1, deadline - Date.now())));
        continue;
      }
      groupSnapshot = groupRes.value;
      const nextTargets: TargetState[] = [];
      for (const job of groupSnapshot.definition.jobs) {
        const node = Object.hasOwn(groupSnapshot.nodes, job.key) ? groupSnapshot.nodes[job.key] : undefined;
        const rootTaskId = node?.taskId?.toLowerCase();
        if (!rootTaskId) continue;
        const rootReader = getTaskReader(rootTaskId);
        const rootRes = rootReader.read();
        if (rootRes.status !== 'ok') {
          const target: TargetState = {
            taskId: rootTaskId,
            nodeKey: job.key,
            after: seeds.get(rootTaskId) ?? 0,
            snapshot: rootRes.status === 'missing' ? undefined : rootReader.value,
          };
          if (rootRes.status === 'missing') missingTarget ??= target;
          else if (rootRes.status === 'invalid') invalidState = true;
          else transient = true;
          nextTargets.push(target);
          continue;
        }
        let currentId = rootTaskId;
        let currentSnapshot: WaitSnapshot | undefined = rootRes.value;
        let hops = 0;
        while (currentSnapshot?.record.continuationTaskId) {
          const contId = currentSnapshot.record.continuationTaskId.toLowerCase();
          const contReader = getTaskReader(contId);
          const contRes = contReader.read();
          if (contRes.status === 'missing') break;
          hops++;
          if (hops > maxContinuationHops) {
            invalidState = true;
            break;
          }
          if (contRes.status === 'invalid') {
            invalidState = true;
            currentId = contId;
            currentSnapshot = contReader.value;
            break;
          }
          if (contRes.status === 'transient') {
            transient = true;
            currentId = contId;
            currentSnapshot = contReader.value;
            break;
          }
          currentId = contId;
          currentSnapshot = contRes.value;
        }
        nextTargets.push({
          taskId: currentId,
          nodeKey: job.key,
          after: seeds.get(currentId) ?? 0,
          snapshot: currentSnapshot,
        });
      }
      targets = nextTargets;
    } else {
      for (const target of targets) {
        const reader = getTaskReader(target.taskId);
        const res = reader.read();
        if (res.status === 'missing') {
          target.snapshot = undefined;
          missingTarget ??= target;
        } else if (res.status === 'invalid') {
          target.snapshot = reader.value;
          invalidState = true;
        } else if (res.status === 'transient') {
          target.snapshot = reader.value;
          transient = true;
        } else {
          target.snapshot = res.value;
        }
      }
    }

    if (invalidState) return finishMulti('error', 'INVALID_STATE');
    if (missingTarget) return finishMulti('unknown-task', 'TASK_NOT_FOUND', missingTarget);
    if (transient) {
      if (Date.now() >= deadline) return finishMulti('wait-deadline', 'WAIT_DEADLINE');
      await setTimeout(Math.min(interval, Math.max(1, deadline - Date.now())));
      continue;
    }

    for (const target of targets) {
      const promptMessage = findPromptMessage(target.snapshot!.record, target.after);
      if (promptMessage) {
        return finishMulti(promptMessage.kind, null, target, promptMessage.sequence);
      }
    }

    for (const target of targets) {
      const { status, error } = target.snapshot!.record;
      if (status === 'failed' || status === 'cancelled' || status === 'timeout') {
        return finishMulti(status, failureReason(status, error), target);
      }
    }

    if (groupSnapshot && (groupSnapshot.state === 'failed' || groupSnapshot.state === 'cancelled')) {
      const code = groupSnapshot.error?.code;
      const reason = code && errorCodePattern.test(code)
        ? code
        : groupSnapshot.state === 'failed'
        ? 'GROUP_FAILED'
        : 'GROUP_CANCELLED';
      return finishMulti('group-ended', reason);
    }

    if (groupSnapshot) {
      if (groupSnapshot.state === 'completed' && targets.every(t => t.snapshot?.record.status === 'completed')) {
        return finishMulti('completed', null);
      }
      if (groupSnapshot.state === 'paused') {
        return finishMulti('group-paused', 'GROUP_PAUSED');
      }
      if (groupSnapshot.state === 'running' && groupSnapshot.ownerPid !== undefined && !processAlive(groupSnapshot.ownerPid)) {
        return finishMulti('group-paused', 'OWNER_STOPPED');
      }
    } else if (targets.length > 0 && targets.every(t => t.snapshot?.record.status === 'completed')) {
      return finishMulti('completed', null);
    }

    for (const target of targets) {
      if (!isTerminalStatus(target.snapshot!.record.status) && !processAlive(target.snapshot!.ownerPid)) {
        return finishMulti('owner-stopped', 'OWNER_STOPPED', target);
      }
    }

    if (Date.now() >= deadline) return finishMulti('wait-deadline', 'WAIT_DEADLINE');
    await setTimeout(Math.min(interval, Math.max(1, deadline - Date.now())));
  }
}
