import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TaskRecord } from './types.js';

export const deliveryModeSchema = z.enum(['messages', 'events']);
export type DeliveryMode = z.infer<typeof deliveryModeSchema>;
export const MAX_MESSAGE_CHARS = 2000;
export const MAX_TASK_MESSAGES = 100;
export const agentMessageInputSchema = z.object({
  kind: z.enum(['message', 'question', 'blocker']), text: z.string().min(1).max(MAX_MESSAGE_CHARS),
}).strict();
export const bridgeMessageSchema = z.object({
  messageId: z.string().uuid(), taskId: z.string().uuid(), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  timestamp: z.string().datetime(), source: z.enum(['agy-reported', 'bridge']),
  kind: z.enum(['message', 'question', 'blocker', 'final', 'error']),
  text: z.string().min(1).max(MAX_MESSAGE_CHARS), model: z.string().nullable(),
  reference: z.object({ tool: z.literal('antigravity_read_result'), taskId: z.string().uuid(), contentSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict();
export type BridgeMessage = z.infer<typeof bridgeMessageSchema>;
export interface MessageLog { messages?: BridgeMessage[]; messageCursor?: number }

export function appendMessage(record: Pick<TaskRecord, 'taskId' | 'model'> & MessageLog,
  kind: BridgeMessage['kind'], source: BridgeMessage['source'], text: string, reference?: BridgeMessage['reference']): BridgeMessage {
  const sequence = (record.messageCursor ?? 0) + 1;
  const message = bridgeMessageSchema.parse({ messageId: randomUUID(), taskId: record.taskId, sequence, timestamp: new Date().toISOString(),
    kind, source, text: text.slice(0, MAX_MESSAGE_CHARS), model: record.model ?? null, ...(reference ? { reference } : {}) });
  record.messageCursor = sequence;
  record.messages = [...(record.messages ?? []), message].slice(-MAX_TASK_MESSAGES);
  return message;
}

export function readMessages(record: MessageLog, after = 0, limit = 25) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid message cursor or page size');
  const retained = record.messages ?? [];
  const oldestAvailable = retained[0]?.sequence ?? (record.messageCursor ?? 0) + 1;
  const messages = retained.filter(message => message.sequence > after).slice(0, limit);
  return { messages, nextCursor: messages.at(-1)?.sequence ?? after, oldestAvailable, truncated: after < oldestAvailable - 1 };
}

// Only explicit public response envelopes qualify; arbitrary tool output is not a message.
export function extractAgentMessages(text: string): z.infer<typeof agentMessageInputSchema>[] {
  const messages: z.infer<typeof agentMessageInputSchema>[] = [];
  const bounded = text.slice(0, 1024 * 1024);
  for (const match of bounded.matchAll(/<antigravity-message>([\s\S]*?)<\/antigravity-message>/g)) {
    if (messages.length >= 1001) break;
    if (match[1]!.length > 4096) continue;
    try { const parsed = agentMessageInputSchema.safeParse(JSON.parse(match[1]!)); if (parsed.success) messages.push(parsed.data); }
    catch { /* malformed model output remains available as public history */ }
  }
  return messages;
}

export function clientTask(task: TaskRecord): TaskRecord | CompactTask {
  if (task.deliveryMode === 'messages') return compactTask(task);
  const { messages, messageCursor, ...metadata } = task;
  void messages; void messageCursor;
  return metadata;
}

export function resultReference(record: Pick<TaskRecord, 'taskId' | 'result'>): BridgeMessage['reference'] {
  return { tool: 'antigravity_read_result', taskId: record.taskId,
    contentSha256: createHash('sha256').update(JSON.stringify(record.result ?? null)).digest('hex') };
}

export type CompactTask = Pick<TaskRecord, 'taskId' | 'workingDirectory' | 'status' | 'createdAt' | 'sessionId' | 'model' | 'mode' | 'role' | 'startedAt' | 'completedAt' | 'exitCode' | 'error' | 'tokenUsage' | 'integratedAt' | 'discardedAt' | 'deliveryMode'>;

export function compactTask(task: TaskRecord): CompactTask {
  return { taskId: task.taskId, workingDirectory: task.workingDirectory, status: task.status, createdAt: task.createdAt,
    sessionId: task.sessionId, model: task.model, mode: task.mode, role: task.role, startedAt: task.startedAt, completedAt: task.completedAt,
    exitCode: task.exitCode, error: task.error, tokenUsage: task.tokenUsage,
    integratedAt: task.integratedAt, discardedAt: task.discardedAt, deliveryMode: task.deliveryMode };
}
