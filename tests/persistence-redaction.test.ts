import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CliAdapter } from '../src/cli-adapter.js';
import { loadConfig } from '../src/config.js';
import { redactionContextDigest } from '../src/subprocess.js';
import { TaskManager } from '../src/task-manager.js';
import { BridgeError } from '../src/types.js';

const fixture = fileURLToPath(new URL('../../tests/redaction-fixture.mjs', import.meta.url));
const token = 'gh' + 'p_' + 'D'.repeat(36);
const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

async function setup(scenario?: string, existingState?: string, timeoutSeconds = 20, extra: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-persistence-redaction-'));
  directories.push(root);
  const source = path.join(root, 'source');
  execFileSync('git', ['init', '--quiet', source]);
  await writeFile(path.join(source, 'source.txt'), 'source content\n');
  const state = existingState ?? path.join(root, 'state');
  const config = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', AGY_PATH: process.execPath, BRIDGE_TEST_EXECUTOR: 'agy', BRIDGE_STATE_DIRECTORY: state, DEFAULT_TIMEOUT_SECONDS: String(timeoutSeconds), ...extra });
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

async function legacyTask() {
  const first = await setup('message-tail');
  const started = await first.tasks.run({ prompt: 'synthetic legacy run', workingDirectory: first.source });
  await finished(first.tasks, started.taskId);
  await first.tasks.shutdown();
  const file = path.join(first.state, started.taskId + '.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  // Earlier versions did not mark their state as redacted.
  delete stored.redacted;
  return { state: first.state, taskId: started.taskId, file, stored };
}
async function sanitizedCopies(state: string, taskId: string) {
  const directory = path.join(state, 'sanitized');
  return (await readdir(directory).catch(() => [] as string[])).filter(name => name.startsWith(taskId + '-') && name.endsWith('.json')).map(name => path.join(directory, name));
}

function cacheKey(sourceText: string) {
  return createHash('sha256').update(createHash('sha256').update(sourceText).digest('hex') + ':' + redactionContextDigest()).digest('hex');
}

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
  } finally {
    await second.tasks.shutdown();
  }
});

test('a legacy snapshot is sanitized once and the cached copy is reused', async () => {
  const { state, taskId, file, stored } = await legacyTask();
  stored.record.prompt = stored.options.prompt = 'legacy prompt ' + token;
  await writeFile(file, JSON.stringify(stored));
  await (await setup(undefined, state)).tasks.shutdown();
  const copies = await sanitizedCopies(state, taskId);
  assert.equal(copies.length, 1);
  const cached = JSON.parse(await readFile(copies[0]!, 'utf8'));
  assert.equal(cached.redacted, true);
  assert.equal(JSON.stringify(cached).includes(token), false);
  const source = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(source.redacted, undefined);
  cached.record.prompt = cached.record.prompt.replace('legacy prompt [redacted]', 'legacy prompt [redacted cached]');
  cached.options.prompt = cached.options.prompt.replace('legacy prompt [redacted]', 'legacy prompt [redacted cached]');
  await writeFile(copies[0]!, JSON.stringify(cached));
  const third = await setup(undefined, state);
  try {
    assert.equal(third.tasks.status(taskId).prompt, 'legacy prompt [redacted cached]');
  } finally {
    await third.tasks.shutdown();
  }
});

test('the cached copy keeps events beyond the in-memory buffer', async () => {
  const { state, taskId, file, stored } = await legacyTask();
  for (let i = 1; i <= 5; i++) {
    stored.events.push({
      taskId,
      sequence: stored.cursor + i,
      timestamp: new Date().toISOString(),
      type: 'response.chunk',
      data: { step_index: 9, step_type: 'agent_response', text_delta: `legacy line ${i}\n` },
      raw: { event: 'step_update', step_update: { step_index: 9, text_delta: `legacy line ${i}\n` } },
    });
  }
  stored.cursor += 5;
  await writeFile(file, JSON.stringify(stored));
  const total = stored.events.length;
  const second = await setup(undefined, state, 20, { EVENT_BUFFER_SIZE: '2' });
  try {
    const copies = await sanitizedCopies(state, taskId);
    assert.equal(copies.length, 1);
    const cached = JSON.parse(await readFile(copies[0]!, 'utf8'));
    assert.equal(cached.events.length, total);
  } finally {
    await second.tasks.shutdown();
  }
});

test('a newer source file replaces its cached copy', async () => {
  const { state, taskId, file, stored } = await legacyTask();
  await writeFile(file, JSON.stringify(stored));
  await (await setup(undefined, state)).tasks.shutdown();
  stored.record.prompt = stored.options.prompt = 'newer write ' + token;
  await writeFile(file, JSON.stringify(stored));
  const third = await setup(undefined, state);
  try {
    assert.equal(third.tasks.status(taskId).prompt, 'newer write [redacted]');
    const copies = await sanitizedCopies(state, taskId);
    assert.equal(copies.length, 1);
    const cachedText = await readFile(copies[0]!, 'utf8');
    assert.ok(cachedText.includes('newer write'));
  } finally {
    await third.tasks.shutdown();
  }
});

test('an invalid cached copy is rebuilt', async () => {
  const { state, taskId, file, stored } = await legacyTask();
  await writeFile(file, JSON.stringify(stored));
  await (await setup(undefined, state)).tasks.shutdown();
  const copies = await sanitizedCopies(state, taskId);
  assert.equal(copies.length, 1);
  await writeFile(copies[0]!, '{not json');
  const third = await setup(undefined, state);
  try {
    assert.equal(third.tasks.status(taskId).status, stored.record.status);
    const updated = await sanitizedCopies(state, taskId);
    assert.equal(updated.length, 1);
    const rebuilt = JSON.parse(await readFile(updated[0]!, 'utf8'));
    assert.equal(rebuilt.redacted, true);
  } finally {
    await third.tasks.shutdown();
  }
});

test('a cached copy with a sanitized structured result is reused', async () => {
  const { state, taskId, file, stored } = await legacyTask();
  stored.record.prompt = stored.options.prompt = 'legacy prompt ' + token;
  stored.record.structuredResult = { value: { summary: 'legacy ' + token }, sha256: 'a'.repeat(64) };
  await writeFile(file, JSON.stringify(stored));
  await (await setup(undefined, state)).tasks.shutdown();
  const copies = await sanitizedCopies(state, taskId);
  assert.equal(copies.length, 1);
  const cached = JSON.parse(await readFile(copies[0]!, 'utf8'));
  cached.record.prompt = cached.record.prompt.replace('legacy prompt [redacted]', 'legacy prompt [redacted cached]');
  cached.options.prompt = cached.options.prompt.replace('legacy prompt [redacted]', 'legacy prompt [redacted cached]');
  await writeFile(copies[0]!, JSON.stringify(cached));
  const second = await setup(undefined, state);
  try {
    assert.equal(second.tasks.status(taskId).prompt, 'legacy prompt [redacted cached]');
    assert.equal(JSON.stringify(second.tasks.status(taskId).structuredResult).includes(token), false);
  } finally {
    await second.tasks.shutdown();
  }
});

test('options holding credentials are never cached', async () => {
  const { state, taskId, file, stored } = await legacyTask();
  stored.options.note = 'leak ' + token;
  await writeFile(file, JSON.stringify(stored));
  await (await setup(undefined, state)).tasks.shutdown();
  assert.equal((await sanitizedCopies(state, taskId)).length, 0);
  const second = await setup(undefined, state);
  try {
    assert.equal(second.tasks.status(taskId).status, stored.record.status);
  } finally {
    await second.tasks.shutdown();
  }
});

test('project metadata holding credentials is never cached', async () => {
  const { state, taskId, file, stored } = await legacyTask();
  assert.ok(stored.project);
  stored.project.includedFiles.push('leak-' + token + '.txt');
  await writeFile(file, JSON.stringify(stored));
  await (await setup(undefined, state)).tasks.shutdown();
  assert.equal((await sanitizedCopies(state, taskId)).length, 0);
  const second = await setup(undefined, state);
  try {
    assert.equal(second.tasks.status(taskId).status, stored.record.status);
  } finally {
    await second.tasks.shutdown();
  }
});

test('record fields kept verbatim that hold credentials are never cached', async () => {
  const { state, taskId, file, stored } = await legacyTask();
  delete stored.project;
  stored.record.copyDirectory = path.join(os.tmpdir(), 'agy-mcp-copy-' + token);
  await writeFile(file, JSON.stringify(stored));
  await (await setup(undefined, state)).tasks.shutdown();
  assert.equal((await sanitizedCopies(state, taskId)).length, 0);
  const second = await setup(undefined, state);
  try {
    assert.equal(second.tasks.status(taskId).status, stored.record.status);
  } finally {
    await second.tasks.shutdown();
  }
});

test('event metadata holding credentials is never cached', async () => {
  const { state, taskId, file, stored } = await legacyTask();
  stored.events[0].type = 'leak-' + token;
  await writeFile(file, JSON.stringify(stored));
  await (await setup(undefined, state)).tasks.shutdown();
  assert.equal((await sanitizedCopies(state, taskId)).length, 0);
  const second = await setup(undefined, state);
  try {
    assert.equal(second.tasks.status(taskId).status, stored.record.status);
  } finally {
    await second.tasks.shutdown();
  }
});

test('a cached copy keeps its own project when another snapshot shares the copy', async () => {
  const { state, taskId, file, stored } = await legacyTask();
  assert.ok(stored.project);
  await writeFile(file, JSON.stringify(stored));
  const novoId = randomUUID();
  const b = JSON.parse(JSON.stringify(stored));
  b.record.taskId = novoId;
  for (const event of b.events) event.taskId = novoId;
  if (b.record.messages) for (const item of b.record.messages) item.taskId = novoId;
  if (b.record.inbox) {
    for (const item of b.record.inbox) {
      item.taskId = novoId;
      if (item.receipt) item.receipt.taskId = novoId;
    }
  }
  b.project.includedFiles = [...b.project.includedFiles, 'only-in-b.txt'];
  b.record.createdAt = new Date(Date.parse(stored.record.createdAt) + 1).toISOString();
  await writeFile(path.join(state, novoId + '.json'), JSON.stringify(b));
  await (await setup(undefined, state)).tasks.shutdown();
  await rm(file);
  for (const copy of await sanitizedCopies(state, taskId)) await rm(copy);
  const { tasks } = await setup(undefined, state);
  try {
    const copies = await sanitizedCopies(state, novoId);
    assert.equal(copies.length, 1);
    const cached = JSON.parse(await readFile(copies[0]!, 'utf8'));
    assert.ok(cached.project?.includedFiles.includes('only-in-b.txt'));
    assert.equal(tasks.status(novoId).status, stored.record.status);
  } finally {
    await tasks.shutdown();
  }
});

test('a directory in place of the cached copy does not block loading', async () => {
  const { state, taskId, file, stored } = await legacyTask();
  const text = JSON.stringify(stored);
  await writeFile(file, text);
  const hash = cacheKey(text);
  const dir = path.join(state, 'sanitized', taskId + '-' + hash + '.v1.json');
  await mkdir(dir, { recursive: true });
  const second = await setup(undefined, state);
  try {
    assert.equal(second.tasks.status(taskId).status, stored.record.status);
    assert.equal((await readdir(dir)).length, 0);
  } finally {
    await second.tasks.shutdown();
  }
});

test('a FIFO in place of the cached copy does not block loading', { skip: process.platform === 'win32' }, async () => {
  const { state, taskId, file, stored } = await legacyTask();
  const text = JSON.stringify(stored);
  await writeFile(file, text);
  const hash = cacheKey(text);
  const fifo = path.join(state, 'sanitized', taskId + '-' + hash + '.v1.json');
  await mkdir(path.join(state, 'sanitized'), { recursive: true });
  execFileSync('mkfifo', [fifo]);
  const second = await setup(undefined, state);
  try {
    assert.equal(second.tasks.status(taskId).status, stored.record.status);
  } finally {
    await second.tasks.shutdown();
  }
});

test('a change in environment secrets invalidates the cached copy', async () => {
  const { state, taskId, file, stored } = await legacyTask();
  stored.record.prompt = stored.options.prompt = 'legacy prompt plainvalue-abcdef123456';
  await writeFile(file, JSON.stringify(stored));
  await (await setup(undefined, state)).tasks.shutdown();
  const copies = await sanitizedCopies(state, taskId);
  assert.equal(copies.length, 1);
  process.env.BRIDGE_CACHE_TEST_API_KEY = 'plainvalue-abcdef123456';
  try {
    const second = await setup(undefined, state);
    try {
      assert.equal(second.tasks.status(taskId).prompt, 'legacy prompt [redacted]');
    } finally {
      await second.tasks.shutdown();
    }
  } finally {
    delete process.env.BRIDGE_CACHE_TEST_API_KEY;
  }
});
