'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const bundledRuntime = name => Buffer.concat([
  fs.readFileSync(path.join(__dirname, '../media/regions.js')), Buffer.from('\n;\n'),
  fs.readFileSync(path.join(__dirname, '../media', name)),
]);

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
  const renderer = bundledRuntime('renderer.js');
  const playerScript = bundledRuntime('video-player.js');
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
      .editor-container { height:calc(100% - 34px);background:var(--vscode-editor-background); }
      .editor-instance,.monaco-editor { height:100%;background:var(--vscode-editor-background); }
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
    async function verifyBounds(fit = 'cover') {
      const host = await page.locator('.part.editor').boundingBox();
      const expected = fit === 'fill' ? { x: host.x, y: host.y + 34, width: host.width - 1, height: host.height - 34 } : host;
      await page.waitForFunction(expected => {
        const box = document.querySelector('.frosted-background-layer').getBoundingClientRect();
        return ['x', 'y', 'width', 'height'].every(key => Math.abs(box[key] - expected[key]) < 0.1);
      }, expected);
      const background = await page.locator('.frosted-background-layer').boundingBox();
      assert.deepEqual(background, expected, fit === 'fill' ? 'complete compression excludes the opaque title bars' : 'background exactly follows editor bounds');
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
    await verifyBounds('fill');
    assert.deepEqual(await page.locator('.frosted-background-media').boundingBox(), await page.locator('.frosted-background-layer').boundingBox(), 'complete compression has no overscan that could crop edge pixels');
    await page.setViewportSize({ width: 900, height: 610 });
    await verifyBounds('fill');

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
    await verifyBounds('fill');
    assert.deepEqual(await page.locator('iframe').boundingBox(), await page.locator('.frosted-background-layer').boundingBox());
    await page.setViewportSize({ width: 1060, height: 510 });
    await verifyBounds('fill');
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
    // A file-origin regression must not inherit the browsing-context group of
    // the preceding COOP/COEP page. browser.newPage creates a fresh context;
    // retain the real file fetch, player CSP, Blob decode and playback checks.
    const localPage = await browser.newPage({ viewport: { width: 1060, height: 510 } });
    const localDiagnostics = [];
    const record = value => { localDiagnostics.push(value); if (localDiagnostics.length > 40) localDiagnostics.shift(); };
    localPage.on('console', message => {
      if (['warning', 'error'].includes(message.type())) record({ type: message.type(), text: message.text() });
    });
    localPage.on('requestfailed', request => record({ type: 'requestfailed', url: request.url(), error: request.failure()?.errorText }));
    localPage.on('pageerror', error => { pageErrors.push(error.message); record({ type: 'pageerror', text: error.message }); });
    await localPage.addInitScript(({ fixtureMediaURL }) => {
      window.__localPlayerMessages = [];
      window.__localCspViolations = [];
      window.__localFileBridgeRequests = [];
      // Chromium's standalone file: scheme does not consistently implement
      // Fetch (Linux headless-shell rejects it even with file access enabled).
      // VS Code explicitly registers vscode-file with supportFetchAPI. Model
      // that one protocol capability here using XHR's real local-file bytes;
      // the production player, origin handshake, Blob decoder and CSP stay real.
      // HTTPS/COI cases above still exercise the browser's native Fetch path.
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, options = {}) => {
        const requested = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (location.protocol !== 'file:' || requested.href !== fixtureMediaURL) return nativeFetch(input, options);
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const record = { url: requested.href, transport: 'XMLHttpRequest', state: 'loading' };
          window.__localFileBridgeRequests.push(record);
          const signal = options.signal;
          const aborted = () => { record.state = 'aborted'; xhr.abort(); reject(new DOMException('Aborted', 'AbortError')); };
          if (signal?.aborted) { aborted(); return; }
          xhr.open('GET', requested.href);
          xhr.responseType = 'blob';
          signal?.addEventListener('abort', aborted, { once: true });
          xhr.onload = () => {
            signal?.removeEventListener('abort', aborted);
            if ((xhr.status !== 0 && xhr.status !== 200) || !(xhr.response instanceof Blob)) {
              record.state = 'failed'; reject(new TypeError('Local fixture read failed.')); return;
            }
            record.state = 'loaded'; record.bytes = xhr.response.size;
            resolve(new Response(xhr.response, { status: 200, headers: { 'Content-Type': 'video/webm', 'Content-Length': String(xhr.response.size) } }));
          };
          xhr.onerror = () => { signal?.removeEventListener('abort', aborted); record.state = 'failed'; reject(new TypeError('Local fixture XHR failed.')); };
          xhr.send();
        });
      };
      document.addEventListener('securitypolicyviolation', event => window.__localCspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
      window.addEventListener('message', event => {
        if (event.data?.type !== 'frosted-background-player') return;
        window.__localPlayerMessages.push({ origin: event.origin, action: event.data.action, event: event.data.event, detail: event.data.detail, fromParent: event.source === parent });
        if (window.__localPlayerMessages.length > 20) window.__localPlayerMessages.shift();
      });
    }, { fixtureMediaURL: pathToFileURL(path.join(localAssets, mediaName)).href });
    fs.writeFileSync(path.join(fixtureDirectory, 'index.html'), fixture('/?kind=video&player=1&local=1&fit=fill'));
    await localPage.goto(`${fixtureUrl}?kind=video&player=1&local=1&fit=fill`);
    await localPage.bringToFront();
    try {
      assert.equal(await localPage.evaluate(() => globalThis.crossOriginIsolated), false, 'file test starts outside the prior isolated context');
      await localPage.waitForSelector('.frosted-background-ready', { timeout: 15000 });
      const localFrame = localPage.frames().find(value => value.url().includes(playerName));
      assert.ok(localFrame, 'local player document exists');
      await localFrame.waitForFunction(() => document.querySelector('video').readyState >= 2 && !document.querySelector('video').paused, undefined, { timeout: 10000 });
      assert.equal(await localFrame.locator('video').evaluate(el => getComputedStyle(el).objectFit), 'fill');
      assert.match(await localFrame.locator('video').evaluate(el => el.currentSrc), /^blob:/, 'opaque local origins can initialize and decode the player too');
      const bridgeReads = await localFrame.evaluate(() => window.__localFileBridgeRequests);
      assert.equal(bridgeReads.length, 1);
      assert.equal(bridgeReads[0].state, 'loaded');
      assert.equal(bridgeReads[0].bytes, fs.statSync(path.join(localAssets, mediaName)).size, 'protocol bridge reads the actual fixture bytes');
    } catch (error) {
      const frames = await Promise.all(localPage.frames().map(async frame => {
        try {
          return await frame.evaluate(() => {
            const video = document.querySelector('video');
            return {
              protocol: location.protocol, origin: location.origin, urlOrigin: new URL(location.href).origin,
              isolated: globalThis.crossOriginIsolated, focused: document.hasFocus(), hidden: document.hidden,
              state: document.querySelector('.frosted-background-layer')?.dataset.state,
              video: video ? { readyState: video.readyState, networkState: video.networkState, error: video.error?.message, errorCode: video.error?.code, sourceProtocol: video.currentSrc.split(':')[0], paused: video.paused, width: video.videoWidth } : null,
              messages: window.__localPlayerMessages, csp: window.__localCspViolations, bridge: window.__localFileBridgeRequests,
            };
          });
        } catch (inspectionError) { return { inspectionError: inspectionError.message }; }
      }));
      assert.fail(`${error.message}\nLocal player diagnostics: ${JSON.stringify({ browser: await browser.version(), platform: process.platform, events: localDiagnostics, frames })}`);
    } finally { await localPage.close(); }
    assert.deepEqual(pageErrors, [], 'renderer has no uncaught errors');
  } finally {
    if (browser) await browser.close();
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('live state swaps media without reload, preserves video settings updates and tears down obsolete work', {
  skip: !process.env.PLAYWRIGHT_MODULE,
  timeout: 60000,
}, async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const executablePath = process.env.BROWSER_EXECUTABLE || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(value => fs.existsSync(value));
  const renderer = bundledRuntime('renderer.js');
  const playerScript = bundledRuntime('video-player.js');
  const imageName = `media-${'1'.repeat(64)}.png`;
  const imageName2 = `media-${'2'.repeat(64)}.png`;
  const videoName = `media-${'3'.repeat(64)}.webm`;
  const slowVideoName = `media-${'4'.repeat(64)}.webm`;
  const playerName = `video-host-${'5'.repeat(64)}.html`;
  const assets = './frosted-background-assets/';
  const playerHtml = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; connect-src \'self\'; media-src blob:; style-src \'unsafe-inline\';"><body><script src="./video-player.js" defer></script></body>';
  const initial = {
    enabled: true, kind: 'image', source: assets + imageName, liveState: assets + 'live-state.json',
    blur: 14, opacity: 0.35, tintOpacity: 0.18, saturation: 1, brightness: 1,
    fit: 'cover', position: 'center center', playbackRate: 1, pauseWhenUnfocused: true, respectReducedMotion: true,
  };
  const image2 = { ...initial, source: assets + imageName2, blur: 7 };
  const video = { ...initial, kind: 'video', source: assets + videoName, videoPlayer: assets + playerName };
  const envelope = settings => ({ protocol: 1, revision: randomUUID(), settings });
  let body = JSON.stringify(envelope(initial));
  let status = 200;
  let holdState = false;
  let releaseState;
  let releaseSlowVideo;
  let slowVideoStarted;
  const slowVideoRequested = new Promise(resolve => { slowVideoStarted = resolve; });
  const slowVideoReleased = new Promise(resolve => { releaseSlowVideo = resolve; });
  const requests = [];
  const errors = [];
  const fixture = settings => `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; frame-src 'self'; connect-src 'self';"><style>
    :root{--vscode-editor-background:#181818} body{margin:0}.part.editor{position:absolute;inset:20px;background:#181818}
    .content,.editor-group-container,.editor-instance,.monaco-editor{width:100%;height:100%;background:#181818}.title{height:32px;background:#222}
    .editor-container{height:calc(100% - 32px)}textarea{background:transparent;color:white;border:0}
  </style><main class="part editor"><div class="content"><div class="editor-group-container"><div class="title">app.js</div><div class="editor-container"><div class="editor-instance"><div class="monaco-editor"><textarea>unsaved work</textarea></div></div></div></div></div></main><script src="./renderer.js" data-frosted-config="${JSON.stringify(settings).replace(/"/g, '&quot;')}"></script>`;
  const files = new Map([
    ['/renderer.js', ['text/javascript', renderer]],
    [`/frosted-background-assets/${imageName}`, ['image/png', fs.readFileSync(path.join(__dirname, 'fixtures/edges.png'))]],
    [`/frosted-background-assets/${imageName2}`, ['image/png', fs.readFileSync(path.join(__dirname, 'fixtures/wallpaper.png'))]],
    [`/frosted-background-assets/${videoName}`, ['video/webm', fs.readFileSync(path.join(__dirname, 'fixtures/colors.webm'))]],
    [`/frosted-background-assets/${slowVideoName}`, ['video/webm', fs.readFileSync(path.join(__dirname, 'fixtures/edges.webm'))]],
    [`/frosted-background-assets/${playerName}`, ['text/html', playerHtml]],
    ['/frosted-background-assets/video-player.js', ['text/javascript', playerScript]],
  ]);
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--allow-file-access-from-files'] });
  const localDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'frosted-live-test-'));
  try {
    const page = await browser.newPage({ viewport: { width: 700, height: 480 } });
    const stripePNG = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d');
      for (let x = 0; x < 320; x += 8) { context.fillStyle = (x / 8) % 2 ? '#fff' : '#000'; context.fillRect(x, 0, 8, 180); }
      return canvas.toDataURL('image/png').split(',')[1];
    });
    files.set(`/frosted-background-assets/${imageName}`, ['image/png', Buffer.from(stripePNG, 'base64')]);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__cspViolations = [];
      window.__blobEvents = [];
      window.__liveAborts = 0;
      window.__maskReads = 0;
      window.__messageListeners = new Set();
      const pixels = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function (...args) { if (!this.canvas.isConnected) window.__maskReads++; return pixels.apply(this, args); };
      document.addEventListener('securitypolicyviolation', event => window.__cspViolations.push(event.effectiveDirective));
      const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
      window.addEventListener = (type, listener, options) => { if (type === 'message') window.__messageListeners.add(listener); return add(type, listener, options); };
      window.removeEventListener = (type, listener, options) => { if (type === 'message') window.__messageListeners.delete(listener); return remove(type, listener, options); };
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = value => { const url = create(value); top.__blobEvents.push({ event: 'create', url }); return url; };
      URL.revokeObjectURL = url => { top.__blobEvents.push({ event: 'revoke', url }); revoke(url); };
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (url, options) => {
        if (String(url).includes('/live-state.json')) options.signal.addEventListener('abort', () => window.__liveAborts++, { once: true });
        return nativeFetch(url, options);
      };
      window.__documentToken = Math.random();
    });
    await page.route('https://live.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/index.html') return route.fulfill({ contentType: 'text/html', body: fixture(initial) });
      if (url.pathname === '/frosted-background-assets/live-state.json') {
        requests.push(url.href);
        if (holdState) await new Promise(resolve => { releaseState = resolve; });
        return route.fulfill({ status, contentType: 'application/json', body }).catch(() => {});
      }
      if (url.pathname.endsWith(slowVideoName)) { slowVideoStarted(); await slowVideoReleased; }
      const asset = files.get(url.pathname);
      return route.fulfill(asset ? { contentType: asset[0], body: asset[1] } : { status: 404, body: '' }).catch(() => {});
    });
    const publish = settings => { status = 200; body = JSON.stringify(envelope(settings)); };
    const nextPoll = async () => {
      await page.waitForResponse(value => value.url().includes('/live-state.json'));
      // Invalid responses may be deliberately aborted by the size/schema guard;
      // awaiting Playwright's response.finished() can then never settle.
      await page.waitForTimeout(50);
    };
    await page.goto('https://live.test/index.html');
    await page.waitForSelector('.frosted-background-ready');
    const documentToken = await page.evaluate(() => window.__documentToken);
    await page.locator('textarea').fill('keep my unsaved code');
    publish({ ...initial, fit: 'fill', blur: 3, opacity: 0.6 });
    await page.waitForFunction(() => document.querySelector('img').style.objectFit === 'fill' && document.querySelector('img').style.opacity === '0.6');
    assert.equal(await page.locator('.frosted-background-layer').evaluate(el => el.getBoundingClientRect().top), 52, 'live fill excludes the opaque title');
    const clearRegion = { id: 'clear', name: 'Clear', points: [[0.05, 0.15], [0.55, 0.15], [0.55, 0.85], [0.05, 0.85]], blur: 0, opacity: 1, tintOpacity: 0, brightness: 1, saturation: 1, feather: 0.06 };
    const overlapRegion = { ...clearRegion, id: 'overlap', name: 'Overlap', points: [[0.25, 0.25], [0.42, 0.25], [0.42, 0.75], [0.25, 0.75]], brightness: 0.2 };
    const regionalImage = { ...initial, blur: 14, opacity: 1, tintOpacity: 0, fit: 'fill', regions: { enabled: true, items: [clearRegion, overlapRegion] } };
    async function regionPixels(fit) {
      const box = await page.locator('.frosted-background-layer').boundingBox();
      const bytes = await page.screenshot();
      return page.evaluate(async ({ bytes, box, fit }) => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
        let width = box.width, height = box.height;
        if (fit !== 'fill') { const scale = (fit === 'cover' ? Math.max : Math.min)(box.width / 320, box.height / 180); width = 320 * scale; height = 180 * scale; }
        const read = sourceX => [...context.getImageData(Math.floor(box.x + (box.width - width) / 2 + sourceX / 320 * width), Math.floor(box.y + box.height / 2), 1, 1).data].slice(0, 3);
        return { clear: read(170), overlap: read(110), base: read(186) };
      }, { bytes: [...bytes], box, fit });
    }
    for (const fit of ['fill', 'contain', 'cover']) {
      publish({ ...regionalImage, fit });
      await page.waitForFunction(fit => document.querySelector('.frosted-background-canvas') && document.querySelector('img').style.objectFit === fit, fit);
      await page.setViewportSize({ width: fit === 'fill' ? 700 : 300, height: 500 });
      await page.waitForTimeout(100);
      const pixels = await regionPixels(fit);
      assert.ok(pixels.clear.every(value => value > 230), `zero-blur polygon stays sharp over a blurred base after ${fit} resize: ${JSON.stringify(pixels)}`);
      assert.ok(pixels.overlap.every(value => value >= 40 && value <= 65), `later region independently overrides brightness in overlap: ${JSON.stringify(pixels)}`);
      assert.ok(pixels.base.every(value => value > 80 && value < 180), `outside polygon retains global blur: ${JSON.stringify(pixels)}`);
    }
    publish({ ...regionalImage, fit: 'fill', regions: { enabled: true, items: [clearRegion, { ...overlapRegion, opacity: 0.05, tintOpacity: 0.9 }] } });
    await nextPoll();
    await page.evaluate(() => document.documentElement.style.setProperty('--vscode-editor-background', '#e0e8f0'));
    await page.waitForTimeout(100);
    assert.ok((await regionPixels('fill')).overlap.every(value => value > 210), 'regional theme tint updates without recreating media');
    await page.evaluate(() => document.documentElement.style.setProperty('--vscode-editor-background', '#181818'));
    publish(video);
    await page.waitForSelector('iframe.frosted-background-media');
    const frame = page.frames().find(value => value.url().includes(playerName));
    await frame.waitForFunction(() => document.querySelector('video').readyState >= 2 && !document.querySelector('video').paused);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await frame.waitForFunction(() => document.querySelector('video').paused);
    await frame.locator('video').evaluate(element => { element.currentTime = 0.5; window.__originalVideo = element; });
    await frame.waitForFunction(() => !document.querySelector('video').seeking);
    await page.locator('iframe').evaluate(element => { window.__originalFrame = element; });
    const videoTime = await frame.locator('video').evaluate(element => element.currentTime);
    publish({ ...video, fit: 'contain', blur: 22, opacity: 0.55, tintOpacity: 0.4, brightness: 0.8, saturation: 0.6, playbackRate: 1.5, position: 'left center' });
    await frame.waitForFunction(() => document.querySelector('video').style.objectFit === 'contain' && document.querySelector('video').playbackRate === 1.5);
    assert.equal(await page.evaluate(() => document.querySelector('iframe') === window.__originalFrame), true);
    assert.equal(await frame.evaluate(() => document.querySelector('video') === window.__originalVideo), true);
    assert.equal(await frame.locator('video').evaluate(element => element.currentTime), videoTime, 'settings-only changes preserve playback position');
    assert.match(await page.locator('iframe').getAttribute('style'), /blur\(22px\)/);
    assert.equal(await page.locator('.frosted-background-tint').evaluate(el => el.style.opacity), '0.4');
    const videoRegions = { enabled: true, items: [{ ...clearRegion, id: 'left', points: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]], brightness: 0.2 }] };
    publish({ ...video, fit: 'fill', blur: 0, opacity: 1, tintOpacity: 0, regions: videoRegions });
    await frame.waitForFunction(() => document.querySelector('canvas')?.width > 0);
    const videoPixels = await frame.locator('canvas').evaluate(canvas => {
      const ctx = canvas.getContext('2d');
      return { left: [...ctx.getImageData(Math.floor(canvas.width / 4), Math.floor(canvas.height / 2), 1, 1).data].slice(0, 3), right: [...ctx.getImageData(Math.floor(canvas.width * 3 / 4), Math.floor(canvas.height / 2), 1, 1).data].slice(0, 3) };
    });
    assert.ok(Math.max(...videoPixels.left) < Math.max(...videoPixels.right) * 0.4, `single decoded video is composited with independent regional effects: ${JSON.stringify(videoPixels)}`);
    assert.equal(await frame.locator('video').count(), 1);
    assert.equal(await frame.evaluate(() => document.querySelector('video') === window.__originalVideo), true);
    assert.equal(await frame.locator('video').evaluate(element => element.currentTime), videoTime);
    assert.equal(await page.locator('iframe').evaluate(el => el.style.filter), 'none', 'parent does not apply global effects twice');
    assert.equal(await page.locator('.frosted-background-tint').evaluate(el => el.style.opacity), '0');
    await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const videoMaskReads = await frame.evaluate(() => window.__maskReads);
    assert.ok(videoMaskReads > 0, 'video feather initially builds a real alpha mask');
    publish({ ...video, fit: 'fill', blur: 0, opacity: 1, tintOpacity: 0, regions: { enabled: true, items: [{ ...videoRegions.items[0], opacity: 0.05, tintOpacity: 0.9 }] } });
    await nextPoll();
    await page.evaluate(() => document.documentElement.style.setProperty('--vscode-editor-background', '#dc2020'));
    await frame.waitForFunction(() => {
      const canvas = document.querySelector('canvas');
      const pixel = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 4), Math.floor(canvas.height / 2), 1, 1).data;
      return pixel[0] > 180 && pixel[1] < 60;
    });
    assert.equal(await frame.evaluate(() => document.querySelector('video') === window.__originalVideo), true, 'theme changes do not recreate the decoder');
    await page.evaluate(() => document.documentElement.style.setProperty('--vscode-editor-background', '#181818'));
    const beforePlayback = await frame.locator('canvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(Math.floor(canvas.width * 3 / 4), Math.floor(canvas.height / 2), 1, 1).data].join(','));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await frame.waitForFunction(previous => {
      const canvas = document.querySelector('canvas');
      const pixel = [...canvas.getContext('2d').getImageData(Math.floor(canvas.width * 3 / 4), Math.floor(canvas.height / 2), 1, 1).data].join(',');
      return !document.querySelector('video').paused && pixel !== previous;
    }, beforePlayback);
    assert.equal(await frame.locator('video').evaluate(element => element.style.visibility), 'hidden', 'canvas receives fresh video pixels while the raw video element is hidden');
    assert.equal(await frame.evaluate(() => window.__maskReads), videoMaskReads, 'video playback, regional effect edits and theme changes reuse the same feather mask');
    publish({ ...video, fit: 'fill', blur: 0 });
    await frame.waitForFunction(() => document.querySelector('video').style.objectFit === 'fill');
    await frame.waitForFunction(() => !document.querySelector('canvas'));
    assert.equal(await frame.evaluate(() => document.querySelector('video') === window.__originalVideo), true, 'disabling regions preserves the decoder too');
    await page.setViewportSize({ width: 410, height: 300 });
    assert.equal(await page.locator('.frosted-background-layer').evaluate(el => el.getBoundingClientRect().top), 52);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await frame.waitForFunction(() => !document.querySelector('video').paused && document.querySelector('video').currentTime !== 0.5);
    publish(image2);
    await page.waitForFunction(name => document.querySelector('img')?.src.endsWith(name) && document.querySelector('.frosted-background-ready'), imageName2);
    const lifecycle = await page.evaluate(() => window.__blobEvents);
    assert.equal(lifecycle.filter(event => event.event === 'create').length, 1);
    assert.deepEqual(lifecycle.filter(event => event.event === 'revoke').map(event => event.url), lifecycle.filter(event => event.event === 'create').map(event => event.url), 'obsolete video Blob is revoked before its frame is removed');
    assert.equal(await page.evaluate(() => window.__messageListeners.size), 0, 'obsolete player message listeners are removed');
    await page.locator('img').evaluate(element => { window.__stableImage = element; });
    // A broken/oversized state file or a remote/foreign media address must not
    // replace the last valid background or cause external resource requests.
    for (const invalid of [
      '{partial json', JSON.stringify({ ...envelope(initial), protocol: 2 }),
      JSON.stringify({ ...envelope(initial), revision: 'not-a-uuid' }),
      JSON.stringify(envelope({ ...initial, source: 'https://untrusted.invalid/private.png' })),
      JSON.stringify(envelope({ ...initial, source: './another-directory/media-' + '1'.repeat(64) + '.png' })),
      JSON.stringify(envelope({ ...initial, blur: 'not a number' })),
      JSON.stringify({ ...envelope(initial), oversized: 'x'.repeat(70 * 1024) }),
    ]) {
      body = invalid;
      await nextPoll();
      assert.equal(await page.evaluate(() => document.querySelector('img') === window.__stableImage), true, 'invalid state preserves the previous media instance');
    }
    status = 404;
    await nextPoll();
    assert.equal(await page.evaluate(() => document.querySelector('img') === window.__stableImage), true, 'transient missing state preserves the background');
    publish({ ...video, source: assets + slowVideoName });
    await slowVideoRequested;
    publish(initial);
    await page.waitForFunction(name => document.querySelector('img')?.src.endsWith(name) && document.querySelector('.frosted-background-ready'), imageName);
    releaseSlowVideo();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('iframe').count(), 0, 'a superseded video load cannot resurrect its player');
    assert.equal(await page.evaluate(() => window.__blobEvents.filter(event => event.event === 'create').length), 1, 'superseded fetch does not create a late video Blob');
    assert.equal(await page.evaluate(() => window.__messageListeners.size), 0);
    publish({ enabled: false });
    await page.waitForFunction(() => !document.querySelector('.frosted-background-layer'));
    assert.equal(await page.locator('.frosted-background-ready').count(), 0);
    assert.notEqual(await page.locator('.monaco-editor').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'disabled tombstone restores normal editor styling');
    publish({ ...image2, opacity: 0.75 });
    await page.waitForFunction(() => document.querySelector('img')?.style.opacity === '0.75' && document.querySelector('.frosted-background-ready'));
    assert.equal(await page.locator('textarea').inputValue(), 'keep my unsaved code');
    assert.equal(await page.evaluate(() => window.__documentToken), documentToken, 'all changes happen in the original document');
    assert.equal(new Set(requests).size, requests.length, 'every poll uses a unique cache-busting URL');
    assert.deepEqual(await page.evaluate(() => window.__cspViolations), [], 'live state does not require workbench CSP changes');
    holdState = true;
    await page.waitForRequest(request => request.url().includes('/live-state.json'));
    const previousAborts = await page.evaluate(() => window.__liveAborts);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    const lastRequestCount = requests.length;
    releaseState?.();
    await page.waitForTimeout(650);
    assert.equal(requests.length, lastRequestCount, 'pagehide stops the polling timer');
    assert.equal(await page.evaluate(() => window.__liveAborts), previousAborts + 1, 'pagehide aborts the pending local read');
    assert.equal(await page.locator('.frosted-background-layer, #frosted-background-style').count(), 0);

    // Standalone Chromium file: lacks VS Code's supportFetchAPI protocol flag.
    // Bridge only this exact local JSON path through XHR; still read real bytes
    // and exercise the production polling/parser/renderer with an opaque origin.
    fs.mkdirSync(path.join(localDirectory, 'frosted-background-assets'));
    fs.writeFileSync(path.join(localDirectory, 'index.html'), fixture({ enabled: false, liveState: initial.liveState }));
    fs.writeFileSync(path.join(localDirectory, 'renderer.js'), renderer);
    fs.writeFileSync(path.join(localDirectory, 'frosted-background-assets', imageName), files.get(`/frosted-background-assets/${imageName}`)[1]);
    const localStatePath = path.join(localDirectory, 'frosted-background-assets/live-state.json');
    fs.writeFileSync(localStatePath, JSON.stringify(envelope(initial)));
    const localPage = await browser.newPage();
    localPage.on('pageerror', error => errors.push(error.message));
    await localPage.addInitScript(({ stateURL }) => {
      const original = window.fetch.bind(window);
      window.__stateReads = 0;
      window.fetch = (input, options = {}) => {
        const url = new URL(input, location.href); url.search = '';
        if (url.href !== stateURL) return original(input, options);
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const abort = () => { xhr.abort(); reject(new DOMException('Aborted', 'AbortError')); };
          if (options.signal?.aborted) return abort();
          xhr.open('GET', String(input)); xhr.responseType = 'arraybuffer';
          options.signal?.addEventListener('abort', abort, { once: true });
          xhr.onload = () => {
            options.signal?.removeEventListener('abort', abort);
            window.__stateReads++;
            if (xhr.status !== 0 && xhr.status !== 200) { reject(new Error('Local read failed')); return; }
            resolve(new Response(xhr.response, { headers: { 'Content-Type': 'application/json' } }));
          };
          xhr.onerror = () => { options.signal?.removeEventListener('abort', abort); reject(new Error('Local read failed')); };
          xhr.send();
        });
      };
    }, { stateURL: pathToFileURL(localStatePath).href });
    await localPage.goto(pathToFileURL(path.join(localDirectory, 'index.html')).href);
    await localPage.waitForSelector('.frosted-background-ready');
    fs.writeFileSync(localStatePath, JSON.stringify(envelope({ ...initial, fit: 'fill', blur: 9 })));
    await localPage.waitForFunction(() => document.querySelector('img')?.style.filter.includes('blur(9px)') && document.querySelector('img').style.objectFit === 'fill');
    fs.writeFileSync(localStatePath, JSON.stringify(envelope({ enabled: false })));
    await localPage.waitForFunction(() => !document.querySelector('.frosted-background-layer'));
    assert.ok(await localPage.evaluate(() => window.__stateReads) >= 3);
    await localPage.close();
    assert.deepEqual(errors, [], 'live updates cause no uncaught runtime errors');
  } finally {
    releaseSlowVideo(); releaseState?.();
    await browser.close();
    fs.rmSync(localDirectory, { recursive: true, force: true });
  }
});

test('feather masks blend real pixels without seams and reuse cached geometry', {
  skip: !process.env.PLAYWRIGHT_MODULE,
  timeout: 60000,
}, async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const executablePath = process.env.BROWSER_EXECUTABLE || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(value => fs.existsSync(value));
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 360 } });
    await page.setContent('<style>body{margin:24px;background:#151923;color:#eee;font:14px system-ui}canvas{display:block;width:320px;height:180px}#comparison{display:flex;gap:24px}p{margin:8px 0}</style><h2>Region edge transition</h2><section id="comparison"><div><p>0% — hard edge</p><canvas id="output" data-output="true"></canvas></div></section>');
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../media/regions.js'), 'utf8') });
    await page.evaluate(async () => {
      const original = document.createElement('canvas'); original.width = 320; original.height = 180;
      original.getContext('2d').fillStyle = '#fff'; original.getContext('2d').fillRect(0, 0, 320, 180);
      const source = new Image(); source.src = original.toDataURL(); await source.decode();
      const canvas = document.querySelector('#output');
      window.__maskReads = 0; window.__offscreen = [];
      const read = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function (...args) { if (!this.canvas.dataset.output) window.__maskReads++; return read.apply(this, args); };
      const create = document.createElement.bind(document);
      document.createElement = (tag, ...args) => { const element = create(tag, ...args); if (tag === 'canvas') window.__offscreen.push(element); return element; };
      const compositor = FrostedRegions.createCompositor({ source, canvas });
      const base = { fit: 'fill', position: 'center center', blur: 0, opacity: 1, tintOpacity: 0, brightness: 0.2, saturation: 1, tintColor: '#14283c' };
      window.__region = (id, left, right, brightness = 1, feather = 0.06) => ({ id, name: id, points: [[left, 0], [right, 0], [right, 1], [left, 1]], blur: 0, opacity: 1, tintOpacity: 0, brightness, saturation: 1, feather });
      window.__set = (items, extra = {}, width = 320, height = 180) => {
        canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
        compositor.update({ ...base, ...extra, regions: { enabled: true, items } });
      };
      window.__samples = (points = [[140, 90], [150, 90], [156, 90], [160, 90], [164, 90], [170, 90], [180, 90]]) => points.map(([x, y]) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data].slice(0, 3));
      window.__fx = { canvas, compositor, source, base };
    });
    await page.evaluate(() => __set([__region('left', 0, 0.5, 1, 0)]));
    const hard = await page.evaluate(() => __samples([[159, 90], [160, 90]]));
    assert.deepEqual(hard, [[255, 255, 255], [51, 51, 51]], 'zero feather preserves the exact hard boundary');
    await page.evaluate(() => __set([__region('left', 0, 0.5)]));
    const soft = await page.evaluate(() => __samples());
    assert.ok(soft[0][0] > 245 && soft.at(-1)[0] < 60, JSON.stringify(soft));
    assert.ok(soft.filter(pixel => pixel[0] > 70 && pixel[0] < 235).length >= 3, `edge has real intermediate alpha values: ${JSON.stringify(soft)}`);
    assert.ok(soft.every((pixel, index) => !index || pixel[0] <= soft[index - 1][0]), 'single-region transition is monotonic');
    assert.ok((await page.evaluate(() => __samples([[2, 2], [2, 178], [80, 2], [80, 178]]))).every(pixel => pixel[0] > 250), 'image-border template edges do not fade into the base');
    const initialReads = await page.evaluate(() => __maskReads);
    await page.evaluate(() => { __set([__region('left', 0, 0.5, 0.8)]); for (let i = 0; i < 5; i++) __fx.compositor.draw(); });
    assert.equal(await page.evaluate(() => __maskReads), initialReads, 'effect changes and frame draws do not rebuild/read masks');
    await page.evaluate(() => __set([__region('left', 0, 0.6, 0.8)]));
    assert.equal(await page.evaluate(() => __maskReads), initialReads + 1, 'polygon geometry changes rebuild the cached mask');
    await page.evaluate(() => __set([__region('left', 0, 0.6, 0.8, 0.12)]));
    assert.equal(await page.evaluate(() => __maskReads), initialReads + 2, 'feather changes rebuild the cached mask');

    await page.evaluate(() => __set([__region('whole', 0, 1)]));
    const whole = await page.evaluate(() => __samples());
    await page.evaluate(() => __set([__region('left', 0, 0.5), __region('right', 0.5, 1)]));
    const adjacent = await page.evaluate(() => __samples());
    assert.ok(adjacent.every((pixel, index) => pixel.every((channel, c) => Math.abs(channel - whole[index][c]) <= 2)), `adjacent equal effects match a single region without a dark seam: ${JSON.stringify(adjacent)}`);
    await page.evaluate(() => __set([__region('left', 0, 0.5), __region('right', 0.5, 1, 0.5)]));
    const differing = await page.evaluate(() => __samples());
    assert.ok(differing.every(pixel => pixel[0] >= 126 && pixel[0] <= 255), 'adjacent different effects do not dip below either endpoint');
    assert.ok(differing.every((pixel, i) => !i || pixel[0] <= differing[i - 1][0] + 1), `different effects transition continuously: ${JSON.stringify(differing)}`);
    await page.evaluate(() => __set([__region('hard-base', 0, 1, 1, 0), __region('soft-later', 0.5, 1, 0.2)]));
    const mixed = await page.evaluate(() => __samples());
    assert.ok(mixed[0][0] > 245 && mixed.at(-1)[0] < 60 && mixed[3][0] > 70 && mixed[3][0] < 235, 'hard/soft overlap preserves the later effect and its soft boundary');
    await page.evaluate(() => __set([__region('first', 0, 1), __region('later', 0.25, 1, 0.2)]));
    assert.deepEqual(await page.evaluate(() => __samples([[20, 90], [280, 90]])), [[255, 255, 255], [51, 51, 51]], 'the later region wins fully inside an overlap');
    await page.evaluate(() => __set([__region('center', 0.4, 0.6)]));
    const outside = await page.evaluate(() => __samples([[110, 90], [124, 90], [160, 90], [210, 90]]));
    assert.ok(outside[0][0] === 51 && outside[1][0] > 51 && outside[2][0] > 250 && outside[3][0] === 51, `feather crosses the original polygon boundary without expanding indefinitely: ${JSON.stringify(outside)}`);

    await page.evaluate(() => __set([__region('whole', 0, 1, 1, 0.3)], { fit: 'contain' }, 320, 320));
    assert.deepEqual(await page.evaluate(() => __samples([[100, 30], [100, 69], [100, 250], [100, 290]])), Array(4).fill([20, 40, 60]), 'feather does not spill image pixels into contain letterboxes');
    await page.evaluate(() => __set([__region('whole', 0, 1, 1, 0.3)], { fit: 'cover' }, 64, 320));
    assert.ok((await page.evaluate(() => __samples([[1, 1], [62, 1], [1, 318], [62, 318], [32, 160]]))).every(pixel => pixel[0] > 250), 'extreme narrow cover retains all visible outer-edge coverage');
    assert.ok(await page.evaluate(() => __offscreen.every(canvas => canvas.width * canvas.height <= 1000000)), 'mask padding never creates oversized buffers');

    if (process.env.RENDERER_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.RENDERER_ARTIFACT_DIR, { recursive: true });
      await page.evaluate(() => {
        __set([__region('left', 0, 0.5, 1, 0)]);
        const panel = document.createElement('div'), title = document.createElement('p'), canvas = document.createElement('canvas');
        title.textContent = '6% — feathered edge'; canvas.dataset.output = 'true'; panel.append(title, canvas); document.querySelector('#comparison').append(panel);
        window.__comparison = FrostedRegions.createCompositor({ source: __fx.source, canvas });
        __comparison.update({ ...__fx.base, regions: { enabled: true, items: [__region('left', 0, 0.5)] } });
      });
      await page.screenshot({ path: path.join(process.env.RENDERER_ARTIFACT_DIR, 'feather-comparison.png') });
    }
    await page.evaluate(() => { __fx.compositor.dispose(); window.__comparison?.dispose(); });
    assert.ok(await page.evaluate(() => __offscreen.filter(canvas => !canvas.dataset.output).every(canvas => canvas.width * canvas.height === 1)), 'disposing releases every mask and scratch buffer');
  } finally { await browser.close(); }
});

test('complete compression keeps all four image and video edges visible in small code viewports', {
  skip: !process.env.PLAYWRIGHT_MODULE,
  timeout: 60000,
}, async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const executablePath = process.env.BROWSER_EXECUTABLE || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(value => fs.existsSync(value));
  const renderer = bundledRuntime('renderer.js');
  const playerScript = bundledRuntime('video-player.js');
  const mediaName = `media-${'c'.repeat(64)}.webm`;
  const playerName = `video-host-${'d'.repeat(64)}.html`;
  const playerHtml = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; connect-src \'self\'; media-src blob:; style-src \'unsafe-inline\';"><body><script src="./video-player.js" defer></script></body>';
  function edgeFixture(video) {
    const config = {
      enabled: true, kind: video ? 'video' : 'image', fit: 'fill', blur: 0, opacity: 1, tintOpacity: 0,
      source: video ? `./frosted-background-assets/${mediaName}` : './edges.png',
      ...(video ? { videoPlayer: `./frosted-background-assets/${playerName}` } : {}),
    };
    // Match the workbench hierarchy: breadcrumbs belong to the opaque title,
    // while the right minimap is inside Monaco's scrollable area. The separate
    // code-surface marks the visible region; it is not consulted by the renderer.
    return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; frame-src 'self'; connect-src 'self';"><style>
      :root { --vscode-editor-background:#181818; } * { box-sizing:border-box; }
      body { margin:0;background:#333; } .part.editor { position:absolute;inset:20px;--title-height:56px;background:var(--vscode-editor-background); }
      .content,.editor-group-container,.editor-instance,.monaco-editor,.overflow-guard { width:100%;height:100%;background:var(--vscode-editor-background); }
      .title { height:var(--title-height);background:#101010; } .tabs-container { height:34px; } .breadcrumbs-control { height:22px;background:#080808; }
      .editor-container { height:calc(100% - var(--title-height)); } .monaco-editor,.overflow-guard { position:relative; }
      .overflow-guard { background:transparent; } .editor-scrollable { position:absolute;inset:0; }
      #code-surface { position:absolute;left:0;right:60px;top:0;bottom:12px;background:var(--vscode-editor-background); }
      .minimap { position:absolute;right:12px;top:0;bottom:0;width:48px;background:#111; }
      .scrollbar.vertical { position:absolute;right:0;top:0;bottom:0;width:12px;background:#222; }
      .scrollbar.horizontal { position:absolute;left:0;right:12px;bottom:0;height:12px;background:#222; }
      .minimap-left .minimap { left:0;right:auto; } .minimap-left #code-surface { left:48px;right:12px; }
    </style><main class="part editor"><div class="content"><div class="editor-group-container"><div class="title"><div class="tabs-container"></div><div class="breadcrumbs-below-tabs"><div class="breadcrumbs-control"></div></div></div><div class="editor-container"><div class="editor-instance"><div class="monaco-editor"><div class="overflow-guard"><div class="editor-scrollable"><div id="code-surface" class="monaco-editor-background"></div><div class="minimap"></div><div class="scrollbar vertical"></div><div class="scrollbar horizontal"></div></div></div></div></div></div></div></div></main><script src="./renderer.js" data-frosted-config="${JSON.stringify(config).replace(/"/g, '&quot;')}"></script>`;
  }
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 340, height: 240 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://edges.test/**', async route => {
      const requested = new URL(route.request().url());
      if (requested.pathname === '/index.html') return route.fulfill({ contentType: 'text/html', body: edgeFixture(requested.searchParams.has('video')) });
      const assets = new Map([
        ['/renderer.js', ['text/javascript', renderer]],
        ['/edges.png', ['image/png', fs.readFileSync(path.join(__dirname, 'fixtures/edges.png'))]],
        [`/frosted-background-assets/${mediaName}`, ['video/webm', fs.readFileSync(path.join(__dirname, 'fixtures/edges.webm'))]],
        [`/frosted-background-assets/${playerName}`, ['text/html', playerHtml]],
        ['/frosted-background-assets/video-player.js', ['text/javascript', playerScript]],
      ]);
      const asset = assets.get(requested.pathname);
      return route.fulfill(asset ? { contentType: asset[0], body: asset[1] } : { status: 404, body: '' });
    });
    async function verifyVisibleEdges(label) {
      await page.waitForFunction(() => {
        const visible = document.querySelector('#code-surface').getBoundingClientRect();
        const layer = document.querySelector('.frosted-background-layer').getBoundingClientRect();
        return ['x', 'y', 'width', 'height'].every(key => Math.abs(visible[key] - layer[key]) < 0.1);
      });
      const box = await page.locator('#code-surface').boundingBox();
      const screenshot = await page.screenshot();
      // Read the composited screenshot, not image source pixels or object-fit.
      // Opaque titles/minimaps, incorrect media sizing or cropping all fail here.
      const samples = await page.evaluate(async ({ bytes, box }) => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
        const read = (x, y) => [...context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data].slice(0, 3);
        return {
          top: read(box.x + box.width / 2, box.y + 2), bottom: read(box.x + box.width / 2, box.y + box.height - 3),
          left: read(box.x + 2, box.y + box.height / 2), right: read(box.x + box.width - 3, box.y + box.height / 2),
        };
      }, { bytes: [...screenshot], box });
      const diagnostic = `${label}: ${JSON.stringify({ box, samples })}`;
      assert.ok(samples.top[0] > 160 && samples.top[1] < 100 && samples.top[2] < 100, `top red edge remains visible; ${diagnostic}`);
      assert.ok(samples.bottom[2] > 160 && samples.bottom[0] < 100 && samples.bottom[1] < 100, `bottom blue edge remains visible; ${diagnostic}`);
      assert.ok(samples.left[1] > 160 && samples.left[0] < 100 && samples.left[2] < 100, `left green edge remains visible; ${diagnostic}`);
      assert.ok(samples.right[0] > 160 && samples.right[1] > 160 && samples.right[2] < 100, `right yellow edge remains visible; ${diagnostic}`);
      assert.equal(await page.locator('.frosted-background-media').count(), 1, 'one shared media surface');
      assert.equal(await page.locator('.monaco-editor').evaluate(el => getComputedStyle(el).filter), 'none');
      assert.equal(await page.locator('.title').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(16, 16, 16)', 'tabs retain their readable native surface');
      assert.equal(await page.locator('.minimap').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(17, 17, 17)', 'minimap is not made globally transparent');
    }
    for (const kind of ['image', 'video']) {
      await page.goto(`https://edges.test/index.html${kind === 'video' ? '?video=1' : ''}`);
      await page.waitForSelector('.frosted-background-ready');
      const frame = kind === 'video' ? page.frames().find(value => value.url().includes(playerName)) : undefined;
      if (frame) {
        await frame.waitForFunction(() => document.querySelector('video').readyState >= 2 && !document.querySelector('video').paused);
        const start = await frame.locator('video').evaluate(video => video.currentTime);
        await frame.waitForFunction(start => document.querySelector('video').currentTime !== start, start);
      }
      await verifyVisibleEdges(`${kind} initial`);
      await page.setViewportSize({ width: 220, height: 420 });
      await verifyVisibleEdges(`${kind} narrow/tall`);
      await page.locator('.monaco-editor').evaluate(element => {
        const widget = document.createElement('div'); widget.className = 'suggest-widget';
        widget.innerHTML = '<div class="scrollbar vertical" style="left:40px;top:45px;width:8px;height:40px;background:transparent"></div>';
        element.append(widget);
      });
      await verifyVisibleEdges(`${kind} nested suggestion scrollbar does not shrink the wallpaper`);
      await page.locator('.suggest-widget').evaluate(element => element.remove());
      await page.setViewportSize({ width: 680, height: 180 });
      await verifyVisibleEdges(`${kind} wide/short`);
      await page.setViewportSize({ width: 340, height: 240 });
      await page.locator('.part.editor').evaluate(element => element.style.setProperty('--title-height', '78px'));
      await page.locator('.monaco-editor').evaluate(element => element.classList.add('minimap-left'));
      await verifyVisibleEdges(`${kind} moved minimap and expanded title`);
    }
    assert.deepEqual(errors, [], 'fill layout and video player raise no uncaught errors');
  } finally { await browser.close(); }
});
