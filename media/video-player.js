/* Isolated video document. Local files use Blob media; an HLS-only document
   permits HTTPS streaming without changing the workbench CSP. No Node access. */
(() => {
  'use strict';
  const channel = new URLSearchParams(location.hash.slice(1)).get('frosted-channel');
  if (!channel || !/^[a-f0-9-]{36}$/.test(channel) || parent === window) return;
  const MESSAGE = 'frosted-background-player';
  // File/custom protocols differ between Chromium builds in origin
  // serialization. Their messages use the exact parent WindowProxy plus a
  // random channel; ordinary web origins additionally require an origin match.
  const own = new URL(location.href);
  const ownOrigin = /^https?:$/.test(own.protocol) ? own.origin : undefined;
  const targetOrigin = ownOrigin || '*';
  const controller = new AbortController();
  let initialized = false;
  let disposed = false;
  let desiredPlaying = false;
  let manuallyPaused = false;
  let sourceAssigned = false;
  let ready = false;
  let failed = false;
  let playPending = false;
  let playbackBlocked = false;
  let objectURL;
  let compositor;
  let regionCanvas;
  let hls;
  let recoveryTimer;
  let networkRecoveries = 0;
  let mediaRecoveries = 0;
  const regionTools = window.FrostedRegions;
  const video = document.createElement('video');
  video.muted = video.defaultMuted = true;
  video.loop = video.playsInline = true;
  video.preload = 'auto';
  video.controls = false;
  video.tabIndex = -1;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('aria-hidden', 'true');
  Object.assign(document.documentElement.style, { width: '100%', height: '100%', overflow: 'hidden' });
  Object.assign(document.body.style, { margin: '0', width: '100%', height: '100%', overflow: 'hidden', background: 'transparent' });
  Object.assign(video.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', pointerEvents: 'none' });
  document.body.appendChild(video);

  function send(event, detail) {
    if (!disposed) parent.postMessage({ type: MESSAGE, channel, event, detail }, targetOrigin);
  }
  function updatePlayback() {
    if (disposed || failed || !sourceAssigned) return;
    if (!desiredPlaying || manuallyPaused) { video.pause(); return; }
    if (playPending || playbackBlocked || !video.paused) return;
    playPending = true;
    Promise.resolve(video.play()).catch(error => {
      if (disposed || error.name === 'AbortError') return;
      playbackBlocked = true;
      send('playback-blocked', 'Automatic playback was blocked; click or focus the editor to retry.');
    }).finally(() => {
      playPending = false;
      if (disposed || !desiredPlaying || manuallyPaused) video.pause();
      else if (ready && video.paused && !playbackBlocked && !failed) updatePlayback();
    });
  }
  function fail(error) {
    if (disposed || failed) return;
    failed = true;
    clearTimeout(recoveryTimer); recoveryTimer = undefined;
    if (hls) { const current = hls; hls = undefined; current.destroy(); }
    video.pause();
    send('error', error instanceof Error ? error.message : `Video decoder error ${video.error?.code || 'unknown'}.`);
  }
  function markReady() {
    if (disposed || failed || video.readyState < 2 || !video.videoWidth) return;
    if (!ready) { ready = true; send('media-ready'); }
    updatePlayback();
  }
  video.addEventListener('loadeddata', markReady);
  video.addEventListener('canplay', markReady);
  const videoError = error => { if (!hls) fail(error); };
  video.addEventListener('error', videoError);

  function applySettings(data) {
    manuallyPaused = data.paused === true;
    video.style.objectFit = ['cover', 'contain', 'fill'].includes(data.fit) ? data.fit : 'cover';
    video.style.objectPosition = typeof data.position === 'string' && data.position.length < 80 ? data.position : 'center center';
    video.playbackRate = typeof data.playbackRate === 'number' && Number.isFinite(data.playbackRate) ? Math.max(0.25, Math.min(2, data.playbackRate)) : 1;
    const regions = regionTools?.normalizeRegions(data.regions);
    const active = Boolean(regions?.enabled && regions.items.length);
    video.style.visibility = active ? 'hidden' : '';
    if (active) {
      if (!compositor) {
        regionCanvas = document.createElement('canvas');
        regionCanvas.className = 'frosted-background-canvas';
        Object.assign(regionCanvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
        document.body.appendChild(regionCanvas);
        compositor = regionTools.createCompositor({ source: video, canvas: regionCanvas });
      }
      compositor.update({ ...data, regions });
    } else {
      compositor?.dispose(); compositor = undefined;
      regionCanvas?.remove(); regionCanvas = undefined;
    }
    updatePlayback();
  }

  function streamingURL(value) {
    const normalized = window.FrostedSource?.normalizeRemoteSource({ type: 'hls', kind: 'video', url: value });
    if (!normalized) throw new Error('HTTPS stream validation is unavailable.');
    return normalized.url;
  }

  function initializeStream(url) {
    video.loop = false;
    video.crossOrigin = 'anonymous';
    const Hls = window.Hls;
    if (Hls?.isSupported()) {
      const retry = { maxNumRetry: 2, retryDelayMs: 500, maxRetryDelayMs: 2000 };
      const policy = { default: { maxTimeToFirstByteMs: 10000, maxLoadTimeMs: 20000, timeoutRetry: { ...retry }, errorRetry: { ...retry } } };
      hls = new Hls({
        enableWorker: false, debug: false, enableInterstitialPlayback: false,
        maxBufferLength: 20, maxMaxBufferLength: 60, backBufferLength: 10,
        manifestLoadPolicy: policy, playlistLoadPolicy: policy, fragLoadPolicy: policy,
        xhrSetup(xhr, address) { streamingURL(address); xhr.withCredentials = false; },
        fetchSetup(context, init) { return new Request(streamingURL(context.url), { ...init, credentials: 'omit' }); },
      });
      const player = hls;
      player.on(Hls.Events.MANIFEST_PARSED, () => { if (!disposed && !failed && hls === player) updatePlayback(); });
      player.on(Hls.Events.ERROR, (_event, data) => {
        if (disposed || failed || hls !== player || !data?.fatal || recoveryTimer) return;
        let recover, delay;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < 2) {
          delay = 1000 * 2 ** networkRecoveries++;
          recover = () => { player.loadSource(url); player.startLoad(); };
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 1) {
          delay = 500; recover = () => player.recoverMediaError();
        }
        if (!recover) { fail(new Error('The HLS stream could not be played. Check the link, CORS permissions and supported codecs, then select the stream again.')); return; }
        recoveryTimer = setTimeout(() => {
          recoveryTimer = undefined;
          if (disposed || failed || hls !== player) return;
          try { recover(); } catch { fail(new Error('The HLS stream could not recover. Select the stream again to retry.')); }
        }, delay);
      });
      sourceAssigned = true;
      player.loadSource(url);
      player.attachMedia(video);
      updatePlayback();
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      sourceAssigned = true;
      video.src = url; video.load(); updatePlayback();
    } else throw new Error('This VS Code build does not support HLS playback.');
  }

  async function initialize(data) {
    if (initialized || disposed) return;
    initialized = true;
    try {
      const source = new URL(data.source, location.href);
      const own = new URL(location.href);
      const directory = own.pathname.slice(0, own.pathname.lastIndexOf('/') + 1);
      const basename = source.pathname.slice(source.pathname.lastIndexOf('/') + 1);
      const streaming = data.sourceType === 'hls';
      if (data.sourceType !== undefined && !streaming) throw new Error('Unsupported video source type.');
      const streamURL = streaming ? streamingURL(data.source) : undefined;
      if (!streaming && (source.protocol !== own.protocol || source.host !== own.host || source.username || source.password || source.search || source.hash ||
          source.pathname.slice(0, source.pathname.lastIndexOf('/') + 1) !== directory ||
          !/\/frosted-background-assets\/$/.test(directory) || !/^media-[a-f0-9]{64}\.(mp4|webm)$/.test(basename))) {
        throw new Error('Video source must be an owned cached media asset beside this player.');
      }
      applySettings(data);
      desiredPlaying = data.playing === true;
      if (streaming) { initializeStream(streamURL); return; }
      // VS Code's vscode-file protocol supports fetch but is not registered for
      // streaming media. Decode a local Blob instead of handing that protocol
      // directly to Chromium's video demuxer.
      const response = await fetch(source.href, { signal: controller.signal, credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error(`Could not read cached video (HTTP ${response.status}).`);
      const limit = 500 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > limit) throw new Error('Cached video exceeds 500 MB.');
      const blob = await response.blob();
      if (disposed) return;
      if (!blob.size || blob.size > limit) throw new Error('Cached video is empty or exceeds 500 MB.');
      objectURL = URL.createObjectURL(new Blob([blob], { type: basename.endsWith('.webm') ? 'video/webm' : 'video/mp4' }));
      sourceAssigned = true;
      video.src = objectURL;
      video.load();
      updatePlayback();
    } catch (error) {
      if (!disposed && error.name !== 'AbortError') fail(error);
    }
  }
  function receive(event) {
    if (event.source !== parent || (ownOrigin && event.origin !== ownOrigin)) return;
    const data = event.data;
    if (!data || data.type !== MESSAGE || data.channel !== channel || disposed) return;
    if (data.action === 'initialize') initialize(data);
    else if (data.action === 'settings') applySettings(data);
    else if (data.action === 'playback') {
      desiredPlaying = data.playing === true;
      if (data.retry === true) playbackBlocked = false;
      updatePlayback();
    } else if (data.action === 'dispose') cleanup();
  }
  function cleanup() {
    if (disposed) return;
    disposed = true;
    clearTimeout(recoveryTimer); recoveryTimer = undefined;
    if (hls) { const current = hls; hls = undefined; current.destroy(); }
    compositor?.dispose(); compositor = undefined;
    regionCanvas?.remove(); regionCanvas = undefined;
    controller.abort();
    video.pause();
    video.removeEventListener('loadeddata', markReady);
    video.removeEventListener('canplay', markReady);
    video.removeEventListener('error', videoError);
    video.removeAttribute('src');
    video.load();
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = undefined;
    window.removeEventListener('message', receive);
    window.removeEventListener('pagehide', cleanup);
    if (window.__frostedVideoDispose === disposeFromParent) delete window.__frostedVideoDispose;
  }
  const disposeFromParent = token => { if (token === channel) cleanup(); };
  window.__frostedVideoDispose = disposeFromParent;
  window.addEventListener('message', receive);
  window.addEventListener('pagehide', cleanup, { once: true });
  send('booted');
})();
