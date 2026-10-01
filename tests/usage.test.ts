import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateUsage, normalizeUsage, taskTokenUsage } from '../src/usage.js';
import type { TaskRecord } from '../src/types.js';

function task(taskId: string, model: string, usage: Record<string, unknown>, extra: Partial<TaskRecord> = {}): TaskRecord {
  return { taskId, sessionId: 'session', model, prompt: 'test', workingDirectory: '/fixture', status: 'completed', createdAt: '2026-10-01T00:00:00Z',
    usageIsResume: false, result: { usage }, ...extra };
}
const firstUsage = { input_tokens: 100, output_tokens: 20, total_tokens: 120, thinking_tokens: 5, cache_read_tokens: 40 };

test('session deltas avoid double counting across resumed tasks and model changes', () => {
  const first = task('one', 'model-a', firstUsage);
  const second = task('two', 'model-b', { input_tokens: 140, output_tokens: 30, total_tokens: 170, thinking_tokens: 8, cache_read_tokens: 60 },
    { usageIsResume: true, usageBaseline: normalizeUsage(firstUsage), status: 'failed' });
  const summary = aggregateUsage([first, second]);
  assert.equal(summary.counters.totalTokens, 170);
  assert.equal(summary.byTask[1]?.counters.totalTokens, 50);
  assert.equal(summary.byTask[1]?.source, 'session-delta');
  assert.equal(summary.byModel[0]?.counters.totalTokens, 120);
  assert.equal(summary.byModel[1]?.counters.totalTokens, 50);
  assert.equal(summary.bySession[0]?.observedCumulative?.totalTokens, 170);
  assert.equal(aggregateUsage([second]).counters.totalTokens, 50);
});
test('missing, malformed, reset and overflowing counters never become fabricated zeros or totals', () => {
  const absent = taskTokenUsage(task('missing', 'model', {}));
  assert.equal(absent.available, false);
  assert.equal(absent.counters.totalTokens, null);
  const invalid = normalizeUsage({ input_tokens: '100', output_tokens: -1, total_tokens: 1.5, thinking_tokens: 0 });
  assert.equal(invalid.inputTokens, null);
  assert.equal(invalid.thinkingTokens, 0);
  const resume = task('resume', 'model', firstUsage, { usageIsResume: true });
  assert.equal(taskTokenUsage(resume).counters.totalTokens, null);
  const reset = task('reset', 'model', firstUsage, { usageIsResume: true, usageBaseline: normalizeUsage({ ...firstUsage, total_tokens: 500 }) });
  assert.equal(taskTokenUsage(reset).counters.totalTokens, null);
  assert.ok(taskTokenUsage(reset).warnings.includes('Counter reset: totalTokens'));
  const huge = task('huge', 'model', { ...firstUsage, total_tokens: Number.MAX_SAFE_INTEGER });
  assert.equal(aggregateUsage([huge, huge]).counters.totalTokens, null);
});
