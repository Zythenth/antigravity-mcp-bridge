import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CliAdapter } from '../dist/src/cli-adapter.js';
import { loadConfig } from '../dist/src/config.js';
import { TaskManager } from '../dist/src/task-manager.js';

const [root, stateDirectory, taskCountArg, withGroupArg] = process.argv.slice(2);
const isPackageRoot = dir => path.basename(dir).startsWith('agy-package-test-') && path.relative(fs.realpathSync(os.tmpdir()), path.dirname(dir)) === '';
if (!root || !path.isAbsolute(root) || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw Error('Expected named temporary fixture root');
const realRoot = fs.realpathSync(root);
if (!isPackageRoot(realRoot) && !isPackageRoot(path.dirname(realRoot))) throw Error('Expected named temporary fixture root');
if (!stateDirectory || !path.isAbsolute(stateDirectory)) throw Error('Expected absolute stateDirectory');
const taskCount = Number(taskCountArg);
if (!Number.isSafeInteger(taskCount) || taskCount < 0 || !['0', '1'].includes(withGroupArg)) throw Error('Invalid fixture arguments');

const source = path.join(realRoot, 'source');
if (!fs.existsSync(path.join(source, '.git'))) execFileSync('git', ['init', '--quiet', source]);
if (!fs.existsSync(path.join(source, 'source.txt'))) fs.writeFileSync(path.join(source, 'source.txt'), 'source');

const config = loadConfig({
  BRIDGE_ANTI_AI_CRAFT: 'off',
  AGY_PATH: process.execPath,
  DEFAULT_TIMEOUT_SECONDS: '30',
  BRIDGE_TEST_EXECUTOR: 'agy',
  BRIDGE_STATE_DIRECTORY: stateDirectory,
});
const mockPath = fileURLToPath(new URL('./mock-agy.mjs', import.meta.url));
class Adapter extends CliAdapter {
  spawnTask(options, model, cwd) {
    if (!options.group) return super.spawnTask(options, model, cwd);
    const child = new EventEmitter(), stdout = new PassThrough(), sessionId = randomUUID();
    Object.assign(child, { stdin: new PassThrough(), stdout, stderr: new PassThrough(), exitCode: null, killed: false, kill() { return true; } });
    setImmediate(() => {
      stdout.write(JSON.stringify({ event: 'init', conversation_id: sessionId }) + '\n');
      setTimeout(() => {
        const hook = spawnSync(process.execPath, ['bridge-execution-hook.mjs'], { cwd: path.join(cwd, '.agents'), windowsHide: true, encoding: 'utf8',
          input: JSON.stringify({ toolCall: { name: 'finish', args: {} }, workspacePaths: [cwd], conversationId: sessionId }) });
        if (hook.status !== 0 || JSON.parse(hook.stdout).decision !== 'allow') throw Error('Guard did not permit fixture completion');
        stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Public result.' } }) + '\n');
        stdout.end(); child.exitCode = 0; child.emit('close', 0);
      }, 50);
    });
    return child;
  }
}

const adapter = new Adapter(config, [mockPath]);
await adapter.discover();
const manager = new TaskManager(adapter, config);
const terminal = new Set(['completed', 'failed', 'cancelled', 'timeout']);
for (let i = 0; i < taskCount; i++) {
  const { taskId } = await manager.run({ prompt: 'test', workingDirectory: source });
  const deadline = Date.now() + 60000;
  let task = manager.status(taskId);
  while (!terminal.has(task.status)) {
    if (Date.now() >= deadline) throw Error(`Task timed out: ${taskId}`);
    await delay(20);
    task = manager.status(taskId);
  }
  assert.equal(task.status, 'completed');
}
let groupId = null;
if (withGroupArg === '1') {
  const group = await manager.groups.create(randomUUID(), {
    workingDirectory: source,
    title: 'Aged state',
    jobs: [{ key: 'a', owner: 'implementer', dependsOn: [], task: { prompt: 'Inspect A.', mode: 'read-only' } }],
  });
  groupId = group.groupId;
  manager.groups.start(groupId, group.definitionSha256);
  const deadline = Date.now() + 120000;
  let status = manager.groups.status(groupId);
  while (!['completed', 'failed', 'cancelled', 'paused'].includes(status.state)) {
    if (Date.now() >= deadline) throw Error(`Group timed out: ${groupId}`);
    await delay(20);
    status = manager.groups.status(groupId);
  }
  assert.equal(status.state, 'completed');
}
const tasks = manager.list().filter(task => task.copyDirectory).map(({ taskId, copyDirectory }) => ({ taskId, copyDirectory }));
console.log(JSON.stringify({ tasks, groupId }));
await manager.shutdown();
