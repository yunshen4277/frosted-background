'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { classifyLink, normalizeRemoteSource, displayName } = require('../media/source');
const { resolveMediaLink, publicAddress } = require('../src/remote-media');
const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
function network(routes) {
  const calls = [];
  return { calls, request(url, options, callback) {
    calls.push({ url: url.href, options });
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = failure => { if (failure) req.emit('error', failure); };
    req.end = () => setImmediate(() => {
      if (options.signal?.aborted) { const failure = new Error('aborted'); failure.name = 'AbortError'; req.emit('error', failure); return; }
      const route = routes.shift();
      if (!route) { req.emit('error', new Error('Unexpected request')); return; }
      const response = Readable.from(route.chunks || [route.body || png]);
      response.statusCode = route.status || 200;
      response.headers = route.headers || { 'content-type': 'image/png' };
      callback(response);
    });
    return req;
  } };
}
async function directory(t) {
  const value = await fs.mkdtemp(path.join(process.env.FROSTED_TEST_TMP || os.tmpdir(), 'frosted-remote-'));
  t.after(() => fs.rm(value, { recursive: true, force: true }));
  return path.resolve(value);
}

test('remote links classify platform URLs separately, preserving only playback identifiers', () => {
  assert.deepEqual(classifyLink('https://youtu.be/dQw4w9WgXcQ?si=tracking&t=12'), { type: 'platform', platform: 'YouTube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12' });
  assert.equal(classifyLink('https://www.youtube.com/@NASA/live').type, 'platform');
  assert.equal(classifyLink('https://player.twitch.tv/?channel=nasa&parent=example.com').url, 'https://www.twitch.tv/nasa');
  assert.equal(classifyLink('https://www.twitch.tv/videos/12345').type, 'platform');
  assert.equal(classifyLink('https://clips.twitch.tv/ExampleClip').type, 'platform');
  assert.equal(classifyLink('https://clips.twitch.tv/embed?clip=ExampleClip&parent=example.com').url, 'https://clips.twitch.tv/ExampleClip');
  assert.throws(() => classifyLink('https://clips.twitch.tv/embed'));
  assert.equal(classifyLink('https://cdn.example.com/image.png?token=private').type, 'image');
  assert.equal(classifyLink('https://cdn.example.com/live.m3u8?token=private').type, 'hls');
  assert.equal(classifyLink('https://cdn.example.com/download').type, 'auto');
  assert.equal(classifyLink('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ').type, 'auto');
  assert.throws(() => classifyLink('https://www.youtube.com/redirect?q=https://evil.example'));
  assert.equal(displayName('https://cdn.example.com/live.m3u8?token=secret'), 'cdn.example.com / live.m3u8');
});

test('remote links reject local targets, credentials and unsafe protocols', () => {
  for (const url of ['http://example.com/v.mp4', 'file:///C:/secret', 'javascript:alert(1)', 'https://user:pass@example.com/a', 'https://localhost/a', 'https://127.0.0.1/a', 'https://2130706433/a', 'https://0x7f000001/a', 'https://10.0.0.1/a', 'https://169.254.169.254/a', 'https://192.168.1.1/a', 'https://[::1]/a', 'https://printer.local/a', 'https://example.com/a\nb']) assert.throws(() => classifyLink(url), url);
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  assert.deepEqual(normalizeRemoteSource({ type: 'hls', kind: 'video', url: 'https://cdn.example.com/live?sig=private#fragment', extra: 1 }), { type: 'hls', kind: 'video', url: 'https://cdn.example.com/live?sig=private' });
});

test('downloads inspect content, keep tokens out of filenames and return a usable cache path', async t => {
  const cache = await directory(t), net = network([{ chunks: [png.subarray(0, 3), png.subarray(3)] }]);
  const file = await resolveMediaLink('https://cdn.example.com/download?token=secret', 'auto', { directory: cache, request: net.request });
  assert.equal(path.dirname(file), cache);
  assert.match(path.basename(file), /^cdn\.example\.com-[a-f0-9-]+\.png$/);
  assert.deepEqual(await fs.readFile(file), png);
  assert.equal(typeof net.calls[0].options.lookup, 'function');
  assert.equal(net.calls[0].options.headers.Cookie, undefined);
});

test('redirects are revalidated and unsupported, oversized or mismatched downloads leave no partial files', async t => {
  const cache = await directory(t);
  for (const routes of [
    [{ status: 302, headers: { location: 'https://127.0.0.1/private' } }],
    [{ status: 302, headers: { location: 'file:///secret' } }],
    [{ headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>login</html>') }],
    [{ headers: { 'content-type': 'image/png' }, body: Buffer.from('not an image') }],
    [{ chunks: [png, png], headers: {} }],
  ]) {
    const net = network(routes);
    await assert.rejects(resolveMediaLink('https://cdn.example.com/a', 'auto', { directory: cache, request: net.request, maxBytes: 15 }));
    assert.deepEqual(await fs.readdir(cache), []);
  }
  await assert.rejects(resolveMediaLink('https://cdn.example.com/a', 'video', { directory: cache, request: network([{}]).request }), /媒体类型/);
  assert.deepEqual(await fs.readdir(cache), []);
  const valid = network([{ status: 302, headers: { location: '/asset?sig=private' } }, {}]);
  assert.match(await resolveMediaLink('https://cdn.example.com/a', 'image', { directory: cache, request: valid.request }), /\.png$/);
  assert.equal(valid.calls[1].url, 'https://cdn.example.com/asset?sig=private');
});

test('HLS descriptors stream without download and platform URLs never become background assets', async t => {
  const cache = await directory(t), net = network([]);
  const result = await resolveMediaLink('https://cdn.example.com/live.m3u8?token=secret', 'auto', { directory: cache, request: net.request });
  assert.equal(result.type, 'hls'); assert.equal(net.calls.length, 0);
  assert.equal((await resolveMediaLink('https://www.twitch.tv/nasa', 'video', { directory: cache, request: net.request })).type, 'platform');
  assert.equal(net.calls.length, 0);
  const detected = await resolveMediaLink('https://cdn.example.com/stream', 'auto', { directory: cache, request: network([{ headers: { 'content-type': 'application/vnd.apple.mpegurl' } }]).request });
  assert.equal(detected.type, 'hls'); assert.deepEqual(await fs.readdir(cache), []);
});

test('canceling a download preserves the old cache and removes partial work', async t => {
  const cache = await directory(t), abort = new AbortController();
  await fs.writeFile(path.join(cache, 'old.png'), png);
  abort.abort();
  await assert.rejects(resolveMediaLink('https://cdn.example.com/live.m3u8', 'auto', { signal: abort.signal }), /取消/);
  await assert.rejects(resolveMediaLink('https://cdn.example.com/a.png', 'image', { directory: cache, signal: abort.signal, request: network([{}]).request }), /取消/);
  assert.deepEqual(await fs.readdir(cache), ['old.png']);
  const midDownload = new AbortController();
  async function* chunks() {
    yield png;
    await new Promise(resolve => setImmediate(resolve));
    midDownload.abort();
    yield png;
  }
  await assert.rejects(resolveMediaLink('https://cdn.example.com/a.png', 'image', { directory: cache, signal: midDownload.signal, request: network([{ chunks: chunks() }]).request }), /取消/);
  assert.deepEqual(await fs.readdir(cache), ['old.png']);
});
