import type { Project } from './model.ts';

type SourcedProject = Project & { sourceSnapshot?: { packageId: string; revision: number } };
export type SnapshotMerge = { snapshots: Project[]; project: Project };
const pairKey = (project: Project) => JSON.stringify([project.schemeHash, project.questionsHash]);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function validateSnapshot(project: Project, projectId: string, label: string): void {
  if (project.id !== projectId) throw new Error(`${label}项目 ID 不一致，不能合并历史快照`);
  if (!Number.isSafeInteger(project.revision) || project.revision < 1) throw new Error(`${label}快照版本号必须为正整数`);
  if (!nonempty(project.schemeHash) || !nonempty(project.questionsHash)) throw new Error(`${label}规则或题库快照摘要为空`);
  const source = (project as SourcedProject).sourceSnapshot;
  if (source !== undefined && (!source || !nonempty(source.packageId) || !Number.isSafeInteger(source.revision) || source.revision < 1)) throw new Error(`${label}快照来源信息无效`);
}

function validateHistory(history: Project[], projectId: string, label: string): void {
  const revisions = new Set<number>();
  for (const project of history) {
    validateSnapshot(project, projectId, label);
    if (revisions.has(project.revision)) throw new Error(`${label}存在重复输入快照版本号：${project.revision}`);
    revisions.add(project.revision);
  }
}

/**
 * Returns only snapshots to insert. Existing local versions are never rewritten.
 * The storage transaction owns the final insertion and current-project update.
 */
export function mergeSnapshotHistory(local: Project[], incoming: Project[], current: Project, packageId: string): SnapshotMerge {
  if (!nonempty(current.id)) throw new Error('当前项目 ID 不可为空');
  if (!nonempty(packageId)) throw new Error('来源数据包 ID 不可为空');
  validateSnapshot(current, current.id, '当前');
  validateHistory(local, current.id, '本机');
  validateHistory(incoming, current.id, '传入');
  let maximum = Math.max(current.revision, ...local.map(snapshot => snapshot.revision));
  const nextRevision = () => {
    if (maximum >= Number.MAX_SAFE_INTEGER) throw new Error('快照版本号超出安全整数范围');
    return ++maximum;
  };
  const snapshots: Project[] = [];
  if (local.length === 0) {
    // On first import, preserve every source revision (including equal hash pairs).
    snapshots.push(...structuredClone(incoming));
    maximum = Math.max(maximum, ...incoming.map(snapshot => snapshot.revision));
  } else {
    const seen = new Set(local.map(pairKey));
    for (const source of [...incoming].sort((left, right) => left.revision - right.revision)) {
      const pair = pairKey(source);
      if (seen.has(pair)) continue;
      const historical: SourcedProject = {
        ...structuredClone(source), revision: nextRevision(),
        sourceSnapshot: { packageId, revision: source.revision }
      };
      snapshots.push(historical);
      seen.add(pair);
    }
  }
  const project: Project = { ...structuredClone(current), revision: nextRevision() };
  snapshots.push(structuredClone(project));
  return { snapshots, project };
}
