import { randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative as relativePath } from 'node:path';
import { checkedPath } from './isolation.js';
import { BridgeError } from './types.js';

const MAX_FILE_SIZE = 16 * 1024 * 1024;

function countLineEndings(text: string): { crlf: number; lf: number } {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      if (i > 0 && text[i - 1] === '\r') {
        crlf++;
      } else {
        lf++;
      }
    }
  }
  return { crlf, lf };
}

function convertLineEndings(text: string, toCrlf: boolean): string {
  // Preserve isolated CR: convert only isolated LF to CRLF, or CRLF to LF.
  return toCrlf ? text.replace(/(?<!\r)\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
}

function isAcceptedText(buffer: Buffer): boolean {
  if (buffer.length > MAX_FILE_SIZE || buffer.includes(0)) {
    return false;
  }
  const text = buffer.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buffer);
}

// The target directory must still be a real directory inside the copy when the file is replaced.
async function directoryInside(canonicalRoot: string, directory: string): Promise<boolean> {
  const stat = await lstat(directory).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  const inside = relativePath(canonicalRoot, await realpath(directory));
  return !inside.startsWith('..') && !isAbsolute(inside);
}

export async function normalizeEditedLineEndings(root: string, relativePaths: readonly string[], original?: (relative: string) => Promise<Buffer | undefined>): Promise<string[]> {
  const normalized: string[] = [];
  const canonicalRoot = await realpath(root);

  for (const relative of relativePaths) {
    const absolutePath = await checkedPath(root, relative, true);
    const stat = await lstat(absolutePath);

    if (stat.size > MAX_FILE_SIZE) {
      continue;
    }

    const buffer = await readFile(absolutePath);
    if (!isAcceptedText(buffer)) {
      continue;
    }

    const text = buffer.toString('utf8');
    // An isolated CR makes the line structure ambiguous; such files are left exactly as they are.
    if (/\r(?!\n)/.test(text)) {
      continue;
    }
    const { crlf, lf } = countLineEndings(text);

    let targetCrlf: boolean | undefined;

    if (original) {
      const originalBuffer = await original(relative);
      if (originalBuffer && isAcceptedText(originalBuffer)) {
        const { crlf: origCrlf, lf: origLf } = countLineEndings(originalBuffer.toString('utf8'));
        if (origCrlf > 0 && origLf === 0) {
          targetCrlf = true;
        } else if (origLf > 0 && origCrlf === 0) {
          targetCrlf = false;
        }
      }
    }

    if (targetCrlf === undefined) {
      if (crlf === 0 || lf === 0) {
        continue;
      }
      targetCrlf = crlf >= lf;
    } else if (targetCrlf ? lf === 0 : crlf === 0) {
      continue;
    }

    const converted = convertLineEndings(text, targetCrlf);
    const tempPath = join(dirname(absolutePath), randomUUID());

    const directory = dirname(absolutePath);
    if (!await directoryInside(canonicalRoot, directory)) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'An edited file moved outside the isolated copy before its line endings were restored');
    }
    try {
      await writeFile(tempPath, converted, { encoding: 'utf8', flag: 'wx' });
      await chmod(tempPath, stat.mode);
      if (!await directoryInside(canonicalRoot, directory)) {
        throw new BridgeError('UNSAFE_PROJECT_PATH', 'An edited file moved outside the isolated copy before its line endings were restored');
      }
      await rename(tempPath, absolutePath);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }

    normalized.push(relative);
  }

  return normalized;
}
