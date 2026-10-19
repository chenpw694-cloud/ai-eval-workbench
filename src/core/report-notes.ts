import type { ProjectBundle } from './model.ts';
import { canonicalJoint } from './joint.ts';

export type ReportNotes = {
  id: string; parentId: string | null; createdAt: string; participants: string[];
  summary: string; productInsights: string; recommendations: string;
  consistencyExplanation: string; featureComparison: string; limitations: string;
  caseQuestionIds: string[]; acknowledgedNoteIds: string[]; noteResolution: string;
};
export const emptyReportNotes = (): Omit<ReportNotes, 'id' | 'parentId' | 'createdAt'> => ({ participants: [], summary: '', productInsights: '', recommendations: '', consistencyExplanation: '', featureComparison: '', limitations: '', caseQuestionIds: [], acknowledgedNoteIds: [], noteResolution: '' });
export function latestReportNotes(rows: ReportNotes[] = []): ReportNotes | undefined {
  const parents = new Set(rows.map(row => row.parentId));
  const heads = rows.filter(row => !parents.has(row.id));
  return heads.length === 1 ? heads[0] : undefined;
}
export function validateReportNotes(rows: ReportNotes[] | undefined, bundle: ProjectBundle): string[] {
  if (rows === undefined) return [];
  if (!Array.isArray(rows) || rows.length > 1000 || new Set(rows.map(row => row?.id)).size !== rows.length) return ['报告草稿修订结构无效'];
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id || !Number.isFinite(Date.parse(row.createdAt)) || !['summary','productInsights','recommendations','consistencyExplanation','featureComparison','limitations','noteResolution'].every(key => typeof row[key as keyof ReportNotes] === 'string' && String(row[key as keyof ReportNotes]).length <= 20000) || !Array.isArray(row.participants) || new Set(row.participants).size !== row.participants.length || row.participants.some(id => !bundle.project.members.some(m => m.id === id)) || !Array.isArray(row.caseQuestionIds) || new Set(row.caseQuestionIds).size !== row.caseQuestionIds.length || row.caseQuestionIds.some(id => !bundle.quality?.joint?.plan.questionIds.includes(id)) || !Array.isArray(row.acknowledgedNoteIds) || new Set(row.acknowledgedNoteIds).size !== row.acknowledgedNoteIds.length || row.acknowledgedNoteIds.some(id => !bundle.evaluations.some(e => e.id === id)) || (row.parentId !== null && !rows.some(parent => parent.id === row.parentId && parent.id !== row.id))) return ['报告草稿字段或引用无效'];
    let cursor: ReportNotes | undefined = row; const visited = new Set<string>();
    while (cursor) { if (visited.has(cursor.id)) return ['报告草稿修订链存在循环']; visited.add(cursor.id); cursor = rows.find(parent => parent.id === cursor!.parentId); }
  }
  return rows.length && !latestReportNotes(rows) ? ['报告草稿存在多个分支，需负责人统一版本'] : [];
}
export function mergeReportNotes(a: ReportNotes[] = [], b: ReportNotes[] = []): ReportNotes[] {
  const map = new Map(a.map(row => [row.id, row]));
  for (const row of b) {
    if (map.has(row.id) && canonicalJoint(map.get(row.id)) !== canonicalJoint(row)) throw new Error('报告草稿同 ID 内容不同');
    map.set(row.id, row);
  }
  return structuredClone([...map.values()]);
}
