import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agy-native-integration-')));
const source = path.join(directory, 'source');
const markerDirectory = await realpath(await mkdtemp(path.join(os.homedir(), '.agy-isolation-check-')));
const markerPath = path.join(markerDirectory, 'marker.txt');
const markerContent = randomUUID();
await writeFile(markerPath, markerContent);
execFileSync('git', ['init', '--quiet', source]);
await writeFile(path.join(source, 'source.txt'), 'original');
const client = new Client({ name: 'native-test-integration', version: '1' });
let firstId, testId;
const windowsLpac = process.platform === 'win32' && process.env.BRIDGE_TEST_EXECUTOR !== 'agy';
const expectedEvidence = windowsLpac
  ? { source: 'windows-executor', sandbox: 'windows-lpac' }
  : { source: 'agy-tool', sandbox: 'agy-native-requested' };
const portableRuntime = windowsLpac && process.env.BRIDGE_WINDOWS_NODE_RUNTIME === 'portable';
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw Error(JSON.stringify(result.structuredContent));
  return result.structuredContent;
}
async function wait(taskId) {
  const deadline = Date.now() + 200000;
  let final;
  while (Date.now() < deadline) {
    final = await call('antigravity_result', { taskId });
    if (final.ready) return final.task;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error('Native integration timed out: ' + JSON.stringify(final));
}
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/src/index.js')],
    env: { BRIDGE_STATE_DIRECTORY: path.join(directory, 'state'), BRIDGE_TOOL_PROFILE: 'full',
       ...(process.env.AGY_PATH ? { AGY_PATH: process.env.AGY_PATH } : {}),
       ...(process.env.BRIDGE_DEFAULT_MODEL ? { BRIDGE_DEFAULT_MODEL: process.env.BRIDGE_DEFAULT_MODEL } : {}),
       ...(process.env.BRIDGE_TEST_EXECUTOR ? { BRIDGE_TEST_EXECUTOR: process.env.BRIDGE_TEST_EXECUTOR } : {}),
       ...(process.env.BRIDGE_WINDOWS_NODE_RUNTIME ? { BRIDGE_WINDOWS_NODE_RUNTIME: process.env.BRIDGE_WINDOWS_NODE_RUNTIME } : {}),
       ...(process.env.BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY ? { BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: process.env.BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY } : {}) }, stderr: 'pipe' }));
  const first = await call('antigravity_run', { prompt: 'Do not change files. Reply ready for a test command.', workingDirectory: source, timeoutSeconds: 60,
    acceptanceCriteria: [{ id: 'source', description: 'Keep the source file', check: { kind: 'file-contains', path: 'source.txt', text: 'original' } }] });
  firstId = first.task.taskId;
  const finished = await wait(firstId);
  if (finished.status !== 'completed') throw Error(JSON.stringify({ error: finished.error, initialTokenUsage: finished.tokenUsage }));
  const preview = await call('antigravity_preview', { taskId: firstId });
  const runtimeLookup = windowsLpac ?
    'const cp=require("node:child_process");const lookup=cp.spawnSync(process.execPath,["--version"],{encoding:"utf8"});' +
    'if(lookup.status!==0){console.error(lookup.stderr||lookup.stdout);process.exit(11)}' +
    'if(!lookup.stdout.trim()){console.error(lookup.stderr||"staged node produced no version output");process.exit(12)}console.log("sandbox resolves staged node: "+lookup.stdout.trim());' :
    process.platform === 'win32' ?
    'const cp=require("node:child_process");const lookup=cp.spawnSync(' +
    JSON.stringify(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')) +
    ',["-NoProfile","-NonInteractive","-Command","$ErrorActionPreference=\'Stop\';(Get-Command -Name node -CommandType Application -ErrorAction Stop).Source"],{encoding:"utf8"});' +
    'if(lookup.status!==0){console.error(lookup.stderr);process.exit(11)}console.log("sandbox resolves installed node command");' : '';
  const testScript = "const fs=require('node:fs'); if(fs.readFileSync('source.txt','utf8')!=='original')process.exit(8);" +
    runtimeLookup +
    'const marker=' + JSON.stringify(markerPath) + ";const denied=new Set(['EACCES','EPERM','ENOENT']);" +
    "try{fs.readFileSync(marker);process.exit(9)}catch(error){if(!denied.has(error.code))throw error}" +
    "try{fs.writeFileSync(marker,'changed');process.exit(10)}catch(error){if(!denied.has(error.code))throw error}" +
    "console.log('native executor ran; outside read and write denied');";
  const tested = await call('antigravity_test', { taskId: firstId, expectedSha256: preview.sha256, timeoutSeconds: 120,
    command: { executable: process.execPath, args: ['-e', testScript] } });
  testId = tested.task.taskId;
  const final = await wait(testId);
  const evidence = final.tests?.at(-1);
  const localUsage = final.tokenUsage;
  if (final.status !== 'completed' || evidence?.source !== expectedEvidence.source || evidence?.sandbox !== expectedEvidence.sandbox || evidence.exitCode !== 0 || !evidence.output.includes('native executor ran') ||
       (portableRuntime && !evidence?.portableNode) ||
       (windowsLpac && (localUsage?.source !== 'local-executor' || Object.values(localUsage.counters || {}).some(value => value !== 0)))) {
    const events = await call('antigravity_events', { taskId: testId });
    throw Error(JSON.stringify({ error: final.error, result: final.result, evidence, initialTokenUsage: finished.tokenUsage, tokenUsage: final.tokenUsage, sessionUsage: final.usage,
      diagnostics: events.events.filter(event => !['copy.ready', 'copy.created', 'task.queued'].includes(event.type)) }));
  }
  const after = await call('antigravity_preview', { taskId: testId });
  if (after.tests.at(-1).stale || after.sha256 !== preview.sha256) throw Error('Native test evidence or patch changed');
  if (await readFile(path.join(source, 'source.txt'), 'utf8') !== 'original') throw Error('Original source changed');
  if (await readFile(markerPath, 'utf8') !== markerContent) throw Error('Host marker changed');
  console.log(JSON.stringify({ status: 'passed', source: evidence.source, exitCode: evidence.exitCode, output: evidence.output, sandbox: evidence.sandbox, portableNode: evidence.portableNode, initialTokenUsage: finished.tokenUsage, tokenUsage: final.tokenUsage, sessionUsage: final.usage }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  for (const taskId of [testId, firstId].filter(Boolean)) await call('antigravity_cancel', { taskId }).catch(() => {});
  for (const taskId of [testId, firstId].filter(Boolean)) await call('antigravity_discard', { taskId }).catch(() => {});
  await client.close();
  if (path.relative(await realpath(os.tmpdir()), path.dirname(directory)) !== '' || !path.basename(directory).startsWith('agy-native-integration-')) throw Error('Unsafe test cleanup path');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (path.relative(await realpath(os.homedir()), path.dirname(markerDirectory)) !== '' || !path.basename(markerDirectory).startsWith('.agy-isolation-check-')) throw Error('Unsafe marker cleanup path');
  await rm(markerDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
