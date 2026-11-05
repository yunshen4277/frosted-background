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
      normalized.feather = bounded(item.feather, 0, 0, 0.3);
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
    let masks = [], maskKey = '', effectCanvas, effectContext;
    const newCanvas = (width, height) => {
      const result = canvas.ownerDocument.createElement('canvas');
      result.width = width; result.height = height;
      return result;
    };
    const clearMasks = () => {
      for (const mask of masks) mask.width = mask.height = 1;
      masks = []; maskKey = '';
    };
    function polygonPath(target, region, bounds, padding = 0) {
      target.beginPath();
      region.points.forEach(([x, y], index) => target[index ? 'lineTo' : 'moveTo'](bounds.x + x * bounds.width, bounds.y + y * bounds.height));
      target.closePath();
      if (!padding) return;
      // Continue boundary-aligned edges beyond the image before blurring the
      // mask. Full-image templates must not fade toward transparent black at
      // the canvas edges. These are path coordinates, not oversized buffers.
      region.points.forEach((point, i) => {
        const next = region.points[(i + 1) % region.points.length];
        const previous = region.points[(i + region.points.length - 1) % region.points.length];
        const x = bounds.x + point[0] * bounds.width, y = bounds.y + point[1] * bounds.height;
        if (point[0] === next[0] && (point[0] === 0 || point[0] === 1)) {
          target.rect(x - (point[0] === 0 ? padding : 0), bounds.y + Math.min(point[1], next[1]) * bounds.height, padding, Math.abs(point[1] - next[1]) * bounds.height);
        }
        if (point[1] === next[1] && (point[1] === 0 || point[1] === 1)) {
          target.rect(bounds.x + Math.min(point[0], next[0]) * bounds.width, y - (point[1] === 0 ? padding : 0), Math.abs(point[0] - next[0]) * bounds.width, padding);
        }
        if ((point[0] === 0 || point[0] === 1) && (point[1] === 0 || point[1] === 1) &&
            ((previous[0] === point[0] && next[1] === point[1]) || (previous[1] === point[1] && next[0] === point[0]))) {
          target.rect(x - (point[0] === 0 ? padding : 0), y - (point[1] === 0 ? padding : 0), padding, padding);
        }
      });
    }
    function masksFor(bounds, width, height, pixelWidth, pixelHeight) {
      const key = JSON.stringify([bounds, width, height, pixelWidth, pixelHeight, regions.items.map(region => [region.points, region.feather])]);
      if (key === maskKey) return masks;
      clearMasks();
      const scaleX = pixelWidth / width, scaleY = pixelHeight / height;
      const alpha = regions.items.map(region => {
        const mask = newCanvas(pixelWidth, pixelHeight);
        const target = mask.getContext('2d');
        target.setTransform(scaleX, 0, 0, scaleY, 0, 0);
        const featherWidth = Math.min(bounds.width, bounds.height) * region.feather;
        // Three standard deviations span the requested feather width on each
        // side. Farther inside, the independent region remains fully opaque.
        target.filter = featherWidth ? `blur(${featherWidth * Math.min(scaleX, scaleY) / 3}px)` : 'none';
        target.fillStyle = '#fff';
        polygonPath(target, region, bounds, featherWidth ? featherWidth + 2 : 0);
        target.fill();
        target.filter = 'none';
        target.globalCompositeOperation = 'destination-in';
        target.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
        target.globalCompositeOperation = 'source-over';
        masks.push(mask);
        const pixels = target.getImageData(0, 0, pixelWidth, pixelHeight).data;
        const values = new Uint8Array(pixelWidth * pixelHeight);
        for (let i = 0; i < values.length; i++) values[i] = pixels[i * 4 + 3];
        return values;
      });
      // Independent source-over masks leave a dark seam where adjacent halves
      // both have 50% coverage. Normalize their total coverage once, preserving
      // the later-region weights. No pixel readback happens on video frames or
      // effect-only edits, and a single mask retains its original soft alpha.
      for (let pixel = 0; pixel < pixelWidth * pixelHeight; pixel++) {
        let sum = 0, uncovered = 1;
        for (const values of alpha) { const a = values[pixel] / 255; sum += a; uncovered *= 1 - a; }
        const coverage = 1 - uncovered, wanted = Math.min(1, sum);
        if (!coverage || coverage >= 0.99999 || wanted <= coverage + 0.00001) continue;
        let after = 1, remaining = 1;
        for (let i = alpha.length - 1; i >= 0; i--) {
          const a = alpha[i][pixel] / 255;
          const weight = a * after * wanted / coverage;
          alpha[i][pixel] = remaining > 0.000001 ? Math.round(Math.min(1, weight / remaining) * 255) : 0;
          remaining -= weight; after *= 1 - a;
        }
      }
      const pixels = context.createImageData(pixelWidth, pixelHeight);
      for (let i = 0; i < pixels.data.length; i += 4) pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
      masks.forEach((mask, index) => {
        for (let i = 0; i < alpha[index].length; i++) pixels.data[i * 4 + 3] = alpha[index][i];
        mask.getContext('2d').putImageData(pixels, 0, 0);
      });
      maskKey = key;
      return masks;
    }
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
      const paint = (effect, target = context) => {
        target.globalAlpha = 1; target.filter = 'none'; target.fillStyle = tint;
        target.clearRect(0, 0, width, height);
        target.fillRect(0, 0, width, height);
        target.globalAlpha = bounded(effect.opacity, 0.35, 0.05, 1);
        target.filter = `blur(${bounded(effect.blur, 14, 0, 60) * ratio}px) brightness(${bounded(effect.brightness, 1, 0.2, 2)}) saturate(${bounded(effect.saturation, 1, 0, 2)})`;
        target.drawImage(source, bounds.x, bounds.y, bounds.width, bounds.height);
        target.filter = 'none'; target.globalAlpha = bounded(effect.tintOpacity, 0.18, 0, 0.9);
        target.fillStyle = tint; target.fillRect(0, 0, width, height);
        target.globalAlpha = 1;
      };
      paint(options);
      const feathered = regions.enabled && regions.items.some(region => region.feather > 0);
      if (feathered) {
        const currentMasks = masksFor(bounds, width, height, pixelWidth, pixelHeight);
        if (!effectCanvas) { effectCanvas = newCanvas(pixelWidth, pixelHeight); effectContext = effectCanvas.getContext('2d'); }
        if (effectCanvas.width !== pixelWidth) effectCanvas.width = pixelWidth;
        if (effectCanvas.height !== pixelHeight) effectCanvas.height = pixelHeight;
        regions.items.forEach((region, index) => {
          effectContext.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
          paint(region, effectContext);
          effectContext.setTransform(1, 0, 0, 1, 0, 0);
          effectContext.globalCompositeOperation = 'destination-in';
          effectContext.drawImage(currentMasks[index], 0, 0);
          effectContext.globalCompositeOperation = 'source-over';
          context.save(); context.setTransform(1, 0, 0, 1, 0, 0);
          context.drawImage(effectCanvas, 0, 0); context.restore();
        });
      } else if (regions.enabled) for (const region of regions.items) {
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
      update(value = {}) { if (!disposed) { options = { ...value }; regions = normalizeRegions(value.regions); if (!regions.enabled || !regions.items.some(region => region.feather > 0)) clearMasks(); changed(); } },
      draw,
      dispose() {
        if (disposed) return;
        disposed = true; cancelFrame(); resize.disconnect(); listeners.forEach(remove => remove()); clearMasks();
        if (effectCanvas) effectCanvas.width = effectCanvas.height = 1;
        effectCanvas = effectContext = undefined;
      },
    };
  }

  return Object.freeze({ normalizeRegions, getImageBounds, createCompositor });
});
