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
import { groupDefinitionSchema, groupDefinitionSha256, summarizeGroup, type GroupDefinition, type GroupRecord, type PeerDelivery } from './group-contract.js';
import { groupReadiness, initialGroupProgress, type GroupNodeStatus } from './task-groups.js';
import { jointWaitPage, waitCursorsSchema, type WaitTarget } from './joint-wait.js';
import { isPeerRouteAllowed } from './peer-messages.js';
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
  private conversation(record: GroupRecord, key: string, retained: TaskRecord[]) {
    const node = record.nodes[key]!;
    const referenced = node.taskId ? retained.find(task => task.taskId.toLowerCase() === node.taskId!.toLowerCase()) : undefined;
    if (referenced) this.assertMember(record, key, referenced);
    const related = retained.filter(task => task.group?.groupId.toLowerCase() === record.groupId.toLowerCase() && task.group.nodeKey === key);
    for (const task of related) this.assertMember(record, key, task);
    let latest = related.find(task => task.taskId === node.taskId);
    const seen = new Set<string>();
    while (latest) {
      if (seen.has(latest.taskId)) throw new BridgeError('INVALID_STATE', 'Group conversation contains a cycle');
      seen.add(latest.taskId);
      const children = related.filter(task => task.parentTaskId === latest!.taskId);
      if (children.length > 1) throw new BridgeError('INVALID_STATE', 'Group conversation has ambiguous continuations');
      const child = children[0];
      if (latest.continuationTaskId && child?.taskId !== latest.continuationTaskId) throw new BridgeError('GROUP_TASK_MISSING', 'Accepted continuation is unavailable');
      if (!child) break;
      latest = child;
    }
    if (related.length !== seen.size) throw new BridgeError('INVALID_STATE', 'Group conversation contains unlinked tasks');
    const executing = related.some(task => !finished.has(task.status) && task.status !== 'timeout' || !!task.dispatching);
    const active = executing || related.some(task => task.inbox?.some(item => item.receipt.state === 'queued'));
    return { latest, active, executing };
  }
  private summary(record: GroupRecord) {
    const retained = this.tasks.list();
    for (const [key, node] of Object.entries(record.nodes)) if (node.taskId) {
      const { latest, active } = this.conversation(record, key, retained);
      if (latest && !['failed','cancelled','blocked'].includes(node.state)) {
        node.state = active ? 'running' : observedState(latest); node.error = latest.error;
      }
    }
    return summarizeGroup(record, record.state === 'paused' || (record.state === 'running' && !!record.ownerPid && !processAlive(record.ownerPid)));
  }
  constructor(private readonly tasks: TaskManager, private readonly config: Config) { this.store = new GroupStore(config.stateDirectory); }

  private assertMember(record: GroupRecord, key: string, task: TaskRecord): void {
    if (task.group?.groupId.toLowerCase() !== record.groupId.toLowerCase() || task.group.nodeKey !== key ||
        task.group.owner !== record.definition.jobs.find(job => job.key === key)?.owner || task.role !== task.group.owner ||
        task.group.definitionSha256 !== record.definitionSha256 || task.workingDirectory !== record.definition.workingDirectory ||
        (record.nodes[key]?.taskId && task.group.rootTaskId.toLowerCase() !== record.nodes[key]!.taskId!.toLowerCase())) {
      throw new BridgeError('INVALID_STATE', 'A task reference does not belong to this exact group, node and project');
    }
  }

  peerReceipts(groupId: string, after = 0, limit = 20) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new BridgeError('INVALID_CURSOR', 'Use a nonnegative cursor and a page size between1 and20');
    const record = this.store.read(groupId), deliveries = record.peerDeliveries ?? [];
    const receipts = deliveries.slice(after, after + limit).map(({ messageId, sourceTaskId, sourceNode, toNode, state, sha256, continuationTaskId, error }) => ({
      messageId, sourceTaskId, fromNode: sourceNode, toNode, state, sha256, source: 'agy-reported' as const,
      ...(continuationTaskId ? { continuationTaskId } : {}), ...(error ? { error } : {}),
    }));
    return { receipts, nextCursor: after + receipts.length, hasMore: after + receipts.length < deliveries.length };
  }
  private collectPeers(record: GroupRecord, retained: TaskRecord[]): PeerDelivery | undefined {
    const deliveries = record.peerDeliveries ??= [];
    const members = retained.filter(task => task.group?.groupId.toLowerCase() === record.groupId.toLowerCase());
    for (const task of members) {
      this.assertMember(record, task.group!.nodeKey, task);
      if (task.peerRequestsTruncated) throw new BridgeError('PEER_LIMIT_EXCEEDED', 'Public peer requests were truncated; inspect retained task results');
      for (const input of task.peerRequests ?? []) {
        const messageId = input.messageId.toLowerCase();
        const existing = deliveries.find(item => item.sourceTaskId.toLowerCase() === task.taskId.toLowerCase() && item.messageId.toLowerCase() === messageId);
        if (existing) {
          if (existing.toNode !== input.toNode || existing.text !== input.text) throw new BridgeError('PEER_MESSAGE_CONFLICT', 'A public peer message ID identifies different content');
          continue;
        }
        if (deliveries.length >= 100 || deliveries.filter(item => item.sourceNode === task.group!.nodeKey).length >= 20) throw new BridgeError('PEER_LIMIT_EXCEEDED', 'At most100 messages per group and20 per source node are supported');
        const allowed = isPeerRouteAllowed(graph(record), record.definition.peerRoutes ?? [], task.group!.nodeKey, input.toNode);
        deliveries.push({ sourceTaskId: task.taskId, sourceNode: task.group!.nodeKey, messageId, toNode: input.toNode,
          text: input.text, sha256: createHash('sha256').update(input.text).digest('hex'), transportId: randomUUID(),
          state: allowed ? 'pending' : 'failed',
          ...(!allowed ? { error: { code: 'PEER_ROUTE_DENIED', message: 'This directed peer route was not selected' } } : {}) });
      }
    }
    let selected: PeerDelivery | undefined;
    for (const item of deliveries) {
      if (!['pending','queued'].includes(item.state)) continue;
      const sender = members.find(task => task.taskId === item.sourceTaskId);
      if (!sender || !sender.peerRequests?.some(input => input.messageId.toLowerCase() === item.messageId.toLowerCase() && input.text === item.text && input.toNode === item.toNode)) throw new BridgeError('INVALID_STATE', 'Peer delivery lost its public source request');
      const node = record.nodes[item.toNode];
      if (!node) throw new BridgeError('INVALID_STATE', 'Peer delivery target is unavailable');
      if (['failed','cancelled','blocked'].includes(node.state)) {
        item.state = node.state === 'cancelled' ? 'cancelled' : 'failed';
        item.error = { code: 'PEER_TARGET_FAILED', message: 'Target stopped before delivery' }; continue;
      }
      const target = item.targetTaskId ? retained.find(task => task.taskId === item.targetTaskId) : this.conversation(record, item.toNode, retained).latest;
      if (!target) {
        if (item.targetTaskId) throw new BridgeError('GROUP_TASK_MISSING', 'Peer target identity is unavailable; it was not repeated');
        continue;
      }
      this.assertMember(record, item.toNode, target);
      const inbox = target.inbox?.find(input => input.messageId === item.transportId);
      if (inbox) {
        item.state = inbox.receipt.state; item.continuationTaskId = inbox.receipt.continuationTaskId; item.error = inbox.receipt.error;
        if (item.state !== 'queued') continue;
      } else if (item.state === 'queued') throw new BridgeError('INVALID_STATE', 'Queued peer input is unavailable; it was not repeated');
      if (target.integratedAt || target.discardedAt || ['failed','timeout','cancelled'].includes(target.status)) {
        item.state = 'failed'; item.error = { code: 'INVALID_MESSAGE_TARGET', message: 'Target no longer retains a successful conversation' }; continue;
      }
      if (!selected && (item.state === 'pending' || !this.conversation(record, item.toNode, retained).executing)) {
        item.targetTaskId ??= target.taskId; selected = structuredClone(item);
      }
    }
    return selected;
  }
  private async dispatchPeer(groupId: string, delivery: PeerDelivery) {
    const current = this.store.read(groupId);
    if (current.state !== 'running' || current.ownerId !== this.ownerId || this.stopped) return;
    let receipt: Awaited<ReturnType<TaskManager['sendMessage']>>['receipt'] | undefined, failure: string | undefined;
    try {
      receipt = (await this.tasks.sendMessage(delivery.targetTaskId!, delivery.transportId, delivery.text, {
        groupId, fromNode: delivery.sourceNode, sourceTaskId: delivery.sourceTaskId, messageId: delivery.messageId,
      })).receipt;
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'STATE_BUSY') return;
      failure = error instanceof BridgeError ? error.code : 'PEER_DISPATCH_UNVERIFIED';
    }
    const release = this.store.state.acquire('group-' + groupId);
    try {
      const record = this.store.read(groupId), item = record.peerDeliveries?.find(item => item.transportId === delivery.transportId);
      if (!item || record.state !== 'running' || record.ownerId !== this.ownerId) return;
      if (receipt) { item.state = receipt.state; item.continuationTaskId = receipt.continuationTaskId; item.error = receipt.error; }
      else if (failure === 'PEER_DISPATCH_UNVERIFIED') {
        // Keep the persisted ID for an explicit same-input recovery, never invent a new turn.
        record.state = 'paused'; record.error = { code: failure, message: 'Delivery acknowledgment is unavailable; inspect the persisted input before resuming' };
      } else { item.state = 'failed'; item.error = { code: failure!, message: 'Peer input was not accepted' }; }
      record.updatedAt = new Date().toISOString(); this.store.write(record);
    } finally { release(); }
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
    let delivery: PeerDelivery | undefined, targets: string[] = [];
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
        if (['failed', 'cancelled', 'blocked'].includes(node.state)) continue;
        if (task) { node.taskId = task.taskId; const { latest, active } = this.conversation(record, job.key, retained); node.state = active ? 'running' : observedState(latest!); node.error = latest!.error; }
        else if (node.taskId) { node.state = 'failed'; node.error = { code: 'GROUP_TASK_MISSING', message: 'Accepted task state is unavailable; it was not repeated' }; }
        else if (node.state === 'starting') { node.state = 'failed'; node.error = { code: 'GROUP_ADMISSION_UNVERIFIED', message: 'Admission checkpoint has no retained task identity; no model execution was repeated' }; }
      }
      delivery = this.collectPeers(record, retained);
      const pendingPeers = record.peerDeliveries?.some(item => ['pending','queued'].includes(item.state));
      const readiness = groupReadiness(graph(record), progress(record));
      for (const key of readiness.blocked) record.nodes[key] = { state: 'blocked', error: { code: 'DEPENDENCY_FAILED', message: 'A prerequisite did not complete successfully' } };
      if (readiness.terminal && !pendingPeers) {
        record.state = Object.values(record.nodes).every(node => node.state === 'completed') && record.peerDeliveries?.every(item => item.state === 'sent') ? 'completed' : 'failed';
      } else if (!delivery) {
        const key = record.definition.jobs.find(job => record.nodes[job.key]!.state === 'starting' && !record.nodes[job.key]!.taskId)?.key ?? readiness.ready[0];
        if (key) {
          selected = record.definition.jobs.find(job => job.key === key)!;
          targets = (record.definition.peerRoutes ?? []).filter(route => route.from === key).map(route => route.to);
          if (profileHash(resolveRole(selected.owner, this.config.customRoles)) !== record.profiles[key]) throw new BridgeError('GROUP_PROFILE_CHANGED', 'Configured specialist changed; inspect the group before selecting a new definition');
          record.nodes[key] = { state: 'starting' }; definitionSha256 = record.definitionSha256; workingDirectory = record.definition.workingDirectory;
        }
      }
      record.updatedAt = new Date().toISOString(); this.store.write(record);
      if (record.state !== 'running') return false;
    } finally { release(); }
    if (delivery) { await this.dispatchPeer(groupId, delivery); return true; }
    if (!selected) return true;
    let task: TaskRecord | undefined, failure: { code: string; message: string } | undefined;
    try {
      task = await this.tasks.runInGroup({ ...selected.task, workingDirectory, deliveryMode: 'messages', peerContext: { groupId, nodeKey: selected.key, targets } },
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
      ids = this.tasks.list().filter(task => task.group?.groupId.toLowerCase() === record.groupId.toLowerCase() && !finished.has(task.status) && task.status !== 'timeout').map(task => { this.assertMember(record, task.group!.nodeKey, task); return task.taskId; });
      for (const item of record.peerDeliveries ?? []) if (['pending','queued'].includes(item.state)) { item.state = 'cancelled'; item.error = { code: 'GROUP_CANCELLED', message: 'Group stopped before delivery' }; }
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
        const retained = this.tasks.list();
        const targets = Object.keys(record.nodes).flatMap(key => {
          const taskId = this.conversation(record, key, retained).latest?.taskId ?? record.nodes[key]!.taskId;
          return taskId ? [{ taskId, after: cursors.find(cursor => cursor.taskId.toLowerCase() === taskId.toLowerCase())?.after ?? 0 }] : [];
        });
        const page = jointWaitPage(retained, targets), ready = finished.has(group.state) && page.tasks.every(task => task.ready);
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
