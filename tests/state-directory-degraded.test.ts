import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { TaskManager } from '../src/task-manager.js';
import { StateStore } from '../src/state-store.js';
import { runWaitCommand } from '../src/wait-command.js';

const entryPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

test('loadConfig validates BRIDGE_STATE_DIRECTORY per failure type without leaking the configured value', () => {
  // 1. Relative path
  const relativeConfig = loadConfig({ BRIDGE_STATE_DIRECTORY: 'some/relative/path' });
  assert.equal(relativeConfig.stateDirectoryInvalid, true);
  assert.equal(relativeConfig.stateDirectory, '');
  assert.deepEqual(relativeConfig.configurationIssues, [
    { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'not-absolute' },
  ]);
  assert.equal(JSON.stringify(relativeConfig.configurationIssues).includes('some/relative/path'), false);

  // 2. NUL byte
  const nulConfig = loadConfig({ BRIDGE_STATE_DIRECTORY: '/tmp/state\0dir' });
  assert.equal(nulConfig.stateDirectoryInvalid, true);
  assert.equal(nulConfig.stateDirectory, '');
  assert.deepEqual(nulConfig.configurationIssues, [
    { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'invalid-entry' },
  ]);
  assert.equal(JSON.stringify(nulConfig.configurationIssues).includes('state'), false);

  // 3. Win32 root-relative and drive-relative values
  if (process.platform === 'win32') {
    const rootRelConfig = loadConfig({ BRIDGE_STATE_DIRECTORY: '\\state-root-relative' });
    assert.equal(rootRelConfig.stateDirectoryInvalid, true);
    assert.equal(rootRelConfig.stateDirectory, '');
    assert.deepEqual(rootRelConfig.configurationIssues, [
      { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'not-absolute' },
    ]);
    assert.equal(JSON.stringify(rootRelConfig.configurationIssues).includes('state-root-relative'), false);

    const driveRelConfig = loadConfig({ BRIDGE_STATE_DIRECTORY: 'C:state-drive-relative' });
    assert.equal(driveRelConfig.stateDirectoryInvalid, true);
    assert.equal(driveRelConfig.stateDirectory, '');
    assert.deepEqual(driveRelConfig.configurationIssues, [
      { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'not-absolute' },
    ]);
    assert.equal(JSON.stringify(driveRelConfig.configurationIssues).includes('state-drive-relative'), false);

    const malformedWinConfig = loadConfig({ BRIDGE_STATE_DIRECTORY: 'C:\\invalid?state' });
    assert.equal(malformedWinConfig.stateDirectoryInvalid, true);
    assert.equal(malformedWinConfig.stateDirectory, '');
    assert.deepEqual(malformedWinConfig.configurationIssues, [
      { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'invalid-entry' },
    ]);
    assert.equal(JSON.stringify(malformedWinConfig.configurationIssues).includes('invalid?state'), false);

    const malformedUncConfig = loadConfig({ BRIDGE_STATE_DIRECTORY: '\\\\server\\invalid?share\\state' });
    assert.equal(malformedUncConfig.stateDirectoryInvalid, true);
    assert.equal(malformedUncConfig.stateDirectory, '');
    assert.deepEqual(malformedUncConfig.configurationIssues, [
      { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'invalid-entry' },
    ]);
    assert.equal(JSON.stringify(malformedUncConfig.configurationIssues).includes('invalid?share'), false);

    const malformedExtUncConfig = loadConfig({ BRIDGE_STATE_DIRECTORY: '\\\\?\\UNC\\server\\invalid?share\\state' });
    assert.equal(malformedExtUncConfig.stateDirectoryInvalid, true);
    assert.equal(malformedExtUncConfig.stateDirectory, '');
    assert.deepEqual(malformedExtUncConfig.configurationIssues, [
      { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'invalid-entry' },
    ]);
    assert.equal(JSON.stringify(malformedExtUncConfig.configurationIssues).includes('invalid?share'), false);

    const overlongComponent = 'a'.repeat(256);
    const overlongConfig = loadConfig({ BRIDGE_STATE_DIRECTORY: 'C:\\parent-not-created\\' + overlongComponent });
    assert.equal(overlongConfig.stateDirectoryInvalid, true);
    assert.equal(overlongConfig.stateDirectory, '');
    assert.deepEqual(overlongConfig.configurationIssues, [
      { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'invalid-entry' },
    ]);
    assert.equal(JSON.stringify(overlongConfig.configurationIssues).includes(overlongComponent), false);

    // Positive cases on Windows
    const validExtDrive = loadConfig({ BRIDGE_STATE_DIRECTORY: '\\\\?\\C:\\x' });
    assert.equal(validExtDrive.stateDirectoryInvalid, undefined);
    assert.equal(validExtDrive.stateDirectory, '\\\\?\\C:\\x');
    assert.equal(validExtDrive.configurationIssues.some(issue => issue.variable === 'BRIDGE_STATE_DIRECTORY'), false);

    const validExtUnc = loadConfig({ BRIDGE_STATE_DIRECTORY: '\\\\?\\UNC\\server\\share\\x' });
    assert.equal(validExtUnc.stateDirectoryInvalid, undefined);
    assert.equal(validExtUnc.stateDirectory, '\\\\?\\UNC\\server\\share\\x');
    assert.equal(validExtUnc.configurationIssues.some(issue => issue.variable === 'BRIDGE_STATE_DIRECTORY'), false);

    const validVolume = loadConfig({ BRIDGE_STATE_DIRECTORY: '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\x' });
    assert.equal(validVolume.stateDirectoryInvalid, undefined);
    assert.equal(validVolume.stateDirectory, '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\x');
    assert.equal(validVolume.configurationIssues.some(issue => issue.variable === 'BRIDGE_STATE_DIRECTORY'), false);

    const validUnc = loadConfig({ BRIDGE_STATE_DIRECTORY: '\\\\server\\share\\x' });
    assert.equal(validUnc.stateDirectoryInvalid, undefined);
    assert.equal(validUnc.stateDirectory, '\\\\server\\share\\x');
    assert.equal(validUnc.configurationIssues.some(issue => issue.variable === 'BRIDGE_STATE_DIRECTORY'), false);
  }

  // 4. Unset keeps default
  const unsetConfig = loadConfig({});
  assert.equal(unsetConfig.stateDirectoryInvalid, undefined);
  assert.equal(unsetConfig.stateDirectory, path.join(os.homedir(), '.antigravity-mcp-bridge'));
  assert.equal(unsetConfig.configurationIssues.some(issue => issue.variable === 'BRIDGE_STATE_DIRECTORY'), false);

  // 5. Empty string keeps default
  const emptyConfig = loadConfig({ BRIDGE_STATE_DIRECTORY: '' });
  assert.equal(emptyConfig.stateDirectoryInvalid, undefined);
  assert.equal(emptyConfig.stateDirectory, path.join(os.homedir(), '.antigravity-mcp-bridge'));
  assert.equal(emptyConfig.configurationIssues.some(issue => issue.variable === 'BRIDGE_STATE_DIRECTORY'), false);

  // 6. Absolute path keeps value
  const validDir = path.resolve(os.tmpdir(), 'valid-bridge-state-dir');
  const validConfig = loadConfig({ BRIDGE_STATE_DIRECTORY: validDir });
  assert.equal(validConfig.stateDirectoryInvalid, undefined);
  assert.equal(validConfig.stateDirectory, validDir);
  assert.equal(validConfig.configurationIssues.some(issue => issue.variable === 'BRIDGE_STATE_DIRECTORY'), false);
});

test('Real server startup over stdio enters degraded mode on relative BRIDGE_STATE_DIRECTORY', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-srv-rel-state-'));
  const fakeHome = path.join(tmpDir, 'fake-home');
  const fakeCwd = path.join(tmpDir, 'fake-cwd');
  mkdirSync(fakeHome);
  mkdirSync(fakeCwd);

  let client: Client | undefined;
  let stderr = '';
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entryPath],
      cwd: fakeCwd,
      env: {
        ...process.env as Record<string, string>,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        BRIDGE_ANTI_AI_CRAFT: 'off',
        BRIDGE_STATE_DIRECTORY: 'relative-state-dir',
      },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', chunk => {
      stderr += String(chunk);
    });

    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const healthResult = await client.callTool({ name: 'antigravity_health', arguments: {} });
    const health = healthResult.structuredContent as Record<string, unknown>;
    assert.deepEqual(health.configurationIssues, [
      { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'not-absolute' },
    ]);
    assert.equal(health.waitCommand, undefined);

    const cleanupResult = await client.callTool({ name: 'antigravity_cleanup', arguments: {} });
    assert.equal(cleanupResult.isError, true);
    assert.match(JSON.stringify(cleanupResult), /INVALID_STATE_DIRECTORY/);

    const policyResult = await client.callTool({ name: 'antigravity_get_agent_policy', arguments: {} });
    assert.equal(policyResult.isError, true);
    assert.match(JSON.stringify(policyResult), /INVALID_STATE_DIRECTORY/);

    const tasksResult = await client.callTool({ name: 'antigravity_tasks', arguments: {} });
    assert.equal(tasksResult.isError, true);
    assert.match(JSON.stringify(tasksResult), /INVALID_STATE_DIRECTORY/);

    const rolesResult = await client.callTool({ name: 'antigravity_roles', arguments: {} });
    assert.equal(rolesResult.isError, undefined);
    assert.ok(Array.isArray((rolesResult.structuredContent as Record<string, unknown>).roles));

    const modelsResult = await client.callTool({ name: 'antigravity_list_models', arguments: {} });
    assert.equal(JSON.stringify(modelsResult).includes('INVALID_STATE_DIRECTORY'), false);

    await client.close();
    client = undefined;

    const stderrLines = stderr.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(stderrLines.length, 1);
    assert.match(stderrLines[0]!, /^Invalid configuration entries were ignored/);
    assert.match(stderrLines[0]!, /BRIDGE_STATE_DIRECTORY not-absolute/);
    assert.equal(stderr.includes('relative-state-dir'), false);

    assert.equal(existsSync(path.join(fakeHome, '.antigravity-mcp-bridge')), false);
    assert.deepEqual(readdirSync(fakeCwd), []);
    assert.equal(existsSync(path.join(fakeCwd, 'relative-state-dir')), false);
    assert.equal(existsSync(path.resolve('relative-state-dir')), false);
    assert.equal(existsSync(path.join(process.cwd(), 'relative-state-dir')), false);
  } finally {
    if (client) await client.close();
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Real server startup over stdio or TaskManager handles NUL byte in BRIDGE_STATE_DIRECTORY', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-srv-nul-state-'));
  const fakeHome = path.join(tmpDir, 'fake-home');
  const fakeCwd = path.join(tmpDir, 'fake-cwd');
  mkdirSync(fakeHome);
  mkdirSync(fakeCwd);

  let canEnvCarryNul = true;
  try {
    spawnSync(process.execPath, ['-v'], { env: { ...process.env, TEST_NUL: 'val\0test' } });
  } catch {
    canEnvCarryNul = false;
  }

  try {
    if (canEnvCarryNul) {
      let client: Client | undefined;
      try {
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [entryPath],
          cwd: fakeCwd,
          env: {
            ...process.env as Record<string, string>,
            HOME: fakeHome,
            USERPROFILE: fakeHome,
            BRIDGE_ANTI_AI_CRAFT: 'off',
            BRIDGE_STATE_DIRECTORY: path.join(tmpDir, 'nul\0dir'),
          },
          stderr: 'pipe',
        });

        client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const healthResult = await client.callTool({ name: 'antigravity_health', arguments: {} });
        const health = healthResult.structuredContent as Record<string, unknown>;
        assert.deepEqual(health.configurationIssues, [
          { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'invalid-entry' },
        ]);
        assert.equal(health.waitCommand, undefined);

        const cleanupResult = await client.callTool({ name: 'antigravity_cleanup', arguments: {} });
        assert.equal(cleanupResult.isError, true);
        assert.match(JSON.stringify(cleanupResult), /INVALID_STATE_DIRECTORY/);

        const policyResult = await client.callTool({ name: 'antigravity_get_agent_policy', arguments: {} });
        assert.equal(policyResult.isError, true);
        assert.match(JSON.stringify(policyResult), /INVALID_STATE_DIRECTORY/);

        const tasksResult = await client.callTool({ name: 'antigravity_tasks', arguments: {} });
        assert.equal(tasksResult.isError, true);
        assert.match(JSON.stringify(tasksResult), /INVALID_STATE_DIRECTORY/);

        const rolesResult = await client.callTool({ name: 'antigravity_roles', arguments: {} });
        assert.equal(rolesResult.isError, undefined);
        assert.ok(Array.isArray((rolesResult.structuredContent as Record<string, unknown>).roles));

        const modelsResult = await client.callTool({ name: 'antigravity_list_models', arguments: {} });
        assert.equal(JSON.stringify(modelsResult).includes('INVALID_STATE_DIRECTORY'), false);
      } finally {
        if (client) await client.close();
      }
    } else {
      const config = loadConfig({
        BRIDGE_STATE_DIRECTORY: path.join(tmpDir, 'state\0dir'),
        AGY_PATH: process.execPath,
      });
      const adapter = new CliAdapter(config);
      const tasks = new TaskManager(adapter, config);
      assert.deepEqual(tasks.configurationIssues, [
        { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'invalid-entry' },
      ]);
      assert.equal(tasks.isStateDirectoryUsable(), false);
      await assert.rejects(tasks.run({ workingDirectory: tmpDir, prompt: 'test' }), { code: 'INVALID_STATE_DIRECTORY' });
      assert.throws(() => tasks.list(), { code: 'INVALID_STATE_DIRECTORY' });
      assert.deepEqual(await tasks.cleanup(), { discardedTaskIds: [] });
      await tasks.shutdown();
    }

    assert.equal(existsSync(path.join(fakeHome, '.antigravity-mcp-bridge')), false);
    assert.deepEqual(readdirSync(fakeCwd), []);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Real server startup over stdio enters degraded mode on link BRIDGE_STATE_DIRECTORY', async t => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-srv-link-state-'));
  const fakeHome = path.join(tmpDir, 'fake-home');
  const fakeCwd = path.join(tmpDir, 'fake-cwd');
  const targetDir = path.join(tmpDir, 'link-target');
  const linkDir = path.join(tmpDir, 'link-source');
  mkdirSync(fakeHome);
  mkdirSync(fakeCwd);
  mkdirSync(targetDir);

  try {
    symlinkSync(targetDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return t.skip('Platform refuses symlink/junction creation');
  }

  let client: Client | undefined;
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entryPath],
      cwd: fakeCwd,
      env: {
        ...process.env as Record<string, string>,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        BRIDGE_ANTI_AI_CRAFT: 'off',
        BRIDGE_STATE_DIRECTORY: linkDir,
      },
      stderr: 'pipe',
    });

    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const healthResult = await client.callTool({ name: 'antigravity_health', arguments: {} });
    const health = healthResult.structuredContent as Record<string, unknown>;
    assert.deepEqual(health.configurationIssues, [
      { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'link' },
    ]);
    assert.equal(health.waitCommand, undefined);

    const cleanupResult = await client.callTool({ name: 'antigravity_cleanup', arguments: {} });
    assert.equal(cleanupResult.isError, true);
    assert.match(JSON.stringify(cleanupResult), /INVALID_STATE_DIRECTORY/);

    const policyResult = await client.callTool({ name: 'antigravity_get_agent_policy', arguments: {} });
    assert.equal(policyResult.isError, true);
    assert.match(JSON.stringify(policyResult), /INVALID_STATE_DIRECTORY/);

    const tasksResult = await client.callTool({ name: 'antigravity_tasks', arguments: {} });
    assert.equal(tasksResult.isError, true);
    assert.match(JSON.stringify(tasksResult), /INVALID_STATE_DIRECTORY/);

    const rolesResult = await client.callTool({ name: 'antigravity_roles', arguments: {} });
    assert.equal(rolesResult.isError, undefined);
    assert.ok(Array.isArray((rolesResult.structuredContent as Record<string, unknown>).roles));

    const modelsResult = await client.callTool({ name: 'antigravity_list_models', arguments: {} });
    assert.equal(JSON.stringify(modelsResult).includes('INVALID_STATE_DIRECTORY'), false);

    await client.close();
    client = undefined;

    assert.equal(existsSync(path.join(fakeHome, '.antigravity-mcp-bridge')), false);
    assert.deepEqual(readdirSync(fakeCwd), []);
    assert.deepEqual(readdirSync(targetDir), []);
  } finally {
    if (client) await client.close();
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Real server startup over stdio and wait command enter degraded mode on existing regular file BRIDGE_STATE_DIRECTORY', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-srv-file-state-'));
  const fakeHome = path.join(tmpDir, 'fake-home');
  const fakeCwd = path.join(tmpDir, 'fake-cwd');
  const regularFile = path.join(tmpDir, 'regular-file.txt');
  mkdirSync(fakeHome);
  mkdirSync(fakeCwd);
  writeFileSync(regularFile, 'not a directory');

  let client: Client | undefined;
  let stderr = '';
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entryPath],
      cwd: fakeCwd,
      env: {
        ...process.env as Record<string, string>,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        BRIDGE_ANTI_AI_CRAFT: 'off',
        BRIDGE_STATE_DIRECTORY: regularFile,
      },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', chunk => {
      stderr += String(chunk);
    });

    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const healthResult = await client.callTool({ name: 'antigravity_health', arguments: {} });
    const health = healthResult.structuredContent as Record<string, unknown>;
    assert.deepEqual(health.configurationIssues, [
      { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'not-directory' },
    ]);
    assert.equal(health.waitCommand, undefined);

    const cleanupResult = await client.callTool({ name: 'antigravity_cleanup', arguments: {} });
    assert.equal(cleanupResult.isError, true);
    assert.match(JSON.stringify(cleanupResult), /INVALID_STATE_DIRECTORY/);

    const policyResult = await client.callTool({ name: 'antigravity_get_agent_policy', arguments: {} });
    assert.equal(policyResult.isError, true);
    assert.match(JSON.stringify(policyResult), /INVALID_STATE_DIRECTORY/);

    const tasksResult = await client.callTool({ name: 'antigravity_tasks', arguments: {} });
    assert.equal(tasksResult.isError, true);
    assert.match(JSON.stringify(tasksResult), /INVALID_STATE_DIRECTORY/);

    const rolesResult = await client.callTool({ name: 'antigravity_roles', arguments: {} });
    assert.equal(rolesResult.isError, undefined);
    assert.ok(Array.isArray((rolesResult.structuredContent as Record<string, unknown>).roles));

    const modelsResult = await client.callTool({ name: 'antigravity_list_models', arguments: {} });
    assert.equal(JSON.stringify(modelsResult).includes('INVALID_STATE_DIRECTORY'), false);

    await client.close();
    client = undefined;

    const stderrLines = stderr.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(stderrLines.length, 1);
    assert.match(stderrLines[0]!, /^Invalid configuration entries were ignored/);
    assert.match(stderrLines[0]!, /BRIDGE_STATE_DIRECTORY not-directory/);
    assert.equal(stderr.includes(regularFile), false);

    const validId = '00000000-0000-0000-0000-000000000000';
    let outputWait = '';
    const exitWait = await runWaitCommand(
      ['--state-directory', regularFile, validId],
      process.env,
      line => { outputWait = line; },
    );
    assert.equal(exitWait, 1);
    assert.equal(JSON.parse(outputWait).outcome, 'error');
    assert.equal(JSON.parse(outputWait).reason, 'INVALID_STATE_DIRECTORY');
    assert.equal(outputWait.includes(regularFile), false);
  } finally {
    if (client) await client.close();
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('TaskManager in degraded mode refuses state operations and performs harmless cleanup/shutdown', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-tm-degraded-'));
  try {
    const config = loadConfig({
      BRIDGE_STATE_DIRECTORY: 'relative-state-path',
      AGY_PATH: process.execPath,
    });
    const adapter = new CliAdapter(config);
    const tasks = new TaskManager(adapter, config);

    assert.equal(tasks.isStateDirectoryUsable(), false);
    assert.deepEqual(tasks.configurationIssues, [
      { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'not-absolute' },
    ]);

    const dummyId = '00000000-0000-0000-0000-000000000000';
    const dummyHash = '0'.repeat(64);

    await assert.rejects(tasks.run({ workingDirectory: tmpDir, prompt: 'test' }), { code: 'INVALID_STATE_DIRECTORY' });
    assert.throws(() => tasks.runInGroup({ workingDirectory: tmpDir, prompt: 'test' }, { groupId: dummyId, nodeKey: 'a', owner: 'implementer', definitionSha256: dummyHash }), { code: 'INVALID_STATE_DIRECTORY' });
    assert.throws(() => tasks.list(), { code: 'INVALID_STATE_DIRECTORY' });
    assert.throws(() => tasks.status(dummyId), { code: 'INVALID_STATE_DIRECTORY' });
    assert.throws(() => tasks.usage(), { code: 'INVALID_STATE_DIRECTORY' });
    assert.throws(() => tasks.result(dummyId), { code: 'INVALID_STATE_DIRECTORY' });
    assert.throws(() => tasks.readResult(dummyId), { code: 'INVALID_STATE_DIRECTORY' });
    assert.throws(() => tasks.readStructuredResult(dummyId), { code: 'INVALID_STATE_DIRECTORY' });
    assert.throws(() => tasks.listArtifacts(dummyId), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.readArtifact(dummyId, 'file.txt', dummyHash), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.readPatch(dummyId, dummyHash), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.preview(dummyId), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.context(dummyId), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.compare(dummyId, dummyHash, ['model'], 'prompt'), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.comparison(dummyId), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.verify(dummyId, dummyHash), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.workflowSnapshot(dummyId, dummyId, 'key'), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.startTests(dummyId, dummyHash, { executable: 'node', args: [] }), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.recordTest(dummyId, dummyHash, 'node -v', 0), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.discard(dummyId), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.integrate(dummyId, dummyHash), { code: 'INVALID_STATE_DIRECTORY' });
    assert.throws(() => tasks.inbox(dummyId), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.sendMessage(dummyId, dummyId, 'text'), { code: 'INVALID_STATE_DIRECTORY' });
    assert.throws(() => tasks.setDeliveryMode(dummyId, 'messages'), { code: 'INVALID_STATE_DIRECTORY' });
    assert.throws(() => tasks.readEvents(dummyId), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.waitMany([]), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.wait(dummyId), { code: 'INVALID_STATE_DIRECTORY' });
    assert.throws(() => tasks.sessions(), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.cancel(dummyId), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.listMemory(tmpDir), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.readMemory(tmpDir, 'specialist', dummyHash), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.writeMemory(tmpDir, 'specialist', 'text', null), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.removeMemory(tmpDir, 'specialist', dummyHash), { code: 'INVALID_STATE_DIRECTORY' });
    assert.throws(() => tasks.groups, { code: 'INVALID_STATE_DIRECTORY' });
    assert.throws(() => tasks.getModel(), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.setModel('model-id'), { code: 'INVALID_STATE_DIRECTORY' });
    assert.throws(() => tasks.getSandboxPolicy(), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.setSandboxPolicy({}, dummyHash), { code: 'INVALID_STATE_DIRECTORY' });
    assert.throws(() => tasks.integrationPreauthorized(dummyId), { code: 'INVALID_STATE_DIRECTORY' });
    await assert.rejects(tasks.listProjectFiles(tmpDir), { code: 'INVALID_STATE_DIRECTORY' });

    assert.deepEqual(await tasks.cleanup(), { discardedTaskIds: [] });
    await tasks.shutdown();

    assert.equal(existsSync(path.resolve('relative-state-path')), false);
    assert.equal(existsSync(path.join(process.cwd(), 'relative-state-path')), false);

    const runtimeStatus = await tasks.windowsRuntimeStatus();
    assert.ok(runtimeStatus);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('TaskManager enters degraded mode with unusable when StateStore construction fails after validation', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-tm-unusable-'));
  try {
    const filePath = path.join(tmpDir, 'file-barrier.txt');
    writeFileSync(filePath, 'barrier');
    const stateDir = path.join(filePath, 'sub-state-dir');

    const config = loadConfig({
      BRIDGE_STATE_DIRECTORY: stateDir,
      AGY_PATH: process.execPath,
    });
    assert.equal(config.stateDirectoryInvalid, undefined);
    assert.equal(config.stateDirectory, stateDir);

    const adapter = new CliAdapter(config);
    const tasks = new TaskManager(adapter, config);

    assert.equal(tasks.isStateDirectoryUsable(), false);
    assert.deepEqual(tasks.configurationIssues, [
      { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'unusable' },
    ]);
    assert.equal(JSON.stringify(tasks.configurationIssues).includes(stateDir), false);
    assert.equal(JSON.stringify(tasks.configurationIssues).includes('file-barrier.txt'), false);

    assert.throws(() => tasks.list(), { code: 'INVALID_STATE_DIRECTORY' });
    assert.deepEqual(await tasks.cleanup(), { discardedTaskIds: [] });
    await tasks.shutdown();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('TaskManager enters degraded mode with unusable when refresh throws after StateStore construction succeeds', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-tm-corrupt-refresh-'));
  const stateDir = path.join(tmpDir, 'state');
  mkdirSync(stateDir);
  const corruptedTaskId = randomUUID();
  writeFileSync(path.join(stateDir, `${corruptedTaskId}.json`), '{ invalid json syntax');

  try {
    const config = loadConfig({
      BRIDGE_STATE_DIRECTORY: stateDir,
      AGY_PATH: process.execPath,
    });
    assert.equal(config.stateDirectoryInvalid, undefined);
    assert.equal(config.stateDirectory, stateDir);

    const adapter = new CliAdapter(config);
    const tasks = new TaskManager(adapter, config);

    assert.equal(tasks.isStateDirectoryUsable(), false);
    assert.deepEqual(tasks.configurationIssues, [
      { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'unusable' },
    ]);
    assert.equal(JSON.stringify(tasks.configurationIssues).includes(stateDir), false);

    const internal = tasks as unknown as { stateStore?: unknown; tasks: Map<string, unknown> };
    assert.equal(internal.stateStore, undefined);
    assert.equal(internal.tasks.size, 0);

    assert.throws(() => tasks.list(), { code: 'INVALID_STATE_DIRECTORY' });
    assert.deepEqual(await tasks.cleanup(), { discardedTaskIds: [] });
    await tasks.shutdown();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('TaskManager enters degraded mode and discards events when refresh throws after emitting', async t => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-tm-refresh-event-discard-'));
  const stateDir = path.join(tmpDir, 'state');
  mkdirSync(stateDir);
  const taskId = randomUUID();
  const snapshot = {
    version: 1,
    ownerPid: 99999999,
    record: {
      taskId,
      workingDirectory: tmpDir,
      prompt: 'test prompt',
      status: 'running',
      createdAt: new Date().toISOString(),
    },
    options: {
      prompt: 'test prompt',
      workingDirectory: tmpDir,
    },
    events: [],
    cursor: 0,
  };
  writeFileSync(path.join(stateDir, `${taskId}.json`), JSON.stringify(snapshot));

  t.mock.method(StateStore.prototype, 'save', () => {
    throw new Error('disk failure during refresh save');
  });

  try {
    const config = loadConfig({
      BRIDGE_STATE_DIRECTORY: stateDir,
      AGY_PATH: process.execPath,
    });
    assert.equal(config.stateDirectoryInvalid, undefined);
    assert.equal(config.stateDirectory, stateDir);

    const adapter = new CliAdapter(config);
    const tasks = new TaskManager(adapter, config);

    assert.equal(tasks.isStateDirectoryUsable(), false);
    assert.deepEqual(tasks.configurationIssues, [
      { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'unusable' },
    ]);
    assert.equal(JSON.stringify(tasks.configurationIssues).includes(stateDir), false);

    const internal = tasks as unknown as { stateStore?: unknown; tasks: Map<string, unknown> };
    assert.equal(internal.stateStore, undefined);
    assert.equal(internal.tasks.size, 0);

    assert.equal(tasks.events.read(taskId).events.length, 0);
    assert.equal(tasks.events.snapshot(taskId).events.length, 0);

    assert.throws(() => tasks.list(), { code: 'INVALID_STATE_DIRECTORY' });
    assert.deepEqual(await tasks.cleanup(), { discardedTaskIds: [] });
    await tasks.shutdown();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('StateStore probeWritable leaves no probe file on normal execution', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-store-probe-'));
  try {
    const store = new StateStore(tmpDir);
    store.probeWritable();
    assert.deepEqual(readdirSync(tmpDir), []);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Normal server startup leaves no probe file in state directory', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-srv-normal-no-probe-'));
  const fakeHome = path.join(tmpDir, 'fake-home');
  const fakeCwd = path.join(tmpDir, 'fake-cwd');
  const stateDir = path.join(tmpDir, 'state');
  mkdirSync(fakeHome);
  mkdirSync(fakeCwd);
  mkdirSync(stateDir);

  let client: Client | undefined;
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entryPath],
      cwd: fakeCwd,
      env: {
        ...process.env as Record<string, string>,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        BRIDGE_ANTI_AI_CRAFT: 'off',
        BRIDGE_STATE_DIRECTORY: stateDir,
      },
    });

    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const healthResult = await client.callTool({ name: 'antigravity_health', arguments: {} });
    assert.equal(healthResult.isError, undefined);

    await client.close();
    client = undefined;

    const entries = readdirSync(stateDir);
    assert.equal(entries.some(name => name.includes('probe')), false);
  } finally {
    if (client) await client.close();
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('wait command refuses relative, NUL, and on win32 root-relative state directory with INVALID_STATE_DIRECTORY', async () => {
  const validId = '00000000-0000-0000-0000-000000000000';

  let outputRelative = '';
  const exitRelative = await runWaitCommand(
    ['--state-directory', 'relative-state-dir', validId],
    process.env,
    line => { outputRelative = line; },
  );
  assert.equal(exitRelative, 1);
  assert.equal(JSON.parse(outputRelative).outcome, 'error');
  assert.equal(JSON.parse(outputRelative).reason, 'INVALID_STATE_DIRECTORY');

  let outputNul = '';
  const exitNul = await runWaitCommand(
    ['--state-directory', '/tmp/state\0dir', validId],
    process.env,
    line => { outputNul = line; },
  );
  assert.equal(exitNul, 1);
  assert.equal(JSON.parse(outputNul).outcome, 'error');
  assert.equal(JSON.parse(outputNul).reason, 'INVALID_STATE_DIRECTORY');

  if (process.platform === 'win32') {
    let outputRootRel = '';
    const exitRootRel = await runWaitCommand(
      ['--state-directory', '\\root-relative-state', validId],
      process.env,
      line => { outputRootRel = line; },
    );
    assert.equal(exitRootRel, 1);
    assert.equal(JSON.parse(outputRootRel).outcome, 'error');
    assert.equal(JSON.parse(outputRootRel).reason, 'INVALID_STATE_DIRECTORY');

    let outputDriveRel = '';
    const exitDriveRel = await runWaitCommand(
      ['--state-directory', 'C:drive-relative-state', validId],
      process.env,
      line => { outputDriveRel = line; },
    );
    assert.equal(exitDriveRel, 1);
    assert.equal(JSON.parse(outputDriveRel).outcome, 'error');
    assert.equal(JSON.parse(outputDriveRel).reason, 'INVALID_STATE_DIRECTORY');

    let outputMalformed = '';
    const exitMalformed = await runWaitCommand(
      ['--state-directory', 'C:\\invalid?state', validId],
      process.env,
      line => { outputMalformed = line; },
    );
    assert.equal(exitMalformed, 1);
    assert.equal(JSON.parse(outputMalformed).outcome, 'error');
    assert.equal(JSON.parse(outputMalformed).reason, 'INVALID_STATE_DIRECTORY');
    assert.equal(outputMalformed.includes('invalid?state'), false);
    assert.equal(outputMalformed.includes('C:\\invalid?state'), false);

    let outputUncMalformed = '';
    const exitUncMalformed = await runWaitCommand(
      ['--state-directory', '\\\\server\\invalid?share\\state', validId],
      process.env,
      line => { outputUncMalformed = line; },
    );
    assert.equal(exitUncMalformed, 1);
    assert.equal(JSON.parse(outputUncMalformed).outcome, 'error');
    assert.equal(JSON.parse(outputUncMalformed).reason, 'INVALID_STATE_DIRECTORY');
    assert.equal(outputUncMalformed.includes('invalid?share'), false);
    assert.equal(outputUncMalformed.includes('\\\\server\\invalid?share\\state'), false);
  }
});

if (process.platform === 'win32') {
  test('Real server startup over stdio enters degraded mode on win32 malformed BRIDGE_STATE_DIRECTORY', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-srv-win-malformed-state-'));
    const fakeHome = path.join(tmpDir, 'fake-home');
    const fakeCwd = path.join(tmpDir, 'fake-cwd');
    mkdirSync(fakeHome);
    mkdirSync(fakeCwd);

    let client: Client | undefined;
    let stderr = '';
    try {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entryPath],
        cwd: fakeCwd,
        env: {
          ...process.env as Record<string, string>,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          BRIDGE_ANTI_AI_CRAFT: 'off',
          BRIDGE_STATE_DIRECTORY: 'C:\\invalid?state',
        },
        stderr: 'pipe',
      });
      transport.stderr?.on('data', chunk => {
        stderr += String(chunk);
      });

      client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      const healthResult = await client.callTool({ name: 'antigravity_health', arguments: {} });
      const health = healthResult.structuredContent as Record<string, unknown>;
      assert.deepEqual(health.configurationIssues, [
        { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'invalid-entry' },
      ]);
      assert.equal(health.waitCommand, undefined);

      const cleanupResult = await client.callTool({ name: 'antigravity_cleanup', arguments: {} });
      assert.equal(cleanupResult.isError, true);
      assert.match(JSON.stringify(cleanupResult), /INVALID_STATE_DIRECTORY/);

      const policyResult = await client.callTool({ name: 'antigravity_get_agent_policy', arguments: {} });
      assert.equal(policyResult.isError, true);
      assert.match(JSON.stringify(policyResult), /INVALID_STATE_DIRECTORY/);

      const tasksResult = await client.callTool({ name: 'antigravity_tasks', arguments: {} });
      assert.equal(tasksResult.isError, true);
      assert.match(JSON.stringify(tasksResult), /INVALID_STATE_DIRECTORY/);

      const rolesResult = await client.callTool({ name: 'antigravity_roles', arguments: {} });
      assert.equal(rolesResult.isError, undefined);
      assert.ok(Array.isArray((rolesResult.structuredContent as Record<string, unknown>).roles));

      const modelsResult = await client.callTool({ name: 'antigravity_list_models', arguments: {} });
      assert.equal(JSON.stringify(modelsResult).includes('INVALID_STATE_DIRECTORY'), false);

      await client.close();
      client = undefined;

      const stderrLines = stderr.trim().split(/\r?\n/).filter(Boolean);
      assert.equal(stderrLines.length, 1);
      assert.match(stderrLines[0]!, /^Invalid configuration entries were ignored/);
      assert.match(stderrLines[0]!, /BRIDGE_STATE_DIRECTORY invalid-entry/);
      assert.equal(stderr.includes('invalid?state'), false);
      assert.equal(stderr.includes('C:\\invalid?state'), false);

      assert.equal(existsSync(path.join(fakeHome, '.antigravity-mcp-bridge')), false);
      assert.deepEqual(readdirSync(fakeCwd), []);
    } finally {
      if (client) await client.close();
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test('Real server startup over stdio enters degraded mode on win32 malformed UNC BRIDGE_STATE_DIRECTORY', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-srv-win-unc-malformed-state-'));
    const fakeHome = path.join(tmpDir, 'fake-home');
    const fakeCwd = path.join(tmpDir, 'fake-cwd');
    mkdirSync(fakeHome);
    mkdirSync(fakeCwd);

    let client: Client | undefined;
    let stderr = '';
    try {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entryPath],
        cwd: fakeCwd,
        env: {
          ...process.env as Record<string, string>,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          BRIDGE_ANTI_AI_CRAFT: 'off',
          BRIDGE_STATE_DIRECTORY: '\\\\server\\invalid?share\\state',
        },
        stderr: 'pipe',
      });
      transport.stderr?.on('data', chunk => {
        stderr += String(chunk);
      });

      client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      const healthResult = await client.callTool({ name: 'antigravity_health', arguments: {} });
      const health = healthResult.structuredContent as Record<string, unknown>;
      assert.deepEqual(health.configurationIssues, [
        { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'invalid-entry' },
      ]);
      assert.equal(health.waitCommand, undefined);

      const cleanupResult = await client.callTool({ name: 'antigravity_cleanup', arguments: {} });
      assert.equal(cleanupResult.isError, true);
      assert.match(JSON.stringify(cleanupResult), /INVALID_STATE_DIRECTORY/);

      const policyResult = await client.callTool({ name: 'antigravity_get_agent_policy', arguments: {} });
      assert.equal(policyResult.isError, true);
      assert.match(JSON.stringify(policyResult), /INVALID_STATE_DIRECTORY/);

      const tasksResult = await client.callTool({ name: 'antigravity_tasks', arguments: {} });
      assert.equal(tasksResult.isError, true);
      assert.match(JSON.stringify(tasksResult), /INVALID_STATE_DIRECTORY/);

      const rolesResult = await client.callTool({ name: 'antigravity_roles', arguments: {} });
      assert.equal(rolesResult.isError, undefined);
      assert.ok(Array.isArray((rolesResult.structuredContent as Record<string, unknown>).roles));

      const modelsResult = await client.callTool({ name: 'antigravity_list_models', arguments: {} });
      assert.equal(JSON.stringify(modelsResult).includes('INVALID_STATE_DIRECTORY'), false);

      await client.close();
      client = undefined;

      const stderrLines = stderr.trim().split(/\r?\n/).filter(Boolean);
      assert.equal(stderrLines.length, 1);
      assert.match(stderrLines[0]!, /^Invalid configuration entries were ignored/);
      assert.match(stderrLines[0]!, /BRIDGE_STATE_DIRECTORY invalid-entry/);
      assert.equal(stderr.includes('invalid?share'), false);
      assert.equal(stderr.includes('\\\\server\\invalid?share\\state'), false);

      assert.equal(existsSync(path.join(fakeHome, '.antigravity-mcp-bridge')), false);
      assert.deepEqual(readdirSync(fakeCwd), []);
    } finally {
      if (client) await client.close();
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test('Real server startup over stdio and wait command enter degraded mode on win32 256-character component without creating parent', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-srv-win-overlong-'));
    const fakeHome = path.join(tmpDir, 'fake-home');
    const fakeCwd = path.join(tmpDir, 'fake-cwd');
    const parentDir = path.join(tmpDir, 'parent-must-not-be-created');
    const overlongDir = path.join(parentDir, 'a'.repeat(256));
    mkdirSync(fakeHome);
    mkdirSync(fakeCwd);

    let client: Client | undefined;
    let stderr = '';
    try {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entryPath],
        cwd: fakeCwd,
        env: {
          ...process.env as Record<string, string>,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          BRIDGE_ANTI_AI_CRAFT: 'off',
          BRIDGE_STATE_DIRECTORY: overlongDir,
        },
        stderr: 'pipe',
      });
      transport.stderr?.on('data', chunk => {
        stderr += String(chunk);
      });

      client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      const healthResult = await client.callTool({ name: 'antigravity_health', arguments: {} });
      const health = healthResult.structuredContent as Record<string, unknown>;
      assert.deepEqual(health.configurationIssues, [
        { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'invalid-entry' },
      ]);
      assert.equal(health.waitCommand, undefined);

      const cleanupResult = await client.callTool({ name: 'antigravity_cleanup', arguments: {} });
      assert.equal(cleanupResult.isError, true);
      assert.match(JSON.stringify(cleanupResult), /INVALID_STATE_DIRECTORY/);

      const policyResult = await client.callTool({ name: 'antigravity_get_agent_policy', arguments: {} });
      assert.equal(policyResult.isError, true);
      assert.match(JSON.stringify(policyResult), /INVALID_STATE_DIRECTORY/);

      const tasksResult = await client.callTool({ name: 'antigravity_tasks', arguments: {} });
      assert.equal(tasksResult.isError, true);
      assert.match(JSON.stringify(tasksResult), /INVALID_STATE_DIRECTORY/);

      const rolesResult = await client.callTool({ name: 'antigravity_roles', arguments: {} });
      assert.equal(rolesResult.isError, undefined);
      assert.ok(Array.isArray((rolesResult.structuredContent as Record<string, unknown>).roles));

      const modelsResult = await client.callTool({ name: 'antigravity_list_models', arguments: {} });
      assert.equal(JSON.stringify(modelsResult).includes('INVALID_STATE_DIRECTORY'), false);

      await client.close();
      client = undefined;

      const stderrLines = stderr.trim().split(/\r?\n/).filter(Boolean);
      assert.equal(stderrLines.length, 1);
      assert.match(stderrLines[0]!, /^Invalid configuration entries were ignored/);
      assert.match(stderrLines[0]!, /BRIDGE_STATE_DIRECTORY invalid-entry/);
      assert.equal(stderr.includes('a'.repeat(256)), false);
      assert.equal(stderr.includes(parentDir), false);

      assert.equal(existsSync(parentDir), false);

      const validId = '00000000-0000-0000-0000-000000000000';
      let outputWait = '';
      const exitWait = await runWaitCommand(
        ['--state-directory', overlongDir, validId],
        process.env,
        line => { outputWait = line; },
      );
      assert.equal(exitWait, 1);
      assert.equal(JSON.parse(outputWait).outcome, 'error');
      assert.equal(JSON.parse(outputWait).reason, 'INVALID_STATE_DIRECTORY');
      assert.equal(outputWait.includes('a'.repeat(256)), false);
      assert.equal(existsSync(parentDir), false);
    } finally {
      if (client) await client.close();
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  function restoreAcl(directory: string, user: string): void {
    try {
      execFileSync('icacls', [directory, '/remove:d', user]);
    } catch (error) {
      const output = execFileSync('icacls', [directory], { encoding: 'utf8' });
      const userPattern = user.replace(/\\/g, '\\\\');
      const hasDeny = new RegExp(`${userPattern}:.*\\(DENY\\)`, 'i').test(output);
      if (hasDeny) throw error;
    }
  }

  test('Real server startup over stdio enters degraded mode on win32 when state directory listing is denied', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-srv-win-acl-rd-'));
    const fakeHome = path.join(tmpDir, 'fake-home');
    const fakeCwd = path.join(tmpDir, 'fake-cwd');
    const stateDir = path.join(tmpDir, 'state');
    mkdirSync(fakeHome);
    mkdirSync(fakeCwd);
    mkdirSync(stateDir);

    const currentUser = execFileSync('whoami', { encoding: 'utf8' }).trim();
    let client: Client | undefined;
    let stderr = '';
    try {
      execFileSync('icacls', [stateDir, '/deny', `${currentUser}:(OI)(CI)(RD)`]);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entryPath],
        cwd: fakeCwd,
        env: {
          ...process.env as Record<string, string>,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          BRIDGE_ANTI_AI_CRAFT: 'off',
          BRIDGE_STATE_DIRECTORY: stateDir,
        },
        stderr: 'pipe',
      });
      transport.stderr?.on('data', chunk => {
        stderr += String(chunk);
      });

      client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      const healthResult = await client.callTool({ name: 'antigravity_health', arguments: {} });
      const health = healthResult.structuredContent as Record<string, unknown>;
      assert.deepEqual(health.configurationIssues, [
        { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'unusable' },
      ]);
      assert.equal(health.waitCommand, undefined);

      const cleanupResult = await client.callTool({ name: 'antigravity_cleanup', arguments: {} });
      assert.equal(cleanupResult.isError, true);
      assert.match(JSON.stringify(cleanupResult), /INVALID_STATE_DIRECTORY/);

      const policyResult = await client.callTool({ name: 'antigravity_get_agent_policy', arguments: {} });
      assert.equal(policyResult.isError, true);
      assert.match(JSON.stringify(policyResult), /INVALID_STATE_DIRECTORY/);

      const tasksResult = await client.callTool({ name: 'antigravity_tasks', arguments: {} });
      assert.equal(tasksResult.isError, true);
      assert.match(JSON.stringify(tasksResult), /INVALID_STATE_DIRECTORY/);

      const rolesResult = await client.callTool({ name: 'antigravity_roles', arguments: {} });
      assert.equal(rolesResult.isError, undefined);
      assert.ok(Array.isArray((rolesResult.structuredContent as Record<string, unknown>).roles));

      const modelsResult = await client.callTool({ name: 'antigravity_list_models', arguments: {} });
      assert.equal(JSON.stringify(modelsResult).includes('INVALID_STATE_DIRECTORY'), false);

      await client.close();
      client = undefined;

      const stderrLines = stderr.trim().split(/\r?\n/).filter(Boolean);
      assert.equal(stderrLines.length, 1);
      assert.match(stderrLines[0]!, /^Invalid configuration entries were ignored/);
      assert.match(stderrLines[0]!, /BRIDGE_STATE_DIRECTORY unusable/);
      assert.equal(stderr.includes(stateDir), false);
      assert.equal(/EPERM|EACCES|error|exception/i.test(stderr), false);
    } finally {
      try {
        restoreAcl(stateDir, currentUser);
        const entries = readdirSync(stateDir);
        assert.equal(entries.some(name => name.includes('probe')), false);
        assert.deepEqual(entries, []);
      } finally {
        if (client) await client.close();
        rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  });

  test('Real server startup over stdio enters degraded mode on win32 when state directory file writing is denied', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-srv-win-acl-wd-'));
    const fakeHome = path.join(tmpDir, 'fake-home');
    const fakeCwd = path.join(tmpDir, 'fake-cwd');
    const stateDir = path.join(tmpDir, 'state');
    mkdirSync(fakeHome);
    mkdirSync(fakeCwd);
    mkdirSync(stateDir);

    const currentUser = execFileSync('whoami', { encoding: 'utf8' }).trim();
    let client: Client | undefined;
    let stderr = '';
    try {
      execFileSync('icacls', [stateDir, '/deny', `${currentUser}:(OI)(CI)(WD)`]);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entryPath],
        cwd: fakeCwd,
        env: {
          ...process.env as Record<string, string>,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          BRIDGE_ANTI_AI_CRAFT: 'off',
          BRIDGE_STATE_DIRECTORY: stateDir,
        },
        stderr: 'pipe',
      });
      transport.stderr?.on('data', chunk => {
        stderr += String(chunk);
      });

      client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      const healthResult = await client.callTool({ name: 'antigravity_health', arguments: {} });
      const health = healthResult.structuredContent as Record<string, unknown>;
      assert.deepEqual(health.configurationIssues, [
        { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'unusable' },
      ]);
      assert.equal(health.waitCommand, undefined);

      const cleanupResult = await client.callTool({ name: 'antigravity_cleanup', arguments: {} });
      assert.equal(cleanupResult.isError, true);
      assert.match(JSON.stringify(cleanupResult), /INVALID_STATE_DIRECTORY/);

      const policyResult = await client.callTool({ name: 'antigravity_get_agent_policy', arguments: {} });
      assert.equal(policyResult.isError, true);
      assert.match(JSON.stringify(policyResult), /INVALID_STATE_DIRECTORY/);

      const tasksResult = await client.callTool({ name: 'antigravity_tasks', arguments: {} });
      assert.equal(tasksResult.isError, true);
      assert.match(JSON.stringify(tasksResult), /INVALID_STATE_DIRECTORY/);

      const rolesResult = await client.callTool({ name: 'antigravity_roles', arguments: {} });
      assert.equal(rolesResult.isError, undefined);
      assert.ok(Array.isArray((rolesResult.structuredContent as Record<string, unknown>).roles));

      const modelsResult = await client.callTool({ name: 'antigravity_list_models', arguments: {} });
      assert.equal(JSON.stringify(modelsResult).includes('INVALID_STATE_DIRECTORY'), false);

      await client.close();
      client = undefined;

      const stderrLines = stderr.trim().split(/\r?\n/).filter(Boolean);
      assert.equal(stderrLines.length, 1);
      assert.match(stderrLines[0]!, /^Invalid configuration entries were ignored/);
      assert.match(stderrLines[0]!, /BRIDGE_STATE_DIRECTORY unusable/);
      assert.equal(stderr.includes(stateDir), false);
      assert.equal(/EPERM|EACCES|error|exception/i.test(stderr), false);
    } finally {
      try {
        restoreAcl(stateDir, currentUser);
        const entries = readdirSync(stateDir);
        assert.equal(entries.some(name => name.includes('probe')), false);
        assert.deepEqual(entries, []);
      } finally {
        if (client) await client.close();
        rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  });

  test('Real server startup over stdio enters degraded mode on win32 when running task exists and write is denied', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-srv-win-acl-running-'));
    const fakeHome = path.join(tmpDir, 'fake-home');
    const fakeCwd = path.join(tmpDir, 'fake-cwd');
    const stateDir = path.join(tmpDir, 'state');
    mkdirSync(fakeHome);
    mkdirSync(fakeCwd);
    mkdirSync(stateDir);

    const taskId = randomUUID();
    const initialSnapshot = {
      version: 1,
      ownerPid: 99999999,
      record: {
        taskId,
        workingDirectory: fakeCwd,
        prompt: 'test prompt',
        status: 'running',
        createdAt: new Date().toISOString(),
      },
      options: {
        prompt: 'test prompt',
        workingDirectory: fakeCwd,
      },
      events: [],
      cursor: 0,
    };
    const snapshotFile = path.join(stateDir, `${taskId}.json`);
    const snapshotContent = JSON.stringify(initialSnapshot, null, 2);
    writeFileSync(snapshotFile, snapshotContent);

    const currentUser = execFileSync('whoami', { encoding: 'utf8' }).trim();
    let client: Client | undefined;
    let stderr = '';
    try {
      execFileSync('icacls', [stateDir, '/deny', `${currentUser}:(OI)(CI)(WD)`]);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entryPath],
        cwd: fakeCwd,
        env: {
          ...process.env as Record<string, string>,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          BRIDGE_ANTI_AI_CRAFT: 'off',
          BRIDGE_STATE_DIRECTORY: stateDir,
        },
        stderr: 'pipe',
      });
      transport.stderr?.on('data', chunk => {
        stderr += String(chunk);
      });

      client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      const healthResult = await client.callTool({ name: 'antigravity_health', arguments: {} });
      const health = healthResult.structuredContent as Record<string, unknown>;
      assert.deepEqual(health.configurationIssues, [
        { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'unusable' },
      ]);
      assert.equal(health.waitCommand, undefined);

      const tasksResult = await client.callTool({ name: 'antigravity_tasks', arguments: {} });
      assert.equal(tasksResult.isError, true);
      assert.match(JSON.stringify(tasksResult), /INVALID_STATE_DIRECTORY/);

      const eventsResult = await client.callTool({ name: 'antigravity_events', arguments: { taskId } });
      assert.equal(eventsResult.isError, true);
      assert.match(JSON.stringify(eventsResult), /INVALID_STATE_DIRECTORY/);

      await client.close();
      client = undefined;

      const stderrLines = stderr.trim().split(/\r?\n/).filter(Boolean);
      assert.equal(stderrLines.length, 1);
      assert.match(stderrLines[0]!, /^Invalid configuration entries were ignored/);
      assert.match(stderrLines[0]!, /BRIDGE_STATE_DIRECTORY unusable/);
      assert.equal(stderr.includes(stateDir), false);
      assert.equal(/EPERM|EACCES|error|exception|task\.failed|SERVER_RESTARTED/i.test(stderr), false);

      assert.equal(readFileSync(snapshotFile, 'utf8'), snapshotContent);
    } finally {
      try {
        restoreAcl(stateDir, currentUser);
        const entries = readdirSync(stateDir);
        assert.equal(entries.some(name => name.includes('probe')), false);
        assert.deepEqual(entries, [`${taskId}.json`]);
      } finally {
        if (client) await client.close();
        rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  });

  test('Startup with deny-read ACL leaves no probe file after ACL is restored', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-srv-win-acl-no-probe-'));
    const fakeHome = path.join(tmpDir, 'fake-home');
    const fakeCwd = path.join(tmpDir, 'fake-cwd');
    const stateDir = path.join(tmpDir, 'state');
    mkdirSync(fakeHome);
    mkdirSync(fakeCwd);
    mkdirSync(stateDir);

    const currentUser = execFileSync('whoami', { encoding: 'utf8' }).trim();
    let client: Client | undefined;
    try {
      execFileSync('icacls', [stateDir, '/deny', `${currentUser}:(OI)(CI)(RD)`]);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entryPath],
        cwd: fakeCwd,
        env: {
          ...process.env as Record<string, string>,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          BRIDGE_ANTI_AI_CRAFT: 'off',
          BRIDGE_STATE_DIRECTORY: stateDir,
        },
      });

      client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      const healthResult = await client.callTool({ name: 'antigravity_health', arguments: {} });
      const health = healthResult.structuredContent as Record<string, unknown>;
      assert.deepEqual(health.configurationIssues, [
        { variable: 'BRIDGE_STATE_DIRECTORY', reason: 'unusable' },
      ]);

      await client.close();
      client = undefined;
    } finally {
      try {
        restoreAcl(stateDir, currentUser);
        const entries = readdirSync(stateDir);
        assert.equal(entries.some(name => name.includes('probe')), false);
        assert.deepEqual(entries, []);
      } finally {
        if (client) await client.close();
        rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  });
}
