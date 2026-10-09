import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export function preauthorizedIntegrationRoots(value?: string): string[] {
  const roots: unknown = JSON.parse(value ?? '[]');
  if (!Array.isArray(roots) || roots.length > 20 || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) {
    throw new Error('BRIDGE_PREAUTHORIZED_INTEGRATION_ROOTS must be a JSON array of up to 20 absolute project directories');
  }
  return [...new Set((roots as string[]).map(root => {
    const canonical = realpathSync.native(root);
    if (!statSync(canonical).isDirectory() || canonical === path.parse(canonical).root) throw new Error('Preauthorization requires a project directory, not a volume root');
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  }))];
}

export function integrationPreauthorized(workingDirectory: string, roots: readonly string[]): boolean {
  const canonical = process.platform === 'win32' ? workingDirectory.toLowerCase() : workingDirectory;
  return roots.includes(canonical);
}
