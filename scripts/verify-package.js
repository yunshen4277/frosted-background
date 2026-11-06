#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { manifestFor } = require('./package');

async function main() {
  const args = process.argv.slice(2);
  const modulesIndex = args.indexOf('--modules');
  const JSZip = modulesIndex === -1 ? require('jszip') : require(path.join(path.resolve(args[modulesIndex + 1]), 'jszip'));
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const file = args.find((value, index) => !value.startsWith('--') && args[index - 1] !== '--modules')
    || path.join(path.dirname(root), `${pkg.name}-${pkg.version}.vsix`);
  const archive = await JSZip.loadAsync(await fs.readFile(file), { checkCRC32: true });
  for (const required of ['extension.vsixmanifest', '[Content_Types].xml', 'extension/package.json',
    'extension/package.nls.json', 'extension/package.nls.zh-cn.json', 'extension/package.nls.es.json',
    'extension/README.md', 'extension/LICENSE', `extension/${pkg.main.replace(/^\.\//, '')}`,
    'extension/src/patcher.js', 'extension/media/renderer.js', 'extension/media/video-player.js',
    'extension/src/panel.js', 'extension/src/panel-ui.js', 'extension/media/panel.js', 'extension/media/panel.css',
    'extension/media/background-icon.svg', 'extension/src/updater.js', 'extension/src/github-update.js',
    'extension/src/localization.js', 'extension/media/i18n.js', 'extension/media/regions.js',
    'extension/src/remote-media.js', 'extension/src/youtube-media.js', 'extension/src/youtube-tools.js', 'extension/media/source.js', 'extension/media/webm-player.js', 'extension/media/vendor/hls.min.js', 'extension/media/vendor/HLS-LICENSE.txt']) {
    assert.ok(archive.file(required), `Missing ${required}`);
  }
  const packedPkg = JSON.parse(await archive.file('extension/package.json').async('string'));
  assert.equal(packedPkg.name, pkg.name);
  assert.equal(packedPkg.version, pkg.version);
  assert.equal(packedPkg.publisher, pkg.publisher);
  const catalog = JSON.parse(await archive.file('extension/package.nls.json').async('string'));
  assert.equal(await archive.file('extension.vsixmanifest').async('string'), manifestFor(packedPkg, catalog), 'VSIX metadata must resolve the default language strings');
  assert.ok(packedPkg.contributes.views.frostedBackground.some(view => view.id === 'frostedBackground.controls' && view.type === 'webview'));
  assert.ok(!Object.keys(archive.files).some(name => /(^|\/)node_modules\//.test(name)), 'Runtime archive must not contain node_modules');
  for (const name of Object.keys(archive.files)) {
    if (archive.files[name].dir || !name.startsWith('extension/')) continue;
    const sourceName = name.slice('extension/'.length);
    const original = await fs.readFile(path.join(root, sourceName));
    assert.deepEqual(await archive.file(name).async('nodebuffer'), original, `${sourceName} differs from source`);
  }
  console.log(`Verified ${pkg.publisher}.${pkg.name}@${pkg.version}: ${file}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
