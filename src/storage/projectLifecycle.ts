import type { Project } from '../core/model';
import { buildRestartedProject } from '../core/projectLifecycle';
import { canonical, digest, getProjectBundle, openDatabase } from './projects';
import { PROJECT_TRASH_STORE, PROJECT_TRASH_MESSAGE } from './projectAccess';
import type { ProjectTombstone } from './projectAccess';

export type TrashedProject = { project: Project; trashedAt: string };
const read = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function listTrashedProjects(): Promise<TrashedProject[]> {
  const db = await openDatabase();
  const tx = db.transaction(['projects', PROJECT_TRASH_STORE]);
  const [projects, tombstones] = await Promise.all([
    read<Project[]>(tx.objectStore('projects').getAll()),
    read<ProjectTombstone[]>(tx.objectStore(PROJECT_TRASH_STORE).getAll())
  ]);
  const byId = new Map(projects.map(project => [project.id, project]));
  return tombstones.flatMap(row => {
    const project = byId.get(row.id);
    return project ? [{ project, trashedAt: row.trashedAt }] : [];
  }).sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
}

/** No rows, snapshots or shared image blobs are deleted. */
async function setTrashed(projectId: string, trashed: boolean): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['projects', PROJECT_TRASH_STORE], 'readwrite');
    let failure: Error | undefined;
    const tombstone = tx.objectStore(PROJECT_TRASH_STORE).get(projectId);
    const project = tx.objectStore('projects').get(projectId);
    project.onsuccess = () => {
      if (!project.result) { failure = new Error('未找到该项目，请返回项目列表刷新'); tx.abort(); return; }
      if (trashed) {
        if (!tombstone.result) tx.objectStore(PROJECT_TRASH_STORE).add({ id: projectId, trashedAt: new Date().toISOString() } satisfies ProjectTombstone);
      } else tx.objectStore(PROJECT_TRASH_STORE).delete(projectId);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(failure ?? tx.error ?? new Error(trashed ? '项目未能移入回收站' : '项目恢复失败'));
  });
}
export function trashProject(projectId: string): Promise<void> { return setTrashed(projectId, true); }
export function restoreTrashedProject(projectId: string): Promise<void> { return setTrashed(projectId, false); }

export async function restartProject(projectId: string, options: { name: string; keepQuestions: boolean }): Promise<Project> {
  const source = (await getProjectBundle(projectId)).project;
  const draft = buildRestartedProject(source, options, () => crypto.randomUUID(), new Date().toISOString());
  const saved: Project = {
    ...draft, revision: 1,
    schemeHash: await digest(canonical(draft.scheme)), questionsHash: await digest(canonical(draft.questions))
  };
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['projects', 'snapshots', PROJECT_TRASH_STORE], 'readwrite');
    let failure: Error | undefined;
    const abort = (message: string) => { failure = new Error(message); tx.abort(); };
    const sourceTrash = tx.objectStore(PROJECT_TRASH_STORE).get(projectId);
    const newTrash = tx.objectStore(PROJECT_TRASH_STORE).get(saved.id);
    const collision = tx.objectStore('projects').get(saved.id);
    const current = tx.objectStore('projects').get(projectId);
    current.onsuccess = () => {
      if (sourceTrash.result) { abort(PROJECT_TRASH_MESSAGE); return; }
      if (!current.result || canonical(current.result) !== canonical(source)) { abort('原项目已在其他页面更新，请刷新后重新开始'); return; }
      if (collision.result || newTrash.result) { abort('新项目标识已存在，请重试'); return; }
      tx.objectStore('projects').add(saved);
      tx.objectStore('snapshots').add({ id: `${saved.id}:1`, projectId: saved.id, project: saved });
    };
    tx.oncomplete = () => resolve(saved);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('新建项目失败，原项目保持不变'));
  });
}
