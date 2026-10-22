// Maintainer tool: replaces plugin/anti-ai-craft with one pinned revision of the official repository.
// Usage: node scripts/update-anti-ai-craft.mjs --revision <40-hex> [--source <git url or path>]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const LIMITS = { maxTotalBytes: 64 * 1024 * 1024, maxFiles: 2000, maxFileBytes: 16 * 1024 * 1024 };
const SKILLS = ['anti-ai-audit', 'anti-ai-code', 'anti-ai-design', 'anti-ai-design-flow', 'anti-ai-remediate', 'anti-ai-security'];
// Catalog research tooling is development material; only the summary that ATTRIBUTIONS.md cites is kept.
const EXCLUDED = ['skills/anti-ai-design/references/visual-library/research/'];
const KEPT = ['skills/anti-ai-design/references/visual-library/research/superseded-link-only-summary.jsonl'];
const MEDIA = { '.md': 'text/markdown', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.json': 'application/json', '.jsonl': 'application/x-ndjson',
  '.txt': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const revision = option('--revision');
const source = option('--source') ?? 'https://github.com/Zythenth/anti-ai-craft.git';
if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('Pass --revision with a full 40-character commit hash');

const target = path.resolve('plugin', 'anti-ai-craft');
const work = await mkdtemp(path.join(os.tmpdir(), 'anti-ai-craft-'));
// No hooks, no symlinks and no checkout of the default branch: only the pinned tree is read.
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.symlinks=false', '-c', 'protocol.file.allow=always', ...args],
  { cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
try {
  git('init', '--quiet');
  git('fetch', '--quiet', '--depth', '1', '--no-tags', source, revision);
  if (git('rev-parse', 'FETCH_HEAD').trim() !== revision) throw new Error('Fetched revision does not match the requested hash');
  const version = JSON.parse(git('show', `${revision}:plugins/anti-ai-craft/.codex-plugin/plugin.json`)).version;
  const entries = git('ls-tree', '-r', '-z', '--long', revision, 'plugins/anti-ai-craft/skills/').split('\0').filter(Boolean);
  const files = [];
  for (const entry of entries) {
    const [meta, name] = entry.split('\t');
    const [mode, type] = meta.split(/\s+/);
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) throw new Error('Unsupported tree entry: ' + name);
    const relative = name.slice('plugins/anti-ai-craft/'.length);
    if (EXCLUDED.some(prefix => relative.startsWith(prefix)) && !KEPT.includes(relative)) continue;
    if (!/^skills\/[a-z0-9-]+\/[^\\:]+$/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe path: ' + relative);
    files.push(relative);
  }
  if (files.length > LIMITS.maxFiles) throw new Error('Too many files in the snapshot');
  const missing = SKILLS.filter(skill => !files.includes(`skills/${skill}/SKILL.md`));
  if (missing.length) throw new Error('Missing skills: ' + missing.join(', '));
  // Blobs are read as exact bytes, so no checkout filter or line-ending conversion can alter them.
  const staged = path.join(work, 'tree');
  const manifestFiles = [];
  let total = 0;
  for (const relative of files.sort()) {
    const bytes = execFileSync('git', ['cat-file', 'blob', `${revision}:plugins/anti-ai-craft/${relative}`], { cwd: work, maxBuffer: LIMITS.maxFileBytes + 1, windowsHide: true });
    if (bytes.length > LIMITS.maxFileBytes) throw new Error('File exceeds the per-resource limit: ' + relative);
    total += bytes.length;
    const file = path.join(staged, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes, { flag: 'wx' });
    manifestFiles.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      mediaType: MEDIA[path.extname(relative).toLowerCase()] ?? 'application/octet-stream' });
  }
  if (total > LIMITS.maxTotalBytes) throw new Error('Snapshot exceeds the installed size limit');
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(path.join(staged, 'skills'), path.join(target, 'skills'), { recursive: true });
  const manifest = { schemaVersion: 1, origin: source.replace(/\.git$/, ''), revision, version, skills: SKILLS, files: manifestFiles };
  await writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const listed = (await readdir(path.join(target, 'skills'), { recursive: true, withFileTypes: true })).filter(item => item.isFile()).length;
  if (listed !== manifestFiles.length) throw new Error('Copied tree differs from the manifest');
  console.log(`Anti-AI Craft ${version} at ${revision}: ${manifestFiles.length} files, ${total} bytes.`);
} finally {
  await rm(work, { recursive: true, force: true });
}
