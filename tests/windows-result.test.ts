import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BridgeError } from '../src/types.js';
import {
  parseWindowsExecutionResult,
  redactExecutionDiagnostic,
} from '../src/windows-executor.js';

const dummyRoots = {
  copy: 'C:\\test\\copy',
  runtime: 'C:\\test\\runtime',
  scratch: 'C:\\test\\scratch',
};

function successPayload(nonce: string, overrides: Record<string, unknown> = {}) {
  return {
    nonce,
    pid: 1234,
    sandbox: 'windows-lpac',
    exitCode: 0,
    output: 'hello from lpac',
    truncated: false,
    profileDeleted: true,
    aliasesDeleted: true,
    pathMappings: [
      { kind: 'copy', aliasRoot: 'Z:\\', physicalRoot: dummyRoots.copy },
      { kind: 'runtime', aliasRoot: 'Y:\\', physicalRoot: dummyRoots.runtime },
      { kind: 'scratch', aliasRoot: 'X:\\', physicalRoot: dummyRoots.scratch },
    ],
    ...overrides,
  };
}

test('Windows result parser accepts complete verified success strictly', () => {
  const nonce = randomUUID();
  const payload = successPayload(nonce);
  const result = parseWindowsExecutionResult(
    { stdout: JSON.stringify(payload), code: 0 },
    { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
  );
  assert.equal(result.nonce, nonce);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'hello from lpac');
  assert.equal(result.sandbox, 'windows-lpac');
  assert.equal(result.profileDeleted, true);
  assert.equal(result.aliasesDeleted, true);
  assert.equal(result.pathMappings.length, 3);
});

test('Windows result parser rejects null or invalid controller exit code as UNVERIFIED', () => {
  const nonce = randomUUID();
  const payload = successPayload(nonce);

  for (const code of [null, -1, 1.5, NaN, 0x100000000]) {
    assert.throws(
      () =>
        parseWindowsExecutionResult(
          { stdout: JSON.stringify(payload), code },
          { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
        ),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'WINDOWS_EXECUTION_UNVERIFIED');
        assert.match(err.message, /exit code was not verified/i);
        return true;
      }
    );
  }
});

test('Windows result parser yields bounded redacted BridgeError on early native failure instead of raw ZodError', () => {
  const nonce = randomUUID();
  const earlyFailurePayload = {
    nonce,
    error: 'Invalid request: maxFiles=0 exceeds minimum bounds',
    aliasesDeleted: false,
    exitCode: null,
    output: '',
    truncated: false,
  };

  assert.throws(
    () =>
      parseWindowsExecutionResult(
        { stdout: JSON.stringify(earlyFailurePayload), code: 1 },
        { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError, 'must throw BridgeError');
      assert.equal(err.code, 'WINDOWS_EXECUTOR_FAILED');
      assert.ok(!err.message.includes('ZodError'), 'must not leak raw ZodError');
      assert.ok(!err.message.includes('aliasesDeleted'), 'must not fail on aliasesDeleted requirement');
      assert.match(err.message, /Invalid request/);
      return true;
    }
  );
});

test('Windows result parser redacts Bearer tokens before truncation in early error longer than 4000 characters', () => {
  const nonce = randomUUID();
  const rawSecret = 'secret-bearer-token-should-be-redacted-999';
  const longTail = 'X'.repeat(5000);
  const earlyFailurePayload = {
    nonce,
    error: `Failure: Bearer ${rawSecret} details: ${longTail}`,
    aliasesDeleted: false,
    exitCode: null,
    output: '',
    truncated: false,
  };

  assert.throws(
    () =>
      parseWindowsExecutionResult(
        { stdout: JSON.stringify(earlyFailurePayload), code: 1 },
        { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError, 'must throw BridgeError');
      assert.equal(err.code, 'WINDOWS_EXECUTOR_FAILED');
      assert.ok(!err.message.includes(rawSecret), 'secret Bearer token must be redacted before cut');
      assert.match(err.message, /Bearer\s+\[redacted\]/i);
      assert.ok(err.message.length <= 4000, 'message must be bounded to 4000 characters');
      assert.ok(err.message.endsWith('... [truncated]'), 'must end with explicit truncation marker');
      return true;
    }
  );
});

test('Windows result parser rejects mismatched nonce in early failure envelope', () => {
  const nonce = randomUUID();
  const otherNonce = randomUUID();
  const earlyFailurePayload = {
    nonce: otherNonce,
    error: 'Invalid request',
    exitCode: null,
    output: '',
    truncated: false,
  };

  assert.throws(
    () =>
      parseWindowsExecutionResult(
        { stdout: JSON.stringify(earlyFailurePayload), code: 1 },
        { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'WINDOWS_EXECUTION_UNVERIFIED');
      assert.match(err.message, /nonce was not verified/i);
      return true;
    }
  );
});

test('Windows result parser rejects early error with exit code zero (early error never becomes success)', () => {
  const nonce = randomUUID();
  const earlyFailurePayload = {
    nonce,
    error: 'Early native failure',
    exitCode: null,
    output: '',
    truncated: false,
  };

  assert.throws(
    () =>
      parseWindowsExecutionResult(
        { stdout: JSON.stringify(earlyFailurePayload), code: 0 },
        { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'WINDOWS_EXECUTION_UNVERIFIED');
      assert.match(err.message, /zero exit code/i);
      return true;
    }
  );
});

test('Windows result parser rejects invalid failure envelope shape', () => {
  const nonce = randomUUID();
  const badEnvelope = {
    nonce,
    error: '', // empty error violates min(1)
  };

  assert.throws(
    () =>
      parseWindowsExecutionResult(
        { stdout: JSON.stringify(badEnvelope), code: 1 },
        { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'WINDOWS_EXECUTOR_FAILED');
      assert.match(err.message, /invalid failure envelope/i);
      return true;
    }
  );
});

test('Windows result parser rejects unparseable stdout without echoing raw input', () => {
  const nonce = randomUUID();
  const secretMalformedInput = '<<< MALFORMED_SECRET_JSON_STDOUT >>>';

  assert.throws(
    () =>
      parseWindowsExecutionResult(
        { stdout: secretMalformedInput, code: 1 },
        { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'WINDOWS_EXECUTOR_FAILED');
      assert.match(err.message, /unparseable output/i);
      assert.ok(!err.message.includes('MALFORMED_SECRET_JSON_STDOUT'), 'must not echo raw stdout');
      return true;
    }
  );
});

test('Windows result parser rejects setup error with complete cleanup and throws WINDOWS_EXECUTOR_FAILED', () => {
  const nonce = randomUUID();
  const setupErrorWithCleanup = successPayload(nonce, {
    error: 'Setup failed: unable to grant permission',
    exitCode: null,
  });

  assert.throws(
    () =>
      parseWindowsExecutionResult(
        { stdout: JSON.stringify(setupErrorWithCleanup), code: 1 },
        { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'WINDOWS_EXECUTOR_FAILED');
      assert.match(err.message, /Setup failed/);
      return true;
    }
  );
});

test('Windows result parser returns WindowsExecution for a Command timed out envelope with non-null exitCode', () => {
  const nonce = randomUUID();
  const timeoutPayload = successPayload(nonce, {
    error: 'Command timed out',
    exitCode: 124,
    output: 'process was terminated on timeout',
  });

  const result = parseWindowsExecutionResult(
    { stdout: JSON.stringify(timeoutPayload), code: 1 },
    { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
  );

  assert.equal(result.nonce, nonce);
  assert.equal(result.error, 'Command timed out');
  assert.equal(result.exitCode, 124);
  assert.equal(result.sandbox, 'windows-lpac');
  assert.equal(result.profileDeleted, true);
  assert.equal(result.aliasesDeleted, true);
});

test('Windows result parser returns WindowsExecution for a Command cancelled envelope with non-null exitCode', () => {
  const nonce = randomUUID();
  const cancelPayload = successPayload(nonce, {
    error: 'Command cancelled',
    exitCode: 125,
    output: 'process was terminated on cancel',
  });

  const result = parseWindowsExecutionResult(
    { stdout: JSON.stringify(cancelPayload), code: 1 },
    { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
  );

  assert.equal(result.nonce, nonce);
  assert.equal(result.error, 'Command cancelled');
  assert.equal(result.exitCode, 125);
  assert.equal(result.sandbox, 'windows-lpac');
  assert.equal(result.profileDeleted, true);
  assert.equal(result.aliasesDeleted, true);
});

test('Windows result parser rejects timeout or cancel if exitCode is null', () => {
  const nonce = randomUUID();
  const timeoutNullExit = successPayload(nonce, {
    error: 'Command timed out',
    exitCode: null,
  });

  assert.throws(
    () =>
      parseWindowsExecutionResult(
        { stdout: JSON.stringify(timeoutNullExit), code: 1 },
        { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'WINDOWS_EXECUTOR_FAILED');
      assert.match(err.message, /Command timed out/);
      return true;
    }
  );
});

test('Windows result parser enforces strict success shape and rejects missing required fields', () => {
  const nonce = randomUUID();
  const missingAliases = successPayload(nonce, { aliasesDeleted: false });

  assert.throws(
    () =>
      parseWindowsExecutionResult(
        { stdout: JSON.stringify(missingAliases), code: 0 },
        { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'WINDOWS_EXECUTION_UNVERIFIED');
      return true;
    }
  );

  const missingProfile = successPayload(nonce, { profileDeleted: false });
  assert.throws(
    () =>
      parseWindowsExecutionResult(
        { stdout: JSON.stringify(missingProfile), code: 0 },
        { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'WINDOWS_EXECUTION_UNVERIFIED');
      return true;
    }
  );
});

test('Windows result parser rejects incorrect path mappings in success payload', () => {
  const nonce = randomUUID();
  const wrongMappings = successPayload(nonce, {
    pathMappings: [
      { kind: 'copy', aliasRoot: 'Z:\\', physicalRoot: dummyRoots.copy },
    ],
  });
  assert.throws(
    () =>
      parseWindowsExecutionResult(
        { stdout: JSON.stringify(wrongMappings), code: 0 },
        { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'WINDOWS_EXECUTION_UNVERIFIED');
      return true;
    }
  );

  const wrongRoot = successPayload(nonce, {
    pathMappings: [
      { kind: 'copy', aliasRoot: 'Z:\\', physicalRoot: 'C:\\other\\copy' },
      { kind: 'runtime', aliasRoot: 'Y:\\', physicalRoot: dummyRoots.runtime },
      { kind: 'scratch', aliasRoot: 'X:\\', physicalRoot: dummyRoots.scratch },
    ],
  });
  assert.throws(
    () =>
      parseWindowsExecutionResult(
        { stdout: JSON.stringify(wrongRoot), code: 0 },
        { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'WINDOWS_EXECUTION_UNVERIFIED');
      assert.match(err.message, /did not match an owned execution root/i);
      return true;
    }
  );
});

test('Windows result parser rejects duplicate aliases in success payload', () => {
  const nonce = randomUUID();
  const duplicateAliases = successPayload(nonce, {
    pathMappings: [
      { kind: 'copy', aliasRoot: 'Z:\\', physicalRoot: dummyRoots.copy },
      { kind: 'runtime', aliasRoot: 'Z:\\', physicalRoot: dummyRoots.runtime },
      { kind: 'scratch', aliasRoot: 'X:\\', physicalRoot: dummyRoots.scratch },
    ],
  });

  assert.throws(
    () =>
      parseWindowsExecutionResult(
        { stdout: JSON.stringify(duplicateAliases), code: 0 },
        { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'WINDOWS_EXECUTION_UNVERIFIED');
      assert.match(err.message, /reused a drive letter/i);
      return true;
    }
  );
});

test('Windows result parser rejects nonce mismatch in success payload', () => {
  const nonce = randomUUID();
  const otherNonce = randomUUID();
  const payload = successPayload(nonce);

  assert.throws(
    () =>
      parseWindowsExecutionResult(
        { stdout: JSON.stringify(payload), code: 0 },
        { expectedNonce: otherNonce, roots: dummyRoots, maxOutputChars: 4000 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'WINDOWS_EXECUTION_UNVERIFIED');
      assert.match(err.message, /nonce was not verified/i);
      return true;
    }
  );
});

test('Windows result parser enforces output length limits', () => {
  const nonce = randomUUID();
  const oversized = successPayload(nonce, { output: 'a'.repeat(5000) });

  assert.throws(
    () =>
      parseWindowsExecutionResult(
        { stdout: JSON.stringify(oversized), code: 0 },
        { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'WINDOWS_EXECUTION_UNVERIFIED');
      assert.match(err.message, /output limit/i);
      return true;
    }
  );
});

test('redactExecutionDiagnostic redacts process.env secrets matching sensitive patterns', () => {
  const prevSecret = process.env.TEST_BRIDGE_API_KEY;
  process.env.TEST_BRIDGE_API_KEY = 'super-secret-api-token-998877';
  try {
    const raw = 'Failure calling service with super-secret-api-token-998877 in request';
    const redacted = redactExecutionDiagnostic(raw);
    assert.ok(!redacted.includes('super-secret-api-token-998877'));
    assert.match(redacted, /\[redacted\]/);
  } finally {
    if (prevSecret === undefined) delete process.env.TEST_BRIDGE_API_KEY;
    else process.env.TEST_BRIDGE_API_KEY = prevSecret;
  }
});

test('redactExecutionDiagnostic redacts Bearer tokens', () => {
  const raw = 'Authorization failed: Bearer secret-bearer-token-123456789 expired';
  const redacted = redactExecutionDiagnostic(raw);
  assert.ok(!redacted.includes('secret-bearer-token-123456789'));
  assert.match(redacted, /Bearer\s+\[redacted\]/i);
});

test('redactExecutionDiagnostic redacts multi-line private keys', () => {
  const raw = [
    'Error details:',
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAz8j...key-material...',
    '-----END RSA PRIVATE KEY-----',
    'Operation failed',
  ].join('\n');
  const redacted = redactExecutionDiagnostic(raw);
  assert.ok(!redacted.includes('MIIEowIBAAKCAQEAz8j'));
  assert.ok(!redacted.includes('key-material'));
  assert.match(redacted, /\[private key redacted\]/);
});

test('redactExecutionDiagnostic redacts unclosed private keys', () => {
  const raw = [
    'Header info',
    '-----BEGIN PRIVATE KEY-----',
    'unclosed-secret-key-material-line-1',
    'unclosed-secret-key-material-line-2',
  ].join('\n');
  const redacted = redactExecutionDiagnostic(raw);
  assert.ok(!redacted.includes('unclosed-secret-key-material-line-1'));
  assert.ok(!redacted.includes('unclosed-secret-key-material-line-2'));
  assert.match(redacted, /\[private key redacted\]/);
});

test('redactExecutionDiagnostic bounds length to 4000 and appends explicit truncation marker', () => {
  const giant = 'Error diagnostic: ' + 'X'.repeat(6000);
  const result = redactExecutionDiagnostic(giant);
  assert.ok(result.length <= 4000, 'must not exceed 4000 characters');
  assert.ok(result.endsWith('... [truncated]'), 'must end with explicit truncation marker');
});

test('Windows result parser redacts sensitive secrets in execution error', () => {
  const nonce = randomUUID();
  const payloadWithError = successPayload(nonce, {
    error: 'Command timed out with Bearer secret-auth-token-in-error',
    exitCode: 124,
  });

  // Since error is not exact "Command timed out", parser throws WINDOWS_EXECUTOR_FAILED with redacted error
  assert.throws(
    () =>
      parseWindowsExecutionResult(
        { stdout: JSON.stringify(payloadWithError), code: 1 },
        { expectedNonce: nonce, roots: dummyRoots, maxOutputChars: 4000 }
      ),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'WINDOWS_EXECUTOR_FAILED');
      assert.ok(!err.message.includes('secret-auth-token-in-error'));
      assert.match(err.message, /Bearer\s+\[redacted\]/i);
      return true;
    }
  );
});

test('redactExecutionDiagnostic protects a sensitive environment value containing a newline', () => {
  const previous = process.env.TEST_BRIDGE_MULTILINE_SECRET;
  const synthetic = 'BRIDGE_SYNTHETIC_first\nBRIDGE_SYNTHETIC_second';
  process.env.TEST_BRIDGE_MULTILINE_SECRET = synthetic;
  try {
    const result = redactExecutionDiagnostic('Failure: ' + synthetic);
    assert.equal(result.includes('BRIDGE_SYNTHETIC_first'), false);
    assert.equal(result.includes('BRIDGE_SYNTHETIC_second'), false);
  } finally {
    if (previous === undefined) delete process.env.TEST_BRIDGE_MULTILINE_SECRET;
    else process.env.TEST_BRIDGE_MULTILINE_SECRET = previous;
  }
});
