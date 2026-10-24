import { createHash } from 'node:crypto';
import { open, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BridgeError } from './types.js';
import { assertLineEndingsRestored, checkedPath, checkFenceMarker, managedGit, type ProjectCopy } from './isolation.js';
import { DEFAULT_PROJECT_LIMITS, type ProjectLimits } from './config.js';
import { preflightProjectFiles } from './secret-preflight.js';

const WINDOWS_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  'CONIN$', 'CONOUT$',
]);

export function validArtifactRelative(input: string): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new BridgeError('INVALID_ARTIFACT_PATH', 'Artifact path cannot be empty');
  }
  if (input.includes(':')) {
    throw new BridgeError('INVALID_ARTIFACT_PATH', 'Colon and Alternate Data Streams are forbidden: ' + input);
  }
  if (/[\x00-\x1f\x7f]/.test(input)) {
    throw new BridgeError('INVALID_ARTIFACT_PATH', 'Control characters and NUL are forbidden: ' + input);
  }
  const value = input.replaceAll('\\', '/');
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || /^(?:\\\\|\/\/|\\\\\?\\)/.test(input)) {
    throw new BridgeError('INVALID_ARTIFACT_PATH', 'Artifact path must be a relative path: ' + input);
  }
  if (value.endsWith('/')) {
    throw new BridgeError('INVALID_ARTIFACT_PATH', 'Artifact path must point to a file, not a directory: ' + input);
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new BridgeError('INVALID_ARTIFACT_PATH', 'Artifact path cannot contain traversal elements (. or ..): ' + input);
  }
  for (const part of parts) {
    if (/[. ]$/.test(part)) {
      throw new BridgeError('INVALID_ARTIFACT_PATH', 'Path segment cannot end with a dot or space: ' + input);
    }
    if (/[<>"|?*]/.test(part)) {
      throw new BridgeError('INVALID_ARTIFACT_PATH', 'Invalid path characters in segment: ' + input);
    }
    const base = part.split('.')[0]!.toUpperCase();
    if (WINDOWS_DEVICE_NAMES.has(base)) {
      throw new BridgeError('INVALID_ARTIFACT_PATH', 'Artifact path cannot contain Windows device name: ' + input);
    }
    if (part.toLowerCase() === '.git') {
      throw new BridgeError('UNSAFE_ARTIFACT_PATH', 'Artifact path cannot contain .git components: ' + input);
    }
    if (part.toLowerCase() === '.agents') {
      throw new BridgeError('UNSAFE_ARTIFACT_PATH', 'Artifact path cannot contain .agents components: ' + input);
    }
  }
  return value;
}

export const artifactPathSchema = z.string()
  .min(1)
  .max(1000)
  .refine(val => {
    try {
      validArtifactRelative(val);
      return true;
    } catch {
      return false;
    }
  }, 'Artifact path must be a valid project-relative path');

export const artifactPathsSchema = z.array(artifactPathSchema)
  .min(1)
  .max(100)
  .refine(paths => {
    try {
      const normalizedLower = paths.map(p => validArtifactRelative(p).toLowerCase());
      return new Set(normalizedLower).size === paths.length;
    } catch {
      return false;
    }
  }, 'Artifact paths must be unique (including case aliases)');

export interface ArtifactReference {
  path: string;
  sha256: string;
  bytes: number;
}

export const artifactReferenceSchema = z.object({
  path: z.string().min(1).max(1000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
}).strict();

export interface ReadArtifactResult {
  path: string;
  sha256: string;
  bytes: number;
  offset: number;
  nextOffset: number;
  hasMore: boolean;
  encoding: 'base64';
  content: string;
  offsetUnit: 'bytes';
}

function splitNull(bytes: Buffer): string[] {
  return bytes.toString('utf8').split('\0').filter(Boolean);
}

async function verifyCopyRoot(copyDirectory: string): Promise<void> {
  let rootStat;
  try {
    rootStat = await lstat(copyDirectory);
  } catch (err) {
    throw new BridgeError('UNSAFE_PROJECT_PATH', 'Cannot access copy directory: ' + (err instanceof Error ? err.message : String(err)));
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new BridgeError('UNSAFE_PROJECT_PATH', 'Copy directory cannot be a symbolic link or replaced directory');
  }
}

async function verifyExactDiskCase(rootDir: string, relativePath: string): Promise<string> {
  const segments = relativePath.split('/');
  let current = rootDir;
  for (const seg of segments) {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BridgeError('ARTIFACT_NOT_FOUND', 'Artifact file does not exist: ' + relativePath);
      }
      throw err;
    }
    if (!entries.includes(seg)) {
      const lower = seg.toLowerCase();
      const match = entries.find(e => e.toLowerCase() === lower);
      if (match) {
        throw new BridgeError('INVALID_ARTIFACT_PATH', `Path case alias mismatch: requested '${seg}', disk has '${match}'`);
      }
      throw new BridgeError('ARTIFACT_NOT_FOUND', 'Artifact file does not exist: ' + relativePath);
    }
    current = path.join(current, seg);
  }
  return current;
}

async function checkArtifactIgnoreRules(
  project: ProjectCopy,
  paths: readonly string[]
): Promise<void> {
  const stdinBuf = Buffer.from(paths.join('\0') + '\0');
  const copyScope = ['--git-dir=' + project.gitDirectory, '--work-tree=' + project.copyDirectory];
  const copyIgnoreOutput = await managedGit(
    project,
    project.copyDirectory,
    [...copyScope, 'check-ignore', '--no-index', '--stdin', '-z'],
    stdinBuf,
    [0, 1]
  );
  const sourceIgnoreOutput = await managedGit(
    project,
    project.sourceDirectory,
    ['check-ignore', '--no-index', '--stdin', '-z'],
    stdinBuf,
    [0, 1]
  );
  const ignoredSet = new Set([
    ...splitNull(copyIgnoreOutput),
    ...splitNull(sourceIgnoreOutput),
  ]);
  for (const p of paths) {
    if (ignoredSet.has(p)) {
      throw new BridgeError('IGNORED_ARTIFACT_PATH', 'Artifact path is ignored by repository rules: ' + p);
    }
  }
}

export async function collectArtifacts(
  project: ProjectCopy,
  paths: readonly string[],
  limits: ProjectLimits = DEFAULT_PROJECT_LIMITS
): Promise<ArtifactReference[]> {
  await checkFenceMarker(project);
  await assertLineEndingsRestored(project);
  await verifyCopyRoot(project.copyDirectory);

  const parsed = artifactPathsSchema.safeParse(paths);
  if (!parsed.success) {
    throw new BridgeError('INVALID_ARTIFACT_PATH', 'Invalid artifact paths: ' + parsed.error.issues.map(i => i.message).join('; '));
  }
  const normalizedPaths = paths.map(validArtifactRelative);

  if (project.providedSkills) {
    for (const skill of project.providedSkills) {
      for (const f of skill.files) {
        for (const p of normalizedPaths) {
          if (f.path.toLowerCase() === p.toLowerCase()) {
            throw new BridgeError('UNSAFE_ARTIFACT_PATH', 'Artifact path refers to a provided skill file: ' + p);
          }
        }
      }
    }
  }

  for (const relative of normalizedPaths) {
    await checkedPath(project.copyDirectory, relative, false);
  }

  await checkArtifactIgnoreRules(project, normalizedPaths);

  for (const relative of normalizedPaths) {
    try {
      await checkedPath(project.copyDirectory, relative, true);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BridgeError('ARTIFACT_NOT_FOUND', 'Artifact file does not exist: ' + relative);
      }
      throw err;
    }

    await verifyExactDiskCase(project.copyDirectory, relative);
  }

  const preflight = await preflightProjectFiles(project.copyDirectory, normalizedPaths, limits);
  if (preflight.blocked.length > 0) {
    const blocked = preflight.blocked[0]!;
    if (blocked.reason === 'UNSAFE_PATH') {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Artifact path is unsafe: ' + blocked.path);
    }
    throw new BridgeError('BLOCKED_ARTIFACT_PATH', `Artifact path blocked by secret policy (${blocked.reason}): ${blocked.path}`);
  }

  let totalBytes = 0;
  const references: ArtifactReference[] = [];

  for (const relative of normalizedPaths) {
    const record = preflight.records.get(relative);
    if (!record) {
      throw new BridgeError('ARTIFACT_NOT_FOUND', 'Artifact file does not exist: ' + relative);
    }
    totalBytes += record.size;
    if (record.size > limits.maxCopyBytes || totalBytes > limits.maxCopyBytes) {
      throw new BridgeError('COPY_LIMIT_EXCEEDED', `Total artifact bytes exceed limit of ${limits.maxCopyBytes} bytes`);
    }
    references.push({
      path: relative,
      sha256: record.sha256,
      bytes: record.size,
    });
  }

  return references;
}

export async function readArtifact(
  project: ProjectCopy,
  reference: ArtifactReference,
  expectedSha256: string,
  offset = 0,
  limit = 65536,
  maxBytes: number = DEFAULT_PROJECT_LIMITS.maxCopyBytes,
  limits?: ProjectLimits
): Promise<ReadArtifactResult> {
  const parsedRef = artifactReferenceSchema.safeParse(reference);
  if (!parsedRef.success) {
    throw new BridgeError('INVALID_ARTIFACT_REFERENCE', 'Invalid artifact reference: ' + parsedRef.error.message);
  }

  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new BridgeError('INVALID_CURSOR', 'offset must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 65536) {
    throw new BridgeError('INVALID_CURSOR', 'limit must be an integer between 1 and 65536');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new BridgeError('INVALID_CURSOR', 'maxBytes must be a positive integer');
  }
  if (offset > reference.bytes) {
    throw new BridgeError('INVALID_CURSOR', `offset ${offset} exceeds reference bytes ${reference.bytes}`);
  }

  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new BridgeError('INVALID_ARTIFACT_HASH', 'expectedSha256 must be a 64-character lowercase hex string');
  }
  if (expectedSha256 !== reference.sha256) {
    throw new BridgeError('CONTENT_CHANGED', 'expectedSha256 does not match reference sha256');
  }

  const effectiveLimits: ProjectLimits = limits ?? {
    ...DEFAULT_PROJECT_LIMITS,
    maxCopyBytes: maxBytes,
  };
  const effectiveMaxBytes = Math.min(maxBytes, effectiveLimits.maxCopyBytes);
  if (reference.bytes > effectiveMaxBytes) {
    throw new BridgeError('COPY_LIMIT_EXCEEDED', `Artifact size (${reference.bytes} bytes) exceeds limit of ${effectiveMaxBytes} bytes`);
  }

  await checkFenceMarker(project);
  await assertLineEndingsRestored(project);
  await verifyCopyRoot(project.copyDirectory);

  const relative = validArtifactRelative(reference.path);

  if (project.providedSkills) {
    for (const skill of project.providedSkills) {
      for (const f of skill.files) {
        if (f.path.toLowerCase() === relative.toLowerCase()) {
          throw new BridgeError('UNSAFE_ARTIFACT_PATH', 'Artifact path refers to a provided skill file: ' + relative);
        }
      }
    }
  }

  await checkedPath(project.copyDirectory, relative, false);
  await checkArtifactIgnoreRules(project, [relative]);

  let filePath: string;
  try {
    filePath = await checkedPath(project.copyDirectory, relative, true);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BridgeError('ARTIFACT_NOT_FOUND', 'Artifact file does not exist: ' + relative);
    }
    throw err;
  }

  await verifyExactDiskCase(project.copyDirectory, relative);

  const scanLimits: ProjectLimits = {
    ...effectiveLimits,
    maxCopyBytes: effectiveMaxBytes,
  };
  const preflight = await preflightProjectFiles(project.copyDirectory, [relative], scanLimits);
  if (preflight.blocked.length > 0) {
    const blocked = preflight.blocked[0]!;
    if (blocked.reason === 'UNSAFE_PATH') {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Artifact path is unsafe: ' + blocked.path);
    }
    throw new BridgeError('BLOCKED_ARTIFACT_PATH', `Artifact path blocked by secret policy (${blocked.reason}): ${blocked.path}`);
  }

  const preflightRecord = preflight.records.get(relative);
  if (!preflightRecord) {
    throw new BridgeError('ARTIFACT_NOT_FOUND', 'Artifact file does not exist: ' + relative);
  }

  const handle = await open(filePath, 'r');
  try {
    await verifyCopyRoot(project.copyDirectory);
    const recheckedPath = await checkedPath(project.copyDirectory, relative, true);
    await verifyExactDiskCase(project.copyDirectory, relative);

    const fstat = await handle.stat();
    const currentLstat = await lstat(recheckedPath);
    if (!fstat.isFile() || currentLstat.isSymbolicLink() || !currentLstat.isFile()) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Artifact must be a regular non-link file: ' + relative);
    }
    if (
      currentLstat.ino !== fstat.ino ||
      currentLstat.dev !== fstat.dev ||
      currentLstat.size !== fstat.size
    ) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Artifact detected file replacement: ' + relative);
    }

    if (fstat.size !== preflightRecord.size) {
      throw new BridgeError('CONTENT_CHANGED', `Artifact size on disk (${fstat.size}) does not match preflight record (${preflightRecord.size})`);
    }
    if (fstat.size !== reference.bytes) {
      throw new BridgeError('CONTENT_CHANGED', `Artifact size on disk (${fstat.size}) does not match reference bytes (${reference.bytes})`);
    }
    if (fstat.mtimeMs !== preflightRecord.mtimeMs) {
      throw new BridgeError('CONTENT_CHANGED', 'Artifact modification time changed after preflight: ' + relative);
    }
    if (fstat.ino !== preflightRecord.ino || fstat.dev !== preflightRecord.dev) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Artifact file identity changed after preflight: ' + relative);
    }

    if (fstat.size > effectiveMaxBytes) {
      throw new BridgeError('COPY_LIMIT_EXCEEDED', `Artifact size (${fstat.size} bytes) exceeds limit of ${effectiveMaxBytes} bytes`);
    }

    const windowStart = offset;
    const windowEnd = Math.min(reference.bytes, offset + limit);
    const windowLen = Math.max(0, windowEnd - windowStart);
    const windowBuf = Buffer.alloc(windowLen);

    const CHUNK_SIZE = 64 * 1024;
    const readBuf = Buffer.allocUnsafe(CHUNK_SIZE);
    const hash = createHash('sha256');
    let streamBytes = 0;

    for (;;) {
      const { bytesRead } = await handle.read(readBuf, 0, CHUNK_SIZE, null);
      if (bytesRead === 0) break;

      const chunkStart = streamBytes;
      const chunkEnd = streamBytes + bytesRead;
      streamBytes = chunkEnd;

      if (streamBytes > effectiveMaxBytes) {
        throw new BridgeError('COPY_LIMIT_EXCEEDED', `Artifact exceeded maximum byte limit (${effectiveMaxBytes}) during reading`);
      }
      if (streamBytes > reference.bytes) {
        throw new BridgeError('CONTENT_CHANGED', 'Artifact grew beyond reference bytes during reading');
      }

      const slice = readBuf.subarray(0, bytesRead);
      hash.update(slice);

      const overlapStart = Math.max(chunkStart, windowStart);
      const overlapEnd = Math.min(chunkEnd, windowEnd);
      if (overlapStart < overlapEnd) {
        slice.copy(windowBuf, overlapStart - windowStart, overlapStart - chunkStart, overlapEnd - chunkStart);
      }
    }

    if (streamBytes !== reference.bytes) {
      throw new BridgeError('CONTENT_CHANGED', `Artifact size changed during reading (expected ${reference.bytes}, observed ${streamBytes})`);
    }

    const finalFstat = await handle.stat();
    if (finalFstat.size !== reference.bytes || finalFstat.mtimeMs !== preflightRecord.mtimeMs) {
      throw new BridgeError('CONTENT_CHANGED', 'Artifact mutated during reading: ' + relative);
    }
    if (finalFstat.ino !== preflightRecord.ino || finalFstat.dev !== preflightRecord.dev) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Artifact descriptor identity changed: ' + relative);
    }

    await verifyCopyRoot(project.copyDirectory);
    const finalCheckedPath = await checkedPath(project.copyDirectory, relative, true);
    const finalLstat = await lstat(finalCheckedPath);
    if (!finalLstat.isFile() || finalLstat.isSymbolicLink()) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Artifact must be a regular non-link file: ' + relative);
    }
    if (
      finalLstat.ino !== finalFstat.ino ||
      finalLstat.dev !== finalFstat.dev ||
      finalLstat.size !== finalFstat.size
    ) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Artifact path replaced during read: ' + relative);
    }

    const actualSha256 = hash.digest('hex');
    if (actualSha256 !== preflightRecord.sha256) {
      throw new BridgeError('CONTENT_CHANGED', 'Artifact content on disk does not match preflight sha256');
    }
    if (actualSha256 !== reference.sha256 || actualSha256 !== expectedSha256) {
      throw new BridgeError('CONTENT_CHANGED', 'Artifact content on disk has changed; sha256 mismatch');
    }

    const content = windowBuf.toString('base64');
    const nextOffset = windowEnd;
    const hasMore = windowEnd < reference.bytes;

    return {
      path: reference.path,
      sha256: actualSha256,
      bytes: reference.bytes,
      offset,
      nextOffset,
      hasMore,
      encoding: 'base64',
      content,
      offsetUnit: 'bytes',
    };
  } finally {
    await handle.close().catch(() => {});
  }
}
