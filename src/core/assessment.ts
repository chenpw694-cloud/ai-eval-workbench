import { isAnchorMode, questionDimensions, imageRatingDimensions, ratingErrors, ratingSchemeErrors, recordDimensionScore } from './ratings.ts';
import { dimensionScore, type Severity } from './scoring.ts';
import type {
  AssetMetadata, DimensionId, Evaluation, Metric, Product, ProductResult,
  Project, ProjectBundle, TagAssignment, TagDefinition, Walkthrough
} from './model.ts';

const dimensionIds: DimensionId[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const imageDimensions: DimensionId[] = ['A', 'B', 'C', 'F'];
const severities: Severity[] = ['P0', 'P1', 'P2', 'P3'];
const walkthroughTasks = ['background', 'color', 'expand'] as const;
const filled = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const unique = (values: string[]) => [...new Set(values)];
const average = (values: number[]): number | null => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const groupKey = (record: Evaluation) => JSON.stringify([record.projectId, record.productId, record.questionId]);

/** Only one adjacent severity step is allowed; infringement is always P0. */
export function allowedSeverities(tag: TagDefinition): Severity[] {
  if (tag.code === 'F-01') return ['P0'];
  const index = severities.indexOf(tag.severity);
  return index < 0 ? [] : severities.filter((_, candidate) => Math.abs(candidate - index) <= 1);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function resolveRevisions(revisions: Evaluation[]): { latest: Evaluation[]; issues: Map<string, string> } {
  const groups = new Map<string, Evaluation[]>();
  const issues = new Map<string, string>();
  const latest: Evaluation[] = [];
  for (const record of revisions) {
    const key = groupKey(record);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  for (const [key, records] of groups) {
    const byId = new Map<string, Evaluation>();
    for (const record of records) {
      const existing = byId.get(record.id);
      if (existing && canonical(existing) !== canonical(record)) issues.set(key, '同一修订 ID 存在不同内容，需处理修订分叉');
      byId.set(record.id, record);
    }
    if (issues.has(key)) continue;
    const values = [...byId.values()];
    if (values.some(record => !filled(record.id) || !Number.isSafeInteger(record.revision) || record.revision < 1)) {
      issues.set(key, '修订 ID 或版本号无效');
      continue;
    }
    const roots = values.filter(record => record.parentId === null);
    if (roots.length !== 1) { issues.set(key, '修订分叉或存在多个根记录'); continue; }
    const parents = new Set<string>();
    for (const record of values) {
      if (record.parentId === null) continue;
      const parent = byId.get(record.parentId);
      if (!parent || parent.revision >= record.revision) issues.set(key, '修订链断裂或父版本无效');
      parents.add(record.parentId);
    }
    const leaves = values.filter(record => !parents.has(record.id));
    if (issues.has(key)) continue;
    if (leaves.length !== 1) { issues.set(key, '修订分叉，不能静默选择其中一个版本'); continue; }
    const visited = new Set<string>();
    let cursor: Evaluation | undefined = leaves[0];
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    if (visited.size !== values.length) { issues.set(key, '修订链存在循环或未连接记录'); continue; }
    latest.push(leaves[0]);
  }
  return { latest, issues };
}

/** Includes a latest draft; callers must not fall back to its submitted ancestor. */
export function latestEvaluations(revisions: Evaluation[]): Evaluation[] {
  return resolveRevisions(revisions).latest;
}

function tagErrors(project: Project, assignments: TagAssignment[], allowed: string[]): string[] {
  const errors: string[] = [];
  if (new Set(assignments.map(tag => tag.code)).size !== assignments.length) errors.push('同一问题标签不可重复');
  for (const assignment of assignments) {
    const definition = project.scheme.tags.find(tag => tag.code === assignment.code);
    if (!definition) { errors.push(`未知问题标签：${assignment.code}`); continue; }
    if (!allowed.includes(definition.dimension)) errors.push(`标签 ${assignment.code} 不适用于当前评测记录`);
    if (!allowedSeverities(definition).includes(assignment.severity)) errors.push(`标签 ${assignment.code} 的严重等级超出允许范围`);
  }
  return errors;
}

/** Submission validation. Incomplete drafts may still be stored by the caller. */
export function validateEvaluation(project: Project, record: Evaluation, assets: AssetMetadata[]): string[] {
  const errors: string[] = [...validateProject(project)];
  const question = project.questions.find(item => item.id === record.questionId);
  const product = project.products.find(item => item.id === record.productId);
  if (record.projectId !== project.id) errors.push('评测记录不属于当前项目');
  if (!product) errors.push('被测产品不存在');
  if (!question) errors.push('评测题目不存在');
  if (!project.members.some(member => member.id === record.reviewerId)) errors.push('评测员不在项目成员中');
  if (!filled(record.id) || !Number.isSafeInteger(record.revision) || record.revision < 1 || record.parentId === record.id) errors.push('修订标识无效');
  if (!record.schemeHash || record.schemeHash !== project.schemeHash) errors.push('规则快照不匹配');
  if (!record.questionsHash || record.questionsHash !== project.questionsHash) errors.push('题库快照不匹配');
  if (record.seconds === null || !Number.isFinite(record.seconds) || record.seconds < 0) errors.push('生成耗时须为大于或等于 0 的有限秒数');
  errors.push(...tagErrors(project, record.tags, ['A', 'B', 'C', 'F', 'G']));
  const ratingDims = record.failed && !record.mediaIds.length ? ['G'] : questionDimensions;
  errors.push(...ratingErrors(project.scheme, record.ratings, questionDimensions, false));
  if (isAnchorMode(project.scheme)) errors.push(...ratingErrors(project.scheme, record.ratings && Object.fromEntries(Object.entries(record.ratings).filter(([id]) => ratingDims.includes(id))), ratingDims, true));
  if (record.failed && !filled(record.failureReason)) errors.push('生成失败必须填写失败原因');
  if (record.failed && !record.tags.some(tag => tag.code === 'G-03' || tag.code === 'G-04')) errors.push('生成失败需记录 G-03 或 G-04 标签');
  if (!record.failed && record.mediaIds.length === 0) errors.push('非失败任务必须有原始输出图片');
  if (new Set(record.mediaIds).size !== record.mediaIds.length) errors.push('输出图片引用不可重复');
  if (new Set(record.mediaChecks.map(check => check.mediaId)).size !== record.mediaChecks.length) errors.push('同一图片不可存在重复检查记录');
  for (const check of record.mediaChecks) {
    if (!record.mediaIds.includes(check.mediaId)) errors.push(`图片检查引用不属于本题：${check.mediaId}`);
  }
  for (const mediaId of record.mediaIds) {
    const matching = assets.filter(asset => asset.id === mediaId);
    const asset = matching[0];
    if (matching.length !== 1 || !asset || asset.role !== 'output' || asset.projectId !== project.id || asset.productId !== record.productId || asset.questionId !== record.questionId) {
      errors.push(`原图缺失或归属不匹配：${mediaId}`);
    }
    const check = record.mediaChecks.find(item => item.mediaId === mediaId);
    if (!check || typeof check.usable !== 'boolean') errors.push(`图片尚未检查可用性：${mediaId}`);
    if (!check || typeof check.infringement !== 'boolean') errors.push(`图片尚未检查侵权风险：${mediaId}`);
    if (check?.infringement === true && check.usable === true) errors.push(`存在侵权风险的图片不可标记为可用：${mediaId}`);
  }
  if (record.mediaIds.length > 0) {
    if (!record.bestMediaId || !record.mediaIds.includes(record.bestMediaId)) errors.push('最佳图必须引用本题现有原图');
    else {
      const check = record.mediaChecks.find(item => item.mediaId === record.bestMediaId);
      const seriousImageTag = record.tags.some(assignment => {
        const definition = project.scheme.tags.find(tag => tag.code === assignment.code);
        return definition && imageDimensions.includes(definition.dimension as DimensionId) && ['P0', 'P1'].includes(assignment.severity);
      });
      if ((seriousImageTag || (isAnchorMode(project.scheme) && imageRatingDimensions.some(id => (record.ratings?.[id]?.score ?? 5) <= 2))) && check?.usable === true) errors.push('最佳图存在 P0/P1 问题，不可标记为可用');
      const hasInfringementTag = record.tags.some(tag => tag.code === 'F-01');
      if (check && typeof check.infringement === 'boolean' && hasInfringementTag !== check.infringement) errors.push('最佳图 F-01 标签与逐图侵权检查不一致');
    }
  } else if (record.bestMediaId !== null) errors.push('零输出任务不能引用最佳图');
  for (const name of unique(question?.referenceNames ?? [])) {
    if (!assets.some(asset => asset.projectId === project.id && asset.questionId === record.questionId && asset.role === 'reference' && asset.name === name)) errors.push(`参考图缺失：${name}`);
  }
  return unique(errors);
}

export function validateProject(project: Project): string[] {
  const errors: string[] = [];
  if (!filled(project.id)) errors.push('项目 ID 不可为空');
  if (!filled(project.name)) errors.push('项目名称不可为空');
  if (!project.members.length) errors.push('至少需要一名项目成员');
  for (const [label, items] of [['成员', project.members], ['产品', project.products], ['题目', project.questions]] as const) {
    if (items.some(item => !filled(item.id))) errors.push(`${label} ID 不可为空`);
    if (new Set(items.map(item => item.id)).size !== items.length) errors.push(`${label} ID 不可重复`);
  }
  if (project.members.some(member => !filled(member.name))) errors.push('成员姓名不可为空');
  if (!project.products.some(product => !product.demo)) errors.push('至少需要一个真实产品');
  for (const product of project.products) {
    if (!filled(product.name)) errors.push(`产品 ${product.id} 的名称不可为空`);
    if (!filled(product.version)) errors.push(`产品 ${product.id} 的版本或档位不可为空`);
    if (!project.members.some(member => member.id === product.ownerId)) errors.push(`产品 ${product.id} 的负责人不在项目成员中`);
    if (product.totalCost !== null && (!Number.isFinite(product.totalCost) || product.totalCost < 0)) errors.push(`产品 ${product.id} 的费用须为非负有限数或未知`);
  }
  if (!project.questions.length) errors.push('题库至少需要一道题');
  if (!Number.isSafeInteger(project.expectedQuestionCount) || project.expectedQuestionCount < 1) errors.push('计划题量必须为正整数');
  else if (project.questions.length !== project.expectedQuestionCount) errors.push(`题库现有 ${project.questions.length} 题，与计划 ${project.expectedQuestionCount} 题不一致；若试跑请调整计划题量`);
  for (const question of project.questions) {
    if (!filled(question.request)) errors.push(`题目 ${question.id} 缺少需求描述`);
    if (!question.acceptance.length || question.acceptance.some(item => !filled(item))) errors.push(`题目 ${question.id} 至少需要一条有效验收要点`);
  }
  if (!filled(project.scheme.version)) errors.push('规则版本不可为空');
  errors.push(...ratingSchemeErrors(project.scheme));
  const definitions = project.scheme.dimensions;
  if (definitions.length !== 7 || dimensionIds.some(id => definitions.filter(dimension => dimension.id === id).length !== 1)) errors.push('需配置且只配置 A–G 七个一级维度');
  if (definitions.some(dimension => !Number.isFinite(dimension.weight) || dimension.weight < 0) || Math.abs(definitions.reduce((sum, dimension) => sum + dimension.weight, 0) - 100) > 1e-8) errors.push('维度权重必须为非负有限数且总和为 100%');
  if (new Set(project.scheme.tags.map(tag => tag.code)).size !== project.scheme.tags.length) errors.push('问题标签编码不可重复');
  for (const tag of project.scheme.tags) {
    if (!filled(tag.code) || !definitions.some(dimension => dimension.id === tag.dimension) || !severities.includes(tag.severity)) errors.push(`问题标签定义无效：${tag.code}`);
    if (tag.code === 'F-01' && tag.severity !== 'P0') errors.push('F-01 的默认严重等级必须为 P0');
  }
  if (!project.rulesConfirmed) errors.push('正式发布前须确认评测规则');
  return unique(errors);
}

function metric(values: number[], expected: number, reasons: string[] = []): Metric {
  return { value: average(values), complete: expected > 0 && values.length === expected, n: values.length, expected, reasons: unique(reasons) };
}

function scoreTags(project: Project, assignments: TagAssignment[], dimension: DimensionId): number {
  const applicable = assignments.filter(assignment => project.scheme.tags.find(tag => tag.code === assignment.code)?.dimension === dimension);
  return dimensionScore(applicable.map(tag => tag.severity), true)!;
}

function walkthroughError(project: Project, walkthrough: Walkthrough): string[] {
  const reasons = tagErrors(project, walkthrough.tags, ['D']);
  if (walkthrough.steps === null || !Number.isSafeInteger(walkthrough.steps) || walkthrough.steps < 0) reasons.push('操作步数未完整记录');
  reasons.push(...ratingErrors(project.scheme, walkthrough.ratings, ['D'], isAnchorMode(project.scheme)));
  if (!walkthrough.completed && !walkthrough.tags.length) reasons.push('未完成的走查必须记录对应 D 标签');
  return reasons;
}

type ProductState = {
  product: Product; result: ProductResult; allComplete: boolean; checksComplete: boolean;
  speedScore: number | null; costScore: number | null;
  speedReasons: string[]; costReasons: string[];
};

function rankValues(values: { id: string; value: number }[], ties: Project['scheme']['policies']['rankingTies']): Map<string, number> | null {
  const ordered = [...new Set(values.map(item => item.value))].sort((left, right) => left - right);
  if (ties === 'unresolved' && ordered.length !== values.length) return null;
  return new Map(values.map(item => [item.id, Math.max(1, 5 - ordered.indexOf(item.value))]));
}

function scoreEfficiencyPeers(project: Project, states: ProductState[]): void {
  if (!states.length) return;
  if (states.every(state => state.allComplete && state.result.meanSeconds !== null)) {
    const ranks = rankValues(states.map(state => ({ id: state.product.id, value: state.result.meanSeconds! })), project.scheme.policies.rankingTies);
    for (const state of states) {
      state.speedScore = ranks?.get(state.product.id) ?? null;
      if (!ranks) state.speedReasons.push('速度存在并列，尚未确认并列换算规则');
    }
  } else for (const state of states) state.speedReasons.push('速度排名需全部同组产品完成有效评测');

  const costReady = states.every(state => state.allComplete && state.checksComplete && state.product.totalCost !== null && Number.isFinite(state.product.totalCost) && state.product.totalCost >= 0 && (state.result.costPerUsable !== null || project.scheme.policies.zeroUsableCost === 'score-one'));
  if (!costReady) {
    for (const state of states) state.costReasons.push('成本排名需全部同组产品完成数据、费用及零可用图规则');
    return;
  }
  const ranked = states.filter(state => state.result.costPerUsable !== null);
  const ranks = rankValues(ranked.map(state => ({ id: state.product.id, value: state.result.costPerUsable! })), project.scheme.policies.rankingTies);
  for (const state of states) {
    if (state.result.costPerUsable === null && state.result.usable === 0) state.costScore = 1;
    else state.costScore = ranks?.get(state.product.id) ?? null;
    if (state.costScore === null) state.costReasons.push('单张可用图成本存在并列，尚未确认并列换算规则');
  }
}

export function summarizeProject(bundle: ProjectBundle): ProductResult[] {
  const { project, assets } = bundle;
  const planned = Number.isSafeInteger(project.expectedQuestionCount) && project.expectedQuestionCount > 0 ? project.expectedQuestionCount : 0;
  const expected = Math.max(project.questions.length, planned);
  const resolved = resolveRevisions(bundle.evaluations);
  const scoringProblems: string[] = [...validateProject(project)];
  const weights = project.scheme.dimensions;
  if (weights.length !== 7 || dimensionIds.some(id => weights.filter(dimension => dimension.id === id).length !== 1) || weights.some(dimension => !Number.isFinite(dimension.weight) || dimension.weight < 0) || Math.abs(weights.reduce((sum, dimension) => sum + dimension.weight, 0) - 100) > 1e-8) scoringProblems.push('七个维度的有效权重总和须为 100%');
  if (!project.rulesConfirmed) scoringProblems.push('评测规则尚未确认');

  const states: ProductState[] = project.products.map(product => {
    const valid: Evaluation[] = [];
    const candidates: Evaluation[] = [];
    const missing: string[] = [];
    for (const question of project.questions) {
      const key = JSON.stringify([project.id, product.id, question.id]);
      const record = resolved.latest.find(item => groupKey(item) === key);
      if (resolved.issues.has(key)) { missing.push(`题目 ${question.id}：${resolved.issues.get(key)}`); continue; }
      if (!record) { missing.push(`题目 ${question.id} 尚未提交`); continue; }
      if (record.status !== 'submitted') { missing.push(`题目 ${question.id} 的最新修订为草稿，未纳入统计`); continue; }
      if (record.schemeHash !== project.schemeHash || record.questionsHash !== project.questionsHash || !record.schemeHash || !record.questionsHash) { missing.push(`题目 ${question.id} 的规则或题库快照不匹配`); continue; }
      candidates.push(record);
      const errors = validateEvaluation(project, record, assets);
      if (errors.length) missing.push(...errors.map(error => `题目 ${question.id}：${error}`));
      else valid.push(record);
    }
    const dimensions = {} as Record<DimensionId, Metric>;
    for (const id of imageDimensions) {
      const values: number[] = [];
      let excluded = 0;
      const reasons = [...missing];
      for (const record of valid) {
        if (record.failed && !record.mediaIds.length) {
          if (project.scheme.policies.failedNoOutput === 'exclude') { excluded++; continue; }
          if (project.scheme.policies.failedNoOutput === 'score-one') values.push(1);
          else reasons.push(`题目 ${record.questionId} 失败且零输出，图像计分规则待确认`);
        } else { const value = recordDimensionScore(project.scheme, record, id); if (value !== null) values.push(value); }
      }
      if (excluded) reasons.push(`已明确排除 ${excluded} 道失败零输出题，有效分母为 ${expected - excluded}`);
      if (!values.length) reasons.push('没有可计算图像维度均分的有效题目');
      dimensions[id] = metric(values, Math.max(0, expected - excluded), reasons);
    }

    const dValues: number[] = [];
    const dReasons: string[] = [];
    for (const task of walkthroughTasks) {
      const walks = bundle.walkthroughs.filter(walk => walk.projectId === project.id && walk.productId === product.id && walk.task === task);
      if (walks.length !== 1 || walks[0].status !== 'submitted') { dReasons.push(`走查 ${task} 未提交或存在重复记录`); continue; }
      const errors = walkthroughError(project, walks[0]);
      if (errors.length) dReasons.push(...errors.map(error => `走查 ${task}：${error}`));
      else { const value = recordDimensionScore(project.scheme, walks[0], 'D'); if (value !== null) dValues.push(value); }
    }
    dimensions.D = metric(dValues, 3, dReasons);

    const experience = bundle.experiences.filter(item => item.productId === product.id);
    const experienceScore = experience.length === 1 ? experience[0].score : null;
    const validExperience = experienceScore !== null && Number.isFinite(experienceScore) && experienceScore >= 1 && experienceScore <= 5;
    const gValues = valid.flatMap(record => { const value = recordDimensionScore(project.scheme, record, 'G'); return value === null ? [] : [value]; });
    const gMean = average(gValues);
    dimensions.G = { value: gMean !== null && validExperience ? (gMean + experienceScore!) / 2 : null, complete: expected > 0 && valid.length === expected && validExperience, n: valid.length, expected, reasons: unique([...missing, ...(validExperience ? [] : ['缺少唯一有效的整体走查体验分（1–5）'])]) };

    const allMediaIds = unique(candidates.flatMap(record => record.mediaIds));
    let usable = 0;
    let infringed = 0;
    let checksComplete = true;
    let infringementComplete = true;
    for (const mediaId of allMediaIds) {
      const owners = candidates.filter(record => record.mediaIds.includes(mediaId));
      const record = owners[0];
      const checks = record.mediaChecks.filter(check => check.mediaId === mediaId);
      const check = checks[0];
      const matchingAssets = assets.filter(asset => asset.id === mediaId && asset.role === 'output' && asset.projectId === project.id && asset.productId === product.id && asset.questionId === record.questionId);
      const evidencePresent = owners.length === 1 && matchingAssets.length === 1;
      if (!evidencePresent || checks.length !== 1 || typeof check?.usable !== 'boolean' || typeof check?.infringement !== 'boolean' || (check.infringement && check.usable)) checksComplete = false;
      if (!evidencePresent || checks.length !== 1 || typeof check?.infringement !== 'boolean') infringementComplete = false;
      if (check?.infringement === true) infringed++;
      if (check?.usable === true && check?.infringement === false && evidencePresent && checks.length === 1) usable++;
    }
    const generated = allMediaIds.length;
    const usableRate = checksComplete && generated > 0 ? usable / generated : null;
    const infringementRate = infringementComplete && generated > 0 ? infringed / generated : null;
    const knownCost = product.totalCost !== null && Number.isFinite(product.totalCost) && product.totalCost >= 0;
    const costPerUsable = checksComplete && usable > 0 && knownCost ? product.totalCost! / usable : null;
    const vetoReasons: string[] = [];
    if (generated > 0 && infringed * 100 >= generated * 5) vetoReasons.push(`侵权图片达到 5% 阈值（${infringed}/${generated}）`);
    if (product.commercialUse === 'unclear' || product.commercialUse === 'forbidden') vetoReasons.push('用户协议未明确允许生成内容商用');
    const eligibility = product.demo ? 'simulated' : vetoReasons.length ? 'vetoed' : product.commercialUse === 'unreviewed' || !infringementComplete || !generated || valid.length !== expected || expected === 0 ? 'pending' : 'eligible';
    if (!checksComplete) missing.push('全部输出图片的可用性或侵权检查尚未完整');
    if (!knownCost) missing.push('产品总费用未知或无效，不能视为免费');
    if (product.commercialUse === 'unreviewed') missing.push('商用授权尚未检查');
    if (!generated) missing.push('没有输出图片，图片可用率和侵权比例无有效分母');
    const result: ProductResult = {
      productId: product.id, dimensions, total: null, submitted: valid.length, expected,
      usableRate, meanSeconds: average(valid.map(record => record.seconds!)), costPerUsable,
      generated, usable, infringementRate, eligibility, vetoReasons, missing
    };
    return { product, result, allComplete: expected > 0 && valid.length === expected, checksComplete, speedScore: null, costScore: null, speedReasons: [], costReasons: [] };
  });

  // Simulation results have their own peers and can never block or change real rankings.
  scoreEfficiencyPeers(project, states.filter(state => !state.product.demo));
  scoreEfficiencyPeers(project, states.filter(state => state.product.demo));
  for (const state of states) {
    const result = state.result;
    const rate = result.usableRate;
    const rateScore = rate === null ? null : rate >= .8 ? 5 : rate >= .6 ? 4 : rate >= .4 ? 3 : rate >= .2 ? 2 : 1;
    const reasons = unique([
      ...(state.allComplete ? [] : ['效率维度需要全部题目有效提交']),
      ...(rateScore === null ? ['可用率缺少完整检查或有效图片分母'] : []),
      ...state.speedReasons, ...state.costReasons
    ]);
    const complete = state.allComplete && rateScore !== null && state.speedScore !== null && state.costScore !== null;
    result.dimensions.E = { value: rateScore !== null && state.speedScore !== null && state.costScore !== null ? rateScore * .5 + state.speedScore * .25 + state.costScore * .25 : null, complete, n: result.submitted, expected, reasons };
    for (const id of dimensionIds) {
      const dimension = result.dimensions[id];
      if (!dimension.complete) result.missing.push(...dimension.reasons.map(reason => `${id}：${reason}`));
    }
    result.missing = unique([...result.missing, ...scoringProblems]);
    if (!scoringProblems.length && dimensionIds.every(id => result.dimensions[id].complete && result.dimensions[id].value !== null)) {
      result.total = weights.reduce((sum, dimension) => sum + result.dimensions[dimension.id as DimensionId].value! * dimension.weight / 100, 0);
    }
  }
  return states.map(state => state.result);
}
