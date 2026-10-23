import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import {
  cliEnvironment,
  WINDOWS_PATHEXT_FALLBACK,
} from '../src/cli-environment.js';
import { loadConfig } from '../src/config.js';
import { BridgeError } from '../src/types.js';

test('preserves required system, home, temp, locale, proxy, cert, and keyring variables', () => {
  const source: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    PATHEXT: '.COM;.EXE;.BAT',
    SystemRoot: 'C:\\Windows',
    SystemDrive: 'C:',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    WINDIR: 'C:\\Windows',
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',

    HOME: '/home/synthetic-user',
    USERPROFILE: 'C:\\Users\\synthetic-user',
    APPDATA: 'C:\\Users\\synthetic-user\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\synthetic-user\\AppData\\Local',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\synthetic-user',
    USER: 'synthetic-user',
    LOGNAME: 'synthetic-user',
    USERNAME: 'synthetic-user',

    TEMP: '/tmp/synthetic-temp',
    TMP: '/tmp/synthetic-tmp',
    TMPDIR: '/tmp/synthetic-tmpdir',

    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'en_US.UTF-8',
    LC_MESSAGES: 'en_US.UTF-8',
    TZ: 'UTC',

    XDG_CONFIG_HOME: '/home/synthetic-user/.config',
    XDG_DATA_HOME: '/home/synthetic-user/.local/share',
    XDG_CACHE_HOME: '/home/synthetic-user/.cache',
    XDG_RUNTIME_DIR: '/run/user/1000',
    XDG_DATA_DIRS: '/usr/local/share:/usr/share',
    XDG_CONFIG_DIRS: '/etc/xdg',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    GNOME_KEYRING_CONTROL: '/run/user/1000/keyring',
    GNOME_KEYRING_PID: '1234',
    SECURITYSESSIONID: '186a7',

    SSH_CONNECTION: '192.168.1.100 54321 192.168.1.1 22',
    SSH_CLIENT: '192.168.1.100 54321 22',
    SSH_TTY: '/dev/pts/1',

    HTTP_PROXY: 'http://proxy.synthetic.local:8080',
    HTTPS_PROXY: 'https://proxy.synthetic.local:8443',
    ALL_PROXY: 'socks5://proxy.synthetic.local:1080',
    NO_PROXY: 'localhost,127.0.0.1,.local',

    SSL_CERT_FILE: '/etc/ssl/certs/synthetic-ca-certificates.crt',
    SSL_CERT_DIR: '/etc/ssl/certs',
    REQUESTS_CA_BUNDLE: '/etc/ssl/certs/synthetic-requests.crt',
    CURL_CA_BUNDLE: '/etc/ssl/certs/synthetic-curl.crt',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/synthetic-node.crt',

    OS: 'Windows_NT',
    PROCESSOR_ARCHITECTURE: 'AMD64',
    PROCESSOR_ARCHITEW6432: 'AMD64',
    NUMBER_OF_PROCESSORS: '8',
    ProgramData: 'C:\\ProgramData',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    CommonProgramFiles: 'C:\\Program Files\\Common Files',
    'CommonProgramFiles(x86)': 'C:\\Program Files (x86)\\Common Files',
    USERDOMAIN: 'SYNTHETIC_DOMAIN',
    USERDNSDOMAIN: 'CORP.SYNTHETIC.LOCAL',
    COMPUTERNAME: 'SYNTHETIC-HOST',
  };

  const env = cliEnvironment([], source, 'win32');

  for (const [key, expectedValue] of Object.entries(source)) {
    assert.equal(env[key], expectedValue, `Expected ${key} to be preserved`);
  }
});

test('Unix independently preserves both exact uppercase and lowercase proxy names', () => {
  const source: NodeJS.ProcessEnv = {
    HTTP_PROXY: 'http://upper.proxy:8080',
    http_proxy: 'http://lower.proxy:8080',
    HTTPS_PROXY: 'https://upper.proxy:8443',
    https_proxy: 'https://lower.proxy:8443',
    ALL_PROXY: 'socks5://upper.proxy:1080',
    all_proxy: 'socks5://lower.proxy:1080',
    NO_PROXY: 'upper.local',
    no_proxy: 'lower.local',
  };

  const env = cliEnvironment([], source, 'linux');

  assert.equal(env.HTTP_PROXY, 'http://upper.proxy:8080');
  assert.equal(env.http_proxy, 'http://lower.proxy:8080');
  assert.equal(env.HTTPS_PROXY, 'https://upper.proxy:8443');
  assert.equal(env.https_proxy, 'https://lower.proxy:8443');
  assert.equal(env.ALL_PROXY, 'socks5://upper.proxy:1080');
  assert.equal(env.all_proxy, 'socks5://lower.proxy:1080');
  assert.equal(env.NO_PROXY, 'upper.local');
  assert.equal(env.no_proxy, 'lower.local');
});

test('excludes SSH_AUTH_SOCK and GPG_AGENT_INFO by default but allows explicit opt-in', () => {
  const source: NodeJS.ProcessEnv = {
    SSH_AUTH_SOCK: '/tmp/synthetic-ssh-agent.sock',
    GPG_AGENT_INFO: '/tmp/synthetic-gpg-agent:1234:1',
    SSH_CONNECTION: '192.168.1.100 54321 192.168.1.1 22',
    SSH_CLIENT: '192.168.1.100 54321 22',
    SSH_TTY: '/dev/pts/1',
  };

  // Default: agent socket credentials are excluded; remote session context is preserved
  const defaultEnv = cliEnvironment([], source, 'linux');
  assert.equal(defaultEnv.SSH_AUTH_SOCK, undefined, 'SSH_AUTH_SOCK must be excluded by default');
  assert.equal(defaultEnv.GPG_AGENT_INFO, undefined, 'GPG_AGENT_INFO must be excluded by default');
  assert.equal(defaultEnv.SSH_CONNECTION, '192.168.1.100 54321 192.168.1.1 22');
  assert.equal(defaultEnv.SSH_CLIENT, '192.168.1.100 54321 22');
  assert.equal(defaultEnv.SSH_TTY, '/dev/pts/1');

  // Opt-in via allowedEnvVars
  const optInEnv = cliEnvironment(['SSH_AUTH_SOCK', 'GPG_AGENT_INFO'], source, 'linux');
  assert.equal(optInEnv.SSH_AUTH_SOCK, '/tmp/synthetic-ssh-agent.sock');
  assert.equal(optInEnv.GPG_AGENT_INFO, '/tmp/synthetic-gpg-agent:1234:1');
});

test('preserves official Gemini CLI auth and Google ADC context, excludes GOOGLE_API_KEY by default', () => {
  const source: NodeJS.ProcessEnv = {
    GEMINI_API_KEY: 'synthetic-gemini-key-112233',
    GOOGLE_GEMINI_BASE_URL: 'https://custom.gemini.synthetic.endpoint/v1',
    GOOGLE_APPLICATION_CREDENTIALS: '/var/secrets/synthetic-adc-sa.json',
    GOOGLE_CLOUD_PROJECT: 'synthetic-project-id',
    GCLOUD_PROJECT: 'synthetic-legacy-project-id',
    GOOGLE_CLOUD_UNIVERSE_DOMAIN: 'synthetic.universe.domain',
    GOOGLE_API_KEY: 'synthetic-google-api-key-unconsumed',
  };

  const env = cliEnvironment([], source, 'linux');

  assert.equal(env.GEMINI_API_KEY, 'synthetic-gemini-key-112233');
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, 'https://custom.gemini.synthetic.endpoint/v1');
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, '/var/secrets/synthetic-adc-sa.json');
  assert.equal(env.GOOGLE_CLOUD_PROJECT, 'synthetic-project-id');
  assert.equal(env.GCLOUD_PROJECT, 'synthetic-legacy-project-id');
  assert.equal(env.GOOGLE_CLOUD_UNIVERSE_DOMAIN, 'synthetic.universe.domain');

  // GOOGLE_API_KEY alone is not consumed and must be excluded by default
  assert.equal(env.GOOGLE_API_KEY, undefined);
});

test('excludes unrelated third-party service credentials by default', () => {
  const source: NodeJS.ProcessEnv = {
    AWS_ACCESS_KEY_ID: 'synthetic-aws-access-key-id',
    AWS_SECRET_ACCESS_KEY: 'synthetic-aws-secret-access-key',
    AWS_SESSION_TOKEN: 'synthetic-aws-session-token',
    GITHUB_TOKEN: 'synthetic-ghp-token-12345',
    GH_TOKEN: 'synthetic-gho-token-67890',
    OPENAI_API_KEY: 'synthetic-sk-openai-token',
    STRIPE_API_KEY: 'synthetic-sk_live_stripe_secret',
    STRIPE_SECRET_KEY: 'synthetic-rk_live_stripe_key',
    SSH_AUTH_SOCK: 'synthetic-ssh-agent-secret',
    GPG_AGENT_INFO: 'synthetic-gpg-agent-secret',
  };

  const env = cliEnvironment([], source, 'linux');

  for (const key of Object.keys(source)) {
    assert.equal(env[key], undefined, `Expected unrelated credential ${key} to be excluded`);
  }
});

test('excludes runtime injection and library loading variables by default', () => {
  const source: NodeJS.ProcessEnv = {
    NODE_OPTIONS: '--require /tmp/malicious.js',
    NODE_PATH: '/tmp/fake-node-modules',
    LD_PRELOAD: '/tmp/malicious.so',
    LD_LIBRARY_PATH: '/tmp/malicious-lib',
    DYLD_LIBRARY_PATH: '/tmp/malicious-dylib',
    DYLD_INSERT_LIBRARIES: '/tmp/malicious-insert.dylib',
  };

  const env = cliEnvironment([], source, 'linux');

  for (const key of Object.keys(source)) {
    assert.equal(env[key], undefined, `Expected runtime injection variable ${key} to be excluded`);
  }
});

test('rejects broad prefix catch-alls for GOOGLE_, GEMINI_, and AGY_', () => {
  const source: NodeJS.ProcessEnv = {
    GOOGLE_INTERNAL_SECRET: 'synthetic-google-internal',
    GOOGLE_AUTH_TOKEN: 'synthetic-google-auth',
    GEMINI_UNAPPROVED_CONTEXT: 'synthetic-gemini-unapproved',
    AGY_INTERNAL_CONFIG: 'synthetic-agy-config',
    AGY_API_SECRET: 'synthetic-agy-secret',
  };

  const env = cliEnvironment([], source, 'linux');

  for (const key of Object.keys(source)) {
    assert.equal(env[key], undefined, `Prefix catch-all for ${key} must not be allowed`);
  }
});

test('supports configurable opt-in through allowedEnvVars', () => {
  const source: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: 'synthetic-openai-secret',
    GOOGLE_API_KEY: 'synthetic-opted-in-google-key',
    CUSTOM_DEPLOY_SECRET: 'synthetic-deploy-key',
    CUSTOM_NON_INJECTABLE_VAR: 'synthetic-safe-val-123',
    AWS_SECRET_ACCESS_KEY: 'synthetic-aws-still-excluded',
  };

  const env = cliEnvironment(
    ['OPENAI_API_KEY', 'GOOGLE_API_KEY', '  CUSTOM_DEPLOY_SECRET  ', 'CUSTOM_NON_INJECTABLE_VAR'],
    source,
    'linux'
  );

  assert.equal(env.OPENAI_API_KEY, 'synthetic-openai-secret');
  assert.equal(env.GOOGLE_API_KEY, 'synthetic-opted-in-google-key');
  assert.equal(env.CUSTOM_DEPLOY_SECRET, 'synthetic-deploy-key');
  assert.equal(env.CUSTOM_NON_INJECTABLE_VAR, 'synthetic-safe-val-123');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, 'Non-opted-in secret remains excluded');
});

test('Windows environment names are compared case-insensitively without duplicate aliases', () => {
  const source: NodeJS.ProcessEnv = {
    HTTP_PROXY: 'http://first.proxy:8080',
    http_proxy: 'http://second.proxy:8080',
    Path: 'C:\\first\\path',
    PATH: 'C:\\second\\path',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    COMSPEC: 'C:\\Windows\\system32\\cmd_alias.exe',
    gemini_api_key: 'synthetic-gemini-key-lowercase',
    CUSTOM_OPT_IN: 'synthetic-opt-val',
  };

  const env = cliEnvironment(['custom_opt_in'], source, 'win32');

  const proxyKeys = Object.keys(env).filter(k => k.toUpperCase() === 'HTTP_PROXY');
  assert.equal(proxyKeys.length, 1, 'Windows result must contain at most one HTTP_PROXY alias');
  assert.equal(env[proxyKeys[0]!], 'http://first.proxy:8080', 'Windows preserves first source value for HTTP_PROXY alias');

  const pathKeys = Object.keys(env).filter(k => k.toUpperCase() === 'PATH');
  assert.equal(pathKeys.length, 1, 'Windows result must contain at most one PATH alias');
  assert.equal(env[pathKeys[0]!], 'C:\\first\\path', 'Original casing and first entry value preserved');

  const comspecKeys = Object.keys(env).filter(k => k.toUpperCase() === 'COMSPEC');
  assert.equal(comspecKeys.length, 1, 'Windows result must contain at most one COMSPEC alias');
  assert.equal(env[comspecKeys[0]!], 'C:\\Windows\\system32\\cmd.exe');

  const geminiKeys = Object.keys(env).filter(k => k.toUpperCase() === 'GEMINI_API_KEY');
  assert.equal(geminiKeys.length, 1);
  assert.equal(geminiKeys[0], 'gemini_api_key', 'Original lowercase casing preserved');
  assert.equal(env['gemini_api_key'], 'synthetic-gemini-key-lowercase');

  const optInKeys = Object.keys(env).filter(k => k.toUpperCase() === 'CUSTOM_OPT_IN');
  assert.equal(optInKeys.length, 1);
  assert.equal(optInKeys[0], 'CUSTOM_OPT_IN');
  assert.equal(env['CUSTOM_OPT_IN'], 'synthetic-opt-val');
});

test('Windows PATHEXT handling: absent gets fallback, explicit including empty is preserved', () => {
  // Scenario 1: Absent PATHEXT gets the existing fallback
  const absentResult = cliEnvironment([], { PATH: 'C:\\bin' }, 'win32');
  assert.equal(absentResult.PATHEXT, WINDOWS_PATHEXT_FALLBACK);

  // Scenario 2: Undefined PATHEXT gets fallback
  const undefinedResult = cliEnvironment([], { PATH: 'C:\\bin', PATHEXT: undefined }, 'win32');
  assert.equal(undefinedResult.PATHEXT, WINDOWS_PATHEXT_FALLBACK);

  // Scenario 3: Explicit PATHEXT is preserved without duplicate fallback
  const explicitResult = cliEnvironment([], { PATHEXT: '.EXE;.BAT' }, 'win32');
  assert.equal(explicitResult.PATHEXT, '.EXE;.BAT');
  const explicitKeys = Object.keys(explicitResult).filter(k => k.toUpperCase() === 'PATHEXT');
  assert.equal(explicitKeys.length, 1);

  // Scenario 4: Explicitly empty PATHEXT is preserved
  const emptyResult = cliEnvironment([], { PATHEXT: '' }, 'win32');
  assert.equal(emptyResult.PATHEXT, '');
  assert.notEqual(emptyResult.PATHEXT, WINDOWS_PATHEXT_FALLBACK);

  // Scenario 5: Lowercase explicitly empty pathext is preserved without duplicate alias
  const lowercaseEmptyResult = cliEnvironment([], { pathext: '' }, 'win32');
  assert.equal(lowercaseEmptyResult['pathext'], '');
  assert.equal(lowercaseEmptyResult['PATHEXT'], undefined);
  const pathextKeys = Object.keys(lowercaseEmptyResult).filter(k => k.toUpperCase() === 'PATHEXT');
  assert.equal(pathextKeys.length, 1);
  assert.equal(pathextKeys[0], 'pathext');

  // Scenario 6: Lowercase explicit pathext with value is preserved
  const lowercaseValResult = cliEnvironment([], { pathext: '.EXE' }, 'win32');
  assert.equal(lowercaseValResult['pathext'], '.EXE');
  assert.equal(lowercaseValResult['PATHEXT'], undefined);
  assert.equal(Object.keys(lowercaseValResult).filter(k => k.toUpperCase() === 'PATHEXT').length, 1);
});

test('Unix environment names remain strictly case-sensitive', () => {
  const source: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    path: '/custom/bin',
    HOME: '/home/synthetic-user',
    home: '/other/path',
    GEMINI_API_KEY: 'synthetic-gemini-exact-upper',
    gemini_api_key: 'synthetic-gemini-lower',
    CUSTOM_VAR: 'exact-upper',
    custom_var: 'exact-lower',
  };

  const env = cliEnvironment(['custom_var'], source, 'linux');

  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env['path'], undefined, 'Unix must not match lowercase path');
  assert.equal(env.HOME, '/home/synthetic-user');
  assert.equal(env['home'], undefined, 'Unix must not match lowercase home');
  assert.equal(env.GEMINI_API_KEY, 'synthetic-gemini-exact-upper');
  assert.equal(env['gemini_api_key'], undefined, 'Unix must not match lowercase gemini_api_key');
  assert.equal(env['custom_var'], 'exact-lower');
  assert.equal(env['CUSTOM_VAR'], undefined, 'Unix must not match mismatched casing for opt-in variable');
});

test('Unix does not add fallback for absent PATHEXT', () => {
  const env = cliEnvironment([], { PATH: '/usr/bin' }, 'linux');
  assert.equal(env['PATHEXT'], undefined, 'Unix absent PATHEXT must not receive fallback');

  // Explicit PATHEXT on Unix is preserved
  const withPathext = cliEnvironment([], { PATH: '/usr/bin', PATHEXT: '.sh' }, 'linux');
  assert.equal(withPathext['PATHEXT'], '.sh');
});

test('does not log secrets or write output to console or stdio streams', () => {
  const syntheticGeminiKey = 'synthetic-secret-gemini-key-never-log-12345';
  const syntheticAwsKey = 'synthetic-secret-aws-key-never-log-67890';
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  let captured = '';
  const intercept = (chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  };

  try {
    console.log = (...args: unknown[]) => { captured += args.map(String).join(' ') + '\n'; };
    console.error = (...args: unknown[]) => { captured += args.map(String).join(' ') + '\n'; };
    console.warn = (...args: unknown[]) => { captured += args.map(String).join(' ') + '\n'; };
    process.stdout.write = intercept as typeof process.stdout.write;
    process.stderr.write = intercept as typeof process.stderr.write;

    const filtered = cliEnvironment(
      ['OPT_IN_SECRET'],
      {
        GEMINI_API_KEY: syntheticGeminiKey,
        AWS_SECRET_ACCESS_KEY: syntheticAwsKey,
        OPT_IN_SECRET: 'synthetic-opt-in-secret-value',
      },
      'win32'
    );

    assert.equal(filtered.GEMINI_API_KEY, syntheticGeminiKey);
    assert.equal(captured, '', 'cliEnvironment must not write to any log or stdio stream');
    assert.ok(!captured.includes(syntheticGeminiKey));
    assert.ok(!captured.includes(syntheticAwsKey));
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
});

test('real Node child process observes filtered environment and resists NODE_OPTIONS injection', () => {
  const syntheticGeminiKey = 'synthetic-gemini-key-child-test-998877';
  const syntheticAwsKey = 'synthetic-aws-secret-child-test-112233';
  const syntheticNodeOptions = '--require ./nonexistent-malicious-script-should-not-load.js';
  const syntheticOptInVar = 'synthetic-opt-in-child-value-445566';

  const sourceEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GEMINI_API_KEY: syntheticGeminiKey,
    AWS_SECRET_ACCESS_KEY: syntheticAwsKey,
    NODE_OPTIONS: syntheticNodeOptions,
    CUSTOM_OPTED_IN: syntheticOptInVar,
  };

  const filtered = cliEnvironment(['CUSTOM_OPTED_IN'], sourceEnv, process.platform);

  // If NODE_OPTIONS was not stripped, Node.js would attempt to --require the nonexistent file and fail to start
  const childScript = `
    const observed = {
      hasPath: Boolean(process.env.PATH || process.env.Path),
      geminiKey: process.env.GEMINI_API_KEY,
      awsKey: process.env.AWS_SECRET_ACCESS_KEY,
      nodeOptions: process.env.NODE_OPTIONS,
      optedIn: process.env.CUSTOM_OPTED_IN,
    };
    process.stdout.write(JSON.stringify(observed));
  `;

  const output = execFileSync(process.execPath, ['-e', childScript], {
    env: filtered,
    encoding: 'utf8',
    windowsHide: true,
  });

  const observed = JSON.parse(output) as {
    hasPath: boolean;
    geminiKey?: string;
    awsKey?: string;
    nodeOptions?: string;
    optedIn?: string;
  };

  assert.equal(observed.hasPath, true);
  assert.equal(observed.geminiKey, syntheticGeminiKey);
  assert.equal(observed.optedIn, syntheticOptInVar);
  assert.equal(observed.awsKey, undefined);
  assert.equal(observed.nodeOptions, undefined);
});

test('default parameters use process.env and process.platform while safely restoring environment', () => {
  const testKey = 'BRIDGE_TEST_SYNTHETIC_DEFAULT_ENV_CHECK';
  const original = process.env[testKey];
  try {
    process.env[testKey] = 'synthetic-default-param-test-val';
    const env = cliEnvironment([testKey]);
    assert.equal(env[testKey], 'synthetic-default-param-test-val');
    assert.equal(typeof env, 'object');
  } finally {
    if (original === undefined) {
      delete process.env[testKey];
    } else {
      process.env[testKey] = original;
    }
  }
});

test('strictly forbids runtime injection opt-ins in allowedEnvVars across all platforms and casing/whitespace aliases', () => {
  const forbiddenCandidates = [
    'NODE_OPTIONS',
    'node_options',
    '  Node_Options  ',
    'NODE_PATH',
    'node_path',
    '  Node_Path  ',
    'LD_PRELOAD',
    'ld_preload',
    '  Ld_Library_Path  ',
    'DYLD_INSERT_LIBRARIES',
    'dyld_library_path',
    '  Dyld_Insert_Libraries  ',
  ];

  for (const candidate of forbiddenCandidates) {
    // 1. Direct cliEnvironment call on Linux
    assert.throws(
      () => cliEnvironment([candidate], {}, 'linux'),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'FORBIDDEN_ENV_VAR');
        assert.match(err.message, /cannot include runtime injection variable/);
        return true;
      },
      `Expected ${candidate} to be forbidden on linux`
    );

    // 2. Direct cliEnvironment call on Windows
    assert.throws(
      () => cliEnvironment([candidate], {}, 'win32'),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'FORBIDDEN_ENV_VAR');
        assert.match(err.message, /cannot include runtime injection variable/);
        return true;
      },
      `Expected ${candidate} to be forbidden on win32`
    );

    // 3. Environment configuration via loadConfig
    assert.throws(
      () => loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_ALLOWED_ENV_VARS: JSON.stringify([candidate.trim()]) }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /cannot include runtime injection variable/);
        return true;
      },
      `Expected loadConfig to reject ${candidate}`
    );
  }
});

test('injection rejection error message names the variable but never exposes its value', () => {
  const dangerousSecretValue = '--import=data:text/javascript,console.log("synthetic-evil-token-998877")';
  const preloadSecretValue = '/opt/malicious/synthetic-secret-preload-library.so';

  const sourceEnv: NodeJS.ProcessEnv = {
    NODE_OPTIONS: dangerousSecretValue,
    LD_PRELOAD: preloadSecretValue,
  };

  // Rejection in direct cliEnvironment call
  assert.throws(
    () => cliEnvironment(['NODE_OPTIONS'], sourceEnv, 'linux'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('NODE_OPTIONS'), 'Error must name the forbidden variable');
      assert.ok(!err.message.includes(dangerousSecretValue), 'Error must never expose the variable value');
      assert.ok(!err.message.includes('synthetic-evil-token-998877'), 'Error must not leak sensitive tokens');
      return true;
    }
  );

  assert.throws(
    () => cliEnvironment(['  LD_PRELOAD  '], sourceEnv, 'win32'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('LD_PRELOAD'), 'Error must name the forbidden variable');
      assert.ok(!err.message.includes(preloadSecretValue), 'Error must never expose the variable value');
      return true;
    }
  );

  // Rejection in loadConfig
  assert.throws(
    () => loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', BRIDGE_ALLOWED_ENV_VARS: JSON.stringify(['NODE_OPTIONS']) }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('NODE_OPTIONS'), 'Error must name the forbidden variable');
      assert.ok(!err.message.includes(dangerousSecretValue), 'Error must never expose the variable value');
      return true;
    }
  );
});

test('preserves official authentication environment and certificate roots including NODE_EXTRA_CA_CERTS', () => {
  const source: NodeJS.ProcessEnv = {
    GEMINI_API_KEY: 'synthetic-gemini-key-preserve',
    GOOGLE_GEMINI_BASE_URL: 'https://custom.gemini.endpoint',
    GOOGLE_APPLICATION_CREDENTIALS: '/secrets/sa.json',
    GOOGLE_CLOUD_PROJECT: 'proj-123',
    GCLOUD_PROJECT: 'legacy-proj-123',
    GOOGLE_CLOUD_UNIVERSE_DOMAIN: 'googleapis.com',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/custom-ca.pem',
    CUSTOM_LEGIT_SETTING: 'legit-val',
  };

  const env = cliEnvironment(['CUSTOM_LEGIT_SETTING'], source, 'linux');

  assert.equal(env.GEMINI_API_KEY, 'synthetic-gemini-key-preserve');
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, 'https://custom.gemini.endpoint');
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, '/secrets/sa.json');
  assert.equal(env.GOOGLE_CLOUD_PROJECT, 'proj-123');
  assert.equal(env.GCLOUD_PROJECT, 'legacy-proj-123');
  assert.equal(env.GOOGLE_CLOUD_UNIVERSE_DOMAIN, 'googleapis.com');
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/etc/ssl/certs/custom-ca.pem');
  assert.equal(env.CUSTOM_LEGIT_SETTING, 'legit-val');
});

test('runtime injection opt-in is rejected before a real Node preload can execute', () => {
  const hook = 'process.stdout.write("BRIDGE_SYNTHETIC_PRELOAD_EXECUTED")';
  const source: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_OPTIONS: '--import=data:text/javascript,' + encodeURIComponent(hook),
  };
  assert.throws(() => execFileSync(process.execPath, ['-e', 'process.stdout.write("MAIN")'], {
    env: cliEnvironment(['NODE_OPTIONS'], source),
    encoding: 'utf8',
    windowsHide: true,
  }), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'FORBIDDEN_ENV_VAR');
    return true;
  });
});
