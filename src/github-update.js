'use strict';

// GitHub's repository is the trust boundary. The manifest's SHA-256 detects
// corruption; it is not a signature independent of the release publisher.
const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const LIMITS = Object.freeze({ release: 1024 * 1024, manifest: 64 * 1024, vsix: 30 * 1024 * 1024, package: 256 * 1024 });
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const EXTENSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function abort(signal) {
  if (signal?.aborted) {
    const error = new Error('更新操作已取消。');
    error.name = 'AbortError';
    throw error;
  }
}

function repositoryParts(repository) {
  if (typeof repository !== 'string' || repository.trim() !== repository || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) {
    throw new Error('GitHub 仓库必须是有效的 owner/repository。');
  }
  const parts = repository.split('/');
  if (['.', '..'].includes(parts[1]) || parts[0].includes('--')) throw new Error('GitHub 仓库名称无效。');
  return parts;
}

function stableVersion(value) {
  if (typeof value !== 'string' || value.trim() !== value || !VERSION.test(value) || value.length > 60) throw new Error('更新版本必须是稳定版 X.Y.Z。');
  return value;
}

function compareVersions(left, right) {
  const a = stableVersion(left).split('.').map(BigInt);
  const b = stableVersion(right).split('.').map(BigInt);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

function extensionIdentity(extensionId) {
  if (typeof extensionId !== 'string' || extensionId.trim() !== extensionId || !EXTENSION_ID.test(extensionId)) throw new Error('扩展标识无效。');
  const dot = extensionId.indexOf('.');
  return { publisher: extensionId.slice(0, dot), name: extensionId.slice(dot + 1) };
}

function safeURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('更新下载地址无效。'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) throw new Error('更新仅允许无凭据的 HTTPS 地址。');
  return url;
}

function isRepositoryPath(url, repository, suffix) {
  const [owner, name] = repositoryParts(repository);
  const prefix = `/${owner}/${name}`;
  return url.pathname.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase() && url.pathname.slice(prefix.length) === suffix;
}

function releaseURL(value, repository, version, type, tag) {
  const url = safeURL(value);
  if (url.hostname !== 'github.com' || url.search) throw new Error('更新地址不属于指定 GitHub 仓库。');
  const tags = tag ? [tag] : [`v${version}`, version];
  for (const candidate of tags) {
    const suffix = type === 'page' ? `/releases/tag/${candidate}` : `/releases/download/${candidate}/${type}`;
    if (isRepositoryPath(url, repository, suffix)) return { url, tag: candidate };
  }
  throw new Error('更新地址的仓库、版本标签或资源名称不匹配。');
}

function validateRelease(release, repository) {
  repositoryParts(repository);
  if (!release || typeof release !== 'object') throw new Error('更新信息无效。');
  const version = stableVersion(release.version);
  const assetName = `frosted-background-${version}.vsix`;
  const asset = releaseURL(release.assetUrl, repository, version, assetName);
  const manifest = releaseURL(release.manifestUrl, repository, version, 'update-manifest.json', asset.tag);
  releaseURL(release.pageUrl, repository, version, 'page', asset.tag);
  return { version, assetName, assetURL: asset.url, manifestURL: manifest.url };
}

function header(headers, name) {
  const key = Object.keys(headers || {}).find(item => item.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  if (Array.isArray(value)) return value.length === 1 ? String(value[0]) : undefined;
  return value === undefined ? undefined : String(value);
}

// Transport performs exactly one request. Redirect policy stays in fetchBuffer,
// so injected test transports cannot bypass the URL and size validation.
function requestBuffer(url, { maxBytes, signal, headers }) {
  abort(signal);
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    let finished = false;
    let timer;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const request = https.get(url, { headers, signal, agent: false }, response => {
      const size = Number(header(response.headers, 'content-length'));
      if (Number.isFinite(size) && size > maxBytes) {
        request.destroy(new Error('更新文件超过允许大小。'));
        return;
      }
      response.on('data', chunk => {
        total += chunk.length;
        if (total > maxBytes) request.destroy(new Error('更新文件超过允许大小。'));
        else chunks.push(chunk);
      });
      response.on('error', error => finish(error));
      response.on('aborted', () => finish(new Error('更新下载未完成。')));
      response.on('end', () => finish(null, { statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', error => finish(error));
    request.setTimeout(15000, () => request.destroy(new Error('更新下载连接超时。')));
    timer = setTimeout(() => request.destroy(new Error('更新下载超时。')), 30000);
    timer.unref?.();
  });
}

async function fetchBuffer(initial, { request = requestBuffer, signal, maxBytes, api = false }) {
  let current = safeURL(initial);
  const first = current.href;
  for (let hop = 0; hop <= 4; hop++) {
    abort(signal);
    if (current.href !== first) {
      // API redirects could transfer ownership to an unexpected repository.
      // Download redirects may only use GitHub's dedicated release CDN.
      if (api || current.hostname !== 'release-assets.githubusercontent.com' || !/^\/github-production-release-asset\/[A-Za-z0-9/_-]+$/.test(current.pathname)) {
        throw new Error('已拒绝不受信任的更新重定向。');
      }
    }
    const response = await request(current.href, {
      maxBytes, signal,
      headers: {
        'User-Agent': 'frosted-background-update',
        Accept: api ? 'application/vnd.github+json' : 'application/octet-stream',
        'Accept-Encoding': 'identity',
        ...(api ? { 'X-GitHub-Api-Version': '2022-11-28' } : {})
      }
    });
    abort(signal);
    if (!response || !Number.isInteger(response.statusCode) || !Buffer.isBuffer(response.body)) throw new Error('更新服务器响应格式无效。');
    if (response.body.length > maxBytes || Number(header(response.headers, 'content-length')) > maxBytes) throw new Error('更新文件超过允许大小。');
    const encoding = header(response.headers, 'content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') throw new Error('更新服务器返回了不支持的内容编码。');
    if (REDIRECTS.has(response.statusCode)) {
      const location = header(response.headers, 'location');
      if (!location || hop === 4) throw new Error('更新重定向次数过多或地址缺失。');
      // Do not include signed CDN URLs in diagnostics or logs.
      try { current = safeURL(new URL(location, current).href); }
      catch { throw new Error('更新重定向地址无效。'); }
      continue;
    }
    return response;
  }
  throw new Error('更新重定向次数过多。');
}

function json(buffer, label) {
  let parsed;
  try { parsed = JSON.parse(buffer.toString('utf8')); }
  catch { throw new Error(`${label}不是有效 JSON。`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label}格式无效。`);
  return parsed;
}

function successful(response) {
  if (response.statusCode !== 200) throw new Error(`GitHub 更新请求失败（HTTP ${response.statusCode}）。`);
  return response.body;
}

async function findRelease({ repository, currentVersion, extensionId, request, signal }) {
  repositoryParts(repository);
  stableVersion(currentVersion);
  extensionIdentity(extensionId);
  const response = await fetchBuffer(`https://api.github.com/repos/${repository}/releases/latest`, { request, signal, maxBytes: LIMITS.release, api: true });
  if (response.statusCode === 404) return null;
  const release = json(successful(response), 'GitHub 发布信息');
  if (release.draft !== false || release.prerelease !== false) throw new Error('更新发布必须是公开稳定版。');
  if (typeof release.tag_name !== 'string') throw new Error('更新缺少版本标签。');
  const version = stableVersion(release.tag_name.replace(/^v/, ''));
  if (compareVersions(version, currentVersion) <= 0) return null;
  if (!Array.isArray(release.assets)) throw new Error('更新发布缺少资源。');
  const assetName = `frosted-background-${version}.vsix`;
  const select = (name, maxBytes) => {
    const matching = release.assets.filter(asset => asset?.name === name);
    if (matching.length !== 1) throw new Error(`更新发布必须包含唯一的 ${name}。`);
    const asset = matching[0];
    if (asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxBytes) throw new Error('更新发布资源无效或超过允许大小。');
    releaseURL(asset.browser_download_url, repository, version, name, release.tag_name);
    return asset.browser_download_url;
  };
  const result = {
    version,
    assetUrl: select(assetName, LIMITS.vsix),
    manifestUrl: select('update-manifest.json', LIMITS.manifest),
    pageUrl: release.html_url
  };
  validateRelease(result, repository);
  return result;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntries(buffer) {
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) { end = offset; break; }
  }
  if (end === -1) throw new Error('下载文件不是有效 VSIX 压缩包。');
  const count = buffer.readUInt16LE(end + 10), length = buffer.readUInt32LE(end + 12), start = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== count || count === 0xffff || count > 5000 || start + length !== end) {
    throw new Error('不支持此 VSIX 压缩包结构。');
  }
  const entries = new Map();
  let cursor = start;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('VSIX 文件目录损坏。');
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw new Error('VSIX 文件目录越界。');
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    const mode = buffer.readUInt32LE(cursor + 38) >>> 16;
    const entry = {
      name, flags: buffer.readUInt16LE(cursor + 8), method: buffer.readUInt16LE(cursor + 10), crc: buffer.readUInt32LE(cursor + 16),
      compressed: buffer.readUInt32LE(cursor + 20), size: buffer.readUInt32LE(cursor + 24), offset: buffer.readUInt32LE(cursor + 42)
    };
    const parts = name.split('/');
    if (!name || !Buffer.from(name).equals(nameBytes) || /[\\\x00-\x1f:]/.test(name) || name.startsWith('/') || parts.some((part, i) => part === '..' || part === '.' || (!part && i < parts.length - 1)) || (mode & 0xf000) === 0xa000) throw new Error('VSIX 包含不安全的文件路径。');
    if (entries.has(name.toLowerCase()) || entry.flags & 1 || ![0, 8].includes(entry.method) || buffer.readUInt16LE(cursor + 34) !== 0 || entry.offset >= start) throw new Error('VSIX 包含重复、加密或不支持的文件。');
    entries.set(name.toLowerCase(), entry);
    cursor = next;
  }
  if (cursor !== end) throw new Error('VSIX 文件目录长度不匹配。');
  return { entries, start };
}

function readZipEntry(buffer, directory, name) {
  const entry = directory.entries.get(name);
  if (!entry || entry.name !== name) throw new Error(`VSIX 缺少 ${name}。`);
  if (entry.size <= 0 || entry.size > LIMITS.package || entry.offset + 30 > directory.start || buffer.readUInt32LE(entry.offset) !== 0x04034b50) throw new Error('VSIX 清单大小或文件头无效。');
  const nameLength = buffer.readUInt16LE(entry.offset + 26), extraLength = buffer.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLength + extraLength;
  if (start + entry.compressed > directory.start || buffer.readUInt16LE(entry.offset + 6) !== entry.flags || buffer.readUInt16LE(entry.offset + 8) !== entry.method || buffer.subarray(entry.offset + 30, entry.offset + 30 + nameLength).toString('utf8') !== name) throw new Error('VSIX 清单文件头不匹配。');
  if (!(entry.flags & 8) && (buffer.readUInt32LE(entry.offset + 18) !== entry.compressed || buffer.readUInt32LE(entry.offset + 22) !== entry.size)) throw new Error('VSIX 清单压缩长度不匹配。');
  const compressed = buffer.subarray(start, start + entry.compressed);
  let content;
  try { content = entry.method === 0 ? compressed : zlib.inflateRawSync(compressed, { maxOutputLength: LIMITS.package }); }
  catch { throw new Error('VSIX 清单无法解压或超过允许大小。'); }
  if (content.length !== entry.size || crc32(content) !== entry.crc) throw new Error('VSIX 清单校验失败。');
  return content;
}

function inspectVSIX(buffer, extensionId, version) {
  const expected = extensionIdentity(extensionId);
  const directory = zipEntries(buffer);
  const pkg = json(readZipEntry(buffer, directory, 'extension/package.json'), '扩展清单');
  if (pkg.publisher !== expected.publisher || pkg.name !== expected.name || pkg.version !== version) throw new Error('VSIX 内的扩展身份或版本与发布信息不一致。');
  if (typeof pkg.engines?.vscode !== 'string' || !pkg.engines.vscode || pkg.engines.vscode.length > 200) throw new Error('VSIX 缺少有效的 VS Code 版本要求。');
  const xml = readZipEntry(buffer, directory, 'extension.vsixmanifest').toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('VSIX XML 清单包含不支持的声明。');
  const identities = [...xml.matchAll(/<Identity\b([^>]*)>/g)];
  if (identities.length !== 1) throw new Error('VSIX XML 清单身份无效。');
  const attributes = new Map();
  for (const match of identities[0][1].matchAll(/([A-Za-z][\w:.-]*)\s*=\s*(["'])(.*?)\2/g)) {
    if (attributes.has(match[1])) throw new Error('VSIX XML 清单包含重复属性。');
    attributes.set(match[1], match[3]);
  }
  if (attributes.get('Publisher') !== expected.publisher || attributes.get('Id') !== expected.name || attributes.get('Version') !== version) throw new Error('VSIX XML 清单身份或版本不匹配。');
  return { vscode: pkg.engines.vscode };
}

async function downloadRelease({ release, repository, extensionId, currentVersion, directory, request, signal }) {
  extensionIdentity(extensionId);
  const metadata = validateRelease(release, repository);
  if (currentVersion !== undefined && compareVersions(metadata.version, currentVersion) <= 0) throw new Error('更新版本必须高于当前已安装版本。');
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('更新缓存目录必须是本机绝对路径。');
  const manifestResponse = await fetchBuffer(metadata.manifestURL.href, { request, signal, maxBytes: LIMITS.manifest });
  const manifest = json(successful(manifestResponse), '更新清单');
  if (manifest.version !== metadata.version || manifest.extensionId !== extensionId || manifest.assetName !== metadata.assetName || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('更新清单的身份、版本、文件名或校验值不匹配。');
  const response = await fetchBuffer(metadata.assetURL.href, { request, signal, maxBytes: LIMITS.vsix });
  const bytes = successful(response);
  if (!bytes.length || crypto.createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('更新文件 SHA-256 校验失败，未安装。');
  const engines = inspectVSIX(bytes, extensionId, metadata.version);
  abort(signal);
  await fs.mkdir(directory, { recursive: true });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('更新缓存目录必须是普通目录。');
  // A unique filename prevents concurrent checks or an occupied old VSIX from
  // being overwritten. Only fully verified bytes become an install candidate.
  const filename = `${metadata.assetName.slice(0, -5)}-${crypto.randomUUID()}.vsix`;
  const filePath = path.join(directory, filename);
  const temporary = filePath + '.part';
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    abort(signal);
    await fs.rename(temporary, filePath);
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return { filePath, version: metadata.version, engines };
}

module.exports = { findRelease, downloadRelease, compareVersions, LIMITS };
