import { z } from 'zod';
import { roleSchema, plannerReportSchema, reviewerReportSchema } from './roles.js';
import { criterionSchema } from './verification.js';

export const decisionsSchema = z.array(z.string().min(1).max(2000)).max(20);
export const handoffSchema = z.object({
  sourceTaskId: z.string().uuid(), sourceRole: roleSchema, sourceModel: z.string().nullable(),
  treeSha256: z.string().regex(/^[a-f0-9]{64}$/), patchSha256: z.string().regex(/^[a-f0-9]{64}$/),
  decisions: z.object({ source: z.literal('client-reported'), items: decisionsSchema }).strict(),
  files: z.array(z.string().min(1).max(1000)).max(10000),
  acceptanceCriteria: z.array(criterionSchema).max(100),
  reports: z.array(z.object({ taskId: z.string().uuid(), role: z.enum(['planner', 'reviewer']),
    data: z.union([plannerReportSchema, reviewerReportSchema]) }).strict()).max(8),
  tests: z.array(z.object({ command: z.string(), exitCode: z.number().int(), source: z.enum(['client-reported', 'agy-tool', 'windows-executor']),
    sha256: z.string(), stale: z.boolean() }).strict()).max(20),
}).strict();
export type HandoffContext = z.infer<typeof handoffSchema>;
