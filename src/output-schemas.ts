import { z } from 'zod';
import { resolvedAgentPolicySchema, nativeToolsSchema, mcpSelectionSchema, mcpCatalogToolSchema } from './agent-policy.js';
import { bridgeMessageSchema, deliveryModeSchema } from './messages.js';
import { stagedSkillsSchema } from './skills.js';
import { criterionSchema, reviewEvidenceSchema } from './verification.js';
import { plannerReportSchema, reviewerReportSchema, roleSchema, builtinRoleSchema, roleDefinitionSchema, effortSchema } from './roles.js';
import { usageCountersSchema } from './usage.js';
import { toolProfileSchema } from './tool-profiles.js';
import { handoffSchema } from './handoff.js';
import { comparisonSchema, comparisonFindingSchema } from './comparison.js';
import { sandboxPolicySchema, sandboxSelectionSchema } from './sandbox-policy.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().uuid();
const count = z.number().int().nonnegative();
const timestamp = z.string().datetime();
const status = z.enum(['queued', 'starting', 'running', 'streaming', 'completed', 'failed', 'cancelled', 'timeout']);
const verificationStatus = z.enum(['passed', 'failed', 'unverified']);
const portableNodeIdentity = z.object({ buildId: z.string(), nodeVersion: z.string(), libuvVersion: z.string(), sha256: hash }).strict();
export const testEvidenceSchema = z.object({
  command: z.string(), exitCode: z.number().int().min(0).max(0xffffffff), output: z.string(), sha256: hash, beforeSha256: hash.optional(), recordedAt: timestamp,
  source: z.enum(['client-reported', 'agy-tool', 'windows-executor']), treeSha256: hash.optional(), beforeTreeSha256: hash.optional(),
  executionError: z.string().optional(), truncated: z.boolean().optional(), attempt: count.optional(),
  testTaskId: id.optional(), sandbox: z.enum(['agy-native-requested', 'windows-lpac']).optional(),
  sandboxSelection: sandboxSelectionSchema.optional(), sandboxPolicySha256: hash.optional(),
  portableNode: portableNodeIdentity.optional(),
}).strict();
const verification = z.object({
  sha256: hash, checkedAt: timestamp, status: verificationStatus,
  checks: z.array(z.object({ criterionId: z.string(), status: verificationStatus, observation: z.string() }).strict()),
  review: z.object({ source: z.literal('client-reported'), evidence: z.array(reviewEvidenceSchema) }).strict(),
  fileHashes: z.record(z.string(), hash.nullable()),
}).strict();
const tokenUsage = z.object({
  scope: z.literal('task'), source: z.enum(['session-total', 'session-delta', 'local-executor', 'unavailable']),
  counters: usageCountersSchema, available: z.boolean(), partial: z.boolean(), warnings: z.array(z.string()),
}).strict();
const report = z.discriminatedUnion('role', [
  z.object({ role: z.literal('planner'), source: z.literal('agy-reported'), data: plannerReportSchema }).strict(),
  z.object({ role: z.literal('reviewer'), source: z.literal('agy-reported'), data: reviewerReportSchema, citationsChecked: z.literal(true) }).strict(),
]);
export const taskRecordSchema = z.object({
  deliveryMode: deliveryModeSchema.optional(),
  providedSkills: stagedSkillsSchema.optional(),
  taskId: id, workingDirectory: z.string(), status, createdAt: timestamp,
  prompt: z.string().optional(), sessionId: z.string().optional(), pid: z.number().int().positive().optional(),
  model: z.string().optional(), startedAt: timestamp.optional(), completedAt: timestamp.optional(),
  exitCode: z.number().int().nullable().optional(), error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  usage: z.unknown().optional(), result: z.unknown().optional(), copyDirectory: z.string().optional(),
  includedFiles: z.array(z.string()).optional(), integratedAt: timestamp.optional(), discardedAt: timestamp.optional(),
  mode: z.enum(['write', 'read-only']).optional(), tests: z.array(testEvidenceSchema).optional(),
  acceptanceCriteria: z.array(criterionSchema).optional(), verification: verification.optional(), role: roleSchema.optional(),
  report: report.optional(), usageIsResume: z.boolean().optional(), usageBaseline: usageCountersSchema.optional(), tokenUsage: tokenUsage.optional(),
  usageProvenance: z.literal('local-executor').optional(), lastObservedCliUsage: usageCountersSchema.optional(),
  handoff: handoffSchema.optional(),
  comparison: comparisonSchema.optional(),
  roleDefinition: roleDefinitionSchema.optional(),
  continuationTaskId: id.optional(),
  parentTaskId: id.optional(),
  providedSkillSummaries: z.array(z.object({name: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), fileCount: count}).strict()).max(8).optional(),
  effort: effortSchema.optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  artifactPaths: z.array(z.string()).optional(),
  structuredResult: z.object({ value: z.unknown(), sha256: hash }).strict().optional(),
  artifacts: z.array(z.object({ path: z.string(), sha256: hash, bytes: count }).strict()).optional(),
  structuredResultSha256: hash.optional(),
  artifactCount: count.optional(),
  agentPolicy: resolvedAgentPolicySchema.optional(),
  agentPolicyReceipt: z.object({ sha256: hash, decisionCount: count, deniedCount: count }).strict().optional(),
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
const sandboxPolicySnapshot = z.object({ version: z.literal(1), policy: sandboxPolicySchema, sha256: hash }).strict();

export const successOutputSchemas = {
  antigravity_health: z.object({
    toolProfile: toolProfileSchema.optional(),
    installed: z.boolean(), path: z.string(), version: z.string().optional(), authenticated: z.boolean().nullable(),
    capabilities: z.object({
      structuredOutput: z.boolean(), streaming: z.boolean(), sandbox: z.boolean(), readOnlyMode: z.boolean(),
      models: z.boolean(), modelSelection: z.boolean(), resume: z.boolean(), sessionsList: z.boolean(), cancel: z.boolean(),
    }).strict(), error: z.string().optional(),
    integrationApproval: z.object({ available: z.boolean(), method: z.enum(['mcp-form-elicitation', 'project-preauthorization-or-mcp-form']), preauthorizedProjectCount: count.optional() }).strict(),
    bridgeLimitations: z.object({
      interactiveReplies: z.object({ available: z.literal(false), reason: z.string() }).strict(),
      preflightTokenCount: z.object({ available: z.literal(false), exactTokens: z.null(), reason: z.string() }).strict(),
    }).strict().optional(),
    windowsRuntime: z.object({ requestedMode: z.enum(['system', 'portable']), supported: z.boolean(), ready: z.boolean(), buildId: z.string(),
      nodeVersion: z.string(), libuvVersion: z.string(), sha256: hash.nullable(), error: z.object({ code: z.string(), message: z.string() }).strict().optional() }).strict().optional(),
  }).strict(),
  antigravity_list_models: z.object({ models: z.array(z.object({ id: z.string(), name: z.string() }).strict()) }).strict(),
  antigravity_get_agent_policy: z.object({ allowedTools: nativeToolsSchema, mcpServers: z.array(z.object({ id: z.string(), description: z.string().nullable(), nativeServerName: z.string(), tools: z.array(mcpCatalogToolSchema) }).strict()).max(20) }).strict(),
  antigravity_get_model: z.object({ model: z.string().nullable() }).strict(),
  antigravity_get_sandbox_policy: sandboxPolicySnapshot,
  antigravity_roles: z.object({ roles: z.array(z.object({ name: roleSchema, baseRole: builtinRoleSchema,
    description: z.string().nullable(), custom: z.boolean(), instructionChars: count,
    defaultModel: z.string().nullable().optional(), defaultEffort: effortSchema.optional(),
    defaultTimeoutSeconds: z.number().int().min(1).max(86400).optional(), defaultDeliveryMode: deliveryModeSchema.optional(),
    defaultIncludePaths: z.array(z.string()).optional(), defaultArtifactPaths: z.array(z.string()).optional(),
    defaultSkillSummaries: z.array(z.object({ name: z.string(), sha256: hash, resourceCount: count }).strict()).optional(),
    defaultAllowedTools: nativeToolsSchema.optional(), defaultMcpServers: mcpSelectionSchema.optional(),
    outputSchemaSha256: hash.optional() }).strict()) }).strict(),
  antigravity_set_model: z.object({ model: z.string().nullable() }).strict(),
  antigravity_set_sandbox_policy: sandboxPolicySnapshot,
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
    handoffAvailable: z.boolean().optional(), roleDefinitionAvailable: z.boolean().optional(),
    structuredResultAvailable: z.boolean().optional(), artifactCount: count.optional(),
  }).strict(),
  antigravity_wait: z.object({
    taskId: id, status, ready: z.boolean(), timedOut: z.boolean(), tokenUsage: tokenUsage.optional(),
    deliveryMode: deliveryModeSchema.optional(), cursorReset: z.boolean().optional(), messages: z.array(bridgeMessageSchema).max(50).optional(),
    events: z.array(z.object({ taskId: id, sequence: z.number().int().positive(), timestamp, type: z.string(), data: z.unknown(), raw: z.unknown().optional() }).strict()).optional(),
    continuationTaskId: id.optional(), continuationPending: z.boolean().optional(),
    nextCursor: count, oldestAvailable: z.number().int().positive(), truncated: z.boolean(),
  }).strict().refine(value => value.deliveryMode === 'messages' ? Array.isArray(value.messages) && value.events === undefined : Array.isArray(value.events) && value.messages === undefined, 'Delivery mode must match its payload')
    .meta({ anyOf: [{ properties: { deliveryMode: { const: 'messages' } }, required: ['deliveryMode', 'messages'], not: { required: ['events'] } },
      { properties: { deliveryMode: { const: 'events' } }, required: ['events'], not: { required: ['messages'] } }] }),
  antigravity_set_delivery_mode: z.object({ taskId: id, deliveryMode: deliveryModeSchema }).strict(),
  antigravity_cancel: task,
  antigravity_sessions: z.object({ sessions: z.array(z.object({ sessionId: z.string(), taskIds: z.array(id) }).strict()), scope: z.literal('local bridge state') }).strict(),
  antigravity_send_message: z.object({
    receipt: z.object({
      messageId: id,
      taskId: id,
      state: z.enum(['queued', 'sent', 'failed', 'cancelled']),
      continuationTaskId: id.optional(),
      error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
    }).strict(),
  }).strict(),
  antigravity_read_structured_result: z.object({
    taskId: id, ...chunkShape,
  }).strict(),
  antigravity_artifacts: z.object({
    taskId: id,
    artifacts: z.array(z.object({
      path: z.string(),
      sha256: hash,
      bytes: count,
    }).strict()),
  }).strict(),
  antigravity_read_artifact: z.object({
    taskId: id,
    path: z.string(),
    sha256: hash,
    bytes: count,
    offset: count,
    nextOffset: count,
    hasMore: z.boolean(),
    encoding: z.literal('base64'),
    content: z.string(),
    offsetUnit: z.literal('bytes'),
  }).strict(),
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
