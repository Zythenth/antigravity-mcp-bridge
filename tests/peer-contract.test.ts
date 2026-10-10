import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  groupDefinitionSchema,
  groupDefinitionSha256,
  groupRecordSchema,
  peerDeliverySchema,
  peerReceiptSchema,
  peerReceiptsPageSchema,
  summarizeGroup,
} from '../src/group-contract.js';

describe('peer contracts and receipt validation', () => {
  it('preserves legacy definition JSON and hash when peerRoutes is absent', () => {
    const legacyDef = {
      workingDirectory: '/test/workspace',
      title: 'Legacy Group',
      jobs: [
        {
          key: 'job-a',
          owner: 'coder',
          dependsOn: [],
          task: { prompt: 'Task A' },
        },
        {
          key: 'job-b',
          owner: 'reviewer',
          dependsOn: ['job-a'],
          task: { prompt: 'Task B' },
        },
      ],
    };

    const parsed = groupDefinitionSchema.parse(legacyDef);
    assert.equal(parsed.peerRoutes, undefined);
    assert.equal('peerRoutes' in parsed, false);

    const serialized = JSON.stringify(parsed);
    assert.equal(serialized.includes('peerRoutes'), false);
    assert.equal(serialized, JSON.stringify(legacyDef));

    const hash = groupDefinitionSha256(legacyDef);
    const expectedHash = createHash('sha256').update(JSON.stringify(legacyDef)).digest('hex');
    assert.equal(hash, expectedHash);

    const legacyRecord = {
      version: 1 as const,
      groupId: '11111111-1111-4111-8111-111111111111',
      definitionSha256: hash,
      definition: legacyDef,
      profiles: {},
      nodes: {
        'job-a': { state: 'completed' as const },
        'job-b': { state: 'pending' as const },
      },
      state: 'running' as const,
      createdAt: '2026-10-10T00:00:00.000Z',
      updatedAt: '2026-10-10T00:00:00.000Z',
    };
    const parsedRecord = groupRecordSchema.parse(legacyRecord);
    assert.equal(parsedRecord.peerDeliveries, undefined);
    assert.equal('peerDeliveries' in parsedRecord, false);
  });

  it('accepts valid directed route array in groupDefinitionSchema', () => {
    const def = {
      workingDirectory: '/test/workspace',
      title: 'Group With Routes',
      jobs: [
        {
          key: 'planner',
          owner: 'coder',
          dependsOn: [],
          task: { prompt: 'Plan project' },
        },
        {
          key: 'worker',
          owner: 'coder',
          dependsOn: ['planner'],
          task: { prompt: 'Implement plan' },
        },
      ],
      peerRoutes: [
        { from: 'planner', to: 'worker' },
      ],
    };

    const parsed = groupDefinitionSchema.parse(def);
    assert.deepEqual(parsed.peerRoutes, [{ from: 'planner', to: 'worker' }]);
  });

  it('rejects invalid endpoint, duplicate edge, self edge, and object-mapping routes', () => {
    const baseJobs = [
      { key: 'node-a', owner: 'coder', dependsOn: [], task: { prompt: 'Task A' } },
      { key: 'node-b', owner: 'coder', dependsOn: ['node-a'], task: { prompt: 'Task B' } },
    ];
    const baseDef = {
      workingDirectory: '/test/workspace',
      title: 'Route Validation Tests',
      jobs: baseJobs,
    };

    // Unknown endpoint
    assert.throws(() => {
      groupDefinitionSchema.parse({
        ...baseDef,
        peerRoutes: [{ from: 'node-a', to: 'unknown-node' }],
      });
    });

    // Duplicate edge
    assert.throws(() => {
      groupDefinitionSchema.parse({
        ...baseDef,
        peerRoutes: [
          { from: 'node-a', to: 'node-b' },
          { from: 'node-a', to: 'node-b' },
        ],
      });
    });

    // Self edge
    assert.throws(() => {
      groupDefinitionSchema.parse({
        ...baseDef,
        peerRoutes: [{ from: 'node-a', to: 'node-a' }],
      });
    });

    // Object mapping instead of array
    assert.throws(() => {
      groupDefinitionSchema.parse({
        ...baseDef,
        peerRoutes: { 'node-a': 'node-b' },
      });
    });
  });

  it('verifies sha256 matches SHA-256 of UTF-8 text in peerDeliverySchema', () => {
    const text = 'Hello peer agent!';
    const expectedSha256 = createHash('sha256').update(text, 'utf8').digest('hex');

    const validDelivery = {
      sourceTaskId: '11111111-1111-4111-8111-111111111111',
      sourceNode: 'node-a',
      messageId: '22222222-2222-4222-8222-222222222222',
      toNode: 'node-b',
      text,
      sha256: expectedSha256,
      transportId: '33333333-3333-4333-8333-333333333333',
      state: 'pending' as const,
    };

    const parsed = peerDeliverySchema.parse(validDelivery);
    assert.equal(parsed.sha256, expectedSha256);

    // Mismatched sha256
    const wrongSha256 = createHash('sha256').update('different text', 'utf8').digest('hex');
    assert.throws(() => {
      peerDeliverySchema.parse({
        ...validDelivery,
        sha256: wrongSha256,
      });
    });

    // Non-lowercase / malformed sha256
    assert.throws(() => {
      peerDeliverySchema.parse({
        ...validDelivery,
        sha256: expectedSha256.toUpperCase(),
      });
    });
    assert.throws(() => {
      peerDeliverySchema.parse({
        ...validDelivery,
        sha256: 'short-digest',
      });
    });
  });

  it('enforces queued and sent state requirements on targetTaskId and continuationTaskId', () => {
    const text = 'state requirement test';
    const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    const base = {
      sourceTaskId: '11111111-1111-4111-8111-111111111111',
      sourceNode: 'node-a',
      messageId: '22222222-2222-4222-8222-222222222222',
      toNode: 'node-b',
      text,
      sha256,
      transportId: '33333333-3333-4333-8333-333333333333',
    };

    // pending: requires neither targetTaskId nor continuationTaskId
    assert.doesNotThrow(() => {
      peerDeliverySchema.parse({ ...base, state: 'pending' });
    });

    // queued: requires targetTaskId
    assert.throws(() => {
      peerDeliverySchema.parse({ ...base, state: 'queued' });
    });
    assert.doesNotThrow(() => {
      peerDeliverySchema.parse({
        ...base,
        state: 'queued',
        targetTaskId: '44444444-4444-4444-8444-444444444444',
      });
    });

    // sent: requires targetTaskId AND continuationTaskId
    assert.throws(() => {
      peerDeliverySchema.parse({ ...base, state: 'sent' });
    });
    assert.throws(() => {
      peerDeliverySchema.parse({
        ...base,
        state: 'sent',
        targetTaskId: '44444444-4444-4444-8444-444444444444',
      });
    });
    assert.throws(() => {
      peerDeliverySchema.parse({
        ...base,
        state: 'sent',
        continuationTaskId: '55555555-5555-4555-8555-555555555555',
      });
    });
    assert.doesNotThrow(() => {
      peerDeliverySchema.parse({
        ...base,
        state: 'sent',
        targetTaskId: '44444444-4444-4444-8444-444444444444',
        continuationTaskId: '55555555-5555-4555-8555-555555555555',
      });
    });

    // failed with error object
    assert.doesNotThrow(() => {
      peerDeliverySchema.parse({
        ...base,
        state: 'failed',
        error: { code: 'TIMEOUT', message: 'Delivery timed out' },
      });
    });
  });

  it('strictly rejects text and transportId in peerReceiptSchema', () => {
    const validReceipt = {
      messageId: '22222222-2222-4222-8222-222222222222',
      sourceTaskId: '11111111-1111-4111-8111-111111111111',
      fromNode: 'node-a',
      toNode: 'node-b',
      state: 'sent' as const,
      sha256: createHash('sha256').update('hello', 'utf8').digest('hex'),
      continuationTaskId: '55555555-5555-4555-8555-555555555555',
      source: 'agy-reported' as const,
    };

    const parsed = peerReceiptSchema.parse(validReceipt);
    assert.equal(parsed.source, 'agy-reported');
    assert.equal('text' in parsed, false);
    assert.equal('transportId' in parsed, false);

    // Rejects extra text field
    assert.throws(() => {
      peerReceiptSchema.parse({ ...validReceipt, text: 'unwanted text' });
    });

    // Rejects extra transportId field
    assert.throws(() => {
      peerReceiptSchema.parse({
        ...validReceipt,
        transportId: '33333333-3333-4333-8333-333333333333',
      });
    });

    // Rejects invalid source literal
    assert.throws(() => {
      peerReceiptSchema.parse({ ...validReceipt, source: 'unauthorized-source' });
    });
  });

  it('enforces cap of 20 receipts and safe nonnegative integer cursor in peerReceiptsPageSchema', () => {
    const makeReceipt = (idx: number) => ({
      messageId: `00000000-0000-4000-8000-${String(idx).padStart(12, '0')}`,
      sourceTaskId: '11111111-1111-4111-8111-111111111111',
      fromNode: 'node-a',
      toNode: 'node-b',
      state: 'pending' as const,
      sha256: createHash('sha256').update(`item-${idx}`, 'utf8').digest('hex'),
      source: 'agy-reported' as const,
    });

    const page20 = {
      receipts: Array.from({ length: 20 }, (_, i) => makeReceipt(i)),
      nextCursor: 20,
      hasMore: true,
    };
    assert.doesNotThrow(() => peerReceiptsPageSchema.parse(page20));

    // 21 receipts exceeds max 20
    const page21 = {
      receipts: Array.from({ length: 21 }, (_, i) => makeReceipt(i)),
      nextCursor: 21,
      hasMore: true,
    };
    assert.throws(() => peerReceiptsPageSchema.parse(page21));

    // Cursor validation: safe nonnegative integer required
    assert.doesNotThrow(() => peerReceiptsPageSchema.parse({ ...page20, nextCursor: 0 }));
    assert.throws(() => peerReceiptsPageSchema.parse({ ...page20, nextCursor: -1 }));
    assert.throws(() => peerReceiptsPageSchema.parse({ ...page20, nextCursor: 3.14 }));
    assert.throws(() => peerReceiptsPageSchema.parse({ ...page20, nextCursor: Number.MAX_SAFE_INTEGER + 1 }));
    assert.throws(() => peerReceiptsPageSchema.parse({ ...page20, nextCursor: '20' }));
  });

  it('enforces 100-delivery cap, rejects duplicate casefolded IDs, and excludes ledger from summarizeGroup', () => {
    const baseDef = {
      workingDirectory: '/test/workspace',
      title: 'Ledger Test Group',
      jobs: [
        { key: 'node-a', owner: 'coder', dependsOn: [], task: { prompt: 'Task A' } },
        { key: 'node-b', owner: 'coder', dependsOn: ['node-a'], task: { prompt: 'Task B' } },
      ],
    };

    const makeDelivery = (idx: number, overrides = {}) => {
      const text = `payload-${idx}`;
      return {
        sourceTaskId: '11111111-1111-4111-8111-111111111111',
        sourceNode: 'node-a',
        messageId: `00000000-0000-4000-8000-${String(idx).padStart(12, '0')}`,
        toNode: 'node-b',
        text,
        sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
        transportId: `ffffffff-ffff-4fff-8fff-${String(idx).padStart(12, '0')}`,
        state: 'pending' as const,
        ...overrides,
      };
    };

    const baseRecord = {
      version: 1 as const,
      groupId: '11111111-1111-4111-8111-111111111111',
      definitionSha256: groupDefinitionSha256(baseDef),
      definition: baseDef,
      profiles: {},
      nodes: {
        'node-a': { state: 'completed' as const },
        'node-b': { state: 'pending' as const },
      },
      state: 'running' as const,
      createdAt: '2026-10-10T00:00:00.000Z',
      updatedAt: '2026-10-10T00:00:00.000Z',
    };

    // 100 deliveries accepted
    const rec100 = {
      ...baseRecord,
      peerDeliveries: Array.from({ length: 100 }, (_, i) => makeDelivery(i)),
    };
    assert.doesNotThrow(() => groupRecordSchema.parse(rec100));

    // 101 deliveries rejected
    const rec101 = {
      ...baseRecord,
      peerDeliveries: Array.from({ length: 101 }, (_, i) => makeDelivery(i)),
    };
    assert.throws(() => groupRecordSchema.parse(rec101));

    // Reject duplicate logical casefold(sourceTaskId, messageId)
    const dupLogical = {
      ...baseRecord,
      peerDeliveries: [
        makeDelivery(1, {
          sourceTaskId: '11111111-1111-4111-8111-111111111111',
          messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          transportId: '22222222-2222-4222-8222-222222222222',
        }),
        makeDelivery(2, {
          sourceTaskId: '11111111-1111-4111-8111-111111111111',
          messageId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
          transportId: '33333333-3333-4333-8333-333333333333',
        }),
      ],
    };
    assert.throws(() => groupRecordSchema.parse(dupLogical));

    // Reject duplicate casefold transportId
    const dupTransport = {
      ...baseRecord,
      peerDeliveries: [
        makeDelivery(1, {
          messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          transportId: '44444444-4444-4444-8444-444444444444',
        }),
        makeDelivery(2, {
          messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          transportId: '44444444-4444-4444-8444-444444444444',
        }),
      ],
    };
    assert.throws(() => groupRecordSchema.parse(dupTransport));

    // summarizeGroup does NOT include bodies or ledger
    const validRecord = groupRecordSchema.parse({
      ...baseRecord,
      peerDeliveries: [makeDelivery(1)],
    });
    const summary = summarizeGroup(validRecord);
    assert.equal('peerDeliveries' in summary, false);
  });
});
