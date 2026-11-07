import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOL_ANNOTATIONS, toolAnnotationRow, toolAnnotations } from '../src/tool-annotations.js';
import { toolEnabled, type ToolProfile } from '../src/tool-profiles.js';

const profiles: readonly ToolProfile[] = ['full', 'query', 'review', 'implementation'];

async function listTools(profile: ToolProfile) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-annotations-test-'));
  const client = new Client({ name: 'annotations-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('./mcp-fixture.js', import.meta.url))],
      env: { ...process.env as Record<string, string>, BRIDGE_TOOL_PROFILE: profile, BRIDGE_STATE_DIRECTORY: path.join(directory, 'state') },
      stderr: 'pipe' }));
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('the annotation table refuses tools without a row', () => {
  assert.throws(() => toolAnnotationRow('antigravity_missing'), /has no row/);
  assert.throws(() => toolAnnotationRow('toString'), /has no row/);
  assert.deepEqual(Object.keys(toolAnnotations('antigravity_health')).sort(), ['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint']);
});

test('tools/list publishes exactly one table row per registered tool in every profile', async () => {
  const tableNames = Object.keys(TOOL_ANNOTATIONS).sort();
  for (const profile of profiles) {
    const tools = await listTools(profile);
    const names = tools.map(tool => tool.name);
    assert.equal(new Set(names).size, names.length, profile);
    assert.deepEqual([...names].sort(), tableNames.filter(name => toolEnabled(profile, name)), profile);
    for (const tool of tools) {
      assert.equal(tool.title, toolAnnotationRow(tool.name).title, tool.name);
      assert.deepEqual(tool.annotations, toolAnnotations(tool.name), tool.name);
    }
    if (profile === 'full') {
      assert.deepEqual([...names].sort(), tableNames);
      const read = tools.filter(tool => tool.annotations?.readOnlyHint === true).length;
      assert.deepEqual({ read, write: tools.length - read }, { read: 23, write: 27 });
    }
  }
});
