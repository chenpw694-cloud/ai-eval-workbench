import { defaultAnchors } from '../src/core/ratings.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture } from './helpers/formal-fixture.mjs';
import { archiveContentHash, archiveReadiness, buildFinalArchive, hashValue, readFinalArchive } from '../src/core/archive.ts';
import { createQualityBatch, emptyQuality } from '../src/core/quality.ts';
import { emptyReportNotes } from '../src/core/report-notes.ts';
import { hashBlob } from '../src/core/packages.ts';
import { buildReport, reportMarkdown } from '../src/core/report.ts';
const stamp='2026-10-20T12:00:00.000Z';let seq=0;const id=()=>`a-${++seq}`;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=','base64');
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`:JSON.stringify(value);
function setup(complete=false,anchors=false){
 const b=fixture(3,complete?50:2);if(complete)b.project.products[0].role='self';b.quality=emptyQuality();b.project.scheme.policies.rankingTies='dense';
 b.project.questions.forEach((q,i)=>{q.scene=['白底主图','场景图','详情图','营销海报'][i%4];});
 if(anchors){b.project.scheme.rating={mode:'anchors',anchors:defaultAnchors()};b.evaluations.forEach(r=>r.ratings=Object.fromEntries(['A','B','C','F','G'].map(id=>[id,{score:5,reason:'合成评分依据'}])));b.walkthroughs.forEach(r=>r.ratings={D:{score:5,reason:'编辑目标达成'}});}
 b.project.schemeHash=sha(canonical(b.project.scheme));b.project.questionsHash=sha(canonical(b.project.questions));
 b.evaluations.forEach(e=>{e.schemeHash=b.project.schemeHash;e.questionsHash=b.project.questionsHash;});b.assets.forEach(a=>{a.size=png.length;a.sha256=sha(png);});
 if(complete){
  b.quality=createQualityBatch(b,'calibration','calib',id,stamp);b.quality.judgments=b.quality.tasks.map(task=>({id:id(),taskId:task.id,parentId:null,revision:1,reviewerId:task.reviewerId,tags:[],choice:null,unable:false,exposed:false,notes:'',createdAt:stamp}));
  b.quality.decisions=b.quality.tasks.filter(t=>t.reviewerId==='m1').map(task=>({id:id(),taskId:task.id,judgmentId:b.quality.judgments.find(j=>j.taskId===task.id).id,parentId:null,participants:['m1','m2','m3'],tags:[],usable:true,reason:'共同校准锚点',createdAt:stamp}));
  b.quality=createQualityBatch(b,'review','cross',id,stamp);b.quality.judgments.push(...b.quality.tasks.filter(t=>t.kind==='review').map(task=>({id:id(),taskId:task.id,parentId:null,revision:1,reviewerId:task.reviewerId,tags:[],choice:null,unable:false,exposed:false,notes:'',createdAt:stamp})));
  b.quality=createQualityBatch(b,'gsb','self-only',id,stamp);b.quality.judgments.push(...b.quality.tasks.filter(t=>t.kind==='gsb').map(task=>({id:id(),taskId:task.id,parentId:null,revision:1,reviewerId:task.reviewerId,tags:[],choice:'win',unable:false,exposed:false,notes:'',createdAt:stamp})));
  const ids=b.project.questions.map(q=>q.id);
  b.quality.reportNotes=[{...emptyReportNotes(),id:id(),parentId:null,createdAt:stamp,participants:['m1','m2','m3'],summary:'基于本轮真实范围的结论',productInsights:'各产品的优势和短板',recommendations:'自家产品启示',consistencyExplanation:'维度与联合比较的关系',featureComparison:'功能、价格与商用条款依据',limitations:'样本、人员、版本与随机性',caseQuestionIds:ids.slice(0,3)}];
 }
 if(anchors){for(const row of [...b.quality.judgments,...b.quality.decisions].filter(row=>!row.choice))row.ratings=Object.fromEntries(['A','B','C','F'].map(id=>[id,{score:5,reason:'独立或共同判断依据'}]));}
 return {bundle:b,snapshots:[b.project],audits:[]};
}
const input=(patch={})=>({mode:'checkpoint',basis:'original',operatorId:'m1',reason:'留存本轮评测证据',scopeConfirmed:true,featuresConfirmed:true,conclusionsConfirmed:true,demo:false,...patch});
const loader=source=>async assetId=>{const a=source.bundle.assets.find(a=>a.id===assetId);return a?{...a,blob:new Blob([png],{type:'image/png'})}:undefined;};
const files=record=>record.files.map(f=>new File([f.blob],f.name));
const build=(source,patch={})=>buildFinalArchive(source,input(patch),loader(source),{archiveId:id(),now:stamp});
async function altered(record,mutate){
 const list=files(record),header=list.find(f=>f.name.endsWith('.archive.json')),manifest=JSON.parse(await header.text());
 await mutate(manifest,list);
 const {manifestHash:_,...unsigned}=manifest;manifest.manifestHash=await hashValue(unsigned);
 const result=list.filter(f=>f.name!==header.name);result.push(new File([JSON.stringify(manifest)],header.name));return result;
}
async function replaceContent(manifest,list,role,content){const entry=manifest.files.find(e=>e.role===role),blob=new Blob([content]);entry.size=blob.size;entry.sha256=await hashBlob(blob);list.splice(list.findIndex(f=>f.name===entry.name),1,new File([blob],entry.name));}
function legacyArchivedMarkdown(source, manifest, version='report-v1') {
 const report=buildReport(source.bundle,manifest.basis,manifest.createdAt,manifest.demo,{legacyRequiredReasons:version==='report-v1',reportVersion:version});
 const lines=reportMarkdown({...report,checks:manifest.checks},version).split('\n');
 lines[0]=`# ${report.project.name} · ${report.demo?'界面演示 · ':''}${manifest.mode==='final'?'最终归档报告':'阶段快照报告'}`;
 lines[2]=manifest.mode==='final'?'> 本报告固定于本次归档的数据快照。后续工作项目修改不会改变这份文件；模拟对象与真实对象分别展示。':'> 阶段快照保留当前缺口，不代表最终评测完成。';
 const last=lines.findIndex(line=>line.startsWith('本文件及 JSON 明细不包含原图'));
 if(last>=0)lines[last]='原图已随本次归档的项目清单与 ZIP 分包提供；报告单独保存不能恢复项目。';
 lines.splice(4,0,`归档编号：${manifest.archiveId}`,`数据快照 SHA-256：${manifest.sourceHash}`,'');
 return lines.join('\n');
}

test('checkpoint freezes report, metadata and verified originals without pretending completion',async()=>{const source=setup(),record=await build(source);assert.equal(record.manifest.mode,'checkpoint');assert.equal(record.files.length,5);assert.ok(record.manifest.checks.some(c=>!c.passed));assert.equal(record.manifest.checks.find(c=>c.id==='media').passed,true);const read=await readFinalArchive(files(record));assert.equal(read.report.status,'checkpoint');assert.equal(read.blobs.size,1);assert.ok((await record.files.find(f=>f.name.endsWith('.md')).blob.text()).includes('不代表最终评测完成'));});
test('final archive rejects partial quality, trials and missing confirmations before loading images',async()=>{const source=setup();let loaded=false;await assert.rejects(()=>buildFinalArchive(source,input({mode:'final'}),async()=>{loaded=true;return undefined;}),/暂不能最终归档/);assert.equal(loaded,false);const full=setup(true);await assert.rejects(()=>build(full,{mode:'final',featuresConfirmed:false}),/负责人核实/);});
test('complete official workflow can create and independently verify final archive',async()=>{const source=setup(true);assert.deepEqual(archiveReadiness(source.bundle,'original',stamp,input(),true).blockers,[]);const record=await build(source,{mode:'final'});const read=await readFinalArchive(files(record));assert.equal(read.report.status,'final');assert.equal(read.record.manifest.mode,'final');assert.ok(read.record.manifest.checks.every(c=>c.passed));assert.equal(read.report.references.evaluationIds.length,150);assert.equal(read.bundle.quality.joint,undefined);assert.equal(read.bundle.quality.tasks.filter(t=>t.kind==='gsb').length,100);const md=await record.files.find(f=>f.name.endsWith('.md')).blob.text();assert.ok(md.includes('最终归档报告'));assert.ok(!md.includes('> 草稿'));assert.ok(md.includes('原图已随本次归档'));});
test('missing or wrong local originals abort generation with no usable final result',async()=>{const source=setup(true);await assert.rejects(()=>buildFinalArchive(source,input({mode:'final'}),async()=>undefined,{archiveId:id(),now:stamp}),/原图/);await assert.rejects(()=>buildFinalArchive(source,input({mode:'final'}),async aid=>({...source.bundle.assets.find(a=>a.id===aid),blob:new Blob(['bad'],{type:'image/png'})}),{archiveId:id(),now:stamp}),/原图/);});
test('working changes never mutate a generated archive file or its frozen report',async()=>{const source=setup(true),before=structuredClone(source),record=await build(source,{mode:'final'});source.bundle.project.products[0].totalCost=999;source.bundle.evaluations[0].notes='后续修改';assert.notEqual(await archiveContentHash(source.bundle),record.manifest.sourceHash);const read=await readFinalArchive(files(record));assert.equal(read.bundle.project.products[0].totalCost,10);assert.equal(read.bundle.evaluations[0].notes,'');assert.equal(before.bundle.project.products[0].totalCost,10);});
test('content identity ignores remapped local counters and record iteration order',async()=>{const source=setup(),copy=structuredClone(source.bundle);copy.project.revision+=10;copy.project.updatedAt='2026-11-01T00:00:00Z';copy.project.sourceSnapshot={packageId:'restored',revision:1};copy.evaluations.reverse();copy.assets.reverse();assert.equal(await archiveContentHash(source.bundle),await archiveContentHash(copy));copy.project.name='改变范围描述';assert.notEqual(await archiveContentHash(source.bundle),await archiveContentHash(copy));});
test('missing, duplicate, extra and mixed archive files are rejected',async()=>{const a=await build(setup()),b=await build(setup());await assert.rejects(()=>readFinalArchive(files(a).slice(1)),/归档清单/);await assert.rejects(()=>readFinalArchive(files(a).slice(0,-1)),/缺少文件/);await assert.rejects(()=>readFinalArchive([...files(a),files(a)[0]]),/重名/);await assert.rejects(()=>readFinalArchive([...files(a),new File(['extra'],'extra.txt')]),/额外/);await assert.rejects(()=>readFinalArchive([...files(a),files(b)[0]]),/归档清单/);});
test('corrupt report or original part bytes fail outer file SHA before parsing',async()=>{const record=await build(setup());for(const suffix of ['.report.json','.zip']){const list=files(record),index=list.findIndex(f=>f.name.endsWith(suffix)),file=list[index],bytes=new Uint8Array(await file.arrayBuffer());bytes[bytes.length-1]^=1;list[index]=new File([bytes],file.name);await assert.rejects(()=>readFinalArchive(list),/SHA-256/);}});
test('re-signing altered computed report cannot pass semantic verification',async()=>{const record=await build(setup());const list=await altered(record,async(manifest,list)=>{const file=list.find(f=>f.name.endsWith('.report.json')),data=JSON.parse(await file.text());data.results[0].total=1;await replaceContent(manifest,list,'report-json',JSON.stringify(data));});await assert.rejects(()=>readFinalArchive(list),/报告内容/);});
test('re-signing altered Markdown cannot bypass exact frozen text check',async()=>{const record=await build(setup());const list=await altered(record,(m,list)=>replaceContent(m,list,'report-md','伪造的推荐结论'));await assert.rejects(()=>readFinalArchive(list),/报告内容/);});
test('checkpoint cannot be relabelled as final by merely re-signing wrapper',async()=>{const record=await build(setup());const list=await altered(record,m=>{m.mode='final';});await assert.rejects(()=>readFinalArchive(list),/归档条件/);});
test('project, scope, basis and calculation version remain bound to the frozen evidence',async()=>{const record=await build(setup());for(const mode of ['project','scope','basis','version']){const list=await altered(record,m=>{if(mode==='project')m.projectId='other';if(mode==='scope')m.scope.realProductIds=[];if(mode==='basis')m.basis='adjudicated-reference';if(mode==='version')m.calculationVersion='future-v2';});await assert.rejects(()=>readFinalArchive(list),/不同|不一致|版本/);}});
test('configured self with unfinished GSB prevents final even if all real scores are complete',()=>{const source=setup(true);source.bundle.project.products.push({...source.bundle.project.products[0],id:'demo-self',role:'self',demo:true});assert.equal(archiveReadiness(source.bundle,'original',stamp,input(),true).checks.find(c=>c.id==='gsb').passed,false);});
test('all assigned quality judgments must be valid, and duplicate review sample questions cannot close coverage',()=>{const source=setup(true);const review=source.bundle.quality.tasks.filter(t=>t.kind==='review');source.bundle.quality.judgments.find(j=>j.taskId===review[0].id).unable=true;source.bundle.quality.judgments.find(j=>j.taskId===review[0].id).notes='无法判断';assert.equal(archiveReadiness(source.bundle,'original',stamp,input(),true).checks.find(c=>c.id==='quality-coverage').passed,false);});
test('operator must belong to the project and independent spaces cannot archive full data',async()=>{const source=setup();await assert.rejects(()=>build(source,{operatorId:'stranger'}),/负责人/);source.bundle.quality.space={type:'blind',batchId:'x',reviewerId:'m1'};await assert.rejects(()=>build(source),/独立评审/);});
test('manifest digest itself is verifiable independently of JSON key order',async()=>{const record=await build(setup());const {manifestHash,...unsigned}=record.manifest;assert.equal(manifestHash,sha(canonical(unsigned)));const filesReordered=files(record).reverse();const read=await readFinalArchive(filesReordered);assert.equal(read.record.id,record.id);});
test('unprepared configuration uses regular draft backup rather than an unmergeable archive',async()=>{const source=setup();source.bundle.project.rulesConfirmed=false;await assert.rejects(()=>build(source),/配置草稿可使用项目备份/);});

test('complete anchor workflow creates a final archive without changing legacy archive semantics',async()=>{const source=setup(true,true);assert.deepEqual(archiveReadiness(source.bundle,'original',stamp,input(),true).blockers,[]);const record=await build(source,{mode:'final'});assert.equal(record.manifest.calculationVersion,'ecommerce-anchors-v1');const read=await readFinalArchive(files(record));assert.equal(read.report.status,'final');assert.equal(read.bundle.evaluations[0].ratings.A.score,5);assert.match(await record.files.find(f=>f.name.endsWith('.report.md')).blob.text(),/总分 \/5/);});

test('new anchor archives roundtrip optional empty reasons and render clean score lines',async()=>{
 const source=setup(true,true);
 for(const row of [...source.bundle.evaluations,...source.bundle.walkthroughs,...source.bundle.quality.judgments,...source.bundle.quality.decisions])for(const rating of Object.values(row.ratings??{}))rating.reason='';
 source.bundle.evaluations[0].ratings.B.reason='   ';
 const record=await build(source,{mode:'final'}),read=await readFinalArchive(files(record));
 assert.equal(record.manifest.reportVersion,'report-v4');
 assert.equal(record.manifest.calculationVersion,'ecommerce-anchors-v1');
 assert.equal(read.report.status,'final');
 assert.equal(read.bundle.evaluations[0].ratings.A.reason,'');
 assert.equal(read.bundle.walkthroughs[0].ratings.D.reason,'');
 assert.equal(read.bundle.quality.judgments[0].ratings.A.reason,'');
 const md=await record.files.find(file=>file.name.endsWith('.report.md')).blob.text();
 assert.match(md,/评分依据选填/);
 const scoreLines=md.split('\n').filter(line=>/^- .* \/ [ABCFG]：/.test(line));
 assert(scoreLines.length>0);
 assert(scoreLines.every(line=>/：5 分$/.test(line)));
});

test('old anchor archives without a rendering marker retain exact original Markdown verification',async()=>{
 const source=setup(false,true),record=await build(source);
 const legacyFiles=await altered(record,async(manifest,list)=>{
  delete manifest.reportVersion;
  const checked=archiveReadiness(source.bundle,manifest.basis,manifest.createdAt,input(),true,{legacyRequiredReasons:true,reportVersion:'report-v1'});
  manifest.checks=checked.checks;
  const jsonFile=list.find(file=>file.name.endsWith('.report.json'));
  const archived=JSON.parse(await jsonFile.text());delete archived.comparison;
  delete archived.comparison;Object.assign(archived,checked.report,{format:archived.format,status:archived.status,scope:archived.scope,checks:manifest.checks});
  await replaceContent(manifest,list,'report-json',JSON.stringify(archived));
  const md=legacyArchivedMarkdown(source,manifest);
  assert.match(md,/选 1–5 分并填写依据/);
  assert.doesNotMatch(md,/评分依据选填/);
  await replaceContent(manifest,list,'report-md',md);
 });
 const read=await readFinalArchive(legacyFiles);
 assert.equal(read.record.manifest.reportVersion,undefined);
 assert.equal(read.record.manifest.calculationVersion,'ecommerce-anchors-v1');
 assert.equal(read.bundle.evaluations[0].ratings.A.reason,'合成评分依据');
 assert.equal(read.report.results[0].dimensions.A.value,5);
 const onlyRelabelled=await altered(record,manifest=>{delete manifest.reportVersion;});
 await assert.rejects(()=>readFinalArchive(onlyRelabelled),/报告内容|归档检查结果/);
});

test('unknown report renderer cannot bypass archive semantic checks after re-signing',async()=>{
 const record=await build(setup());
 const future=await altered(record,manifest=>{manifest.reportVersion='report-v99';});
 await assert.rejects(()=>readFinalArchive(future),/报告版本/);
});

test('old checkpoints retain invalid empty reasons and missing scores without gaining newly valid submissions',async()=>{
 const source=setup(false,true);
 source.bundle.evaluations[0].ratings.A.reason='';
 delete source.bundle.evaluations[1].ratings.G;
 source.bundle.walkthroughs[0].ratings.D.reason='';
 source.bundle.evaluations[2].seconds=null;
 const record=await build(source);
 const legacyFiles=await altered(record,async(manifest,list)=>{
  delete manifest.reportVersion;
  const checked=archiveReadiness(source.bundle,manifest.basis,manifest.createdAt,input(),true,{legacyRequiredReasons:true,reportVersion:'report-v1'});
  manifest.checks=checked.checks;
  const jsonFile=list.find(file=>file.name.endsWith('.report.json'));
  const archived=JSON.parse(await jsonFile.text());
  delete archived.comparison;Object.assign(archived,checked.report,{format:archived.format,status:archived.status,scope:archived.scope,checks:manifest.checks});
  await replaceContent(manifest,list,'report-json',JSON.stringify(archived));
  await replaceContent(manifest,list,'report-md',legacyArchivedMarkdown(source,manifest));
 });
 const legacy=await readFinalArchive(legacyFiles);
 assert.equal(legacy.report.results[0].submitted,0);
 assert.equal(legacy.report.results[0].dimensions.D.n,2);
 assert(legacy.report.results[0].missing.some(message=>message.includes('G 维度尚未按锚点打分并填写依据')));
 assert(legacy.report.results[0].missing.some(message=>message.includes('A 维度分数或评分依据无效')));
 assert(legacy.report.results[1].missing.some(message=>message.includes('生成耗时须为大于或等于 0 的有限秒数')));
 assert.equal(legacy.bundle.evaluations[0].ratings.A.reason,'');
 const current=await readFinalArchive(files(record));
 assert.equal(current.report.results[0].submitted,1);
 assert.equal(current.report.results[0].dimensions.D.n,3);
});

test('v2 archives retain their joint-review checks and exact report content after the self-only workflow update',async()=>{
 const source=setup(false,true),record=await build(source);
 const legacyFiles=await altered(record,async(manifest,list)=>{
  manifest.reportVersion='report-v2';
  const checked=archiveReadiness(source.bundle,manifest.basis,manifest.createdAt,input(),true,{reportVersion:'report-v2'});
  manifest.checks=checked.checks;
  const archived=JSON.parse(await list.find(file=>file.name.endsWith('.report.json')).text());delete archived.comparison;
  Object.assign(archived,checked.report,{format:archived.format,status:archived.status,scope:archived.scope,checks:manifest.checks});
  await replaceContent(manifest,list,'report-json',JSON.stringify(archived));
  await replaceContent(manifest,list,'report-md',legacyArchivedMarkdown(source,manifest,'report-v2'));
 });
 const read=await readFinalArchive(legacyFiles);
 assert.equal(read.record.manifest.reportVersion,'report-v2');
 assert(read.report.checks.some(c=>c.id==='joint'&&!c.passed));
 assert.equal(read.report.comparison,undefined);
});

test('v4 archives roundtrip blank walkthrough steps; v3 archives retain their original missing-score result',async()=>{
 const source=setup(false,true);source.bundle.walkthroughs.forEach(task=>task.steps=null);
 const record=await build(source),current=await readFinalArchive(files(record));
 assert.equal(record.manifest.reportVersion,'report-v4');assert.equal(current.report.results[0].dimensions.D.n,3);assert(current.bundle.walkthroughs.every(task=>task.steps===null));
 const legacyFiles=await altered(record,async(manifest,list)=>{
  manifest.reportVersion='report-v3';
  const checked=archiveReadiness(source.bundle,manifest.basis,manifest.createdAt,input(),true,{reportVersion:'report-v3'});manifest.checks=checked.checks;
  const archived=JSON.parse(await list.find(file=>file.name.endsWith('.report.json')).text());
  Object.assign(archived,checked.report,{format:archived.format,status:archived.status,scope:archived.scope,checks:manifest.checks});
  await replaceContent(manifest,list,'report-json',JSON.stringify(archived));
  await replaceContent(manifest,list,'report-md',legacyArchivedMarkdown(source,manifest,'report-v3'));
 });
 const legacy=await readFinalArchive(legacyFiles);assert.equal(legacy.report.results[0].dimensions.D.n,0);assert.equal(legacy.report.results[0].dimensions.D.value,null);
 assert(legacy.report.results[0].dimensions.D.reasons.some(message=>message.includes('操作步数未完整记录')));
});
