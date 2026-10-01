export function logTaskEvent(taskId: string, type: string, data: unknown): void {
  if (!type.startsWith('task.') && type !== 'process.started') return;
  const details = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const entry: Record<string, unknown> = { timestamp: new Date().toISOString(), taskId, type };
  if (type === 'process.started' && typeof details.pid === 'number') entry.pid = details.pid;
  if (type === 'task.failed' && typeof details.code === 'string') entry.code = details.code;
  process.stderr.write(JSON.stringify(entry) + '\n');
}
