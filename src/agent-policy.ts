import { z } from 'zod';
import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { BridgeError } from './types.js';

// --- Regex Constants ---

export const serverIdRegex = /^[a-z][a-z0-9-]{0,31}$/;
export const toolNameRegex = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
export const envKeyRegex = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Native Tool Schemas ---

export const nativeToolSchema = z.enum([
  'finish',
  'view_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

export type NativeTool = z.infer<typeof nativeToolSchema>;

export const nativeToolsSchema = z
  .array(nativeToolSchema)
  .max(5)
  .refine((tools) => new Set(tools).size === tools.length, {
    message: 'Duplicate native tools are not allowed',
  });

// --- MCP Selection Schemas ---

export const mcpServerSelectionItemSchema = z
  .object({
    serverId: z.string().regex(serverIdRegex),
    tools: z
      .array(z.string().regex(toolNameRegex))
      .min(1)
      .max(100)
      .refine((tools) => new Set(tools).size === tools.length, {
        message: 'Duplicate tool names are not allowed',
      })
      .optional(),
  })
  .strict();

export const mcpSelectionSchema = z
  .array(mcpServerSelectionItemSchema)
  .max(20)
  .refine(
    (servers) => new Set(servers.map((s) => s.serverId)).size === servers.length,
    { message: 'Duplicate serverId in MCP selection' }
  );

export const agentPolicySelectionSchema = z
  .object({
    allowedTools: nativeToolsSchema.optional(),
    mcpServers: mcpSelectionSchema.optional(),
  })
  .strict();

export type AgentPolicySelection = z.infer<typeof agentPolicySelectionSchema>;

// --- Helper Validators ---

function isAbsolutePath(val: string): boolean {
  if (typeof val !== 'string' || val.length === 0 || val.length > 4000) {
    return false;
  }
  return path.isAbsolute(val) && (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(val));
}

function isValidServerUrl(urlString: string): boolean {
  if (typeof urlString !== 'string' || urlString.length > 4000) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return false;
  }
  // Reject URL embedded username/password
  if (parsed.username !== '' || parsed.password !== '') {
    return false;
  }
  // HTTPS remote or HTTP only loopback localhost/127.0.0.1/[::1]
  if (parsed.protocol === 'https:') {
    return true;
  }
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host === '::1'
    );
  }
  return false;
}

// --- MCP Catalog Schemas ---

export const mcpCatalogToolSchema = z
  .object({
    name: z.string().regex(toolNameRegex),
    readOnly: z.boolean(),
  })
  .strict();

export const mcpCatalogEntrySchema = z
  .object({
    id: z.string().regex(serverIdRegex),
    description: z.string().max(500).optional(),
    command: z
      .string()
      .max(4000)
      .refine(isAbsolutePath, { message: 'command must be an absolute host path' })
      .optional(),
    args: z.array(z.string().max(4000)).max(100).optional(),
    env: z
      .record(z.string().regex(envKeyRegex), z.string().max(16000))
      .refine((rec) => Object.keys(rec).length <= 100, {
        message: 'env entries cannot exceed 100',
      })
      .optional(),
    cwd: z
      .string()
      .max(4000)
      .refine(isAbsolutePath, { message: 'cwd must be an absolute host path' })
      .optional(),
    serverUrl: z
      .string()
      .max(4000)
      .refine(isValidServerUrl, {
        message: 'serverUrl must be valid HTTPS or loopback HTTP without credentials',
      })
      .optional(),
    headers: z
      .record(z.string().min(1).max(256), z.string().max(16000))
      .refine((rec) => Object.keys(rec).length <= 100, {
        message: 'headers entries cannot exceed 100',
      })
      .optional(),
    tools: z
      .array(mcpCatalogToolSchema)
      .min(1)
      .max(100)
      .refine((tools) => new Set(tools.map((t) => t.name)).size === tools.length, {
        message: 'tools in catalog entry must have unique names',
      }),
  })
  .strict()
  .refine(
    (entry) => (entry.command !== undefined) !== (entry.serverUrl !== undefined),
    { message: 'Require exactly one transport: command or serverUrl' }
  )
  .refine(
    (entry) => {
      if (entry.serverUrl !== undefined) {
        return (
          entry.args === undefined &&
          entry.cwd === undefined &&
          entry.env === undefined
        );
      }
      return true;
    },
    { message: 'Reject stdio-only fields (args, cwd, env) when HTTP transport is used' }
  )
  .refine(
    (entry) => {
      if (entry.command !== undefined) {
        return entry.headers === undefined;
      }
      return true;
    },
    { message: 'Reject headers when stdio transport is used' }
  );

export const mcpCatalogSchema = z
  .array(mcpCatalogEntrySchema)
  .max(20)
  .refine(
    (entries) => new Set(entries.map((e) => e.id)).size === entries.length,
    { message: 'Duplicate server id in MCP catalog' }
  )
  .refine(
    (entries) => {
      try {
        const serialized = JSON.stringify(entries);
        return Buffer.byteLength(serialized, 'utf8') <= 1024 * 1024;
      } catch {
        return false;
      }
    },
    { message: 'Serialized MCP catalog exceeds 1MiB' }
  );

export type McpCatalogEntry = z.infer<typeof mcpCatalogEntrySchema>;

// --- Policy Output Types ---

export interface ResolvedMcpServer {
  serverId: string;
  serverName: string;
  tools: string[];
}

export interface ResolvedAgentPolicy {
  mode: 'write' | 'read-only';
  nativeTools: NativeTool[];
  mcpServers: ResolvedMcpServer[];
  catalogSha256: string;
  sha256: string;
}

// --- Policy Resolution Constants ---

const WRITE_TOOLS: ReadonlySet<NativeTool> = new Set([
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

const READ_ONLY_NATIVE_TOOLS: ReadonlySet<NativeTool> = new Set([
  'finish',
  'view_file',
]);

// --- Policy Resolution Implementation ---

export function resolveAgentPolicy(
  selection: AgentPolicySelection,
  ceilingTools: NativeTool[],
  catalog: McpCatalogEntry[],
  mode: 'write' | 'read-only',
  namespace: string
): ResolvedAgentPolicy {
  // Validate mode
  if (mode !== 'write' && mode !== 'read-only') {
    throw new BridgeError('POLICY_NOT_ALLOWED', `Invalid mode: ${String(mode)}`);
  }

  // Validate namespace UUID
  if (typeof namespace !== 'string' || !UUID_REGEX.test(namespace)) {
    throw new BridgeError('POLICY_NOT_ALLOWED', `Invalid namespace UUID: ${String(namespace)}`);
  }

  // Validate ceilingTools
  const parsedCeiling = nativeToolsSchema.safeParse(ceilingTools);
  if (!parsedCeiling.success) {
    throw new BridgeError('POLICY_NOT_ALLOWED', `Invalid ceiling tools: ${parsedCeiling.error.message}`);
  }

  // Validate catalog
  const parsedCatalog = mcpCatalogSchema.safeParse(catalog);
  if (!parsedCatalog.success) {
    throw new BridgeError('POLICY_NOT_ALLOWED', `Invalid MCP catalog: ${parsedCatalog.error.message}`);
  }

  // Validate selection
  const parsedSelection = agentPolicySelectionSchema.safeParse(selection);
  if (!parsedSelection.success) {
    throw new BridgeError('POLICY_NOT_ALLOWED', `Invalid agent policy selection: ${parsedSelection.error.message}`);
  }

  // Native tools resolution
  let resolvedNative: NativeTool[];
  if (parsedSelection.data.allowedTools === undefined) {
    if (mode === 'read-only') {
      resolvedNative = parsedCeiling.data.filter((t) => READ_ONLY_NATIVE_TOOLS.has(t));
    } else {
      resolvedNative = [...parsedCeiling.data];
    }
  } else {
    const ceilingSet = new Set<NativeTool>(parsedCeiling.data);
    ceilingSet.add('finish'); // finish is always permitted

    for (const tool of parsedSelection.data.allowedTools) {
      if (!ceilingSet.has(tool)) {
        throw new BridgeError('POLICY_NOT_ALLOWED', `Tool '${tool}' exceeds ceiling`);
      }
      if (mode === 'read-only' && WRITE_TOOLS.has(tool)) {
        throw new BridgeError('POLICY_NOT_ALLOWED', `Write tool '${tool}' is not allowed in read-only mode`);
      }
    }
    resolvedNative = [...parsedSelection.data.allowedTools];
  }

  // Always retain implicit finish, even ceiling omitted it
  if (!resolvedNative.includes('finish')) {
    resolvedNative.push('finish');
  }

  // MCP Servers resolution
  const resolvedMcpServers: ResolvedMcpServer[] = [];

  if (parsedSelection.data.mcpServers !== undefined) {
    const seenServerIds = new Set<string>();
    for (const sel of parsedSelection.data.mcpServers) {
      if (seenServerIds.has(sel.serverId)) {
        throw new BridgeError('POLICY_NOT_ALLOWED', `Duplicate serverId '${sel.serverId}' in MCP selection`);
      }
      seenServerIds.add(sel.serverId);

      const entry = parsedCatalog.data.find((c) => c.id === sel.serverId);
      if (!entry) {
        throw new BridgeError('POLICY_NOT_ALLOWED', `Unknown MCP server '${sel.serverId}'`);
      }

      const catalogToolMap = new Map<string, boolean>();
      for (const t of entry.tools) {
        catalogToolMap.set(t.name, t.readOnly);
      }

      let eligibleTools: string[];

      if (sel.tools === undefined) {
        if (mode === 'write') {
          eligibleTools = entry.tools.map((t) => t.name);
        } else {
          eligibleTools = entry.tools.filter((t) => t.readOnly).map((t) => t.name);
        }
      } else {
        const seenTools = new Set<string>();
        eligibleTools = [];
        for (const toolName of sel.tools) {
          if (seenTools.has(toolName)) {
            throw new BridgeError(
              'POLICY_NOT_ALLOWED',
              `Duplicate tool '${toolName}' in selection for server '${sel.serverId}'`
            );
          }
          seenTools.add(toolName);

          const isReadOnly = catalogToolMap.get(toolName);
          if (isReadOnly === undefined) {
            throw new BridgeError(
              'POLICY_NOT_ALLOWED',
              `Unknown tool '${toolName}' for server '${sel.serverId}'`
            );
          }
          if (mode === 'read-only' && !isReadOnly) {
            throw new BridgeError(
              'POLICY_NOT_ALLOWED',
              `Tool '${toolName}' on server '${sel.serverId}' is not read-only`
            );
          }
          eligibleTools.push(toolName);
        }
      }

      if (eligibleTools.length === 0) {
        throw new BridgeError(
          'POLICY_NOT_ALLOWED',
          `No eligible tools for server '${sel.serverId}' in ${mode} mode`
        );
      }

      const cleanNs = namespace.replace(/-/g, '').toLowerCase();
      const cleanServerId = sel.serverId.replace(/-/g, '_');
      const serverName = `bridge_${cleanNs}_${cleanServerId}`;

      resolvedMcpServers.push({
        serverId: sel.serverId,
        serverName,
        tools: [...eligibleTools],
      });
    }
  }

  // Selected private definitions from human catalog for hashing
  const selectedPrivateDefinitions = resolvedMcpServers.map((s) => {
    return catalog.find((c) => c.id === s.serverId)!;
  });

  const catalogSha256 = crypto
    .createHash('sha256')
    .update(JSON.stringify(selectedPrivateDefinitions))
    .digest('hex');

  const publicPayload = {
    mode,
    nativeTools: resolvedNative,
    mcpServers: resolvedMcpServers,
    catalogSha256,
  };

  const sha256 = crypto
    .createHash('sha256')
    .update(JSON.stringify(publicPayload))
    .digest('hex');

  return {
    mode,
    nativeTools: [...resolvedNative],
    mcpServers: resolvedMcpServers.map((s) => ({
      serverId: s.serverId,
      serverName: s.serverName,
      tools: [...s.tools],
    })),
    catalogSha256,
    sha256,
  };
}

// --- Strict JSON Validator Helpers ---

function isStrictJsonValue(val: unknown, stack: Set<object>): boolean {
  if (val === null) {
    return true;
  }
  const t = typeof val;
  if (t === 'boolean' || t === 'string') {
    return true;
  }
  if (t === 'number') {
    return Number.isFinite(val);
  }
  if (t === 'object') {
    const obj = val as object;
    if (stack.has(obj)) {
      return false; // circular reference
    }
    stack.add(obj);

    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (!isStrictJsonValue(item, stack)) {
          stack.delete(obj);
          return false;
        }
      }
      stack.delete(obj);
      return true;
    }

    const proto = Object.getPrototypeOf(obj);
    if (proto !== null && proto !== Object.prototype) {
      stack.delete(obj);
      return false;
    }

    if (Object.getOwnPropertySymbols(obj).length > 0) {
      stack.delete(obj);
      return false;
    }

    for (const v of Object.values(obj)) {
      if (!isStrictJsonValue(v, stack)) {
        stack.delete(obj);
        return false;
      }
    }
    stack.delete(obj);
    return true;
  }
  return false;
}

function isStrictJsonObject(val: object): boolean {
  const proto = Object.getPrototypeOf(val);
  if (proto !== null && proto !== Object.prototype) {
    return false;
  }
  return isStrictJsonValue(val, new Set<object>());
}

// --- Generic MCP Tool Authorizer ---

export function authorizeMcpTool(policy: ResolvedAgentPolicy, args: unknown): boolean {
  try {
    if (!policy || !Array.isArray(policy.mcpServers) || typeof args !== 'object' || args === null || Array.isArray(args)) return false;
    const keys = Object.keys(args);
    if (keys.length !== 3 || !keys.includes('ServerName') || !keys.includes('ToolName') || !keys.includes('Arguments') || !isStrictJsonObject(args)) return false;
    const raw = args as Record<string, unknown>;
    if (typeof raw.ServerName !== 'string' || typeof raw.ToolName !== 'string' || typeof raw.Arguments !== 'object' || raw.Arguments === null || Array.isArray(raw.Arguments)) return false;
    if (Buffer.byteLength(JSON.stringify(raw.Arguments), 'utf8') > 50000) return false;
    return policy.mcpServers.some(server => server.serverName === raw.ServerName && server.tools.includes(raw.ToolName as string));
  } catch {
    return false;
  }
}
