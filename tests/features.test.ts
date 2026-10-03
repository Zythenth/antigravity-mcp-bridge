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
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('agy-feature-test-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}

test('tool profiles reduce the MCP catalog and reject writes in query/review', async () => {
  assert.throws(() => loadConfig({ BRIDGE_TOOL_PROFILE: 'unknown' }));
  for (const [profile, count] of [['full', 23], ['query', 14], ['review', 17], ['implementation', 23]] as const) {
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
