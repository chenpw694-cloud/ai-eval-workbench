import type { ProjectBundle, Scheme } from './model.ts';
import { latestEvaluations, validateEvaluation, validateProject } from './assessment.ts';
import type { RatingValidationOptions } from './ratings.ts';

export type JointPolicy = { scenes: string[]; perScene: number; minimumQuestions: number };
export type JointPlan = {
  id: string; createdAt: string; schemeHash: string; questionsHash: string;
  policy: JointPolicy; questionIds: string[]; productIds: string[]; selectionReason: string; trial: boolean;
  evidence: { questionId: string; productId: string; baselineId: string; bestMediaId: string; sha256: string }[];
};
export type JointRanking = {
  id: string; parentId: string | null; questionId: string; participants: string[];
  ranks: { productId: string; rank: number }[]; unable: boolean; reason: string; createdAt: string;
};
export type JointState = { plan: JointPlan; rankings: JointRanking[] };
export const fallbackJointPolicy: JointPolicy = { scenes: ['白底主图', '场景图', '详情图', '营销海报'], perScene: 3, minimumQuestions: 50 };
export const jointPolicy = (scheme: Scheme): JointPolicy => scheme.jointReview ?? fallbackJointPolicy;
export const canonicalJoint = (value: unknown): string => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row) ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
export const latestRankings = (rows: JointRanking[]): JointRanking[] => {
  const parents = new Set(rows.map(row => row.parentId));
  const heads = rows.filter(row => !parents.has(row.id));
  return heads.filter(row => heads.filter(other => other.questionId === row.questionId).length === 1);
};
export function validateJointPolicy(policy: JointPolicy): string[] {
  return !policy || !Array.isArray(policy.scenes) || !policy.scenes.length || policy.scenes.length > 20 || policy.scenes.some(scene => typeof scene !== 'string' || !scene.trim()) || new Set(policy.scenes).size !== policy.scenes.length || !Number.isSafeInteger(policy.perScene) || policy.perScene < 1 || policy.perScene > 50 || !Number.isSafeInteger(policy.minimumQuestions) || policy.minimumQuestions < 1 ? ['联合评审场景、配额或正式题量配置无效'] : [];
}
export function createJointPlan(bundle: ProjectBundle, questionIds: string[], selectionReason: string, id: string, createdAt: string): JointState {
  if (bundle.quality?.joint) throw new Error('联合样本已经固定，请继续原样本，不能替换以改变结论');
  const errors = validateProject(bundle.project);
  if (errors.length) throw new Error(errors.join('；'));
  const policy = jointPolicy(bundle.project.scheme);
  if (validateJointPolicy(policy).length) throw new Error('联合评审配置无效');
  const products = bundle.project.products.filter(product => !product.demo);
  if (products.length < 2) throw new Error('联合排名至少需要两个真实产品');
  const latest = latestEvaluations(bundle.evaluations);
  for (const product of products) for (const question of bundle.project.questions) {
    const row = latest.find(row => row.productId === product.id && row.questionId === question.id);
    if (!row || row.status !== 'submitted' || row.schemeHash !== bundle.project.schemeHash || row.questionsHash !== bundle.project.questionsHash || validateEvaluation(bundle.project, row, bundle.assets).length) throw new Error('先完成全部真实产品的有效初评，再固定联合样本');
  }
  if (!selectionReason.trim()) throw new Error('请记录共同选题依据，兼顾品类与难度');
  if (new Set(questionIds).size !== questionIds.length || !questionIds.length || questionIds.some(id => !bundle.project.questions.some(q => q.id === id && policy.scenes.includes(q.scene)))) throw new Error('联合样本包含重复、未知题目或未配置场景');
  for (const scene of policy.scenes) {
    const target = Math.min(policy.perScene, bundle.project.questions.filter(q => q.scene === scene).length);
    if (questionIds.filter(id => bundle.project.questions.find(q => q.id === id)?.scene === scene).length !== target) throw new Error(`${scene} 应选择 ${target} 题`);
  }
  const plan: JointPlan = {
    id, createdAt, schemeHash: bundle.project.schemeHash, questionsHash: bundle.project.questionsHash,
    policy: structuredClone(policy), questionIds: [...questionIds], productIds: products.map(p => p.id), selectionReason: selectionReason.trim(),
    trial: bundle.project.questions.length < policy.minimumQuestions || policy.scenes.some(scene => bundle.project.questions.filter(q => q.scene === scene).length < policy.perScene),
    evidence: questionIds.flatMap(questionId => products.map(product => {
      const row = latest.find(row => row.productId === product.id && row.questionId === questionId)!;
      const asset = bundle.assets.find(asset => asset.id === row.bestMediaId);
      if (!row.bestMediaId || !asset) throw new Error(`${questionId} 的 ${product.name} 缺少最佳图，请选择有共同证据的题目`);
      return { questionId, productId: product.id, baselineId: row.id, bestMediaId: row.bestMediaId, sha256: asset.sha256 };
    }))
  };
  const state = { plan, rankings: [] };
  const problems = validateJoint(state, bundle);
  if (problems.length) throw new Error(problems.join('；'));
  return state;
}
export function validateJoint(raw: JointState | undefined, bundle: ProjectBundle, options: RatingValidationOptions = {}): string[] {
  if (raw === undefined) return [];
  const errors: string[] = [];
  const plan = raw?.plan;
  if (!plan || !Array.isArray(raw.rankings) || raw.rankings.length > 10000 || validateJointPolicy(plan.policy).length || typeof plan.id !== 'string' || !plan.id || !Number.isFinite(Date.parse(plan.createdAt)) || plan.schemeHash !== bundle.project.schemeHash || plan.questionsHash !== bundle.project.questionsHash || canonicalJoint(plan.policy) !== canonicalJoint(jointPolicy(bundle.project.scheme)) || typeof plan.trial !== 'boolean' || typeof plan.selectionReason !== 'string' || !plan.selectionReason.trim() || !Array.isArray(plan.questionIds) || !plan.questionIds.length || new Set(plan.questionIds).size !== plan.questionIds.length || !Array.isArray(plan.productIds) || new Set(plan.productIds).size !== plan.productIds.length || plan.productIds.length < 2 || !Array.isArray(plan.evidence)) return ['联合样本结构、配置或快照无效'];
  const products = bundle.project.products.filter(product => !product.demo).map(p => p.id);
  if (canonicalJoint([...plan.productIds].sort()) !== canonicalJoint(products.sort())) errors.push('联合样本混入模拟产品或遗漏真实产品');
  if (plan.questionIds.some(id => !bundle.project.questions.some(q => q.id === id && plan.policy.scenes.includes(q.scene)))) errors.push('联合样本题目无效');
  for (const scene of plan.policy.scenes) if (plan.questionIds.filter(id => bundle.project.questions.find(q => q.id === id)?.scene === scene).length !== Math.min(plan.policy.perScene, bundle.project.questions.filter(q => q.scene === scene).length)) errors.push('联合样本场景配额无效');
  const trial = bundle.project.questions.length < plan.policy.minimumQuestions || plan.policy.scenes.some(scene => bundle.project.questions.filter(q => q.scene === scene).length < plan.policy.perScene);
  if (trial !== plan.trial) errors.push('联合样本试跑标识无效');
  if (plan.evidence.length !== plan.questionIds.length * plan.productIds.length) errors.push('联合样本证据数量无效');
  for (const questionId of plan.questionIds) for (const productId of plan.productIds) {
    const rows = plan.evidence.filter(row => row?.questionId === questionId && row.productId === productId);
    const row = rows[0], baseline = bundle.evaluations.find(e => e.id === row?.baselineId), asset = bundle.assets.find(a => a.id === row?.bestMediaId);
    if (rows.length !== 1 || !baseline || baseline.questionId !== questionId || baseline.productId !== productId || baseline.status !== 'submitted' || validateEvaluation(bundle.project, baseline, bundle.assets, options).length || baseline.bestMediaId !== row.bestMediaId || !baseline.mediaIds.includes(row.bestMediaId) || baseline.schemeHash !== plan.schemeHash || baseline.questionsHash !== plan.questionsHash || !asset || asset.productId !== productId || asset.questionId !== questionId || asset.sha256 !== row.sha256) errors.push('联合样本最佳图或初评引用无效');
  }
  if (new Set(raw.rankings.map(row => row?.id)).size !== raw.rankings.length) errors.push('联合排名 ID 重复');
  for (const row of raw.rankings) {
    const parent = raw.rankings.find(p => p.id === row?.parentId);
    if (!row || typeof row.id !== 'string' || !row.id || !plan.questionIds.includes(row.questionId) || !Number.isFinite(Date.parse(row.createdAt)) || (row.parentId !== null && (!parent || parent.questionId !== row.questionId || parent.id === row.id)) || !Array.isArray(row.participants) || new Set(row.participants).size !== row.participants.length || canonicalJoint([...row.participants].sort()) !== canonicalJoint(bundle.project.members.map(m => m.id).sort()) || typeof row.unable !== 'boolean' || typeof row.reason !== 'string' || !row.reason.trim() || !Array.isArray(row.ranks) || (row.unable ? row.ranks.length !== 0 : row.ranks.length !== plan.productIds.length || new Set(row.ranks.map(r => r?.productId)).size !== plan.productIds.length || row.ranks.some(r => !r || !plan.productIds.includes(r.productId) || !Number.isInteger(r.rank) || r.rank < 1 || r.rank > plan.productIds.length) || !row.ranks.some(r => r.rank === 1))) errors.push('联合排名、参与人或讨论依据无效');
    const visited = new Set<string>(); let cursor: JointRanking | undefined = row;
    while (cursor) { if (visited.has(cursor.id)) { errors.push('联合排名修订链存在循环'); break; } visited.add(cursor.id); cursor = raw.rankings.find(p => p.id === cursor!.parentId); }
  }
  if (latestRankings(raw.rankings).length !== new Set(raw.rankings.map(r => r.questionId)).size) errors.push('联合排名修订存在分叉');
  return [...new Set(errors)];
}
export function jointSummary(bundle: ProjectBundle) {
  const state = bundle.quality?.joint;
  if (!state) return { expected: 0, completed: 0, unable: 0, stale: false, pairs: [] as { left: string; right: string; wins: number; ties: number; losses: number; n: number; net: number | null }[] };
  const heads = latestEvaluations(bundle.evaluations);
  const stale = state.plan.evidence.some(e => heads.find(row => row.productId === e.productId && row.questionId === e.questionId)?.id !== e.baselineId);
  const rankings = latestRankings(state.rankings), valid = rankings.filter(row => !row.unable);
  const pairs = state.plan.productIds.flatMap((left, index) => state.plan.productIds.slice(index + 1).map(right => {
    let wins = 0, ties = 0, losses = 0;
    for (const row of valid) {
      const a = row.ranks.find(r => r.productId === left)?.rank, b = row.ranks.find(r => r.productId === right)?.rank;
      if (a === undefined || b === undefined) continue;
      if (a < b) wins++; else if (a > b) losses++; else ties++;
    }
    const n = wins + ties + losses;
    return { left, right, wins, ties, losses, n, net: n ? (wins - losses) / n : null };
  }));
  return { expected: state.plan.questionIds.length, completed: valid.length, unable: rankings.filter(row => row.unable).length, stale, pairs };
}
export function mergeJoint(a: JointState | undefined, b: JointState | undefined): JointState | undefined {
  if (!a) return b ? structuredClone(b) : undefined;
  if (!b) return structuredClone(a);
  if (canonicalJoint(a.plan) !== canonicalJoint(b.plan)) throw new Error('联合样本不同，需负责人统一固定样本后再合并');
  const map = new Map(a.rankings.map(row => [row.id, row]));
  for (const row of b.rankings) {
    if (map.has(row.id) && canonicalJoint(map.get(row.id)) !== canonicalJoint(row)) throw new Error('联合排名同 ID 内容不同');
    map.set(row.id, row);
  }
  return { plan: structuredClone(a.plan), rankings: structuredClone([...map.values()]) };
}
