'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { normalizeConfig } = require('./config');

const ASSET_DIRECTORY = 'frosted-background-assets';
const OWNER_FILE = '.owner.json';
const OWNER = 'frosted-background/v1';
const START_MARKER = '<!-- FROSTED-BACKGROUND:START v1 -->';
const END_MARKER = '<!-- FROSTED-BACKGROUND:END v1 -->';
const MAX_MEDIA_BYTES = 500 * 1024 * 1024;
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
  const info = await fsp.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('界面文件不是普通文件，已停止操作。');
  const temporary = path.join(path.dirname(filename), `.frosted-${crypto.randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temporary, content, { flag: 'wx', mode: info.mode & 0o777 });
    if (await fsp.readFile(filename, 'utf8') !== expected) throw new Error('界面文件被其他程序修改，请重新执行背景命令。');
    await fsp.rename(temporary, filename);
  } finally {
    await fsp.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
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
    await pipeline(fs.createReadStream(source), meter, fs.createWriteStream(temporary, { flags: 'wx' }));
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

async function applyChecked({ appRoot, rendererPath, mediaPath, config = {} }, cachedExpectation) {
  try {
    const extension = path.extname(mediaPath || '').toLowerCase();
    const kind = IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : undefined;
    if (!kind) throw new Error('请选择 PNG、JPG、JPEG、GIF、WebP、BMP、AVIF 图片，或 MP4、WebM 视频。');
    const mediaInfo = await fsp.stat(mediaPath);
    if (!mediaInfo.isFile() || !mediaInfo.size) throw new Error('请选择有效且非空的本地媒体文件。');
    if (mediaInfo.size > MAX_MEDIA_BYTES) throw new Error('背景文件过大，请选择不超过 500 MB 的文件。');
    const rendererInfo = await fsp.stat(rendererPath);
    if (!rendererInfo.isFile()) throw new Error('插件渲染文件缺失，请重新安装插件。');
    const workbenchPath = await findWorkbench(appRoot);
    const directory = await ensureAssets(workbenchPath, true);
    return await withLock(directory, async () => {
      const original = await fsp.readFile(workbenchPath, 'utf8');
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
        const rendererName = await stageAsset(rendererPath, directory, 'renderer', '.js', 2 * 1024 * 1024, created);
        const mediaName = await stageAsset(mediaPath, directory, 'media', extension, MAX_MEDIA_BYTES, created);
        if (cachedExpectation && mediaName !== cachedExpectation.mediaName) throw new Error('缓存背景在更新期间被修改，已停止应用。');
        const payload = { ...config, enabled: true, source: `./${ASSET_DIRECTORY}/${mediaName}`, kind };
        const next = inject(original, rendererName, payload);
        if (next !== original) await atomicReplace(workbenchPath, next, original);
        return { workbenchPath, kind, backupPath: backup };
      } catch (error) {
        // HTML publication is the final operation, so a failed apply cannot
        // leave the workbench referring to partially copied files.
        for (const filename of created) await fsp.unlink(filename).catch(() => {});
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
  if (stripInjection(html) === html) throw new Error('当前安装没有可复用的背景，请先选择背景。');
  const directory = await ensureAssets(workbenchPath, false);
  if (!directory) throw new Error('背景缓存目录缺失，请重新选择背景。');
  const block = html.slice(html.indexOf(START_MARKER) + START_MARKER.length, html.indexOf(END_MARKER)).trim();
  const script = /^<script src="\.\/frosted-background-assets\/renderer-[a-f0-9]{64}\.js" data-frosted-config="([^"]*)"><\/script>$/.exec(block);
  if (!script) throw new Error('背景注入结构与本插件不符，已停止自动更新。');
  let payload;
  try { payload = JSON.parse(decodeOwnAttribute(script[1])); }
  catch { throw new Error('无法读取已应用的背景配置，请重新选择背景。'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.enabled !== true || typeof payload.source !== 'string') throw new Error('背景缓存配置无效。');
  const source = /^\.\/frosted-background-assets\/(media-([a-f0-9]{64})\.(png|jpe?g|gif|webp|bmp|avif|mp4|webm))$/.exec(payload.source);
  if (!source) throw new Error('缓存背景地址不属于本插件的本地资源。');
  const expectedKind = ['mp4', 'webm'].includes(source[3]) ? 'video' : 'image';
  if (payload.kind !== expectedKind) throw new Error('缓存背景类型不匹配。');
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
  return applyChecked({ appRoot, rendererPath, mediaPath: cached.mediaPath, config: config === undefined ? cached.config : normalizeConfig(config) }, cached);
}

async function restore({ appRoot }) {
  try {
    const workbenchPath = await findWorkbench(appRoot);
    const directory = await ensureAssets(workbenchPath, false);
    const action = async () => {
      const original = await fsp.readFile(workbenchPath, 'utf8');
      const next = stripInjection(original);
      if (next !== original) await atomicReplace(workbenchPath, next, original);
      const cleanupErrors = [];
      if (directory) {
        for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
          if (!/^(renderer-[a-f0-9]{64}\.js|media-[a-f0-9]{64}\.(png|jpe?g|gif|webp|bmp|avif|mp4|webm))$/.test(entry.name)) continue;
          // Never follow links or remove unknown files. Backups remain for recovery.
          if (!entry.isFile() || entry.isSymbolicLink()) continue;
          try { await fsp.unlink(path.join(directory, entry.name)); } catch (error) { cleanupErrors.push(error.message); }
        }
      }
      return { workbenchPath, changed: next !== original, cleanupErrors };
    };
    return directory ? await withLock(directory, action) : await action();
  } catch (error) { throw friendly(error); }
}

async function status({ appRoot }) {
  const workbenchPath = await findWorkbench(appRoot);
  const html = await fsp.readFile(workbenchPath, 'utf8');
  return { installed: stripInjection(html) !== html, workbenchPath };
}

module.exports = { findWorkbench, apply, reapply, restore, status, stripInjection, inject, ASSET_DIRECTORY, START_MARKER, END_MARKER, MAX_MEDIA_BYTES };
