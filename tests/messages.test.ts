import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendMessage, bridgeMessageSchema, clientTask, compactTask, extractAgentMessages, readMessages, resultReference } from '../src/messages.js';
import type { MessageLog } from '../src/messages.js';
import { StateStore } from '../src/state-store.js';
import type { TaskRecord } from '../src/types.js';

test('explicit public question and blocker envelopes are parsed while malformed or oversized output is ignored', () => {
  const text = 'ordinary status\n<black-gravity-message>{"kind":"question","text":"Which fixture is expected?"}</black-gravity-message>\n<black-gravity-message>{"kind":"blocker","text":"Test command failed"}</black-gravity-message>';
  assert.deepEqual(extractAgentMessages(text), [{ kind: 'question', text: 'Which fixture is expected?' }, { kind: 'blocker', text: 'Test command failed' }]);
  for (const body of ['{', '{"kind":"question","text":"ok","approve":true}', JSON.stringify({ kind: 'question', text: 'x'.repeat(2001) })]) {
    assert.deepEqual(extractAgentMessages('<black-gravity-message>' + body + '</black-gravity-message>'), []);
  }
  assert.deepEqual(extractAgentMessages('ordinary tool log'), []);
});

test('message rotation preserves monotonic cursors and discloses actual loss', () => {
  const task: Pick<TaskRecord, 'taskId' | 'model'> & MessageLog = { taskId: randomUUID(), model: 'fixture-model' };
  for (let i = 0; i < 105; i++) appendMessage(task, 'message', 'agy-reported', String(i));
  const page = readMessages(task, 0, 2);
  assert.equal(page.oldestAvailable, 6);
  assert.equal(page.truncated, true);
  assert.deepEqual(page.messages.map(m => m.sequence), [6, 7]);
  assert.equal(page.nextCursor, 7);
  const next = readMessages(task, page.nextCursor, 2);
  assert.deepEqual(next.messages.map(m => m.sequence), [8, 9]);
  assert.equal(next.truncated, false);
  assert.equal(next.messages[0]!.model, 'fixture-model');
  assert.equal(new Set(task.messages!.map(m => m.messageId)).size, 100);
  assert.throws(() => readMessages(task, -1));
});

test('compact metadata omits prompts, instruction bodies, results, raw usage and file lists while preserving status and model attribution', () => {
  const task: TaskRecord = { taskId: randomUUID(), workingDirectory: '/fixture/project', status: 'completed', createdAt: new Date().toISOString(),
    prompt: 'sensitive task instructions', result: { response: 'x'.repeat(100000) }, usage: { arbitrary: 'raw' },
    includedFiles: ['internal.txt'], copyDirectory: '/fixture/copy', model: 'fixture-model', error: { code: 'FIXTURE_ERROR', message: 'Observed error' } };
  const compact = compactTask(task);
  assert.equal(compact.taskId, task.taskId);
  assert.equal(compact.model, 'fixture-model');
  assert.deepEqual(compact.error, task.error);
  for (const field of ['prompt', 'result', 'usage', 'includedFiles', 'copyDirectory', 'roleDefinition', 'handoff']) assert.equal(field in compact, false);
  assert.ok(JSON.stringify(compact).length < 1000);
});

test('final result references match the existing JSON chunk reader hash without inlining the result', () => {
  const task = { taskId: randomUUID(), result: { response: 'Public response 🧭' } };
  const ref = resultReference(task)!;
  assert.equal(ref.tool, 'black_gravity_read_result');
  assert.equal(ref.contentSha256, createHash('sha256').update(JSON.stringify(task.result)).digest('hex'));
  assert.equal('response' in ref, false);
});


test('legacy and compact task delivery both omit private message buffers', () => {
  const task: TaskRecord = { taskId: randomUUID(), workingDirectory: '/fixture/project', status: 'completed', createdAt: new Date().toISOString(), prompt: 'fixture prompt' };
  appendMessage(task, 'message', 'agy-reported', 'Public message');
  assert.equal(clientTask(task).deliveryMode, undefined);
  assert.equal('messages' in clientTask(task), false);
  assert.equal('prompt' in clientTask(task), true);
  task.deliveryMode = 'messages';
  assert.equal(clientTask(task).deliveryMode, 'messages');
  assert.equal('prompt' in clientTask(task), false);
  assert.equal('messages' in clientTask(task), false);
});


test('public response extraction does not silently stop at a delivery page boundary', () => {
  const envelope = '<black-gravity-message>{"kind":"message","text":"Public note"}</black-gravity-message>';
  assert.equal(extractAgentMessages(envelope.repeat(30)).length, 30);
});

test('a task saved with the earlier result reader name loads under the current name, and new messages refuse the earlier name', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-message-state-'));
  try {
    const store = new StateStore(directory);
    const taskId = randomUUID();
    const workingDirectory = path.join(directory, 'project');
    const record: TaskRecord = { taskId, prompt: 'Public reference fixture', workingDirectory, status: 'completed', createdAt: new Date().toISOString() };
    const message = appendMessage(record, 'final', 'bridge', 'Result ready', resultReference({ taskId, result: { response: 'ok' } }));
    store.save({ ownerPid: process.pid, events: [], cursor: 0, options: { prompt: record.prompt, workingDirectory }, record });
    const target = path.join(directory, taskId + '.json');
    const snapshot = JSON.parse(await readFile(target, 'utf8'));
    assert.equal(snapshot.record.messages[0].reference.tool, 'black_gravity_read_result');
    snapshot.record.messages[0].reference.tool = 'antigravity_read_result';
    await writeFile(target, JSON.stringify(snapshot));
    const [loaded] = store.load();
    assert.deepEqual(loaded!.record.messages, [message]);
    assert.equal(bridgeMessageSchema.safeParse({ ...message, reference: { ...message.reference, tool: 'antigravity_read_result' } }).success, false);
    snapshot.record.messages[0].reference.tool = 'other_read_result';
    await writeFile(target, JSON.stringify(snapshot));
    assert.throws(() => store.load(), { code: 'INVALID_STATE' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
