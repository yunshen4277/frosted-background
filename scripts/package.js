#!/usr/bin/env node
'use strict';

// No build step or runtime dependencies are required by the extension itself.
// Run npm install once for development, or pass --modules /path/to/node_modules.
const fs = require('node:fs/promises');
const path = require('node:path');

function getJSZip(args) {
  const index = args.indexOf('--modules');
  if (index !== -1) {
    if (!args[index + 1]) throw new Error('--modules requires a node_modules directory.');
    return require(path.join(path.resolve(args[index + 1]), 'jszip'));
  }
  try {
    return require('jszip');
  } catch {
    throw new Error('JSZip is needed only to package the extension. Run npm install, set NODE_PATH, or pass --modules <node_modules>.');
  }
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[character]);
}

function manifestFor(pkg) {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(pkg.name)}" Version="${xml(pkg.version)}" Publisher="${xml(pkg.publisher)}" />
    <DisplayName>${xml(pkg.displayName || pkg.name)}</DisplayName>
    <Description xml:space="preserve">${xml(pkg.description || '')}</Description>
    <Tags>${xml((pkg.keywords || []).join(','))}</Tags>
    <Categories>${xml((pkg.categories || []).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${xml((pkg.extensionKind || ['ui']).join(','))}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="${xml(pkg.homepage || '')}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${xml(pkg.repository?.url || '')}" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE</License>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="css" ContentType="text/css" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Override PartName="/extension/LICENSE" ContentType="text/plain" />
</Types>
`;

async function listFiles(directory, relative = '') {
  const files = [];
  const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (['node_modules', '.git', 'work', 'outputs', '.DS_Store'].includes(entry.name)) continue;
    if (/\.(vsix|zip|tmp|log)$/i.test(entry.name)) continue;
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(directory, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Refusing to package symbolic link or special file: ${name}`);
  }
  return files;
}

async function main(args = process.argv.slice(2)) {
  const JSZip = getJSZip(args);
  const root = path.resolve(__dirname, '..');
  const outIndex = args.indexOf('--out');
  if (outIndex !== -1 && !args[outIndex + 1]) throw new Error('--out requires a directory.');
  const output = outIndex === -1 ? path.dirname(root) : path.resolve(args[outIndex + 1]);
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  for (const field of ['name', 'version', 'publisher']) {
    if (typeof pkg[field] !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(pkg[field])) {
      throw new Error(`Invalid or missing package ${field}.`);
    }
  }
  if (!pkg.engines?.vscode || !pkg.main) throw new Error('Missing VS Code engine or extension entry point.');
  const files = await listFiles(root);
  const packaged = files.filter(name =>
    ['package.json', 'package.nls.json', 'package.nls.zh-cn.json', 'README.md', 'LICENSE', 'CHANGELOG.md'].includes(name)
    || name.startsWith('src/') || name.startsWith('media/'));
  const required = ['package.json', 'README.md', 'LICENSE', pkg.main.replace(/^\.\//, ''), 'media/renderer.js',
    'src/panel.js', 'src/panel-ui.js', 'media/panel.js', 'media/panel.css', 'media/background-icon.svg', 'src/updater.js', 'src/github-update.js'];
  for (const file of required) {
    if (!packaged.includes(file)) throw new Error(`Missing package file: ${file}`);
  }
  const vsix = new JSZip();
  const source = new JSZip();
  // A fixed entry timestamp keeps unchanged packages reproducible.
  const options = { date: new Date('2026-01-01T00:00:00.000Z'), unixPermissions: 0o100644 };
  vsix.file('extension.vsixmanifest', manifestFor(pkg), options);
  vsix.file('[Content_Types].xml', contentTypes, options);
  for (const name of files) {
    const bytes = await fs.readFile(path.join(root, name));
    source.file(`${pkg.name}/${name}`, bytes, options);
    if (packaged.includes(name)) vsix.file(`extension/${name}`, bytes, options);
  }
  await fs.mkdir(output, { recursive: true });
  const basename = `${pkg.name}-${pkg.version}`;
  const generate = { type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 }, platform: 'UNIX' };
  const vsixPath = path.join(output, `${basename}.vsix`);
  const sourcePath = path.join(output, `${basename}-source.zip`);
  await fs.writeFile(vsixPath, await vsix.generateAsync(generate));
  await fs.writeFile(sourcePath, await source.generateAsync(generate));
  console.log(`VSIX: ${vsixPath}`);
  console.log(`Source: ${sourcePath}`);
  console.log(`Extension files: ${packaged.length}; source files: ${files.length}`);
  return { vsixPath, sourcePath };
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { main, manifestFor, listFiles };
