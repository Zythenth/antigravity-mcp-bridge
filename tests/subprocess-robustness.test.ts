import assert from 'node:assert/strict';
import child_process, { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, mock, test } from 'node:test';
import { CliAdapter } from '../src/cli-adapter.js';
import { loadConfig } from '../src/config.js';
import { TaskManager } from '../src/task-manager.js';
import type { TaskRecord } from '../src/types.js';
import { redactDiagnostic, processError } from '../src/subprocess.js';
import { randomUUID } from 'node:crypto';

const fixturePath = fileURLToPath(new URL('../../tests/subprocess-fixtures.mjs', import.meta.url));

if (process.platform === 'win32') {
  const gitRuntimeBin = fileURLToPath(new URL('../../tests/.git-runtime/bin', import.meta.url));
  const gitRuntimeExe = path.join(gitRuntimeBin, 'git.exe');
  if (existsSync(gitRuntimeExe)) {
    process.env.PATH = process.env.PATH ? `${gitRuntimeBin}${path.delimiter}${process.env.PATH}` : gitRuntimeBin;
    process.env.GIT_EXEC_PATH = gitRuntimeBin;
  }
}

const stateDirectories: string[] = [];
const repositories: string[] = [];
const managers: TaskManager[] = [];

function setup(prefixArgs = [fixturePath], configOverrides: Record<string, string> = {}) {
  const stateDirectory = mkdtempSync(path.join(os.tmpdir(), 'agy-sub-state-test-'));
  stateDirectories.push(stateDirectory);
  const config = loadConfig({
    AGY_PATH: process.execPath,
    DEFAULT_TIMEOUT_SECONDS: '2',
    BRIDGE_TEST_EXECUTOR: 'agy',
    BRIDGE_STATE_DIRECTORY: stateDirectory,
    MAX_PROMPT_CHARS: '1000000',
    ...configOverrides,
  });
  const adapter = new CliAdapter(config, prefixArgs);
  const tasks = new TaskManager(adapter, config);
  managers.push(tasks);
  return { adapter, tasks, config };
}

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-sub-repo-test-'));
  repositories.push(dir);
  execFileSync('git', ['init', '--quiet', dir]);
  await writeFile(path.join(dir, 'source.txt'), 'source content\n');
  return dir;
}

const done = (task: TaskRecord) => ['completed', 'failed', 'cancelled', 'timeout'].includes(task.status);

async function until(tasks: TaskManager, taskId: string, predicate: (record: TaskRecord) => boolean, timeout = 10000): Promise<TaskRecord> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const task = tasks.status(taskId);
    if (predicate(task)) return task;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for task: ${JSON.stringify(tasks.status(taskId))}`);
}

after(async () => {
  const cleanupErrors: unknown[] = [];
  for (const tasks of managers) {
    try {
      await tasks.shutdown();
    } catch (err) {
      cleanupErrors.push(err);
    }
    for (const task of tasks.list()) {
      if (done(task)) {
        try {
          await tasks.discard(task.taskId);
        } catch (err) {
          cleanupErrors.push(err);
        }
      }
    }
  }
  for (const dir of stateDirectories) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      cleanupErrors.push(err);
    }
  }
  for (const repo of repositories) {
    try {
      await rm(repo, { recursive: true, force: true });
    } catch (err) {
      cleanupErrors.push(err);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `Cleanup failed with ${cleanupErrors.length} errors`);
  }
});

test('discover reports AGY_NOT_FOUND when executable is missing', async () => {
  const missingPath = path.join(os.tmpdir(), 'non-existent-agy-' + randomUUID());
  const adapter = new CliAdapter(loadConfig({ AGY_PATH: missingPath }));
  const result = await adapter.discover();
  assert.equal(result.installed, false);
  assert.equal(result.version, undefined);
  assert.ok(result.error?.includes('AGY_NOT_FOUND'), `Expected AGY_NOT_FOUND error, got: ${result.error}`);
  assert.equal(result.capabilities.streaming, false);
  assert.equal(result.capabilities.sandbox, false);
});

test('discover reports AGY_PERMISSION_DENIED when spawn fails with EACCES or EPERM', async () => {
  for (const code of ['EACCES', 'EPERM'] as const) {
    const permErr = Object.assign(new Error(`spawn ${code}`), { code });
    const mockSpawn = mock.method(child_process, 'spawn', () => {
      const proc = new child_process.ChildProcess();
      mock.method(proc, 'kill', () => true);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      proc.stdout = stdout;
      proc.stderr = stderr;
      process.nextTick(() => {
        proc.emit('error', permErr);
        stdout.end();
        stderr.end();
        proc.emit('close', null, null);
      });
      return proc;
    });
    syncBuiltinESMExports();
    try {
      const adapter = new CliAdapter(loadConfig({ AGY_PATH: `/mock/denied/${code.toLowerCase()}` }));
      const result = await adapter.discover();
      assert.equal(result.installed, false);
      assert.ok(result.error?.includes('AGY_PERMISSION_DENIED'), `Expected AGY_PERMISSION_DENIED error for ${code}, got: ${result.error}`);
      assert.equal(result.capabilities.streaming, false);
    } finally {
      mockSpawn.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test('discover reports AGY_PERMISSION_DENIED on POSIX when file permissions are denied', { skip: process.platform === 'win32' }, async () => {
  const dir = await createRepo();
  const filePath = path.join(dir, 'denied-agy.sh');
  await writeFile(filePath, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  const adapter = new CliAdapter(loadConfig({ AGY_PATH: filePath }));
  const result = await adapter.discover();
  assert.equal(result.installed, false);
  assert.ok(result.error?.includes('AGY_PERMISSION_DENIED'), `Expected AGY_PERMISSION_DENIED error, got: ${result.error}`);
  assert.equal(result.capabilities.streaming, false);
});

test('discover reports AGY_PROBE_FAILED when --version exits with nonzero code (confirmed reproduction)', async () => {
  const { adapter } = setup([fixturePath, '--scenario', 'version-fail']);
  const result = await adapter.discover();
  assert.equal(result.installed, false);
  assert.equal(result.version, undefined);
  assert.ok(result.error?.includes('AGY_PROBE_FAILED'), `Expected AGY_PROBE_FAILED, got: ${result.error}`);
  assert.ok(result.error?.includes('9'), `Expected exit code 9 mentioned in error, got: ${result.error}`);
  assert.equal(result.capabilities.streaming, false);
});

test('discover reports AGY_PROBE_FAILED when --help exits with nonzero code', async () => {
  const { adapter } = setup([fixturePath, '--scenario', 'help-fail']);
  const result = await adapter.discover();
  assert.equal(result.installed, false);
  assert.ok(result.error?.includes('AGY_PROBE_FAILED'), `Expected AGY_PROBE_FAILED, got: ${result.error}`);
  assert.ok(result.error?.includes('2'), `Expected exit code 2 mentioned in error, got: ${result.error}`);
  assert.equal(result.capabilities.streaming, false);
});

test('discover reports AGY_INCOMPATIBLE when --version produces empty output', async () => {
  const { adapter } = setup([fixturePath, '--scenario', 'empty-version']);
  const result = await adapter.discover();
  assert.equal(result.installed, false);
  assert.ok(result.error?.includes('AGY_INCOMPATIBLE'), `Expected AGY_INCOMPATIBLE, got: ${result.error}`);
});

test('discover reports AGY_INCOMPATIBLE when --help produces empty or incompatible output', async () => {
  const { adapter } = setup([fixturePath, '--scenario', 'incompatible-help']);
  const result = await adapter.discover();
  assert.equal(result.installed, false);
  assert.ok(result.error?.includes('AGY_INCOMPATIBLE'), `Expected AGY_INCOMPATIBLE, got: ${result.error}`);
});

test('discover reports AGY_PROBE_FAILED when probe process is killed by signal', async () => {
  const { adapter } = setup([fixturePath, '--scenario', 'signal-version']);
  const result = await adapter.discover();
  assert.equal(result.installed, false);
  assert.ok(result.error?.includes('AGY_PROBE_FAILED'), `Expected AGY_PROBE_FAILED, got: ${result.error}`);
});

test('discover preserves version text on successful probe', async () => {
  const { adapter } = setup();
  const result = await adapter.discover();
  assert.equal(result.installed, true);
  assert.equal(result.version, '1.3.2');
  assert.equal(result.capabilities.streaming, true);
  assert.equal(result.capabilities.sandbox, true);
});

test('task execution handles startup failure after successful discovery', async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup([fixturePath, '--scenario', 'startup-fail']);
  const discovery = await adapter.discover();
  assert.equal(discovery.installed, true);
  assert.equal(discovery.version, '1.3.2');

  const task = await tasks.run({ prompt: 'test startup fail', workingDirectory: dir });
  const final = await until(tasks, task.taskId, done);
  assert.equal(final.status, 'failed');
  assert.equal(final.error?.code, 'AGY_PROCESS_FAILED');
  assert.ok(final.error?.message.includes('127') || final.error?.message.includes('startup fatal failure'));
});

test('task execution handles stdin EPIPE / early exit without marking completed even if result says SUCCESS', async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup([fixturePath, '--scenario', 'early-exit-epipe']);
  await adapter.discover();
  const backpressurePrompt = 'Backpressure prompt data: ' + 'X'.repeat(100000);
  const task = await tasks.run({ prompt: backpressurePrompt, workingDirectory: dir });
  const final = await until(tasks, task.taskId, done);
  assert.equal(final.status, 'failed');
  assert.equal(final.error?.code, 'CLI_INPUT_FAILED');
  assert.notEqual(final.status, 'completed');
  const events = tasks.readEvents(task.taskId).events;
  assert.ok(!events.some(e => e.type === 'task.completed'), 'Should not emit task.completed');
  assert.ok(events.some(e => e.type === 'task.failed'), 'Should emit task.failed');
});

test('cancellation wins over expected pipe error when task is cancelled during large write', async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup([fixturePath, '--scenario', 'hang'], { DEFAULT_TIMEOUT_SECONDS: '5' });
  await adapter.discover();

  const largePrompt = 'Cancel test with large prompt ' + 'Y'.repeat(100000);
  const task = await tasks.run({ prompt: largePrompt, workingDirectory: dir });
  await until(tasks, task.taskId, t => t.status === 'running');
  await tasks.cancel(task.taskId);
  const final = await until(tasks, task.taskId, done);
  assert.equal(final.status, 'cancelled');
  assert.equal(final.error?.code, 'TASK_CANCELLED');
});

test('task execution handles signal exit cleanly', async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup([fixturePath, '--scenario', 'signal-task']);
  await adapter.discover();
  const task = await tasks.run({ prompt: 'test signal', workingDirectory: dir });
  const final = await until(tasks, task.taskId, done);
  assert.equal(final.status, 'failed');
  assert.equal(final.error?.code, 'AGY_PROCESS_FAILED');
});

test('concurrent cancel and timeout preserves first requested termination intent', async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup([fixturePath, '--scenario', 'hang'], { DEFAULT_TIMEOUT_SECONDS: '5' });
  await adapter.discover();

  let capturedDeadlineCallback: (() => void) | undefined;
  const originalSetTimeout = globalThis.setTimeout;
  mock.method(globalThis, 'setTimeout', ((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 5000) {
      capturedDeadlineCallback = fn as () => void;
    }
    return originalSetTimeout(fn, delay, ...args);
  }) as typeof globalThis.setTimeout);

  try {
    // Order 1: Cancel requested first, then deadline callback invoked before child close
    capturedDeadlineCallback = undefined;
    const taskA = await tasks.run({ prompt: 'test cancel first', workingDirectory: dir, timeoutSeconds: 5 });
    await until(tasks, taskA.taskId, t => t.status === 'running' && capturedDeadlineCallback !== undefined);
    await tasks.cancel(taskA.taskId);
    capturedDeadlineCallback!();
    const finalA = await until(tasks, taskA.taskId, done);
    assert.equal(finalA.status, 'cancelled');
    assert.equal(finalA.error?.code, 'TASK_CANCELLED');

    // Order 2: Deadline callback invoked first, then cancel requested before child close
    capturedDeadlineCallback = undefined;
    const taskB = await tasks.run({ prompt: 'test timeout first', workingDirectory: dir, timeoutSeconds: 5 });
    await until(tasks, taskB.taskId, t => t.status === 'running' && capturedDeadlineCallback !== undefined);
    capturedDeadlineCallback!();
    await tasks.cancel(taskB.taskId);
    const finalB = await until(tasks, taskB.taskId, done);
    assert.equal(finalB.status, 'timeout');
    assert.equal(finalB.error?.code, 'TASK_TIMEOUT');
  } finally {
    mock.reset();
  }
});

test('task completion is not duplicated on cancel or multiple finish calls', async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup();
  await adapter.discover();
  const task = await tasks.run({ prompt: 'normal test', workingDirectory: dir });
  const final = await until(tasks, task.taskId, done);
  assert.equal(final.status, 'completed');

  // Cancel after completion does not change status or emit cancelled event
  await tasks.cancel(task.taskId);
  const afterCancel = tasks.status(task.taskId);
  assert.equal(afterCancel.status, 'completed');
  assert.equal(afterCancel.completedAt, final.completedAt);

  const events = tasks.readEvents(task.taskId).events;
  assert.equal(events.filter(e => e.type === 'task.completed').length, 1);
  assert.equal(events.filter(e => e.type === 'task.cancelled').length, 0);
});

test('diagnostics redact secrets and private keys', () => {
  const privateKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----';
  assert.equal(redactDiagnostic(privateKey), '[private key redacted]');

  const tokenDiagnostic = 'Error with token AIzaSyD12345678901234567890123456789012 and secret';
  assert.ok(!redactDiagnostic(tokenDiagnostic).includes('AIzaSyD12345678901234567890123456789012'));
  assert.ok(redactDiagnostic(tokenDiagnostic).includes('[redacted]'));

  const bearerDiagnostic = 'Authorization: Bearer secret_access_token_12345';
  assert.equal(redactDiagnostic(bearerDiagnostic), 'Authorization: Bearer [redacted]');
});

test('diagnostics redact multiline private keys fed line-by-line without persisting body lines', () => {
  const state = {};
  const lines = [
    'Header info',
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEA0sensitive1',
    'sensitive2bodyline',
    '-----END RSA PRIVATE KEY-----',
    'Trailing info',
  ];
  const redacted = lines.map(line => redactDiagnostic(line, state));
  assert.equal(redacted[0], 'Header info');
  assert.equal(redacted[1], '[private key redacted]');
  assert.equal(redacted[2], '[private key redacted]');
  assert.equal(redacted[3], '[private key redacted]');
  assert.equal(redacted[4], '[private key redacted]');
  assert.equal(redacted[5], 'Trailing info');
  assert.ok(!redacted.some(line => line.includes('sensitive1') || line.includes('sensitive2')));
});

test('diagnostics redact URL userinfo proxy credentials', () => {
  assert.equal(
    redactDiagnostic('Proxy error: http://user:secret123@proxy.internal:8080/v1'),
    'Proxy error: http://[redacted]@proxy.internal:8080/v1'
  );
  assert.equal(
    redactDiagnostic('Connecting via https://admin:pass456@corp-gateway.com:443'),
    'Connecting via https://[redacted]@corp-gateway.com:443'
  );
  assert.equal(
    redactDiagnostic('socks5://useronly@127.0.0.1:1080 connected'),
    'socks5://[redacted]@127.0.0.1:1080 connected'
  );
});

test('result-provided error messages are sanitized before terminal errors', async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup([fixturePath, '--scenario', 'result-with-secret-error']);
  await adapter.discover();

  const task = await tasks.run({ prompt: 'test secret error', workingDirectory: dir });
  const final = await until(tasks, task.taskId, done);
  assert.equal(final.status, 'failed');
  assert.ok(!final.error?.message.includes('AIzaSyD12345678901234567890123456789012'));
  assert.ok(final.error?.message.includes('[redacted]'));
  const res = final.result as { error?: string } | undefined;
  assert.ok(!res?.error?.includes('AIzaSyD12345678901234567890123456789012'));
});

test('stderr events redact private keys without persisting body lines', async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup([fixturePath, '--scenario', 'stderr-private-key']);
  await adapter.discover();

  const task = await tasks.run({ prompt: 'test stderr key', workingDirectory: dir });
  const final = await until(tasks, task.taskId, done);
  assert.equal(final.status, 'failed');
  const events = tasks.readEvents(task.taskId).events.filter(e => e.type === 'process.stderr');
  const texts = events.map(e => (e.data as { text?: string })?.text ?? '');
  assert.ok(!texts.some(t => t.includes('MIIEowIBAAKCAQEA0sensitive')));
  assert.ok(texts.some(t => t.includes('[private key redacted]')));
});

test('read-only task cancelled retains cancellation instead of failing copy verification', async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup([fixturePath, '--scenario', 'modify-copy-hang'], { DEFAULT_TIMEOUT_SECONDS: '5' });
  await adapter.discover();

  const task = await tasks.run({ prompt: 'plan something', workingDirectory: dir, mode: 'read-only', timeoutSeconds: 5 });
  await until(tasks, task.taskId, t => t.status === 'running');
  const copyFile = path.join(tasks.status(task.taskId).copyDirectory!, 'source.txt');
  const deadline = Date.now() + 5000;
  let mutated = false;
  while (Date.now() < deadline) {
    try {
      const content = readFileSync(copyFile, 'utf8');
      if (content.includes('mutated content by plan mode')) {
        mutated = true;
        break;
      }
    } catch { /* wait for child write */ }
    await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(mutated, 'Expected read-only copy file mutation was not observed');
  await tasks.cancel(task.taskId);
  const final = await until(tasks, task.taskId, done);
  assert.equal(final.status, 'cancelled');
  assert.equal(final.error?.code, 'TASK_CANCELLED');
});

test('POSIX descendant holding stdio open is escalated to SIGKILL via owned process group', { skip: process.platform === 'win32' }, async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup([fixturePath, '--scenario', 'posix-descendant-hang'], {
    DEFAULT_TIMEOUT_SECONDS: '10',
  });
  await adapter.discover();

  const task = await tasks.run({ prompt: 'test descendant hang', workingDirectory: dir, timeoutSeconds: 10 });
  await until(tasks, task.taskId, t => t.status === 'running');

  const markerFile = path.join(tasks.status(task.taskId).copyDirectory!, 'descendant-ready.txt');
  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      if (readFileSync(markerFile, 'utf8').includes('ready')) {
        ready = true;
        break;
      }
    } catch { /* wait */ }
    await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(ready, 'Observable readiness marker was not emitted by descendant');

  await tasks.cancel(task.taskId);
  const final = await until(tasks, task.taskId, done, 10000);
  assert.equal(final.status, 'cancelled');
  assert.equal(final.error?.code, 'TASK_CANCELLED');
});

test('immediate child exit during large 900,000-char prompt does not crash caller and reports CLI_INPUT_FAILED', async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup([fixturePath, '--scenario', 'immediate-exit']);
  await adapter.discover();

  const hugePrompt = 'A'.repeat(900000);
  const task = await tasks.run({ prompt: hugePrompt, workingDirectory: dir });
  const final = await until(tasks, task.taskId, done);
  assert.equal(final.status, 'failed');
  assert.equal(final.error?.code, 'CLI_INPUT_FAILED');
  assert.notEqual(final.status, 'completed');
});

test('processError correctly maps error types', () => {
  const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
  enoent.code = 'ENOENT';
  assert.equal(processError(enoent, 'spawn').code, 'AGY_NOT_FOUND');

  const eacces = new Error('EACCES') as NodeJS.ErrnoException;
  eacces.code = 'EACCES';
  assert.equal(processError(eacces, 'spawn').code, 'AGY_PERMISSION_DENIED');

  const epipe = new Error('EPIPE') as NodeJS.ErrnoException;
  epipe.code = 'EPIPE';
  assert.equal(processError(epipe, 'write').code, 'CLI_INPUT_FAILED');

  const eof = new Error('EOF') as NodeJS.ErrnoException;
  eof.code = 'EOF';
  assert.equal(processError(eof, 'write').code, 'CLI_INPUT_FAILED');

  assert.equal(processError(new Error('other'), 'stdin').code, 'CLI_INPUT_FAILED');
  assert.equal(processError(new Error('other'), 'stdout').code, 'AGY_IO_FAILED');
});
