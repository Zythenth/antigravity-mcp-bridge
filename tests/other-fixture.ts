import {
  assertExecutionCapabilities, type ExecutionAdapter, type ExecutionCapabilities,
  type ExecutionRequest, type ExecutionResult,
} from '../src/execution-contract.js';

// An intentionally synthetic second provider, not an implementation of any vendor CLI.
export interface OtherFixtureEnvelope {
  readonly outcome: string;
  readonly session?: string;
  readonly payload?: unknown;
  readonly text?: string;
  readonly hostMessage?: { readonly kind: 'question' | 'blocker'; readonly text: string };
}

const fixtureCapabilities: ExecutionCapabilities = {
  read: 'supported', write: 'supported', sandbox: 'unknown', network: 'unsupported',
  skills: 'unsupported', resources: 'unknown', structuredOutput: 'supported',
  cancel: 'unsupported', resume: 'supported', observableUsage: 'unknown',
};

export class OtherProviderExecutionFixture implements ExecutionAdapter {
  readonly identity = { id: 'other-fixture', provider: 'synthetic-provider' };
  constructor(readonly envelope: OtherFixtureEnvelope, readonly capabilities: ExecutionCapabilities = fixtureCapabilities) {}

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    assertExecutionCapabilities(request, this.capabilities);
    const common = { taskId: request.taskId, raw: this.envelope,
      session: this.envelope.session ? { id: this.envelope.session } : undefined };
    switch (this.envelope.outcome) {
      case 'done':
        return { ...common, status: 'completed', response: this.envelope.text ?? '',
          structuredOutput: this.envelope.payload };
      case 'input_required':
        if (!this.envelope.hostMessage) throw new TypeError('Waiting fixture requires a host message');
        return { ...common, status: 'needs-host', message: this.envelope.hostMessage };
      case 'active': return { ...common, status: 'running' };
      case 'fault':
        return { ...common, status: 'failed', error: { code: 'AGY_PROCESS_FAILED', message: 'Fixture failed' } };
      case 'aborted':
        return { ...common, status: 'cancelled', error: { code: 'TASK_CANCELLED', message: 'Fixture cancelled' } };
      case 'deadline':
        return { ...common, status: 'timeout', error: { code: 'TASK_TIMEOUT', message: 'Fixture timed out' } };
      default: throw new TypeError('Unknown other fixture status: ' + this.envelope.outcome);
    }
  }
}
