import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CliAdapter } from './cli-adapter.js';
import { TaskManager } from './task-manager.js';
import { BridgeError } from './types.js';
import { listProjectFiles } from './isolation.js';
import { criteriaSchema, reviewSchema } from './verification.js';
import { testCommandSchema } from './native-tests.js';

function response(value: unknown) {
  const structuredContent = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value };
  return { structuredContent, content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function failure(error: unknown) {
  const code = error instanceof BridgeError ? error.code : 'AGY_PROCESS_FAILED';
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, ...response({ error: { code, message } }) };
}

function safe<T>(operation: () => Promise<T> | T) {
  return async () => {
    try { return response(await operation()); }
    catch (error) { return failure(error); }
  };
}

export function createMcpServer(adapter: CliAdapter, tasks: TaskManager): McpServer {
  const server = new McpServer({ name: 'antigravity-mcp-bridge', version: '0.3.0' }, {
    instructions: 'Tasks run with agy --sandbox in a temporary copy. The copy excludes .gitignore and .git/info/exclude matches by default; includePaths can narrow it. Use read-only mode for consultations. Review antigravity_preview and actual tests before integration. antigravity_integrate requests confirmation through MCP form elicitation, bound to the reviewed SHA-256; clients without form support cannot integrate. A tool argument or patch hash does not constitute approval. The original project is not modified by antigravity_run.',
  });
  const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
  const action = { readOnlyHint: false, openWorldHint: true, destructiveHint: true };

  server.registerTool('antigravity_health', {
    title: 'Check Antigravity CLI', description: 'Inspect installed agy version, authentication and supported capabilities.',
    inputSchema: {}, annotations: readOnly,
  }, safe(async () => ({ ...await adapter.health(), integrationApproval: { available: Boolean(server.server.getClientCapabilities()?.elicitation?.form), method: 'mcp-form-elicitation' } })));

  server.registerTool('antigravity_list_models', {
    title: 'List Antigravity models', description: 'List model IDs actually returned by agy models for this account.',
    inputSchema: {}, annotations: readOnly,
  }, safe(async () => ({ models: await adapter.listModels() })));

  server.registerTool('antigravity_get_model', {
    title: 'Get selected model', description: 'Return the default model selected for subsequent bridge tasks. Null means agy chooses its own default.',
    inputSchema: {}, annotations: readOnly,
  }, safe(() => ({ model: tasks.getModel() ?? null })));

  server.registerTool('antigravity_list_project_files', {
    title: 'List files eligible for a project copy', description: 'List tracked and untracked files excluding Git ignore and local exclude matches.',
    inputSchema: { workingDirectory: z.string().min(1) }, annotations: readOnly,
  }, async ({ workingDirectory }) => safe(async () => ({ files: await listProjectFiles(workingDirectory) }))());

  server.registerTool('antigravity_set_model', {
    title: 'Select Antigravity model', description: 'Select an exact model ID from agy models as the bridge default. Does not alter agy global settings.',
    inputSchema: { model: z.string().min(1).max(128) }, annotations: { ...readOnly, readOnlyHint: false },
  }, async ({ model }) => safe(async () => ({ model: await tasks.setModel(model) }))());

  const runSchema = {
    prompt: z.string().min(1),
    model: z.string().min(1).max(128).optional(),
    workingDirectory: z.string().min(1),
    sessionId: z.string().min(1).max(128).optional(),
    timeoutSeconds: z.number().int().min(1).max(86400).optional(),
    isolateWorktree: z.boolean().optional(),
    includePaths: z.array(z.string().min(1)).min(1).optional(),
    mode: z.enum(['write', 'read-only']).optional(),
    acceptanceCriteria: criteriaSchema.optional(),
  };
  server.registerTool('antigravity_run', {
    title: 'Run Antigravity task', description: 'Copy non-ignored project files to a temporary directory and run agy --sandbox there. includePaths narrows copied files or folders. Returns a taskId; source is unchanged.',
    inputSchema: runSchema, annotations: action,
  }, async args => safe(async () => ({ task: await tasks.run(args) }))());

  server.registerTool('antigravity_resume', {
    title: 'Resume Antigravity conversation', description: 'Continue a completed session in its existing isolated copy.',
    inputSchema: { ...runSchema, sessionId: z.string().min(1).max(128) }, annotations: action,
  }, async args => safe(async () => ({ task: await tasks.run(args) }))());

  server.registerTool('antigravity_preview', {
    title: 'Preview isolated changes', description: 'Return A/M/D files, per-file line statistics, totals, binary markers, patch, SHA-256 and client-reported test evidence with stale markers. Requires a finished task.',
    inputSchema: { taskId: z.string().uuid(), includePatch: z.boolean().optional() }, annotations: readOnly,
  }, async ({ taskId, includePatch }) => safe(() => tasks.preview(taskId, includePatch))());

  const chunkInput = { offset: z.number().int().min(0).optional(), limit: z.number().int().min(2).max(50000).optional() };
  server.registerTool('antigravity_read_patch', {
    title: 'Read patch by file or chunk', description: 'Read at most 50000 UTF-16 units of the current patch, optionally selecting a changed path. Bind every read to the full preview hash. Follow nextOffset until hasMore is false. Use preview with includePatch false for metadata.',
    inputSchema: { taskId: z.string().uuid(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/), path: z.string().min(1).max(1000).optional(), ...chunkInput }, annotations: readOnly,
  }, async ({ taskId, expectedSha256, path, offset, limit }) => safe(() => tasks.readPatch(taskId, expectedSha256, path, offset, limit))());

  server.registerTool('antigravity_read_result', {
    title: 'Read result in chunks', description: 'Read the final CLI result serialized as JSON in bounded chunks. Returns ready false while active. Keep contentSha256 for subsequent requests and reconstruct the JSON by concatenating text.',
    inputSchema: { taskId: z.string().uuid(), expectedContentSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), ...chunkInput }, annotations: readOnly,
  }, async ({ taskId, offset, limit, expectedContentSha256 }) => safe(() => tasks.readResult(taskId, offset, limit, expectedContentSha256))());

  server.registerTool('antigravity_verify', {
    title: 'Verify task acceptance criteria', description: 'Check actual artifacts and ground Codex review quotes in file lines. Requires criteria defined before the task. A CLI SUCCESS or unsupported claim is not verification; client review remains client-reported.',
    inputSchema: { taskId: z.string().uuid(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/), reviews: reviewSchema.optional() }, annotations: { ...readOnly, readOnlyHint: false },
  }, async ({ taskId, expectedSha256, reviews }) => safe(() => tasks.verify(taskId, expectedSha256, reviews))());

  server.registerTool('antigravity_test', {
    title: 'Run tests in the native agy sandbox', description: 'Start an asynchronous continuation that executes an exact command through agy run_command. Captures actual output, exit status and file fingerprints. Optionally permits up to three repair retries. No Docker or host execution fallback. Use the returned taskId for events, result, review and integration.',
    inputSchema: { taskId: z.string().uuid(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/), command: testCommandSchema,
      retries: z.number().int().min(0).max(3).optional(), timeoutSeconds: z.number().int().min(1).max(86400).optional() }, annotations: action,
  }, async ({ taskId, expectedSha256, command, retries, timeoutSeconds }) => safe(async () => ({ task: await tasks.startTests(taskId, expectedSha256, command, retries, timeoutSeconds) }))());

  server.registerTool('antigravity_record_test', {
    title: 'Record review test evidence', description: 'Record a test already executed by the client in the isolated copy. Bind command, exit code and output to the reviewed patch. These are client-reported results; the bridge does not execute or independently verify the command. Do not include secrets in output.',
    inputSchema: { taskId: z.string().uuid(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/), command: z.string().min(1).max(1000),
      exitCode: z.number().int().min(0).max(255), output: z.string().max(4000).optional() },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async ({ taskId, expectedSha256, command, exitCode, output }) => safe(() => tasks.recordTest(taskId, expectedSha256, command, exitCode, output))());

  server.registerTool('antigravity_integrate', {
    title: 'Integrate reviewed changes', description: 'Request human confirmation through MCP form elicitation, then apply the reviewed patch. Requires the SHA-256 from antigravity_preview. Clients without form elicitation cannot integrate; no tool argument substitutes for user confirmation.',
    inputSchema: { taskId: z.string().uuid(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/) }, annotations: action,
  }, async ({ taskId, expectedSha256 }) => safe(() => tasks.integrate(taskId, expectedSha256, async preview => {
    if (!server.server.getClientCapabilities()?.elicitation?.form) {
      throw new BridgeError('APPROVAL_UNAVAILABLE', 'The MCP client must support form elicitation to confirm integration');
    }
    const files = preview.fileSummaries.map(file => `${file.status} ${JSON.stringify(file.path)} (${file.binary ? 'binário' : '+' + file.insertions + ' -' + file.deletions})`).join('\n');
    const answer = await server.server.elicitInput({ mode: 'form',
      message: `Aplicar ${preview.summary.filesChanged} arquivo(s) ao projeto original?\nOrigem: ${JSON.stringify(preview.sourceDirectory)}\nTarefa: ${taskId}\nSHA-256 revisado: ${preview.sha256}\n${files}\nA integração modifica o original. Confirme apenas após revisar o patch e os testes.`,
      requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Confirmo a integração deste patch', default: false } }, required: ['confirm'] },
    }, { timeout: 300000 }).catch(() => {
      throw new BridgeError('APPROVAL_FAILED', 'Client confirmation failed or timed out; no changes were applied');
    });
    return answer.action === 'accept' && answer.content?.confirm === true;
  }))());

  server.registerTool('antigravity_discard', {
    title: 'Discard an isolated copy', description: 'Delete the copy and baseline of a finished task, including resumed tasks sharing that copy. Active copies are refused. The source project is preserved.',
    inputSchema: { taskId: z.string().uuid() }, annotations: { ...action, openWorldHint: false },
  }, async ({ taskId }) => safe(async () => ({ task: await tasks.discard(taskId) }))());

  server.registerTool('antigravity_cleanup', {
    title: 'Clean expired isolated copies', description: 'Remove finished copies older than COPY_RETENTION_HOURS. Active copies are preserved.',
    inputSchema: {}, annotations: { ...action, openWorldHint: false },
  }, safe(() => tasks.cleanup()));

  server.registerTool('antigravity_status', {
    title: 'Get Antigravity task status', description: 'Return task metadata, status, process ID and isolated copy path when available.',
    inputSchema: { taskId: z.string().uuid() }, annotations: readOnly,
  }, async ({ taskId }) => safe(() => ({ task: tasks.status(taskId) }))());

  server.registerTool('antigravity_tasks', {
    title: 'List persisted tasks', description: 'Recover task IDs and metadata from local bridge state, including tasks from earlier server processes.',
    inputSchema: {}, annotations: readOnly,
  }, safe(() => ({ tasks: tasks.list().map(({ prompt: _prompt, ...task }) => task) })));

  server.registerTool('antigravity_events', {
    title: 'Read Antigravity events', description: 'Read live normalized agy events after a sequence cursor. Includes original agy event payloads.',
    inputSchema: { taskId: z.string().uuid(), after: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(1000).optional() },
    annotations: readOnly,
  }, async ({ taskId, after, limit }) => safe(() => tasks.readEvents(taskId, after, limit))());

  server.registerTool('antigravity_result', {
    title: 'Get Antigravity result', description: 'Return terminal result, usage and error once the task finishes. Use antigravity_preview for the patch.',
    inputSchema: { taskId: z.string().uuid(), includeResult: z.boolean().optional() }, annotations: readOnly,
  }, async ({ taskId, includeResult }) => safe(() => {
    const result = tasks.result(taskId);
    if (includeResult !== false) return result;
    const { prompt, result: output, includedFiles, ...metadata } = result.task;
    return { ...result, task: metadata, resultAvailable: output !== undefined, includedFileCount: includedFiles?.length ?? 0 };
  })());

  server.registerTool('antigravity_cancel', {
    title: 'Cancel Antigravity task', description: 'Cancel a queued task or terminate its local agy process.',
    inputSchema: { taskId: z.string().uuid() }, annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async ({ taskId }) => safe(async () => ({ task: await tasks.cancel(taskId) }))());

  server.registerTool('antigravity_sessions', {
    title: 'List known Antigravity sessions', description: 'List conversation IDs recovered from local persisted tasks. agy does not advertise a session-list command.',
    inputSchema: {}, annotations: readOnly,
  }, safe(() => ({ sessions: tasks.sessions(), scope: 'local bridge state' })));

  return server;
}
