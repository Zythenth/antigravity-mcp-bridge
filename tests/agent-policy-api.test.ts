import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { nativeToolSchema, resolveAgentPolicy, resolvedAgentPolicySchema } from '../src/agent-policy.js';
import { applyRoleDefaults, listRoles, resolveRole } from '../src/roles.js';
import { successOutputSchemas } from '../src/output-schemas.js';
import { compactTask } from '../src/messages.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { TaskManager } from '../src/task-manager.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const namespace = '28c48913-763e-4ced-aee4-3fe6f0dd25eb';
const catalog = [{ id: 'fixture', nativeServerName: 'bridge-policy-probe', command: process.execPath, args: ['private-service.mjs'], env: { FIXTURE_KEY: 'synthetic-secret' }, tools: [{ name: 'echo', readOnly: true }, { name: 'write', readOnly: false }] }];
test('trusted configuration bounds native tools and private MCP transports; caller cannot supply transport', () => {
  const config = loadConfig({ BRIDGE_ALLOWED_AGY_TOOLS: '["view_file"]', BRIDGE_MCP_CATALOG: JSON.stringify(catalog) });
  assert.deepEqual(config.allowedAgyTools, ['view_file']);
  assert.throws(() => loadConfig({ BRIDGE_ALLOWED_AGY_TOOLS: '["run_command"]' }));
  assert.throws(() => resolveAgentPolicy({ allowedTools: ['write_to_file'] }, config.allowedAgyTools, config.mcpCatalog, 'write', namespace), { code: 'POLICY_NOT_ALLOWED' });
  assert.throws(() => resolveAgentPolicy({ mcpServers: [{ serverId: 'fixture', command: process.execPath }] } as never, config.allowedAgyTools, config.mcpCatalog, 'write', namespace), { code: 'POLICY_NOT_ALLOWED' });
});
test('native aliases remain stable across selections and only trusted catalog can choose them', () => {
  const a = resolveAgentPolicy({ mcpServers: [{ serverId: 'fixture', tools: ['echo'] }] }, nativeToolSchema.options, catalog, 'write', namespace);
  const b = resolveAgentPolicy({ mcpServers: [{ serverId: 'fixture' }] }, nativeToolSchema.options, catalog, 'write', namespace);
  assert.equal(a.mcpServers[0]!.serverName, 'bridge-policy-probe'); assert.equal(a.mcpServers[0]!.serverName, b.mcpServers[0]!.serverName);
  assert.equal(JSON.stringify(a).includes('synthetic-secret'), false); assert.equal(JSON.stringify(a).includes('private-service'), false);
  assert.throws(() => resolveAgentPolicy({ mcpServers: [{ serverId: 'fixture' }, { serverId: 'other' }] }, nativeToolSchema.options, [...catalog, { ...catalog[0]!, id: 'other' }], 'write', namespace), { code: 'POLICY_NOT_ALLOWED' });
});
test('resolved policy persistence rejects mutation and read-only writes, with compact public metadata', () => {
  const p = resolveAgentPolicy({ allowedTools: ['view_file'], mcpServers: [] }, nativeToolSchema.options, [], 'read-only', namespace);
  assert.deepEqual(resolvedAgentPolicySchema.parse(p), p);
  assert.equal(resolvedAgentPolicySchema.safeParse({ ...p, nativeTools: ['write_to_file', 'finish'] }).success, false);
  assert.equal(resolvedAgentPolicySchema.safeParse({ ...p, sha256: '0'.repeat(64) }).success, false);
  const t = { taskId: 'bcc7086b-f674-4b2d-825c-ff39c5635453', prompt: 'fixture', workingDirectory: path.resolve('project'), status: 'queued' as const, createdAt: new Date().toISOString(), agentPolicy: p, deliveryMode: 'messages' as const };
  assert.deepEqual(compactTask(t).agentPolicy, p); assert.deepEqual(successOutputSchemas.antigravity_run.parse({ task: compactTask(t) }).task.agentPolicy, p);
});
test('profile selectors snapshot defaults while explicit empty lists replace them', () => {
  const definition = { name: 'fixture', baseRole: 'implementer' as const, instruction: 'Inspect the fixture.', defaults: { allowedTools: ['view_file' as const], mcpServers: [{ serverId: 'fixture', tools: ['echo'] }] } };
  const role = resolveRole('fixture', [definition]);
  const options = { prompt: 'fixture', workingDirectory: path.resolve('project') };
  const defaults = applyRoleDefaults(options, role); assert.deepEqual(defaults.allowedTools, ['view_file']);
  definition.defaults.allowedTools.length = 0; assert.deepEqual(defaults.allowedTools, ['view_file']);
  assert.deepEqual(applyRoleDefaults({ ...options, allowedTools: [], mcpServers: [] }, role).mcpServers, []);
  assert.deepEqual(listRoles([role]).find(r => r.name === 'fixture')?.defaultMcpServers, [{ serverId: 'fixture', tools: ['echo'] }]);
});
test('catalog discovery returns IDs and ceilings without credentials or transport paths', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-policy-api-'));
  const config = loadConfig({ BRIDGE_MCP_CATALOG: JSON.stringify(catalog), BRIDGE_STATE_DIRECTORY: directory, BRIDGE_TEST_EXECUTOR: 'agy' });
  const tasks = new TaskManager(new CliAdapter(config), config);
  try {
    const result = successOutputSchemas.antigravity_get_agent_policy.parse(tasks.agentPolicyCatalog());
    assert.equal(result.mcpServers[0]!.nativeServerName, 'bridge-policy-probe');
    assert.equal(JSON.stringify(result).includes('synthetic-secret'), false); assert.equal(JSON.stringify(result).includes('private-service'), false);
  } finally { await tasks.shutdown(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await rm(directory, { recursive: true, force: true }); }
});
