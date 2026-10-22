import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP bridge and SDK errors are redacted before reaching the client', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-redaction-test-'));
  const credential = 'gh' + 'p_' + 'A'.repeat(36);
  const client = new Client({ name: 'bridge-redaction-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('./mcp-fixture.js', import.meta.url))],
      env: { ...process.env as Record<string, string>, BRIDGE_TOOL_PROFILE: 'full', BRIDGE_STATE_DIRECTORY: path.join(dir, 'state') }, stderr: 'pipe' }));
    const exposed = (value: unknown) => JSON.stringify(value).includes(credential);

    const bridge = await client.callTool({ name: 'antigravity_run', arguments: {
      prompt: 'Benign validation probe', mode: 'read-only', workingDirectory: path.join(dir, 'missing-' + credential) } });
    assert.equal(bridge.isError, true);
    assert.equal((bridge.structuredContent as { error: { code: string } }).error.code, 'INVALID_WORKING_DIRECTORY');
    assert.equal(exposed(bridge), false);
    assert.match(JSON.stringify(bridge), /\[redacted\]/);

    const unknown = await client.callTool({ name: 'antigravity missing ' + credential, arguments: {} });
    assert.equal(unknown.isError, true);
    assert.equal(exposed(unknown), false);
    assert.match(JSON.stringify(unknown.content), /\[redacted\]/);

    const health = await client.callTool({ name: 'antigravity_health', arguments: {} });
    assert.equal(health.isError, undefined);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
