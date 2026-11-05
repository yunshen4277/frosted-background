'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const inflate = promisify(zlib.inflateRaw);

const PINS = Object.freeze({
  extractor: Object.freeze({ version: '2026.10.26', size: 23575744,
    url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe',
    sha256: 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d' }),
  runtime: Object.freeze({ version: '2.9.8', size: 42917472, binarySize: 98081568,
    binarySha256: '924397800533d3eb0ed0c889b20ad70e18b970d93acd8135bc043f425e528266',
    url: 'https://github.com/denoland/deno/releases/download/v2.9.8/deno-x86_64-pc-windows-msvc.zip',
    sha256: 'cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf' }),
});
const MAX_RUNTIME_BYTES = 150 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const error = key => Object.assign(new Error(key), { localizationKey: key });
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const checkAbort = signal => { if (signal?.aborted) throw error('已取消 YouTube 工具准备。'); };

function header(headers, key) {
  const found = Object.keys(headers || {}).find(name => name.toLowerCase() === key);
  const value = found && headers[found];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function downloadURL(value, initial) {
  let url;
  try { url = new URL(value); } catch { throw error('已拒绝不受信任的工具下载地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port ||
      (url.href !== initial && (url.hostname !== 'release-assets.githubusercontent.com' || !/^\/github-production-release-asset\/[A-Za-z0-9/_-]+$/.test(url.pathname)))) {
    throw error('已拒绝不受信任的工具下载地址。');
  }
  return url;
}

// One bounded HTTPS response. The caller validates every redirect and all
// downloaded bytes; injected transports cannot bypass those checks.
function requestBuffer(url, { maxBytes, signal, onProgress }) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let settled = false, timer, response;
    let total = 0;
    const chunks = [];
    const finish = (failure, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (failure) { response?.destroy(); reject(failure); } else resolve(result);
    };
    const request = https.get(url, { signal, agent: false, headers: {
      'User-Agent': 'FrostedBackground-YouTube-Tools', Accept: 'application/octet-stream', 'Accept-Encoding': 'identity'
    } }, incoming => {
      response = incoming;
      if (Number(header(incoming.headers, 'content-length')) > maxBytes) { request.destroy(error('YouTube 工具下载大小无效。')); return; }
      incoming.on('data', chunk => {
        total += chunk.length;
        if (total > maxBytes) { request.destroy(error('YouTube 工具下载大小无效。')); return; }
        chunks.push(chunk);
        if (incoming.statusCode === 200) {
          try { onProgress?.(total); } catch (failure) { request.destroy(failure); }
        }
      });
      incoming.on('error', failure => finish(failure));
      incoming.on('aborted', () => finish(error('YouTube 工具下载未完成，请重试。')));
      incoming.on('end', () => finish(null, { statusCode: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', failure => finish(failure));
    request.setTimeout(20000, () => request.destroy(error('YouTube 工具下载超时，请重试。')));
    timer = setTimeout(() => request.destroy(error('YouTube 工具下载超时，请重试。')), 180000);
    timer.unref?.();
  });
}

async function fetchPinned(pin, { request, signal, onProgress }) {
  let url = pin.url;
  for (let hop = 0; hop <= 4; hop++) {
    checkAbort(signal);
    url = downloadURL(url, pin.url).href;
    const response = await request(url, { maxBytes: pin.size, signal, onProgress });
    checkAbort(signal);
    if (!response || !Number.isInteger(response.statusCode) || !Buffer.isBuffer(response.body)) throw error('YouTube 工具下载响应无效。');
    if (response.body.length > pin.size || Number(header(response.headers, 'content-length')) > pin.size) throw error('YouTube 工具下载大小无效。');
    const encoding = header(response.headers, 'content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') throw error('YouTube 工具下载响应无效。');
    if (REDIRECTS.has(response.statusCode)) {
      const location = header(response.headers, 'location');
      if (!location || hop === 4) throw error('YouTube 工具下载重定向无效。');
      try { url = new URL(location, url).href; } catch { throw error('YouTube 工具下载重定向无效。'); }
      continue;
    }
    if (response.statusCode !== 200) throw error('无法下载 YouTube 工具，请检查网络或稍后重试。');
    if (response.body.length !== pin.size) throw error('YouTube 工具下载大小无效。');
    if (digest(response.body) !== pin.sha256) throw error('YouTube 工具校验失败，未使用下载文件。');
    return response.body;
  }
  throw error('YouTube 工具下载重定向无效。');
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  return value >>> 0;
});
async function crc32(bytes, signal) {
  let crc = 0xffffffff;
  for (let start = 0; start < bytes.length; start += 1024 * 1024) {
    checkAbort(signal);
    for (let i = start, end = Math.min(bytes.length, start + 1024 * 1024); i < end; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    if (start + 1024 * 1024 < bytes.length) await new Promise(resolve => setImmediate(resolve));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// No extraction paths are used. Accept only the one ordinary deno.exe entry,
// reject ZIP64/multi-disk/encrypted or ambiguous archives, and bound inflation.
async function unpackDeno(bytes, expectedSize, signal) {
  const invalid = () => { throw error('Deno 工具压缩包无效，未使用下载文件。'); };
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || expectedSize <= 0 || expectedSize > MAX_RUNTIME_BYTES) return invalid();
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) { end = index; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== 1 || bytes.readUInt16LE(end + 10) !== 1) return invalid();
  const length = bytes.readUInt32LE(end + 12), central = bytes.readUInt32LE(end + 16);
  if (central + length !== end || length < 46 || central + 46 > end || bytes.readUInt32LE(central) !== 0x02014b50) return invalid();
  const flags = bytes.readUInt16LE(central + 8), method = bytes.readUInt16LE(central + 10);
  const checksum = bytes.readUInt32LE(central + 16), compressedSize = bytes.readUInt32LE(central + 20), size = bytes.readUInt32LE(central + 24);
  const nameLength = bytes.readUInt16LE(central + 28), extra = bytes.readUInt16LE(central + 30), comment = bytes.readUInt16LE(central + 32);
  const attributes = bytes.readUInt32LE(central + 38), mode = attributes >>> 16;
  if (central + 46 + nameLength + extra + comment !== end || size !== expectedSize || compressedSize > MAX_DOWNLOAD_BYTES ||
      (flags & ~0x080e) || ![0, 8].includes(method) || bytes.readUInt16LE(central + 34) || bytes.readUInt32LE(central + 42) !== 0 ||
      ((mode & 0xf000) && (mode & 0xf000) !== 0x8000) || (attributes & 0x10) ||
      !bytes.subarray(central + 46, central + 46 + nameLength).equals(Buffer.from('deno.exe'))) return invalid();
  if (central < 30 || bytes.readUInt32LE(0) !== 0x04034b50 || bytes.readUInt16LE(6) !== flags || bytes.readUInt16LE(8) !== method) return invalid();
  const localNameLength = bytes.readUInt16LE(26), dataStart = 30 + localNameLength + bytes.readUInt16LE(28);
  const dataEnd = dataStart + compressedSize;
  if (dataStart > central || dataEnd > central || !bytes.subarray(30, 30 + localNameLength).equals(Buffer.from('deno.exe'))) return invalid();
  if (!(flags & 8)) {
    if (dataEnd !== central || bytes.readUInt32LE(14) !== checksum || bytes.readUInt32LE(18) !== compressedSize || bytes.readUInt32LE(22) !== size) return invalid();
  } else {
    const descriptorSize = central - dataEnd;
    if (![12, 16].includes(descriptorSize)) return invalid();
    const descriptor = dataEnd + (descriptorSize === 16 ? 4 : 0);
    if ((descriptorSize === 16 && bytes.readUInt32LE(dataEnd) !== 0x08074b50) || bytes.readUInt32LE(descriptor) !== checksum || bytes.readUInt32LE(descriptor + 4) !== compressedSize || bytes.readUInt32LE(descriptor + 8) !== size) return invalid();
  }
  checkAbort(signal);
  let binary;
  try { binary = method === 0 ? bytes.subarray(dataStart, dataEnd) : await inflate(bytes.subarray(dataStart, dataEnd), { maxOutputLength: expectedSize }); }
  catch { return invalid(); }
  checkAbort(signal);
  if (binary.length !== size || binary[0] !== 0x4d || binary[1] !== 0x5a || await crc32(binary, signal) !== checksum) return invalid();
  return binary;
}

async function safeDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw error('YouTube 工具缓存目录无效。');
}

async function regularFile(filename) {
  let info;
  try { info = await fs.lstat(filename); } catch (failure) { if (failure.code === 'ENOENT') return; throw failure; }
  if (!info.isFile() || info.isSymbolicLink()) throw error('YouTube 工具缓存文件无效。');
  return info;
}

async function verifiedCache(filename, size, expected, signal) {
  const info = await regularFile(filename);
  if (!info || info.size !== size) return false;
  const handle = await fs.open(filename, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== size) throw error('YouTube 工具缓存文件无效。');
    const hash = crypto.createHash('sha256'), chunk = Buffer.alloc(1024 * 1024);
    let total = 0;
    while (total <= size) {
      checkAbort(signal);
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - total + 1), total);
      if (!bytesRead) break;
      total += bytesRead; hash.update(chunk.subarray(0, bytesRead));
    }
    return total === size && hash.digest('hex') === expected;
  } finally { await handle.close(); }
}

async function publish(filename, bytes, signal) {
  await regularFile(filename);
  const temporary = path.join(path.dirname(filename), '.youtube-tools-' + crypto.randomUUID() + '.part');
  try {
    checkAbort(signal);
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    checkAbort(signal);
    await regularFile(filename);
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(failure => { if (failure.code !== 'ENOENT') throw failure; }); }
}

function createYouTubeTools({ request = requestBuffer, pins = PINS } = {}) {
  for (const pin of [pins.extractor, pins.runtime]) {
    if (!pin || !/^[0-9.]+$/.test(pin.version) || !Number.isSafeInteger(pin.size) || pin.size <= 0 || pin.size > MAX_DOWNLOAD_BYTES || !/^[a-f0-9]{64}$/.test(pin.sha256) ||
        !/^https:\/\/github\.com\/(?:yt-dlp\/yt-dlp|denoland\/deno)\/releases\/download\/[A-Za-z0-9.\/_-]+$/.test(pin.url)) throw new Error('Invalid pinned helper metadata.');
  }
  if (!Number.isSafeInteger(pins.runtime.binarySize) || pins.runtime.binarySize <= 0 || pins.runtime.binarySize > MAX_RUNTIME_BYTES || !/^[a-f0-9]{64}$/.test(pins.runtime.binarySha256)) throw new Error('Invalid pinned runtime metadata.');
  return async function ensureYouTubeTools({ directory, signal, onProgress, platform = process.platform, arch = process.arch } = {}) {
    if (platform !== 'win32' || arch !== 'x64') throw error('YouTube 背景目前仅支持 Windows x64。');
    if (!path.isAbsolute(directory || '')) throw error('YouTube 工具缓存目录无效。');
    checkAbort(signal);
    try {
      await safeDirectory(directory);
      const extractorDirectory = path.join(directory, 'yt-dlp-' + pins.extractor.version);
      const runtimeDirectory = path.join(directory, 'deno-' + pins.runtime.version);
      await safeDirectory(extractorDirectory); await safeDirectory(runtimeDirectory);
      const extractor = path.join(extractorDirectory, 'yt-dlp.exe');
      const runtime = path.join(runtimeDirectory, 'deno.exe');
      const total = pins.extractor.size + pins.runtime.size;
      onProgress?.(0, total);
      if (!await verifiedCache(extractor, pins.extractor.size, pins.extractor.sha256, signal)) {
        const bytes = await fetchPinned(pins.extractor, { request, signal, onProgress: value => onProgress?.(Math.min(value, pins.extractor.size), total) });
        if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw error('YouTube 工具校验失败，未使用下载文件。');
        await publish(extractor, bytes, signal);
      }
      onProgress?.(pins.extractor.size, total);
      if (!await verifiedCache(runtime, pins.runtime.binarySize, pins.runtime.binarySha256, signal)) {
        const bytes = await fetchPinned(pins.runtime, { request, signal, onProgress: value => onProgress?.(pins.extractor.size + Math.min(value, pins.runtime.size), total) });
        const binary = await unpackDeno(bytes, pins.runtime.binarySize, signal);
        if (digest(binary) !== pins.runtime.binarySha256) throw error('YouTube 工具校验失败，未使用下载文件。');
        await publish(runtime, binary, signal);
      }
      checkAbort(signal);
      onProgress?.(total, total);
      return { extractor, runtime };
    } catch (failure) {
      if (signal?.aborted || failure.name === 'AbortError') throw error('已取消 YouTube 工具准备。');
      if (failure.localizationKey) throw failure;
      // Do not log signed release-asset redirects or transport error details.
      throw error('无法准备 YouTube 工具，请检查网络或缓存目录权限。');
    }
  };
}

const ensureYouTubeTools = createYouTubeTools();
module.exports = { ensureYouTubeTools, createYouTubeTools, unpackDeno, PINS };
