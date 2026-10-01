import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { checkedPath, type ProjectCopy } from './isolation.js';
import { BridgeError } from './types.js';

export const criterionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  description: z.string().min(1).max(2000),
  check: z.object({
    kind: z.enum(['file-exists', 'file-absent', 'file-contains', 'file-not-contains']),
    path: z.string().min(1).max(1000),
    text: z.string().min(1).max(4000).optional(),
  }).strict().refine(check => !['file-contains', 'file-not-contains'].includes(check.kind) || Boolean(check.text), 'A text check requires text').optional(),
}).strict();
export const criteriaSchema = z.array(criterionSchema).min(1).max(100).refine(criteria => new Set(criteria.map(item => item.id)).size === criteria.length, 'Criterion IDs must be unique');
export const reviewEvidenceSchema = z.object({
  criterionId: z.string().min(1).max(64),
  verdict: z.enum(['passed', 'failed', 'unverified']),
  path: z.string().min(1).max(1000),
  line: z.number().int().min(1),
  quote: z.string().min(1).max(4000),
  explanation: z.string().min(1).max(2000),
}).strict();
export const reviewSchema = z.array(reviewEvidenceSchema).max(100).refine(reviews => new Set(reviews.map(item => item.criterionId)).size === reviews.length, 'One review per criterion');
export type AcceptanceCriterion = z.infer<typeof criterionSchema>;
export type ReviewEvidence = z.infer<typeof reviewEvidenceSchema>;
export interface VerificationRecord {
  sha256: string;
  checkedAt: string;
  status: 'passed' | 'failed' | 'unverified';
  checks: Array<{ criterionId: string; status: 'passed' | 'failed' | 'unverified'; observation: string }>;
  review: { source: 'client-reported'; evidence: ReviewEvidence[] };
  fileHashes: Record<string, string | null>;
}

export async function verifyCriteria(project: ProjectCopy, sha256: string, criteria: AcceptanceCriterion[] = [], reviews: ReviewEvidence[] = []): Promise<VerificationRecord> {
  if (criteria.length) criteria = criteriaSchema.parse(criteria);
  reviews = reviewSchema.parse(reviews);
  if (reviews.some(review => !criteria.some(criterion => criterion.id === review.criterionId))) {
    throw new BridgeError('INVALID_REVIEW', 'Review refers to an unknown acceptance criterion');
  }
  const fileHashes: Record<string, string | null> = Object.create(null);
  const contents = new Map<string, Buffer | undefined>();
  async function file(relative: string): Promise<Buffer | undefined> {
    if (contents.has(relative)) return contents.get(relative);
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of createReadStream(await checkedPath(project.copyDirectory, relative, true))) {
        length += chunk.length;
        if (length > 10_000_000) throw new BridgeError('VERIFICATION_TOO_LARGE', 'Verification file exceeds 10 MB');
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      fileHashes[relative] = createHash('sha256').update(buffer).digest('hex');
      contents.set(relative, buffer);
      return buffer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fileHashes[relative] = null;
      contents.set(relative, undefined);
      return undefined;
    }
  }
  const checks: VerificationRecord['checks'] = [];
  for (const criterion of criteria) {
    let checkPassed: boolean | undefined;
    if (criterion.check) {
      const { kind, path, text } = criterion.check;
      const content = await file(path);
      if (kind === 'file-exists') checkPassed = content !== undefined;
      if (kind === 'file-absent') checkPassed = content === undefined;
      if (kind === 'file-contains') checkPassed = content !== undefined && content.toString('utf8').includes(text!);
      if (kind === 'file-not-contains') checkPassed = content !== undefined && !content.toString('utf8').includes(text!);
    }
    const review = reviews.find(item => item.criterionId === criterion.id);
    let grounded = false;
    if (review) {
      const content = await file(review.path);
      const lines = content?.toString('utf8').split(/\r?\n/);
      const quoteLines = review.quote.split(/\r?\n/);
      grounded = Boolean(lines && lines.slice(review.line - 1, review.line - 1 + quoteLines.length).join('\n') === quoteLines.join('\n'));
    }
    const status = checkPassed === false || (review && (!grounded || review.verdict === 'failed')) ? 'failed'
      : !review || review.verdict === 'unverified' ? 'unverified' : 'passed';
    checks.push({ criterionId: criterion.id, status, observation: checkPassed === false ? 'Artifact check failed'
      : review && !grounded ? 'Review quote does not match the file and line'
      : !review ? 'Codex review evidence is missing'
      : 'Artifact check: ' + (checkPassed === undefined ? 'not specified' : 'passed') + '; client review: ' + review.verdict });
  }
  const status = checks.some(check => check.status === 'failed') ? 'failed'
    : !checks.length || checks.some(check => check.status === 'unverified') ? 'unverified' : 'passed';
  return { sha256, checkedAt: new Date().toISOString(), status, checks, review: { source: 'client-reported', evidence: reviews }, fileHashes };
}
