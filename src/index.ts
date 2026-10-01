import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CliAdapter } from './cli-adapter.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp-server.js';
import { TaskManager } from './task-manager.js';

const config = loadConfig();
const adapter = new CliAdapter(config);
await adapter.discover();
const tasks = new TaskManager(adapter, config);
await tasks.cleanup();
const server = createMcpServer(adapter, tasks);
await server.connect(new StdioServerTransport());
const cleanupTimer = setInterval(() => {
  void tasks.cleanup().catch(error => process.stderr.write(`Copy cleanup failed: ${String(error)}\n`));
}, 60000);
cleanupTimer.unref();

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(cleanupTimer);
  await tasks.shutdown();
  await server.close();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
