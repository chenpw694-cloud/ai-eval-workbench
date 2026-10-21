import { isAnchorMode } from './ratings.ts';
import type { Asset, Project, ProjectBundle, StageAudit } from './model.ts';
import { buildStagePackage, hashBlob, readStagePackage } from './packages.ts';
import { buildReport, reportMarkdown } from './report.ts';
import type { Report, ReportBasis, ReportCheck, ReportVersion } from './report.ts';
import type { RatingValidationOptions } from './ratings.ts';
import { canonicalJoint } from './joint.ts';
import { latestEvaluations, validateEvaluation, validateProject } from './assessment.ts';
import { latestQuality, validateQuality } from './quality.ts';

export type ArchiveMode = 'checkpoint' | 'final';
export type ArchiveInput = { mode: ArchiveMode; basis: ReportBasis; operatorId: string; reason: string; scopeConfirmed: boolean; conclusionsConfirmed: boolean; featuresConfirmed: boolean; demo: boolean };
export type ArchiveSource = { bundle: ProjectBundle; snapshots: Project[]; audits: StageAudit[] };
export type ArchiveManifest = {
  format: 'eval-studio-final-archive'; schemaVersion: 1; archiveId: string; projectId: string; projectName: string;
  calculationVersion: 'ecommerce-v1' | 'ecommerce-anchors-v1';
  reportVersion?: ReportVersion;
  mode: ArchiveMode; basis: ReportBasis; createdAt: string; operatorId: string; reason: string; demo: boolean;
  confirmations: { scope: boolean; conclusions: boolean; features: boolean };
  scope: { realProductIds: string[]; simulatedProductIds: string[]; questionCount: number; selfConfigured: boolean };
  sourceHash: string; stageManifestHash: string; checks: ReportCheck[];
  files: { name: string; size: number; sha256: string; role: 'project' | 'media' | 'report-json' | 'report-md' }[];
  manifestHash: string;
};
export type ArchiveFile = { name: string; blob: Blob };
export type ArchiveRecord = { id: string; projectId: string; manifest: ArchiveManifest; files: ArchiveFile[] };
const MiB = 1024 * 1024;
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validConfirmations = (value: unknown): boolean => object(value) && ['scope','conclusions','features'].every(key => typeof value[key] === 'boolean');
const jsonBlob = (value: unknown) => new Blob([JSON.stringify(value)], {type:'application/json'});
export const hashValue = (value: unknown) => hashBlob(new Blob([canonicalJoint(value)]));
const sorted = <T extends {id: string}>(rows: T[]) => [...rows].sort((a,b) => a.id.localeCompare(b.id));
/** Content identity ignores local revision counters remapped during a stage restore. */
export function archiveContent(bundle: ProjectBundle): unknown {
  const {revision: _r, updatedAt: _u, sourceSnapshot: _s, ...project} = bundle.project;
  const quality = bundle.quality;
  return { ...bundle, project: {...project, products:sorted(project.products),members:sorted(project.members)},
    evaluations:sorted(bundle.evaluations),assets:sorted(bundle.assets),walkthroughs:sorted(bundle.walkthroughs),
    ...(bundle.referenceRevisions!==undefined?{referenceRevisions:sorted(bundle.referenceRevisions)}:{}),
    experiences:[...bundle.experiences].map(({productId,score,notes})=>({productId,score,notes})).sort((a,b)=>a.productId.localeCompare(b.productId)),
    ...(quality ? {quality:{...quality,batches:sorted(quality.batches),tasks:sorted(quality.tasks),judgments:sorted(quality.judgments),decisions:sorted(quality.decisions),...(quality.reportNotes?{reportNotes:sorted(quality.reportNotes)}:{})}} : {}) };
}
export const archiveContentHash = (bundle: ProjectBundle) => hashValue(archiveContent(bundle));

export function archiveReadiness(bundle: ProjectBundle, basis: ReportBasis, createdAt: string, input: Pick<ArchiveInput,'scopeConfirmed'|'featuresConfirmed'|'conclusionsConfirmed'|'demo'>, mediaVerified = false, options: RatingValidationOptions = {}) {
  const report = buildReport(bundle, basis, createdAt, input.demo, options);
  const checks = report.checks.map(check => check.id === 'media' ? {...check, passed:mediaVerified, detail:mediaVerified?'本次归档的全部原图已读取并完成 SHA-256 校验，清单与所有 ZIP 必须一起保存。':'生成归档时逐图校验；当前尚未生成完整文件组。'} : check);
  const heads = latestEvaluations(bundle.evaluations);
  const state = bundle.quality;
  const judgments = latestQuality(state?.judgments ?? [], row=>row.taskId);
  const taskKeys=(state?.tasks??[]).map(task=>canonicalJoint([task.batchId,task.questionId,task.reviewerId,task.evidence.map(e=>e.productId)]));
  const pendingQuality=(state?.tasks??[]).filter(task=>!judgments.some(row=>row.taskId===task.id&&!row.unable));
  const reviewCoverage=(state?.batches??[]).filter(batch=>['review','recheck'].includes(batch.kind)).every(batch=>bundle.project.products.filter(product=>!product.demo).every(product=>{
    const tasks=(state?.tasks??[]).filter(task=>task.batchId===batch.id&&task.evidence[0]?.productId===product.id);
    if(batch.kind==='recheck'&&!tasks.length)return true;
    const expected=batch.kind==='review'?10:bundle.project.questions.length;
    return tasks.length===expected&&new Set(tasks.map(task=>task.questionId)).size===expected;
  }));
  checks.push({id:'quality-coverage',title:'全部已分配质检任务及独立样本覆盖',passed:!pendingQuality.length&&new Set(taskKeys).size===taskKeys.length&&reviewCoverage,detail:`${pendingQuality.length} 份任务未形成有效判断；每个复评/复查批次还需包含足量的不重复题目。`});
  const staleFinals = (state?.finals ?? []).filter(ref => {
    const record = heads.find(row=>row.id===ref.baselineId),decision = state?.decisions.find(row=>row.id===ref.decisionId);
    return !record || !decision || !judgments.some(row=>row.id===decision.judgmentId);
  });
  checks.push({id:'final-source',title:'最终引用仍适用于当前记录',passed:!staleFinals.length,detail:`${staleFinals.length} 条最终引用已失效；历史裁决不能覆盖新的初评或独立判断。`});
  const unfinished = bundle.project.products.filter(product=>!product.demo).flatMap(product=>bundle.project.questions.flatMap(question=>{
    const row=heads.find(r=>r.productId===product.id&&r.questionId===question.id);
    return row&&row.status==='submitted'&&!validateEvaluation(bundle.project,row,bundle.assets,options).length?[]:[`${product.name}/${question.id}`];
  }));
  checks.push({id:'all-primary',title:'已配置真实产品的全部初评',passed:!unfinished.length,detail:unfinished.length?`${unfinished.length} 份缺失、草稿或无效初评`:'当前配置范围的真实产品全部有效提交；模拟对象仅供单独比较。'});
  checks.push({id:'scope-confirmed',title:'确认本次归档范围',passed:input.scopeConfirmed,detail:'归档仅涵盖当前配置的产品与题量；未配置自家时不声称完成原四产品 GSB 方案。'});
  checks.push({id:'features-confirmed',title:'负责人核实功能与授权检查',passed:input.featuresConfirmed,detail:'功能检查采用人工摘要，负责人需核实来源、完整性和授权依据。'});
  checks.push({id:'conclusions-confirmed',title:'负责人确认结论',passed:input.conclusionsConfirmed,detail:'确认共同讨论结果、推荐条件和局限均已记录；本地姓名选择不等于账号签名。'});
  return {report,checks,blockers:checks.filter(check=>!check.passed)};
}
function archiveReport(report: Report, manifest: Pick<ArchiveManifest,'archiveId'|'mode'|'sourceHash'|'checks'>) {
  return { ...report,format:'eval-studio-archived-report',status:manifest.mode==='final'?'final':'checkpoint',archiveId:manifest.archiveId,sourceHash:manifest.sourceHash,checks:manifest.checks,
    scope:manifest.mode==='final'?'当前配置范围的最终归档报告，模拟数据单列':'阶段快照报告，保留未完成项，不代表最终评测完成' };
}
function archivedMarkdown(report: Report, manifest: Pick<ArchiveManifest,'archiveId'|'mode'|'sourceHash'|'checks'|'reportVersion'>): string {
  const label = manifest.mode==='final'?'最终归档报告':'阶段快照报告';
  // Archives created before this field existed must retain their exact original text.
  const lines = reportMarkdown({...report,checks:manifest.checks}, manifest.reportVersion ?? 'report-v1').split('\n');
  lines[0]=`# ${report.project.name} · ${report.demo?'界面演示 · ':''}${label}`;
  lines[2]=manifest.mode==='final'?'> 本报告固定于本次归档的数据快照。后续工作项目修改不会改变这份文件；模拟对象与真实对象分别展示。':'> 阶段快照保留当前缺口，不代表最终评测完成。';
  const last=lines.findIndex(line=>line.startsWith('本文件及 JSON 明细不包含原图'));
  if(last>=0)lines[last]='原图已随本次归档的项目清单与 ZIP 分包提供；报告单独保存不能恢复项目。';
  lines.splice(4,0,`归档编号：${manifest.archiveId}`,`数据快照 SHA-256：${manifest.sourceHash}`,'');
  return lines.join('\n');
}
function validateInput(bundle: ProjectBundle, input: ArchiveInput, options: RatingValidationOptions = {}) {
  if (!['checkpoint','final'].includes(input.mode)||!['original','adjudicated-reference'].includes(input.basis)||!bundle.project.members.some(m=>m.id===input.operatorId)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>10000||['scopeConfirmed','featuresConfirmed','conclusionsConfirmed','demo'].some(key=>typeof input[key as keyof ArchiveInput]!=='boolean')) throw new Error('请选择负责人、归档类型并填写归档说明');
  if(bundle.quality?.space)throw new Error('独立评审任务不能作为完整项目归档');
  const preparation=validateProject(bundle.project);
  if(preparation.length)throw new Error(`版本归档需先完成配置并确认规则：${preparation.slice(0,4).join('；')}。配置草稿可使用项目备份保存。`);
  const qualityErrors=validateQuality(bundle.quality,bundle,options);if(qualityErrors.length)throw new Error(qualityErrors.join('；'));
}
export async function buildFinalArchive(source: ArchiveSource, input: ArchiveInput, loader: (id:string)=>Promise<Asset|undefined>, options: {archiveId?:string;now?:string;partBytes?:number}={}) : Promise<ArchiveRecord> {
  const frozen=structuredClone(source),bundle=frozen.bundle;
  validateInput(bundle,input);
  const archiveId=options.archiveId??crypto.randomUUID(),createdAt=options.now??new Date().toISOString();
  if(!identity(archiveId)||!Number.isFinite(Date.parse(createdAt)))throw new Error('归档编号或时间无效');
  const preliminary=archiveReadiness(bundle,input.basis,createdAt,input,true);
  if(input.mode==='final'&&preliminary.blockers.length)throw new Error(`暂不能最终归档：${preliminary.blockers.map(c=>c.title).join('；')}`);
  const stage=await buildStagePackage({bundle,snapshots:frozen.snapshots,audits:frozen.audits,kind:'baseline',senderId:input.operatorId,productIds:bundle.project.products.map(p=>p.id)},loader,{packageId:archiveId,now:createdAt,partBytes:options.partBytes});
  const sourceHash=await archiveContentHash(bundle);
  const checked=archiveReadiness(bundle,input.basis,createdAt,input,true);
  const manifest:ArchiveManifest={format:'eval-studio-final-archive',schemaVersion:1,calculationVersion:isAnchorMode(bundle.project.scheme)?'ecommerce-anchors-v1':'ecommerce-v1',reportVersion:'report-v2',archiveId,projectId:bundle.project.id,projectName:bundle.project.name,mode:input.mode,basis:input.basis,createdAt,operatorId:input.operatorId,reason:input.reason.trim(),demo:input.demo,
    confirmations:{scope:input.scopeConfirmed,conclusions:input.conclusionsConfirmed,features:input.featuresConfirmed},scope:{realProductIds:bundle.project.products.filter(p=>!p.demo).map(p=>p.id),simulatedProductIds:bundle.project.products.filter(p=>p.demo).map(p=>p.id),questionCount:bundle.project.questions.length,selfConfigured:bundle.project.products.some(p=>p.role==='self')},sourceHash,stageManifestHash:stage.manifest.manifestHash,checks:checked.checks,files:[],manifestHash:''};
  const reportJson=jsonBlob(archiveReport(checked.report,manifest));
  const files:ArchiveFile[]=[...stage.files,{name:`${archiveId}.report.json`,blob:reportJson},{name:`${archiveId}.report.md`,blob:new Blob([archivedMarkdown(checked.report,manifest)],{type:'text/markdown;charset=utf-8'})}];
  if(reportJson.size>20*MiB||files.at(-1)!.blob.size>2*MiB)throw new Error('报告超过当前归档上限（JSON 20 MiB / Markdown 2 MiB）');
  for(const file of files)manifest.files.push({name:file.name,size:file.blob.size,sha256:await hashBlob(file.blob),role:file.name.endsWith('.eval.json')?'project':file.name.endsWith('.zip')?'media':file.name.endsWith('.report.json')?'report-json':'report-md'});
  const {manifestHash:_hash,...unsigned}=manifest;manifest.manifestHash=await hashValue(unsigned);
  const header=jsonBlob(manifest);
  if(header.size>MiB)throw new Error('归档总清单超过 1 MiB 上限，未创建归档版本');
  files.unshift({name:`${archiveId}.archive.json`,blob:header});
  return {id:archiveId,projectId:bundle.project.id,manifest,files};
}

/** Read-only verification. Never writes into a working project. */
export async function readFinalArchive(files: File[]): Promise<{record:ArchiveRecord;bundle:ProjectBundle;report:ReturnType<typeof archiveReport>;blobs:Map<string,Blob>}> {
  if(!files.length||files.length>260||new Set(files.map(f=>f.name)).size!==files.length)throw new Error('归档文件缺失、重名或数量超过上限');
  const headers=files.filter(f=>f.name.endsWith('.archive.json'));
  if(headers.length!==1||headers[0].size>MiB)throw new Error('请选择一份归档清单与它的全部报告、项目清单和 ZIP');
  let raw:unknown;try{raw=JSON.parse(await headers[0].text());}catch{throw new Error('归档清单不是有效 JSON');}
  if(!object(raw)||raw.format!=='eval-studio-final-archive'||raw.schemaVersion!==1||!identity(raw.archiveId)||headers[0].name!==`${raw.archiveId}.archive.json`||typeof raw.projectId!=='string'||typeof raw.projectName!=='string'||!['checkpoint','final'].includes(String(raw.mode))||!['original','adjudicated-reference'].includes(String(raw.basis))||typeof raw.createdAt!=='string'||!Number.isFinite(Date.parse(raw.createdAt))||typeof raw.operatorId!=='string'||typeof raw.reason!=='string'||!raw.reason.trim()||raw.reason.length>10000||typeof raw.demo!=='boolean'||!hash(raw.sourceHash)||!hash(raw.stageManifestHash)||!hash(raw.manifestHash)||!validConfirmations(raw.confirmations)||!object(raw.scope)||!Array.isArray(raw.checks)||!Array.isArray(raw.files)||raw.files.length>259)throw new Error('归档清单结构、标识或口径无效');
  const manifest=raw as unknown as ArchiveManifest;
  if(!['ecommerce-v1','ecommerce-anchors-v1'].includes(manifest.calculationVersion))throw new Error('此归档计算版本暂不支持，请使用对应版本工作台校验');
  if(manifest.reportVersion!==undefined&&!['report-v1','report-v2'].includes(manifest.reportVersion))throw new Error('此归档报告版本暂不支持，请使用对应版本工作台校验');
  const {manifestHash:_hash,...unsigned}=manifest;if(await hashValue(unsigned)!==manifest.manifestHash)throw new Error('归档清单 SHA-256 校验失败');
  if(new Set(manifest.files.map(row=>row?.name)).size!==manifest.files.length||files.length!==manifest.files.length+1)throw new Error('归档缺少文件、混入额外文件或清单存在重名');
  for(const row of manifest.files){
    if(!row||typeof row.name!=='string'||!row.name.startsWith(`${manifest.archiveId}.`)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(row.name)||!Number.isSafeInteger(row.size)||row.size<1||row.size>50*MiB||!hash(row.sha256)||!['project','media','report-json','report-md'].includes(row.role))throw new Error('归档文件条目、路径或大小无效');
    const file=files.find(f=>f.name===row.name);if(!file||file.size!==row.size||await hashBlob(file)!==row.sha256)throw new Error(`归档文件缺失或 SHA-256 不符：${row.name}`);
  }
  const one=(role:ArchiveManifest['files'][number]['role'],suffix:string)=>{const rows=manifest.files.filter(r=>r.role===role);if(rows.length!==1||rows[0].name!==`${manifest.archiveId}.${suffix}`)throw new Error('归档项目或报告文件角色不匹配');return files.find(f=>f.name===rows[0].name)!;};
  const projectFile=one('project','eval.json'),jsonFile=one('report-json','report.json'),mdFile=one('report-md','report.md');
  if(jsonFile.size>20*MiB||mdFile.size>2*MiB)throw new Error('归档报告超过大小上限');
  const mediaFiles=manifest.files.filter(r=>r.role==='media').map(r=>files.find(f=>f.name===r.name)!);
  const stage=await readStagePackage([projectFile,...mediaFiles]);
  const bundle=stage.manifest.bundle;
  if(manifest.calculationVersion!==(isAnchorMode(bundle.project.scheme)?'ecommerce-anchors-v1':'ecommerce-v1'))throw new Error('归档计算版本与评分方式不一致');
  const input:ArchiveInput={mode:manifest.mode,basis:manifest.basis,operatorId:manifest.operatorId,reason:manifest.reason,demo:manifest.demo,scopeConfirmed:manifest.confirmations.scope,featuresConfirmed:manifest.confirmations.features,conclusionsConfirmed:manifest.confirmations.conclusions};
  const reportOptions:RatingValidationOptions={legacyRequiredReasons:manifest.reportVersion===undefined||manifest.reportVersion==='report-v1'};
  validateInput(bundle,input,reportOptions);
  const expectedScope={realProductIds:bundle.project.products.filter(p=>!p.demo).map(p=>p.id),simulatedProductIds:bundle.project.products.filter(p=>p.demo).map(p=>p.id),questionCount:bundle.project.questions.length,selfConfigured:bundle.project.products.some(p=>p.role==='self')};
  if(stage.manifest.kind!=='baseline'||stage.manifest.packageId!==manifest.archiveId||stage.manifest.exportedAt!==manifest.createdAt||stage.manifest.senderId!==manifest.operatorId||stage.manifest.manifestHash!==manifest.stageManifestHash||bundle.project.id!==manifest.projectId||bundle.project.name!==manifest.projectName||await archiveContentHash(bundle)!==manifest.sourceHash||canonicalJoint(expectedScope)!==canonicalJoint(manifest.scope))throw new Error('归档项目、范围或数据快照与清单不同');
  const check=archiveReadiness(bundle,manifest.basis,manifest.createdAt,input,true,reportOptions);
  if(canonicalJoint(check.checks)!==canonicalJoint(manifest.checks)||manifest.mode==='final'&&check.blockers.length)throw new Error('归档检查结果不符或未满足最终归档条件');
  const report=archiveReport(check.report,manifest);
  let reportRaw:unknown;try{reportRaw=JSON.parse(await jsonFile.text());}catch{throw new Error('归档报告 JSON 无效');}
  if(canonicalJoint(reportRaw)!==canonicalJoint(report)||await mdFile.text()!==archivedMarkdown(check.report,manifest))throw new Error('报告内容与冻结的评测数据或口径不一致');
  return {record:{id:manifest.archiveId,projectId:manifest.projectId,manifest,files:files.map(file=>({name:file.name,blob:file.slice(0,file.size,file.type)}))},bundle,report,blobs:stage.blobs};
}
