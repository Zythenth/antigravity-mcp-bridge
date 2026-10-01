import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CliAdapter } from './cli-adapter.js';
import { TaskManager } from './task-manager.js';
import { BridgeError } from './types.js';

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
  const server = new McpServer({ name: 'antigravity-mcp-bridge', version: '0.1.0' }, {
    instructions: 'Use antigravity_health before relying on CLI capabilities. Run returns a taskId; poll antigravity_events and antigravity_result for live progress and completion. Model IDs must come from antigravity_list_models. Antigravity may modify files in the selected directory; review Git changes after completion.',
  });
  const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
  const action = { readOnlyHint: false, openWorldHint: true, destructiveHint: true };

  server.registerTool('antigravity_health', {
    title: 'Check Antigravity CLI', description: 'Inspect installed agy version, authentication and supported capabilities.',
    inputSchema: {}, annotations: readOnly,
  }, safe(() => adapter.health()));

  server.registerTool('antigravity_list_models', {
    title: 'List Antigravity models', description: 'List model IDs actually returned by agy models for this account.',
    inputSchema: {}, annotations: readOnly,
  }, safe(async () => ({ models: await adapter.listModels() })));

  server.registerTool('antigravity_get_model', {
    title: 'Get selected model', description: 'Return the default model selected for subsequent bridge tasks. Null means agy chooses its own default.',
    inputSchema: {}, annotations: readOnly,
  }, safe(() => ({ model: tasks.getModel() ?? null })));

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
  };
  server.registerTool('antigravity_run', {
    title: 'Run Antigravity task', description: 'Start a programming task asynchronously through official agy stream-json. Returns a taskId. The agent can modify files in workingDirectory.',
    inputSchema: runSchema, annotations: action,
  }, async args => safe(async () => ({ task: await tasks.run(args) }))());

  server.registerTool('antigravity_resume', {
    title: 'Resume Antigravity conversation', description: 'Start another agy task in an existing conversation using its conversation ID.',
    inputSchema: { ...runSchema, sessionId: z.string().min(1).max(128) }, annotations: action,
  }, async args => safe(async () => ({ task: await tasks.run(args) }))());

  server.registerTool('antigravity_status', {
    title: 'Get Antigravity task status', description: 'Return task metadata, status, process ID and Git snapshots when available.',
    inputSchema: { taskId: z.string().uuid() }, annotations: readOnly,
  }, async ({ taskId }) => safe(() => ({ task: tasks.status(taskId) }))());

  server.registerTool('antigravity_events', {
    title: 'Read Antigravity events', description: 'Read live normalized agy events after a sequence cursor. Includes original agy event payloads.',
    inputSchema: { taskId: z.string().uuid(), after: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(1000).optional() },
    annotations: readOnly,
  }, async ({ taskId, after, limit }) => safe(() => tasks.readEvents(taskId, after, limit))());

  server.registerTool('antigravity_result', {
    title: 'Get Antigravity result', description: 'Return terminal result, usage, error and Git diff once the task finishes.',
    inputSchema: { taskId: z.string().uuid() }, annotations: readOnly,
  }, async ({ taskId }) => safe(() => tasks.result(taskId))());

  server.registerTool('antigravity_cancel', {
    title: 'Cancel Antigravity task', description: 'Cancel a queued task or terminate its local agy process.',
    inputSchema: { taskId: z.string().uuid() }, annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async ({ taskId }) => safe(async () => ({ task: await tasks.cancel(taskId) }))());

  server.registerTool('antigravity_sessions', {
    title: 'List known Antigravity sessions', description: 'List conversation IDs observed by this bridge process. agy 1.2.11 does not advertise a session-list command.',
    inputSchema: {}, annotations: readOnly,
  }, safe(() => ({ sessions: tasks.sessions(), scope: 'current bridge process' })));

  return server;
}
