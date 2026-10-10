import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import { z } from 'zod';

import { BridgeError } from './types.js';
import type {
  ResolvedAgentPolicy,
  McpCatalogEntry,
} from './agent-policy.js';
import {
  resolvedAgentPolicySchema,
  mcpCatalogSchema,
} from './agent-policy.js';
import type { ProjectLimits } from './config.js';

export const EXECUTION_POLICY_PATHS = [
  '.agents/hooks.json',
  '.agents/bridge-execution-hook.mjs',
  '.agents/bridge-execution-policy.json',
  '.agents/mcp_config.json',
] as const;

export interface StagedExecutionPolicy {
  policy: ResolvedAgentPolicy;
  executionId: string;
  receiptPath: string;
  receiptIdentity: { dev: string; ino: string };
  files: Array<{ path: string; sha256: string; bytes: number }>;
  requiredNativePermissions: string[];
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;
const MCP_PERMISSION_REGEX = /^mcp\([A-Za-z0-9][A-Za-z0-9_-]{0,127}\/[A-Za-z0-9_.-]+\)$/;

export const stagedExecutionPolicyFileSchema = z
  .object({
    path: z.enum(EXECUTION_POLICY_PATHS),
    sha256: z.string().regex(SHA256_HEX_REGEX),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export const stagedExecutionPolicySchema = z
  .object({
    policy: resolvedAgentPolicySchema,
    executionId: z.string().regex(UUID_REGEX),
    receiptIdentity: z.object({ dev: z.string().regex(/^[0-9]+$/), ino: z.string().regex(/^[0-9]+$/) }).strict(),
    receiptPath: z
      .string()
      .min(1)
      .max(4000)
      .refine(
        (val) => {
          return (
            path.isAbsolute(val) &&
            (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(val))
          );
        },
        { message: 'receiptPath must be an absolute path' }
      ),
    files: z
      .array(stagedExecutionPolicyFileSchema)
      .length(4)
      .refine(
        (files) => {
          const paths = new Set(files.map((f) => f.path));
          const hashes = new Set(files.map((f) => f.sha256));
          return (
            paths.size === 4 &&
            hashes.size === 4 &&
            EXECUTION_POLICY_PATHS.every((p) => paths.has(p))
          );
        },
        { message: 'files must contain exactly the 4 managed execution policy paths with unique hashes' }
      ),
    requiredNativePermissions: z
      .array(z.string().regex(MCP_PERMISSION_REGEX))
      .refine((perms) => new Set(perms).size === perms.length, {
        message: 'Duplicate required native permissions',
      }),
  })
  .strict();

const WINDOWS_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  'CONIN$', 'CONOUT$',
]);

function isWindowsDeviceName(segment: string): boolean {
  const base = segment.split('.')[0]!.toUpperCase();
  return WINDOWS_DEVICE_NAMES.has(base);
}

function pathsEqual(p1: string, p2: string): boolean {
  if (process.platform === 'win32') {
    return path.resolve(p1).toLowerCase() === path.resolve(p2).toLowerCase();
  }
  return path.resolve(p1) === path.resolve(p2);
}

function validatePathFormat(targetPath: string, label: string): void {
  if (typeof targetPath !== 'string' || !targetPath || targetPath.length > 4000) {
    throw new BridgeError('UNSAFE_PROJECT_PATH', `${label} must be a valid path string`);
  }
  if (!path.isAbsolute(targetPath)) {
    throw new BridgeError('UNSAFE_PROJECT_PATH', `${label} must be absolute: ${targetPath}`);
  }
  if (process.platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/.test(targetPath)) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', `${label} must be a local Windows drive path: ${targetPath}`);
    }
    if (/^(?:\\\\|\/\/|\\\\\?\\)/.test(targetPath)) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', `${label} cannot be a UNC or device namespace path: ${targetPath}`);
    }
    if (targetPath.slice(2).includes(':')) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', `${label} cannot contain alternate data streams: ${targetPath}`);
    }
  }
  if (/[\x00-\x1f]/.test(targetPath)) {
    throw new BridgeError('UNSAFE_PROJECT_PATH', `${label} cannot contain control characters`);
  }
  if (targetPath.split(/[\\/]+/).some(part => part === '.' || part === '..')) throw new BridgeError('UNSAFE_PROJECT_PATH', 'Path traversal segments are not allowed');
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  const relFromRoot = resolved.slice(parsed.root.length);
  const segments = relFromRoot.split(/[\\/]+/).filter(Boolean);
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new BridgeError('UNSAFE_PROJECT_PATH', `${label} cannot contain traversal segments`);
    }
    if (/[. ]$/.test(seg)) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', `${label} cannot contain trailing dot or space: ${seg}`);
    }
    if (isWindowsDeviceName(seg)) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', `${label} cannot contain device name: ${seg}`);
    }
  }
}

async function assertNoLinkAncestry(targetPath: string, label: string): Promise<void> {
  validatePathFormat(targetPath, label);
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  const relFromRoot = resolved.slice(parsed.root.length);
  const segments = relFromRoot.split(/[\\/]+/).filter(Boolean);
  let current = parsed.root;
  for (const seg of segments) {
    current = path.join(current, seg);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        break;
      }
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', `${label} cannot have symlink or junction in path: ${current}`);
    }
  }
}

async function hookMain() {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const url = await import('node:url');

  const WINDOWS_DEVICE_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
    'CONIN$', 'CONOUT$',
  ]);

  function isDeviceName(segment: string) {
    const base = segment.split('.')[0]!.toUpperCase();
    return WINDOWS_DEVICE_NAMES.has(base);
  }

  function isInside(parent: string, child: string) {
    const p = process.platform === 'win32' ? path.resolve(parent).toLowerCase() : path.resolve(parent);
    const c = process.platform === 'win32' ? path.resolve(child).toLowerCase() : path.resolve(child);
    const rel = path.relative(p, c);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  function canonicalProtected(target: string) {
    const parts = path.relative(manifest.canonicalCopyRoot, target).split(/[\\/]+/).filter(Boolean).map(part => part.toLowerCase());
    return parts.includes('.git') || parts[0] === '.agents';
  }

  function emitDecision(decision: string, reason: string): never {
    console.log(JSON.stringify({ decision, reason }));
    process.exit(0);
  }

  // 1. Read manifest relative to hook cwd (.agents)
  const manifestPath = path.resolve(process.cwd(), 'bridge-execution-policy.json');
  let manifestStat;
  try {
    manifestStat = await fsp.lstat(manifestPath);
  } catch {
    emitDecision('deny', 'Denied by execution policy');
  }
  if (!manifestStat || manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    emitDecision('deny', 'Denied by execution policy');
  }

  let manifest: { version: number; policy: ResolvedAgentPolicy; originalCopyRoot: string; canonicalCopyRoot: string; hookSha256: string; executionId: string; receiptPath: string; receiptIdentity: { dev: string; ino: string }; skillFiles: string[] };
  try {
    const manifestText = await fsp.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(manifestText);
  } catch {
    emitDecision('deny', 'Denied by execution policy');
  }
  if (!manifest || typeof manifest !== 'object' || manifest.version !== 1) {
    emitDecision('deny', 'Denied by execution policy');
  }

  // 2. Verify hook script source hash
  try {
    const scriptPath = url.fileURLToPath(import.meta.url);
    const hookStat = await fsp.lstat(scriptPath);
    if (hookStat.isSymbolicLink() || !hookStat.isFile()) {
      emitDecision('deny', 'Denied by execution policy');
    }
    const hookSource = await fsp.readFile(scriptPath, 'utf8');
    const hookHash = crypto.createHash('sha256').update(hookSource, 'utf8').digest('hex');
    if (hookHash !== manifest.hookSha256) {
      emitDecision('deny', 'Denied by execution policy');
    }
  } catch {
    emitDecision('deny', 'Denied by execution policy');
  }

  // 3. Verify public policy hash
  try {
    const publicPayload = {
      mode: manifest.policy.mode,
      nativeTools: manifest.policy.nativeTools,
      mcpServers: manifest.policy.mcpServers,
      catalogSha256: manifest.policy.catalogSha256,
    };
    const policyHash = crypto.createHash('sha256').update(JSON.stringify(publicPayload)).digest('hex');
    if (policyHash !== manifest.policy.sha256) {
      emitDecision('deny', 'Denied by execution policy');
    }
  } catch {
    emitDecision('deny', 'Denied by execution policy');
  }

  // 4. Verify canonical workspace identity
  const isWindows = process.platform === 'win32';
  try {
    const expectedCanonical = path.resolve(manifest.canonicalCopyRoot);
    const actualCanonical = path.resolve(await fsp.realpath(path.resolve(process.cwd(), '..')));
    const match = isWindows
      ? expectedCanonical.toLowerCase() === actualCanonical.toLowerCase()
      : expectedCanonical === actualCanonical;
    if (!match) {
      emitDecision('deny', 'Denied by execution policy');
    }
  } catch {
    emitDecision('deny', 'Denied by execution policy');
  }

  // 5. Read bounded 1MiB stdin
  let rawStdin = '';
  try {
    rawStdin = await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      process.stdin.on('data', chunk => {
        total += chunk.length;
        if (total > 1024 * 1024) {
          process.stdin.pause();
          reject(new Error('STDIN_TOO_LARGE'));
        } else {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      });
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      process.stdin.on('error', reject);
    });
  } catch {
    emitDecision('deny', 'Denied by execution policy');
  }

  let input;
  try {
    input = JSON.parse(rawStdin);
  } catch {
    emitDecision('deny', 'Denied by execution policy');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    emitDecision('deny', 'Denied by execution policy');
  }

  // Check workspacePaths if provided
  if (Array.isArray(input.workspacePaths) && input.workspacePaths.length > 0) {
    const origRoot = path.resolve(manifest.originalCopyRoot);
    const canonRoot = path.resolve(manifest.canonicalCopyRoot);
    const matchAny = input.workspacePaths.some((wp: unknown) => {
      if (typeof wp !== 'string') return false;
      const res = path.resolve(wp);
      return isWindows
        ? (res.toLowerCase() === origRoot.toLowerCase() || res.toLowerCase() === canonRoot.toLowerCase())
        : (res === origRoot || res === canonRoot);
    });
    if (!matchAny) {
      emitDecision('deny', 'Denied by execution policy');
    }
  }

  // 6. Evaluate decision
  const toolCall = input.toolCall;
  const toolName = toolCall?.name;
  const args = toolCall?.args;
  const conversationId = typeof input.conversationId === 'string' ? input.conversationId : null;

  let decision = 'deny';
  let reason = 'Denied by execution policy';

  if (typeof toolName !== 'string') {
    decision = 'deny';
    reason = 'Invalid tool call';
  } else if (toolName === 'finish') {
    decision = 'allow';
    reason = 'Finish tool is permitted';
  } else if (toolName === 'call_mcp_tool') {
    let mcpAllowed = false;
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      const keys = Object.keys(args).filter(key => key !== 'toolAction' && key !== 'toolSummary');
      const metadataValid = ['toolAction', 'toolSummary'].every(key => args[key] === undefined || (typeof args[key] === 'string' && args[key].length <= 2000));
      if (metadataValid && keys.length === 3 && keys.includes('ServerName') && keys.includes('ToolName') && keys.includes('Arguments')) {
        const { ServerName, ToolName, Arguments } = args;
        if (typeof ServerName === 'string' && typeof ToolName === 'string' &&
            Arguments && typeof Arguments === 'object' && !Array.isArray(Arguments)) {
          let argsBytes = 0;
          try {
            argsBytes = Buffer.byteLength(JSON.stringify(Arguments), 'utf8');
          } catch {
            argsBytes = 999999;
          }
          if (argsBytes <= 50000) {
            const s = manifest.policy.mcpServers?.find((srv: { serverName: string; tools: string[] }) => srv.serverName === ServerName);
            if (s && Array.isArray(s.tools) && s.tools.includes(ToolName)) {
              mcpAllowed = true;
            }
          }
        }
      }
    }
    if (mcpAllowed) {
      decision = 'allow';
      reason = 'MCP tool authorized by policy';
    } else {
      decision = 'deny';
      reason = 'MCP server, tool or argument envelope is not authorized';
    }
  } else if (['view_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(toolName)) {
    const isWrite = toolName !== 'view_file';
    if (!manifest.policy.nativeTools || !manifest.policy.nativeTools.some(tool => tool === toolName)) {
      decision = 'deny';
      reason = `Tool ${toolName} not allowed by native tools policy`;
    } else if (isWrite && manifest.policy.mode === 'read-only') {
      decision = 'deny';
      reason = 'Write tools not allowed in read-only mode';
    } else {
      const rawTarget = toolName === 'view_file' ? args?.AbsolutePath : args?.TargetFile;
      let pathValid = typeof rawTarget === 'string' && rawTarget.length > 0 && rawTarget.length <= 4000;
      if (pathValid) {
        if (!path.isAbsolute(rawTarget)) {
          pathValid = false;
        } else if (isWindows) {
          if (!/^[A-Za-z]:[\\/]/.test(rawTarget) || /^(?:\\\\|\/\/|\\\\\?\\)/.test(rawTarget) || rawTarget.slice(2).includes(':')) {
            pathValid = false;
          }
        }
        if (/[\x00-\x1f]/.test(rawTarget) || rawTarget.split(/[\\/]+/).some((part: string) => part === '.' || part === '..')) {
          pathValid = false;
        }
      }

      if (!pathValid) {
        decision = 'deny';
        reason = 'Invalid or non-absolute target file path';
      } else {
        const resolvedTarget = path.resolve(rawTarget);
        const insideOriginal = isInside(manifest.originalCopyRoot, resolvedTarget);
        const insideCanonical = isInside(manifest.canonicalCopyRoot, resolvedTarget);

        if (!insideOriginal && !insideCanonical) {
          decision = 'deny';
          reason = 'Path is outside copy directory';
        } else {
          const rootUsed = insideOriginal ? manifest.originalCopyRoot : manifest.canonicalCopyRoot;
          let relToRoot = path.relative(rootUsed, resolvedTarget);
          if (isWindows && (relToRoot.startsWith('..') || path.isAbsolute(relToRoot))) {
            relToRoot = path.relative(path.resolve(rootUsed).toLowerCase(), path.resolve(resolvedTarget).toLowerCase());
          }
          const segs = relToRoot.split(/[\\/]+/).filter(Boolean);

          let segsSafe = true;
          for (const seg of segs) {
            if (seg === '.' || seg === '..' || /[. ]$/.test(seg) || isDeviceName(seg)) {
              segsSafe = false;
              break;
            }
          }
          if (isWrite && segs.length === 1 && ['node', 'node.exe', 'node.com', 'node.cmd', 'node.bat'].includes(segs[0]!.toLowerCase())) segsSafe = false;
          if (segs.some(s => s.toLowerCase() === '.git')) {
            segsSafe = false;
          }

          if (!segsSafe) {
            decision = 'deny';
            reason = 'Path contains invalid characters or accesses .git';
          } else if (segs[0]?.toLowerCase() === '.agents') {
            if (isWrite) {
              decision = 'deny';
              reason = 'All writes to .agents are denied';
            } else {
              const forwardRel = segs.join('/');
              if (!Array.isArray(manifest.skillFiles) || !manifest.skillFiles.includes(forwardRel)) {
                decision = 'deny';
                reason = 'Reads in .agents only permitted for explicitly allowed skill files';
              } else {
                let ancSafe = true;
                let current = rootUsed;
                for (let i = 0; i < segs.length - 1; i++) {
                  current = path.join(current, segs[i]!);
                  try {
                    const st = await fsp.lstat(current);
                    if (st.isSymbolicLink() || !st.isDirectory()) {
                      ancSafe = false;
                      break;
                    }
                    const r = await fsp.realpath(current);
                    if (!isInside(manifest.canonicalCopyRoot, r)) {
                      ancSafe = false;
                      break;
                    }
                  } catch {
                    ancSafe = false;
                    break;
                  }
                }
                if (ancSafe) {
                  try {
                    const leafSt = await fsp.lstat(resolvedTarget);
                    if (leafSt.isSymbolicLink() || !leafSt.isFile() || leafSt.nlink !== 1) {
                      ancSafe = false;
                    } else {
                      const realLeaf = await fsp.realpath(resolvedTarget);
                      if (!isInside(manifest.canonicalCopyRoot, realLeaf)) {
                        ancSafe = false;
                      }
                    }
                  } catch {
                    ancSafe = false;
                  }
                }
                if (ancSafe) {
                  decision = 'allow';
                  reason = 'Skill file read permitted';
                } else {
                  decision = 'deny';
                  reason = 'Unsafe ancestry or non-regular file in skill path';
                }
              }
            }
          } else {
            let ancSafe = true;
            let current = rootUsed;
            for (let i = 0; i < segs.length - 1; i++) {
              current = path.join(current, segs[i]!);
              try {
                const st = await fsp.lstat(current);
                if (st.isSymbolicLink() || !st.isDirectory()) {
                  ancSafe = false;
                  break;
                }
                const r = await fsp.realpath(current);
                if (!isInside(manifest.canonicalCopyRoot, r) || canonicalProtected(r)) {
                  ancSafe = false;
                  break;
                }
              } catch (error) {
                if (toolName === 'write_to_file' && (error as NodeJS.ErrnoException).code === 'ENOENT') break;
                ancSafe = false;
                break;
              }
            }

            if (!ancSafe) {
              decision = 'deny';
              reason = 'Ancestry contains symlink or does not exist';
            } else {
              let leafSt = null;
              try {
                leafSt = await fsp.lstat(resolvedTarget);
              } catch {}

              if (toolName === 'view_file' || toolName === 'replace_file_content' || toolName === 'multi_replace_file_content') {
                if (!leafSt || leafSt.isSymbolicLink() || !leafSt.isFile() || leafSt.nlink !== 1) {
                  decision = 'deny';
                  reason = 'Target file must exist and be a regular file';
                } else {
                  try {
                    const realLeaf = await fsp.realpath(resolvedTarget);
                    if (!isInside(manifest.canonicalCopyRoot, realLeaf) || canonicalProtected(realLeaf)) {
                      decision = 'deny';
                      reason = 'Target file resolved outside canonical copy';
                    } else {
                      decision = 'allow';
                      reason = 'File access permitted';
                    }
                  } catch {
                    decision = 'deny';
                    reason = 'Failed to verify target file realpath';
                  }
                }
              } else if (toolName === 'write_to_file') {
                if (leafSt) {
                  if (leafSt.isSymbolicLink() || !leafSt.isFile() || leafSt.nlink !== 1) {
                    decision = 'deny';
                    reason = 'Target leaf cannot be a symlink or directory';
                  } else {
                    try {
                      const realLeaf = await fsp.realpath(resolvedTarget);
                      if (!isInside(manifest.canonicalCopyRoot, realLeaf) || canonicalProtected(realLeaf)) {
                        decision = 'deny';
                        reason = 'Target file resolved outside canonical copy';
                      } else {
                        decision = 'allow';
                        reason = 'Write to existing file permitted';
                      }
                    } catch {
                      decision = 'deny';
                      reason = 'Failed to verify target file realpath';
                    }
                  }
                } else {
                  decision = 'allow';
                  reason = 'New write leaf permitted through safe ancestry';
                }
              }
            }
          }
        }
      }
    }
  } else {
    decision = 'deny';
    reason = `Tool ${toolName} not permitted`;
  }

  // 7. Append to receipt
  const receiptEntry = JSON.stringify({
    executionId: manifest.executionId,
    policySha256: manifest.policy.sha256,
    conversationId,
    toolName: typeof toolName === 'string' ? toolName : 'unknown',
    decision,
  }) + '\n';
  const entryBytes = Buffer.byteLength(receiptEntry, 'utf8');

  let receiptOk = false;
  try {
    const statBefore = await fsp.lstat(manifest.receiptPath, { bigint: true });
    if (!statBefore.isSymbolicLink() && statBefore.isFile() && statBefore.nlink === 1n && statBefore.dev.toString() === manifest.receiptIdentity?.dev && statBefore.ino.toString() === manifest.receiptIdentity?.ino) {
      if (statBefore.size + BigInt(entryBytes) <= 1048576n) {
        const handle = await fsp.open(manifest.receiptPath, 'a');
        try {
          const statAfter = await handle.stat({ bigint: true });
          if (statAfter.isFile() && statAfter.nlink === 1n && statAfter.dev === statBefore.dev && statAfter.ino === statBefore.ino && statAfter.size + BigInt(entryBytes) <= 1048576n) {
            await handle.write(receiptEntry);
            receiptOk = true;
          }
        } finally {
          await handle.close();
        }
      }
    }
  } catch {}

  if (!receiptOk) {
    decision = 'deny';
    reason = 'Receipt write error or receipt size limit exceeded';
  }

  emitDecision(decision, reason);
}

export function generateHookSource(): string {
  return `(${hookMain.toString()})().catch(() => {
  console.log(JSON.stringify({ decision: 'deny', reason: 'Denied by execution policy' }));
  process.exit(0);
});\n`;
}

export async function stageExecutionPolicy(
  copyDirectory: string,
  setup: {
    policy: ResolvedAgentPolicy;
    catalog: McpCatalogEntry[];
    stateDirectory: string;
    executionId: string;
    skillFiles?: readonly string[];
  },
  remaining: ProjectLimits
): Promise<StagedExecutionPolicy> {
  resolvedAgentPolicySchema.parse(setup.policy);
  mcpCatalogSchema.parse(setup.catalog);
  const selectedDefinitions = setup.policy.mcpServers.map(server => setup.catalog.find(entry => entry.id === server.serverId));
  if (selectedDefinitions.some(entry => !entry) || crypto.createHash('sha256').update(JSON.stringify(selectedDefinitions)).digest('hex') !== setup.policy.catalogSha256) throw new BridgeError('AGENT_POLICY_CHANGED', 'Trusted MCP catalog changed after task admission');
  // Validate owned copy root: canonical parent equals os.tmpdir and basename starts agy-mcp-copy-, root nonlink
  const canonicalTmp = await fsp.realpath(os.tmpdir());
  const absoluteCopy = path.resolve(copyDirectory);
  const copyParent = path.dirname(absoluteCopy);
  const canonicalParent = await fsp.realpath(copyParent);

  if (!pathsEqual(canonicalTmp, canonicalParent) || !path.basename(absoluteCopy).startsWith('agy-mcp-copy-')) {
    throw new BridgeError('UNSAFE_PROJECT_PATH', 'copyDirectory must be an owned temporary copy directly under os.tmpdir()');
  }

  const copyInfo = await fsp.lstat(absoluteCopy).catch(() => undefined);
  if (!copyInfo || !copyInfo.isDirectory() || copyInfo.isSymbolicLink()) {
    throw new BridgeError('UNSAFE_PROJECT_PATH', 'copyDirectory must be an existing non-link directory');
  }

  const canonicalCopy = await fsp.realpath(absoluteCopy);
  if (!path.basename(canonicalCopy).startsWith('agy-mcp-copy-')) {
    throw new BridgeError('UNSAFE_PROJECT_PATH', 'canonical copyDirectory basename must start with agy-mcp-copy-');
  }

  // Validate stateDirectory: absolute, nonroot, nonlink, outside copy
  await assertNoLinkAncestry(setup.stateDirectory, 'stateDirectory');
  const resolvedState = path.resolve(setup.stateDirectory);
  const stateParsed = path.parse(resolvedState);
  if (resolvedState === stateParsed.root) {
    throw new BridgeError('UNSAFE_PROJECT_PATH', 'stateDirectory cannot be a volume root');
  }

  const stateInfo = await fsp.lstat(resolvedState).catch(() => undefined);
  if (stateInfo && (stateInfo.isSymbolicLink() || !stateInfo.isDirectory())) {
    throw new BridgeError('UNSAFE_PROJECT_PATH', 'stateDirectory cannot be a symlink or non-directory');
  }

  const canonicalState = stateInfo ? await fsp.realpath(resolvedState) : resolvedState;
  if (pathsEqual(canonicalState, stateParsed.root)) {
    throw new BridgeError('UNSAFE_PROJECT_PATH', 'canonical stateDirectory cannot be a root directory');
  }

  const relCopyState = path.relative(canonicalCopy, canonicalState);
  if (relCopyState === '' || (!relCopyState.startsWith('..') && !path.isAbsolute(relCopyState))) {
    throw new BridgeError('UNSAFE_PROJECT_PATH', 'stateDirectory cannot be inside copyDirectory');
  }
  const relStateCopy = path.relative(canonicalState, canonicalCopy);
  if (relStateCopy === '' || (!relStateCopy.startsWith('..') && !path.isAbsolute(relStateCopy))) {
    throw new BridgeError('UNSAFE_PROJECT_PATH', 'copyDirectory cannot be inside stateDirectory');
  }

  // Validate executionId UUID
  if (typeof setup.executionId !== 'string' || !UUID_REGEX.test(setup.executionId)) {
    throw new BridgeError('POLICY_NOT_ALLOWED', `Invalid executionId UUID: ${String(setup.executionId)}`);
  }

  validatePathFormat(copyDirectory, 'copyDirectory');
  // The native hook resolves node in its .agents working directory on Windows.
  for (const directory of [copyDirectory, path.join(copyDirectory, '.agents')]) {
    for (const name of ['node', 'node.exe', 'node.com', 'node.cmd', 'node.bat']) {
      if (await fsp.lstat(path.join(directory, name)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new BridgeError('CONFLICTING_EXECUTION_POLICY', 'Project cannot shadow the trusted hook runtime');
    }
  }
  // Reject conflicting existing 4 managed paths before writing anything
  for (const managedPath of EXECUTION_POLICY_PATHS) {
    const target = path.join(copyDirectory, managedPath);
    let stat;
    try {
      stat = await fsp.lstat(target);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw err;
    }
    if (stat) {
      throw new BridgeError('CONFLICTING_EXECUTION_POLICY', `Conflicting managed path exists: ${managedPath}`);
    }
  }

  // Validate .agents directory if it exists
  const agentsDir = path.join(copyDirectory, '.agents');
  try {
    const agentsStat = await fsp.lstat(agentsDir);
    if (agentsStat.isSymbolicLink()) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', '.agents cannot be a symlink or junction');
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  // Validate allowed skillFiles (strict relative paths only below .agents/skills/)
  const allowedSkillFiles: string[] = [];
  if (setup.skillFiles) {
    for (const sf of setup.skillFiles) {
      if (typeof sf !== 'string' || !sf) {
        throw new BridgeError('POLICY_NOT_ALLOWED', 'skillFiles items must be non-empty strings');
      }
      const normalized = sf.replaceAll('\\', '/');
      if (!normalized.startsWith('.agents/skills/') || normalized.includes('..')) {
        throw new BridgeError('POLICY_NOT_ALLOWED', `skillFiles must be strictly relative paths below .agents/skills/: ${sf}`);
      }
      const parts = normalized.split('/');
      if (parts.some((p) => !p || p === '.' || p === '..')) {
        throw new BridgeError('POLICY_NOT_ALLOWED', `Invalid skillFile path: ${sf}`);
      }
      for (const part of parts) {
        if (isWindowsDeviceName(part) || /[. ]$/.test(part) || /[\x00-\x1f]/.test(part)) {
          throw new BridgeError('POLICY_NOT_ALLOWED', `Invalid skillFile path characters: ${sf}`);
        }
      }
      allowedSkillFiles.push(normalized);
    }
  }

  // Prepare private receipt file
  const receiptsDir = path.join(canonicalState, 'execution-receipts');
  await fsp.mkdir(receiptsDir, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(receiptsDir, `${setup.executionId}.jsonl`);
  await assertNoLinkAncestry(receiptPath, 'receiptPath');

  const createdFiles: string[] = [];
  let receiptIdentity!: { dev: string; ino: string };

  try {
    // Create receipt file exclusively (flag 'wx')
    try {
      const handle = await fsp.open(receiptPath, 'wx', 0o600);
      try { const stat = await handle.stat({ bigint: true }); receiptIdentity = { dev: stat.dev.toString(), ino: stat.ino.toString() }; } finally { await handle.close(); }
      createdFiles.push(receiptPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new BridgeError('RECEIPT_COLLISION', `Preexisting receipt file: ${receiptPath}`);
      }
      throw err;
    }

    // Build hooks.json
    const hooksJsonContent = JSON.stringify(
      {
        'bridge-execution-hook': {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command: 'node bridge-execution-hook.mjs',
                  timeout: 10,
                },
              ],
            },
          ],
        },
      },
      null,
      2
    ) + '\n';

    // Build hook script
    const hookScriptContent = generateHookSource();
    const hookScriptSha256 = crypto
      .createHash('sha256')
      .update(hookScriptContent, 'utf8')
      .digest('hex');

    // Build manifest JSON
    const manifestPayload = {
      version: 1,
      policy: setup.policy,
      originalCopyRoot: copyDirectory,
      canonicalCopyRoot: canonicalCopy,
      executionId: setup.executionId,
      receiptPath,
      receiptIdentity,
      skillFiles: allowedSkillFiles,
      hookSha256: hookScriptSha256,
    };
    const manifestContent = JSON.stringify(manifestPayload, null, 2) + '\n';

    // Build MCP config
    const mcpConfig: Record<string, unknown> = {};
    for (const server of setup.policy.mcpServers) {
      const entry = setup.catalog.find((c) => c.id === server.serverId);
      if (!entry) {
        throw new BridgeError('POLICY_NOT_ALLOWED', `MCP server '${server.serverId}' not found in catalog`);
      }
      const serverConfig: Record<string, unknown> = {};
      if (entry.command !== undefined) {
        serverConfig.command = entry.command;
        if (entry.args !== undefined) serverConfig.args = entry.args;
        if (entry.env !== undefined) serverConfig.env = entry.env;
        if (entry.cwd !== undefined) serverConfig.cwd = entry.cwd;
      } else if (entry.serverUrl !== undefined) {
        serverConfig.serverUrl = entry.serverUrl;
        if (entry.headers !== undefined) serverConfig.headers = entry.headers;
      }
      const selectedToolSet = new Set(server.tools);
      const disabledTools = entry.tools
        .map((t) => t.name)
        .filter((t) => !selectedToolSet.has(t));
      if (disabledTools.length > 0) {
        serverConfig.disabledTools = disabledTools;
      }
      mcpConfig[server.serverName] = serverConfig;
    }
    const mcpConfigContent = JSON.stringify({ mcpServers: mcpConfig }, null, 2) + '\n';

    // Sum exact UTF8 helper bytes/file count against remaining limits
    const fileCount = 4;
    if (fileCount > remaining.maxCopyFiles) {
      throw new BridgeError('COPY_LIMIT_EXCEEDED', `Staging requires ${fileCount} files, but remaining limit is ${remaining.maxCopyFiles}`);
    }

    const hooksBytes = Buffer.byteLength(hooksJsonContent, 'utf8');
    const hookScriptBytes = Buffer.byteLength(hookScriptContent, 'utf8');
    const manifestBytes = Buffer.byteLength(manifestContent, 'utf8');
    const mcpConfigBytes = Buffer.byteLength(mcpConfigContent, 'utf8');
    const totalBytes = hooksBytes + hookScriptBytes + manifestBytes + mcpConfigBytes;

    if (totalBytes > remaining.maxCopyBytes) {
      throw new BridgeError('COPY_LIMIT_EXCEEDED', `Staging requires ${totalBytes} bytes, but remaining limit is ${remaining.maxCopyBytes}`);
    }

    // Write helper files
    await fsp.mkdir(agentsDir, { recursive: true, mode: 0o700 });

    const hooksPath = path.join(copyDirectory, '.agents', 'hooks.json');
    await fsp.writeFile(hooksPath, hooksJsonContent, { flag: 'wx', mode: 0o600 });
    createdFiles.push(hooksPath);

    const hookScriptPath = path.join(copyDirectory, '.agents', 'bridge-execution-hook.mjs');
    await fsp.writeFile(hookScriptPath, hookScriptContent, { flag: 'wx', mode: 0o600 });
    createdFiles.push(hookScriptPath);

    const manifestPath = path.join(copyDirectory, '.agents', 'bridge-execution-policy.json');
    await fsp.writeFile(manifestPath, manifestContent, { flag: 'wx', mode: 0o600 });
    createdFiles.push(manifestPath);

    const mcpConfigPath = path.join(copyDirectory, '.agents', 'mcp_config.json');
    await fsp.writeFile(mcpConfigPath, mcpConfigContent, { flag: 'wx', mode: 0o600 });
    createdFiles.push(mcpConfigPath);
    if (process.platform === 'win32') {
      // The LPAC controller skips existing children with protected DACLs.
      // Preserve the host user's ACL while keeping helper credentials out of tests.
      await promisify(execFile)(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [mcpConfigPath, '/inheritance:d'], { windowsHide: true, timeout: 10000, maxBuffer: 8192 });
    }

    const hooksSha256 = crypto.createHash('sha256').update(hooksJsonContent, 'utf8').digest('hex');
    const manifestSha256 = crypto.createHash('sha256').update(manifestContent, 'utf8').digest('hex');
    const mcpConfigSha256 = crypto.createHash('sha256').update(mcpConfigContent, 'utf8').digest('hex');

    const files = [
      { path: '.agents/hooks.json', sha256: hooksSha256, bytes: hooksBytes },
      { path: '.agents/bridge-execution-hook.mjs', sha256: hookScriptSha256, bytes: hookScriptBytes },
      { path: '.agents/bridge-execution-policy.json', sha256: manifestSha256, bytes: manifestBytes },
      { path: '.agents/mcp_config.json', sha256: mcpConfigSha256, bytes: mcpConfigBytes },
    ];

    const perms: string[] = [];
    for (const server of setup.policy.mcpServers) {
      for (const tool of server.tools) {
        perms.push(`mcp(${server.serverName}/${tool})`);
      }
    }
    const requiredNativePermissions = [...new Set(perms)].sort();

    const staged: StagedExecutionPolicy = {
      policy: setup.policy,
      executionId: setup.executionId,
      receiptPath,
      receiptIdentity,
      files,
      requiredNativePermissions,
    };

    return stagedExecutionPolicySchema.parse(staged);
  } catch (error) {
    let cleanupFailed = false;
    for (const created of createdFiles) {
      try {
        await assertNoLinkAncestry(created, 'created helper');
        const relative = path.relative(canonicalCopy, created);
        if (created !== receiptPath && (!relative || relative.startsWith('..') || path.isAbsolute(relative))) throw new Error('Unsafe helper cleanup');
        await fsp.rm(created, { force: true });
      } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw new BridgeError('EXECUTION_POLICY_CLEANUP_FAILED', 'Staging failed and helper cleanup could not be verified');
    throw error;
  }
}

export async function verifyExecutionPolicy(
  copyDirectory: string,
  staged: StagedExecutionPolicy,
  stateDirectory: string
): Promise<void> {
  const parsedStaged = stagedExecutionPolicySchema.safeParse(staged);
  if (!parsedStaged.success) {
    throw new BridgeError('EXECUTION_POLICY_VERIFICATION_FAILED', `Invalid staged execution policy metadata: ${parsedStaged.error.message}`);
  }

  await assertNoLinkAncestry(copyDirectory, 'copyDirectory');
  await assertNoLinkAncestry(stateDirectory, 'stateDirectory');
  // Validate copy directory
  const copyInfo = await fsp.lstat(copyDirectory).catch(() => undefined);
  if (!copyInfo || !copyInfo.isDirectory() || copyInfo.isSymbolicLink()) {
    throw new BridgeError('EXECUTION_POLICY_VERIFICATION_FAILED', 'copyDirectory must be a non-link directory');
  }

  // Validate state directory and receipt path boundary
  const stateInfo = await fsp.lstat(stateDirectory).catch(() => undefined);
  if (!stateInfo || !stateInfo.isDirectory() || stateInfo.isSymbolicLink()) {
    throw new BridgeError('EXECUTION_POLICY_VERIFICATION_FAILED', 'stateDirectory must be a non-link directory');
  }
  const canonicalState = await fsp.realpath(stateDirectory);
  const expectedReceiptPath = path.join(canonicalState, 'execution-receipts', `${staged.executionId}.jsonl`);
  if (!pathsEqual(staged.receiptPath, expectedReceiptPath)) {
    throw new BridgeError('EXECUTION_POLICY_VERIFICATION_FAILED', 'Receipt path boundary mismatch');
  }

  // Receipt must exist and be regular non-link file
  await assertNoLinkAncestry(staged.receiptPath, 'receiptPath');
  const identity = await fsp.lstat(staged.receiptPath, { bigint: true });
  if (identity.nlink !== 1n || identity.dev.toString() !== staged.receiptIdentity.dev || identity.ino.toString() !== staged.receiptIdentity.ino) throw new BridgeError('EXECUTION_POLICY_VERIFICATION_FAILED', 'Private receipt file identity changed');
  const receiptStat = await fsp.lstat(staged.receiptPath).catch(() => undefined);
  if (!receiptStat || receiptStat.isSymbolicLink() || !receiptStat.isFile()) {
    throw new BridgeError('EXECUTION_POLICY_VERIFICATION_FAILED', 'Receipt file is missing or not a regular file');
  }

  // Check actual 4 regular files in copyDirectory
  for (const file of staged.files) {
    const fullPath = path.join(copyDirectory, file.path);
    await assertNoLinkAncestry(fullPath, 'managed helper');
    const stat = await fsp.lstat(fullPath).catch(() => undefined);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      throw new BridgeError('EXECUTION_POLICY_VERIFICATION_FAILED', `Managed helper is missing or not a regular file: ${file.path}`);
    }
    if (stat.size !== file.bytes) {
      throw new BridgeError('EXECUTION_POLICY_VERIFICATION_FAILED', `File size mismatch for ${file.path}: expected ${file.bytes}, got ${stat.size}`);
    }
    const content = await fsp.readFile(fullPath);
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    if (sha256 !== file.sha256) {
      throw new BridgeError('EXECUTION_POLICY_VERIFICATION_FAILED', `File hash mismatch for ${file.path}`);
    }
  }

  // Cross-check manifest content
  const manifestPath = path.join(copyDirectory, '.agents', 'bridge-execution-policy.json');
  let manifest: any;
  try {
    const raw = await fsp.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch {
    throw new BridgeError('EXECUTION_POLICY_VERIFICATION_FAILED', 'Failed to read or parse bridge-execution-policy.json');
  }

  if (
    manifest.version !== 1 ||
    manifest.executionId !== staged.executionId ||
    manifest.policy?.sha256 !== staged.policy.sha256 ||
    !pathsEqual(manifest.receiptPath, staged.receiptPath)
  ) {
    throw new BridgeError('EXECUTION_POLICY_VERIFICATION_FAILED', 'Manifest content mismatch with staged policy');
  }
}

export async function readExecutionPolicyReceipt(
  staged: StagedExecutionPolicy,
  stateDirectory: string,
  offset = 0,
  conversationId?: string
): Promise<{
  offset: number;
  nextOffset: number;
  sha256: string;
  guardedFinish: boolean;
  decisionCount: number;
  deniedCount: number;
}> {
  const parsedStaged = stagedExecutionPolicySchema.safeParse(staged);
  if (!parsedStaged.success) {
    throw new BridgeError('INVALID_RECEIPT', `Invalid staged execution policy metadata: ${parsedStaged.error.message}`);
  }

  // Validate stateDirectory
  const stateInfo = await fsp.lstat(stateDirectory).catch(() => undefined);
  if (!stateInfo || !stateInfo.isDirectory() || stateInfo.isSymbolicLink()) {
    throw new BridgeError('INVALID_RECEIPT', 'stateDirectory must be an existing non-link directory');
  }
  const canonicalState = await fsp.realpath(stateDirectory);
  const expectedReceiptPath = path.join(canonicalState, 'execution-receipts', `${staged.executionId}.jsonl`);
  if (!pathsEqual(staged.receiptPath, expectedReceiptPath)) {
    throw new BridgeError('INVALID_RECEIPT', 'Receipt path does not match stateDirectory and executionId');
  }

  await assertNoLinkAncestry(staged.receiptPath, 'receiptPath');
  const identity = await fsp.lstat(staged.receiptPath, { bigint: true });
  if (identity.nlink !== 1n || identity.dev.toString() !== staged.receiptIdentity.dev || identity.ino.toString() !== staged.receiptIdentity.ino) throw new BridgeError('INVALID_RECEIPT', 'Private receipt file identity changed');
  // Validate receipt file
  const receiptStat = await fsp.lstat(staged.receiptPath).catch(() => undefined);
  if (!receiptStat || receiptStat.isSymbolicLink() || !receiptStat.isFile()) {
    throw new BridgeError('INVALID_RECEIPT', 'Receipt file is missing or not a regular file');
  }
  if (receiptStat.size > 1024 * 1024) {
    throw new BridgeError('RECEIPT_LIMIT_EXCEEDED', 'Receipt file exceeds 1MiB');
  }

  // Validate offset
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > receiptStat.size) {
    throw new BridgeError('INVALID_RECEIPT_OFFSET', `Invalid receipt offset: ${offset}`);
  }

  if (receiptStat.size === 0) {
    const emptyBuf = Buffer.alloc(0);
    const sha256 = crypto.createHash('sha256').update(emptyBuf).digest('hex');
    return {
      offset: 0,
      nextOffset: 0,
      sha256,
      guardedFinish: false,
      decisionCount: 0,
      deniedCount: 0,
    };
  }

  const handle = await fsp.open(staged.receiptPath, 'r');
  let fullBuffer: Buffer;
  try {
    const stat = await handle.stat({ bigint: true });
    if (stat.dev !== identity.dev || stat.ino !== identity.ino || stat.size > 1048576n) throw new BridgeError('INVALID_RECEIPT', 'Private receipt changed before reading');
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    let length = 0;
    while (length < buffer.length) { const part = await handle.read(buffer, length, buffer.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
    fullBuffer = buffer.subarray(0, length);
  } finally { await handle.close(); }
  if (fullBuffer.length !== receiptStat.size) {
    throw new BridgeError('INVALID_RECEIPT', 'Receipt file size changed during read');
  }

  if (offset > 0 && fullBuffer[offset - 1] !== 0x0A) {
    throw new BridgeError('INVALID_RECEIPT_OFFSET', `Offset ${offset} is not at a line boundary`);
  }

  const windowBuffer = fullBuffer.subarray(offset);
  const sha256 = crypto.createHash('sha256').update(windowBuffer).digest('hex');

  if (windowBuffer.length === 0) {
    return {
      offset,
      nextOffset: receiptStat.size,
      sha256,
      guardedFinish: false,
      decisionCount: 0,
      deniedCount: 0,
    };
  }

  const windowText = windowBuffer.toString('utf8');
  if (!windowText.endsWith('\n')) {
    throw new BridgeError('INVALID_RECEIPT', 'Receipt window does not terminate with newline');
  }

  const lines = windowText.split('\n').slice(0, -1);
  let decisionCount = 0;
  let deniedCount = 0;
  let guardedFinish = false;

  for (const line of lines) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new BridgeError('INVALID_RECEIPT', 'Malformed JSON line in receipt');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).sort().join(',') !== 'conversationId,decision,executionId,policySha256,toolName' || (parsed.conversationId !== null && (typeof parsed.conversationId !== 'string' || parsed.conversationId.length > 128)) || typeof parsed.toolName !== 'string' || parsed.toolName.length > 128) {
      throw new BridgeError('INVALID_RECEIPT', 'Invalid receipt line structure');
    }
    if (parsed.executionId !== staged.executionId) {
      throw new BridgeError('INVALID_RECEIPT', `executionId mismatch in receipt line: expected ${staged.executionId}, got ${String(parsed.executionId)}`);
    }
    if (parsed.policySha256 !== staged.policy.sha256) {
      throw new BridgeError('INVALID_RECEIPT', `policySha256 mismatch in receipt line: expected ${staged.policy.sha256}, got ${String(parsed.policySha256)}`);
    }
    if (parsed.decision !== 'allow' && parsed.decision !== 'deny') {
      throw new BridgeError('INVALID_RECEIPT', `Invalid decision value in receipt line: ${String(parsed.decision)}`);
    }

    if (conversationId !== undefined && parsed.conversationId !== conversationId) {
      continue;
    }

    decisionCount++;
    if (parsed.decision === 'deny') {
      deniedCount++;
    }
    if (parsed.toolName === 'finish' && parsed.decision === 'allow') {
      guardedFinish = true;
    }
  }

  return {
    offset,
    nextOffset: receiptStat.size,
    sha256,
    guardedFinish,
    decisionCount,
    deniedCount,
  };
}


export async function discardExecutionPolicy(staged: StagedExecutionPolicy, stateDirectory: string): Promise<void> {
  stagedExecutionPolicySchema.parse(staged);
  await assertNoLinkAncestry(stateDirectory, 'stateDirectory');
  const state = await fsp.realpath(stateDirectory);
  const expected = path.join(state, 'execution-receipts', staged.executionId + '.jsonl');
  if (!pathsEqual(expected, staged.receiptPath)) throw new BridgeError('INVALID_RECEIPT', 'Private receipt cleanup boundary mismatch');
  await assertNoLinkAncestry(expected, 'receiptPath');
  let identity;
  try { identity = await fsp.lstat(expected, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1n || identity.dev.toString() !== staged.receiptIdentity.dev || identity.ino.toString() !== staged.receiptIdentity.ino) throw new BridgeError('INVALID_RECEIPT', 'Refusing to delete a replaced private receipt');
  await fsp.unlink(expected);
}
