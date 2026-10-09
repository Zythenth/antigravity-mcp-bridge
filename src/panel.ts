import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { getUiCapability, registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TaskManager } from './task-manager.js';
import { nativeAvatarResources } from './codex-resources.js';
import { BridgeError, type TaskRecord } from './types.js';
import { textChunk } from './chunks.js';

export const PANEL_URI = 'ui://antigravity/panel.html';
export const panelInput = z.object({ taskId: z.string().uuid().optional(), after: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(200).optional(), includeResponse: z.boolean().optional(),
  responseOffset: z.number().int().nonnegative().optional(), expectedResponseSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();

const id = z.string().uuid(), count = z.number().int().nonnegative();
const taskSchema = z.object({ taskId: id, label: z.string().max(100), status: z.enum(['queued', 'starting', 'running', 'streaming', 'completed', 'failed', 'cancelled', 'timeout']),
  model: z.string().nullable(), mode: z.enum(['write', 'read-only']), createdAt: z.string(), startedAt: z.string().optional(), completedAt: z.string().optional(), sessionId: z.string().optional(),
  deliveryMode: z.enum(['messages', 'events']), tokenUsage: z.unknown().optional(), error: z.object({code: z.string(), message: z.string()}).strict().optional(), parentTaskId: id.optional(), continuationTaskId: id.optional() }).strict();
export const panelOutputSchemas = {
  antigravity_panel_undo: z.object({taskId: id, path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), filesChanged: count}).strict(),
  antigravity_open_panel: z.object({ resourceUri: z.string(), taskId: id.nullable(), supported: z.boolean() }).strict(),
  antigravity_panel_state: z.object({ tasks: z.array(taskSchema).max(10000), selectedTask: taskSchema.nullable(),
    events: z.array(z.object({ sequence: count, timestamp: z.string(), type: z.string(), data: z.unknown() }).strict()).max(200),
    nextCursor: count, oldestAvailable: z.number().int().positive(), truncated: z.boolean(),
    response: z.object({ text: z.string().max(10000), offset: count, length: count, totalLength: count, nextOffset: count, hasMore: z.boolean(), contentSha256: z.string(), offsetUnit: z.literal('utf16-code-units') }).strict().nullable(),
    callerMessages: z.array(z.object({messageId: id, taskId: id, text: z.string().max(2000), receivedAt: z.string(), receipt: z.object({messageId: id, taskId: id, state: z.enum(['queued', 'sent', 'failed', 'cancelled']), continuationTaskId: id.optional(), error: z.object({code: z.string(), message: z.string()}).strict().optional()}).strict()}).strict()).max(21),
    capabilities: z.object({ messaging: z.boolean(), deliveryMode: z.boolean(), cancel: z.boolean(), undo: z.boolean().optional(), preview: z.boolean().optional(), maxConcurrentTasks: z.number().int().min(1).max(16) }).strict(),
  }).strict(),
};

export function panelTask(task: TaskRecord) {
  return { taskId: task.taskId, label: task.prompt.trim().split(/\r?\n/)[0]!.slice(0, 100) || task.taskId,
    status: task.status, model: task.model ?? null, mode: task.mode ?? 'write', createdAt: task.createdAt,
    startedAt: task.startedAt, completedAt: task.completedAt, sessionId: task.sessionId, deliveryMode: task.deliveryMode ?? 'events',
    tokenUsage: task.tokenUsage, error: task.error, parentTaskId: task.parentTaskId, continuationTaskId: task.continuationTaskId };
}

export function panelState(tasks: Pick<TaskManager, 'list' | 'status' | 'readEvents' | 'inbox' | 'panelCapabilities'>, input: z.infer<typeof panelInput>) {
  const options = panelInput.parse(input);
  const records = tasks.list().reverse();
  const selected = options.taskId ? tasks.status(options.taskId) : records[0];
  const page = selected ? tasks.readEvents(selected.taskId, options.after ?? 0, options.limit ?? 200)
    : { events: [], nextCursor: 0, oldestAvailable: 1, truncated: false };
  const events = page.events.map(event => {
    let data = event.data;
    if (event.type === 'agy.result') data = { available: true };
    else if (event.type === 'agy.event' || event.type === 'stream.unparsed') data = { unsupportedPublicEvent: true };
    else if (data && typeof data === 'object' && 'step_type' in data) {
      const step = data as Record<string, unknown>;
      if (step.step_type !== 'agent_response' && step.step_type !== 'tool') {
        data = { step_index: step.step_index, step_type: step.step_type, state: step.state };
      }
    }
    return { sequence: event.sequence, timestamp: event.timestamp, type: event.type, data };
  });
  const result = selected?.result as { response?: unknown } | undefined;
  const response = options.includeResponse !== false && typeof result?.response === 'string'
    ? textChunk(result.response, options.responseOffset ?? 0, 10000, options.expectedResponseSha256) : null;
  return { tasks: records.map(panelTask), selectedTask: selected ? panelTask(selected) : null, ...page, events, response,
    callerMessages: selected ? [
      ...(selected.sourceMessage ? [{ messageId: selected.sourceMessage.messageId, taskId: selected.sourceMessage.taskId,
        text: selected.prompt, receivedAt: selected.createdAt,
        receipt: { messageId: selected.sourceMessage.messageId, taskId: selected.sourceMessage.taskId, state: 'sent' as const, continuationTaskId: selected.taskId } }] : []),
      ...tasks.inbox(selected.taskId),
    ] : [], capabilities: tasks.panelCapabilities(selected?.taskId) };
}

function reply(value: Record<string, unknown>) {
  return { structuredContent: value, content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function registerPanel(server: McpServer, tasks: TaskManager): void {
  const meta = { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false, permissions: { clipboardWrite: {} } } };
  registerAppResource(server, 'Antigravity activity panel', PANEL_URI, { _meta: meta }, async () => { const nativeResources = await nativeAvatarResources(); return { contents: [
    { uri: PANEL_URI, mimeType: RESOURCE_MIME_TYPE, text: (await readFile(new URL('./panel.html', import.meta.url), 'utf8')).replace('/* __NATIVE_AVATAR_RESOURCES__ */', () => JSON.stringify(nativeResources).replaceAll('<', '\\u003c')), _meta: meta },
  ] }; });
  registerAppTool(server, 'antigravity_open_panel', {
    title: 'Open Antigravity panel', description: 'Show retained tasks, public CLI activity and session messaging in an MCP App. Detailed history stays in the panel; send a compact summary to the caller only on an explicit click.',
    inputSchema: { taskId: z.string().uuid().optional() },
    outputSchema: panelOutputSchemas.antigravity_open_panel,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: PANEL_URI, visibility: ['model', 'app'] }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } },
  }, async ({ taskId }) => {
    if (taskId) tasks.status(taskId);
    return reply({ resourceUri: PANEL_URI, taskId: taskId ?? null, supported: Boolean(getUiCapability(server.server.getClientCapabilities())?.mimeTypes?.includes(RESOURCE_MIME_TYPE)) });
  });
  if (tasks.toolProfile === 'full' || tasks.toolProfile === 'implementation') registerAppTool(server, 'antigravity_panel_undo', {
    title: 'Undo one isolated file change', description: 'MCP App action that restores one changed file to the isolated baseline, bound to the current preview hash. Original source is untouched; active turns and pending inputs must finish first.',
    inputSchema: { taskId: id, expectedSha256: z.string().regex(/^[a-f0-9]{64}$/), path: z.string().min(1).max(1024) }, outputSchema: panelOutputSchemas.antigravity_panel_undo,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, _meta: { ui: {resourceUri: PANEL_URI, visibility: ['app']} },
  }, async ({taskId,expectedSha256,path}) => {
    try { return reply(await tasks.undoChange(taskId,expectedSha256,path)); }
    catch (error) { return {isError: true,...reply({error:{code:error instanceof BridgeError ? error.code : 'UNDO_FAILED',message:error instanceof Error ? error.message : String(error)}})}; }
  });
  registerAppTool(server, 'antigravity_panel_state', {
    title: 'Read panel state', description: 'MCP App polling and paging only. Fetch public activity directly for the view, without forwarding full history into the model context.',
    inputSchema: panelInput, outputSchema: panelOutputSchemas.antigravity_panel_state, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: PANEL_URI, visibility: ['app'] } },
  }, async options => {
    try { return reply(panelState(tasks, options)); }
    catch (error) { return { isError: true, ...reply({ error: { code: error instanceof BridgeError ? error.code : 'PANEL_STATE_FAILED', message: error instanceof Error ? error.message : String(error) } }) }; }
  });
}
