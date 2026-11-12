import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StateStore, type StoredTask } from '../src/state-store.js';
import { appendMessage, readMessages, resultReference } from '../src/messages.js';
import { validateStructuredResult } from '../src/structured-results.js';
import { waitCommandInfo, waitCommandArgv } from '../src/wait-command.js';
import {
  isCapabilitySupported, assertExecutionCapabilities, type ExecutionAdapter,
  type ExecutionRequest, type ExecutionResult, type ExecutionCapabilities,
} from '../src/execution-contract.js';
import { AgyExecutionFixture } from './agy-fixture.js';
import { OtherProviderExecutionFixture } from './other-fixture.js';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };

function request(directory: string): ExecutionRequest {
  return { taskId: randomUUID(), prompt: 'Exercise the execution contract', workingDirectory: directory,
    role: 'implementer', model: 'fixture-model', effort: 'high', mode: 'read-only' };
}

// Fixture consumer only: production dispatch, redaction and lifecycle remain in TaskManager.
function storeResult(input: ExecutionRequest, result: ExecutionResult, directory: string) {
  assert.equal(result.taskId, input.taskId);
  const record: StoredTask['record'] = {
    taskId: input.taskId, prompt: input.prompt, workingDirectory: input.workingDirectory,
    status: result.status === 'needs-host' ? 'running' : result.status,
    createdAt: new Date().toISOString(), model: input.model ?? undefined,
    mode: input.mode, role: input.role, effort: input.effort, sessionId: result.session?.id,
    deliveryMode: 'messages', result: result.raw,
  };
  if (result.status === 'needs-host') {
    appendMessage(record, result.message.kind, 'bridge', result.message.text);
  } else if (result.status === 'completed') {
    if (input.outputSchema !== undefined) record.structuredResult = validateStructuredResult(input.outputSchema, result.structuredOutput);
    record.completedAt = new Date().toISOString();
    appendMessage(record, 'final', 'bridge', result.response || 'Fixture completed', resultReference(record));
  } else if (result.status === 'failed' || result.status === 'cancelled' || result.status === 'timeout') {
    record.completedAt = new Date().toISOString();
    record.error = result.error;
    appendMessage(record, 'error', 'bridge', result.error.message);
  }
  const stored: StoredTask = { ownerPid: process.pid, events: [], cursor: 0, record,
    options: { prompt: input.prompt, workingDirectory: input.workingDirectory } };
  const state = new StateStore(directory);
  state.save(stored);
  const loaded = new StateStore(directory).load().find(item => item.record.taskId === input.taskId);
  assert.ok(loaded, 'The existing durable state schema must accept the contract projection');
  return loaded;
}

function wait(directory: string, taskId: string, after = 0) {
  const prefix = waitCommandArgv(directory, entry);
  assert.ok(prefix);
  const command = waitCommandInfo(prefix, taskId);
  const run = spawnSync(command.argv[0]!, [...command.argv.slice(1), '--after', String(after), '--timeout', '2'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000,
    env: { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory,
      BRIDGE_STATE_DIRECTORY: directory, BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: path.join(directory, 'cache') },
  });
  assert.ifError(run.error);
  assert.equal(run.signal, null);
  assert.equal(run.stderr, '');
  const lines = run.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  const output = JSON.parse(lines[0]!);
  assert.equal(output.exitCode, run.status);
  return output;
}

test('capabilities require explicit own supported values; absent, unknown and unsupported deny', () => {
  const capabilities: ExecutionCapabilities = { read: 'supported', sandbox: 'unknown', network: 'unsupported' };
  assert.equal(isCapabilitySupported(capabilities, 'read'), true);
  for (const key of ['sandbox', 'network', 'write', 'structuredOutput', 'cancel', 'resume'] as const) {
    assert.equal(isCapabilitySupported(capabilities, key), false);
  }
  assert.equal(isCapabilitySupported(Object.create({ read: 'supported' }) as ExecutionCapabilities, 'read'), false);
  const input = request(os.tmpdir());
  assert.doesNotThrow(() => assertExecutionCapabilities(input, capabilities));
  assert.throws(() => assertExecutionCapabilities({ ...input, mode: 'write' }, capabilities), /write/);
  assert.throws(() => assertExecutionCapabilities({ ...input, session: { id: 'existing' } }, capabilities), /resume/);
});

test('both fixtures reject unproven structured output support at execution', async () => {
  const input = { ...request(os.tmpdir()), outputSchema: schema };
  for (const support of ['unknown', 'unsupported', undefined] as const) {
    const capabilities: ExecutionCapabilities = { read: 'supported', structuredOutput: support };
    const fixtures: ExecutionAdapter[] = [
      new AgyExecutionFixture({ status: 'SUCCESS' }, capabilities),
      new OtherProviderExecutionFixture({ outcome: 'done' }, capabilities),
    ];
    for (const fixture of fixtures) await assert.rejects(fixture.execute(input), /structuredOutput/);
  }
});

test('native statuses are translated by each fixture and unknown statuses never succeed', async () => {
  const input = request(os.tmpdir());
  for (const fixture of [
    new AgyExecutionFixture({ status: 'UNRECOGNIZED' }),
    new OtherProviderExecutionFixture({ outcome: 'UNRECOGNIZED' }),
  ]) await assert.rejects(fixture.execute(input), /Unknown/);
  assert.equal((await new AgyExecutionFixture({ status: 'INVALID' }).execute(input)).status, 'failed');
  assert.equal((await new AgyExecutionFixture({ status: 'INTERRUPTED' }).execute(input)).status, 'cancelled');
  for (const fixture of [
    new AgyExecutionFixture({ status: 'RUNNING' }),
    new OtherProviderExecutionFixture({ outcome: 'active' }),
  ]) assert.equal((await fixture.execute(input)).status, 'running');
  await assert.rejects(new AgyExecutionFixture({ status: 'WAITING' }).execute(input), /host message/);
  await assert.rejects(new OtherProviderExecutionFixture({ outcome: 'input_required' }).execute(input), /host message/);
});

const cases = [
  { agy: 'SUCCESS', other: 'done', outcome: 'completed', code: 0, kind: 'final' },
  { agy: 'ERROR', other: 'fault', outcome: 'failed', code: 2, kind: 'error' },
  { agy: 'CANCELED', other: 'aborted', outcome: 'cancelled', code: 3, kind: 'error' },
  { agy: 'HARNESS_TIMEOUT', other: 'deadline', outcome: 'timeout', code: 4, kind: 'error' },
  { agy: 'WAITING', other: 'input_required', outcome: 'question', code: 5, kind: 'question' },
  { agy: 'WAITING', other: 'input_required', outcome: 'blocker', code: 6, kind: 'blocker' },
] as const;

// A provider-specific wait branch, missing persistence/message, or changed exit code must fail this matrix.
for (const scenario of cases) {
  test('both fixture providers persist and exit the real waitCommand: ' + scenario.outcome, async t => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'bg-contract-'));
    t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const hostMessage = scenario.kind === 'question' || scenario.kind === 'blocker'
      ? { kind: scenario.kind, text: 'Fixture needs host input' } : undefined;
    const fixtures: ExecutionAdapter[] = [
      new AgyExecutionFixture({ status: scenario.agy, response: 'Finished', conversation_id: 'fixture-session',
        structured_output: { ok: true }, hostMessage }),
      new OtherProviderExecutionFixture({ outcome: scenario.other, text: 'Finished', session: 'fixture-session',
        payload: { ok: true }, hostMessage }),
    ];
    const observations = [];
    for (const fixture of fixtures) {
      const input = { ...request(directory), outputSchema: schema };
      const result = await fixture.execute(input);
      const stored = storeResult(input, result, directory);
      const messages = readMessages(stored.record).messages;
      assert.equal(messages.length, 1);
      assert.equal(messages[0]!.kind, scenario.kind);
      assert.equal(messages[0]!.source, 'bridge');
      assert.equal(stored.record.sessionId, 'fixture-session');
      if (scenario.outcome === 'completed') {
        assert.deepEqual(stored.record.structuredResult?.value, { ok: true });
        assert.equal(stored.record.structuredResult?.sha256, createHash('sha256').update('{"ok":true}').digest('hex'));
        assert.equal(messages[0]!.reference?.tool, 'black_gravity_read_result');
      }
      const output = wait(directory, input.taskId);
      assert.equal(output.exitCode, scenario.code);
      assert.equal(output.outcome, scenario.outcome);
      assert.equal(output.status, hostMessage ? 'running' : scenario.outcome);
      assert.equal(output.cursor, 1);
      assert.equal(output.reason, scenario.outcome === 'failed' ? 'AGY_PROCESS_FAILED' : null);
      const expectedError = scenario.outcome === 'failed' ? { code: 'AGY_PROCESS_FAILED', message: 'Fixture failed' }
        : scenario.outcome === 'cancelled' ? { code: 'TASK_CANCELLED', message: 'Fixture cancelled' }
        : scenario.outcome === 'timeout' ? { code: 'TASK_TIMEOUT', message: 'Fixture timed out' } : undefined;
      assert.deepEqual(stored.record.error, expectedError);
      assert.equal(messages[0]!.text, hostMessage ? 'Fixture needs host input' : expectedError?.message ?? 'Finished');
      const { taskId: storedId, createdAt, completedAt, result: raw, messages: publicMessages, ...durable } = stored.record;
      assert.equal(storedId, input.taskId);
      assert.ok(createdAt);
      assert.equal(typeof completedAt, hostMessage ? 'undefined' : 'string');
      assert.deepEqual(raw, JSON.parse(JSON.stringify(result.raw)));
      const normalizedMessages = publicMessages!.map(({ messageId, taskId, timestamp, reference, ...message }) => {
        assert.ok(messageId);
        assert.equal(taskId, input.taskId);
        assert.ok(timestamp);
        if (reference) assert.deepEqual(reference, resultReference(stored.record));
        return { ...message, referenceTool: reference?.tool };
      });
      observations.push({ outcome: output.outcome, code: output.exitCode, durable, messages: normalizedMessages });
      if (hostMessage) {
        const consumed = wait(directory, input.taskId, 1);
        assert.equal(consumed.exitCode, 8);
        assert.equal(consumed.outcome, 'wait-deadline');
      }
    }
    assert.deepEqual(observations[0], observations[1]);
  });
}

test('both fixtures use existing schema validation rather than trusting native structured output', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bg-contract-json-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const payload of [undefined, { ok: 'wrong-type' }]) {
    const fixtures: ExecutionAdapter[] = [
      new AgyExecutionFixture({ status: 'SUCCESS', structured_output: payload }),
      new OtherProviderExecutionFixture({ outcome: 'done', payload }),
    ];
    for (const fixture of fixtures) {
      const input = { ...request(directory), outputSchema: schema };
      const result = await fixture.execute(input);
      assert.throws(() => storeResult(input, result, directory), { code: 'INVALID_STRUCTURED_RESULT' });
      assert.equal(new StateStore(directory).load().length, 0);
    }
  }
});
