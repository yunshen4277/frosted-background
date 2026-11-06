/* Isolated local video document. Blob media and WebM compatibility playback
   preserve the workbench CSP. No Node access or remote media loading. */
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
  let webmFallback;
  let recoveringWebm = false;
  let sourceKind = 'local';
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

  const playerError = message => Object.assign(new Error(message), { frostedSafe: true });
  function send(event, detail, diagnostic) {
    if (!disposed) parent.postMessage({ type: MESSAGE, channel, event, detail, ...(diagnostic ? { diagnostic } : {}) }, targetOrigin);
  }
  function updatePlayback() {
    if (disposed || failed || !sourceAssigned || recoveringWebm) return;
    if (!desiredPlaying || manuallyPaused) { video.pause(); return; }
    if (playPending || playbackBlocked || !video.paused) return;
    playPending = true;
    Promise.resolve(video.play()).catch(error => {
      if (disposed || error.name === 'AbortError') return;
      if (recoveringWebm || retryWebm(video.error)) return;
      playbackBlocked = true;
      send('playback-blocked', 'Automatic playback was blocked; click or focus the editor to retry.');
    }).finally(() => {
      playPending = false;
      if (disposed || !desiredPlaying || manuallyPaused) video.pause();
      else if (ready && video.paused && !playbackBlocked && !failed) updatePlayback();
    });
  }
  function fail(error, stage = 'decode', reason) {
    if (disposed || failed) return;
    failed = true;
    const code = [1, 2, 3, 4].includes(video.error?.code) ? video.error.code : undefined;
    const diagnostic = { stage, sourceType: sourceKind, code, readyState: video.readyState, networkState: video.networkState,
      ...(/^WEBM_(READ|FORMAT|UNSUPPORTED|DECODE|LIMIT|TIMEOUT)$/.test(reason || '') ? { reason } : {}) };
    webmFallback?.dispose(); webmFallback = undefined; recoveringWebm = false;
    video.pause();
    // Only our fixed messages cross the frame boundary; native errors can
    // contain a local path, signed URL or platform-specific resource detail.
    send('error', error?.frostedSafe === true ? error.message : code ? `Video decoder error ${code}.` : 'The video could not be loaded.', diagnostic);
  }
  function markReady() {
    if (disposed || failed || recoveringWebm || video.readyState < 2 || !video.videoWidth) return;
    if (!ready) { ready = true; send('media-ready'); }
    updatePlayback();
  }
  video.addEventListener('loadeddata', markReady);
  video.addEventListener('canplay', markReady);
  function retryWebm(error) {
    // The helper stays active throughout MSE playback. A later autoplay-policy
    // rejection has no decoder error and must not restart the recovery gate.
    if (error?.code !== 4 || disposed || failed || !webmFallback || !webmFallback.retry(error)) return false;
    recoveringWebm = true; playbackBlocked = false; ready = false;
    if (objectURL) { URL.revokeObjectURL(objectURL); objectURL = undefined; }
    return true;
  }
  const videoError = error => { if (!recoveringWebm && !retryWebm(video.error)) fail(error); };
  video.addEventListener('error', videoError);

  function applySettings(data) {
    manuallyPaused = data.paused === true;
    video.style.objectFit = ['cover', 'contain', 'fill'].includes(data.fit) ? data.fit : 'cover';
    video.style.objectPosition = typeof data.position === 'string' && data.position.length < 80 ? data.position : 'center center';
    video.playbackRate = typeof data.playbackRate === 'number' && Number.isFinite(data.playbackRate) ? Math.max(0.25, Math.min(2, data.playbackRate)) : 1;
    updatePlayback();
  }

  async function initialize(data) {
    if (initialized || disposed) return;
    initialized = true;
    try {
      const source = new URL(data.source, location.href);
      const own = new URL(location.href);
      const directory = own.pathname.slice(0, own.pathname.lastIndexOf('/') + 1);
      const basename = source.pathname.slice(source.pathname.lastIndexOf('/') + 1);
      sourceKind = basename.endsWith('.webm') ? 'webm' : 'mp4';
      if (data.sourceType !== undefined) throw playerError('Only local video files are supported.');
      if (source.protocol !== own.protocol || source.host !== own.host || source.username || source.password || source.search || source.hash ||
          source.pathname.slice(0, source.pathname.lastIndexOf('/') + 1) !== directory ||
          !/\/frosted-background-assets\/$/.test(directory) || !/^media-[a-f0-9]{64}\.(mp4|webm)$/.test(basename)) {
        throw playerError('Video source must be an owned cached media asset beside this player.');
      }
      applySettings(data);
      desiredPlaying = data.playing === true;
      // VS Code's vscode-file protocol supports fetch but is not registered for
      // streaming media. Decode a local Blob instead of handing that protocol
      // directly to Chromium's video demuxer.
      const response = await fetch(source.href, { signal: controller.signal, credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw playerError(`Could not read cached video (HTTP ${response.status}).`);
      const limit = 500 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > limit) throw playerError('Cached video exceeds 500 MB.');
      const blob = await response.blob();
      if (disposed) return;
      if (!blob.size || blob.size > limit) throw playerError('Cached video is empty or exceeds 500 MB.');
      if (basename.endsWith('.webm') && window.FrostedWebm) {
        webmFallback = window.FrostedWebm.createFallback({
          video,
          // Reuse the bytes already fetched. No second local read or remote
          // request is needed when this VS Code build lacks WebM demuxing.
          load: async signal => {
            if (disposed || signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const bytes = new Uint8Array(await blob.arrayBuffer());
            if (disposed || signal.aborted) throw new DOMException('Aborted', 'AbortError');
            return bytes;
          },
          onReady: () => {
            if (disposed || failed) return;
            recoveringWebm = false; playbackBlocked = false;
            markReady(); updatePlayback();
          },
          onError: error => fail(playerError('The cached WebM could not be played using the compatibility decoder.'), 'compatibility', error?.code),
        });
      }
      objectURL = URL.createObjectURL(new Blob([blob], { type: basename.endsWith('.webm') ? 'video/webm' : 'video/mp4' }));
      sourceAssigned = true;
      video.src = objectURL;
      video.load();
      updatePlayback();
    } catch (error) {
      if (!disposed && error.name !== 'AbortError') fail(error, 'read');
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
    webmFallback?.dispose(); webmFallback = undefined; recoveringWebm = false;
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
