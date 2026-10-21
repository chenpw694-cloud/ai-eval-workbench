import type { AssetMetadata, Project, ProjectBundle, ReferenceRevision } from './model.ts';

const filled = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const unique = (errors: string[]) => [...new Set(errors)];
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const rowKeys = ['id', 'projectId', 'questionId', 'parentId', 'revision', 'assetIds', 'createdAt'];
const questionReferences = (project: Project, assets: AssetMetadata[], questionId: string) => assets.filter(asset => asset.projectId === project.id && asset.questionId === questionId && asset.role === 'reference' && asset.productId === null);

/** Immutable history must form one complete linear chain per question. Empty selections are valid. */
export function validateReferenceHistory(project: Project, assets: AssetMetadata[], rows?: ReferenceRevision[]): string[] {
  if (rows === undefined) return [];
  if (!Array.isArray(rows) || rows.length > 100000) return ['参考图绑定修订列表无效或数量过多'];
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    if (!object(row) || Object.keys(row).length !== rowKeys.length || Object.keys(row).some(key => !rowKeys.includes(key)) || !filled(row.id) || row.projectId !== project.id || !project.questions.some(question => question.id === row.questionId) || !(row.parentId === null || filled(row.parentId)) || !Number.isSafeInteger(row.revision) || row.revision < 1 || !Array.isArray(row.assetIds) || row.assetIds.length > 10000 || row.assetIds.some(id => !filled(id)) || new Set(row.assetIds).size !== row.assetIds.length || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) {
      errors.push('参考图绑定修订字段、归属或图片列表无效');
      continue;
    }
    if (ids.has(row.id)) errors.push(`参考图绑定修订 ID 重复：${row.id}`);
    ids.add(row.id);
    for (const assetId of row.assetIds) {
      const matching = assets.filter(asset => asset.id === assetId);
      const asset = matching[0];
      if (matching.length !== 1 || !asset || asset.projectId !== project.id || asset.questionId !== row.questionId || asset.role !== 'reference' || asset.productId !== null) errors.push(`参考图绑定引用缺失或归属不匹配：${assetId}`);
    }
  }
  if (errors.length) return unique(errors);
  for (const questionId of new Set(rows.map(row => row.questionId))) {
    const history = rows.filter(row => row.questionId === questionId);
    const byId = new Map(history.map(row => [row.id, row]));
    const roots = history.filter(row => row.parentId === null);
    if (roots.length !== 1 || roots[0].revision !== 1) {
      errors.push(`${questionId} 参考图绑定修订分叉或根版本无效`);
      continue;
    }
    const parentIds = new Set<string>();
    const children = new Map<string, number>();
    for (const row of history) {
      if (row.parentId === null) continue;
      const parent = byId.get(row.parentId);
      if (!parent || parent.id === row.id || row.revision !== parent.revision + 1) errors.push(`${questionId} 参考图绑定修订链断裂或父版本无效`);
      parentIds.add(row.parentId);
      children.set(row.parentId, (children.get(row.parentId) ?? 0) + 1);
    }
    const heads = history.filter(row => !parentIds.has(row.id));
    if (heads.length !== 1 || [...children.values()].some(count => count !== 1)) {
      errors.push(`${questionId} 参考图绑定存在并发分叉，不能静默选择版本`);
      continue;
    }
    const visited = new Set<string>();
    let cursor: ReferenceRevision | undefined = heads[0];
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    if (visited.size !== history.length) errors.push(`${questionId} 参考图绑定修订存在循环或未连接记录`);
    const requiredNames = new Set(project.questions.find(question => question.id === questionId)!.referenceNames);
    const selected = heads[0].assetIds.map(id => assets.find(asset => asset.id === id)!);
    for (const name of requiredNames) if (selected.filter(asset => asset.name === name).length > 1) errors.push(`${questionId} 必需参考图槽位存在同名歧义：${name}`);
  }
  return unique(errors);
}

/** Legacy uploads have no explicit selection; use one deterministic newest asset per filename. */
export function resolveReferences(bundle: Pick<ProjectBundle, 'project' | 'assets' | 'referenceRevisions'>, questionId: string): { assets: AssetMetadata[]; head: ReferenceRevision | null; errors: string[] } {
  const errors = validateReferenceHistory(bundle.project, bundle.assets, bundle.referenceRevisions);
  if (!bundle.project.questions.some(question => question.id === questionId)) errors.push('参考图对应的题目不存在');
  if (errors.length) return { assets: [], head: null, errors: unique(errors) };
  const history = (bundle.referenceRevisions ?? []).filter(row => row.questionId === questionId);
  if (history.length) {
    const parentIds = new Set(history.map(row => row.parentId));
    const head = history.find(row => !parentIds.has(row.id))!;
    return { assets: head.assetIds.map(id => bundle.assets.find(asset => asset.id === id)!), head, errors: [] };
  }
  const byName = new Map<string, AssetMetadata>();
  const timestamp = (asset: AssetMetadata) => Number.isFinite(Date.parse(asset.createdAt)) ? Date.parse(asset.createdAt) : 0;
  for (const asset of questionReferences(bundle.project, bundle.assets, questionId).sort((a, b) => timestamp(b) - timestamp(a) || compare(a.id, b.id))) if (!byName.has(asset.name)) byName.set(asset.name, asset);
  return { assets: [...byName.values()].sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id)), head: null, errors: [] };
}

/** CAS is checked against the current question head; persistence must repeat it within its transaction. */
export function makeReferenceRevision(bundle: Pick<ProjectBundle, 'project' | 'assets' | 'referenceRevisions'>, questionId: string, assetIds: string[], expectedHeadId: string | null, id: string, now: string): ReferenceRevision {
  if (!Array.isArray(assetIds)) throw new Error('参考图绑定图片列表无效');
  const current = resolveReferences(bundle, questionId);
  if (current.errors.length) throw new Error(current.errors.join('；'));
  if ((current.head?.id ?? null) !== expectedHeadId) throw new Error('参考图已在其他页面更新，请重新打开题目后再保存');
  const revision: ReferenceRevision = { id, projectId: bundle.project.id, questionId, parentId: current.head?.id ?? null, revision: (current.head?.revision ?? 0) + 1, assetIds: [...assetIds], createdAt: now };
  const errors = validateReferenceHistory(bundle.project, bundle.assets, [...bundle.referenceRevisions ?? [], revision]);
  if (errors.length) throw new Error(errors.join('；'));
  return revision;
}
