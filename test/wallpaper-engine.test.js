'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createWallpaperEngine, parseLibraries, buildWorkshopSearchUrl } = require('../src/wallpaper-engine');

async function setup(t) {
  const parent = path.resolve(process.env.FROSTED_TEST_TMP || os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'frosted-we-test-'));
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.equal(path.dirname(absolute), parent);
    assert.ok(path.basename(absolute).startsWith('frosted-we-test-'));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const steam = path.join(root, 'Steam'), second = path.join(root, 'OtherLibrary');
  await fs.mkdir(path.join(steam, 'steamapps'), { recursive: true });
  const install = path.join(second, 'steamapps', 'common', 'wallpaper_engine');
  await fs.mkdir(path.join(install, 'projects', 'myprojects'), { recursive: true });
  await fs.mkdir(path.join(install, 'projects', 'defaultprojects'), { recursive: true });
  await fs.writeFile(path.join(install, 'wallpaper64.exe'), 'never executed fixture');
  const workshop = path.join(second, 'steamapps', 'workshop', 'content', '431960');
  await fs.mkdir(workshop, { recursive: true });
  await fs.writeFile(path.join(steam, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "0" { "path" ${JSON.stringify(steam)} } "1" { "path" ${JSON.stringify(second)} } }`);
  const calls = [];
  const service = createWallpaperEngine({ platform: 'win32', defaultRoots: [], execFile(exe, args, options, done) {
    calls.push({ exe, args, options });
    if (args[1] === 'HKCU\\Software\\Valve\\Steam') done(null, `\n    SteamPath    REG_SZ    ${steam}\n`);
    else done(new Error('not present'));
  } });
  const project = async (id, metadata, files = {}, folder = workshop) => {
    const directory = path.join(folder, id); await fs.mkdir(directory, { recursive: true });
    if (metadata !== undefined) await fs.writeFile(path.join(directory, 'project.json'), typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
    for (const [name, bytes] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true }); await fs.writeFile(path.join(directory, name), bytes); }
    return directory;
  };
  return { root, steam, second, install, workshop, calls, service, project };
}

test('Valve library parser handles old/current format, escaped paths and bounded invalid input', () => {
  const a = path.resolve('steam-fixture'), b = path.resolve('second-fixture');
  assert.deepEqual(parseLibraries(`"LibraryFolders" { "0" ${JSON.stringify(a)} "1" ${JSON.stringify(b)} }`), [a, b]);
  assert.deepEqual(parseLibraries(`// comment\n"libraryfolders" { "0" { "path" ${JSON.stringify(a)} "apps" { "431960" "123" } } }`), [a]);
  assert.deepEqual(parseLibraries('"libraryfolders" { "0" "\\\\server\\share" "1" "relative" }'), []);
  assert.deepEqual(parseLibraries(`"libraryfolders" { "0" ${JSON.stringify('\\\\server\\share')} }`), []);
  assert.deepEqual(parseLibraries('"libraryfolders" { "0" { "path"'), []);
  assert.deepEqual(parseLibraries(' '.repeat(256 * 1024 + 1)), []);
  assert.deepEqual(parseLibraries('"__proto__" { "polluted" "yes" }'), []);
  assert.equal({}.polluted, undefined);
});

test('discovery searches known Steam libraries and own projects with stable opaque IDs and data-only metadata', async t => {
  const f = await setup(t);
  await f.project('101', { type: 'video', title: 'A video', file: 'nested/clip.mp4', preview: 'thumb.gif' }, { 'nested/clip.mp4': 'video bytes', 'thumb.gif': 'GIF89a' });
  await f.project('102', { type: 'scene', title: 'Scene', file: 'scene.json' }, { 'scene.pkg': 'not executed' });
  await f.project('103', { type: 'web', title: 'Web', file: 'index.html' }, { 'index.html': '<script>throw new Error("must not run")</script>' });
  await f.project('104', { type: 'application', file: 'wallpaper.exe' }, { 'wallpaper.exe': 'never execute' });
  await f.project('105', '{broken json');
  await f.project('106', { title: 'Incomplete' });
  await f.project('my-wallpaper', { type: 'image', title: 'Z'.repeat(300) + '\u0000', file: 'image.PNG' }, { 'image.PNG': 'image bytes' }, path.join(f.install, 'projects', 'myprojects'));
  await f.project('default-wallpaper', { type: 'video', title: 'Default', file: 'default.webm' }, { 'default.webm': 'webm bytes' }, path.join(f.install, 'projects', 'defaultprojects'));
  const result = await f.service.discoverLibrary();
  assert.equal(result.installPath, await fs.realpath(f.install));
  assert.equal(result.items.length, 8); assert.equal(result.truncated, false);
  const video = result.items.find(item => item.workshopId === '101');
  assert.equal(video.supported, true); assert.ok(video.previewPath.endsWith('thumb.gif'));
  assert.equal(await f.service.resolveMedia(video), path.join(f.workshop, '101', 'nested', 'clip.mp4'));
  assert.ok(result.items.every(item => /^[a-f0-9]{64}$/.test(item.id) && Object.isFrozen(item) && item.title.length <= 160));
  assert.ok(result.items.filter(item => ['scene', 'web', 'application'].includes(item.type)).every(item => !item.supported && item.reason === 'unsupported-type' && !item.mediaPath));
  assert.equal(result.items.find(item => item.workshopId === '105').reason, 'invalid-project');
  assert.equal(result.items.find(item => item.workshopId === '106').reason, 'invalid-project');
  const again = await f.service.discoverLibrary();
  assert.deepEqual(again.items.map(item => item.id), result.items.map(item => item.id));
  for (const call of f.calls) {
    assert.match(call.exe, /[\\/]System32[\\/]reg\.exe$/i);
    assert.equal(call.options.windowsHide, true); assert.equal(call.options.shell, false);
    assert.equal(call.options.timeout, 2500); assert.equal(call.options.maxBuffer, 16384);
    assert.equal(call.args[0], 'query'); assert.equal(call.args[2], '/v');
    assert.ok(['SteamPath', 'InstallPath'].includes(call.args[3]));
    assert.match(call.args[1], /^HK(?:CU|LM)\\(?:Software|SOFTWARE)\\(?:WOW6432Node\\)?Valve\\Steam$/);
  }
});

test('explicit installation validates before returning, no installation is a quiet empty result', async t => {
  const f = await setup(t);
  const manual = createWallpaperEngine({ platform: 'linux', defaultRoots: [], execFile() { throw new Error('must not launch processes'); } });
  assert.deepEqual(await manual.discoverLibrary(), { installPath: null, items: [], skipped: 0, truncated: false });
  assert.equal((await manual.discoverLibrary({ installPath: f.install })).installPath, f.install);
  await assert.rejects(manual.discoverLibrary({ installPath: f.root }), { code: 'WE_INVALID_FOLDER' });
  await assert.rejects(manual.discoverLibrary({ installPath: '\\\\server\\wallpaper_engine' }), { code: 'WE_INVALID_FOLDER' });
  await assert.rejects(manual.discoverLibrary({ installPath: 'relative' }), { code: 'WE_INVALID_FOLDER' });
});

test('unsafe media and preview references, missing files and unsupported formats cannot be applied', async t => {
  const f = await setup(t);
  const references = ['../outside.mp4', f.install, '\\\\host\\share\\clip.mp4', 'file:///clip.mp4', 'sub/../clip.mp4', 'clip.mp4:stream'];
  for (let i = 0; i < references.length; i++) await f.project(String(200 + i), { type: 'video', file: references[i] });
  await f.project('210', { type: 'video', file: 'missing.mp4' });
  await f.project('211', { type: 'video', file: 'empty.mp4' }, { 'empty.mp4': '' });
  await f.project('212', { type: 'video', file: 'clip.exe' }, { 'clip.exe': 'must not execute' });
  await f.project('213', { type: 'image', file: 'image.png', preview: '../outside.jpg' }, { 'image.png': 'valid local bytes' });
  const items = (await f.service.discoverLibrary()).items;
  for (let i = 0; i < references.length; i++) assert.equal(items.find(item => item.workshopId === String(200 + i)).reason, 'unsafe-path');
  assert.equal(items.find(item => item.workshopId === '210').reason, 'missing-media');
  assert.equal(items.find(item => item.workshopId === '211').reason, 'missing-media');
  assert.equal(items.find(item => item.workshopId === '212').reason, 'unsupported-type');
  assert.equal(items.find(item => item.workshopId === '213').previewPath, undefined);
  await assert.rejects(f.service.resolveMedia(items.find(item => item.workshopId === '212')), { code: 'WE_UNSUPPORTED' });
});

test('media, preview and project byte limits are enforced without loading large assets', async t => {
  const f = await setup(t);
  const dir = await f.project('301', { type: 'video', file: 'large.mp4' }, { 'large.mp4': 'x' });
  const handle = await fs.open(path.join(dir, 'large.mp4'), 'r+');
  try { await handle.truncate(500 * 1024 * 1024 + 1); } finally { await handle.close(); }
  const p = await f.project('302', { type: 'image', file: 'ok.png', preview: 'large.jpg' }, { 'ok.png': 'x', 'large.jpg': 'x' });
  const preview = await fs.open(path.join(p, 'large.jpg'), 'r+');
  try { await preview.truncate(10 * 1024 * 1024 + 1); } finally { await preview.close(); }
  await f.project('303', ' '.repeat(256 * 1024 + 1));
  const items = (await f.service.discoverLibrary()).items;
  const tooLarge = items.find(item => item.workshopId === '301');
  assert.equal(tooLarge.reason, 'too-large'); assert.equal(tooLarge.mediaPath, undefined);
  await assert.rejects(f.service.resolveMedia(tooLarge), { code: 'WE_TOO_LARGE' });
  assert.equal(items.find(item => item.workshopId === '302').supported, true);
  assert.equal(items.find(item => item.workshopId === '302').previewPath, undefined);
  assert.equal(items.find(item => item.workshopId === '303').reason, 'invalid-project');
});

test('apply revalidates trusted objects, paths, metadata and file identity after discovery', async t => {
  const f = await setup(t);
  const dir = await f.project('401', { type: 'video', file: 'clip.mp4' }, { 'clip.mp4': 'first bytes', 'other.mp4': 'other bytes' });
  const item = (await f.service.discoverLibrary()).items[0];
  await assert.rejects(f.service.resolveMedia({ ...item }), { code: 'WE_CHANGED' });
  await assert.rejects(f.service.resolveMedia({ id: item.id, mediaPath: path.join(dir, 'other.mp4') }), { code: 'WE_CHANGED' });
  await fs.appendFile(path.join(dir, 'clip.mp4'), 'new bytes');
  await assert.rejects(f.service.resolveMedia(item), { code: 'WE_CHANGED' });
  const refreshed = (await f.service.discoverLibrary()).items[0];
  assert.equal(await f.service.resolveMedia(refreshed), path.join(dir, 'clip.mp4'));
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ type: 'video', file: 'other.mp4' }));
  await assert.rejects(f.service.resolveMedia(refreshed), { code: 'WE_CHANGED' });
});

test('directory links are neither discovered nor followed for media or install locations', async t => {
  const f = await setup(t);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'outside.mp4'), 'never import through a link');
  const dir = await f.project('501', { type: 'video', file: 'linked/outside.mp4' });
  try {
    await fs.symlink(outside, path.join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(outside, path.join(f.workshop, '502'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(f.install, path.join(f.root, 'linked-install'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (issue) { if (['EPERM', 'EACCES'].includes(issue.code)) { t.skip('Environment does not permit test directory links.'); return; } throw issue; }
  const result = await f.service.discoverLibrary();
  assert.equal(result.items.find(item => item.workshopId === '501').reason, 'unsafe-path');
  assert.equal(result.items.some(item => item.workshopId === '502'), false);
  assert.ok(result.skipped >= 1);
  await assert.rejects(f.service.discoverLibrary({ installPath: path.join(f.root, 'linked-install') }), { code: 'WE_INVALID_FOLDER' });
});

test('library item ceiling reports truncation and workshop URLs never accept another origin', async t => {
  const f = await setup(t);
  // Empty projects exercise enumeration bounds without loading any media.
  for (let start = 0; start < 1001; start += 25) await Promise.all(Array.from({ length: Math.min(25, 1001 - start) }, (_, i) => fs.mkdir(path.join(f.workshop, String(10000 + start + i)))));
  const result = await f.service.discoverLibrary();
  assert.equal(result.items.length, 1000); assert.equal(result.truncated, true);
  const url = new URL(buildWorkshopSearchUrl(' https://evil.example/?appid=1&x=y\nwallpaper '));
  assert.equal(url.origin, 'https://steamcommunity.com'); assert.equal(url.pathname, '/workshop/browse/');
  assert.equal(url.searchParams.get('appid'), '431960');
  assert.equal(url.searchParams.get('searchtext'), 'https://evil.example/?appid=1&x=y wallpaper');
  assert.equal(new URL(buildWorkshopSearchUrl('a'.repeat(500))).searchParams.get('searchtext').length, 200);
});
