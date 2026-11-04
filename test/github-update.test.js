'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { findRelease, downloadRelease, compareVersions, LIMITS } = require('../src/github-update');

const repository = 'example-owner/frosted-background';
const extensionId = 'local-frosted.frosted-background';
const version = '0.3.0';
const assetName = `frosted-background-${version}.vsix`;
const base = `https://github.com/${repository}/releases/download/v${version}`;
const release = { version, assetUrl: `${base}/${assetName}`, manifestUrl: `${base}/update-manifest.json`, pageUrl: `https://github.com/${repository}/releases/tag/v${version}` };

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}

// Build real STORE/DEFLATE ZIP fixtures without a test or runtime dependency.
function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), data = Buffer.from(file.data), method = file.method ?? 8;
    const compressed = method === 0 ? data : zlib.deflateRawSync(data);
    const header = Buffer.alloc(30), record = Buffer.alloc(46), checksum = crc32(data);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(file.flags || 0, 6);
    header.writeUInt16LE(method, 8); header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(file.claimedSize ?? data.length, 22); header.writeUInt16LE(name.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(file.flags || 0, 8); record.writeUInt16LE(method, 10); record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(file.claimedSize ?? data.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(file.mode ? (file.mode << 16) >>> 0 : 0, 38); record.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(record, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function packageFiles(options = {}) {
  const pkg = { name: 'frosted-background', publisher: 'local-frosted', version, engines: { vscode: '^1.90.0' }, ...options.pkg };
  return [
    { name: 'extension/package.json', data: JSON.stringify(pkg), ...(options.packageEntry || {}) },
    { name: 'extension.vsixmanifest', data: options.xml || `<PackageManifest><Metadata><Identity Id="frosted-background" Publisher="local-frosted" Version="${version}" /></Metadata></PackageManifest>` },
    { name: 'extension/src/extension.js', data: '// fixture only; never executed' },
    ...(options.extra || [])
  ];
}

function metadata(overrides = {}) {
  return {
    tag_name: `v${version}`, html_url: release.pageUrl, draft: false, prerelease: false,
    assets: [
      { name: assetName, state: 'uploaded', size: 1024, browser_download_url: release.assetUrl },
      { name: 'update-manifest.json', state: 'uploaded', size: 200, browser_download_url: release.manifestUrl }
    ], ...overrides
  };
}

function response(body, statusCode = 200, headers = {}) {
  return { statusCode, headers, body: Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) };
}

async function downloadFixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(process.env.FROSTED_TEST_TMP || os.tmpdir(), 'github-update-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = options.bytes || zip(packageFiles(options));
  const manifest = { version, extensionId, assetName, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...options.manifest };
  const calls = [];
  const request = async (url, settings) => {
    calls.push({ url, settings });
    if (options.request) return options.request(url, settings, { bytes, manifest });
    if (url === release.manifestUrl) return response(manifest);
    if (url === release.assetUrl) return response(bytes);
    throw new Error('Unexpected offline URL');
  };
  return { directory, bytes, manifest, calls, request, options: { release, repository, extensionId, directory, request } };
}

test('stable version comparison is numeric and refuses prerelease or ambiguous versions', () => {
  assert.equal(compareVersions('1.10.0', '1.9.99'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('0.2.0', '0.3.0'), -1);
  for (const bad of ['v1.0.0', '01.0.0', '1.0', '1.0.0-beta', '1.0.0+build', '', null]) assert.throws(() => compareVersions(bad, '0.1.0'), /稳定版/);
});

test('latest release lookup uses only the validated public API and finds the expected assets', async () => {
  const calls = [];
  const actual = await findRelease({ repository, currentVersion: '0.2.0', extensionId, request: async (url, settings) => {
    calls.push({ url, settings }); return response(metadata());
  } });
  assert.deepEqual(actual, release);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.github.com/repos/${repository}/releases/latest`);
  assert.equal(calls[0].settings.maxBytes, LIMITS.release);
  assert.equal(calls[0].settings.headers.Authorization, undefined);
});

test('same, older and unpublished releases never produce an update', async () => {
  for (const currentVersion of ['0.3.0', '0.4.0']) {
    assert.equal(await findRelease({ repository, currentVersion, extensionId, request: async () => response(metadata()) }), null);
  }
  assert.equal(await findRelease({ repository, currentVersion: '0.2.0', extensionId, request: async () => response('', 404) }), null);
});

test('invalid repositories are rejected before transport access', async () => {
  let called = false;
  for (const value of ['https://github.com/a/b', 'a/b/c', 'a/..', 'a/b?token=x', 'a_b/repo', 'a/b#x', 'a/repo%2fother', 'a/b\n', 'a--b/repo']) {
    await assert.rejects(findRelease({ repository: value, currentVersion: '0.2.0', extensionId, request: async () => { called = true; } }));
  }
  assert.equal(called, false);
});

test('drafts, prereleases, missing assets, duplicate assets and mismatched tags are rejected', async () => {
  const valid = metadata();
  const cases = [
    metadata({ draft: true }), metadata({ prerelease: true }), metadata({ tag_name: 'v0.3.0-beta' }),
    metadata({ assets: [] }), metadata({ assets: [...valid.assets, valid.assets[0]] }),
    metadata({ tag_name: 'v0.4.0' }), metadata({ html_url: 'https://github.com/other/repo/releases/tag/v0.3.0' }),
    metadata({ assets: valid.assets.map((item, i) => i ? item : { ...item, size: LIMITS.vsix + 1 }) })
  ];
  for (const data of cases) await assert.rejects(findRelease({ repository, currentVersion: '0.2.0', extensionId, request: async () => response(data) }));
});

test('unexpected API redirects and non-success responses fail without contacting their destinations', async () => {
  const calls = [];
  await assert.rejects(findRelease({ repository, currentVersion: '0.2.0', extensionId, request: async url => {
    calls.push(url); return response('', 302, { location: 'https://api.github.com/repos/other/repo/releases/latest' });
  } }), /不受信任/);
  assert.equal(calls.length, 1);
  await assert.rejects(findRelease({ repository, currentVersion: '0.2.0', extensionId, request: async () => response({}, 403) }), /HTTP 403/);
});

test('verified VSIX download checks manifest, ZIP identity and engine metadata before writing', async t => {
  const env = await downloadFixture(t);
  const result = await downloadRelease(env.options);
  assert.equal(result.version, version);
  assert.deepEqual(result.engines, { vscode: '^1.90.0' });
  assert.equal(path.dirname(result.filePath), env.directory);
  assert.match(path.basename(result.filePath), /^frosted-background-0\.3\.0-[a-f0-9-]+\.vsix$/);
  assert.deepEqual(await fs.readFile(result.filePath), env.bytes);
  assert.equal((await fs.readdir(env.directory)).length, 1);
  assert.deepEqual(env.calls.map(call => call.url), [release.manifestUrl, release.assetUrl]);
});

test('GitHub release CDN redirects are accepted without forwarding API headers or credentials', async t => {
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/abcd-1234?signature=fixture';
  const env = await downloadFixture(t, { request: async (url, settings, files) => {
    if (url === release.manifestUrl) return response(files.manifest);
    if (url === release.assetUrl) return response('', 302, { Location: cdn });
    assert.equal(url, cdn);
    assert.equal(settings.headers.Authorization, undefined);
    assert.equal(settings.headers['X-GitHub-Api-Version'], undefined);
    return response(files.bytes);
  } });
  const result = await downloadRelease(env.options);
  assert.deepEqual(await fs.readFile(result.filePath), env.bytes);
});

test('cross-repository, HTTP, credentialed and hostile release URLs never reach transport', async t => {
  const env = await downloadFixture(t);
  for (const assetUrl of [
    release.assetUrl.replace(repository, 'other/repo'), release.assetUrl.replace('https:', 'http:'),
    release.assetUrl.replace('github.com', 'github.com.evil.example'), release.assetUrl.replace('github.com', 'user:secret@github.com'),
    release.assetUrl + '?token=x', release.assetUrl.replace('v0.3.0', 'v0.4.0')
  ]) await assert.rejects(downloadRelease({ ...env.options, release: { ...release, assetUrl } }));
  assert.equal(env.calls.length, 0);
  assert.deepEqual(await fs.readdir(env.directory), []);
});

test('untrusted download redirects are refused before contacting the destination', async t => {
  for (const location of ['https://evil.example/file.vsix', 'http://release-assets.githubusercontent.com/github-production-release-asset/1/abc', 'https://github.com/other/repo/releases/download/v0.3.0/file.vsix', 'https://release-assets.githubusercontent.com/not-release-assets/abc']) {
    const env = await downloadFixture(t, { request: async (url, settings, files) => url === release.manifestUrl ? response(files.manifest) : response('', 302, { location }) });
    await assert.rejects(downloadRelease(env.options), /重定向/);
    assert.equal(env.calls.length, 2);
    assert.deepEqual(await fs.readdir(env.directory), []);
  }
});

test('manifest identity, version, filename and SHA-256 must agree before installing', async t => {
  for (const manifest of [{ extensionId: 'other.extension' }, { version: '0.2.0' }, { assetName: '../evil.vsix' }, { sha256: 'not-a-hash' }, { sha256: 'a'.repeat(64) }]) {
    const env = await downloadFixture(t, { manifest });
    await assert.rejects(downloadRelease(env.options), /清单|SHA-256/);
    assert.deepEqual(await fs.readdir(env.directory), []);
    assert.equal(env.calls.length, manifest.sha256 === 'a'.repeat(64) ? 2 : 1);
  }
});

test('a valid hash cannot authorize a different extension, version or XML identity', async t => {
  for (const options of [
    { pkg: { publisher: 'someone-else' } }, { pkg: { name: 'unrelated' } }, { pkg: { version: '0.2.0' } },
    { pkg: { engines: {} } }, { xml: '<PackageManifest><Identity Id="evil" Publisher="local-frosted" Version="0.3.0" /></PackageManifest>' }
  ]) {
    const env = await downloadFixture(t, options);
    await assert.rejects(downloadRelease(env.options), /VSIX/);
    assert.deepEqual(await fs.readdir(env.directory), []);
  }
});

test('ZIP traversal, duplicate names, symlinks and encryption are rejected without extraction', async t => {
  for (const options of [
    { extra: [{ name: '../escape.js', data: 'x' }] }, { extra: [{ name: 'extension\\escape.js', data: 'x' }] },
    { extra: [{ name: 'EXTENSION/PACKAGE.JSON', data: '{}' }] }, { extra: [{ name: 'extension/link', data: '/outside', mode: 0xa1ff }] },
    { packageEntry: { flags: 1 } }, { packageEntry: { claimedSize: LIMITS.package + 1 } },
    { bytes: Buffer.from('not a VSIX') }
  ]) {
    const env = await downloadFixture(t, options);
    await assert.rejects(downloadRelease(env.options), /VSIX/);
    assert.deepEqual(await fs.readdir(env.directory), []);
  }
});

test('download limits apply to transport bodies and claimed lengths even with an injected transport', async t => {
  const env = await downloadFixture(t, { request: async (url, settings, files) => url === release.manifestUrl ? response(files.manifest) : response(files.bytes, 200, { 'content-length': String(LIMITS.vsix + 1) }) });
  await assert.rejects(downloadRelease(env.options), /超过允许大小/);
  const hugeManifest = await downloadFixture(t, { request: async () => response(Buffer.alloc(LIMITS.manifest + 1)) });
  await assert.rejects(downloadRelease(hugeManifest.options), /超过允许大小/);
});

test('aborted work does not issue requests or publish an install candidate', async t => {
  const env = await downloadFixture(t);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(downloadRelease({ ...env.options, signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal(env.calls.length, 0);
  const during = new AbortController();
  const originalRequest = env.request;
  await assert.rejects(downloadRelease({ ...env.options, signal: during.signal, request: async (...args) => {
    const result = await originalRequest(...args);
    if (args[0] === release.assetUrl) during.abort();
    return result;
  } }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(env.directory), []);
});

test('STORE ZIP entries are supported and repeat downloads never overwrite an earlier package', async t => {
  const env = await downloadFixture(t, { packageEntry: { method: 0 } });
  const first = await downloadRelease(env.options), second = await downloadRelease(env.options);
  assert.notEqual(first.filePath, second.filePath);
  assert.deepEqual(await fs.readFile(first.filePath), env.bytes);
  assert.deepEqual(await fs.readFile(second.filePath), env.bytes);
  assert.equal((await fs.readdir(env.directory)).length, 2);
});

test('download independently rejects an equal or older version when the installed version is supplied', async t => {
  const env = await downloadFixture(t);
  for (const currentVersion of [version, '1.0.0']) {
    await assert.rejects(downloadRelease({ ...env.options, currentVersion }), /高于当前已安装版本/);
  }
  assert.equal(env.calls.length, 0);
  assert.deepEqual(await fs.readdir(env.directory), []);
});
