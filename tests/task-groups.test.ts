import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupGraphSchema,
  validateGroupGraph,
  initialGroupProgress,
  groupGraphSha256,
  groupReadiness,
  GroupNodeStatus,
  type GroupGraph,
} from '../src/task-groups.js';
import { BridgeError } from '../src/types.js';

describe('task-groups', () => {
  it('rejects empty, oversized graphs and oversized dependencies', () => {
    assert.throws(
      () => validateGroupGraph({ nodes: [] }),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP'
    );
    assert.equal(groupGraphSchema.safeParse({ nodes: [] }).success, false);

    const oversizedNodes = Array.from({ length: 33 }, (_, i) => ({
      key: `node-${i}`,
      owner: 'worker',
      dependsOn: [],
    }));
    assert.throws(
      () => validateGroupGraph({ nodes: oversizedNodes }),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP'
    );

    const thirtyTwoDeps = Array.from({ length: 32 }, (_, i) => `dep-${i}`);
    assert.throws(
      () =>
        validateGroupGraph({
          nodes: [{ key: 'target', owner: 'worker', dependsOn: thirtyTwoDeps }],
        }),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP'
    );
  });

  it('rejects unknown fields on graph and node objects', () => {
    assert.throws(
      () =>
        validateGroupGraph({
          nodes: [{ key: 'step-a', owner: 'worker', dependsOn: [] }],
          extraField: 'unexpected',
        }),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP'
    );

    assert.throws(
      () =>
        validateGroupGraph({
          nodes: [{ key: 'step-a', owner: 'worker', dependsOn: [], unknownKey: 123 }],
        }),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP'
    );
  });

  it('rejects invalid or reserved node keys and malformed owners', () => {
    for (const reserved of ['constructor', 'prototype', '__proto__', 'valueOf', 'toString']) {
      assert.throws(
        () =>
          validateGroupGraph({
            nodes: [{ key: reserved, owner: 'worker', dependsOn: [] }],
          }),
        (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP'
      );
    }

    for (const invalidKey of ['1step', 'Step', 'step_a', 'step!']) {
      assert.throws(
        () =>
          validateGroupGraph({
            nodes: [{ key: invalidKey, owner: 'worker', dependsOn: [] }],
          }),
        (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP'
      );
    }

    for (const invalidOwner of ['', 'Worker', 'worker_role', 'worker!']) {
      assert.throws(
        () =>
          validateGroupGraph({
            nodes: [{ key: 'step-a', owner: invalidOwner, dependsOn: [] }],
          }),
        (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP'
      );
    }
  });

  it('rejects duplicate nodes, missing references, self edges, and duplicate dependencies', () => {
    assert.throws(
      () =>
        validateGroupGraph({
          nodes: [
            { key: 'step-a', owner: 'worker', dependsOn: [] },
            { key: 'step-a', owner: 'worker', dependsOn: [] },
          ],
        }),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP'
    );

    assert.throws(
      () =>
        validateGroupGraph({
          nodes: [{ key: 'step-a', owner: 'worker', dependsOn: ['missing-node'] }],
        }),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP'
    );

    assert.throws(
      () =>
        validateGroupGraph({
          nodes: [{ key: 'step-a', owner: 'worker', dependsOn: ['step-a'] }],
        }),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP'
    );

    assert.throws(
      () =>
        validateGroupGraph({
          nodes: [
            { key: 'step-a', owner: 'worker', dependsOn: [] },
            { key: 'step-b', owner: 'worker', dependsOn: ['step-a', 'step-a'] },
          ],
        }),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP'
    );
  });

  it('rejects cyclic dependencies in 2-node and multi-node cycles', () => {
    assert.throws(
      () =>
        validateGroupGraph({
          nodes: [
            { key: 'node-a', owner: 'worker', dependsOn: ['node-b'] },
            { key: 'node-b', owner: 'worker', dependsOn: ['node-a'] },
          ],
        }),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP'
    );

    assert.throws(
      () =>
        validateGroupGraph({
          nodes: [
            { key: 'node-a', owner: 'worker', dependsOn: ['node-c'] },
            { key: 'node-b', owner: 'worker', dependsOn: ['node-a'] },
            { key: 'node-c', owner: 'worker', dependsOn: ['node-b'] },
          ],
        }),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP'
    );
  });

  it('validates correct graphs and generates initial progress', () => {
    const validGraph: GroupGraph = {
      nodes: [
        { key: 'setup', owner: 'engineer', dependsOn: [] },
        { key: 'build', owner: 'engineer', dependsOn: ['setup'] },
        { key: 'verify', owner: 'tester', dependsOn: ['build'] },
      ],
    };

    const validated = validateGroupGraph(validGraph);
    assert.equal(validated.nodes.length, 3);
    assert.deepEqual(validated.nodes[0], { key: 'setup', owner: 'engineer', dependsOn: [] });

    const progress = initialGroupProgress(validGraph);
    assert.deepEqual(progress, {
      setup: GroupNodeStatus.enum.pending,
      build: GroupNodeStatus.enum.pending,
      verify: GroupNodeStatus.enum.pending,
    });
  });

  it('computes stable SHA-256 and detects declaration/dependency order changes', () => {
    const graph: GroupGraph = {
      nodes: [
        { key: 'task-a', owner: 'worker', dependsOn: [] },
        { key: 'task-b', owner: 'worker', dependsOn: ['task-a'] },
      ],
    };

    const hash1 = groupGraphSha256(graph);
    const hash2 = groupGraphSha256(graph);
    assert.equal(hash1, hash2);
    assert.match(hash1, /^[0-9a-f]{64}$/);

    const reorderedNodesGraph: GroupGraph = {
      nodes: [
        { key: 'task-b', owner: 'worker', dependsOn: ['task-a'] },
        { key: 'task-a', owner: 'worker', dependsOn: [] },
      ],
    };
    assert.notEqual(groupGraphSha256(reorderedNodesGraph), hash1);

    const multiDepGraph1: GroupGraph = {
      nodes: [
        { key: 'a', owner: 'worker', dependsOn: [] },
        { key: 'b', owner: 'worker', dependsOn: [] },
        { key: 'c', owner: 'worker', dependsOn: ['a', 'b'] },
      ],
    };
    const multiDepGraph2: GroupGraph = {
      nodes: [
        { key: 'a', owner: 'worker', dependsOn: [] },
        { key: 'b', owner: 'worker', dependsOn: [] },
        { key: 'c', owner: 'worker', dependsOn: ['b', 'a'] },
      ],
    };
    assert.notEqual(groupGraphSha256(multiDepGraph1), groupGraphSha256(multiDepGraph2));
  });

  it('guarantees caller mutation detachment', () => {
    const inputGraph = {
      nodes: [
        { key: 'step-1', owner: 'worker', dependsOn: [] },
        { key: 'step-2', owner: 'worker', dependsOn: ['step-1'] },
      ],
    };

    const validated = validateGroupGraph(inputGraph);
    inputGraph.nodes[0]!.dependsOn.push('step-2');
    assert.deepEqual(validated.nodes[0]!.dependsOn, []);

    const returnedDependencies: string[] = validated.nodes[0]!.dependsOn;
    returnedDependencies.push('mutated');
    assert.deepEqual(inputGraph.nodes[0]!.dependsOn, ['step-2']);

    inputGraph.nodes[0]!.dependsOn = [];
    const progress = initialGroupProgress(inputGraph);
    progress['step-1'] = 'completed';
    const freshProgress = initialGroupProgress(inputGraph);
    assert.equal(freshProgress['step-1'], 'pending');
  });

  it('identifies independent ready roots and waiting dependents preserving order', () => {
    const graph: GroupGraph = {
      nodes: [
        { key: 'root-alpha', owner: 'worker', dependsOn: [] },
        { key: 'root-beta', owner: 'worker', dependsOn: [] },
        { key: 'child-omega', owner: 'worker', dependsOn: ['root-alpha', 'root-beta'] },
      ],
    };

    const progress = initialGroupProgress(graph);
    const readiness = groupReadiness(graph, progress);
    assert.deepEqual(readiness.ready, ['root-alpha', 'root-beta']);
    assert.deepEqual(readiness.waiting, ['child-omega']);
    assert.deepEqual(readiness.blocked, []);
    assert.equal(readiness.terminal, false);
  });

  it('gates execution until all dependencies are completed', () => {
    const graph: GroupGraph = {
      nodes: [
        { key: 'dep-a', owner: 'worker', dependsOn: [] },
        { key: 'dep-b', owner: 'worker', dependsOn: [] },
        { key: 'consumer', owner: 'worker', dependsOn: ['dep-a', 'dep-b'] },
      ],
    };

    const rPartial1 = groupReadiness(graph, {
      'dep-a': 'completed',
      'dep-b': 'pending',
      consumer: 'pending',
    });
    assert.deepEqual(rPartial1.ready, ['dep-b']);
    assert.deepEqual(rPartial1.waiting, ['consumer']);

    const rPartial2 = groupReadiness(graph, {
      'dep-a': 'completed',
      'dep-b': 'running',
      consumer: 'pending',
    });
    assert.deepEqual(rPartial2.ready, []);
    assert.deepEqual(rPartial2.waiting, ['consumer']);

    const rAllDone = groupReadiness(graph, {
      'dep-a': 'completed',
      'dep-b': 'completed',
      consumer: 'pending',
    });
    assert.deepEqual(rAllDone.ready, ['consumer']);
    assert.deepEqual(rAllDone.waiting, []);
  });

  it('cascades failed, cancelled, and blocked states transitively across ancestors', () => {
    const chain: GroupGraph = {
      nodes: [
        { key: 'root', owner: 'worker', dependsOn: [] },
        { key: 'mid', owner: 'worker', dependsOn: ['root'] },
        { key: 'leaf', owner: 'worker', dependsOn: ['mid'] },
      ],
    };

    const rFailed = groupReadiness(chain, {
      root: 'failed',
      mid: 'pending',
      leaf: 'pending',
    });
    assert.deepEqual(rFailed.ready, []);
    assert.deepEqual(rFailed.waiting, []);
    assert.deepEqual(rFailed.blocked, ['mid', 'leaf']);
    assert.equal(rFailed.terminal, true);

    const rCancelled = groupReadiness(chain, {
      root: 'cancelled',
      mid: 'pending',
      leaf: 'pending',
    });
    assert.deepEqual(rCancelled.blocked, ['mid', 'leaf']);
    assert.equal(rCancelled.terminal, true);

    const rBlocked = groupReadiness(chain, {
      root: 'blocked',
      mid: 'pending',
      leaf: 'pending',
    });
    assert.deepEqual(rBlocked.blocked, ['mid', 'leaf']);
    assert.equal(rBlocked.terminal, true);

    // Multi-parent cascade: failure in one parent blocks downstream child even if other parent completed
    const multiParent: GroupGraph = {
      nodes: [
        { key: 'parent-ok', owner: 'worker', dependsOn: [] },
        { key: 'parent-bad', owner: 'worker', dependsOn: [] },
        { key: 'child', owner: 'worker', dependsOn: ['parent-ok', 'parent-bad'] },
      ],
    };
    const rMulti = groupReadiness(multiParent, {
      'parent-ok': 'completed',
      'parent-bad': 'failed',
      child: 'pending',
    });
    assert.deepEqual(rMulti.blocked, ['child']);
    assert.equal(rMulti.terminal, true);
  });

  it('never replays starting, running, or terminal nodes and validates progress strictly', () => {
    const graph: GroupGraph = {
      nodes: [
        { key: 'done', owner: 'worker', dependsOn: [] },
        { key: 'active', owner: 'worker', dependsOn: [] },
        { key: 'stopped', owner: 'worker', dependsOn: [] },
        { key: 'waiting-task', owner: 'worker', dependsOn: ['active'] },
      ],
    };

    const r = groupReadiness(graph, {
      done: 'completed',
      active: 'running',
      stopped: 'blocked',
      'waiting-task': 'pending',
    });
    assert.deepEqual(r.ready, []);
    assert.deepEqual(r.waiting, ['waiting-task']);
    assert.deepEqual(r.blocked, []);
    assert.equal(r.terminal, false);

    // Missing key
    assert.throws(
      () =>
        groupReadiness(graph, {
          done: 'completed',
          active: 'running',
          stopped: 'blocked',
        }),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP_STATE'
    );

    // Extra unknown key
    assert.throws(
      () =>
        groupReadiness(graph, {
          done: 'completed',
          active: 'running',
          stopped: 'blocked',
          'waiting-task': 'pending',
          unexpected: 'pending',
        }),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP_STATE'
    );

    // Invalid enum status
    assert.throws(
      () =>
        groupReadiness(graph, {
          done: 'completed',
          active: 'RUNNING',
          stopped: 'blocked',
          'waiting-task': 'pending',
        }),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP_STATE'
    );

    // Prototype inheritance rejected
    const protoObj = Object.create({
      done: 'completed',
      active: 'running',
      stopped: 'blocked',
      'waiting-task': 'pending',
    });
    assert.throws(
      () => groupReadiness(graph, protoObj),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP_STATE'
    );
  });

  it('determines terminal state accurately', () => {
    const graph: GroupGraph = {
      nodes: [
        { key: 'task-1', owner: 'worker', dependsOn: [] },
        { key: 'task-2', owner: 'worker', dependsOn: ['task-1'] },
      ],
    };

    // All completed -> terminal
    assert.equal(
      groupReadiness(graph, { 'task-1': 'completed', 'task-2': 'completed' }).terminal,
      true
    );

    // Starting or running node active -> not terminal
    assert.equal(
      groupReadiness(graph, { 'task-1': 'starting', 'task-2': 'pending' }).terminal,
      false
    );
    assert.equal(
      groupReadiness(graph, { 'task-1': 'running', 'task-2': 'pending' }).terminal,
      false
    );

    // Pending ready or waiting nodes -> not terminal
    assert.equal(
      groupReadiness(graph, { 'task-1': 'pending', 'task-2': 'pending' }).terminal,
      false
    );

    // All pending nodes blocked with no active nodes -> terminal
    assert.equal(
      groupReadiness(graph, { 'task-1': 'failed', 'task-2': 'pending' }).terminal,
      true
    );
  });
});

it('invalid object progress values preserve the documented error contract', () => {
  const graph = { nodes: [{ key: 'root', owner: 'worker', dependsOn: [] }] };
  assert.throws(() => groupReadiness(graph, { root: { toString: null, valueOf: null } }), { code: 'INVALID_GROUP_STATE' });
});
