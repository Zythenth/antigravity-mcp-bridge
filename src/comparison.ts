import { z } from 'zod';
import type { TaskRecord } from './types.js';
import { reviewerReportSchema } from './roles.js';

export const comparisonModelsSchema = z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)).min(2).max(4)
  .refine(models => new Set(models).size === models.length, 'Choose distinct model IDs');
export const comparisonSchema = z.object({
  comparisonId: z.string().uuid(), sourceTaskId: z.string().uuid(),
  treeSha256: z.string().regex(/^[a-f0-9]{64}$/), models: comparisonModelsSchema,
  startErrors: z.array(z.object({ model: z.string(), code: z.string(), message: z.string() }).strict()),
}).strict();
export type Comparison = z.infer<typeof comparisonSchema>;
type Finding = z.infer<typeof reviewerReportSchema>['findings'][number];
export const comparisonFindingSchema = z.object({
  path: z.string(), line: z.number().int().positive(), quote: z.string(),
  agreement: z.enum(['identical', 'different', 'not-reported-by-all']),
  opinions: z.array(z.object({ model: z.string(), finding: reviewerReportSchema.shape.findings.element }).strict()),
  notReportedBy: z.array(z.string()),
}).strict();

export function compareFindings(tasks: TaskRecord[], models: string[]) {
  const groups = new Map<string, Array<{ model: string; finding: Finding }>>();
  const valid = tasks.filter(task => task.status === 'completed' && task.report?.role === 'reviewer');
  for (const task of valid) {
    if (task.report?.role !== 'reviewer' || !task.model) continue;
    for (const finding of task.report.data.findings) {
      const key = JSON.stringify([finding.path, finding.line, finding.quote]);
      const group = groups.get(key) ?? [];
      group.push({ model: task.model, finding });
      groups.set(key, group);
    }
  }
  return [...groups.values()].map(opinions => {
    const { path, line, quote } = opinions[0]!.finding;
    const notReportedBy = models.filter(model => !opinions.some(opinion => opinion.model === model));
    return { path, line, quote, opinions, notReportedBy,
      agreement: notReportedBy.length ? 'not-reported-by-all' as const :
        new Set(opinions.map(opinion => JSON.stringify(opinion.finding))).size === 1 ? 'identical' as const : 'different' as const };
  });
}
