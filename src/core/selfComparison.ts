import type { ProjectBundle } from './model.ts';
import { latestEvaluations, validateEvaluation } from './assessment.ts';
import type { RatingValidationOptions } from './ratings.ts';

/** Report cases cite completed, current self/competitor judgments, never inferred rankings. */
export function selfComparisonEvidence(bundle: ProjectBundle, options: RatingValidationOptions = {}) {
  const self = bundle.project.products.filter(product => product.role === 'self');
  if (self.length !== 1) return [];
  const heads = latestEvaluations(bundle.evaluations);
  const rows = bundle.quality?.judgments ?? [];
  const parents = new Set(rows.map(row => row.parentId));
  const leaves = rows.filter(row => !parents.has(row.id));
  return (bundle.quality?.tasks ?? []).filter(task => task.kind === 'gsb').flatMap(task => {
    const judgments = leaves.filter(row => row.taskId === task.id);
    const judgment = judgments.length === 1 ? judgments[0] : undefined;
    if (!judgment || judgment.unable || !['win', 'tie', 'loss'].includes(String(judgment.choice)) || task.evidence.length !== 2 || task.evidence[0].productId !== self[0].id || task.evidence[1].productId === self[0].id) return [];
    const evidence = task.evidence.flatMap(item => {
      const head = heads.find(row => row.productId === item.productId && row.questionId === task.questionId);
      const asset = bundle.assets.find(row => row.id === item.bestMediaId && row.role === 'output' && row.productId === item.productId && row.questionId === task.questionId);
      if (!head || head.id !== item.baselineId || head.status !== 'submitted' || validateEvaluation(bundle.project, head, bundle.assets, options).length || !asset || head.bestMediaId !== asset.id) return [];
      return [{ productId: item.productId, baselineId: item.baselineId, bestMediaId: asset.id, sha256: asset.sha256 }];
    });
    return evidence.length === 2 ? [{ questionId: task.questionId, taskId: task.id, judgmentId: judgment.id, reviewerId: judgment.reviewerId, competitorId: task.evidence[1].productId, choice: judgment.choice!, notes: judgment.notes, demo: task.demo, evidence }] : [];
  });
}

/** Drafts may select fixed tasks before judging; completion is checked separately. */
export function fixedReportCaseIds(bundle: ProjectBundle): Set<string> {
  return new Set([
    ...bundle.quality?.joint?.plan.questionIds ?? [],
    ...(bundle.quality?.tasks ?? []).filter(task => task.kind === 'gsb').map(task => task.questionId)
  ]);
}
