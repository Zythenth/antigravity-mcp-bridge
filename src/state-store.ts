import { memorySelectionSchema, memorySnapshotsSchema, summarizeMemory } from './memory-context.js';
import { computeProjectId, memorySummarySchema } from './project-memory.js';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { stagedExecutionPolicySchema } from './execution-policy.js';
import { resolvedAgentPolicySchema, nativeToolsSchema, mcpSelectionSchema } from './agent-policy.js';
import { bridgeMessageSchema, deliveryModeSchema } from './messages.js';
import { stagedSkillsSchema } from './skills.js';
import { BridgeError, type RunOptions, type TaskRecord } from './types.js';
import type { ProjectCopy } from './isolation.js';
import type { BridgeEvent } from './types.js';
import { usageCountersSchema } from './usage.js';
import { roleDefinitionSchema, effortSchema } from './roles.js';
import { parseSandboxPolicySnapshot, sandboxPolicyDigest, sandboxPolicySchema, type SandboxPolicySnapshot } from './sandbox-policy.js';

const uuid = /^[a-f0-9-]{36}$/;
const maxSandboxPolicyFileBytes = 2 * 20 * 1000 * 6 + 4096;
const modelSelectionSchema = z.object({ version: z.literal(1), model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).nullable() }).strict();
const snapshotSchema = z.object({
  version: z.literal(1), ownerPid: z.number().int().positive(),
  record: z.object({ taskId: z.string().uuid(), workingDirectory: z.string(), prompt: z.string(),
    status: z.enum(['queued', 'starting', 'running', 'streaming', 'completed', 'failed', 'cancelled', 'timeout']),
    createdAt: z.string().datetime(), completedAt: z.string().datetime().optional(), pid: z.number().int().positive().optional(),
    mode: z.enum(['write', 'read-only']).optional(), integratedAt: z.string().datetime().optional(), discardedAt: z.string().datetime().optional(),
    usageIsResume: z.boolean().optional(), usageBaseline: usageCountersSchema.optional(),
    lastObservedCliUsage: usageCountersSchema.optional(), usageProvenance: z.literal('local-executor').optional(),
    deliveryMode: deliveryModeSchema.optional(), messages: z.array(bridgeMessageSchema).max(100).optional(), messageCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    effort: effortSchema.optional(), roleDefinition: roleDefinitionSchema.optional(), providedSkills: stagedSkillsSchema.optional(),
    agentPolicyReceipt: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), decisionCount: z.number().int().nonnegative(), deniedCount: z.number().int().nonnegative() }).strict().optional(),
    memory: z.array(z.lazy(() => memorySummarySchema)).max(8).optional(),
    agentPolicy: resolvedAgentPolicySchema.optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    artifactPaths: z.array(z.string().min(1).max(1000)).min(1).max(100).optional(),
    structuredResult: z.object({ value: z.unknown(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
    artifacts: z.array(z.object({ path: z.string().min(1).max(1000), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() }).strict()).max(100).optional(),
    continuationTaskId: z.string().uuid().optional(), parentTaskId: z.string().uuid().optional(),
    sourceMessage: z.object({ taskId: z.string().uuid(), messageId: z.string().uuid() }).strict().optional(),
    dispatching: z.object({ messageId: z.string().uuid(), continuationTaskId: z.string().uuid().optional(), ownerId: z.string().uuid().optional() }).strict().optional(),
    inbox: z.array(z.object({
      messageId: z.string().uuid(),
      taskId: z.string().uuid(),
      text: z.string().min(1).max(2000),
      receivedAt: z.string().datetime(),
      receipt: z.object({
        messageId: z.string().uuid(),
        taskId: z.string().uuid(),
        state: z.enum(['queued', 'sent', 'failed', 'cancelled']),
        continuationTaskId: z.string().uuid().optional(),
        error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
      }).strict(),
    }).strict()).max(20).optional(),
  }).passthrough(),
  options: z.object({ memory: z.lazy(() => memorySelectionSchema).optional(), memorySnapshots: z.lazy(() => memorySnapshotsSchema).optional(), allowedTools: nativeToolsSchema.optional(), mcpServers: mcpSelectionSchema.optional(), agentPolicy: resolvedAgentPolicySchema.optional(), prompt: z.string(), workingDirectory: z.string(), effort: effortSchema.optional(), roleDefinition: roleDefinitionSchema.optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    artifactPaths: z.array(z.string().min(1).max(1000)).min(1).max(100).optional(),
  }).passthrough(),
  project: z.object({ executionPolicy: stagedExecutionPolicySchema.optional(), executionStateDirectory: z.string().optional(), sourceDirectory: z.string(), copyDirectory: z.string(), gitDirectory: z.string(),
    baseline: z.array(z.tuple([z.string(), z.string().regex(/^[a-f0-9]{64}$/)])), includedFiles: z.array(z.string()), providedSkills: stagedSkillsSchema.optional(),
  }).optional(),
  events: z.array(z.object({ taskId: z.string().uuid(), sequence: z.number().int().positive(), timestamp: z.string(), type: z.string(), data: z.unknown(), raw: z.unknown().optional() })),
  cursor: z.number().int().nonnegative(),
});

export interface StoredTask {
  record: TaskRecord;
  options: RunOptions;
  project?: ProjectCopy;
  ownerPid: number;
  events: BridgeEvent[];
  cursor: number;
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

// Windows can transiently deny replacement while another process holds the file.
// Keep the existing atomic rename and never unlink the last valid state as a fallback.
function replaceStateFile(temporary: string, target: string): void {
  const delays = [10, 20, 40, 80, 160];
  for (let attempt = 0; ; attempt++) {
    try { renameSync(temporary, target); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= delays.length) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
    }
  }
}

export class StateStore {
  constructor(private readonly directory: string) {
    if (!path.isAbsolute(directory)) throw new BridgeError('INVALID_STATE_DIRECTORY', 'BRIDGE_STATE_DIRECTORY must be absolute');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new BridgeError('INVALID_STATE_DIRECTORY', 'State directory cannot be a link');
  }

  private file(taskId: string): string {
    if (!uuid.test(taskId)) throw new BridgeError('INVALID_STATE', 'Invalid persisted task ID');
    return path.join(this.directory, taskId + '.json');
  }

  loadModel(): { model: string | null } | undefined {
    const file = path.join(this.directory, 'model-selection.json');
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('Unsafe model selection');
      return modelSelectionSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new BridgeError('INVALID_STATE', 'Invalid persisted model selection');
    }
  }

  loadSandboxPolicy(): SandboxPolicySnapshot {
    const file = path.join(this.directory, 'sandbox-policy.json');
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxSandboxPolicyFileBytes) throw new Error('Unsafe sandbox policy');
      return parseSandboxPolicySnapshot(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const policy = sandboxPolicySchema.parse({});
        return { version: 1, policy, sha256: sandboxPolicyDigest(policy) };
      }
      throw new BridgeError('INVALID_STATE', 'Invalid persisted sandbox policy');
    }
  }

  saveSandboxPolicy(snapshot: SandboxPolicySnapshot): void {
    let validated: SandboxPolicySnapshot;
    try { validated = parseSandboxPolicySnapshot(snapshot); }
    catch { throw new BridgeError('INVALID_STATE', 'Invalid sandbox policy snapshot'); }
    const target = path.join(this.directory, 'sandbox-policy.json');
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
      // Callers hold acquire('sandbox-policy') across reload, digest comparison, and this write; do not nest that lock here.
      this.loadSandboxPolicy();
      writeFileSync(temporary, JSON.stringify(validated), { flag: 'wx', mode: 0o600, flush: true });
      replaceStateFile(temporary, target);
    } finally { rmSync(temporary, { force: true }); }
  }

  saveModel(model: string | null): void {
    const selection = modelSelectionSchema.parse({ version: 1, model });
    const release = this.acquire('model-selection');
    const target = path.join(this.directory, 'model-selection.json');
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
      // Validate an existing record before replacing it, including links and malformed data.
      this.loadModel();
      writeFileSync(temporary, JSON.stringify(selection), { flag: 'wx', mode: 0o600, flush: true });
      replaceStateFile(temporary, target);
    } finally { rmSync(temporary, { force: true }); release(); }
  }

  save(task: StoredTask): void {
    const target = this.file(task.record.taskId);
    const temporary = target + '.' + randomUUID() + '.tmp';
    const snapshot = { ...task, version: 1, project: task.project && { ...task.project, baseline: [...task.project.baseline] } };
    try {
      writeFileSync(temporary, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600, flush: true });
      replaceStateFile(temporary, target);
    } finally { rmSync(temporary, { force: true }); }
  }

  load(): StoredTask[] {
    return readdirSync(this.directory).filter(name => uuid.test(name.slice(0, -5)) && name.endsWith('.json')).map(name => {
      const file = path.join(this.directory, name);
      if (lstatSync(file).isSymbolicLink() || lstatSync(file).size > 70_000_000) throw new BridgeError('INVALID_STATE', 'Unsafe persisted task file');
      let data;
      try { data = snapshotSchema.parse(JSON.parse(readFileSync(file, 'utf8'))); }
      catch { throw new BridgeError('INVALID_STATE', 'Invalid persisted task: ' + name); }
      if (data.record.taskId + '.json' !== name || !path.isAbsolute(data.record.workingDirectory) ||
          data.options.workingDirectory !== data.record.workingDirectory || data.options.prompt !== data.record.prompt ||
          data.events.some(event => event.taskId !== data.record.taskId || event.sequence > data.cursor)) {
        throw new BridgeError('INVALID_STATE', 'Persisted task does not match its identity');
      }
      const messages = data.record.messages ?? [];
      if (messages.some((message, index) => message.taskId !== data.record.taskId || message.sequence > (data.record.messageCursor ?? 0) ||
        (index > 0 && messages[index - 1]!.sequence >= message.sequence))) throw new BridgeError('INVALID_STATE', 'Persisted messages do not match task identity or cursor');
      const inbox = data.record.inbox ?? [];
      if (new Set(inbox.map(item => item.messageId.toLowerCase())).size !== inbox.length ||
        inbox.some(item => item.taskId !== data.record.taskId || item.receipt.taskId !== data.record.taskId || item.receipt.messageId !== item.messageId) ||
        (data.record.dispatching && !inbox.some(item => item.messageId === data.record.dispatching!.messageId && item.receipt.state === 'queued'))) {
        throw new BridgeError('INVALID_STATE', 'Persisted inbox does not match task identity');
      }
      const snapshots = data.options.memorySnapshots;
      if (snapshots?.some(entry => entry.projectId !== computeProjectId(data.record.workingDirectory)) ||
          JSON.stringify(data.record.memory) !== JSON.stringify(summarizeMemory(snapshots)) ||
          JSON.stringify(data.options.memory) !== JSON.stringify(snapshots?.map(({ specialist, sha256 }) => ({ specialist, sha256 })))) {
        throw new BridgeError('INVALID_STATE', 'Persisted private memory differs from its project, hashes or metadata');
      }
      if (data.record.agentPolicy?.sha256 !== data.options.agentPolicy?.sha256) throw new BridgeError('INVALID_STATE', 'Persisted task tool policies disagree');
      if (data.project) {
        if (Boolean(data.project.executionPolicy) !== Boolean(data.project.executionStateDirectory) || (data.project.executionStateDirectory && path.relative(realpathSync.native(data.project.executionStateDirectory), realpathSync.native(this.directory)) !== '') || (data.project.executionPolicy && data.project.executionPolicy.policy.sha256 !== data.record.agentPolicy?.sha256)) throw new BridgeError('INVALID_STATE', 'Persisted execution policy differs from task or private storage');
        for (const [directory, prefix] of [[data.project.copyDirectory, 'agy-mcp-copy-'], [data.project.gitDirectory, 'agy-mcp-baseline-']]) {
          if (!path.isAbsolute(directory!) || path.relative(os.tmpdir(), path.dirname(directory!)) !== '' || !path.basename(directory!).startsWith(prefix!)) {
            throw new BridgeError('INVALID_STATE', 'Persisted copy is outside bridge temporary storage');
          }
        }
        if (data.project.sourceDirectory !== data.record.workingDirectory) throw new BridgeError('INVALID_STATE', 'Persisted source differs from task');
      }
      return { ...data, record: data.record as unknown as TaskRecord, options: data.options as RunOptions,
        project: data.project && { ...data.project, baseline: new Map(data.project.baseline) } };
    }).sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));
  }

  drop(taskId: string): void { rmSync(this.file(taskId), { force: true }); }

  acquire(name: string): () => void {
    if (!/^[a-zA-Z0-9-]+$/.test(name)) throw new BridgeError('INVALID_STATE', 'Invalid lock name');
    const file = path.join(this.directory, name + '.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
        return () => rmSync(file, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let pid;
        try { pid = JSON.parse(readFileSync(file, 'utf8')).pid as unknown; } catch { /* an incomplete lock remains protected */ }
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1 || processAlive(pid)) {
          throw new BridgeError('STATE_BUSY', 'Another bridge operation owns this task or copy');
        }
        rmSync(file);
      }
    }
    throw new BridgeError('STATE_BUSY', 'Could not acquire bridge state lock');
  }
}
