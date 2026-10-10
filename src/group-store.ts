import { workflowCheckpointSha256 } from './workflows.js';
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BridgeError } from './types.js';
import { StateStore, replaceStateFile } from './state-store.js';
import { groupRecordSchema, groupDefinitionSha256, type GroupRecord } from './group-contract.js';
import { groupReadiness } from './task-groups.js';

export class GroupStore {
  readonly state: StateStore;
  private readonly root: string;
  private readonly identity: string;
  constructor(directory: string) {
    this.state = new StateStore(directory);
    this.root = realpathSync.native(directory);
    this.identity = this.directoryIdentity();
  }
  private directoryIdentity(): string {
    let current = this.root;
    for (;;) {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BridgeError('INVALID_STATE', 'Unsafe group storage ancestry');
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
    const stat = lstatSync(this.root, { bigint: true });
    return stat.dev.toString() + ':' + stat.ino.toString();
  }
  private file(groupId: string): string {
    if (this.directoryIdentity() !== this.identity) throw new BridgeError('INVALID_STATE', 'Group storage identity changed');
    if (!/^[a-f0-9-]{36}$/i.test(groupId)) throw new BridgeError('INVALID_GROUP', 'Invalid group ID');
    return path.join(this.root, 'group-' + groupId.toLowerCase() + '.json');
  }
  read(groupId: string): GroupRecord {
    const file = this.file(groupId);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 5 * 1024 * 1024) throw Error('Unsafe group file');
      const record = groupRecordSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      if (record.groupId.toLowerCase() !== groupId.toLowerCase() || record.definitionSha256 !== groupDefinitionSha256(record.definition)) throw Error('Group identity or definition changed');
      for (const node of Object.values(record.nodes)) if (node.checkpoint && node.checkpoint.sha256 !== workflowCheckpointSha256(node.checkpoint.data)) throw Error('Workflow checkpoint identity changed');
      const keys = record.definition.jobs.map(job => job.key);
      if (Object.keys(record.profiles).length !== keys.length || keys.some(key => !Object.hasOwn(record.profiles, key))) throw Error('Group profiles mismatch');
      groupReadiness({ nodes: record.definition.jobs.map(({ key, owner, dependsOn }) => ({ key, owner, dependsOn })) },
        Object.fromEntries(Object.entries(record.nodes).map(([key, value]) => [key, value.state])));
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BridgeError('GROUP_NOT_FOUND', 'Unknown group');
      throw new BridgeError('INVALID_STATE', 'Invalid private group state');
    }
  }
  list(): GroupRecord[] {
    this.file(randomUUID());
    return readdirSync(this.root).filter(name => /^group-[a-f0-9-]{36}\.json$/.test(name)).map(name => this.read(name.slice(6, -5)));
  }
  write(record: GroupRecord): void {
    const validated = groupRecordSchema.parse(record), file = this.file(record.groupId), temporary = file + '.' + randomUUID() + '.tmp';
    // Callers hold the corresponding group lock across read, decision and write.
    try {
      try { this.read(record.groupId); } catch (error) { if (!(error instanceof BridgeError) || error.code !== 'GROUP_NOT_FOUND') throw error; }
      writeFileSync(temporary, JSON.stringify(validated), { flag: 'wx', mode: 0o600, flush: true });
      replaceStateFile(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
  }
}
