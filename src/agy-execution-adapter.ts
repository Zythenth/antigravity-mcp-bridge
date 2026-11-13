import { CliAdapter, type CliProcess, type Discovery } from './cli-adapter.js';
import type { Config } from './config.js';
import { MAX_EVENT_PAYLOAD_CHARS } from './event-store.js';
import {
  assertExecutionCapabilities,
  type ExecutionAdapter,
  type ExecutionAdapterIdentity,
  type ExecutionCapabilities,
  type ExecutionRequest,
  type ExecutionResult,
} from './execution-contract.js';
import { classifySandboxDenial } from './native-tests.js';
import {
  DEFAULT_MAX_PAYLOAD_DEPTH,
  DEFAULT_MAX_PAYLOAD_NODES,
  sanitizePayload,
} from './payload-safety.js';
import { reconcileOwnedProcesses } from './process-tree.js';
import { LineParser } from './stream-parser.js';
import {
  isOwnedProcessGroup,
  redactDiagnostic,
  terminateSubprocess,
  type RedactionState,
} from './subprocess.js';
import { BridgeError, type RunOptions, type TaskRecord } from './types.js';
import { normalizeUsage, type UsageCounters } from './usage.js';

const RESPONSE_HOLD_BACK_CHARS = 8192;
const MAX_BUFFERED_RESPONSE_STEPS = 16;
const MAX_RESPONSE_STEPS = 1000;
const MAX_HELD_RESPONSE_LINES = 100;
const STDERR_BUFFER_LIMIT = 10000;

interface PendingResponse {
  text: string;
  redaction: RedactionState;
  suppressing: boolean;
  dropped: string;
  untilDone: boolean;
  held: string[];
  overflow: boolean;
}

export type AgyExecutionResult = ExecutionResult & {
  readonly exitCode?: number | null;
  readonly processCleanup?: TaskRecord['processCleanup'];
  readonly parseErrors?: number;
  readonly spawnedPid?: number;
};

export interface AgyExecutionHooks {
  readonly runOptions?: RunOptions;
  readonly spawnWorkingDirectory?: string;
  readonly signal?: AbortSignal;
  readonly getTerminationReason?: () => 'cancelled' | 'timeout' | undefined;
  readonly repair?: boolean;
  readonly onProcessStarted?: (pid: number | undefined, repair: boolean) => void;
  readonly onProcessCleanup?: (cleanup: NonNullable<TaskRecord['processCleanup']>) => void;
  readonly onAfterProcessExit?: (cleanup: TaskRecord['processCleanup'] | undefined, spawnedPid: number | undefined) => Promise<void> | void;
  readonly onEvent?: (type: string, data: unknown, raw?: unknown) => void;
  readonly onSession?: (sessionId: string) => void;
  readonly onStreaming?: () => void;
  readonly onUsage?: (usage: unknown, normalized?: UsageCounters) => void;
  readonly onRawResponseDelta?: (stepIndex: number, textDelta: string) => void;
  readonly onResultFrame?: (result: unknown) => void;
  readonly onFinalText?: (response: unknown, structuredOutput: unknown) => void;
  readonly onParseError?: () => void;
  readonly resolveEditMismatch?: (
    toolName: unknown,
    state: unknown,
    rawErrorMsg: string | undefined,
    params: Record<string, unknown> | undefined,
  ) => { mismatch: string; target?: { sha256: string; bytes: number; lines: number } } | undefined;
  readonly onNativeStep?: (sourceStep: Record<string, unknown>, stepIndex: number) => void;
}

export class ResponseRedactor {
  private readonly pending = new Map<number, PendingResponse>();

  releaseDelta(
    index: number,
    delta: string,
    done: boolean,
    onTruncated?: (stepIndex: number, maxPendingChars: number) => void,
  ): string {
    let entry = this.pending.get(index);
    if (!entry) {
      if (this.pending.size >= MAX_RESPONSE_STEPS) return '';
      // Redaction state outlives any buffered text, so a step that resumes mid-key is still treated as inside the key.
      entry = { text: '', redaction: {}, suppressing: false, dropped: '', untilDone: false, held: [], overflow: false };
      this.pending.set(index, entry);
    }
    let input = delta;
    if (entry.suppressing) {
      const newline = entry.untilDone ? -1 : input.indexOf('\n');
      this.dropText(entry, newline < 0 ? input : input.slice(0, newline));
      input = newline < 0 || entry.untilDone ? '' : input.slice(newline + 1);
      if (newline >= 0 && !entry.untilDone) entry.suppressing = false;
    }
    entry.text += input;
    const cut = done ? entry.text.length : entry.text.lastIndexOf('\n') + 1;
    const ready = entry.text.slice(0, cut);
    entry.text = entry.text.slice(cut);
    let marker = '';
    const buffered = [...this.pending.values()].filter(item => item.text).length;
    if (entry.text.length > RESPONSE_HOLD_BACK_CHARS || (entry.text && buffered > MAX_BUFFERED_RESPONSE_STEPS)) {
      // An unfinished line too long (or too many unfinished lines) cannot be redacted safely; drop it until its newline.
      this.dropText(entry, entry.text);
      entry.text = '';
      entry.suppressing = true;
      marker = '[response line suppressed before redaction]\n';
      onTruncated?.(index, RESPONSE_HOLD_BACK_CHARS);
    }
    // Finished steps keep their entry so the step limit never frees a slot for an index whose context was lost.
    let released = '';
    const redactLine = (line: string) => {
      const redacted = redactDiagnostic(line, entry.redaction);
      return line.endsWith('\n') && !redacted.endsWith('\n') ? redacted + '\n' : redacted;
    };
    // A key body may arrive before a terminator whose opening was never streamed, so base64-like lines wait for the next line.
    for (const line of ready.split(/(?<=\n)/).filter(Boolean)) {
      // Once a body may have started, its short final line and blank lines inside it are held too.
      const inBody = entry.held.length > 0 || entry.overflow;
      const minimum = inBody ? 1 : 16;
      const bodyLine = new RegExp(`^[A-Za-z0-9+/=]{${minimum},1024}\\r?\\n$`).test(line) || (inBody && /^\r?\n$/.test(line));
      if (!entry.redaction.inPrivateKey && bodyLine) {
        // After an overflow the rest of the same body is dropped, not released line by line.
        if (entry.overflow) continue;
        entry.held.push(line);
        if (entry.held.length > MAX_HELD_RESPONSE_LINES) {
          entry.held = [];
          entry.overflow = true;
          released += '[response lines suppressed before redaction]\n';
        }
        continue;
      }
      entry.overflow = false;
      const orphanEnd = !entry.redaction.inPrivateKey && /-----END [^-]*PRIVATE KEY-----/.test(line) && !/-----BEGIN [^-]*PRIVATE KEY-----/.test(line);
      if (orphanEnd && entry.held.length) released += '[private key redacted]\n';
      else released += entry.held.map(redactLine).join('');
      entry.held = [];
      released += redactLine(line);
    }
    if (done) {
      released += entry.held.map(redactLine).join('');
      entry.held = [];
    }
    return released + marker;
  }

  flushStep(index: number, onChunk: (index: number, text: string) => void): void {
    if (!this.pending.has(index)) return;
    const text = this.releaseDelta(index, '', true);
    if (text) onChunk(index, text);
  }

  flushAll(onChunk: (index: number, text: string) => void): void {
    for (const index of [...this.pending.keys()]) {
      this.flushStep(index, onChunk);
    }
    this.pending.clear();
  }

  // Dropped text may hold a key delimiter that redaction never saw, so the rest of that step stays suppressed.
  private dropText(entry: PendingResponse, text: string): void {
    if ((entry.dropped + text).includes('-----')) entry.untilDone = true;
    entry.dropped = (entry.dropped + text).slice(-4);
  }
}

// Bound diagnostic context, not input: every character is scanned without quadratic suffix searches.
const MCP_PERMISSION_RE = /no output produced[^\r\n]{0,200}["']mcp["'][^\r\n]{0,200}permission[^\r\n]{0,200}headless|(?:permission check failed|tool call denied|denied tool|action denied|cannot request approval)[^\r\n]{0,200}\bmcp\b|\bmcp\b[^\r\n]{0,200}(?:permission denied|permission check failed|requires? approval|not authorized)/iu;
const SOFT_DENIAL_RE = /permission check failed|tool(?:\s+call|\s+execution)?\s+(?:was\s+)?denied|(?:soft\s+)?tool\s+denial|(?:action|command|operation)\s+(?:was\s+)?denied\s+(?:by\s+(?:the\s+)?(?:pre-?tool\s+hook|execution\s+policy|hook|policy|sandbox|security|user|headless|agy|\bmcp\b|permission\s+(?:check|policy))|in\s+(?:headless|non-?interactive)\s+mode)|(?:headless|non-?interactive|agy|pre-?tool\s+hook|execution\s+policy|sandbox|\bmcp\b)[^\r\n]{0,200}(?:confirmation|approval|permission)\s+(?:required|denied|rejected)|(?:confirmation|approval|permission)\s+(?:required|denied|rejected)[^\r\n]{0,200}(?:headless|non-?interactive|pre-?tool\s+hook|execution\s+policy|sandbox|agy|\bmcp\b)|headless\s+mode\s+cannot\s+(?:prompt|request)\s+(?:for\s+)?(?:permission|approval|confirmation)|user\s+denied\s+(?:permission|the\s+tool|tool\s+execution)|denied\s+by\s+(?:the\s+)?(?:pre-?tool\s+hook|execution\s+policy|hook|policy|sandbox|security|user|headless|agy|\bmcp\b|permission\s+(?:check|policy))|(?:not\s+allowed|blocked)\s+by\s+(?:the\s+)?(?:bridge\s+)?(?:pre-?tool\s+hook|execution\s+policy|hook|policy|sandbox|security|headless|agy|\bmcp\b)|failed to prompt user for /i;
const SOFT_TOOL_STATES = new Set(['DENIED', 'BLOCKED', 'REJECTED', 'CANCELED', 'CANCELLED']);

function errorPriority(code: string): number {
  switch (code) {
    case 'AGY_AUTH_REQUIRED': return 6;
    case 'AGY_MCP_PERMISSION_REQUIRED': return 5;
    case 'AGY_SANDBOX_BYPASS_REQUESTED': return 4;
    case 'AGY_SANDBOX_BYPASS_DENIED':
    case 'AGY_SANDBOX_SETUP_REQUIRED':
    case 'AGY_SANDBOX_ACCESS_DENIED':
      return 3;
    default: return 1;
  }
}

function pickHigherPriority(current: BridgeError | undefined, candidate: BridgeError | undefined): BridgeError | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  return errorPriority(candidate.code) > errorPriority(current.code) ? candidate : current;
}

export type CliTextErrorContext = 'stderr' | 'result' | 'tool-error' | 'run-command-output';

export function classifyCliTextError(text: string, context: CliTextErrorContext = 'stderr'): BridgeError | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // Ordinary shell commands (e.g. `gh`, `ssh`, `npm`) can print auth/permission messages on stdout; only classify CLI auth failures from stderr/result/tool-error channels.
  if (context !== 'run-command-output' && CliAdapter.authError(trimmed)) {
    return new BridgeError('AGY_AUTH_REQUIRED', 'Authenticate with the official interactive `agy` command');
  }
  if (MCP_PERMISSION_RE.test(trimmed)) {
    return new BridgeError(
      'AGY_MCP_PERMISSION_REQUIRED',
      'Native agy permission is required for the selected MCP tool. Authorize the exact server/tool in agy settings before retrying; headless cannot request approval.',
    );
  }
  const sandbox = classifySandboxDenial(trimmed);
  if (sandbox) return sandbox;
  const denial = SOFT_DENIAL_RE.exec(trimmed);
  if (denial) {
    return new BridgeError('AGY_PROCESS_FAILED', redactDiagnostic(trimmed.slice(denial.index)).slice(0, 2000));
  }
  return undefined;
}

export function classifyDeniedActions(deniedActions: unknown): BridgeError | undefined {
  if (!Array.isArray(deniedActions) || deniedActions.length === 0) return undefined;
  const names: string[] = [];
  let hasEscalate = false;
  let hasUnsandboxed = false;
  let hasMcp = false;
  for (const item of deniedActions) {
    if (typeof item === 'string') {
      names.push(item);
      if (/escalate_admin/i.test(item)) hasEscalate = true;
      if (/unsandboxed/i.test(item)) hasUnsandboxed = true;
      if (/\bmcp\b/i.test(item)) hasMcp = true;
      continue;
    }
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const action = typeof record.action === 'string' ? record.action : typeof record.name === 'string' ? record.name : typeof record.tool === 'string' ? record.tool : '';
      const reason = typeof record.reason === 'string' ? record.reason : typeof record.message === 'string' ? record.message : '';
      const label = [action, reason].filter(Boolean).join(': ') || JSON.stringify(item);
      names.push(label);
      if (action === 'escalate_admin' || /escalate_admin/i.test(label)) hasEscalate = true;
      if (action === 'unsandboxed' || /unsandboxed/i.test(label)) hasUnsandboxed = true;
      if (/\bmcp\b/i.test(label)) hasMcp = true;
    }
  }
  if (hasEscalate) {
    return new BridgeError(
      'AGY_SANDBOX_SETUP_REQUIRED',
      'The CLI denied administrative sandbox setup for this process. A setup performed in an exited CLI session does not prove that its administrative broker is still available.',
    );
  }
  if (hasUnsandboxed) {
    return new BridgeError(
      'AGY_SANDBOX_BYPASS_DENIED',
      'The runtime reported a denied sandbox bypass. Preserve that denial; do not retry the command through another host execution path.',
    );
  }
  if (hasMcp) {
    return new BridgeError(
      'AGY_MCP_PERMISSION_REQUIRED',
      'Native agy permission is required for the selected MCP tool. Authorize the exact server/tool in agy settings before retrying; headless cannot request approval.',
    );
  }
  const summary = names.map(name => redactDiagnostic(name)).join('; ').slice(0, 1500);
  return new BridgeError('AGY_PROCESS_FAILED', `CLI denied actions despite exit status: ${summary}`);
}

function toResultError(err: unknown, fallbackCode = 'AGY_PROCESS_FAILED'): NonNullable<TaskRecord['error']> {
  if (err instanceof BridgeError) return { code: err.code, message: redactDiagnostic(err.message) || err.code };
  const raw = err instanceof Error ? err.message : String(err);
  return { code: fallbackCode, message: redactDiagnostic(raw) || fallbackCode };
}

function explicitNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class AgyExecutionAdapter implements ExecutionAdapter {
  readonly identity: ExecutionAdapterIdentity = { id: 'agy', provider: 'agy' };
  private observedDiscovery?: Discovery;

  constructor(
    private readonly cli: CliAdapter,
    private readonly config: Config,
    private readonly explicitCapabilities?: ExecutionCapabilities,
  ) {}

  get capabilities(): ExecutionCapabilities {
    if (this.explicitCapabilities) return this.explicitCapabilities;
    const discovery = this.cli.getDiscovery() ?? this.observedDiscovery;
    if (!discovery) {
      return {
        read: 'unknown',
        write: 'unknown',
        sandbox: 'unknown',
        network: 'unknown',
        skills: 'unknown',
        resources: 'unknown',
        structuredOutput: 'unknown',
        cancel: 'unknown',
        resume: 'unknown',
        observableUsage: 'unknown',
      };
    }
    if (!discovery.installed) {
      return {
        read: 'unsupported',
        write: 'unsupported',
        sandbox: 'unsupported',
        network: 'unknown',
        skills: 'unsupported',
        resources: 'unknown',
        structuredOutput: 'unsupported',
        cancel: 'unsupported',
        resume: 'unsupported',
        observableUsage: 'unsupported',
      };
    }
    return {
      read: discovery.capabilities.readOnlyMode ? 'supported' : 'unsupported',
      write: discovery.capabilities.sandbox && discovery.capabilities.streaming ? 'supported' : 'unsupported',
      sandbox: discovery.capabilities.sandbox ? 'supported' : 'unsupported',
      network: 'unknown',
      skills: 'supported',
      resources: 'unknown',
      structuredOutput: discovery.capabilities.structuredOutput ? 'supported' : 'unsupported',
      cancel: discovery.capabilities.cancel ? 'supported' : 'unknown',
      resume: discovery.capabilities.resume ? 'supported' : 'unsupported',
      observableUsage: discovery.capabilities.streaming ? 'supported' : 'unknown',
    };
  }

  private async checkCapabilities(request: ExecutionRequest): Promise<{ code: string; message: string } | undefined> {
    if (!this.explicitCapabilities) {
      const discovery = this.cli.getDiscovery() ?? await this.cli.discover();
      this.observedDiscovery = discovery;
      if (!discovery.installed) {
        const match = discovery.error?.match(/^([A-Z0-9_]+):\s*(.*)$/s);
        return {
          code: match?.[1] || 'AGY_NOT_FOUND',
          message: redactDiagnostic(match?.[2] || discovery.error || 'agy executable not found'),
        };
      }
    }
    try {
      assertExecutionCapabilities(request, this.capabilities);
      return undefined;
    } catch (error) {
      return {
        code: 'AGY_CAPABILITY_UNAVAILABLE',
        message: redactDiagnostic(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  async execute(request: ExecutionRequest, hooks?: AgyExecutionHooks): Promise<AgyExecutionResult> {
    const terminationBefore = this.terminationFromSignal(hooks);
    if (terminationBefore) {
      return this.terminatedResult(request.taskId, terminationBefore, undefined, undefined, undefined, 0);
    }
    const precheckError = await this.checkCapabilities(request);
    const terminationAfterDiscovery = this.terminationFromSignal(hooks);
    if (terminationAfterDiscovery) {
      return this.terminatedResult(request.taskId, terminationAfterDiscovery, undefined, undefined, undefined, 0);
    }
    if (precheckError) {
      return { taskId: request.taskId, status: 'failed', error: precheckError };
    }

    const options: RunOptions = hooks?.runOptions ?? {
      prompt: request.prompt,
      workingDirectory: request.workingDirectory,
      role: request.role,
      model: request.model,
      effort: request.effort,
      sessionId: request.session?.id,
      mode: request.mode,
      outputSchema: request.outputSchema,
      timeoutSeconds: this.config.defaultTimeoutSeconds,
    };
    const spawnCwd = hooks?.spawnWorkingDirectory ?? request.workingDirectory;

    const spawnedAt = Date.now();
    let child: CliProcess;
    try {
      child = this.cli.spawnTask(options, request.model ?? undefined, spawnCwd);
    } catch (error) {
      return { taskId: request.taskId, status: 'failed', error: toResultError(error) };
    }

    const spawnedPid = child.pid;

    let standaloneTermination: 'timeout' | undefined;
    let standaloneTimer: NodeJS.Timeout | undefined;
    const onAbort = () => terminateSubprocess(child);

    let stderr = '';
    let stderrSuppressed = false;
    let uninspectedStdoutLoss = false;
    let uninspectedStderrLoss = false;
    let hookFailure: unknown;
    const stderrRedactor: RedactionState = {};
    let lastWasRedactedKey = false;
    let parseErrors = 0;
    let sessionId = request.session?.id;
    let lastUsage: unknown;
    let resultFrame: Record<string, unknown> | undefined;
    let observedDenial: BridgeError | undefined;
    const redactor = new ResponseRedactor();

    const recordHookFailure = (error: unknown) => {
      if (hookFailure === undefined) hookFailure = error;
      terminateSubprocess(child);
    };

    const safeInvoke = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        recordHookFailure(error);
      }
    };

    const recordDenial = (candidate: BridgeError | undefined) => {
      observedDenial = pickHigherPriority(observedDenial, candidate);
    };

    const emitChunk = (index: number, textDelta: string) => {
      hooks?.onEvent?.('response.chunk', { step_index: index, step_type: 'agent_response', text_delta: textDelta });
    };

    const handleStdoutLine = (line: string) => {
      let source: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected event object');
        source = parsed as Record<string, unknown>;
      } catch {
        parseErrors += 1;
        recordDenial(classifyCliTextError(line));
        hooks?.onParseError?.();
        hooks?.onEvent?.('stream.unparsed', { line: redactDiagnostic(line).slice(0, 4000) });
        return;
      }
      // Everything retained or returned derives from this bounded, redacted copy; the source frame is read only for receipts and response deltas.
      const sanitized = sanitizePayload(source);
      const raw = sanitized.value as Record<string, unknown>;
      if (sanitized.truncated) {
        uninspectedStdoutLoss = true;
        hooks?.onEvent?.('stream.truncated', { maxDepth: DEFAULT_MAX_PAYLOAD_DEPTH, maxNodes: DEFAULT_MAX_PAYLOAD_NODES });
      }
      const sourceType = raw.event;
      if (sourceType === 'init') {
        if (typeof raw.conversation_id === 'string') {
          sessionId = raw.conversation_id;
          hooks?.onSession?.(raw.conversation_id);
        }
        hooks?.onEvent?.('agent.started', raw.init || {}, raw);
        return;
      }
      if (sourceType === 'step_update' && raw.step_update && typeof raw.step_update === 'object') {
        const step = raw.step_update as Record<string, unknown>;
        const sourceStep = source.step_update as Record<string, unknown>;
        if (typeof step.step_index === 'number') {
          hooks?.onNativeStep?.(sourceStep, step.step_index);
        }
        if (step.step_type === 'agent_response' && Number.isSafeInteger(step.step_index)) {
          const index = step.step_index as number;
          if (typeof sourceStep.text_delta === 'string') {
            hooks?.onRawResponseDelta?.(index, sourceStep.text_delta);
            const released = redactor.releaseDelta(index, sourceStep.text_delta, step.state === 'DONE', (stepIdx, maxPendingChars) => {
              hooks?.onEvent?.('response.truncated', { step_index: stepIdx, maxPendingChars });
            });
            step.text_delta = released;
          } else if (step.state === 'DONE') {
            redactor.flushStep(index, emitChunk);
          }
        } else if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
          // Without a usable step index, deltas cannot be joined for redaction, so their text is not retained.
          step.text_delta = '';
        }

        let type = 'step.update';
        let eventData: Record<string, unknown> = step;
        if (step.step_type === 'tool') {
          const result = this.handleToolStep(step, hooks);
          type = result.type;
          eventData = result.eventData;
          recordDenial(result.denial);
        } else if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
          type = 'response.chunk';
        }
        hooks?.onEvent?.(type, eventData, raw);
        if (step.usage !== undefined) {
          lastUsage = step.usage;
          hooks?.onUsage?.(step.usage);
        }
        hooks?.onStreaming?.();
        return;
      }
      if (sourceType === 'result' && raw.result && typeof raw.result === 'object') {
        redactor.flushAll(emitChunk);
        const result = raw.result as Record<string, unknown>;
        if (typeof result.error === 'string') {
          result.error = redactDiagnostic(result.error);
        }
        resultFrame = result;
        if (typeof result.conversation_id === 'string') {
          sessionId = result.conversation_id;
          hooks?.onSession?.(result.conversation_id);
        }
        if (result.usage !== undefined) {
          lastUsage = result.usage;
          hooks?.onUsage?.(result.usage, normalizeUsage(result.usage));
        }
        hooks?.onResultFrame?.(raw.result);
        hooks?.onFinalText?.(result.response, result.structured_output);
        hooks?.onEvent?.('agy.result', result, raw);
        return;
      }
      hooks?.onEvent?.('agy.event', raw, raw);
    };

    const stdoutParser = new LineParser(handleStdoutLine, undefined, () => {
      uninspectedStdoutLoss = true;
      hooks?.onEvent?.('process.output_rejected', { stream: 'stdout', reason: 'line_limit' });
    });
    const stderrParser = new LineParser(line => {
      if (stderrSuppressed) return;
      const redacted = redactDiagnostic(line, stderrRedactor);
      if (redacted === '[private key redacted]') {
        if (!lastWasRedactedKey) {
          lastWasRedactedKey = true;
          stderr = (stderr + '\n' + redacted).slice(-STDERR_BUFFER_LIMIT);
          hooks?.onEvent?.('process.stderr', { text: redacted });
        }
        return;
      }
      lastWasRedactedKey = false;
      // Inspect the full line before truncating retained buffers/events so later eviction cannot erase a real denial.
      recordDenial(classifyCliTextError(redacted));
      stderr = (stderr + '\n' + redacted).slice(-STDERR_BUFFER_LIMIT);
      hooks?.onEvent?.('process.stderr', { text: redacted.slice(0, 4000) });
    }, undefined, () => {
      if (stderrSuppressed) return;
      stderrSuppressed = true;
      uninspectedStderrLoss = true;
      stderr = (stderr + '\n[stderr suppressed after line limit]').slice(-STDERR_BUFFER_LIMIT);
      hooks?.onEvent?.('process.output_rejected', { stream: 'stderr', reason: 'line_limit', remainingStreamSuppressed: true });
    });

    const onStreamError = (error: Error) => {
      const redacted = redactDiagnostic(error.message);
      stderr = (stderr + '\n' + redacted).slice(-STDERR_BUFFER_LIMIT);
      safeInvoke(() => hooks?.onEvent?.('process.error', { message: redacted }));
      if (!this.terminationFromSignal(hooks) && !standaloneTermination) terminateSubprocess(child);
    };

    // Attach close and pipe listeners before any post-spawn hook can throw so pipe errors never go unhandled and cleanup always awaits child termination.
    const closePromise = new Promise<number | null>(resolve => {
      child.once('close', resolve);
    });
    child.stdout.on('data', chunk => {
      if (hookFailure === undefined) safeInvoke(() => stdoutParser.write(chunk));
    });
    child.stderr.on('data', chunk => {
      if (hookFailure === undefined && !stderrSuppressed) safeInvoke(() => stderrParser.write(chunk));
    });
    child.stdout.on('error', onStreamError);
    child.stderr.on('error', onStreamError);
    child.stdin.on('error', onStreamError);
    child.on('error', onStreamError);

    let exitCode: number | null = null;
    let processCleanup: TaskRecord['processCleanup'] | undefined;
    try {
      safeInvoke(() => hooks?.onProcessStarted?.(spawnedPid, Boolean(hooks.repair)));
      if (hookFailure === undefined) {
        if (hooks?.signal) {
          if (hooks.signal.aborted) onAbort();
          else hooks.signal.addEventListener('abort', onAbort, { once: true });
        } else {
          const timeoutSeconds = options.timeoutSeconds ?? this.config.defaultTimeoutSeconds;
          standaloneTimer = setTimeout(() => {
            standaloneTermination = 'timeout';
            terminateSubprocess(child);
          }, timeoutSeconds * 1000);
          standaloneTimer.unref();
        }
      }

      exitCode = await closePromise;
      if (child.pid !== undefined) {
        const cleanup = await reconcileOwnedProcesses({
          pid: child.pid,
          spawnedAt,
          processGroup: isOwnedProcessGroup(child),
        });
        processCleanup = {
          verified: cleanup.verified,
          spawnedAt: new Date(spawnedAt).toISOString(),
          checkedAt: new Date().toISOString(),
          remaining: cleanup.remaining.length,
        };
        safeInvoke(() => {
          hooks?.onProcessCleanup?.(processCleanup!);
          hooks?.onEvent?.('process.cleanup', {
            verified: cleanup.verified,
            method: cleanup.method,
            remaining: cleanup.remaining.length,
          });
        });
      }
      try {
        await hooks?.onAfterProcessExit?.(processCleanup, spawnedPid);
      } catch (error) {
        recordHookFailure(error);
      }
    } finally {
      if (standaloneTimer) clearTimeout(standaloneTimer);
      hooks?.signal?.removeEventListener('abort', onAbort);
      terminateSubprocess(child);
    }

    if (hookFailure === undefined) {
      safeInvoke(() => {
        stdoutParser.end();
        stderrParser.end();
        redactor.flushAll(emitChunk);
      });
    }

    const common = {
      taskId: request.taskId,
      session: sessionId ? { id: sessionId } : undefined,
      raw: resultFrame,
      usage: resultFrame?.usage ?? lastUsage,
      exitCode,
      processCleanup,
      parseErrors,
      spawnedPid,
    };

    const termination = this.terminationFromSignal(hooks) ?? standaloneTermination;
    if (termination) {
      return this.terminatedResult(request.taskId, termination, common.session, common.raw, common.usage, parseErrors, exitCode, processCleanup, spawnedPid);
    }
    if (child.schemaCleanupError) {
      return { ...common, status: 'failed', error: toResultError(child.schemaCleanupError, 'SCHEMA_CLEANUP_FAILED') };
    }
    if (hookFailure !== undefined) {
      return { ...common, status: 'failed', error: toResultError(hookFailure) };
    }
    if (child.startupError) {
      return { ...common, status: 'failed', error: toResultError(child.startupError, 'AGY_IO_FAILED') };
    }
    if (child.communicationError) {
      return { ...common, status: 'failed', error: toResultError(child.communicationError, 'AGY_IO_FAILED') };
    }

    const authCombined = stderr + JSON.stringify(resultFrame || '');
    if (CliAdapter.authError(authCombined)) {
      return {
        ...common,
        status: 'failed',
        error: { code: 'AGY_AUTH_REQUIRED', message: 'Authenticate with the official interactive `agy` command' },
      };
    }

    // Check combined stderr lines & buffer for MCP/sandbox/soft denials missed across line boundaries.
    recordDenial(classifyCliTextError(stderr));
    if (resultFrame) {
      recordDenial(classifyDeniedActions(resultFrame.denied_actions));
      const frameError = explicitNonEmptyString(resultFrame.error);
      if (frameError) recordDenial(classifyCliTextError(frameError, 'result'));
    }

    if (observedDenial && errorPriority(observedDenial.code) >= 3) {
      return { ...common, status: 'failed', error: toResultError(observedDenial) };
    }

    if (resultFrame && Array.isArray(resultFrame.denied_actions) && resultFrame.denied_actions.length > 0) {
      const deniedErr = classifyDeniedActions(resultFrame.denied_actions)!;
      return { ...common, status: 'failed', error: toResultError(deniedErr) };
    }

    const exactStatus = resultFrame && typeof resultFrame.status === 'string' ? resultFrame.status : undefined;
    const statusLabel = exactStatus !== undefined && exactStatus.length > 0
      ? (exactStatus.trim() === exactStatus ? exactStatus : JSON.stringify(exactStatus))
      : 'UNKNOWN';
    const detailReason = resultFrame
      ? explicitNonEmptyString(resultFrame.error) ?? explicitNonEmptyString(resultFrame.reason) ?? explicitNonEmptyString(stderr)
      : explicitNonEmptyString(stderr);

    if (resultFrame && (resultFrame.denied === true || resultFrame.permission_denied === true || resultFrame.incomplete === true)) {
      return {
        ...common,
        status: 'failed',
        error: {
          code: 'AGY_PROCESS_FAILED',
          message: redactDiagnostic(detailReason || `CLI reported an incomplete or denied execution (status ${statusLabel})`),
        },
      };
    }

    if (resultFrame && explicitNonEmptyString(resultFrame.error)) {
      const errText = explicitNonEmptyString(resultFrame.error)!;
      const classified = classifyCliTextError(errText, 'result');
      return {
        ...common,
        status: 'failed',
        error: classified ? toResultError(classified) : { code: 'AGY_PROCESS_FAILED', message: redactDiagnostic(errText) },
      };
    }

    if (observedDenial) {
      return { ...common, status: 'failed', error: toResultError(observedDenial) };
    }

    if (!resultFrame) {
      const fallbackMessage = stderr.trim()
        ? redactDiagnostic(stderr.trim())
        : `agy exited with code ${exitCode} without emitting a result event`;
      return {
        ...common,
        status: 'failed',
        error: { code: parseErrors > 0 ? 'STREAM_PARSE_ERROR' : 'AGY_PROCESS_FAILED', message: fallbackMessage },
      };
    }

    if (exactStatus !== 'SUCCESS') {
      const extraReason = explicitNonEmptyString(resultFrame.reason) ?? explicitNonEmptyString(stderr);
      const message = extraReason
        ? `CLI ended with non-SUCCESS status ${statusLabel}: ${redactDiagnostic(extraReason)}`
        : `CLI ended with non-SUCCESS status ${statusLabel}`;
      return {
        ...common,
        status: 'failed',
        error: {
          code: 'AGY_PROCESS_FAILED',
          message,
        },
      };
    }

    if (exitCode !== 0) {
      return {
        ...common,
        status: 'failed',
        error: {
          code: 'AGY_PROCESS_FAILED',
          message: redactDiagnostic(detailReason || `agy exited with code ${exitCode}`),
        },
      };
    }

    if (uninspectedStdoutLoss || uninspectedStderrLoss) {
      const lostStreams = [
        ...(uninspectedStdoutLoss ? ['stdout'] : []),
        ...(uninspectedStderrLoss ? ['stderr'] : []),
      ];
      return {
        ...common,
        status: 'failed',
        error: {
          code: 'AGY_PROCESS_FAILED',
          message: `CLI output truncated without denial inspection (${lostStreams.join(', ')})`,
        },
      };
    }

    const finalResponse = typeof resultFrame.response === 'string' ? resultFrame.response : '';
    return {
      ...common,
      status: 'completed',
      response: finalResponse,
      structuredOutput: resultFrame.structured_output,
    };
  }

  private handleToolStep(
    step: Record<string, unknown>,
    hooks: AgyExecutionHooks | undefined,
  ): { type: string; eventData: Record<string, unknown>; denial?: BridgeError } {
    const type = step.state === 'DONE' ? 'tool.completed' : step.state === 'ERROR' ? 'tool.failed' : 'tool.started';
    const toolInfo = step.tool_info && typeof step.tool_info === 'object' ? step.tool_info as Record<string, unknown> : undefined;
    const toolError = toolInfo?.error && typeof toolInfo.error === 'object' ? toolInfo.error as Record<string, unknown> : undefined;
    const rawErrorMsg = typeof toolError?.message === 'string' ? toolError.message : undefined;
    const params = toolInfo?.parameters && typeof toolInfo.parameters === 'object' ? toolInfo.parameters as Record<string, unknown> : undefined;
    const editSearch = hooks?.resolveEditMismatch?.(step.tool_name, step.state, rawErrorMsg, params);

    let denial: BridgeError | undefined;
    const stepDenied = classifyDeniedActions(toolInfo?.denied_actions) ?? classifyDeniedActions(step.denied_actions);
    if (stepDenied) denial = pickHigherPriority(denial, stepDenied);

    const stateUpper = typeof step.state === 'string' ? step.state.toUpperCase() : '';
    if (step.denied === true || step.permission_denied === true || toolInfo?.denied === true || toolInfo?.permission_denied === true || SOFT_TOOL_STATES.has(stateUpper)) {
      const reason = rawErrorMsg ?? (typeof toolInfo?.output === 'string' ? toolInfo.output : undefined);
      denial = pickHigherPriority(
        denial,
        classifyCliTextError(reason ?? '', 'tool-error') ?? new BridgeError('AGY_PROCESS_FAILED', redactDiagnostic(reason || `Tool step ${String(step.tool_name ?? '')} ended with state ${stateUpper || 'DENIED'}`)),
      );
    }

    if (step.state === 'ERROR') {
      if (rawErrorMsg) denial = pickHigherPriority(denial, classifyCliTextError(rawErrorMsg, 'tool-error'));
      if (typeof toolInfo?.output === 'string') denial = pickHigherPriority(denial, classifyCliTextError(toolInfo.output, 'tool-error'));
      if (!denial && typeof toolError?.type === 'string' && /(?:hook|permission|policy|deni|reject|block)/i.test(toolError.type)) {
        denial = new BridgeError(
          'AGY_PROCESS_FAILED',
          redactDiagnostic(rawErrorMsg || `Tool step ${String(step.tool_name ?? '')} denied (${toolError.type})`).slice(0, 2000),
        );
      }
      const failure = {
        ...(typeof toolError?.type === 'string' && toolError.type.length <= 64 ? { type: toolError.type } : {}),
        message: rawErrorMsg !== undefined ? redactDiagnostic(rawErrorMsg).slice(0, 500) : 'Tool reported an error without details',
      };
      let eventData: Record<string, unknown> = { ...step, failure, ...(editSearch ? { editSearch } : {}) };
      if (JSON.stringify(eventData).length > MAX_EVENT_PAYLOAD_CHARS) {
        const { conversation_id, step_index, state, step_type, tool_name, duration_seconds } = step;
        eventData = {
          ...(conversation_id !== undefined ? { conversation_id } : {}),
          ...(step_index !== undefined ? { step_index } : {}),
          ...(state !== undefined ? { state } : {}),
          ...(step_type !== undefined ? { step_type } : {}),
          ...(tool_name !== undefined ? { tool_name } : {}),
          ...(duration_seconds !== undefined ? { duration_seconds } : {}),
          failure,
          ...(editSearch ? { editSearch } : {}),
          truncated: true,
        };
      }
      return { type, eventData, denial };
    }

    if (step.state === 'DONE' && step.tool_name === 'run_command' && typeof toolInfo?.output === 'string') {
      const trimmedOutput = toolInfo.output.trim();
      const cmdDenial = classifyCliTextError(trimmedOutput, 'run-command-output');
      if (cmdDenial) denial = pickHigherPriority(denial, cmdDenial);
    }

    return { type, eventData: step, denial };
  }

  private terminationFromSignal(hooks: AgyExecutionHooks | undefined): 'cancelled' | 'timeout' | undefined {
    const fromCallback = hooks?.getTerminationReason?.();
    if (fromCallback) return fromCallback;
    const signal = hooks?.signal;
    if (!signal?.aborted) return undefined;
    return signal.reason === 'timeout' ? 'timeout' : 'cancelled';
  }

  private terminatedResult(
    taskId: string,
    termination: 'cancelled' | 'timeout',
    session: { readonly id: string } | undefined,
    raw: unknown,
    usage: unknown,
    parseErrors: number,
    exitCode?: number | null,
    processCleanup?: TaskRecord['processCleanup'],
    spawnedPid?: number,
  ): AgyExecutionResult {
    return {
      taskId,
      status: termination,
      error: termination === 'timeout'
        ? { code: 'TASK_TIMEOUT', message: 'Task execution timed out' }
        : { code: 'TASK_CANCELLED', message: 'Task cancelled' },
      session,
      raw,
      usage,
      exitCode,
      processCleanup,
      parseErrors,
      spawnedPid,
    };
  }
}
