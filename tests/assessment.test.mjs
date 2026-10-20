import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allowedSeverities, latestEvaluations, summarizeProject, validateEvaluation, validateProject } from '../src/core/assessment.ts';

const sourceScheme = JSON.parse(readFileSync(new URL('../schemes/ecommerce-t2i/scheme.json', import.meta.url), 'utf8'));
const stamp = '2026-10-20T12:00:00.000Z';
const clone = value => structuredClone(value);

function fixture(productCount = 3, questionCount = 2, imagesPerQuestion = 1) {
  const members = Array.from({ length: productCount }, (_, index) => ({ id: `m${index + 1}`, name: `评测员 ${index + 1}` }));
  const products = members.map((member, index) => ({ id: `p${index + 1}`, name: `真实产品 ${index + 1}`, version: 'v1', role: 'direct', demo: false, ownerId: member.id, totalCost: (index + 1) * 10, commercialUse: 'allowed', commercialEvidence: '协议明确允许商用' }));
  const questions = Array.from({ length: questionCount }, (_, index) => ({ id: `q${index + 1}`, title: `题目 ${index + 1}`, scene: '场景图', category: '美妆', difficulty: '基础', request: '制作商品场景图', acceptance: ['商品与参考要求一致'], referenceNames: [], fields: {} }));
  const project = { id: 'project', name: '真实评测', background: '试跑', period: '3 天', members, products, questions, scheme: { ...clone(sourceScheme), policies: { failedNoOutput: 'unresolved', rankingTies: 'unresolved', zeroUsableCost: 'unresolved' } }, rulesConfirmed: true, expectedQuestionCount: questionCount, status: 'active', revision: 1, createdAt: stamp, updatedAt: stamp, schemeHash: 'scheme-v1', questionsHash: 'questions-v1' };
  const assets = [];
  const evaluations = [];
  const walkthroughs = [];
  const experiences = [];
  for (const [productIndex, product] of products.entries()) {
    for (const question of questions) {
      const mediaIds = Array.from({ length: imagesPerQuestion }, (_, index) => `${product.id}-${question.id}-${index + 1}`);
      for (const id of mediaIds) assets.push({ id, projectId: project.id, questionId: question.id, productId: product.id, role: 'output', name: `${id}.png`, mime: 'image/png', size: 1, sha256: `sha-${id}`, createdAt: stamp });
      evaluations.push({ id: `${product.id}-${question.id}-v1`, projectId: project.id, productId: product.id, questionId: question.id, reviewerId: product.ownerId, revision: 1, parentId: null, status: 'submitted', mediaIds, bestMediaId: mediaIds[0] ?? null, mediaChecks: mediaIds.map(mediaId => ({ mediaId, usable: true, infringement: false })), tags: [], seconds: 30 + productIndex * 10, failed: false, failureReason: '', notes: '', schemeHash: project.schemeHash, questionsHash: project.questionsHash, createdAt: stamp });
    }
    for (const task of ['background', 'color', 'expand']) walkthroughs.push({ id: `${product.id}-${task}`, projectId: project.id, productId: product.id, task, status: 'submitted', completed: true, steps: 1, tags: [], notes: '' });
    experiences.push({ productId: product.id, score: 5, notes: '' });
  }
  return { project, assets, evaluations, walkthroughs, experiences };
}

function results(bundle) { return summarizeProject(bundle); }
function result(bundle, id = 'p1') { return results(bundle).find(item => item.productId === id); }
function record(bundle, productId = 'p1', questionId = 'q1') { return bundle.evaluations.find(item => item.productId === productId && item.questionId === questionId); }
function failWithoutOutput(bundle, productId = 'p1', questionId = 'q1') {
  const evaluation = record(bundle, productId, questionId);
  evaluation.failed = true;
  evaluation.failureReason = '服务中断，没有生成图片';
  evaluation.tags = [{ code: 'G-04', severity: 'P1' }];
  evaluation.mediaIds = [];
  evaluation.mediaChecks = [];
  evaluation.bestMediaId = null;
  return evaluation;
}
function addRevision(bundle, previous, overrides = {}) {
  const next = { ...clone(previous), id: `${previous.id}-next`, parentId: previous.id, revision: previous.revision + 1, ...overrides };
  bundle.evaluations.push(next);
  return next;
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('three complete real products: exact dimension weights, E ranking and 50/50 G mix', () => {
  const bundle = fixture();
  record(bundle).tags = [{ code: 'G-01', severity: 'P2' }];
  bundle.experiences[0].score = 2;
  const [first, second, third] = results(bundle);
  for (const item of [first, second, third]) {
    assert.equal(item.submitted, 2);
    assert.equal(item.expected, 2);
    assert.equal(item.eligibility, 'eligible');
    assert.ok(Object.values(item.dimensions).every(metric => metric.complete));
    assert.equal(item.generated, 2);
    assert.equal(item.usableRate, 1);
    assert.deepEqual(item.missing, []);
  }
  assert.equal(first.dimensions.G.value, 3); // ((3 + 5) / 2) * .5 + 2 * .5
  assert.equal(first.dimensions.E.value, 5);
  assert.equal(second.dimensions.E.value, 4.5);
  assert.equal(third.dimensions.E.value, 4);
  close(first.total, 4.6);
  close(second.total, 4.95);
  close(third.total, 4.9);
});

test('a two-question trial requires an explicit plan of two; an incomplete plan of 50 remains a gap', () => {
  const bundle = fixture();
  assert.deepEqual(validateProject(bundle.project), []);
  assert.equal(result(bundle).expected, 2);
  assert.notEqual(result(bundle).total, null);
  bundle.project.expectedQuestionCount = 50;
  assert.match(validateProject(bundle.project).join('\n'), /题库.*计划.*若试跑请调整计划题量/);
  assert.match(validateEvaluation(bundle.project, record(bundle), bundle.assets).join('\n'), /题库.*计划/);
  const summary = result(bundle);
  assert.equal(summary.expected, 50);
  assert.equal(summary.submitted, 0);
  assert.equal(summary.dimensions.A.expected, 50);
  assert.equal(summary.dimensions.A.complete, false);
  assert.equal(summary.total, null);
  assert.match(summary.missing.join('\n'), /题库.*计划/);
});

test('planned count must be a positive integer and cannot hide excess imported questions', () => {
  const bundle = fixture(1, 2);
  for (const planned of [0, -1, .5, NaN, Infinity]) {
    bundle.project.expectedQuestionCount = planned;
    assert.match(validateProject(bundle.project).join('\n'), /计划题量必须为正整数/);
    assert.equal(result(bundle).expected, 2);
    assert.equal(result(bundle).total, null);
  }
  bundle.project.expectedQuestionCount = 1;
  assert.match(validateProject(bundle.project).join('\n'), /题库.*计划/);
  assert.equal(result(bundle).expected, 2);
  assert.equal(result(bundle).total, null);
});

test('direct evaluation submission cannot bypass preparation with a blank product name or version', () => {
  const bundle = fixture(1, 1);
  bundle.project.products[0].name = ' ';
  assert.match(validateEvaluation(bundle.project, record(bundle), bundle.assets).join('\n'), /产品.*名称不可为空/);
  assert.equal(result(bundle).submitted, 0);
  assert.equal(result(bundle).total, null);
  bundle.project.products[0].name = '真实产品';
  bundle.project.products[0].version = '';
  assert.match(validateEvaluation(bundle.project, record(bundle), bundle.assets).join('\n'), /产品.*版本或档位不可为空/);
  assert.equal(result(bundle).total, null);
});

test('task collection ignores unrelated product setup without weakening project reporting', () => {
  const bundle = fixture(3, 1);
  const unfinished = bundle.project.products[1];
  unfinished.name = '';
  unfinished.version = '';
  unfinished.totalCost = -1;
  const current = record(bundle);
  assert.deepEqual(current.tags, []); // No issue means no diagnosis tags are required.
  assert.deepEqual(validateEvaluation(bundle.project, current, bundle.assets, { scope: 'task' }), []);
  assert.match(validateEvaluation(bundle.project, current, bundle.assets).join('\n'), /产品.*名称不可为空/);
  assert.match(validateProject(bundle.project).join('\n'), /版本或档位不可为空/);
  assert.equal(result(bundle).total, null);
  unfinished.name = '已补齐竞品';
  unfinished.version = 'Web';
  unfinished.ownerId = bundle.project.members[1].id;
  unfinished.totalCost = null;
  assert.deepEqual(validateEvaluation(bundle.project, current, bundle.assets), []);
  assert.equal(result(bundle).submitted, 1);
});

test('task collection still validates the current product and its evidence', () => {
  const bundle = fixture(2, 1);
  const current = record(bundle);
  bundle.project.products[0].version = '';
  current.bestMediaId = null;
  current.mediaChecks[0].usable = null;
  const errors = validateEvaluation(bundle.project, current, bundle.assets, { scope: 'task' }).join('\n');
  assert.match(errors, /版本或档位不可为空/);
  assert.match(errors, /请选择最佳图/);
  assert.match(errors, /尚未检查可用性/);
  current.productId = 'missing-product';
  assert.match(validateEvaluation(bundle.project, current, bundle.assets, { scope: 'task' }).join('\n'), /被测产品不存在/);
});

test('task collection preserves project structure, rule and question completeness checks', () => {
  const bundle = fixture(2, 1);
  bundle.project.rulesConfirmed = false;
  bundle.project.expectedQuestionCount = 50;
  bundle.project.products.push(clone(bundle.project.products[1]));
  bundle.project.products[1].ownerId = '';
  const errors = validateEvaluation(bundle.project, record(bundle), bundle.assets, { scope: 'task' }).join('\n');
  assert.match(errors, /确认评测规则/);
  assert.match(errors, /计划 50 题/);
  assert.match(errors, /产品 ID 不可重复/);
  assert.match(errors, /负责人不在项目成员中/);
});

test('project publication rejects invalid owners, members, versions, questions, weights and rules', () => {
  const bundle = fixture();
  bundle.project.name = ' ';
  bundle.project.members.push(clone(bundle.project.members[0]));
  bundle.project.products[0].ownerId = 'missing';
  bundle.project.products[0].version = '';
  bundle.project.questions[0].request = '';
  bundle.project.questions[0].acceptance = [];
  bundle.project.questions.push(clone(bundle.project.questions[1]));
  bundle.project.scheme.dimensions[0].weight++;
  bundle.project.rulesConfirmed = false;
  const errors = validateProject(bundle.project).join('\n');
  for (const expected of ['项目名称', '成员 ID 不可重复', '负责人', '版本', '需求描述', '验收要点', '题目 ID 不可重复', '100%', '确认']) assert.match(errors, new RegExp(expected));
  bundle.project.products.forEach(product => { product.demo = true; });
  assert.match(validateProject(bundle.project).join('\n'), /真实产品/);
});

test('severity adjustment is limited to one step, with F-01 fixed at P0', () => {
  const tag = { code: 'A-x', name: '', dimension: 'A', severity: 'P1' };
  assert.deepEqual(allowedSeverities(tag), ['P0', 'P1', 'P2']);
  assert.deepEqual(allowedSeverities({ ...tag, severity: 'P0' }), ['P0', 'P1']);
  assert.deepEqual(allowedSeverities({ ...tag, severity: 'P2' }), ['P1', 'P2', 'P3']);
  assert.deepEqual(allowedSeverities({ ...tag, severity: 'P3' }), ['P2', 'P3']);
  assert.deepEqual(allowedSeverities({ ...tag, code: 'F-01' }), ['P0']);
});

test('the most severe tag wins within each dimension; P0 maps to one', () => {
  const bundle = fixture();
  const evaluation = record(bundle);
  evaluation.tags = [{ code: 'A-01', severity: 'P2' }, { code: 'A-04', severity: 'P3' }];
  assert.deepEqual(validateEvaluation(bundle.project, evaluation, bundle.assets), []);
  assert.equal(result(bundle).dimensions.A.value, 4); // 3 and 5
  evaluation.tags.push({ code: 'A-03', severity: 'P0' });
  evaluation.mediaChecks[0].usable = false;
  assert.equal(result(bundle).dimensions.A.value, 3); // 1 and 5
  assert.equal(result(bundle).dimensions.B.value, 5);
});

test('an explicit complete empty-label submission scores five; a draft never does', () => {
  const bundle = fixture();
  assert.equal(result(bundle).dimensions.A.value, 5);
  record(bundle).status = 'draft';
  const summary = result(bundle);
  assert.equal(summary.dimensions.A.value, 5); // reference average from the other question only
  assert.equal(summary.dimensions.A.n, 1);
  assert.equal(summary.dimensions.A.expected, 2);
  assert.equal(summary.dimensions.A.complete, false);
  assert.equal(summary.total, null);
  assert.match(summary.missing.join('\n'), /草稿/);
});

test('unchecked media, missing originals and incomplete records remain gaps', () => {
  for (const mutation of [
    bundle => { record(bundle).mediaChecks[0].usable = null; },
    bundle => { record(bundle).mediaChecks[0].infringement = null; },
    bundle => { bundle.assets = bundle.assets.filter(asset => asset.id !== record(bundle).mediaIds[0]); },
    bundle => { record(bundle).seconds = null; }
  ]) {
    const bundle = fixture();
    mutation(bundle);
    const summary = result(bundle);
    assert.equal(summary.submitted, 1);
    assert.equal(summary.dimensions.A.complete, false);
    assert.equal(summary.total, null);
    assert.ok(summary.missing.length > 0);
  }
});

test('non-failed submissions require original output, a valid best reference and complete media checks', () => {
  const bundle = fixture(1, 1);
  const evaluation = record(bundle);
  evaluation.mediaIds = [];
  evaluation.mediaChecks = [];
  evaluation.bestMediaId = null;
  assert.match(validateEvaluation(bundle.project, evaluation, bundle.assets).join('\n'), /非失败任务必须有原始输出/);
  const valid = fixture(1, 1);
  record(valid).bestMediaId = 'ghost';
  assert.match(validateEvaluation(valid.project, record(valid), valid.assets).join('\n'), /最佳图/);
  record(valid).bestMediaId = record(valid).mediaIds[0];
  record(valid).mediaChecks = [];
  assert.match(validateEvaluation(valid.project, record(valid), valid.assets).join('\n'), /可用性|侵权/);
});

test('validation rejects unknown tags, D image tags, duplicate tags and out-of-range severity', () => {
  const bundle = fixture(1, 1);
  record(bundle).tags = [{ code: 'unknown', severity: 'P1' }, { code: 'D-01', severity: 'P1' }, { code: 'C-01', severity: 'P0' }, { code: 'C-01', severity: 'P2' }];
  const errors = validateEvaluation(bundle.project, record(bundle), bundle.assets).join('\n');
  assert.match(errors, /未知问题标签/);
  assert.match(errors, /不适用于/);
  assert.match(errors, /超出允许/);
  assert.match(errors, /不可重复/);
});

test('seconds must be finite and non-negative; zero seconds is allowed', () => {
  const bundle = fixture(1, 1);
  for (const seconds of [null, -1, NaN, Infinity]) {
    record(bundle).seconds = seconds;
    assert.match(validateEvaluation(bundle.project, record(bundle), bundle.assets).join('\n'), /生成耗时/);
  }
  record(bundle).seconds = 0;
  assert.deepEqual(validateEvaluation(bundle.project, record(bundle), bundle.assets), []);
});

test('formal submission requires confirmed rules and a valid product owner', () => {
  const bundle = fixture(1, 1);
  bundle.project.rulesConfirmed = false;
  assert.match(validateEvaluation(bundle.project, record(bundle), bundle.assets).join('\n'), /确认评测规则/);
  bundle.project.rulesConfirmed = true;
  bundle.project.products[0].ownerId = 'missing';
  assert.match(validateEvaluation(bundle.project, record(bundle), bundle.assets).join('\n'), /负责人不在项目成员/);
});

test('unrelated output metadata cannot satisfy a missing original reference', () => {
  const bundle = fixture(1, 1);
  for (const [field, wrongValue] of [['projectId', 'other-project'], ['productId', 'other-product'], ['questionId', 'other-question'], ['role', 'reference']]) {
    const changed = clone(bundle);
    changed.assets[0][field] = wrongValue;
    assert.match(validateEvaluation(changed.project, record(changed), changed.assets).join('\n'), /原图缺失或归属不匹配/);
    assert.equal(result(changed).eligibility, 'pending');
  }
});

test('best-image P0/P1 and infringement cannot be usable; G process tags do not change image usability', () => {
  const bundle = fixture(1, 1);
  const evaluation = record(bundle);
  evaluation.tags = [{ code: 'A-01', severity: 'P1' }];
  assert.match(validateEvaluation(bundle.project, evaluation, bundle.assets).join('\n'), /不可标记为可用/);
  evaluation.tags = [{ code: 'G-04', severity: 'P1' }];
  assert.deepEqual(validateEvaluation(bundle.project, evaluation, bundle.assets), []);
  evaluation.tags = [{ code: 'F-01', severity: 'P0' }];
  evaluation.mediaChecks[0].infringement = true;
  assert.match(validateEvaluation(bundle.project, evaluation, bundle.assets).join('\n'), /侵权风险的图片/);
  evaluation.mediaChecks[0].usable = false;
  assert.deepEqual(validateEvaluation(bundle.project, evaluation, bundle.assets), []);
  evaluation.mediaChecks[0].infringement = false;
  assert.match(validateEvaluation(bundle.project, evaluation, bundle.assets).join('\n'), /F-01.*不一致/);
});

test('required reference names must exactly match reference metadata for this question', () => {
  const bundle = fixture(1, 1);
  bundle.project.questions[0].referenceNames = ['Reference.png'];
  assert.match(validateEvaluation(bundle.project, record(bundle), bundle.assets).join('\n'), /参考图缺失/);
  const reference = { ...bundle.assets[0], id: 'reference', role: 'reference', productId: null, name: 'reference.png' };
  bundle.assets.push(reference);
  assert.match(validateEvaluation(bundle.project, record(bundle), bundle.assets).join('\n'), /参考图缺失/);
  reference.name = 'Reference.png';
  assert.deepEqual(validateEvaluation(bundle.project, record(bundle), bundle.assets), []);
  reference.questionId = 'another-question';
  assert.match(validateEvaluation(bundle.project, record(bundle), bundle.assets).join('\n'), /参考图缺失/);
});

test('failed tasks require a reason and G-03 or G-04, even with zero output', () => {
  const bundle = fixture(1, 1);
  const evaluation = failWithoutOutput(bundle);
  assert.deepEqual(validateEvaluation(bundle.project, evaluation, bundle.assets), []);
  evaluation.failureReason = '';
  evaluation.tags = [];
  const errors = validateEvaluation(bundle.project, evaluation, bundle.assets).join('\n');
  assert.match(errors, /失败原因/);
  assert.match(errors, /G-03.*G-04/);
});

test('unresolved failed-no-output policy keeps image gaps and a reference mean', () => {
  const bundle = fixture(1, 2);
  failWithoutOutput(bundle);
  const summary = result(bundle);
  assert.equal(summary.submitted, 2);
  assert.equal(summary.dimensions.A.value, 5);
  assert.equal(summary.dimensions.A.n, 1);
  assert.equal(summary.dimensions.A.expected, 2);
  assert.equal(summary.dimensions.A.complete, false);
  assert.equal(summary.total, null);
  assert.equal(summary.dimensions.G.value, 4.25);
});

test('score-one gives each image dimension one for a failed zero-output task', () => {
  const bundle = fixture(1, 2);
  failWithoutOutput(bundle);
  bundle.project.scheme.policies.failedNoOutput = 'score-one';
  const summary = result(bundle);
  for (const id of ['A', 'B', 'C', 'F']) {
    assert.equal(summary.dimensions[id].value, 3);
    assert.equal(summary.dimensions[id].complete, true);
  }
  assert.equal(summary.generated, 1);
  assert.equal(summary.usableRate, 1);
  assert.equal(summary.dimensions.G.value, 4.25);
  assert.notEqual(summary.total, null);
});

test('explicit exclusion adjusts only image denominators and can be complete', () => {
  const bundle = fixture(1, 2);
  failWithoutOutput(bundle);
  bundle.project.scheme.policies.failedNoOutput = 'exclude';
  const summary = result(bundle);
  assert.equal(summary.dimensions.A.value, 5);
  assert.equal(summary.dimensions.A.n, 1);
  assert.equal(summary.dimensions.A.expected, 1);
  assert.equal(summary.dimensions.A.complete, true);
  assert.match(summary.dimensions.A.reasons.join('\n'), /明确排除 1/);
  assert.equal(summary.dimensions.G.n, 2);
  assert.equal(summary.meanSeconds, 30);
  close(summary.total, 4.85);
});

test('all-zero-output never produces an image average under exclusion or a complete total', () => {
  const bundle = fixture(1, 2);
  failWithoutOutput(bundle, 'p1', 'q1');
  failWithoutOutput(bundle, 'p1', 'q2');
  bundle.project.scheme.policies.failedNoOutput = 'exclude';
  bundle.project.scheme.policies.zeroUsableCost = 'score-one';
  const summary = result(bundle);
  assert.equal(summary.dimensions.A.value, null);
  assert.equal(summary.dimensions.A.expected, 0);
  assert.equal(summary.dimensions.A.complete, false);
  assert.equal(summary.usableRate, null);
  assert.equal(summary.costPerUsable, null);
  assert.equal(summary.total, null);
});

test('incomplete simulation results do not enter real speed/cost rankings or block totals', () => {
  const bundle = fixture(4, 2);
  bundle.project.products[3].demo = true;
  bundle.project.products[3].totalCost = null;
  bundle.evaluations = bundle.evaluations.filter(item => item.productId !== 'p4');
  bundle.walkthroughs = bundle.walkthroughs.filter(item => item.productId !== 'p4');
  const summaries = results(bundle);
  assert.deepEqual(summaries.slice(0, 3).map(item => item.dimensions.E.value), [5, 4.5, 4]);
  assert.ok(summaries.slice(0, 3).every(item => item.total !== null));
  assert.equal(summaries[3].eligibility, 'simulated');
  assert.equal(summaries[3].total, null);
});

test('unresolved speed ties create gaps; dense ties use 5,5,4', () => {
  const bundle = fixture();
  bundle.evaluations.filter(item => item.productId === 'p2').forEach(item => { item.seconds = 30; });
  bundle.evaluations.filter(item => item.productId === 'p3').forEach(item => { item.seconds = 40; });
  assert.ok(results(bundle).every(item => item.dimensions.E.value === null && item.total === null));
  bundle.project.scheme.policies.rankingTies = 'dense';
  assert.deepEqual(results(bundle).map(item => item.dimensions.E.value), [5, 4.75, 4.25]);
});

test('unresolved cost ties create gaps; dense cost ties use 5,5,4', () => {
  const bundle = fixture();
  bundle.project.products[1].totalCost = 10;
  bundle.project.products[2].totalCost = 20;
  assert.ok(results(bundle).every(item => item.dimensions.E.complete === false));
  bundle.project.scheme.policies.rankingTies = 'dense';
  assert.deepEqual(results(bundle).map(item => item.dimensions.E.value), [5, 4.75, 4.25]);
});

test('zero fee is legitimate, unknown fee is not treated as free', () => {
  const bundle = fixture();
  bundle.project.products[0].totalCost = 0;
  assert.equal(result(bundle).costPerUsable, 0);
  assert.equal(result(bundle).dimensions.E.complete, true);
  bundle.project.products[0].totalCost = null;
  assert.equal(result(bundle).costPerUsable, null);
  assert.ok(results(bundle).every(item => item.total === null));
  assert.match(result(bundle).missing.join('\n'), /费用未知/);
});

test('zero usable cost policy scores only the cost component one and never divides by zero', () => {
  const bundle = fixture();
  bundle.evaluations.filter(item => item.productId === 'p1').forEach(item => { item.mediaChecks[0].usable = false; });
  assert.equal(result(bundle).costPerUsable, null);
  assert.ok(results(bundle).every(item => item.dimensions.E.value === null));
  bundle.project.scheme.policies.zeroUsableCost = 'score-one';
  const summaries = results(bundle);
  assert.equal(summaries[0].usableRate, 0);
  assert.equal(summaries[0].costPerUsable, null);
  assert.equal(summaries[0].dimensions.E.value, 2); // .5*1 + .25*5 + .25*1
  assert.equal(summaries[0].dimensions.E.complete, true);
  assert.equal(summaries[1].dimensions.E.value, 4.75);
});

test('usable-rate thresholds include exactly 80%, 60%, 40% and 20%', () => {
  for (const [usable, expectedScore] of [[4, 5], [3, 4.5], [2, 4], [1, 3.5]]) {
    const bundle = fixture(1, 1, 5);
    record(bundle).mediaChecks.forEach((check, index) => { check.usable = index < usable; });
    assert.equal(result(bundle).dimensions.E.value, expectedScore);
  }
});

test('infringement veto uses all output images, reaches exactly 5%, and ignores best-only shortcuts', () => {
  const bundle = fixture(1, 1, 20);
  const evaluation = record(bundle);
  evaluation.mediaChecks[19].infringement = true;
  evaluation.mediaChecks[19].usable = false;
  assert.deepEqual(evaluation.tags, []); // the best image is not the infringing one
  assert.deepEqual(validateEvaluation(bundle.project, evaluation, bundle.assets), []);
  assert.equal(result(bundle).infringementRate, .05);
  assert.equal(result(bundle).eligibility, 'vetoed');
  const below = fixture(1, 1, 21);
  record(below).mediaChecks[20].infringement = true;
  record(below).mediaChecks[20].usable = false;
  assert.equal(result(below).eligibility, 'eligible');
  close(result(below).infringementRate, 1 / 21);
});

test('unreviewed commercial use or incomplete infringement checks are pending; unclear/forbidden veto', () => {
  const bundle = fixture(1, 1);
  bundle.project.products[0].commercialUse = 'unreviewed';
  assert.equal(result(bundle).eligibility, 'pending');
  for (const use of ['unclear', 'forbidden']) {
    bundle.project.products[0].commercialUse = use;
    assert.equal(result(bundle).eligibility, 'vetoed');
  }
  bundle.project.products[0].commercialUse = 'allowed';
  record(bundle).mediaChecks[0].infringement = null;
  assert.equal(result(bundle).eligibility, 'pending');
  assert.equal(result(bundle).infringementRate, null);
});

test('latest draft suppresses its submitted ancestor without mutating history; a new submission restores it', () => {
  const bundle = fixture(1, 2);
  const original = clone(record(bundle));
  const draft = addRevision(bundle, record(bundle), { id: 'draft-v2', status: 'draft' });
  assert.equal(latestEvaluations(bundle.evaluations).find(item => item.questionId === 'q1').id, draft.id);
  assert.equal(result(bundle).submitted, 1);
  assert.equal(result(bundle).total, null);
  const submitted = addRevision(bundle, draft, { id: 'submitted-v3', status: 'submitted' });
  assert.equal(latestEvaluations(bundle.evaluations).find(item => item.questionId === 'q1').id, submitted.id);
  assert.notEqual(result(bundle).total, null);
  assert.deepEqual(bundle.evaluations.find(item => item.id === original.id), original);
  assert.equal(bundle.evaluations.length, 4);
});

test('same-revision branches are omitted and reported instead of silently picking one', () => {
  const bundle = fixture(1, 2);
  const original = record(bundle);
  addRevision(bundle, original, { id: 'branch-a' });
  addRevision(bundle, original, { id: 'branch-b' });
  assert.equal(latestEvaluations(bundle.evaluations).some(item => item.questionId === 'q1'), false);
  assert.equal(result(bundle).total, null);
  assert.match(result(bundle).missing.join('\n'), /分叉/);
});

test('unequal branch heights, duplicate-id conflicts and orphaned parents cannot evade fork checks', () => {
  const bundle = fixture(1, 1);
  const original = record(bundle);
  const branch = addRevision(bundle, original, { id: 'branch-a' });
  addRevision(bundle, original, { id: 'branch-b' });
  addRevision(bundle, branch, { id: 'branch-a-v3' });
  assert.deepEqual(latestEvaluations(bundle.evaluations), []);
  const duplicate = fixture(1, 1);
  duplicate.evaluations.push({ ...clone(record(duplicate)), notes: 'same ID, changed payload' });
  assert.deepEqual(latestEvaluations(duplicate.evaluations), []);
  const orphan = fixture(1, 1);
  record(orphan).parentId = 'missing-parent';
  record(orphan).revision = 2;
  assert.deepEqual(latestEvaluations(orphan.evaluations), []);
});

test('repeated identical revisions are idempotent and do not increase sample counts', () => {
  const bundle = fixture(1, 1);
  bundle.evaluations.push(clone(record(bundle)));
  assert.equal(latestEvaluations(bundle.evaluations).length, 1);
  assert.equal(result(bundle).submitted, 1);
  assert.equal(result(bundle).generated, 1);
});

test('a latest revision with mismatched snapshots cannot fall back to an old valid submission', () => {
  const bundle = fixture(1, 2);
  addRevision(bundle, record(bundle), { id: 'stale-rules', schemeHash: 'different-rules' });
  assert.equal(result(bundle).submitted, 1);
  assert.equal(result(bundle).total, null);
  assert.match(result(bundle).missing.join('\n'), /快照不匹配/);
  const questions = fixture(1, 1);
  record(questions).questionsHash = '';
  assert.equal(result(questions).submitted, 0);
  assert.equal(result(questions).total, null);
});

test('D requires all three valid walkthroughs; missing G experience is not filled with five', () => {
  const bundle = fixture(1, 2);
  bundle.walkthroughs.pop();
  assert.equal(result(bundle).dimensions.D.n, 2);
  assert.equal(result(bundle).dimensions.D.value, 5);
  assert.equal(result(bundle).dimensions.D.complete, false);
  assert.equal(result(bundle).total, null);
  bundle.experiences = [];
  assert.equal(result(bundle).dimensions.G.value, null);
  assert.equal(result(bundle).dimensions.G.complete, false);
});

test('incomplete walkthrough cannot silently score five; valid D tags use their highest severity', () => {
  const bundle = fixture(1, 1);
  bundle.walkthroughs[0].completed = false;
  assert.equal(result(bundle).dimensions.D.complete, false);
  bundle.walkthroughs[0].tags = [{ code: 'D-01', severity: 'P1' }, { code: 'D-02', severity: 'P2' }];
  assert.equal(result(bundle).dimensions.D.complete, true);
  assert.equal(result(bundle).dimensions.D.value, 4); // (2+5+5)/3
});

test('unconfirmed rules and invalid weight sum prevent formal totals even with complete metrics', () => {
  const bundle = fixture(1, 1);
  bundle.project.rulesConfirmed = false;
  assert.equal(result(bundle).total, null);
  assert.match(result(bundle).missing.join('\n'), /规则尚未确认/);
  bundle.project.rulesConfirmed = true;
  bundle.project.scheme.dimensions[0].weight = 30;
  assert.equal(result(bundle).total, null);
  assert.match(result(bundle).missing.join('\n'), /100%/);
});

test('ranked speed and cost scores bottom out at one for larger real product sets', () => {
  const bundle = fixture(6, 1);
  const summaries = results(bundle);
  assert.equal(summaries[0].dimensions.E.value, 5);
  assert.equal(summaries[4].dimensions.E.value, 3); // 50%*5 + 25%*1 + 25%*1
  assert.equal(summaries[5].dimensions.E.value, 3);
});

test('summary is a pure calculation and leaves bundle and revision order unchanged', () => {
  const bundle = fixture();
  const before = clone(bundle);
  summarizeProject(bundle);
  latestEvaluations(bundle.evaluations);
  assert.deepEqual(bundle, before);
});
