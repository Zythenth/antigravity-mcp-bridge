import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { CliAdapter } from './cli-adapter.js';
import type { Config } from './config.js';
import { EventStore } from './event-store.js';
import { createWorktree, gitSnapshot } from './git.js';
import { LineParser } from './stream-parser.js';
import { BridgeError, type RunOptions, type TaskRecord } from './types.js';
import { validatePrompt, validateWorkingDirectory } from './validation.js';

interface InternalTask { record: TaskRecord; options: RunOptions; child?: ChildProcessWithoutNullStreams; timer?: NodeJS.Timeout; termination?: 'cancelled' | 'timeout'; parseErrors?: number }
const terminal = new Set(['completed', 'failed', 'cancelled', 'timeout']);

export class TaskManager {
  readonly events: EventStore;
  private readonly tasks = new Map<string, InternalTask>();
  private readonly queue: string[] = [];
  private active = 0;
  private selectedModel?: string;
  private stopped = false;

  constructor(private readonly adapter: CliAdapter, private readonly config: Config) {
    this.events = new EventStore(config.eventBufferSize);
  }

  getModel(): string | undefined { return this.selectedModel; }

  async setModel(model: string): Promise<string> {
    const models = await this.adapter.listModels();
    if (!models.some(item => item.id === model)) throw new BridgeError('MODEL_NOT_AVAILABLE', `Model is not listed by agy: ${model}`);
    this.selectedModel = model;
    return model;
  }

  async run(options: RunOptions): Promise<TaskRecord> {
    if (this.stopped) throw new BridgeError('AGY_PROCESS_FAILED', 'Server is shutting down');
    validatePrompt(options.prompt, this.config.maxPromptChars);
    const workingDirectory = await validateWorkingDirectory(options.workingDirectory, this.config.forbiddenDirectories);
    const timeoutSeconds = options.timeoutSeconds ?? this.config.defaultTimeoutSeconds;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) {
      throw new BridgeError('INVALID_TIMEOUT', 'timeoutSeconds must be between 1 and 86400');
    }
    const model = options.model ?? this.selectedModel;
    if (model) {
      const models = await this.adapter.listModels();
      if (!models.some(item => item.id === model)) throw new BridgeError('MODEL_NOT_AVAILABLE', `Model is not listed by agy: ${model}`);
    }
    if (options.sessionId && !/^[a-zA-Z0-9-]{1,128}$/.test(options.sessionId)) throw new BridgeError('INVALID_SESSION', 'Invalid conversation ID');
    if (this.queue.length >= this.config.maxQueuedTasks && this.active >= this.config.maxConcurrentTasks) {
      throw new BridgeError('QUEUE_FULL', 'Task queue is full');
    }
    if (this.tasks.size >= this.config.maxRetainedTasks) {
      const oldestFinished = [...this.tasks.values()].find(task => terminal.has(task.record.status));
      if (!oldestFinished) throw new BridgeError('QUEUE_FULL', 'Task retention limit reached with active tasks');
      this.tasks.delete(oldestFinished.record.taskId);
      this.events.drop(oldestFinished.record.taskId);
    }
    const record: TaskRecord = { taskId: randomUUID(), sessionId: options.sessionId, model, prompt: options.prompt,
      workingDirectory, status: 'queued', createdAt: new Date().toISOString() };
    this.tasks.set(record.taskId, { record, options: { ...options, workingDirectory, timeoutSeconds } });
    this.queue.push(record.taskId);
    this.events.append(record.taskId, 'task.queued', { workingDirectory, model });
    this.pump();
    return { ...record };
  }

  status(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new BridgeError('TASK_NOT_FOUND', `Unknown task: ${taskId}`);
    return { ...task.record };
  }

  result(taskId: string): { task: TaskRecord; ready: boolean } {
    const task = this.status(taskId);
    return { task, ready: terminal.has(task.status) };
  }

  readEvents(taskId: string, after = 0, limit = 200) {
    this.status(taskId);
    return this.events.read(taskId, after, limit);
  }

  sessions(): Array<{ sessionId: string; taskIds: string[] }> {
    const sessions = new Map<string, string[]>();
    for (const { record } of this.tasks.values()) {
      if (record.sessionId) sessions.set(record.sessionId, [...(sessions.get(record.sessionId) || []), record.taskId]);
    }
    return [...sessions].map(([sessionId, taskIds]) => ({ sessionId, taskIds }));
  }

  async cancel(taskId: string): Promise<TaskRecord> {
    const task = this.tasks.get(taskId);
    if (!task) throw new BridgeError('TASK_NOT_FOUND', `Unknown task: ${taskId}`);
    if (terminal.has(task.record.status)) return this.status(taskId);
    if (task.record.status === 'queued') {
      const index = this.queue.indexOf(taskId);
      if (index !== -1) this.queue.splice(index, 1);
      task.record.status = 'cancelled';
      task.record.error = { code: 'TASK_CANCELLED', message: 'Task cancelled before execution' };
      task.record.completedAt = new Date().toISOString();
      this.events.append(taskId, 'task.cancelled', {});
    } else {
      task.termination = 'cancelled';
      if (task.child) this.terminate(task.child);
    }
    return this.status(taskId);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.tasks.keys()].map(id => this.cancel(id)));
  }

  private pump(): void {
    while (!this.stopped && this.active < this.config.maxConcurrentTasks && this.queue.length) {
      const task = this.tasks.get(this.queue.shift()!);
      if (!task || task.record.status !== 'queued') continue;
      this.active++;
      void this.execute(task).finally(() => { this.active--; this.pump(); });
    }
  }

  private async execute(task: InternalTask): Promise<void> {
    const record = task.record;
    record.status = 'starting';
    record.startedAt = new Date().toISOString();
    this.events.append(record.taskId, 'task.started', {});
    try {
      if (task.options.isolateWorktree) {
        record.worktreePath = await createWorktree(record.workingDirectory);
        record.workingDirectory = await validateWorkingDirectory(record.worktreePath, this.config.forbiddenDirectories);
      }
      record.gitBefore = await gitSnapshot(record.workingDirectory);
      if (task.termination) { this.finish(task, task.termination); return; }
      const child = this.adapter.spawnTask(task.options, record.model, record.workingDirectory);
      task.child = child;
      record.pid = child.pid;
      record.status = 'running';
      this.events.append(record.taskId, 'process.started', { pid: child.pid });
      const timeoutMs = task.options.timeoutSeconds! * 1000;
      task.timer = setTimeout(() => { task.termination = 'timeout'; this.terminate(child); }, timeoutMs);
      let stderr = '';
      const stdoutParser = new LineParser(line => this.handleStdout(task, line));
      const stderrParser = new LineParser(line => {
        stderr = (stderr + '\n' + line).slice(-10000);
        this.events.append(record.taskId, 'process.stderr', { text: line.slice(0, 4000) });
      });
      child.stdout.on('data', chunk => stdoutParser.write(chunk));
      child.stderr.on('data', chunk => stderrParser.write(chunk));
      const exitCode = await new Promise<number | null>(resolve => {
        child.once('error', error => {
          stderr += `\n${error.message}`;
          this.events.append(record.taskId, 'process.error', { message: error.message });
        });
        child.once('close', resolve);
      });
      stdoutParser.end(); stderrParser.end();
      if (task.timer) clearTimeout(task.timer);
      record.exitCode = exitCode;
      record.gitAfter = await gitSnapshot(record.workingDirectory);
      if (task.termination) this.finish(task, task.termination);
      else if (CliAdapter.authError(stderr + JSON.stringify(record.result || ''))) this.finish(task, 'failed', 'AGY_AUTH_REQUIRED', 'Authenticate with the official interactive `agy` command');
      else if (exitCode !== 0 || !record.result || (record.result as { status?: string }).status !== 'SUCCESS') {
        const message = (record.result as { error?: string } | undefined)?.error || `agy exited with code ${exitCode}`;
        this.finish(task, 'failed', !record.result && task.parseErrors ? 'STREAM_PARSE_ERROR' : 'AGY_PROCESS_FAILED', message);
      } else this.finish(task, 'completed');
    } catch (error) {
      const code = error instanceof BridgeError ? error.code : 'AGY_PROCESS_FAILED';
      this.finish(task, 'failed', code, error instanceof Error ? error.message : String(error));
    }
  }

  private handleStdout(task: InternalTask, line: string): void {
    const record = task.record;
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected event object');
      raw = parsed as Record<string, unknown>;
    } catch {
      task.parseErrors = (task.parseErrors || 0) + 1;
      this.events.append(record.taskId, 'stream.unparsed', { line: line.slice(0, 4000) });
      return;
    }
    const sourceType = raw.event;
    if (sourceType === 'init') {
      if (typeof raw.conversation_id === 'string') record.sessionId = raw.conversation_id;
      this.events.append(record.taskId, 'agent.started', raw.init || {}, raw);
    } else if (sourceType === 'step_update' && raw.step_update && typeof raw.step_update === 'object') {
      const step = raw.step_update as Record<string, unknown>;
      let type = 'step.update';
      if (step.step_type === 'tool') type = step.state === 'DONE' ? 'tool.completed' : 'tool.started';
      else if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') type = 'response.chunk';
      this.events.append(record.taskId, type, step, raw);
      if (step.usage !== undefined) record.usage = step.usage;
      if (record.status === 'running') record.status = 'streaming';
    } else if (sourceType === 'result' && raw.result && typeof raw.result === 'object') {
      record.result = raw.result;
      const result = raw.result as Record<string, unknown>;
      if (typeof result.conversation_id === 'string') record.sessionId = result.conversation_id;
      if (result.usage !== undefined) record.usage = result.usage;
      this.events.append(record.taskId, 'agy.result', result, raw);
    } else this.events.append(record.taskId, 'agy.event', raw, raw);
  }

  private finish(task: InternalTask, status: 'completed' | 'failed' | 'cancelled' | 'timeout', code?: string, message?: string): void {
    if (terminal.has(task.record.status)) return;
    task.record.status = status;
    task.record.completedAt = new Date().toISOString();
    if (status === 'timeout') code = 'TASK_TIMEOUT';
    if (status === 'cancelled') code = 'TASK_CANCELLED';
    if (code) task.record.error = { code, message: message || code };
    this.events.append(task.record.taskId, `task.${status}`, task.record.error || { exitCode: task.record.exitCode });
  }

  private terminate(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode !== null || child.killed) return;
    child.kill('SIGINT');
    const grace = setTimeout(() => {
      if (child.exitCode !== null) return;
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
    }, 3000);
    grace.unref();
  }
}
