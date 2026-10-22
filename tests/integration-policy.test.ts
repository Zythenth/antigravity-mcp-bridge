import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { preauthorizedIntegrationRoots, integrationPreauthorized } from '../src/integration-policy.js';
import { StateStore } from '../src/state-store.js';
import { loadConfig } from '../src/config.js';
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
