import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SERVER_ICONS } from '../src/server-icons.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DATA_URI_PREFIX = 'data:image/png;base64,';

async function serverInfo() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'black-gravity-icons-test-'));
  const client = new Client({ name: 'icons-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('./mcp-fixture.js', import.meta.url))],
      env: { ...process.env as Record<string, string>, BRIDGE_STATE_DIRECTORY: path.join(directory, 'state') },
      stderr: 'pipe' }));
    return client.getServerVersion();
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('initialize returns serverInfo.icons as PNG data URIs for light and dark backgrounds', async () => {
  const info = await serverInfo();
  assert.ok(info);
  assert.deepEqual(Object.keys(info).sort(), ['icons', 'name', 'version']);
  assert.equal(info.name, 'black-gravity');
  assert.deepEqual(info.icons, SERVER_ICONS);
  assert.deepEqual([...new Set(info.icons?.map(icon => icon.theme))].sort(), ['dark', 'light']);
  for (const icon of info.icons ?? []) {
    assert.equal(icon.mimeType, 'image/png');
    assert.ok(icon.src.startsWith(DATA_URI_PREFIX), icon.src.slice(0, 40));
    const png = Buffer.from(icon.src.slice(DATA_URI_PREFIX.length), 'base64');
    assert.equal(png.toString('base64'), icon.src.slice(DATA_URI_PREFIX.length), 'data URI is canonical Base64');
    assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
    // The first chunk is IHDR, whose width and height must match the declared size.
    assert.equal(png.toString('latin1', 12, 16), 'IHDR');
    assert.deepEqual(icon.sizes, [`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`]);
  }
});
