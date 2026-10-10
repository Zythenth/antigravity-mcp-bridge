import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.js';
import type { TaskManager } from './task-manager.js';
import { BridgeError, type TaskRecord } from './types.js';
import { validateWorkingDirectory, validatePrompt, validateRuntimeCacheSeparation, validateStateSeparation } from './validation.js';
import { validateProjectRoot } from './isolation.js';
import { applyRoleDefaults, resolveRole } from './roles.js';
import { taskPrompt } from './cli-adapter.js';
import { GroupStore } from './group-store.js';
import { groupDefinitionSchema, groupDefinitionSha256, summarizeGroup, type GroupDefinition, type GroupRecord } from './group-contract.js';
import { groupReadiness, initialGroupProgress, type GroupNodeStatus } from './task-groups.js';
import { jointWaitPage, waitCursorsSchema, type WaitTarget } from './joint-wait.js';
import { processAlive } from './state-store.js';

const finished = new Set(['completed', 'failed', 'cancelled']);
function profileHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function graph(record: Pick<GroupRecord, 'definition'>) { return { nodes: record.definition.jobs.map(({ key, owner, dependsOn }) => ({ key, owner, dependsOn })) }; }
function progress(record: GroupRecord) { return Object.fromEntries(Object.entries(record.nodes).map(([key, node]) => [key, node.state])); }
function observedState(task: TaskRecord): GroupNodeStatus {
  if (task.status === 'completed' || task.status === 'cancelled') return task.status;
  if (task.status === 'failed' || task.status === 'timeout') return 'failed';
  return task.status === 'queued' || task.status === 'starting' ? 'starting' : 'running';
}

export class GroupManager {
  private readonly store: GroupStore;
  private readonly ownerId = randomUUID();
  private readonly loops = new Map<string, Promise<void>>();
  private stopped = false;
  private waiting = 0;
  private summary(record: GroupRecord) {
    const retained = this.tasks.list();
    for (const [key, node] of Object.entries(record.nodes)) if (node.taskId) {
      const task = retained.find(task => task.taskId.toLowerCase() === node.taskId?.toLowerCase());
      if (task) {
        this.assertMember(record, key, task);
        if (!['completed','failed','cancelled','blocked'].includes(node.state)) { node.state = observedState(task); node.error = task.error; }
      }
    }
    return summarizeGroup(record, record.state === 'paused' || (record.state === 'running' && !!record.ownerPid && !processAlive(record.ownerPid)));
  }
  constructor(private readonly tasks: TaskManager, private readonly config: Config) { this.store = new GroupStore(config.stateDirectory); }

  private assertMember(record: GroupRecord, key: string, task: TaskRecord): void {
    if (task.group?.groupId.toLowerCase() !== record.groupId.toLowerCase() || task.group.nodeKey !== key ||
        task.group.owner !== record.definition.jobs.find(job => job.key === key)?.owner || task.role !== task.group.owner ||
        task.group.definitionSha256 !== record.definitionSha256 || task.workingDirectory !== record.definition.workingDirectory) {
      throw new BridgeError('INVALID_STATE', 'A task reference does not belong to this exact group, node and project');
    }
  }

  async create(groupId: string, input: GroupDefinition) {
    groupId = groupId.toLowerCase();
    const definition = groupDefinitionSchema.parse(input);
    definition.workingDirectory = await validateWorkingDirectory(definition.workingDirectory, this.config.forbiddenDirectories);
    await validateRuntimeCacheSeparation(definition.workingDirectory, this.config.windowsNodeCacheDirectory);
    await validateStateSeparation(definition.workingDirectory, this.config.stateDirectory);
    await validateProjectRoot(definition.workingDirectory);
    const profiles = Object.fromEntries(definition.jobs.map(job => {
      const role = resolveRole(job.owner, this.config.customRoles);
      const options = applyRoleDefaults({ ...job.task, workingDirectory: definition.workingDirectory, role: job.owner }, role);
      validatePrompt(options.prompt, this.config.maxPromptChars);
      taskPrompt({ ...options, roleDefinition: role }, this.config.maxPromptChars);
      return [job.key, profileHash(role)];
    }));
    const definitionSha256 = groupDefinitionSha256(definition), release = this.store.state.acquire('group-registry');
    try {
      try {
        const existing = this.store.read(groupId);
        if (existing.definitionSha256 !== definitionSha256) throw new BridgeError('GROUP_CONFLICT', 'This group ID already belongs to another definition');
        return this.summary(existing);
      } catch (error) { if (!(error instanceof BridgeError) || error.code !== 'GROUP_NOT_FOUND') throw error; }
      if (this.store.list().length >= 100) throw new BridgeError('GROUP_LIMIT_EXCEEDED', 'At most 100 retained groups are supported');
      const now = new Date().toISOString(), record: GroupRecord = {
        version: 1, groupId, definitionSha256, definition, profiles,
        nodes: Object.fromEntries(Object.entries(initialGroupProgress(graph({ definition }))).map(([key, state]) => [key, { state }])),
        state: 'created', createdAt: now, updatedAt: now,
      };
      this.store.write(record); return this.summary(record);
    } finally { release(); }
  }
  status(groupId: string) { return this.summary(this.store.read(groupId)); }
  list() { return this.store.list().map(record => this.summary(record)); }

  start(groupId: string, expectedDefinitionSha256: string) {
    if (this.stopped) throw new BridgeError('AGY_PROCESS_FAILED', 'Group coordinator is stopping');
    const release = this.store.state.acquire('group-' + groupId.toLowerCase());
    let record: GroupRecord;
    try {
      record = this.store.read(groupId);
      this.summary(record);
      if (record.definitionSha256 !== expectedDefinitionSha256) throw new BridgeError('GROUP_CHANGED', 'Inspect the current group definition before starting');
      if (finished.has(record.state)) return this.summary(record);
      if (record.state === 'running' && record.ownerId !== this.ownerId && record.ownerPid && processAlive(record.ownerPid)) throw new BridgeError('GROUP_OWNED_BY_OTHER_SERVER', 'Another live server coordinates this group');
      record.state = 'running'; record.ownerPid = process.pid; record.ownerId = this.ownerId; delete record.error;
      record.updatedAt = new Date().toISOString(); this.store.write(record);
    } finally { release(); }
    this.launch(record.groupId);
    return this.summary(record);
  }

  private launch(groupId: string): void {
    if (this.loops.has(groupId)) return;
    const loop = this.run(groupId).finally(() => this.loops.delete(groupId));
    this.loops.set(groupId, loop);
  }
  private async run(groupId: string): Promise<void> {
    while (!this.stopped) {
      try { if (!await this.advance(groupId)) return; }
      catch (error) {
        if (!(error instanceof BridgeError) || error.code !== 'STATE_BUSY') {
          try {
            const release = this.store.state.acquire('group-' + groupId);
            try {
              const record = this.store.read(groupId);
              if (record.ownerId === this.ownerId && record.state === 'running') {
                record.state = 'paused'; record.error = { code: error instanceof BridgeError ? error.code : 'GROUP_COORDINATION_FAILED', message: 'Coordination stopped; inspect existing tasks before explicitly resuming' };
                record.updatedAt = new Date().toISOString(); this.store.write(record);
              }
            } finally { release(); }
          } catch { /* Preserve state when it cannot be safely updated. No automatic replay. */ }
          return;
        }
      }
      await delay(100);
    }
  }

  private async advance(groupId: string): Promise<boolean> {
    let selected: GroupDefinition['jobs'][number] | undefined, definitionSha256 = '', workingDirectory = '';
    const release = this.store.state.acquire('group-' + groupId);
    try {
      const record = this.store.read(groupId);
      if (record.state !== 'running' || record.ownerId !== this.ownerId) return false;
      const retained = this.tasks.list();
      for (const job of record.definition.jobs) {
        const node = record.nodes[job.key]!;
        const task = node.taskId ? retained.find(task => task.taskId.toLowerCase() === node.taskId?.toLowerCase()) :
          retained.find(task => task.group?.groupId.toLowerCase() === groupId.toLowerCase() && task.group.nodeKey === job.key && task.group.rootTaskId.toLowerCase() === task.taskId.toLowerCase());
        if (task) this.assertMember(record, job.key, task);
        if (['completed', 'failed', 'cancelled', 'blocked'].includes(node.state)) continue;
        if (task) { node.taskId = task.taskId; node.state = observedState(task); node.error = task.error; }
        else if (node.taskId) { node.state = 'failed'; node.error = { code: 'GROUP_TASK_MISSING', message: 'Accepted task state is unavailable; it was not repeated' }; }
        else if (node.state === 'starting') { node.state = 'failed'; node.error = { code: 'GROUP_ADMISSION_UNVERIFIED', message: 'Admission checkpoint has no retained task identity; no model execution was repeated' }; }
      }
      const readiness = groupReadiness(graph(record), progress(record));
      for (const key of readiness.blocked) record.nodes[key] = { state: 'blocked', error: { code: 'DEPENDENCY_FAILED', message: 'A prerequisite did not complete successfully' } };
      if (readiness.terminal) {
        record.state = Object.values(record.nodes).every(node => node.state === 'completed') ? 'completed' : 'failed';
      } else {
        const key = record.definition.jobs.find(job => record.nodes[job.key]!.state === 'starting' && !record.nodes[job.key]!.taskId)?.key ?? readiness.ready[0];
        if (key) {
          selected = record.definition.jobs.find(job => job.key === key)!;
          if (profileHash(resolveRole(selected.owner, this.config.customRoles)) !== record.profiles[key]) throw new BridgeError('GROUP_PROFILE_CHANGED', 'Configured specialist changed; inspect the group before selecting a new definition');
          record.nodes[key] = { state: 'starting' }; definitionSha256 = record.definitionSha256; workingDirectory = record.definition.workingDirectory;
        }
      }
      record.updatedAt = new Date().toISOString(); this.store.write(record);
      if (record.state !== 'running') return false;
    } finally { release(); }
    if (!selected) return true;
    let task: TaskRecord | undefined, failure: { code: string; message: string } | undefined;
    try {
      task = await this.tasks.runInGroup({ ...selected.task, workingDirectory, deliveryMode: 'messages' },
        { groupId, nodeKey: selected.key, owner: selected.owner, definitionSha256 });
    } catch (error) {
      failure = { code: error instanceof BridgeError ? error.code : 'GROUP_ADMISSION_FAILED', message: 'Task admission failed; inspect retained tasks before new work' };
    }
    let cancel = false;
    const finish = this.store.state.acquire('group-' + groupId);
    try {
      const record = this.store.read(groupId), node = record.nodes[selected.key]!;
      if (task) {
        node.taskId = task.taskId; node.state = observedState(task); node.error = task.error;
        cancel = record.state !== 'running' || record.ownerId !== this.ownerId || this.stopped;
      } else { node.state = 'failed'; node.error = failure; }
      record.updatedAt = new Date().toISOString(); this.store.write(record);
    } finally { finish(); }
    if (cancel && task) await this.tasks.cancel(task.taskId);
    return !cancel;
  }

  async cancel(groupId: string) {
    const release = this.store.state.acquire('group-' + groupId.toLowerCase());
    let ids: string[];
    try {
      const record = this.store.read(groupId);
      if (finished.has(record.state)) return this.summary(record);
      if (record.ownerId && record.ownerId !== this.ownerId && record.ownerPid && processAlive(record.ownerPid)) throw new BridgeError('GROUP_OWNED_BY_OTHER_SERVER', 'Cancel the group in its coordinating server');
      this.summary(record);
      record.state = 'cancelled';
      ids = Object.values(record.nodes).flatMap(node => !['completed','failed','cancelled','blocked'].includes(node.state) && node.taskId ? [node.taskId] : []);
      for (const node of Object.values(record.nodes)) if (node.state === 'pending' || (node.state === 'starting' && !node.taskId)) node.state = 'cancelled';
      record.updatedAt = new Date().toISOString(); this.store.write(record);
    } finally { release(); }
    await Promise.all(ids.map(id => this.tasks.cancel(id)));
    return this.status(groupId);
  }

  async wait(groupId: string, cursors: WaitTarget[] = [], timeoutSeconds = 30, signal?: AbortSignal) {
    cursors = waitCursorsSchema.parse(cursors);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60) throw new BridgeError('INVALID_TIMEOUT', 'Wait timeout must be between 1 and 60 seconds');
    if (this.waiting >= this.config.maxConcurrentTasks + this.config.maxQueuedTasks) throw new BridgeError('WAIT_LIMIT_EXCEEDED', 'Too many concurrent group waits');
    this.waiting++;
    try {
      const deadline = Date.now() + timeoutSeconds * 1000;
      for (;;) {
        if (signal?.aborted) throw new BridgeError('WAIT_CANCELLED', 'Waiting cancelled; group execution continues');
        const record = this.store.read(groupId), group = this.summary(record);
        const targets = Object.values(record.nodes).flatMap(node => node.taskId ? [{ taskId: node.taskId, after: cursors.find(cursor => cursor.taskId.toLowerCase() === node.taskId?.toLowerCase())?.after ?? 0 }] : []);
        const page = jointWaitPage(this.tasks.list(), targets), ready = finished.has(group.state) && page.tasks.every(task => task.ready);
        if (ready || group.resumeRequired || page.hasMessages || Date.now() >= deadline) return { group, ready, timedOut: !ready && !group.resumeRequired && !page.hasMessages, hasMoreMessages: page.hasMoreMessages, tasks: page.tasks };
        try { await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal }); }
        catch { throw new BridgeError('WAIT_CANCELLED', 'Waiting cancelled; group execution continues'); }
      }
    } finally { this.waiting--; }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.loops.values());
    for (const record of this.store.list()) if (record.ownerId === this.ownerId && record.state === 'running') {
      const release = this.store.state.acquire('group-' + record.groupId);
      try { record.state = 'paused'; record.updatedAt = new Date().toISOString(); this.store.write(record); }
      finally { release(); }
    }
  }
}
