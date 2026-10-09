import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { outputSchemas } from '../dist/src/output-schemas.js';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw Error('Run with npm run test:package');
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agy-package-test-')));
const expectedFiles = [
  'package.json', 'bin/antigravity-mcp-bridge.mjs', 'plugin/server.mjs',
  'plugin/.codex-plugin/plugin.json', 'plugin/.mcp.json',
  'plugin/skills/antigravity/SKILL.md', 'plugin/skills/antigravity/agents/openai.yaml',
  'LICENSE', 'README.md', 'CHANGELOG.md', 'PRIVACY.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md',
].sort();

async function check(command, args, label) {
  const client = new Client({ name: 'package-test', version: '1' });
  const transport = new StdioClientTransport({ command, args, cwd: directory, stderr: 'pipe',
    env: { AGY_PATH: path.join(directory, 'missing-agy'), BRIDGE_STATE_DIRECTORY: path.join(directory, 'state-' + label) } });
  let diagnostics = '';
  transport.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000); });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, manifest.version);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), Object.keys(outputSchemas).sort());
    assert.ok(tools.tools.every(tool => !tool.name.includes('panel')));
    assert.equal(client.getServerCapabilities()?.resources, undefined);
    assert.ok(tools.tools.every(tool => tool.outputSchema?.type === 'object'));
    const health = await client.callTool({ name: 'antigravity_health', arguments: {} });
    assert.equal(health.isError, undefined, JSON.stringify(health.structuredContent));
    assert.equal(health.structuredContent.installed, false);
    assert.equal(typeof health.structuredContent.error, 'string');
    const auto = await client.callTool({ name: 'antigravity_set_model', arguments: { model: null } });
    assert.equal(auto.isError, undefined, JSON.stringify(auto.structuredContent));
    assert.equal(auto.structuredContent.model, null);
    console.log(`${label}: MCP startup, version, ${tools.tools.length} contracts, health and Auto passed`);
  } catch (error) {
    throw new Error(`${label}: ${String(error)}; stderr: ${diagnostics}`, { cause: error });
  } finally { await client.close(); }
}

function checkRuntimeStatus(command, args, label) {
  const output = execFileSync(command, [...args, '--windows-runtime-status'], {
    cwd: directory,
    env: { AGY_PATH: path.join(directory, 'missing-agy'), BRIDGE_STATE_DIRECTORY: path.join(directory, 'status-' + label) },
    encoding: 'utf8',
  });
  const status = JSON.parse(output);
  assert.ok(status && typeof status === 'object');
  assert.ok(status.requestedMode === 'system' || status.requestedMode === 'portable');
  assert.equal(typeof status.supported, 'boolean');
  assert.equal(typeof status.ready, 'boolean');
  assert.equal(typeof status.buildId, 'string');
  assert.equal(typeof status.nodeVersion, 'string');
  assert.equal(typeof status.libuvVersion, 'string');
  assert.ok(status.sha256 === null || typeof status.sha256 === 'string');
  if (status.error !== undefined) {
    assert.equal(typeof status.error.code, 'string');
    assert.equal(typeof status.error.message, 'string');
  }
  if (process.platform !== 'win32') assert.equal(status.supported, false);
  console.log(`${label}: read-only runtime status passed`);
}

try {
  const packed = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory], { encoding: 'utf8' }))[0];
  assert.deepEqual(packed.files.map(file => file.path).sort(), expectedFiles);
  assert.equal(packed.version, manifest.version);
  assert.equal(packed.bundled.length, 0);
  const archive = path.join(directory, packed.filename);
  assert.equal(path.dirname(archive), directory);
  const archivedFiles = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/).sort();
  assert.deepEqual(archivedFiles, expectedFiles.map(file => 'package/' + file).sort());
  execFileSync('tar', ['-xf', archive, '-C', directory]);
  const packagedManifest = JSON.parse(await readFile(path.join(directory, 'package/package.json'), 'utf8'));
  assert.equal(packagedManifest.private, undefined);
  assert.deepEqual(packagedManifest.dependencies ?? {}, {});
  assert.equal(packagedManifest.bin['antigravity-mcp-bridge'], 'bin/antigravity-mcp-bridge.mjs');
  assert.equal(JSON.parse(await readFile(path.join(directory, 'package/plugin/.codex-plugin/plugin.json'), 'utf8')).version, manifest.version);
  const bin = path.join(directory, 'package/bin/antigravity-mcp-bridge.mjs');
  assert.ok((await readFile(bin, 'utf8')).startsWith('#!/usr/bin/env node\n'));
  checkRuntimeStatus(process.execPath, [bin], 'tarball');
  await check(process.execPath, [bin], 'tarball');
  await check(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--offline', '--yes', '--ignore-scripts', '--cache', path.join(directory, 'cache'), '--package', archive, 'antigravity-mcp-bridge'], 'npx');
  console.log(`Package ${manifest.version}: exact ${expectedFiles.length}-file allowlist passed; no runtime dependency installation`);
} finally {
  if (path.relative(await realpath(os.tmpdir()), path.dirname(directory)) !== '' || !path.basename(directory).startsWith('agy-package-test-')) throw Error('Unsafe package-test cleanup path');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
