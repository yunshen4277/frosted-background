'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { renderPanelHtml } = require('../src/panel-ui');
const { DEFAULTS } = require('../src/config');

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
    const media = {
      name: '山谷 · 清晨.png', kind: 'image',
      uri: pathToFileURL(path.resolve(__dirname, 'fixtures/wallpaper.png')).href,
    };
    let state = { type: 'state', config: { ...DEFAULTS }, defaults: { ...DEFAULTS }, enabled: false, media, busy: false, error: null, notice: null, needsReload: false };
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
    assert.equal(await page.evaluate(() => window.__messages.filter(item => item.type === 'apply').length), 0, 'sliders only update the local preview');
    await sendState({ config: { ...DEFAULTS, blur: 8 } });
    assert.equal(await page.locator('#blur').inputValue(), '31', 'external changes preserve an unsaved local draft');

    const update = { currentVersion: '0.4.0', repository: 'example/frosted-background', mode: 'automatic', status: 'idle', message: '已是最新版本。', availableVersion: null, pendingVersion: null };
    await sendState({ update });
    assert.equal(await page.locator('#update-section').isVisible(), true);
    assert.equal(await page.locator('#current-version').textContent(), 'v0.4.0');
    assert.equal(await page.locator('#blur').inputValue(), '31', 'update status never resets background drafts');
    await page.locator('#check-updates').click();
    assert.deepEqual(await page.evaluate(() => window.__messages.at(-1)), { type: 'checkUpdates' });
    await sendState({ update: { ...update, status: 'checking', message: '正在检查…' } });
    assert.equal(await page.locator('#check-updates').isEnabled(), false);
    await sendState({ update: { ...update, status: 'installing', availableVersion: '0.5.0' } });
    assert.equal(await page.locator('#check-updates').isEnabled(), false);
    assert.equal(await page.locator('#available-version').textContent(), '发现 v0.5.0');
    await sendState({ update: { ...update, status: 'available', availableVersion: '0.5.0', message: '<img onerror=alert(1)>新版本可用' } });
    assert.equal(await page.locator('#update-message img').count(), 0);
    assert.equal(await page.locator('#update-message').textContent(), '<img onerror=alert(1)>新版本可用');
    await page.locator('#update-mode').selectOption('notify');
    assert.deepEqual(await page.evaluate(() => window.__messages.at(-1)), { type: 'setUpdateMode', mode: 'notify' });
    await sendState({ update: { ...update, mode: 'notify', repository: '', status: 'unconfigured' } });
    assert.equal(await page.locator('#check-updates').isEnabled(), false);
    assert.equal(await page.locator('#update-mode').isEnabled(), true, 'an unconfigured updater still permits turning updates off');
    await page.locator('#update-mode').selectOption('off');
    assert.deepEqual(await page.evaluate(() => window.__messages.at(-1)), { type: 'setUpdateMode', mode: 'off' });
    await sendState({ update: { ...update, pendingVersion: '0.5.0' }, needsReload: true });
    assert.equal(await page.locator('#available-version').textContent(), 'v0.5.0 · 待重载');
    assert.equal(await page.locator('#reload').isVisible(), true);
    assert.equal(await page.locator('#blur').inputValue(), '31');
    await sendState({ update: null, needsReload: false });
    await page.locator('#choose-image').click();
    assert.deepEqual(await page.evaluate(() => window.__messages.at(-1)), { type: 'chooseMedia', kind: 'image' });
    await sendState({ media: { ...media, name: '<img onerror=alert(1)>.png' } });
    assert.equal(await page.locator('#blur').inputValue(), '31', 'selecting a file preserves unsaved settings');
    assert.equal(await page.locator('#media-name').textContent(), '<img onerror=alert(1)>.png');
    assert.equal(await page.locator('#media-name img').count(), 0, 'filenames are plain text');

    await page.locator('[data-preset="clear"]').click();
    assert.equal(await page.locator('#blur').inputValue(), '5');
    await page.locator('input[name="fit"][value="contain"]').check();
    assert.equal(await page.locator('#preview-media img').evaluate(el => getComputedStyle(el).objectFit), 'contain');
    await page.locator('input[name="fit"][value="fill"]').check();
    assert.equal(await page.locator('#fit-description').textContent(), '随编辑区拉伸，可能改变画面比例');
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
    assert.equal(applying.config.blur, 5);
    assert.equal(applying.config.fit, 'fill');
    assert.equal(applying.config.position, 'center top');
    assert.equal(Object.keys(applying.config).length, Object.keys(DEFAULTS).length);
    assert.equal(await page.locator('#apply').isEnabled(), false);
    await sendState({ config: applying.config, resetDraft: true, enabled: true, needsReload: true, notice: '背景已准备好，重载窗口后生效。' });
    assert.equal(await page.locator('#draft-label').getAttribute('class'), 'draft-label');
    assert.equal(await page.locator('#reload').isVisible(), true);
    await page.locator('#reload').click();
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

    await sendState({ config: { ...DEFAULTS, fit: 'fill', blur: 18, opacity: 0.5, tintOpacity: 0.12 }, resetDraft: true, media, enabled: true, update });
    await page.locator('#preview-media img').evaluate(image => image.decode());
    await page.setViewportSize({ width: 280, height: 620 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow at 280×620');
    assert.equal(await page.locator('.fit-control span').evaluateAll(labels => labels.length === 3 && labels.every(el => el.scrollWidth <= el.clientWidth)), true, 'three layout options fit the narrow sidebar without clipping labels');
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
