'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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
  await fs.writeFile(rendererPath, '(() => { /* renderer fixture */ })();');
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
  assert.equal(decodeConfig(html).label, tricky);
  assert.equal(decodeConfig(html).kind, 'image');
  assert.equal(decodeConfig(html).enabled, true);
  assert.equal(decodeConfig(html).source.includes('https:'), false);
});

test('video files use the video renderer kind', async t => {
  const data = await fixture(t);
  const mediaPath = path.join(data.appRoot, 'clip.WEBM');
  await fs.writeFile(mediaPath, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  await patcher.apply({ ...data, mediaPath });
  const config = decodeConfig(await fs.readFile(data.workbenchPath, 'utf8'));
  assert.equal(config.kind, 'video');
  assert.match(config.source, /\.webm$/);
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
