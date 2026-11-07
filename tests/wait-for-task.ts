import type { TaskManager } from '../src/task-manager.js';
import type { TaskRecord } from '../src/types.js';

const isTerminalStatus = (status: string) => ['completed', 'failed', 'cancelled', 'timeout'].includes(status);

export async function waitForTask(tasks: TaskManager, taskId: string, timeoutMs = 180_000): Promise<TaskRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = tasks.status(taskId);
    if (isTerminalStatus(current.status)) return current;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}
