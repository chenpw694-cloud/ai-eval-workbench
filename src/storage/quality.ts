import type { Asset, ProjectBundle } from '../core/model';
import { blindQualityBundle, emptyQuality, mergeQuality, validateQuality, validateQualityReturn } from '../core/quality';
import type { QualityState } from '../core/quality';
import { validateQualityExtension } from '../core/quality';
import { buildStagePackage, readStagePackage } from '../core/packages';
import { canonical, getAsset, getProjectBundle, listProjects, openDatabase } from './projects';

export type ReviewSpace = { id: string; bundle: ProjectBundle; blobs: { hash: string; blob: Blob }[] };
const read = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });

export async function saveQuality(bundle: ProjectBundle, state: QualityState) {
  const errors = validateQuality(state, bundle);
  if (errors.length) throw new Error(errors.join('；'));
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['projects', 'qualityStates', 'snapshots'], 'readwrite');
    let failure: Error | undefined;
    const projectRequest = tx.objectStore('projects').get(bundle.project.id);
    const current = tx.objectStore('qualityStates').get(bundle.project.id);
    current.onsuccess = () => {
      if (canonical(current.result?.state ?? emptyQuality()) !== canonical(bundle.quality ?? emptyQuality())) {
        failure = new Error('质检数据已在其他页面更新，请重新打开后再保存'); tx.abort(); return;
      }
      const extensionErrors = validateQualityExtension(current.result?.state ?? emptyQuality(), state);
      if (extensionErrors.length) { failure = new Error(extensionErrors.join('；')); tx.abort(); return; }
      if (!projectRequest.result || projectRequest.result.revision !== bundle.project.revision || projectRequest.result.schemeHash !== bundle.project.schemeHash || projectRequest.result.questionsHash !== bundle.project.questionsHash) {
        failure = new Error('规则或题库已变化，不能保存旧口径判断'); tx.abort(); return;
      }
      tx.objectStore('qualityStates').put({ id: bundle.project.id, state });
      const project = { ...projectRequest.result, status: 'active', revision: projectRequest.result.revision + 1, updatedAt: new Date().toISOString() };
      tx.objectStore('projects').put(project);
      tx.objectStore('snapshots').add({id:`${project.id}:${project.revision}`, projectId:project.id, project});
    };
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure ?? tx.error ?? new Error('质检保存失败'));
  });
}
export async function exportIndependent(bundle: ProjectBundle, batchId: string, reviewerId: string, returning = false, loader = getAsset) {
  const projected = blindQualityBundle(bundle, batchId, reviewerId, returning);
  return buildStagePackage({ bundle: projected, snapshots: [projected.project], kind: 'baseline', senderId: reviewerId, productIds: projected.project.products.map(row => row.id) }, loader);
}
export async function listReviewSpaces(): Promise<ReviewSpace[]> {
  const db = await openDatabase();
  return read<ReviewSpace[]>(db.transaction('qualitySpaces').objectStore('qualitySpaces').getAll());
}
export async function importIndependent(files: File[]): Promise<ReviewSpace> {
  const { manifest, blobs } = await readStagePackage(files);
  const bundle = manifest.bundle;
  const space = bundle.quality?.space;
  if (!space || space.type !== 'blind' || bundle.evaluations.length || bundle.walkthroughs.length || bundle.experiences.length || manifest.audits?.length || bundle.quality!.judgments.length || bundle.quality!.decisions.length || manifest.snapshots.length !== 1 || bundle.project.products.some(row => row.totalCost !== null || row.commercialUse !== 'unreviewed' || row.commercialEvidence)) throw new Error('请导入不含原判断的独立任务包，完整主包与结果包不能进入独立空间');
  if ((await listProjects()).some(project => project.id === bundle.project.id)) throw new Error('当前浏览器站点已存有此项目的完整数据，不能在此进行独立盲评。请使用未导入完整包的浏览器配置。');
  const incoming: ReviewSpace = { id: `${bundle.project.id}:${space.batchId}:${space.reviewerId}`, bundle, blobs: [...blobs].map(([hash, blob]) => ({ hash, blob })) };
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['qualitySpaces','projects','archives'], 'readwrite');
    let output = incoming, failure: Error | undefined;
    const projectCheck = tx.objectStore('projects').get(bundle.project.id);
    projectCheck.onsuccess = () => {
      if(projectCheck.result) {failure = new Error('站点中已出现原项目，请更换独立浏览器配置');tx.abort();return;}
      const archiveCheck = tx.objectStore('archives').index('projectId').getAll(bundle.project.id);
      archiveCheck.onsuccess = () => {
      if(archiveCheck.result.length) {failure = new Error('站点已保存含原评分的项目归档，请更换独立浏览器配置');tx.abort();return;}
      const request = tx.objectStore('qualitySpaces').get(incoming.id);
      request.onsuccess = () => {
      if (request.result) {
        output = request.result;
        if (canonical(output.bundle.quality?.tasks) !== canonical(incoming.bundle.quality?.tasks)) { failure = new Error('同一独立空间的证据或任务不同，不能覆盖'); tx.abort(); }
      } else tx.objectStore('qualitySpaces').add(incoming);
      };
      };
    };
    tx.oncomplete = () => resolve(output); tx.onabort = () => reject(failure ?? tx.error ?? new Error('独立空间导入中断'));
  });
}
export async function saveReviewSpace(original: ReviewSpace, state: QualityState): Promise<ReviewSpace> {
  const errors = validateQuality(state, original.bundle);
  if (errors.length) throw new Error(errors.join('；'));
  const next = { ...original, bundle: { ...original.bundle, quality: state } };
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('qualitySpaces', 'readwrite'); let failure: Error | undefined;
    const request = tx.objectStore('qualitySpaces').get(original.id);
    request.onsuccess = () => {
      if (!request.result || canonical(request.result.bundle.quality) !== canonical(original.bundle.quality)) { failure = new Error('独立判断已更新，请重新载入'); tx.abort(); return; }
      tx.objectStore('qualitySpaces').put(next);
    };
    tx.oncomplete = () => resolve(next); tx.onabort = () => reject(failure ?? tx.error ?? new Error('独立判断保存失败'));
  });
}
export function spaceAsset(space: ReviewSpace, id: string): Promise<Asset | undefined> {
  const metadata = space.bundle.assets.find(row => row.id === id);
  const blob = space.blobs.find(row => row.hash === metadata?.sha256)?.blob;
  return Promise.resolve(metadata && blob ? { ...metadata, blob } : undefined);
}
export async function importJudgments(bundle: ProjectBundle, files: File[]): Promise<{ state: QualityState; added: number }> {
  const { manifest } = await readStagePackage(files);
  const incoming = manifest.bundle.quality;
  const local = bundle.quality ?? emptyQuality();
  const evidenceErrors = validateQualityReturn(bundle, manifest.bundle);
  if (evidenceErrors.length) throw new Error(evidenceErrors.join('；'));
  if (!incoming?.space || incoming.space.type !== 'return' || manifest.bundle.project.id !== bundle.project.id || manifest.bundle.project.schemeHash !== bundle.project.schemeHash || manifest.bundle.project.questionsHash !== bundle.project.questionsHash) throw new Error('不是当前项目、规则与题库的独立判断返回包');
  if (incoming.decisions.length || incoming.tasks.some(task => canonical(local.tasks.find(row => row.id === task.id)) !== canonical(task)) || incoming.batches.some(batch => canonical(local.batches.find(row => row.id === batch.id)) !== canonical(batch))) throw new Error('返回包修改了原任务、证据或抽样口径，拒绝合入');
  if (manifest.bundle.evaluations.length || manifest.bundle.walkthroughs.length || manifest.bundle.experiences.length || manifest.audits?.length) throw new Error('返回包包含无关评分或审计记录');
  const state = mergeQuality(local, incoming, bundle)!;
  const added = state.judgments.length - local.judgments.length;
  await saveQuality(bundle, state);
  return { state, added };
}
