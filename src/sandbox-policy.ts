import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_PROJECT_LIMITS, type ProjectLimits } from './config.js';
import { BridgeError } from './types.js';

const paths = z.array(z.string().min(1).max(1000)).max(20);
const persistedPolicySchema = z.object({
  readRoots: paths,
  writeRoots: paths,
  network: z.boolean(),
  childProcesses: z.boolean(),
  maxOutputChars: z.number().int().min(256).max(64000),
}).strict();

export const sandboxPolicySchema = z.object({
  readRoots: paths.default([]),
  writeRoots: paths.default([]),
  network: z.boolean().default(false),
  childProcesses: z.boolean().default(true),
  maxOutputChars: z.number().int().min(256).max(64000).default(4000),
}).strict();
export const sandboxSelectionInputSchema = z.object({
  readPaths: paths.optional(),
  writePaths: paths.optional(),
  network: z.boolean().optional(),
  childProcesses: z.boolean().optional(),
  maxOutputChars: z.number().int().min(256).max(64000).optional(),
}).strict();
export const sandboxSelectionSchema = z.object({
  readPaths: paths.default([]),
  writePaths: paths.default([]),
  network: z.boolean().default(false),
  childProcesses: z.boolean().default(true),
  maxOutputChars: z.number().int().min(256).max(64000).default(4000),
}).strict();
export type SandboxPolicy = z.infer<typeof sandboxPolicySchema>;
export type SandboxSelectionInput = z.infer<typeof sandboxSelectionInputSchema>;
export type SandboxSelection = z.infer<typeof sandboxSelectionSchema>;

export interface SandboxPolicySnapshot {
  version: 1;
  policy: SandboxPolicy;
  sha256: string;
}

export interface SandboxPathValidationLimits extends Pick<ProjectLimits, 'maxCopyFiles' | 'maxCopyBytes'> {}

const ownedTemporaryDirectory = /^agy-mcp-(?:copy|baseline|runtime|controller|scratch)-/i;
const windowsDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
}

function comparePaths(left: string, right: string): number {
  const normalizedLeft = pathKey(left), normalizedRight = pathKey(right);
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function contains(root: string, target: string): boolean {
  const relative = path.relative(pathKey(root), pathKey(target));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function overlaps(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left);
}

function uniquePaths(values: string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values) if (!unique.has(pathKey(value))) unique.set(pathKey(value), value);
  return [...unique.values()].sort(comparePaths);
}

function minimalRoots(values: string[]): string[] {
  const candidates = uniquePaths(values).sort((left, right) => left.length - right.length || comparePaths(left, right));
  return candidates.filter(candidate => !candidates.some(root => root !== candidate && contains(root, candidate))).sort(comparePaths);
}

function canonicalPolicyShape(value: SandboxPolicy): SandboxPolicy {
  const readRoots = minimalRoots([...value.readRoots, ...value.writeRoots]);
  if (readRoots.length > 20) {
    throw new BridgeError('INVALID_SANDBOX_POLICY', 'Write roots require corresponding read roots within the policy path limit');
  }
  return {
    readRoots,
    writeRoots: minimalRoots(value.writeRoots),
    network: value.network,
    childProcesses: value.childProcesses,
    maxOutputChars: value.maxOutputChars,
  };
}

function requireNormalizedPolicy(value: unknown): SandboxPolicy {
  const policy = persistedPolicySchema.parse(value);
  const normalized = canonicalPolicyShape(policy);
  if (JSON.stringify(policy) !== JSON.stringify(normalized)) {
    throw new BridgeError('INVALID_SANDBOX_POLICY', 'Sandbox policies must be normalized before they are persisted or hashed');
  }
  return policy;
}

export function sandboxPolicyDigest(policy: SandboxPolicy): string {
  const normalized = requireNormalizedPolicy(policy);
  return createHash('sha256').update(JSON.stringify({ version: 1, policy: normalized })).digest('hex');
}

export function parseSandboxPolicySnapshot(value: unknown): SandboxPolicySnapshot {
  const snapshot = z.object({
    version: z.literal(1),
    policy: persistedPolicySchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().parse(value);
  const policy = requireNormalizedPolicy(snapshot.policy);
  if (snapshot.sha256 !== sandboxPolicyDigest(policy)) {
    throw new BridgeError('INVALID_SANDBOX_POLICY', 'Sandbox policy digest does not match its normalized policy');
  }
  return { version: 1, policy, sha256: snapshot.sha256 };
}

function localAbsolutePath(value: string): string {
  if (value.includes('\0')) throw new BridgeError('INVALID_SANDBOX_PATH', 'Sandbox permissions cannot contain NUL characters');
  if (process.platform === 'win32') {
    if (/^(?:\\\\|\/\/)/.test(value) || !/^[A-Za-z]:[\\/]/.test(value) || value.slice(2).includes(':')) {
      throw new BridgeError('INVALID_SANDBOX_PATH', 'Sandbox permissions require local absolute paths without alternate streams');
    }
    for (const part of value.slice(2).split(/[\\/]+/).filter(Boolean)) {
      const normalized = part.trimEnd().replace(/\.+$/, '');
      if (!normalized || normalized === '.' || normalized === '..' || windowsDevice.test(normalized)) {
        throw new BridgeError('INVALID_SANDBOX_PATH', 'Sandbox permissions cannot name a Windows device or relative path');
      }
    }
  } else if (!path.isAbsolute(value) || value.startsWith('//')) {
    throw new BridgeError('INVALID_SANDBOX_PATH', 'Sandbox permissions require local absolute paths');
  }
  return path.resolve(value);
}

async function inspectExistingPath(absolute: string): Promise<{ canonical: string; directory: boolean }> {
  const root = path.parse(absolute).root;
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BridgeError('INVALID_SANDBOX_PATH', 'Sandbox permission targets must already exist');
      }
      throw new BridgeError('INVALID_SANDBOX_PATH', 'Could not inspect a sandbox permission target');
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory()) ||
        (index === parts.length - 1 && !info.isDirectory() && !info.isFile()) ||
        (info.isFile() && info.nlink > 1)) {
      throw new BridgeError('INVALID_SANDBOX_PATH', 'Sandbox permission targets cannot contain links, hard links, or non-regular files');
    }
  }
  let canonical: string;
  try { canonical = await realpath(absolute); }
  catch { throw new BridgeError('INVALID_SANDBOX_PATH', 'Could not canonicalize a sandbox permission target'); }
  const final = await lstat(canonical).catch(() => undefined);
  if (!final || final.isSymbolicLink() || (!final.isDirectory() && !final.isFile()) || (final.isFile() && final.nlink > 1)) {
    throw new BridgeError('INVALID_SANDBOX_PATH', 'Sandbox permission targets must resolve to regular files or directories');
  }
  return { canonical, directory: final.isDirectory() };
}

async function inspectDirectoryGrant(directory: string, limits: SandboxPathValidationLimits): Promise<void> {
  let entries = 0, bytes = 0;
  const visit = async (current: string): Promise<void> => {
    let children;
    try { children = await readdir(current); }
    catch { throw new BridgeError('INVALID_SANDBOX_PATH', 'Could not inspect a sandbox directory grant'); }
    for (const name of children) {
      const child = path.join(current, name);
      let info;
      try { info = await lstat(child); }
      catch { throw new BridgeError('INVALID_SANDBOX_PATH', 'Sandbox directory grants cannot change during validation'); }
      entries++;
      if (entries > limits.maxCopyFiles) throw new BridgeError('SANDBOX_PATH_TOO_LARGE', 'Sandbox directory grant exceeds the existing copy file limit');
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink > 1)) {
        throw new BridgeError('INVALID_SANDBOX_PATH', 'Sandbox directory grants cannot contain links, hard links, or non-regular files');
      }
      if (info.isDirectory()) await visit(child);
      else {
        bytes += info.size;
        if (bytes > limits.maxCopyBytes) throw new BridgeError('SANDBOX_PATH_TOO_LARGE', 'Sandbox directory grant exceeds the existing copy byte limit');
      }
    }
  };
  await visit(directory);
}

/** Validates the reusable filesystem safety boundary; callers still apply their own authorization roots. */
async function inspectSandboxGrant(value: string): Promise<{ canonical: string; directory: boolean }> {
  const first = await inspectExistingPath(localAbsolutePath(value));
  return inspectExistingPath(first.canonical);
}

export async function validateSandboxGrant(value: string, limits: SandboxPathValidationLimits = DEFAULT_PROJECT_LIMITS): Promise<string> {
  if (!Number.isSafeInteger(limits.maxCopyFiles) || limits.maxCopyFiles < 1 || !Number.isSafeInteger(limits.maxCopyBytes) || limits.maxCopyBytes < 1) {
    throw new BridgeError('INVALID_SANDBOX_PATH', 'Sandbox validation limits must be positive integers');
  }
  const canonical = await inspectSandboxGrant(value);
  if (canonical.directory) await inspectDirectoryGrant(canonical.canonical, limits);
  return canonical.canonical;
}

async function canonicalProtectedPath(value: string): Promise<string> {
  const absolute = localAbsolutePath(value);
  const root = path.parse(absolute).root;
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let current = root, firstMissing = parts.length;
  for (let index = 0; index < parts.length; index++) {
    const next = path.join(current, parts[index]!);
    let info;
    try { info = await lstat(next); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { firstMissing = index; break; }
      throw new BridgeError('INVALID_SANDBOX_PATH', 'Could not inspect a protected sandbox path');
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory()) ||
        (index === parts.length - 1 && !info.isDirectory() && !info.isFile())) {
      throw new BridgeError('INVALID_SANDBOX_PATH', 'Protected sandbox paths cannot contain links or non-regular files');
    }
    current = next;
  }
  let canonical: string;
  try { canonical = await realpath(current); }
  catch { throw new BridgeError('INVALID_SANDBOX_PATH', 'Could not canonicalize a protected sandbox path'); }
  return path.join(canonical, ...parts.slice(firstMissing));
}

async function protectedPaths(stateDirectory: string, forbidden: string[]): Promise<string[]> {
  return Promise.all([
    stateDirectory,
    ...['.codex', '.gemini', '.ssh', '.aws', '.azure'].map(name => path.join(os.homedir(), name)),
    ...forbidden,
  ].map(canonicalProtectedPath));
}

async function canonicalPaths(values: string[], protectedRoots: string[], limits: SandboxPathValidationLimits): Promise<string[]> {
  const temporary = await canonicalProtectedPath(os.tmpdir());
  const canonical = await Promise.all(values.map(async value => {
    const target = await inspectSandboxGrant(value);
    if (protectedRoots.some(root => overlaps(root, target.canonical)) || contains(target.canonical, temporary) ||
        target.canonical.split(path.sep).some(part => ownedTemporaryDirectory.test(part))) {
      throw new BridgeError('SANDBOX_PATH_PROTECTED', 'Sandbox permission target overlaps protected bridge storage, credentials, source, or temporary paths');
    }
    if (target.directory) await inspectDirectoryGrant(target.canonical, limits);
    return target.canonical;
  }));
  return minimalRoots(canonical);
}

export async function normalizeSandboxPolicy(value: unknown, stateDirectory: string, forbidden: string[],
  limits: SandboxPathValidationLimits = DEFAULT_PROJECT_LIMITS): Promise<SandboxPolicy> {
  const policy = sandboxPolicySchema.parse(value);
  const protectedRoots = await protectedPaths(stateDirectory, forbidden);
  const writeRoots = await canonicalPaths(policy.writeRoots, protectedRoots, limits);
  const readRoots = await canonicalPaths([...policy.readRoots, ...writeRoots], protectedRoots, limits);
  return canonicalPolicyShape({ ...policy, readRoots, writeRoots });
}

export async function resolveSandboxSelection(policy: SandboxPolicy, value: unknown | undefined,
  sourceDirectory: string, stateDirectory: string, forbidden: string[],
  limits: SandboxPathValidationLimits = DEFAULT_PROJECT_LIMITS): Promise<SandboxSelection> {
  const ceiling = requireNormalizedPolicy(policy);
  const selected = sandboxSelectionInputSchema.parse(value ?? {});
  const protectedRoots = [...await protectedPaths(stateDirectory, forbidden), await canonicalProtectedPath(sourceDirectory)];
  const writePaths = await canonicalPaths(selected.writePaths ?? [], protectedRoots, limits);
  const readPaths = await canonicalPaths([...(selected.readPaths ?? []), ...writePaths], protectedRoots, limits);
  if (readPaths.length > 20) {
    throw new BridgeError('SANDBOX_PERMISSION_DENIED', 'Write paths require corresponding read paths within the selection path limit');
  }
  const network = selected.network ?? false;
  const childProcesses = selected.childProcesses ?? ceiling.childProcesses;
  const maxOutputChars = selected.maxOutputChars ?? Math.min(4000, ceiling.maxOutputChars);
  if ((network && !ceiling.network) || (childProcesses && !ceiling.childProcesses) || maxOutputChars > ceiling.maxOutputChars ||
      readPaths.some(target => !ceiling.readRoots.some(root => contains(root, target))) ||
      writePaths.some(target => !ceiling.writeRoots.some(root => contains(root, target)))) {
    throw new BridgeError('SANDBOX_PERMISSION_DENIED', 'Requested permissions exceed the globally authorized sandbox policy');
  }
  return { readPaths, writePaths, network, childProcesses, maxOutputChars };
}
