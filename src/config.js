'use strict';

const { normalizeRegions } = require('../media/regions');

const DEFAULTS = Object.freeze({
  blur: 14, opacity: 0.35, tintOpacity: 0.18, saturation: 1, brightness: 1,
  fit: 'cover', position: 'center center', playbackRate: 1,
  pauseWhenUnfocused: true, respectReducedMotion: true,
  regions: Object.freeze({ enabled: false, items: Object.freeze([]) })
});

function normalizeConfig(values = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) values = {};
  const result = { ...DEFAULTS };
  const ranges = { blur: [0, 60], opacity: [0.05, 1], tintOpacity: [0, 0.9], saturation: [0, 2], brightness: [0.2, 2], playbackRate: [0.25, 2] };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (typeof values[key] === 'number' && Number.isFinite(values[key])) result[key] = Math.min(max, Math.max(min, values[key]));
  }
  if (['cover', 'contain', 'fill'].includes(values.fit)) result.fit = values.fit;
  if (['center center', 'center top', 'center bottom', 'left center', 'right center'].includes(values.position)) result.position = values.position;
  for (const key of ['pauseWhenUnfocused', 'respectReducedMotion']) {
    if (typeof values[key] === 'boolean') result[key] = values[key];
  }
  result.regions = normalizeRegions(values.regions);
  return result;
}

module.exports = { DEFAULTS, normalizeConfig };
