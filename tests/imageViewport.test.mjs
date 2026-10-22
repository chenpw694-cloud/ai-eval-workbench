import test from 'node:test';
import assert from 'node:assert/strict';
import { fitView, constrainView, zoomView, wheelDeltaPixels } from '../src/core/imageViewport.ts';

const stage = { width: 800, height: 600 };
const image = { width: 1600, height: 1200 };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('fit contains landscape and portrait images without upscaling a small original', () => {
  assert.deepEqual(fitView(stage, image), { scale: 0.5, x: 0, y: 0 });
  assert.deepEqual(fitView(stage, { width: 1200, height: 2400 }), { scale: 0.25, x: 0, y: 0 });
  assert.deepEqual(fitView(stage, { width: 100, height: 200 }), { scale: 1, x: 0, y: 0 });
});

test('zoom preserves the original pixel under the pointer when no boundary is reached', () => {
  const current = { scale: 1, x: 50, y: -30 };
  const point = { x: 120, y: -80 };
  const next = zoomView(current, 2, point, stage, image);
  close((point.x - next.x) / next.scale, (point.x - current.x) / current.scale);
  close((point.y - next.y) / next.scale, (point.y - current.y) / current.scale);
  assert.deepEqual(next, { scale: 2, x: -20, y: 20 });
  const previous = zoomView(next, 1, point, stage, image);
  assert.deepEqual(previous, current);
});

test('zoom is anchored at the centre by default and never mutates the current view', () => {
  const current = { scale: 1, x: 40, y: -20 };
  const before = structuredClone(current);
  assert.deepEqual(zoomView(current, 1.5, { x: 0, y: 0 }, stage, image), { scale: 1.5, x: 60, y: -30 });
  assert.deepEqual(current, before);
});

test('panning stops exactly at all four image edges and centres axes that still fit', () => {
  assert.deepEqual(constrainView({ scale: 1, x: 9999, y: -9999 }, stage, image), { scale: 1, x: 400, y: -300 });
  assert.deepEqual(constrainView({ scale: 1, x: -9999, y: 9999 }, stage, image), { scale: 1, x: -400, y: 300 });
  assert.deepEqual(constrainView({ scale: 1, x: 100, y: 100 }, stage, { width: 1600, height: 200 }), { scale: 1, x: 100, y: 0 });
  assert.deepEqual(constrainView({ scale: 1, x: 100, y: 100 }, stage, { width: 200, height: 1200 }), { scale: 1, x: 0, y: 100 });
  assert.deepEqual(constrainView({ scale: 0.5, x: 100, y: 100 }, stage, image), { scale: 0.5, x: 0, y: 0 });
});

test('zooming out prioritizes visible image bounds over a pointer anchor outside the image', () => {
  assert.deepEqual(zoomView({ scale: 1, x: 400, y: 300 }, 0.5, { x: -400, y: -300 }, stage, image), { scale: 0.5, x: 0, y: 0 });
});

test('scale stays between the smaller of fit or 25 percent and 800 percent of the original', () => {
  assert.deepEqual(constrainView({ scale: 0.01, x: 1, y: 2 }, stage, image), { scale: 0.25, x: 0, y: 0 });
  assert.equal(constrainView({ scale: 100, x: 0, y: 0 }, stage, image).scale, 8);
  const large = { width: 16000, height: 12000 };
  assert.deepEqual(constrainView({ scale: 0.01, x: 1, y: 2 }, stage, large), { scale: 0.05, x: 0, y: 0 });
  assert.equal(zoomView(fitView(stage, large), 100, { x: 0, y: 0 }, stage, large).scale, 8);
  assert.deepEqual(zoomView({ scale: 1, x: 0, y: 0 }, 0.001, { x: 0, y: 0 }, stage, { width: 100, height: 100 }), { scale: 0.25, x: 0, y: 0 });
});

test('one-to-one scale preserves original dimensions, and fit resets all previous pan', () => {
  assert.deepEqual(zoomView(fitView(stage, image), 1, { x: 0, y: 0 }, stage, image), { scale: 1, x: 0, y: 0 });
  assert.deepEqual(fitView(stage, image), { scale: 0.5, x: 0, y: 0 });
});

test('wheel pixel, line and page units preserve direction and touchpad precision', () => {
  assert.equal(wheelDeltaPixels(-0.25, 0, 600), -0.25);
  assert.equal(wheelDeltaPixels(3, 1, 600), 48);
  assert.equal(wheelDeltaPixels(-1, 2, 600), -600);
  assert.equal(wheelDeltaPixels(0, 0, 600), 0);
});

test('invalid sizes, translations, pointers and scales cannot produce broken viewport values', () => {
  for (const invalid of [0, -1, NaN, Infinity, -Infinity]) {
    for (const key of ['width', 'height']) {
      assert.throws(() => fitView({ ...stage, [key]: invalid }, image), RangeError);
      assert.throws(() => fitView(stage, { ...image, [key]: invalid }), RangeError);
    }
    assert.throws(() => constrainView({ scale: invalid, x: 0, y: 0 }, stage, image), RangeError);
    assert.throws(() => zoomView(fitView(stage, image), invalid, { x: 0, y: 0 }, stage, image), RangeError);
    assert.throws(() => wheelDeltaPixels(1, 2, invalid), RangeError);
  }
  for (const invalid of [NaN, Infinity, -Infinity]) {
    for (const key of ['x', 'y']) {
      assert.throws(() => constrainView({ scale: 1, x: 0, y: 0, [key]: invalid }, stage, image), RangeError);
      assert.throws(() => zoomView(fitView(stage, image), 1, { x: 0, y: 0, [key]: invalid }, stage, image), RangeError);
    }
    assert.throws(() => wheelDeltaPixels(invalid, 0, 600), RangeError);
  }
  for (const mode of [-1, 0.5, 3, NaN, Infinity]) assert.throws(() => wheelDeltaPixels(1, mode, 600), RangeError);
  assert.throws(() => wheelDeltaPixels(Number.MAX_VALUE, 2, 600), RangeError);
});
