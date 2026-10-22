import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isWindowsDeviceName } from './skills.js';
import { BridgeError } from './types.js';

export const CRAFT_LIMITS = {
  maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 2000,
  maxFileBytes: 16 * 1024 * 1024,
} as const;

export interface CraftManifestFile {
  path: string;
  bytes: number;
  sha256: string;
  mediaType: string;
}

export interface CraftManifest {
  schemaVersion: 1;
  origin: string;
  revision: string;
  version: string;
  skills: string[];
  files: CraftManifestFile[];
}

export interface VerifiedCraftSnapshot {
  root: string;
  manifest: CraftManifest;
  manifestSha256: string;
  totalBytes: number;
}

export function craftMediaType(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');
  const lastSlash = normalized.lastIndexOf('/');
  const filename = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const dotIndex = filename.lastIndexOf('.');
  const ext = dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : '';
  switch (ext) {
    case '.md':
      return 'text/markdown';
    case '.yaml':
    case '.yml':
      return 'text/yaml';
    case '.json':
      return 'application/json';
    case '.jsonl':
      return 'application/x-ndjson';
    case '.txt':
      return 'text/plain';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

const craftManifestFileSchema = z.object({
  path: z.string().min(1).max(512),
  bytes: z.number().int().min(0).max(CRAFT_LIMITS.maxFileBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().min(1).max(128),
}).strict();

const rawManifestSchema = z.object({
  schemaVersion: z.literal(1),
  origin: z.string().startsWith('https://github.com/'),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  version: z.string().min(1).max(64),
  skills: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).min(1).max(16),
  files: z.array(craftManifestFileSchema).min(1).max(CRAFT_LIMITS.maxFiles),
}).strict();

export const craftManifestSchema: z.ZodType<CraftManifest> = rawManifestSchema.superRefine((manifest, ctx) => {
  const skillSet = new Set<string>();
  for (const skill of manifest.skills) {
    if (skillSet.has(skill)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate skill name: ${skill}`,
        path: ['skills'],
      });
    }
    if (isWindowsDeviceName(skill)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Skill name cannot be a Windows device name: ${skill}`,
        path: ['skills'],
      });
    }
    skillSet.add(skill);
  }

  let totalBytes = 0;
  const seenLowerPaths = new Set<string>();
  const exactPaths = new Set<string>();

  for (let i = 0; i < manifest.files.length; i++) {
    const file = manifest.files[i]!;
    totalBytes += file.bytes;

    const lower = file.path.toLowerCase();
    if (seenLowerPaths.has(lower)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate file path: ${file.path}`,
        path: ['files', i, 'path'],
      });
    }
    seenLowerPaths.add(lower);
    exactPaths.add(file.path);

    const p = file.path;

    if (p.includes('\\')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Path must not contain backslashes: ${p}`,
        path: ['files', i, 'path'],
      });
      continue;
    }

    if (p.includes(':')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Path must not contain colons: ${p}`,
        path: ['files', i, 'path'],
      });
      continue;
    }

    if (p.startsWith('/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Path must not start with slash: ${p}`,
        path: ['files', i, 'path'],
      });
      continue;
    }

    if (/[\x00-\x1f\x7f]/.test(p)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Path must not contain control characters: ${p}`,
        path: ['files', i, 'path'],
      });
      continue;
    }

    const segments = p.split('/');
    let hasInvalidSegment = false;
    for (const seg of segments) {
      if (seg.length === 0 || seg === '.' || seg === '..') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Path contains empty, dot, or dot-dot segment: ${p}`,
          path: ['files', i, 'path'],
        });
        hasInvalidSegment = true;
        break;
      }
      if (isWindowsDeviceName(seg)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Path segment is a Windows device name: ${p}`,
          path: ['files', i, 'path'],
        });
        hasInvalidSegment = true;
        break;
      }
    }
    if (hasInvalidSegment) continue;

    if (segments[0] !== 'skills' || segments.length < 3 || !skillSet.has(segments[1]!)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Path must start with 'skills/<skill>/' where <skill> is declared in skills: ${p}`,
        path: ['files', i, 'path'],
      });
      continue;
    }

    const expectedMediaType = craftMediaType(p);
    if (file.mediaType !== expectedMediaType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `mediaType mismatch for ${p}: expected ${expectedMediaType}, got ${file.mediaType}`,
        path: ['files', i, 'mediaType'],
      });
    }
  }

  if (totalBytes > CRAFT_LIMITS.maxTotalBytes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Total bytes (${totalBytes}) exceeds maximum of ${CRAFT_LIMITS.maxTotalBytes}`,
      path: ['files'],
    });
  }

  for (const skill of manifest.skills) {
    const requiredPath = `skills/${skill}/SKILL.md`;
    if (!exactPaths.has(requiredPath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Missing required file ${requiredPath}`,
        path: ['files'],
      });
    }
  }
});

async function computeStreamSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function verifyCraftSnapshot(root: string): Promise<VerifiedCraftSnapshot> {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new BridgeError('CRAFT_SNAPSHOT_INVALID', 'root: path must be a non-empty string');
  }

  const manifestRel = 'manifest.json';
  const manifestPath = path.join(root, manifestRel);

  let manifestStat;
  try {
    manifestStat = await lstat(manifestPath);
  } catch {
    throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${manifestRel}: missing or inaccessible`);
  }

  if (manifestStat.isSymbolicLink()) {
    throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${manifestRel}: symbolic links and junctions forbidden`);
  }
  if (!manifestStat.isFile()) {
    throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${manifestRel}: not a regular file`);
  }
  if (manifestStat.size > 1024 * 1024) {
    throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${manifestRel}: exceeds 1 MiB limit`);
  }

  let manifestBuffer: Buffer;
  try {
    manifestBuffer = await readFile(manifestPath);
  } catch {
    throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${manifestRel}: failed to read file`);
  }

  if (manifestBuffer.length > 1024 * 1024) {
    throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${manifestRel}: exceeds 1 MiB limit`);
  }

  const manifestSha256 = createHash('sha256').update(manifestBuffer).digest('hex');

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(manifestBuffer.toString('utf8'));
  } catch {
    throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${manifestRel}: invalid JSON`);
  }

  const parsed = craftManifestSchema.safeParse(rawJson);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const msg = issue?.message ?? 'invalid manifest schema';
    throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${manifestRel}: ${msg}`);
  }
  const manifest = parsed.data;

  const skillsRel = 'skills';
  const skillsRoot = path.join(root, skillsRel);

  let skillsStat;
  try {
    skillsStat = await lstat(skillsRoot);
  } catch {
    throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${skillsRel}: missing or inaccessible`);
  }

  if (skillsStat.isSymbolicLink()) {
    throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${skillsRel}: symbolic links and junctions forbidden`);
  }
  if (!skillsStat.isDirectory()) {
    throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${skillsRel}: not a directory`);
  }

  const manifestFileMap = new Map<string, CraftManifestFile>();
  for (const file of manifest.files) {
    manifestFileMap.set(file.path, file);
  }

  const visitedFiles = new Set<string>();
  const stack: Array<{ fullDir: string; relDir: string }> = [
    { fullDir: skillsRoot, relDir: skillsRel },
  ];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current.fullDir, { withFileTypes: true });
    } catch {
      throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${current.relDir}: failed to read directory`);
    }

    entries.sort((a, b) => b.name.localeCompare(a.name));

    for (const entry of entries) {
      const relPath = `${current.relDir}/${entry.name}`;
      const fullPath = path.join(current.fullDir, entry.name);

      let st;
      try {
        st = await lstat(fullPath);
      } catch {
        throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${relPath}: missing or inaccessible`);
      }

      if (st.isSymbolicLink()) {
        throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${relPath}: symbolic links and junctions forbidden`);
      }

      if (st.isDirectory()) {
        stack.push({ fullDir: fullPath, relDir: relPath });
      } else if (st.isFile()) {
        const expected = manifestFileMap.get(relPath);
        if (!expected) {
          throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${relPath}: unexpected file not in manifest`);
        }
        if (st.size !== expected.bytes) {
          throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${relPath}: size mismatch (expected ${expected.bytes}, got ${st.size})`);
        }
        let actualSha: string;
        try {
          actualSha = await computeStreamSha256(fullPath);
        } catch {
          throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${relPath}: failed to read file`);
        }
        if (actualSha !== expected.sha256) {
          throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${relPath}: sha256 mismatch (expected ${expected.sha256}, got ${actualSha})`);
        }
        visitedFiles.add(relPath);
      } else {
        throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${relPath}: entry is neither a regular file nor a directory`);
      }
    }
  }

  for (const file of manifest.files) {
    if (!visitedFiles.has(file.path)) {
      throw new BridgeError('CRAFT_SNAPSHOT_INVALID', `${file.path}: file missing from snapshot`);
    }
  }

  let totalBytes = 0;
  for (const file of manifest.files) {
    totalBytes += file.bytes;
  }

  return {
    root,
    manifest,
    manifestSha256,
    totalBytes,
  };
}
