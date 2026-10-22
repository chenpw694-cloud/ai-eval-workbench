import test from 'node:test';
import assert from 'node:assert/strict';
import { matchReferenceText, parseReferenceLabels } from '../src/core/referenceTextMatching.ts';
import { fixture } from './helpers/formal-fixture.mjs';
const file = (name, key = name, path = name) => ({ key, name, path });
function project(requests) {
  const p = fixture(1, requests.length).project;
  p.questions.forEach((q, i) => { q.request = requests[i]; });
  return p;
}

test('one numeric source with a product label automatically serves four related questions and keeps input unchanged', () => {
  const p = project(['精华液白底主图', '将精华液放在窗边', '这瓶精华液的详情图', '制作精华液海报', '口红主图']);
  const files = [file('1.png')]; const labels = { '1.png': '精华液' };
  const before = structuredClone({ p, files, labels });
  const result = matchReferenceText(p, files, labels);
  assert.deepEqual(result.map(row => row.questionId), ['q1', 'q2', 'q3', 'q4']);
  assert.equal(result.every(row => row.key === '1.png' && row.role === 'reference' && row.productId === null), true);
  assert.match(result[0].reason, /共用于 4 道题/);
  assert.deepEqual({ p, files, labels }, before);
});
test('bare numbers never silently match question order or an unrelated number in a request', () => {
  const result = matchReferenceText(project(['制作1张精华液海报', '口红主图']), [file('1.png')]);
  assert.equal(result.length, 1); assert.equal(result[0].questionId, null);
  assert.match(result[0].reason, /数字文件名/);
});
test('filename references are shared automatically and take precedence over generic product terms', () => {
  const p = project(['精华液主图', '精华液场景图']);
  p.questions.forEach(q => { q.referenceNames = ['1.png']; });
  const result = matchReferenceText(p, [file('1.png'), file('2.png')], { '2.png': '精华液' });
  assert.deepEqual(result.filter(row => row.key === '1.png').map(row => row.questionId), ['q1', 'q2']);
  assert.equal(result.find(row => row.key === '2.png').questionId, null);
});
test('descriptive filenames, explicit R codes, product fields and aliases support shared matching', () => {
  const p = project(['口红白底图', '参考 R01 拍摄', '参考 R010 拍摄', '制作商品图']);
  p.questions[3].fields = { 商品: '唇膏' };
  const result = matchReferenceText(p, [file('R01.png'), file('口红.png')], { '口红.png': '口红、唇膏' });
  assert.deepEqual(result.filter(r => r.key === 'R01.png').map(r => r.questionId), ['q2']);
  assert.deepEqual(result.filter(r => r.key === '口红.png').map(r => r.questionId), ['q1', 'q4']);
});
test('multiple files matching a product or the same slot stay unresolved', () => {
  const p = project(['精华液主图']);
  const result = matchReferenceText(p, [file('1.png'), file('2.png')], { '1.png': '精华液', '2.png': '精华液' });
  assert.equal(result.every(r => r.questionId === null), true);
  assert.match(result[0].reason, /同时匹配多张/);
});
test('distinct required reference slots can both match; ambiguous slots remain explicit for manual selection', () => {
  const p = project(['精华液主图', '制作口红图片']);
  p.questions[0].referenceNames = ['1.png', '2.png'];
  p.questions[1].referenceNames = ['正面.png', '背面.png'];
  const result = matchReferenceText(p, [file('1.png'), file('2.png'), file('口红.png')]);
  assert.equal(result.filter(r => r.questionId === 'q1').length, 2);
  assert.equal(result.find(r => r.questionId === 'q2').referenceName, '');
});
test('relative paths disambiguate equal filenames; labels require a safe explicit text dictionary', () => {
  const p = project(['精华液主图', '口红主图']);
  const labels = parseReferenceLabels('{"A/1.png":"精华液","B/1.png":"口红"}');
  const result = matchReferenceText(p, [file('1.png', 'a', 'A/1.png'), file('1.png', 'b', 'B/1.png')], labels);
  assert.deepEqual(result.map(r => r.questionId), ['q1', 'q2']);
  for (const source of ['[]', '{}', 'null', '{"1.png":1}', '{"1.png":""}', 'oops']) assert.throws(() => parseReferenceLabels(source));
});
test('Latin names match complete words and do not claim substrings', () => {
  const result = matchReferenceText(project(['icecream 海报', 'cream 海报']), [file('1.png')], { '1.png': 'cream' });
  assert.deepEqual(result.map(r => r.questionId), ['q2']);
});
test('Chinese product names tolerate typographic spacing and adjacent model letters', () => {
  const result = matchReferenceText(project(['这件白 T 恤做平铺主图', '展示品牌A精华液的瓶身']), [file('1.png'), file('2.png')], { '1.png': '白T恤', '2.png': '精华液' });
  assert.deepEqual(result.map(r => r.questionId), ['q1', 'q2']);
});
