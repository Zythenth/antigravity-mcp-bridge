import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { CliAdapter } from '../src/cli-adapter.js';
import { DEFAULT_PROJECT_LIMITS, loadConfig } from '../src/config.js';
import { EventStore } from '../src/event-store.js';
import { LineParser } from '../src/stream-parser.js';
import { TaskManager } from '../src/task-manager.js';
import type { TaskRecord } from '../src/types.js';
import type { AcceptanceCriterion } from '../src/verification.js';
import { readNativeReceipt } from '../src/native-tests.js';
import { createProjectCopy, discardProjectCopy, integrateProjectCopy, listProjectFiles, previewProjectCopy } from '../src/isolation.js';

const mockPath = fileURLToPath(new URL('../../tests/mock-agy.mjs', import.meta.url));
const stateDirectories: string[] = [];
const managers: TaskManager[] = [];
const acceptanceCriteria: AcceptanceCriterion[] = [{ id: 'created', description: 'Create the requested file', check: { kind: 'file-exists', path: 'AGY_BRIDGE_TEST.md' } }];
async function verifyTask(tasks: TaskManager, taskId: string, sha256: string) {
  const quote = await readFile(path.join(tasks.status(taskId).copyDirectory!, 'AGY_BRIDGE_TEST.md'), 'utf8');
  return tasks.verify(taskId, sha256, [{ criterionId: 'created', verdict: 'passed', path: 'AGY_BRIDGE_TEST.md', line: 1, quote, explanation: 'The requested file exists with the fixture content' }]);
}

test('a denied concurrent resume preserves the retained task while another server awaits approval', async () => {
  const dir = await repository();
  const { adapter, tasks, config } = setup([mockPath], { MAX_RETAINED_TASKS: '1' });
  try {
    await adapter.discover();
    const task = await tasks.run({ prompt: 'write:test', workingDirectory: dir, acceptanceCriteria });
    const finished = await until(tasks, task.taskId, done);
    const other = new TaskManager(adapter, config); managers.push(other);
    const preview = await other.preview(task.taskId);
    await verifyTask(other, task.taskId, preview.sha256);
    let deny!: (value: boolean) => void;
    let waiting!: () => void;
    const awaitingApproval = new Promise<void>(resolve => { waiting = resolve; });
    const integration = other.integrate(task.taskId, preview.sha256, async () => {
      waiting(); return new Promise<boolean>(resolve => { deny = resolve; });
    });
    await awaitingApproval;
    await assert.rejects(tasks.run({ prompt: 'resume', workingDirectory: dir, sessionId: finished.sessionId }), { code: 'STATE_BUSY' });
    assert.equal(tasks.status(task.taskId).status, 'completed');
    deny(false);
    await assert.rejects(integration, { code: 'APPROVAL_DENIED' });
    assert.equal(tasks.status(task.taskId).copyDirectory, finished.copyDirectory);
    await tasks.discard(task.taskId);
  } finally { await tasks.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test('integration requires confirmation and rechecks the patch after confirmation', async () => {
  const dir = await repository();
  const { adapter, tasks } = setup();
  try {
    await adapter.discover();
    const task = await tasks.run({ prompt: 'write:test', workingDirectory: dir, acceptanceCriteria });
    const finished = await until(tasks, task.taskId, done);
    const preview = await tasks.preview(task.taskId);
    await verifyTask(tasks, task.taskId, preview.sha256);
    await assert.rejects(tasks.integrate(task.taskId, preview.sha256), { code: 'APPROVAL_REQUIRED' });
    await assert.rejects(tasks.integrate(task.taskId, preview.sha256, async () => false), { code: 'APPROVAL_DENIED' });
    await assert.rejects(readFile(path.join(dir, 'AGY_BRIDGE_TEST.md')), { code: 'ENOENT' });
    await assert.rejects(tasks.integrate(task.taskId, preview.sha256, async reviewed => {
      assert.equal(reviewed.sha256, preview.sha256);
      await writeFile(path.join(finished.copyDirectory!, 'AGY_BRIDGE_TEST.md'), 'changed after confirmation');
      return true;
    }), { code: 'REVIEW_CHANGED' });
    await assert.rejects(readFile(path.join(dir, 'AGY_BRIDGE_TEST.md')), { code: 'ENOENT' });
    const current = await tasks.preview(task.taskId);
    await verifyTask(tasks, task.taskId, current.sha256);
    await tasks.integrate(task.taskId, current.sha256, async () => true);
    assert.equal(await readFile(path.join(dir, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'changed after confirmation');
    await tasks.discard(task.taskId);
  } finally { await tasks.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test('CLI success and fabricated reviews cannot bypass acceptance verification', async () => {
  const dir = await repository();
  const { adapter, tasks, config } = setup();
  try {
    await adapter.discover();
    const claimed = await tasks.run({ prompt: 'claim-only:test', workingDirectory: dir, acceptanceCriteria });
    assert.equal((await until(tasks, claimed.taskId, done)).status, 'completed');
    const absent = await tasks.preview(claimed.taskId);
    assert.equal((await tasks.verify(claimed.taskId, absent.sha256)).status, 'failed');
    const task = await tasks.run({ prompt: 'write:test', workingDirectory: dir, acceptanceCriteria });
    await until(tasks, task.taskId, done);
    const preview = await tasks.preview(task.taskId);
    await assert.rejects(tasks.integrate(task.taskId, preview.sha256, async () => true), { code: 'VERIFICATION_REQUIRED' });
    assert.equal((await tasks.verify(task.taskId, preview.sha256)).status, 'unverified');
    const fabricated = { criterionId: 'created', verdict: 'passed' as const, path: 'AGY_BRIDGE_TEST.md', line: 1, quote: 'invented content', explanation: 'Unsupported assertion' };
    assert.equal((await tasks.verify(task.taskId, preview.sha256, [fabricated])).status, 'failed');
    await assert.rejects(tasks.verify(task.taskId, preview.sha256, [{ ...fabricated, path: '../outside.txt' }]), { code: 'INVALID_INCLUDE_PATH' });
    await assert.rejects(tasks.verify(task.taskId, preview.sha256, [{ ...fabricated, criterionId: 'unknown' }]), { code: 'INVALID_REVIEW' });
    const verification = await verifyTask(tasks, task.taskId, preview.sha256);
    assert.equal(verification.status, 'passed');
    const recovered = new TaskManager(adapter, config); managers.push(recovered);
    assert.deepEqual(recovered.status(task.taskId).verification, JSON.parse(JSON.stringify(verification)));
    await recovered.integrate(task.taskId, preview.sha256, async () => true);
    assert.equal(await readFile(path.join(dir, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'Antigravity MCP bridge test successful.');
    const noCriteria = await tasks.run({ prompt: 'write-many:test', workingDirectory: dir });
    await until(tasks, noCriteria.taskId, done);
    const unchecked = await tasks.preview(noCriteria.taskId);
    assert.equal((await tasks.verify(noCriteria.taskId, unchecked.sha256)).status, 'unverified');
    await assert.rejects(tasks.integrate(noCriteria.taskId, unchecked.sha256, async () => true), { code: 'VERIFICATION_REQUIRED' });
  } finally { await tasks.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test('verification detects changed ignored evidence even when the patch hash stays equal', async () => {
  const dir = await repository();
  const { adapter, tasks } = setup();
  try {
    await writeFile(path.join(dir, '.gitignore'), 'generated.txt\n');
    await adapter.discover();
    const task = await tasks.run({ prompt: 'write:test', workingDirectory: dir,
      acceptanceCriteria: [{ id: 'output', description: 'Generated output is correct', check: { kind: 'file-contains', path: 'generated.txt', text: 'expected' } }] });
    const finished = await until(tasks, task.taskId, done);
    const file = path.join(finished.copyDirectory!, 'generated.txt');
    await writeFile(file, 'expected');
    const preview = await tasks.preview(task.taskId);
    const reviews = [{ criterionId: 'output', verdict: 'passed' as const, path: 'generated.txt', line: 1, quote: 'expected', explanation: 'Checked generated output' }];
    assert.equal((await tasks.verify(task.taskId, preview.sha256, reviews)).status, 'passed');
    await writeFile(file, 'expected but changed');
    const current = await tasks.preview(task.taskId);
    assert.equal(current.sha256, preview.sha256);
    assert.equal(current.verification?.stale, true);
    await assert.rejects(tasks.integrate(task.taskId, preview.sha256, async () => true), { code: 'VERIFICATION_STALE' });
    await writeFile(file, 'expected');
    await tasks.verify(task.taskId, preview.sha256, reviews);
    await assert.rejects(tasks.integrate(task.taskId, preview.sha256, async () => {
      await writeFile(file, 'expected but changed'); return true;
    }), { code: 'VERIFICATION_STALE' });
    await assert.rejects(readFile(path.join(dir, 'AGY_BRIDGE_TEST.md')), { code: 'ENOENT' });
  } finally { await tasks.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test('native test execution captures real command results, repair attempts and stale source state', async () => {
  const dir = await repository();
  const { adapter, tasks } = setup();
  try {
    await adapter.discover();
    const task = await tasks.run({ prompt: 'write:test', workingDirectory: dir, acceptanceCriteria });
    await until(tasks, task.taskId, done);
    const preview = await tasks.preview(task.taskId);
    const command = { executable: process.execPath, args: ['-e', "const fs=require('node:fs');console.log('actual test output');process.exit(fs.readFileSync('source.txt','utf8')==='fixed'?0:9)"] };
    const tested = await tasks.startTests(task.taskId, preview.sha256, command, 1, 20);
    const final = await until(tasks, tested.taskId, done, 30000);
    assert.equal(final.status, 'completed', JSON.stringify({ error: final.error, tests: final.tests, diagnostics: tasks.readEvents(tested.taskId).events.filter(event => event.type === 'process.stderr') }));
    assert.deepEqual(final.tests?.map(test => test.exitCode), [9, 0]);
    assert.ok(final.tests?.every(test => test.source === 'agy-tool' && test.output.includes('actual test output')));
    const after = await tasks.preview(tested.taskId);
    assert.equal(after.tests[0]?.stale, true);
    assert.equal(after.tests[1]?.stale, false);
    assert.equal(after.tests[1]?.beforeTreeSha256, after.tests[1]?.treeSha256);
    assert.equal(await readFile(path.join(dir, 'source.txt'), 'utf8'), 'source');
    await verifyTask(tasks, tested.taskId, after.sha256);
    await tasks.integrate(tested.taskId, after.sha256, async () => true);
    assert.equal(await readFile(path.join(dir, 'source.txt'), 'utf8'), 'fixed');
  } finally { await tasks.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test('native test failure is preserved and narrative success never counts as executed tests', async () => {
  const dir = await repository();
  const { adapter, tasks } = setup();
  const unchecked = setup([mockPath, 'no-test-events']);
  try {
    await adapter.discover(); await unchecked.adapter.discover();
    for (const current of [tasks, unchecked.tasks]) {
      const task = await current.run({ prompt: 'write:test', workingDirectory: dir, acceptanceCriteria });
      await until(current, task.taskId, done);
      const preview = await current.preview(task.taskId);
      const tested = await current.startTests(task.taskId, preview.sha256, { executable: process.execPath, args: ['-e', 'console.log("failed assertion");process.exit(7)'] }, 0, 20);
      const final = await until(current, tested.taskId, done, 30000);
      assert.equal(final.error?.code, current === tasks ? 'TEST_FAILED' : 'TEST_EXECUTION_UNVERIFIED', JSON.stringify({ error: final.error, tests: final.tests }));
      assert.equal(final.tests?.at(-1)?.exitCode, current === tasks ? 7 : undefined);
      await assert.rejects(current.integrate(tested.taskId, preview.sha256, async () => true), { code: 'TASK_NOT_READY' });
    }
    await assert.rejects(readFile(path.join(dir, 'AGY_BRIDGE_TEST.md')), { code: 'ENOENT' });
  } finally { await tasks.shutdown(); await unchecked.tasks.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test('native test receipts require the exact tool command and reject malformed or duplicate receipts', () => {
  const nonce = 'd16a1fe6-5488-4c44-89a3-2972d0e4d9b1';
  const receipt = Buffer.from(JSON.stringify({ nonce, exitCode: 0, beforeSha256: 'a'.repeat(64), afterSha256: 'a'.repeat(64), truncated: false })).toString('base64');
  const output = 'observed output\nAGY_BRIDGE_TEST:' + nonce + ':' + receipt;
  const step = { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'exact command' }, output } };
  assert.equal(readNativeReceipt(step, { nonce, commandLine: 'exact command' })?.receipt.exitCode, 0);
  assert.equal(readNativeReceipt(step, { nonce, commandLine: 'different command' }), undefined);
  assert.equal(readNativeReceipt({ ...step, step_type: 'agent_response' }, { nonce, commandLine: 'exact command' }), undefined);
  assert.equal(readNativeReceipt({ ...step, tool_info: { parameters: { CommandLine: 'exact command' }, output: output + '\n' + output } }, { nonce, commandLine: 'exact command' }), undefined);
});

test('patch readers bind pages to the full hash and select changed files without mixing paths', async () => {
  const dir = await repository();
  const { adapter, tasks } = setup();
  try {
    await adapter.discover();
    const task = await tasks.run({ prompt: 'write:test', workingDirectory: dir });
    const final = await until(tasks, task.taskId, done);
    await writeFile(path.join(final.copyDirectory!, 'source.txt'), 'updated 😀 source\n');
    const preview = await tasks.preview(task.taskId);
    const metadata = await tasks.preview(task.taskId, false);
    assert.equal(metadata.patch, undefined);
    assert.equal(metadata.patchLength, preview.patch!.length);
    let offset = 0, combined = '';
    for (;;) {
      const page = await tasks.readPatch(task.taskId, preview.sha256, undefined, offset, 47);
      combined += page.text;
      if (!page.hasMore) break;
      offset = page.nextOffset;
    }
    assert.equal(combined, preview.patch);
    const selected = await tasks.readPatch(task.taskId, preview.sha256, 'source.txt');
    assert.ok(selected.text.includes('+updated 😀 source'));
    assert.ok(!selected.text.includes('AGY_BRIDGE_TEST.md'));
    await assert.rejects(tasks.readPatch(task.taskId, preview.sha256, '../outside'), { code: 'INVALID_PATCH_PATH' });
    const result = tasks.readResult(task.taskId, 0, 50000);
    assert.equal(result.ready, true);
    if (result.ready) assert.deepEqual(JSON.parse(result.text), final.result);
    await writeFile(path.join(final.copyDirectory!, 'source.txt'), 'changed again');
    await assert.rejects(tasks.readPatch(task.taskId, preview.sha256, 'source.txt', selected.nextOffset), { code: 'REVIEW_CHANGED' });
  } finally { await tasks.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test('planner and reviewer roles preserve read-only mode and reject fabricated citations', async () => {
  const dir = await repository();
  const { adapter, tasks, config } = setup();
  try {
    await adapter.discover();
    await assert.rejects(tasks.run({ prompt: 'review', workingDirectory: dir, role: 'reviewer', mode: 'write' }), { code: 'INVALID_ROLE' });
    const planned = await tasks.run({ prompt: 'plan:test', workingDirectory: dir, role: 'planner' });
    const plan = await until(tasks, planned.taskId, done);
    assert.equal(plan.mode, 'read-only');
    assert.equal(plan.report?.role, 'planner');
    assert.equal(plan.report?.source, 'agy-reported');
    assert.deepEqual(plan.report?.data.unverified, ['Runtime not tested']);
    const reviewed = await tasks.run({ prompt: 'review:test', workingDirectory: dir, role: 'reviewer' });
    const review = await until(tasks, reviewed.taskId, done);
    assert.equal(review.status, 'completed', JSON.stringify(review.error));
    assert.equal(review.report?.role, 'reviewer');
    if (review.report?.role === 'reviewer') assert.equal(review.report.citationsChecked, true);
    const recovered = new TaskManager(adapter, config); managers.push(recovered);
    assert.deepEqual(recovered.status(reviewed.taskId).report, review.report);
    await assert.rejects(tasks.integrate(reviewed.taskId, '0'.repeat(64)), { code: 'READ_ONLY_TASK' });
    await assert.rejects(tasks.run({ prompt: 'change role', workingDirectory: dir, sessionId: review.sessionId, role: 'implementer' }), { code: 'INVALID_ROLE' });
    const invalid = await tasks.run({ prompt: 'fabricated-review:test', workingDirectory: dir, role: 'reviewer' });
    assert.equal((await until(tasks, invalid.taskId, done)).error?.code, 'ROLE_OUTPUT_INVALID');
    const modified = await tasks.run({ prompt: 'write:test', workingDirectory: dir, role: 'reviewer' });
    assert.equal((await until(tasks, modified.taskId, done)).error?.code, 'READ_ONLY_VIOLATION');
    assert.equal(await readFile(path.join(dir, 'source.txt'), 'utf8'), 'source');
  } finally { await tasks.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test('preview reports line totals, A/M/D counts and binary files independently of patch text', async () => {
  const dir = await repository();
  try {
    await writeFile(path.join(dir, 'gone.txt'), 'a\nb\n');
    await writeFile(path.join(dir, 'binary.bin'), Buffer.from([0, 1, 2]));
    const project = await createProjectCopy(dir);
    await writeFile(path.join(project.copyDirectory, 'source.txt'), 'new\nmore\n');
    await writeFile(path.join(project.copyDirectory, 'new file.txt'), 'first\nsecond\n');
    await writeFile(path.join(project.copyDirectory, 'binary.bin'), Buffer.from([0, 3, 4]));
    await rm(path.join(project.copyDirectory, 'gone.txt'));
    const preview = await previewProjectCopy(project);
    assert.deepEqual(preview.summary, { filesChanged: 4, added: 1, modified: 2, deleted: 1, insertions: 4, deletions: 3, binaryFiles: 1 });
    assert.deepEqual(preview.fileSummaries.find(file => file.path === 'new file.txt'), { status: 'A', path: 'new file.txt', insertions: 2, deletions: 0, binary: false });
    assert.deepEqual(preview.fileSummaries.find(file => file.path === 'binary.bin'), { status: 'M', path: 'binary.bin', insertions: null, deletions: null, binary: true });
    assert.ok(preview.patch.includes('GIT binary patch'));
    await discardProjectCopy(project);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('test evidence persists, keeps failed results and marks stale hashes without claiming execution', async () => {
  const dir = await repository();
  const { adapter, tasks, config } = setup();
  try {
    await adapter.discover();
    const task = await tasks.run({ prompt: 'write:test', workingDirectory: dir });
    const finished = await until(tasks, task.taskId, done);
    const preview = await tasks.preview(task.taskId);
    await tasks.recordTest(task.taskId, preview.sha256, 'fixture check', 0, 'client-provided output');
    const recovered = new TaskManager(adapter, config); managers.push(recovered);
    assert.equal((await recovered.preview(task.taskId)).tests[0]?.source, 'client-reported');
    assert.equal((await recovered.preview(task.taskId)).tests[0]?.stale, false);
    await writeFile(path.join(finished.copyDirectory!, 'source.txt'), 'changed');
    const changed = await recovered.preview(task.taskId);
    assert.equal(changed.tests[0]?.stale, true);
    await assert.rejects(recovered.recordTest(task.taskId, preview.sha256, 'old check', 0), { code: 'REVIEW_CHANGED' });
    await recovered.recordTest(task.taskId, changed.sha256, 'failed check', 1, 'assertion failed');
    const tests = (await recovered.preview(task.taskId)).tests;
    assert.equal(tests.length, 2);
    assert.equal(tests[1]?.exitCode, 1);
    assert.equal(tests[1]?.stale, false);
    await tasks.discard(task.taskId);
  } finally { await tasks.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test('copy limits enforce count and byte boundaries before copying; includePaths narrows them', async () => {
  const dir = await repository();
  try {
    await writeFile(path.join(dir, 'second.txt'), 'four');
    let created = false;
    const limits = { ...DEFAULT_PROJECT_LIMITS, maxCopyFiles: 1, maxCopyBytes: 6 };
    await assert.rejects(createProjectCopy(dir, undefined, () => { created = true; }, limits), { code: 'COPY_LIMIT_EXCEEDED' });
    assert.equal(created, false);
    const copy = await createProjectCopy(dir, ['source.txt'], undefined, limits);
    assert.equal(await readFile(path.join(copy.copyDirectory, 'source.txt'), 'utf8'), 'source');
    await discardProjectCopy(copy);
    await assert.rejects(createProjectCopy(dir, ['source.txt'], undefined, { ...limits, maxCopyBytes: 5 }), { code: 'COPY_LIMIT_EXCEEDED' });
    let copyDirectory = '', gitDirectory = '';
    await assert.rejects(createProjectCopy(dir, ['source.txt'], project => {
      copyDirectory = project.copyDirectory; gitDirectory = project.gitDirectory;
      writeFileSync(path.join(dir, 'source.txt'), 'longer source');
    }, limits), { code: 'COPY_LIMIT_EXCEEDED' });
    await assert.rejects(readFile(path.join(copyDirectory, 'source.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(gitDirectory, 'HEAD')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('change limits reject preview, integration and successful CLI output above the boundary', async () => {
  const dir = await repository();
  const { adapter, tasks } = setup([mockPath], { MAX_CHANGED_FILES: '1' });
  try {
    const project = await createProjectCopy(dir);
    await writeFile(path.join(project.copyDirectory, 'one.txt'), 'one');
    const limits = { ...DEFAULT_PROJECT_LIMITS, maxChangedFiles: 1 };
    assert.equal((await previewProjectCopy(project, limits)).files.length, 1);
    await writeFile(path.join(project.copyDirectory, 'two.txt'), 'two');
    await assert.rejects(previewProjectCopy(project, limits), { code: 'CHANGE_LIMIT_EXCEEDED' });
    await assert.rejects(integrateProjectCopy(project, '0'.repeat(64), limits), { code: 'CHANGE_LIMIT_EXCEEDED' });
    await assert.rejects(readFile(path.join(dir, 'one.txt')), { code: 'ENOENT' });
    await discardProjectCopy(project);
    await adapter.discover();
    const task = await tasks.run({ prompt: 'write-many:test', workingDirectory: dir });
    assert.equal((await until(tasks, task.taskId, done)).error?.code, 'CHANGE_LIMIT_EXCEEDED');
    assert.equal(await readFile(path.join(dir, 'source.txt'), 'utf8'), 'source');
    await tasks.discard(task.taskId);
  } finally { await tasks.shutdown(); await rm(dir, { recursive: true, force: true }); }
});
after(async () => {
  for (const tasks of managers) {
    await tasks.shutdown();
    for (const task of tasks.list()) if (done(task)) await tasks.discard(task.taskId);
  }
  for (const directory of stateDirectories) {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('agy-mcp-state-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('restart recovers tasks, bounded events, sessions and the original copy', async () => {
  const dir = await repository();
  const { adapter, tasks, config } = setup();
  try {
    await adapter.discover();
    const first = await tasks.run({ prompt: 'split:test', workingDirectory: dir, acceptanceCriteria });
    const finished = await until(tasks, first.taskId, done);
    const events = tasks.readEvents(first.taskId);
    await tasks.shutdown();
    const recovered = new TaskManager(adapter, config); managers.push(recovered);
    assert.equal(recovered.status(first.taskId).copyDirectory, finished.copyDirectory);
    assert.deepEqual(recovered.readEvents(first.taskId), events);
    assert.ok(recovered.sessions().some(session => session.sessionId === finished.sessionId));
    const next = await recovered.run({ prompt: 'write:test', workingDirectory: dir, sessionId: finished.sessionId });
    await until(recovered, next.taskId, done);
    assert.equal(recovered.status(next.taskId).copyDirectory, finished.copyDirectory);
    await assert.rejects(readFile(path.join(dir, 'AGY_BRIDGE_TEST.md')), { code: 'ENOENT' });
    const preview = await recovered.preview(next.taskId);
    await verifyTask(recovered, next.taskId, preview.sha256);
    await recovered.integrate(next.taskId, preview.sha256, async () => true);
    assert.ok(tasks.status(first.taskId).integratedAt);
    await tasks.discard(first.taskId);
    assert.ok(recovered.status(next.taskId).discardedAt);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('recovery never replays interrupted work or terminates an unowned live PID', async () => {
  const dir = await repository();
  const { adapter, tasks, config } = setup();
  try {
    await adapter.discover();
    const first = await tasks.run({ prompt: 'test', workingDirectory: dir });
    await until(tasks, first.taskId, done); await tasks.shutdown();
    const file = path.join(config.stateDirectory, first.taskId + '.json');
    const data = JSON.parse(await readFile(file, 'utf8'));
    data.ownerPid = 99999999; data.record.status = 'queued'; delete data.record.pid;
    await writeFile(file, JSON.stringify(data));
    const recovered = new TaskManager(adapter, config); managers.push(recovered);
    assert.equal(recovered.result(first.taskId).ready, true);
    assert.equal(recovered.status(first.taskId).error?.code, 'SERVER_RESTARTED');
    assert.equal(recovered.readEvents(first.taskId).events.at(-1)?.type, 'task.failed');
    data.record.status = 'running'; data.record.pid = process.pid;
    await writeFile(file, JSON.stringify(data));
    assert.equal(recovered.result(first.taskId).ready, false);
    assert.equal(recovered.status(first.taskId).error?.code, 'ORPHAN_PROCESS_RUNNING');
    await assert.rejects(recovered.cancel(first.taskId), { code: 'TASK_OWNED_BY_OTHER_SERVER' });
    await assert.rejects(recovered.discard(first.taskId), { code: 'TASK_NOT_READY' });
    data.record.status = 'failed'; delete data.record.pid;
    await writeFile(file, JSON.stringify(data));
    await recovered.discard(first.taskId);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('read-only uses plan mode, survives resume, rejects integration and detects edits', async () => {
  const dir = await repository();
  const { adapter, tasks } = setup([mockPath], { MAX_RETAINED_TASKS: '1' });
  try {
    await adapter.discover();
    const first = await tasks.run({ prompt: 'consult:test', workingDirectory: dir, mode: 'read-only' });
    const finished = await until(tasks, first.taskId, done);
    assert.equal(finished.status, 'completed');
    const init = tasks.readEvents(first.taskId).events.find(event => event.type === 'agent.started')!;
    const args = (init.data as { args: string[] }).args;
    assert.equal(args[args.indexOf('--mode') + 1], 'plan');
    await assert.rejects(tasks.integrate(first.taskId, '0'.repeat(64)), { code: 'READ_ONLY_TASK' });
    await assert.rejects(tasks.run({ prompt: 'switch', workingDirectory: dir, sessionId: finished.sessionId, mode: 'write' }), { code: 'INVALID_MODE' });
    const resumed = await tasks.run({ prompt: 'consult:resume', workingDirectory: dir, sessionId: finished.sessionId });
    assert.equal((await until(tasks, resumed.taskId, done)).status, 'completed');
    assert.equal(tasks.status(resumed.taskId).copyDirectory, finished.copyDirectory);
    assert.equal(tasks.status(resumed.taskId).mode, 'read-only');
    await tasks.discard(resumed.taskId);
    const violation = await tasks.run({ prompt: 'write:test', workingDirectory: dir, mode: 'read-only' });
    assert.equal((await until(tasks, violation.taskId, done)).error?.code, 'READ_ONLY_VIOLATION');
    await assert.rejects(readFile(path.join(dir, 'AGY_BRIDGE_TEST.md')), { code: 'ENOENT' });
    await tasks.discard(violation.taskId);
  } finally { await tasks.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test('discard removes copy and baseline, refuses active shared copies, and is idempotent', async () => {
  const dir = await repository();
  const { adapter, tasks } = setup();
  try {
    await adapter.discover();
    const first = await tasks.run({ prompt: 'write:test', workingDirectory: dir });
    const finished = await until(tasks, first.taskId, done);
    const resumed = await tasks.run({ prompt: 'slow:test', workingDirectory: dir, sessionId: finished.sessionId });
    await assert.rejects(tasks.discard(first.taskId), { code: 'TASK_NOT_READY' });
    await assert.rejects(tasks.preview(first.taskId), { code: 'TASK_NOT_READY' });
    await until(tasks, resumed.taskId, done);
    await tasks.discard(first.taskId);
    assert.ok(tasks.status(resumed.taskId).discardedAt);
    await assert.rejects(readFile(path.join(finished.copyDirectory!, 'source.txt')), { code: 'ENOENT' });
    await assert.rejects(tasks.preview(resumed.taskId), { code: 'TASK_NOT_READY' });
    await assert.rejects(tasks.run({ prompt: 'resume', workingDirectory: dir, sessionId: finished.sessionId }), { code: 'INVALID_SESSION' });
    await tasks.discard(first.taskId);
    assert.equal(await readFile(path.join(dir, 'source.txt'), 'utf8'), 'source');
  } finally { await tasks.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test('cleanup expires only inactive copies and deletion rejects source paths', async () => {
  const dir = await repository();
  const { adapter, tasks } = setup();
  try {
    await adapter.discover();
    const first = await tasks.run({ prompt: 'test', workingDirectory: dir });
    const finished = await until(tasks, first.taskId, done);
    assert.deepEqual((await tasks.cleanup()).discardedTaskIds, []);
    const active = await tasks.run({ prompt: 'slow:test', workingDirectory: dir });
    const future = Date.parse(finished.completedAt!) + 168 * 3600000;
    assert.deepEqual((await tasks.cleanup(future)).discardedTaskIds, [first.taskId]);
    assert.equal(tasks.status(active.taskId).discardedAt, undefined);
    await until(tasks, active.taskId, done);
    await tasks.discard(active.taskId);
    const project = await createProjectCopy(dir);
    await assert.rejects(discardProjectCopy({ ...project, copyDirectory: dir }), { code: 'UNSAFE_PROJECT_PATH' });
    assert.equal(await readFile(path.join(dir, 'source.txt'), 'utf8'), 'source');
    await discardProjectCopy(project);
    await assert.rejects(readFile(path.join(project.gitDirectory, 'HEAD')), { code: 'ENOENT' });
  } finally { await tasks.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

function setup(prefixArgs = [mockPath], configOverrides: Record<string, string> = {}) {
  const stateDirectory = mkdtempSync(path.join(os.tmpdir(), 'agy-mcp-state-test-')); stateDirectories.push(stateDirectory);
  const config = loadConfig({ AGY_PATH: process.execPath, DEFAULT_TIMEOUT_SECONDS: '2', BRIDGE_STATE_DIRECTORY: stateDirectory, ...configOverrides });
  const adapter = new CliAdapter(config, prefixArgs);
  const tasks = new TaskManager(adapter, config); managers.push(tasks);
  return { adapter, tasks, config };
}

async function until(tasks: TaskManager, taskId: string, predicate: (record: TaskRecord) => boolean, timeout = 5000): Promise<TaskRecord> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const task = tasks.status(taskId);
    if (predicate(task)) return task;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for task: ${JSON.stringify(tasks.status(taskId))}`);
}

const done = (task: TaskRecord) => ['completed', 'failed', 'cancelled', 'timeout'].includes(task.status);

async function repository(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-bridge-test-'));
  execFileSync('git', ['init', '--quiet', dir]);
  await writeFile(path.join(dir, 'source.txt'), 'source');
  return dir;
}

test('discovery distinguishes missing executable and authentication', async () => {
  const missing = new CliAdapter(loadConfig({ AGY_PATH: path.join(os.tmpdir(), 'absent-agy-executable') }));
  assert.equal((await missing.discover()).installed, false);
  const { adapter } = setup([mockPath, 'auth']);
  const health = await adapter.health();
  assert.equal(health.installed, true);
  assert.equal(health.authenticated, false);
  await assert.rejects(adapter.listModels(), { code: 'AGY_AUTH_REQUIRED' });
});

test('models come from CLI and invalid model is rejected', async () => {
  const { adapter, tasks } = setup();
  await adapter.discover();
  assert.deepEqual((await adapter.listModels()).map(item => item.id), ['mock-pro', 'mock-flash']);
  await assert.rejects(tasks.setModel('bad;echo injected'), { code: 'MODEL_NOT_AVAILABLE' });
  assert.equal(await tasks.setModel('mock-pro'), 'mock-pro');
  assert.equal(tasks.getModel(), 'mock-pro');
});

test('parser handles split UTF-8, multiple events and trailing lines', () => {
  const lines: string[] = [];
  const parser = new LineParser(line => lines.push(line));
  const bytes = Buffer.from('Olá\nsecond\nthird');
  parser.write(bytes.subarray(0, 3));
  parser.write(bytes.subarray(3, 10));
  parser.write(bytes.subarray(10));
  parser.end();
  assert.deepEqual(lines, ['Olá', 'second', 'third']);
});

test('event store enforces a global bound and reports lost cursors', () => {
  const store = new EventStore(2);
  store.append('a', 'first', {});
  store.append('b', 'other', {});
  store.append('a', 'last', {});
  const page = store.read('a', 0);
  assert.deepEqual(page.events.map(event => event.sequence), [2]);
  assert.equal(page.truncated, true);
  assert.equal(page.oldestAvailable, 2);
});

test('run streams official event shapes and captures result, stderr and malformed lines', async () => {
  const dir = await repository();
  try {
    const { adapter, tasks } = setup();
    await adapter.discover();
    const first = await tasks.run({ prompt: 'split: $() `echo injected`', workingDirectory: dir, model: 'mock-pro' });
    const final = await until(tasks, first.taskId, done);
    assert.equal(final.status, 'completed');
    assert.equal(final.sessionId, 'mock-conversation');
    assert.ok((final.result as { response: string }).response.startsWith('split: $() `echo injected`\n\n<bridge-verification>'));
    const events = tasks.readEvents(first.taskId).events;
    const initialArgs = (events.find(event => event.type === 'agent.started')!.data as { args: string[] }).args;
    assert.equal(initialArgs[initialArgs.indexOf('--add-dir') + 1], final.copyDirectory);
    assert.ok(initialArgs.includes('--new-project'));
    assert.ok(events.some(event => event.type === 'response.chunk' && (event.data as { text_delta: string }).text_delta === 'Olá'));
    assert.ok(events.some(event => event.type === 'tool.started'));
    assert.ok(events.some(event => event.type === 'tool.completed'));
    assert.equal(events.at(-1)?.type, 'task.completed');
    const after = tasks.readEvents(first.taskId, events[2]!.sequence);
    assert.ok(after.events.every(event => event.sequence > events[2]!.sequence));
    const second = await tasks.run({ prompt: 'malformed:test', workingDirectory: dir });
    await until(tasks, second.taskId, done);
    assert.ok(tasks.readEvents(second.taskId).events.some(event => event.type === 'stream.unparsed'));
    const third = await tasks.run({ prompt: 'stderr:test', workingDirectory: dir });
    await until(tasks, third.taskId, done);
    assert.ok(tasks.readEvents(third.taskId).events.some(event => event.type === 'process.stderr'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failure, timeout, cancellation, queue and concurrency', async () => {
  const dir = await repository();
  try {
    const { adapter, tasks } = setup([mockPath], { MAX_CONCURRENT_TASKS: '1', MAX_QUEUED_TASKS: '1' });
    await adapter.discover();
    const failure = await tasks.run({ prompt: 'failure:test', workingDirectory: dir });
    assert.equal((await until(tasks, failure.taskId, done)).status, 'failed');
    const crash = await tasks.run({ prompt: 'crash:test', workingDirectory: dir });
    assert.equal((await until(tasks, crash.taskId, done)).status, 'failed');
    const slow = await tasks.run({ prompt: 'slow:test', workingDirectory: dir });
    const queued = await tasks.run({ prompt: 'write:test', workingDirectory: dir });
    assert.equal(tasks.status(queued.taskId).status, 'queued');
    await assert.rejects(tasks.run({ prompt: 'extra:test', workingDirectory: dir }), { code: 'QUEUE_FULL' });
    await tasks.cancel(queued.taskId);
    assert.equal(tasks.status(queued.taskId).status, 'cancelled');
    assert.equal(tasks.status(queued.taskId).error?.code, 'TASK_CANCELLED');
    assert.equal((await until(tasks, slow.taskId, done)).status, 'completed');
    const timeout = await tasks.run({ prompt: 'timeout:test', workingDirectory: dir, timeoutSeconds: 1 });
    assert.equal((await until(tasks, timeout.taskId, done)).error?.code, 'TASK_TIMEOUT');
    const cancel = await tasks.run({ prompt: 'cancel:test', workingDirectory: dir });
    await until(tasks, cancel.taskId, task => Boolean(task.pid));
    await tasks.cancel(cancel.taskId);
    assert.equal((await until(tasks, cancel.taskId, done)).error?.code, 'TASK_CANCELLED');
    const write = await tasks.run({ prompt: 'write:test', workingDirectory: dir, acceptanceCriteria });
    assert.equal((await until(tasks, write.taskId, done)).status, 'completed');
    const written = tasks.status(write.taskId).copyDirectory!;
    assert.equal(await readFile(path.join(written, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'Antigravity MCP bridge test successful.');
    await assert.rejects(readFile(path.join(dir, 'AGY_BRIDGE_TEST.md'), 'utf8'), { code: 'ENOENT' });
    const preview = await tasks.preview(write.taskId);
    assert.deepEqual(preview.files, [{ status: 'A', path: 'AGY_BRIDGE_TEST.md' }]);
    await verifyTask(tasks, write.taskId, preview.sha256);
    await tasks.integrate(write.taskId, preview.sha256, async () => true);
    assert.equal(await readFile(path.join(dir, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'Antigravity MCP bridge test successful.');
    await assert.rejects(tasks.integrate(write.taskId, preview.sha256), { code: 'ALREADY_INTEGRATED' });
    await tasks.shutdown();
    await assert.rejects(tasks.run({ prompt: 'after shutdown', workingDirectory: dir }), { code: 'AGY_PROCESS_FAILED' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('working directory and prompt validation', async () => {
  const { adapter, tasks } = setup();
  await adapter.discover();
  await assert.rejects(tasks.run({ prompt: 'hello', workingDirectory: 'relative/path' }), { code: 'INVALID_WORKING_DIRECTORY' });
  await assert.rejects(tasks.run({ prompt: 'hello', workingDirectory: path.join(os.tmpdir(), 'absent-directory-123') }), { code: 'INVALID_WORKING_DIRECTORY' });
  await assert.rejects(tasks.run({ prompt: '', workingDirectory: os.tmpdir() }), { code: 'INVALID_PROMPT' });
});

test('resumed conversation reuses the isolated copy and source remains clean', async () => {
  const dir = await repository();
  try {
    const { adapter, tasks } = setup();
    await adapter.discover();
    const run = await tasks.run({ prompt: 'write:test', workingDirectory: dir });
    const final = await until(tasks, run.taskId, done);
    assert.equal(final.status, 'completed');
    assert.equal(final.sessionId, 'mock-conversation');
    const resumed = await tasks.run({ prompt: 'split:again', workingDirectory: dir, sessionId: final.sessionId });
    const continued = await until(tasks, resumed.taskId, done);
    assert.equal(continued.status, 'completed');
    assert.equal(continued.copyDirectory, final.copyDirectory);
    const resumedArgs = (tasks.readEvents(resumed.taskId).events.find(event => event.type === 'agent.started')!.data as { args: string[] }).args;
    assert.equal(resumedArgs[resumedArgs.indexOf('--add-dir') + 1], final.copyDirectory);
    assert.ok(!resumedArgs.includes('--new-project'));
    assert.equal(await readFile(path.join(final.copyDirectory!, 'AGY_BRIDGE_TEST.md'), 'utf8'), 'Antigravity MCP bridge test successful.');
    await assert.rejects(readFile(path.join(dir, 'AGY_BRIDGE_TEST.md'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('copy excludes Git ignores and excludes, includes untracked files and can narrow paths', async () => {
  const dir = await repository();
  try {
    await writeFile(path.join(dir, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(dir, '.git', 'info', 'exclude'), 'excluded.txt\n');
    await writeFile(path.join(dir, 'ignored.txt'), 'private');
    await writeFile(path.join(dir, 'excluded.txt'), 'private');
    await writeFile(path.join(dir, 'untracked.txt'), 'included');
    execFileSync('git', ['-C', dir, 'add', '-f', 'ignored.txt']);
    const eligible = await listProjectFiles(dir);
    assert.ok(eligible.includes('untracked.txt'));
    assert.ok(!eligible.includes('ignored.txt'));
    assert.ok(!eligible.includes('excluded.txt'));
    const copy = await createProjectCopy(dir, ['untracked.txt']);
    assert.deepEqual(copy.includedFiles, ['untracked.txt']);
    assert.equal(await readFile(path.join(copy.copyDirectory, 'untracked.txt'), 'utf8'), 'included');
    await assert.rejects(readFile(path.join(copy.copyDirectory, 'ignored.txt'), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(createProjectCopy(dir, ['ignored.txt']), { code: 'INVALID_INCLUDE_PATH' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('review digest gates integration and source edits block stale patches', async () => {
  const dir = await repository();
  try {
    const copy = await createProjectCopy(dir);
    await writeFile(path.join(copy.copyDirectory, 'source.txt'), 'changed');
    const preview = await previewProjectCopy(copy);
    assert.deepEqual(preview.files, [{ status: 'M', path: 'source.txt' }]);
    await assert.rejects(integrateProjectCopy(copy, '0'.repeat(64)), { code: 'REVIEW_CHANGED' });
    await writeFile(path.join(dir, 'source.txt'), 'source changed locally');
    await assert.rejects(integrateProjectCopy(copy, preview.sha256), { code: 'SOURCE_CHANGED' });
    await writeFile(path.join(dir, 'source.txt'), 'source');
    await integrateProjectCopy(copy, preview.sha256);
    assert.equal(await readFile(path.join(dir, 'source.txt'), 'utf8'), 'changed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
