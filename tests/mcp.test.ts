import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

test('MCP subprocess restart recovers results, events, review baseline and discard', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-protocol-test-'));
  const source = path.join(dir, 'source');
  execFileSync('git', ['init', '--quiet', source]);
  const submittedSource = process.platform === 'win32' ? source.toUpperCase() : source;
  await writeFile(path.join(source, 'source.txt'), 'original');
  let client: Client | undefined;
  let decision: 'accept' | 'decline' | 'cancel' = 'accept';
  let confirmation = false;
  const confirmations: string[] = [];
  async function connect(withElicitation = false): Promise<Client> {
    const next = new Client({ name: 'bridge-contract-test', version: '1' }, { capabilities: withElicitation ? { elicitation: { form: {} } } : {} });
    if (withElicitation) next.setRequestHandler(ElicitRequestSchema, async request => {
      assert.equal(request.params.mode, 'form');
      if (request.params.mode !== 'form') throw new Error('Unexpected elicitation mode');
      confirmations.push(request.params.message);
      assert.equal(request.params.requestedSchema.properties.confirm?.default, false);
      return { action: decision, ...(decision === 'accept' ? { content: { confirm: confirmation } } : {}) };
    });
    await next.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('./mcp-fixture.js', import.meta.url))],
      env: { ...process.env as Record<string, string>, BRIDGE_STATE_DIRECTORY: path.join(dir, 'state') }, stderr: 'pipe' }));
    const tools = await next.listTools();
    assert.equal(tools.tools.length, 24);
    for (const tool of tools.tools) {
      assert.equal(tool.outputSchema?.type, 'object', tool.name);
      assert.ok(Object.keys(tool.outputSchema?.properties || {}).length > 0, tool.name);
    }
    return next;
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client!.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    return result.structuredContent as Record<string, any>;
  }
  try {
    client = await connect();
    assert.equal((await call('antigravity_list_models')).models.length, 2);
    assert.equal((await call('antigravity_get_model')).model, null);
    assert.equal((await call('antigravity_set_model', { model: 'mock-pro' })).model, 'mock-pro');
    assert.ok((await call('antigravity_list_project_files', { workingDirectory: submittedSource })).files.includes('source.txt'));
    assert.deepEqual((await call('antigravity_cleanup')).discardedTaskIds, []);
    assert.equal((await call('antigravity_health')).integrationApproval.available, false);
    let taskId = (await call('antigravity_run', { prompt: 'write:test', workingDirectory: submittedSource,
      acceptanceCriteria: [{ id: 'created', description: 'Create the requested file', check: { kind: 'file-contains', path: 'AGY_BRIDGE_TEST.md', text: 'successful.' } }] })).task.taskId;
    const deadline = Date.now() + 10000;
    let final;
    while (Date.now() < deadline) {
      final = await call('antigravity_result', { taskId });
      if (final.ready) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(final?.task.status, 'completed');
    const compact = await call('antigravity_result', { taskId, includeResult: false });
    assert.equal(compact.task.result, undefined);
    assert.equal(compact.task.prompt, undefined);
    assert.ok(compact.includedFileCount >= 1);
    const resultChunk = await call('antigravity_read_result', { taskId, limit: 50000 });
    assert.deepEqual(JSON.parse(resultChunk.text), final.task.result);
    const firstPreview = await call('antigravity_preview', { taskId });
    const compactPreview = await call('antigravity_preview', { taskId, includePatch: false });
    assert.equal(compactPreview.patch, undefined);
    assert.equal(compactPreview.sha256, firstPreview.sha256);
    const patchChunk = await call('antigravity_read_patch', { taskId, expectedSha256: firstPreview.sha256, path: 'AGY_BRIDGE_TEST.md' });
    assert.equal(patchChunk.text, firstPreview.patch);
    await call('antigravity_verify', { taskId, expectedSha256: firstPreview.sha256,
      reviews: [{ criterionId: 'created', verdict: 'passed', path: 'AGY_BRIDGE_TEST.md', line: 1, quote: 'Antigravity MCP bridge test successful.', explanation: 'Reviewed the requested artifact' }] });
    const events = await call('antigravity_events', { taskId });
    const unavailable = await client.callTool({ name: 'antigravity_integrate', arguments: { taskId, expectedSha256: firstPreview.sha256, approved: true } });
    assert.equal((unavailable.structuredContent as any).error.code, 'APPROVAL_UNAVAILABLE');
    await client.close();
    client = await connect(true);
    assert.equal((await call('antigravity_get_model')).model, 'mock-pro');
    assert.equal((await call('antigravity_set_model', { model: null })).model, null);
    assert.equal((await call('antigravity_get_model')).model, null);
    await call('antigravity_set_model', { model: 'mock-pro' });
    assert.equal((await call('antigravity_health')).integrationApproval.available, true);
    assert.equal((await call('antigravity_result', { taskId })).task.copyDirectory, final.task.copyDirectory);
    assert.deepEqual(await call('antigravity_events', { taskId }), events);
    assert.ok((await call('antigravity_tasks')).tasks.some((task: { taskId: string }) => task.taskId === taskId));
    await assert.rejects(readFile(path.join(source, 'AGY_BRIDGE_TEST.md')), { code: 'ENOENT' });
    const preview = await call('antigravity_preview', { taskId });
    const canonicalSource = await realpath(source);
    assert.equal(preview.sourceDirectory, canonicalSource);
    assert.equal(preview.summary.added, 1);
    const verified = await call('antigravity_verify', { taskId, expectedSha256: preview.sha256,
      reviews: [{ criterionId: 'created', verdict: 'passed', path: 'AGY_BRIDGE_TEST.md', line: 1, quote: 'Antigravity MCP bridge test successful.', explanation: 'Reviewed the requested artifact' }] });
    assert.equal(verified.status, 'passed');
    const testScript = "if (require('node:fs').readFileSync('AGY_BRIDGE_TEST.md','utf8') !== 'Antigravity MCP bridge test successful.') process.exit(1); console.log('file checked');";
    const output = execFileSync(process.execPath, ['-e', testScript], { cwd: final.task.copyDirectory, encoding: 'utf8' });
    await call('antigravity_record_test', { taskId, expectedSha256: preview.sha256, command: 'node -e ' + testScript, exitCode: 0, output });
    assert.equal((await call('antigravity_preview', { taskId })).tests[0].stale, false);
    taskId = (await call('antigravity_test', { taskId, expectedSha256: preview.sha256, timeoutSeconds: 20,
      command: { executable: process.execPath, args: ['-e', testScript] } })).task.taskId;
    const testDeadline = Date.now() + 15000;
    let observed;
    while (Date.now() < testDeadline) {
      observed = await call('antigravity_result', { taskId });
      if (observed.ready) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(observed?.task.status, 'completed', JSON.stringify(observed?.task.error));
    assert.equal(observed.task.tests.at(-1).source, 'agy-tool');
    assert.equal(observed.task.tests.at(-1).exitCode, 0);
    assert.equal((await call('antigravity_status', { taskId })).task.status, 'completed');
    assert.ok((await call('antigravity_sessions')).sessions.some((session: { sessionId: string }) => session.sessionId === observed.task.sessionId));
    assert.equal((await call('antigravity_cancel', { taskId })).task.status, 'completed');
    assert.equal(observed.task.tokenUsage.counters.totalTokens, 3);
    const consumption = await call('antigravity_usage', { sessionId: observed.task.sessionId });
    assert.equal(consumption.counters.totalTokens, 6);
    assert.equal(consumption.bySession[0].observedCumulative.totalTokens, 6);
    assert.equal(consumption.byModel[0].model, 'mock-pro');
    await call('antigravity_verify', { taskId, expectedSha256: preview.sha256,
      reviews: [{ criterionId: 'created', verdict: 'passed', path: 'AGY_BRIDGE_TEST.md', line: 1, quote: 'Antigravity MCP bridge test successful.', explanation: 'Reviewed the artifact after native tests' }] });
    for (const response of ['decline', 'cancel', 'accept'] as const) {
      decision = response;
      const denied = await client.callTool({ name: 'antigravity_integrate', arguments: { taskId, expectedSha256: preview.sha256 } });
      assert.equal((denied.structuredContent as any).error.code, 'APPROVAL_DENIED');
      await assert.rejects(readFile(path.join(source, 'AGY_BRIDGE_TEST.md')), { code: 'ENOENT' });
    }
    confirmation = true;
    await call('antigravity_integrate', { taskId, expectedSha256: preview.sha256 });
    assert.equal(confirmations.length, 4);
    assert.ok(confirmations.every(message => message.includes(preview.sha256) && message.includes(JSON.stringify(canonicalSource))));
    assert.equal(await readFile(path.join(source, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'Antigravity MCP bridge test successful.');
    await call('antigravity_discard', { taskId });
    await assert.rejects(readFile(path.join(final.task.copyDirectory, 'source.txt')), { code: 'ENOENT' });
  } finally {
    await client?.close();
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('agy-mcp-protocol-test-'));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
