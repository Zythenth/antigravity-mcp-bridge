import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CliAdapter } from '../src/cli-adapter.js';
import { loadConfig, type Config } from '../src/config.js';
import { TaskManager } from '../src/task-manager.js';
import { StateStore } from '../src/state-store.js';
import { discardProjectCopy, fingerprintProjectCopy } from '../src/isolation.js';
import type { RunOptions, TaskRecord } from '../src/types.js';

function hook(cwd: string, conversationId: string, name: string, args: unknown) {
  const child = spawnSync(process.execPath, ['bridge-execution-hook.mjs'], { cwd: path.join(cwd, '.agents'), input: JSON.stringify({ workspacePaths: [cwd], conversationId, toolCall: { name, args } }), encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout).decision as string;
}
class GuardedAdapter extends CliAdapter {
  calls: Array<{ options: RunOptions; cwd: string }> = [];
  behavior: 'guarded' | 'bypass' | 'tamper' = 'guarded';
  override spawnTask(options: RunOptions, _model: string | undefined, cwd: string): ChildProcessWithoutNullStreams {
    this.calls.push({ options, cwd });
    const child = new EventEmitter() as ChildProcessWithoutNullStreams, stdout = new PassThrough(), stderr = new PassThrough();
    Object.assign(child, { stdin: new PassThrough(), stdout, stderr, pid: undefined, exitCode: null, killed: false, kill: () => { Object.assign(child, { exitCode: 1, killed: true }); child.emit('close', 1); return true; } });
    setImmediate(() => void (async () => {
      const session = options.sessionId ?? randomUUID();
      stdout.write(JSON.stringify({ event: 'init', conversation_id: session }) + '\n');
      if (this.behavior !== 'bypass') {
        assert.equal(hook(cwd, session, 'view_file', { AbsolutePath: path.join(cwd, 'source.txt') }), 'allow');
        assert.equal(hook(cwd, session, 'run_command', { CommandLine: 'inert fixture' }), 'deny');
        assert.equal(hook(cwd, session, 'call_mcp_tool', { ServerName: 'unselected', ToolName: 'echo', Arguments: {} }), 'deny');
        if (options.mode === 'write') {
          assert.equal(hook(cwd, session, 'write_to_file', { TargetFile: path.join(cwd, 'created.txt') }), 'allow');
          await writeFile(path.join(cwd, 'created.txt'), 'created by controlled adapter\n');
        }
        assert.equal(hook(cwd, session, 'finish', {}), 'allow');
      }
      if (this.behavior === 'tamper') await writeFile(path.join(cwd, '.agents/hooks.json'), '{}');
      const result = options.roleDefinition?.baseRole === 'reviewer' ? { summary: 'Inspected fixture.', reviewedFiles: ['source.txt'], findings: [], unverified: [] } : { marker: 'guarded' };
      stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', structured_output: result } }) + '\n');
      stdout.end(); Object.assign(child, { exitCode: 0 }); child.emit('close', 0);
    })().catch(error => { stderr.write(String(error)); Object.assign(child, { exitCode: 1 }); child.emit('close', 1); }));
    return child;
  }
}
async function fixture(body: (f: { root: string; source: string; config: Config; adapter: GuardedAdapter; tasks: TaskManager; managers: TaskManager[] }) => Promise<void>, environment: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-policy-runtime-')), source = path.join(root, 'source');
  await mkdir(source); execFileSync('git', ['init', '--quiet'], { cwd: source }); await writeFile(path.join(source, 'source.txt'), 'fixture\n');
  const config = loadConfig({ BRIDGE_STATE_DIRECTORY: path.join(root, 'state'), BRIDGE_TEST_EXECUTOR: 'agy', ...environment }), adapter = new GuardedAdapter(config), tasks = new TaskManager(adapter, config), managers = [tasks];
  try { await body({ root, source, config, adapter, tasks, managers }); }
  finally {
    for (const manager of managers) await manager.shutdown();
    for (const project of new Map(new StateStore(config.stateDirectory).load().flatMap(item => item.project ? [[item.project.copyDirectory, item.project] as const] : [])).values()) await discardProjectCopy(project);
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('agy-policy-runtime-')); await rm(root, { recursive: true, force: true });
  }
}
async function end(tasks: TaskManager, task: TaskRecord) { await tasks.wait(task.taskId); return tasks.status(task.taskId); }

test('enforced task executes real hooks, excludes managed files from preview and persists policy identity', async () => {
  await fixture(async ({ source, tasks, config }) => {
    const task = await end(tasks, await tasks.run({ prompt: 'Public fixture.', workingDirectory: source, allowedTools: ['view_file', 'write_to_file'], mcpServers: [] }));
    assert.equal(task.status, 'completed', JSON.stringify(task.error)); assert.ok(task.agentPolicyReceipt!.decisionCount >= 5); assert.equal(task.agentPolicyReceipt!.deniedCount, 2);
    assert.deepEqual((await tasks.preview(task.taskId)).files, [{ status: 'A', path: 'created.txt' }]);
    assert.deepEqual(new StateStore(config.stateDirectory).load().find(t => t.record.taskId === task.taskId)!.record.agentPolicy, task.agentPolicy);
    await assert.rejects(readFile(path.join(source, '.agents/hooks.json')), { code: 'ENOENT' });
    await assert.rejects(tasks.startTests(task.taskId, (await tasks.preview(task.taskId)).sha256, { executable: process.execPath, args: ['--version'] }), { code: 'POLICY_TEST_EXECUTOR_UNAVAILABLE' });
  });
});
test('read-only policy includes protected helpers in baseline without changes or patches', async () => {
  await fixture(async ({ source, tasks }) => {
    const task = await end(tasks, await tasks.run({ prompt: 'Read fixture.', workingDirectory: source, mode: 'read-only', allowedTools: ['view_file'] }));
    assert.equal(task.status, 'completed', JSON.stringify(task.error)); assert.deepEqual((await tasks.preview(task.taskId)).files, []);
  });
});
test('old guarded finish cannot validate a new resume that skips native hooks', async () => {
  await fixture(async ({ source, tasks, adapter }) => {
    const first = await end(tasks, await tasks.run({ prompt: 'Original.', workingDirectory: source, mode: 'read-only', allowedTools: ['view_file'] })); assert.equal(first.status, 'completed');
    await assert.rejects(tasks.run({ prompt: 'Change selection.', workingDirectory: source, sessionId: first.sessionId, allowedTools: [] }), { code: 'INVALID_AGENT_POLICY' });
    adapter.behavior = 'bypass'; const next = await end(tasks, await tasks.run({ prompt: 'Resume.', workingDirectory: source, sessionId: first.sessionId }));
    assert.equal(next.status, 'failed'); assert.equal(next.error?.code, 'AGENT_POLICY_UNVERIFIED');
  });
});
test('modified hook blocks success even when CLI result says SUCCESS', async () => {
  await fixture(async ({ source, tasks, adapter }) => {
    adapter.behavior = 'tamper'; const task = await end(tasks, await tasks.run({ prompt: 'Tamper fixture.', workingDirectory: source, allowedTools: ['view_file', 'write_to_file'] }));
    assert.equal(task.status, 'failed'); assert.equal(task.error?.code, 'EXECUTION_POLICY_VERIFICATION_FAILED');
  });
});
test('handoff restages controls for a separate copy and preserves context tree hash', async () => {
  await fixture(async ({ source, tasks, config }) => {
    const first = await end(tasks, await tasks.run({ prompt: 'Write fixture.', workingDirectory: source, allowedTools: ['view_file', 'write_to_file'] })); assert.equal(first.status, 'completed');
    const context = await tasks.context(first.taskId); const next = await end(tasks, await tasks.run({ prompt: 'Review fixture.', workingDirectory: source, contextTaskId: first.taskId, expectedContextSha256: context.treeSha256, role: 'reviewer' }));
    assert.equal(next.status, 'completed', JSON.stringify(next.error)); assert.notEqual(next.copyDirectory, first.copyDirectory); assert.deepEqual(next.agentPolicy!.nativeTools, ['view_file', 'finish']);
    const saved = new StateStore(config.stateDirectory).load(), a = saved.find(t => t.record.taskId === first.taskId)!.project!, b = saved.find(t => t.record.taskId === next.taskId)!.project!;
    assert.equal(await fingerprintProjectCopy(a, config), await fingerprintProjectCopy(b, config)); assert.notEqual(a.executionPolicy!.receiptPath, b.executionPolicy!.receiptPath);
  });
});
test('restart honors policy snapshot and rejects a revoked human ceiling before provider execution', async () => {
  await fixture(async ({ source, tasks, config, managers }) => {
    const first = await end(tasks, await tasks.run({ prompt: 'Original.', workingDirectory: source, allowedTools: ['view_file', 'write_to_file'] })); assert.equal(first.status, 'completed'); await tasks.shutdown();
    const changed = { ...config, allowedAgyTools: ['view_file' as const] }, adapter = new GuardedAdapter(changed), next = new TaskManager(adapter, changed); managers.push(next);
    await assert.rejects(next.run({ prompt: 'Revoked.', workingDirectory: source, sessionId: first.sessionId }), { code: 'POLICY_NOT_ALLOWED' }); assert.equal(adapter.calls.length, 0);
  });
});


test('discard releases the private execution receipt and allows repeated cleanup', async () => {
  await fixture(async ({ source, tasks, config }) => {
    const task = await end(tasks, await tasks.run({ prompt: 'Discard fixture.', workingDirectory: source, mode: 'read-only', allowedTools: ['view_file'] })); assert.equal(task.status, 'completed');
    const project = new StateStore(config.stateDirectory).load().find(t => t.record.taskId === task.taskId)!.project!;
    const receipt = project.executionPolicy!.receiptPath; assert.ok((await readFile(receipt)).length > 0);
    await tasks.discard(task.taskId); await assert.rejects(readFile(receipt), { code: 'ENOENT' });
    await discardProjectCopy(project);
  });
});


test('omitting caller selectors cannot bypass an explicit human ceiling', async () => {
  await fixture(async ({ source, tasks }) => {
    const task = await end(tasks, await tasks.run({ prompt: 'Use configured ceiling.', workingDirectory: source, mode: 'read-only' }));
    assert.equal(task.status, 'completed', JSON.stringify(task.error)); assert.deepEqual(task.agentPolicy!.nativeTools, ['view_file', 'finish']); assert.ok(task.agentPolicyReceipt);
  }, { BRIDGE_ALLOWED_AGY_TOOLS: '["view_file"]' });
});
test('a newly configured human ceiling cannot silently reuse an unguarded legacy session', async () => {
  await fixture(async ({ source, tasks, adapter, config }) => {
    adapter.behavior = 'bypass'; const first = await end(tasks, await tasks.run({ prompt: 'Legacy fixture.', workingDirectory: source, mode: 'read-only' })); assert.equal(first.status, 'completed'); assert.equal(first.agentPolicy, undefined);
    config.enforceAgentPolicy = true; config.allowedAgyTools = ['view_file'];
    await assert.rejects(tasks.run({ prompt: 'Continue under new ceiling.', workingDirectory: source, sessionId: first.sessionId }), { code: 'AGENT_POLICY_CHANGED' }); assert.equal(adapter.calls.length, 1);
  });
});


test('handoff retains the selected MCP tools when a human ceiling is globally configured', async () => {
  const catalog = [{ id: 'probe', command: process.execPath, args: ['--version'], tools: [{ name: 'echo', readOnly: true }] }];
  await fixture(async ({ source, tasks }) => {
    const first = await end(tasks, await tasks.run({ prompt: 'Original selected MCP.', workingDirectory: source, allowedTools: ['view_file', 'write_to_file'], mcpServers: [{ serverId: 'probe', tools: ['echo'] }] })); assert.equal(first.status, 'completed');
    const context = await tasks.context(first.taskId), next = await end(tasks, await tasks.run({ prompt: 'Review same tools.', workingDirectory: source, contextTaskId: first.taskId, expectedContextSha256: context.treeSha256, role: 'reviewer' }));
    assert.equal(next.status, 'completed', JSON.stringify(next.error)); assert.deepEqual(next.agentPolicy!.mcpServers, first.agentPolicy!.mcpServers); assert.deepEqual(next.agentPolicy!.nativeTools, ['view_file', 'finish']);
  }, { BRIDGE_MCP_CATALOG: JSON.stringify(catalog) });
});


test('Windows restart accepts canonical aliases of the same private state directory', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async ({ source, tasks, config, managers }) => {
    const first = await end(tasks, await tasks.run({ prompt: 'Alias fixture.', workingDirectory: source, mode: 'read-only', allowedTools: ['view_file'] })); assert.equal(first.status, 'completed'); await tasks.shutdown();
    const aliased = { ...config, stateDirectory: config.stateDirectory.toLowerCase() }, adapter = new GuardedAdapter(aliased), next = new TaskManager(adapter, aliased); managers.push(next);
    const resumed = await end(next, await next.run({ prompt: 'Continue through alias.', workingDirectory: source, sessionId: first.sessionId })); assert.equal(resumed.status, 'completed', JSON.stringify(resumed.error)); assert.deepEqual(resumed.agentPolicy, first.agentPolicy);
  });
});
