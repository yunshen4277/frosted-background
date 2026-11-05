(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FrostedRegions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const effects = Object.freeze({ blur: [14, 0, 60], opacity: [0.35, 0.05, 1], tintOpacity: [0.18, 0, 0.9], brightness: [1, 0.2, 2], saturation: [1, 0, 2] });
  const bounded = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  function normalizeRegions(value) {
    const result = { enabled: value?.enabled === true, items: [] };
    if (!value || typeof value !== 'object' || !Array.isArray(value.items)) return result;
    const ids = new Set();
    for (const [index, item] of value.items.slice(0, 8).entries()) {
      if (!item || typeof item !== 'object' || !Array.isArray(item.points)) continue;
      const input = item.points.slice(0, 64);
      if (input.length < 3 || input.some(point => !Array.isArray(point) || point.length !== 2 || point.some(coordinate => typeof coordinate !== 'number' || !Number.isFinite(coordinate)))) continue;
      const points = input.map(point => point.map(coordinate => Math.round(Math.max(0, Math.min(1, coordinate)) * 10000) / 10000));
      const area = points.reduce((sum, point, i) => { const next = points[(i + 1) % points.length]; return sum + point[0] * next[1] - next[0] * point[1]; }, 0);
      if (Math.abs(area) < 0.00000001) continue;
      let id = typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(item.id) ? item.id : `region-${index + 1}`;
      let suffix = 0;
      while (ids.has(id)) id = `region-${index + 1}-${++suffix}`;
      ids.add(id);
      const normalized = { id, name: typeof item.name === 'string' ? item.name.trim().slice(0, 40) : `Region ${index + 1}`, points };
      for (const [key, [fallback, min, max]] of Object.entries(effects)) normalized[key] = bounded(item[key], fallback, min, max);
      result.items.push(normalized);
    }
    return result;
  }

  function getImageBounds(sourceWidth, sourceHeight, width, height, fit = 'contain', position = 'center center') {
    if (!(sourceWidth > 0 && sourceHeight > 0 && width > 0 && height > 0)) return { x: 0, y: 0, width: 0, height: 0 };
    if (fit === 'fill') return { x: 0, y: 0, width, height };
    const scale = (fit === 'cover' ? Math.max : Math.min)(width / sourceWidth, height / sourceHeight);
    const drawnWidth = sourceWidth * scale, drawnHeight = sourceHeight * scale;
    const horizontal = position.startsWith('left ') ? 0 : position.startsWith('right ') ? 1 : 0.5;
    const vertical = position.endsWith(' top') ? 0 : position.endsWith(' bottom') ? 1 : 0.5;
    return { x: (width - drawnWidth) * horizontal, y: (height - drawnHeight) * vertical, width: drawnWidth, height: drawnHeight };
  }

  function createCompositor({ source, canvas }) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas compositing is unavailable.');
    const video = source.tagName === 'VIDEO';
    // Animated image formats (including GIF) use a still canvas frame in region
    // mode. Disabling regions restores the caller's native animated image path.
    const listeners = [];
    let options = {}, regions = normalizeRegions(), disposed = false;
    let frame, frameType, lastFrame = -Infinity;
    const cancelFrame = () => {
      if (frame !== undefined) {
        if (frameType === 'video') source.cancelVideoFrameCallback?.(frame);
        else cancelAnimationFrame(frame);
      }
      frame = undefined;
    };
    function draw() {
      if (disposed) return;
      const sourceWidth = video ? source.videoWidth : source.naturalWidth;
      const sourceHeight = video ? source.videoHeight : source.naturalHeight;
      if (!sourceWidth || !sourceHeight || (video && source.readyState < 2)) return;
      const width = options.width || canvas.clientWidth, height = options.height || canvas.clientHeight;
      if (!width || !height) return;
      const ratio = Math.min(globalThis.devicePixelRatio || 1, 1.5, Math.sqrt(1000000 / (width * height)));
      const pixelWidth = Math.max(1, Math.round(width * ratio)), pixelHeight = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      context.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
      const bounds = getImageBounds(sourceWidth, sourceHeight, width, height, options.fit, options.position);
      const tint = typeof options.tintColor === 'string' && options.tintColor ? options.tintColor : '#1e1e1e';
      const paint = effect => {
        context.globalAlpha = 1; context.filter = 'none'; context.fillStyle = tint;
        context.clearRect(0, 0, width, height);
        context.fillRect(0, 0, width, height);
        context.globalAlpha = bounded(effect.opacity, 0.35, 0.05, 1);
        context.filter = `blur(${bounded(effect.blur, 14, 0, 60) * ratio}px) brightness(${bounded(effect.brightness, 1, 0.2, 2)}) saturate(${bounded(effect.saturation, 1, 0, 2)})`;
        context.drawImage(source, bounds.x, bounds.y, bounds.width, bounds.height);
        context.filter = 'none'; context.globalAlpha = bounded(effect.tintOpacity, 0.18, 0, 0.9);
        context.fillStyle = tint; context.fillRect(0, 0, width, height);
        context.globalAlpha = 1;
      };
      paint(options);
      if (regions.enabled) for (const region of regions.items) {
        context.save(); context.beginPath();
        region.points.forEach(([x, y], index) => context[index ? 'lineTo' : 'moveTo'](bounds.x + x * bounds.width, bounds.y + y * bounds.height));
        context.closePath(); context.clip();
        // Replace the base inside the polygon before drawing its independent
        // effects. A clear region therefore does not inherit the base blur.
        paint(region);
        context.restore();
      }
    }
    function schedule() {
      if (disposed || !video || source.paused || source.ended || frame !== undefined) return;
      const callback = now => {
        frame = undefined;
        if (disposed || source.paused || source.ended) return;
        if (now - lastFrame >= 1000 / 30) { draw(); lastFrame = now; }
        schedule();
      };
      frameType = typeof source.requestVideoFrameCallback === 'function' ? 'video' : 'animation';
      frame = frameType === 'video' ? source.requestVideoFrameCallback(callback) : requestAnimationFrame(callback);
    }
    const changed = () => { cancelFrame(); draw(); schedule(); };
    for (const name of video ? ['loadeddata', 'seeked', 'play', 'pause', 'resize'] : ['load']) {
      source.addEventListener(name, changed); listeners.push(() => source.removeEventListener(name, changed));
    }
    const resize = new ResizeObserver(changed); resize.observe(canvas);
    return {
      update(value = {}) { if (!disposed) { options = { ...value }; regions = normalizeRegions(value.regions); changed(); } },
      draw,
      dispose() { if (disposed) return; disposed = true; cancelFrame(); resize.disconnect(); listeners.forEach(remove => remove()); },
    };
  }

  return Object.freeze({ normalizeRegions, getImageBounds, createCompositor });
});
