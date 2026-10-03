import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state-store.js';
import { discardProjectCopy } from '../src/isolation.js';

async function fixture(profile = 'full') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-feature-test-'));
  const source = path.join(directory, 'source');
  execFileSync('git', ['init', '--quiet', source]);
  await writeFile(path.join(source, 'source.txt'), 'source');
  const client = new Client({ name: 'feature-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./mcp-fixture.js', import.meta.url))],
    env: { ...process.env as Record<string, string>, BRIDGE_TOOL_PROFILE: profile, BRIDGE_STATE_DIRECTORY: path.join(directory, 'state') },
    stderr: 'pipe' }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    return result.structuredContent as Record<string, any>;
  };
  return { client, source, call, async close() {
    for (const task of (await call('antigravity_tasks')).tasks) {
      if (!(await call('antigravity_result', { taskId: task.taskId })).ready) await call('antigravity_cancel', { taskId: task.taskId });
    }
    await client.close();
    for (const saved of new StateStore(path.join(directory, 'state')).load()) if (saved.project) await discardProjectCopy(saved.project);
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('agy-feature-test-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}

test('tool profiles reduce the MCP catalog and reject writes in query/review', async () => {
  assert.throws(() => loadConfig({ BRIDGE_TOOL_PROFILE: 'unknown' }));
  for (const [profile, count] of [['full', 24], ['query', 15], ['review', 18], ['implementation', 24]] as const) {
    const f = await fixture(profile);
    try {
      const names = (await f.client.listTools()).tools.map(tool => tool.name);
      assert.equal(names.length, count, profile);
      assert.equal((await f.call('antigravity_health')).toolProfile, profile);
      if (profile === 'query' || profile === 'review') {
        assert.ok(!names.includes('antigravity_integrate'));
        assert.ok(!names.includes('antigravity_test'));
        const disabled = await f.client.callTool({ name: 'antigravity_set_model', arguments: { model: null } });
        assert.equal(disabled.isError, true);
        const write = await f.client.callTool({ name: 'antigravity_run', arguments: { prompt: 'write:test', workingDirectory: f.source, mode: 'write' } });
        assert.equal((write.structuredContent as any).error.code, 'PROFILE_READ_ONLY');
        const run = await f.call('antigravity_run', { prompt: 'slow:test', workingDirectory: f.source });
        assert.equal(run.task.mode, 'read-only');
      }
    } finally { await f.close(); }
  }
});

test('wait sends event-based MCP progress and timeouts/cancellation preserve execution', async () => {
  const f = await fixture();
  try {
    const run = await f.call('antigravity_run', { prompt: 'split:test', workingDirectory: f.source, mode: 'read-only' });
    const progress: Array<{ progress: number; message?: string; total?: number }> = [];
    const response = await f.client.callTool({ name: 'antigravity_wait', arguments: { taskId: run.task.taskId, timeoutSeconds: 10 } },
      undefined, { onprogress: update => progress.push(update) });
    const done = response.structuredContent as any;
    assert.equal(response.isError, undefined);
    assert.equal(done.status, 'completed');
    assert.equal(done.ready, true);
    assert.equal(done.timedOut, false);
    assert.ok(progress.some(update => update.message?.endsWith('tool.completed')));
    assert.deepEqual(progress.map(update => update.progress), done.events.map((event: any) => event.sequence));
    assert.ok(progress.every(update => update.total === undefined));
    const continued = await f.call('antigravity_wait', { taskId: run.task.taskId, after: done.nextCursor });
    assert.deepEqual(continued.events, []);
    const slow = await f.call('antigravity_run', { prompt: 'cancel:test', workingDirectory: f.source, timeoutSeconds: 10 });
    const timed = await f.call('antigravity_wait', { taskId: slow.task.taskId, timeoutSeconds: 1 });
    assert.equal(timed.timedOut, true);
    assert.equal(timed.ready, false);
    const controller = new AbortController();
    const pending = f.client.callTool({ name: 'antigravity_wait', arguments: { taskId: slow.task.taskId } }, undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending);
    assert.equal((await f.call('antigravity_result', { taskId: slow.task.taskId })).ready, false);
    await f.call('antigravity_cancel', { taskId: slow.task.taskId });
    assert.equal((await f.call('antigravity_wait', { taskId: slow.task.taskId, timeoutSeconds: 10 })).status, 'cancelled');
  } finally { await f.close(); }
});
