import type { AcceptanceCriterion, VerificationRecord } from './verification.js';
import type { NativeTestRequest } from './native-tests.js';
import type { RoleReport, TaskRole } from './roles.js';

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
  role?: TaskRole;
  report?: RoleReport;
}

export interface TestEvidence {
  command: string;
  exitCode: number;
  output: string;
  sha256: string;
  recordedAt: string;
  source: 'client-reported' | 'agy-tool';
  treeSha256?: string;
  beforeTreeSha256?: string;
  executionError?: string;
  truncated?: boolean;
  attempt?: number;
  testTaskId?: string;
  sandbox?: 'agy-native-requested';
}

export interface RunOptions {
  role?: TaskRole;
  nativeTest?: NativeTestRequest;
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
