import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { verifyCraftSnapshot, type VerifiedCraftSnapshot } from './craft-snapshot.js';
import type { ProvidedSkill } from './skills.js';
import { BridgeError } from './types.js';

export const PERMANENT_SKILLS = ['anti-ai-code', 'anti-ai-security'];
export const MAX_CATALOG_BYTES = 8 * 1024;
const TEXT_MEDIA_TYPES = new Set(['text/markdown', 'text/yaml', 'text/plain', 'application/json', 'application/x-ndjson']);

export const craftSelectionSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  root: z.string().min(1).max(4000),
  permanent: z.array(z.string()).max(8),
  catalog: z.array(z.object({ name: z.string(), description: z.string(), skillFile: z.string() }).strict()).max(16),
}).strict();
export type CraftSelection = z.infer<typeof craftSelectionSchema>;

export interface PreparedCraft {
  selection: CraftSelection;
  permanent: ProvidedSkill[];
}

// The bundle (plugin/server.mjs) and the compiled sources (dist/src) sit at different depths from the shipped snapshot.
function bundledSnapshot(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.join(here, 'anti-ai-craft'), path.join(here, '..', '..', 'plugin', 'anti-ai-craft')]
    .find(candidate => existsSync(path.join(candidate, 'manifest.json')));
}

// Each revision gets its own private copy, promoted atomically, so sessions keep reading the snapshot they started with after an upgrade.
async function cachedSnapshot(source: VerifiedCraftSnapshot, stateDirectory: string): Promise<VerifiedCraftSnapshot> {
  const parent = path.join(stateDirectory, 'anti-ai-craft');
  const target = path.join(parent, `${source.manifest.revision}-${source.manifestSha256.slice(0, 16)}`);
  if (existsSync(target)) {
    try {
      const cached = await verifyCraftSnapshot(target);
      if (cached.manifestSha256 === source.manifestSha256) return cached;
    } catch { /* rebuilt below */ }
    await rm(target, { recursive: true, force: true });
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.tmp-${randomUUID()}`);
  try {
    await cp(source.root, temporary, { recursive: true, errorOnExist: true, force: false });
    const copied = await verifyCraftSnapshot(temporary);
    if (copied.manifestSha256 !== source.manifestSha256) throw new BridgeError('CRAFT_SNAPSHOT_INVALID', 'Cached manifest differs from the installed snapshot');
    try {
      await rename(temporary, target);
    } catch (error) {
      // Another server promoted the same revision first; its copy must verify as well.
      if (!existsSync(target)) throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return verifyCraftSnapshot(target);
}

function frontmatterDescription(content: string): string {
  const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? '';
  const value = /^description:\s*(.+)$/m.exec(header)?.[1]?.trim() ?? '';
  return value.replace(/^["']|["']$/g, '');
}

async function permanentBundle(snapshot: VerifiedCraftSnapshot, name: string): Promise<ProvidedSkill> {
  const prefix = `skills/${name}/`;
  const read = (relative: string) => readFile(path.join(snapshot.root, ...relative.split('/')), 'utf8');
  const resources = snapshot.manifest.files.filter(file => file.path.startsWith(prefix) && file.path !== prefix + 'SKILL.md' && TEXT_MEDIA_TYPES.has(file.mediaType));
  return { name, content: await read(prefix + 'SKILL.md'),
    resources: await Promise.all(resources.map(async file => ({ path: file.path.slice(prefix.length), content: await read(file.path) }))) };
}

function boundedCatalog(entries: CraftSelection['catalog']): CraftSelection['catalog'] {
  // Names and paths are always kept; descriptions shrink until the catalog fits its prompt budget.
  for (let limit = 600; limit >= 0; limit -= 100) {
    const catalog = entries.map(entry => ({ ...entry, description: entry.description.length > limit ? entry.description.slice(0, limit).trimEnd() + '…' : entry.description }));
    if (Buffer.byteLength(JSON.stringify(catalog), 'utf8') <= MAX_CATALOG_BYTES) return catalog;
  }
  throw new BridgeError('CRAFT_SNAPSHOT_INVALID', 'Skill catalog does not fit its prompt budget');
}

export async function prepareCraft(config: { antiAiCraft: boolean; antiAiCraftDirectory?: string; stateDirectory: string }): Promise<PreparedCraft | undefined> {
  if (!config.antiAiCraft) return undefined;
  const source = config.antiAiCraftDirectory ?? bundledSnapshot();
  if (!source) throw new BridgeError('CRAFT_SNAPSHOT_MISSING', 'The bundled Anti-AI Craft snapshot is missing; reinstall this bridge version');
  const snapshot = await cachedSnapshot(await verifyCraftSnapshot(source), config.stateDirectory);
  const missing = PERMANENT_SKILLS.filter(name => !snapshot.manifest.skills.includes(name));
  if (missing.length) throw new BridgeError('CRAFT_SNAPSHOT_INVALID', 'Permanent skills are missing: ' + missing.join(', '));
  const permanent = await Promise.all(PERMANENT_SKILLS.map(name => permanentBundle(snapshot, name)));
  const catalog = await Promise.all(snapshot.manifest.skills.filter(name => !PERMANENT_SKILLS.includes(name)).map(async name => {
    const skillFile = path.join(snapshot.root, 'skills', name, 'SKILL.md');
    return { name, description: frontmatterDescription(await readFile(skillFile, 'utf8')), skillFile };
  }));
  return { permanent, selection: { revision: snapshot.manifest.revision, manifestSha256: snapshot.manifestSha256, root: snapshot.root,
    permanent: [...PERMANENT_SKILLS], catalog: boundedCatalog(catalog) } };
}

// Identical caller bundles are deduplicated; the same name with different content is a conflict, never a silent replacement.
export function mergePermanentSkills(permanent: readonly ProvidedSkill[], supplied: readonly ProvidedSkill[]): ProvidedSkill[] {
  const canonical = (skill: ProvidedSkill) => JSON.stringify([skill.content, [...skill.resources ?? []].map(file => [file.path, file.content]).sort()]);
  const merged = [...permanent];
  for (const skill of supplied) {
    const existing = merged.find(item => item.name.toLowerCase() === skill.name.toLowerCase());
    if (!existing) merged.push(skill);
    else if (canonical(existing) !== canonical(skill)) {
      throw new BridgeError('SKILL_CONFLICT', 'A supplied skill uses the name of a permanent Anti-AI Craft skill with different content: ' + skill.name);
    }
  }
  return merged;
}
