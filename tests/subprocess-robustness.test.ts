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

test('task execution handles stdin EPIPE / early exit without marking completed even if result says SUCCESS', async t => {
  const dir = await createRepo();
  const { adapter, tasks } = setup([fixturePath, '--scenario', 'early-exit-epipe']);
  await adapter.discover();
  const originalSpawn = child_process.spawn;
  let removeEndListener: (() => void) | undefined;
  t.mock.method(child_process, 'spawn', ((...args: Parameters<typeof child_process.spawn>) => {
    const child = originalSpawn(...args);
    if (Array.isArray(args[1]) && args[1].includes('early-exit-epipe')) {
      const { stdin, stdout } = child;
      assert.ok(stdin);
      assert.ok(stdout);
      t.mock.method(stdin, 'write', ((_chunk: unknown, _encoding: unknown, callback: (error?: Error | null) => void) => {
        const onEnd = () => queueMicrotask(() => callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
        stdout.once('end', onEnd);
        removeEndListener = () => { stdout.off('end', onEnd); };
        return true;
      }) as typeof stdin.write);
    }
    return child;
  }) as typeof child_process.spawn);
  syncBuiltinESMExports();
  try {
    const task = await tasks.run({ prompt: 'test early-exit stdin error', workingDirectory: dir });
    const final = await until(tasks, task.taskId, done);
    assert.equal(final.status, 'failed');
    assert.equal(final.error?.code, 'CLI_INPUT_FAILED');
    assert.notEqual(final.status, 'completed');
    assert.equal((final.result as { status?: string } | undefined)?.status, 'SUCCESS');
    const events = tasks.readEvents(task.taskId).events;
    assert.ok(events.some(e => e.type === 'agy.result'), 'Fixture result must be received before the input error wins');
    assert.ok(!events.some(e => e.type === 'task.completed'), 'Should not emit task.completed');
    assert.ok(events.some(e => e.type === 'task.failed'), 'Should emit task.failed');
  } finally {
    removeEndListener?.();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
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
  assert.equal(redactDiagnostic('key: -----BEGIN RSA PRIVATE KEY-----\nMIIEunterminatedbody'), 'key: [private key redacted]');
  assert.equal(redactDiagnostic('MIIEheadlesstail\n-----END RSA PRIVATE KEY-----\nafter'), '[private key redacted]\nafter');

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

  const chained = {};
  const chainedLines = ['-----BEGIN PRIVATE KEY-----', 'firstbody', '-----END PRIVATE KEY----- -----BEGIN PRIVATE KEY-----', 'secondbody', '-----END PRIVATE KEY-----', 'visible'];
  assert.deepEqual(chainedLines.map(line => redactDiagnostic(line, chained)).slice(3), ['[private key redacted]', '[private key redacted]', 'visible']);
});

test('multi-line environment secrets are redacted line by line', () => {
  process.env.BRIDGE_TEST_MULTILINE_SECRET = 'first-secret-line\nsecond-secret-line';
  try {
    const state = {};
    const lines = ['before', 'first-secret-line', 'second-secret-line', 'after'].map(line => redactDiagnostic(line, state));
    assert.deepEqual(lines, ['before', '[redacted]', '[redacted]', 'after']);
    assert.equal(redactDiagnostic('x first-secret-line\nsecond-secret-line y'), 'x [redacted] y');
  } finally {
    delete process.env.BRIDGE_TEST_MULTILINE_SECRET;
  }
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
  assert.equal(redactDiagnostic('git+ssh://deploy@example.test/repo'), 'git+ssh://[redacted]@example.test/repo');
});

test('diagnostic redaction stays linear on long inputs without credentials', () => {
  const safe = 'x'.repeat(200000);
  const longScheme = 'a1'.repeat(100000) + '://example.test/path';
  const started = performance.now();
  assert.equal(redactDiagnostic(safe), safe);
  assert.equal(redactDiagnostic(longScheme), longScheme);
  assert.ok(performance.now() - started < 2000);
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

test('task execution drains final stderr before stream close even without trailing newline', async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup([fixturePath, '--scenario', 'final-stderr-no-newline']);
  await adapter.discover();

  const task = await tasks.run({ prompt: 'test final stderr', workingDirectory: dir });
  const final = await until(tasks, task.taskId, done);
  assert.equal(final.status, 'failed');
  assert.equal(final.exitCode, 42);
  assert.equal(final.error?.code, 'AGY_PROCESS_FAILED');
  assert.equal(final.error?.message, 'synthetic fatal crash without newline');

  const stderrEvents = tasks.readEvents(task.taskId).events.filter(e => e.type === 'process.stderr');
  assert.equal(stderrEvents.length, 1);
  assert.equal((stderrEvents[0]!.data as { text?: string })?.text, 'synthetic fatal crash without newline');
});

test('task execution fails with STREAM_PARSE_ERROR on malformed stream json output', async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup([fixturePath, '--scenario', 'malformed-stream-json']);
  await adapter.discover();

  const task = await tasks.run({ prompt: 'test malformed stream json', workingDirectory: dir });
  const final = await until(tasks, task.taskId, done);
  assert.equal(final.status, 'failed');
  assert.equal(final.exitCode, 0);
  assert.equal(final.error?.code, 'STREAM_PARSE_ERROR');
  assert.notEqual(final.status, 'completed');

  const events = tasks.readEvents(task.taskId).events;
  const unparsed = events.filter(e => e.type === 'stream.unparsed');
  assert.equal(unparsed.length, 1);
  assert.ok(((unparsed[0]!.data as { line?: string })?.line ?? '').includes('{corrupted-json-line'));
  assert.ok(!events.some(e => e.type === 'task.completed'));
  assert.ok(events.some(e => e.type === 'task.failed'));
});

test('task execution fails when process exits 0 without producing result event (incomplete protocol)', async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup([fixturePath, '--scenario', 'incomplete-result-exit-zero']);
  await adapter.discover();

  const task = await tasks.run({ prompt: 'test incomplete protocol', workingDirectory: dir });
  const final = await until(tasks, task.taskId, done);
  assert.equal(final.status, 'failed');
  assert.equal(final.exitCode, 0);
  assert.equal(final.error?.code, 'AGY_PROCESS_FAILED');
  assert.ok(final.error?.message.includes('code 0'));
  assert.notEqual(final.status, 'completed');

  const events = tasks.readEvents(task.taskId).events;
  assert.ok(!events.some(e => e.type === 'task.completed'));
  assert.ok(events.some(e => e.type === 'task.failed'));
});

test('task execution fails when result protocol status is not SUCCESS', async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup([fixturePath, '--scenario', 'result-non-success-status']);
  await adapter.discover();

  const task = await tasks.run({ prompt: 'test non-success status', workingDirectory: dir });
  const final = await until(tasks, task.taskId, done);
  assert.equal(final.status, 'failed');
  assert.equal(final.exitCode, 0);
  assert.equal(final.error?.code, 'AGY_PROCESS_FAILED');
  assert.equal(final.error?.message, 'Upstream generation rejected');
  assert.notEqual(final.status, 'completed');

  const events = tasks.readEvents(task.taskId).events;
  assert.ok(!events.some(e => e.type === 'task.completed'));
  assert.ok(events.some(e => e.type === 'task.failed'));
});

test('synchronous stdin write failure cannot produce completion and fails with CLI_INPUT_FAILED', async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup();
  await adapter.discover();

  const originalSpawn = child_process.spawn;
  const mockSpawn = mock.method(child_process, 'spawn', ((...args: Parameters<typeof child_process.spawn>) => {
    const child = originalSpawn(...args);
    const procArgs = args[1];
    if (Array.isArray(procArgs) && procArgs.includes(fixturePath)) {
      assert.ok(child.stdin);
      mock.method(child.stdin, 'write', () => {
        const err = new Error('synchronous stream write failure');
        Object.assign(err, { code: 'ERR_STREAM_DESTROYED' });
        throw err;
      });
    }
    return child;
  }) as typeof child_process.spawn);
  syncBuiltinESMExports();

  try {
    const task = await tasks.run({ prompt: 'test sync stdin failure', workingDirectory: dir });
    const final = await until(tasks, task.taskId, done);
    assert.equal(final.status, 'failed');
    assert.equal(final.error?.code, 'CLI_INPUT_FAILED');
    assert.notEqual(final.status, 'completed');

    const events = tasks.readEvents(task.taskId).events;
    assert.ok(!events.some(e => e.type === 'task.completed'), 'Should not emit task.completed');
    assert.ok(events.some(e => e.type === 'task.failed'), 'Should emit task.failed');
  } finally {
    mockSpawn.mock.restore();
    syncBuiltinESMExports();
  }
});

test('task failure finalizes once and ignores subsequent cancellation', async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup([fixturePath, '--scenario', 'startup-fail']);
  await adapter.discover();

  const task = await tasks.run({ prompt: 'test fail finalization', workingDirectory: dir });
  const final = await until(tasks, task.taskId, done);
  assert.equal(final.status, 'failed');
  assert.equal(final.error?.code, 'AGY_PROCESS_FAILED');
  assert.ok(final.completedAt);

  // Cancel after failure must not mutate status or emit cancelled event
  await tasks.cancel(task.taskId);
  const afterCancel = tasks.status(task.taskId);
  assert.equal(afterCancel.status, 'failed');
  assert.equal(afterCancel.completedAt, final.completedAt);
  assert.equal(afterCancel.error?.code, 'AGY_PROCESS_FAILED');

  const events = tasks.readEvents(task.taskId).events;
  assert.equal(events.filter(e => e.type === 'task.failed').length, 1);
  assert.equal(events.filter(e => e.type === 'task.cancelled').length, 0);

  const errorMessages = (afterCancel.messages ?? []).filter(m => m.kind === 'error');
  assert.equal(errorMessages.length, 1);
});

test('queued task cancellation finalizes once with idempotent repeated cancel', async () => {
  const dir = await createRepo();
  const { adapter, tasks } = setup([fixturePath, '--scenario', 'hang'], {
    DEFAULT_TIMEOUT_SECONDS: '10',
    MAX_CONCURRENT_TASKS: '1',
  });
  await adapter.discover();

  // Task 1 occupies the single concurrency slot
  const task1 = await tasks.run({ prompt: 'running task 1', workingDirectory: dir });
  await until(tasks, task1.taskId, t => t.status === 'running');

  // Task 2 stays queued
  const task2 = await tasks.run({ prompt: 'queued task 2', workingDirectory: dir });
  assert.equal(tasks.status(task2.taskId).status, 'queued');

  // First cancellation transitions queued task to cancelled
  const cancel1 = await tasks.cancel(task2.taskId);
  assert.equal(cancel1.status, 'cancelled');
  assert.equal(cancel1.error?.code, 'TASK_CANCELLED');
  assert.ok(cancel1.completedAt);

  // Second cancellation is idempotent and does not duplicate finalization
  const cancel2 = await tasks.cancel(task2.taskId);
  assert.equal(cancel2.status, 'cancelled');
  assert.equal(cancel2.completedAt, cancel1.completedAt);

  const events = tasks.readEvents(task2.taskId).events;
  assert.equal(events.filter(e => e.type === 'task.cancelled').length, 1);
  assert.equal(events.filter(e => e.type === 'task.failed').length, 0);
  assert.equal(events.filter(e => e.type === 'task.completed').length, 0);

  const messages = (tasks.status(task2.taskId).messages ?? []).filter(m => m.kind === 'error');
  assert.equal(messages.length, 1);

  // Clean up Task 1
  await tasks.cancel(task1.taskId);
  await until(tasks, task1.taskId, done);
});
