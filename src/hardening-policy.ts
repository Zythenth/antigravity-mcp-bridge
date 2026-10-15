import { BridgeError } from './types.js';

export interface SecretExceptionsPolicy {
  readonly version: 2;
  readonly namePatterns: readonly string[];
}

/**
 * Checks if an environment variable name belongs to forbidden runtime injection namespaces.
 * Blocks NODE_OPTIONS, NODE_PATH, and LD_ / DYLD_ namespaces regardless of casing or whitespace.
 */
export function isForbiddenAllowedEnvVar(name: string): boolean {
  const norm = name.trim().toUpperCase();
  if (norm === 'NODE_OPTIONS' || norm === 'NODE_PATH') return true;
  if (norm.startsWith('LD_') || norm.startsWith('DYLD_')) return true;
  return false;
}

/**
 * Validates a single allowed environment variable name.
 * Disallows invalid variable names, traversal/NUL, and forbidden injection variables.
 * Diagnostic never echoes any variable value.
 */
export function assertValidAllowedEnvVar(rawName: string, contextName = 'allowedEnvVars'): string {
  if (typeof rawName !== 'string' || !rawName.trim() || rawName.includes('\0')) {
    throw new BridgeError('INVALID_ALLOWED_ENV_VAR', `${contextName} must contain exact environment variable names`);
  }
  const trimmed = rawName.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new BridgeError('INVALID_ALLOWED_ENV_VAR', `${contextName} must contain exact environment variable names`);
  }
  if (isForbiddenAllowedEnvVar(trimmed)) {
    throw new BridgeError('FORBIDDEN_ENV_VAR', `${contextName} cannot include runtime injection variable: ${trimmed}`);
  }
  return trimmed;
}

/**
 * Validates a list of allowed environment variable names.
 */
export function validateAllowedEnvVars(vars: readonly string[], contextName = 'allowedEnvVars'): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of vars) {
    const valid = assertValidAllowedEnvVar(item, contextName);
    if (!seen.has(valid)) {
      seen.add(valid);
      result.push(valid);
    }
  }
  return result;
}

/**
 * Validates project-relative glob pattern string.
 */
export function validateRelativeGlobPattern(pattern: string, contextName = 'Glob pattern'): string {
  if (typeof pattern !== 'string' || !pattern.trim() || pattern.includes('\0')) {
    throw new BridgeError('INVALID_GLOB_PATTERN', `${contextName} must be a non-empty string without NUL`);
  }
  let norm = pattern.replaceAll('\\', '/').trim();
  while (norm.startsWith('./')) {
    norm = norm.slice(2);
  }
  if (!norm) {
    throw new BridgeError('INVALID_GLOB_PATTERN', `${contextName} must be a non-empty string without NUL`);
  }
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) {
    throw new BridgeError('INVALID_GLOB_PATTERN', `${contextName} must be project-relative`);
  }
  const parts = norm.split('/');
  if (parts.some(p => p === '..')) {
    throw new BridgeError('INVALID_GLOB_PATTERN', `${contextName} must not contain traversal (..)`);
  }
  return norm;
}

/**
 * Normalizes and validates secret exceptions policy.
 * Supports version 2 object format: { version: 2, namePatterns: string[] }.
 * Omission or empty array normalizes to empty policy.
 * Legacy non-empty array fails with migration guidance without echoing values.
 * Unknown versions, extra fields, malformed or null values are rejected.
 */
export function normalizeSecretExceptionsPolicy(
  input: unknown,
  contextName = 'BRIDGE_SECRET_EXCEPTIONS'
): SecretExceptionsPolicy {
  if (input === undefined) {
    return { version: 2, namePatterns: [] };
  }
  if (Array.isArray(input)) {
    if (input.length === 0) {
      return { version: 2, namePatterns: [] };
    }
    throw new BridgeError(
      'INVALID_SECRET_EXCEPTIONS',
      `${contextName} uses legacy array format. Migrate to strict version 2 object format: {"version":2,"namePatterns":[...]}`
    );
  }
  if (typeof input !== 'object' || input === null) {
    throw new BridgeError(
      'INVALID_SECRET_EXCEPTIONS',
      `${contextName} must be a strict JSON object: {"version":2,"namePatterns":[...]}`
    );
  }

  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.some(k => k !== 'version' && k !== 'namePatterns')) {
    throw new BridgeError(
      'INVALID_SECRET_EXCEPTIONS',
      `${contextName} contains unexpected fields. Only version and namePatterns are allowed`
    );
  }
  if (!Object.hasOwn(obj, 'version') || !Object.hasOwn(obj, 'namePatterns')) {
    throw new BridgeError(
      'INVALID_SECRET_EXCEPTIONS',
      `${contextName} must contain version and namePatterns fields`
    );
  }
  if (obj.version !== 2) {
    throw new BridgeError(
      'INVALID_SECRET_EXCEPTIONS',
      `${contextName} specifies an unsupported version. Only version 2 is supported`
    );
  }
  if (!Array.isArray(obj.namePatterns)) {
    throw new BridgeError(
      'INVALID_SECRET_EXCEPTIONS',
      `${contextName}.namePatterns must be a JSON array of strings`
    );
  }

  const validatedPatterns: string[] = [];
  const seenPatterns = new Set<string>();
  for (const item of obj.namePatterns) {
    if (typeof item !== 'string' || !item.trim() || item.includes('\0')) {
      throw new BridgeError(
        'INVALID_SECRET_EXCEPTIONS',
        `${contextName}.namePatterns must be a JSON array of non-empty strings without NUL`
      );
    }
    if (item.startsWith('/') || /^[A-Za-z]:/.test(item) || item.split(/[\\/]+/).some(part => part === '..')) {
      throw new BridgeError(
        'INVALID_SECRET_EXCEPTIONS',
        `${contextName} must contain relative glob patterns without traversal`
      );
    }
    const validated = validateRelativeGlobPattern(item, `${contextName}.namePatterns`);
    if (!seenPatterns.has(validated)) {
      seenPatterns.add(validated);
      validatedPatterns.push(validated);
    }
  }

  return {
    version: 2,
    namePatterns: validatedPatterns,
  };
}
