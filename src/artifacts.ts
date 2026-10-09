import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { BridgeError } from './types.js';
import { checkedPath, type ProjectCopy } from './isolation.js';
import { DEFAULT_PROJECT_LIMITS, type ProjectLimits } from './config.js';

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

async function git(cwd: string, args: string[], input?: Buffer, allowedCodes = [0]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let length = 0;
    let stderr = '';
    let overflow = false;
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > 10_000_000) {
        overflow = true;
        child.kill();
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.once('error', reject);
    child.once('close', code => {
      if (overflow) reject(new BridgeError('ISOLATION_TOO_LARGE', 'Git output exceeds the isolation limit'));
      else if (!allowedCodes.includes(code ?? -1)) reject(new BridgeError('GIT_OPERATION_FAILED', stderr.trim() || 'git exited with code ' + code));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
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

export async function collectArtifacts(
  project: ProjectCopy,
  paths: readonly string[],
  limits: ProjectLimits = DEFAULT_PROJECT_LIMITS
): Promise<ArtifactReference[]> {
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

  // Preserve git ignore rules: check all paths on the original repository root (including .gitignore and .git/info/exclude)
  const stdinBuf = Buffer.from(normalizedPaths.join('\0') + '\0');
  const ignoreOutput = await git(
    project.sourceDirectory,
    ['check-ignore', '--no-index', '--stdin', '-z'],
    stdinBuf,
    [0, 1]
  );
  const ignoredSet = new Set(splitNull(ignoreOutput));
  for (const p of normalizedPaths) {
    if (ignoredSet.has(p)) {
      throw new BridgeError('IGNORED_ARTIFACT_PATH', 'Artifact path is ignored by repository rules: ' + p);
    }
  }

  let totalBytes = 0;
  const references: ArtifactReference[] = [];

  for (const relative of normalizedPaths) {
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

    const st = await lstat(filePath);
    if (!st.isFile() || st.isSymbolicLink()) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Artifact must be a regular non-link file: ' + relative);
    }

    if (st.size > limits.maxCopyBytes) {
      throw new BridgeError('COPY_LIMIT_EXCEEDED', `Artifact size exceeds copy limit of ${limits.maxCopyBytes} bytes`);
    }

    const hasher = createHash('sha256');
    let fileBytes = 0;
    for await (const chunk of createReadStream(filePath)) {
      fileBytes += chunk.length;
      totalBytes += chunk.length;
      if (totalBytes > limits.maxCopyBytes) {
        throw new BridgeError('COPY_LIMIT_EXCEEDED', `Total artifact bytes exceed limit of ${limits.maxCopyBytes} bytes`);
      }
      hasher.update(chunk);
    }

    const sha256 = hasher.digest('hex');
    references.push({
      path: relative,
      sha256,
      bytes: fileBytes,
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
  maxBytes: number = DEFAULT_PROJECT_LIMITS.maxCopyBytes
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

  await verifyCopyRoot(project.copyDirectory);

  const relative = validArtifactRelative(reference.path);
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

  const st = await lstat(filePath);
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new BridgeError('UNSAFE_PROJECT_PATH', 'Artifact must be a regular non-link file: ' + relative);
  }

  if (st.size > maxBytes) {
    throw new BridgeError('COPY_LIMIT_EXCEEDED', `Artifact size (${st.size} bytes) exceeds limit of ${maxBytes} bytes`);
  }
  if (st.size !== reference.bytes) {
    throw new BridgeError('CONTENT_CHANGED', `Artifact size on disk (${st.size}) does not match reference bytes (${reference.bytes})`);
  }

  // Streaming hash and retention of only requested window <= 65536
  const windowStart = offset;
  const windowEnd = Math.min(reference.bytes, offset + limit);
  const windowLen = Math.max(0, windowEnd - windowStart);
  const windowBuf = Buffer.alloc(windowLen);
  let streamBytes = 0;
  const hasher = createHash('sha256');

  const stream = createReadStream(filePath);
  try {
    for await (const chunk of stream) {
      const chunkBuf = chunk as Buffer;
      const chunkStart = streamBytes;
      const chunkEnd = streamBytes + chunkBuf.length;
      streamBytes = chunkEnd;

      if (streamBytes > maxBytes) {
        throw new BridgeError('COPY_LIMIT_EXCEEDED', `Artifact exceeded maximum byte limit (${maxBytes}) during reading`);
      }
      if (streamBytes > reference.bytes) {
        throw new BridgeError('CONTENT_CHANGED', 'Artifact grew beyond reference bytes during reading');
      }

      hasher.update(chunkBuf);

      const overlapStart = Math.max(chunkStart, windowStart);
      const overlapEnd = Math.min(chunkEnd, windowEnd);
      if (overlapStart < overlapEnd) {
        const slice = chunkBuf.subarray(overlapStart - chunkStart, overlapEnd - chunkStart);
        slice.copy(windowBuf, overlapStart - windowStart);
      }
    }
  } finally {
    stream.destroy();
  }

  if (streamBytes !== reference.bytes) {
    throw new BridgeError('CONTENT_CHANGED', `Artifact size changed during reading (expected ${reference.bytes}, observed ${streamBytes})`);
  }

  const actualSha256 = hasher.digest('hex');
  if (actualSha256 !== expectedSha256) {
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
}
