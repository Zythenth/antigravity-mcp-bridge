import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { checkedPath } from './isolation.js';
import { BridgeError, type RunOptions } from './types.js';
import { nativeToolsSchema, mcpSelectionSchema, type AgentPolicySelection } from './agent-policy.js';
import { deliveryModeSchema, type DeliveryMode } from './messages.js';
import { providedSkillsSchema, MAX_TOTAL_BUNDLES_BYTES, isWindowsDeviceName, type ProvidedSkill } from './skills.js';
import { artifactPathsSchema } from './artifacts.js';
import { validateOutputSchema } from './structured-results.js';

export function validIncludePath(input: string): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new BridgeError('INVALID_INCLUDE_PATH', 'Include path cannot be empty');
  }
  if (input.includes(':')) {
    throw new BridgeError('INVALID_INCLUDE_PATH', 'Colon and Alternate Data Streams are forbidden: ' + input);
  }
  if (/[\x00-\x1f\x7f]/.test(input)) {
    throw new BridgeError('INVALID_INCLUDE_PATH', 'Control characters and NUL are forbidden: ' + input);
  }
  const value = input.replaceAll('\\', '/').replace(/\/+$/, '');
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(input) || /^(?:\\\\|\/\/|\\\\\?\\)/.test(input)) {
    throw new BridgeError('INVALID_INCLUDE_PATH', 'Include path must be a relative project path: ' + input);
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new BridgeError('INVALID_INCLUDE_PATH', 'Include path cannot contain empty segments or traversal elements (. or ..): ' + input);
  }
  for (const part of parts) {
    if (/[. ]$/.test(part)) {
      throw new BridgeError('INVALID_INCLUDE_PATH', 'Path segment cannot end with a dot or space: ' + input);
    }
    if (/[<>"|?*]/.test(part)) {
      throw new BridgeError('INVALID_INCLUDE_PATH', 'Invalid path characters in segment: ' + input);
    }
    if (isWindowsDeviceName(part)) {
      throw new BridgeError('INVALID_INCLUDE_PATH', 'Include path cannot contain Windows device name: ' + input);
    }
    if (part.toLowerCase() === '.git') {
      throw new BridgeError('UNSAFE_INCLUDE_PATH', 'Include path cannot contain .git components: ' + input);
    }
    if (part.toLowerCase() === '.agents') {
      throw new BridgeError('UNSAFE_INCLUDE_PATH', 'Include path cannot contain .agents components: ' + input);
    }
  }
  return value;
}

export const includePathSchema = z.string()
  .min(1)
  .max(1000)
  .refine(val => {
    try {
      validIncludePath(val);
      return true;
    } catch {
      return false;
    }
  }, 'includePaths must contain bounded relative project paths');

export const includePathsSchema = z.array(includePathSchema)
  .min(1)
  .max(100)
  .refine(paths => {
    try {
      const normalizedLower = paths.map(p => validIncludePath(p).toLowerCase());
      return new Set(normalizedLower).size === paths.length;
    } catch {
      return false;
    }
  }, 'includePaths must be unique (including case aliases)');

function computeSkillBundlesBytes(skills: readonly ProvidedSkill[]): number {
  return skills.reduce(
    (sum, skill) =>
      sum +
      Buffer.byteLength(skill.content, 'utf8') +
      (skill.resources ?? []).reduce((n, file) => n + Buffer.byteLength(file.content, 'utf8'), 0),
    0
  );
}

export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof effortSchema>;

export const profileSkillsSchema = z.lazy(() => providedSkillsSchema
  .refine(
    skills => computeSkillBundlesBytes(skills) <= MAX_TOTAL_BUNDLES_BYTES,
    'Supplied skills exceed the 1 MiB text budget'
  )
  .refine(
    skills => new Set(skills.map(s => s.name.toLowerCase())).size === skills.length,
    'Skill names must be unique'
  ));

export const profileOutputSchema = z.record(z.string(), z.unknown())
  .superRefine((schema, ctx) => {
    try {
      validateOutputSchema(schema);
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

export const profileDefaultsSchema = z.object({
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).nullable().optional(),
  effort: effortSchema.optional(),
  allowedTools: nativeToolsSchema.optional(),
  mcpServers: mcpSelectionSchema.optional(),
  skills: profileSkillsSchema.optional(),
  includePaths: includePathsSchema.optional(),
  outputSchema: profileOutputSchema.optional(),
  artifactPaths: z.lazy(() => artifactPathsSchema).optional(),
  deliveryMode: deliveryModeSchema.optional(),
  timeoutSeconds: z.number().int().min(1).max(86400).optional(),
}).strict();

export type RoleDefaults = z.infer<typeof profileDefaultsSchema>;

export const builtinRoleSchema = z.enum(['implementer', 'planner', 'reviewer']);
export type BuiltinRole = z.infer<typeof builtinRoleSchema>;
export const roleSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export type TaskRole = z.infer<typeof roleSchema>;

export const roleDefinitionSchema = z.object({
  name: roleSchema,
  baseRole: builtinRoleSchema,
  instruction: z.string().max(8000),
  description: z.string().min(1).max(500).optional(),
  defaults: profileDefaultsSchema.optional(),
}).strict().superRefine((role, ctx) => {
  if (role.baseRole !== 'implementer' && role.defaults?.outputSchema !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'Roles based on planner and reviewer cannot configure custom outputSchema',
      path: ['defaults', 'outputSchema'],
    });
  }
});

export type RoleDefinition = z.infer<typeof roleDefinitionSchema>;

export const customRolesSchema = z.array(roleDefinitionSchema.refine(role => !builtinRoleSchema.safeParse(role.name).success && Boolean(role.instruction.trim()),
  'Custom roles cannot replace built-in names and require instructions')).max(20)
  .refine(roles => new Set(roles.map(role => role.name)).size === roles.length, 'Custom role names must be unique');

const builtinDefinitions: RoleDefinition[] = [
  { name: 'implementer', baseRole: 'implementer', instruction: '', description: 'Implement requested changes in the isolated copy.' },
  { name: 'planner', baseRole: 'planner', instruction: '', description: 'Plan requested work in read-only mode with a structured report.' },
  { name: 'reviewer', baseRole: 'reviewer', instruction: '', description: 'Review files in read-only mode with checked citations.' },
];

/**
 * Computes SHA-256 hash of the exact JSON schema serialization.
 * Used by listRoles to expose compact catalog metadata without leaking full schema content.
 */
export function hashJsonSchema(schema: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}

/**
 * Computes SHA-256 hash of the exact skill bundle JSON serialization.
 * Used by listRoles to expose compact catalog metadata without leaking full skill content.
 */
export function hashSkillBundle(skill: ProvidedSkill): string {
  return createHash('sha256').update(JSON.stringify(skill)).digest('hex');
}

export interface RoleListing {
  name: TaskRole;
  baseRole: BuiltinRole;
  description: string | null;
  custom: boolean;
  instructionChars: number;
  defaultModel?: string | null;
  defaultEffort?: Effort;
  defaultTimeoutSeconds?: number;
  defaultDeliveryMode?: DeliveryMode;
  defaultIncludePaths?: string[];
  defaultArtifactPaths?: string[];
  defaultAllowedTools?: AgentPolicySelection['allowedTools'];
  defaultMcpServers?: AgentPolicySelection['mcpServers'];
  defaultSkillSummaries?: Array<{ name: string; sha256: string; resourceCount: number }>;
  outputSchemaSha256?: string;
}

export function resolveRole(name: string, customRoles: RoleDefinition[] = []): RoleDefinition {
  const role = [...builtinDefinitions, ...customRoles].find(role => role.name === name);
  if (!role) throw new BridgeError('INVALID_ROLE', 'Role is not configured: ' + name);
  return {
    ...role,
    ...(role.defaults !== undefined ? { defaults: structuredClone(role.defaults) } : {}),
  };
}

export function listRoles(customRoles: RoleDefinition[] = []): RoleListing[] {
  return [...builtinDefinitions, ...customRoles].map(role => {
    const listing: RoleListing = {
      name: role.name,
      baseRole: role.baseRole,
      description: role.description ?? null,
      custom: !builtinRoleSchema.safeParse(role.name).success,
      instructionChars: role.instruction.length,
    };
    if (role.defaults) {
      if (role.defaults.allowedTools !== undefined) listing.defaultAllowedTools = structuredClone(role.defaults.allowedTools);
      if (role.defaults.mcpServers !== undefined) listing.defaultMcpServers = structuredClone(role.defaults.mcpServers);
      if (role.defaults.model !== undefined) {
        listing.defaultModel = role.defaults.model;
      }
      if (role.defaults.effort !== undefined) {
        listing.defaultEffort = role.defaults.effort;
      }
      if (role.defaults.timeoutSeconds !== undefined) {
        listing.defaultTimeoutSeconds = role.defaults.timeoutSeconds;
      }
      if (role.defaults.deliveryMode !== undefined) {
        listing.defaultDeliveryMode = role.defaults.deliveryMode;
      }
      if (role.defaults.includePaths !== undefined) {
        listing.defaultIncludePaths = [...role.defaults.includePaths];
      }
      if (role.defaults.artifactPaths !== undefined) {
        listing.defaultArtifactPaths = [...role.defaults.artifactPaths];
      }
      if (role.defaults.skills !== undefined) {
        listing.defaultSkillSummaries = role.defaults.skills.map(skill => ({
          name: skill.name,
          sha256: hashSkillBundle(skill),
          resourceCount: skill.resources?.length ?? 0,
        }));
      }
      if (role.defaults.outputSchema !== undefined) {
        listing.outputSchemaSha256 = hashJsonSchema(role.defaults.outputSchema);
      }
    }
    return listing;
  });
}

export function applyRoleDefaults(options: RunOptions, definition: RoleDefinition): RunOptions {
  if (definition.baseRole !== 'implementer' && (options.outputSchema !== undefined || definition.defaults?.outputSchema !== undefined)) {
    throw new BridgeError('INVALID_ROLE', 'Structured output schema requires an implementer base role');
  }
  const result = structuredClone(options);
  for (const key of ['model', 'effort', 'skills', 'includePaths', 'outputSchema', 'artifactPaths', 'deliveryMode', 'timeoutSeconds', 'allowedTools', 'mcpServers'] as const) {
    if (result[key] === undefined && definition.defaults?.[key] !== undefined) {
      Object.assign(result, { [key]: structuredClone(definition.defaults[key]) });
    }
  }
  return result;
}

export const plannerReportSchema = z.object({
  summary: z.string().min(1).max(4000),
  steps: z.array(z.object({ description: z.string().min(1).max(2000), files: z.array(z.string().min(1)).max(100),
    verification: z.string().min(1).max(2000) }).strict()).min(1).max(100),
  unverified: z.array(z.string().min(1).max(2000)).max(100),
}).strict();

export const reviewerReportSchema = z.object({
  summary: z.string().min(1).max(4000),
  reviewedFiles: z.array(z.string().min(1).max(1000)).min(1).max(100),
  findings: z.array(z.object({
    severity: z.enum(['P0', 'P1', 'P2', 'P3']), path: z.string().min(1).max(1000), line: z.number().int().positive(),
    quote: z.string().min(1).max(4000), message: z.string().min(1).max(2000), impact: z.string().min(1).max(2000), suggestion: z.string().min(1).max(2000),
  }).strict()).max(100),
  unverified: z.array(z.string().min(1).max(2000)).max(100),
}).strict();

export type RoleReport =
  | { role: 'planner'; source: 'agy-reported'; data: z.infer<typeof plannerReportSchema> }
  | { role: 'reviewer'; source: 'agy-reported'; data: z.infer<typeof reviewerReportSchema>; citationsChecked: true };

export function roleContract(role: BuiltinRole) {
  if (role === 'implementer') return;
  const schema = role === 'planner' ? plannerReportSchema : reviewerReportSchema;
  return { schema: z.toJSONSchema(schema), instruction: role === 'planner'
    ? 'Plan the requested work without editing files. Inspect existing sources. Return a concise structured plan with files, observable verification for each step and unverified assumptions. Distinguish proposed changes from existing behavior.'
    : 'Review the requested scope without editing files. Report actionable findings with severity P0-P3, project-relative file, one-based line, exact whole-line quote, impact and suggestion. List actually reviewed files and limitations in unverified. Do not invent findings or claim tests ran without evidence. A report with no findings is not proof of correctness.' };
}

export async function validateRoleReport(role: BuiltinRole, raw: unknown, copyDirectory: string): Promise<RoleReport | undefined> {
  if (role === 'implementer') return;
  if (role === 'planner') {
    const parsed = plannerReportSchema.safeParse(raw);
    if (!parsed.success) throw new BridgeError('ROLE_OUTPUT_INVALID', 'Planner response does not match its structured contract');
    for (const step of parsed.data.steps) for (const file of step.files) await checkedPath(copyDirectory, file, false);
    return { role, source: 'agy-reported', data: parsed.data };
  }
  const parsed = reviewerReportSchema.safeParse(raw);
  if (!parsed.success) throw new BridgeError('ROLE_OUTPUT_INVALID', 'Reviewer response does not match its structured contract');
  for (const file of parsed.data.reviewedFiles) await checkedPath(copyDirectory, file, true);
  for (const finding of parsed.data.findings) {
    if (!parsed.data.reviewedFiles.includes(finding.path)) throw new BridgeError('ROLE_OUTPUT_INVALID', 'Finding refers to a file outside reviewedFiles');
    const file = await checkedPath(copyDirectory, finding.path, true);
    if ((await stat(file)).size > 10_000_000) throw new BridgeError('VERIFICATION_TOO_LARGE', 'Review citation exceeds the text file limit');
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    const quote = finding.quote.split(/\r?\n/);
    if (lines.slice(finding.line - 1, finding.line - 1 + quote.length).join('\n') !== quote.join('\n')) {
      throw new BridgeError('ROLE_OUTPUT_INVALID', 'Review citation does not match its file and line');
    }
  }
  return { role, source: 'agy-reported', data: parsed.data, citationsChecked: true };
}
