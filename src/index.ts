import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CliAdapter } from './cli-adapter.js';
import { loadConfig, configurationWarning } from './config.js';
import { createMcpServer } from './mcp-server.js';
import { TaskManager } from './task-manager.js';
import { portableNodeStatus, preparePortableNodeRuntime } from './portable-node.js';
import { runWaitCommand, waitCommandArgv } from './wait-command.js';
import { runPermissionsCommand } from './permissions-command.js';
import { migrateDefaultState, migrateDefaultStateSettling } from './state-migration.js';
import { recoverWindowsExecutions } from './windows-executor.js';

const command = process.argv.slice(2);

async function runtimeCommand(): Promise<boolean> {
  if (command.length === 0) return false;
  if (command.length !== 1 || (command[0] !== '--prepare-windows-runtime' && command[0] !== '--windows-runtime-status')) {
    throw new Error('Expected exactly one startup command: --prepare-windows-runtime, --windows-runtime-status, wait <taskId>, or permissions --host <host>');
  }
  const config = loadConfig();
  if (command[0] === '--windows-runtime-status') {
    process.stdout.write(JSON.stringify(await portableNodeStatus(config.windowsNodeRuntime, config.windowsNodeCacheDirectory, undefined, { cacheDirectoryInvalid: config.windowsNodeCacheDirectoryInvalid })) + '\n');
    return true;
  }
  try {
    // Preparing the runtime creates the default root, so an earlier root is migrated first to keep its cache.
    migrateDefaultState(config, process.env, { report: line => process.stderr.write(line + '\n') });
    await preparePortableNodeRuntime({ cacheDirectory: config.windowsNodeCacheDirectory, cacheDirectoryInvalid: config.windowsNodeCacheDirectoryInvalid });
    process.stdout.write(JSON.stringify(await portableNodeStatus(config.windowsNodeRuntime, config.windowsNodeCacheDirectory, undefined, { cacheDirectoryInvalid: config.windowsNodeCacheDirectoryInvalid })) + '\n');
    return true;
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
    return true;
  }
}

if (command[0] === 'wait') {
  process.exitCode = await runWaitCommand(command.slice(1), process.env, line => process.stdout.write(line + '\n'));
} else if (command[0] === 'permissions') {
  process.exitCode = runPermissionsCommand(command.slice(1), text => process.stdout.write(text), text => process.stderr.write(text));
} else if (!await runtimeCommand()) {
  const loaded = loadConfig();
  const config = await migrateDefaultStateSettling(loaded, process.env, async legacy => {
    if (process.platform !== 'win32' || loaded.testExecutor !== 'windows-lpac') throw new Error('the Windows executor is not available in this configuration');
    await recoverWindowsExecutions(legacy, { requireIdle: true });
  }, { report: line => process.stderr.write(line + '\n') });
  const adapter = new CliAdapter(config);
  await adapter.discover();
  const tasks = new TaskManager(adapter, config);
  const warning = configurationWarning(tasks.configurationIssues);
  if (warning) process.stderr.write(warning + '\n');
  function reportMaintenance(problem: string | undefined) {
    if (problem !== undefined) process.stderr.write(problem + '\n');
  }
  reportMaintenance(await tasks.maintain());
  const waitCommand = tasks.isStateDirectoryUsable() ? waitCommandArgv(config.stateDirectory) : undefined;
  const server = createMcpServer(adapter, tasks, { waitCommand });
  await server.connect(new StdioServerTransport());
  const cleanupTimer = setInterval(() => {
    void tasks.maintain().then(reportMaintenance);
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
