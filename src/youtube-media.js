'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { classifyLink, mediaURL } = require('../media/source');
const { detectMedia, MAX_BYTES } = require('./remote-media');
const { ensureYouTubeTools } = require('./youtube-tools');

const MAX_METADATA_BYTES = 10 * 1024 * 1024;
const MAX_ERROR_BYTES = 20 * 1024;
const METADATA_TIMEOUT = 90000;
const error = message => Object.assign(new Error(message), { localizationKey: message });
const cancelled = () => error('已取消 YouTube 视频加载。');

function videoIdentity(value, hint) {
  if (!['auto', 'video'].includes(hint)) throw error('YouTube 链接只能用于视频背景。');
  let source, input;
  try { input = mediaURL(value); source = classifyLink(value, hint); }
  catch { throw error('请输入单个 YouTube 视频链接。'); }
  if (source.type !== 'platform' || source.platform !== 'YouTube') throw error('请输入单个 YouTube 视频链接。');
  if (/^\/live(?:\/|$)/.test(input.pathname) || /\/live\/?$/.test(input.pathname)) throw error('暂不支持将 YouTube 直播或尚未处理完成的视频设为背景。');
  const canonical = new URL(source.url), id = canonical.searchParams.get('v');
  if (canonical.pathname !== '/watch' || !/^[A-Za-z0-9_-]{11}$/.test(id || '')) throw error('请输入单个 YouTube 视频链接。');
  // Tracking, playlist, and playback-position parameters never reach the tool.
  return { id, url: 'https://www.youtube.com/watch?v=' + id };
}

function helperEnvironment() {
  const env = { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', DENO_NO_UPDATE_CHECK: '1' };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function terminate(child, spawn) {
  return new Promise(resolve => {
    let timer;
    const done = () => { clearTimeout(timer); resolve(); };
    timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* Already closed. */ } done(); }, 3000); timer.unref?.();
    child.once('close', done);
    const fallback = () => { try { child.kill(); } catch { done(); } };
    if (process.platform === 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
      try {
        const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore', env: helperEnvironment() });
        killer.once('error', fallback);
        killer.once('close', code => { if (code) fallback(); else done(); });
        killer.unref?.();
        return;
      } catch { /* Fall back to terminating the owned process. */ }
    }
    fallback();
  });
}

const isolatedArguments = tools => [
  '--ignore-config', '--no-plugin-dirs', '--no-cookies', '--no-cookies-from-browser', '--no-cache-dir', '--no-playlist', '--no-exec',
  '--no-js-runtimes', '--js-runtimes', 'deno:' + tools.runtime, '--no-remote-components',
  '--socket-timeout', '20', '--retries', '1', '--extractor-retries', '1', '--no-warnings', '--no-colors',
];

function readMetadata(url, tools, directory, signal, spawn) {
  if (signal?.aborted) return Promise.reject(cancelled());
  if (!path.isAbsolute(tools?.extractor || '') || !path.isAbsolute(tools?.runtime || '')) return Promise.reject(error('YouTube 视频工具不可用，请重试。'));
  const args = [...isolatedArguments(tools), '--skip-download', '--dump-single-json', '--', url];
  return new Promise((resolve, reject) => {
    let child, timer, done = false, stopping = false, size = 0, errorBytes = 0;
    const chunks = [];
    const finish = (failure, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      chunks.length = 0;
      if (failure) reject(failure); else resolve(result);
    };
    const stop = failure => {
      if (done || stopping) return;
      stopping = true; clearTimeout(timer);
      terminate(child, spawn).then(() => finish(failure));
    };
    const abort = () => stop(cancelled());
    try {
      child = spawn(tools.extractor, args, { shell: false, windowsHide: true, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: helperEnvironment() });
    } catch { finish(error('无法解析 YouTube 视频，请检查链接、网络或站点访问限制。')); return; }
    child.on('error', () => finish(error('无法解析 YouTube 视频，请检查链接、网络或站点访问限制。')));
    child.stdout.on('error', () => stop(error('YouTube 视频信息无效或超过大小限制。')));
    child.stderr.on('error', () => stop(error('无法解析 YouTube 视频，请检查链接、网络或站点访问限制。')));
    child.stdout.on('data', value => {
      if (done || stopping) return;
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += bytes.length;
      if (size > MAX_METADATA_BYTES) { stop(error('YouTube 视频信息无效或超过大小限制。')); return; }
      chunks.push(bytes);
    });
    // Drain but never expose helper stderr: it can contain signed media URLs,
    // local paths or server response details. Excessive output is terminated.
    child.stderr.on('data', value => {
      if (done || stopping) return;
      errorBytes += Buffer.byteLength(value);
      if (errorBytes > MAX_ERROR_BYTES) stop(error('YouTube 视频信息无效或超过大小限制。'));
    });
    child.once('close', code => {
      if (done || stopping) return;
      if (signal?.aborted) { finish(cancelled()); return; }
      if (code !== 0) { finish(error('无法解析 YouTube 视频，请检查链接、网络或站点访问限制。')); return; }
      try {
        const metadata = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
        finish(null, metadata);
      } catch { finish(error('YouTube 视频信息无效或超过大小限制。')); }
    });
    timer = setTimeout(() => stop(error('YouTube 视频解析超时，请稍后重试。')), METADATA_TIMEOUT);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function selectFormat(metadata, id) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.id !== id || (metadata._type !== undefined && metadata._type !== 'video')) throw error('YouTube 视频信息无效或超过大小限制。');
  if (metadata.is_live === true || metadata.is_upcoming === true || (metadata.live_status !== undefined && !['not_live', 'was_live'].includes(metadata.live_status))) throw error('暂不支持将 YouTube 直播或尚未处理完成的视频设为背景。');
  // yt-dlp can leave availability null when it could not classify access.
  // Unknown is not an authentication denial: explicit restrictions still fail,
  // and the following download uses no credentials or restriction overrides.
  if (metadata.has_drm === true || metadata.drm_family || metadata.is_private === true || metadata.needs_auth === true || (metadata.availability != null && !['public', 'unlisted'].includes(metadata.availability))) throw error('此 YouTube 视频需要登录、访问权限或 DRM，不支持导入。');
  const formats = Array.isArray(metadata.formats) ? metadata.formats : [];
  const candidates = [];
  for (const format of formats) {
    if (!format || typeof format !== 'object' || !/^[A-Za-z\d._-]{1,64}$/.test(format.format_id || '') || format.has_drm === true || format.drm_family || format.protocol !== 'https' || format.acodec !== 'none' ||
        (format.fragments !== undefined && (!Array.isArray(format.fragments) || format.fragments.length)) ||
        !Number.isFinite(format.height) || format.height <= 0 || format.height > 720 ||
        !Number.isFinite(format.width) || format.width <= 0) continue;
    const codec = String(format.vcodec || '').toLowerCase();
    const webm = format.ext === 'webm' && /^(?:vp8|vp9|vp08|vp09)(?:\.|$)/.test(codec);
    const mp4 = format.ext === 'mp4' && /^(?:avc1|h264)(?:\.|$)/.test(codec);
    if (!webm && !mp4) continue;
    if (['filesize', 'filesize_approx'].some(key => format[key] !== undefined && format[key] !== null && (!Number.isFinite(format[key]) || format[key] <= 0 || format[key] > MAX_BYTES))) continue;
    let url;
    try { url = mediaURL(format.url); } catch { continue; }
    if (!url.hostname.endsWith('.googlevideo.com') || (url.port && url.port !== '443')) continue;
    candidates.push({ url: url.href, extension: '.' + format.ext, id: format.format_id, codec: codec.split('.')[0], rank: webm ? 0 : 1, height: format.height, fps: Number.isFinite(format.fps) ? format.fps : 0, bitrate: Number.isFinite(format.tbr) ? format.tbr : 0 });
  }
  candidates.sort((a, b) => a.rank - b.rank || b.height - a.height || b.fps - a.fps || b.bitrate - a.bitrate);
  if (!candidates.length) throw error('未找到不高于 720p 且不超过 500 MB 的兼容 YouTube 视频格式。');
  return candidates[0];
}

async function downloadVideo(url, selected, tools, cache, signal, spawn, onProgress) {
  const directory = await fs.mkdtemp(path.join(cache, 'youtube-request-'));
  const output = path.join(directory, 'video' + selected.extension);
  try {
    if (signal?.aborted) throw cancelled();
    await new Promise((resolve, reject) => {
      let child, done = false, stopping = false, checking = false, timeout, monitor, stdoutBytes = 0, stderrBytes = 0, pendingLine = '';
      const clear = () => { clearTimeout(timeout); clearInterval(monitor); signal?.removeEventListener('abort', abort); };
      const finish = failure => { if (done) return; done = true; clear(); if (failure) reject(failure); else resolve(); };
      const stop = failure => {
        if (done || stopping) return;
        stopping = true; clear();
        terminate(child, spawn).then(() => finish(failure));
      };
      const abort = () => stop(cancelled());
      const inspect = async () => {
        let total = 0;
        for (const entry of await fs.readdir(directory)) {
          const stat = await fs.lstat(path.join(directory, entry));
          if (!stat.isFile() || stat.isSymbolicLink()) throw error('YouTube 视频下载结果无效。');
          total += stat.size;
          if (total > MAX_BYTES) throw error('背景文件过大，请选择不超过 500 MB 的文件。');
        }
      };
      // Re-extract the canonical URL instead of persisting signed URLs. The
      // filter revalidates the chosen track's basic properties on that pass.
      const filter = `${selected.id}[protocol=https][ext=${selected.extension.slice(1)}][vcodec^=${selected.codec}][acodec=none][height<=720]`;
      const args = [...isolatedArguments(tools), '--format', filter,
        '--match-filter', 'live_status = not_live & !is_live & !is_upcoming & !has_drm',
        '--match-filter', 'live_status = was_live & !is_live & !is_upcoming & !has_drm',
        '--downloader', 'native', '--fixup', 'never', '--no-continue', '--no-overwrites', '--no-mtime',
        '--no-write-info-json', '--no-write-thumbnail', '--max-filesize', String(MAX_BYTES),
        '--quiet', '--newline', '--progress', '--progress-delta', '1', '--progress-template', 'download:FROSTED_BYTES=%(progress.downloaded_bytes)s',
        '--output', output, '--', url];
      try { child = spawn(tools.extractor, args, { shell: false, windowsHide: true, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: helperEnvironment() }); }
      catch { finish(error('无法下载 YouTube 视频，请检查网络或站点访问限制。')); return; }
      child.on('error', () => finish(error('无法下载 YouTube 视频，请检查网络或站点访问限制。')));
      child.stdout.on('error', () => stop(error('无法下载 YouTube 视频，请检查网络或站点访问限制。')));
      child.stderr.on('error', () => stop(error('无法下载 YouTube 视频，请检查网络或站点访问限制。')));
      child.stdout.on('data', value => {
        if (done || stopping) return;
        stdoutBytes += Buffer.byteLength(value);
        if (stdoutBytes > 1024 * 1024) { stop(error('YouTube 视频下载结果无效。')); return; }
        pendingLine += value.toString();
        const lines = pendingLine.split(/\r?\n/); pendingLine = lines.pop();
        if (pendingLine.length > 4096) { stop(error('YouTube 视频下载结果无效。')); return; }
        for (const line of lines) {
          const match = /^FROSTED_BYTES=(\d{1,16})$/.exec(line);
          if (!match) continue;
          const bytes = Number(match[1]);
          if (!Number.isSafeInteger(bytes) || bytes > MAX_BYTES) { stop(error('背景文件过大，请选择不超过 500 MB 的文件。')); return; }
          try { onProgress?.(bytes); } catch { /* Progress UI does not control the process lifetime. */ }
        }
      });
      child.stderr.on('data', value => {
        if (done || stopping) return;
        stderrBytes += Buffer.byteLength(value);
        if (stderrBytes > MAX_ERROR_BYTES) stop(error('YouTube 视频下载结果无效。'));
      });
      child.once('close', async code => {
        if (done || stopping) return;
        if (signal?.aborted) { finish(cancelled()); return; }
        if (code !== 0) { finish(error('无法下载 YouTube 视频，请检查网络或站点访问限制。')); return; }
        try {
          await inspect();
          const file = await fs.lstat(output);
          if (!file.isFile() || file.isSymbolicLink() || !file.size) throw error('YouTube 视频下载结果无效。');
          finish();
        } catch (failure) { finish(failure.localizationKey ? failure : error('YouTube 视频下载结果无效。')); }
      });
      timeout = setTimeout(() => stop(error('YouTube 视频下载超时，请稍后重试。')), 5 * 60 * 1000);
      monitor = setInterval(async () => {
        if (done || stopping || checking) return;
        checking = true;
        try { await inspect(); }
        catch (failure) { if (failure.code !== 'ENOENT') stop(failure.localizationKey ? failure : error('YouTube 视频下载结果无效。')); }
        finally { checking = false; }
      }, 250);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    if (signal?.aborted) throw cancelled();
    const filename = path.join(cache, 'youtube-download-' + randomUUID() + selected.extension);
    await fs.rename(output, filename);
    return filename;
  } finally {
    // mkdtemp created this exact private subdirectory beneath the validated
    // cache. Never recursively remove a path derived from helper output.
    const ownedDirectory = path.resolve(directory);
    if (path.dirname(ownedDirectory) === cache && /^youtube-request-[A-Za-z\d]+$/.test(path.basename(ownedDirectory))) {
      await fs.rm(ownedDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    }
  }
}

async function resolveYouTubeLink(url, hint = 'auto', { directory, signal, onProgress, onStage, ensureTools = ensureYouTubeTools, spawn = childProcess.spawn, download } = {}) {
  if (signal?.aborted) throw cancelled();
  const identity = videoIdentity(url, hint);
  if (!path.isAbsolute(directory || '')) throw error('无法创建 YouTube 视频缓存。');
  const cache = path.resolve(directory);
  let downloaded;
  try {
    await fs.mkdir(cache, { recursive: true });
    const root = await fs.lstat(cache);
    if (!root.isDirectory() || root.isSymbolicLink()) throw error('无法创建 YouTube 视频缓存。');
    onStage?.('prepare');
    const tools = await ensureTools({ directory: path.join(cache, 'tools'), signal, onProgress });
    if (signal?.aborted) throw cancelled();
    onStage?.('resolve');
    const metadata = await readMetadata(identity.url, tools, cache, signal, spawn);
    if (signal?.aborted) throw cancelled();
    const selected = selectFormat(metadata, identity.id);
    onStage?.('download');
    const result = download
      ? await download(selected.url, 'video', { directory: cache, signal, onProgress })
      : await downloadVideo(identity.url, selected, tools, cache, signal, spawn, onProgress);
    // Only a newly returned ordinary file in this cache can be renamed/removed.
    if (typeof result !== 'string' || !path.isAbsolute(result) || path.dirname(path.resolve(result)) !== cache) throw error('YouTube 视频下载结果无效。');
    downloaded = path.resolve(result);
    if (signal?.aborted) throw cancelled();
    const stat = await fs.lstat(downloaded);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > MAX_BYTES || path.extname(downloaded).toLowerCase() !== selected.extension) throw error('YouTube 视频下载结果无效。');
    const file = await fs.open(downloaded, 'r');
    let media;
    try { const prefix = Buffer.alloc(Math.min(stat.size, 4096)); await file.read(prefix, 0, prefix.length, 0); media = detectMedia(prefix); }
    finally { await file.close(); }
    if (media?.kind !== 'video' || media.extension !== selected.extension) throw error('YouTube 视频下载结果无效。');
    if (signal?.aborted) throw cancelled();
    const filename = path.join(cache, `YouTube-${identity.id}-${randomUUID()}${selected.extension}`);
    await fs.rename(downloaded, filename);
    downloaded = undefined;
    return filename;
  } catch (failure) {
    if (signal?.aborted || failure.name === 'AbortError') throw cancelled();
    if (failure.localizationKey) throw failure;
    throw error('无法加载 YouTube 视频，请检查网络或稍后重试。');
  } finally {
    if (downloaded) await fs.unlink(downloaded).catch(() => {});
  }
}

module.exports = { resolveYouTubeLink };
