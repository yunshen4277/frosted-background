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
  if (settings.enabled === false || !settings.source) return;

  let source;
  try {
    source = new URL(settings.source, document.baseURI);
    const origin = new URL(document.baseURI);
    if (source.protocol !== origin.protocol || source.host !== origin.host || source.username || source.password) {
      throw new Error('Only media copied into this VS Code installation is supported.');
    }
  } catch (error) {
    console.warn('[Frosted Background] Invalid local media location.', error);
    return;
  }

  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  const config = {
    kind: settings.kind === 'video' ? 'video' : 'image',
    blur: number(settings.blur, 14, 0, 60),
    opacity: number(settings.opacity, 0.35, 0, 1),
    tintOpacity: number(settings.tintOpacity, 0.18, 0, 1),
    saturation: number(settings.saturation, 1, 0, 3),
    brightness: number(settings.brightness, 1, 0.1, 2),
    playbackRate: number(settings.playbackRate, 1, 0.25, 2),
    fit: settings.fit === 'contain' ? 'contain' : 'cover',
    position: typeof settings.position === 'string' && settings.position.length < 80 ? settings.position : 'center center',
    pauseWhenUnfocused: settings.pauseWhenUnfocused !== false,
    respectReducedMotion: settings.respectReducedMotion !== false,
  };

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

  const listen = (target, name, callback, options) => {
    target.addEventListener(name, callback, options);
    removers.push(() => target.removeEventListener(name, callback, options));
  };

  function mount(host) {
    const layer = document.createElement('div');
    layer.className = 'frosted-background-layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.setAttribute('inert', '');
    const media = document.createElement(config.kind === 'video' ? 'video' : 'img');
    media.className = 'frosted-background-media';
    media.setAttribute('aria-hidden', 'true');
    media.setAttribute('tabindex', '-1');
    const overscan = config.fit === 'cover' ? config.blur * 3 : 0;
    Object.assign(media.style, {
      left: `${-overscan}px`, top: `${-overscan}px`,
      width: `calc(100% + ${overscan * 2}px)`, height: `calc(100% + ${overscan * 2}px)`,
      objectFit: config.fit, objectPosition: config.position,
      filter: `blur(${config.blur}px) saturate(${config.saturation}) brightness(${config.brightness})`,
      opacity: String(config.opacity),
    });
    const tint = document.createElement('div');
    tint.className = 'frosted-background-tint';
    tint.style.opacity = String(config.tintOpacity);
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

    const shouldPlay = () => !stopped && !failed && !document.hidden && inViewport &&
      host.isConnected && host.clientWidth > 0 && host.clientHeight > 0 &&
      (!config.pauseWhenUnfocused || document.hasFocus()) &&
      (!config.respectReducedMotion || !reducedMotion.matches);

    const updatePlayback = () => {
      if (config.kind !== 'video') return;
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
    const onError = () => {
      if (stopped) return;
      failed = true;
      layer.dataset.state = 'error';
      layer.hidden = true;
      host.classList.remove('frosted-background-ready');
      if (config.kind === 'video') media.pause();
      console.warn('[Frosted Background] Media could not be decoded. The normal editor background has been restored.');
    };
    media.addEventListener(config.kind === 'video' ? 'loadeddata' : 'load', onReady);
    media.addEventListener('error', onError);

    if (config.kind === 'video') {
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
    media.src = source.href;

    const resize = new ResizeObserver(updatePlayback);
    resize.observe(host);
    const intersection = new IntersectionObserver(entries => {
      inViewport = entries[0]?.isIntersecting ?? true;
      updatePlayback();
    });
    intersection.observe(host);

    const state = {
      updatePlayback,
      retryPlayback() { playbackBlocked = false; updatePlayback(); },
      dispose() {
        stopped = true;
        resize.disconnect();
        intersection.disconnect();
        media.removeEventListener(config.kind === 'video' ? 'loadeddata' : 'load', onReady);
        media.removeEventListener('error', onError);
        if (config.kind === 'video') {
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
    for (const host of document.querySelectorAll('.part.editor')) {
      if (!hosts.has(host)) mount(host);
    }
  }

  function scheduleReconcile() {
    if (!pendingFrame && !disposed) pendingFrame = requestAnimationFrame(reconcile);
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
    cancelAnimationFrame(pendingFrame);
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
})();
