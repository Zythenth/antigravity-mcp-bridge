import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outputSchemas, successOutputSchemas } from '../src/output-schemas.js';

test('output contracts reject missing fields, wrong types and incomplete ready chunks', () => {
  assert.equal(outputSchemas.antigravity_get_model.safeParse({ model: null }).success, true);
  assert.equal(outputSchemas.antigravity_get_model.safeParse({ model: 123 }).success, false);
  assert.equal(outputSchemas.antigravity_get_model.safeParse({ error: { code: 'MODEL_NOT_AVAILABLE', message: 'Unavailable' } }).success, true);
  const health = { installed: false, path: 'missing-agy', authenticated: null, error: 'CLI unavailable',
    capabilities: Object.fromEntries(Object.keys(successOutputSchemas.antigravity_health.shape.capabilities.shape).map(key => [key, false])),
    integrationApproval: { available: false, method: 'mcp-form-elicitation' } };
  assert.equal(outputSchemas.antigravity_health.safeParse(health).success, true);
  assert.equal(outputSchemas.antigravity_health.safeParse({ error: { code: 'AGY_NOT_FOUND', message: 'Unavailable' } }).success, true);
  assert.equal(outputSchemas.antigravity_status.safeParse({ task: { taskId: 'not-a-uuid', status: 'completed' } }).success, false);
  assert.equal(outputSchemas.antigravity_preview.safeParse({ sha256: 'a'.repeat(64), patch: 'claimed output' }).success, false);
  const taskId = '78a7b84e-1a73-4d97-bd6e-e29e8af61b61';
  assert.equal(outputSchemas.antigravity_read_result.safeParse({ ready: false, taskId, status: 'running' }).success, true);
  assert.equal(outputSchemas.antigravity_read_result.safeParse({ ready: true, taskId, status: 'completed' }).success, false);
});


test('wait contracts enforce the selected delivery payload without accepting mixed histories', () => {
  const base = { taskId: '78a7b84e-1a73-4d97-bd6e-e29e8af61b61', status: 'completed', ready: true, timedOut: false, nextCursor: 0, oldestAvailable: 1, truncated: false };
  assert.equal(outputSchemas.antigravity_wait.safeParse({ ...base, events: [] }).success, true);
  assert.equal(outputSchemas.antigravity_wait.safeParse({ ...base, deliveryMode: 'messages', messages: [] }).success, true);
  assert.equal(outputSchemas.antigravity_wait.safeParse({ ...base, deliveryMode: 'messages', events: [] }).success, false);
  assert.equal(outputSchemas.antigravity_wait.safeParse({ ...base, deliveryMode: 'events', messages: [] }).success, false);
  assert.equal(outputSchemas.antigravity_wait.safeParse({ ...base, deliveryMode: 'messages', messages: [], events: [] }).success, false);
});
