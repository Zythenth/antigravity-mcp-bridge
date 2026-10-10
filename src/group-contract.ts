import { z } from 'zod';
import { createHash } from 'node:crypto';
import { profileDefaultsSchema, roleSchema } from './roles.js';
import { criteriaSchema } from './verification.js';
import { validateGroupGraph, GroupNodeStatus } from './task-groups.js';

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
}).strict().superRefine((definition, ctx) => {
  try { validateGroupGraph({ nodes: definition.jobs.map(({ key, owner, dependsOn }) => ({ key, owner, dependsOn })) }); }
  catch { ctx.addIssue({ code: 'custom', message: 'Invalid group dependency graph' }); }
  if (Buffer.byteLength(JSON.stringify(definition), 'utf8') > 4 * 1024 * 1024) ctx.addIssue({ code: 'custom', message: 'Group definition exceeds 4 MiB' });
});
export type GroupDefinition = z.infer<typeof groupDefinitionSchema>;
export function groupDefinitionSha256(definition: GroupDefinition): string {
  return createHash('sha256').update(JSON.stringify(groupDefinitionSchema.parse(definition))).digest('hex');
}
export const groupStateSchema = z.enum(['created', 'running', 'paused', 'completed', 'failed', 'cancelled']);
export const groupNodeRecordSchema = z.object({
  state: z.lazy(() => GroupNodeStatus), taskId: z.string().uuid().optional(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
}).strict();
export const groupRecordSchema = z.object({
  version: z.literal(1), groupId: z.string().uuid(), definitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  definition: groupDefinitionSchema, profiles: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  nodes: z.record(z.string(), groupNodeRecordSchema), state: groupStateSchema,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  ownerPid: z.number().int().positive().optional(), ownerId: z.string().uuid().optional(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
}).strict();
export type GroupRecord = z.infer<typeof groupRecordSchema>;
export const groupSummarySchema = z.object({
  groupId: z.string().uuid(), definitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  workingDirectory: z.string(), title: z.string(), state: groupStateSchema,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), resumeRequired: z.boolean(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  nodes: z.array(z.object({
    key: z.string(), owner: roleSchema, dependsOn: z.array(z.string()), ...groupNodeRecordSchema.shape,
  }).strict()).max(32),
}).strict();
export function summarizeGroup(record: GroupRecord, resumeRequired = record.state === 'paused') {
  return groupSummarySchema.parse({
    groupId: record.groupId, definitionSha256: record.definitionSha256,
    workingDirectory: record.definition.workingDirectory, title: record.definition.title, state: record.state,
    createdAt: record.createdAt, updatedAt: record.updatedAt, resumeRequired, error: record.error,
    nodes: record.definition.jobs.map(({ key, owner, dependsOn }) => ({ key, owner, dependsOn, ...record.nodes[key]! })),
  });
}
