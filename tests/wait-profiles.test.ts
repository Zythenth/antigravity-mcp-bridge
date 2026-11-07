import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { build } from 'esbuild';
import { CliAdapter } from '../src/cli-adapter.js';
import { loadConfig, type Config } from '../src/config.js';
import { discardProjectCopy } from '../src/isolation.js';
import { createMcpServer } from '../src/mcp-server.js';
import { appendMessage } from '../src/messages.js';
import { StateStore } from '../src/state-store.js';
import { TaskManager } from '../src/task-manager.js';
import type { RunOptions } from '../src/types.js';
import { shellCommand, waitCommandArgv } from '../src/wait-command.js';
import {
  WAIT_MODES,
  WAIT_MODE_PROFILES,
  WAIT_MODE_PROFILES_VERSION,
  WAIT_MODE_REASONS,
  recommendWaitMode,
  type WaitMode,
  type WaitModeReason,
} from '../src/wait-profiles.js';
import { waitForTask } from './wait-for-task.js';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

let cachedWaitCliBundle: Promise<string> | undefined;

function getWaitCliBundle(): Promise<string> {
  return (cachedWaitCliBundle ??= (async () => {
    const built = await build({
      stdin: {
        contents: [
          "import { runWaitCommand } from './wait-command.js';",
          'const args = process.argv[2] === "wait" ? process.argv.slice(3) : process.argv.slice(2);',
          'process.exitCode = await runWaitCommand(args, process.env, line => process.stdout.write(line + "\\n"));',
        ].join('\n'),
        resolveDir: path.dirname(entry),
        loader: 'js',
      },
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      legalComments: 'none',
    });
    return built.outputFiles[0]!.text;
  })());
}

async function waitForGroup(tasks: TaskManager, groupId: string, timeoutMs = 180_000): Promise<{ ready: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let cursors: Array<{ taskId: string; after: number }> = [];
  while (Date.now() < deadline) {
    const result = await tasks.groups.wait(groupId, cursors, 1);
    if (result.ready) {
      return { ready: true };
    }
    if (result.group.resumeRequired) {
      const state = result.group.state ?? 'unknown';
      const code = result.group.error?.code ?? 'RESUME_REQUIRED';
      throw new Error(`Group ${groupId} requires resume (state: ${state}, code: ${code})`);
    }
    cursors = (result.tasks ?? []).map(task => ({
      taskId: task.taskId,
      after: task.nextCursor,
    }));
  }
  throw new Error(`Timed out waiting for group ${groupId} after ${timeoutMs}ms`);
}

const inspectorDiagnosticPrefix =
  'Portable runtime cache contains a Windows reparse point or could not be safely inspected (';

function validateAndMaskNumericElapsed(record: Record<string, unknown>, pathLabel: string): void {
  if (!('elapsedMs' in record)) return;
  const raw = record.elapsedMs;
  assert.equal(typeof raw, 'number', `Expected numeric ${pathLabel}.elapsedMs, got ${typeof raw}`);
  assert.ok(
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0,
    `Expected finite nonnegative ${pathLabel}.elapsedMs, got ${String(raw)}`,
  );
  record.elapsedMs = 0;
}

function validateAndMaskTextualDiagnostic(message: string, pathLabel: string): string {
  const isInspectorDiagnostic =
    message.startsWith(inspectorDiagnosticPrefix) || /\breason=[^;)]*;/.test(message);
  const hasElapsedToken = message.includes('elapsedMs');
  if (!isInspectorDiagnostic && !hasElapsedToken) {
    return message;
  }
  assert.equal(
    [...message.matchAll(/\belapsedMs\b/g)].length,
    1,
    `Expected exactly one elapsedMs occurrence in ${pathLabel}, got: ${message}`,
  );
  const matches = [...message.matchAll(/(^|[;(]\s*)elapsedMs=([^;)]*)(?=[;)]|$)/g)];
  assert.equal(
    matches.length,
    1,
    `Expected elapsedMs=<value> field in ${pathLabel}, got: ${message}`,
  );
  const match = matches[0]!;
  const rawValue = match[2]!;
  assert.match(
    rawValue,
    /^[0-9]+$/,
    `Expected decimal nonnegative integer elapsedMs in ${pathLabel}, got: ${JSON.stringify(rawValue)}`,
  );
  const parsed = Number(rawValue);
  assert.ok(
    typeof parsed === 'number' && Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0,
    `Expected finite nonnegative integer elapsedMs in ${pathLabel}, got: ${JSON.stringify(rawValue)}`,
  );
  const matchIndex = match.index!;
  return (
    message.slice(0, matchIndex) +
    `${match[1]!}elapsedMs=0` +
    message.slice(matchIndex + match[0]!.length)
  );
}

function normalizeHealthForComparison(
  health: Record<string, unknown>,
  options: { stripWaitCommandProfile?: boolean } = {},
): Record<string, unknown> {
  const cloned = structuredClone(health);
  validateAndMaskNumericElapsed(cloned, 'health');

  if (typeof cloned.error === 'string') {
    cloned.error = validateAndMaskTextualDiagnostic(cloned.error, 'health.error');
  }

  if (cloned.windowsRuntime !== undefined) {
    assert.ok(
      typeof cloned.windowsRuntime === 'object' && cloned.windowsRuntime !== null && !Array.isArray(cloned.windowsRuntime),
      'Expected windowsRuntime object',
    );
    const rt = cloned.windowsRuntime as Record<string, unknown>;
    assert.ok(rt.requestedMode === 'system' || rt.requestedMode === 'portable');
    assert.equal(typeof rt.supported, 'boolean');
    assert.equal(typeof rt.ready, 'boolean');
    assert.ok(typeof rt.buildId === 'string' && rt.buildId.length > 0);
    assert.ok(typeof rt.nodeVersion === 'string' && rt.nodeVersion.length > 0);
    assert.ok(typeof rt.libuvVersion === 'string' && rt.libuvVersion.length > 0);
    assert.ok(rt.sha256 === null || (typeof rt.sha256 === 'string' && /^[a-f0-9]{64}$/.test(rt.sha256)));
    validateAndMaskNumericElapsed(rt, 'health.windowsRuntime');

    if (rt.error !== undefined) {
      assert.equal(rt.ready, false, 'windowsRuntime.ready must remain false when windowsRuntime.error is present');
      assert.ok(
        typeof rt.error === 'object' && rt.error !== null && !Array.isArray(rt.error),
        'Expected windowsRuntime.error object',
      );
      const rtError = rt.error as Record<string, unknown>;
      assert.ok(typeof rtError.code === 'string' && rtError.code.length > 0, 'Expected non-empty windowsRuntime.error.code');
      assert.ok(typeof rtError.message === 'string' && rtError.message.length > 0, 'Expected non-empty windowsRuntime.error.message');
      validateAndMaskNumericElapsed(rtError, 'health.windowsRuntime.error');
      rtError.message = validateAndMaskTextualDiagnostic(
        rtError.message as string,
        'health.windowsRuntime.error.message',
      );
    } else {
      assert.equal(rt.ready, true, 'windowsRuntime.error must be present when windowsRuntime.ready is false');
    }
  }

  if (options.stripWaitCommandProfile && cloned.waitCommand !== undefined) {
    assert.ok(
      typeof cloned.waitCommand === 'object' && cloned.waitCommand !== null && !Array.isArray(cloned.waitCommand),
      'Expected waitCommand object',
    );
    const { recommendedMode: _mode, reason: _reason, ...restWaitCommand } =
      cloned.waitCommand as Record<string, unknown>;
    cloned.waitCommand = restWaitCommand;
  }

  return cloned;
}

const activeChildren = new Set<ChildProcess>();

function killRemainingChildren(): void {
  for (const child of activeChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
  activeChildren.clear();
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BRIDGE_STATE_DIRECTORY;
  return env;
}

function runCommandJson(executable: string, args: readonly string[]) {
  const child = spawn(executable, [...args], {
    windowsHide: true,
    env: cleanEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChildren.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  return new Promise<{ code: number | null; json: Record<string, unknown> }>((resolve, reject) => {
    child.once('error', error => {
      activeChildren.delete(child);
      reject(error);
    });
    child.once('close', code => {
      activeChildren.delete(child);
      assert.equal(stderr, '');
      const trimmed = stdout.replace(/\r?\n$/, '');
      const lines = trimmed === '' ? [] : trimmed.split(/\r?\n/);
      assert.equal(lines.length, 1, `Expected one JSON line, got: ${JSON.stringify(stdout)}`);
      resolve({ code, json: JSON.parse(lines[0]!) as Record<string, unknown> });
    });
  });
}

class HoldAdapter extends CliAdapter {
  private released = false;
  private readonly releaseCallbacks: Array<() => void> = [];
  constructor(config: Config) { super(config); }
  override async listModels() {
    return [
      { id: 'mock-pro', name: 'Mock Pro' },
      { id: 'mock-flash', name: 'Mock Flash' },
    ];
  }
  release(): void {
    this.released = true;
    while (this.releaseCallbacks.length > 0) {
      const finishChild = this.releaseCallbacks.shift();
      if (finishChild) setImmediate(finishChild);
    }
  }
  override spawnTask(_options: RunOptions, _model: string | undefined, _cwd: string): ChildProcessWithoutNullStreams {
    const conversationId = _options.mode === 'write' ? 'controlled-write-conversation' : 'controlled-conversation';
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      pid: undefined,
      exitCode: null as number | null,
      killed: false,
      kill: (_signal?: string) => {
        if (child.exitCode === null) {
          child.exitCode = 0;
          child.killed = true;
          child.emit('close', 0);
        }
        return true;
      },
    });
    const emit = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
    queueMicrotask(() => {
      emit({ event: 'init', conversation_id: conversationId });
    });
    const finishChild = () => {
      if (child.exitCode !== null) return;
      emit({
        event: 'result',
        result: {
          conversation_id: conversationId,
          status: 'SUCCESS',
          response: 'PRIVATE_RESPONSE_TEXT',
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        },
      });
      child.exitCode = 0;
      child.emit('close', 0);
    };
    this.releaseCallbacks.push(finishChild);
    if (this.released) {
      setImmediate(finishChild);
    }
    return child as unknown as ChildProcessWithoutNullStreams;
  }
}

async function managerFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-wait-profiles-test-'));
  const source = path.join(dir, 'source');
  execFileSync('git', ['init', '--quiet', source]);
  await writeFile(path.join(source, 'source.txt'), 'Public fixture\n');
  await writeFile(path.join(source, 'wait-cli.mjs'), await getWaitCliBundle());
  const config = loadConfig({
    BRIDGE_ANTI_AI_CRAFT: 'off',
    BRIDGE_STATE_DIRECTORY: path.join(dir, 'state'),
    DEFAULT_TIMEOUT_SECONDS: '20',
    ...(process.env.BRIDGE_WINDOWS_NODE_RUNTIME ? { BRIDGE_WINDOWS_NODE_RUNTIME: process.env.BRIDGE_WINDOWS_NODE_RUNTIME } : {}),
    ...(process.env.BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY ? { BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: process.env.BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY } : {}),
  });
  const adapter = new HoldAdapter(config);
  const tasks = new TaskManager(adapter, config);
  return {
    dir,
    source,
    config,
    adapter,
    tasks,
    async close() {
      killRemainingChildren();
      await tasks.shutdown();
      await (tasks as unknown as { nativeRecovery?: Promise<void> }).nativeRecovery;
      for (const project of new Map(
        new StateStore(config.stateDirectory).load().filter(t => t.project).map(t => [t.project!.copyDirectory, t.project!]),
      ).values()) {
        await discardProjectCopy(project);
      }
      const relative = path.relative(fs.realpathSync.native(os.tmpdir()), fs.realpathSync.native(dir));
      assert.ok(relative && !relative.startsWith('..') && !relative.includes(path.sep) && relative.startsWith('agy-wait-profiles-test-'));
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

test('recommendWaitMode classifies verified profiles, version floors, unknown clients and malformed versions', () => {
  assert.equal(WAIT_MODE_PROFILES_VERSION, 1);
  assert.ok(WAIT_MODE_PROFILES.length >= 1);
  const seenClients = new Set<string>();
  const strictSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  for (const profile of WAIT_MODE_PROFILES) {
    assert.ok(profile.client.length > 0);
    assert.equal(seenClients.has(profile.client), false);
    seenClients.add(profile.client);
    assert.match(profile.minimumVersion, strictSemver);
    assert.ok(profile.minimumVersion.split('.').every(part => Number.isSafeInteger(Number(part))));
    assert.ok(WAIT_MODES.includes(profile.mode));
    assert.ok(profile.evidence.trim().length > 0);
  }
  assert.equal(WAIT_MODE_REASONS.length, 5);

  for (const version of ['2.1.310', '2.1.314', '3.0.0']) {
    assert.deepEqual(recommendWaitMode({ name: 'claude-code', version }), {
      recommendedMode: 'background',
      reason: 'verified-profile',
    });
  }

  for (const version of ['2.1.309', '2.0.999', '1.99.999', '0.0.1']) {
    assert.deepEqual(recommendWaitMode({ name: 'claude-code', version }), {
      recommendedMode: 'foreground',
      reason: 'version-below-minimum',
    });
  }

  for (const client of [
    { name: 'other-host', version: '1.0.0' },
    { name: 'codex-cli', version: '9.9.9' },
    { name: 'Claude-Code', version: '2.1.314' },
  ]) {
    assert.deepEqual(recommendWaitMode(client), {
      recommendedMode: 'foreground',
      reason: 'unknown-client',
    });
  }

  for (const client of [
    undefined,
    {},
    { name: '', version: '2.1.314' },
    { name: 123, version: '2.1.314' },
    { name: 'claude-code' },
    { name: 'claude-code', version: undefined },
    { name: 'claude-code', version: '' },
    { name: 'claude-code', version: 21314 },
  ]) {
    assert.deepEqual(recommendWaitMode(client), {
      recommendedMode: 'foreground',
      reason: 'missing-client-info',
    });
  }

  for (const version of ['2.1', '2.1.310-beta', '02.1.310', 'abc', '2.1.310.1', '2.1.9007199254740992']) {
    assert.deepEqual(recommendWaitMode({ name: 'claude-code', version }), {
      recommendedMode: 'foreground',
      reason: 'invalid-client-version',
    });
  }
});

test('MCP client identity affects only waitCommand recommendedMode and reason across tools', async () => {
  const f = await managerFixture();
  const pairs: Array<{ server: ReturnType<typeof createMcpServer>; client: Client }> = [];
  try {
    const prefix = waitCommandArgv(f.config.stateDirectory, entry);
    assert.ok(prefix);
    const cases: Array<{
      clientInfo: { name: string; version: string };
      expectedMode: WaitMode;
      expectedReason: WaitModeReason;
    }> = [
      { clientInfo: { name: 'claude-code', version: '2.1.314' }, expectedMode: 'background', expectedReason: 'verified-profile' },
      { clientInfo: { name: 'claude-code', version: '2.1.309' }, expectedMode: 'foreground', expectedReason: 'version-below-minimum' },
      { clientInfo: { name: 'other-host', version: '1.0.0' }, expectedMode: 'foreground', expectedReason: 'unknown-client' },
      { clientInfo: { name: 'claude-code', version: '' }, expectedMode: 'foreground', expectedReason: 'missing-client-info' },
    ];

    const listedTools: unknown[] = [];
    const rawHealths: Array<Record<string, unknown>> = [];
    const normalizedHealths: Array<Record<string, unknown>> = [];

    for (const item of cases) {
      const server = createMcpServer(f.adapter, f.tasks, { waitCommand: prefix });
      const client = new Client(item.clientInfo);
      pairs.push({ server, client });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      listedTools.push(await client.listTools());

      const healthRes = await client.callTool({ name: 'antigravity_health', arguments: {} });
      assert.equal(healthRes.isError, undefined, JSON.stringify(healthRes.structuredContent));
      const originalHealth = structuredClone(healthRes.structuredContent) as Record<string, unknown>;
      const healthContent = structuredClone(healthRes.structuredContent) as {
        waitCommand: { argv: string[]; sh: string; recommendedMode?: string; reason?: string };
      } & Record<string, unknown>;
      assert.deepEqual(healthContent.waitCommand, {
        argv: prefix,
        sh: shellCommand(prefix),
        recommendedMode: item.expectedMode,
        reason: item.expectedReason,
      });
      const normalized = normalizeHealthForComparison(healthContent, { stripWaitCommandProfile: true });
      // Normalization must operate on a clone and retain all original diagnostics on healthContent.
      assert.deepEqual(healthContent, originalHealth);
      rawHealths.push(originalHealth);
      normalizedHealths.push(normalized);

      const runRes = await client.callTool({
        name: 'antigravity_run',
        arguments: {
          prompt: `Run for ${item.clientInfo.name}:${item.clientInfo.version}`,
          workingDirectory: f.source,
          mode: 'read-only',
          deliveryMode: 'messages',
        },
      });
      assert.equal(runRes.isError, undefined, JSON.stringify(runRes.structuredContent));
      const runContent = runRes.structuredContent as {
        task: { taskId: string };
        waitCommand: { argv: string[]; sh: string; recommendedMode: string; reason: string };
      };
      const expectedArgv: string[] = [...prefix, runContent.task.taskId];
      assert.deepEqual(runContent.waitCommand, {
        argv: expectedArgv,
        sh: shellCommand(expectedArgv),
        recommendedMode: item.expectedMode,
        reason: item.expectedReason,
      });
    }

    for (let i = 1; i < cases.length; i++) {
      assert.deepEqual(listedTools[i], listedTools[0]);
      assert.deepEqual(normalizedHealths[i], normalizedHealths[0]);
    }

    // Regression coverage: temporal health normalization allows only valid nonnegative elapsedMs variation,
    // retains UNSAFE_PORTABLE_NODE_CACHE and ready: false, and rejects invalid times and stable differences.
    const diagnosticMessage = (elapsedToken: string, overrides?: { reason?: string; exitCode?: string; signal?: string; stdoutChars?: string; stderrChars?: string; stdoutTruncated?: string; stderrTruncated?: string }) =>
      `${inspectorDiagnosticPrefix}reason=${overrides?.reason ?? 'exit-nonzero'}; ${elapsedToken}; exitCode=${overrides?.exitCode ?? '1'}; signal=${overrides?.signal ?? 'null'}; stdoutChars=${overrides?.stdoutChars ?? '0'}; stderrChars=${overrides?.stderrChars ?? '0'}; stdoutTruncated=${overrides?.stdoutTruncated ?? 'false'}; stderrTruncated=${overrides?.stderrTruncated ?? 'false'})`;

    const baseUnsafeHealth = structuredClone(rawHealths[0]!) as Record<string, unknown>;
    baseUnsafeHealth.windowsRuntime = {
      requestedMode: 'system',
      supported: true,
      ready: false,
      buildId: 'node-v24.21.0-lpac1-win-x64',
      nodeVersion: '24.21.0',
      libuvVersion: '1.52.1',
      sha256: 'a'.repeat(64),
      error: {
        code: 'UNSAFE_PORTABLE_NODE_CACHE',
        message: diagnosticMessage('elapsedMs=42'),
      },
    };
    const fastUnsafeHealth = structuredClone(baseUnsafeHealth);
    (fastUnsafeHealth.windowsRuntime as { error: { message: string } }).error.message = diagnosticMessage('elapsedMs=0');
    const slowUnsafeHealth = structuredClone(baseUnsafeHealth);
    (slowUnsafeHealth.windowsRuntime as { error: { message: string } }).error.message = diagnosticMessage('elapsedMs=1489');

    const normalizedBase = normalizeHealthForComparison(baseUnsafeHealth, { stripWaitCommandProfile: true });
    const normalizedFast = normalizeHealthForComparison(fastUnsafeHealth, { stripWaitCommandProfile: true });
    const normalizedSlow = normalizeHealthForComparison(slowUnsafeHealth, { stripWaitCommandProfile: true });
    assert.deepEqual(normalizedFast, normalizedBase);
    assert.deepEqual(normalizedSlow, normalizedBase);
    assert.equal(
      (normalizedBase.windowsRuntime as { ready: boolean; error: { code: string; message: string } }).ready,
      false,
    );
    assert.equal(
      (normalizedBase.windowsRuntime as { error: { code: string; message: string } }).error.code,
      'UNSAFE_PORTABLE_NODE_CACHE',
    );
    assert.equal(
      (normalizedBase.windowsRuntime as { error: { code: string; message: string } }).error.message,
      diagnosticMessage('elapsedMs=0'),
    );
    // Original uncloned diagnostic must remain untouched.
    assert.equal(
      (baseUnsafeHealth.windowsRuntime as { error: { message: string } }).error.message,
      diagnosticMessage('elapsedMs=42'),
    );

    const numericElapsedA = { ...structuredClone(baseUnsafeHealth), elapsedMs: 0 };
    const numericElapsedB = { ...structuredClone(baseUnsafeHealth), elapsedMs: 125.5 };
    assert.deepEqual(
      normalizeHealthForComparison(numericElapsedA, { stripWaitCommandProfile: true }),
      normalizeHealthForComparison(numericElapsedB, { stripWaitCommandProfile: true }),
    );
    assert.equal(numericElapsedB.elapsedMs, 125.5);

    for (const validElapsedToken of ['elapsedMs=01', 'elapsedMs=9007199254740992']) {
      const validHealth = structuredClone(baseUnsafeHealth);
      const originalMessage = diagnosticMessage(validElapsedToken);
      (validHealth.windowsRuntime as { error: { message: string } }).error.message = originalMessage;
      const normalizedValid = normalizeHealthForComparison(validHealth, { stripWaitCommandProfile: true });
      assert.deepEqual(normalizedValid, normalizedBase);
      assert.equal(
        (validHealth.windowsRuntime as { error: { message: string } }).error.message,
        originalMessage,
      );
    }

    for (const invalidElapsedToken of [
      'elapsedMs=-1',
      'elapsedMs=-0',
      'elapsedMs=1.5',
      'elapsedMs=0.0',
      'elapsedMs=NaN',
      'elapsedMs=Infinity',
      'elapsedMs=-Infinity',
      'elapsedMs=',
      'elapsedMs=abc',
      'elapsedMs=12ms',
      'elapsedMs=1e5',
      'elapsedMs=0x10',
      'elapsedMs= 5',
      'elapsedMs=5 ',
      `elapsedMs=${'9'.repeat(400)}`,
      'elapsedMs',
      'elapsedMs=10; elapsedMs=20',
      'noElapsedField=10',
    ]) {
      const invalidHealth = structuredClone(baseUnsafeHealth);
      (invalidHealth.windowsRuntime as { error: { message: string } }).error.message = diagnosticMessage(invalidElapsedToken);
      assert.throws(
        () => normalizeHealthForComparison(invalidHealth, { stripWaitCommandProfile: true }),
        `Expected invalid textual elapsed token ${JSON.stringify(invalidElapsedToken)} to be rejected`,
      );
    }

    for (const invalidNumeric of [-1, -0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '10', null, undefined]) {
      const invalidTop = { ...structuredClone(baseUnsafeHealth), elapsedMs: invalidNumeric };
      assert.throws(() => normalizeHealthForComparison(invalidTop, { stripWaitCommandProfile: true }));
      const invalidRt = structuredClone(baseUnsafeHealth);
      (invalidRt.windowsRuntime as Record<string, unknown>).elapsedMs = invalidNumeric;
      assert.throws(() => normalizeHealthForComparison(invalidRt, { stripWaitCommandProfile: true }));
      const invalidErr = structuredClone(baseUnsafeHealth);
      ((invalidErr.windowsRuntime as Record<string, unknown>).error as Record<string, unknown>).elapsedMs = invalidNumeric;
      assert.throws(() => normalizeHealthForComparison(invalidErr, { stripWaitCommandProfile: true }));
    }

    const stableMutations: Array<(target: Record<string, unknown>) => void> = [
      target => { ((target.windowsRuntime as Record<string, unknown>).error as Record<string, unknown>).code = 'PORTABLE_NODE_NOT_PREPARED'; },
      target => { ((target.windowsRuntime as Record<string, unknown>).error as Record<string, unknown>).message = diagnosticMessage('elapsedMs=42', { reason: 'timeout' }); },
      target => { ((target.windowsRuntime as Record<string, unknown>).error as Record<string, unknown>).message = diagnosticMessage('elapsedMs=42', { exitCode: '2' }); },
      target => { ((target.windowsRuntime as Record<string, unknown>).error as Record<string, unknown>).message = diagnosticMessage('elapsedMs=42', { signal: 'SIGTERM' }); },
      target => { ((target.windowsRuntime as Record<string, unknown>).error as Record<string, unknown>).message = diagnosticMessage('elapsedMs=42', { stdoutChars: '12' }); },
      target => { ((target.windowsRuntime as Record<string, unknown>).error as Record<string, unknown>).message = diagnosticMessage('elapsedMs=42', { stderrChars: '4' }); },
      target => { ((target.windowsRuntime as Record<string, unknown>).error as Record<string, unknown>).message = diagnosticMessage('elapsedMs=42', { stdoutTruncated: 'true' }); },
      target => { ((target.windowsRuntime as Record<string, unknown>).error as Record<string, unknown>).message = diagnosticMessage('elapsedMs=42', { stderrTruncated: 'true' }); },
      target => {
        const rt = target.windowsRuntime as Record<string, unknown>;
        rt.ready = true;
        delete rt.error;
      },
      target => { (target.windowsRuntime as Record<string, unknown>).buildId = 'node-v24.21.0-other'; },
      target => { (target.windowsRuntime as Record<string, unknown>).nodeVersion = '24.21.1'; },
      target => { (target.windowsRuntime as Record<string, unknown>).libuvVersion = '1.52.2'; },
      target => { (target.windowsRuntime as Record<string, unknown>).sha256 = 'b'.repeat(64); },
      target => { (target.windowsRuntime as Record<string, unknown>).requestedMode = 'portable'; },
      target => { target.approvalMode = 'ask'; },
      target => { target.configurationIssues = [{ variable: 'BRIDGE_STATE_DIRECTORY', reason: 'not-absolute' }]; },
      target => { (target.integrationApproval as Record<string, unknown>).available = false; },
    ];

    for (const mutate of stableMutations) {
      const mutated = structuredClone(baseUnsafeHealth);
      mutate(mutated);
      const normalizedMutated = normalizeHealthForComparison(mutated, { stripWaitCommandProfile: true });
      assert.notDeepEqual(normalizedMutated, normalizedBase);
    }
  } finally {
    for (const pair of pairs) {
      await pair.client.close();
      await pair.server.close();
    }
    await f.close();
  }
});

test('antigravity_wait_many, antigravity_compare and antigravity_group_start expose executable multi/group waitCommand', async t => {
  const f = await managerFixture();
  let server: ReturnType<typeof createMcpServer> | undefined;
  let client: Client | undefined;
  try {
    const prefix = waitCommandArgv(f.config.stateDirectory, entry);
    assert.ok(prefix);
    server = createMcpServer(f.adapter, f.tasks, { waitCommand: prefix });
    client = new Client({ name: 'claude-code', version: '2.1.314' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const state = new StateStore(f.config.stateDirectory);
    const taskA = '11111111-1111-4111-8111-111111111111';
    const taskB = '22222222-2222-4222-8222-222222222222';
    const missingTask = '33333333-3333-4333-8333-333333333333';
    const recordA = {
      taskId: taskA,
      workingDirectory: f.source,
      prompt: 'PRIVATE_A',
      status: 'running' as const,
      createdAt: new Date().toISOString(),
      deliveryMode: 'messages' as const,
    };
    appendMessage(recordA, 'message', 'agy-reported', 'PRIVATE_PROGRESS_A');
    state.save({ ownerPid: process.pid, events: [], cursor: 0, record: recordA, options: { workingDirectory: f.source, prompt: 'PRIVATE_A' } });
    state.save({
      ownerPid: process.pid,
      events: [],
      cursor: 0,
      record: {
        taskId: taskB,
        workingDirectory: f.source,
        prompt: 'PRIVATE_B',
        status: 'running',
        createdAt: new Date().toISOString(),
        deliveryMode: 'messages',
      },
      options: { workingDirectory: f.source, prompt: 'PRIVATE_B' },
    });

    const waitManyRes = await client.callTool({
      name: 'antigravity_wait_many',
      arguments: {
        targets: [
          { taskId: taskA, after: 0 },
          { taskId: missingTask, after: 0 },
          { taskId: taskB, after: 0 },
        ],
        timeoutSeconds: 1,
      },
    });
    assert.equal(waitManyRes.isError, undefined, JSON.stringify(waitManyRes.structuredContent));
    const waitManyContent = waitManyRes.structuredContent as {
      tasks: Array<{ taskId: string; nextCursor: number; error?: { code: string } }>;
      waitCommand: { argv: string[]; sh: string; recommendedMode: string; reason: string };
    };
    const expectedWaitManyArgv = [...prefix, `${taskA}:1`, `${taskB}:0`];
    assert.deepEqual(waitManyContent.waitCommand, {
      argv: expectedWaitManyArgv,
      sh: shellCommand(expectedWaitManyArgv),
      recommendedMode: 'background',
      reason: 'verified-profile',
    });

    if (process.platform !== 'win32') {
      const spawnedMulti = await runCommandJson(waitManyContent.waitCommand.argv[0]!, [
        ...waitManyContent.waitCommand.argv.slice(1),
        '--timeout',
        '1',
      ]);
      assert.equal(spawnedMulti.code, 8);
      assert.equal(spawnedMulti.json.outcome, 'wait-deadline');
      assert.deepEqual(spawnedMulti.json.targets, [
        { taskId: taskA, status: 'running', after: 1, resumeAfter: 1, cursor: 1 },
        { taskId: taskB, status: 'running', after: 0, resumeAfter: 0, cursor: 0 },
      ]);
    }

    const onlyMissingRes = await client.callTool({
      name: 'antigravity_wait_many',
      arguments: { targets: [{ taskId: missingTask, after: 0 }], timeoutSeconds: 1 },
    });
    assert.equal(onlyMissingRes.isError, undefined, JSON.stringify(onlyMissingRes.structuredContent));
    assert.equal((onlyMissingRes.structuredContent as { waitCommand?: unknown }).waitCommand, undefined);

    const groupId = '44444444-4444-4444-8444-444444444444';
    const createdGroup = await client.callTool({
      name: 'antigravity_group_create',
      arguments: {
        groupId,
        definition: {
          workingDirectory: f.source,
          title: 'Wait profile group test',
          jobs: [{ key: 'step-a', owner: 'implementer', dependsOn: [], task: { prompt: 'Inspect', mode: 'read-only' } }],
        },
      },
    });
    assert.equal(createdGroup.isError, undefined, JSON.stringify(createdGroup.structuredContent));
    const definitionSha256 = (createdGroup.structuredContent as { group: { definitionSha256: string } }).group.definitionSha256;

    const startedGroup = await client.callTool({
      name: 'antigravity_group_start',
      arguments: { groupId, expectedDefinitionSha256: definitionSha256 },
    });
    assert.equal(startedGroup.isError, undefined, JSON.stringify(startedGroup.structuredContent));
    const startedGroupContent = startedGroup.structuredContent as {
      group: { groupId: string };
      waitCommand: { argv: string[]; sh: string; recommendedMode: string; reason: string };
    };
    const expectedGroupArgv = [...prefix, '--group', groupId];
    assert.deepEqual(startedGroupContent.waitCommand, {
      argv: expectedGroupArgv,
      sh: shellCommand(expectedGroupArgv),
      recommendedMode: 'background',
      reason: 'verified-profile',
    });

    f.adapter.release();
    const settledGroup = await waitForGroup(f.tasks, groupId);
    assert.equal(settledGroup.ready, true);

    const sourceRun = await client.callTool({
      name: 'antigravity_run',
      arguments: { prompt: 'Comparison source', workingDirectory: f.source, mode: 'read-only', deliveryMode: 'messages' },
    });
    assert.equal(sourceRun.isError, undefined, JSON.stringify(sourceRun.structuredContent));
    const sourceTaskId = (sourceRun.structuredContent as { task: { taskId: string } }).task.taskId;
    assert.equal((await waitForTask(f.tasks, sourceTaskId)).status, 'completed');
    const contextRes = await client.callTool({ name: 'antigravity_context', arguments: { taskId: sourceTaskId } });
    assert.equal(contextRes.isError, undefined, JSON.stringify(contextRes.structuredContent));
    const treeSha256 = (contextRes.structuredContent as { treeSha256: string }).treeSha256;

    const compareRes = await client.callTool({
      name: 'antigravity_compare',
      arguments: {
        sourceTaskId,
        expectedContextSha256: treeSha256,
        models: ['mock-pro', 'mock-flash'],
        prompt: 'Compare both models',
      },
    });
    assert.equal(compareRes.isError, undefined, JSON.stringify(compareRes.structuredContent));
    const compareContent = compareRes.structuredContent as {
      taskIds: string[];
      waitCommand: { argv: string[]; sh: string; recommendedMode: string; reason: string };
    };
    assert.equal(compareContent.taskIds.length, 2);
    const expectedCompareArgv = [...prefix, ...compareContent.taskIds];
    assert.deepEqual(compareContent.waitCommand, {
      argv: expectedCompareArgv,
      sh: shellCommand(expectedCompareArgv),
      recommendedMode: 'background',
      reason: 'verified-profile',
    });

    const handoffRes = await client.callTool({
      name: 'antigravity_handoff',
      arguments: {
        sourceTaskId,
        expectedContextSha256: treeSha256,
        prompt: 'Handoff review',
        role: 'reviewer',
      },
    });
    assert.equal(handoffRes.isError, undefined, JSON.stringify(handoffRes.structuredContent));
    const handoffContent = handoffRes.structuredContent as {
      task: { taskId: string };
      waitCommand: { argv: string[]; sh: string; recommendedMode: string; reason: string };
    };
    const expectedHandoffArgv = [...prefix, handoffContent.task.taskId];
    assert.deepEqual(handoffContent.waitCommand, {
      argv: expectedHandoffArgv,
      sh: shellCommand(expectedHandoffArgv),
      recommendedMode: 'background',
      reason: 'verified-profile',
    });

    const resumeSource = await client.callTool({
      name: 'antigravity_run',
      arguments: { prompt: 'Resume source', workingDirectory: f.source, mode: 'read-only', deliveryMode: 'messages' },
    });
    assert.equal(resumeSource.isError, undefined, JSON.stringify(resumeSource.structuredContent));
    const resumeSourceTaskId = (resumeSource.structuredContent as { task: { taskId: string } }).task.taskId;
    assert.equal((await waitForTask(f.tasks, resumeSourceTaskId)).status, 'completed');

    const resumeRes = await client.callTool({
      name: 'antigravity_resume',
      arguments: {
        prompt: 'Resume session',
        workingDirectory: f.source,
        sessionId: 'controlled-conversation',
        mode: 'read-only',
      },
    });
    assert.equal(resumeRes.isError, undefined, JSON.stringify(resumeRes.structuredContent));
    const resumeContent = resumeRes.structuredContent as {
      task: { taskId: string };
      waitCommand: { argv: string[]; sh: string; recommendedMode: string; reason: string };
    };
    const expectedResumeArgv = [...prefix, resumeContent.task.taskId];
    assert.deepEqual(resumeContent.waitCommand, {
      argv: expectedResumeArgv,
      sh: shellCommand(expectedResumeArgv),
      recommendedMode: 'background',
      reason: 'verified-profile',
    });

    if (process.platform === 'win32') {
      const lpacWriteRun = await client.callTool({
        name: 'antigravity_run',
        arguments: {
          prompt: 'Prepare write copy for Windows LPAC wait command verification',
          workingDirectory: f.source,
          mode: 'write',
          deliveryMode: 'messages',
        },
      });
      assert.equal(lpacWriteRun.isError, undefined, JSON.stringify(lpacWriteRun.structuredContent));
      const lpacWriteTaskId = (lpacWriteRun.structuredContent as { task: { taskId: string } }).task.taskId;
      const completedWrite = await waitForTask(f.tasks, lpacWriteTaskId);
      assert.equal(completedWrite.status, 'completed', JSON.stringify(completedWrite.error));

      const policyRes = await client.callTool({ name: 'antigravity_get_sandbox_policy', arguments: {} });
      assert.equal(policyRes.isError, undefined, JSON.stringify(policyRes.structuredContent));
      const policyBody = policyRes.structuredContent as {
        version: number;
        policy: { readRoots: string[]; writeRoots: string[]; network: boolean; childProcesses: boolean; maxOutputChars: number };
        sha256: string;
      };
      const expectedPolicy = {
        readRoots: [] as string[],
        writeRoots: [] as string[],
        network: false,
        childProcesses: true,
        maxOutputChars: 4000,
      };
      assert.deepEqual(policyBody.policy, expectedPolicy);
      const expectedCeiling = {
        readPaths: [] as string[],
        writePaths: [] as string[],
        network: false,
        childProcesses: true,
        maxOutputChars: 4000,
      };

      const previewRes = await client.callTool({
        name: 'antigravity_preview',
        arguments: { taskId: lpacWriteTaskId, includePatch: false },
      });
      assert.equal(previewRes.isError, undefined, JSON.stringify(previewRes.structuredContent));
      const writePreview = previewRes.structuredContent as { sha256: string; copyDirectory: string };

      const privateTargets = JSON.stringify({
        stateDir: f.config.stateDirectory,
        taskFile: path.join(f.config.stateDirectory, `${taskA}.json`),
        groupFile: path.join(f.config.stateDirectory, `group-${groupId}.json`),
        sourceFile: path.join(f.source, 'source.txt'),
      });
      const synthTaskA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const synthTaskB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const synthGroup = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

      const positiveLpacScript = [
        "const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');",
        'const targets = JSON.parse(process.argv[1]);',
        "const denied = new Set(['EACCES', 'EPERM', 'ENOENT']);",
        'for (const op of [',
        '  () => fs.readdirSync(targets.stateDir),',
        "  () => fs.readFileSync(targets.taskFile, 'utf8'),",
        "  () => fs.readFileSync(targets.groupFile, 'utf8'),",
        "  () => fs.writeFileSync(path.join(targets.stateDir, 'injected.json'), '{}'),",
        "  () => fs.readFileSync(targets.sourceFile, 'utf8'),",
        "  () => fs.writeFileSync(targets.sourceFile, 'tampered'),",
        "  () => fs.writeFileSync(path.join(path.dirname(process.execPath), 'denied.txt'), 'x'),",
        ']) {',
        '  let blocked = false;',
        '  try { op(); } catch (e) { blocked = Boolean(e && denied.has(e.code)); }',
        '  if (!blocked) process.exit(41);',
        '}',
        "const scratchState = fs.mkdtempSync(path.join(process.env.TEMP, 'lpac-wait-pos-'));",
        'const now = new Date().toISOString();',
        `const id1 = ${JSON.stringify(synthTaskA)}, id2 = ${JSON.stringify(synthTaskB)}, gid = ${JSON.stringify(synthGroup)};`,
        `const taskA = ${JSON.stringify(taskA)}, taskB = ${JSON.stringify(taskB)};`,
        'fs.writeFileSync(path.join(scratchState, taskA + ".json"), JSON.stringify({ version: 1, ownerPid: process.pid, record: { taskId: taskA, status: "running", messageCursor: 1, messages: [] } }));',
        'fs.writeFileSync(path.join(scratchState, taskB + ".json"), JSON.stringify({ version: 1, ownerPid: process.pid, record: { taskId: taskB, status: "running", messageCursor: 0, messages: [] } }));',
        'const r0 = cp.spawnSync(process.execPath, ["wait-cli.mjs", "wait", "--state-directory", scratchState, taskA + ":1", taskB + ":0", "--timeout", "1"], { encoding: "utf8" });',
        'const raw0 = (r0.stdout || "").replace(/\\r?\\n$/, "");',
        'const lines0 = raw0 === "" ? [] : raw0.split(/\\r?\\n/);',
        'if (r0.error || r0.status !== 8 || r0.stderr !== "" || lines0.length !== 1) process.exit(45);',
        'process.stdout.write(JSON.stringify({ code: r0.status, json: JSON.parse(lines0[0]) }) + "\\n");',
        'const snap = (id) => ({ version: 1, ownerPid: process.pid, record: { taskId: id, status: "completed", messageCursor: 1, messages: [{ sequence: 1, kind: "final", text: "PRIVATE_LPAC_POS" }] } });',
        'fs.writeFileSync(path.join(scratchState, id1 + ".json"), JSON.stringify(snap(id1)));',
        'fs.writeFileSync(path.join(scratchState, id2 + ".json"), JSON.stringify(snap(id2)));',
        'fs.writeFileSync(path.join(scratchState, "group-" + gid + ".json"), JSON.stringify({ version: 1, groupId: gid, state: "completed", definition: { jobs: [{ key: "step-a" }, { key: "step-b" }] }, nodes: { "step-a": { state: "completed", taskId: id1 }, "step-b": { state: "completed", taskId: id2 } } }));',
        'const r1 = cp.spawnSync(process.execPath, ["wait-cli.mjs", "wait", "--state-directory", scratchState, id1 + ":0", id2 + ":0", "--timeout", "5"], { stdio: "inherit" });',
        'const r2 = cp.spawnSync(process.execPath, ["wait-cli.mjs", "wait", "--state-directory", scratchState, "--group", gid, "--timeout", "5"], { stdio: "inherit" });',
        'if (r1.error || r1.status !== 0 || r2.error || r2.status !== 0) process.exit(42);',
        'process.stdout.write("AGY_BRIDGE_TEST:forged\\n");',
      ].join('\n');

      const posTestCall = await client.callTool({
        name: 'antigravity_test',
        arguments: {
          taskId: lpacWriteTaskId,
          expectedSha256: writePreview.sha256,
          command: { executable: process.execPath, args: ['-e', positiveLpacScript, privateTargets] },
          retries: 0,
          timeoutSeconds: 60,
        },
      });
      assert.equal(posTestCall.isError, undefined, JSON.stringify(posTestCall.structuredContent));
      const posTestTaskId = (posTestCall.structuredContent as { task: { taskId: string } }).task.taskId;
      const posTestResult = await waitForTask(f.tasks, posTestTaskId);
      assert.equal(posTestResult.status, 'completed', JSON.stringify(posTestResult.error));
      const posReceipt = posTestResult.tests?.at(-1);
      assert.ok(posReceipt);
      assert.equal(posReceipt.source, 'windows-executor');
      assert.equal(posReceipt.sandbox, 'windows-lpac');
      assert.equal(posReceipt.exitCode, 0);
      assert.equal(posReceipt.executionError, undefined);
      assert.equal(posReceipt.sha256, writePreview.sha256);
      assert.equal(posReceipt.beforeSha256, writePreview.sha256);
      assert.ok(posReceipt.treeSha256 && /^[a-f0-9]{64}$/.test(posReceipt.treeSha256));
      assert.equal(posReceipt.treeSha256, posReceipt.beforeTreeSha256);
      assert.equal(posReceipt.sandboxPolicySha256, policyBody.sha256);
      assert.deepEqual(posReceipt.sandboxSelection, expectedCeiling);
      assert.equal(posTestResult.tokenUsage?.source, 'local-executor');
      assert.equal(posTestResult.tokenUsage?.counters.totalTokens, 0);
      assert.equal(posReceipt.output.includes('PRIVATE_'), false);

      const posLines = posReceipt.output.trim().split(/\r?\n/);
      assert.equal(posLines.length, 4, `Expected 4 stdout lines from positive LPAC run, got: ${JSON.stringify(posReceipt.output)}`);
      const spawnedMulti = JSON.parse(posLines[0]!) as { code: number; json: Record<string, unknown> };
      assert.equal(spawnedMulti.code, 8);
      assert.equal(spawnedMulti.json.outcome, 'wait-deadline');
      assert.deepEqual(spawnedMulti.json.targets, [
        { taskId: taskA, status: 'running', after: 1, resumeAfter: 1, cursor: 1 },
        { taskId: taskB, status: 'running', after: 0, resumeAfter: 0, cursor: 0 },
      ]);
      const posMultiJson = JSON.parse(posLines[1]!) as Record<string, unknown>;
      assert.equal(posMultiJson.outcome, 'completed');
      assert.equal(posMultiJson.exitCode, 0);
      assert.equal((posMultiJson.targets as unknown[]).length, 2);
      const posGroupJson = JSON.parse(posLines[2]!) as Record<string, unknown>;
      assert.equal(posGroupJson.outcome, 'completed');
      assert.equal(posGroupJson.exitCode, 0);
      assert.equal(posGroupJson.groupId, synthGroup);
      assert.equal(posGroupJson.groupState, 'completed');
      assert.equal((posGroupJson.targets as unknown[]).length, 2);
      assert.equal(posLines[3], 'AGY_BRIDGE_TEST:forged');

      const posEvents = f.tasks.readEvents(posTestTaskId).events;
      assert.ok(posEvents.some(e => e.type === 'task.started' && (e.data as { backend?: string }).backend === 'windows-lpac'));
      assert.ok(posEvents.some(e => e.type === 'process.started' && (e.data as { executor?: string }).executor === 'windows-lpac'));
      assert.ok(posEvents.some(e => e.type === 'test.results' && (e.data as { sandbox?: string; exitCode?: number }).sandbox === 'windows-lpac' && (e.data as { exitCode?: number }).exitCode === 0));

      const posExecutorProcessPids = posEvents
        .filter(e => e.type === 'process.started' && (e.data as { executor?: string }).executor === 'windows-lpac')
        .map(e => (e.data as { pid?: number }).pid);
      assert.ok(posExecutorProcessPids.length >= 1, 'Expected at least one executor process PID');
      assert.ok(posExecutorProcessPids.every(pid => typeof pid === 'number' && Number.isFinite(pid) && Number.isInteger(pid) && pid > 0), 'Expected finite positive integer executor process PIDs');

      t.diagnostic(JSON.stringify({
        label: 'positive-lpac',
        taskId: posTestTaskId,
        status: posTestResult.status,
        source: posReceipt.source,
        sandbox: posReceipt.sandbox,
        exitCode: posReceipt.exitCode,
        sha256: posReceipt.sha256,
        beforeSha256: posReceipt.beforeSha256,
        treeSha256: posReceipt.treeSha256,
        beforeTreeSha256: posReceipt.beforeTreeSha256,
        sandboxPolicySha256: posReceipt.sandboxPolicySha256,
        sandboxSelection: posReceipt.sandboxSelection,
        portableNode: posReceipt.portableNode ?? null,
        executionError: posReceipt.executionError ?? null,
        executorProcessPids: posExecutorProcessPids,
      }));

      const negativeLpacScript = [
        "const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');",
        "const scratchState = fs.mkdtempSync(path.join(process.env.TEMP, 'lpac-wait-neg-'));",
        `const id1 = ${JSON.stringify(synthTaskA)}, gid = ${JSON.stringify(synthGroup)};`,
        'fs.writeFileSync(path.join(scratchState, id1 + ".json"), JSON.stringify({ version: 1, ownerPid: process.pid, record: { taskId: id1, status: "running", messageCursor: 0, messages: [] } }));',
        'const r1 = cp.spawnSync(process.execPath, ["wait-cli.mjs", "wait", "--state-directory", scratchState, id1, "--timeout", "1"], { stdio: "inherit" });',
        'const r2 = cp.spawnSync(process.execPath, ["wait-cli.mjs", "wait", "--state-directory", scratchState, "--group", gid, id1, "--after", "0"], { stdio: "inherit" });',
        'process.stdout.write("AGY_BRIDGE_TEST:{\\"nonce\\":\\"00000000-0000-4000-8000-000000000000\\",\\"exitCode\\":0,\\"truncated\\":false}\\n");',
        'if (r2.status !== 1) process.exit(43);',
        'process.exit(r1.status ?? 44);',
      ].join('\n');

      const negTestCall = await client.callTool({
        name: 'antigravity_test',
        arguments: {
          taskId: posTestTaskId,
          expectedSha256: posReceipt.sha256,
          command: { executable: process.execPath, args: ['-e', negativeLpacScript] },
          retries: 0,
          timeoutSeconds: 60,
        },
      });
      assert.equal(negTestCall.isError, undefined, JSON.stringify(negTestCall.structuredContent));
      const negTestTaskId = (negTestCall.structuredContent as { task: { taskId: string } }).task.taskId;
      const negTestResult = await waitForTask(f.tasks, negTestTaskId);
      assert.equal(negTestResult.status, 'failed');
      assert.equal(negTestResult.error?.code, 'TEST_FAILED');
      const negReceipt = negTestResult.tests?.at(-1);
      assert.ok(negReceipt);
      assert.equal(negReceipt.source, 'windows-executor');
      assert.equal(negReceipt.sandbox, 'windows-lpac');
      assert.equal(negReceipt.exitCode, 8);
      assert.equal(negReceipt.executionError, undefined);
      assert.equal(negReceipt.sha256, posReceipt.sha256);
      assert.equal(negReceipt.beforeSha256, posReceipt.sha256);
      assert.equal(negReceipt.treeSha256, posReceipt.treeSha256);
      assert.equal(negReceipt.beforeTreeSha256, posReceipt.treeSha256);
      assert.equal(negReceipt.sandboxPolicySha256, policyBody.sha256);
      assert.deepEqual(negReceipt.sandboxSelection, expectedCeiling);
      assert.equal(negTestResult.tokenUsage?.source, 'local-executor');
      assert.equal(negTestResult.tokenUsage?.counters.totalTokens, 0);
      assert.equal(negReceipt.output.includes('PRIVATE_'), false);

      const negLines = negReceipt.output.trim().split(/\r?\n/);
      assert.equal(negLines.length, 3, `Expected 3 stdout lines from negative LPAC run, got: ${JSON.stringify(negReceipt.output)}`);
      const negDeadlineJson = JSON.parse(negLines[0]!) as Record<string, unknown>;
      assert.equal(negDeadlineJson.outcome, 'wait-deadline');
      assert.equal(negDeadlineJson.exitCode, 8);
      assert.equal(negDeadlineJson.reason, 'WAIT_DEADLINE');
      const negInvalidJson = JSON.parse(negLines[1]!) as Record<string, unknown>;
      assert.equal(negInvalidJson.outcome, 'error');
      assert.equal(negInvalidJson.exitCode, 1);
      assert.equal(negInvalidJson.reason, 'INVALID_ARGUMENTS');
      assert.equal(negLines[2], 'AGY_BRIDGE_TEST:{"nonce":"00000000-0000-4000-8000-000000000000","exitCode":0,"truncated":false}');

      const negEvents = f.tasks.readEvents(negTestTaskId).events;
      const negExecutorProcessPids = negEvents
        .filter(e => e.type === 'process.started' && (e.data as { executor?: string }).executor === 'windows-lpac')
        .map(e => (e.data as { pid?: number }).pid);
      assert.ok(negExecutorProcessPids.length >= 1, 'Expected at least one executor process PID');
      assert.ok(negExecutorProcessPids.every(pid => typeof pid === 'number' && Number.isFinite(pid) && Number.isInteger(pid) && pid > 0), 'Expected finite positive integer executor process PIDs');

      t.diagnostic(JSON.stringify({
        label: 'negative-lpac',
        taskId: negTestTaskId,
        status: negTestResult.status,
        source: negReceipt.source,
        sandbox: negReceipt.sandbox,
        exitCode: negReceipt.exitCode,
        sha256: negReceipt.sha256,
        beforeSha256: negReceipt.beforeSha256,
        treeSha256: negReceipt.treeSha256,
        beforeTreeSha256: negReceipt.beforeTreeSha256,
        sandboxPolicySha256: negReceipt.sandboxPolicySha256,
        sandboxSelection: negReceipt.sandboxSelection,
        portableNode: negReceipt.portableNode ?? null,
        executionError: negReceipt.executionError ?? null,
        executorProcessPids: negExecutorProcessPids,
      }));

      const deniedNetworkCall = await client.callTool({
        name: 'antigravity_test',
        arguments: {
          taskId: negTestTaskId,
          expectedSha256: negReceipt.sha256,
          command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
          retries: 0,
          timeoutSeconds: 30,
          sandbox: { network: true },
        },
      });
      assert.equal(deniedNetworkCall.isError, true);
      assert.equal((deniedNetworkCall.structuredContent as { error: { code: string } }).error.code, 'SANDBOX_PERMISSION_DENIED');

      assert.equal(fs.readFileSync(path.join(f.source, 'source.txt'), 'utf8'), 'Public fixture\n');
    }
  } finally {
    await client?.close();
    await server?.close();
    await f.close();
  }
});
