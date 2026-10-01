import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { checkedPath } from './isolation.js';
import { BridgeError } from './types.js';

export const roleSchema = z.enum(['implementer', 'planner', 'reviewer']);
export type TaskRole = z.infer<typeof roleSchema>;
export const plannerReportSchema = z.object({
  summary: z.string().min(1).max(4000),
  steps: z.array(z.object({ description: z.string().min(1).max(2000), files: z.array(z.string().min(1)).max(100),
    verification: z.string().min(1).max(2000) }).strict()).min(1).max(100),
  unverified: z.array(z.string().min(1).max(2000)).max(100),
}).strict();
export const reviewerReportSchema = z.object({
  summary: z.string().min(1).max(4000),
  reviewedFiles: z.array(z.string().min(1).max(1000)).min(1).max(100),
  findings: z.array(z.object({
    severity: z.enum(['P0', 'P1', 'P2', 'P3']), path: z.string().min(1).max(1000), line: z.number().int().positive(),
    quote: z.string().min(1).max(4000), message: z.string().min(1).max(2000), impact: z.string().min(1).max(2000), suggestion: z.string().min(1).max(2000),
  }).strict()).max(100),
  unverified: z.array(z.string().min(1).max(2000)).max(100),
}).strict();
export type RoleReport =
  | { role: 'planner'; source: 'agy-reported'; data: z.infer<typeof plannerReportSchema> }
  | { role: 'reviewer'; source: 'agy-reported'; data: z.infer<typeof reviewerReportSchema>; citationsChecked: true };

export function roleContract(role: TaskRole) {
  if (role === 'implementer') return;
  const schema = role === 'planner' ? plannerReportSchema : reviewerReportSchema;
  return { schema: z.toJSONSchema(schema), instruction: role === 'planner'
    ? 'Plan the requested work without editing files. Inspect existing sources. Return a concise structured plan with files, observable verification for each step and unverified assumptions. Distinguish proposed changes from existing behavior.'
    : 'Review the requested scope without editing files. Report actionable findings with severity P0-P3, project-relative file, one-based line, exact whole-line quote, impact and suggestion. List actually reviewed files and limitations in unverified. Do not invent findings or claim tests ran without evidence. A report with no findings is not proof of correctness.' };
}

export async function validateRoleReport(role: TaskRole, raw: unknown, copyDirectory: string): Promise<RoleReport | undefined> {
  if (role === 'implementer') return;
  if (role === 'planner') {
    const parsed = plannerReportSchema.safeParse(raw);
    if (!parsed.success) throw new BridgeError('ROLE_OUTPUT_INVALID', 'Planner response does not match its structured contract');
    for (const step of parsed.data.steps) for (const file of step.files) await checkedPath(copyDirectory, file, false);
    return { role, source: 'agy-reported', data: parsed.data };
  }
  const parsed = reviewerReportSchema.safeParse(raw);
  if (!parsed.success) throw new BridgeError('ROLE_OUTPUT_INVALID', 'Reviewer response does not match its structured contract');
  for (const file of parsed.data.reviewedFiles) await checkedPath(copyDirectory, file, true);
  for (const finding of parsed.data.findings) {
    if (!parsed.data.reviewedFiles.includes(finding.path)) throw new BridgeError('ROLE_OUTPUT_INVALID', 'Finding refers to a file outside reviewedFiles');
    const file = await checkedPath(copyDirectory, finding.path, true);
    if ((await stat(file)).size > 10_000_000) throw new BridgeError('VERIFICATION_TOO_LARGE', 'Review citation exceeds the text file limit');
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    const quote = finding.quote.split(/\r?\n/);
    if (lines.slice(finding.line - 1, finding.line - 1 + quote.length).join('\n') !== quote.join('\n')) {
      throw new BridgeError('ROLE_OUTPUT_INVALID', 'Review citation does not match its file and line');
    }
  }
  return { role, source: 'agy-reported', data: parsed.data, citationsChecked: true };
}
