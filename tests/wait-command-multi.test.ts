import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { groupDefinitionSha256, groupRecordSchema, type GroupDefinition, type GroupRecord } from '../src/group-contract.js';
import { appendMessage } from '../src/messages.js';
import { StateStore, replaceStateFile, type StoredTask } from '../src/state-store.js';
import type { GroupNodeStatus } from '../src/task-groups.js';
import type { TaskStatus } from '../src/types.js';
import { WAIT_EXIT_CODES, runWaitCommand, type WaitOutcome } from '../src/wait-command.js';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

// Preloaded into a wait child so a test can observe each state file read; it reports file names and content hashes only.
const readProbe = `data:text/javascript,${encodeURIComponent([
  "import { createHash } from 'node:crypto';",
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import { syncBuiltinESMExports } from 'node:module';",
  'const readFileSync = fs.readFileSync;',
  'fs.readFileSync = function (file, ...rest) {',
  '  const result = readFileSync.call(this, file, ...rest);',
  "  if (typeof file === 'string') process.stderr.write(`READ ${path.basename(file)} ${createHash('sha256').update(result).digest('hex')}\\n`);",
  '  return result;',
  '};',
  'syncBuiltinESMExports();',
].join('\n'))}`;

interface SingleWaitOutput {
  taskId: string | null;
  outcome: WaitOutcome;
  exitCode: number;
  status: TaskStatus | null;
  reason: string | null;
  after: number;
  cursor: number | null;
  continuationTaskId?: string;
}

interface MultiWaitTargetOutput {
  taskId: string;
  nodeKey?: string;
  status: TaskStatus | null;
  after: number;
  resumeAfter: number;
  cursor: number | null;
  continuationTaskId?: string;
}

interface MultiWaitOutput {
  taskId: string | null;
  groupId: string | null;
  outcome: WaitOutcome;
  exitCode: number;
  status: TaskStatus | null;
  groupState: GroupRecord['state'] | null;
  reason: string | null;
  after: number | null;
  cursor: number | null;
  targets: MultiWaitTargetOutput[];
}

interface GroupJobSpec {
  key: string;
  dependsOn?: string[];
  state?: GroupNodeStatus;
  taskId?: string;
}

const activeChildren = new Set<ChildProcess>();

function killRemainingChildren(): void {
  for (const child of activeChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
  activeChildren.clear();
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BRIDGE_STATE_DIRECTORY;
  return env;
}

function startCommand(executable: string, args: readonly string[]) {
  const child = spawn(executable, [...args], {
    windowsHide: true,
    env: cleanEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChildren.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; exitedAt: number }>((resolve, reject) => {
    child.once('error', error => {
      activeChildren.delete(child);
      reject(error);
    });
    child.once('close', (code, signal) => {
      const exitedAt = performance.now();
      activeChildren.delete(child);
      resolve({ code, signal, stdout, stderr, exitedAt });
    });
  });
  return { child, done };
}

function startWaitArgs(waitArgs: readonly string[]) {
  return startCommand(process.execPath, [entry, 'wait', ...waitArgs]);
}

async function finishWait<T = MultiWaitOutput>(handle: ReturnType<typeof startWaitArgs>, options: { readProbe?: boolean } = {}) {
  const outcome = await handle.done;
  assert.equal(options.readProbe ? outcome.stderr.replace(/^READ \S+ [0-9a-f]{64}\r?\n/gm, '') : outcome.stderr, '');
  const trimmed = outcome.stdout.replace(/\r?\n$/, '');
  const lines = trimmed === '' ? [] : trimmed.split(/\r?\n/);
  assert.equal(lines.length, 1, `Expected exactly one stdout line, got: ${JSON.stringify(outcome.stdout)}`);
  const json = JSON.parse(lines[0]!) as T;
  assert.equal(outcome.stdout.includes('PRIVATE_'), false, `Leaked fixture text in stdout: ${outcome.stdout}`);
  return { code: outcome.code, stdout: outcome.stdout, exitedAt: outcome.exitedAt, json };
}

function runWaitArgs<T = MultiWaitOutput>(waitArgs: readonly string[]) {
  return finishWait<T>(startWaitArgs(waitArgs));
}

// runWaitCommand reads the state synchronously before its first await, so a caller that
// changes the state after this returns knows the first snapshot did not include the change.
function startInProcessWait(waitArgs: readonly string[]) {
  const lines: string[] = [];
  const done = runWaitCommand(waitArgs, {}, line => lines.push(line));
  return { lines, done };
}

async function finishInProcessWait<T = MultiWaitOutput>(handle: ReturnType<typeof startInProcessWait>) {
  const code = await handle.done;
  const exitedAt = performance.now();
  assert.equal(handle.lines.length, 1, `Expected exactly one output line, got: ${JSON.stringify(handle.lines)}`);
  const line = handle.lines[0]!;
  assert.equal(line.includes('PRIVATE_'), false, `Leaked fixture text in output: ${line}`);
  return { code, exitedAt, json: JSON.parse(line) as T };
}

async function waitForCondition(condition: () => boolean, timeoutMs: number, describe: () => string): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    assert.ok(performance.now() < deadline, describe());
    await delay(20);
  }
}

function deadPid(): number {
  const exitedChild = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.ok(exitedChild.pid && exitedChild.pid > 0);
  return exitedChild.pid;
}

function stateFixture() {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wait-command-multi-test-')));
  const state = new StateStore(directory);
  const makeStored = (status: TaskStatus = 'running', ownerPid = process.pid): StoredTask => {
    const taskId = randomUUID();
    return {
      ownerPid,
      events: [],
      cursor: 0,
      record: {
        taskId,
        workingDirectory: directory,
        prompt: 'PRIVATE_PROMPT_TEXT',
        status,
        createdAt: new Date().toISOString(),
        ...(status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timeout'
          ? { completedAt: new Date().toISOString() }
          : {}),
      },
      options: {
        workingDirectory: directory,
        prompt: 'PRIVATE_PROMPT_TEXT',
      },
    };
  };
  const makeGroup = (
    jobs: readonly GroupJobSpec[],
    groupState: GroupRecord['state'] = 'running',
    options: { groupId?: string; ownerPid?: number; error?: { code: string; message: string } } = {},
  ): GroupRecord => {
    const groupId = (options.groupId ?? randomUUID()).toLowerCase();
    const definition: GroupDefinition = {
      workingDirectory: directory,
      title: 'PRIVATE_GROUP_TITLE',
      jobs: jobs.map(job => ({
        key: job.key,
        owner: 'implementer',
        dependsOn: job.dependsOn ?? [],
        task: {
          prompt: 'PRIVATE_GROUP_PROMPT_TEXT',
          mode: 'read-only',
          deliveryMode: 'messages',
        },
      })),
    };
    const now = new Date().toISOString();
    const record: GroupRecord = {
      version: 1,
      groupId,
      definitionSha256: groupDefinitionSha256(definition),
      definition,
      profiles: Object.fromEntries(jobs.map(job => [job.key, '0'.repeat(64)])),
      nodes: Object.fromEntries(
        jobs.map(job => [
          job.key,
          {
            state: job.state ?? 'pending',
            ...(job.taskId !== undefined ? { taskId: job.taskId } : {}),
          },
        ]),
      ),
      state: groupState,
      createdAt: now,
      updatedAt: now,
      ...(options.ownerPid !== undefined ? { ownerPid: options.ownerPid } : {}),
      ...(options.error !== undefined ? { error: options.error } : {}),
    };
    return groupRecordSchema.parse(record);
  };
  const saveGroup = (record: GroupRecord): GroupRecord => {
    const validated = groupRecordSchema.parse({
      ...record,
      updatedAt: new Date().toISOString(),
    });
    const target = path.join(directory, `group-${validated.groupId.toLowerCase()}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(validated), { flag: 'wx', mode: 0o600, flush: true });
      replaceStateFile(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return validated;
  };
  return {
    directory,
    state,
    makeStored,
    makeGroup,
    saveGroup,
    close() {
      killRemainingChildren();
      const tmpRoot = fs.realpathSync.native(os.tmpdir());
      const resolvedDir = fs.existsSync(directory) ? fs.realpathSync.native(directory) : path.resolve(directory);
      const relative = path.relative(tmpRoot, resolvedDir);
      assert.ok(relative && !relative.startsWith('..') && !relative.includes(path.sep) && relative.startsWith('agy-wait-command-multi-test-'));
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

interface FileSnapshot {
  relativePath: string;
  sha256: string;
  size: number;
  mtimeMs: number;
}

function snapshotDirectory(root: string, current = root): FileSnapshot[] {
  const results: FileSnapshot[] = [];
  for (const entryItem of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(current, entryItem.name);
    if (entryItem.isDirectory()) {
      results.push(...snapshotDirectory(root, fullPath));
    } else {
      const stat = fs.lstatSync(fullPath);
      const bytes = fs.readFileSync(fullPath);
      results.push({
        relativePath: path.relative(root, fullPath),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  return results;
}

test('single mode output key set and exit codes remain unchanged', async () => {
  const f = stateFixture();
  try {
    assert.deepEqual(WAIT_EXIT_CODES, {
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
    });

    const completed = f.makeStored('completed');
    appendMessage(completed.record, 'final', 'agy-reported', 'PRIVATE_SINGLE_FINAL');
    f.state.save(completed);

    const singleRes = await runWaitArgs<SingleWaitOutput>(['--state-directory', f.directory, completed.record.taskId, '--timeout', '30']);
    assert.equal(singleRes.code, 0);
    assert.deepEqual(Object.keys(singleRes.json), ['taskId', 'outcome', 'exitCode', 'status', 'reason', 'after', 'cursor']);
    assert.equal('targets' in singleRes.json, false);
    assert.equal('groupId' in singleRes.json, false);
    assert.equal('groupState' in singleRes.json, false);
    assert.deepEqual(singleRes.json, {
      taskId: completed.record.taskId,
      outcome: 'completed',
      exitCode: 0,
      status: 'completed',
      reason: null,
      after: 0,
      cursor: 1,
    });

    const continued = f.makeStored('completed');
    const nextId = randomUUID();
    continued.record.continuationTaskId = nextId;
    f.state.save(continued);
    const contRes = await runWaitArgs<SingleWaitOutput>(['--state-directory', f.directory, continued.record.taskId, '--timeout', '30']);
    assert.equal(contRes.code, 0);
    assert.deepEqual(Object.keys(contRes.json), ['taskId', 'outcome', 'exitCode', 'status', 'reason', 'after', 'cursor', 'continuationTaskId']);
    assert.equal(contRes.json.continuationTaskId, nextId);
  } finally {
    f.close();
  }
});

test('multi mode wakes on question, blocker and failure on a non-first target within 5 seconds at p95', async () => {
  const f = stateFixture();
  try {
    const specs: Array<{
      kind: 'question' | 'blocker' | 'failed';
      expectedCode: number;
      expectedOutcome: WaitOutcome;
      expectedStatus: TaskStatus;
      expectedReason: string | null;
    }> = [
      { kind: 'question', expectedCode: 5, expectedOutcome: 'question', expectedStatus: 'running', expectedReason: null },
      { kind: 'blocker', expectedCode: 6, expectedOutcome: 'blocker', expectedStatus: 'running', expectedReason: null },
      { kind: 'failed', expectedCode: 2, expectedOutcome: 'failed', expectedStatus: 'failed', expectedReason: 'TASK_FAILED' },
    ];

    for (const spec of specs) {
      const latencies: number[] = [];
      for (let i = 0; i < 5; i++) {
        const first = f.makeStored('running');
        const second = f.makeStored('running');
        appendMessage(second.record, 'question', 'agy-reported', 'PRIVATE_CONSUMED_QUESTION');
        f.state.save(first);
        f.state.save(second);

        const handle = startInProcessWait([
          '--state-directory',
          f.directory,
          first.record.taskId,
          `${second.record.taskId}:1`,
          '--timeout',
          '60',
        ]);
        assert.deepEqual(handle.lines, []);

        const t0 = performance.now();
        let expectedCursor: number;
        let expectedResumeAfter: number;
        if (spec.kind === 'question' || spec.kind === 'blocker') {
          const msg = appendMessage(second.record, spec.kind, 'agy-reported', `PRIVATE_${spec.kind.toUpperCase()}_TEXT`);
          expectedCursor = msg.sequence;
          expectedResumeAfter = msg.sequence;
        } else {
          second.record.status = 'failed';
          second.record.completedAt = new Date().toISOString();
          second.record.error = { code: 'TASK_FAILED', message: 'PRIVATE_FAILURE_MESSAGE' };
          appendMessage(second.record, 'error', 'agy-reported', 'PRIVATE_ERROR_MESSAGE');
          expectedCursor = second.record.messageCursor ?? 0;
          expectedResumeAfter = 1;
        }
        f.state.save(second);

        const result = await finishInProcessWait(handle);
        latencies.push(result.exitedAt - t0);
        assert.equal(result.code, spec.expectedCode);
        assert.deepEqual(result.json, {
          taskId: second.record.taskId,
          groupId: null,
          outcome: spec.expectedOutcome,
          exitCode: spec.expectedCode,
          status: spec.expectedStatus,
          groupState: null,
          reason: spec.expectedReason,
          after: 1,
          cursor: expectedCursor,
          targets: [
            {
              taskId: first.record.taskId,
              status: 'running',
              after: 0,
              resumeAfter: 0,
              cursor: 0,
            },
            {
              taskId: second.record.taskId,
              status: spec.expectedStatus,
              after: 1,
              resumeAfter: expectedResumeAfter,
              cursor: second.record.messageCursor ?? 0,
            },
          ],
        });
      }
      const sorted = [...latencies].sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]!;
      assert.ok(p95 <= 5000, `Expected ${spec.kind} p95 <= 5000ms, got ${p95}ms`);
    }
  } finally {
    f.close();
  }
});

test('one completed target does not end wait while another is running, then all completed exits 0', async () => {
  const f = stateFixture();
  try {
    const exitedOwner = deadPid();
    const first = f.makeStored('completed', exitedOwner);
    appendMessage(first.record, 'final', 'agy-reported', 'PRIVATE_FIRST_DONE');
    const second = f.makeStored('running');
    appendMessage(second.record, 'message', 'agy-reported', 'PRIVATE_SECOND_PROGRESS');
    f.state.save(first);
    f.state.save(second);

    const deadlineRes = await runWaitArgs([
      '--state-directory',
      f.directory,
      first.record.taskId,
      second.record.taskId,
      '--timeout',
      '1',
    ]);
    assert.equal(deadlineRes.code, 8);
    assert.deepEqual(deadlineRes.json, {
      taskId: null,
      groupId: null,
      outcome: 'wait-deadline',
      exitCode: 8,
      status: null,
      groupState: null,
      reason: 'WAIT_DEADLINE',
      after: null,
      cursor: null,
      targets: [
        {
          taskId: first.record.taskId,
          status: 'completed',
          after: 0,
          resumeAfter: 0,
          cursor: 1,
        },
        {
          taskId: second.record.taskId,
          status: 'running',
          after: 0,
          resumeAfter: 0,
          cursor: 1,
        },
      ],
    });

    second.record.status = 'completed';
    second.record.completedAt = new Date().toISOString();
    appendMessage(second.record, 'final', 'agy-reported', 'PRIVATE_SECOND_DONE');
    f.state.save(second);

    const completedRes = await runWaitArgs([
      '--state-directory',
      f.directory,
      first.record.taskId,
      second.record.taskId,
      '--timeout',
      '30',
    ]);
    assert.equal(completedRes.code, 0);
    assert.deepEqual(completedRes.json, {
      taskId: null,
      groupId: null,
      outcome: 'completed',
      exitCode: 0,
      status: null,
      groupState: null,
      reason: null,
      after: null,
      cursor: null,
      targets: [
        {
          taskId: first.record.taskId,
          status: 'completed',
          after: 0,
          resumeAfter: 0,
          cursor: 1,
        },
        {
          taskId: second.record.taskId,
          status: 'completed',
          after: 0,
          resumeAfter: 0,
          cursor: 2,
        },
      ],
    });
  } finally {
    f.close();
  }
});

test('group mode tracks a node that receives a taskId later and follows continuation chains', async () => {
  const f = stateFixture();
  try {
    const taskA = f.makeStored('completed');
    appendMessage(taskA.record, 'final', 'agy-reported', 'PRIVATE_NODE_A_DONE');
    f.state.save(taskA);

    const group = f.saveGroup(
      f.makeGroup(
        [
          { key: 'node-a', state: 'completed', taskId: taskA.record.taskId },
          { key: 'node-b', dependsOn: ['node-a'], state: 'pending' },
        ],
        'running',
        { ownerPid: process.pid },
      ),
    );

    const handle = startInProcessWait(['--state-directory', f.directory, '--group', group.groupId, '--timeout', '60']);
    assert.deepEqual(handle.lines, []);

    const taskB1 = f.makeStored('completed');
    const taskB2 = f.makeStored('running');
    const uncreatedContinuationId = randomUUID();
    taskB1.record.continuationTaskId = taskB2.record.taskId;
    appendMessage(taskB2.record, 'message', 'agy-reported', 'PRIVATE_B2_MSG');
    const questionMsg = appendMessage(taskB2.record, 'question', 'agy-reported', 'PRIVATE_B2_QUESTION');
    taskB2.record.continuationTaskId = uncreatedContinuationId;
    f.state.save(taskB1);
    f.state.save(taskB2);

    group.nodes['node-b'] = { state: 'running', taskId: taskB1.record.taskId };
    f.saveGroup(group);

    const res = await finishInProcessWait(handle);
    assert.equal(res.code, 5);
    assert.deepEqual(res.json, {
      taskId: taskB2.record.taskId,
      groupId: group.groupId,
      outcome: 'question',
      exitCode: 5,
      status: 'running',
      groupState: 'running',
      reason: null,
      after: 0,
      cursor: questionMsg.sequence,
      targets: [
        {
          taskId: taskA.record.taskId,
          nodeKey: 'node-a',
          status: 'completed',
          after: 0,
          resumeAfter: 0,
          cursor: 1,
        },
        {
          taskId: taskB2.record.taskId,
          nodeKey: 'node-b',
          status: 'running',
          after: 0,
          resumeAfter: questionMsg.sequence,
          cursor: 2,
          continuationTaskId: uncreatedContinuationId,
        },
      ],
    });

    // Seed cursor on taskB2 skips the consumed question and wakes when continuation taskB3 is created with a blocker.
    const taskB3 = f.makeStored('running');
    const blockerMsg = appendMessage(taskB3.record, 'blocker', 'agy-reported', 'PRIVATE_B3_BLOCKER');
    f.state.save(taskB3);
    taskB2.record.status = 'completed';
    taskB2.record.completedAt = new Date().toISOString();
    taskB2.record.continuationTaskId = taskB3.record.taskId;
    f.state.save(taskB2);

    const seededRes = await runWaitArgs([
      '--state-directory',
      f.directory,
      '--group',
      group.groupId,
      `${taskB2.record.taskId}:${questionMsg.sequence}`,
      `${ randomUUID() }:9`,
      '--timeout',
      '30',
    ]);
    assert.equal(seededRes.code, 6);
    assert.equal(seededRes.json.taskId, taskB3.record.taskId);
    assert.equal(seededRes.json.outcome, 'blocker');
    assert.equal(seededRes.json.after, 0);
    assert.equal(seededRes.json.cursor, blockerMsg.sequence);
    assert.equal(seededRes.json.targets[1]?.taskId, taskB3.record.taskId);
    assert.equal(seededRes.json.targets[1]?.nodeKey, 'node-b');
    assert.equal(seededRes.json.targets[1]?.after, 0);
    assert.equal(seededRes.json.targets[1]?.resumeAfter, blockerMsg.sequence);
  } finally {
    f.close();
  }
});

test('group mode handles paused, dead owner, failed, cancelled, completed, unknown group, unknown root task and hop limit', async () => {
  const f = stateFixture();
  try {
    // Unknown group in existing state directory -> 10
    const missingGroupId = randomUUID();
    const unknownGroupRes = await runWaitArgs(['--state-directory', f.directory, '--group', missingGroupId, '--timeout', '5']);
    assert.equal(unknownGroupRes.code, 10);
    assert.deepEqual(unknownGroupRes.json, {
      taskId: null,
      groupId: missingGroupId,
      outcome: 'unknown-group',
      exitCode: 10,
      status: null,
      groupState: null,
      reason: 'GROUP_NOT_FOUND',
      after: null,
      cursor: null,
      targets: [],
    });

    // Unknown group in non-existent state directory -> 10 without creating directory
    const missingDir = path.join(f.directory, 'nonexistent-group-dir');
    const missingDirRes = await runWaitArgs(['--state-directory', missingDir, '--group', missingGroupId, '--timeout', '5']);
    assert.equal(missingDirRes.code, 10);
    assert.equal(missingDirRes.json.outcome, 'unknown-group');
    assert.equal(missingDirRes.json.reason, 'GROUP_NOT_FOUND');
    assert.equal(fs.existsSync(missingDir), false);

    // Unknown root task -> 7
    const missingRootTaskId = randomUUID();
    const unknownRootGroup = f.saveGroup(
      f.makeGroup([{ key: 'node-a', state: 'running', taskId: missingRootTaskId }], 'running', { ownerPid: process.pid }),
    );
    const unknownRootRes = await runWaitArgs(['--state-directory', f.directory, '--group', unknownRootGroup.groupId, '--timeout', '5']);
    assert.equal(unknownRootRes.code, 7);
    assert.deepEqual(unknownRootRes.json, {
      taskId: missingRootTaskId,
      groupId: unknownRootGroup.groupId,
      outcome: 'unknown-task',
      exitCode: 7,
      status: null,
      groupState: 'running',
      reason: 'TASK_NOT_FOUND',
      after: 0,
      cursor: null,
      targets: [
        {
          taskId: missingRootTaskId,
          nodeKey: 'node-a',
          status: null,
          after: 0,
          resumeAfter: 0,
          cursor: null,
        },
      ],
    });

    // Paused group -> 11 GROUP_PAUSED
    const runningTask = f.makeStored('running');
    f.state.save(runningTask);
    const pausedGroup = f.saveGroup(
      f.makeGroup([{ key: 'node-a', state: 'running', taskId: runningTask.record.taskId }], 'paused'),
    );
    const pausedRes = await runWaitArgs(['--state-directory', f.directory, '--group', pausedGroup.groupId, '--timeout', '5']);
    assert.equal(pausedRes.code, 11);
    assert.equal(pausedRes.json.outcome, 'group-paused');
    assert.equal(pausedRes.json.groupState, 'paused');
    assert.equal(pausedRes.json.reason, 'GROUP_PAUSED');
    assert.equal(pausedRes.json.taskId, null);

    // Running group with dead ownerPid -> 11 OWNER_STOPPED
    const deadOwnerGroup = f.saveGroup(
      f.makeGroup([{ key: 'node-a', state: 'running', taskId: runningTask.record.taskId }], 'running', { ownerPid: deadPid() }),
    );
    const deadOwnerRes = await runWaitArgs(['--state-directory', f.directory, '--group', deadOwnerGroup.groupId, '--timeout', '5']);
    assert.equal(deadOwnerRes.code, 11);
    assert.equal(deadOwnerRes.json.outcome, 'group-paused');
    assert.equal(deadOwnerRes.json.groupState, 'running');
    assert.equal(deadOwnerRes.json.reason, 'OWNER_STOPPED');
    assert.equal(deadOwnerRes.json.taskId, null);

    // Group failed with valid error code -> 12 with error.code, and with invalid error code -> 12 GROUP_FAILED
    const completedTask = f.makeStored('completed');
    f.state.save(completedTask);
    const failedGroupWithCode = f.saveGroup(
      f.makeGroup([{ key: 'node-a', state: 'completed', taskId: completedTask.record.taskId }], 'failed', {
        error: { code: 'WORKFLOW_SYNTHESIS_FAILED', message: 'PRIVATE_GROUP_ERROR_TEXT' },
      }),
    );
    const failedCodeRes = await runWaitArgs(['--state-directory', f.directory, '--group', failedGroupWithCode.groupId, '--timeout', '5']);
    assert.equal(failedCodeRes.code, 12);
    assert.equal(failedCodeRes.json.outcome, 'group-ended');
    assert.equal(failedCodeRes.json.groupState, 'failed');
    assert.equal(failedCodeRes.json.reason, 'WORKFLOW_SYNTHESIS_FAILED');
    assert.equal(failedCodeRes.json.taskId, null);

    const failedGroupFallback = f.saveGroup(
      f.makeGroup([{ key: 'node-a', state: 'completed', taskId: completedTask.record.taskId }], 'failed', {
        error: { code: 'bad code PRIVATE_GROUP_CODE', message: 'PRIVATE_GROUP_ERROR_TEXT' },
      }),
    );
    const failedFallbackRes = await runWaitArgs(['--state-directory', f.directory, '--group', failedGroupFallback.groupId, '--timeout', '5']);
    assert.equal(failedFallbackRes.code, 12);
    assert.equal(failedFallbackRes.json.outcome, 'group-ended');
    assert.equal(failedFallbackRes.json.groupState, 'failed');
    assert.equal(failedFallbackRes.json.reason, 'GROUP_FAILED');

    // Group cancelled -> 12 GROUP_CANCELLED
    const cancelledGroup = f.saveGroup(
      f.makeGroup([{ key: 'node-a', state: 'cancelled' }], 'cancelled'),
    );
    const cancelledRes = await runWaitArgs(['--state-directory', f.directory, '--group', cancelledGroup.groupId, '--timeout', '5']);
    assert.equal(cancelledRes.code, 12);
    assert.equal(cancelledRes.json.outcome, 'group-ended');
    assert.equal(cancelledRes.json.groupState, 'cancelled');
    assert.equal(cancelledRes.json.reason, 'GROUP_CANCELLED');
    assert.equal(cancelledRes.json.taskId, null);

    // Group completed with all tracked tasks completed -> 0
    const completedTask2 = f.makeStored('completed');
    f.state.save(completedTask2);
    const completedGroup = f.saveGroup(
      f.makeGroup(
        [
          { key: 'node-a', state: 'completed', taskId: completedTask.record.taskId },
          { key: 'node-b', dependsOn: ['node-a'], state: 'completed', taskId: completedTask2.record.taskId },
        ],
        'completed',
      ),
    );
    const completedGroupRes = await runWaitArgs(['--state-directory', f.directory, '--group', completedGroup.groupId, '--timeout', '5']);
    assert.equal(completedGroupRes.code, 0);
    assert.equal(completedGroupRes.json.outcome, 'completed');
    assert.equal(completedGroupRes.json.groupState, 'completed');
    assert.equal(completedGroupRes.json.reason, null);
    assert.equal(completedGroupRes.json.taskId, null);
    assert.equal(completedGroupRes.json.targets.length, 2);

    // Continuation cycle (> 64 hops) -> 1 INVALID_STATE
    const cycleA = f.makeStored('completed');
    const cycleB = f.makeStored('completed');
    cycleA.record.continuationTaskId = cycleB.record.taskId;
    cycleB.record.continuationTaskId = cycleA.record.taskId;
    f.state.save(cycleA);
    f.state.save(cycleB);
    const cycleGroup = f.saveGroup(
      f.makeGroup([{ key: 'node-a', state: 'running', taskId: cycleA.record.taskId }], 'running', { ownerPid: process.pid }),
    );
    const cycleRes = await runWaitArgs(['--state-directory', f.directory, '--group', cycleGroup.groupId, '--timeout', '5']);
    assert.equal(cycleRes.code, 1);
    assert.equal(cycleRes.json.outcome, 'error');
    assert.equal(cycleRes.json.reason, 'INVALID_STATE');
  } finally {
    f.close();
  }
});

test('invalid argument combinations return exit 1 INVALID_ARGUMENTS with matching single or multi shape', async () => {
  const f = stateFixture();
  try {
    const id1 = randomUUID();
    const id2 = randomUUID();
    const groupId = randomUUID();
    const thirtyThreeMulti = Array.from({ length: 33 }, () => randomUUID());
    const thirtyThreeGroupSeeds = Array.from({ length: 33 }, () => `${randomUUID()}:0`);

    const multiInvalidCases: string[][] = [
      ['--state-directory', f.directory, id1, id2, '--after', '0'],
      ['--state-directory', f.directory, `${id1}:0`, '--after', '0'],
      ['--state-directory', f.directory, '--group', groupId, '--after', '0'],
      ['--state-directory', f.directory, id1, id1.toUpperCase()],
      ['--state-directory', f.directory, `${id1}:0`, `${id1}:2`],
      ['--state-directory', f.directory, '--group', groupId, `${id1}:0`, `${id1}:1`],
      ['--state-directory', f.directory, ...thirtyThreeMulti],
      ['--state-directory', f.directory, '--group', groupId, ...thirtyThreeGroupSeeds],
      ['--state-directory', f.directory, '--group', groupId, id1],
      ['--state-directory', f.directory, 'not-a-uuid', id1],
      ['--state-directory', f.directory, `${id1}:-1`],
      ['--state-directory', f.directory, `${id1}:abc`],
      ['--state-directory', f.directory, `${id1}:`],
      ['--state-directory', f.directory, `bad-uuid:0`],
      ['--state-directory', f.directory, '--group', 'not-a-uuid'],
      ['--state-directory', f.directory, '--group'],
      ['--state-directory', f.directory, '--group', groupId, '--group', randomUUID()],
    ];

    for (const args of multiInvalidCases) {
      const res = await runWaitArgs(args);
      assert.equal(res.code, 1, `Expected exit 1 for args: ${JSON.stringify(args)}`);
      assert.equal(res.json.outcome, 'error');
      assert.equal(res.json.reason, 'INVALID_ARGUMENTS');
      assert.deepEqual(Object.keys(res.json), [
        'taskId',
        'groupId',
        'outcome',
        'exitCode',
        'status',
        'groupState',
        'reason',
        'after',
        'cursor',
        'targets',
      ]);
    }

    const singleNoTarget = await runWaitArgs<SingleWaitOutput>(['--state-directory', f.directory]);
    assert.equal(singleNoTarget.code, 1);
    assert.equal(singleNoTarget.json.outcome, 'error');
    assert.equal(singleNoTarget.json.reason, 'INVALID_ARGUMENTS');
    assert.deepEqual(Object.keys(singleNoTarget.json), ['taskId', 'outcome', 'exitCode', 'status', 'reason', 'after', 'cursor']);
  } finally {
    f.close();
  }
});

test('multi mode tracks 32 simultaneous tasks, stays waiting when 31 complete, and exits 0 when the 32nd completes', async () => {
  const f = stateFixture();
  try {
    const tasks = Array.from({ length: 32 }, (_, i) => {
      const stored = f.makeStored('running');
      appendMessage(stored.record, 'message', 'agy-reported', `PRIVATE_PROGRESS_${i}`);
      f.state.save(stored);
      return stored;
    });

    const taskIds = tasks.map(t => t.record.taskId);
    assert.equal(taskIds.length, 32);

    const handle = startCommand(process.execPath, [
      '--import',
      readProbe,
      entry,
      'wait',
      '--state-directory',
      f.directory,
      ...taskIds,
      '--timeout',
      '60',
    ]);

    let probeOutput = '';
    handle.child.stderr.on('data', (chunk: string) => {
      probeOutput += chunk;
    });

    const all32TasksReadInitially = () => {
      const readFiles = new Set(
        probeOutput
          .split(/\r?\n/)
          .filter(line => line.startsWith('READ '))
          .map(line => line.split(' ')[1])
          .filter(Boolean),
      );
      return tasks.every(t => readFiles.has(`${t.record.taskId}.json`));
    };

    await waitForCondition(
      all32TasksReadInitially,
      30_000,
      () => `Wait child did not read all 32 initial task files; probeOutput: ${probeOutput}`,
    );

    assert.equal(handle.child.exitCode, null);

    const updatedHashes31 = new Map<string, string>();
    for (let i = 0; i < 31; i++) {
      const t = tasks[i]!;
      t.record.status = 'completed';
      t.record.completedAt = new Date().toISOString();
      appendMessage(t.record, 'final', 'agy-reported', `PRIVATE_FINAL_${i}`);
      f.state.save(t);
      const content = fs.readFileSync(path.join(f.directory, `${t.record.taskId}.json`));
      updatedHashes31.set(
        `${t.record.taskId}.json`,
        createHash('sha256').update(content).digest('hex'),
      );
    }

    const all31NewHashesRead = () => {
      const lines = new Set(probeOutput.split(/\r?\n/));
      for (const [filename, hash] of updatedHashes31) {
        if (!lines.has(`READ ${filename} ${hash}`)) return false;
      }
      return true;
    };

    await waitForCondition(
      all31NewHashesRead,
      30_000,
      () => `Wait child did not observe updated hashes for 31 completed tasks; probeOutput: ${probeOutput}`,
    );

    appendMessage(tasks[31]!.record, 'message', 'agy-reported', 'PRIVATE_STILL_RUNNING_31');
    f.state.save(tasks[31]!);
    const task32RunningHash = createHash('sha256')
      .update(fs.readFileSync(path.join(f.directory, `${tasks[31]!.record.taskId}.json`)))
      .digest('hex');

    await waitForCondition(
      () => probeOutput.split(/\r?\n/).includes(`READ ${tasks[31]!.record.taskId}.json ${task32RunningHash}`),
      30_000,
      () => `Wait child did not observe running update for 32nd task; probeOutput: ${probeOutput}`,
    );

    assert.equal(handle.child.exitCode, null, 'Wait child exited prematurely when only 31 of 32 tasks completed');
    assert.equal(handle.child.signalCode, null);

    tasks[31]!.record.status = 'completed';
    tasks[31]!.record.completedAt = new Date().toISOString();
    appendMessage(tasks[31]!.record, 'final', 'agy-reported', 'PRIVATE_FINAL_31');
    f.state.save(tasks[31]!);

    const result = await finishWait(handle, { readProbe: true });
    assert.equal(result.code, 0);
    assert.equal(result.json.outcome, 'completed');
    assert.equal(result.json.exitCode, 0);
    assert.equal(result.json.status, null);
    assert.equal(result.json.reason, null);
    assert.equal(result.json.groupId, null);
    assert.equal(result.json.groupState, null);
    assert.equal(result.json.taskId, null);
    assert.equal(result.json.targets.length, 32);

    for (let i = 0; i < 32; i++) {
      const expectedTask = tasks[i]!;
      const target = result.json.targets[i]!;
      assert.equal(target.taskId, expectedTask.record.taskId);
      assert.equal(target.status, 'completed');
      assert.equal(target.after, 0);
      assert.equal(target.resumeAfter, 0);
      assert.equal(target.cursor, expectedTask.record.messageCursor ?? 0);
    }
  } finally {
    f.close();
  }
});

test('state directory files remain byte- and mtime-identical after multi and group waits and under concurrent group writes', async () => {
  const f = stateFixture();
  try {
    const task1 = f.makeStored('completed');
    const task2 = f.makeStored('running');
    appendMessage(task2.record, 'question', 'agy-reported', 'PRIVATE_READONLY_QUESTION');
    f.state.save(task1);
    f.state.save(task2);
    const group = f.saveGroup(
      f.makeGroup(
        [
          { key: 'node-a', state: 'completed', taskId: task1.record.taskId },
          { key: 'node-b', dependsOn: ['node-a'], state: 'running', taskId: task2.record.taskId },
        ],
        'running',
        { ownerPid: process.pid },
      ),
    );

    const before = snapshotDirectory(f.directory);
    assert.equal(before.length, 3);

    assert.equal((await runWaitArgs(['--state-directory', f.directory, task1.record.taskId, task2.record.taskId, '--timeout', '5'])).code, 5);
    assert.deepEqual(snapshotDirectory(f.directory), before);

    assert.equal((await runWaitArgs(['--state-directory', f.directory, `${task1.record.taskId}:0`, `${task2.record.taskId}:1`, '--timeout', '1'])).code, 8);
    assert.deepEqual(snapshotDirectory(f.directory), before);

    assert.equal((await runWaitArgs(['--state-directory', f.directory, '--group', group.groupId, '--timeout', '5'])).code, 5);
    assert.deepEqual(snapshotDirectory(f.directory), before);

    assert.equal((await runWaitArgs(['--state-directory', f.directory, '--group', randomUUID(), '--timeout', '5'])).code, 10);
    assert.deepEqual(snapshotDirectory(f.directory), before);
  } finally {
    f.close();
  }

  const cf = stateFixture();
  try {
    const writerTaskA = cf.makeStored('running');
    const writerTaskB = cf.makeStored('running');
    cf.state.save(writerTaskA);
    cf.state.save(writerTaskB);
    let writerGroup = cf.saveGroup(
      cf.makeGroup(
        [
          { key: 'node-a', state: 'running', taskId: writerTaskA.record.taskId },
          { key: 'node-b', dependsOn: ['node-a'], state: 'pending' },
        ],
        'running',
        { ownerPid: process.pid },
      ),
    );

    const groupFile = `group-${writerGroup.groupId}.json`;
    const handle = startCommand(process.execPath, [
      '--import',
      readProbe,
      entry,
      'wait',
      '--state-directory',
      cf.directory,
      '--group',
      writerGroup.groupId,
      '--timeout',
      '60',
    ]);
    let probeOutput = '';
    handle.child.stderr.on('data', (chunk: string) => { probeOutput += chunk; });
    const groupReadPrefix = `READ ${groupFile} `;
    const groupReadHashes = () =>
      probeOutput
        .split(/\r?\n/)
        .filter(line => line.startsWith(groupReadPrefix))
        .map(line => line.slice(groupReadPrefix.length))
        .filter(hash => /^[0-9a-f]{64}$/.test(hash));
    const loopGroupHashes = new Set<string>();
    let writes = 0;
    let writesAtConcurrentRead: number | undefined;
    let startedAt = performance.now();
    // replaceStateFile already retries transient Windows sharing errors, so any error here is a real failure.
    try {
      await waitForCondition(() => groupReadHashes().length > 0, 30_000, () => `wait child never read ${groupFile}; stderr: ${probeOutput}`);
      startedAt = performance.now();
      while (performance.now() - startedAt < 2000 || writes < 40 || writesAtConcurrentRead === undefined || writes <= writesAtConcurrentRead) {
        assert.ok(
          performance.now() - startedAt < 30_000,
          `Concurrent writer stalled after ${writes} writes (writesAtConcurrentRead=${writesAtConcurrentRead}); stderr: ${probeOutput}`,
        );
        await delay(5);
        appendMessage(writerTaskA.record, 'message', 'agy-reported', `PRIVATE_CONCURRENT_A_${writes}`);
        cf.state.save(writerTaskA);
        if (writes === 20) {
          writerTaskA.record.status = 'completed';
          writerTaskA.record.completedAt = new Date().toISOString();
          cf.state.save(writerTaskA);
          writerGroup.nodes['node-a'] = { state: 'completed', taskId: writerTaskA.record.taskId };
          writerGroup.nodes['node-b'] = { state: 'running', taskId: writerTaskB.record.taskId };
        }
        if (writes >= 20) {
          appendMessage(writerTaskB.record, 'message', 'agy-reported', `PRIVATE_CONCURRENT_B_${writes}`);
          cf.state.save(writerTaskB);
        }
        writerGroup = cf.saveGroup(writerGroup);
        loopGroupHashes.add(createHash('sha256').update(fs.readFileSync(path.join(cf.directory, groupFile))).digest('hex'));
        writes++;
        if (writesAtConcurrentRead === undefined && groupReadHashes().some(hash => loopGroupHashes.has(hash))) {
          writesAtConcurrentRead = writes;
        }
      }

      writerTaskB.record.status = 'completed';
      writerTaskB.record.completedAt = new Date().toISOString();
      appendMessage(writerTaskB.record, 'final', 'agy-reported', 'PRIVATE_FINAL_CONCURRENT_B');
      cf.state.save(writerTaskB);
      writerGroup.nodes['node-b'] = { state: 'completed', taskId: writerTaskB.record.taskId };
      writerGroup.state = 'completed';
      writerGroup = cf.saveGroup(writerGroup);
    } catch (error) {
      handle.child.kill();
      throw error;
    }

    const expectedFiles = [
      `${writerTaskA.record.taskId}.json`,
      `${writerTaskB.record.taskId}.json`,
      `group-${writerGroup.groupId}.json`,
    ].sort();
    const lastBytes = new Map(expectedFiles.map(name => [name, fs.readFileSync(path.join(cf.directory, name))]));

    const result = await finishWait(handle, { readProbe: true });
    assert.ok(writes >= 40, `Expected at least 40 concurrent writes, got ${writes}`);
    assert.equal(result.code, 0);
    assert.equal(result.json.outcome, 'completed');
    assert.equal(result.json.groupState, 'completed');
    assert.deepEqual(fs.readdirSync(cf.directory).sort(), expectedFiles);
    for (const [name, bytes] of lastBytes) {
      assert.deepEqual(fs.readFileSync(path.join(cf.directory, name)), bytes);
    }
  } finally {
    cf.close();
  }
});
