import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BridgeError } from './types.js';

export const memorySnapshotSchema = z.object({
  projectId: z.string().regex(/^[a-f0-9]{64}$/),
  specialist: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  text: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.string().datetime(),
}).strict();

export const memorySummarySchema = z.object({
  projectId: z.string().regex(/^[a-f0-9]{64}$/),
  specialist: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.string().datetime(),
  bytes: z.number().int().nonnegative(),
}).strict();

export type MemorySnapshot = z.infer<typeof memorySnapshotSchema>;
export type MemorySummary = z.infer<typeof memorySummarySchema>;

export interface ProjectMemoryLimits {
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
}

const memoryRecordSchema = z.object({
  version: z.literal(1),
  projectId: z.string().regex(/^[a-f0-9]{64}$/),
  specialist: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  text: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.string().datetime(),
}).strict();

type MemoryRecord = z.infer<typeof memoryRecordSchema>;

const SPECIALIST_REGEX = /^[a-z][a-z0-9-]{0,63}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WINDOWS_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function isWindowsDeviceName(name: string): boolean {
  const base = name.split('.')[0]?.toLowerCase() ?? '';
  return WINDOWS_DEVICE_NAMES.has(base);
}

export function computeMemorySha256(projectId: string, specialist: string, text: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, projectId, specialist, text }))
    .digest('hex');
}

export function computeProjectId(canonicalProjectPath: string): string {
  const identity = process.platform === 'win32'
    ? canonicalProjectPath.toLowerCase()
    : canonicalProjectPath;
  return createHash('sha256').update(identity).digest('hex');
}

function isVolumeRoot(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  return resolved === parsed.root || resolved === parsed.root.replace(/[\\/]+$/, '');
}

function checkNoAds(targetPath: string, code: string): void {
  const afterDrive = process.platform === 'win32' && /^[a-zA-Z]:/.test(targetPath)
    ? targetPath.slice(2)
    : targetPath;
  if (afterDrive.includes(':')) {
    throw new BridgeError(code, `Alternate Data Streams and colon are forbidden: ${targetPath}`);
  }
}

function checkNoDeviceNames(targetPath: string, code: string): void {
  const parts = targetPath.split(/[\\/]/);
  for (const part of parts) {
    if (part && isWindowsDeviceName(part)) {
      throw new BridgeError(code, `Path contains reserved Windows device name: ${part}`);
    }
  }
}

function verifySafeDirectory(targetPath: string, code: string): void {
  let current = path.resolve(targetPath);
  const parsed = path.parse(current);
  const root = parsed.root;
  while (current && current !== root) {
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        current = path.dirname(current);
        continue;
      }
      throw new BridgeError(code, `Failed to inspect path component: ${current}`);
    }
    if (stat.isSymbolicLink()) {
      throw new BridgeError(code, `Path component cannot be a link or junction: ${current}`);
    }
    current = path.dirname(current);
  }
}

function validateSpecialist(specialist: string): void {
  if (typeof specialist !== 'string' || !SPECIALIST_REGEX.test(specialist)) {
    throw new BridgeError('INVALID_SPECIALIST', `Invalid specialist ID: ${specialist}`);
  }
  if (isWindowsDeviceName(specialist)) {
    throw new BridgeError('INVALID_SPECIALIST', `Specialist ID cannot be a Windows device name: ${specialist}`);
  }
}

function replaceStateFile(temporary: string, target: string): void {
  const delays = [10, 20, 40, 80, 160];
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temporary, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const delay = delays[attempt];
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || delay === undefined) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

export class ProjectMemoryStore {
  readonly limits: {
    readonly maxEntries: number;
    readonly maxBytes: number;
    readonly maxEntryBytes: number;
  };
  private readonly memoryDirectory: string;
  private readonly canonicalStateDir: string;
  private readonly stateIdentity: string;
  private readonly memoryIdentity: string;

  constructor(
    readonly stateDirectory: string,
    limits?: ProjectMemoryLimits
  ) {
    if (typeof stateDirectory !== 'string' || !stateDirectory.trim()) {
      throw new BridgeError('INVALID_STATE_DIRECTORY', 'State directory cannot be empty');
    }
    if (!path.isAbsolute(stateDirectory)) {
      throw new BridgeError('INVALID_STATE_DIRECTORY', 'State directory must be absolute');
    }
    checkNoAds(stateDirectory, 'INVALID_STATE_DIRECTORY');
    checkNoDeviceNames(stateDirectory, 'INVALID_STATE_DIRECTORY');

    if (isVolumeRoot(stateDirectory)) {
      throw new BridgeError('INVALID_STATE_DIRECTORY', 'State directory cannot be volume root');
    }

    if (limits?.maxEntries !== undefined && (!Number.isSafeInteger(limits.maxEntries) || limits.maxEntries <= 0)) {
      throw new BridgeError('INVALID_MEMORY_INPUT', 'maxEntries must be a positive integer');
    }
    if (limits?.maxBytes !== undefined && (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0)) {
      throw new BridgeError('INVALID_MEMORY_INPUT', 'maxBytes must be a positive integer');
    }
    if (limits?.maxEntryBytes !== undefined && (!Number.isSafeInteger(limits.maxEntryBytes) || limits.maxEntryBytes <= 0)) {
      throw new BridgeError('INVALID_MEMORY_INPUT', 'maxEntryBytes must be a positive integer');
    }

    const maxEntries = limits?.maxEntries ?? 100;
    const maxBytes = limits?.maxBytes ?? 1024 * 1024;
    const maxEntryBytes = limits?.maxEntryBytes ?? 64 * 1024;

    if (maxEntryBytes > maxBytes) {
      throw new BridgeError('INVALID_MEMORY_INPUT', 'maxEntryBytes cannot exceed maxBytes');
    }

    this.limits = Object.freeze({ maxEntries, maxBytes, maxEntryBytes });

    verifySafeDirectory(this.stateDirectory, 'INVALID_STATE_DIRECTORY');
    try { mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 }); }
    catch { throw new BridgeError('INVALID_STATE_DIRECTORY', 'Memory storage must be an accessible directory'); }
    const stat = lstatSync(this.stateDirectory, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw new BridgeError('INVALID_STATE_DIRECTORY', 'State directory cannot be a link');
    }
    if (!stat.isDirectory()) {
      throw new BridgeError('INVALID_STATE_DIRECTORY', 'State directory must be a directory');
    }
    verifySafeDirectory(this.stateDirectory, 'INVALID_STATE_DIRECTORY');

    this.stateIdentity = stat.dev.toString() + ":" + stat.ino.toString();
    this.canonicalStateDir = realpathSync.native(this.stateDirectory);
    if (isVolumeRoot(this.canonicalStateDir)) {
      throw new BridgeError('INVALID_STATE_DIRECTORY', 'Canonical state directory cannot be volume root');
    }

    this.memoryDirectory = path.join(this.stateDirectory, 'project-memory');
    verifySafeDirectory(this.memoryDirectory, 'INVALID_STATE_DIRECTORY');
    try { mkdirSync(this.memoryDirectory, { recursive: true, mode: 0o700 }); }
    catch { throw new BridgeError('INVALID_STATE_DIRECTORY', 'Memory storage must be an accessible directory'); }
    const memStat = lstatSync(this.memoryDirectory, { bigint: true });
    if (memStat.isSymbolicLink() || !memStat.isDirectory()) {
      throw new BridgeError('INVALID_STATE_DIRECTORY', 'Memory directory cannot be a link');
    }
    this.memoryIdentity = memStat.dev.toString() + ':' + memStat.ino.toString();
    verifySafeDirectory(this.memoryDirectory, 'INVALID_STATE_DIRECTORY');
  }

  private verifyStorageAncestry(): void {
    let stateStat;
    try {
      stateStat = lstatSync(this.stateDirectory, { bigint: true });
    } catch (error) {
      throw new BridgeError('INVALID_STATE_DIRECTORY', `Cannot access state directory: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (stateStat.isSymbolicLink() || !stateStat.isDirectory() || stateStat.dev.toString() + ':' + stateStat.ino.toString() !== this.stateIdentity) {
      throw new BridgeError('INVALID_STATE_DIRECTORY', 'State directory cannot be a link or non-directory');
    }
    verifySafeDirectory(this.stateDirectory, 'INVALID_STATE_DIRECTORY');

    let canonical: string;
    try {
      canonical = realpathSync.native(this.stateDirectory);
    } catch (error) {
      throw new BridgeError('INVALID_STATE_DIRECTORY', `Could not resolve canonical state directory: ${error instanceof Error ? error.message : String(error)}`);
    }

    const normCanonical = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    const normExpected = process.platform === 'win32' ? this.canonicalStateDir.toLowerCase() : this.canonicalStateDir;
    if (normCanonical !== normExpected) {
      throw new BridgeError('INVALID_STATE_DIRECTORY', 'State directory identity changed');
    }
    if (isVolumeRoot(canonical)) {
      throw new BridgeError('INVALID_STATE_DIRECTORY', 'Canonical state directory cannot be volume root');
    }

    let memStat;
    try {
      memStat = lstatSync(this.memoryDirectory, { bigint: true });
    } catch (error) {
      throw new BridgeError('INVALID_STATE_DIRECTORY', `Cannot access memory directory: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (memStat.isSymbolicLink() || !memStat.isDirectory() || memStat.dev.toString() + ':' + memStat.ino.toString() !== this.memoryIdentity) {
      throw new BridgeError('INVALID_STATE_DIRECTORY', 'Memory directory cannot be a link or non-directory');
    }
    verifySafeDirectory(this.memoryDirectory, 'INVALID_STATE_DIRECTORY');
  }

  private resolveCanonicalProject(projectDirectory: string): { canonicalProject: string; projectId: string } {
    if (typeof projectDirectory !== 'string' || !projectDirectory.trim()) {
      throw new BridgeError('INVALID_PROJECT_DIRECTORY', 'Project directory cannot be empty');
    }
    if (!path.isAbsolute(projectDirectory)) {
      throw new BridgeError('INVALID_PROJECT_DIRECTORY', 'Project directory must be absolute');
    }
    checkNoAds(projectDirectory, 'INVALID_PROJECT_DIRECTORY');
    checkNoDeviceNames(projectDirectory, 'INVALID_PROJECT_DIRECTORY');

    if (isVolumeRoot(projectDirectory)) {
      throw new BridgeError('INVALID_PROJECT_DIRECTORY', 'Project directory cannot be volume root');
    }

    let stat;
    try {
      stat = lstatSync(projectDirectory);
    } catch {
      throw new BridgeError('INVALID_PROJECT_DIRECTORY', `Project directory does not exist: ${projectDirectory}`);
    }

    if (stat.isSymbolicLink()) {
      throw new BridgeError('INVALID_PROJECT_DIRECTORY', 'Project directory cannot be a link or junction');
    }
    if (!stat.isDirectory()) {
      throw new BridgeError('INVALID_PROJECT_DIRECTORY', 'Project directory must be a directory');
    }

    verifySafeDirectory(projectDirectory, 'INVALID_PROJECT_DIRECTORY');

    let canonical: string;
    try {
      canonical = realpathSync.native(projectDirectory);
    } catch (error) {
      throw new BridgeError('INVALID_PROJECT_DIRECTORY', `Could not resolve canonical project path: ${projectDirectory}`);
    }

    if (isVolumeRoot(canonical)) {
      throw new BridgeError('INVALID_PROJECT_DIRECTORY', 'Canonical project directory cannot be volume root');
    }

    verifySafeDirectory(canonical, 'INVALID_PROJECT_DIRECTORY');
    this.checkOverlap(canonical);

    const projectId = computeProjectId(canonical);
    return { canonicalProject: canonical, projectId };
  }

  private checkOverlap(canonicalProject: string): void {
    const normProject = process.platform === 'win32' ? canonicalProject.toLowerCase() : canonicalProject;
    const normState = process.platform === 'win32' ? this.canonicalStateDir.toLowerCase() : this.canonicalStateDir;

    if (normProject === normState) {
      throw new BridgeError('INVALID_PROJECT_DIRECTORY', 'Project directory overlaps with state directory');
    }

    const rel1 = path.relative(normProject, normState);
    if (!rel1.startsWith('..') && !path.isAbsolute(rel1)) {
      throw new BridgeError('INVALID_PROJECT_DIRECTORY', 'State directory cannot be inside project directory');
    }

    const rel2 = path.relative(normState, normProject);
    if (!rel2.startsWith('..') && !path.isAbsolute(rel2)) {
      throw new BridgeError('INVALID_PROJECT_DIRECTORY', 'Project directory cannot be inside state directory');
    }
  }

  private acquireLock(): () => void {
    const lockFile = path.join(this.memoryDirectory, 'memory.lock');
    const token = randomUUID();
    const delays = [10, 20, 40, 80, 160];
    let ownedIdentity: { dev: bigint; ino: bigint } | undefined;

    for (let attempt = 0; ; attempt++) {
      try {
        writeFileSync(
          lockFile,
          JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }),
          { flag: 'wx', mode: 0o600 }
        );
        const identity = lstatSync(lockFile, { bigint: true }); ownedIdentity = { dev: identity.dev, ino: identity.ino };
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new BridgeError('MEMORY_BUSY', 'Failed to acquire memory lock: ' + (error instanceof Error ? error.message : String(error)));
        }

        let stat;
        try {
          stat = lstatSync(lockFile, { bigint: true });
        } catch (inspectError) {
          throw new BridgeError('MEMORY_BUSY', 'Failed to inspect existing memory lock: ' + (inspectError instanceof Error ? inspectError.message : String(inspectError)));
        }

        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n || stat.size > 1024n) {
          throw new BridgeError('MEMORY_BUSY', 'Memory lock is not a regular file');
        }

        let lockData: { pid?: unknown; token?: unknown; createdAt?: unknown };
        try {
          const content = readFileSync(lockFile, 'utf8');
          lockData = JSON.parse(content);
        } catch {
          throw new BridgeError('MEMORY_BUSY', 'Memory lock is malformed');
        }

        if (
          !lockData ||
          typeof lockData !== 'object' ||
          typeof lockData.pid !== 'number' ||
          !Number.isSafeInteger(lockData.pid) ||
          lockData.pid <= 0 ||
          typeof lockData.token !== 'string' ||
          !UUID_REGEX.test(lockData.token)
        ) {
          throw new BridgeError('MEMORY_BUSY', 'Memory lock contains invalid data');
        }

        const lockPid = lockData.pid;
        const lockToken = lockData.token;

        if (processAlive(lockPid)) {
          const delay = delays[attempt];
          if (delay === undefined) {
            throw new BridgeError('MEMORY_BUSY', 'Project memory is busy');
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
          continue;
        }

        const recoveryFile = path.join(this.memoryDirectory, 'memory-recovery.lock');
        const recoveryToken = randomUUID();
        let recoveryIdentity;
        try {
          writeFileSync(recoveryFile, JSON.stringify({ pid: process.pid, token: recoveryToken }), { flag: 'wx', mode: 0o600 });
          recoveryIdentity = lstatSync(recoveryFile, { bigint: true });
        } catch {
          throw new BridgeError('MEMORY_BUSY', 'Another recovery owns the gate, or an abandoned recovery gate needs inspection');
        }
        try {
          this.verifyStorageAncestry();
          const current = lstatSync(lockFile, { bigint: true });
          const data = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid?: unknown; token?: unknown };
          if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n || current.size > 1024n || current.dev !== stat.dev || current.ino !== stat.ino || data.pid !== lockPid || data.token !== lockToken || processAlive(lockPid)) throw new BridgeError('MEMORY_BUSY', 'Lock identity changed before recovery');
          rmSync(lockFile);
        } catch (error) {
          if (error instanceof BridgeError) throw error;
          throw new BridgeError('MEMORY_BUSY', 'Lock could not be safely recovered');
        } finally {
          const current = lstatSync(recoveryFile, { bigint: true });
          if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n || current.size > 1024n || current.dev !== recoveryIdentity.dev || current.ino !== recoveryIdentity.ino) throw new BridgeError('MEMORY_BUSY', 'Recovery gate identity changed; it was preserved');
          const data = JSON.parse(readFileSync(recoveryFile, 'utf8')) as { pid?: unknown; token?: unknown };
          if (data.pid !== process.pid || data.token !== recoveryToken) throw new BridgeError('MEMORY_BUSY', 'Recovery gate ownership changed; it was preserved');
          rmSync(recoveryFile);
        }

        continue;
      }
    }

    return () => {
      let stat;
      try {
        stat = lstatSync(lockFile, { bigint: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new BridgeError('MEMORY_BUSY', 'Owned lock disappeared before release');
        throw new BridgeError('MEMORY_BUSY', `Failed to stat lock file during release: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n || stat.dev !== ownedIdentity?.dev || stat.ino !== ownedIdentity?.ino) {
        throw new BridgeError('MEMORY_BUSY', 'Lock file is invalid during release');
      }

      let content: string;
      try {
        content = readFileSync(lockFile, 'utf8');
      } catch (err) {
        throw new BridgeError('MEMORY_BUSY', `Failed to read lock file during release: ${err instanceof Error ? err.message : String(err)}`);
      }

      let data: { pid?: unknown; token?: unknown };
      try {
        data = JSON.parse(content);
      } catch {
        throw new BridgeError('MEMORY_BUSY', 'Lock file corrupted during release');
      }

      if (data.token !== token || data.pid !== process.pid) {
        throw new BridgeError('MEMORY_BUSY', 'Lock identity or token mismatch during release');
      }

      try {
        rmSync(lockFile);
      } catch (cleanupError) {
        throw new BridgeError('MEMORY_BUSY', `Failed to remove lock file during release: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
    };
  }

  private readRecord(filePath: string, expectedProjectId: string, expectedSpecialist: string): MemoryRecord {
    verifySafeDirectory(filePath, 'INVALID_MEMORY_STATE');
    let stat;
    try {
      stat = lstatSync(filePath);
    } catch {
      throw new BridgeError('INVALID_MEMORY_STATE', `Cannot stat memory file: ${filePath}`);
    }

    if (stat.isSymbolicLink()) {
      throw new BridgeError('INVALID_MEMORY_STATE', `Memory file cannot be a symbolic link: ${filePath}`);
    }
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new BridgeError('INVALID_MEMORY_STATE', `Memory file must be a regular file: ${filePath}`);
    }
    if (stat.size <= 0) {
      throw new BridgeError('INVALID_MEMORY_STATE', `Memory file is empty: ${filePath}`);
    }
    if (stat.size > this.limits.maxEntryBytes * 6 + 8192) {
      throw new BridgeError('INVALID_MEMORY_STATE', `Memory file size exceeds allowable entry limit: ${filePath}`);
    }

    let rawJson: unknown;
    try {
      const content = readFileSync(filePath, 'utf8');
      rawJson = JSON.parse(content);
    } catch {
      throw new BridgeError('INVALID_MEMORY_STATE', `Memory file contains invalid JSON: ${filePath}`);
    }

    const parsed = memoryRecordSchema.safeParse(rawJson);
    if (!parsed.success) {
      throw new BridgeError('INVALID_MEMORY_STATE', `Memory file does not match memory schema: ${filePath}`);
    }

    const record = parsed.data;

    if (record.text.includes('\0')) {
      throw new BridgeError('INVALID_MEMORY_STATE', `Memory text contains NUL character: ${filePath}`);
    }

    const byteLength = Buffer.byteLength(record.text, 'utf8');
    if (byteLength > this.limits.maxEntryBytes) {
      throw new BridgeError('INVALID_MEMORY_STATE', `Memory text exceeds entry byte limit: ${filePath}`);
    }

    if (record.projectId !== expectedProjectId) {
      throw new BridgeError('INVALID_MEMORY_STATE', `Memory projectId mismatch (expected ${expectedProjectId}, got ${record.projectId})`);
    }
    if (record.specialist !== expectedSpecialist) {
      throw new BridgeError('INVALID_MEMORY_STATE', `Memory specialist mismatch (expected ${expectedSpecialist}, got ${record.specialist})`);
    }

    if (record.sha256 !== computeMemorySha256(record.projectId, record.specialist, record.text)) {
      throw new BridgeError('INVALID_MEMORY_STATE', `Memory content hash mismatch: ${filePath}`);
    }

    return record;
  }

  private calculateGlobalUsageExcluding(excludeProjectId: string, excludeSpecialist: string): { totalEntries: number; totalBytes: number } {
    let totalEntries = 0;
    let totalBytes = 0;

    let entries: string[];
    try {
      entries = readdirSync(this.memoryDirectory);
    } catch (err) {
      throw new BridgeError('INVALID_MEMORY_STATE', `Failed to read memory directory: ${err instanceof Error ? err.message : String(err)}`);
    }

    for (const entry of entries) {
      if (entry === 'memory.lock' || entry === 'memory-recovery.lock') {
        const lock = lstatSync(path.join(this.memoryDirectory, entry));
        if (lock.isSymbolicLink() || !lock.isFile() || lock.nlink !== 1 || lock.size > 1024) throw new BridgeError('INVALID_MEMORY_STATE', 'Unsafe memory lock metadata');
        continue;
      }

      const entryPath = path.join(this.memoryDirectory, entry);
      const entryStat = lstatSync(entryPath);

      if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
        throw new BridgeError('INVALID_MEMORY_STATE', `Invalid non-directory entry in memory directory: ${entry}`);
      }

      if (!/^[a-f0-9]{64}$/.test(entry)) {
        throw new BridgeError('INVALID_MEMORY_STATE', `Unknown directory in memory directory: ${entry}`);
      }

      const projectFiles = readdirSync(entryPath);
      for (const file of projectFiles) {
        const filePath = path.join(entryPath, file);
        const fileStat = lstatSync(filePath);

        if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
          throw new BridgeError('INVALID_MEMORY_STATE', `Invalid entry in project directory: ${file}`);
        }

        if (!file.endsWith('.json')) {
          throw new BridgeError('INVALID_MEMORY_STATE', `Unknown file in project directory: ${file}`);
        }

        const specialist = file.slice(0, -5);
        if (!SPECIALIST_REGEX.test(specialist) || isWindowsDeviceName(specialist)) {
          throw new BridgeError('INVALID_MEMORY_STATE', `Invalid specialist filename: ${file}`);
        }

        if (entry === excludeProjectId && specialist === excludeSpecialist) {
          continue;
        }

        const record = this.readRecord(filePath, entry, specialist);
        totalEntries += 1;
        totalBytes += Buffer.byteLength(record.text, 'utf8');
      }
    }

    return { totalEntries, totalBytes };
  }

  async read(projectDirectory: string, specialist: string): Promise<MemorySnapshot | null> {
    this.verifyStorageAncestry();
    validateSpecialist(specialist);
    const { projectId } = this.resolveCanonicalProject(projectDirectory);
    const releaseLock = this.acquireLock();
    try {
      const projectDir = path.join(this.memoryDirectory, projectId);
      verifySafeDirectory(projectDir, 'INVALID_MEMORY_STATE');
      let projectDirStat;
      try {
        projectDirStat = lstatSync(projectDir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return null;
        }
        throw new BridgeError('INVALID_MEMORY_STATE', `Cannot access project directory: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (projectDirStat.isSymbolicLink() || !projectDirStat.isDirectory()) {
        throw new BridgeError('INVALID_MEMORY_STATE', `Project memory directory is invalid: ${projectDir}`);
      }

      const targetFile = path.join(projectDir, `${specialist}.json`);
      let targetStat;
      try {
        targetStat = lstatSync(targetFile);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return null;
        }
        throw new BridgeError('INVALID_MEMORY_STATE', `Cannot access target memory file: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (targetStat.isSymbolicLink()) {
        throw new BridgeError('INVALID_MEMORY_STATE', `Memory file cannot be a symbolic link: ${targetFile}`);
      }
      if (!targetStat.isFile()) {
        throw new BridgeError('INVALID_MEMORY_STATE', `Memory file must be a regular file: ${targetFile}`);
      }

      const record = this.readRecord(targetFile, projectId, specialist);
      return {
        projectId: record.projectId,
        specialist: record.specialist,
        text: record.text,
        sha256: record.sha256,
        updatedAt: record.updatedAt,
      };
    } finally {
      releaseLock();
    }
  }

  async list(projectDirectory: string): Promise<MemorySummary[]> {
    this.verifyStorageAncestry();
    const { projectId } = this.resolveCanonicalProject(projectDirectory);
    const releaseLock = this.acquireLock();
    try {
      const projectDir = path.join(this.memoryDirectory, projectId);
      verifySafeDirectory(projectDir, 'INVALID_MEMORY_STATE');
      let projectDirStat;
      try {
        projectDirStat = lstatSync(projectDir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return [];
        }
        throw new BridgeError('INVALID_MEMORY_STATE', `Cannot access project directory: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (projectDirStat.isSymbolicLink() || !projectDirStat.isDirectory()) {
        throw new BridgeError('INVALID_MEMORY_STATE', `Project memory directory is invalid: ${projectDir}`);
      }

      const entries = readdirSync(projectDir);
      const summaries: MemorySummary[] = [];

      for (const entry of entries) {
        const entryPath = path.join(projectDir, entry);
        const entryStat = lstatSync(entryPath);

        if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
          throw new BridgeError('INVALID_MEMORY_STATE', `Unknown or non-file entry in project memory: ${entry}`);
        }

        if (!entry.endsWith('.json')) {
          throw new BridgeError('INVALID_MEMORY_STATE', `Unknown file in project memory: ${entry}`);
        }

        const specialist = entry.slice(0, -5);
        if (!SPECIALIST_REGEX.test(specialist) || isWindowsDeviceName(specialist)) {
          throw new BridgeError('INVALID_MEMORY_STATE', `Invalid specialist filename: ${entry}`);
        }

        const record = this.readRecord(entryPath, projectId, specialist);
        summaries.push({
          projectId: record.projectId,
          specialist: record.specialist,
          sha256: record.sha256,
          updatedAt: record.updatedAt,
          bytes: Buffer.byteLength(record.text, 'utf8'),
        });
      }

      summaries.sort((a, b) => a.specialist.localeCompare(b.specialist));
      return summaries;
    } finally {
      releaseLock();
    }
  }

  async write(
    projectDirectory: string,
    specialist: string,
    { text, expectedSha256 }: { text: string; expectedSha256: string | null }
  ): Promise<MemorySnapshot> {
    this.verifyStorageAncestry();
    validateSpecialist(specialist);

    if (typeof text !== 'string') {
      throw new BridgeError('INVALID_MEMORY_INPUT', 'Memory text must be a string');
    }
    if (text.length === 0) {
      throw new BridgeError('INVALID_MEMORY_INPUT', 'Memory text cannot be empty');
    }
    if (text.includes('\0')) {
      throw new BridgeError('INVALID_MEMORY_INPUT', 'Memory text cannot contain NUL character');
    }

    const textBytes = Buffer.byteLength(text, 'utf8');
    if (textBytes > this.limits.maxEntryBytes) {
      throw new BridgeError('MEMORY_LIMIT_EXCEEDED', `Memory text size ${textBytes} bytes exceeds maximum entry size of ${this.limits.maxEntryBytes} bytes`);
    }

    if (expectedSha256 !== null && (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedSha256))) {
      throw new BridgeError('INVALID_MEMORY_INPUT', 'expectedSha256 must be null or a 64-character hex string');
    }

    const { projectId } = this.resolveCanonicalProject(projectDirectory);
    const releaseLock = this.acquireLock();

    try {
      this.verifyStorageAncestry();
      const projectDir = path.join(this.memoryDirectory, projectId);
      verifySafeDirectory(projectDir, 'INVALID_MEMORY_STATE');
      const targetFile = path.join(projectDir, `${specialist}.json`);

      let currentRecord: MemoryRecord | null = null;
      let targetStat;
      try {
        targetStat = lstatSync(targetFile);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          throw new BridgeError('INVALID_MEMORY_STATE', `Cannot access target memory file: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (targetStat) {
        if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
          throw new BridgeError('INVALID_MEMORY_STATE', `Target memory file is invalid: ${targetFile}`);
        }
        currentRecord = this.readRecord(targetFile, projectId, specialist);
      }

      if (expectedSha256 === null) {
        if (currentRecord !== null) {
          throw new BridgeError('MEMORY_CHANGED', `Memory entry already exists for specialist: ${specialist}`);
        }
      } else {
        if (currentRecord === null) {
          throw new BridgeError('MEMORY_CHANGED', `Memory entry does not exist for specialist: ${specialist}`);
        }
        if (currentRecord.sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
          throw new BridgeError('MEMORY_CHANGED', `Memory hash mismatch: expected ${expectedSha256}, current ${currentRecord.sha256}`);
        }
      }

      const { totalEntries, totalBytes } = this.calculateGlobalUsageExcluding(projectId, specialist);
      if (totalEntries + 1 > this.limits.maxEntries) {
        throw new BridgeError('MEMORY_LIMIT_EXCEEDED', `Total memory entries (${totalEntries + 1}) exceeds limit of ${this.limits.maxEntries}`);
      }
      if (totalBytes + textBytes > this.limits.maxBytes) {
        throw new BridgeError('MEMORY_LIMIT_EXCEEDED', `Total memory bytes (${totalBytes + textBytes}) exceeds limit of ${this.limits.maxBytes}`);
      }

      const sha256 = computeMemorySha256(projectId, specialist, text);
      const updatedAt = new Date().toISOString();
      const newRecord: MemoryRecord = {
        version: 1,
        projectId,
        specialist,
        text,
        sha256,
        updatedAt,
      };

      if (!existsSync(projectDir)) {
        mkdirSync(projectDir, { recursive: true, mode: 0o700 });
      }
      const dirStat = lstatSync(projectDir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        throw new BridgeError('INVALID_MEMORY_STATE', `Project memory directory is a link: ${projectDir}`);
      }

      const temporary = path.join(projectDir, `${specialist}.${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, JSON.stringify(newRecord, null, 2), { flag: 'wx', mode: 0o600, flush: true });
        replaceStateFile(temporary, targetFile);
      } finally {
        rmSync(temporary, { force: true });
      }

      return {
        projectId: newRecord.projectId,
        specialist: newRecord.specialist,
        text: newRecord.text,
        sha256: newRecord.sha256,
        updatedAt: newRecord.updatedAt,
      };
    } finally {
      releaseLock();
    }
  }

  async remove(
    projectDirectory: string,
    specialist: string,
    expectedSha256: string
  ): Promise<{ removed: true }> {
    this.verifyStorageAncestry();
    validateSpecialist(specialist);

    if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
      throw new BridgeError('INVALID_MEMORY_INPUT', 'expectedSha256 must be a 64-character hex string');
    }

    const { projectId } = this.resolveCanonicalProject(projectDirectory);
    const releaseLock = this.acquireLock();

    try {
      this.verifyStorageAncestry();
      const projectDir = path.join(this.memoryDirectory, projectId);
      verifySafeDirectory(projectDir, 'INVALID_MEMORY_STATE');
      const targetFile = path.join(projectDir, `${specialist}.json`);

      let targetStat;
      try {
        targetStat = lstatSync(targetFile);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new BridgeError('MEMORY_CHANGED', `Memory entry does not exist for specialist: ${specialist}`);
        }
        throw new BridgeError('INVALID_MEMORY_STATE', `Cannot access memory file: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
        throw new BridgeError('INVALID_MEMORY_STATE', `Target memory file is invalid: ${targetFile}`);
      }

      const currentRecord = this.readRecord(targetFile, projectId, specialist);
      if (currentRecord.sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
        throw new BridgeError('MEMORY_CHANGED', `Memory hash mismatch: expected ${expectedSha256}, current ${currentRecord.sha256}`);
      }

      rmSync(targetFile, { force: true });

      try {
        if (existsSync(projectDir) && readdirSync(projectDir).length === 0) {
          rmdirSync(projectDir);
        }
      } catch {
        // ignore directory cleanup error
      }

      return { removed: true };
    } finally {
      releaseLock();
    }
  }
}
