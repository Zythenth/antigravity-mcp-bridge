import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CliAdapter } from '../dist/src/cli-adapter.js';
import { loadConfig } from '../dist/src/config.js';
import { TaskManager } from '../dist/src/task-manager.js';

const clock = fileURLToPath(new URL('./clock-offset.mjs', import.meta.url));
const clockURL = pathToFileURL(clock).href;
const fixture = fileURLToPath(new URL('./aged-state-fixture.mjs', import.meta.url));
const warningLine = /^Copy cleanup failed \(STATE_BUSY\); the server keeps running and retries every minute\. See maintenanceIssues in antigravity_health\.$/m;

async function exists(target) {
  try { await access(target); return true; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

// The fixture and the server must resolve the same temporary directory, which the SDK does not pass on Linux.
export const temporaryEnv = Object.fromEntries(['TEMP', 'TMP', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));

function fixtureEnv(offsetMs) {
  const env = { ...temporaryEnv, BRIDGE_TEST_CLOCK_OFFSET_MS: String(offsetMs) };
  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'HOME', 'USERPROFILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function runFixture(caseRoot, state, taskCount, withGroup, offsetMs) {
  const output = execFileSync(process.execPath, ['--import', clockURL, fixture, caseRoot, state, String(taskCount), String(withGroup)], {
    cwd: caseRoot,
    encoding: 'utf8',
    env: fixtureEnv(offsetMs),
  });
  return JSON.parse(output.trim());
}

export async function withAgedServer(bin, root, name, prepare, verify, server = {}) {
  const caseRoot = path.join(root, name), state = path.join(caseRoot, 'state');
  await mkdir(caseRoot, { recursive: true });
  const client = new Client({ name: 'package-test', version: '1' });
  let stderr = '', lockFile, failure;
  try {
    const context = await prepare({
      caseRoot,
      state,
      run: (taskCount, withGroup, offsetMs) => runFixture(caseRoot, state, taskCount, withGroup, offsetMs),
      setLockFile: file => { lockFile = file; },
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', clockURL, ...(server.args ?? []), bin],
      cwd: root,
      stderr: 'pipe',
      env: { ...temporaryEnv, AGY_PATH: path.join(root, 'missing-agy'), BRIDGE_STATE_DIRECTORY: state, BRIDGE_TEST_CLOCK_OFFSET_MS: String(200 * 3600000), ...(server.env ?? {}) },
    });
    transport.stderr.on('data', chunk => { stderr += String(chunk); });
    await client.connect(transport);
    await verify({ client, state, getStderr: () => stderr, ...context });
  } catch (error) {
    failure = new Error(`tarball (${name}): ${String(error)}; stderr: ${stderr}`, { cause: error });
    throw failure;
  } finally {
    if (lockFile) await unlink(lockFile).catch(() => {});
    await client.close().catch(() => {});
    // Copies live outside the fixture root, so they are recovered from its state even when the fixture failed midway.
    if (await exists(state)) {
      const config = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', AGY_PATH: process.execPath, DEFAULT_TIMEOUT_SECONDS: '30', BRIDGE_TEST_EXECUTOR: 'agy', BRIDGE_STATE_DIRECTORY: state });
      const manager = new TaskManager(new CliAdapter(config), config), remaining = [];
      try {
        for (const task of manager.list()) if (task.copyDirectory && await exists(task.copyDirectory)) await manager.discard(task.taskId).catch(() => {});
        for (const task of manager.list()) if (task.copyDirectory && await exists(task.copyDirectory)) remaining.push(task.taskId);
      } finally { await manager.shutdown(); }
      if (remaining.length && !failure) throw Error(`tarball (${name}): copies left after teardown: ${remaining.join(', ')}`);
    }
  }
}

export async function checkAgedState(bin, root) {
  await withAgedServer(bin, root, 'aged', async ({ run }) => {
    const expired = run(3, 1, 0);
    assert.equal(expired.tasks.length, 4);
    assert.equal(typeof expired.groupId, 'string');
    const expiredIds = new Set(expired.tasks.map(task => task.taskId));
    const retainedList = run(1, 0, 100 * 3600000).tasks.filter(task => !expiredIds.has(task.taskId));
    assert.equal(retainedList.length, 1);
    return { expired: expired.tasks, groupId: expired.groupId, retained: retainedList[0] };
  }, async ({ client, getStderr, expired, groupId, retained }) => {
    const health = await client.callTool({ name: 'antigravity_health', arguments: {} });
    assert.equal(health.isError, undefined, JSON.stringify(health.structuredContent));
    assert.deepEqual(health.structuredContent.maintenanceIssues ?? [], []);
    for (const task of expired) await assert.rejects(access(task.copyDirectory), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(retained.copyDirectory, 'source.txt'), 'utf8'), 'source');
    const status = await client.callTool({ name: 'antigravity_status', arguments: { taskId: retained.taskId } });
    assert.equal(status.isError, undefined, JSON.stringify(status.structuredContent));
    assert.equal(status.structuredContent.task.discardedAt, undefined);
    const group = await client.callTool({ name: 'antigravity_group_status', arguments: { groupId } });
    assert.equal(group.isError, undefined, JSON.stringify(group.structuredContent));
    assert.equal(group.structuredContent.group.state, 'completed');
    assert.ok(!getStderr().includes('Copy cleanup failed'), getStderr());
    console.log('tarball: aged state startup cleanup passed');
  });
}

export async function checkFailedCleanup(bin, root) {
  await withAgedServer(bin, root, 'failed-cleanup', async ({ state, run, setLockFile }) => {
    const first = run(1, 0, 0);
    assert.equal(first.tasks.length, 1);
    const expired = first.tasks[0];
    const retainedList = run(1, 0, 100 * 3600000).tasks.filter(task => task.taskId !== expired.taskId);
    assert.equal(retainedList.length, 1);
    const lockFile = path.join(state, `copy-${createHash('sha256').update(expired.copyDirectory).digest('hex')}.lock`);
    await writeFile(lockFile, JSON.stringify({ pid: process.pid, token: randomUUID() }), { flag: 'wx', mode: 0o600 });
    setLockFile(lockFile);
    return { expired, retained: retainedList[0], lockFile };
  }, async ({ client, state, getStderr, expired, retained, lockFile }) => {
    const health = await client.callTool({ name: 'antigravity_health', arguments: {} });
    assert.equal(health.isError, undefined, JSON.stringify(health.structuredContent));
    const since = health.structuredContent.maintenanceIssues?.[0]?.since;
    assert.equal(typeof since, 'string');
    assert.match(since, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(health.structuredContent.maintenanceIssues, [{ operation: 'copy-cleanup', code: 'STATE_BUSY', since, failures: 1 }]);
    const initialStderr = getStderr();
    assert.match(initialStderr, warningLine);
    assert.equal(initialStderr.split(/\r?\n/).filter(line => warningLine.test(line)).length, 1, initialStderr);
    assert.equal(initialStderr.split(/\r?\n/).filter(line => line.includes('Copy cleanup failed')).length, 1, initialStderr);
    const realTmp = await realpath(os.tmpdir());
    for (const dir of [state, expired.copyDirectory, retained.copyDirectory, os.tmpdir(), realTmp]) {
      assert.ok(!initialStderr.includes(dir), `stderr leaked path: ${dir}`);
    }
    for (const call of [
      { name: 'antigravity_tasks', arguments: {} },
      { name: 'antigravity_status', arguments: { taskId: expired.taskId } },
      { name: 'antigravity_groups', arguments: {} },
    ]) {
      const response = await client.callTool(call);
      assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    }
    assert.equal(await readFile(path.join(expired.copyDirectory, 'source.txt'), 'utf8'), 'source');
    assert.equal(await readFile(path.join(retained.copyDirectory, 'source.txt'), 'utf8'), 'source');
    await unlink(lockFile);
    const deadline = Date.now() + 90000;
    let currentHealth;
    while (Date.now() < deadline) {
      await delay(1000);
      currentHealth = await client.callTool({ name: 'antigravity_health', arguments: {} });
      assert.equal(currentHealth.isError, undefined, JSON.stringify(currentHealth.structuredContent));
      if (!currentHealth.structuredContent.maintenanceIssues?.length) break;
    }
    assert.deepEqual(currentHealth?.structuredContent.maintenanceIssues ?? [], [], JSON.stringify(currentHealth?.structuredContent));
    await assert.rejects(access(expired.copyDirectory), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(retained.copyDirectory, 'source.txt'), 'utf8'), 'source');
    const finalStderr = getStderr();
    assert.equal(finalStderr.split(/\r?\n/).filter(line => warningLine.test(line)).length, 1, finalStderr);
    assert.equal(finalStderr.split(/\r?\n/).filter(line => line.includes('Copy cleanup failed')).length, 1, finalStderr);
    console.log('tarball: failed startup cleanup and timer recovery passed');
  });
}
