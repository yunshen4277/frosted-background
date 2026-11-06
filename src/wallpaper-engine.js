'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const MAX_ITEMS = 1000;
const MAX_METADATA = 256 * 1024;
const MAX_MEDIA = 500 * 1024 * 1024;
const MAX_PREVIEW = 10 * 1024 * 1024;
const IMAGES = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);
const VIDEOS = new Set(['.mp4', '.webm']);
const error = code => Object.assign(new Error(code), { code });
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const safeAbsolute = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
  && (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value))
  && !/^[\\/]{2}|[\x00-\x1f]/.test(value) && !value.startsWith('\\?\\');
const contained = (root, value) => {
  const relative = path.relative(root, value);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};

// Valve's old library list stores numeric keys -> paths; the current format
// stores numeric keys -> { path, apps, ... }. Parse data, never evaluate it.
function parseLibraries(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_METADATA) return [];
  let position = 0, tokens = 0;
  function token() {
    if (++tokens > 20000) throw error('WE_INVALID_FOLDER');
    while (position < text.length) {
      if (/\s/.test(text[position])) { position++; continue; }
      if (text.slice(position, position + 2) === '//') { position = text.indexOf('\n', position); if (position < 0) position = text.length; continue; }
      break;
    }
    if (position >= text.length) return undefined;
    const char = text[position++];
    if (char === '{' || char === '}') return char;
    if (char !== '"') throw error('WE_INVALID_FOLDER');
    let value = '';
    while (position < text.length) {
      const next = text[position++];
      if (next === '"') return { value };
      if (next === '\\' && ['\\', '"'].includes(text[position])) value += text[position++];
      else value += next;
      if (value.length > 4096) throw error('WE_INVALID_FOLDER');
    }
    throw error('WE_INVALID_FOLDER');
  }
  function object(depth, nested) {
    if (depth > 16) throw error('WE_INVALID_FOLDER');
    const result = Object.create(null);
    while (true) {
      const key = token();
      if (key === undefined && !nested) return result;
      if (key === '}' && nested) return result;
      if (!key || typeof key !== 'object') throw error('WE_INVALID_FOLDER');
      const value = token();
      if (value === '{') result[key.value] = object(depth + 1, true);
      else if (value && typeof value === 'object') result[key.value] = value.value;
      else throw error('WE_INVALID_FOLDER');
    }
  }
  try {
    const parsed = object(0, false);
    const libraries = parsed.libraryfolders || parsed.LibraryFolders;
    if (!libraries || typeof libraries !== 'object') return [];
    return Object.entries(libraries).filter(([key]) => /^\d+$/.test(key)).map(([, value]) => typeof value === 'string' ? value : value?.path).filter(safeAbsolute).slice(0, 64);
  } catch { return []; }
}

async function noLinks(filename, wantDirectory) {
  if (!safeAbsolute(filename)) throw error('WE_UNSAFE');
  const absolute = path.resolve(filename), parsed = path.parse(absolute);
  let current = parsed.root, info;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    info = await fs.lstat(current);
    if (info.isSymbolicLink()) throw error('WE_UNSAFE');
  }
  if (!info || (wantDirectory ? !info.isDirectory() : !info.isFile())) throw error('WE_UNSAFE');
  const real = await fs.realpath(absolute);
  if (!safeAbsolute(real) || !samePath(real, absolute)) throw error('WE_UNSAFE');
  return { path: real, info };
}

async function projectFile(directory, relative, limit) {
  if (typeof relative !== 'string' || !relative || relative.length > 1024 || /^[\\/]|[<>:"|?*\x00-\x1f]/.test(relative)) throw error('WE_UNSAFE');
  const pieces = relative.split(/[\\/]/);
  if (pieces.some(piece => !piece || piece === '.' || piece === '..')) throw error('WE_UNSAFE');
  const filename = path.resolve(directory, ...pieces);
  if (!contained(directory, filename)) throw error('WE_UNSAFE');
  const checked = await noLinks(filename, false);
  if (!contained(directory, checked.path)) throw error('WE_UNSAFE');
  if (checked.info.size > limit) throw error('WE_TOO_LARGE');
  if (!checked.info.size) throw error('WE_MISSING');
  return checked;
}

async function boundedRead(filename, maximum) {
  const checked = await noLinks(filename, false);
  if (checked.info.size > maximum) throw error('WE_TOO_LARGE');
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW || 0);
  const handle = await fs.open(checked.path, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum || info.dev !== checked.info.dev || info.ino !== checked.info.ino) throw error('WE_UNSAFE');
    const bytes = Buffer.alloc(Math.min(info.size + 1, maximum + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maximum || offset !== info.size) throw error('WE_UNSAFE');
    return bytes.subarray(0, offset).toString('utf8').replace(/^\uFEFF/, '');
  } finally { await handle.close(); }
}

const fingerprint = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
function titleFor(value, fallback) {
  return (typeof value === 'string' ? value : fallback).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160) || fallback.slice(0, 160);
}

function createWallpaperEngine(dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  const execFile = dependencies.execFile || childProcess.execFile;
  const defaultRoots = dependencies.defaultRoots || (platform === 'win32' ? ['C:\\Program Files (x86)\\Steam'] : []);
  const records = new WeakMap();
  async function registryRoots() {
    if (platform !== 'win32') return [];
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    const queries = [
      ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
      ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
      ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
    ];
    const values = await Promise.all(queries.map(([key, name]) => new Promise(resolve => {
      try {
        execFile(executable, ['query', key, '/v', name], { windowsHide: true, shell: false, timeout: 2500, maxBuffer: 16 * 1024, encoding: 'utf8' }, (issue, stdout) => {
          if (issue || typeof stdout !== 'string' || stdout.length > 16384) { resolve(); return; }
          const value = stdout.split(/\r?\n/).map(line => line.match(new RegExp(`^\\s*${name}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+?)\\s*$`))?.[1]).find(Boolean);
          resolve(safeAbsolute(value) ? value : undefined);
        });
      } catch { resolve(); }
    })));
    return values.filter(Boolean);
  }

  async function isInstallation(directory) {
    try {
      const root = (await noLinks(directory, true)).path;
      for (const name of ['wallpaper32.exe', 'wallpaper64.exe']) {
        try { await projectFile(root, name, 256 * 1024 * 1024); return root; } catch { /* Try the other architecture. */ }
      }
    } catch { /* Missing or unsafe directory. */ }
    return undefined;
  }

  async function inspectProject(directory, workshopId) {
    const id = crypto.createHash('sha256').update(process.platform === 'win32' ? directory.toLowerCase() : directory).digest('hex');
    const item = { id, title: titleFor(undefined, path.basename(directory)), type: 'unknown', supported: false, reason: 'invalid-project', ...(workshopId ? { workshopId } : {}) };
    try { await noLinks(directory, true); } catch { return { item: { ...item, reason: 'unsafe-path' } }; }
    let metadata;
    try {
      metadata = JSON.parse(await boundedRead(path.join(directory, 'project.json'), MAX_METADATA));
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return { item };
    } catch { return { item }; }
    item.title = titleFor(metadata.title, path.basename(directory));
    item.type = ['image', 'video', 'scene', 'web', 'application'].includes(metadata.type) ? metadata.type : 'unknown';
    if (typeof metadata.preview === 'string' && IMAGES.has(path.extname(metadata.preview).toLowerCase())) {
      try { item.previewPath = (await projectFile(directory, metadata.preview, MAX_PREVIEW)).path; } catch { /* Preview is optional, never a substitute for the wallpaper. */ }
    }
    if (!['image', 'video'].includes(item.type)) {
      item.reason = item.type === 'unknown' ? 'invalid-project' : 'unsupported-type';
      return { item };
    }
    if (typeof metadata.file !== 'string' || !metadata.file) { item.reason = 'missing-media'; return { item }; }
    // Validate even rejected extensions so traversal cannot be mislabeled as an
    // ordinary unsupported format and later become an accidental apply path.
    let media;
    try { media = await projectFile(directory, metadata.file, MAX_MEDIA); }
    catch (issue) {
      item.reason = issue.code === 'WE_TOO_LARGE' ? 'too-large' : issue.code === 'WE_UNSAFE' ? 'unsafe-path' : 'missing-media';
      return { item };
    }
    const allowed = item.type === 'video' ? VIDEOS : IMAGES;
    if (!allowed.has(path.extname(media.path).toLowerCase())) { item.reason = 'unsupported-type'; return { item }; }
    item.mediaPath = media.path; item.supported = true; delete item.reason;
    return { item, fingerprint: fingerprint(media.info), directory, workshopId };
  }

  async function discoverLibrary(options = {}) {
    const explicit = Object.prototype.hasOwnProperty.call(options, 'installPath') && options.installPath !== undefined;
    let installation;
    if (explicit) {
      installation = await isInstallation(options.installPath);
      if (!installation) throw error('WE_INVALID_FOLDER');
    }
    const initial = [...await registryRoots(), ...defaultRoots].filter(safeAbsolute);
    const libraries = new Set();
    const addLibrary = value => { if (safeAbsolute(value) && libraries.size < 64) libraries.add(path.resolve(value)); };
    if (installation) {
      const common = path.dirname(installation), steamapps = path.dirname(common);
      if (path.basename(common).toLowerCase() === 'common' && path.basename(steamapps).toLowerCase() === 'steamapps') addLibrary(path.dirname(steamapps));
    }
    for (const root of initial.slice(0, 8)) {
      try {
        const checked = (await noLinks(root, true)).path;
        addLibrary(checked);
        try { for (const library of parseLibraries(await boundedRead(path.join(checked, 'steamapps', 'libraryfolders.vdf'), MAX_METADATA))) addLibrary(library); } catch { /* A default library works without a VDF. */ }
      } catch { /* Ignore absent registry/default entries. */ }
    }
    const roots = [], rootKeys = new Set();
    async function addRoot(candidate, workshop) {
      try {
        const root = (await noLinks(candidate, true)).path, key = process.platform === 'win32' ? root.toLowerCase() : root;
        if (!rootKeys.has(key)) { rootKeys.add(key); roots.push({ root, workshop }); }
      } catch { /* Uninstalled or unsafe optional library. */ }
    }
    for (const library of libraries) {
      const candidate = await isInstallation(path.join(library, 'steamapps', 'common', 'wallpaper_engine'));
      if (!installation && candidate) installation = candidate;
      await addRoot(path.join(library, 'steamapps', 'workshop', 'content', '431960'), true);
    }
    if (installation) {
      await addRoot(path.join(installation, 'projects', 'myprojects'), false);
      await addRoot(path.join(installation, 'projects', 'defaultprojects'), false);
    }
    const projects = [];
    let skipped = 0, truncated = false;
    outer: for (const { root, workshop } of roots) {
      try {
        const directory = await fs.opendir(root);
        for await (const entry of directory) {
          if (entry.isSymbolicLink()) { skipped++; continue; }
          if (!entry.isDirectory() || (workshop && !/^\d{1,20}$/.test(entry.name))) continue;
          if (projects.length >= MAX_ITEMS) { truncated = true; break outer; }
          projects.push({ directory: path.join(root, entry.name), workshopId: workshop ? entry.name : undefined });
        }
      } catch { skipped++; }
    }
    const items = new Array(projects.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, projects.length) }, async () => {
      while (next < projects.length) {
        const index = next++, project = projects[index];
        const record = await inspectProject(project.directory, project.workshopId);
        const item = Object.freeze(record.item); records.set(item, record); items[index] = item;
      }
    }));
    items.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    return { installPath: installation || null, items, skipped, truncated };
  }

  async function resolveMedia(item) {
    const record = item && typeof item === 'object' ? records.get(item) : undefined;
    if (!record) throw error('WE_CHANGED');
    if (!record.item.supported) throw error(record.item.reason === 'too-large' ? 'WE_TOO_LARGE' : 'WE_UNSUPPORTED');
    const current = await inspectProject(record.directory, record.workshopId);
    if (!current.item.supported || current.item.type !== record.item.type || current.item.mediaPath !== record.item.mediaPath || current.fingerprint !== record.fingerprint) throw error('WE_CHANGED');
    return current.item.mediaPath;
  }
  return { discoverLibrary, resolveMedia };
}

function buildWorkshopSearchUrl(query = '') {
  const url = new URL('https://steamcommunity.com/workshop/browse/');
  url.searchParams.set('appid', '431960');
  url.searchParams.set('searchtext', String(query).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200));
  url.searchParams.set('browsesort', 'textsearch');
  url.searchParams.set('section', 'readytouseitems');
  return url.href;
}

const library = createWallpaperEngine();
module.exports = { ...library, createWallpaperEngine, buildWorkshopSearchUrl, parseLibraries };
