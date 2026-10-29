import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { preauthorizedIntegrationRoots, readPreauthorizedIntegrationRoots, integrationPreauthorized } from '../src/integration-policy.js';
import { StateStore } from '../src/state-store.js';
import { loadConfig, configurationWarning } from '../src/config.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { TaskManager } from '../src/task-manager.js';
import { createMcpServer } from '../src/mcp-server.js';

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
  assert.equal(singleWarning, 'Ignored invalid configuration entries (nothing was granted from them): BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS invalid-json. See configurationIssues in antigravity_health.');

  const sampleIssues = [
    { variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', index: 0, reason: 'not-found' as const },
    { variable: 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS', reason: 'invalid-json' as const },
  ];
  const warning = configurationWarning(sampleIssues);
  assert.equal(warning, 'Ignored invalid configuration entries (nothing was granted from them): BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS[0] not-found, BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS invalid-json. See configurationIssues in antigravity_health.');
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
  } finally {
    if (client) await client.close().catch(() => {});
    if (client2) await client2.close().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
