'use strict';

const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { mediaURL, publicHost, classifyLink, normalizeRemoteSource } = require('../media/source');
const MAX_BYTES = 500 * 1024 * 1024;
const error = message => Object.assign(new Error(message), { localizationKey: message });

function publicAddress(address) {
  if (net.isIP(address) === 4) return publicHost(address);
  // Global-unicast IPv6 only; mapped IPv4, loopback, link-local and ULA are excluded.
  return net.isIP(address) === 6 && /^[23][a-f\d]{0,3}:/i.test(address) && !/^2001:(?:db8|0):/i.test(address);
}
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (failure, addresses) => {
    if (failure || !addresses?.length || addresses.some(item => !publicAddress(item.address))) {
      callback(error('链接不能指向本机或内网地址。')); return;
    }
    if (options?.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}
function get(url, { request = https.request, signal }) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', agent: false, lookup: safeLookup, signal,
      headers: { 'User-Agent': 'FrostedBackground/0.10', Accept: 'image/*,video/mp4,video/webm,application/vnd.apple.mpegurl,application/x-mpegURL;q=0.9,*/*;q=0.1' } }, resolve);
    req.once('error', reject);
    req.setTimeout(20000, () => req.destroy(error('链接连接超时，请稍后重试。')));
    req.end();
  });
}
function detectMedia(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { kind: 'image', extension: '.png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { kind: 'image', extension: '.jpg' };
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return { kind: 'image', extension: '.gif' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { kind: 'image', extension: '.webp' };
  if (bytes.toString('ascii', 0, 2) === 'BM') return { kind: 'image', extension: '.bmp' };
  if (bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brands = bytes.toString('ascii', 8, 128);
    return /avif|avis/.test(brands) ? { kind: 'image', extension: '.avif' } : { kind: 'video', extension: '.mp4' };
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) && bytes.subarray(0, 4096).includes(Buffer.from('webm'))) return { kind: 'video', extension: '.webm' };
  return null;
}

async function resolveMediaLink(value, hint, { directory, signal, request, onProgress, maxBytes = MAX_BYTES } = {}) {
  if (signal?.aborted) throw error('已取消链接加载或加载超时。');
  const source = classifyLink(value, hint);
  if (source.type === 'platform') return source;
  if (source.type === 'hls') return normalizeRemoteSource(source);
  if (!path.isAbsolute(directory || '')) throw error('无法创建外链媒体缓存。');
  await fs.mkdir(directory, { recursive: true });
  const root = await fs.lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw error('无法创建外链媒体缓存。');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 5 * 60 * 1000);
  let temporary, handle, response;
  try {
    let url = mediaURL(source.url);
    for (let redirects = 0; ; redirects++) {
      response = await get(url, { request, signal: controller.signal });
      if (![301, 302, 303, 307, 308].includes(response.statusCode)) break;
      const target = response.headers.location;
      response.destroy();
      if (!target || redirects >= 5) throw error('链接重定向过多或无效。');
      url = mediaURL(new URL(target, url).href);
      if (classifyLink(url.href).type === 'platform') throw error('该链接指向网页，请使用图片或视频文件直链。');
    }
    if (response.statusCode !== 200) throw error('无法下载媒体，请检查链接是否有效或需要登录。');
    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'].includes(contentType)) {
      response.destroy();
      if (hint === 'image') throw error('链接内容与选择的媒体类型不匹配。');
      return normalizeRemoteSource({ type: 'hls', kind: 'video', url: url.href });
    }
    if (/^(?:text\/|application\/(?:json|xhtml\+xml))/.test(contentType) || contentType === 'image/svg+xml') throw error('该链接指向网页，请使用图片或视频文件直链。');
    if (Number(response.headers['content-length']) > maxBytes) throw error('背景文件过大，请选择不超过 500 MB 的文件。');
    temporary = path.join(directory, 'download-' + crypto.randomUUID() + '.part');
    handle = await fs.open(temporary, 'wx', 0o600);
    let size = 0, prefix = Buffer.alloc(0), reported = 0;
    for await (const chunk of response) {
      if (controller.signal.aborted) throw error('已取消链接加载或加载超时。');
      size += chunk.length;
      if (size > maxBytes) throw error('背景文件过大，请选择不超过 500 MB 的文件。');
      if (prefix.length < 4096) prefix = Buffer.concat([prefix, chunk.subarray(0, 4096 - prefix.length)]);
      await handle.writeFile(chunk);
      if (size - reported >= 1024 * 1024) { reported = size; onProgress?.(size); }
    }
    if (controller.signal.aborted) throw error('已取消链接加载或加载超时。');
    const media = detectMedia(prefix);
    if (!size || !media) throw error('不支持此媒体内容，请使用 PNG、JPEG、WebP、GIF、BMP、AVIF、MP4 或 WebM。');
    if (hint !== 'auto' && hint !== media.kind) throw error('链接内容与选择的媒体类型不匹配。');
    await handle.close(); handle = undefined;
    const filename = path.join(directory, url.hostname.slice(0, 60) + '-' + crypto.randomUUID() + media.extension);
    await fs.rename(temporary, filename); temporary = undefined;
    return filename;
  } catch (failure) {
    if (failure.localizationKey) throw failure;
    if (controller.signal.aborted || failure.name === 'AbortError') throw error('已取消链接加载或加载超时。');
    // Do not surface signed URLs, query tokens or response bodies in logs/UI.
    throw error('无法下载媒体，请检查网络、链接或站点访问限制。');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    response?.destroy();
    await handle?.close().catch(() => {});
    if (temporary) await fs.unlink(temporary).catch(() => {});
  }
}
module.exports = { resolveMediaLink, detectMedia, publicAddress, safeLookup, MAX_BYTES };
