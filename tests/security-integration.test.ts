import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { loadConfig } from '../src/config.js';
import { TaskManager } from '../src/task-manager.js';
import { StateStore } from '../src/state-store.js';
import { createMcpServer } from '../src/mcp-server.js';
import type { TaskRecord } from '../src/types.js';

if (process.platform === 'win32') {
  const dir = fileURLToPath(new URL('../../tests/.git-runtime/bin', import.meta.url));
  const gitExe = path.join(dir, 'git.exe');
  if (existsSync(gitExe)) {
    process.env.PATH = dir + path.delimiter + (process.env.PATH ?? '');
    process.env.GIT_EXEC_PATH = dir;
  }
}

const fixturePath = fileURLToPath(new URL('../../tests/security-integration-fixture.mjs', import.meta.url));
const stateDirectories: string[] = [];
const managers: TaskManager[] = [];
const cleanupDirs: string[] = [];

after(async () => {
  for (const manager of managers) {
    await manager.shutdown().catch(() => {});
  }
  for (const dir of stateDirectories) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-sec-test-repo-'));
  cleanupDirs.push(dir);
  execFileSync('git', ['init', '--quiet', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Security Test']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'sec@test.local']);
  await writeFile(path.join(dir, 'source.txt'), 'console.log("hello security");\n');
  return dir;
}

function setup(prefixArgs: string[], configOverrides: Record<string, string> = {}) {
  const stateDirectory = mkdtempSync(path.join(os.tmpdir(), 'agy-sec-state-'));
  stateDirectories.push(stateDirectory);
  const config = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off',
    AGY_PATH: process.execPath,
    DEFAULT_TIMEOUT_SECONDS: '5',
    BRIDGE_TEST_EXECUTOR: 'agy',
    BRIDGE_STATE_DIRECTORY: stateDirectory,
    ...configOverrides,
  });
  const adapter = new CliAdapter(config, prefixArgs);
  const tasks = new TaskManager(adapter, config);
  managers.push(tasks);
  return { adapter, tasks, config };
}

async function until(
  tasks: TaskManager,
  taskId: string,
  predicate: (record: TaskRecord) => boolean,
  timeout = 30000
): Promise<TaskRecord> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const task = tasks.status(taskId);
    if (predicate(task)) return task;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for task: ${JSON.stringify(tasks.status(taskId))}`);
}

const done = (task: TaskRecord) =>
  ['completed', 'failed', 'cancelled', 'timeout'].includes(task.status);

test('CliAdapter filters environment in probes, models, and spawnTask, preserving required vars and config extensions', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agy-sec-adapter-'));
  cleanupDirs.push(tempDir);
  const stateDirectory = mkdtempSync(path.join(os.tmpdir(), 'agy-sec-state-'));
  stateDirectories.push(stateDirectory);
  const reportFile = path.join(tempDir, 'env-audit.jsonl');

  const originalSecret = process.env.THIRD_PARTY_SECRET;
  const originalNodeOpts = process.env.NODE_OPTIONS;
  const originalCustom = process.env.MY_SAFE_EXTENSION_VAR;

  try {
    process.env.THIRD_PARTY_SECRET = 'synthetic-secret-token-do-not-leak';
    process.env.NODE_OPTIONS = '--max-old-space-size=4096';
    process.env.MY_SAFE_EXTENSION_VAR = 'public-allowed-value';

    const config = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off',
      AGY_PATH: process.execPath,
      DEFAULT_TIMEOUT_SECONDS: '5',
      BRIDGE_TEST_EXECUTOR: 'agy',
      BRIDGE_STATE_DIRECTORY: stateDirectory,
      BRIDGE_ALLOWED_ENV_VARS: JSON.stringify(['MY_SAFE_EXTENSION_VAR']),
    });
    const adapter = new CliAdapter(config, [fixturePath, '--report', reportFile]);

    const discovery = await adapter.discover();
    assert.equal(discovery.installed, true, discovery.error ?? 'CLI discovery failed');

    const models = await adapter.listModels();
    assert.ok(models.length > 0);

    const child = adapter.spawnTask(
      { prompt: 'test:env', workingDirectory: tempDir },
      undefined,
      tempDir
    );

    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });

    await new Promise<void>(resolve => {
      child.once('close', () => resolve());
    });

    const lines = readFileSync(reportFile, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line));

    assert.ok(lines.length >= 3, 'Expected at least version/help, models, and task invocations');

    for (const record of lines) {
      assert.equal(record.hasThirdPartySecret, false, `Third-party secret was not filtered in ${record.op}`);
      assert.equal(record.hasNodeOptions, false, `NODE_OPTIONS was not filtered in ${record.op}`);
      assert.equal(record.hasAllowedVar, true, `Allowed custom var was missing in ${record.op}`);
      assert.equal(record.hasPath, true, `PATH was missing in ${record.op}`);
      if (process.platform === 'win32') {
        assert.equal(record.hasSystemRoot, true, `SystemRoot was missing on Windows in ${record.op}`);
        assert.equal(record.hasPathExt, true, `PATHEXT was missing on Windows in ${record.op}`);
      }
    }

    const resultLine = stdout
      .split(/\r?\n/)
      .find(l => l.includes('"event":"result"'));
    assert.ok(resultLine, 'Result event emitted on stdout');
    const parsed = JSON.parse(resultLine);
    const taskObs = JSON.parse(parsed.result.response);
    assert.equal(taskObs.hasThirdPartySecret, false);
    assert.equal(taskObs.hasNodeOptions, false);
    assert.equal(taskObs.hasAllowedVar, true);
    assert.equal(taskObs.hasPath, true);
  } finally {
    if (originalSecret !== undefined) process.env.THIRD_PARTY_SECRET = originalSecret;
    else delete process.env.THIRD_PARTY_SECRET;

    if (originalNodeOpts !== undefined) process.env.NODE_OPTIONS = originalNodeOpts;
    else delete process.env.NODE_OPTIONS;

    if (originalCustom !== undefined) process.env.MY_SAFE_EXTENSION_VAR = originalCustom;
    else delete process.env.MY_SAFE_EXTENSION_VAR;
  }
});

test('Custom exclusion and exception in TaskManager and MCP agree with copy eligibility', async () => {
  const repoDir = await createRepo();

  await mkdir(path.join(repoDir, 'confidential'), { recursive: true });
  await writeFile(path.join(repoDir, 'confidential', 'secret.txt'), 'CONFIDENTIAL_SECRET\n');
  await writeFile(path.join(repoDir, 'confidential', 'allowed.txt'), 'ALLOWED_DOC\n');
  await writeFile(path.join(repoDir, '.env.local'), 'PORT=3000\nDATABASE_URL=test\n');
  await writeFile(path.join(repoDir, '.env'), 'TOKEN=secret-local-token\n');

  await mkdir(path.join(repoDir, 'fixtures'));
  const syntheticKeyBody = 'BRIDGE_SYNTHETIC_NOT_A_USABLE_KEY';
  await writeFile(path.join(repoDir, 'fixtures', '.env.local'),
    '-----BEGIN PRIVATE KEY-----\n' + syntheticKeyBody + '\n-----END PRIVATE KEY-----\n');
  const namePatterns = ['.env.local', 'confidential/allowed.txt', '.env'];
  const legacySetup = setup([fixturePath], {
    BRIDGE_SECRET_EXCEPTIONS: JSON.stringify(namePatterns),
  });
  assert.deepEqual(legacySetup.config.secretExceptions, { version: 2, namePatterns: [] });
  assert.deepEqual(legacySetup.tasks.configurationIssues, [
    { variable: 'BRIDGE_SECRET_EXCEPTIONS', reason: 'legacy-format' },
  ]);

  const { adapter, tasks } = setup([fixturePath], {
    BRIDGE_SECRET_EXCLUSIONS: JSON.stringify(['confidential/**', '.env']),
    BRIDGE_SECRET_EXCEPTIONS: JSON.stringify({ version: 2, namePatterns }),
  });

  await adapter.discover();

  const expectedEligible = ['.env.local', 'source.txt'];

  const listed = await tasks.listProjectFiles(repoDir);
  assert.deepEqual(listed, expectedEligible);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpServer = createMcpServer(adapter, tasks);
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: 'test-mcp-client', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    const mcpResult = await client.callTool({
      name: 'antigravity_list_project_files',
      arguments: { workingDirectory: repoDir },
    });
    assert.equal(mcpResult.isError, undefined);
    assert.deepEqual(mcpResult.structuredContent, { files: expectedEligible });
  } finally {
    await client.close();
    await mcpServer.close();
  }

  const task = await tasks.run({ prompt: 'test:copy', workingDirectory: repoDir });
  const finished = await until(tasks, task.taskId, done);
  assert.equal(finished.status, 'completed');

  assert.deepEqual(finished.includedFiles?.slice().sort(), expectedEligible);
  assert.deepEqual(listed, finished.includedFiles?.slice().sort());

  const events = tasks.readEvents(task.taskId).events;
  const copyReady = events.find(e => e.type === 'copy.ready');
  assert.ok(copyReady, 'copy.ready event was emitted');

  const data = copyReady.data as {
    copyDirectory: string;
    blockedFiles: Array<{ path: string; reason: string }>;
  };
  assert.ok(Array.isArray(data.blockedFiles));
  assert.ok(data.blockedFiles.length >= 4);
  assert.ok(data.blockedFiles.some(b => b.path === 'fixtures/.env.local' && b.reason === 'SECRET_CONTENT'));

  const blockedPaths = data.blockedFiles.map(b => b.path).sort();
  assert.ok(blockedPaths.includes('.env'));
  assert.ok(blockedPaths.includes('confidential/allowed.txt'));
  assert.ok(blockedPaths.includes('confidential/secret.txt'));
  assert.ok(!blockedPaths.includes('.env.local'));
  assert.ok(!blockedPaths.includes('source.txt'));

  for (const blocked of data.blockedFiles) {
    assert.deepEqual(Object.keys(blocked).sort(), ['path', 'reason']);
    assert.equal(typeof blocked.path, 'string');
    assert.ok(
      ['SECRET_FILE', 'SECRET_CONTENT', 'SECRET_EXCLUSION', 'UNSAFE_PATH'].includes(blocked.reason)
    );
  }

  const eventPayload = JSON.stringify(copyReady);
  assert.equal(eventPayload.includes('CONFIDENTIAL_SECRET'), false);
  assert.equal(eventPayload.includes('secret-local-token'), false);
  assert.equal(eventPayload.includes(syntheticKeyBody), false);
});

test('StateStore restart and resume preserves task metadata including blockedFiles without data leakage', async () => {
  const repoDir = await createRepo();

  await writeFile(path.join(repoDir, 'token.secret'), 'FORBIDDEN_TOKEN\n');
  await writeFile(path.join(repoDir, '.env'), 'API_KEY=synthetic-key\n');

  const { adapter, tasks, config } = setup([fixturePath], {
    BRIDGE_SECRET_EXCLUSIONS: JSON.stringify(['**/*.secret']),
  });

  await adapter.discover();

  const task = await tasks.run({ prompt: 'test:persist', workingDirectory: repoDir });
  const finished = await until(tasks, task.taskId, done);
  assert.equal(finished.status, 'completed');

  const store = new StateStore(config.stateDirectory);
  const loaded = store.load();
  const storedTask = loaded.find(t => t.record.taskId === task.taskId);
  assert.ok(storedTask, 'Stored task loaded');
  assert.ok(storedTask.project?.blockedFiles, 'Project copy retained blockedFiles');
  assert.ok(storedTask.project.blockedFiles.length >= 2);

  for (const blocked of storedTask.project.blockedFiles) {
    assert.deepEqual(Object.keys(blocked).sort(), ['path', 'reason']);
    assert.ok(
      ['SECRET_FILE', 'SECRET_CONTENT', 'SECRET_EXCLUSION', 'UNSAFE_PATH'].includes(blocked.reason)
    );
  }

  const restoredManager = new TaskManager(adapter, config);
  managers.push(restoredManager);
  const status = restoredManager.status(task.taskId);
  assert.equal(status.status, 'completed');
  assert.ok(status.sessionId);

  const resumed = await restoredManager.run({
    prompt: 'test:resume',
    workingDirectory: repoDir,
    sessionId: status.sessionId,
  });
  const resumedFinished = await until(restoredManager, resumed.taskId, done);
  assert.equal(resumedFinished.status, 'completed');
  assert.equal(resumedFinished.copyDirectory, status.copyDirectory);
});

test('StateStore maintains backward compatibility with legacy snapshots missing blockedFiles', async () => {
  const repoDir = await createRepo();
  const { adapter, tasks, config } = setup([fixturePath]);
  await adapter.discover();

  const task = await tasks.run({ prompt: 'test:legacy', workingDirectory: repoDir });
  const finished = await until(tasks, task.taskId, done);
  assert.equal(finished.status, 'completed');

  const store = new StateStore(config.stateDirectory);
  const taskFilePath = path.join(config.stateDirectory, `${task.taskId}.json`);
  const raw = JSON.parse(readFileSync(taskFilePath, 'utf8'));

  if (raw.project && raw.project.blockedFiles) {
    delete raw.project.blockedFiles;
    writeFileSync(taskFilePath, JSON.stringify(raw), 'utf8');
  }

  const loaded = store.load();
  const loadedTask = loaded.find(t => t.record.taskId === task.taskId);
  assert.ok(loadedTask, 'Legacy task without blockedFiles loaded successfully');
  assert.equal(loadedTask.project?.blockedFiles, undefined);
});
