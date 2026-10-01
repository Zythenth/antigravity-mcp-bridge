import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state-store.js';

test('model state rejects corrupt records and concurrent writes without overwriting preferences', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-model-state-test-'));
  try {
    const state = new StateStore(directory);
    assert.equal(state.loadModel(), undefined);
    state.saveModel('mock-pro');
    const other = new StateStore(directory);
    const release = state.acquire('model-selection');
    try { assert.throws(() => other.saveModel(null), { code: 'STATE_BUSY' }); }
    finally { release(); }
    assert.equal(other.loadModel()?.model, 'mock-pro');
    other.saveModel(null);
    assert.equal(state.loadModel()?.model, null);
    const file = path.join(directory, 'model-selection.json');
    for (const contents of ['{', JSON.stringify({ version: 1, model: 'model', extra: true }), 'x'.repeat(1025)]) {
      writeFileSync(file, contents);
      assert.throws(() => state.loadModel(), { code: 'INVALID_STATE' });
      assert.throws(() => state.saveModel('mock-pro'), { code: 'INVALID_STATE' });
    }
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
