import type { AcceptanceCriterion, VerificationRecord } from './verification.js';

export type TaskStatus = 'queued' | 'starting' | 'running' | 'streaming' | 'completed' | 'failed' | 'cancelled' | 'timeout';

export interface BridgeEvent {
  taskId: string;
  sequence: number;
  timestamp: string;
  type: string;
  data: unknown;
  raw?: unknown;
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
  copyDirectory?: string;
  includedFiles?: string[];
  integratedAt?: string;
  discardedAt?: string;
  mode?: 'write' | 'read-only';
  tests?: TestEvidence[];
  acceptanceCriteria?: AcceptanceCriterion[];
  verification?: VerificationRecord;
}

export interface TestEvidence {
  command: string;
  exitCode: number;
  output: string;
  sha256: string;
  recordedAt: string;
  source: 'client-reported';
}

export interface RunOptions {
  acceptanceCriteria?: AcceptanceCriterion[];
  prompt: string;
  model?: string;
  workingDirectory: string;
  sessionId?: string;
  timeoutSeconds?: number;
  isolateWorktree?: boolean;
  includePaths?: string[];
  mode?: 'write' | 'read-only';
}

export class BridgeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
  }
}
