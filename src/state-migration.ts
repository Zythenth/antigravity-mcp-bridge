import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, copyFileSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  readdirSync, renameSync, rmSync, rmdirSync, utimesSync, writeFileSync, type BigIntStats,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultStateDirectory, legacyStateDirectory, type Config } from './config.js';

// The state root was renamed once. The previous default root is copied into the new one, never moved or edited,
// so the previous build keeps working on its own root and a rollback needs no repair.
export const MIGRATION_MARKER = 'migrated-from-legacy.json';
const OWNER_FILE = '.migration-owner.json';
const STAGING_SUFFIX = '.migrating';
const ADOPTABLE_ENTRIES = new Set(['windows-runtimes']);
const ACTIVE_STATUSES = new Set(['queued', 'starting', 'running', 'streaming']);
const TASK_FILE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/i;
const MAX_LISTED_SKIPS = 200;

export type MigrationBlockReason = 'legacy-state-busy' | 'legacy-state-conflict' | 'legacy-state-migration-failed';

export interface MigrationMarker {
  version: 1;
  source: string;
  completedAt: string;
  files: number;
  bytes: number;
  sha256: string;
  skipped: Array<{ path: string; reason: string }>;
  skippedTotal: number;
  // Entries the new root already held when the copy was made. They were not taken from the previous root.
  kept?: string[];
}

export type MigrationOutcome =
  | { status: 'not-needed' }
  | { status: 'already-migrated'; marker: MigrationMarker }
  | { status: 'migrated'; marker: MigrationMarker }
  | { status: 'blocked'; reason: MigrationBlockReason; detail: string; pendingLeases?: true };

export interface MigrationOptions {
  legacy: string;
  target: string;
  isProcessAlive?: (pid: number) => boolean;
  // How long a second server waits for the one that is already migrating.
  waitMs?: number;
  // Test seam: called after each copied file, so a test can interrupt the copy.
  onFileCopied?: (relative: string) => void;
  // Test seam: called after a leftover staging root was inspected and before it is taken over.
  onStagingObserved?: () => void;
  onStagedValidated?: () => void;
}

class Blocked extends Error {
  constructor(readonly reason: MigrationBlockReason, detail: string, readonly pendingLeases = false) { super(detail); }
}

function defaultProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function kind(target: string): 'missing' | 'directory' | 'other' {
  try {
    const stat = lstatSync(target);
    return !stat.isSymbolicLink() && stat.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

export function readMigrationMarker(directory: string): MigrationMarker | undefined {
  const file = path.join(directory, MIGRATION_MARKER);
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1_000_000) return undefined;
    const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<MigrationMarker> | null;
    if (!data || typeof data !== 'object' || data.version !== 1 || typeof data.source !== 'string' || !path.isAbsolute(data.source) ||
        typeof data.completedAt !== 'string' || typeof data.files !== 'number' || typeof data.bytes !== 'number' ||
        typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256) || !Array.isArray(data.skipped) || typeof data.skippedTotal !== 'number' ||
        (data.kept !== undefined && (!Array.isArray(data.kept) || data.kept.some(name => typeof name !== 'string' || !ADOPTABLE_ENTRIES.has(name))))) return undefined;
    return data as MigrationMarker;
  } catch { return undefined; }
}

/** Copies and baselines persisted before the rename keep their original names until they are discarded. */
export function hasOwnedPrefix(name: string, role: 'copy' | 'baseline'): boolean {
  return name.startsWith(`black-gravity-${role}-`) || name.startsWith(`agy-mcp-${role}-`);
}

export function samePath(left: string, right: string): boolean {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isLockName(name: string): boolean {
  return name.endsWith('.lock') || name.endsWith('.lock.recovery');
}

function ownerText(file: string): string | undefined {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > 4096) return undefined;
    return readFileSync(file, 'utf8');
  } catch { return undefined; }
}

function ownerPid(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  try {
    const data = JSON.parse(text) as { pid?: unknown } | null;
    return data && typeof data === 'object' && typeof data.pid === 'number' && Number.isSafeInteger(data.pid) && data.pid > 0 ? data.pid : undefined;
  } catch { return undefined; }
}

function lockOwner(file: string): number | undefined {
  return ownerPid(ownerText(file));
}

function entries(directory: string): string[] {
  try { return readdirSync(directory).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

// Vendored skill snapshots may legitimately hold files named like locks, so only the directories where the bridge
// itself creates locks are inspected for them.
function lockDirectories(legacy: string): string[] {
  return [legacy, path.join(legacy, 'project-memory'), path.join(legacy, 'windows-runtimes')].filter(directory => kind(directory) === 'directory');
}

function assertLegacyIdle(legacy: string, alive: (pid: number) => boolean): void {
  for (const directory of lockDirectories(legacy)) {
    for (const name of entries(directory)) {
      if (!isLockName(name)) continue;
      const file = path.join(directory, name);
      if (kind(file) === 'missing') continue;
      const pid = lockOwner(file);
      if (pid === undefined) throw new Blocked('legacy-state-busy', 'Lock ' + file + ' has no verifiable owner');
      if (alive(pid)) throw new Blocked('legacy-state-busy', 'Lock ' + file + ' is held by live process ' + pid);
    }
  }
  const leases = path.join(legacy, 'windows-lpac-leases');
  if (kind(leases) === 'directory') {
    // Only lease files count: an interrupted lease update may leave a temporary file that recovery never reads.
    const pending = entries(leases).filter(name => name.endsWith('.json'));
    if (pending.length > 0) throw new Blocked('legacy-state-busy', 'Windows execution lease ' + path.join(leases, pending[0]!) + ' is active or awaits recovery', true);
  }
  for (const name of entries(legacy)) {
    if (!TASK_FILE.test(name)) continue;
    let snapshot: { ownerPid?: unknown; record?: { status?: unknown } } | null;
    try { snapshot = JSON.parse(readFileSync(path.join(legacy, name), 'utf8')) as typeof snapshot; }
    catch { continue; }
    const pid = snapshot?.ownerPid, status = snapshot?.record?.status;
    if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && typeof status === 'string' && ACTIVE_STATUSES.has(status) && alive(pid)) {
      throw new Blocked('legacy-state-busy', 'Task ' + name.slice(0, -5) + ' is still owned by live process ' + pid + ' of a previous server');
    }
  }
}

function digestFile(file: string): { sha256: string; size: number; mtimeMs: number; mode: number; atime: Date; mtime: Date } {
  const descriptor = openSync(file, constants.O_RDONLY);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Blocked('legacy-state-migration-failed', 'Not a regular file: ' + file);
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      size += read;
    }
    return { sha256: hash.digest('hex'), size, mtimeMs: stat.mtimeMs, mode: stat.mode, atime: stat.atime, mtime: stat.mtime };
  } finally { closeSync(descriptor); }
}

interface CopyTotals { files: number; bytes: number; digest: ReturnType<typeof createHash>; skipped: Array<{ path: string; reason: string }>; skippedTotal: number }

function skip(totals: CopyTotals, relative: string, reason: string): void {
  totals.skippedTotal++;
  if (totals.skipped.length < MAX_LISTED_SKIPS) totals.skipped.push({ path: relative, reason });
}

// An entry of the previous root that disappears under the copy means that root is still being written to.
function present<T>(read: () => T, file: string): T {
  try { return read(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Blocked('legacy-state-busy', 'Entry ' + file + ' disappeared while it was being copied');
    throw error;
  }
}

// A copy keeps the mode of its source, so it may be read-only. Outside Windows a read-only descriptor can be flushed;
// on Windows a flush needs write access, and a read-only copy is left to the flush of the system.
function flushFile(file: string): void {
  let descriptor: number;
  try { descriptor = openSync(file, process.platform === 'win32' ? 'r+' : 'r'); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) return;
    throw error;
  }
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function sameEntry(file: string, before: BigIntStats, directory: boolean): boolean {
  let now: BigIntStats;
  try { now = lstatSync(file, { bigint: true }); } catch { return false; }
  return !now.isSymbolicLink() && (directory ? now.isDirectory() : now.isFile()) && now.dev === before.dev && now.ino === before.ino;
}

// Without a destination nothing is written: the previous root is only hashed again, by the same rules and in the same order.
function copyTree(source: string, destination: string | undefined, relative: string, excluded: ReadonlySet<string>, totals: CopyTotals, onFileCopied?: (relative: string) => void): void {
  const inLockDirectory = relative === '' || relative === 'project-memory' || relative === 'windows-runtimes';
  for (const name of entries(source)) {
    const child = relative === '' ? name : relative + '/' + name;
    const from = path.join(source, name), to = destination === undefined ? undefined : path.join(destination, name);
    if (excluded.has(child)) { skip(totals, child, 'kept-from-new-root'); continue; }
    if (relative === '' && (name === MIGRATION_MARKER || name === OWNER_FILE)) { skip(totals, child, 'reserved-name'); continue; }
    const stat = present(() => lstatSync(from, { bigint: true }), from);
    if (stat.isSymbolicLink()) { skip(totals, child, 'link'); continue; }
    if (stat.isDirectory()) {
      if (to !== undefined) mkdirSync(to, { mode: 0o700 });
      copyTree(from, to, child, excluded, totals, onFileCopied);
      if (!sameEntry(from, stat, true)) throw new Blocked('legacy-state-busy', 'Directory ' + from + ' was replaced while it was being copied');
      if (to !== undefined && process.platform !== 'win32') chmodSync(to, Number(stat.mode) & 0o777);
      continue;
    }
    if (!stat.isFile()) { skip(totals, child, 'not-a-regular-file'); continue; }
    if (inLockDirectory && isLockName(name)) { skip(totals, child, 'lock'); continue; }
    if ((inLockDirectory || relative === 'windows-lpac-leases' || relative.startsWith('project-memory/')) && name.endsWith('.tmp')) { skip(totals, child, 'temporary'); continue; }
    const before = present(() => digestFile(from), from);
    if (to !== undefined) {
      present(() => copyFileSync(from, to, constants.COPYFILE_EXCL), from);
      flushFile(to);
      const copied = digestFile(to), after = present(() => digestFile(from), from);
      if (before.sha256 !== copied.sha256 || before.sha256 !== after.sha256 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Blocked('legacy-state-busy', 'File ' + from + ' changed while it was being copied');
      }
      if (process.platform !== 'win32') chmodSync(to, before.mode & 0o777);
      utimesSync(to, before.atime, before.mtime);
    }
    // The entry inspected before the read must still be the one that was read, so a link swapped in is never followed unnoticed.
    if (!sameEntry(from, stat, false)) throw new Blocked('legacy-state-busy', 'File ' + from + ' was replaced while it was being copied');
    totals.files++;
    totals.bytes += before.size;
    totals.digest.update(child + '\0' + before.sha256 + '\n');
    if (to !== undefined) onFileCopied?.(child);
  }
}

function newTotals(): CopyTotals {
  return { files: 0, bytes: 0, digest: createHash('sha256'), skipped: [], skippedTotal: 0 };
}

// A previous server that holds no lock at the moment can still write. The whole previous root is therefore hashed a
// second time, and any file that changed, appeared or disappeared since it was copied refuses the migration. The same
// walk checks a staged copy that an earlier start left complete.
function treeMatches(root: string, excluded: ReadonlySet<string>, files: number, sha256: string): boolean {
  const totals = newTotals();
  copyTree(root, undefined, '', excluded, totals);
  return totals.files === files && totals.digest.digest('hex') === sha256;
}

function assertSameRoot(legacy: string, root: BigIntStats): void {
  if (!sameEntry(legacy, root, true)) throw new Blocked('legacy-state-busy', 'The previous state root ' + legacy + ' was replaced while it was being copied');
}

function removeTree(directory: string): void {
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// Creating the staging root and taking a leftover one over are serialized by an exclusive gate file. It is held only
// for those few calls, and a gate left by a server that died while holding it is reported instead of being broken.
function withStagingGate<T>(staging: string, action: () => T): T {
  const gate = staging + '.takeover';
  for (const deadline = Date.now() + 5_000; ;) {
    try { writeFileSync(gate, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new Blocked('legacy-state-busy', 'Another server holds ' + gate + '. If no server is starting, remove that file and restart');
      }
      sleep(50);
    }
  }
  try { return action(); } finally { rmSync(gate, { force: true }); }
}

// A leftover staging root is moved away only while it still carries the owner record that was inspected, so a root
// that another server recreated in the meantime is never touched.
function discardStaging(staging: string, observedOwner: string | undefined): void {
  const stale = staging + '.stale-' + randomUUID();
  const moved = withStagingGate(staging, () => {
    if (kind(staging) === 'missing' || ownerText(path.join(staging, OWNER_FILE)) !== observedOwner) return false;
    renameSync(staging, stale);
    return true;
  });
  if (moved) removeTree(stale);
}

// Publication holds the staging gate and goes ahead only for the very staging root that was inspected or built, so a
// root that another server discarded and started again is never published by a server that validated its predecessor.
function publish(staging: string, target: string, marker: MigrationMarker, owner: string | undefined, identity: BigIntStats): MigrationOutcome | undefined {
  return withStagingGate(staging, () => {
    if (!sameEntry(staging, identity, true) || ownerText(path.join(staging, OWNER_FILE)) !== owner) return undefined;
    return publishStaged(staging, target, marker);
  });
}

function publishStaged(staging: string, target: string, marker: MigrationMarker): MigrationOutcome {
  rmSync(path.join(staging, OWNER_FILE), { force: true });
  if (kind(target) === 'directory') {
    for (const name of entries(target)) {
      if (!ADOPTABLE_ENTRIES.has(name)) throw new Blocked('legacy-state-conflict', 'The new state root ' + target + ' gained ' + name + ' during the migration');
      if (kind(path.join(staging, name)) === 'missing') renameSync(path.join(target, name), path.join(staging, name));
      else throw new Blocked('legacy-state-conflict', 'Both the staged copy and ' + target + ' hold ' + name);
    }
    rmdirSync(target);
  }
  try { renameSync(staging, target); }
  catch (error) {
    const published = readMigrationMarker(target);
    if (published) return { status: 'already-migrated', marker: published };
    throw error;
  }
  return { status: 'migrated', marker };
}

// A complete staged copy that will be discarded may already hold entries adopted from the new root, moved in by a
// publication that was interrupted. They go back first, so rebuilding the copy keeps them and still skips their
// counterparts of the previous root.
function returnAdopted(staging: string, target: string, staged: MigrationMarker, owner: string | undefined, identity: BigIntStats): void {
  if (!staged.kept?.length) return;
  withStagingGate(staging, () => {
    if (!sameEntry(staging, identity, true) || ownerText(path.join(staging, OWNER_FILE)) !== owner) return;
    for (const name of staged.kept!) {
      if (kind(path.join(staging, name)) !== 'directory' || kind(path.join(target, name)) !== 'missing') continue;
      mkdirSync(target, { recursive: true, mode: 0o700 });
      renameSync(path.join(staging, name), path.join(target, name));
    }
  });
}

function waitForPeer(target: string, staging: string, waitMs: number): MigrationMarker | 'gone' | 'still-there' {
  for (const deadline = Date.now() + waitMs; ;) {
    const marker = readMigrationMarker(target);
    if (marker) return marker;
    if (kind(staging) === 'missing') return 'gone';
    if (Date.now() >= deadline) return 'still-there';
    sleep(100);
  }
}

function migrate(options: MigrationOptions): MigrationOutcome {
  const { legacy, target } = options;
  const alive = options.isProcessAlive ?? defaultProcessAlive, waitMs = options.waitMs ?? 30_000;
  const staging = target + STAGING_SUFFIX;

  const targetKind = kind(target);
  if (targetKind === 'other') return { status: 'not-needed' };
  if (targetKind === 'directory') {
    const marker = readMigrationMarker(target);
    if (marker) return { status: 'already-migrated', marker };
  }
  const legacyKind = kind(legacy);
  if (legacyKind === 'missing') return { status: 'not-needed' };
  if (legacyKind === 'other') throw new Blocked('legacy-state-migration-failed', 'The previous state root ' + legacy + ' is not a real directory');
  const legacyRoot = lstatSync(legacy, { bigint: true });
  // An empty previous root holds no state, so there is nothing to migrate and nothing to conflict with.
  if (entries(legacy).length === 0) return { status: 'not-needed' };

  for (let attempt = 0; attempt < 3; attempt++) {
    // Another server may have published the migration since the last look.
    const published = attempt > 0 ? readMigrationMarker(target) : undefined;
    if (published) return { status: 'already-migrated', marker: published };
    const kept = kind(target) === 'directory' ? entries(target) : [];
    const foreign = kept.find(name => !ADOPTABLE_ENTRIES.has(name));
    if (foreign !== undefined) {
      throw new Blocked('legacy-state-conflict', 'Both ' + legacy + ' and ' + target + ' hold state (' + foreign + ') and ' + target + ' was not produced by a migration');
    }
    const excluded = new Set(kept);
    const token = randomUUID(), ownRecord = JSON.stringify({ pid: process.pid, token });
    // The owner record is written under the gate, so a staging root seen without one is never a root being created.
    const created = withStagingGate(staging, () => {
      try { mkdirSync(staging, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
      writeFileSync(path.join(staging, OWNER_FILE), ownRecord, { flag: 'wx', mode: 0o600, flush: true });
      return true;
    });
    if (!created) {
      if (kind(staging) !== 'directory') throw new Blocked('legacy-state-migration-failed', 'The staging path ' + staging + ' is not a real directory');
      const identity = lstatSync(staging, { bigint: true });
      const observed = ownerText(path.join(staging, OWNER_FILE)), owner = ownerPid(observed);
      const staged = readMigrationMarker(staging);
      if (staged && samePath(staged.source, legacy)) {
        // A complete staged copy is published only while it is intact and the previous root is idle and still holds
        // exactly what was copied. Entries adopted from the new root may already have been moved into it.
        const adopted = new Set([...kept, ...(staged.kept ?? [])]);
        assertLegacyIdle(legacy, alive);
        const intact = treeMatches(staging, adopted, staged.files, staged.sha256) && treeMatches(legacy, adopted, staged.files, staged.sha256);
        assertSameRoot(legacy, legacyRoot);
        if (intact) {
          options.onStagedValidated?.();
          const outcome = publish(staging, target, staged, observed, identity);
          if (outcome) return outcome;
          continue;
        }
        returnAdopted(staging, target, staged, observed, identity);
      } else if (owner === undefined || (owner !== process.pid && alive(owner))) {
        const peer = waitForPeer(target, staging, waitMs);
        if (typeof peer === 'object') return { status: 'already-migrated', marker: peer };
        if (peer === 'gone') continue;
        if (owner !== undefined && alive(owner)) throw new Blocked('legacy-state-busy', 'Process ' + owner + ' is still migrating into ' + staging);
      }
      options.onStagingObserved?.();
      discardStaging(staging, observed);
      continue;
    }
    try {
      assertLegacyIdle(legacy, alive);
      const totals = newTotals();
      copyTree(legacy, staging, '', excluded, totals, options.onFileCopied);
      const sha256 = totals.digest.digest('hex');
      assertLegacyIdle(legacy, alive);
      if (!treeMatches(legacy, excluded, totals.files, sha256)) {
        throw new Blocked('legacy-state-busy', 'The previous state root ' + legacy + ' changed while it was being copied');
      }
      assertSameRoot(legacy, legacyRoot);
      const marker: MigrationMarker = {
        version: 1, source: path.resolve(legacy), completedAt: new Date().toISOString(), files: totals.files, bytes: totals.bytes,
        sha256, skipped: totals.skipped, skippedTotal: totals.skippedTotal, ...(kept.length > 0 ? { kept } : {}),
      };
      const temporary = path.join(staging, MIGRATION_MARKER + '.' + token + '.tmp');
      writeFileSync(temporary, JSON.stringify(marker), { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temporary, path.join(staging, MIGRATION_MARKER));
      const outcome = publish(staging, target, marker, ownRecord, lstatSync(staging, { bigint: true }));
      if (!outcome) throw new Blocked('legacy-state-busy', 'The staging root ' + staging + ' was taken over by another server');
      return outcome;
    } catch (error) {
      // A staged copy that already carries its marker is complete, and the next start only has to publish it.
      if (!readMigrationMarker(staging)) {
        try { discardStaging(staging, ownRecord); } catch { /* the next start takes the leftover over */ }
      }
      throw error;
    }
  }
  throw new Blocked('legacy-state-busy', 'Another server keeps restarting the migration into ' + staging);
}

export function migrateLegacyState(options: MigrationOptions): MigrationOutcome {
  try { return migrate(options); }
  catch (error) {
    // Whatever stopped this attempt, a marker in the new root means another server completed the migration meanwhile.
    const published = readMigrationMarker(options.target);
    if (published) return { status: 'already-migrated', marker: published };
    if (error instanceof Blocked) return { status: 'blocked', reason: error.reason, detail: error.message, ...(error.pendingLeases ? { pendingLeases: true as const } : {}) };
    return { status: 'blocked', reason: 'legacy-state-migration-failed', detail: error instanceof Error ? error.message : String(error) };
  }
}

export interface DefaultStateOptions {
  home?: string;
  isProcessAlive?: (pid: number) => boolean;
  waitMs?: number;
  report?: (line: string) => void;
}

interface Resolution { config: Config; lines: string[]; legacy?: string }

// The previous root still holds earlier snapshots and receipts, so it stays protected like the current one.
function protectSource(config: Config, marker: MigrationMarker | undefined): Config {
  if (!marker) return config;
  let present = false;
  try { present = kind(marker.source) === 'directory'; } catch { /* an unreadable source is not a directory to protect */ }
  if (!present || config.forbiddenDirectories.some(entry => samePath(entry, marker.source))) return config;
  return { ...config, forbiddenDirectories: [...config.forbiddenDirectories, marker.source] };
}

// An explicit BRIDGE_STATE_DIRECTORY is used as given and never triggers a migration. When it names a root that a
// migration produced, the source of that migration is still protected.
function resolveDefaultState(config: Config, env: NodeJS.ProcessEnv, options: DefaultStateOptions): Resolution {
  const home = options.home ?? os.homedir();
  if (config.stateDirectoryInvalid) return { config, lines: [] };
  if (env.BRIDGE_STATE_DIRECTORY || !samePath(config.stateDirectory, defaultStateDirectory(home))) {
    return { config: protectSource(config, readMigrationMarker(config.stateDirectory)), lines: [] };
  }
  const legacy = legacyStateDirectory(home);
  const outcome = migrateLegacyState({ legacy, target: config.stateDirectory, isProcessAlive: options.isProcessAlive, waitMs: options.waitMs });
  if (outcome.status === 'not-needed') return { config, lines: [] };
  if (outcome.status === 'blocked') {
    return {
      config: { ...config, stateDirectoryInvalid: true, configurationIssues: [{ variable: 'BRIDGE_STATE_DIRECTORY', reason: outcome.reason }, ...config.configurationIssues] },
      lines: ['The previous state root ' + legacy + ' was not migrated to ' + config.stateDirectory + ' (' + outcome.reason + '): ' + outcome.detail +
        '. No state was copied. Resolve the cause and restart, or set BRIDGE_STATE_DIRECTORY to choose a root explicitly.'],
      legacy: outcome.pendingLeases ? legacy : undefined,
    };
  }
  const lines = outcome.status === 'migrated'
    ? ['Migrated ' + outcome.marker.files + ' state files from ' + legacy + ' to ' + config.stateDirectory + '. The previous root was kept.']
    : [];
  return { config: protectSource(config, outcome.marker), lines };
}

export function migrateDefaultState(config: Config, env: NodeJS.ProcessEnv, options: DefaultStateOptions = {}): Config {
  const resolved = resolveDefaultState(config, env, options);
  for (const line of resolved.lines) options.report?.(line);
  return resolved.config;
}

/**
 * Same as migrateDefaultState, but executions that the previous build left unfinished are first settled in the previous
 * root by `settle`, which follows the lease protocol of that root, and the migration is then attempted once more.
 */
export async function migrateDefaultStateSettling(
  config: Config, env: NodeJS.ProcessEnv, settle: (legacy: string) => Promise<void>, options: DefaultStateOptions = {},
): Promise<Config> {
  const first = resolveDefaultState(config, env, options);
  if (first.legacy === undefined) {
    for (const line of first.lines) options.report?.(line);
    return first.config;
  }
  try { await settle(first.legacy); }
  catch (error) {
    for (const line of first.lines) options.report?.(line);
    options.report?.('Unfinished executions of the previous root could not be settled: ' + (error instanceof Error ? error.message : String(error)));
    return first.config;
  }
  return migrateDefaultState(config, env, options);
}
