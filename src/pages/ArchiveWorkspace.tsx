import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, CheckCircle2, FileArchive, Files, History, LockKeyhole, PackageCheck, ShieldCheck, Upload } from 'lucide-react';
import type { Asset, ProjectBundle } from '../core/model';
import type { ArchiveInput, ArchiveMode, ArchiveRecord } from '../core/archive';
import { archiveContentHash, archiveReadiness, buildFinalArchive, readFinalArchive } from '../core/archive';
import type { ReportBasis } from '../core/report';
import { createArchive, inspectArchive, listArchives, retainVerifiedArchive } from '../storage/archives';
import { PageHeading, PanelHeading, Pill } from '../ui';
import { useDirty } from './QualityWorkspace';
import './archive-workspace.css';

const label=(mode:ArchiveMode)=>mode==='final'?'最终归档':'阶段快照';
const size=(bytes:number)=>bytes>1024*1024?`${(bytes/1024/1024).toFixed(1)} MB`:`${(bytes/1024).toFixed(1)} KB`;
const message=(error:unknown)=>error instanceof Error?error.message:'操作失败';
const saveFile=(file:ArchiveRecord['files'][number])=>{const url=URL.createObjectURL(file.blob),anchor=document.createElement('a');anchor.href=url;anchor.download=file.name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),10000);};
export default function ArchiveWorkspace({bundle,onToast,demo=false,loader}:{bundle:ProjectBundle|null;onToast:(message:string)=>void;demo?:boolean;loader?:(id:string)=>Promise<Asset|undefined>}){
  const [mode,setMode]=useState<ArchiveMode>('checkpoint'),[basis,setBasis]=useState<ReportBasis>('adjudicated-reference');
  const [operatorId,setOperatorId]=useState(bundle?.project.members[0]?.id??''),[reason,setReason]=useState('');
  const [scopeConfirmed,setScope]=useState(false),[featuresConfirmed,setFeatures]=useState(false),[conclusionsConfirmed,setConclusions]=useState(false);
  const [records,setRecords]=useState<ArchiveRecord[]>([]),[selected,setSelected]=useState<ArchiveRecord|null>(null),[contentHash,setContentHash]=useState('');
  const [inspection,setInspection]=useState<Awaited<ReturnType<typeof readFinalArchive>>|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[readError,setReadError]=useState(''),[changed,setChanged]=useState(false);
  const [requested,setRequested]=useState<string[]>([]);
  const input=useRef<HTMLInputElement>(null);
  useDirty(busy||changed);
  const options:ArchiveInput={mode,basis,operatorId,reason,scopeConfirmed,featuresConfirmed,conclusionsConfirmed,demo};
  const readiness=bundle?archiveReadiness(bundle,basis,new Date().toISOString(),options):null;
  const blockers=readiness?.blockers.filter(c=>c.id!=='media')??[];
  const configurationReady=readiness?.checks.find(check=>check.id==='project')?.passed??false;
  useEffect(()=>{
    let active=true;setContentHash('');setReadError('');setSelected(null);setRequested([]);setInspection(null);
    if(bundle)archiveContentHash(bundle).then(hash=>{if(active)setContentHash(hash);}).catch(error=>{if(active)setReadError(message(error));});
    if(!demo)listArchives(bundle?.project.id).then(rows=>{if(active)setRecords(rows);}).catch(error=>{if(active)setReadError(message(error));});
    return()=>{active=false;};
  },[bundle,demo]);
  function edit(action:()=>void){action();setChanged(true);}
  async function generate(){
    if(!bundle)return;setBusy(true);setError('');
    try{
      const record=demo?await buildFinalArchive({bundle,snapshots:[bundle.project],audits:[]},options,loader!):await createArchive(bundle.project.id,options,contentHash);
      setRecords(previous=>[record,...previous.filter(row=>row.id!==record.id)]);setSelected(record);setRequested([]);setChanged(false);
      onToast(`${label(record.manifest.mode)}已生成${demo?'（演示会话）':'并留存在本机'}；请下载清单、报告和全部分包`);
    }catch(error){setError(message(error));}finally{setBusy(false);}
  }
  return <>
    <PageHeading eyebrow="VERSIONED DELIVERABLES" title="让结论有一份固定的版本" description="报告、原始记录、规则题库与全部原图一起留存；后续修改工作项目不会覆盖旧归档。"/>
    <div className="archive-status"><span><LockKeyhole size={24}/></span><div><strong>{bundle?'先检查，再冻结本轮成果':'校验与留存收到的归档'}</strong><p>{demo?'演示数据只生成界面样本，不代表真实评测完成；离开页面后不保留。':'归档保存在当前浏览器。请下载全部文件，重新上传可校验完整性。'}</p></div><Pill tone="violet">独立版本</Pill></div>
    {readError&&<div role="alert" className="quality-error">本机归档读取未完成：{readError}</div>}
    {bundle&&<section className="panel archive-panel"><PanelHeading title="生成本轮交付版本" subtitle="检查未齐时保留阶段快照；全部条件满足后才允许最终归档。"/><fieldset className="archive-form" disabled={busy}>
      <label className="field">归档类型<select className="input" value={mode} onChange={event=>edit(()=>setMode(event.target.value as ArchiveMode))}><option value="checkpoint">阶段快照 · 保留缺口</option><option value="final">最终归档 · 检查全部通过</option></select></label>
      <label className="field">统计口径<select className="input" value={basis} onChange={event=>edit(()=>setBasis(event.target.value as ReportBasis))}><option value="original">原始初评</option><option value="adjudicated-reference">裁决口径参考分</option></select></label>
      <label className="field">归档负责人<select className="input" value={operatorId} onChange={event=>edit(()=>setOperatorId(event.target.value))}>{bundle.project.members.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      <label className="field archive-wide">版本说明<textarea className="input" value={reason} onChange={event=>edit(()=>setReason(event.target.value))} placeholder="说明本轮范围、结论修订或当前保留的缺口。"/></label>
      <div className="archive-confirmations archive-wide"><label><input type="checkbox" checked={scopeConfirmed} onChange={event=>edit(()=>setScope(event.target.checked))}/>确认当前产品与题量范围；未配置自家时不声称完成原四产品 GSB 方案</label><label><input type="checkbox" checked={featuresConfirmed} onChange={event=>edit(()=>setFeatures(event.target.checked))}/>负责人已核实功能检查、费用与商用授权摘要及来源</label><label><input type="checkbox" checked={conclusionsConfirmed} onChange={event=>edit(()=>setConclusions(event.target.checked))}/>负责人已确认共同讨论结论、推荐条件与局限</label></div>
      <div className="archive-generate archive-wide"><div><strong>{!configurationReady?'请先完成项目配置；配置草稿可使用项目备份':mode==='final'?`${blockers.length} 项条件待处理`:'允许保存尚未完成的评测工作'}</strong><p>生成时逐图核验。缺图或损坏会中止，不产生“最终归档”记录。</p></div><button className="btn btn-primary" disabled={!operatorId||!reason.trim()||!contentHash||!configurationReady||!!readError||mode==='final'&&blockers.length>0} onClick={()=>void generate()}><FileArchive size={16}/>{busy?'正在校验和打包…':`生成${label(mode)}`}</button></div>
    </fieldset><details className="archive-checks" open={mode==='final'&&blockers.length>0}><summary>查看本轮检查与缺口（{blockers.length}）</summary>{readiness?.checks.map(check=><div key={check.id}>{check.passed?<CheckCircle2 size={15}/>:<AlertCircle size={15}/>}<span><b>{check.title}</b><small>{check.detail}</small></span><Pill tone={check.passed?'green':'orange'}>{check.id==='media'?'生成时校验':check.passed?'通过':'待处理'}</Pill></div>)}</details></section>}
    {error&&<div className="quality-error" role="alert">{error}</div>}
    <div className="archive-columns"><section className="panel archive-panel"><PanelHeading title="归档版本记录" subtitle={bundle?'仅显示本项目；旧版本不会被后续评测覆盖。':'所有本机留存的归档；校验包不会覆盖工作项目。'} action={<History size={18}/>}/>{records.length?records.map(record=><button className={`archive-record ${selected?.id===record.id?'selected':''}`} key={record.id} disabled={busy} onClick={()=>{setSelected(record);setRequested([]);}}><span className="archive-record-icon"><FileArchive size={20}/></span><span><strong>{record.manifest.projectName}</strong><small>{label(record.manifest.mode)} · {new Date(record.manifest.createdAt).toLocaleString('zh-CN')}</small><small>{record.manifest.reason}</small></span><Pill tone={record.manifest.mode==='final'?'green':'neutral'}>{record.manifest.demo?'演示':label(record.manifest.mode)}</Pill></button>):<div className="archive-empty"><Files size={30}/><p>还没有留存的归档版本</p></div>}</section>
      <section className="panel archive-panel"><PanelHeading title="重新上传，复核离线文件" subtitle="选择同一组 .archive.json、.eval.json、两个报告文件与全部 ZIP。"/><input ref={input} type="file" accept=".json,.zip,.md" multiple hidden onChange={async event=>{const files=[...event.target.files??[]];event.target.value='';if(!files.length)return;setBusy(true);setError('');setInspection(null);try{setInspection(await (demo?readFinalArchive(files):inspectArchive(files)));onToast('全部文件校验通过，报告与冻结数据一致');}catch(error){setError(message(error));}finally{setBusy(false);}}}/><button className="upload-zone" disabled={busy} onClick={()=>input.current?.click()}><Upload size={26}/><strong>{busy?'正在核验文件…':'选择完整归档文件组'}</strong><small>核对文件 SHA-256、ZIP、原图与报告计算结果</small></button>
      {inspection&&<div className="archive-verified"><PackageCheck size={21}/><div><strong>{label(inspection.record.manifest.mode)} · 校验通过</strong><p>{inspection.record.manifest.projectName} · {inspection.record.files.length} 个文件</p><p>不修改或恢复当前工作项目；归档仍按其原范围解释。</p><button className="btn btn-small" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{const record=demo?inspection.record:await retainVerifiedArchive(inspection);setRecords(previous=>[record,...previous.filter(row=>row.id!==record.id)]);setSelected(record);setInspection(null);setRequested([]);onToast('只读归档已留存；工作项目保持原状');}catch(error){setError(message(error));}finally{setBusy(false);}}}><ShieldCheck size={14}/>留存这份只读归档</button></div></div>}
      </section></div>
    {selected&&<section className="panel archive-panel"><PanelHeading title={`${label(selected.manifest.mode)} · 下载完整文件组`} subtitle="请将下列文件放在同一个文件夹中保存。点击下载仅代表已发起请求，重新上传全套文件才完成本页复核。"/><div className="archive-version-meta"><Pill tone={selected.manifest.mode==='final'?'green':'orange'}>{label(selected.manifest.mode)}{selected.manifest.demo?' · 演示':''}</Pill>{bundle&&<Pill tone={contentHash===selected.manifest.sourceHash?'green':'orange'}>{contentHash===selected.manifest.sourceHash?'与当前工作数据一致':'工作数据已变化，旧版本保留'}</Pill>}<span>{selected.files.length} 个文件 · {size(selected.files.reduce((n,f)=>n+f.blob.size,0))}</span></div>
      <p className="archive-digest">版本 SHA-256：{selected.manifest.manifestHash}</p><p className="archive-scope">{selected.manifest.scope.realProductIds.length} 个真实产品 · {selected.manifest.scope.simulatedProductIds.length} 个模拟产品 · {selected.manifest.scope.questionCount} 道题 · {selected.manifest.basis==='original'?'原始初评':'裁决口径参考分'}</p>
      {selected.files.map(file=><div className="archive-file" key={file.name}><span><b>{file.name.endsWith('.archive.json')?'归档总清单':file.name.endsWith('.eval.json')?'可恢复项目主包清单':file.name.endsWith('.md')?'冻结报告 · Markdown':file.name.endsWith('.report.json')?'冻结报告 · JSON':'原图 ZIP 分包'}</b><code>{file.name}</code></span><small>{size(file.blob.size)}</small><button className="btn btn-small" onClick={()=>{saveFile(file);setRequested(previous=>[...new Set([...previous,file.name])]);}}><ArrowDownToLine size={14}/>{requested.includes(file.name)?'再次下载':'下载文件'}</button></div>)}
      <div className="archive-footer-note"><AlertCircle size={16}/><p>完整 .eval.json 与原图 ZIP 可从“阶段同步”预览后恢复或合并。旧归档文件固定不变；普通项目备份不包含这里留存的全部归档文件，请单独保存各版本文件组。</p></div>
    </section>}
  </>;
}
