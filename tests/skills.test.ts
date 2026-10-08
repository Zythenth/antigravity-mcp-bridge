import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  stageProvidedSkills,
  verifyProvidedSkills,
  providedSkillsSchema,
  computeSkillSha256,
  isValidCanonicalSlug,
  parseAndValidateFrontmatterName,
  validateAndNormalizeResourcePath,
  type ProvidedSkill,
  type StagedSkill,
} from '../src/skills.js';
import { BridgeError } from '../src/types.js';

async function createTempDir(prefix = 'agy-skills-test-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function cleanupTempDir(dir: string): Promise<void> {
  const resolved = path.resolve(dir);
  const tempRoot = path.resolve(os.tmpdir());
  const rel = path.relative(tempRoot, resolved);
  if (!rel || rel.startsWith('..') || rel.includes(path.sep) || rel.includes('/') || !path.basename(resolved).startsWith('agy-skills-test-')) {
    throw new Error(`Refusing to remove directory outside temporary storage: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

test('stages realistic skill with reference files and verifies exact bytes and hashes', async () => {
  const copyDir = await createTempDir();
  try {
    const skillContent = [
      '---',
      'name: code-auditor',
      'description: Expert security auditor skill',
      '---',
      '# Code Auditor',
      'Inspect source code for security vulnerabilities. 🔍',
    ].join('\n');

    const owaspRef = '# OWASP Top 10\n1. Broken Access Control\n2. Cryptographic Failures\nUnicode: 🛡️ 安全';
    const checkScript = '#!/bin/sh\necho "checking"';

    const bundles: ProvidedSkill[] = [
      {
        name: 'code-auditor',
        content: skillContent,
        resources: [
          { path: 'references/owasp.md', content: owaspRef },
          { path: 'scripts/check.sh', content: checkScript },
        ],
      },
    ];

    const staged = await stageProvidedSkills(copyDir, bundles);

    assert.equal(staged.length, 1);
    const stagedSkill = staged[0]!;
    assert.equal(stagedSkill.name, 'code-auditor');

    assert.equal('content' in (stagedSkill as unknown as Record<string, unknown>), false);
    assert.equal('resources' in (stagedSkill as unknown as Record<string, unknown>), false);

    assert.equal(stagedSkill.files.length, 3);
    const filesMap = new Map(stagedSkill.files.map(f => [f.path, f.sha256]));

    const expectedSkillMdPath = '.agents/skills/code-auditor/SKILL.md';
    const expectedOwaspPath = '.agents/skills/code-auditor/references/owasp.md';
    const expectedScriptPath = '.agents/skills/code-auditor/scripts/check.sh';

    assert.equal(filesMap.get(expectedSkillMdPath), sha256Hex(skillContent));
    assert.equal(filesMap.get(expectedOwaspPath), sha256Hex(owaspRef));
    assert.equal(filesMap.get(expectedScriptPath), sha256Hex(checkScript));

    assert.equal(stagedSkill.sha256, computeSkillSha256(stagedSkill.files));

    const diskSkillMd = await readFile(path.join(copyDir, expectedSkillMdPath), 'utf8');
    const diskOwasp = await readFile(path.join(copyDir, expectedOwaspPath), 'utf8');
    const diskScript = await readFile(path.join(copyDir, expectedScriptPath), 'utf8');

    assert.equal(diskSkillMd, skillContent);
    assert.equal(diskOwasp, owaspRef);
    assert.equal(diskScript, checkScript);

    await verifyProvidedSkills(copyDir, staged);
  } finally {
    await cleanupTempDir(copyDir);
  }
});

test('supports plain, single-quoted, and double-quoted frontmatter canonical names', async () => {
  const copyDir = await createTempDir();
  try {
    const bundles: ProvidedSkill[] = [
      {
        name: 'plain-skill',
        content: '---\nname: plain-skill\ndescription: plain\n---\n# Plain',
      },
      {
        name: 'single-quoted-skill',
        content: "---\nname: 'single-quoted-skill'\ndescription: single\n---\n# Single",
      },
      {
        name: 'double-quoted-skill',
        content: '---\nname: "double-quoted-skill"\ndescription: double\n---\n# Double',
      },
    ];

    const staged = await stageProvidedSkills(copyDir, bundles);
    assert.equal(staged.length, 3);
    await verifyProvidedSkills(copyDir, staged);
  } finally {
    await cleanupTempDir(copyDir);
  }
});

test('rejects malformed, unclosed, mismatched, and ambiguous frontmatter names', async () => {
  const expected = 'my-skill';

  assert.throws(
    () => parseAndValidateFrontmatterName('# No Frontmatter\nJust text', expected),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_FRONTMATTER',
  );

  assert.throws(
    () => parseAndValidateFrontmatterName('---\nname: my-skill\n# unclosed', expected),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_FRONTMATTER',
  );

  assert.throws(
    () => parseAndValidateFrontmatterName('---\ndescription: test\n---\n# Skill', expected),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_FRONTMATTER',
  );

  assert.throws(
    () => parseAndValidateFrontmatterName('---\nname: other-skill\n---\n# Skill', expected),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_FRONTMATTER',
  );

  assert.throws(
    () => parseAndValidateFrontmatterName('---\nname: my-skill\nname: my-skill\n---\n# Skill', expected),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_FRONTMATTER',
  );

  assert.throws(
    () => parseAndValidateFrontmatterName('---\nname: "my-skill\n---\n# Skill', expected),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_FRONTMATTER',
  );

  assert.throws(
    () => parseAndValidateFrontmatterName('---\nname: my-skill # trailing comment\n---\n# Skill', expected),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_FRONTMATTER',
  );

  assert.throws(
    () => parseAndValidateFrontmatterName('---\nname:\n---\n# Skill', expected),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_FRONTMATTER',
  );

  assert.throws(
    () => parseAndValidateFrontmatterName('---\nname: ""\n---\n# Skill', expected),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_FRONTMATTER',
  );

  assert.throws(
    () => parseAndValidateFrontmatterName('---\nmetadata:\n  name: my-skill\n---\n# Skill', expected),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_FRONTMATTER',
  );
});

test('canonical slug validator rejects invalid names and Windows device names', () => {
  assert.equal(isValidCanonicalSlug('valid-slug'), true);
  assert.equal(isValidCanonicalSlug('skill1'), true);
  assert.equal(isValidCanonicalSlug('a'), true);
  assert.equal(isValidCanonicalSlug('a'.repeat(64)), true);

  assert.equal(isValidCanonicalSlug('Uppercase'), false);
  assert.equal(isValidCanonicalSlug('space name'), false);
  assert.equal(isValidCanonicalSlug('under_score'), false);
  assert.equal(isValidCanonicalSlug('consecutive--hyphen'), false);
  assert.equal(isValidCanonicalSlug('-leading-hyphen'), false);
  assert.equal(isValidCanonicalSlug('trailing-hyphen-'), false);
  assert.equal(isValidCanonicalSlug(''), false);
  assert.equal(isValidCanonicalSlug('a'.repeat(65)), false);

  assert.equal(isValidCanonicalSlug('con'), false);
  assert.equal(isValidCanonicalSlug('prn'), false);
  assert.equal(isValidCanonicalSlug('aux'), false);
  assert.equal(isValidCanonicalSlug('nul'), false);
  assert.equal(isValidCanonicalSlug('com1'), false);
  assert.equal(isValidCanonicalSlug('lpt1'), false);
});

test('rejects duplicate skill names and case alias collisions in input bundles', async () => {
  const copyDir = await createTempDir();
  try {
    const duplicates: ProvidedSkill[] = [
      { name: 'my-skill', content: '---\nname: my-skill\n---\n# 1' },
      { name: 'my-skill', content: '---\nname: my-skill\n---\n# 2' },
    ];
    await assert.rejects(
      stageProvidedSkills(copyDir, duplicates),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_INPUT',
    );
  } finally {
    await cleanupTempDir(copyDir);
  }
});

test('rejects null and undefined input bundles rather than returning empty', async () => {
  const copyDir = await createTempDir();
  try {
    await assert.rejects(
      stageProvidedSkills(copyDir, null as unknown as ProvidedSkill[]),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_INPUT',
    );
    await assert.rejects(
      stageProvidedSkills(copyDir, undefined as unknown as ProvidedSkill[]),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_INPUT',
    );
    const empty = await stageProvidedSkills(copyDir, []);
    assert.deepEqual(empty, []);
  } finally {
    await cleanupTempDir(copyDir);
  }
});

test('resource path validator rejects traversal, absolute, device, and empty segments', () => {
  const skill = 'test-skill';

  assert.equal(validateAndNormalizeResourcePath('references/doc.md', skill), 'references/doc.md');
  assert.equal(validateAndNormalizeResourcePath('scripts\\run.sh', skill), 'scripts/run.sh');

  assert.throws(
    () => validateAndNormalizeResourcePath('../outside.txt', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );
  assert.throws(
    () => validateAndNormalizeResourcePath('dir/../../outside.txt', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );
  assert.throws(
    () => validateAndNormalizeResourcePath('dir/./curr.txt', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );

  assert.throws(
    () => validateAndNormalizeResourcePath('/etc/passwd', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );
  assert.throws(
    () => validateAndNormalizeResourcePath('C:/Windows/win.ini', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );
  assert.throws(
    () => validateAndNormalizeResourcePath('\\\\server\\share\\file.txt', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );

  assert.throws(
    () => validateAndNormalizeResourcePath('dir//file.txt', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );
  assert.throws(
    () => validateAndNormalizeResourcePath('dir/', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );
  assert.throws(
    () => validateAndNormalizeResourcePath('', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );

  assert.throws(
    () => validateAndNormalizeResourcePath('con', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );
  assert.throws(
    () => validateAndNormalizeResourcePath('dir/nul.txt', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );
  assert.throws(
    () => validateAndNormalizeResourcePath('com1.log', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );
});

test('rejects .git, AGENTS.md, and SKILL.md override in resource paths', () => {
  const skill = 'test-skill';

  assert.throws(
    () => validateAndNormalizeResourcePath('.git/config', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );
  assert.throws(
    () => validateAndNormalizeResourcePath('subdir/.git/HEAD', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );

  assert.throws(
    () => validateAndNormalizeResourcePath('AGENTS.md', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );
  assert.throws(
    () => validateAndNormalizeResourcePath('agents.md', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );
  assert.throws(
    () => validateAndNormalizeResourcePath('dir/AGENTS.md', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );

  assert.throws(
    () => validateAndNormalizeResourcePath('SKILL.md', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );
  assert.throws(
    () => validateAndNormalizeResourcePath('skill.md', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );
  assert.throws(
    () => validateAndNormalizeResourcePath('SKILL.md/extra', skill),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
  );
});

test('rejects duplicate resource paths, case aliases, and file/dir prefix collisions', async () => {
  const copyDir = await createTempDir();
  try {
    await assert.rejects(
      stageProvidedSkills(copyDir, [
        {
          name: 'skill-dup',
          content: '---\nname: skill-dup\n---\n# Dup',
          resources: [
            { path: 'doc.txt', content: 'a' },
            { path: 'doc.txt', content: 'b' },
          ],
        },
      ]),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
    );

    await assert.rejects(
      stageProvidedSkills(copyDir, [
        {
          name: 'skill-case',
          content: '---\nname: skill-case\n---\n# Case',
          resources: [
            { path: 'doc.txt', content: 'a' },
            { path: 'DOC.TXT', content: 'b' },
          ],
        },
      ]),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
    );

    await assert.rejects(
      stageProvidedSkills(copyDir, [
        {
          name: 'skill-prefix',
          content: '---\nname: skill-prefix\n---\n# Prefix',
          resources: [
            { path: 'docs', content: 'file content' },
            { path: 'docs/guide.md', content: 'nested file' },
          ],
        },
      ]),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_RESOURCE',
    );
  } finally {
    await cleanupTempDir(copyDir);
  }
});

test('prevalidates all bundles and performs no partial write on invalid second bundle', async () => {
  const copyDir = await createTempDir();
  try {
    const bundles: ProvidedSkill[] = [
      {
        name: 'skill-first',
        content: '---\nname: skill-first\n---\n# Valid First',
      },
      {
        name: 'skill-second',
        content: '---\nname: wrong-name\n---\n# Invalid Second',
      },
    ];

    await assert.rejects(
      stageProvidedSkills(copyDir, bundles),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_FRONTMATTER',
    );

    const firstSkillPath = path.join(copyDir, '.agents', 'skills', 'skill-first');
    await assert.rejects(readFile(path.join(firstSkillPath, 'SKILL.md')), { code: 'ENOENT' });
  } finally {
    await cleanupTempDir(copyDir);
  }
});

test('prevents overwriting existing project skill directories and case aliases', async () => {
  const copyDir = await createTempDir();
  try {
    const existingSkillDir = path.join(copyDir, '.agents', 'skills', 'existing-skill');
    await mkdir(existingSkillDir, { recursive: true });
    await writeFile(path.join(existingSkillDir, 'SKILL.md'), 'pre-existing');

    await assert.rejects(
      stageProvidedSkills(copyDir, [
        {
          name: 'existing-skill',
          content: '---\nname: existing-skill\n---\n# Collide',
        },
      ]),
      (err: unknown) => err instanceof BridgeError && err.code === 'SKILL_COLLISION',
    );

    const preserved = await readFile(path.join(existingSkillDir, 'SKILL.md'), 'utf8');
    assert.equal(preserved, 'pre-existing');
  } finally {
    await cleanupTempDir(copyDir);
  }
});

test('enforces deterministic limits: max count, 101 resources, max bytes, and copy limits with no partial writes', async () => {
  const copyDir = await createTempDir();
  try {
    const nineBundles: ProvidedSkill[] = Array.from({ length: 9 }, (_, i) => ({
      name: `skill-${i}`,
      content: `---\nname: skill-${i}\n---\n# Skill ${i}`,
    }));
    await assert.rejects(
      stageProvidedSkills(copyDir, nineBundles),
      (err: unknown) => err instanceof BridgeError && err.code === 'COPY_LIMIT_EXCEEDED',
    );

    const tooManyResources: ProvidedSkill[] = [
      {
        name: 'skill-res-limit',
        content: '---\nname: skill-res-limit\n---\n# Limit',
        resources: Array.from({ length: 101 }, (_, i) => ({
          path: `res-${i}.txt`,
          content: 'text',
        })),
      },
    ];
    await assert.rejects(
      stageProvidedSkills(copyDir, tooManyResources),
      (err: unknown) => err instanceof BridgeError && err.code === 'COPY_LIMIT_EXCEEDED',
    );

    // Verify 101-resource failure performed no writes on disk
    const targetDir = path.join(copyDir, '.agents', 'skills', 'skill-res-limit');
    await assert.rejects(readFile(path.join(targetDir, 'SKILL.md')), { code: 'ENOENT' });

    const hugeSkill: ProvidedSkill[] = [
      {
        name: 'huge-skill',
        content: '---\nname: huge-skill\n---\n' + 'x'.repeat(1024 * 1024 + 10),
      },
    ];
    await assert.rejects(
      stageProvidedSkills(copyDir, hugeSkill),
      (err: unknown) => err instanceof BridgeError && err.code === 'COPY_LIMIT_EXCEEDED',
    );

    const boundedByteSkill: ProvidedSkill[] = [
      {
        name: 'bounded-skill',
        content: '---\nname: bounded-skill\n---\n# Small',
      },
    ];
    await assert.rejects(
      stageProvidedSkills(copyDir, boundedByteSkill, { maxCopyBytes: 10, maxCopyFiles: 100, maxChangedFiles: 10 }),
      (err: unknown) => err instanceof BridgeError && err.code === 'COPY_LIMIT_EXCEEDED',
    );

    await assert.rejects(
      stageProvidedSkills(
        copyDir,
        [
          {
            name: 'bounded-file-skill',
            content: '---\nname: bounded-file-skill\n---\n# Files',
            resources: [{ path: 'ref.txt', content: 'test' }],
          },
        ],
        { maxCopyFiles: 1, maxCopyBytes: 100000, maxChangedFiles: 10 },
      ),
      (err: unknown) => err instanceof BridgeError && err.code === 'COPY_LIMIT_EXCEEDED',
    );
  } finally {
    await cleanupTempDir(copyDir);
  }
});

test('verification rejects modified, deleted, untracked extra files, and unsafe manifests', async () => {
  const copyDir = await createTempDir();
  try {
    const bundles: ProvidedSkill[] = [
      {
        name: 'tamper-test',
        content: '---\nname: tamper-test\n---\n# Tamper Test',
        resources: [{ path: 'refs/doc.txt', content: 'original text' }],
      },
    ];

    const staged = await stageProvidedSkills(copyDir, bundles);
    await verifyProvidedSkills(copyDir, staged);

    const docPath = path.join(copyDir, '.agents', 'skills', 'tamper-test', 'refs', 'doc.txt');
    await writeFile(docPath, 'modified text');
    await assert.rejects(
      verifyProvidedSkills(copyDir, staged),
      (err: unknown) => err instanceof BridgeError && err.code === 'SKILL_VERIFICATION_FAILED',
    );
    await writeFile(docPath, 'original text');

    await unlink(docPath);
    await assert.rejects(
      verifyProvidedSkills(copyDir, staged),
      (err: unknown) => err instanceof BridgeError && err.code === 'SKILL_VERIFICATION_FAILED',
    );
    await writeFile(docPath, 'original text');

    const extraFilePath = path.join(copyDir, '.agents', 'skills', 'tamper-test', 'untracked.sh');
    await writeFile(extraFilePath, '#!/bin/sh\necho "injected"');
    await assert.rejects(
      verifyProvidedSkills(copyDir, staged),
      (err: unknown) => err instanceof BridgeError && err.code === 'SKILL_VERIFICATION_FAILED',
    );
    await unlink(extraFilePath);

    const tamperedManifest: StagedSkill[] = [
      {
        ...staged[0]!,
        files: staged[0]!.files.map(f => ({ ...f, sha256: '0'.repeat(64) })),
      },
    ];
    await assert.rejects(
      verifyProvidedSkills(copyDir, tamperedManifest),
      (err: unknown) => err instanceof BridgeError && err.code === 'UNSAFE_SKILL_MANIFEST',
    );

    await assert.rejects(
      verifyProvidedSkills(copyDir, [{ name: 'Invalid_Name!', sha256: '0'.repeat(64), files: [] }]),
      (err: unknown) => err instanceof BridgeError && err.code === 'UNSAFE_SKILL_MANIFEST',
    );

    const escapedManifest: StagedSkill[] = [
      {
        name: 'tamper-test',
        sha256: '0'.repeat(64),
        files: [{ path: '.agents/skills/other-skill/SKILL.md', sha256: '0'.repeat(64) }],
      },
    ];
    await assert.rejects(
      verifyProvidedSkills(copyDir, escapedManifest),
      (err: unknown) => err instanceof BridgeError && err.code === 'UNSAFE_SKILL_MANIFEST',
    );
  } finally {
    await cleanupTempDir(copyDir);
  }
});

test('verification rejects hardlink substitution (nlink > 1)', async () => {
  const copyDir = await createTempDir();
  try {
    const staged = await stageProvidedSkills(copyDir, [
      {
        name: 'hardlink-test',
        content: '---\nname: hardlink-test\n---\n# Hardlink Test',
        resources: [{ path: 'refs/doc.txt', content: 'test content' }],
      },
    ]);
    await verifyProvidedSkills(copyDir, staged);

    const sourceFile = path.join(copyDir, '.agents', 'skills', 'hardlink-test', 'refs', 'doc.txt');
    const outsideHardlink = path.join(copyDir, 'outside-link.txt');
    await link(sourceFile, outsideHardlink);

    await assert.rejects(
      verifyProvidedSkills(copyDir, staged),
      (err: unknown) => err instanceof BridgeError && err.code === 'SKILL_VERIFICATION_FAILED',
    );
    await unlink(outsideHardlink);
  } finally {
    await cleanupTempDir(copyDir);
  }
});

test('verification rejects symbolic links in skill directory', async (t) => {
  const copyDir = await createTempDir();
  try {
    const staged = await stageProvidedSkills(copyDir, [
      {
        name: 'symlink-test',
        content: '---\nname: symlink-test\n---\n# Symlink Test',
        resources: [{ path: 'ref.txt', content: 'test' }],
      },
    ]);
    const target = path.join(copyDir, '.agents', 'skills', 'symlink-test', 'ref.txt');
    const linkPath = path.join(copyDir, '.agents', 'skills', 'symlink-test', 'link.txt');
    try {
      await symlink(target, linkPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'ENOTSUP') {
        t.skip('Symlink creation unavailable in current OS environment');
        return;
      }
      throw err;
    }
    await assert.rejects(
      verifyProvidedSkills(copyDir, staged),
      (err: unknown) => err instanceof BridgeError && err.code === 'SKILL_VERIFICATION_FAILED',
    );
  } finally {
    await cleanupTempDir(copyDir);
  }
});

test('verification rejects unsafe manifest with backslash and Windows ADS', async () => {
  const copyDir = await createTempDir();
  try {
    const staged = await stageProvidedSkills(copyDir, [
      {
        name: 'manifest-test',
        content: '---\nname: manifest-test\n---\n# Manifest Test',
      },
    ]);

    // Backslash in manifest path
    const backslashManifest: StagedSkill[] = [
      {
        name: 'manifest-test',
        sha256: staged[0]!.sha256,
        files: [
          staged[0]!.files[0]!,
          { path: '.agents/skills/manifest-test\\sub/file.txt', sha256: '0'.repeat(64) },
        ],
      },
    ];
    await assert.rejects(
      verifyProvidedSkills(copyDir, backslashManifest),
      (err: unknown) => err instanceof BridgeError && err.code === 'UNSAFE_SKILL_MANIFEST',
    );

    // Windows ADS in manifest path
    const adsManifest: StagedSkill[] = [
      {
        name: 'manifest-test',
        sha256: staged[0]!.sha256,
        files: [
          staged[0]!.files[0]!,
          { path: '.agents/skills/manifest-test/file.txt:stream', sha256: '0'.repeat(64) },
        ],
      },
    ];
    await assert.rejects(
      verifyProvidedSkills(copyDir, adsManifest),
      (err: unknown) => err instanceof BridgeError && err.code === 'UNSAFE_SKILL_MANIFEST',
    );
  } finally {
    await cleanupTempDir(copyDir);
  }
});

test('verification bounds scan by rejecting unexpected directories and enforces file limits', async () => {
  const copyDir = await createTempDir();
  try {
    const staged = await stageProvidedSkills(copyDir, [
      {
        name: 'bounded-test',
        content: '---\nname: bounded-test\n---\n# Bounded Test',
      },
    ]);

    // Unexpected directory injection
    const unexpectedDir = path.join(copyDir, '.agents', 'skills', 'bounded-test', 'injected-dir');
    await mkdir(unexpectedDir);
    await assert.rejects(
      verifyProvidedSkills(copyDir, staged),
      (err: unknown) => err instanceof BridgeError && err.code === 'SKILL_VERIFICATION_FAILED',
    );
    await rm(unexpectedDir, { recursive: true, force: true });

    // Manifest exceeding 101 files
    const tooManyFilesManifest: StagedSkill[] = [
      {
        name: 'bounded-test',
        sha256: '0'.repeat(64),
        files: Array.from({ length: 102 }, (_, i) => ({
          path: `.agents/skills/bounded-test/${i === 0 ? 'SKILL.md' : `file-${i}.txt`}`,
          sha256: '0'.repeat(64),
        })),
      },
    ];
    await assert.rejects(
      verifyProvidedSkills(copyDir, tooManyFilesManifest),
      (err: unknown) => err instanceof BridgeError && err.code === 'UNSAFE_SKILL_MANIFEST',
    );
  } finally {
    await cleanupTempDir(copyDir);
  }
});

test('providedSkillsSchema zod schema parses valid array and rejects malformed inputs', () => {
  const valid = [
    {
      name: 'code-review',
      content: '---\nname: code-review\n---\n# Review',
      resources: [{ path: 'guide.md', content: 'guide' }],
    },
  ];

  const parsed = providedSkillsSchema.parse(valid);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.name, 'code-review');

  assert.throws(() =>
    providedSkillsSchema.parse(
      Array.from({ length: 9 }, (_, i) => ({
        name: `skill-${i}`,
        content: `content-${i}`,
      })),
    ),
  );

  assert.throws(() =>
    providedSkillsSchema.parse([
      {
        name: 'Invalid_Slug!',
        content: 'content',
      },
    ]),
  );

  assert.throws(() =>
    providedSkillsSchema.parse([
      {
        name: 'test-skill',
        content: 'content',
        resources: [{ path: '', content: 'empty' }],
      },
    ]),
  );
});


test('preserves Codex skill name case and exact content using a lowercase directory', async () => {
  const copyDir = await createTempDir();
  const content = '---\nname: Presentations\ndescription: Create slide decks\n---\n# Presentations\nPreserve these bytes. 📊';
  try {
    const input = providedSkillsSchema.parse([{ name: 'Presentations', content }]);
    const staged = await stageProvidedSkills(copyDir, input);
    assert.equal(staged[0]!.name, 'Presentations');
    assert.equal(staged[0]!.files[0]!.path, '.agents/skills/presentations/SKILL.md');
    assert.equal(await readFile(path.join(copyDir, '.agents/skills/presentations/SKILL.md'), 'utf8'), content);
    await verifyProvidedSkills(copyDir, staged);
  } finally { await cleanupTempDir(copyDir); }
});

test('rejects case aliases between supplied skills before writing', async () => {
  const copyDir = await createTempDir();
  try {
    await assert.rejects(stageProvidedSkills(copyDir, [
      { name: 'Presentations', content: '---\nname: Presentations\n---\nA' },
      { name: 'presentations', content: '---\nname: presentations\n---\nB' },
    ]), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SKILL_INPUT');
    await assert.rejects(readFile(path.join(copyDir, '.agents/skills/presentations/SKILL.md')), { code: 'ENOENT' });
  } finally { await cleanupTempDir(copyDir); }
});

test('rejects Windows directory junctions before staging supplied files', { skip: process.platform !== 'win32' }, async () => {
  const copyDir = await createTempDir();
  const outside = await createTempDir();
  const junction = path.join(copyDir, '.agents');
  try {
    await symlink(outside, junction, 'junction');
    await assert.rejects(stageProvidedSkills(copyDir, [{ name: 'safe-skill', content: '---\nname: safe-skill\n---\nSafe' }]),
      (err: unknown) => err instanceof BridgeError && err.code === 'UNSAFE_PROJECT_PATH');
    await assert.rejects(readFile(path.join(outside, 'skills/safe-skill/SKILL.md')), { code: 'ENOENT' });
  } finally {
    await unlink(junction);
    await cleanupTempDir(copyDir);
    await cleanupTempDir(outside);
  }
});
