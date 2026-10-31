import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { loadConfig, type Config } from '../src/config.js';
import { discardProjectCopy } from '../src/isolation.js';
import { createMcpServer } from '../src/mcp-server.js';
import { appendMessage, readMessages } from '../src/messages.js';
import { StateStore, type StoredTask } from '../src/state-store.js';
import { TaskManager } from '../src/task-manager.js';
import type { RunOptions, TaskStatus } from '../src/types.js';
import { WAIT_EXIT_CODES, shellCommand, waitCommandArgv, waitCommandInfo, type WaitOutcome } from '../src/wait-command.js';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

interface WaitOutput {
  taskId: string | null;
  outcome: WaitOutcome;
  exitCode: number;
  status: TaskStatus | null;
  reason: string | null;
  after: number;
  cursor: number | null;
  continuationTaskId?: string;
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

function startWait(dir: string, taskId: string, extra: readonly string[] = []) {
  return startWaitArgs(['--state-directory', dir, taskId, ...extra]);
}

async function finishWait(handle: ReturnType<typeof startWaitArgs>) {
  const outcome = await handle.done;
  assert.equal(outcome.stderr, '');
  const trimmed = outcome.stdout.replace(/\r?\n$/, '');
  const lines = trimmed === '' ? [] : trimmed.split(/\r?\n/);
  assert.equal(lines.length, 1, `Expected exactly one stdout line, got: ${JSON.stringify(outcome.stdout)}`);
  const json = JSON.parse(lines[0]!) as WaitOutput;
  return { code: outcome.code, stdout: outcome.stdout, exitedAt: outcome.exitedAt, json };
}

function runWait(dir: string, taskId: string, extra: readonly string[] = []) {
  return finishWait(startWait(dir, taskId, extra));
}

function runWaitArgs(waitArgs: readonly string[]) {
  return finishWait(startWaitArgs(waitArgs));
}

function stateFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wait-command-test-'));
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
  return {
    directory,
    state,
    makeStored,
    close() {
      killRemainingChildren();
      const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
      assert.ok(relative && !relative.startsWith('..') && !relative.includes(path.sep) && relative.startsWith('agy-wait-command-test-'));
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

class HoldAdapter extends CliAdapter {
  private released = false;
  private releaseCurrent?: () => void;
  constructor(config: Config) { super(config); }
  override async listModels() { return []; }
  release(): void {
    this.released = true;
    this.releaseCurrent?.();
  }
  override spawnTask(_options: RunOptions, _model: string | undefined, _cwd: string): ChildProcessWithoutNullStreams {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      pid: undefined,
      exitCode: null as number | null,
      killed: false,
      kill: (_signal?: string) => {
        if (child.exitCode === null) {
          child.exitCode = 0;
          child.killed = true;
          child.emit('close', 0);
        }
        return true;
      },
    });
    const emit = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
    queueMicrotask(() => {
      emit({ event: 'init', conversation_id: 'controlled-conversation' });
    });
    this.releaseCurrent = () => {
      if (child.exitCode !== null) return;
      emit({
        event: 'result',
        result: {
          conversation_id: 'controlled-conversation',
          status: 'SUCCESS',
          response: 'PRIVATE_RESPONSE_TEXT',
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        },
      });
      child.exitCode = 0;
      child.emit('close', 0);
    };
    if (this.released) {
      queueMicrotask(() => {
        this.releaseCurrent?.();
      });
    }
    return child as unknown as ChildProcessWithoutNullStreams;
  }
}

async function managerFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-wait-command-test-'));
  const source = path.join(dir, 'source');
  execFileSync('git', ['init', '--quiet', source]);
  await writeFile(path.join(source, 'source.txt'), 'Public fixture\n');
  const config = loadConfig({
    BRIDGE_ANTI_AI_CRAFT: 'off',
    BRIDGE_STATE_DIRECTORY: path.join(dir, 'state'),
    BRIDGE_TEST_EXECUTOR: 'agy',
  });
  const adapter = new HoldAdapter(config);
  const tasks = new TaskManager(adapter, config);
  return {
    dir,
    source,
    config,
    adapter,
    tasks,
    async close() {
      killRemainingChildren();
      await tasks.shutdown();
      for (const project of new Map(
        new StateStore(config.stateDirectory).load().filter(t => t.project).map(t => [t.project!.copyDirectory, t.project!]),
      ).values()) {
        await discardProjectCopy(project);
      }
      const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(dir));
      assert.ok(relative && !relative.startsWith('..') && !relative.includes(path.sep) && relative.startsWith('agy-wait-command-test-'));
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

test('already terminal tasks exit immediately with exact JSON fields and without leaking text', async () => {
  const f = stateFixture();
  try {
    const cases: Array<{
      status: 'completed' | 'failed' | 'cancelled' | 'timeout';
      errorCode?: string;
      expectedCode: number;
      expectedReason: string | null;
    }> = [
      { status: 'completed', expectedCode: 0, expectedReason: null },
      { status: 'failed', errorCode: 'AGY_FAILED', expectedCode: 2, expectedReason: 'AGY_FAILED' },
      { status: 'failed', errorCode: 'bad code PRIVATE_CODE_TEXT', expectedCode: 2, expectedReason: null },
      { status: 'cancelled', errorCode: 'TASK_CANCELLED', expectedCode: 3, expectedReason: null },
      { status: 'timeout', errorCode: 'TASK_TIMEOUT', expectedCode: 4, expectedReason: null },
    ];
    for (const item of cases) {
      const stored = f.makeStored(item.status);
      appendMessage(stored.record, 'message', 'agy-reported', 'PRIVATE_MESSAGE_TEXT');
      if (item.errorCode) {
        stored.record.error = { code: item.errorCode, message: 'PRIVATE_ERROR_TEXT' };
      }
      f.state.save(stored);
      const startedAt = performance.now();
      const result = await runWait(f.directory, stored.record.taskId, ['--timeout', '30']);
      const elapsed = result.exitedAt - startedAt;
      assert.ok(elapsed < 3000, `Expected ${item.status} to exit in < 3000ms, got ${elapsed}ms`);
      assert.equal(result.code, item.expectedCode);
      assert.deepEqual(result.json, {
        taskId: stored.record.taskId,
        outcome: item.status,
        exitCode: item.expectedCode,
        status: item.status,
        reason: item.expectedReason,
        after: 0,
        cursor: 1,
      });
      assert.equal(result.stdout.includes('PRIVATE_PROMPT_TEXT'), false);
      assert.equal(result.stdout.includes('PRIVATE_MESSAGE_TEXT'), false);
      assert.equal(result.stdout.includes('PRIVATE_ERROR_TEXT'), false);
      assert.equal(result.stdout.includes('PRIVATE_CODE_TEXT'), false);
    }
  } finally {
    f.close();
  }
});

test('shell command quotes every argument exactly on every platform', () => {
  assert.equal(shellCommand(['/a b/node', "/c'd/server.mjs", 'wait']), "'/a b/node' '/c'\\''d/server.mjs' 'wait'");
  const prefix = ['/a b/node', "/c'd/server.mjs", 'wait', '--state-directory', "/tmp/state 'dir'"];
  const id = randomUUID();
  assert.equal(waitCommandInfo(prefix, id).sh, shellCommand(waitCommandInfo(prefix, id).argv));
  assert.equal(waitCommandInfo(prefix, id).argv.at(-1), id);
});

test('a question after a full page of ordinary messages is readable from cursor minus one', async () => {
  const f = stateFixture();
  try {
    const stored = f.makeStored('running');
    const id = stored.record.taskId;
    for (let i = 0; i < 25; i++) {
      appendMessage(stored.record, 'message', 'agy-reported', 'PRIVATE_MESSAGE_TEXT');
    }
    appendMessage(stored.record, 'question', 'agy-reported', 'PRIVATE_QUESTION_TEXT');
    f.state.save(stored);

    const { code, json } = await runWait(f.directory, id, ['--timeout', '30']);
    assert.equal(code, 5);
    assert.equal(json.outcome, 'question');
    assert.equal(json.cursor, 26);
    assert.equal(json.after, 0);
    if (json.cursor === null) assert.fail('Expected numeric cursor');

    assert.equal(readMessages(stored.record, 0).messages.length, 25);
    assert.equal(readMessages(stored.record, 0).messages.some(m => m.kind === 'question'), false);
    const questionMessage = readMessages(stored.record, json.cursor - 1).messages[0];
    assert.equal(questionMessage?.sequence, 26);
    assert.equal(questionMessage?.kind, 'question');
  } finally {
    f.close();
  }
});

test('question, blocker and completion transitions exit within 5 seconds at p95', async () => {
  const f = stateFixture();
  try {
    const kinds: Array<{
      kind: 'question' | 'blocker' | 'completion';
      expectedCode: number;
      expectedOutcome: WaitOutcome;
      expectedStatus: TaskStatus;
    }> = [
      { kind: 'question', expectedCode: 5, expectedOutcome: 'question', expectedStatus: 'running' },
      { kind: 'blocker', expectedCode: 6, expectedOutcome: 'blocker', expectedStatus: 'running' },
      { kind: 'completion', expectedCode: 0, expectedOutcome: 'completed', expectedStatus: 'completed' },
    ];
    for (const spec of kinds) {
      const latencies: number[] = [];
      for (let i = 0; i < 5; i++) {
        const stored = f.makeStored('running');
        f.state.save(stored);
        const handle = startWait(f.directory, stored.record.taskId, ['--timeout', '60']);
        await delay(700);
        assert.equal(handle.child.exitCode, null);
        assert.equal(handle.child.signalCode, null);
        const t0 = performance.now();
        let expectedCursor: number;
        if (spec.kind === 'question' || spec.kind === 'blocker') {
          const msg = appendMessage(stored.record, spec.kind, 'agy-reported', `PRIVATE_${spec.kind.toUpperCase()}_TEXT`);
          expectedCursor = msg.sequence;
        } else {
          stored.record.status = 'completed';
          stored.record.completedAt = new Date().toISOString();
          const msg = appendMessage(stored.record, 'final', 'agy-reported', 'PRIVATE_FINAL_TEXT');
          expectedCursor = msg.sequence;
        }
        f.state.save(stored);
        const result = await finishWait(handle);
        latencies.push(result.exitedAt - t0);
        assert.equal(result.code, spec.expectedCode);
        assert.deepEqual(result.json, {
          taskId: stored.record.taskId,
          outcome: spec.expectedOutcome,
          exitCode: spec.expectedCode,
          status: spec.expectedStatus,
          reason: null,
          after: 0,
          cursor: expectedCursor,
        });
        assert.equal(result.stdout.includes('PRIVATE_'), false);
      }
      const sorted = [...latencies].sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]!;
      assert.ok(p95 <= 5000, `Expected ${spec.kind} p95 <= 5000ms, got ${p95}ms`);
    }
  } finally {
    f.close();
  }
});

test('--after skips already consumed messages and wakes on a newer blocker', async () => {
  const f = stateFixture();
  try {
    const stored = f.makeStored('running');
    const first = appendMessage(stored.record, 'question', 'agy-reported', 'PRIVATE_QUESTION_1');
    assert.equal(first.sequence, 1);
    f.state.save(stored);

    const deadlineResult = await runWait(f.directory, stored.record.taskId, ['--after', '1', '--timeout', '1']);
    assert.equal(deadlineResult.code, 8);
    assert.deepEqual(deadlineResult.json, {
      taskId: stored.record.taskId,
      outcome: 'wait-deadline',
      exitCode: 8,
      status: 'running',
      reason: 'WAIT_DEADLINE',
      after: 1,
      cursor: 1,
    });

    const handle = startWait(f.directory, stored.record.taskId, ['--after', '1', '--timeout', '30']);
    await delay(700);
    assert.equal(handle.child.exitCode, null);
    const second = appendMessage(stored.record, 'blocker', 'agy-reported', 'PRIVATE_BLOCKER_2');
    assert.equal(second.sequence, 2);
    f.state.save(stored);

    const blockerResult = await finishWait(handle);
    assert.equal(blockerResult.code, 6);
    assert.deepEqual(blockerResult.json, {
      taskId: stored.record.taskId,
      outcome: 'blocker',
      exitCode: 6,
      status: 'running',
      reason: null,
      after: 1,
      cursor: 2,
    });
  } finally {
    f.close();
  }
});

test('unknown tasks and wait deadlines return distinct dedicated exit codes', async () => {
  const f = stateFixture();
  try {
    const exitValues = Object.values(WAIT_EXIT_CODES);
    assert.equal(new Set(exitValues).size, exitValues.length);

    const missingTaskId = randomUUID();
    const missingTask = await runWait(f.directory, missingTaskId, ['--timeout', '5']);
    assert.equal(missingTask.code, 7);
    assert.deepEqual(missingTask.json, {
      taskId: missingTaskId,
      outcome: 'unknown-task',
      exitCode: 7,
      status: null,
      reason: 'TASK_NOT_FOUND',
      after: 0,
      cursor: null,
    });

    const missingDir = path.join(f.directory, 'nonexistent-state-dir');
    const missingDirResult = await runWait(missingDir, missingTaskId, ['--timeout', '5']);
    assert.equal(missingDirResult.code, 7);
    assert.equal(missingDirResult.json.outcome, 'unknown-task');
    assert.equal(missingDirResult.json.reason, 'TASK_NOT_FOUND');
    assert.equal(fs.existsSync(missingDir), false);

    const running = f.makeStored('running');
    f.state.save(running);
    const startedAt = performance.now();
    const deadlineResult = await runWait(f.directory, running.record.taskId, ['--timeout', '1']);
    const elapsed = deadlineResult.exitedAt - startedAt;
    assert.equal(deadlineResult.code, 8);
    assert.equal(deadlineResult.json.outcome, 'wait-deadline');
    assert.equal(deadlineResult.json.reason, 'WAIT_DEADLINE');
    assert.ok(elapsed >= 1000 && elapsed < 5000, `Expected deadline elapsed in [1000, 5000) ms, got ${elapsed}ms`);
  } finally {
    f.close();
  }
});

test('stopped owner, corrupt state and invalid arguments return their respective codes', async () => {
  const f = stateFixture();
  try {
    const exitedChild = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    assert.ok(exitedChild.pid && exitedChild.pid > 0);
    const stoppedTask = f.makeStored('running', exitedChild.pid);
    f.state.save(stoppedTask);
    const stoppedResult = await runWait(f.directory, stoppedTask.record.taskId, ['--timeout', '10']);
    assert.equal(stoppedResult.code, 9);
    assert.equal(stoppedResult.json.outcome, 'owner-stopped');
    assert.equal(stoppedResult.json.reason, 'OWNER_STOPPED');

    const invalidStateId = randomUUID();
    fs.writeFileSync(path.join(f.directory, `${invalidStateId}.json`), '{broken-json', 'utf8');
    const invalidStateResult = await runWait(f.directory, invalidStateId, ['--timeout', '10']);
    assert.equal(invalidStateResult.code, 1);
    assert.equal(invalidStateResult.json.outcome, 'error');
    assert.equal(invalidStateResult.json.reason, 'INVALID_STATE');

    const validId = randomUUID();
    const invalidArgCases: Array<{ args: string[]; reason: string }> = [
      { args: ['--state-directory', f.directory], reason: 'INVALID_ARGUMENTS' },
      { args: ['--state-directory', f.directory, validId, '--timeout', '0'], reason: 'INVALID_ARGUMENTS' },
      { args: ['--state-directory', f.directory, validId, '--timeout', '86401'], reason: 'INVALID_ARGUMENTS' },
      { args: ['--state-directory', f.directory, validId, '--after', '-1'], reason: 'INVALID_ARGUMENTS' },
      { args: ['--state-directory', 'relative-state-dir', validId], reason: 'INVALID_STATE_DIRECTORY' },
      ...(process.platform === 'win32' ? [
        { args: ['--state-directory', '\\root-relative-state-dir', validId], reason: 'INVALID_STATE_DIRECTORY' },
        { args: ['--state-directory', 'C:drive-relative-state-dir', validId], reason: 'INVALID_STATE_DIRECTORY' },
      ] : []),
    ];
    for (const item of invalidArgCases) {
      const res = await runWaitArgs(item.args);
      assert.equal(res.code, 1);
      assert.equal(res.json.outcome, 'error');
      assert.equal(res.json.reason, item.reason);
    }
  } finally {
    f.close();
  }
});

test('state directory files remain byte-for-byte and mtime-identical before and after wait executions', async () => {
  const f = stateFixture();
  try {
    const terminalTask = f.makeStored('completed');
    const questionTask = f.makeStored('running');
    appendMessage(questionTask.record, 'question', 'agy-reported', 'PRIVATE_QUESTION_SNAPSHOT');
    const runningTask = f.makeStored('running');
    f.state.save(terminalTask);
    f.state.save(questionTask);
    f.state.save(runningTask);

    const before = snapshotDirectory(f.directory);
    assert.equal(before.length, 3);

    assert.equal((await runWait(f.directory, terminalTask.record.taskId, ['--timeout', '5'])).code, 0);
    assert.deepEqual(snapshotDirectory(f.directory), before);

    assert.equal((await runWait(f.directory, questionTask.record.taskId, ['--timeout', '5'])).code, 5);
    assert.deepEqual(snapshotDirectory(f.directory), before);

    assert.equal((await runWait(f.directory, randomUUID(), ['--timeout', '5'])).code, 7);
    assert.deepEqual(snapshotDirectory(f.directory), before);

    assert.equal((await runWait(f.directory, runningTask.record.taskId, ['--timeout', '1'])).code, 8);
    assert.deepEqual(snapshotDirectory(f.directory), before);
  } finally {
    f.close();
  }
});

test('concurrent state writes complete without errors and wait exits cleanly when completed', async () => {
  const f = stateFixture();
  try {
    const stored = f.makeStored('running');
    f.state.save(stored);
    const handle = startWait(f.directory, stored.record.taskId, ['--timeout', '60']);

    const errors: unknown[] = [];
    let saves = 0;
    const startedAt = performance.now();
    while (performance.now() - startedAt < 2000 || saves < 50) {
      await delay(5);
      appendMessage(stored.record, 'message', 'agy-reported', `PRIVATE_CONCURRENT_${saves}`);
      try {
        f.state.save(stored);
        saves++;
      } catch (error) {
        errors.push(error);
      }
    }

    stored.record.status = 'completed';
    stored.record.completedAt = new Date().toISOString();
    appendMessage(stored.record, 'final', 'agy-reported', 'PRIVATE_FINAL_CONCURRENT');
    try {
      f.state.save(stored);
    } catch (error) {
      errors.push(error);
    }
    const targetFile = path.join(f.directory, `${stored.record.taskId}.json`);
    const bytesAfterLastSave = fs.readFileSync(targetFile);

    const result = await finishWait(handle);
    assert.deepEqual(errors, []);
    assert.ok(saves >= 50, `Expected at least 50 saves, got ${saves}`);
    assert.equal(result.code, 0);
    assert.equal(result.json.outcome, 'completed');
    assert.deepEqual(fs.readdirSync(f.directory), [`${stored.record.taskId}.json`]);
    assert.deepEqual(fs.readFileSync(targetFile), bytesAfterLastSave);
  } finally {
    f.close();
  }
});

test('killing the wait command process does not cancel or stop the running task', async () => {
  const f = await managerFixture();
  try {
    const task = await f.tasks.run({
      prompt: 'Hold until released',
      workingDirectory: f.source,
      mode: 'read-only',
      deliveryMode: 'messages',
    });
    const runDeadline = performance.now() + 30_000;
    while (!['running', 'streaming'].includes(f.tasks.status(task.taskId).status)) {
      assert.ok(performance.now() < runDeadline, 'Timed out waiting for task to start running');
      await delay(50);
    }
    const handle = startWait(f.config.stateDirectory, task.taskId, ['--timeout', '60']);
    await delay(700);
    assert.equal(handle.child.exitCode, null);

    handle.child.kill();
    await handle.done;

    const activeStatus = f.tasks.status(task.taskId).status;
    assert.notEqual(activeStatus, 'cancelled');
    assert.equal(['completed', 'failed', 'cancelled', 'timeout'].includes(activeStatus), false);
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(f.config.stateDirectory, `${task.taskId}.json`), 'utf8'),
    ) as StoredTask;
    assert.equal(['completed', 'failed', 'cancelled', 'timeout'].includes(snapshot.record.status), false);

    f.adapter.release();
    const waited = await f.tasks.wait(task.taskId, 0, 10);
    assert.equal(waited.ready, true);
    assert.equal(f.tasks.status(task.taskId).status, 'completed');

    const secondWait = await runWait(f.config.stateDirectory, task.taskId, ['--timeout', '10']);
    assert.equal(secondWait.code, 0);
    assert.equal(secondWait.json.outcome, 'completed');
    assert.equal(secondWait.json.status, 'completed');
  } finally {
    await f.close();
  }
});

test('MCP server exposes exact build waitCommand in health and run', async () => {
  const f = await managerFixture();
  let server: ReturnType<typeof createMcpServer> | undefined;
  let client: Client | undefined;
  try {
    const prefix = waitCommandArgv(f.config.stateDirectory, entry);
    assert.ok(prefix);
    server = createMcpServer(f.adapter, f.tasks, { waitCommand: prefix });
    client = new Client({ name: 'wait-command-mcp-test', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const healthRes = await client.callTool({ name: 'antigravity_health', arguments: {} });
    assert.equal(healthRes.isError, undefined, JSON.stringify(healthRes.structuredContent));
    const healthContent = healthRes.structuredContent as { waitCommand: { argv: string[]; sh: string } };
    const expectedPrefix = [process.execPath, entry, 'wait', '--state-directory', f.config.stateDirectory];
    assert.deepEqual(healthContent.waitCommand.argv, expectedPrefix);
    assert.equal(healthContent.waitCommand.sh, shellCommand(expectedPrefix));

    const runRes = await client.callTool({
      name: 'antigravity_run',
      arguments: {
        prompt: 'MCP waitCommand execution test',
        workingDirectory: f.source,
        mode: 'read-only',
        deliveryMode: 'messages',
      },
    });
    assert.equal(runRes.isError, undefined, JSON.stringify(runRes.structuredContent));
    const runContent = runRes.structuredContent as {
      task: { taskId: string };
      waitCommand: { argv: string[]; sh: string };
    };
    const expectedRunArgv = [...expectedPrefix, runContent.task.taskId];
    assert.deepEqual(runContent.waitCommand.argv, expectedRunArgv);
    assert.equal(runContent.waitCommand.sh, shellCommand(expectedRunArgv));

    const handle = startCommand(runContent.waitCommand.argv[0]!, [...runContent.waitCommand.argv.slice(1), '--timeout', '60']);
    f.adapter.release();
    const waitRes = await finishWait(handle);
    assert.equal(waitRes.code, 0);
    assert.equal(waitRes.json.taskId, runContent.task.taskId);
    assert.equal(waitRes.json.outcome, 'completed');
    assert.equal(waitRes.json.status, 'completed');

    const specialPrefix = ['/usr/bin/node', entry, 'wait', '--state-directory', "/tmp/dir with 'single quotes' and spaces"];
    const specialTaskId = randomUUID();
    const info = waitCommandInfo(specialPrefix, specialTaskId);
    assert.deepEqual(info.argv, [...specialPrefix, specialTaskId]);
    if (process.platform !== 'win32') {
      const splitCheck = spawnSync('sh', ['-c', `for a in ${info.sh}; do printf '%s\\n' "$a"; done`], { encoding: 'utf8' });
      assert.equal(splitCheck.status, 0, splitCheck.stderr);
      assert.deepEqual(splitCheck.stdout.replace(/\n$/, '').split('\n'), info.argv);
    }
  } finally {
    await client?.close();
    await server?.close();
    await f.close();
  }
});
