'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { renderPanelHtml } = require('../src/panel-ui');
const { DEFAULTS } = require('../src/config');
const { normalizeLanguage, t, dictionaries } = require('../media/i18n');

test('panel localization catalog covers markup and defaults to English without a first-render flash', () => {
  assert.equal(normalizeLanguage('es'), 'es');
  assert.equal(normalizeLanguage('zh-CN'), 'zh-CN');
  for (const value of [undefined, null, 'fr', 'EN', {}, '__proto__']) assert.equal(normalizeLanguage(value), 'en');
  const options = { cspSource: 'file:', nonce: 'test', scriptUri: 'panel.js', styleUri: 'panel.css', i18nUri: 'i18n.js', regionsUri: 'regions.js' };
  const html = renderPanelHtml(options);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title[^>]*>Frosted Background<\/title>/);
  assert.ok(html.indexOf('src="i18n.js"') < html.indexOf('src="panel.js"'));
  assert.deepEqual([...html.matchAll(/>([^<>]*[\u3400-\u9fff][^<>]*)</g)].map(match => match[1]), ['简体中文'], 'only the native language name is Chinese in the English first render');
  for (const match of html.matchAll(/data-i18n(?:-aria-label|-title)?="([^"]+)"/g)) {
    for (const language of ['en', 'zh-CN', 'es']) assert.equal(typeof dictionaries[language][match[1]], 'string', `${language}: ${match[1]}`);
  }
  for (const language of ['en', 'zh-CN', 'es']) {
    assert.deepEqual(Object.keys(dictionaries[language]), Object.keys(dictionaries.en));
    assert.match(renderPanelHtml({ ...options, language }), new RegExp(`<html lang="${language}">`));
  }
  assert.equal(t('es', '发现 v{version}', { version: '0.7.0' }), 'v0.7.0 disponible');
  assert.equal(t('en', '发现 v{version}', { version: '<script>' }), 'v<script> available', 'parameters stay plain text for DOM consumers');
  assert.equal(t('en', '__proto__'), '__proto__');
});

test('live controls coalesce edits, preserve newer drafts across acknowledgements, and use one Apply action', {
  skip: !process.env.PLAYWRIGHT_MODULE,
  timeout: 30000,
}, async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const executablePath = process.env.BROWSER_EXECUTABLE || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(value => fs.existsSync(value));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frosted-live-panel-test-'));
  const fixtureFile = path.join(directory, 'panel.html');
  fs.writeFileSync(fixtureFile, renderPanelHtml({
    cspSource: 'file:', nonce: 'live-panel-test-nonce',
    scriptUri: pathToFileURL(path.resolve(__dirname, '../media/panel.js')).href,
    styleUri: pathToFileURL(path.resolve(__dirname, '../media/panel.css')).href,
    i18nUri: pathToFileURL(path.resolve(__dirname, '../media/i18n.js')).href,
    regionsUri: pathToFileURL(path.resolve(__dirname, '../media/regions.js')).href,
  }));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width: 280, height: 620 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__messages = [];
      window.__violations = [];
      window.acquireVsCodeApi = () => ({
        getState: () => window.__saved,
        setState: value => { window.__saved = value; },
        postMessage: value => window.__messages.push(value),
      });
      document.addEventListener('securitypolicyviolation', event => window.__violations.push(event.violatedDirective));
    });
    await page.goto(pathToFileURL(fixtureFile).href);
    await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2030-01-01T00:01:00Z'));
    const media = { kind: 'image', name: 'wallpaper.png', uri: pathToFileURL(path.resolve(__dirname, 'fixtures/wallpaper.png')).href };
    let state = { type: 'state', language: 'en', config: { ...DEFAULTS }, defaults: DEFAULTS, media, enabled: true, busy: false, needsReload: false, liveEnabled: true, liveApplying: false, liveAck: 0, resetDraft: false, error: null, notice: null };
    const sendState = async changes => {
      state = { ...state, ...changes };
      await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), state);
    };
    const liveMessages = () => page.evaluate(() => window.__messages.filter(message => message.type === 'liveConfig'));
    const changeBlur = async value => { await page.locator('#blur').fill(String(value)); await page.locator('#blur').dispatchEvent('input'); };
    await sendState();
    await changeBlur(20);
    await page.clock.runFor(100);
    await changeBlur(21);
    await page.clock.runFor(100);
    await changeBlur(22);
    await page.clock.runFor(249);
    assert.deepEqual(await liveMessages(), [], 'rapid edits wait for the full 250ms debounce');
    await page.clock.runFor(1);
    const first = (await liveMessages())[0];
    assert.equal(first.requestId, 1);
    assert.equal(first.config.blur, 22);
    assert.equal(await page.locator('#blur').isEnabled(), true, 'an unacknowledged live request never disables sliders');
    assert.equal(await page.locator('#apply').isEnabled(), false, 'manual Apply waits for the active live request');
    assert.equal(await page.locator('#panel').getAttribute('aria-busy'), 'false');

    await changeBlur(31);
    await page.locator('input[name="fit"][value="fill"]').check();
    await page.locator('#position').selectOption('center top');
    await page.clock.runFor(250);
    assert.equal((await liveMessages()).length, 1, 'a newer edit queues behind the unacknowledged request');
    await sendState({ liveApplying: true, language: 'es' });
    assert.equal(await page.locator('#blur').isEnabled(), true);
    assert.equal(await page.locator('#blur').inputValue(), '31');
    await page.locator('#language').selectOption('zh-CN');
    assert.equal(await page.locator('#draft-label').textContent(), dictionaries['zh-CN']['正在自动应用最新效果…']);
    await sendState({ language: 'zh-CN', liveApplying: false, liveAck: first.requestId, config: first.config, resetDraft: true });
    const second = (await liveMessages())[1];
    assert.equal(second.requestId, 2);
    assert.equal(second.config.blur, 31);
    assert.equal(second.config.fit, 'fill');
    assert.equal(second.config.position, 'center top');
    assert.equal(await page.locator('#blur').inputValue(), '31', 'the first acknowledgement cannot replace a newer draft');
    assert.equal(await page.evaluate(() => window.__saved.dirty), true);
    await sendState({ liveAck: first.requestId, config: first.config, resetDraft: true });
    assert.equal(await page.locator('#blur').inputValue(), '31', 'a repeated older acknowledgement cannot reset the in-flight draft');
    await sendState({ liveAck: second.requestId, config: second.config, resetDraft: true });
    assert.equal(await page.evaluate(() => window.__saved.dirty), false);
    assert.equal(await page.locator('#draft-label').isVisible(), false, 'idle live state has no repeated success instructions');
    await sendState({ liveAck: first.requestId, config: first.config, resetDraft: true });
    assert.equal(await page.locator('#blur').inputValue(), '31', 'late snapshots cannot roll back an already-acknowledged draft');
    await sendState({ liveAck: second.requestId, config: second.config, resetDraft: false });

    await changeBlur(40);
    await page.clock.runFor(250);
    const third = (await liveMessages())[2];
    await sendState({ liveAck: third.requestId, resetDraft: false, error: '<strong>Save failed</strong>' });
    assert.equal(await page.locator('#blur').inputValue(), '40');
    assert.equal(await page.evaluate(() => window.__saved.dirty), true);
    assert.equal(await page.locator('#apply').isEnabled(), true);
    assert.equal(await page.locator('#error strong').count(), 0);
    for (const language of ['en', 'es', 'zh-CN']) {
      await page.locator('#language').selectOption(language);
      assert.equal(await page.locator('#draft-label').textContent(), dictionaries[language]['自动应用失败，请点击应用重试。']);
      assert.equal(await page.locator('#apply-label').textContent(), dictionaries[language]['应用']);
    }
    await page.clock.runFor(1000);
    assert.equal((await liveMessages()).length, 3, 'a failed request does not enter an automatic retry loop');
    await page.locator('#apply').click();
    assert.deepEqual(await page.evaluate(() => window.__messages.at(-1)), { type: 'apply', config: third.config, reloadAfterApply: true });
    await sendState({ busy: false, config: third.config, resetDraft: true, error: null });

    await page.locator('#opacity').fill('0.55');
    await page.locator('#opacity').dispatchEvent('input');
    await page.locator('#choose-image').click();
    await page.clock.runFor(250);
    assert.equal((await liveMessages()).length, 3, 'queued settings wait while the native file picker is open');
    await sendState({ busy: false, resetDraft: false });
    const fourth = (await liveMessages())[3];
    assert.equal(fourth.config.opacity, 0.55, 'canceling the picker preserves the pending change for the existing background');
    await sendState({ config: fourth.config, liveAck: fourth.requestId, resetDraft: true });
    await page.locator('#opacity').fill('0.65');
    await page.locator('#opacity').dispatchEvent('input');
    await page.locator('#choose-video').click();
    const choosing = await page.evaluate(() => window.__messages.at(-1));
    assert.equal(choosing.type, 'chooseMedia');
    assert.equal(choosing.kind, 'video');
    assert.equal(choosing.config.opacity, 0.65, 'media selection applies the current full draft');
    assert.equal(Object.keys(choosing.config).length, Object.keys(DEFAULTS).length);
    await page.clock.runFor(1000);
    assert.equal((await liveMessages()).length, 4, 'media selection holds the queued effect change until the picker returns');
    assert.equal(await page.evaluate(() => window.__messages.filter(message => message.type === 'reload').length), 0, 'media selection never triggers an automatic reload');
    await sendState({ config: choosing.config, resetDraft: true });
    await page.clock.runFor(250);
    assert.equal((await liveMessages()).length, 4, 'successful media selection consumes its matching queued change without duplicate writes');

    await sendState({ liveEnabled: false, enabled: false, resetDraft: false, language: 'en' });
    await changeBlur(12);
    await page.clock.runFor(1000);
    assert.equal((await liveMessages()).length, 4, 'first setup retains the manual fallback');
    await page.locator('#apply').click();
    const initialApply = await page.evaluate(() => window.__messages.at(-1));
    assert.equal(initialApply.reloadAfterApply, true);
    assert.equal(initialApply.config.blur, 12);
    await sendState({ config: initialApply.config, enabled: true, needsReload: true, resetDraft: true });
    assert.equal(await page.locator('#apply-label').textContent(), 'Apply');
    assert.equal(await page.locator('#draft-label').textContent(), dictionaries.en['点击应用将重载窗口，完成背景设置。']);
    assert.equal(await page.locator('#reload').count(), 0);
    await page.locator('#apply').click();
    assert.deepEqual(await page.evaluate(() => window.__messages.at(-1)), { type: 'reload' });

    await sendState({ media: null, enabled: false, busy: false, update: { currentVersion: '0.7.0', pendingVersion: '0.8.0', mode: 'automatic' } });
    assert.equal(await page.locator('#apply').isEnabled(), true, 'a prepared extension update can be applied without a background file');
    assert.equal(await page.locator('#draft-label').textContent(), dictionaries.en['点击应用将重载窗口，完成插件更新。']);
    await page.locator('#apply').click();
    assert.deepEqual(await page.evaluate(() => window.__messages.at(-1)), { type: 'reload' });
    assert.equal(await page.evaluate(() => window.__saved.liveRequestId), fourth.requestId, 'request IDs persist across webview recreation');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(await page.evaluate(() => window.__violations), []);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('regions preview independent effects, keep source coordinates, and support templates, drawing and video', {
  skip: !process.env.PLAYWRIGHT_MODULE,
  timeout: 45000,
}, async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const executablePath = process.env.BROWSER_EXECUTABLE || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(value => fs.existsSync(value));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frosted-regions-panel-'));
  const fixtureFile = path.join(directory, 'regions.html');
  fs.writeFileSync(fixtureFile, renderPanelHtml({
    cspSource: 'file:', nonce: 'regions-test',
    scriptUri: pathToFileURL(path.resolve(__dirname, '../media/panel.js')).href,
    styleUri: pathToFileURL(path.resolve(__dirname, '../media/panel.css')).href,
    i18nUri: pathToFileURL(path.resolve(__dirname, '../media/i18n.js')).href,
    regionsUri: pathToFileURL(path.resolve(__dirname, '../media/regions.js')).href,
  }));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width: 280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__messages = []; window.__violations = [];
      window.acquireVsCodeApi = () => ({ getState: () => window.__saved, setState: value => { window.__saved = value; }, postMessage: message => window.__messages.push(message) });
      document.addEventListener('securitypolicyviolation', event => window.__violations.push(event.violatedDirective));
    });
    await page.goto(pathToFileURL(fixtureFile).href);
    await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2030-01-01T00:01:00Z'));
    const imageUri = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d');
      for (let x = 0; x < 320; x += 4) { context.fillStyle = (x / 4) % 2 ? '#fff' : '#000'; context.fillRect(x, 0, 4, 180); }
      return canvas.toDataURL();
    });
    let state = { type: 'state', language: 'en', config: { ...DEFAULTS, fit: 'fill', blur: 24, opacity: 1, tintOpacity: 0 }, defaults: DEFAULTS, media: { kind: 'image', name: 'stripes.png', uri: imageUri }, enabled: true, busy: false, needsReload: false, liveEnabled: true, liveApplying: false, liveAck: 0, resetDraft: false, error: null, notice: null, update: { currentVersion: '0.8.0', status: 'idle', mode: 'automatic', message: 'Already up to date.' } };
    const sendState = async changes => {
      state = { ...state, resetDraft: false, ...changes };
      await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), state);
    };
    const acknowledge = async () => {
      await page.clock.runFor(250);
      const message = await page.evaluate(() => window.__messages.filter(item => item.type === 'liveConfig').at(-1));
      assert.ok(message, 'regional edits use the live config channel');
      await sendState({ config: message.config, liveAck: message.requestId, resetDraft: true });
      return message.config;
    };
    await sendState();
    await page.locator('#preview-media img').evaluate(image => image.decode());
    assert.equal(await page.locator('#notice').isVisible(), false, 'routine background success is silent');
    assert.equal(await page.locator('#draft-label').isVisible(), false);
    assert.equal(await page.locator('.panel-footnote').count(), 0);
    assert.equal(await page.locator('#update-message').isVisible(), false, 'idle updater feedback is quiet');
    await sendState({ notice: 'Effects applied, but preferences could not be saved.' });
    assert.equal(await page.locator('#notice').isVisible(), true, 'a useful settings-save warning remains visible without reload');
    await sendState({ notice: null });
    await page.locator('#regions-section summary').click();
    await page.locator('#region-template-apply').click();
    const initial = await acknowledge();
    assert.equal(initial.regions.enabled, true);
    assert.equal(initial.regions.items.length, 2);
    assert.equal(await page.evaluate(() => window.__saved.dirty), false, 'structurally equal acknowledged region objects are clean');
    assert.equal(await page.locator('#region-canvas').isVisible(), true);
    const contrast = await page.locator('#region-canvas').evaluate(canvas => {
      const context = canvas.getContext('2d');
      const variation = (start, end) => {
        const values = []; for (let x = Math.floor(start * canvas.width); x < end * canvas.width; x++) values.push(context.getImageData(x, Math.floor(canvas.height * 0.6), 1, 1).data[0]);
        const average = values.reduce((sum, value) => sum + value, 0) / values.length;
        return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
      };
      return { clear: variation(0.1, 0.4), blurred: variation(0.6, 0.9) };
    });
    assert.ok(contrast.clear > 70 && contrast.blurred < 30, `canvas visibly preserves a sharp region beside blur: ${JSON.stringify(contrast)}`);
    for (const [template, count] of [['horizontal', 2], ['columns', 3], ['grid', 4], ['center', 1]]) {
      await page.locator('#region-template').selectOption(template);
      await page.locator('#region-template-apply').click();
      const config = await acknowledge();
      assert.equal(config.regions.items.length, count);
      assert.ok(config.regions.items.every(region => region.points.every(point => point.every(value => value >= 0 && value <= 1))));
    }
    await page.locator('#region-name').fill('<b>My focus</b>');
    await page.locator('#region-name').dispatchEvent('input');
    for (const [key, value] of Object.entries({ blur: 17, opacity: 0.7, tintOpacity: 0.2, brightness: 1.3, saturation: 0.6 })) {
      await page.locator(`#region-${key}`).fill(String(value));
      await page.locator(`#region-${key}`).dispatchEvent('input');
    }
    let config = await acknowledge();
    assert.equal(config.regions.items[0].name, '<b>My focus</b>');
    assert.equal(config.regions.items[0].blur, 17);
    assert.equal(config.regions.items[0].opacity, 0.7);
    assert.equal(config.regions.items[0].tintOpacity, 0.2);
    assert.equal(config.regions.items[0].brightness, 1.3);
    assert.equal(config.regions.items[0].saturation, 0.6);
    assert.equal(await page.locator('#region-select b').count(), 0, 'region names are text, never markup');
    await page.locator('#region-sharp').click();
    config = await acknowledge();
    assert.equal(config.regions.items[0].blur, 0);
    assert.equal(config.blur, 24, 'regional sliders never overwrite the global effect');

    const portrait = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 320;
      const context = canvas.getContext('2d'); context.fillStyle = '#537a9a'; context.fillRect(0, 0, 180, 320);
      context.fillStyle = '#f9c760'; context.fillRect(10, 10, 160, 300); return canvas.toDataURL();
    });
    await sendState({ config: { ...config, fit: 'cover', regions: { enabled: true, items: [] } }, media: { kind: 'image', name: 'portrait.png', uri: portrait }, resetDraft: true });
    await page.locator('#preview-media img').evaluate(image => image.decode());
    await page.locator('#region-edit').click();
    assert.equal(await page.locator('.preview-code').isVisible(), false);
    assert.equal(await page.locator('#preview-media img').evaluate(image => getComputedStyle(image).objectFit), 'contain');
    await page.locator('[data-region-tool="rect"]').click();
    await page.locator('#region-overlay').scrollIntoViewIfNeeded();
    async function displayBounds() {
      return page.locator('#region-overlay').evaluate(svg => {
        const rect = svg.getBoundingClientRect();
        const media = document.querySelector('#preview-media > *');
        const width = media.naturalWidth || media.videoWidth, height = media.naturalHeight || media.videoHeight;
        const scale = Math.min(rect.width / width, rect.height / height);
        return { left: rect.left, top: rect.top, x: (rect.width - width * scale) / 2, y: (rect.height - height * scale) / 2, width: width * scale, height: height * scale };
      });
    }
    let bounds = await displayBounds();
    await page.mouse.move(bounds.left + 3, bounds.top + 30); await page.mouse.down(); await page.mouse.up();
    assert.equal(await page.evaluate(() => window.__saved.draft.regions.items.length), 0, 'portrait letterbox margins cannot start a region');
    await page.mouse.move(bounds.left + bounds.x + bounds.width * 0.1, bounds.top + bounds.y + bounds.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(bounds.left + bounds.x + bounds.width * 0.9, bounds.top + bounds.y + bounds.height * 0.8, { steps: 8 });
    await page.mouse.up();
    config = await acknowledge();
    const rectangle = config.regions.items[0];
    assert.ok(Math.abs(rectangle.points[0][0] - 0.1) < 0.01 && Math.abs(rectangle.points[0][1] - 0.2) < 0.01);
    assert.ok(Math.abs(rectangle.points[2][0] - 0.9) < 0.01 && Math.abs(rectangle.points[2][1] - 0.8) < 0.01);
    await page.evaluate(() => document.documentElement.style.setProperty('--vscode-editor-background', '#f7f6f4'));
    assert.deepEqual(await page.locator('#region-canvas').evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(2, Math.floor(canvas.height / 2), 1, 1).data).slice(0, 3)), [247, 246, 244], 'theme changes redraw the canvas tint immediately');
    await page.evaluate(() => document.documentElement.style.removeProperty('--vscode-editor-background'));
    await page.setViewportSize({ width: 360, height: 900 });
    bounds = await displayBounds();
    const projected = await page.locator('#region-overlay polygon').evaluate(polygon => ({ x: polygon.points.getItem(0).x, y: polygon.points.getItem(0).y }));
    assert.ok(Math.abs(projected.x - (bounds.x + rectangle.points[0][0] * bounds.width)) < 1);
    assert.ok(Math.abs(projected.y - (bounds.y + rectangle.points[0][1] * bounds.height)) < 1);
    assert.deepEqual(await page.evaluate(() => window.__saved.draft.regions.items[0].points), rectangle.points, 'resizing does not alter source anchors');

    await page.locator('[data-region-tool="polygon"]').click();
    await page.locator('#region-overlay').scrollIntoViewIfNeeded();
    bounds = await displayBounds();
    const circlePoint = angle => [bounds.left + bounds.x + bounds.width * (0.5 + 0.4 * Math.cos(angle)), bounds.top + bounds.y + bounds.height * (0.5 + 0.4 * Math.sin(angle))];
    await page.mouse.move(...circlePoint(0)); await page.mouse.down();
    for (let index = 1; index <= 130; index++) await page.mouse.move(...circlePoint(index * Math.PI * 2 / 130));
    await page.mouse.up();
    config = await acknowledge();
    const freehand = config.regions.items[1];
    assert.ok(freehand.points.length >= 8 && freehand.points.length <= 64);
    assert.ok(Math.min(...freehand.points.map(point => point[0])) < 0.13 && Math.max(...freehand.points.map(point => point[0])) > 0.87);
    assert.ok(Math.min(...freehand.points.map(point => point[1])) < 0.13 && Math.max(...freehand.points.map(point => point[1])) > 0.87, 'a long lasso preserves the late half of the stroke');
    await page.locator('[data-region-tool="rect"]').click();
    await page.locator('#region-overlay').focus();
    await page.keyboard.press('Space'); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Enter');
    config = await acknowledge();
    assert.equal(config.regions.items.length, 3, 'a rectangle can be created with the keyboard alone');
    assert.equal(await page.locator('#region-canvas').isVisible(), true, 'editing can show the actual regional effects');
    await page.locator('#region-show-effects').uncheck();
    assert.equal(await page.locator('#region-canvas').isVisible(), false);
    assert.equal(await page.locator('#preview-media img').evaluate(image => getComputedStyle(image).filter), 'none');
    await page.locator('#region-show-effects').check();
    await page.locator('#region-done').click();
    assert.equal(await page.locator('#region-overlay').isVisible(), false);
    assert.equal(await page.locator('#preview-media img').evaluate(image => getComputedStyle(image).objectFit), 'cover');
    await page.locator('input[name="fit"][value="fill"]').check();
    config = await acknowledge();
    assert.deepEqual(config.regions.items[0].points, rectangle.points, 'switching cover to fill keeps source coordinates');

    const many = Array.from({ length: 8 }, (_, index) => ({ ...rectangle, id: `limit-${index}`, name: `Area ${index + 1}` }));
    await sendState({ config: { ...config, regions: { enabled: true, items: many } }, resetDraft: true });
    await page.locator('#region-edit').click();
    assert.equal(await page.locator('[data-region-tool="rect"]').isEnabled(), false);
    assert.equal(await page.locator('#region-limit').isVisible(), true);
    await page.locator('#region-delete').click();
    config = await acknowledge();
    assert.equal(config.regions.items.length, 7);
    assert.equal(await page.locator('[data-region-tool="rect"]').isEnabled(), true);
    for (const language of ['zh-CN', 'es', 'en']) {
      await page.locator('#language').selectOption(language);
      assert.equal(await page.locator('#region-template-apply').textContent(), dictionaries[language]['套用模板']);
      assert.equal(await page.locator('#region-overlay').getAttribute('aria-label'), dictionaries[language]['区域绘制画布']);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.clock.resume();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const video = { kind: 'video', name: 'edges.webm', uri: pathToFileURL(path.resolve(__dirname, 'fixtures/edges.webm')).href };
    await sendState({ media: video, language: 'en' });
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
    await page.locator('video').evaluate(video => { window.__regionVideo = video; });
    await page.locator('#region-edit').click();
    await page.locator('#region-edit').click();
    assert.equal(await page.locator('video').count(), 1, 'regional video preview uses one decoder');
    assert.equal(await page.locator('video').evaluate(video => video === window.__regionVideo), true, 'opening and closing the editor preserves the media element');
    await sendState({ media: { kind: 'image', name: 'missing.png', uri: 'data:image/png;base64,AA==' } });
    await page.waitForFunction(() => !document.querySelector('#preview-error').hidden);
    assert.equal(await page.locator('#region-canvas').isVisible(), false, 'a failed new media source cannot display the previous canvas bitmap');
    assert.equal(await page.locator('#region-canvas').evaluate(canvas => canvas.width), 1);
    await sendState({ media: { kind: 'image', name: 'portrait.png', uri: portrait }, error: 'A real error remains visible.' });
    await page.locator('#preview-media img').evaluate(image => image.decode());
    assert.equal(await page.locator('#error').isVisible(), true);
    await page.setViewportSize({ width: 280, height: 620 });
    await page.locator('#region-saturation').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const sliderBox = await page.locator('#region-saturation').boundingBox(), footerBox = await page.locator('.action-bar').boundingBox();
    assert.ok(sliderBox.y >= 0 && sliderBox.y + sliderBox.height <= footerBox.y, 'all five regional controls are reachable above the sticky footer');
    assert.deepEqual(await page.evaluate(() => window.__violations), []);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('sidebar previews drafts, sends explicit actions, and stays usable across widths and themes', {
  skip: !process.env.PLAYWRIGHT_MODULE,
  timeout: 30000,
}, async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const executablePath = process.env.BROWSER_EXECUTABLE || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(value => fs.existsSync(value));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frosted-panel-test-'));
  const fixtureFile = path.join(directory, 'panel.html');
  fs.writeFileSync(fixtureFile, renderPanelHtml({
    cspSource: 'file:', nonce: 'panel-test-nonce',
    scriptUri: pathToFileURL(path.resolve(__dirname, '../media/panel.js')).href,
    styleUri: pathToFileURL(path.resolve(__dirname, '../media/panel.css')).href,
    i18nUri: pathToFileURL(path.resolve(__dirname, '../media/i18n.js')).href,
    regionsUri: pathToFileURL(path.resolve(__dirname, '../media/regions.js')).href,
  }));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width: 340, height: 960 } });
    await page.addInitScript(() => {
      window.__messages = [];
      window.__saved = undefined;
      window.__violations = [];
      window.acquireVsCodeApi = () => ({
        getState: () => window.__saved,
        setState: value => { window.__saved = value; },
        postMessage: value => window.__messages.push(value),
      });
      document.addEventListener('securitypolicyviolation', event => window.__violations.push(event.violatedDirective));
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(fixtureFile).href);
    assert.deepEqual(await page.evaluate(() => window.__messages), [{ type: 'ready' }]);
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.equal(await page.locator('h1').textContent(), 'Frosted Background');
    assert.equal(await page.getByRole('button', { name: 'Close control panel' }).count(), 1);
    const media = {
      name: '山谷 · 清晨.png', kind: 'image',
      uri: pathToFileURL(path.resolve(__dirname, 'fixtures/wallpaper.png')).href,
    };
    let state = { type: 'state', language: 'zh-CN', config: { ...DEFAULTS }, defaults: { ...DEFAULTS }, enabled: false, media, busy: false, error: null, notice: null, needsReload: false };
    const sendState = async changes => {
      state = { ...state, ...changes };
      await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), state);
    };
    await sendState();
    await page.locator('#preview-media img').evaluate(image => image.decode());
    assert.equal(await page.locator('#apply').isEnabled(), true);
    assert.equal(await page.locator('#video-section').isVisible(), false);
    assert.equal(await page.locator('#update-section').isVisible(), false, 'older hosts can omit updater state');
    assert.equal(await page.locator('.preview-code').evaluate(el => getComputedStyle(el).filter), 'none');

    await sendState({ config: { ...DEFAULTS, blur: 20 } });
    assert.equal(await page.locator('#blur').inputValue(), '20', 'clean controls follow external settings changes');
    assert.equal(await page.locator('#draft-label').getAttribute('class'), 'draft-label');

    await page.locator('#blur').fill('31');
    await page.locator('#blur').dispatchEvent('input');
    assert.equal(await page.locator('#blur-value').textContent(), '31 px');
    assert.match(await page.locator('#preview-media img').evaluate(el => getComputedStyle(el).filter), /blur\(10\.54px\)/);
    assert.equal(await page.evaluate(() => window.__messages.filter(item => ['apply', 'liveConfig'].includes(item.type)).length), 0, 'before first setup, sliders update only the local preview');
    const savedDraft = await page.evaluate(() => window.__saved);
    await sendState({ busy: true });
    assert.equal(await page.getByRole('button', { name: '关闭控制面板' }).isEnabled(), true);
    await page.getByRole('button', { name: '关闭控制面板' }).focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.__messages.at(-1)), { type: 'closePanel' });
    assert.deepEqual(await page.evaluate(() => window.__saved), savedDraft, 'close preserves unsaved controls');
    assert.equal(await page.locator('#blur').inputValue(), '31');
    assert.equal(await page.evaluate(() => window.__messages.filter(item => item.type === 'restore').length), 0, 'closing does not disable the background');
    await sendState({ busy: false });
    await sendState({ config: { ...DEFAULTS, blur: 8 } });
    assert.equal(await page.locator('#blur').inputValue(), '31', 'external changes preserve an unsaved local draft');

    const update = { currentVersion: '0.5.0', repository: 'example/frosted-background', mode: 'automatic', status: 'idle', message: '已是最新版本。', availableVersion: null, pendingVersion: null };
    await sendState({ update });
    assert.equal(await page.locator('#update-section').isVisible(), true);
    assert.equal(await page.locator('#current-version').textContent(), 'v0.5.0');
    assert.equal(await page.locator('#blur').inputValue(), '31', 'update status never resets background drafts');
    await page.locator('#check-updates').click();
    assert.deepEqual(await page.evaluate(() => window.__messages.at(-1)), { type: 'checkUpdates' });
    await sendState({ update: { ...update, status: 'checking', message: '正在检查…' } });
    assert.equal(await page.locator('#check-updates').isEnabled(), false);
    await sendState({ update: { ...update, status: 'installing', availableVersion: '0.6.0' } });
    assert.equal(await page.locator('#check-updates').isEnabled(), false);
    assert.equal(await page.locator('#available-version').textContent(), '发现 v0.6.0');
    await sendState({ update: { ...update, status: 'available', availableVersion: '0.6.0', message: '<img onerror=alert(1)>新版本可用' } });
    assert.equal(await page.locator('#update-message img').count(), 0);
    assert.equal(await page.locator('#update-message').textContent(), '<img onerror=alert(1)>新版本可用');
    await page.locator('#update-mode').selectOption('notify');
    assert.deepEqual(await page.evaluate(() => window.__messages.at(-1)), { type: 'setUpdateMode', mode: 'notify' });
    await sendState({ update: { ...update, mode: 'notify', repository: '', status: 'unconfigured' } });
    assert.equal(await page.locator('#check-updates').isEnabled(), false);
    assert.equal(await page.locator('#update-mode').isEnabled(), true, 'an unconfigured updater still permits turning updates off');
    await page.locator('#update-mode').selectOption('off');
    assert.deepEqual(await page.evaluate(() => window.__messages.at(-1)), { type: 'setUpdateMode', mode: 'off' });
    await sendState({ update: { ...update, pendingVersion: '0.6.0' }, needsReload: true });
    assert.equal(await page.locator('#available-version').textContent(), 'v0.6.0 · 待重载');
    assert.equal(await page.locator('#reload').count(), 0, 'reload is combined into the primary Apply action');
    assert.match(await page.locator('#draft-label').textContent(), /点击应用将重载窗口/);
    assert.equal(await page.locator('#blur').inputValue(), '31');
    await sendState({ update: null, needsReload: false });
    await page.locator('#choose-image').click();
    assert.deepEqual(await page.evaluate(() => window.__messages.at(-1)), { type: 'chooseMedia', kind: 'image', config: savedDraft.draft });
    await sendState({ media: { ...media, name: '<img onerror=alert(1)>.png' } });
    assert.equal(await page.locator('#blur').inputValue(), '31', 'selecting a file preserves unsaved settings');
    assert.equal(await page.locator('#media-name').textContent(), '<img onerror=alert(1)>.png');
    assert.equal(await page.locator('#media-name img').count(), 0, 'filenames are plain text');

    await page.locator('[data-preset="clear"]').click();
    assert.equal(await page.locator('#blur').inputValue(), '5');
    await page.locator('input[name="fit"][value="contain"]').check();
    assert.equal(await page.locator('#preview-media img').evaluate(el => getComputedStyle(el).objectFit), 'contain');
    await page.locator('input[name="fit"][value="fill"]').check();
    assert.equal(await page.locator('input[name="fit"][value="fill"] + span').textContent(), '完整压缩');
    assert.equal(await page.locator('#fit-description').textContent(), '完整画面压缩到编辑区，不裁剪；可能改变比例');
    const imageStretch = await page.locator('#preview-media img').evaluate(el => ({
      fit: getComputedStyle(el).objectFit, transform: getComputedStyle(el).transform,
      displayedRatio: el.clientWidth / el.clientHeight, naturalRatio: el.naturalWidth / el.naturalHeight,
    }));
    assert.equal(imageStretch.fit, 'fill');
    assert.equal(imageStretch.transform, 'none');
    assert.ok(Math.abs(imageStretch.displayedRatio - imageStretch.naturalRatio) > 0.1, 'fill permits a display ratio different from the image source');
    await page.locator('#position').selectOption('center top');
    await page.locator('#apply').click();
    const applying = await page.evaluate(() => window.__messages.at(-1));
    assert.equal(applying.type, 'apply');
    assert.equal(applying.reloadAfterApply, true);
    assert.equal(applying.config.blur, 5);
    assert.equal(applying.config.fit, 'fill');
    assert.equal(applying.config.position, 'center top');
    assert.equal(Object.keys(applying.config).length, Object.keys(DEFAULTS).length);
    assert.equal(await page.locator('#apply').isEnabled(), false);
    await sendState({ config: applying.config, resetDraft: true, enabled: true, needsReload: true, notice: '背景已准备好，重载窗口后生效。' });
    assert.equal(await page.locator('#draft-label').getAttribute('class'), 'draft-label requires-reload');
    assert.match(await page.locator('#draft-label').textContent(), /点击应用将重载窗口/);
    await page.locator('#apply').click();
    assert.deepEqual(await page.evaluate(() => window.__messages.at(-1)), { type: 'reload' });

    await sendState({ resetDraft: false, needsReload: false, notice: null });
    await page.locator('#restore').click();
    assert.deepEqual(await page.evaluate(() => window.__messages.at(-1)), { type: 'restore' });
    await sendState({ enabled: false, error: '示例：安装目录暂时不可写。' });
    assert.match(await page.locator('#error').textContent(), /安装目录/);
    await page.locator('#reset').click();
    assert.equal(await page.locator('#blur').inputValue(), '14');

    const clip = pathToFileURL(path.resolve(__dirname, 'fixtures/colors.webm')).href;
    await sendState({ config: { ...DEFAULTS, fit: 'fill' }, resetDraft: true, media: { name: '静音循环.webm', kind: 'video', uri: clip }, error: null });
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
    assert.equal(await page.locator('#video-section').isVisible(), true);
    assert.equal(await page.locator('video').evaluate(video => video.muted && video.loop && !video.controls), true);
    assert.equal(await page.locator('video').evaluate(video => getComputedStyle(video).objectFit), 'fill', 'saved stretch layout is normalized and previewed for video');
    assert.equal(await page.locator('input[name="fit"][value="fill"]').isChecked(), true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.querySelector('video').paused);
    await page.locator('#playbackRate').fill('1.5');
    await page.locator('#playbackRate').dispatchEvent('input');
    assert.equal(await page.locator('video').evaluate(video => video.playbackRate), 1.5);

    await page.locator('video').evaluate(video => { video.currentTime = 0.2; window.__previewNode = video; });
    await page.waitForFunction(() => !document.querySelector('video').seeking);
    const languageDraft = await page.evaluate(() => window.__saved);
    const languageTime = await page.locator('video').evaluate(video => video.currentTime);
    await page.locator('video').dispatchEvent('error');
    await sendState({ busy: true, resetDraft: false });
    for (const [language, heading, closeName] of [
      ['es', 'Fondo esmerilado', 'Cerrar panel de control'],
      ['en', 'Frosted Background', 'Close control panel'],
      ['zh-CN', '毛玻璃背景', '关闭控制面板'],
    ]) {
      assert.equal(await page.locator('#language').isEnabled(), true, 'language stays usable during background operations');
      await page.locator('#language').selectOption(language);
      assert.deepEqual(await page.evaluate(() => window.__messages.at(-1)), { type: 'setLanguage', language });
      assert.equal(await page.locator('html').getAttribute('lang'), language, 'text changes before the host responds');
      assert.equal(await page.locator('h1').textContent(), heading);
      assert.equal(await page.getByRole('button', { name: closeName }).getAttribute('title'), closeName);
      assert.equal(await page.locator('#preview-error').textContent(), dictionaries[language]['此视频无法预览，请尝试 WebM 格式。'], 'an existing preview error changes language in place');
      assert.equal(await page.locator('video').evaluate(video => video === window.__previewNode), true);
      assert.equal(await page.locator('video').evaluate(video => video.currentTime), languageTime);
      assert.deepEqual(await page.evaluate(() => window.__saved), languageDraft, 'language does not change the saved effect draft');
      await sendState({ language });
      assert.equal(await page.locator('video').evaluate(video => video === window.__previewNode), true, 'host language echo does not remount media');
      assert.equal(await page.locator('#playbackRate').inputValue(), '1.5');
    }
    await sendState({ busy: false });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('#pauseWhenUnfocused').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#pauseWhenUnfocused').isChecked(), false);
    await page.locator('video').evaluate(async video => { video.loop = false; video.currentTime = video.duration / 4; await video.play(); });
    await page.waitForFunction(() => document.querySelector('video').currentTime > document.querySelector('video').duration / 3);
    const playingTime = await page.locator('video').evaluate(video => video.currentTime);
    await page.locator('#language').selectOption('es');
    assert.equal(await page.locator('video').evaluate(video => video === window.__previewNode), true, 'a playing video keeps its node');
    assert.ok(await page.locator('video').evaluate(video => video.currentTime) >= playingTime, 'playing video does not restart when the language changes');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#pauseWhenUnfocused').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#pauseWhenUnfocused').isChecked(), true);
    await sendState({ busy: false, language: 'es', needsReload: true, enabled: true, update: { ...update, pendingVersion: '0.6.0' } });
    assert.equal(await page.locator('#available-version').textContent(), 'v0.6.0 · Recarga pendiente');
    assert.equal(await page.locator('#fit-description').textContent(), dictionaries.es['完整画面压缩到编辑区，不裁剪；可能改变比例']);
    assert.equal(await page.locator('#status-text').textContent(), 'Aplicar para finalizar');
    await sendState({ notice: '<strong>Ajustes guardados</strong>', error: '<img onerror=alert(1)>Error externo' });
    assert.equal(await page.locator('#notice').textContent(), '<strong>Ajustes guardados</strong>');
    assert.equal(await page.locator('#error img, #notice strong').count(), 0, 'localized host feedback remains plain text');
    await page.setViewportSize({ width: 280, height: 620 });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Spanish has no horizontal overflow at 280px');
    assert.equal(await page.locator('.fit-control label > span').evaluateAll(labels => labels.every(el => el.scrollWidth <= el.clientWidth)), true, 'Spanish fit labels remain readable');
    const spanishAction = await page.locator('#apply').boundingBox();
    assert.ok(spanishAction.y >= 0 && spanishAction.y + spanishAction.height <= 620, 'Spanish apply button stays visible');
    await page.getByRole('button', { name: 'Cerrar panel de control' }).focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.__messages.at(-1)), { type: 'closePanel' });

    // Reopening uses the host's persisted language, before any state message;
    // a restored dirty draft remains separate from that UI preference.
    const reopenFile = path.join(directory, 'reopened.html');
    fs.writeFileSync(reopenFile, renderPanelHtml({
      cspSource: 'file:', nonce: 'panel-test-nonce', language: 'es',
      scriptUri: pathToFileURL(path.resolve(__dirname, '../media/panel.js')).href,
      styleUri: pathToFileURL(path.resolve(__dirname, '../media/panel.css')).href,
      i18nUri: pathToFileURL(path.resolve(__dirname, '../media/i18n.js')).href,
    regionsUri: pathToFileURL(path.resolve(__dirname, '../media/regions.js')).href,
    }));
    const reopened = await browser.newPage({ viewport: { width: 280, height: 620 } });
    await reopened.addInitScript(saved => {
      window.__saved = saved;
      window.acquireVsCodeApi = () => ({ getState: () => window.__saved, setState: value => { window.__saved = value; }, postMessage() {} });
    }, languageDraft);
    await reopened.goto(pathToFileURL(reopenFile).href);
    assert.equal(await reopened.locator('html').getAttribute('lang'), 'es');
    assert.equal(await reopened.locator('#language').inputValue(), 'es');
    assert.equal(await reopened.locator('h1').textContent(), 'Fondo esmerilado');
    await reopened.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), { ...state, resetDraft: false });
    assert.equal(await reopened.locator('#playbackRate').inputValue(), '1.5', 'reopened draft survives the first state message');
    await reopened.close();
    await sendState({ language: 'zh-CN', needsReload: false, update: null });

    // Distinct color bands touch all four source edges. Sample the composited
    // preview screenshot, not just object-fit styles, to catch cropping/zoom.
    async function verifyVisibleEdges(kind) {
      const bytes = await page.locator('#preview').screenshot();
      const pixels = await page.evaluate(async values => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(values)], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
        const sample = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3);
        return {
          top: sample(Math.floor(canvas.width / 2), 5), bottom: sample(Math.floor(canvas.width / 2), canvas.height - 6),
          left: sample(5, Math.floor(canvas.height / 2)), right: sample(canvas.width - 6, Math.floor(canvas.height / 2)),
        };
      }, Array.from(bytes));
      const detail = `${kind}: ${JSON.stringify(pixels)}`;
      assert.ok(pixels.top[0] > 160 && pixels.top[1] < 100 && pixels.top[2] < 100, 'red top edge is visible: ' + detail);
      assert.ok(pixels.bottom[2] > 160 && pixels.bottom[0] < 100 && pixels.bottom[1] < 100, 'blue bottom edge is visible: ' + detail);
      assert.ok(pixels.left[1] > 160 && pixels.left[0] < 100 && pixels.left[2] < 100, 'green left edge is visible: ' + detail);
      assert.ok(pixels.right[0] > 160 && pixels.right[1] > 160 && pixels.right[2] < 100, 'yellow right edge is visible: ' + detail);
    }
    for (const kind of ['image', 'video']) {
      const file = kind === 'image' ? 'edges.png' : 'edges.webm';
      await sendState({
        config: { ...DEFAULTS, fit: 'fill', blur: 0, opacity: 1, tintOpacity: 0 }, resetDraft: true,
        media: { name: file, kind, uri: pathToFileURL(path.resolve(__dirname, 'fixtures', file)).href },
      });
      if (kind === 'image') await page.locator('#preview-media img').evaluate(image => image.decode());
      else await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
      assert.equal(await page.locator('#preview-media > *').evaluate(el => getComputedStyle(el).transform), 'none');
      for (const width of [280, 360]) {
        await page.setViewportSize({ width, height: 620 });
        await page.locator('#preview').scrollIntoViewIfNeeded();
        await verifyVisibleEdges(`${kind} at ${width}px`);
      }
    }

    await sendState({ config: { ...DEFAULTS, fit: 'fill', blur: 18, opacity: 0.5, tintOpacity: 0.12 }, resetDraft: true, media, enabled: true, update });
    await page.locator('#preview-media img').evaluate(image => image.decode());
    await page.setViewportSize({ width: 280, height: 620 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const closeBounds = await page.locator('#close-panel').boundingBox();
    assert.ok(closeBounds.x >= 0 && closeBounds.x + closeBounds.width <= 280 && closeBounds.y >= 0 && closeBounds.y + closeBounds.height <= 620, 'close control stays visible in the narrow header');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow at 280×620');
    assert.equal(await page.locator('.fit-control label > span').evaluateAll(labels => labels.length === 3 && labels.every(el => el.scrollWidth <= el.clientWidth)), true, 'three layout options fit the narrow sidebar without clipping labels');
    assert.equal(await page.locator('#preview-media img').evaluate(el => getComputedStyle(el).objectFit), 'fill', 'stretch survives panel resizing');
    const actionBounds = await page.locator('#apply').boundingBox();
    assert.ok(actionBounds.y >= 0 && actionBounds.y + actionBounds.height <= 620, 'sticky apply action remains inside the short viewport');
    await page.locator('.advanced summary').click();
    await page.locator('#brightness').scrollIntoViewIfNeeded();
    const advancedBounds = await page.locator('#brightness').boundingBox();
    const footerBounds = await page.locator('.action-bar').boundingBox();
    assert.ok(advancedBounds.y >= 0 && advancedBounds.y + advancedBounds.height <= footerBounds.y, 'expanded advanced slider can scroll above the sticky footer');
    await page.locator('#brightness').fill('1.25');
    await page.locator('#brightness').dispatchEvent('input');
    assert.equal(await page.locator('#brightness-value').textContent(), '125%');
    await page.locator('.advanced summary').click();
    await sendState({ resetDraft: true });
    for (const width of [280, 340]) {
      await page.setViewportSize({ width, height: 960 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal overflow at ${width}px`);
      assert.equal(await page.locator('#apply').isVisible(), true);
    }
    await page.evaluate(() => document.body.className = 'vscode-light');
    assert.equal(await page.locator('#apply').evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)');
    await page.evaluate(() => document.body.className = 'vscode-high-contrast');
    assert.notEqual(await page.locator('#apply').evaluate(el => getComputedStyle(el).borderTopStyle), 'none');
    await page.evaluate(() => { document.body.className = 'vscode-dark'; });
    await page.evaluate(() => window.scrollTo(0, 0));
    if (process.env.PANEL_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.PANEL_ARTIFACT_DIR, { recursive: true });
      // Expand only the exported screenshot so a sticky footer cannot cover
      // controls lower down the scrollable sidebar in a full-page capture.
      await page.setViewportSize({ width: 340, height: await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight)) });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(process.env.PANEL_ARTIFACT_DIR, 'frosted-background-panel-preview.png'), fullPage: true });
    }
    assert.deepEqual(await page.evaluate(() => window.__violations), [], 'strict webview CSP allows the intended UI');
    assert.deepEqual(errors, [], 'no browser exceptions');
  } finally {
    if (browser) await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
