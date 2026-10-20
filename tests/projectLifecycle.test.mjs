import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRestartedProject } from '../src/core/projectLifecycle.ts';
import { fixture } from './helpers/formal-fixture.mjs';

const now = '2026-10-20T20:00:00.000Z';
function restart(source, options = { name: '重新导入版', keepQuestions: false }) {
  let index = 0;
  return buildRestartedProject(source, options, () => `fresh-${++index}`, now);
}

test('restarting creates a draft with new project, member and product identities and remapped owners', () => {
  const source = fixture().project;
  const next = restart(source);
  const oldIds = new Set([source.id, ...source.members.map(row => row.id), ...source.products.map(row => row.id)]);
  const newIds = [next.id, ...next.members.map(row => row.id), ...next.products.map(row => row.id)];
  assert.equal(new Set(newIds).size, newIds.length);
  assert(newIds.every(id => !oldIds.has(id)));
  assert.equal(next.status, 'draft');
  assert.equal(next.rulesConfirmed, false);
  assert.equal(next.revision, 0);
  assert.equal(next.schemeHash, '');
  assert.equal(next.questionsHash, '');
  assert.equal(next.createdAt, now);
  assert.equal(next.updatedAt, now);
  for (const [index, product] of next.products.entries()) {
    assert.equal(product.ownerId, next.members[index].id);
    assert.equal(product.name, source.products[index].name);
    assert.equal(product.version, source.products[index].version);
    assert.equal(product.role, source.products[index].role);
  }
});

test('the default restart scope is empty and retains the intended question count and reusable configuration', () => {
  const source = fixture().project;
  const next = restart(source);
  assert.deepEqual(next.questions, []);
  assert.equal(next.expectedQuestionCount, source.expectedQuestionCount);
  assert.equal(next.background, source.background);
  assert.equal(next.period, source.period);
  assert.deepEqual(next.scheme, source.scheme);
  assert.deepEqual(next.members.map(({name}) => name), source.members.map(({name}) => name));
  assert.equal(next.name, '重新导入版');
});

test('retaining questions copies only editable question metadata, including reference names, without mutating the old project', () => {
  const source = fixture().project;
  source.questions[0].referenceNames = ['serum.png'];
  source.questions[0].fields = { ref_images: '["serum.png"]' };
  source.sourceSnapshot = { packageId: 'old-package', revision: 11 };
  const before = structuredClone(source);
  const next = restart(source, { name: '  新项目  ', keepQuestions: true });
  assert.deepEqual(next.questions, source.questions);
  assert.equal(next.name, '新项目');
  assert.equal('sourceSnapshot' in next, false);
  assert.deepEqual(source, before);
  next.questions[0].acceptance.push('新验收条件');
  next.questions[0].referenceNames.push('new.png');
  next.scheme.dimensions[0].weight = 999;
  next.members[0].name = '只改新成员';
  assert.deepEqual(source, before);
});

test('restarting clears cost and commercial judgments and does not copy any collection evidence fields', () => {
  const source = fixture().project;
  source.evaluations = ['future-extension-data'];
  const next = restart(source);
  assert(next.products.every(row => row.totalCost === null && row.commercialUse === 'unreviewed' && row.commercialEvidence === ''));
  assert.equal('evaluations' in next, false);
  assert.equal('assets' in next, false);
  assert.equal('quality' in next, false);
});

test('an invalid old owner stays unassigned rather than binding the restarted product to an unrelated member', () => {
  const source = fixture().project;
  source.products[0].ownerId = 'missing-member';
  assert.equal(restart(source).products[0].ownerId, '');
});

test('blank names receive a clear restart title and duplicate generated IDs cannot silently reuse the old scope', () => {
  const source = fixture().project;
  assert.equal(restart(source, { name: ' ', keepQuestions: false }).name, `${source.name}（重新开始）`);
  assert.throws(() => buildRestartedProject(source, {name: '新项目', keepQuestions: false}, () => source.id, now), /标识重复/);
  assert.throws(() => buildRestartedProject(source, {name: '新项目', keepQuestions: false}, () => 'same-id', now), /标识重复/);
});
