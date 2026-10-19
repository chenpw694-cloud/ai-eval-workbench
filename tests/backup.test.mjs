import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateBackupStructure } from '../src/core/backup.ts';

const sourceScheme = JSON.parse(readFileSync(new URL('../schemes/ecommerce-t2i/scheme.json', import.meta.url), 'utf8'));
const stamp = '2026-10-18T12:00:00.000Z';
const schemeHash = 'a'.repeat(64);
const questionsHash = 'b'.repeat(64);
const pngData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=';
const png = Buffer.from(pngData, 'base64');
const imageHash = createHash('sha256').update(png).digest('hex');

function fixture({ withEvaluation = false } = {}) {
  const project = {
    id: 'project-1', name: '真实采集项目', background: '', period: '',
    members: [{ id: 'member-1', name: '评测员 1' }],
    products: [1, 2].map(index => ({
      id: `product-${index}`, name: `产品 ${index}`, version: '免费版', role: 'direct',
      demo: false, ownerId: 'member-1', totalCost: null,
      commercialUse: 'unreviewed', commercialEvidence: '',
    })),
    questions: [],
    scheme: {
      ...structuredClone(sourceScheme),
      policies: { failedNoOutput: 'unresolved', rankingTies: 'unresolved', zeroUsableCost: 'unresolved' },
    },
    rulesConfirmed: false, expectedQuestionCount: 50, status: 'draft', revision: 1,
    createdAt: stamp, updatedAt: stamp, schemeHash, questionsHash,
  };
  const backup = {
    format: 'eval-studio-project-backup', schemaVersion: 1, exportedAt: stamp,
    bundle: { project, evaluations: [], assets: [], walkthroughs: [], experiences: [] },
    snapshots: [], blobs: [],
  };
  if (withEvaluation) {
    project.questions.push({
      id: 'question-1', title: '白底主图', scene: '白底主图', category: '美妆', difficulty: '基础',
      request: '生成商品白底主图', acceptance: ['商品信息准确'], referenceNames: [], fields: {},
    });
    backup.bundle.assets.push({
      id: 'image-1', projectId: project.id, questionId: 'question-1', productId: 'product-1',
      role: 'output', name: 'original.png', mime: 'image/png', size: png.length,
      sha256: imageHash, createdAt: stamp,
    });
    backup.blobs.push({ sha256: imageHash, mime: 'image/png', data: pngData });
    backup.bundle.evaluations.push({
      id: 'evaluation-1', projectId: project.id, questionId: 'question-1', productId: 'product-1',
      reviewerId: 'member-1', revision: 1, parentId: null, status: 'draft',
      mediaIds: ['image-1'], bestMediaId: 'image-1',
      mediaChecks: [{ mediaId: 'image-1', usable: null, infringement: null }], tags: [],
      seconds: null, failed: false, failureReason: '', notes: '', schemeHash, questionsHash,
      createdAt: stamp,
    });
  }
  backup.snapshots.push(structuredClone(project));
  return backup;
}

function errors(backup) {
  return validateBackupStructure(backup).join('\n');
}

test('a newly created empty-question project can be backed up and restored structurally', () => {
  const backup = fixture();
  assert.equal(backup.bundle.project.questions.length, 0);
  assert.deepEqual(validateBackupStructure(backup), []);
});

test('a draft with its original PNG, unchecked media and null duration remains recoverable', () => {
  assert.deepEqual(validateBackupStructure(fixture({ withEvaluation: true })), []);
});

test('demo exports, phase packages and unsupported versions are not formal backups', () => {
  for (const format of ['eval-studio-backup', 'eval-studio-demo-backup', 'eval-studio-phase-package', '']) {
    const backup = fixture();
    backup.format = format;
    assert.match(errors(backup), /正式项目备份/);
  }
  const backup = fixture();
  backup.schemaVersion = 2;
  assert.match(errors(backup), /正式项目备份/);
  assert.match(errors(null), /正式项目备份/);
});

test('duplicate IDs in project entities, assets and immutable revisions are rejected', () => {
  for (const [label, select] of [
    ['成员', backup => backup.bundle.project.members],
    ['产品', backup => backup.bundle.project.products],
    ['题目', backup => backup.bundle.project.questions],
    ['图片', backup => backup.bundle.assets],
    ['评测修订', backup => backup.bundle.evaluations],
  ]) {
    const backup = fixture({ withEvaluation: true });
    const rows = select(backup);
    rows.push(structuredClone(rows[0]));
    assert.match(errors(backup), new RegExp(`${label}包含无效或重复 ID`), label);
  }
});

test('an evaluation cannot reference an image owned by another product or question', () => {
  const crossProduct = fixture({ withEvaluation: true });
  crossProduct.bundle.assets[0].productId = 'product-2';
  assert.match(errors(crossProduct), /其他产品或题目/);

  const crossQuestion = fixture({ withEvaluation: true });
  crossQuestion.bundle.project.questions.push({ ...structuredClone(crossQuestion.bundle.project.questions[0]), id: 'question-2' });
  crossQuestion.bundle.assets[0].questionId = 'question-2';
  assert.match(errors(crossQuestion), /其他产品或题目/);
});

test('metadata without its original blob, or with a different blob MIME, is rejected', () => {
  const missing = fixture({ withEvaluation: true });
  missing.blobs = [];
  assert.match(errors(missing), /原图缺失/);

  const wrongMime = fixture({ withEvaluation: true });
  wrongMime.blobs[0].mime = 'image/jpeg';
  assert.match(errors(wrongMime), /原图缺失/);

  const duplicateBlob = fixture({ withEvaluation: true });
  duplicateBlob.blobs.push(structuredClone(duplicateBlob.blobs[0]));
  assert.match(errors(duplicateBlob), /原图编码、格式或摘要/);
});

test('unknown tag severity is rejected in both the scheme and an evaluation', () => {
  const scheme = fixture();
  scheme.bundle.project.scheme.tags[0].severity = 'P4';
  assert.match(errors(scheme), /标签编码、维度或等级/);

  const evaluation = fixture({ withEvaluation: true });
  evaluation.bundle.evaluations[0].tags.push({ code: 'A-01', severity: 'P4' });
  assert.match(errors(evaluation), /评测修订字段或引用/);
});

test('unknown cost remains null; negative, infinite and string costs are rejected', () => {
  assert.deepEqual(validateBackupStructure(fixture()), []);
  for (const cost of [-1, Infinity, NaN, '0']) {
    const backup = fixture();
    backup.bundle.project.products[0].totalCost = cost;
    assert.match(errors(backup), /产品字段/, `cost=${String(cost)}`);
  }
  for (const cost of [0, 0.5, 100]) {
    const backup = fixture();
    backup.bundle.project.products[0].totalCost = cost;
    backup.snapshots[0] = structuredClone(backup.bundle.project);
    assert.deepEqual(validateBackupStructure(backup), []);
  }
});

test('the current project revision must have a snapshot, and duplicate snapshot revisions fail', () => {
  const missing = fixture();
  missing.snapshots = [];
  assert.match(errors(missing), /缺少当前项目快照/);

  const previousOnly = fixture();
  previousOnly.bundle.project.revision = 2;
  assert.match(errors(previousOnly), /缺少当前项目快照/);

  const duplicate = fixture();
  duplicate.snapshots.push(structuredClone(duplicate.snapshots[0]));
  assert.match(errors(duplicate), /快照记录无效或重复/);
});

test('invalid reference relationships and malformed hashes are rejected before recovery', () => {
  const backup = fixture({ withEvaluation: true });
  backup.bundle.evaluations[0].parentId = 'missing-parent';
  backup.bundle.assets[0].sha256 = 'not-a-sha256';
  assert.match(errors(backup), /原图缺失/);
  assert.match(errors(backup), /评测修订字段或引用/);
});

test('a root evaluation revision must start at one', () => {
  const backup = fixture({ withEvaluation: true });
  backup.bundle.evaluations[0].revision = 2;
  assert.notDeepEqual(validateBackupStructure(backup), []);
});

test('a valid adjacent immutable revision chain remains recoverable', () => {
  const backup = fixture({ withEvaluation: true });
  const first = backup.bundle.evaluations[0];
  backup.bundle.evaluations.push({ ...structuredClone(first), id: 'evaluation-2', revision: 2, parentId: first.id });
  assert.deepEqual(validateBackupStructure(backup), []);
});

test('a revision parent must belong to the same product and question', () => {
  for (const changed of ['productId', 'questionId']) {
    const backup = fixture({ withEvaluation: true });
    const first = backup.bundle.evaluations[0];
    const next = {
      ...structuredClone(first), id: 'evaluation-2', revision: 2, parentId: first.id,
      mediaIds: [], bestMediaId: null, mediaChecks: [],
    };
    if (changed === 'productId') next.productId = 'product-2';
    else {
      backup.bundle.project.questions.push({ ...structuredClone(backup.bundle.project.questions[0]), id: 'question-2' });
      next.questionId = 'question-2';
      backup.snapshots[0] = structuredClone(backup.bundle.project);
    }
    backup.bundle.evaluations.push(next);
    assert.notDeepEqual(validateBackupStructure(backup), [], changed);
  }
});

test('revision numbers must be adjacent to their parent', () => {
  const backup = fixture({ withEvaluation: true });
  const first = backup.bundle.evaluations[0];
  backup.bundle.evaluations.push({ ...structuredClone(first), id: 'evaluation-3', revision: 3, parentId: first.id });
  assert.notDeepEqual(validateBackupStructure(backup), []);
});

test('branching, multiple roots and cyclic revision histories are rejected', () => {
  const branching = fixture({ withEvaluation: true });
  const first = branching.bundle.evaluations[0];
  branching.bundle.evaluations.push(
    { ...structuredClone(first), id: 'evaluation-2a', revision: 2, parentId: first.id },
    { ...structuredClone(first), id: 'evaluation-2b', revision: 2, parentId: first.id },
  );
  assert.notDeepEqual(validateBackupStructure(branching), []);

  const multipleRoots = fixture({ withEvaluation: true });
  multipleRoots.bundle.evaluations.push({ ...structuredClone(multipleRoots.bundle.evaluations[0]), id: 'other-root' });
  assert.notDeepEqual(validateBackupStructure(multipleRoots), []);

  const cycle = fixture({ withEvaluation: true });
  cycle.bundle.evaluations[0].parentId = 'evaluation-2';
  cycle.bundle.evaluations.push({ ...structuredClone(cycle.bundle.evaluations[0]), id: 'evaluation-2', parentId: 'evaluation-1', revision: 2 });
  assert.notDeepEqual(validateBackupStructure(cycle), []);

  const selfParent = fixture({ withEvaluation: true });
  selfParent.bundle.evaluations[0].parentId = 'evaluation-1';
  assert.notDeepEqual(validateBackupStructure(selfParent), []);
});

test('a current snapshot with the same revision but different project content is rejected', () => {
  const backup = fixture();
  backup.snapshots[0].name = '与当前项目不同的名字';
  assert.notDeepEqual(validateBackupStructure(backup), []);

  const wrongRules = fixture();
  wrongRules.snapshots[0].scheme.tags[0].severity = 'P2';
  assert.notDeepEqual(validateBackupStructure(wrongRules), []);
});

test('an unassigned local draft may be recovered, but an unassigned submission may not', () => {
  const backup = fixture({ withEvaluation: true });
  backup.bundle.evaluations[0].reviewerId = '';
  assert.deepEqual(validateBackupStructure(backup), []);
  backup.bundle.evaluations[0].status = 'submitted';
  assert.notDeepEqual(validateBackupStructure(backup), []);
});

test('validation does not mutate the backup or discard historical records', () => {
  const backup = fixture({ withEvaluation: true });
  const before = structuredClone(backup);
  validateBackupStructure(backup);
  assert.deepEqual(backup, before);
});
