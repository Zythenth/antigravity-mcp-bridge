import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fsPromises, { mkdtemp, mkdir, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
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
  await writeFile(path.join(dir, 'base.txt'), 'base repository content\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
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

  assert.throws(
    () => validArtifactRelative('file.txt:stream'),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ARTIFACT_PATH' && err.message.includes('Colon')
  );

  assert.throws(
    () => validArtifactRelative('file\x00.txt'),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ARTIFACT_PATH' && err.message.includes('Control')
  );
  assert.throws(
    () => validArtifactRelative('file\n.txt'),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ARTIFACT_PATH'
  );

  assert.throws(
    () => validArtifactRelative('file.txt.'),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ARTIFACT_PATH' && err.message.includes('dot or space')
  );
  assert.throws(
    () => validArtifactRelative('dir /file.txt'),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ARTIFACT_PATH'
  );

  assert.throws(
    () => validArtifactRelative('../outside.txt'),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ARTIFACT_PATH'
  );

  assert.throws(
    () => validArtifactRelative('CON.txt'),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ARTIFACT_PATH'
  );

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

  assert.ok(!artifactPathsSchema.safeParse([]).success);

  const over100 = Array.from({ length: 101 }, (_, i) => `file_${i}.txt`);
  assert.ok(!artifactPathsSchema.safeParse(over100).success);

  assert.ok(!artifactPathsSchema.safeParse(['file.txt', 'file.txt']).success);

  assert.ok(!artifactPathsSchema.safeParse(['file.txt', 'FILE.TXT']).success);
  assert.ok(!artifactPathsSchema.safeParse(['docs/file.txt', 'DOCS/file.txt']).success);

  assert.ok(!artifactPathsSchema.safeParse(['dir/']).success);
});

test('artifactReferenceSchema validates schema bounds', () => {
  const validRef: ArtifactReference = {
    path: 'output/result.json',
    sha256: 'a'.repeat(64),
    bytes: 1024,
  };
  assert.ok(artifactReferenceSchema.safeParse(validRef).success);

  assert.ok(!artifactReferenceSchema.safeParse({ ...validRef, sha256: 'not-a-hash' }).success);

  assert.ok(!artifactReferenceSchema.safeParse({ ...validRef, bytes: -1 }).success);
});

test('collectArtifacts collects existing and new non-ignored files with streaming hashes', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    await writeFile(path.join(repo, 'README.md'), '# Test Project');
    await writeFile(path.join(repo, '.gitignore'), '*.log\nignored-dir/\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init-test'], { cwd: repo });

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
    await writeFile(path.join(repo, 'tracked-ignored.txt'), 'tracked but should be ignored');
    execFileSync('git', ['add', 'tracked-ignored.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'add file'], { cwd: repo });

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
    await writeFile(path.join(repo, 'sub.txt'), 'sub');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'commit-sub'], { cwd: repo });

    await mkdir(path.join(repo, '.git', 'info'), { recursive: true });
    await writeFile(path.join(repo, '.git', 'info', 'exclude'), 'local-secret.txt\n');

    project = await createProjectCopy(repo);

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

test('git ignore: generated or modified .gitignore in copy rejects collection and reading forged refs, while permitting safe positive output', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    project = await createProjectCopy(repo);

    await writeFile(path.join(project.copyDirectory, '.gitignore'), 'output-ignored.txt\n');
    await writeFile(path.join(project.copyDirectory, 'output-ignored.txt'), 'generated ignored output\n');
    await writeFile(path.join(project.copyDirectory, 'output-safe.txt'), 'safe public output\n');

    await assert.rejects(
      collectArtifacts(project, ['output-ignored.txt'], DEFAULT_PROJECT_LIMITS),
      (err: unknown) => err instanceof BridgeError && err.code === 'IGNORED_ARTIFACT_PATH'
    );

    const forgedRef: ArtifactReference = {
      path: 'output-ignored.txt',
      sha256: sha256Buffer(Buffer.from('generated ignored output\n', 'utf8')),
      bytes: Buffer.byteLength('generated ignored output\n', 'utf8'),
    };
    await assert.rejects(
      readArtifact(project, forgedRef, forgedRef.sha256),
      (err: unknown) => err instanceof BridgeError && err.code === 'IGNORED_ARTIFACT_PATH'
    );

    const [safeRef] = await collectArtifacts(project, ['output-safe.txt'], DEFAULT_PROJECT_LIMITS);
    assert.ok(safeRef);
    assert.equal(safeRef.path, 'output-safe.txt');

    const readResult = await readArtifact(project, safeRef, safeRef.sha256, 0, 65536);
    assert.equal(readResult.path, 'output-safe.txt');
    assert.equal(readResult.hasMore, false);
    assert.equal(Buffer.from(readResult.content, 'base64').toString('utf8'), 'safe public output\n');
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
    execFileSync('git', ['commit', '-m', 'add-exact'], { cwd: repo });

    project = await createProjectCopy(repo);

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
    project = await createProjectCopy(repo);

    const corruptProject: ProjectCopy = {
      ...project,
      copyDirectory: path.join(repo, 'base.txt'),
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
    await writeFile(path.join(repo, 'large.txt'), 'a'.repeat(200));
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'add-large'], { cwd: repo });

    project = await createProjectCopy(repo);

    const restrictiveLimits: ProjectLimits = {
      maxCopyBytes: 100,
      maxCopyFiles: 10,
      maxChangedFiles: 10,
    };

    await assert.rejects(
      collectArtifacts(project, ['large.txt'], restrictiveLimits),
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
    const bigContent = Buffer.alloc(70_000, 0x42);
    await writeFile(path.join(repo, 'big.bin'), bigContent);
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'add-big'], { cwd: repo });

    project = await createProjectCopy(repo);

    const [ref] = await collectArtifacts(project, ['big.bin'], DEFAULT_PROJECT_LIMITS);
    assert.ok(ref);
    assert.equal(ref.bytes, 70_000);

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
    execFileSync('git', ['commit', '-m', 'add-dynamic'], { cwd: repo });

    project = await createProjectCopy(repo);
    const [ref] = await collectArtifacts(project, ['dynamic.txt'], DEFAULT_PROJECT_LIMITS);
    assert.ok(ref);

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
    execFileSync('git', ['commit', '-m', 'add-data'], { cwd: repo });

    project = await createProjectCopy(repo);
    const [ref] = await collectArtifacts(project, ['data.bin'], DEFAULT_PROJECT_LIMITS);
    assert.ok(ref);

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
    execFileSync('git', ['commit', '-m', 'add-sample'], { cwd: repo });

    project = await createProjectCopy(repo);
    const [ref] = await collectArtifacts(project, ['sample.txt'], DEFAULT_PROJECT_LIMITS);
    assert.ok(ref);

    await assert.rejects(
      readArtifact(project, { ...ref, sha256: 'invalid' }, ref.sha256, 0),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_ARTIFACT_REFERENCE'
    );

    await assert.rejects(
      readArtifact(project, ref, ref.sha256, -1),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_CURSOR'
    );

    await assert.rejects(
      readArtifact(project, ref, ref.sha256, 2.5),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_CURSOR'
    );

    await assert.rejects(
      readArtifact(project, ref, ref.sha256, 100),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_CURSOR'
    );

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
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;
  try {
    await writeFile(path.join(repo, 'result.txt'), 'original');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'add-result'], { cwd: repo });

    project = await createProjectCopy(repo);
    const [reference] = await collectArtifacts(project, ['result.txt']);
    assert.ok(reference);
    await assert.rejects(readArtifact(project, reference, '0'.repeat(64)), { code: 'CONTENT_CHANGED' });
    await writeFile(path.join(project.copyDirectory, 'result.txt'), 'tampered');
    await assert.rejects(readArtifact(project, reference, reference.sha256), { code: 'CONTENT_CHANGED' });
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('artifact paths reject directory links before enumerating files outside the copy', async (t) => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;
  try {
    const external = path.join(repo, 'excluded');
    await mkdir(external);
    const targetContent = 'excluded fixture';
    const baseFile = path.join(repo, 'base.txt');
    await writeFile(baseFile, targetContent);
    await fsPromises.link(baseFile, path.join(external, 'SensitiveName.txt'));
    await writeFile(path.join(repo, '.gitignore'), 'excluded/\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'add-excluded-ignore'], { cwd: repo });

    project = await createProjectCopy(repo);
    try {
      await symlink(external, path.join(project.copyDirectory, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('Directory links unavailable');
        return;
      }
      throw error;
    }
    await assert.rejects(collectArtifacts(project, ['alias/sensitivename.txt']), { code: 'UNSAFE_PROJECT_PATH' });
    await assert.rejects(readArtifact(project, { path: 'alias/sensitivename.txt', bytes: 16, sha256: 'a'.repeat(64) }, 'a'.repeat(64)), { code: 'UNSAFE_PROJECT_PATH' });
    await assert.rejects(collectArtifacts(project, ['alias/SensitiveName.txt']), { code: 'UNSAFE_PROJECT_PATH' });
    await assert.rejects(readArtifact(project, { path: 'alias/SensitiveName.txt', bytes: 16, sha256: 'a'.repeat(64) }, 'a'.repeat(64)), { code: 'UNSAFE_PROJECT_PATH' });
    await assert.rejects(collectArtifacts(project, ['excluded/SensitiveName.txt']), { code: 'IGNORED_ARTIFACT_PATH' });
    await assert.rejects(readArtifact(project, { path: 'excluded/SensitiveName.txt', bytes: 16, sha256: 'a'.repeat(64) }, 'a'.repeat(64)), { code: 'IGNORED_ARTIFACT_PATH' });

    const [baseRef] = await collectArtifacts(project, ['base.txt']);
    assert.ok(baseRef);
    const baseRead = await readArtifact(project, baseRef, baseRef.sha256);
    assert.equal(Buffer.from(baseRead.content, 'base64').toString('utf8'), targetContent);
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('collectArtifacts rejects credential files by name and high-confidence content with metadata-only error', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    project = await createProjectCopy(repo);

    await writeFile(path.join(project.copyDirectory, '.env'), 'APP_ENV=production\n');

    const pemContent = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0m...\n-----END RSA PRIVATE KEY-----\n';
    await writeFile(path.join(project.copyDirectory, 'server.key'), pemContent);

    const stripeConfig = 'secret_key = ' + 'sk_' + 'live_' + '123456789012345678901234\n';
    await writeFile(path.join(project.copyDirectory, 'stripe.conf'), stripeConfig);

    await assert.rejects(
      collectArtifacts(project, ['.env'], DEFAULT_PROJECT_LIMITS),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'BLOCKED_ARTIFACT_PATH');
        assert.ok(!err.message.includes('production'));
        return true;
      }
    );

    await assert.rejects(
      collectArtifacts(project, ['server.key'], DEFAULT_PROJECT_LIMITS),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'BLOCKED_ARTIFACT_PATH');
        assert.ok(!err.message.includes('MIIEowIBAAKCAQEA0m'));
        return true;
      }
    );

    await assert.rejects(
      collectArtifacts(project, ['stripe.conf'], DEFAULT_PROJECT_LIMITS),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'BLOCKED_ARTIFACT_PATH');
        assert.ok(!err.message.includes('sk_live_'));
        return true;
      }
    );
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('collectArtifacts and readArtifact honor secretExclusions and v2 secretExceptions', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    project = await createProjectCopy(repo);

    const harmlessEnvLocal = 'PORT=3000\nDEBUG=false\nAPP_NAME=test-app\n';
    await writeFile(path.join(project.copyDirectory, '.env.local'), harmlessEnvLocal);

    await writeFile(path.join(project.copyDirectory, 'output.custom'), 'custom data');

    await assert.rejects(
      collectArtifacts(project, ['.env.local'], DEFAULT_PROJECT_LIMITS),
      (err: unknown) => err instanceof BridgeError && err.code === 'BLOCKED_ARTIFACT_PATH'
    );

    const limitsWithException: ProjectLimits = {
      ...DEFAULT_PROJECT_LIMITS,
      secretExceptions: {
        version: 2 as const,
        namePatterns: ['.env.local'],
      },
    };

    const [envLocalRef] = await collectArtifacts(project, ['.env.local'], limitsWithException);
    assert.ok(envLocalRef);
    assert.equal(envLocalRef.path, '.env.local');

    const readResult = await readArtifact(
      project,
      envLocalRef,
      envLocalRef.sha256,
      0,
      65536,
      DEFAULT_PROJECT_LIMITS.maxCopyBytes,
      limitsWithException
    );
    assert.equal(Buffer.from(readResult.content, 'base64').toString('utf8'), harmlessEnvLocal);

    await writeFile(path.join(project.copyDirectory, '.env.local'), 'secret_key = ' + 'sk_' + 'live_' + '123456789012345678901234\n');
    await assert.rejects(
      collectArtifacts(project, ['.env.local'], limitsWithException),
      (err: unknown) => err instanceof BridgeError && err.code === 'BLOCKED_ARTIFACT_PATH'
    );

    const limitsWithExclusion: ProjectLimits = {
      ...DEFAULT_PROJECT_LIMITS,
      secretExclusions: ['*.custom'],
    };
    await assert.rejects(
      collectArtifacts(project, ['output.custom'], limitsWithExclusion),
      (err: unknown) => err instanceof BridgeError && err.code === 'BLOCKED_ARTIFACT_PATH'
    );
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('readArtifact rejects forged references bypassing ignore, exclusion, name, and content rules', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    await writeFile(path.join(repo, '.gitignore'), 'ignored.log\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'add gitignore'], { cwd: repo });

    project = await createProjectCopy(repo);

    await writeFile(path.join(project.copyDirectory, 'ignored.log'), 'sensitive log data\n');
    const forgedIgnoredRef: ArtifactReference = {
      path: 'ignored.log',
      sha256: sha256Buffer(Buffer.from('sensitive log data\n', 'utf8')),
      bytes: Buffer.byteLength('sensitive log data\n', 'utf8'),
    };
    await assert.rejects(
      readArtifact(project, forgedIgnoredRef, forgedIgnoredRef.sha256),
      (err: unknown) => err instanceof BridgeError && err.code === 'IGNORED_ARTIFACT_PATH'
    );

    await writeFile(path.join(project.copyDirectory, '.env'), 'SECRET_TOKEN=xyz\n');
    const forgedEnvRef: ArtifactReference = {
      path: '.env',
      sha256: sha256Buffer(Buffer.from('SECRET_TOKEN=xyz\n', 'utf8')),
      bytes: Buffer.byteLength('SECRET_TOKEN=xyz\n', 'utf8'),
    };
    await assert.rejects(
      readArtifact(project, forgedEnvRef, forgedEnvRef.sha256),
      (err: unknown) => err instanceof BridgeError && err.code === 'BLOCKED_ARTIFACT_PATH'
    );

    await writeFile(path.join(project.copyDirectory, 'rule.blocked'), 'secret payload\n');
    const forgedExcludedRef: ArtifactReference = {
      path: 'rule.blocked',
      sha256: sha256Buffer(Buffer.from('secret payload\n', 'utf8')),
      bytes: Buffer.byteLength('secret payload\n', 'utf8'),
    };
    const exclusionLimits: ProjectLimits = {
      ...DEFAULT_PROJECT_LIMITS,
      secretExclusions: ['*.blocked'],
    };
    await assert.rejects(
      readArtifact(project, forgedExcludedRef, forgedExcludedRef.sha256, 0, 65536, DEFAULT_PROJECT_LIMITS.maxCopyBytes, exclusionLimits),
      (err: unknown) => err instanceof BridgeError && err.code === 'BLOCKED_ARTIFACT_PATH'
    );
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('readArtifact honors lower of numeric maxBytes and policy maxCopyBytes cap', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    await writeFile(path.join(repo, 'payload.dat'), Buffer.alloc(400, 0x11));
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'add payload.dat'], { cwd: repo });

    project = await createProjectCopy(repo);

    const [ref] = await collectArtifacts(project, ['payload.dat'], DEFAULT_PROJECT_LIMITS);
    assert.ok(ref);
    assert.equal(ref.bytes, 400);

    await assert.rejects(
      readArtifact(project, ref, ref.sha256, 0, 65536, 1000, {
        ...DEFAULT_PROJECT_LIMITS,
        maxCopyBytes: 250,
      }),
      (err: unknown) => err instanceof BridgeError && err.code === 'COPY_LIMIT_EXCEEDED'
    );

    await assert.rejects(
      readArtifact(project, ref, ref.sha256, 0, 65536, 250, {
        ...DEFAULT_PROJECT_LIMITS,
        maxCopyBytes: 1000,
      }),
      (err: unknown) => err instanceof BridgeError && err.code === 'COPY_LIMIT_EXCEEDED'
    );
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('adversarial: deterministic parent-directory junction swap during readArtifact open is rejected by post-open validation', async (t) => {
  const repo = await createTempRepo();
  const external = await mkdtemp(path.join(os.tmpdir(), 'agy-artifacts-ext-'));
  let project: ProjectCopy | undefined;
  const originalOpen = fsPromises.open;
  let swapped = false;
  let subDir = '';

  try {
    const targetContent = 'verified artifact content\n';
    project = await createProjectCopy(repo);

    subDir = path.join(project.copyDirectory, 'sub');
    await mkdir(subDir, { recursive: true });
    const localTarget = path.join(subDir, 'target.txt');
    await writeFile(localTarget, targetContent);

    const extTarget = path.join(external, 'target.txt');
    await fsPromises.link(localTarget, extTarget);
    const localIdentity = await fsPromises.stat(localTarget, { bigint: true });
    const externalIdentity = await fsPromises.stat(extTarget, { bigint: true });
    for (const field of ['ino', 'dev', 'size', 'mtimeNs'] as const) {
      assert.equal(externalIdentity[field], localIdentity[field], 'The race fixture must share the same file identity');
    }

    const [ref] = await collectArtifacts(project, ['sub/target.txt'], DEFAULT_PROJECT_LIMITS);
    assert.ok(ref);

    let openCount = 0;
    let skipped = false;
    fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
      const targetPath = String(args[0]);
      if (targetPath.includes('target.txt')) {
        openCount++;
        if (openCount === 2) {
          try {
            await rm(subDir, { recursive: true, force: true });
            await symlink(external, subDir, process.platform === 'win32' ? 'junction' : 'dir');
            swapped = true;
          } catch (err) {
            if (['EPERM', 'ENOTSUP'].includes((err as NodeJS.ErrnoException).code ?? '')) {
              skipped = true;
              t.skip('Directory links unavailable');
              return originalOpen(...args);
            }
            throw err;
          }
        }
      }
      return originalOpen(...args);
    }) as typeof originalOpen;
    syncBuiltinESMExports();

    try {
      await assert.rejects(
        readArtifact(project, ref, ref.sha256),
        (err: unknown) => err instanceof BridgeError && err.code === 'UNSAFE_PROJECT_PATH'
      );
      assert.equal(swapped, true, 'Deterministic junction swap must have occurred at the open boundary');
    } catch (err) {
      if (skipped) return;
      throw err;
    }
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();

    if (swapped && subDir) {
      try {
        await unlink(subDir);
      } catch {
        try {
          await rmdir(subDir);
        } catch {
          await rm(subDir, { recursive: false, force: true }).catch(() => {});
        }
      }
    }
    if (project) await discardProjectCopy(project);
    await rm(external, { recursive: true, force: true });
    await cleanupTempDir(repo);
  }
});

test('adversarial: deterministic junction swap fault injection during collectArtifacts preflight is rejected', async (t) => {
  const repo = await createTempRepo();
  const external = await mkdtemp(path.join(os.tmpdir(), 'agy-artifacts-ext-'));
  let project: ProjectCopy | undefined;
  const originalOpen = fsPromises.open;
  let swapped = false;
  let skipped = false;
  let subDir = '';

  try {
    const targetContent = 'collector candidate content\n';
    project = await createProjectCopy(repo);

    subDir = path.join(project.copyDirectory, 'sub');
    await mkdir(subDir, { recursive: true });
    const localTarget = path.join(subDir, 'target.txt');
    await writeFile(localTarget, targetContent);

    const extTarget = path.join(external, 'target.txt');
    await fsPromises.link(localTarget, extTarget);
    const localIdentity = await fsPromises.stat(localTarget, { bigint: true });
    const externalIdentity = await fsPromises.stat(extTarget, { bigint: true });
    for (const field of ['ino', 'dev', 'size', 'mtimeNs'] as const) {
      assert.equal(externalIdentity[field], localIdentity[field], 'The race fixture must share the same file identity');
    }

    fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
      const targetPath = String(args[0]);
      if (targetPath.includes('target.txt') && !swapped) {
        try {
          await rm(subDir, { recursive: true, force: true });
          await symlink(external, subDir, process.platform === 'win32' ? 'junction' : 'dir');
          swapped = true;
        } catch (err) {
          if (['EPERM', 'ENOTSUP'].includes((err as NodeJS.ErrnoException).code ?? '')) {
            skipped = true;
            t.skip('Directory links unavailable');
            return originalOpen(...args);
          }
          throw err;
        }
      }
      return originalOpen(...args);
    }) as typeof originalOpen;
    syncBuiltinESMExports();

    try {
      await assert.rejects(
        collectArtifacts(project, ['sub/target.txt'], DEFAULT_PROJECT_LIMITS),
        (err: unknown) => err instanceof BridgeError && err.code === 'UNSAFE_PROJECT_PATH'
      );
      assert.equal(swapped, true, 'Deterministic junction swap must have occurred at the open boundary');
    } catch (err) {
      if (skipped) return;
      throw err;
    }
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();

    if (swapped && subDir) {
      try {
        await unlink(subDir);
      } catch {
        try {
          await rmdir(subDir);
        } catch {
          await rm(subDir, { recursive: false, force: true }).catch(() => {});
        }
      }
    }
    if (project) await discardProjectCopy(project);
    await rm(external, { recursive: true, force: true });
    await cleanupTempDir(repo);
  }
});

test('adversarial: deterministic regular-file replacement between collect and read fails closed', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    project = await createProjectCopy(repo);

    const filePath = path.join(project.copyDirectory, 'replaceable.txt');
    await writeFile(filePath, 'original content here');

    const [ref] = await collectArtifacts(project, ['replaceable.txt'], DEFAULT_PROJECT_LIMITS);
    assert.ok(ref);

    await rm(filePath, { force: true });
    await writeFile(filePath, 'mutated file data now');

    await assert.rejects(
      readArtifact(project, ref, ref.sha256),
      (err: unknown) => err instanceof BridgeError && (err.code === 'CONTENT_CHANGED' || err.code === 'UNSAFE_PROJECT_PATH')
    );
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('readArtifact handles exact 64KiB chunk boundaries and EOF reads', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    const exact64K = Buffer.alloc(65536, 0x5a);
    await writeFile(path.join(repo, 'exact.bin'), exact64K);
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'add exact.bin'], { cwd: repo });

    project = await createProjectCopy(repo);

    const [ref] = await collectArtifacts(project, ['exact.bin'], DEFAULT_PROJECT_LIMITS);
    assert.ok(ref);
    assert.equal(ref.bytes, 65536);

    const chunk = await readArtifact(project, ref, ref.sha256, 0, 65536);
    assert.equal(chunk.offset, 0);
    assert.equal(chunk.nextOffset, 65536);
    assert.equal(chunk.hasMore, false);
    const decoded = Buffer.from(chunk.content, 'base64');
    assert.deepEqual(decoded, exact64K);

    const eofChunk = await readArtifact(project, ref, ref.sha256, 65536, 65536);
    assert.equal(eofChunk.offset, 65536);
    assert.equal(eofChunk.nextOffset, 65536);
    assert.equal(eofChunk.hasMore, false);
    assert.equal(eofChunk.content, '');
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});

test('collectArtifacts and readArtifact reject BOM/NUL-padded Unicode encoded credentials while preserving raw byte hash and identity for safe Unicode artifacts', async () => {
  const repo = await createTempRepo();
  let project: ProjectCopy | undefined;

  try {
    project = await createProjectCopy(repo);

    const pemBegin = '-----BEGIN ' + 'PRIVATE KEY-----\n';
    const pemEnd = '-----END ' + 'PRIVATE KEY-----\n';
    const pemMarker = 'BRIDGE_SYNTHETIC_ARTIFACT_ENCODED_KEY_01';
    const pemText = `${pemBegin}${pemMarker}\n${pemEnd}`;

    // UTF-16LE with BOM under neutral .txt name
    const utf16LeKeyBuf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(pemText, 'utf16le')]);
    await writeFile(path.join(project.copyDirectory, 'encoded-key.txt'), utf16LeKeyBuf);

    // UTF-16BE with BOM config secret
    const awsMarker = 'BRIDGESYNTHETICARTIFACTAWSKEY123456';
    const awsLe = Buffer.from(`AWS_SECRET_ACCESS_KEY=${awsMarker}\n`, 'utf16le');
    const awsBe = Buffer.alloc(awsLe.length);
    for (let i = 0; i < awsLe.length; i += 2) {
      awsBe[i] = awsLe[i + 1]!;
      awsBe[i + 1] = awsLe[i]!;
    }
    const utf16BeAwsBuf = Buffer.concat([Buffer.from([0xfe, 0xff]), awsBe]);
    await writeFile(path.join(project.copyDirectory, 'aws-config.ini'), utf16BeAwsBuf);

    // UTF-32LE with BOM private key
    const cps = Array.from(pemText, ch => ch.codePointAt(0)!);
    const utf32LeBody = Buffer.alloc(cps.length * 4);
    for (let i = 0; i < cps.length; i++) {
      utf32LeBody.writeUInt32LE(cps[i]!, i * 4);
    }
    const utf32LeKeyBuf = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), utf32LeBody]);
    await writeFile(path.join(project.copyDirectory, 'utf32-key.txt'), utf32LeKeyBuf);

    for (const [candidate, secretMarker] of [
      ['encoded-key.txt', pemMarker],
      ['aws-config.ini', awsMarker],
      ['utf32-key.txt', pemMarker],
    ] as const) {
      await assert.rejects(
        collectArtifacts(project, [candidate], DEFAULT_PROJECT_LIMITS),
        (err: unknown) => {
          assert.ok(err instanceof BridgeError);
          assert.equal(err.code, 'BLOCKED_ARTIFACT_PATH');
          assert.match(err.message, /SECRET_CONTENT/);
          assert.equal(err.message.includes(secretMarker), false);
          return true;
        },
      );
    }

    // Legacy stored encoded reference with matching raw byte sha256 and size is rejected on readArtifact
    const legacyEncodedRef: ArtifactReference = {
      path: 'encoded-key.txt',
      sha256: sha256Buffer(utf16LeKeyBuf),
      bytes: utf16LeKeyBuf.length,
    };
    await assert.rejects(
      readArtifact(project, legacyEncodedRef, legacyEncodedRef.sha256, 0, 65536),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'BLOCKED_ARTIFACT_PATH');
        assert.match(err.message, /SECRET_CONTENT/);
        assert.equal(err.message.includes(pemMarker), false);
        return true;
      },
    );

    // Safe UTF-16LE artifact preserves exact raw byte hash, length, and payload through collectArtifacts and readArtifact
    const safeUtf16Buf = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('Safe UTF-16 artifact payload — Café 日本語\n', 'utf16le'),
    ]);
    await writeFile(path.join(project.copyDirectory, 'safe-utf16.txt'), safeUtf16Buf);

    const [safeRef] = await collectArtifacts(project, ['safe-utf16.txt'], DEFAULT_PROJECT_LIMITS);
    assert.ok(safeRef);
    assert.equal(safeRef.path, 'safe-utf16.txt');
    assert.equal(safeRef.sha256, sha256Buffer(safeUtf16Buf));
    assert.equal(safeRef.bytes, safeUtf16Buf.length);

    const readRes = await readArtifact(project, safeRef, safeRef.sha256, 0, 65536);
    assert.equal(readRes.path, 'safe-utf16.txt');
    assert.equal(readRes.sha256, safeRef.sha256);
    assert.equal(readRes.bytes, safeUtf16Buf.length);
    assert.equal(readRes.hasMore, false);
    assert.deepEqual(Buffer.from(readRes.content, 'base64'), safeUtf16Buf);
  } finally {
    if (project) await discardProjectCopy(project);
    await cleanupTempDir(repo);
  }
});
