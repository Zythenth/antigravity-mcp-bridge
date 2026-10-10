import { z } from 'zod';

export const toolProfileSchema = z.enum(['full', 'query', 'review', 'implementation']);
export type ToolProfile = z.infer<typeof toolProfileSchema>;
const queryTools = new Set([
  'antigravity_workflow_result', 'antigravity_peer_receipts', 'antigravity_wait_many', 'antigravity_group_status', 'antigravity_groups', 'antigravity_group_wait', 'antigravity_group_cancel',
  'antigravity_memory_list', 'antigravity_memory_read',
  'antigravity_health', 'antigravity_get_agent_policy', 'antigravity_list_models', 'antigravity_get_model', 'antigravity_usage',
  'antigravity_list_project_files', 'antigravity_run', 'antigravity_resume', 'antigravity_status',
  'antigravity_tasks', 'antigravity_events', 'antigravity_result', 'antigravity_read_result',
  'antigravity_cancel', 'antigravity_sessions', 'antigravity_wait', 'antigravity_context', 'antigravity_handoff',
  'antigravity_compare', 'antigravity_comparison',
  'antigravity_roles', 'antigravity_get_sandbox_policy', 'antigravity_set_delivery_mode',
  'antigravity_send_message',
  'antigravity_read_structured_result', 'antigravity_artifacts', 'antigravity_read_artifact',
]);
const reviewTools = new Set([...queryTools, 'antigravity_preview', 'antigravity_read_patch', 'antigravity_verify']);

export function toolEnabled(profile: ToolProfile, name: string): boolean {
  if (profile === 'full' || profile === 'implementation') return true;
  return (profile === 'query' ? queryTools : reviewTools).has(name);
}

export function profileReadOnly(profile: ToolProfile): boolean {
  return profile === 'query' || profile === 'review';
}
