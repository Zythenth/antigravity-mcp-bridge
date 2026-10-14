import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DEFAULT_PROJECT_LIMITS, loadConfig } from '../src/config.js';
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
} from '../src/isolation.js';
import { BridgeError } from '../src/types.js';
import {
  detectSecretContent,
  validateGlobPattern,
  matchProjectRelativeGlob,
  preflightProjectFiles,
} from '../src/secret-preflight.js';

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
      secretExceptions: ['.env.local'],
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
      secretExceptions: ['.env.local'],
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
      secretExceptions: ['git-ignored.txt'],
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
      secretExceptions: ['../outside.txt'],
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
    await writeFile(outsideTarget, 'outside file content\n');
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
        await rm(junctionDir, { force: true });
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
  const valid = loadConfig({
    BRIDGE_SECRET_EXCLUSIONS: JSON.stringify(['*.env', 'secrets/**']),
    BRIDGE_SECRET_EXCEPTIONS: JSON.stringify(['.env.template']),
  });
  assert.deepEqual(valid.secretExclusions, ['*.env', 'secrets/**']);
  assert.deepEqual(valid.secretExceptions, ['.env.template']);

  // Invalid JSON format
  assert.throws(() => loadConfig({ BRIDGE_SECRET_EXCLUSIONS: 'not-json' }), /must be a JSON array of strings/);

  // Invalid traversal pattern
  assert.throws(
    () => loadConfig({ BRIDGE_SECRET_EXCLUSIONS: JSON.stringify(['../outside']) }),
    /must contain relative glob patterns without traversal/
  );

  // Invalid absolute path pattern
  assert.throws(
    () => loadConfig({ BRIDGE_SECRET_EXCEPTIONS: JSON.stringify(['/root/secret']) }),
    /must contain relative glob patterns without traversal/
  );
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
