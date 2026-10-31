import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyCraftSnapshot, type CraftManifest } from '../src/craft-snapshot.js';
import { BridgeError } from '../src/types.js';

const packaged = fileURLToPath(new URL('../../plugin/anti-ai-craft', import.meta.url));
const invalid = (error: unknown) => error instanceof BridgeError && error.code === 'CRAFT_SNAPSHOT_INVALID';

async function synthetic(change?: (manifest: CraftManifest, root: string) => Promise<void> | void) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-craft-snapshot-'));
  const content = Buffer.from('---\nname: anti-ai-code\n---\nSynthetic skill.\n');
  await mkdir(path.join(root, 'skills', 'anti-ai-code'), { recursive: true });
  await writeFile(path.join(root, 'skills', 'anti-ai-code', 'SKILL.md'), content);
  const manifest: CraftManifest = { schemaVersion: 1, origin: 'https://github.com/Zythenth/anti-ai-craft', revision: 'a'.repeat(40), version: '0.0.1',
    skills: ['anti-ai-code'], files: [{ path: 'skills/anti-ai-code/SKILL.md', bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), mediaType: 'text/markdown' }] };
  await change?.(manifest, root);
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  return root;
}

test('the packaged Anti-AI Craft snapshot matches its pinned manifest', async () => {
  const snapshot = await verifyCraftSnapshot(packaged);
  assert.equal(snapshot.manifest.revision, '201fec54431bdf7e4c8bb3660100601b41b97b08');
  assert.deepEqual(snapshot.manifest.skills, ['anti-ai-audit', 'anti-ai-code', 'anti-ai-design', 'anti-ai-design-flow', 'anti-ai-remediate', 'anti-ai-security']);
  assert.ok(snapshot.manifest.files.some(file => file.mediaType === 'image/png'));
  assert.equal(snapshot.manifest.files.some(file => file.path.endsWith('.py')), false);
});

test('a snapshot is refused when bytes, files or manifest paths diverge', async () => {
  const roots: string[] = [];
  try {
    const valid = await synthetic();
    roots.push(valid);
    assert.equal((await verifyCraftSnapshot(valid)).manifest.files.length, 1);
    const cases = [
      synthetic(async (_manifest, root) => { await writeFile(path.join(root, 'skills', 'anti-ai-code', 'SKILL.md'), 'tampered'); }),
      synthetic(async (_manifest, root) => { await writeFile(path.join(root, 'skills', 'anti-ai-code', 'extra.md'), 'unlisted'); }),
      synthetic(manifest => { manifest.files.push({ path: 'skills/anti-ai-code/missing.md', bytes: 0, sha256: 'b'.repeat(64), mediaType: 'text/markdown' }); }),
      synthetic(manifest => { manifest.files[0]!.path = 'skills/anti-ai-code/../SKILL.md'; }),
      synthetic(manifest => { manifest.files[0]!.mediaType = 'image/png'; }),
      synthetic(manifest => { manifest.skills.push('anti-ai-security'); }),
    ];
    for (const root of await Promise.all(cases)) {
      roots.push(root);
      await assert.rejects(verifyCraftSnapshot(root), invalid, root);
    }
  } finally {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  }
});
