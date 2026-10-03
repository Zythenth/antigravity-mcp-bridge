import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state-store.js';
import { discardProjectCopy } from '../src/isolation.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

async function fixture(profile = 'full', withApproval = false, environment: Record<string, string> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-feature-test-'));
  const source = path.join(directory, 'source');
  execFileSync('git', ['init', '--quiet', source]);
  await writeFile(path.join(source, 'source.txt'), 'source');
  const client = new Client({ name: 'feature-test', version: '1' }, { capabilities: withApproval ? { elicitation: { form: {} } } : {} });
  if (withApproval) client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { confirm: true } }));
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./mcp-fixture.js', import.meta.url))],
    env: { ...process.env as Record<string, string>, ...environment, BRIDGE_TOOL_PROFILE: profile, BRIDGE_STATE_DIRECTORY: path.join(directory, 'state') },
    stderr: 'pipe' }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    return result.structuredContent as Record<string, any>;
  };
  return { client, source, call, async close() {
    for (const task of (await call('antigravity_tasks')).tasks) {
      if (!(await call('antigravity_result', { taskId: task.taskId })).ready) {
        await call('antigravity_cancel', { taskId: task.taskId });
        await call('antigravity_wait', { taskId: task.taskId, timeoutSeconds: 10 });
      }
    }
    await client.close();
    for (const saved of new StateStore(path.join(directory, 'state')).load()) if (saved.project) await discardProjectCopy(saved.project);
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('agy-feature-test-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}

test('tool profiles reduce the MCP catalog and reject writes in query/review', async () => {
  assert.throws(() => loadConfig({ BRIDGE_TOOL_PROFILE: 'unknown' }));
  for (const [profile, count] of [['full', 28], ['query', 19], ['review', 22], ['implementation', 28]] as const) {
    const f = await fixture(profile);
    try {
      const names = (await f.client.listTools()).tools.map(tool => tool.name);
      assert.equal(names.length, count, profile);
      const health = await f.call('antigravity_health');
      assert.equal(health.toolProfile, profile);
      assert.equal(health.bridgeLimitations.interactiveReplies.available, false);
      assert.equal(health.bridgeLimitations.preflightTokenCount.available, false);
      assert.equal(health.bridgeLimitations.preflightTokenCount.exactTokens, null);
      if (profile === 'query' || profile === 'review') {
        assert.ok(!names.includes('antigravity_integrate'));
        assert.ok(!names.includes('antigravity_test'));
        const disabled = await f.client.callTool({ name: 'antigravity_set_model', arguments: { model: null } });
        assert.equal(disabled.isError, true);
        const write = await f.client.callTool({ name: 'antigravity_run', arguments: { prompt: 'write:test', workingDirectory: f.source, mode: 'write' } });
        assert.equal((write.structuredContent as any).error.code, 'PROFILE_READ_ONLY');
        const run = await f.call('antigravity_run', { prompt: 'slow:test', workingDirectory: f.source });
        assert.equal(run.task.mode, 'read-only');
      }
    } finally { await f.close(); }
  }
});

test('role handoff transfers plans, criteria and decisions to independent copies and rejects stale context', async () => {
  const f = await fixture('full', true);
  try {
    const criteria = [{ id: 'created', description: 'Create the requested file', check: { kind: 'file-exists', path: 'AGY_BRIDGE_TEST.md' } }];
    const plan = await f.call('antigravity_run', { prompt: 'plan:test', role: 'planner', workingDirectory: f.source, acceptanceCriteria: criteria });
    await f.call('antigravity_wait', { taskId: plan.task.taskId, timeoutSeconds: 10 });
    const planContext = await f.call('antigravity_context', { taskId: plan.task.taskId });
    const run = await f.call('antigravity_handoff', { sourceTaskId: plan.task.taskId, expectedContextSha256: planContext.treeSha256,
      role: 'implementer', prompt: 'write:test', decisions: ['Keep the existing source file'] });
    const implemented = await f.call('antigravity_wait', { taskId: run.task.taskId, timeoutSeconds: 10 });
    assert.equal(implemented.status, 'completed');
    const implementation = (await f.call('antigravity_result', { taskId: run.task.taskId })).task;
    assert.deepEqual(implementation.acceptanceCriteria, criteria);
    assert.deepEqual(implementation.handoff.reports[0].data, planContext.report.data);
    assert.ok(implementation.result.response.includes('Keep the existing source file'));
    assert.notEqual(implementation.copyDirectory, (await f.call('antigravity_status', { taskId: plan.task.taskId })).task.copyDirectory);
    const context = await f.call('antigravity_context', { taskId: run.task.taskId });
    const review = await f.call('antigravity_handoff', { sourceTaskId: run.task.taskId, expectedContextSha256: context.treeSha256,
      role: 'reviewer', prompt: 'review:test' });
    assert.equal((await f.call('antigravity_wait', { taskId: review.task.taskId, timeoutSeconds: 10 })).status, 'completed');
    const reviewed = (await f.call('antigravity_result', { taskId: review.task.taskId })).task;
    assert.equal(reviewed.report.citationsChecked, true);
    assert.deepEqual(reviewed.handoff.decisions.items, ['Keep the existing source file']);
    assert.equal(await readFile(path.join(reviewed.copyDirectory, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'Antigravity MCP bridge test successful.');
    assert.equal((await f.call('antigravity_preview', { taskId: run.task.taskId })).summary.added, 1);
    await assert.rejects(readFile(path.join(f.source, 'AGY_BRIDGE_TEST.md')), { code: 'ENOENT' });
    const malicious = await f.call('antigravity_handoff', { sourceTaskId: run.task.taskId, expectedContextSha256: context.treeSha256,
      role: 'reviewer', prompt: 'write-many:test' });
    const violation = await f.call('antigravity_wait', { taskId: malicious.task.taskId, timeoutSeconds: 10 });
    assert.equal(violation.status, 'failed');
    assert.equal((await f.call('antigravity_result', { taskId: malicious.task.taskId })).task.error.code, 'READ_ONLY_VIOLATION');
    assert.equal((await f.call('antigravity_preview', { taskId: run.task.taskId })).summary.added, 1);
    await writeFile(path.join(implementation.copyDirectory, 'source.txt'), 'changed');
    const stale = await f.client.callTool({ name: 'antigravity_handoff', arguments: { sourceTaskId: run.task.taskId,
      expectedContextSha256: context.treeSha256, role: 'reviewer', prompt: 'review:test' } });
    assert.equal((stale.structuredContent as any).error.code, 'CONTEXT_CHANGED');
    await writeFile(path.join(implementation.copyDirectory, '.gitignore'), 'source.txt\n');
    const changedSelection = await f.call('antigravity_context', { taskId: run.task.taskId });
    const excluded = await f.client.callTool({ name: 'antigravity_handoff', arguments: { sourceTaskId: run.task.taskId, expectedContextSha256: changedSelection.treeSha256,
      role: 'reviewer', prompt: 'review:test' } });
    assert.equal((excluded.structuredContent as any).error.code, 'CONTEXT_CHANGED');
    assert.equal(await readFile(path.join(implementation.copyDirectory, 'source.txt'), 'utf8'), 'changed');
    const reviewContext = await f.call('antigravity_context', { taskId: review.task.taskId });
    const fixed = await f.call('antigravity_handoff', { sourceTaskId: review.task.taskId, expectedContextSha256: reviewContext.treeSha256,
      role: 'implementer', prompt: 'split:test' });
    assert.equal((await f.call('antigravity_wait', { taskId: fixed.task.taskId, timeoutSeconds: 10 })).status, 'completed');
    const fixedTask = (await f.call('antigravity_result', { taskId: fixed.task.taskId })).task;
    assert.deepEqual(fixedTask.handoff.reports.map((report: any) => report.role), ['planner', 'reviewer']);
    const preview = await f.call('antigravity_preview', { taskId: fixed.task.taskId });
    const verified = await f.call('antigravity_verify', { taskId: fixed.task.taskId, expectedSha256: preview.sha256, reviews: [{
      criterionId: 'created', verdict: 'passed', path: 'AGY_BRIDGE_TEST.md', line: 1, quote: 'Antigravity MCP bridge test successful.', explanation: 'Checked the inherited artifact',
    }] });
    assert.equal(verified.status, 'passed');
    await f.call('antigravity_integrate', { taskId: fixed.task.taskId, expectedSha256: preview.sha256 });
    assert.equal(await readFile(path.join(f.source, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'Antigravity MCP bridge test successful.');
  } finally { await f.close(); }
});

test('model comparison preserves distinct opinions, failures and stale evidence', async () => {
  const f = await fixture('full', false, { MAX_CONCURRENT_TASKS: '2' });
  try {
    const source = await f.call('antigravity_run', { prompt: 'plan:test', role: 'planner', workingDirectory: f.source });
    await f.call('antigravity_wait', { taskId: source.task.taskId, timeoutSeconds: 10 });
    const context = await f.call('antigravity_context', { taskId: source.task.taskId });
    const args = { sourceTaskId: source.task.taskId, expectedContextSha256: context.treeSha256, models: ['mock-pro', 'mock-flash'], prompt: 'comparison:test' };
    const unavailable = await f.client.callTool({ name: 'antigravity_compare', arguments: { ...args, models: ['mock-pro', 'unknown'] } });
    assert.equal((unavailable.structuredContent as any).error.code, 'MODEL_NOT_AVAILABLE');
    assert.equal((await f.call('antigravity_tasks')).tasks.length, 1);
    const duplicate = await f.client.callTool({ name: 'antigravity_compare', arguments: { ...args, models: ['mock-pro', 'mock-pro'] } });
    assert.equal(duplicate.isError, true);
    const started = await f.call('antigravity_compare', args);
    assert.equal(started.taskIds.length, 2);
    for (const taskId of started.taskIds) await f.call('antigravity_wait', { taskId, timeoutSeconds: 10 });
    const comparison = await f.call('antigravity_comparison', { comparisonId: started.comparisonId });
    assert.equal(comparison.complete, true);
    assert.equal(comparison.contextStale, false);
    assert.equal(comparison.findings[0].agreement, 'different');
    assert.deepEqual(comparison.opinions.map((opinion: any) => opinion.model), ['mock-pro', 'mock-flash']);
    const member = (await f.call('antigravity_result', { taskId: started.taskIds[0] })).task;
    await writeFile(path.join(member.copyDirectory, 'source.txt'), 'changed');
    const stale = await f.call('antigravity_comparison', { comparisonId: started.comparisonId });
    assert.equal(stale.complete, false);
    assert.equal(stale.contextStale, true);
    assert.equal(stale.findings[0].agreement, 'not-reported-by-all');
    const failed = await f.call('antigravity_compare', { ...args, prompt: 'fabricated-review:test' });
    for (const taskId of failed.taskIds) await f.call('antigravity_wait', { taskId, timeoutSeconds: 10 });
    const failure = await f.call('antigravity_comparison', { comparisonId: failed.comparisonId });
    assert.equal(failure.ready, true);
    assert.equal(failure.complete, false);
    assert.ok(failure.opinions.every((opinion: any) => opinion.error.code === 'ROLE_OUTPUT_INVALID'));
    assert.deepEqual(failure.findings, []);
  } finally { await f.close(); }
});

test('wait sends event-based MCP progress and timeouts/cancellation preserve execution', async () => {
  const f = await fixture();
  try {
    const run = await f.call('antigravity_run', { prompt: 'split:test', workingDirectory: f.source, mode: 'read-only' });
    const progress: Array<{ progress: number; message?: string; total?: number }> = [];
    const response = await f.client.callTool({ name: 'antigravity_wait', arguments: { taskId: run.task.taskId, timeoutSeconds: 10 } },
      undefined, { onprogress: update => progress.push(update) });
    const done = response.structuredContent as any;
    assert.equal(response.isError, undefined);
    assert.equal(done.status, 'completed');
    assert.equal(done.ready, true);
    assert.equal(done.timedOut, false);
    assert.ok(progress.some(update => update.message?.endsWith('tool.completed')));
    assert.deepEqual(progress.map(update => update.progress), done.events.map((event: any) => event.sequence));
    assert.ok(progress.every(update => update.total === undefined));
    const continued = await f.call('antigravity_wait', { taskId: run.task.taskId, after: done.nextCursor });
    assert.deepEqual(continued.events, []);
    const slow = await f.call('antigravity_run', { prompt: 'cancel:test', workingDirectory: f.source, timeoutSeconds: 10 });
    const timed = await f.call('antigravity_wait', { taskId: slow.task.taskId, timeoutSeconds: 1 });
    assert.equal(timed.timedOut, true);
    assert.equal(timed.ready, false);
    const controller = new AbortController();
    const pending = f.client.callTool({ name: 'antigravity_wait', arguments: { taskId: slow.task.taskId } }, undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending);
    assert.equal((await f.call('antigravity_result', { taskId: slow.task.taskId })).ready, false);
    await f.call('antigravity_cancel', { taskId: slow.task.taskId });
    assert.equal((await f.call('antigravity_wait', { taskId: slow.task.taskId, timeoutSeconds: 10 })).status, 'cancelled');
  } finally { await f.close(); }
});
