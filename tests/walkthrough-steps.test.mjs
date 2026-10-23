import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/formal-fixture.mjs';
import {validateWalkthrough,summarizeProject} from '../src/core/assessment.ts';
import {defaultAnchors} from '../src/core/ratings.ts';
import {buildReport} from '../src/core/report.ts';

test('missing walkthrough steps stay unknown and do not change completed task scores',()=>{
 const b=fixture(2,2),before=summarizeProject(b).map(r=>r.dimensions.D.value);
 b.walkthroughs.forEach(task=>task.steps=null);
 b.walkthroughs.forEach(task=>assert.deepEqual(validateWalkthrough(b.project,task),[]));
 assert.deepEqual(summarizeProject(b).map(r=>r.dimensions.D.value),before);
 assert(b.walkthroughs.every(task=>task.steps===null));
});
test('provided walkthrough steps still reject negative, fractional, infinite and malformed values',()=>{
 const b=fixture(2,2),task=b.walkthroughs[0];
 for(const steps of [-1,1.5,NaN,Infinity,'2',undefined])assert.match(validateWalkthrough(b.project,{...task,steps}).join(';'),/操作步数须为非负整数/);
 for(const steps of [null,0,1,20])assert.deepEqual(validateWalkthrough(b.project,{...task,steps}),[]);
});
test('blank steps never substitute for a task outcome, problem tags or a missing D rating',()=>{
 const b=fixture(2,2),task={...b.walkthroughs[0],steps:null,completed:false};
 assert.match(validateWalkthrough(b.project,task).join(';'),/未完成.*D 标签/);
 b.project.scheme.rating={mode:'anchors',anchors:defaultAnchors()};
 assert.match(validateWalkthrough(b.project,{...task,completed:true}).join(';'),/D 维度尚未按锚点打分/);
 assert.deepEqual(validateWalkthrough(b.project,{...task,completed:true,ratings:{D:{score:4,reason:''}}}),[]);
});
test('old report versions retain required steps, while the current report uses optional steps',()=>{
 const b=fixture(2,2);b.walkthroughs.forEach(task=>task.steps=null);
 for(const version of ['report-v1','report-v2','report-v3']){
  const old=buildReport(b,'original','2026-10-22T12:00:00Z',false,{reportVersion:version});
  assert.equal(old.results[0].dimensions.D.n,0);assert(old.results[0].dimensions.D.reasons.some(s=>s.includes('操作步数未完整记录')));
 }
 const current=buildReport(b,'original','2026-10-22T12:00:00Z');assert.equal(current.results[0].dimensions.D.n,3);
 assert.equal(buildReport(b,'original','2026-10-22T12:00:00Z',false,{reportVersion:'report-v4'}).results[0].dimensions.D.n,3);
});
