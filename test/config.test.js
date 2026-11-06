'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig, DEFAULTS } = require('../src/config');

test('manual pause is persistent and only accepts a boolean', () => {
  assert.equal(DEFAULTS.paused, false);
  assert.equal(normalizeConfig({ paused: true }).paused, true);
  assert.equal(normalizeConfig({ paused: 'true' }).paused, false);
  assert.equal(require('../package.json').contributes.configuration.properties['frostedBackground.paused'].scope, 'application');
});

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

test('retired regions and remote source settings are ignored during migration', () => {
  const config = normalizeConfig({ blur: 7, regions: { enabled: true, items: [{ id: 'old', points: [[0, 0], [1, 0], [0, 1]], blur: 0 }] }, sourceType: 'hls', source: 'https://example.invalid/video.m3u8' });
  assert.deepEqual(config, { ...DEFAULTS, blur: 7 });
  assert.equal(Object.hasOwn(config, 'regions'), false);
  assert.equal(Object.hasOwn(config, 'source'), false);
  assert.equal(Object.hasOwn(config, 'sourceType'), false);
  assert.deepEqual(normalizeConfig(null), DEFAULTS);
  assert.deepEqual(normalizeConfig({ get regions() { throw new Error('Retired fields must not be read'); } }), DEFAULTS);
});
