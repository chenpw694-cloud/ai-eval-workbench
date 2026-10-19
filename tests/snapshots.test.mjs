import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSnapshotHistory } from '../src/core/snapshots.ts';

const stamp = '2026-10-22T12:00:00.000Z';
const clone = value => structuredClone(value);
function snapshot(revision, schemeHash = `scheme-${revision}`, questionsHash = `questions-${revision}`) {
  return {
    id: 'project', name: `项目修订 ${revision}`, background: '', period: '', members: [], products: [], questions: [],
    scheme: { id: 'scheme', name: `规则 ${schemeHash}`, version: '1', dimensions: [], tags: [], policies: { failedNoOutput: 'unresolved', rankingTies: 'unresolved', zeroUsableCost: 'unresolved' } },
    rulesConfirmed: true, expectedQuestionCount: 2, status: 'active', revision,
    createdAt: stamp, updatedAt: stamp, schemeHash, questionsHash
  };
}
const pair = project => JSON.stringify([project.schemeHash, project.questionsHash]);

test('same revision with different hashes is remapped after local history rather than overwritten', () => {
  const local = [snapshot(1), snapshot(2)];
  const incoming = [snapshot(1, 'remote-rules', 'remote-questions'), snapshot(2)];
  const current = { ...snapshot(2), name: '本机当前项目' };
  const result = mergeSnapshotHistory(local, incoming, current, 'package-a');
  assert.equal(result.snapshots.length, 2);
  assert.equal(result.snapshots[0].revision, 3);
  assert.equal(result.snapshots[0].schemeHash, 'remote-rules');
  assert.deepEqual(result.snapshots[0].sourceSnapshot, { packageId: 'package-a', revision: 1 });
  assert.equal(result.project.revision, 4);
  assert.equal(result.project.name, '本机当前项目');
  assert.deepEqual(result.snapshots[1], result.project);
  assert.equal(local[0].schemeHash, 'scheme-1');
  assert.equal(local[1].revision, 2);
});

test('a new project preserves the entire incoming history and appends a higher current revision', () => {
  const incoming = [snapshot(4), snapshot(1), snapshot(3)];
  const current = snapshot(3);
  const result = mergeSnapshotHistory([], incoming, current, 'package-a');
  assert.deepEqual(result.snapshots.slice(0, 3), incoming);
  assert.equal(result.project.revision, 5);
  assert.deepEqual(result.snapshots.at(-1), result.project);
  assert.equal(result.snapshots.some(project => project.sourceSnapshot), false);
});

test('the supplied current revision contributes to the highest revision on first import', () => {
  const result = mergeSnapshotHistory([], [snapshot(1), snapshot(2)], snapshot(8), 'package-a');
  assert.equal(result.project.revision, 9);
});

test('existing local history never appears in the insertion list', () => {
  const local = [snapshot(1), snapshot(2), snapshot(7)];
  const result = mergeSnapshotHistory(local, [snapshot(3, 'new-rule', 'new-questions')], snapshot(7), 'package-a');
  assert.deepEqual(result.snapshots.map(project => project.revision), [8, 9]);
  assert.equal(result.project.revision, 9);
});

test('known hash pairs are skipped even with differing foreign revision numbers or mutable metadata', () => {
  const local = [snapshot(1, 'same-rule', 'same-questions')];
  const incoming = [snapshot(999, 'same-rule', 'same-questions')];
  incoming[0].background = '同规则下的外来信息';
  const result = mergeSnapshotHistory(local, incoming, snapshot(1, 'same-rule', 'same-questions'), 'package-a');
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.project.revision, 2);
  assert.equal(result.project.background, '');
});

test('repeated unseen pairs within an existing-project import are copied once', () => {
  const local = [snapshot(1)];
  const incoming = [snapshot(9, 'new-rule', 'new-questions'), snapshot(4, 'new-rule', 'new-questions')];
  const result = mergeSnapshotHistory(local, incoming, snapshot(1), 'package-a');
  assert.equal(result.snapshots.length, 2);
  assert.deepEqual(result.snapshots[0].sourceSnapshot, { packageId: 'package-a', revision: 4 });
  assert.equal(result.snapshots[0].revision, 2);
  assert.equal(result.project.revision, 3);
});

test('equal pairs on distinct revisions remain intact during a new-project import', () => {
  const incoming = [snapshot(1, 'rule', 'questions'), snapshot(2, 'rule', 'questions')];
  const result = mergeSnapshotHistory([], incoming, incoming[1], 'package-a');
  assert.equal(result.snapshots.length, 3);
  assert.deepEqual(result.snapshots.slice(0, 2), incoming);
  assert.equal(result.project.revision, 3);
});

test('pair identity includes both scheme and question hashes', () => {
  const local = [snapshot(1, 'rules', 'questions-1')];
  const incoming = [snapshot(1, 'rules', 'questions-2'), snapshot(2, 'rules-2', 'questions-1')];
  const result = mergeSnapshotHistory(local, incoming, local[0], 'package-a');
  assert.equal(result.snapshots.length, 3);
  assert.deepEqual(result.snapshots.map(project => project.revision), [2, 3, 4]);
});

test('subsequent export history contains every hash pair referenced by accepted historical evaluations', () => {
  const local = [snapshot(1, 'current-rules', 'current-questions')];
  const incoming = [snapshot(1, 'older-rules', 'older-questions'), snapshot(2, 'current-rules', 'current-questions')];
  const merged = mergeSnapshotHistory(local, incoming, local[0], 'package-a');
  const completeHistory = [...local, ...merged.snapshots];
  const exportPairs = new Set(completeHistory.map(pair));
  const evaluations = [
    { schemeHash: 'older-rules', questionsHash: 'older-questions' },
    { schemeHash: 'current-rules', questionsHash: 'current-questions' }
  ];
  assert.ok(evaluations.every(record => exportPairs.has(pair(record))));
  assert.equal(new Set(completeHistory.map(project => project.revision)).size, completeHistory.length);
  const replay = mergeSnapshotHistory(completeHistory, incoming, merged.project, 'package-a-again');
  assert.equal(replay.snapshots.length, 1);
  assert.ok(replay.project.revision > merged.project.revision);
});

test('empty incoming history still creates one new highest current snapshot', () => {
  const local = [snapshot(1), snapshot(3)];
  const result = mergeSnapshotHistory(local, [], snapshot(2), 'package-a');
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.project.revision, 4);
});

test('duplicate input revisions are rejected even when duplicate objects match', () => {
  const current = snapshot(1);
  assert.throws(() => mergeSnapshotHistory([snapshot(1), snapshot(1)], [], current, 'package-a'), /本机.*重复输入快照版本号/);
  assert.throws(() => mergeSnapshotHistory([], [snapshot(1), snapshot(1)], current, 'package-a'), /传入.*重复输入快照版本号/);
  assert.throws(() => mergeSnapshotHistory([snapshot(1)], [snapshot(2), snapshot(2, 'different', 'different')], current, 'package-a'), /传入.*重复输入快照版本号/);
});

test('local, incoming and current must describe the same project ID', () => {
  const current = snapshot(1);
  assert.throws(() => mergeSnapshotHistory([{ ...snapshot(1), id: 'other' }], [], current, 'package-a'), /本机项目 ID 不一致/);
  assert.throws(() => mergeSnapshotHistory([], [{ ...snapshot(1), id: 'other' }], current, 'package-a'), /传入项目 ID 不一致/);
  assert.throws(() => mergeSnapshotHistory([], [], { ...current, id: ' ' }, 'package-a'), /当前项目 ID 不可为空/);
});

test('invalid revisions, empty hashes and malformed source provenance are rejected', () => {
  const current = snapshot(1);
  for (const revision of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => mergeSnapshotHistory([], [snapshot(revision)], current, 'package-a'), /版本号必须为正整数/);
  assert.throws(() => mergeSnapshotHistory([], [snapshot(1, '', 'questions')], current, 'package-a'), /摘要为空/);
  assert.throws(() => mergeSnapshotHistory([], [], current, ' '), /数据包 ID/);
  for (const sourceSnapshot of [null, {}, { packageId: '', revision: 1 }, { packageId: 'source', revision: 0 }]) {
    assert.throws(() => mergeSnapshotHistory([], [{ ...snapshot(1), sourceSnapshot }], current, 'package-a'), /快照来源信息无效/);
  }
});

test('a recopied historical snapshot records its immediate source package and source revision', () => {
  const remote = { ...snapshot(9, 'remote-rules', 'remote-questions'), sourceSnapshot: { packageId: 'older-package', revision: 2 } };
  const result = mergeSnapshotHistory([snapshot(1)], [remote], snapshot(1), 'new-package');
  assert.deepEqual(result.snapshots[0].sourceSnapshot, { packageId: 'new-package', revision: 9 });
});

test('revision allocation rejects unsafe-integer overflow', () => {
  assert.throws(() => mergeSnapshotHistory([], [], snapshot(Number.MAX_SAFE_INTEGER), 'package-a'), /安全整数/);
  assert.throws(() => mergeSnapshotHistory([snapshot(Number.MAX_SAFE_INTEGER - 1)], [snapshot(1)], snapshot(Number.MAX_SAFE_INTEGER - 1), 'package-a'), /安全整数/);
});

test('inputs remain unchanged and returned nested structures do not alias source objects', () => {
  const local = [snapshot(1)], incoming = [snapshot(1, 'remote', 'remote-questions')], current = snapshot(1);
  const before = clone({ local, incoming, current });
  const result = mergeSnapshotHistory(local, incoming, current, 'package-a');
  result.snapshots[0].scheme.name = 'mutated return';
  result.project.name = 'mutated current';
  assert.deepEqual({ local, incoming, current }, before);
  assert.equal(result.snapshots.at(-1).name, current.name);
});
