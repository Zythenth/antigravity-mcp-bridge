import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AgyExecutionAdapter, type AgyExecutionHooks } from '../src/agy-execution-adapter.js';
import { CliAdapter, taskPrompt } from '../src/cli-adapter.js';
import { loadConfig } from '../src/config.js';
import {
  assertExecutionCapabilities,
  type ExecutionAdapter,
  type ExecutionRequest,
  type ExecutionResult,
} from '../src/execution-contract.js';
import { TaskManager } from '../src/task-manager.js';
import type { RunOptions } from '../src/types.js';
import { AgyExecutionFixture } from './agy-fixture.js';
import { ControlledCliAdapter, fixtureDiscovery } from './controlled-cli-adapter.js';
import { OtherProviderExecutionFixture } from './other-fixture.js';
import { waitForTask } from './wait-for-task.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_AGY = path.resolve(HERE, '../../tests/mock-agy.mjs');
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timeout']);

interface ScenarioHookCall {
  readonly name: string;
  readonly args?: Record<string, unknown>;
  readonly copyRelativePathArg?: { readonly key: string; readonly relativePath: string };
  readonly conversationId?: string;
  readonly emitDenialStep?: boolean;
  readonly emitStderrDenial?: boolean;
}

interface ScenarioSpec {
  readonly stdoutLines?: readonly unknown[];
  readonly stdoutRaw?: readonly string[];
  readonly stderrLines?: readonly string[];
  readonly exitCode?: number;
  readonly delayMs?: number;
  readonly holdUntilSigterm?: boolean;
  readonly authError?: boolean;
  readonly hookCalls?: readonly ScenarioHookCall[];
  readonly writeFile?: { readonly path: string; readonly content: string };
  readonly runNativeTest?: boolean;
}

function buildScenarioCliScript(defaultSpec: ScenarioSpec = {}): string {
  return `
import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('agy-scenario 1.0.0\\n');
  process.exit(0);
}
if (args.includes('--help')) {
  process.stdout.write('models --output-format stream-json --sandbox --mode accept-edits plan --model --effort --conversation --json-schema --add-dir --new-project\\n');
  process.exit(0);
}
if (args.includes('models')) {
  if (args.includes('--scenario-auth-error')) {
    process.stderr.write('authentication required; run agy login\\n');
    process.exit(1);
  }
  process.stdout.write('mock-pro\\tMock Pro\\nmock-flash\\tMock Flash\\n');
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  input += chunk;
}

let prompt = '';
try {
  const parsed = JSON.parse(input.trim());
  prompt = String(parsed?.message?.content ?? '');
} catch {
  prompt = input;
}

const DEFAULT_SPEC = ${JSON.stringify(defaultSpec)};
const scenarioMatch = prompt.match(/\\/\\*SCENARIO_B64:([A-Za-z0-9+/=]+)\\*\\//);
const spec = scenarioMatch ? JSON.parse(Buffer.from(scenarioMatch[1], 'base64').toString('utf8')) : DEFAULT_SPEC;

if (spec.writeFile) {
  writeFileSync(path.join(process.cwd(), spec.writeFile.path), spec.writeFile.content, 'utf8');
}

for (const line of spec.stderrLines ?? []) {
  process.stderr.write(line + '\\n');
}

if (spec.authError || args.includes('--scenario-auth-error')) {
  process.stderr.write('authentication required; run agy login\\n');
  process.exit(spec.exitCode ?? 1);
}

let hookStepIndex = 100;
for (const call of spec.hookCalls ?? []) {
  const hookArgs = { ...(call.args ?? {}) };
  if (call.copyRelativePathArg) {
    hookArgs[call.copyRelativePathArg.key] = path.join(realpathSync(process.cwd()), call.copyRelativePathArg.relativePath);
  }
  const hookOut = execFileSync(process.execPath, ['bridge-execution-hook.mjs'], {
    cwd: path.join(process.cwd(), '.agents'),
    input: JSON.stringify({
      toolCall: { name: call.name, args: hookArgs },
      conversationId: call.conversationId ?? '',
    }),
    encoding: 'utf8',
  });
  const parsedDecision = JSON.parse(hookOut.trim());
  if (parsedDecision.decision === 'deny') {
    const reason = parsedDecision.reason || 'denied by execution policy';
    if (call.emitStderrDenial) {
      process.stderr.write('Denied by pre-tool hook: ' + reason + '\\n');
    } else if (call.emitDenialStep !== false) {
      process.stdout.write(JSON.stringify({
        event: 'step_update',
        step_update: {
          step_index: hookStepIndex++,
          step_type: 'tool',
          state: 'ERROR',
          tool_name: call.name,
          tool_info: { error: { type: 'HookDenied', message: 'Denied by pre-tool hook: ' + reason } },
        },
      }) + '\\n');
    }
  } else {
    process.stdout.write(JSON.stringify({
      event: 'step_update',
      step_update: {
        step_index: hookStepIndex++,
        step_type: 'tool',
        state: 'DONE',
        tool_name: call.name,
        tool_info: { parameters: hookArgs, output: 'ok' },
      },
    }) + '\\n');
  }
}

if (spec.runNativeTest) {
  const testTag = prompt.match(/<bridge-test-command>(\\{.*?\\})<\\/bridge-test-command>/);
  const cmdInfo = testTag ? JSON.parse(testTag[1]) : null;
  const scriptMatch = cmdInfo?.commandLine?.match(/\\.black-gravity-test-[0-9a-f-]+\\.cjs/);
  if (cmdInfo && scriptMatch) {
    let output = '';
    try {
      output = execFileSync(process.execPath, [scriptMatch[0]], { cwd: process.cwd(), encoding: 'utf8' });
    } catch (err) {
      output = String(err?.stdout ?? '') + String(err?.stderr ?? '');
    }
    process.stdout.write(JSON.stringify({
      event: 'step_update',
      step_update: {
        step_index: 0,
        step_type: 'tool',
        state: 'DONE',
        tool_name: 'run_command',
        tool_info: { parameters: { CommandLine: cmdInfo.commandLine }, output },
      },
    }) + '\\n');
  }
}

for (const rawLine of spec.stdoutRaw ?? []) {
  process.stdout.write(rawLine + '\\n');
}
for (const frame of spec.stdoutLines ?? []) {
  process.stdout.write(JSON.stringify(frame) + '\\n');
}

if (spec.holdUntilSigterm) {
  process.on('SIGTERM', () => process.exit(143));
  setInterval(() => {}, 1000);
} else {
  if (spec.delayMs) await new Promise(resolve => setTimeout(resolve, spec.delayMs));
  process.exit(spec.exitCode ?? 0);
}
`;
}

function encodeScenarioPrompt(spec: ScenarioSpec): string {
  const b64 = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
  return `/*SCENARIO_B64:${b64}*/`;
}

function createWorkspace(): {
  root: string;
  repoDir: string;
  stateDir: string;
  scenarioScript: string;
  cleanup: () => void;
} {
  const rawRoot = mkdtempSync(path.join(os.tmpdir(), 'e03-adapter-'));
  const root = realpathSync(rawRoot);
  const repoDir = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  const scenarioScript = path.join(root, 'scenario-cli.mjs');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(repoDir, 'app.txt'), 'line1\r\nline2\r\n', 'utf8');
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
  writeFileSync(scenarioScript, buildScenarioCliScript(), 'utf8');
  return {
    root,
    repoDir,
    stateDir,
    scenarioScript,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

async function settleTask(tasks: TaskManager, taskId: string, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = tasks.status(taskId);
    if (TERMINAL_STATUSES.has(record.status)) return record;
    await delay(25);
  }
  throw new Error(`Task ${taskId} did not settle within ${timeoutMs}ms`);
}

function makeRequest(overrides: Partial<ExecutionRequest> & { workingDirectory: string }): ExecutionRequest {
  return {
    taskId: 'task-standalone-1',
    prompt: 'default',
    role: 'implementer',
    mode: 'write',
    ...overrides,
  };
}

test('AgyExecutionAdapter exposes neutral identity, discovery capabilities, and explicit capability guards', async () => {
  const env = createWorkspace();
  try {
    const config = loadConfig({ BRIDGE_STATE_DIRECTORY: env.stateDir, AGY_PATH: process.execPath });
    const cli = new CliAdapter(config, [MOCK_AGY]);
    const adapter = new AgyExecutionAdapter(cli, config);

    assert.deepEqual(adapter.identity, { id: 'agy', provider: 'agy' });
    assert.equal(adapter.capabilities.read, 'unknown');
    assert.equal(adapter.capabilities.write, 'unknown');
    assert.equal(adapter.capabilities.structuredOutput, 'unknown');
    assert.equal(adapter.capabilities.resume, 'unknown');
    assert.equal(adapter.capabilities.network, 'unknown');
    assert.throws(
      () => assertExecutionCapabilities(makeRequest({ workingDirectory: env.repoDir, mode: 'write' }), adapter.capabilities),
      /Execution capability unavailable: write/,
    );

    const discovery = await cli.discover();
    assert.equal(discovery.installed, true);
    assert.equal(adapter.capabilities.read, 'supported');
    assert.equal(adapter.capabilities.write, 'supported');
    assert.equal(adapter.capabilities.structuredOutput, 'supported');
    assert.equal(adapter.capabilities.resume, 'supported');

    const readDenied = new AgyExecutionAdapter(cli, config, {
      read: 'unsupported',
      write: 'supported',
      sandbox: 'supported',
      structuredOutput: 'supported',
      resume: 'supported',
    });
    assert.throws(
      () => assertExecutionCapabilities(makeRequest({ workingDirectory: env.repoDir, mode: 'read-only' }), readDenied.capabilities),
      /Execution capability unavailable: read/,
    );
    const failed = await readDenied.execute(makeRequest({ workingDirectory: env.repoDir, mode: 'read-only' }));
    assert.equal(failed.status, 'failed');
    if (failed.status === 'failed') {
      assert.equal(failed.error.code, 'AGY_CAPABILITY_UNAVAILABLE');
      assert.match(failed.error.message, /read/);
    }

    const missingConfig = loadConfig({
      BRIDGE_STATE_DIRECTORY: env.stateDir,
      AGY_PATH: path.join(env.root, 'missing-agy-binary'),
    });
    const missingCli = new CliAdapter(missingConfig);
    const missingAdapter = new AgyExecutionAdapter(missingCli, missingConfig);
    assert.equal(missingAdapter.capabilities.write, 'unknown');
    const missingResult = await missingAdapter.execute(makeRequest({ workingDirectory: env.repoDir }));
    assert.equal(missingResult.status, 'failed');
    if (missingResult.status === 'failed') {
      assert.equal(missingResult.error.code, 'AGY_NOT_FOUND');
    }
    assert.equal(missingAdapter.capabilities.write, 'unsupported');

    const noPlanScript = path.join(env.root, 'no-plan-cli.mjs');
    writeFileSync(
      noPlanScript,
      `const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('agy-no-plan 1.0.0\\n'); process.exit(0); }
if (args.includes('--help')) { process.stdout.write('models --output-format stream-json --sandbox --model --conversation\\n'); process.exit(0); }
process.exit(1);`,
      'utf8',
    );
    const noPlanCli = new CliAdapter(config, [noPlanScript]);
    const noPlanAdapter = new AgyExecutionAdapter(noPlanCli, config);
    assert.equal(noPlanAdapter.capabilities.read, 'unknown');
    const noPlanResult = await noPlanAdapter.execute(makeRequest({ workingDirectory: env.repoDir, mode: 'read-only' }));
    assert.equal(noPlanResult.status, 'failed');
    if (noPlanResult.status === 'failed') {
      assert.equal(noPlanResult.error.code, 'AGY_CAPABILITY_UNAVAILABLE');
      assert.match(noPlanResult.error.message, /read/);
    }
    assert.equal(noPlanAdapter.capabilities.read, 'unsupported');

    const lazyCli = new CliAdapter(config, [env.scenarioScript]);
    const lazyAdapter = new AgyExecutionAdapter(lazyCli, config);
    assert.equal(lazyAdapter.capabilities.write, 'unknown');
    const lazyResult = await lazyAdapter.execute(makeRequest({
      taskId: 'lazy-discovery-ok',
      workingDirectory: env.repoDir,
      prompt: encodeScenarioPrompt({
        stdoutLines: [
          { event: 'init', conversation_id: 'c-lazy-1' },
          { event: 'result', result: { status: 'SUCCESS', conversation_id: 'c-lazy-1', response: 'discovered ok' } },
        ],
      }),
    }));
    assert.equal(lazyResult.status, 'completed');
    if (lazyResult.status === 'completed') {
      assert.equal(lazyResult.response, 'discovered ok');
    }
    assert.equal(lazyAdapter.capabilities.write, 'supported');
  } finally {
    env.cleanup();
  }
});

test('AgyExecutionAdapter standalone execution preserves parity, redaction across chunks, and AbortSignal cancellation', async () => {
  const env = createWorkspace();
  try {
    const config = loadConfig({ BRIDGE_STATE_DIRECTORY: env.stateDir, AGY_PATH: process.execPath });
    const cli = new CliAdapter(config, [MOCK_AGY]);
    await cli.discover();
    const adapter = new AgyExecutionAdapter(cli, config);

    const completed = await adapter.execute(makeRequest({
      taskId: 'standalone-write',
      prompt: 'write:hello standalone',
      workingDirectory: env.repoDir,
    }));
    assert.equal(completed.status, 'completed');
    if (completed.status === 'completed') {
      assert.equal(completed.response, taskPrompt({ prompt: 'write:hello standalone', workingDirectory: env.repoDir }, config.maxPromptChars));
      assert.equal(completed.session?.id, 'mock-conversation');
    }

    const scenarioCli = new CliAdapter(config, [env.scenarioScript]);
    await scenarioCli.discover();
    const scenarioAdapter = new AgyExecutionAdapter(scenarioCli, config);
    const pemHeader = ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join('');
    const pemFooter = ['-----END RSA ', 'PRIVATE KEY-----'].join('');
    const secretChunks: string[] = [];
    const secretResult = await scenarioAdapter.execute(
      makeRequest({
        taskId: 'standalone-split-redaction',
        workingDirectory: env.repoDir,
        prompt: encodeScenarioPrompt({
          stdoutLines: [
            { event: 'init', conversation_id: 'conv-split' },
            {
              event: 'step_update',
              step_update: { step_index: 0, step_type: 'agent_response', state: 'RUNNING', text_delta: `prefix ${pemHeader.slice(0, 10)}` },
            },
            {
              event: 'step_update',
              step_update: { step_index: 0, step_type: 'agent_response', state: 'RUNNING', text_delta: `${pemHeader.slice(10)}\nMIIBOgIBAAJBA\n${pemFooter}\n` },
            },
            {
              event: 'step_update',
              step_update: { step_index: 0, step_type: 'agent_response', state: 'DONE', text_delta: 'done\n' },
            },
            {
              event: 'result',
              result: { status: 'SUCCESS', conversation_id: 'conv-split', response: 'safe summary', usage: { input_tokens: 1, output_tokens: 2 } },
            },
          ],
        }),
      }),
      {
        onEvent: (type, data) => {
          if (type === 'response.chunk') {
            secretChunks.push(String((data as { text_delta?: unknown }).text_delta ?? ''));
          }
        },
      },
    );
    assert.equal(secretResult.status, 'completed');
    const joined = secretChunks.join('');
    assert.ok(!joined.includes('MIIBOgIBAAJBA'), 'Expected split private key body to be redacted');
    assert.ok(joined.includes('[private key redacted]'));

    const forwardedChunks: string[] = [];
    const forwardedRawDeltas: string[] = [];
    const streamOnlyResult = await scenarioAdapter.execute(
      makeRequest({
        taskId: 'standalone-bounded-stream-no-fallback-buffer',
        workingDirectory: env.repoDir,
        prompt: encodeScenarioPrompt({
          stdoutLines: [
            { event: 'init', conversation_id: 'conv-stream-only' },
            { event: 'step_update', step_update: { step_index: 0, step_type: 'agent_response', state: 'RUNNING', text_delta: 'part-1 ' } },
            { event: 'step_update', step_update: { step_index: 0, step_type: 'agent_response', state: 'DONE', text_delta: 'part-2' } },
            { event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-stream-only' } },
          ],
        }),
      }),
      {
        onEvent: (type, data) => {
          if (type === 'response.chunk') {
            forwardedChunks.push(String((data as { text_delta?: unknown }).text_delta ?? ''));
          }
        },
        onRawResponseDelta: (_index, textDelta) => {
          forwardedRawDeltas.push(textDelta);
        },
      },
    );
    assert.equal(streamOnlyResult.status, 'completed');
    if (streamOnlyResult.status === 'completed') {
      assert.equal(streamOnlyResult.response, '');
    }
    assert.equal(forwardedChunks.join(''), 'part-1 part-2');
    assert.equal(forwardedRawDeltas.join(''), 'part-1 part-2');

    const controller = new AbortController();
    setTimeout(() => controller.abort('cancelled'), 100);
    const cancelResult = await scenarioAdapter.execute(
      makeRequest({
        taskId: 'standalone-cancel',
        workingDirectory: env.repoDir,
        prompt: encodeScenarioPrompt({ holdUntilSigterm: true }),
      }),
      { signal: controller.signal },
    );
    assert.equal(cancelResult.status, 'cancelled');
    if (cancelResult.status === 'cancelled') {
      assert.equal(cancelResult.error.code, 'TASK_CANCELLED');
    }
    assert.equal(cancelResult.processCleanup?.verified, true);
  } finally {
    env.cleanup();
  }
});

test('TaskManager routes production runs and native tests through ExecutionAdapter with queue/model/auth/read-only parity', async () => {
  const env = createWorkspace();
  let tasks: TaskManager | undefined;
  try {
    const config = loadConfig({
      BRIDGE_STATE_DIRECTORY: env.stateDir,
      AGY_PATH: process.execPath,
      BRIDGE_TEST_EXECUTOR: 'agy',
      MAX_CONCURRENT_TASKS: '1',
      BRIDGE_ANTI_AI_CRAFT: 'off',
    });
    const nativePassScript = path.join(env.root, 'native-pass-cli.mjs');
    writeFileSync(nativePassScript, buildScenarioCliScript({
      runNativeTest: true,
      stdoutLines: [
        { event: 'init', conversation_id: 'conv-native-1' },
        { event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-native-1', response: 'tested' } },
      ],
    }), 'utf8');
    const cli = new CliAdapter(config, [nativePassScript]);
    await cli.discover();

    const authCli = new CliAdapter(config, [nativePassScript, '--scenario-auth-error']);
    const authHealth = await authCli.health();
    assert.equal(authHealth.installed, true);
    assert.equal(authHealth.authenticated, false);
    await assert.rejects(authCli.listModels(), { code: 'AGY_AUTH_REQUIRED' });

    const observedRequests: ExecutionRequest[] = [];
    class SpyingAgyAdapter extends AgyExecutionAdapter {
      override execute(request: ExecutionRequest, hooks?: AgyExecutionHooks) {
        observedRequests.push(request);
        return super.execute(request, hooks);
      }
    }
    const spyingAdapter = new SpyingAgyAdapter(cli, config);

    tasks = new TaskManager(cli, config, spyingAdapter);
    const runTask = await tasks.run({
      workingDirectory: env.repoDir,
      prompt: encodeScenarioPrompt({
        writeFile: { path: 'app.txt', content: 'line1\nline2\nline3\n' },
        stdoutLines: [
          { event: 'init', conversation_id: 'conv-run-1' },
          { event: 'step_update', step_update: { step_index: 0, step_type: 'agent_response', state: 'DONE', text_delta: 'ok\n' } },
          { event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-run-1', response: 'applied', usage: { input_tokens: 3, output_tokens: 4 } } },
        ],
      }),
      model: 'mock-pro',
    });
    const settledRun = await settleTask(tasks, runTask.taskId);
    assert.equal(settledRun.status, 'completed');
    assert.equal(settledRun.sessionId, 'conv-run-1');
    assert.equal(settledRun.exitCode, 0);
    assert.equal(observedRequests.length, 1);
    assert.equal(observedRequests[0]!.workingDirectory, settledRun.copyDirectory);
    assert.equal(observedRequests[0]!.model, 'mock-pro');

    const blockerTask = await tasks.run({
      workingDirectory: env.repoDir,
      prompt: encodeScenarioPrompt({
        stdoutLines: [{ event: 'init', conversation_id: 'conv-blocker-1' }],
        holdUntilSigterm: true,
      }),
      model: 'mock-flash',
    });

    const queuedTask = await tasks.run({
      workingDirectory: env.repoDir,
      prompt: encodeScenarioPrompt({
        stdoutLines: [
          { event: 'init', conversation_id: 'conv-queued-1' },
          { event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-queued-1', response: 'queued model kept' } },
        ],
      }),
      model: 'mock-flash',
    });
    assert.equal(queuedTask.status, 'queued');
    const waitStartDeadline = Date.now() + 10000;
    while (tasks.status(blockerTask.taskId).pid === undefined) {
      if (Date.now() >= waitStartDeadline) throw new Error('Blocker task did not spawn');
      await delay(25);
    }
    const updatedDefaultModel = await tasks.setModel('mock-pro');
    assert.equal(updatedDefaultModel, 'mock-pro');
    assert.equal(tasks.getModel(), 'mock-pro');
    assert.equal(tasks.status(queuedTask.taskId).model, 'mock-flash');
    await assert.rejects(tasks.setModel('not-available'), { code: 'MODEL_NOT_AVAILABLE' });

    await tasks.cancel(blockerTask.taskId);
    const settledBlocker = await settleTask(tasks, blockerTask.taskId);
    assert.equal(settledBlocker.status, 'cancelled');
    assert.equal(settledBlocker.error?.code, 'TASK_CANCELLED');

    const settledQueued = await settleTask(tasks, queuedTask.taskId);
    assert.equal(settledQueued.status, 'completed');
    assert.equal(settledQueued.model, 'mock-flash');
    assert.equal(observedRequests[2]!.model, 'mock-flash');

    const defaultModelTask = await tasks.run({
      workingDirectory: env.repoDir,
      prompt: encodeScenarioPrompt({
        stdoutLines: [
          { event: 'init', conversation_id: 'conv-default-model-1' },
          { event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-default-model-1', response: 'used default model' } },
        ],
      }),
    });
    const settledDefaultModel = await settleTask(tasks, defaultModelTask.taskId);
    assert.equal(settledDefaultModel.status, 'completed');
    assert.equal(settledDefaultModel.model, 'mock-pro');
    assert.equal(observedRequests[3]!.model, 'mock-pro');

    const authFailedTask = await tasks.run({
      workingDirectory: env.repoDir,
      prompt: encodeScenarioPrompt({ authError: true }),
    });
    const settledAuthFailed = await settleTask(tasks, authFailedTask.taskId);
    assert.equal(settledAuthFailed.status, 'failed');
    assert.equal(settledAuthFailed.error?.code, 'AGY_AUTH_REQUIRED');

    const preview = await tasks.preview(runTask.taskId);
    const testTask = await tasks.startTests(
      runTask.taskId,
      preview.sha256,
      { executable: process.execPath, args: ['-e', 'console.log("native ok")'] },
      0,
      30,
    );
    const settledTest = await waitForTask(tasks, testTask.taskId);
    assert.equal(settledTest.status, 'completed');
    assert.equal(settledTest.tests?.length, 1);
    assert.equal(settledTest.tests?.[0]?.exitCode, 0);
    assert.equal(observedRequests.length, 6, 'Expected production runs and native test runs to execute via adapter');
  } finally {
    await tasks?.shutdown();
    env.cleanup();
  }
});

test('TaskManager timeout starts after process spawn rather than before async line-ending preparation', async () => {
  const env = createWorkspace();
  let tasks: TaskManager | undefined;
  try {
    const config = loadConfig({ BRIDGE_STATE_DIRECTORY: env.stateDir, AGY_PATH: process.execPath, BRIDGE_ANTI_AI_CRAFT: 'off' });
    const cli = new CliAdapter(config, [env.scenarioScript]);
    await cli.discover();
    tasks = new TaskManager(cli, config, new AgyExecutionAdapter(cli, config));

    // Pre-spawn LF normalization slower than timeoutSeconds (1s) must not exhaust execution timeout.
    const internal = tasks as unknown as {
      prepareLfCopy: (task: unknown, convertLf: boolean) => Promise<unknown>;
    };
    const originalPrepareLf = internal.prepareLfCopy.bind(tasks);
    internal.prepareLfCopy = async (taskArg: unknown, convertLf: boolean) => {
      await delay(1200);
      return originalPrepareLf(taskArg, convertLf);
    };

    const completedAfterSlowPrep = await tasks.run({
      workingDirectory: env.repoDir,
      timeoutSeconds: 1,
      prompt: encodeScenarioPrompt({
        delayMs: 100,
        stdoutLines: [
          { event: 'init', conversation_id: 'c-post-spawn-ok' },
          { event: 'result', result: { status: 'SUCCESS', conversation_id: 'c-post-spawn-ok', response: 'ok' } },
        ],
      }),
    });
    const settledOk = await settleTask(tasks, completedAfterSlowPrep.taskId);
    assert.equal(settledOk.status, 'completed', JSON.stringify(settledOk.error));

    const postSpawnTimeout = await tasks.run({
      workingDirectory: env.repoDir,
      timeoutSeconds: 1,
      prompt: encodeScenarioPrompt({
        stdoutLines: [{ event: 'init', conversation_id: 'c-post-spawn-timeout' }],
        holdUntilSigterm: true,
      }),
    });
    const settledTimeout = await settleTask(tasks, postSpawnTimeout.taskId);
    assert.equal(settledTimeout.status, 'timeout');
    assert.equal(settledTimeout.error?.code, 'TASK_TIMEOUT');
  } finally {
    await tasks?.shutdown();
    env.cleanup();
  }
});

test('TaskManager supports pure E02 ExecutionAdapter fixtures and rejects incomplete statuses or read-only writes', async () => {
  const env = createWorkspace();
  let tasks: TaskManager | undefined;
  try {
    const config = loadConfig({ BRIDGE_STATE_DIRECTORY: env.stateDir, AGY_PATH: process.execPath, BRIDGE_ANTI_AI_CRAFT: 'off' });
    const cli = new CliAdapter(config);

    // 1. Pure E02 SUCCESS fixture without hooks.
    tasks = new TaskManager(cli, config, new AgyExecutionFixture({
      status: 'SUCCESS',
      conversation_id: 'fixture-session-1',
      response: 'fixture done',
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const okTask = await tasks.run({ workingDirectory: env.repoDir, prompt: 'pure fixture' });
    const settledOk = await settleTask(tasks, okTask.taskId);
    assert.equal(settledOk.status, 'completed');
    assert.equal(settledOk.sessionId, 'fixture-session-1');
    assert.equal(settledOk.tokenUsage?.counters.inputTokens, 10);
    await tasks.shutdown();

    // 2. needs-host (WAITING) must fail cleanly instead of completing or hanging.
    tasks = new TaskManager(cli, config, new AgyExecutionFixture({
      status: 'WAITING',
      conversation_id: 'fixture-wait',
      hostMessage: { kind: 'question', text: 'Need confirmation' },
    }));
    const waitTask = await tasks.run({ workingDirectory: env.repoDir, prompt: 'needs host' });
    const settledWait = await settleTask(tasks, waitTask.taskId);
    assert.equal(settledWait.status, 'failed');
    assert.equal(settledWait.error?.code, 'AGY_PROCESS_FAILED');
    assert.match(settledWait.error?.message ?? '', /Need confirmation/);
    await tasks.shutdown();

    // 3. Non-terminal adapter result (running) must fail with clear incomplete reason.
    tasks = new TaskManager(cli, config, new AgyExecutionFixture({ status: 'RUNNING', conversation_id: 'fixture-running' }));
    const runningTask = await tasks.run({ workingDirectory: env.repoDir, prompt: 'still running' });
    const settledRunning = await settleTask(tasks, runningTask.taskId);
    assert.equal(settledRunning.status, 'failed');
    assert.equal(settledRunning.error?.code, 'AGY_PROCESS_FAILED');
    assert.match(settledRunning.error?.message ?? '', /running/);
    await tasks.shutdown();

    // 4. Read-only mode still verifies no copy files changed even behind a custom ExecutionAdapter.
    const mutatingAdapter: ExecutionAdapter = {
      identity: { id: 'mutator', provider: 'test' },
      capabilities: { read: 'supported', write: 'supported', sandbox: 'supported', structuredOutput: 'supported', resume: 'supported' },
      async execute(request) {
        writeFileSync(path.join(request.workingDirectory, 'app.txt'), 'mutated in read-only\n', 'utf8');
        return { taskId: request.taskId, status: 'completed', response: 'mutated' };
      },
    };
    tasks = new TaskManager(cli, config, mutatingAdapter);
    const roTask = await tasks.run({ workingDirectory: env.repoDir, prompt: 'mutate', mode: 'read-only' });
    const settledRo = await settleTask(tasks, roTask.taskId);
    assert.equal(settledRo.status, 'failed');
    assert.equal(settledRo.error?.code, 'READ_ONLY_VIOLATION');
  } finally {
    await tasks?.shutdown();
    env.cleanup();
  }
});

test('Rejects soft tool denials (including stderr-only with exit 0) and every non-SUCCESS status across JSON, streaming and native paths', async () => {
  const env = createWorkspace();
  let tasks: TaskManager | undefined;
  try {
    const config = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'off',
      BRIDGE_STATE_DIRECTORY: env.stateDir,
      AGY_PATH: process.execPath,
      BRIDGE_TEST_EXECUTOR: 'agy',
    });
    const cli = new CliAdapter(config, [env.scenarioScript]);
    await cli.discover();
    tasks = new TaskManager(cli, config, new AgyExecutionAdapter(cli, config));

    const longStderrNoise = Array.from({ length: 160 }, (_, idx) => `trailing info line ${idx}: ${'x'.repeat(80)}`);

    const failureCases: Array<{
      name: string;
      spec: ScenarioSpec;
      expectedStatus: 'failed' | 'cancelled' | 'timeout';
      expectedCode: string;
      messagePattern: RegExp;
    }> = [
      {
        name: 'exit 0 + SUCCESS with denied_actions tool denial',
        spec: {
          exitCode: 0,
          stdoutLines: [
            { event: 'init', conversation_id: 'c-denied-1' },
            { event: 'result', result: { status: 'SUCCESS', denied_actions: [{ action: 'run_command', reason: 'user denied' }], response: 'done' } },
          ],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_PROCESS_FAILED',
        messagePattern: /run_command/i,
      },
      {
        name: 'exit 0 + SUCCESS with denied_actions escalate_admin',
        spec: {
          exitCode: 0,
          stdoutLines: [
            { event: 'result', result: { status: 'SUCCESS', denied_actions: [{ action: 'escalate_admin' }] } },
          ],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_SANDBOX_SETUP_REQUIRED',
        messagePattern: /administrative sandbox setup/i,
      },
      {
        name: 'exit 0 + SUCCESS with denied_actions unsandboxed',
        spec: {
          exitCode: 0,
          stdoutLines: [
            { event: 'result', result: { status: 'SUCCESS', denied_actions: [{ action: 'unsandboxed' }] } },
          ],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_SANDBOX_BYPASS_DENIED',
        messagePattern: /denied sandbox bypass/i,
      },
      {
        name: 'exit 0 + SUCCESS with stderr-only tool denial pushed past 10KB buffer tail',
        spec: {
          exitCode: 0,
          stderrLines: ['Tool call denied: headless mode cannot request permission for write_to_file', ...longStderrNoise],
          stdoutLines: [
            { event: 'init', conversation_id: 'c-stderr-1' },
            { event: 'result', result: { status: 'SUCCESS', response: 'claimed done' } },
          ],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_PROCESS_FAILED',
        messagePattern: /tool call denied/i,
      },
      {
        name: 'exit 0 + SUCCESS with stderr-only MCP permission denial',
        spec: {
          exitCode: 0,
          stderrLines: ['permission check failed for mcp tool context7'],
          stdoutLines: [
            { event: 'result', result: { status: 'SUCCESS', response: 'ok' } },
          ],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_MCP_PERMISSION_REQUIRED',
        messagePattern: /MCP/i,
      },
      {
        name: 'exit 0 + SUCCESS with streaming tool step ERROR permission denial',
        spec: {
          exitCode: 0,
          stdoutLines: [
            { event: 'init', conversation_id: 'c-stream-denial' },
            {
              event: 'step_update',
              step_update: {
                step_index: 0,
                step_type: 'tool',
                state: 'ERROR',
                tool_name: 'write_to_file',
                tool_info: { error: { type: 'PermissionError', message: 'permission check failed for write_to_file' } },
              },
            },
            { event: 'result', result: { status: 'SUCCESS', response: 'finished anyway' } },
          ],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_PROCESS_FAILED',
        messagePattern: /permission check failed/i,
      },
      {
        name: 'exit 0 + SUCCESS with streaming run_command DONE unsandboxed denial',
        spec: {
          exitCode: 0,
          stdoutLines: [
            {
              event: 'step_update',
              step_update: {
                step_index: 0,
                step_type: 'tool',
                state: 'DONE',
                tool_name: 'run_command',
                tool_info: { output: 'permission check failed for unsandboxed' },
              },
            },
            { event: 'result', result: { status: 'SUCCESS', response: 'finished anyway' } },
          ],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_SANDBOX_BYPASS_DENIED',
        messagePattern: /denied sandbox bypass/i,
      },
      {
        name: 'exit 0 + SUCCESS with non-empty result.error',
        spec: {
          exitCode: 0,
          stdoutLines: [
            { event: 'result', result: { status: 'SUCCESS', error: 'Tool backend rejected request', response: 'ok' } },
          ],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_PROCESS_FAILED',
        messagePattern: /Tool backend rejected request/,
      },
      {
        name: 'exit 0 without any result event (never infers success from exit 0)',
        spec: {
          exitCode: 0,
          stdoutLines: [
            { event: 'init', conversation_id: 'c-no-result' },
            { event: 'step_update', step_update: { step_index: 0, step_type: 'agent_response', state: 'DONE', text_delta: 'partial\n' } },
          ],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_PROCESS_FAILED',
        messagePattern: /without emitting a result event/,
      },
      {
        name: 'exit 0 with unparseable stdout and no result event',
        spec: {
          exitCode: 0,
          stdoutRaw: ['{not-valid-json'],
        },
        expectedStatus: 'failed',
        expectedCode: 'STREAM_PARSE_ERROR',
        messagePattern: /without emitting a result event/,
      },
      {
        name: 'exit 1 despite SUCCESS status',
        spec: {
          exitCode: 1,
          stdoutLines: [
            { event: 'result', result: { status: 'SUCCESS', response: 'ok' } },
          ],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_PROCESS_FAILED',
        messagePattern: /exited with code 1/,
      },
      {
        name: 'non-SUCCESS ERROR status with exit 0',
        spec: {
          exitCode: 0,
          stdoutLines: [{ event: 'result', result: { status: 'ERROR', error: 'Upstream failure' } }],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_PROCESS_FAILED',
        messagePattern: /Upstream failure/,
      },
      {
        name: 'non-SUCCESS INVALID status with exit 0',
        spec: {
          exitCode: 0,
          stdoutLines: [{ event: 'result', result: { status: 'INVALID' } }],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_PROCESS_FAILED',
        messagePattern: /INVALID/,
      },
      {
        name: 'non-SUCCESS WAITING status with exit 0',
        spec: {
          exitCode: 0,
          stdoutLines: [{ event: 'result', result: { status: 'WAITING' } }],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_PROCESS_FAILED',
        messagePattern: /WAITING/,
      },
      {
        name: 'non-SUCCESS RUNNING status with exit 0',
        spec: {
          exitCode: 0,
          stdoutLines: [{ event: 'result', result: { status: 'RUNNING' } }],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_PROCESS_FAILED',
        messagePattern: /RUNNING/,
      },
      {
        name: 'non-SUCCESS CANCELED status with exit 0 (no host cancel)',
        spec: {
          exitCode: 0,
          stdoutLines: [{ event: 'result', result: { status: 'CANCELED' } }],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_PROCESS_FAILED',
        messagePattern: /CANCELED/,
      },
      {
        name: 'non-SUCCESS INTERRUPTED status with exit 0 (no host cancel)',
        spec: {
          exitCode: 0,
          stdoutLines: [{ event: 'result', result: { status: 'INTERRUPTED' } }],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_PROCESS_FAILED',
        messagePattern: /INTERRUPTED/,
      },
      {
        name: 'non-SUCCESS TIMEOUT status with exit 0 (no host timeout)',
        spec: {
          exitCode: 0,
          stdoutLines: [{ event: 'result', result: { status: 'TIMEOUT' } }],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_PROCESS_FAILED',
        messagePattern: /TIMEOUT/,
      },
      {
        name: 'malformed padded lowercase success status with exit 0',
        spec: {
          exitCode: 0,
          stdoutLines: [{ event: 'result', result: { status: ' success ' } }],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_PROCESS_FAILED',
        messagePattern: /non-SUCCESS status/i,
      },
      {
        name: 'malformed trailing-space SUCCESS status with exit 0',
        spec: {
          exitCode: 0,
          stdoutLines: [{ event: 'result', result: { status: 'SUCCESS ' } }],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_PROCESS_FAILED',
        messagePattern: /non-SUCCESS status/i,
      },
      {
        name: 'malformed lowercase success status with exit 0',
        spec: {
          exitCode: 0,
          stdoutLines: [{ event: 'result', result: { status: 'success' } }],
        },
        expectedStatus: 'failed',
        expectedCode: 'AGY_PROCESS_FAILED',
        messagePattern: /non-SUCCESS status/i,
      },
    ];

    for (const c of failureCases) {
      const queued = await tasks.run({ workingDirectory: env.repoDir, prompt: encodeScenarioPrompt(c.spec) });
      const settled = await settleTask(tasks, queued.taskId);
      assert.equal(settled.status, c.expectedStatus, `Expected ${c.name} status=${c.expectedStatus}, got ${settled.status}`);
      assert.equal(settled.error?.code, c.expectedCode, `Expected ${c.name} code=${c.expectedCode}, got ${settled.error?.code}`);
      assert.match(settled.error?.message ?? '', c.messagePattern, `Expected ${c.name} message match`);
    }

    // Benign stderr diagnostic does not trigger false positive failure.
    const benignTask = await tasks.run({
      workingDirectory: env.repoDir,
      prompt: encodeScenarioPrompt({
        exitCode: 0,
        stderrLines: ['mock diagnostic', 'ExperimentalWarning: benign notice'],
        stdoutLines: [{ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }],
      }),
    });
    const settledBenign = await settleTask(tasks, benignTask.taskId);
    assert.equal(settledBenign.status, 'completed');

    // All pre-tool hook / execution-policy denials stay failed even on exit 0 + SUCCESS and real guarded finish.
    const hookAdapter = new AgyExecutionAdapter(cli, config);
    const hookPrompt = encodeScenarioPrompt({
      exitCode: 0,
      stdoutLines: [
        { event: 'init', conversation_id: 'c-hook' },
        {
          event: 'step_update',
          step_update: {
            step_index: 0,
            step_type: 'tool',
            state: 'ERROR',
            tool_name: 'edit_file',
            tool_info: { error: { type: 'HookDenied', message: 'Denied by pre-tool hook: outside allowlist' } },
          },
        },
        { event: 'result', result: { status: 'SUCCESS', conversation_id: 'c-hook', response: 'recovered cleanly' } },
      ],
    });
    const hookDeniedRes = await hookAdapter.execute(
      makeRequest({ taskId: 'hook-deny', workingDirectory: env.repoDir, prompt: hookPrompt }),
    );
    assert.equal(hookDeniedRes.status, 'failed');
    if (hookDeniedRes.status === 'failed') {
      assert.equal(hookDeniedRes.error.code, 'AGY_PROCESS_FAILED');
      assert.match(hookDeniedRes.error.message, /Denied by pre-tool hook/i);
    }

    const policyStderrRes = await hookAdapter.execute(
      makeRequest({
        taskId: 'hook-stderr-policy-deny',
        workingDirectory: env.repoDir,
        prompt: encodeScenarioPrompt({
          exitCode: 0,
          stderrLines: ['Denied by execution policy'],
          stdoutLines: [{ event: 'result', result: { status: 'SUCCESS', conversation_id: 'c-hook-stderr', response: 'ok' } }],
        }),
      }),
    );
    assert.equal(policyStderrRes.status, 'failed');
    if (policyStderrRes.status === 'failed') {
      assert.equal(policyStderrRes.error.code, 'AGY_PROCESS_FAILED');
    }

    const policyStateDir = path.join(env.root, 'policy-state');
    mkdirSync(policyStateDir, { recursive: true });
    const policyConfig = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'off',
      BRIDGE_STATE_DIRECTORY: policyStateDir,
      AGY_PATH: process.execPath,
      BRIDGE_ALLOWED_AGY_TOOLS: JSON.stringify(['finish', 'view_file', 'write_to_file']),
    });
    const policyCli = new CliAdapter(policyConfig, [env.scenarioScript]);
    await policyCli.discover();
    const policyTasks = new TaskManager(policyCli, policyConfig, new AgyExecutionAdapter(policyCli, policyConfig));
    try {
      const guardAllowedTask = await policyTasks.run({
        workingDirectory: env.repoDir,
        allowedTools: ['finish', 'view_file'],
        prompt: encodeScenarioPrompt({
          exitCode: 0,
          hookCalls: [
            { name: 'view_file', copyRelativePathArg: { key: 'AbsolutePath', relativePath: 'app.txt' }, conversationId: 'c-guard-ok' },
            { name: 'finish', conversationId: 'c-guard-ok' },
          ],
          stdoutLines: [
            { event: 'init', conversation_id: 'c-guard-ok' },
            { event: 'result', result: { status: 'SUCCESS', conversation_id: 'c-guard-ok', response: 'guarded ok', structured_output: { summary: 'guarded ok' } } },
          ],
        }),
      });
      const settledGuardAllowed = await settleTask(policyTasks, guardAllowedTask.taskId);
      assert.equal(settledGuardAllowed.status, 'completed', JSON.stringify(settledGuardAllowed.error));
      assert.equal(settledGuardAllowed.agentPolicyReceipt?.decisionCount, 2);
      assert.equal(settledGuardAllowed.agentPolicyReceipt?.deniedCount, 0);

      const unverifiedGuardTask = await policyTasks.run({
        workingDirectory: env.repoDir,
        allowedTools: ['finish', 'view_file'],
        prompt: encodeScenarioPrompt({
          exitCode: 0,
          hookCalls: [
            { name: 'view_file', copyRelativePathArg: { key: 'AbsolutePath', relativePath: 'app.txt' }, conversationId: 'c-guard-missing' },
          ],
          stdoutLines: [
            { event: 'init', conversation_id: 'c-guard-missing' },
            { event: 'result', result: { status: 'SUCCESS', conversation_id: 'c-guard-missing', response: 'missing finish', structured_output: { summary: 'missing finish' } } },
          ],
        }),
      });
      const settledUnverifiedGuard = await settleTask(policyTasks, unverifiedGuardTask.taskId);
      assert.equal(settledUnverifiedGuard.status, 'failed');
      assert.equal(settledUnverifiedGuard.error?.code, 'AGENT_POLICY_UNVERIFIED');

      const guardDeniedThenFinishedTask = await policyTasks.run({
        workingDirectory: env.repoDir,
        allowedTools: ['finish', 'view_file'],
        prompt: encodeScenarioPrompt({
          exitCode: 0,
          hookCalls: [
            { name: 'write_to_file', copyRelativePathArg: { key: 'TargetFile', relativePath: 'app.txt' }, conversationId: 'c-guard-deny' },
            { name: 'finish', conversationId: 'c-guard-deny' },
          ],
          stdoutLines: [
            { event: 'init', conversation_id: 'c-guard-deny' },
            { event: 'result', result: { status: 'SUCCESS', conversation_id: 'c-guard-deny', response: 'claimed recovery', structured_output: { summary: 'claimed recovery' } } },
          ],
        }),
      });
      const settledGuardDenied = await settleTask(policyTasks, guardDeniedThenFinishedTask.taskId);
      assert.equal(settledGuardDenied.status, 'failed');
      assert.equal(settledGuardDenied.error?.code, 'AGY_PROCESS_FAILED');
      assert.match(settledGuardDenied.error?.message ?? '', /Denied by pre-tool hook/i);

      const guardStderrDeniedTask = await policyTasks.run({
        workingDirectory: env.repoDir,
        allowedTools: ['finish', 'view_file'],
        prompt: encodeScenarioPrompt({
          exitCode: 0,
          hookCalls: [
            { name: 'write_to_file', copyRelativePathArg: { key: 'TargetFile', relativePath: 'app.txt' }, conversationId: 'c-guard-stderr-deny', emitStderrDenial: true },
            { name: 'finish', conversationId: 'c-guard-stderr-deny' },
          ],
          stdoutLines: [
            { event: 'init', conversation_id: 'c-guard-stderr-deny' },
            { event: 'result', result: { status: 'SUCCESS', conversation_id: 'c-guard-stderr-deny', response: 'claimed recovery', structured_output: { summary: 'claimed recovery' } } },
          ],
        }),
      });
      const settledGuardStderrDenied = await settleTask(policyTasks, guardStderrDeniedTask.taskId);
      assert.equal(settledGuardStderrDenied.status, 'failed');
      assert.equal(settledGuardStderrDenied.error?.code, 'AGY_PROCESS_FAILED');
      assert.match(settledGuardStderrDenied.error?.message ?? '', /Denied by pre-tool hook/i);

      const guardSilentDeniedTask = await policyTasks.run({
        workingDirectory: env.repoDir,
        allowedTools: ['finish', 'view_file'],
        prompt: encodeScenarioPrompt({
          exitCode: 0,
          hookCalls: [
            { name: 'write_to_file', copyRelativePathArg: { key: 'TargetFile', relativePath: 'app.txt' }, conversationId: 'c-guard-silent-deny', emitDenialStep: false },
            { name: 'finish', conversationId: 'c-guard-silent-deny' },
          ],
          stdoutLines: [
            { event: 'init', conversation_id: 'c-guard-silent-deny' },
            { event: 'result', result: { status: 'SUCCESS', conversation_id: 'c-guard-silent-deny', response: 'claimed recovery', structured_output: { summary: 'claimed recovery' } } },
          ],
        }),
      });
      const settledGuardSilentDenied = await settleTask(policyTasks, guardSilentDeniedTask.taskId);
      assert.equal(settledGuardSilentDenied.status, 'failed');
      assert.equal(settledGuardSilentDenied.error?.code, 'AGY_PROCESS_FAILED');
      assert.match(settledGuardSilentDenied.error?.message ?? '', /denied 1 tool call/i);
      assert.ok(settledGuardSilentDenied.agentPolicyReceipt);
      assert.ok(settledGuardSilentDenied.agentPolicyReceipt.decisionCount >= 2);
      assert.equal(settledGuardSilentDenied.agentPolicyReceipt.deniedCount, 1);
    } finally {
      await policyTasks.shutdown();
    }

    // Native test paths: missing receipt remains TEST_EXECUTION_UNVERIFIED; passing receipt + stderr denial fails.
    const noReceiptScript = path.join(env.root, 'native-no-receipt-cli.mjs');
    writeFileSync(noReceiptScript, buildScenarioCliScript({
      runNativeTest: false,
      stdoutLines: [{ event: 'result', result: { status: 'SUCCESS', response: 'claimed pass without running test' } }],
    }), 'utf8');
    const noReceiptCli = new CliAdapter(config, [noReceiptScript]);
    await noReceiptCli.discover();
    const noReceiptTasks = new TaskManager(noReceiptCli, config, new AgyExecutionAdapter(noReceiptCli, config));
    try {
      const baseTask = await noReceiptTasks.run({
        workingDirectory: env.repoDir,
        prompt: encodeScenarioPrompt({ stdoutLines: [{ event: 'result', result: { status: 'SUCCESS', conversation_id: 'c-no-receipt-seed', response: 'ready' } }] }),
      });
      const settledBase = await settleTask(noReceiptTasks, baseTask.taskId);
      assert.equal(settledBase.status, 'completed');
      const preview = await noReceiptTasks.preview(settledBase.taskId);
      const missingReceiptTest = await noReceiptTasks.startTests(
        settledBase.taskId,
        preview.sha256,
        { executable: process.execPath, args: ['-e', 'console.log("unused")'] },
        0,
        30,
      );
      const settledMissingReceipt = await waitForTask(noReceiptTasks, missingReceiptTest.taskId);
      assert.equal(settledMissingReceipt.status, 'failed');
      assert.equal(settledMissingReceipt.error?.code, 'TEST_EXECUTION_UNVERIFIED');
    } finally {
      await noReceiptTasks.shutdown();
    }

    const nativeDenyScript = path.join(env.root, 'native-deny-cli.mjs');
    writeFileSync(nativeDenyScript, buildScenarioCliScript({
      runNativeTest: true,
      stderrLines: ['Tool call denied: headless mode cannot request permission'],
      stdoutLines: [
        { event: 'init', conversation_id: 'c-native-deny' },
        { event: 'result', result: { status: 'SUCCESS', conversation_id: 'c-native-deny', response: 'claimed pass' } },
      ],
    }), 'utf8');
    const denyCli = new CliAdapter(config, [nativeDenyScript]);
    await denyCli.discover();
    const denyTasks = new TaskManager(denyCli, config, new AgyExecutionAdapter(denyCli, config));
    try {
      const seed = await denyTasks.run({
        workingDirectory: env.repoDir,
        prompt: encodeScenarioPrompt({ stdoutLines: [{ event: 'result', result: { status: 'SUCCESS', conversation_id: 'c-native-deny-seed', response: 'seed' } }] }),
      });
      const settledSeed = await settleTask(denyTasks, seed.taskId);
      assert.equal(settledSeed.status, 'completed');
      const seedPreview = await denyTasks.preview(settledSeed.taskId);
      const deniedNativeTest = await denyTasks.startTests(
        settledSeed.taskId,
        seedPreview.sha256,
        { executable: process.execPath, args: ['-e', 'console.log("ok")'] },
        0,
        30,
      );
      const settledDeniedNative = await waitForTask(denyTasks, deniedNativeTest.taskId);
      assert.equal(settledDeniedNative.status, 'failed');
      assert.equal(settledDeniedNative.error?.code, 'AGY_PROCESS_FAILED');
      assert.match(settledDeniedNative.error?.message ?? '', /tool call denied/i);
      assert.equal(settledDeniedNative.tests?.length, 1);
    } finally {
      await denyTasks.shutdown();
    }
  } finally {
    await tasks?.shutdown();
    env.cleanup();
  }
});

test('ordinary command permission and OS errors complete on SUCCESS while explicit agy denials fail', async () => {
  const env = createWorkspace();
  try {
    const config = loadConfig({ BRIDGE_STATE_DIRECTORY: env.stateDir, AGY_PATH: process.execPath, BRIDGE_ANTI_AI_CRAFT: 'off' });
    const cli = new CliAdapter(config, [env.scenarioScript]);
    await cli.discover();
    const adapter = new AgyExecutionAdapter(cli, config);

    const ordinaryDone = await adapter.execute(makeRequest({
      workingDirectory: env.repoDir,
      prompt: encodeScenarioPrompt({
        stdoutLines: [
          {
            event: 'step_update',
            step_update: {
              step_index: 0,
              step_type: 'tool',
              state: 'DONE',
              tool_name: 'run_command',
              tool_info: { output: 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.' },
            },
          },
          {
            event: 'step_update',
            step_update: {
              step_index: 1,
              step_type: 'tool',
              state: 'DONE',
              tool_name: 'run_command',
              tool_info: { output: 'To get started with GitHub CLI, please run: gh auth login' },
            },
          },
          {
            event: 'step_update',
            step_update: {
              step_index: 2,
              step_type: 'tool',
              state: 'ERROR',
              tool_name: 'run_command',
              tool_info: {
                output: 'Permission denied',
                error: { type: 'CommandFailed', message: "EACCES: permission denied, open '/etc/shadow'" },
              },
            },
          },
          { event: 'result', result: { status: 'SUCCESS', response: 'handled ordinary errors' } },
        ],
      }),
    }));
    assert.equal(ordinaryDone.status, 'completed', JSON.stringify(ordinaryDone));

    const realToolDenial = await adapter.execute(makeRequest({
      workingDirectory: env.repoDir,
      prompt: encodeScenarioPrompt({
        stdoutLines: [
          {
            event: 'step_update',
            step_update: {
              step_index: 0,
              step_type: 'tool',
              state: 'ERROR',
              tool_name: 'run_command',
              tool_info: { error: { type: 'HookDenied', message: 'Denied by pre-tool hook: run_command' } },
            },
          },
          { event: 'result', result: { status: 'SUCCESS', response: 'claimed done' } },
        ],
      }),
    }));
    assert.equal(realToolDenial.status, 'failed');
    if (realToolDenial.status === 'failed') {
      assert.equal(realToolDenial.error.code, 'AGY_PROCESS_FAILED');
      assert.match(realToolDenial.error.message, /pre-tool hook/i);
    }

    const headlessStderrDenial = await adapter.execute(makeRequest({
      workingDirectory: env.repoDir,
      prompt: encodeScenarioPrompt({
        stderrLines: ['Permission denied in headless mode'],
        stdoutLines: [{ event: 'result', result: { status: 'SUCCESS', response: 'claimed done' } }],
      }),
    }));
    assert.equal(headlessStderrDenial.status, 'failed');
    if (headlessStderrDenial.status === 'failed') {
      assert.equal(headlessStderrDenial.error.code, 'AGY_PROCESS_FAILED');
      assert.match(headlessStderrDenial.error.message, /headless mode/i);
    }
  } finally {
    env.cleanup();
  }
});

test('TaskManager treats unsolicited provider cancelled/timeout/interrupted as failed retaining explicit reason', async () => {
  const env = createWorkspace();
  try {
    const config = loadConfig({ BRIDGE_STATE_DIRECTORY: env.stateDir, AGY_PATH: process.execPath, BRIDGE_ANTI_AI_CRAFT: 'off' });
    const cli = new CliAdapter(config, [env.scenarioScript]);

    const runWithPureAdapter = async (adapter: ExecutionAdapter) => {
      const tasks = new TaskManager(cli, config, adapter);
      try {
        const queued = await tasks.run({ workingDirectory: env.repoDir, prompt: 'pure unsolicited termination' });
        return await settleTask(tasks, queued.taskId);
      } finally {
        await tasks.shutdown();
      }
    };

    const interrupted = await runWithPureAdapter(new AgyExecutionFixture({ status: 'INTERRUPTED' }));
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.error?.code, 'AGY_PROCESS_FAILED');
    assert.match(interrupted.error?.message ?? '', /without host termination/i);
    assert.match(interrupted.error?.message ?? '', /Fixture cancelled/i);

    const aborted = await runWithPureAdapter(new OtherProviderExecutionFixture({ outcome: 'aborted' }));
    assert.equal(aborted.status, 'failed');
    assert.equal(aborted.error?.code, 'AGY_PROCESS_FAILED');
    assert.match(aborted.error?.message ?? '', /without host termination/i);
    assert.match(aborted.error?.message ?? '', /Fixture cancelled/i);

    const deadline = await runWithPureAdapter(new OtherProviderExecutionFixture({ outcome: 'deadline' }));
    assert.equal(deadline.status, 'failed');
    assert.equal(deadline.error?.code, 'AGY_PROCESS_FAILED');
    assert.match(deadline.error?.message ?? '', /without host termination/i);
    assert.match(deadline.error?.message ?? '', /Fixture timed out/i);

    const customReasonAdapter: ExecutionAdapter = {
      identity: { id: 'custom-unsolicited', provider: 'custom' },
      capabilities: {
        read: 'supported', write: 'supported', sandbox: 'unknown', network: 'unknown',
        skills: 'unknown', resources: 'unknown', structuredOutput: 'supported',
        cancel: 'unknown', resume: 'supported', observableUsage: 'unknown',
      },
      async execute(request): Promise<ExecutionResult> {
        return {
          taskId: request.taskId,
          status: 'timeout',
          error: { code: 'TASK_TIMEOUT', message: 'upstream quota deadline reached' },
        };
      },
    };
    const custom = await runWithPureAdapter(customReasonAdapter);
    assert.equal(custom.status, 'failed');
    assert.equal(custom.error?.code, 'AGY_PROCESS_FAILED');
    assert.match(custom.error?.message ?? '', /upstream quota deadline reached/i);
  } finally {
    env.cleanup();
  }
});

test('TaskManager bounds hanging pure ExecutionAdapter against cancel and deadline without leaking queue slots', { timeout: 60_000 }, async () => {
  const env = createWorkspace();
  let tasks: TaskManager | undefined;
  try {
    const config = loadConfig({
      BRIDGE_STATE_DIRECTORY: env.stateDir,
      AGY_PATH: process.execPath,
      MAX_CONCURRENT_TASKS: '1',
      BRIDGE_ANTI_AI_CRAFT: 'off',
    });
    const cli = new CliAdapter(config, [env.scenarioScript]);
    const lateRejections: Array<(err: Error) => void> = [];
    const lateResolves: Array<(result: ExecutionResult) => void> = [];
    let signalCancelStarted!: () => void;
    const cancelStarted = new Promise<void>(resolve => { signalCancelStarted = resolve; });
    const adapter: ExecutionAdapter = {
      identity: { id: 'hanging-pure', provider: 'synthetic' },
      capabilities: {
        read: 'supported', write: 'supported', sandbox: 'unknown', network: 'unknown',
        skills: 'unknown', resources: 'unknown', structuredOutput: 'supported',
        cancel: 'unknown', resume: 'unknown', observableUsage: 'unknown',
      },
      execute(request): Promise<ExecutionResult> {
        if (request.prompt.startsWith('complete-immediately')) {
          return Promise.resolve({ taskId: request.taskId, status: 'completed', response: 'slot available' });
        }
        if (request.prompt.startsWith('hang-cancel')) {
          return new Promise<ExecutionResult>((_resolve, reject) => {
            lateRejections.push(reject);
            signalCancelStarted();
          });
        }
        return new Promise<ExecutionResult>(resolve => {
          lateResolves.push(resolve);
        });
      },
    };

    tasks = new TaskManager(cli, config, adapter);
    const hungCancel = await tasks.run({ workingDirectory: env.repoDir, prompt: 'hang-cancel' });
    const queuedAfterCancel = await tasks.run({ workingDirectory: env.repoDir, prompt: 'complete-immediately-1' });
    await cancelStarted;
    assert.equal(tasks.status(hungCancel.taskId).status, 'running');

    await tasks.cancel(hungCancel.taskId);
    const settledCancel = await settleTask(tasks, hungCancel.taskId);
    assert.equal(settledCancel.status, 'cancelled');
    assert.equal(settledCancel.error?.code, 'TASK_CANCELLED');

    const settledAfterCancel = await settleTask(tasks, queuedAfterCancel.taskId);
    assert.equal(settledAfterCancel.status, 'completed', JSON.stringify(settledAfterCancel.error));

    const hungTimeout = await tasks.run({ workingDirectory: env.repoDir, prompt: 'hang-timeout', timeoutSeconds: 1 });
    const queuedAfterTimeout = await tasks.run({ workingDirectory: env.repoDir, prompt: 'complete-immediately-2' });
    const settledTimeout = await settleTask(tasks, hungTimeout.taskId);
    assert.equal(settledTimeout.status, 'timeout');
    assert.equal(settledTimeout.error?.code, 'TASK_TIMEOUT');

    const settledAfterTimeout = await settleTask(tasks, queuedAfterTimeout.taskId);
    assert.equal(settledAfterTimeout.status, 'completed', JSON.stringify(settledAfterTimeout.error));

    // Late settlement after host cancellation/timeout must not overwrite terminal status or crash the process.
    for (const rejectLate of lateRejections) rejectLate(new Error('late provider failure'));
    for (const resolveLate of lateResolves) resolveLate({ taskId: hungTimeout.taskId, status: 'completed', response: 'late' });
    await delay(25);
    assert.equal(tasks.status(hungCancel.taskId).status, 'cancelled');
    assert.equal(tasks.status(hungTimeout.taskId).status, 'timeout');
  } finally {
    await tasks?.shutdown();
    env.cleanup();
  }
});

test('AgyExecutionAdapter fails uninspected line-limit loss while permitting safe post-inspection retention truncation', { timeout: 60_000 }, async () => {
  const env = createWorkspace();
  try {
    const config = loadConfig({ BRIDGE_STATE_DIRECTORY: env.stateDir, AGY_PATH: process.execPath, BRIDGE_ANTI_AI_CRAFT: 'off' });
    const overflowScript = path.join(env.root, 'overflow-cli.mjs');
    writeFileSync(overflowScript, `
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('agy-overflow 1.0.0\\n'); process.exit(0); }
if (args.includes('--help')) { process.stdout.write('models --output-format stream-json --sandbox --mode accept-edits plan --model --effort --conversation --json-schema --add-dir --new-project\\n'); process.exit(0); }
if (args.includes('models')) { process.stdout.write('mock-pro\\tMock Pro\\n'); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
if (input.includes('MODE:payload-nodes')) {
  process.stdout.write(JSON.stringify({ event: 'step_update', step_update: {
    step_type: 'tool', state: 'DONE', tool_name: 'run_command',
    padding: [...Array(100_010).fill(0), { denied_actions: ['blocked action'] }],
  } }) + '\\n');
} else if (input.includes('MODE:payload-depth')) {
  let nested = { denied_actions: ['blocked action'] };
  for (let i = 0; i < 70; i++) nested = { nested };
  process.stdout.write(JSON.stringify({ event: 'step_update', step_update: {
    step_type: 'tool', state: 'DONE', tool_name: 'run_command', nested,
  } }) + '\\n');
} else if (input.includes('MODE:long-command-denial') || input.includes('MODE:receipt-command-denial')) {
  const prefix = input.includes('MODE:receipt-command-denial') ? 'BLACK_GRAVITY_TEST:fixture\\n' : '';
  process.stdout.write(JSON.stringify({ event: 'step_update', step_update: {
    step_type: 'tool', state: 'DONE', tool_name: 'run_command',
    tool_info: { output: prefix + 'harmless '.repeat(500) + '\\nDenied by pre-tool hook: run_command' },
  } }) + '\\n');
} else if (input.includes('MODE:repeated-prefixes')) {
  process.stderr.write('headless mcp agy permission '.repeat(40_000));
} else if (input.includes('MODE:plain-stdout-denial')) {
  process.stdout.write('Tool execution denied by pre-tool hook: run_command\\n');
} else if (input.includes('MODE:stdout-overflow')) {
  process.stdout.write('x'.repeat(2_050_000) + '\\n');
} else if (input.includes('MODE:stderr-overflow')) {
  process.stderr.write('y'.repeat(2_050_000) + '\\n');
  process.stderr.write('tail after suppression\\n');
} else if (input.includes('MODE:retained-truncation-ok')) {
  const padLine = 'harmless diagnostic '.padEnd(160, '.') + '\\n';
  for (let i = 0; i < 120; i++) process.stderr.write(padLine);
  process.stderr.write('h'.repeat(5000) + '\\n');
  process.stdout.write(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 0, step_type: 'agent_response', state: 'DELTA', text_delta: 'r'.repeat(10_000) },
  }) + '\\n');
} else if (input.includes('MODE:evicted-denial')) {
  process.stderr.write('Tool execution denied by pre-tool hook: run_command\\n');
  const padLine = 'harmless tail '.padEnd(160, '.') + '\\n';
  for (let i = 0; i < 120; i++) process.stderr.write(padLine);
}
process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }) + '\\n');
process.exitCode = 0;
`, 'utf8');
    const cli = new CliAdapter(config, [overflowScript]);
    await cli.discover();
    const adapter = new AgyExecutionAdapter(cli, config);

    const runMode = async (mode: string) => {
      const events: Array<{ type: string; data: unknown }> = [];
      const result = await adapter.execute(makeRequest({ workingDirectory: env.repoDir, prompt: mode }), {
        onEvent(type, data) { events.push({ type, data }); },
      });
      return { result, events };
    };

    const stdoutLoss = await runMode('MODE:stdout-overflow');
    assert.equal(stdoutLoss.result.status, 'failed');
    if (stdoutLoss.result.status === 'failed') {
      assert.equal(stdoutLoss.result.error.code, 'AGY_PROCESS_FAILED');
      assert.match(stdoutLoss.result.error.message, /output truncated without denial inspection.*stdout/i);
    }
    assert.ok(stdoutLoss.events.some(e => e.type === 'process.output_rejected'));

    const stderrLoss = await runMode('MODE:stderr-overflow');
    assert.equal(stderrLoss.result.status, 'failed');
    if (stderrLoss.result.status === 'failed') {
      assert.equal(stderrLoss.result.error.code, 'AGY_PROCESS_FAILED');
      assert.match(stderrLoss.result.error.message, /output truncated without denial inspection.*stderr/i);
    }
    assert.ok(stderrLoss.events.some(e => e.type === 'process.output_rejected'));

    for (const mode of ['MODE:payload-nodes', 'MODE:payload-depth']) {
      const loss = await runMode(mode);
      assert.equal(loss.result.status, 'failed', mode);
      if (loss.result.status === 'failed') {
        assert.equal(loss.result.error.code, 'AGY_PROCESS_FAILED');
        assert.match(loss.result.error.message, /output truncated without denial inspection.*stdout/i);
      }
      assert.ok(loss.events.some(e => e.type === 'stream.truncated'), mode);
    }
    for (const mode of ['MODE:long-command-denial', 'MODE:receipt-command-denial', 'MODE:plain-stdout-denial']) {
      const denied = await runMode(mode);
      assert.equal(denied.result.status, 'failed', mode);
      if (denied.result.status === 'failed') {
        assert.equal(denied.result.error.code, 'AGY_PROCESS_FAILED');
        assert.match(denied.result.error.message, /pre-tool hook/i);
      }
    }
    const started = performance.now();
    const repeated = await runMode('MODE:repeated-prefixes');
    assert.equal(repeated.result.status, 'completed', JSON.stringify(repeated.result));
    assert.ok(performance.now() - started < 15_000, '1 MB repeated prefixes must not stall denial inspection');

    const retainedOk = await runMode('MODE:retained-truncation-ok');
    assert.equal(retainedOk.result.status, 'completed', JSON.stringify(retainedOk.result));
    assert.equal(retainedOk.events.some(e => e.type === 'process.output_rejected'), false);
    assert.ok(retainedOk.events.some(e => e.type === 'response.truncated'));

    const evictedDenial = await runMode('MODE:evicted-denial');
    assert.equal(evictedDenial.result.status, 'failed');
    if (evictedDenial.result.status === 'failed') {
      assert.equal(evictedDenial.result.error.code, 'AGY_PROCESS_FAILED');
      assert.match(evictedDenial.result.error.message, /Tool execution denied by pre-tool hook/i);
    }
  } finally {
    env.cleanup();
  }
});

test('AgyExecutionAdapter terminates and reconciles real child without leaking when onProcessStarted throws', async () => {
  const env = createWorkspace();
  try {
    const config = loadConfig({ BRIDGE_STATE_DIRECTORY: env.stateDir, AGY_PATH: process.execPath, BRIDGE_ANTI_AI_CRAFT: 'off' });
    const cli = new CliAdapter(config, [env.scenarioScript]);
    await cli.discover();
    const adapter = new AgyExecutionAdapter(cli, config);

    let startedPid: number | undefined;
    const result = await adapter.execute(
      makeRequest({
        workingDirectory: env.repoDir,
        prompt: encodeScenarioPrompt({ holdUntilSigterm: true }),
      }),
      {
        onProcessStarted(pid) {
          startedPid = pid;
          throw new Error('persist process start failed');
        },
      },
    );

    assert.equal(result.status, 'failed');
    if (result.status === 'failed') {
      assert.equal(result.error.code, 'AGY_PROCESS_FAILED');
      assert.match(result.error.message, /persist process start failed/);
    }
    assert.equal(typeof startedPid, 'number');
    assert.ok(startedPid! > 0);
    assert.equal(result.spawnedPid, startedPid);
    assert.equal(result.processCleanup?.verified, true);
    assert.equal(result.processCleanup?.remaining, 0);
    assert.throws(() => process.kill(startedPid!, 0), { code: 'ESRCH' });
  } finally {
    env.cleanup();
  }
});

test('ControlledCliAdapter skips real agy probe with nonexistent AGY_PATH while real CliAdapter still fails AGY_NOT_FOUND', async () => {
  const env = createWorkspace();
  const missingConfig = loadConfig({
    BRIDGE_STATE_DIRECTORY: env.stateDir,
    AGY_PATH: path.join(env.root, 'nonexistent-agy-binary'),
    BRIDGE_ANTI_AI_CRAFT: 'off',
  });

  class SimulatedProbeGuardAdapter extends ControlledCliAdapter {
    override spawnTask(
      _options: RunOptions,
      _model: string | undefined,
      _cwd: string,
    ): ChildProcessWithoutNullStreams {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        pid: undefined,
        exitCode: null as number | null,
        killed: false,
        kill: (_signal?: string) => {
          child.exitCode = 0;
          child.killed = true;
          child.emit('close', 0);
          return true;
        },
      });
      setImmediate(() => {
        child.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'sim-conv-1' }) + '\n');
        child.stdout.write(
          JSON.stringify({
            event: 'result',
            result: {
              status: 'SUCCESS',
              conversation_id: 'sim-conv-1',
              response: 'simulated without real agy probe',
            },
          }) + '\n',
        );
        child.exitCode = 0;
        child.emit('close', 0);
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }
  }

  let probeCalls = 0;
  const proto = CliAdapter.prototype as unknown as { probe: (...args: unknown[]) => Promise<unknown> };
  const originalProbe = proto.probe;
  proto.probe = async () => {
    probeCalls += 1;
    throw new Error('real CliAdapter.probe must not execute for ControlledCliAdapter');
  };

  const simulatedCli = new SimulatedProbeGuardAdapter(missingConfig);
  const simulatedAdapter = new AgyExecutionAdapter(simulatedCli, missingConfig);
  const tasks = new TaskManager(simulatedCli, missingConfig);
  let copyDir: string | undefined;
  try {
    assert.equal(simulatedCli.getDiscovery(), undefined);
    assert.equal(simulatedAdapter.capabilities.write, 'unknown');

    const executed = await simulatedAdapter.execute(makeRequest({
      taskId: 'sim-no-probe-exec',
      workingDirectory: env.repoDir,
    }));
    assert.equal(executed.status, 'completed');
    if (executed.status === 'completed') {
      assert.equal(executed.response, 'simulated without real agy probe');
    }
    assert.deepEqual(simulatedCli.getDiscovery(), fixtureDiscovery());
    assert.equal(simulatedAdapter.capabilities.write, 'supported');
    assert.equal(probeCalls, 0);

    const started = await tasks.run({
      prompt: 'Simulated task manager run without agy binary',
      workingDirectory: env.repoDir,
      mode: 'read-only',
    });
    const settled = await settleTask(tasks, started.taskId);
    copyDir = settled.copyDirectory;
    assert.equal(settled.status, 'completed', JSON.stringify(settled.error));
    assert.equal(
      (settled.result as { status?: string; response?: unknown } | undefined)?.response,
      'simulated without real agy probe',
    );
    assert.equal(probeCalls, 0);

    const health = await simulatedCli.health();
    assert.equal(health.installed, true);
    assert.equal(health.path, 'mock-agy');
    assert.equal(health.authenticated, false);
    assert.equal(probeCalls, 0);
  } finally {
    proto.probe = originalProbe;
    await tasks.shutdown();
    if (copyDir) {
      rmSync(copyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  try {
    const realCli = new CliAdapter(missingConfig);
    const realAdapter = new AgyExecutionAdapter(realCli, missingConfig);
    const realResult = await realAdapter.execute(makeRequest({
      taskId: 'real-missing-agy',
      workingDirectory: env.repoDir,
    }));
    assert.equal(realResult.status, 'failed');
    if (realResult.status === 'failed') {
      assert.equal(realResult.error.code, 'AGY_NOT_FOUND');
    }
    assert.equal(realAdapter.capabilities.write, 'unsupported');
  } finally {
    env.cleanup();
  }
});
