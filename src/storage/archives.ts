import type { AssetMetadata, Evaluation, Experience, Project, ProjectBundle, StageAudit, Walkthrough } from '../core/model';
import type { ArchiveInput, ArchiveRecord, ArchiveSource } from '../core/archive';
import { archiveContentHash, buildFinalArchive, readFinalArchive } from '../core/archive';
import { canonical, getAsset, openDatabase } from './projects';
import { PROJECT_TRASH_STORE, PROJECT_TRASH_MESSAGE } from './projectAccess';

const stores=['projects','evaluations','assets','walkthroughs','experiences','qualityStates','snapshots','stageReceipts'];
const read=<T,>(request:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
function requests(tx:IDBTransaction,projectId:string){
  return {
    project:tx.objectStore('projects').get(projectId),evaluations:tx.objectStore('evaluations').index('projectId').getAll(projectId),
    assets:tx.objectStore('assets').index('projectId').getAll(projectId),walkthroughs:tx.objectStore('walkthroughs').index('projectId').getAll(projectId),
    experiences:tx.objectStore('experiences').index('projectId').getAll(projectId),quality:tx.objectStore('qualityStates').get(projectId),
    snapshots:tx.objectStore('snapshots').index('projectId').getAll(projectId),audits:tx.objectStore('stageReceipts').index('projectId').getAll(projectId)
  };
}
function materialize(r:ReturnType<typeof requests>):ArchiveSource {
  const project=r.project.result as Project|undefined;if(!project)throw new Error('项目已不存在');
  const bundle:ProjectBundle={project,evaluations:r.evaluations.result as Evaluation[],assets:r.assets.result as AssetMetadata[],walkthroughs:r.walkthroughs.result as Walkthrough[],experiences:r.experiences.result as Experience[],...(r.quality.result?{quality:r.quality.result.state}:{})};
  return {bundle,snapshots:r.snapshots.result.map((row:{project:Project})=>row.project),audits:r.audits.result as StageAudit[]};
}
export async function readArchiveSource(projectId:string):Promise<ArchiveSource>{
  const db=await openDatabase(),tx=db.transaction([...stores,PROJECT_TRASH_STORE]),r=requests(tx,projectId);
  const trashed=tx.objectStore(PROJECT_TRASH_STORE).get(projectId);
  await Promise.all([...Object.values(r),trashed].map(request=>read(request)));
  if(trashed.result)throw new Error(PROJECT_TRASH_MESSAGE);return materialize(r);
}
function token(source:ArchiveSource){
  return canonical({...source,bundle:{...source.bundle,evaluations:[...source.bundle.evaluations].sort((a,b)=>a.id.localeCompare(b.id)),assets:[...source.bundle.assets].sort((a,b)=>a.id.localeCompare(b.id))},snapshots:[...source.snapshots].sort((a,b)=>a.revision-b.revision),audits:[...source.audits].sort((a,b)=>a.id.localeCompare(b.id))});
}
export async function listArchives(projectId?:string):Promise<ArchiveRecord[]>{
  const db=await openDatabase(),store=db.transaction('archives').objectStore('archives');
  const rows=await read<ArchiveRecord[]>(projectId?store.index('projectId').getAll(projectId):store.getAll());
  return rows.sort((a,b)=>b.manifest.createdAt.localeCompare(a.manifest.createdAt));
}
/** Stored archive files are append-only. All source reads are repeated in the commit transaction. */
async function persist(record:ArchiveRecord,source?:ArchiveSource):Promise<ArchiveRecord>{
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(['archives','qualitySpaces',...(source?[...stores,PROJECT_TRASH_STORE]:[])],'readwrite');
    let failure:Error|undefined,output=record;
    const abort=(message:string)=>{failure=new Error(message);tx.abort();};
    const spaces=tx.objectStore('qualitySpaces').getAll(),prior=tx.objectStore('archives').get(record.id);
    const src=source?requests(tx,record.projectId):null;
    const trashed=source?tx.objectStore(PROJECT_TRASH_STORE).get(record.projectId):null;
    const pending=[spaces,prior,...(src?Object.values(src):[]),...(trashed?[trashed]:[])];let remaining=pending.length;
    const done=()=>{if(--remaining)return;
      if(trashed?.result){abort(PROJECT_TRASH_MESSAGE);return;}
      if(spaces.result.some((space:{bundle:ProjectBundle})=>space.bundle.project.id===record.projectId)){abort('此站点已有该项目的独立评审空间，不能存入包含原评分的归档。请使用负责人浏览器配置。');return;}
      if(source&&src){try{if(token(materialize(src))!==token(source)){abort('归档生成期间项目或审计已变化，请刷新后重新生成；旧归档保持不变。');return;}}catch(error){abort(error instanceof Error?error.message:'源项目读取失败');return;}}
      if(prior.result){if(prior.result.manifest.manifestHash!==record.manifest.manifestHash){abort('归档 ID 已存在但内容不同，不能覆盖原版本。');return;}output=prior.result;return;}
      tx.objectStore('archives').add(record);
    };
    pending.forEach(request=>{request.onsuccess=done;});
    tx.oncomplete=()=>resolve(output);tx.onabort=()=>reject(failure??tx.error??new Error('归档未能保存，可能存储空间不足；工作数据未更改。'));
  });
}
export async function createArchive(projectId:string,input:ArchiveInput,expectedContentHash:string):Promise<ArchiveRecord>{
  const source=await readArchiveSource(projectId);
  if(await archiveContentHash(source.bundle)!==expectedContentHash)throw new Error('工作项目已变化，请重新打开归档页确认最新数据');
  const record=await buildFinalArchive(source,input,getAsset);
  return persist(record,source);
}
export async function inspectArchive(files:File[]){return readFinalArchive(files);}
export async function retainVerifiedArchive(inspection:Awaited<ReturnType<typeof readFinalArchive>>){
  // Re-verify the bytes supplied by the inspection, without taking UI metadata on trust.
  const checked=await readFinalArchive(inspection.record.files.map(file=>new File([file.blob],file.name)));
  return persist(checked.record);
}
