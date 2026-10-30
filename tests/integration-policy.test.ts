import assert from 'node:assert/strict';
import test from 'node:test';
import fs, { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { preauthorizedIntegrationRoots, readPreauthorizedIntegrationRoots, integrationPreauthorized } from '../src/integration-policy.js';
import { StateStore } from '../src/state-store.js';
import {
  loadConfig,
  configurationWarning,
} from '../src/config.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { TaskManager } from '../src/task-manager.js';
import { createMcpServer } from '../src/mcp-server.js';
import { BridgeError } from '../src/types.js';
import { resolveAgentPolicy } from '../src/agent-policy.js';
import { prepareCraft } from '../src/craft.js';
import { portableNodeStatus, preparePortableNodeRuntime } from '../src/portable-node.js';
import { validateRuntimeCacheSeparation } from '../src/validation.js';
import { executeWindowsTest } from '../src/windows-executor.js';

const mockPath = fileURLToPath(new URL('../../tests/mock-agy.mjs', import.meta.url));
const fixturePath = fileURLToPath(new URL('./mcp-fixture.js', import.meta.url));

async function waitFor(ready: () => boolean | Promise<boolean>, describe: () => unknown) {
  const deadline = Date.now() + 120000;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`Condition timed out: ${JSON.stringify(await describe())}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

test('preauthorization is explicit, canonical, exact and excludes descendant projects', () => {
  assert.deepEqual(preauthorizedIntegrationRoots(), []);
  const root = realpathSync.native(process.cwd());
  const roots = preauthorizedIntegrationRoots(JSON.stringify([root, root]));
  assert.equal(roots.length, 1);
  assert.equal(integrationPreauthorized(root, roots), true);
  assert.equal(integrationPreauthorized(path.join(root, 'nested-project'), roots), false);
  assert.equal(integrationPreauthorized(root + '-sibling', roots), false);
  assert.throws(() => preauthorizedIntegrationRoots('true'));
  assert.throws(() => preauthorizedIntegrationRoots('["relative"]'));
  assert.throws(() => preauthorizedIntegrationRoots(JSON.stringify([path.parse(root).root])));
  assert.throws(() => preauthorizedIntegrationRoots(JSON.stringify(Array(21).fill(root))));
});


test('Windows short aliases resolve to the same project identity as asynchronous task validation', { skip: process.platform !== 'win32' }, async t => {
  const alias = path.join(path.parse(process.env.ProgramFiles ?? process.cwd()).root, 'PROGRA~1');
  if (!existsSync(alias)) return t.skip('This Windows volume has no Program Files short alias');
  const canonical = await realpath(alias);
  const roots = preauthorizedIntegrationRoots(JSON.stringify([alias, canonical]));
  assert.deepEqual(roots, [canonical.toLowerCase()]);
  assert.equal(integrationPreauthorized(canonical, roots), true);
  assert.equal(integrationPreauthorized(path.join(canonical, 'different-project'), roots), false);
});

test('remembered roots persist exactly, merge under a lock and can be revoked locally', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-integration-approval-'));
  try {
    const first = path.join(directory, 'first'), second = path.join(directory, 'second');
    mkdirSync(first); mkdirSync(second);
    const state = new StateStore(path.join(directory, 'state'));
    const other = new StateStore(path.join(directory, 'state'));
    assert.deepEqual(state.loadIntegrationRoots(), []);
    state.rememberIntegrationRoot(first);
    state.rememberIntegrationRoot(first);
    const release = state.acquire('integration-approvals');
    try { assert.throws(() => other.rememberIntegrationRoot(second), { code: 'STATE_BUSY' }); }
    finally { release(); }
    other.rememberIntegrationRoot(second);
    const roots = preauthorizedIntegrationRoots(JSON.stringify([first, second]));
    assert.deepEqual(new StateStore(path.join(directory, 'state')).loadIntegrationRoots(), roots);
    assert.equal(integrationPreauthorized(path.join(first, 'nested'), roots), false);
    assert.equal(integrationPreauthorized(first + '-sibling', roots), false);
    unlinkSync(path.join(directory, 'state', 'integration-approvals.json'));
    assert.deepEqual(state.loadIntegrationRoots(), []);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('agy-integration-approval-'));
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('remembered roots reject corrupt, oversized, noncanonical and linked state without replacement', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-integration-approval-'));
  try {
    const state = new StateStore(directory);
    const file = path.join(directory, 'integration-approvals.json');
    const root = preauthorizedIntegrationRoots(JSON.stringify([directory]))[0]!;
    for (const contents of ['{', 'x'.repeat(128 * 1024 + 1),
      ...[
        { version: 1, roots: ['relative'] }, { version: 1, roots: [path.parse(root).root] },
        { version: 1, roots: [root + path.sep + '..'] }, { version: 1, roots: Array(21).fill(root) },
        { version: 1, roots: [root], extra: true }, { version: 2, roots: [root] },
      ].map(value => JSON.stringify(value))]) {
      writeFileSync(file, contents);
      assert.throws(() => state.loadIntegrationRoots(), { code: 'INVALID_STATE' });
      assert.throws(() => state.rememberIntegrationRoot(directory), { code: 'INVALID_STATE' });
      assert.equal(readFileSync(file, 'utf8'), contents);
    }
    unlinkSync(file);
    const outside = path.join(directory, 'other.json');
    const valid = JSON.stringify({ version: 1, roots: [root] });
    writeFileSync(outside, valid);
    linkSync(outside, file);
    assert.throws(() => state.loadIntegrationRoots(), { code: 'INVALID_STATE' });
    assert.throws(() => state.rememberIntegrationRoot(directory), { code: 'INVALID_STATE' });
    assert.equal(readFileSync(outside, 'utf8'), valid);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('agy-integration-approval-'));
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('loadConfig validates BRIDGE_APPROVAL_MODE defaulting to auto, accepting ask, and rejecting invalid modes', () => {
  assert.equal(loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off' }).approvalMode, 'auto');
  assert.equal(loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_APPROVAL_MODE: 'auto' }).approvalMode, 'auto');
  assert.equal(loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_APPROVAL_MODE: 'ask' }).approvalMode, 'ask');
  for (const invalid of ['', 'manual', 'prompt', 'true', 'false', 'AUTO', 'ASK', '1']) {
    assert.throws(() => loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_APPROVAL_MODE: invalid }), {
      message: 'BRIDGE_APPROVAL_MODE must be auto or ask',
    });
  }
});

test('MCP server instructions and health accurately expose automatic versus ask mode', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-approval-instructions-test-'));
  try {
    const configAuto = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', AGY_PATH: process.execPath, BRIDGE_STATE_DIRECTORY: path.join(directory, 'state-auto') });
    const adapterAuto = new CliAdapter(configAuto, [mockPath]);
    const tasksAuto = new TaskManager(adapterAuto, configAuto);
    const serverAuto = createMcpServer(adapterAuto, tasksAuto);
    const [clientTransportAuto, serverTransportAuto] = InMemoryTransport.createLinkedPair();
    const clientAuto = new Client({ name: 'test-auto', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([
      serverAuto.connect(serverTransportAuto),
      clientAuto.connect(clientTransportAuto),
    ]);
    assert.equal(tasksAuto.approvalMode, 'auto');
    const autoInstructions = clientAuto.getInstructions();
    assert.ok(autoInstructions?.includes('BRIDGE_APPROVAL_MODE=auto'));
    assert.ok(autoInstructions?.includes('authorized automatically without human forms'));

    const configAsk = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', AGY_PATH: process.execPath, BRIDGE_APPROVAL_MODE: 'ask', BRIDGE_STATE_DIRECTORY: path.join(directory, 'state-ask') });
    const adapterAsk = new CliAdapter(configAsk, [mockPath]);
    const tasksAsk = new TaskManager(adapterAsk, configAsk);
    const serverAsk = createMcpServer(adapterAsk, tasksAsk);
    const [clientTransportAsk, serverTransportAsk] = InMemoryTransport.createLinkedPair();
    const clientAsk = new Client({ name: 'test-ask', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([
      serverAsk.connect(serverTransportAsk),
      clientAsk.connect(clientTransportAsk),
    ]);
    assert.equal(tasksAsk.approvalMode, 'ask');
    const askInstructions = clientAsk.getInstructions();
    assert.ok(askInstructions?.includes('BRIDGE_APPROVAL_MODE=ask'));
    assert.ok(askInstructions?.includes('human confirmation forms are always required'));

    await clientAuto.close();
    await clientAsk.close();
    await serverAuto.close();
    await serverAsk.close();
    await tasksAuto.shutdown();
    await tasksAsk.shutdown();
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('automatic mode integrates and updates sandbox policy without forms or elicitation', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-auto-mode-test-'));
  const source = path.join(directory, 'source');
  execFileSync('git', ['init', '--quiet', source]);
  writeFileSync(path.join(source, 'source.txt'), 'original');
  const client = new Client({ name: 'auto-test', version: '1' }, { capabilities: {} });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    return result.structuredContent as Record<string, any>;
  };
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fixturePath],
      env: { ...process.env as Record<string, string>, BRIDGE_APPROVAL_MODE: 'auto', BRIDGE_TOOL_PROFILE: 'full', BRIDGE_STATE_DIRECTORY: path.join(directory, 'state') },
      stderr: 'pipe',
    }));
    const health = await call('antigravity_health');
    assert.equal(health.approvalMode, 'auto');
    assert.equal(health.integrationApproval.mode, 'auto');
    assert.equal(health.integrationApproval.method, 'automatic');
    assert.equal(health.integrationApproval.available, true);

    const initialPolicy = await call('antigravity_get_sandbox_policy');
    const updatedPolicy = await call('antigravity_set_sandbox_policy', {
      policy: { ...initialPolicy.policy, childProcesses: false, maxOutputChars: 512 },
      expectedSha256: initialPolicy.sha256,
    });
    assert.equal(updatedPolicy.policy.childProcesses, false);
    assert.equal(updatedPolicy.policy.maxOutputChars, 512);

    const run = await call('antigravity_run', {
      prompt: 'write:test',
      workingDirectory: source,
      acceptanceCriteria: [{ id: 'created', description: 'Create file', check: { kind: 'file-contains', path: 'AGY_BRIDGE_TEST.md', text: 'successful.' } }],
    });
    await waitFor(async () => (await call('antigravity_result', { taskId: run.task.taskId })).ready === true, async () => { const { ready, status } = await call('antigravity_result', { taskId: run.task.taskId }); return { ready, status }; });
    const preview = await call('antigravity_preview', { taskId: run.task.taskId });
    await call('antigravity_verify', {
      taskId: run.task.taskId,
      expectedSha256: preview.sha256,
      reviews: [{ criterionId: 'created', verdict: 'passed', path: 'AGY_BRIDGE_TEST.md', line: 1, quote: 'Antigravity MCP bridge test successful.', explanation: 'Verified' }],
    });
    const integrated = await call('antigravity_integrate', { taskId: run.task.taskId, expectedSha256: preview.sha256 });
    assert.equal(integrated.summary.added, 1);
    assert.equal(readFileSync(path.join(source, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'Antigravity MCP bridge test successful.');
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('automatic mode preserves verification, test evidence, readonly and review change guards', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-auto-guards-test-'));
  const source = path.join(directory, 'source');
  execFileSync('git', ['init', '--quiet', source]);
  writeFileSync(path.join(source, 'source.txt'), 'original');
  const config = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', AGY_PATH: process.execPath, BRIDGE_STATE_DIRECTORY: path.join(directory, 'state') });
  const adapter = new CliAdapter(config, [mockPath]);
  const tasks = new TaskManager(adapter, config);
  try {
    await adapter.discover();
    const initialPolicy = tasks.getSandboxPolicy();
    await assert.rejects(tasks.setSandboxPolicy({ ...initialPolicy.policy, childProcesses: false }, '0'.repeat(64)),
      { code: 'SANDBOX_POLICY_CHANGED' });

    const roTask = await tasks.run({ prompt: 'slow:test', workingDirectory: source, mode: 'read-only' });
    await waitFor(() => tasks.status(roTask.taskId).status === 'completed', () => tasks.status(roTask.taskId).status);
    await assert.rejects(tasks.integrate(roTask.taskId, '0'.repeat(64)), { code: 'READ_ONLY_TASK' });

    const writeTask = await tasks.run({
      prompt: 'write:test',
      workingDirectory: source,
      acceptanceCriteria: [{ id: 'created', description: 'Create file', check: { kind: 'file-contains', path: 'AGY_BRIDGE_TEST.md', text: 'successful.' } }],
    });
    await waitFor(() => tasks.status(writeTask.taskId).status === 'completed', () => tasks.status(writeTask.taskId).status);
    const preview = await tasks.preview(writeTask.taskId);
    await assert.rejects(tasks.integrate(writeTask.taskId, preview.sha256), { code: 'VERIFICATION_REQUIRED' });

    await assert.rejects(tasks.integrate(writeTask.taskId, '1'.repeat(64)), { code: 'REVIEW_CHANGED' });

    await tasks.verify(writeTask.taskId, preview.sha256, [
      { criterionId: 'created', verdict: 'passed', path: 'AGY_BRIDGE_TEST.md', line: 1, quote: 'Antigravity MCP bridge test successful.', explanation: 'Verified' },
    ]);
    const taskCopy = tasks.status(writeTask.taskId).copyDirectory!;
    writeFileSync(path.join(taskCopy, 'AGY_BRIDGE_TEST.md'), 'tampered content');
    await assert.rejects(tasks.integrate(writeTask.taskId, preview.sha256), { code: 'REVIEW_CHANGED' });
  } finally {
    await tasks.shutdown();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('ask mode requires forms, handles accept/deny/unavailable, and prevents remembered roots from bypassing ask', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-ask-guards-test-'));
  const source = path.join(directory, 'source');
  execFileSync('git', ['init', '--quiet', source]);
  writeFileSync(path.join(source, 'source.txt'), 'original');

  const config = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off',
    AGY_PATH: process.execPath,
    BRIDGE_APPROVAL_MODE: 'ask',
    BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS: JSON.stringify([source]),
    BRIDGE_STATE_DIRECTORY: path.join(directory, 'state'),
  });
  const adapter = new CliAdapter(config, [mockPath]);
  const tasks = new TaskManager(adapter, config);
  try {
    await adapter.discover();
    const initialPolicy = tasks.getSandboxPolicy();
    const proposal = { ...initialPolicy.policy, childProcesses: false, maxOutputChars: 256 };

    await assert.rejects(tasks.setSandboxPolicy(proposal, initialPolicy.sha256), { code: 'APPROVAL_REQUIRED' });
    await assert.rejects(tasks.setSandboxPolicy(proposal, initialPolicy.sha256, async () => false), { code: 'APPROVAL_DENIED' });
    const updated = await tasks.setSandboxPolicy(proposal, initialPolicy.sha256, async () => true);
    assert.equal(updated.policy.childProcesses, false);

    const writeTask = await tasks.run({
      prompt: 'write:test',
      workingDirectory: source,
      acceptanceCriteria: [{ id: 'created', description: 'Create file', check: { kind: 'file-contains', path: 'AGY_BRIDGE_TEST.md', text: 'successful.' } }],
    });
    await waitFor(() => tasks.status(writeTask.taskId).status === 'completed', () => tasks.status(writeTask.taskId).status);
    const preview = await tasks.preview(writeTask.taskId);
    await tasks.verify(writeTask.taskId, preview.sha256, [
      { criterionId: 'created', verdict: 'passed', path: 'AGY_BRIDGE_TEST.md', line: 1, quote: 'Antigravity MCP bridge test successful.', explanation: 'Verified' },
    ]);

    assert.equal(tasks.integrationPreauthorized(writeTask.taskId), true);
    await assert.rejects(tasks.integrate(writeTask.taskId, preview.sha256), { code: 'APPROVAL_REQUIRED' });

    await assert.rejects(tasks.integrate(writeTask.taskId, preview.sha256, async () => false), { code: 'APPROVAL_DENIED' });

    const integrated = await tasks.integrate(writeTask.taskId, preview.sha256, async () => ({ confirmed: true, rememberProject: true }));
    assert.equal(integrated.summary.added, 1);
    assert.equal(readFileSync(path.join(source, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'Antigravity MCP bridge test successful.');
  } finally {
    await tasks.shutdown();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  const mcpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-ask-mcp-test-'));
  const mcpSource = path.join(mcpDir, 'source');
  execFileSync('git', ['init', '--quiet', mcpSource]);
  writeFileSync(path.join(mcpSource, 'source.txt'), 'original');
  const state = new StateStore(path.join(mcpDir, 'state'));
  state.rememberIntegrationRoot(mcpSource);

  const unavailableClient = new Client({ name: 'ask-no-elicitation', version: '1' }, { capabilities: {} });
  try {
    await unavailableClient.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fixturePath],
      env: { ...process.env as Record<string, string>, BRIDGE_APPROVAL_MODE: 'ask', BRIDGE_TOOL_PROFILE: 'full', BRIDGE_STATE_DIRECTORY: path.join(mcpDir, 'state') },
      stderr: 'pipe',
    }));
    const health = (await unavailableClient.callTool({ name: 'antigravity_health', arguments: {} })).structuredContent as any;
    assert.equal(health.approvalMode, 'ask');
    assert.equal(health.integrationApproval.mode, 'ask');
    assert.equal(health.integrationApproval.preauthorizedProjectCount, 1);

    const getPolicy = (await unavailableClient.callTool({ name: 'antigravity_get_sandbox_policy', arguments: {} })).structuredContent as any;
    const policyDenied = await unavailableClient.callTool({
      name: 'antigravity_set_sandbox_policy',
      arguments: { policy: { ...getPolicy.policy, childProcesses: false }, expectedSha256: getPolicy.sha256 },
    });
    assert.equal((policyDenied.structuredContent as any).error.code, 'APPROVAL_UNAVAILABLE');

    const run = (await unavailableClient.callTool({
      name: 'antigravity_run',
      arguments: {
        prompt: 'write:test',
        workingDirectory: mcpSource,
        acceptanceCriteria: [{ id: 'created', description: 'Create file', check: { kind: 'file-contains', path: 'AGY_BRIDGE_TEST.md', text: 'successful.' } }],
      },
    })).structuredContent as any;
    await waitFor(async () => ((await unavailableClient.callTool({ name: 'antigravity_result', arguments: { taskId: run.task.taskId } })).structuredContent as any).ready === true, async () => { const { ready, status } = ((await unavailableClient.callTool({ name: 'antigravity_result', arguments: { taskId: run.task.taskId } })).structuredContent as any); return { ready, status }; });
    const preview = (await unavailableClient.callTool({ name: 'antigravity_preview', arguments: { taskId: run.task.taskId } })).structuredContent as any;
    await unavailableClient.callTool({
      name: 'antigravity_verify',
      arguments: {
        taskId: run.task.taskId,
        expectedSha256: preview.sha256,
        reviews: [{ criterionId: 'created', verdict: 'passed', path: 'AGY_BRIDGE_TEST.md', line: 1, quote: 'Antigravity MCP bridge test successful.', explanation: 'Verified' }],
      },
    });

    // Even with remembered root in state, calling integrate on client without elicitation fails with APPROVAL_UNAVAILABLE in ask mode
    const integrateDenied = await unavailableClient.callTool({
      name: 'antigravity_integrate',
      arguments: { taskId: run.task.taskId, expectedSha256: preview.sha256 },
    });
    assert.equal((integrateDenied.structuredContent as any).error.code, 'APPROVAL_UNAVAILABLE');
  } finally {
    await unavailableClient.close();
  }

  // Client with elicitation in ask mode: decline yields APPROVAL_DENIED, accept yields success
  let formAction: 'accept' | 'decline' = 'decline';
  let formConfirm = false;
  const elicitationClient = new Client({ name: 'ask-with-elicitation', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  elicitationClient.setRequestHandler(ElicitRequestSchema, async request => {
    assert.equal(request.params.mode, 'form');
    if (request.params.mode !== 'form') throw new Error('Unexpected elicitation mode');
    assert.equal(request.params.requestedSchema.properties.confirm?.default, false);
    assert.equal(request.params.requestedSchema.properties.rememberProject, undefined);
    return formAction === 'accept' ? { action: 'accept', content: { confirm: formConfirm } } : { action: 'decline' };
  });
  await elicitationClient.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fixturePath],
    env: { ...process.env as Record<string, string>, BRIDGE_APPROVAL_MODE: 'ask', BRIDGE_TOOL_PROFILE: 'full', BRIDGE_STATE_DIRECTORY: path.join(mcpDir, 'state') },
    stderr: 'pipe',
  }));
  try {
    const run = (await elicitationClient.callTool({
      name: 'antigravity_run',
      arguments: {
        prompt: 'write:test',
        workingDirectory: mcpSource,
        acceptanceCriteria: [{ id: 'created', description: 'Create file', check: { kind: 'file-contains', path: 'AGY_BRIDGE_TEST.md', text: 'successful.' } }],
      },
    })).structuredContent as any;
    await waitFor(async () => ((await elicitationClient.callTool({ name: 'antigravity_result', arguments: { taskId: run.task.taskId } })).structuredContent as any).ready === true, async () => { const { ready, status } = ((await elicitationClient.callTool({ name: 'antigravity_result', arguments: { taskId: run.task.taskId } })).structuredContent as any); return { ready, status }; });
    const preview = (await elicitationClient.callTool({ name: 'antigravity_preview', arguments: { taskId: run.task.taskId } })).structuredContent as any;
    await elicitationClient.callTool({
      name: 'antigravity_verify',
      arguments: {
        taskId: run.task.taskId,
        expectedSha256: preview.sha256,
        reviews: [{ criterionId: 'created', verdict: 'passed', path: 'AGY_BRIDGE_TEST.md', line: 1, quote: 'Antigravity MCP bridge test successful.', explanation: 'Verified' }],
      },
    });

    const deniedRes = await elicitationClient.callTool({
      name: 'antigravity_integrate',
      arguments: { taskId: run.task.taskId, expectedSha256: preview.sha256 },
    });
    assert.equal((deniedRes.structuredContent as any).error.code, 'APPROVAL_DENIED');

    formAction = 'accept';
    formConfirm = true;
    const acceptRes = (await elicitationClient.callTool({
      name: 'antigravity_integrate',
      arguments: { taskId: run.task.taskId, expectedSha256: preview.sha256 },
    })).structuredContent as any;
    assert.equal(acceptRes.summary.added, 1);
    assert.equal(readFileSync(path.join(mcpSource, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'Antigravity MCP bridge test successful.');
  } finally {
    await elicitationClient.close();
    rmSync(mcpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('readPreauthorizedIntegrationRoots reports each issue reason correctly', () => {
  assert.deepEqual(readPreauthorizedIntegrationRoots(undefined), { roots: [], issues: [] });
  assert.deepEqual(readPreauthorizedIntegrationRoots('{'), {
    roots: [],
    issues: [{ variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', reason: 'invalid-json' }],
  });
  assert.deepEqual(readPreauthorizedIntegrationRoots(''), {
    roots: [],
    issues: [{ variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', reason: 'invalid-json' }],
  });
  assert.deepEqual(readPreauthorizedIntegrationRoots('true'), {
    roots: [],
    issues: [{ variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', reason: 'not-a-list' }],
  });
  assert.deepEqual(readPreauthorizedIntegrationRoots('{}'), {
    roots: [],
    issues: [{ variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', reason: 'not-a-list' }],
  });
  assert.deepEqual(readPreauthorizedIntegrationRoots(JSON.stringify(Array(21).fill(process.cwd()))), {
    roots: [],
    issues: [{ variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', reason: 'too-many-entries' }],
  });
  assert.deepEqual(readPreauthorizedIntegrationRoots(JSON.stringify([42])), {
    roots: [],
    issues: [{ variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', index: 0, reason: 'not-a-string' }],
  });
  assert.deepEqual(readPreauthorizedIntegrationRoots(JSON.stringify(['relative'])), {
    roots: [],
    issues: [{ variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', index: 0, reason: 'not-absolute' }],
  });
  const nonexistent = path.join(process.cwd(), 'nonexistent-directory-' + Date.now());
  assert.deepEqual(readPreauthorizedIntegrationRoots(JSON.stringify([nonexistent])), {
    roots: [],
    issues: [{ variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', index: 0, reason: 'not-found' }],
  });
  const fileEntry = fileURLToPath(import.meta.url);
  assert.deepEqual(readPreauthorizedIntegrationRoots(JSON.stringify([fileEntry])), {
    roots: [],
    issues: [{ variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', index: 0, reason: 'not-a-directory' }],
  });
  const volumeRoot = path.parse(process.cwd()).root;
  assert.deepEqual(readPreauthorizedIntegrationRoots(JSON.stringify([volumeRoot])), {
    roots: [],
    issues: [{ variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', index: 0, reason: 'volume-root' }],
  });
  const nullByteEntry = process.platform === 'win32' ? 'C:\\a\0b' : '/a\0b';
  assert.deepEqual(readPreauthorizedIntegrationRoots(JSON.stringify([nullByteEntry])), {
    roots: [],
    issues: [{ variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', index: 0, reason: 'unresolvable' }],
  });
});

test('readPreauthorizedIntegrationRoots reports access-denied for inaccessible paths on POSIX', t => {
  if (process.platform === 'win32') {
    return t.skip('Windows does not fail realpath with access-denied for 0o000 permissions');
  }
  if (process.getuid?.() === 0) {
    return t.skip('Root user bypasses filesystem permission checks');
  }
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agy-perm-test-'));
  const parent = path.join(tempDir, 'no-access');
  const child = path.join(parent, 'child');
  mkdirSync(child, { recursive: true });
  const unreadable = path.join(tempDir, 'unreadable');
  mkdirSync(unreadable);
  try {
    chmodSync(parent, 0o000);
    const result = readPreauthorizedIntegrationRoots(JSON.stringify([child]));
    assert.deepEqual(result.roots, []);
    assert.deepEqual(result.issues, [
      { variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', index: 0, reason: 'access-denied' },
    ]);

    chmodSync(unreadable, 0o000);
    const unreadableResult = readPreauthorizedIntegrationRoots(JSON.stringify([unreadable]));
    assert.deepEqual(unreadableResult.roots, []);
    assert.deepEqual(unreadableResult.issues, [
      { variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', index: 0, reason: 'access-denied' },
    ]);
  } finally {
    try { chmodSync(parent, 0o700); } catch { /* ignore */ }
    try { chmodSync(unreadable, 0o700); } catch { /* ignore */ }
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('readPreauthorizedIntegrationRoots reports access-denied for directories without list permission on Windows', { skip: process.platform !== 'win32' }, t => {
  const username = process.env.USERNAME;
  if (!username) return t.skip('USERNAME environment variable is not set');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-win-perm-test-'));
  try {
    execFileSync('icacls', [directory, '/deny', `${username}:(RD)`]);
    const result = readPreauthorizedIntegrationRoots(JSON.stringify([directory]));
    assert.deepEqual(result.roots, []);
    assert.deepEqual(result.issues, [
      { variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', index: 0, reason: 'access-denied' },
    ]);
  } finally {
    try { execFileSync('icacls', [directory, '/remove:d', username]); } catch { /* ignore */ }
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('readPreauthorizedIntegrationRoots handles mixed lists without permissions widening or path leakage', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-mixed-roots-'));
  try {
    const valid = path.join(directory, 'valid');
    mkdirSync(valid);
    const canonicalValid = process.platform === 'win32' ? realpathSync.native(valid).toLowerCase() : realpathSync.native(valid);
    const nonexistent1 = path.join(directory, 'nonexistent');
    const nonexistent2 = path.join(valid, 'sub-nonexistent');

    const result = readPreauthorizedIntegrationRoots(JSON.stringify([nonexistent1, valid, nonexistent2]));
    assert.deepEqual(result.roots, [canonicalValid]);
    assert.deepEqual(result.issues, [
      { variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', index: 0, reason: 'not-found' },
      { variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', index: 2, reason: 'not-found' },
    ]);

    assert.equal(integrationPreauthorized(directory, result.roots), false);
    assert.equal(integrationPreauthorized(valid + '-sibling', result.roots), false);

    const issuesJson = JSON.stringify(result.issues);
    for (const p of [nonexistent1, valid, nonexistent2, directory]) {
      assert.equal(issuesJson.includes(p), false);
      assert.equal(issuesJson.includes(JSON.stringify(p).slice(1, -1)), false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('loadConfig tolerates invalid BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS and configurationWarning formats properly', () => {
  const config = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS: '{' });
  assert.deepEqual(config.preauthorizedIntegrationRoots, []);
  assert.deepEqual(config.configurationIssues, [
    { variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', reason: 'invalid-json' },
  ]);

  assert.equal(configurationWarning([]), undefined);

  const singleWarning = configurationWarning(config.configurationIssues);
  assert.ok(singleWarning);
  assert.equal(singleWarning?.includes('\n'), false);
  assert.equal(singleWarning?.includes('{'), false);
  assert.equal(singleWarning, 'Invalid configuration entries were ignored or made the affected feature unavailable (nothing was granted from them): BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS invalid-json. See configurationIssues in antigravity_health.');

  const sampleIssues = [
    { variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', index: 0, reason: 'not-found' as const },
    { variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', reason: 'invalid-json' as const },
  ];
  const warning = configurationWarning(sampleIssues);
  assert.equal(warning, 'Invalid configuration entries were ignored or made the affected feature unavailable (nothing was granted from them): BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS[0] not-found, BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS invalid-json. See configurationIssues in antigravity_health.');
  assert.equal(warning?.includes('\n'), false);
});

test('ask mode with invalid preauthorized root requires confirmation and does not preauthorize task project', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-ask-invalid-root-'));
  const source = path.join(directory, 'source');
  const otherValid = path.join(directory, 'other-valid');
  execFileSync('git', ['init', '--quiet', source]);
  mkdirSync(otherValid);
  writeFileSync(path.join(source, 'source.txt'), 'original');

  const config = loadConfig({
    BRIDGE_ANTI_AI_CRAFT: 'off',
    AGY_PATH: process.execPath,
    BRIDGE_APPROVAL_MODE: 'ask',
    BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS: JSON.stringify([source + '-renamed', otherValid]),
    BRIDGE_STATE_DIRECTORY: path.join(directory, 'state'),
  });
  const adapter = new CliAdapter(config, [mockPath]);
  const tasks = new TaskManager(adapter, config);
  try {
    await adapter.discover();
    assert.equal(tasks.preauthorizedProjectCount, 1);

    const writeTask = await tasks.run({
      prompt: 'write:test',
      workingDirectory: source,
      acceptanceCriteria: [{ id: 'created', description: 'Create file', check: { kind: 'file-contains', path: 'AGY_BRIDGE_TEST.md', text: 'successful.' } }],
    });
    await waitFor(() => tasks.status(writeTask.taskId).status === 'completed', () => tasks.status(writeTask.taskId).status);
    const preview = await tasks.preview(writeTask.taskId);
    await tasks.verify(writeTask.taskId, preview.sha256, [
      { criterionId: 'created', verdict: 'passed', path: 'AGY_BRIDGE_TEST.md', line: 1, quote: 'Antigravity MCP bridge test successful.', explanation: 'Verified' },
    ]);

    assert.equal(tasks.integrationPreauthorized(writeTask.taskId), false);
    await assert.rejects(tasks.integrate(writeTask.taskId, preview.sha256), { code: 'APPROVAL_REQUIRED' });

    const integrated = await tasks.integrate(writeTask.taskId, preview.sha256, async () => true);
    assert.equal(integrated.summary.added, 1);
    assert.equal(readFileSync(path.join(source, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'Antigravity MCP bridge test successful.');
  } finally {
    await tasks.shutdown();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('server startup handles invalid BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS with single warning and health report', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-server-roots-test-'));
  const entryPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const nonexistentAgy = path.join(tmpDir, 'nonexistent-agy');
  const nonexistentRoot = path.join(tmpDir, 'nonexistent-root');
  const validRoot = path.join(tmpDir, 'valid-root');
  mkdirSync(validRoot);

  let client: Client | undefined;
  let client2: Client | undefined;
  let client3: Client | undefined;
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entryPath],
      env: {
        ...process.env as Record<string, string>,
        BRIDGE_ANTI_AI_CRAFT: 'off',
        AGY_PATH: nonexistentAgy,
        BRIDGE_STATE_DIRECTORY: path.join(tmpDir, 'state'),
        BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS: JSON.stringify([nonexistentRoot, validRoot]),
      },
      stderr: 'pipe',
    });
    let stderrData = '';
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      stderrData += chunk.toString();
    });

    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const health1 = (await client.callTool({ name: 'antigravity_health', arguments: {} })).structuredContent as any;
    assert.deepEqual(health1.configurationIssues, [
      { variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', index: 0, reason: 'not-found' },
    ]);
    assert.equal(health1.integrationApproval.preauthorizedProjectCount, 1);

    const health2 = (await client.callTool({ name: 'antigravity_health', arguments: {} })).structuredContent as any;
    assert.deepEqual(health2.configurationIssues, [
      { variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', index: 0, reason: 'not-found' },
    ]);
    assert.equal(health2.integrationApproval.preauthorizedProjectCount, 1);

    const expectedWarning = configurationWarning([
      { variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', index: 0, reason: 'not-found' },
    ])!;
    assert.ok(expectedWarning);
    await waitFor(() => stderrData.includes(expectedWarning), () => stderrData);
    assert.equal(stderrData.split(expectedWarning).length - 1, 1);
    assert.equal(stderrData.includes(nonexistentRoot), false);

    await client.close();
    client = undefined;

    const transport2 = new StdioClientTransport({
      command: process.execPath,
      args: [entryPath],
      env: {
        ...process.env as Record<string, string>,
        BRIDGE_ANTI_AI_CRAFT: 'off',
        AGY_PATH: nonexistentAgy,
        BRIDGE_STATE_DIRECTORY: path.join(tmpDir, 'state2'),
        BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS: '{',
      },
      stderr: 'pipe',
    });

    client2 = new Client({ name: 'test-client-malformed', version: '1.0.0' }, { capabilities: {} });
    await client2.connect(transport2);

    const healthMalformed = (await client2.callTool({ name: 'antigravity_health', arguments: {} })).structuredContent as any;
    assert.deepEqual(healthMalformed.configurationIssues, [
      { variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', reason: 'invalid-json' },
    ]);

    await client2.close();
    client2 = undefined;

    const state3Dir = path.join(tmpDir, 'state3');
    mkdirSync(state3Dir, { recursive: true });
    const canonicalValidRoot = process.platform === 'win32' ? realpathSync.native(validRoot).toLowerCase() : realpathSync.native(validRoot);
    writeFileSync(path.join(state3Dir, 'integration-approvals.json'), JSON.stringify({ version: 1, roots: ['relative-path', canonicalValidRoot] }));

    const transport3 = new StdioClientTransport({
      command: process.execPath,
      args: [entryPath],
      env: {
        ...process.env as Record<string, string>,
        BRIDGE_ANTI_AI_CRAFT: 'off',
        AGY_PATH: nonexistentAgy,
        BRIDGE_STATE_DIRECTORY: state3Dir,
        BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS: JSON.stringify([nonexistentRoot, validRoot]),
        BRIDGE_ALLOWED_ENV_VARS: JSON.stringify(['NODE_OPTIONS', 'MY_VALID_ENV']),
        BRIDGE_SECRET_EXCEPTIONS: JSON.stringify({ version: 2, namePatterns: ['/invalid/abs', 'valid/*.doc'] }),
        BRIDGE_MCP_CATALOG: JSON.stringify([{ id: 'bad-entry', badField: true }]),
        BRIDGE_CUSTOM_ROLES: JSON.stringify([{ name: 'reviewer', baseRole: 'reviewer', instruction: 'Forbidden builtin' }]),
      },
      stderr: 'pipe',
    });
    let stderrData3 = '';
    transport3.stderr?.on('data', (chunk: Buffer | string) => {
      stderrData3 += chunk.toString();
    });

    client3 = new Client({ name: 'test-client-all-invalid', version: '1.0.0' }, { capabilities: {} });
    await client3.connect(transport3);

    const healthAll = (await client3.callTool({ name: 'antigravity_health', arguments: {} })).structuredContent as any;
    assert.deepEqual(healthAll.configurationIssues, [
      { variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', index: 0, reason: 'not-found' },
      { variable: 'BRIDGE_ALLOWED_ENV_VARS', index: 0, reason: 'forbidden-name' },
      { variable: 'BRIDGE_SECRET_EXCEPTIONS', index: 0, reason: 'invalid-pattern' },
      { variable: 'BRIDGE_MCP_CATALOG', index: 0, reason: 'invalid-entry' },
      { variable: 'BRIDGE_CUSTOM_ROLES', index: 0, reason: 'invalid-entry' },
      { variable: 'integration-approvals.json', index: 0, reason: 'invalid-entry' },
    ]);
    assert.equal(healthAll.integrationApproval.preauthorizedProjectCount, 1);

    const expectedWarning3 = configurationWarning(healthAll.configurationIssues)!;
    assert.ok(expectedWarning3);
    await waitFor(() => stderrData3.includes(expectedWarning3), () => stderrData3);
    const warningLines = stderrData3.trim().split(/\r?\n/).filter(line => line.startsWith('Invalid configuration entries were ignored or made the affected feature unavailable'));
    assert.equal(warningLines.length, 1);
    assert.equal(warningLines[0], expectedWarning3);

    await client3.close();
    client3 = undefined;
  } finally {
    if (client) await client.close().catch(() => {});
    if (client2) await client2.close().catch(() => {});
    if (client3) await client3.close().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('server startup handles unreadable BRIDGE_ALLOWED_AGY_TOOLS, invalid BRIDGE_SECRET_EXCLUSIONS, and relative FORBIDDEN_DIRECTORIES', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-server-startup-invalid-'));
  const entryPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const nonexistentAgy = path.join(tmpDir, 'nonexistent-agy');
  const stateDir = path.join(tmpDir, 'state');
  mkdirSync(stateDir, { recursive: true });

  const sensitiveToolsMarker = 'SENSITIVE_TOOLS_BAD_JSON_112233{';
  const sensitiveExclusionsMarker = '\\privado_sensitive_secret_445566';
  const sensitiveForbiddenMarker = 'relative_forbidden_dir_778899';

  let client: Client | undefined;
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entryPath],
      env: {
        ...process.env as Record<string, string>,
        BRIDGE_ANTI_AI_CRAFT: 'off',
        AGY_PATH: nonexistentAgy,
        BRIDGE_STATE_DIRECTORY: stateDir,
        BRIDGE_ALLOWED_AGY_TOOLS: sensitiveToolsMarker,
        BRIDGE_SECRET_EXCLUSIONS: JSON.stringify([sensitiveExclusionsMarker]),
        FORBIDDEN_DIRECTORIES: sensitiveForbiddenMarker,
      },
      stderr: 'pipe',
    });
    let stderrData = '';
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      stderrData += chunk.toString();
    });

    client = new Client({ name: 'test-startup-coverage', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const health = (await client.callTool({ name: 'antigravity_health', arguments: {} })).structuredContent as any;
    assert.deepEqual(health.configurationIssues, [
      { variable: 'BRIDGE_ALLOWED_AGY_TOOLS', reason: 'invalid-json' },
      { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 0, reason: 'invalid-pattern' },
      { variable: 'FORBIDDEN_DIRECTORIES', index: 0, reason: 'not-absolute' },
    ]);

    const expectedWarning = configurationWarning(health.configurationIssues)!;
    assert.ok(expectedWarning);
    await waitFor(() => stderrData.includes(expectedWarning), () => stderrData);
    const warningLines = stderrData.trim().split(/\r?\n/).filter(line => line.startsWith('Invalid configuration entries were ignored or made the affected feature unavailable'));
    assert.equal(warningLines.length, 1);
    assert.equal(warningLines[0], expectedWarning);

    for (const marker of [sensitiveToolsMarker, sensitiveExclusionsMarker, sensitiveForbiddenMarker]) {
      assert.equal(stderrData.includes(marker), false, `stderr must not leak ${marker}`);
      assert.equal(JSON.stringify(health).includes(marker), false, `health must not leak ${marker}`);
    }

    const agentPolicyResult = (await client.callTool({ name: 'antigravity_get_agent_policy', arguments: {} })).structuredContent as any;
    assert.deepEqual(agentPolicyResult.allowedTools, []);
    for (const marker of [sensitiveToolsMarker, sensitiveExclusionsMarker, sensitiveForbiddenMarker]) {
      assert.equal(JSON.stringify(agentPolicyResult).includes(marker), false);
    }
    const effectivePolicy = resolveAgentPolicy({}, agentPolicyResult.allowedTools, [], 'write', '28c48913-763e-4ced-aee4-3fe6f0dd25eb');
    assert.deepEqual(effectivePolicy.nativeTools, ['finish']);

    const listFilesResult = await client.callTool({
      name: 'antigravity_list_project_files',
      arguments: { workingDirectory: tmpDir },
    }) as any;
    assert.equal(listFilesResult.isError, true);
    const listFilesContent = listFilesResult.structuredContent as any;
    assert.equal(listFilesContent.error.code, 'INVALID_CONFIGURATION');

    const runResult = await client.callTool({
      name: 'antigravity_run',
      arguments: { prompt: 'do work', workingDirectory: tmpDir },
    }) as any;
    assert.equal(runResult.isError, true);
    const runContent = runResult.structuredContent as any;
    assert.equal(runContent.error.code, 'INVALID_CONFIGURATION');

    for (const marker of [sensitiveToolsMarker, sensitiveExclusionsMarker, sensitiveForbiddenMarker]) {
      assert.equal(JSON.stringify(listFilesResult).includes(marker), false);
      assert.equal(JSON.stringify(runResult).includes(marker), false);
    }

    await client.close();
    client = undefined;
  } finally {
    if (client) await client.close().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('BRIDGE_ALLOWED_ENV_VARS tolerates invalid values and keeps valid names', () => {
  const jsonCfg = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_ALLOWED_ENV_VARS: '{' });
  assert.deepEqual(jsonCfg.allowedEnvVars, []);
  assert.deepEqual(jsonCfg.configurationIssues, [{ variable: 'BRIDGE_ALLOWED_ENV_VARS', reason: 'invalid-json' }]);

  const listCfg = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_ALLOWED_ENV_VARS: '{"a": 1}' });
  assert.deepEqual(listCfg.allowedEnvVars, []);
  assert.deepEqual(listCfg.configurationIssues, [{ variable: 'BRIDGE_ALLOWED_ENV_VARS', reason: 'not-a-list' }]);

  const mixedCfg = loadConfig({
    BRIDGE_ANTI_AI_CRAFT: 'off',
    BRIDGE_ALLOWED_ENV_VARS: JSON.stringify([
      123,
      '',
      'BAD-ENV-NAME!',
      'NUL\0VAR',
      'NODE_OPTIONS',
      'NODE_PATH',
      'LD_PRELOAD',
      'DYLD_LIBRARY_PATH',
      '  VALID_CUSTOM_VAR  ',
      'VALID_CUSTOM_VAR',
      'ANOTHER_VALID_VAR',
    ]),
  });
  assert.deepEqual(mixedCfg.allowedEnvVars, ['VALID_CUSTOM_VAR', 'ANOTHER_VALID_VAR']);
  assert.deepEqual(mixedCfg.configurationIssues, [
    { variable: 'BRIDGE_ALLOWED_ENV_VARS', index: 0, reason: 'not-a-string' },
    { variable: 'BRIDGE_ALLOWED_ENV_VARS', index: 1, reason: 'invalid-name' },
    { variable: 'BRIDGE_ALLOWED_ENV_VARS', index: 2, reason: 'invalid-name' },
    { variable: 'BRIDGE_ALLOWED_ENV_VARS', index: 3, reason: 'invalid-name' },
    { variable: 'BRIDGE_ALLOWED_ENV_VARS', index: 4, reason: 'forbidden-name' },
    { variable: 'BRIDGE_ALLOWED_ENV_VARS', index: 5, reason: 'forbidden-name' },
    { variable: 'BRIDGE_ALLOWED_ENV_VARS', index: 6, reason: 'forbidden-name' },
    { variable: 'BRIDGE_ALLOWED_ENV_VARS', index: 7, reason: 'forbidden-name' },
  ]);
  assert.equal(mixedCfg.allowedEnvVars.includes('NODE_OPTIONS'), false);
  assert.equal(mixedCfg.allowedEnvVars.includes('BAD-ENV-NAME!'), false);
});

test('BRIDGE_SECRET_EXCEPTIONS tolerates invalid values and keeps valid patterns', () => {
  const jsonCfg = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCEPTIONS: '{' });
  assert.deepEqual(jsonCfg.secretExceptions, { version: 2, namePatterns: [] });
  assert.deepEqual(jsonCfg.configurationIssues, [{ variable: 'BRIDGE_SECRET_EXCEPTIONS', reason: 'invalid-json' }]);

  const emptyListCfg = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCEPTIONS: '[]' });
  assert.deepEqual(emptyListCfg.secretExceptions, { version: 2, namePatterns: [] });
  assert.deepEqual(emptyListCfg.configurationIssues, []);

  const legacyCfg = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCEPTIONS: '["old/pattern"]' });
  assert.deepEqual(legacyCfg.secretExceptions, { version: 2, namePatterns: [] });
  assert.deepEqual(legacyCfg.configurationIssues, [{ variable: 'BRIDGE_SECRET_EXCEPTIONS', reason: 'legacy-format' }]);

  for (const notObj of ['null', '123', '"a string"', 'false']) {
    const cfg = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCEPTIONS: notObj });
    assert.deepEqual(cfg.secretExceptions, { version: 2, namePatterns: [] });
    assert.deepEqual(cfg.configurationIssues, [{ variable: 'BRIDGE_SECRET_EXCEPTIONS', reason: 'not-an-object' }]);
  }

  const formatCases = [
    { version: 2, namePatterns: [], extra: true },
    { namePatterns: [] },
    { version: 2 },
    { version: 1, namePatterns: [] },
    { version: 3, namePatterns: [] },
    { version: 2, namePatterns: 'not-a-list' },
  ];
  for (const badFormat of formatCases) {
    const cfg = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCEPTIONS: JSON.stringify(badFormat) });
    assert.deepEqual(cfg.secretExceptions, { version: 2, namePatterns: [] });
    assert.deepEqual(cfg.configurationIssues, [{ variable: 'BRIDGE_SECRET_EXCEPTIONS', reason: 'invalid-format' }]);
  }

  const mixedCfg = loadConfig({
    BRIDGE_ANTI_AI_CRAFT: 'off',
    BRIDGE_SECRET_EXCEPTIONS: JSON.stringify({
      version: 2,
      namePatterns: [
        123,
        '',
        '   ',
        'nul\0char',
        '/absolute/path',
        'C:/drive/path',
        'sub/../traversal',
        ' ./valid\\pattern ',
        'valid/pattern',
        'another/*.pattern',
      ],
    }),
  });
  assert.deepEqual(mixedCfg.secretExceptions, { version: 2, namePatterns: ['valid/pattern', 'another/*.pattern'] });
  assert.deepEqual(mixedCfg.configurationIssues, [
    { variable: 'BRIDGE_SECRET_EXCEPTIONS', index: 0, reason: 'not-a-string' },
    { variable: 'BRIDGE_SECRET_EXCEPTIONS', index: 1, reason: 'invalid-pattern' },
    { variable: 'BRIDGE_SECRET_EXCEPTIONS', index: 2, reason: 'invalid-pattern' },
    { variable: 'BRIDGE_SECRET_EXCEPTIONS', index: 3, reason: 'invalid-pattern' },
    { variable: 'BRIDGE_SECRET_EXCEPTIONS', index: 4, reason: 'invalid-pattern' },
    { variable: 'BRIDGE_SECRET_EXCEPTIONS', index: 5, reason: 'invalid-pattern' },
    { variable: 'BRIDGE_SECRET_EXCEPTIONS', index: 6, reason: 'invalid-pattern' },
  ]);
  assert.equal(mixedCfg.secretExceptions.namePatterns.includes('/absolute/path'), false);
  assert.equal(mixedCfg.secretExceptions.namePatterns.includes('sub/../traversal'), false);
});

test('BRIDGE_MCP_CATALOG tolerates invalid values, duplicate ids, and large payloads', () => {
  const jsonCfg = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_MCP_CATALOG: '{' });
  assert.deepEqual(jsonCfg.mcpCatalog, []);
  assert.deepEqual(jsonCfg.configurationIssues, [{ variable: 'BRIDGE_MCP_CATALOG', reason: 'invalid-json' }]);
  assert.equal(jsonCfg.enforceAgentPolicy, true);

  const listCfg = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_MCP_CATALOG: '{"server": 1}' });
  assert.deepEqual(listCfg.mcpCatalog, []);
  assert.deepEqual(listCfg.configurationIssues, [{ variable: 'BRIDGE_MCP_CATALOG', reason: 'not-a-list' }]);

  const tooMany = Array(21).fill({ id: 'srv', serverUrl: 'https://example.com/mcp', tools: [{ name: 't', readOnly: true }] });
  const countCfg = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_MCP_CATALOG: JSON.stringify(tooMany) });
  assert.deepEqual(countCfg.mcpCatalog, []);
  assert.deepEqual(countCfg.configurationIssues, [{ variable: 'BRIDGE_MCP_CATALOG', reason: 'too-many-entries' }]);

  const valid1 = { id: 'srv-a', serverUrl: 'https://example.com/a', tools: [{ name: 'query', readOnly: true }] };
  const valid2 = { id: 'srv-b', serverUrl: 'https://example.com/b', tools: [{ name: 'query', readOnly: true }] };
  const validDup = { id: 'srv-a', serverUrl: 'https://example.com/dup', tools: [{ name: 'query', readOnly: true }] };
  const invalid = { id: 'bad-entry', command: 'relative-not-abs', tools: [{ name: 'query', readOnly: true }] };

  const mixedCfg = loadConfig({
    BRIDGE_ANTI_AI_CRAFT: 'off',
    BRIDGE_MCP_CATALOG: JSON.stringify([valid1, invalid, valid2, validDup]),
  });
  assert.deepEqual(mixedCfg.mcpCatalog, [valid2]);
  assert.deepEqual(mixedCfg.configurationIssues, [
    { variable: 'BRIDGE_MCP_CATALOG', index: 0, reason: 'duplicate' },
    { variable: 'BRIDGE_MCP_CATALOG', index: 1, reason: 'invalid-entry' },
    { variable: 'BRIDGE_MCP_CATALOG', index: 3, reason: 'duplicate' },
  ]);

  const largeEnv = Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['KEY_' + i, 'x'.repeat(15000)]));
  const largeEntry = {
    id: 'large-server',
    command: path.resolve('fixtures/server'),
    env: largeEnv,
    tools: [{ name: 'echo', readOnly: true }],
  };
  assert.ok(Buffer.byteLength(JSON.stringify([largeEntry]), 'utf8') > 1024 * 1024);
  const largeCfg = loadConfig({
    BRIDGE_ANTI_AI_CRAFT: 'off',
    BRIDGE_MCP_CATALOG: JSON.stringify([largeEntry]),
  });
  assert.deepEqual(largeCfg.mcpCatalog, []);
  assert.deepEqual(largeCfg.configurationIssues, [{ variable: 'BRIDGE_MCP_CATALOG', reason: 'too-large' }]);
});

test('BRIDGE_CUSTOM_ROLES tolerates invalid values, built-in names, and duplicates', () => {
  const jsonCfg = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_CUSTOM_ROLES: '{' });
  assert.deepEqual(jsonCfg.customRoles, []);
  assert.deepEqual(jsonCfg.configurationIssues, [{ variable: 'BRIDGE_CUSTOM_ROLES', reason: 'invalid-json' }]);

  const listCfg = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_CUSTOM_ROLES: '"string-role"' });
  assert.deepEqual(listCfg.customRoles, []);
  assert.deepEqual(listCfg.configurationIssues, [{ variable: 'BRIDGE_CUSTOM_ROLES', reason: 'not-a-list' }]);

  const validRole = { name: 'role-valid', baseRole: 'reviewer', instruction: 'Audit the files.' };
  const countCfg = loadConfig({
    BRIDGE_ANTI_AI_CRAFT: 'off',
    BRIDGE_CUSTOM_ROLES: JSON.stringify(Array(21).fill(validRole)),
  });
  assert.deepEqual(countCfg.customRoles, []);
  assert.deepEqual(countCfg.configurationIssues, [{ variable: 'BRIDGE_CUSTOM_ROLES', reason: 'too-many-entries' }]);

  const roleBuiltin = { name: 'reviewer', baseRole: 'reviewer', instruction: 'Check citations.' };
  const roleEmpty = { name: 'role-empty', baseRole: 'reviewer', instruction: '   ' };
  const roleBadBase = { name: 'role-bad-base', baseRole: 'invalid-base', instruction: 'Check.' };
  const roleDup1 = { name: 'role-dup', baseRole: 'implementer', instruction: 'Implement things.' };
  const roleDup2 = { name: 'role-dup', baseRole: 'implementer', instruction: 'Implement other things.' };
  const roleOk = { name: 'role-ok', baseRole: 'implementer', instruction: 'Valid instructions.' };

  const mixedCfg = loadConfig({
    BRIDGE_ANTI_AI_CRAFT: 'off',
    BRIDGE_CUSTOM_ROLES: JSON.stringify([roleBuiltin, roleDup1, roleEmpty, roleBadBase, roleOk, roleDup2]),
  });
  assert.deepEqual(mixedCfg.customRoles, [roleOk]);
  assert.deepEqual(mixedCfg.configurationIssues, [
    { variable: 'BRIDGE_CUSTOM_ROLES', index: 0, reason: 'invalid-entry' },
    { variable: 'BRIDGE_CUSTOM_ROLES', index: 1, reason: 'duplicate' },
    { variable: 'BRIDGE_CUSTOM_ROLES', index: 2, reason: 'invalid-entry' },
    { variable: 'BRIDGE_CUSTOM_ROLES', index: 3, reason: 'invalid-entry' },
    { variable: 'BRIDGE_CUSTOM_ROLES', index: 5, reason: 'duplicate' },
  ]);
  assert.equal(mixedCfg.customRoles.some(r => r.name === 'reviewer'), false);
  assert.equal(mixedCfg.customRoles.some(r => r.name === 'role-dup'), false);
});

test('StateStore readIntegrationRoots tolerates invalid files, unsafe files, and maintains valid roots', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-tolerant-approvals-'));
  try {
    const state = new StateStore(directory);
    const file = path.join(directory, 'integration-approvals.json');
    const validCanonical = process.platform === 'win32' ? directory.toLowerCase() : directory;

    assert.deepEqual(state.readIntegrationRoots(), { roots: [], issues: [] });

    mkdirSync(file);
    assert.deepEqual(state.readIntegrationRoots(), { roots: [], issues: [{ variable: 'integration-approvals.json', reason: 'unsafe-file' }] });
    rmSync(file, { recursive: true });

    writeFileSync(file, 'x'.repeat(128 * 1024 + 1));
    assert.deepEqual(state.readIntegrationRoots(), { roots: [], issues: [{ variable: 'integration-approvals.json', reason: 'unsafe-file' }] });
    unlinkSync(file);

    const outside = path.join(directory, 'outside.json');
    writeFileSync(outside, JSON.stringify({ version: 1, roots: [validCanonical] }));
    linkSync(outside, file);
    assert.deepEqual(state.readIntegrationRoots(), { roots: [], issues: [{ variable: 'integration-approvals.json', reason: 'unsafe-file' }] });
    unlinkSync(file);
    unlinkSync(outside);

    writeFileSync(file, '{');
    assert.deepEqual(state.readIntegrationRoots(), { roots: [], issues: [{ variable: 'integration-approvals.json', reason: 'invalid-json' }] });

    for (const badFormat of ['null', '123', '[]', { version: 2, roots: [] }, { version: 1, roots: [], extra: true }, { version: 1, roots: 'bad' }]) {
      writeFileSync(file, typeof badFormat === 'string' ? badFormat : JSON.stringify(badFormat));
      assert.deepEqual(state.readIntegrationRoots(), { roots: [], issues: [{ variable: 'integration-approvals.json', reason: 'invalid-format' }] });
    }

    writeFileSync(file, JSON.stringify({ version: 1, roots: Array(21).fill(validCanonical) }));
    assert.deepEqual(state.readIntegrationRoots(), { roots: [], issues: [{ variable: 'integration-approvals.json', reason: 'too-many-entries' }] });

    writeFileSync(file, JSON.stringify({
      version: 1,
      roots: [
        'relative/path',
        path.parse(validCanonical).root,
        validCanonical + path.sep + '..',
        validCanonical,
      ],
    }));
    assert.deepEqual(state.readIntegrationRoots(), {
      roots: [validCanonical],
      issues: [
        { variable: 'integration-approvals.json', index: 0, reason: 'invalid-entry' },
        { variable: 'integration-approvals.json', index: 1, reason: 'invalid-entry' },
        { variable: 'integration-approvals.json', index: 2, reason: 'invalid-entry' },
      ],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('StateStore readIntegrationRoots tolerates filesystem faults and maps access-denied and unresolvable', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-tolerant-faults-'));
  const otherDir = mkdtempSync(path.join(os.tmpdir(), 'agy-other-valid-'));
  const originalLstatSync = fs.lstatSync;
  const originalReadFileSync = fs.readFileSync;
  try {
    const state = new StateStore(directory);
    const file = path.join(directory, 'integration-approvals.json');
    const validCanonical = process.platform === 'win32' ? directory.toLowerCase() : directory;
    const initialContent = JSON.stringify({ version: 1, roots: [validCanonical] });
    writeFileSync(file, initialContent, 'utf8');

    assert.deepEqual(state.readIntegrationRoots(), { roots: [validCanonical], issues: [] });

    let activeFault: { method: 'lstatSync' | 'readFileSync'; code: string; message: string } | null = null;

    fs.lstatSync = ((...args: Parameters<typeof originalLstatSync>) => {
      if (activeFault?.method === 'lstatSync' && args[0] === file) {
        throw Object.assign(new Error(activeFault.message), { code: activeFault.code });
      }
      return Reflect.apply(originalLstatSync, fs, args);
    }) as unknown as typeof originalLstatSync;

    fs.readFileSync = ((...args: Parameters<typeof originalReadFileSync>) => {
      if (activeFault?.method === 'readFileSync' && args[0] === file) {
        throw Object.assign(new Error(activeFault.message), { code: activeFault.code });
      }
      return Reflect.apply(originalReadFileSync, fs, args);
    }) as unknown as typeof originalReadFileSync;

    syncBuiltinESMExports();

    const cases: Array<{
      method: 'lstatSync' | 'readFileSync';
      code: string;
      expectedReason: 'access-denied' | 'unresolvable';
    }> = [
      { method: 'lstatSync', code: 'EACCES', expectedReason: 'access-denied' },
      { method: 'lstatSync', code: 'EPERM', expectedReason: 'access-denied' },
      { method: 'lstatSync', code: 'EIO', expectedReason: 'unresolvable' },
      { method: 'readFileSync', code: 'EACCES', expectedReason: 'access-denied' },
      { method: 'readFileSync', code: 'EIO', expectedReason: 'unresolvable' },
    ];

    for (const { method, code, expectedReason } of cases) {
      activeFault = { method, code, message: `SEGREDO-IO: simulated ${method} ${code} failure for ${directory}` };

      const result = state.readIntegrationRoots();
      assert.deepEqual(result.roots, []);
      assert.deepEqual(result.issues, [{ variable: 'integration-approvals.json', reason: expectedReason }]);

      const issuesJson = JSON.stringify(result.issues);
      assert.equal(issuesJson.includes(directory), false);
      assert.equal(issuesJson.includes('SEGREDO-IO'), false);

      const config = loadConfig({
        BRIDGE_ANTI_AI_CRAFT: 'off',
        BRIDGE_STATE_DIRECTORY: directory,
      });
      const adapter = new CliAdapter(config, [mockPath]);
      const tasks = new TaskManager(adapter, config);

      assert.equal(tasks.preauthorizedProjectCount, 0);
      assert.deepEqual(tasks.configurationIssues, [{ variable: 'integration-approvals.json', reason: expectedReason }]);

      const tasksIssuesJson = JSON.stringify(tasks.configurationIssues);
      assert.equal(tasksIssuesJson.includes(directory), false);
      assert.equal(tasksIssuesJson.includes('SEGREDO-IO'), false);

      assert.throws(
        () => state.rememberIntegrationRoot(otherDir),
        (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_STATE'
      );
    }

    activeFault = null;
    fs.lstatSync = originalLstatSync;
    fs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();

    assert.equal(readFileSync(file, 'utf8'), initialContent);
    assert.deepEqual(state.readIntegrationRoots(), { roots: [validCanonical], issues: [] });
  } finally {
    fs.lstatSync = originalLstatSync;
    fs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(otherDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('configurationWarning and configurationIssues never leak sensitive values', () => {
  const SENSITIVE = 'MARKER_LEAK_CHECK_987654321';
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-leak-check-'));
  try {
    const file = path.join(directory, 'integration-approvals.json');
    writeFileSync(file, JSON.stringify({ version: 1, roots: ['relative/' + SENSITIVE] }));

    const config = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'off',
      BRIDGE_STATE_DIRECTORY: directory,
      BRIDGE_ALLOWED_ENV_VARS: JSON.stringify(['NODE_OPTIONS_' + SENSITIVE]),
      BRIDGE_SECRET_EXCEPTIONS: JSON.stringify({ version: 2, namePatterns: ['/abs/' + SENSITIVE] }),
      BRIDGE_MCP_CATALOG: JSON.stringify([{ id: 'bad-entry', command: 'rel/' + SENSITIVE, tools: [{ name: 't', readOnly: true }] }]),
      BRIDGE_CUSTOM_ROLES: JSON.stringify([{ name: 'reviewer', baseRole: 'reviewer', instruction: 'LEAK_' + SENSITIVE }]),
    });

    const adapter = new CliAdapter(config, [mockPath]);
    const tasks = new TaskManager(adapter, config);
    const issues = tasks.configurationIssues;
    const issuesJson = JSON.stringify(issues);
    assert.equal(issuesJson.includes(SENSITIVE), false, 'Issues JSON must not leak sensitive marker');
    for (const issue of issues) {
      assert.equal(issue.variable.includes(SENSITIVE), false);
      assert.equal(issue.reason.includes(SENSITIVE), false);
    }

    const warning = configurationWarning(issues)!;
    assert.ok(warning);
    assert.equal(warning.includes(SENSITIVE), false, 'Warning text must not leak sensitive marker');
    assert.equal(JSON.stringify(warning).includes(SENSITIVE), false, 'Warning JSON must not leak sensitive marker');
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('rememberIntegrationRoot refuses to overwrite invalid integration-approvals.json and preserves bytes', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-refuse-overwrite-'));
  try {
    const state = new StateStore(directory);
    const file = path.join(directory, 'integration-approvals.json');
    const invalidContent = '{"version": 999, "roots": ["invalid"], "customSentinel": "KEEP_ME_BYTE_FOR_BYTE"}';
    writeFileSync(file, invalidContent, 'utf8');

    assert.throws(() => state.rememberIntegrationRoot(directory), { code: 'INVALID_STATE' });
    assert.equal(readFileSync(file, 'utf8'), invalidContent);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('antigravity_health continues to respond when integration-approvals.json is invalid and lists the problem', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-health-invalid-file-'));
  try {
    const file = path.join(directory, 'integration-approvals.json');
    writeFileSync(file, '{"invalidJson": true');

    const config = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'off',
      BRIDGE_STATE_DIRECTORY: directory,
    });
    const adapter = new CliAdapter(config, [mockPath]);
    const tasks = new TaskManager(adapter, config);

    assert.equal(tasks.preauthorizedProjectCount, 0);
    assert.deepEqual(tasks.configurationIssues, [
      { variable: 'integration-approvals.json', reason: 'invalid-json' },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('loadConfig tolerates invalid BRIDGE_ANTI_AI_CRAFT_DIRECTORY, BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY, and AGY_PATH', () => {
  // BRIDGE_ANTI_AI_CRAFT_DIRECTORY
  const craftRelative = loadConfig({ BRIDGE_ANTI_AI_CRAFT_DIRECTORY: 'relative/craft' });
  assert.equal(craftRelative.antiAiCraftDirectory, undefined);
  assert.equal(craftRelative.antiAiCraftDirectoryInvalid, true);
  assert.deepEqual(craftRelative.configurationIssues, [
    { variable: 'BRIDGE_ANTI_AI_CRAFT_DIRECTORY', reason: 'not-absolute' },
  ]);
  assert.equal(JSON.stringify(craftRelative.configurationIssues).includes('relative/craft'), false);

  const craftNul = loadConfig({ BRIDGE_ANTI_AI_CRAFT_DIRECTORY: '/craft\0path' });
  assert.equal(craftNul.antiAiCraftDirectory, undefined);
  assert.equal(craftNul.antiAiCraftDirectoryInvalid, true);
  assert.deepEqual(craftNul.configurationIssues, [
    { variable: 'BRIDGE_ANTI_AI_CRAFT_DIRECTORY', reason: 'invalid-entry' },
  ]);
  assert.equal(JSON.stringify(craftNul.configurationIssues).includes('\0'), false);

  // BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY
  const cacheRelative = loadConfig({ BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: 'relative/cache' });
  assert.equal(cacheRelative.windowsNodeCacheDirectory, undefined);
  assert.equal(cacheRelative.windowsNodeCacheDirectoryInvalid, true);
  assert.deepEqual(cacheRelative.configurationIssues, [
    { variable: 'BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY', reason: 'not-absolute' },
  ]);
  assert.equal(JSON.stringify(cacheRelative.configurationIssues).includes('relative/cache'), false);

  const nulCacheVal = process.platform === 'win32' ? 'C:\\cache\0' : '/cache\0';
  const cacheNul = loadConfig({ BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: nulCacheVal });
  assert.equal(cacheNul.windowsNodeCacheDirectory, undefined);
  assert.equal(cacheNul.windowsNodeCacheDirectoryInvalid, true);
  assert.deepEqual(cacheNul.configurationIssues, [
    { variable: 'BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY', reason: 'invalid-entry' },
  ]);
  assert.equal(JSON.stringify(cacheNul.configurationIssues).includes('\0'), false);

  if (process.platform === 'win32') {
    const cacheUnc = loadConfig({ BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: '\\\\server\\share\\cache' });
    assert.equal(cacheUnc.windowsNodeCacheDirectory, undefined);
    assert.equal(cacheUnc.windowsNodeCacheDirectoryInvalid, true);
    assert.deepEqual(cacheUnc.configurationIssues, [
      { variable: 'BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY', reason: 'invalid-entry' },
    ]);
    assert.equal(JSON.stringify(cacheUnc.configurationIssues).includes('share'), false);

    const cacheDevice = loadConfig({ BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: '\\\\?\\C:\\cache' });
    assert.equal(cacheDevice.windowsNodeCacheDirectory, undefined);
    assert.equal(cacheDevice.windowsNodeCacheDirectoryInvalid, true);
    assert.deepEqual(cacheDevice.configurationIssues, [
      { variable: 'BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY', reason: 'invalid-entry' },
    ]);
    assert.equal(JSON.stringify(cacheDevice.configurationIssues).includes('cache'), false);

    const cacheDotDot = loadConfig({ BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: 'C:\\cache\\..\\other' });
    assert.equal(cacheDotDot.windowsNodeCacheDirectory, undefined);
    assert.equal(cacheDotDot.windowsNodeCacheDirectoryInvalid, true);
    assert.deepEqual(cacheDotDot.configurationIssues, [
      { variable: 'BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY', reason: 'invalid-entry' },
    ]);
    assert.equal(JSON.stringify(cacheDotDot.configurationIssues).includes('other'), false);

    const cacheExtraColon = loadConfig({ BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: 'C:\\cache:stream' });
    assert.equal(cacheExtraColon.windowsNodeCacheDirectory, undefined);
    assert.equal(cacheExtraColon.windowsNodeCacheDirectoryInvalid, true);
    assert.deepEqual(cacheExtraColon.configurationIssues, [
      { variable: 'BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY', reason: 'invalid-entry' },
    ]);
    assert.equal(JSON.stringify(cacheExtraColon.configurationIssues).includes('stream'), false);

    const cacheVolumeRoot = loadConfig({ BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: 'C:\\' });
    assert.equal(cacheVolumeRoot.windowsNodeCacheDirectory, undefined);
    assert.equal(cacheVolumeRoot.windowsNodeCacheDirectoryInvalid, true);
    assert.deepEqual(cacheVolumeRoot.configurationIssues, [
      { variable: 'BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY', reason: 'volume-root' },
    ]);
    assert.equal(JSON.stringify(cacheVolumeRoot.configurationIssues).includes('C:'), false);
  }

  // AGY_PATH
  const agyRelativeSlash = loadConfig({ AGY_PATH: 'bin/agy' });
  assert.equal(agyRelativeSlash.agyPath, '');
  assert.equal(agyRelativeSlash.agyPathInvalid, true);
  assert.deepEqual(agyRelativeSlash.configurationIssues, [
    { variable: 'AGY_PATH', reason: 'not-absolute' },
  ]);
  assert.equal(JSON.stringify(agyRelativeSlash.configurationIssues).includes('bin/agy'), false);

  if (process.platform === 'win32') {
    const agyRelativeBackslash = loadConfig({ AGY_PATH: '.\\agy' });
    assert.equal(agyRelativeBackslash.agyPath, '');
    assert.equal(agyRelativeBackslash.agyPathInvalid, true);
    assert.deepEqual(agyRelativeBackslash.configurationIssues, [
      { variable: 'AGY_PATH', reason: 'not-absolute' },
    ]);
    assert.equal(JSON.stringify(agyRelativeBackslash.configurationIssues).includes('.\\agy'), false);

    const agyDriveRelative = loadConfig({ AGY_PATH: 'C:agy.exe' });
    assert.equal(agyDriveRelative.agyPath, '');
    assert.equal(agyDriveRelative.agyPathInvalid, true);
    assert.deepEqual(agyDriveRelative.configurationIssues, [
      { variable: 'AGY_PATH', reason: 'not-absolute' },
    ]);
    assert.equal(JSON.stringify(agyDriveRelative.configurationIssues).includes('C:agy.exe'), false);
    assert.equal(JSON.stringify(agyDriveRelative.configurationIssues).includes('agy.exe'), false);

    const craftExtended = loadConfig({ BRIDGE_ANTI_AI_CRAFT_DIRECTORY: '\\\\?\\C:\\craft' });
    assert.equal(craftExtended.antiAiCraftDirectory, path.resolve('\\\\?\\C:\\craft'));
    assert.equal(craftExtended.antiAiCraftDirectoryInvalid, undefined);
    assert.equal(craftExtended.configurationIssues.some(i => i.variable === 'BRIDGE_ANTI_AI_CRAFT_DIRECTORY'), false);

    const craftVolume = loadConfig({ BRIDGE_ANTI_AI_CRAFT_DIRECTORY: '\\\\?\\Volume{26a21bda-a627-11d7-9931-806e6f6e6963}\\craft' });
    assert.equal(craftVolume.antiAiCraftDirectory, path.resolve('\\\\?\\Volume{26a21bda-a627-11d7-9931-806e6f6e6963}\\craft'));
    assert.equal(craftVolume.antiAiCraftDirectoryInvalid, undefined);
    assert.equal(craftVolume.configurationIssues.some(i => i.variable === 'BRIDGE_ANTI_AI_CRAFT_DIRECTORY'), false);

    const agyExtendedDrive = loadConfig({ AGY_PATH: '\\\\?\\C:\\tools\\agy.exe' });
    assert.equal(agyExtendedDrive.agyPath, '\\\\?\\C:\\tools\\agy.exe');
    assert.equal(agyExtendedDrive.agyPathInvalid, undefined);
    assert.equal(agyExtendedDrive.configurationIssues.some(i => i.variable === 'AGY_PATH'), false);

    const agyExtendedUnc = loadConfig({ AGY_PATH: '\\\\?\\UNC\\server\\share\\agy.exe' });
    assert.equal(agyExtendedUnc.agyPath, '\\\\?\\UNC\\server\\share\\agy.exe');
    assert.equal(agyExtendedUnc.agyPathInvalid, undefined);
    assert.equal(agyExtendedUnc.configurationIssues.some(i => i.variable === 'AGY_PATH'), false);

    const agyVolume = loadConfig({ AGY_PATH: '\\\\?\\Volume{26a21bda-a627-11d7-9931-806e6f6e6963}\\tools\\agy.exe' });
    assert.equal(agyVolume.agyPath, '\\\\?\\Volume{26a21bda-a627-11d7-9931-806e6f6e6963}\\tools\\agy.exe');
    assert.equal(agyVolume.agyPathInvalid, undefined);
    assert.equal(agyVolume.configurationIssues.some(i => i.variable === 'AGY_PATH'), false);

    const agyVolumeMalformed = loadConfig({ AGY_PATH: '\\\\?\\Volume{not-a-guid}\\agy.exe' });
    assert.equal(agyVolumeMalformed.agyPath, '');
    assert.equal(agyVolumeMalformed.agyPathInvalid, true);
    assert.deepEqual(agyVolumeMalformed.configurationIssues, [
      { variable: 'AGY_PATH', reason: 'not-absolute' },
    ]);
    assert.equal(JSON.stringify(agyVolumeMalformed.configurationIssues).includes('agy.exe'), false);
    assert.equal(JSON.stringify(agyVolumeMalformed.configurationIssues).includes('not-a-guid'), false);

    const agyDevice = loadConfig({ AGY_PATH: '\\\\.\\C:\\agy.exe' });
    assert.equal(agyDevice.agyPath, '');
    assert.equal(agyDevice.agyPathInvalid, true);
    assert.deepEqual(agyDevice.configurationIssues, [
      { variable: 'AGY_PATH', reason: 'not-absolute' },
    ]);
    assert.equal(JSON.stringify(agyDevice.configurationIssues).includes('C:\\agy.exe'), false);
    assert.equal(JSON.stringify(agyDevice.configurationIssues).includes('agy.exe'), false);

    const agyRootRelative = loadConfig({ AGY_PATH: '\\tools\\agy.exe' });
    assert.equal(agyRootRelative.agyPath, '');
    assert.equal(agyRootRelative.agyPathInvalid, true);
    assert.deepEqual(agyRootRelative.configurationIssues, [
      { variable: 'AGY_PATH', reason: 'not-absolute' },
    ]);
    assert.equal(JSON.stringify(agyRootRelative.configurationIssues).includes('\\tools\\agy.exe'), false);
    assert.equal(JSON.stringify(agyRootRelative.configurationIssues).includes('tools'), false);
    assert.equal(JSON.stringify(agyRootRelative.configurationIssues).includes('agy.exe'), false);
  }

  const agyNul = loadConfig({ AGY_PATH: 'agy\0exe' });
  assert.equal(agyNul.agyPath, '');
  assert.equal(agyNul.agyPathInvalid, true);
  assert.deepEqual(agyNul.configurationIssues, [
    { variable: 'AGY_PATH', reason: 'invalid-entry' },
  ]);
  assert.equal(JSON.stringify(agyNul.configurationIssues).includes('\0'), false);

  // Valid values remain accepted without issues
  const agyBare = loadConfig({ AGY_PATH: 'agy' });
  assert.equal(agyBare.agyPath, 'agy');
  assert.equal(agyBare.agyPathInvalid, undefined);
  assert.equal(agyBare.configurationIssues.some(i => i.variable === 'AGY_PATH'), false);

  const agyExeBare = loadConfig({ AGY_PATH: 'agy.exe' });
  assert.equal(agyExeBare.agyPath, 'agy.exe');
  assert.equal(agyExeBare.agyPathInvalid, undefined);
  assert.equal(agyExeBare.configurationIssues.some(i => i.variable === 'AGY_PATH'), false);

  const agyAbsolute = loadConfig({ AGY_PATH: process.execPath });
  assert.equal(agyAbsolute.agyPath, process.execPath);
  assert.equal(agyAbsolute.agyPathInvalid, undefined);
  assert.equal(agyAbsolute.configurationIssues.some(i => i.variable === 'AGY_PATH'), false);
});

test('operations refuse invalid path configurations with INVALID_CONFIGURATION and allow execution when unaffected', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-refusals-test-'));
  const source = path.join(directory, 'source');
  execFileSync('git', ['init', '--quiet', source]);
  writeFileSync(path.join(source, 'source.txt'), 'content');

  try {
    // 1. Craft invalid: TaskManager.run refused with INVALID_CONFIGURATION before copy/task creation when craft is on
    const configCraftInvalid = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'on',
      BRIDGE_ANTI_AI_CRAFT_DIRECTORY: 'relative/craft/path',
      AGY_PATH: process.execPath,
      BRIDGE_STATE_DIRECTORY: path.join(directory, 'state-craft'),
    });
    const adapterCraftInvalid = new CliAdapter(configCraftInvalid, [mockPath]);
    const tasksCraftInvalid = new TaskManager(adapterCraftInvalid, configCraftInvalid);
    await assert.rejects(
      tasksCraftInvalid.run({ prompt: 'test', workingDirectory: source }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_CONFIGURATION');
        assert.match(err.message, /BRIDGE_ANTI_AI_CRAFT_DIRECTORY is invalid/);
        return true;
      },
    );

    // prepareCraft throws directly and never falls back to bundled snapshot
    await assert.rejects(
      prepareCraft(configCraftInvalid),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_CONFIGURATION');
        return true;
      },
    );

    // Permitted when BRIDGE_ANTI_AI_CRAFT='off'
    const configCraftOff = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'off',
      BRIDGE_ANTI_AI_CRAFT_DIRECTORY: 'relative/craft/path',
      AGY_PATH: process.execPath,
      BRIDGE_STATE_DIRECTORY: path.join(directory, 'state-craft-off'),
    });
    const adapterCraftOff = new CliAdapter(configCraftOff, [mockPath]);
    const tasksCraftOff = new TaskManager(adapterCraftOff, configCraftOff);
    await adapterCraftOff.discover();
    const craftOffTask = await tasksCraftOff.run({
      prompt: 'read:test',
      workingDirectory: source,
      mode: 'read-only',
    });
    assert.ok(craftOffTask.taskId);
    await tasksCraftOff.shutdown();

    // 2. AGY_PATH invalid: CliAdapter.discover returns installed:false, path: '', error with INVALID_CONFIGURATION without leaking value
    const configAgyInvalid = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'off',
      AGY_PATH: 'bin/agy-secret-test',
      BRIDGE_STATE_DIRECTORY: path.join(directory, 'state-agy'),
    });
    const adapterAgyInvalid = new CliAdapter(configAgyInvalid);
    const discovery = await adapterAgyInvalid.discover();
    assert.equal(discovery.installed, false);
    assert.equal(discovery.path, '');
    assert.match(discovery.error ?? '', /INVALID_CONFIGURATION/);
    assert.equal(discovery.error?.includes('bin/agy-secret-test'), false);

    // spawnTask, listModels, and tasks.run refuse with INVALID_CONFIGURATION
    assert.throws(
      () => adapterAgyInvalid.spawnTask({ prompt: 'test', workingDirectory: source, mode: 'read-only' }, undefined, source),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_CONFIGURATION',
    );
    await assert.rejects(
      adapterAgyInvalid.listModels(),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_CONFIGURATION',
    );
    const tasksAgyInvalid = new TaskManager(adapterAgyInvalid, configAgyInvalid);
    await assert.rejects(
      tasksAgyInvalid.run({ prompt: 'test', workingDirectory: source }),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_CONFIGURATION',
    );

    // 3. Cache invalid: portableNodeStatus & preparePortableNodeRuntime report/throw INVALID_CONFIGURATION without touching default path
    const statusInvalid = await portableNodeStatus('portable', undefined, undefined, { cacheDirectoryInvalid: true });
    assert.equal(statusInvalid.ready, false);
    assert.equal(statusInvalid.error?.code, 'INVALID_CONFIGURATION');
    assert.match(statusInvalid.error?.message ?? '', /BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY is invalid/);

    await assert.rejects(
      preparePortableNodeRuntime({ cacheDirectory: undefined, cacheDirectoryInvalid: true }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_CONFIGURATION');
        assert.match(err.message, /BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY is invalid/);
        return true;
      },
    );

    // validateRuntimeCacheSeparation with undefined cache does not throw
    await assert.doesNotReject(validateRuntimeCacheSeparation(source, undefined));
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('server startup tolerates invalid craft, node cache, and agy path without leaking values', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-server-startup-paths-'));
  const entryPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const stateDir = path.join(tmpDir, 'state');
  mkdirSync(stateDir, { recursive: true });

  const craftSecretMarker = 'relative_craft_secret_112233';
  const cacheSecretMarker = 'relative_cache_secret_445566';
  const agySecretMarker = 'bin/agy_secret_marker_778899';

  let client: Client | undefined;
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entryPath],
      env: {
        ...process.env as Record<string, string>,
        BRIDGE_STATE_DIRECTORY: stateDir,
        BRIDGE_ANTI_AI_CRAFT_DIRECTORY: craftSecretMarker,
        BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: cacheSecretMarker,
        AGY_PATH: agySecretMarker,
      },
      stderr: 'pipe',
    });
    let stderrData = '';
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      stderrData += chunk.toString();
    });

    client = new Client({ name: 'test-startup-tolerant-paths', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const health = (await client.callTool({ name: 'antigravity_health', arguments: {} })).structuredContent as any;
    assert.deepEqual(health.configurationIssues, [
      { variable: 'BRIDGE_ANTI_AI_CRAFT_DIRECTORY', reason: 'not-absolute' },
      { variable: 'BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY', reason: 'not-absolute' },
      { variable: 'AGY_PATH', reason: 'not-absolute' },
    ]);

    const expectedWarning = configurationWarning(health.configurationIssues)!;
    assert.ok(expectedWarning);
    await waitFor(() => stderrData.includes(expectedWarning), () => stderrData);
    const warningLines = stderrData.trim().split(/\r?\n/).filter(line => line.startsWith('Invalid configuration entries were ignored or made the affected feature unavailable'));
    assert.equal(warningLines.length, 1);
    assert.equal(warningLines[0], expectedWarning);

    assert.equal(health.installed, false);
    assert.equal(health.path, '');
    assert.match(health.error ?? '', /INVALID_CONFIGURATION/);

    for (const marker of [craftSecretMarker, cacheSecretMarker, agySecretMarker]) {
      assert.equal(stderrData.includes(marker), false, `stderr must not leak ${marker}`);
      assert.equal(JSON.stringify(health).includes(marker), false, `health must not leak ${marker}`);
    }
  } finally {
    if (client) await client.close();
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('resumed and handoff tasks refuse invalid craft directory with INVALID_CONFIGURATION when craft is on', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-craft-resume-test-'));
  const source = path.join(directory, 'source');
  execFileSync('git', ['init', '--quiet', source]);
  writeFileSync(path.join(source, 'source.txt'), 'content\n');
  const stateDir = path.join(directory, 'state');

  try {
    // 1. Initial task completed with valid craft configuration
    const configInitial = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'on',
      AGY_PATH: process.execPath,
      BRIDGE_STATE_DIRECTORY: stateDir,
    });
    const adapterInitial = new CliAdapter(configInitial, [mockPath]);
    await adapterInitial.discover();
    const tasksInitial = new TaskManager(adapterInitial, configInitial);
    const initialTask = await tasksInitial.run({
      prompt: 'read:initial',
      workingDirectory: source,
      mode: 'read-only',
    });
    await waitFor(() => tasksInitial.status(initialTask.taskId).status === 'completed', () => tasksInitial.status(initialTask.taskId));
    const completed = tasksInitial.status(initialTask.taskId);
    assert.equal(completed.status, 'completed');
    const contextInfo = await tasksInitial.context(initialTask.taskId);
    await tasksInitial.shutdown();

    // 2. Recreate TaskManager with invalid BRIDGE_ANTI_AI_CRAFT_DIRECTORY and Craft on:
    // Resume and handoff must refuse with INVALID_CONFIGURATION without leaking the invalid value.
    const invalidCraftMarker = 'relative_invalid_craft_dir_marker';
    const configCraftInvalid = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'on',
      BRIDGE_ANTI_AI_CRAFT_DIRECTORY: invalidCraftMarker,
      AGY_PATH: process.execPath,
      BRIDGE_STATE_DIRECTORY: stateDir,
    });
    const adapterCraftInvalid = new CliAdapter(configCraftInvalid, [mockPath]);
    const tasksCraftInvalid = new TaskManager(adapterCraftInvalid, configCraftInvalid);

    await assert.rejects(
      tasksCraftInvalid.run({
        prompt: 'read:resumed',
        workingDirectory: source,
        sessionId: completed.sessionId,
        mode: 'read-only',
      }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_CONFIGURATION');
        assert.match(err.message, /BRIDGE_ANTI_AI_CRAFT_DIRECTORY is invalid/);
        assert.equal(err.message.includes(invalidCraftMarker), false);
        return true;
      },
    );

    await assert.rejects(
      tasksCraftInvalid.run({
        prompt: 'read:handoff',
        workingDirectory: source,
        contextTaskId: completed.taskId,
        expectedContextSha256: contextInfo.treeSha256,
        mode: 'read-only',
      }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_CONFIGURATION');
        assert.match(err.message, /BRIDGE_ANTI_AI_CRAFT_DIRECTORY is invalid/);
        assert.equal(err.message.includes(invalidCraftMarker), false);
        return true;
      },
    );
    await tasksCraftInvalid.shutdown();

    // 3. When BRIDGE_ANTI_AI_CRAFT='off', resume is not refused for this reason
    const configCraftOff = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'off',
      BRIDGE_ANTI_AI_CRAFT_DIRECTORY: invalidCraftMarker,
      AGY_PATH: process.execPath,
      BRIDGE_STATE_DIRECTORY: stateDir,
    });
    const adapterCraftOff = new CliAdapter(configCraftOff, [mockPath]);
    await adapterCraftOff.discover();
    const tasksCraftOff = new TaskManager(adapterCraftOff, configCraftOff);
    const resumedOff = await tasksCraftOff.run({
      prompt: 'read:resumed-off',
      workingDirectory: source,
      sessionId: completed.sessionId,
      mode: 'read-only',
    });
    assert.ok(resumedOff.taskId);
    await tasksCraftOff.shutdown();
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Windows test repair refuses invalid craft directory with INVALID_CONFIGURATION when craft is on', async t => {
  if (process.platform !== 'win32') return t.skip('Windows LPAC execution requires Windows');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-craft-repair-test-'));
  const source = path.join(directory, 'source');
  execFileSync('git', ['init', '--quiet', source]);
  writeFileSync(path.join(source, 'source.txt'), 'content\n');
  const stateDir = path.join(directory, 'state');

  let tasksInitial: TaskManager | undefined;
  let tasksCraftInvalid: TaskManager | undefined;

  try {
    // 1. Initial write task completed with valid craft configuration and windows-lpac test executor
    const configInitial = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'on',
      AGY_PATH: process.execPath,
      BRIDGE_STATE_DIRECTORY: stateDir,
      BRIDGE_TEST_EXECUTOR: 'windows-lpac',
    });
    const adapterInitial = new CliAdapter(configInitial, [mockPath]);
    await adapterInitial.discover();
    tasksInitial = new TaskManager(adapterInitial, configInitial);
    const initialTask = await tasksInitial.run({
      prompt: 'write:initial',
      workingDirectory: source,
    });
    await waitFor(() => tasksInitial!.status(initialTask.taskId).status === 'completed', () => tasksInitial!.status(initialTask.taskId));
    const completed = tasksInitial.status(initialTask.taskId);
    assert.equal(completed.status, 'completed');
    const preview = await tasksInitial.preview(initialTask.taskId);
    assert.ok(preview.sha256);
    await tasksInitial.shutdown();
    tasksInitial = undefined;

    // 2. Recreate TaskManager with invalid BRIDGE_ANTI_AI_CRAFT_DIRECTORY and Craft on:
    // startTests with windows-lpac must refuse with INVALID_CONFIGURATION before queuing, without leaking the invalid value.
    const invalidCraftMarker = 'relative_invalid_craft_dir_marker';
    const configCraftInvalid = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'on',
      BRIDGE_ANTI_AI_CRAFT_DIRECTORY: invalidCraftMarker,
      AGY_PATH: process.execPath,
      BRIDGE_STATE_DIRECTORY: stateDir,
      BRIDGE_TEST_EXECUTOR: 'windows-lpac',
    });
    const adapterCraftInvalid = new CliAdapter(configCraftInvalid, [mockPath]);
    tasksCraftInvalid = new TaskManager(adapterCraftInvalid, configCraftInvalid);

    const before = tasksCraftInvalid.list();
    assert.equal(before.length, 1);
    assert.equal(before[0]!.taskId, initialTask.taskId);

    await assert.rejects(
      tasksCraftInvalid.startTests(
        initialTask.taskId,
        preview.sha256,
        { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
        1,
        20,
      ),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_CONFIGURATION');
        assert.match(err.message, /BRIDGE_ANTI_AI_CRAFT_DIRECTORY is invalid/);
        assert.equal(err.message.includes(invalidCraftMarker), false);
        return true;
      },
    );

    const after = tasksCraftInvalid.list();
    assert.equal(after.length, before.length);
    assert.deepEqual(after.map(task => task.taskId), before.map(task => task.taskId));
    await tasksCraftInvalid.shutdown();
    tasksCraftInvalid = undefined;
  } finally {
    if (tasksCraftInvalid) await tasksCraftInvalid.shutdown();
    if (tasksInitial) await tasksInitial.shutdown();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Windows executor rejects invalid node cache in portable mode before staging and permits system mode', async t => {
  if (process.platform !== 'win32') return t.skip('Windows LPAC execution requires Windows');
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-mcp-copy-exec-test-'));
  const copyDir = mkdtempSync(path.join(os.tmpdir(), 'agy-mcp-copy-'));
  const systemStateDir = path.join(tmpDir, 'system-state');
  const directPortableStateDir = path.join(tmpDir, 'direct-portable-state');
  const childStateDir = path.join(tmpDir, 'child-state');
  const envStateDir = path.join(tmpDir, 'env-state');
  try {
    // 1. System mode permits execution with exitCode 0
    const systemResult = await executeWindowsTest(
      { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
      copyDir,
      {
        timeoutSeconds: 30,
        maxRuntimeBytes: 256 * 1024 * 1024,
        stateDirectory: systemStateDir,
        windowsNodeRuntime: 'system',
        portableNodeCacheDirectoryInvalid: true,
      },
    );
    assert.equal(systemResult.exitCode, 0);

    // 2. Direct portable mode with invalid cache rejects before staging without creating stateDirectory
    assert.equal(existsSync(directPortableStateDir), false);
    await assert.rejects(
      executeWindowsTest(
        { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
        copyDir,
        {
          timeoutSeconds: 30,
          maxRuntimeBytes: 256 * 1024 * 1024,
          stateDirectory: directPortableStateDir,
          windowsNodeRuntime: 'portable',
          portableNodeCacheDirectoryInvalid: true,
        },
      ),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_CONFIGURATION');
        assert.match(err.message, /BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY is invalid/);
        return true;
      },
    );
    assert.equal(existsSync(directPortableStateDir), false, 'direct portable mode must not create state directory on configuration failure');

    // 3. Child process propagating invalid cache via environment without manual option injection
    const cacheMarker = 'relative_cache_marker_exec_44';
    const executorModuleUrl = pathToFileURL(fileURLToPath(new URL('../src/windows-executor.js', import.meta.url))).href;
    const childScript = [
      `import { executeWindowsTest } from ${JSON.stringify(executorModuleUrl)};`,
      'try {',
      '  await executeWindowsTest(',
      `    { executable: process.execPath, args: ['-e', 'process.exit(0)'] },`,
      `    ${JSON.stringify(copyDir)},`,
      `    { timeoutSeconds: 30, maxRuntimeBytes: 256 * 1024 * 1024, stateDirectory: ${JSON.stringify(childStateDir)} },`,
      '  );',
      '  console.log(JSON.stringify({ success: true }));',
      '} catch (err) {',
      '  const error = err;',
      '  console.log(JSON.stringify({ code: error?.code, message: error?.message }));',
      '}',
    ].join('\n');

    assert.equal(existsSync(childStateDir), false);
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', childScript],
      {
        encoding: 'utf8',
        env: {
          ...process.env as Record<string, string>,
          BRIDGE_WINDOWS_NODE_RUNTIME: 'portable',
          BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: cacheMarker,
          BRIDGE_STATE_DIRECTORY: envStateDir,
        },
        windowsHide: true,
      },
    );
    assert.equal(child.status, 0);
    const childOutput = JSON.parse(child.stdout.trim());
    assert.equal(childOutput.code, 'INVALID_CONFIGURATION');
    assert.match(childOutput.message, /BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY is invalid/);
    assert.equal(existsSync(childStateDir), false, 'child process state directory must not be created before validation');
    assert.equal(child.stdout.includes(cacheMarker), false, 'child stdout must not leak cache marker');
    assert.equal(child.stderr.includes(cacheMarker), false, 'child stderr must not leak cache marker');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(copyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('wait command tolerates invalid craft, node cache, and agy path without leaking values', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-wait-tolerance-test-'));
  const stateDir = path.join(tmpDir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const entryPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

  const craftSecretMarker = 'relative_craft_secret_wait_11';
  const cacheSecretMarker = 'relative_cache_secret_wait_22';
  const agySecretMarker = 'bin/agy_secret_marker_wait_33';

  try {
    const taskId = randomUUID();
    const state = new StateStore(stateDir);
    state.save({
      ownerPid: process.pid,
      events: [],
      cursor: 0,
      record: {
        taskId,
        workingDirectory: tmpDir,
        prompt: 'wait tolerance test',
        status: 'completed',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      options: {
        workingDirectory: tmpDir,
        prompt: 'wait tolerance test',
      },
    });

    const envWithSecrets = {
      ...process.env as Record<string, string>,
      BRIDGE_ANTI_AI_CRAFT_DIRECTORY: craftSecretMarker,
      BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: cacheSecretMarker,
      AGY_PATH: agySecretMarker,
    };

    // 1. Wait on a known completed task
    const knownResult = spawnSync(
      process.execPath,
      [entryPath, 'wait', '--state-directory', stateDir, taskId],
      { encoding: 'utf8', env: envWithSecrets, windowsHide: true },
    );
    assert.equal(knownResult.status, 0);
    assert.equal(knownResult.stderr, '');
    const knownJson = JSON.parse(knownResult.stdout.trim());
    assert.equal(knownJson.taskId, taskId);
    assert.equal(knownJson.outcome, 'completed');
    assert.equal(knownJson.exitCode, 0);

    for (const marker of [craftSecretMarker, cacheSecretMarker, agySecretMarker]) {
      assert.equal(knownResult.stdout.includes(marker), false, `wait stdout must not leak ${marker}`);
      assert.equal(knownResult.stderr.includes(marker), false, `wait stderr must not leak ${marker}`);
    }

    // 2. Wait on an unknown task
    const unknownId = randomUUID();
    const unknownResult = spawnSync(
      process.execPath,
      [entryPath, 'wait', '--state-directory', stateDir, unknownId],
      { encoding: 'utf8', env: envWithSecrets, windowsHide: true },
    );
    assert.equal(unknownResult.status, 7);
    assert.equal(unknownResult.stderr, '');
    const unknownJson = JSON.parse(unknownResult.stdout.trim());
    assert.equal(unknownJson.taskId, unknownId);
    assert.equal(unknownJson.outcome, 'unknown-task');
    assert.equal(unknownJson.reason, 'TASK_NOT_FOUND');

    for (const marker of [craftSecretMarker, cacheSecretMarker, agySecretMarker]) {
      assert.equal(unknownResult.stdout.includes(marker), false, `wait stdout must not leak ${marker}`);
      assert.equal(unknownResult.stderr.includes(marker), false, `wait stderr must not leak ${marker}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
