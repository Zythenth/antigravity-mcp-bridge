import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { CliAdapter } from '../src/cli-adapter.js';
import { loadConfig } from '../src/config.js';
import { TaskManager } from '../src/task-manager.js';

interface EventRecord {
  type?: string;
  timestamp?: string | number;
  sequence?: number;
  [key: string]: unknown;
}

interface MessageRecord {
  messageId?: string;
  timestamp?: string | number;
  [key: string]: unknown;
}

interface TaskRecord {
  taskId?: string;
  status?: string;
  completedAt?: string | number;
  messageCursor?: number;
  messages?: MessageRecord[];
  error?: { code?: string; [key: string]: unknown };
  inbox?: Array<{ receipt?: { state?: string }; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface Snapshot {
  version?: number;
  ownerPid?: number;
  redacted?: boolean;
  record?: TaskRecord;
  options?: Record<string, unknown>;
  events?: EventRecord[];
  cursor?: number;
  project?: Record<string, unknown>;
  [key: string]: unknown;
}

interface FixtureSpec {
  taskId: string;
  createdAt: string;
  ownerPid?: number;
  omitRedacted?: boolean;
  record?: Record<string, unknown>;
  options?: Record<string, unknown>;
  events?: EventRecord[];
  cursor?: number;
  project?: Record<string, unknown>;
}

const DEAD_PID = 99999999;
const INBOX_MESSAGE_ID = '66666666-6666-4666-8666-666666666666';
const SNAPSHOT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
const FIXTURE_CWD = path.join(os.tmpdir(), 'black-gravity-restart-fixture-cwd');
const FIXTURE_PROJECT = {
  sourceDirectory: FIXTURE_CWD,
  copyDirectory: path.join(os.tmpdir(), 'black-gravity-copy-restart-fixture'),
  gitDirectory: path.join(os.tmpdir(), 'black-gravity-baseline-restart-fixture'),
  baseline: [],
  includedFiles: [],
};

const TASK_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
] as const;

function interruptedFixture(taskId: string, createdAt: string, extra?: Partial<FixtureSpec>): FixtureSpec {
  return {
    taskId,
    createdAt,
    ownerPid: DEAD_PID,
    record: {
      status: 'running',
    },
    ...extra,
  };
}

function terminalFixture(taskId: string, createdAt: string, completedAt: string, extra?: Partial<FixtureSpec>): FixtureSpec {
  return {
    taskId,
    createdAt,
    ownerPid: DEAD_PID,
    record: {
      status: 'completed',
      completedAt,
    },
    ...extra,
  };
}

function orphanFixture(taskId: string, createdAt: string, extra?: Partial<FixtureSpec>): FixtureSpec {
  return {
    taskId,
    createdAt,
    ownerPid: DEAD_PID,
    record: {
      status: 'running',
      pid: process.pid,
    },
    ...extra,
  };
}

function writeSnapshot(dir: string, fixture: FixtureSpec): string {
  const filePath = path.join(dir, `${fixture.taskId}.json`);
  const snapshot: Record<string, unknown> = {
    version: 1,
    ownerPid: fixture.ownerPid ?? DEAD_PID,
  };
  if (!fixture.omitRedacted) {
    snapshot.redacted = true;
  }
  snapshot.record = {
    taskId: fixture.taskId,
    workingDirectory: FIXTURE_CWD,
    prompt: 'test',
    status: 'running',
    createdAt: fixture.createdAt,
    ...fixture.record,
  };
  snapshot.options = {
    prompt: 'test',
    workingDirectory: FIXTURE_CWD,
    ...fixture.options,
  };
  snapshot.events = fixture.events ?? [];
  snapshot.cursor = fixture.cursor ?? 0;
  if (fixture.project) {
    snapshot.project = fixture.project;
  }
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
  return filePath;
}

function snapshotOf(dir: string, id: string): Snapshot {
  return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')) as Snapshot;
}

function createManager(stateDir: string): TaskManager {
  const config = loadConfig({
    BRIDGE_ANTI_AI_CRAFT: 'off',
    AGY_PATH: process.execPath,
    BRIDGE_TEST_EXECUTOR: 'agy',
    BRIDGE_STATE_DIRECTORY: stateDir,
  });
  return new TaskManager(new CliAdapter(config), config);
}

function read(dir: string): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  for (const entry of fs.readdirSync(dir).sort()) {
    if (SNAPSHOT_NAME.test(entry)) {
      const taskId = path.basename(entry, '.json');
      result.set(taskId, fs.readFileSync(path.join(dir, entry)));
    }
  }
  return result;
}

function normalized(dir: string): Map<string, Snapshot> {
  const result = new Map<string, Snapshot>();
  for (const [taskId, buffer] of read(dir)) {
    const parsed = JSON.parse(buffer.toString('utf8')) as Snapshot;
    if (parsed.record && typeof parsed.record === 'object') {
      delete parsed.record.completedAt;
      const messages = parsed.record.messages;
      if (Array.isArray(messages)) {
        for (const msg of messages) {
          if (msg && typeof msg === 'object') {
            delete msg.messageId;
            delete msg.timestamp;
          }
        }
      }
    }
    if (Array.isArray(parsed.events)) {
      for (const ev of parsed.events) {
        if (ev && typeof ev === 'object') {
          delete ev.timestamp;
        }
      }
    }
    result.set(taskId, parsed);
  }
  return result;
}

async function control(fixtures: readonly FixtureSpec[]): Promise<Map<string, Snapshot>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'black-gravity-restart-'));
  try {
    for (const f of fixtures) {
      writeSnapshot(dir, f);
    }
    const manager = createManager(dir);
    await manager.shutdown();
    return normalized(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function failRenameOf(t: TestContext, taskId: string): () => void {
  const original = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', ((from: fs.PathLike, to: fs.PathLike) => {
    if (path.basename(String(to)) === `${taskId}.json`) {
      const error = new Error('injected');
      Object.assign(error, { code: 'EIO' });
      throw error;
    }
    return original(from, to);
  }) as typeof fs.renameSync);
  syncBuiltinESMExports();

  let restored = false;
  return () => {
    if (!restored) {
      restored = true;
      mock.mock.restore();
      syncBuiltinESMExports();
    }
  };
}

function taskFailedLogs(t: TestContext): { count: () => number; restore: () => void } {
  let output = '';
  const mock = t.mock.method(process.stderr, 'write', ((chunk: string | Uint8Array, ...args: unknown[]) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const callback = args.find((arg): arg is (err?: Error) => void => typeof arg === 'function');
    if (callback) {
      callback();
    }
    return true;
  }) as typeof process.stderr.write);

  let restored = false;
  return {
    count: () => output.split('\n').filter(line => line.includes('"type":"task.failed"')).length,
    restore: () => {
      if (!restored) {
        restored = true;
        mock.mock.restore();
        syncBuiltinESMExports();
      }
    },
  };
}

function noTemporaries(dir: string): void {
  const tmpFiles = fs.readdirSync(dir).filter(entry => entry.endsWith('.tmp'));
  assert.equal(tmpFiles.length, 0, `Expected no .tmp files, found: ${tmpFiles.join(', ')}`);
}

async function cleanupDir(dir: string, managers: TaskManager[]): Promise<void> {
  for (const m of managers) {
    try {
      await m.shutdown();
    } catch {
      // ignore
    }
  }
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) {
        const fullPath = path.join(dir, entry.name);
        try {
          fs.chmodSync(fullPath, 0o666);
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test('normal startup transitions interrupted tasks, preserves terminal and orphan tasks, and logs task.failed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'black-gravity-restart-'));
  const managers: TaskManager[] = [];
  try {
    const fixtures: FixtureSpec[] = [
      interruptedFixture(TASK_IDS[0], '2026-01-01T00:00:01.000Z'),
      interruptedFixture(TASK_IDS[1], '2026-01-01T00:00:02.000Z'),
      interruptedFixture(TASK_IDS[2], '2026-01-01T00:00:03.000Z'),
      terminalFixture(TASK_IDS[3], '2026-01-01T00:00:04.000Z', '2026-01-01T00:00:05.000Z'),
      orphanFixture(TASK_IDS[4], '2026-01-01T00:00:06.000Z'),
    ];
    for (const f of fixtures) {
      writeSnapshot(dir, f);
    }

    const beforeBytes = read(dir);
    const logs = taskFailedLogs(t);

    const manager1 = createManager(dir);
    managers.push(manager1);
    assert.equal(manager1.isStateDirectoryUsable(), true);
    await manager1.shutdown();

    const afterBytes = read(dir);
    assert.ok(beforeBytes.has(TASK_IDS[3]));
    assert.ok(beforeBytes.has(TASK_IDS[4]));
    assert.deepEqual(afterBytes.get(TASK_IDS[3]), beforeBytes.get(TASK_IDS[3]));
    assert.deepEqual(afterBytes.get(TASK_IDS[4]), beforeBytes.get(TASK_IDS[4]));

    for (const id of [TASK_IDS[0], TASK_IDS[1], TASK_IDS[2]]) {
      const snap = snapshotOf(dir, id);
      const record = snap.record;
      const error = record?.error;
      assert.equal(record?.status, 'failed');
      assert.equal(error?.code, 'SERVER_RESTARTED');
      assert.equal(snap.ownerPid, process.pid);
      assert.equal(snap.cursor, 1);
      const messageCursor = record?.messageCursor;
      assert.equal(messageCursor, 1);

      const events = snap.events ?? [];
      const failedEvents = events.filter(e => e.type === 'task.failed');
      assert.equal(failedEvents.length, 1);
    }

    assert.equal(logs.count(), 3);
    noTemporaries(dir);

    const beforeSecond = read(dir);
    const manager2 = createManager(dir);
    managers.push(manager2);
    assert.equal(manager2.isStateDirectoryUsable(), true);
    await manager2.shutdown();

    const afterSecond = read(dir);
    assert.deepEqual(afterSecond, beforeSecond);
  } finally {
    await cleanupDir(dir, managers);
  }
});

test('windows acl write denial degrades startup without mutation or logs, recovering after acl removal', { skip: process.platform !== 'win32' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'black-gravity-restart-'));
  const managers: TaskManager[] = [];
  const middleId = TASK_IDS[1];
  const file = path.join(dir, `${middleId}.json`);
  let user = '';
  try {
    user = execFileSync('whoami', { encoding: 'utf8' }).trim();
    const fixtures: FixtureSpec[] = [
      interruptedFixture(TASK_IDS[0], '2026-01-01T00:00:01.000Z'),
      interruptedFixture(TASK_IDS[1], '2026-01-01T00:00:02.000Z'),
      interruptedFixture(TASK_IDS[2], '2026-01-01T00:00:03.000Z'),
    ];
    for (const f of fixtures) {
      writeSnapshot(dir, f);
    }

    // (W) would also deny SYNCHRONIZE and block reading, so loading would fail before the publication phase under test.
    execFileSync('icacls', [file, '/deny', `${user}:(WD)`]);
    const beforeBytes = read(dir);
    const logs = taskFailedLogs(t);

    const manager1 = createManager(dir);
    managers.push(manager1);
    assert.equal(manager1.isStateDirectoryUsable(), false);
    assert.deepEqual(manager1.configurationIssues, [{ variable: 'BRIDGE_STATE_DIRECTORY', reason: 'unusable' }]);
    await manager1.shutdown();

    const afterBytes = read(dir);
    assert.deepEqual(afterBytes, beforeBytes);
    noTemporaries(dir);
    assert.equal(logs.count(), 0);

    logs.restore();
    execFileSync('icacls', [file, '/remove:d', user]);

    const manager2 = createManager(dir);
    managers.push(manager2);
    assert.equal(manager2.isStateDirectoryUsable(), true);
    await manager2.shutdown();

    assert.deepEqual(normalized(dir), await control(fixtures));
  } finally {
    if (user && process.platform === 'win32') {
      try {
        execFileSync('icacls', [file, '/remove:d', user]);
      } catch {
        // ignore
      }
    }
    await cleanupDir(dir, managers);
  }
});

test('read-only file mode degrades startup without mutation or logs, recovering after chmod', { skip: process.getuid?.() === 0 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'black-gravity-restart-'));
  const managers: TaskManager[] = [];
  const middleId = TASK_IDS[1];
  const file = path.join(dir, `${middleId}.json`);
  try {
    const fixtures: FixtureSpec[] = [
      interruptedFixture(TASK_IDS[0], '2026-01-01T00:00:01.000Z'),
      interruptedFixture(TASK_IDS[1], '2026-01-01T00:00:02.000Z'),
      interruptedFixture(TASK_IDS[2], '2026-01-01T00:00:03.000Z'),
    ];
    for (const f of fixtures) {
      writeSnapshot(dir, f);
    }

    fs.chmodSync(file, 0o444);
    const beforeBytes = read(dir);
    const logs = taskFailedLogs(t);

    const manager1 = createManager(dir);
    managers.push(manager1);
    assert.equal(manager1.isStateDirectoryUsable(), false);
    assert.deepEqual(manager1.configurationIssues, [{ variable: 'BRIDGE_STATE_DIRECTORY', reason: 'unusable' }]);
    await manager1.shutdown();

    const afterBytes = read(dir);
    assert.deepEqual(afterBytes, beforeBytes);
    noTemporaries(dir);
    assert.equal(logs.count(), 0);

    logs.restore();
    fs.chmodSync(file, 0o644);

    const manager2 = createManager(dir);
    managers.push(manager2);
    assert.equal(manager2.isStateDirectoryUsable(), true);
    await manager2.shutdown();

    assert.deepEqual(normalized(dir), await control(fixtures));
  } finally {
    try {
      fs.chmodSync(file, 0o644);
    } catch {
      // ignore
    }
    await cleanupDir(dir, managers);
  }
});

test('rename failure in the middle yields partial result, next startup reaches control state', async t => {
  for (const omitRedacted of [false, true]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'black-gravity-restart-'));
    const managers: TaskManager[] = [];
    const middleId = TASK_IDS[1];
    let restoreRename = () => {};
    try {
      const fixtures: FixtureSpec[] = [
        interruptedFixture(TASK_IDS[0], '2026-01-01T00:00:01.000Z', { omitRedacted }),
        interruptedFixture(TASK_IDS[1], '2026-01-01T00:00:02.000Z', { omitRedacted }),
        interruptedFixture(TASK_IDS[2], '2026-01-01T00:00:03.000Z', { omitRedacted }),
      ];
      for (const f of fixtures) {
        writeSnapshot(dir, f);
      }

      restoreRename = failRenameOf(t, middleId);
      const beforeBytes = read(dir);
      const logs = taskFailedLogs(t);

      const manager1 = createManager(dir);
      managers.push(manager1);
      assert.equal(manager1.isStateDirectoryUsable(), false);
      assert.deepEqual(manager1.configurationIssues, [{ variable: 'BRIDGE_STATE_DIRECTORY', reason: 'unusable' }]);
      await manager1.shutdown();

      const snap1 = snapshotOf(dir, TASK_IDS[0]);
      assert.equal(snap1.record?.status, 'failed');

      const midBytes = read(dir);
      assert.deepEqual(midBytes.get(TASK_IDS[1]), beforeBytes.get(TASK_IDS[1]));
      assert.deepEqual(midBytes.get(TASK_IDS[2]), beforeBytes.get(TASK_IDS[2]));
      noTemporaries(dir);
      assert.equal(logs.count(), 1);

      restoreRename();

      const manager2 = createManager(dir);
      managers.push(manager2);
      assert.equal(manager2.isStateDirectoryUsable(), true);
      await manager2.shutdown();

      assert.equal(logs.count(), 3);
      logs.restore();

      assert.deepEqual(normalized(dir), await control(fixtures));

      for (const id of [TASK_IDS[0], TASK_IDS[1], TASK_IDS[2]]) {
        const snap = snapshotOf(dir, id);
        const events = snap.events ?? [];
        const failedEvents = events.filter(e => e.type === 'task.failed');
        assert.equal(failedEvents.length, 1);
        if (events.length > 0) {
          assert.equal(typeof events[0]?.sequence, 'number');
        }
        for (let i = 1; i < events.length; i++) {
          const prev = events[i - 1]?.sequence;
          const curr = events[i]?.sequence;
          assert.equal(typeof prev, 'number');
          assert.equal(typeof curr, 'number');
          assert.ok((curr as number) > (prev as number));
        }
      }
    } finally {
      restoreRename();
      await cleanupDir(dir, managers);
    }
  }
});

test('a temporary that cannot be removed does not stop removing the others', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'black-gravity-restart-'));
  const managers: TaskManager[] = [];
  let restoreRename = () => {};
  let restoreRmSync = () => {};
  try {
    const fixtures: FixtureSpec[] = [
      interruptedFixture(TASK_IDS[0], '2026-01-01T00:00:01.000Z'),
      interruptedFixture(TASK_IDS[1], '2026-01-01T00:00:02.000Z'),
      interruptedFixture(TASK_IDS[2], '2026-01-01T00:00:03.000Z'),
    ];
    for (const f of fixtures) {
      writeSnapshot(dir, f);
    }

    restoreRename = failRenameOf(t, TASK_IDS[1]);
    const originalRmSync = fs.rmSync;
    const rmSyncMock = t.mock.method(fs, 'rmSync', ((target: fs.PathLike, options?: fs.RmOptions) => {
      const base = path.basename(String(target));
      if (base.startsWith(TASK_IDS[1]) && base.endsWith('.tmp')) {
        const error = new Error('injected');
        Object.assign(error, { code: 'EBUSY' });
        throw error;
      }
      return originalRmSync(target, options);
    }) as typeof fs.rmSync);
    syncBuiltinESMExports();

    let rmSyncRestored = false;
    restoreRmSync = () => {
      if (!rmSyncRestored) {
        rmSyncRestored = true;
        rmSyncMock.mock.restore();
        syncBuiltinESMExports();
      }
    };

    const manager1 = createManager(dir);
    managers.push(manager1);
    assert.equal(manager1.isStateDirectoryUsable(), false);
    await manager1.shutdown();

    restoreRmSync();
    restoreRename();
    syncBuiltinESMExports();

    const tmpFiles = fs.readdirSync(dir).filter(entry => entry.endsWith('.tmp'));
    assert.equal(tmpFiles.length, 1);
    assert.ok(tmpFiles[0]?.startsWith(TASK_IDS[1]));

    const manager2 = createManager(dir);
    managers.push(manager2);
    assert.equal(manager2.isStateDirectoryUsable(), true);
    await manager2.shutdown();

    assert.deepEqual(normalized(dir), await control(fixtures));
  } finally {
    restoreRmSync();
    restoreRename();
    await cleanupDir(dir, managers);
  }
});

test('publication order updates non-transitioned tasks first and transitioned tasks last by createdAt', async t => {
  const b1Id = TASK_IDS[0];
  const sId = TASK_IDS[1];
  const b2Id = TASK_IDS[2];

  for (const failTarget of ['S', 'B1', 'B2'] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'black-gravity-restart-'));
    const managers: TaskManager[] = [];
    let restoreRename = () => {};
    try {
      const fixtures: FixtureSpec[] = [
        interruptedFixture(b1Id, '2026-01-01T00:00:01.000Z', { project: FIXTURE_PROJECT }),
        {
          taskId: sId,
          createdAt: '2026-01-01T00:00:02.000Z',
          ownerPid: DEAD_PID,
          record: {
            status: 'completed',
            completedAt: '2026-01-01T00:00:02.500Z',
            inbox: [
              {
                messageId: INBOX_MESSAGE_ID,
                taskId: sId,
                text: 'x',
                receivedAt: '2026-01-01T00:00:02.100Z',
                receipt: { messageId: INBOX_MESSAGE_ID, taskId: sId, state: 'queued' },
              },
            ],
          },
          project: FIXTURE_PROJECT,
        },
        interruptedFixture(b2Id, '2026-01-01T00:00:03.000Z', { project: FIXTURE_PROJECT }),
      ];

      for (const f of fixtures) {
        writeSnapshot(dir, f);
      }

      const beforeBytes = read(dir);
      const targetId = failTarget === 'S' ? sId : failTarget === 'B1' ? b1Id : b2Id;
      restoreRename = failRenameOf(t, targetId);

      const manager1 = createManager(dir);
      managers.push(manager1);
      assert.equal(manager1.isStateDirectoryUsable(), false);
      await manager1.shutdown();

      const currentBytes = read(dir);
      if (failTarget === 'S') {
        assert.deepEqual(currentBytes.get(b1Id), beforeBytes.get(b1Id));
        assert.deepEqual(currentBytes.get(sId), beforeBytes.get(sId));
        assert.deepEqual(currentBytes.get(b2Id), beforeBytes.get(b2Id));
      } else if (failTarget === 'B1') {
        const sSnap = snapshotOf(dir, sId);
        const record = sSnap.record;
        const inbox = record?.inbox as Array<{ receipt?: { state?: string } }> | undefined;
        assert.equal(inbox?.[0]?.receipt?.state, 'failed');
        assert.deepEqual(currentBytes.get(b1Id), beforeBytes.get(b1Id));
        assert.deepEqual(currentBytes.get(b2Id), beforeBytes.get(b2Id));
      } else {
        const sSnap = snapshotOf(dir, sId);
        const record = sSnap.record;
        const inbox = record?.inbox as Array<{ receipt?: { state?: string } }> | undefined;
        assert.equal(inbox?.[0]?.receipt?.state, 'failed');

        const b1Snap = snapshotOf(dir, b1Id);
        assert.equal(b1Snap.record?.status, 'failed');
        assert.deepEqual(currentBytes.get(b2Id), beforeBytes.get(b2Id));
      }

      restoreRename();

      const manager2 = createManager(dir);
      managers.push(manager2);
      assert.equal(manager2.isStateDirectoryUsable(), true);
      await manager2.shutdown();

      assert.deepEqual(normalized(dir), await control(fixtures));

      const sFinal = snapshotOf(dir, sId);
      const stoppedEvents = (sFinal.events ?? []).filter(e => e.type === 'caller.messages-stopped');
      assert.equal(stoppedEvents.length, 1);
    } finally {
      restoreRename();
      await cleanupDir(dir, managers);
    }
  }
});

test('read-only terminal snapshot needs no write and startup succeeds', { skip: process.getuid?.() === 0 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'black-gravity-restart-'));
  const managers: TaskManager[] = [];
  const termId = TASK_IDS[2];
  const termFile = path.join(dir, `${termId}.json`);
  try {
    const fixtures: FixtureSpec[] = [
      interruptedFixture(TASK_IDS[0], '2026-01-01T00:00:01.000Z'),
      interruptedFixture(TASK_IDS[1], '2026-01-01T00:00:02.000Z'),
      terminalFixture(termId, '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:04.000Z'),
    ];
    for (const f of fixtures) {
      writeSnapshot(dir, f);
    }

    const beforeBytes = read(dir);
    fs.chmodSync(termFile, 0o444);

    const manager = createManager(dir);
    managers.push(manager);
    assert.equal(manager.isStateDirectoryUsable(), true);
    await manager.shutdown();

    const snap1 = snapshotOf(dir, TASK_IDS[0]);
    assert.equal(snap1.record?.status, 'failed');
    const snap2 = snapshotOf(dir, TASK_IDS[1]);
    assert.equal(snap2.record?.status, 'failed');

    const afterBytes = read(dir);
    assert.ok(beforeBytes.has(termId));
    assert.deepEqual(afterBytes.get(termId), beforeBytes.get(termId));
  } finally {
    try {
      fs.chmodSync(termFile, 0o644);
    } catch {
      // ignore
    }
    await cleanupDir(dir, managers);
  }
});

test('refresh failing on a running manager throws and keeps manager usable without file mutation', { skip: process.getuid?.() === 0 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'black-gravity-restart-'));
  const managers: TaskManager[] = [];
  const midId = TASK_IDS[1];
  const midFile = path.join(dir, `${midId}.json`);
  try {
    const manager = createManager(dir);
    managers.push(manager);
    assert.equal(manager.isStateDirectoryUsable(), true);

    const fixtures: FixtureSpec[] = [
      interruptedFixture(TASK_IDS[0], '2026-01-01T00:00:01.000Z'),
      interruptedFixture(TASK_IDS[1], '2026-01-01T00:00:02.000Z'),
      interruptedFixture(TASK_IDS[2], '2026-01-01T00:00:03.000Z'),
    ];
    for (const f of fixtures) {
      writeSnapshot(dir, f);
    }
    fs.chmodSync(midFile, 0o444);

    const beforeBytes = read(dir);
    assert.throws(() => manager.status(TASK_IDS[0]));

    const currentBytes = read(dir);
    assert.deepEqual(currentBytes, beforeBytes);
    assert.equal(manager.isStateDirectoryUsable(), true);
    noTemporaries(dir);

    fs.chmodSync(midFile, 0o644);
    const statusRecord = manager.status(TASK_IDS[0]);
    assert.equal(statusRecord.status, 'failed');

    for (const id of [TASK_IDS[0], TASK_IDS[1], TASK_IDS[2]]) {
      const events = manager.readEvents(id).events;
      const failed = events.filter(event => event.type === 'task.failed');
      assert.equal(failed.length, 1);
    }

    await manager.shutdown();
  } finally {
    try {
      fs.chmodSync(midFile, 0o644);
    } catch {
      // ignore
    }
    await cleanupDir(dir, managers);
  }
});
