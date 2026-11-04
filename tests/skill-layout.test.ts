import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CORE_LIMIT_BYTES = 12_000;
const shippedSkill = fileURLToPath(new URL('../../plugin/skills/antigravity/', import.meta.url));

async function inspectSkillLayout(root: string): Promise<string[]> {
  const problems: string[] = [];
  // A Windows checkout can turn every LF into CRLF, so the limit applies to that larger form.
  const coreBytes = Buffer.byteLength((await readFile(path.join(root, 'SKILL.md'), 'utf8')).replace(/\r?\n/g, '\r\n'));
  if (coreBytes > CORE_LIMIT_BYTES) problems.push(`SKILL.md has ${coreBytes} bytes with CRLF line endings; the limit is ${CORE_LIMIT_BYTES}`);
  const references = (await readdir(path.join(root, 'references'))).filter(name => name.endsWith('.md')).sort();
  const linkedFromCore = new Set<string>();
  for (const document of ['SKILL.md', ...references.map(name => `references/${name}`)]) {
    const text = await readFile(path.join(root, document), 'utf8');
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      const resolved = path.resolve(root, path.dirname(document), target.split('#')[0]!);
      const inside = path.relative(root, resolved);
      if (inside.startsWith('..') || path.isAbsolute(inside)) problems.push(`${document}: link ${target} leaves the skill folder`);
      else if (!existsSync(resolved)) problems.push(`${document}: broken link ${target}`);
      else if (document === 'SKILL.md') linkedFromCore.add(inside.replaceAll(path.sep, '/'));
    }
  }
  for (const reference of references) {
    if (!linkedFromCore.has(`references/${reference}`)) problems.push(`references/${reference}: not linked from SKILL.md`);
  }
  return problems;
}

async function inspectFixture(core: string, reference: string): Promise<string[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-layout-'));
  try {
    await mkdir(path.join(root, 'references'));
    await writeFile(path.join(root, 'SKILL.md'), core);
    await writeFile(path.join(root, 'references', 'a.md'), reference);
    return await inspectSkillLayout(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const validCore = '[a](references/a.md)\n';
const validReference = '[core](../SKILL.md)\n';

test('the shipped skill core stays within the limit and every link resolves', async () => {
  assert.deepEqual(await inspectSkillLayout(shippedSkill), []);
});

test('a valid layout has no problems', async () => {
  assert.deepEqual(await inspectFixture(validCore, validReference), []);
});

test('a core above the limit is reported', async () => {
  const problems = await inspectFixture(validCore + 'x'.repeat(CORE_LIMIT_BYTES), validReference);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /the limit is 12000/);
});

test('a core that only exceeds the limit with CRLF line endings is reported', async () => {
  const lineFeeds = '\n'.repeat(10);
  const padding = 'x'.repeat(CORE_LIMIT_BYTES - validCore.length - lineFeeds.length);
  const problems = await inspectFixture(validCore + lineFeeds + padding, validReference);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /the limit is 12000/);
});

test('a broken link is reported', async () => {
  assert.deepEqual(await inspectFixture(validCore, '[gone](missing.md)\n'), ['references/a.md: broken link missing.md']);
});

test('a link that leaves the skill folder is reported', async () => {
  assert.deepEqual(await inspectFixture(validCore, '[out](../../outside.md)\n'), ['references/a.md: link ../../outside.md leaves the skill folder']);
});

test('a reference missing from the core is reported', async () => {
  assert.deepEqual(await inspectFixture('no links\n', validReference), ['references/a.md: not linked from SKILL.md']);
});
