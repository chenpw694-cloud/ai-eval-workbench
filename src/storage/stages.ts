import type { Asset, Project, ProjectBundle, StageAudit } from '../core/model';
import { materializeMerge, planMerge } from '../core/merge';
import type { MergePlan } from '../core/merge';
import { buildStagePackage, readStagePackage } from '../core/packages';
import type { StagePackage } from '../core/packages';
import { mergeSnapshotHistory } from '../core/snapshots';
import { latestEvaluations, validateEvaluation, validateProject } from '../core/assessment';
import { canonical, getAsset, getProjectBundle, openDatabase, saveProject } from './projects';
import { PROJECT_TRASH_STORE, PROJECT_TRASH_MESSAGE } from './projectAccess';

export type StageReceipt = StageAudit;
export type StageInspection = {
  manifest: StagePackage; blobs: Map<string, Blob>; plan: MergePlan; token: string; alreadyImported: boolean;
};
type Kind = StagePackage['kind'];
const requestValue = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const storeNames = ['projects', 'snapshots', 'evaluations', 'assets', 'blobs', 'walkthroughs', 'experiences', 'stageReceipts', 'qualityStates', 'qualitySpaces', 'referenceRevisions', PROJECT_TRASH_STORE];

function readBundle(transaction: IDBTransaction, projectId: string, done: (bundle: ProjectBundle | null) => void) {
  const keys = ['evaluations', 'assets', 'walkthroughs', 'experiences'] as const;
  const projectRequest = transaction.objectStore('projects').get(projectId);
  const requests = keys.map(key => transaction.objectStore(key).index('projectId').getAll(projectId));
  const qualityRequest = transaction.objectStore('qualityStates').get(projectId);
  const referenceRequest = transaction.objectStore('referenceRevisions').index('projectId').getAll(projectId);
  let pending = 3 + requests.length;
  const loaded = () => {
    if (--pending) return;
    if (!projectRequest.result) { done(null); return; }
    const [evaluations, assets, walkthroughs, experiences] = requests.map(request => request.result);
    done({ project: projectRequest.result, evaluations, assets, walkthroughs, experiences, ...(referenceRequest.result.length ? {referenceRevisions:referenceRequest.result} : {}), ...(qualityRequest.result ? {quality:qualityRequest.result.state} : {}) });
  };
  projectRequest.onsuccess = loaded; qualityRequest.onsuccess = loaded; referenceRequest.onsuccess = loaded;
  requests.forEach(request => { request.onsuccess = loaded; });
}

function fingerprint(bundle: ProjectBundle | null): string {
  if (!bundle) return 'absent';
  return canonical({
    ...bundle,
    evaluations: [...bundle.evaluations].sort((a, b) => a.id.localeCompare(b.id)),
    assets: [...bundle.assets].sort((a, b) => a.id.localeCompare(b.id)),
    ...(bundle.referenceRevisions !== undefined ? {referenceRevisions:[...bundle.referenceRevisions].sort((a,b)=>a.id.localeCompare(b.id))} : {}),
    walkthroughs: [...bundle.walkthroughs].sort((a, b) => a.id.localeCompare(b.id)),
    experiences: [...bundle.experiences].sort((a, b) => a.productId.localeCompare(b.productId))
  });
}

export async function listStageReceipts(projectId: string): Promise<StageReceipt[]> {
  const db = await openDatabase();
  const rows = await requestValue<StageReceipt[]>(db.transaction('stageReceipts').objectStore('stageReceipts').index('projectId').getAll(projectId));
  return rows.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

export async function exportStage(projectId: string, kind: Kind, senderId: string) {
  let bundle = await getProjectBundle(projectId);
  const errors = validateProject(bundle.project);
  if (errors.length) throw new Error(`分发前请补齐配置：${errors.slice(0, 4).join('；')}`);
  if (!bundle.project.members.some(member => member.id === senderId)) throw new Error('请选择本项目中的发件人');
  const productIds = bundle.project.products.filter(product => kind !== 'submission' || product.ownerId === senderId).map(product => product.id);
  if (!productIds.length) throw new Error('这位成员没有负责的产品，无法生成初评提交包');
  if (bundle.quality?.space) throw new Error('独立评审空间不能导出完整主包');
  if (kind !== 'baseline') { const {quality: _quality, ...withoutQuality} = bundle; bundle = withoutQuality; }
  const originalProject = bundle.project;
  bundle = { ...bundle, project: { ...bundle.project, status: 'active' } };
  const scopeProject = (project: Project): Project => kind === 'submission' ? {
    ...project, products: project.products.map(product => productIds.includes(product.id) ? product : {
      ...product, totalCost: null, commercialUse: 'unreviewed', commercialEvidence: ''
    })
  } : project;
  if (kind === 'submission') {
    bundle = {
      ...bundle,
      project: scopeProject(bundle.project),
      evaluations: bundle.evaluations.filter(record => productIds.includes(record.productId)),
      assets: bundle.assets.filter(asset => asset.role === 'reference' || (asset.productId !== null && productIds.includes(asset.productId))),
      walkthroughs: bundle.walkthroughs.filter(row => productIds.includes(row.productId)),
      experiences: bundle.experiences.filter(row => productIds.includes(row.productId))
    };
  }
  if (kind === 'assignment') {
    bundle = {
      ...bundle,
      project: { ...bundle.project, products: bundle.project.products.map(product => ({ ...product, totalCost: null, commercialUse: 'unreviewed', commercialEvidence: '' })) },
      evaluations: [], assets: bundle.assets.filter(asset => asset.role === 'reference'), walkthroughs: [], experiences: []
    };
  }
  const db = await openDatabase();
  const snapshotRows = await requestValue<{ project: Project }[]>(db.transaction('snapshots').objectStore('snapshots').index('projectId').getAll(projectId));
  const snapshots = kind === 'assignment' ? [] : snapshotRows.map(row => scopeProject(row.project)).filter(project => project.revision < bundle.project.revision);
  snapshots.push(bundle.project);
  const audits = kind === 'baseline' ? await listStageReceipts(projectId) : [];
  const exported = await buildStagePackage({ bundle, snapshots, kind, senderId, productIds, audits }, getAsset);
  if (originalProject.status !== 'active') await saveProject({ ...originalProject, status: 'active' });
  // A different tab can move an already-active project to trash while packaging images.
  else await getProjectBundle(projectId);
  return exported;
}

export async function inspectStage(files: File[]): Promise<StageInspection> {
  const { manifest, blobs } = await readStagePackage(files);
  if (manifest.bundle.quality?.space) throw new Error('独立任务包或判断返回包请使用“质量控制”或“独立评审空间”入口');
  const db = await openDatabase();
  const spaces = await requestValue<{bundle:ProjectBundle}[]>(db.transaction('qualitySpaces').objectStore('qualitySpaces').getAll());
  if(spaces.some(space => space.bundle.project.id === manifest.bundle.project.id)) throw new Error('此站点已存有该项目的独立评审空间，不能接收完整主包。请在负责人的浏览器配置中汇总。');
  const exists = await requestValue<Project | undefined>(db.transaction('projects').objectStore('projects').get(manifest.bundle.project.id));
  const local = exists ? await getProjectBundle(exists.id) : null;
  const plan = planMerge(local, manifest);
  const receipts = exists ? await listStageReceipts(exists.id) : [];
  const prior = receipts.filter(receipt => receipt.packageId === manifest.packageId);
  const alreadyImported = prior.some(receipt => receipt.manifestHash === manifest.manifestHash);
  if (prior.length && !alreadyImported) plan.blockers.push('包 ID 已存在，但清单内容不同或旧收据无法确认，拒绝重复使用这个包 ID');
  const readiness = validateProject(manifest.bundle.project);
  if (readiness.length) plan.blockers.push(...readiness.map(message => `阶段包项目配置：${message}`));
  for (const record of latestEvaluations(manifest.bundle.evaluations)) {
    if (record.status === 'submitted') {
      plan.blockers.push(...validateEvaluation(manifest.bundle.project, record, manifest.bundle.assets).map(message => `阶段包 ${record.questionId}：${message}`));
    }
  }
  plan.counts.blockers = plan.blockers.length;
  if (alreadyImported) {
    plan.conflicts = [];
    plan.counts.conflicts = 0;
    plan.counts.new = plan.counts.newEvaluations = plan.counts.newAssets = plan.counts.newProductInfos = 0;
    plan.blockers = [];
    plan.counts.blockers = 0;
  }
  return { manifest, blobs, plan, token: fingerprint(local), alreadyImported };
}

export async function commitStage(inspection: StageInspection, options: {
  decisions: Record<string, 'local' | 'incoming'>; resolverId: string; reason: string;
}): Promise<{ projectId: string; duplicate: boolean }> {
  if (inspection.plan.blockers.length) throw new Error('导入检查仍有阻断项，请重新导出正确的数据包');
  const projectId = inspection.manifest.bundle.project.id;
  const now = new Date().toISOString();
  const merged = materializeMerge(inspection.plan, options.decisions, options.resolverId, options.reason, () => crypto.randomUUID(), now);
  const local = inspection.plan.local;
  merged.project = { ...merged.project, status: 'active', updatedAt: now };
  const receipt: StageReceipt = {
    id: crypto.randomUUID(), projectId,
    packageId: inspection.manifest.packageId, importedAt: now,
    manifestHash: inspection.manifest.manifestHash,
    senderId: inspection.manifest.senderId, kind: inspection.manifest.kind,
    counts: { ...inspection.plan.counts }, decisions: options.decisions,
    resolverId: options.resolverId, reason: options.reason,
    conflicts: inspection.plan.conflicts, incoming: inspection.manifest.bundle, before: local
  };
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, 'readwrite');
    let failure: Error | undefined;
    let duplicate = false;
    const abort = (message: string) => { failure = new Error(message); transaction.abort(); };
    const trashed = transaction.objectStore(PROJECT_TRASH_STORE).get(projectId);
    const spaceCheck = transaction.objectStore('qualitySpaces').getAll();
    spaceCheck.onsuccess = () => {
      if (trashed.result) { abort(PROJECT_TRASH_MESSAGE); return; }
      if ((spaceCheck.result as {bundle:ProjectBundle}[]).some(space => space.bundle.project.id === projectId)) { abort('独立评审空间不能接收完整主包，请更换浏览器配置'); return; }
      const priorReceipt = transaction.objectStore('stageReceipts').index('projectId').getAll(projectId);
      priorReceipt.onsuccess = () => {
      const prior = (priorReceipt.result as StageReceipt[]).filter(row => row.packageId === inspection.manifest.packageId);
      if (prior.length) {
        if (!prior.some(row => row.manifestHash === inspection.manifest.manifestHash)) { abort('包 ID 已存在但清单内容不同或无法确认，不能覆盖已有导入记录'); return; }
        duplicate = true;
        return;
      }
      readBundle(transaction, projectId, current => {
        if (fingerprint(current) !== inspection.token) { abort('预览后本机数据已变化，请重新选择文件并检查，当前数据未改动'); return; }
        const oldRecords = new Set(current?.evaluations.map(record => record.id));
        const oldAssets = new Set(current?.assets.map(asset => asset.id));
        const oldReferences = new Set(current?.referenceRevisions?.map(row => row.id));
        const foreignChecks = [
          ...merged.walkthroughs.map(row => ({ store: 'walkthroughs', id: row.id })),
          ...(inspection.manifest.audits ?? []).map(row => ({ store: 'stageReceipts', id: row.id }))
        ];
        const localSnapshotsRequest = transaction.objectStore('snapshots').index('projectId').getAll(projectId);
        let localSnapshots: Project[] = [];
        let pending = foreignChecks.length + 1;
        const write = () => {
          let history: ReturnType<typeof mergeSnapshotHistory>;
          try { history = mergeSnapshotHistory(localSnapshots, inspection.manifest.snapshots, merged.project, inspection.manifest.packageId); }
          catch (reason) { abort(reason instanceof Error ? reason.message : '历史快照无法合入，当前数据未改动'); return; }
          merged.project = history.project;
          transaction.objectStore('projects').put(merged.project);
          if(merged.quality) transaction.objectStore('qualityStates').put({id:projectId,state:merged.quality});
          for (const project of history.snapshots) transaction.objectStore('snapshots').add({ id: `${projectId}:${project.revision}`, projectId, project });
          for (const record of merged.evaluations) if (!oldRecords.has(record.id)) transaction.objectStore('evaluations').add(record);
          for (const asset of merged.assets) if (!oldAssets.has(asset.id)) transaction.objectStore('assets').add(asset);
          for (const row of merged.referenceRevisions ?? []) if (!oldReferences.has(row.id)) transaction.objectStore('referenceRevisions').add(row);
          for (const [hash, blob] of inspection.blobs) transaction.objectStore('blobs').put(blob, hash);
          for (const row of current?.walkthroughs ?? []) transaction.objectStore('walkthroughs').delete(row.id);
          for (const row of current?.experiences ?? []) transaction.objectStore('experiences').delete(`${projectId}:${row.productId}`);
          for (const row of merged.walkthroughs) transaction.objectStore('walkthroughs').put(row);
          for (const row of merged.experiences) transaction.objectStore('experiences').put({ ...row, projectId, id: `${projectId}:${row.productId}` });
          for (const audit of inspection.manifest.audits ?? []) transaction.objectStore('stageReceipts').put(audit);
          transaction.objectStore('stageReceipts').add(receipt);
        };
        localSnapshotsRequest.onsuccess = () => {
          localSnapshots = (localSnapshotsRequest.result as { project: Project }[]).map(row => row.project);
          if (--pending === 0) write();
        };
        foreignChecks.forEach(check => {
          const request = transaction.objectStore(check.store).get(check.id);
          request.onsuccess = () => {
            if (request.result && request.result.projectId !== projectId) { abort('导入 ID 与其他项目数据冲突，当前数据未改动'); return; }
            if (check.store === 'stageReceipts' && request.result) {
              const incoming = inspection.manifest.audits?.find(audit => audit.id === check.id);
              if (canonical(request.result) !== canonical(incoming)) { abort('历史审计记录 ID 相同但内容不同'); return; }
            }
            if (--pending === 0) write();
          };
        });
      });
      };
    };
    transaction.oncomplete = () => resolve({ projectId, duplicate });
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('合并中断，原项目数据保持不变'));
    transaction.onerror = () => { failure ??= transaction.error ?? new Error('写入失败，可能空间不足或 ID 冲突'); };
  });
}
