import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/formal-fixture.mjs';
import { makeReferenceRevision, resolveReferences, validateReferenceHistory } from '../src/core/references.ts';
import { summarizeProject, validateEvaluation } from '../src/core/assessment.ts';

const stamp = '2026-10-21T12:00:00.000Z';
const clone = value => structuredClone(value);
function setup() {
  const b = fixture(1, 2);
  const ref = (id, name, createdAt = stamp, questionId = 'q1') => ({ id, projectId:b.project.id, questionId, productId:null, role:'reference', name, mime:'image/png', size:1, sha256:`sha-${id}`, createdAt });
  b.project.questions[0].referenceNames = ['required.png'];
  b.assets.push(ref('ref-old','required.png','2026-10-20T12:00:00.000Z'),ref('ref-new','required.png'),ref('ref-extra','extra.png'),ref('ref-other','other.png',stamp,'q2'));
  return b;
}
function root(b, assetIds = ['ref-old','ref-extra']) { const row = makeReferenceRevision(b,'q1',assetIds,null,'ref-revision-1',stamp); b.referenceRevisions = [row]; return row; }

test('legacy references resolve one deterministic newest asset per name without mutating metadata', () => {
  const b=setup(),before=clone(b);
  assert.deepEqual(validateReferenceHistory(b.project,b.assets),[]);
  assert.deepEqual(resolveReferences(b,'q1').assets.map(a=>a.id),['ref-extra','ref-new']);
  assert.equal(resolveReferences(b,'q1').head,null);
  assert.deepEqual(resolveReferences({...b,assets:[...b.assets].reverse()},'q1'),resolveReferences(b,'q1'));
  assert.deepEqual(b,before);
  b.assets.find(a=>a.id==='ref-old').createdAt=stamp;
  assert.equal(resolveReferences(b,'q1').assets.find(a=>a.name==='required.png').id,'ref-new');
});

test('removal and replacement append linear selections while preserving original assets and prior revisions', () => {
  const b=setup(),assets=clone(b.assets),first=root(b),before=clone(first);
  const second=makeReferenceRevision(b,'q1',[],first.id,'ref-revision-2',stamp);
  b.referenceRevisions.push(second);
  assert.deepEqual(resolveReferences(b,'q1').assets,[]);
  const third=makeReferenceRevision(b,'q1',['ref-new'],second.id,'ref-revision-3',stamp);
  b.referenceRevisions.push(third);
  assert.equal(third.parentId,second.id);
  assert.equal(third.revision,3);
  assert.deepEqual(resolveReferences(b,'q1').assets.map(a=>a.id),['ref-new']);
  assert.deepEqual(first,before);
  assert.deepEqual(b.assets,assets);
  assert.deepEqual(validateReferenceHistory(b.project,b.assets,b.referenceRevisions),[]);
});

test('root selection may start empty and each question maintains an independent head', () => {
  const b=setup(),first=root(b,[]);
  const other=makeReferenceRevision(b,'q2',['ref-other'],null,'ref-q2-1',stamp);
  b.referenceRevisions.push(other);
  assert.equal(first.revision,1);
  assert.equal(first.parentId,null);
  assert.equal(resolveReferences(b,'q1').head.id,first.id);
  assert.equal(resolveReferences(b,'q2').head.id,other.id);
  assert.deepEqual(resolveReferences(b,'q2').assets.map(a=>a.id),['ref-other']);
});

test('stale heads, duplicate IDs, unknown questions and ambiguous required slots cannot create revisions', () => {
  const b=setup(),first=root(b);
  for(const [questionId,ids,expected,id] of [['q1',['ref-new'],null,'next'],['q1',['ref-new'],'stale','next'],['q1',['ref-new'],first.id,first.id],['unknown',[],null,'next'],['q1',['ref-old','ref-new'],first.id,'next']]) assert.throws(()=>makeReferenceRevision(b,questionId,ids,expected,id,stamp));
  assert.equal(b.referenceRevisions.length,1);
});

test('history rejects malformed fields, duplicate selections and mismatched reference ownership', () => {
  const b=setup(),first=root(b);
  for(const patch of [{id:''},{projectId:'foreign'},{questionId:'unknown'},{parentId:9},{revision:0},{revision:1.5},{createdAt:'invalid'},{assetIds:['ref-old','ref-old']},{assetIds:['missing']},{assetIds:['ref-other']},{assetIds:['p1-q1-1']},{extra:true}]) assert.ok(validateReferenceHistory(b.project,b.assets,[{...first,...patch}]).length,JSON.stringify(patch));
  for(const rows of [null,{},'invalid',[first,clone(first)]]) assert.ok(validateReferenceHistory(b.project,b.assets,rows).length);
  const foreign=clone(b.assets);foreign.find(a=>a.id==='ref-old').productId='p1';
  assert.match(validateReferenceHistory(b.project,foreign,[first]).join(),/归属/);
  assert.match(validateReferenceHistory(b.project,[...b.assets,clone(b.assets.find(a=>a.id==='ref-old'))],[first]).join(),/引用/);
});

test('orphaned, cyclic and branched histories fail closed instead of silently choosing a leaf', () => {
  const b=setup(),first=root(b),child={...first,id:'child',parentId:first.id,revision:2},branch={...child,id:'branch'};
  for(const rows of [[{...first,revision:2}],[{...first,parentId:'missing'}],[first,{...child,parentId:'missing'}],[first,{...child,revision:3}],[first,child,branch],[first,child,branch,{...branch,id:'grandchild',parentId:'child',revision:3}],[first,{...child,id:'cycle-a',parentId:'cycle-b',revision:3},{...child,id:'cycle-b',parentId:'cycle-a',revision:2}]]) {
    const result=resolveReferences({...b,referenceRevisions:rows},'q1');
    assert.ok(result.errors.length,JSON.stringify(rows));
    assert.equal(result.head,null);
    assert.deepEqual(result.assets,[]);
  }
});

test('only the current required-slot selection must be unambiguous, and malformed other-question histories also surface', () => {
  const b=setup(),first=root(b,['ref-old']);
  const second={...first,id:'second',parentId:first.id,revision:2,assetIds:['ref-old','ref-new']};
  assert.match(validateReferenceHistory(b.project,b.assets,[first,second]).join(),/同名歧义/);
  const third={...second,id:'third',parentId:second.id,revision:3,assetIds:['ref-new']};
  assert.deepEqual(validateReferenceHistory(b.project,b.assets,[first,second,third]),[]);
  assert.ok(resolveReferences({...b,referenceRevisions:[first,{...first,id:'q2-invalid',questionId:'q2',assetIds:['ref-other'],revision:2}]},'q1').errors.length);
});

test('new evaluation snapshots cannot be satisfied by a removed historical file with the same required name', () => {
  const b=setup(),record=b.evaluations[0];
  assert.deepEqual(validateEvaluation(b.project,record,b.assets),[]);
  record.referenceIds=[];
  assert.match(validateEvaluation(b.project,record,b.assets).join(),/参考图缺失：required.png/);
  record.referenceIds=['ref-extra'];
  assert.match(validateEvaluation(b.project,record,b.assets).join(),/参考图缺失：required.png/);
  record.referenceIds=['ref-new'];
  assert.deepEqual(validateEvaluation(b.project,record,b.assets),[]);
  for(const referenceIds of [null,'ref-new',['ref-new','ref-new'],['missing'],['ref-other'],['p1-q1-1'],['ref-old','ref-new']]) {
    record.referenceIds=referenceIds;
    assert.ok(validateEvaluation(b.project,record,b.assets).length,JSON.stringify(referenceIds));
  }
});

test('historic evaluation reference snapshots stay valid after current bindings are removed or replaced', () => {
  const b=setup(),record=b.evaluations[0],first=root(b,['ref-old']);
  record.referenceIds=['ref-old'];
  const second=makeReferenceRevision(b,'q1',[],first.id,'removed',stamp);
  b.referenceRevisions.push(second);
  assert.deepEqual(resolveReferences(b,'q1').assets,[]);
  assert.deepEqual(validateEvaluation(b.project,record,b.assets),[]);
  assert.equal(summarizeProject(b)[0].submitted,2);
  delete record.referenceIds;
  assert.deepEqual(validateEvaluation(b.project,record,b.assets),[]);
});
