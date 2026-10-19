import { fixture } from './helpers/formal-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { blindQualityBundle, createQualityBatch, disagreement, emptyQuality, finalQualityBundle, latestQuality, mergeQuality, qualitySummary, seededSample, validateQuality, validateQualityReturn } from '../src/core/quality.ts';
import { buildStagePackage, readStagePackage } from '../src/core/packages.ts';
import { planMerge } from '../src/core/merge.ts';
const stamp = '2026-10-20T12:00:00.000Z';
const clone = value => structuredClone(value);




let counter=0;const id=()=>`quality-${++counter}`;
const batch=(b,kind='review')=>{b.quality=createQualityBatch(b,kind,'fixed-seed',id,stamp);return b.quality;};
const judge=(task,patch={})=>({id:id(),taskId:task.id,parentId:null,revision:1,reviewerId:task.reviewerId,tags:[],choice:task.kind==='gsb'?'tie':null,unable:false,exposed:false,notes:'',createdAt:stamp,...patch});
test('seeded sampling is deterministic, unique and independent of input order',()=>{const ids=Array.from({length:50},(_,i)=>String(i));assert.deepEqual(seededSample(ids,10,'seed'),seededSample([...ids].reverse(),10,'seed'));assert.equal(new Set(seededSample(ids,10,'seed')).size,10);assert.notDeepEqual(seededSample(ids,10,'seed'),seededSample(ids,10,'another'));});
test('formal calibration freezes five shared questions and three independent people per product',()=>{const b=fixture(3,50);const q=batch(b,'calibration');assert.equal(q.tasks.length,45);assert.equal(q.batches[0].sampled.length,5);assert.equal(q.batches[0].trial,false);assert.deepEqual(validateQuality(q,b),[]);assert.throws(()=>createQualityBatch(b,'calibration','newseed',id,stamp),/已有/);});
test('small trial is explicit and cannot trigger official 3-of-10 logic',()=>{const b=fixture();const q=batch(b);q.judgments=q.tasks.map(task=>judge(task,{tags:[{code:'A-01',severity:'P0'}]}));assert.ok(qualitySummary(b).reviews.every(row=>row.trial&&!row.trigger));});
test('cross review assigns a different member and all product samples retain baseline IDs',()=>{const b=fixture(3,50);const q=batch(b);assert.equal(q.tasks.length,30);for(const task of q.tasks){assert.notEqual(task.reviewerId,b.project.products.find(p=>p.id===task.evidence[0].productId).ownerId);assert.ok(b.evaluations.some(e=>e.id===task.evidence[0].baselineId));}assert.deepEqual(validateQuality(q,b),[]);});
test('missing unsampled primary tasks still prevents publishing review',()=>{const b=fixture(3,50);b.evaluations.pop();assert.throws(()=>batch(b),/所有真实产品/);});
test('calibration may use best-image drafts but needs a common evidence set',()=>{const b=fixture(3,5);b.evaluations.forEach(e=>e.status='draft');assert.equal(batch(b,'calibration').tasks.length,45);const c=fixture(3,5);c.evaluations[0].bestMediaId=null;assert.throws(()=>batch(c,'calibration'),/至少准备/);});
test('any dimension gap of two is a disagreement even if other dimensions match',()=>{const b=fixture();assert.equal(disagreement([], [{code:'A-06',severity:'P2'}],b),true);assert.equal(disagreement([], [{code:'A-06',severity:'P3'}],b),false);});
test('P1 to P2 and P0 to P1 changes are disagreements; G is outside image range',()=>{const b=fixture();assert.equal(disagreement([{code:'A-01',severity:'P1'}],[{code:'A-01',severity:'P2'}],b),true);assert.equal(disagreement([{code:'A-01',severity:'P0'}],[{code:'A-01',severity:'P1'}],b),true);assert.equal(disagreement([],[{code:'G-04',severity:'P1'}],b),false);});
test('exactly three disagreements does not trigger; four of ten triggers full recheck',()=>{const b=fixture(3,50);const q=batch(b);const tasks=q.tasks.filter(t=>t.evidence[0].productId==='p1');q.judgments=tasks.map((t,i)=>judge(t,{tags:i<3?[{code:'A-01',severity:'P1'}]:[]}));assert.equal(qualitySummary(b).reviews.find(r=>r.productId==='p1').trigger,false);q.judgments[3].tags=[{code:'A-01',severity:'P1'}];assert.equal(qualitySummary(b).reviews.find(r=>r.productId==='p1').trigger,true);const next=createQualityBatch(b,'recheck','full',id,stamp,q.batches[0].id);assert.equal(next.tasks.filter(t=>t.kind==='recheck').length,50);assert.equal(next.batches.at(-1).sourceBatchId,q.batches[0].id);});
test('incomplete review never triggers and unable judgments do not inflate denominator',()=>{const b=fixture(3,50);const q=batch(b);q.judgments=q.tasks.slice(0,9).map(t=>judge(t,{tags:[{code:'A-01',severity:'P1'}]}));assert.equal(qualitySummary(b).reviews[0].completed,9);assert.equal(qualitySummary(b).reviews[0].trigger,false);q.judgments[0].unable=true;q.judgments[0].notes='原图缺失';assert.equal(qualitySummary(b).reviews[0].completed,8);});
test('independent historical revisions survive; only the unique latest contributes',()=>{const b=fixture();const q=batch(b);const first=judge(q.tasks[0]);q.judgments=[first,{...first,id:id(),parentId:first.id,revision:2,tags:[{code:'A-01',severity:'P1'}]}];assert.equal(latestQuality(q.judgments,r=>r.taskId)[0].revision,2);assert.equal(q.judgments.length,2);assert.deepEqual(validateQuality(q,b),[]);q.judgments.push({...first,id:id(),parentId:first.id,revision:2});assert.ok(validateQuality(q,b).some(x=>x.includes('分叉')));});
test('wrong author, wrong task evidence and invalid tag adjustments are rejected',()=>{for(const mode of ['author','asset','tag']){const b=fixture();const q=batch(b);q.judgments=[judge(q.tasks[0])];if(mode==='author')q.judgments[0].reviewerId='stranger';if(mode==='asset')q.tasks[0].evidence[0].mediaIds=['unknown'];if(mode==='tag')q.judgments[0].tags=[{code:'F-01',severity:'P1'}];assert.ok(validateQuality(q,b).length);}});
test('GSB requires one self, separates simulated comparisons and counts ties',()=>{const b=fixture(3,2);assert.throws(()=>batch(b,'gsb'),/自家/);b.project.products[0].role='self';b.project.products[0].demo=true;const q=batch(b,'gsb');assert.equal(q.tasks.length,4);q.judgments=q.tasks.map((t,i)=>judge(t,{choice:i===0?'win':'tie'}));assert.deepEqual(validateQuality(q,b),[]);const rows=qualitySummary(b).gsb;assert.ok(rows.every(row=>row.demo));assert.equal(rows.reduce((sum,row)=>sum+row.ties,0),3);assert.equal(rows[0].net,.5);});
test('exposure and overlapping calibration attendance are retained',()=>{const b=fixture(3,5);batch(b,'calibration');b.quality.judgments=b.quality.tasks.map(t=>judge(t));b.quality=createQualityBatch(b,'review','next',id,stamp);assert.ok(b.quality.tasks.filter(t=>t.kind==='review').every(t=>t.previouslySeen));});
test('objective package physically removes original labels, checks, remarks, costs and audits',()=>{const b=fixture();b.evaluations[0].notes='SECRET_INITIAL_NOTE';b.evaluations[0].tags=[{code:'A-01',severity:'P1'}];b.evaluations[0].mediaChecks[0].usable=false;b.assets[0].name='P1-secret.png';const q=batch(b);q.judgments=[judge(q.tasks[0],{notes:'SECRET_OTHER_JUDGMENT'})];const projected=blindQualityBundle(b,q.batches[0].id,q.tasks[0].reviewerId);const serialized=JSON.stringify(projected);assert.equal(projected.evaluations.length,0);assert.equal(projected.walkthroughs.length,0);assert.ok(projected.project.products.every(p=>p.totalCost===null&&p.commercialUse==='unreviewed'));assert.ok(!serialized.includes('SECRET_'));assert.ok(!serialized.includes('P1-secret'));assert.equal(projected.quality.judgments.length,0);assert.ok(projected.quality.tasks.every(t=>t.reviewerId===q.tasks[0].reviewerId));assert.deepEqual(validateQuality(projected.quality,projected),[]);});
test('return package includes only assigned judgments and no final references',()=>{const b=fixture();const q=batch(b);q.judgments=q.tasks.map(t=>judge(t));q.finals=[];const projected=blindQualityBundle(b,q.batches[0].id,q.tasks[0].reviewerId,true);assert.equal(projected.quality.space.type,'return');assert.equal(projected.quality.judgments.length,2);assert.equal(projected.quality.finals,undefined);});
test('union is idempotent, preserves judgments and rejects same-ID mutation',()=>{const b=fixture();const q=batch(b);q.judgments=[judge(q.tasks[0])];assert.equal(mergeQuality(q,q,b).judgments.length,1);const altered=clone(q);altered.judgments[0].notes='altered';assert.throws(()=>mergeQuality(q,altered,b),/同 ID/);});
test('adjudication projects final tags without mutating original agreement or history',()=>{const b=fixture();const q=batch(b);const task=q.tasks[0];const judgment=judge(task,{tags:[{code:'A-01',severity:'P1'}]});q.judgments=[judgment];const decision={id:id(),taskId:task.id,judgmentId:judgment.id,parentId:null,participants:['m1','m2'],tags:judgment.tags,usable:false,reason:'共同核验商品结构',createdAt:stamp};q.decisions=[decision];q.finals=[{baselineId:task.evidence[0].baselineId,decisionId:decision.id}];assert.deepEqual(validateQuality(q,b),[]);const rate=qualitySummary(b).reviews[0].rate;const final=finalQualityBundle(b);assert.equal(b.evaluations[0].tags.length,0);assert.equal(final.evaluations[0].tags[0].severity,'P1');assert.equal(final.evaluations[0].mediaChecks[0].usable,false);assert.equal(qualitySummary(b).reviews[0].rate,rate);});
test('missing participant/reason and contradictory usability cannot become decisions',()=>{const b=fixture();const q=batch(b);const row=judge(q.tasks[0]);q.judgments=[row];q.decisions=[{id:id(),taskId:row.taskId,judgmentId:row.id,parentId:null,participants:[],tags:[{code:'A-01',severity:'P1'}],usable:true,reason:'',createdAt:stamp}];assert.ok(validateQuality(q,b).some(x=>x.includes('裁决')));});

test('a complete quality payload survives ZIP export/read with physically redacted assignments',async()=>{
  const b=fixture();
  const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
  const hash=value=>createHash('sha256').update(value).digest('hex');
  b.project.schemeHash=hash(canonical(b.project.scheme));b.project.questionsHash=hash(canonical(b.project.questions));
  b.evaluations.forEach(row=>{row.schemeHash=b.project.schemeHash;row.questionsHash=b.project.questionsHash;row.notes='ORIGINAL_SECRET';});
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=','base64');
  b.assets.forEach(asset=>{asset.size=bytes.length;asset.sha256=hash(bytes);});
  const state=batch(b), task=state.tasks[0];state.judgments=[judge(task)];
  const loader=async assetId=>({...b.assets.find(asset=>asset.id===assetId),blob:new Blob([bytes],{type:'image/png'})});
  const full=await buildStagePackage({bundle:b,snapshots:[b.project],kind:'baseline',senderId:'m1',productIds:b.project.products.map(p=>p.id)},loader,{packageId:'quality-full'});
  const loaded=await readStagePackage(full.files.map(f=>new File([f.blob],f.name)));
  assert.deepEqual(loaded.manifest.bundle.quality,state);
  const objective=blindQualityBundle(b,state.batches[0].id,task.reviewerId);
  const exported=await buildStagePackage({bundle:objective,snapshots:[objective.project],kind:'baseline',senderId:task.reviewerId,productIds:b.project.products.map(p=>p.id)},loader,{packageId:'quality-blind'});
  assert.ok(!JSON.stringify(exported.manifest).includes('ORIGINAL_SECRET'));
  const checked=await readStagePackage(exported.files.map(f=>new File([f.blob],f.name)));
  assert.equal(checked.manifest.bundle.quality.judgments.length,0);
  assert.equal(checked.blobs.size,1);
});
test('regular stage merge retains quality state and refuses conflicting quality IDs',()=>{
 const b=fixture();const q=batch(b);q.judgments=[judge(q.tasks[0])];const stage={packageId:'stage',kind:'baseline',senderId:'m1',productIds:b.project.products.map(p=>p.id),bundle:b,snapshots:[b.project]};
 const merged=planMerge(null,stage);assert.deepEqual(merged.merged.quality,q);assert.deepEqual(merged.blockers,[]);
 const conflicting=clone(b);conflicting.quality.judgments[0].notes='different';assert.ok(planMerge(conflicting,stage).blockers.some(message=>message.includes('质检同 ID')));
});
test('assigned but unfinished calibration is not recorded as prior attendance',()=>{const b=fixture(3,5);batch(b,'calibration');b.quality=createQualityBatch(b,'review','next',id,stamp);assert.ok(b.quality.tasks.filter(task=>task.kind==='review').every(task=>!task.previouslySeen));});
test('returned assignments must bind identical image bytes, product identities and fixed tasks',()=>{
 const b=fixture();const q=batch(b);const returned=blindQualityBundle(b,q.batches[0].id,q.tasks[0].reviewerId,true);
 assert.deepEqual(validateQualityReturn(b,returned),[]);
 for(const change of ['hash','product','task']){const altered=clone(returned);if(change==='hash')altered.assets[0].sha256='other';if(change==='product')altered.project.products[0].name='other';if(change==='task')altered.quality.tasks[0].evidence[0].bestMediaId=null;assert.ok(validateQualityReturn(b,altered).length);}
});
test('blind protocol refuses hidden extra answer fields',()=>{const b=fixture();const q=batch(b);const objective=blindQualityBundle(b,q.batches[0].id,q.tasks[0].reviewerId);objective.quality.tasks[0].originalTags=['secret'];assert.ok(validateQuality(objective.quality,objective).some(message=>message.includes('非协议字段')));});
test('zero-output GSB can be explicitly unjudgeable without fabricating a tie',()=>{const b=fixture();b.project.products[0].role='self';const q=batch(b,'gsb');q.tasks[0].evidence[0].bestMediaId=null;q.judgments=[judge(q.tasks[0],{choice:null,unable:true,notes:'没有有效出图'})];assert.deepEqual(validateQuality(q,b),[]);assert.equal(qualitySummary(b).gsb[0].n,0);});
