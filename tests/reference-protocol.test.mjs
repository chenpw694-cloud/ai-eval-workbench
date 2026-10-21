import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture } from './helpers/formal-fixture.mjs';
import { archiveSchemaVersion, validateBackupStructure } from '../src/core/backup.ts';
import { buildStagePackage, readStagePackage } from '../src/core/packages.ts';
import { planMerge, materializeMerge } from '../src/core/merge.ts';
import { createQualityBatch, blindQualityBundle, validateQuality, validateQualityReturn, qualityReferenceIds } from '../src/core/quality.ts';
import { resolveReferences } from '../src/core/references.ts';
import { archiveContentHash, buildFinalArchive, readFinalArchive } from '../src/core/archive.ts';
import { defaultAnchors } from '../src/core/ratings.ts';

const stamp = '2026-10-21T12:00:00.000Z';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
const clone = value => structuredClone(value);

function refreshHashes(bundle) {
  bundle.project.schemeHash = hash(bundle.project.scheme);
  bundle.project.questionsHash = hash(bundle.project.questions);
  for (const evaluation of bundle.evaluations) {
    evaluation.schemeHash = bundle.project.schemeHash;
    evaluation.questionsHash = bundle.project.questionsHash;
  }
}

function setup() {
  const bundle = fixture(3, 2);
  bundle.project.questions[0].referenceNames = ['front.png'];
  bundle.project.scheme.policies.rankingTies = 'dense';
  for (const asset of bundle.assets) { asset.sha256 = hash(png); asset.size = png.length; }
  for (const [index, id] of ['ref-old', 'ref-new'].entries()) bundle.assets.push({
    id, projectId: bundle.project.id, questionId: 'q1', productId: null, role: 'reference',
    name: 'front.png', mime: 'image/png', size: png.length, sha256: hash(png), createdAt: stamp
  });
  bundle.referenceRevisions = [
    { id: 'bind-1', projectId: 'project', questionId: 'q1', parentId: null, revision: 1, assetIds: ['ref-old'], createdAt: stamp },
    { id: 'bind-2', projectId: 'project', questionId: 'q1', parentId: 'bind-1', revision: 2, assetIds: ['ref-new'], createdAt: stamp },
    { id: 'bind-3', projectId: 'project', questionId: 'q1', parentId: 'bind-2', revision: 3, assetIds: [], createdAt: stamp }
  ];
  bundle.evaluations.forEach(row => { row.referenceIds = row.questionId === 'q1' ? ['ref-old'] : []; });
  refreshHashes(bundle);
  const load = async id => {
    const asset = bundle.assets.find(row => row.id === id);
    return asset ? { ...asset, blob: new Blob([png], { type: 'image/png' }) } : undefined;
  };
  return { bundle, load };
}

function backup(bundle, version = archiveSchemaVersion(bundle)) {
  return {
    format: 'eval-studio-project-backup', schemaVersion: version,
    bundle, snapshots: [clone(bundle.project)], blobs: [{ sha256: hash(png), mime: 'image/png', data: png.toString('base64') }]
  };
}

function stage(bundle, packageId = 'reference-package') {
  return { bundle, snapshots: [clone(bundle.project)], kind: 'baseline', senderId: 'm1', productIds: bundle.project.products.map(row => row.id), packageId };
}
const fileList = result => result.files.map(file => new File([file.blob], file.name));

test('schema 3 preserves removed reference history and evaluation snapshots in tag and anchor backups', () => {
  for (const anchorMode of [false, true]) {
    const { bundle } = setup();
    if (anchorMode) bundle.project.scheme.rating = { mode: 'anchors', anchors: defaultAnchors() };
    refreshHashes(bundle);
    assert.equal(archiveSchemaVersion(bundle), 3);
    assert.deepEqual(validateBackupStructure(backup(bundle)), []);
    assert.ok(validateBackupStructure(backup(bundle, anchorMode ? 2 : 1)).some(message => message.includes('schemaVersion 3')));
    assert.deepEqual(resolveReferences(bundle, 'q1').assets, []);
    assert.deepEqual(bundle.evaluations[0].referenceIds, ['ref-old']);
  }
});

test('legacy schemas refuse new fields, including empty selections and new fields hidden in audits', () => {
  const { bundle } = setup();
  for (const field of ['history', 'evaluation', 'task']) {
    const legacy = clone(bundle);
    delete legacy.referenceRevisions;
    legacy.evaluations.forEach(row => delete row.referenceIds);
    if (field === 'history') legacy.referenceRevisions = [];
    if (field === 'evaluation') legacy.evaluations[0].referenceIds = [];
    if (field === 'task') legacy.quality = { batches: [], tasks: [{ evidence: [{ referenceIds: [] }] }], judgments: [], decisions: [] };
    assert.equal(archiveSchemaVersion(legacy), 3);
    assert.ok(validateBackupStructure(backup(legacy, 1)).some(message => message.includes('schemaVersion 3')));
  }
  const plain = clone(bundle);
  delete plain.referenceRevisions;
  plain.evaluations.forEach(row => delete row.referenceIds);
  assert.equal(archiveSchemaVersion(plain), 1);
  plain.project.questions[0].fields.referenceIds = 'this is just custom text';
  assert.equal(archiveSchemaVersion(plain), 1);
  assert.equal(archiveSchemaVersion(plain, [{ incoming: bundle }]), 3);
});

test('backup rejects missing fixed reference images and invalid binding histories', () => {
  const { bundle } = setup();
  const missing = clone(bundle);
  missing.assets = missing.assets.filter(row => row.id !== 'ref-old');
  assert.ok(validateBackupStructure(backup(missing)).some(message => message.includes('参考图')));
  const changed = clone(bundle);
  changed.referenceRevisions[2].parentId = 'unknown';
  assert.ok(validateBackupStructure(backup(changed)).some(message => message.includes('参考图')));
});

test('stage schema 3 ZIP roundtrip retains all historical reference metadata and immutable snapshots', async () => {
  const { bundle, load } = setup();
  const result = await buildStagePackage(stage(bundle), load, { packageId: 'reference-roundtrip', now: stamp });
  assert.equal(result.manifest.schemaVersion, 3);
  const restored = await readStagePackage(fileList(result));
  assert.deepEqual(restored.manifest.bundle, bundle);
  assert.deepEqual(resolveReferences(restored.manifest.bundle, 'q1').assets, []);
  assert.equal(restored.blobs.size, 1);
});

test('stage schema 3 supports anchors without treating the new transport version as a scoring mode', async () => {
  const { bundle, load } = setup();
  bundle.project.scheme.rating = { mode: 'anchors', anchors: defaultAnchors() };
  refreshHashes(bundle);
  const result = await buildStagePackage(stage(bundle), load, { packageId: 'reference-anchors', now: stamp });
  assert.equal(result.manifest.schemaVersion, 3);
  const restored = await readStagePackage(fileList(result));
  assert.equal(restored.manifest.bundle.project.scheme.rating.mode, 'anchors');
  assert.deepEqual(restored.manifest.bundle.referenceRevisions, bundle.referenceRevisions);
});

test('re-signed schema 1 cannot smuggle reference protocol fields into a stage package', async () => {
  const { bundle, load } = setup();
  const result = await buildStagePackage(stage(bundle), load, { packageId: 'reference-old-schema', now: stamp });
  const manifest = clone(result.manifest);
  manifest.schemaVersion = 1;
  const { manifestHash, ...unsigned } = manifest;
  manifest.manifestHash = hash(unsigned);
  const files = fileList(result).filter(file => !file.name.endsWith('.eval.json'));
  files.push(new File([JSON.stringify(manifest)], `${manifest.packageId}.eval.json`));
  await assert.rejects(() => readStagePackage(files), /schemaVersion 3/);
});

test('merging an old package cannot resurrect reference images removed by the current binding head', () => {
  const { bundle } = setup();
  const old = clone(bundle);
  delete old.referenceRevisions;
  old.evaluations = [];
  old.assets = old.assets.filter(asset => asset.role === 'reference');
  const plan = planMerge(bundle, stage(old));
  assert.deepEqual(plan.blockers, []);
  const merged = materializeMerge(plan, {}, '', '', () => 'unused', stamp);
  assert.deepEqual(resolveReferences(merged, 'q1').assets, []);
  assert.equal(merged.referenceRevisions.length, 3);
  assert.deepEqual(merged.evaluations[0].referenceIds, ['ref-old']);
});

test('binding descendants union by id; concurrent forks and same-id edits block merge', () => {
  const { bundle } = setup();
  const root = clone(bundle);
  root.referenceRevisions = root.referenceRevisions.slice(0, 1);
  const straight = planMerge(root, stage(bundle));
  assert.deepEqual(straight.blockers, []);
  assert.equal(straight.merged.referenceRevisions.length, 3);
  const fork = clone(root);
  fork.referenceRevisions.push({ ...bundle.referenceRevisions[1], id: 'fork', assetIds: [] });
  assert.ok(planMerge(bundle, stage(fork)).blockers.some(message => /参考图.*分叉/.test(message)));
  const changed = clone(bundle);
  changed.referenceRevisions[0].assetIds = ['ref-new'];
  assert.ok(planMerge(bundle, stage(changed)).blockers.some(message => /参考图绑定同 ID/.test(message)));
  const metadata = clone(bundle);
  metadata.assets.find(row => row.id === 'ref-old').name = 'changed.png';
  assert.ok(planMerge(bundle, stage(metadata)).blockers.some(message => /图片同 ID/.test(message)));
});

test('new review tasks pin original reference snapshots and blind transport includes only those images', () => {
  const { bundle } = setup();
  let sequence = 0;
  bundle.quality = createQualityBatch(bundle, 'review', 'fixed-reference-seed', () => `quality-${++sequence}`, stamp);
  const task = bundle.quality.tasks.find(row => row.questionId === 'q1');
  assert.deepEqual(task.evidence[0].referenceIds, ['ref-old']);
  assert.deepEqual(qualityReferenceIds(bundle, task), ['ref-old']);
  const projected = blindQualityBundle(bundle, task.batchId, task.reviewerId);
  assert.equal(projected.referenceRevisions, undefined);
  assert.equal(projected.assets.some(row => row.id === 'ref-new'), false);
  assert.equal(projected.assets.find(row => row.id === 'ref-old').name, 'front.png');
  assert.deepEqual(validateQuality(projected.quality, projected), []);
  assert.equal(archiveSchemaVersion(projected), 3);
  const tampered = clone(projected);
  tampered.assets.push(bundle.assets.find(row => row.id === 'ref-new'));
  assert.ok(validateQuality(tampered.quality, tampered).some(message => message.includes('越界')));
});

test('an explicit empty task reference snapshot never falls back to subsequently uploaded images', () => {
  const { bundle } = setup();
  let sequence = 0;
  bundle.quality = createQualityBatch(bundle, 'review', 'empty-pinned', () => `empty-${++sequence}`, stamp);
  const task = bundle.quality.tasks.find(row => row.questionId === 'q2');
  bundle.assets.push({ ...bundle.assets.find(row => row.id === 'ref-new'), id: 'later-q2-reference', questionId: 'q2' });
  assert.deepEqual(qualityReferenceIds(bundle, task), []);
  delete task.evidence[0].referenceIds;
  assert.deepEqual(qualityReferenceIds(bundle, task), ['later-q2-reference']);
});

test('legacy tasks keep legacy all-reference behavior and are not re-pinned to the current selection', () => {
  const { bundle } = setup();
  let sequence = 0;
  bundle.quality = createQualityBatch(bundle, 'review', 'legacy-task', () => `legacy-${++sequence}`, stamp);
  for (const task of bundle.quality.tasks) task.evidence.forEach(evidence => delete evidence.referenceIds);
  for (const row of bundle.evaluations) delete row.referenceIds;
  const task = bundle.quality.tasks.find(row => row.questionId === 'q1');
  const projected = blindQualityBundle(bundle, task.batchId, task.reviewerId);
  assert.deepEqual(projected.assets.filter(row => row.role === 'reference').map(row => row.id).sort(), ['ref-new', 'ref-old']);
  assert.equal(projected.quality.tasks[0].evidence[0].referenceIds, undefined);
});

test('return packages keep immutable pinned metadata after unrelated reference replacement', () => {
  const { bundle } = setup();
  let sequence = 0;
  bundle.quality = createQualityBatch(bundle, 'review', 'return-fixed', () => `return-${++sequence}`, stamp);
  const task = bundle.quality.tasks.find(row => row.questionId === 'q1');
  const returned = blindQualityBundle(bundle, task.batchId, task.reviewerId, true);
  bundle.assets.reverse();
  assert.deepEqual(validateQualityReturn(bundle, returned), []);
  const tampered = clone(returned);
  tampered.assets.find(asset => asset.id === 'ref-old').name = 'different-reference.png';
  assert.ok(validateQualityReturn(bundle, tampered).some(message => message.includes('元数据')));
});

test('archive content hash includes binding changes and ignores binding iteration order', async () => {
  const { bundle } = setup();
  const reordered = clone(bundle);
  reordered.referenceRevisions.reverse();
  assert.equal(await archiveContentHash(bundle), await archiveContentHash(reordered));
  const changed = clone(bundle);
  changed.referenceRevisions[2].assetIds = ['ref-new'];
  assert.notEqual(await archiveContentHash(bundle), await archiveContentHash(changed));
});

test('checkpoint archive embeds schema 3 and preserves old evaluation references after removal', async () => {
  const { bundle, load } = setup();
  const archive = await buildFinalArchive({ bundle, snapshots: [bundle.project], audits: [] }, {
    mode: 'checkpoint', basis: 'original', operatorId: 'm1', reason: '保存参考图替换与移除历史',
    scopeConfirmed: true, conclusionsConfirmed: true, featuresConfirmed: true, demo: false
  }, load, { archiveId: 'reference-archive', now: stamp });
  const stageFile = archive.files.find(file => file.name.endsWith('.eval.json'));
  assert.equal(JSON.parse(await stageFile.blob.text()).schemaVersion, 3);
  const restored = await readFinalArchive(fileList(archive));
  assert.deepEqual(restored.bundle.referenceRevisions, bundle.referenceRevisions);
  assert.deepEqual(restored.bundle.evaluations[0].referenceIds, ['ref-old']);
  assert.deepEqual(resolveReferences(restored.bundle, 'q1').assets, []);
});
