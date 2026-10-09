import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path'; import os from 'node:os';
import { CliAdapter } from '../src/cli-adapter.js';
import { TaskManager } from '../src/task-manager.js';
import { StateStore } from '../src/state-store.js';
import { discardProjectCopy } from '../src/isolation.js';
import { loadConfig, type Config } from '../src/config.js';
import { clientTask } from '../src/messages.js';
import { successOutputSchemas } from '../src/output-schemas.js';
import type { RunOptions, CallerInboxItem } from '../src/types.js';

class InboxAdapter extends CliAdapter {
  readonly calls: Array<{ options: RunOptions; directory: string }> = [];
  active = 0; maxActive = 0; releaseFirst?: () => void;
  constructor(config: Config, private readonly holdFirst: boolean) { super(config); }
  override async listModels() { return []; }
  override spawnTask(options: RunOptions, _model: string | undefined, directory: string): ChildProcessWithoutNullStreams {
    this.calls.push({ options: structuredClone(options), directory }); this.active++; this.maxActive = Math.max(this.maxActive, this.active);
    let timer: NodeJS.Timeout | undefined; let ended = false;
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: undefined,
      exitCode: null as number | null, killed: false, kill: (_signal?: string) => { if (ended) return false; ended = true; clearTimeout(timer); this.active--; child.exitCode = 0; child.killed = true; child.emit('close', 0); return true; } });
    const emit = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
    const complete = () => { if (ended) return; ended = true; this.active--; emit({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'inbox-conversation', response: 'Reply: ' + options.prompt } }); child.exitCode = 0; child.emit('close', 0); };
    queueMicrotask(() => { emit({ event: 'init', conversation_id: 'inbox-conversation' }); });
    if (this.holdFirst && this.calls.length === 1) this.releaseFirst = complete; else timer = setTimeout(complete, 80);
    return child as unknown as ChildProcessWithoutNullStreams;
  }
}
async function fixture(hold = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-inbox-test-'));
  const source = path.join(directory, 'source'); execFileSync('git', ['init', '--quiet', source]); await writeFile(path.join(source, 'source.txt'), 'source');
  const config = loadConfig({ BRIDGE_STATE_DIRECTORY: path.join(directory, 'state'), BRIDGE_TEST_EXECUTOR: 'agy' });
  const adapter = new InboxAdapter(config, hold); const managers: TaskManager[] = [new TaskManager(adapter, config)]; const tasks = managers[0]!;
  return { source, config, adapter, tasks, managers, async close() {
    for (const manager of managers) await manager.shutdown();
    const projects = new Map(new StateStore(config.stateDirectory).load().filter(s => s.project).map(s => [s.project!.copyDirectory, s.project!]));
    for (const project of projects.values()) await discardProjectCopy(project);
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !relative.includes(path.sep) && relative.startsWith('agy-inbox-test-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}
async function until(check: () => boolean) { const deadline = Date.now() + 15000; while (!check()) { if (Date.now() >= deadline) throw new Error('Condition was not reached'); await delay(10); } }
async function runFirst(f: Awaited<ReturnType<typeof fixture>>, mode: 'write' | 'read-only' = 'read-only') {
  const task = await f.tasks.run({ workingDirectory: f.source, prompt: 'initial request', mode, deliveryMode: 'messages',
    skills: [{ name: 'inbox-style', content: '---\nname: inbox-style\n---\nPublic fixture skill' }],
    acceptanceCriteria: [{ id: 'source', description: 'Keep public source', check: { kind: 'file-exists', path: 'source.txt' } }] });
  await until(() => f.adapter.calls.length === 1 && Boolean(f.tasks.status(task.taskId).sessionId)); return task.taskId;
}

test('active inputs are scoped and idempotent, and two inputs resume sequentially with inherited constraints', async () => {
  const f = await fixture();
  try {
    const id = await runFirst(f); const one = randomUUID(), two = randomUUID();
    assert.equal((await f.tasks.sendMessage(id, one, 'first reply')).receipt.state, 'queued');
    assert.equal((await f.tasks.sendMessage(id, one, 'first reply')).receipt.state, 'queued');
    await assert.rejects(f.tasks.sendMessage(id, one, 'different reply'), { code: 'MESSAGE_ID_CONFLICT' });
    await f.tasks.sendMessage(id, two, 'second reply');
    assert.equal(f.adapter.calls.length, 1); assert.equal(f.tasks.inbox(id).length, 2);
    assert.equal('inbox' in clientTask(f.tasks.status(id)), false);
    f.adapter.releaseFirst!();
    await until(() => f.adapter.calls.length === 3 && f.adapter.active === 0 && f.tasks.inbox(id).every(row => row.receipt.state === 'sent' && Boolean(row.receipt.continuationTaskId) && f.tasks.status(row.receipt.continuationTaskId!).status === 'completed'));
    assert.deepEqual(f.adapter.calls.map(call => call.options.prompt), ['initial request', 'first reply', 'second reply']);
    assert.equal(f.adapter.maxActive, 1);
    assert.equal(new Set(f.adapter.calls.map(call => call.directory)).size, 1);
    for (const call of f.adapter.calls.slice(1)) { assert.equal(call.options.mode, 'read-only'); assert.equal(call.options.sessionId, 'inbox-conversation'); assert.equal(call.options.deliveryMode, 'messages'); assert.equal(call.options.acceptanceCriteria?.[0]?.id, 'source'); assert.equal(call.options.providedSkills?.[0]?.name, 'inbox-style'); }
    const receipts = f.tasks.inbox(id); const b = receipts[0]!.receipt.continuationTaskId!, c = receipts[1]!.receipt.continuationTaskId!;
    assert.equal(f.tasks.status(id).continuationTaskId, b); assert.equal(f.tasks.status(b).continuationTaskId, c); assert.equal(f.tasks.status(c).parentTaskId, b);
    assert.equal((await f.tasks.sendMessage(id, one, 'first reply')).receipt.continuationTaskId, b);
    assert.equal(f.adapter.calls.length, 3);
    const record = new StateStore(f.config.stateDirectory).load().find(s => s.record.taskId === c)!.record;
    assert.deepEqual(record.sourceMessage, { taskId: id, messageId: two });
    assert.equal(await readFile(path.join(f.source, 'source.txt'), 'utf8'), 'source');
  } finally { await f.close(); }
});

test('completed input starts one continuation and foreign active owners cannot accept messages', async () => {
  const f = await fixture();
  try {
    const id = await runFirst(f); const foreign = new TaskManager(f.adapter, f.config); f.managers.push(foreign);
    await assert.rejects(foreign.sendMessage(id, randomUUID(), 'foreign input'), { code: 'TASK_OWNED_BY_OTHER_SERVER' });
    f.adapter.releaseFirst!(); await until(() => f.tasks.status(id).status === 'completed'); await delay(10);
    const receipt = (await f.tasks.sendMessage(id, randomUUID(), 'completed reply')).receipt;
    assert.equal(receipt.state, 'sent'); assert.ok(receipt.continuationTaskId);
    await until(() => f.adapter.calls.length === 2 && f.adapter.active === 0 && f.tasks.status(receipt.continuationTaskId!).status === 'completed');
  } finally { await f.close(); }
});

test('cancellation stops pending inputs and limits reject further acceptance without dispatch', async () => {
  const f = await fixture();
  try {
    const id = await runFirst(f);
    for (let i = 0; i < 20; i++) await f.tasks.sendMessage(id, randomUUID(), 'input ' + i);
    await assert.rejects(f.tasks.sendMessage(id, randomUUID(), 'overflow'), { code: 'INBOX_FULL' });
    await assert.rejects(f.tasks.sendMessage(id, randomUUID(), 'x'.repeat(2001)), { code: 'INVALID_MESSAGE' });
    await f.tasks.cancel(id); await until(() => f.tasks.status(id).status === 'cancelled');
    assert.ok(f.tasks.inbox(id).every(item => item.receipt.state === 'cancelled')); assert.equal(f.adapter.calls.length, 1);
  } finally { await f.close(); }
});

test('uncertain interrupted dispatch fails without replay and known correlation is linked without a new provider start', async () => {
  for (const withCorrelation of [false, true]) {
    const f = await fixture(false);
    try {
      const id = await runFirst(f); await until(() => f.tasks.status(id).status === 'completed'); await delay(10);
      const store = new StateStore(f.config.stateDirectory), saved = store.load().find(t => t.record.taskId === id)!;
      const messageId = randomUUID(); const item: CallerInboxItem = { messageId, taskId: id, text: 'accepted earlier', receivedAt: new Date().toISOString(), receipt: { messageId, taskId: id, state: 'queued' } };
      saved.record.inbox = [item]; saved.record.dispatching = { messageId }; saved.ownerPid = 99999999; store.save(saved);
      let linked: string | undefined;
      if (withCorrelation) { linked = randomUUID(); store.save({ ...saved, events: [], cursor: 0, record: { ...saved.record, taskId: linked, prompt: 'accepted earlier', parentTaskId: id, sourceMessage: { taskId: id, messageId }, messages: undefined, messageCursor: 0, inbox: undefined, dispatching: undefined, createdAt: new Date(Date.now() + 1).toISOString() }, options: { ...saved.options, prompt: 'accepted earlier' } }); }
      const kill = process.kill.bind(process); mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => { if (pid === 99999999) throw Object.assign(new Error('dead fixture owner'), { code: 'ESRCH' }); return kill(pid, signal); });
      const recovered = new TaskManager(f.adapter, f.config); f.managers.push(recovered);
      const receipt = recovered.inbox(id)[0]!.receipt;
      assert.equal(receipt.state, withCorrelation ? 'sent' : 'failed');
      if (withCorrelation) { assert.equal(receipt.continuationTaskId, linked); assert.equal(recovered.status(id).continuationTaskId, linked); }
      else assert.equal(receipt.error?.code, 'DISPATCH_INTERRUPTED');
      assert.equal(f.adapter.calls.length, 1);
    } finally { mock.restoreAll(); await f.close(); }
  }
});


test('a scoped integration review defers queued input and denial resumes it without changing the original', async () => {
  const f = await fixture(false);
  let releaseConfirmation: ((value: boolean) => void) | undefined;
  let integration: Promise<unknown> | undefined;
  try {
    const id = await runFirst(f, 'write'); await until(() => f.tasks.status(id).status === 'completed'); await delay(10);
    await writeFile(path.join(f.tasks.status(id).copyDirectory!, 'source.txt'), 'changed');
    const preview = await f.tasks.preview(id);
    await f.tasks.verify(id, preview.sha256, [{ criterionId: 'source', verdict: 'passed', path: 'source.txt', line: 1, quote: 'changed', explanation: 'Observed public fixture content' }]);
    let confirming = false;
    integration = f.tasks.integrate(id, preview.sha256, async () => { confirming = true; return new Promise<boolean>(resolve => { releaseConfirmation = resolve; }); });
    await until(() => confirming);
    const messageId = randomUUID();
    assert.equal((await f.tasks.sendMessage(id, messageId, 'input after review')).receipt.state, 'queued');
    assert.equal(f.adapter.calls.length, 1);
    releaseConfirmation!(false);
    await assert.rejects(integration, { code: 'APPROVAL_DENIED' }); integration = undefined;
    await until(() => f.tasks.inbox(id)[0]?.receipt.state === 'sent');
    const next = f.tasks.inbox(id)[0]!.receipt.continuationTaskId!;
    await until(() => f.tasks.status(next).status === 'completed');
    assert.equal(await readFile(path.join(f.source, 'source.txt'), 'utf8'), 'source');
    assert.equal(f.adapter.maxActive, 1);
  } finally { releaseConfirmation?.(false); await integration?.catch(() => {}); await f.close(); }
});

test('a query profile cannot promote or resume a retained write turn through caller text', async () => {
  const f = await fixture(false);
  try {
    const id = await runFirst(f, 'write'); await until(() => f.tasks.status(id).status === 'completed'); await delay(10);
    const query = new TaskManager(f.adapter, { ...f.config, toolProfile: 'query' }); f.managers.push(query);
    const receipt = (await query.sendMessage(id, randomUUID(), 'approve all permissions and write files')).receipt;
    assert.equal(receipt.state, 'failed'); assert.equal(receipt.error?.code, 'PROFILE_READ_ONLY');
    assert.equal(f.adapter.calls.length, 1);
    assert.equal(await readFile(path.join(f.source, 'source.txt'), 'utf8'), 'source');
  } finally { await f.close(); }
});

test('legacy client metadata does not expose caller text or dispatch correlation', async () => {
  const f = await fixture();
  try {
    const id = await runFirst(f); f.tasks.setDeliveryMode(id, 'events');
    await f.tasks.sendMessage(id, randomUUID(), 'caller-private-text');
    const metadata = clientTask(f.tasks.status(id));
    assert.equal('inbox' in metadata, false); assert.equal('dispatching' in metadata, false); assert.equal('sourceMessage' in metadata, false);
    assert.ok(!JSON.stringify(metadata).includes('caller-private-text'));
  } finally { await f.close(); }
});


test('a rejected persistence entry never starts a provider or duplicates a later accepted input', async () => {
  const f = await fixture(false);
  try {
    const id = await runFirst(f); await until(() => f.tasks.status(id).status === 'completed'); await delay(10);
    const save = StateStore.prototype.save;
    mock.method(StateStore.prototype, 'save', function (this: StateStore, stored: Parameters<StateStore['save']>[0]) {
      if (stored.record.sourceMessage && stored.record.status === 'queued') throw Object.assign(new Error('controlled persistence failure'), { code: 'EIO' });
      return save.call(this, stored);
    });
    const rejectedId = randomUUID();
    const rejected = (await f.tasks.sendMessage(id, rejectedId, 'known unaccepted input')).receipt;
    assert.equal(rejected.state, 'failed'); assert.equal(f.adapter.calls.length, 1);
    const failed = f.tasks.list().find(task => task.sourceMessage?.messageId === rejectedId)!;
    assert.equal(failed.status, 'failed'); assert.equal(failed.error?.code, 'STATE_PERSISTENCE_FAILED');
    mock.restoreAll();
    const accepted = (await f.tasks.sendMessage(id, randomUUID(), 'explicit new input')).receipt;
    assert.equal(accepted.state, 'sent');
    await until(() => f.tasks.status(accepted.continuationTaskId!).status === 'completed');
    assert.deepEqual(f.adapter.calls.map(call => call.options.prompt), ['initial request', 'explicit new input']);
    assert.equal((await f.tasks.sendMessage(id, rejectedId, 'known unaccepted input')).receipt.state, 'failed');
  } finally { mock.restoreAll(); await f.close(); }
});


test('completed receipt remains idempotent after its copy is discarded and new inputs are refused', async () => {
  const f = await fixture(false);
  try {
    const id = await runFirst(f); await until(() => f.tasks.status(id).status === 'completed'); await delay(10);
    const messageId = randomUUID(); const first = (await f.tasks.sendMessage(id, messageId, 'retained receipt')).receipt;
    await until(() => f.tasks.status(first.continuationTaskId!).status === 'completed'); await delay(10);
    await f.tasks.discard(first.continuationTaskId!);
    assert.deepEqual((await f.tasks.sendMessage(id, messageId, 'retained receipt')).receipt, first);
    await assert.rejects(f.tasks.sendMessage(id, randomUUID(), 'new input'), { code: 'INVALID_MESSAGE_TARGET' });
    assert.equal(f.adapter.calls.length, 2);
  } finally { await f.close(); }
});

test('retention limits fail a new input explicitly instead of bypassing bounds or replaying it', async () => {
  const f = await fixture(false);
  try {
    const id = await runFirst(f); await until(() => f.tasks.status(id).status === 'completed'); await delay(10);
    const limited = new TaskManager(f.adapter, { ...f.config, maxRetainedTasks: 1 }); f.managers.push(limited);
    const receipt = (await limited.sendMessage(id, randomUUID(), 'limited input')).receipt;
    assert.equal(receipt.state, 'failed'); assert.equal(receipt.error?.code, 'QUEUE_FULL');
    assert.equal(f.adapter.calls.length, 1);
  } finally { await f.close(); }
});


test('wait exposes pending input and accepted continuation in the strict MCP contract', async () => {
  const f = await fixture();
  try {
    const id = await runFirst(f);
    await f.tasks.sendMessage(id, randomUUID(), 'wait contract');
    const pending = await f.tasks.wait(id, 0, 1, undefined, undefined, 'messages');
    assert.equal(pending.continuationPending, true);
    assert.equal(pending.continuationTaskId, undefined);
    assert.equal(successOutputSchemas.antigravity_wait.safeParse(pending).success, true);
    f.adapter.releaseFirst!();
    await until(() => Boolean(f.tasks.status(id).continuationTaskId));
    const linked = await f.tasks.wait(id, 0, 1, undefined, undefined, 'messages');
    assert.ok(linked.continuationTaskId);
    assert.equal(successOutputSchemas.antigravity_wait.safeParse(linked).success, true);
  } finally { await f.close(); }
});

test('shutdown cancels active queued inputs without starting another provider', async () => {
  const f = await fixture();
  try {
    const id = await runFirst(f);
    await f.tasks.sendMessage(id, randomUUID(), 'must not start after shutdown');
    await f.tasks.shutdown();
    assert.equal(f.tasks.status(id).status, 'cancelled');
    assert.equal(f.tasks.inbox(id)[0]!.receipt.state, 'cancelled');
    await assert.rejects(f.tasks.sendMessage(id, randomUUID(), 'after shutdown'), { code: 'AGY_PROCESS_FAILED' });
    assert.equal(f.adapter.calls.length, 1);
  } finally { await f.close(); }
});

test('persisted duplicate message IDs and dangling dispatch claims are rejected', async () => {
  const f = await fixture();
  try {
    const id = await runFirst(f);
    await f.tasks.sendMessage(id, randomUUID(), 'canonical input');
    const store = new StateStore(f.config.stateDirectory);
    const original = store.load().find(row => row.record.taskId === id)!;
    try {
      const duplicate = structuredClone(original);
      duplicate.record.inbox!.push(structuredClone(duplicate.record.inbox![0]!));
      store.save(duplicate);
      assert.throws(() => store.load(), { code: 'INVALID_STATE' });
      const dangling = structuredClone(original);
      dangling.record.dispatching = { messageId: randomUUID() };
      store.save(dangling);
      assert.throws(() => store.load(), { code: 'INVALID_STATE' });
    } finally { store.save(original); }
  } finally { await f.close(); }
});


test('project preauthorization skips only the repeated form and keeps hash, review and mode gates', async () => {
  const f = await fixture(false);
  try {
    const id = await runFirst(f, 'write'); await until(() => f.tasks.status(id).status === 'completed'); await delay(10);
    await writeFile(path.join(f.tasks.status(id).copyDirectory!, 'source.txt'), 'changed');
    const preview = await f.tasks.preview(id);
    await assert.rejects(f.tasks.integrate(id, preview.sha256), { code: 'APPROVAL_REQUIRED' });
    const authorized = new TaskManager(f.adapter, { ...f.config, preauthorizedIntegrationRoots: [process.platform === 'win32' ? f.source.toLowerCase() : f.source] }); f.managers.push(authorized);
    await assert.rejects(authorized.integrate(id, '0'.repeat(64)), { code: 'REVIEW_CHANGED' });
    await assert.rejects(authorized.integrate(id, preview.sha256), { code: 'VERIFICATION_REQUIRED' });
    await authorized.verify(id, preview.sha256, [{ criterionId: 'source', verdict: 'passed', path: 'source.txt', line: 1, quote: 'changed', explanation: 'Observed fixture content' }]);
    let prompted = false;
    await authorized.integrate(id, preview.sha256, async () => { prompted = true; return false; });
    assert.equal(prompted, false);
    assert.equal(await readFile(path.join(f.source, 'source.txt'), 'utf8'), 'changed');
  } finally { await f.close(); }
});
