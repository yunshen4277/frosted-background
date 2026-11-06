/* Frosted Background: runs in the VS Code workbench renderer, without Node access. */
(() => {
  'use strict';

  const script = document.currentScript || document.querySelector('script[data-frosted-config]');
  let settings;
  try {
    settings = JSON.parse(script?.getAttribute('data-frosted-config') || '{}');
  } catch (error) {
    console.warn('[Frosted Background] Invalid background configuration.', error);
    return;
  }

  // Reinstallation must never accumulate observers, video decoders or styles.
  window.__frostedBackgroundCleanup?.();
  const regionTools = window.FrostedRegions;
  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  const normalizeConfig = settings => ({
    kind: settings.kind === 'video' ? 'video' : 'image',
    blur: number(settings.blur, 14, 0, 60),
    opacity: number(settings.opacity, 0.35, 0, 1),
    tintOpacity: number(settings.tintOpacity, 0.18, 0, 1),
    saturation: number(settings.saturation, 1, 0, 3),
    brightness: number(settings.brightness, 1, 0.1, 2),
    playbackRate: number(settings.playbackRate, 1, 0.25, 2),
    fit: ['cover', 'contain', 'fill'].includes(settings.fit) ? settings.fit : 'cover',
    position: typeof settings.position === 'string' && settings.position.length < 80 ? settings.position : 'center center',
    pauseWhenUnfocused: settings.pauseWhenUnfocused !== false,
    respectReducedMotion: settings.respectReducedMotion !== false,
    paused: settings.paused === true,
    sourceType: settings.sourceType === 'hls' ? 'hls' : undefined,
    regions: regionTools?.normalizeRegions(settings.regions) || { enabled: false, items: [] },
  });
  const origin = new URL(document.baseURI);
  const ownedDirectory = new URL('./frosted-background-assets/', origin);
  const ownedState = new URL('live-state.json', ownedDirectory);
  const sameOrigin = url => url.protocol === origin.protocol && url.host === origin.host && !url.username && !url.password;
  let liveState;
  let active;
  function parseSettings(settings, strict = false) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings.');
    if (settings.enabled === false) return { enabled: false };
    if (typeof settings.source !== 'string' || !settings.source || (strict && (settings.enabled !== true || !['image', 'video'].includes(settings.kind)))) throw new Error('Missing media source.');
    const streaming = settings.sourceType === 'hls';
    if (settings.sourceType !== undefined && !streaming) throw new Error('Unsupported background source type.');
    if (streaming && settings.kind !== 'video') throw new Error('HLS sources must be videos.');
    const normalizedStream = streaming ? window.FrostedSource?.normalizeRemoteSource({ type: 'hls', kind: 'video', url: settings.source }) : undefined;
    if (streaming && !normalizedStream) throw new Error('HLS source validation is unavailable.');
    const source = new URL(streaming ? normalizedStream.url : settings.source, origin);
    if (!streaming && !sameOrigin(source)) throw new Error('Only local workbench media is supported.');
    if (!streaming && strict && (source.search || source.hash || source.pathname.slice(0, source.pathname.lastIndexOf('/') + 1) !== ownedDirectory.pathname ||
        !/^media-[a-f0-9]{64}\.(png|jpe?g|gif|webp|bmp|avif|mp4|webm)$/.test(source.pathname.slice(source.pathname.lastIndexOf('/') + 1)) ||
        /\.(mp4|webm)$/.test(source.pathname) !== (settings.kind === 'video'))) throw new Error('Media is not an owned cached asset.');
    let videoPlayer;
    if (settings.kind === 'video' && settings.videoPlayer) {
      videoPlayer = new URL(settings.videoPlayer, origin);
      const directory = streaming ? ownedDirectory.pathname : source.pathname.slice(0, source.pathname.lastIndexOf('/') + 1);
      if (!sameOrigin(videoPlayer) || videoPlayer.search || videoPlayer.hash || (!streaming && (source.search || source.hash)) ||
          !/\/frosted-background-assets\/$/.test(directory) ||
          videoPlayer.pathname.slice(0, videoPlayer.pathname.lastIndexOf('/') + 1) !== directory ||
          !/^video-host-[a-f0-9]{64}\.html$/.test(videoPlayer.pathname.slice(videoPlayer.pathname.lastIndexOf('/') + 1)) ||
          (!streaming && !/^media-[a-f0-9]{64}\.(mp4|webm)$/.test(source.pathname.slice(source.pathname.lastIndexOf('/') + 1)))) throw new Error('Invalid local video player.');
    }
    if ((strict || streaming) && settings.kind === 'video' && !videoPlayer) throw new Error('Missing local video player.');
    if (settings.paused !== undefined && typeof settings.paused !== 'boolean') throw new Error('Invalid manual playback setting.');
    if (strict) {
      if (settings.liveState !== undefined && new URL(settings.liveState, origin).href !== ownedState.href) throw new Error('Live state location cannot change.');
      for (const key of ['blur', 'opacity', 'tintOpacity', 'saturation', 'brightness', 'playbackRate']) {
        if (typeof settings[key] !== 'number' || !Number.isFinite(settings[key])) throw new Error('Invalid numeric setting.');
      }
      if (!['cover', 'contain', 'fill'].includes(settings.fit) || !['center center', 'center top', 'center bottom', 'left center', 'right center'].includes(settings.position) ||
          typeof settings.pauseWhenUnfocused !== 'boolean' || typeof settings.respectReducedMotion !== 'boolean') throw new Error('Invalid layout or playback setting.');
    }
    return { enabled: true, source, videoPlayer, config: normalizeConfig(settings) };
  }
  try {
    if (settings.liveState !== undefined) {
      const location = new URL(settings.liveState, origin);
      if (location.href !== ownedState.href) throw new Error('Invalid live state location.');
      liveState = location;
    }
    active = parseSettings(settings, Boolean(liveState));
  } catch (error) {
    console.warn('[Frosted Background] Invalid local background configuration.', error);
    return;
  }
  if (!active.enabled && !liveState) return;

  const style = document.createElement('style');
  style.id = 'frosted-background-style';
  style.textContent = `
    .part.editor.frosted-background-host { isolation: isolate; }
    .frosted-background-layer {
      position: absolute; inset: 0; z-index: -1;
      overflow: hidden; pointer-events: none !important; user-select: none;
      border-radius: inherit; contain: layout paint; background: var(--vscode-editor-background, #1e1e1e);
    }
    .frosted-background-layer > .frosted-background-media {
      position: absolute; display: block; max-width: none; max-height: none;
      pointer-events: none !important; user-select: none;
    }
    .frosted-background-tint {
      position: absolute; inset: 0; pointer-events: none !important;
      background: var(--vscode-editor-background, #1e1e1e);
    }
    .part.editor.frosted-background-ready > .content,
    .part.editor.frosted-background-ready .editor-group-container,
    .part.editor.frosted-background-ready .editor-container,
    .part.editor.frosted-background-ready .editor-instance,
    .part.editor.frosted-background-ready .monaco-editor,
    .part.editor.frosted-background-ready .monaco-editor .monaco-editor-background,
    .part.editor.frosted-background-ready .monaco-editor .margin {
      background-color: transparent !important;
    }
    /* Sticky Scroll sits above moving code. A transparent fill alone would
       superimpose two rows of text; blur only the backdrop, never the pinned row. */
    .part.editor.frosted-background-ready .monaco-editor .sticky-widget {
      background-color: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 35%, transparent) !important;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      box-shadow: none !important;
    }
    .part.editor.frosted-background-ready .monaco-editor .sticky-widget .sticky-widget-line-numbers,
    .part.editor.frosted-background-ready .monaco-editor .sticky-widget .sticky-widget-line-number,
    .part.editor.frosted-background-ready .monaco-editor .sticky-widget .sticky-widget-lines-scrollable,
    .part.editor.frosted-background-ready .monaco-editor .sticky-widget .sticky-widget-lines,
    .part.editor.frosted-background-ready .monaco-editor .sticky-widget .sticky-widget-line,
    .part.editor.frosted-background-ready .monaco-editor .sticky-widget .sticky-line-number,
    .part.editor.frosted-background-ready .monaco-editor .sticky-widget .sticky-line-content {
      background-color: transparent !important;
    }
    .part.editor.frosted-background-ready .monaco-editor .sticky-widget .sticky-line-content:hover,
    .part.editor.frosted-background-ready .monaco-editor .sticky-widget .sticky-widget-line:hover {
      background-color: color-mix(in srgb, var(--vscode-editorStickyScrollHover-background, var(--vscode-editor-background, #1e1e1e)) 35%, transparent) !important;
    }
    .part.editor.frosted-background-ready .monaco-editor .scroll-decoration {
      box-shadow: none !important;
    }
    /* Embedded editors inside opaque tools retain the tool's readable surface. */
    .part.editor.frosted-background-ready .monaco-editor .peekview-widget .monaco-editor,
    .part.editor.frosted-background-ready .monaco-editor .peekview-widget .monaco-editor-background,
    .part.editor.frosted-background-ready .monaco-editor .peekview-widget .margin {
      background-color: var(--vscode-peekViewEditor-background, var(--vscode-editor-background)) !important;
    }
  `;
  document.head.appendChild(style);

  const hosts = new Map();
  const removers = [];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let disposed = false;
  let pendingFrame = 0;
  let pollTimer;
  let pollRequest;
  let revision;
  let pollSequence = 0;
  let themeFrame = 0;

  const listen = (target, name, callback, options) => {
    target.addEventListener(name, callback, options);
    removers.push(() => target.removeEventListener(name, callback, options));
  };

  function mount(host) {
    const { source, videoPlayer } = active;
    let config = active.config;
    let compositor;
    let regionCanvas;
    const hasRegions = () => Boolean(regionTools && config.regions.enabled && config.regions.items.length);
    const tintColor = () => getComputedStyle(tint).backgroundColor || '#1e1e1e';
    const layer = document.createElement('div');
    layer.className = 'frosted-background-layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.setAttribute('inert', '');
    const framedVideo = config.kind === 'video' && Boolean(videoPlayer);
    const media = document.createElement(framedVideo ? 'iframe' : config.kind === 'video' ? 'video' : 'img');
    media.className = 'frosted-background-media';
    media.setAttribute('aria-hidden', 'true');
    media.setAttribute('tabindex', '-1');
    const tint = document.createElement('div');
    tint.className = 'frosted-background-tint';
    function applyMediaStyles() {
      const regional = hasRegions();
      const overscan = !regional && config.fit === 'cover' ? config.blur * 3 : 0;
      Object.assign(media.style, {
        left: `${-overscan}px`, top: `${-overscan}px`,
        width: `calc(100% + ${overscan * 2}px)`, height: `calc(100% + ${overscan * 2}px)`,
        objectFit: config.fit, objectPosition: config.position,
        filter: regional ? 'none' : `blur(${config.blur}px) saturate(${config.saturation}) brightness(${config.brightness})`,
        opacity: regional ? '1' : String(config.opacity), border: '0',
        visibility: regional && !framedVideo ? 'hidden' : '',
      });
      tint.style.opacity = regional ? '0' : String(config.tintOpacity);
    }
    function updateImageRegions() {
      if (framedVideo) return;
      if (hasRegions()) {
        if (!compositor) {
          regionCanvas = document.createElement('canvas');
          regionCanvas.className = 'frosted-background-canvas';
          Object.assign(regionCanvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
          layer.insertBefore(regionCanvas, tint);
          compositor = regionTools.createCompositor({ source: media, canvas: regionCanvas });
        }
        compositor.update({ ...config, tintColor: tintColor() });
      } else {
        compositor?.dispose(); compositor = undefined;
        regionCanvas?.remove(); regionCanvas = undefined;
      }
    }
    applyMediaStyles();
    layer.append(media, tint);

    const initialPosition = host.style.getPropertyValue('position');
    const initialPositionPriority = host.style.getPropertyPriority('position');
    const needsPosition = getComputedStyle(host).position === 'static';
    if (needsPosition) host.style.setProperty('position', 'relative');
    host.classList.add('frosted-background-host');
    host.prepend(layer);

    let failed = false;
    let ready = false;
    let inViewport = true;
    let playPending = false;
    let playbackBlocked = false;
    let stopped = false;
    let playerBooted = false;
    const channel = framedVideo ? crypto.randomUUID() : undefined;
    const playerOrigin = framedVideo && /^https?:$/.test(videoPlayer.protocol) ? videoPlayer.origin : undefined;
    const targetOrigin = playerOrigin || '*';
    const postPlayer = data => media.contentWindow?.postMessage({ type: 'frosted-background-player', channel, ...data }, targetOrigin);

    const shouldPlay = () => !stopped && !failed && !config.paused && !document.hidden && inViewport &&
      host.isConnected && host.clientWidth > 0 && host.clientHeight > 0 &&
      (!config.pauseWhenUnfocused || document.hasFocus()) &&
      (!config.respectReducedMotion || !reducedMotion.matches);

    const updatePlayback = () => {
      if (config.kind !== 'video') return;
      if (framedVideo) {
        if (playerBooted && !stopped) postPlayer({ action: 'playback', playing: shouldPlay() });
        return;
      }
      if (!shouldPlay()) {
        media.pause();
        return;
      }
      if (!media.paused || playPending || playbackBlocked) return;
      playPending = true;
      Promise.resolve(media.play()).catch(error => {
        if (stopped || error.name === 'AbortError') return;
        playbackBlocked = true;
        console.warn('[Frosted Background] Video could not start; keeping its still frame.', error);
      }).finally(() => {
        playPending = false;
        // A focus/visibility change may have happened while play() was pending.
        if (!shouldPlay()) media.pause();
      });
    };

    const onReady = () => {
      if (stopped || failed) return;
      ready = true;
      layer.dataset.state = 'ready';
      host.classList.add('frosted-background-ready');
      updatePlayback();
    };
    const onError = (error, diagnostic) => {
      if (stopped) return;
      failed = true;
      layer.dataset.state = 'error';
      layer.hidden = true;
      host.classList.remove('frosted-background-ready');
      if (framedVideo) postPlayer({ action: 'playback', playing: false });
      else if (config.kind === 'video') media.pause();
      const safe = diagnostic && typeof diagnostic === 'object' ? {
        stage: ['read', 'decode', 'compatibility'].includes(diagnostic.stage) ? diagnostic.stage : 'decode',
        sourceType: ['local', 'webm', 'mp4', 'hls'].includes(diagnostic.sourceType) ? diagnostic.sourceType : 'local',
        code: [1, 2, 3, 4].includes(diagnostic.code) ? diagnostic.code : undefined,
        readyState: Number.isInteger(diagnostic.readyState) && diagnostic.readyState >= 0 && diagnostic.readyState <= 4 ? diagnostic.readyState : undefined,
        networkState: Number.isInteger(diagnostic.networkState) && diagnostic.networkState >= 0 && diagnostic.networkState <= 3 ? diagnostic.networkState : undefined,
        reason: /^WEBM_(READ|FORMAT|UNSUPPORTED|DECODE|LIMIT|TIMEOUT)$/.test(diagnostic.reason || '') ? diagnostic.reason : undefined,
      } : undefined;
      console.warn('[Frosted Background] Media could not be decoded. The normal editor background has been restored.', typeof error === 'string' ? error : 'Media load failed.', safe || '');
    };
    const initializePlayer = () => {
      if (stopped || failed) return;
      playerBooted = true;
      postPlayer({ action: 'initialize', source: source.href, ...config, tintColor: tintColor(), playing: shouldPlay() });
      updatePlayback();
    };
    const receivePlayer = event => {
      if (event.source !== media.contentWindow || (playerOrigin && event.origin !== playerOrigin)) return;
      const data = event.data;
      if (!data || data.type !== 'frosted-background-player' || data.channel !== channel || stopped) return;
      if (data.event === 'booted') initializePlayer();
      else if (data.event === 'media-ready') onReady();
      else if (data.event === 'error') onError(typeof data.detail === 'string' ? data.detail.slice(0, 300) : 'Player load failed.', data.diagnostic);
      else if (data.event === 'playback-blocked') console.warn('[Frosted Background] Video playback is paused; focus or click the editor to retry.');
    };
    if (framedVideo) {
      window.addEventListener('message', receivePlayer);
      media.addEventListener('load', initializePlayer);
    } else {
      media.addEventListener(config.kind === 'video' ? 'loadeddata' : 'load', onReady);
      media.addEventListener('error', onError);
    }

    if (framedVideo) {
      media.title = '毛玻璃背景视频';
      media.setAttribute('allow', 'autoplay');
      media.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      const location = new URL(videoPlayer.href);
      if (globalThis.crossOriginIsolated === true) location.searchParams.set('vscode-coi', '3');
      location.hash = new URLSearchParams({ 'frosted-channel': channel }).toString();
      media.src = location.href;
    } else if (config.kind === 'video') {
      media.muted = true;
      media.defaultMuted = true;
      media.loop = true;
      media.playsInline = true;
      media.preload = 'auto';
      media.controls = false;
      media.setAttribute('muted', '');
      media.setAttribute('playsinline', '');
      media.playbackRate = config.playbackRate;
    } else {
      media.alt = '';
      media.draggable = false;
      media.decoding = 'async';
    }
    if (!framedVideo) media.src = source.href;
    updateImageRegions();

    // Complete compression must fit the pixels the user can actually see.
    // The workbench part also includes opaque tabs/breadcrumbs, and Monaco's
    // scrollable element includes a right minimap; neither is the code viewport.
    let geometryFrame = 0;
    const geometryNodes = new Set();
    const layoutSelector = '.editor-group-container, .editor-container, .monaco-editor, .minimap, .scrollbar, .title, .breadcrumbs-control, .monaco-grid-view, .monaco-grid-branch-node, .monaco-grid-leaf-node';
    function updateFillBounds() {
      geometryFrame = 0;
      if (stopped || config.fit !== 'fill') return;
      const hostRect = host.getBoundingClientRect();
      const rectangles = [];
      const observed = new Set();
      const addRectangle = (element, container) => {
        const raw = element.getBoundingClientRect();
        const enclosing = container.getBoundingClientRect();
        if (!raw.width || !raw.height || getComputedStyle(element).visibility === 'hidden') return;
        let left = Math.max(raw.left, enclosing.left, hostRect.left);
        let top = Math.max(raw.top, enclosing.top, hostRect.top);
        let right = Math.min(raw.right, enclosing.right, hostRect.right);
        let bottom = Math.min(raw.bottom, enclosing.bottom, hostRect.bottom);
        observed.add(element);
        if (element.matches('.monaco-editor')) {
          for (const obstacle of element.querySelectorAll('.minimap, .scrollbar.vertical, .scrollbar.horizontal')) {
            if (obstacle.closest('.monaco-editor') !== element) continue;
            // Suggest/hover widgets have their own scrollbars inside the same
            // Monaco editor. Only the editor's primary scrollbars bound it.
            if (obstacle.matches('.scrollbar') && !obstacle.parentElement?.matches('.editor-scrollable')) continue;
            observed.add(obstacle);
            const box = obstacle.getBoundingClientRect();
            if (!box.width || !box.height || box.bottom <= top || box.top >= bottom || box.right <= left || box.left >= right) continue;
            if (obstacle.matches('.scrollbar.horizontal')) {
              if (box.top >= (top + bottom) / 2) bottom = Math.min(bottom, box.top);
            } else if (box.left <= raw.left + 1) left = Math.max(left, box.right);
            else right = Math.min(right, box.left);
          }
        }
        if (right > left && bottom > top) rectangles.push({ left, top, right, bottom });
      };
      for (const container of host.querySelectorAll('.editor-group-container > .editor-container')) {
        if (container.closest('.part.editor') !== host) continue;
        observed.add(container);
        // Ignore peek/embedded editors: their layout must not move the wallpaper.
        const editors = [...container.querySelectorAll('.monaco-editor')].filter(editor => {
          const outer = editor.parentElement?.closest('.monaco-editor');
          return !outer || !container.contains(outer);
        });
        if (editors.length) editors.forEach(editor => addRectangle(editor, container));
        else addRectangle(container, container);
      }
      for (const element of geometryNodes) if (!observed.has(element)) { resize.unobserve(element); geometryNodes.delete(element); }
      for (const element of observed) if (!geometryNodes.has(element)) { resize.observe(element); geometryNodes.add(element); }
      if (!rectangles.length || !hostRect.width || !hostRect.height) {
        layer.style.inset = '0';
        return;
      }
      const scaleX = host.offsetWidth ? hostRect.width / host.offsetWidth : 1;
      const scaleY = host.offsetHeight ? hostRect.height / host.offsetHeight : 1;
      const left = Math.max(0, (Math.min(...rectangles.map(box => box.left)) - hostRect.left) / scaleX - host.clientLeft);
      const top = Math.max(0, (Math.min(...rectangles.map(box => box.top)) - hostRect.top) / scaleY - host.clientTop);
      const right = Math.max(0, host.clientWidth - (Math.max(...rectangles.map(box => box.right)) - hostRect.left) / scaleX + host.clientLeft);
      const bottom = Math.max(0, host.clientHeight - (Math.max(...rectangles.map(box => box.bottom)) - hostRect.top) / scaleY + host.clientTop);
      const inset = `${top}px ${right}px ${bottom}px ${left}px`;
      if (layer.style.inset !== inset) layer.style.inset = inset;
    }
    function scheduleGeometry() {
      if (!stopped && config.fit === 'fill' && !geometryFrame) geometryFrame = requestAnimationFrame(updateFillBounds);
    }
    const resize = new ResizeObserver(() => { scheduleGeometry(); updatePlayback(); });
    resize.observe(host);
    const layoutObserver = new MutationObserver(records => {
      if (records.some(record => record.target.matches?.(layoutSelector) ||
        [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches(layoutSelector) || node.querySelector(layoutSelector))))) scheduleGeometry();
    });
    const observeLayout = () => {
      cancelAnimationFrame(geometryFrame);
      layoutObserver.disconnect();
      if (config.fit === 'fill') layoutObserver.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      else {
        for (const element of geometryNodes) resize.unobserve(element);
        geometryNodes.clear();
        layer.style.inset = '0';
      }
      updateFillBounds();
    };
    observeLayout();
    const intersection = new IntersectionObserver(entries => {
      inViewport = entries[0]?.isIntersecting ?? true;
      updatePlayback();
    });
    intersection.observe(host);

    const state = {
      get failed() { return failed; },
      updatePlayback,
      updateSettings(next) {
        config = next;
        applyMediaStyles();
        observeLayout();
        updateImageRegions();
        if (framedVideo && playerBooted) postPlayer({ action: 'settings', ...config, tintColor: tintColor() });
        else if (config.kind === 'video' && !framedVideo) media.playbackRate = config.playbackRate;
        updatePlayback();
      },
      updateTheme() {
        if (!hasRegions()) return;
        updateImageRegions();
        if (framedVideo && playerBooted) postPlayer({ action: 'settings', ...config, tintColor: tintColor() });
      },
      retryPlayback() {
        playbackBlocked = false;
        if (framedVideo && playerBooted && !stopped) postPlayer({ action: 'playback', playing: shouldPlay(), retry: true });
        else updatePlayback();
      },
      dispose() {
        stopped = true;
        compositor?.dispose();
        cancelAnimationFrame(geometryFrame);
        layoutObserver?.disconnect();
        resize.disconnect();
        intersection.disconnect();
        media.removeEventListener(config.kind === 'video' ? 'loadeddata' : 'load', onReady);
        media.removeEventListener('error', onError);
        if (framedVideo) {
          // Same-origin teardown is synchronous: removing an iframe immediately
          // after postMessage need not deliver that message before destruction.
          try { media.contentWindow?.__frostedVideoDispose?.(channel); } catch { /* A still-loading frame is released when removed. */ }
          postPlayer({ action: 'dispose' });
          window.removeEventListener('message', receivePlayer);
          media.removeEventListener('load', initializePlayer);
        } else if (config.kind === 'video') {
          media.pause();
          media.removeAttribute('src');
          media.load();
        }
        layer.remove();
        host.classList.remove('frosted-background-host', 'frosted-background-ready');
        if (needsPosition && host.style.getPropertyValue('position') === 'relative') {
          if (initialPosition) host.style.setProperty('position', initialPosition, initialPositionPriority);
          else host.style.removeProperty('position');
        }
      },
    };
    hosts.set(host, state);
    if (config.kind === 'image' && media.complete && media.naturalWidth > 0 && !ready) onReady();
  }

  function reconcile() {
    pendingFrame = 0;
    if (disposed) return;
    for (const [host, state] of hosts) {
      if (!host.isConnected || !host.matches('.part.editor')) {
        state.dispose();
        hosts.delete(host);
      }
    }
    if (!active.enabled) return;
    for (const host of document.querySelectorAll('.part.editor')) {
      if (!hosts.has(host)) mount(host);
    }
  }

  function scheduleReconcile() {
    if (!pendingFrame && !disposed) pendingFrame = requestAnimationFrame(reconcile);
  }

  function applySettings(next) {
    const sameMedia = active.enabled && next.enabled && active.source.href === next.source.href &&
      active.videoPlayer?.href === next.videoPlayer?.href && active.config.kind === next.config.kind && active.config.sourceType === next.config.sourceType;
    active = next;
    if (sameMedia) {
      for (const [host, state] of hosts) {
        // This path runs only for a new valid publication, never for repeated
        // polls. Explicit Apply can retry a failed stream without replacing a
        // healthy decoder or resetting its playback position.
        if (state.failed) { state.dispose(); hosts.delete(host); }
        else state.updateSettings(next.config);
      }
      reconcile();
    } else {
      for (const state of hosts.values()) state.dispose();
      hosts.clear();
      reconcile();
    }
  }

  async function readState(response) {
    const limit = 64 * 1024;
    if (!response.ok || Number(response.headers.get('content-length')) > limit) throw new Error('Invalid live state response.');
    // Enforce the limit while streaming too; a missing Content-Length must not
    // allow an accidental large local file to be buffered without a bound.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing live state body.');
    const decoder = new TextDecoder();
    let length = 0;
    let text = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) { await reader.cancel(); throw new Error('Live state exceeds its size limit.'); }
        text += decoder.decode(value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } finally { reader.releaseLock(); }
  }

  async function poll() {
    if (disposed || !liveState) return;
    const request = new AbortController();
    pollRequest = request;
    const timeout = setTimeout(() => request.abort(), 5000);
    try {
      const url = new URL(liveState.href);
      url.searchParams.set('frosted-poll', `${Date.now()}-${++pollSequence}`);
      const response = await fetch(url.href, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: request.signal });
      const envelope = await readState(response);
      if (disposed || request.signal.aborted) return;
      if (!envelope || envelope.protocol !== 1 || typeof envelope.revision !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(envelope.revision)) throw new Error('Invalid live state envelope.');
      if (envelope.revision !== revision) {
        const next = parseSettings(envelope.settings, true);
        applySettings(next);
        revision = envelope.revision;
      }
    } catch {
      // Stop any unread oversized response too. An atomic replacement,
      // transient read or invalid file keeps the previous background.
      request.abort();
    }
    finally {
      clearTimeout(timeout);
      pollRequest = undefined;
      if (!disposed) pollTimer = setTimeout(poll, 500);
    }
  }

  // Changes to editor lines are frequent. Ignore mutations inside existing hosts
  // and only rescan for newly attached editor parts or detached hosts.
  const observer = new MutationObserver(records => {
    if ([...hosts.keys()].some(host => !host.isConnected)) {
      scheduleReconcile();
      return;
    }
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1 || node.closest('.frosted-background-host')) continue;
        if (node.matches('.part.editor') || node.querySelector('.part.editor')) {
          scheduleReconcile();
          return;
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const themeObserver = new MutationObserver(() => {
    if (!themeFrame && !disposed) themeFrame = requestAnimationFrame(() => {
      themeFrame = 0;
      for (const state of hosts.values()) state.updateTheme();
    });
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  if (document.body) themeObserver.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });
  themeObserver.observe(document.head, { childList: true, subtree: true, characterData: true });

  const updateAll = () => { for (const state of hosts.values()) state.updatePlayback(); };
  const retryAll = () => { for (const state of hosts.values()) state.retryPlayback(); };
  listen(document, 'visibilitychange', updateAll);
  listen(window, 'blur', updateAll);
  listen(window, 'focus', retryAll);
  listen(reducedMotion, 'change', updateAll);
  listen(document, 'pointerdown', retryAll, { passive: true });

  function cleanup() {
    if (disposed) return;
    disposed = true;
    clearTimeout(pollTimer);
    pollRequest?.abort();
    cancelAnimationFrame(pendingFrame);
    cancelAnimationFrame(themeFrame);
    themeObserver.disconnect();
    observer.disconnect();
    for (const remove of removers) remove();
    for (const state of hosts.values()) state.dispose();
    hosts.clear();
    style.remove();
    if (window.__frostedBackgroundCleanup === cleanup) delete window.__frostedBackgroundCleanup;
  }
  window.__frostedBackgroundCleanup = cleanup;
  listen(window, 'pagehide', cleanup, { once: true });
  reconcile();
  if (liveState) pollTimer = setTimeout(poll, 500);
})();
