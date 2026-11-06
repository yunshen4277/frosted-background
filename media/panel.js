(() => {
  'use strict';

  const vscode = acquireVsCodeApi();
  const { normalizeLanguage, t } = window.FrostedI18n;
  const clone = value => JSON.parse(JSON.stringify(value));
  let language = normalizeLanguage(document.documentElement.lang);
  const translate = (key, params) => t(language, key, params);
  const fallback = {
    blur: 14, opacity: 0.35, tintOpacity: 0.18, saturation: 1, brightness: 1,
    fit: 'cover', position: 'center center', playbackRate: 1,
    pauseWhenUnfocused: true, respectReducedMotion: true, paused: false,
  };
  const ranges = { blur: [0, 60], opacity: [0.05, 1], tintOpacity: [0, 0.9], brightness: [0.2, 2], saturation: [0, 2], playbackRate: [0.25, 2] };
  const presets = {
    soft: { blur: 18, opacity: 0.35, tintOpacity: 0.18, brightness: 1, saturation: 0.9 },
    clear: { blur: 5, opacity: 0.45, tintOpacity: 0.1, brightness: 1, saturation: 1 },
    focus: { blur: 28, opacity: 0.22, tintOpacity: 0.35, brightness: 0.8, saturation: 0.7 },
  };
  const byId = id => document.getElementById(id);
  const normalize = values => {
    const result = { ...fallback };
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
  let wallpaperQuery = typeof saved.wallpaperQuery === 'string' ? saved.wallpaperQuery.slice(0, 120) : '';
  let wallpaperSupportedOnly = saved.wallpaperSupportedOnly !== false;
  let wallpaperLimit = 50;
  let wallpaperSignature = '';
  let state = { config: applied, enabled: false, media: null, busy: true, error: null, notice: null, needsReload: false, update: null, wallpaperEngine: null, liveEnabled: false, liveApplying: false };
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
  let webmFallback = null;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function persistDraft() {
    dirty = JSON.stringify(draft) !== JSON.stringify(applied);
    vscode.setState({ draft: clone(draft), dirty, liveRequestId: requestSequence, wallpaperQuery, wallpaperSupportedOnly });
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
    for (const attribute of ['aria-label', 'title', 'placeholder']) {
      for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
        element.setAttribute(attribute, translate(element.getAttribute(`data-i18n-${attribute}`)));
      }
    }
    if (previewErrorKey) byId('preview-error').textContent = translate(previewErrorKey);
    byId('preview-loading').textContent = translate('正在以兼容模式加载视频…');
    // Only text changes. The current image/video element, time, and draft stay
    // intact; updateMedia has an identity guard for authoritative host echoes.
    updateMedia();
    renderControls();
  }

  function renderControls() {
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
    renderActions();
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
      if (videoReady && currentMedia.currentTime === 0 && Number.isFinite(currentMedia.duration)) {
        try { currentMedia.currentTime = Math.min(0.05, currentMedia.duration / 2); } catch { /* Unsupported codec: media error handler supplies a useful message. */ }
      }
    } else {
      const promise = currentMedia.play();
      if (promise && typeof promise.catch === 'function') promise.catch(() => { /* Muted preview may be paused by browser policy; controls remain usable. */ });
    }
  }

  function renderPreview() {
    byId('preview-loading').textContent = translate('正在以兼容模式加载视频…');
    byId('preview-loading').hidden = !previewLoading || mediaFailed;
    document.querySelector('.preview-tint').style.opacity = String(draft.tintOpacity);
    if (currentMedia) {
      currentMedia.style.objectFit = draft.fit;
      currentMedia.style.objectPosition = draft.position;
      currentMedia.style.opacity = String(draft.opacity);
      // Preview pixels represent the texture at the editor's larger scale.
      currentMedia.style.filter = `blur(${draft.blur * 0.34}px) brightness(${draft.brightness}) saturate(${draft.saturation})`;
      currentMedia.style.transform = draft.fit === 'cover' ? 'scale(1.08)' : 'none';
      if (currentMedia.tagName === 'VIDEO') currentMedia.playbackRate = draft.playbackRate;
    }
    syncPlayback();
  }

  function updateMedia() {
    const media = state.media;
    const valid = media && typeof media.uri === 'string' && ['image', 'video'].includes(media.kind);
    const identity = valid ? `${media.kind}:${media.uri}` : '';
    byId('media-kind').textContent = translate(valid ? (media.kind === 'video' ? '视频' : '图片') : '未选择背景');
    byId('media-name').textContent = valid && typeof media.name === 'string' ? media.name : translate('从本机选择文件');
    byId('media-name').title = valid && typeof media.name === 'string' ? media.name : '';
    byId('video-section').hidden = !valid || media.kind !== 'video';
    byId('preview-empty').hidden = Boolean(valid);
    byId('preview').classList.toggle('has-media', Boolean(valid));
    if (identity === mediaIdentity) return;
    mediaIdentity = identity;
    disposeWebm();
    mediaFailed = false;
    previewLoading = false;
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
      element.loop = true;
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
      if (media.kind === 'video' && webmFallback && (webmFallback.active || element.error?.code === 4)) {
        previewLoading = true;
        if (webmFallback.retry(element.error)) { renderPreview(); return; }
        previewLoading = false;
      }
      failPreview(element, media.kind === 'video' ? videoErrorKey(element.error?.code) : '无法读取预览，请重新选择图片。');
    });
    byId('preview-media').append(element);
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

  function failPreview(element, key) {
    if (element !== currentMedia) return;
    mediaFailed = true; previewLoading = false;
    disposeWebm();
    previewErrorKey = key;
    byId('preview-error').textContent = translate(key);
    byId('preview-error').hidden = false;
    renderPreview();
  }

  function wallpaperType(type) {
    return translate({ image: '图片', video: '视频', scene: '场景壁纸', web: '网页壁纸', app: '应用壁纸', application: '应用壁纸' }[type] || '其他类型');
  }

  function wallpaperReason(reason) {
    const key = {
      'unsupported-type': '此类型无法用于代码区。',
      'missing-media': '壁纸文件缺失或尚未下载完成。',
      'too-large': '文件超过 500 MB。',
      'invalid-project': '壁纸项目无效。',
      'unsafe-path': '壁纸路径无效。',
    }[reason];
    return key ? translate(key) : typeof reason === 'string' && reason ? reason : translate('此类型无法用于代码区。');
  }

  function libraryItems() {
    const items = state.wallpaperEngine?.items;
    return Array.isArray(items) ? items.slice(0, 1000).filter(item => item && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 256) : [];
  }

  function renderWallpapers() {
    const library = state.wallpaperEngine || {};
    const busy = Boolean(state.busy || library.loading);
    const items = libraryItems();
    const query = wallpaperQuery.trim().toLowerCase();
    const matches = items.filter(item => (!wallpaperSupportedOnly || item.supported === true)
      && (!query || `${typeof item.title === 'string' ? item.title : ''} ${item.type || ''} ${wallpaperType(item.type)}`.toLowerCase().includes(query)));
    const visible = matches.slice(0, wallpaperLimit);
    byId('wallpaper-search').value = wallpaperQuery;
    byId('wallpaper-search').disabled = false;
    byId('wallpaper-supported').checked = wallpaperSupportedOnly;
    byId('wallpaper-supported').disabled = false;
    byId('wallpaper-status').textContent = translate(library.loading ? '正在读取壁纸库…' : library.connected ? '已连接本机壁纸库' : '连接本机壁纸库');
    byId('wallpaper-refresh').disabled = busy;
    byId('wallpaper-folder').disabled = busy;
    byId('wallpaper-workshop').disabled = busy || !query;
    byId('wallpaper-error').textContent = typeof library.error === 'string' ? library.error : '';
    byId('wallpaper-error').hidden = !byId('wallpaper-error').textContent;
    byId('wallpaper-empty').hidden = visible.length > 0;
    byId('wallpaper-empty').textContent = translate(library.loading ? '正在读取壁纸库…' : !library.connected ? '尚未连接壁纸库，请刷新自动检测或选择文件夹。'
      : query ? '没有匹配的壁纸。' : wallpaperSupportedOnly && items.length ? '没有可用于代码区的壁纸，可取消筛选查看全部。' : '此文件夹中没有已下载的壁纸。');
    byId('wallpaper-count').textContent = matches.length ? translate('显示 {shown} / {count}', { shown: visible.length, count: matches.length }) : '';
    byId('wallpaper-more').hidden = matches.length <= visible.length;
    byId('wallpaper-truncated').hidden = !library.truncated;
    const signature = JSON.stringify([language, busy, visible]);
    if (signature === wallpaperSignature) return;
    wallpaperSignature = signature;
    const cards = visible.map(item => {
      const card = document.createElement('article'); card.className = 'wallpaper-card';
      const supported = item.supported === true;
      card.classList.toggle('is-unavailable', !supported);
      const thumbnail = document.createElement('div'); thumbnail.className = 'wallpaper-thumbnail'; thumbnail.setAttribute('aria-hidden', 'true');
      thumbnail.textContent = '▧';
      if (typeof item.previewUri === 'string' && item.previewUri) {
        const image = document.createElement('img'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; image.src = item.previewUri;
        image.addEventListener('error', () => { thumbnail.textContent = '▧'; }, { once: true });
        thumbnail.replaceChildren(image);
      }
      const info = document.createElement('div'); info.className = 'wallpaper-info';
      const title = document.createElement('h3'); title.className = 'wallpaper-title';
      title.textContent = typeof item.title === 'string' && item.title ? item.title : translate('未命名壁纸');
      const type = document.createElement('span'); type.className = 'wallpaper-type'; type.textContent = wallpaperType(item.type);
      info.append(title, type); card.append(thumbnail, info);
      if (supported) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button wallpaper-apply';
        button.dataset.wallpaperId = item.id; button.textContent = translate('应用'); button.disabled = busy;
        button.setAttribute('aria-label', translate('应用壁纸：{title}', { title: title.textContent })); card.append(button);
      } else {
        const reason = document.createElement('p'); reason.className = 'wallpaper-reason'; reason.textContent = wallpaperReason(item.reason); card.append(reason);
      }
      return card;
    });
    byId('wallpaper-list').replaceChildren(...cards);
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
    renderWallpapers();
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
  byId('choose-image').addEventListener('click', () => sendAction({ type: 'chooseMedia', kind: 'image', config: clone(draft) }));
  byId('choose-video').addEventListener('click', () => sendAction({ type: 'chooseMedia', kind: 'video', config: clone(draft) }));
  byId('wallpaper-search').addEventListener('input', event => {
    wallpaperQuery = event.target.value.slice(0, 120); wallpaperLimit = 50;
    persistDraft(); renderWallpapers();
  });
  byId('wallpaper-supported').addEventListener('change', event => {
    wallpaperSupportedOnly = event.target.checked; wallpaperLimit = 50;
    persistDraft(); renderWallpapers();
  });
  byId('wallpaper-more').addEventListener('click', () => { wallpaperLimit = Math.min(1000, wallpaperLimit + 50); renderWallpapers(); });
  byId('wallpaper-refresh').addEventListener('click', () => sendAction({ type: 'refreshWallpapers' }));
  byId('wallpaper-folder').addEventListener('click', () => sendAction({ type: 'chooseWallpaperFolder' }));
  byId('wallpaper-workshop').addEventListener('click', () => {
    const query = wallpaperQuery.trim(); if (query) sendAction({ type: 'searchWorkshop', query });
  });
  byId('wallpaper-list').addEventListener('click', event => {
    const button = event.target.closest('button[data-wallpaper-id]');
    if (!button || button.disabled || state.wallpaperEngine?.loading) return;
    const item = libraryItems().find(value => value.id === button.dataset.wallpaperId && value.supported === true);
    if (item) sendAction({ type: 'applyWallpaper', id: item.id, config: clone(draft) });
  });
  byId('toggle-playback').addEventListener('click', () => { if (!state.busy && state.media?.kind === 'video') { draft.paused = !draft.paused; changed(); } });
  byId('apply').addEventListener('click', () => {
    if (state.needsReload && (!dirty || !state.media)) sendAction({ type: 'reload' });
    else sendAction({ type: 'apply', config: clone(draft), reloadAfterApply: true });
  });
  byId('restore').addEventListener('click', () => sendAction({ type: 'restore' }));
  // Closing is a view-only action: do not acquire the operation lock or modify
  // saved drafts, the selected media, or the background's enabled state.
  byId('close-panel').addEventListener('click', () => vscode.postMessage({ type: 'closePanel' }));
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
    // Host settings may change outside this panel. Follow them whenever there
    // is no unsaved local draft, while preserving deliberate local edits.
    if (shouldReplaceDraft) draft = { ...applied };
    if (acknowledged) liveRequest = null;
    state = {
      config: applied, enabled: Boolean(message.enabled), media: message.media || null,
      busy: Boolean(message.busy), error: message.error, notice: message.notice,
      needsReload: Boolean(message.needsReload),
      liveEnabled: Boolean(message.liveEnabled), liveApplying: Boolean(message.liveApplying),
      update: message.update && typeof message.update === 'object' ? message.update : null,
      wallpaperEngine: message.wallpaperEngine && typeof message.wallpaperEngine === 'object' ? message.wallpaperEngine : null,
    };
    persistDraft();
    if (!dirty && !liveRequest) clearQueuedConfig();
    renderLanguage();
    flushLiveConfig();
  });
  reducedMotion.addEventListener('change', syncPlayback);
  document.addEventListener('visibilitychange', syncPlayback);
  window.addEventListener('focus', syncPlayback);
  window.addEventListener('blur', syncPlayback);
  window.addEventListener('pagehide', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (currentMedia?.tagName === 'VIDEO') currentMedia.pause();
    disposeWebm();
  });
  renderLanguage();
  vscode.postMessage({ type: 'ready' });
})();
