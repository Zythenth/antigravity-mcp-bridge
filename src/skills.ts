import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BridgeError } from './types.js';
import { DEFAULT_PROJECT_LIMITS, type ProjectLimits } from './config.js';
import { checkedPath } from './isolation.js';

export const MAX_PROVIDED_SKILLS = 8;
export const MAX_RESOURCES_PER_SKILL = 100;
export const MAX_TOTAL_BUNDLES_BYTES = 1024 * 1024; // 1 MiB
export const MAX_SKILL_NAME_LENGTH = 64;

export const providedSkillResourceSchema = z.object({
  path: z.string().min(1).max(1024),
  content: z.string(),
}).strict();

export const providedSkillSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/).max(MAX_SKILL_NAME_LENGTH),
  content: z.string().min(1),
  resources: z.array(providedSkillResourceSchema).max(MAX_RESOURCES_PER_SKILL).optional(),
}).strict();

export const providedSkillsSchema = z.array(providedSkillSchema).max(MAX_PROVIDED_SKILLS);

export interface ProvidedSkillResource {
  readonly path: string;
  readonly content: string;
}

export interface ProvidedSkill {
  readonly name: string;
  readonly content: string;
  readonly resources?: readonly ProvidedSkillResource[];
}

export interface StagedSkillFile {
  readonly path: string;
  readonly sha256: string;
}

export interface StagedSkill {
  readonly name: string;
  readonly sha256: string;
  readonly files: readonly StagedSkillFile[];
}

export const stagedSkillSchema = z.object({
  name: providedSkillSchema.shape.name,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.object({ path: z.string().min(1).max(1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(MAX_RESOURCES_PER_SKILL + 1),
}).strict();
export const stagedSkillsSchema = z.array(stagedSkillSchema).max(MAX_PROVIDED_SKILLS);

const WINDOWS_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  'CONIN$', 'CONOUT$',
]);

export function isWindowsDeviceName(segment: string): boolean {
  const base = segment.split('.')[0]!.toUpperCase();
  return WINDOWS_DEVICE_NAMES.has(base);
}

export function isValidCanonicalSlug(slug: string): boolean {
  if (typeof slug !== 'string' || slug.length === 0 || slug.length > MAX_SKILL_NAME_LENGTH) {
    return false;
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return false;
  }
  if (isWindowsDeviceName(slug)) {
    return false;
  }
  return true;
}

function isValidSkillName(name: string): boolean {
  return typeof name === 'string' && isValidCanonicalSlug(name.toLowerCase());
}

export function parseAndValidateFrontmatterName(content: string, expectedName: string): string {
  const text = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const lines = text.split(/\r?\n/);
  const firstLine = lines[0]?.trimEnd();
  if (firstLine !== '---') {
    throw new BridgeError('INVALID_SKILL_FRONTMATTER', `Skill ${expectedName}: SKILL.md must start with YAML frontmatter delimiter (---)`);
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trimEnd() === '---') {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    throw new BridgeError('INVALID_SKILL_FRONTMATTER', `Skill ${expectedName}: SKILL.md missing closing frontmatter delimiter (---)`);
  }

  const fmLines = lines.slice(1, closingIndex);
  const nameMatches: { lineIndex: number; rawValue: string }[] = [];

  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i]!;
    if (/^\s/.test(line)) continue;
    const match = line.match(/^name\s*:\s*(.*)$/);
    if (match) {
      nameMatches.push({ lineIndex: i, rawValue: match[1]! });
    }
  }

  if (nameMatches.length === 0) {
    throw new BridgeError('INVALID_SKILL_FRONTMATTER', `Skill ${expectedName}: SKILL.md frontmatter missing required 'name' field`);
  }

  if (nameMatches.length > 1) {
    throw new BridgeError('INVALID_SKILL_FRONTMATTER', `Skill ${expectedName}: SKILL.md frontmatter has ambiguous duplicate 'name' fields`);
  }

  const raw = nameMatches[0]!.rawValue.trim();
  if (raw === '') {
    throw new BridgeError('INVALID_SKILL_FRONTMATTER', `Skill ${expectedName}: SKILL.md frontmatter 'name' cannot be empty`);
  }

  let parsedName: string;
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) {
      throw new BridgeError('INVALID_SKILL_FRONTMATTER', `Skill ${expectedName}: SKILL.md frontmatter 'name' has malformed single quotes`);
    }
    const inner = raw.slice(1, -1);
    if (inner.includes("'")) {
      throw new BridgeError('INVALID_SKILL_FRONTMATTER', `Skill ${expectedName}: SKILL.md frontmatter 'name' contains invalid quotes`);
    }
    parsedName = inner;
  } else if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) {
      throw new BridgeError('INVALID_SKILL_FRONTMATTER', `Skill ${expectedName}: SKILL.md frontmatter 'name' has malformed double quotes`);
    }
    const inner = raw.slice(1, -1);
    if (inner.includes('"') || inner.includes('\\')) {
      throw new BridgeError('INVALID_SKILL_FRONTMATTER', `Skill ${expectedName}: SKILL.md frontmatter 'name' contains invalid quotes or escapes`);
    }
    parsedName = inner;
  } else {
    if (raw.includes('#') || /\s/.test(raw) || raw.includes('"') || raw.includes("'") || raw.includes(':')) {
      throw new BridgeError('INVALID_SKILL_FRONTMATTER', `Skill ${expectedName}: SKILL.md frontmatter 'name' has malformed or ambiguous unquoted tokens`);
    }
    parsedName = raw;
  }

  if (!isValidSkillName(parsedName)) {
    throw new BridgeError('INVALID_SKILL_FRONTMATTER', `Skill ${expectedName}: Frontmatter name '${parsedName}' is not a supported skill name`);
  }

  if (parsedName !== expectedName) {
    throw new BridgeError('INVALID_SKILL_FRONTMATTER', `Skill ${expectedName}: Frontmatter name '${parsedName}' does not match supplied name '${expectedName}'`);
  }

  return parsedName;
}

export function validateAndNormalizeResourcePath(resourcePath: string, skillName: string): string {
  if (typeof resourcePath !== 'string' || resourcePath.length === 0) {
    throw new BridgeError('INVALID_SKILL_RESOURCE', `Skill ${skillName}: Resource path cannot be empty`);
  }

  if (resourcePath.startsWith('/') || resourcePath.startsWith('\\')) {
    throw new BridgeError('INVALID_SKILL_RESOURCE', `Skill ${skillName}: Resource path must be relative: ${resourcePath}`);
  }

  if (/^[A-Za-z]:/.test(resourcePath)) {
    throw new BridgeError('INVALID_SKILL_RESOURCE', `Skill ${skillName}: Device or drive-letter paths forbidden: ${resourcePath}`);
  }

  if (/^(?:\\\\|\/\/|\\\\\?\\)/.test(resourcePath)) {
    throw new BridgeError('INVALID_SKILL_RESOURCE', `Skill ${skillName}: UNC or device namespace paths forbidden: ${resourcePath}`);
  }

  if (resourcePath.endsWith('/') || resourcePath.endsWith('\\')) {
    throw new BridgeError('INVALID_SKILL_RESOURCE', `Skill ${skillName}: Resource path cannot end with a slash: ${resourcePath}`);
  }

  const normalized = resourcePath.replaceAll('\\', '/');
  const segments = normalized.split('/');

  if (segments.some(s => s.length === 0)) {
    throw new BridgeError('INVALID_SKILL_RESOURCE', `Skill ${skillName}: Empty path segments forbidden: ${resourcePath}`);
  }

  if (segments.some(s => s === '.' || s === '..')) {
    throw new BridgeError('INVALID_SKILL_RESOURCE', `Skill ${skillName}: Path traversal forbidden: ${resourcePath}`);
  }

  if (segments.some(s => s.toLowerCase() === '.git')) {
    throw new BridgeError('INVALID_SKILL_RESOURCE', `Skill ${skillName}: .git paths forbidden: ${resourcePath}`);
  }

  if (segments.some(s => s.toLowerCase() === 'agents.md')) {
    throw new BridgeError('INVALID_SKILL_RESOURCE', `Skill ${skillName}: AGENTS.md is forbidden: ${resourcePath}`);
  }

  if (normalized.toLowerCase() === 'skill.md' || segments[0]?.toLowerCase() === 'skill.md') {
    throw new BridgeError('INVALID_SKILL_RESOURCE', `Skill ${skillName}: Overriding or nesting under SKILL.md is forbidden: ${resourcePath}`);
  }

  for (const seg of segments) {
    if (isWindowsDeviceName(seg)) {
      throw new BridgeError('INVALID_SKILL_RESOURCE', `Skill ${skillName}: Windows device name forbidden: ${resourcePath}`);
    }
    if (/[<>:"|?*\x00-\x1f]/.test(seg) || /[. ]$/.test(seg)) {
      throw new BridgeError('INVALID_SKILL_RESOURCE', `Skill ${skillName}: Invalid filename characters: ${resourcePath}`);
    }
  }

  return normalized;
}

export function computeSkillSha256(files: readonly { path: string; sha256: string }[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const hasher = createHash('sha256');
  for (const file of sorted) {
    hasher.update(`${file.path}\0${file.sha256}\0`);
  }
  return hasher.digest('hex');
}

export function sha256String(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

export async function sha256File(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    digest.update(chunk);
  }
  return digest.digest('hex');
}

export async function stageProvidedSkills(
  copyDirectory: string,
  bundles: readonly ProvidedSkill[],
  limits: Partial<ProjectLimits> = DEFAULT_PROJECT_LIMITS,
): Promise<readonly StagedSkill[]> {
  if (!Array.isArray(bundles)) {
    throw new BridgeError('INVALID_SKILL_INPUT', 'Provided skills must be an array');
  }

  if (bundles.length === 0) {
    return Object.freeze([]);
  }

  if (bundles.length > MAX_PROVIDED_SKILLS) {
    throw new BridgeError('COPY_LIMIT_EXCEEDED', `Too many skill bundles (${bundles.length}); maximum is ${MAX_PROVIDED_SKILLS}`);
  }

  for (const b of bundles) {
    if (b && typeof b === 'object' && Array.isArray((b as { resources?: unknown }).resources)) {
      if (((b as { resources: unknown[] }).resources.length) > MAX_RESOURCES_PER_SKILL) {
        throw new BridgeError('COPY_LIMIT_EXCEEDED', `Skill exceeds limit of ${MAX_RESOURCES_PER_SKILL} resources`);
      }
    }
  }

  const parsed = providedSkillsSchema.safeParse(bundles);
  if (!parsed.success) {
    throw new BridgeError('INVALID_SKILL_INPUT', `Invalid provided skills input: ${parsed.error.message}`);
  }

  // Phase 1: Pure in-memory prevalidation across all bundles
  const seenSkillNames = new Set<string>();
  let totalBytes = 0;
  let totalFiles = 0;

  for (const bundle of bundles) {
    if (!isValidSkillName(bundle.name)) {
      throw new BridgeError('INVALID_SKILL_NAME', `Invalid skill name: ${bundle.name}`);
    }

    const lowerName = bundle.name.toLowerCase();
    if (seenSkillNames.has(lowerName)) {
      throw new BridgeError('INVALID_SKILL_INPUT', `Duplicate skill name: ${bundle.name}`);
    }
    seenSkillNames.add(lowerName);

    parseAndValidateFrontmatterName(bundle.content, bundle.name);

    totalBytes += Buffer.byteLength(bundle.content, 'utf8');
    totalFiles += 1;

    if (bundle.resources) {
      const seenResourcePathsLower = new Set<string>();
      const allSkillFilesLower = ['skill.md'];

      for (const res of bundle.resources) {
        const norm = validateAndNormalizeResourcePath(res.path, bundle.name);
        const lower = norm.toLowerCase();
        if (seenResourcePathsLower.has(lower)) {
          throw new BridgeError('INVALID_SKILL_RESOURCE', `Skill ${bundle.name}: Duplicate or case-alias resource path: ${norm}`);
        }
        seenResourcePathsLower.add(lower);
        allSkillFilesLower.push(lower);

        totalBytes += Buffer.byteLength(res.content, 'utf8');
        totalFiles += 1;
      }

      for (const fileA of allSkillFilesLower) {
        for (const fileB of allSkillFilesLower) {
          if (fileA !== fileB && fileB.startsWith(fileA + '/')) {
            throw new BridgeError('INVALID_SKILL_RESOURCE', `Skill ${bundle.name}: Path prefix collision between '${fileA}' and '${fileB}'`);
          }
        }
      }
    }
  }

  if (totalBytes > MAX_TOTAL_BUNDLES_BYTES) {
    throw new BridgeError('COPY_LIMIT_EXCEEDED', `Total skill bundles size (${totalBytes} bytes) exceeds limit of ${MAX_TOTAL_BUNDLES_BYTES} bytes (1 MiB)`);
  }
  if (limits.maxCopyBytes !== undefined && totalBytes > limits.maxCopyBytes) {
    throw new BridgeError('COPY_LIMIT_EXCEEDED', `Total skill bundles size (${totalBytes} bytes) exceeds copy limit of ${limits.maxCopyBytes} bytes`);
  }
  if (limits.maxCopyFiles !== undefined && totalFiles > limits.maxCopyFiles) {
    throw new BridgeError('COPY_LIMIT_EXCEEDED', `Total skill files (${totalFiles}) exceeds copy limit of ${limits.maxCopyFiles} files`);
  }

  // Phase 2: Filesystem prevalidation & collision checks (precedes writes)
  const rootStat = await lstat(copyDirectory).catch(() => {
    throw new BridgeError('UNSAFE_PROJECT_PATH', `copyDirectory does not exist or cannot be accessed: ${copyDirectory}`);
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new BridgeError('UNSAFE_PROJECT_PATH', `copyDirectory must be a non-link directory: ${copyDirectory}`);
  }

  const agentsPath = path.join(copyDirectory, '.agents');
  const agentsStat = await lstat(agentsPath).catch(err => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  });
  if (agentsStat) {
    if (agentsStat.isSymbolicLink() || !agentsStat.isDirectory()) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Existing .agents is not a directory or is a symbolic link');
    }
  }

  const skillsPath = path.join(copyDirectory, '.agents', 'skills');
  const skillsStat = await lstat(skillsPath).catch(err => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  });
  if (skillsStat) {
    if (skillsStat.isSymbolicLink() || !skillsStat.isDirectory()) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Existing .agents/skills is not a directory or is a symbolic link');
    }

    const existingEntries = await readdir(skillsPath);
    const existingLower = new Set(existingEntries.map(e => e.toLowerCase()));
    for (const bundle of bundles) {
      if (existingLower.has(bundle.name.toLowerCase())) {
        throw new BridgeError('SKILL_COLLISION', `Skill directory already exists: ${bundle.name}`);
      }
    }
  }

  for (const bundle of bundles) {
    const relSkillDir = path.join('.agents', 'skills', bundle.name.toLowerCase()).replaceAll('\\', '/');
    await checkedPath(copyDirectory, relSkillDir, false);
    const targetSkillDir = path.join(copyDirectory, '.agents', 'skills', bundle.name.toLowerCase());
    const targetStat = await lstat(targetSkillDir).catch(err => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    });
    if (targetStat) {
      throw new BridgeError('SKILL_COLLISION', `Skill directory already exists: ${bundle.name}`);
    }
  }

  // Phase 3: Prevalidation passed; write files exclusively with flag wx
  await mkdir(skillsPath, { recursive: true });

  const stagedSkills: StagedSkill[] = [];

  for (const bundle of bundles) {
    const skillDir = path.join(skillsPath, bundle.name.toLowerCase());
    await mkdir(skillDir, { recursive: true });

    const files: StagedSkillFile[] = [];

    const skillMdTarget = path.join(skillDir, 'SKILL.md');
    await writeFile(skillMdTarget, bundle.content, { encoding: 'utf8', flag: 'wx' });
    files.push(Object.freeze({
      path: `.agents/skills/${bundle.name.toLowerCase()}/SKILL.md`,
      sha256: sha256String(bundle.content),
    }));

    if (bundle.resources) {
      for (const res of bundle.resources) {
        const norm = res.path.replaceAll('\\', '/');
        const targetFile = path.join(skillDir, ...norm.split('/'));
        await mkdir(path.dirname(targetFile), { recursive: true });
        await writeFile(targetFile, res.content, { encoding: 'utf8', flag: 'wx' });
        files.push(Object.freeze({
          path: `.agents/skills/${bundle.name.toLowerCase()}/${norm}`,
          sha256: sha256String(res.content),
        }));
      }
    }

    files.sort((a, b) => a.path.localeCompare(b.path));

    const bundleSha256 = computeSkillSha256(files);

    stagedSkills.push(Object.freeze({
      name: bundle.name,
      sha256: bundleSha256,
      files: Object.freeze(files),
    }));
  }

  return Object.freeze(stagedSkills);
}

export async function verifyProvidedSkills(
  copyDirectory: string,
  manifest: readonly StagedSkill[],
): Promise<void> {
  if (!Array.isArray(manifest)) {
    throw new BridgeError('UNSAFE_SKILL_MANIFEST', 'Manifest must be an array of staged skills');
  }

  if (manifest.length === 0) {
    return;
  }

  if (manifest.length > MAX_PROVIDED_SKILLS) {
    throw new BridgeError('UNSAFE_SKILL_MANIFEST', `Manifest exceeds maximum of ${MAX_PROVIDED_SKILLS} skills`);
  }

  const seenManifestNames = new Set<string>();

  for (const skill of manifest) {
    if (!skill || typeof skill !== 'object') {
      throw new BridgeError('UNSAFE_SKILL_MANIFEST', 'Invalid staged skill entry in manifest');
    }
    if (!isValidSkillName(skill.name)) {
      throw new BridgeError('UNSAFE_SKILL_MANIFEST', `Invalid skill name in manifest: ${skill.name}`);
    }
    const lowerName = skill.name.toLowerCase();
    if (seenManifestNames.has(lowerName)) {
      throw new BridgeError('UNSAFE_SKILL_MANIFEST', `Duplicate skill name in manifest: ${skill.name}`);
    }
    seenManifestNames.add(lowerName);

    if (typeof skill.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(skill.sha256)) {
      throw new BridgeError('UNSAFE_SKILL_MANIFEST', `Invalid skill sha256 in manifest: ${skill.name}`);
    }

    if (!Array.isArray(skill.files) || skill.files.length === 0) {
      throw new BridgeError('UNSAFE_SKILL_MANIFEST', `Skill ${skill.name} has no files in manifest`);
    }

    if (skill.files.length > MAX_RESOURCES_PER_SKILL + 1) {
      throw new BridgeError('UNSAFE_SKILL_MANIFEST', `Skill ${skill.name} exceeds maximum of ${MAX_RESOURCES_PER_SKILL + 1} files`);
    }

    const expectedPrefix = `.agents/skills/${skill.name.toLowerCase()}/`;
    let hasSkillMd = false;
    const seenFilePathsLower = new Set<string>();

    for (const file of skill.files) {
      if (!file || typeof file !== 'object') {
        throw new BridgeError('UNSAFE_SKILL_MANIFEST', `Invalid file entry in skill ${skill.name}`);
      }
      if (typeof file.path !== 'string' || typeof file.sha256 !== 'string') {
        throw new BridgeError('UNSAFE_SKILL_MANIFEST', `Invalid file path or sha256 in skill ${skill.name}`);
      }
      if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
        throw new BridgeError('UNSAFE_SKILL_MANIFEST', `Invalid sha256 format for file: ${file.path}`);
      }
      if (file.path.includes('\\')) {
        throw new BridgeError('UNSAFE_SKILL_MANIFEST', `Backslashes forbidden in manifest path: ${file.path}`);
      }
      if (!file.path.startsWith(expectedPrefix)) {
        throw new BridgeError('UNSAFE_SKILL_MANIFEST', `File path '${file.path}' is not contained within skill directory '${expectedPrefix}'`);
      }

      const relativeToSkill = file.path.slice(expectedPrefix.length);
      if (relativeToSkill === 'SKILL.md') {
        hasSkillMd = true;
      } else {
        if (relativeToSkill.toLowerCase() === 'skill.md') {
          throw new BridgeError('UNSAFE_SKILL_MANIFEST', `Case mismatch on SKILL.md: ${file.path}`);
        }
        try {
          const norm = validateAndNormalizeResourcePath(relativeToSkill, skill.name);
          if (norm !== relativeToSkill) {
            throw new BridgeError('UNSAFE_SKILL_MANIFEST', `Unnormalized file path in manifest: ${file.path}`);
          }
        } catch (err) {
          if (err instanceof BridgeError) {
            throw new BridgeError('UNSAFE_SKILL_MANIFEST', err.message);
          }
          throw err;
        }
      }

      const lower = file.path.toLowerCase();
      if (seenFilePathsLower.has(lower)) {
        throw new BridgeError('UNSAFE_SKILL_MANIFEST', `Duplicate or case-alias file path in manifest: ${file.path}`);
      }
      seenFilePathsLower.add(lower);
    }

    if (!hasSkillMd) {
      throw new BridgeError('UNSAFE_SKILL_MANIFEST', `Skill ${skill.name} manifest is missing SKILL.md`);
    }

    const recomputedSha = computeSkillSha256(skill.files);
    if (recomputedSha !== skill.sha256) {
      throw new BridgeError('UNSAFE_SKILL_MANIFEST', `Skill ${skill.name} sha256 mismatch: manifest has ${skill.sha256}, expected ${recomputedSha}`);
    }
  }

  const rootStat = await lstat(copyDirectory).catch(() => {
    throw new BridgeError('SKILL_VERIFICATION_FAILED', `copyDirectory not found: ${copyDirectory}`);
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new BridgeError('SKILL_VERIFICATION_FAILED', 'copyDirectory must be a directory and not a link');
  }

  for (const rel of ['.agents', '.agents/skills']) {
    const full = path.join(copyDirectory, ...rel.split('/'));
    const st = await lstat(full).catch(() => {
      throw new BridgeError('SKILL_VERIFICATION_FAILED', `Missing required directory: ${rel}`);
    });
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new BridgeError('SKILL_VERIFICATION_FAILED', `${rel} is not a directory or is a symbolic link`);
    }
  }

  let totalVerifiedBytes = 0;

  for (const skill of manifest) {
    const skillRelative = `.agents/skills/${skill.name.toLowerCase()}`;
    const skillDir = path.join(copyDirectory, '.agents', 'skills', skill.name.toLowerCase());
    const skillStat = await lstat(skillDir).catch(() => {
      throw new BridgeError('SKILL_VERIFICATION_FAILED', `Skill directory not found: ${skillRelative}`);
    });
    if (!skillStat.isDirectory() || skillStat.isSymbolicLink()) {
      throw new BridgeError('SKILL_VERIFICATION_FAILED', `Skill directory must be a directory and not a link: ${skillRelative}`);
    }

    const manifestFileMap = new Map<string, string>();
    const allowedDirRelPaths = new Set<string>();
    allowedDirRelPaths.add(skillRelative);

    for (const f of skill.files) {
      manifestFileMap.set(f.path, f.sha256);
      const parts = f.path.split('/');
      for (let i = 3; i < parts.length; i++) {
        allowedDirRelPaths.add(parts.slice(0, i).join('/'));
      }
    }

    for (const file of skill.files) {
      const filePath = await checkedPath(copyDirectory, file.path, true).catch(err => {
        if (err instanceof BridgeError) throw err;
        throw new BridgeError('SKILL_VERIFICATION_FAILED', `File missing or inaccessible: ${file.path}`);
      });

      const fileStat = await lstat(filePath);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new BridgeError('SKILL_VERIFICATION_FAILED', `File is not a regular file or is a link: ${file.path}`);
      }
      if (fileStat.nlink > 1) {
        throw new BridgeError('SKILL_VERIFICATION_FAILED', `Hardlinks are forbidden: ${file.path}`);
      }

      totalVerifiedBytes += fileStat.size;
      if (totalVerifiedBytes > MAX_TOTAL_BUNDLES_BYTES) {
        throw new BridgeError('SKILL_VERIFICATION_FAILED', `Total skill files exceed ${MAX_TOTAL_BUNDLES_BYTES} bytes (1 MiB)`);
      }

      const actualSha = await sha256File(filePath);
      if (actualSha !== file.sha256) {
        throw new BridgeError('SKILL_VERIFICATION_FAILED', `File content modified: ${file.path} (expected ${file.sha256}, got ${actualSha})`);
      }
    }

    const onDiskFiles: string[] = [];
    async function scan(dir: string, relPrefix: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const entryRel = relPrefix + '/' + entry.name;
        const fullPath = path.join(dir, entry.name);
        const st = await lstat(fullPath);
        if (st.isSymbolicLink()) {
          throw new BridgeError('SKILL_VERIFICATION_FAILED', `Symbolic link found in skill: ${entryRel}`);
        }
        if (st.isDirectory()) {
          if (!allowedDirRelPaths.has(entryRel)) {
            throw new BridgeError('SKILL_VERIFICATION_FAILED', `Unexpected directory found: ${entryRel}`);
          }
          await scan(fullPath, entryRel);
        } else if (st.isFile()) {
          if (st.nlink > 1) {
            throw new BridgeError('SKILL_VERIFICATION_FAILED', `Hardlinks are forbidden: ${entryRel}`);
          }
          if (!manifestFileMap.has(entryRel)) {
            throw new BridgeError('SKILL_VERIFICATION_FAILED', `Unexpected file found: ${entryRel}`);
          }
          onDiskFiles.push(entryRel);
        } else {
          throw new BridgeError('SKILL_VERIFICATION_FAILED', `Unsafe non-regular file found in skill: ${entryRel}`);
        }
      }
    }

    await scan(skillDir, skillRelative);

    for (const diskFile of onDiskFiles) {
      if (!manifestFileMap.has(diskFile)) {
        throw new BridgeError('SKILL_VERIFICATION_FAILED', `Untracked or unexpected file in skill directory: ${diskFile}`);
      }
    }

    if (onDiskFiles.length !== skill.files.length) {
      throw new BridgeError('SKILL_VERIFICATION_FAILED', `File count mismatch in skill ${skill.name}: expected ${skill.files.length}, found ${onDiskFiles.length}`);
    }
  }
}
