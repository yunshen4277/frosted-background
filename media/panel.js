(() => {
  'use strict';

  const vscode = acquireVsCodeApi();
  const fallback = {
    blur: 14, opacity: 0.35, tintOpacity: 0.18, saturation: 1, brightness: 1,
    fit: 'cover', position: 'center center', playbackRate: 1,
    pauseWhenUnfocused: true, respectReducedMotion: true,
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
    for (const key of ['pauseWhenUnfocused', 'respectReducedMotion']) if (typeof values[key] === 'boolean') result[key] = values[key];
    return result;
  };
  const saved = vscode.getState() || {};
  let draft = normalize(saved.draft);
  let defaults = { ...fallback };
  let applied = { ...fallback };
  let dirty = Boolean(saved.dirty && saved.draft);
  let state = { config: applied, enabled: false, media: null, busy: true, error: null, notice: null, needsReload: false, update: null };
  let currentMedia = null;
  let mediaIdentity = '';
  let videoReady = false;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function persistDraft() {
    dirty = Object.keys(fallback).some(key => draft[key] !== applied[key]);
    vscode.setState({ draft: { ...draft }, dirty });
  }

  function formatValue(key, value) {
    if (key === 'blur') return `${Math.round(value)} px`;
    if (key === 'playbackRate') return `${Number(value.toFixed(2))}×`;
    return `${Math.round(value * 100)}%`;
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
    byId('fit-description').textContent = {
      cover: '等比铺满，允许裁剪边缘',
      contain: '完整显示画面，可能留白',
      fill: '随编辑区拉伸，可能改变画面比例',
    }[draft.fit];
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
    const shouldPause = document.hidden || (draft.respectReducedMotion && reducedMotion.matches)
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
    byId('preview').style.backgroundColor = 'var(--vscode-editor-background, #111923)';
    document.querySelector('.preview-tint').style.opacity = String(draft.tintOpacity);
    if (currentMedia) {
      currentMedia.style.objectFit = draft.fit;
      currentMedia.style.objectPosition = draft.position;
      currentMedia.style.opacity = String(draft.opacity);
      // Preview pixels are scaled down to represent the editor's visual texture.
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
    byId('media-kind').textContent = valid ? (media.kind === 'video' ? '视频' : '图片') : '未选择背景';
    byId('media-name').textContent = valid && typeof media.name === 'string' ? media.name : '从本机选择文件';
    byId('media-name').title = valid && typeof media.name === 'string' ? media.name : '';
    byId('video-section').hidden = !valid || media.kind !== 'video';
    byId('preview-empty').hidden = Boolean(valid);
    byId('preview').classList.toggle('has-media', Boolean(valid));
    if (identity === mediaIdentity) return;
    mediaIdentity = identity;
    videoReady = false;
    if (currentMedia?.tagName === 'VIDEO') { currentMedia.pause(); currentMedia.removeAttribute('src'); currentMedia.load(); }
    byId('preview-media').replaceChildren();
    currentMedia = null;
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
      element.addEventListener('loadedmetadata', () => { videoReady = true; syncPlayback(); });
    } else {
      element.alt = '';
      element.draggable = false;
    }
    element.addEventListener('error', () => {
      if (element !== currentMedia) return;
      byId('preview-error').textContent = media.kind === 'video' ? '此视频无法预览，请尝试 WebM 格式。' : '无法读取预览，请重新选择图片。';
      byId('preview-error').hidden = false;
    });
    element.src = media.uri;
    byId('preview-media').append(element);
  }

  function renderActions() {
    const busy = Boolean(state.busy);
    byId('panel').setAttribute('aria-busy', String(busy));
    for (const input of document.querySelectorAll('input, select, [data-preset], #reset, #choose-image, #choose-video')) input.disabled = busy;
    byId('apply').disabled = busy || !state.media;
    byId('restore').disabled = busy || (!state.enabled && !state.needsReload);
    byId('reload').disabled = busy;
    byId('reload').hidden = !state.needsReload;
    const update = state.update;
    byId('update-section').hidden = !update;
    if (update) {
      byId('current-version').textContent = typeof update.currentVersion === 'string' ? `v${update.currentVersion}` : '';
      byId('update-mode').value = ['automatic', 'notify', 'off'].includes(update.mode) ? update.mode : 'off';
      byId('check-updates').disabled = busy || ['checking', 'installing', 'unconfigured'].includes(update.status);
      byId('check-updates').textContent = update.status === 'checking' ? '正在检查…' : update.status === 'installing' ? '正在更新…' : '检查更新';
      const pendingVersion = typeof update.pendingVersion === 'string' ? update.pendingVersion : '';
      const availableVersion = typeof update.availableVersion === 'string' ? update.availableVersion : '';
      byId('available-version').textContent = pendingVersion ? `v${pendingVersion} · 待重载` : availableVersion ? `发现 v${availableVersion}` : '';
      byId('available-version').hidden = !pendingVersion && !availableVersion;
      byId('update-message').textContent = typeof update.message === 'string' ? update.message : '';
      byId('update-message').classList.toggle('is-error', update.status === 'error');
    }
    byId('apply-label').textContent = busy ? '正在处理…' : '应用到编辑区';
    const statusText = busy ? '处理中' : state.needsReload ? '待重载' : state.enabled ? '已启用' : '未启用';
    byId('status-text').textContent = statusText;
    byId('status').classList.toggle('is-active', Boolean(state.enabled || state.needsReload));
    byId('draft-label').textContent = dirty ? '● 效果已调整，尚未应用到编辑区' : state.needsReload ? (update?.pendingVersion ? '插件更新已准备好，重载窗口后生效' : '背景已准备好，重载窗口后生效') : state.media ? '预览效果不会影响代码清晰度' : '把喜欢的风景，放进代码里';
    byId('draft-label').classList.toggle('is-dirty', dirty);
    for (const key of ['error', 'notice']) {
      const message = typeof state[key] === 'string' ? state[key] : '';
      byId(key).textContent = message;
      byId(key).hidden = !message;
    }
  }

  function changed() {
    persistDraft();
    renderControls();
  }

  function sendAction(message) {
    if (state.busy) return;
    state.busy = true;
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
  byId('choose-image').addEventListener('click', () => sendAction({ type: 'chooseMedia', kind: 'image' }));
  byId('choose-video').addEventListener('click', () => sendAction({ type: 'chooseMedia', kind: 'video' }));
  byId('apply').addEventListener('click', () => sendAction({ type: 'apply', config: { ...draft } }));
  byId('restore').addEventListener('click', () => sendAction({ type: 'restore' }));
  byId('reload').addEventListener('click', () => sendAction({ type: 'reload' }));
  byId('update-mode').addEventListener('change', event => sendAction({ type: 'setUpdateMode', mode: event.target.value }));
  byId('check-updates').addEventListener('click', () => sendAction({ type: 'checkUpdates' }));

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.type !== 'state') return;
    applied = normalize(message.config);
    defaults = normalize(message.defaults);
    // Host settings may change outside this panel. Follow them whenever there
    // is no unsaved local draft, while preserving deliberate local edits.
    if (message.resetDraft || !dirty) draft = { ...applied };
    state = {
      config: applied, enabled: Boolean(message.enabled), media: message.media || null,
      busy: Boolean(message.busy), error: message.error, notice: message.notice,
      needsReload: Boolean(message.needsReload),
      update: message.update && typeof message.update === 'object' ? message.update : null,
    };
    updateMedia();
    persistDraft();
    renderControls();
  });
  reducedMotion.addEventListener('change', syncPlayback);
  document.addEventListener('visibilitychange', syncPlayback);
  window.addEventListener('focus', syncPlayback);
  window.addEventListener('blur', syncPlayback);
  window.addEventListener('pagehide', () => { if (currentMedia?.tagName === 'VIDEO') currentMedia.pause(); });
  renderControls();
  vscode.postMessage({ type: 'ready' });
})();
