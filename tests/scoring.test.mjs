import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dimensionScore, gsbNetWin, requiresFullReview } from '../src/core/scoring.ts';

test('unsubmitted blank dimensions stay missing', () => assert.equal(dimensionScore([], false), null));
test('submitted dimensions without issues receive 5', () => assert.equal(dimensionScore([], true), 5));
test('the most severe tag wins within a dimension', () => {
  assert.equal(dimensionScore(['P3', 'P1', 'P2'], true), 2);
  assert.equal(dimensionScore(['P0', 'P3'], true), 1);
});
test('tagged drafts are not included as submitted scores', () => assert.equal(dimensionScore(['P0'], false), null));
test('an empty GSB set has no result', () => assert.equal(gsbNetWin([]), null));
test('ties belong in the GSB denominator', () => assert.equal(gsbNetWin(['G', 'G', 'S', 'B']), .25));
test('GSB handles all ties and all losses', () => { assert.equal(gsbNetWin(['S', 'S']), 0); assert.equal(gsbNetWin(['B']), -1); });
test('3 of 10 disagreements do not trigger a full review', () => assert.equal(requiresFullReview(3, 10), false));
test('4 of 10 disagreements trigger a full review', () => assert.equal(requiresFullReview(4, 10), true));
test('an incomplete review set cannot trigger a completed-set decision', () => assert.equal(requiresFullReview(4, 9), false));
