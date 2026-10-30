import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import childProcess, { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import fsPromises, { link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DEFAULT_PROJECT_LIMITS, loadConfig, configurationWarning } from '../src/config.js';
import { normalizeSecretExceptionsPolicy } from '../src/hardening-policy.js';
import {
  checkedPath,
  copyVerifiedFile,
  createProjectCopy,
  discardProjectCopy,
  forkProjectCopy,
  git,
  integrateProjectCopy,
  listProjectFiles,
  previewProjectCopy,
  readProjectPatch,
  validRelative,
  writeAll,
  getFenceMarkerPath,
  copyGit,
  snapshotCopyFiles,
  fingerprintProjectCopy,
  type ProjectCopy,
} from '../src/isolation.js';
import { BridgeError } from '../src/types.js';
import {
  detectSecretContent,
  validateGlobPattern,
  matchProjectRelativeGlob,
  preflightProjectFiles,
} from '../src/secret-preflight.js';
import { validateWorkingDirectory } from '../src/validation.js';
import { TaskManager } from '../src/task-manager.js';
import { CliAdapter } from '../src/cli-adapter.js';

if (process.platform === 'win32') {
  const dir = fileURLToPath(new URL('../../tests/.git-runtime/bin', import.meta.url));
  const gitExe = path.join(dir, 'git.exe');
  if (existsSync(gitExe)) {
    process.env.PATH = dir + path.delimiter + (process.env.PATH ?? '');
    process.env.GIT_EXEC_PATH = dir;
  }
}

const SYNTHETIC_SLACK_PREFIX = 'xox' + 'b-';
const SYNTHETIC_SLACK_TEAM = '123456789012';
const SYNTHETIC_SLACK_USER = '1234567890123';
const SYNTHETIC_SLACK_SECRET = 'AbCdEfGh' + 'IjKlMnOp' + 'QrStUvWx';
const SYNTHETIC_SLACK_TOKEN = `${SYNTHETIC_SLACK_PREFIX}${SYNTHETIC_SLACK_TEAM}-${SYNTHETIC_SLACK_USER}-${SYNTHETIC_SLACK_SECRET}`;

const SYNTHETIC_STRIPE_PREFIX = 'sk_' + 'live_';
const SYNTHETIC_STRIPE_SECRET = '123456789012' + '345678901234';
const SYNTHETIC_STRIPE_KEY = `${SYNTHETIC_STRIPE_PREFIX}${SYNTHETIC_STRIPE_SECRET}`;

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-file-protection-'));
  execFileSync('git', ['init', '--quiet', dir]);
  await writeFile(path.join(dir, 'source.txt'), 'legitimate application source code\n');
  return dir;
}

test('secrets: unignored .env and local variants are excluded and recorded as blocked metadata', async () => {
  const dir = await createRepo();
  try {
    // Current reproduction: unignored .env with synthetic token
    await writeFile(path.join(dir, '.env'), 'SERVICE_TOKEN=synthetic-service-token-xyz-12345\nPORT=8080\n');
    await writeFile(path.join(dir, '.env.local'), 'SECRET_KEY=local-dev-secret-98765\n');
    await writeFile(path.join(dir, '.env.production.local'), 'DATABASE_PASSWORD=super-secret-pw\n');
    await writeFile(path.join(dir, '.envrc'), 'export SECRET_ENV=direnv-secret\n');

    const listed = await listProjectFiles(dir);
    assert.deepEqual(listed, ['source.txt']);
    assert.ok(!listed.includes('.env'));
    assert.ok(!listed.includes('.env.local'));
    assert.ok(!listed.includes('.env.production.local'));
    assert.ok(!listed.includes('.envrc'));

    const copy = await createProjectCopy(dir);
    try {
      assert.deepEqual(copy.includedFiles, ['source.txt']);
      assert.equal(await readFile(path.join(copy.copyDirectory, 'source.txt'), 'utf8'), 'legitimate application source code\n');
      await assert.rejects(readFile(path.join(copy.copyDirectory, '.env')), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(copy.copyDirectory, '.env.local')), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(copy.copyDirectory, '.env.production.local')), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(copy.copyDirectory, '.envrc')), { code: 'ENOENT' });

      assert.ok(copy.blockedFiles && copy.blockedFiles.length >= 4);
      assert.equal('blockedPaths' in copy, false);
      const envBlock = copy.blockedFiles.find(b => b.path === '.env');
      assert.ok(envBlock);
      assert.equal(envBlock?.reason, 'SECRET_FILE');

      // Attempting to explicitly include blocked .env fails closed
      await assert.rejects(createProjectCopy(dir, ['.env']), { code: 'INVALID_INCLUDE_PATH' });
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('secrets: private keys, keystores, and auth config files are excluded', async () => {
  const dir = await createRepo();
  try {
    const rsaKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0m...\n-----END RSA PRIVATE KEY-----\n';
    await writeFile(path.join(dir, 'id_rsa'), rsaKey);
    await writeFile(path.join(dir, 'server.key'), '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ...\n-----END PRIVATE KEY-----\n');
    await writeFile(path.join(dir, 'keystore.p12'), Buffer.from([0x30, 0x82, 0x09, 0x00]));
    await writeFile(path.join(dir, '.git-credentials'), 'https://user:ghp_personalaccesstoken12345678901234@github.com\n');
    await writeFile(path.join(dir, '.netrc'), 'machine api.github.com login user password token123\n');

    const listed = await listProjectFiles(dir);
    assert.deepEqual(listed, ['source.txt']);

    const copy = await createProjectCopy(dir);
    try {
      assert.deepEqual(copy.includedFiles, ['source.txt']);
      await assert.rejects(readFile(path.join(copy.copyDirectory, 'id_rsa')), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(copy.copyDirectory, 'server.key')), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(copy.copyDirectory, 'keystore.p12')), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(copy.copyDirectory, '.git-credentials')), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(copy.copyDirectory, '.netrc')), { code: 'ENOENT' });

      assert.ok(copy.blockedFiles?.some(b => b.path === 'id_rsa' && (b.reason === 'SECRET_FILE' || b.reason === 'SECRET_CONTENT')));
      assert.ok(copy.blockedFiles?.some(b => b.path === 'server.key' && (b.reason === 'SECRET_FILE' || b.reason === 'SECRET_CONTENT')));
      assert.ok(copy.blockedFiles?.some(b => b.path === 'keystore.p12' && b.reason === 'SECRET_FILE'));
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('secrets: high-confidence credential content in non-standard file paths is detected', async () => {
  const dir = await createRepo();
  try {
    const gcpServiceAccount = JSON.stringify({
      type: 'service_account',
      project_id: 'sample-project',
      private_key_id: 'key123',
      private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ...\n-----END PRIVATE KEY-----\n',
      client_email: 'svc@sample-project.iam.gserviceaccount.com',
    });
    await writeFile(path.join(dir, 'app-credentials.json'), gcpServiceAccount);
    await writeFile(path.join(dir, 'aws-config.txt'), 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY987654321\n');
    await writeFile(path.join(dir, 'github-integration.yml'), 'token: ghp_123456789012345678901234567890123456\n');
    await writeFile(path.join(dir, 'slack.conf'), `bot_token = ${SYNTHETIC_SLACK_TOKEN}\n`);

    const listed = await listProjectFiles(dir);
    assert.deepEqual(listed, ['source.txt']);

    const copy = await createProjectCopy(dir);
    try {
      assert.deepEqual(copy.includedFiles, ['source.txt']);
      await assert.rejects(readFile(path.join(copy.copyDirectory, 'app-credentials.json')), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(copy.copyDirectory, 'aws-config.txt')), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(copy.copyDirectory, 'github-integration.yml')), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(copy.copyDirectory, 'slack.conf')), { code: 'ENOENT' });

      const blockedPaths = copy.blockedFiles?.map(b => b.path) ?? [];
      assert.ok(blockedPaths.includes('app-credentials.json'));
      assert.ok(blockedPaths.includes('aws-config.txt'));
      assert.ok(blockedPaths.includes('github-integration.yml'));
      assert.ok(blockedPaths.includes('slack.conf'));
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('legitimate examples, public certificates, and source code remain usable', async () => {
  const dir = await createRepo();
  try {
    const publicCert = '-----BEGIN CERTIFICATE-----\nMIIDXTCCAkWgAwIBAgIJAL...certificate_data...\n-----END CERTIFICATE-----\n';
    const publicKey = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...\n-----END PUBLIC KEY-----\n';
    const envExample = '# Example configuration\nPORT=3000\nDATABASE_URL=postgres://user:password@localhost:5432/dbname\nAPI_KEY=your_api_key_here\n';
    const sourceCode = '// Token service implementation\nexport function verifyToken(token: string) { const secret = "test"; return token.length > 0; }\n';
    const awsPlaceholder = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n';

    await writeFile(path.join(dir, 'cert.pem'), publicCert);
    await writeFile(path.join(dir, 'public.pem'), publicKey);
    await writeFile(path.join(dir, '.env.example'), envExample);
    await writeFile(path.join(dir, 'tokens.ts'), sourceCode);
    await writeFile(path.join(dir, 'aws-placeholder.txt'), awsPlaceholder);

    const listed = await listProjectFiles(dir);
    assert.ok(listed.includes('.env.example'));
    assert.ok(listed.includes('cert.pem'));
    assert.ok(listed.includes('public.pem'));
    assert.ok(listed.includes('source.txt'));
    assert.ok(listed.includes('tokens.ts'));
    assert.ok(listed.includes('aws-placeholder.txt'));

    const copy = await createProjectCopy(dir);
    try {
      assert.ok(copy.includedFiles.includes('.env.example'));
      assert.ok(copy.includedFiles.includes('cert.pem'));
      assert.ok(copy.includedFiles.includes('public.pem'));
      assert.ok(copy.includedFiles.includes('tokens.ts'));
      assert.ok(copy.includedFiles.includes('aws-placeholder.txt'));

      assert.equal(await readFile(path.join(copy.copyDirectory, 'cert.pem'), 'utf8'), publicCert);
      assert.equal(await readFile(path.join(copy.copyDirectory, 'public.pem'), 'utf8'), publicKey);
      assert.equal(await readFile(path.join(copy.copyDirectory, '.env.example'), 'utf8'), envExample);
      assert.equal(await readFile(path.join(copy.copyDirectory, 'tokens.ts'), 'utf8'), sourceCode);
      assert.equal(await readFile(path.join(copy.copyDirectory, 'aws-placeholder.txt'), 'utf8'), awsPlaceholder);
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('positive regression: source and test fixtures containing synthetic key literals and mock tokens pass copy', async () => {
  const dir = await createRepo();
  try {
    const authSource = `
// Authentication service
export const MOCK_RSA_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEA0m...synthetic...\\n-----END RSA PRIVATE KEY-----\\n";
export const MOCK_GITHUB_TOKEN = "ghp_123456789012345678901234567890123456";
export function isAuthorized(token: string) { return token.startsWith("ghp_"); }
`;
    const fixtureKeys = `
// Test fixtures with synthetic keys and tokens
export const FIXTURE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ...\\n-----END PRIVATE KEY-----\\n";
export const FIXTURE_STRIPE_KEY = "${SYNTHETIC_STRIPE_KEY}";
export const FIXTURE_SLACK_TOKEN = "${SYNTHETIC_SLACK_TOKEN}";
`;
    const unitTest = `
import { MOCK_RSA_KEY, MOCK_GITHUB_TOKEN } from '../src/auth.js';
import { FIXTURE_PRIVATE_KEY } from './fixtures/keys.js';
// Unit test verifying token parsing with synthetic credentials
export function testAuth() { return MOCK_GITHUB_TOKEN.length > 0; }
`;

    await mkdir(path.join(dir, 'src'), { recursive: true });
    await mkdir(path.join(dir, 'tests', 'fixtures'), { recursive: true });

    await writeFile(path.join(dir, 'src', 'auth.ts'), authSource);
    await writeFile(path.join(dir, 'tests', 'fixtures', 'keys.ts'), fixtureKeys);
    await writeFile(path.join(dir, 'tests', 'auth.test.ts'), unitTest);

    const listed = await listProjectFiles(dir);
    assert.ok(listed.includes('src/auth.ts'));
    assert.ok(listed.includes('tests/fixtures/keys.ts'));
    assert.ok(listed.includes('tests/auth.test.ts'));

    const copy = await createProjectCopy(dir);
    try {
      assert.ok(copy.includedFiles.includes('src/auth.ts'));
      assert.ok(copy.includedFiles.includes('tests/fixtures/keys.ts'));
      assert.ok(copy.includedFiles.includes('tests/auth.test.ts'));

      assert.equal(await readFile(path.join(copy.copyDirectory, 'src', 'auth.ts'), 'utf8'), authSource);
      assert.equal(await readFile(path.join(copy.copyDirectory, 'tests', 'fixtures', 'keys.ts'), 'utf8'), fixtureKeys);
      assert.equal(await readFile(path.join(copy.copyDirectory, 'tests', 'auth.test.ts'), 'utf8'), unitTest);

      assert.ok(!copy.blockedFiles?.some(b => b.path === 'src/auth.ts'));
      assert.ok(!copy.blockedFiles?.some(b => b.path === 'tests/fixtures/keys.ts'));
      assert.ok(!copy.blockedFiles?.some(b => b.path === 'tests/auth.test.ts'));
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('policy: secretExclusions, secretExceptions, and precedence hierarchy', async () => {
  const dir = await createRepo();
  try {
    await writeFile(path.join(dir, 'custom-internal.txt'), 'confidential internal doc\n');
    await writeFile(path.join(dir, '.env.local'), 'PORT=8080\nSERVICE_TOKEN=intended-template-token\n');
    await writeFile(path.join(dir, 'override-conflict.txt'), 'conflict data\n');
    await writeFile(path.join(dir, '.gitignore'), 'git-ignored.txt\n');
    await writeFile(path.join(dir, 'git-ignored.txt'), 'ignored by git\n');

    // 1. By default, .env.local is blocked as SECRET_FILE
    const defaultCopy = await createProjectCopy(dir);
    try {
      assert.ok(!defaultCopy.includedFiles.includes('.env.local'));
      assert.ok(defaultCopy.blockedFiles?.some(b => b.path === '.env.local' && b.reason === 'SECRET_FILE'));
    } finally {
      await discardProjectCopy(defaultCopy);
    }

    // 2. Custom exclude blocks file with SECRET_EXCLUSION
    const copy1 = await createProjectCopy(dir, undefined, undefined, {
      ...DEFAULT_PROJECT_LIMITS,
      secretExclusions: ['custom-internal.txt'],
    });
    try {
      assert.ok(!copy1.includedFiles.includes('custom-internal.txt'));
      assert.ok(copy1.blockedFiles?.some(b => b.path === 'custom-internal.txt' && b.reason === 'SECRET_EXCLUSION'));
    } finally {
      await discardProjectCopy(copy1);
    }

    // 3. Explicit exception permits .env.local that is normally blocked by default
    const copy2 = await createProjectCopy(dir, undefined, undefined, {
      ...DEFAULT_PROJECT_LIMITS,
      secretExceptions: { version: 2, namePatterns: ['.env.local'] },
    });
    try {
      assert.ok(copy2.includedFiles.includes('.env.local'));
      assert.equal(await readFile(path.join(copy2.copyDirectory, '.env.local'), 'utf8'), 'PORT=8080\nSERVICE_TOKEN=intended-template-token\n');
    } finally {
      await discardProjectCopy(copy2);
    }

    // 4. Custom deny rule (secretExclusions) takes precedence over explicit exceptions
    const copy3 = await createProjectCopy(dir, undefined, undefined, {
      ...DEFAULT_PROJECT_LIMITS,
      secretExclusions: ['.env.local'],
      secretExceptions: { version: 2, namePatterns: ['.env.local'] },
    });
    try {
      assert.ok(!copy3.includedFiles.includes('.env.local'));
      assert.ok(copy3.blockedFiles?.some(b => b.path === '.env.local' && b.reason === 'SECRET_EXCLUSION'));
    } finally {
      await discardProjectCopy(copy3);
    }

    // 5. Explicit exceptions CANNOT override Git ignores
    const copy4 = await createProjectCopy(dir, undefined, undefined, {
      ...DEFAULT_PROJECT_LIMITS,
      secretExceptions: { version: 2, namePatterns: ['git-ignored.txt'] },
    });
    try {
      assert.ok(!copy4.includedFiles.includes('git-ignored.txt'));
      await assert.rejects(readFile(path.join(copy4.copyDirectory, 'git-ignored.txt')), { code: 'ENOENT' });
    } finally {
      await discardProjectCopy(copy4);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('paths: rejects traversal, NUL bytes, Windows ADS, device paths, and .git aliases', async () => {
  const dir = await createRepo();
  try {
    // Malicious traversal
    await assert.rejects(checkedPath(dir, '../outside.txt', false), { code: 'INVALID_INCLUDE_PATH' });
    await assert.rejects(createProjectCopy(dir, ['../outside.txt']), { code: 'INVALID_INCLUDE_PATH' });

    // NUL byte
    await assert.rejects(checkedPath(dir, 'file\0.txt', false), { code: 'INVALID_INCLUDE_PATH' });

    if (process.platform === 'win32') {
      // Windows Alternate Data Streams (colons)
      await assert.rejects(checkedPath(dir, 'source.txt:hidden_stream', false), { code: 'INVALID_INCLUDE_PATH' });
      await assert.rejects(createProjectCopy(dir, ['source.txt:stream']), { code: 'INVALID_INCLUDE_PATH' });

      // Windows device names (NUL, CON, PRN, AUX, COM1, LPT1)
      await assert.rejects(checkedPath(dir, 'NUL', false), { code: 'INVALID_INCLUDE_PATH' });
      await assert.rejects(checkedPath(dir, 'nul.txt', false), { code: 'INVALID_INCLUDE_PATH' });
      await assert.rejects(checkedPath(dir, 'con.log', false), { code: 'INVALID_INCLUDE_PATH' });
      await assert.rejects(checkedPath(dir, 'aux.dat', false), { code: 'INVALID_INCLUDE_PATH' });
      await assert.rejects(checkedPath(dir, 'com1', false), { code: 'INVALID_INCLUDE_PATH' });

      // .git case aliases on Windows / case-insensitive systems
      await assert.rejects(checkedPath(dir, '.GIT/config', false), { code: 'INVALID_INCLUDE_PATH' });
      await assert.rejects(checkedPath(dir, '.Git/HEAD', false), { code: 'INVALID_INCLUDE_PATH' });
      await assert.rejects(checkedPath(dir, 'git~1/config', false), { code: 'INVALID_INCLUDE_PATH' });
    } else {
      // On POSIX, aux.dat is a legitimate filename
      const validOnPosix = await checkedPath(dir, 'aux.dat', false);
      assert.ok(validOnPosix.endsWith('aux.dat'));
    }

    // Explicit exception cannot override unsafe paths
    await assert.rejects(createProjectCopy(dir, ['../outside.txt'], undefined, {
      ...DEFAULT_PROJECT_LIMITS,
      secretExceptions: { version: 2, namePatterns: ['../outside.txt'] },
    }), { code: 'INVALID_INCLUDE_PATH' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('paths: external symbolic links are denied where supported', async (t) => {
  const dir = await createRepo();
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'agy-external-fixture-'));
  try {
    const outsideTarget = path.join(outsideDir, 'target.txt');
    try {
      await link(path.join(dir, 'source.txt'), outsideTarget);
    } catch {
      await writeFile(outsideTarget, 'outside file content\n');
    }
    let symlinksSupported = true;
    try {
      await symlink(outsideTarget, path.join(dir, 'external_link.txt'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'ENOSYS') {
        symlinksSupported = false;
      } else {
        throw err;
      }
    }

    if (symlinksSupported) {
      // Direct checkedPath check on symbolic link throws UNSAFE_PROJECT_PATH
      await assert.rejects(checkedPath(dir, 'external_link.txt', true), { code: 'UNSAFE_PROJECT_PATH' });
      // Selecting non-git link throws INVALID_INCLUDE_PATH because git does not list external link as eligible regular file
      await assert.rejects(createProjectCopy(dir, ['external_link.txt']), { code: 'INVALID_INCLUDE_PATH' });
      // listProjectFiles safely excludes the symbolic link
      const listed = await listProjectFiles(dir);
      assert.ok(!listed.includes('external_link.txt'));
    } else {
      t.skip('Symlink creation not permitted in this environment');
    }

    // Test directory junction ancestors on Windows
    if (process.platform === 'win32') {
      const junctionDir = path.join(dir, 'ext_junction');
      try {
        await symlink(outsideDir, junctionDir, 'junction');
        await assert.rejects(checkedPath(dir, 'ext_junction/target.txt', false), { code: 'UNSAFE_PROJECT_PATH' });
        await unlink(junctionDir).catch(async error => {
        if (!['EPERM', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await rmdir(junctionDir);
      });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EPERM' && code !== 'ENOSYS') throw err;
      }
    }
  } finally {
    await rm(outsideDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('paths: file changes during copy fail closed and do not expose contents', async () => {
  const dir = await createRepo();
  try {
    await writeFile(path.join(dir, 'race.txt'), 'initial content before preflight\n');

    // Simulate concurrent content change during createProjectCopy preparation
    // By modifying the file right before copying
    const listed = await listProjectFiles(dir);
    assert.ok(listed.includes('race.txt'));

    // Test that if content changes, createProjectCopy fails closed
    // We test this by triggering createProjectCopy with onCreated callback modifying the source file
    const copyPromise = createProjectCopy(dir, ['race.txt'], () => {
      // Intentionally modify source file during copy creation to simulate concurrent race
      writeFileSync(path.join(dir, 'race.txt'), 'concurrent modification');
    });

    await assert.rejects(copyPromise, (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'SOURCE_CHANGED');
      // Verify sensitive content is not exposed in the error message
      assert.ok(!err.message.includes('concurrent modification'));
      assert.ok(!err.message.includes('initial content'));
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fork: forkProjectCopy excludes secrets created in copy and retains isolation', async () => {
  const dir = await createRepo();
  try {
    const copy = await createProjectCopy(dir);
    try {
      // Simulate task creating an unignored .env and a private key with ambiguous filename in copyDirectory
      await writeFile(path.join(copy.copyDirectory, '.env'), 'FORK_TOKEN=sensitive-fork-token\n');
      await writeFile(path.join(copy.copyDirectory, 'fork-secret.dat'), '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ...\n-----END PRIVATE KEY-----\n');
      await writeFile(path.join(copy.copyDirectory, 'output.txt'), 'valid task output\n');

      const fork = await forkProjectCopy(copy, DEFAULT_PROJECT_LIMITS);
      try {
        assert.ok(fork.includedFiles.includes('output.txt'));
        assert.ok(fork.includedFiles.includes('source.txt'));
        assert.ok(!fork.includedFiles.includes('.env'));
        assert.ok(!fork.includedFiles.includes('fork-secret.dat'));

        await assert.rejects(readFile(path.join(fork.copyDirectory, '.env')), { code: 'ENOENT' });
        await assert.rejects(readFile(path.join(fork.copyDirectory, 'fork-secret.dat')), { code: 'ENOENT' });
        assert.equal(await readFile(path.join(fork.copyDirectory, 'output.txt'), 'utf8'), 'valid task output\n');

        assert.ok(fork.blockedFiles?.some(b => b.path === '.env' && b.reason === 'SECRET_FILE'));
        assert.ok(fork.blockedFiles?.some(b => b.path === 'fork-secret.dat' && b.reason === 'SECRET_CONTENT'));
      } finally {
        await discardProjectCopy(fork);
      }
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent copies maintain complete isolation without interference', async () => {
  const dir1 = await createRepo();
  const dir2 = await createRepo();
  try {
    await writeFile(path.join(dir1, 'file1.txt'), 'repo 1 data\n');
    await writeFile(path.join(dir2, 'file2.txt'), 'repo 2 data\n');

    const [copy1, copy2] = await Promise.all([
      createProjectCopy(dir1),
      createProjectCopy(dir2),
    ]);

    try {
      assert.notEqual(copy1.copyDirectory, copy2.copyDirectory);
      assert.notEqual(copy1.gitDirectory, copy2.gitDirectory);

      assert.ok(copy1.includedFiles.includes('file1.txt'));
      assert.ok(!copy1.includedFiles.includes('file2.txt'));

      assert.ok(copy2.includedFiles.includes('file2.txt'));
      assert.ok(!copy2.includedFiles.includes('file1.txt'));

      assert.equal(await readFile(path.join(copy1.copyDirectory, 'file1.txt'), 'utf8'), 'repo 1 data\n');
      assert.equal(await readFile(path.join(copy2.copyDirectory, 'file2.txt'), 'utf8'), 'repo 2 data\n');
    } finally {
      await Promise.all([
        discardProjectCopy(copy1),
        discardProjectCopy(copy2),
      ]);
    }
  } finally {
    await Promise.all([
      rm(dir1, { recursive: true, force: true }),
      rm(dir2, { recursive: true, force: true }),
    ]);
  }
});

test('config validation: BRIDGE_SECRET_EXCLUSIONS and BRIDGE_SECRET_EXCEPTIONS validation', () => {
  // Valid JSON array of relative glob patterns
  const valid = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off',
    BRIDGE_SECRET_EXCLUSIONS: JSON.stringify(['*.env', 'secrets/**']),
    BRIDGE_SECRET_EXCEPTIONS: JSON.stringify({ version: 2, namePatterns: ['.env.template'] }),
  });
  assert.deepEqual(valid.secretExclusions, ['*.env', 'secrets/**']);
  assert.deepEqual(valid.secretExceptions, { version: 2, namePatterns: ['.env.template'] });

  // Invalid JSON format
  const invalidJsonExcl = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCLUSIONS: 'not-json' });
  assert.deepEqual(invalidJsonExcl.secretExclusions, []);
  assert.equal(invalidJsonExcl.secretExclusionsInvalid, true);
  assert.deepEqual(invalidJsonExcl.configurationIssues, [
    { variable: 'BRIDGE_SECRET_EXCLUSIONS', reason: 'invalid-json' },
  ]);

  // Invalid traversal pattern
  const traversalExcl = loadConfig({
    BRIDGE_ANTI_AI_CRAFT: 'off',
    BRIDGE_SECRET_EXCLUSIONS: JSON.stringify(['../outside']),
  });
  assert.deepEqual(traversalExcl.secretExclusions, []);
  assert.equal(traversalExcl.secretExclusionsInvalid, true);
  assert.deepEqual(traversalExcl.configurationIssues, [
    { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 0, reason: 'invalid-pattern' },
  ]);

  // Invalid absolute path pattern
  const invalidAbsConfig = loadConfig({
    BRIDGE_ANTI_AI_CRAFT: 'off',
    BRIDGE_SECRET_EXCEPTIONS: JSON.stringify({ version: 2, namePatterns: ['/root/secret'] }),
  });
  assert.deepEqual(invalidAbsConfig.secretExceptions, { version: 2, namePatterns: [] });
  assert.deepEqual(invalidAbsConfig.configurationIssues, [
    { variable: 'BRIDGE_SECRET_EXCEPTIONS', index: 0, reason: 'invalid-pattern' },
  ]);
});

test('BRIDGE_SECRET_EXCLUSIONS: failure modes report issues, mark exclusions unusable, and refuse operations', async () => {
  const dir = await createRepo();
  try {
    const cases: Array<{
      name: string;
      raw: string;
      expectedIssue: { variable: string; index?: number; reason: string };
    }> = [
      { name: 'invalid-json', raw: 'not-valid-json', expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', reason: 'invalid-json' } },
      { name: 'not-a-list', raw: '{"pattern":"*.env"}', expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', reason: 'not-a-list' } },
      { name: 'non-string', raw: JSON.stringify([123]), expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 0, reason: 'invalid-entry' } },
      { name: 'empty-string', raw: JSON.stringify(['   ']), expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 0, reason: 'invalid-entry' } },
      { name: 'nul-character', raw: JSON.stringify(['secret\0key']), expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 0, reason: 'invalid-entry' } },
      { name: 'absolute-path', raw: JSON.stringify(['/root/secrets']), expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 0, reason: 'invalid-pattern' } },
      { name: 'drive-letter', raw: JSON.stringify(['C:secrets']), expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 0, reason: 'invalid-pattern' } },
      { name: 'traversal', raw: JSON.stringify(['foo/../bar']), expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 0, reason: 'invalid-pattern' } },
      { name: 'leading-backslash', raw: JSON.stringify(['\\privado']), expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 0, reason: 'invalid-pattern' } },
      { name: 'unc-share', raw: JSON.stringify(['\\\\servidor\\share']), expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 0, reason: 'invalid-pattern' } },
      { name: 'dot-slash-only', raw: JSON.stringify(['./']), expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 0, reason: 'invalid-pattern' } },
      { name: 'unstable-absolute-slash', raw: JSON.stringify(['./ /privado']), expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 0, reason: 'invalid-pattern' } },
      { name: 'unstable-leading-space', raw: JSON.stringify(['./ secrets/**']), expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 0, reason: 'invalid-pattern' } },
    ];

    for (const c of cases) {
      const config = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCLUSIONS: c.raw });
      assert.deepEqual(config.secretExclusions, [], `${c.name} must result in empty secretExclusions`);
      assert.equal(config.secretExclusionsInvalid, true, `${c.name} must mark secretExclusionsInvalid`);
      assert.deepEqual(config.configurationIssues, [c.expectedIssue], `${c.name} issue mismatch`);

      // preflightProjectFiles refuses with INVALID_CONFIGURATION before copying
      await assert.rejects(
        preflightProjectFiles(dir, ['source.txt'], config),
        (err: unknown) => {
          assert.ok(err instanceof BridgeError, `${c.name} must throw BridgeError`);
          assert.equal(err.code, 'INVALID_CONFIGURATION');
          assert.ok(err.message.includes('BRIDGE_SECRET_EXCLUSIONS'));
          assert.ok(err.message.includes('antigravity_health'));
          assert.equal(err.message.includes(c.raw), false, 'Error message must never echo configured value');
          return true;
        }
      );

      // createProjectCopy refuses before creating copy
      await assert.rejects(
        createProjectCopy(dir, undefined, undefined, config),
        (err: unknown) => {
          assert.ok(err instanceof BridgeError, `${c.name} copy creation must throw BridgeError`);
          assert.equal(err.code, 'INVALID_CONFIGURATION');
          return true;
        }
      );
    }

    // Mixed invalid patterns with valid entries: invalid entries make entire list unusable
    const mixedExclusionCases: Array<{
      name: string;
      raw: string;
      expectedIssue: { variable: string; index: number; reason: string };
    }> = [
      {
        name: 'mixed-leading-backslash',
        raw: JSON.stringify(['*.env', '\\privado', 'secrets/**']),
        expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 1, reason: 'invalid-pattern' },
      },
      {
        name: 'mixed-unc-share',
        raw: JSON.stringify(['*.env', '\\\\servidor\\share']),
        expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 1, reason: 'invalid-pattern' },
      },
      {
        name: 'mixed-dot-slash-only',
        raw: JSON.stringify(['secrets/**', './']),
        expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 1, reason: 'invalid-pattern' },
      },
      {
        name: 'mixed-unstable-absolute-slash',
        raw: JSON.stringify(['*.env', './ /privado', 'secrets/**']),
        expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 1, reason: 'invalid-pattern' },
      },
      {
        name: 'mixed-unstable-leading-space',
        raw: JSON.stringify(['*.env', './ secrets/**', 'secrets/**']),
        expectedIssue: { variable: 'BRIDGE_SECRET_EXCLUSIONS', index: 1, reason: 'invalid-pattern' },
      },
    ];

    for (const c of mixedExclusionCases) {
      const config = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCLUSIONS: c.raw });
      assert.deepEqual(config.secretExclusions, [], `${c.name} must result in empty secretExclusions`);
      assert.equal(config.secretExclusionsInvalid, true, `${c.name} must mark secretExclusionsInvalid`);
      assert.deepEqual(config.configurationIssues, [c.expectedIssue], `${c.name} issue mismatch`);

      await assert.rejects(
        preflightProjectFiles(dir, ['source.txt'], config),
        (err: unknown) => {
          assert.ok(err instanceof BridgeError, `${c.name} preflight must throw BridgeError`);
          assert.equal(err.code, 'INVALID_CONFIGURATION');
          assert.ok(err.message.includes('BRIDGE_SECRET_EXCLUSIONS'));
          assert.ok(err.message.includes('antigravity_health'));
          assert.equal(err.message.includes(c.raw), false, 'Error message must never echo configured value');
          return true;
        }
      );
    }

    // Valid exclusions behave unchanged (trim + dedupe)
    const validConfig = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'off',
      BRIDGE_SECRET_EXCLUSIONS: JSON.stringify(['  *.env  ', 'secrets/**', '*.env']),
    });
    assert.deepEqual(validConfig.secretExclusions, ['*.env', 'secrets/**']);
    assert.equal(validConfig.secretExclusionsInvalid, undefined);
    assert.deepEqual(validConfig.configurationIssues, []);
    const preflight = await preflightProjectFiles(dir, ['source.txt'], validConfig);
    assert.equal(preflight.eligible.length, 1);

    // Valid exclusions with ./ prefix and whitespace remain accepted and normalized
    const validNormalizedConfig = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'off',
      BRIDGE_SECRET_EXCLUSIONS: JSON.stringify(['./secrets/**', '  *.env  ']),
    });
    assert.deepEqual(validNormalizedConfig.secretExclusions, ['secrets/**', '*.env']);
    assert.equal(validNormalizedConfig.secretExclusionsInvalid, undefined);
    assert.deepEqual(validNormalizedConfig.configurationIssues, []);
    const preflightNormalized = await preflightProjectFiles(dir, ['source.txt'], validNormalizedConfig);
    assert.equal(preflightNormalized.eligible.length, 1);

    // Diagnostics and warnings never contain raw value
    const sensitivePattern = 'SENSITIVE_SECRET_PATTERN_998877';
    const sensitiveConfig = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'off',
      BRIDGE_SECRET_EXCLUSIONS: JSON.stringify(['/abs/' + sensitivePattern]),
    });
    const issuesJson = JSON.stringify(sensitiveConfig.configurationIssues);
    assert.equal(issuesJson.includes(sensitivePattern), false);
    const warn = configurationWarning(sensitiveConfig.configurationIssues)!;
    assert.ok(warn);
    assert.equal(warn.includes(sensitivePattern), false);

    // Invalid exclusions refuse tasks at TaskManager level without creating tasks
    const exclStateDir = await mkdtemp(path.join(os.tmpdir(), 'agy-excl-state-'));
    const exclConfig = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'off',
      BRIDGE_SECRET_EXCLUSIONS: 'not-json',
      BRIDGE_STATE_DIRECTORY: exclStateDir,
    });
    const exclAdapter = new CliAdapter(exclConfig);
    const exclTasks = new TaskManager(exclAdapter, exclConfig);
    try {
      await assert.rejects(
        exclTasks.run({ prompt: 'test', workingDirectory: dir }),
        (err: unknown) => {
          assert.ok(err instanceof BridgeError);
          assert.equal(err.code, 'INVALID_CONFIGURATION');
          assert.ok(err.message.includes('BRIDGE_SECRET_EXCLUSIONS'));
          assert.ok(err.message.includes('antigravity_health'));
          return true;
        }
      );
      assert.equal(exclTasks.list().length, 0);
    } finally {
      await exclTasks.shutdown();
      await rm(exclStateDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('FORBIDDEN_DIRECTORIES: relative or NUL entries report issues, mark unusable, and refuse operations', async () => {
  const dir = await createRepo();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'agy-state-dir-'));
  const validForbidden = await mkdtemp(path.join(os.tmpdir(), 'agy-forbidden-'));
  try {
    // 1. Relative entry is never resolved against cwd
    const relativeRaw = 'relative-non-absolute-dir';
    const relConfig = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', FORBIDDEN_DIRECTORIES: relativeRaw });
    assert.deepEqual(relConfig.forbiddenDirectories, []);
    assert.equal(relConfig.forbiddenDirectoriesInvalid, true);
    assert.deepEqual(relConfig.configurationIssues, [
      { variable: 'FORBIDDEN_DIRECTORIES', index: 0, reason: 'not-absolute' },
    ]);
    if (process.platform === 'win32') {
      const rootRelConfig = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', FORBIDDEN_DIRECTORIES: '\\root-relative-dir' });
      assert.deepEqual(rootRelConfig.forbiddenDirectories, []);
      assert.equal(rootRelConfig.forbiddenDirectoriesInvalid, true);
      assert.deepEqual(rootRelConfig.configurationIssues, [
        { variable: 'FORBIDDEN_DIRECTORIES', index: 0, reason: 'not-absolute' },
      ]);

      const winIncompleteRoots = ['//privado', '\\\\\\\\privado', '//servidor'];
      for (const badRoot of winIncompleteRoots) {
        const badConfig = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', FORBIDDEN_DIRECTORIES: badRoot });
        assert.deepEqual(badConfig.forbiddenDirectories, [], `${badRoot} must not resolve against cwd`);
        assert.equal(badConfig.forbiddenDirectoriesInvalid, true, `${badRoot} must mark forbiddenDirectoriesInvalid`);
        assert.deepEqual(badConfig.configurationIssues, [
          { variable: 'FORBIDDEN_DIRECTORIES', index: 0, reason: 'not-absolute' },
        ]);

        const mixedBad = loadConfig({
          BRIDGE_ANTI_AI_CRAFT: 'off',
          FORBIDDEN_DIRECTORIES: `${validForbidden};${badRoot}`,
        });
        assert.deepEqual(mixedBad.forbiddenDirectories, [path.resolve(validForbidden)]);
        assert.equal(mixedBad.forbiddenDirectoriesInvalid, true);
        assert.deepEqual(mixedBad.configurationIssues, [
          { variable: 'FORBIDDEN_DIRECTORIES', index: 1, reason: 'not-absolute' },
        ]);
      }
    }

    // 2. NUL entry is never resolved
    const nulRaw = `${validForbidden}\0bad`;
    const nulConfig = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', FORBIDDEN_DIRECTORIES: nulRaw });
    assert.deepEqual(nulConfig.forbiddenDirectories, []);
    assert.equal(nulConfig.forbiddenDirectoriesInvalid, true);
    assert.deepEqual(nulConfig.configurationIssues, [
      { variable: 'FORBIDDEN_DIRECTORIES', index: 0, reason: 'invalid-entry' },
    ]);

    // 3. Mixed valid and relative: valid entries stay in forbiddenDirectories and keep being forbidden
    const mixedConfig = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'off',
      FORBIDDEN_DIRECTORIES: `${validForbidden}${path.delimiter}relative-bad`,
      BRIDGE_STATE_DIRECTORY: stateDir,
    });
    assert.deepEqual(mixedConfig.forbiddenDirectories, [path.resolve(validForbidden)]);
    assert.equal(mixedConfig.forbiddenDirectoriesInvalid, true);
    assert.deepEqual(mixedConfig.configurationIssues, [
      { variable: 'FORBIDDEN_DIRECTORIES', index: 1, reason: 'not-absolute' },
    ]);

    // TaskManager and GroupManager refuse while unusable
    const adapter = new CliAdapter(mixedConfig);
    const tasks = new TaskManager(adapter, mixedConfig);
    try {
      await assert.rejects(
        tasks.run({ prompt: 'test', workingDirectory: dir }),
        (err: unknown) => {
          assert.ok(err instanceof BridgeError);
          assert.equal(err.code, 'INVALID_CONFIGURATION');
          assert.ok(err.message.includes('FORBIDDEN_DIRECTORIES'));
          assert.ok(err.message.includes('antigravity_health'));
          assert.equal(err.message.includes('relative-bad'), false, 'Error message must not echo relative entry');
          return true;
        }
      );
      await assert.rejects(
        tasks.setSandboxPolicy({ readRoots: [], writeRoots: [], network: false, childProcesses: true, maxOutputChars: 4000 }, tasks.getSandboxPolicy().sha256),
        { code: 'INVALID_CONFIGURATION' }
      );
      await assert.rejects(
        tasks.listProjectFiles(dir),
        { code: 'INVALID_CONFIGURATION' }
      );
      await assert.rejects(
        tasks.groups.create('a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d', {
          workingDirectory: dir,
          title: 'Test Group',
          jobs: [{ key: 'step-a', owner: 'implementer', dependsOn: [], task: { prompt: 'do work' } }],
        }),
        { code: 'INVALID_CONFIGURATION' }
      );
    } finally {
      await tasks.shutdown();
    }

    // 4. Valid configuration only: workingDirectory inside forbidden directory is rejected as forbidden
    const cleanConfig = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', FORBIDDEN_DIRECTORIES: validForbidden });
    assert.deepEqual(cleanConfig.configurationIssues, []);
    assert.equal(cleanConfig.forbiddenDirectoriesInvalid, undefined);
    await assert.rejects(
      validateWorkingDirectory(validForbidden, cleanConfig.forbiddenDirectories),
      { code: 'INVALID_WORKING_DIRECTORY' }
    );
    const validatedDir = await validateWorkingDirectory(dir, cleanConfig.forbiddenDirectories);
    assert.equal(validatedDir, await realpath(dir));

    // 5. Diagnostics and error messages never leak configured values
    const sensitive = 'SENSITIVE_FORBIDDEN_DIR_998877';
    const leakStateDir = await mkdtemp(path.join(os.tmpdir(), 'agy-leak-state-'));
    const leakConfig = loadConfig({
      BRIDGE_ANTI_AI_CRAFT: 'off',
      FORBIDDEN_DIRECTORIES: 'relative/' + sensitive,
      BRIDGE_STATE_DIRECTORY: leakStateDir,
    });
    const leakIssues = JSON.stringify(leakConfig.configurationIssues);
    assert.equal(leakIssues.includes(sensitive), false);
    const leakWarn = configurationWarning(leakConfig.configurationIssues)!;
    assert.equal(leakWarn.includes(sensitive), false);
    const leakAdapter = new CliAdapter(leakConfig);
    const leakTasks = new TaskManager(leakAdapter, leakConfig);
    try {
      await assert.rejects(
        leakTasks.run({ prompt: 'test', workingDirectory: dir }),
        (err: unknown) => {
          assert.ok(err instanceof BridgeError);
          assert.equal(err.code, 'INVALID_CONFIGURATION');
          assert.ok(err.message.includes('FORBIDDEN_DIRECTORIES'));
          assert.ok(err.message.includes('antigravity_health'));
          assert.equal(err.message.includes(sensitive), false, 'Error message must not echo sensitive entry');
          return true;
        }
      );
    } finally {
      await leakTasks.shutdown();
      await rm(leakStateDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
    await rm(validForbidden, { recursive: true, force: true });
  }
});

test('policy: glob pattern validation fails explicitly on invalid input', () => {
  // Invalid inputs that must throw INVALID_GLOB_PATTERN
  assert.throws(() => validateGlobPattern(''), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GLOB_PATTERN');
  assert.throws(() => validateGlobPattern('   '), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GLOB_PATTERN');
  assert.throws(() => validateGlobPattern('/absolute/path'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GLOB_PATTERN');
  assert.throws(() => validateGlobPattern('C:\\Windows\\system32'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GLOB_PATTERN');
  assert.throws(() => validateGlobPattern('../traversal'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GLOB_PATTERN');
  assert.throws(() => validateGlobPattern('foo/../bar'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GLOB_PATTERN');
  assert.throws(() => validateGlobPattern('pattern\0withnull'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GLOB_PATTERN');

  // Valid patterns normalize cleanly
  assert.equal(validateGlobPattern('*.env'), '*.env');
  assert.equal(validateGlobPattern('./secrets/**'), 'secrets/**');
  assert.equal(validateGlobPattern('config/**/*.json'), 'config/**/*.json');
});

test('git subprocess: guards errors and redacts diagnostics upon git operation failure', async () => {
  const dir = await createRepo();
  try {
    const nonGitDir = await mkdtemp(path.join(os.tmpdir(), 'agy-non-git-'));
    try {
      await assert.rejects(listProjectFiles(nonGitDir), (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'ISOLATION_REQUIRES_GIT');
        return true;
      });
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }

    // Child process exit failure with diagnostic redaction
    await assert.rejects(git(dir, ['rev-parse', '--verify', 'refs/heads/definitely-missing-regression-ref']), (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'GIT_OPERATION_FAILED');
      assert.ok(err.message.length > 0);
      return true;
    });

    // Subprocess spawn boundary error (invalid working directory)
    await assert.rejects(git(path.join(dir, 'nonexistent-directory-xyz'), ['status']), (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'GIT_OPERATION_FAILED');
      return true;
    });

    // Stream communication error: sending large input to command that does not consume stdin
    // Must settle GIT_OPERATION_FAILED and never accept code 0 after I/O error
    await assert.rejects(git(dir, ['version'], Buffer.alloc(5 * 1024 * 1024)), (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'GIT_OPERATION_FAILED');
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('policy: interior globstar matches zero directory segments', async () => {
  // Unit tests for glob matching semantics
  assert.ok(matchProjectRelativeGlob('config/**/auth.json', 'config/auth.json'));
  assert.ok(matchProjectRelativeGlob('config/**/auth.json', 'config/sub/auth.json'));
  assert.ok(matchProjectRelativeGlob('config/**/auth.json', 'config/a/b/auth.json'));
  assert.ok(!matchProjectRelativeGlob('config/**/auth.json', 'other/auth.json'));

  // Integration test with exclusion rule
  const dir = await createRepo();
  try {
    await mkdir(path.join(dir, 'config'), { recursive: true });
    await writeFile(path.join(dir, 'config', 'auth.json'), '{"client_id": "test"}\n');
    await writeFile(path.join(dir, 'config', 'public.json'), '{"public": true}\n');

    const copy = await createProjectCopy(dir, undefined, undefined, {
      ...DEFAULT_PROJECT_LIMITS,
      secretExclusions: ['config/**/auth.json'],
    });
    try {
      assert.ok(!copy.includedFiles.includes('config/auth.json'));
      assert.ok(copy.includedFiles.includes('config/public.json'));
      assert.ok(copy.blockedFiles?.some(b => b.path === 'config/auth.json' && b.reason === 'SECRET_EXCLUSION'));
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('secrets: ambiguous .key files evaluated by content rather than name alone', async () => {
  const dir = await createRepo();
  try {
    const pubKey = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...\n-----END PUBLIC KEY-----\n';
    const license = 'LICENSE_KEY = PRO-LICENSE-12345-ABCDE\n';
    const serverPrivKey = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ...\n-----END PRIVATE KEY-----\n';
    const genericPrivKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0m...\n-----END RSA PRIVATE KEY-----\n';

    await writeFile(path.join(dir, 'public.key'), pubKey);
    await writeFile(path.join(dir, 'license.key'), license);
    await writeFile(path.join(dir, 'server.key'), serverPrivKey);
    await writeFile(path.join(dir, 'custom.key'), genericPrivKey);

    const listed = await listProjectFiles(dir);
    assert.ok(listed.includes('public.key'));
    assert.ok(listed.includes('license.key'));
    assert.ok(!listed.includes('server.key'));
    assert.ok(!listed.includes('custom.key'));

    const copy = await createProjectCopy(dir);
    try {
      assert.ok(copy.includedFiles.includes('public.key'));
      assert.ok(copy.includedFiles.includes('license.key'));
      assert.ok(!copy.includedFiles.includes('server.key'));
      assert.ok(!copy.includedFiles.includes('custom.key'));

      assert.equal(await readFile(path.join(copy.copyDirectory, 'public.key'), 'utf8'), pubKey);
      assert.equal(await readFile(path.join(copy.copyDirectory, 'license.key'), 'utf8'), license);

      assert.ok(copy.blockedFiles?.some(b => b.path === 'server.key'));
      assert.ok(copy.blockedFiles?.some(b => b.path === 'custom.key' && b.reason === 'SECRET_CONTENT'));
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('performance & limits: selection narrows oversized repository before preflight scanning', async () => {
  const dir = await createRepo();
  try {
    // File exceeding small budget limit
    await writeFile(path.join(dir, 'oversized-unselected.txt'), Buffer.alloc(10000, 'x'));
    await mkdir(path.join(dir, 'sub'), { recursive: true });
    await writeFile(path.join(dir, 'sub', 'selected.txt'), 'small selected content\n');

    // maxCopyBytes is 2000, so preflighting the entire repo would fail on oversized-unselected.txt
    const tightLimits = { ...DEFAULT_PROJECT_LIMITS, maxCopyBytes: 2000 };

    const copy = await createProjectCopy(dir, ['sub/selected.txt'], undefined, tightLimits);
    try {
      assert.deepEqual(copy.includedFiles, ['sub/selected.txt']);
      assert.equal(await readFile(path.join(copy.copyDirectory, 'sub', 'selected.txt'), 'utf8'), 'small selected content\n');
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('secrets: chunk overlap detects credential signatures across chunk boundaries', async () => {
  const dir = await createRepo();
  try {
    // 65536 is 64 KiB chunk boundary; place token across 65520..65570
    const padding = '#'.repeat(65520) + '\n';
    const secretLine = 'token: ghp_123456789012345678901234567890123456\n';
    const trailing = '#'.repeat(1000) + '\n';
    await writeFile(path.join(dir, 'cross-chunk.yml'), padding + secretLine + trailing);

    const listed = await listProjectFiles(dir);
    assert.ok(!listed.includes('cross-chunk.yml'));

    const copy = await createProjectCopy(dir);
    try {
      assert.ok(!copy.includedFiles.includes('cross-chunk.yml'));
      assert.ok(copy.blockedFiles?.some(b => b.path === 'cross-chunk.yml' && b.reason === 'SECRET_CONTENT'));
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('paths: includePaths allows single trailing slash for directory selection', async () => {
  const dir = await createRepo();
  try {
    await mkdir(path.join(dir, 'sub'), { recursive: true });
    await writeFile(path.join(dir, 'sub', 'file1.txt'), 'sub file 1\n');
    await writeFile(path.join(dir, 'sub', 'file2.txt'), 'sub file 2\n');
    await writeFile(path.join(dir, 'root.txt'), 'root file\n');

    // validRelative allows single trailing slash and strips it
    assert.equal(validRelative('sub/'), 'sub');
    assert.equal(validRelative('a/b/'), 'a/b');
    assert.throws(() => validRelative('sub//'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_INCLUDE_PATH');
    assert.throws(() => validRelative('/'), (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_INCLUDE_PATH');

    // createProjectCopy accepts trailing slash in includePaths
    const copy = await createProjectCopy(dir, ['sub/']);
    try {
      assert.ok(copy.includedFiles.includes('sub/file1.txt'));
      assert.ok(copy.includedFiles.includes('sub/file2.txt'));
      assert.ok(!copy.includedFiles.includes('root.txt'));
      assert.equal(await readFile(path.join(copy.copyDirectory, 'sub', 'file1.txt'), 'utf8'), 'sub file 1\n');
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fork: baseline file becoming blocked fails closed with CONTEXT_CHANGED', async () => {
  const dir = await createRepo();
  try {
    const copy = await createProjectCopy(dir);
    try {
      // Overwrite baseline source.txt with a private key
      await writeFile(
        path.join(copy.copyDirectory, 'source.txt'),
        '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ...\n-----END PRIVATE KEY-----\n'
      );

      // Attempting to fork must fail closed with CONTEXT_CHANGED rather than omitting the baseline file
      await assert.rejects(forkProjectCopy(copy, DEFAULT_PROJECT_LIMITS), (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'CONTEXT_CHANGED');
        assert.ok(!err.message.includes('MIIEvg'));
        return true;
      });
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('secrets: late credential signature beyond 256 KiB is detected', async () => {
  const dir = await createRepo();
  try {
    // 270 KiB of comment padding, placing token past the 256 KiB mark
    const padding = '# harmless config comment line\n'.repeat(9000); // ~279 KB
    const secretLine = 'token = ghp_123456789012345678901234567890123456\n';
    const trailing = '# more comments\n'.repeat(100);
    await writeFile(path.join(dir, 'late-secret.ini'), padding + secretLine + trailing);

    const listed = await listProjectFiles(dir);
    assert.ok(!listed.includes('late-secret.ini'));

    const copy = await createProjectCopy(dir);
    try {
      assert.ok(!copy.includedFiles.includes('late-secret.ini'));
      assert.ok(copy.blockedFiles?.some(b => b.path === 'late-secret.ini' && b.reason === 'SECRET_CONTENT'));
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('copyVerifiedFile: writeAll handles partial writes and fails on zero progress', async () => {
  const writtenChunks: Buffer[] = [];
  const testBuffer = Buffer.from('hello world partial write test buffer content');

  // Mock handle that writes at most 10 bytes at a time
  const partialHandle = {
    async write(buf: Uint8Array, offset = 0, length = buf.length) {
      const take = Math.min(10, length);
      writtenChunks.push(Buffer.from(buf.buffer, buf.byteOffset + offset, take));
      return { bytesWritten: take };
    },
  };

  await writeAll(partialHandle, testBuffer);
  const concatenated = Buffer.concat(writtenChunks);
  assert.equal(concatenated.toString('utf8'), testBuffer.toString('utf8'));
  assert.ok(writtenChunks.length > 1, 'Expected multiple partial writes');

  // Mock handle that makes zero progress
  const zeroProgressHandle = {
    async write() {
      return { bytesWritten: 0 };
    },
  };

  await assert.rejects(
    writeAll(zeroProgressHandle, testBuffer),
    (err: unknown) => err instanceof BridgeError && err.code === 'COPY_WRITE_FAILED'
  );
});

test('paths & identity: copyVerifiedFile rejects identity mismatch (dev/ino change)', async () => {
  const dir = await createRepo();
  try {
    await writeFile(path.join(dir, 'identity.txt'), 'identity verified content\n');
    const preflight = await preflightProjectFiles(dir, ['identity.txt'], DEFAULT_PROJECT_LIMITS);
    const record = preflight.records.get('identity.txt');
    assert.ok(record);

    const source = path.join(dir, 'identity.txt');
    const targetDir = await mkdtemp(path.join(os.tmpdir(), 'agy-target-'));
    const target = path.join(targetDir, 'identity.txt');

    try {
      // Tampered ino
      const tamperedInoRecord = { ...record, ino: record.ino !== 0 ? record.ino + 999999 : 12345 };
      await assert.rejects(
        copyVerifiedFile(source, target, 'identity.txt', tamperedInoRecord, { remainingBytes: 10000 }, 'SOURCE_CHANGED'),
        (err: unknown) => err instanceof BridgeError && err.code === 'SOURCE_CHANGED'
      );

      // Tampered dev
      const tamperedDevRecord = { ...record, dev: record.dev !== 0 ? record.dev + 999999 : 54321 };
      await assert.rejects(
        copyVerifiedFile(source, target, 'identity.txt', tamperedDevRecord, { remainingBytes: 10000 }, 'SOURCE_CHANGED'),
        (err: unknown) => err instanceof BridgeError && err.code === 'SOURCE_CHANGED'
      );

      // Successful verified copy with authentic record
      const hash = await copyVerifiedFile(source, target, 'identity.txt', record, { remainingBytes: 10000 }, 'SOURCE_CHANGED');
      assert.equal(hash, record.sha256);
      assert.equal(await readFile(target, 'utf8'), 'identity verified content\n');
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('paths & identity: preflight detects ancestor junction/link swap via post-open revalidation', async () => {
  const dir = await createRepo();
  try {
    await mkdir(path.join(dir, 'ancestor'), { recursive: true });
    await writeFile(path.join(dir, 'ancestor', 'doc.txt'), 'ancestor target file\n');

    let callCount = 0;
    const customCheckedPath = async (root: string, rel: string, mustExist: boolean) => {
      callCount++;
      if (callCount === 1) {
        // First check passes before opening
        return checkedPath(root, rel, mustExist);
      }
      // Revalidation after open simulates ancestor swapped with junction/symlink
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'Ancestor junction detected: ' + rel);
    };

    const preflight = await preflightProjectFiles(dir, ['ancestor/doc.txt'], DEFAULT_PROJECT_LIMITS, customCheckedPath);
    assert.ok(!preflight.eligible.includes('ancestor/doc.txt'));
    assert.ok(preflight.blocked.some(b => b.path === 'ancestor/doc.txt' && b.reason === 'UNSAFE_PATH'));
    assert.ok(callCount >= 2, 'Expected post-open revalidation call to checkedPath');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('secrets: pure tests for mixed.dat (positive) and quoted literals (negative)', () => {
  // Positive: mixed.dat with an example quoted header on one line followed by a real unquoted private key
  const mixedBuffer = Buffer.from(
    '# example key header illustration:\n' +
    '"-----BEGIN PRIVATE KEY-----"\n' +
    '-----BEGIN PRIVATE KEY-----\n' +
    'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ...\n' +
    '-----END PRIVATE KEY-----\n'
  );
  assert.equal(detectSecretContent('mixed.dat', mixedBuffer), true);

  // Negative: pure quoted literals in non-source files are not detected as raw private keys
  const doubleQuoted = Buffer.from(
    '// documentation comment\n' +
    '"-----BEGIN PRIVATE KEY-----\\nMIIEvgIBADANBgkq...\\n-----END PRIVATE KEY-----\\n"\n'
  );
  assert.equal(detectSecretContent('quoted.dat', doubleQuoted), false);

  const singleQuoted = Buffer.from(
    '\'-----BEGIN RSA PRIVATE KEY-----\'\n'
  );
  assert.equal(detectSecretContent('quoted-single.dat', singleQuoted), false);

  const backtickQuoted = Buffer.from(
    '`-----BEGIN EC PRIVATE KEY-----`\n'
  );
  assert.equal(detectSecretContent('quoted-backtick.dat', backtickQuoted), false);

  // Positive regression: synthetic private key string literals in source files continue to be permitted
  const sourceFile = Buffer.from(
    'export const MOCK_KEY = "-----BEGIN PRIVATE KEY-----\\nMIIEvg...\\n-----END PRIVATE KEY-----\\n";\n'
  );
  assert.equal(detectSecretContent('src/crypto.ts', sourceFile), false);
  assert.equal(detectSecretContent('tests/auth.test.ts', sourceFile), false);
});

test('secrets: generated synthetic tokens retain detection and source-file exclusions', () => {
  const slackConfig = Buffer.from(`bot_token = ${SYNTHETIC_SLACK_TOKEN}\n`);
  const stripeConfig = Buffer.from(`stripe_key = ${SYNTHETIC_STRIPE_KEY}\n`);
  assert.equal(detectSecretContent('slack.conf', slackConfig), true);
  assert.equal(detectSecretContent('stripe.conf', stripeConfig), true);

  const fixtureSource = Buffer.from(
    `export const FIXTURE_STRIPE_KEY = "${SYNTHETIC_STRIPE_KEY}";\n` +
    `export const FIXTURE_SLACK_TOKEN = "${SYNTHETIC_SLACK_TOKEN}";\n`
  );
  assert.equal(detectSecretContent('tests/fixtures/keys.ts', fixtureSource), false);
  assert.equal(detectSecretContent('tests/file-protection.test.ts', fixtureSource), false);

  const slackSource = Buffer.from(`export const token = "${SYNTHETIC_SLACK_TOKEN}";\n`);
  const stripeSource = Buffer.from(`export const key = "${SYNTHETIC_STRIPE_KEY}";\n`);
  assert.equal(detectSecretContent('tests/auth.test.ts', slackSource), false);
  assert.equal(detectSecretContent('src/auth.ts', stripeSource), false);
});

test('performance & limits: preflight checks candidate count before scan and fails before any I/O', async () => {
  let ioCalled = false;
  const failingCheckedPath = async () => {
    ioCalled = true;
    throw new Error('checkedPathFn must not be called when candidate count exceeds maxCopyFiles');
  };

  const tightLimits = { ...DEFAULT_PROJECT_LIMITS, maxCopyFiles: 1 };
  await assert.rejects(
    preflightProjectFiles('dummy-dir', ['file1.txt', 'file2.txt'], tightLimits, failingCheckedPath),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'COPY_LIMIT_EXCEEDED');
      return true;
    }
  );
  assert.equal(ioCalled, false, 'Expected preflight to fail before performing any I/O');
});

test('fork: forkProjectCopy preserves baseline tree and reproduces worktree changes after preview', async () => {
  const dir = await createRepo();
  try {
    await writeFile(path.join(dir, 'file-to-mod.txt'), 'original content\n');
    await writeFile(path.join(dir, 'file-to-del.txt'), 'content to delete\n');
    await writeFile(path.join(dir, 'file-unchanged.txt'), 'stays unchanged\n');

    const copy = await createProjectCopy(dir);
    try {
      // Modify, add, delete, and add secret
      await writeFile(path.join(copy.copyDirectory, 'file-to-mod.txt'), 'modified content in copy\n');
      await rm(path.join(copy.copyDirectory, 'file-to-del.txt'));
      await writeFile(path.join(copy.copyDirectory, 'file-new.txt'), 'brand new file\n');

      // Stage and preview source copy
      const copyPreview = await previewProjectCopy(copy);
      assert.ok(copyPreview.files.some(f => f.path === 'file-to-mod.txt' && f.status === 'M'));
      assert.ok(copyPreview.files.some(f => f.path === 'file-to-del.txt' && f.status === 'D'));
      assert.ok(copyPreview.files.some(f => f.path === 'file-new.txt' && f.status === 'A'));
      assert.ok(!copyPreview.files.some(f => f.path === '.env'));

      // Record source copy commit, tree and index before fork
      const sourceHeadBefore = (await git(copy.copyDirectory, ['--git-dir=' + copy.gitDirectory, 'rev-parse', 'HEAD'])).toString('utf8').trim();
      const sourceTreeBefore = (await git(copy.copyDirectory, ['--git-dir=' + copy.gitDirectory, 'rev-parse', 'HEAD^{tree}'])).toString('utf8').trim();
      const sourceIndexBefore = await readFile(path.join(copy.gitDirectory, 'index'));
      await writeFile(path.join(copy.copyDirectory, '.env'), 'SYNTHETIC_TEST_VALUE=fixture\n');

      // Fork the project copy
      const fork = await forkProjectCopy(copy, DEFAULT_PROJECT_LIMITS);
      try {
        // Verify source copy HEAD, tree and index are unchanged
        const sourceHeadAfter = (await git(copy.copyDirectory, ['--git-dir=' + copy.gitDirectory, 'rev-parse', 'HEAD'])).toString('utf8').trim();
        const sourceTreeAfter = (await git(copy.copyDirectory, ['--git-dir=' + copy.gitDirectory, 'rev-parse', 'HEAD^{tree}'])).toString('utf8').trim();
        const sourceIndexAfter = await readFile(path.join(copy.gitDirectory, 'index'));
        assert.equal(sourceHeadAfter, sourceHeadBefore, 'Source HEAD must be unchanged');
        assert.equal(sourceTreeAfter, sourceTreeBefore, 'Source tree must be unchanged');
        assert.deepEqual(sourceIndexAfter, sourceIndexBefore, 'Source index must be unchanged');

        // Verify fork content
        assert.equal(await readFile(path.join(fork.copyDirectory, 'file-to-mod.txt'), 'utf8'), 'modified content in copy\n');
        assert.equal(await readFile(path.join(fork.copyDirectory, 'file-new.txt'), 'utf8'), 'brand new file\n');
        assert.equal(existsSync(path.join(fork.copyDirectory, 'file-to-del.txt')), false);
        assert.equal(existsSync(path.join(fork.copyDirectory, '.env')), false);
        assert.ok(fork.blockedFiles?.some(b => b.path === '.env' && b.reason === 'SECRET_FILE'));

        // Verify fork preview reproduces changes
        const forkPreview = await previewProjectCopy(fork);
        assert.deepEqual(forkPreview.files, copyPreview.files);
        assert.equal(forkPreview.summary.filesChanged, 3);
        assert.equal(forkPreview.summary.added, 1);
        assert.equal(forkPreview.summary.modified, 1);
        assert.equal(forkPreview.summary.deleted, 1);
      } finally {
        await discardProjectCopy(fork);
      }
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('patch integrity: non-UTF8 Latin1 text change fails closed with UNSUPPORTED_PATCH_ENCODING; binary attribute integrates exact bytes', async () => {
  const dir = await createRepo();
  try {
    // Latin1 text with \xe9
    const originalLatin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x74, 0x65, 0x73, 0x74, 0x0a]);
    await writeFile(path.join(dir, 'latin1.dat'), originalLatin1);
    execFileSync('git', ['add', 'latin1.dat'], { cwd: dir });
    await git(dir, ['-c', 'user.name=Bridge Test', '-c', 'user.email=test@invalid.local', 'commit', '-m', 'adiciona arquivo Latin1']);

    const copy = await createProjectCopy(dir);
    try {
      // Modify latin1 file: replace \xe9 with \xe8
      const modifiedLatin1 = Buffer.from([0x63, 0x61, 0x66, 0xe8, 0x20, 0x74, 0x65, 0x73, 0x74, 0x0a]);
      await writeFile(path.join(copy.copyDirectory, 'latin1.dat'), modifiedLatin1);

      // 1. Without binary attribute, git diff produces raw Latin1 text diff, which cannot round-trip UTF-8.
      // previewProjectCopy and readProjectPatch must fail closed with UNSUPPORTED_PATCH_ENCODING.
      await assert.rejects(
        previewProjectCopy(copy),
        (err: unknown) => {
          assert.ok(err instanceof BridgeError);
          assert.equal(err.code, 'UNSUPPORTED_PATCH_ENCODING');
          assert.ok(err.message.includes('.gitattributes') && /binary/i.test(err.message));
          return true;
        }
      );
      await assert.rejects(
        readProjectPatch(copy, 'latin1.dat'),
        (err: unknown) => {
          assert.ok(err instanceof BridgeError);
          assert.equal(err.code, 'UNSUPPORTED_PATCH_ENCODING');
          return true;
        }
      );

      // Verify source file in dir is completely untouched
      const sourceContent = await readFile(path.join(dir, 'latin1.dat'));
      assert.deepEqual(sourceContent, originalLatin1);
    } finally {
      await discardProjectCopy(copy);
    }

    // 2. Now declare *.dat as binary in .gitattributes
    await writeFile(path.join(dir, '.gitattributes'), '*.dat binary\n');
    execFileSync('git', ['add', '.gitattributes'], { cwd: dir });
    await git(dir, ['-c', 'user.name=Bridge Test', '-c', 'user.email=test@invalid.local', 'commit', '-m', 'declara dat como binário']);

    const copy2 = await createProjectCopy(dir);
    try {
      const modifiedLatin1 = Buffer.from([0x63, 0x61, 0x66, 0xe8, 0x20, 0x74, 0x65, 0x73, 0x74, 0x0a]);
      await writeFile(path.join(copy2.copyDirectory, 'latin1.dat'), modifiedLatin1);

      // With binary attribute, git produces a standard ASCII binary patch which round-trips UTF-8
      const preview = await previewProjectCopy(copy2);
      assert.ok(preview.patch.length > 0);
      assert.ok(preview.summary.binaryFiles >= 1 || preview.fileSummaries.some(f => f.path === 'latin1.dat' && f.binary));

      const singlePatch = await readProjectPatch(copy2, 'latin1.dat');
      assert.ok(singlePatch.includes('GIT binary patch'));

      // Integrate the patch
      const integrated = await integrateProjectCopy(copy2, preview.sha256);
      assert.ok(integrated);

      // Verify the integrated file in source repo matches modified bytes exactly
      const integratedContent = await readFile(path.join(dir, 'latin1.dat'));
      assert.deepEqual(integratedContent, modifiedLatin1);
    } finally {
      await discardProjectCopy(copy2);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('integration: source Git filters and whitespace policy cannot execute code or change approved bytes', async () => {
  const dir = await createRepo();
  const auxiliary = await mkdtemp(path.join(os.tmpdir(), 'agy-apply-policy-'));
  let copy;
  try {
    const marker = path.join(auxiliary, 'synthetic-filter-ran');
    const script = path.join(auxiliary, 'filter.cjs');
    await writeFile(script, "const fs=require('node:fs');fs.writeFileSync(" + JSON.stringify(marker) + ", 'synthetic filter');process.stdin.pipe(process.stdout);");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const command = quote(process.execPath.replaceAll('\\', '/')) + ' ' + quote(script.replaceAll('\\', '/'));
    await writeFile(path.join(dir, '.gitattributes'), '*.txt filter=synthetic_probe\n');
    await git(dir, ['config', 'filter.synthetic_probe.clean', command]);
    await git(dir, ['config', 'filter.synthetic_probe.smudge', command]);
    await git(dir, ['config', 'apply.whitespace', 'fix']);
    const configBefore = await readFile(path.join(dir, '.git', 'config'));
    copy = await createProjectCopy(dir);
    const approved = Buffer.from('legitimate application source code\nsynthetic addition \n');
    await writeFile(path.join(copy.copyDirectory, 'source.txt'), approved);
    const preview = await previewProjectCopy(copy);
    await integrateProjectCopy(copy, preview.sha256);
    assert.deepEqual(await readFile(path.join(dir, 'source.txt')), approved);
    assert.equal(existsSync(marker), false, 'Project Git filters must not execute during integration');
    assert.deepEqual(await readFile(path.join(dir, '.git', 'config')), configBefore);
  } finally {
    if (copy) await discardProjectCopy(copy);
    await rm(dir, { recursive: true, force: true });
    await rm(auxiliary, { recursive: true, force: true });
  }
});

test('fork: newly ignored baseline paths fail closed before exposing deletion content', async () => {
  for (const policy of ['copy', 'source']) {
    const dir = await createRepo();
    let copy;
    try {
      await writeFile(path.join(dir, 'protected.txt'), 'synthetic restricted content');
      copy = await createProjectCopy(dir);
      if (policy === 'copy') await writeFile(path.join(copy.copyDirectory, '.gitignore'), 'protected.txt\n');
      else {
        await mkdir(path.join(dir, '.git', 'info'), { recursive: true });
        await writeFile(path.join(dir, '.git', 'info', 'exclude'), 'protected.txt\n');
      }
      await assert.rejects(forkProjectCopy(copy, DEFAULT_PROJECT_LIMITS), { code: 'CONTEXT_CHANGED' });
      assert.equal(await readFile(path.join(dir, 'protected.txt'), 'utf8'), 'synthetic restricted content');
    } finally {
      if (copy) await discardProjectCopy(copy);
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('isolation: managed copy check-ignore and operations exclude both roots and refuse fenced copies', async () => {
  const dir = await createRepo();
  let copy;
  try {
    await writeFile(path.join(dir, 'app.txt'), 'app content\n');
    copy = await createProjectCopy(dir);

    // Verify forkProjectCopy succeeds and exercises managed check-ignore on both copy and source
    const isWindows = process.platform === 'win32';
    const fakeExeName = isWindows ? 'git.exe' : 'git';
    await writeFile(path.join(copy.copyDirectory, fakeExeName), 'malicious binary');

    const forked = await forkProjectCopy(copy, DEFAULT_PROJECT_LIMITS);
    try {
      assert.ok(forked.includedFiles.includes('app.txt'));
    } finally {
      await discardProjectCopy(forked);
    }

    // Now verify cleanup unverified fencing on copy
    const markerPath = getFenceMarkerPath(copy);
    await writeFile(markerPath, JSON.stringify({ code: 'GIT_CLEANUP_UNVERIFIED', version: 1 }) + '\n', 'utf8');

    // All managed copy operations must fail closed with GIT_CLEANUP_UNVERIFIED
    await assert.rejects(forkProjectCopy(copy, DEFAULT_PROJECT_LIMITS), { code: 'GIT_CLEANUP_UNVERIFIED' });
    await assert.rejects(previewProjectCopy(copy), { code: 'GIT_CLEANUP_UNVERIFIED' });
    await assert.rejects(discardProjectCopy(copy), { code: 'GIT_CLEANUP_UNVERIFIED' });

    // Fixture cleans up its own marker before deletion
    await rm(markerPath, { force: true });
    await discardProjectCopy(copy);
    copy = undefined;
  } finally {
    if (copy) {
      await rm(getFenceMarkerPath(copy), { force: true });
      await discardProjectCopy(copy).catch(() => {});
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('v2 secret exceptions: name exception permits harmless credential filename but never bypasses credential content detection', async () => {
  const dir = await createRepo();
  try {
    // 1. Harmless content in .env.local: allowed under v2 exception
    await writeFile(path.join(dir, '.env.local'), 'PORT=8080\nFEATURE_FLAG=true\nAPP_NAME=synthetic-app\n');

    // 2. Secret content in another excepted file fixtures/.env.local:
    // contains an AWS secret access key format
    await mkdir(path.join(dir, 'fixtures'), { recursive: true });
    await writeFile(path.join(dir, 'fixtures', '.env.local'), 'AWS_SECRET_ACCESS_KEY=BRIDGESYNTHETICNOTAREALKEY1234567890\n');

    // 3. Secret content in third excepted file server.key:
    // contains an unquoted private key
    const privKey = '-----BEGIN PRIVATE KEY-----\nBRIDGE_SYNTHETIC_NOT_A_USABLE_KEY\n-----END PRIVATE KEY-----\n';
    await writeFile(path.join(dir, 'server.key'), privKey);

    const limits = {
      ...DEFAULT_PROJECT_LIMITS,
      secretExceptions: {
        version: 2 as const,
        namePatterns: ['.env.local', 'fixtures/.env.local', 'server.key'],
      },
    };

    const copy = await createProjectCopy(dir, undefined, undefined, limits);
    try {
      // Harmless .env.local is included
      assert.ok(copy.includedFiles.includes('.env.local'));
      assert.equal(await readFile(path.join(copy.copyDirectory, '.env.local'), 'utf8'), 'PORT=8080\nFEATURE_FLAG=true\nAPP_NAME=synthetic-app\n');

      // fixtures/.env.local had credential content -> blocked as SECRET_CONTENT despite name exception
      assert.ok(!copy.includedFiles.includes('fixtures/.env.local'));
      assert.ok(copy.blockedFiles?.some(b => b.path === 'fixtures/.env.local' && b.reason === 'SECRET_CONTENT'));

      // server.key had private key content -> blocked as SECRET_CONTENT despite name exception
      assert.ok(!copy.includedFiles.includes('server.key'));
      assert.ok(copy.blockedFiles?.some(b => b.path === 'server.key' && b.reason === 'SECRET_CONTENT'));
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('v2 secret exceptions: legacy non-empty arrays fail with migration guidance without echoing secret values', async () => {
  const dir = await createRepo();
  try {
    const sensitivePatternName = 'sensitive-token-file-xyz.local';

    // 1. In environment config: non-empty legacy array is ignored with legacy-format issue without echoing pattern
    const legacyCfg = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCEPTIONS: JSON.stringify([sensitivePatternName]) });
    assert.deepEqual(legacyCfg.secretExceptions, { version: 2, namePatterns: [] });
    assert.deepEqual(legacyCfg.configurationIssues, [
      { variable: 'BRIDGE_SECRET_EXCEPTIONS', reason: 'legacy-format' },
    ]);
    const legacyWarning = configurationWarning(legacyCfg.configurationIssues)!;
    assert.ok(legacyWarning);
    assert.ok(!legacyWarning.includes(sensitivePatternName), 'Diagnostic must never echo values from legacy array');

    // 2. Direct runtime API: non-empty legacy array in limits fails with migration message without echoing pattern
    await assert.rejects(
      preflightProjectFiles(dir, ['source.txt'], {
        ...DEFAULT_PROJECT_LIMITS,
        secretExceptions: [sensitivePatternName],
      }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'INVALID_SECRET_EXCEPTIONS');
        assert.match(err.message, /uses legacy array format\. Migrate to strict version 2 object format/);
        assert.ok(!err.message.includes(sensitivePatternName), 'Diagnostic must never echo values from legacy array');
        return true;
      }
    );

    // 3. Direct runtime API: empty array and omitted normalize to empty policy
    const emptyArrayPreflight = await preflightProjectFiles(dir, ['source.txt'], {
      ...DEFAULT_PROJECT_LIMITS,
      secretExceptions: [],
    });
    assert.deepEqual(emptyArrayPreflight.eligible, ['source.txt']);

    const omittedPreflight = await preflightProjectFiles(dir, ['source.txt'], {
      ...DEFAULT_PROJECT_LIMITS,
      secretExceptions: undefined,
    });
    assert.deepEqual(omittedPreflight.eligible, ['source.txt']);

    // 4. Env config: empty array and omitted normalize to empty policy
    const emptyConfig = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCEPTIONS: '[]' });
    assert.deepEqual(emptyConfig.secretExceptions, { version: 2, namePatterns: [] });

    const omittedConfig = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off' });
    assert.deepEqual(omittedConfig.secretExceptions, { version: 2, namePatterns: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('v2 secret exceptions: strict validation rejects unsupported versions, extra fields, null, and traversal', async () => {
  const dir = await createRepo();
  try {
    // Unsupported versions (v1, v3)
    const cfgV1 = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCEPTIONS: JSON.stringify({ version: 1, namePatterns: ['.env.local'] }) });
    assert.deepEqual(cfgV1.secretExceptions, { version: 2, namePatterns: [] });
    assert.deepEqual(cfgV1.configurationIssues, [{ variable: 'BRIDGE_SECRET_EXCEPTIONS', reason: 'invalid-format' }]);

    const cfgV3 = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCEPTIONS: JSON.stringify({ version: 3, namePatterns: ['.env.local'] }) });
    assert.deepEqual(cfgV3.secretExceptions, { version: 2, namePatterns: [] });
    assert.deepEqual(cfgV3.configurationIssues, [{ variable: 'BRIDGE_SECRET_EXCEPTIONS', reason: 'invalid-format' }]);

    // Extra fields
    const cfgExtra = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCEPTIONS: JSON.stringify({ version: 2, namePatterns: ['.env.local'], extraField: true }) });
    assert.deepEqual(cfgExtra.secretExceptions, { version: 2, namePatterns: [] });
    assert.deepEqual(cfgExtra.configurationIssues, [{ variable: 'BRIDGE_SECRET_EXCEPTIONS', reason: 'invalid-format' }]);

    // Missing fields
    const cfgMissingPatterns = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCEPTIONS: JSON.stringify({ version: 2 }) });
    assert.deepEqual(cfgMissingPatterns.secretExceptions, { version: 2, namePatterns: [] });
    assert.deepEqual(cfgMissingPatterns.configurationIssues, [{ variable: 'BRIDGE_SECRET_EXCEPTIONS', reason: 'invalid-format' }]);

    const cfgMissingVersion = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCEPTIONS: JSON.stringify({ namePatterns: ['.env.local'] }) });
    assert.deepEqual(cfgMissingVersion.secretExceptions, { version: 2, namePatterns: [] });
    assert.deepEqual(cfgMissingVersion.configurationIssues, [{ variable: 'BRIDGE_SECRET_EXCEPTIONS', reason: 'invalid-format' }]);

    // Malformed / null
    const cfgNull = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCEPTIONS: 'null' });
    assert.deepEqual(cfgNull.secretExceptions, { version: 2, namePatterns: [] });
    assert.deepEqual(cfgNull.configurationIssues, [{ variable: 'BRIDGE_SECRET_EXCEPTIONS', reason: 'not-an-object' }]);

    const cfgNum = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCEPTIONS: '123' });
    assert.deepEqual(cfgNum.secretExceptions, { version: 2, namePatterns: [] });
    assert.deepEqual(cfgNum.configurationIssues, [{ variable: 'BRIDGE_SECRET_EXCEPTIONS', reason: 'not-an-object' }]);

    // A variable retains extra fields for runtime validation without a type escape.
    const extraPolicy = { version: 2 as const, namePatterns: ['.env.local'], unexpectedKey: 'bad' };
    await assert.rejects(
      preflightProjectFiles(dir, ['source.txt'], {
        ...DEFAULT_PROJECT_LIMITS,
        secretExceptions: extraPolicy,
      }),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SECRET_EXCEPTIONS'
    );

    await assert.rejects(
      preflightProjectFiles(dir, ['source.txt'], {
        ...DEFAULT_PROJECT_LIMITS,
        secretExceptions: { version: 2, namePatterns: ['sub/../../outside'] },
      }),
      (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_SECRET_EXCEPTIONS'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('v2 policy rejects blank configuration and hides invalid version values', () => {
  for (const input of ['', ' \t\n', '{']) {
    const blankCfg = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_SECRET_EXCEPTIONS: input });
    assert.deepEqual(blankCfg.secretExceptions, { version: 2, namePatterns: [] });
    assert.deepEqual(blankCfg.configurationIssues, [{ variable: 'BRIDGE_SECRET_EXCEPTIONS', reason: 'invalid-json' }]);
  }
  const hidden = 'BRIDGE_SYNTHETIC_VERSION_SHOULD_NOT_ECHO';
  assert.throws(() => normalizeSecretExceptionsPolicy({ version: hidden, namePatterns: [] }), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'INVALID_SECRET_EXCEPTIONS');
    assert.equal(error.message.includes(hidden), false);
    return true;
  });
  const inherited = Object.setPrototypeOf({ namePatterns: [] }, { version: 2 });
  assert.throws(() => normalizeSecretExceptionsPolicy(inherited), /must contain version and namePatterns/);
  assert.deepEqual(normalizeSecretExceptionsPolicy({
    version: 2, namePatterns: [' ./fixtures\\.env.local ', 'fixtures/.env.local'],
  }), { version: 2, namePatterns: ['fixtures/.env.local'] });
});

const OUTPUT_SYNTHETIC_KEY = '-----BEGIN PRIVATE KEY-----\nBRIDGE_SYNTHETIC_NOT_A_USABLE_KEY\n-----END PRIVATE KEY-----\n';

async function withOutputFixture(
  run: (project: ProjectCopy, source: string) => Promise<void>,
  prepare?: (source: string) => Promise<void>
): Promise<void> {
  const dir = await createRepo();
  try {
    await prepare?.(dir);
    const project = await createProjectCopy(dir);
    try { await run(project, dir); }
    finally { await discardProjectCopy(project); }
  } finally {
    const actual = await realpath(dir);
    const info = await lstat(dir);
    if (path.dirname(actual) !== await realpath(os.tmpdir()) || !path.basename(actual).startsWith('agy-file-protection-') ||
        info.isSymbolicLink() || !info.isDirectory()) throw new Error('Unsafe output fixture cleanup');
    await rm(actual, { recursive: true, force: true });
  }
}

async function assertNoOutputBlob(project: ProjectCopy, content: string): Promise<void> {
  const scope = ['--git-dir=' + project.gitDirectory, '--work-tree=' + project.copyDirectory];
  const oid = (await copyGit(project, [...scope, 'hash-object', '--stdin'], Buffer.from(content))).toString().trim();
  const object = (await copyGit(project, [...scope, 'cat-file', '--batch-check'], Buffer.from(oid + '\n'))).toString().trim();
  assert.equal(object, oid + ' missing', 'Rejected bytes must not enter the Git object database');
}

test('output protection rejects a generated credential name before Git persists its bytes', async () => {
  await withOutputFixture(async project => {
    const content = 'PORT=9876\nBRIDGE_SYNTHETIC_FILENAME_ONLY\n';
    await writeFile(path.join(project.copyDirectory, '.env.synthetic'), content);
    await assert.rejects(previewProjectCopy(project), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'BLOCKED_FILE_DETECTED');
      assert.match(error.message, /SECRET_FILE/);
      assert.equal(error.message.includes('9876'), false);
      return true;
    });
    await assertNoOutputBlob(project, content);
    await assert.rejects(readProjectPatch(project, '.env.synthetic'), { code: 'BLOCKED_FILE_DETECTED' });
  });
});

test('output protection rejects sensitive baseline changes without modifying the source', async () => {
  await withOutputFixture(async (project, source) => {
    const original = await readFile(path.join(source, 'source.txt'), 'utf8');
    await writeFile(path.join(project.copyDirectory, 'source.txt'), OUTPUT_SYNTHETIC_KEY);
    await assert.rejects(previewProjectCopy(project), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'BLOCKED_FILE_DETECTED');
      assert.match(error.message, /baseline file.*SECRET_CONTENT/);
      assert.equal(error.message.includes('BRIDGE_SYNTHETIC_NOT_A_USABLE_KEY'), false);
      return true;
    });
    assert.equal(await readFile(path.join(source, 'source.txt'), 'utf8'), original);
    await assertNoOutputBlob(project, OUTPUT_SYNTHETIC_KEY);
  });
});

test('output protection preserves exclusion precedence and name-only v2 exceptions', async () => {
  await withOutputFixture(async project => {
    await writeFile(path.join(project.copyDirectory, '.env.local'), 'PORT=8080\n');
    const limits = { ...DEFAULT_PROJECT_LIMITS, secretExceptions: { version: 2 as const, namePatterns: ['.env.local'] } };
    const allowed = await previewProjectCopy(project, limits);
    assert.ok(allowed.files.some(file => file.path === '.env.local'));
    await assert.rejects(previewProjectCopy(project, { ...limits, secretExclusions: ['.env.local'] }), { code: 'BLOCKED_FILE_DETECTED' });
    await writeFile(path.join(project.copyDirectory, '.env.local'), OUTPUT_SYNTHETIC_KEY);
    await assert.rejects(previewProjectCopy(project, limits), { code: 'BLOCKED_FILE_DETECTED' });
    await assertNoOutputBlob(project, OUTPUT_SYNTHETIC_KEY);
  });
});

test('output protection omits blocked generated context and rejects a contaminated baseline', async () => {
  await withOutputFixture(async project => {
    const before = await fingerprintProjectCopy(project);
    await writeFile(path.join(project.copyDirectory, '.env.synthetic'), 'PORT=8080\n');
    const snapshot = await snapshotCopyFiles(project, DEFAULT_PROJECT_LIMITS);
    assert.equal(snapshot.has('.env.synthetic'), false);
    assert.ok(snapshot.has('source.txt'));
    assert.equal(await fingerprintProjectCopy(project), before);
    const fork = await forkProjectCopy(project, DEFAULT_PROJECT_LIMITS);
    try { assert.equal(existsSync(path.join(fork.copyDirectory, '.env.synthetic')), false); }
    finally { await discardProjectCopy(fork); }
    await writeFile(path.join(project.copyDirectory, 'source.txt'), OUTPUT_SYNTHETIC_KEY);
    await assert.rejects(snapshotCopyFiles(project, DEFAULT_PROJECT_LIMITS), { code: 'CONTEXT_CHANGED' });
    await assert.rejects(fingerprintProjectCopy(project), { code: 'CONTEXT_CHANGED' });
    await assert.rejects(forkProjectCopy(project, DEFAULT_PROJECT_LIMITS), { code: 'CONTEXT_CHANGED' });
  });
});

test('output protection respects source and copy ignore rules before staging', async () => {
  await withOutputFixture(async project => {
    await writeFile(path.join(project.copyDirectory, '.gitignore'), 'source-ignored.log\ncopy-ignored.log\n');
    await writeFile(path.join(project.copyDirectory, 'source-ignored.log'), OUTPUT_SYNTHETIC_KEY);
    await writeFile(path.join(project.copyDirectory, 'copy-ignored.log'), OUTPUT_SYNTHETIC_KEY);
    await writeFile(path.join(project.copyDirectory, 'legit.txt'), 'BRIDGE_SYNTHETIC_SAFE_OUTPUT\n');
    const preview = await previewProjectCopy(project);
    assert.ok(preview.files.some(file => file.path === 'legit.txt'));
    assert.equal(preview.files.some(file => file.path.endsWith('ignored.log')), false);
    assert.equal(preview.patch.includes('BRIDGE_SYNTHETIC_NOT_A_USABLE_KEY'), false);
  }, async source => { await writeFile(path.join(source, '.gitignore'), 'source-ignored.log\n'); });
});

test('output protection binds Git input to verified bytes when the copy changes immediately before staging', async t => {
  await withOutputFixture(async project => {
    const marker = 'BRIDGESYNTHETICNOTAREALKEY1234567890';
    const sensitive = 'AWS_SECRET_ACCESS_KEY=' + marker + '\n';
    const file = path.join(project.copyDirectory, 'race-config.txt');
    await writeFile(file, 'x'.repeat(Buffer.byteLength(sensitive)));
    const originalSpawn = childProcess.spawn;
    let changed = false;
    t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
      if (!changed && Array.isArray(args[1]) && args[1].includes('add')) {
        changed = true;
        writeFileSync(file, sensitive);
      }
      return originalSpawn(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(previewProjectCopy(project), (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.ok(['BLOCKED_FILE_DETECTED', 'CONTEXT_CHANGED'].includes(error.code));
        assert.equal(error.message.includes(marker), false);
        return true;
      });
      assert.equal(changed, true, 'The deterministic staging boundary must be exercised');
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    await assertNoOutputBlob(project, sensitive);
  });
});

test('output protection refreshes stale indexed bytes for both restored and missing working files', async () => {
  await withOutputFixture(async project => {
    const content = 'AWS_SECRET_ACCESS_KEY=BRIDGESYNTHETICNOTAREALKEY1234567890\n';
    const relative = 'staged-config.txt';
    const file = path.join(project.copyDirectory, relative);
    const scope = ['--git-dir=' + project.gitDirectory, '--work-tree=' + project.copyDirectory];
    for (const missing of [false, true]) {
      await writeFile(file, content);
      // Controlled legacy-index fixture, not a production staging path.
      await copyGit(project, [...scope, 'add', '--', relative]);
      if (missing) await rm(file);
      else await writeFile(file, 'BRIDGE_SYNTHETIC_SAFE_CURRENT_CONTENT\n');
      const patch = await readProjectPatch(project, relative);
      assert.equal(patch.includes('BRIDGESYNTHETICNOTAREALKEY1234567890'), false);
    }
  });
});

test('output protection readProjectPatch slices reviewed preview patch without shared index reread', async () => {
  await withOutputFixture(async project => {
    await writeFile(path.join(project.copyDirectory, 'file-a.txt'), 'content A modified\n');
    await writeFile(path.join(project.copyDirectory, 'file-b.txt'), 'content B modified\n');
    await writeFile(path.join(project.copyDirectory, 'ação espaço.txt'), 'non-ASCII path content\n');
    await writeFile(path.join(project.copyDirectory, 'binary.dat'), Buffer.from([0, 255, 1, 0]));
    const preview = await previewProjectCopy(project);
    assert.equal(preview.files.length, 4);

    const unicodePatch = await readProjectPatch(project, 'ação espaço.txt', DEFAULT_PROJECT_LIMITS, preview.sha256);
    assert.ok(unicodePatch.includes('non-ASCII path content'));
    assert.equal(unicodePatch.includes('content A modified'), false);
    const binaryPatch = await readProjectPatch(project, 'binary.dat', DEFAULT_PROJECT_LIMITS, preview.sha256);
    assert.ok(binaryPatch.includes('GIT binary patch'));
    assert.equal(binaryPatch.includes('content B modified'), false);

    // Slice for file-a.txt
    const patchA = await readProjectPatch(project, 'file-a.txt', DEFAULT_PROJECT_LIMITS, preview.sha256);
    assert.ok(patchA.includes('diff --git a/file-a.txt b/file-a.txt'));
    assert.ok(patchA.includes('content A modified'));
    assert.equal(patchA.includes('file-b.txt'), false);
    assert.equal(patchA.includes('content B modified'), false);

    // Slice for file-b.txt
    const patchB = await readProjectPatch(project, 'file-b.txt', DEFAULT_PROJECT_LIMITS, preview.sha256);
    assert.ok(patchB.includes('diff --git a/file-b.txt b/file-b.txt'));
    assert.ok(patchB.includes('content B modified'));
    assert.equal(patchB.includes('file-a.txt'), false);
    assert.equal(patchB.includes('content A modified'), false);

    // Unchanged path rejected with INVALID_PATCH_PATH when expectedSha256 is supplied
    await assert.rejects(
      readProjectPatch(project, 'source.txt', DEFAULT_PROJECT_LIMITS, preview.sha256),
      { code: 'INVALID_PATCH_PATH' }
    );

    // Concurrently altering the copy invalidates preview and throws REVIEW_CHANGED or CONTEXT_CHANGED
    await writeFile(path.join(project.copyDirectory, 'file-a.txt'), 'content A altered after preview\n');
    await assert.rejects(
      readProjectPatch(project, 'file-a.txt', DEFAULT_PROJECT_LIMITS, preview.sha256),
      (err: unknown) => err instanceof BridgeError && ['REVIEW_CHANGED', 'CONTEXT_CHANGED'].includes(err.code)
    );
  });
});

test('paths: directory junction ancestry rejection with identical file bytes and inode', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Directory junctions are specific to Windows');
    return;
  }
  const dir = await createRepo();
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'agy-external-junction-'));
  try {
    const localTarget = path.join(dir, 'source.txt');
    const outsideTarget = path.join(outsideDir, 'external-source.txt');
    await link(localTarget, outsideTarget);

    const junctionDir = path.join(dir, 'junction-ancestor');
    try {
      await symlink(outsideDir, junctionDir, 'junction');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'ENOSYS') {
        t.skip('Junction creation not permitted in this environment');
        return;
      }
      throw err;
    }

    try {
      // Prove that outsideTarget shares the exact same inode, device and size
      const localStat = await lstat(localTarget, { bigint: true });
      const extStat = await lstat(path.join(junctionDir, 'external-source.txt'), { bigint: true });
      assert.equal(extStat.ino, localStat.ino, 'Hard link must share inode number');
      assert.equal(extStat.dev, localStat.dev, 'Hard link must share device number');
      assert.equal(extStat.size, localStat.size);
      assert.equal(extStat.mtimeNs, localStat.mtimeNs);

      // checkedPath must reject traversal/ancestry even though inode, dev, and content match
      await assert.rejects(
        checkedPath(dir, 'junction-ancestor/external-source.txt', false),
        { code: 'UNSAFE_PROJECT_PATH' }
      );
      await assert.rejects(
        createProjectCopy(dir, ['junction-ancestor/external-source.txt']),
        { code: 'INVALID_INCLUDE_PATH' }
      );
    } finally {
      await rm(junctionDir, { force: true });
    }
  } finally {
    await rm(outsideDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

const SYNTHETIC_PEM_BEGIN = '-----BEGIN ' + 'PRIVATE KEY-----\n';
const SYNTHETIC_PEM_END = '-----END ' + 'PRIVATE KEY-----\n';

test('regression defect 1: private historical baseline blobs are inspected against current policy before patch or fork object creation', async () => {
  await withOutputFixture(async (project, source) => {
    const originalSource = await readFile(path.join(source, 'source.txt'), 'utf8');
    const legacySecretMarker = 'BRIDGE_SYNTHETIC_LEGACY_BASELINE_KEY_MARKER_01';
    const legacySecretBlob =
      SYNTHETIC_PEM_BEGIN +
      legacySecretMarker + '\n' +
      SYNTHETIC_PEM_END;
    const sanitizedCopyContent = 'BRIDGE_SYNTHETIC_SANITIZED_CURRENT_COPY_CONTENT\n';
    const scope = ['--git-dir=' + project.gitDirectory, '--work-tree=' + project.copyDirectory];

    // Fixture-only representation of a legacy snapshot whose private HEAD and baseline record
    // contain a synthetic secret in source.txt and a smudge attribute, while the current working copy is sanitized.
    await writeFile(path.join(project.copyDirectory, '.gitattributes'), 'source.txt filter=synthetic_smudge\n');
    await writeFile(path.join(project.copyDirectory, 'source.txt'), legacySecretBlob);
    await copyGit(project, [...scope, 'add', '-f', '--', '.gitattributes', 'source.txt']);
    await copyGit(project, [
      ...scope,
      '-c', 'user.name=Bridge Snapshot',
      '-c', 'user.email=bridge@invalid.local',
      'commit', '--quiet', '-m', 'legacy-contaminated-baseline',
    ]);
    await copyGit(project, [
      '--git-dir=' + project.gitDirectory,
      'config',
      'filter.synthetic_smudge.smudge',
      `"${process.execPath.replaceAll('\\', '/')}" -e "process.stdout.write('smudged harmless checkout\\n')"`,
    ]);
    project.baseline.set('.gitattributes', createHash('sha256').update('source.txt filter=synthetic_smudge\n').digest('hex'));
    project.baseline.set('source.txt', createHash('sha256').update(legacySecretBlob).digest('hex'));

    // Sanitize current working copy so only private HEAD holds the secret bytes
    await writeFile(path.join(project.copyDirectory, 'source.txt'), sanitizedCopyContent);
    await copyGit(project, [...scope, 'read-tree', 'HEAD']);

    await assert.rejects(previewProjectCopy(project), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'BLOCKED_FILE_DETECTED');
      assert.match(error.message, /baseline file.*SECRET_CONTENT/);
      assert.equal(error.message.includes(legacySecretMarker), false);
      assert.equal(error.message.includes(sanitizedCopyContent.trim()), false);
      return true;
    });

    // Rejected before staging the sanitized current copy into the Git object database
    await assertNoOutputBlob(project, sanitizedCopyContent);
    assert.equal(await readFile(path.join(source, 'source.txt'), 'utf8'), originalSource);

    await assert.rejects(readProjectPatch(project, 'source.txt'), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'BLOCKED_FILE_DETECTED');
      assert.equal(error.message.includes(legacySecretMarker), false);
      return true;
    });

    for (const op of [
      () => snapshotCopyFiles(project, DEFAULT_PROJECT_LIMITS),
      () => fingerprintProjectCopy(project),
      () => forkProjectCopy(project, DEFAULT_PROJECT_LIMITS),
    ]) {
      await assert.rejects(op(), (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.code, 'CONTEXT_CHANGED');
        assert.equal(error.message.includes(legacySecretMarker), false);
        return true;
      });
    }
  });
});

test('regression defect 1: binary secret blobs and policy-revoked deleted baseline files in HEAD fail closed', async () => {
  await withOutputFixture(async project => {
    const binaryMarker = 'BRIDGE_SYNTHETIC_BINARY_BASELINE_SECRET_02';
    const binarySecret = Buffer.concat([
      Buffer.from([0x00, 0xff, 0x00, 0x0a]),
      Buffer.from(`${SYNTHETIC_PEM_BEGIN}${binaryMarker}\n${SYNTHETIC_PEM_END}`, 'utf8'),
    ]);
    const scope = ['--git-dir=' + project.gitDirectory, '--work-tree=' + project.copyDirectory];

    await writeFile(path.join(project.copyDirectory, 'legacy.bin'), binarySecret);
    await copyGit(project, [...scope, 'add', '-f', '--', 'legacy.bin']);
    await copyGit(project, [
      ...scope,
      '-c', 'user.name=Bridge Snapshot',
      '-c', 'user.email=bridge@invalid.local',
      'commit', '--quiet', '-m', 'legacy-binary-secret',
    ]);
    project.baseline.set('legacy.bin', createHash('sha256').update(binarySecret).digest('hex'));

    // Even when deleted in the current working copy, removed binary secret in HEAD must be rejected
    await rm(path.join(project.copyDirectory, 'legacy.bin'));
    const extraChange = 'BRIDGE_SYNTHETIC_UNSTAGED_EXTRA_CHANGE\n';
    await writeFile(path.join(project.copyDirectory, 'source.txt'), extraChange);

    await assert.rejects(previewProjectCopy(project), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'BLOCKED_FILE_DETECTED');
      assert.match(error.message, /baseline file.*SECRET_CONTENT.*legacy\.bin/);
      assert.equal(error.message.includes(binaryMarker), false);
      return true;
    });
    await assertNoOutputBlob(project, extraChange);
    await assert.rejects(forkProjectCopy(project, DEFAULT_PROJECT_LIMITS), { code: 'CONTEXT_CHANGED' });
  });

  // Policy-revoked baseline file deleted in copyDirectory must not be silently omitted or emitted as deletion patch
  await withOutputFixture(async project => {
    await rm(path.join(project.copyDirectory, 'source.txt'));
    const revokedLimits = { ...DEFAULT_PROJECT_LIMITS, secretExclusions: ['source.txt'] };
    await assert.rejects(previewProjectCopy(project, revokedLimits), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'BLOCKED_FILE_DETECTED');
      assert.match(error.message, /baseline file.*SECRET_EXCLUSION.*source\.txt/);
      return true;
    });
    await assert.rejects(forkProjectCopy(project, revokedLimits), { code: 'CONTEXT_CHANGED' });
  });
});

test('regression defect 2: newly ignored baseline files are rejected even when private index is emptied', async () => {
  await withOutputFixture(async (project, source) => {
    const originalSource = await readFile(path.join(source, 'source.txt'), 'utf8');
    const mutatedIgnored = 'BRIDGE_SYNTHETIC_MUTATED_NOW_IGNORED_CONTENT\n';
    const gitignoreContent = 'source.txt\n';
    const scope = ['--git-dir=' + project.gitDirectory, '--work-tree=' + project.copyDirectory];

    await writeFile(path.join(project.copyDirectory, '.gitignore'), gitignoreContent);
    await writeFile(path.join(project.copyDirectory, 'source.txt'), mutatedIgnored);
    // Fixture empties mutable private index
    await copyGit(project, [...scope, 'read-tree', '--empty']);

    await assert.rejects(previewProjectCopy(project), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'CONTEXT_CHANGED');
      assert.match(error.message, /Baseline file became ignored: source\.txt/);
      assert.equal(error.message.includes(mutatedIgnored.trim()), false);
      assert.equal(error.message.includes(originalSource.trim()), false);
      return true;
    });

    await assertNoOutputBlob(project, mutatedIgnored);
    await assertNoOutputBlob(project, gitignoreContent);

    await assert.rejects(readProjectPatch(project, 'source.txt'), { code: 'CONTEXT_CHANGED' });
    await assert.rejects(snapshotCopyFiles(project, DEFAULT_PROJECT_LIMITS), { code: 'CONTEXT_CHANGED' });
    await assert.rejects(fingerprintProjectCopy(project), { code: 'CONTEXT_CHANGED' });
    await assert.rejects(forkProjectCopy(project, DEFAULT_PROJECT_LIMITS), { code: 'CONTEXT_CHANGED' });

    // Also when the newly ignored baseline file is deleted from disk while index is empty
    await rm(path.join(project.copyDirectory, 'source.txt'));
    await assert.rejects(previewProjectCopy(project), { code: 'CONTEXT_CHANGED' });
    await assert.rejects(forkProjectCopy(project, DEFAULT_PROJECT_LIMITS), { code: 'CONTEXT_CHANGED' });
  });

  // Also when source repository ignore rules (.git/info/exclude) newly ignore a baseline file while index is empty
  await withOutputFixture(async (project, source) => {
    const scope = ['--git-dir=' + project.gitDirectory, '--work-tree=' + project.copyDirectory];
    await mkdir(path.join(source, '.git', 'info'), { recursive: true });
    await writeFile(path.join(source, '.git', 'info', 'exclude'), 'source.txt\n');
    await copyGit(project, [...scope, 'read-tree', '--empty']);
    await rm(path.join(project.copyDirectory, 'source.txt'));
    await assert.rejects(previewProjectCopy(project), { code: 'CONTEXT_CHANGED' });
    await assert.rejects(forkProjectCopy(project, DEFAULT_PROJECT_LIMITS), { code: 'CONTEXT_CHANGED' });
  });
});

test('regression defect 2b: ignored directories are pruned by Git ls-files without unbounded recursive directory walks', async t => {
  await withOutputFixture(
    async project => {
      // Create an ignored node_modules tree with more files than tight maxCopyFiles limit
      const ignoredRoot = path.join(project.copyDirectory, 'node_modules');
      const nmDir = path.join(ignoredRoot, 'pkg-heavy', 'nested');
      await mkdir(nmDir, { recursive: true });
      for (let i = 0; i < 12; i++) {
        await writeFile(path.join(nmDir, `mod-${i}.js`), `module.exports = ${i};\n`);
      }
      await writeFile(path.join(project.copyDirectory, 'source.txt'), 'updated application source\n');

      const originalReaddir = fsPromises.readdir;
      let ignoredReaddirAttempts = 0;
      t.mock.method(fsPromises, 'readdir', ((...args: Parameters<typeof originalReaddir>) => {
        const target = path.resolve(String(args[0]));
        const normalized = target.replaceAll('\\', '/');
        if (
          target === path.resolve(ignoredRoot) ||
          target.startsWith(path.resolve(ignoredRoot) + path.sep) ||
          normalized.endsWith('/node_modules') ||
          normalized.includes('/node_modules/')
        ) {
          ignoredReaddirAttempts++;
          return Promise.reject(new Error('Unexpected Node readdir traversal into ignored node_modules: ' + target));
        }
        return Reflect.apply(originalReaddir, fsPromises, args);
      }) as typeof originalReaddir);
      syncBuiltinESMExports();

      try {
        // Control check proving instrumentation catches an attempted ignored-directory read via named binding
        await assert.rejects(
          readdir(ignoredRoot),
          /Unexpected Node readdir traversal into ignored node_modules/
        );
        assert.equal(ignoredReaddirAttempts, 1, 'Control check must confirm readdir spy intercepts ignored directory reads');
        ignoredReaddirAttempts = 0;

        const tightLimits = { ...DEFAULT_PROJECT_LIMITS, maxCopyFiles: 5 };
        const snapshot = await snapshotCopyFiles(project, tightLimits);
        assert.deepEqual([...snapshot.keys()], ['.gitignore', 'source.txt']);

        const preview = await previewProjectCopy(project, tightLimits);
        assert.deepEqual(preview.files, [{ status: 'M', path: 'source.txt' }]);
        assert.equal(ignoredReaddirAttempts, 0, 'Snapshot and preview must never traverse ignored node_modules via Node readdir');
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    },
    async source => {
      await writeFile(path.join(source, '.gitignore'), 'node_modules/\n');
    }
  );
});

test('regression defect 3: intact managed skills are excluded from gitattributes-driven patch diffs and source writes while preserving manifest verification and rejecting contaminated historical skill blobs', async () => {
  const dir = await createRepo();
  try {
    const skillMarker = '$Id: SYNTHETIC_IDENTIFIER_ONLY$';
    const skillContent =
      '---\n' +
      'name: ident-helper\n' +
      'description: Managed helper skill fixture\n' +
      '---\n' +
      `# Managed Helper Skill\n${skillMarker}\n`;
    const skills = [{ name: 'ident-helper', content: skillContent }];
    const copy = await createProjectCopy(dir, undefined, undefined, DEFAULT_PROJECT_LIMITS, skills);
    try {
      const skillRelPath = '.agents/skills/ident-helper/SKILL.md';
      const attrContent = `${skillRelPath} ident\n`;
      await writeFile(path.join(copy.copyDirectory, '.gitattributes'), attrContent);

      // Even if a legacy copy had the managed skill committed in HEAD, preview and integrate must exclude it
      const preview = await previewProjectCopy(copy);
      assert.deepEqual(preview.files, [{ status: 'A', path: '.gitattributes' }]);
      assert.equal(
        preview.patch.split(/\r?\n/).some((line) => line.startsWith('diff --git ') && line.includes(skillRelPath)),
        false,
      );
      assert.equal(preview.patch.includes(`+${skillRelPath} ident`), true);
      assert.equal(preview.patch.includes('SYNTHETIC_IDENTIFIER_ONLY'), false);

      // Simulate legacy copy where safe SKILL.md was also committed in HEAD before .gitattributes added ident
      const scope = ['--git-dir=' + copy.gitDirectory, '--work-tree=' + copy.copyDirectory];
      await copyGit(copy, [...scope, 'read-tree', 'HEAD']);
      await copyGit(copy, [...scope, 'add', '-f', '--', skillRelPath]);
      await copyGit(copy, [
        ...scope,
        '-c', 'user.name=Bridge Snapshot',
        '-c', 'user.email=bridge@invalid.local',
        'commit', '--quiet', '-m', 'legacy-skill-in-head',
      ]);

      const legacyPreview = await previewProjectCopy(copy);
      assert.deepEqual(legacyPreview.files, [{ status: 'A', path: '.gitattributes' }]);
      assert.equal(
        legacyPreview.patch.split(/\r?\n/).some((line) => line.startsWith('diff --git ') && line.includes(skillRelPath)),
        false,
      );
      assert.equal(legacyPreview.patch.includes(`+${skillRelPath} ident`), true);
      assert.equal(legacyPreview.patch.includes('SYNTHETIC_IDENTIFIER_ONLY'), false);

      // Integrate legitimate .gitattributes change and verify no auxiliary skill is written to sourceDirectory
      await integrateProjectCopy(copy, legacyPreview.sha256);
      assert.equal(await readFile(path.join(dir, '.gitattributes'), 'utf8'), attrContent);
      assert.equal(existsSync(path.join(dir, '.agents')), false);
      assert.equal(await readFile(path.join(copy.copyDirectory, skillRelPath), 'utf8'), skillContent);

      // Positive inheritance: fork preserves safe provided skills and tree fingerprint
      const forked = await forkProjectCopy(copy, DEFAULT_PROJECT_LIMITS);
      try {
        assert.equal(await readFile(path.join(forked.copyDirectory, skillRelPath), 'utf8'), skillContent);
        assert.equal(await fingerprintProjectCopy(forked), await fingerprintProjectCopy(copy));
      } finally {
        await discardProjectCopy(forked);
      }

      // Negative historical auxiliary contamination: synthetic PEM private key committed ONLY to legacy private HEAD
      // at the managed SKILL path while working SKILL is restored to original safe bytes matching current manifest.
      const contaminatedSkillMarker = 'BRIDGE_SYNTHETIC_HISTORICAL_SKILL_KEY_MARKER_04';
      const contaminatedSkillBlob =
        skillContent +
        SYNTHETIC_PEM_BEGIN +
        contaminatedSkillMarker + '\n' +
        SYNTHETIC_PEM_END;
      await writeFile(path.join(copy.copyDirectory, skillRelPath), contaminatedSkillBlob);
      await copyGit(copy, [...scope, 'read-tree', 'HEAD']);
      await copyGit(copy, [...scope, 'add', '-f', '--', skillRelPath]);
      await copyGit(copy, [
        ...scope,
        '-c', 'user.name=Bridge Snapshot',
        '-c', 'user.email=bridge@invalid.local',
        'commit', '--quiet', '-m', 'legacy-contaminated-skill-in-head',
      ]);
      // Restore working SKILL to original safe bytes matching current manifest
      await writeFile(path.join(copy.copyDirectory, skillRelPath), skillContent);
      await copyGit(copy, [...scope, 'read-tree', 'HEAD']);

      await assert.rejects(previewProjectCopy(copy), (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.code, 'BLOCKED_FILE_DETECTED');
        assert.match(error.message, /baseline file.*SECRET_CONTENT/);
        assert.equal(error.message.includes(contaminatedSkillMarker), false);
        return true;
      });
      await assert.rejects(readProjectPatch(copy, '.gitattributes'), (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.code, 'BLOCKED_FILE_DETECTED');
        assert.equal(error.message.includes(contaminatedSkillMarker), false);
        return true;
      });
      for (const op of [
        () => snapshotCopyFiles(copy, DEFAULT_PROJECT_LIMITS),
        () => fingerprintProjectCopy(copy),
        () => forkProjectCopy(copy, DEFAULT_PROJECT_LIMITS),
      ]) {
        await assert.rejects(op(), (error: unknown) => {
          assert.ok(error instanceof BridgeError);
          assert.equal(error.code, 'CONTEXT_CHANGED');
          assert.equal(error.message.includes(contaminatedSkillMarker), false);
          return true;
        });
      }

      // Tampering with the managed skill file still fails manifest verification before baseline inspection
      await writeFile(path.join(copy.copyDirectory, skillRelPath), '# Tampered skill\n');
      await assert.rejects(previewProjectCopy(copy), { code: 'SKILL_VERIFICATION_FAILED' });
      await assert.rejects(forkProjectCopy(copy, DEFAULT_PROJECT_LIMITS), { code: 'SKILL_VERIFICATION_FAILED' });
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('regression: deterministic after-scan HEAD swap in previewProjectCopy rejects with CONTEXT_CHANGED without exposing unscanned commit bytes', async t => {
  await withOutputFixture(async project => {
    const scope = ['--git-dir=' + project.gitDirectory, '--work-tree=' + project.copyDirectory];
    const originalHead = (await copyGit(project, ['--git-dir=' + project.gitDirectory, 'rev-parse', '--verify', 'HEAD^{commit}'])).toString('utf8').trim();

    // Create an unreferenced commit in gitDirectory containing a synthetic secret, then restore HEAD to originalHead
    const swappedMarker = 'BRIDGE_SYNTHETIC_AFTER_SCAN_SWAPPED_HEAD_SECRET_03';
    const swappedSecret = `${SYNTHETIC_PEM_BEGIN}${swappedMarker}\n${SYNTHETIC_PEM_END}`;
    await writeFile(path.join(project.copyDirectory, 'source.txt'), swappedSecret);
    await copyGit(project, [...scope, 'add', '-f', '--', 'source.txt']);
    await copyGit(project, [
      ...scope,
      '-c', 'user.name=Bridge Snapshot',
      '-c', 'user.email=bridge@invalid.local',
      'commit', '--quiet', '-m', 'unscanned-swapped-head',
    ]);
    const swappedCommit = (await copyGit(project, ['--git-dir=' + project.gitDirectory, 'rev-parse', '--verify', 'HEAD^{commit}'])).toString('utf8').trim();
    await copyGit(project, ['--git-dir=' + project.gitDirectory, 'update-ref', 'HEAD', originalHead]);
    await copyGit(project, [...scope, 'read-tree', originalHead]);

    // Write safe working copy edit
    await writeFile(path.join(project.copyDirectory, 'source.txt'), 'safe working copy update\n');

    const originalSpawn = childProcess.spawn;
    let swapped = false;
    let verifiedMovedHead = '';
    t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
      if (!swapped && Array.isArray(args[1]) && args[1].includes('diff')) {
        swapped = true;
        const gitFile = String(args[0]);
        const spawnOpts = (args[2] ?? {}) as { cwd?: string; env?: NodeJS.ProcessEnv };
        execFileSync(
          gitFile,
          ['--git-dir=' + project.gitDirectory, 'update-ref', 'HEAD', swappedCommit],
          { cwd: spawnOpts.cwd, env: spawnOpts.env, windowsHide: true }
        );
        verifiedMovedHead = execFileSync(
          gitFile,
          ['--git-dir=' + project.gitDirectory, 'rev-parse', '--verify', 'HEAD^{commit}'],
          { cwd: spawnOpts.cwd, env: spawnOpts.env, encoding: 'utf8', windowsHide: true }
        ).trim();
      }
      return originalSpawn(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(previewProjectCopy(project), (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.code, 'CONTEXT_CHANGED');
        assert.equal(error.message.includes(swappedMarker), false);
        return true;
      });
      assert.equal(swapped, true, 'Deterministic after-scan HEAD swap must trigger during diff');
      assert.equal(verifiedMovedHead, swappedCommit, 'Git update-ref must move HEAD to swappedCommit across files/reftable backends');
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await copyGit(project, ['--git-dir=' + project.gitDirectory, 'update-ref', 'HEAD', originalHead]).catch(() => {});
    }
  });
});

test('regression: conflicting execution policy path in source rejects before first Git add and persisted copy without HEAD fails closed', async t => {
  const dir = await createRepo();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'agy-policy-state-'));
  try {
    await mkdir(path.join(dir, '.agents'), { recursive: true });
    const conflictMarker = 'BRIDGE_SYNTHETIC_CONFLICTING_HOOKS_CONTENT';
    await writeFile(path.join(dir, '.agents', 'hooks.json'), `{"conflict":"${conflictMarker}"}\n`);

    const { resolveAgentPolicy } = await import('../src/agent-policy.js');
    const { randomUUID } = await import('node:crypto');
    const executionId = randomUUID();
    const policy = resolveAgentPolicy({ allowedTools: ['finish', 'view_file'] }, ['finish', 'view_file'], [], 'read-only', executionId);

    const originalSpawn = childProcess.spawn;
    let gitAddCalled = false;
    t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
      if (Array.isArray(args[1]) && args[1].includes('add')) {
        gitAddCalled = true;
      }
      return originalSpawn(...args);
    });
    syncBuiltinESMExports();

    let capturedProject: ProjectCopy | undefined;
    try {
      await assert.rejects(
        createProjectCopy(
          dir,
          undefined,
          p => { capturedProject = p; },
          DEFAULT_PROJECT_LIMITS,
          [],
          { policy, catalog: [], stateDirectory: stateDir, executionId }
        ),
        { code: 'CONFLICTING_EXECUTION_POLICY' }
      );
      assert.equal(gitAddCalled, false, 'Conflicting helper content must be rejected before first Git add');
      assert.ok(capturedProject, 'onCreated should capture project before stageProjectExecutionPolicy');
      assert.equal(existsSync(capturedProject.copyDirectory), false, 'Failed createProjectCopy must clean up copyDirectory');
      assert.equal(existsSync(capturedProject.gitDirectory), false, 'Failed createProjectCopy must clean up gitDirectory');
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }

    // Persisted copy whose HEAD is missing/unborn fails closed with GIT_OPERATION_FAILED
    await rm(path.join(dir, '.agents'), { recursive: true, force: true });
    const persisted = await createProjectCopy(dir);
    try {
      await copyGit(persisted, ['--git-dir=' + persisted.gitDirectory, 'symbolic-ref', 'HEAD', 'refs/heads/unborn-branch']);
      await assert.rejects(previewProjectCopy(persisted), { code: 'GIT_OPERATION_FAILED' });
      await assert.rejects(snapshotCopyFiles(persisted, DEFAULT_PROJECT_LIMITS), { code: 'GIT_OPERATION_FAILED' });
      await assert.rejects(forkProjectCopy(persisted, DEFAULT_PROJECT_LIMITS), { code: 'GIT_OPERATION_FAILED' });
    } finally {
      await discardProjectCopy(persisted);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('positive regressions: safe legacy baseline, legitimate deletions, and safe 12MB baseline larger than 10MB default Git output cap', async () => {
  const dir = await createRepo();
  try {
    await writeFile(path.join(dir, 'delete-me.txt'), 'legitimate file to delete\n');
    // 12 MiB safe baseline file (> 10,000,000 bytes MAX_GIT_OUTPUT default buffer limit, within 256MiB)
    const largeSize = 12 * 1024 * 1024;
    const largeBuffer = Buffer.alloc(largeSize, 'A');
    await writeFile(path.join(dir, 'large-safe.bin'), largeBuffer);

    const copy = await createProjectCopy(dir);
    try {
      // Simulate safe legacy snapshot with an additional safe file in HEAD and legitimate deletion of delete-me.txt
      const scope = ['--git-dir=' + copy.gitDirectory, '--work-tree=' + copy.copyDirectory];
      const legacySafeContent = 'safe legacy baseline file content\n';
      await writeFile(path.join(copy.copyDirectory, 'legacy-safe.txt'), legacySafeContent);
      await copyGit(copy, [...scope, 'add', '-f', '--', 'legacy-safe.txt']);
      await copyGit(copy, [
        ...scope,
        '-c', 'user.name=Bridge Snapshot',
        '-c', 'user.email=bridge@invalid.local',
        'commit', '--quiet', '-m', 'safe-legacy-baseline',
      ]);
      copy.baseline.set('legacy-safe.txt', createHash('sha256').update(legacySafeContent).digest('hex'));

      // Legitimate deletion and modification
      await rm(path.join(copy.copyDirectory, 'delete-me.txt'));
      await writeFile(path.join(copy.copyDirectory, 'source.txt'), 'updated safe source\n');

      const preview = await previewProjectCopy(copy);
      assert.deepEqual(preview.files, [
        { status: 'D', path: 'delete-me.txt' },
        { status: 'M', path: 'source.txt' },
      ]);
      assert.equal(preview.summary.deleted, 1);
      assert.equal(preview.summary.modified, 1);

      const snapshot = await snapshotCopyFiles(copy, DEFAULT_PROJECT_LIMITS);
      assert.equal(snapshot.has('delete-me.txt'), false);
      assert.equal(snapshot.has('large-safe.bin'), true);
      assert.equal(snapshot.has('legacy-safe.txt'), true);

      const fork = await forkProjectCopy(copy, DEFAULT_PROJECT_LIMITS);
      try {
        assert.equal(existsSync(path.join(fork.copyDirectory, 'delete-me.txt')), false);
        assert.equal((await lstat(path.join(fork.copyDirectory, 'large-safe.bin'))).size, largeSize);
        const forkPreview = await previewProjectCopy(fork);
        assert.deepEqual(forkPreview.files, preview.files);
      } finally {
        await discardProjectCopy(fork);
      }
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function encodeUtf16Le(text: string, withBom = false): Buffer {
  const body = Buffer.from(text, 'utf16le');
  return withBom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
}

function encodeUtf16Be(text: string, withBom = false): Buffer {
  const le = Buffer.from(text, 'utf16le');
  const body = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    body[i] = le[i + 1]!;
    body[i + 1] = le[i]!;
  }
  return withBom ? Buffer.concat([Buffer.from([0xfe, 0xff]), body]) : body;
}

function encodeUtf32Le(text: string, withBom = false): Buffer {
  const cps = Array.from(text, ch => ch.codePointAt(0)!);
  const body = Buffer.alloc(cps.length * 4);
  for (let i = 0; i < cps.length; i++) {
    body.writeUInt32LE(cps[i]!, i * 4);
  }
  return withBom ? Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), body]) : body;
}

function encodeUtf32Be(text: string, withBom = false): Buffer {
  const cps = Array.from(text, ch => ch.codePointAt(0)!);
  const body = Buffer.alloc(cps.length * 4);
  for (let i = 0; i < cps.length; i++) {
    body.writeUInt32BE(cps[i]!, i * 4);
  }
  return withBom ? Buffer.concat([Buffer.from([0x00, 0x00, 0xfe, 0xff]), body]) : body;
}

test('regression: BOM/NUL-padded Unicode secret signatures are blocked before Git object insertion even with working-tree-encoding while preserving safe Unicode sources', async () => {
  const dir = await createRepo();
  try {
    const marker = 'BRIDGE_SYNTHETIC_UNICODE_PEM_KEY_MARKER_09';
    const pemPayload = `${SYNTHETIC_PEM_BEGIN}${marker}\n${SYNTHETIC_PEM_END}`;
    const safeUnicodeText = 'legitimate UTF-16 source text — Café 日本語\n';
    const safeUnicodeBuf = encodeUtf16Le(safeUnicodeText, true);
    const gitattributesContent =
      'source.txt working-tree-encoding=UTF-16\n' +
      'safe-unicode.txt working-tree-encoding=UTF-16\n';

    await writeFile(path.join(dir, '.gitattributes'), gitattributesContent);
    await writeFile(path.join(dir, 'source.txt'), encodeUtf16Le(pemPayload, true));
    await writeFile(path.join(dir, 'safe-unicode.txt'), safeUnicodeBuf);

    // BOM and non-BOM endian variants under neutral .txt names
    const variantFiles: Array<[string, Buffer]> = [
      ['utf16le-bom.txt', encodeUtf16Le(pemPayload, true)],
      ['utf16le-nobom.txt', encodeUtf16Le(pemPayload, false)],
      ['utf16be-bom.txt', encodeUtf16Be(pemPayload, true)],
      ['utf16be-nobom.txt', encodeUtf16Be(pemPayload, false)],
      ['utf32le-bom.txt', encodeUtf32Le(pemPayload, true)],
      ['utf32le-nobom.txt', encodeUtf32Le(pemPayload, false)],
      ['utf32be-bom.txt', encodeUtf32Be(pemPayload, true)],
      ['utf32be-nobom.txt', encodeUtf32Be(pemPayload, false)],
    ];
    for (const [name, buf] of variantFiles) {
      await writeFile(path.join(dir, name), buf);
    }

    // Bounded generated fixture where the UTF-16LE PEM header crosses the 64KiB (65536-byte) read window boundary
    const padUnit = Buffer.from('safe-window-pad\n', 'utf16le'); // 32 bytes
    const prefixTargetBytes = 65520 - 2; // 2 bytes for BOM -> header starts at offset 65520 and crosses 65536
    const fullUnits = Math.floor(prefixTargetBytes / padUnit.length);
    const remBytes = prefixTargetBytes - fullUnits * padUnit.length;
    const remPad = Buffer.from(' '.repeat(remBytes / 2 - 1) + '\n', 'utf16le');
    const windowCrossingBuf = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      ...Array.from({ length: fullUnits }, () => padUnit),
      remPad,
      encodeUtf16Le(pemPayload, false),
    ]);
    assert.ok(windowCrossingBuf.length > 65536);
    await writeFile(path.join(dir, 'window-crossing-utf16le.txt'), windowCrossingBuf);

    // Name-only v2 secretExceptions cannot bypass encoded secret content
    const awsMarker = 'BRIDGESYNTHETICENCODEDAWSKEY1234567890';
    await writeFile(
      path.join(dir, '.env.local'),
      encodeUtf16Be(`AWS_SECRET_ACCESS_KEY=${awsMarker}\n`, true),
    );
    await writeFile(path.join(dir, 'server.key'), encodeUtf16Le(pemPayload, true));
    const harmlessEnvBuf = encodeUtf16Le('PORT=8080\nAPP_NAME=safe-unicode-env\n', true);
    await writeFile(path.join(dir, 'harmless.env.local'), harmlessEnvBuf);

    // Safe UTF-16 source file with synthetic string literal and safe UTF-16 public certificate
    await mkdir(path.join(dir, 'src'), { recursive: true });
    const safeSourceBuf = encodeUtf16Le(
      `export const MOCK_KEY = "${SYNTHETIC_PEM_BEGIN.trim()}\\nMOCK\\n${SYNTHETIC_PEM_END.trim()}";\n`,
      true,
    );
    await writeFile(path.join(dir, 'src', 'unicode-auth.ts'), safeSourceBuf);
    const safeCertBuf = encodeUtf16Le(
      '-----BEGIN ' + 'CERTIFICATE-----\nSAFE_CERT_BODY\n-----END ' + 'CERTIFICATE-----\n',
      true,
    );
    await writeFile(path.join(dir, 'cert-utf16.pem'), safeCertBuf);

    const limits = {
      ...DEFAULT_PROJECT_LIMITS,
      secretExceptions: {
        version: 2 as const,
        namePatterns: ['.env.local', 'server.key', 'harmless.env.local'],
      },
    };

    const listed = await listProjectFiles(dir);
    assert.equal(listed.includes('source.txt'), false);
    assert.equal(listed.includes('window-crossing-utf16le.txt'), false);
    for (const [name] of variantFiles) {
      assert.equal(listed.includes(name), false);
    }
    assert.ok(listed.includes('safe-unicode.txt'));
    assert.ok(listed.includes('src/unicode-auth.ts'));
    assert.ok(listed.includes('cert-utf16.pem'));

    const copy = await createProjectCopy(dir, undefined, undefined, limits);
    try {
      const blockedExpected = [
        'source.txt',
        'window-crossing-utf16le.txt',
        '.env.local',
        'server.key',
        ...variantFiles.map(([name]) => name),
      ];
      for (const blockedPath of blockedExpected) {
        assert.equal(copy.includedFiles.includes(blockedPath), false, `${blockedPath} must not be included`);
        assert.equal(existsSync(path.join(copy.copyDirectory, blockedPath)), false, `${blockedPath} must not exist in copy`);
        assert.ok(
          copy.blockedFiles?.some(b => b.path === blockedPath && b.reason === 'SECRET_CONTENT'),
          `${blockedPath} must be recorded as SECRET_CONTENT`,
        );
      }

      // Verify neither canonical UTF-8 PEM nor raw encoded bytes entered the private Git object database
      await assertNoOutputBlob(copy, pemPayload);
      const rawUtf16Oid = (
        await copyGit(copy, ['--git-dir=' + copy.gitDirectory, 'hash-object', '--stdin'], encodeUtf16Le(pemPayload, true))
      ).toString('utf8').trim();
      const rawUtf16Check = (
        await copyGit(copy, ['--git-dir=' + copy.gitDirectory, 'cat-file', '--batch-check'], Buffer.from(rawUtf16Oid + '\n'))
      ).toString('utf8').trim();
      assert.equal(rawUtf16Check, `${rawUtf16Oid} missing`);
      const headTree = (
        await copyGit(copy, ['--git-dir=' + copy.gitDirectory, 'ls-tree', '-r', '--name-only', 'HEAD'])
      ).toString('utf8');
      assert.equal(headTree.includes('source.txt'), false);
      assert.equal(headTree.includes('window-crossing-utf16le.txt'), false);

      // Verify safe Unicode source was copied byte-for-byte and the private baseline keeps its bytes, not a UTF-8 conversion
      assert.ok(copy.includedFiles.includes('safe-unicode.txt'));
      const copiedSafeBytes = await readFile(path.join(copy.copyDirectory, 'safe-unicode.txt'));
      assert.deepEqual(copiedSafeBytes, safeUnicodeBuf);
      assert.equal(
        copy.baseline.get('safe-unicode.txt'),
        createHash('sha256').update(safeUnicodeBuf).digest('hex'),
      );
      const baselineBlob = await copyGit(copy, ['--git-dir=' + copy.gitDirectory, 'show', 'HEAD:safe-unicode.txt']);
      assert.deepEqual(baselineBlob, safeUnicodeBuf);

      // Verify safe source, public certificate, and harmless excepted env remain intact byte-for-byte
      assert.deepEqual(await readFile(path.join(copy.copyDirectory, 'src', 'unicode-auth.ts')), safeSourceBuf);
      assert.deepEqual(await readFile(path.join(copy.copyDirectory, 'cert-utf16.pem')), safeCertBuf);
      assert.deepEqual(await readFile(path.join(copy.copyDirectory, 'harmless.env.local')), harmlessEnvBuf);

      // Verify post-copy contamination of safe-unicode.txt with UTF-16LE private key fails closed before Git staging
      await writeFile(path.join(copy.copyDirectory, 'safe-unicode.txt'), encodeUtf16Le(pemPayload, true));
      await assert.rejects(previewProjectCopy(copy, limits), (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'BLOCKED_FILE_DETECTED');
        assert.match(err.message, /SECRET_CONTENT/);
        assert.equal(err.message.includes(marker), false);
        return true;
      });
      await assertNoOutputBlob(copy, pemPayload);
      await assert.rejects(snapshotCopyFiles(copy, limits), { code: 'CONTEXT_CHANGED' });
      await assert.rejects(fingerprintProjectCopy(copy), { code: 'CONTEXT_CHANGED' });
      await assert.rejects(forkProjectCopy(copy, limits), { code: 'CONTEXT_CHANGED' });
    } finally {
      await discardProjectCopy(copy);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
