import { randomUUID } from 'node:crypto';
import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CliAdapter, type Model } from '../src/cli-adapter.js';
import { loadConfig, type Config } from '../src/config.js';
import { TaskManager } from '../src/task-manager.js';
import { StateStore } from '../src/state-store.js';
import { discardProjectCopy } from '../src/isolation.js';
import { compactTask } from '../src/messages.js';
import { successOutputSchemas } from '../src/output-schemas.js';
import type { RunOptions, TaskRecord } from '../src/types.js';

class RecordingAdapter extends CliAdapter {
  calls: Array<{ options: RunOptions; model: string | undefined; cwd: string }> = [];
  override async listModels(): Promise<Model[]> { return ['model-a', 'model-b'].map(id => ({ id, name: id })); }
  override spawnTask(options: RunOptions, model: string | undefined, cwd: string): ChildProcessWithoutNullStreams {
    this.calls.push({ options: structuredClone(options), model, cwd });
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdout = new PassThrough();
    Object.assign(child, { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: undefined, exitCode: null, killed: false,
      kill: () => { Object.assign(child, { exitCode: 0, killed: true }); child.emit('close', 0); return true; } });
    setImmediate(() => {
      const output = options.roleDefinition?.baseRole === 'planner'
        ? { summary: 'Inspected fixture.', steps: [{ description: 'Check selected source.', files: ['chosen.txt'], verification: 'Read chosen.txt.' }], unverified: [] }
        : { marker: 'profile-result' };
      stdout.write(JSON.stringify({ event: 'init', conversation_id: options.sessionId ?? randomUUID() }) + '\n');
      stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', structured_output: output } }) + '\n');
      stdout.end(); Object.assign(child, { exitCode: 0 }); child.emit('close', 0);
    });
    return child;
  }
}

async function fixture(customRoles: unknown[], body: (f: { root: string; repo: string; state: string; config: Config; adapter: RecordingAdapter; tasks: TaskManager; managers: TaskManager[] }) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-profile-runtime-'));
  const repo = path.join(root, 'repo'), state = path.join(root, 'state');
  const managers: TaskManager[] = [];
  try {
    await mkdir(repo); await mkdir(state);
    await writeFile(path.join(repo, 'chosen.txt'), 'chosen fixture\n');
    await writeFile(path.join(repo, 'other.txt'), 'unselected fixture\n');
    await writeFile(path.join(repo, '.gitignore'), 'secret.txt\n');
    await writeFile(path.join(repo, 'secret.txt'), 'synthetic ignored fixture\n');
    for (const args of [['init'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.com'], ['config', 'commit.gpgsign', 'false'], ['add', '.'], ['commit', '-m', 'fixture']]) {
      execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    }
    const config = loadConfig({ BRIDGE_CUSTOM_ROLES: JSON.stringify(customRoles), BRIDGE_STATE_DIRECTORY: state, BRIDGE_TEST_EXECUTOR: 'agy', BRIDGE_DEFAULT_MODEL: 'model-b' });
    const adapter = new RecordingAdapter(config), tasks = new TaskManager(adapter, config); managers.push(tasks);
    await body({ root, repo, state, config, adapter, tasks, managers });
  } finally {
    for (const manager of managers) await manager.shutdown();
    const projects = new Map(new StateStore(state).load().filter(item => item.project).map(item => [item.project!.copyDirectory, item.project!]));
    for (const project of projects.values()) await discardProjectCopy(project);
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('agy-profile-runtime-'));
    await rm(root, { recursive: true, force: true });
  }
}
const schema = { type: 'object', properties: { marker: { type: 'string', enum: ['profile-result'] } }, required: ['marker'], additionalProperties: false };
const role = { name: 'specialist', baseRole: 'implementer', instruction: 'Use the selected fixture.', defaults: {
  model: 'model-a', effort: 'high', timeoutSeconds: 77, deliveryMode: 'messages', includePaths: ['chosen.txt'],
  skills: [{ name: 'fixture-skill', content: '---\nname: fixture-skill\ndescription: Public fixture.\n---\nRead the selected file.' }], outputSchema: schema, artifactPaths: ['chosen.txt'],
} };
async function completed(tasks: TaskManager, task: TaskRecord) {
  await tasks.wait(task.taskId); const current = tasks.status(task.taskId);
  assert.equal(current.status, 'completed', JSON.stringify(current.error)); return current;
}

test('specialist defaults reach copy selection, skills, adapter and validated result contracts', async () => {
  await fixture([role], async ({ repo, tasks, adapter }) => {
    const current = await completed(tasks, await tasks.run({ workingDirectory: repo, role: 'specialist', prompt: 'Inspect the public fixture.' }));
    assert.equal(current.model, 'model-a'); assert.equal(current.effort, 'high'); assert.equal(current.deliveryMode, 'messages');
    assert.deepEqual(current.includedFiles, ['chosen.txt']); assert.equal(current.providedSkills?.length, 1);
    assert.equal(await readFile(path.join(current.copyDirectory!, '.agents/skills/fixture-skill/SKILL.md'), 'utf8'), role.defaults.skills[0]!.content);
    assert.equal(adapter.calls[0]!.options.timeoutSeconds, 77); assert.equal(adapter.calls[0]!.options.effort, 'high');
    assert.equal(adapter.calls[0]!.model, 'model-a'); assert.deepEqual(current.structuredResult?.value, { marker: 'profile-result' });
    assert.deepEqual(tasks.listArtifacts(current.taskId).artifacts.map(item => item.path), ['chosen.txt']);
    assert.equal(compactTask(current).effort, 'high');
    const listing = successOutputSchemas.antigravity_roles.parse({ roles: tasks.roles() });
    assert.equal(listing.roles.find(item => item.name === 'specialist')?.defaultEffort, 'high');
    assert.equal(JSON.stringify(listing).includes('Read the selected file.'), false);
  });
});

test('task overrides replace profile defaults without merging selections or skill bundles', async () => {
  await fixture([role], async ({ repo, tasks, adapter }) => {
    const current = await completed(tasks, await tasks.run({ workingDirectory: repo, role: 'specialist', prompt: 'Inspect other fixture.', model: 'model-b', effort: 'low', timeoutSeconds: 42, skills: [], includePaths: ['other.txt'], artifactPaths: ['other.txt'], deliveryMode: 'events' }));
    assert.equal(current.model, 'model-b'); assert.equal(current.effort, 'low'); assert.equal(current.deliveryMode, 'events');
    assert.deepEqual(current.includedFiles, ['other.txt']); assert.deepEqual(current.providedSkills ?? [], []);
    assert.equal(adapter.calls[0]!.options.timeoutSeconds, 42);
    assert.deepEqual(tasks.listArtifacts(current.taskId).artifacts.map(item => item.path), ['other.txt']);
  });
});

test('resume after restart retains original specialist snapshot, model, effort, skills and timeout', async () => {
  await fixture([role], async ({ repo, state, tasks, managers }) => {
    const original = await completed(tasks, await tasks.run({ workingDirectory: repo, role: 'specialist', prompt: 'Original fixture.' }));
    await tasks.shutdown();
    const changedRole = structuredClone(role); changedRole.defaults.model = 'model-b'; changedRole.defaults.effort = 'low'; changedRole.defaults.timeoutSeconds = 12;
    changedRole.defaults.skills[0]!.content += '\nChanged configuration.';
    const config = loadConfig({ BRIDGE_CUSTOM_ROLES: JSON.stringify([changedRole]), BRIDGE_STATE_DIRECTORY: state, BRIDGE_TEST_EXECUTOR: 'agy', BRIDGE_DEFAULT_MODEL: 'model-b' });
    const adapter = new RecordingAdapter(config), resumedManager = new TaskManager(adapter, config); managers.push(resumedManager);
    const resumed = await completed(resumedManager, await resumedManager.run({ workingDirectory: repo, sessionId: original.sessionId, prompt: 'Continue original fixture.' }));
    assert.equal(resumed.model, 'model-a'); assert.equal(resumed.effort, 'high');
    assert.equal(adapter.calls[0]!.options.timeoutSeconds, 77);
    assert.deepEqual(resumed.roleDefinition, original.roleDefinition); assert.deepEqual(resumed.providedSkills, original.providedSkills);
    await assert.rejects(resumedManager.run({ workingDirectory: repo, sessionId: resumed.sessionId, prompt: 'Change effort.', effort: 'max' }), { code: 'INVALID_EFFORT' });
  });
});

test('explicit Auto model is preserved on resume even when server default selects another model', async () => {
  await fixture([role], async ({ repo, tasks, adapter }) => {
    const original = await completed(tasks, await tasks.run({ workingDirectory: repo, role: 'specialist', prompt: 'Auto fixture.', model: null }));
    assert.equal(original.model, undefined); assert.equal(adapter.calls[0]!.model, undefined);
    await completed(tasks, await tasks.run({ workingDirectory: repo, sessionId: original.sessionId, prompt: 'Resume Auto.' }));
    assert.equal(adapter.calls[1]!.model, undefined);
  });
});

test('specialist configuration cannot weaken read-only base or Git ignored selection', async () => {
  const planner = { name: 'planning-specialist', baseRole: 'planner', instruction: 'Inspect only.', defaults: { model: 'model-a', effort: 'high', includePaths: ['chosen.txt'] } };
  await fixture([planner, role], async ({ repo, tasks }) => {
    await assert.rejects(tasks.run({ workingDirectory: repo, role: 'planning-specialist', prompt: 'Write.', mode: 'write' }), { code: 'INVALID_ROLE' });
    const planned = await completed(tasks, await tasks.run({ workingDirectory: repo, role: 'planning-specialist', prompt: 'Plan.' }));
    assert.equal(planned.mode, 'read-only'); assert.equal(planned.report?.role, 'planner');
    const ignored = await tasks.run({ workingDirectory: repo, role: 'specialist', prompt: 'Ignored fixture.', includePaths: ['secret.txt'] });
    await tasks.wait(ignored.taskId); assert.equal(tasks.status(ignored.taskId).status, 'failed');
  });
});

test('actual adapter sends sandbox and effort as separate CLI arguments and refuses unsupported effort', async () => {
  await fixture([], async ({ root, repo, state }) => {
    const script = path.join(root, 'capture-effort.mjs'), receipt = path.join(root, 'argv.json');
    await writeFile(script, `import fs from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('--version'))console.log('1');
else if(args.includes('--help'))console.log('--sandbox --effort stream-json --output-format --conversation');
else {process.stdin.resume();process.stdin.once('end',()=>{fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(args));console.log(JSON.stringify({event:'result',result:{status:'SUCCESS'}}));});}`);
    const config = loadConfig({ AGY_PATH: process.execPath, BRIDGE_STATE_DIRECTORY: state, BRIDGE_TEST_EXECUTOR: 'agy' });
    const actual = new CliAdapter(config, [script]); await actual.discover();
    const child = actual.spawnTask({ prompt: 'Public capture fixture.', workingDirectory: repo, effort: 'high' }, 'model-a', repo);
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); });
    const argv: string[] = JSON.parse(await readFile(receipt, 'utf8'));
    assert.ok(argv.includes('--sandbox')); assert.equal(argv[argv.indexOf('--effort') + 1], 'high'); assert.equal(argv[argv.indexOf('--model') + 1], 'model-a');
    await writeFile(script, `console.log(process.argv.includes('--help') ? '--sandbox stream-json --output-format' : '1');`);
    const unsupported = new CliAdapter(config, [script]); await unsupported.discover();
    assert.throws(() => unsupported.spawnTask({ prompt: 'Unsupported fixture.', workingDirectory: repo, effort: 'high' }, undefined, repo), { code: 'AGY_CAPABILITY_UNAVAILABLE' });
  });
});
