import type { Asset, AssetMetadata, Evaluation, Project, ProjectBundle, ReferenceRevision } from '../core/model.ts';
import { bulkImageImportFingerprint, planBulkImageImport, type BulkImageImportOptions, type BulkImageImportSummary } from '../core/bulkImageImport.ts';
import { digest, openDatabase } from './projects.ts';
import { PROJECT_TRASH_MESSAGE, PROJECT_TRASH_STORE } from './projectAccess.ts';

function signature(bytes: Uint8Array, mime: string): boolean {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  return mime === 'image/png' ? bytes[0] === 137 && ascii(1, 4) === 'PNG'
    : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mime === 'image/webp' ? ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
        : mime === 'image/gif' && ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
}

/** Validate all bytes first; then re-plan and append everything in one CAS-protected transaction. */
export async function importBulkImages(expected: ProjectBundle, input: Asset[], options: BulkImageImportOptions = {}): Promise<BulkImageImportSummary> {
  const fingerprint = bulkImageImportFingerprint(expected);
  const projectId = expected.project.id;
  const assets = input.map(asset => ({ ...asset }));
  const settings = { replaceReferences: options.replaceReferences === true };
  const preflight = planBulkImageImport(expected, assets, settings);
  if (preflight.blockers.length) throw new Error(preflight.blockers.join('；'));
  for (const asset of assets) {
    if (!(asset.blob instanceof Blob) || asset.blob.size !== asset.size || asset.blob.type !== asset.mime) throw new Error(`图片大小或格式校验失败：${asset.name}，未导入任何图片`);
    const bytes = await asset.blob.arrayBuffer();
    if (!signature(new Uint8Array(bytes), asset.mime) || await digest(bytes) !== asset.sha256) throw new Error(`图片内容或 SHA-256 校验失败：${asset.name}，未导入任何图片`);
  }
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['projects', 'evaluations', 'assets', 'blobs', 'referenceRevisions', PROJECT_TRASH_STORE], 'readwrite');
    let failure: Error | undefined;
    let summary: BulkImageImportSummary;
    const fail = (message: string) => { failure = new Error(message); transaction.abort(); };
    const trashed = transaction.objectStore(PROJECT_TRASH_STORE).get(projectId);
    const project = transaction.objectStore('projects').get(projectId);
    const evaluations = transaction.objectStore('evaluations').index('projectId').getAll(projectId);
    const metadata = transaction.objectStore('assets').index('projectId').getAll(projectId);
    const references = transaction.objectStore('referenceRevisions').index('projectId').getAll(projectId);
    references.onsuccess = () => {
      if (trashed.result) { fail(PROJECT_TRASH_MESSAGE); return; }
      if (!project.result) { fail('项目已不存在，请返回项目列表'); return; }
      const current: ProjectBundle = {
        project: project.result as Project, evaluations: evaluations.result as Evaluation[],
        assets: metadata.result as AssetMetadata[], referenceRevisions: references.result as ReferenceRevision[],
        walkthroughs: [], experiences: []
      };
      if (bulkImageImportFingerprint(current) !== fingerprint) {
        fail('项目、评测图片或参考图已在其他页面更新，请重新预览后导入；本次没有写入任何图片'); return;
      }
      try {
        const plan = planBulkImageImport(current, assets, settings);
        if (plan.blockers.length) { fail(plan.blockers.join('；')); return; }
        summary = plan.summary;
        for (const { blob: _blob, ...asset } of plan.assets) transaction.objectStore('assets').add(asset);
        for (const row of plan.evaluations) transaction.objectStore('evaluations').add(row);
        for (const row of plan.referenceRevisions) transaction.objectStore('referenceRevisions').add(row);
        const usedIds = new Set([...plan.evaluations.flatMap(row => row.mediaIds), ...plan.referenceRevisions.flatMap(row => row.assetIds)]);
        const retainedHashes = new Set([...current.assets, ...plan.assets].filter(asset => usedIds.has(asset.id)).map(asset => asset.sha256));
        const incomingBlobs = new Map(assets.filter(asset => retainedHashes.has(asset.sha256)).map(asset => [asset.sha256, asset.blob]));
        for (const [sha256, blob] of incomingBlobs) {
          const stored = transaction.objectStore('blobs').get(sha256);
          stored.onsuccess = () => { if (!stored.result) transaction.objectStore('blobs').add(blob, sha256); };
        }
      } catch (error) { fail(error instanceof Error ? error.message : '批量导入计划无效，未写入任何图片'); }
    };
    transaction.oncomplete = () => resolve(summary);
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('批量导入中断，全部图片保持原样'));
    transaction.onerror = () => { failure ??= transaction.error ?? new Error('批量导入失败，全部图片保持原样'); };
  });
}
