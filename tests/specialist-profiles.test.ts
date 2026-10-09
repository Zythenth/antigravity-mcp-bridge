import { z } from 'zod';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  effortSchema,
  profileDefaultsSchema,
  roleDefinitionSchema,
  customRolesSchema,
  applyRoleDefaults,
  resolveRole,
  listRoles,
  hashJsonSchema,
  hashSkillBundle,
  validIncludePath,
  includePathsSchema,
  type RoleDefaults,
  type RoleDefinition,
} from '../src/roles.js';
import { BridgeError, type RunOptions } from '../src/types.js';

test('effortSchema validates supported effort levels and rejects invalid values', () => {
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    assert.equal(effortSchema.parse(level), level);
    assert.ok(profileDefaultsSchema.safeParse({ effort: level }).success);
  }

  for (const invalid of ['minimal', 'extreme', 'LOW', 'MEDIUM', 'ultra', '', 'none']) {
    assert.ok(!effortSchema.safeParse(invalid).success);
    assert.ok(!profileDefaultsSchema.safeParse({ effort: invalid }).success);
  }

  assert.ok(!profileDefaultsSchema.safeParse({ effort: 123 }).success);
  assert.ok(!profileDefaultsSchema.safeParse({ effort: null }).success);
});

test('profileDefaultsSchema validates model syntax and nullability', () => {
  // Valid model IDs
  for (const model of ['gemini-1.5-pro', 'claude-3-5-sonnet', 'gpt-4o', 'model.v1_alpha', 'm1']) {
    const res = profileDefaultsSchema.safeParse({ model });
    assert.ok(res.success, `Expected model '${model}' to be valid`);
    if (res.success) {
      assert.equal(res.data.model, model);
    }
  }

  // Explicit null is valid
  const nullRes = profileDefaultsSchema.safeParse({ model: null });
  assert.ok(nullRes.success);
  if (nullRes.success) {
    assert.equal(nullRes.data.model, null);
  }

  // Invalid models
  for (const invalid of [
    '', // empty
    '-start-dash', // starts with dash
    '.start-dot', // starts with dot
    '_start-under', // starts with underscore
    'invalid model spaces', // contains spaces
    'model/slash', // contains slash
    'model:colon', // contains colon
    'a'.repeat(129), // exceeds 128 characters
  ]) {
    assert.ok(!profileDefaultsSchema.safeParse({ model: invalid }).success, `Expected model '${invalid}' to be rejected`);
  }
});

test('profileDefaultsSchema is strict and rejects unknown privilege fields or callbacks', () => {
  assert.ok(!profileDefaultsSchema.safeParse({ permissions: ['exec', 'read'] }).success);
  assert.ok(!profileDefaultsSchema.safeParse({ allowExecution: true }).success);
  assert.ok(!profileDefaultsSchema.safeParse({ env: { KEY: 'value' } }).success);
  assert.ok(!profileDefaultsSchema.safeParse({ config: { privileged: true } }).success);
  assert.ok(!profileDefaultsSchema.safeParse({ callbacks: {} }).success);
  assert.ok(!profileDefaultsSchema.safeParse({ role: 'admin' }).success);
  assert.ok(!profileDefaultsSchema.safeParse({ unknownField: 42 }).success);

  // RoleDefinition schema is also strict
  assert.ok(!roleDefinitionSchema.safeParse({
    name: 'custom-worker',
    baseRole: 'implementer',
    instruction: 'Custom instructions',
    unknownProperty: true,
  }).success);
});

test('profileDefaultsSchema detects overbudget skills and enforces unique skill names', () => {
  const validSkills = [
    { name: 'skill-alpha', content: '# Skill Alpha\nInstructions' },
    { name: 'skill-beta', content: '# Skill Beta\nMore instructions', resources: [{ path: 'ref.md', content: 'Ref content' }] },
  ];
  assert.ok(profileDefaultsSchema.safeParse({ skills: validSkills }).success);

  // Exceeds 1 MiB aggregate size
  const hugeContent = 'x'.repeat(1024 * 1024 + 1);
  const overbudgetSkills = [
    { name: 'huge-skill', content: hugeContent },
  ];
  assert.ok(!profileDefaultsSchema.safeParse({ skills: overbudgetSkills }).success);

  // Exceeds 1 MiB aggregate across multiple bundles
  const mediumContent = 'x'.repeat(600 * 1024);
  const multiOverbudget = [
    { name: 'skill-one', content: mediumContent },
    { name: 'skill-two', content: mediumContent },
  ];
  assert.ok(!profileDefaultsSchema.safeParse({ skills: multiOverbudget }).success);

  // Exceeds 1 MiB via resources
  const hugeResourceSkill = [
    { name: 'res-skill', content: 'small', resources: [{ path: 'data.txt', content: hugeContent }] },
  ];
  assert.ok(!profileDefaultsSchema.safeParse({ skills: hugeResourceSkill }).success);

  // Duplicate skill names (exact and case-insensitive)
  const duplicateSkills = [
    { name: 'skill-dup', content: 'content 1' },
    { name: 'skill-dup', content: 'content 2' },
  ];
  assert.ok(!profileDefaultsSchema.safeParse({ skills: duplicateSkills }).success);

  const caseDupSkills = [
    { name: 'Skill-Dup', content: 'content 1' },
    { name: 'skill-dup', content: 'content 2' },
  ];
  assert.ok(!profileDefaultsSchema.safeParse({ skills: caseDupSkills }).success);

  // More than 8 skills (MAX_PROVIDED_SKILLS)
  const nineSkills = Array.from({ length: 9 }, (_, i) => ({
    name: `skill-${i}`,
    content: `content ${i}`,
  }));
  assert.ok(!profileDefaultsSchema.safeParse({ skills: nineSkills }).success);
});

test('profileDefaultsSchema validates outputSchema with bounded schema validation and detects overbudget schema', () => {
  const validSchema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      items: { type: 'array', items: { type: 'number' } },
    },
    required: ['summary'],
  };
  const parsed = profileDefaultsSchema.safeParse({ outputSchema: validSchema });
  assert.ok(parsed.success);
  if (parsed.success) {
    assert.deepEqual(parsed.data.outputSchema, validSchema);
  }

  // Non-object outputSchema
  assert.ok(!profileDefaultsSchema.safeParse({ outputSchema: 'string' }).success);
  assert.ok(!profileDefaultsSchema.safeParse({ outputSchema: [1, 2, 3] }).success);
  assert.ok(!profileDefaultsSchema.safeParse({ outputSchema: null }).success);

  // Overbudget schema (> 64 KiB)
  const hugeProps: Record<string, unknown> = {};
  for (let i = 0; i < 2000; i++) {
    hugeProps[`prop_${i}_long_key_padding_${i}`] = { type: 'string', description: 'x'.repeat(40) };
  }
  const hugeSchema = { type: 'object', properties: hugeProps };
  assert.ok(!profileDefaultsSchema.safeParse({ outputSchema: hugeSchema }).success);

  // Unsupported keywords (e.g. pattern, $id)
  assert.ok(!profileDefaultsSchema.safeParse({
    outputSchema: { type: 'string', pattern: '^[a-z]+$' },
  }).success);

  assert.ok(!profileDefaultsSchema.safeParse({
    outputSchema: { $id: 'http://example.com/schema.json', type: 'object' },
  }).success);

  // External network $ref
  assert.ok(!profileDefaultsSchema.safeParse({
    outputSchema: { type: 'object', properties: { item: { $ref: 'https://example.com/item.json' } } },
  }).success);
});

test('includePaths validates bounded relative paths and rejects traversal, .git, .agents, and unsafe segments', () => {
  // Valid includePaths
  assert.ok(includePathsSchema.safeParse(['src/roles.ts', 'tests/fixtures']).success);
  assert.ok(includePathsSchema.safeParse(['package.json']).success);

  // Path traversal
  assert.throws(() => validIncludePath('../outside.ts'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_INCLUDE_PATH');
  assert.throws(() => validIncludePath('src/../../outside.ts'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_INCLUDE_PATH');
  assert.throws(() => validIncludePath('./src'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_INCLUDE_PATH');
  assert.ok(!includePathsSchema.safeParse(['../secret.txt']).success);
  assert.ok(!includePathsSchema.safeParse(['src/../etc']).success);

  // Absolute / UNC / drive letter paths
  assert.throws(() => validIncludePath('/etc/passwd'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_INCLUDE_PATH');
  assert.throws(() => validIncludePath('\\Windows\\System32'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_INCLUDE_PATH');
  assert.throws(() => validIncludePath('C:/project/file.ts'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_INCLUDE_PATH');
  assert.throws(() => validIncludePath('\\\\server\\share'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_INCLUDE_PATH');

  // .git and .agents rejection
  assert.throws(() => validIncludePath('.git'), (err: unknown) => err instanceof BridgeError && err.code === 'UNSAFE_INCLUDE_PATH');
  assert.throws(() => validIncludePath('src/.git/HEAD'), (err: unknown) => err instanceof BridgeError && err.code === 'UNSAFE_INCLUDE_PATH');
  assert.throws(() => validIncludePath('.agents'), (err: unknown) => err instanceof BridgeError && err.code === 'UNSAFE_INCLUDE_PATH');
  assert.throws(() => validIncludePath('nested/.agents/skills'), (err: unknown) => err instanceof BridgeError && err.code === 'UNSAFE_INCLUDE_PATH');
  assert.ok(!includePathsSchema.safeParse(['.git/config']).success);
  assert.ok(!includePathsSchema.safeParse(['sub/.agents']).success);

  // Windows device names
  assert.throws(() => validIncludePath('CON'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_INCLUDE_PATH');
  assert.throws(() => validIncludePath('aux.txt'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_INCLUDE_PATH');
  assert.throws(() => validIncludePath('sub/NUL'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_INCLUDE_PATH');
  assert.ok(!includePathsSchema.safeParse(['CON']).success);

  // Colon / Alternate Data Streams (ADS)
  assert.throws(() => validIncludePath('file.txt:stream'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_INCLUDE_PATH');
  assert.ok(!includePathsSchema.safeParse(['file.txt:stream']).success);

  // Control characters and NUL
  assert.throws(() => validIncludePath('file\x00.txt'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_INCLUDE_PATH');
  assert.throws(() => validIncludePath('file\n.txt'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_INCLUDE_PATH');
  assert.ok(!includePathsSchema.safeParse(['file\x00.txt']).success);

  // Trailing dot or space in segment
  assert.throws(() => validIncludePath('src/file.'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_INCLUDE_PATH');
  assert.throws(() => validIncludePath('src/dir '), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_INCLUDE_PATH');
  assert.ok(!includePathsSchema.safeParse(['src/file.']).success);

  // Empty array (1..100 required)
  assert.ok(!includePathsSchema.safeParse([]).success);

  // Exceeds 100 paths
  const over100 = Array.from({ length: 101 }, (_, i) => `src/file_${i}.ts`);
  assert.ok(!includePathsSchema.safeParse(over100).success);

  // Duplicate paths and case-alias duplicates
  assert.ok(!includePathsSchema.safeParse(['src/a.ts', 'src/a.ts']).success);
  assert.ok(!includePathsSchema.safeParse(['src/a.ts', 'SRC/A.TS']).success);
});

test('artifactPaths and timeoutSeconds validation in profileDefaultsSchema', () => {
  // timeoutSeconds
  assert.ok(profileDefaultsSchema.safeParse({ timeoutSeconds: 1 }).success);
  assert.ok(profileDefaultsSchema.safeParse({ timeoutSeconds: 86400 }).success);
  assert.ok(!profileDefaultsSchema.safeParse({ timeoutSeconds: 0 }).success);
  assert.ok(!profileDefaultsSchema.safeParse({ timeoutSeconds: -1 }).success);
  assert.ok(!profileDefaultsSchema.safeParse({ timeoutSeconds: 86401 }).success);
  assert.ok(!profileDefaultsSchema.safeParse({ timeoutSeconds: 12.5 }).success);

  // deliveryMode
  assert.ok(profileDefaultsSchema.safeParse({ deliveryMode: 'messages' }).success);
  assert.ok(profileDefaultsSchema.safeParse({ deliveryMode: 'events' }).success);
  assert.ok(!profileDefaultsSchema.safeParse({ deliveryMode: 'invalid' }).success);

  // artifactPaths
  assert.ok(profileDefaultsSchema.safeParse({ artifactPaths: ['dist/out.json'] }).success);
  assert.ok(!profileDefaultsSchema.safeParse({ artifactPaths: [] }).success);
  assert.ok(!profileDefaultsSchema.safeParse({ artifactPaths: ['../outside.txt'] }).success);
  assert.ok(!profileDefaultsSchema.safeParse({ artifactPaths: ['dup.txt', 'dup.txt'] }).success);
});

test('planner and reviewer base roles reject custom outputSchema in configuration and applyRoleDefaults', () => {
  const customSchema = { type: 'object', properties: { res: { type: 'string' } } };

  // Implementer base role accepts custom outputSchema
  const validImplementerRole: RoleDefinition = {
    name: 'custom-impl',
    baseRole: 'implementer',
    instruction: 'Implement stuff',
    defaults: {
      outputSchema: customSchema,
    },
  };
  assert.ok(roleDefinitionSchema.safeParse(validImplementerRole).success);

  // Planner base role rejects custom outputSchema
  const plannerWithSchema = {
    name: 'custom-plan',
    baseRole: 'planner',
    instruction: 'Plan stuff',
    defaults: {
      outputSchema: customSchema,
    },
  };
  assert.ok(!roleDefinitionSchema.safeParse(plannerWithSchema).success);
  assert.ok(!customRolesSchema.safeParse([plannerWithSchema]).success);

  // Reviewer base role rejects custom outputSchema
  const reviewerWithSchema = {
    name: 'custom-rev',
    baseRole: 'reviewer',
    instruction: 'Review stuff',
    defaults: {
      outputSchema: customSchema,
    },
  };
  assert.ok(!roleDefinitionSchema.safeParse(reviewerWithSchema).success);
  assert.ok(!customRolesSchema.safeParse([reviewerWithSchema]).success);

  // applyRoleDefaults rejects custom outputSchema for planner base
  const plannerRole: RoleDefinition = {
    name: 'custom-plan',
    baseRole: 'planner',
    instruction: 'Plan stuff',
  };
  assert.throws(
    () => applyRoleDefaults({ prompt: 'test', workingDirectory: '/test', outputSchema: customSchema }, plannerRole),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ROLE' && err.message.includes('implementer')
  );

  // applyRoleDefaults rejects if definition defaults has outputSchema on non-implementer
  const bypassedPlanner: RoleDefinition = {
    name: 'bypassed-plan',
    baseRole: 'planner',
    instruction: 'Plan stuff',
    defaults: { outputSchema: customSchema },
  };
  assert.throws(
    () => applyRoleDefaults({ prompt: 'test', workingDirectory: '/test' }, bypassedPlanner),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ROLE'
  );
});

test('applyRoleDefaults merges only missing options and preserves explicit model:null and skills:[]', () => {
  const defaults: RoleDefaults = {
    model: 'gemini-1.5-pro',
    effort: 'low',
    skills: [{ name: 'auditor', content: '# Auditor' }],
    includePaths: ['src/default'],
    artifactPaths: ['out/default.log'],
    deliveryMode: 'events',
    timeoutSeconds: 3600,
    outputSchema: { type: 'object', properties: { defaultField: { type: 'string' } } },
  };

  const role: RoleDefinition = {
    name: 'specialist-worker',
    baseRole: 'implementer',
    instruction: 'Execute with specialist defaults',
    defaults,
  };

  // Test 1: Task options missing fields adopt defaults
  const emptyOpts: RunOptions = {
    prompt: 'Implement feature',
    workingDirectory: '/workspace',
  };
  const merged1 = applyRoleDefaults(emptyOpts, role);
  assert.equal(merged1.model, 'gemini-1.5-pro');
  assert.equal((merged1 as { effort?: string }).effort, 'low');
  assert.deepEqual(merged1.skills, defaults.skills);
  assert.deepEqual(merged1.includePaths, ['src/default']);
  assert.deepEqual(merged1.artifactPaths, ['out/default.log']);
  assert.equal(merged1.deliveryMode, 'events');
  assert.equal(merged1.timeoutSeconds, 3600);
  assert.deepEqual(merged1.outputSchema, defaults.outputSchema);

  // Test 2: Task options with explicit model:null MUST be preserved, NOT overridden by default
  const nullModelOpts: RunOptions = {
    prompt: 'Implement feature',
    workingDirectory: '/workspace',
    model: null,
  };
  const merged2 = applyRoleDefaults(nullModelOpts, role);
  assert.equal(merged2.model, null, 'Explicit model:null must be preserved');

  // Test 3: Task options with explicit skills:[] MUST be preserved, NOT overridden by default
  const emptySkillsOpts: RunOptions = {
    prompt: 'Implement feature',
    workingDirectory: '/workspace',
    skills: [],
  };
  const merged3 = applyRoleDefaults(emptySkillsOpts, role);
  assert.deepEqual(merged3.skills, [], 'Explicit skills:[] must be preserved');

  // Test 4: Task options override other defaults
  const overrideOpts: RunOptions & { effort?: 'high' } = {
    prompt: 'Implement feature',
    workingDirectory: '/workspace',
    model: 'claude-3-5-sonnet',
    effort: 'high',
    timeoutSeconds: 600,
    deliveryMode: 'messages',
    includePaths: ['src/custom.ts'],
    artifactPaths: ['out/custom.log'],
  };
  const merged4 = applyRoleDefaults(overrideOpts, role);
  assert.equal(merged4.model, 'claude-3-5-sonnet');
  assert.equal((merged4 as { effort?: string }).effort, 'high');
  assert.equal(merged4.timeoutSeconds, 600);
  assert.equal(merged4.deliveryMode, 'messages');
  assert.deepEqual(merged4.includePaths, ['src/custom.ts']);
  assert.deepEqual(merged4.artifactPaths, ['out/custom.log']);
});

test('applyRoleDefaults overrides outputSchema wholesale without deep merge', () => {
  const defaultSchema = {
    type: 'object',
    properties: {
      a: { type: 'string' },
      nested: { type: 'object', properties: { x: { type: 'number' } } },
    },
    required: ['a'],
  };

  const taskSchema = {
    type: 'object',
    properties: {
      b: { type: 'boolean' },
    },
    required: ['b'],
  };

  const role: RoleDefinition = {
    name: 'json-worker',
    baseRole: 'implementer',
    instruction: 'Produce json',
    defaults: { outputSchema: defaultSchema },
  };

  const merged = applyRoleDefaults({
    prompt: 'Run task',
    workingDirectory: '/workspace',
    outputSchema: taskSchema,
  }, role);

  assert.deepEqual(merged.outputSchema, taskSchema);
  assert.equal('a' in (merged.outputSchema!.properties as Record<string, unknown>), false);
  assert.equal('nested' in (merged.outputSchema!.properties as Record<string, unknown>), false);
});

test('applyRoleDefaults does not copy instruction or name into RunOptions', () => {
  const role: RoleDefinition = {
    name: 'secret-agent',
    baseRole: 'implementer',
    instruction: 'Top secret role instruction',
    defaults: { effort: 'medium' },
  };

  const merged = applyRoleDefaults({
    prompt: 'Task prompt',
    workingDirectory: '/workspace',
  }, role);

  assert.equal('instruction' in (merged as unknown as Record<string, unknown>), false);
  assert.equal('name' in (merged as unknown as Record<string, unknown>), false);
  assert.equal(merged.prompt, 'Task prompt');
});

test('deep mutation safety: mutating applyRoleDefaults result never mutates configured object or vice-versa', () => {
  const configuredDefaults: RoleDefaults = {
    model: 'gemini-1.5-pro',
    effort: 'high',
    skills: [
      { name: 'auditor', content: '# Original Skill Content', resources: [{ path: 'r.md', content: 'Orig resource' }] },
    ],
    includePaths: ['src/original.ts'],
    artifactPaths: ['out/orig.txt'],
    outputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
    },
  };

  const role: RoleDefinition = {
    name: 'isolated-role',
    baseRole: 'implementer',
    instruction: 'Instructions',
    defaults: configuredDefaults,
  };

  const merged = applyRoleDefaults({
    prompt: 'Run task',
    workingDirectory: '/workspace',
  }, role);

  // Mutate merged result deeply
  (merged.skills![0] as { content: string }).content = 'MUTATED SKILL CONTENT';
  (merged.skills![0]!.resources![0] as { content: string }).content = 'MUTATED RESOURCE CONTENT';
  merged.includePaths!.push('src/hacked.ts');
  merged.artifactPaths!.push('out/hacked.txt');
  (merged.outputSchema!.properties as Record<string, unknown>)['extraKey'] = { type: 'number' };

  // Verify configuredDefaults remained completely unchanged
  assert.equal(configuredDefaults.skills![0]!.content, '# Original Skill Content');
  assert.equal(configuredDefaults.skills![0]!.resources![0]!.content, 'Orig resource');
  assert.deepEqual(configuredDefaults.includePaths, ['src/original.ts']);
  assert.deepEqual(configuredDefaults.artifactPaths, ['out/orig.txt']);
  assert.equal('extraKey' in (configuredDefaults.outputSchema!.properties as Record<string, unknown>), false);

  // Conversely, mutating configuredDefaults does not affect previously merged result
  const merged2 = applyRoleDefaults({
    prompt: 'Run task 2',
    workingDirectory: '/workspace',
  }, role);

  (configuredDefaults.skills![0] as { content: string }).content = 'CONFIG MUTATED AFTER MERGE';
  configuredDefaults.includePaths!.push('src/late_addition.ts');

  assert.equal(merged2.skills![0]!.content, '# Original Skill Content');
  assert.notEqual(merged2.skills![0]!.content, 'CONFIG MUTATED AFTER MERGE');
  assert.equal(merged2.includePaths!.includes('src/late_addition.ts'), false);
});

test('deep mutation safety: resolveRole detaches nested defaults rather than shallow spread', () => {
  const customRole: RoleDefinition = {
    name: 'specialist-resolver',
    baseRole: 'implementer',
    instruction: 'Resolve me',
    defaults: {
      model: 'gemini-1.5-flash',
      skills: [{ name: 'sec-skill', content: 'Strict policy' }],
      includePaths: ['lib/core.ts'],
      artifactPaths: ['build/receipt.json'],
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    },
  };

  const customRoles = [customRole];
  const resolved = resolveRole('specialist-resolver', customRoles);

  assert.deepEqual(resolved.defaults, customRole.defaults);
  assert.notEqual(resolved.defaults, customRole.defaults, 'defaults object reference must be detached');

  // Deep mutation on resolved defaults
  (resolved.defaults!.skills![0] as { content: string }).content = 'ATTACKER CONTENT';
  resolved.defaults!.includePaths!.push('lib/injected.ts');
  resolved.defaults!.artifactPaths!.push('build/fake.json');
  (resolved.defaults!.outputSchema!.properties as Record<string, unknown>)['hacked'] = { type: 'string' };

  // Original custom role must be unmutated
  assert.equal(customRole.defaults!.skills![0]!.content, 'Strict policy');
  assert.deepEqual(customRole.defaults!.includePaths, ['lib/core.ts']);
  assert.deepEqual(customRole.defaults!.artifactPaths, ['build/receipt.json']);
  assert.equal('hacked' in (customRole.defaults!.outputSchema!.properties as Record<string, unknown>), false);
});

test('listRoles exposes compact default metadata and never leaks full skills content or schema', () => {
  const schema = {
    type: 'object',
    properties: { result: { type: 'string' }, details: { type: 'array' } },
  };
  const skill = {
    name: 'code-checker',
    content: '# Secret Skill Code\nDO NOT LEAK THIS CONTENT IN CATALOG',
    resources: [
      { path: 'doc.md', content: 'Secret resource documentation' },
      { path: 'script.sh', content: 'Secret script content' },
    ],
  };

  const customRole: RoleDefinition = {
    name: 'auditor-pro',
    baseRole: 'implementer',
    instruction: 'Audit system',
    description: 'Specialist security auditor',
    defaults: {
      model: 'gemini-1.5-pro',
      effort: 'high',
      timeoutSeconds: 7200,
      deliveryMode: 'messages',
      includePaths: ['src/core', 'src/auth'],
      artifactPaths: ['audit/report.md'],
      skills: [skill],
      outputSchema: schema,
    },
  };

  const listings = listRoles([customRole]);
  const auditorListing = listings.find(l => l.name === 'auditor-pro');
  assert.ok(auditorListing);

  // Compatible keys preserved
  assert.equal(auditorListing.name, 'auditor-pro');
  assert.equal(auditorListing.baseRole, 'implementer');
  assert.equal(auditorListing.description, 'Specialist security auditor');
  assert.equal(auditorListing.custom, true);
  assert.equal(auditorListing.instructionChars, 'Audit system'.length);

  // Compact default metadata
  assert.equal(auditorListing.defaultModel, 'gemini-1.5-pro');
  assert.equal(auditorListing.defaultEffort, 'high');
  assert.equal(auditorListing.defaultTimeoutSeconds, 7200);
  assert.equal(auditorListing.defaultDeliveryMode, 'messages');
  assert.deepEqual(auditorListing.defaultIncludePaths, ['src/core', 'src/auth']);
  assert.deepEqual(auditorListing.defaultArtifactPaths, ['audit/report.md']);

  // Skill summaries expose ONLY { name, sha256, resourceCount }
  assert.ok(auditorListing.defaultSkillSummaries);
  assert.equal(auditorListing.defaultSkillSummaries.length, 1);
  const summary = auditorListing.defaultSkillSummaries[0]!;
  assert.equal(summary.name, 'code-checker');
  assert.equal(summary.resourceCount, 2);
  assert.equal(summary.sha256, hashSkillBundle(skill));
  assert.equal(summary.sha256, createHash('sha256').update(JSON.stringify(skill)).digest('hex'));

  // CRITICAL: Full skills content and schema MUST NOT be exposed
  assert.equal('skills' in auditorListing, false);
  assert.equal('outputSchema' in auditorListing, false);
  assert.equal('content' in (summary as unknown as Record<string, unknown>), false);
  assert.equal('resources' in (summary as unknown as Record<string, unknown>), false);

  // outputSchemaSha256 matches exact JSON serialization
  assert.equal(auditorListing.outputSchemaSha256, hashJsonSchema(schema));
  assert.equal(auditorListing.outputSchemaSha256, createHash('sha256').update(JSON.stringify(schema)).digest('hex'));

  // Built-in roles must remain backwards-compatible without defaults leaking
  const builtinImplementer = listings.find(l => l.name === 'implementer');
  assert.ok(builtinImplementer);
  assert.equal(builtinImplementer.custom, false);
  assert.equal('defaultModel' in builtinImplementer, false);
  assert.equal('defaultEffort' in builtinImplementer, false);
  assert.equal('defaultSkillSummaries' in builtinImplementer, false);
  assert.equal('outputSchemaSha256' in builtinImplementer, false);
});

test('listRoles preserves defaultModel: null explicitly', () => {
  const nullModelRole: RoleDefinition = {
    name: 'auto-model-role',
    baseRole: 'implementer',
    instruction: 'Work with default agy model',
    defaults: {
      model: null,
      effort: 'medium',
    },
  };

  const listings = listRoles([nullModelRole]);
  const item = listings.find(l => l.name === 'auto-model-role');
  assert.ok(item);
  assert.equal(item.defaultModel, null);
  assert.equal(item.defaultEffort, 'medium');
});

test('0.7.1 backwards compatibility: roles without defaults continue to work seamlessly', () => {
  const legacyRole: RoleDefinition = {
    name: 'legacy-specialist',
    baseRole: 'implementer',
    instruction: 'Legacy instructions without defaults',
  };

  assert.ok(roleDefinitionSchema.safeParse(legacyRole).success);
  assert.ok(customRolesSchema.safeParse([legacyRole]).success);

  const resolved = resolveRole('legacy-specialist', [legacyRole]);
  assert.equal(resolved.name, 'legacy-specialist');
  assert.equal(resolved.defaults, undefined);

  const merged = applyRoleDefaults({
    prompt: 'Legacy task',
    workingDirectory: '/workspace',
  }, resolved);
  assert.equal(merged.prompt, 'Legacy task');
  assert.equal(merged.workingDirectory, '/workspace');
  assert.equal(merged.model, undefined);
  assert.equal(merged.skills, undefined);

  const listings = listRoles([legacyRole]);
  const legacyListing = listings.find(l => l.name === 'legacy-specialist');
  assert.ok(legacyListing);
  assert.equal('defaultModel' in legacyListing, false);
  assert.equal('defaultEffort' in legacyListing, false);
});

test('profile definition exports an MCP JSON Schema while retaining runtime validation', () => {
  assert.doesNotThrow(() => z.toJSONSchema(roleDefinitionSchema));
  assert.ok(!profileDefaultsSchema.safeParse({ outputSchema: { type: 'invalid' } }).success);
});
