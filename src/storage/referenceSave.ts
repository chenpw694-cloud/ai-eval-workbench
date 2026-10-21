import type { AssetMetadata, Evaluation, ProjectBundle, ReferenceRevision } from '../core/model.ts';
import { makeReferenceRevision, resolveReferences, validateReferenceHistory } from '../core/references.ts';

export type ReferenceChange = { expectedHeadId: string | null; assetIds: string[]; id?: string };

/** Pure validation repeated inside the IndexedDB write transaction, never against stale UI state. */
export function prepareReferenceSave(
  bundle: ProjectBundle,
  record: Evaluation,
  newAssets: AssetMetadata[],
  change: ReferenceChange | undefined,
  makeId: () => string,
  now: string
): { assets: AssetMetadata[]; nextReference?: ReferenceRevision } {
  const current = resolveReferences(bundle, record.questionId);
  if (current.errors.length) throw new Error(current.errors.join('；'));
  if (!Array.isArray(record.referenceIds) || record.referenceIds.some(id => typeof id !== 'string') || new Set(record.referenceIds).size !== record.referenceIds.length) {
    throw new Error('参考图快照不完整，请刷新题目后重新保存');
  }
  const used = new Set(bundle.assets.map(asset => asset.id));
  for (const asset of newAssets) {
    if (used.has(asset.id)) throw new Error('原图标识已存在，不能覆盖历史图片，请重新上传');
    used.add(asset.id);
    if (asset.projectId !== bundle.project.id || asset.questionId !== record.questionId || (asset.role === 'reference' ? asset.productId !== null : asset.role !== 'output' || asset.productId !== record.productId)) {
      throw new Error('待保存图片不属于本题或当前产品');
    }
  }
  const assets = [...bundle.assets, ...newAssets];
  const nextReference = change ? makeReferenceRevision({ ...bundle, assets }, record.questionId, change.assetIds, change.expectedHeadId, change.id ?? makeId(), now) : undefined;
  const expectedIds = nextReference?.assetIds ?? current.assets.map(asset => asset.id);
  if (record.referenceIds.length !== expectedIds.length || record.referenceIds.some(id => !expectedIds.includes(id))) {
    throw new Error('参考图已在其他页面修改，请刷新题目后确认当前参考图，原记录保持不变');
  }
  if (record.referenceIds.some(id => !assets.some(asset => asset.id === id && asset.role === 'reference' && asset.projectId === bundle.project.id && asset.questionId === record.questionId && asset.productId === null))) {
    throw new Error('参考图快照引用了不存在或不属于本题的素材');
  }
  const errors = validateReferenceHistory(bundle.project, assets, [...bundle.referenceRevisions ?? [], ...(nextReference ? [nextReference] : [])]);
  if (errors.length) throw new Error(errors.join('；'));
  return { assets, ...(nextReference ? { nextReference } : {}) };
}
