import type { AcceptanceCriterion, VerificationRecord } from './verification.js';
import type { NativeTestRequest } from './native-tests.js';
import type { RoleReport, TaskRole, RoleDefinition } from './roles.js';
import type { UsageCounters, taskTokenUsage } from './usage.js';
import type { HandoffContext } from './handoff.js';
import type { Comparison } from './comparison.js';

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
  roleDefinition?: RoleDefinition;
  report?: RoleReport;
  usageIsResume?: boolean;
  usageBaseline?: UsageCounters;
  tokenUsage?: ReturnType<typeof taskTokenUsage>;
  handoff?: HandoffContext;
  comparison?: Comparison;
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
  roleDefinition?: RoleDefinition;
  comparison?: Comparison;
  contextTaskId?: string;
  expectedContextSha256?: string;
  decisions?: string[];
  handoff?: HandoffContext;
  role?: TaskRole;
  nativeTest?: NativeTestRequest;
  acceptanceCriteria?: AcceptanceCriterion[];
  prompt: string;
  model?: string | null;
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
