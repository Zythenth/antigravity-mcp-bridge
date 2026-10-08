import { z } from 'zod';
import type { TaskRecord } from './types.js';

export const usageCountersSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(), thinkingTokens: z.number().int().nonnegative().nullable(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
});
export type UsageCounters = z.infer<typeof usageCountersSchema>;
const fields = { inputTokens: 'input_tokens', outputTokens: 'output_tokens', totalTokens: 'total_tokens',
  thinkingTokens: 'thinking_tokens', cacheReadTokens: 'cache_read_tokens' } as const;
const keys = Object.keys(fields) as Array<keyof UsageCounters>;

export function normalizeUsage(raw: unknown): UsageCounters {
  const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return Object.fromEntries(keys.map(key => {
    const value = data[fields[key]];
    return [key, typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null];
  })) as UsageCounters;
}

export function taskTokenUsage(task: TaskRecord) {
  if (task.usageProvenance === 'local-executor') {
    return { scope: 'task' as const, source: 'local-executor' as const,
      counters: { inputTokens: 0, outputTokens: 0, totalTokens: 0, thinkingTokens: 0, cacheReadTokens: 0 },
      available: true, partial: false, warnings: [] as string[] };
  }
  const raw = (task.result as { usage?: unknown } | undefined)?.usage;
  const current = normalizeUsage(raw);
  const counters = { ...current };
  const warnings: string[] = [];
  if (task.usageIsResume) {
    for (const key of keys) {
      const before = task.usageBaseline?.[key];
      const after = current[key];
      counters[key] = before !== undefined && before !== null && after !== null && after >= before ? after - before : null;
      if (before !== null && before !== undefined && after !== null && after < before) warnings.push('Counter reset: ' + key);
    }
    if (!task.usageBaseline) warnings.push('Previous session counters are unavailable; cumulative usage is not task usage');
  }
  const available = keys.some(key => counters[key] !== null);
  const partial = keys.some(key => counters[key] === null);
  if (raw === undefined) warnings.push('Final CLI usage is unavailable');
  if (partial) warnings.push('Missing counters remain null; no estimate or zero substitution');
  return { scope: 'task' as const, source: available ? task.usageIsResume ? 'session-delta' as const : 'session-total' as const : 'unavailable' as const,
    counters, available, partial, warnings };
}

function sum(rows: UsageCounters[]): UsageCounters {
  return Object.fromEntries(keys.map(key => {
    if (!rows.length || rows.some(row => row[key] === null)) return [key, null];
    const total = rows.reduce((total, row) => total + row[key]!, 0);
    return [key, Number.isSafeInteger(total) ? total : null];
  })) as UsageCounters;
}

export function aggregateUsage(tasks: TaskRecord[]) {
  const byTask = tasks.map(task => ({ taskId: task.taskId, sessionId: task.sessionId ?? null, model: task.model ?? null, status: task.status, ...taskTokenUsage(task) }));
  const models = [...new Set(tasks.map(task => task.model ?? null))];
  const sessions = [...new Set(tasks.map(task => task.sessionId).filter((id): id is string => id !== undefined))];
  return { scope: 'retained-tasks' as const, taskCount: tasks.length, measuredTaskCount: byTask.filter(task => task.available).length,
    counters: sum(byTask.map(task => task.counters)), byTask,
    byModel: models.map(model => {
      const rows = byTask.filter(task => task.model === model);
      return { model, taskCount: rows.length, counters: sum(rows.map(task => task.counters)) };
    }),
    bySession: sessions.map(sessionId => {
      const rows = byTask.filter(task => task.sessionId === sessionId);
      const latest = tasks.filter(task => task.sessionId === sessionId && task.usageProvenance !== 'local-executor' &&
        (task.lastObservedCliUsage !== undefined || (task.result as { usage?: unknown } | undefined)?.usage !== undefined)).at(-1);
      return { sessionId, taskCount: rows.length, counters: sum(rows.map(task => task.counters)),
        observedCumulative: latest?.lastObservedCliUsage ?? (latest ? normalizeUsage((latest.result as { usage: unknown }).usage) : null) };
    }),
  };
}
