import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CliAdapter } from '../src/cli-adapter.js';
import { loadConfig } from '../src/config.js';
import { TaskManager } from '../src/task-manager.js';
import { BridgeError, type TaskRecord } from '../src/types.js';

const mock = fileURLToPath(new URL('../../tests/mock-agy.mjs', import.meta.url));
const packaged = fileURLToPath(new URL('../../plugin/anti-ai-craft', import.meta.url));
const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

async function setup(env: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-craft-runtime-'));
  directories.push(root);
  const source = path.join(root, 'source');
  execFileSync('git', ['init', '--quiet', source]);
  await writeFile(path.join(source, 'source.txt'), 'source content\n');
  const state = path.join(root, 'state');
  const config = loadConfig({ AGY_PATH: process.execPath, BRIDGE_TEST_EXECUTOR: 'agy', BRIDGE_STATE_DIRECTORY: state, ...env });
  const adapter = new CliAdapter(config, [mock]);
  await adapter.discover();
  return { root, source, state, tasks: new TaskManager(adapter, config) };
}

async function finished(tasks: TaskManager, taskId: string): Promise<TaskRecord> {
  const deadline = Date.now() + 20000;
  let record = tasks.status(taskId);
  while (!['completed', 'failed', 'cancelled', 'timeout'].includes(record.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    record = tasks.status(taskId);
  }
  return record;
}

// A minimal snapshot with the two permanent skills and one situational skill.
async function syntheticSnapshot(root: string) {
  const directory = path.join(root, 'craft');
  const files: Record<string, string> = {
    'skills/anti-ai-code/SKILL.md': '---\nname: anti-ai-code\ndescription: Code rules.\n---\nCODE_BODY\n',
    'skills/anti-ai-code/references/notes.md': 'CODE_REFERENCE\n',
    'skills/anti-ai-security/SKILL.md': '---\nname: anti-ai-security\ndescription: Security rules.\n---\nSECURITY_BODY\n',
    'skills/anti-ai-design/SKILL.md': '---\nname: anti-ai-design\ndescription: Interface design guidance.\n---\nDESIGN_BODY_NOT_IN_PROMPT\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await writeFile(path.join(directory, relative), content);
  }
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, origin: 'https://github.com/Zythenth/anti-ai-craft', revision: 'c'.repeat(40), version: '0.0.1',
    skills: ['anti-ai-code', 'anti-ai-security', 'anti-ai-design'],
    files: Object.entries(files).map(([relative, content]) => ({ path: relative, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), mediaType: 'text/markdown' })) }));
  return directory;
}

test('new sessions receive the two permanent skills and a catalog without situational bodies', async () => {
  const { source, state, tasks } = await setup();
  try {
    const started = await tasks.run({ prompt: 'read:craft', workingDirectory: source, mode: 'read-only' });
    const record = await finished(tasks, started.taskId);
    assert.equal(record.status, 'completed', JSON.stringify(record.error));
    const manifest = JSON.parse(await readFile(path.join(packaged, 'manifest.json'), 'utf8'));
    assert.deepEqual(record.craft, { revision: manifest.revision, manifestSha256: record.craft!.manifestSha256, permanent: ['anti-ai-code', 'anti-ai-security'],
      catalog: ['anti-ai-audit', 'anti-ai-design', 'anti-ai-design-flow', 'anti-ai-remediate'] });
    assert.deepEqual(record.providedSkills?.map(skill => skill.name), ['anti-ai-code', 'anti-ai-security']);
    assert.ok(existsSync(path.join(record.copyDirectory!, '.agents', 'skills', 'anti-ai-security', 'SKILL.md')));
    const prompt = (record.result as { response: string }).response;
    assert.match(prompt, /<anti-ai-craft revision="[a-f0-9]{40}">/);
    const designBody = await readFile(path.join(packaged, 'skills', 'anti-ai-design', 'SKILL.md'), 'utf8');
    assert.equal(prompt.includes(designBody.split('\n').find(line => line.startsWith('## '))!), false);
    const args = (tasks.readEvents(started.taskId).events.find(event => event.type === 'agent.started')!.data as { args: string[] }).args;
    const cache = args[args.lastIndexOf('--add-dir') + 1]!;
    assert.ok(cache.startsWith(path.join(state, 'anti-ai-craft')));
    assert.ok(existsSync(path.join(cache, 'anti-ai-design', 'references', 'visual-library', 'images')));
  } finally {
    await tasks.shutdown();
  }
});

test('opt-out, conflicting names and a tampered snapshot are explicit', async () => {
  const off = await setup({ BRIDGE_ANTI_AI_CRAFT: 'off' });
  try {
    const started = await off.tasks.run({ prompt: 'read:off', workingDirectory: off.source, mode: 'read-only' });
    const record = await finished(off.tasks, started.taskId);
    assert.equal(record.craft, undefined);
    assert.equal(record.providedSkills, undefined);
  } finally {
    await off.tasks.shutdown();
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'agy-craft-synthetic-'));
  directories.push(scratch);
  const snapshot = await syntheticSnapshot(scratch);
  const custom = await setup({ BRIDGE_ANTI_AI_CRAFT_DIRECTORY: snapshot });
  try {
    const started = await custom.tasks.run({ prompt: 'read:custom', workingDirectory: custom.source, mode: 'read-only',
      skills: [{ name: 'anti-ai-code', content: '---\nname: anti-ai-code\ndescription: Code rules.\n---\nCODE_BODY\n', resources: [{ path: 'references/notes.md', content: 'CODE_REFERENCE\n' }] }] });
    const record = await finished(custom.tasks, started.taskId);
    assert.deepEqual(record.providedSkills?.map(skill => skill.name), ['anti-ai-code', 'anti-ai-security']);
    assert.equal((record.result as { response: string }).response.includes('DESIGN_BODY_NOT_IN_PROMPT'), false);
    await assert.rejects(custom.tasks.run({ prompt: 'read:conflict', workingDirectory: custom.source, mode: 'read-only', skills: [{ name: 'anti-ai-security', content: 'different' }] }),
      (error: unknown) => error instanceof BridgeError && error.code === 'SKILL_CONFLICT');
    await writeFile(path.join(snapshot, 'skills', 'anti-ai-design', 'SKILL.md'), 'tampered');
    await assert.rejects(custom.tasks.run({ prompt: 'read:tampered', workingDirectory: custom.source, mode: 'read-only' }),
      (error: unknown) => error instanceof BridgeError && error.code === 'CRAFT_SNAPSHOT_INVALID');
  } finally {
    await custom.tasks.shutdown();
  }
});
