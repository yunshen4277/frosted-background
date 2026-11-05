'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const patcher = require('../src/patcher');
const { DEFAULTS } = require('../src/config');

const ORIGINAL = '\uFEFF<!DOCTYPE html>\r\n<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; media-src \'self\'"></head>\r\n<body></body>\r\n<script src="./workbench.js" type="module"></script>\r\n</html>\r\n';

async function fixture(t, variant = 'electron-browser') {
  const appRoot = await fs.mkdtemp(path.join(process.env.FROSTED_TEST_TMP || os.tmpdir(), 'frosted-patcher-test-'));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const workbenchPath = path.join(appRoot, 'out/vs/code', variant, 'workbench/workbench.html');
  await fs.mkdir(path.dirname(workbenchPath), { recursive: true });
  await fs.writeFile(workbenchPath, ORIGINAL);
  const rendererPath = path.join(appRoot, 'renderer.js');
  const mediaPath = path.join(appRoot, '壁纸 & image.jpg');
  await fs.writeFile(path.join(appRoot, 'regions.js'), '(function(root) { root.FrostedRegions = { version: 1 }; })(globalThis);');
  await fs.writeFile(rendererPath, '(() => { /* renderer fixture */ })();');
  await fs.writeFile(path.join(appRoot, 'video-player.js'), '(() => { /* video player fixture */ })();');
  await fs.writeFile(mediaPath, Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3, 4]));
  return { appRoot, workbenchPath, rendererPath, mediaPath, config: { blur: 14, opacity: 0.35 } };
}

function decodeConfig(html) {
  const encoded = /data-frosted-config="([^"]+)"/.exec(html)[1];
  return JSON.parse(encoded.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}

test('apply injects a self-hosted external script without changing CSP; restore is byte-exact', async t => {
  const fixtureData = await fixture(t);
  assert.equal((await patcher.status(fixtureData)).installed, false);
  const result = await patcher.apply(fixtureData);
  const html = await fs.readFile(fixtureData.workbenchPath, 'utf8');
  assert.equal(patcher.stripInjection(html), ORIGINAL);
  assert.equal(html.match(/FROSTED-BACKGROUND:START/g).length, 1);
  assert.match(html, /src="\.\/frosted-background-assets\/renderer-[a-f0-9]{64}\.js"/);
  assert.equal((await patcher.status(fixtureData)).installed, true);
  assert.equal(await fs.readFile(result.backupPath, 'utf8'), ORIGINAL);
  const config = decodeConfig(html);
  assert.equal(config.kind, 'image');
  assert.equal(config.enabled, true);
  assert.equal(config.blur, 14);
  assert.match(config.source, /^\.\/frosted-background-assets\/media-[a-f0-9]{64}\.jpg$/);
  assert.deepEqual(await fs.readFile(path.join(path.dirname(fixtureData.workbenchPath), config.source)), await fs.readFile(fixtureData.mediaPath));
  const restored = await patcher.restore(fixtureData);
  assert.equal(restored.changed, true);
  assert.deepEqual(restored.cleanupErrors, []);
  assert.equal(await fs.readFile(fixtureData.workbenchPath, 'utf8'), ORIGINAL);
  assert.equal((await patcher.status(fixtureData)).installed, false);
  assert.equal(await fs.readFile(result.backupPath, 'utf8'), ORIGINAL);
  assert.equal((await patcher.restore(fixtureData)).changed, false);
});

test('legacy electron-sandbox workbench is discovered', async t => {
  const data = await fixture(t, 'electron-sandbox');
  assert.equal(await patcher.findWorkbench(data.appRoot), data.workbenchPath);
  await patcher.apply(data);
  assert.equal((await patcher.status(data)).installed, true);
});

test('repeat apply is idempotent and update replaces the single block', async t => {
  const data = await fixture(t);
  await patcher.apply(data);
  const first = await fs.readFile(data.workbenchPath, 'utf8');
  await patcher.apply(data);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), first);
  await fs.writeFile(data.mediaPath, Buffer.from([0xff, 0xd8, 8, 7, 6]));
  await patcher.apply({ ...data, config: { blur: 25 } });
  const second = await fs.readFile(data.workbenchPath, 'utf8');
  assert.notEqual(decodeConfig(first).source, decodeConfig(second).source);
  assert.equal(decodeConfig(second).blur, 25);
  assert.equal(second.match(/FROSTED-BACKGROUND:START/g).length, 1);
  assert.equal(patcher.stripInjection(second), ORIGINAL);
});

test('restore preserves unrelated modifications and unknown assets', async t => {
  const data = await fixture(t);
  await patcher.apply(data);
  const html = await fs.readFile(data.workbenchPath, 'utf8');
  await fs.writeFile(data.workbenchPath, html.replace('<body>', '<body data-other-extension="retained">'));
  const foreign = path.join(path.dirname(data.workbenchPath), patcher.ASSET_DIRECTORY, 'my-notes.txt');
  await fs.writeFile(foreign, 'Keep me');
  await patcher.restore(data);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), ORIGINAL.replace('<body>', '<body data-other-extension="retained">'));
  assert.equal(await fs.readFile(foreign, 'utf8'), 'Keep me');
});

test('rejects malformed injection markers rather than deleting uncertain content', () => {
  assert.throws(() => patcher.stripInjection(`${patcher.START_MARKER}broken`), /标记不完整/);
  assert.throws(() => patcher.stripInjection(`${patcher.END_MARKER}${patcher.START_MARKER}`), /标记不完整/);
  assert.throws(() => patcher.stripInjection(`${patcher.START_MARKER}${patcher.START_MARKER}${patcher.END_MARKER}`), /标记不完整/);
});

test('config is HTML-escaped and authoritative source cannot be overridden', async t => {
  const data = await fixture(t);
  const tricky = '</script><script>alert("x")</script> & \'quote\'';
  await patcher.apply({ ...data, config: { label: tricky, source: 'https://example.com/x', kind: 'video', enabled: false } });
  const html = await fs.readFile(data.workbenchPath, 'utf8');
  assert.equal(html.includes('<script>alert'), false);
  assert.equal(decodeConfig(html).label, undefined, 'only supported normalized configuration is persisted');
  assert.equal(decodeConfig(html).kind, 'image');
  assert.equal(decodeConfig(html).enabled, true);
  assert.equal(decodeConfig(html).source.includes('https:'), false);
  const escaped = patcher.inject(ORIGINAL, 'renderer-test.js', { label: tricky });
  assert.equal(escaped.includes('<script>alert'), false);
  assert.equal(decodeConfig(escaped).label, tricky, 'the injection writer still escapes every JSON attribute value');
});

test('video uses an owned standalone player without altering the workbench CSP', async t => {
  const data = await fixture(t);
  const mediaPath = path.join(data.appRoot, 'clip.WEBM');
  await fs.writeFile(mediaPath, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  await patcher.apply({ ...data, mediaPath, config: { fit: 'fill', videoPlayer: 'https://example.com/foreign.html' } });
  const html = await fs.readFile(data.workbenchPath, 'utf8');
  const config = decodeConfig(html);
  assert.equal(config.kind, 'video');
  assert.equal(config.fit, 'fill');
  assert.match(config.source, /\.webm$/);
  assert.equal(patcher.stripInjection(html), ORIGINAL);
  assert.match(config.videoPlayer, /^\.\/frosted-background-assets\/video-host-[a-f0-9]{64}\.html$/);
  const page = await fs.readFile(path.join(path.dirname(data.workbenchPath), config.videoPlayer), 'utf8');
  assert.match(page, /media-src blob:/);
  assert.match(page, /script-src 'self'/);
  assert.doesNotMatch(page, /unsafe-eval|srcdoc|https:/);
  const player = /src="\.\/(video-player-[a-f0-9]{64}\.js)"/.exec(page)[1];
  const directory = path.join(path.dirname(data.workbenchPath), patcher.ASSET_DIRECTORY);
  assert.equal(await fs.readFile(path.join(directory, player), 'utf8'), (await fs.readFile(path.join(data.appRoot, 'regions.js'), 'utf8')) + '\n;\n' + (await fs.readFile(path.join(data.appRoot, 'video-player.js'), 'utf8')));
  await fs.writeFile(path.join(directory, 'video-host-not-owned.html'), 'keep');
  await patcher.restore(data);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), ORIGINAL);
  assert.equal(await fs.readFile(path.join(directory, 'video-host-not-owned.html'), 'utf8'), 'keep');
  assert.equal((await fs.readdir(directory)).some(name => /^(video-player-|video-host-[a-f0-9]{64})/.test(name)), false);
});

test('video helper failures cannot replace the current background or leave partial assets', async t => {
  const data = await fixture(t);
  await patcher.apply(data);
  const before = await fs.readFile(data.workbenchPath, 'utf8');
  const directory = path.join(path.dirname(data.workbenchPath), patcher.ASSET_DIRECTORY);
  const names = (await fs.readdir(directory)).sort();
  const video = path.join(data.appRoot, 'clip.mp4');
  await fs.writeFile(video, 'video fixture');
  const playerPath = path.join(data.appRoot, 'video-player.js');
  await fs.unlink(playerPath);
  await assert.rejects(patcher.apply({ ...data, mediaPath: video }), /播放器文件缺失/);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), before);
  assert.deepEqual((await fs.readdir(directory)).sort(), names);
  await fs.writeFile(playerPath, 'player script');
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === data.workbenchPath) throw Object.assign(new Error('in-use'), { code: 'EPERM' });
    return rename(from, to);
  });
  await assert.rejects(patcher.apply({ ...data, mediaPath: video }), /无法写入/);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), before);
  assert.deepEqual((await fs.readdir(directory)).sort(), names);
});

test('old cached video migrates to the standalone player after its original file is removed', async t => {
  const data = await fixture(t);
  const video = path.join(data.appRoot, 'clip.mp4');
  await fs.writeFile(video, 'cached video fixture');
  await patcher.apply({ ...data, mediaPath: video, config: { ...DEFAULTS, fit: 'fill', playbackRate: 1.5 } });
  const html = await fs.readFile(data.workbenchPath, 'utf8');
  const payload = decodeConfig(html);
  const source = payload.source;
  delete payload.videoPlayer;
  await fs.writeFile(data.workbenchPath, replaceConfig(html, payload));
  await fs.unlink(video);
  await patcher.reapply({ appRoot: data.appRoot, rendererPath: data.rendererPath });
  const migrated = decodeConfig(await fs.readFile(data.workbenchPath, 'utf8'));
  assert.equal(migrated.source, source);
  assert.equal(migrated.fit, 'fill');
  assert.equal(migrated.playbackRate, 1.5);
  assert.match(migrated.videoPlayer, /video-host-[a-f0-9]{64}\.html$/);
});

test('rejects unsupported files and oversized media before touching workbench', async t => {
  const data = await fixture(t);
  await assert.rejects(patcher.apply({ ...data, mediaPath: path.join(data.appRoot, 'bad.svg') }), /请选择 PNG/);
  const huge = path.join(data.appRoot, 'huge.mp4');
  const handle = await fs.open(huge, 'w');
  await handle.truncate(patcher.MAX_MEDIA_BYTES + 1);
  await handle.close();
  await assert.rejects(patcher.apply({ ...data, mediaPath: huge }), /500 MB/);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), ORIGINAL);
  await assert.rejects(fs.access(path.join(path.dirname(data.workbenchPath), patcher.ASSET_DIRECTORY)));
});

test('foreign asset directory is neither overwritten nor removed', async t => {
  const data = await fixture(t);
  const directory = path.join(path.dirname(data.workbenchPath), patcher.ASSET_DIRECTORY);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'foreign.txt'), 'untouched');
  await assert.rejects(patcher.apply(data), /不属于本插件/);
  await assert.rejects(patcher.restore(data), /不属于本插件/);
  assert.equal(await fs.readFile(path.join(directory, 'foreign.txt'), 'utf8'), 'untouched');
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), ORIGINAL);
});

test('failed atomic publication rolls back new assets and retains previous background', async t => {
  const data = await fixture(t);
  await patcher.apply(data);
  const htmlBefore = await fs.readFile(data.workbenchPath, 'utf8');
  const directory = path.join(path.dirname(data.workbenchPath), patcher.ASSET_DIRECTORY);
  const namesBefore = (await fs.readdir(directory)).sort();
  await fs.writeFile(data.mediaPath, 'another media fixture');
  const actualRename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === data.workbenchPath) throw Object.assign(new Error('simulated permission failure'), { code: 'EPERM' });
    return actualRename(from, to);
  });
  await assert.rejects(patcher.apply(data), /无法写入 VS Code 安装目录/);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), htmlBefore);
  assert.deepEqual((await fs.readdir(directory)).sort(), namesBefore);
});

test('unsupported document leaves HTML unchanged and does not copy media', async t => {
  const data = await fixture(t);
  await fs.writeFile(data.workbenchPath, '<not-a-workbench>');
  await assert.rejects(patcher.apply(data), /格式不受支持/);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), '<not-a-workbench>');
  const names = await fs.readdir(path.join(path.dirname(data.workbenchPath), patcher.ASSET_DIRECTORY));
  assert.deepEqual(names, ['.owner.json']);
});

test('a live operation lock prevents overlapping writes', async t => {
  const data = await fixture(t);
  await patcher.apply(data);
  const directory = path.join(path.dirname(data.workbenchPath), patcher.ASSET_DIRECTORY);
  const lock = path.join(directory, '.operation.lock');
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid }));
  const before = await fs.readFile(data.workbenchPath, 'utf8');
  await assert.rejects(patcher.apply(data), /另一个 VS Code 窗口/);
  await assert.rejects(patcher.restore(data), /另一个 VS Code 窗口/);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), before);
});

test('asset directory junction cannot redirect writes or cleanup elsewhere', async t => {
  const data = await fixture(t);
  const directory = path.join(path.dirname(data.workbenchPath), patcher.ASSET_DIRECTORY);
  const unrelated = path.join(data.appRoot, 'unrelated');
  await fs.mkdir(unrelated);
  await fs.writeFile(path.join(unrelated, 'keep.txt'), 'untouched');
  try { await fs.symlink(unrelated, directory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('This environment disallows creating symbolic links.');
    throw error;
  }
  await assert.rejects(patcher.apply(data), /不是普通目录/);
  await assert.rejects(patcher.restore(data), /不是普通目录/);
  assert.deepEqual(await fs.readdir(unrelated), ['keep.txt']);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), ORIGINAL);
});

function replaceConfig(html, payload) {
  const escaped = JSON.stringify(payload).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
  return html.replace(/data-frosted-config="[^"]*"/, `data-frosted-config="${escaped}"`);
}

test('renderer upgrades reuse cached media after original deletion and retain last applied settings', async t => {
  const data = await fixture(t);
  const settings = { ...DEFAULTS, blur: 27, opacity: 0.63, fit: 'contain', position: 'right center', playbackRate: 1.25 };
  await patcher.apply({ ...data, config: settings });
  const oldHtml = await fs.readFile(data.workbenchPath, 'utf8');
  const oldPayload = decodeConfig(oldHtml);
  await fs.unlink(data.mediaPath);
  await fs.writeFile(data.rendererPath, '(() => { /* upgraded renderer */ })();');
  const result = await patcher.reapply({ appRoot: data.appRoot, rendererPath: data.rendererPath });
  assert.equal(result.workbenchPath, data.workbenchPath);
  const newHtml = await fs.readFile(data.workbenchPath, 'utf8');
  assert.notEqual(newHtml, oldHtml);
  assert.deepEqual(decodeConfig(newHtml), oldPayload);
  assert.equal(patcher.stripInjection(newHtml), ORIGINAL);
  await patcher.restore(data);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), ORIGINAL);
});

test('cached source paths cannot escape the owned media directory', async t => {
  const data = await fixture(t);
  await patcher.apply(data);
  const original = await fs.readFile(data.workbenchPath, 'utf8');
  const payload = decodeConfig(original);
  for (const source of ['file:///C:/outside.jpg', '../outside.jpg', './frosted-background-assets/../outside.jpg', payload.source.replace('media-', '%6dedia-'), 'https://github.com/image.jpg']) {
    const changed = replaceConfig(original, { ...payload, source });
    await fs.writeFile(data.workbenchPath, changed);
    await assert.rejects(patcher.reapply({ appRoot: data.appRoot, rendererPath: data.rendererPath }), /不属于本插件/);
    assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), changed);
  }
});

test('cached reapply requires an active own injection and verified directory ownership', async t => {
  const data = await fixture(t);
  await assert.rejects(patcher.reapply({ appRoot: data.appRoot, rendererPath: data.rendererPath }), /没有可复用/);
  await patcher.apply(data);
  const html = await fs.readFile(data.workbenchPath, 'utf8');
  const ownerPath = path.join(path.dirname(data.workbenchPath), patcher.ASSET_DIRECTORY, '.owner.json');
  await fs.writeFile(ownerPath, JSON.stringify({ owner: 'another-extension' }));
  await assert.rejects(patcher.reapply({ appRoot: data.appRoot, rendererPath: data.rendererPath }), /所有权/);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), html);
});

test('changed cached media and unexpected injection structure are not reused', async t => {
  const data = await fixture(t);
  await patcher.apply(data);
  const html = await fs.readFile(data.workbenchPath, 'utf8');
  const payload = decodeConfig(html);
  const changedStructure = html.replace('src="./frosted-background-assets/renderer-', 'src="https://example.com/renderer-');
  await fs.writeFile(data.workbenchPath, changedStructure);
  await assert.rejects(patcher.reapply({ appRoot: data.appRoot, rendererPath: data.rendererPath }), /注入结构/);
  await fs.writeFile(data.workbenchPath, html);
  await fs.writeFile(path.join(path.dirname(data.workbenchPath), payload.source), 'tampered bytes');
  await assert.rejects(patcher.reapply({ appRoot: data.appRoot, rendererPath: data.rendererPath }), /缓存背景校验失败/);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), html);
});

test('cached reapply refuses a race with another background change', async t => {
  const data = await fixture(t);
  await patcher.apply(data);
  const original = await fs.readFile(data.workbenchPath, 'utf8');
  const cachedPath = path.join(path.dirname(data.workbenchPath), decodeConfig(original).source);
  const changed = original.replace('</body>', '<!-- another change --></body>');
  const originalStat = fs.stat;
  let mutated = false;
  t.mock.method(fs, 'stat', async filename => {
    if (filename === cachedPath && !mutated) { mutated = true; await fs.writeFile(data.workbenchPath, changed); }
    return originalStat(filename);
  });
  await assert.rejects(patcher.reapply({ appRoot: data.appRoot, rendererPath: data.rendererPath }), /另一个窗口中改变/);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), changed);
});

test('explicit cached reapply settings are normalized and cannot replace the media source', async t => {
  const data = await fixture(t);
  await patcher.apply(data);
  const previous = decodeConfig(await fs.readFile(data.workbenchPath, 'utf8'));
  await patcher.reapply({ appRoot: data.appRoot, rendererPath: data.rendererPath, config: { blur: 200, source: 'file:///outside.jpg', position: 'url(evil)' } });
  const updated = decodeConfig(await fs.readFile(data.workbenchPath, 'utf8'));
  assert.equal(updated.blur, 60);
  assert.equal(updated.position, 'center center');
  assert.equal(updated.source, previous.source);
});

function assetDirectory(data) {
  return path.join(path.dirname(data.workbenchPath), patcher.ASSET_DIRECTORY);
}

function livePath(data) {
  return path.join(assetDirectory(data), patcher.LIVE_STATE_FILE);
}

async function liveState(data) {
  return JSON.parse(await fs.readFile(livePath(data), 'utf8'));
}

test('apply publishes an authoritative live envelope and a new revision without changing the CSP', async t => {
  const data = await fixture(t);
  const result = await patcher.apply({ ...data, config: { ...data.config, liveState: 'https://example.com/state.json' } });
  assert.equal(result.liveProtocol, 1);
  const html = await fs.readFile(data.workbenchPath, 'utf8');
  const payload = decodeConfig(html);
  const first = await liveState(data);
  assert.equal(payload.liveState, './frosted-background-assets/live-state.json');
  assert.equal(first.protocol, 1);
  assert.match(first.revision, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(first.settings, payload);
  assert.deepEqual(Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, payload[key]])), { ...DEFAULTS, ...data.config }, 'partial caller configuration becomes a complete normalized live payload');
  assert.equal(patcher.stripInjection(html), ORIGINAL);
  assert.equal((await patcher.status(data)).liveProtocol, 1);
  await patcher.apply({ ...data, config: { ...data.config, liveState: 'https://example.com/state.json' } });
  const second = await liveState(data);
  assert.notEqual(second.revision, first.revision);
  assert.deepEqual(second.settings, first.settings);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), html);
});

test('updating image configuration never reads, hashes or copies cached media and preserves the source', async t => {
  const data = await fixture(t);
  await patcher.apply({ ...data, config: { ...DEFAULTS, opacity: 0.61, fit: 'contain' } });
  const before = await liveState(data);
  const beforeHtml = await fs.readFile(data.workbenchPath, 'utf8');
  const names = (await fs.readdir(assetDirectory(data))).sort();
  const mediaPath = path.join(path.dirname(data.workbenchPath), before.settings.source);
  await fs.unlink(data.mediaPath);
  const read = fs.readFile;
  t.mock.method(fs, 'readFile', async (filename, ...args) => {
    assert.notEqual(String(filename), mediaPath, 'configuration changes must not read the cached media');
    return read(filename, ...args);
  });
  t.mock.method(nativeFs, 'createReadStream', () => assert.fail('configuration changes must not stream media'));
  t.mock.method(fs, 'copyFile', () => assert.fail('configuration changes must not copy media'));
  t.mock.method(crypto, 'createHash', () => assert.fail('configuration changes must not hash media'));
  const result = await patcher.updateConfig({ appRoot: data.appRoot, config: { blur: 200, source: 'https://example.com/evil.mp4', kind: 'video', enabled: false, liveState: '../evil.json', videoPlayer: '../evil.html', unknown: 1 } });
  assert.equal(result.liveProtocol, 1);
  const after = await liveState(data);
  const afterHtml = await fs.readFile(data.workbenchPath, 'utf8');
  assert.notEqual(after.revision, before.revision);
  assert.equal(after.settings.source, before.settings.source);
  assert.equal(after.settings.kind, 'image');
  assert.equal(after.settings.enabled, true);
  assert.equal(after.settings.liveState, patcher.LIVE_STATE_SOURCE);
  assert.equal(after.settings.videoPlayer, undefined);
  assert.equal(after.settings.unknown, undefined);
  assert.equal(after.settings.blur, 60);
  assert.equal(after.settings.opacity, 0.61);
  assert.equal(after.settings.fit, 'contain');
  assert.deepEqual(after.settings, decodeConfig(afterHtml));
  assert.equal(/src="([^"]+)" data-frosted-config/.exec(afterHtml)[1], /src="([^"]+)" data-frosted-config/.exec(beforeHtml)[1]);
  assert.deepEqual((await fs.readdir(assetDirectory(data))).sort(), names);
  assert.equal(patcher.stripInjection(afterHtml), ORIGINAL);
});

test('video parameter updates validate the player files while leaving the video and player identity unchanged', async t => {
  const data = await fixture(t);
  const video = path.join(data.appRoot, 'clip.mp4');
  await fs.writeFile(video, 'video fixture');
  await patcher.apply({ ...data, mediaPath: video, config: { ...DEFAULTS, playbackRate: 1 } });
  const before = await liveState(data);
  const cachedVideo = path.join(path.dirname(data.workbenchPath), before.settings.source);
  await fs.unlink(video);
  const read = fs.readFile;
  t.mock.method(fs, 'readFile', async (filename, ...args) => {
    assert.notEqual(String(filename), cachedVideo);
    return read(filename, ...args);
  });
  t.mock.method(nativeFs, 'createReadStream', () => assert.fail('video updates must not open the media stream'));
  await patcher.updateConfig({ appRoot: data.appRoot, config: { playbackRate: 1.75, blur: 3, fit: 'fill' } });
  const updated = await liveState(data);
  assert.equal(updated.settings.source, before.settings.source);
  assert.equal(updated.settings.videoPlayer, before.settings.videoPlayer);
  assert.equal(updated.settings.playbackRate, 1.75);
  assert.equal(updated.settings.fit, 'fill');
  const page = await fs.readFile(path.join(path.dirname(data.workbenchPath), updated.settings.videoPlayer), 'utf8');
  const playerName = /src="\.\/(video-player-[a-f0-9]{64}\.js)"/.exec(page)[1];
  await fs.unlink(path.join(assetDirectory(data), playerName));
  const html = await fs.readFile(data.workbenchPath, 'utf8');
  await assert.rejects(patcher.updateConfig({ appRoot: data.appRoot, config: { blur: 10 } }), { code: 'ENOENT' });
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), html);
  assert.deepEqual(await liveState(data), updated);
  assert.equal((await patcher.status(data)).liveProtocol, undefined);
});

test('legacy cached backgrounds gain the live protocol only after a renderer reapply', async t => {
  const data = await fixture(t);
  await patcher.apply({ ...data, config: { ...DEFAULTS, blur: 23, fit: 'fill' } });
  const html = await fs.readFile(data.workbenchPath, 'utf8');
  const previous = decodeConfig(html);
  delete previous.liveState;
  await fs.writeFile(data.workbenchPath, replaceConfig(html, previous));
  await fs.unlink(livePath(data));
  await fs.unlink(data.mediaPath);
  assert.equal((await patcher.status(data)).installed, true);
  assert.equal((await patcher.status(data)).liveProtocol, undefined);
  await assert.rejects(patcher.updateConfig({ appRoot: data.appRoot, config: { blur: 10 } }), /尚不支持实时调整/);
  const result = await patcher.reapply({ appRoot: data.appRoot, rendererPath: data.rendererPath });
  assert.equal(result.liveProtocol, 1);
  assert.equal((await patcher.status(data)).liveProtocol, 1);
  const live = await liveState(data);
  assert.equal(live.settings.source, previous.source);
  assert.equal(live.settings.blur, 23);
  assert.equal(live.settings.fit, 'fill');
  assert.equal(live.settings.liveState, patcher.LIVE_STATE_SOURCE);
});

test('failed live publication restores HTML and keeps the previous envelope and assets', async t => {
  const data = await fixture(t);
  await patcher.apply(data);
  const htmlBefore = await fs.readFile(data.workbenchPath, 'utf8');
  const liveBefore = await fs.readFile(livePath(data), 'utf8');
  const namesBefore = (await fs.readdir(assetDirectory(data))).sort();
  await fs.writeFile(data.mediaPath, 'new image data');
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === livePath(data)) throw Object.assign(new Error('simulated live-state permission failure'), { code: 'EPERM' });
    return rename(from, to);
  });
  await assert.rejects(patcher.apply(data), /无法写入/);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), htmlBefore);
  assert.equal(await fs.readFile(livePath(data), 'utf8'), liveBefore);
  assert.deepEqual((await fs.readdir(assetDirectory(data))).sort(), namesBefore);
  await assert.rejects(patcher.updateConfig({ appRoot: data.appRoot, config: { blur: 50 } }), /无法写入/);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), htmlBefore);
  assert.equal(await fs.readFile(livePath(data), 'utf8'), liveBefore);
  assert.deepEqual((await fs.readdir(assetDirectory(data))).sort(), namesBefore);
});

test('failed first live publication restores the original workbench and removes unreferenced staged assets', async t => {
  const data = await fixture(t);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === livePath(data)) throw new Error('cannot publish live state');
    return rename(from, to);
  });
  await assert.rejects(patcher.apply(data), /cannot publish/);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), ORIGINAL);
  await assert.rejects(fs.access(livePath(data)), { code: 'ENOENT' });
  assert.ok((await fs.readdir(assetDirectory(data))).every(name => name === '.owner.json' || /^backup-[a-f0-9]{64}\.html$/.test(name)));
});

test('a failed HTML rollback never deletes assets still referenced by the persisted workbench', async t => {
  const data = await fixture(t);
  await patcher.apply(data);
  const liveBefore = await fs.readFile(livePath(data), 'utf8');
  const oldPayload = JSON.parse(liveBefore).settings;
  await fs.writeFile(data.mediaPath, 'new asset that must survive');
  const rename = fs.rename;
  let htmlWrites = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === livePath(data)) throw new Error('live commit failed');
    if (to === data.workbenchPath && ++htmlWrites === 2) throw new Error('HTML rollback failed');
    return rename(from, to);
  });
  await assert.rejects(patcher.apply(data), error => error.message === 'live commit failed' && error.rollbackError?.message === 'HTML rollback failed');
  const current = decodeConfig(await fs.readFile(data.workbenchPath, 'utf8'));
  assert.notEqual(current.source, oldPayload.source);
  assert.equal(await fs.readFile(path.join(path.dirname(data.workbenchPath), current.source), 'utf8'), 'new asset that must survive');
  await fs.access(path.join(path.dirname(data.workbenchPath), oldPayload.source));
  assert.equal(await fs.readFile(livePath(data), 'utf8'), liveBefore);
  assert.equal((await patcher.status(data)).liveProtocol, undefined, 'mismatched documents do not advertise live capability');
});

test('live publication rollback preserves an external workbench edit and its referenced assets', async t => {
  const data = await fixture(t);
  await patcher.apply(data);
  await fs.writeFile(data.mediaPath, 'changed image fixture');
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === livePath(data)) {
      const current = await fs.readFile(data.workbenchPath, 'utf8');
      await fs.writeFile(data.workbenchPath, current.replace('<body>', '<body data-foreign="keep">'));
      throw new Error('simulated external race');
    }
    return rename(from, to);
  });
  await assert.rejects(patcher.apply(data), error => error.message === 'simulated external race' && /其他程序修改/.test(error.rollbackError?.message));
  const html = await fs.readFile(data.workbenchPath, 'utf8');
  assert.match(html, /data-foreign="keep"/);
  assert.equal(await fs.readFile(path.join(path.dirname(data.workbenchPath), decodeConfig(html).source), 'utf8'), 'changed image fixture');
});

test('restore commits a retained disabled tombstone before deleting any owned media', async t => {
  const data = await fixture(t);
  await patcher.apply(data);
  const before = await liveState(data);
  const unlink = fs.unlink;
  let inspected = false;
  t.mock.method(fs, 'unlink', async filename => {
    if (/^media-[a-f0-9]{64}\./.test(path.basename(filename))) {
      inspected = true;
      assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), ORIGINAL);
      assert.deepEqual((await liveState(data)).settings, { enabled: false });
    }
    return unlink(filename);
  });
  const result = await patcher.restore(data);
  assert.equal(result.liveProtocol, 1);
  assert.equal(inspected, true);
  const tombstone = await liveState(data);
  assert.equal(tombstone.protocol, 1);
  assert.notEqual(tombstone.revision, before.revision);
  assert.deepEqual(tombstone.settings, { enabled: false });
  assert.equal((await patcher.status(data)).installed, false);
  assert.equal((await patcher.status(data)).liveProtocol, undefined);
  assert.equal((await patcher.restore(data)).liveProtocol, 1);
  await assert.rejects(patcher.updateConfig({ appRoot: data.appRoot, config: { blur: 5 } }), /没有可复用/);
  await patcher.apply(data);
  assert.equal((await liveState(data)).settings.enabled, true, 'the stable channel supports re-enabling after restore');
});

test('failed restore tombstone publication rolls back HTML and never cleans referenced assets', async t => {
  const data = await fixture(t);
  await patcher.apply(data);
  const html = await fs.readFile(data.workbenchPath, 'utf8');
  const live = await fs.readFile(livePath(data), 'utf8');
  const names = (await fs.readdir(assetDirectory(data))).sort();
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === livePath(data)) throw new Error('tombstone failed');
    return rename(from, to);
  });
  await assert.rejects(patcher.restore(data), /tombstone failed/);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), html);
  assert.equal(await fs.readFile(livePath(data), 'utf8'), live);
  assert.deepEqual((await fs.readdir(assetDirectory(data))).sort(), names);
});

test('legacy restore writes a tombstone without claiming a legacy renderer can update live', async t => {
  const data = await fixture(t);
  await patcher.apply(data);
  const html = await fs.readFile(data.workbenchPath, 'utf8');
  const payload = decodeConfig(html);
  delete payload.liveState;
  await fs.writeFile(data.workbenchPath, replaceConfig(html, payload));
  await fs.unlink(livePath(data));
  const result = await patcher.restore(data);
  assert.equal(result.liveProtocol, undefined);
  assert.deepEqual((await liveState(data)).settings, { enabled: false });
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), ORIGINAL);
});

test('config updates refuse unowned paths, invalid live pointers and mismatched documents without writes', async t => {
  const data = await fixture(t);
  await patcher.apply(data);
  const original = await fs.readFile(data.workbenchPath, 'utf8');
  const live = await fs.readFile(livePath(data), 'utf8');
  const payload = decodeConfig(original);
  const changes = [
    { source: '../outside.jpg' }, { source: 'file:///outside.jpg' },
    { liveState: './frosted-background-assets/../live-state.json' },
    { liveState: 'https://example.com/state.json' },
    { videoPlayer: './frosted-background-assets/foreign.html' },
    { blur: 47 }
  ];
  for (const change of changes) {
    const altered = replaceConfig(original, { ...payload, ...change });
    await fs.writeFile(data.workbenchPath, altered);
    await assert.rejects(patcher.updateConfig({ appRoot: data.appRoot, config: { blur: 7 } }));
    assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), altered);
    assert.equal(await fs.readFile(livePath(data), 'utf8'), live);
    assert.equal((await patcher.status(data)).liveProtocol, undefined);
  }
});

test('a corrupt or nonregular stable state file is never overwritten or followed', async t => {
  const data = await fixture(t);
  await patcher.apply(data);
  const html = await fs.readFile(data.workbenchPath, 'utf8');
  const live = await fs.readFile(livePath(data), 'utf8');
  for (const invalid of ['not json', JSON.stringify({ protocol: 1, revision: 'not-a-uuid', settings: { enabled: false } }), JSON.stringify({ protocol: 2, revision: crypto.randomUUID(), settings: { enabled: false } })]) {
    await fs.writeFile(livePath(data), invalid);
    assert.equal((await patcher.status(data)).liveProtocol, undefined);
    await assert.rejects(patcher.updateConfig({ appRoot: data.appRoot, config: { blur: 3 } }), /实时背景配置无效/);
    await assert.rejects(patcher.apply(data), /实时背景配置无效/);
    await assert.rejects(patcher.restore(data), /实时背景配置无效/);
    assert.equal(await fs.readFile(livePath(data), 'utf8'), invalid);
    assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), html);
  }
  await fs.writeFile(livePath(data), live);
  const lstat = fs.lstat;
  t.mock.method(fs, 'lstat', async filename => {
    const info = await lstat(filename);
    if (filename === livePath(data)) return { ...info, isFile: () => true, isSymbolicLink: () => true };
    return info;
  });
  await assert.rejects(patcher.apply(data), /不是有效的普通文件/);
  await assert.rejects(patcher.updateConfig({ appRoot: data.appRoot, config: { blur: 3 } }), /不是有效的普通文件/);
  await assert.rejects(patcher.restore(data), /不是有效的普通文件/);
  assert.equal(await fs.readFile(livePath(data), 'utf8'), live);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), html);
});

test('cached scripts execute the shared regions module first and both hashes include its bytes', async t => {
  const data = await fixture(t);
  const video = path.join(data.appRoot, 'clip.webm');
  const playerPath = path.join(data.appRoot, 'video-player.js');
  const regionsPath = path.join(data.appRoot, 'regions.js');
  await fs.writeFile(video, 'cached video fixture');
  await fs.writeFile(data.rendererPath, 'globalThis.rendererRegionVersion = globalThis.FrostedRegions.version;');
  await fs.writeFile(playerPath, 'globalThis.playerRegionVersion = globalThis.FrostedRegions.version;');
  await patcher.apply({ ...data, mediaPath: video });

  const inspect = async () => {
    const html = await fs.readFile(data.workbenchPath, 'utf8');
    assert.equal(patcher.stripInjection(html), ORIGINAL, 'the workbench CSP and all original bytes stay unchanged');
    assert.equal((html.match(/data-frosted-config=/g) || []).length, 1, 'the workbench still has a single injected script');
    const rendererName = /src="\.\/frosted-background-assets\/(renderer-[a-f0-9]{64}\.js)"/.exec(html)[1];
    const payload = decodeConfig(html);
    const page = await fs.readFile(path.join(path.dirname(data.workbenchPath), payload.videoPlayer), 'utf8');
    const playerName = /src="\.\/(video-player-[a-f0-9]{64}\.js)"/.exec(page)[1];
    assert.equal((page.match(/<script /g) || []).length, 1, 'the video page still loads one script under its original CSP');
    const renderer = await fs.readFile(path.join(assetDirectory(data), rendererName));
    const player = await fs.readFile(path.join(assetDirectory(data), playerName));
    const shared = await fs.readFile(regionsPath);
    assert.deepEqual(renderer, Buffer.concat([shared, Buffer.from('\n;\n'), await fs.readFile(data.rendererPath)]));
    assert.deepEqual(player, Buffer.concat([shared, Buffer.from('\n;\n'), await fs.readFile(playerPath)]));
    assert.equal(rendererName, `renderer-${crypto.createHash('sha256').update(renderer).digest('hex')}.js`);
    assert.equal(playerName, `video-player-${crypto.createHash('sha256').update(player).digest('hex')}.js`);
    const rendererScope = {};
    const playerScope = {};
    vm.runInNewContext(renderer.toString('utf8'), rendererScope);
    vm.runInNewContext(player.toString('utf8'), playerScope);
    return { rendererName, playerName, payload, rendererVersion: rendererScope.rendererRegionVersion, playerVersion: playerScope.playerRegionVersion };
  };
  const first = await inspect();
  assert.equal(first.rendererVersion, 1);
  assert.equal(first.playerVersion, 1);
  await fs.unlink(video);
  await fs.writeFile(regionsPath, '(function(root) { root.FrostedRegions = { version: 2 }; })(globalThis);');
  await patcher.reapply({ appRoot: data.appRoot, rendererPath: data.rendererPath });
  const second = await inspect();
  assert.equal(second.rendererVersion, 2);
  assert.equal(second.playerVersion, 2);
  assert.notEqual(second.rendererName, first.rendererName, 'changing only regions.js invalidates the renderer cache');
  assert.notEqual(second.playerName, first.playerName, 'changing only regions.js invalidates the video-player cache');
  assert.notEqual(second.payload.videoPlayer, first.payload.videoPlayer, 'the video host follows the newly hashed bundled player');
  assert.equal(second.payload.source, first.payload.source, 'the existing cached media is retained');
  assert.equal((await patcher.status(data)).liveProtocol, 1, 'the existing injection parser accepts bundled scripts');
});

test('missing, empty, oversized or nonregular regions modules fail before any workbench or asset writes', async t => {
  for (const kind of ['missing', 'empty', 'oversized', 'directory']) {
    await t.test(kind, async child => {
      const data = await fixture(child);
      const filename = path.join(data.appRoot, 'regions.js');
      await fs.unlink(filename);
      if (kind === 'directory') await fs.mkdir(filename);
      if (kind === 'empty') await fs.writeFile(filename, '');
      if (kind === 'oversized') {
        const handle = await fs.open(filename, 'w');
        await handle.truncate(512 * 1024 + 1);
        await handle.close();
      }
      await assert.rejects(patcher.apply(data), /区域效果文件无效或缺失/);
      assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), ORIGINAL);
      await assert.rejects(fs.access(assetDirectory(data)), { code: 'ENOENT' });
    });
  }
});

test('all bundled runtime sources reject symbolic links without reading their target', async t => {
  for (const sourceName of ['regions.js', 'renderer.js', 'video-player.js']) {
    await t.test(sourceName, async child => {
      const data = await fixture(child);
      const video = path.join(data.appRoot, 'clip.webm');
      await fs.writeFile(video, 'video fixture');
      const blockedPath = path.join(data.appRoot, sourceName);
      const lstat = fs.lstat;
      const open = fs.open;
      child.mock.method(fs, 'lstat', async filename => {
        const info = await lstat(filename);
        return filename === blockedPath ? { ...info, isFile: () => true, isSymbolicLink: () => true } : info;
      });
      child.mock.method(fs, 'open', async (filename, ...args) => {
        assert.notEqual(filename, blockedPath, 'the symlink target must not be opened');
        return open(filename, ...args);
      });
      await assert.rejects(patcher.apply({ ...data, mediaPath: video }), /重新安装插件/);
      assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), ORIGINAL);
      await assert.rejects(fs.access(assetDirectory(data)), { code: 'ENOENT' });
    });
  }
});

test('the combined runtime bundle size is bounded before staging', async t => {
  const data = await fixture(t);
  const handle = await fs.open(data.rendererPath, 'w');
  await handle.truncate(2 * 1024 * 1024);
  await handle.close();
  await assert.rejects(patcher.apply(data), /插件运行文件无效或过大/);
  assert.equal(await fs.readFile(data.workbenchPath, 'utf8'), ORIGINAL);
  await assert.rejects(fs.access(assetDirectory(data)), { code: 'ENOENT' });
});
