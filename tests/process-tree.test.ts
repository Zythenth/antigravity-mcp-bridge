import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ownedProcesses, reconcileOwnedProcesses } from '../src/process-tree.js';

test('owned process tree follows creation order and ignores reused or unrelated PIDs', () => {
  const spawnedAt = 1_000_000;
  const processes = [
    { pid: 10, parentPid: 1, createdAt: spawnedAt + 5 },
    { pid: 11, parentPid: 10, createdAt: spawnedAt + 10 },
    { pid: 12, parentPid: 11, createdAt: spawnedAt + 20 },
    { pid: 13, parentPid: 10, createdAt: spawnedAt - 60_000 },
    { pid: 14, parentPid: 99, createdAt: spawnedAt + 30 },
    { pid: 15, parentPid: 13, createdAt: spawnedAt + 40 },
  ];
  assert.deepEqual(ownedProcesses(processes, 10, spawnedAt).map(item => item.pid).sort(), [10, 11, 12]);
  // With the root gone, its surviving children are still owned when they were created after the spawn.
  assert.deepEqual(ownedProcesses(processes.slice(1), 10, spawnedAt).map(item => item.pid).sort(), [11, 12]);
  assert.deepEqual(ownedProcesses(processes, 10, spawnedAt + 1_000_000), []);
});

test('cleanup terminates a descendant that outlived its exited parent and verifies it is gone', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-process-tree-'));
  const pidFile = path.join(directory, 'descendant.pid');
  const spawnedAt = Date.now();
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const parent = spawn(process.execPath, ['-e', `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { detached: process.platform === 'win32', stdio: 'ignore' }); child.unref();`],
    { detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true });
  let descendantPid: number | undefined;
  try {
    await new Promise(resolve => parent.once('exit', resolve));
    const deadline = Date.now() + 60_000;
    while (descendantPid === undefined && Date.now() < deadline) {
      descendantPid = Number(await readFile(pidFile, 'utf8').catch(() => '')) || undefined;
      if (descendantPid === undefined) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(descendantPid, 'descendant did not report readiness');
    assert.doesNotThrow(() => process.kill(descendantPid!, 0));
    const cleanup = await reconcileOwnedProcesses({ pid: parent.pid, spawnedAt, processGroup: process.platform !== 'win32' });
    assert.equal(cleanup.verified, true, JSON.stringify(cleanup));
    assert.throws(() => process.kill(descendantPid!, 0), { code: 'ESRCH' });
  } finally {
    if (descendantPid) try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already gone */ }
    await rm(directory, { recursive: true, force: true });
  }
});
