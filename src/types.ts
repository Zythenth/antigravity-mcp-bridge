import type { GroupAdmission, GroupAssignment } from './group-contract.js';
import type { MemorySnapshot, MemorySummary } from './project-memory.js';
import type { MemorySelection } from './memory-context.js';
import type { BridgeMessage, DeliveryMode } from './messages.js';
import type { ProvidedSkill, StagedSkill } from './skills.js';
import type { AcceptanceCriterion, VerificationRecord } from './verification.js';
import type { BridgeNativeTestRequest } from './native-tests.js';
import type { RoleReport, TaskRole, RoleDefinition, Effort } from './roles.js';
import type { UsageCounters, taskTokenUsage } from './usage.js';
import type { HandoffContext } from './handoff.js';
import type { Comparison } from './comparison.js';
import type { SandboxSelection } from './sandbox-policy.js';
import type { PortableNodeIdentity } from './portable-node.js';
import type { ArtifactReference } from './artifacts.js';
import type { AgentPolicySelection, ResolvedAgentPolicy } from './agent-policy.js';

export type { ArtifactReference } from './artifacts.js';

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
  group?: GroupAssignment;
  memory?: MemorySummary[];
  deliveryMode?: DeliveryMode;
  messages?: BridgeMessage[];
  messageCursor?: number;
  providedSkills?: readonly StagedSkill[];
  taskId: string;
  sessionId?: string;
  pid?: number;
  model?: string;
  effort?: Effort;
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
  usageProvenance?: 'local-executor';
  lastObservedCliUsage?: UsageCounters;
  tokenUsage?: ReturnType<typeof taskTokenUsage>;
  handoff?: HandoffContext;
  comparison?: Comparison;
  continuationTaskId?: string;
  parentTaskId?: string;
  sourceMessage?: { taskId: string; messageId: string };
  inbox?: CallerInboxItem[];
  dispatching?: { messageId: string; continuationTaskId?: string; ownerId?: string };
  outputSchema?: Record<string, unknown>;
  artifactPaths?: string[];
  structuredResult?: { value: unknown; sha256: string };
  artifacts?: ArtifactReference[];
  agentPolicy?: ResolvedAgentPolicy;
  agentPolicyReceipt?: { sha256: string; decisionCount: number; deniedCount: number };
}

export type CallerReceiptState = 'queued' | 'sent' | 'failed' | 'cancelled';

export interface CallerMessageReceipt {
  messageId: string;
  taskId: string;
  state: CallerReceiptState;
  continuationTaskId?: string;
  error?: { code: string; message: string };
}

export interface CallerInboxItem {
  messageId: string;
  taskId: string;
  text: string;
  receivedAt: string;
  receipt: CallerMessageReceipt;
}

export interface TestEvidence {
  command: string;
  exitCode: number;
  output: string;
  sha256: string;
  beforeSha256?: string;
  recordedAt: string;
  source: 'client-reported' | 'agy-tool' | 'windows-executor';
  treeSha256?: string;
  beforeTreeSha256?: string;
  executionError?: string;
  truncated?: boolean;
  attempt?: number;
  testTaskId?: string;
  sandbox?: 'agy-native-requested' | 'windows-lpac';
  sandboxSelection?: SandboxSelection;
  sandboxPolicySha256?: string;
  portableNode?: PortableNodeIdentity;
}

export interface RunOptions extends AgentPolicySelection {
  groupAdmission?: GroupAdmission;
  group?: GroupAssignment;
  memory?: MemorySelection;
  memorySnapshots?: MemorySnapshot[];
  agentPolicy?: ResolvedAgentPolicy;
  deliveryMode?: DeliveryMode;
  skills?: readonly ProvidedSkill[];
  providedSkills?: readonly StagedSkill[];
  roleDefinition?: RoleDefinition;
  comparison?: Comparison;
  contextTaskId?: string;
  expectedContextSha256?: string;
  decisions?: string[];
  handoff?: HandoffContext;
  role?: TaskRole;
  nativeTest?: BridgeNativeTestRequest;
  acceptanceCriteria?: AcceptanceCriterion[];
  prompt: string;
  model?: string | null;
  effort?: Effort;
  workingDirectory: string;
  sessionId?: string;
  timeoutSeconds?: number;
  isolateWorktree?: boolean;
  includePaths?: string[];
  mode?: 'write' | 'read-only';
  parentTaskId?: string;
  sourceMessage?: { taskId: string; messageId: string };
  outputSchema?: Record<string, unknown>;
  artifactPaths?: string[];
}

export class BridgeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
  }
}
