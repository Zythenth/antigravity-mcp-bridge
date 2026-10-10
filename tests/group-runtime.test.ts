import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile, rename, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { loadConfig, type Config } from '../src/config.js';
import { TaskManager } from '../src/task-manager.js';
import { StateStore } from '../src/state-store.js';
import { GroupStore } from '../src/group-store.js';
import { createMcpServer } from '../src/mcp-server.js';
import { discardProjectCopy } from '../src/isolation.js';
import { successOutputSchemas } from '../src/output-schemas.js';
import type { GroupDefinition } from '../src/group-contract.js';
import type { RunOptions } from '../src/types.js';

class HeldAdapter extends CliAdapter {
  calls: Array<{ key: string; options: RunOptions; finish: (success?: boolean) => void }> = [];
  override spawnTask(options: RunOptions, _model: string | undefined, cwd: string): ChildProcessWithoutNullStreams {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams, stdout = new PassThrough(), sessionId = options.sessionId ?? randomUUID();
    const finish = (success = true) => {
      if (child.exitCode !== null) return;
      if (options.agentPolicy) {
        const hook = spawnSync(process.execPath, ['bridge-execution-hook.mjs'], { cwd: path.join(cwd, '.agents'), windowsHide: true, encoding: 'utf8',
          input: JSON.stringify({ toolCall: { name: 'finish', args: {} }, workspacePaths: [cwd], conversationId: sessionId }) });
        assert.equal(hook.status, 0, hook.stderr); assert.equal(JSON.parse(hook.stdout).decision, 'allow');
      }
      stdout.write(JSON.stringify({ event: 'result', result: { status: success ? 'SUCCESS' : 'ERROR', response: 'Public result reference.',
        usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } } }) + '\n');
      stdout.end(); Object.assign(child, { exitCode: success ? 0 : 1 }); child.emit('close', success ? 0 : 1);
    };
    Object.assign(child, { stdin: new PassThrough(), stdout, stderr: new PassThrough(), exitCode: null, killed: false,
      kill: () => { Object.assign(child, { killed: true }); finish(false); return true; } });
    this.calls.push({ key: options.group?.nodeKey ?? 'standalone', options: structuredClone(options), finish });
    setImmediate(() => stdout.write(JSON.stringify({ event: 'init', conversation_id: sessionId }) + '\n'));
    return child;
  }
}
async function fixture(body: (f: { root: string; source: string; config: Config; tasks: TaskManager; adapter: HeldAdapter; managers: TaskManager[] }) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-group-runtime-')), source = path.join(root, 'source');
  await mkdir(source); execFileSync('git', ['init', '--quiet'], { cwd: source }); await writeFile(path.join(source, 'source.txt'), 'fixture\n');
  const config = loadConfig({ BRIDGE_STATE_DIRECTORY: path.join(root, 'state'), BRIDGE_TEST_EXECUTOR: 'agy', MAX_CONCURRENT_TASKS: '2',
    BRIDGE_CUSTOM_ROLES: JSON.stringify([{ name: 'tester', baseRole: 'implementer', instruction: 'PRIVATE_PROFILE_INSTRUCTION', defaults: { effort: 'high' } }]) });
  const adapter = new HeldAdapter(config), tasks = new TaskManager(adapter, config), managers = [tasks];
  try { await body({ root, source, config, tasks, adapter, managers }); }
  finally {
    for (const manager of managers) await manager.shutdown();
    for (const project of new Map(new StateStore(config.stateDirectory).load().flatMap(item => item.project ? [[item.project.copyDirectory, item.project] as const] : [])).values()) await discardProjectCopy(project);
    assert.equal(path.relative(path.resolve(os.tmpdir()), path.dirname(path.resolve(root))), '');
    assert.ok(path.basename(root).startsWith('agy-group-runtime-'));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Fixture condition timed out'); await delay(20); }
}
function definition(source: string): GroupDefinition {
  return { workingDirectory: source, title: 'Dependency fixture', jobs: [
    { key: 'a', owner: 'implementer', dependsOn: [], task: { prompt: 'PRIVATE_JOB_PROMPT_A', mode: 'read-only' } },
    { key: 'b', owner: 'tester', dependsOn: [], task: { prompt: 'Inspect B.', mode: 'read-only' } },
    { key: 'join', owner: 'implementer', dependsOn: ['a','b'], task: { prompt: 'Inspect join.', mode: 'read-only' } },
  ] };
}
function chain(source: string) { const input = definition(source); input.jobs = [input.jobs[0]!, { ...input.jobs[2]!, dependsOn: ['a'] }]; return input; }

test('group MCP preserves owners, waits for every prerequisite and returns compact references', async () => {
  await fixture(async ({ source, tasks, adapter }) => {
    const server = createMcpServer(adapter, tasks), client = new Client({ name: 'group-test', version: '1' }), [a,b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result)); return result.structuredContent;
    };
    try {
      assert.equal((await client.listTools()).tools.length, 50);
      const groupId = randomUUID(), input = definition(source);
      const created = successOutputSchemas.antigravity_group_create.parse(await call('antigravity_group_create', { groupId, definition: input })).group;
      assert.equal(JSON.stringify(created).includes('PRIVATE_JOB_PROMPT_A'), false);
      assert.equal(JSON.stringify(created).includes('PRIVATE_PROFILE_INSTRUCTION'), false); assert.equal(adapter.calls.length, 0);
      assert.deepEqual(await tasks.groups.create(groupId, input), created);
      await assert.rejects(tasks.groups.create(groupId, { ...input, title: 'Different' }), { code: 'GROUP_CONFLICT' });
      assert.throws(() => tasks.groups.start(groupId, '0'.repeat(64)), { code: 'GROUP_CHANGED' });
      await call('antigravity_group_start', { groupId, expectedDefinitionSha256: created.definitionSha256 });
      tasks.groups.start(groupId, created.definitionSha256); await until(() => adapter.calls.length === 2);
      assert.deepEqual(adapter.calls.map(call => call.key).sort(), ['a','b']);
      const firstRoot = adapter.calls.find(call => call.key === 'a')!, secondRoot = adapter.calls.find(call => call.key === 'b')!;
      assert.deepEqual(secondRoot.options.agentPolicy!.mcpServers, []); assert.deepEqual([...secondRoot.options.agentPolicy!.nativeTools].sort(), ['finish', 'view_file']);
      assert.equal(secondRoot.options.role, 'tester'); assert.equal(secondRoot.options.effort, 'high');
      firstRoot.finish(); await delay(150); assert.equal(adapter.calls.length, 2);
      secondRoot.finish(); await until(() => adapter.calls.length === 3); adapter.calls[2]!.finish();
      await until(() => tasks.groups.status(groupId).state === 'completed');
      const waited = successOutputSchemas.antigravity_group_wait.parse(await call('antigravity_group_wait', { groupId, timeoutSeconds: 1 }));
      assert.equal(waited.ready, true); assert.equal(waited.tasks.length, 3);
      assert.ok(waited.tasks.reduce((count, task) => count + task.messages.length, 0) <= 4);
      assert.equal(JSON.stringify(waited).includes('PRIVATE_JOB_PROMPT_A'), false);
      assert.equal(JSON.stringify(waited).includes('tool.started'), false);
      assert.ok(tasks.list().every(task => task.group?.groupId === groupId));
      await call('antigravity_group_start', { groupId, expectedDefinitionSha256: created.definitionSha256 }); assert.equal(adapter.calls.length, 3);
    } finally { await client.close(); await server.close(); }
  });
});
test('failed prerequisites block dependent nodes without starting them', async () => {
  await fixture(async ({ source, tasks, adapter }) => {
    const group = await tasks.groups.create(randomUUID(), chain(source)); tasks.groups.start(group.groupId, group.definitionSha256);
    await until(() => adapter.calls.length === 1); adapter.calls[0]!.finish(false);
    await until(() => tasks.groups.status(group.groupId).state === 'failed');
    assert.equal(tasks.groups.status(group.groupId).nodes[1]!.state, 'blocked'); assert.equal(adapter.calls.length, 1);
  });
});
test('group cancellation stops active work and never admits pending dependents', async () => {
  await fixture(async ({ source, tasks, adapter }) => {
    const group = await tasks.groups.create(randomUUID(), chain(source)); tasks.groups.start(group.groupId, group.definitionSha256);
    await until(() => adapter.calls.length === 1); await tasks.groups.cancel(group.groupId);
    const waited = await tasks.groups.wait(group.groupId, [], 1);
    assert.equal(waited.group.state, 'cancelled'); assert.equal(waited.ready, true);
    assert.equal(waited.group.nodes[0]!.state, 'cancelled'); assert.equal(waited.group.nodes[1]!.state, 'cancelled');
    await delay(150); assert.equal(adapter.calls.length, 1);
  });
});
test('explicit resume recovers accepted task identity when checkpoint omitted its ID', async () => {
  await fixture(async ({ source, tasks, adapter, config, managers }) => {
    const group = await tasks.groups.create(randomUUID(), chain(source)); tasks.groups.start(group.groupId, group.definitionSha256);
    await until(() => adapter.calls.length === 1); await tasks.groups.shutdown();
    const store = new GroupStore(config.stateDirectory), record = store.read(group.groupId), release = store.state.acquire('group-' + group.groupId);
    try { record.nodes.a = { state: 'starting' }; store.write(record); } finally { release(); }
    const resumed = new TaskManager(adapter, config); managers.push(resumed);
    assert.equal(resumed.groups.status(group.groupId).resumeRequired, true);
    resumed.groups.start(group.groupId, group.definitionSha256); await delay(150); assert.equal(adapter.calls.length, 1);
    adapter.calls[0]!.finish(); await until(() => adapter.calls.length === 2); adapter.calls[1]!.finish();
    await until(() => resumed.groups.status(group.groupId).state === 'completed');
    assert.deepEqual(adapter.calls.map(call => call.key), ['a','join']);
    assert.equal(resumed.list().filter(task => task.group?.nodeKey === 'a').length, 1);
  });
});
test('profile changes pause admission and malformed DAGs fail before any provider starts', async () => {
  await fixture(async ({ source, tasks, adapter, config }) => {
    const input = definition(source); input.jobs = [input.jobs[1]!]; const group = await tasks.groups.create(randomUUID(), input);
    config.customRoles[0]!.instruction = 'Changed instruction'; tasks.groups.start(group.groupId, group.definitionSha256);
    await until(() => tasks.groups.status(group.groupId).state === 'paused');
    assert.equal(tasks.groups.status(group.groupId).error!.code, 'GROUP_PROFILE_CHANGED'); assert.equal(adapter.calls.length, 0);
    await assert.rejects(tasks.groups.create(randomUUID(), { ...input, jobs: [{ ...input.jobs[0]!, dependsOn: ['missing'] }] }));
    await assert.rejects(tasks.groups.create(randomUUID(), { ...input, jobs: [{ ...input.jobs[0]!, owner: 'unknown' }] }), { code: 'INVALID_ROLE' });
  });
});
test('joint wait bounds messages, preserves independent cursors and cancels only waiting', async () => {
  await fixture(async ({ source, tasks, adapter }) => {
    const runs = [];
    for (let index = 0; index < 6; index++) runs.push(await tasks.run({ prompt: 'Inspect.', workingDirectory: source, mode: 'read-only', deliveryMode: 'messages' }));
    for (let index = 0; index < 6; index++) { await until(() => adapter.calls.length > index); adapter.calls[index]!.finish(); }
    await until(() => tasks.list().every(task => task.status === 'completed'));
    const first = successOutputSchemas.antigravity_wait_many.parse(await tasks.waitMany(runs.map(task => ({ taskId: task.taskId })), 1));
    assert.equal(first.ready, true); assert.equal(first.hasMoreMessages, true); assert.equal(first.tasks.reduce((count, task) => count + task.messages.length, 0), 4);
    const second = await tasks.waitMany(first.tasks.map(task => ({ taskId: task.taskId, after: task.nextCursor })), 1);
    assert.equal(second.tasks.reduce((count, task) => count + task.messages.length, 0), 2); assert.equal(second.hasMoreMessages, false);
    const missing = await tasks.waitMany([{ taskId: randomUUID() }], 1); assert.equal(missing.tasks[0]!.error!.code, 'TASK_NOT_FOUND');
    await assert.rejects(tasks.waitMany([{ taskId: runs[0]!.taskId }, { taskId: runs[0]!.taskId }], 1));
    const active = await tasks.run({ prompt: 'Hold.', workingDirectory: source, mode: 'read-only' });
    const controller = new AbortController(), waiting = tasks.waitMany([{ taskId: active.taskId }], 10, controller.signal);
    controller.abort(); await assert.rejects(waiting, { code: 'WAIT_CANCELLED' }); assert.notEqual(tasks.status(active.taskId).status, 'cancelled');
  });
});
test('two native processes starting the same group cannot duplicate admissions', async () => {
  await fixture(async ({ root, source, tasks }) => {
    const group = await tasks.groups.create(randomUUID(), chain(source)), log = path.join(root, 'admissions.jsonl');
    const children: ReturnType<typeof spawn>[] = [], done: Promise<void>[] = []; let ready = 0;
    try {
      for (let index = 0; index < 2; index++) {
        const child = spawn(process.execPath, [fileURLToPath(new URL('../../tests/group-process.mjs', import.meta.url)),root,group.groupId,group.definitionSha256], { windowsHide: true });
        children.push(child);
        done.push(new Promise<void>((resolve,reject) => {
          let output = '', errors = '', announced = false;
          child.stdout!.on('data', chunk => { output += chunk; if (!announced && output.includes('READY')) { announced = true; ready++; } });
          child.stderr!.on('data', chunk => { errors += chunk; }); child.once('error',reject);
          child.once('close', code => { try { assert.equal(code,0,errors); assert.ok(output.includes('"state":"completed"'),output); resolve(); } catch(error) { reject(error); } });
        }));
      }
      await until(() => ready === 2); await writeFile(path.join(root,'go'),'1'); await Promise.all(done);
      const calls = (await readFile(log,'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line).key); assert.deepEqual(calls,['a','join']);
    } finally { await writeFile(path.join(root,'go'),'1'); await Promise.allSettled(done); for (const child of children) if (child.exitCode === null) child.kill(); }
  });
});

test('an ambiguous interrupted admission is never retried when task identity is unavailable', async () => {
  await fixture(async ({ source, tasks, adapter, config }) => {
    const group = await tasks.groups.create(randomUUID(), chain(source));
    const store = new GroupStore(config.stateDirectory), record = store.read(group.groupId), release = store.state.acquire('group-' + group.groupId);
    try { record.state = 'paused'; record.nodes.a = { state: 'starting' }; store.write(record); } finally { release(); }
    tasks.groups.start(group.groupId, group.definitionSha256);
    await until(() => tasks.groups.status(group.groupId).state === 'failed');
    assert.equal(tasks.groups.status(group.groupId).nodes[0]!.error!.code, 'GROUP_ADMISSION_UNVERIFIED');
    assert.equal(adapter.calls.length, 0);
  });
});

test('a corrupted group reference cannot forward a foreign task or its messages', async () => {
  await fixture(async ({ source, tasks, config, adapter }) => {
    const foreign = await tasks.run({ prompt: 'Standalone.', workingDirectory: source, mode: 'read-only' });
    const input = chain(source);
    const group = await tasks.groups.create(randomUUID(), input);
    const store = new GroupStore(config.stateDirectory), record = store.read(group.groupId), release = store.state.acquire('group-' + group.groupId);
    try { record.nodes.a = { state: 'completed', taskId: foreign.taskId.toUpperCase() }; record.state = 'paused'; store.write(record); } finally { release(); }
    assert.throws(() => tasks.groups.status(group.groupId), { code: 'INVALID_STATE' });
    await assert.rejects(tasks.groups.wait(group.groupId, [], 1), { code: 'INVALID_STATE' });
    await assert.rejects(tasks.groups.cancel(group.groupId), { code: 'INVALID_STATE' });
    assert.throws(() => tasks.groups.start(group.groupId, group.definitionSha256), { code: 'INVALID_STATE' });
    assert.notEqual(tasks.status(foreign.taskId).status, 'cancelled');
    assert.equal(adapter.calls.filter(call => call.key !== 'standalone').length, 0);
  });
});

test('group state cannot be copied as project input and canonical project redirection blocks admission', async () => {
  await fixture(async ({ root, source, tasks, config, adapter }) => {
    execFileSync('git', ['init', '--quiet'], { cwd: config.stateDirectory });
    await assert.rejects(tasks.groups.create(randomUUID(), chain(config.stateDirectory)), { code: 'INVALID_WORKING_DIRECTORY' });
    const group = await tasks.groups.create(randomUUID(), chain(source)), moved = path.join(root, 'moved'), other = path.join(root, 'other');
    await mkdir(other); execFileSync('git', ['init', '--quiet'], { cwd: other });
    assert.equal(path.dirname(source), root); assert.equal(path.dirname(moved), root);
    await rename(source, moved); await symlink(other, source, process.platform === 'win32' ? 'junction' : 'dir');
    tasks.groups.start(group.groupId, group.definitionSha256);
    await until(() => tasks.groups.status(group.groupId).state === 'failed');
    assert.equal(tasks.groups.status(group.groupId).nodes[0]!.error!.code, 'GROUP_CHANGED'); assert.equal(adapter.calls.length, 0);
  });
});
