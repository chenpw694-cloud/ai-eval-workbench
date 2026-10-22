import test from 'node:test';
import assert from 'node:assert/strict';
import { frozenConfigurationMatches, productInfoCorrectionErrors } from '../src/core/projectEditing.ts';
import { fixture } from './helpers/formal-fixture.mjs';

function setup(status = 'draft') {
  const previous = structuredClone(fixture().project);
  previous.status = status;
  previous.products[1].name = '';
  previous.products[1].version = '  ';
  return previous;
}

test('submitted but undistributed projects can complete original blank product labels without changing IDs', () => {
  const previous = setup(), next = structuredClone(previous);
  next.products[1].name = '后续补齐的竞品';
  next.products[1].version = 'Web 标准版';
  assert.equal(frozenConfigurationMatches(previous, next), true);
  assert.equal(previous.products[1].name, '');
  assert.equal(previous.products[1].version, '  ');
});

test('product names and versions can be corrected repeatedly after submission or activation', () => {
  for (const status of ['draft', 'active']) {
    const previous = setup(status), next = structuredClone(previous);
    next.products[0].name = '更正后的产品'; next.products[0].version = '实际会员档位';
    assert.equal(frozenConfigurationMatches(previous, next), true);
    const again = structuredClone(next);
    again.products[0].name = '再次更正的名称'; again.products[0].version = '网页免费版';
    assert.equal(frozenConfigurationMatches(next, again), true);
    for (const field of ['name', 'version']) {
      const cleared = structuredClone(next); cleared.products[0][field] = '';
      assert.equal(frozenConfigurationMatches(previous, cleared), false);
      assert.match(productInfoCorrectionErrors(previous, cleared).join(), /不可清空/);
    }
  }
});

test('blank label repairs must be meaningful, not another blank or whitespace value', () => {
  const previous = setup(), next = structuredClone(previous);
  next.products[1].name = '   ';
  assert.equal(frozenConfigurationMatches(previous, next), false);
  next.products[1].name = '';
  next.products[1].version = '';
  assert.equal(frozenConfigurationMatches(previous, next), false);
  assert.equal(frozenConfigurationMatches(previous, structuredClone(previous)), true);
});

test('correcting product information does not unlock IDs, real/demo scope, membership or scoring rules', () => {
  const previous = setup();
  const changes = [
    next => { next.products[1].id = 'replacement-id'; },
    next => { next.products[1].demo = !next.products[1].demo; },
    next => { next.products.pop(); },
    next => { next.members[0].id = 'replacement-member'; },
    next => { next.members.push({ id: 'new-member', name: '新增人员' }); },
    next => { next.members.pop(); },
    next => { next.questions[0].request = '新题目'; },
    next => { next.scheme.version = '9.9.9'; },
    next => { next.rulesConfirmed = !next.rulesConfirmed; },
    next => { next.expectedQuestionCount += 1; }
  ];
  for (const change of changes) {
    const next = structuredClone(previous);
    next.products[1].name = '允许补齐的名称';
    change(next);
    assert.equal(frozenConfigurationMatches(previous, next), false);
  }
});

test('frozen projects allow nonempty member name corrections while IDs and assignments remain unchanged', () => {
  for (const status of ['draft', 'active']) {
    const previous = setup(status), next = structuredClone(previous);
    const original = structuredClone(previous);
    next.members[0].name = '更正后的姓名';
    next.members[1].name = '同组评测员';
    assert.equal(frozenConfigurationMatches(previous, next), true);
    assert.deepEqual(next.members.map(member => member.id), previous.members.map(member => member.id));
    assert.deepEqual(next.products, previous.products);
    assert.deepEqual(previous, original);
    for (const value of ['', '  ', undefined]) {
      const invalid = structuredClone(next); invalid.members[0].name = value;
      assert.equal(frozenConfigurationMatches(previous, invalid), false);
    }
  }
});

test('active projects can complete blank labels but cannot downgrade their frozen status', () => {
  const previous = setup('active');
  for (const field of ['name', 'version']) {
    const next = structuredClone(previous);
    next.products[1][field] = '补齐';
    assert.equal(frozenConfigurationMatches(previous, next), true);
  }
  const downgraded = { ...structuredClone(previous), status: 'draft' };
  assert.equal(frozenConfigurationMatches(previous, downgraded), false);
  assert.equal(frozenConfigurationMatches(previous, structuredClone(previous)), true);
});

test('project description and recorded cost or commercial evidence stay editable after freezing', () => {
  for (const status of ['draft', 'active']) {
    const previous = setup(status), next = structuredClone(previous);
    next.name = '修订后的项目标题';
    next.background = '补充业务背景';
    next.period = '延长一天';
    next.products[0].totalCost = 30;
    next.products[0].commercialUse = 'allowed';
    next.products[0].commercialEvidence = '补充协议链接';
    assert.equal(frozenConfigurationMatches(previous, next), true);
  }
});

test('undistributed product labels may be completed while transitioning to a frozen active snapshot', () => {
  const previous = setup(), next = structuredClone(previous);
  next.products[1].name = '已补齐的产品';
  next.products[1].version = 'Web';
  next.status = 'active';
  assert.equal(frozenConfigurationMatches(previous, next), true);
});

test('product role and owner corrections require a valid role and an existing member', () => {
  for (const status of ['draft', 'active']) {
    const previous = setup(status), next = structuredClone(previous);
    next.products[0].role = 'benchmark'; next.products[0].ownerId = previous.members[1].id;
    assert.equal(frozenConfigurationMatches(previous, next), true);
    assert.equal(next.products[0].id, previous.products[0].id);
    for (const [field, value] of [['ownerId', 'foreign-member'], ['ownerId', ''], ['role', 'unknown']]) {
      const invalid = structuredClone(next); invalid.products[0][field] = value;
      assert.equal(frozenConfigurationMatches(previous, invalid), false);
      assert.ok(productInfoCorrectionErrors(previous, invalid).length);
    }
  }
});
