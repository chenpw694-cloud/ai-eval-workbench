import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/formal-fixture.mjs';
import { createQualityBatch, emptyQuality, validateQuality } from '../src/core/quality.ts';
import { buildReport, reportMarkdown } from '../src/core/report.ts';
import { emptyReportNotes, validateReportNotes } from '../src/core/report-notes.ts';
import { selfComparisonEvidence } from '../src/core/selfComparison.ts';

const stamp='2026-10-22T12:00:00Z';let sequence=0;const id=()=>`self-${++sequence}`;
function setup(count=50) {
  const b=fixture(4,count);
  b.project.members.pop();b.project.products[3].ownerId='m1';
  b.evaluations.filter(row=>row.productId==='p4').forEach(row=>row.reviewerId='m1');
  b.project.products[3].role='self';b.quality=emptyQuality();
  b.quality=createQualityBatch(b,'gsb','self-only',id,stamp);
  b.quality.judgments=b.quality.tasks.map(task=>({id:id(),parentId:null,revision:1,taskId:task.id,reviewerId:task.reviewerId,choice:'win',tags:[],unable:false,exposed:false,notes:'',createdAt:stamp}));
  b.quality.reportNotes=[{...emptyReportNotes(),id:id(),parentId:null,createdAt:stamp,participants:b.project.members.map(m=>m.id),summary:'各竞品相对自家的结论',productInsights:'优势与短板',recommendations:'改进建议',consistencyExplanation:'GSB 与维度分的关系',featureComparison:'功能与授权依据',limitations:'人员和随机性',caseQuestionIds:['q1','q2','q3']}];
  return b;
}
const check=(b,key)=>buildReport(b,'original',stamp).checks.find(row=>row.id===key);
test('three owners compare their own competitor against one shared self, without competitor pairs',()=>{
  const b=setup();assert.equal(b.quality.tasks.length,150);
  assert(b.quality.tasks.every(task=>task.evidence[0].productId==='p4'&&task.evidence[1].productId!=='p4'));
  for(const task of b.quality.tasks)assert.equal(task.reviewerId,b.project.products.find(p=>p.id===task.evidence[1].productId).ownerId);
  assert.deepEqual(validateQuality(b.quality,b),[]);
});
test('completed self GSB and cases do not require a joint plan, while quality checks remain explicit',()=>{
  const b=setup(),r=buildReport(b,'original',stamp);
  assert.equal(b.quality.joint,undefined);assert.equal(r.checks.some(c=>c.id==='joint'),false);
  assert.equal(check(b,'gsb').passed,true);assert.equal(check(b,'cases').passed,true);
  assert.equal(check(b,'calibration').passed,false);assert.equal(check(b,'reviews').passed,false);
  assert.deepEqual(validateReportNotes(b.quality.reportNotes,b),[]);
  assert.equal(r.comparison.cases.length,150);
});
test('an unfinished GSB pair cannot silently become a complete report',()=>{
  const b=setup();b.quality.judgments.pop();assert.equal(check(b,'gsb').passed,false);
  assert.equal(selfComparisonEvidence(b).length,149);
});
test('unknown, unable and stale judgments cannot supply case evidence or image references',()=>{
  const b=setup(),q1=b.quality.tasks.filter(t=>t.questionId==='q1');
  for(const task of q1){const j=b.quality.judgments.find(j=>j.taskId===task.id);j.unable=true;j.choice=null;j.notes='无法判断';}
  assert(!selfComparisonEvidence(b).some(row=>row.questionId==='q1'));assert.equal(check(b,'cases').passed,false);
  const c=setup(),old=c.evaluations.find(row=>row.productId==='p4'&&row.questionId==='q2');
  c.evaluations.push({...old,id:id(),parentId:old.id,revision:2});
  assert(!selfComparisonEvidence(c).some(row=>row.questionId==='q2'));assert.equal(check(c,'baseline').passed,false);
});
test('self baseline is required and multiple self products cannot complete GSB',()=>{
  const b=setup();b.project.products[3].role='direct';assert.equal(check(b,'gsb').passed,false);assert.equal(selfComparisonEvidence(b).length,0);
  b.project.products[3].role='self';b.project.products[0].role='self';assert.equal(check(b,'gsb').passed,false);
});
test('new Markdown uses only self comparisons and cites fixed judgments and original hashes',()=>{
  const b=setup(),r=buildReport(b,'original',stamp),md=reportMarkdown(r);
  assert(!md.includes('## 联合对比评审'));assert(!md.includes('### 联合结论'));
  assert(md.includes('## 自家对竞品 GSB'));assert(md.includes('G 自家更好'));
  assert(md.includes(r.comparison.cases[0].judgmentId));assert(md.includes('sha-p4-q1-1'));
  assert(md.includes('150/150 个有效比较'));
});
test('case references must belong to fixed tasks; arbitrary question names are rejected',()=>{
  const b=setup();b.quality.reportNotes[0].caseQuestionIds=['foreign'];assert(validateReportNotes(b.quality.reportNotes,b).length);
});
test('each competitor starts independently when self and that competitor are ready, without waiting for other products',()=>{
  const b=setup();b.quality=emptyQuality();
  const later=b.evaluations.filter(row=>row.productId==='p2');b.evaluations=b.evaluations.filter(row=>row.productId!=='p2');
  b.quality=createQualityBatch(b,'gsb','first',id,stamp,null,['p1']);
  assert.equal(b.quality.tasks.length,50);assert(b.quality.tasks.every(t=>t.evidence[1].productId==='p1'));
  assert.throws(()=>createQualityBatch(b,'gsb','again',id,stamp,null,['p1']),/已有该竞品/);
  assert.throws(()=>createQualityBatch(b,'gsb','not-ready',id,stamp,null,['p2']),/缺少有效初评/);
  b.evaluations.push(...later);b.quality=createQualityBatch(b,'gsb','second',id,stamp,null,['p2']);
  assert.equal(b.quality.batches.length,2);assert.equal(b.quality.tasks.length,100);
  assert.deepEqual(validateQuality(b.quality,b),[]);
  assert.throws(()=>createQualityBatch(b,'gsb','self',id,stamp,null,['p4']),/有效且不重复/);
  assert.throws(()=>createQualityBatch(b,'gsb','foreign',id,stamp,null,['unknown']),/有效且不重复/);
});
