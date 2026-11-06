(() => {
  'use strict';

  const vscode = acquireVsCodeApi();
  const { normalizeLanguage, t } = window.FrostedI18n;
  const regionApi = window.FrostedRegions;
  const sourceApi = window.FrostedSource;
  const normalizeRegions = value => regionApi ? regionApi.normalizeRegions(value) : { enabled: false, items: [] };
  const clone = value => JSON.parse(JSON.stringify(value));
  let language = normalizeLanguage(document.documentElement.lang);
  const translate = (key, params) => t(language, key, params);
  const fallback = {
    blur: 14, opacity: 0.35, tintOpacity: 0.18, saturation: 1, brightness: 1,
    fit: 'cover', position: 'center center', playbackRate: 1,
    pauseWhenUnfocused: true, respectReducedMotion: true, paused: false,
    regions: { enabled: false, items: [] },
  };
  const ranges = { blur: [0, 60], opacity: [0.05, 1], tintOpacity: [0, 0.9], brightness: [0.2, 2], saturation: [0, 2], playbackRate: [0.25, 2] };
  const presets = {
    soft: { blur: 18, opacity: 0.35, tintOpacity: 0.18, brightness: 1, saturation: 0.9 },
    clear: { blur: 5, opacity: 0.45, tintOpacity: 0.1, brightness: 1, saturation: 1 },
    focus: { blur: 28, opacity: 0.22, tintOpacity: 0.35, brightness: 0.8, saturation: 0.7 },
  };
  const byId = id => document.getElementById(id);
  const normalize = values => {
    const result = { ...fallback, regions: normalizeRegions(values?.regions) };
    if (!values || typeof values !== 'object') return result;
    for (const [key, [min, max]] of Object.entries(ranges)) {
      if (typeof values[key] === 'number' && Number.isFinite(values[key])) result[key] = Math.min(max, Math.max(min, values[key]));
    }
    if (['cover', 'contain', 'fill'].includes(values.fit)) result.fit = values.fit;
    if (['center center', 'center top', 'center bottom', 'left center', 'right center'].includes(values.position)) result.position = values.position;
    for (const key of ['pauseWhenUnfocused', 'respectReducedMotion', 'paused']) if (typeof values[key] === 'boolean') result[key] = values[key];
    return result;
  };
  const saved = vscode.getState() || {};
  let draft = normalize(saved.draft);
  let defaults = { ...fallback };
  let applied = { ...fallback };
  let dirty = Boolean(saved.dirty && saved.draft);
  let state = { config: applied, enabled: false, media: null, busy: true, error: null, notice: null, needsReload: false, update: null, liveEnabled: false, liveApplying: false };
  let editRevision = 0;
  let requestSequence = Number.isSafeInteger(saved.liveRequestId) && saved.liveRequestId > 0 ? saved.liveRequestId : 0;
  let lastLiveAck = 0;
  let liveRequest = null;
  let queuedRevision = null;
  let debounceTimer = null;
  let debounceReady = false;
  let currentMedia = null;
  let mediaIdentity = '';
  let videoReady = false;
  let previewErrorKey = null;
  let mediaFailed = false;
  let previewLoading = false;
  let previewLoadingKey = '正在加载直播…';
  let webmFallback = null;
  let hlsPlayer = null;
  let nativeHls = false;
  let sourceErrorKey = null;
  let loadingUrl = false;
  let submittedUrl = '';
  let compositor = null;
  let regionEditing = false;
  let regionEffectsVisible = true;
  let selectedRegionId = '';
  let drawingTool = 'select';
  let drawing = null;
  let regionDrag = null;
  let drawingErrorKey = null;
  let activePointer = null;
  let activeTemplate = '';
  let templateSignature = '';
  let keyboardCursor = [0.5, 0.5];
  let showKeyboardCursor = false;
  const regionKeys = ['blur', 'opacity', 'tintOpacity', 'brightness', 'saturation'];
  const regionPropertyKeys = [...regionKeys, 'feather'];
  const regionRanges = { ...ranges, feather: [0, 0.3] };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function persistDraft() {
    dirty = JSON.stringify(draft) !== JSON.stringify(applied);
    vscode.setState({ draft: clone(draft), dirty, liveRequestId: requestSequence });
  }

  function formatValue(key, value) {
    if (key === 'blur') return `${Math.round(value)} px`;
    if (key === 'playbackRate') return `${Number(value.toFixed(2))}×`;
    return `${Math.round(value * 100)}%`;
  }

  function renderLanguage() {
    document.documentElement.lang = language;
    byId('language').value = language;
    for (const element of document.querySelectorAll('[data-i18n]')) {
      element.textContent = translate(element.dataset.i18n);
    }
    for (const attribute of ['aria-label', 'title']) {
      for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
        element.setAttribute(attribute, translate(element.getAttribute(`data-i18n-${attribute}`)));
      }
    }
    if (previewErrorKey) byId('preview-error').textContent = translate(previewErrorKey);
    byId('preview-loading').textContent = translate(previewLoadingKey);
    // Only text changes. The current image/video element, time, and draft stay
    // intact; updateMedia has an identity guard for authoritative host echoes.
    updateMedia();
    renderControls();
  }

  function renderControls() {
    if (!draft.regions.enabled) { regionEditing = false; cancelGesture(false); }
    for (const [key, [min, max]] of Object.entries(ranges)) {
      const input = byId(key);
      input.value = String(draft[key]);
      input.style.setProperty('--range-fill', `${(draft[key] - min) / (max - min) * 100}%`);
      input.setAttribute('aria-valuetext', formatValue(key, draft[key]));
      byId(`${key}-value`).textContent = formatValue(key, draft[key]);
    }
    for (const input of document.querySelectorAll('input[name="fit"]')) input.checked = input.value === draft.fit;
    byId('fit-description').textContent = translate({
      cover: '等比铺满，允许裁剪边缘',
      contain: '完整显示画面，可能留白',
      fill: '完整画面压缩到编辑区，不裁剪；可能改变比例',
    }[draft.fit]);
    byId('position').value = draft.position;
    for (const key of ['pauseWhenUnfocused', 'respectReducedMotion']) byId(key).checked = draft[key];
    for (const button of document.querySelectorAll('[data-preset]')) {
      const active = Object.entries(presets[button.dataset.preset]).every(([key, value]) => Math.abs(draft[key] - value) < 0.001);
      button.setAttribute('aria-pressed', String(active));
    }
    renderPreview();
    renderRegionControls();
    renderActions();
  }

  function selectedRegion() { return draft.regions.items.find(region => region.id === selectedRegionId); }

  function regionBounds() {
    const width = currentMedia?.videoWidth || currentMedia?.naturalWidth || 0;
    const height = currentMedia?.videoHeight || currentMedia?.naturalHeight || 0;
    return regionApi?.getImageBounds(width, height, byId('preview').clientWidth, byId('preview').clientHeight, 'contain', 'center center')
      || { x: 0, y: 0, width: 0, height: 0 };
  }

  function renderRegionControls() {
    if (!selectedRegion()) selectedRegionId = draft.regions.items[0]?.id || '';
    const selected = selectedRegion();
    byId('regions-enabled').checked = draft.regions.enabled;
    byId('region-count').textContent = `${draft.regions.items.length} / 8`;
    if (JSON.stringify(draft.regions) !== templateSignature) activeTemplate = '';
    byId('region-template').value = activeTemplate;
    const select = byId('region-select');
    const signature = JSON.stringify(draft.regions.items.map(region => [region.id, region.name]));
    if (select.dataset.signature !== signature) {
      select.replaceChildren(...draft.regions.items.map((region, index) => {
        const option = document.createElement('option');
        option.value = region.id;
        option.textContent = region.name || translate('区域 {number}', { number: index + 1 });
        return option;
      }));
      select.dataset.signature = signature;
    }
    select.value = selectedRegionId;
    byId('region-properties').hidden = !selected;
    byId('region-empty').hidden = Boolean(selected);
    byId('region-limit').hidden = draft.regions.items.length < 8;
    byId('region-edit').textContent = translate(regionEditing ? '完成编辑' : '编辑选区');
    byId('region-edit').setAttribute('aria-pressed', String(regionEditing));
    byId('region-drawing-tools').hidden = !regionEditing;
    byId('region-show-effects').checked = regionEffectsVisible;
    byId('region-drawing-error').hidden = !drawingErrorKey;
    byId('region-drawing-error').textContent = drawingErrorKey ? translate(drawingErrorKey) : '';
    byId('region-drawing-help').textContent = translate({
      select: '拖动选区可移动位置。方向键切换区域，Delete删除。',
      rect: '拖动绘制矩形。方向键移动，空格选角，Enter完成。',
      lasso: '按住拖动套索，松开闭合。Esc取消。',
      polygon: '逐点点击，双击或Enter闭合；Backspace撤点，Esc取消。',
    }[drawingTool]);
    for (const button of document.querySelectorAll('[data-region-tool]')) button.setAttribute('aria-pressed', String(button.dataset.regionTool === drawingTool));
    if (selected) {
      if (document.activeElement !== byId('region-name')) byId('region-name').value = selected.name;
      for (const key of regionPropertyKeys) {
        const [min, max] = regionRanges[key];
        const input = byId(`region-${key}`);
        input.value = String(selected[key]);
        input.style.setProperty('--range-fill', `${(selected[key] - min) / (max - min) * 100}%`);
        input.setAttribute('aria-valuetext', formatValue(key, selected[key]));
        byId(`region-${key}-value`).textContent = formatValue(key, selected[key]);
      }
    }
    renderRegionOverlay();
  }

  function renderRegionAvailability() {
    const unavailable = state.busy || !state.media || !regionApi;
    byId('regions-enabled').disabled = unavailable;
    for (const id of ['region-template', 'region-edit']) byId(id).disabled = unavailable;
    byId('region-clear').disabled = unavailable || !draft.regions.items.length;
    for (const element of byId('region-properties').querySelectorAll('button, input, select')) element.disabled = unavailable || !draft.regions.enabled || !selectedRegion();
    for (const button of document.querySelectorAll('[data-region-tool]')) button.disabled = unavailable || (button.dataset.regionTool !== 'select' && draft.regions.items.length >= 8);
    byId('region-show-effects').disabled = unavailable;
    byId('region-finish').disabled = unavailable || !drawing || drawing.points.length < (drawing.kind === 'rect' ? 2 : 3);
    byId('region-cancel').disabled = unavailable || (!drawing && !regionDrag);
    byId('region-done').disabled = Boolean(state.busy);
    byId('region-overlay').setAttribute('aria-disabled', String(Boolean(unavailable)));
  }

  function rectanglePoints(start, end) {
    const [left, right] = [Math.min(start[0], end[0]), Math.max(start[0], end[0])];
    const [top, bottom] = [Math.min(start[1], end[1]), Math.max(start[1], end[1])];
    return [[left, top], [right, top], [right, bottom], [left, bottom]];
  }

  function renderRegionOverlay() {
    const overlay = byId('region-overlay');
    overlay.toggleAttribute('hidden', !regionEditing);
    overlay.dataset.tool = drawingTool;
    overlay.classList.toggle('is-dragging', Boolean(regionDrag));
    if (!regionEditing) return;
    const bounds = regionBounds();
    overlay.setAttribute('viewBox', `0 0 ${byId('preview').clientWidth} ${byId('preview').clientHeight}`);
    const svg = (tag, attributes) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      return node;
    };
    const pointsText = points => points.map(([x, y]) => `${bounds.x + x * bounds.width},${bounds.y + y * bounds.height}`).join(' ');
    const children = [svg('rect', { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, class: 'source-outline' })];
    for (const region of draft.regions.items) {
      const points = regionDrag?.id === region.id ? regionDrag.currentPoints : region.points;
      const polygon = svg('polygon', { points: pointsText(points), 'data-region-id': region.id, class: region.id === selectedRegionId ? 'is-selected' : '' });
      const title = svg('title', {}); title.textContent = region.name; polygon.append(title);
      children.push(polygon);
    }
    if (drawing) {
      const points = drawing.kind === 'rect' ? rectanglePoints(drawing.points[0], drawing.points.at(-1)) : drawing.points.concat(drawing.hover ? [drawing.hover] : []);
      children.push(svg('polyline', { points: pointsText(drawing.kind === 'rect' ? [...points, points[0]] : points), class: 'drawing-shape' }));
      if (drawing.kind === 'polygon') for (const point of drawing.points) children.push(svg('circle', { cx: bounds.x + point[0] * bounds.width, cy: bounds.y + point[1] * bounds.height, r: 2.5, class: 'drawing-vertex' }));
      const cursor = drawing.hover || drawing.points.at(-1);
      if (cursor) children.push(svg('circle', { cx: bounds.x + cursor[0] * bounds.width, cy: bounds.y + cursor[1] * bounds.height, r: 3, class: 'drawing-cursor' }));
    }
    if (showKeyboardCursor) {
      const x = bounds.x + keyboardCursor[0] * bounds.width, y = bounds.y + keyboardCursor[1] * bounds.height;
      children.push(svg('path', { d: `M${x - 5} ${y}h10M${x} ${y - 5}v10`, class: 'keyboard-cursor' }));
    }
    overlay.replaceChildren(...children);
    renderRegionAvailability();
  }

  function updateRegion(id, values) {
    if (!draft.regions.items.some(region => region.id === id)) return;
    draft.regions = normalizeRegions({ ...draft.regions, items: draft.regions.items.map(region => region.id === id ? { ...region, ...values } : region) });
    changed();
  }
  function updateSelectedRegion(values) { updateRegion(selectedRegionId, values); }

  function addRegion(points, name) {
    if (draft.regions.items.length >= 8) return false;
    const id = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const effects = Object.fromEntries(regionKeys.map(key => [key, draft[key]]));
    const next = normalizeRegions({ enabled: true, items: [...draft.regions.items, { id, name: name || translate('区域 {number}', { number: draft.regions.items.length + 1 }), points, ...effects, feather: 0.06 }] });
    if (next.items.length === draft.regions.items.length) return false;
    draft.regions = next;
    selectedRegionId = id;
    changed();
    return true;
  }

  function setRegionEditing(value) {
    regionEditing = Boolean(value && state.media && regionApi);
    cancelGesture(false); drawingErrorKey = null;
    if (regionEditing && !draft.regions.enabled) { draft.regions = { ...draft.regions, enabled: true }; changed(); }
    else renderControls();
    if (regionEditing) byId('preview').scrollIntoView({ block: 'start' });
  }

  function useRegionTemplate() {
    const rect = (name, left, top, right, bottom, clear = false) => ({
      id: `template-${name}`, name: translate(name), points: rectanglePoints([left, top], [right, bottom]),
      ...Object.fromEntries(regionKeys.map(key => [key, draft[key]])),
      feather: 0.06,
      ...(clear ? { blur: 0, opacity: 1, tintOpacity: 0 } : { blur: Math.max(14, draft.blur) }),
    });
    const templates = {
      vertical: () => [rect('左侧', 0, 0, 0.5, 1, true), rect('右侧', 0.5, 0, 1, 1)],
      horizontal: () => [rect('上方', 0, 0, 1, 0.5, true), rect('下方', 0, 0.5, 1, 1)],
      columns: () => [rect('左侧', 0, 0, 1 / 3, 1), rect('中央', 1 / 3, 0, 2 / 3, 1, true), rect('右侧', 2 / 3, 0, 1, 1)],
      grid: () => [rect('左上', 0, 0, 0.5, 0.5, true), rect('右上', 0.5, 0, 1, 0.5), rect('左下', 0, 0.5, 0.5, 1), rect('右下', 0.5, 0.5, 1, 1, true)],
      center: () => [rect('中央', 0.25, 0.2, 0.75, 0.8, true)],
    };
    const selectedTemplate = byId('region-template').value;
    const create = templates[selectedTemplate];
    if (!create) return;
    const items = create().map((region, index) => ({ ...region, id: `template-${index + 1}` }));
    draft.regions = normalizeRegions({ enabled: true, items });
    activeTemplate = selectedTemplate;
    templateSignature = JSON.stringify(draft.regions);
    selectedRegionId = draft.regions.items[0]?.id || '';
    cancelGesture(false); drawingErrorKey = null;
    drawingTool = 'select';
    regionEditing = true;
    changed();
    byId('preview').scrollIntoView({ block: 'nearest' });
  }

  function syncPlayback() {
    if (!currentMedia || currentMedia.tagName !== 'VIDEO') return;
    if (mediaFailed) { currentMedia.pause(); return; }
    const shouldPause = draft.paused || document.hidden || (draft.respectReducedMotion && reducedMotion.matches)
      || (draft.pauseWhenUnfocused && !document.hasFocus());
    if (shouldPause) {
      currentMedia.pause();
      // Metadata alone can leave a blank video surface. Seek once so a still
      // frame is decoded even when reduced-motion or focus rules pause playback.
      if (state.media?.type !== 'hls' && videoReady && currentMedia.currentTime === 0 && Number.isFinite(currentMedia.duration)) {
        try { currentMedia.currentTime = Math.min(0.05, currentMedia.duration / 2); } catch { /* Unsupported codec: media error handler supplies a useful message. */ }
      }
    } else {
      const promise = currentMedia.play();
      if (promise && typeof promise.catch === 'function') promise.catch(() => { /* Muted preview may be paused by browser policy; controls remain usable. */ });
    }
  }

  function renderPreview() {
    byId('preview-loading').textContent = translate(previewLoadingKey);
    byId('preview-loading').hidden = !previewLoading || mediaFailed;
    byId('preview').style.backgroundColor = 'var(--vscode-editor-background, #111923)';
    byId('preview').classList.toggle('is-region-editing', regionEditing);
    byId('preview').classList.toggle('show-region-effects', regionEffectsVisible);
    const mediaReady = currentMedia && !mediaFailed && (currentMedia.tagName === 'VIDEO' ? currentMedia.readyState >= 2 : currentMedia.complete && currentMedia.naturalWidth > 0);
    const useCanvas = Boolean(mediaReady && regionApi && draft.regions.enabled && draft.regions.items.length && (!regionEditing || regionEffectsVisible));
    byId('region-canvas').hidden = !useCanvas;
    document.querySelector('.preview-tint').style.opacity = String(useCanvas || regionEditing ? 0 : draft.tintOpacity);
    if (!useCanvas && compositor) { compositor.dispose(); compositor = null; }
    if (currentMedia) {
      currentMedia.style.objectFit = regionEditing ? 'contain' : draft.fit;
      currentMedia.style.objectPosition = regionEditing ? 'center center' : draft.position;
      currentMedia.style.opacity = String(useCanvas ? 0 : regionEditing ? 1 : draft.opacity);
      // Preview pixels are scaled down to represent the editor's visual texture.
      currentMedia.style.filter = regionEditing ? 'none' : `blur(${draft.blur * 0.34}px) brightness(${draft.brightness}) saturate(${draft.saturation})`;
      currentMedia.style.transform = !regionEditing && !useCanvas && draft.fit === 'cover' ? 'scale(1.08)' : 'none';
      if (currentMedia.tagName === 'VIDEO') currentMedia.playbackRate = draft.playbackRate;
      if (useCanvas) {
        compositor ||= regionApi.createCompositor({ source: currentMedia, canvas: byId('region-canvas') });
        compositor.update({
          ...draft, blur: draft.blur * 0.34,
          fit: regionEditing ? 'contain' : draft.fit, position: regionEditing ? 'center center' : draft.position,
          regions: { ...draft.regions, items: draft.regions.items.map(region => ({ ...region, blur: region.blur * 0.34, points: regionDrag?.id === region.id ? regionDrag.currentPoints : region.points })) },
          tintColor: getComputedStyle(byId('preview')).backgroundColor,
        });
      }
    }
    renderRegionOverlay();
    syncPlayback();
  }

  function updateMedia() {
    const media = state.media;
    const valid = media && typeof media.uri === 'string' && ['image', 'video'].includes(media.kind);
    const identity = valid ? `${media.kind}:${media.type || 'file'}:${media.uri}` : '';
    byId('media-kind').textContent = translate(valid ? (media.type === 'hls' ? 'HLS直播' : media.kind === 'video' ? '视频' : '图片') : '未选择背景');
    byId('media-name').textContent = valid && typeof media.name === 'string' ? media.name : translate('从本机选择文件');
    byId('media-name').title = valid && typeof media.name === 'string' ? media.name : '';
    byId('video-section').hidden = !valid || media.kind !== 'video';
    byId('video-behavior').textContent = translate(media?.type === 'hls' ? '静音 · 直播流' : '静音 · 循环');
    let origin = '';
    try { if (valid && media.sourceUrl) origin = new URL(media.sourceUrl).origin; else if (valid && media.type === 'hls') origin = new URL(media.uri).origin; } catch { /* A host-provided display name still remains available. */ }
    byId('media-origin').textContent = origin;
    byId('media-origin').hidden = !origin;
    byId('preview-empty').hidden = Boolean(valid);
    byId('preview').classList.toggle('has-media', Boolean(valid));
    if (identity === mediaIdentity) return;
    mediaIdentity = identity;
    disposeWebm();
    disposeHls();
    if (compositor) { compositor.dispose(); compositor = null; }
    byId('region-canvas').width = 1; byId('region-canvas').height = 1;
    byId('region-canvas').hidden = true;
    mediaFailed = false;
    previewLoading = Boolean(valid && media.type === 'hls');
    previewLoadingKey = '正在加载直播…';
    cancelGesture(false); drawingErrorKey = null;
    if (!valid) regionEditing = false;
    videoReady = false;
    if (currentMedia?.tagName === 'VIDEO') { currentMedia.pause(); currentMedia.removeAttribute('src'); currentMedia.load(); }
    byId('preview-media').replaceChildren();
    currentMedia = null;
    previewErrorKey = null;
    byId('preview-error').hidden = true;
    if (!valid) return;
    const element = document.createElement(media.kind === 'video' ? 'video' : 'img');
    currentMedia = element;
    if (media.kind === 'video') {
      element.muted = true;
      element.defaultMuted = true;
      element.loop = media.type !== 'hls';
      element.playsInline = true;
      element.preload = 'auto';
      element.addEventListener('loadedmetadata', () => { if (element === currentMedia) { videoReady = true; renderPreview(); } });
      element.addEventListener('loadeddata', () => { if (element === currentMedia) { previewLoading = false; renderPreview(); } });
    } else {
      element.alt = '';
      element.draggable = false;
      element.addEventListener('load', () => { if (element === currentMedia) renderPreview(); });
    }
    element.addEventListener('error', () => {
      if (element !== currentMedia) return;
      if (media.kind === 'video' && media.type !== 'hls' && webmFallback && (webmFallback.active || element.error?.code === 4)) {
        previewLoading = true; previewLoadingKey = '正在以兼容模式加载视频…';
        if (webmFallback.retry(element.error)) { renderPreview(); return; }
        previewLoading = false;
      }
      failPreview(element, media.type === 'hls' ? '直播无法预览，请检查播放地址、跨域权限或视频编码。' : media.kind === 'video' ? videoErrorKey(element.error?.code) : '无法读取预览，请重新选择图片。');
    });
    byId('preview-media').append(element);
    if (media.type === 'hls') attachHls(element, media.uri);
    else {
      if (media.kind === 'video' && isWebmMedia(media) && window.FrostedWebm) {
        const fallback = window.FrostedWebm.createFallback({
          video: element,
          load: signal => readVideoBytes(media.uri, signal),
          onReady: () => { if (element === currentMedia && webmFallback === fallback) renderPreview(); },
          onError: error => { if (element === currentMedia && webmFallback === fallback) failPreview(element, videoErrorKey(error?.code)); },
        });
        webmFallback = fallback;
      }
      element.src = media.uri;
    }
  }

  function videoErrorKey(code) {
    if (code === 2 || ['WEBM_READ', 'WEBM_TIMEOUT'].includes(code)) return '无法读取视频，请确认文件可访问且不超过 500 MB。';
    if (code === 'WEBM_LIMIT') return '视频超出当前播放器的缓冲区容量，请选择较小的文件。';
    if (code === 3 || code === 'WEBM_DECODE') return '视频解码失败，请检查文件是否损坏或更换编码。';
    return '此视频的容器或编码不受支持。';
  }

  function isWebmMedia(media) {
    if (typeof media.name === 'string' && /\.webm$/i.test(media.name)) return true;
    try { return /\.webm$/i.test(decodeURIComponent(new URL(media.uri).pathname)); }
    catch { return false; }
  }

  async function readVideoBytes(uri, signal) {
    const limit = Math.min(window.FrostedWebm?.MAX_BYTES || 500 * 1024 * 1024, 500 * 1024 * 1024);
    const response = await fetch(uri, { signal, credentials: 'omit' });
    const reader = response.body?.getReader();
    let complete = false;
    try {
      if (!response.ok || !reader || Number(response.headers.get('content-length')) > limit) throw new Error('Video cannot be read within the size limit');
      const chunks = []; let total = 0;
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) throw new Error('Video exceeds the size limit');
        chunks.push(value);
      }
      signal.throwIfAborted();
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      complete = true;
      return bytes;
    } finally {
      if (reader) {
        if (!complete) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }

  function disposeWebm() {
    const fallback = webmFallback;
    webmFallback = null;
    fallback?.dispose();
  }

  function disposeHls() {
    const player = hlsPlayer;
    hlsPlayer = null;
    if (player) player.destroy();
    if (nativeHls && currentMedia?.tagName === 'VIDEO') {
      nativeHls = false; currentMedia.pause(); currentMedia.removeAttribute('src'); currentMedia.load();
    }
  }

  function failPreview(element, key) {
    if (element !== currentMedia) return;
    cancelGesture(false); mediaFailed = true; previewLoading = false;
    disposeWebm();
    disposeHls();
    previewErrorKey = key;
    byId('preview-error').textContent = translate(key);
    byId('preview-error').hidden = false;
    renderPreview();
  }

  function validatedUrl(value) {
    if (sourceApi) return sourceApi.mediaURL(value);
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || value.length > 8192) throw new Error('Invalid URL');
    url.hash = '';
    return url;
  }

  function attachHls(element, address) {
    const streamingUrl = value => {
      const normalized = sourceApi?.normalizeRemoteSource({ type: 'hls', kind: 'video', url: value });
      if (!normalized) throw new Error('Stream validation is unavailable');
      return normalized.url;
    };
    let url;
    try { url = streamingUrl(address); }
    catch { failPreview(element, '请输入有效的HTTPS链接，不支持包含账号密码的地址。'); return; }
    element.crossOrigin = 'anonymous';
    const Hls = window.Hls;
    if (Hls?.isSupported()) {
      try {
        const player = new Hls({
          enableWorker: false, debug: false, enableInterstitialPlayback: false,
          maxBufferLength: 20, maxMaxBufferLength: 60, backBufferLength: 10,
          xhrSetup(xhr, address) { streamingUrl(address); xhr.withCredentials = false; },
          fetchSetup(context, init) { return new Request(streamingUrl(context.url), { ...init, credentials: 'omit' }); },
        });
        hlsPlayer = player;
        player.on(Hls.Events.MEDIA_ATTACHED, () => { if (hlsPlayer === player && element === currentMedia) player.loadSource(url); });
        player.on(Hls.Events.MANIFEST_PARSED, () => { if (hlsPlayer === player && element === currentMedia) syncPlayback(); });
        player.on(Hls.Events.ERROR, (_event, data) => {
          if (hlsPlayer === player && element === currentMedia && data?.fatal) failPreview(element, '直播无法预览，请检查播放地址、跨域权限或视频编码。');
        });
        player.attachMedia(element);
      } catch { failPreview(element, '直播无法预览，请检查播放地址、跨域权限或视频编码。'); }
    } else if (element.canPlayType('application/vnd.apple.mpegurl')) {
      nativeHls = true; element.src = url;
    } else failPreview(element, '此浏览器不支持HLS预览。');
  }

  function linkInfo() {
    const value = byId('source-url').value.trim();
    if (!value) return null;
    try {
      if (sourceApi) return sourceApi.classifyLink(value, byId('source-kind').value);
      const url = validatedUrl(value);
      const platform = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtube-nocookie.com'].includes(url.hostname) ? 'YouTube'
        : ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'player.twitch.tv', 'clips.twitch.tv'].includes(url.hostname) ? 'Twitch' : null;
      return { type: platform ? 'platform' : byId('source-kind').value, platform, url: url.href };
    } catch { return null; }
  }

  function renderLinkControls() {
    const info = linkInfo();
    const youtube = info?.type === 'platform' && info.platform === 'YouTube';
    const opensPage = info?.type === 'platform' && !youtube;
    byId('source-kind').disabled = Boolean(state.busy || opensPage);
    byId('choose-url').disabled = Boolean(state.busy || !byId('source-url').value.trim());
    byId('choose-url').textContent = translate(loadingUrl ? '正在载入…' : youtube ? '载入背景' : opensPage ? '打开网页' : '载入链接');
    byId('source-hint').textContent = translate(youtube ? 'YouTube 视频会先缓存，再作为背景播放。首次使用会下载辅助工具。' : opensPage ? '此链接将在官方浏览器页面打开，不会用作背景。' : info?.type === 'hls' || byId('source-kind').value === 'hls' ? 'HLS直播需要允许跨域访问的HTTPS播放地址。' : '支持图片、视频直链、YouTube 视频与 HLS 直播；Twitch 在官方网页打开。');
    byId('source-error').textContent = sourceErrorKey ? translate(sourceErrorKey) : '';
    byId('source-error').hidden = !sourceErrorKey;
  }

  function chooseUrl() {
    if (state.busy) return;
    const url = byId('source-url').value.trim();
    try { validatedUrl(url); }
    catch { sourceErrorKey = '请输入有效的HTTPS链接，不支持包含账号密码的地址。'; renderLinkControls(); return; }
    const info = linkInfo();
    if (!info) { sourceErrorKey = '此链接格式不受支持，请检查地址或选择正确类型。'; renderLinkControls(); return; }
    sourceErrorKey = null; loadingUrl = true; submittedUrl = info.url;
    sendAction({ type: 'chooseUrl', url, kind: byId('source-kind').value, config: clone(draft) });
  }

  function renderActions() {
    const busy = Boolean(state.busy);
    const liveApplying = Boolean(state.liveApplying || liveRequest);
    byId('panel').setAttribute('aria-busy', String(busy));
    for (const input of document.querySelectorAll('input, select:not(#language), [data-preset], #reset, #choose-image, #choose-video')) input.disabled = busy;
    byId('apply').disabled = busy || liveApplying || (!state.media && !state.needsReload);
    byId('restore').disabled = busy || (!state.enabled && !state.needsReload);
    byId('toggle-playback').disabled = busy || state.media?.kind !== 'video';
    byId('toggle-playback').textContent = translate(draft.paused ? '继续播放' : '暂停播放');
    byId('toggle-playback').setAttribute('aria-label', translate(draft.paused ? '继续播放' : '暂停播放'));
    byId('toggle-playback').setAttribute('aria-pressed', String(draft.paused));
    const update = state.update;
    byId('update-section').hidden = !update;
    if (update) {
      byId('current-version').textContent = typeof update.currentVersion === 'string' ? `v${update.currentVersion}` : '';
      byId('update-mode').value = ['automatic', 'notify', 'off'].includes(update.mode) ? update.mode : 'off';
      byId('check-updates').disabled = busy || ['checking', 'installing', 'unconfigured'].includes(update.status);
      byId('check-updates').textContent = translate(update.status === 'checking' ? '正在检查…' : update.status === 'installing' ? '正在更新…' : '检查更新');
      const pendingVersion = typeof update.pendingVersion === 'string' ? update.pendingVersion : '';
      const availableVersion = typeof update.availableVersion === 'string' ? update.availableVersion : '';
      byId('available-version').textContent = pendingVersion ? translate('v{version} · 待重载', { version: pendingVersion }) : availableVersion ? translate('发现 v{version}', { version: availableVersion }) : '';
      byId('available-version').hidden = !pendingVersion && !availableVersion;
      byId('update-message').textContent = typeof update.message === 'string' ? update.message : '';
      byId('update-message').hidden = !['checking', 'installing', 'error', 'available', 'unconfigured'].includes(update.status) && !pendingVersion;
      byId('update-message').classList.toggle('is-error', update.status === 'error');
    }
    byId('apply-label').textContent = translate('应用');
    const statusText = busy ? '处理中' : state.needsReload ? '待应用' : liveApplying ? '更新中' : state.liveEnabled ? '实时生效' : state.enabled ? '已启用' : '未启用';
    byId('status-text').textContent = translate(statusText);
    byId('status').classList.toggle('is-active', Boolean(state.enabled || state.needsReload));
    const feedbackKey = state.needsReload ? (update?.pendingVersion ? '点击应用将重载窗口，完成插件更新。' : '点击应用将重载窗口，完成背景设置。')
      : liveApplying ? '正在自动应用最新效果…'
        : state.liveEnabled && dirty && state.error ? '自动应用失败，请点击应用重试。'
          : dirty ? (state.liveEnabled ? '效果调整将自动应用…' : '效果已调整，点击应用使其生效。')
            : '';
    byId('draft-label').textContent = feedbackKey ? translate(feedbackKey) : '';
    byId('draft-label').hidden = !feedbackKey;
    byId('draft-label').classList.toggle('is-dirty', dirty);
    byId('draft-label').classList.toggle('requires-reload', state.needsReload);
    for (const key of ['error', 'notice']) {
      const message = typeof state[key] === 'string' ? state[key] : '';
      byId(key).textContent = message;
      byId(key).hidden = !message;
    }
    renderRegionAvailability();
    renderLinkControls();
  }

  function changed() {
    editRevision += 1;
    queuedRevision = editRevision;
    debounceReady = false;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      debounceReady = true;
      flushLiveConfig();
    }, 250);
    persistDraft();
    renderControls();
  }

  function clearQueuedConfig() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    queuedRevision = null;
    debounceReady = false;
  }

  function flushLiveConfig() {
    if (queuedRevision === null || !debounceReady || liveRequest || !state.liveEnabled || state.busy || !state.media) return;
    if (!dirty) { clearQueuedConfig(); return; }
    const requestId = ++requestSequence;
    liveRequest = { requestId, revision: editRevision };
    clearQueuedConfig();
    persistDraft();
    renderActions();
    // This operation intentionally does not acquire the ordinary UI busy lock:
    // subsequent edits stay responsive and are sent after this request's ack.
    vscode.postMessage({ type: 'liveConfig', config: clone(draft), requestId });
  }

  function sendAction(message) {
    if (state.busy) return;
    cancelGesture(false);
    // Keep a queued change while the picker is open: if choosing is canceled,
    // it still belongs to the existing background. A successful choice returns
    // matching config and clears the queue without a duplicate write.
    if (['apply', 'restore', 'reload'].includes(message.type)) clearQueuedConfig();
    state.busy = true;
    renderPreview();
    renderActions();
    vscode.postMessage(message);
  }

  for (const key of Object.keys(ranges)) {
    byId(key).addEventListener('input', event => { draft[key] = Number(event.target.value); changed(); });
  }
  for (const input of document.querySelectorAll('input[name="fit"]')) {
    input.addEventListener('change', () => { if (input.checked) { draft.fit = input.value; changed(); } });
  }
  byId('position').addEventListener('change', event => { draft.position = event.target.value; changed(); });
  for (const key of ['pauseWhenUnfocused', 'respectReducedMotion']) {
    byId(key).addEventListener('change', event => { draft[key] = event.target.checked; changed(); });
  }
  for (const button of document.querySelectorAll('[data-preset]')) {
    button.addEventListener('click', () => { draft = { ...draft, ...presets[button.dataset.preset] }; changed(); });
  }
  byId('reset').addEventListener('click', () => { draft = { ...defaults }; changed(); });
  byId('regions-enabled').addEventListener('change', event => {
    draft.regions = { ...draft.regions, enabled: event.target.checked };
    changed();
  });
  byId('region-template').addEventListener('change', useRegionTemplate);
  byId('region-edit').addEventListener('click', () => setRegionEditing(!regionEditing));
  byId('region-done').addEventListener('click', () => setRegionEditing(false));
  byId('region-clear').addEventListener('click', () => {
    draft.regions = { ...draft.regions, items: [] }; selectedRegionId = ''; cancelGesture(false); changed();
  });
  byId('region-select').addEventListener('change', event => { cancelGesture(false); selectedRegionId = event.target.value; renderPreview(); renderRegionControls(); });
  byId('region-name').addEventListener('input', event => updateSelectedRegion({ name: event.target.value }));
  for (const key of regionPropertyKeys) byId(`region-${key}`).addEventListener('input', event => updateSelectedRegion({ [key]: Number(event.target.value) }));
  byId('region-sharp').addEventListener('click', () => updateSelectedRegion({ blur: 0 }));
  function deleteSelectedRegion() {
    if (state.busy || !selectedRegion()) return;
    cancelGesture(false);
    draft.regions = { ...draft.regions, items: draft.regions.items.filter(region => region.id !== selectedRegionId) };
    selectedRegionId = ''; changed();
  }
  byId('region-delete').addEventListener('click', deleteSelectedRegion);
  byId('region-show-effects').addEventListener('change', event => { regionEffectsVisible = event.target.checked; renderPreview(); });
  for (const button of document.querySelectorAll('[data-region-tool]')) button.addEventListener('click', () => {
    cancelGesture(false); drawingErrorKey = null; drawingTool = button.dataset.regionTool; renderPreview(); renderRegionControls();
  });
  byId('region-finish').addEventListener('click', finishDrawing);
  byId('region-cancel').addEventListener('click', () => { drawingErrorKey = null; cancelGesture(); });

  function sourcePoint(event, clamp = false) {
    const rect = byId('region-overlay').getBoundingClientRect();
    const bounds = regionBounds();
    if (!bounds.width || !bounds.height) return null;
    const x = (event.clientX - rect.left - bounds.x) / bounds.width;
    const y = (event.clientY - rect.top - bounds.y) / bounds.height;
    if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
    return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
  }
  const overlay = byId('region-overlay');
  function releasePointer() {
    const id = activePointer;
    activePointer = null;
    if (id !== null && overlay.hasPointerCapture(id)) overlay.releasePointerCapture(id);
  }
  function cancelGesture(render = true) {
    releasePointer(); drawing = null; regionDrag = null; showKeyboardCursor = false;
    if (render) { renderPreview(); renderRegionControls(); }
  }
  function pointDistance(a, b, bounds = regionBounds()) {
    return Math.hypot((a[0] - b[0]) * bounds.width, (a[1] - b[1]) * bounds.height);
  }
  function segmentDistance(point, start, end) {
    const dx = end[0] - start[0], dy = end[1] - start[1];
    const amount = dx || dy ? Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy))) : 0;
    return Math.hypot(point[0] - start[0] - amount * dx, point[1] - start[1] - amount * dy);
  }
  function simplifyLasso(points, bounds) {
    const pixels = points.map(([x, y]) => [x * bounds.width, y * bounds.height]);
    if (pixels.length < 3) return null;
    const closed = [...pixels, pixels[0]];
    const keep = new Set([0, closed.length - 1]);
    const pending = [[0, closed.length - 1]];
    while (pending.length) {
      const [start, end] = pending.pop();
      let farthest = -1, distance = 0.8;
      for (let index = start + 1; index < end; index++) {
        const next = segmentDistance(closed[index], closed[start], closed[end]);
        if (next > distance) { distance = next; farthest = index; }
      }
      if (farthest >= 0) { keep.add(farthest); pending.push([start, farthest], [farthest, end]); }
    }
    let result = [...keep].sort((a, b) => a - b).slice(0, -1).map(index => closed[index]);
    if (result.length > 64) {
      // Equal arc-length samples distribute the budget across the whole stroke,
      // instead of repeatedly removing vertices from its beginning.
      const lengths = closed.slice(1).map((point, index) => Math.hypot(point[0] - closed[index][0], point[1] - closed[index][1]));
      const total = lengths.reduce((sum, length) => sum + length, 0);
      result = []; let segment = 0, traversed = 0;
      for (let index = 0; index < 64; index++) {
        const target = total * index / 64;
        while (segment < lengths.length - 1 && traversed + lengths[segment] < target) traversed += lengths[segment++];
        const fraction = lengths[segment] ? (target - traversed) / lengths[segment] : 0;
        result.push(closed[segment].map((value, axis) => value + (closed[segment + 1][axis] - value) * fraction));
      }
    }
    // Reject exceptionally complex contours instead of silently changing them.
    if (pixels.some(point => Math.min(...result.map((start, index) => segmentDistance(point, start, result[(index + 1) % result.length]))) > 2)) return null;
    return result.map(([x, y]) => [x / bounds.width, y / bounds.height]);
  }
  function shapeIsLargeEnough(points, bounds) {
    if (points.length < 3) return false;
    const x = points.map(point => point[0]), y = points.map(point => point[1]);
    const area = Math.abs(points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point[0] * next[1] - next[0] * point[1]; }, 0)) * bounds.width * bounds.height / 2;
    return (Math.max(...x) - Math.min(...x)) * bounds.width >= 4 && (Math.max(...y) - Math.min(...y)) * bounds.height >= 4 && area >= 16;
  }
  function finishDrawing() {
    if (state.busy || !drawing) return;
    if (drawing.kind === 'polygon' && drawing.points.length < 3) {
      drawingErrorKey = '多边形至少需要3个点。'; renderRegionControls(); return;
    }
    const kind = drawing.kind;
    let points = kind === 'rect' ? rectanglePoints(drawing.points[0], drawing.points.at(-1)) : drawing.points;
    const bounds = regionBounds();
    if (!shapeIsLargeEnough(points, bounds)) {
      cancelGesture(false); drawingErrorKey = '选区太小，请重新绘制更大的区域。'; renderRegionControls(); return;
    }
    if (kind === 'lasso') points = drawing.tooComplex ? null : simplifyLasso(points, bounds);
    if (!points) {
      cancelGesture(false); drawingErrorKey = '轮廓过于复杂，请拆成更简单的区域。'; renderRegionControls(); return;
    }
    if (!shapeIsLargeEnough(points, bounds)) {
      cancelGesture(false); drawingErrorKey = '选区太小，请重新绘制更大的区域。'; renderRegionControls(); return;
    }
    cancelGesture(false); drawingErrorKey = null;
    if (addRegion(points)) drawingTool = 'select';
    renderRegionControls();
  }
  function appendLassoPoint(point, minimumDistance = 0.75) {
    if (!drawing || drawing.kind !== 'lasso') return;
    if (pointDistance(point, drawing.points.at(-1)) < minimumDistance) return;
    if (drawing.points.length >= 8192) { drawing.tooComplex = true; return; }
    drawing.points.push(point);
  }
  function appendPolygonPoint(point) {
    if (!drawing) drawing = { kind: 'polygon', points: [], hover: null };
    if (drawing.points.length && pointDistance(point, drawing.points.at(-1)) < 1) return;
    if (drawing.points.length >= 64) { drawingErrorKey = '最多64个顶点，请完成选区或撤销一个点。'; return; }
    drawing.points.push([...point]); drawing.hover = null; drawingErrorKey = null;
  }
  function moveRegion(point) {
    if (!regionDrag) return;
    const x = regionDrag.points.map(item => item[0]), y = regionDrag.points.map(item => item[1]);
    const dx = Math.max(-Math.min(...x), Math.min(1 - Math.max(...x), point[0] - regionDrag.start[0]));
    const dy = Math.max(-Math.min(...y), Math.min(1 - Math.max(...y), point[1] - regionDrag.start[1]));
    regionDrag.currentPoints = regionDrag.points.map(([px, py]) => [px + dx, py + dy]);
    regionDrag.moved = Math.abs(dx) + Math.abs(dy) > 0.00001;
    renderPreview();
  }
  overlay.addEventListener('pointerdown', event => {
    if (state.busy || !regionEditing || event.button !== 0 || event.isPrimary === false || activePointer !== null) return;
    const point = sourcePoint(event);
    if (!point) return;
    overlay.focus({ preventScroll: true });
    showKeyboardCursor = false;
    if (drawingTool === 'select') {
      const polygon = event.target.closest('[data-region-id]');
      if (polygon) {
        selectedRegionId = polygon.getAttribute('data-region-id');
        const region = selectedRegion();
        regionDrag = { id: region.id, start: point, points: clone(region.points), currentPoints: clone(region.points), moved: false };
        activePointer = event.pointerId; overlay.setPointerCapture(event.pointerId);
        drawingErrorKey = null; renderRegionControls(); event.preventDefault();
      }
      return;
    }
    if (draft.regions.items.length >= 8) return;
    event.preventDefault();
    activePointer = event.pointerId;
    overlay.setPointerCapture(event.pointerId);
    drawingErrorKey = null;
    if (drawingTool === 'rect') drawing = { kind: 'rect', points: [point, point] };
    else if (drawingTool === 'lasso') drawing = { kind: 'lasso', points: [point] };
    else appendPolygonPoint(point);
    renderRegionControls();
  });
  overlay.addEventListener('pointermove', event => {
    if (state.busy || !regionEditing || event.isPrimary === false || (activePointer !== null && activePointer !== event.pointerId)) return;
    const point = sourcePoint(event, true);
    if (!point) return;
    if (regionDrag && activePointer === event.pointerId) { moveRegion(point); return; }
    if (!drawing) return;
    if (drawing.kind === 'polygon') drawing.hover = point;
    else if (activePointer !== event.pointerId) return;
    else if (drawing.kind === 'rect') drawing.points[1] = point;
    else appendLassoPoint(point);
    renderRegionOverlay();
  });
  overlay.addEventListener('pointerup', event => {
    if (activePointer !== event.pointerId) return;
    if (state.busy || !regionEditing) { cancelGesture(); return; }
    const point = sourcePoint(event, true);
    if (regionDrag) {
      if (point) moveRegion(point);
      const { id, moved, currentPoints: points } = regionDrag;
      cancelGesture(false);
      if (moved) updateRegion(id, { points });
      else { renderPreview(); renderRegionControls(); }
      return;
    }
    if (point && drawing?.kind === 'rect') drawing.points[1] = point;
    else if (point && drawing?.kind === 'lasso') appendLassoPoint(point, 0.1);
    releasePointer();
    if (drawing?.kind === 'rect' || drawing?.kind === 'lasso') finishDrawing();
    else renderRegionControls();
  });
  overlay.addEventListener('dblclick', event => {
    if (state.busy || !regionEditing || drawingTool !== 'polygon') return;
    event.preventDefault(); releasePointer(); finishDrawing();
  });
  for (const name of ['pointercancel', 'lostpointercapture']) overlay.addEventListener(name, event => { if (activePointer === event.pointerId) cancelGesture(); });
  overlay.addEventListener('pointerleave', () => { if (activePointer === null && drawing?.kind === 'polygon') { drawing.hover = null; renderRegionOverlay(); } });
  overlay.addEventListener('keydown', event => {
    if (state.busy || !regionEditing) return;
    if (event.key === 'Escape') { event.preventDefault(); drawingErrorKey = null; cancelGesture(); return; }
    if (event.key === 'Backspace' && drawing?.kind === 'polygon') {
      event.preventDefault(); drawing.points.pop(); drawing.hover = null; drawingErrorKey = null;
      if (!drawing.points.length) drawing = null;
      renderRegionControls(); return;
    }
    if (event.key === 'Delete' && drawingTool === 'select') { event.preventDefault(); deleteSelectedRegion(); return; }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      if (drawingTool === 'select') {
        cancelGesture(false);
        const items = draft.regions.items;
        const direction = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
        if (items.length) selectedRegionId = items[(Math.max(0, items.findIndex(region => region.id === selectedRegionId)) + direction + items.length) % items.length].id;
        renderPreview(); renderRegionControls(); return;
      }
      const step = event.shiftKey ? 0.1 : 0.02;
      const axis = ['ArrowLeft', 'ArrowRight'].includes(event.key) ? 0 : 1;
      keyboardCursor[axis] = Math.max(0, Math.min(1, keyboardCursor[axis] + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -step : step)));
      showKeyboardCursor = true;
      if (drawing?.kind === 'rect') drawing.points[1] = [...keyboardCursor];
      else if (drawing?.kind === 'polygon') drawing.hover = [...keyboardCursor];
      renderRegionOverlay(); return;
    }
    if ((event.key === ' ' || event.key === 'Enter') && ['rect', 'polygon'].includes(drawingTool) && draft.regions.items.length < 8) {
      event.preventDefault(); showKeyboardCursor = true;
      if (event.key === 'Enter' && drawing) { finishDrawing(); return; }
      if (drawingTool === 'rect') {
        if (drawing) finishDrawing();
        else drawing = { kind: 'rect', points: [[...keyboardCursor], [...keyboardCursor]] };
      } else appendPolygonPoint(keyboardCursor);
      renderRegionControls();
    }
  });
  let previewSize = [byId('preview').clientWidth, byId('preview').clientHeight];
  new ResizeObserver(() => {
    const next = [byId('preview').clientWidth, byId('preview').clientHeight];
    if (next.some((value, index) => value !== previewSize[index])) cancelGesture(false);
    previewSize = next;
    renderPreview();
  }).observe(byId('preview'));
  const themeObserver = new MutationObserver(renderPreview);
  for (const element of [document.documentElement, document.body]) themeObserver.observe(element, { attributes: true, attributeFilter: ['class', 'style'] });
  byId('choose-image').addEventListener('click', () => sendAction({ type: 'chooseMedia', kind: 'image', config: clone(draft) }));
  byId('choose-video').addEventListener('click', () => sendAction({ type: 'chooseMedia', kind: 'video', config: clone(draft) }));
  byId('choose-url').addEventListener('click', chooseUrl);
  byId('source-url').addEventListener('input', () => { sourceErrorKey = null; renderLinkControls(); });
  byId('source-kind').addEventListener('change', () => { sourceErrorKey = null; renderLinkControls(); });
  byId('source-url').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); chooseUrl(); } });
  byId('toggle-playback').addEventListener('click', () => { if (!state.busy && state.media?.kind === 'video') { draft.paused = !draft.paused; changed(); } });
  byId('apply').addEventListener('click', () => {
    if (state.needsReload && (!dirty || !state.media)) sendAction({ type: 'reload' });
    else sendAction({ type: 'apply', config: clone(draft), reloadAfterApply: true });
  });
  byId('restore').addEventListener('click', () => sendAction({ type: 'restore' }));
  // Closing is a view-only action: do not acquire the operation lock or modify
  // saved drafts, the selected media, or the background's enabled state.
  byId('close-panel').addEventListener('click', () => { cancelGesture(); vscode.postMessage({ type: 'closePanel' }); });
  byId('language').addEventListener('change', event => {
    language = normalizeLanguage(event.target.value);
    renderLanguage();
    vscode.postMessage({ type: 'setLanguage', language });
  });
  byId('update-mode').addEventListener('change', event => sendAction({ type: 'setUpdateMode', mode: event.target.value }));
  byId('check-updates').addEventListener('click', () => sendAction({ type: 'checkUpdates' }));

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.type !== 'state') return;
    const ack = Number.isSafeInteger(message.liveAck) && message.liveAck > 0 ? message.liveAck : 0;
    // Ignore an older acknowledgement snapshot rather than rolling controls
    // back after a newer request has already completed.
    if (ack && ack < lastLiveAck) return;
    if (message.busy) cancelGesture(false);
    lastLiveAck = Math.max(lastLiveAck, ack);
    requestSequence = Math.max(requestSequence, ack);
    const request = liveRequest;
    const acknowledged = Boolean(request && ack >= request.requestId);
    const canReset = message.resetDraft && (request
      ? acknowledged && editRevision === request.revision && !message.error
      : !state.liveEnabled || queuedRevision === null);
    language = normalizeLanguage(message.language);
    applied = normalize(message.config);
    defaults = normalize(message.defaults);
    const shouldReplaceDraft = canReset || (!dirty && !request && queuedRevision === null);
    if ((drawing || regionDrag) && shouldReplaceDraft && JSON.stringify(applied.regions) !== JSON.stringify(draft.regions)) cancelGesture(false);
    // Host settings may change outside this panel. Follow them whenever there
    // is no unsaved local draft, while preserving deliberate local edits.
    if (shouldReplaceDraft) draft = { ...applied };
    if (acknowledged) liveRequest = null;
    if (loadingUrl && !message.busy) {
      // An explicit retry of a failed stream creates one fresh player. Other
      // host echoes, including opening a platform page, retain the old media.
      if (!message.error && mediaFailed && message.media?.type === 'hls' && message.media.uri === submittedUrl) mediaIdentity = '';
      loadingUrl = false;
    }
    state = {
      config: applied, enabled: Boolean(message.enabled), media: message.media || null,
      busy: Boolean(message.busy), error: message.error, notice: message.notice,
      needsReload: Boolean(message.needsReload),
      liveEnabled: Boolean(message.liveEnabled), liveApplying: Boolean(message.liveApplying),
      update: message.update && typeof message.update === 'object' ? message.update : null,
    };
    persistDraft();
    if (!dirty && !liveRequest) clearQueuedConfig();
    renderLanguage();
    flushLiveConfig();
  });
  reducedMotion.addEventListener('change', syncPlayback);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelGesture(); syncPlayback(); });
  window.addEventListener('focus', syncPlayback);
  window.addEventListener('blur', () => { cancelGesture(); syncPlayback(); });
  window.addEventListener('pagehide', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (currentMedia?.tagName === 'VIDEO') currentMedia.pause();
    disposeWebm();
    disposeHls();
    if (compositor) { compositor.dispose(); compositor = null; }
  });
  renderLanguage();
  vscode.postMessage({ type: 'ready' });
})();
