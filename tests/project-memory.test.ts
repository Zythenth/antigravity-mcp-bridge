import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { existsSync, readFileSync, rmSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  ProjectMemoryStore,
  computeMemorySha256,
  computeProjectId,
  memorySnapshotSchema,
  memorySummarySchema,
} from '../src/project-memory.js';

async function safeCleanup(dir: string): Promise<void> {
  assert.ok(path.isAbsolute(dir), `Cleanup target must be absolute: ${dir}`);
  const resolved = path.resolve(dir);
  const tempRoot = path.resolve(os.tmpdir());
  assert.ok(
    path.relative(tempRoot, path.dirname(resolved)) === '' && path.basename(resolved).startsWith('pm-test-'),
    `Cleanup target must remain inside named temporary fixture: ${resolved}`
  );
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test('ProjectMemoryStore persists, reloads, and validates memory snapshots and summaries', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'pm-test-persist-'));
  const stateDir = path.join(tmpBase, 'state');
  const projDir = path.join(tmpBase, 'proj');

  try {
    await mkdir(projDir, { recursive: true });
    const store1 = new ProjectMemoryStore(stateDir);

    const snapshot = await store1.write(projDir, 'planner', {
      text: 'Architectural overview of system components',
      expectedSha256: null,
    });

    assert.equal(snapshot.specialist, 'planner');
    assert.equal(snapshot.text, 'Architectural overview of system components');
    assert.ok(/^[a-f0-9]{64}$/.test(snapshot.projectId));
    assert.equal(snapshot.projectId, computeProjectId(projDir));
    assert.ok(/^[a-f0-9]{64}$/.test(snapshot.sha256));
    assert.equal(snapshot.sha256, computeMemorySha256(snapshot.projectId, 'planner', snapshot.text));
    assert.ok(!Number.isNaN(Date.parse(snapshot.updatedAt)));

    // Verify snapshot strictly validates against contract schema
    const validatedSnapshot = memorySnapshotSchema.parse(snapshot);
    assert.deepEqual(validatedSnapshot, snapshot);

    // Verify canonical project path is NOT leaked into snapshot
    assert.ok(!JSON.stringify(snapshot).includes(projDir));

    // Reload with a new store instance pointing to the same state directory
    const store2 = new ProjectMemoryStore(stateDir);
    const loaded = await store2.read(projDir, 'planner');
    assert.ok(loaded);
    assert.deepEqual(loaded, snapshot);

    // List summaries
    const summaries = await store2.list(projDir);
    assert.equal(summaries.length, 1);
    const summary = summaries[0]!;
    assert.equal(summary.specialist, 'planner');
    assert.equal(summary.projectId, snapshot.projectId);
    assert.equal(summary.sha256, snapshot.sha256);
    assert.equal(summary.updatedAt, snapshot.updatedAt);
    assert.equal(summary.bytes, Buffer.byteLength(snapshot.text, 'utf8'));
    assert.equal('text' in summary, false);

    const validatedSummary = memorySummarySchema.parse(summary);
    assert.deepEqual(validatedSummary, summary);
  } finally {
    await safeCleanup(tmpBase);
  }
});

test('canonical aliases map to the exact same project identity', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'pm-test-aliases-'));
  const stateDir = path.join(tmpBase, 'state');
  const projDir = path.join(tmpBase, 'MyProject');

  try {
    await mkdir(projDir, { recursive: true });
    const store = new ProjectMemoryStore(stateDir);

    const snapshot = await store.write(projDir, 'implementer', {
      text: 'Baseline implementation details',
      expectedSha256: null,
    });

    if (process.platform === 'win32') {
      const lowerAlias = projDir.toLowerCase();
      const readLower = await store.read(lowerAlias, 'implementer');
      assert.ok(readLower);
      assert.equal(readLower.sha256, snapshot.sha256);
      assert.equal(readLower.projectId, snapshot.projectId);

      const upperAlias = projDir.toUpperCase();
      const readUpper = await store.read(upperAlias, 'implementer');
      assert.ok(readUpper);
      assert.equal(readUpper.sha256, snapshot.sha256);

      const forwardSlashAlias = projDir.replaceAll('\\', '/');
      const readForward = await store.read(forwardSlashAlias, 'implementer');
      assert.ok(readForward);
      assert.equal(readForward.sha256, snapshot.sha256);
    } else {
      const trailingSlashAlias = projDir + '/';
      const readTrailing = await store.read(trailingSlashAlias, 'implementer');
      assert.ok(readTrailing);
      assert.equal(readTrailing.sha256, snapshot.sha256);
    }
  } finally {
    await safeCleanup(tmpBase);
  }
});

test('separate projects and specialists are strictly isolated', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'pm-test-isolation-'));
  const stateDir = path.join(tmpBase, 'state');
  const projA = path.join(tmpBase, 'projA');
  const projB = path.join(tmpBase, 'projB');

  try {
    await mkdir(projA, { recursive: true });
    await mkdir(projB, { recursive: true });
    const store = new ProjectMemoryStore(stateDir);

    await store.write(projA, 'planner', { text: 'Plan for A', expectedSha256: null });
    await store.write(projA, 'reviewer', { text: 'Review for A', expectedSha256: null });
    await store.write(projB, 'planner', { text: 'Plan for B', expectedSha256: null });

    const memA_planner = await store.read(projA, 'planner');
    const memB_planner = await store.read(projB, 'planner');
    const memA_reviewer = await store.read(projA, 'reviewer');
    const memB_reviewer = await store.read(projB, 'reviewer');

    assert.equal(memA_planner?.text, 'Plan for A');
    assert.equal(memB_planner?.text, 'Plan for B');
    assert.notEqual(memA_planner?.projectId, memB_planner?.projectId);
    assert.equal(memA_reviewer?.text, 'Review for A');
    assert.equal(memB_reviewer, null);

    const listA = await store.list(projA);
    const listB = await store.list(projB);

    assert.equal(listA.length, 2);
    assert.deepEqual(listA.map(s => s.specialist), ['planner', 'reviewer']);
    assert.equal(listB.length, 1);
    assert.deepEqual(listB.map(s => s.specialist), ['planner']);
  } finally {
    await safeCleanup(tmpBase);
  }
});

test('CAS enforces atomic compare-and-swap on write and remove, rejecting stale and replayed mutations', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'pm-test-cas-'));
  const stateDir = path.join(tmpBase, 'state');
  const projDir = path.join(tmpBase, 'proj');

  try {
    await mkdir(projDir, { recursive: true });
    const store = new ProjectMemoryStore(stateDir);

    const first = await store.write(projDir, 'planner', { text: 'Version 1', expectedSha256: null });

    await assert.rejects(
      async () => store.write(projDir, 'planner', { text: 'Overwrite attempt', expectedSha256: null }),
      { code: 'MEMORY_CHANGED' }
    );

    const fakeHash = '0'.repeat(64);
    await assert.rejects(
      async () => store.write(projDir, 'planner', { text: 'Version 2 bad', expectedSha256: fakeHash }),
      { code: 'MEMORY_CHANGED' }
    );

    const second = await store.write(projDir, 'planner', { text: 'Version 2 updated', expectedSha256: first.sha256 });
    assert.notEqual(second.sha256, first.sha256);
    assert.equal(second.text, 'Version 2 updated');

    await assert.rejects(
      async () => store.write(projDir, 'planner', { text: 'Replay attempt', expectedSha256: first.sha256 }),
      { code: 'MEMORY_CHANGED' }
    );

    await assert.rejects(
      async () => store.remove(projDir, 'planner', first.sha256),
      { code: 'MEMORY_CHANGED' }
    );

    await assert.rejects(
      async () => store.remove(projDir, 'nonexistent', second.sha256),
      { code: 'MEMORY_CHANGED' }
    );

    const removalResult = await store.remove(projDir, 'planner', second.sha256);
    assert.deepEqual(removalResult, { removed: true });

    const postRemove = await store.read(projDir, 'planner');
    assert.equal(postRemove, null);

    await assert.rejects(
      async () => store.remove(projDir, 'planner', second.sha256),
      { code: 'MEMORY_CHANGED' }
    );
  } finally {
    await safeCleanup(tmpBase);
  }
});

test('global count, byte limits, and per-entry byte limits are strictly enforced across projects', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'pm-test-limits-'));
  const stateDir = path.join(tmpBase, 'state');
  const projA = path.join(tmpBase, 'projA');
  const projB = path.join(tmpBase, 'projB');

  try {
    await mkdir(projA, { recursive: true });
    await mkdir(projB, { recursive: true });

    const store = new ProjectMemoryStore(stateDir, {
      maxEntries: 2,
      maxBytes: 200,
      maxEntryBytes: 100,
    });

    const oversizedText = 'x'.repeat(101);
    await assert.rejects(
      async () => store.write(projA, 'planner', { text: oversizedText, expectedSha256: null }),
      { code: 'MEMORY_LIMIT_EXCEEDED' }
    );

    const snapA = await store.write(projA, 'planner', { text: 'a'.repeat(80), expectedSha256: null });
    const snapB = await store.write(projB, 'reviewer', { text: 'b'.repeat(80), expectedSha256: null });

    await assert.rejects(
      async () => store.write(projA, 'reviewer', { text: 'c'.repeat(10), expectedSha256: null }),
      { code: 'MEMORY_LIMIT_EXCEEDED' }
    );

    const updatedB = await store.write(projB, 'reviewer', { text: 'b'.repeat(90), expectedSha256: snapB.sha256 });
    assert.equal(updatedB.text.length, 90);

    const updatedA = await store.write(projA, 'planner', { text: 'a'.repeat(100), expectedSha256: snapA.sha256 });
    assert.equal(updatedA.text.length, 100);

    const tightBase = await mkdtemp(path.join(os.tmpdir(), 'pm-test-tight-'));
    try {
      const tightStore = new ProjectMemoryStore(tightBase, { maxEntries: 5, maxBytes: 150, maxEntryBytes: 100 });
      const snap1 = await tightStore.write(projA, 'planner', { text: '1'.repeat(80), expectedSha256: null });
      assert.equal(snap1.text.length, 80);
      assert.equal(snap1.specialist, 'planner');

      await assert.rejects(
        async () => tightStore.write(projB, 'planner', { text: '2'.repeat(80), expectedSha256: null }),
        { code: 'MEMORY_LIMIT_EXCEEDED' }
      );

      const snap2 = await tightStore.write(projB, 'planner', { text: '2'.repeat(60), expectedSha256: null });
      assert.equal(snap2.text.length, 60);

      await assert.rejects(
        async () => tightStore.write(projB, 'planner', { text: '2'.repeat(80), expectedSha256: snap2.sha256 }),
        { code: 'MEMORY_LIMIT_EXCEEDED' }
      );
    } finally {
      await safeCleanup(tightBase);
    }
  } finally {
    await safeCleanup(tmpBase);
  }
});

test('non-ASCII characters are accurately measured by UTF-8 byte length', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'pm-test-utf8-'));
  const stateDir = path.join(tmpBase, 'state');
  const projDir = path.join(tmpBase, 'proj');

  try {
    await mkdir(projDir, { recursive: true });
    const store = new ProjectMemoryStore(stateDir);

    const nonAsciiText = 'Unicode: 🚀🔥 — こんにちは世界 — áéíóú';
    const expectedByteLength = Buffer.byteLength(nonAsciiText, 'utf8');
    assert.ok(expectedByteLength > nonAsciiText.length);

    const snapshot = await store.write(projDir, 'planner', {
      text: nonAsciiText,
      expectedSha256: null,
    });
    assert.equal(snapshot.text, nonAsciiText);
    assert.equal(Buffer.byteLength(snapshot.text, 'utf8'), expectedByteLength);
    assert.equal(snapshot.sha256, computeMemorySha256(snapshot.projectId, 'planner', nonAsciiText));

    const summaries = await store.list(projDir);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.bytes, expectedByteLength);

    const tightStore = new ProjectMemoryStore(path.join(tmpBase, 'tight-state'), {
      maxEntries: 10,
      maxBytes: 1000,
      maxEntryBytes: 20,
    });
    await tightStore.write(projDir, 'emoji1', { text: '🚀🚀🚀🚀🚀', expectedSha256: null });
    await assert.rejects(
      async () => tightStore.write(projDir, 'emoji2', { text: '🚀🚀🚀🚀🚀🚀', expectedSha256: null }),
      { code: 'MEMORY_LIMIT_EXCEEDED' }
    );
  } finally {
    await safeCleanup(tmpBase);
  }
});

test('corrupted files, hash tampering, and scope mismatches throw INVALID_MEMORY_STATE', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'pm-test-tamper-'));
  const stateDir = path.join(tmpBase, 'state');
  const projDir = path.join(tmpBase, 'proj');

  try {
    await mkdir(projDir, { recursive: true });
    const store = new ProjectMemoryStore(stateDir);

    const snapshot = await store.write(projDir, 'planner', {
      text: 'Original valid content',
      expectedSha256: null,
    });

    const targetFile = path.join(stateDir, 'project-memory', snapshot.projectId, 'planner.json');

    // 1. Corrupt JSON syntax
    await writeFile(targetFile, 'INVALID JSON CONTENT {[');
    await assert.rejects(async () => store.read(projDir, 'planner'), { code: 'INVALID_MEMORY_STATE' });

    // 2. Tampered text without updating sha256
    const tamperedContent = {
      version: 1,
      projectId: snapshot.projectId,
      specialist: 'planner',
      text: 'TAMPERED TEXT CONTENT',
      sha256: snapshot.sha256,
      updatedAt: snapshot.updatedAt,
    };
    await writeFile(targetFile, JSON.stringify(tamperedContent));
    await assert.rejects(async () => store.read(projDir, 'planner'), { code: 'INVALID_MEMORY_STATE' });

    // 3. Tampered projectId (scope mismatch)
    const scopeTampered = {
      version: 1,
      projectId: 'f'.repeat(64),
      specialist: 'planner',
      text: 'Original valid content',
      sha256: computeMemorySha256('f'.repeat(64), 'planner', 'Original valid content'),
      updatedAt: snapshot.updatedAt,
    };
    await writeFile(targetFile, JSON.stringify(scopeTampered));
    await assert.rejects(async () => store.read(projDir, 'planner'), { code: 'INVALID_MEMORY_STATE' });

    // 4. Tampered specialist inside file (scope mismatch)
    const specialistTampered = {
      version: 1,
      projectId: snapshot.projectId,
      specialist: 'reviewer',
      text: 'Original valid content',
      sha256: computeMemorySha256(snapshot.projectId, 'reviewer', 'Original valid content'),
      updatedAt: snapshot.updatedAt,
    };
    await writeFile(targetFile, JSON.stringify(specialistTampered));
    await assert.rejects(async () => store.read(projDir, 'planner'), { code: 'INVALID_MEMORY_STATE' });

    // 5. Tampered version (e.g. version 2)
    const versionTampered = {
      version: 2,
      projectId: snapshot.projectId,
      specialist: 'planner',
      text: 'Original valid content',
      sha256: snapshot.sha256,
      updatedAt: snapshot.updatedAt,
    };
    await writeFile(targetFile, JSON.stringify(versionTampered));
    await assert.rejects(async () => store.read(projDir, 'planner'), { code: 'INVALID_MEMORY_STATE' });

    // 6. Zero-byte file
    await writeFile(targetFile, '');
    await assert.rejects(async () => store.read(projDir, 'planner'), { code: 'INVALID_MEMORY_STATE' });

    // 7. Unknown attack file in project memory directory causes list to fail closed
    const attackFile = path.join(stateDir, 'project-memory', snapshot.projectId, 'unknown.txt');
    await writeFile(attackFile, 'malicious entry');
    await assert.rejects(async () => store.list(projDir), { code: 'INVALID_MEMORY_STATE' });
  } finally {
    await safeCleanup(tmpBase);
  }
});

test('existing-state absence distinction: absent returns null, corrupted throws INVALID_MEMORY_STATE', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'pm-test-absence-'));
  const stateDir = path.join(tmpBase, 'state');
  const projDir = path.join(tmpBase, 'proj');

  try {
    await mkdir(projDir, { recursive: true });
    const store = new ProjectMemoryStore(stateDir);

    assert.equal(await store.read(projDir, 'planner'), null);
    assert.deepEqual(await store.list(projDir), []);

    const snapshot = await store.write(projDir, 'planner', { text: 'Some text', expectedSha256: null });

    assert.equal(await store.read(projDir, 'reviewer'), null);

    const targetFile = path.join(stateDir, 'project-memory', snapshot.projectId, 'planner.json');
    await writeFile(targetFile, '{ bad json');

    await assert.rejects(
      async () => store.read(projDir, 'planner'),
      { code: 'INVALID_MEMORY_STATE' }
    );
  } finally {
    await safeCleanup(tmpBase);
  }
});

test('root and path overlap checks reject volume roots and mutual containment', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'pm-test-overlap-'));
  const stateDir = path.join(tmpBase, 'state');
  const projDir = path.join(tmpBase, 'proj');

  try {
    await mkdir(projDir, { recursive: true });

    const volumeRoot = path.parse(path.resolve(tmpBase)).root;
    assert.throws(() => new ProjectMemoryStore(volumeRoot), { code: 'INVALID_STATE_DIRECTORY' });

    const store = new ProjectMemoryStore(stateDir);

    await assert.rejects(
      async () => store.read(volumeRoot, 'planner'),
      { code: 'INVALID_PROJECT_DIRECTORY' }
    );

    const nestedState = path.join(projDir, 'nested-state');
    const nestedStore = new ProjectMemoryStore(nestedState);
    await assert.rejects(
      async () => nestedStore.read(projDir, 'planner'),
      { code: 'INVALID_PROJECT_DIRECTORY' }
    );

    const nestedProject = path.join(stateDir, 'nested-proj');
    await mkdir(nestedProject, { recursive: true });
    await assert.rejects(
      async () => store.read(nestedProject, 'planner'),
      { code: 'INVALID_PROJECT_DIRECTORY' }
    );

    await assert.rejects(
      async () => store.read(stateDir, 'planner'),
      { code: 'INVALID_PROJECT_DIRECTORY' }
    );
  } finally {
    await safeCleanup(tmpBase);
  }
});

test('link and junction negatives reject unsafe paths', async (t) => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'pm-test-links-'));
  const stateDir = path.join(tmpBase, 'state');
  const projDir = path.join(tmpBase, 'proj');

  try {
    await mkdir(stateDir, { recursive: true });
    await mkdir(projDir, { recursive: true });
    const store = new ProjectMemoryStore(stateDir);

    // 1. Junction on Windows or directory symlink on POSIX for project directory
    const linkDir = path.join(tmpBase, 'proj-link');
    if (process.platform === 'win32') {
      await symlink(projDir, linkDir, 'junction');
    } else {
      await symlink(projDir, linkDir, 'dir');
    }

    await assert.rejects(
      async () => store.read(linkDir, 'planner'),
      { code: 'INVALID_PROJECT_DIRECTORY' }
    );
    await assert.rejects(
      async () => store.write(linkDir, 'planner', { text: 'content', expectedSha256: null }),
      { code: 'INVALID_PROJECT_DIRECTORY' }
    );

    // 2. State directory as link/junction
    const linkState = path.join(tmpBase, 'state-link');
    if (process.platform === 'win32') {
      await symlink(stateDir, linkState, 'junction');
    } else {
      await symlink(stateDir, linkState, 'dir');
    }

    assert.throws(
      () => new ProjectMemoryStore(linkState),
      { code: 'INVALID_STATE_DIRECTORY' }
    );

    // 3. Subtest testing unsupported file symlink
    await t.test('file symlink rejection or explicit skip if unsupported', async (subtest) => {
      const fileTarget = path.join(projDir, 'real-target.txt');
      await writeFile(fileTarget, 'sample');
      const fileLink = path.join(tmpBase, 'file-link.txt');
      try {
        await symlink(fileTarget, fileLink, 'file');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES') {
          subtest.skip('File symlinks require ungranted privileges/Developer Mode on Windows');
          return;
        }
        throw err;
      }
      assert.throws(
        () => new ProjectMemoryStore(fileLink),
        { code: 'INVALID_STATE_DIRECTORY' }
      );
    });
  } finally {
    await safeCleanup(tmpBase);
  }
});

test('unsafe specialist names, traversal, ADS, and Windows device names are rejected', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'pm-test-unsafe-'));
  const stateDir = path.join(tmpBase, 'state');
  const projDir = path.join(tmpBase, 'proj');

  try {
    await mkdir(projDir, { recursive: true });
    const store = new ProjectMemoryStore(stateDir);

    const invalidSpecialists = [
      '',
      '1planner',
      'Planner',
      'plan_ner',
      'plan/ner',
      '../escape',
      'planner.json',
      'a'.repeat(65),
    ];
    for (const spec of invalidSpecialists) {
      await assert.rejects(
        async () => store.read(projDir, spec),
        { code: 'INVALID_SPECIALIST' }
      );
    }

    const deviceNames = ['con', 'prn', 'aux', 'nul', 'com1', 'lpt1'];
    for (const dev of deviceNames) {
      await assert.rejects(
        async () => store.read(projDir, dev),
        { code: 'INVALID_SPECIALIST' }
      );
    }

    await assert.rejects(
      async () => store.write(projDir, 'planner', { text: 'hello\0world', expectedSha256: null }),
      { code: 'INVALID_MEMORY_INPUT' }
    );

    await assert.rejects(
      async () => store.write(projDir, 'planner', { text: '', expectedSha256: null }),
      { code: 'INVALID_MEMORY_INPUT' }
    );

    if (process.platform === 'win32') {
      const adsPath = projDir + ':stream';
      await assert.rejects(
        async () => store.read(adsPath, 'planner'),
        { code: 'INVALID_PROJECT_DIRECTORY' }
      );
    }
  } finally {
    await safeCleanup(tmpBase);
  }
});

test('concurrent store instances serialize operations and handle lock contention and recovery', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'pm-test-concurrency-'));
  const stateDir = path.join(tmpBase, 'state');
  const projDir = path.join(tmpBase, 'proj');

  try {
    await mkdir(projDir, { recursive: true });
    const store1 = new ProjectMemoryStore(stateDir);
    const store2 = new ProjectMemoryStore(stateDir);

    // Simulate an active lock file held by an alive process with valid UUID
    const lockFile = path.join(stateDir, 'project-memory', 'memory.lock');
    const aliveToken = randomUUID();
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: aliveToken, createdAt: new Date().toISOString() }));

    // Both store1 and store2 must fail with MEMORY_BUSY
    await assert.rejects(
      async () => store1.write(projDir, 'planner', { text: 'test', expectedSha256: null }),
      { code: 'MEMORY_BUSY' }
    );
    await assert.rejects(
      async () => store2.write(projDir, 'planner', { text: 'test', expectedSha256: null }),
      { code: 'MEMORY_BUSY' }
    );

    // Simulate a stale lock from a dead process with valid safe positive PID and UUID token
    const deadPid = 99999999;
    const deadToken = randomUUID();
    writeFileSync(lockFile, JSON.stringify({ pid: deadPid, token: deadToken, createdAt: new Date().toISOString() }));

    // Store recovers automatically from verified dead lock
    const snap = await store1.write(projDir, 'planner', { text: 'recovering', expectedSha256: null });
    assert.equal(snap.text, 'recovering');

    // Serialized read confirms content
    const readBack = await store2.read(projDir, 'planner');
    assert.ok(readBack);
    assert.equal(readBack.text, 'recovering');
  } finally {
    await safeCleanup(tmpBase);
  }
});

test('malformed, invalid, or corrupt locks fail MEMORY_BUSY without deletion', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'pm-test-malformed-lock-'));
  const stateDir = path.join(tmpBase, 'state');
  const projDir = path.join(tmpBase, 'proj');

  try {
    await mkdir(projDir, { recursive: true });
    const store = new ProjectMemoryStore(stateDir);
    const lockFile = path.join(stateDir, 'project-memory', 'memory.lock');

    // Case 1: Malformed JSON syntax
    const badJson = '{ malformed json [[[';
    writeFileSync(lockFile, badJson, 'utf8');

    await assert.rejects(
      async () => store.write(projDir, 'planner', { text: 'test text', expectedSha256: null }),
      { code: 'MEMORY_BUSY' }
    );
    // Malformed lock MUST stay intact without deletion
    assert.equal(existsSync(lockFile), true);
    assert.equal(readFileSync(lockFile, 'utf8'), badJson);

    // Case 2: Invalid lock data (non-positive PID)
    const invalidPid = JSON.stringify({ pid: -123, token: randomUUID() });
    writeFileSync(lockFile, invalidPid, 'utf8');

    await assert.rejects(
      async () => store.write(projDir, 'planner', { text: 'test text', expectedSha256: null }),
      { code: 'MEMORY_BUSY' }
    );
    assert.equal(existsSync(lockFile), true);
    assert.equal(readFileSync(lockFile, 'utf8'), invalidPid);

    // Case 3: Invalid lock data (invalid token format, not a UUID)
    const invalidToken = JSON.stringify({ pid: process.pid, token: 'not-a-valid-uuid' });
    writeFileSync(lockFile, invalidToken, 'utf8');

    await assert.rejects(
      async () => store.write(projDir, 'planner', { text: 'test text', expectedSha256: null }),
      { code: 'MEMORY_BUSY' }
    );
    assert.equal(existsSync(lockFile), true);
    assert.equal(readFileSync(lockFile, 'utf8'), invalidToken);

    // Case 4: Missing PID
    const missingPid = JSON.stringify({ token: randomUUID() });
    writeFileSync(lockFile, missingPid, 'utf8');

    await assert.rejects(
      async () => store.write(projDir, 'planner', { text: 'test text', expectedSha256: null }),
      { code: 'MEMORY_BUSY' }
    );
    assert.equal(existsSync(lockFile), true);
    assert.equal(readFileSync(lockFile, 'utf8'), missingPid);

    rmSync(lockFile, { force: true });
  } finally {
    await safeCleanup(tmpBase);
  }
});

test('storage ancestry checks reject root replacement by a junction or link during operations', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'pm-test-root-replace-'));
  const stateDir = path.join(tmpBase, 'state');
  const projDir = path.join(tmpBase, 'proj');
  const altDir = path.join(tmpBase, 'alt-state');

  try {
    await mkdir(projDir, { recursive: true });
    await mkdir(altDir, { recursive: true });
    const store = new ProjectMemoryStore(stateDir);

    await store.write(projDir, 'planner', { text: 'Initial memory', expectedSha256: null });

    // Simulate root replacement by a junction or directory link
    await rm(stateDir, { recursive: true, force: true });
    if (process.platform === 'win32') {
      await symlink(altDir, stateDir, 'junction');
    } else {
      await symlink(altDir, stateDir, 'dir');
    }

    await assert.rejects(
      async () => store.read(projDir, 'planner'),
      { code: 'INVALID_STATE_DIRECTORY' }
    );
    await assert.rejects(
      async () => store.list(projDir),
      { code: 'INVALID_STATE_DIRECTORY' }
    );
    await assert.rejects(
      async () => store.write(projDir, 'planner', { text: 'New memory', expectedSha256: null }),
      { code: 'INVALID_STATE_DIRECTORY' }
    );
  } finally {
    await safeCleanup(tmpBase);
  }
});

test('noncanonical content hashes and alternate hash formats are strictly rejected', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'pm-test-hash-format-'));
  const stateDir = path.join(tmpBase, 'state');
  const projDir = path.join(tmpBase, 'proj');

  try {
    await mkdir(projDir, { recursive: true });
    const store = new ProjectMemoryStore(stateDir);

    const snapshot = await store.write(projDir, 'planner', {
      text: 'Valid text content',
      expectedSha256: null,
    });

    const targetFile = path.join(stateDir, 'project-memory', snapshot.projectId, 'planner.json');

    // 1. Alternate format 1: version1:projectId:specialist:text
    const altHash1 = createHash('sha256')
      .update(`version1:${snapshot.projectId}:planner:Valid text content`)
      .digest('hex');
    const recordAlt1 = {
      version: 1,
      projectId: snapshot.projectId,
      specialist: 'planner',
      text: 'Valid text content',
      sha256: altHash1,
      updatedAt: snapshot.updatedAt,
    };
    await writeFile(targetFile, JSON.stringify(recordAlt1, null, 2));

    await assert.rejects(
      async () => store.read(projDir, 'planner'),
      { code: 'INVALID_MEMORY_STATE' }
    );
    await assert.rejects(
      async () => store.list(projDir),
      { code: 'INVALID_MEMORY_STATE' }
    );

    // 2. Alternate format 2: version1,projectId,specialist,text
    const altHash2 = createHash('sha256')
      .update(`version1,${snapshot.projectId},planner,Valid text content`)
      .digest('hex');
    const recordAlt2 = {
      version: 1,
      projectId: snapshot.projectId,
      specialist: 'planner',
      text: 'Valid text content',
      sha256: altHash2,
      updatedAt: snapshot.updatedAt,
    };
    await writeFile(targetFile, JSON.stringify(recordAlt2, null, 2));

    await assert.rejects(
      async () => store.read(projDir, 'planner'),
      { code: 'INVALID_MEMORY_STATE' }
    );
    await assert.rejects(
      async () => store.list(projDir),
      { code: 'INVALID_MEMORY_STATE' }
    );
  } finally {
    await safeCleanup(tmpBase);
  }
});

test('dangling links and inaccessible storage do not become absence', async (t) => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'pm-test-dangling-'));
  const stateDir = path.join(tmpBase, 'state');
  const projDir = path.join(tmpBase, 'proj');

  try {
    await mkdir(projDir, { recursive: true });
    const store = new ProjectMemoryStore(stateDir);
    const projectId = computeProjectId(projDir);
    const projectMemoryDir = path.join(stateDir, 'project-memory', projectId);
    await mkdir(projectMemoryDir, { recursive: true });

    // Create a dangling link in place of specialist.json
    const nonExistentTarget = path.join(tmpBase, 'non-existent-target.json');
    const targetFile = path.join(projectMemoryDir, 'planner.json');

    let linkCreated = false;
    try {
      if (process.platform === 'win32') {
        await symlink(nonExistentTarget, targetFile, 'file');
        linkCreated = true;
      } else {
        await symlink(nonExistentTarget, targetFile, 'file');
        linkCreated = true;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES') throw err;
    }

    if (!linkCreated) { t.skip("Creating file symlinks requires an unavailable OS permission"); return; }
    if (linkCreated) {
      await assert.rejects(
        async () => store.read(projDir, 'planner'),
        { code: 'INVALID_MEMORY_STATE' }
      );
      await assert.rejects(
        async () => store.list(projDir),
        { code: 'INVALID_MEMORY_STATE' }
      );
    }
  } finally {
    await safeCleanup(tmpBase);
  }
});


test('escaped text at the full UTF8 entry limit remains readable after persistence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pm-test-escaped-'));
  try { const project = path.join(root, 'project'); await mkdir(project); const store = new ProjectMemoryStore(path.join(root, 'state')); const text = String.fromCharCode(1).repeat(65536); const snapshot = await store.write(project, 'planner', { text, expectedSha256: null }); assert.deepEqual(await store.read(project, 'planner'), snapshot); }
  finally { await safeCleanup(root); }
});
test('a regular replacement of the memory storage directory cannot masquerade as absence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pm-test-root-identity-'));
  try { const project = path.join(root, 'project'), state = path.join(root, 'state'); await mkdir(project); const store = new ProjectMemoryStore(state); await store.write(project, 'planner', { text: 'preserved', expectedSha256: null }); const directory = path.join(state, 'project-memory'); renameSync(directory, directory + '.original'); mkdirSync(directory); await assert.rejects(store.read(project, 'planner'), { code: 'INVALID_STATE_DIRECTORY' }); }
  finally { await safeCleanup(root); }
});
test('a project memory junction cannot redirect removal into another directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pm-test-project-junction-'));
  try { const project = path.join(root, 'project'), state = path.join(root, 'state'); await mkdir(project); const store = new ProjectMemoryStore(state); const entry = await store.write(project, 'planner', { text: 'preserve outside file', expectedSha256: null }); const directory = path.join(state, 'project-memory', entry.projectId), outside = path.join(root, 'outside'); renameSync(directory, outside); await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(store.remove(project, 'planner', entry.sha256), { code: 'INVALID_MEMORY_STATE' }); assert.ok(existsSync(path.join(outside, 'planner.json'))); }
  finally { await safeCleanup(root); }
});
test('a replaced lock with copied ownership JSON is not deleted by release', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pm-test-lock-inode-'));
  try { const store = new ProjectMemoryStore(path.join(root, 'state')), release = (store as unknown as { acquireLock(): () => void }).acquireLock(), file = path.join(root, 'state', 'project-memory', 'memory.lock'), content = readFileSync(file, 'utf8'); renameSync(file, file + '.original'); writeFileSync(file, content); assert.throws(release, { code: 'MEMORY_BUSY' }); assert.equal(readFileSync(file, 'utf8'), content); }
  finally { await safeCleanup(root); }
});


test('concurrent stale-lock recovery cannot remove a new writer lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pm-test-recovery-race-'));
  const children: ReturnType<typeof spawn>[] = [];
  const results: Array<Promise<{ status: string; code?: string }>> = [];
  const worker = String.raw`
    import fs from 'node:fs';import path from 'node:path';import{syncBuiltinESMExports}from'node:module';
    const [mode,root,moduleUrl]=process.argv.slice(1),state=path.join(root,'state'),primary=path.join(state,'project-memory','memory.lock');
    const write=fs.writeFileSync,remove=fs.rmSync;let paused=false;
    const pause=(ready,go)=>{write(path.join(root,ready),'1');const deadline=Date.now()+10000;while(!fs.existsSync(path.join(root,go))){if(Date.now()>deadline)throw Error('Fixture barrier expired');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}};
    if(mode==='b')fs.rmSync=(file,...args)=>{if(file===primary&&!paused){paused=true;pause('b-ready','b-go');}return remove(file,...args);};
    if(mode==='a')fs.writeFileSync=(file,...args)=>{if(typeof file==='string'&&file.endsWith('.tmp')&&!paused){paused=true;pause('a-ready','a-go');}return write(file,...args);};
    syncBuiltinESMExports();const{ProjectMemoryStore}=await import(moduleUrl);
    try{await new ProjectMemoryStore(state).write(path.join(root,'project'),'planner',{text:'writer-'+mode,expectedSha256:null});console.log(JSON.stringify({status:'success'}));}catch(error){console.log(JSON.stringify({status:'failed',code:error.code??'FIXTURE_ERROR'}));}
  `;
  const launch = (mode: string) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, mode, root, new URL('../src/project-memory.js', import.meta.url).href], { windowsHide: true }); children.push(child);
    const result = new Promise<{ status: string; code?: string }>((resolve, reject) => { let output = '', errors = ''; child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { errors += chunk; }); child.once('error', reject); child.once('close', code => { try { assert.equal(code, 0, errors); resolve(JSON.parse(output.trim())); } catch (error) { reject(error); } }); }); results.push(result); return result;
  };
  const waitFor = async (predicate: () => boolean) => { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw Error('Fixture signal timed out'); await delay(10); } };
  try {
    const project = path.join(root, 'project'), state = path.join(root, 'state'); await mkdir(project);
    const store = new ProjectMemoryStore(state); const primary = path.join(state, 'project-memory', 'memory.lock');
    writeFileSync(primary, JSON.stringify({ pid: 99999999, token: randomUUID(), createdAt: new Date().toISOString() }));
    const b = launch('b'); await waitFor(() => existsSync(path.join(root, 'b-ready')));
    let aDone = false; const a = launch('a').then(value => { aDone = true; return value; });
    await waitFor(() => aDone || existsSync(path.join(root, 'a-ready')));
    if (aDone) { assert.deepEqual(await a, { status: 'failed', code: 'MEMORY_BUSY' }); writeFileSync(path.join(root, 'b-go'), '1'); assert.equal((await b).status, 'success'); }
    else { writeFileSync(path.join(root, 'b-go'), '1'); const observed = await b; writeFileSync(path.join(root, 'a-go'), '1'); await a; assert.equal(observed.code, 'MEMORY_BUSY', 'A recovering contender removed another live writer lock'); }
    assert.equal((await store.read(project, 'planner'))!.text, 'writer-b');
  } finally {
    writeFileSync(path.join(root, 'a-go'), '1'); writeFileSync(path.join(root, 'b-go'), '1');
    await Promise.allSettled(results); for (const child of children) if (child.exitCode === null) child.kill();
    await safeCleanup(root);
  }
});
