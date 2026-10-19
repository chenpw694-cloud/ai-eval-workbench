import { mergeQuality } from './quality.ts';
import type { AssetMetadata, Evaluation, Experience, Product, Project, ProjectBundle, Walkthrough } from './model.ts';

/** Structural subset of StagePackage; importing its runtime is unnecessary. */
export type StageLike = {
  packageId: string; senderId: string; kind: 'assignment' | 'submission' | 'baseline';
  productIds: string[]; bundle: ProjectBundle; snapshots: Project[];
};
export type MergeDecision = 'local' | 'incoming';
export type ProductInfo = {
  productId: string; totalCost: number | null; commercialUse: Product['commercialUse'];
  commercialEvidence: string; walkthroughs: Walkthrough[]; experience: Experience | null;
};
export type EvaluationConflict = {
  id: string; key: string; kind: 'evaluation'; label: string;
  local: Evaluation[]; incoming: Evaluation[];
  localHead: Evaluation | null; incomingHead: Evaluation;
};
export type ProductInfoConflict = {
  id: string; key: string; kind: 'product-info'; label: string;
  local: ProductInfo; incoming: ProductInfo;
};
export type MergeConflict = EvaluationConflict | ProductInfoConflict;
export type MergeCounts = {
  new: number; duplicate: number; conflicts: number; blockers: number;
  newEvaluations: number; duplicateEvaluations: number;
  newAssets: number; duplicateAssets: number;
  newProductInfos: number; duplicateProductInfos: number;
};
export type MergePlan = {
  packageId: string; senderId: string; kind: StageLike['kind'];
  local: ProjectBundle | null; incoming: ProjectBundle; merged: ProjectBundle;
  conflicts: MergeConflict[]; blockers: string[]; counts: MergeCounts;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const nonempty = (value: string) => typeof value === 'string' && value.trim().length > 0;
const evalKey = (row: Evaluation) => JSON.stringify([row.productId, row.questionId]);
const sortedById = <T extends { id: string }>(rows: T[]): T[] => [...rows].sort((left, right) => left.id.localeCompare(right.id));

function identity(project: Project): unknown {
  return {
    id: project.id, schemeHash: project.schemeHash, questionsHash: project.questionsHash,
    members: sortedById(project.members),
    products: sortedById(project.products).map(({ totalCost: _cost, commercialUse: _use, commercialEvidence: _evidence, ...product }) => product),
    questions: project.questions, expectedQuestionCount: project.expectedQuestionCount,
    rulesConfirmed: project.rulesConfirmed, scheme: project.scheme
  };
}

function normalizeBundle(bundle: ProjectBundle): ProjectBundle {
  return {
    project: structuredClone(bundle.project),
    evaluations: [...bundle.evaluations].sort((left, right) => evalKey(left).localeCompare(evalKey(right)) || left.revision - right.revision || left.id.localeCompare(right.id)),
    assets: sortedById(bundle.assets),
    walkthroughs: [...bundle.walkthroughs].sort((left, right) => left.productId.localeCompare(right.productId) || left.task.localeCompare(right.task) || left.id.localeCompare(right.id)),
    ...(bundle.quality ? {quality:structuredClone(bundle.quality)} : {}),
    experiences: [...bundle.experiences].sort((left, right) => left.productId.localeCompare(right.productId))
  };
}

function deduplicate<T extends { id: string }>(rows: T[], label: string, blockers: string[]): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const row of rows) {
    const previous = indexed.get(row.id);
    if (!nonempty(row.id)) blockers.push(`${label}存在空 ID`);
    else if (previous && !same(previous, row)) blockers.push(`${label}同 ID 内容不一致：${row.id}`);
    else indexed.set(row.id, row);
  }
  return indexed;
}

type Chain = { head: Evaluation | null; problem: string | null };
function inspectChain(rows: Evaluation[]): Chain {
  if (!rows.length) return { head: null, problem: null };
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const row of rows) {
    if (!Number.isSafeInteger(row.revision) || row.revision < 1) return { head: null, problem: '修订版本必须为正整数' };
    if (row.parentId === null) {
      if (row.revision !== 1) return { head: null, problem: '根修订版本必须为 1' };
    } else {
      const parent = byId.get(row.parentId);
      if (!parent) return { head: null, problem: `缺少父修订 ${row.parentId}` };
      if (parent.revision + 1 !== row.revision) return { head: null, problem: '父子修订版本不连续' };
    }
  }
  const roots = rows.filter(row => row.parentId === null);
  const parentIds = new Set(rows.map(row => row.parentId).filter((id): id is string => id !== null));
  const heads = rows.filter(row => !parentIds.has(row.id));
  if (roots.length !== 1 || heads.length !== 1) return { head: null, problem: '存在独立根或修订分叉' };
  const visited = new Set<string>();
  let cursor: Evaluation | undefined = heads[0];
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
  }
  return visited.size === rows.length ? { head: heads[0], problem: null } : { head: null, problem: '存在循环或未连接的修订' };
}

/** Finds the single side head, following shared ancestors through the union. */
function sideHead(side: Evaluation[], union: Evaluation[]): Evaluation | null {
  const byId = new Map(union.map(row => [row.id, row]));
  const ancestors = new Set<string>();
  for (const row of side) {
    let cursor = row.parentId;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor); ancestors.add(cursor); cursor = byId.get(cursor)?.parentId ?? null;
    }
  }
  const heads = side.filter(row => !ancestors.has(row.id));
  return heads.length === 1 ? heads[0] : null;
}

function productInfo(bundle: ProjectBundle, productId: string): ProductInfo {
  const product = bundle.project.products.find(row => row.id === productId)!;
  const storedExperience = bundle.experiences.find(row => row.productId === productId);
  return {
    productId, totalCost: product.totalCost, commercialUse: product.commercialUse,
    commercialEvidence: product.commercialEvidence,
    walkthroughs: sortedById(bundle.walkthroughs.filter(row => row.productId === productId)),
    experience: storedExperience ? { productId: storedExperience.productId, score: storedExperience.score, notes: storedExperience.notes } : null
  };
}
function emptyInfo(info: ProductInfo): boolean {
  return info.totalCost === null && info.commercialUse === 'unreviewed' && info.commercialEvidence.trim() === '' && !info.walkthroughs.length && info.experience === null;
}
function applyProductInfo(bundle: ProjectBundle, info: ProductInfo): void {
  bundle.project.products = bundle.project.products.map(product => product.id === info.productId ? {
    ...product, totalCost: info.totalCost, commercialUse: info.commercialUse, commercialEvidence: info.commercialEvidence
  } : product);
  bundle.walkthroughs = [...bundle.walkthroughs.filter(row => row.productId !== info.productId), ...structuredClone(info.walkthroughs)];
  bundle.experiences = [...bundle.experiences.filter(row => row.productId !== info.productId), ...(info.experience ? [structuredClone(info.experience)] : [])];
}

function validateBundleReferences(bundle: ProjectBundle, label: string, blockers: string[]): void {
  const { project } = bundle;
  const productIds = new Set(project.products.map(row => row.id));
  const questionIds = new Set(project.questions.map(row => row.id));
  const memberIds = new Set(project.members.map(row => row.id));
  const assetMap = deduplicate(bundle.assets, `${label}图片`, blockers);
  for (const row of bundle.assets) {
    if (row.projectId !== project.id || !questionIds.has(row.questionId) || (row.role === 'output' ? !row.productId || !productIds.has(row.productId) : row.productId !== null)) blockers.push(`${label}图片归属无效：${row.id}`);
  }
  for (const row of bundle.evaluations) {
    if (row.projectId !== project.id || !productIds.has(row.productId) || !questionIds.has(row.questionId) || (row.reviewerId !== '' && !memberIds.has(row.reviewerId))) blockers.push(`${label}评测归属无效：${row.id}`);
    if (row.mediaIds.some(id => {
      const asset = assetMap.get(id);
      return !asset || asset.role !== 'output' || asset.productId !== row.productId || asset.questionId !== row.questionId;
    })) blockers.push(`${label}评测缺少归属匹配的图片清单：${row.id}`);
  }
  for (const row of bundle.walkthroughs) if (row.projectId !== project.id || !productIds.has(row.productId)) blockers.push(`${label}走查归属无效：${row.id}`);
  for (const productId of productIds) {
    const tasks = bundle.walkthroughs.filter(row => row.productId === productId).map(row => row.task);
    if (new Set(tasks).size !== tasks.length) blockers.push(`${label}产品 ${productId} 存在重复走查任务`);
    if (bundle.experiences.filter(row => row.productId === productId).length > 1) blockers.push(`${label}产品 ${productId} 存在重复体验分`);
  }
  for (const row of bundle.experiences) if (!productIds.has(row.productId)) blockers.push(`${label}体验分归属无效：${row.productId}`);
}

export function planMerge(local: ProjectBundle | null, stage: StageLike): MergePlan {
  const incoming = structuredClone(stage.bundle);
  const base = local ? structuredClone(local) : null;
  const merged = base ? structuredClone(base) : structuredClone(incoming);
  const blockers: string[] = [];
  const conflicts: MergeConflict[] = [];
  const counts: MergeCounts = { new: 0, duplicate: 0, conflicts: 0, blockers: 0, newEvaluations: 0, duplicateEvaluations: 0, newAssets: 0, duplicateAssets: 0, newProductInfos: 0, duplicateProductInfos: 0 };
  const project = incoming.project;
  const allProductIds = project.products.map(row => row.id);
  const scope = new Set(stage.productIds);
  if (!nonempty(stage.packageId)) blockers.push('阶段包 ID 不可为空');
  if (!project.members.some(member => member.id === stage.senderId)) blockers.push('阶段包发送人不在项目成员中');
  if (!['assignment', 'submission', 'baseline'].includes(stage.kind)) blockers.push('未知阶段包类型');
  if (!stage.productIds.length || stage.productIds.length !== scope.size || stage.productIds.some(id => !allProductIds.includes(id))) blockers.push('阶段包产品范围为空、重复或无效');
  if (stage.kind !== 'submission' && !same([...scope].sort(), [...allProductIds].sort())) blockers.push('任务包和基线包必须包含全部产品范围');
  if (stage.kind === 'submission') {
    if (stage.productIds.some(id => project.products.find(product => product.id === id)?.ownerId !== stage.senderId)) blockers.push('提交包只能包含发送人负责的产品');
    if (incoming.evaluations.some(row => !scope.has(row.productId)) || incoming.walkthroughs.some(row => !scope.has(row.productId)) || incoming.experiences.some(row => !scope.has(row.productId)) || incoming.assets.some(row => row.role === 'output' && (!row.productId || !scope.has(row.productId)))) blockers.push('提交包记录或输出图片超出声明的产品范围');
  }
  if (base && !same(identity(base.project), identity(project))) blockers.push('项目 ID、身份配置、规则或题库快照不兼容，不能合并');
  validateBundleReferences(incoming, '传入', blockers);
  if (base) validateBundleReferences(base, '本机', blockers);
  const localRecords = deduplicate(base?.evaluations ?? [], '本机评测', blockers);
  const incomingRecords = deduplicate(incoming.evaluations, '传入评测', blockers);
  const localAssets = deduplicate(base?.assets ?? [], '本机图片', blockers);
  const incomingAssets = deduplicate(incoming.assets, '传入图片', blockers);
  for (const [id, row] of incomingRecords) {
    if (localRecords.has(id) && !same(localRecords.get(id), row)) blockers.push(`评测同 ID 内容不一致：${id}`);
    else if (localRecords.has(id)) counts.duplicateEvaluations++;
  }
  for (const [id, row] of incomingAssets) {
    if (localAssets.has(id) && !same(localAssets.get(id), row)) blockers.push(`图片同 ID 清单不一致：${id}`);
    else if (localAssets.has(id)) counts.duplicateAssets++;
    else counts.newAssets++;
  }
  merged.assets = [...localAssets.values(), ...[...incomingAssets.values()].filter(row => !localAssets.has(row.id))];
  const groups = new Set([...localRecords.values(), ...incomingRecords.values()].map(evalKey));
  merged.evaluations = [...localRecords.values()];
  for (const key of [...groups].sort()) {
    const localRows = [...localRecords.values()].filter(row => evalKey(row) === key);
    const incomingRows = [...incomingRecords.values()].filter(row => evalKey(row) === key);
    const rows = [...localRows, ...incomingRows.filter(row => !localRecords.has(row.id))];
    const localChain = inspectChain(localRows);
    if (localChain.problem) { blockers.push(`本机评测 ${key}：${localChain.problem}`); continue; }
    const chain = inspectChain(rows);
    if (!chain.problem) {
      if (chain.head && (chain.head.schemeHash !== project.schemeHash || chain.head.questionsHash !== project.questionsHash)) {
        blockers.push(`评测 ${key} 的最新修订规则或题库快照不匹配，不能回退采用旧提交`);
        continue;
      }
      const additions = incomingRows.filter(row => !localRecords.has(row.id));
      merged.evaluations.push(...additions);
      counts.newEvaluations += additions.length;
      continue;
    }
    // Parent references must be complete in the union before a choice can be made.
    const rowMap = new Map(rows.map(row => [row.id, row]));
    const broken = rows.find(row => row.parentId !== null && (!rowMap.has(row.parentId) || rowMap.get(row.parentId)!.revision + 1 !== row.revision));
    if (broken || rows.some(row => !Number.isSafeInteger(row.revision) || row.revision < 1 || (row.parentId === null && row.revision !== 1))) {
      blockers.push(`评测 ${key}：${chain.problem}`); continue;
    }
    const incomingHead = sideHead(incomingRows, rows);
    if (!incomingHead || !localChain.head) { blockers.push(`评测 ${key} 的单边修订链存在分叉或无法确定唯一版本`); continue; }
    if ([incomingHead, localChain.head].some(head => head.schemeHash !== project.schemeHash || head.questionsHash !== project.questionsHash)) {
      blockers.push(`评测 ${key} 的冲突最新修订规则或题库快照不匹配`); continue;
    }
    const question = project.questions.find(row => row.id === incomingHead.questionId);
    const product = project.products.find(row => row.id === incomingHead.productId);
    conflicts.push({ id: `evaluation:${key}`, key, kind: 'evaluation', label: `${product?.name ?? incomingHead.productId} · ${question?.title ?? incomingHead.questionId}`, local: localRows, incoming: incomingRows, localHead: localChain.head, incomingHead });
  }
  for (const productId of stage.productIds) {
    if (!allProductIds.includes(productId)) continue;
    const next = productInfo(incoming, productId);
    const previous = base?.project.products.some(row => row.id === productId) ? productInfo(base, productId) : null;
    if (!previous || (emptyInfo(previous) && !emptyInfo(next))) {
      applyProductInfo(merged, next);
      if (!emptyInfo(next)) counts.newProductInfos++;
    } else if (same(previous, next)) {
      if (!emptyInfo(next)) counts.duplicateProductInfos++;
    } else if (!emptyInfo(next)) {
      const key = productId;
      conflicts.push({ id: `product-info:${key}`, key, kind: 'product-info', label: `${project.products.find(row => row.id === productId)?.name ?? productId} · 走查、费用与授权`, local: previous, incoming: next });
    }
  }
  try { const quality = mergeQuality(base?.quality, incoming.quality, merged); if(quality) merged.quality = quality; } catch(error) { blockers.push(error instanceof Error ? error.message : '质检记录合并失败'); }
  const uniqueBlockers = [...new Set(blockers)];
  counts.new = counts.newEvaluations + counts.newAssets + counts.newProductInfos;
  counts.duplicate = counts.duplicateEvaluations + counts.duplicateAssets + counts.duplicateProductInfos;
  counts.conflicts = conflicts.length;
  counts.blockers = uniqueBlockers.length;
  return { packageId: stage.packageId, senderId: stage.senderId, kind: stage.kind, local: base, incoming, merged: normalizeBundle(merged), conflicts, blockers: uniqueBlockers, counts };
}

/** Applies choices without importing a losing branch into active revision history. */
export function materializeMerge(
  plan: MergePlan, decisions: Record<string, MergeDecision>, resolverId: string,
  reason: string, newId: () => string, now: string
): ProjectBundle {
  if (plan.blockers.length) throw new Error(`阶段包不能合并：${plan.blockers.join('；')}`);
  if (plan.conflicts.length) {
    if (!nonempty(reason)) throw new Error('处理合并冲突必须填写原因');
    if (!plan.merged.project.members.some(member => member.id === resolverId)) throw new Error('冲突处理人必须是项目成员');
    if (!Number.isFinite(Date.parse(now))) throw new Error('冲突处理时间无效');
    for (const conflict of plan.conflicts) if (!['local', 'incoming'].includes(decisions[conflict.id])) throw new Error(`尚未选择冲突处理方式：${conflict.label}`);
  }
  const bundle = structuredClone(plan.merged);
  const occupiedIds = new Set([...bundle.evaluations, ...plan.incoming.evaluations].map(row => row.id));
  for (const conflict of plan.conflicts) {
    if (decisions[conflict.id] === 'local') continue;
    if (conflict.kind === 'product-info') {
      applyProductInfo(bundle, conflict.incoming);
      continue;
    }
    const head = conflict.localHead;
    const source = conflict.incomingHead;
    const id = newId();
    if (!nonempty(id) || occupiedIds.has(id)) throw new Error('新修订 ID 为空或重复，未生成合并结果');
    occupiedIds.add(id);
    const audit = `合并裁决：采用阶段包 ${plan.packageId} 的修订 ${source.id}；处理人 ${resolverId}；原因：${reason.trim()}`;
    bundle.evaluations.push({
      ...structuredClone(source), id, parentId: head?.id ?? null, revision: head ? head.revision + 1 : 1,
      reviewerId: resolverId, createdAt: now, notes: source.notes.trim() ? `${source.notes}\n\n${audit}` : audit
    });
  }
  return normalizeBundle(bundle);
}
