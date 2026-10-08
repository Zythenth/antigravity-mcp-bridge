import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { TaskManager } from '../src/task-manager.js';
import { StateStore } from '../src/state-store.js';
import { createProjectCopy, discardProjectCopy, forkProjectCopy, fingerprintProjectCopy, previewProjectCopy } from '../src/isolation.js';
import type { ProvidedSkill } from '../src/skills.js';

const skillContent = '---\nname: Presentations\ndescription: Fixture skill\n---\n# Slides\nPRESERVE_SKILL_BYTES_7E3A';
const skills: ProvidedSkill[] = [{ name: 'Presentations', content: skillContent, resources: [{ path: 'references/guide.md', content: 'REFERENCE_BYTES_942C' }] }];
async function fixture(extra: Record<string, string> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-skill-api-test-'));
  const source = path.join(dir, 'source');
  execFileSync('git', ['init', '--quiet', source]);
  await writeFile(path.join(source, 'source.txt'), 'source');
  const config = loadConfig({ AGY_PATH: process.execPath, BRIDGE_STATE_DIRECTORY: path.join(dir, 'state'), BRIDGE_TEST_EXECUTOR: 'agy', ...extra });
  const adapter = new CliAdapter(config, [fileURLToPath(new URL('../../tests/mock-agy.mjs', import.meta.url))]);
  await adapter.discover();
  const managers = [new TaskManager(adapter, config)];
  const tasks = managers[0]!;
  return { source, config, adapter, tasks, managers, async close() {
    for (const manager of managers) await manager.shutdown();
    const copies = new Map(new StateStore(config.stateDirectory).load().filter(t => t.project).map(t => [t.project!.copyDirectory, t.project!]));
    for (const project of copies.values()) await discardProjectCopy(project);
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(dir));
    assert.ok(relative && !relative.startsWith('..') && !relative.includes(path.sep) && relative.startsWith('agy-skill-api-test-'));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}
async function finished(tasks: TaskManager, taskId: string) {
  for (let i = 0; i < 30; i++) {
    const result = await tasks.wait(taskId, 0, 1);
    if (result.ready) { await delay(5); return tasks.status(taskId); }
  }
  throw new Error('Fixture task did not finish');
}

test('supplied skill bytes and resources reach only the isolated CLI copy with bounded provenance', async () => {
  const f = await fixture();
  try {
    const run = await f.tasks.run({ prompt: 'skills-read:test', workingDirectory: f.source, skills, mode: 'read-only' });
    const end = await finished(f.tasks, run.taskId);
    assert.equal(end.status, 'completed', JSON.stringify(end.error));
    const response = JSON.parse((end.result as { response: string }).response);
    assert.equal(response.skill, skillContent);
    assert.equal(response.reference, 'REFERENCE_BYTES_942C');
    assert.equal(end.providedSkills?.[0]?.name, 'Presentations');
    assert.equal(end.providedSkills?.[0]?.files.length, 2);
    assert.ok(!JSON.stringify(end.providedSkills).includes('PRESERVE_SKILL_BYTES'));
    const saved = new StateStore(f.config.stateDirectory).load()[0]!;
    assert.equal(saved.options.skills, undefined);
    assert.deepEqual(saved.project!.providedSkills, end.providedSkills);
    assert.ok(!saved.project!.baseline.has('.agents/skills/presentations/SKILL.md'));
    await assert.rejects(readFile(path.join(f.source, '.agents/skills/presentations/SKILL.md')), { code: 'ENOENT' });
    assert.deepEqual((await f.tasks.preview(run.taskId)).files, []);
  } finally { await f.close(); }
});

test('supplied auxiliary files never become source patches or source writes after reviewed integration', async () => {
  const f = await fixture();
  try {
    const run = await f.tasks.run({ prompt: 'write:test', workingDirectory: f.source, skills,
      acceptanceCriteria: [{ id: 'created', description: 'Create fixture file', check: { kind: 'file-exists', path: 'AGY_BRIDGE_TEST.md' } }] });
    const end = await finished(f.tasks, run.taskId);
    assert.equal(end.status, 'completed');
    const preview = await f.tasks.preview(run.taskId);
    assert.deepEqual(preview.files, [{ status: 'A', path: 'AGY_BRIDGE_TEST.md' }]);
    const quote = await readFile(path.join(end.copyDirectory!, 'AGY_BRIDGE_TEST.md'), 'utf8');
    await f.tasks.verify(run.taskId, preview.sha256, [{ criterionId: 'created', verdict: 'passed', path: 'AGY_BRIDGE_TEST.md', line: 1, quote, explanation: 'Observed fixture file and exact content' }]);
    await f.tasks.integrate(run.taskId, preview.sha256, async () => true);
    assert.equal(await readFile(path.join(f.source, 'AGY_BRIDGE_TEST.md'), 'utf8'), quote);
    await assert.rejects(readFile(path.join(f.source, '.agents/skills/presentations/SKILL.md')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('restart and resume retain the supplied manifest and refuse replacement bundles', async () => {
  const f = await fixture();
  try {
    const run = await f.tasks.run({ prompt: 'split:first', workingDirectory: f.source, skills, mode: 'read-only' });
    const end = await finished(f.tasks, run.taskId);
    assert.equal(end.status, 'completed');
    const recovered = new TaskManager(f.adapter, f.config); f.managers.push(recovered);
    assert.deepEqual(recovered.status(run.taskId).providedSkills, end.providedSkills);
    await assert.rejects(recovered.run({ prompt: 'split:replace', workingDirectory: f.source, sessionId: end.sessionId, skills: [] }), { code: 'INVALID_SKILLS' });
    const resumed = await recovered.run({ prompt: 'skills-read:again', workingDirectory: f.source, sessionId: end.sessionId });
    const continued = await finished(recovered, resumed.taskId);
    assert.equal(continued.status, 'completed');
    assert.equal(continued.copyDirectory, end.copyDirectory);
    assert.deepEqual(continued.providedSkills, end.providedSkills);
    assert.equal(JSON.parse((continued.result as { response: string }).response).skill, skillContent);
  } finally { await f.close(); }
});

test('copy bounds count both project files and supplied resources', async () => {
  for (const extra of [{ MAX_COPY_FILES: '2' }, { MAX_COPY_BYTES: String(Buffer.byteLength(skillContent) + 'REFERENCE_BYTES_942C'.length) }] as Record<string, string>[]) {
    const f = await fixture(extra);
    try {
      const run = await f.tasks.run({ prompt: 'split:test', workingDirectory: f.source, skills });
      const end = await finished(f.tasks, run.taskId);
      assert.equal(end.status, 'failed');
      assert.equal(end.error?.code, 'COPY_LIMIT_EXCEEDED');
      assert.ok(!f.tasks.readEvents(run.taskId).events.some(event => event.type === 'process.started'));
    } finally { await f.close(); }
  }
});

test('tamper fails preview, context, resume and integration while discard remains available', async () => {
  const f = await fixture();
  try {
    const run = await f.tasks.run({ prompt: 'write:test', workingDirectory: f.source, skills });
    const end = await finished(f.tasks, run.taskId);
    const preview = await f.tasks.preview(run.taskId);
    await writeFile(path.join(end.copyDirectory!, '.agents/skills/presentations/references/guide.md'), 'tampered');
    await assert.rejects(f.tasks.preview(run.taskId), { code: 'SKILL_VERIFICATION_FAILED' });
    await assert.rejects(f.tasks.context(run.taskId), { code: 'SKILL_VERIFICATION_FAILED' });
    await assert.rejects(f.tasks.run({ prompt: 'split:again', workingDirectory: f.source, sessionId: end.sessionId }), { code: 'SKILL_VERIFICATION_FAILED' });
    await assert.rejects(f.tasks.integrate(run.taskId, preview.sha256, async () => true), { code: 'SKILL_VERIFICATION_FAILED' });
    await f.tasks.discard(run.taskId);
    await assert.rejects(readFile(path.join(end.copyDirectory!, '.agents/skills/presentations/SKILL.md')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('read-only CLI cannot modify a supplied skill and existing project skills cannot be replaced', async () => {
  const f = await fixture();
  try {
    const run = await f.tasks.run({ prompt: 'skills-tamper:test', workingDirectory: f.source, skills, mode: 'read-only' });
    const end = await finished(f.tasks, run.taskId);
    assert.equal(end.status, 'failed');
    assert.equal(end.error?.code, 'SKILL_VERIFICATION_FAILED');
    await assert.rejects(f.tasks.preview(run.taskId), { code: 'SKILL_VERIFICATION_FAILED' });
    await writeFile(path.join(f.source, '.gitignore'), '.agents/\n');
    const legacy = await f.tasks.run({ prompt: 'split:legacy', workingDirectory: f.source, mode: 'read-only' });
    const legacyEnd = await finished(f.tasks, legacy.taskId);
    assert.equal(legacyEnd.status, 'completed');
    assert.equal(legacyEnd.providedSkills, undefined);
  } finally { await f.close(); }
});

test('context forks preserve supplied skills even when source Git ignores their generated directory', async () => {
  const f = await fixture();
  let original; let fork;
  try {
    await writeFile(path.join(f.source, '.gitignore'), '.agents/\n');
    original = await createProjectCopy(f.source, undefined, undefined, f.config, skills);
    const before = await fingerprintProjectCopy(original, f.config);
    fork = await forkProjectCopy(original, f.config);
    assert.equal(await fingerprintProjectCopy(fork, f.config), before);
    assert.deepEqual(fork.providedSkills, original.providedSkills);
    assert.equal(await readFile(path.join(fork.copyDirectory, '.agents/skills/presentations/SKILL.md'), 'utf8'), skillContent);
    assert.deepEqual((await previewProjectCopy(fork, f.config)).files, []);
  } finally { if (fork) await discardProjectCopy(fork); if (original) await discardProjectCopy(original); await f.close(); }
});


test('oversized supplied text is rejected before queueing or persistence', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.tasks.run({ prompt: 'split:large', workingDirectory: f.source, skills: [{ name: 'large-skill', content: '---\nname: large-skill\n---\n' + 'x'.repeat(1024 * 1024) }] }), { code: 'COPY_LIMIT_EXCEEDED' });
    assert.deepEqual(f.tasks.list(), []);
    assert.deepEqual(new StateStore(f.config.stateDirectory).load(), []);
  } finally { await f.close(); }
});
