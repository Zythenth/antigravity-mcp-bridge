import path from 'node:path';
import { nativeToolsSchema, nativeToolSchema, mcpCatalogSchema, type NativeTool, type McpCatalogEntry } from './agent-policy.js';
import { readPreauthorizedIntegrationRoots } from './integration-policy.js';
import os from 'node:os';
import { toolProfileSchema, type ToolProfile } from './tool-profiles.js';
import { customRolesSchema, type RoleDefinition } from './roles.js';
import type { WindowsNodeRuntime } from './portable-node.js';

import {
  type SecretExceptionsPolicy,
  normalizeSecretExceptionsPolicy,
  validateAllowedEnvVars,
} from './hardening-policy.js';

export type { SecretExceptionsPolicy } from './hardening-policy.js';
export type TestExecutor = 'agy' | 'windows-lpac';
export type ApprovalMode = 'auto' | 'ask';
export type ConfigurationIssueReason = 'invalid-json' | 'not-a-list' | 'too-many-entries' | 'not-a-string' | 'not-absolute' | 'not-found' | 'access-denied' | 'not-a-directory' | 'volume-root' | 'unresolvable';
export interface ConfigurationIssue { variable: string; index?: number; reason: ConfigurationIssueReason }

function positiveInteger(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Invalid numeric configuration: ${value}`);
  return n;
}

export interface ProjectLimits {
  maxCopyFiles: number;
  maxCopyBytes: number;
  maxChangedFiles: number;
  secretExclusions?: readonly string[];
  secretExceptions?: SecretExceptionsPolicy | readonly string[];
}
export const DEFAULT_PROJECT_LIMITS: ProjectLimits = {
  maxCopyFiles: 10000,
  maxCopyBytes: 256 * 1024 * 1024,
  maxChangedFiles: 100,
  secretExclusions: [],
  secretExceptions: { version: 2, namePatterns: [] },
};

export interface Config extends ProjectLimits {
  approvalMode: ApprovalMode;
  antiAiCraft: boolean;
  antiAiCraftDirectory?: string;
  toolProfile: ToolProfile;
  preauthorizedIntegrationRoots: string[];
  configurationIssues: ConfigurationIssue[];
  customRoles: RoleDefinition[];
  allowedAgyTools: NativeTool[];
  enforceAgentPolicy: boolean;
  mcpCatalog: McpCatalogEntry[];
  agyPath: string;
  defaultModel?: string;
  maxConcurrentTasks: number;
  maxQueuedTasks: number;
  maxRetainedTasks: number;
  defaultTimeoutSeconds: number;
  eventBufferSize: number;
  maxPromptChars: number;
  copyRetentionHours: number;
  stateDirectory: string;
  memoryMaxEntries: number;
  memoryMaxBytes: number;
  memoryMaxEntryBytes: number;
  forbiddenDirectories: string[];
  testExecutor: TestExecutor;
  windowsNodeRuntime: WindowsNodeRuntime;
  windowsNodeCacheDirectory: string;
  secretExclusions: string[];
  secretExceptions: SecretExceptionsPolicy;
  allowedEnvVars: string[];
}

function absoluteDirectory(value: string, name: string): string {
  if (!path.isAbsolute(value) || value.includes('\0')) throw new Error(name + ' must be an absolute path');
  return path.resolve(value);
}

// Enabled unless explicitly turned off; an override directory is still verified against its manifest.
function antiAiCraft(value: string | undefined): boolean {
  if (value === undefined || value === 'on') return true;
  if (value === 'off') return false;
  throw new Error('BRIDGE_ANTI_AI_CRAFT must be on or off');
}

function approvalMode(value: string | undefined): ApprovalMode {
  if (value === undefined) return 'auto';
  if (value === 'auto' || value === 'ask') return value;
  throw new Error('BRIDGE_APPROVAL_MODE must be auto or ask');
}

function testExecutor(value: string | undefined): TestExecutor {
  if (value === undefined) return process.platform === 'win32' ? 'windows-lpac' : 'agy';
  if (value === 'agy' || value === 'windows-lpac') return value;
  throw new Error('BRIDGE_TEST_EXECUTOR must be agy or windows-lpac');
}

function windowsNodeRuntime(value: string | undefined): WindowsNodeRuntime {
  if (value === undefined) return 'system';
  if (value === 'system' || value === 'portable') return value;
  throw new Error('BRIDGE_WINDOWS_NODE_RUNTIME must be system or portable');
}

function windowsNodeCacheDirectory(value: string | undefined): string {
  const directory = value ?? path.join(os.homedir(), '.antigravity-mcp-bridge', 'windows-runtimes');
  if (value !== undefined) {
    if (process.platform === 'win32') {
      if (!/^[A-Za-z]:[\\/]/.test(value) || /^(?:\\\\|\/\/|\\\\\?\\)/.test(value) || value.slice(2).includes(':') ||
          value.slice(2).split(/[\\/]+/).filter(Boolean).some(part => part === '.' || part === '..')) {
        throw new Error('BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY must be an absolute local non-device path');
      }
    } else if (!path.isAbsolute(value)) {
      throw new Error('BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY must be absolute');
    }
  }
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root) throw new Error('BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY cannot be a volume root');
  return resolved;
}

function parseSecretExceptionsConfig(value: string | undefined): SecretExceptionsPolicy {
  if (value === undefined) return { version: 2, namePatterns: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('BRIDGE_SECRET_EXCEPTIONS must be a valid JSON object: {"version":2,"namePatterns":[...]}');
  }
  return normalizeSecretExceptionsPolicy(parsed, 'BRIDGE_SECRET_EXCEPTIONS');
}

function parseStringArray(value: string | undefined, envName: string): string[] {
  if (value === undefined) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(envName + ' must be a JSON array of strings'); }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string' || !item.trim() || item.includes('\0'))) {
    throw new Error(envName + ' must be a JSON array of non-empty strings');
  }
  const items = [...new Set((parsed as string[]).map(item => item.trim()))];
  if (envName === 'BRIDGE_ALLOWED_ENV_VARS' && items.some(item => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item))) {
    throw new Error(envName + ' must contain exact environment variable names');
  }
  if (envName === 'BRIDGE_SECRET_EXCLUSIONS' &&
      items.some(item => item.startsWith('/') || /^[A-Za-z]:/.test(item) || item.split(/[\\/]+/).some(part => part === '..'))) {
    throw new Error(envName + ' must contain relative glob patterns without traversal');
  }
  return items;
}

export function stateDirectoryFrom(env: NodeJS.ProcessEnv): string {
  return env.BRIDGE_STATE_DIRECTORY || path.join(os.homedir(), '.antigravity-mcp-bridge');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const defaultModel = env.BRIDGE_DEFAULT_MODEL;
  if (defaultModel !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(defaultModel)) {
    throw new Error('BRIDGE_DEFAULT_MODEL must be an exact model ID');
  }
  const memoryMaxEntries = positiveInteger(env.BRIDGE_MEMORY_MAX_ENTRIES, 100, 10000);
  const memoryMaxBytes = positiveInteger(env.BRIDGE_MEMORY_MAX_BYTES, 1024 * 1024, 64 * 1024 * 1024);
  const memoryMaxEntryBytes = positiveInteger(env.BRIDGE_MEMORY_MAX_ENTRY_BYTES, 64 * 1024, 1024 * 1024);
  if (memoryMaxEntryBytes > memoryMaxBytes) throw new Error('BRIDGE_MEMORY_MAX_ENTRY_BYTES cannot exceed BRIDGE_MEMORY_MAX_BYTES');
  const preauthorized = readPreauthorizedIntegrationRoots(env.BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS);
  return {
    approvalMode: approvalMode(env.BRIDGE_APPROVAL_MODE),
    antiAiCraft: antiAiCraft(env.BRIDGE_ANTI_AI_CRAFT),
    ...(env.BRIDGE_ANTI_AI_CRAFT_DIRECTORY ? { antiAiCraftDirectory: absoluteDirectory(env.BRIDGE_ANTI_AI_CRAFT_DIRECTORY, 'BRIDGE_ANTI_AI_CRAFT_DIRECTORY') } : {}),
    toolProfile: toolProfileSchema.parse(env.BRIDGE_TOOL_PROFILE ?? 'full'),
    preauthorizedIntegrationRoots: preauthorized.roots,
    configurationIssues: preauthorized.issues,
    customRoles: customRolesSchema.parse(JSON.parse(env.BRIDGE_CUSTOM_ROLES ?? '[]')),
    enforceAgentPolicy: env.BRIDGE_ALLOWED_AGY_TOOLS !== undefined || env.BRIDGE_MCP_CATALOG !== undefined,
    allowedAgyTools: nativeToolsSchema.parse(JSON.parse(env.BRIDGE_ALLOWED_AGY_TOOLS ?? JSON.stringify(nativeToolSchema.options))),
    mcpCatalog: mcpCatalogSchema.parse(JSON.parse(env.BRIDGE_MCP_CATALOG ?? '[]')),
    agyPath: env.AGY_PATH || 'agy',
    defaultModel,
    maxConcurrentTasks: positiveInteger(env.MAX_CONCURRENT_TASKS, 1, 16),
    maxQueuedTasks: positiveInteger(env.MAX_QUEUED_TASKS, 20, 1000),
    maxRetainedTasks: positiveInteger(env.MAX_RETAINED_TASKS, 100, 10000),
    defaultTimeoutSeconds: positiveInteger(env.DEFAULT_TIMEOUT_SECONDS, 1800, 86400),
    eventBufferSize: positiveInteger(env.EVENT_BUFFER_SIZE, 2000, 100000),
    maxPromptChars: positiveInteger(env.MAX_PROMPT_CHARS, 50000, 1000000),
    copyRetentionHours: positiveInteger(env.COPY_RETENTION_HOURS, 168, 87600),
    stateDirectory: stateDirectoryFrom(env),
    memoryMaxEntries,
    memoryMaxBytes,
    memoryMaxEntryBytes,
    maxCopyFiles: positiveInteger(env.MAX_COPY_FILES, DEFAULT_PROJECT_LIMITS.maxCopyFiles, 1000000),
    maxCopyBytes: positiveInteger(env.MAX_COPY_BYTES, DEFAULT_PROJECT_LIMITS.maxCopyBytes, 1024 ** 4),
    maxChangedFiles: positiveInteger(env.MAX_CHANGED_FILES, DEFAULT_PROJECT_LIMITS.maxChangedFiles, 1000000),
    forbiddenDirectories: (env.FORBIDDEN_DIRECTORIES || '').split(path.delimiter).filter(Boolean).map(p => path.resolve(p)),
    testExecutor: testExecutor(env.BRIDGE_TEST_EXECUTOR),
    windowsNodeRuntime: windowsNodeRuntime(env.BRIDGE_WINDOWS_NODE_RUNTIME),
    windowsNodeCacheDirectory: windowsNodeCacheDirectory(env.BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY),
    secretExclusions: parseStringArray(env.BRIDGE_SECRET_EXCLUSIONS, 'BRIDGE_SECRET_EXCLUSIONS'),
    secretExceptions: parseSecretExceptionsConfig(env.BRIDGE_SECRET_EXCEPTIONS),
    allowedEnvVars: validateAllowedEnvVars(parseStringArray(env.BRIDGE_ALLOWED_ENV_VARS, 'BRIDGE_ALLOWED_ENV_VARS'), 'BRIDGE_ALLOWED_ENV_VARS'),
  };
}

export function configurationWarning(issues: readonly ConfigurationIssue[]): string | undefined {
  if (issues.length === 0) return undefined;
  const formatted = issues.map(issue => `${issue.variable}${issue.index !== undefined ? `[${issue.index}]` : ''} ${issue.reason}`).join(', ');
  return `Ignored invalid configuration entries (nothing was granted from them): ${formatted}. See configurationIssues in antigravity_health.`;
}
