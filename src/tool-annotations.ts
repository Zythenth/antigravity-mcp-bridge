import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

// One row per MCP tool: the title and the behavior hints published in tools/list. The profiles in tool-profiles.ts decide
// which tools are registered; this table only describes them.
// readOnlyHint: the tool starts no work and changes no task, copy, message, memory, or policy; dispatching a caller message still
// queued for the copy counts as a change, while recording that a task whose owner process already ended was interrupted (as every
// state load does, including startup) and creating the empty private memory directory on first use do not.
// destructiveHint: it can delete or overwrite something of the user;
// creating an isolated copy or starting the model does not count, evicting the oldest finished task does. idempotentHint: repeating the call with the same
// arguments is refused or returns the existing state without new records. openWorldHint: it queries agy or the account.
export interface ToolAnnotationRow {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export const TOOL_ANNOTATIONS: Readonly<Record<string, ToolAnnotationRow>> = {
  antigravity_health: { title: 'Check Antigravity CLI', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  antigravity_list_models: { title: 'List Antigravity models', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  antigravity_get_model: { title: 'Get selected model', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_get_sandbox_policy: { title: 'Get Windows test sandbox policy', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_usage: { title: 'Read observed token usage', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_list_project_files: { title: 'List files eligible for a project copy', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_set_model: { title: 'Select Antigravity model', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  antigravity_set_sandbox_policy: { title: 'Set Windows test sandbox policy', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  antigravity_roles: { title: 'List configured task roles', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_get_agent_policy: { title: 'List delegated tool ceilings', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_memory_list: { title: 'List private project memory', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_memory_read: { title: 'Read private memory in chunks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_memory_write: { title: 'Write reviewed private memory', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  antigravity_memory_remove: { title: 'Remove private memory', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  antigravity_workflow_result: { title: 'Read the validated workflow synthesis', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_peer_receipts: { title: 'Inspect compact peer delivery receipts', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_group_create: { title: 'Create a dependency group', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_group_start: { title: 'Start or resume a dependency group', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  antigravity_group_status: { title: 'Inspect group state', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_groups: { title: 'List retained groups', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_group_wait: { title: 'Wait for compact group progress', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_group_cancel: { title: 'Cancel a dependency group', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_wait_many: { title: 'Wait for several tasks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_run: { title: 'Run Antigravity task', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  antigravity_resume: { title: 'Resume Antigravity conversation', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  antigravity_context: { title: 'Inspect role handoff context', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  antigravity_handoff: { title: 'Transfer work to another role', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  antigravity_compare: { title: 'Request independent model opinions', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  antigravity_comparison: { title: 'Compare model review evidence', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  antigravity_preview: { title: 'Preview isolated changes', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  antigravity_read_patch: { title: 'Read patch by file or chunk', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  antigravity_read_result: { title: 'Read result in chunks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_verify: { title: 'Verify task acceptance criteria', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  antigravity_test: { title: 'Run tests in the bridge sandbox', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  antigravity_record_test: { title: 'Record review test evidence', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  antigravity_integrate: { title: 'Integrate reviewed changes', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  antigravity_discard: { title: 'Discard an isolated copy', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  antigravity_cleanup: { title: 'Clean expired isolated copies', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  antigravity_send_message: { title: 'Send a caller message to an agy session', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  antigravity_set_delivery_mode: { title: 'Choose delivery to the caller', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  antigravity_status: { title: 'Get Antigravity task status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_tasks: { title: 'List persisted tasks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_events: { title: 'Read Antigravity events', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_wait: { title: 'Wait for real task progress', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  antigravity_result: { title: 'Get Antigravity result', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_cancel: { title: 'Cancel Antigravity task', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_sessions: { title: 'List known Antigravity sessions', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_read_structured_result: { title: 'Read structured result in chunks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_artifacts: { title: 'List recorded task artifacts', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  antigravity_read_artifact: { title: 'Read artifact in bounded chunks', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

export function toolAnnotationRow(name: string): ToolAnnotationRow {
  const row = Object.hasOwn(TOOL_ANNOTATIONS, name) ? TOOL_ANNOTATIONS[name] : undefined;
  if (!row) throw new Error(`Tool ${name} has no row in TOOL_ANNOTATIONS`);
  return row;
}

export function toolAnnotations(name: string): ToolAnnotations {
  const { readOnlyHint, destructiveHint, idempotentHint, openWorldHint } = toolAnnotationRow(name);
  return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint };
}
