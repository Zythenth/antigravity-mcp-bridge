import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { withAgedServer } from './aged-state.mjs';

const reviews = [
  {
    criterionId: 'created',
    verdict: 'passed',
    path: 'AGY_BRIDGE_TEST.md',
    line: 1,
    quote: 'Antigravity MCP bridge test successful.',
    explanation: 'Reviewed the requested artifact',
  },
];

async function settle(client, taskId) {
  const terminal = new Set(['completed', 'failed', 'cancelled', 'timeout']);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const res = await client.request(
      { method: 'tools/call', params: { name: 'antigravity_status', arguments: { taskId } } },
      CallToolResultSchema,
    );
    const task = res.structuredContent?.task;
    if (task && terminal.has(task.status)) return task;
    await delay(100);
  }
  throw new Error(`Task ${taskId} did not settle within 120s`);
}

export function assertCoverage(toolNames, caseNames) {
  const seen = new Set();
  const duplicates = [];
  for (const name of caseNames) {
    if (seen.has(name)) duplicates.push(name);
    seen.add(name);
  }
  if (duplicates.length) {
    throw new Error(`Duplicate case names: ${duplicates.join(', ')}`);
  }
  const toolSet = new Set(toolNames);
  const caseSet = new Set(caseNames);
  const missingCases = toolNames.filter(name => !caseSet.has(name));
  const orphanCases = caseNames.filter(name => !toolSet.has(name));
  if (missingCases.length || orphanCases.length) {
    const parts = [];
    if (missingCases.length) parts.push(`tools without a case: ${missingCases.join(', ')}`);
    if (orphanCases.length) parts.push(`cases without a tool: ${orphanCases.join(', ')}`);
    throw new Error(`Tool coverage mismatch: ${parts.join('; ')}`);
  }
}

export const toolCases = [
  { name: 'antigravity_health', args: () => ({}) },
  { name: 'antigravity_list_models', args: () => ({}) },
  { name: 'antigravity_get_model', args: () => ({}) },
  { name: 'antigravity_set_model', args: () => ({ model: null }) },
  { name: 'antigravity_get_sandbox_policy', args: () => ({}), check: async (result, c) => { c.policy = result; } },
  { name: 'antigravity_set_sandbox_policy', args: c => ({ policy: c.policy.policy, expectedSha256: c.policy.sha256 }) },
  { name: 'antigravity_roles', args: () => ({}) },
  { name: 'antigravity_get_agent_policy', args: () => ({}) },
  { name: 'antigravity_list_project_files', args: c => ({ workingDirectory: c.source }) },
  { name: 'antigravity_memory_list', args: c => ({ workingDirectory: c.source }) },
  {
    name: 'antigravity_memory_write',
    args: c => ({ workingDirectory: c.source, specialist: 'contract', text: 'Contract note.', expectedSha256: null }),
    check: async (result, c) => { c.memory = result.memory.sha256; },
  },
  { name: 'antigravity_memory_read', args: c => ({ workingDirectory: c.source, specialist: 'contract', expectedSha256: c.memory }) },
  { name: 'antigravity_memory_remove', args: c => ({ workingDirectory: c.source, specialist: 'contract', expectedSha256: c.memory }) },
  {
    name: 'antigravity_run',
    args: c => ({
      prompt: 'write:contract',
      workingDirectory: c.source,
      artifactPaths: ['AGY_BRIDGE_TEST.md'],
      acceptanceCriteria: [
        {
          id: 'created',
          description: 'Create the file',
          check: { kind: 'file-contains', path: 'AGY_BRIDGE_TEST.md', text: 'successful.' },
        },
      ],
    }),
    check: async (result, c) => { c.task = result.task.taskId; },
  },
  {
    name: 'antigravity_wait',
    args: c => ({ taskId: c.task, timeoutSeconds: 30 }),
    check: async (result, c) => {
      const task = await settle(c.client, c.task);
      assert.equal(task.status, 'completed', `[${c.scenario}] antigravity_wait: ${JSON.stringify(task.error)}`);
      c.session = task.sessionId;
    },
  },
  { name: 'antigravity_events', args: c => ({ taskId: c.task }) },
  { name: 'antigravity_result', args: c => ({ taskId: c.task, includeResult: false }) },
  { name: 'antigravity_read_result', args: c => ({ taskId: c.task }) },
  { name: 'antigravity_status', args: c => ({ taskId: c.task }) },
  { name: 'antigravity_tasks', args: () => ({}) },
  { name: 'antigravity_sessions', args: () => ({}) },
  {
    name: 'antigravity_artifacts',
    args: c => ({ taskId: c.task }),
    check: async (result, c) => {
      c.artifact = result.artifacts[0];
      assert.equal(c.artifact?.path, 'AGY_BRIDGE_TEST.md', `[${c.scenario}] antigravity_artifacts: artifact path mismatch`);
    },
  },
  { name: 'antigravity_read_artifact', args: c => ({ taskId: c.task, path: c.artifact.path, expectedSha256: c.artifact.sha256 }) },
  { name: 'antigravity_read_structured_result', args: c => ({ taskId: c.task }), error: 'STRUCTURED_RESULT_NOT_AVAILABLE' },
  { name: 'antigravity_preview', args: c => ({ taskId: c.task, includePatch: false }), check: async (result, c) => { c.sha = result.sha256; } },
  { name: 'antigravity_read_patch', args: c => ({ taskId: c.task, expectedSha256: c.sha }) },
  { name: 'antigravity_record_test', args: c => ({ taskId: c.task, expectedSha256: c.sha, command: 'node --version', exitCode: 0, output: 'v24' }) },
  {
    name: 'antigravity_test',
    args: c => ({
      taskId: c.task,
      expectedSha256: c.sha,
      command: { executable: process.execPath, args: ['-e', "console.log('contract checked')"] },
      timeoutSeconds: 60,
    }),
    check: async (result, c) => {
      c.testTask = result.task.taskId;
      const task = await settle(c.client, c.testTask);
      assert.equal(task.status, 'completed', `[${c.scenario}] antigravity_test: ${JSON.stringify(task.error)}`);
      assert.equal(task.tests?.at(-1)?.source, 'agy-tool', `[${c.scenario}] antigravity_test: test source mismatch`);
      assert.equal(task.tests?.at(-1)?.exitCode, 0, `[${c.scenario}] antigravity_test: test exit code mismatch`);
    },
  },
  {
    name: 'antigravity_verify',
    args: c => ({ taskId: c.testTask, expectedSha256: c.sha, reviews }),
    check: async (result, c) => {
      assert.equal(result.status, 'passed', `[${c.scenario}] antigravity_verify: status mismatch`);
    },
  },
  { name: 'antigravity_context', args: c => ({ taskId: c.task }), check: async (result, c) => { c.context = result.treeSha256; } },
  {
    name: 'antigravity_handoff',
    args: c => ({ sourceTaskId: c.task, expectedContextSha256: c.context, prompt: 'Review the contract file.', role: 'reviewer' }),
    check: async (result, c) => { await settle(c.client, result.task.taskId); },
  },
  {
    name: 'antigravity_compare',
    args: c => ({ sourceTaskId: c.task, expectedContextSha256: c.context, models: ['mock-pro', 'mock-flash'], prompt: 'Compare the contract file.' }),
    check: async (result, c) => { c.comparison = result; },
  },
  {
    name: 'antigravity_wait_many',
    args: c => ({ targets: c.comparison.taskIds.map(taskId => ({ taskId })), timeoutSeconds: 30 }),
    check: async (result, c) => {
      for (const taskId of c.comparison.taskIds) {
        await settle(c.client, taskId);
      }
    },
  },
  { name: 'antigravity_comparison', args: c => ({ comparisonId: c.comparison.comparisonId }) },
  {
    name: 'antigravity_resume',
    args: c => ({ prompt: 'Continue the review.', workingDirectory: c.source, sessionId: c.session }),
    check: async (result, c) => { await settle(c.client, result.task.taskId); },
  },
  { name: 'antigravity_set_delivery_mode', args: c => ({ taskId: c.task, deliveryMode: 'messages' }) },
  { name: 'antigravity_send_message', args: c => ({ taskId: c.task, messageId: randomUUID(), text: 'Contract message.' }) },
  { name: 'antigravity_integrate', args: c => ({ taskId: c.testTask, expectedSha256: c.sha }) },
  { name: 'antigravity_cancel', args: c => ({ taskId: c.task }) },
  {
    name: 'antigravity_group_create',
    args: c => ({
      groupId: (c.group = randomUUID()),
      definition: {
        workingDirectory: c.source,
        title: 'Contract',
        jobs: [{ key: 'a', owner: 'implementer', dependsOn: [], task: { prompt: 'Inspect A.', mode: 'read-only' } }],
      },
    }),
    check: async (result, c) => { c.groupSha = result.group.definitionSha256; },
  },
  { name: 'antigravity_group_start', args: c => ({ groupId: c.group, expectedDefinitionSha256: c.groupSha }) },
  { name: 'antigravity_group_status', args: c => ({ groupId: c.group }) },
  { name: 'antigravity_groups', args: () => ({}) },
  { name: 'antigravity_group_wait', args: c => ({ groupId: c.group, timeoutSeconds: 30 }) },
  { name: 'antigravity_peer_receipts', args: c => ({ groupId: c.group }) },
  { name: 'antigravity_workflow_result', args: c => ({ groupId: c.group }), error: 'WORKFLOW_NOT_READY' },
  { name: 'antigravity_group_cancel', args: c => ({ groupId: c.group }) },
  { name: 'antigravity_discard', args: c => ({ taskId: c.task }) },
  { name: 'antigravity_cleanup', args: () => ({}) },
  { name: 'antigravity_usage', args: () => ({}) },
];

export async function checkToolContracts(bin, root) {
  const caseNames = toolCases.map(toolCase => toolCase.name);
  assert.throws(() => assertCoverage([...caseNames, 'antigravity_extra_tool'], caseNames), /antigravity_extra_tool/);
  assert.throws(() => assertCoverage(caseNames, [...caseNames, 'antigravity_orphan_case']), /antigravity_orphan_case/);
  for (const name of [
    'antigravity_group_cancel',
    'antigravity_group_status',
    'antigravity_groups',
    'antigravity_send_message',
    'antigravity_set_delivery_mode',
    'antigravity_workflow_result',
  ]) {
    assert.ok(caseNames.includes(name), `Missing case for ${name}`);
  }

  const agySpawn = fileURLToPath(new URL('./agy-spawn.mjs', import.meta.url));
  const serverArgs = ['--import', pathToFileURL(agySpawn).href];
  // The SDK passes the real profile variables; an empty profile keeps personal folders out of the contract.
  // PSModulePath is not among the SDK defaults; without it, the PowerShell listing that verifies process cleanup
  // took 18 to 25 s on Windows CI runners, past its 15 s limit, against under half a second with it.
  const home = path.join(root, 'contract-home');
  await mkdir(home, { recursive: true });
  const serverEnv = {
    AGY_PATH: fileURLToPath(new URL('./mock-agy.mjs', import.meta.url)),
    BRIDGE_TEST_EXECUTOR: 'agy',
    BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: path.join(root, 'contract-node-cache'),
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
  };
  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'PSModulePath']) {
    if (process.env[key] !== undefined) serverEnv[key] = process.env[key];
  }
  const serverOptions = { args: serverArgs, env: serverEnv };

  async function runScenario(scenario, label, client, source) {
    const start = Date.now();
    const listed = await client.listTools();
    const listedNames = listed.tools.map(tool => tool.name);
    assertCoverage(listedNames, caseNames);
    const ajv = new AjvJsonSchemaValidator();
    const validators = new Map(listed.tools.map(tool => [tool.name, ajv.getValidator(tool.outputSchema)]));
    const context = { source, client, scenario };
    for (const toolCase of toolCases) {
      const args = toolCase.args(context);
      const response = await client.request(
        { method: 'tools/call', params: { name: toolCase.name, arguments: args } },
        CallToolResultSchema,
      );
      assert.equal(Array.isArray(response.content) && response.content.length === 1, true, `[${scenario}] ${toolCase.name}: content must be an array of length 1`);
      assert.equal(response.content[0]?.type, 'text', `[${scenario}] ${toolCase.name}: content[0].type must be 'text'`);
      assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent, `[${scenario}] ${toolCase.name}: JSON.parse(content[0].text) must equal structuredContent`);

      if (toolCase.error) {
        assert.equal(response.isError, true, `[${scenario}] ${toolCase.name}: isError must be true`);
        assert.deepEqual(Object.keys(response.structuredContent), ['error'], `[${scenario}] ${toolCase.name}: structuredContent keys must be ['error']`);
        const errorObj = response.structuredContent.error;
        assert.ok(errorObj && typeof errorObj === 'object', `[${scenario}] ${toolCase.name}: error must be an object`);
        assert.deepEqual(Object.keys(errorObj).sort(), ['code', 'message'], `[${scenario}] ${toolCase.name}: error keys must be ['code', 'message']`);
        assert.equal(errorObj.code, toolCase.error, `[${scenario}] ${toolCase.name}: error code mismatch`);
        assert.equal(typeof errorObj.message === 'string' && errorObj.message.length > 0, true, `[${scenario}] ${toolCase.name}: error message must be a non-empty string`);
      } else {
        assert.equal(!response.isError, true, `[${scenario}] ${toolCase.name}: unexpected error ${JSON.stringify(response.structuredContent?.error)}`);
        const validator = validators.get(toolCase.name);
        assert.ok(validator, `[${scenario}] ${toolCase.name}: missing validator`);
        const { valid, errorMessage } = validator(response.structuredContent);
        assert.equal(valid, true, `[${scenario}] ${toolCase.name}: ${errorMessage}`);
      }
      if (toolCase.check) {
        await toolCase.check(response.structuredContent, context);
      }
      await client.ping();
    }
    const duration = Date.now() - start;
    console.log(`tarball: tool contract (${label}): ${toolCases.length} tools passed in ${duration} ms`);
  }

  await withAgedServer(bin, root, 'contract-empty', async ({ run, caseRoot }) => {
    assert.deepEqual(run(0, 0, 0).tasks, []);
    return { source: path.join(caseRoot, 'source') };
  }, async ({ client, source }) => {
    await runScenario('contract-empty', 'empty', client, source);
  }, serverOptions);

  await withAgedServer(bin, root, 'contract-aged', async ({ run, caseRoot }) => {
    const expired = run(3, 1, 0);
    assert.equal(expired.tasks.length, 4);
    assert.equal(typeof expired.groupId, 'string');
    const expiredIds = new Set(expired.tasks.map(task => task.taskId));
    const retainedList = run(1, 0, 100 * 3600000).tasks.filter(task => !expiredIds.has(task.taskId));
    assert.equal(retainedList.length, 1);
    return { source: path.join(caseRoot, 'source'), expired: expired.tasks, groupId: expired.groupId, retained: retainedList[0] };
  }, async ({ client, source }) => {
    await runScenario('contract-aged', 'aged', client, source);
  }, serverOptions);
}
