import { type WorkflowHook, type WorkflowCheckpoint, type WorkflowInput } from './workflows.js';
import { observeGroupBudget, requireGroupBudget } from './group-budget.js';
import { extractPeerMessages, peerOriginSchema, peerContextSchema, isPeerRouteAllowed, type PeerOrigin } from './peer-messages.js';
import { GroupStore } from './group-store.js';
import { jointWaitPage, waitTargetsSchema } from './joint-wait.js';
import { groupAdmissionSchema, type GroupAdmission } from './group-contract.js';
import { GroupManager } from './group-manager.js';
import { ProjectMemoryStore, type MemorySnapshot } from './project-memory.js';
import { memorySelectionSchema, memorySnapshotsSchema, summarizeMemory } from './memory-context.js';
import { validateProjectRoot } from './isolation.js';
import { createHash, randomUUID } from 'node:crypto';
import { readExecutionPolicyReceipt } from './execution-policy.js';
import { agentPolicySelectionSchema, resolveAgentPolicy, type ResolvedAgentPolicy } from './agent-policy.js';
import { integrationPreauthorized } from './integration-policy.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendMessage, deliveryModeSchema, extractAgentMessages, readMessages, resultReference, type DeliveryMode } from './messages.js';
import { MAX_TOTAL_BUNDLES_BYTES, providedSkillsSchema, verifyProvidedSkills } from './skills.js';
import { CliAdapter, taskPrompt, type CliProcess } from './cli-adapter.js';
import type { Config } from './config.js';
import { EventStore } from './event-store.js';
import { createProjectCopy, stageProjectExecutionPolicy, verifyManagedCopy, discardProjectCopy, fingerprintProjectCopy, forkProjectCopy, snapshotCopyFiles, integrateProjectCopy, previewProjectCopy, readProjectPatch, verifyReadOnlyCopy, type ChangePreview, type ProjectCopy } from './isolation.js';
import { LineParser } from './stream-parser.js';
import { BridgeError, type RunOptions, type TaskRecord, type CallerInboxItem, type CallerMessageReceipt } from './types.js';
import { validatePrompt, validateRuntimeCacheSeparation, validateWorkingDirectory, validateStateSeparation } from './validation.js';
import { processAlive, StateStore } from './state-store.js';
import { criteriaSchema, verifyCriteria, type ReviewEvidence } from './verification.js';
import { prepareNativeTest, readNativeReceipt, readNativeSandboxError, testCommandSchema, type NativeTestReceipt, type TestCommand, type WindowsNativeTestRequest } from './native-tests.js';
import { textChunk } from './chunks.js';
import { roleSchema, validateRoleReport, resolveRole, listRoles, applyRoleDefaults, effortSchema } from './roles.js';
import { aggregateUsage, normalizeUsage, taskTokenUsage } from './usage.js';
import { profileReadOnly } from './tool-profiles.js';
import { setTimeout as delay } from 'node:timers/promises';
import { validateOutputSchema, validateStructuredResult } from './structured-results.js';
import { artifactPathsSchema, collectArtifacts, readArtifact } from './artifacts.js';
import type { BridgeEvent } from './types.js';
import { decisionsSchema, handoffSchema } from './handoff.js';
import { comparisonModelsSchema, compareFindings, type Comparison } from './comparison.js';
import { normalizeSandboxPolicy, resolveSandboxSelection, sandboxPolicyDigest, type SandboxPolicySnapshot } from './sandbox-policy.js';
import { executeWindowsTest, recoverWindowsExecutions } from './windows-executor.js';
import { portableNodeStatus, type PortableNodeStatus } from './portable-node.js';

interface InternalTask { publicResponses?: Map<number, string>; messageKeys?: Set<string>; responseChars?: number; messageBufferLimited?: boolean; messageLimitReported?: boolean; record: TaskRecord; options: RunOptions; ownerPid: number; owned?: boolean; project?: ProjectCopy; releaseProject?: () => void; completion?: Promise<void>; child?: ChildProcessWithoutNullStreams; nativeAbort?: AbortController; timer?: NodeJS.Timeout; termination?: 'cancelled' | 'timeout'; parseErrors?: number; nativeTest?: { nonce: string; commandLine: string; attempts: Array<{ receipt: NativeTestReceipt; output: string }>; steps: Set<number>; failure?: BridgeError } }
const terminal = new Set(['completed', 'failed', 'cancelled', 'timeout']);

export class TaskManager {
  readonly events: EventStore;
  private readonly tasks = new Map<string, InternalTask>();
  private readonly queue: string[] = [];
  private active = 0;
  private waiting = 0;
  private batching = 0;
  private stopped = false;
  private readonly inboxOwnerId = randomUUID();
  private readonly flushingInboxes = new Set<string>();
  private readonly claimingMessages = new Set<string>();
  private readonly busyProjects = new Set<ProjectCopy>();
  private readonly state: StateStore;
  private memoryStore?: ProjectMemoryStore;
  private groupManager?: GroupManager;
  get groups(): GroupManager { return this.groupManager ??= new GroupManager(this, this.config); }
  runInGroup(options: RunOptions, admission: GroupAdmission) { return this.run({ ...options, role: admission.owner, groupAdmission: groupAdmissionSchema.parse(admission) }); }
  private readonly nativeRecovery: Promise<void>;
  private nativeRecoveryError: unknown;

  constructor(private readonly adapter: CliAdapter, private readonly config: Config) {
    this.state = new StateStore(config.stateDirectory);
    this.events = new EventStore(config.eventBufferSize, taskId => this.persist(taskId));
    this.nativeRecovery = (config.testExecutor === 'windows-lpac' ? recoverWindowsExecutions(config.stateDirectory) : Promise.resolve())
      .catch(error => { this.nativeRecoveryError = error; });
    this.refresh();
    this.recoverInboxClaims();
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
  get preauthorizedProjectCount() { return this.config.preauthorizedIntegrationRoots.length; }
  integrationPreauthorized(taskId: string) { return integrationPreauthorized(this.status(taskId).workingDirectory, this.config.preauthorizedIntegrationRoots); }
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

  private checkAgentPolicySnapshot(saved: ResolvedAgentPolicy): ResolvedAgentPolicy {
    const current = resolveAgentPolicy({ allowedTools: saved.nativeTools, mcpServers: saved.mcpServers.map(server => ({ serverId: server.serverId, tools: server.tools })) }, this.config.allowedAgyTools, this.config.mcpCatalog, saved.mode, '28c48913-763e-4ced-aee4-3fe6f0dd25eb');
    if (current.sha256 !== saved.sha256) throw new BridgeError('AGENT_POLICY_CHANGED', 'The human-configured tool catalog or ceiling changed; start a new task');
    return structuredClone(saved);
  }

  agentPolicyCatalog() {
    const namespace = '28c48913-763e-4ced-aee4-3fe6f0dd25eb';
    return { allowedTools: [...this.config.allowedAgyTools], mcpServers: this.config.mcpCatalog.map(entry => ({
      id: entry.id, description: entry.description ?? null,
      nativeServerName: entry.nativeServerName ?? 'bridge_' + namespace.replaceAll('-', '') + '_' + entry.id.replaceAll('-', '_'),
      tools: structuredClone(entry.tools),
    })) };
  }

  private projectMemory(): ProjectMemoryStore {
    return this.memoryStore ??= new ProjectMemoryStore(this.config.stateDirectory, {
      maxEntries: this.config.memoryMaxEntries, maxBytes: this.config.memoryMaxBytes, maxEntryBytes: this.config.memoryMaxEntryBytes,
    });
  }

  private async memoryProject(workingDirectory: string): Promise<string> {
    const directory = await validateWorkingDirectory(workingDirectory, this.config.forbiddenDirectories);
    await validateRuntimeCacheSeparation(directory, this.config.windowsNodeCacheDirectory);
    await validateProjectRoot(directory);
    return directory;
  }

  async listMemory(workingDirectory: string) {
    const directory = await this.memoryProject(workingDirectory), store = this.projectMemory();
    return { memories: await store.list(directory), limits: store.limits };
  }

  async readMemory(workingDirectory: string, specialist: string, expectedSha256: string, offset = 0, limit = 10000) {
    const entry = await this.projectMemory().read(await this.memoryProject(workingDirectory), specialist);
    if (!entry) throw new BridgeError('MEMORY_NOT_FOUND', 'Selected memory does not exist');
    if (entry.sha256 !== expectedSha256) throw new BridgeError('MEMORY_CHANGED', 'Reload memory metadata before reading the current version');
    return { memory: summarizeMemory([entry])![0]!, ...textChunk(entry.text, offset, limit) };
  }

  async writeMemory(workingDirectory: string, specialist: string, text: string, expectedSha256: string | null) {
    if (profileReadOnly(this.config.toolProfile)) throw new BridgeError('PROFILE_READ_ONLY', 'This profile cannot change private memory');
    const entry = await this.projectMemory().write(await this.memoryProject(workingDirectory), specialist, { text, expectedSha256 });
    return { memory: summarizeMemory([entry])![0]! };
  }

  async removeMemory(workingDirectory: string, specialist: string, expectedSha256: string) {
    if (profileReadOnly(this.config.toolProfile)) throw new BridgeError('PROFILE_READ_ONLY', 'This profile cannot remove private memory');
    return this.projectMemory().remove(await this.memoryProject(workingDirectory), specialist, expectedSha256);
  }

  async run(options: RunOptions): Promise<TaskRecord> {
    options = { ...options };
    delete options.group;
    if (!options.groupAdmission) delete options.peerContext;
    else if (options.peerContext) {
      options.peerContext = peerContextSchema.parse(options.peerContext);
      if (options.peerContext.groupId.toLowerCase() !== options.groupAdmission.groupId.toLowerCase() || options.peerContext.nodeKey !== options.groupAdmission.nodeKey) throw new BridgeError('INVALID_GROUP', 'Peer context differs from group admission');
    }
    if (!options.sourceMessage) delete options.peerOrigin;
    if (options.groupAdmission && options.sessionId) throw new BridgeError('INVALID_GROUP', 'Group admission starts a new session');
    delete options.memorySnapshots; // Internal snapshots are resolved only by the bridge.
    const initialRoleDefinition = options.sessionId ? undefined : resolveRole(options.role ?? 'implementer', this.config.customRoles);
    if (initialRoleDefinition) {
      const { skills, includePaths, memory } = options;
      options = applyRoleDefaults(options, initialRoleDefinition);
      if (options.contextTaskId) options = { ...options, skills, includePaths, memory };
    }
    if (options.groupAdmission && options.mcpServers === undefined) options.mcpServers = [];
    if (options.memory !== undefined) options.memory = memorySelectionSchema.parse(options.memory);
    if (options.effort !== undefined) effortSchema.parse(options.effort);
    if (profileReadOnly(this.config.toolProfile)) {
      if (options.mode === 'write') throw new BridgeError('PROFILE_READ_ONLY', 'This tool profile only permits read-only tasks');
      options = { ...options, mode: 'read-only' };
    }
    if (this.stopped) throw new BridgeError('AGY_PROCESS_FAILED', 'Server is shutting down');
    validatePrompt(options.prompt, this.config.maxPromptChars);
    if (options.deliveryMode !== undefined) deliveryModeSchema.parse(options.deliveryMode);
    if (options.skills !== undefined) {
      const parsed = providedSkillsSchema.safeParse(options.skills);
      if (!parsed.success) throw new BridgeError('INVALID_SKILL_INPUT', 'Invalid supplied skill bundles');
      const bytes = parsed.data.reduce((sum, skill) => sum + Buffer.byteLength(skill.content, 'utf8') + (skill.resources ?? []).reduce((n, file) => n + Buffer.byteLength(file.content, 'utf8'), 0), 0);
      if (bytes > MAX_TOTAL_BUNDLES_BYTES) throw new BridgeError('COPY_LIMIT_EXCEEDED', 'Supplied skills exceed the 1 MiB text budget');
      options = { ...options, skills: parsed.data };
    }
    if (options.acceptanceCriteria !== undefined) criteriaSchema.parse(options.acceptanceCriteria);
    if (options.outputSchema !== undefined) options.outputSchema = validateOutputSchema(options.outputSchema);
    if (options.artifactPaths !== undefined) options.artifactPaths = [...artifactPathsSchema.parse(options.artifactPaths)];
    const workingDirectory = await validateWorkingDirectory(options.workingDirectory, this.config.forbiddenDirectories);
    await validateRuntimeCacheSeparation(workingDirectory, this.config.windowsNodeCacheDirectory);
    if (options.groupAdmission) {
      await validateStateSeparation(workingDirectory, this.config.stateDirectory);
      if (options.workingDirectory !== workingDirectory) throw new BridgeError('GROUP_CHANGED', 'Group project no longer resolves to its saved canonical directory');
    }
    if (options.isolateWorktree === false) throw new BridgeError('ISOLATION_REQUIRED', 'Direct execution in the source project is disabled');
    if (options.sessionId && !/^[a-zA-Z0-9-]{1,128}$/.test(options.sessionId)) throw new BridgeError('INVALID_SESSION', 'Invalid conversation ID');
    const releaseRegistry = this.state.acquire('registry');
    let pendingProjectRelease: (() => void) | undefined;
    let contextProject: ProjectCopy | undefined;
    let accepted = false;
    try {
      this.refresh();
      if (options.groupAdmission) {
        const admission = groupAdmissionSchema.parse(options.groupAdmission);
        const existing = [...this.tasks.values()].find(task => task.record.group?.groupId.toLowerCase() === admission.groupId.toLowerCase() &&
          task.record.group.nodeKey === admission.nodeKey && task.record.group.rootTaskId.toLowerCase() === task.record.taskId.toLowerCase());
        if (existing) {
          if (existing.record.workingDirectory !== workingDirectory || existing.record.group!.definitionSha256 !== admission.definitionSha256 ||
              existing.record.group!.owner !== admission.owner) throw new BridgeError('INVALID_GROUP', 'Group admission identity changed');
          return this.status(existing.record.taskId);
        }
      }
      const contextSource = options.contextTaskId ? this.tasks.get(options.contextTaskId) : undefined;
      if (options.contextTaskId && (options.sessionId || !contextSource?.project || contextSource.record.status !== 'completed' ||
        contextSource.record.integratedAt || contextSource.record.workingDirectory !== workingDirectory)) {
        throw new BridgeError('INVALID_CONTEXT', 'Context requires a completed, retained, non-integrated task in the same project; use a new session');
      }
      const previous = options.sessionId ? [...this.tasks.values()].reverse().find(task =>
        task.record.sessionId === options.sessionId && task.record.workingDirectory === workingDirectory && task.project && !(task.record.error?.code === 'STATE_PERSISTENCE_FAILED' && !task.record.startedAt)) : undefined;
      if (options.sessionId && (!previous || (previous.record.status !== 'completed' && previous.record.error?.code !== 'TEST_FAILED') || previous.record.integratedAt)) {
        throw new BridgeError('INVALID_SESSION', 'Resume requires a completed, non-integrated task in this project');
      }
      if (previous?.record.group) options.parentTaskId = previous.record.taskId;
      if (previous?.record.group && new GroupStore(this.config.stateDirectory).read(previous.record.group.groupId).state !== 'running') throw new BridgeError('GROUP_CLOSED', 'Start or resume the group coordinator before another conversation turn');
      if (previous?.record.group) {
        const group = new GroupStore(this.config.stateDirectory).read(previous.record.group.groupId);
        if (group.definition.workflow && group.nodes[previous.record.group.nodeKey]?.checkpoint) throw new BridgeError('WORKFLOW_NODE_CLOSED', 'Checkpointed workflow outputs cannot be changed by another conversation turn');
      }
      const budgetGroup = options.groupAdmission ?? previous?.record.group;
      if (budgetGroup) this.checkGroupBudget(budgetGroup.groupId);
      if (previous?.project && this.busyProjects.has(previous.project)) throw new BridgeError('TASK_NOT_READY', 'The copy is being reviewed or removed');
      if (previous && !previous.record.agentPolicy && this.config.enforceAgentPolicy) throw new BridgeError('AGENT_POLICY_CHANGED', 'This legacy session has no enforced policy; start a new task under the configured human ceiling');
      if (previous && (options.allowedTools !== undefined || options.mcpServers !== undefined)) throw new BridgeError('INVALID_AGENT_POLICY', 'Resume retains its original tool policy; use a new task to select different tools');
      if (previous && options.includePaths !== undefined) throw new BridgeError('INVALID_INCLUDE_PATH', 'A resumed task reuses its original file selection');
      if (previous && options.acceptanceCriteria !== undefined) throw new BridgeError('INVALID_CRITERIA', 'A resumed task retains its original acceptance criteria');
      if ((previous || contextSource) && options.skills !== undefined) throw new BridgeError('INVALID_SKILLS', 'Resume and handoff retain supplied skills; new bundles require a new task');
      if (previous && options.outputSchema !== undefined) throw new BridgeError('INVALID_SCHEMA', 'A resumed task retains its original structured output schema');
      if (previous && options.artifactPaths !== undefined) throw new BridgeError('INVALID_ARTIFACT_PATHS', 'A resumed task retains its original artifact paths');
      if (previous && options.memory !== undefined) throw new BridgeError('INVALID_MEMORY_SELECTION', 'Resume retains its original private memory snapshots; start a new task to select different memory');
      if (previous || (contextSource && options.memory === undefined)) {
        options.memorySnapshots = structuredClone((previous ?? contextSource)!.options.memorySnapshots);
      } else if (options.memory !== undefined) {
        await validateProjectRoot(workingDirectory);
        const snapshots: MemorySnapshot[] = [];
        for (const selection of options.memory) {
          const entry = await this.projectMemory().read(workingDirectory, selection.specialist);
          if (!entry) throw new BridgeError('MEMORY_NOT_FOUND', 'Selected memory does not exist: ' + selection.specialist);
          if (entry.sha256 !== selection.sha256) throw new BridgeError('MEMORY_CHANGED', 'Selected private memory changed; review its current content before dispatch');
          snapshots.push(entry);
        }
        options.memorySnapshots = memorySnapshotsSchema.parse(snapshots);
      }
      options.memory = options.memorySnapshots?.map(({ specialist, sha256 }) => ({ specialist, sha256 }));
      options.outputSchema = previous?.record.outputSchema ?? options.outputSchema;
      options.artifactPaths = previous?.record.artifactPaths ?? options.artifactPaths;
      if (options.outputSchema !== undefined) options.outputSchema = validateOutputSchema(options.outputSchema);
      if (options.artifactPaths !== undefined) options.artifactPaths = [...artifactPathsSchema.parse(options.artifactPaths)];
      if (previous?.project) await verifyProvidedSkills(previous.project.copyDirectory, previous.project.providedSkills ?? []);
      options.handoff ??= previous?.record.handoff;
      if (previous) options.peerContext = structuredClone(previous.options.peerContext);
      if (options.peerOrigin) {
        options.peerOrigin = peerOriginSchema.parse(options.peerOrigin);
        const item = this.tasks.get(options.sourceMessage!.taskId)?.record.inbox?.find(item => item.messageId === options.sourceMessage!.messageId);
        if (!previous?.record.group || JSON.stringify(item?.peerOrigin) !== JSON.stringify(options.peerOrigin) ||
            options.peerOrigin.groupId.toLowerCase() !== previous.record.group.groupId.toLowerCase() || item?.text !== options.prompt) {
          throw new BridgeError('INVALID_PEER_MESSAGE', 'Peer continuation does not match its persisted input');
        }
      }
      const acceptanceCriteria = previous?.record.acceptanceCriteria ?? options.acceptanceCriteria ?? contextSource?.record.acceptanceCriteria;
      const role = roleSchema.parse(options.role ?? previous?.record.role ?? 'implementer');
      const roleDefinition = previous?.record.roleDefinition ?? initialRoleDefinition ?? resolveRole(role, this.config.customRoles);
      if (previous && options.effort !== undefined && options.effort !== previous.record.effort) {
        throw new BridgeError('INVALID_EFFORT', 'A resumed task retains its original effort');
      }
      options.effort ??= previous?.record.effort;
      const timeoutSeconds = options.timeoutSeconds ?? previous?.options.timeoutSeconds ?? this.config.defaultTimeoutSeconds;
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) {
        throw new BridgeError('INVALID_TIMEOUT', 'timeoutSeconds must be between 1 and 86400');
      }
      const selectedModel = options.model !== undefined ? options.model : previous ? previous.record.model : this.getModel();
      const model = selectedModel === null ? undefined : selectedModel;
      if (model) {
        const models = await this.adapter.listModels();
        if (!models.some(item => item.id === model)) throw new BridgeError('MODEL_NOT_AVAILABLE', 'Model is not listed by agy: ' + model);
      }
      if (previous && role !== (previous.record.role ?? 'implementer')) throw new BridgeError('INVALID_ROLE', 'A resumed task retains its original role');
      const mode = options.mode ?? previous?.record.mode ?? (roleDefinition.baseRole === 'implementer' ? 'write' : 'read-only');
      if (roleDefinition.baseRole !== 'implementer' && mode !== 'read-only') throw new BridgeError('INVALID_ROLE', 'Roles based on planner and reviewer require read-only mode');
      if (roleDefinition.baseRole !== 'implementer' && options.outputSchema !== undefined) throw new BridgeError('INVALID_ROLE', 'Structured output schema requires an implementer base role');
      if (!['write', 'read-only'].includes(mode)) throw new BridgeError('INVALID_MODE', 'mode must be write or read-only');
      if (previous?.record.agentPolicy) {
        options.agentPolicy = this.checkAgentPolicySnapshot(previous.record.agentPolicy);
      } else if (options.allowedTools !== undefined || options.mcpServers !== undefined) {
        const selection = agentPolicySelectionSchema.parse({ allowedTools: options.allowedTools, mcpServers: options.mcpServers });
        options.agentPolicy = resolveAgentPolicy(selection, this.config.allowedAgyTools, this.config.mcpCatalog, mode, '28c48913-763e-4ced-aee4-3fe6f0dd25eb');
      } else if (contextSource?.record.agentPolicy) {
        const source = contextSource.record.agentPolicy;
        options.agentPolicy = resolveAgentPolicy({ allowedTools: source.nativeTools.filter(tool => mode !== 'read-only' || ['finish', 'view_file'].includes(tool)),
          mcpServers: source.mcpServers.flatMap(server => { const tools = server.tools.filter(name => mode !== 'read-only' || this.config.mcpCatalog.find(entry => entry.id === server.serverId)?.tools.some(tool => tool.name === name && tool.readOnly)); return tools.length ? [{ serverId: server.serverId, tools }] : []; }) },
          this.config.allowedAgyTools, this.config.mcpCatalog, mode, '28c48913-763e-4ced-aee4-3fe6f0dd25eb');
      } else if (this.config.enforceAgentPolicy) {
        options.agentPolicy = resolveAgentPolicy({}, this.config.allowedAgyTools, this.config.mcpCatalog, mode, '28c48913-763e-4ced-aee4-3fe6f0dd25eb');
      } else delete options.agentPolicy;
      if (previous && mode !== previous.record.mode) throw new BridgeError('INVALID_MODE', 'A resumed task must retain its original mode');
      if (this.queue.length >= this.config.maxQueuedTasks && this.active >= this.config.maxConcurrentTasks) {
        throw new BridgeError('QUEUE_FULL', 'Task queue is full');
      }
      options.deliveryMode ??= previous?.record.deliveryMode ?? contextSource?.record.deliveryMode ?? 'events';
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
      options.providedSkills = (previous?.project ?? contextProject)?.providedSkills;
      taskPrompt({ ...options, role, acceptanceCriteria }, this.config.maxPromptChars);
      pendingProjectRelease = previous?.project || contextProject ? this.state.acquire(this.projectLock((previous?.project ?? contextProject)!)) : undefined;
      if (this.tasks.size >= this.config.maxRetainedTasks) {
        const oldestFinished = [...this.tasks.values()].find(task => terminal.has(task.record.status) && task !== contextSource && !this.hasPendingInbox(task.record) && !(options.sourceMessage && task === previous));
        if (!oldestFinished) throw new BridgeError('QUEUE_FULL', 'Task retention limit reached with active tasks');
        if (oldestFinished !== previous && oldestFinished.project && ![...this.tasks.values()].some(other => other !== oldestFinished && other.project === oldestFinished.project)) {
          await this.discard(oldestFinished.record.taskId);
        }
        this.tasks.delete(oldestFinished.record.taskId);
        this.events.drop(oldestFinished.record.taskId);
        this.state.drop(oldestFinished.record.taskId);
      }
      const recordOutputSchema = options.outputSchema;
      const recordArtifactPaths = options.artifactPaths;
      if (options.nativeTest) {
        options.outputSchema = undefined;
        options.artifactPaths = undefined;
      }
      const taskId = randomUUID();
      options.group = options.groupAdmission ? { ...options.groupAdmission, rootTaskId: taskId } : previous?.record.group && structuredClone(previous.record.group);
      delete options.groupAdmission;
      const record: TaskRecord = { group: options.group, memory: summarizeMemory(options.memorySnapshots), parentTaskId: options.parentTaskId, sourceMessage: options.sourceMessage, deliveryMode: options.deliveryMode, providedSkills: options.providedSkills, taskId, sessionId: options.sessionId, model, effort: options.effort, mode, role, roleDefinition, prompt: options.prompt,
        acceptanceCriteria, handoff: options.handoff ?? previous?.record.handoff, comparison: options.comparison,
        tests: previous?.record.tests ?? contextSource?.record.tests, usageIsResume: Boolean(previous),
        usageBaseline: previous ? this.latestObservedUsage(previous.record.sessionId, workingDirectory) : undefined,
        workingDirectory, status: 'queued', createdAt: new Date().toISOString(),
        outputSchema: recordOutputSchema, artifactPaths: recordArtifactPaths, agentPolicy: options.agentPolicy };
      this.tasks.set(record.taskId, { record, ownerPid: process.pid, owned: true, options: { ...options, model: model ?? null, role, acceptanceCriteria, workingDirectory, timeoutSeconds, mode }, project: previous?.project ?? contextProject, releaseProject: pendingProjectRelease });
      accepted = true;
      pendingProjectRelease = undefined;
      this.queue.push(record.taskId);
      try { this.events.append(record.taskId, 'task.queued', { workingDirectory, model }); }
      catch (error) {
        // No provider was started: roll back this rejected queue entry before any later pump can execute it.
        const index = this.queue.indexOf(record.taskId);
        if (index >= 0) this.queue.splice(index, 1);
        const rejected = this.tasks.get(record.taskId)!;
        rejected.record.status = 'failed'; rejected.record.completedAt = new Date().toISOString();
        rejected.record.error = { code: 'STATE_PERSISTENCE_FAILED', message: 'The task could not be durably accepted; no provider was started' };
        rejected.releaseProject?.(); rejected.releaseProject = undefined;
        try { this.persist(record.taskId); } catch { /* retain in memory and never pump this failed entry */ }
        throw error;
      }
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

  readStructuredResult(taskId: string, offset = 0, limit = 10000, expectedContentSha256?: string) {
    this.refresh();
    const task = this.tasks.get(taskId);
    if (!task) throw new BridgeError('TASK_NOT_FOUND', `Unknown task: ${taskId}`);
    if (task.record.status !== 'completed') {
      throw new BridgeError('TASK_NOT_READY', 'Structured result requires a completed task');
    }
    if (!task.record.structuredResult) {
      throw new BridgeError('STRUCTURED_RESULT_NOT_AVAILABLE', 'No structured result recorded for this task');
    }
    return {
      taskId,
      ...textChunk(JSON.stringify(task.record.structuredResult.value), offset, limit, expectedContentSha256),
    };
  }

  listArtifacts(taskId: string) {
    this.refresh();
    const task = this.tasks.get(taskId);
    if (!task) throw new BridgeError('TASK_NOT_FOUND', `Unknown task: ${taskId}`);
    if (task.record.status !== 'completed') {
      throw new BridgeError('TASK_NOT_READY', 'Artifacts require a completed task');
    }
    return {
      taskId,
      artifacts: task.record.artifacts ?? [],
    };
  }

  async readArtifact(taskId: string, artifactPath: string, expectedSha256: string, offset = 0, limit = 65536) {
    this.refresh();
    const task = this.tasks.get(taskId);
    if (!task) throw new BridgeError('TASK_NOT_FOUND', `Unknown task: ${taskId}`);
    if (task.record.status !== 'completed' || !task.project || task.record.discardedAt) {
      throw new BridgeError('TASK_NOT_READY', 'Reading artifacts requires a completed task with a retained copy');
    }
    const normalized = artifactPath.replaceAll('\\', '/');
    const ref = task.record.artifacts?.find(entry => entry.path === normalized);
    if (!ref) {
      throw new BridgeError('ARTIFACT_NOT_FOUND', `Artifact not recorded: ${artifactPath}`);
    }
    return this.withProject(task.project, async () => {
      const chunk = await readArtifact(task.project!, ref, expectedSha256, offset, limit, this.config.maxCopyBytes);
      return { taskId, ...chunk };
    });
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

  async workflowSnapshot(taskId: string, outputTaskId: string, nodeKey: string, hooks: WorkflowHook = {}, createdAt = new Date().toISOString()) {
    this.refresh();
    const task = this.tasks.get(taskId), output = this.tasks.get(outputTaskId);
    if (!task?.project || !output?.project || task.record.status !== 'completed' || output.record.status !== 'completed' ||
        task.project.copyDirectory !== output.project.copyDirectory || !task.record.group || !output.record.group ||
        task.record.group.rootTaskId !== output.record.group.rootTaskId || task.record.integratedAt || task.record.discardedAt) {
      throw new BridgeError('WORKFLOW_TASK_UNAVAILABLE', 'Workflow requires completed retained outputs in the same conversation copy');
    }
    return this.withProject(task.project, async () => {
      const project = task.project!, preview = await previewProjectCopy(project, this.config), treeSha256 = await fingerprintProjectCopy(project, this.config);
      const value = output.record.structuredResult ? output.record.structuredResult.value : output.record.report?.data;
      const structured = validateStructuredResult({}, value);
      if (output.record.structuredResult && output.record.structuredResult.sha256 !== structured.sha256) throw new BridgeError('WORKFLOW_OUTPUT_CHANGED', 'Structured workflow output identity changed');
      const artifacts = output.record.artifactPaths?.length ? await collectArtifacts(project, output.record.artifactPaths, this.config) : [];
      if (JSON.stringify(artifacts) !== JSON.stringify(output.record.artifacts ?? [])) throw new BridgeError('WORKFLOW_OUTPUT_CHANGED', 'Workflow artifacts changed since completion');
      const criteria = output.record.acceptanceCriteria ?? [];
      if (!criteria.length) throw new BridgeError('WORKFLOW_CRITERIA_REQUIRED', 'Every step requires independently checked acceptance criteria');
      const automatic = await verifyCriteria(project, preview.sha256, criteria, []);
      if (automatic.checks.some(check => check.status === 'failed')) throw new BridgeError('WORKFLOW_VALIDATION_FAILED', 'An actual file acceptance check failed');
      const previous = task.record.verification ?? output.record.verification;
      const reviewed = previous ? await verifyCriteria(project, preview.sha256, criteria, previous.review.evidence) : undefined;
      const reviewPassed = previous?.status === 'passed' && previous.sha256 === preview.sha256 && reviewed?.status === 'passed' &&
        JSON.stringify(reviewed.fileHashes) === JSON.stringify(previous.fileHashes);
      const lastObservedTest = (task.record.tests ?? []).filter(test => test.source !== 'client-reported').at(-1);
      const observedTests = lastObservedTest && lastObservedTest.sha256 === preview.sha256 && lastObservedTest.treeSha256 === treeSha256 &&
        lastObservedTest.beforeTreeSha256 === treeSha256 && lastObservedTest.exitCode === 0 && !lastObservedTest.executionError && !lastObservedTest.truncated ? [lastObservedTest] : [];
      const needsReview = hooks.requireReview || criteria.some(criterion => !criterion.check) || reviewed?.status === 'failed';
      const phase = needsReview && !reviewPassed ? 'pending-review' as const : hooks.requireTests && !observedTests.length ? 'pending-tests' as const : 'validated' as const;
      const validationSha256 = createHash('sha256').update(JSON.stringify({
        criteria, fileHashes: automatic.fileHashes, reviews: reviewed ? { checks: reviewed.checks, fileHashes: reviewed.fileHashes, evidence: previous!.review.evidence } : null,
        tests: observedTests.map(test => ({ command: test.command, exitCode: test.exitCode, source: test.source, sha256: test.sha256,
          treeSha256: test.treeSha256, recordedAt: test.recordedAt, sandboxPolicySha256: test.sandboxPolicySha256, portableNode: test.portableNode, testTaskId: test.testTaskId, outputSha256: createHash('sha256').update(test.output).digest('hex') })), phase,
      })).digest('hex');
      const checkpoint: WorkflowCheckpoint = { taskId, outputTaskId, treeSha256, patchSha256: preview.sha256, outputSha256: structured.sha256,
        validationSha256, artifacts, createdAt };
      const input: WorkflowInput = { nodeKey, taskId: outputTaskId, outputSha256: structured.sha256, value: structured.value, artifacts };
      return { checkpoint, input, phase };
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
    if (task.agentPolicy) throw new BridgeError('POLICY_TEST_EXECUTOR_UNAVAILABLE', 'Tasks with an enforced tool policy require the bridge Windows LPAC executor for direct tests; native terminal access is not granted by this policy');
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
        const oldestFinished = [...this.tasks.values()].find(candidate => terminal.has(candidate.record.status) && candidate !== current && !this.hasPendingInbox(candidate.record)) ?? (this.hasPendingInbox(current.record) ? undefined : current);
        if (!oldestFinished) throw new BridgeError('QUEUE_FULL', 'Task retention limit reached with active tasks');
        if (oldestFinished !== current && oldestFinished.project && ![...this.tasks.values()].some(other => other !== oldestFinished && other.project === oldestFinished.project)) {
          await this.discard(oldestFinished.record.taskId);
        }
        this.tasks.delete(oldestFinished.record.taskId);
        this.events.drop(oldestFinished.record.taskId);
        this.state.drop(oldestFinished.record.taskId);
      }
      const record: TaskRecord = { parentTaskId: current.record.taskId, group: structuredClone(current.record.group), memory: structuredClone(current.record.memory), deliveryMode: current.record.deliveryMode, providedSkills: current.project.providedSkills, taskId: randomUUID(), sessionId: current.record.sessionId, model: current.record.model, effort: current.record.effort,
        mode: 'write', role: current.record.role, roleDefinition: current.record.roleDefinition, prompt: 'Run the requested tests in the Windows sandbox.',
        acceptanceCriteria: current.record.acceptanceCriteria, handoff: current.record.handoff, tests: current.record.tests,
        usageIsResume: true, usageBaseline: this.latestObservedUsage(current.record.sessionId, current.record.workingDirectory),
        workingDirectory: current.record.workingDirectory, copyDirectory: current.project.copyDirectory, includedFiles: current.project.includedFiles,
        status: 'queued', createdAt: new Date().toISOString(),
        outputSchema: current.record.outputSchema, artifactPaths: current.record.artifactPaths, agentPolicy: current.record.agentPolicy };
      const options: RunOptions = { parentTaskId: current.record.taskId, group: structuredClone(current.record.group), memory: structuredClone(current.options.memory), memorySnapshots: structuredClone(current.options.memorySnapshots), deliveryMode: record.deliveryMode, providedSkills: record.providedSkills, prompt: record.prompt, workingDirectory: record.workingDirectory, sessionId: record.sessionId,
        agentPolicy: record.agentPolicy, model: record.model, effort: record.effort, timeoutSeconds, mode: 'write', role: record.role, roleDefinition: record.roleDefinition,
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
    finally { release?.(); this.busyProjects.delete(project); this.scheduleInbox(project.copyDirectory); }
  }

  async discard(taskId: string): Promise<TaskRecord> {
    this.refresh();
    const task = this.tasks.get(taskId);
    if (!task) throw new BridgeError('TASK_NOT_FOUND', `Unknown task: ${taskId}`);
    if (!terminal.has(task.record.status)) throw new BridgeError('TASK_NOT_READY', 'Cancel and wait for the task before discarding');
    if (task.project) {
      const project = task.project;
      await this.withProject(project, async () => {
        this.failPendingInbox(project.copyDirectory, task, 'cancelled', 'COPY_DISCARDED');
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
      const preauthorized = this.integrationPreauthorized(taskId);
      if (!preauthorized && !confirm) throw new BridgeError('APPROVAL_REQUIRED', 'Integration requires confirmation or a configured project preauthorization');
      await this.requireVerification(task, expectedSha256);
      if (!preauthorized && !await confirm!(reviewed)) throw new BridgeError('APPROVAL_DENIED', 'Integration was not confirmed');
      const releaseSource = this.state.acquire('source-' + createHash('sha256').update(task.record.workingDirectory).digest('hex'));
      try {
        const current = await previewProjectCopy(task.project!, this.config);
        if (current.sha256 !== expectedSha256) throw new BridgeError('REVIEW_CHANGED', 'The copy changed after confirmation');
        await this.requireVerification(task, expectedSha256);
        const preview = await integrateProjectCopy(task.project!, expectedSha256, this.config);
        for (const related of this.tasks.values()) if (related.project === task.project) {
          related.record.integratedAt = new Date().toISOString();
          this.events.append(related.record.taskId, 'copy.integrated', { sha256: expectedSha256, approvalSource: preauthorized ? 'configured-project' : 'mcp-elicitation' });
        }
        return preview;
      } finally { releaseSource(); }
    });
  }

  private hasPendingInbox(record: TaskRecord): boolean {
    return Boolean(record.dispatching || record.inbox?.some(item => item.receipt.state === 'queued'));
  }

  private inboxReceipt(item: CallerInboxItem): CallerMessageReceipt {
    return { ...item.receipt, ...(item.receipt.error ? { error: { ...item.receipt.error } } : {}) };
  }

  inbox(taskId: string) {
    this.status(taskId);
    const task = this.tasks.get(taskId)!;
    if (task.project) this.scheduleInbox(task.project.copyDirectory);
    return (task.record.inbox ?? []).map(item => ({
      messageId: item.messageId, taskId, text: item.text, receivedAt: item.receivedAt, receipt: this.inboxReceipt(item),
    }));
  }

  async sendMessage(taskId: string, messageId: string, text: string, peerOrigin?: PeerOrigin) {
    if (this.stopped) throw new BridgeError('AGY_PROCESS_FAILED', 'Server is shutting down');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(messageId) || !text.trim() || text.length > 2000) {
      throw new BridgeError('INVALID_MESSAGE', 'Provide a UUID and between 1 and 2000 characters of caller text');
    }
    messageId = messageId.toLowerCase();
    if (peerOrigin) {
      peerOrigin = peerOriginSchema.parse(peerOrigin);
      peerOrigin = { ...peerOrigin, groupId: peerOrigin.groupId.toLowerCase(), sourceTaskId: peerOrigin.sourceTaskId.toLowerCase(), messageId: peerOrigin.messageId.toLowerCase() };
    }
    const release = this.state.acquire('registry');
    let directory: string | undefined;
    try {
      this.refresh();
      this.recoverInboxClaims(true);
      const task = this.tasks.get(taskId);
      if (!task) throw new BridgeError('TASK_NOT_FOUND', 'Unknown task: ' + taskId);
      const existing = task.record.inbox?.find(item => item.messageId === messageId);
      if (existing && (existing.text !== text || JSON.stringify(existing.peerOrigin) !== JSON.stringify(peerOrigin))) throw new BridgeError('MESSAGE_ID_CONFLICT', 'This message ID already identifies different text or origin');
      if (peerOrigin && (!existing || existing.receipt.state === 'queued')) this.assertPeerInput(task.record, text, peerOrigin);
      if (existing && existing.receipt.state !== 'queued') return { receipt: this.inboxReceipt(existing) };
      if (!task.owned && !terminal.has(task.record.status)) throw new BridgeError('TASK_OWNED_BY_OTHER_SERVER', 'Send through the bridge that owns the running task');
      if (task.record.integratedAt || task.record.discardedAt || (!task.project && terminal.has(task.record.status))) {
        throw new BridgeError('INVALID_MESSAGE_TARGET', 'This task no longer retains a conversation copy');
      }
      if (!existing) {
        if (task.record.group) {
          const group = new GroupStore(this.config.stateDirectory).read(task.record.group.groupId);
          if (group.definition.workflow && group.nodes[task.record.group.nodeKey]?.checkpoint) throw new BridgeError('WORKFLOW_NODE_CLOSED', 'Checkpointed workflow outputs cannot accept another input');
        }
        if ((task.record.inbox?.length ?? 0) >= 20) throw new BridgeError('INBOX_FULL', 'At most 20 caller messages can be retained on one task');
        const item: CallerInboxItem = { messageId, taskId, text, ...(peerOrigin ? { peerOrigin } : {}), receivedAt: new Date().toISOString(), receipt: { messageId, taskId, state: 'queued' } };
        task.record.inbox = [...(task.record.inbox ?? []), item];
        this.events.append(taskId, 'caller.message-queued', { messageId });
      }
      directory = task.project?.copyDirectory;
      if (terminal.has(task.record.status) && task.record.status !== 'completed') {
        this.failPendingInbox(directory, task, task.record.status === 'cancelled' ? 'cancelled' : 'failed', 'TASK_NOT_COMPLETED');
      }
    } finally { release(); }
    if (directory) await this.flushInbox(directory);
    this.refresh();
    const item = this.tasks.get(taskId)?.record.inbox?.find(entry => entry.messageId === messageId);
    if (!item) throw new BridgeError('TASK_NOT_FOUND', 'Caller message target was removed');
    return { receipt: this.inboxReceipt(item) };
  }

  private checkGroupBudget(groupId: string, pending?: { taskId: string; zeroTokens: boolean }): void {
    const group = new GroupStore(this.config.stateDirectory).read(groupId);
    if (group.state !== 'running') throw new BridgeError('GROUP_CLOSED', 'Start or resume the group before another model turn');
    requireGroupBudget(observeGroupBudget(group, [...this.tasks.values()].map(task => task.record), pending));
  }

  private assertPeerInput(target: TaskRecord, text: string, origin: PeerOrigin): void {
    const sender = this.tasks.get(origin.sourceTaskId)?.record;
    const group = new GroupStore(this.config.stateDirectory).read(origin.groupId);
    const check = (task: TaskRecord | undefined, key: string): task is TaskRecord => {
      if (!task?.group) return false;
      const root = this.tasks.get(task.group.rootTaskId)?.record;
      return task.group.groupId.toLowerCase() === group.groupId.toLowerCase() && task.group.nodeKey === key &&
        task.group.definitionSha256 === group.definitionSha256 && task.workingDirectory === group.definition.workingDirectory &&
        task.group.owner === group.definition.jobs.find(job => job.key === key)?.owner && task.role === task.group.owner &&
        !!root?.group && root.group.rootTaskId.toLowerCase() === root.taskId.toLowerCase() &&
        root.group.groupId.toLowerCase() === group.groupId.toLowerCase() && root.group.nodeKey === key &&
        root.group.definitionSha256 === group.definitionSha256 && root.group.owner === task.group.owner && root.role === task.role && root.workingDirectory === task.workingDirectory;
    };
    const routes = (group.definition as typeof group.definition & { peerRoutes?: Array<{ from: string; to: string }> }).peerRoutes ?? [];
    if (group.state !== 'running' || !check(sender, origin.fromNode) || !target.group || !check(target, target.group.nodeKey) ||
        !isPeerRouteAllowed({ nodes: group.definition.jobs.map(({ key, owner, dependsOn }) => ({ key, owner, dependsOn })) }, routes, origin.fromNode, target.group.nodeKey) ||
        !sender!.peerRequests?.some(input => input.messageId.toLowerCase() === origin.messageId && input.toNode === target.group!.nodeKey && input.text === text)) {
      throw new BridgeError('INVALID_PEER_MESSAGE', 'Peer input is outside the selected route, project, membership or public request');
    }
  }

  private failPendingInbox(directory: string | undefined, current: InternalTask, state: 'failed' | 'cancelled', code: string): void {
    const related = directory ? [...this.tasks.values()].filter(task => task.project?.copyDirectory === directory) : [current];
    for (const task of related) {
      let changed = false;
      for (const item of task.record.inbox ?? []) if (item.receipt.state === 'queued' && task.record.dispatching?.messageId !== item.messageId) {
        item.receipt = { messageId: item.messageId, taskId: task.record.taskId, state, error: { code, message: 'The conversation ended before this input was dispatched' } };
        changed = true;
      }
      if (changed) this.events.append(task.record.taskId, 'caller.messages-stopped', { state, code });
    }
  }

  private recoverInboxClaims(locked = false): void {
    if (!locked) {
      let release: (() => void) | undefined;
      try { release = this.state.acquire('registry'); this.refresh(); this.recoverInboxClaims(true); }
      catch (error) { if (!(error instanceof BridgeError && error.code === 'STATE_BUSY')) throw error; }
      finally { release?.(); }
      return;
    }
    for (const task of this.tasks.values()) {
      const claim = task.record.dispatching;
      if (!claim || this.claimingMessages.has(task.record.taskId) || (processAlive(task.ownerPid) && (task.ownerPid !== process.pid || claim.ownerId !== this.inboxOwnerId))) continue;
      const item = task.record.inbox?.find(entry => entry.messageId === claim.messageId);
      const continuation = [...this.tasks.values()].find(candidate => candidate.record.sourceMessage?.taskId === task.record.taskId && candidate.record.sourceMessage.messageId === claim.messageId);
      if (item) {
        item.receipt = continuation && continuation.record.error?.code !== 'STATE_PERSISTENCE_FAILED' ? { messageId: item.messageId, taskId: task.record.taskId, state: 'sent', continuationTaskId: continuation.record.taskId }
          : { messageId: item.messageId, taskId: task.record.taskId, state: 'failed', error: { code: 'DISPATCH_INTERRUPTED', message: 'Dispatch was interrupted without a retained continuation; it will not be replayed' } };
        if (continuation?.record.parentTaskId) {
          const parent = this.tasks.get(continuation.record.parentTaskId);
          if (parent) { parent.record.continuationTaskId = continuation.record.taskId; this.persist(parent.record.taskId); }
        }
      }
      delete task.record.dispatching;
      this.events.append(task.record.taskId, 'caller.dispatch-recovered', { messageId: claim.messageId, state: item?.receipt.state ?? 'failed' });
    }
  }

  private continuationState(taskId: string) {
    const task = this.tasks.get(taskId)!;
    const directory = task.project?.copyDirectory;
    const related = directory ? [...this.tasks.values()].filter(candidate => candidate.project?.copyDirectory === directory) : [task];
    const continuationPending = related.some(candidate => this.hasPendingInbox(candidate.record));
    if (directory && continuationPending && terminal.has(task.record.status)) this.scheduleInbox(directory);
    return { ...(task.record.continuationTaskId ? { continuationTaskId: task.record.continuationTaskId } : {}), continuationPending };
  }

  private scheduleInbox(directory: string): void {
    if (this.stopped || this.flushingInboxes.has(directory)) return;
    void this.flushInbox(directory).catch(error => process.stderr.write('Caller inbox dispatch failed: ' + (error instanceof BridgeError ? error.code : 'AGY_PROCESS_FAILED') + '\n'));
  }

  private async flushInbox(directory: string): Promise<void> {
    if (this.stopped || this.flushingInboxes.has(directory)) return;
    this.flushingInboxes.add(directory);
    let target: InternalTask | undefined;
    let latest: InternalTask | undefined;
    let item: CallerInboxItem | undefined;
    let sent = false;
    try {
      const release = this.state.acquire('registry');
      try {
        this.refresh();
        this.recoverInboxClaims(true);
        const related = [...this.tasks.values()].filter(task => task.project?.copyDirectory === directory);
        latest = related.filter(task => !(task.record.error?.code === 'STATE_PERSISTENCE_FAILED' && !task.record.startedAt)).at(-1);
        if (!latest || !terminal.has(latest.record.status) || latest.owned || this.busyProjects.has(latest.project!)) return;
        if (latest.record.status !== 'completed' || latest.record.integratedAt || latest.record.discardedAt || !latest.record.sessionId) {
          this.failPendingInbox(directory, latest, 'failed', 'INVALID_MESSAGE_TARGET'); return;
        }
        if (related.some(task => task.record.dispatching)) return;
        const queued = related.flatMap(task => (task.record.inbox ?? []).filter(entry => entry.receipt.state === 'queued').map(entry => ({ task, entry })));
        queued.sort((a, b) => a.entry.receivedAt.localeCompare(b.entry.receivedAt));
        const first = queued[0]; if (!first) return;
        target = first.task; item = first.entry;
        target.ownerPid = process.pid;
        target.record.dispatching = { messageId: item.messageId, ownerId: this.inboxOwnerId };
        this.claimingMessages.add(target.record.taskId);
        this.events.append(target.record.taskId, 'caller.message-dispatching', { messageId: item.messageId });
      } finally { release(); }
      try {
        const continuation = await this.run({ workingDirectory: latest!.record.workingDirectory, sessionId: latest!.record.sessionId,
          prompt: item!.text, peerOrigin: item!.peerOrigin, mode: latest!.record.mode, role: latest!.record.role, model: latest!.record.model ?? null,
          deliveryMode: latest!.record.deliveryMode, timeoutSeconds: latest!.options.timeoutSeconds,
          parentTaskId: latest!.record.taskId, sourceMessage: { taskId: target!.record.taskId, messageId: item!.messageId } });
        const finish = this.state.acquire('registry');
        try {
          this.refresh();
          target = this.tasks.get(target!.record.taskId)!;
          item = target.record.inbox!.find(entry => entry.messageId === item!.messageId)!;
          item.receipt = { messageId: item.messageId, taskId: target.record.taskId, state: 'sent', continuationTaskId: continuation.taskId };
          const parent = this.tasks.get(latest!.record.taskId);
          if (parent) { parent.record.continuationTaskId = continuation.taskId; this.persist(parent.record.taskId); }
          delete target.record.dispatching;
          this.events.append(target.record.taskId, 'caller.message-sent', { messageId: item.messageId, continuationTaskId: continuation.taskId });
          sent = true;
        } finally { finish(); }
      } catch (error) {
        const finish = this.state.acquire('registry');
        try {
          this.refresh();
          target = this.tasks.get(target!.record.taskId);
          item = target?.record.inbox?.find(entry => entry.messageId === item!.messageId);
          if (!target || !item) return;
          const accepted = [...this.tasks.values()].find(task => task.record.sourceMessage?.taskId === target!.record.taskId && task.record.sourceMessage.messageId === item!.messageId);
          if (accepted && accepted.record.error?.code !== 'STATE_PERSISTENCE_FAILED') {
            item.receipt = { messageId: item.messageId, taskId: target.record.taskId, state: 'sent', continuationTaskId: accepted.record.taskId };
          } else if (!accepted && error instanceof BridgeError && (error.code === 'STATE_BUSY' || error.code === 'GROUP_BUDGET_PENDING')) {
            // run refused before accepting a continuation; this known-unsent input may be tried again by an explicit call or after a scoped lock releases.
          } else item.receipt = { messageId: item.messageId, taskId: target.record.taskId, state: 'failed', error: { code: error instanceof BridgeError ? error.code : 'AGY_PROCESS_FAILED', message: 'The continuation was not accepted' } };
          delete target.record.dispatching;
          this.events.append(target.record.taskId, 'caller.message-dispatch-ended', { messageId: item.messageId, state: item.receipt.state });
        } finally { finish(); }
      }
    } catch (error) {
      if (!(error instanceof BridgeError && error.code === 'STATE_BUSY')) throw error;
    } finally {
      if (target) this.claimingMessages.delete(target.record.taskId);
      this.flushingInboxes.delete(directory);
      if (sent && !this.stopped) queueMicrotask(() => this.scheduleInbox(directory));
    }
  }

  setDeliveryMode(taskId: string, mode: DeliveryMode) {
    const deliveryMode = deliveryModeSchema.parse(mode);
    const release = this.state.acquire('registry');
    try {
      this.refresh();
      const task = this.tasks.get(taskId);
      if (!task) throw new BridgeError('TASK_NOT_FOUND', 'Unknown task: ' + taskId);
      if (!task.owned && !terminal.has(task.record.status)) throw new BridgeError('TASK_OWNED_BY_OTHER_SERVER', 'Change delivery in the bridge that owns the running task');
      task.record.deliveryMode = deliveryMode;
      task.options.deliveryMode = deliveryMode;
      this.events.append(taskId, 'delivery.updated', { deliveryMode });
      return { taskId, deliveryMode };
    } finally { release(); }
  }

  readEvents(taskId: string, after = 0, limit = 200) {
    this.status(taskId);
    return this.events.read(taskId, after, limit);
  }

  async waitMany(input: unknown, timeoutSeconds = 30, signal?: AbortSignal) {
    const targets = waitTargetsSchema.parse(input);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60) throw new BridgeError('INVALID_TIMEOUT', 'Wait timeout must be between 1 and 60 seconds');
    if (this.waiting >= this.config.maxConcurrentTasks + this.config.maxQueuedTasks) throw new BridgeError('WAIT_LIMIT_EXCEEDED', 'Too many concurrent waits');
    this.waiting++;
    try {
      const deadline = Date.now() + timeoutSeconds * 1000;
      for (;;) {
        if (signal?.aborted) throw new BridgeError('WAIT_CANCELLED', 'Waiting cancelled; tasks continue');
        const page = jointWaitPage(this.list(), targets);
        if (page.ready || page.hasMessages || Date.now() >= deadline) return { ready: page.ready, timedOut: !page.ready && !page.hasMessages, hasMoreMessages: page.hasMoreMessages, tasks: page.tasks };
        try { await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal }); }
        catch { throw new BridgeError('WAIT_CANCELLED', 'Waiting cancelled; tasks continue'); }
      }
    } finally { this.waiting--; }
  }

  async wait(taskId: string, after = 0, timeoutSeconds = 30, signal?: AbortSignal, onEvent?: (event: BridgeEvent) => Promise<void>, cursorMode?: DeliveryMode) {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60) {
      throw new BridgeError('INVALID_TIMEOUT', 'Wait timeout must be between 1 and 60 seconds');
    }
    if (this.waiting >= this.config.maxConcurrentTasks + this.config.maxQueuedTasks) throw new BridgeError('WAIT_LIMIT_EXCEEDED', 'Too many concurrent waits');
    this.waiting++;
    const deadline = Date.now() + timeoutSeconds * 1000;
    const deliveryMode = this.status(taskId).deliveryMode ?? 'events';
    const cursorReset = cursorMode !== undefined && cursorMode !== deliveryMode;
    if (cursorReset) after = 0;
    let cursor = after;
    try {
      while (true) {
        if (signal?.aborted) throw new BridgeError('WAIT_CANCELLED', 'Waiting was cancelled; the task continues');
        const task = this.status(taskId);
        const continuation = this.continuationState(taskId);
        if (deliveryMode === 'messages') {
          const messages = readMessages(task, after);
          const ready = terminal.has(task.status);
          if (messages.messages.length || (ready && (!continuation.continuationPending || continuation.continuationTaskId)) || Date.now() >= deadline) return {
            taskId, status: task.status, ready, timedOut: !ready && !messages.messages.length,
            deliveryMode, cursorReset, ...continuation, ...messages, tokenUsage: task.tokenUsage,
          };
          await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal });
          continue;
        }
        const page = this.events.read(taskId, cursor, 1000);
        for (const event of page.events) { await onEvent?.(event); cursor = event.sequence; }
        const ready = terminal.has(task.status);
        if (ready || Date.now() >= deadline) return {
          taskId, status: task.status, ready, timedOut: !ready, deliveryMode, cursorReset, ...continuation,
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
      this.failPendingInbox(task.project?.copyDirectory, task, 'cancelled', 'TASK_CANCELLED');
      appendMessage(task.record, 'error', 'bridge', 'Task cancelled before execution');
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
    await this.groupManager?.shutdown();
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
      task.completion = this.execute(task).finally(() => { task.releaseProject?.(); task.releaseProject = undefined; task.owned = false; this.active--; this.pump(); if (task.project) this.scheduleInbox(task.project.copyDirectory); });
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
    let policyReceiptOffset = 0;
    try {
      task.project ??= await createProjectCopy(record.workingDirectory, task.options.includePaths, project => {
        task.project = project;
        this.events.append(record.taskId, 'copy.created', { copyDirectory: project.copyDirectory });
      }, this.config, task.options.skills, task.options.agentPolicy ? { policy: task.options.agentPolicy, catalog: this.config.mcpCatalog, stateDirectory: this.config.stateDirectory, executionId: record.taskId } : undefined);
      if (task.options.agentPolicy && !task.project.executionPolicy) await stageProjectExecutionPolicy(task.project, { policy: task.options.agentPolicy, catalog: this.config.mcpCatalog, stateDirectory: this.config.stateDirectory, executionId: record.taskId }, this.config);
      await verifyManagedCopy(task.project);
      if (task.project.executionPolicy?.policy.sha256 !== task.options.agentPolicy?.sha256) throw new BridgeError('AGENT_POLICY_CHANGED', 'Copy policy does not match the task snapshot');
      record.providedSkills = task.project.providedSkills;
      task.options.providedSkills = task.project.providedSkills;
      delete task.options.skills;
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
      if (task.project.executionPolicy) policyReceiptOffset = (await readExecutionPolicyReceipt(task.project.executionPolicy, this.config.stateDirectory)).nextOffset;
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
      if ((child as CliProcess).schemaCleanupError) throw (child as CliProcess).schemaCleanupError;
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
      else if (/no output produced[^\r\n]*["']mcp["'][^\r\n]*permission[^\r\n]*headless/iu.test(stderr)) {
        this.finish(task, 'failed', 'AGY_MCP_PERMISSION_REQUIRED', 'Native agy permission is required for the selected MCP tool. Authorize the exact server/tool in agy settings before retrying; headless cannot request approval.');
      }
      else if (exitCode !== 0 || !record.result || (record.result as { status?: string }).status !== 'SUCCESS') {
        const message = (record.result as { error?: string } | undefined)?.error || `agy exited with code ${exitCode}`;
        this.finish(task, 'failed', !record.result && task.parseErrors ? 'STREAM_PARSE_ERROR' : 'AGY_PROCESS_FAILED', message);
      } else {
        if (task.project.executionPolicy) {
          await verifyManagedCopy(task.project);
          const receipt = await readExecutionPolicyReceipt(task.project.executionPolicy, this.config.stateDirectory, policyReceiptOffset, record.sessionId);
          if (!record.sessionId || !receipt.guardedFinish) throw new BridgeError('AGENT_POLICY_UNVERIFIED', 'No new guarded finish was observed for this conversation');
          record.agentPolicyReceipt = { sha256: receipt.sha256, decisionCount: receipt.decisionCount, deniedCount: receipt.deniedCount };
        }
        if (record.mode !== 'read-only') await previewProjectCopy(task.project, this.config);
        record.report = await validateRoleReport((record.roleDefinition ?? resolveRole(record.role ?? 'implementer')).baseRole,
          (record.result as { structured_output?: unknown }).structured_output, task.project.copyDirectory);
        if (!task.options.nativeTest && record.outputSchema !== undefined) {
          const rawStructured = (record.result as { structured_output?: unknown } | undefined)?.structured_output;
          record.structuredResult = validateStructuredResult(record.outputSchema, rawStructured);
        }
        if (!task.options.nativeTest && record.artifactPaths !== undefined) {
          record.artifacts = await collectArtifacts(task.project, record.artifactPaths, this.config);
        }
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
    const { nativeTest: _nativeTest, outputSchema: _outputSchema, artifactPaths: _artifactPaths, ...baseOptions } = task.options;
    const options: RunOptions = { ...baseOptions, timeoutSeconds,
      prompt: 'The bridge observed this exact test command exit with code ' + observedExitCode + ': ' +
        JSON.stringify({ executable: request.executable, args: request.args }) +
        '. Make only relevant fixes in the isolated copy. Do not run tests, change the command, weaken assertions, alter sandbox permissions, or change bridge configuration. Stop after the repair so the bridge can rerun the same command.' };
    if (task.record.agentPolicy) options.agentPolicy = this.checkAgentPolicySnapshot(task.record.agentPolicy);
    await verifyManagedCopy(task.project);
    const receiptOffset = task.project.executionPolicy ? (await readExecutionPolicyReceipt(task.project.executionPolicy, this.config.stateDirectory)).nextOffset : 0;
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
    if (task.project.executionPolicy) {
      await verifyManagedCopy(task.project);
      const receipt = await readExecutionPolicyReceipt(task.project.executionPolicy, this.config.stateDirectory, receiptOffset, task.record.sessionId);
      if (!task.record.sessionId || !receipt.guardedFinish) throw new BridgeError('AGENT_POLICY_UNVERIFIED', 'Repair did not produce a new guarded finish');
      task.record.agentPolicyReceipt = { sha256: receipt.sha256, decisionCount: receipt.decisionCount, deniedCount: receipt.deniedCount };
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
        if (task.record.group) {
          const budgetLock = this.state.acquire('registry');
          try { this.refresh(); this.checkGroupBudget(task.record.group.groupId, { taskId: task.record.taskId, zeroTokens: !modelInvoked }); }
          finally { budgetLock(); }
        }
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
      if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && Number.isSafeInteger(step.step_index)) {
        const index = step.step_index as number;
        task.publicResponses ??= new Map();
        if (task.publicResponses.size < 200 || task.publicResponses.has(index)) {
          const room = Math.max(0, 1024 * 1024 - (task.responseChars ?? 0));
          const delta = step.text_delta.slice(0, room);
          if (delta.length < step.text_delta.length && !task.messageBufferLimited) {
            task.messageBufferLimited = true;
            if (record.group) record.peerRequestsTruncated = true;
            appendMessage(record, 'blocker', 'bridge', 'The public message buffer reached its limit; inspect retained history and the full result for omitted details.');
            this.events.append(record.taskId, 'message.truncated', { limitChars: 1024 * 1024 });
          }
          task.responseChars = (task.responseChars ?? 0) + delta.length;
          const text = (task.publicResponses.get(index) ?? '') + delta;
          task.publicResponses.set(index, text);
          this.captureMessages(task, text, String(index));
        } else if (record.group) record.peerRequestsTruncated = true;
      }
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
      if (typeof result.response === 'string') this.captureMessages(task, result.response, 'final', true);
      const structured = result.structured_output;
      if (structured && typeof structured === 'object' && typeof (structured as { summary?: unknown }).summary === 'string') this.captureMessages(task, (structured as { summary: string }).summary, 'structured-final', true);
      this.events.append(record.taskId, 'agy.result', result, raw);
    } else this.events.append(record.taskId, 'agy.event', raw, raw);
  }

  private captureMessages(task: InternalTask, text: string, step: string, final = false): void {
    if (task.record.group) {
      const peers = extractPeerMessages(text);
      let changed = false;
      for (const input of peers.messages) {
        const normalized = { ...input, messageId: input.messageId.toLowerCase() };
        if (task.record.peerRequests?.some(old => old.messageId === normalized.messageId && old.toNode === normalized.toNode && old.text === normalized.text)) continue;
        if ((task.record.peerRequests?.length ?? 0) >= 20) { task.record.peerRequestsTruncated = true; break; }
        task.record.peerRequests = [...(task.record.peerRequests ?? []), normalized]; changed = true;
      }
      if (peers.truncated) task.record.peerRequestsTruncated = true;
      if (changed || task.record.peerRequestsTruncated) this.events.append(task.record.taskId, 'peer.requests-observed', { count: task.record.peerRequests?.length ?? 0, truncated: task.record.peerRequestsTruncated ?? false });
    }
    task.messageKeys ??= new Set();
    for (const input of extractAgentMessages(text)) {
      const payload = JSON.stringify(input);
      const key = step + ':' + createHash('sha256').update(payload).digest('hex');
      if (task.messageKeys.has(key) || (final && task.record.messages?.some(message => message.source === 'agy-reported' && message.kind === input.kind && message.text === input.text))) continue;
      if (task.messageKeys.size >= 1000) {
        if (!task.messageLimitReported) {
          task.messageLimitReported = true;
          appendMessage(task.record, 'blocker', 'bridge', 'The message forwarding limit was reached; inspect retained history and the full result after execution for omitted public messages.');
          this.events.append(task.record.taskId, 'message.truncated', { maxForwardedMessages: 1000 });
        }
        continue;
      }
      task.messageKeys.add(key);
      const message = appendMessage(task.record, input.kind, 'agy-reported', input.text);
      this.events.append(task.record.taskId, 'message.reported', { messageId: message.messageId, sequence: message.sequence, kind: message.kind });
    }
  }

  private finish(task: InternalTask, status: 'completed' | 'failed' | 'cancelled' | 'timeout', code?: string, message?: string): void {
    if (terminal.has(task.record.status)) return;
    task.record.status = status;
    task.record.completedAt = new Date().toISOString();
    if (status === 'timeout') code = 'TASK_TIMEOUT';
    if (status === 'cancelled') code = 'TASK_CANCELLED';
    if (code) task.record.error = { code, message: message || code };
    if (status !== 'completed') this.failPendingInbox(task.project?.copyDirectory, task, status === 'cancelled' ? 'cancelled' : 'failed', code ?? 'TASK_NOT_COMPLETED');
    const output = task.record.result as { response?: unknown; structured_output?: { summary?: unknown } } | undefined;
    const reported = typeof output?.structured_output?.summary === 'string' ? output.structured_output.summary : typeof output?.response === 'string' && output.response.trim() ? output.response : task.record.report?.data.summary;
    const hasPeerEnvelope = typeof reported === 'string' && reported.includes('<antigravity-peer-message>');
    const text = hasPeerEnvelope ? 'Peer messages retained by the coordinator; inspect the referenced result for the final response.' : typeof reported === 'string' && reported.trim() ? reported.replace(/<antigravity-message>[\s\S]*?<\/antigravity-message>/g, '').trim() || 'Execution ended; inspect the referenced result.' : 'Execution ended with status ' + status + '; inspect the current verification and tests.';
    const source = !hasPeerEnvelope && status === 'completed' && typeof reported === 'string' && task.record.usageProvenance !== 'local-executor' ? 'agy-reported' : 'bridge';
    appendMessage(task.record, status === 'completed' ? 'final' : 'error', source,
      status === 'completed' ? text : (task.record.error?.code ?? status) + ': ' + (task.record.error?.message ?? text), resultReference(task.record));
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
