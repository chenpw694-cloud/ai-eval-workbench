import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, Save } from 'lucide-react';
import AnchorRatings from '../components/AnchorRatings';
import type { DimensionRatings, Scheme } from '../core/model';
import { defaultAnchors, questionDimensions, ratingErrors } from '../core/ratings';
import source from '../../schemes/ecommerce-t2i/scheme.json';
import { getValue, setValue } from '../storage/local';
import { PageHeading, PanelHeading } from '../ui';
const scheme: Scheme = { ...source, tags: source.tags as Scheme['tags'], rating: { mode: 'anchors', anchors: defaultAnchors() }, policies: { failedNoOutput:'unresolved', rankingTies:'unresolved', zeroUsableCost:'unresolved' } };
export default function AnchorDemo({ onToast }: { onToast: (text: string) => void }) {
  const [values,setValues] = useState<DimensionRatings>({});
  const [saved,setSaved] = useState(false);
  const [submitted,setSubmitted] = useState(false);
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState(false);
  useEffect(() => { let active=true; getValue<{ values:DimensionRatings; submitted:boolean } | null>('anchor-rating-preview',null).then(row => { if(active&&row){ setValues(row.values);setSubmitted(row.submitted);setSaved(true); } }).catch(()=>onToast('演示评分读取失败')).finally(()=>{if(active)setLoading(false);}); return()=>{active=false;}; },[]);
  async function save(submit:boolean){
    const errors=ratingErrors(scheme,values,questionDimensions,submit);
    if(errors.length){onToast(errors[0]);return;}
    setBusy(true);try{await setValue('anchor-rating-preview',{values,submitted:submit,demo:true});setSaved(true);setSubmitted(submit);onToast(submit?'演示评分已提交，仅保存在演示数据区':'演示草稿已保存，刷新后可继续');}catch{onToast('演示评分保存失败，输入仍保留');}finally{setBusy(false);}
  }
  return <div className="anchor-demo"><PageHeading eyebrow="RUBRIC SCORING" title="对照锚点，给出有依据的分数" description="每个维度选择 1～5 分整数，再记录画面或操作依据。此页只演示交互，不计入正式评测。" action={<a className="btn" href="#/projects">进入正式项目<ArrowRight size={15}/></a>}/><div className="anchor-demo-grid"><section className="panel anchor-demo-info"><PanelHeading title="Q01 · 精华液自然光场景图" subtitle="场景图 · 美妆个护 · 基础 · 合成演示"/><img className="anchor-demo-image" src={`${import.meta.env.BASE_URL}assets/serum-demo.png`} alt="锚点评分示例：AI 生成的精华液场景图"/><h3>需求与验收要点</h3><p className="anchor-demo-status">展示一瓶琥珀色精华液，使用自然光、浅色台面与轻微叶影。商品完整居中，标签清晰，接触阴影自然。</p><p className="anchor-readonly">A/B/C/F/G 在右侧逐题打分；D 在正式项目的“走查与成本”中打分；E 由可用率、耗时和成本计算。G 的操作过程需实际体验，不能仅凭这张图片判断。</p><p className="anchor-demo-status">建议锚点属于扩展评分口径。正式使用前，在“项目与题库 → 规则确认 → 评分方式与锚点”选择并确认。已开始评测的标签方案保持原口径，可另建锚点评分项目。</p></section><section className="panel anchor-demo-panel"><div className="anchor-demo-status" role="status">{loading?'读取演示草稿…':saved?submitted?'演示评分已提交':'演示草稿已保存':'当前修改尚未保存'} · 原图为 AI 示范素材</div><AnchorRatings scheme={scheme} dimensions={questionDimensions} values={values} disabled={loading||busy} onChange={value=>{setValues(value);setSaved(false);setSubmitted(false);}}/><div className="formal-entry-actions"><button className="btn" disabled={loading||busy} onClick={()=>void save(false)}><Save size={15}/>保存演示草稿</button><button className="btn btn-primary" disabled={loading||busy} onClick={()=>void save(true)}><CheckCircle2 size={15}/>提交演示评分</button></div></section></div></div>;
}
