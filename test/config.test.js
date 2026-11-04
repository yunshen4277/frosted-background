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
