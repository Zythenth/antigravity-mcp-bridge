import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultStateDirectory, legacyStateDirectory, loadConfig } from '../src/config.js';
import { appendMessage, resultReference } from '../src/messages.js';
import { EXECUTION_POLICY_PATHS } from '../src/execution-policy.js';
import { MIGRATION_MARKER, migrateDefaultState, migrateDefaultStateSettling, migrateLegacyState, readMigrationMarker } from '../src/state-migration.js';
import { StateStore } from '../src/state-store.js';
import type { TaskRecord } from '../src/types.js';

const entryPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
const migrationModule = pathToFileURL(fileURLToPath(new URL('../src/state-migration.js', import.meta.url))).href;
const DEAD_PID = 2_147_483_646;
// Only this test process counts as alive, so fixture owners are always gone.
const dead = (pid: number) => pid === process.pid;

function sandbox(): { root: string; legacy: string; target: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'black-gravity-migration-test-'));
  return {
    root, legacy: legacyStateDirectory(root), target: defaultStateDirectory(root),
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

function tree(directory: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (current: string, relative: string) => {
    for (const name of readdirSync(current).sort()) {
      const file = path.join(current, name), child = relative ? relative + '/' + name : name;
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) found[child] = 'link';
      else if (stat.isDirectory()) { found[child] = 'directory'; walk(file, child); }
      else found[child] = createHash('sha256').update(readFileSync(file)).digest('hex') + ':' + Math.floor(stat.mtimeMs);
    }
  };
  if (existsSync(directory)) walk(directory, '');
  return found;
}

function saveTask(directory: string, status: TaskRecord['status'], ownerPid: number, legacyReader = false): string {
  const taskId = randomUUID(), workingDirectory = path.join(directory, 'project');
  const record: TaskRecord = { taskId, prompt: 'Migration fixture', workingDirectory, status, createdAt: new Date().toISOString() };
  if (legacyReader) appendMessage(record, 'final', 'bridge', 'Result ready', resultReference({ taskId, result: { response: 'ok' } }));
  new StateStore(directory).save({ ownerPid, events: [], cursor: 0, options: { prompt: record.prompt, workingDirectory }, record });
  if (legacyReader) {
    const file = path.join(directory, taskId + '.json');
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    snapshot.record.messages[0].reference.tool = 'antigravity_read_result';
    writeFileSync(file, JSON.stringify(snapshot));
  }
  return taskId;
}

// A previous root with every kind of record the bridge persists, plus leftovers of finished operations.
function populate(legacy: string): { taskId: string; groupId: string } {
  mkdirSync(legacy, { recursive: true, mode: 0o700 });
  const taskId = saveTask(legacy, 'completed', DEAD_PID, true), groupId = randomUUID();
  writeFileSync(path.join(legacy, 'group-' + groupId + '.json'), JSON.stringify({ groupId, nodes: [] }), { mode: 0o600 });
  writeFileSync(path.join(legacy, 'integration-approvals.json'), JSON.stringify({ version: 1, roots: [] }), { mode: 0o600 });
  writeFileSync(path.join(legacy, 'sandbox-policy.json'), JSON.stringify({ version: 1, ceilings: {} }), { mode: 0o600 });
  writeFileSync(path.join(legacy, 'model-selection.json'), JSON.stringify({ version: 1, model: null }), { mode: 0o600 });
  mkdirSync(path.join(legacy, 'project-memory', 'a'.repeat(64)), { recursive: true });
  writeFileSync(path.join(legacy, 'project-memory', 'a'.repeat(64), 'reviewer.json'), JSON.stringify({ entries: ['kept'] }), { mode: 0o600 });
  mkdirSync(path.join(legacy, 'execution-receipts'));
  writeFileSync(path.join(legacy, 'execution-receipts', randomUUID() + '.jsonl'), '{"tool":"view_file"}\n', { mode: 0o600 });
  mkdirSync(path.join(legacy, 'anti-ai-craft', 'rev-0123456789abcdef'), { recursive: true });
  writeFileSync(path.join(legacy, 'anti-ai-craft', 'rev-0123456789abcdef', 'yarn.lock'), 'vendored file named like a lock\n');
  mkdirSync(path.join(legacy, 'windows-runtimes', 'node-fixture'), { recursive: true });
  writeFileSync(path.join(legacy, 'windows-runtimes', 'node-fixture', 'build.json'), '{"fixture":true}');
  mkdirSync(path.join(legacy, 'windows-lpac-leases'));
  writeFileSync(path.join(legacy, 'windows-lpac-leases', 'c'.repeat(32) + '.json.update.4242.tmp'), 'partial');
  writeFileSync(path.join(legacy, 'project-memory', 'a'.repeat(64), 'reviewer.' + randomUUID() + '.tmp'), 'partial');
  mkdirSync(path.join(legacy, 'sanitized'));
  // Leftovers that must stay behind: stale locks, a recovery gate and an unfinished atomic write.
  writeFileSync(path.join(legacy, 'group-' + groupId + '.lock'), JSON.stringify({ pid: DEAD_PID, token: randomUUID() }));
  writeFileSync(path.join(legacy, 'copy-' + 'b'.repeat(64) + '.lock.recovery'), JSON.stringify({ pid: DEAD_PID, token: randomUUID() }));
  writeFileSync(path.join(legacy, 'project-memory', 'memory.lock'), JSON.stringify({ pid: DEAD_PID, token: randomUUID(), createdAt: new Date().toISOString() }));
  writeFileSync(path.join(legacy, 'windows-runtimes', '.portable-node-fixture.lock'), JSON.stringify({ v: 1, pid: DEAD_PID, nonce: randomUUID() }));
  writeFileSync(path.join(legacy, taskId + '.json.' + randomUUID() + '.tmp'), 'partial');
  return { taskId, groupId };
}

const LEFT_BEHIND = (name: string) => name.endsWith('.lock') || name.endsWith('.lock.recovery') || name.endsWith('.tmp');

function assertMigratedCopy(legacyBefore: Record<string, string>, target: string): void {
  const copied = tree(target);
  for (const [name, value] of Object.entries(legacyBefore)) {
    if (LEFT_BEHIND(name) && !name.startsWith('anti-ai-craft/')) assert.equal(copied[name], undefined, name + ' must not be copied');
    // Timestamps are restored to the millisecond, so only the content is compared here.
    else assert.equal(copied[name]?.split(':')[0], value.split(':')[0], name + ' must be copied unchanged');
  }
  assert.deepEqual(Object.keys(copied).filter(name => !(name in legacyBefore)), [MIGRATION_MARKER]);
}

test('a previous root alone is copied once, without locks, and is left untouched', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    const { taskId } = populate(legacy);
    let linked = false;
    try { symlinkSync(path.join(legacy, 'model-selection.json'), path.join(legacy, 'linked.json')); linked = true; } catch { /* links need a privilege on Windows */ }
    const before = tree(legacy);
    const outcome = migrateLegacyState({ legacy, target, isProcessAlive: dead });
    assert.equal(outcome.status, 'migrated');
    assert.deepEqual(tree(legacy), before, 'the previous root must not change');
    if (linked) { assert.equal(existsSync(path.join(target, 'linked.json')), false); delete before['linked.json']; }
    assertMigratedCopy(before, target);
    assert.equal(existsSync(target + '.migrating'), false);
    const marker = readMigrationMarker(target)!;
    assert.equal(marker.source, path.resolve(legacy));
    assert.equal(marker.files, Object.entries(before).filter(([name, value]) => value !== 'directory' && value !== 'link' && (!LEFT_BEHIND(name) || name.startsWith('anti-ai-craft/'))).length);
    assert.deepEqual(marker.skipped.filter(item => item.reason === 'lock').map(item => item.path).sort(),
      Object.keys(before).filter(name => (name.endsWith('.lock') || name.endsWith('.lock.recovery')) && !name.startsWith('anti-ai-craft/')).sort());
    assert.equal(marker.skippedTotal, marker.skipped.length);
    if (process.platform !== 'win32') {
      assert.equal(lstatSync(target).mode & 0o777, 0o700);
      assert.equal(lstatSync(path.join(target, taskId + '.json')).mode & 0o777, lstatSync(path.join(legacy, taskId + '.json')).mode & 0o777);
    }
    // The historical reader name is normalized when read, and the stored bytes stay as they were written.
    const [loaded] = new StateStore(target).load();
    assert.equal(loaded!.record.messages![0]!.reference!.tool, 'black_gravity_read_result');
    assert.equal(readFileSync(path.join(target, taskId + '.json'), 'utf8').includes('"antigravity_read_result"'), true);
    assert.deepEqual(readFileSync(path.join(target, taskId + '.json')), readFileSync(path.join(legacy, taskId + '.json')));
  } finally { cleanup(); }
});

test('a current root alone needs no migration and no previous root is created', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    mkdirSync(target);
    saveTask(target, 'completed', DEAD_PID);
    const before = tree(target);
    assert.deepEqual(migrateLegacyState({ legacy, target, isProcessAlive: dead }), { status: 'not-needed' });
    assert.deepEqual(tree(target), before);
    assert.equal(existsSync(legacy), false);
    assert.equal(existsSync(target + '.migrating'), false);
    assert.deepEqual(migrateLegacyState({ legacy, target: path.join(target, 'absent'), isProcessAlive: dead }), { status: 'not-needed' });
    assert.equal(existsSync(path.join(target, 'absent')), false);
  } finally { cleanup(); }
});

test('two independent roots are a conflict that changes neither of them', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    populate(legacy);
    mkdirSync(target);
    saveTask(target, 'completed', DEAD_PID);
    const legacyBefore = tree(legacy), targetBefore = tree(target);
    const outcome = migrateLegacyState({ legacy, target, isProcessAlive: dead });
    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.status === 'blocked' && outcome.reason, 'legacy-state-conflict');
    assert.deepEqual(tree(legacy), legacyBefore);
    assert.deepEqual(tree(target), targetBefore);
    assert.equal(existsSync(target + '.migrating'), false);
  } finally { cleanup(); }
});

test('a current root holding only a prepared runtime cache is adopted and keeps its cache', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    const { taskId } = populate(legacy);
    mkdirSync(path.join(target, 'windows-runtimes', 'node-current'), { recursive: true });
    writeFileSync(path.join(target, 'windows-runtimes', 'node-current', 'build.json'), '{"current":true}');
    const legacyBefore = tree(legacy);
    assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'migrated');
    assert.deepEqual(tree(legacy), legacyBefore);
    assert.equal(readFileSync(path.join(target, 'windows-runtimes', 'node-current', 'build.json'), 'utf8'), '{"current":true}');
    assert.equal(existsSync(path.join(target, 'windows-runtimes', 'node-fixture')), false);
    assert.equal(existsSync(path.join(target, taskId + '.json')), true);
    assert.deepEqual(readMigrationMarker(target)!.skipped.filter(item => item.reason === 'kept-from-new-root'), [{ path: 'windows-runtimes', reason: 'kept-from-new-root' }]);
  } finally { cleanup(); }
});

test('repeating the migration is a no-op, even after the previous root changes or disappears', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    populate(legacy);
    assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'migrated');
    const migrated = tree(target);
    saveTask(legacy, 'completed', DEAD_PID);
    const again = migrateLegacyState({ legacy, target, isProcessAlive: dead });
    assert.equal(again.status, 'already-migrated');
    assert.deepEqual(tree(target), migrated);
    rmSync(legacy, { recursive: true, force: true });
    assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'already-migrated');
    assert.deepEqual(tree(target), migrated);
  } finally { cleanup(); }
});

test('a migration killed halfway leaves no current root and the next start completes it', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    populate(legacy);
    const before = tree(legacy);
    const script = 'const { migrateLegacyState } = await import(process.argv[1]); let copied = 0;' +
      'migrateLegacyState({ legacy: process.argv[2], target: process.argv[3], isProcessAlive: () => false, onFileCopied: () => { if (++copied === 3) process.exit(7); } });';
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script, migrationModule, legacy, target], { encoding: 'utf8' });
    assert.equal(killed.status, 7, killed.stderr);
    assert.equal(existsSync(target), false, 'a partial copy must never be published');
    assert.equal(existsSync(target + '.migrating'), true);
    assert.equal(readMigrationMarker(target + '.migrating'), undefined);
    assert.deepEqual(tree(legacy), before);

    // The interrupted process is gone, so its staging copy is discarded and rebuilt from the untouched previous root.
    const owner = JSON.parse(readFileSync(path.join(target + '.migrating', '.migration-owner.json'), 'utf8')).pid as number;
    assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: pid => pid !== owner && pid === process.pid, waitMs: 200 }).status, 'migrated');
    assertMigratedCopy(before, target);
    assert.deepEqual(tree(legacy), before);
    assert.deepEqual(readdirSync(path.dirname(target)).filter(name => name.includes('.migrating')), []);
  } finally { cleanup(); }
});

test('a staged copy that was completed but not published is published as it is', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    populate(legacy);
    const before = tree(legacy);
    assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'migrated');
    const published = tree(target);
    renameSync(target, target + '.migrating');
    writeFileSync(path.join(target + '.migrating', '.migration-owner.json'), JSON.stringify({ pid: DEAD_PID, token: randomUUID() }));
    assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'migrated');
    assert.deepEqual(tree(target), published);
    assert.deepEqual(tree(legacy), before);
    assert.equal(existsSync(target + '.migrating'), false);
  } finally { cleanup(); }
});

test('a previous root written to after its files were copied refuses the migration and publishes nothing', () => {
  const changes: Array<{ name: string; change: (legacy: string, taskId: string) => void }> = [
    { name: 'file rewritten after it was verified', change: legacy => writeFileSync(path.join(legacy, 'integration-approvals.json'), JSON.stringify({ version: 1, roots: ['later'] })) },
    { name: 'file created after the listing', change: legacy => { saveTask(legacy, 'completed', DEAD_PID); } },
    { name: 'file removed after it was copied', change: (legacy, taskId) => rmSync(path.join(legacy, taskId + '.json')) },
  ];
  for (const item of changes) {
    const { legacy, target, cleanup } = sandbox();
    try {
      const { taskId } = populate(legacy);
      const expected = Object.entries(tree(legacy)).filter(([name, value]) => value !== 'directory' && (!LEFT_BEHIND(name) || name.startsWith('anti-ai-craft/'))).length;
      let copied = 0;
      // The write happens once the last file was copied and verified, as an idle previous server could do it.
      const outcome = migrateLegacyState({ legacy, target, isProcessAlive: dead, onFileCopied: () => { if (++copied === expected) item.change(legacy, taskId); } });
      assert.equal(copied, expected, item.name);
      assert.equal(outcome.status === 'blocked' && outcome.reason, 'legacy-state-busy', item.name);
      assert.equal(existsSync(target), false, item.name);
      assert.deepEqual(readdirSync(path.dirname(target)).filter(name => name.includes('.migrating')), [], item.name);

      // Once the previous root is quiet again the same start migrates what it holds now.
      const settled = tree(legacy);
      assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'migrated', item.name);
      assertMigratedCopy(settled, target);
    } finally { cleanup(); }
  }
});

test('a complete staged copy is rebuilt when the previous root changed or is busy since it was staged', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    populate(legacy);
    assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'migrated');
    renameSync(target, target + '.migrating');
    writeFileSync(path.join(target + '.migrating', '.migration-owner.json'), JSON.stringify({ pid: DEAD_PID, token: randomUUID() }));
    const later = saveTask(legacy, 'completed', DEAD_PID);

    // A live lock of the previous root keeps even a complete staged copy from being published.
    const lock = path.join(legacy, 'model-selection.lock');
    writeFileSync(lock, JSON.stringify({ pid: 4242, token: randomUUID() }));
    const staged = tree(target + '.migrating');
    const busy = migrateLegacyState({ legacy, target, isProcessAlive: pid => pid === 4242 });
    assert.equal(busy.status === 'blocked' && busy.reason, 'legacy-state-busy');
    assert.equal(existsSync(target), false);
    assert.deepEqual(tree(target + '.migrating'), staged);
    rmSync(lock);

    const before = tree(legacy);
    assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'migrated');
    assert.equal(existsSync(path.join(target, later + '.json')), true, 'the stale staged copy must not be published');
    assertMigratedCopy(before, target);
    assert.deepEqual(tree(legacy), before);
    assert.deepEqual(readdirSync(path.dirname(target)).filter(name => name.includes('.migrating')), []);
  } finally { cleanup(); }
});

test('an entry that disappears or a previous root that is replaced under the copy refuses the migration', () => {
  const cases: Array<{ name: string; at: 'first' | 'last'; detail: RegExp; change: (legacy: string) => void }> = [
    { name: 'file removed before it was reached', at: 'first', detail: /disappeared/, change: legacy => rmSync(path.join(legacy, 'sandbox-policy.json')) },
    {
      name: 'root swapped for an identical directory', at: 'last', detail: /was replaced/,
      change: legacy => { renameSync(legacy, legacy + '.moved'); cpSync(legacy + '.moved', legacy, { recursive: true }); },
    },
  ];
  for (const item of cases) {
    const { legacy, target, cleanup } = sandbox();
    try {
      populate(legacy);
      const expected = Object.entries(tree(legacy)).filter(([name, value]) => value !== 'directory' && (!LEFT_BEHIND(name) || name.startsWith('anti-ai-craft/'))).length;
      let copied = 0;
      const outcome = migrateLegacyState({
        legacy, target, isProcessAlive: dead,
        onFileCopied: () => { if (++copied === (item.at === 'first' ? 1 : expected)) item.change(legacy); },
      });
      assert.equal(outcome.status === 'blocked' && outcome.reason, 'legacy-state-busy', item.name);
      assert.match(outcome.status === 'blocked' ? outcome.detail : '', item.detail, item.name);
      assert.equal(existsSync(target), false, item.name);
      assert.deepEqual(readdirSync(path.dirname(target)).filter(name => name.includes('.migrating')), [], item.name);
    } finally { cleanup(); }
  }
});

test('a complete staged copy that lost or changed a file is rebuilt instead of being published', () => {
  for (const damage of ['truncated', 'removed'] as const) {
    const { legacy, target, cleanup } = sandbox();
    try {
      populate(legacy);
      const before = tree(legacy);
      assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'migrated');
      const staging = target + '.migrating';
      renameSync(target, staging);
      writeFileSync(path.join(staging, '.migration-owner.json'), JSON.stringify({ pid: DEAD_PID, token: randomUUID() }));
      if (damage === 'truncated') writeFileSync(path.join(staging, 'sandbox-policy.json'), '');
      else rmSync(path.join(staging, 'sandbox-policy.json'));
      assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'migrated', damage);
      assertMigratedCopy(before, target);
      assert.deepEqual(tree(legacy), before, damage);
      assert.deepEqual(readdirSync(path.dirname(target)).filter(name => name.includes('.migrating')), [], damage);
    } finally { cleanup(); }
  }
});

test('a publication interrupted after the kept runtime cache was moved is completed with that cache', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    const { taskId } = populate(legacy);
    mkdirSync(path.join(target, 'windows-runtimes', 'node-current'), { recursive: true });
    writeFileSync(path.join(target, 'windows-runtimes', 'node-current', 'build.json'), '{"current":true}');
    assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'migrated');
    assert.deepEqual(readMigrationMarker(target)!.kept, ['windows-runtimes']);
    const published = tree(target);
    // The cache already sits in the staged copy and the emptied current root is gone, as right before the final rename.
    renameSync(target, target + '.migrating');
    assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'migrated');
    assert.deepEqual(tree(target), published);
    assert.equal(existsSync(path.join(target, 'windows-runtimes', 'node-fixture')), false);
    assert.equal(existsSync(path.join(target, taskId + '.json')), true);
    assert.deepEqual(readdirSync(path.dirname(target)).filter(name => name.includes('.migrating')), []);
  } finally { cleanup(); }
});

test('a damaged staged copy that already holds the kept runtime cache gives that cache back before it is rebuilt', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    const { taskId } = populate(legacy);
    mkdirSync(path.join(target, 'windows-runtimes', 'node-current'), { recursive: true });
    writeFileSync(path.join(target, 'windows-runtimes', 'node-current', 'build.json'), '{"current":true}');
    assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'migrated');
    renameSync(target, target + '.migrating');
    rmSync(path.join(target + '.migrating', 'sandbox-policy.json'));
    const before = tree(legacy);
    assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'migrated');
    assert.deepEqual(tree(legacy), before);
    assert.equal(readFileSync(path.join(target, 'windows-runtimes', 'node-current', 'build.json'), 'utf8'), '{"current":true}');
    assert.equal(existsSync(path.join(target, 'windows-runtimes', 'node-fixture')), false);
    assert.equal(existsSync(path.join(target, 'sandbox-policy.json')), true);
    assert.equal(existsSync(path.join(target, taskId + '.json')), true);
    assert.deepEqual(readMigrationMarker(target)!.kept, ['windows-runtimes']);
    assert.deepEqual(readdirSync(path.dirname(target)).filter(name => name.includes('.migrating')), []);
  } finally { cleanup(); }
});

test('an empty previous root is no state: a current root with its own state is used and nothing conflicts', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    mkdirSync(legacy);
    mkdirSync(target);
    saveTask(target, 'completed', DEAD_PID);
    const before = tree(target);
    assert.deepEqual(migrateLegacyState({ legacy, target, isProcessAlive: dead }), { status: 'not-needed' });
    assert.deepEqual(tree(target), before);
    assert.deepEqual(readdirSync(legacy), []);
    assert.equal(existsSync(target + '.migrating'), false);
  } finally { cleanup(); }
});

test('a staged copy that another server discarded and started again while it was validated is not published', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    populate(legacy);
    assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'migrated');
    const staging = target + '.migrating', peer = 4242;
    renameSync(target, staging);
    writeFileSync(path.join(staging, '.migration-owner.json'), JSON.stringify({ pid: DEAD_PID, token: randomUUID() }));
    let recreated: Record<string, string> | undefined;
    const outcome = migrateLegacyState({
      legacy, target, waitMs: 200, isProcessAlive: pid => pid === peer,
      // The validation of the complete copy is over; a second server replaces it right before it would be published.
      onStagedValidated: () => {
        if (recreated) return;
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(staging);
        writeFileSync(path.join(staging, '.migration-owner.json'), JSON.stringify({ pid: peer, token: randomUUID() }));
        writeFileSync(path.join(staging, 'partial.json'), '{}');
        recreated = tree(staging);
      },
    });
    assert.ok(recreated);
    assert.equal(outcome.status === 'blocked' && outcome.reason, 'legacy-state-busy');
    assert.equal(existsSync(target), false, 'the partial copy of the other server must not be published');
    assert.deepEqual(tree(staging), recreated);
  } finally { cleanup(); }
});

test('a staging root that another server recreated after it was inspected is left alone', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    populate(legacy);
    const staging = target + '.migrating', peer = 4242;
    mkdirSync(staging);
    writeFileSync(path.join(staging, '.migration-owner.json'), JSON.stringify({ pid: DEAD_PID, token: randomUUID() }));
    let recreated: Record<string, string> | undefined;
    const outcome = migrateLegacyState({
      legacy, target, waitMs: 200,
      // The first owner is gone. A second server takes its leftover over first and is now copying.
      isProcessAlive: pid => pid === peer,
      onStagingObserved: () => {
        if (recreated) return;
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(staging);
        writeFileSync(path.join(staging, '.migration-owner.json'), JSON.stringify({ pid: peer, token: randomUUID() }));
        writeFileSync(path.join(staging, 'partial.json'), '{}');
        recreated = tree(staging);
      },
    });
    assert.ok(recreated);
    assert.equal(outcome.status === 'blocked' && outcome.reason, 'legacy-state-busy');
    assert.match(outcome.status === 'blocked' ? outcome.detail : '', /4242/);
    assert.deepEqual(tree(staging), recreated, 'the staging root of the live server must survive');
    assert.equal(existsSync(target), false);
    assert.deepEqual(readdirSync(path.dirname(target)).filter(name => name.includes('.stale-')), []);
  } finally { cleanup(); }
});

test('a migration that another live server is running is waited for and never taken over', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    populate(legacy);
    const peer = 4242;
    mkdirSync(target + '.migrating');
    writeFileSync(path.join(target + '.migrating', '.migration-owner.json'), JSON.stringify({ pid: peer, token: randomUUID() }));
    writeFileSync(path.join(target + '.migrating', 'partial.json'), '{}');
    const staged = tree(target + '.migrating');
    const outcome = migrateLegacyState({ legacy, target, isProcessAlive: pid => pid === peer, waitMs: 300 });
    assert.equal(outcome.status === 'blocked' && outcome.reason, 'legacy-state-busy');
    assert.match(outcome.status === 'blocked' ? outcome.detail : '', /4242/);
    assert.deepEqual(tree(target + '.migrating'), staged);
    assert.equal(existsSync(target), false);
  } finally { cleanup(); }
});

test('a previous server that still owns an active task blocks the migration', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    populate(legacy);
    const taskId = saveTask(legacy, 'running', process.pid);
    const before = tree(legacy);
    // The real liveness probe is used here: the owner is this test process.
    const outcome = migrateLegacyState({ legacy, target });
    assert.equal(outcome.status === 'blocked' && outcome.reason, 'legacy-state-busy');
    const detail = outcome.status === 'blocked' ? outcome.detail : '';
    assert.equal(detail.includes(taskId) && detail.includes(String(process.pid)), true, detail);
    assert.deepEqual(tree(legacy), before);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(target + '.migrating'), false);

    // Once that server is gone the same root migrates, and the unfinished task is carried over for normal recovery.
    assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: () => false }).status, 'migrated');
    assert.equal(existsSync(path.join(target, taskId + '.json')), true);
  } finally { cleanup(); }
});

test('locks of the previous root block the migration while their owner lives or cannot be verified', () => {
  const cases: Array<{ name: string; file: string[]; content: string; alive: boolean }> = [
    { name: 'task lock', file: ['group-' + randomUUID() + '.lock'], content: JSON.stringify({ pid: 4242, token: randomUUID() }), alive: true },
    { name: 'recovery gate', file: ['copy-' + 'c'.repeat(64) + '.lock.recovery'], content: JSON.stringify({ pid: 4242, token: randomUUID() }), alive: true },
    { name: 'memory lock', file: ['project-memory', 'memory.lock'], content: JSON.stringify({ pid: 4242, token: randomUUID(), createdAt: new Date().toISOString() }), alive: true },
    { name: 'runtime preparation lock', file: ['windows-runtimes', '.portable-node-other.lock'], content: JSON.stringify({ v: 1, pid: 4242, nonce: randomUUID() }), alive: true },
    { name: 'unreadable lock', file: ['model-selection.lock'], content: 'not json', alive: false },
  ];
  for (const item of cases) {
    const { legacy, target, cleanup } = sandbox();
    try {
      populate(legacy);
      const lock = path.join(legacy, ...item.file);
      writeFileSync(lock, item.content);
      const before = tree(legacy);
      const outcome = migrateLegacyState({ legacy, target, isProcessAlive: pid => item.alive && pid === 4242 });
      assert.equal(outcome.status === 'blocked' && outcome.reason, 'legacy-state-busy', item.name);
      const detail = outcome.status === 'blocked' ? outcome.detail : '';
      assert.equal(detail.includes(lock), true, item.name + ': ' + detail);
      if (item.alive) assert.match(detail, /4242/, item.name);
      assert.deepEqual(tree(legacy), before, item.name);
      assert.equal(existsSync(target), false, item.name);
      assert.equal(existsSync(target + '.migrating'), false, item.name);
    } finally { cleanup(); }
  }
});

test('a Windows execution lease of the previous build blocks the migration', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    populate(legacy);
    const lease = path.join(legacy, 'windows-lpac-leases', randomUUID().replaceAll('-', '') + '.json');
    writeFileSync(lease, '{}');
    const outcome = migrateLegacyState({ legacy, target, isProcessAlive: dead });
    assert.equal(outcome.status === 'blocked' && outcome.reason, 'legacy-state-busy');
    assert.equal(outcome.status === 'blocked' && outcome.detail.includes(lease), true);
    assert.equal(existsSync(target), false);
  } finally { cleanup(); }
});

test('an explicit state directory is used as given and never migrates', () => {
  const { root, legacy, target, cleanup } = sandbox();
  try {
    populate(legacy);
    const before = tree(legacy);
    for (const explicit of [legacy, path.join(root, 'elsewhere')]) {
      const env = { BRIDGE_STATE_DIRECTORY: explicit };
      const config = loadConfig(env);
      assert.equal(migrateDefaultState(config, env, { home: root, isProcessAlive: dead }), config);
      assert.equal(config.stateDirectory, path.resolve(explicit));
    }
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(path.join(root, 'elsewhere')), false);
    assert.deepEqual(tree(legacy), before);

    // Naming the migrated root explicitly copies nothing either, and the root it came from stays protected.
    assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'migrated');
    const migrated = tree(target), env = { BRIDGE_STATE_DIRECTORY: target };
    const explicit = migrateDefaultState(loadConfig(env), env, { home: root, isProcessAlive: dead });
    assert.equal(explicit.stateDirectory, path.resolve(target));
    assert.equal(explicit.forbiddenDirectories.some(entry => path.resolve(entry) === path.resolve(legacy)), true);
    assert.deepEqual(tree(target), migrated);
    assert.deepEqual(tree(legacy), before);
  } finally { cleanup(); }
});

test('a migration that another server published while this one was validating the staged copy is recognized', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    populate(legacy);
    assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'migrated');
    const published = tree(target), staging = target + '.migrating';
    renameSync(target, staging);
    writeFileSync(path.join(staging, '.migration-owner.json'), JSON.stringify({ pid: DEAD_PID, token: randomUUID() }));
    const outcome = migrateLegacyState({
      legacy, target, isProcessAlive: dead,
      onStagedValidated: () => { rmSync(path.join(staging, '.migration-owner.json')); renameSync(staging, target); },
    });
    assert.equal(outcome.status, 'already-migrated');
    assert.deepEqual(tree(target), published);
    assert.deepEqual(readdirSync(path.dirname(target)).filter(name => name.includes('.migrating')), []);
  } finally { cleanup(); }
});

test('the default root migrates at startup, protects the previous root and reports a blocked migration', () => {
  const { root, legacy, target, cleanup } = sandbox();
  try {
    populate(legacy);
    const config = { ...loadConfig({}), stateDirectory: target };
    const lock = path.join(legacy, 'model-selection.lock');
    writeFileSync(lock, JSON.stringify({ pid: 4242, token: randomUUID() }));
    const lines: string[] = [];
    const blocked = migrateDefaultState(config, {}, { home: root, isProcessAlive: pid => pid === 4242, report: line => lines.push(line) });
    assert.equal(blocked.stateDirectoryInvalid, true);
    assert.deepEqual(blocked.configurationIssues[0], { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'legacy-state-busy' });
    assert.equal(lines.length === 1 && lines[0]!.includes(lock) && lines[0]!.includes('4242'), true, lines.join('\n'));
    assert.equal(existsSync(target), false);

    const migrated = migrateDefaultState(config, {}, { home: root, isProcessAlive: dead, report: line => lines.push(line) });
    assert.equal(migrated.stateDirectoryInvalid, undefined);
    assert.deepEqual(migrated.forbiddenDirectories, [path.resolve(legacy)]);
    assert.deepEqual(migrated.configurationIssues, config.configurationIssues);
    assert.equal(lines.length, 2);
    const again = migrateDefaultState(config, {}, { home: root, isProcessAlive: dead, report: line => lines.push(line) });
    assert.deepEqual(again.forbiddenDirectories, [path.resolve(legacy)]);
    assert.equal(lines.length, 2, 'an already migrated root is not reported again');
    assert.equal(loadConfig({}).stateDirectory, defaultStateDirectory());
    assert.equal(path.basename(defaultStateDirectory(root)), '.black-gravity');
    assert.equal(loadConfig({}).windowsNodeCacheDirectory, path.resolve(defaultStateDirectory(), 'windows-runtimes'));
  } finally { cleanup(); }
});

test('unfinished executions of the previous root are settled there before the migration is retried', async () => {
  const { root, legacy, target, cleanup } = sandbox();
  try {
    populate(legacy);
    const config = { ...loadConfig({}), stateDirectory: target };
    const lease = path.join(legacy, 'windows-lpac-leases', randomUUID().replaceAll('-', '') + '.json');
    writeFileSync(lease, '{}');
    const lines: string[] = [], settled: string[] = [];
    const options = { home: root, isProcessAlive: dead, report: (line: string) => lines.push(line) };

    const failed = await migrateDefaultStateSettling(config, {}, async directory => { settled.push(directory); throw new Error('helper unavailable'); }, options);
    assert.deepEqual(failed.configurationIssues[0], { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'legacy-state-busy' });
    assert.equal(lines.length === 2 && lines[0]!.includes(lease) && lines[1]!.includes('helper unavailable'), true, lines.join('\n'));
    assert.equal(existsSync(target), false);

    const kept = await migrateDefaultStateSettling(config, {}, async directory => { settled.push(directory); }, options);
    assert.equal(kept.stateDirectoryInvalid, true, 'a lease that survives the recovery still blocks');
    assert.equal(existsSync(target), false);

    const migrated = await migrateDefaultStateSettling(config, {}, async directory => { settled.push(directory); rmSync(lease); }, options);
    assert.equal(migrated.stateDirectoryInvalid, undefined);
    assert.deepEqual(settled, [legacy, legacy, legacy]);
    assert.equal(readMigrationMarker(target)!.source, path.resolve(legacy));

    await migrateDefaultStateSettling(config, {}, async () => { throw new Error('must not run again'); }, options);
    const explicit = { BRIDGE_STATE_DIRECTORY: legacy };
    await migrateDefaultStateSettling(loadConfig(explicit), explicit, async () => { throw new Error('an explicit root is never settled'); }, options);
  } finally { cleanup(); }
});

test('tasks carried over keep the copy names and the receipt root they were created with', () => {
  const { legacy, target, cleanup } = sandbox();
  try {
    mkdirSync(legacy, { recursive: true, mode: 0o700 });
    const identity = { mode: 'write' as const, nativeTools: ['finish' as const], mcpServers: [], catalogSha256: 'c'.repeat(64) };
    const agentPolicy = { ...identity, sha256: createHash('sha256').update(JSON.stringify(identity)).digest('hex') };
    const save = (directory: string, copyName: string, stateDirectory: string) => {
      const taskId = randomUUID(), workingDirectory = path.join(directory, 'project');
      const record: TaskRecord = { taskId, prompt: 'Migration fixture', workingDirectory, status: 'completed', createdAt: new Date().toISOString(), agentPolicy };
      new StateStore(directory).save({
        ownerPid: DEAD_PID, events: [], cursor: 0, options: { prompt: record.prompt, workingDirectory, agentPolicy }, record,
        project: {
          sourceDirectory: workingDirectory, copyDirectory: path.join(os.tmpdir(), copyName), gitDirectory: path.join(os.tmpdir(), copyName.replace('-copy-', '-baseline-')),
          baseline: new Map(), includedFiles: [], executionStateDirectory: stateDirectory,
          executionPolicy: {
            policy: agentPolicy, executionId: randomUUID(), receiptIdentity: { dev: '1', ino: '1' }, receiptPath: path.join(stateDirectory, 'execution-receipts', taskId + '.jsonl'),
            files: EXECUTION_POLICY_PATHS.map((file, index) => ({ path: file, sha256: String(index).repeat(64), bytes: 1 })), requiredNativePermissions: [],
          },
        },
      });
      return taskId;
    };
    const carried = save(legacy, 'agy-mcp-copy-fixture', legacy);
    assert.equal(migrateLegacyState({ legacy, target, isProcessAlive: dead }).status, 'migrated');
    const loaded = new StateStore(target).load();
    assert.deepEqual(loaded.map(task => task.record.taskId), [carried]);
    assert.equal(loaded[0]!.project!.executionStateDirectory, legacy);
    assert.equal(path.basename(loaded[0]!.project!.copyDirectory), 'agy-mcp-copy-fixture');

    // Only the recorded origin and the two historical prefixes are accepted, and only the origin of this very root.
    const elsewhere = path.join(path.dirname(legacy), 'elsewhere');
    mkdirSync(elsewhere);
    save(target, 'black-gravity-copy-fixture', elsewhere);
    assert.throws(() => new StateStore(target).load(), { code: 'INVALID_STATE' });
    const unrelated = path.join(path.dirname(legacy), 'unrelated');
    mkdirSync(unrelated);
    save(unrelated, 'agy-mcp-copy-fixture', unrelated);
    assert.equal(new StateStore(unrelated).load().length, 1);
    save(unrelated, 'agy-other-copy-fixture', unrelated);
    assert.throws(() => new StateStore(unrelated).load(), { code: 'INVALID_STATE' });
  } finally { cleanup(); }
});

async function withServer<T>(home: string, env: Record<string, string>, run: (client: Client, stderr: () => string) => Promise<T>): Promise<T> {
  const cwd = path.join(home, 'cwd');
  mkdirSync(cwd, { recursive: true });
  const base = { ...process.env as Record<string, string> };
  delete base.BRIDGE_STATE_DIRECTORY;
  const transport = new StdioClientTransport({
    command: process.execPath, args: [entryPath], cwd, stderr: 'pipe',
    // The native executor would start a recovery helper inside the fixture root and keep it busy during cleanup.
    env: { ...base, HOME: home, USERPROFILE: home, BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_TEST_EXECUTOR: 'agy', ...env },
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    return await run(client, () => stderr);
  } finally { await client.close().catch(() => undefined); }
}

async function listedTasks(client: Client): Promise<string[]> {
  const result = await client.callTool({ name: 'black_gravity_tasks', arguments: {} });
  return ((result.structuredContent as { tasks: Array<{ taskId: string }> }).tasks).map(task => task.taskId);
}

test('a server started on the default root migrates the previous root and serves its tasks', async () => {
  const { root, legacy, target, cleanup } = sandbox();
  try {
    const { taskId } = populate(legacy);
    const before = tree(legacy);
    await withServer(root, {}, async (client, stderr) => {
      const health = (await client.callTool({ name: 'black_gravity_health', arguments: {} })).structuredContent as { configurationIssues: unknown[]; waitCommand?: { argv: string[] } };
      assert.deepEqual(health.configurationIssues, []);
      assert.equal(health.waitCommand?.argv.includes(target), true);
      assert.deepEqual(await listedTasks(client), [taskId]);
      assert.match(stderr(), /Migrated \d+ state files/);
    });
    assert.deepEqual(tree(legacy), before);
    assert.deepEqual(readFileSync(path.join(target, taskId + '.json')), readFileSync(path.join(legacy, taskId + '.json')));
    assert.equal(readMigrationMarker(target)!.source, path.resolve(legacy));

    // A second start finds the marker, and a task added to the previous root afterwards stays there.
    const later = saveTask(legacy, 'completed', DEAD_PID);
    await withServer(root, {}, async (client, stderr) => {
      assert.deepEqual(await listedTasks(client), [taskId]);
      assert.equal(stderr().includes('Migrated'), false);
    });
    assert.equal(existsSync(path.join(target, later + '.json')), false);
  } finally { cleanup(); }
});

test('a server keeps the explicit previous root in use and creates no default root', async () => {
  const { root, legacy, target, cleanup } = sandbox();
  try {
    const { taskId } = populate(legacy);
    await withServer(root, { BRIDGE_STATE_DIRECTORY: legacy }, async client => {
      const health = (await client.callTool({ name: 'black_gravity_health', arguments: {} })).structuredContent as { configurationIssues: unknown[] };
      assert.deepEqual(health.configurationIssues, []);
      assert.deepEqual(await listedTasks(client), [taskId]);
    });
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(target + '.migrating'), false);
  } finally { cleanup(); }
});

test('a server refuses to start on the default root while a previous server is active, and says why', async () => {
  const { root, legacy, target, cleanup } = sandbox();
  try {
    populate(legacy);
    const active = saveTask(legacy, 'running', process.pid);
    const before = tree(legacy);
    await withServer(root, {}, async (client, stderr) => {
      const health = (await client.callTool({ name: 'black_gravity_health', arguments: {} })).structuredContent as { configurationIssues: unknown[]; waitCommand?: unknown };
      assert.deepEqual(health.configurationIssues, [{ variable: 'BRIDGE_STATE_DIRECTORY', reason: 'legacy-state-busy' }]);
      assert.equal(health.waitCommand, undefined);
      const listed = await client.callTool({ name: 'black_gravity_tasks', arguments: {} });
      assert.equal(listed.isError, true);
      assert.equal(stderr().includes(active) && stderr().includes(String(process.pid)) && stderr().includes('legacy-state-busy'), true, stderr());
    });
    assert.deepEqual(tree(legacy), before);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(target + '.migrating'), false);
  } finally { cleanup(); }
});
