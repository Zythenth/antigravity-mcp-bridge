import { workflowOptionsSchema, workflowCheckpointSchema, validateWorkflowOptions } from './workflows.js';
import { groupBudgetSchema, groupBudgetStatusSchema } from './group-budget.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { profileDefaultsSchema, roleSchema } from './roles.js';
import { criteriaSchema } from './verification.js';
import { validateGroupGraph, GroupNodeStatus } from './task-groups.js';
import {
  peerRoutesSchema,
  validatePeerRoutes,
  nodeKeySchema,
  peerMessageTextSchema,
} from './peer-messages.js';

export { peerRoutesSchema };

export const groupAdmissionSchema = z.object({
  groupId: z.string().uuid(), nodeKey: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), owner: roleSchema,
  definitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const groupAssignmentSchema = groupAdmissionSchema.extend({ rootTaskId: z.string().uuid() });
export type GroupAssignment = z.infer<typeof groupAssignmentSchema>;
export type GroupAdmission = z.infer<typeof groupAdmissionSchema>;
export const groupTaskInputSchema = z.lazy(() => profileDefaultsSchema.extend({
  deliveryMode: z.literal('messages').optional(),
  prompt: z.string().min(1).max(1000000), mode: z.enum(['write', 'read-only']).optional(),
  acceptanceCriteria: criteriaSchema.optional(),
}).strict());
export const groupDefinitionSchema = z.object({
  workingDirectory: z.string().min(1), title: z.string().min(1).max(200),
  jobs: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), owner: roleSchema,
    dependsOn: z.array(z.string()).max(31), task: groupTaskInputSchema,
  }).strict()).min(1).max(32),
  peerRoutes: peerRoutesSchema.optional(),
  budget: groupBudgetSchema.optional(),
  workflow: workflowOptionsSchema.optional(),
}).strict().superRefine((definition, ctx) => {
  try { validateGroupGraph({ nodes: definition.jobs.map(({ key, owner, dependsOn }) => ({ key, owner, dependsOn })) }); }
  catch { ctx.addIssue({ code: 'custom', message: 'Invalid group dependency graph' }); }
  if (definition.peerRoutes !== undefined) {
    try {
      validatePeerRoutes(
        { nodes: definition.jobs.map(({ key, owner, dependsOn }) => ({ key, owner, dependsOn })) },
        definition.peerRoutes
      );
    } catch (err: unknown) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof Error ? err.message : 'Invalid peer routes',
        path: ['peerRoutes'],
      });
    }
  }
  if (definition.workflow) {
    try { validateWorkflowOptions({ nodes: definition.jobs.map(({ key, owner, dependsOn }) => ({ key, owner, dependsOn })) }, definition.workflow); }
    catch { ctx.addIssue({ code: 'custom', message: 'Invalid workflow synthesis graph or hooks' }); }
    if (definition.jobs.some(job => !job.task.acceptanceCriteria?.length)) ctx.addIssue({ code: 'custom', message: 'Every workflow step requires acceptance criteria' });
  }
  if (Buffer.byteLength(JSON.stringify(definition), 'utf8') > 4 * 1024 * 1024) ctx.addIssue({ code: 'custom', message: 'Group definition exceeds 4 MiB' });
});
export type GroupDefinition = z.infer<typeof groupDefinitionSchema>;
export function groupDefinitionSha256(definition: GroupDefinition): string {
  return createHash('sha256').update(JSON.stringify(groupDefinitionSchema.parse(definition))).digest('hex');
}
export const groupStateSchema = z.enum(['created', 'running', 'paused', 'completed', 'failed', 'cancelled']);
export const groupNodeRecordSchema = z.object({
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  checkpoint: z.object({ data: z.lazy(() => workflowCheckpointSchema), sha256: z.string().regex(/^[a-f0-9]{64}$/), phase: z.enum(['validated','pending-review','pending-tests']) }).strict().optional(),
  state: z.lazy(() => GroupNodeStatus), taskId: z.string().uuid().optional(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
}).strict();

export const peerDeliveryStateSchema = z.enum(['pending', 'queued', 'sent', 'failed', 'cancelled']);
export type PeerDeliveryState = z.infer<typeof peerDeliveryStateSchema>;

export const peerDeliverySchema = z.object({
  sourceTaskId: z.string().uuid(),
  sourceNode: nodeKeySchema,
  messageId: z.string().uuid(),
  toNode: nodeKeySchema,
  text: peerMessageTextSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  transportId: z.string().uuid(),
  targetTaskId: z.string().uuid().optional(),
  state: peerDeliveryStateSchema,
  continuationTaskId: z.string().uuid().optional(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
}).strict().superRefine((delivery, ctx) => {
  if (typeof delivery.text === 'string') {
    const expectedSha256 = createHash('sha256').update(delivery.text, 'utf8').digest('hex');
    if (delivery.sha256 !== expectedSha256) {
      ctx.addIssue({
        code: 'custom',
        message: 'sha256 must match SHA256 of UTF8 text',
        path: ['sha256'],
      });
    }
  }
  if ((delivery.state === 'queued' || delivery.state === 'sent') && !delivery.targetTaskId) {
    ctx.addIssue({
      code: 'custom',
      message: `State "${delivery.state}" requires targetTaskId`,
      path: ['targetTaskId'],
    });
  }
  if (delivery.state === 'sent' && !delivery.continuationTaskId) {
    ctx.addIssue({
      code: 'custom',
      message: 'State "sent" requires continuationTaskId',
      path: ['continuationTaskId'],
    });
  }
});
export type PeerDelivery = z.infer<typeof peerDeliverySchema>;

export const peerReceiptSchema = z.object({
  messageId: z.string().uuid(),
  sourceTaskId: z.string().uuid(),
  fromNode: nodeKeySchema,
  toNode: nodeKeySchema,
  state: peerDeliveryStateSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  continuationTaskId: z.string().uuid().optional(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  source: z.literal('agy-reported'),
}).strict();
export type PeerReceipt = z.infer<typeof peerReceiptSchema>;

export const peerReceiptsPageSchema = z.object({
  receipts: z.array(peerReceiptSchema).max(20),
  nextCursor: z.number().int().nonnegative().safe(),
  hasMore: z.boolean(),
}).strict();
export type PeerReceiptsPage = z.infer<typeof peerReceiptsPageSchema>;

export const groupRecordSchema = z.object({
  version: z.literal(1), groupId: z.string().uuid(), definitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  definition: groupDefinitionSchema, profiles: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  nodes: z.record(z.string(), groupNodeRecordSchema), state: groupStateSchema,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  ownerPid: z.number().int().positive().optional(), ownerId: z.string().uuid().optional(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  peerDeliveries: z.array(peerDeliverySchema).max(100).optional(),
}).strict().superRefine((record, ctx) => {
  if (record.peerDeliveries !== undefined) {
    const seenLogical = new Set<string>();
    const seenTransport = new Set<string>();
    for (let i = 0; i < record.peerDeliveries.length; i++) {
      const delivery = record.peerDeliveries[i]!;
      if (typeof delivery.sourceTaskId === 'string' && typeof delivery.messageId === 'string') {
        const logicalKey = `${delivery.sourceTaskId.toLowerCase()}:${delivery.messageId.toLowerCase()}`;
        if (seenLogical.has(logicalKey)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate peer delivery logical ID: ${delivery.sourceTaskId}:${delivery.messageId}`,
            path: ['peerDeliveries', i],
          });
        }
        seenLogical.add(logicalKey);
      }
      if (typeof delivery.transportId === 'string') {
        const transportKey = delivery.transportId.toLowerCase();
        if (seenTransport.has(transportKey)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate peer delivery transport ID: ${delivery.transportId}`,
            path: ['peerDeliveries', i],
          });
        }
        seenTransport.add(transportKey);
      }
    }
  }
});
export type GroupRecord = z.infer<typeof groupRecordSchema>;
export const groupSummarySchema = z.object({
  budget: groupBudgetStatusSchema.optional(),
  workflow: z.object({ finalNode: z.string(), fileSources: z.record(z.string(), z.string()).optional() }).strict().optional(),
  groupId: z.string().uuid(), definitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  workingDirectory: z.string(), title: z.string(), state: groupStateSchema,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), resumeRequired: z.boolean(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  nodes: z.array(z.object({
    key: z.string(), owner: roleSchema, dependsOn: z.array(z.string()),
    state: z.lazy(() => GroupNodeStatus), taskId: z.string().uuid().optional(),
    error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    checkpoint: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), phase: z.enum(['validated','pending-review','pending-tests']),
      taskId: z.string().uuid(), outputSha256: z.string().regex(/^[a-f0-9]{64}$/), artifactCount: z.number().int().nonnegative() }).strict().optional(),
  }).strict()).max(32),
}).strict();
export function summarizeGroup(record: GroupRecord, resumeRequired = record.state === 'paused') {
  return groupSummarySchema.parse({
    groupId: record.groupId, definitionSha256: record.definitionSha256,
    ...(record.definition.workflow ? { workflow: { finalNode: record.definition.workflow.finalNode, ...(record.definition.workflow.fileSources ? { fileSources: record.definition.workflow.fileSources } : {}) } } : {}),
    workingDirectory: record.definition.workingDirectory, title: record.definition.title, state: record.state,
    createdAt: record.createdAt, updatedAt: record.updatedAt, resumeRequired, error: record.error,
    nodes: record.definition.jobs.map(({ key, owner, dependsOn }) => {
      const { checkpoint, ...node } = record.nodes[key]!;
      return { key, owner, dependsOn, ...node, ...(checkpoint ? { checkpoint: { sha256: checkpoint.sha256, phase: checkpoint.phase,
        taskId: checkpoint.data.taskId, outputSha256: checkpoint.data.outputSha256, artifactCount: checkpoint.data.artifacts.length } } : {}) };
    }),
  });
}
