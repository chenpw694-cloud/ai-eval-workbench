import test from 'node:test';
import assert from 'node:assert/strict';
import { matchBulkImages } from '../src/core/bulkImageMatching.ts';
import { fixture } from './helpers/formal-fixture.mjs';

function project() {
  const value = fixture(2, 3).project;
  value.questions = value.questions.map((row, index) => ({ ...row, id: `Q-${String(index + 1).padStart(3, '0')}`, referenceNames: index === 0 ? ['精华液.png', '共享图.png'] : index === 1 ? ['口红.png', '共享图.png'] : [] }));
  value.products[0].name = '混元';
  value.products[1].name = '即梦';
  return value;
}
const file = (path, key = path) => ({ key, path, name: path.split(/[\\/]/).at(-1) });
const fields = row => ({ questionId: row.questionId, productId: row.productId, role: row.role });

test('folder hints map case-insensitive normalized question IDs and product folders without modifying files', () => {
  const p = project();
  const files = [file('整批图片/生成图/混元/q001/1.png'), file('整批图片/outputs/p2/Q_002-result.png')];
  const original = structuredClone({ p, files });
  const result = matchBulkImages(p, files);
  assert.deepEqual(fields(result[0]), { questionId: 'Q-001', productId: 'p1', role: 'output' });
  assert.deepEqual(fields(result[1]), { questionId: 'Q-002', productId: 'p2', role: 'output' });
  assert.equal(result[0].key, files[0].key);
  assert.equal(result[0].path, files[0].path);
  assert.deepEqual({ p, files }, original);
});

test('question matching respects letter and numeric boundaries and does not infer plain image sequence numbers', () => {
  const p = project();
  const result = matchBulkImages(p, ['Q0010.png', 'AQ001.png', 'Q001A.png', '0001.png', 'Q-001-2.png'].map(file));
  assert.deepEqual(result.map(row => row.questionId), [null, null, null, null, 'Q-001']);
});

test('a configured reference filename can identify a question in an arbitrary folder', () => {
  const p = project();
  const [row] = matchBulkImages(p, [file('随便一个文件夹/精华液.png')]);
  assert.deepEqual(fields(row), { questionId: 'Q-001', productId: null, role: 'reference' });
  assert.match(row.reason, /参考图属于 Q-001/);
  const [differentCase] = matchBulkImages({ ...p, questions: [{ ...p.questions[0], referenceNames: ['REF.png'] }] }, [file('ref.png')]);
  assert.equal(differentCase.role, null);
});

test('a shared reference remains a single unassigned row until a path identifies its question', () => {
  const p = project();
  const [shared, identified] = matchBulkImages(p, [file('素材图/共享图.png'), file('参考图/Q002/共享图.png')], { questionId: 'Q-001' });
  assert.deepEqual(fields(shared), { questionId: null, productId: null, role: 'reference' });
  assert.match(shared.reason, /多个题目.*复制行/);
  assert.deepEqual(fields(identified), { questionId: 'Q-002', productId: null, role: 'reference' });
});

test('conflicting question signals and overlapping aliases are not resolved with defaults', () => {
  const p = project();
  const result = matchBulkImages(p, [file('参考图/Q002/精华液.png'), file('Q001/Q002/生成图/1.png')], { questionId: 'Q-003', role: 'reference' });
  assert.equal(result[0].questionId, null);
  assert.match(result[0].reason, /冲突/);
  assert.equal(result[1].questionId, null);
  const aliasCollision = { ...p, questions: [p.questions[0], { ...p.questions[1], id: 'q1' }] };
  assert.equal(matchBulkImages(aliasCollision, [file('Q001/a.png')])[0].questionId, null);
});

test('explicit output folders do not mistake a generated image for a configured reference filename', () => {
  const p = project();
  const [row] = matchBulkImages(p, [file('outputs/即梦/Q002/精华液.png')]);
  assert.deepEqual(fields(row), { questionId: 'Q-002', productId: 'p2', role: 'output' });
});

test('ambiguous role folders remain unassigned and references never inherit a product', () => {
  const p = project();
  const [conflict, reference] = matchBulkImages(p, [file('参考图/outputs/Q001/1.png'), file('p1/refs/Q001/a.png')], { role: 'output', productId: 'p2' });
  assert.equal(conflict.role, null);
  assert.equal(conflict.productId, null);
  assert.match(conflict.reason, /同时包含/);
  assert.deepEqual(fields(reference), { questionId: 'Q-001', productId: null, role: 'reference' });
});

test('duplicate product names, contradictory product folders and partial product names are not guessed', () => {
  const p = project();
  const [partial, multiple] = matchBulkImages(p, [file('混元新版/Q001/a.png'), file('p1/p2/Q001/a.png')], { role: 'output', productId: 'p1' });
  assert.equal(partial.productId, 'p1'); // A supplied default may fill an unrecognized folder.
  assert.equal(multiple.productId, null);
  assert.match(multiple.reason, /多个产品/);
  const duplicate = { ...p, products: p.products.map(row => ({ ...row, name: '同名' })) };
  assert.equal(matchBulkImages(duplicate, [file('同名/Q001/a.png')], { productId: 'p1' })[0].productId, null);
  assert.equal(matchBulkImages(p, [file('混元新版/Q001/a.png')], { role: 'output' })[0].productId, null);
});

test('valid defaults fill only missing assignments and invalid default IDs are ignored', () => {
  const p = project();
  const [row] = matchBulkImages(p, [file('任意路径/a.png')], { role: 'output', questionId: 'Q-003', productId: 'p2' });
  assert.deepEqual(fields(row), { questionId: 'Q-003', productId: 'p2', role: 'output' });
  const [invalid] = matchBulkImages(p, [file('a.png')], { role: 'output', questionId: 'foreign-q', productId: 'foreign-p' });
  assert.deepEqual(fields(invalid), { questionId: null, productId: null, role: 'output' });
});

test('Windows paths and custom identifiers work while punctuation is escaped as literal text', () => {
  const p = project();
  p.questions = [{ ...p.questions[0], id: 'SCENE.A+1' }, { ...p.questions[1], id: '12' }];
  const [custom, numeric, noSubstring] = matchBulkImages(p, [file('图片\\outputs\\p1\\SCENE.A+1\\a.png'), file('outputs/p2/12/a.png'), file('outputs/p1/112/a.png')]);
  assert.equal(custom.questionId, 'SCENE.A+1');
  assert.equal(numeric.questionId, '12');
  assert.equal(noSubstring.questionId, null);
});

test('opt-in numeric filenames match question array order, regardless of IDs, using selected role and product', () => {
  const p = project();
  p.questions = [p.questions[2], p.questions[0], p.questions[1]];
  const result = matchBulkImages(p, [file('素材/1.png'), file('任意场景/02.jpeg'), file('任意场景/3.webp')], { numericOrder: true, role: 'output', productId: 'p2' });
  assert.deepEqual(result.map(row => row.questionId), ['Q-003', 'Q-001', 'Q-002']);
  assert.equal(result[0].role, 'output');
  assert.equal(result[0].productId, 'p2');
  assert.equal(result[1].role, 'output');
  assert.equal(result[1].productId, 'p2');
  assert.match(result[1].reason, /题库顺序.*2/);
});

test('out-of-range numeric filenames remain unassigned individually and are never replaced with a default', () => {
  const p = project();
  const result = matchBulkImages(p, ['1.png', '54.png', '999999999999999999999.png', '0.png', '-1.png', '1.2.png'].map(file), { numericOrder: true, role: 'reference', questionId: 'Q-002' });
  assert.equal(result[0].questionId, 'Q-001');
  assert.equal(result[1].questionId, null);
  assert.equal(result[2].questionId, null);
  assert.match(result[1].reason, /超出题库范围/);
  assert.deepEqual(result.slice(3).map(row => row.questionId), ['Q-002', 'Q-002', 'Q-002']);
});

test('numeric order conflicts with explicit path and required reference assignments instead of guessing', () => {
  const p = project();
  p.questions[1].referenceNames = ['1.png'];
  const result = matchBulkImages(p, [file('Q003/2.png'), file('refs/1.png')], { numericOrder: true, role: 'reference' });
  assert.deepEqual(result.map(row => row.questionId), [null, null]);
  result.forEach(row => assert.match(row.reason, /冲突/));
});

test('numeric order can select one question using a shared filename and does not confuse numeric IDs with ordinals', () => {
  const p = project();
  p.questions[0].referenceNames = ['1.png'];
  p.questions[1].referenceNames = ['1.png'];
  assert.equal(matchBulkImages(p, [file('refs/1.png')], { numericOrder: true })[0].questionId, 'Q-001');
  p.questions = [{ ...p.questions[0], id: '2' }, { ...p.questions[1], id: '1' }];
  p.questions.forEach(row => { row.referenceNames = []; });
  assert.equal(matchBulkImages(p, [file('1.png')], { numericOrder: true, role: 'reference' })[0].questionId, '2');
  assert.equal(matchBulkImages(p, [file('1/1.png')], { numericOrder: true, role: 'reference' })[0].questionId, null);
});

test('numeric-order imports honor the explicitly selected role over folder and reference filename hints', () => {
  const p = project();
  const [output] = matchBulkImages(p, [file('素材图/1.png')], { numericOrder: true, role: 'output', productId: 'p2' });
  assert.deepEqual(fields(output), { questionId: 'Q-001', productId: 'p2', role: 'output' });
  const [reference] = matchBulkImages(p, [file('outputs/混元/2.png')], { numericOrder: true, role: 'reference', productId: 'p2' });
  assert.deepEqual(fields(reference), { questionId: 'Q-002', productId: null, role: 'reference' });
  const [ordinaryAuto] = matchBulkImages(p, [file('素材图/Q001/a.png')], { numericOrder: false, role: 'output', productId: 'p2' });
  assert.equal(ordinaryAuto.role, 'reference');
});

test('numeric-order output imports honor the explicitly selected product over another product directory', () => {
  const p = project();
  const [selected] = matchBulkImages(p, [file('outputs/混元/1.png')], { numericOrder: true, role: 'output', productId: 'p2' });
  assert.deepEqual(fields(selected), { questionId: 'Q-001', productId: 'p2', role: 'output' });
  const [ordinaryAuto] = matchBulkImages(p, [file('outputs/混元/Q001/a.png')], { numericOrder: false, role: 'output', productId: 'p2' });
  assert.equal(ordinaryAuto.productId, 'p1');
});

test('numeric generated images may share another question reference filename while explicit path conflicts still block', () => {
  const p = project();
  p.questions[1].referenceNames = ['1.png'];
  const [output, reference, conflictingPath] = matchBulkImages(p, [file('1.png'), file('refs/1.png'), file('Q003/1.png')], { numericOrder: true, role: 'output', productId: 'p1' });
  assert.equal(output.questionId, 'Q-001');
  assert.equal(reference.questionId, 'Q-001');
  assert.equal(conflictingPath.questionId, null);
  const [realReference] = matchBulkImages(p, [file('1.png')], { numericOrder: true, role: 'reference' });
  assert.equal(realReference.questionId, null);
  assert.match(realReference.reason, /冲突/);
});
