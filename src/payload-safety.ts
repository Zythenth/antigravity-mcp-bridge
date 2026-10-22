import { redactDiagnostic } from './subprocess.js';

export const DEFAULT_MAX_PAYLOAD_DEPTH = 64;
export const DEFAULT_MAX_PAYLOAD_NODES = 100_000;

export interface SanitizeOptions { maxDepth?: number; maxNodes?: number }
export interface SanitizedPayload { value: unknown; redacted: boolean; truncated: boolean }

type Container = unknown[] | Record<string, unknown>;

// Copies JSON-shaped data iteratively so hostile nesting cannot exhaust the stack before stringify or structuredClone.
export function sanitizePayload(value: unknown, options: SanitizeOptions = {}): SanitizedPayload {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_PAYLOAD_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_PAYLOAD_NODES;
  for (const limit of [maxDepth, maxNodes]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Payload limits must be positive safe integers');
  }
  let redacted = false, truncated = false, nodes = 0;
  const pending: Array<{ source: object; target: Container; depth: number }> = [];

  const copy = (input: unknown, depth: number): { keep: boolean; value?: unknown } => {
    if (++nodes > maxNodes) { truncated = true; return { keep: true, value: '[node limit exceeded]' }; }
    if (typeof input === 'string') {
      const text = redactDiagnostic(input);
      if (text !== input) redacted = true;
      return { keep: true, value: text };
    }
    if (typeof input === 'number') return { keep: true, value: Number.isFinite(input) ? input : null };
    if (typeof input === 'boolean' || input === null) return { keep: true, value: input };
    if (typeof input !== 'object') return { keep: false };
    if (depth > maxDepth) { truncated = true; return { keep: true, value: '[depth limit exceeded]' }; }
    const target: Container = Array.isArray(input) ? [] : {};
    pending.push({ source: input, target, depth });
    return { keep: true, value: target };
  };

  const root = copy(value, 0);
  while (pending.length) {
    const { source, target, depth } = pending.pop()!;
    // Once the node budget is spent, each container keeps a single marker and stops enumerating.
    if (Array.isArray(source)) {
      for (const item of source) {
        const next = copy(item, depth + 1);
        (target as unknown[]).push(next.keep ? next.value : null);
        if (nodes > maxNodes) break;
      }
      continue;
    }
    // for...in avoids materializing every entry of a huge object once the budget is spent.
    for (const key in source) {
      if (nodes > maxNodes) break;
      if (!Object.hasOwn(source, key)) continue;
      const next = copy((source as Record<string, unknown>)[key], depth + 1);
      if (!next.keep) continue;
      const name = redactDiagnostic(key);
      if (name !== key) redacted = true;
      if (Object.hasOwn(target, name)) { redacted = true; continue; }
      // defineProperty keeps keys such as __proto__ as own data instead of changing the prototype.
      Object.defineProperty(target, name, { value: next.value, enumerable: true, writable: true, configurable: true });
    }
  }
  return { value: root.keep ? root.value : undefined, redacted, truncated };
}
