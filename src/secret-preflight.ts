import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './types.js';
import type { ProjectLimits } from './config.js';
import { checkedPath, validRelative } from './isolation.js';
import { normalizeSecretExceptionsPolicy, validateRelativeGlobPattern as validateGlobPattern, type SecretExceptionsPolicy } from './hardening-policy.js';

export { validRelative, validRelative as validateSafeRelativePath, validateGlobPattern };
export type { SecretExceptionsPolicy };

export interface BlockedPath {
  path: string;
  reason: 'SECRET_FILE' | 'SECRET_CONTENT' | 'SECRET_EXCLUSION' | 'UNSAFE_PATH';
}

export interface PreflightRecord {
  path: string;
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
  sha256: string;
}

export interface SecretPreflightResult {
  eligible: string[];
  blocked: BlockedPath[];
  records: Map<string, PreflightRecord>;
}

const CONFIG_EXTENSIONS = new Set([
  '.env', '.ini', '.conf', '.cfg', '.cnf', '.properties',
  '.toml', '.yaml', '.yml'
]);

/**
 * Translates a project-relative glob pattern into a regular expression.
 * Supports *, **, ? with project-relative semantics. Fails explicitly on invalid input.
 */
export function globToRegExp(pattern: string): RegExp {
  let p = validateGlobPattern(pattern);
  if (p === '**' || p === '*') {
    return /^.*$/i;
  }
  if (p.endsWith('/')) {
    p += '**';
  }

  // Handle leading **/ or single filename pattern
  let leadingRx = '';
  if (p.startsWith('**/')) {
    leadingRx = '(?:.*\\/)?';
    p = p.slice(3);
  } else if (!p.includes('/')) {
    leadingRx = '(?:.*\\/)?';
  }

  // Handle trailing /**
  let trailingRx = '';
  if (p.endsWith('/**')) {
    trailingRx = '\\/.*';
    p = p.slice(0, -3);
  }

  // Split remainder by /**/ to allow zero intermediate directories
  const segments = p.split('/**/');
  const segmentRegexes = segments.map(seg => {
    return seg
      .split('**')
      .map(part =>
        part
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]')
      )
      .join('.*');
  });

  const joined = segmentRegexes.join('/(?:.*/)?');
  return new RegExp(`^${leadingRx}${joined}${trailingRx}$`, 'i');
}

export function matchProjectRelativeGlob(pattern: string, relativePath: string): boolean {
  const rx = globToRegExp(pattern);
  return rx.test(relativePath);
}

/**
 * Identifies high-confidence credential files by name or path.
 * Retains legitimate templates/examples like .env.example, .env.sample, .env.template, .env.dist.
 * Allows ambiguous .key files (e.g. license.key) or public keys to be evaluated by content rather than name alone.
 */
export function isKnownCredentialFile(normalizedRelative: string): boolean {
  const norm = normalizedRelative.replaceAll('\\', '/').toLowerCase();
  const base = path.posix.basename(norm);

  // 1. .env files
  if (base === '.env' || base === '.envrc') return true;
  if (base.startsWith('.env.')) {
    if (base === '.env.example' || base === '.env.sample' || base === '.env.template' || base === '.env.dist') {
      return false;
    }
    return true;
  }

  // 2. Standalone private key files and keystores
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$/.test(base)) {
    if (base.endsWith('.pub')) return false;
    return true;
  }
  if (base.endsWith('.pub')) return false;
  if (base.endsWith('.key')) {
    if (base.includes('pub') || base.includes('cert')) return false;
    if (
      base.includes('priv') ||
      base.includes('secret') ||
      base === 'server.key' ||
      base === 'client.key' ||
      base === 'tls.key' ||
      base === 'ssl.key' ||
      base === 'host.key' ||
      base === 'jwt.key'
    ) {
      return true;
    }
    // Ambiguous .key files are not blocked by filename alone;
    // they fall through to detectSecretContent
    return false;
  }
  if (base.endsWith('.pem')) {
    if (base.includes('pub') || base.includes('cert')) return false;
    if (base.includes('priv') || base.includes('key')) return true;
    return false;
  }
  if (
    base.endsWith('.pfx') ||
    base.endsWith('.p12') ||
    base.endsWith('.pkcs12') ||
    base.endsWith('.keystore') ||
    base.endsWith('.jks')
  ) {
    return true;
  }

  // 3. Known credential / auth config paths
  if (base === '.git-credentials' || base === '.netrc' || base === '_netrc') return true;
  if (norm.endsWith('/.aws/credentials') || norm.endsWith('/.aws/config') || norm === '.aws/credentials' || norm === '.aws/config') return true;
  if (norm.endsWith('/.kube/config') || norm === '.kube/config' || base === 'kubeconfig') return true;
  if (norm.endsWith('/.docker/config.json') || norm === '.docker/config.json' || base === '.dockercfg') return true;
  if (/^(?:service[-_]account|serviceaccountkey)\.json$/.test(base)) return true;

  return false;
}

/**
 * Detects native bounded content signatures with high confidence.
 * Restricts config-only assignments/object parsing or literal key blocks to actual credential formats.
 * Preserves source files and tests containing synthetic string literals or test fixtures.
 */
export interface SecretScanState {
  jsonHasTypeServiceAccount?: boolean;
  jsonHasPrivateKeyField?: boolean;
}

const KNOWN_SOURCE_EXTENSIONS = new Set([
  '.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.cc',
  '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt'
]);

export function detectSecretContent(
  normalizedRelative: string,
  content: Buffer,
  scanState: SecretScanState = {}
): boolean {
  const norm = normalizedRelative.replaceAll('\\', '/').toLowerCase();
  const base = path.posix.basename(norm);
  const ext = path.posix.extname(norm);

  const text = content.toString('utf8');
  const trimmed = text.trimStart();

  // Format 1: Standalone PEM / OpenSSH / PGP / PuTTY private key file
  // Checks anchored unquoted private key headers across all allowed bytes in non-source files
  const isSource = KNOWN_SOURCE_EXTENSIONS.has(ext);
  if (!isSource) {
    if (/(?:^|[\r\n])\s*-----BEGIN[A-Z0-9 _-]*PRIVATE KEY-----/i.test(text)) {
      return true;
    }
    if (/(?:^|[\r\n])\s*-----BEGIN PGP PRIVATE KEY BLOCK-----/.test(text)) return true;
    if (/(?:^|[\r\n])\s*PuTTY-User-Key-File-/.test(text)) return true;
  }

  // Format 2: Standalone JSON credential document (e.g. Google Cloud service account)
  // Tracked across chunk boundaries using bounded field signals
  if (ext === '.json' || (!ext && trimmed.startsWith('{'))) {
    if (text.includes('"type"') && text.includes('"service_account"')) {
      scanState.jsonHasTypeServiceAccount = true;
    }
    if (text.includes('"private_key"') || text.includes('"private_key_id"')) {
      scanState.jsonHasPrivateKeyField = true;
    }
    if (scanState.jsonHasTypeServiceAccount && scanState.jsonHasPrivateKeyField) {
      return true;
    }
  }

  // Format 3: Configuration files with recognized credential assignments
  const isConfigFile =
    CONFIG_EXTENSIONS.has(ext) ||
    base.startsWith('.env') ||
    base === '.git-credentials' ||
    base === '.netrc' ||
    base === '_netrc' ||
    base === '.npmrc' ||
    norm.includes('/.aws/') ||
    norm.includes('/.kube/') ||
    norm.includes('/.docker/') ||
    (ext === '.txt' && (base.includes('config') || base.includes('cred') || base.includes('secret') || base.includes('token') || base.includes('aws') || base.includes('auth')));

  if (isConfigFile) {
    // AWS Secret Access Key in config (non-placeholder, at least 20 base64 chars)
    const awsMatch = text.match(
      /^\s*(?:aws_secret_access_key|aws_session_token|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\s*[:=]\s*([A-Za-z0-9/+=]{20,})/m
    );
    if (awsMatch) {
      const val = awsMatch[1]!.toLowerCase();
      if (
        !val.includes('your_') &&
        !val.includes('example') &&
        !val.includes('placeholder') &&
        !val.includes('changeme') &&
        !val.includes('xxxx') &&
        !val.includes('dummy')
      ) {
        return true;
      }
    }

    // NPM auth token in config
    const npmMatch = text.match(
      /(?:\/\/registry\.[^:]+:_authToken|_authToken)\s*[:=]\s*([A-Za-z0-9_-]{20,})/
    );
    if (npmMatch) {
      const val = npmMatch[1]!.toLowerCase();
      if (!val.includes('your_') && !val.includes('example') && !val.includes('placeholder') && !val.includes('dummy')) {
        return true;
      }
    }

    // GitHub PAT in config
    if (/^\s*(?:token|access_token|github_token|password)\s*[:=]\s*['"]?(?:ghp|gho|ghs)_[A-Za-z0-9]{36}/m.test(text)) {
      return true;
    }

    // Slack token in config
    if (/^\s*(?:bot_token|token|api_token)\s*[:=]\s*['"]?xox[baprs]-[0-9]{10,}-[A-Za-z0-9]{10,}/m.test(text)) {
      return true;
    }

    // Stripe secret key in config
    if (/^\s*(?:stripe_key|secret_key|api_key)\s*[:=]\s*['"]?sk_live_[0-9a-zA-Z]{24,}/m.test(text)) {
      return true;
    }

    // Embedded private key assigned in config
    if (/^\s*(?:private_key|ssl_key|tls_key|key)\s*[:=]\s*['"]?-----BEGIN/im.test(text)) {
      return true;
    }
  }

  // Also check if an ambiguous .key file contains actual private key block anywhere
  if (base.endsWith('.key') && !base.includes('pub') && !base.includes('cert')) {
    if (/(?:^|[\r\n])\s*-----BEGIN[A-Z0-9 _-]*PRIVATE KEY-----/i.test(text)) {
      return true;
    }
  }

  return false;
}

/**
 * Preflights candidate files before copying.
 * Reuses checkedPath's intermediate link validation BEFORE reading preflight file.
 * Streams bounded chunks and enforces aggregate copy byte limits before/during read with sliding overlap to cover allowed bytes without unbounded readFile.
 */
export async function preflightProjectFiles(
  directory: string,
  candidates: string[],
  limits: ProjectLimits,
  checkedPathFn: typeof checkedPath = checkedPath
): Promise<SecretPreflightResult> {
  if (candidates.length > limits.maxCopyFiles) {
    throw new BridgeError('COPY_LIMIT_EXCEEDED', `Copy has ${candidates.length} files; limit is ${limits.maxCopyFiles}. Narrow includePaths.`);
  }

  const eligible: string[] = [];
  const blocked: BlockedPath[] = [];
  const records = new Map<string, PreflightRecord>();

  const exclusions = (limits.secretExclusions ?? []).filter(Boolean);
  const exceptionsPolicy = normalizeSecretExceptionsPolicy(limits.secretExceptions, 'secretExceptions');
  const namePatterns = exceptionsPolicy.namePatterns;
  let aggregateBytesScanned = 0;

  for (const candidate of candidates) {
    // 1. Reuse checkedPath's intermediate link validation BEFORE reading preflight file
    let absolute: string;
    try {
      absolute = await checkedPathFn(directory, candidate, true);
    } catch (error) {
      if (
        error instanceof BridgeError &&
        (error.code === 'UNSAFE_PROJECT_PATH' || error.code === 'INVALID_INCLUDE_PATH')
      ) {
        blocked.push({ path: candidate, reason: 'UNSAFE_PATH' });
        continue;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    const relative = validRelative(candidate);

    // 2. Custom deny rules (secretExclusions) take absolute precedence over exceptions
    if (exclusions.some(pattern => matchProjectRelativeGlob(pattern, relative))) {
      blocked.push({ path: relative, reason: 'SECRET_EXCLUSION' });
      continue;
    }

    // 3. Check if an explicit name exception applies (skips known credential file name check ONLY)
    const isNameExcepted = namePatterns.some(pattern => matchProjectRelativeGlob(pattern, relative));

    // 4. Known credential file check
    if (!isNameExcepted && isKnownCredentialFile(relative)) {
      blocked.push({ path: relative, reason: 'SECRET_FILE' });
      continue;
    }

    // 5. Open descriptor and revalidate identity BEFORE reading
    const handle = await open(absolute, 'r');
    try {
      let revalidatedPath: string;
      try {
        revalidatedPath = await checkedPathFn(directory, candidate, true);
      } catch (error) {
        if (
          error instanceof BridgeError &&
          (error.code === 'UNSAFE_PROJECT_PATH' || error.code === 'INVALID_INCLUDE_PATH')
        ) {
          blocked.push({ path: relative, reason: 'UNSAFE_PATH' });
          continue;
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }

      const fstat = await handle.stat();
      const currentLstat = await lstat(revalidatedPath);
      if (!fstat.isFile() || currentLstat.isSymbolicLink() || !currentLstat.isFile()) {
        blocked.push({ path: relative, reason: 'UNSAFE_PATH' });
        continue;
      }
      if (currentLstat.ino !== fstat.ino || currentLstat.dev !== fstat.dev || currentLstat.size !== fstat.size) {
        blocked.push({ path: relative, reason: 'UNSAFE_PATH' });
        continue;
      }

      if (fstat.size > limits.maxCopyBytes || aggregateBytesScanned + fstat.size > limits.maxCopyBytes) {
        throw new BridgeError('COPY_LIMIT_EXCEEDED', `Candidate files exceed ${limits.maxCopyBytes} copy byte budget`);
      }

      // Stream bounded chunks to compute SHA-256 and inspect content with sliding chunk overlap
      const CHUNK_SIZE = 64 * 1024;
      const OVERLAP_SIZE = 4 * 1024;
      const buf = Buffer.allocUnsafe(CHUNK_SIZE);
      const hash = createHash('sha256');
      let totalRead = 0;
      let hasSecret = false;
      let prevOverlap = Buffer.alloc(0);
      const scanState: SecretScanState = {};

      for (;;) {
        const { bytesRead } = await handle.read(buf, 0, CHUNK_SIZE, null);
        if (bytesRead === 0) break;
        totalRead += bytesRead;
        aggregateBytesScanned += bytesRead;
        if (totalRead > limits.maxCopyBytes || aggregateBytesScanned > limits.maxCopyBytes) {
          throw new BridgeError('COPY_LIMIT_EXCEEDED', `Candidate files exceed ${limits.maxCopyBytes} copy byte budget`);
        }
        const slice = buf.subarray(0, bytesRead);
        hash.update(slice);

        if (!hasSecret) {
          const window = prevOverlap.length > 0 ? Buffer.concat([prevOverlap, slice]) : slice;
          if (detectSecretContent(relative, window, scanState)) {
            hasSecret = true;
          }
          const takeOverlap = Math.min(slice.length, OVERLAP_SIZE);
          prevOverlap = Buffer.from(slice.subarray(slice.length - takeOverlap));
        }
      }

      if (hasSecret) {
        blocked.push({ path: relative, reason: 'SECRET_CONTENT' });
        continue;
      }

      const sha256 = hash.digest('hex');

      eligible.push(relative);
      records.set(relative, {
        path: relative,
        size: fstat.size,
        mtimeMs: fstat.mtimeMs,
        ino: fstat.ino,
        dev: fstat.dev,
        sha256,
      });
    } finally {
      await handle.close();
    }
  }

  return { eligible, blocked, records };
}
