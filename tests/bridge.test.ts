import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { createProjectCopy, discardProjectCopy, integrateProjectCopy, listProjectFiles, previewProjectCopy } from '../src/isolation.js';

const mockPath = fileURLToPath(new URL('../../tests/mock-agy.mjs', import.meta.url));

test('discard removes copy and baseline, refuses active shared copies, and is idempotent', async () => {
  const dir = await repository();
  const { adapter, tasks } = setup();
  try {
    await adapter.discover();
    const first = await tasks.run({ prompt: 'write:test', workingDirectory: dir });
    const finished = await until(tasks, first.taskId, done);
    const resumed = await tasks.run({ prompt: 'slow:test', workingDirectory: dir, sessionId: finished.sessionId });
    await assert.rejects(tasks.discard(first.taskId), { code: 'TASK_NOT_READY' });
    await assert.rejects(tasks.preview(first.taskId), { code: 'TASK_NOT_READY' });
    await until(tasks, resumed.taskId, done);
    await tasks.discard(first.taskId);
    assert.ok(tasks.status(resumed.taskId).discardedAt);
    await assert.rejects(readFile(path.join(finished.copyDirectory!, 'source.txt')), { code: 'ENOENT' });
    await assert.rejects(tasks.preview(resumed.taskId), { code: 'TASK_NOT_READY' });
    await assert.rejects(tasks.run({ prompt: 'resume', workingDirectory: dir, sessionId: finished.sessionId }), { code: 'INVALID_SESSION' });
    await tasks.discard(first.taskId);
    assert.equal(await readFile(path.join(dir, 'source.txt'), 'utf8'), 'source');
  } finally { await tasks.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test('cleanup expires only inactive copies and deletion rejects source paths', async () => {
  const dir = await repository();
  const { adapter, tasks } = setup();
  try {
    await adapter.discover();
    const first = await tasks.run({ prompt: 'test', workingDirectory: dir });
    const finished = await until(tasks, first.taskId, done);
    assert.deepEqual((await tasks.cleanup()).discardedTaskIds, []);
    const active = await tasks.run({ prompt: 'slow:test', workingDirectory: dir });
    const future = Date.parse(finished.completedAt!) + 168 * 3600000;
    assert.deepEqual((await tasks.cleanup(future)).discardedTaskIds, [first.taskId]);
    assert.equal(tasks.status(active.taskId).discardedAt, undefined);
    await until(tasks, active.taskId, done);
    await tasks.discard(active.taskId);
    const project = await createProjectCopy(dir);
    await assert.rejects(discardProjectCopy({ ...project, copyDirectory: dir }), { code: 'UNSAFE_PROJECT_PATH' });
    assert.equal(await readFile(path.join(dir, 'source.txt'), 'utf8'), 'source');
    await discardProjectCopy(project);
    await assert.rejects(readFile(path.join(project.gitDirectory, 'HEAD')), { code: 'ENOENT' });
  } finally { await tasks.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

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

async function repository(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-bridge-test-'));
  execFileSync('git', ['init', '--quiet', dir]);
  await writeFile(path.join(dir, 'source.txt'), 'source');
  return dir;
}

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
  const dir = await repository();
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
  const dir = await repository();
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
    const written = tasks.status(write.taskId).copyDirectory!;
    assert.equal(await readFile(path.join(written, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'Antigravity MCP bridge test successful.');
    await assert.rejects(readFile(path.join(dir, 'AGY_BRIDGE_TEST.md'), 'utf8'), { code: 'ENOENT' });
    const preview = await tasks.preview(write.taskId);
    assert.deepEqual(preview.files, [{ status: 'A', path: 'AGY_BRIDGE_TEST.md' }]);
    await tasks.integrate(write.taskId, preview.sha256);
    assert.equal(await readFile(path.join(dir, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'Antigravity MCP bridge test successful.');
    await assert.rejects(tasks.integrate(write.taskId, preview.sha256), { code: 'ALREADY_INTEGRATED' });
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

test('resumed conversation reuses the isolated copy and source remains clean', async () => {
  const dir = await repository();
  try {
    const { adapter, tasks } = setup();
    await adapter.discover();
    const run = await tasks.run({ prompt: 'write:test', workingDirectory: dir });
    const final = await until(tasks, run.taskId, done);
    assert.equal(final.status, 'completed');
    assert.equal(final.sessionId, 'mock-conversation');
    const resumed = await tasks.run({ prompt: 'split:again', workingDirectory: dir, sessionId: final.sessionId });
    const continued = await until(tasks, resumed.taskId, done);
    assert.equal(continued.status, 'completed');
    assert.equal(continued.copyDirectory, final.copyDirectory);
    assert.equal(await readFile(path.join(final.copyDirectory!, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'Antigravity MCP bridge test successful.');
    await assert.rejects(readFile(path.join(dir, 'AGY_BRIDGE_TEST.md'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('copy excludes Git ignores and excludes, includes untracked files and can narrow paths', async () => {
  const dir = await repository();
  try {
    await writeFile(path.join(dir, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(dir, '.git', 'info', 'exclude'), 'excluded.txt\n');
    await writeFile(path.join(dir, 'ignored.txt'), 'private');
    await writeFile(path.join(dir, 'excluded.txt'), 'private');
    await writeFile(path.join(dir, 'untracked.txt'), 'included');
    execFileSync('git', ['-C', dir, 'add', '-f', 'ignored.txt']);
    const eligible = await listProjectFiles(dir);
    assert.ok(eligible.includes('untracked.txt'));
    assert.ok(!eligible.includes('ignored.txt'));
    assert.ok(!eligible.includes('excluded.txt'));
    const copy = await createProjectCopy(dir, ['untracked.txt']);
    assert.deepEqual(copy.includedFiles, ['untracked.txt']);
    assert.equal(await readFile(path.join(copy.copyDirectory, 'untracked.txt'), 'utf8'), 'included');
    await assert.rejects(readFile(path.join(copy.copyDirectory, 'ignored.txt'), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(createProjectCopy(dir, ['ignored.txt']), { code: 'INVALID_INCLUDE_PATH' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('review digest gates integration and source edits block stale patches', async () => {
  const dir = await repository();
  try {
    const copy = await createProjectCopy(dir);
    await writeFile(path.join(copy.copyDirectory, 'source.txt'), 'changed');
    const preview = await previewProjectCopy(copy);
    assert.deepEqual(preview.files, [{ status: 'M', path: 'source.txt' }]);
    await assert.rejects(integrateProjectCopy(copy, '0'.repeat(64)), { code: 'REVIEW_CHANGED' });
    await writeFile(path.join(dir, 'source.txt'), 'source changed locally');
    await assert.rejects(integrateProjectCopy(copy, preview.sha256), { code: 'SOURCE_CHANGED' });
    await writeFile(path.join(dir, 'source.txt'), 'source');
    await integrateProjectCopy(copy, preview.sha256);
    assert.equal(await readFile(path.join(dir, 'source.txt'), 'utf8'), 'changed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
