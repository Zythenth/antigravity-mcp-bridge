import type { TaskStatus, RunOptions, TaskRecord } from './types.js';
import type { TaskRole, Effort } from './roles.js';
import type { BridgeMessage } from './messages.js';

export type CapabilitySupport = 'supported' | 'unsupported' | 'unknown';
export type ExecutionCapability =
  | 'read' | 'write' | 'sandbox' | 'network' | 'skills' | 'resources'
  | 'structuredOutput' | 'cancel' | 'resume' | 'observableUsage';
export type ExecutionCapabilities = Readonly<Partial<Record<ExecutionCapability, CapabilitySupport>>>;

export function isCapabilitySupported(capabilities: ExecutionCapabilities, key: ExecutionCapability): boolean {
  return Object.hasOwn(capabilities, key) && capabilities[key] === 'supported';
}

export interface ExecutionAdapterIdentity {
  readonly id: string;
  readonly provider: string;
}

export interface ExecutionRequest {
  readonly taskId: string;
  readonly prompt: string;
  readonly workingDirectory: string;
  readonly role: TaskRole;
  readonly model?: string | null;
  readonly effort?: Effort;
  readonly session?: { readonly id: string };
  readonly mode: 'write' | 'read-only';
  readonly outputSchema?: RunOptions['outputSchema'];
}

export type ExecutionHostMessage = Pick<BridgeMessage, 'text'> & {
  readonly kind: 'question' | 'blocker';
};

interface ExecutionResultFields {
  readonly taskId: string;
  readonly session?: { readonly id: string };
  readonly raw?: unknown;
  readonly usage?: unknown;
}

// Native statuses belong to adapters. NEEDS_HOST is an internal result, not a new durable TaskStatus.
export type ExecutionResult = ExecutionResultFields & (
  | { readonly status: Exclude<TaskStatus, 'completed' | 'failed' | 'cancelled' | 'timeout'> }
  | { readonly status: 'needs-host'; readonly message: ExecutionHostMessage }
  | { readonly status: 'completed'; readonly response: string; readonly structuredOutput?: unknown }
  | { readonly status: 'failed' | 'cancelled' | 'timeout'; readonly error: NonNullable<TaskRecord['error']> }
);

export interface ExecutionAdapter {
  readonly identity: ExecutionAdapterIdentity;
  readonly capabilities: ExecutionCapabilities;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}

// This checks advertised support only. It grants no permissions and does not validate provider output.
export function assertExecutionCapabilities(request: ExecutionRequest, capabilities: ExecutionCapabilities): void {
  const required: ExecutionCapability[] = [request.mode === 'write' ? 'write' : 'read'];
  if (request.session) required.push('resume');
  if (request.outputSchema !== undefined) required.push('structuredOutput');
  for (const key of required) {
    if (!isCapabilitySupported(capabilities, key)) throw new TypeError('Execution capability unavailable: ' + key);
  }
}
