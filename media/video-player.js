/* Local, isolated video document. Its CSP allows blob media without changing
   the workbench's Content-Security-Policy. No Node access or remote media. */
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
  let sourceAssigned = false;
  let ready = false;
  let failed = false;
  let playPending = false;
  let playbackBlocked = false;
  let objectURL;
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
    if (!desiredPlaying) { video.pause(); return; }
    if (playPending || playbackBlocked || !video.paused) return;
    playPending = true;
    Promise.resolve(video.play()).catch(error => {
      if (disposed || error.name === 'AbortError') return;
      playbackBlocked = true;
      send('playback-blocked', 'Automatic playback was blocked; click or focus the editor to retry.');
    }).finally(() => {
      playPending = false;
      if (disposed || !desiredPlaying) video.pause();
      else if (ready && video.paused && !playbackBlocked && !failed) updatePlayback();
    });
  }
  function fail(error) {
    if (disposed || failed) return;
    failed = true;
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
  video.addEventListener('error', fail);

  async function initialize(data) {
    if (initialized || disposed) return;
    initialized = true;
    try {
      const source = new URL(data.source, location.href);
      const own = new URL(location.href);
      const directory = own.pathname.slice(0, own.pathname.lastIndexOf('/') + 1);
      const basename = source.pathname.slice(source.pathname.lastIndexOf('/') + 1);
      if (source.protocol !== own.protocol || source.host !== own.host || source.username || source.password || source.search || source.hash ||
          source.pathname.slice(0, source.pathname.lastIndexOf('/') + 1) !== directory ||
          !/\/frosted-background-assets\/$/.test(directory) || !/^media-[a-f0-9]{64}\.(mp4|webm)$/.test(basename)) {
        throw new Error('Video source must be an owned cached media asset beside this player.');
      }
      video.style.objectFit = ['cover', 'contain', 'fill'].includes(data.fit) ? data.fit : 'cover';
      video.style.objectPosition = typeof data.position === 'string' && data.position.length < 80 ? data.position : 'center center';
      video.playbackRate = typeof data.playbackRate === 'number' && Number.isFinite(data.playbackRate) ? Math.max(0.25, Math.min(2, data.playbackRate)) : 1;
      desiredPlaying = data.playing === true;
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
    else if (data.action === 'playback') {
      desiredPlaying = data.playing === true;
      if (data.retry === true) playbackBlocked = false;
      updatePlayback();
    } else if (data.action === 'dispose') cleanup();
  }
  function cleanup() {
    if (disposed) return;
    disposed = true;
    controller.abort();
    video.pause();
    video.removeEventListener('loadeddata', markReady);
    video.removeEventListener('canplay', markReady);
    video.removeEventListener('error', fail);
    video.removeAttribute('src');
    video.load();
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = undefined;
    window.removeEventListener('message', receive);
  }
  window.addEventListener('message', receive);
  window.addEventListener('pagehide', cleanup, { once: true });
  send('booted');
})();
