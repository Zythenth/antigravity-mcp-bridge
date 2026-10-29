import { opendirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ConfigurationIssue, ConfigurationIssueReason } from './config.js';

export interface IntegrationApproval { confirmed: boolean; rememberProject?: boolean }

function mapFsError(error: unknown): ConfigurationIssueReason {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not-found';
  if (code === 'EACCES' || code === 'EPERM') return 'access-denied';
  return 'unresolvable';
}

function canonicalizeRoot(entry: unknown): { root: string } | { reason: ConfigurationIssueReason; error?: unknown } {
  if (typeof entry !== 'string') return { reason: 'not-a-string' };
  if (!path.isAbsolute(entry)) return { reason: 'not-absolute' };
  let canonical: string;
  try {
    canonical = realpathSync.native(entry);
  } catch (error) {
    return { reason: mapFsError(error), error };
  }
  let isDirectory: boolean;
  try {
    isDirectory = statSync(canonical).isDirectory();
  } catch (error) {
    return { reason: mapFsError(error), error };
  }
  if (!isDirectory) return { reason: 'not-a-directory' };
  if (canonical === path.parse(canonical).root) return { reason: 'volume-root' };
  try {
    opendirSync(canonical).closeSync();
  } catch (error) {
    return { reason: mapFsError(error), error };
  }
  return { root: process.platform === 'win32' ? canonical.toLowerCase() : canonical };
}

export function preauthorizedIntegrationRoots(value?: string): string[] {
  const roots: unknown = JSON.parse(value ?? '[]');
  if (!Array.isArray(roots) || roots.length > 20 || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) {
    throw new Error('BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS must be a JSON array of up to 20 absolute project directories');
  }
  return [...new Set((roots as string[]).map(root => {
    const result = canonicalizeRoot(root);
    if ('root' in result) return result.root;
    throw result.error ?? new Error('Preauthorization requires a project directory, not a volume root');
  }))];
}

export function readPreauthorizedIntegrationRoots(value: string | undefined): { roots: string[]; issues: ConfigurationIssue[] } {
  const variable = 'BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS';
  if (value === undefined) return { roots: [], issues: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { roots: [], issues: [{ variable, reason: 'invalid-json' }] };
  }
  if (!Array.isArray(parsed)) {
    return { roots: [], issues: [{ variable, reason: 'not-a-list' }] };
  }
  if (parsed.length > 20) {
    return { roots: [], issues: [{ variable, reason: 'too-many-entries' }] };
  }
  const roots: string[] = [];
  const issues: ConfigurationIssue[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const result = canonicalizeRoot(parsed[i]);
    if ('root' in result) {
      roots.push(result.root);
    } else {
      issues.push({ variable, index: i, reason: result.reason });
    }
  }
  return { roots: [...new Set(roots)], issues };
}

export function integrationPreauthorized(workingDirectory: string, roots: readonly string[]): boolean {
  const canonical = process.platform === 'win32' ? workingDirectory.toLowerCase() : workingDirectory;
  return roots.includes(canonical);
}
