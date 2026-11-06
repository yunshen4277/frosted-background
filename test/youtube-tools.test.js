'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { createYouTubeTools, unpackDeno, PINS } = require('../src/youtube-tools');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(binary, options = {}) {
  const name = Buffer.from(options.name || 'deno.exe'), method = options.method ?? 8;
  const compressed = method === 0 ? binary : zlib.deflateRawSync(binary);
  const flags = options.flags || 0, checksum = crc32(binary), size = options.size ?? binary.length;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
  if (!(flags & 8)) { local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22); }
  local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(((options.mode || 0o100644) << 16) >>> 0, 38);
  const descriptor = flags & 8 ? Buffer.alloc(16) : Buffer.alloc(0);
  if (descriptor.length) {
    descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4);
    descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(size, 12);
  }
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length + descriptor.length, 16);
  return Buffer.concat([local, name, compressed, descriptor, central, name, end]);
}

async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(process.env.FROSTED_TEST_TMP || os.tmpdir(), 'youtube-tools-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const extractorBytes = Buffer.from('MZ never-executed yt-dlp fixture');
  const runtimeBytes = Buffer.concat([Buffer.from('MZ never-executed Deno fixture'), Buffer.alloc(2048, 17)]);
  const archive = overrides.archive || zip(runtimeBytes);
  const pins = {
    extractor: { ...PINS.extractor, size: extractorBytes.length, sha256: digest(extractorBytes) },
    runtime: { ...PINS.runtime, size: archive.length, sha256: digest(archive), binarySize: runtimeBytes.length, binarySha256: digest(runtimeBytes) },
  };
  const calls = [], progress = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    if (overrides.request) return overrides.request(url, options, { pins, archive, extractorBytes, runtimeBytes });
    const bytes = url === pins.extractor.url ? extractorBytes : url === pins.runtime.url ? archive : undefined;
    assert.ok(bytes, 'unexpected offline request');
    options.onProgress?.(bytes.length);
    return { statusCode: 200, headers: { 'content-length': String(bytes.length) }, body: bytes };
  };
  const ensure = createYouTubeTools({ pins, request });
  const options = { directory, platform: 'win32', arch: 'x64', onProgress: (bytes, total) => progress.push({ bytes, total }) };
  return { directory, extractorBytes, runtimeBytes, archive, pins, calls, progress, ensure, options };
}

async function files(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => entry.isDirectory()
    ? (await files(path.join(directory, entry.name))).map(name => entry.name + '/' + name) : [entry.name]))).flat().sort();
}

test('pinned helpers are verified and safely unpacked; cache hits reverify both executables without network', async t => {
  const f = await fixture(t);
  const result = await f.ensure(f.options);
  assert.deepEqual(await fs.readFile(result.extractor), f.extractorBytes);
  assert.deepEqual(await fs.readFile(result.runtime), f.runtimeBytes);
  assert.equal(path.basename(result.extractor), 'yt-dlp.exe');
  assert.equal(path.basename(result.runtime), 'deno.exe');
  assert.ok(path.isAbsolute(result.extractor) && path.isAbsolute(result.runtime));
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.progress.at(-1), { bytes: f.pins.extractor.size + f.pins.runtime.size, total: f.pins.extractor.size + f.pins.runtime.size });
  assert.equal((await files(f.directory)).length, 2, 'no archive, metadata or partial files remain');
  f.calls.length = 0;
  assert.deepEqual(await f.ensure(f.options), result);
  assert.equal(f.calls.length, 0);
  const tampered = Buffer.from(f.extractorBytes); tampered[tampered.length - 1] ^= 1;
  await fs.writeFile(result.extractor, tampered);
  await f.ensure(f.options);
  assert.equal(f.calls.length, 1, 'same-size binary tampering requires the pinned download again');
  assert.deepEqual(await fs.readFile(result.extractor), f.extractorBytes);
  f.calls.length = 0;
  await fs.writeFile(result.runtime, Buffer.alloc(f.runtimeBytes.length, 1));
  await f.ensure(f.options);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await fs.readFile(result.runtime), f.runtimeBytes);
});

test('unsupported platforms, invalid directories and already canceled requests fail before any downloads', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  for (const options of [{ platform: 'darwin' }, { arch: 'arm64' }, { directory: 'relative' }, { signal: controller.signal }]) {
    await assert.rejects(f.ensure({ ...f.options, ...options }), failure => Boolean(failure.localizationKey));
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await files(f.directory), []);
});

test('only official release-asset redirects are followed and query secrets stay out of errors', async t => {
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/abc-def?sig=private';
  let redirected = false;
  const f = await fixture(t, { request(url, options, data) {
    if (url === data.pins.extractor.url && !redirected) { redirected = true; return { statusCode: 302, headers: { location: cdn }, body: Buffer.alloc(0) }; }
    return { statusCode: 200, headers: {}, body: url === cdn ? data.extractorBytes : data.archive };
  } });
  await f.ensure(f.options);
  assert.equal(f.calls[1].url, cdn);
  for (const target of ['http://release-assets.githubusercontent.com/github-production-release-asset/123/a',
    'https://example.com/yt-dlp.exe?secret=private', 'https://github.com/other/repo/releases/download/v1/a.exe',
    'https://user:password@release-assets.githubusercontent.com/github-production-release-asset/123/a',
    'https://release-assets.githubusercontent.com/not-release/123/a']) {
    const next = await fixture(t, { request: async () => ({ statusCode: 302, headers: { location: target }, body: Buffer.alloc(0) }) });
    await assert.rejects(next.ensure(next.options), failure => Boolean(failure.localizationKey) && !/private|password|example\.com/.test(failure.message));
    assert.equal(next.calls.length, 1);
    assert.deepEqual(await files(next.directory), []);
  }
});

test('oversized, incomplete, compressed, non-200 and hash-mismatched downloads are never published', async t => {
  for (const type of ['oversized', 'header-size', 'short', 'encoding', 'status', 'sha', 'shape']) {
    await t.test(type, async child => {
      const f = await fixture(child, { request(url, options, data) {
        const body = Buffer.from(data.extractorBytes);
        if (type === 'oversized') return { statusCode: 200, headers: {}, body: Buffer.concat([body, Buffer.from([0])]) };
        if (type === 'header-size') return { statusCode: 200, headers: { 'content-length': body.length + 1 }, body };
        if (type === 'short') return { statusCode: 200, headers: {}, body: body.subarray(1) };
        if (type === 'encoding') return { statusCode: 200, headers: { 'content-encoding': 'gzip' }, body };
        if (type === 'status') return { statusCode: 403, headers: {}, body: Buffer.alloc(0) };
        if (type === 'sha') body[body.length - 1] ^= 1;
        if (type === 'shape') return { statusCode: 200, headers: {}, body: 'not a Buffer' };
        return { statusCode: 200, headers: {}, body };
      } });
      await assert.rejects(f.ensure(f.options), failure => Boolean(failure.localizationKey));
      assert.deepEqual(await files(f.directory), []);
    });
  }
});

test('cache symlinks or directories are rejected without following or overwriting them', async t => {
  const f = await fixture(t), result = await f.ensure(f.options);
  const lstat = fs.lstat, open = fs.open;
  t.mock.method(fs, 'lstat', async filename => {
    const info = await lstat(filename);
    return filename === result.extractor ? { ...info, isFile: () => true, isSymbolicLink: () => true } : info;
  });
  t.mock.method(fs, 'open', async (filename, ...args) => { assert.notEqual(filename, result.extractor); return open(filename, ...args); });
  f.calls.length = 0;
  await assert.rejects(f.ensure(f.options), /缓存文件无效/);
  assert.equal(f.calls.length, 0);
  t.mock.restoreAll();
  await fs.unlink(result.runtime); await fs.mkdir(result.runtime);
  await assert.rejects(f.ensure(f.options), /缓存文件无效/);
  assert.ok((await fs.lstat(result.runtime)).isDirectory());
});

test('canceling a second download keeps the verified first tool and leaves no partial runtime', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { request(url, options, data) {
    if (url === data.pins.runtime.url) controller.abort();
    return { statusCode: 200, headers: {}, body: url === data.pins.extractor.url ? data.extractorBytes : data.archive };
  } });
  await assert.rejects(f.ensure({ ...f.options, signal: controller.signal }), /已取消/);
  assert.deepEqual(await files(f.directory), ['yt-dlp-2026.10.26/yt-dlp.exe']);
});

test('atomic publication failures and cancellation after writing clean every temporary file', async t => {
  for (const cancel of [false, true]) {
    await t.test(cancel ? 'abort after write' : 'rename fails', async child => {
      const f = await fixture(child), controller = new AbortController();
      if (cancel) {
        const write = fs.writeFile;
        child.mock.method(fs, 'writeFile', async (...args) => { await write(...args); controller.abort(); });
      } else child.mock.method(fs, 'rename', async () => { throw new Error('locked https://secret.example/?token=private'); });
      await assert.rejects(f.ensure({ ...f.options, signal: controller.signal }), failure => Boolean(failure.localizationKey) && !failure.message.includes('private'));
      assert.deepEqual(await files(f.directory), []);
    });
  }
});

test('the default HTTPS transport enforces its inactivity timeout without publishing partial tools', async t => {
  const f = await fixture(t);
  let timeoutMilliseconds;
  t.mock.method(https, 'get', (_url, options) => {
    assert.equal(options.agent, false);
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    const request = new EventEmitter();
    request.destroy = failure => { request.emit('error', failure); return request; };
    request.setTimeout = (milliseconds, callback) => { timeoutMilliseconds = milliseconds; setImmediate(callback); return request; };
    return request;
  });
  const ensure = createYouTubeTools();
  await assert.rejects(ensure(f.options), /下载超时/);
  assert.equal(timeoutMilliseconds, 20000);
  assert.deepEqual(await files(f.directory), []);
});

test('Deno ZIP parser accepts STORE, DEFLATE and signed data descriptors without using an extraction path', async () => {
  const bytes = Buffer.from('MZ tiny runtime fixture');
  for (const options of [{ method: 0 }, { method: 8 }, { method: 8, flags: 8 }]) assert.deepEqual(await unpackDeno(zip(bytes, options), bytes.length), bytes);
});

test('Deno ZIP parser rejects traversal, duplicates, symlinks, encryption, wrong lengths, CRC and zip bombs', async () => {
  const bytes = Buffer.from('MZ tiny runtime fixture');
  const duplicate = zip(bytes); duplicate.writeUInt16LE(2, duplicate.length - 14); duplicate.writeUInt16LE(2, duplicate.length - 12);
  const corruptCRC = zip(bytes); corruptCRC.writeUInt32LE(1, 14); corruptCRC.writeUInt32LE(1, corruptCRC.readUInt32LE(corruptCRC.length - 6) + 16);
  const wrongLocalName = zip(bytes); wrongLocalName[30] = 'x'.charCodeAt(0);
  const tooLarge = zip(Buffer.concat([bytes, Buffer.alloc(10000)]), { size: bytes.length });
  const invalid = [Buffer.alloc(30), zip(bytes, { name: '../deno.exe' }), zip(bytes, { name: 'DENO.EXE' }), zip(bytes, { name: 'nested/deno.exe' }),
    zip(bytes, { mode: 0o120777 }), zip(bytes, { flags: 1 }), zip(bytes, { method: 9 }), zip(bytes, { size: bytes.length + 1 }),
    duplicate, corruptCRC, wrongLocalName, tooLarge];
  for (const archive of invalid) await assert.rejects(unpackDeno(archive, bytes.length), /压缩包无效/);
});

test('even a hash-approved ZIP cannot publish a runtime with the wrong executable digest', async t => {
  const f = await fixture(t);
  const ensure = createYouTubeTools({ pins: { ...f.pins, runtime: { ...f.pins.runtime, binarySha256: '0'.repeat(64) } }, request: async url => ({ statusCode: 200, headers: {}, body: url === f.pins.extractor.url ? f.extractorBytes : f.archive }) });
  await assert.rejects(ensure(f.options), /校验失败/);
  assert.deepEqual(await files(f.directory), ['yt-dlp-2026.10.26/yt-dlp.exe']);
});
