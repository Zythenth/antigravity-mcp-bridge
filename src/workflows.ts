import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BridgeError } from './types.js';
import { validateGroupGraph } from './task-groups.js';
import { nodeKeySchema } from './peer-messages.js';
import { validateStructuredResult } from './structured-results.js';
import { artifactReferenceSchema, validArtifactRelative, type ArtifactReference } from './artifacts.js';

const HASH_REGEX = /^[a-f0-9]{64}$/;

export const workflowHookSchema = z
  .object({
    requireReview: z.boolean().optional(),
    requireTests: z.boolean().optional(),
  })
  .strict();

export type WorkflowHook = z.infer<typeof workflowHookSchema>;

export const workflowOptionsSchema = z
  .object({
    finalNode: nodeKeySchema,
    hooks: z.record(nodeKeySchema, workflowHookSchema).optional(),
    fileSources: z.record(nodeKeySchema, nodeKeySchema).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.fileSources && Object.keys(val.fileSources).length > 32) ctx.addIssue({ code: 'custom', message: 'File sources cannot exceed32 entries', path: ['fileSources'] });
    if (val.hooks !== undefined && Object.keys(val.hooks).length > 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Hooks cannot exceed 32 entries',
        path: ['hooks'],
      });
    }
  });

export type WorkflowOptions = z.infer<typeof workflowOptionsSchema>;

export function validateWorkflowOptions(graph: unknown, options: unknown): WorkflowOptions {
  const validGraph = validateGroupGraph(graph);

  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new BridgeError('INVALID_WORKFLOW', 'Workflow options must be an object');
  }

  const parsed = workflowOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new BridgeError(
      'INVALID_WORKFLOW',
      parsed.error.issues[0]?.message ?? 'Invalid workflow options'
    );
  }

  const nodeMap = new Map<string, string[]>();
  for (const node of validGraph.nodes) {
    nodeMap.set(node.key, node.dependsOn);
  }

  if (!nodeMap.has(parsed.data.finalNode)) {
    throw new BridgeError('INVALID_WORKFLOW', `Final node "${parsed.data.finalNode}" does not exist in graph`);
  }

  const ancestors = new Set<string>();
  const queue = [...(nodeMap.get(parsed.data.finalNode) ?? [])];
  for (const dep of queue) {
    ancestors.add(dep);
  }
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++]!;
    const deps = nodeMap.get(current) ?? [];
    for (const dep of deps) {
      if (!ancestors.has(dep)) {
        ancestors.add(dep);
        queue.push(dep);
      }
    }
  }

  for (const node of validGraph.nodes) {
    if (node.key !== parsed.data.finalNode && !ancestors.has(node.key)) {
      throw new BridgeError(
        'INVALID_WORKFLOW',
        `Node "${node.key}" is not a transitive ancestor of final node "${parsed.data.finalNode}"`
      );
    }
  }

  if (parsed.data.hooks !== undefined) {
    for (const hookKey of Object.keys(parsed.data.hooks)) {
      if (!nodeMap.has(hookKey)) {
        throw new BridgeError('INVALID_WORKFLOW', `Hook key "${hookKey}" does not exist in graph`);
      }
    }
  }

  for (const [target, source] of Object.entries(parsed.data.fileSources ?? {})) {
    if (!nodeMap.has(target) || !nodeMap.get(target)!.includes(source)) throw new BridgeError('INVALID_WORKFLOW', 'A file source must be a declared direct dependency of its target step');
  }
  const detached: WorkflowOptions = {
    finalNode: parsed.data.finalNode,
  };

  if (parsed.data.hooks !== undefined) {
    const detachedHooks: Record<string, WorkflowHook> = {};
    for (const [key, hook] of Object.entries(parsed.data.hooks)) {
      const entry: WorkflowHook = {};
      if (hook.requireReview !== undefined) entry.requireReview = hook.requireReview;
      if (hook.requireTests !== undefined) entry.requireTests = hook.requireTests;
      detachedHooks[key] = entry;
    }
    detached.hooks = detachedHooks;
  }

  if (parsed.data.fileSources !== undefined) detached.fileSources = { ...parsed.data.fileSources };
  return detached;
}

function validateArtifactsList(artifacts: readonly ArtifactReference[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (let i = 0; i < artifacts.length; i++) {
    const art = artifacts[i]!;
    let norm: string;
    try {
      norm = validArtifactRelative(art.path);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
        path: ['artifacts', i, 'path'],
      });
      continue;
    }
    const key = norm;
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate artifact path "${norm}"`,
        path: ['artifacts', i, 'path'],
      });
    }
    seen.add(key);
  }
}

export const workflowCheckpointSchema = z
  .object({
    taskId: z.string().uuid(),
    outputTaskId: z.string().uuid(),
    treeSha256: z.string().regex(HASH_REGEX, 'treeSha256 must be a 64-character lowercase hex hash'),
    patchSha256: z.string().regex(HASH_REGEX, 'patchSha256 must be a 64-character lowercase hex hash'),
    outputSha256: z.string().regex(HASH_REGEX, 'outputSha256 must be a 64-character lowercase hex hash'),
    validationSha256: z.string().regex(HASH_REGEX, 'validationSha256 must be a 64-character lowercase hex hash'),
    artifacts: z.array(artifactReferenceSchema).max(100, 'artifacts cannot exceed 100 entries'),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateArtifactsList(val.artifacts, ctx);
  });

export type WorkflowCheckpoint = z.infer<typeof workflowCheckpointSchema>;

export function workflowCheckpointSha256(checkpoint: unknown): string {
  if (typeof checkpoint !== 'object' || checkpoint === null || Array.isArray(checkpoint)) {
    throw new BridgeError('INVALID_WORKFLOW_CHECKPOINT', 'Workflow checkpoint must be an object');
  }

  const parsed = workflowCheckpointSchema.safeParse(checkpoint);
  if (!parsed.success) {
    throw new BridgeError(
      'INVALID_WORKFLOW_CHECKPOINT',
      parsed.error.issues[0]?.message ?? 'Invalid workflow checkpoint'
    );
  }


  return createHash('sha256')
    .update(Buffer.from(JSON.stringify(parsed.data), 'utf8'))
    .digest('hex');
}

export const workflowInputSchema = z
  .object({
    nodeKey: nodeKeySchema,
    taskId: z.string().uuid(),
    outputSha256: z.string().regex(HASH_REGEX, 'outputSha256 must be a 64-character lowercase hex hash'),
    value: z.unknown(),
    artifacts: z.array(artifactReferenceSchema).max(100, 'artifacts cannot exceed 100 entries'),
  })
  .strict();

export type WorkflowInput = z.infer<typeof workflowInputSchema>;

export const MAX_WORKFLOW_CONTEXT_BYTES = 64 * 1024;

export function buildWorkflowContext(inputs: unknown): {
  text: string;
  sha256: string;
  bytes: number;
} {
  if (!Array.isArray(inputs)) {
    throw new BridgeError('INVALID_WORKFLOW_INPUT', 'Workflow inputs must be an array');
  }

  if (inputs.length > 32) {
    throw new BridgeError('INVALID_WORKFLOW_INPUT', 'Workflow inputs cannot exceed 32 entries');
  }

  const seenNodeKeys = new Set<string>();
  const detachedInputs: WorkflowInput[] = [];

  for (const rawInput of inputs) {
    if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
      throw new BridgeError('INVALID_WORKFLOW_INPUT', 'Workflow input must be an object');
    }

    const parsed = workflowInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new BridgeError(
        'INVALID_WORKFLOW_INPUT',
        parsed.error.issues[0]?.message ?? 'Invalid workflow input'
      );
    }

    const input = parsed.data;

    if (seenNodeKeys.has(input.nodeKey)) {
      throw new BridgeError(
        'INVALID_WORKFLOW_INPUT',
        `Duplicate input for node key "${input.nodeKey}"`
      );
    }
    seenNodeKeys.add(input.nodeKey);

    let structured: { value: unknown; sha256: string };
    try {
      structured = validateStructuredResult({}, input.value);
    } catch (err) {
      throw new BridgeError(
        'INVALID_WORKFLOW_INPUT',
        `Invalid value for node "${input.nodeKey}": ` +
          (err instanceof Error ? err.message : String(err))
      );
    }

    if (structured.sha256 !== input.outputSha256) {
      throw new BridgeError(
        'INVALID_WORKFLOW_INPUT',
        `Output sha256 mismatch for node "${input.nodeKey}": expected ${input.outputSha256}, got ${structured.sha256}`
      );
    }

    const seenArtifacts = new Set<string>();
    const detachedArtifacts: ArtifactReference[] = [];

    for (const art of input.artifacts) {
      let norm: string;
      try {
        norm = validArtifactRelative(art.path);
      } catch (err) {
        throw new BridgeError(
          'INVALID_WORKFLOW_INPUT',
          `Invalid artifact path in node "${input.nodeKey}": ` +
            (err instanceof Error ? err.message : String(err))
        );
      }

      const key = norm;
      if (seenArtifacts.has(key)) {
        throw new BridgeError(
          'INVALID_WORKFLOW_INPUT',
          `Duplicate artifact path "${norm}" in node "${input.nodeKey}"`
        );
      }
      seenArtifacts.add(key);

      detachedArtifacts.push({
        path: norm,
        sha256: art.sha256,
        bytes: art.bytes,
      });
    }

    detachedInputs.push({
      nodeKey: input.nodeKey,
      taskId: input.taskId,
      outputSha256: input.outputSha256,
      value: structured.value,
      artifacts: detachedArtifacts,
    });
  }

  const payload = { inputs: detachedInputs };
  const text = JSON.stringify(payload);
  const bytes = Buffer.byteLength(text, 'utf8');

  if (bytes > MAX_WORKFLOW_CONTEXT_BYTES) {
    throw new BridgeError(
      'WORKFLOW_CONTEXT_TOO_LARGE',
      `Workflow context size (${bytes} bytes) exceeds limit of ${MAX_WORKFLOW_CONTEXT_BYTES} bytes`
    );
  }

  const sha256 = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

  return { text, sha256, bytes };
}
