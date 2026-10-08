import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { appendMessage, clientTask, compactTask, extractAgentMessages, readMessages, resultReference } from '../src/messages.js';
import type { MessageLog } from '../src/messages.js';
import type { TaskRecord } from '../src/types.js';

test('explicit public question and blocker envelopes are parsed while malformed or oversized output is ignored', () => {
  const text = 'ordinary status\n<antigravity-message>{"kind":"question","text":"Which fixture is expected?"}</antigravity-message>\n<antigravity-message>{"kind":"blocker","text":"Test command failed"}</antigravity-message>';
  assert.deepEqual(extractAgentMessages(text), [{ kind: 'question', text: 'Which fixture is expected?' }, { kind: 'blocker', text: 'Test command failed' }]);
  for (const body of ['{', '{"kind":"question","text":"ok","approve":true}', JSON.stringify({ kind: 'question', text: 'x'.repeat(2001) })]) {
    assert.deepEqual(extractAgentMessages('<antigravity-message>' + body + '</antigravity-message>'), []);
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
  assert.equal(ref.tool, 'antigravity_read_result');
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
  const envelope = '<antigravity-message>{"kind":"message","text":"Public note"}</antigravity-message>';
  assert.equal(extractAgentMessages(envelope.repeat(30)).length, 30);
});
