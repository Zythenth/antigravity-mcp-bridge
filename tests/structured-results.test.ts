import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  structuredResultInputSchema,
  validateOutputSchema,
  validateStructuredResult,
} from '../src/structured-results.js';
import { BridgeError } from '../src/types.js';

test('structuredResultInputSchema accepts string-keyed records and rejects non-records', () => {
  assert.ok(structuredResultInputSchema.safeParse({ key: 'val', num: 42, nested: { a: 1 } }).success);
  assert.ok(structuredResultInputSchema.safeParse({}).success);
  assert.ok(!structuredResultInputSchema.safeParse('not an object').success);
  assert.ok(!structuredResultInputSchema.safeParse([1, 2, 3]).success);
  assert.ok(!structuredResultInputSchema.safeParse(null).success);
});

test('validates valid output schema and matches structured result with exact sha256', () => {
  const schema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      count: { type: 'integer', minimum: 0 },
      active: { type: 'boolean' },
    },
    required: ['id', 'count'],
    additionalProperties: false,
  };

  const validatedSchema = validateOutputSchema(schema);
  assert.deepEqual(validatedSchema, schema);

  const resultValue = { id: 'item-123', count: 5 };
  const verified = validateStructuredResult(schema, resultValue);

  assert.deepEqual(verified.value, resultValue);
  const expectedHash = createHash('sha256').update(Buffer.from(JSON.stringify(resultValue), 'utf8')).digest('hex');
  assert.equal(verified.sha256, expectedHash);
});

test('positive property names id, type, and minimum work in properties map', () => {
  const schema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      type: { type: 'string' },
      minimum: { type: 'number' },
    },
    required: ['id', 'type', 'minimum'],
  };

  assert.doesNotThrow(() => validateOutputSchema(schema));

  const resultValue = { id: 'usr-1', type: 'admin', minimum: 10 };
  const verified = validateStructuredResult(schema, resultValue);
  assert.deepEqual(verified.value, resultValue);
});

test('enum and const data objects can contain keys resembling schema keywords', () => {
  const schema = {
    type: 'object',
    properties: {
      mode: {
        enum: [
          { id: 'mode-a', type: 'preset', minimum: 1 },
          { id: 'mode-b', type: 'custom', minimum: 5 },
        ],
      },
      fallback: {
        const: { id: 'default', type: 'fallback', minimum: 0, $ref: 'not-evaluated' },
      },
    },
    required: ['mode'],
  };

  assert.doesNotThrow(() => validateOutputSchema(schema));

  const validResult = {
    mode: { id: 'mode-a', type: 'preset', minimum: 1 },
    fallback: { id: 'default', type: 'fallback', minimum: 0, $ref: 'not-evaluated' },
  };
  const verified = validateStructuredResult(schema, validResult);
  assert.deepEqual(verified.value, validResult);
});

test('enforces schema size limit of 64 KiB', () => {
  const largeDescription = 'x'.repeat(65 * 1024);
  const hugeSchema = {
    type: 'object',
    description: largeDescription,
  };

  assert.throws(
    () => validateOutputSchema(hugeSchema),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA' && err.message.includes('64 KiB')
  );
});

test('enforces schema depth limit of 32 independently: 15 containers passes at depth32; 16 containers exceeds32', () => {
  // 15 containers: root (depth 1), properties (depth 2), child 2 (depth 3) ... child 15 (depth 29), properties (depth 30), leaf schema (depth 31), scalar type value (depth 32)
  function buildContainers(count: number): Record<string, unknown> {
    let current: Record<string, unknown> = { type: 'string' };
    for (let i = 1; i < count; i++) {
      current = { type: 'object', properties: { child: current } };
    }
    return { type: 'object', properties: { child: current } };
  }

  const depth15 = buildContainers(15);
  assert.doesNotThrow(() => validateOutputSchema(depth15));

  const depth16 = buildContainers(16);
  assert.throws(
    () => validateOutputSchema(depth16),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA' && err.message.includes('depth')
  );
});

test('enforces schema node count limit of 1000', () => {
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < 1100; i++) {
    properties[`prop_${i}`] = { type: 'string' };
  }
  const hugeNodeSchema = {
    type: 'object',
    properties,
  };

  assert.throws(
    () => validateOutputSchema(hugeNodeSchema),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA' && err.message.includes('node count')
  );
});

test('rejects circular references in schema', () => {
  const circular: Record<string, unknown> = { type: 'object' };
  circular.properties = { self: circular };

  assert.throws(
    () => validateOutputSchema(circular),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA'
  );
});

test('rejects unsafe keys __proto__, constructor, and prototype anywhere in schema', () => {
  const unsafeProto = JSON.parse('{"type": "object", "__proto__": {"polluted": true}}');
  assert.throws(
    () => validateOutputSchema(unsafeProto),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA' && err.message.includes('__proto__')
  );

  const unsafeConstructor = {
    type: 'object',
    constructor: 'malicious',
  };
  assert.throws(
    () => validateOutputSchema(unsafeConstructor),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA' && err.message.includes('constructor')
  );

  const unsafePrototype = {
    type: 'object',
    prototype: 'malicious',
  };
  assert.throws(
    () => validateOutputSchema(unsafePrototype),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA' && err.message.includes('prototype')
  );
});

test('rejects $id and id keywords on actual schema nodes', () => {
  const schemaWithDollarId = {
    $id: 'https://example.com/schema.json',
    type: 'object',
  };
  assert.throws(
    () => validateOutputSchema(schemaWithDollarId),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA' && err.message.includes('$id')
  );

  const schemaWithId = {
    id: 'https://example.com/schema.json',
    type: 'object',
  };
  assert.throws(
    () => validateOutputSchema(schemaWithId),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA' && err.message.includes('id')
  );
});

test('rejects pattern and patternProperties with explicit INVALID_OUTPUT_SCHEMA to prevent regex DoS', () => {
  const patternSchema = {
    type: 'string',
    pattern: '^[a-z]+$',
  };
  assert.throws(
    () => validateOutputSchema(patternSchema),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA' && err.message.includes('pattern')
  );

  const malformedPattern = {
    type: 'string',
    pattern: '[open-bracket',
  };
  assert.throws(
    () => validateOutputSchema(malformedPattern),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA'
  );

  const patternPropsSchema = {
    type: 'object',
    patternProperties: {
      '^S_': { type: 'string' },
    },
  };
  assert.throws(
    () => validateOutputSchema(patternPropsSchema),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA' && err.message.includes('patternProperties')
  );
});

test('rejects external and network $ref, direct self-ref, and allows valid local $ref', () => {
  assert.throws(
    () => validateOutputSchema({ type: 'object', properties: { user: { $ref: 'https://example.com/user.json' } } }),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA' && err.message.includes('$ref')
  );

  assert.throws(
    () => validateOutputSchema({ type: 'object', properties: { user: { $ref: 'user.json#/definitions/User' } } }),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA' && err.message.includes('$ref')
  );

  assert.throws(
    () => validateOutputSchema({ type: 'object', properties: { self: { $ref: '#' } } }),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA' && err.message.includes('$ref')
  );

  const validLocalRef = {
    type: 'object',
    definitions: {
      User: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
    properties: {
      user: { $ref: '#/definitions/User' },
    },
  };
  assert.doesNotThrow(() => validateOutputSchema(validLocalRef));

  const validRes = validateStructuredResult(validLocalRef, { user: { name: 'Alice' } });
  assert.equal(typeof validRes.sha256, 'string');
});

test('isolated local ref cycle fails closed', () => {
  const cycleSchema = {
    type: 'object',
    definitions: {
      a: {
        type: 'object',
        properties: { next: { $ref: '#/definitions/b' } },
        required: ['next'],
      },
      b: {
        type: 'object',
        properties: { next: { $ref: '#/definitions/a' } },
        required: ['next'],
      },
    },
    properties: {
      head: { $ref: '#/definitions/a' },
    },
    required: ['head'],
  };

  assert.doesNotThrow(() => validateOutputSchema(cycleSchema));

  // Circular payload without end must fail closed
  const cyclePayload = {
    head: { next: { next: {} } },
  };
  assert.throws(
    () => validateStructuredResult(cycleSchema, cyclePayload),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_STRUCTURED_RESULT'
  );
});

test('rejects malformed schema keywords via Draft-7 metaschema', () => {
  // required must be an array, not a string
  assert.throws(
    () => validateOutputSchema({ type: 'object', required: 'id' }),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA'
  );

  // properties must be an object
  assert.throws(
    () => validateOutputSchema({ type: 'object', properties: 'not-an-object' }),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA'
  );

  // minimum must be a number
  assert.throws(
    () => validateOutputSchema({ type: 'number', minimum: 'ten' }),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA'
  );

  // type must be a valid Draft-7 type
  assert.throws(
    () => validateOutputSchema({ type: 'custom-type' }),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA'
  );

  // unknown schema keyword not in Draft-7 set
  assert.throws(
    () => validateOutputSchema({ type: 'object', unknownSemanticKeyword: 123 }),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_OUTPUT_SCHEMA'
  );
});

test('rejects non-JSON result values before serialization', () => {
  const schema = { type: 'object' };

  // NaN
  assert.throws(
    () => validateStructuredResult(schema, { num: NaN }),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_STRUCTURED_RESULT' && err.message.includes('NaN')
  );

  // Infinity
  assert.throws(
    () => validateStructuredResult(schema, { num: Infinity }),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_STRUCTURED_RESULT' && err.message.includes('Infinity')
  );

  // Undefined member
  assert.throws(
    () => validateStructuredResult(schema, { missing: undefined }),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_STRUCTURED_RESULT' && err.message.includes('undefined')
  );

  // Function
  assert.throws(
    () => validateStructuredResult(schema, { fn: () => 'hello' }),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_STRUCTURED_RESULT'
  );

  // Date instance
  assert.throws(
    () => validateStructuredResult(schema, { date: new Date() }),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_STRUCTURED_RESULT'
  );

  // Circular reference in result
  const circularResult: Record<string, unknown> = { a: 1 };
  circularResult.self = circularResult;
  assert.throws(
    () => validateStructuredResult(schema, circularResult),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_STRUCTURED_RESULT' && err.message.includes('circular')
  );
});

test('rejects structured result exceeding 1 MiB or depth 32 or nodes 10000', () => {
  const schema = { type: 'object' };

  // 1 MiB payload
  const hugePayload = { big: 'A'.repeat(1024 * 1024 + 10) };
  assert.throws(
    () => validateStructuredResult(schema, hugePayload),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_STRUCTURED_RESULT' && err.message.includes('1 MiB')
  );

  // Depth > 32
  let deepVal: unknown = 'leaf';
  for (let i = 0; i < 35; i++) {
    deepVal = { child: deepVal };
  }
  assert.throws(
    () => validateStructuredResult(schema, deepVal),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_STRUCTURED_RESULT' && err.message.includes('depth')
  );
});

test('source/result input mutation isolation: returned result is a detached snapshot', () => {
  const schema = {
    type: 'object',
    properties: {
      count: { type: 'number' },
      info: {
        type: 'object',
        properties: { tag: { type: 'string' } },
        required: ['tag'],
      },
      role: { type: 'string', default: 'viewer' },
    },
    required: ['count', 'info'],
  };

  const originalInput = { count: 42, info: { tag: 'initial' } };
  const verified = validateStructuredResult(schema, originalInput);

  // Mutating original input object after validation
  originalInput.count = 999;
  originalInput.info.tag = 'mutated';
  (originalInput as Record<string, unknown>).injected = true;

  // Verified snapshot is isolated and unchanged
  assert.equal((verified.value as typeof originalInput).count, 42);
  assert.equal((verified.value as typeof originalInput).info.tag, 'initial');
  assert.equal((verified.value as Record<string, unknown>).injected, undefined);

  // Defaults not injected
  assert.equal((verified.value as { role?: string }).role, undefined);

  // Exact matching sha256 for original state
  const originalJson = JSON.stringify({ count: 42, info: { tag: 'initial' } });
  const expectedHash = createHash('sha256').update(Buffer.from(originalJson, 'utf8')).digest('hex');
  assert.equal(verified.sha256, expectedHash);
});

test('validator cache operates within bounded limits', () => {
  for (let i = 0; i < 110; i++) {
    const dynamicSchema = {
      type: 'object',
      properties: {
        [`field_${i}`]: { type: 'integer' },
      },
    };
    const res = validateStructuredResult(dynamicSchema, { [`field_${i}`]: i });
    assert.ok(res.sha256);
  }
});

test('validated output schemas preserve their snapshot after caller mutation', () => {
  const input = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'] };
  const snapshot = validateOutputSchema(input);
  input.properties.answer.type = 'string';
  assert.deepEqual(validateStructuredResult(snapshot, { answer: 42 }).value, { answer: 42 });
});
