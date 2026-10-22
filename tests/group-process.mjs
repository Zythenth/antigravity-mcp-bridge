import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskManager } from '../dist/src/task-manager.js';
import { loadConfig } from '../dist/src/config.js';
import { CliAdapter } from '../dist/src/cli-adapter.js';
const [root, groupId, digest] = process.argv.slice(2);
if (!path.isAbsolute(root) || path.relative(path.resolve(os.tmpdir()), path.dirname(path.resolve(root))) !== '' || !path.basename(root).startsWith('agy-group-runtime-')) throw Error('Expected named temporary fixture root');
const config = loadConfig({ BRIDGE_STATE_DIRECTORY: path.join(root, 'state'), BRIDGE_TEST_EXECUTOR: 'agy' });
class Adapter extends CliAdapter {
  spawnTask(options, _model, cwd) {
    fs.appendFileSync(path.join(root, 'admissions.jsonl'), JSON.stringify({ key: options.group.nodeKey }) + '\n');
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
const manager = new TaskManager(new Adapter(config), config);
console.log('READY');
while (!fs.existsSync(path.join(root, 'go'))) await delay(10);
try { manager.groups.start(groupId, digest); }
catch (error) { if (!['STATE_BUSY', 'GROUP_OWNED_BY_OTHER_SERVER'].includes(error.code)) throw error; }
const totalDeadline = Date.now() + 180000;
let inactivityDeadline = Date.now() + 60000, lastProgress = '', status;
while (!['completed', 'failed'].includes((status = manager.groups.status(groupId)).state)) {
  const progress = JSON.stringify({ state: status.state, nodes: status.nodes.map(({ key, state }) => ({ key, state })) });
  if (progress !== lastProgress) {
    lastProgress = progress;
    inactivityDeadline = Date.now() + 60000;
  }
  const now = Date.now();
  if (now > totalDeadline || now > inactivityDeadline) {
    const limit = now > totalDeadline ? 'Group did not finish within 180 s' : 'Group made no progress for 60 s';
    const nodeErrors = status.nodes.filter(n => n.error?.code).map(n => ({ key: n.key, error: n.error.code }));
    throw Error(`${limit}; progress: ${progress}; node errors: ${JSON.stringify(nodeErrors)}`);
  }
  await delay(20);
}
console.log(JSON.stringify({ state: manager.groups.status(groupId).state }));
await manager.shutdown();
