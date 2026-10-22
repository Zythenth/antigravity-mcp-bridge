import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizePayload } from '../src/payload-safety.js';

const credential = 'gh' + 'p_' + 'C'.repeat(36);

test('payload sanitizer redacts strings and keys in a fresh copy', () => {
  const input = JSON.parse(`{"id":"4f0c2a51-8f0e-4f7a-9d55-2f4b8f1d3c10","sha256":"${'a'.repeat(64)}","items":[1,true,null,"token ${credential}"],"${credential}":"key","__proto__":{"polluted":true}}`);
  const result = sanitizePayload(input);
  const value = result.value as Record<string, unknown>;
  assert.equal(result.redacted, true);
  assert.equal(result.truncated, false);
  assert.equal(JSON.stringify(value).includes(credential), false);
  assert.equal(value.id, input.id);
  assert.equal(value.sha256, input.sha256);
  assert.deepEqual(value.items, [1, true, null, 'token [redacted]']);
  assert.equal(value['[redacted]'], 'key');
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(value, '__proto__')?.value, { polluted: true });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.notEqual(value.items, input.items);
  assert.equal(input.items[3], 'token ' + credential);
});

test('payload sanitizer preserves clean payloads without flags', () => {
  const input = { response: 'done', nested: { list: [{ step: 1 }, 'text'] }, count: 3 };
  const result = sanitizePayload(input);
  assert.deepEqual(result, { value: input, redacted: false, truncated: false });
  assert.notEqual(result.value, input);
});

test('payload sanitizer bounds very deep payloads before stringify or clone', () => {
  const depth = 1_000_000;
  const deep = JSON.parse('['.repeat(depth) + ']'.repeat(depth));
  const result = sanitizePayload(deep, { maxDepth: 3 });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.value, [[[['[depth limit exceeded]']]]]);
  assert.doesNotThrow(() => structuredClone(result.value));
  assert.equal(sanitizePayload([[1]], { maxDepth: 1 }).truncated, false);
});

test('payload sanitizer bounds node count and follows JSON semantics', () => {
  const wide = { a: [1, 2], b: [3], c: [4] };
  const limited = sanitizePayload(wide, { maxNodes: 2 });
  assert.equal(limited.truncated, true);
  assert.equal(JSON.stringify(limited.value).includes('[node limit exceeded]'), true);
  assert.deepEqual(sanitizePayload({ keep: 1, skip: undefined, list: [undefined, Number.NaN] }).value, { keep: 1, list: [null, null] });
  assert.deepEqual(sanitizePayload(['x', 'x', 'x', 'x', 'x'], { maxNodes: 3 }), { value: ['x', 'x', '[node limit exceeded]'], redacted: false, truncated: true });
  assert.throws(() => sanitizePayload({}, { maxDepth: 0 }), RangeError);
  assert.throws(() => sanitizePayload({}, { maxNodes: 1.5 }), RangeError);
});
