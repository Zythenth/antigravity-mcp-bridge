import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { BridgeError } from '../src/types.js';
import {
  workflowOptionsSchema,
  validateWorkflowOptions,
  workflowCheckpointSchema,
  workflowCheckpointSha256,
  workflowInputSchema,
  buildWorkflowContext,
  MAX_WORKFLOW_CONTEXT_BYTES,
  type WorkflowCheckpoint,
  type WorkflowInput,
} from '../src/workflows.js';
import { validateStructuredResult } from '../src/structured-results.js';

describe('Workflows', () => {
  it('validates ancestor synthesis sink, hooks, and returns detached options', () => {
    const graph = {
      nodes: [
        { key: 'prep', owner: 'agent-a', dependsOn: [] },
        { key: 'compute', owner: 'agent-b', dependsOn: ['prep'] },
        { key: 'aggregate', owner: 'agent-c', dependsOn: ['compute'] },
      ],
    };

    const rawOptions = {
      finalNode: 'aggregate',
      hooks: {
        prep: { requireReview: true },
        aggregate: { requireTests: false },
      },
    };

    const validated = validateWorkflowOptions(graph, rawOptions);
    assert.equal(validated.finalNode, 'aggregate');
    assert.equal(validated.hooks?.prep?.requireReview, true);
    assert.equal(validated.hooks?.aggregate?.requireTests, false);

    rawOptions.hooks.prep.requireReview = false;
    rawOptions.hooks.aggregate.requireTests = true;
    assert.equal(validated.hooks?.prep?.requireReview, true);
    assert.equal(validated.hooks?.aggregate?.requireTests, false);

    validated.hooks!.prep!.requireReview = false;
    assert.equal(rawOptions.hooks.prep.requireReview, false);
  });

  it('retains INVALID_GROUP for graph errors and uses INVALID_WORKFLOW for option/DAG errors', () => {
    assert.throws(
      () => validateWorkflowOptions({ nodes: [] }, { finalNode: 'node1' }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_GROUP');
        return true;
      }
    );

    const cyclicGraph = {
      nodes: [
        { key: 'a', owner: 'agent-a', dependsOn: ['b'] },
        { key: 'b', owner: 'agent-b', dependsOn: ['a'] },
      ],
    };
    assert.throws(
      () => validateWorkflowOptions(cyclicGraph, { finalNode: 'b' }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_GROUP');
        return true;
      }
    );

    const graphWithIsolated = {
      nodes: [
        { key: 'a', owner: 'agent-a', dependsOn: [] },
        { key: 'b', owner: 'agent-b', dependsOn: ['a'] },
        { key: 'c', owner: 'agent-c', dependsOn: [] },
      ],
    };
    assert.throws(
      () => validateWorkflowOptions(graphWithIsolated, { finalNode: 'b' }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_WORKFLOW');
        return true;
      }
    );

    assert.throws(
      () => validateWorkflowOptions(graphWithIsolated, { finalNode: 'nonexistent' }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_WORKFLOW');
        return true;
      }
    );

    const validGraph = {
      nodes: [
        { key: 'a', owner: 'agent-a', dependsOn: [] },
        { key: 'b', owner: 'agent-b', dependsOn: ['a'] },
      ],
    };
    assert.throws(
      () =>
        validateWorkflowOptions(validGraph, {
          finalNode: 'b',
          hooks: { nonexistent: { requireReview: true } },
        }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_WORKFLOW');
        return true;
      }
    );
  });

  it('omits optional fields without injecting defaults into stored options', () => {
    const graph = {
      nodes: [
        { key: 'a', owner: 'agent-a', dependsOn: [] },
        { key: 'b', owner: 'agent-b', dependsOn: ['a'] },
      ],
    };

    const result1 = validateWorkflowOptions(graph, { finalNode: 'b' });
    assert.equal(result1.finalNode, 'b');
    assert.equal(result1.hooks, undefined);
    assert.equal('hooks' in result1, false);

    const result2 = validateWorkflowOptions(graph, {
      finalNode: 'b',
      hooks: { a: { requireReview: true } },
    });
    assert.equal(result2.hooks?.a?.requireReview, true);
    assert.equal(result2.hooks?.a?.requireTests, undefined);
    assert.equal('requireTests' in (result2.hooks?.a ?? {}), false);
  });

  it('enforces strict checkpoint schema and reflects changes in SHA256 digest', () => {
    const cp: WorkflowCheckpoint = {
      taskId: randomUUID(),
      outputTaskId: randomUUID(),
      treeSha256: 'a'.repeat(64),
      patchSha256: 'b'.repeat(64),
      outputSha256: 'c'.repeat(64),
      validationSha256: 'd'.repeat(64),
      artifacts: [{ path: 'dist/out.json', sha256: 'e'.repeat(64), bytes: 1024 }],
      createdAt: new Date().toISOString(),
    };

    const parsed = workflowCheckpointSchema.parse(cp);
    assert.equal(parsed.taskId, cp.taskId);

    const hash1 = workflowCheckpointSha256(cp);
    assert.match(hash1, /^[a-f0-9]{64}$/);

    const cpChanged = { ...cp, patchSha256: 'f'.repeat(64) };
    const hash2 = workflowCheckpointSha256(cpChanged);
    assert.notEqual(hash1, hash2);

    assert.throws(
      () => workflowCheckpointSha256({ ...cp, prompt: 'Generate code' }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_WORKFLOW_CHECKPOINT');
        return true;
      }
    );

    assert.throws(
      () => workflowCheckpointSha256({ ...cp, authority: 'root' }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_WORKFLOW_CHECKPOINT');
        return true;
      }
    );
  });

  it('rejects path traversal and duplicate normalized artifact paths in checkpoints', () => {
    const cpTraversal = {
      taskId: randomUUID(),
      outputTaskId: randomUUID(),
      treeSha256: 'a'.repeat(64),
      patchSha256: 'b'.repeat(64),
      outputSha256: 'c'.repeat(64),
      validationSha256: 'd'.repeat(64),
      artifacts: [{ path: '../secret.txt', sha256: 'e'.repeat(64), bytes: 10 }],
      createdAt: new Date().toISOString(),
    };
    assert.throws(
      () => workflowCheckpointSha256(cpTraversal),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_WORKFLOW_CHECKPOINT');
        return true;
      }
    );

    const cpDuplicate = {
      taskId: randomUUID(),
      outputTaskId: randomUUID(),
      treeSha256: 'a'.repeat(64),
      patchSha256: 'b'.repeat(64),
      outputSha256: 'c'.repeat(64),
      validationSha256: 'd'.repeat(64),
      artifacts: [
        { path: 'sub/file.txt', sha256: 'e'.repeat(64), bytes: 10 },
        { path: 'sub\\file.txt', sha256: 'f'.repeat(64), bytes: 20 },
      ],
      createdAt: new Date().toISOString(),
    };
    assert.throws(
      () => workflowCheckpointSha256(cpDuplicate),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_WORKFLOW_CHECKPOINT');
        return true;
      }
    );
  });

  it('builds workflow context with exact bytes, verified hashes, and detached values', () => {
    const val1 = { count: 42, label: 'alpha' };
    const val2 = { ok: true, nested: { list: [1, 2, 3] } };
    const hash1 = validateStructuredResult({}, val1).sha256;
    const hash2 = validateStructuredResult({}, val2).sha256;

    const rawInputs: WorkflowInput[] = [
      {
        nodeKey: 'n1',
        taskId: randomUUID(),
        outputSha256: hash1,
        value: val1,
        artifacts: [{ path: 'out/one.txt', sha256: '1'.repeat(64), bytes: 100 }],
      },
      {
        nodeKey: 'n2',
        taskId: randomUUID(),
        outputSha256: hash2,
        value: val2,
        artifacts: [],
      },
    ];

    const context = buildWorkflowContext(rawInputs);
    assert.equal(context.bytes, Buffer.byteLength(context.text, 'utf8'));
    assert.equal(
      context.sha256,
      createHash('sha256').update(Buffer.from(context.text, 'utf8')).digest('hex')
    );

    const parsed = JSON.parse(context.text);
    assert.equal(parsed.inputs.length, 2);
    assert.deepEqual(parsed.inputs[0].value, val1);
    assert.deepEqual(parsed.inputs[1].value, val2);

    val1.count = 999;
    const reParsed = JSON.parse(context.text);
    assert.equal(reParsed.inputs[0].value.count, 42);
  });

  it('rejects wrong hash, undefined, non-JSON, and cyclic values with INVALID_WORKFLOW_INPUT', () => {
    const inputWrongHash: WorkflowInput = {
      nodeKey: 'n1',
      taskId: randomUUID(),
      outputSha256: '0'.repeat(64),
      value: { ok: true },
      artifacts: [],
    };
    assert.throws(
      () => buildWorkflowContext([inputWrongHash]),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_WORKFLOW_INPUT');
        return true;
      }
    );

    const inputUndefined: WorkflowInput = {
      nodeKey: 'n1',
      taskId: randomUUID(),
      outputSha256: '0'.repeat(64),
      value: { bad: undefined },
      artifacts: [],
    };
    assert.throws(
      () => buildWorkflowContext([inputUndefined]),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_WORKFLOW_INPUT');
        return true;
      }
    );

    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const inputCyclic: WorkflowInput = {
      nodeKey: 'n1',
      taskId: randomUUID(),
      outputSha256: '0'.repeat(64),
      value: cyclic,
      artifacts: [],
    };
    assert.throws(
      () => buildWorkflowContext([inputCyclic]),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_WORKFLOW_INPUT');
        return true;
      }
    );

    const inputNaN: WorkflowInput = {
      nodeKey: 'n1',
      taskId: randomUUID(),
      outputSha256: '0'.repeat(64),
      value: { bad: NaN },
      artifacts: [],
    };
    assert.throws(
      () => buildWorkflowContext([inputNaN]),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_WORKFLOW_INPUT');
        return true;
      }
    );
  });

  it('enforces unique node keys and the 32 input cap with INVALID_WORKFLOW_INPUT', () => {
    const val = { x: 1 };
    const h = validateStructuredResult({}, val).sha256;
    const dupInputs: WorkflowInput[] = [
      { nodeKey: 'dup-node', taskId: randomUUID(), outputSha256: h, value: val, artifacts: [] },
      { nodeKey: 'dup-node', taskId: randomUUID(), outputSha256: h, value: val, artifacts: [] },
    ];
    assert.throws(
      () => buildWorkflowContext(dupInputs),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_WORKFLOW_INPUT');
        return true;
      }
    );

    const thirtyThree: WorkflowInput[] = Array.from({ length: 33 }, (_, i) => ({
      nodeKey: `node-${i}`,
      taskId: randomUUID(),
      outputSha256: h,
      value: val,
      artifacts: [],
    }));
    assert.throws(
      () => buildWorkflowContext(thirtyThree),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_WORKFLOW_INPUT');
        return true;
      }
    );

    const thirtyTwo = thirtyThree.slice(0, 32);
    const ctx32 = buildWorkflowContext(thirtyTwo);
    assert.equal(JSON.parse(ctx32.text).inputs.length, 32);
  });

  it('handles exact 64KiB byte limit and rejects multibyte over-limit with WORKFLOW_CONTEXT_TOO_LARGE', () => {
    const baseVal = { pad: '' };
    const baseHash = validateStructuredResult({}, baseVal).sha256;
    const baseInput: WorkflowInput = {
      nodeKey: 'n0',
      taskId: randomUUID(),
      outputSha256: baseHash,
      value: baseVal,
      artifacts: [],
    };
    const baseSerialized = JSON.stringify({ inputs: [baseInput] });
    const baseBytes = Buffer.byteLength(baseSerialized, 'utf8');
    const needed = MAX_WORKFLOW_CONTEXT_BYTES - baseBytes;

    const exactVal = { pad: 'x'.repeat(needed) };
    const exactHash = validateStructuredResult({}, exactVal).sha256;
    const exactInput: WorkflowInput = {
      ...baseInput,
      outputSha256: exactHash,
      value: exactVal,
    };

    const res = buildWorkflowContext([exactInput]);
    assert.equal(res.bytes, MAX_WORKFLOW_CONTEXT_BYTES);
    assert.equal(res.bytes, 64 * 1024);

    const overVal = { pad: 'x'.repeat(needed - 1) + '🔥' };
    const overHash = validateStructuredResult({}, overVal).sha256;
    const overInput: WorkflowInput = {
      ...baseInput,
      outputSha256: overHash,
      value: overVal,
    };

    assert.throws(
      () => buildWorkflowContext([overInput]),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'WORKFLOW_CONTEXT_TOO_LARGE');
        return true;
      }
    );
  });
});


it('rejects unknown workflow option and input fields without adding defaults', () => {
  assert.equal(workflowOptionsSchema.safeParse({ finalNode: 'final', permission: true }).success, false);
  assert.equal(workflowInputSchema.safeParse({ nodeKey: 'a', taskId: randomUUID(), outputSha256: 'a'.repeat(64), value: 1, artifacts: [], permission: true }).success, false);
});
function checkpointFixture(artifacts: WorkflowCheckpoint['artifacts']): WorkflowCheckpoint {
  return { taskId: randomUUID(), outputTaskId: randomUUID(), treeSha256: 'a'.repeat(64), patchSha256: 'b'.repeat(64),
    outputSha256: 'c'.repeat(64), validationSha256: 'd'.repeat(64), artifacts, createdAt: '2026-10-10T00:00:00.000Z' };
}
it('checkpoint digest identifies exact validated JSON including literal path representation', () => {
  const cp = checkpointFixture([{ path: 'folder\\out.json', sha256: 'e'.repeat(64), bytes: 1 }]);
  const parsed = workflowCheckpointSchema.parse(cp);
  assert.equal(workflowCheckpointSha256(cp), createHash('sha256').update(JSON.stringify(parsed), 'utf8').digest('hex'));
});
it('distinct case-sensitive artifact names remain distinct normalized references', () => {
  const artifacts = [{ path: 'Out.json', sha256: 'a'.repeat(64), bytes: 1 }, { path: 'out.json', sha256: 'b'.repeat(64), bytes: 1 }];
  assert.doesNotThrow(() => workflowCheckpointSha256(checkpointFixture(artifacts)));
  const value = { ok: true }, outputSha256 = validateStructuredResult({}, value).sha256;
  assert.doesNotThrow(() => buildWorkflowContext([{ nodeKey: 'a', taskId: randomUUID(), value, outputSha256, artifacts }]));
});

it('file inheritance selects only a declared direct predecessor and detaches configuration', () => {
  const graph = { nodes: [{ key: 'a', owner: 'implementer', dependsOn: [] }, { key: 'b', owner: 'implementer', dependsOn: ['a'] }] };
  const raw = { finalNode: 'b', fileSources: { b: 'a' } };
  const options = validateWorkflowOptions(graph, raw); raw.fileSources.b = 'b';
  assert.equal(options.fileSources!.b, 'a');
  assert.throws(() => validateWorkflowOptions(graph, raw), { code: 'INVALID_WORKFLOW' });
  assert.throws(() => validateWorkflowOptions(graph, { finalNode: 'b', fileSources: { a: 'b' } }), { code: 'INVALID_WORKFLOW' });
});
