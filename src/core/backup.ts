import { validateQuality } from './quality.ts';
import type { AssetMetadata, Evaluation, Project, ProjectBundle } from './model.ts';
import { latestEvaluations } from './assessment.ts';
import { validateJointPolicy } from './joint.ts';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const date = (value: unknown) => string(value) && Number.isFinite(Date.parse(value));
const hash = (value: unknown): value is string => string(value) && /^[a-f0-9]{64}$/.test(value);
const severities = new Set(['P0', 'P1', 'P2', 'P3']);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

function auditErrors(raw: unknown, projectId: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 1000) return ['历史审计数量无效或超过 1000 条'];
  const ids = new Set<string>();
  const validBundle = (value: unknown) => object(value) && object(value.project) && value.project.id === projectId && ['evaluations', 'assets', 'walkthroughs', 'experiences'].every(key => Array.isArray(value[key]) && (value[key] as unknown[]).length <= 100000);
  for (const audit of raw) {
    if (!object(audit) || !string(audit.id) || !audit.id || ids.has(audit.id) || audit.projectId !== projectId || !string(audit.packageId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(audit.packageId) || !(audit.manifestHash === undefined || hash(audit.manifestHash)) || !date(audit.importedAt) || !string(audit.senderId) || !['assignment', 'submission', 'baseline'].includes(String(audit.kind)) || !object(audit.counts) || Object.keys(audit.counts).length > 100 || Object.values(audit.counts).some(value => !Number.isSafeInteger(value) || Number(value) < 0) || !object(audit.decisions) || Object.keys(audit.decisions).length > 100000 || Object.values(audit.decisions).some(value => value !== 'local' && value !== 'incoming') || !string(audit.resolverId) || !string(audit.reason) || audit.reason.length > 10000 || !Array.isArray(audit.conflicts) || audit.conflicts.length > 10000 || !validBundle(audit.incoming) || !(audit.before === null || validBundle(audit.before))) return ['历史审计结构、项目归属或字段无效'];
    ids.add(audit.id);
  }
  return [];
}

export function validateBackupStructure(raw: unknown): string[] {
  const errors: string[] = [];
  const fail = (message: string) => { if (errors.length < 30) errors.push(message); };
  if (!object(raw) || raw.format !== 'eval-studio-project-backup' || raw.schemaVersion !== 1) return ['不是支持的正式项目备份，不能使用演示备份或阶段提交包恢复'];
  if (!object(raw.bundle) || !Array.isArray(raw.snapshots) || !Array.isArray(raw.blobs)) return ['备份缺少项目、快照或图片数据'];
  const bundle = raw.bundle;
  const p = bundle.project;
  if (!object(p) || !string(p.id) || !p.id || !string(p.name) || !p.name.trim() || !string(p.background) || !string(p.period) || !date(p.createdAt) || !date(p.updatedAt) || !Number.isSafeInteger(p.revision) || Number(p.revision) < 1 || !hash(p.schemeHash) || !hash(p.questionsHash) || !['draft', 'active'].includes(String(p.status)) || typeof p.rulesConfirmed !== 'boolean' || !Number.isSafeInteger(p.expectedQuestionCount) || Number(p.expectedQuestionCount) < 1) return ['项目基本字段无效'];
  if (!Array.isArray(p.members) || !Array.isArray(p.products) || !Array.isArray(p.questions) || !object(p.scheme)) return ['项目缺少成员、产品、题库或方案'];
  if (!Array.isArray(bundle.evaluations) || !Array.isArray(bundle.assets) || !Array.isArray(bundle.walkthroughs) || !Array.isArray(bundle.experiences)) return ['项目记录列表无效'];
  if (p.questions.length > 10000 || bundle.evaluations.length > 100000 || bundle.assets.length > 10000) return ['项目记录超出当前恢复上限'];
  errors.push(...auditErrors(raw.audits, p.id));

  const uniqueIds = (rows: unknown[], label: string): Set<string> => {
    const ids = new Set<string>();
    rows.forEach(row => {
      if (!object(row) || !string(row.id) || !row.id || ids.has(row.id)) fail(`${label}包含无效或重复 ID`);
      else ids.add(row.id);
    });
    return ids;
  };
  const memberIds = uniqueIds(p.members, '成员');
  const productIds = uniqueIds(p.products, '产品');
  const questionIds = uniqueIds(p.questions, '题目');
  const assetIds = uniqueIds(bundle.assets, '图片');
  const recordIds = uniqueIds(bundle.evaluations, '评测修订');
  uniqueIds(bundle.walkthroughs, '走查');

  for (const row of p.members) if (!object(row) || !string(row.name)) fail('成员名称无效');
  for (const row of p.products) {
    if (!object(row) || !string(row.name) || !string(row.version) || !string(row.ownerId) || (row.ownerId !== '' && !memberIds.has(row.ownerId)) || !['self', 'direct', 'benchmark', 'alternative'].includes(String(row.role)) || typeof row.demo !== 'boolean' || !(row.totalCost === null || (finite(row.totalCost) && row.totalCost >= 0)) || !['unreviewed', 'allowed', 'unclear', 'forbidden'].includes(String(row.commercialUse)) || !string(row.commercialEvidence)) fail('产品字段或负责人引用无效');
  }
  for (const row of p.questions) {
    if (!object(row) || !['title', 'scene', 'category', 'difficulty', 'request'].every(key => string(row[key])) || !Array.isArray(row.acceptance) || !row.acceptance.every(string) || !Array.isArray(row.referenceNames) || !row.referenceNames.every(string) || !object(row.fields) || !Object.values(row.fields).every(string)) fail('题目字段无效');
  }
  const scheme = p.scheme;
  if (!string(scheme.id) || !string(scheme.name) || !string(scheme.version) || !Array.isArray(scheme.dimensions) || !Array.isArray(scheme.tags) || !object(scheme.policies)) return [...errors, '评分方案结构无效'];
  const dimensionIds = uniqueIds(scheme.dimensions, '维度');
  if (scheme.jointReview !== undefined) errors.push(...validateJointPolicy(scheme.jointReview as import('./joint.ts').JointPolicy));
  if (scheme.dimensions.some(row => !object(row) || !string(row.name) || !string(row.method) || !finite(row.weight) || row.weight < 0 || row.weight > 100)) fail('维度字段或权重无效');
  const codes = new Set<string>();
  for (const row of scheme.tags) {
    if (!object(row) || !string(row.code) || codes.has(row.code) || !string(row.name) || !string(row.dimension) || !dimensionIds.has(row.dimension) || !severities.has(String(row.severity))) fail('标签编码、维度或等级无效');
    else codes.add(row.code);
  }
  if (!['unresolved', 'score-one', 'exclude'].includes(String(scheme.policies.failedNoOutput)) || !['unresolved', 'dense'].includes(String(scheme.policies.rankingTies)) || !['unresolved', 'score-one'].includes(String(scheme.policies.zeroUsableCost))) fail('评分口径选项无效');

  const blobs = new Map<string, { mime: string; data: string }>();
  for (const row of raw.blobs) {
    if (!object(row) || !hash(row.sha256) || !string(row.mime) || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(row.mime) || !string(row.data) || row.data.length > 36 * 1024 * 1024 || blobs.has(row.sha256)) fail('原图编码、格式或摘要无效');
    else blobs.set(row.sha256, { mime: row.mime, data: row.data });
  }
  const assets = bundle.assets as AssetMetadata[];
  for (const row of bundle.assets) {
    if (!object(row) || row.projectId !== p.id || !questionIds.has(String(row.questionId)) || !['reference', 'output'].includes(String(row.role)) || (row.role === 'reference' ? row.productId !== null : !productIds.has(String(row.productId))) || !string(row.name) || !hash(row.sha256) || !Number.isSafeInteger(row.size) || Number(row.size) < 1 || Number(row.size) > 25 * 1024 * 1024 || !date(row.createdAt) || !blobs.has(String(row.sha256)) || blobs.get(String(row.sha256))?.mime !== row.mime) fail('图片引用、类型、大小或原图缺失');
  }
  const assignmentsValid = (tags: unknown) => Array.isArray(tags) && tags.every(tag => object(tag) && string(tag.code) && codes.has(tag.code) && severities.has(String(tag.severity)));
  for (const row of bundle.evaluations) {
    if (!object(row) || row.projectId !== p.id || !questionIds.has(String(row.questionId)) || !productIds.has(String(row.productId)) || !(memberIds.has(String(row.reviewerId)) || (row.status === 'draft' && row.reviewerId === '')) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || !(row.parentId === null || recordIds.has(String(row.parentId))) || !['draft', 'submitted'].includes(String(row.status)) || !Array.isArray(row.mediaIds) || !row.mediaIds.every(id => string(id) && assetIds.has(id)) || !(row.bestMediaId === null || (string(row.bestMediaId) && row.mediaIds.includes(row.bestMediaId))) || !Array.isArray(row.mediaChecks) || !row.mediaChecks.every(item => object(item) && row.mediaIds instanceof Array && row.mediaIds.includes(item.mediaId) && [null, true, false].includes(item.usable as null | boolean) && [null, true, false].includes(item.infringement as null | boolean)) || !assignmentsValid(row.tags) || !(row.seconds === null || (finite(row.seconds) && row.seconds >= 0)) || typeof row.failed !== 'boolean' || !string(row.failureReason) || !string(row.notes) || !date(row.createdAt) || !hash(row.schemeHash) || !hash(row.questionsHash)) fail('评测修订字段或引用无效');
    else {
      const record = row as unknown as Evaluation;
      if (record.mediaIds.some(id => !assets.some(asset => asset.id === id && asset.role === 'output' && asset.productId === record.productId && asset.questionId === record.questionId))) fail('评测引用了其他产品或题目的出图');
    }
  }
  if (errors.length === 0) {
    const records = bundle.evaluations as Evaluation[];
    for (const record of records) {
      const parent = records.find(item => item.id === record.parentId);
      if (record.parentId === null ? record.revision !== 1 : !parent || parent.productId !== record.productId || parent.questionId !== record.questionId || parent.revision + 1 !== record.revision) fail('评测修订链的根版本或父版本关系无效');
    }
    const groups = new Set(records.map(record => JSON.stringify([record.projectId, record.productId, record.questionId])));
    if (latestEvaluations(records).length !== groups.size) fail('评测修订链存在分叉、循环或断裂，不能恢复');
  }
  for (const row of bundle.walkthroughs) {
    if (!object(row) || row.projectId !== p.id || !productIds.has(String(row.productId)) || !['background', 'color', 'expand'].includes(String(row.task)) || !['draft', 'submitted'].includes(String(row.status)) || typeof row.completed !== 'boolean' || !(row.steps === null || (Number.isSafeInteger(row.steps) && Number(row.steps) >= 0)) || !assignmentsValid(row.tags) || !string(row.notes)) fail('走查记录字段无效');
  }
  const experienceIds = new Set<string>();
  for (const row of bundle.experiences) {
    if (!object(row) || !string(row.productId) || !productIds.has(row.productId) || experienceIds.has(row.productId) || !(row.score === null || (Number.isInteger(row.score) && Number(row.score) >= 1 && Number(row.score) <= 5)) || !string(row.notes)) fail('整体体验分无效或重复');
    else experienceIds.add(row.productId);
  }
  const revisions = new Set<number>();
  for (const snapshot of raw.snapshots) {
    if (!object(snapshot) || snapshot.id !== p.id || !Number.isSafeInteger(snapshot.revision) || revisions.has(Number(snapshot.revision)) || !hash(snapshot.schemeHash) || !hash(snapshot.questionsHash) || !object(snapshot.scheme) || !Array.isArray(snapshot.questions)) fail('项目快照记录无效或重复');
    else revisions.add(Number(snapshot.revision));
  }
  if (!revisions.has(Number(p.revision))) fail('备份缺少当前项目快照');
  const current = raw.snapshots.find(snapshot => object(snapshot) && snapshot.revision === p.revision);
  if (current && canonical(current) !== canonical(p)) fail('当前项目快照内容与项目不一致');
  try { errors.push(...validateQuality(bundle.quality, bundle as unknown as ProjectBundle)); } catch { errors.push('质检数据结构无效'); }
  return [...new Set(errors)];
}

export function isFormalBundle(value: unknown): value is ProjectBundle {
  return object(value) && object(value.project) && Array.isArray(value.evaluations) && Array.isArray(value.assets);
}

/** The same strict archive metadata checks, without encoding or loading image bytes. */
export function validateArchiveMetadata(raw: unknown): string[] {
  if (!object(raw) || !object(raw.bundle) || !Array.isArray(raw.bundle.assets) || !Array.isArray(raw.snapshots)) return ['归档缺少项目元数据或快照'];
  const byHash = new Map<unknown, { sha256: unknown; mime: unknown; data: string }>();
  for (const asset of raw.bundle.assets) {
    if (object(asset) && !byHash.has(asset.sha256)) byHash.set(asset.sha256, { sha256: asset.sha256, mime: asset.mime, data: '' });
  }
  return validateBackupStructure({
    format: 'eval-studio-project-backup', schemaVersion: 1,
    bundle: raw.bundle, snapshots: raw.snapshots, audits: raw.audits, blobs: [...byHash.values()],
  });
}
