import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './types.js';

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function validateWorkingDirectory(input: string, forbidden: string[]): Promise<string> {
  if (!path.isAbsolute(input)) throw new BridgeError('INVALID_WORKING_DIRECTORY', 'workingDirectory must be absolute');
  try {
    const directory = await realpath(input);
    if (!(await stat(directory)).isDirectory()) throw new Error('not a directory');
    await access(directory, constants.R_OK | constants.W_OK);
    for (const excluded of forbidden) {
      const resolved = await realpath(excluded).catch(() => path.resolve(excluded));
      if (within(resolved, directory)) throw new BridgeError('INVALID_WORKING_DIRECTORY', 'workingDirectory is forbidden');
    }
    return directory;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('INVALID_WORKING_DIRECTORY', `workingDirectory is unavailable: ${input}`);
  }
}

export function validatePrompt(prompt: string, maxChars: number): void {
  if (!prompt.trim() || prompt.length > maxChars || prompt.includes('\0')) {
    throw new BridgeError('INVALID_PROMPT', `prompt must contain 1 to ${maxChars} characters and no NUL`);
  }
}
