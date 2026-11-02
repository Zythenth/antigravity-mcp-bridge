export const WAIT_MODES = ['background', 'foreground'] as const;
export type WaitMode = (typeof WAIT_MODES)[number];

export const WAIT_MODE_REASONS = [
  'verified-profile',
  'unknown-client',
  'version-below-minimum',
  'invalid-client-version',
  'missing-client-info',
] as const;
export type WaitModeReason = (typeof WAIT_MODE_REASONS)[number];

export interface WaitModeProfile {
  client: string;
  minimumVersion: string;
  mode: WaitMode;
  evidence: string;
}

export const WAIT_MODE_PROFILES_VERSION = 1;

export const WAIT_MODE_PROFILES: readonly WaitModeProfile[] = [
  {
    client: 'claude-code',
    minimumVersion: '2.1.310',
    mode: 'background',
    evidence: 'Background wait command resumed by the host completion notice, verified with Claude Code 2.1.310.',
  },
];

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(value: string): [number, number, number] | undefined {
  const match = versionPattern.exec(value);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return undefined;
  }
  return [major, minor, patch];
}

function isVersionBelow(actual: [number, number, number], minimum: [number, number, number]): boolean {
  if (actual[0] !== minimum[0]) return actual[0] < minimum[0];
  if (actual[1] !== minimum[1]) return actual[1] < minimum[1];
  return actual[2] < minimum[2];
}

export function recommendWaitMode(
  client: { name?: unknown; version?: unknown } | undefined,
): { recommendedMode: WaitMode; reason: WaitModeReason } {
  if (!client || typeof client.name !== 'string' || client.name.length === 0) {
    return { recommendedMode: 'foreground', reason: 'missing-client-info' };
  }
  const profile = WAIT_MODE_PROFILES.find(entry => entry.client === client.name);
  if (!profile) {
    return { recommendedMode: 'foreground', reason: 'unknown-client' };
  }
  if (typeof client.version !== 'string' || client.version.length === 0) {
    return { recommendedMode: 'foreground', reason: 'missing-client-info' };
  }
  const actual = parseVersion(client.version);
  const minimum = parseVersion(profile.minimumVersion);
  if (!actual || !minimum) {
    return { recommendedMode: 'foreground', reason: 'invalid-client-version' };
  }
  if (isVersionBelow(actual, minimum)) {
    return { recommendedMode: 'foreground', reason: 'version-below-minimum' };
  }
  return { recommendedMode: profile.mode, reason: 'verified-profile' };
}
