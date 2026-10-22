import { useEffect, useState } from 'react';
import { AlertCircle, Columns2, FileArchive, FileText, LoaderCircle } from 'lucide-react';
import { createReportExample } from '../demo/report-example';
import { validateQuality, validateQualityExtension } from '../core/quality';
import { canonical } from '../storage/projects';
import type { QualityState } from '../core/quality';
import JointWorkspace from './JointWorkspace';
import ReportWorkspace from './ReportWorkspace';
import ArchiveWorkspace from './ArchiveWorkspace';

const initialView=(): 'report'|'joint'|'archive' => { const value=new URLSearchParams(location.hash.split('?')[1]??'').get('view');return value==='archive'||value==='joint'?value:'report'; };

export default function ReportDemo({onToast}:{onToast:(message:string)=>void}) {
  const [example,setExample]=useState<Awaited<ReturnType<typeof createReportExample>>|null>(null),[error,setError]=useState('');
  const [tab,setTab]=useState<'report'|'joint'|'archive'>(initialView);
  const [pending,setPending]=useState(false);
  useEffect(()=>{let active=true;createReportExample().then(value=>{if(active)setExample(value);}).catch(error=>{if(active)setError(error instanceof Error?error.message:'演示加载失败');});const edited=(event:Event)=>setPending(Boolean((event as CustomEvent).detail));window.addEventListener('formal-dirty',edited);return()=>{active=false;window.removeEventListener('formal-dirty',edited);};},[]);
  useEffect(()=>{const changed=()=>setTab(initialView());window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);
  if(error)return <div className="quality-error" role="alert">{error}</div>;
  if(!example)return <div className="empty-state"><LoaderCircle size={22} className="spin"/>正在加载独立演示数据…</div>;
  async function save(state:QualityState){
    const errors=[...validateQuality(state,example!.bundle),...validateQualityExtension(example!.bundle.quality!,state)];
    if(errors.length)throw new Error(errors.join('；'));
    const expected=canonical(example!.bundle.quality);
    setExample(current=>current && canonical(current.bundle.quality)===expected?{...current,bundle:{...current.bundle,quality:state}}:current);
  }
  return <>
    <div className="report-note"><AlertCircle size={16}/>独立界面示例：三产品、50 题、12 题共同样本；所有图片复用同一素材，所有判断均为模拟。操作仅保留在本次页面会话，刷新后恢复示例，不写入正式项目。</div>
    <div className="report-tabs" style={{marginBottom:22}}>{(['report','joint','archive'] as const).map(id=><button key={id} aria-pressed={tab===id} style={{color:tab===id?'#8564b5':undefined,borderBottomColor:tab===id?'#a188c4':undefined}} onClick={()=>{if(pending&&!window.confirm('有尚未保存的输入，切换会丢失修改，是否继续？'))return;setTab(id);history.replaceState(null,'',`${location.pathname}${location.search}#/report?view=${id}`);}}>{id==='archive'?<FileArchive size={16}/>:id==='report'?<FileText size={16}/>:<Columns2 size={16}/>}体验{id==='archive'?'版本归档':id==='report'?'报告与检查':'联合排名'}</button>)}</div>
    {tab==='archive'?<ArchiveWorkspace bundle={example.bundle} loader={example.loader} onToast={onToast} demo/>:tab==='report'?<ReportWorkspace loader={example.loader} bundle={example.bundle} onSave={save} onToast={onToast} demo/>:<JointWorkspace bundle={example.bundle} loader={example.loader} onSave={save} onToast={onToast}/>}
  </>;
}
