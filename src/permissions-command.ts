import { TOOL_ANNOTATIONS } from './tool-annotations.js';
import { toolEnabled, toolProfileSchema, type ToolProfile } from './tool-profiles.js';

export const PERMISSION_HOSTS = ['claude-code', 'codex'] as const;
export type PermissionHost = (typeof PERMISSION_HOSTS)[number];

export const PERMISSION_PRESETS = ['connector', 'delegation'] as const;
export type PermissionPreset = (typeof PERMISSION_PRESETS)[number];

// The delegation preset asks before tools that change the original project, delete copies or memory, change the sandbox policy, or stop work; every other tool acts only on the copy or the bridge state.
export const DELEGATION_ASK_TOOLS: ReadonlySet<string> = new Set([
  'black_gravity_integrate',
  'black_gravity_discard',
  'black_gravity_cleanup',
  'black_gravity_memory_remove',
  'black_gravity_set_sandbox_policy',
  'black_gravity_cancel',
  'black_gravity_group_cancel',
]);

export interface PermissionPlan {
  allow: string[];
  ask: string[];
  deny: string[];
}

export function permissionPlan(
  preset: PermissionPreset,
  profile: ToolProfile,
  deny: readonly string[],
): PermissionPlan {
  const plan: PermissionPlan = { allow: [], ask: [], deny: [] };
  const denySet = new Set(deny);

  for (const name of Object.keys(TOOL_ANNOTATIONS)) {
    if (!toolEnabled(profile, name)) {
      continue;
    }
    if (denySet.has(name)) {
      plan.deny.push(name);
    } else if (preset === 'connector') {
      if (TOOL_ANNOTATIONS[name]!.readOnlyHint) {
        plan.allow.push(name);
      } else {
        plan.ask.push(name);
      }
    } else if (DELEGATION_ASK_TOOLS.has(name)) {
      plan.ask.push(name);
    } else {
      plan.allow.push(name);
    }
  }

  return plan;
}

export function renderClaudeCode(plan: PermissionPlan, serverName: string): string {
  return (
    JSON.stringify(
      {
        permissions: {
          allow: plan.allow.map(tool => `mcp__${serverName}__${tool}`),
          ask: plan.ask.map(tool => `mcp__${serverName}__${tool}`),
          deny: plan.deny.map(tool => `mcp__${serverName}__${tool}`),
        },
      },
      null,
      2,
    ) + '\n'
  );
}

export function renderCodex(plan: PermissionPlan, serverName: string): string {
  const blocks: string[] = [];

  if (plan.deny.length > 0) {
    const disabled = plan.deny.map(tool => JSON.stringify(tool)).join(', ');
    blocks.push(`[mcp_servers.${serverName}]\ndisabled_tools = [${disabled}]`);
  }

  const allowSet = new Set(plan.allow);
  const askSet = new Set(plan.ask);

  for (const tool of Object.keys(TOOL_ANNOTATIONS)) {
    if (allowSet.has(tool)) {
      blocks.push(`[mcp_servers.${serverName}.tools.${tool}]\napproval_mode = "approve"`);
    } else if (askSet.has(tool)) {
      blocks.push(`[mcp_servers.${serverName}.tools.${tool}]\napproval_mode = "prompt"`);
    }
  }

  return blocks.join('\n\n') + '\n';
}

const SERVER_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function runPermissionsCommand(
  args: readonly string[],
  write: (text: string) => void,
  writeError: (text: string) => void,
): number {
  function refuse(message: string): number {
    writeError(`black-gravity permissions: ${message}\n`);
    return 2;
  }

  const singularOptions: Record<string, string | undefined> = {
    '--host': undefined,
    '--preset': undefined,
    '--profile': undefined,
    '--server-name': undefined,
  };
  const denyRaw: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === '--help' || arg === '-h') {
      if (args.length === 1) {
        write(
          'Usage: black-gravity permissions --host <claude-code|codex> [options]\n\n' +
          'Prints a host permission block generated from the tool annotations table.\n' +
          'This command only prints to stdout and never writes any file.\n\n' +
          'Options:\n' +
          '  --host <claude-code|codex>                     Target host format (required)\n' +
          '  --preset <connector|delegation>                Permission preset (default: connector)\n' +
          '  --profile <full|query|review|implementation>   Tool profile (default: full)\n' +
          '  --server-name <name>                           MCP server name (default: black-gravity)\n' +
          '  --deny <tool>                                  Deny a tool (repeatable)\n' +
          '  -h, --help                                     Show this help message\n',
        );
        return 0;
      }
      return refuse('Option --help cannot be combined with other arguments');
    }

    if (Object.hasOwn(singularOptions, arg)) {
      if (singularOptions[arg] !== undefined) {
        return refuse(`Option ${arg} cannot be specified more than once`);
      }
      i++;
      if (i >= args.length) {
        return refuse(`Option ${arg} requires a value`);
      }
      singularOptions[arg] = args[i]!;
    } else if (arg === '--deny') {
      i++;
      if (i >= args.length) {
        return refuse('Option --deny requires a value');
      }
      denyRaw.push(args[i]!);
    } else if (arg.startsWith('-')) {
      return refuse(`Unknown option: ${arg}`);
    } else {
      return refuse(`Unexpected positional argument: ${arg}`);
    }
    i++;
  }

  const host = singularOptions['--host'];
  if (host === undefined) {
    return refuse('Missing required option --host');
  }

  if (!(PERMISSION_HOSTS as readonly string[]).includes(host)) {
    return refuse(`Invalid host: ${host}. Expected one of: ${PERMISSION_HOSTS.join(', ')}`);
  }
  const effectiveHost = host as PermissionHost;

  const preset = singularOptions['--preset'];
  if (preset !== undefined && !(PERMISSION_PRESETS as readonly string[]).includes(preset)) {
    return refuse(`Invalid preset: ${preset}. Expected one of: ${PERMISSION_PRESETS.join(', ')}`);
  }
  const effectivePreset: PermissionPreset = (preset as PermissionPreset | undefined) ?? 'connector';

  const profile = singularOptions['--profile'];
  const effectiveProfileString = profile ?? 'full';
  const profileParsed = toolProfileSchema.safeParse(effectiveProfileString);
  if (!profileParsed.success) {
    return refuse(`Invalid profile: ${effectiveProfileString}. Expected one of: full, query, review, implementation`);
  }
  const effectiveProfile: ToolProfile = profileParsed.data;

  const serverName = singularOptions['--server-name'];
  const effectiveServerName = serverName ?? 'black-gravity';
  if (!SERVER_NAME_REGEX.test(effectiveServerName)) {
    return refuse(`Invalid server name: ${effectiveServerName}. Must match ${SERVER_NAME_REGEX}`);
  }

  const expectedPrefix = `mcp__${effectiveServerName}__`;
  const dedupedDenyTools: string[] = [];
  const seenDeny = new Set<string>();

  for (const raw of denyRaw) {
    let toolName = raw;
    if (raw.startsWith('mcp__')) {
      if (!raw.startsWith(expectedPrefix)) {
        const match = raw.match(/^(mcp__.*?__)/);
        const prefixFound = match ? match[1]! : raw;
        return refuse(`Invalid deny prefix: found "${prefixFound}", expected "${expectedPrefix}"`);
      }
      toolName = raw.slice(expectedPrefix.length);
    }

    if (!Object.hasOwn(TOOL_ANNOTATIONS, toolName)) {
      return refuse(`Unknown tool "${toolName}"`);
    }

    if (!toolEnabled(effectiveProfile, toolName)) {
      return refuse(`Tool "${toolName}" is not available in the "${effectiveProfile}" profile`);
    }

    if (!seenDeny.has(toolName)) {
      seenDeny.add(toolName);
      dedupedDenyTools.push(toolName);
    }
  }

  const plan = permissionPlan(effectivePreset, effectiveProfile, dedupedDenyTools);
  const rendered = effectiveHost === 'claude-code'
    ? renderClaudeCode(plan, effectiveServerName)
    : renderCodex(plan, effectiveServerName);

  write(rendered);
  return 0;
}
