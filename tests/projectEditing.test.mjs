import test from 'node:test';
import assert from 'node:assert/strict';
import { frozenConfigurationMatches } from '../src/core/projectEditing.ts';
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

test('the completion allowance cannot replace or clear already filled product names or versions', () => {
  const previous = setup();
  for (const [field, value] of [['name', '另一个产品'], ['name', ''], ['version', 'v99'], ['version', '']]) {
    const next = structuredClone(previous);
    next.products[0][field] = value;
    assert.equal(frozenConfigurationMatches(previous, next), false, `${field} -> ${value}`);
  }
  const completed = structuredClone(previous);
  completed.products[1].name = '已补齐名称';
  const replacement = structuredClone(completed);
  replacement.products[1].name = '改成其他名称';
  assert.equal(frozenConfigurationMatches(completed, replacement), false);
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

test('repairing a label does not unlock product ownership, scope, membership or scoring rules', () => {
  const previous = setup();
  const changes = [
    next => { next.products[1].id = 'replacement-id'; },
    next => { next.products[1].ownerId = previous.members[0].id; },
    next => { next.products[1].role = 'self'; },
    next => { next.products[1].demo = !next.products[1].demo; },
    next => { next.products.pop(); },
    next => { next.members[0].name = '替换评测员'; },
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

test('active projects cannot complete blank labels or downgrade their status to bypass the team freeze', () => {
  const previous = setup('active');
  for (const field of ['name', 'version']) {
    const next = structuredClone(previous);
    next.products[1][field] = '补齐';
    assert.equal(frozenConfigurationMatches(previous, next), false);
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
