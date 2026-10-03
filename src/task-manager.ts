import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { CliAdapter, taskPrompt } from './cli-adapter.js';
import type { Config } from './config.js';
import { EventStore } from './event-store.js';
import { createProjectCopy, discardProjectCopy, fingerprintProjectCopy, forkProjectCopy, snapshotCopyFiles, integrateProjectCopy, previewProjectCopy, readProjectPatch, verifyReadOnlyCopy, type ChangePreview, type ProjectCopy } from './isolation.js';
import { LineParser } from './stream-parser.js';
import { BridgeError, type RunOptions, type TaskRecord } from './types.js';
import { validatePrompt, validateWorkingDirectory } from './validation.js';
import { processAlive, StateStore } from './state-store.js';
import { criteriaSchema, verifyCriteria, type ReviewEvidence } from './verification.js';
import { prepareNativeTest, readNativeReceipt, testCommandSchema, type NativeTestReceipt, type TestCommand } from './native-tests.js';
import { textChunk } from './chunks.js';
import { roleSchema, validateRoleReport } from './roles.js';
import { aggregateUsage, normalizeUsage, taskTokenUsage } from './usage.js';
import { profileReadOnly } from './tool-profiles.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { BridgeEvent } from './types.js';
import { decisionsSchema, handoffSchema } from './handoff.js';

interface InternalTask { record: TaskRecord; options: RunOptions; ownerPid: number; owned?: boolean; project?: ProjectCopy; releaseProject?: () => void; completion?: Promise<void>; child?: ChildProcessWithoutNullStreams; timer?: NodeJS.Timeout; termination?: 'cancelled' | 'timeout'; parseErrors?: number; nativeTest?: { nonce: string; commandLine: string; attempts: Array<{ receipt: NativeTestReceipt; output: string }>; steps: Set<number> } }
const terminal = new Set(['completed', 'failed', 'cancelled', 'timeout']);

export class TaskManager {
  readonly events: EventStore;
  private readonly tasks = new Map<string, InternalTask>();
  private readonly queue: string[] = [];
  private active = 0;
  private waiting = 0;
  private stopped = false;
  private readonly busyProjects = new Set<ProjectCopy>();
  private readonly state: StateStore;

  constructor(private readonly adapter: CliAdapter, private readonly config: Config) {
    this.state = new StateStore(config.stateDirectory);
    this.events = new EventStore(config.eventBufferSize, taskId => this.persist(taskId));
    this.refresh();
  }

  private persist(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) this.state.save({ record: task.record, options: task.options, project: task.project, ownerPid: task.ownerPid, ...this.events.snapshot(taskId) });
  }

  private projectLock(project: ProjectCopy): string {
    return 'copy-' + createHash('sha256').update(project.copyDirectory).digest('hex');
  }

  private refresh(): void {
    const stored = this.state.load();
    const projects = new Map([...this.tasks.values()].filter(task => task.project && (task.owned || this.busyProjects.has(task.project))).map(task => [task.project!.copyDirectory, task.project!]));
    const ids = new Set(stored.map(task => task.record.taskId));
    for (const [id, task] of this.tasks) if (!ids.has(id) && !task.owned && !this.busyProjects.has(task.project!)) {
      this.tasks.delete(id); this.events.drop(id);
    }
    for (const item of stored) {
      item.record.usageIsResume ??= Boolean(item.options.sessionId);
      const existing = this.tasks.get(item.record.taskId);
      if (existing?.owned || (existing?.project && this.busyProjects.has(existing.project))) continue;
      if (item.project) {
        if (!projects.has(item.project.copyDirectory)) projects.set(item.project.copyDirectory, item.project);
        item.project = projects.get(item.project.copyDirectory);
      }
      const task: InternalTask = { record: item.record, options: item.options, ownerPid: item.ownerPid, project: item.project };
      this.tasks.set(item.record.taskId, task);
      this.events.restore(item.record.taskId, item.events, item.cursor);
      if (!terminal.has(item.record.status) && !processAlive(item.ownerPid)) {
        if (item.record.pid && processAlive(item.record.pid)) {
          item.record.error = { code: 'ORPHAN_PROCESS_RUNNING', message: 'The previous bridge stopped but its recorded process is still alive; no automatic replay or PID-based termination' };
        } else {
          task.ownerPid = process.pid;
          this.finish(task, 'failed', 'SERVER_RESTARTED', 'Previous execution was interrupted; inspect its copy before starting new work');
        }
      }
    }
  }

  getModel(): string | undefined {
    const selection = this.state.loadModel();
    return selection === undefined ? this.config.defaultModel : selection.model ?? undefined;
  }

  get toolProfile() { return this.config.toolProfile; }

  async setModel(model: string | null): Promise<string | null> {
    if (model !== null) {
      const models = await this.adapter.listModels();
      if (!models.some(item => item.id === model)) throw new BridgeError('MODEL_NOT_AVAILABLE', `Model is not listed by agy: ${model}`);
    }
    this.state.saveModel(model);
    return model;
  }

  async run(options: RunOptions): Promise<TaskRecord> {
    if (profileReadOnly(this.config.toolProfile)) {
      if (options.mode === 'write') throw new BridgeError('PROFILE_READ_ONLY', 'This tool profile only permits read-only tasks');
      options = { ...options, mode: 'read-only' };
    }
    if (this.stopped) throw new BridgeError('AGY_PROCESS_FAILED', 'Server is shutting down');
    validatePrompt(options.prompt, this.config.maxPromptChars);
    if (options.acceptanceCriteria !== undefined) criteriaSchema.parse(options.acceptanceCriteria);
    const workingDirectory = await validateWorkingDirectory(options.workingDirectory, this.config.forbiddenDirectories);
    if (options.isolateWorktree === false) throw new BridgeError('ISOLATION_REQUIRED', 'Direct execution in the source project is disabled');
    const timeoutSeconds = options.timeoutSeconds ?? this.config.defaultTimeoutSeconds;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) {
      throw new BridgeError('INVALID_TIMEOUT', 'timeoutSeconds must be between 1 and 86400');
    }
    const model = options.model === null ? undefined : options.model ?? this.getModel();
    if (model) {
      const models = await this.adapter.listModels();
      if (!models.some(item => item.id === model)) throw new BridgeError('MODEL_NOT_AVAILABLE', `Model is not listed by agy: ${model}`);
    }
    if (options.sessionId && !/^[a-zA-Z0-9-]{1,128}$/.test(options.sessionId)) throw new BridgeError('INVALID_SESSION', 'Invalid conversation ID');
    const releaseRegistry = this.state.acquire('registry');
    let pendingProjectRelease: (() => void) | undefined;
    try {
      this.refresh();
      const contextSource = options.contextTaskId ? this.tasks.get(options.contextTaskId) : undefined;
      if (options.contextTaskId && (options.sessionId || !contextSource?.project || contextSource.record.status !== 'completed' ||
        contextSource.record.integratedAt || contextSource.record.workingDirectory !== workingDirectory)) {
        throw new BridgeError('INVALID_CONTEXT', 'Context requires a completed, retained, non-integrated task in the same project; use a new session');
      }
      const previous = options.sessionId ? [...this.tasks.values()].reverse().find(task =>
        task.record.sessionId === options.sessionId && task.record.workingDirectory === workingDirectory && task.project) : undefined;
      if (options.sessionId && (!previous || (previous.record.status !== 'completed' && previous.record.error?.code !== 'TEST_FAILED') || previous.record.integratedAt)) {
        throw new BridgeError('INVALID_SESSION', 'Resume requires a completed, non-integrated task in this project');
      }
      if (previous?.project && this.busyProjects.has(previous.project)) throw new BridgeError('TASK_NOT_READY', 'The copy is being reviewed or removed');
      if (previous && options.includePaths !== undefined) throw new BridgeError('INVALID_INCLUDE_PATH', 'A resumed task reuses its original file selection');
      if (previous && options.acceptanceCriteria !== undefined) throw new BridgeError('INVALID_CRITERIA', 'A resumed task retains its original acceptance criteria');
      options.handoff ??= previous?.record.handoff;
      const acceptanceCriteria = previous?.record.acceptanceCriteria ?? options.acceptanceCriteria ?? contextSource?.record.acceptanceCriteria;
      const role = roleSchema.parse(options.role ?? previous?.record.role ?? 'implementer');
      if (previous && role !== (previous.record.role ?? 'implementer')) throw new BridgeError('INVALID_ROLE', 'A resumed task retains its original role');
      const mode = options.mode ?? previous?.record.mode ?? (role === 'implementer' ? 'write' : 'read-only');
      if (role !== 'implementer' && mode !== 'read-only') throw new BridgeError('INVALID_ROLE', 'Planner and reviewer roles require read-only mode');
      if (!['write', 'read-only'].includes(mode)) throw new BridgeError('INVALID_MODE', 'mode must be write or read-only');
      if (previous && mode !== previous.record.mode) throw new BridgeError('INVALID_MODE', 'A resumed task must retain its original mode');
      if (this.queue.length >= this.config.maxQueuedTasks && this.active >= this.config.maxConcurrentTasks) {
        throw new BridgeError('QUEUE_FULL', 'Task queue is full');
      }
      if (contextSource?.project) {
        if (options.includePaths) throw new BridgeError('INVALID_CONTEXT', 'A context task uses the existing copy selection');
        options.handoff = await this.withProject(contextSource.project, async () => {
          const treeSha256 = await fingerprintProjectCopy(contextSource.project!, this.config);
          const preview = await previewProjectCopy(contextSource.project!, this.config);
          if (treeSha256 !== options.expectedContextSha256) throw new BridgeError('CONTEXT_CHANGED', 'Context files changed; inspect the context again');
          return handoffSchema.parse({
            sourceTaskId: contextSource.record.taskId, sourceRole: contextSource.record.role ?? 'implementer',
            sourceModel: contextSource.record.model ?? null, treeSha256, patchSha256: preview.sha256,
            decisions: { source: 'client-reported', items: decisionsSchema.parse(options.decisions ?? contextSource.record.handoff?.decisions.items ?? []) },
            files: preview.files.map(file => file.path), acceptanceCriteria: contextSource.record.acceptanceCriteria ?? [],
            reports: [...(contextSource.record.handoff?.reports ?? []), ...(contextSource.record.report ?
              [{ taskId: contextSource.record.taskId, role: contextSource.record.report.role, data: contextSource.record.report.data }] : [])],
            tests: (contextSource.record.tests ?? []).map(test => ({ command: test.command, exitCode: test.exitCode, source: test.source, sha256: test.sha256,
              stale: test.sha256 !== preview.sha256 || (test.treeSha256 !== undefined && test.treeSha256 !== treeSha256) })),
          });
        });
      }
      taskPrompt({ ...options, role, acceptanceCriteria }, this.config.maxPromptChars);
      pendingProjectRelease = previous?.project ? this.state.acquire(this.projectLock(previous.project)) : undefined;
      if (this.tasks.size >= this.config.maxRetainedTasks) {
        const oldestFinished = [...this.tasks.values()].find(task => terminal.has(task.record.status) && task !== contextSource);
        if (!oldestFinished) throw new BridgeError('QUEUE_FULL', 'Task retention limit reached with active tasks');
        if (oldestFinished !== previous && oldestFinished.project && ![...this.tasks.values()].some(other => other !== oldestFinished && other.project === oldestFinished.project)) {
          await this.discard(oldestFinished.record.taskId);
        }
        this.tasks.delete(oldestFinished.record.taskId);
        this.events.drop(oldestFinished.record.taskId);
        this.state.drop(oldestFinished.record.taskId);
      }
      const record: TaskRecord = { taskId: randomUUID(), sessionId: options.sessionId, model, mode, role, prompt: options.prompt,
        acceptanceCriteria, handoff: options.handoff ?? previous?.record.handoff, tests: previous?.record.tests ?? contextSource?.record.tests, usageIsResume: Boolean(previous),
        usageBaseline: previous ? normalizeUsage((previous.record.result as { usage?: unknown } | undefined)?.usage) : undefined,
        workingDirectory, status: 'queued', createdAt: new Date().toISOString() };
      this.tasks.set(record.taskId, { record, ownerPid: process.pid, owned: true, options: { ...options, role, acceptanceCriteria, workingDirectory, timeoutSeconds, mode }, project: previous?.project, releaseProject: pendingProjectRelease });
      pendingProjectRelease = undefined;
      this.queue.push(record.taskId);
      this.events.append(record.taskId, 'task.queued', { workingDirectory, model });
      this.pump();
      return { ...record };
    } finally { pendingProjectRelease?.(); releaseRegistry(); }
  }

  status(taskId: string): TaskRecord {
    this.refresh();
    const task = this.tasks.get(taskId);
    if (!task) throw new BridgeError('TASK_NOT_FOUND', `Unknown task: ${taskId}`);
    return { ...task.record, tokenUsage: taskTokenUsage(task.record) };
  }

  list(): TaskRecord[] {
    this.refresh();
    return [...this.tasks.values()].map(task => ({ ...task.record, tokenUsage: taskTokenUsage(task.record) }));
  }

  usage(filters: { taskId?: string; sessionId?: string; model?: string } = {}) {
    if (filters.taskId) this.status(filters.taskId);
    return aggregateUsage(this.list().filter(task => (!filters.taskId || task.taskId === filters.taskId) &&
      (!filters.sessionId || task.sessionId === filters.sessionId) && (!filters.model || task.model === filters.model)));
  }

  result(taskId: string) {
    const task = this.status(taskId);
    return { task, ready: terminal.has(task.status) };
  }

  readResult(taskId: string, offset = 0, limit = 10000, expectedContentSha256?: string) {
    const result = this.result(taskId);
    if (!result.ready) return { ready: false as const, taskId, status: result.task.status };
    return { ready: true as const, taskId, status: result.task.status,
      ...textChunk(JSON.stringify(result.task.result ?? null), offset, limit, expectedContentSha256) };
  }

  async readPatch(taskId: string, expectedSha256: string, relative?: string, offset = 0, limit = 10000) {
    this.refresh();
    const task = this.tasks.get(taskId);
    if (!task?.project || !terminal.has(task.record.status)) throw new BridgeError('TASK_NOT_READY', 'Wait for the task before reading its patch');
    return this.withProject(task.project, async () => {
      const preview = await previewProjectCopy(task.project!, this.config);
      if (preview.sha256 !== expectedSha256) throw new BridgeError('REVIEW_CHANGED', 'The patch changed; preview again before reading');
      const selected = relative?.replaceAll('\\', '/');
      if (selected !== undefined && !preview.files.some(file => file.path === selected)) throw new BridgeError('INVALID_PATCH_PATH', 'Select a changed path from the preview');
      const patch = selected === undefined ? preview.patch : await readProjectPatch(task.project!, selected);
      return { taskId, sha256: preview.sha256, path: selected ?? null, ...textChunk(patch, offset, limit) };
    });
  }

  async preview(taskId: string, includePatch = true) {
    this.refresh();
    const task = this.tasks.get(taskId);
    if (!task || !task.project || !terminal.has(task.record.status)) throw new BridgeError('TASK_NOT_READY', 'Wait for an isolated task to finish');
    return this.withProject(task.project, async () => {
      const preview = await previewProjectCopy(task.project!, this.config);
      const current = task.record.verification && await verifyCriteria(task.project!, preview.sha256, task.record.acceptanceCriteria, task.record.verification.review.evidence);
      const tree = task.record.tests?.some(test => test.source === 'agy-tool') ? await fingerprintProjectCopy(task.project!, this.config) : undefined;
      return { ...preview, patch: includePatch ? preview.patch : undefined, patchLength: preview.patch.length,
        tests: (task.record.tests || []).map(test => ({ ...test, stale: test.sha256 !== preview.sha256 || (test.treeSha256 !== undefined && test.treeSha256 !== tree) })),
        verification: task.record.verification ? { ...task.record.verification, stale: task.record.verification.sha256 !== preview.sha256 ||
          JSON.stringify(current!.fileHashes) !== JSON.stringify(task.record.verification.fileHashes) } : null };
    });
  }

  async context(taskId: string) {
    this.refresh();
    const task = this.tasks.get(taskId);
    if (!task?.project || task.record.status !== 'completed' || task.record.integratedAt) throw new BridgeError('INVALID_CONTEXT', 'Context requires a completed, non-integrated task with a retained copy');
    return this.withProject(task.project, async () => ({
      taskId, treeSha256: await fingerprintProjectCopy(task.project!, this.config),
      role: task.record.role ?? 'implementer', report: task.record.report ?? null, handoff: task.record.handoff ?? null,
      acceptanceCriteria: task.record.acceptanceCriteria ?? [], includedFiles: task.project!.includedFiles,
    }));
  }

  async verify(taskId: string, expectedSha256: string, reviews: ReviewEvidence[] = []) {
    this.refresh();
    const task = this.tasks.get(taskId);
    if (!task?.project || !terminal.has(task.record.status)) throw new BridgeError('TASK_NOT_READY', 'Wait for the task before verification');
    return this.withProject(task.project, async () => {
      const preview = await previewProjectCopy(task.project!, this.config);
      if (preview.sha256 !== expectedSha256) throw new BridgeError('REVIEW_CHANGED', 'Preview the current patch before verification');
      const verification = await verifyCriteria(task.project!, preview.sha256, task.record.acceptanceCriteria, reviews);
      task.record.verification = verification;
      this.events.append(taskId, 'review.verified', { sha256: preview.sha256, status: verification.status });
      return verification;
    });
  }

  private async requireVerification(task: InternalTask, sha256: string): Promise<void> {
    const previous = task.record.verification;
    if (!previous || previous.status !== 'passed') throw new BridgeError('VERIFICATION_REQUIRED', 'All acceptance criteria require artifact checks and grounded Codex review before integration');
    if (previous.sha256 !== sha256) throw new BridgeError('VERIFICATION_STALE', 'Verify the current patch before integration');
    const current = await verifyCriteria(task.project!, sha256, task.record.acceptanceCriteria, previous.review.evidence);
    if (current.status !== 'passed' || JSON.stringify(current.fileHashes) !== JSON.stringify(previous.fileHashes)) {
      throw new BridgeError('VERIFICATION_STALE', 'Verification files or evidence changed; verify again');
    }
    const tree = task.record.tests?.some(test => test.source === 'agy-tool') ? await fingerprintProjectCopy(task.project!, this.config) : undefined;
    const latestTests = new Map((task.record.tests || []).filter(test => test.source === 'agy-tool').map(test => [test.command, test]));
    if ([...latestTests.values()].some(test => test.sha256 !== sha256 || test.treeSha256 !== tree)) {
      throw new BridgeError('TESTS_STALE', 'Run the observed test commands again against the current files');
    }
    if ([...latestTests.values()].some(test => test.exitCode !== 0 || test.executionError || test.beforeTreeSha256 !== test.treeSha256)) {
      throw new BridgeError('TESTS_FAILED', 'The latest observed command failed or changed project files');
    }
  }

  async startTests(taskId: string, expectedSha256: string, command: TestCommand, retries = 0, timeoutSeconds = 600) {
    testCommandSchema.parse(command);
    if (!Number.isInteger(retries) || retries < 0 || retries > 3) throw new BridgeError('INVALID_TEST_COMMAND', 'retries must be between 0 and 3');
    const task = this.status(taskId);
    if (!task.sessionId || task.mode === 'read-only') throw new BridgeError('TASK_NOT_READY', 'Tests require a completed write task with a CLI conversation');
    const preview = await this.preview(taskId);
    if (preview.sha256 !== expectedSha256) throw new BridgeError('REVIEW_CHANGED', 'Preview the current patch before starting tests');
    return this.run({ prompt: 'Run the requested tests in the native sandbox.', workingDirectory: task.workingDirectory, sessionId: task.sessionId,
      model: task.model, timeoutSeconds, nativeTest: { ...command, expectedSha256, maxAttempts: retries + 1 } });
  }

  async recordTest(taskId: string, expectedSha256: string, command: string, exitCode: number, output = '') {
    this.refresh();
    const task = this.tasks.get(taskId);
    if (!task?.project || !terminal.has(task.record.status)) throw new BridgeError('TASK_NOT_READY', 'Wait for the task before recording tests');
    if (!command.trim() || command.length > 1000 || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255 || output.length > 4000) {
      throw new BridgeError('INVALID_TEST_EVIDENCE', 'Invalid command, exit code or output size');
    }
    return this.withProject(task.project, async () => {
      const preview = await previewProjectCopy(task.project!, this.config);
      if (preview.sha256 !== expectedSha256) throw new BridgeError('REVIEW_CHANGED', 'Preview again before recording test evidence');
      const evidence = { command, exitCode, output, sha256: expectedSha256, recordedAt: new Date().toISOString(), source: 'client-reported' as const };
      task.record.tests = [...(task.record.tests || []).slice(-19), evidence];
      this.events.append(taskId, 'review.test-recorded', { command, exitCode, sha256: expectedSha256 });
      return evidence;
    });
  }

  private async withProject<T>(project: ProjectCopy, operation: () => Promise<T>): Promise<T> {
    if (this.busyProjects.has(project) || [...this.tasks.values()].some(task => task.project === project && !terminal.has(task.record.status))) {
      throw new BridgeError('TASK_NOT_READY', 'Wait for all operations on this copy to finish');
    }
    this.busyProjects.add(project);
    let release: (() => void) | undefined;
    try { release = this.state.acquire(this.projectLock(project)); return await operation(); }
    finally { release?.(); this.busyProjects.delete(project); }
  }

  async discard(taskId: string): Promise<TaskRecord> {
    this.refresh();
    const task = this.tasks.get(taskId);
    if (!task) throw new BridgeError('TASK_NOT_FOUND', `Unknown task: ${taskId}`);
    if (!terminal.has(task.record.status)) throw new BridgeError('TASK_NOT_READY', 'Cancel and wait for the task before discarding');
    if (task.project) {
      const project = task.project;
      await this.withProject(project, async () => {
        await discardProjectCopy(project);
        for (const related of this.tasks.values()) if (related.project === project) {
          related.project = undefined;
          related.record.discardedAt = new Date().toISOString();
          this.events.append(related.record.taskId, 'copy.discarded', {});
        }
      });
    }
    return this.status(taskId);
  }

  async cleanup(now = Date.now()): Promise<{ discardedTaskIds: string[] }> {
    this.refresh();
    const discardedTaskIds: string[] = [];
    for (const project of new Set([...this.tasks.values()].map(task => task.project).filter((p): p is ProjectCopy => Boolean(p)))) {
      const related = [...this.tasks.values()].filter(task => task.project === project);
      if (this.busyProjects.has(project) || related.some(task => !terminal.has(task.record.status))) continue;
      const latest = Math.max(...related.map(task => Date.parse(task.record.completedAt || task.record.createdAt)));
      if (now - latest < this.config.copyRetentionHours * 3600000) continue;
      await this.discard(related[0]!.record.taskId);
      discardedTaskIds.push(...related.map(task => task.record.taskId));
    }
    return { discardedTaskIds };
  }

  async integrate(taskId: string, expectedSha256: string, confirm?: (preview: ChangePreview) => Promise<boolean>) {
    this.refresh();
    const task = this.tasks.get(taskId);
    if (!task || !task.project || task.record.status !== 'completed') throw new BridgeError('TASK_NOT_READY', 'Only completed tasks can be integrated');
    if (task.record.integratedAt) throw new BridgeError('ALREADY_INTEGRATED', 'This task was already integrated');
    if (task.record.mode === 'read-only') throw new BridgeError('READ_ONLY_TASK', 'Read-only tasks cannot be integrated');
    if ([...this.tasks.values()].filter(other => other.project === task.project).at(-1) !== task) {
      throw new BridgeError('TASK_NOT_READY', 'Preview and integrate the latest task for this copy');
    }
    if ([...this.tasks.values()].some(other => other !== task && other.project === task.project && !terminal.has(other.record.status))) {
      throw new BridgeError('TASK_NOT_READY', 'Wait for the resumed task to finish');
    }
    return this.withProject(task.project, async () => {
      const reviewed = await previewProjectCopy(task.project!, this.config);
      if (!reviewed.files.length) throw new BridgeError('NO_CHANGES', 'The isolated copy has no changes');
      if (reviewed.sha256 !== expectedSha256) throw new BridgeError('REVIEW_CHANGED', 'Preview the current patch before requesting confirmation');
      if (!confirm) throw new BridgeError('APPROVAL_REQUIRED', 'Integration requires confirmation through the MCP client');
      await this.requireVerification(task, expectedSha256);
      if (!await confirm(reviewed)) throw new BridgeError('APPROVAL_DENIED', 'Integration was not confirmed');
      const releaseSource = this.state.acquire('source-' + createHash('sha256').update(task.record.workingDirectory).digest('hex'));
      try {
        const current = await previewProjectCopy(task.project!, this.config);
        if (current.sha256 !== expectedSha256) throw new BridgeError('REVIEW_CHANGED', 'The copy changed after confirmation');
        await this.requireVerification(task, expectedSha256);
        const preview = await integrateProjectCopy(task.project!, expectedSha256, this.config);
        for (const related of this.tasks.values()) if (related.project === task.project) {
          related.record.integratedAt = new Date().toISOString();
          this.events.append(related.record.taskId, 'copy.integrated', { sha256: expectedSha256, approvalSource: 'mcp-elicitation' });
        }
        return preview;
      } finally { releaseSource(); }
    });
  }

  readEvents(taskId: string, after = 0, limit = 200) {
    this.status(taskId);
    return this.events.read(taskId, after, limit);
  }

  async wait(taskId: string, after = 0, timeoutSeconds = 30, signal?: AbortSignal, onEvent?: (event: BridgeEvent) => Promise<void>) {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60) {
      throw new BridgeError('INVALID_TIMEOUT', 'Wait timeout must be between 1 and 60 seconds');
    }
    if (this.waiting >= this.config.maxConcurrentTasks + this.config.maxQueuedTasks) throw new BridgeError('WAIT_LIMIT_EXCEEDED', 'Too many concurrent waits');
    this.waiting++;
    const deadline = Date.now() + timeoutSeconds * 1000;
    let cursor = after;
    try {
      while (true) {
        if (signal?.aborted) throw new BridgeError('WAIT_CANCELLED', 'Waiting was cancelled; the task continues');
        const task = this.status(taskId);
        const page = this.events.read(taskId, cursor, 1000);
        for (const event of page.events) { await onEvent?.(event); cursor = event.sequence; }
        const ready = terminal.has(task.status);
        if (ready || Date.now() >= deadline) return {
          taskId, status: task.status, ready, timedOut: !ready,
          ...this.events.read(taskId, after, 1000), tokenUsage: task.tokenUsage,
        };
        await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal });
      }
    } catch (error) {
      if (signal?.aborted) throw new BridgeError('WAIT_CANCELLED', 'Waiting was cancelled; the task continues');
      throw error;
    } finally { this.waiting--; }
  }

  sessions(): Array<{ sessionId: string; taskIds: string[] }> {
    this.refresh();
    const sessions = new Map<string, string[]>();
    for (const { record } of this.tasks.values()) {
      if (record.sessionId) sessions.set(record.sessionId, [...(sessions.get(record.sessionId) || []), record.taskId]);
    }
    return [...sessions].map(([sessionId, taskIds]) => ({ sessionId, taskIds }));
  }

  async cancel(taskId: string): Promise<TaskRecord> {
    this.refresh();
    const task = this.tasks.get(taskId);
    if (!task) throw new BridgeError('TASK_NOT_FOUND', `Unknown task: ${taskId}`);
    if (terminal.has(task.record.status)) return this.status(taskId);
    if (!task.owned) throw new BridgeError('TASK_OWNED_BY_OTHER_SERVER', 'Cancel the task in the bridge process that started it');
    if (task.record.status === 'queued') {
      const index = this.queue.indexOf(taskId);
      if (index !== -1) this.queue.splice(index, 1);
      task.record.status = 'cancelled';
      task.record.error = { code: 'TASK_CANCELLED', message: 'Task cancelled before execution' };
      task.record.completedAt = new Date().toISOString();
      this.events.append(taskId, 'task.cancelled', {});
      task.owned = false;
      task.releaseProject?.(); task.releaseProject = undefined;
    } else {
      task.termination = 'cancelled';
      if (task.child) this.terminate(task.child);
    }
    return this.status(taskId);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    const owned = [...this.tasks.values()].filter(task => task.owned);
    await Promise.all(owned.map(task => this.cancel(task.record.taskId)));
    await Promise.all(owned.map(task => task.completion));
  }

  private pump(): void {
    while (!this.stopped && this.active < this.config.maxConcurrentTasks && this.queue.length) {
      const task = this.tasks.get(this.queue.shift()!);
      if (!task || task.record.status !== 'queued') continue;
      this.active++;
      task.completion = this.execute(task).finally(() => { task.releaseProject?.(); task.releaseProject = undefined; task.owned = false; this.active--; this.pump(); });
    }
  }

  private async execute(task: InternalTask): Promise<void> {
    const record = task.record;
    record.status = 'starting';
    record.startedAt = new Date().toISOString();
    this.events.append(record.taskId, 'task.started', {});
    let native: Awaited<ReturnType<typeof prepareNativeTest>> | undefined;
    let readOnlyBaseline: Map<string, string> | undefined;
    try {
      if (!task.project && task.options.contextTaskId) {
        this.refresh();
        const source = this.tasks.get(task.options.contextTaskId);
        if (!source?.project || source.record.status !== 'completed' || source.record.integratedAt) throw new BridgeError('INVALID_CONTEXT', 'Context source is no longer available');
        task.project = await this.withProject(source.project, async () => {
          if (await fingerprintProjectCopy(source.project!, this.config) !== task.options.handoff?.treeSha256) throw new BridgeError('CONTEXT_CHANGED', 'Context changed while the task was queued');
          const fork = await forkProjectCopy(source.project!, this.config);
          if (await fingerprintProjectCopy(fork, this.config) !== task.options.handoff.treeSha256 ||
            (await previewProjectCopy(fork, this.config)).sha256 !== task.options.handoff.patchSha256) {
            await discardProjectCopy(fork);
            throw new BridgeError('CONTEXT_CHANGED', 'Context changed while copying or contains newly ignored files');
          }
          return fork;
        });
        this.events.append(record.taskId, 'context.copied', { sourceTaskId: task.options.contextTaskId, treeSha256: task.options.handoff?.treeSha256 });
      }
      task.project ??= await createProjectCopy(record.workingDirectory, task.options.includePaths, project => {
        task.project = project;
        this.events.append(record.taskId, 'copy.created', { copyDirectory: project.copyDirectory });
      }, this.config);
      task.releaseProject ??= this.state.acquire(this.projectLock(task.project));
      record.copyDirectory = task.project.copyDirectory;
      record.includedFiles = task.project.includedFiles;
      this.events.append(record.taskId, 'copy.ready', { copyDirectory: record.copyDirectory });
      if (record.mode === 'read-only' && record.handoff) readOnlyBaseline = await snapshotCopyFiles(task.project, this.config);
      if (task.termination) { this.finish(task, task.termination); return; }
      if (task.options.nativeTest) {
        const preview = await previewProjectCopy(task.project, this.config);
        if (preview.sha256 !== task.options.nativeTest.expectedSha256) throw new BridgeError('REVIEW_CHANGED', 'Copy changed while tests were queued');
        native = await prepareNativeTest(task.project, task.options.nativeTest, { timeoutSeconds: task.options.timeoutSeconds!,
          maxCopyFiles: this.config.maxCopyFiles, maxCopyBytes: this.config.maxCopyBytes });
        task.nativeTest = { nonce: native.nonce, commandLine: native.commandLine, attempts: [], steps: new Set() };
      }
      const child = this.adapter.spawnTask(native ? { ...task.options, prompt: native.prompt } : task.options, record.model, task.project.copyDirectory);
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
      if (native) {
        await native.cleanup(); native = undefined;
        const preview = await previewProjectCopy(task.project, this.config);
        const tree = await fingerprintProjectCopy(task.project, this.config);
        const attempts = task.nativeTest!.attempts;
        for (const [index, attempt] of attempts.entries()) {
          const receipt = attempt.receipt;
          record.tests = [...(record.tests || []).slice(-19), {
            command: JSON.stringify({ executable: task.options.nativeTest!.executable, args: task.options.nativeTest!.args }),
            exitCode: receipt.exitCode ?? 255, output: attempt.output, sha256: receipt.afterSha256 === tree ? preview.sha256 : task.options.nativeTest!.expectedSha256,
            recordedAt: new Date().toISOString(), source: 'agy-tool', treeSha256: receipt.afterSha256, beforeTreeSha256: receipt.beforeSha256,
            executionError: receipt.error, truncated: receipt.truncated, attempt: index + 1, testTaskId: record.taskId, sandbox: 'agy-native-requested',
          }];
        }
        this.events.append(record.taskId, 'test.results', { attempts: attempts.length, sha256: preview.sha256 });
        if (!task.termination) {
          const last = attempts.at(-1)?.receipt;
          if (!last || last.exitCode === null || last.error) throw new BridgeError('TEST_EXECUTION_UNVERIFIED', 'No valid execution receipt from the exact run_command call; check native sandbox permissions');
          if (last.beforeSha256 !== last.afterSha256 || last.afterSha256 !== tree) throw new BridgeError('TEST_CHANGED_PATCH', 'Project files changed during or after the test; run tests again');
          if (last.exitCode !== 0) { this.finish(task, 'failed', 'TEST_FAILED', 'Observed test command failed'); return; }
        }
      }
      if (record.mode === 'read-only') await verifyReadOnlyCopy(task.project, readOnlyBaseline);
      if (task.termination) this.finish(task, task.termination);
      else if (CliAdapter.authError(stderr + JSON.stringify(record.result || ''))) this.finish(task, 'failed', 'AGY_AUTH_REQUIRED', 'Authenticate with the official interactive `agy` command');
      else if (exitCode !== 0 || !record.result || (record.result as { status?: string }).status !== 'SUCCESS') {
        const message = (record.result as { error?: string } | undefined)?.error || `agy exited with code ${exitCode}`;
        this.finish(task, 'failed', !record.result && task.parseErrors ? 'STREAM_PARSE_ERROR' : 'AGY_PROCESS_FAILED', message);
      } else {
        if (record.mode !== 'read-only') await previewProjectCopy(task.project, this.config);
        record.report = await validateRoleReport(record.role ?? 'implementer', (record.result as { structured_output?: unknown }).structured_output, task.project.copyDirectory);
        this.finish(task, 'completed');
      }
    } catch (error) {
      const code = error instanceof BridgeError ? error.code : 'AGY_PROCESS_FAILED';
      this.finish(task, 'failed', code, error instanceof Error ? error.message : String(error));
    } finally { await native?.cleanup(); }
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
      if (task.nativeTest && typeof step.step_index === 'number' && !task.nativeTest.steps.has(step.step_index)) {
        const attempt = readNativeReceipt(step, task.nativeTest);
        if (attempt) {
          task.nativeTest.steps.add(step.step_index);
          task.nativeTest.attempts.push(attempt);
          this.events.append(record.taskId, 'test.executed', { attempt: task.nativeTest.attempts.length, exitCode: attempt.receipt.exitCode });
          if (task.nativeTest.attempts.length > task.options.nativeTest!.maxAttempts) {
            task.termination = 'cancelled';
            if (task.child) this.terminate(task.child);
          }
        }
      }
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
