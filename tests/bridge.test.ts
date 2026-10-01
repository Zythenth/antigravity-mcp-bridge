import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CliAdapter } from '../src/cli-adapter.js';
import { loadConfig } from '../src/config.js';
import { EventStore } from '../src/event-store.js';
import { LineParser } from '../src/stream-parser.js';
import { TaskManager } from '../src/task-manager.js';
import type { TaskRecord } from '../src/types.js';

const mockPath = fileURLToPath(new URL('../../tests/mock-agy.mjs', import.meta.url));

function setup(prefixArgs = [mockPath], configOverrides: Record<string, string> = {}) {
  const config = loadConfig({ AGY_PATH: process.execPath, DEFAULT_TIMEOUT_SECONDS: '2', ...configOverrides });
  const adapter = new CliAdapter(config, prefixArgs);
  return { adapter, tasks: new TaskManager(adapter, config) };
}

async function until(tasks: TaskManager, taskId: string, predicate: (record: TaskRecord) => boolean, timeout = 5000): Promise<TaskRecord> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const task = tasks.status(taskId);
    if (predicate(task)) return task;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for task: ${JSON.stringify(tasks.status(taskId))}`);
}

const done = (task: TaskRecord) => ['completed', 'failed', 'cancelled', 'timeout'].includes(task.status);

test('discovery distinguishes missing executable and authentication', async () => {
  const missing = new CliAdapter(loadConfig({ AGY_PATH: path.join(os.tmpdir(), 'absent-agy-executable') }));
  assert.equal((await missing.discover()).installed, false);
  const { adapter } = setup([mockPath, 'auth']);
  const health = await adapter.health();
  assert.equal(health.installed, true);
  assert.equal(health.authenticated, false);
  await assert.rejects(adapter.listModels(), { code: 'AGY_AUTH_REQUIRED' });
});

test('models come from CLI and invalid model is rejected', async () => {
  const { adapter, tasks } = setup();
  await adapter.discover();
  assert.deepEqual((await adapter.listModels()).map(item => item.id), ['mock-pro', 'mock-flash']);
  await assert.rejects(tasks.setModel('bad;echo injected'), { code: 'MODEL_NOT_AVAILABLE' });
  assert.equal(await tasks.setModel('mock-pro'), 'mock-pro');
  assert.equal(tasks.getModel(), 'mock-pro');
});

test('parser handles split UTF-8, multiple events and trailing lines', () => {
  const lines: string[] = [];
  const parser = new LineParser(line => lines.push(line));
  const bytes = Buffer.from('Olá\nsecond\nthird');
  parser.write(bytes.subarray(0, 3));
  parser.write(bytes.subarray(3, 10));
  parser.write(bytes.subarray(10));
  parser.end();
  assert.deepEqual(lines, ['Olá', 'second', 'third']);
});

test('event store enforces a global bound and reports lost cursors', () => {
  const store = new EventStore(2);
  store.append('a', 'first', {});
  store.append('b', 'other', {});
  store.append('a', 'last', {});
  const page = store.read('a', 0);
  assert.deepEqual(page.events.map(event => event.sequence), [2]);
  assert.equal(page.truncated, true);
  assert.equal(page.oldestAvailable, 2);
});

test('run streams official event shapes and captures result, stderr and malformed lines', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-bridge-test-'));
  try {
    const { adapter, tasks } = setup();
    await adapter.discover();
    const first = await tasks.run({ prompt: 'split: $() `echo injected`', workingDirectory: dir, model: 'mock-pro' });
    const final = await until(tasks, first.taskId, done);
    assert.equal(final.status, 'completed');
    assert.equal(final.sessionId, 'mock-conversation');
    assert.equal((final.result as { response: string }).response, 'split: $() `echo injected`');
    const events = tasks.readEvents(first.taskId).events;
    assert.ok(events.some(event => event.type === 'response.chunk' && (event.data as { text_delta: string }).text_delta === 'Olá'));
    assert.ok(events.some(event => event.type === 'tool.started'));
    assert.ok(events.some(event => event.type === 'tool.completed'));
    assert.equal(events.at(-1)?.type, 'task.completed');
    const after = tasks.readEvents(first.taskId, events[2]!.sequence);
    assert.ok(after.events.every(event => event.sequence > events[2]!.sequence));
    const second = await tasks.run({ prompt: 'malformed:test', workingDirectory: dir });
    await until(tasks, second.taskId, done);
    assert.ok(tasks.readEvents(second.taskId).events.some(event => event.type === 'stream.unparsed'));
    const third = await tasks.run({ prompt: 'stderr:test', workingDirectory: dir });
    await until(tasks, third.taskId, done);
    assert.ok(tasks.readEvents(third.taskId).events.some(event => event.type === 'process.stderr'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failure, timeout, cancellation, queue and concurrency', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-bridge-test-'));
  try {
    const { adapter, tasks } = setup([mockPath], { MAX_CONCURRENT_TASKS: '1', MAX_QUEUED_TASKS: '1' });
    await adapter.discover();
    const failure = await tasks.run({ prompt: 'failure:test', workingDirectory: dir });
    assert.equal((await until(tasks, failure.taskId, done)).status, 'failed');
    const crash = await tasks.run({ prompt: 'crash:test', workingDirectory: dir });
    assert.equal((await until(tasks, crash.taskId, done)).status, 'failed');
    const slow = await tasks.run({ prompt: 'slow:test', workingDirectory: dir });
    const queued = await tasks.run({ prompt: 'write:test', workingDirectory: dir });
    assert.equal(tasks.status(queued.taskId).status, 'queued');
    await assert.rejects(tasks.run({ prompt: 'extra:test', workingDirectory: dir }), { code: 'QUEUE_FULL' });
    await tasks.cancel(queued.taskId);
    assert.equal(tasks.status(queued.taskId).status, 'cancelled');
    assert.equal(tasks.status(queued.taskId).error?.code, 'TASK_CANCELLED');
    assert.equal((await until(tasks, slow.taskId, done)).status, 'completed');
    const timeout = await tasks.run({ prompt: 'timeout:test', workingDirectory: dir, timeoutSeconds: 1 });
    assert.equal((await until(tasks, timeout.taskId, done)).error?.code, 'TASK_TIMEOUT');
    const cancel = await tasks.run({ prompt: 'cancel:test', workingDirectory: dir });
    await until(tasks, cancel.taskId, task => Boolean(task.pid));
    await tasks.cancel(cancel.taskId);
    assert.equal((await until(tasks, cancel.taskId, done)).error?.code, 'TASK_CANCELLED');
    const write = await tasks.run({ prompt: 'write:test', workingDirectory: dir });
    assert.equal((await until(tasks, write.taskId, done)).status, 'completed');
    assert.equal(await readFile(path.join(dir, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'Antigravity MCP bridge test successful.');
    await tasks.shutdown();
    await assert.rejects(tasks.run({ prompt: 'after shutdown', workingDirectory: dir }), { code: 'AGY_PROCESS_FAILED' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('working directory and prompt validation', async () => {
  const { adapter, tasks } = setup();
  await adapter.discover();
  await assert.rejects(tasks.run({ prompt: 'hello', workingDirectory: 'relative/path' }), { code: 'INVALID_WORKING_DIRECTORY' });
  await assert.rejects(tasks.run({ prompt: 'hello', workingDirectory: path.join(os.tmpdir(), 'absent-directory-123') }), { code: 'INVALID_WORKING_DIRECTORY' });
  await assert.rejects(tasks.run({ prompt: '', workingDirectory: os.tmpdir() }), { code: 'INVALID_PROMPT' });
});

test('resume uses a known conversation and isolated worktree keeps the source clean', async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'agy-bridge-repo-'));
  let worktreePath: string | undefined;
  try {
    execFileSync('git', ['init', repository]);
    execFileSync('git', ['-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial']);
    const { adapter, tasks } = setup();
    await adapter.discover();
    const run = await tasks.run({ prompt: 'write:test', workingDirectory: repository, sessionId: 'prior-conversation', isolateWorktree: true });
    const final = await until(tasks, run.taskId, done);
    assert.equal(final.status, 'completed');
    assert.equal(final.sessionId, 'prior-conversation');
    worktreePath = final.worktreePath;
    assert.ok(worktreePath);
    assert.equal(await readFile(path.join(worktreePath, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'Antigravity MCP bridge test successful.');
    await assert.rejects(readFile(path.join(repository, 'AGY_BRIDGE_TEST.md'), 'utf8'), { code: 'ENOENT' });
  } finally {
    if (worktreePath) execFileSync('git', ['-C', repository, 'worktree', 'remove', '--force', worktreePath]);
    await rm(repository, { recursive: true, force: true });
  }
});
