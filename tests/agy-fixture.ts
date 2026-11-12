import {
  assertExecutionCapabilities, type ExecutionAdapter, type ExecutionCapabilities,
  type ExecutionRequest, type ExecutionResult,
} from '../src/execution-contract.js';

// Synthetic fixture: advertised capabilities are test inputs, not claims about an installed CLI.
export const fixtureCapabilities: ExecutionCapabilities = {
  read: 'supported', write: 'supported', sandbox: 'supported', network: 'unknown',
  skills: 'supported', resources: 'unknown', structuredOutput: 'supported',
  cancel: 'unknown', resume: 'supported', observableUsage: 'supported',
};

export interface AgyFixtureEnvelope {
  readonly status: string;
  readonly conversation_id?: string;
  readonly response?: string;
  readonly structured_output?: unknown;
  readonly usage?: unknown;
  readonly hostMessage?: { readonly kind: 'question' | 'blocker'; readonly text: string };
}

export class AgyExecutionFixture implements ExecutionAdapter {
  readonly identity = { id: 'agy-fixture', provider: 'agy' };
  constructor(readonly envelope: AgyFixtureEnvelope, readonly capabilities = fixtureCapabilities) {}

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    assertExecutionCapabilities(request, this.capabilities);
    const common = {
      taskId: request.taskId, raw: this.envelope, usage: this.envelope.usage,
      session: this.envelope.conversation_id ? { id: this.envelope.conversation_id } : undefined,
    };
    switch (this.envelope.status) {
      case 'SUCCESS':
        return { ...common, status: 'completed', response: this.envelope.response ?? '',
          structuredOutput: this.envelope.structured_output };
      case 'WAITING':
        if (!this.envelope.hostMessage) throw new TypeError('Waiting fixture requires a host message');
        return { ...common, status: 'needs-host', message: this.envelope.hostMessage };
      case 'RUNNING': return { ...common, status: 'running' };
      case 'ERROR':
      case 'INVALID':
        return { ...common, status: 'failed', error: { code: 'AGY_PROCESS_FAILED', message: 'Fixture failed' } };
      case 'CANCELED':
      case 'INTERRUPTED':
        return { ...common, status: 'cancelled', error: { code: 'TASK_CANCELLED', message: 'Fixture cancelled' } };
      // Timeout is a harness outcome, not a claimed native agy status.
      case 'HARNESS_TIMEOUT':
        return { ...common, status: 'timeout', error: { code: 'TASK_TIMEOUT', message: 'Fixture timed out' } };
      default: throw new TypeError('Unknown agy fixture status: ' + this.envelope.status);
    }
  }
}
