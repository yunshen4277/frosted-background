'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

// Optional integration suite: PLAYWRIGHT_MODULE=/path/to/playwright node --test test/renderer.browser.test.js
// No Playwright dependency is shipped in the extension.
test('renderer fits the editor, preserves interaction and manages image/video lifetime', {
  skip: !process.env.PLAYWRIGHT_MODULE,
  timeout: 60000,
}, async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const executablePath = process.env.BROWSER_EXECUTABLE || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(value => fs.existsSync(value));
  const renderer = fs.readFileSync(path.join(__dirname, '../media/renderer.js'));
  const playerScript = fs.readFileSync(path.join(__dirname, '../media/video-player.js'));
  const mediaName = `media-${'a'.repeat(64)}.webm`;
  const playerName = `video-host-${'b'.repeat(64)}.html`;
  const playerHtml = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; connect-src \'self\'; media-src blob:; style-src \'unsafe-inline\';"><body><script src="./video-player.js" defer></script></body>';
  const escapeAttribute = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  function fixture(url) {
    const params = new URL(url, 'http://localhost').searchParams;
    const config = {
      enabled: true, kind: params.get('kind') || 'image',
      source: params.get('source') || './wallpaper.png', fit: params.get('fit') || 'cover',
      opacity: 0.7, blur: params.has('blur') ? Number(params.get('blur')) : 10, tintOpacity: 0.15,
      pauseWhenUnfocused: true, respectReducedMotion: true,
    };
    if (params.has('player')) {
      config.source = `./frosted-background-assets/${mediaName}`;
      config.videoPlayer = `./frosted-background-assets/${playerName}`;
    }
    const csp = params.has('player') ? '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src \'self\'; media-src \'self\'; frame-src \'self\'; connect-src \'self\';">' : '';
    return `<!doctype html><html><head><meta charset="utf-8">${csp}<style>
      :root {
        --vscode-editor-background: #161c2a; --vscode-editor-foreground: #e7edf8;
        --vscode-editorStickyScroll-background: #000; --vscode-editorStickyScrollGutter-background: #000;
        --vscode-editorStickyScrollHover-background: #222; --vscode-editorStickyScroll-shadow: #000;
        --vscode-editorLineNumber-foreground: #9ca9bd; --vscode-scrollbar-shadow: #000;
      } * { box-sizing: border-box; }
      body { margin:0; font:15px monospace; background:#101520;color:var(--vscode-editor-foreground); }
      aside { position:absolute;width:180px;top:0;bottom:0;padding:20px;background:#151b28; }
      .part.editor { position:absolute;left:180px;right:0;top:32px;bottom:24px;background:var(--vscode-editor-background); }
      .content { display:flex;width:100%;height:100%;background:var(--vscode-editor-background); }
      .editor-group-container { flex:1;min-width:0;background:var(--vscode-editor-background);border-right:1px solid #ffffff30; }
      .title { height:34px;padding:8px;background:#1b2332; }
      .editor-container,.editor-instance,.monaco-editor { height:calc(100% - 34px);background:var(--vscode-editor-background); }
      .monaco-editor { display:flex;height:100%;padding:15px 0;position:relative; }
      .margin { width:42px;text-align:center;color:#a5b4c8; }
      .monaco-editor-background { flex:1;background:var(--vscode-editor-background); }
      textarea { width:100%;height:100%;resize:none;color:#e7edf8;outline:none;border:0;background:transparent;font:15px/1.7 monospace; }
      header { padding:8px 200px;font-size:12px; }
      .test-scroll-region { position:absolute;inset:0;overflow:auto; }
      .view-lines { min-height:1600px;padding-left:42px; }
      .view-line { height:26px;line-height:26px;white-space:nowrap; }
      /* Actual VS Code 1.144 Sticky Scroll selectors/fills, plus fixture layout. */
      .monaco-editor .sticky-widget { display:none;position:absolute;top:0;height:26px;overflow:hidden;border-bottom:1px solid var(--vscode-editorStickyScroll-border);width:100%;box-shadow:var(--vscode-editorStickyScroll-shadow) 0 4px 2px -2px;z-index:4;right:initial!important; }
      .monaco-editor .sticky-widget .sticky-widget-line-numbers { float:left;background-color:var(--vscode-editorStickyScrollGutter-background);width:42px;height:26px; }
      .monaco-editor .sticky-widget .sticky-widget-lines-scrollable { display:inline-block;position:absolute;overflow:hidden;width:var(--vscode-editorStickyScroll-scrollableWidth);background-color:var(--vscode-editorStickyScroll-background);left:42px;height:26px; }
      .monaco-editor .sticky-widget .sticky-widget-lines { position:absolute;background-color:inherit;width:100%;height:26px; }
      .monaco-editor .sticky-widget .sticky-line-number,.monaco-editor .sticky-widget .sticky-line-content { color:var(--vscode-editorLineNumber-foreground);white-space:nowrap;display:inline-block;position:absolute;background-color:inherit;line-height:26px; }
      .monaco-editor .sticky-widget .sticky-line-content { width:var(--vscode-editorStickyScroll-scrollableWidth);background-color:inherit;white-space:nowrap;color:var(--vscode-editor-foreground); }
      .monaco-editor .sticky-widget .sticky-line-content:hover { background-color:var(--vscode-editorStickyScrollHover-background);cursor:pointer; }
      .monaco-editor .scroll-decoration { display:none;position:absolute;top:0;left:0;height:6px;width:100%;box-shadow:var(--vscode-scrollbar-shadow) 0 6px 6px -6px inset;z-index:5;pointer-events:none; }
      .monaco-editor.is-scrolled .sticky-widget,.monaco-editor.is-scrolled .scroll-decoration { display:block; }
    </style></head><body><header>Frosted Background / renderer integration fixture</header><aside>EXPLORER<br><br>src<br>  app.js<br>  theme.css</aside><div class="monaco-workbench"><main class="part editor"><div class="content">${group('app.js', params.has('sticky'))}${group('theme.css', params.has('sticky'))}</div></main></div><script>document.querySelectorAll('.test-scroll-region').forEach(region => region.addEventListener('scroll', () => region.closest('.monaco-editor').classList.toggle('is-scrolled', region.scrollTop > 0)));</script><script src="./renderer.js" data-frosted-config="${escapeAttribute(JSON.stringify(config))}"></script></body></html>`;
  }
  function group(name, sticky = false) {
    const editor = sticky
      ? `<div class="test-scroll-region"><div class="view-lines">${Array.from({ length: 60 }, (_, i) => `<div class="view-line">// moving code line ${i + 1} under sticky row</div>`).join('')}</div></div><div class="scroll-decoration"></div><div class="sticky-widget" style="--vscode-editorStickyScroll-scrollableWidth:calc(100% - 42px)"><div class="sticky-widget-line-numbers"><div class="sticky-line-number" style="left:15px">1</div></div><div class="sticky-widget-lines-scrollable"><div class="sticky-widget-lines"><div class="sticky-line-content">#include &lt;iostream&gt;</div></div></div></div>`
      : `<div class="margin">1<br>2<br>3<br>4</div><div class="monaco-editor-background"><textarea spellcheck="false">const backdrop = {\n  blur: 14,\n  fit: 'cover',\n};</textarea></div>`;
    return `<div class="editor-group-container"><div class="title">${name}</div><div class="editor-container"><div class="editor-instance"><div class="monaco-editor">${editor}</div></div></div></div>`;
  }
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'frosted-renderer-test-'));
  fs.writeFileSync(path.join(fixtureDirectory, 'renderer.js'), renderer);
  fs.copyFileSync(path.join(__dirname, 'fixtures/wallpaper.png'), path.join(fixtureDirectory, 'wallpaper.png'));
  const localAssets = path.join(fixtureDirectory, 'frosted-background-assets');
  fs.mkdirSync(localAssets);
  fs.writeFileSync(path.join(localAssets, playerName), playerHtml);
  fs.writeFileSync(path.join(localAssets, 'video-player.js'), playerScript);
  fs.copyFileSync(path.join(__dirname, 'fixtures/colors.webm'), path.join(localAssets, mediaName));
  const fixtureUrl = pathToFileURL(path.join(fixtureDirectory, 'index.html')).href;
  let browser;
  try {
    // This disposable test browser models vscode-file's local fetch capability.
    browser = await chromium.launch({ headless: true, executablePath, args: ['--allow-file-access-from-files'] });
    const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', event => window.__cspViolations.push(event.effectiveDirective));
      window.__revokedBlobs = [];
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = value => { window.__revokedBlobs.push(value); revoke(value); };
    });
    await page.route('https://frosted.test/**', async route => {
      const requested = new URL(route.request().url());
      const files = new Map([
        ['/renderer.js', ['text/javascript', renderer]],
        [`/frosted-background-assets/${playerName}`, ['text/html', playerHtml]],
        ['/frosted-background-assets/video-player.js', ['text/javascript', playerScript]],
        [`/frosted-background-assets/${mediaName}`, ['video/webm', fs.readFileSync(path.join(__dirname, 'fixtures/colors.webm'))]],
      ]);
      const headers = requested.searchParams.has('coi') || requested.searchParams.get('vscode-coi') === '3'
        ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } : {};
      if (requested.pathname === '/index.html') return route.fulfill({ contentType: 'text/html', headers, body: fixture(requested.href) });
      const file = files.get(requested.pathname);
      if (file) return route.fulfill({ contentType: file[0], headers, body: file[1] });
      return route.fulfill({ status: 404, body: '' });
    });
    const openFixture = async (query = '') => {
      const params = new URLSearchParams(query);
      if (params.has('player') && !params.has('local')) return page.goto(`https://frosted.test/index.html?${query}`);
      fs.writeFileSync(path.join(fixtureDirectory, 'index.html'), fixture(`/?${query}`));
      await page.goto(`${fixtureUrl}?${query}`);
    };
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await openFixture();
    await page.waitForSelector('.frosted-background-ready');
    assert.equal(await page.locator('.frosted-background-layer').count(), 1, 'split groups share one background');
    async function verifyBounds() {
      const host = await page.locator('.part.editor').boundingBox();
      const background = await page.locator('.frosted-background-layer').boundingBox();
      assert.deepEqual(background, host, 'background exactly follows editor bounds');
    }
    await verifyBounds();
    assert.equal(await page.locator('.frosted-background-media').evaluate(el => getComputedStyle(el).objectFit), 'cover');
    assert.match(await page.locator('.frosted-background-media').evaluate(el => getComputedStyle(el).filter), /blur\(10px\)/);
    assert.equal(await page.locator('.monaco-editor').first().evaluate(el => getComputedStyle(el).filter), 'none', 'code stays sharp');
    assert.equal(await page.locator('.monaco-editor-background').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    await page.locator('textarea').first().fill('Typing still works');
    assert.equal(await page.locator('textarea').first().inputValue(), 'Typing still works');
    await page.setViewportSize({ width: 810, height: 570 });
    await verifyBounds();
    await page.locator('.part.editor').evaluate(el => { el.style.left = '245px'; });
    await verifyBounds();
    await page.evaluate(() => document.documentElement.style.setProperty('--vscode-editor-background', '#f0f3fa'));
    assert.equal(await page.locator('.frosted-background-tint').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(240, 243, 250)', 'tint follows the theme');
    await page.evaluate(() => document.documentElement.style.setProperty('--vscode-editor-background', '#161c2a'));
    if (process.env.RENDERER_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.RENDERER_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.RENDERER_ARTIFACT_DIR, 'renderer-preview.png') });
    }
    await page.locator('.part.editor').evaluate(el => el.remove());
    await page.waitForFunction(() => !document.querySelector('.frosted-background-layer'));
    await page.evaluate(html => {
      const host = document.createElement('main'); host.className = 'part editor';
      host.innerHTML = `<div class="content">${html}</div>`; document.querySelector('.monaco-workbench').appendChild(host);
    }, group('replacement.js'));
    await page.waitForSelector('.frosted-background-ready');
    assert.equal(await page.locator('.frosted-background-layer').count(), 1);
    await page.evaluate(() => window.__frostedBackgroundCleanup());
    assert.equal(await page.locator('.frosted-background-layer, #frosted-background-style').count(), 0, 'cleanup removes injected elements');
    assert.notEqual(await page.locator('.monaco-editor-background').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');

    await openFixture('fit=contain');
    await page.waitForSelector('.frosted-background-ready');
    assert.equal(await page.locator('.frosted-background-media').evaluate(el => getComputedStyle(el).objectFit), 'contain');
    assert.deepEqual(await page.locator('.frosted-background-media').boundingBox(), await page.locator('.part.editor').boundingBox(), 'contain has no blur overscan that would crop the image');
    await verifyBounds();

    await openFixture('fit=fill');
    await page.waitForSelector('.frosted-background-ready');
    assert.equal(await page.locator('img.frosted-background-media').evaluate(el => getComputedStyle(el).objectFit), 'fill');
    assert.deepEqual(await page.locator('.frosted-background-media').boundingBox(), await page.locator('.part.editor').boundingBox(), 'stretch mode uses every editor pixel without preserving media aspect ratio');
    await page.setViewportSize({ width: 900, height: 610 });
    await verifyBounds();

    // Regression: native Sticky Scroll uses opaque fills on several nested
    // surfaces, and both it and scroll-decoration add black scroll shadows.
    async function verifyStickySurface(theme) {
      await page.mouse.move(0, 0);
      await page.locator('.test-scroll-region').first().evaluate(el => { el.scrollTop = 183; });
      await page.locator('.sticky-widget').first().waitFor({ state: 'visible' });
      const state = await page.locator('.sticky-widget').first().evaluate(el => {
        const pixel = color => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data);
        };
        const computed = getComputedStyle(el);
        return {
          tint: pixel(computed.backgroundColor), backdrop: computed.backdropFilter,
          shadow: computed.boxShadow, textFilter: getComputedStyle(el.querySelector('.sticky-line-content')).filter,
          fills: [...el.querySelectorAll('.sticky-widget-line-numbers,.sticky-widget-lines-scrollable,.sticky-widget-lines,.sticky-line-number,.sticky-line-content')].map(node => getComputedStyle(node).backgroundColor),
        };
      });
      assert.equal(state.backdrop, 'blur(16px)', 'moving text is obscured behind the pinned row');
      assert.equal(state.textFilter, 'none', 'pinned code itself stays sharp');
      assert.ok(state.tint[3] >= 87 && state.tint[3] <= 91, 'sticky surface is translucent rather than a solid bar');
      assert.ok(theme === 'light' ? state.tint[0] > 220 : state.tint[0] < 50, 'sticky tint follows the active theme');
      assert.ok(state.fills.every(value => value === 'rgba(0, 0, 0, 0)'), 'nested native sticky fills do not restore opaque backgrounds');
      assert.equal(state.shadow, 'none');
      assert.equal(await page.locator('.scroll-decoration').first().evaluate(el => getComputedStyle(el).boxShadow), 'none', 'scrolling does not add a black top shadow');
      assert.equal(await page.locator('.view-line').first().evaluate(el => getComputedStyle(el).filter), 'none', 'moving code outside the glass surface stays sharp');
      assert.equal(await page.locator('.frosted-background-media').count(), 1, 'sticky glass does not duplicate the media');
      if (process.env.RENDERER_ARTIFACT_DIR) await page.screenshot({ path: path.join(process.env.RENDERER_ARTIFACT_DIR, `sticky-${theme}.png`) });
      await page.locator('.sticky-line-content').first().hover();
      const hoverFill = await page.locator('.sticky-line-content').first().evaluate(el => getComputedStyle(el).backgroundColor);
      assert.match(hoverFill, /\/\s*0\.35\)/, 'hover remains translucent instead of returning to the native opaque fill');
      await page.locator('.sticky-line-content').first().evaluate(el => el.addEventListener('click', () => { el.dataset.clicked = 'yes'; }, { once: true }));
      await page.locator('.sticky-line-content').first().click();
      assert.equal(await page.locator('.sticky-line-content').first().getAttribute('data-clicked'), 'yes', 'Sticky Scroll remains interactive');
    }
    await openFixture('sticky=1');
    await page.waitForSelector('.frosted-background-ready');
    assert.equal(await page.locator('.sticky-widget').first().isVisible(), false, 'fixture starts before Sticky Scroll is active');
    await verifyStickySurface('dark');
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--vscode-editor-background', '#f0f3fa');
      document.documentElement.style.setProperty('--vscode-editor-foreground', '#19202d');
      document.documentElement.style.setProperty('--vscode-editorStickyScrollHover-background', '#e7edf4');
    });
    await verifyStickySurface('light');
    await page.evaluate(() => window.__frostedBackgroundCleanup());
    assert.equal(await page.locator('.sticky-widget').first().evaluate(el => getComputedStyle(el).backdropFilter), 'none');
    assert.equal(await page.locator('.sticky-widget-lines-scrollable').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)', 'disabling the effect restores native Sticky Scroll styling');
    assert.notEqual(await page.locator('.scroll-decoration').first().evaluate(el => getComputedStyle(el).boxShadow), 'none');

    await openFixture('source=./missing.png');
    await page.waitForSelector('.frosted-background-layer[data-state="error"]', { state: 'attached' });
    assert.equal(await page.locator('.frosted-background-ready').count(), 0, 'broken media restores the original editor');

    // Deterministic VP8 fixture generated from canvas color frames (no downloaded media).
    const webm = fs.readFileSync(path.join(__dirname, 'fixtures/colors.webm'));
    fs.writeFileSync(path.join(fixtureDirectory, 'video.webm'), webm);
    if (process.env.RENDERER_ARTIFACT_DIR) fs.writeFileSync(path.join(process.env.RENDERER_ARTIFACT_DIR, 'sample.webm'), webm);
    await openFixture('kind=video&source=./video.webm&sticky=1');
    await page.waitForSelector('.frosted-background-ready', { timeout: 5000 }).catch(async error => {
      assert.fail(error.message + '\nVideo state: ' + JSON.stringify(await page.locator('video').evaluate(el => ({ source: el.currentSrc, error: el.error?.message, readyState: el.readyState, networkState: el.networkState }))));
    });
    await page.waitForFunction(() => !document.querySelector('video').paused);
    assert.equal(await page.locator('video').evaluate(el => el.muted && el.loop && !el.controls), true);
    await verifyStickySurface('dark');
    assert.equal(await page.locator('video').count(), 1, 'playing video is not cloned for sticky rows');
    await page.setViewportSize({ width: 1050, height: 690 });
    await verifyBounds();
    assert.equal(await page.locator('video').evaluate(el => getComputedStyle(el).objectFit), 'cover');
    assert.equal(await page.locator('video').evaluate(el => el.paused), false, 'video continues playing after resize');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.querySelector('video').paused);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(() => !document.querySelector('video').paused);
    await page.locator('.part.editor').evaluate(el => { el.style.display = 'none'; });
    await page.waitForFunction(() => document.querySelector('video').paused);
    await page.locator('.part.editor').evaluate(el => { el.style.display = ''; });
    await page.waitForFunction(() => !document.querySelector('video').paused);
    await page.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
    await page.waitForFunction(() => document.querySelector('video').paused);
    await page.evaluate(() => { document.hasFocus = () => true; window.dispatchEvent(new Event('focus')); });
    await page.waitForFunction(() => !document.querySelector('video').paused);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => document.querySelector('video').paused);
    await page.evaluate(() => window.__frostedBackgroundCleanup());
    assert.equal(await page.locator('video').count(), 0);

    // The parent keeps VS Code's media-src 'self'. An actual same-origin child
    // document owns the blob permission and decodes real video bytes locally.
    await openFixture('kind=video&player=1&fit=fill&blur=0');
    await page.waitForSelector('.frosted-background-ready');
    const frame = page.frames().find(value => value.url().includes(playerName));
    assert.ok(frame, 'the independent player document loaded');
    await frame.waitForFunction(() => document.querySelector('video').readyState >= 2 && !document.querySelector('video').paused);
    assert.equal(await page.locator('video').count(), 0, 'workbench does not load video directly through its restricted protocol');
    assert.equal(new URL(await page.locator('iframe').getAttribute('src')).search, '', 'normal workbench does not add isolation parameters');
    assert.equal(await frame.locator('video').evaluate(el => getComputedStyle(el).objectFit), 'fill');
    assert.match(await frame.locator('video').evaluate(el => el.currentSrc), /^blob:https:\/\/frosted\.test\//);
    assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), /media-src 'self';/);
    assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
    assert.deepEqual(await frame.evaluate(() => window.__cspViolations), []);
    await verifyBounds();
    assert.deepEqual(await page.locator('iframe').boundingBox(), await page.locator('.part.editor').boundingBox());
    await page.setViewportSize({ width: 1060, height: 510 });
    await verifyBounds();
    const frameSize = await frame.locator('video').evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }));
    const frameBounds = await page.locator('iframe').boundingBox();
    assert.deepEqual(frameSize, { width: frameBounds.width, height: frameBounds.height }, 'stretched child video follows both dimensions of the resized editor');
    await page.evaluate(() => {
      const iframe = document.querySelector('iframe');
      const channel = new URL(iframe.src).hash.slice('#frosted-channel='.length);
      window.dispatchEvent(new MessageEvent('message', { source: window, origin: location.origin, data: { type: 'frosted-background-player', channel, event: 'error' } }));
      window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, origin: location.origin, data: { type: 'frosted-background-player', channel: 'wrong', event: 'error' } }));
    });
    assert.equal(await page.locator('.frosted-background-ready').count(), 1, 'spoofed player messages cannot hide the background');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await frame.waitForFunction(() => document.querySelector('video').paused);
    assert.equal(await page.locator('.frosted-background-ready').count(), 1, 'reduced motion keeps the decoded still frame visible');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await frame.waitForFunction(() => !document.querySelector('video').paused);
    await page.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
    await frame.waitForFunction(() => document.querySelector('video').paused);
    await page.evaluate(() => { document.hasFocus = () => true; window.dispatchEvent(new Event('focus')); });
    await frame.waitForFunction(() => !document.querySelector('video').paused);
    await frame.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    assert.equal(await frame.evaluate(() => window.__revokedBlobs.length), 1, 'player disposal revokes its video blob');
    assert.equal(await frame.locator('video').getAttribute('src'), null);
    await page.evaluate(() => window.__frostedBackgroundCleanup());
    assert.equal(await page.locator('iframe').count(), 0, 'parent cleanup releases the entire player document');
    await openFixture('kind=video&player=1&coi=1');
    assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), true);
    await page.waitForSelector('.frosted-background-ready');
    assert.equal(new URL(await page.locator('iframe').getAttribute('src')).searchParams.get('vscode-coi'), '3', 'isolated workbenches request the matching child document headers');
    await openFixture('kind=video&player=1&local=1&fit=fill');
    await page.waitForSelector('.frosted-background-ready');
    const localFrame = page.frames().find(value => value.url().includes(playerName));
    await localFrame.waitForFunction(() => document.querySelector('video').readyState >= 2 && !document.querySelector('video').paused);
    assert.equal(await localFrame.locator('video').evaluate(el => getComputedStyle(el).objectFit), 'fill');
    assert.match(await localFrame.locator('video').evaluate(el => el.currentSrc), /^blob:/, 'opaque local origins can initialize and decode the player too');
    assert.deepEqual(pageErrors, [], 'renderer has no uncaught errors');
  } finally {
    if (browser) await browser.close();
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});
