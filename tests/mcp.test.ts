import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP subprocess restart recovers results, events, review baseline and discard', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-protocol-test-'));
  const source = path.join(dir, 'source');
  execFileSync('git', ['init', '--quiet', source]);
  await writeFile(path.join(source, 'source.txt'), 'original');
  let client: Client | undefined;
  async function connect(): Promise<Client> {
    const next = new Client({ name: 'bridge-contract-test', version: '1' });
    await next.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('./mcp-fixture.js', import.meta.url))],
      env: { ...process.env as Record<string, string>, BRIDGE_STATE_DIRECTORY: path.join(dir, 'state') }, stderr: 'pipe' }));
    return next;
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client!.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    return result.structuredContent as Record<string, any>;
  }
  try {
    client = await connect();
    const taskId = (await call('antigravity_run', { prompt: 'write:test', workingDirectory: source })).task.taskId;
    const deadline = Date.now() + 10000;
    let final;
    while (Date.now() < deadline) {
      final = await call('antigravity_result', { taskId });
      if (final.ready) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(final?.task.status, 'completed');
    const events = await call('antigravity_events', { taskId });
    await client.close();
    client = await connect();
    assert.equal((await call('antigravity_result', { taskId })).task.copyDirectory, final.task.copyDirectory);
    assert.deepEqual(await call('antigravity_events', { taskId }), events);
    assert.ok((await call('antigravity_tasks')).tasks.some((task: { taskId: string }) => task.taskId === taskId));
    await assert.rejects(readFile(path.join(source, 'AGY_BRIDGE_TEST.md')), { code: 'ENOENT' });
    const preview = await call('antigravity_preview', { taskId });
    assert.equal(preview.summary.added, 1);
    const testScript = "if (require('node:fs').readFileSync('AGY_BRIDGE_TEST.md','utf8') !== 'Antigravity MCP bridge test successful.') process.exit(1); console.log('file checked');";
    const output = execFileSync(process.execPath, ['-e', testScript], { cwd: final.task.copyDirectory, encoding: 'utf8' });
    await call('antigravity_record_test', { taskId, expectedSha256: preview.sha256, command: 'node -e ' + testScript, exitCode: 0, output });
    assert.equal((await call('antigravity_preview', { taskId })).tests[0].stale, false);
    await call('antigravity_integrate', { taskId, expectedSha256: preview.sha256 });
    assert.equal(await readFile(path.join(source, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'Antigravity MCP bridge test successful.');
    await call('antigravity_discard', { taskId });
    await assert.rejects(readFile(path.join(final.task.copyDirectory, 'source.txt')), { code: 'ENOENT' });
  } finally {
    await client?.close();
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('agy-mcp-protocol-test-'));
    await rm(dir, { recursive: true, force: true });
  }
});
