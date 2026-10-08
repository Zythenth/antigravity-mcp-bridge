import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CliAdapter } from '../src/cli-adapter.js';
import { TaskManager } from '../src/task-manager.js';
import { StateStore } from '../src/state-store.js';
import { discardProjectCopy } from '../src/isolation.js';
import { loadConfig, type Config } from '../src/config.js';
import type { RunOptions } from '../src/types.js';
import { clientTask } from '../src/messages.js';

const question = { kind: 'question', text: 'Which public fixture should be used?' };
const envelope = '<antigravity-message>' + JSON.stringify(question) + '</antigravity-message>';
class ControlledAdapter extends CliAdapter {
  constructor(config: Config) { super(config); }
  override async listModels() { return []; }
  override spawnTask(_options: RunOptions, _model: string | undefined, _cwd: string): ChildProcessWithoutNullStreams {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: undefined,
      exitCode: null as number | null, killed: false, kill: (_signal?: string) => { clearTimeout(timer); child.exitCode = 0; child.killed = true; child.emit('close', 0); return true; } });
    const emit = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
    queueMicrotask(() => {
      emit({ event: 'init', conversation_id: 'controlled-conversation' });
      const chunk = JSON.stringify({ event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'ACTIVE', text_delta: envelope } }) + '\n';
      child.stdout.write(chunk.slice(0, 40)); child.stdout.write(chunk.slice(40));
      emit({ event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'DONE' } });
      emit({ event: 'step_update', step_update: { step_index: 4, step_type: 'tool', state: 'DONE', tool_name: 'view_file', tool_info: { output: 'x'.repeat(8000) } } });
    });
    const timer = setTimeout(() => {
      emit({ event: 'result', result: { conversation_id: 'controlled-conversation', status: 'SUCCESS', response: envelope + '\n' + 'Public final result '.repeat(3000), usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } });
      child.exitCode = 0; child.emit('close', 0);
    }, 1000);
    return child as unknown as ChildProcessWithoutNullStreams;
  }
}
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-message-delivery-test-'));
  const source = path.join(dir, 'source'); execFileSync('git', ['init', '--quiet', source]); await writeFile(path.join(source, 'source.txt'), 'Public fixture');
  const config = loadConfig({ BRIDGE_STATE_DIRECTORY: path.join(dir, 'state'), BRIDGE_TEST_EXECUTOR: 'agy' });
  const adapter = new ControlledAdapter(config); const tasks = new TaskManager(adapter, config);
  return { source, config, adapter, tasks, async close() {
    await tasks.shutdown();
    for (const project of new Map(new StateStore(config.stateDirectory).load().filter(t => t.project).map(t => [t.project!.copyDirectory, t.project!])).values()) await discardProjectCopy(project);
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(dir));
    assert.ok(relative && !relative.startsWith('..') && !relative.includes(path.sep) && relative.startsWith('agy-message-delivery-test-'));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}

test('messages wait wakes on a public question before completion, suppresses raw progress and retains full history separately', async () => {
  const f = await fixture();
  try {
    const run = await f.tasks.run({ prompt: 'Fixture public stream', workingDirectory: f.source, mode: 'read-only', deliveryMode: 'messages' });
    let progress = 0;
    const first = await f.tasks.wait(run.taskId, 0, 10, undefined, async () => { progress++; });
    if (first.deliveryMode !== 'messages') throw new Error('Expected message delivery');
    assert.equal(first.deliveryMode, 'messages');
    assert.equal(first.ready, false);
    assert.equal(first.timedOut, false);
    assert.equal('events' in first, false);
    assert.equal(first.messages?.length, 1);
    assert.equal(first.messages?.[0]!.text, question.text);
    assert.equal(progress, 0);
    const final = await f.tasks.wait(run.taskId, first.nextCursor, 10);
    if (final.deliveryMode !== 'messages') throw new Error('Expected final message delivery');
    assert.equal(final.ready, true);
    assert.equal(final.messages?.length, 1);
    assert.equal(final.messages?.[0]!.kind, 'final');
    assert.ok(final.messages?.[0]!.text.length === 2000);
    assert.ok(final.messages?.[0]!.reference?.contentSha256);
    const history = f.tasks.readEvents(run.taskId, 0, 1000);
    assert.ok(history.events.some(event => event.type === 'tool.completed'));
    assert.ok(JSON.stringify(history).length > JSON.stringify(first).length * 5);
    assert.equal('prompt' in clientTask(f.tasks.status(run.taskId)), false);
    const recovered = new TaskManager(f.adapter, f.config);
    const retained = await recovered.wait(run.taskId, 0, 1);
    if (retained.deliveryMode !== 'messages') throw new Error('Expected retained message delivery');
    assert.deepEqual(retained.messages, [...first.messages!, ...final.messages!]);
    assert.equal(retained.deliveryMode, 'messages');
  } finally { await f.close(); }
});

test('omitting delivery mode preserves events and switching modes requires distinct cursors', async () => {
  const f = await fixture();
  try {
    const run = await f.tasks.run({ prompt: 'Legacy public stream', workingDirectory: f.source, mode: 'read-only' });
    const old = await f.tasks.wait(run.taskId, 0, 10);
    assert.equal(old.deliveryMode, 'events');
    assert.ok(old.events!.length > 0);
    assert.equal('messages' in old, false);
    assert.equal('prompt' in clientTask(f.tasks.status(run.taskId)), true);
    assert.equal(f.tasks.setDeliveryMode(run.taskId, 'messages').deliveryMode, 'messages');
    const compact = await f.tasks.wait(run.taskId, old.nextCursor, 1, undefined, undefined, 'events');
    assert.equal(compact.cursorReset, true);
    if (compact.deliveryMode !== 'messages') throw new Error('Expected selected message delivery');
    assert.equal(compact.messages?.length, 2);
    assert.equal('events' in compact, false);
    assert.equal('prompt' in clientTask(f.tasks.status(run.taskId)), false);
  } finally { await f.close(); }
});
