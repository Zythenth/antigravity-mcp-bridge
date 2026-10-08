import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { StateStore } from '../src/state-store.js';

const taskId = '76f04ea1-cd2e-4d81-b8db-7559050d860a';
const counters = { inputTokens: 100, outputTokens: 20, totalTokens: 120, thinkingTokens: null, cacheReadTokens: 40 };

function snapshot(record: Record<string, unknown> = {}) {
  const workingDirectory = path.join(path.sep, 'synthetic-usage-state-workspace');
  return {
    version: 1,
    ownerPid: 1,
    record: {
      taskId,
      workingDirectory,
      prompt: 'synthetic persisted task',
      status: 'completed',
      createdAt: '2026-10-06T00:00:00.000Z',
      ...record,
    },
    options: { prompt: 'synthetic persisted task', workingDirectory },
    events: [],
    cursor: 0,
  };
}

test('task reload validates observed CLI usage fields and preserves valid legacy snapshots', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-usage-state-test-'));
  const file = path.join(directory, taskId + '.json');
  const state = new StateStore(directory);
  try {
    writeFileSync(file, JSON.stringify(snapshot({ lastObservedCliUsage: counters, usageProvenance: 'local-executor' })));
    const persisted = state.load()[0]?.record;
    assert.deepEqual(persisted?.lastObservedCliUsage, counters);
    assert.equal(persisted?.usageProvenance, 'local-executor');

    writeFileSync(file, JSON.stringify(snapshot()));
    const legacy = state.load()[0]?.record;
    assert.equal('lastObservedCliUsage' in (legacy ?? {}), false);
    assert.equal('usageProvenance' in (legacy ?? {}), false);

    for (const record of [
      { lastObservedCliUsage: { ...counters, totalTokens: -1 } },
      { lastObservedCliUsage: { totalTokens: 120 } },
      { usageProvenance: 'cli' },
    ]) {
      writeFileSync(file, JSON.stringify(snapshot(record)));
      assert.throws(() => state.load(), { code: 'INVALID_STATE' });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
