import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative as relativePath, sep } from 'node:path';
import { checkedPath, validRelative } from './isolation.js';
import { BridgeError } from './types.js';

const MAX_FILE_SIZE = 16 * 1024 * 1024;

export type LineEndingStyle = 'crlf' | 'lf';

// A file handed to the CLI as LF, with the SHA-256 of the LF bytes it received.
export interface LfConversion { path: string; sha256: string }

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

// Only text with one kind of line ending and no isolated CR converts to the other kind and back to the same bytes.
function pureStyle(buffer: Buffer): LineEndingStyle | undefined {
  if (!isAcceptedText(buffer)) return undefined;
  const text = buffer.toString('utf8');
  if (/\r(?!\n)/.test(text)) return undefined;
  const { crlf, lf } = countLineEndings(text);
  if (crlf > 0 && lf === 0) return 'crlf';
  if (lf > 0 && crlf === 0) return 'lf';
  return undefined;
}

// The target directory must still be a real directory inside the copy when the file is replaced.
async function directoryInside(canonicalRoot: string, directory: string): Promise<boolean> {
  const stat = await lstat(directory).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  const inside = relativePath(canonicalRoot, await realpath(directory));
  return inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside);
}

async function replaceInsideCopy(canonicalRoot: string, absolutePath: string, content: string, mode: number): Promise<void> {
  const directory = dirname(absolutePath);
  if (!await directoryInside(canonicalRoot, directory)) {
    throw new BridgeError('UNSAFE_PROJECT_PATH', 'A copy file moved outside the isolated copy before its line endings were rewritten');
  }
  const tempPath = join(directory, randomUUID());
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx' });
    await chmod(tempPath, mode);
    if (!await directoryInside(canonicalRoot, directory)) {
      throw new BridgeError('UNSAFE_PROJECT_PATH', 'A copy file moved outside the isolated copy before its line endings were rewritten');
    }
    await rename(tempPath, absolutePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

// A missing file reads as undefined; a file above the size limit comes back without its content.
async function readCopyFile(root: string, relative: string): Promise<{ path: string; buffer?: Buffer; mode: number } | undefined> {
  let absolutePath: string;
  try { absolutePath = await checkedPath(root, relative, true); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const stat = await lstat(absolutePath);
  return { path: absolutePath, buffer: stat.size > MAX_FILE_SIZE ? undefined : await readFile(absolutePath), mode: stat.mode };
}

function contentSha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

// Reads the copy as it is before a run: the styles of its pure text files are the reference for every later line ending
// decision, and its pure CRLF files are the ones to hand to the CLI as LF.
export async function planLineEndings(root: string, relativePaths: readonly string[]): Promise<{ styles: Map<string, LineEndingStyle>; conversions: LfConversion[] }> {
  const styles = new Map<string, LineEndingStyle>();
  const conversions: LfConversion[] = [];
  for (const relative of relativePaths) {
    const file = await readCopyFile(root, relative);
    const style = file?.buffer && pureStyle(file.buffer);
    if (!style) continue;
    styles.set(relative, style);
    if (style === 'crlf') conversions.push({ path: relative, sha256: contentSha256(convertLineEndings(file.buffer!.toString('utf8'), false)) });
  }
  return { styles, conversions };
}

// The CLI's edit tool matches text exactly, so pure CRLF files are handed to it as LF.
export async function convertCrlfToLf(root: string, conversions: readonly LfConversion[]): Promise<string[]> {
  const converted: string[] = [];
  const canonicalRoot = await realpath(root);
  for (const { path: relative } of conversions) {
    const file = await readCopyFile(root, relative);
    if (!file?.buffer || pureStyle(file.buffer) !== 'crlf') continue;
    await replaceInsideCopy(canonicalRoot, file.path, convertLineEndings(file.buffer.toString('utf8'), false), file.mode);
    converted.push(relative);
  }
  return converted;
}

// A converted file held only CRLF before the run, so every isolated LF in it, original or added, becomes CRLF again.
async function restoreFile(canonicalRoot: string, relative: string, file: { path: string; buffer?: Buffer; mode: number }): Promise<boolean> {
  if (!file.buffer) {
    throw new BridgeError('LINE_ENDINGS_UNRESTORED', 'A file converted to LF grew beyond 16 MiB and cannot regain its line endings: ' + relative);
  }
  if (!isAcceptedText(file.buffer)) return false;
  const text = file.buffer.toString('utf8');
  const crlf = convertLineEndings(text, true);
  if (crlf === text) return false;
  await replaceInsideCopy(canonicalRoot, file.path, crlf, file.mode);
  return true;
}

// Every regular file in the copy, ignored or not, so that files existing before a run can be told apart from new ones.
export async function listCopyFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [''];
  for (let prefix = pending.pop(); prefix !== undefined; prefix = pending.pop()) {
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  return files;
}

// Paths the bridge never copies or exports, such as .git, cannot be part of a candidate.
function exportablePath(relative: string): boolean {
  try { validRelative(relative); return true; } catch { return false; }
}

// Untouched converted files get back their exact bytes, and restoring a file that is already CRLF changes nothing. A new
// path, ignored or not, holding exactly the LF bytes a converted file received is that content renamed or copied by the CLI,
// and is restored too; a path that existed before the run is never rewritten unless it was converted.
export async function restoreCrlfLineEndings(root: string, conversions: readonly LfConversion[], existingBefore: readonly string[]): Promise<string[]> {
  const restored: string[] = [];
  const canonicalRoot = await realpath(root);
  for (const conversion of conversions) {
    const file = await readCopyFile(root, conversion.path);
    if (file && await restoreFile(canonicalRoot, conversion.path, file)) restored.push(conversion.path);
  }
  const listed = new Set([...conversions.map(conversion => conversion.path), ...existingBefore]);
  const handedOut = new Set(conversions.map(conversion => conversion.sha256));
  for (const relative of await listCopyFiles(root)) {
    if (listed.has(relative) || !exportablePath(relative)) continue;
    const file = await readCopyFile(root, relative);
    if (file?.buffer && handedOut.has(contentSha256(file.buffer)) && await restoreFile(canonicalRoot, relative, file)) restored.push(relative);
  }
  return restored;
}

export async function normalizeEditedLineEndings(root: string, relativePaths: readonly string[], original?: (relative: string) => Promise<LineEndingStyle | undefined>): Promise<string[]> {
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

    const style = await original?.(relative);
    let targetCrlf = style === undefined ? undefined : style === 'crlf';

    if (targetCrlf === undefined) {
      if (crlf === 0 || lf === 0) {
        continue;
      }
      targetCrlf = crlf >= lf;
    } else if (targetCrlf ? lf === 0 : crlf === 0) {
      continue;
    }

    await replaceInsideCopy(canonicalRoot, absolutePath, convertLineEndings(text, targetCrlf), stat.mode);
    normalized.push(relative);
  }

  return normalized;
}
