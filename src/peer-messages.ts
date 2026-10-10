import { z } from 'zod';
import { BridgeError } from './types.js';
import { validateGroupGraph, KEY_REGEX, RESERVED_KEYS } from './task-groups.js';
import type { GroupGraph } from './task-groups.js';

export const MAX_PEER_MESSAGE_CHARS = 2000;
export const MAX_PEER_ROUTES = 128;
export const MAX_PEER_SCAN_CHARS = 1_000_000;
export const MAX_PEER_PAYLOAD_CHARS = 4096;
export const MAX_PEER_MESSAGES = 20;
export const PEER_MESSAGE_OPEN_TAG = '<antigravity-peer-message>';
export const PEER_MESSAGE_CLOSE_TAG = '</antigravity-peer-message>';

export const nodeKeySchema = z
  .string()
  .regex(KEY_REGEX, 'Node key must match /^[a-z][a-z0-9-]{0,63}$/')
  .refine(
    (k) => !RESERVED_KEYS.has(k) && !(k in Object.prototype),
    'Node key cannot be a reserved object property'
  );

export const peerMessageTextSchema = z
  .string()
  .min(1, 'Message text must be between 1 and 2000 characters')
  .max(MAX_PEER_MESSAGE_CHARS, 'Message text must be between 1 and 2000 characters')
  .refine((val) => !val.includes('\0'), 'Message text cannot contain NUL bytes')
  .refine((val) => val.trim().length > 0, 'Message text cannot be all whitespace');

export const peerMessageInputSchema = z
  .object({
    messageId: z.string().uuid('messageId must be a valid UUID'),
    toNode: nodeKeySchema,
    text: peerMessageTextSchema,
  })
  .strict();

export type PeerMessageInput = z.infer<typeof peerMessageInputSchema>;

export const peerRouteSchema = z
  .object({
    from: nodeKeySchema,
    to: nodeKeySchema,
  })
  .strict();

export type PeerRoute = z.infer<typeof peerRouteSchema>;

export const peerRoutesSchema = z
  .array(peerRouteSchema)
  .min(0, 'Peer routes cannot contain fewer than 0 routes')
  .max(MAX_PEER_ROUTES, `Peer routes cannot exceed ${MAX_PEER_ROUTES} routes`)
  .superRefine((routes, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i]!;
      if (route.from === route.to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Self edge detected: node "${route.from}" cannot route to itself`,
          path: [i],
        });
      }
      const edgeKey = `${route.from}->${route.to}`;
      if (seen.has(edgeKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate route detected: "${route.from}" -> "${route.to}"`,
          path: [i],
        });
      }
      seen.add(edgeKey);
    }
  });

function parseAndValidateRoutes(validGraph: GroupGraph, routes: unknown): PeerRoute[] {
  const parsed = peerRoutesSchema.safeParse(routes);
  if (!parsed.success) {
    throw new BridgeError('INVALID_PEER_ROUTES', parsed.error.issues[0]?.message ?? 'Invalid peer routes');
  }

  const validNodes = new Set(validGraph.nodes.map((n) => n.key));
  for (const route of parsed.data) {
    if (!validNodes.has(route.from)) {
      throw new BridgeError('INVALID_PEER_ROUTES', `Route endpoint "${route.from}" does not exist in graph`);
    }
    if (!validNodes.has(route.to)) {
      throw new BridgeError('INVALID_PEER_ROUTES', `Route endpoint "${route.to}" does not exist in graph`);
    }
  }

  return parsed.data.map((r) => ({ from: r.from, to: r.to }));
}

export function validatePeerRoutes(graph: unknown, routes: unknown): PeerRoute[] {
  const validGraph = validateGroupGraph(graph);
  return parseAndValidateRoutes(validGraph, routes);
}

export function isPeerRouteAllowed(
  graph: unknown,
  routes: unknown,
  from: string,
  to: string,
): boolean {
  const validGraph = validateGroupGraph(graph);
  const validRoutes = parseAndValidateRoutes(validGraph, routes);

  if (typeof from !== 'string' || typeof to !== 'string') {
    return false;
  }

  const validNodes = new Set(validGraph.nodes.map((n) => n.key));
  if (!validNodes.has(from) || !validNodes.has(to)) {
    return false;
  }

  return validRoutes.some((route) => route.from === from && route.to === to);
}

export function extractPeerMessages(text: string): { messages: PeerMessageInput[]; truncated: boolean } {
  if (typeof text !== 'string') return { messages: [], truncated: false };
  const bounded = text.slice(0, MAX_PEER_SCAN_CHARS);
  const messages: PeerMessageInput[] = [];
  let truncated = text.length > MAX_PEER_SCAN_CHARS;
  let cursor = 0, payloadStart: number | undefined, quoted = false, escaped = false;
  while (cursor < bounded.length) {
    if (payloadStart !== undefined) {
      if (cursor - payloadStart > MAX_PEER_PAYLOAD_CHARS) {
        payloadStart = undefined; quoted = false; escaped = false;
      } else if (quoted) {
        if (escaped) escaped = false;
        else if (bounded[cursor] === '\\') escaped = true;
        else if (bounded[cursor] === '"') quoted = false;
        cursor++; continue;
      } else if (bounded[cursor] === '"') {
        quoted = true; cursor++; continue;
      }
    }
    if (bounded.startsWith(PEER_MESSAGE_OPEN_TAG, cursor)) {
      payloadStart = cursor + PEER_MESSAGE_OPEN_TAG.length;
      cursor = payloadStart; quoted = false; escaped = false;
      continue;
    }
    if (payloadStart !== undefined && bounded.startsWith(PEER_MESSAGE_CLOSE_TAG, cursor)) {
      try {
        const parsed = peerMessageInputSchema.safeParse(JSON.parse(bounded.slice(payloadStart, cursor)));
        if (parsed.success) {
          if (messages.length === MAX_PEER_MESSAGES) { truncated = true; break; }
          messages.push(parsed.data);
        }
      } catch { /* Malformed public envelopes do not become routed messages. */ }
      payloadStart = undefined; quoted = false; escaped = false;
      cursor += PEER_MESSAGE_CLOSE_TAG.length;
      continue;
    }
    cursor++;
  }
  return { messages, truncated };
}


export const peerOriginSchema = z.object({
  groupId: z.string().uuid(), fromNode: nodeKeySchema,
  sourceTaskId: z.string().uuid(), messageId: z.string().uuid(),
}).strict();
export type PeerOrigin = z.infer<typeof peerOriginSchema>;
export const peerContextSchema = z.object({
  groupId: z.string().uuid(), nodeKey: nodeKeySchema,
  targets: z.array(nodeKeySchema).max(31).refine(values => new Set(values).size === values.length),
}).strict();
export type PeerContext = z.infer<typeof peerContextSchema>;
