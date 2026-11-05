'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { normalizeConfig } = require('./config');
const { normalizeRemoteSource } = require('../media/source');

const ASSET_DIRECTORY = 'frosted-background-assets';
const OWNER_FILE = '.owner.json';
const OWNER = 'frosted-background/v1';
const START_MARKER = '<!-- FROSTED-BACKGROUND:START v1 -->';
const END_MARKER = '<!-- FROSTED-BACKGROUND:END v1 -->';
const MAX_MEDIA_BYTES = 500 * 1024 * 1024;
const MAX_RUNTIME_BYTES = 3 * 1024 * 1024;
const MAX_REGIONS_BYTES = 512 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_HLS_BYTES = 2 * 1024 * 1024;
const SCRIPT_SEPARATOR = Buffer.from('\n;\n');
const LIVE_STATE_FILE = 'live-state.json';
const LIVE_STATE_SOURCE = `./${ASSET_DIRECTORY}/${LIVE_STATE_FILE}`;
const MAX_LIVE_STATE_BYTES = 128 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm']);
const WORKBENCH_CANDIDATES = [
  'out/vs/code/electron-browser/workbench/workbench.html',
  'out/vs/code/electron-sandbox/workbench/workbench.html',
];

async function exists(filename) {
  try { return await fsp.lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function findWorkbench(appRoot) {
  if (!appRoot || !path.isAbsolute(appRoot)) throw new Error('无法定位 VS Code 安装目录。仅支持桌面版 VS Code。');
  for (const candidate of WORKBENCH_CANDIDATES) {
    const filename = path.join(appRoot, candidate);
    const info = await exists(filename);
    if (info && info.isFile() && !info.isSymbolicLink()) return filename;
  }
  throw new Error('未找到兼容的 VS Code 界面文件。当前版本可能尚不受支持。');
}

function stripInjection(html) {
  const start = html.indexOf(START_MARKER);
  const end = html.indexOf(END_MARKER);
  if (start === -1 && end === -1) return html;
  if (start === -1 || end < start || html.indexOf(START_MARKER, start + START_MARKER.length) !== -1 || html.indexOf(END_MARKER, end + END_MARKER.length) !== -1) {
    throw new Error('毛玻璃背景标记不完整，已停止修改。请先检查或恢复界面文件。');
  }
  let after = end + END_MARKER.length;
  // This newline belongs to our block; all bytes outside the block survive.
  if (html.slice(after, after + 2) === '\r\n') after += 2;
  else if (html[after] === '\n') after += 1;
  return html.slice(0, start) + html.slice(after);
}

function escapeAttribute(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
}

function inject(html, rendererName, config) {
  const clean = stripInjection(html);
  const match = /<\/html\s*>\s*$/i.exec(clean);
  if (!match) throw new Error('VS Code 界面文件格式不受支持，未修改原文件。');
  const block = `${START_MARKER}\n<script src="./${ASSET_DIRECTORY}/${rendererName}" data-frosted-config="${escapeAttribute(JSON.stringify(config))}"></script>\n${END_MARKER}\n`;
  return clean.slice(0, match.index) + block + clean.slice(match.index);
}

async function ensureAssets(workbenchPath, create) {
  const directory = path.join(path.dirname(workbenchPath), ASSET_DIRECTORY);
  const info = await exists(directory);
  if (!info) {
    if (!create) return undefined;
    try {
      await fsp.mkdir(directory);
      await fsp.writeFile(path.join(directory, OWNER_FILE), JSON.stringify({ owner: OWNER }) + '\n', { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const actual = await fsp.lstat(directory);
  if (!actual.isDirectory() || actual.isSymbolicLink()) throw new Error('背景资源目录不是普通目录，已停止操作。');
  const ownerPath = path.join(directory, OWNER_FILE);
  const ownerInfo = await exists(ownerPath);
  if (!ownerInfo || !ownerInfo.isFile() || ownerInfo.isSymbolicLink()) throw new Error('背景资源目录已存在，但不属于本插件。未修改其中的文件。');
  let owner;
  try { owner = JSON.parse(await fsp.readFile(ownerPath, 'utf8')); } catch { /* Invalid ownership fails closed. */ }
  if (owner?.owner !== OWNER) throw new Error('背景资源目录所有权无法确认，已停止操作。');
  return directory;
}

async function withLock(directory, action) {
  const lock = path.join(directory, '.operation.lock');
  let handle;
  try { handle = await fsp.open(lock, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const lockInfo = await fsp.lstat(lock);
    if (!lockInfo.isFile() || lockInfo.isSymbolicLink()) throw new Error('背景操作锁异常，已停止操作。');
    let previous;
    try { previous = JSON.parse(await fsp.readFile(lock, 'utf8')); } catch { /* A live process may still be writing it. */ }
    let alive = true;
    if (Number.isInteger(previous?.pid) && previous.pid > 0) {
      try { process.kill(previous.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
    }
    if (alive) throw new Error('另一个 VS Code 窗口正在修改背景，请稍后重试。');
    await fsp.unlink(lock);
    handle = await fsp.open(lock, 'wx');
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    return await action();
  } finally {
    await handle.close();
    await fsp.unlink(lock).catch(() => {});
  }
}

async function atomicReplace(filename, content, expected) {
  const info = await exists(filename);
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('界面文件不是普通文件，已停止操作。');
  if (Boolean(info) !== (expected !== undefined)) throw new Error('界面文件被其他程序修改，请重新执行背景命令。');
  const temporary = path.join(path.dirname(filename), `.frosted-${crypto.randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temporary, content, { flag: 'wx', mode: info ? info.mode & 0o777 : 0o600 });
    const current = await exists(filename);
    if (current && (!current.isFile() || current.isSymbolicLink())) throw new Error('界面文件不是普通文件，已停止操作。');
    if (Boolean(current) !== (expected !== undefined) || (current && await fsp.readFile(filename, 'utf8') !== expected)) throw new Error('界面文件被其他程序修改，请重新执行背景命令。');
    await fsp.rename(temporary, filename);
  } finally {
    await fsp.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.enabled !== true || typeof payload.source !== 'string') throw new Error('背景缓存配置无效。');
  const remote = payload.sourceType === 'hls';
  if (payload.sourceType !== undefined && !remote) throw new Error('背景缓存配置无效。');
  const source = remote ? normalizeRemoteSource({ type: 'hls', kind: payload.kind, url: payload.source })
    : /^\.\/frosted-background-assets\/(media-([a-f0-9]{64})\.(png|jpe?g|gif|webp|bmp|avif|mp4|webm))$/.exec(payload.source);
  if (!source) throw new Error('缓存背景地址不属于本插件的本地资源。');
  if (remote && source.url !== payload.source) throw new Error('背景缓存配置无效。');
  const expectedKind = remote || ['mp4', 'webm'].includes(source[3]) ? 'video' : 'image';
  if (payload.kind !== expectedKind) throw new Error('缓存背景类型不匹配。');
  if (payload.liveState !== undefined && payload.liveState !== LIVE_STATE_SOURCE) throw new Error('实时背景配置地址无效，已停止操作。');
  if (payload.videoPlayer !== undefined && (expectedKind !== 'video' || !/^\.\/frosted-background-assets\/video-host-[a-f0-9]{64}\.html$/.test(payload.videoPlayer))) throw new Error('视频播放器缓存地址无效，已停止操作。');
  if (remote && !payload.videoPlayer) throw new Error('视频播放器缓存地址无效，已停止操作。');
  return source;
}

function parseInjection(html) {
  if (stripInjection(html) === html) throw new Error('当前安装没有可复用的背景，请先选择背景。');
  const block = html.slice(html.indexOf(START_MARKER) + START_MARKER.length, html.indexOf(END_MARKER)).trim();
  const script = /^<script src="\.\/frosted-background-assets\/(renderer-[a-f0-9]{64}\.js)" data-frosted-config="([^"]*)"><\/script>$/.exec(block);
  if (!script) throw new Error('背景注入结构与本插件不符，已停止自动更新。');
  let payload;
  try { payload = JSON.parse(decodeOwnAttribute(script[2])); }
  catch { throw new Error('无法读取已应用的背景配置，请重新选择背景。'); }
  const source = validatePayload(payload);
  return { payload, source, rendererName: script[1] };
}

async function readLiveState(directory) {
  const filename = path.join(directory, LIVE_STATE_FILE);
  const info = await exists(filename);
  if (!info) return { filename, content: undefined, envelope: undefined };
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_LIVE_STATE_BYTES) throw new Error('实时背景配置不是有效的普通文件，已停止操作。');
  const content = await fsp.readFile(filename, 'utf8');
  let envelope;
  try { envelope = JSON.parse(content); } catch { /* Fail closed for a foreign/corrupt stable file. */ }
  const settings = envelope?.settings;
  if (Buffer.byteLength(content) > MAX_LIVE_STATE_BYTES || envelope?.protocol !== 1 || !UUID.test(envelope.revision) || !settings || typeof settings !== 'object' || Array.isArray(settings) || typeof settings.enabled !== 'boolean') throw new Error('实时背景配置无效，已停止操作。');
  if (settings.enabled) {
    validatePayload(settings);
    if (settings.liveState !== LIVE_STATE_SOURCE) throw new Error('实时背景配置无效，已停止操作。');
  } else if (Object.keys(settings).length !== 1) throw new Error('实时背景配置无效，已停止操作。');
  return { filename, content, envelope };
}

// HTML is durable before the live revision becomes visible. On a failed live
// commit, roll back only our exact HTML, preserving any concurrent external edit.
async function publishState(workbenchPath, original, next, live, settings) {
  const envelope = { protocol: 1, revision: crypto.randomUUID(), settings };
  const content = JSON.stringify(envelope) + '\n';
  if (Buffer.byteLength(content) > MAX_LIVE_STATE_BYTES) throw new Error('实时背景配置过大，已停止操作。');
  let htmlPublished = false;
  try {
    if (next !== original) {
      await atomicReplace(workbenchPath, next, original);
      htmlPublished = true;
    }
    await atomicReplace(live.filename, content, live.content);
  } catch (error) {
    if (htmlPublished) {
      try { await atomicReplace(workbenchPath, original, next); }
      catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    throw error;
  }
}

async function cleanFailedAssets(created, workbenchPath, directory) {
  // A failed rollback, an external edit, or an unreadable state may still refer
  // to staged assets. In uncertain cases retain them for later explicit restore.
  let references;
  try {
    const html = await fsp.readFile(workbenchPath, 'utf8');
    const live = await readLiveState(directory);
    references = html + (live.content || '');
    // A workbench/live document refers to the video page, which in turn refers
    // to its bundled player. Keep that indirect dependency if rollback fails.
    const pages = new Set(Array.from(references.matchAll(/video-host-[a-f0-9]{64}\.html/g), match => match[0]));
    for (const name of pages) {
      const filename = path.join(directory, name);
      const page = await readRuntimeSource(filename, 64 * 1024, '视频播放器缓存地址无效，已停止操作。');
      references += page.toString('utf8');
    }
  } catch { return; }
  for (const filename of created) {
    if (!references.includes(path.basename(filename))) await fsp.unlink(filename).catch(() => {});
  }
}

async function stageAsset(source, directory, prefix, extension, limit, created) {
  const temporary = path.join(directory, `.stage-${crypto.randomUUID()}.tmp`);
  const hash = crypto.createHash('sha256');
  let total = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      if (total > limit) return callback(new Error('背景文件过大，请选择不超过 500 MB 的文件。'));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    const input = Buffer.isBuffer(source) ? Readable.from([source]) : fs.createReadStream(source);
    await pipeline(input, meter, fs.createWriteStream(temporary, { flags: 'wx' }));
    if (!total) throw new Error('所选背景文件为空。');
    const name = `${prefix}-${hash.digest('hex')}${extension}`;
    const destination = path.join(directory, name);
    const info = await exists(destination);
    if (info) {
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('背景资源目标不是普通文件，已停止操作。');
      // Replace only an asset whose bytes match its content-derived filename.
      const digest = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(destination)) digest.update(chunk);
      if (digest.digest('hex') !== name.slice(prefix.length + 1, prefix.length + 65)) throw new Error('现有背景资源被修改，已停止覆盖。请先恢复背景。');
    } else {
      await fsp.rename(temporary, destination);
      created.push(destination);
    }
    return name;
  } finally {
    await fsp.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function friendly(error) {
  if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) {
    const wrapped = new Error('无法写入 VS Code 安装目录。请使用有写入权限的用户安装版，或由系统管理员授予该目录写入权限。原界面文件会保留。');
    wrapped.code = error.code;
    wrapped.cause = error;
    return wrapped;
  }
  return error;
}

async function readRuntimeSource(filename, limit, invalidMessage) {
  const info = await exists(filename);
  if (!info?.isFile() || info.isSymbolicLink() || !info.size || info.size > limit) throw new Error(invalidMessage);
  const handle = await fsp.open(filename, 'r');
  try {
    // Verify the opened file is the same ordinary file that was inspected.
    // Bound the read itself so growth after lstat cannot allocate arbitrary RAM.
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || !opened.size || opened.size > limit) throw new Error(invalidMessage);
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total <= limit) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (!total || total > limit) throw new Error(invalidMessage);
    return buffer.subarray(0, total);
  } finally { await handle.close(); }
}

async function applyChecked({ appRoot, rendererPath, mediaPath, mediaSource, config = {} }, cachedExpectation) {
  try {
    if (mediaSource !== undefined && mediaPath !== undefined) throw new Error('请选择一个背景来源。');
    const remote = mediaSource === undefined ? undefined : normalizeRemoteSource(mediaSource);
    const extension = path.extname(mediaPath || '').toLowerCase();
    const kind = remote ? 'video' : IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : undefined;
    if (!kind) throw new Error('请选择 PNG、JPG、JPEG、GIF、WebP、BMP、AVIF 图片，或 MP4、WebM 视频。');
    if (!remote) {
      const mediaInfo = await fsp.stat(mediaPath);
      if (!mediaInfo.isFile() || !mediaInfo.size) throw new Error('请选择有效且非空的本地媒体文件。');
      if (mediaInfo.size > MAX_MEDIA_BYTES) throw new Error('背景文件过大，请选择不超过 500 MB 的文件。');
    }
    const regionsPath = path.join(path.dirname(rendererPath), 'regions.js');
    const regionsBytes = await readRuntimeSource(regionsPath, MAX_REGIONS_BYTES, '区域效果文件无效或缺失，请重新安装插件。');
    const sourceBytes = await readRuntimeSource(path.join(path.dirname(rendererPath), 'source.js'), MAX_SOURCE_BYTES, '媒体来源文件无效或缺失，请重新安装插件。');
    const sharedBundle = Buffer.concat([regionsBytes, SCRIPT_SEPARATOR, sourceBytes, SCRIPT_SEPARATOR]);
    const availableRuntimeBytes = MAX_RUNTIME_BYTES - sharedBundle.length;
    const rendererBytes = await readRuntimeSource(rendererPath, availableRuntimeBytes, '插件运行文件无效或过大，请重新安装插件。');
    const rendererBundle = Buffer.concat([sharedBundle, rendererBytes]);
    // The video page has its own media policy. The workbench CSP is untouched.
    const videoPlayerPath = path.join(path.dirname(rendererPath), 'video-player.js');
    let playerBundle;
    if (kind === 'video') {
      const hlsBytes = remote ? await readRuntimeSource(path.join(path.dirname(rendererPath), 'vendor', 'hls.min.js'), MAX_HLS_BYTES, 'HLS 播放器文件无效或缺失，请重新安装插件。') : Buffer.alloc(0);
      const playerBytes = await readRuntimeSource(videoPlayerPath, availableRuntimeBytes - hlsBytes.length - (remote ? SCRIPT_SEPARATOR.length : 0), '视频播放器文件缺失，请重新安装插件。');
      playerBundle = Buffer.concat(remote ? [sharedBundle, hlsBytes, SCRIPT_SEPARATOR, playerBytes] : [sharedBundle, playerBytes]);
    }
    const workbenchPath = await findWorkbench(appRoot);
    const directory = await ensureAssets(workbenchPath, true);
    return await withLock(directory, async () => {
      const original = await fsp.readFile(workbenchPath, 'utf8');
      const live = await readLiveState(directory);
      if (cachedExpectation && original !== cachedExpectation.html) throw new Error('背景已在另一个窗口中改变，请重新应用。');
      const clean = stripInjection(original);
      // Validate the document before copying any large media files.
      inject(clean, 'validate.js', {});
      const backup = path.join(directory, `backup-${crypto.createHash('sha256').update(clean).digest('hex')}.html`);
      try { await fsp.writeFile(backup, clean, { flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const info = await fsp.lstat(backup);
        if (!info.isFile() || info.isSymbolicLink() || await fsp.readFile(backup, 'utf8') !== clean) throw new Error('界面备份已被修改，已停止操作。');
      }
      const created = [];
      try {
        const rendererName = await stageAsset(rendererBundle, directory, 'renderer', '.js', MAX_RUNTIME_BYTES, created);
        const mediaName = remote ? undefined : await stageAsset(mediaPath, directory, 'media', extension, MAX_MEDIA_BYTES, created);
        if (cachedExpectation && !remote && mediaName !== cachedExpectation.mediaName) throw new Error('缓存背景在更新期间被修改，已停止应用。');
        const payload = { ...normalizeConfig(config), enabled: true, source: remote ? remote.url : `./${ASSET_DIRECTORY}/${mediaName}`, kind, liveState: LIVE_STATE_SOURCE };
        if (remote) payload.sourceType = 'hls';
        delete payload.videoPlayer;
        if (kind === 'video') {
          const playerName = await stageAsset(playerBundle, directory, 'video-player', '.js', MAX_RUNTIME_BYTES, created);
          const videoPage = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src 'self'${remote ? ' https:' : ''}; media-src blob:${remote ? ' https:' : ''}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}video{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none}</style><script src="./${playerName}" defer></script></head><body></body></html>\n`);
          const pageName = await stageAsset(videoPage, directory, 'video-host', '.html', 64 * 1024, created);
          payload.videoPlayer = `./${ASSET_DIRECTORY}/${pageName}`;
        }
        const next = inject(original, rendererName, payload);
        await publishState(workbenchPath, original, next, live, payload);
        return { workbenchPath, kind, backupPath: backup, liveProtocol: 1 };
      } catch (error) {
        await cleanFailedAssets(created, workbenchPath, directory);
        throw error;
      }
    });
  } catch (error) { throw friendly(error); }
}

async function apply(options) {
  return applyChecked(options);
}

function decodeOwnAttribute(value) {
  if (/[<>]/.test(value) || /&(?!(?:amp|quot|lt|gt|#39);)/.test(value)) throw new Error('背景缓存配置包含未知的 HTML 编码。');
  const entities = { amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'" };
  return value.replace(/&(amp|quot|lt|gt|#39);/g, (_, name) => entities[name]);
}

async function cachedBackground(appRoot) {
  const workbenchPath = await findWorkbench(appRoot);
  const html = await fsp.readFile(workbenchPath, 'utf8');
  const parsed = parseInjection(html);
  const { payload, source } = parsed;
  const directory = await ensureAssets(workbenchPath, false);
  if (!directory) throw new Error('背景缓存目录缺失，请重新选择背景。');
  if (source.type === 'hls') {
    await validateCachedFiles(directory, parsed);
    return { html, mediaSource: source, config: normalizeConfig(payload) };
  }
  const mediaPath = path.join(directory, source[1]);
  const info = await fsp.lstat(mediaPath);
  if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > MAX_MEDIA_BYTES) throw new Error('缓存背景不是有效的普通媒体文件。');
  const digest = crypto.createHash('sha256');
  let size = 0;
  for await (const bytes of fs.createReadStream(mediaPath)) {
    size += bytes.length;
    if (size > MAX_MEDIA_BYTES) throw new Error('缓存背景超过允许大小。');
    digest.update(bytes);
  }
  if (digest.digest('hex') !== source[2]) throw new Error('缓存背景校验失败，请重新选择背景。');
  return { html, mediaPath, mediaName: source[1], config: normalizeConfig(payload) };
}

// Upgrade the renderer using the last successfully applied media and settings.
// The user's original media path is neither required nor changed by this helper.
async function reapply({ appRoot, rendererPath, config }) {
  const cached = await cachedBackground(appRoot);
  return applyChecked({ appRoot, rendererPath, mediaPath: cached.mediaPath, mediaSource: cached.mediaSource, config: config === undefined ? cached.config : normalizeConfig(config) }, cached);
}

async function validateCachedFiles(directory, parsed) {
  const validateFile = async (name, limit) => {
    const filename = path.join(directory, name);
    const info = await fsp.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > limit) throw new Error('缓存背景不是有效的普通媒体文件。');
    return filename;
  };
  if (parsed.source.type !== 'hls') await validateFile(parsed.source[1], MAX_MEDIA_BYTES);
  await validateFile(parsed.rendererName, MAX_RUNTIME_BYTES);
  if (parsed.payload.kind === 'video') {
    if (!parsed.payload.videoPlayer) throw new Error('视频播放器缓存地址无效，已停止操作。');
    const pagePath = await validateFile(path.basename(parsed.payload.videoPlayer), 64 * 1024);
    const page = await fsp.readFile(pagePath, 'utf8');
    const player = /<script src="\.\/(video-player-[a-f0-9]{64}\.js)" defer><\/script>/.exec(page);
    if (!player) throw new Error('视频播放器缓存地址无效，已停止操作。');
    await validateFile(player[1], MAX_RUNTIME_BYTES);
  }
}

// Slider/configuration changes reuse the already staged media. Only small
// control documents are read; even a 500 MB video is neither read nor hashed.
async function updateConfig({ appRoot, config = {} }) {
  try {
    const workbenchPath = await findWorkbench(appRoot);
    const directory = await ensureAssets(workbenchPath, false);
    if (!directory) throw new Error('背景缓存目录缺失，请重新选择背景。');
    return await withLock(directory, async () => {
      const original = await fsp.readFile(workbenchPath, 'utf8');
      const parsed = parseInjection(original);
      if (parsed.payload.liveState !== LIVE_STATE_SOURCE) throw new Error('当前背景尚不支持实时调整，请重新应用背景。');
      const live = await readLiveState(directory);
      if (!live.envelope || JSON.stringify(live.envelope.settings) !== JSON.stringify(parsed.payload)) throw new Error('实时背景配置与界面文件不一致，请重新应用背景。');
      await validateCachedFiles(directory, parsed);
      const settings = {
        ...normalizeConfig({ ...parsed.payload, ...config }), enabled: true,
        source: parsed.payload.source, kind: parsed.payload.kind, liveState: LIVE_STATE_SOURCE
      };
      if (parsed.payload.videoPlayer) settings.videoPlayer = parsed.payload.videoPlayer;
      if (parsed.payload.sourceType === 'hls') settings.sourceType = 'hls';
      const next = inject(original, parsed.rendererName, settings);
      await publishState(workbenchPath, original, next, live, settings);
      return { workbenchPath, kind: settings.kind, liveProtocol: 1 };
    });
  } catch (error) { throw friendly(error); }
}

async function restore({ appRoot }) {
  try {
    const workbenchPath = await findWorkbench(appRoot);
    const directory = await ensureAssets(workbenchPath, false);
    const action = async () => {
      const original = await fsp.readFile(workbenchPath, 'utf8');
      const next = stripInjection(original);
      let liveProtocol;
      if (directory) {
        const live = await readLiveState(directory);
        if (next === original && live.envelope) liveProtocol = 1;
        else {
          try { if (parseInjection(original).payload.liveState === LIVE_STATE_SOURCE) liveProtocol = 1; }
          catch { /* A legacy or malformed own block can still be removed safely. */ }
        }
        await publishState(workbenchPath, original, next, live, { enabled: false });
      } else if (next !== original) await atomicReplace(workbenchPath, next, original);
      const cleanupErrors = [];
      if (directory) {
        for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
          if (!/^(renderer-[a-f0-9]{64}\.js|video-player-[a-f0-9]{64}\.js|video-host-[a-f0-9]{64}\.html|media-[a-f0-9]{64}\.(png|jpe?g|gif|webp|bmp|avif|mp4|webm))$/.test(entry.name)) continue;
          // Never follow links or remove unknown files. Backups remain for recovery.
          if (!entry.isFile() || entry.isSymbolicLink()) continue;
          try { await fsp.unlink(path.join(directory, entry.name)); } catch (error) { cleanupErrors.push(error.message); }
        }
      }
      return { workbenchPath, changed: next !== original, cleanupErrors, ...(liveProtocol ? { liveProtocol } : {}) };
    };
    return directory ? await withLock(directory, action) : await action();
  } catch (error) { throw friendly(error); }
}

async function status({ appRoot }) {
  const workbenchPath = await findWorkbench(appRoot);
  const html = await fsp.readFile(workbenchPath, 'utf8');
  const state = { installed: stripInjection(html) !== html, workbenchPath };
  if (state.installed) {
    try {
      const parsed = parseInjection(html);
      if (parsed.payload.liveState !== LIVE_STATE_SOURCE) return state;
      const directory = await ensureAssets(workbenchPath, false);
      if (!directory) return state;
      const live = await readLiveState(directory);
      if (!live.envelope || JSON.stringify(live.envelope.settings) !== JSON.stringify(parsed.payload)) return state;
      await validateCachedFiles(directory, parsed);
      state.liveProtocol = 1;
    } catch { /* Presence is distinct from verified live-update capability. */ }
  }
  return state;
}

module.exports = { findWorkbench, apply, reapply, updateConfig, restore, status, stripInjection, inject, ASSET_DIRECTORY, START_MARKER, END_MARKER, MAX_MEDIA_BYTES, LIVE_STATE_FILE, LIVE_STATE_SOURCE };
