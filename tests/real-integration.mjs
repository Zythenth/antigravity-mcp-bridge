import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-real-'));
const client = new Client({ name: 'agy-mcp-integration-test', version: '1.0.0' });
const serverPath = process.env.AGY_BRIDGE_SERVER || path.resolve('dist/src/index.js');
const transport = new StdioClientTransport({ command: process.execPath,
  args: [serverPath], env: { ...process.env, AGY_PATH: process.env.AGY_PATH || 'agy' } });
let taskId;
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name);
  for (const name of ['antigravity_health', 'antigravity_list_models', 'antigravity_run', 'antigravity_events', 'antigravity_result', 'antigravity_cancel']) {
    if (!names.includes(name)) throw new Error(`Missing MCP tool ${name}`);
  }
  console.log(`MCP_TOOLS=${names.length}`);
  const health = await client.callTool({ name: 'antigravity_health', arguments: {} });
  if (health.isError) throw new Error(JSON.stringify(health.structuredContent));
  console.log(`HEALTH=${JSON.stringify(health.structuredContent)}`);
  const models = await client.callTool({ name: 'antigravity_list_models', arguments: {} });
  if (models.isError) throw new Error(JSON.stringify(models.structuredContent));
  console.log(`MODEL_COUNT=${models.structuredContent.models.length}`);
  const run = await client.callTool({ name: 'antigravity_run', arguments: {
    prompt: 'Create a file named AGY_BRIDGE_TEST.md in the current directory containing exactly this sentence: Antigravity MCP bridge test successful. Do not change other files.',
    workingDirectory: directory, timeoutSeconds: 180,
  } });
  if (run.isError) throw new Error(JSON.stringify(run.structuredContent));
  taskId = run.structuredContent.task.taskId;
  console.log(`TASK_ID=${taskId}`);
  let cursor = 0, eventCount = 0, sawLive = false, final;
  const deadline = Date.now() + 200000;
  while (Date.now() < deadline) {
    const events = await client.callTool({ name: 'antigravity_events', arguments: { taskId, after: cursor } });
    if (events.isError) throw new Error(JSON.stringify(events.structuredContent));
    const payload = events.structuredContent;
    eventCount += payload.events.length;
    cursor = payload.nextCursor;
    const result = await client.callTool({ name: 'antigravity_result', arguments: { taskId } });
    if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
    if (!result.structuredContent.ready && payload.events.some(event => event.type === 'agent.started' || event.type === 'step.update' || event.type === 'response.chunk')) sawLive = true;
    if (result.structuredContent.ready) { final = result.structuredContent.task; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!final) throw new Error('Task did not finish before deadline');
  console.log(`FINAL_STATUS=${final.status}`);
  console.log(`EVENT_COUNT=${eventCount}`);
  console.log(`SAW_LIVE=${sawLive}`);
  if (final.status !== 'completed') throw new Error(JSON.stringify(final.error || final.result || final));
  const contents = await readFile(path.join(directory, 'AGY_BRIDGE_TEST.md'), 'utf8');
  console.log(`FILE=${contents.trim()}`);
  if (final.status !== 'completed' || contents.trim() !== 'Antigravity MCP bridge test successful.' || eventCount < 3) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (taskId) await client.callTool({ name: 'antigravity_cancel', arguments: { taskId } }).catch(() => {});
  await client.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
