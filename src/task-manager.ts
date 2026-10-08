import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { CliAdapter, taskPrompt } from './cli-adapter.js';
import type { Config } from './config.js';
import { EventStore } from './event-store.js';
import { createProjectCopy, discardProjectCopy, fingerprintProjectCopy, forkProjectCopy, snapshotCopyFiles, integrateProjectCopy, previewProjectCopy, readProjectPatch, verifyReadOnlyCopy, type ChangePreview, type ProjectCopy } from './isolation.js';
import { LineParser } from './stream-parser.js';
import { BridgeError, type RunOptions, type TaskRecord } from './types.js';
import { validatePrompt, validateRuntimeCacheSeparation, validateWorkingDirectory } from './validation.js';
import { processAlive, StateStore } from './state-store.js';
import { criteriaSchema, verifyCriteria, type ReviewEvidence } from './verification.js';
import { prepareNativeTest, readNativeReceipt, readNativeSandboxError, testCommandSchema, type NativeTestReceipt, type TestCommand, type WindowsNativeTestRequest } from './native-tests.js';
import { textChunk } from './chunks.js';
import { roleSchema, validateRoleReport, resolveRole, listRoles } from './roles.js';
import { aggregateUsage, normalizeUsage, taskTokenUsage } from './usage.js';
import { profileReadOnly } from './tool-profiles.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { BridgeEvent } from './types.js';
import { decisionsSchema, handoffSchema } from './handoff.js';
import { comparisonModelsSchema, compareFindings, type Comparison } from './comparison.js';
import { normalizeSandboxPolicy, resolveSandboxSelection, sandboxPolicyDigest, type SandboxPolicySnapshot } from './sandbox-policy.js';
import { executeWindowsTest, recoverWindowsExecutions } from './windows-executor.js';
import { portableNodeStatus, type PortableNodeStatus } from './portable-node.js';

interface InternalTask { record: TaskRecord; options: RunOptions; ownerPid: number; owned?: boolean; project?: ProjectCopy; releaseProject?: () => void; completion?: Promise<void>; child?: ChildProcessWithoutNullStreams; nativeAbort?: AbortController; timer?: NodeJS.Timeout; termination?: 'cancelled' | 'timeout'; parseErrors?: number; nativeTest?: { nonce: string; commandLine: string; attempts: Array<{ receipt: NativeTestReceipt; output: string }>; steps: Set<number>; failure?: BridgeError } }
const terminal = new Set(['completed', 'failed', 'cancelled', 'timeout']);

export class TaskManager {
  readonly events: EventStore;
  private readonly tasks = new Map<string, InternalTask>();
  private readonly queue: string[] = [];
  private active = 0;
  private waiting = 0;
  private batching = 0;
  private stopped = false;
  private readonly busyProjects = new Set<ProjectCopy>();
  private readonly state: StateStore;
  private readonly nativeRecovery: Promise<void>;
  private nativeRecoveryError: unknown;

  constructor(private readonly adapter: CliAdapter, private readonly config: Config) {
    this.state = new StateStore(config.stateDirectory);
    this.events = new EventStore(config.eventBufferSize, taskId => this.persist(taskId));
    this.nativeRecovery = (config.testExecutor === 'windows-lpac' ? recoverWindowsExecutions(config.stateDirectory) : Promise.resolve())
      .catch(error => { this.nativeRecoveryError = error; });
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
  roles() { return listRoles(this.config.customRoles); }

  getSandboxPolicy(): SandboxPolicySnapshot { return this.state.loadSandboxPolicy(); }
  windowsRuntimeStatus(): Promise<PortableNodeStatus> { return portableNodeStatus(this.config.windowsNodeRuntime, this.config.windowsNodeCacheDirectory); }

  async setSandboxPolicy(value: unknown, expectedSha256: string,
    confirm?: (previous: SandboxPolicySnapshot, proposed: SandboxPolicySnapshot) => Promise<boolean>): Promise<SandboxPolicySnapshot> {
    const previous = this.state.loadSandboxPolicy();
    if (previous.sha256 !== expectedSha256) throw new BridgeError('SANDBOX_POLICY_CHANGED', 'Reload the current sandbox policy before proposing an update');
    const policy = await normalizeSandboxPolicy(value, this.config.stateDirectory, this.config.forbiddenDirectories, this.config, this.config.windowsNodeCacheDirectory);
    const proposed: SandboxPolicySnapshot = { version: 1, policy, sha256: sandboxPolicyDigest(policy) };
    if (!confirm) throw new BridgeError('APPROVAL_REQUIRED', 'Sandbox policy updates require confirmation through the MCP client');
    if (!await confirm(previous, proposed)) throw new BridgeError('APPROVAL_DENIED', 'Sandbox policy update was not confirmed');
    const release = this.state.acquire('sandbox-policy');
    try {
      const current = this.state.loadSandboxPolicy();
      if (current.sha256 !== previous.sha256) throw new BridgeError('SANDBOX_POLICY_CHANGED', 'Sandbox policy changed while confirmation was pending');
      const rechecked = await normalizeSandboxPolicy(value, this.config.stateDirectory, this.config.forbiddenDirectories, this.config, this.config.windowsNodeCacheDirectory);
      if (sandboxPolicyDigest(rechecked) !== proposed.sha256) {
        throw new BridgeError('SANDBOX_POLICY_CHANGED', 'Sandbox policy proposal changed while confirmation was pending');
      }
      this.state.saveSandboxPolicy(proposed);
      return proposed;
    } finally { release(); }
  }

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
    await validateRuntimeCacheSeparation(workingDirectory, this.config.windowsNodeCacheDirectory);
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
    let contextProject: ProjectCopy | undefined;
    let accepted = false;
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
      const roleDefinition = previous?.record.roleDefinition ?? resolveRole(role, this.config.customRoles);
      if (previous && role !== (previous.record.role ?? 'implementer')) throw new BridgeError('INVALID_ROLE', 'A resumed task retains its original role');
      const mode = options.mode ?? previous?.record.mode ?? (roleDefinition.baseRole === 'implementer' ? 'write' : 'read-only');
      if (roleDefinition.baseRole !== 'implementer' && mode !== 'read-only') throw new BridgeError('INVALID_ROLE', 'Roles based on planner and reviewer require read-only mode');
      if (!['write', 'read-only'].includes(mode)) throw new BridgeError('INVALID_MODE', 'mode must be write or read-only');
      if (previous && mode !== previous.record.mode) throw new BridgeError('INVALID_MODE', 'A resumed task must retain its original mode');
      if (this.queue.length >= this.config.maxQueuedTasks && this.active >= this.config.maxConcurrentTasks) {
        throw new BridgeError('QUEUE_FULL', 'Task queue is full');
      }
      options.roleDefinition = roleDefinition;
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
        taskPrompt({ ...options, role, acceptanceCriteria }, this.config.maxPromptChars);
        contextProject = await this.withProject(contextSource.project, async () => {
          if (await fingerprintProjectCopy(contextSource.project!, this.config) !== options.handoff!.treeSha256) throw new BridgeError('CONTEXT_CHANGED', 'Context changed before copying');
          const fork = await forkProjectCopy(contextSource.project!, this.config);
          if (await fingerprintProjectCopy(fork, this.config) !== options.handoff!.treeSha256 ||
            (await previewProjectCopy(fork, this.config)).sha256 !== options.handoff!.patchSha256) {
            await discardProjectCopy(fork);
            throw new BridgeError('CONTEXT_CHANGED', 'Context changed while copying or contains newly ignored files');
          }
          return fork;
        });
      }
      taskPrompt({ ...options, role, acceptanceCriteria }, this.config.maxPromptChars);
      pendingProjectRelease = previous?.project || contextProject ? this.state.acquire(this.projectLock((previous?.project ?? contextProject)!)) : undefined;
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
      const record: TaskRecord = { taskId: randomUUID(), sessionId: options.sessionId, model, mode, role, roleDefinition, prompt: options.prompt,
        acceptanceCriteria, handoff: options.handoff ?? previous?.record.handoff, comparison: options.comparison,
        tests: previous?.record.tests ?? contextSource?.record.tests, usageIsResume: Boolean(previous),
        usageBaseline: previous ? this.latestObservedUsage(previous.record.sessionId, workingDirectory) : undefined,
        workingDirectory, status: 'queued', createdAt: new Date().toISOString() };
      this.tasks.set(record.taskId, { record, ownerPid: process.pid, owned: true, options: { ...options, role, acceptanceCriteria, workingDirectory, timeoutSeconds, mode }, project: previous?.project ?? contextProject, releaseProject: pendingProjectRelease });
      accepted = true;
      pendingProjectRelease = undefined;
      this.queue.push(record.taskId);
      this.events.append(record.taskId, 'task.queued', { workingDirectory, model });
      if (!this.batching) this.pump();
      return { ...record };
    } finally { pendingProjectRelease?.(); releaseRegistry(); if (contextProject && !accepted) await discardProjectCopy(contextProject); }
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

  private latestObservedUsage(sessionId: string | undefined, workingDirectory: string) {
    if (!sessionId) return undefined;
    const observed = [...this.tasks.values()].reverse().find(candidate => candidate.record.sessionId === sessionId && candidate.record.workingDirectory === workingDirectory &&
      (candidate.record.lastObservedCliUsage !== undefined || (candidate.record.result as { usage?: unknown } | undefined)?.usage !== undefined));
    return observed?.record.lastObservedCliUsage ?? (observed ? normalizeUsage((observed.record.result as { usage: unknown }).usage) : undefined);
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
      const tree = task.record.tests?.some(test => test.source === 'agy-tool' || test.source === 'windows-executor') ? await fingerprintProjectCopy(task.project!, this.config) : undefined;
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

  async compare(sourceTaskId: string, expectedContextSha256: string, models: string[], prompt: string, timeoutSeconds?: number) {
    models = comparisonModelsSchema.parse(models);
    const context = await this.context(sourceTaskId);
    if (context.treeSha256 !== expectedContextSha256) throw new BridgeError('CONTEXT_CHANGED', 'Inspect the current context before comparison');
    const available = await this.adapter.listModels();
    for (const model of models) if (!available.some(item => item.id === model)) throw new BridgeError('MODEL_NOT_AVAILABLE', 'Model is not listed by agy: ' + model);
    if (this.config.maxRetainedTasks < models.length + 1 || this.config.maxQueuedTasks < models.length) throw new BridgeError('COMPARISON_LIMIT_EXCEEDED', 'Retention and queue limits must accommodate all comparison members and the source');
    const source = this.status(sourceTaskId);
    const comparison: Comparison = { comparisonId: randomUUID(), sourceTaskId, treeSha256: expectedContextSha256, models, startErrors: [] };
    const taskIds: string[] = [];
    this.batching++;
    try {
      for (const model of models) {
        try {
          const task = await this.run({ contextTaskId: sourceTaskId, expectedContextSha256, role: 'reviewer', mode: 'read-only',
            prompt, model, timeoutSeconds, workingDirectory: source.workingDirectory, comparison });
          taskIds.push(task.taskId);
        } catch (error) {
          if (!taskIds.length) throw error;
          comparison.startErrors.push({ model, code: error instanceof BridgeError ? error.code : 'AGY_PROCESS_FAILED',
            message: error instanceof Error ? error.message : String(error) });
        }
      }
      for (const taskId of taskIds) this.events.append(taskId, 'comparison.queued', { comparisonId: comparison.comparisonId });
      return { comparisonId: comparison.comparisonId, taskIds, models, startErrors: comparison.startErrors };
    } finally { this.batching--; if (!this.batching) this.pump(); }
  }

  async comparison(comparisonId: string) {
    const tasks = this.list().filter(task => task.comparison?.comparisonId === comparisonId);
    const comparison = tasks[0]?.comparison;
    if (!comparison) throw new BridgeError('COMPARISON_NOT_FOUND', 'No retained tasks for this comparison');
    const missingModels = comparison.models.filter(model => !tasks.some(task => task.model === model));
    const ready = tasks.every(task => terminal.has(task.status));
    const complete = ready && !missingModels.length && tasks.every(task => task.status === 'completed' && task.report?.role === 'reviewer');
    const current = await this.context(comparison.sourceTaskId).catch(error => {
      if (error instanceof BridgeError && ['INVALID_CONTEXT', 'TASK_NOT_FOUND', 'TASK_NOT_READY'].includes(error.code)) return null;
      throw error;
    });
    const opinions = await Promise.all(tasks.map(async task => {
      const project = this.tasks.get(task.taskId)?.project;
      const contextMatches = project && terminal.has(task.status) ? await this.withProject(project,
        async () => await fingerprintProjectCopy(project, this.config) === comparison.treeSha256).catch(error => {
          if (error instanceof BridgeError && error.code === 'TASK_NOT_READY') return null;
          throw error;
        }) : null;
      return { taskId: task.taskId, model: task.model!, status: task.status, contextMatches,
        report: task.report?.role === 'reviewer' ? task.report : null, error: task.error ?? null, tokenUsage: task.tokenUsage };
    }));
    return {
      ...comparison, ready, complete: complete && opinions.every(opinion => opinion.contextMatches === true),
      missingModels, contextStale: current === null || current.treeSha256 !== comparison.treeSha256 ||
        opinions.some(opinion => terminal.has(opinion.status) && opinion.contextMatches !== true),
      opinions,
      findings: compareFindings(tasks.filter(task => opinions.some(opinion => opinion.taskId === task.taskId && opinion.contextMatches === true)), comparison.models),
      warnings: ['Findings are model-reported with checked citations, not verified conclusions. Identical means exact matching findings only.',
        'Missing findings, failed opinions and unverified fields do not demonstrate agreement. Codex must inspect and synthesize the reports before making recommendations.'],
    };
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
    const tree = task.record.tests?.some(test => test.source === 'agy-tool' || test.source === 'windows-executor') ? await fingerprintProjectCopy(task.project!, this.config) : undefined;
    const latestTests = new Map((task.record.tests || []).filter(test => test.source === 'agy-tool' || test.source === 'windows-executor').map(test => [test.command, test]));
    if ([...latestTests.values()].some(test => test.sha256 !== sha256 || test.treeSha256 !== tree)) {
      throw new BridgeError('TESTS_STALE', 'Run the observed test commands again against the current files');
    }
    if ([...latestTests.values()].some(test => test.exitCode !== 0 || test.executionError || test.beforeTreeSha256 !== test.treeSha256)) {
      throw new BridgeError('TESTS_FAILED', 'The latest observed command failed or changed project files');
    }
  }

  async startTests(taskId: string, expectedSha256: string, command: TestCommand, retries = 0, timeoutSeconds = 600, sandbox?: unknown) {
    testCommandSchema.parse(command);
    if (!Number.isInteger(retries) || retries < 0 || retries > 3) throw new BridgeError('INVALID_TEST_COMMAND', 'retries must be between 0 and 3');
    const task = this.status(taskId);
    if (!task.sessionId || task.mode === 'read-only') throw new BridgeError('TASK_NOT_READY', 'Tests require a completed write task with a CLI conversation');
    const preview = await this.preview(taskId);
    if (preview.sha256 !== expectedSha256) throw new BridgeError('REVIEW_CHANGED', 'Preview the current patch before starting tests');
    if (this.config.testExecutor === 'windows-lpac') return this.queueWindowsTest(taskId, task, expectedSha256, command, retries, timeoutSeconds, sandbox);
    if (sandbox !== undefined) throw new BridgeError('SANDBOX_PERMISSIONS_UNSUPPORTED', 'Per-test sandbox permissions require the Windows LPAC executor');
    return this.run({ prompt: 'Run the requested tests in the native sandbox.', workingDirectory: task.workingDirectory, sessionId: task.sessionId,
      model: task.model, timeoutSeconds, nativeTest: { ...command, expectedSha256, maxAttempts: retries + 1 } });
  }

  private async queueWindowsTest(sourceTaskId: string, source: TaskRecord, expectedSha256: string, command: TestCommand, retries: number, timeoutSeconds: number, sandbox: unknown): Promise<TaskRecord> {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) {
      throw new BridgeError('INVALID_TIMEOUT', 'timeoutSeconds must be between 1 and 86400');
    }
    const policy = this.state.loadSandboxPolicy();
    const selection = await resolveSandboxSelection(policy.policy, sandbox, source.workingDirectory, this.config.stateDirectory, this.config.forbiddenDirectories, this.config, this.config.windowsNodeCacheDirectory);
    const nativeTest: WindowsNativeTestRequest = { ...command, expectedSha256,
      maxAttempts: retries + 1, backend: 'windows-lpac', sandbox: selection, policySha256: policy.sha256 };
    const releaseRegistry = this.state.acquire('registry');
    let releaseProject: (() => void) | undefined;
    try {
      this.refresh();
      const current = this.tasks.get(sourceTaskId);
      if (!current?.project || !current.record.sessionId || current.record.mode === 'read-only' ||
        !terminal.has(current.record.status) || (current.record.status !== 'completed' && current.record.error?.code !== 'TEST_FAILED') ||
        current.record.integratedAt) {
        throw new BridgeError('TASK_NOT_READY', 'Tests require a completed write task with an isolated copy and CLI conversation');
      }
      if ([...this.tasks.values()].filter(candidate => candidate.project === current.project).at(-1) !== current) {
        throw new BridgeError('TASK_NOT_READY', 'Run tests from the latest retained task for this isolated copy');
      }
      if (this.busyProjects.has(current.project)) throw new BridgeError('TASK_NOT_READY', 'Wait for all operations on this copy to finish');
      const currentPreview = await this.preview(sourceTaskId, false);
      if (currentPreview.sha256 !== nativeTest.expectedSha256) throw new BridgeError('REVIEW_CHANGED', 'Copy changed while tests were queued');
      if (this.queue.length >= this.config.maxQueuedTasks && this.active >= this.config.maxConcurrentTasks) throw new BridgeError('QUEUE_FULL', 'Task queue is full');
      releaseProject = this.state.acquire(this.projectLock(current.project));
      if (this.tasks.size >= this.config.maxRetainedTasks) {
        const oldestFinished = [...this.tasks.values()].find(candidate => terminal.has(candidate.record.status) && candidate !== current) ?? current;
        if (!oldestFinished) throw new BridgeError('QUEUE_FULL', 'Task retention limit reached with active tasks');
        if (oldestFinished !== current && oldestFinished.project && ![...this.tasks.values()].some(other => other !== oldestFinished && other.project === oldestFinished.project)) {
          await this.discard(oldestFinished.record.taskId);
        }
        this.tasks.delete(oldestFinished.record.taskId);
        this.events.drop(oldestFinished.record.taskId);
        this.state.drop(oldestFinished.record.taskId);
      }
      const record: TaskRecord = { taskId: randomUUID(), sessionId: current.record.sessionId, model: current.record.model,
        mode: 'write', role: current.record.role, roleDefinition: current.record.roleDefinition, prompt: 'Run the requested tests in the Windows sandbox.',
        acceptanceCriteria: current.record.acceptanceCriteria, handoff: current.record.handoff, tests: current.record.tests,
        usageIsResume: true, usageBaseline: this.latestObservedUsage(current.record.sessionId, current.record.workingDirectory),
        workingDirectory: current.record.workingDirectory, copyDirectory: current.project.copyDirectory, includedFiles: current.project.includedFiles,
        status: 'queued', createdAt: new Date().toISOString() };
      const options: RunOptions = { prompt: record.prompt, workingDirectory: record.workingDirectory, sessionId: record.sessionId,
        model: record.model, timeoutSeconds, mode: 'write', role: record.role, roleDefinition: record.roleDefinition,
        acceptanceCriteria: record.acceptanceCriteria, nativeTest };
      this.tasks.set(record.taskId, { record, options, ownerPid: process.pid, owned: true, project: current.project, releaseProject });
      releaseProject = undefined;
      this.queue.push(record.taskId);
      this.events.append(record.taskId, 'task.queued', { workingDirectory: record.workingDirectory, model: record.model, backend: 'windows-lpac' });
      if (!this.batching) this.pump();
      return { ...record };
    } finally { releaseProject?.(); releaseRegistry(); }
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
      if (task.nativeAbort) task.nativeAbort.abort();
      else if (task.child) this.terminate(task.child);
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
    while (!this.stopped && !this.batching && this.active < this.config.maxConcurrentTasks && this.queue.length) {
      const task = this.tasks.get(this.queue.shift()!);
      if (!task || task.record.status !== 'queued') continue;
      this.active++;
      task.completion = this.execute(task).finally(() => { task.releaseProject?.(); task.releaseProject = undefined; task.owned = false; this.active--; this.pump(); });
    }
  }

  private async execute(task: InternalTask): Promise<void> {
    const record = task.record;
    if (task.options.nativeTest && 'backend' in task.options.nativeTest && task.options.nativeTest.backend === 'windows-lpac') {
      record.usageProvenance = 'local-executor';
      try { await this.executeWindowsNativeTest(task); }
      catch (error) {
        if (task.termination) this.finish(task, task.termination);
        else this.finish(task, 'failed', error instanceof BridgeError ? error.code : 'WINDOWS_EXECUTION_UNVERIFIED', error instanceof Error ? error.message : String(error));
      }
      return;
    }
    record.status = 'starting';
    record.startedAt = new Date().toISOString();
    this.events.append(record.taskId, 'task.started', {});
    let native: Awaited<ReturnType<typeof prepareNativeTest>> | undefined;
    let readOnlyBaseline: Map<string, string> | undefined;
    try {
      task.project ??= await createProjectCopy(record.workingDirectory, task.options.includePaths, project => {
        task.project = project;
        this.events.append(record.taskId, 'copy.created', { copyDirectory: project.copyDirectory });
      }, this.config);
      task.releaseProject ??= this.state.acquire(this.projectLock(task.project));
      record.copyDirectory = task.project.copyDirectory;
      record.includedFiles = task.project.includedFiles;
      this.events.append(record.taskId, 'copy.ready', { copyDirectory: record.copyDirectory });
      if (record.handoff && !task.options.sessionId) {
        if (await fingerprintProjectCopy(task.project, this.config) !== record.handoff.treeSha256 ||
          (await previewProjectCopy(task.project, this.config)).sha256 !== record.handoff.patchSha256) throw new BridgeError('CONTEXT_CHANGED', 'Queued context copy changed before execution');
        this.events.append(record.taskId, 'context.copied', { sourceTaskId: record.handoff.sourceTaskId, treeSha256: record.handoff.treeSha256 });
      }
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
          if (task.nativeTest!.failure) throw task.nativeTest!.failure;
          const last = attempts.at(-1)?.receipt;
          if (!last || last.exitCode === null || last.error) {
            const denied = (record.result as { denied_actions?: unknown } | undefined)?.denied_actions;
            if (Array.isArray(denied) && denied.some(action => action && typeof action === 'object' && action.action === 'escalate_admin')) {
              throw new BridgeError('AGY_SANDBOX_SETUP_REQUIRED', 'The CLI denied administrative sandbox setup for this process. A setup performed in an exited CLI session does not prove that its administrative broker is still available.');
            }
            throw new BridgeError('TEST_EXECUTION_UNVERIFIED', 'No valid execution receipt from the exact run_command call; check native sandbox permissions');
          }
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
        record.report = await validateRoleReport((record.roleDefinition ?? resolveRole(record.role ?? 'implementer')).baseRole,
          (record.result as { structured_output?: unknown }).structured_output, task.project.copyDirectory);
        this.finish(task, 'completed');
      }
    } catch (error) {
      const code = error instanceof BridgeError ? error.code : 'AGY_PROCESS_FAILED';
      this.finish(task, 'failed', code, error instanceof Error ? error.message : String(error));
    } finally { await native?.cleanup(); }
  }

  private windowsRequest(task: InternalTask): WindowsNativeTestRequest {
    const request = task.options.nativeTest;
    if (!request || !('backend' in request) || request.backend !== 'windows-lpac') {
      throw new BridgeError('WINDOWS_EXECUTION_UNVERIFIED', 'Missing frozen Windows test request');
    }
    return request;
  }

  private async beginWindowsNativeTest(task: InternalTask, request: WindowsNativeTestRequest): Promise<void> {
    await this.nativeRecovery;
    if (this.nativeRecoveryError) throw this.nativeRecoveryError;
    const release = this.state.acquire('sandbox-policy');
    try {
      const current = this.state.loadSandboxPolicy();
      if (current.sha256 !== request.policySha256) {
        throw new BridgeError('SANDBOX_POLICY_CHANGED', 'Sandbox policy changed while this Windows test was queued');
      }
      const selected = await resolveSandboxSelection(current.policy, request.sandbox, task.record.workingDirectory,
        this.config.stateDirectory, this.config.forbiddenDirectories, this.config, this.config.windowsNodeCacheDirectory);
      if (JSON.stringify(selected) !== JSON.stringify(request.sandbox)) {
        throw new BridgeError('SANDBOX_POLICY_CHANGED', 'Sandbox selection changed while this Windows test was queued');
      }
      if (task.termination) return;
      task.record.status = 'starting';
      task.record.startedAt = new Date().toISOString();
      this.events.append(task.record.taskId, 'task.started', { backend: 'windows-lpac', policySha256: request.policySha256 });
    } finally { release(); }
  }

  private remainingSeconds(deadline: number): number {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 0;
    return Math.max(1, Math.ceil(remaining / 1000));
  }

  private async executeWindowsCommand(task: InternalTask, request: WindowsNativeTestRequest, timeoutSeconds: number) {
    if (!task.project) throw new BridgeError('TASK_NOT_READY', 'Windows tests require an isolated project copy');
    const controller = new AbortController();
    task.nativeAbort = controller;
    try {
      return await executeWindowsTest({ executable: request.executable, args: request.args }, task.project.copyDirectory, {
        timeoutSeconds, maxRuntimeBytes: this.config.maxCopyBytes, maxFiles: this.config.maxCopyFiles,
        mode: task.record.mode, stateDirectory: this.config.stateDirectory,
        protectedPaths: [task.record.workingDirectory, this.config.stateDirectory, this.config.windowsNodeCacheDirectory, ...this.config.forbiddenDirectories],
        windowsNodeRuntime: this.config.windowsNodeRuntime, portableNodeCacheDirectory: this.config.windowsNodeCacheDirectory,
        sandbox: request.sandbox, signal: controller.signal,
        onProcess: child => {
          task.child = child;
          task.record.pid = child.pid;
          this.events.append(task.record.taskId, 'process.started', { pid: child.pid, executor: 'windows-lpac' });
        },
      });
    } finally {
      if (task.nativeAbort === controller) task.nativeAbort = undefined;
      task.child = undefined;
    }
  }

  private async repairWindowsTest(task: InternalTask, request: WindowsNativeTestRequest, observedExitCode: number, timeoutSeconds: number): Promise<void> {
    if (!task.project) throw new BridgeError('TASK_NOT_READY', 'Windows test copy is unavailable');
    const { nativeTest: _nativeTest, ...baseOptions } = task.options;
    const options: RunOptions = { ...baseOptions, timeoutSeconds,
      prompt: 'The bridge observed this exact test command exit with code ' + observedExitCode + ': ' +
        JSON.stringify({ executable: request.executable, args: request.args }) +
        '. Make only relevant fixes in the isolated copy. Do not run tests, change the command, weaken assertions, alter sandbox permissions, or change bridge configuration. Stop after the repair so the bridge can rerun the same command.' };
    task.record.result = undefined;
    task.record.usage = undefined;
    const child = this.adapter.spawnTask(options, task.record.model, task.project.copyDirectory);
    task.child = child;
    task.record.pid = child.pid;
    task.record.status = 'running';
    this.events.append(task.record.taskId, 'process.started', { pid: child.pid, repair: true });
    let stderr = '';
    const stdoutParser = new LineParser(line => this.handleStdout(task, line));
    const stderrParser = new LineParser(line => {
      stderr = (stderr + '\n' + line).slice(-10000);
      this.events.append(task.record.taskId, 'process.stderr', { text: line.slice(0, 4000) });
    });
    child.stdout.on('data', chunk => stdoutParser.write(chunk));
    child.stderr.on('data', chunk => stderrParser.write(chunk));
    const exitCode = await new Promise<number | null>(resolve => {
      child.once('error', error => {
        stderr += '\n' + error.message;
        this.events.append(task.record.taskId, 'process.error', { message: error.message });
      });
      child.once('close', resolve);
    });
    stdoutParser.end(); stderrParser.end();
    task.child = undefined;
    task.record.exitCode = exitCode;
    if (task.termination) return;
    if (CliAdapter.authError(stderr + JSON.stringify(task.record.result || ''))) {
      throw new BridgeError('AGY_AUTH_REQUIRED', 'Authenticate with the official interactive `agy` command');
    }
    if (exitCode !== 0 || !task.record.result || (task.record.result as { status?: string }).status !== 'SUCCESS') {
      const message = (task.record.result as { error?: string } | undefined)?.error || `agy repair exited with code ${exitCode}`;
      throw new BridgeError('AGY_PROCESS_FAILED', message);
    }
  }

  private async executeWindowsNativeTest(task: InternalTask): Promise<void> {
    const request = this.windowsRequest(task);
    await this.beginWindowsNativeTest(task, request);
    if (task.termination) { this.finish(task, task.termination); return; }
    if (!task.project) throw new BridgeError('TASK_NOT_READY', 'Windows tests require an isolated project copy');
    const initial = await previewProjectCopy(task.project, this.config);
    if (initial.sha256 !== request.expectedSha256) throw new BridgeError('REVIEW_CHANGED', 'Copy changed while the Windows test was queued');
    const deadline = Date.now() + task.options.timeoutSeconds! * 1000;
    let modelInvoked = false;
    task.timer = setTimeout(() => {
      task.termination = 'timeout';
      if (task.nativeAbort) task.nativeAbort.abort();
      else if (task.child) this.terminate(task.child);
    }, task.options.timeoutSeconds! * 1000);
    try {
      for (let attempt = 1; attempt <= request.maxAttempts; attempt++) {
        if (task.termination) break;
        const remaining = this.remainingSeconds(deadline);
        if (!remaining) { task.termination = 'timeout'; break; }
        const beforePreview = await previewProjectCopy(task.project, this.config);
        const beforeTree = await fingerprintProjectCopy(task.project, this.config);
        if (attempt === 1 && beforePreview.sha256 !== request.expectedSha256) {
          throw new BridgeError('REVIEW_CHANGED', 'Copy changed before the Windows test command started');
        }
        const result = await this.executeWindowsCommand(task, request, remaining);
        const afterTree = await fingerprintProjectCopy(task.project, this.config);
        const afterPreview = await previewProjectCopy(task.project, this.config);
        task.record.exitCode = result.exitCode;
        if (result.exitCode !== null) {
          task.record.tests = [...(task.record.tests || []).slice(-19), {
            command: JSON.stringify({ executable: request.executable, args: request.args }), exitCode: result.exitCode,
            output: result.output, sha256: afterPreview.sha256, beforeSha256: beforePreview.sha256, recordedAt: new Date().toISOString(), source: 'windows-executor',
            treeSha256: afterTree, beforeTreeSha256: beforeTree, executionError: result.error, truncated: result.truncated,
            attempt, testTaskId: task.record.taskId, sandbox: 'windows-lpac', sandboxSelection: request.sandbox,
            sandboxPolicySha256: request.policySha256,
            portableNode: result.portableNode,
          }];
        }
        this.events.append(task.record.taskId, 'test.results', { attempt, exitCode: result.exitCode, sha256: afterPreview.sha256, sandbox: 'windows-lpac' });
        if (task.termination) break;
        if (result.exitCode === null || result.error || result.profileDeleted !== true) {
          throw new BridgeError('TEST_EXECUTION_UNVERIFIED', 'The Windows executor did not return a clean, verified execution receipt');
        }
        if (beforeTree !== afterTree) throw new BridgeError('TEST_CHANGED_PATCH', 'Project files changed during the observed Windows test command');
        if (result.exitCode === 0) {
          if (!modelInvoked) task.record.usageProvenance = 'local-executor';
          this.finish(task, 'completed');
          return;
        }
        if (attempt === request.maxAttempts) {
          if (!modelInvoked) task.record.usageProvenance = 'local-executor';
          this.finish(task, 'failed', 'TEST_FAILED', 'Observed Windows test command failed');
          return;
        }
        const repairSeconds = this.remainingSeconds(deadline);
        if (!repairSeconds) { task.termination = 'timeout'; break; }
        modelInvoked = true;
        task.record.usageProvenance = undefined;
        await this.repairWindowsTest(task, request, result.exitCode, repairSeconds);
      }
      if (task.termination) this.finish(task, task.termination);
    } finally {
      if (task.timer) clearTimeout(task.timer);
      task.timer = undefined;
      task.nativeAbort = undefined;
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
      if (task.nativeTest && typeof step.step_index === 'number' && !task.nativeTest.steps.has(step.step_index)) {
        const failure = readNativeSandboxError(step, task.nativeTest);
        if (failure) {
          if (task.nativeTest.failure?.code !== 'AGY_SANDBOX_BYPASS_REQUESTED') task.nativeTest.failure = failure;
          this.events.append(record.taskId, 'test.blocked', { code: failure.code, message: failure.message });
        }
        const attempt = readNativeReceipt(step, task.nativeTest);
        if (attempt) {
          if (task.nativeTest.failure?.code !== 'AGY_SANDBOX_BYPASS_REQUESTED') task.nativeTest.failure = undefined;
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
      if (result.usage !== undefined) {
        record.usage = result.usage;
        record.lastObservedCliUsage = normalizeUsage(result.usage);
      }
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
