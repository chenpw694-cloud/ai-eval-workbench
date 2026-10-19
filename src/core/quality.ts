import type { DimensionRatings } from './model.ts';
import { isAnchorMode, imageRatingDimensions, ratingErrors, recordDimensionScore } from './ratings.ts';
import type { Evaluation, ProjectBundle, TagAssignment } from './model.ts';
import { allowedSeverities, latestEvaluations, validateEvaluation, validateProject } from './assessment.ts';
import { mergeJoint, validateJoint } from './joint.ts';
import { mergeReportNotes, validateReportNotes } from './report-notes.ts';

export type QualityKind = 'calibration' | 'review' | 'recheck' | 'gsb';
export type QualityBatch = { id: string; kind: QualityKind; seed: string; sampling?: 'mulberry32-fisher-yates-v1'; createdAt: string; schemeHash: string; questionsHash: string; candidates: string[]; sampled: string[]; trial: boolean; range: 'ABCF'; policy: 'dimension-gap-2-or-high-tag-set'; sourceBatchId: string | null };
export type QualityTask = { id: string; batchId: string; kind: QualityKind; questionId: string; reviewerId: string; evidence: { productId: string; baselineId: string; mediaIds: string[]; bestMediaId: string | null }[]; demo: boolean; previouslySeen: boolean };
export type QualityJudgment = { id: string; taskId: string; parentId: string | null; revision: number; reviewerId: string; ratings?: DimensionRatings; tags: TagAssignment[]; choice: 'win' | 'tie' | 'loss' | null; unable: boolean; exposed: boolean; notes: string; createdAt: string };
export type QualityDecision = { id: string; taskId: string; judgmentId: string; parentId: string | null; participants: string[]; ratings?: DimensionRatings; tags: TagAssignment[]; usable: boolean; reason: string; createdAt: string };
export type QualityState = { batches: QualityBatch[]; tasks: QualityTask[]; judgments: QualityJudgment[]; decisions: QualityDecision[]; finals?: { baselineId: string; decisionId: string }[]; joint?: import('./joint.ts').JointState; reportNotes?: import('./report-notes.ts').ReportNotes[]; space?: { type: 'blind' | 'return'; batchId: string; reviewerId: string } };
export const emptyQuality = (): QualityState => ({ batches: [], tasks: [], judgments: [], decisions: [] });
const clean = (value: unknown): string => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row) ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const imageDims = new Set(['A', 'B', 'C', 'F']);
export function validateQualityExtension(previous: QualityState, next: QualityState): string[] {
  for (const key of ['batches','tasks','judgments','decisions','reportNotes'] as const) {
    if ((previous[key] ?? []).some(row => clean(row) !== clean((next[key] ?? []).find(other => other.id === row.id)))) return ['已保存的质检和报告修订不能删除或原地修改，请追加新修订'];
  }
  if (previous.joint && (!next.joint || clean(previous.joint.plan) !== clean(next.joint.plan) || previous.joint.rankings.some(row => clean(row) !== clean(next.joint!.rankings.find(other => other.id === row.id))))) return ['联合样本及历史排名不能替换，请追加排名修订'];
  return [];
}
export function dimensionScore(tags: TagAssignment[], dimension: string, bundle: ProjectBundle): number {
  return Math.min(5, ...tags.filter(tag => bundle.project.scheme.tags.find(def => def.code === tag.code)?.dimension === dimension).map(tag => ({ P0: 1, P1: 2, P2: 3, P3: 4 })[tag.severity]));
}
export function disagreement(a: TagAssignment[], b: TagAssignment[], bundle: ProjectBundle, aRatings?: DimensionRatings, bRatings?: DimensionRatings): boolean {
  const relevant = (tags: TagAssignment[]) => tags.filter(tag => imageDims.has(bundle.project.scheme.tags.find(def => def.code === tag.code)?.dimension ?? ''));
  const high = (tags: TagAssignment[]) => relevant(tags).filter(tag => tag.severity === 'P0' || tag.severity === 'P1').map(tag => `${tag.code}:${tag.severity}`).sort();
  return clean(high(a)) !== clean(high(b)) || [...imageDims].some(dim => Math.abs((recordDimensionScore(bundle.project.scheme, { tags: a, ratings: aRatings }, dim) ?? NaN) - (recordDimensionScore(bundle.project.scheme, { tags: b, ratings: bRatings }, dim) ?? NaN)) >= 2);
}
export function judgmentDisagreement(a: { tags: TagAssignment[]; ratings?: DimensionRatings }, b: { tags: TagAssignment[]; ratings?: DimensionRatings }, bundle: ProjectBundle): boolean {
  return disagreement(a.tags, b.tags, bundle, a.ratings, b.ratings);
}
export function seededSample(ids: string[], count: number, seed: string): string[] {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  const rows = [...new Set(ids)].sort();
  for (let index = rows.length - 1; index > 0; index--) {
    state += 0x6d2b79f5; let x = state;
    x = Math.imul(x ^ x >>> 15, x | 1); x ^= x + Math.imul(x ^ x >>> 7, x | 61);
    const target = ((x ^ x >>> 14) >>> 0) % (index + 1);
    [rows[index], rows[target]] = [rows[target], rows[index]];
  }
  return rows.slice(0, count);
}
export function latestQuality<T extends { id: string; parentId: string | null }>(rows: T[], key: (row: T) => string): T[] {
  const parents = new Set(rows.map(row => row.parentId));
  const groups = new Map<string, T[]>();
  for (const row of rows.filter(row => !parents.has(row.id))) groups.set(key(row), [...groups.get(key(row)) ?? [], row]);
  return [...groups.values()].filter(group => group.length === 1).map(group => group[0]);
}
export function createQualityBatch(bundle: ProjectBundle, kind: QualityKind, seed: string, newId: () => string, now: string, sourceBatchId: string | null = null): QualityState {
  if (!seed.trim()) throw new Error('请填写可追溯的抽样种子');
  const preparation = validateProject(bundle.project);
  if (preparation.length) throw new Error(preparation.join('；'));
  if (!bundle.project.rulesConfirmed || bundle.project.questions.length !== bundle.project.expectedQuestionCount) throw new Error('先补齐题库并确认评分规则');
  if (bundle.project.members.length < 2) throw new Error('独立评审至少需要两位成员');
  const state = structuredClone(bundle.quality ?? emptyQuality());
  if (state.batches.some(batch => batch.kind === kind && batch.sourceBatchId === sourceBatchId)) throw new Error('已有同类固定批次；请继续原任务，不能重抽以改变样本');
  const products = bundle.project.products.filter(product => !product.demo);
  const heads = latestEvaluations(bundle.evaluations);
  const head = (productId: string, questionId: string) => heads.find(row => row.productId === productId && row.questionId === questionId);
  const valid = (row?: Evaluation) => !!row && row.schemeHash === bundle.project.schemeHash && row.questionsHash === bundle.project.questionsHash && (kind === 'calibration' ? !!row.bestMediaId : row.status === 'submitted' && !validateEvaluation(bundle.project, row, bundle.assets).length);
  const candidates = bundle.project.questions.map(question => question.id);
  if (kind === 'review' || kind === 'recheck') for (const product of products) for (const questionId of candidates) if (!valid(head(product.id, questionId))) throw new Error('请先完成所有真实产品的初评，再固定交叉复评样本');
  const batch: QualityBatch = { id: newId(), kind, seed: seed.trim(), sampling: 'mulberry32-fisher-yates-v1', createdAt: now, schemeHash: bundle.project.schemeHash, questionsHash: bundle.project.questionsHash, candidates, sampled: [], trial: candidates.length < (kind === 'calibration' ? 5 : 10), range: 'ABCF', policy: 'dimension-gap-2-or-high-tag-set', sourceBatchId };
  const tasks: QualityTask[] = [];
  const add = (questionId: string, productIds: string[], reviewerId: string) => {
    const evidence = productIds.map(productId => {
      const row = head(productId, questionId);
      if (!valid(row)) throw new Error(`${questionId} 的 ${bundle.project.products.find(product => product.id === productId)?.name} 缺少${kind === 'calibration' ? '原图与最佳图草稿' : '有效初评提交'}`);
      return { productId, baselineId: row!.id, bestMediaId: row!.bestMediaId, mediaIds: [...row!.mediaIds] };
    });
    const attendedCalibration = state.tasks.some(task => task.kind === 'calibration' && task.reviewerId === reviewerId && task.questionId === questionId && state.judgments.some(judgment => judgment.taskId === task.id));
    const authoredPrimary = productIds.some(id => head(id, questionId)?.reviewerId === reviewerId);
    tasks.push({ id: newId(), batchId: batch.id, kind, questionId, reviewerId, evidence, demo: productIds.some(id => bundle.project.products.find(product => product.id === id)?.demo), previouslySeen: attendedCalibration || authoredPrimary });
  };
  if (kind === 'calibration') {
    const available = candidates.filter(questionId => products.every(product => valid(head(product.id, questionId))));
    batch.candidates = available;
    if (available.length < Math.min(5, candidates.length)) throw new Error('至少准备共同校准的 5 题原图及最佳图；小项目按计划题量试跑');
    batch.sampled = seededSample(available, Math.min(5, candidates.length), seed);
    for (const questionId of batch.sampled) for (const product of products) for (const member of bundle.project.members) add(questionId, [product.id], member.id);
  } else if (kind === 'gsb') {
    const self = bundle.project.products.filter(product => product.role === 'self');
    if (self.length !== 1) throw new Error('GSB 需要配置且仅配置一个自家产品（可以明确标为模拟）');
    batch.sampled = candidates;
    for (const questionId of candidates) for (const competitor of bundle.project.products.filter(product => product.id !== self[0].id)) add(questionId, [self[0].id, competitor.id], competitor.ownerId);
  } else {
    let targets = products;
    if (kind === 'recheck') {
      if (!sourceBatchId) throw new Error('全量复查必须关联触发它的交叉复评批次');
      targets = products.filter(product => qualitySummary(bundle).reviews.some(row => row.batchId === sourceBatchId && row.productId === product.id && row.trigger));
      if (!targets.length) throw new Error('尚无完成 10 题且不一致超过 3 题的产品');
    }
    for (const product of targets) {
      const selected = kind === 'recheck' ? candidates : seededSample(candidates, Math.min(10, candidates.length), `${seed}:${product.id}`);
      batch.sampled.push(...selected);
      const ownerIndex = bundle.project.members.findIndex(member => member.id === product.ownerId);
      const reviewer = bundle.project.members[(ownerIndex + 1) % bundle.project.members.length];
      for (const questionId of selected) add(questionId, [product.id], reviewer.id);
    }
    batch.sampled = [...new Set(batch.sampled)];
  }
  if (!tasks.length) throw new Error('没有可分配的评审任务');
  return { ...state, batches: [...state.batches, batch], tasks: [...state.tasks, ...tasks] };
}
export function validateQuality(raw: unknown, bundle: ProjectBundle): string[] {
  if (raw === undefined) return [];
  const state = raw as QualityState;
  if (!state || !['batches', 'tasks', 'judgments', 'decisions'].every(key => Array.isArray((state as unknown as Record<string, unknown>)[key]))) return ['质检数据列表无效'];
  const errors: string[] = [];
  const exact = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
  const fail = (message: string) => { if (errors.length < 20) errors.push(message); };
  const unique = (rows: { id: string }[]) => rows.every(row => row && typeof row.id === 'string' && row.id.length > 0) && new Set(rows.map(row => row.id)).size === rows.length;
  if ([state.batches, state.tasks, state.judgments, state.decisions].some(rows => rows.length > 100000 || !unique(rows))) return ['质检 ID 重复或数量无效'];
  const member = (id: string) => bundle.project.members.some(row => row.id === id);
  const tagsValid = (tags: TagAssignment[]) => Array.isArray(tags) && new Set(tags.map(tag => tag?.code)).size === tags.length && tags.every(tag => { const def = bundle.project.scheme.tags.find(row => row.code === tag?.code); return !!def && imageDims.has(def.dimension) && allowedSeverities(def).includes(tag.severity); });
  for (const batch of state.batches) if (!['calibration', 'review', 'recheck', 'gsb'].includes(batch.kind) || typeof batch.seed !== 'string' || !batch.seed.trim() || !Number.isFinite(Date.parse(batch.createdAt)) || batch.schemeHash !== bundle.project.schemeHash || batch.questionsHash !== bundle.project.questionsHash || !Array.isArray(batch.candidates) || !Array.isArray(batch.sampled) || [...batch.candidates, ...batch.sampled].some(id => !bundle.project.questions.some(row => row.id === id)) || batch.range !== 'ABCF' || batch.policy !== 'dimension-gap-2-or-high-tag-set' || typeof batch.trial !== 'boolean') fail('质检批次口径或快照无效');
  for (const task of state.tasks) {
    if (!state.batches.some(batch => batch.id === task.batchId && batch.kind === task.kind) || !member(task.reviewerId) || !bundle.project.questions.some(row => row.id === task.questionId) || !Array.isArray(task.evidence) || task.evidence.length !== (task.kind === 'gsb' ? 2 : 1) || typeof task.demo !== 'boolean' || typeof task.previouslySeen !== 'boolean') { fail('质检任务或分工无效'); continue; }
    for (const evidence of task.evidence) if (!evidence || !bundle.project.products.some(row => row.id === evidence.productId) || typeof evidence.baselineId !== 'string' || !Array.isArray(evidence.mediaIds) || evidence.mediaIds.some(id => !bundle.assets.some(asset => asset.id === id && asset.questionId === task.questionId && asset.productId === evidence.productId)) || !(evidence.bestMediaId === null || evidence.mediaIds.includes(evidence.bestMediaId))) fail('质检证据引用无效');
    if (task.demo !== task.evidence.some(evidence => bundle.project.products.find(product => product.id === evidence.productId)?.demo)) fail('模拟数据标识不一致');
    if (task.kind === 'review' && task.evidence.some(evidence => bundle.project.products.find(product => product.id === evidence.productId)?.ownerId === task.reviewerId)) fail('交叉复评不能分给产品初评负责人');
  }
  for (const row of state.judgments) {
    const task = state.tasks.find(task => task.id === row.taskId);
    const parent = state.judgments.find(parent => parent.id === row.parentId);
    if (!task || row.reviewerId !== task.reviewerId || !Number.isSafeInteger(row.revision) || (row.parentId === null ? row.revision !== 1 : !parent || parent.taskId !== row.taskId || parent.revision + 1 !== row.revision) || !tagsValid(row.tags) || typeof row.unable !== 'boolean' || typeof row.exposed !== 'boolean' || typeof row.notes !== 'string' || !Number.isFinite(Date.parse(row.createdAt)) || (task.kind === 'gsb' ? (!(row.unable && row.choice === null) && !['win', 'tie', 'loss'].includes(String(row.choice))) || row.tags.length > 0 : row.choice !== null) || (row.unable && !row.notes.trim())) fail('独立判断字段或修订链无效');
    errors.push(...ratingErrors(bundle.project.scheme, row.ratings, task?.kind === 'gsb' ? [] : imageRatingDimensions, !!task && task.kind !== 'gsb' && !row.unable && isAnchorMode(bundle.project.scheme)));
    if (task && !row.unable && task.evidence.some(evidence => !evidence.bestMediaId)) fail('没有最佳图的任务必须说明无法判断');
  }
  if (latestQuality(state.judgments, row => row.taskId).length !== new Set(state.judgments.map(row => row.taskId)).size) fail('独立判断存在分叉，须在原空间创建单一后继后重新导出');
  for (const row of state.decisions) {
    const task = state.tasks.find(task => task.id === row.taskId);
    const parent = state.decisions.find(parent => parent.id === row.parentId);
    if (!task || task.kind === 'gsb' || !state.judgments.some(judgment => judgment.id === row.judgmentId && judgment.taskId === task.id) || (row.parentId !== null && (!parent || parent.taskId !== row.taskId)) || !Array.isArray(row.participants) || !row.participants.length || row.participants.some(id => !member(id)) || !tagsValid(row.tags) || typeof row.usable !== 'boolean' || typeof row.reason !== 'string' || !row.reason.trim() || !Number.isFinite(Date.parse(row.createdAt)) || (row.usable && row.tags.some(tag => tag.severity === 'P0' || tag.severity === 'P1'))) fail('裁决字段、引用或依据无效');
  }
  for (const row of state.decisions) {
    errors.push(...ratingErrors(bundle.project.scheme, row.ratings, imageRatingDimensions, isAnchorMode(bundle.project.scheme)));
    if (isAnchorMode(bundle.project.scheme) && row.usable && imageRatingDimensions.some(id => (row.ratings?.[id]?.score ?? 5) <= 2)) fail('低分图像裁决不可标为可用');
  }
  if (latestQuality(state.decisions, row => row.taskId).length !== new Set(state.decisions.map(row => row.taskId)).size) fail('裁决记录存在分叉');
  if (state.space && (!['blind', 'return'].includes(state.space.type) || !member(state.space.reviewerId) || !state.batches.some(batch => batch.id === state.space?.batchId) || state.tasks.some(task => task.batchId !== state.space?.batchId || task.reviewerId !== state.space?.reviewerId) || state.decisions.length)) fail('独立空间包含越界任务或裁决');
  if (state.space && (!exact(state.space, ['type','batchId','reviewerId']) || !exact(state, ['batches','tasks','judgments','decisions','space']) || state.batches.some(batch => !exact(batch, ['id','kind','seed','sampling','createdAt','schemeHash','questionsHash','candidates','sampled','trial','range','policy','sourceBatchId'])) || state.tasks.some(task => !exact(task, ['id','batchId','kind','questionId','reviewerId','evidence','demo','previouslySeen']) || task.evidence.some(evidence => !exact(evidence, ['productId','baselineId','mediaIds','bestMediaId']))))) fail('独立任务包包含非协议字段，不能保证已剔除原判断');
  if (state.finals && (!Array.isArray(state.finals) || new Set(state.finals.map(row => row?.baselineId)).size !== state.finals.length || state.finals.some(row => !row || !state.decisions.some(decision => decision.id === row.decisionId && state.tasks.some(task => task.id === decision.taskId && ['review','recheck'].includes(task.kind) && task.evidence[0]?.baselineId === row.baselineId))))) fail('最终引用无效或重复');
  errors.push(...validateJoint(state.joint, bundle), ...validateReportNotes(state.reportNotes, { ...bundle, quality: state }));
  return errors;
}

export function validateQualityReturn(bundle: ProjectBundle, returned: ProjectBundle): string[] {
  const state = returned.quality, local = bundle.quality ?? emptyQuality();
  if (!state?.space || state.space.type !== 'return' || returned.project.id !== bundle.project.id || returned.project.schemeHash !== bundle.project.schemeHash || returned.project.questionsHash !== bundle.project.questionsHash) return ['返回包项目、口径或类型不匹配'];
  const identity = (source: ProjectBundle) => source.project.products.map(({totalCost, commercialUse, commercialEvidence, ...product}) => product);
  if (clean(identity(bundle)) !== clean(identity(returned)) || clean(bundle.project.members) !== clean(returned.project.members)) return ['返回包修改了产品或成员身份'];
  if (state.tasks.some(task => clean(local.tasks.find(row => row.id === task.id)) !== clean(task)) || state.batches.some(batch => clean(local.batches.find(row => row.id === batch.id)) !== clean(batch))) return ['返回包修改了原任务、证据或抽样口径'];
  for (const asset of returned.assets) {
    const source = bundle.assets.find(row => row.id === asset.id);
    if (!source || ['sha256','size','mime','projectId','questionId','productId','role'].some(key => source[key as keyof typeof source] !== asset[key as keyof typeof asset])) return ['返回包图片与初评基线的原图字节或归属不同'];
  }
  return [];
}
export function mergeQuality(local: QualityState | undefined, incoming: QualityState | undefined, bundle: ProjectBundle): QualityState | undefined {
  if (!local && !incoming) return undefined;
  const output = emptyQuality();
  for (const key of ['batches', 'tasks', 'judgments', 'decisions'] as const) {
    const map = new Map<string, unknown>();
    for (const row of [...local?.[key] ?? [], ...incoming?.[key] ?? []]) {
      if (map.has(row.id) && clean(map.get(row.id)) !== clean(row)) throw new Error(`质检同 ID 内容不一致：${row.id}`);
      map.set(row.id, structuredClone(row));
    }
    (output[key] as unknown[]) = [...map.values()];
  }
  const finals = new Map<string, string>();
  for (const row of [...local?.finals ?? [], ...incoming?.finals ?? []]) {
    if (finals.has(row.baselineId) && finals.get(row.baselineId) !== row.decisionId) throw new Error('最终裁决引用不同，请负责人统一后重新分发');
    finals.set(row.baselineId, row.decisionId);
  }
  if (finals.size) output.finals = [...finals].map(([baselineId, decisionId]) => ({ baselineId, decisionId }));
  const joint = mergeJoint(local?.joint, incoming?.joint);
  if (joint) output.joint = joint;
  const reportNotes = mergeReportNotes(local?.reportNotes, incoming?.reportNotes);
  if (reportNotes.length) output.reportNotes = reportNotes;
  const errors = validateQuality(output, bundle);
  if (errors.length) throw new Error(errors.join('；'));
  return output;
}

export function finalQualityBundle(bundle: ProjectBundle): ProjectBundle {
  const state = bundle.quality ?? emptyQuality();
  const judgments = latestQuality(state.judgments, row => row.taskId);
  return { ...bundle, evaluations: bundle.evaluations.map(record => {
    const reference = state.finals?.find(row => row.baselineId === record.id);
    const decision = state.decisions.find(row => row.id === reference?.decisionId);
    const task = state.tasks.find(row => row.id === decision?.taskId);
    if (!decision || !task || task.kind === 'calibration' || !judgments.some(row => row.id === decision.judgmentId)) return record;
    return { ...record, ...(isAnchorMode(bundle.project.scheme) ? { ratings: { ...record.ratings, ...decision.ratings } } : {}), tags: [...record.tags.filter(tag => !imageDims.has(bundle.project.scheme.tags.find(def => def.code === tag.code)?.dimension ?? '')), ...decision.tags], mediaChecks: record.mediaChecks.map(check => check.mediaId === record.bestMediaId ? { ...check, usable: decision.usable, infringement: decision.tags.some(tag => tag.code === 'F-01') } : check) };
  }) };
}
export function qualitySummary(bundle: ProjectBundle) {
  const state = bundle.quality ?? emptyQuality();
  const judgments = latestQuality(state.judgments, row => row.taskId);
  const reviews = state.batches.filter(batch => batch.kind === 'review' || batch.kind === 'recheck').flatMap(batch => bundle.project.products.filter(product => !product.demo).map(product => {
    const tasks = state.tasks.filter(task => task.batchId === batch.id && task.evidence[0]?.productId === product.id);
    let completed = 0, different = 0, exposed = 0;
    for (const task of tasks) {
      const judgment = judgments.find(row => row.taskId === task.id);
      const original = bundle.evaluations.find(row => row.id === task.evidence[0].baselineId);
      if (!judgment || judgment.unable || !original || ratingErrors(bundle.project.scheme, judgment.ratings, imageRatingDimensions, isAnchorMode(bundle.project.scheme)).length || ratingErrors(bundle.project.scheme, original.ratings, ['A','B','C','F','G'], isAnchorMode(bundle.project.scheme)).length) continue;
      if (judgment.exposed || task.previouslySeen) exposed++;
      completed++; if (judgmentDisagreement(original, judgment, bundle)) different++;
    }
    return { batchId: batch.id, kind: batch.kind, productId: product.id, expected: tasks.length, completed, different, exposed, rate: completed ? (completed - different) / completed : null, trigger: batch.kind === 'review' && tasks.length === 10 && completed === 10 && different > 3, trial: batch.trial };
  }).filter(row => row.expected));
  const gsb = bundle.project.products.filter(product => product.role !== 'self').map(product => {
    const tasks = state.tasks.filter(task => task.kind === 'gsb' && task.evidence[1]?.productId === product.id);
    const rows = judgments.filter(row => tasks.some(task => task.id === row.taskId) && !row.unable);
    const wins = rows.filter(row => row.choice === 'win').length, losses = rows.filter(row => row.choice === 'loss').length;
    return { productId: product.id, expected: tasks.length, n: rows.length, wins, losses, ties: rows.length - wins - losses, net: rows.length ? (wins - losses) / rows.length : null, demo: tasks.some(task => task.demo), exposed: rows.filter(row => row.exposed).length };
  }).filter(row => row.expected);
  const decisions = latestQuality(state.decisions, row => row.taskId);
  const unresolved = state.tasks.filter(task => (task.kind === 'review' || task.kind === 'recheck') && (() => { const row = judgments.find(row => row.taskId === task.id); const original = bundle.evaluations.find(row => row.id === task.evidence[0].baselineId); return !!row && !row.unable && !!original && judgmentDisagreement(original, row, bundle) && !decisions.some(decision => decision.taskId === task.id && decision.judgmentId === row.id); })());
  return { reviews, gsb, unresolved, completed: judgments.length, expected: state.tasks.length };
}

/** Objective-only transport: no original scores, usability, notes, costs or audit history. */
export function blindQualityBundle(bundle: ProjectBundle, batchId: string, reviewerId: string, returning = false): ProjectBundle {
  const state = bundle.quality ?? emptyQuality();
  const batch = state.batches.find(row => row.id === batchId);
  if (!batch) throw new Error('找不到评审批次');
  const tasks = state.tasks.filter(task => task.batchId === batchId && task.reviewerId === reviewerId);
  if (!tasks.length) throw new Error('该成员在此批次没有任务');
  const ids = new Set(tasks.flatMap(task => task.evidence.flatMap(evidence => evidence.mediaIds)));
  const questionIds = new Set(tasks.map(task => task.questionId));
  return {
    project: { id: bundle.project.id, name: '独立评审', background: '', period: '', members: structuredClone(bundle.project.members), products: bundle.project.products.map(({id,name,version,role,demo,ownerId}) => ({ id,name,version,role,demo,ownerId, totalCost: null, commercialUse: 'unreviewed', commercialEvidence: '' })), questions: structuredClone(bundle.project.questions), scheme: structuredClone(bundle.project.scheme), rulesConfirmed: bundle.project.rulesConfirmed, expectedQuestionCount: bundle.project.expectedQuestionCount, status: bundle.project.status, revision: bundle.project.revision, createdAt: bundle.project.createdAt, updatedAt: bundle.project.updatedAt, schemeHash: bundle.project.schemeHash, questionsHash: bundle.project.questionsHash },
    assets: bundle.assets.filter(asset => ids.has(asset.id) || (asset.role === 'reference' && questionIds.has(asset.questionId))).map((asset, index) => ({ ...asset, name: `evidence-${index + 1}.${asset.mime.split('/')[1]}`, createdAt: batch.createdAt })),
    evaluations: [], walkthroughs: [], experiences: [],
    quality: { batches: [structuredClone(batch)], tasks: structuredClone(tasks), judgments: returning ? state.judgments.filter(row => tasks.some(task => task.id === row.taskId)) : [], decisions: [], space: { type: returning ? 'return' : 'blind', batchId, reviewerId } }
  };
}
