import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CliAdapter } from '../src/cli-adapter.js';
import { loadConfig } from '../src/config.js';
import { TaskManager } from '../src/task-manager.js';
import { BridgeError } from '../src/types.js';

const fixture = fileURLToPath(new URL('../../tests/redaction-fixture.mjs', import.meta.url));
const token = 'gh' + 'p_' + 'D'.repeat(36);
const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

async function setup(scenario?: string, existingState?: string, timeoutSeconds = 20) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-persistence-redaction-'));
  directories.push(root);
  const source = path.join(root, 'source');
  execFileSync('git', ['init', '--quiet', source]);
  await writeFile(path.join(source, 'source.txt'), 'source content\n');
  const state = existingState ?? path.join(root, 'state');
  const config = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', AGY_PATH: process.execPath, BRIDGE_TEST_EXECUTOR: 'agy', BRIDGE_STATE_DIRECTORY: state, DEFAULT_TIMEOUT_SECONDS: String(timeoutSeconds) });
  const adapter = new CliAdapter(config, scenario ? [fixture, '--scenario', scenario] : [fixture]);
  await adapter.discover();
  return { source, state, tasks: new TaskManager(adapter, config) };
}

async function finished(tasks: TaskManager, taskId: string) {
  const deadline = Date.now() + 60000;
  let record = tasks.status(taskId);
  while (!['completed', 'failed', 'cancelled', 'timeout'].includes(record.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    record = tasks.status(taskId);
  }
  assert.equal(record.status, 'completed', JSON.stringify(record.error));
  return record;
}

const chunkText = (tasks: TaskManager, taskId: string) => tasks.readEvents(taskId, 0, 1000).events
  .filter(event => event.type === 'response.chunk').map(event => (event.data as { text_delta: string }).text_delta).join('');

async function stateText(directory: string): Promise<string> {
  let text = '';
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) text += await readFile(path.join(entry.parentPath, entry.name), 'utf8');
  }
  return text;
}

test('results, deltas, tool output, messages and deep frames are redacted before persistence', async () => {
  const { source, state, tasks } = await setup();
  try {
    const started = await tasks.run({ prompt: 'synthetic redaction run', workingDirectory: source, deliveryMode: 'messages' });
    const deadline = Date.now() + 60000;
    let record = tasks.status(started.taskId);
    while (!['completed', 'failed', 'cancelled', 'timeout'].includes(record.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      record = tasks.status(started.taskId);
    }
    assert.equal(record.status, 'completed', JSON.stringify(record.error));
    assert.equal(record.sessionId, 'redaction-conv');
    const events = tasks.readEvents(started.taskId, 0, 1000).events;
    const visible = JSON.stringify({ record, events, result: tasks.result(started.taskId) });
    assert.equal(visible.includes(token), false);
    assert.equal(visible.includes('MIIEsyntheticbody'), false);
    assert.equal(visible.includes('MIIEheadlessbody'), false);
    assert.match(visible, /final \[redacted\]/);
    const chunks = events.filter(event => event.type === 'response.chunk').map(event => (event.data as { text_delta: string }).text_delta).join('');
    assert.match(chunks, /^Report: \[redacted\] done\nKey follows\n/);
    assert.ok(events.some(event => event.type === 'stream.truncated'));
    assert.equal((await stateText(state)).includes(token), false);
  } finally {
    await tasks.shutdown();
  }
});

test('credential-shaped operational inputs are refused before persistence', async () => {
  const { source, state, tasks } = await setup();
  try {
    await assert.rejects(tasks.run({ prompt: 'use ' + token, workingDirectory: source }), (error: unknown) => error instanceof BridgeError && error.code === 'INPUT_SECRET_DETECTED');
    await assert.rejects(tasks.writeMemory(source, 'reviewer', 'remember ' + token, null), (error: unknown) => error instanceof BridgeError && error.code === 'INPUT_SECRET_DETECTED');
    const stored = await stateText(state).catch(() => '');
    assert.equal(stored.includes(token), false);
  } finally {
    await tasks.shutdown();
  }
});

test('overlong unfinished lines are suppressed instead of released mid-credential', async () => {
  const { source, tasks } = await setup('long-line');
  try {
    const started = await tasks.run({ prompt: 'synthetic long line run', workingDirectory: source });
    await finished(tasks, started.taskId);
    const chunks = chunkText(tasks, started.taskId);
    assert.equal(chunks, 'head\n[response line suppressed before redaction]\nnext line ok\n');
    assert.ok(tasks.readEvents(started.taskId, 0, 1000).events.some(event => event.type === 'response.truncated'));
  } finally {
    await tasks.shutdown();
  }
});

test('private key state survives other unfinished steps', async () => {
  const { source, tasks } = await setup('key-across-steps');
  try {
    const started = await tasks.run({ prompt: 'synthetic key run', workingDirectory: source });
    await finished(tasks, started.taskId);
    const chunks = chunkText(tasks, started.taskId);
    assert.equal(/MIIE(first|second)body/.test(chunks), false);
    assert.match(chunks, /after key\n/);
  } finally {
    await tasks.shutdown();
  }
});

test('suppressed text that may hold a key delimiter suppresses the rest of the step', async () => {
  const { source, tasks } = await setup('key-after-long-line');
  try {
    const started = await tasks.run({ prompt: 'synthetic suppressed key run', workingDirectory: source });
    await finished(tasks, started.taskId);
    const visible = JSON.stringify(tasks.readEvents(started.taskId, 0, 1000).events);
    assert.equal(visible.includes('MIIEhiddenbody'), false);
    assert.equal(visible.includes(token.slice(0, 20)) && visible.includes(token.slice(20)), false);
  } finally {
    await tasks.shutdown();
  }
});

test('the response step limit never readmits an index after other steps finish', async () => {
  const { source, tasks } = await setup('step-limit', undefined, 120);
  try {
    const started = await tasks.run({ prompt: 'synthetic step limit run', workingDirectory: source });
    await finished(tasks, started.taskId);
    assert.equal(JSON.stringify(tasks.readEvents(started.taskId, 0, 5000).events).includes('MIIEoverflowbody'), false);
  } finally {
    await tasks.shutdown();
  }
});

test('message bodies are redacted after their JSON escapes are decoded', async () => {
  const { source, state, tasks } = await setup('escaped-message');
  try {
    const started = await tasks.run({ prompt: 'synthetic escaped message run', workingDirectory: source, deliveryMode: 'messages' });
    const record = await finished(tasks, started.taskId);
    assert.ok(record.messages?.some(message => message.kind === 'question' && message.text === 'use [redacted]'));
    assert.equal(JSON.stringify(record.messages).includes(token), false);
    // Events keep JSON text, so the escaped token must not survive there either once decoded.
    const decode = (text: string) => text.replace(/\\+u0067/g, 'g');
    assert.equal(decode(JSON.stringify(tasks.readEvents(started.taskId, 0, 1000).events)).includes(token), false);
    assert.equal(decode(await stateText(state)).includes(token), false);
  } finally {
    await tasks.shutdown();
  }
});

test('key bodies streamed before a terminator without opening are redacted, other lines are released', async () => {
  const { source, tasks } = await setup('headless-key');
  try {
    const started = await tasks.run({ prompt: 'synthetic headless key run', workingDirectory: source });
    await finished(tasks, started.taskId);
    const visible = JSON.stringify(tasks.readEvents(started.taskId, 0, 1000).events);
    assert.equal(/MIIE(headless|sameframe|splitterminator|shorttail|overflow|blank|escaped)|AQ==/.test(visible), false);
    const chunks = chunkText(tasks, started.taskId);
    assert.match(chunks, /after\n/);
    assert.match(chunks, /closing\n/);
    // More than 100 blank lines after a possible body hit the hold limit instead of growing without bound.
    assert.match(chunks, /\[response lines suppressed before redaction\]\nplain text after flood\n/);
    assert.match(chunks, /\[response lines suppressed before redaction\]\n\[private key redacted\]\nbye\n/);
    assert.match(chunks, /deadbeefdeadbeefdeadbeef\nordinary text\n/);
  } finally {
    await tasks.shutdown();
  }
});

test('an unfinished line is kept, redacted, when the CLI exits without a result', async () => {
  const { source, tasks } = await setup('no-result');
  try {
    const started = await tasks.run({ prompt: 'synthetic exit run', workingDirectory: source });
    const deadline = Date.now() + 60000;
    while (!['completed', 'failed', 'cancelled', 'timeout'].includes(tasks.status(started.taskId).status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(tasks.status(started.taskId).status, 'failed');
    assert.equal(chunkText(tasks, started.taskId), 'Diagnostic before failure [redacted]');
  } finally {
    await tasks.shutdown();
  }
});

test('text released by the result event still yields public messages', async () => {
  const { source, tasks } = await setup('message-tail');
  try {
    const started = await tasks.run({ prompt: 'synthetic message run', workingDirectory: source, deliveryMode: 'messages' });
    const record = await finished(tasks, started.taskId);
    assert.ok(record.messages?.some(message => message.kind === 'question' && message.text === 'Which branch?'));
  } finally {
    await tasks.shutdown();
  }
});

test('state written before redaction is sanitized when restored', async () => {
  const first = await setup('message-tail');
  const started = await first.tasks.run({ prompt: 'synthetic legacy run', workingDirectory: first.source });
  await finished(first.tasks, started.taskId);
  await first.tasks.shutdown();
  const file = path.join(first.state, started.taskId + '.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  // Earlier versions did not mark their state as redacted.
  delete stored.redacted;
  const chunk = (text: string) => ({ taskId: started.taskId, sequence: 0, timestamp: new Date().toISOString(), type: 'response.chunk',
    data: { step_index: 7, step_type: 'agent_response', text_delta: text }, raw: { event: 'step_update', step_update: { step_index: 7, text_delta: text } } });
  const legacy = [token.slice(0, 15), token.slice(15), '-----BEGIN PRIVATE KEY-----\n', 'MIIElegacybody\n', '-----END PRIVATE KEY-----\n'];
  legacy.forEach((text, offset) => stored.events.push({ ...chunk(text), sequence: stored.cursor + offset + 1, ...(offset > 1 ? { data: { step_index: 8, step_type: 'agent_response', text_delta: text } } : {}) }));
  stored.cursor += legacy.length;
  stored.record.structuredResult = { value: { summary: 'legacy ' + token }, sha256: 'a'.repeat(64) };
  for (const text of [token.slice(0, 18), token.slice(18)]) stored.events.push({ ...chunk(text), data: { step_type: 'agent_response', text_delta: text }, raw: { event: 'step_update', step_update: { text_delta: text } }, sequence: ++stored.cursor });
  stored.record.prompt = stored.options.prompt = 'legacy prompt ' + token;
  stored.record.report = { role: 'implementer', source: 'agy-reported', data: { summary: 'report ' + token } };
  stored.record.tests = [{ command: 'node check.js', exitCode: 1, output: 'leaked ' + token, sha256: 'b'.repeat(64), recordedAt: new Date().toISOString(), source: 'client-reported' }];
  await writeFile(file, JSON.stringify(stored));
  const second = await setup(undefined, first.state);
  try {
    await second.tasks.cleanup();
    const visible = JSON.stringify({ events: second.tasks.readEvents(started.taskId, 0, 1000).events, record: second.tasks.status(started.taskId) });
    assert.equal(visible.includes(token.slice(0, 15)), false);
    assert.equal(visible.includes(token.slice(15)), false);
    assert.equal(visible.includes(token.slice(18)), false);
    assert.equal(visible.includes(token), false);
    assert.equal(visible.includes('MIIElegacybody'), false);
    assert.match(visible, /legacy \[redacted\]/);
    assert.match(visible, /leaked \[redacted\]/);
    assert.match(visible, /legacy prompt \[redacted\]/);
    // The sanitized state replaces the legacy file once, so the plaintext is gone from disk and later loads skip the work.
    const migrated = await readFile(file, 'utf8');
    assert.equal(JSON.parse(migrated).redacted, true);
    assert.equal(migrated.includes(token), false);
    assert.equal(migrated.includes('MIIElegacybody'), false);
  } finally {
    await second.tasks.shutdown();
  }
});
