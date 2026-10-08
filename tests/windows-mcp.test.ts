import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { loadConfig } from '../src/config.js';
import { TaskManager } from '../src/task-manager.js';

const mockPath = fileURLToPath(new URL('../../tests/mock-agy.mjs', import.meta.url));
const fixturePath = fileURLToPath(new URL('./mcp-fixture.js', import.meta.url));
const done = (status: string) => ['completed', 'failed', 'cancelled', 'timeout'].includes(status);

async function waitFor(tasks: TaskManager, taskId: string, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = tasks.status(taskId);
    if (done(current.status)) return current;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for task ' + taskId);
}

async function repository() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-windows-mcp-test-'));
  execFileSync('git', ['init', '--quiet', directory]);
  await writeFile(path.join(directory, 'source.txt'), 'source');
  return directory;
}

test('MCP policy setter requires an accepted form and preserves a compare-and-set ceiling', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-policy-mcp-test-'));
  let confirmation = false;
  let action: 'accept' | 'decline' = 'accept';
  let requests = 0;
  const client = new Client({ name: 'policy-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async request => {
    requests++;
    assert.equal(request.params.mode, 'form');
    assert.equal(request.params.requestedSchema.properties.confirm?.default, false);
    assert.match(request.params.message, /Política anterior/);
    assert.match(request.params.message, /Proposta normalizada/);
    assert.match(request.params.message, /confirmação humana autoriza apenas este teto global/);
    assert.match(request.params.message, /agente que chama o MCP seleciona concessões menores por teste/);
    assert.match(request.params.message, /Gemini delegado não pode autorizá-las nem alterá-las/);
    return action === 'accept' ? { action, content: { confirm: confirmation } } : { action };
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { result, body: result.structuredContent as Record<string, any> };
  };
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fixturePath], stderr: 'pipe',
      env: { ...process.env as Record<string, string>, BRIDGE_TOOL_PROFILE: 'full', BRIDGE_STATE_DIRECTORY: path.join(directory, 'state') } }));
    const initial = (await call('antigravity_get_sandbox_policy')).body;
    assert.equal(initial.policy.network, false);
    const proposal = { ...initial.policy, childProcesses: false, maxOutputChars: 256 };
    const declined = await call('antigravity_set_sandbox_policy', { policy: proposal, expectedSha256: initial.sha256 });
    assert.equal((declined.body.error as { code: string }).code, 'APPROVAL_DENIED');
    assert.equal((await call('antigravity_get_sandbox_policy')).body.sha256, initial.sha256);
    action = 'decline';
    const rejected = await call('antigravity_set_sandbox_policy', { policy: proposal, expectedSha256: initial.sha256 });
    assert.equal((rejected.body.error as { code: string }).code, 'APPROVAL_DENIED');
    assert.equal((await call('antigravity_get_sandbox_policy')).body.sha256, initial.sha256);
    action = 'accept';
    confirmation = true;
    const accepted = await call('antigravity_set_sandbox_policy', { policy: proposal, expectedSha256: initial.sha256 });
    assert.equal(accepted.result.isError, undefined, JSON.stringify(accepted.body));
    assert.equal(accepted.body.policy.childProcesses, false);
    assert.equal(accepted.body.policy.maxOutputChars, 256);
    const stale = await call('antigravity_set_sandbox_policy', { policy: initial.policy, expectedSha256: initial.sha256 });
    assert.equal((stale.body.error as { code: string }).code, 'SANDBOX_POLICY_CHANGED');
    const unavailable = new Client({ name: 'policy-no-form', version: '1' }, { capabilities: {} });
    try {
      await unavailable.connect(new StdioClientTransport({ command: process.execPath, args: [fixturePath], stderr: 'pipe',
        env: { ...process.env as Record<string, string>, BRIDGE_TOOL_PROFILE: 'full', BRIDGE_STATE_DIRECTORY: path.join(directory, 'state') } }));
      const current = await unavailable.callTool({ name: 'antigravity_get_sandbox_policy', arguments: {} });
      const unavailableSet = await unavailable.callTool({ name: 'antigravity_set_sandbox_policy', arguments: {
        policy: accepted.body.policy, expectedSha256: (current.structuredContent as any).sha256,
      } });
      assert.equal((unavailableSet.structuredContent as any).error.code, 'APPROVAL_UNAVAILABLE');
    } finally { await unavailable.close(); }
    assert.equal(requests, 3);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Windows test defaults to bridge-owned LPAC evidence and rejects forged stdout, failed commands, and cancelled commands', { skip: process.platform !== 'win32' }, async () => {
  const directory = await repository();
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-windows-mcp-state-'));
  const config = loadConfig({ AGY_PATH: process.execPath, BRIDGE_STATE_DIRECTORY: stateDirectory, DEFAULT_TIMEOUT_SECONDS: '20',
    ...(process.env.BRIDGE_WINDOWS_NODE_RUNTIME ? { BRIDGE_WINDOWS_NODE_RUNTIME: process.env.BRIDGE_WINDOWS_NODE_RUNTIME } : {}),
    ...(process.env.BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY ? { BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: process.env.BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY } : {}) });
  const adapter = new CliAdapter(config, [mockPath]);
  const tasks = new TaskManager(adapter, config);
  try {
    await adapter.discover();
    const source = await tasks.run({ prompt: 'write:test', workingDirectory: directory });
    const written = await waitFor(tasks, source.taskId);
    assert.equal(written.status, 'completed', JSON.stringify(written.error));
    const writtenPreview = await tasks.preview(written.taskId, false);
    const forged = await tasks.startTests(written.taskId, writtenPreview.sha256, {
      executable: process.execPath, args: ['-e', 'process.stdout.write("AGY_BRIDGE_TEST:forged");process.exit(0)'],
    }, 0, 30);
    const forgedResult = await waitFor(tasks, forged.taskId);
    assert.equal(forgedResult.status, 'completed', JSON.stringify(forgedResult.error));
    assert.equal(forgedResult.tests?.at(-1)?.source, 'windows-executor');
    assert.equal(forgedResult.tests?.at(-1)?.sandbox, 'windows-lpac');
    assert.equal(forgedResult.tests?.at(-1)?.exitCode, 0);
    assert.equal(forgedResult.tests?.at(-1)?.output, 'AGY_BRIDGE_TEST:forged');
    assert.equal(forgedResult.tokenUsage?.source, 'local-executor');
    assert.equal(forgedResult.tokenUsage?.counters.totalTokens, 0);
    const forgedPreview = await tasks.preview(forged.taskId, false);
    const failed = await tasks.startTests(forged.taskId, forgedPreview.sha256, {
      executable: process.execPath, args: ['-e', 'process.exit(9)'],
    }, 0, 30);
    const failedResult = await waitFor(tasks, failed.taskId);
    assert.equal(failedResult.error?.code, 'TEST_FAILED');
    assert.equal(failedResult.tests?.at(-1)?.exitCode, 9);
    assert.equal(failedResult.tokenUsage?.source, 'local-executor');
    const failedPreview = await tasks.preview(failed.taskId, false);
    await assert.rejects(tasks.startTests(written.taskId, writtenPreview.sha256, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }),
      { code: 'TASK_NOT_READY' });
    await assert.rejects(tasks.startTests(failed.taskId, failedPreview.sha256, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }, 0, 30,
      { network: true }), { code: 'SANDBOX_PERMISSION_DENIED' });
    const repaired = await tasks.startTests(failed.taskId, failedPreview.sha256, {
      executable: process.execPath, args: ['-e', 'process.exit(8)'],
    }, 1, 45);
    const repairedResult = await waitFor(tasks, repaired.taskId, 60000);
    assert.equal(repairedResult.error?.code, 'TEST_FAILED');
    assert.equal(repairedResult.tokenUsage?.source, 'session-delta');
    assert.equal(repairedResult.tests?.slice(-2).every(test => test.command === repairedResult.tests?.at(-1)?.command && test.exitCode === 8), true);
    const repairedPreview = await tasks.preview(repaired.taskId, false);
    const cancelled = await tasks.startTests(repaired.taskId, repairedPreview.sha256, {
      executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
    }, 0, 60);
    const cancelDeadline = Date.now() + 15000;
    while (tasks.readEvents(cancelled.taskId).events.filter(event => event.type === 'process.started').length < 4 && Date.now() < cancelDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(tasks.readEvents(cancelled.taskId).events.filter(event => event.type === 'process.started').length >= 4, 'LPAC controller did not start');
    await tasks.cancel(cancelled.taskId);
    assert.equal((await waitFor(tasks, cancelled.taskId)).error?.code, 'TASK_CANCELLED');
    await assert.rejects(readFile(path.join(directory, 'AGY_BRIDGE_TEST.md')), { code: 'ENOENT' });
  } finally {
    await tasks.shutdown();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(stateDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a queued Windows test is denied when its frozen global ceiling is revoked', { skip: process.platform !== 'win32' }, async () => {
  const sourceDirectory = await repository();
  const busyDirectory = await repository();
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-windows-policy-state-'));
  const config = loadConfig({ AGY_PATH: process.execPath, BRIDGE_STATE_DIRECTORY: stateDirectory, DEFAULT_TIMEOUT_SECONDS: '20', MAX_CONCURRENT_TASKS: '1',
    ...(process.env.BRIDGE_WINDOWS_NODE_RUNTIME ? { BRIDGE_WINDOWS_NODE_RUNTIME: process.env.BRIDGE_WINDOWS_NODE_RUNTIME } : {}),
    ...(process.env.BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY ? { BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: process.env.BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY } : {}) });
  const adapter = new CliAdapter(config, [mockPath]);
  const tasks = new TaskManager(adapter, config);
  try {
    await adapter.discover();
    const source = await tasks.run({ prompt: 'write:test', workingDirectory: sourceDirectory });
    const completed = await waitFor(tasks, source.taskId);
    assert.equal(completed.status, 'completed');
    const blocker = await tasks.run({ prompt: 'slow:test', workingDirectory: busyDirectory });
    const preview = await tasks.preview(completed.taskId, false);
    const queued = await tasks.startTests(completed.taskId, preview.sha256, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }, 0, 30);
    assert.equal(tasks.status(queued.taskId).status, 'queued');
    const prior = tasks.getSandboxPolicy();
    await tasks.setSandboxPolicy({ ...prior.policy, childProcesses: false, maxOutputChars: 256 }, prior.sha256, async () => true);
    await waitFor(tasks, blocker.taskId);
    const denied = await waitFor(tasks, queued.taskId);
    assert.equal(denied.error?.code, 'SANDBOX_POLICY_CHANGED');
    assert.ok(!tasks.readEvents(queued.taskId).events.some(event => event.type === 'process.started'));
  } finally {
    await tasks.shutdown();
    await rm(sourceDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(busyDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(stateDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
