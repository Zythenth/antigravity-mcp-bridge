import { createHash } from 'node:crypto';
import { BridgeError } from './types.js';

export function textChunk(text: string, offset = 0, limit = 10000, expectedSha256?: string) {
  const sha256 = createHash('sha256').update(text).digest('hex');
  if (expectedSha256 !== undefined && expectedSha256 !== sha256) throw new BridgeError('CONTENT_CHANGED', 'The result changed; restart reading from offset zero');
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length || !Number.isInteger(limit) || limit < 2 || limit > 50000) {
    throw new BridgeError('INVALID_CURSOR', 'offset must be within the content and limit between 2 and 50000');
  }
  const low = (value: number) => value >= 0xdc00 && value <= 0xdfff;
  const high = (value: number) => value >= 0xd800 && value <= 0xdbff;
  if (offset > 0 && low(text.charCodeAt(offset)) && high(text.charCodeAt(offset - 1))) throw new BridgeError('INVALID_CURSOR', 'Offset splits a Unicode character; use nextOffset');
  let end = Math.min(text.length, offset + limit);
  if (end < text.length && high(text.charCodeAt(end - 1)) && low(text.charCodeAt(end))) end--;
  return { text: text.slice(offset, end), offset, length: end - offset, totalLength: text.length,
    nextOffset: end, hasMore: end < text.length, contentSha256: sha256, offsetUnit: 'utf16-code-units' as const };
}
