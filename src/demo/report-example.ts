import scheme from '../../schemes/ecommerce-t2i/scheme.json';
import { questions } from './data';
import type { Asset, ProjectBundle, Scheme } from '../core/model';
import { canonical, digest } from '../storage/projects';
import { createJointPlan } from '../core/joint';
import { emptyQuality } from '../core/quality';
import type { ReportNotes } from '../core/report-notes';

/** Isolated interface example. Never written to formal IndexedDB. */
export async function createReportExample(): Promise<{ bundle: ProjectBundle; loader: (id: string) => Promise<Asset | undefined> }> {
  const response = await fetch(`${import.meta.env.BASE_URL}assets/serum-demo.png`);
  if (!response.ok) throw new Error('演示素材加载失败，请刷新重试');
  const blob = await response.blob(), sha256 = await digest(await blob.arrayBuffer()), stamp = '2026-10-19T12:00:00.000Z';
  const members = ['A','B','C'].map(id => ({id:`demo-member-${id}`,name:`演示评测员 ${id}`}));
  const products = members.map((m,i) => ({id:`demo-product-${i}`,name:`示例竞品 ${['A','B','C'][i]}`,version:'演示版本',role:(['direct','benchmark','alternative'] as const)[i],demo:false,ownerId:m.id,totalCost:[24,40,12][i],commercialUse:'allowed' as const,commercialEvidence:'仅为功能演示假设，不代表任何真实产品的授权条款'}));
  const planScheme: Scheme = {id:scheme.id,name:scheme.name,version:'界面演示',dimensions:scheme.dimensions,tags:scheme.tags as Scheme['tags'],jointReview:scheme.jointReview,policies:{failedNoOutput:'score-one',rankingTies:'dense',zeroUsableCost:'score-one'}};
  const project: ProjectBundle['project'] = {
    id:'interface-report-example',name:'电商文生图 · 报告界面演示',background:'全部产品、素材和判断均为模拟，只用于体验工作台。',period:'演示周期 · 3 天',members,products,
    questions:questions.map(q => ({...q,id:`Q${String(q.id).padStart(2,'0')}`,acceptance:['仅用于界面演示，图片复用同一素材'],referenceNames:[],fields:{}})),scheme:planScheme,rulesConfirmed:true,expectedQuestionCount:50,status:'active',revision:1,createdAt:stamp,updatedAt:stamp,schemeHash:await digest(canonical(planScheme)),questionsHash:''
  };
  project.questionsHash = await digest(canonical(project.questions));
  const bundle: ProjectBundle = {project,evaluations:[],assets:[],walkthroughs:[],experiences:[],quality:emptyQuality()};
  for (const [i, product] of products.entries()) {
    for (const [index, q] of project.questions.entries()) {
      const mediaId=`${product.id}-${q.id}-image`;
      bundle.assets.push({id:mediaId,projectId:project.id,questionId:q.id,productId:product.id,role:'output',name:'reused-interface-example.png',mime:'image/png',size:blob.size,sha256,createdAt:stamp});
      const tags = (index+i)%5===0 ? [{code:['A-06','C-01','B-03'][i],severity:'P2' as const}] : [];
      bundle.evaluations.push({id:`${product.id}-${q.id}-v1`,projectId:project.id,questionId:q.id,productId:product.id,reviewerId:product.ownerId,revision:1,parentId:null,status:'submitted',mediaIds:[mediaId],bestMediaId:mediaId,mediaChecks:[{mediaId,usable:true,infringement:false}],tags,seconds:[35,48,26][i],failed:false,failureReason:'',notes:index===0?'演示存疑：需要说明此图的判断依据。':'',schemeHash:project.schemeHash,questionsHash:project.questionsHash,createdAt:stamp});
    }
    bundle.walkthroughs.push(...(['background','color','expand'] as const).map(task=>({id:`${product.id}-${task}`,projectId:project.id,productId:product.id,task,status:'submitted' as const,completed:true,steps:3+i,tags:[],notes:'模拟走查'})));
    bundle.experiences.push({productId:product.id,score:[4,5,3][i],notes:'模拟体验分'});
  }
  const ids=scheme.jointReview.scenes.flatMap(scene=>project.questions.filter(q=>q.scene===scene).filter((_,i)=>[0,4,8].includes(i)).map(q=>q.id));
  bundle.quality!.joint=createJointPlan(bundle,ids,'示例共同选题：四场景各三题，分布覆盖基础与进阶；全部判断为界面模拟数据。','demo-joint-plan',stamp);
  bundle.quality!.joint.rankings=ids.slice(0,8).map((questionId,index)=>({id:`demo-ranking-${index}`,parentId:null,questionId,participants:members.map(m=>m.id),ranks:products.map((p,i)=>({productId:p.id,rank:index%3===0?(i<2?1:2):((i+index)%3)+1})),unable:false,reason:'演示判断：用模拟排名展示并列、修订与净胜率，不构成真实产品结论。',createdAt:stamp}));
  const notes: ReportNotes={id:'demo-report-notes-v1',parentId:null,createdAt:stamp,participants:members.map(m=>m.id),summary:'本页所有产品、分数和排名均为界面演示。示例用于展示如何把维度分、共同讨论和问题标签整理成可追溯结论，不代表任何真实竞品表现。',productInsights:'示例 A：演示商品场景适配分析。\n示例 B：演示画面质量与体验的权衡。\n示例 C：演示效率、成本与稳定性的比较。',recommendations:'优先从高频且影响上架的问题中寻找改进方向；产品功能与计费建议应在真实评测后填写。',consistencyExplanation:'共同排名尚有 4 题未完成。当前净胜率仅代表已形成有效排名的 8 题，不能据此确定最终推荐。',featureComparison:'演示字段：参考图、白底模板、编辑、批量、比例、水印、分辨率和商用授权。真实产品需逐项核实并注明来源。',limitations:'全部图片复用同一 AI 演示素材。题目、计分、费用和讨论均为模拟，尚无真实三人独立校准与交叉复评。',caseQuestionIds:ids.slice(0,3),acknowledgedNoteIds:[],noteResolution:''};
  bundle.quality!.reportNotes=[notes];
  return {bundle,loader:async id=>{const meta=bundle.assets.find(a=>a.id===id);return meta?{...meta,blob}:undefined;}};
}
