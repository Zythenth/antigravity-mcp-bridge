import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  artifactPathsSchema,
  artifactReferenceSchema,
  collectArtifacts,
  readArtifact,
  validArtifactRelative,
  type ArtifactReference,
} from '../src/artifacts.js';
import { createProjectCopy, discardProjectCopy, type ProjectCopy } from '../src/isolation.js';
import { DEFAULT_PROJECT_LIMITS, type ProjectLimits } from '../src/config.js';
import { BridgeError } from '../src/types.js';

async function createTempRepo(prefix = 'agy-artifacts-test-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', dir]);
  execFileSync('git', ['config', 'user.name', 'Bridge Test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@invalid.local'], { cwd: dir });
  return dir;
}

async function cleanupTempDir(dir: string): Promise<void> {
  const resolved = path.resolve(dir);
  const tempRoot = path.resolve(os.tmpdir());
  const rel = path.relative(tempRoot, resolved);
  if (!rel || rel.startsWith('..') || rel.includes(path.sep) || rel.includes('/') || !path.basename(resolved).startsWith('agy-artifacts-test-')) {
    throw new Error(`Refusing to remove directory outside temporary storage: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

test('validArtifactRelative validates and normalizes relative paths, rejecting dangerous characters', () => {
  assert.equal(validArtifactRelative('dir\\file.txt'), 'dir/file.txt');
  assert.equal(validArtifactRelative('simple.txt'), 'simple.txt');

  // Colons / Alternate Data Streams (ADS)
  assert.throws(
    () => validArtifactRelative('file.txt:stream'),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ARTIFACT_PATH' && err.message.includes('Colon')
  );

  // Control characters / NUL
  assert.throws(
    () => validArtifactRelative('file\x00.txt'),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ARTIFACT_PATH' && err.message.includes('Control')
  );
  assert.throws(
    () => validArtifactRelative('file\n.txt'),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ARTIFACT_PATH'
  );

  // Trailing dots and spaces
  assert.throws(
    () => validArtifactRelative('file.txt.'),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ARTIFACT_PATH' && err.message.includes('dot or space')
  );
  assert.throws(
    () => validArtifactRelative('dir /file.txt'),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ARTIFACT_PATH'
  );

  // Traversal
  assert.throws(
    () => validArtifactRelative('../outside.txt'),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ARTIFACT_PATH'
  );

  // Device names
  assert.throws(
    () => validArtifactRelative('CON.txt'),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ARTIFACT_PATH'
  );

  // Nested .git and .agents
  assert.throws(
    () => validArtifactRelative('sub/.git/config'),
    (err: unknown) => err instanceof BridgeError && err.code === 'UNSAFE_ARTIFACT_PATH'
  );
  assert.throws(
    () => validArtifactRelative('sub/.agents/skills'),
    (err: unknown) => err instanceof BridgeError && err.code === 'UNSAFE_ARTIFACT_PATH'
  );
});

test('artifactPathsSchema validates 1..100 relative paths and rejects case aliases', () => {
  assert.ok(artifactPathsSchema.safeParse(['file.txt', 'docs/manual.md']).success);

  // Empty array
  assert.ok(!artifactPathsSchema.safeParse([]).success);

  // Exceeds 100 paths
  const over100 = Array.from({ length: 101 }, (_, i) => `file_${i}.txt`);
  assert.ok(!artifactPathsSchema.safeParse(over100).success);

  // Duplicate paths
  assert.ok(!artifactPathsSchema.safeParse(['file.txt', 'file.txt']).success);

  // Windows case alias duplicate
  assert.ok(!artifactPathsSchema.safeParse(['file.txt', 'FILE.TXT']).success);
  assert.ok(!artifactPathsSchema.safeParse(['docs/file.txt', 'DOCS/file.txt']).success);

  // Directory paths ending with slash
  assert.ok(!artifactPathsSchema.safeParse(['dir/']).success);
});

test('artifactReferenceSchema validates schema bounds', () => {
  const validRef: ArtifactReference = {
    path: 'output/result.json',
    sha256: 'a'.repeat(64),
    bytes: 1024,
  };
  assert.ok(artifactReferenceSchema.safeParse(validRef).success);

  // Invalid hash
  assert.ok(!artifactReferenceSchema.safeParse({ ...validRef, sha256: 'not-a-hash' }).success);

  // Negative bytes
  assert.ok(!artifactReferenceSchema.safeParse({ ...validRef, bytes: -1 }).success);
});

test('collectArtifacts collects existing and new non-ignored files with streaming hashes', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    await writeFile(path.join(repo, 'README.md'), '# Test Project');
    await writeFile(path.join(repo, '.gitignore'), '*.log\nignored-dir/\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    project = await createProjectCopy(repo);

    const artifactContent = 'Output artifact generated by task\nLine 2';
    const subDir = path.join(project.copyDirectory, 'output');
    await mkdir(subDir, { recursive: true });
    await writeFile(path.join(subDir, 'result.txt'), artifactContent, 'utf8');

    const refs = await collectArtifacts(project, ['README.md', 'output/result.txt'], DEFAULT_PROJECT_LIMITS);

    assert.equal(refs.length, 2);

    const readmeRef = refs.find(r => r.path === 'README.md');
    assert.ok(readmeRef);
    assert.equal(readmeRef.sha256, sha256Buffer(Buffer.from('# Test Project', 'utf8')));
    assert.equal(readmeRef.bytes, Buffer.byteLength('# Test Project', 'utf8'));

    const resultRef = refs.find(r => r.path === 'output/result.txt');
    assert.ok(resultRef);
    assert.equal(resultRef.sha256, sha256Buffer(Buffer.from(artifactContent, 'utf8')));
    assert.equal(resultRef.bytes, Buffer.byteLength(artifactContent, 'utf8'));
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('adversarial: collectArtifacts rejects explicit ignored tracked file', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    // Commit a file first
    await writeFile(path.join(repo, 'tracked-ignored.txt'), 'tracked but should be ignored');
    execFileSync('git', ['add', 'tracked-ignored.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'add file'], { cwd: repo });

    // Now ignore it explicitly in .gitignore
    await writeFile(path.join(repo, '.gitignore'), 'tracked-ignored.txt\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'ignore tracked file'], { cwd: repo });

    project = await createProjectCopy(repo);

    await assert.rejects(
      collectArtifacts(project, ['tracked-ignored.txt'], DEFAULT_PROJECT_LIMITS),
      (err: unknown) => err instanceof BridgeError && err.code === 'IGNORED_ARTIFACT_PATH'
    );
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('adversarial: collectArtifacts rejects new file ignored by .git/info/exclude', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    await writeFile(path.join(repo, 'base.txt'), 'base');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    // Add local exclude rule to .git/info/exclude
    await writeFile(path.join(repo, '.git', 'info', 'exclude'), 'local-secret.txt\n');

    project = await createProjectCopy(repo);

    // Create the excluded file in copyDirectory
    await writeFile(path.join(project.copyDirectory, 'local-secret.txt'), 'top secret');

    await assert.rejects(
      collectArtifacts(project, ['local-secret.txt'], DEFAULT_PROJECT_LIMITS),
      (err: unknown) => err instanceof BridgeError && err.code === 'IGNORED_ARTIFACT_PATH'
    );
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('adversarial: rejects case aliases on disk', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    await writeFile(path.join(repo, 'exact-name.txt'), 'data');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    project = await createProjectCopy(repo);

    // Requesting with different casing (EXACT-NAME.txt) must fail
    await assert.rejects(
      collectArtifacts(project, ['EXACT-NAME.txt'], DEFAULT_PROJECT_LIMITS),
      (err: unknown) => err instanceof BridgeError && (err.code === 'INVALID_ARTIFACT_PATH' || err.code === 'ARTIFACT_NOT_FOUND')
    );
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('adversarial: collectArtifacts rejects symlinks', async (t) => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    await writeFile(path.join(repo, 'base.txt'), 'base content');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    project = await createProjectCopy(repo);

    try {
      await symlink(path.join(project.copyDirectory, 'base.txt'), path.join(project.copyDirectory, 'link.txt'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM' || (err as NodeJS.ErrnoException).code === 'ENOTSUP') {
        t.skip('Symlinks not supported on this platform');
        return;
      }
      throw err;
    }

    await assert.rejects(
      collectArtifacts(project, ['link.txt'], DEFAULT_PROJECT_LIMITS),
      (err: unknown) => err instanceof BridgeError && err.code === 'UNSAFE_PROJECT_PATH'
    );
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('adversarial: rejects replaced copy-root directory', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    await writeFile(path.join(repo, 'base.txt'), 'base');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    project = await createProjectCopy(repo);

    const corruptProject: ProjectCopy = {
      ...project,
      copyDirectory: path.join(repo, 'base.txt'), // Points to a file instead of directory
    };

    await assert.rejects(
      collectArtifacts(corruptProject, ['base.txt'], DEFAULT_PROJECT_LIMITS),
      (err: unknown) => err instanceof BridgeError && err.code === 'UNSAFE_PROJECT_PATH'
    );
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('collectArtifacts enforces limits.maxCopyBytes cap', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    await writeFile(path.join(repo, 'base.txt'), 'a'.repeat(200));
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    project = await createProjectCopy(repo);

    const restrictiveLimits: ProjectLimits = {
      maxCopyBytes: 100,
      maxCopyFiles: 10,
      maxChangedFiles: 10,
    };

    await assert.rejects(
      collectArtifacts(project, ['base.txt'], restrictiveLimits),
      (err: unknown) => err instanceof BridgeError && err.code === 'COPY_LIMIT_EXCEEDED'
    );
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('readArtifact returns base64 window without full readFile and handles pagination', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    const bigContent = Buffer.alloc(70_000, 0x42); // 70,000 bytes
    await writeFile(path.join(repo, 'big.bin'), bigContent);
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    project = await createProjectCopy(repo);

    const [ref] = await collectArtifacts(project, ['big.bin'], DEFAULT_PROJECT_LIMITS);
    assert.ok(ref);
    assert.equal(ref.bytes, 70_000);

    // Read chunk 1 (limit 65536)
    const chunk1 = await readArtifact(project, ref, ref.sha256, 0, 65536);
    assert.equal(chunk1.path, 'big.bin');
    assert.equal(chunk1.sha256, ref.sha256);
    assert.equal(chunk1.offset, 0);
    assert.equal(chunk1.nextOffset, 65536);
    assert.equal(chunk1.hasMore, true);
    assert.equal(chunk1.encoding, 'base64');
    assert.equal(chunk1.offsetUnit, 'bytes');

    const buf1 = Buffer.from(chunk1.content, 'base64');
    assert.equal(buf1.length, 65536);

    // Read chunk 2
    const chunk2 = await readArtifact(project, ref, ref.sha256, chunk1.nextOffset, 65536);
    assert.equal(chunk2.offset, 65536);
    assert.equal(chunk2.nextOffset, 70000);
    assert.equal(chunk2.hasMore, false);

    const buf2 = Buffer.from(chunk2.content, 'base64');
    assert.equal(buf2.length, 4464);

    const combined = Buffer.concat([buf1, buf2]);
    assert.deepEqual(combined, bigContent);
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('readArtifact rejects when file grew beyond authorized reference size', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    await writeFile(path.join(repo, 'dynamic.txt'), 'original 10 bytes');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    project = await createProjectCopy(repo);
    const [ref] = await collectArtifacts(project, ['dynamic.txt'], DEFAULT_PROJECT_LIMITS);
    assert.ok(ref);

    // Mutate file on disk to grow
    await writeFile(path.join(project.copyDirectory, 'dynamic.txt'), 'original 10 bytes and now much bigger data attached');

    await assert.rejects(
      readArtifact(project, ref, ref.sha256, 0),
      (err: unknown) => err instanceof BridgeError && err.code === 'CONTENT_CHANGED'
    );
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('readArtifact enforces maxBytes before allocation and during streaming', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    await writeFile(path.join(repo, 'data.bin'), Buffer.alloc(1000));
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    project = await createProjectCopy(repo);
    const [ref] = await collectArtifacts(project, ['data.bin'], DEFAULT_PROJECT_LIMITS);
    assert.ok(ref);

    // Pre-stat check catches > maxBytes before stream
    await assert.rejects(
      readArtifact(project, ref, ref.sha256, 0, 65536, 500),
      (err: unknown) => err instanceof BridgeError && err.code === 'COPY_LIMIT_EXCEEDED'
    );
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('readArtifact validates reference via artifactReferenceSchema and safe integers', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    await writeFile(path.join(repo, 'sample.txt'), 'hello world');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    project = await createProjectCopy(repo);
    const [ref] = await collectArtifacts(project, ['sample.txt'], DEFAULT_PROJECT_LIMITS);
    assert.ok(ref);

    // Invalid reference
    await assert.rejects(
      readArtifact(project, { ...ref, sha256: 'invalid' }, ref.sha256, 0),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ARTIFACT_REFERENCE'
    );

    // Negative offset
    await assert.rejects(
      readArtifact(project, ref, ref.sha256, -1),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_CURSOR'
    );

    // Non-integer offset
    await assert.rejects(
      readArtifact(project, ref, ref.sha256, 2.5),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_CURSOR'
    );

    // Offset beyond file size
    await assert.rejects(
      readArtifact(project, ref, ref.sha256, 100),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_CURSOR'
    );

    // Limit 0 or > 65536
    await assert.rejects(
      readArtifact(project, ref, ref.sha256, 0, 0),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_CURSOR'
    );
    await assert.rejects(
      readArtifact(project, ref, ref.sha256, 0, 65537),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_CURSOR'
    );
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('artifact readers reject same-size mutations and mismatched expected hashes', async () => {
  const repo = await createTempRepo(); let project: ProjectCopy | undefined;
  try {
    await writeFile(path.join(repo, 'result.txt'), 'original');
    project = await createProjectCopy(repo);
    const [reference] = await collectArtifacts(project, ['result.txt']); assert.ok(reference);
    await assert.rejects(readArtifact(project, reference, '0'.repeat(64)), { code: 'CONTENT_CHANGED' });
    await writeFile(path.join(project.copyDirectory, 'result.txt'), 'tampered');
    await assert.rejects(readArtifact(project, reference, reference.sha256), { code: 'CONTENT_CHANGED' });
  } finally { if (project) await discardProjectCopy(project); await cleanupTempDir(repo); }
});

test('artifact paths reject directory links before enumerating files outside the copy', async t => {
  const repo = await createTempRepo(); let project: ProjectCopy | undefined;
  try {
    await writeFile(path.join(repo, 'base.txt'), 'public fixture');
    const external = path.join(repo, 'excluded'); await mkdir(external);
    await writeFile(path.join(external, 'SensitiveName.txt'), 'excluded fixture');
    await writeFile(path.join(repo, '.gitignore'), 'excluded/\n');
    project = await createProjectCopy(repo);
    try { await symlink(external, path.join(project.copyDirectory, 'alias'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Directory links unavailable'); return; } throw error; }
    await assert.rejects(collectArtifacts(project, ['alias/sensitivename.txt']), { code: 'UNSAFE_PROJECT_PATH' });
    await assert.rejects(readArtifact(project, { path: 'alias/sensitivename.txt', bytes: 16, sha256: 'a'.repeat(64) }, 'a'.repeat(64)), { code: 'UNSAFE_PROJECT_PATH' });
  } finally { if (project) await discardProjectCopy(project); await cleanupTempDir(repo); }
});
