'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../package.json');
const english = require('../package.nls.json');
const chinese = require('../package.nls.zh-cn.json');
const spanish = require('../package.nls.es.json');
const { manifestFor, selectPackageFiles } = require('../scripts/package');
const { t, describeError } = require('../src/localization');

test('YouTube helper and resolver diagnostics and progress have complete native translations', () => {
  const keys = new Set([
    '正在准备 YouTube 背景…', '首次使用正在准备 YouTube 辅助工具…',
    '正在读取 YouTube 视频…', '正在缓存 YouTube 背景视频…',
  ]);
  for (const name of ['youtube-tools.js', 'youtube-media.js']) {
    const source = fs.readFileSync(path.resolve(__dirname, '../src', name), 'utf8');
    const diagnostics = [...source.matchAll(/\berror\('([^']*[\u3400-\u9fff][^']*)'\)/gu)].map(match => match[1]);
    assert.ok(diagnostics.length > 0, `${name} diagnostics are included in the coverage scan`);
    for (const key of diagnostics) keys.add(key);
  }
  for (const key of keys) {
    assert.equal(t('zh-CN', key), key);
    for (const language of ['en', 'es']) {
      const translated = t(language, key);
      assert.notEqual(translated, key, `${language} translation is missing: ${key}`);
      assert.doesNotMatch(translated, /[\u3400-\u9fff]/u, `${language} contains untranslated Chinese: ${key}`);
      assert.equal(describeError(language, Object.assign(new Error(key), { localizationKey: key })), translated, 'native error presentation uses the selected language');
    }
  }
});

test('every visible manifest label has complete English, Chinese and Spanish translations', () => {
  const fields = [pkg.displayName, pkg.description, pkg.contributes.configuration.title];
  for (const command of pkg.contributes.commands) fields.push(command.title, command.category);
  for (const containers of Object.values(pkg.contributes.viewsContainers)) {
    for (const container of containers) fields.push(container.title);
  }
  for (const views of Object.values(pkg.contributes.views)) {
    for (const view of views) fields.push(view.name);
  }
  for (const property of Object.values(pkg.contributes.configuration.properties)) {
    fields.push(property.description, ...(property.enumDescriptions || []));
    if (property.enum) assert.equal(property.enumDescriptions.length, property.enum.length, 'every choice has a translated explanation');
  }
  const keys = new Set();
  for (const value of fields) {
    assert.match(value, /^%[^%]+%$/, `Manifest UI string must use an NLS key: ${value}`);
    keys.add(value.slice(1, -1));
  }
  for (const [locale, catalog] of Object.entries({ en: english, 'zh-CN': chinese, es: spanish })) {
    assert.deepEqual(Object.keys(catalog).sort(), [...keys].sort(), `${locale} has exactly the used manifest keys`);
    for (const [key, value] of Object.entries(catalog)) {
      assert.equal(typeof value, 'string', `${locale}.${key}`);
      assert.ok(value.trim(), `${locale}.${key} must not be blank`);
      assert.doesNotMatch(value, /^%[^%]+%$/, `${locale}.${key} must be translated`);
    }
  }
  assert.equal(english['extension.displayName'], 'Frosted Background');
  assert.ok(Object.values(english).every(value => !/[\u3400-\u9fff]/u.test(value)), 'the default catalog is English');
  assert.ok(!Object.keys(pkg.contributes.configuration.properties).some(key => /language|locale/i.test(key)), 'panel language is persisted separately, not as a workspace setting');
});

test('VSIX metadata resolves default catalog strings and escapes the translated XML values', () => {
  const manifest = manifestFor(pkg);
  assert.match(manifest, /<DisplayName>Frosted Background<\/DisplayName>/);
  assert.ok(manifest.includes(english['extension.description']));
  assert.doesNotMatch(manifest, /%extension\./);
  const translated = manifestFor({ ...pkg, displayName: '%name%', description: '%description%' }, {
    name: 'Glass & <Code>', description: 'A "quoted" description',
  });
  assert.ok(translated.includes('<DisplayName>Glass &amp; &lt;Code&gt;</DisplayName>'));
  assert.ok(translated.includes('A &quot;quoted&quot; description'));
  const literal = manifestFor({ ...pkg, displayName: 'Literal Name', description: 'Literal description' });
  assert.ok(literal.includes('<DisplayName>Literal Name</DisplayName>'), 'existing manifestFor(pkg) callers with literal metadata remain supported');
  assert.throws(() => manifestFor(pkg, {}), /Missing default localization: extension\.displayName/);
});

test('packaging requires all localization catalogs, translators and the shared regions runtime', () => {
  const localization = ['package.nls.json', 'package.nls.zh-cn.json', 'package.nls.es.json', 'src/localization.js', 'media/i18n.js', 'media/regions.js', 'src/remote-media.js', 'src/youtube-tools.js', 'src/youtube-media.js', 'media/source.js', 'media/vendor/hls.min.js', 'media/vendor/HLS-LICENSE.txt'];
  const files = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'src/extension.js', 'src/patcher.js',
    'src/panel.js', 'src/panel-ui.js', 'src/updater.js', 'src/github-update.js', 'media/renderer.js', 'media/video-player.js',
    'media/panel.js', 'media/panel.css', 'media/background-icon.svg', ...localization,
    'test/localization-package.test.js', 'test/fixtures/edges.webm', 'scripts/package.js'];
  const selected = selectPackageFiles(files, pkg);
  for (const file of localization) assert.ok(selected.includes(file), `${file} is shipped in the VSIX`);
  assert.ok(!selected.some(file => file.startsWith('test/') || file.startsWith('scripts/')), 'development tools and media fixtures remain outside the runtime package');
  for (const missing of localization) {
    assert.throws(() => selectPackageFiles(files.filter(file => file !== missing), pkg), { message: `Missing package file: ${missing}` });
  }
});
