import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareReferenceSave } from '../src/storage/referenceSave.ts';
import { fixture } from './helpers/formal-fixture.mjs';

const now = '2026-10-21T10:00:00.000Z';
const ref = (id, questionId = 'q1', name = 'serum.png') => ({ id, projectId: 'project', questionId, productId: null, role: 'reference', name, mime: 'image/png', size: 1, sha256: `hash-${id}`, createdAt: now });
function setup() {
  const bundle = fixture(2, 2);
  bundle.assets.push(ref('old-ref'));
  const record = { ...bundle.evaluations[0], referenceIds: ['old-ref'] };
  return { bundle, record };
}
function prepare(bundle, record, assets = [], change) {
  return prepareReferenceSave(bundle, record, assets, change, () => 'generated-revision', now);
}

 test('reference replacement appends a binding and retains immutable old image metadata and historical snapshots', () => {
  const { bundle, record } = setup();
  const before = structuredClone(bundle);
  const incoming = ref('new-ref');
  const selected = { ...record, referenceIds: ['new-ref'] };
  const prepared = prepare(bundle, selected, [incoming], {expectedHeadId: null, assetIds: ['new-ref'], id: 'ui-revision'});
  assert.deepEqual(prepared.assets, [...bundle.assets, incoming]);
  assert.deepEqual(prepared.nextReference, {id: 'ui-revision', projectId: 'project', questionId: 'q1', parentId: null, revision: 1, assetIds: ['new-ref'], createdAt: now});
  assert.deepEqual(bundle, before);
  assert.equal(prepared.assets.find(row => row.id === 'old-ref').sha256, 'hash-old-ref');
  assert.deepEqual(record.referenceIds, ['old-ref']);
});

test('removal persists an explicit empty selection rather than falling back to old stored reference assets', () => {
  const { bundle, record } = setup();
  const result = prepare(bundle, {...record, referenceIds: []}, [], {expectedHeadId: null, assetIds: []});
  assert.equal(result.assets.some(row => row.id === 'old-ref'), true);
  assert.deepEqual(result.nextReference.assetIds, []);
  const refreshed = { ...bundle, referenceRevisions: [result.nextReference] };
  assert.equal(prepare(refreshed, {...record, referenceIds: []}).nextReference, undefined);
  assert.throws(() => prepare(refreshed, record), /其他页面修改/);
});

test('reference selection is shared between products and compare-and-swap rejects a stale second browser tab', () => {
  const { bundle, record } = setup();
  const first = prepare(bundle, {...record, referenceIds: []}, [], {expectedHeadId: null, assetIds: [], id: 'first-head'});
  const fresh = {...bundle, referenceRevisions: [first.nextReference]};
  const otherProductRecord = {...bundle.evaluations.find(row => row.productId === 'p2' && row.questionId === 'q1'), referenceIds: ['old-ref']};
  assert.throws(() => prepare(fresh, otherProductRecord), /其他页面修改/);
  assert.throws(() => prepare(fresh, otherProductRecord, [], {expectedHeadId: null, assetIds: ['old-ref']}), /其他页面更新/);
  const restored = prepare(fresh, otherProductRecord, [], {expectedHeadId: 'first-head', assetIds: ['old-ref'], id: 'restored-head'});
  assert.equal(restored.nextReference.parentId, 'first-head');
  assert.equal(restored.nextReference.revision, 2);
  assert.deepEqual(restored.nextReference.assetIds, ['old-ref']);
});

test('an evaluation cannot silently bind a different snapshot from the requested reference change', () => {
  const { bundle, record } = setup();
  assert.throws(() => prepare(bundle, record, [], {expectedHeadId: null, assetIds: []}), /其他页面修改/);
  assert.throws(() => prepare(bundle, {...record, referenceIds: ['old-ref', 'old-ref']}), /快照不完整/);
  const {referenceIds: _omitted, ...legacy} = record;
  assert.throws(() => prepare(bundle, legacy), /快照不完整/);
});

test('draft reference bindings reject missing, foreign or output images and invalid revision IDs', () => {
  const { bundle, record } = setup();
  for (const id of ['missing', bundle.assets[0].id]) {
    assert.throws(() => prepare(bundle, {...record, referenceIds: [id]}, [], {expectedHeadId: null, assetIds: [id]}), /归属不匹配/);
  }
  bundle.assets.push(ref('other-question-ref', 'q2'));
  assert.throws(() => prepare(bundle, {...record, referenceIds: ['other-question-ref']}, [], {expectedHeadId: null, assetIds: ['other-question-ref']}), /归属不匹配/);
  assert.throws(() => prepare(bundle, record, [], {expectedHeadId: null, assetIds: ['old-ref'], id: ''}), /字段、归属或图片列表无效/);
  const next = prepare(bundle, record, [], {expectedHeadId: null, assetIds: ['old-ref'], id: 'used'});
  assert.throws(() => prepare({...bundle, referenceRevisions: [next.nextReference]}, record, [], {expectedHeadId: 'used', assetIds: ['old-ref'], id: 'used'}), /ID 重复/);
});

test('new uploads cannot overwrite old metadata or attach files belonging to another question or product', () => {
  const { bundle, record } = setup();
  assert.throws(() => prepare(bundle, record, [{...ref('old-ref'), sha256: 'changed'}]), /不能覆盖历史图片/);
  assert.throws(() => prepare(bundle, record, [ref('fresh', 'q2')]), /不属于本题或当前产品/);
  assert.throws(() => prepare(bundle, record, [{...ref('fresh'), role: 'output', productId: 'p2'}]), /不属于本题或当前产品/);
  assert.throws(() => prepare(bundle, record, [ref('fresh'), ref('fresh')]), /不能覆盖历史图片/);
});

test('legacy projects save an explicit current snapshot without inventing a reference revision when selection is unchanged', () => {
  const { bundle, record } = setup();
  const result = prepare(bundle, record);
  assert.equal('nextReference' in result, false);
  assert.deepEqual(result.assets, bundle.assets);
  const empty = fixture();
  assert.equal(prepare(empty, {...empty.evaluations[0], referenceIds: []}).nextReference, undefined);
});
