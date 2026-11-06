'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { resolveYouTubeLink } = require('../src/youtube-media');

const ID = 'abcdefghijk';
const LINK = 'https://youtu.be/' + ID + '?si=tracking&t=30';
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('fixture-webm')]);
const MP4 = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
const format = overrides => ({ format_id: '247', url: 'https://rr1.example.googlevideo.com/videoplayback?expire=1&secret=private-token', ext: 'webm', protocol: 'https', vcodec: 'vp9', acodec: 'none', width: 1280, height: 720, fps: 30, filesize: 10000, ...overrides });
const metadata = overrides => ({ _type: 'video', id: ID, is_live: false, live_status: 'not_live', availability: 'public', has_drm: false, formats: [format()], ...overrides });

async function harness(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(process.env.FROSTED_TEST_TMP || os.tmpdir(), 'frosted-youtube-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = { ensure: [], spawn: [], download: [], stages: [], progress: [], kills: 0 };
  let started, nativeStarted;
  const spawned = new Promise(resolve => { started = resolve; });
  const nativeSpawned = new Promise(resolve => { nativeStarted = resolve; });
  const tools = { extractor: path.join(directory, 'tools', 'yt-dlp.exe'), runtime: path.join(directory, 'tools', 'deno.exe') };
  const spawn = (file, args, spawnOptions) => {
    calls.spawn.push({ file, args, options: spawnOptions });
    const child = new EventEmitter();
    child.unref = () => {};
    if (path.basename(file).toLowerCase() === 'taskkill.exe') { if (!options.taskkillHold) queueMicrotask(() => child.emit('close', 0)); return child; }
    child.pid = 41234;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { calls.kills++; calls.lastKillSignal = signal; if (!options.killHold || signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null)); return true; };
    queueMicrotask(async () => {
      if (!args.includes('--dump-single-json')) {
        try {
          const output = args[args.indexOf('--output') + 1];
          if (!options.nativeNoFile) await fs.writeFile(output, options.nativeBytes || WEBM);
          nativeStarted({ child, output });
          if (options.nativeHold) return;
          for (const chunk of options.nativeStdout || ['FROSTED_BYTES=16\n']) child.stdout.write(chunk);
          for (const chunk of options.nativeStderr || []) child.stderr.write(chunk);
          child.stdout.end(); child.stderr.end(); child.emit('close', options.nativeCode || 0);
        } catch (failure) { child.emit('error', failure); }
        return;
      }
      started(child);
      if (options.hold) return;
      if (options.processError) { child.emit('error', new Error('sensitive-process-error private-token')); return; }
      for (const chunk of options.stdout || [JSON.stringify(options.metadata || metadata())]) child.stdout.write(chunk);
      for (const chunk of options.stderr || []) child.stderr.write(chunk);
      child.stdout.end(); child.stderr.end(); child.emit('close', options.code || 0);
    });
    return child;
  };
  const dependencies = {
    directory, spawn,
    ensureTools: async value => { calls.ensure.push(value); return tools; },
    download: async (url, kind, value) => {
      calls.download.push({ url, kind, options: value });
      if (options.downloadError) throw options.downloadError;
      const filename = path.join(directory, 'rr1.example.googlevideo.com-fixture.' + (options.mp4 ? 'mp4' : 'webm'));
      await fs.writeFile(filename, options.bytes || (options.mp4 ? MP4 : WEBM));
      value.onProgress?.(10000);
      options.afterDownload?.();
      return options.downloadResult || filename;
    },
    onStage: stage => calls.stages.push(stage),
    onProgress: bytes => calls.progress.push(bytes),
  };
  return { directory, calls, dependencies, tools, spawned, nativeSpawned };
}

test('YouTube import resolves one canonical video with isolated tool arguments then returns a local cache file', async t => {
  const env = await harness(t), abort = new AbortController();
  const original = process.env.NODE_OPTIONS, proxy = process.env.HTTPS_PROXY;
  process.env.NODE_OPTIONS = '--require secret.js'; process.env.HTTPS_PROXY = 'http://credential:secret@proxy.invalid';
  try {
    const result = await resolveYouTubeLink(LINK, 'auto', { ...env.dependencies, signal: abort.signal });
    assert.equal(path.dirname(result), env.directory);
    assert.match(path.basename(result), /^YouTube-abcdefghijk-[a-f\d-]{36}\.webm$/);
    assert.deepEqual(await fs.readFile(result), WEBM);
    assert.deepEqual(env.calls.stages, ['prepare', 'resolve', 'download']);
    assert.deepEqual(env.calls.progress, [10000]);
    assert.deepEqual(env.calls.ensure, [{ directory: path.join(env.directory, 'tools'), signal: abort.signal, onProgress: env.dependencies.onProgress }]);
    const command = env.calls.spawn[0];
    assert.equal(command.file, env.tools.extractor);
    assert.equal(command.options.cwd, env.directory);
    assert.equal(command.options.shell, false); assert.equal(command.options.windowsHide, true);
    assert.deepEqual(command.options.stdio, ['ignore', 'pipe', 'pipe']);
    for (const flag of ['--ignore-config', '--no-plugin-dirs', '--no-cookies', '--no-cookies-from-browser', '--no-cache-dir', '--no-playlist', '--no-exec', '--no-remote-components', '--skip-download', '--dump-single-json']) assert.ok(command.args.includes(flag), flag);
    assert.equal(command.args[command.args.indexOf('--js-runtimes') + 1], 'deno:' + env.tools.runtime);
    assert.deepEqual(command.args.slice(-2), ['--', 'https://www.youtube.com/watch?v=' + ID]);
    assert.equal(command.options.env.NODE_OPTIONS, undefined); assert.equal(command.options.env.HTTPS_PROXY, undefined);
    assert.equal(command.options.env.PYTHONIOENCODING, 'utf-8');
    assert.equal(env.calls.download[0].url, format().url);
    assert.equal(env.calls.download[0].kind, 'video'); assert.equal(env.calls.download[0].options.signal, abort.signal);
    assert.deepEqual(await fs.readdir(env.directory), [path.basename(result)]);
  } finally {
    if (original === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = original;
    if (proxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = proxy;
  }
});

test('YouTube imports reject unsupported links and wrong media kinds before preparing tools', async t => {
  const env = await harness(t);
  for (const [url, kind] of [[LINK, 'image'], [LINK, 'hls'], ['https://www.twitch.tv/nasa', 'auto'], ['https://www.youtube.com/@NASA/live', 'video'], ['https://www.youtube.com/live/' + ID, 'video'], ['https://www.youtube.com/playlist?list=PL1', 'video'], ['https://youtube.com.evil.example/watch?v=' + ID, 'video'], ['http://youtu.be/' + ID, 'video']]) {
    await assert.rejects(resolveYouTubeLink(url, kind, env.dependencies), failure => typeof failure.localizationKey === 'string');
  }
  assert.equal(env.calls.ensure.length, 0); assert.equal(env.calls.spawn.length, 0); assert.equal(env.calls.download.length, 0);
  await assert.rejects(resolveYouTubeLink(LINK, 'video', { ...env.dependencies, directory: 'relative' }), /缓存/);
});

test('metadata identity, livestream, upcoming, private and DRM checks stop before any media download', async t => {
  for (const value of [null, [], metadata({ id: 'otherVideo1' }), metadata({ _type: 'playlist' }), metadata({ is_live: true }), metadata({ is_upcoming: true }), metadata({ live_status: 'post_live' }), metadata({ live_status: 'is_upcoming' }), metadata({ availability: 'private' }), metadata({ availability: 'premium_only' }), metadata({ needs_auth: true }), metadata({ has_drm: true }), metadata({ drm_family: 'widevine' })]) {
    const env = await harness(t, { stdout: [JSON.stringify(value)] });
    await assert.rejects(resolveYouTubeLink(LINK, 'video', env.dependencies), failure => Boolean(failure.localizationKey));
    assert.equal(env.calls.download.length, 0);
  }
  const archived = await harness(t, { metadata: metadata({ live_status: 'was_live', availability: 'unlisted' }) });
  assert.match(await resolveYouTubeLink(LINK, 'video', archived.dependencies), /\.webm$/);
});

test('format selection prefers compatible direct WebM, caps resolution and rejects unsafe, fragmented or DRM formats', async t => {
  const alternatives = [
    format({ format_id: 'mp4', url: 'https://rr1.example.googlevideo.com/mp4', ext: 'mp4', vcodec: 'avc1.4d401f' }),
    format({ url: 'https://rr1.example.googlevideo.com/low', height: 480 }),
    format({ url: 'https://rr1.example.googlevideo.com/high', height: 1080 }),
    format({ url: 'https://rr1.example.googlevideo.com/drm', has_drm: true }),
    format({ url: 'https://rr1.example.googlevideo.com/fragment', fragments: [{ url: 'part' }] }),
    format({ url: 'https://rr1.example.googlevideo.com/hls', protocol: 'm3u8_native' }),
    format({ url: 'https://rr1.example.googlevideo.com/av1', vcodec: 'av01.0.05M.08' }),
    format({ url: 'https://rr1.example.googlevideo.com/audio', vcodec: 'none' }),
    format({ url: 'https://rr1.example.googlevideo.com/muxed', acodec: 'opus' }),
    format({ url: 'https://rr1.example.googlevideo.com/large', filesize: 501 * 1024 * 1024 }),
    format({ url: 'https://rr1.example.googlevideo.com/estimated-large', filesize_approx: 501 * 1024 * 1024 }),
    format({ url: 'https://rr1.example.googlevideo.com/invalid-size', filesize: -1 }),
    format({ url: 'https://rr1.example.googlevideo.com/invalid-height', height: null }),
    format({ url: 'https://rr1.example.googlevideo.com/invalid-width', width: 0 }),
    format({ url: 'https://googlevideo.com.evil.example/v' }),
    format({ url: 'https://user:secret@rr1.example.googlevideo.com/v' }),
    format({ url: 'https://127.0.0.1/v' }),
    format({ url: 'http://rr1.example.googlevideo.com/v' }),
    format({ url: 'https://rr1.example.googlevideo.com:8080/v' }),
    format({ url: 'https://rr1.example.googlevideo.com/best', vcodec: 'vp09.00.31.08', fps: 60 }),
  ];
  const env = await harness(t, { metadata: metadata({ formats: alternatives }) });
  await resolveYouTubeLink(LINK, 'video', env.dependencies);
  assert.equal(env.calls.download[0].url, 'https://rr1.example.googlevideo.com/best');
  const mp4 = await harness(t, { mp4: true, metadata: metadata({ formats: [alternatives[0]] }) });
  assert.match(await resolveYouTubeLink(LINK, 'video', mp4.dependencies), /\.mp4$/);
  const none = await harness(t, { metadata: metadata({ formats: alternatives.slice(2, -1) }) });
  await assert.rejects(resolveYouTubeLink(LINK, 'video', none.dependencies), /兼容/);
  assert.equal(none.calls.download.length, 0);
});

test('unknown nullable availability is accepted without weakening explicit access or DRM denials', async t => {
  const unknown = await harness(t, { metadata: metadata({ availability: null }) });
  assert.match(await resolveYouTubeLink(LINK, 'video', unknown.dependencies), /\.webm$/);
  for (const flags of [{ has_drm: true }, { is_private: true }, { needs_auth: true }, { availability: 'needs_auth' }, { availability: 'subscriber_only' }]) {
    const env = await harness(t, { metadata: metadata({ availability: null, ...flags }) });
    await assert.rejects(resolveYouTubeLink(LINK, 'video', env.dependencies), /访问权限或 DRM/);
    assert.equal(env.calls.download.length, 0);
  }
});

test('helper failures and malformed metadata never expose stderr or signed URLs', async t => {
  for (const options of [{ code: 1, stderr: ['secret=private-token C:/private/file'] }, { processError: true }, { stdout: ['not JSON private-token'] }]) {
    const env = await harness(t, options);
    await assert.rejects(resolveYouTubeLink(LINK, 'video', env.dependencies), failure => {
      assert.ok(failure.localizationKey); assert.doesNotMatch(failure.message, /private-token|C:\/private/); return true;
    });
    assert.equal(env.calls.download.length, 0);
  }
});

test('oversized stdout and stderr terminate the owned helper before downloading', async t => {
  for (const options of [{ stdout: [Buffer.alloc(10 * 1024 * 1024 + 1)] }, { stderr: [Buffer.alloc(20 * 1024 + 1)] }]) {
    const env = await harness(t, options);
    await assert.rejects(resolveYouTubeLink(LINK, 'video', env.dependencies), /大小限制/);
    if (process.platform === 'win32') {
      assert.equal(path.basename(env.calls.spawn[1].file).toLowerCase(), 'taskkill.exe');
      assert.deepEqual(env.calls.spawn[1].args, ['/PID', '41234', '/T', '/F']);
      assert.equal(env.calls.spawn[1].options.shell, false); assert.equal(env.calls.spawn[1].options.windowsHide, true);
    } else assert.equal(env.calls.kills, 1);
    assert.equal(env.calls.download.length, 0);
  }
});

test('cancelled metadata stops the process tree, while pre-cancellation does not prepare tools', async t => {
  const abort = new AbortController(), env = await harness(t, { hold: true });
  const result = resolveYouTubeLink(LINK, 'video', { ...env.dependencies, signal: abort.signal });
  const rejected = assert.rejects(result, /取消/);
  await env.spawned;
  abort.abort();
  await rejected;
  assert.equal(env.calls.download.length, 0);
  assert.equal(process.platform === 'win32' ? env.calls.spawn.length : env.calls.kills, process.platform === 'win32' ? 2 : 1);
  const before = await harness(t);
  await assert.rejects(resolveYouTubeLink(LINK, 'video', { ...before.dependencies, signal: abort.signal }), /取消/);
  assert.equal(before.calls.ensure.length, 0);
});

test('metadata parsing has a hard 90 second deadline', async t => {
  const env = await harness(t, { hold: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = resolveYouTubeLink(LINK, 'video', env.dependencies);
  const rejected = assert.rejects(result, /超时/);
  await env.spawned;
  t.mock.timers.tick(90000);
  await rejected;
  assert.equal(env.calls.download.length, 0);
});

test('termination forces the owned helper if graceful or process-tree stopping stalls', async t => {
  const abort = new AbortController(), env = await harness(t, { hold: true, taskkillHold: true, killHold: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const promise = resolveYouTubeLink(LINK, 'video', { ...env.dependencies, signal: abort.signal });
  const rejected = assert.rejects(promise, /取消/);
  await env.spawned;
  abort.abort();
  t.mock.timers.tick(3000);
  await rejected;
  assert.equal(env.calls.lastKillSignal, 'SIGKILL');
  assert.equal(env.calls.download.length, 0);
});

test('cancelled or invalid downloads remove only new cache work and preserve the old background', async t => {
  for (const invalidBytes of [Buffer.from('not media'), Buffer.alloc(0)]) {
    const env = await harness(t, { bytes: invalidBytes });
    await fs.writeFile(path.join(env.directory, 'existing.webm'), WEBM);
    await assert.rejects(resolveYouTubeLink(LINK, 'video', env.dependencies), /下载结果无效/);
    assert.deepEqual(await fs.readdir(env.directory), ['existing.webm']);
  }
  const abort = new AbortController(), env = await harness(t, { afterDownload: () => abort.abort() });
  await fs.writeFile(path.join(env.directory, 'existing.webm'), WEBM);
  await assert.rejects(resolveYouTubeLink(LINK, 'video', { ...env.dependencies, signal: abort.signal }), /取消/);
  assert.deepEqual(await fs.readdir(env.directory), ['existing.webm']);
  const descriptor = await harness(t, { downloadResult: { type: 'hls', url: 'https://other.example/a.m3u8' } });
  await assert.rejects(resolveYouTubeLink(LINK, 'video', descriptor.dependencies), /下载结果无效/);
});

test('downloader errors retain localized messages without leaking arbitrary transport details', async t => {
  for (const failure of [new Error('https://signed.example/?token=private-token'), Object.assign(new Error('背景文件过大，请选择不超过 500 MB 的文件。'), { localizationKey: '背景文件过大，请选择不超过 500 MB 的文件。' })]) {
    const env = await harness(t, { downloadError: failure });
    await assert.rejects(resolveYouTubeLink(LINK, 'video', env.dependencies), value => {
      assert.ok(value.localizationKey); assert.doesNotMatch(value.message, /private-token/); return true;
    });
  }
});

test('native YouTube download revalidates the chosen track and reads only numeric progress', async t => {
  const env = await harness(t, { nativeStdout: ['server text private-token\nFROSTED_BY', 'TES=8\nFROSTED_BYTES=16\nFROSTED_BYTES=NaN\n'] });
  const result = await resolveYouTubeLink(LINK, 'video', { ...env.dependencies, download: undefined });
  assert.deepEqual(await fs.readFile(result), WEBM);
  assert.deepEqual(env.calls.progress, [8, 16]);
  assert.equal(env.calls.download.length, 0);
  assert.equal(env.calls.spawn.length, 2);
  const command = env.calls.spawn[1];
  assert.equal(command.file, env.tools.extractor);
  assert.equal(command.options.shell, false); assert.equal(command.options.windowsHide, true);
  assert.equal(command.args[command.args.indexOf('--format') + 1], '247[protocol=https][ext=webm][vcodec^=vp9][acodec=none][height<=720]');
  assert.equal(command.args[command.args.indexOf('--downloader') + 1], 'native');
  assert.equal(command.args[command.args.indexOf('--fixup') + 1], 'never');
  assert.equal(command.args[command.args.indexOf('--max-filesize') + 1], String(500 * 1024 * 1024));
  assert.equal(command.args[command.args.indexOf('--progress-delta') + 1], '1');
  const filters = command.args.flatMap((value, index) => value === '--match-filter' ? [command.args[index + 1]] : []);
  assert.deepEqual(filters, ['live_status = not_live & !is_live & !is_upcoming & !has_drm', 'live_status = was_live & !is_live & !is_upcoming & !has_drm']);
  const output = command.args[command.args.indexOf('--output') + 1];
  assert.equal(path.dirname(path.dirname(output)), env.directory);
  assert.equal(path.basename(output), 'video.webm');
  assert.deepEqual(command.args.slice(-2), ['--', 'https://www.youtube.com/watch?v=' + ID]);
  assert.ok(command.args.every(value => !value.includes('private-token')), 'signed URL is not persisted in argv');
  assert.deepEqual(await fs.readdir(env.directory), [path.basename(result)], 'temporary request directory is removed');
});

test('native download failures, missing output and unsafe progress clean up the request directory', async t => {
  for (const options of [{ nativeCode: 1, nativeStderr: ['sensitive private-token'] }, { nativeNoFile: true }, { nativeBytes: Buffer.from('invalid media') }, { nativeStdout: ['FROSTED_BYTES=524288001\n'] }, { nativeStdout: ['x'.repeat(4097)] }, { nativeStderr: [Buffer.alloc(20481)] }]) {
    const env = await harness(t, options);
    await fs.writeFile(path.join(env.directory, 'old.webm'), WEBM);
    await assert.rejects(resolveYouTubeLink(LINK, 'video', { ...env.dependencies, download: undefined }), failure => {
      assert.ok(failure.localizationKey); assert.doesNotMatch(failure.message, /private-token/); return true;
    });
    assert.deepEqual(await fs.readdir(env.directory), ['old.webm']);
  }
});

test('native download cancellation waits for process-tree termination and removes partial media', async t => {
  const abort = new AbortController(), env = await harness(t, { nativeHold: true });
  await fs.writeFile(path.join(env.directory, 'old.webm'), WEBM);
  const promise = resolveYouTubeLink(LINK, 'video', { ...env.dependencies, download: undefined, signal: abort.signal });
  const rejected = assert.rejects(promise, /取消/);
  await env.nativeSpawned;
  abort.abort(); await rejected;
  if (process.platform === 'win32') assert.deepEqual(env.calls.spawn[2].args, ['/PID', '41234', '/T', '/F']);
  else assert.equal(env.calls.kills, 1);
  assert.deepEqual(await fs.readdir(env.directory), ['old.webm']);
});

test('native download deadline is five minutes and independent from metadata timeout', async t => {
  const env = await harness(t, { nativeHold: true });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const promise = resolveYouTubeLink(LINK, 'video', { ...env.dependencies, download: undefined });
  const rejected = assert.rejects(promise, /下载超时/);
  await env.nativeSpawned;
  t.mock.timers.tick(5 * 60 * 1000);
  await rejected;
  assert.deepEqual(await fs.readdir(env.directory), []);
});

test('native download checks actual disk size even if progress does not report it', async t => {
  const env = await harness(t, { nativeHold: true });
  const lstat = fs.lstat;
  t.mock.method(fs, 'lstat', async (...args) => {
    const stat = await lstat(...args);
    if (path.basename(String(args[0])) !== 'video.webm') return stat;
    return Object.assign(Object.create(stat), { size: 500 * 1024 * 1024 + 1 });
  });
  await assert.rejects(resolveYouTubeLink(LINK, 'video', { ...env.dependencies, download: undefined }), /500 MB/);
  assert.deepEqual(await fs.readdir(env.directory), []);
});
