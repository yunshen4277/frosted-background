'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRegions, getImageBounds } = require('../media/regions');
const triangle = [[0, 0], [1, 0], [0, 1]];

test('region normalization bounds polygons and independent effects without mutating input', () => {
  const input = { enabled: true, unsafe: 'drop', items: [{ id: '<bad>', name: 'x'.repeat(80), points: [[-1, 0], [1.5, 0], [0.123456, 1]], blur: 90, opacity: 0, tintOpacity: 2, brightness: 0, saturation: 3, unsafe: true }] };
  const output = normalizeRegions(input);
  assert.deepEqual(output, { enabled: true, items: [{ id: 'region-1', name: 'x'.repeat(40), points: [[0, 0], [1, 0], [0.1235, 1]], blur: 60, opacity: 0.05, tintOpacity: 0.9, brightness: 0.2, saturation: 2, feather: 0 }] });
  assert.equal(input.items[0].blur, 90);
  assert.deepEqual(input.items[0].points[0], [-1, 0]);
  assert.deepEqual(normalizeRegions(), { enabled: false, items: [] });
  assert.deepEqual(normalizeRegions({ enabled: 'true', items: [] }), { enabled: false, items: [] });
});

test('legacy regions keep hard edges and feather is bounded independently of image blur', () => {
  const items = [undefined, -1, 0, 0.06, 0.9, '0.1', NaN].map((feather, i) => ({ id: `r${i}`, points: triangle, feather, blur: 0 }));
  const result = normalizeRegions({ enabled: true, items });
  assert.deepEqual(result.items.map(item => item.feather), [0, 0, 0, 0.06, 0.3, 0, 0]);
  assert.ok(result.items.every(item => item.blur === 0));
});

test('invalid or degenerate region polygons are dropped and duplicate IDs remain unique', () => {
  const invalid = [null, {}, { points: [[0, 0], [1, 1]] }, { points: [[0, 0], [0.5, 0.5], [1, 1]] },
    { points: [[0, 0], ['1', 0], [0, 1]] }, { points: [[0, 0], [NaN, 0], [0, 1]] }];
  assert.deepEqual(normalizeRegions({ enabled: true, items: invalid }), { enabled: true, items: [] });
  const values = normalizeRegions({ enabled: true, items: [{ id: 'region-2-1', points: triangle }, { id: 'region-2-1', points: triangle }, { id: 'region-2-1', points: triangle }] });
  assert.equal(new Set(values.items.map(item => item.id)).size, 3);
  assert.equal(values.items[0].blur, 14);
  assert.equal(values.items[0].opacity, 0.35);
  assert.equal(values.items[0].tintOpacity, 0.18);
  assert.equal(values.items[0].brightness, 1);
  assert.equal(values.items[0].saturation, 1);
});

test('region limits cap work to eight polygons with sixty-four source points each', () => {
  const circle = Array.from({ length: 90 }, (_, i) => [0.5 + Math.cos(i * 2 * Math.PI / 90) * 0.4, 0.5 + Math.sin(i * 2 * Math.PI / 90) * 0.4]);
  const output = normalizeRegions({ enabled: true, items: Array.from({ length: 100 }, (_, i) => ({ id: String(i), points: circle })) });
  assert.equal(output.items.length, 8);
  assert.ok(output.items.every(item => item.points.length === 64));
});

test('source-coordinate mapping matches cover, contain, stretch and aligned positions', () => {
  assert.deepEqual(getImageBounds(400, 200, 200, 200, 'contain'), { x: 0, y: 50, width: 200, height: 100 });
  assert.deepEqual(getImageBounds(400, 200, 200, 200, 'cover'), { x: -100, y: 0, width: 400, height: 200 });
  assert.deepEqual(getImageBounds(400, 200, 200, 200, 'cover', 'right center'), { x: -200, y: 0, width: 400, height: 200 });
  assert.deepEqual(getImageBounds(400, 200, 200, 200, 'contain', 'center bottom'), { x: 0, y: 100, width: 200, height: 100 });
  assert.deepEqual(getImageBounds(400, 200, 200, 200, 'fill'), { x: 0, y: 0, width: 200, height: 200 });
  assert.deepEqual(getImageBounds(0, 200, 200, 200), { x: 0, y: 0, width: 0, height: 0 });
});
