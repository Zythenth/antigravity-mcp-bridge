import path from 'node:path';
import os from 'node:os';

function positiveInteger(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Invalid numeric configuration: ${value}`);
  return n;
}

export interface ProjectLimits { maxCopyFiles: number; maxCopyBytes: number; maxChangedFiles: number }
export const DEFAULT_PROJECT_LIMITS: ProjectLimits = { maxCopyFiles: 10000, maxCopyBytes: 256 * 1024 * 1024, maxChangedFiles: 100 };

export interface Config extends ProjectLimits {
  agyPath: string;
  maxConcurrentTasks: number;
  maxQueuedTasks: number;
  maxRetainedTasks: number;
  defaultTimeoutSeconds: number;
  eventBufferSize: number;
  maxPromptChars: number;
  copyRetentionHours: number;
  stateDirectory: string;
  forbiddenDirectories: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    agyPath: env.AGY_PATH || 'agy',
    maxConcurrentTasks: positiveInteger(env.MAX_CONCURRENT_TASKS, 1, 16),
    maxQueuedTasks: positiveInteger(env.MAX_QUEUED_TASKS, 20, 1000),
    maxRetainedTasks: positiveInteger(env.MAX_RETAINED_TASKS, 100, 10000),
    defaultTimeoutSeconds: positiveInteger(env.DEFAULT_TIMEOUT_SECONDS, 1800, 86400),
    eventBufferSize: positiveInteger(env.EVENT_BUFFER_SIZE, 2000, 100000),
    maxPromptChars: positiveInteger(env.MAX_PROMPT_CHARS, 50000, 1000000),
    copyRetentionHours: positiveInteger(env.COPY_RETENTION_HOURS, 168, 87600),
    stateDirectory: env.BRIDGE_STATE_DIRECTORY || path.join(os.homedir(), '.antigravity-mcp-bridge'),
    maxCopyFiles: positiveInteger(env.MAX_COPY_FILES, DEFAULT_PROJECT_LIMITS.maxCopyFiles, 1000000),
    maxCopyBytes: positiveInteger(env.MAX_COPY_BYTES, DEFAULT_PROJECT_LIMITS.maxCopyBytes, 1024 ** 4),
    maxChangedFiles: positiveInteger(env.MAX_CHANGED_FILES, DEFAULT_PROJECT_LIMITS.maxChangedFiles, 1000000),
    forbiddenDirectories: (env.FORBIDDEN_DIRECTORIES || '').split(path.delimiter).filter(Boolean).map(p => path.resolve(p)),
  };
}
