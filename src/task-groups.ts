import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BridgeError } from './types.js';

export const KEY_REGEX = /^[a-z][a-z0-9-]{0,63}$/;
export const OWNER_REGEX = /^[a-z][a-z0-9-]{0,31}$/;

export const RESERVED_KEYS = new Set([
  'constructor',
  'prototype',
  '__proto__',
  'valueOf',
  'toString',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
]);

export const GROUP_NODE_STATUS_VALUES = [
  'pending',
  'starting',
  'running',
  'completed',
  'failed',
  'cancelled',
  'blocked',
] as const;

export type GroupNodeStatus = (typeof GROUP_NODE_STATUS_VALUES)[number];

export const GroupNodeStatus = z.enum(GROUP_NODE_STATUS_VALUES);

export const groupNodeSchema = z
  .object({
    key: z
      .string()
      .regex(KEY_REGEX, 'Node key must match /^[a-z][a-z0-9-]{0,63}$/')
      .refine(
        (k) => !RESERVED_KEYS.has(k) && !(k in Object.prototype),
        'Node key cannot be a reserved object property'
      ),
    owner: z
      .string()
      .regex(OWNER_REGEX, 'Owner must match /^[a-z][a-z0-9-]{0,31}$/'),
    dependsOn: z
      .array(z.string().regex(KEY_REGEX, 'Dependency key must match /^[a-z][a-z0-9-]{0,63}$/'))
      .min(0)
      .max(31, 'dependsOn cannot exceed 31 dependencies')
      .refine(
        (deps) => new Set(deps).size === deps.length,
        'dependsOn must contain distinct node keys'
      ),
  })
  .strict();

export type GroupNode = z.infer<typeof groupNodeSchema>;

export const groupGraphSchema = z
  .object({
    nodes: z
      .array(groupNodeSchema)
      .min(1, 'Graph must contain 1..32 nodes')
      .max(32, 'Graph must contain 1..32 nodes'),
  })
  .strict()
  .superRefine((val, ctx) => {
    const keys = new Set<string>();
    let hasDuplicate = false;

    for (let i = 0; i < val.nodes.length; i++) {
      const node = val.nodes[i]!;
      if (keys.has(node.key)) {
        hasDuplicate = true;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate node key "${node.key}"`,
          path: ['nodes', i, 'key'],
        });
      }
      keys.add(node.key);
    }
    if (hasDuplicate) return;

    let hasInvalidRef = false;
    for (let i = 0; i < val.nodes.length; i++) {
      const node = val.nodes[i]!;
      for (let j = 0; j < node.dependsOn.length; j++) {
        const dep = node.dependsOn[j]!;
        if (dep === node.key) {
          hasInvalidRef = true;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Self edge detected: node "${node.key}" depends on itself`,
            path: ['nodes', i, 'dependsOn', j],
          });
        } else if (!keys.has(dep)) {
          hasInvalidRef = true;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Missing reference: dependency "${dep}" is not defined in graph`,
            path: ['nodes', i, 'dependsOn', j],
          });
        }
      }
    }
    if (hasInvalidRef) return;

    // Detect cycles using DFS
    const nodeMap = new Map<string, string[]>();
    for (const node of val.nodes) nodeMap.set(node.key, node.dependsOn);
    const state = new Map<string, number>(); // 0: unvisited, 1: visiting, 2: visited

    function dfs(key: string): boolean {
      state.set(key, 1);
      const deps = nodeMap.get(key) ?? [];
      for (const dep of deps) {
        if (!nodeMap.has(dep)) continue;
        const s = state.get(dep) ?? 0;
        if (s === 1) return true;
        if (s === 0 && dfs(dep)) return true;
      }
      state.set(key, 2);
      return false;
    }

    for (const node of val.nodes) {
      if ((state.get(node.key) ?? 0) === 0 && dfs(node.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Cycle detected in dependency graph containing "${node.key}"`,
          path: ['nodes'],
        });
        break;
      }
    }
  });

export type GroupGraph = z.infer<typeof groupGraphSchema>;
export type GroupProgress = Record<string, GroupNodeStatus>;

export interface GroupReadiness {
  ready: string[];
  waiting: string[];
  blocked: string[];
  terminal: boolean;
}

export function validateGroupGraph(input: unknown): GroupGraph {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BridgeError('INVALID_GROUP', 'Group graph must be an object');
  }

  const rootKeys = Object.getOwnPropertyNames(input);
  if (rootKeys.length !== 1 || rootKeys[0] !== 'nodes' || !Object.prototype.hasOwnProperty.call(input, 'nodes')) {
    throw new BridgeError('INVALID_GROUP', 'Group graph must contain only own "nodes" property');
  }

  const result = groupGraphSchema.safeParse(input);
  if (!result.success) {
    throw new BridgeError('INVALID_GROUP', result.error.issues[0]?.message ?? 'Invalid group graph');
  }

  return {
    nodes: result.data.nodes.map((node) => ({
      key: node.key,
      owner: node.owner,
      dependsOn: [...node.dependsOn],
    })),
  };
}

export function initialGroupProgress(graph: unknown): GroupProgress {
  const validGraph = validateGroupGraph(graph);
  const progress: GroupProgress = {};
  for (const node of validGraph.nodes) {
    progress[node.key] = 'pending';
  }
  return progress;
}

export function groupGraphSha256(graph: unknown): string {
  const validGraph = validateGroupGraph(graph);
  const payload = {
    nodes: validGraph.nodes.map((node) => ({
      key: node.key,
      owner: node.owner,
      dependsOn: [...node.dependsOn],
    })),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function groupReadiness(graph: unknown, progress: unknown): GroupReadiness {
  const validGraph = validateGroupGraph(graph);

  if (typeof progress !== 'object' || progress === null || Array.isArray(progress)) {
    throw new BridgeError('INVALID_GROUP_STATE', 'Group progress must be an object');
  }

  const ownKeys = Object.getOwnPropertyNames(progress);
  if (ownKeys.length !== validGraph.nodes.length) {
    throw new BridgeError(
      'INVALID_GROUP_STATE',
      `Progress contains ${ownKeys.length} keys, expected ${validGraph.nodes.length}`
    );
  }

  const nodeKeySet = new Set(validGraph.nodes.map((n) => n.key));
  for (const k of ownKeys) {
    if (!nodeKeySet.has(k)) {
      throw new BridgeError('INVALID_GROUP_STATE', `Unknown key "${k}" in progress`);
    }
  }

  const safeProgress = Object.create(null) as Record<string, GroupNodeStatus>;
  for (const node of validGraph.nodes) {
    if (!Object.prototype.hasOwnProperty.call(progress, node.key)) {
      throw new BridgeError('INVALID_GROUP_STATE', `Missing key "${node.key}" in progress`);
    }
    const val = (progress as Record<string, unknown>)[node.key];
    const parseRes = GroupNodeStatus.safeParse(val);
    if (!parseRes.success) {
      throw new BridgeError(
        'INVALID_GROUP_STATE',
        `Invalid status "${typeof val}" for node "${node.key}"`
      );
    }
    safeProgress[node.key] = parseRes.data;
  }

  const depMap = new Map<string, string[]>();
  for (const node of validGraph.nodes) {
    depMap.set(node.key, node.dependsOn);
  }

  const taintedMemo = new Map<string, boolean>();

  function isTainted(key: string): boolean {
    if (taintedMemo.has(key)) {
      return taintedMemo.get(key)!;
    }
    const status = safeProgress[key];
    if (status === 'failed' || status === 'cancelled' || status === 'blocked') {
      taintedMemo.set(key, true);
      return true;
    }
    const deps = depMap.get(key) ?? [];
    for (const dep of deps) {
      if (isTainted(dep)) {
        taintedMemo.set(key, true);
        return true;
      }
    }
    taintedMemo.set(key, false);
    return false;
  }

  const ready: string[] = [];
  const waiting: string[] = [];
  const blocked: string[] = [];

  for (const node of validGraph.nodes) {
    const status = safeProgress[node.key]!;
    if (status !== 'pending') {
      continue;
    }

    const deps = node.dependsOn;
    const isBlocked = deps.some((dep) => isTainted(dep));
    if (isBlocked) {
      blocked.push(node.key);
    } else {
      const allCompleted = deps.every((dep) => safeProgress[dep] === 'completed');
      if (allCompleted) {
        ready.push(node.key);
      } else {
        waiting.push(node.key);
      }
    }
  }

  const hasActive = validGraph.nodes.some(
    (n) => safeProgress[n.key] === 'starting' || safeProgress[n.key] === 'running'
  );
  const terminal = !hasActive && ready.length === 0 && waiting.length === 0;

  return { ready, waiting, blocked, terminal };
}
