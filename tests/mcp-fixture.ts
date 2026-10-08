import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { CliAdapter } from '../src/cli-adapter.js';
import { loadConfig } from '../src/config.js';
import { createMcpServer } from '../src/mcp-server.js';
import { TaskManager } from '../src/task-manager.js';

const config = loadConfig({ ...process.env, AGY_PATH: process.execPath, BRIDGE_TEST_EXECUTOR: 'agy' });
const adapter = new CliAdapter(config, [fileURLToPath(new URL('../../tests/mock-agy.mjs', import.meta.url))]);
await adapter.discover();
const tasks = new TaskManager(adapter, config);
const server = createMcpServer(adapter, tasks);
server.server.onclose = () => { void tasks.shutdown(); };
await server.connect(new StdioServerTransport());
