import { z } from 'zod';
import { criterionSchema, reviewEvidenceSchema } from './verification.js';
import { plannerReportSchema, reviewerReportSchema, roleSchema } from './roles.js';
import { usageCountersSchema } from './usage.js';
import { toolProfileSchema } from './tool-profiles.js';
import { handoffSchema } from './handoff.js';
import { comparisonSchema, comparisonFindingSchema } from './comparison.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().uuid();
const count = z.number().int().nonnegative();
const timestamp = z.string().datetime();
const status = z.enum(['queued', 'starting', 'running', 'streaming', 'completed', 'failed', 'cancelled', 'timeout']);
const verificationStatus = z.enum(['passed', 'failed', 'unverified']);
export const testEvidenceSchema = z.object({
  command: z.string(), exitCode: z.number().int().min(0).max(255), output: z.string(), sha256: hash, recordedAt: timestamp,
  source: z.enum(['client-reported', 'agy-tool']), treeSha256: hash.optional(), beforeTreeSha256: hash.optional(),
  executionError: z.string().optional(), truncated: z.boolean().optional(), attempt: count.optional(),
  testTaskId: id.optional(), sandbox: z.literal('agy-native-requested').optional(),
}).strict();
const verification = z.object({
  sha256: hash, checkedAt: timestamp, status: verificationStatus,
  checks: z.array(z.object({ criterionId: z.string(), status: verificationStatus, observation: z.string() }).strict()),
  review: z.object({ source: z.literal('client-reported'), evidence: z.array(reviewEvidenceSchema) }).strict(),
  fileHashes: z.record(z.string(), hash.nullable()),
}).strict();
const tokenUsage = z.object({
  scope: z.literal('task'), source: z.enum(['session-total', 'session-delta', 'unavailable']),
  counters: usageCountersSchema, available: z.boolean(), partial: z.boolean(), warnings: z.array(z.string()),
}).strict();
const report = z.discriminatedUnion('role', [
  z.object({ role: z.literal('planner'), source: z.literal('agy-reported'), data: plannerReportSchema }).strict(),
  z.object({ role: z.literal('reviewer'), source: z.literal('agy-reported'), data: reviewerReportSchema, citationsChecked: z.literal(true) }).strict(),
]);
export const taskRecordSchema = z.object({
  taskId: id, workingDirectory: z.string(), status, createdAt: timestamp,
  prompt: z.string().optional(), sessionId: z.string().optional(), pid: z.number().int().positive().optional(),
  model: z.string().optional(), startedAt: timestamp.optional(), completedAt: timestamp.optional(),
  exitCode: z.number().int().nullable().optional(), error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  usage: z.unknown().optional(), result: z.unknown().optional(), copyDirectory: z.string().optional(),
  includedFiles: z.array(z.string()).optional(), integratedAt: timestamp.optional(), discardedAt: timestamp.optional(),
  mode: z.enum(['write', 'read-only']).optional(), tests: z.array(testEvidenceSchema).optional(),
  acceptanceCriteria: z.array(criterionSchema).optional(), verification: verification.optional(), role: roleSchema.optional(),
  report: report.optional(), usageIsResume: z.boolean().optional(), usageBaseline: usageCountersSchema.optional(), tokenUsage: tokenUsage.optional(),
  handoff: handoffSchema.optional(),
  comparison: comparisonSchema.optional(),
}).strict();
const task = z.object({ task: taskRecordSchema }).strict();
const file = z.object({ status: z.enum(['A', 'M', 'D']), path: z.string() }).strict();
const fileSummary = file.extend({ insertions: count.nullable(), deletions: count.nullable(), binary: z.boolean() });
const previewShape = {
  files: z.array(file), fileSummaries: z.array(fileSummary),
  summary: z.object({ filesChanged: count, added: count, modified: count, deleted: count, insertions: count, deletions: count, binaryFiles: count }).strict(),
  patch: z.string(), sha256: hash, sourceDirectory: z.string(), copyDirectory: z.string(),
};
const chunkShape = {
  text: z.string(), offset: count, length: count, totalLength: count, nextOffset: count,
  hasMore: z.boolean(), contentSha256: hash, offsetUnit: z.literal('utf16-code-units'),
};
const usageRow = z.object({ taskId: id, sessionId: z.string().nullable(), model: z.string().nullable(), status, ...tokenUsage.shape }).strict();

export const successOutputSchemas = {
  antigravity_health: z.object({
    toolProfile: toolProfileSchema.optional(),
    installed: z.boolean(), path: z.string(), version: z.string().optional(), authenticated: z.boolean().nullable(),
    capabilities: z.object({
      structuredOutput: z.boolean(), streaming: z.boolean(), sandbox: z.boolean(), readOnlyMode: z.boolean(),
      models: z.boolean(), modelSelection: z.boolean(), resume: z.boolean(), sessionsList: z.boolean(), cancel: z.boolean(),
    }).strict(), error: z.string().optional(),
    integrationApproval: z.object({ available: z.boolean(), method: z.literal('mcp-form-elicitation') }).strict(),
  }).strict(),
  antigravity_list_models: z.object({ models: z.array(z.object({ id: z.string(), name: z.string() }).strict()) }).strict(),
  antigravity_get_model: z.object({ model: z.string().nullable() }).strict(),
  antigravity_set_model: z.object({ model: z.string().nullable() }).strict(),
  antigravity_usage: z.object({
    scope: z.literal('retained-tasks'), taskCount: count, measuredTaskCount: count, counters: usageCountersSchema, byTask: z.array(usageRow),
    byModel: z.array(z.object({ model: z.string().nullable(), taskCount: count, counters: usageCountersSchema }).strict()),
    bySession: z.array(z.object({ sessionId: z.string(), taskCount: count, counters: usageCountersSchema, observedCumulative: usageCountersSchema.nullable() }).strict()),
  }).strict(),
  antigravity_list_project_files: z.object({ files: z.array(z.string()) }).strict(),
  antigravity_run: task,
  antigravity_resume: task,
  antigravity_handoff: task,
  antigravity_context: z.object({ taskId: id, treeSha256: hash, role: roleSchema, report: report.nullable(), handoff: handoffSchema.nullable(),
    acceptanceCriteria: z.array(criterionSchema), includedFiles: z.array(z.string()) }).strict(),
  antigravity_compare: z.object({ comparisonId: id, taskIds: z.array(id), models: comparisonSchema.shape.models,
    startErrors: comparisonSchema.shape.startErrors }).strict(),
  antigravity_comparison: comparisonSchema.extend({
    ready: z.boolean(), complete: z.boolean(), missingModels: z.array(z.string()), contextStale: z.boolean(),
    opinions: z.array(z.object({ taskId: id, model: z.string(), status, contextMatches: z.boolean().nullable(), report: report.nullable(),
      error: z.object({ code: z.string(), message: z.string() }).strict().nullable(), tokenUsage: tokenUsage.optional() }).strict()),
    findings: z.array(comparisonFindingSchema), warnings: z.array(z.string()),
  }).strict(),
  antigravity_preview: z.object({
    ...previewShape, patch: z.string().optional(), patchLength: count,
    tests: z.array(testEvidenceSchema.extend({ stale: z.boolean() })),
    verification: verification.extend({ stale: z.boolean() }).nullable(),
  }).strict(),
  antigravity_read_patch: z.object({ taskId: id, sha256: hash, path: z.string().nullable(), ...chunkShape }).strict(),
  antigravity_read_result: z.object({
    ready: z.boolean(), taskId: id, status,
    text: z.string().optional(), offset: count.optional(), length: count.optional(), totalLength: count.optional(),
    nextOffset: count.optional(), hasMore: z.boolean().optional(), contentSha256: hash.optional(), offsetUnit: z.literal('utf16-code-units').optional(),
  }).strict().refine(value => !value.ready || Object.keys(chunkShape).every(key => value[key as keyof typeof value] !== undefined), 'Ready results require all chunk fields')
    .meta({ allOf: [{ if: { properties: { ready: { const: true } }, required: ['ready'] }, then: { required: Object.keys(chunkShape) } }] }),
  antigravity_verify: verification,
  antigravity_test: task,
  antigravity_record_test: testEvidenceSchema,
  antigravity_integrate: z.object(previewShape).strict(),
  antigravity_discard: task,
  antigravity_cleanup: z.object({ discardedTaskIds: z.array(id) }).strict(),
  antigravity_status: task,
  antigravity_tasks: z.object({ tasks: z.array(taskRecordSchema) }).strict(),
  antigravity_events: z.object({
    events: z.array(z.object({ taskId: id, sequence: z.number().int().positive(), timestamp, type: z.string(), data: z.unknown(), raw: z.unknown().optional() }).strict()),
    nextCursor: count, oldestAvailable: z.number().int().positive(), truncated: z.boolean(),
  }).strict(),
  antigravity_result: z.object({
    task: taskRecordSchema, ready: z.boolean(), resultAvailable: z.boolean().optional(), reportAvailable: z.boolean().optional(), includedFileCount: count.optional(),
  }).strict(),
  antigravity_wait: z.object({
    taskId: id, status, ready: z.boolean(), timedOut: z.boolean(), tokenUsage: tokenUsage.optional(),
    events: z.array(z.object({ taskId: id, sequence: z.number().int().positive(), timestamp, type: z.string(), data: z.unknown(), raw: z.unknown().optional() }).strict()),
    nextCursor: count, oldestAvailable: z.number().int().positive(), truncated: z.boolean(),
  }).strict(),
  antigravity_cancel: task,
  antigravity_sessions: z.object({ sessions: z.array(z.object({ sessionId: z.string(), taskIds: z.array(id) }).strict()), scope: z.literal('local bridge state') }).strict(),
};

const errorResponse = z.object({ error: z.object({ code: z.string(), message: z.string() }).strict() }).strict();
function withError(schema: z.ZodObject) {
  const error = schema.shape.error ? z.union([schema.shape.error, errorResponse.shape.error]) : errorResponse.shape.error;
  return z.object(schema.shape).partial().extend({ error: error.optional() }).strict().superRefine((value, context) => {
    const checked = (typeof value.error === 'object' && value.error !== null ? errorResponse : schema).safeParse(value);
    if (!checked.success) context.addIssue({ code: 'custom', message: 'Response must match the success or error contract' });
  }).meta({ anyOf: [z.toJSONSchema(schema), z.toJSONSchema(errorResponse)] });
}
export const outputSchemas = Object.fromEntries(Object.entries(successOutputSchemas).map(([name, schema]) => [name, withError(schema)])) as
  Record<keyof typeof successOutputSchemas, ReturnType<typeof withError>>;
