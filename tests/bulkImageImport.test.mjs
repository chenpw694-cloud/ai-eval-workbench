import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { archiveSchemaVersion, validateBackupStructure } from '../src/core/backup.ts';
import { buildStagePackage, readStagePackage } from '../src/core/packages.ts';
import { planBulkImageImport, bulkImageImportFingerprint } from '../src/core/bulkImageImport.ts';
import { resolveReferences } from '../src/core/references.ts';
import { prepareReferenceSave } from '../src/storage/referenceSave.ts';
import { fixture } from './helpers/formal-fixture.mjs';

const now = '2026-10-21T20:00:00.000Z';
const sha = index => index.toString(16).padStart(64, '0');
const image = (id, role = 'output', questionId = 'q1', productId = 'p1', name = `${id}.png`, hash = sha(id.length)) => ({
  id, projectId: 'project', questionId, productId: role === 'reference' ? null : productId,
  role, name, mime: 'image/png', size: 8, sha256: hash, blob: new Blob(['png-test'], {type:'image/png'}), createdAt: now
});
const meta = ({blob: _blob, ...row}) => row;
function plan(bundle, images, options = {}) {
  let sequence = 0;
  return planBulkImageImport(bundle, images, options, () => `generated-${++sequence}`, now);
}
function applied(bundle, result) {
  return {...bundle, assets: [...bundle.assets, ...result.assets.map(meta)], evaluations: [...bundle.evaluations, ...result.evaluations], referenceRevisions: [...bundle.referenceRevisions ?? [], ...result.referenceRevisions]};
}

test('bulk output appends one draft per task, preserving scores, checks, best image, timing and revision ancestry', () => {
  const bundle = fixture(2, 2);
  const original = bundle.evaluations[0];
  original.tags = [{code: 'A-01', severity: 'P1'}];
  original.ratings = {A: {score: 4, reason: ''}};
  original.notes = '原备注';
  const before = structuredClone(bundle);
  const result = plan(bundle, [image('new-q1-a'), image('new-q1-b'), image('new-q2', 'output', 'q2')]);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.evaluations.length, 2);
  const next = result.evaluations[0];
  assert.equal(next.parentId, original.id);
  assert.equal(next.revision, 2);
  assert.equal(next.status, 'draft');
  for (const key of ['tags', 'ratings', 'notes', 'seconds', 'failed', 'failureReason', 'bestMediaId', 'reviewerId']) assert.deepEqual(next[key], original[key]);
  assert.deepEqual(next.mediaIds, [...original.mediaIds, 'new-q1-a', 'new-q1-b']);
  assert.deepEqual(next.mediaChecks, [...original.mediaChecks, {mediaId:'new-q1-a', usable:null, infringement:null}, {mediaId:'new-q1-b', usable:null, infringement:null}]);
  assert.deepEqual(next.referenceIds, []);
  assert.equal(result.summary.submittedToDraft, 2);
  assert.equal(result.summary.affectedQuestions, 2);
  assert.equal(result.summary.importedOutputs, 3);
  assert.deepEqual(bundle, before);
});

test('new output tasks remain unscored and unchecked, use a valid owner, and select only a sole image as best', () => {
  const bundle = fixture(2, 2); bundle.evaluations = []; bundle.assets = [];
  bundle.project.status = 'draft';
  bundle.project.products[1].ownerId = 'missing-owner';
  bundle.project.products[1].name = '';
  bundle.project.products[1].version = '';
  const result = plan(bundle, [image('sole'), image('other-a', 'output', 'q2', 'p2'), image('other-b', 'output', 'q2', 'p2')]);
  assert.deepEqual(result.blockers, []);
  const [first, second] = result.evaluations;
  assert.equal(first.parentId, null); assert.equal(first.revision, 1); assert.equal(first.reviewerId, 'm1');
  assert.equal(first.bestMediaId, 'sole'); assert.equal(second.bestMediaId, null); assert.equal(second.reviewerId, '');
  for (const row of result.evaluations) {
    assert.equal(row.status, 'draft'); assert.equal(row.seconds, null); assert.equal(row.ratings, undefined);
    assert.deepEqual(row.tags, []); assert.equal(row.mediaChecks.every(check => check.usable === null && check.infringement === null), true);
  }
  assert.equal(bundle.project.status, 'draft');
});

test('reference-only import creates a shared binding and no evaluation or automatic project activation', () => {
  const bundle = fixture(2, 2); bundle.project.status = 'draft';
  const result = plan(bundle, [image('ref-one', 'reference')]);
  assert.deepEqual(result.blockers, []); assert.equal(result.evaluations.length, 0);
  assert.equal(result.referenceRevisions.length, 1);
  assert.deepEqual(result.referenceRevisions[0].assetIds, ['ref-one']);
  assert.equal(result.summary.affectedTasks, 0); assert.equal(result.summary.affectedQuestions, 1);
  assert.equal(bundle.project.status, 'draft');
});

test('same-name references require explicit replacement and never overwrite immutable asset metadata', () => {
  const bundle = fixture();
  const old = meta(image('old-ref', 'reference', 'q1', null, 'required.png', sha(1)));
  bundle.assets.push(old); bundle.project.questions[0].referenceNames = ['required.png'];
  const replacement = image('replacement', 'reference', 'q1', null, 'required.png', sha(2));
  assert.match(plan(bundle, [replacement]).blockers.join(' '), /替换同名参考图/);
  const result = plan(bundle, [replacement], {replaceReferences:true});
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.referenceRevisions[0].assetIds, ['replacement']);
  const next = applied(bundle, result);
  assert.deepEqual(next.assets.find(row => row.id === old.id), old);
  assert.equal(resolveReferences(next, 'q1').assets[0].id, 'replacement');
});

test('multiple different files for one reference slot block even when replacement is enabled; exact batch duplicates skip', () => {
  const bundle = fixture();
  const first = image('first', 'reference', 'q1', null, 'slot.png', sha(1));
  const conflicting = image('second', 'reference', 'q1', null, 'slot.png', sha(2));
  assert.match(plan(bundle, [first, conflicting], {replaceReferences:true}).blockers.join(' '), /本批多张不同图片/);
  const same = {...conflicting, sha256:first.sha256};
  const result = plan(bundle, [first, same]);
  assert.deepEqual(result.blockers, []); assert.equal(result.assets.length, 1);
  assert.equal(result.summary.skippedDuplicates, 1);
});

test('reference removal stays removed unless explicitly restored; re-importing the same saved file reuses old metadata', () => {
  const bundle = fixture();
  const old = meta(image('removed-ref', 'reference', 'q1', null, 'slot.png', sha(3)));
  bundle.assets.push(old);
  bundle.referenceRevisions = [{id:'removed', projectId:'project', questionId:'q1', parentId:null, revision:1, assetIds:[], createdAt:now}];
  const result = plan(bundle, [image('incoming-copy', 'reference', 'q1', null, 'slot.png', sha(3))]);
  assert.deepEqual(result.blockers, []); assert.equal(result.assets.length, 0);
  assert.equal(result.summary.reusedReferences, 1); assert.equal(result.summary.importedReferences, 0);
  assert.equal(result.referenceRevisions[0].parentId, 'removed');
  assert.deepEqual(result.referenceRevisions[0].assetIds, ['removed-ref']);
  assert.deepEqual(resolveReferences(applied(bundle, result), 'q1').assets, [old]);
});

test('current references and output copies skip; historical removed outputs may be reattached without rewriting bytes', () => {
  const bundle = fixture();
  const ref = meta(image('active-ref', 'reference', 'q1', null, 'slot.png', sha(4)));
  bundle.assets.push(ref);
  const current = bundle.assets.find(asset => asset.id === bundle.evaluations[0].mediaIds[0]);
  current.sha256 = sha(5); current.size = 8;
  const deleted = meta(image('deleted-output', 'output', 'q1', 'p1', 'old-output.png', sha(6)));
  bundle.assets.push(deleted);
  const result = plan(bundle, [image('same-ref', 'reference', 'q1', null, 'slot.png', sha(4)), image('same-out', 'output', 'q1', 'p1', current.name, sha(5)), image('reattach', 'output', 'q1', 'p1', deleted.name, sha(6))]);
  assert.deepEqual(result.blockers, []); assert.equal(result.assets.length, 0);
  assert.equal(result.summary.skippedDuplicates, 2); assert.equal(result.summary.importedOutputs, 1);
  assert.equal(result.referenceRevisions.length, 0);
  assert.deepEqual(result.evaluations[0].mediaIds, [...bundle.evaluations[0].mediaIds, 'deleted-output']);
  assert.deepEqual(result.evaluations[0].mediaChecks.at(-1), {mediaId:'deleted-output', usable:null, infringement:null});
});

test('mixed reference and output imports pin the post-import reference snapshot and satisfy single-save reference semantics', () => {
  const bundle = fixture(2, 2);
  const result = plan(bundle, [image('q1-ref', 'reference'), image('q1-output'), image('q1-output-other', 'output', 'q1', 'p2')]);
  assert.deepEqual(result.blockers, []);
  const postRefs = {...bundle, assets:[...bundle.assets, ...result.assets.map(meta)], referenceRevisions:result.referenceRevisions};
  for (const record of result.evaluations) {
    assert.deepEqual(record.referenceIds, ['q1-ref']);
    assert.doesNotThrow(() => prepareReferenceSave(postRefs, record, [], undefined, () => 'unused', now));
  }
});

test('duplicate output identity is scoped to question and product; filenames with different bytes append', () => {
  const bundle = fixture(2, 2); bundle.assets = []; bundle.evaluations = [];
  const rows = [image('one', 'output', 'q1', 'p1', '1.png', sha(1)), image('one-copy', 'output', 'q1', 'p1', '1.png', sha(1)), image('different', 'output', 'q1', 'p1', '1.png', sha(2)), image('other-product', 'output', 'q1', 'p2', '1.png', sha(1)), image('other-question', 'output', 'q2', 'p1', '1.png', sha(1))];
  const result = plan(bundle, rows);
  assert.deepEqual(result.blockers, []); assert.equal(result.summary.importedOutputs, 4);
  assert.equal(result.summary.skippedDuplicates, 1); assert.equal(result.summary.affectedTasks, 3);
});

test('forked output histories, stale hashes, invalid ownership and reusing old asset IDs block the whole write', () => {
  const bundle = fixture();
  const original = bundle.evaluations[0];
  bundle.evaluations.push({...original, id:'fork', revision:2, parentId:null});
  assert.match(plan(bundle, [image('new')]).blockers.join(' '), /分叉或断链/);
  bundle.evaluations.pop(); original.schemeHash = 'stale';
  assert.match(plan(bundle, [image('new')]).blockers.join(' '), /快照不匹配/);
  assert.match(plan(bundle, [image('bad', 'output', 'missing')]).blockers.join(' '), /归属无效/);
  assert.match(plan(bundle, [image(bundle.assets[0].id)]).blockers.join(' '), /不能覆盖历史原图/);
  assert.match(plan(bundle, [image('duplicate'), image('duplicate')]).blockers.join(' '), /ID 重复/);
});

test('asset and selection limits prevent an import that cannot round-trip through existing backup/package schemas', () => {
  const bundle = fixture(1, 1);
  bundle.assets.push(...Array.from({length:9999}, (_,index) => ({...bundle.assets[0], id:`old-${index}`})));
  assert.match(plan(bundle, [image('too-many')]).blockers.join(' '), /项目图片总量/);
  assert.match(plan(fixture(), Array(10001).fill(image('same'))).blockers.join(' '), /单次批量导入最多/);
});

test('snapshot fingerprint ignores IndexedDB row ordering but detects every project, reference, asset and evaluation mutation', () => {
  const bundle = fixture();
  const first = bulkImageImportFingerprint(bundle);
  const reordered = {...bundle, evaluations:[...bundle.evaluations].reverse(), assets:[...bundle.assets].reverse(), referenceRevisions:[]};
  assert.equal(bulkImageImportFingerprint(reordered), first);
  for (const change of [copy => {copy.evaluations[0].notes='changed';}, copy => {copy.assets[0].name='changed';}, copy => {copy.project.revision++;}, copy => {copy.project.questionsHash='changed';}, copy => {copy.referenceRevisions=[{id:'new-ref-head'}];}]) {
    const copy = structuredClone(bundle); change(copy); assert.notEqual(bulkImageImportFingerprint(copy), first);
  }
});


test('bulk drafts and reference selections round-trip through existing schema 3 backup and stage packages', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
  const bundle = fixture(1, 1);
  bundle.project.schemeHash = hash(canonical(bundle.project.scheme));
  bundle.project.questionsHash = hash(canonical(bundle.project.questions));
  for (const row of bundle.evaluations) {row.schemeHash = bundle.project.schemeHash; row.questionsHash = bundle.project.questionsHash;}
  for (const asset of bundle.assets) {asset.sha256 = hash(png); asset.size = png.length;}
  const incoming = [image('round-ref', 'reference'), image('round-output')].map(row => ({...row, sha256:hash(png), size:png.length, blob:new Blob([png], {type:'image/png'})}));
  const result = plan(bundle, incoming);
  assert.deepEqual(result.blockers, []);
  const after = applied(bundle, result);
  const snapshots = [structuredClone(after.project)];
  assert.equal(archiveSchemaVersion(after), 3);
  assert.deepEqual(validateBackupStructure({format:'eval-studio-project-backup', schemaVersion:3, bundle:after, snapshots, blobs:[{sha256:hash(png), mime:'image/png', data:png.toString('base64')}]}), []);
  const packaged = await buildStagePackage({bundle:after, snapshots, kind:'baseline', senderId:'m1', productIds:['p1'], packageId:'bulk-import-roundtrip'}, async id => {
    const asset = after.assets.find(row => row.id === id);
    return asset ? {...asset, blob:new Blob([png], {type:'image/png'})} : undefined;
  }, {packageId:'bulk-import-roundtrip', now});
  const restored = await readStagePackage(packaged.files.map(file => new File([file.blob], file.name)));
  assert.equal(restored.manifest.schemaVersion, 3);
  assert.deepEqual(restored.manifest.bundle.evaluations.at(-1), after.evaluations.at(-1));
  assert.deepEqual(resolveReferences(restored.manifest.bundle, 'q1').assets.map(asset => asset.id), ['round-ref']);
});

test('new revisions never reuse IDs and conflicting byte metadata cannot enter a package', () => {
  const bundle = fixture();
  const result = planBulkImageImport(bundle, [image('incoming')], {}, () => bundle.evaluations[0].id, now);
  assert.match(result.blockers.join(' '), /新修订 ID/);
  assert.match(plan(bundle, [image('a', 'output', 'q1', 'p1', 'a.png', sha(99)), {...image('b', 'output', 'q2', 'p1', 'b.png', sha(99)), size:9}]).blockers.join(' '), /格式或大小不一致/);
});
