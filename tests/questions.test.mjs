import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, questionsFromRows, parseQuestionsJson } from '../src/core/questions.ts';

const mapping = { id: '题号', request: '需求描述', acceptance: '验收要点' };

test('CSV supports BOM, quoted commas, escaped quotes and embedded CRLF', () => {
  const result = parseCsv('\uFEFF题号,需求描述,验收要点,备注\r\nQ-1,"展示精华液, 标签为""AURA""\r\n自然光","瓶身完整；文字清晰",原图\r\n');
  assert.deepEqual(result.headers, ['题号', '需求描述', '验收要点', '备注']);
  assert.equal(result.rows[0][1], '展示精华液, 标签为"AURA"\n自然光');
  const questions = questionsFromRows(result.headers, result.rows, mapping);
  assert.deepEqual(questions[0].acceptance, ['瓶身完整', '文字清晰']);
  assert.deepEqual(questions[0].fields, { 备注: '原图' });
});

test('CSV ignores empty lines, supports bare CR and preserves quoted filename commas', () => {
  const parsed = parseCsv('\n题号,需求描述,验收要点,参考图\rQ-1,白底图,商品完整,"serum,front.png;side.png"\r\r   \r');
  const result = questionsFromRows(parsed.headers, parsed.rows, { ...mapping, referenceNames: '参考图' });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].referenceNames, ['serum,front.png', 'side.png']);
});

test('CSV rejects empty and duplicate headers, including whitespace-normalized duplicates', () => {
  assert.throws(() => parseCsv('题号, 题号 \n1,2'), /第 1 行.*重复/);
  assert.throws(() => parseCsv('\n\n题号,题号\n1,2'), /第 3 行.*重复/);
  assert.throws(() => parseCsv('题号,,需求\n1,2,3'), /第 1 行.*表头为空/);
  assert.throws(() => parseCsv('  \n\n'), /第 1 行.*文件为空/);
});

test('CSV rejects unequal widths and reports physical row after multiline field', () => {
  assert.throws(() => parseCsv('id,request\n1,"a\nb"\n2,a,b'), /第 4 行.*3 列/);
  assert.throws(() => parseCsv('id,request\n1'), /第 2 行.*1 列/);
});

test('CSV rejects unclosed or misplaced quotes', () => {
  assert.throws(() => parseCsv('a,b\n1,"unfinished'), /第 2 行.*没有闭合/);
  assert.throws(() => parseCsv('a,b\n1,x"y'), /第 2 行.*引号必须/);
  assert.throws(() => parseCsv('a,b\n1,"x"oops'), /第 2 行.*闭合引号后/);
});

test('mapping is explicit and requires id/request/acceptance columns', () => {
  const parsed = parseCsv('编号,提示,标准,难度\n01,白底主图,背景纯白,基础');
  assert.throws(() => questionsFromRows(parsed.headers, parsed.rows, {}), /第 1 行.*题号/);
  assert.throws(() => questionsFromRows(parsed.headers, parsed.rows, { id: '编号', request: '不存在', acceptance: '标准' }), /第 1 行.*不存在/);
  const result = questionsFromRows(parsed.headers, parsed.rows, { id: '编号', request: '提示', acceptance: '标准', difficulty: '难度' });
  assert.equal(result[0].id, '01');
  assert.equal(result[0].difficulty, '基础');
  assert.equal(result[0].title, '题目 01');
});

test('whole CSV batch rejects duplicate ids and blank required values', () => {
  let parsed = parseCsv('题号,需求描述,验收要点\nQ-1,需求,要点\n Q-1 ,需求2,要点');
  assert.throws(() => questionsFromRows(parsed.headers, parsed.rows, mapping), /第 3 行.*题号.*重复.*第 2 行/);
  parsed = parseCsv('题号,需求描述,验收要点\nQ-1,,要点');
  assert.throws(() => questionsFromRows(parsed.headers, parsed.rows, mapping), /第 2 行.*需求描述不能为空/);
  parsed = parseCsv('题号,需求描述,验收要点\nQ-1,需求,"； ;"');
  assert.throws(() => questionsFromRows(parsed.headers, parsed.rows, mapping), /第 2 行.*验收要点不能为空/);
});

test('CSV validation reports physical line of a duplicate after embedded newline', () => {
  const parsed = parseCsv('题号,需求描述,验收要点\nQ-1,"第一行\n第二行",要点\nQ-1,需求,要点');
  assert.throws(() => questionsFromRows(parsed.headers, parsed.rows, mapping), /第 4 行.*第 2 行/);
});

test('formula-looking content still follows the same strict CSV quote rules', () => {
  assert.throws(
    () => parseCsv('题号,需求描述,验收要点,备注\nQ-1,需求,可读,=HYPERLINK(""test"")'),
    /第 2 行.*引号必须/
  );
});

test('data strings are preserved without evaluation and own __proto__ keys are safe', () => {
  const parsed = parseCsv('题号,需求描述,验收要点,__proto__,自定义😀\nQ-1,<script>alert(1)</script>,可读,原型文本,"=HYPERLINK(""test"")"');
  const [question] = questionsFromRows(parsed.headers, parsed.rows, mapping);
  assert.equal(question.request, '<script>alert(1)</script>');
  assert.equal(question.fields['自定义😀'], '=HYPERLINK("test")');
  assert.equal(Object.prototype.hasOwnProperty.call(question.fields, '__proto__'), true);
  assert.equal(question.fields.__proto__, '原型文本');
  assert.equal({}.polluted, undefined);
});

test('JSON accepts minimal questions, numeric id and list delimiters', () => {
  const [question] = parseQuestionsJson('\uFEFF[{"id":1,"request":"生成商品图","acceptance":"完整;清晰\\n无水印；真实","referenceNames":["正面.png"]}]');
  assert.equal(question.id, '1');
  assert.deepEqual(question.acceptance, ['完整', '清晰', '无水印', '真实']);
  assert.deepEqual(question.fields, {});
  assert.equal(question.title, '题目 1');
});

test('JSON standard question round trips and keeps custom fields', () => {
  const source = [{ id: 'Q1', title: '精华液', scene: '场景图', category: '美妆', difficulty: '基础', request: '需求', acceptance: ['商品完整'], referenceNames: ['参考图.png'], fields: { 系列: '春季' } }];
  assert.deepEqual(parseQuestionsJson(JSON.stringify(source)), source);
  assert.deepEqual(parseQuestionsJson('[{"id":"1","request":"需求","acceptance":["要点"],"渠道":"电商","数量":3}]')[0].fields, { 渠道: '电商', 数量: '3' });
});

test('JSON reports exact record line for duplicate ids in pretty printed input', () => {
  const source = '[\n  {"id":"1","request":"需求","acceptance":["一","二"]},\n  {\n    "id":"1","request":"需求","acceptance":["要点"]\n  }\n]';
  assert.throws(() => parseQuestionsJson(source), /第 3 行.*重复.*第 2 行/);
});

test('JSON rejects wrong roots, bad syntax, missing fields and nontext custom values', () => {
  assert.throws(() => parseQuestionsJson('{}'), /第 1 行.*顶层必须/);
  assert.throws(() => parseQuestionsJson('[{"id":1,}]'), /第 \d+ 行.*JSON 格式错误/);
  assert.throws(() => parseQuestionsJson('[{"id":"1","request":"需求"}]'), /第 1 行.*验收要点不能为空/);
  assert.throws(() => parseQuestionsJson('[{"id":"1","request":"需求","acceptance":[3]}]'), /第 1 行.*验收要点须/);
  assert.throws(() => parseQuestionsJson('[{"id":"1","request":"需求","acceptance":["要点"],"fields":{"年龄":1}}]'), /第 1 行.*年龄.*必须是文本/);
});

test('empty template has valid headers and no generated or simulated questions', () => {
  const parsed = parseCsv('\uFEFF题号,题目标题,场景,品类,难度,需求描述,验收要点,参考图文件名\r\n');
  assert.equal(parsed.rows.length, 0);
  assert.deepEqual(questionsFromRows(parsed.headers, parsed.rows, mapping), []);
  assert.deepEqual(parseQuestionsJson('[]'), []);
});
