'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { inspectWebm, MAX_BYTES } = require('../media/webm-player');
const script = fs.readFileSync(path.join(__dirname, '../media/webm-player.js'), 'utf8');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/colors.webm'));
const tick = () => new Promise(resolve => setImmediate(resolve));

function ebml(id, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let width = 1;
  while (bytes.length >= 2 ** (7 * width) - 1) width++;
  const size = Buffer.alloc(width);
  let length = bytes.length;
  for (let i = width - 1; i >= 0; i--) { size[i] = length & 255; length = Math.floor(length / 256); }
  size[0] |= 1 << (8 - width);
  return Buffer.concat([Buffer.from(id, 'hex'), size, bytes]);
}
function webm(video = 'V_VP9', audio, beforeTracks = Buffer.alloc(0)) {
  const track = (type, codec) => ebml('ae', Buffer.concat([ebml('83', [type]), ebml('86', codec)]));
  return Buffer.concat([
    ebml('1a45dfa3', ebml('4282', 'webm')),
    ebml('18538067', Buffer.concat([beforeTracks, ebml('1654ae6b', Buffer.concat([track(1, video), ...(audio ? [track(2, audio)] : [])]))])),
  ]);
}

test('WebM parser reads bounded EBML tracks, including supported audio, without guessing strings', () => {
  assert.equal(MAX_BYTES, 500 * 1024 * 1024);
  assert.equal(inspectWebm(fixture), 'video/webm; codecs="vp8"');
  assert.equal(inspectWebm(webm('V_VP9', 'A_OPUS')), 'video/webm; codecs="vp9,opus"');
  assert.equal(inspectWebm(webm('V_AV1', 'A_VORBIS')), 'video/webm; codecs="av01.0.08M.08,vorbis"');
  assert.throws(() => inspectWebm(webm('V_UNKNOWN', undefined, ebml('ec', 'V_VP8'))), { code: 'WEBM_FORMAT' });
  assert.throws(() => inspectWebm(webm('V_VP8', 'A_AAC')), { code: 'WEBM_FORMAT' });
  assert.throws(() => inspectWebm(Buffer.from('not a video V_VP9')), { code: 'WEBM_FORMAT' });
  assert.throws(() => inspectWebm(webm('V_VP8', undefined, ebml('ec', Buffer.alloc(65536)))), { code: 'WEBM_FORMAT' });
  assert.throws(() => inspectWebm(fixture.subarray(0, 20)), { code: 'WEBM_FORMAT' });
  assert.throws(() => inspectWebm(new Uint8Array()), { code: 'WEBM_LIMIT' });
});

function harness(settings = {}) {
  const instances = [], revoked = [], urls = new Map(), timers = new Map();
  let nextTimer = 0;
  class BufferSource extends EventTarget {
    constructor() { super(); this.updating = false; this.chunks = []; }
    appendBuffer(bytes) {
      if (settings.quota) throw Object.assign(new Error('private source URL'), { name: 'QuotaExceededError' });
      this.chunks.push(bytes.byteLength); this.updating = true;
      queueMicrotask(() => { this.updating = false; this.dispatchEvent(new Event('updateend')); });
    }
    abort() { this.updating = false; }
  }
  class Source extends EventTarget {
    static isTypeSupported() { return settings.supported !== false; }
    constructor() { super(); this.readyState = 'closed'; instances.push(this); }
    addSourceBuffer(mime) { this.mime = mime; return this.buffer = new BufferSource(); }
    removeSourceBuffer(value) { assert.equal(value, this.buffer); this.removed = true; }
    endOfStream() { this.readyState = 'ended'; this.ended = true; }
  }
  class Video extends EventTarget {
    constructor() { super(); this.attributes = new Map(); this.muted = true; this.loop = true; this.paused = true; this.playbackRate = 1.5; this.loads = 0; }
    get src() { return this.getAttribute('src') || ''; }
    set src(value) { this.attributes.set('src', value); }
    getAttribute(name) { return this.attributes.get(name) || null; }
    removeAttribute(name) { this.attributes.delete(name); }
    load() {
      this.loads++;
      const source = urls.get(this.src);
      if (source && !settings.holdOpen) queueMicrotask(() => { source.readyState = 'open'; source.dispatchEvent(new Event('sourceopen')); });
    }
    play() { throw new Error('Helper must leave playback policy to its owner.'); }
    pause() { throw new Error('Helper must leave playback policy to its owner.'); }
  }
  const context = vm.createContext({
    module: { exports: {} }, AbortController, MediaSource: Source,
    URL: { createObjectURL(source) { const url = `blob:test/${urls.size}`; urls.set(url, source); return url; }, revokeObjectURL(url) { revoked.push(url); } },
    setTimeout(callback, delay) {
      if (!settings.fakeTimers) return setTimeout(callback, delay);
      const id = ++nextTimer; timers.set(id, { callback, delay }); return id;
    },
    clearTimeout(id) { if (settings.fakeTimers) timers.delete(id); else clearTimeout(id); },
  });
  vm.runInContext(script, context);
  return { ...context.module.exports, video: new Video(), instances, revoked, urls, timers };
}

test('fallback handles only code 4 once, appends bounded chunks and preserves owner playback settings', async () => {
  const h = harness();
  let reads = 0, ready = 0, errors = 0;
  const bytes = Buffer.concat([fixture, Buffer.alloc(2 * 1024 * 1024)]);
  const fallback = h.createFallback({ video: h.video, load: async () => { reads++; return bytes; }, onReady() { ready++; }, onError() { errors++; } });
  assert.equal(fallback.retry({ code: 3 }), false);
  assert.equal(fallback.retry({ code: 4 }), true);
  assert.equal(fallback.retry({ code: 4 }), true);
  await tick();
  assert.equal(reads, 1); assert.equal(ready, 1); assert.equal(errors, 0);
  assert.equal(h.instances.length, 1);
  assert.equal(h.instances[0].ended, true);
  assert.ok(h.instances[0].buffer.chunks.every(size => size <= 1024 * 1024));
  assert.equal(h.instances[0].buffer.chunks.reduce((a, b) => a + b), bytes.length);
  assert.deepEqual([h.video.muted, h.video.loop, h.video.paused, h.video.playbackRate], [true, true, true, 1.5]);
  assert.equal(fallback.active, true);
  fallback.dispose(); fallback.dispose();
  assert.equal(fallback.active, false);
  assert.equal(h.revoked.length, 1);
  assert.equal(h.video.src, '');
});

test('late loader completion after disposal cannot recreate media or report stale errors', async () => {
  const h = harness(); let finish, signal, callbacks = 0;
  const fallback = h.createFallback({ video: h.video, load: value => { signal = value; return new Promise(resolve => { finish = resolve; }); }, onReady() { callbacks++; }, onError() { callbacks++; } });
  fallback.retry({ code: 4 }); await tick(); fallback.dispose();
  assert.equal(signal.aborted, true);
  finish(fixture); await tick();
  assert.equal(h.instances.length, 0); assert.equal(callbacks, 0);
  assert.equal(fallback.retry({ code: 4 }), false);
});

test('native MSE failures, quota and read failures finish once with sanitized classifications', async () => {
  for (const scenario of ['native', 'quota', 'read', 'unsupported']) {
    const h = harness({ quota: scenario === 'quota', supported: scenario !== 'unsupported' });
    const errors = [];
    const fallback = h.createFallback({ video: h.video, load: async () => { if (scenario === 'read') throw Object.assign(new Error('https://private/token'), { code: 'WEBM_DECODE' }); return fixture; }, onError: error => errors.push(error) });
    fallback.retry({ code: 4 }); await tick();
    if (scenario === 'native') { h.video.dispatchEvent(new Event('error')); h.video.dispatchEvent(new Event('error')); }
    await tick();
    assert.equal(errors.length, 1, scenario);
    assert.equal(errors[0].code, { native: 'WEBM_DECODE', quota: 'WEBM_LIMIT', read: 'WEBM_READ', unsupported: 'WEBM_UNSUPPORTED' }[scenario]);
    assert.doesNotMatch(errors[0].message, /private|token|https:/);
    assert.equal(fallback.active, false);
    assert.equal(fallback.retry({ code: 4 }), false);
    fallback.dispose();
  }
});

test('sourceopen deadline and dispose clean waits without clearing a newer owner source', async () => {
  for (const timeout of [false, true]) {
    const h = harness({ holdOpen: true, fakeTimers: true }), errors = [];
    const fallback = h.createFallback({ video: h.video, bytes: fixture, onError: error => errors.push(error) });
    fallback.retry({ code: 4 }); await tick();
    h.video.src = 'blob:new-owner';
    if (timeout) [...h.timers.values()].find(item => item.delay === 15000).callback();
    else fallback.dispose();
    await tick();
    assert.equal(h.video.src, 'blob:new-owner');
    assert.equal(h.revoked.length, 1); assert.equal(h.timers.size, 0);
    assert.equal(errors.length, Number(timeout));
    if (timeout) assert.equal(errors[0].code, 'WEBM_TIMEOUT');
    fallback.dispose();
  }
});

test('real WebM MSE fallback decodes, seeks, loops, pauses and disposes under media-only Blob CSP', {
  skip: !process.env.PLAYWRIGHT_MODULE,
  timeout: 30000,
}, async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const executablePath = process.env.BROWSER_EXECUTABLE || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(value => fs.existsSync(value));
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://webm-fallback.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/webm-player.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/colors.webm') return route.fulfill({ contentType: 'video/webm', body: fixture });
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src 'self'; media-src blob:; style-src 'unsafe-inline'"><body><video muted loop playsinline style="width:320px;height:180px"></video><script src="/webm-player.js"></script></body>` });
    });
    await page.goto('https://webm-fallback.test/');
    await page.evaluate(() => {
      window.errors = []; window.violations = []; window.reads = 0; window.ready = 0;
      document.addEventListener('securitypolicyviolation', event => window.violations.push(event.violatedDirective));
      const video = document.querySelector('video'); video.muted = true; video.loop = true;
      window.player = FrostedWebm.createFallback({ video, load: async signal => { window.reads++; return new Uint8Array(await (await fetch('/colors.webm', { signal })).arrayBuffer()); }, onReady: () => window.ready++, onError: error => window.errors.push({ code: error.code, message: error.message }) });
      // Force only the missing-demuxer trigger. MediaSource, header parsing,
      // SourceBuffer, decoding and video frames are all real browser behavior.
      video.addEventListener('error', () => { if (!window.player.retry()) window.errors.push({ code: 'OWNER_ERROR' }); });
      Object.defineProperty(video, 'error', { configurable: true, get: () => ({ code: 4 }) });
      video.dispatchEvent(new Event('error')); delete video.error;
    });
    await page.waitForFunction(() => window.ready === 1 && document.querySelector('video').readyState >= 2);
    assert.deepEqual(await page.evaluate(() => ({ reads, errors, violations })), { reads: 1, errors: [], violations: [] });
    assert.equal(await page.locator('video').evaluate(video => video.paused), true);
    const first = await page.locator('video').evaluate(video => { const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight; canvas.getContext('2d').drawImage(video, 0, 0); return Array.from(canvas.getContext('2d').getImageData(1, 1, 1, 1).data); });
    await page.locator('video').evaluate(video => video.play());
    await page.waitForFunction(() => document.querySelector('video').currentTime > 0.3);
    await page.locator('video').evaluate(video => { video.pause(); video.currentTime = 1.2; });
    await page.waitForFunction(() => !document.querySelector('video').seeking);
    const second = await page.locator('video').evaluate(video => { const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight; canvas.getContext('2d').drawImage(video, 0, 0); return Array.from(canvas.getContext('2d').getImageData(1, 1, 1, 1).data); });
    assert.notDeepEqual(first, second, 'actual decoded video colors must change after seeking');
    const pausedAt = await page.locator('video').evaluate(video => video.currentTime);
    await page.waitForTimeout(150);
    assert.equal(await page.locator('video').evaluate(video => video.currentTime), pausedAt);
    await page.locator('video').evaluate(video => { video.currentTime = video.duration - 0.1; return video.play(); });
    await page.waitForFunction(() => document.querySelector('video').currentTime < 0.8);
    assert.deepEqual(await page.evaluate(() => window.errors), []);
    await page.evaluate(() => window.player.dispose());
    assert.deepEqual(await page.locator('video').evaluate(video => ({ src: video.getAttribute('src'), active: window.player.active })), { src: null, active: false });
  } finally { await browser.close(); }
});
