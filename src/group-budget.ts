import { z } from 'zod';
import { BridgeError, type TaskRecord } from './types.js';
import type { GroupRecord } from './group-contract.js';
import { taskTokenUsage } from './usage.js';

export const groupBudgetSchema = z.object({ maxTotalTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export const groupBudgetStatusSchema = z.object({
  limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observedTotalTokens: z.number().int().nonnegative().nullable(),
  knownTotalTokens: z.number().int().nonnegative(),
  unmeasuredTaskCount: z.number().int().nonnegative(), activeTaskCount: z.number().int().nonnegative(),
  remainingTokens: z.number().int().nonnegative().nullable(),
  state: z.enum(['available','waiting','unavailable','exhausted']),
}).strict();
export type GroupBudgetStatus = z.infer<typeof groupBudgetStatusSchema>;
const terminal = new Set(['completed','failed','cancelled','timeout']);

export function observeGroupBudget(group: GroupRecord, tasks: TaskRecord[], pending?: { taskId: string; zeroTokens: boolean }): GroupBudgetStatus | undefined {
  if (!group.definition.budget) return undefined;
  const limit = groupBudgetSchema.parse(group.definition.budget).maxTotalTokens;
  const members = tasks.filter(task => task.group?.groupId.toLowerCase() === group.groupId.toLowerCase());
  for (const task of members) {
    const assignment = task.group!, job = group.definition.jobs.find(job => job.key === assignment.nodeKey);
    const roots = members.filter(candidate => candidate.group?.nodeKey === assignment.nodeKey && candidate.group.rootTaskId.toLowerCase() === candidate.taskId.toLowerCase());
    const node = group.nodes[assignment.nodeKey];
    const rootId = node?.taskId ?? (node?.state === 'starting' && roots.length === 1 ? roots[0]!.taskId : undefined);
    if (!job || roots.length > 1 || assignment.owner !== job.owner || task.role !== job.owner ||
        assignment.definitionSha256 !== group.definitionSha256 || task.workingDirectory !== group.definition.workingDirectory ||
        assignment.rootTaskId.toLowerCase() !== rootId?.toLowerCase()) {
      throw new BridgeError('INVALID_STATE', 'Budget contains a task outside the exact group membership');
    }
  }
  const ids = new Set(members.map(task => task.taskId.toLowerCase()));
  const required = new Set([
    ...Object.values(group.nodes).flatMap(node => [node.taskId, node.checkpoint?.data.taskId, node.checkpoint?.data.outputTaskId].filter((id): id is string => !!id).map(id => id.toLowerCase())),
    ...members.flatMap(task => [task.parentTaskId, task.continuationTaskId].filter((id): id is string => !!id).map(id => id.toLowerCase())),
    ...(group.peerDeliveries ?? []).flatMap(item => [item.sourceTaskId,item.targetTaskId,item.continuationTaskId].filter((id): id is string => !!id).map(id => id.toLowerCase())),
  ]);
  let unmeasuredTaskCount = [...required].filter(id => !ids.has(id)).length, knownTotalTokens = 0, activeTaskCount = 0;
  for (const task of members) {
    const ignored = pending?.taskId === task.taskId;
    if (!terminal.has(task.status) && !ignored) activeTaskCount++;
    const total = taskTokenUsage(task).counters.totalTokens;
    if (total === null) { if (!(ignored && pending.zeroTokens)) unmeasuredTaskCount++; }
    else knownTotalTokens += total;
  }
  if (!Number.isSafeInteger(knownTotalTokens)) throw new BridgeError('GROUP_USAGE_UNAVAILABLE', 'Observed group usage exceeds safe integer accounting');
  const observedTotalTokens = unmeasuredTaskCount ? null : knownTotalTokens;
  return {
    limit, observedTotalTokens, knownTotalTokens, unmeasuredTaskCount, activeTaskCount,
    remainingTokens: observedTotalTokens === null ? null : Math.max(0, limit - observedTotalTokens),
    state: activeTaskCount ? 'waiting' : unmeasuredTaskCount ? 'unavailable' : knownTotalTokens >= limit ? 'exhausted' : 'available',
  };
}
export function requireGroupBudget(status: GroupBudgetStatus | undefined): void {
  if (!status || status.state === 'available') return;
  if (status.state === 'waiting') throw new BridgeError('GROUP_BUDGET_PENDING', 'Wait for active group usage before admitting another model turn');
  if (status.state === 'unavailable') throw new BridgeError('GROUP_USAGE_UNAVAILABLE', 'Group usage is incomplete; no additional model turn was admitted');
  throw new BridgeError('GROUP_BUDGET_EXCEEDED', 'Observed group usage reached its admission limit');
}
