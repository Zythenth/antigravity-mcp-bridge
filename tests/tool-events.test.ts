import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, appendFile, link, copyFile, rename, truncate } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CliAdapter } from '../src/cli-adapter.js';
import { DEFAULT_PROJECT_LIMITS, loadConfig, type Config } from '../src/config.js';
import { TaskManager } from '../src/task-manager.js';
import { StateStore } from '../src/state-store.js';
import { discardProjectCopy } from '../src/isolation.js';
import { resolveAgentPolicy } from '../src/agent-policy.js';
import {
  stageExecutionPolicy,
  readExecutionPolicyReceipt,
  readReceiptEditsSync,
  discardExecutionPolicy,
} from '../src/execution-policy.js';
import type { BridgeEvent, RunOptions, TaskRecord } from '../src/types.js';

const INITIAL_SOURCE = [
  'alpha distinctive-le-one',
  'beta distinctive-le-two',
  'function wsDemo() {',
  '  return "distinctive-ws-token";',
  '}',
  'const café = "distinctive-uni-ação";'.normalize('NFC'),
  '',
].join('\n');

const NOT_FOUND_MESSAGE = 'target content not found in the file; the Target must exactly match existing file text, including whitespace';

function hook(cwd: string, conversationId: string, name: string, args: unknown) {
  const child = spawnSync(process.execPath, ['bridge-execution-hook.mjs'], {
    cwd: path.join(cwd, '.agents'),
    input: JSON.stringify({ workspacePaths: [cwd], conversationId, toolCall: { name, args } }),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout).decision as string;
}

async function runHook(
  agentsDir: string,
  input: unknown
): Promise<{ decision: string; reason?: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bridge-execution-hook.mjs'], {
      cwd: agentsDir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.once('error', reject);
    child.once('close', exitCode => {
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({ decision: parsed.decision, reason: parsed.reason, exitCode });
      } catch {
        reject(new Error(`Failed to parse hook stdout: "${stdout}" (stderr: "${stderr}", exitCode: ${exitCode})`));
      }
    });
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

class GuardedAdapter extends CliAdapter {
  script?: (ctx: { options: RunOptions; cwd: string; session: string; write: (frame: unknown) => void }) => Promise<void> | void;
  override spawnTask(options: RunOptions, _model: string | undefined, cwd: string): ChildProcessWithoutNullStreams {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams, stdout = new PassThrough(), stderr = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout,
      stderr,
      pid: undefined,
      exitCode: null,
      killed: false,
      kill: () => { Object.assign(child, { exitCode: 1, killed: true }); child.emit('close', 1); return true; },
    });
    setImmediate(() => void (async () => {
      const session = options.sessionId ?? randomUUID();
      const write = (frame: unknown) => { stdout.write(JSON.stringify(frame) + '\n'); };
      write({ event: 'init', conversation_id: session, init: { model: 'test-model' } });
      if (this.script) {
        await this.script({ options, cwd, session, write });
      }
      if (options.agentPolicy) assert.equal(hook(cwd, session, 'finish', {}), 'allow');
      write({ event: 'result', result: { status: 'SUCCESS', structured_output: { marker: 'guarded' } } });
      stdout.end();
      Object.assign(child, { exitCode: 0 });
      child.emit('close', 0);
    })().catch(error => {
      stderr.write(String(error));
      Object.assign(child, { exitCode: 1 });
      child.emit('close', 1);
    }));
    return child;
  }
}

async function fixture(
  body: (f: { root: string; source: string; config: Config; adapter: GuardedAdapter; tasks: TaskManager; managers: TaskManager[] }) => Promise<void>
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-tool-events-')), source = path.join(root, 'source');
  await mkdir(source);
  execFileSync('git', ['init', '--quiet'], { cwd: source });
  await writeFile(path.join(source, 'source.txt'), INITIAL_SOURCE, 'utf8');
  const config = loadConfig({
    BRIDGE_ANTI_AI_CRAFT: 'off',
    BRIDGE_STATE_DIRECTORY: path.join(root, 'state'),
    BRIDGE_TEST_EXECUTOR: 'agy',
  });
  const adapter = new GuardedAdapter(config), tasks = new TaskManager(adapter, config), managers = [tasks];
  try {
    await body({ root, source, config, adapter, tasks, managers });
  } finally {
    for (const manager of managers) await manager.shutdown();
    for (const project of new Map(new StateStore(config.stateDirectory).load().flatMap(item => item.project ? [[item.project.copyDirectory, item.project] as const] : [])).values()) {
      await discardProjectCopy(project);
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('agy-tool-events-'));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function end(tasks: TaskManager, task: TaskRecord) {
  await tasks.wait(task.taskId);
  return tasks.status(task.taskId);
}

function emitToolError(
  write: (frame: unknown) => void,
  session: string,
  stepIndex: number,
  toolName: string,
  parameters: Record<string, unknown>,
  error?: Record<string, unknown>
) {
  for (const state of ['ACTIVE', 'ERROR'] as const) {
    write({
      event: 'step_update',
      step_update: {
        conversation_id: session,
        step_index: stepIndex,
        state,
        step_type: 'tool',
        tool_name: toolName,
        tool_info: { name: toolName, parameters, ...(state === 'ERROR' && error ? { error } : {}) },
      },
    });
  }
}

async function readAllStateFiles(dir: string): Promise<Array<{ file: string; content: string }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: Array<{ file: string; content: string }> = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await readAllStateFiles(full));
    } else if (entry.isFile()) {
      results.push({ file: full, content: await readFile(full, 'utf8') });
    }
  }
  return results;
}

test('ERROR tool step produces tool.failed with failure summary and preserves tool event counts', async () => {
  await fixture(async ({ source, tasks, adapter }) => {
    adapter.script = ({ cwd, session, write }) => {
      const targetFile = path.join(cwd, 'source.txt');
      assert.equal(hook(cwd, session, 'read_file', { Path: targetFile }), 'allow');
      write({
        event: 'step_update',
        step_update: {
          conversation_id: session,
          step_index: 1,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'read_file',
          tool_info: { name: 'read_file', parameters: { Path: targetFile } },
        },
      });
      write({
        event: 'step_update',
        step_update: {
          conversation_id: session,
          step_index: 1,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'read_file',
          duration_seconds: 0.02,
          tool_info: { name: 'read_file', parameters: { Path: targetFile } },
        },
      });

      assert.equal(hook(cwd, session, 'edit_file', { Path: targetFile, Target: 'absent-text', Replacement: 'new-text' }), 'allow');
      write({
        event: 'step_update',
        step_update: {
          conversation_id: session,
          step_index: 2,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'edit_file',
          tool_info: { name: 'edit_file', parameters: { Path: targetFile } },
        },
      });
      write({
        event: 'step_update',
        step_update: {
          conversation_id: session,
          step_index: 2,
          state: 'ERROR',
          step_type: 'tool',
          tool_name: 'edit_file',
          duration_seconds: 0.13,
          tool_info: {
            name: 'edit_file',
            parameters: { Path: targetFile },
            error: { type: 'TOOL_ERROR', message: NOT_FOUND_MESSAGE },
          },
        },
      });

      assert.equal(hook(cwd, session, 'read_file', { Path: targetFile }), 'allow');
      emitToolError(write, session, 3, 'read_file', { Path: targetFile }, {
        type: 'T'.repeat(65),
        message: 'm'.repeat(550),
      });

      assert.equal(hook(cwd, session, 'read_file', { Path: targetFile }), 'allow');
      emitToolError(write, session, 4, 'read_file', { Path: targetFile });
    };

    const task = await end(tasks, await tasks.run({
      prompt: 'Test tool.failed.',
      workingDirectory: source,
      allowedTools: ['view_file', 'replace_file_content'],
      mcpServers: [],
    }));
    assert.equal(task.status, 'completed', JSON.stringify(task.error));

    const events = tasks.events.read(task.taskId).events;
    const started = events.filter(e => e.type === 'tool.started');
    const completed = events.filter(e => e.type === 'tool.completed');
    const failed = events.filter(e => e.type === 'tool.failed');

    assert.equal(started.length, 4);
    assert.equal(completed.length, 1);
    assert.equal(failed.length, 3);
    assert.equal(started.length, completed.length + failed.length);

    const failedData = failed[0]!.data as Record<string, unknown>;
    assert.deepEqual(failedData.failure, {
      type: 'TOOL_ERROR',
      message: NOT_FOUND_MESSAGE,
    });
    assert.deepEqual((failed[1]!.data as Record<string, unknown>).failure, {
      message: 'm'.repeat(500),
    });
    assert.deepEqual((failed[2]!.data as Record<string, unknown>).failure, {
      message: 'Tool reported an error without details',
    });
    const rawStep = (failed[0]!.raw as { step_update: Record<string, unknown> }).step_update;
    assert.equal(rawStep.failure, undefined);
    assert.equal(rawStep.editSearch, undefined);
  });
});

test('compact snapshot omits duplicated raw frames and replays identical events on reload', async () => {
  await fixture(async ({ source, tasks, adapter, config, managers }) => {
    adapter.script = ({ cwd, session, write }) => {
      const targetFile = path.join(cwd, 'source.txt');
      for (let i = 1; i <= 3; i++) {
        assert.equal(hook(cwd, session, 'read_file', { Path: targetFile }), 'allow');
        write({
          event: 'step_update',
          step_update: {
            conversation_id: session,
            step_index: i,
            state: 'ACTIVE',
            step_type: 'tool',
            tool_name: 'read_file',
            tool_info: { name: 'read_file', parameters: { Path: targetFile, payload: 'x'.repeat(200) } },
          },
        });
        write({
          event: 'step_update',
          step_update: {
            conversation_id: session,
            step_index: i,
            state: 'DONE',
            step_type: 'tool',
            tool_name: 'read_file',
            tool_info: { name: 'read_file', parameters: { Path: targetFile, payload: 'x'.repeat(200) } },
          },
        });
      }
      write({
        event: 'step_update',
        step_update: {
          conversation_id: session,
          step_index: 4,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: 'Completed inspection.\n',
        },
      });
      write({ event: 'heartbeat', seq: 1, detail: 'y'.repeat(120) });
    };

    const task = await end(tasks, await tasks.run({
      prompt: 'Compact snapshot test.',
      workingDirectory: source,
      allowedTools: ['view_file', 'replace_file_content'],
      mcpServers: [],
    }));
    assert.equal(task.status, 'completed', JSON.stringify(task.error));

    const beforeEvents = tasks.events.read(task.taskId).events;
    const snapshotPath = path.join(config.stateDirectory, `${task.taskId}.json`);
    const persistedText = await readFile(snapshotPath, 'utf8');
    const persistedJson = JSON.parse(persistedText) as { events: Array<Record<string, unknown>> };

    assert.ok(persistedJson.events.some(e => e.rawEnvelope === 'step_update' && !('raw' in e)));
    assert.ok(persistedJson.events.some(e => e.rawEnvelope === 'result' && !('raw' in e)));
    assert.ok(persistedJson.events.some(e => e.rawIsData === true && !('raw' in e)));

    const uncompactedText = JSON.stringify({ ...persistedJson, events: beforeEvents });
    assert.ok(
      Buffer.byteLength(persistedText, 'utf8') < Buffer.byteLength(uncompactedText, 'utf8'),
      `Expected compact snapshot (${Buffer.byteLength(persistedText, 'utf8')}) to be smaller than full-raw snapshot (${Buffer.byteLength(uncompactedText, 'utf8')})`
    );

    await tasks.shutdown();
    const loadedFromStore = new StateStore(config.stateDirectory).load().find(t => t.record.taskId === task.taskId)!;
    assert.equal(JSON.stringify(loadedFromStore.events), JSON.stringify(beforeEvents));

    for (const ev of loadedFromStore.events) {
      if (ev.raw !== undefined) {
        assert.deepEqual(Object.keys(ev), ['taskId', 'sequence', 'timestamp', 'type', 'data', 'raw']);
        assert.notEqual(ev.data, ev.raw);
        const envName = (ev.raw as { event?: string }).event;
        if (envName && typeof (ev.raw as Record<string, unknown>)[envName] === 'object') {
          assert.notEqual(ev.data, (ev.raw as Record<string, unknown>)[envName]);
        }
      }
    }

    const nextManager = new TaskManager(new GuardedAdapter(config), config);
    managers.push(nextManager);
    assert.equal(JSON.stringify(nextManager.events.read(task.taskId).events), JSON.stringify(beforeEvents));
  });
});

test('old snapshots with full raw (with and without redacted) load unchanged and stay byte-identical on disk', async () => {
  await fixture(async ({ root, source, tasks, adapter, config, managers }) => {
    adapter.script = ({ cwd, session, write }) => {
      const targetFile = path.join(cwd, 'source.txt');
      assert.equal(hook(cwd, session, 'read_file', { Path: targetFile }), 'allow');
      write({
        event: 'step_update',
        step_update: {
          conversation_id: session,
          step_index: 1,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'read_file',
          tool_info: { name: 'read_file', parameters: { Path: targetFile } },
        },
      });
      write({
        event: 'step_update',
        step_update: {
          conversation_id: session,
          step_index: 1,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'read_file',
          tool_info: { name: 'read_file', parameters: { Path: targetFile } },
        },
      });
    };

    const templateTask = await end(tasks, await tasks.run({
      prompt: 'Template snapshot.',
      workingDirectory: source,
      allowedTools: ['view_file', 'replace_file_content'],
      mcpServers: [],
    }));
    const templateEvents = tasks.events.read(templateTask.taskId).events;
    await tasks.shutdown();

    const baseSnapshot = JSON.parse(await readFile(path.join(config.stateDirectory, `${templateTask.taskId}.json`), 'utf8')) as Record<string, unknown>;
    delete baseSnapshot.project;

    const makeEvents = (id: string): BridgeEvent[] => templateEvents.map(ev => ({ ...structuredClone(ev), taskId: id }));

    const redactedId = randomUUID();
    const redactedEvents = makeEvents(redactedId);
    const redactedPath = path.join(config.stateDirectory, `${redactedId}.json`);
    const redactedPayload = {
      ...structuredClone(baseSnapshot),
      record: { ...(baseSnapshot.record as Record<string, unknown>), taskId: redactedId, copyDirectory: undefined, messages: undefined, messageCursor: undefined },
      events: redactedEvents,
      redacted: true,
    };
    await writeFile(redactedPath, JSON.stringify(redactedPayload), 'utf8');
    const redactedBeforeBytes = await readFile(redactedPath);

    const legacyId = randomUUID();
    const legacyEvents = makeEvents(legacyId);
    const legacyPath = path.join(config.stateDirectory, `${legacyId}.json`);
    const legacyPayload = {
      ...structuredClone(baseSnapshot),
      record: { ...(baseSnapshot.record as Record<string, unknown>), taskId: legacyId, copyDirectory: undefined, messages: undefined, messageCursor: undefined },
      events: legacyEvents,
    };
    delete (legacyPayload as { redacted?: unknown }).redacted;
    await writeFile(legacyPath, JSON.stringify(legacyPayload), 'utf8');
    const legacyBeforeBytes = await readFile(legacyPath);

    const store = new StateStore(config.stateDirectory);
    const loaded = store.load();
    assert.equal(JSON.stringify(loaded.find(t => t.record.taskId === redactedId)!.events), JSON.stringify(redactedEvents));
    assert.equal(JSON.stringify(loaded.find(t => t.record.taskId === legacyId)!.events), JSON.stringify(legacyEvents));

    const nextManager = new TaskManager(new GuardedAdapter(config), config);
    managers.push(nextManager);
    assert.equal(JSON.stringify(nextManager.events.read(redactedId).events), JSON.stringify(redactedEvents));
    assert.equal(JSON.stringify(nextManager.events.read(legacyId).events), JSON.stringify(legacyEvents));

    assert.equal(Buffer.compare(await readFile(redactedPath), redactedBeforeBytes), 0);
    assert.equal(Buffer.compare(await readFile(legacyPath), legacyBeforeBytes), 0);

    const badStateDir = path.join(root, 'bad-state');
    const badStore = new StateStore(badStateDir);
    const badFile = path.join(badStateDir, `${redactedId}.json`);
    for (const badEvent of [
      { ...redactedEvents[0]!, raw: { ok: true }, rawIsData: true },
      { ...redactedEvents[0]!, raw: undefined, rawEnvelope: 'event' },
    ]) {
      await writeFile(badFile, JSON.stringify({ ...redactedPayload, events: [badEvent] }), 'utf8');
      assert.throws(() => badStore.load(), { name: 'BridgeError', code: 'INVALID_STATE' });
    }
  });
});

test('editSearch classifies line-endings, whitespace and unicode mismatches without storing searched text', async () => {
  await fixture(async ({ source, tasks, adapter, config }) => {
    const cases = [
      {
        mismatch: 'line-endings',
        target: 'alpha distinctive-le-one\r\nbeta distinctive-le-two\r\n',
      },
      {
        mismatch: 'whitespace',
        target: 'function wsDemo() {\n\treturn "distinctive-ws-token";\n}',
      },
      {
        mismatch: 'unicode',
        target: 'const café = "distinctive-uni-ação";'.normalize('NFD'),
      },
    ] as const;

    adapter.script = ({ cwd, session, write }) => {
      const targetFile = path.join(cwd, 'source.txt');
      cases.forEach((entry, idx) => {
        const stepIndex = idx + 1;
        assert.equal(
          hook(cwd, session, 'edit_file', {
            Path: targetFile,
            Target: entry.target,
            Replacement: '/* distinctive-replacement-never-stored */',
          }),
          'allow'
        );
        write({
          event: 'step_update',
          step_update: {
            conversation_id: session,
            step_index: stepIndex,
            state: 'ACTIVE',
            step_type: 'tool',
            tool_name: 'edit_file',
            tool_info: { name: 'edit_file', parameters: { Path: targetFile } },
          },
        });
        write({
          event: 'step_update',
          step_update: {
            conversation_id: session,
            step_index: stepIndex,
            state: 'ERROR',
            step_type: 'tool',
            tool_name: 'edit_file',
            duration_seconds: 0.05,
            tool_info: {
              name: 'edit_file',
              parameters: { Path: targetFile },
              error: { type: 'TOOL_ERROR', message: NOT_FOUND_MESSAGE },
            },
          },
        });
      });
    };

    const task = await end(tasks, await tasks.run({
      prompt: 'Edit mismatch telemetry test.',
      workingDirectory: source,
      allowedTools: ['view_file', 'replace_file_content'],
      mcpServers: [],
    }));
    assert.equal(task.status, 'completed', JSON.stringify(task.error));

    const allEvents = tasks.events.read(task.taskId).events;
    const failedEvents = allEvents.filter(e => e.type === 'tool.failed');
    assert.equal(failedEvents.length, 3);

    cases.forEach((entry, idx) => {
      const data = failedEvents[idx]!.data as {
        editSearch?: { mismatch: string; target?: { sha256: string; bytes: number; lines: number } };
      };
      assert.deepEqual(data.editSearch, {
        mismatch: entry.mismatch,
        target: {
          sha256: createHash('sha256').update(entry.target, 'utf8').digest('hex'),
          bytes: Buffer.byteLength(entry.target, 'utf8'),
          lines: entry.target.split(/\r\n|\r|\n/).length,
        },
      });
    });

    const stateFiles = await readAllStateFiles(config.stateDirectory);
    assert.ok(stateFiles.some(f => f.file.endsWith(`${task.taskId}.json`)));
    assert.ok(stateFiles.some(f => f.file.includes('execution-receipts')));

    const eventsJson = JSON.stringify(allEvents);
    for (const entry of cases) {
      const escaped = JSON.stringify(entry.target).slice(1, -1);
      for (const { file, content } of stateFiles) {
        assert.equal(content.includes(entry.target), false, `Raw target leaked in ${file}`);
        assert.equal(content.includes(escaped), false, `JSON-escaped target leaked in ${file}`);
        assert.equal(content.includes('distinctive-replacement-never-stored'), false, `Replacement leaked in ${file}`);
      }
      assert.equal(eventsJson.includes(entry.target), false, 'Raw target leaked in events');
      assert.equal(eventsJson.includes(escaped), false, 'JSON-escaped target leaked in events');
    }

    const wsTarget = cases[1].target;
    const exactTarget = 'alpha distinctive-le-one\nbeta distinctive-le-two\n';
    const targetStats = (t: string) => ({
      sha256: createHash('sha256').update(t, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(t, 'utf8'),
      lines: t.split(/\r\n|\r|\n/).length,
    });

    adapter.script = ({ cwd, session, write }) => {
      const targetFile = path.join(cwd, 'source.txt');
      assert.equal(
        hook(cwd, session, 'edit_file', { Path: targetFile, Target: wsTarget, Replacement: 'x' }),
        'allow'
      );
      assert.equal(
        hook(cwd, session, 'edit_file', { Path: targetFile, Target: exactTarget, Replacement: 'x', extraKey: true }),
        'deny'
      );
      emitToolError(write, session, 2, 'edit_file', { Path: targetFile }, {
        type: 'TOOL_ERROR',
        message: 'tool call denied by pre-tool hook: denied',
      });
      emitToolError(write, session, 1, 'edit_file', { Path: targetFile }, {
        type: 'TOOL_ERROR',
        message: NOT_FOUND_MESSAGE,
      });

      assert.equal(
        hook(cwd, session, 'edit_file', { Path: targetFile, Target: exactTarget, Replacement: 'x' }),
        'allow'
      );
      emitToolError(write, session, 3, 'edit_file', { Path: targetFile }, {
        type: 'TOOL_ERROR',
        message: NOT_FOUND_MESSAGE,
      });
    };

    const flowTask = await end(tasks, await tasks.run({
      prompt: 'Parallel and exact-match editSearch test.',
      workingDirectory: source,
      allowedTools: ['view_file', 'replace_file_content'],
      mcpServers: [],
    }));
    assert.equal(flowTask.status, 'completed', JSON.stringify(flowTask.error));
    const flowFailed = tasks.events.read(flowTask.taskId).events.filter(e => e.type === 'tool.failed');
    assert.equal(flowFailed.length, 3);
    assert.equal('editSearch' in (flowFailed[0]!.data as Record<string, unknown>), false);
    assert.deepEqual((flowFailed[1]!.data as Record<string, unknown>).editSearch, {
      mismatch: 'whitespace',
      target: targetStats(wsTarget),
    });
    assert.deepEqual((flowFailed[2]!.data as Record<string, unknown>).editSearch, {
      mismatch: 'unknown',
      target: targetStats(exactTarget),
    });

    adapter.script = ({ cwd, session, write }) => {
      emitToolError(write, session, 1, 'edit_file', { Path: path.join(cwd, 'source.txt') }, {
        type: 'TOOL_ERROR',
        message: NOT_FOUND_MESSAGE,
      });
    };
    const noPolicyTask = await end(tasks, await tasks.run({
      prompt: 'No-policy editSearch test.',
      workingDirectory: source,
    }));
    assert.equal(noPolicyTask.status, 'completed', JSON.stringify(noPolicyTask.error));
    const noPolicyFailed = tasks.events.read(noPolicyTask.taskId).events.filter(e => e.type === 'tool.failed');
    assert.equal(noPolicyFailed.length, 1);
    assert.deepEqual((noPolicyFailed[0]!.data as Record<string, unknown>).editSearch, {
      mismatch: 'unknown',
    });
  });
});

test('hook records mismatch none on exact match, omits edit on deny and reader rejects unexpected edit keys', async () => {
  const copyDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-copy-'));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'state-sibling-'));
  try {
    const executionId = randomUUID();
    const policy = resolveAgentPolicy(
      { allowedTools: ['finish', 'view_file', 'replace_file_content'], mcpServers: [] },
      ['finish', 'view_file', 'replace_file_content'],
      [],
      'write',
      executionId
    );
    const staged = await stageExecutionPolicy(
      copyDir,
      { policy, catalog: [], stateDirectory: stateDir, executionId },
      DEFAULT_PROJECT_LIMITS
    );
    const agentsDir = path.join(copyDir, '.agents');
    const filePath = path.join(copyDir, 'exact.txt');
    await writeFile(filePath, 'exact match line\nsecond line\n', 'utf8');

    const allowed = await runHook(agentsDir, {
      conversationId: 'conv-hook-direct',
      toolCall: {
        name: 'edit_file',
        args: { Path: filePath, Target: 'exact match line', Replacement: 'updated line' },
      },
    });
    assert.equal(allowed.decision, 'allow');

    const denied = await runHook(agentsDir, {
      conversationId: 'conv-hook-direct',
      toolCall: {
        name: 'edit_file',
        args: { Path: path.join(stateDir, 'outside.txt'), Target: 'exact match line', Replacement: 'no' },
      },
    });
    assert.equal(denied.decision, 'deny');

    const lines = (await readFile(staged.receiptPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].decision, 'allow');
    assert.deepEqual(lines[0].edit, {
      pathSha256: createHash('sha256').update(filePath, 'utf8').digest('hex'),
      targetSha256: createHash('sha256').update('exact match line', 'utf8').digest('hex'),
      targetBytes: Buffer.byteLength('exact match line', 'utf8'),
      targetLines: 1,
      mismatch: 'none',
    });
    assert.equal(lines[1].decision, 'deny');
    assert.equal('edit' in lines[1], false);

    const syncRead = readReceiptEditsSync(staged, 0, 'conv-hook-direct');
    assert.equal(syncRead.edits.length, 1);
    assert.equal(syncRead.edits[0]!.mismatch, 'none');

    const linkPath = path.join(path.dirname(staged.receiptPath), 'receipt-hardlink.jsonl');
    await link(staged.receiptPath, linkPath);
    try {
      assert.throws(
        () => readReceiptEditsSync(staged, 0, 'conv-hook-direct'),
        { name: 'BridgeError', code: 'INVALID_RECEIPT' }
      );
    } finally {
      await rm(linkPath, { force: true });
    }

    const otherAllowed = await runHook(agentsDir, {
      conversationId: 'conv-hook-other',
      toolCall: {
        name: 'edit_file',
        args: { Path: filePath, Target: 'exact match line\r\n', Replacement: 'updated line' },
      },
    });
    assert.equal(otherAllowed.decision, 'allow');

    const directFiltered = readReceiptEditsSync(staged, 0, 'conv-hook-direct');
    assert.equal(directFiltered.edits.length, 1);
    assert.equal(directFiltered.edits[0]!.mismatch, 'none');
    const otherFiltered = readReceiptEditsSync(staged, 0, 'conv-hook-other');
    assert.equal(otherFiltered.edits.length, 1);
    assert.equal(otherFiltered.edits[0]!.mismatch, 'line-endings');

    const badLine = JSON.stringify({
      ...lines[0],
      edit: { ...lines[0].edit, unexpectedKey: 'forbidden' },
    }) + '\n';
    await appendFile(staged.receiptPath, badLine.slice(0, 24), 'utf8');

    const partialRead = readReceiptEditsSync(staged, syncRead.nextOffset, 'conv-hook-other');
    assert.equal(partialRead.edits.length, 1);
    assert.equal(partialRead.edits[0]!.mismatch, 'line-endings');
    assert.equal(partialRead.nextOffset, otherFiltered.nextOffset);

    for (const badOffset of [1, otherFiltered.nextOffset + 1]) {
      assert.throws(
        () => readReceiptEditsSync(staged, badOffset, 'conv-hook-direct'),
        { name: 'BridgeError', code: 'INVALID_RECEIPT', message: /not at a line boundary/ }
      );
    }

    await appendFile(staged.receiptPath, badLine.slice(24), 'utf8');

    await assert.rejects(
      () => readExecutionPolicyReceipt(staged, stateDir, 0, 'conv-hook-direct'),
      { name: 'BridgeError', code: 'INVALID_RECEIPT' }
    );
    assert.throws(
      () => readReceiptEditsSync(staged, otherFiltered.nextOffset, 'conv-hook-direct'),
      { name: 'BridgeError', code: 'INVALID_RECEIPT' }
    );

    await truncate(staged.receiptPath, otherFiltered.nextOffset);
    const replacementPath = path.join(path.dirname(staged.receiptPath), 'receipt-replaced.jsonl');
    await copyFile(staged.receiptPath, replacementPath);
    await rm(staged.receiptPath);
    await rename(replacementPath, staged.receiptPath);
    assert.throws(
      () => readReceiptEditsSync(staged, 0, 'conv-hook-direct'),
      { name: 'BridgeError', code: 'INVALID_RECEIPT' }
    );
  } finally {
    await rm(copyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('overlapping edit_file calls finishing in reverse order report unknown editSearch without target', async () => {
  await fixture(async ({ source, tasks, adapter }) => {
    const wsTarget = 'function wsDemo() {\n\treturn "distinctive-ws-token";\n}';
    const uniTarget = 'const café = "distinctive-uni-ação";'.normalize('NFD');

    adapter.script = ({ cwd, session, write }) => {
      const targetFile = path.join(cwd, 'source.txt');
      assert.equal(
        hook(cwd, session, 'edit_file', { Path: targetFile, Target: wsTarget, Replacement: 'x' }),
        'allow'
      );
      assert.equal(
        hook(cwd, session, 'edit_file', { Path: targetFile, Target: uniTarget, Replacement: 'y' }),
        'allow'
      );
      for (const stepIndex of [1, 2]) {
        write({
          event: 'step_update',
          step_update: {
            conversation_id: session,
            step_index: stepIndex,
            state: 'ACTIVE',
            step_type: 'tool',
            tool_name: 'edit_file',
            tool_info: { name: 'edit_file', parameters: { Path: targetFile } },
          },
        });
      }
      for (const stepIndex of [2, 1]) {
        write({
          event: 'step_update',
          step_update: {
            conversation_id: session,
            step_index: stepIndex,
            state: 'ERROR',
            step_type: 'tool',
            tool_name: 'edit_file',
            duration_seconds: 0.04,
            tool_info: {
              name: 'edit_file',
              parameters: { Path: targetFile },
              error: { type: 'TOOL_ERROR', message: NOT_FOUND_MESSAGE },
            },
          },
        });
      }
    };

    const task = await end(tasks, await tasks.run({
      prompt: 'Overlapping reverse edit_file test.',
      workingDirectory: source,
      allowedTools: ['view_file', 'replace_file_content'],
      mcpServers: [],
    }));
    assert.equal(task.status, 'completed', JSON.stringify(task.error));

    const failed = tasks.events.read(task.taskId).events.filter(e => e.type === 'tool.failed');
    assert.equal(failed.length, 2);
    assert.deepEqual((failed[0]!.data as Record<string, unknown>).editSearch, { mismatch: 'unknown' });
    assert.deepEqual((failed[1]!.data as Record<string, unknown>).editSearch, { mismatch: 'unknown' });
  });
});

test('interleaved edit_file calls on an ambiguous path keep reporting unknown editSearch without target', async () => {
  await fixture(async ({ source, tasks, adapter }) => {
    const leTarget = 'alpha distinctive-le-one\r\nbeta distinctive-le-two\r\n';
    const wsTarget = 'function wsDemo() {\n\treturn "distinctive-ws-token";\n}';
    const uniTarget = 'const café = "distinctive-uni-ação";'.normalize('NFD');

    adapter.script = ({ cwd, session, write }) => {
      const targetFile = path.join(cwd, 'source.txt');
      assert.equal(
        hook(cwd, session, 'edit_file', { Path: targetFile, Target: leTarget, Replacement: 'a' }),
        'allow'
      );
      assert.equal(
        hook(cwd, session, 'edit_file', { Path: targetFile, Target: wsTarget, Replacement: 'b' }),
        'allow'
      );
      for (const stepIndex of [1, 2]) {
        write({
          event: 'step_update',
          step_update: {
            conversation_id: session,
            step_index: stepIndex,
            state: 'ACTIVE',
            step_type: 'tool',
            tool_name: 'edit_file',
            tool_info: { name: 'edit_file', parameters: { Path: targetFile } },
          },
        });
      }
      write({
        event: 'step_update',
        step_update: {
          conversation_id: session,
          step_index: 2,
          state: 'ERROR',
          step_type: 'tool',
          tool_name: 'edit_file',
          duration_seconds: 0.04,
          tool_info: {
            name: 'edit_file',
            parameters: { Path: targetFile },
            error: { type: 'TOOL_ERROR', message: NOT_FOUND_MESSAGE },
          },
        },
      });
      assert.equal(
        hook(cwd, session, 'edit_file', { Path: targetFile, Target: uniTarget, Replacement: 'c' }),
        'allow'
      );
      emitToolError(write, session, 3, 'edit_file', { Path: targetFile }, {
        type: 'TOOL_ERROR',
        message: NOT_FOUND_MESSAGE,
      });
      write({
        event: 'step_update',
        step_update: {
          conversation_id: session,
          step_index: 1,
          state: 'ERROR',
          step_type: 'tool',
          tool_name: 'edit_file',
          duration_seconds: 0.04,
          tool_info: {
            name: 'edit_file',
            parameters: { Path: targetFile },
            error: { type: 'TOOL_ERROR', message: NOT_FOUND_MESSAGE },
          },
        },
      });
    };

    const task = await end(tasks, await tasks.run({
      prompt: 'Interleaved edit_file ambiguity test.',
      workingDirectory: source,
      allowedTools: ['view_file', 'replace_file_content'],
      mcpServers: [],
    }));
    assert.equal(task.status, 'completed', JSON.stringify(task.error));

    const failed = tasks.events.read(task.taskId).events.filter(e => e.type === 'tool.failed');
    assert.equal(failed.length, 3);
    for (const event of failed) {
      assert.deepEqual((event.data as Record<string, unknown>).editSearch, { mismatch: 'unknown' });
    }
  });
});

test('large edit_file ERROR step with 17000-character message keeps failure and editSearch in compact tool.failed data', async () => {
  await fixture(async ({ source, tasks, adapter }) => {
    const wsTarget = 'function wsDemo() {\n\treturn "distinctive-ws-token";\n}';
    const message = NOT_FOUND_MESSAGE.padEnd(17000, 'x');
    assert.equal(message.length, 17000);

    adapter.script = ({ cwd, session, write }) => {
      const targetFile = path.join(cwd, 'source.txt');
      assert.equal(
        hook(cwd, session, 'edit_file', { Path: targetFile, Target: wsTarget, Replacement: 'x' }),
        'allow'
      );
      emitToolError(write, session, 1, 'edit_file', { Path: targetFile }, {
        type: 'TOOL_ERROR',
        message,
      });
    };

    const task = await end(tasks, await tasks.run({
      prompt: 'Large edit_file failure test.',
      workingDirectory: source,
      allowedTools: ['view_file', 'replace_file_content'],
      mcpServers: [],
    }));
    assert.equal(task.status, 'completed', JSON.stringify(task.error));

    const failed = tasks.events.read(task.taskId).events.filter(e => e.type === 'tool.failed');
    assert.equal(failed.length, 1);
    const data = failed[0]!.data as Record<string, unknown>;
    const failure = data.failure as { type?: string; message: string };
    assert.equal(failure.type, 'TOOL_ERROR');
    assert.equal(failure.message.length, 500);
    assert.equal(failure.message, message.slice(0, 500));
    assert.deepEqual(data.editSearch, {
      mismatch: 'whitespace',
      target: {
        sha256: createHash('sha256').update(wsTarget, 'utf8').digest('hex'),
        bytes: Buffer.byteLength(wsTarget, 'utf8'),
        lines: wsTarget.split(/\r\n|\r|\n/).length,
      },
    });
    assert.equal(data.truncated, true);
    assert.equal(data.tool_name, 'edit_file');
    assert.equal('tool_info' in data, false);
  });
});

test('hook classifies edit_file above 16 MiB read cap as unknown', async () => {
  const copyDir = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-copy-'));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'state-sibling-'));
  try {
    const executionId = randomUUID();
    const policy = resolveAgentPolicy(
      { allowedTools: ['finish', 'view_file', 'replace_file_content'], mcpServers: [] },
      ['finish', 'view_file', 'replace_file_content'],
      [],
      'write',
      executionId
    );
    const staged = await stageExecutionPolicy(
      copyDir,
      { policy, catalog: [], stateDirectory: stateDir, executionId },
      DEFAULT_PROJECT_LIMITS
    );
    const agentsDir = path.join(copyDir, '.agents');
    const filePath = path.join(copyDir, 'large.txt');
    const target = 'exact target after 16 MiB';
    await writeFile(filePath, 'x'.repeat(16 * 1024 * 1024) + target + '\n', 'utf8');

    const allowed = await runHook(agentsDir, {
      conversationId: 'conv-hook-large',
      toolCall: {
        name: 'edit_file',
        args: { Path: filePath, Target: target, Replacement: 'updated' },
      },
    });
    assert.equal(allowed.decision, 'allow');

    const prefixAllowed = await runHook(agentsDir, {
      conversationId: 'conv-hook-large',
      toolCall: {
        name: 'edit_file',
        args: { Path: filePath, Target: 'xxxx', Replacement: 'updated' },
      },
    });
    assert.equal(prefixAllowed.decision, 'allow');

    const lines = (await readFile(staged.receiptPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].edit.mismatch, 'unknown');
    assert.equal(lines[1].edit.mismatch, 'unknown');

    await discardExecutionPolicy(staged, stateDir);
  } finally {
    await rm(copyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('StateStore save and load round-trip compacts and expands all four raw event forms', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'agy-state-roundtrip-'));
  try {
    const store = new StateStore(stateDir);
    const taskId = randomUUID();
    const workingDirectory = path.join(stateDir, 'work');
    const data1 = { event: 'heartbeat', seq: 1 };
    const data2 = { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file' };
    const data3 = { model: 'test-model' };
    const data4 = { workingDirectory };
    const originalEvents: BridgeEvent[] = [
      {
        taskId,
        sequence: 1,
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'agy.event',
        data: data1,
        raw: structuredClone(data1),
      },
      {
        taskId,
        sequence: 2,
        timestamp: '2026-01-01T00:00:02.000Z',
        type: 'tool.started',
        data: data2,
        raw: { event: 'step_update', step_update: structuredClone(data2) },
      },
      {
        taskId,
        sequence: 3,
        timestamp: '2026-01-01T00:00:03.000Z',
        type: 'agent.started',
        data: data3,
        raw: { event: 'init', init: structuredClone(data3), extra: 1 },
      },
      {
        taskId,
        sequence: 4,
        timestamp: '2026-01-01T00:00:04.000Z',
        type: 'task.queued',
        data: data4,
      },
    ];
    store.save({
      ownerPid: process.pid,
      record: {
        taskId,
        workingDirectory,
        prompt: 'Round-trip test.',
        status: 'completed',
        createdAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:05.000Z',
      },
      options: {
        workingDirectory,
        prompt: 'Round-trip test.',
      },
      events: structuredClone(originalEvents),
      cursor: 4,
    });

    const onDisk = JSON.parse(await readFile(path.join(stateDir, `${taskId}.json`), 'utf8')) as {
      events: Array<Record<string, unknown>>;
    };
    assert.equal(onDisk.events.length, 4);
    assert.equal(onDisk.events[0]!.rawIsData, true);
    assert.equal('raw' in onDisk.events[0]!, false);
    assert.equal('rawEnvelope' in onDisk.events[0]!, false);

    assert.equal(onDisk.events[1]!.rawEnvelope, 'step_update');
    assert.equal('raw' in onDisk.events[1]!, false);
    assert.equal('rawIsData' in onDisk.events[1]!, false);

    assert.deepEqual(onDisk.events[2]!.raw, { event: 'init', init: data3, extra: 1 });
    assert.equal('rawIsData' in onDisk.events[2]!, false);
    assert.equal('rawEnvelope' in onDisk.events[2]!, false);

    assert.equal('raw' in onDisk.events[3]!, false);
    assert.equal('rawIsData' in onDisk.events[3]!, false);
    assert.equal('rawEnvelope' in onDisk.events[3]!, false);

    const loaded = store.load();
    assert.equal(loaded.length, 1);
    assert.equal(JSON.stringify(loaded[0]!.events), JSON.stringify(originalEvents));
  } finally {
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
