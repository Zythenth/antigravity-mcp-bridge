import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { BridgeError } from './types.js';

export const structuredResultInputSchema = z.record(z.string(), z.unknown());
export type StructuredResultInput = z.infer<typeof structuredResultInputSchema>;

export interface ValidatedStructuredResult {
  value: unknown;
  sha256: string;
}

const MAX_SCHEMA_BYTES = 64 * 1024; // 64 KiB
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 1000;
const MAX_RESULT_BYTES = 1024 * 1024; // 1 MiB
const MAX_RESULT_DEPTH = 32;
const MAX_RESULT_NODES = 10000;
const MAX_VALIDATOR_CACHE = 100;

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const DRAFT7_SCHEMA_KEYWORDS = new Set([
  '$schema',
  '$ref',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'readOnly',
  'writeOnly',
  'type',
  'enum',
  'const',
  'multipleOf',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'items',
  'additionalItems',
  'maxItems',
  'minItems',
  'uniqueItems',
  'contains',
  'maxProperties',
  'minProperties',
  'required',
  'properties',
  'additionalProperties',
  'definitions',
  '$defs',
  'dependencies',
  'propertyNames',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'format',
  'contentMediaType',
  'contentEncoding',
  'if',
  'then',
  'else',
]);

const validatorCache = new Map<string, (value: unknown) => { valid: boolean; data?: unknown; errorMessage?: string }>();
let draft7MetaschemaValidator: ((value: unknown) => { valid: boolean; data?: unknown; errorMessage?: string }) | undefined;

function getDraft7MetaschemaValidator() {
  if (!draft7MetaschemaValidator) {
    const ajv = new AjvJsonSchemaValidator();
    draft7MetaschemaValidator = ajv.getValidator({
      $ref: 'http://json-schema.org/draft-07/schema#',
    } as JsonSchemaType);
  }
  return draft7MetaschemaValidator;
}

type SchemaContext = 'schema' | 'properties-map' | 'definitions-map' | 'dependencies-map' | 'data';

function traverseSchema(
  node: unknown,
  depth: number,
  context: SchemaContext,
  state: { nodeCount: number; activeStack: Set<unknown> }
): void {
  state.nodeCount++;
  if (state.nodeCount > MAX_SCHEMA_NODES) {
    throw new BridgeError('INVALID_OUTPUT_SCHEMA', `Schema node count exceeds limit of ${MAX_SCHEMA_NODES} nodes`);
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new BridgeError('INVALID_OUTPUT_SCHEMA', `Schema depth exceeds limit of ${MAX_SCHEMA_DEPTH}`);
  }

  if (typeof node !== 'object' || node === null) {
    return;
  }

  if (state.activeStack.has(node)) {
    throw new BridgeError('INVALID_OUTPUT_SCHEMA', 'Schema contains circular references');
  }
  state.activeStack.add(node);

  try {
    if (Array.isArray(node)) {
      const childContext = context === 'data' ? 'data' : 'schema';
      for (const item of node) {
        traverseSchema(item, depth + 1, childContext, state);
      }
      return;
    }

    const obj = node as Record<string, unknown>;

    for (const key of Object.getOwnPropertyNames(obj)) {
      if (UNSAFE_KEYS.has(key)) {
        throw new BridgeError('INVALID_OUTPUT_SCHEMA', `Schema contains forbidden unsafe key: ${key}`);
      }
    }
    for (const key of Object.keys(obj)) {
      if (UNSAFE_KEYS.has(key)) {
        throw new BridgeError('INVALID_OUTPUT_SCHEMA', `Schema contains forbidden unsafe key: ${key}`);
      }
    }

    if (context === 'schema') {
      if (Object.prototype.hasOwnProperty.call(obj, '$id') || Object.prototype.hasOwnProperty.call(obj, 'id')) {
        const idKey = Object.prototype.hasOwnProperty.call(obj, '$id') ? '$id' : 'id';
        throw new BridgeError('INVALID_OUTPUT_SCHEMA', `Schema keyword '${idKey}' is forbidden`);
      }

      if ('pattern' in obj || 'patternProperties' in obj) {
        throw new BridgeError('INVALID_OUTPUT_SCHEMA', 'pattern and patternProperties are unsupported to prevent regex denial of service');
      }

      for (const key of Object.keys(obj)) {
        if (!DRAFT7_SCHEMA_KEYWORDS.has(key)) {
          throw new BridgeError('INVALID_OUTPUT_SCHEMA', `Unsupported schema keyword: ${key}`);
        }
      }

      if ('$ref' in obj) {
        const refVal = obj['$ref'];
        if (typeof refVal !== 'string') {
          throw new BridgeError('INVALID_OUTPUT_SCHEMA', '$ref must be a string');
        }
        if (!refVal.startsWith('#')) {
          throw new BridgeError('INVALID_OUTPUT_SCHEMA', `External $ref is forbidden: ${refVal}`);
        }
        if (refVal.includes('://')) {
          throw new BridgeError('INVALID_OUTPUT_SCHEMA', `Network $ref is forbidden: ${refVal}`);
        }
        if (refVal === '#') {
          throw new BridgeError('INVALID_OUTPUT_SCHEMA', 'Direct recursive self-reference $ref: "#" is forbidden');
        }
      }

      for (const [key, val] of Object.entries(obj)) {
        if (key === 'properties') {
          traverseSchema(val, depth + 1, 'properties-map', state);
        } else if (key === 'definitions' || key === '$defs') {
          traverseSchema(val, depth + 1, 'definitions-map', state);
        } else if (key === 'dependencies') {
          traverseSchema(val, depth + 1, 'dependencies-map', state);
        } else if (
          key === 'items' ||
          key === 'additionalProperties' ||
          key === 'additionalItems' ||
          key === 'allOf' ||
          key === 'anyOf' ||
          key === 'oneOf' ||
          key === 'not' ||
          key === 'if' ||
          key === 'then' ||
          key === 'else' ||
          key === 'contains' ||
          key === 'propertyNames'
        ) {
          traverseSchema(val, depth + 1, 'schema', state);
        } else {
          traverseSchema(val, depth + 1, 'data', state);
        }
      }
    } else if (context === 'properties-map' || context === 'definitions-map') {
      for (const val of Object.values(obj)) {
        traverseSchema(val, depth + 1, 'schema', state);
      }
    } else if (context === 'dependencies-map') {
      for (const val of Object.values(obj)) {
        if (Array.isArray(val)) {
          traverseSchema(val, depth + 1, 'data', state);
        } else {
          traverseSchema(val, depth + 1, 'schema', state);
        }
      }
    } else {
      for (const val of Object.values(obj)) {
        traverseSchema(val, depth + 1, 'data', state);
      }
    }
  } finally {
    state.activeStack.delete(node);
  }
}

export function validateOutputSchema(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BridgeError('INVALID_OUTPUT_SCHEMA', 'Output schema must be a non-null JSON object');
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch (err) {
    throw new BridgeError('INVALID_OUTPUT_SCHEMA', 'Output schema must be serializable to JSON: ' + (err instanceof Error ? err.message : String(err)));
  }
  if (serialized === undefined) {
    throw new BridgeError('INVALID_OUTPUT_SCHEMA', 'Output schema cannot be undefined');
  }

  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > MAX_SCHEMA_BYTES) {
    throw new BridgeError('INVALID_OUTPUT_SCHEMA', `Schema size (${byteLength} bytes) exceeds limit of ${MAX_SCHEMA_BYTES} bytes (64 KiB)`);
  }

  const state = { nodeCount: 0, activeStack: new Set<unknown>() };
  traverseSchema(input, 1, 'schema', state);

  const metaValidator = getDraft7MetaschemaValidator();
  const metaOutcome = metaValidator(input);
  if (!metaOutcome.valid) {
    throw new BridgeError('INVALID_OUTPUT_SCHEMA', metaOutcome.errorMessage || 'Schema does not conform to JSON Schema Draft-07');
  }

  try {
    const validator = new AjvJsonSchemaValidator();
    validator.getValidator(input as JsonSchemaType);
  } catch (err) {
    throw new BridgeError('INVALID_OUTPUT_SCHEMA', 'Failed to compile JSON schema offline: ' + (err instanceof Error ? err.message : String(err)));
  }

  return JSON.parse(serialized) as Record<string, unknown>;
}

function inspectJsonResult(
  val: unknown,
  depth: number,
  state: { nodeCount: number; activeStack: Set<unknown> }
): void {
  state.nodeCount++;
  if (state.nodeCount > MAX_RESULT_NODES) {
    throw new BridgeError('INVALID_STRUCTURED_RESULT', `Result node count exceeds limit of ${MAX_RESULT_NODES} nodes`);
  }
  if (depth > MAX_RESULT_DEPTH) {
    throw new BridgeError('INVALID_STRUCTURED_RESULT', `Result tree depth exceeds limit of ${MAX_RESULT_DEPTH}`);
  }

  if (val === null) {
    return;
  }

  if (val === undefined) {
    throw new BridgeError('INVALID_STRUCTURED_RESULT', 'undefined is not valid JSON');
  }

  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new BridgeError('INVALID_STRUCTURED_RESULT', 'NaN and Infinity are not valid JSON numbers');
    }
    return;
  }

  if (typeof val === 'string' || typeof val === 'boolean') {
    return;
  }

  if (typeof val === 'bigint' || typeof val === 'symbol' || typeof val === 'function') {
    throw new BridgeError('INVALID_STRUCTURED_RESULT', `${typeof val} is not valid JSON`);
  }

  if (typeof val !== 'object') {
    throw new BridgeError('INVALID_STRUCTURED_RESULT', 'Invalid JSON value');
  }

  if (state.activeStack.has(val)) {
    throw new BridgeError('INVALID_STRUCTURED_RESULT', 'Result contains circular references');
  }
  state.activeStack.add(val);

  try {
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        if (!(i in val) || val[i] === undefined) {
          throw new BridgeError('INVALID_STRUCTURED_RESULT', 'Sparse arrays or undefined elements are not valid JSON');
        }
        inspectJsonResult(val[i], depth + 1, state);
      }
      return;
    }

    const proto = Object.getPrototypeOf(val);
    if (proto !== Object.prototype && proto !== null) {
      throw new BridgeError('INVALID_STRUCTURED_RESULT', 'Result must contain only plain JSON objects');
    }

    const obj = val as Record<string, unknown>;

    for (const key of Object.getOwnPropertyNames(obj)) {
      if (UNSAFE_KEYS.has(key)) {
        throw new BridgeError('INVALID_STRUCTURED_RESULT', `Result contains forbidden unsafe key: ${key}`);
      }
      const child = obj[key];
      if (child === undefined) {
        throw new BridgeError('INVALID_STRUCTURED_RESULT', `Result property '${key}' has undefined value`);
      }
      inspectJsonResult(child, depth + 1, state);
    }
  } finally {
    state.activeStack.delete(val);
  }
}

export function validateStructuredResult(
  schema: Record<string, unknown>,
  value: unknown
): ValidatedStructuredResult {
  if (value === undefined) {
    throw new BridgeError('INVALID_STRUCTURED_RESULT', 'Structured result value is required and cannot be undefined');
  }

  inspectJsonResult(value, 1, { nodeCount: 0, activeStack: new Set<unknown>() });

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    throw new BridgeError('INVALID_STRUCTURED_RESULT', 'Structured result must be serializable JSON: ' + (err instanceof Error ? err.message : String(err)));
  }
  if (serialized === undefined) {
    throw new BridgeError('INVALID_STRUCTURED_RESULT', 'Structured result cannot be undefined or unserializable');
  }

  const resultBytes = Buffer.byteLength(serialized, 'utf8');
  if (resultBytes > MAX_RESULT_BYTES) {
    throw new BridgeError('INVALID_STRUCTURED_RESULT', `Structured result size (${resultBytes} bytes) exceeds limit of ${MAX_RESULT_BYTES} bytes (1 MiB)`);
  }

  validateOutputSchema(schema);

  const snapshot = JSON.parse(serialized);

  const schemaHash = createHash('sha256').update(Buffer.from(JSON.stringify(schema), 'utf8')).digest('hex');
  let validatorFn = validatorCache.get(schemaHash);
  if (!validatorFn) {
    try {
      const validator = new AjvJsonSchemaValidator();
      validatorFn = validator.getValidator(schema as JsonSchemaType);
      if (validatorCache.size >= MAX_VALIDATOR_CACHE) {
        const oldestKey = validatorCache.keys().next().value;
        if (oldestKey !== undefined) {
          validatorCache.delete(oldestKey);
        }
      }
      validatorCache.set(schemaHash, validatorFn);
    } catch (err) {
      throw new BridgeError('INVALID_OUTPUT_SCHEMA', 'Failed to compile schema: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  try {
    const outcome = validatorFn(snapshot);
    if (!outcome.valid) {
      throw new BridgeError('INVALID_STRUCTURED_RESULT', outcome.errorMessage || 'Structured result does not match schema');
    }
  } catch (err) {
    if (err instanceof BridgeError) throw err;
    throw new BridgeError('INVALID_STRUCTURED_RESULT', 'Structured result validation failed: ' + (err instanceof Error ? err.message : String(err)));
  }

  const sha256 = createHash('sha256').update(Buffer.from(serialized, 'utf8')).digest('hex');

  return { value: snapshot, sha256 };
}
