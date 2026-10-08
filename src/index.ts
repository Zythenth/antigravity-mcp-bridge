import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CliAdapter } from './cli-adapter.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp-server.js';
import { TaskManager } from './task-manager.js';
import { portableNodeStatus, preparePortableNodeRuntime } from './portable-node.js';

const command = process.argv.slice(2);

async function runtimeCommand(): Promise<boolean> {
  if (command.length === 0) return false;
  if (command.length !== 1 || (command[0] !== '--prepare-windows-runtime' && command[0] !== '--windows-runtime-status')) {
    throw new Error('Expected exactly one startup command: --prepare-windows-runtime or --windows-runtime-status');
  }
  const config = loadConfig();
  if (command[0] === '--windows-runtime-status') {
    process.stdout.write(JSON.stringify(await portableNodeStatus(config.windowsNodeRuntime, config.windowsNodeCacheDirectory)) + '\n');
    return true;
  }
  try {
    await preparePortableNodeRuntime({ cacheDirectory: config.windowsNodeCacheDirectory });
    process.stdout.write(JSON.stringify(await portableNodeStatus(config.windowsNodeRuntime, config.windowsNodeCacheDirectory)) + '\n');
    return true;
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
    return true;
  }
}

if (!await runtimeCommand()) {
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
}
