import baseline from '../../schemes/ecommerce-t2i/scheme.json';
import type { Asset, AssetMetadata, Evaluation, Experience, Project, ProjectBundle, Scheme, Walkthrough, StageAudit, ReferenceRevision } from '../core/model';
import { latestEvaluations, validateEvaluation } from '../core/assessment';
import { archiveSchemaVersion, validateBackupStructure } from '../core/backup';
import { validateReferenceHistory } from '../core/references';
import { prepareReferenceSave } from './referenceSave';
import type { ReferenceChange } from './referenceSave';
export type { ReferenceChange } from './referenceSave';
import { frozenConfigurationMatches, productInfoCorrectionErrors } from '../core/projectEditing';
import { PROJECT_TRASH_STORE, PROJECT_TRASH_MESSAGE } from './projectAccess';

const DATABASE = 'eval-studio-formal-projects';
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
let connection: Promise<IDBDatabase> | undefined;

export function openDatabase(): Promise<IDBDatabase> {
  if (!connection) {
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 6);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains(PROJECT_TRASH_STORE)) db.createObjectStore(PROJECT_TRASH_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('projectId', 'projectId');
        for (const name of ['evaluations', 'assets', 'walkthroughs', 'experiences', 'referenceRevisions']) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' }).createIndex('projectId', 'projectId');
        }
        for (const name of ['qualityStates', 'qualitySpaces']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        if (!db.objectStoreNames.contains('archives')) db.createObjectStore('archives', { keyPath: 'id' }).createIndex('projectId', 'projectId');
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
        if (!db.objectStoreNames.contains('stageReceipts')) db.createObjectStore('stageReceipts', { keyPath: 'id' }).createIndex('projectId', 'projectId');
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); connection = undefined; };
        resolve(request.result);
      };
      request.onerror = () => { connection = undefined; reject(request.error); };
      request.onblocked = () => { connection = undefined; reject(new Error('请关闭旧版项目标签页后重试')); };
    });
  }
  return connection;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function digest(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function listProjects(): Promise<Project[]> {
  const db = await openDatabase();
  const transaction = db.transaction(['projects', PROJECT_TRASH_STORE]);
  const [projects, trashed] = await Promise.all([
    requestValue<Project[]>(transaction.objectStore('projects').getAll()),
    requestValue<{id: string}[]>(transaction.objectStore(PROJECT_TRASH_STORE).getAll())
  ]);
  const hidden = new Set(trashed.map(row => row.id));
  return projects.filter(project => !hidden.has(project.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createProject(name: string): Promise<Project> {
  const now = new Date().toISOString();
  const members = [1, 2, 3].map(index => ({ id: crypto.randomUUID(), name: `评测员 ${index}` }));
  const scheme: Scheme = {
    id: baseline.id, name: baseline.name, version: '0.1.0',
    dimensions: structuredClone(baseline.dimensions),
    tags: structuredClone(baseline.tags) as Scheme['tags'],
    rating: structuredClone(baseline.rating) as Scheme['rating'],
    jointReview: structuredClone(baseline.jointReview),
    policies: { failedNoOutput: 'unresolved', rankingTies: 'unresolved', zeroUsableCost: 'unresolved' }
  };
  const project: Project = {
    id: crypto.randomUUID(), name: name.trim() || '电商文生图竞品评测', background: '', period: '',
    members,
    products: members.map((member, index) => ({
      id: crypto.randomUUID(), name: '', version: '',
      role: (['direct', 'benchmark', 'alternative'] as const)[index], demo: false,
      ownerId: member.id, totalCost: null, commercialUse: 'unreviewed', commercialEvidence: ''
    })),
    questions: [], scheme, rulesConfirmed: false, expectedQuestionCount: 50,
    status: 'draft', revision: 0, createdAt: now, updatedAt: now,
    schemeHash: '', questionsHash: ''
  };
  return saveProject(project);
}

export async function saveProject(input: Project): Promise<Project> {
  const schemeHash = await digest(canonical(input.scheme));
  const questionsHash = await digest(canonical(input.questions));
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['projects', 'snapshots', 'evaluations', PROJECT_TRASH_STORE], 'readwrite');
    let failure: Error | undefined;
    let saved: Project;
    const trashed = transaction.objectStore(PROJECT_TRASH_STORE).get(input.id);
    const projects = transaction.objectStore('projects');
    const existingRequest = projects.get(input.id);
    existingRequest.onsuccess = () => {
      if (trashed.result) { failure = new Error(PROJECT_TRASH_MESSAGE); transaction.abort(); return; }
      const existing = existingRequest.result as Project | undefined;
      if (existing && input.revision !== existing.revision) {
        failure = new Error('项目已在另一个页面更新，请重新打开后再修改'); transaction.abort(); return;
      }
      const evaluations = transaction.objectStore('evaluations').index('projectId').getAll(input.id);
      evaluations.onsuccess = () => {
        const records = evaluations.result as Evaluation[];
        if (existing && (existing.status === 'active' || records.some(record => record.status === 'submitted'))) {
          const correctionErrors = productInfoCorrectionErrors(existing, input);
          if (correctionErrors.length) { failure = new Error(correctionErrors[0]); transaction.abort(); return; }
          if (!frozenConfigurationMatches(existing, input)) {
            failure = new Error('项目已开始或分发，成员和产品 ID、增删范围、真实/模拟属性、题库和评分规则已冻结；姓名、产品名称、版本、竞品角色和负责人可更正');
            transaction.abort(); return;
          }
        }
        const productIds = new Set(input.products.map(product => product.id));
        const questionIds = new Set(input.questions.map(question => question.id));
        const memberIds = new Set(input.members.map(member => member.id));
        if (records.some(record => !productIds.has(record.productId) || !questionIds.has(record.questionId) || (record.reviewerId !== '' && !memberIds.has(record.reviewerId)))) {
          failure = new Error('已有草稿引用这些产品、成员或题目，不能移除；可新建项目采用新的任务范围');
          transaction.abort(); return;
        }
        saved = { ...input, schemeHash, questionsHash, revision: (existing?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
        projects.put(saved);
        transaction.objectStore('snapshots').put({ id: `${saved.id}:${saved.revision}`, projectId: saved.id, project: saved });
      };
    };
    transaction.oncomplete = () => resolve(saved);
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('项目保存中断'));
    transaction.onerror = () => { failure ??= transaction.error ?? new Error('项目保存失败'); };
  });
}

export async function getProjectBundle(projectId: string, options: { includeTrashed?: boolean } = {}): Promise<ProjectBundle> {
  const db = await openDatabase();
  const transaction = db.transaction(['projects', 'evaluations', 'assets', 'walkthroughs', 'experiences', 'qualityStates', 'referenceRevisions', PROJECT_TRASH_STORE]);
  const [project, evaluations, assets, walkthroughs, experiences, qualityRow, referenceRevisions, trashed] = await Promise.all([
    requestValue<Project | undefined>(transaction.objectStore('projects').get(projectId)),
    requestValue<Evaluation[]>(transaction.objectStore('evaluations').index('projectId').getAll(projectId)),
    requestValue<AssetMetadata[]>(transaction.objectStore('assets').index('projectId').getAll(projectId)),
    requestValue<Walkthrough[]>(transaction.objectStore('walkthroughs').index('projectId').getAll(projectId)),
    requestValue<Experience[]>(transaction.objectStore('experiences').index('projectId').getAll(projectId)),
    requestValue<{id:string; state:import('../core/quality').QualityState}|undefined>(transaction.objectStore('qualityStates').get(projectId)),
    requestValue<ReferenceRevision[]>(transaction.objectStore('referenceRevisions').index('projectId').getAll(projectId)),
    requestValue<{id: string}|undefined>(transaction.objectStore(PROJECT_TRASH_STORE).get(projectId))
  ]);
  if (!project) throw new Error('未找到该项目，请选择本机项目或恢复备份');
  if (trashed && !options.includeTrashed) throw new Error(PROJECT_TRASH_MESSAGE);
  return { project, evaluations, assets, walkthroughs, experiences, ...(qualityRow ? { quality: qualityRow.state } : {}), ...(referenceRevisions.length ? { referenceRevisions } : {}) };
}

export async function getAsset(id: string): Promise<Asset | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(['assets', 'blobs']);
  return new Promise((resolve, reject) => {
    const metadata = transaction.objectStore('assets').get(id);
    metadata.onsuccess = () => {
      if (!metadata.result) { resolve(undefined); return; }
      const blob = transaction.objectStore('blobs').get(metadata.result.sha256);
      blob.onsuccess = () => resolve(blob.result ? { ...metadata.result, blob: blob.result } : undefined);
      blob.onerror = () => reject(blob.error);
    };
    metadata.onerror = () => reject(metadata.error);
  });
}

function imageSignature(bytes: Uint8Array, mime: string): boolean {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  return mime === 'image/png' ? bytes[0] === 137 && ascii(1, 4) === 'PNG'
    : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mime === 'image/webp' ? ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
    : mime === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(ascii(0, 6)) : false;
}

export async function createAsset(file: File, metadata: Pick<Asset, 'projectId' | 'questionId' | 'productId' | 'role'>): Promise<Asset> {
  const mime = file.type === 'image/jpg' ? 'image/jpeg' : file.type;
  if (!IMAGE_TYPES.has(mime) || file.size <= 0 || file.size > 25 * 1024 * 1024) {
    throw new Error('原图须为 PNG、JPEG、WebP 或 GIF，且每张不超过 25 MB');
  }
  const bytes = await file.arrayBuffer();
  if (!imageSignature(new Uint8Array(bytes), mime)) throw new Error(`${file.name} 的内容与图片类型不符`);
  return {
    ...metadata, id: crypto.randomUUID(), name: file.name, mime, size: file.size,
    sha256: await digest(bytes), blob: file.slice(0, file.size, mime), createdAt: new Date().toISOString()
  };
}

export async function saveEvaluation(projectId: string, record: Evaluation, newAssets: Asset[], referenceChange?: ReferenceChange): Promise<void> {
  const db = await openDatabase();
  for (const asset of newAssets) {
    if (asset.projectId !== projectId || asset.questionId !== record.questionId || (asset.role === 'reference' ? asset.productId !== null : asset.productId !== record.productId) || asset.blob.size !== asset.size || !IMAGE_TYPES.has(asset.mime) || await digest(await asset.blob.arrayBuffer()) !== asset.sha256) {
      throw new Error('图片校验失败，未写入评测记录');
    }
  }
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['projects', 'evaluations', 'assets', 'blobs', 'referenceRevisions', PROJECT_TRASH_STORE], 'readwrite');
    let failure: Error | undefined;
    const trashed = transaction.objectStore(PROJECT_TRASH_STORE).get(projectId);
    const projects = transaction.objectStore('projects').get(projectId);
    projects.onsuccess = () => {
      if (trashed.result) { failure = new Error(PROJECT_TRASH_MESSAGE); transaction.abort(); return; }
      const project = projects.result as Project | undefined;
      if (!project || record.projectId !== projectId || record.schemeHash !== project.schemeHash || record.questionsHash !== project.questionsHash) {
        failure = new Error('项目规则或题库已变化，请重新打开题目确认后保存'); transaction.abort(); return;
      }
      const records = transaction.objectStore('evaluations').index('projectId').getAll(projectId);
      records.onsuccess = () => {
        const revisions = records.result as Evaluation[];
        const existing = latestEvaluations(revisions).find(item => item.questionId === record.questionId && item.productId === record.productId);
        const matching = revisions.filter(item => item.questionId === record.questionId && item.productId === record.productId);
        if ((matching.length > 0 && !existing) || (record.parentId ?? null) !== (existing?.id ?? null) || record.revision !== (existing?.revision ?? 0) + 1 || revisions.some(item => item.id === record.id)) {
          failure = new Error('评测记录已在另一个页面更新，请重新打开题目，不能覆盖原记录'); transaction.abort(); return;
        }
        const metadata = transaction.objectStore('assets').index('projectId').getAll(projectId);
        const references = transaction.objectStore('referenceRevisions').index('projectId').getAll(projectId);
        references.onsuccess = () => {
          const persistedAssets = metadata.result as AssetMetadata[];
          const referenceRevisions = references.result as ReferenceRevision[];
          const abort = (message: string) => { failure = new Error(message); transaction.abort(); };
          const currentBundle: ProjectBundle = { project, evaluations: revisions, assets: persistedAssets, walkthroughs: [], experiences: [], referenceRevisions };
          let prepared: ReturnType<typeof prepareReferenceSave>;
          try {
            prepared = prepareReferenceSave(currentBundle, record, newAssets.map(({ blob, ...asset }) => asset), referenceChange, () => crypto.randomUUID(), new Date().toISOString());
          } catch (reason) { abort(reason instanceof Error ? reason.message : '参考图绑定已变化，请刷新后重试'); return; }
          const { assets, nextReference } = prepared;
          if (record.status === 'submitted') {
            const errors = validateEvaluation(project, record, assets, { scope: 'task' });
            if (errors.length) { abort(errors.join('；')); return; }
          }
          if (record.mediaIds.some(id => !assets.some(asset => asset.id === id && asset.role === 'output' && asset.questionId === record.questionId && asset.productId === record.productId))) {
            abort('记录引用了尚未保存或不属于本题产品的原图'); return;
          }
          for (const { blob, ...asset } of newAssets) {
            // Assets and their bytes are immutable, including superseded reference images.
            transaction.objectStore('assets').add(asset);
            transaction.objectStore('blobs').put(blob, asset.sha256);
          }
          if (nextReference) transaction.objectStore('referenceRevisions').add(nextReference);
          transaction.objectStore('evaluations').add(record);
        };
      };
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('保存中断，原记录保持不变'));
    transaction.onerror = () => { failure ??= transaction.error ?? new Error('保存失败'); };
  });
}

export async function saveWalkthroughs(projectId: string, walkthroughs: Walkthrough[], experiences: Experience[]): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['projects', 'walkthroughs', 'experiences', PROJECT_TRASH_STORE], 'readwrite');
    let failure: Error | undefined;
    const trashed = transaction.objectStore(PROJECT_TRASH_STORE).get(projectId);
    const project = transaction.objectStore('projects').get(projectId);
    project.onsuccess = () => {
      if (trashed.result || !project.result) {
        failure = new Error(trashed.result ? PROJECT_TRASH_MESSAGE : '未找到该项目'); transaction.abort(); return;
      }
      for (const item of walkthroughs) transaction.objectStore('walkthroughs').put({ ...item, projectId });
      for (const item of experiences) transaction.objectStore('experiences').put({ ...item, projectId, id: `${projectId}:${item.productId}` });
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('走查保存失败'));
  });
}

export type FormalBackup = {
  format: 'eval-studio-project-backup'; schemaVersion: 1 | 2 | 3; exportedAt: string;
  bundle: ProjectBundle; snapshots: Project[];
  blobs: { sha256: string; mime: string; data: string }[];
  audits?: StageAudit[];
};

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function exportProject(projectId: string): Promise<FormalBackup> {
  const bundle = await getProjectBundle(projectId, { includeTrashed: true });
  const uniqueAssets = [...new Map(bundle.assets.map(asset => [asset.sha256, asset])).values()];
  const bytes = uniqueAssets.reduce((total, asset) => total + asset.size, 0);
  if (bytes > 75 * 1024 * 1024) throw new Error('当前 JSON 完整备份适用于 75 MB 内的项目；请保留原图，下一阶段将提供 ZIP 分包');
  const db = await openDatabase();
  const snapshots = await requestValue<{ project: Project }[]>(db.transaction('snapshots').objectStore('snapshots').index('projectId').getAll(projectId));
  const blobs: FormalBackup['blobs'] = [];
  for (const asset of uniqueAssets) {
    const sha256 = asset.sha256;
    const raw = await getAsset(asset.id);
    if (!raw) throw new Error(`缺少原图：${asset.name}，备份未导出`);
    if (await digest(await raw.blob.arrayBuffer()) !== sha256) throw new Error(`原图校验失败：${asset.name}`);
    blobs.push({ sha256, mime: asset.mime, data: await toBase64(raw.blob) });
  }
  const audits = await requestValue<StageAudit[]>(db.transaction('stageReceipts').objectStore('stageReceipts').index('projectId').getAll(projectId));
  return { format: 'eval-studio-project-backup', schemaVersion: archiveSchemaVersion(bundle, audits), exportedAt: new Date().toISOString(), bundle, snapshots: snapshots.map(item => item.project), blobs, audits };
}

export async function restoreProject(raw: unknown): Promise<Project> {
  const errors = validateBackupStructure(raw);
  if (errors.length) throw new Error(errors.join('；'));
  const backup = raw as FormalBackup;
  const bundle = backup.bundle;
  if (bundle.quality?.space) throw new Error('独立任务包不能作为完整项目恢复');
  const referenceErrors = validateReferenceHistory(bundle.project, bundle.assets, bundle.referenceRevisions);
  if (referenceErrors.length) throw new Error(referenceErrors.join('；'));
  if (await digest(canonical(bundle.project.scheme)) !== bundle.project.schemeHash || await digest(canonical(bundle.project.questions)) !== bundle.project.questionsHash) {
    throw new Error('规则或题库快照摘要不匹配，未导入');
  }
  for (const snapshot of backup.snapshots) {
    if (await digest(canonical(snapshot.scheme)) !== snapshot.schemeHash || await digest(canonical(snapshot.questions)) !== snapshot.questionsHash) {
      throw new Error(`项目修订 ${snapshot.revision} 的历史规则或题库摘要不匹配，未导入`);
    }
  }
  const restoredBlobs = new Map<string, Blob>();
  for (const item of backup.blobs) {
    let text: string;
    try { text = atob(item.data); } catch { throw new Error('备份中的图片编码无效'); }
    const bytes = Uint8Array.from(text, char => char.charCodeAt(0));
    if (!imageSignature(bytes, item.mime) || await digest(bytes.buffer) !== item.sha256) throw new Error('备份图片内容或 SHA-256 校验失败');
    const blob = new Blob([bytes], { type: item.mime });
    if (bundle.assets.some(asset => asset.sha256 === item.sha256 && (asset.size !== blob.size || asset.mime !== blob.type))) throw new Error('图片大小或格式与清单不一致');
    restoredBlobs.set(item.sha256, blob);
  }
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['projects', 'snapshots', 'evaluations', 'assets', 'blobs', 'walkthroughs', 'experiences', 'stageReceipts', 'qualityStates', 'qualitySpaces', 'referenceRevisions', PROJECT_TRASH_STORE], 'readwrite');
    let failure: Error | undefined;
    const trashed = transaction.objectStore(PROJECT_TRASH_STORE).get(bundle.project.id);
    const spaceCheck = transaction.objectStore('qualitySpaces').getAll();
    spaceCheck.onsuccess = () => {
      if (trashed.result) { failure = new Error(PROJECT_TRASH_MESSAGE); transaction.abort(); return; }
      if (spaceCheck.result.some((space: {bundle:ProjectBundle}) => space.bundle.project.id === bundle.project.id)) { failure = new Error('独立评审空间不能恢复完整主包，请更换浏览器配置'); transaction.abort(); return; }
      const existing = transaction.objectStore('projects').get(bundle.project.id);
      existing.onsuccess = () => {
      if (existing.result) {
        failure = new Error('本机已有同 ID 项目。此版本只恢复到不存在的项目，不覆盖现有记录；阶段合并将在下一步实现');
        transaction.abort(); return;
      }
      transaction.objectStore('projects').add(bundle.project);
      if (bundle.quality) transaction.objectStore('qualityStates').add({id:bundle.project.id,state:bundle.quality});
      for (const audit of backup.audits ?? []) transaction.objectStore('stageReceipts').add(audit);
      for (const project of backup.snapshots) transaction.objectStore('snapshots').add({ id: `${project.id}:${project.revision}`, projectId: project.id, project });
      for (const record of bundle.evaluations) transaction.objectStore('evaluations').add(record);
      for (const reference of bundle.referenceRevisions ?? []) transaction.objectStore('referenceRevisions').add(reference);
      for (const asset of bundle.assets) transaction.objectStore('assets').add(asset);
      for (const [hash, blob] of restoredBlobs) transaction.objectStore('blobs').put(blob, hash);
      for (const item of bundle.walkthroughs) transaction.objectStore('walkthroughs').add(item);
      for (const item of bundle.experiences) transaction.objectStore('experiences').add({ ...item, projectId: bundle.project.id, id: `${bundle.project.id}:${item.productId}` });
    };
    };
    transaction.oncomplete = () => resolve(bundle.project);
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('恢复中断，本机原数据未变'));
    transaction.onerror = () => { failure ??= transaction.error ?? new Error('恢复失败'); };
  });
}
