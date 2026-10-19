import test from 'node:test';
import assert from 'node:assert/strict';
import { planMerge, materializeMerge } from '../src/core/merge.ts';
import { latestEvaluations } from '../src/core/assessment.ts';

const stamp = '2026-10-21T12:00:00.000Z';
const clone = value => structuredClone(value);
function emptyBundle() {
  const members = [1, 2, 3].map(index => ({ id: `m${index}`, name: `评测员${index}` }));
  return {
    project: {
      id: 'project', name: '负责人项目', background: '保留本机背景', period: '3天',
      members, products: members.map((member, index) => ({ id: `p${index + 1}`, name: `产品${index + 1}`, version: 'v1', role: 'direct', demo: false, ownerId: member.id, totalCost: null, commercialUse: 'unreviewed', commercialEvidence: '' })),
      questions: [1, 2].map(index => ({ id: `q${index}`, title: `题目${index}`, scene: '主图', category: '美妆', difficulty: '基础', request: '商品图', acceptance: ['主体正确'], referenceNames: [], fields: {} })),
      scheme: { id: 'scheme', name: '方案', version: '1', dimensions: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((id, index) => ({ id, name: id, weight: index === 6 ? 40 : 10, method: '标签' })), tags: [], policies: { failedNoOutput: 'unresolved', rankingTies: 'unresolved', zeroUsableCost: 'unresolved' } },
      rulesConfirmed: true, expectedQuestionCount: 2, status: 'active', revision: 3,
      createdAt: stamp, updatedAt: stamp, schemeHash: 'scheme-hash', questionsHash: 'questions-hash'
    }, evaluations: [], assets: [], walkthroughs: [], experiences: []
  };
}
function evaluation(bundle, { productId = 'p1', questionId = 'q1', id = `${productId}-${questionId}-root`, parent = null, notes = '', status = 'submitted', createdAt = stamp } = {}) {
  const assetId = `${productId}-${questionId}-image`;
  if (!bundle.assets.some(asset => asset.id === assetId)) bundle.assets.push({ id: assetId, projectId: 'project', productId, questionId, role: 'output', name: `${assetId}.png`, mime: 'image/png', size: 100, sha256: `sha-${assetId}`, createdAt: stamp });
  const row = { id, projectId: 'project', productId, questionId, reviewerId: bundle.project.products.find(product => product.id === productId).ownerId, revision: parent ? parent.revision + 1 : 1, parentId: parent?.id ?? null, status, mediaIds: [assetId], bestMediaId: assetId, mediaChecks: [{ mediaId: assetId, usable: true, infringement: false }], tags: [], seconds: 10, failed: false, failureReason: '', notes, schemeHash: bundle.project.schemeHash, questionsHash: bundle.project.questionsHash, createdAt };
  bundle.evaluations.push(row);
  return row;
}
function info(bundle, productId = 'p1', cost = 10) {
  Object.assign(bundle.project.products.find(product => product.id === productId), { totalCost: cost, commercialUse: 'allowed', commercialEvidence: '商用协议' });
  bundle.walkthroughs.push({ id: `${productId}-background`, projectId: 'project', productId, task: 'background', status: 'submitted', completed: true, steps: 2, tags: [], notes: '' });
  bundle.experiences.push({ productId, score: 4, notes: '体验顺畅' });
}
function stage(bundle, { kind = 'baseline', senderId = 'm1', productIds = bundle.project.products.map(product => product.id), packageId = 'pkg' } = {}) {
  return { kind, senderId, productIds, packageId, bundle: clone(bundle), snapshots: [clone(bundle.project)] };
}
function submission(bundle, productId, packageId = `submit-${productId}`) {
  const selected = clone(bundle);
  selected.evaluations = selected.evaluations.filter(row => row.productId === productId);
  selected.assets = selected.assets.filter(row => row.role === 'reference' || row.productId === productId);
  selected.walkthroughs = selected.walkthroughs.filter(row => row.productId === productId);
  selected.experiences = selected.experiences.filter(row => row.productId === productId);
  return stage(selected, { kind: 'submission', productIds: [productId], senderId: selected.project.products.find(product => product.id === productId).ownerId, packageId });
}
function apply(plan, decisions = {}, resolver = 'm1', reason = '核对原图后采用', makeId = () => 'resolution', now = stamp) {
  return materializeMerge(plan, decisions, resolver, reason, makeId, now);
}

test('three reviewers can merge in any order with identical active records and product data', () => {
  const original = emptyBundle();
  const packets = ['p1', 'p2', 'p3'].map((productId, index) => {
    const source = clone(original);
    evaluation(source, { productId });
    evaluation(source, { productId, questionId: 'q2' });
    info(source, productId, index * 10);
    return submission(source, productId);
  });
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const merged = permutations.map(order => order.reduce((bundle, index) => {
    const plan = planMerge(bundle, packets[index]);
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual(plan.conflicts, []);
    return apply(plan);
  }, clone(original)));
  merged.forEach(bundle => assert.deepEqual(bundle, merged[0]));
  assert.equal(merged[0].evaluations.length, 6);
  assert.equal(merged[0].assets.length, 6);
  assert.equal(merged[0].walkthroughs.length, 3);
  assert.equal(merged[0].experiences.length, 3);
});

test('same package records are idempotent and count duplicates rather than new rows', () => {
  const source = emptyBundle();
  evaluation(source);
  info(source);
  const packet = submission(source, 'p1');
  const first = apply(planMerge(emptyBundle(), packet));
  const repeated = planMerge(first, packet);
  assert.equal(repeated.counts.new, 0);
  assert.equal(repeated.counts.duplicateEvaluations, 1);
  assert.equal(repeated.counts.duplicateAssets, 1);
  assert.equal(repeated.counts.duplicateProductInfos, 1);
  assert.equal(repeated.counts.duplicate, 3);
  assert.deepEqual(repeated.conflicts, []);
  assert.deepEqual(apply(repeated), first);
});

test('a complete linear descendant is merged from parent relationships regardless of timestamps', () => {
  const local = emptyBundle();
  const root = evaluation(local, { createdAt: '2030-01-01T00:00:00.000Z' });
  const incoming = clone(local);
  const child = evaluation(incoming, { id: 'child', parent: root, createdAt: '2020-01-01T00:00:00.000Z', notes: 'newer revision, earlier timestamp' });
  const plan = planMerge(local, submission(incoming, 'p1'));
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.counts.newEvaluations, 1);
  assert.equal(latestEvaluations(apply(plan).evaluations)[0].id, child.id);
});

test('an incoming ancestor never rolls back an existing local descendant', () => {
  const ancestor = emptyBundle();
  const root = evaluation(ancestor);
  const local = clone(ancestor);
  const child = evaluation(local, { id: 'child', parent: root, status: 'draft' });
  const plan = planMerge(local, submission(ancestor, 'p1'));
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.counts.newEvaluations, 0);
  assert.equal(latestEvaluations(apply(plan).evaluations)[0].id, child.id);
  assert.equal(latestEvaluations(apply(plan).evaluations)[0].status, 'draft');
});

test('a parent omitted from the incoming fragment can be supplied by the local chain', () => {
  const local = emptyBundle();
  const root = evaluation(local);
  const incoming = clone(local);
  const child = evaluation(incoming, { id: 'child', parent: root });
  incoming.evaluations = [child];
  const plan = planMerge(local, submission(incoming, 'p1'));
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(apply(plan).evaluations.length, 2);
});

test('historical ancestor hashes can differ while the unique current head must match the current snapshot', () => {
  const local = emptyBundle();
  const root = evaluation(local);
  root.schemeHash = 'historical-scheme';
  root.questionsHash = 'historical-questions';
  const incoming = clone(local);
  const child = evaluation(incoming, { id: 'current-head', parent: root });
  const plan = planMerge(local, submission(incoming, 'p1'));
  assert.deepEqual(plan.blockers, []);
  assert.equal(latestEvaluations(apply(plan).evaluations)[0].id, child.id);
  assert.equal(apply(plan).evaluations.find(row => row.id === root.id).schemeHash, 'historical-scheme');
  const invalid = clone(incoming);
  invalid.evaluations.find(row => row.id === child.id).schemeHash = 'stale-head';
  assert.match(planMerge(local, submission(invalid, 'p1')).blockers.join('\n'), /最新修订.*快照不匹配/);
});

test('an unresolved missing parent blocks materialization instead of becoming a new root', () => {
  const incoming = emptyBundle();
  const child = evaluation(incoming, { id: 'orphan' });
  child.parentId = 'missing';
  child.revision = 2;
  const plan = planMerge(emptyBundle(), submission(incoming, 'p1'));
  assert.match(plan.blockers.join('\n'), /缺少父修订/);
  assert.throws(() => apply(plan), /不能合并/);
});

test('independent roots produce an explicit evaluation conflict with both heads for UI', () => {
  const local = emptyBundle();
  const localRoot = evaluation(local, { id: 'local-root' });
  const incoming = emptyBundle();
  const incomingRoot = evaluation(incoming, { id: 'incoming-root', notes: 'independent assessment' });
  const plan = planMerge(local, submission(incoming, 'p1'));
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.conflicts.length, 1);
  const conflict = plan.conflicts[0];
  assert.equal(conflict.kind, 'evaluation');
  assert.ok(conflict.id && conflict.key && conflict.label);
  assert.equal(conflict.localHead.id, localRoot.id);
  assert.equal(conflict.incomingHead.id, incomingRoot.id);
  assert.equal(plan.merged.evaluations.length, 1);
});

test('incoming branch choice creates a resolver-authored descendant and preserves every local historical record', () => {
  const common = emptyBundle();
  const root = evaluation(common);
  const local = clone(common);
  const localHead = evaluation(local, { id: 'local-head', parent: root, notes: 'local content' });
  const incoming = clone(common);
  const incomingHead = evaluation(incoming, { id: 'incoming-head', parent: root, notes: 'source observation' });
  const plan = planMerge(local, submission(incoming, 'p1', 'remote-package'));
  const before = clone(local);
  assert.equal(plan.conflicts.length, 1);
  const merged = apply(plan, { [plan.conflicts[0].id]: 'incoming' }, 'm3', '原图支持对方判定', () => 'resolved-head', '2026-10-22T12:00:00.000Z');
  assert.deepEqual(merged.evaluations.find(row => row.id === root.id), before.evaluations[0]);
  assert.deepEqual(merged.evaluations.find(row => row.id === localHead.id), before.evaluations[1]);
  assert.equal(merged.evaluations.some(row => row.id === incomingHead.id), false);
  const head = latestEvaluations(merged.evaluations)[0];
  assert.equal(head.id, 'resolved-head');
  assert.equal(head.parentId, localHead.id);
  assert.equal(head.revision, 3);
  assert.equal(head.reviewerId, 'm3');
  assert.equal(head.createdAt, '2026-10-22T12:00:00.000Z');
  assert.match(head.notes, /source observation/);
  assert.match(head.notes, /remote-package.*incoming-head.*m3.*原图支持对方判定/);
  assert.deepEqual(local, before);
  assert.ok(plan.incoming.evaluations.some(row => row.id === incomingHead.id)); // retained for the storage receipt
});

test('local branch choice adds no incoming conflict history and never calls the ID generator', () => {
  const local = emptyBundle();
  evaluation(local, { id: 'local-root' });
  const incoming = emptyBundle();
  evaluation(incoming, { id: 'incoming-root' });
  const plan = planMerge(local, submission(incoming, 'p1'));
  const merged = apply(plan, { [plan.conflicts[0].id]: 'local' }, 'm1', '保留现有判断', () => { throw new Error('must not generate'); });
  assert.deepEqual(merged.evaluations, local.evaluations);
});

test('unequal-height forks remain conflicts, not a highest-revision or latest-time winner', () => {
  const rootBundle = emptyBundle();
  const root = evaluation(rootBundle);
  const local = clone(rootBundle);
  evaluation(local, { id: 'local-v2', parent: root, createdAt: '2030-01-01T00:00:00Z' });
  const incoming = clone(rootBundle);
  const v2 = evaluation(incoming, { id: 'incoming-v2', parent: root });
  evaluation(incoming, { id: 'incoming-v3', parent: v2 });
  const plan = planMerge(local, submission(incoming, 'p1'));
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].incomingHead.id, 'incoming-v3');
  assert.equal(plan.conflicts[0].localHead.id, 'local-v2');
});

test('a fork wholly inside one incoming package is blocked because there is no single incoming head', () => {
  const incoming = emptyBundle();
  const root = evaluation(incoming);
  evaluation(incoming, { id: 'fork-a', parent: root });
  evaluation(incoming, { id: 'fork-b', parent: root });
  const plan = planMerge(emptyBundle(), submission(incoming, 'p1'));
  assert.ok(plan.blockers.length > 0);
  assert.throws(() => apply(plan), /不能合并/);
});

test('same evaluation ID with a different payload is a hard blocker, even across different logical keys', () => {
  const local = emptyBundle();
  evaluation(local, { id: 'shared-id' });
  const incoming = clone(local);
  incoming.evaluations[0].notes = 'changed';
  let plan = planMerge(local, submission(incoming, 'p1'));
  assert.match(plan.blockers.join('\n'), /评测同 ID 内容不一致/);
  const other = emptyBundle();
  evaluation(other, { id: 'shared-id', questionId: 'q2' });
  plan = planMerge(local, submission(other, 'p1'));
  assert.match(plan.blockers.join('\n'), /评测同 ID 内容不一致/);
});

test('same image ID with differing metadata is blocked, while equal hashes with different IDs are retained', () => {
  const local = emptyBundle();
  evaluation(local);
  const incoming = clone(local);
  incoming.assets[0].name = 'different-name.png';
  assert.match(planMerge(local, submission(incoming, 'p1')).blockers.join('\n'), /图片同 ID 清单不一致/);
  incoming.assets[0] = { ...local.assets[0], id: 'second-image-id' };
  incoming.evaluations = [];
  const plan = planMerge(local, submission(incoming, 'p1'));
  assert.deepEqual(plan.blockers, []);
  assert.equal(apply(plan).assets.length, 2);
  assert.equal(new Set(apply(plan).assets.map(row => row.sha256)).size, 1);
});

test('all image metadata can be retained even when the local conflicting judgment wins', () => {
  const local = emptyBundle();
  evaluation(local, { id: 'local-root' });
  const incoming = emptyBundle();
  evaluation(incoming, { id: 'incoming-root' });
  incoming.assets[0].id = 'incoming-extra-image';
  incoming.evaluations[0].mediaIds = ['incoming-extra-image'];
  incoming.evaluations[0].bestMediaId = 'incoming-extra-image';
  incoming.evaluations[0].mediaChecks[0].mediaId = 'incoming-extra-image';
  const plan = planMerge(local, submission(incoming, 'p1'));
  const merged = apply(plan, { [plan.conflicts[0].id]: 'local' });
  assert.equal(merged.assets.length, 2);
  assert.equal(merged.evaluations.length, 1);
});

test('project identity and hashes are checked beyond the project display name and revision', () => {
  for (const change of [
    bundle => { bundle.project.id = 'another-project'; },
    bundle => { bundle.project.schemeHash = 'another-hash'; },
    bundle => { bundle.project.questionsHash = 'another-hash'; },
    bundle => { bundle.project.members[0].name = 'changed'; },
    bundle => { bundle.project.products[0].version = 'v2'; },
    bundle => { bundle.project.products[0].ownerId = 'm2'; },
    bundle => { bundle.project.questions[0].request = 'changed'; },
    bundle => { bundle.project.expectedQuestionCount = 50; },
    bundle => { bundle.project.rulesConfirmed = false; },
    bundle => { bundle.project.scheme.name = 'changed without new hash'; }
  ]) {
    const local = emptyBundle();
    const incoming = clone(local);
    change(incoming);
    assert.match(planMerge(local, stage(incoming)).blockers.join('\n'), /不兼容/);
  }
});

test('local project metadata, identity ordering and revision are preserved until storage increments it', () => {
  const local = emptyBundle();
  const incoming = emptyBundle();
  evaluation(incoming);
  incoming.project.name = '对方改的名称';
  incoming.project.background = '对方背景';
  incoming.project.period = 'different period';
  incoming.project.status = 'draft';
  incoming.project.revision = 100;
  incoming.project.updatedAt = '2030-01-01T00:00:00Z';
  incoming.project.members.reverse();
  incoming.project.products.reverse();
  const plan = planMerge(local, stage(incoming));
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(apply(plan).project, local.project);
});

test('submission scope is limited to products owned by the declared sender', () => {
  const incoming = emptyBundle();
  evaluation(incoming, { productId: 'p2' });
  const wrongSender = stage(incoming, { kind: 'submission', productIds: ['p2'], senderId: 'm1' });
  assert.match(planMerge(emptyBundle(), wrongSender).blockers.join('\n'), /发送人负责/);
  const scopeLeak = stage(incoming, { kind: 'submission', productIds: ['p1'], senderId: 'm1' });
  assert.match(planMerge(emptyBundle(), scopeLeak).blockers.join('\n'), /超出声明/);
  const unknownSender = stage(emptyBundle(), { senderId: 'outsider' });
  assert.match(planMerge(emptyBundle(), unknownSender).blockers.join('\n'), /发送人不在/);
});

test('assignment/baseline require full product scope; shared reference metadata is valid in a submission', () => {
  for (const kind of ['assignment', 'baseline']) {
    const packet = stage(emptyBundle(), { kind, productIds: ['p1'] });
    assert.match(planMerge(emptyBundle(), packet).blockers.join('\n'), /全部产品范围/);
  }
  const incoming = emptyBundle();
  incoming.assets.push({ id: 'reference', projectId: 'project', questionId: 'q1', productId: null, role: 'reference', name: 'ref.png', mime: 'image/png', size: 1, sha256: 'sha-ref', createdAt: stamp });
  assert.deepEqual(planMerge(emptyBundle(), submission(incoming, 'p1')).blockers, []);
});

test('out-of-scope mutable product information in a submission cannot alter another product', () => {
  const local = emptyBundle();
  const incoming = emptyBundle();
  incoming.project.products[1].totalCost = 999;
  const merged = apply(planMerge(local, submission(incoming, 'p1')));
  assert.equal(merged.project.products[1].totalCost, null);
});

test('an entirely default product-info tuple accepts nonempty incoming data automatically, including zero cost', () => {
  const local = emptyBundle();
  evaluation(local);
  const incoming = clone(local);
  info(incoming, 'p1', 0);
  const plan = planMerge(local, submission(incoming, 'p1'));
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.counts.newProductInfos, 1);
  const merged = apply(plan);
  assert.equal(merged.project.products[0].totalCost, 0);
  assert.equal(merged.project.products[0].commercialUse, 'allowed');
  assert.equal(merged.walkthroughs.length, 1);
  assert.equal(merged.experiences[0].score, 4);
});

test('an empty incoming tuple cannot erase existing product cost, authorization or auxiliary records', () => {
  const local = emptyBundle();
  info(local);
  const plan = planMerge(local, submission(emptyBundle(), 'p1'));
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(apply(plan), local);
});

test('differing nonempty product tuples require one explicit whole-tuple choice', () => {
  const local = emptyBundle();
  info(local, 'p1', 10);
  const incoming = emptyBundle();
  info(incoming, 'p1', 20);
  incoming.walkthroughs[0].steps = 3;
  incoming.experiences[0].score = 3;
  const plan = planMerge(local, submission(incoming, 'p1'));
  assert.equal(plan.conflicts.length, 1);
  const conflict = plan.conflicts[0];
  assert.equal(conflict.kind, 'product-info');
  assert.equal(conflict.local.totalCost, 10);
  assert.equal(conflict.incoming.totalCost, 20);
  assert.deepEqual(apply(plan, { [conflict.id]: 'local' }), local);
  const merged = apply(plan, { [conflict.id]: 'incoming' });
  assert.equal(merged.project.products[0].totalCost, 20);
  assert.equal(merged.walkthroughs[0].steps, 3);
  assert.equal(merged.experiences[0].score, 3);
  assert.equal(merged.project.name, local.project.name);
});

test('IndexedDB-only experience ID/project fields do not create a logical information conflict', () => {
  const local = emptyBundle();
  info(local);
  local.experiences[0].id = 'persisted-experience-row';
  local.experiences[0].projectId = 'project';
  const incoming = clone(local);
  delete incoming.experiences[0].id;
  delete incoming.experiences[0].projectId;
  const plan = planMerge(local, submission(incoming, 'p1'));
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.counts.duplicateProductInfos, 1);
});

test('all conflicts need choices, an actual resolver and an explicit reason', () => {
  const local = emptyBundle(); evaluation(local, { id: 'local' }); info(local, 'p1', 10);
  const incoming = emptyBundle(); evaluation(incoming, { id: 'incoming' }); info(incoming, 'p1', 20);
  const plan = planMerge(local, submission(incoming, 'p1'));
  assert.equal(plan.conflicts.length, 2);
  const decisions = Object.fromEntries(plan.conflicts.map(conflict => [conflict.id, 'incoming']));
  assert.throws(() => apply(plan, {}), /尚未选择/);
  assert.throws(() => apply(plan, decisions, '', '理由'), /处理人/);
  assert.throws(() => apply(plan, decisions, 'outsider', '理由'), /处理人/);
  assert.throws(() => apply(plan, decisions, 'm1', ' '), /填写原因/);
  assert.throws(() => apply(plan, decisions, 'm1', '理由', () => 'new', 'bad-date'), /时间无效/);
});

test('resolver-generated revision IDs cannot collide with active or received historical IDs', () => {
  const local = emptyBundle(); evaluation(local, { id: 'local-root' });
  const incoming = emptyBundle(); evaluation(incoming, { id: 'incoming-root' });
  const plan = planMerge(local, submission(incoming, 'p1'));
  const decisions = { [plan.conflicts[0].id]: 'incoming' };
  for (const id of ['', 'local-root', 'incoming-root']) assert.throws(() => apply(plan, decisions, 'm1', '理由', () => id), /ID/);
});

test('a new local workspace accepts a complete incoming bundle without rewriting IDs or project metadata', () => {
  const incoming = emptyBundle(); evaluation(incoming); info(incoming);
  const plan = planMerge(null, stage(incoming));
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.counts.newEvaluations, 1);
  assert.equal(plan.counts.newAssets, 1);
  assert.equal(plan.counts.newProductInfos, 1);
  assert.equal(plan.local, null);
  assert.deepEqual(apply(plan), incoming);
});

test('planning and materializing are pure; returned data cannot mutate inputs or the plan', () => {
  const local = emptyBundle();
  const incoming = emptyBundle(); evaluation(incoming); info(incoming);
  const packet = submission(incoming, 'p1');
  const localBefore = clone(local), packetBefore = clone(packet);
  const plan = planMerge(local, packet);
  const planBefore = clone(plan);
  const merged = apply(plan);
  merged.evaluations[0].notes = 'changed return';
  merged.project.products[0].totalCost = 999;
  assert.deepEqual(local, localBefore);
  assert.deepEqual(packet, packetBefore);
  assert.deepEqual(plan, planBefore);
});
