import { z } from 'zod';

export const toolProfileSchema = z.enum(['full', 'query', 'review', 'implementation']);
export type ToolProfile = z.infer<typeof toolProfileSchema>;
const queryTools = new Set([
  'black_gravity_workflow_result', 'black_gravity_peer_receipts', 'black_gravity_wait_many', 'black_gravity_group_status', 'black_gravity_groups', 'black_gravity_group_wait', 'black_gravity_group_cancel',
  'black_gravity_memory_list', 'black_gravity_memory_read',
  'black_gravity_health', 'black_gravity_get_agent_policy', 'black_gravity_list_models', 'black_gravity_get_model', 'black_gravity_usage',
  'black_gravity_list_project_files', 'black_gravity_run', 'black_gravity_resume', 'black_gravity_status',
  'black_gravity_tasks', 'black_gravity_events', 'black_gravity_result', 'black_gravity_read_result',
  'black_gravity_cancel', 'black_gravity_sessions', 'black_gravity_wait', 'black_gravity_context', 'black_gravity_handoff',
  'black_gravity_compare', 'black_gravity_comparison',
  'black_gravity_roles', 'black_gravity_get_sandbox_policy', 'black_gravity_set_delivery_mode',
  'black_gravity_send_message',
  'black_gravity_read_structured_result', 'black_gravity_artifacts', 'black_gravity_read_artifact',
]);
const reviewTools = new Set([...queryTools, 'black_gravity_preview', 'black_gravity_read_patch', 'black_gravity_verify']);

export function toolEnabled(profile: ToolProfile, name: string): boolean {
  if (profile === 'full' || profile === 'implementation') return true;
  return (profile === 'query' ? queryTools : reviewTools).has(name);
}

export function profileReadOnly(profile: ToolProfile): boolean {
  return profile === 'query' || profile === 'review';
}
