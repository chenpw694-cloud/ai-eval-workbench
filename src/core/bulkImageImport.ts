import type { Asset, AssetMetadata, Evaluation, ProjectBundle, ReferenceRevision } from './model.ts';
import { latestEvaluations } from './assessment.ts';
import { makeReferenceRevision, resolveReferences, validateReferenceHistory } from './references.ts';

export type BulkImageImportOptions = { replaceReferences?: boolean };
export type BulkImageImportSummary = {
  importedReferences: number; importedOutputs: number; reusedReferences: number;
  skippedDuplicates: number; affectedQuestions: number; affectedTasks: number; submittedToDraft: number;
};
export type BulkImageImportPlan = {
  assets: Asset[]; evaluations: Evaluation[]; referenceRevisions: ReferenceRevision[];
  summary: BulkImageImportSummary; warnings: string[]; blockers: string[];
};
const MAX_ASSETS = 10000;
const MAX_RECORDS = 100000;
const mimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const filled = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));
const metadata = ({ blob: _blob, ...asset }: Asset): AssetMetadata => asset;
const taskKey = (questionId: string, productId: string) => JSON.stringify([questionId, productId]);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
/** Covers all immutable records that a bulk preview depends on, regardless of IDB result order. */
export function bulkImageImportFingerprint(bundle: Pick<ProjectBundle, 'project' | 'evaluations' | 'assets' | 'referenceRevisions'>): string {
  const ordered = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return canonical({ project: bundle.project, evaluations: ordered(bundle.evaluations), assets: ordered(bundle.assets), referenceRevisions: ordered(bundle.referenceRevisions ?? []) });
}

/** Produces append-only drafts and reference bindings. No scoring, usability decisions, or writes. */
export function planBulkImageImport(
  bundle: ProjectBundle, incoming: Asset[], options: BulkImageImportOptions = {},
  makeId: () => string = () => crypto.randomUUID(), now = new Date().toISOString()
): BulkImageImportPlan {
  const plan: BulkImageImportPlan = {
    assets: [], evaluations: [], referenceRevisions: [], warnings: [], blockers: [],
    summary: { importedReferences: 0, importedOutputs: 0, reusedReferences: 0, skippedDuplicates: 0, affectedQuestions: 0, affectedTasks: 0, submittedToDraft: 0 }
  };
  const { project } = bundle;
  const block = (message: string) => { if (!plan.blockers.includes(message)) plan.blockers.push(message); };
  if (!Array.isArray(incoming) || incoming.length > MAX_ASSETS) { block('单次批量导入最多支持 10,000 张图片'); return plan; }
  if (!Number.isFinite(Date.parse(now))) { block('批量导入时间无效'); return plan; }
  if (!project.schemeHash || !project.questionsHash) { block('请先保存项目与题库，再批量导入图片'); return plan; }
  if (bundle.quality?.space) { block('独立复评空间不能批量导入主评测图片'); return plan; }
  for (const error of validateReferenceHistory(project, bundle.assets, bundle.referenceRevisions)) block(error);
  const knownAssetIds = new Set(bundle.assets.map(asset => asset.id));
  const inputIds = new Set<string>();
  const hashMetadata = new Map(bundle.assets.map(asset => [asset.sha256, { mime: asset.mime, size: asset.size }]));
  for (const asset of incoming) {
    if (!asset || !filled(asset.id) || inputIds.has(asset.id) || knownAssetIds.has(asset.id)) { block('待导入图片 ID 重复或已存在，不能覆盖历史原图'); continue; }
    inputIds.add(asset.id);
    if (asset.projectId !== project.id || !project.questions.some(question => question.id === asset.questionId) ||
      (asset.role === 'reference' ? asset.productId !== null : asset.role !== 'output' || !project.products.some(product => product.id === asset.productId))) block(`图片归属无效：${asset.name}`);
    if (!filled(asset.name) || !mimes.has(asset.mime) || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 25 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isFinite(Date.parse(asset.createdAt))) block(`图片格式、大小、名称或摘要无效：${asset.name}`);
    const sameHash = hashMetadata.get(asset.sha256);
    if (sameHash && (sameHash.mime !== asset.mime || sameHash.size !== asset.size)) block(`同一原图摘要的格式或大小不一致：${asset.name}`);
    else hashMetadata.set(asset.sha256, { mime: asset.mime, size: asset.size });
  }
  if (plan.blockers.length) return plan;
  const allIds = new Set([...knownAssetIds, ...inputIds, ...bundle.evaluations.map(row => row.id), ...(bundle.referenceRevisions ?? []).map(row => row.id)]);
  const nextId = () => {
    const id = makeId();
    if (!filled(id) || allIds.has(id)) { block('新修订 ID 无效或重复，请重新预览后再导入'); return id; }
    allIds.add(id); return id;
  };
  const changedQuestions = new Set<string>();
  const referenceGroups = new Map<string, Asset[]>();
  const outputGroups = new Map<string, Asset[]>();
  for (const asset of incoming) {
    const groups = asset.role === 'reference' ? referenceGroups : outputGroups;
    const key = asset.role === 'reference' ? asset.questionId : taskKey(asset.questionId, asset.productId!);
    groups.set(key, [...groups.get(key) ?? [], asset]);
  }
  for (const [questionId, rows] of referenceGroups) {
    const current = resolveReferences(bundle, questionId);
    if (current.errors.length) { for (const error of current.errors) block(error); continue; }
    let selected = [...current.assets];
    const byName = new Map<string, Asset>();
    for (const asset of rows) {
      const previous = byName.get(asset.name);
      if (previous) {
        if (previous.sha256 === asset.sha256) plan.summary.skippedDuplicates++;
        else block(`${questionId} 的参考图“${asset.name}”对应本批多张不同图片，请只保留一张或分别命名`);
      } else byName.set(asset.name, asset);
    }
    for (const asset of byName.values()) {
      const active = selected.find(existing => existing.name === asset.name);
      if (active?.sha256 === asset.sha256) { plan.summary.skippedDuplicates++; continue; }
      if (active && !options.replaceReferences) {
        block(`${questionId} 已有同名参考图“${asset.name}”，请明确开启“替换同名参考图”后重试`); continue;
      }
      const historical = bundle.assets.filter(existing => existing.role === 'reference' && existing.questionId === questionId && existing.productId === null && existing.name === asset.name && existing.sha256 === asset.sha256).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0];
      const chosen = historical ?? metadata(asset);
      selected = [...selected.filter(existing => existing.name !== asset.name), chosen];
      if (historical) plan.summary.reusedReferences++;
      else { plan.assets.push(asset); plan.summary.importedReferences++; }
    }
    if (!sameIds(current.assets.map(asset => asset.id), selected.map(asset => asset.id))) {
      try {
        const revision = makeReferenceRevision({ ...bundle, assets: [...bundle.assets, ...plan.assets.map(metadata)] }, questionId, selected.map(asset => asset.id), current.head?.id ?? null, nextId(), now);
        plan.referenceRevisions.push(revision); changedQuestions.add(questionId);
      } catch (error) { block(error instanceof Error ? error.message : '参考图绑定无效'); }
    }
  }
  const plannedBundle = (): ProjectBundle => ({ ...bundle, assets: [...bundle.assets, ...plan.assets.map(metadata)], referenceRevisions: [...bundle.referenceRevisions ?? [], ...plan.referenceRevisions] });
  const latest = latestEvaluations(bundle.evaluations);
  for (const [key, rows] of outputGroups) {
    const [questionId, productId] = JSON.parse(key) as [string, string];
    const previous = latest.find(row => row.questionId === questionId && row.productId === productId);
    const history = bundle.evaluations.filter(row => row.questionId === questionId && row.productId === productId);
    if (history.length && !previous) { block(`${questionId} 的评测修订存在分叉或断链，需先处理冲突`); continue; }
    if (previous && (previous.schemeHash !== project.schemeHash || previous.questionsHash !== project.questionsHash)) { block(`${questionId} 的现有评测规则或题库快照不匹配，请先处理记录`); continue; }
    const historicalOutputs = bundle.assets.filter(asset => asset.role === 'output' && asset.questionId === questionId && asset.productId === productId);
    const known = new Set(historicalOutputs.filter(asset => previous?.mediaIds.includes(asset.id)).map(asset => JSON.stringify([asset.name, asset.sha256])));
    const attachedOutputs: AssetMetadata[] = [];
    const newOutputs: Asset[] = [];
    for (const asset of rows) {
      const identity = JSON.stringify([asset.name, asset.sha256]);
      if (known.has(identity)) { plan.summary.skippedDuplicates++; continue; }
      known.add(identity);
      const historical = historicalOutputs.filter(existing => existing.name === asset.name && existing.sha256 === asset.sha256).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0];
      attachedOutputs.push(historical ?? metadata(asset));
      if (!historical) newOutputs.push(asset);
    }
    if (!attachedOutputs.length) continue;
    const references = resolveReferences(plannedBundle(), questionId);
    if (references.errors.length) { for (const error of references.errors) block(error); continue; }
    const product = project.products.find(row => row.id === productId)!;
    const base: Evaluation = previous ? structuredClone(previous) : {
      id: '', projectId: project.id, questionId, productId,
      reviewerId: project.members.some(member => member.id === product.ownerId) ? product.ownerId : '',
      revision: 0, parentId: null, status: 'draft', mediaIds: [], bestMediaId: null, mediaChecks: [],
      tags: [], seconds: null, failed: false, failureReason: '', notes: '',
      schemeHash: project.schemeHash, questionsHash: project.questionsHash, createdAt: now
    };
    const mediaIds = [...base.mediaIds, ...attachedOutputs.map(asset => asset.id)];
    if (mediaIds.length > MAX_ASSETS) { block(`${questionId} 的输出图片数量超过 10,000 张上限`); continue; }
    if (base.mediaIds.some(id => !bundle.assets.some(asset => asset.id === id && asset.role === 'output' && asset.questionId === questionId && asset.productId === productId))) { block(`${questionId} 的现有评测缺少原图，请先恢复原图`); continue; }
    const draft: Evaluation = {
      ...base, id: nextId(), parentId: previous?.id ?? null, revision: (previous?.revision ?? 0) + 1,
      status: 'draft', mediaIds, bestMediaId: base.bestMediaId ?? (mediaIds.length === 1 ? mediaIds[0] : null),
      mediaChecks: [...base.mediaChecks, ...attachedOutputs.map(asset => ({ mediaId: asset.id, usable: null, infringement: null }))],
      referenceIds: references.assets.map(asset => asset.id), createdAt: now
    };
    plan.assets.push(...newOutputs); plan.evaluations.push(draft);
    plan.summary.importedOutputs += attachedOutputs.length;
    if (previous?.status === 'submitted') plan.summary.submittedToDraft++;
    changedQuestions.add(questionId);
  }
  if (bundle.assets.length + plan.assets.length > MAX_ASSETS) block('项目图片总量将超过 10,000 张上限，请分建项目');
  if (bundle.evaluations.length + plan.evaluations.length > MAX_RECORDS || (bundle.referenceRevisions?.length ?? 0) + plan.referenceRevisions.length > MAX_RECORDS) block('项目历史修订数量超出当前恢复上限');
  plan.summary.affectedQuestions = changedQuestions.size;
  plan.summary.affectedTasks = plan.evaluations.length;
  if (plan.summary.submittedToDraft) plan.warnings.push(`将有 ${plan.summary.submittedToDraft} 条已提交评测新增草稿修订，原评分保留；新图片需逐张检查后重新提交。`);
  if (plan.referenceRevisions.length) plan.warnings.push('参考图修改对本题各产品共用，已提交记录和独立复评的原参考图快照保持不变。');
  return plan;
}
