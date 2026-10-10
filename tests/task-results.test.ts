import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CliAdapter, type Discovery, type Model } from '../src/cli-adapter.js';
import { loadConfig } from '../src/config.js';
import { createMcpServer } from '../src/mcp-server.js';
import { compactTask } from '../src/messages.js';
import { successOutputSchemas } from '../src/output-schemas.js';
import { StateStore } from '../src/state-store.js';
import { discardProjectCopy } from '../src/isolation.js';
import { TaskManager } from '../src/task-manager.js';
import { BridgeError, type RunOptions } from '../src/types.js';

function createMockProcess(events: unknown[], exitCode = 0, onSpawn?: () => void) {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  child.killed = false;
  child.exitCode = null;
  child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('close', 0); };
  setImmediate(() => {
    try {
      onSpawn?.();
      for (const ev of events) child.stdout.write(JSON.stringify(ev) + '\n');
      child.stdout.end();
      child.exitCode = exitCode;
      child.emit('close', exitCode);
    } catch (err) { child.emit('error', err); }
  });
  return child;
}

class ControlledAdapter extends CliAdapter {
  lastSpawnOptions?: RunOptions;
  nextProcessFactory?: (cwd: string) => any;
  override spawnTask(options: RunOptions, _model: string | undefined, cwd: string) {
    this.lastSpawnOptions = options;
    if (this.nextProcessFactory) {
      const f = this.nextProcessFactory;
      this.nextProcessFactory = undefined;
      return f(cwd);
    }
    return createMockProcess([
      { event: 'init', conversation_id: options.sessionId ?? 'session-default' },
      { event: 'result', result: { status: 'SUCCESS' } },
    ]);
  }
  override async discover(): Promise<Discovery> {
    return {
      installed: true, path: 'mock-agy', authenticated: true,
      capabilities: {
        structuredOutput: true, streaming: true, sandbox: true,
        readOnlyMode: true, models: true, modelSelection: true,
        resume: true, sessionsList: false, cancel: false,
      },
    };
  }
  override async listModels(): Promise<Model[]> {
    return [{ id: 'test-model', name: 'Test' }];
  }
}

describe('Task results and artifacts runtime', () => {
  let tempRoot: string;
  let repoDir: string;
  let stateDir: string;
  let adapter: ControlledAdapter;
  let tasks: TaskManager;

  before(async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agy-results-test-'));
    repoDir = path.join(tempRoot, 'repo');
    stateDir = path.join(tempRoot, 'state');
    await fs.promises.mkdir(repoDir, { recursive: true });
    await fs.promises.mkdir(stateDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir, stdio: 'ignore' });
    await fs.promises.writeFile(path.join(repoDir, 'artifact.txt'), 'hello world');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });

    const config = loadConfig({ BRIDGE_STATE_DIRECTORY: stateDir, BRIDGE_TEST_EXECUTOR: 'agy' });
    adapter = new ControlledAdapter(config);
    tasks = new TaskManager(adapter, config);
  });

  after(async () => {
    await tasks.shutdown();
    for (const project of new Map(new StateStore(stateDir).load().filter(task => task.project).map(task => [task.project!.copyDirectory, task.project!])).values()) await discardProjectCopy(project);
    assert.equal(path.dirname(path.resolve(tempRoot)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tempRoot).startsWith('agy-results-test-'));
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  it('valid schema reaches adapter and actual structured_output is validated before completed', async () => {
    const schema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] };
    adapter.nextProcessFactory = () => createMockProcess([
      { event: 'init', conversation_id: 'session-valid' },
      { event: 'result', result: { status: 'SUCCESS', structured_output: { count: 7 } } },
    ]);
    const task = await tasks.run({ prompt: 'valid schema', workingDirectory: repoDir, outputSchema: schema });
    await tasks.wait(task.taskId);
    assert.equal(tasks.status(task.taskId).status, 'completed');
    assert.deepEqual(adapter.lastSpawnOptions?.outputSchema, schema);
    const res = tasks.readStructuredResult(task.taskId);
    assert.equal(res.text, '{"count":7}');
  });

  it('invalid/missing output fails task and readStructuredResult is rejected', async () => {
    const schema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] };
    adapter.nextProcessFactory = () => createMockProcess([
      { event: 'init', conversation_id: 'session-invalid' },
      { event: 'result', result: { status: 'SUCCESS', structured_output: { count: 'not-a-num' } } },
    ]);
    const task = await tasks.run({ prompt: 'invalid schema output', workingDirectory: repoDir, outputSchema: schema });
    await tasks.wait(task.taskId);
    assert.equal(tasks.status(task.taskId).status, 'failed');
    assert.throws(() => tasks.readStructuredResult(task.taskId), (err: any) => err instanceof BridgeError && err.code === 'TASK_NOT_READY');
  });

  it('actual artifact hash, base64 window, and same-size mutation rejection', async () => {
    adapter.nextProcessFactory = (cwd) => {
      fs.writeFileSync(path.join(cwd, 'artifact.txt'), 'hello world');
      return createMockProcess([
        { event: 'init', conversation_id: 'session-art' },
        { event: 'result', result: { status: 'SUCCESS' } },
      ]);
    };
    const task = await tasks.run({ prompt: 'artifact task', workingDirectory: repoDir, artifactPaths: ['artifact.txt'] });
    await tasks.wait(task.taskId);
    assert.equal(tasks.status(task.taskId).status, 'completed');
    const listed = tasks.listArtifacts(task.taskId);
    assert.equal(listed.artifacts.length, 1);
    const ref = listed.artifacts[0]!;
    assert.equal(ref.path, 'artifact.txt');
    assert.equal(ref.bytes, 11);

    const chunk1 = await tasks.readArtifact(task.taskId, 'artifact.txt', ref.sha256, 0, 5);
    assert.equal(chunk1.offset, 0);
    assert.equal(chunk1.nextOffset, 5);
    assert.equal(chunk1.hasMore, true);
    assert.equal(Buffer.from(chunk1.content, 'base64').toString('utf8'), 'hello');

    const chunk2 = await tasks.readArtifact(task.taskId, 'artifact.txt', ref.sha256, 5, 6);
    assert.equal(chunk2.offset, 5);
    assert.equal(chunk2.nextOffset, 11);
    assert.equal(chunk2.hasMore, false);
    assert.equal(Buffer.from(chunk2.content, 'base64').toString('utf8'), ' world');

    const copyDir = tasks.status(task.taskId).copyDirectory!;
    await fs.promises.writeFile(path.join(copyDir, 'artifact.txt'), 'hello earth');
    await assert.rejects(
      () => tasks.readArtifact(task.taskId, 'artifact.txt', ref.sha256, 0, 11),
      (err: any) => err instanceof BridgeError && err.code === 'CONTENT_CHANGED'
    );
    await fs.promises.writeFile(path.join(copyDir, 'artifact.txt'), 'hello world');
  });

  it('compact metadata omits values, schema, and artifact manifest', async () => {
    const list = tasks.list();
    const taskWithSchema = list.find(t => t.structuredResult);
    assert.ok(taskWithSchema);
    const compact = compactTask(taskWithSchema);
    assert.ok(compact.structuredResultSha256);
    assert.equal((compact as any).structuredResult, undefined);
    assert.equal((compact as any).outputSchema, undefined);
    assert.equal((compact as any).artifactPaths, undefined);

    const taskWithArts = list.find(t => t.artifacts?.length);
    assert.ok(taskWithArts);
    const compactArts = compactTask(taskWithArts);
    assert.equal(compactArts.artifactCount, 1);
    assert.equal((compactArts as any).artifacts, undefined);
  });

  it('SDK in-memory MCP three tool contracts and catalog', async () => {
    const server = createMcpServer(adapter, tasks);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const toolList = await client.listTools();
    const names = toolList.tools.map(t => t.name);
    assert.equal(names.length, 49);
    assert.ok(names.includes('antigravity_read_structured_result'));
    assert.ok(names.includes('antigravity_artifacts'));
    assert.ok(names.includes('antigravity_read_artifact'));

    const completed = tasks.list().find(t => t.status === 'completed' && t.structuredResult)!;
    const artTask = tasks.list().find(t => t.status === 'completed' && t.artifacts?.length)!;
    const artRef = artTask.artifacts![0]!;

    const artsRes = await client.callTool({ name: 'antigravity_artifacts', arguments: { taskId: artTask.taskId } });
    assert.equal(artsRes.isError, undefined);
    const parsedArts = successOutputSchemas.antigravity_artifacts.parse(artsRes.structuredContent);
    assert.equal(parsedArts.artifacts.length, 1);

    const readArtRes = await client.callTool({
      name: 'antigravity_read_artifact',
      arguments: { taskId: artTask.taskId, path: 'artifact.txt', expectedSha256: artRef.sha256 },
    });
    assert.equal(readArtRes.isError, undefined);
    const parsedArtChunk = successOutputSchemas.antigravity_read_artifact.parse(readArtRes.structuredContent);
    assert.equal(Buffer.from(parsedArtChunk.content, 'base64').toString('utf8'), 'hello world');

    const srRes = await client.callTool({ name: 'antigravity_read_structured_result', arguments: { taskId: completed.taskId } });
    assert.equal(srRes.isError, undefined);
    const parsedSr = successOutputSchemas.antigravity_read_structured_result.parse(srRes.structuredContent);
    assert.equal(parsedSr.text, '{"count":7}');

    const incRes = await client.callTool({ name: 'antigravity_result', arguments: { taskId: completed.taskId, includeResult: false } });
    const parsedInc = successOutputSchemas.antigravity_result.parse(incRes.structuredContent);
    assert.equal(parsedInc.structuredResultAvailable, true);
    assert.equal(parsedInc.task.structuredResult, undefined);

    await client.close();
    await server.close();
  });

  it('schema and artifactPaths replacement on resume rejected and originals retained', async () => {
    await assert.rejects(
      () => tasks.run({ prompt: 'replace schema', workingDirectory: repoDir, sessionId: 'session-valid', outputSchema: { type: 'object' } }),
      (err: any) => err instanceof BridgeError && err.code === 'INVALID_SCHEMA'
    );
    await assert.rejects(
      () => tasks.run({ prompt: 'replace paths', workingDirectory: repoDir, sessionId: 'session-art', artifactPaths: ['new.txt'] }),
      (err: any) => err instanceof BridgeError && err.code === 'INVALID_ARTIFACT_PATHS'
    );
    adapter.nextProcessFactory = () => createMockProcess([
      { event: 'init', conversation_id: 'session-valid' },
      { event: 'result', result: { status: 'SUCCESS', structured_output: { count: 99 } } },
    ]);
    const resumed = await tasks.run({ prompt: 'resume retained', workingDirectory: repoDir, sessionId: 'session-valid' });
    assert.deepEqual(resumed.outputSchema, { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] });
    await tasks.wait(resumed.taskId);
    assert.equal(tasks.status(resumed.taskId).status, 'completed');
    assert.equal(tasks.readStructuredResult(resumed.taskId).text, '{"count":99}');
  });

  it('planner custom schema rejected', async () => {
    await assert.rejects(
      () => tasks.run({ prompt: 'plan', workingDirectory: repoDir, role: 'planner', outputSchema: { type: 'object' } }),
      (err: any) => err instanceof BridgeError && err.code === 'INVALID_ROLE'
    );
  });

  it('real CLI adapter forwards --conversation argument on session resume', async () => {
    const fixtureDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cli-fix-'));
    const argvFile = path.join(fixtureDir, 'argv.json');
    const fixtureScript = path.join(fixtureDir, 'mock-cli.mjs');
    await fs.promises.writeFile(fixtureScript, `import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('1.0.0');
else if (args.includes('--help')) console.log('--sandbox stream-json --output-format --conversation --json-schema --new-project models');
else {
  fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));
  console.log(JSON.stringify({ event: 'init', conversation_id: 'session-cli-test' }));
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }));
}`);
    const cliCfg = loadConfig({ AGY_PATH: process.execPath, BRIDGE_STATE_DIRECTORY: stateDir, BRIDGE_TEST_EXECUTOR: 'agy' });
    const realAdapter = new CliAdapter(cliCfg, [fixtureScript]);
    await realAdapter.discover();
    const child = realAdapter.spawnTask({ prompt: 'resume agy', workingDirectory: repoDir, sessionId: 'resume-session-xyz' }, undefined, repoDir);
    await new Promise(resolve => child.once('close', resolve));
    const captured: string[] = JSON.parse(await fs.promises.readFile(argvFile, 'utf8'));
    assert.ok(captured.includes('--conversation'));
    assert.equal(captured[captured.indexOf('--conversation') + 1], 'resume-session-xyz');
    assert.equal(path.dirname(path.resolve(fixtureDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(fixtureDir).startsWith('cli-fix-'));
    await fs.promises.rm(fixtureDir, { recursive: true, force: true });
  });
  it('missing structured output fails despite a CLI SUCCESS result', async () => {
    adapter.nextProcessFactory = () => createMockProcess([
      { event: 'init', conversation_id: 'session-missing' },
      { event: 'result', result: { status: 'SUCCESS' } },
    ]);
    const task = await tasks.run({ prompt: 'missing output', workingDirectory: repoDir, outputSchema: { type: 'object' } });
    await tasks.wait(task.taskId);
    assert.equal(tasks.status(task.taskId).error?.code, 'INVALID_STRUCTURED_RESULT');
  });

  it('large schemas use a private file and cleanup follows CLI completion', async () => {
    const fixtureDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cli-schema-test-'));
    const receipt = path.join(fixtureDir, 'receipt.json');
    const script = path.join(fixtureDir, 'capture.mjs');
    try {
      await fs.promises.writeFile(script, `import fs from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('--version')) console.log('1');
else if(args.includes('--help')) console.log('--sandbox stream-json --output-format --json-schema --conversation');
else {
 const value=args[args.indexOf('--json-schema')+1];
 const body=JSON.parse(fs.readFileSync(value,'utf8'));
 fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({value,body,args}));
 console.log(JSON.stringify({event:'result',result:{status:'SUCCESS'}}));
}`);
      const suppliedStateDir = process.platform === 'win32' ? stateDir.replace(/^[A-Z]:/, drive => drive.toLowerCase()) : stateDir;
      const cfg = loadConfig({ AGY_PATH: process.execPath, BRIDGE_STATE_DIRECTORY: suppliedStateDir, BRIDGE_TEST_EXECUTOR: 'agy' });
      const actual = new CliAdapter(cfg, [script]); await actual.discover();
      const schema = { type: 'object', description: 'x'.repeat(40000) };
      const child = actual.spawnTask({ prompt: 'public fixture', workingDirectory: repoDir, outputSchema: schema }, undefined, repoDir);
      await new Promise(resolve => child.once('close', resolve));
      const result = JSON.parse(await fs.promises.readFile(receipt, 'utf8'));
      assert.deepEqual(result.body, schema);
      assert.equal(path.dirname(result.value), fs.realpathSync.native(suppliedStateDir));
      assert.equal(fs.existsSync(result.value), false);
      assert.ok(result.args.join(' ').length < 32767);
    } finally {
      assert.equal(path.dirname(path.resolve(fixtureDir)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(fixtureDir).startsWith('cli-schema-test-'));
      await fs.promises.rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it('native MCP permission denial is explicit even when CLI reports SUCCESS without output', async () => {
    adapter.nextProcessFactory = () => {
      const child = createMockProcess([{event:'init',conversation_id:'session-mcp-denied'},{event:'result',result:{status:'SUCCESS'}}],0,()=>child.stderr.write('jetski: no output produced — a tool required the "mcp" permission that headless mode cannot prompt for, so it was auto-denied.\n'));
      return child;
    };
    const denied = await tasks.run({prompt:'Permission fixture.',workingDirectory:repoDir,outputSchema:{type:'object'}});
    await tasks.wait(denied.taskId);
    assert.equal(tasks.status(denied.taskId).error?.code,'AGY_MCP_PERMISSION_REQUIRED');
    adapter.nextProcessFactory = () => {
      const child = createMockProcess([{event:'init',conversation_id:'session-mcp-documentation'},{event:'result',result:{status:'SUCCESS',structured_output:{}}}],0,()=>child.stderr.write('Documentation mentions mcp permission in headless mode.\n'));
      return child;
    };
    const normal = await tasks.run({prompt:'Harmless stderr fixture.',workingDirectory:repoDir,outputSchema:{type:'object'}});
    await tasks.wait(normal.taskId);assert.equal(tasks.status(normal.taskId).status,'completed');
  });

});
