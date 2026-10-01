import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outputSchemas } from '../src/output-schemas.js';

test('output contracts reject missing fields, wrong types and incomplete ready chunks', () => {
  assert.equal(outputSchemas.antigravity_get_model.safeParse({ model: null }).success, true);
  assert.equal(outputSchemas.antigravity_get_model.safeParse({ model: 123 }).success, false);
  assert.equal(outputSchemas.antigravity_get_model.safeParse({ error: { code: 'MODEL_NOT_AVAILABLE', message: 'Unavailable' } }).success, true);
  assert.equal(outputSchemas.antigravity_status.safeParse({ task: { taskId: 'not-a-uuid', status: 'completed' } }).success, false);
  assert.equal(outputSchemas.antigravity_preview.safeParse({ sha256: 'a'.repeat(64), patch: 'claimed output' }).success, false);
  const taskId = '78a7b84e-1a73-4d97-bd6e-e29e8af61b61';
  assert.equal(outputSchemas.antigravity_read_result.safeParse({ ready: false, taskId, status: 'running' }).success, true);
  assert.equal(outputSchemas.antigravity_read_result.safeParse({ ready: true, taskId, status: 'completed' }).success, false);
});
