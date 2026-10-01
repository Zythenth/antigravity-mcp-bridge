export type TaskStatus = 'queued' | 'starting' | 'running' | 'streaming' | 'completed' | 'failed' | 'cancelled' | 'timeout';

export interface BridgeEvent {
  taskId: string;
  sequence: number;
  timestamp: string;
  type: string;
  data: unknown;
  raw?: unknown;
}

export interface GitSnapshot {
  branch: string;
  status: string;
  diff: string;
  diffStat: string;
  truncated: boolean;
}

export interface TaskRecord {
  taskId: string;
  sessionId?: string;
  pid?: number;
  model?: string;
  prompt: string;
  workingDirectory: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  error?: { code: string; message: string };
  usage?: unknown;
  result?: unknown;
  gitBefore?: GitSnapshot;
  gitAfter?: GitSnapshot;
  worktreePath?: string;
}

export interface RunOptions {
  prompt: string;
  model?: string;
  workingDirectory: string;
  sessionId?: string;
  timeoutSeconds?: number;
  isolateWorktree?: boolean;
}

export class BridgeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
  }
}
