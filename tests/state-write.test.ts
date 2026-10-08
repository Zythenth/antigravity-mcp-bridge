import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateStore, type StoredTask } from '../src/state-store.js';
import { sandboxPolicyDigest } from '../src/sandbox-policy.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-state-write-test-'));
  const state = new StateStore(directory);
  const taskId = randomUUID();
  const snapshot: StoredTask = { ownerPid: process.pid, events: [], cursor: 0,
    record: { taskId, workingDirectory: directory, prompt: 'fixture', status: 'queued', createdAt: new Date().toISOString() },
    options: { workingDirectory: directory, prompt: 'fixture' } };
  return { directory, state, snapshot, close() {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !relative.includes(path.sep) && relative.startsWith('agy-state-write-test-'));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`atomic task state survives a transient Windows ${code} and remains readable`, { skip: process.platform !== 'win32' }, () => {
    const f = fixture();
    const rename = fs.renameSync;
    let calls = 0;
    try {
      f.state.save(f.snapshot);
      const oldBytes = fs.readFileSync(path.join(f.directory, f.snapshot.record.taskId + '.json'));
      const mocked = mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
        calls++;
        if (calls === 1) {
          assert.deepEqual(fs.readFileSync(target), oldBytes);
          throw Object.assign(new Error('transient fixture'), { code });
        }
        rename(source, target);
      });
      syncBuiltinESMExports();
      f.snapshot.record.status = 'completed';
      f.state.save(f.snapshot);
      assert.equal(f.state.load()[0]!.record.status, 'completed');
      assert.equal(calls, 2);
      assert.deepEqual(fs.readdirSync(f.directory), [f.snapshot.record.taskId + '.json']);
      mocked.mock.restore();
    } finally { mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
  });
}

test('permanent replacement failure preserves the last valid state and propagates the error', () => {
  const f = fixture();
  try {
    f.state.save(f.snapshot);
    const oldBytes = fs.readFileSync(path.join(f.directory, f.snapshot.record.taskId + '.json'));
    let calls = 0;
    mock.method(fs, 'renameSync', () => { calls++; throw Object.assign(new Error('permanent fixture'), { code: 'EPERM' }); });
    syncBuiltinESMExports();
    f.snapshot.record.status = 'completed';
    assert.throws(() => f.state.save(f.snapshot), { code: 'EPERM' });
    assert.equal(calls, process.platform === 'win32' ? 6 : 1);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, f.snapshot.record.taskId + '.json')), oldBytes);
    assert.equal(f.state.load()[0]!.record.status, 'queued');
    assert.deepEqual(fs.readdirSync(f.directory), [f.snapshot.record.taskId + '.json']);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});

test('non-transient errors are propagated without retry or state replacement', () => {
  const f = fixture();
  try {
    f.state.saveModel('mock-pro');
    let calls = 0;
    mock.method(fs, 'renameSync', () => { calls++; throw Object.assign(new Error('io fixture'), { code: 'EIO' }); });
    syncBuiltinESMExports();
    assert.throws(() => f.state.saveModel(null), { code: 'EIO' });
    assert.equal(calls, 1);
    assert.equal(f.state.loadModel()?.model, 'mock-pro');
    assert.deepEqual(fs.readdirSync(f.directory), ['model-selection.json']);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});

test('model and sandbox policy snapshots share the bounded atomic replacement', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  const rename = fs.renameSync;
  const seen = new Set<string>();
  try {
    mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
      const key = String(target);
      if (!seen.has(key)) { seen.add(key); throw Object.assign(new Error('sharing fixture'), { code: 'EBUSY' }); }
      rename(source, target);
    });
    syncBuiltinESMExports();
    f.state.saveModel('mock-pro');
    const policy = f.state.loadSandboxPolicy();
    f.state.saveSandboxPolicy(policy);
    assert.equal(f.state.loadModel()?.model, 'mock-pro');
    assert.equal(f.state.loadSandboxPolicy().sha256, sandboxPolicyDigest(policy.policy));
    assert.equal(seen.size, 2);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});
