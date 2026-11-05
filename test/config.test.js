'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig, DEFAULTS } = require('../src/config');

test('configuration constrains visual values and never accepts executable CSS values', () => {
  const config = normalizeConfig({ blur: Infinity, opacity: -2, tintOpacity: 10, brightness: NaN, saturation: 3,
    fit: 'url(https://example.com)', position: 'center; color:red', playbackRate: 0, pauseWhenUnfocused: 'false',
    respectReducedMotion: false, source: 'https://example.com/video' });
  assert.deepEqual(config, { ...DEFAULTS, opacity: 0.05, tintOpacity: 0.9, saturation: 2, playbackRate: 0.25, respectReducedMotion: false });
  assert.equal(config.source, undefined);
});

test('zero blur and tint are preserved, supported fit and alignment are retained', () => {
  const config = normalizeConfig({ blur: 0, tintOpacity: 0, fit: 'contain', position: 'center top', pauseWhenUnfocused: false });
  assert.equal(config.blur, 0);
  assert.equal(config.tintOpacity, 0);
  assert.equal(config.fit, 'contain');
  assert.equal(config.position, 'center top');
  assert.equal(config.pauseWhenUnfocused, false);
  assert.equal(DEFAULTS.blur, 14);
});

test('all three fit modes are accepted and stretch preserves the other visual settings', () => {
  for (const fit of ['cover', 'contain', 'fill']) {
    assert.deepEqual(normalizeConfig({ ...DEFAULTS, fit, blur: 23, position: 'right center' }), {
      ...DEFAULTS, fit, blur: 23, position: 'right center',
    });
  }
  assert.equal(normalizeConfig().fit, 'cover');
  assert.equal(normalizeConfig({ fit: 'stretch' }).fit, 'cover');
  const manifest = require('../package.json');
  assert.deepEqual(manifest.contributes.configuration.properties['frostedBackground.fit'].enum, ['cover', 'contain', 'fill']);
});

test('region settings survive normalization while unknown nested fields and invalid geometry are removed', () => {
  const values = { enabled: true, items: [
    { id: 'sharp-area', name: 'Sharp <area>', points: [[0.1, 0.2], [0.9, 0.2], [0.9, 0.8], [0.1, 0.8]], blur: 0, opacity: 1, tintOpacity: 0,
      brightness: 1.2, saturation: 0.5, source: 'https://example.test/private', css: 'url(evil)' },
    { points: [[0, 0], [NaN, 1], [1, 1]], blur: 50 },
    { points: [[0, 0], [0.5, 0.5], [1, 1]] }
  ] };
  const normalized = normalizeConfig({ regions: values });
  assert.equal(normalized.regions.enabled, true);
  assert.equal(normalized.regions.items.length, 1);
  assert.deepEqual(normalized.regions.items[0], {
    id: 'sharp-area', name: 'Sharp <area>', points: values.items[0].points,
    blur: 0, opacity: 1, tintOpacity: 0, brightness: 1.2, saturation: 0.5
  });
  assert.notEqual(normalized.regions.items[0].points, values.items[0].points);
  assert.deepEqual(normalizeConfig(null), DEFAULTS);
  assert.deepEqual(normalizeConfig().regions, { enabled: false, items: [] });
});

test('region state stays bounded and disabling preserves shapes for later use', () => {
  const polygon = Array.from({ length: 90 }, (_, i) => [0.5 + Math.cos(i * Math.PI * 2 / 90) / 2, 0.5 + Math.sin(i * Math.PI * 2 / 90) / 2]);
  const items = Array.from({ length: 20 }, () => ({ id: 'duplicate', name: 'a'.repeat(100), points: polygon, blur: 999, brightness: -1 }));
  const result = normalizeConfig({ regions: { enabled: false, items } }).regions;
  assert.equal(result.items.length, 8);
  assert.equal(result.enabled, false);
  assert.equal(new Set(result.items.map(item => item.id)).size, 8);
  assert.ok(result.items.every(item => item.points.length <= 64 && item.name.length <= 40 && item.blur === 60 && item.brightness === 0.2));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64000);
  result.items[0].points[0][0] = 0;
  assert.equal(items[0].points[0][0], 1, 'normalization never mutates the supplied geometry');
});
