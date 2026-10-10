import { z } from 'zod';
import { bridgeMessageSchema, readMessages } from './messages.js';
import type { TaskRecord } from './types.js';

export const waitTargetSchema = z.object({
  taskId: z.string().uuid(), after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
}).strict();
export const waitCursorsSchema = z.array(waitTargetSchema).max(32).refine(items => new Set(items.map(item => item.taskId.toLowerCase())).size === items.length, 'Duplicate wait target');
export const waitTargetsSchema = waitCursorsSchema.min(1);
export type WaitTarget = z.infer<typeof waitTargetSchema>;
const terminal = new Set(['completed', 'failed', 'cancelled', 'timeout']);
export const jointWaitTaskSchema = z.object({
  taskId: z.string().uuid(), status: z.string().nullable(), ready: z.boolean(),
  nextCursor: z.number().int().nonnegative(), oldestAvailable: z.number().int().positive(), truncated: z.boolean(),
  messages: z.array(bridgeMessageSchema).max(1), hasMore: z.boolean(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
}).strict();
export function jointWaitPage(records: readonly TaskRecord[], targets: readonly WaitTarget[]) {
  let remaining = 4;
  const byId = new Map(records.map(record => [record.taskId.toLowerCase(), record]));
  const tasks = targets.map(target => {
    const record = byId.get(target.taskId.toLowerCase());
    if (!record) return { taskId: target.taskId, status: null, ready: true, messages: [], hasMore: false, nextCursor: target.after, oldestAvailable: Math.min(Number.MAX_SAFE_INTEGER, target.after + 1), truncated: false,
      error: { code: 'TASK_NOT_FOUND', message: 'This retained task is unavailable; no execution was repeated' } };
    const page = readMessages(record, target.after, 1);
    const messages = remaining ? page.messages : [];
    remaining -= messages.length;
    return { taskId: record.taskId, status: record.status, ready: terminal.has(record.status),
      ...page, messages, nextCursor: messages.at(-1)?.sequence ?? target.after,
      hasMore: (record.messageCursor ?? 0) > (messages.at(-1)?.sequence ?? target.after), error: record.error };
  });
  return { tasks, ready: tasks.length > 0 && tasks.every(task => task.ready), hasMessages: tasks.some(task => task.messages.length > 0), hasMoreMessages: tasks.some(task => task.hasMore) };
}
