'use strict';

const test = require('node:test');
const { boundManifest } = require('../scripts/bind-repository');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { validateRelease, resolveReleaseTag, createReleaseManifest, parseArguments } = require('../scripts/release-manifest');

const PACKAGE = { name: 'frosted-background', publisher: 'local-frosted', version: '0.3.0' };

test('manual main releases derive the stable package tag while tag runs verify the actual tag', () => {
  assert.equal(resolveReleaseTag(PACKAGE, { eventName: 'workflow_dispatch', refType: 'branch', refName: 'main' }), 'v0.3.0');
  assert.equal(resolveReleaseTag(PACKAGE, { eventName: 'push', refType: 'tag', refName: 'v0.3.0' }), 'v0.3.0');
  assert.equal(resolveReleaseTag(PACKAGE, { eventName: 'workflow_dispatch', refType: 'tag', refName: 'v0.3.0' }), 'v0.3.0');
  for (const context of [
    { eventName: 'workflow_dispatch', refType: 'branch', refName: 'feature/release' },
    { eventName: 'push', refType: 'branch', refName: 'main' },
    { eventName: 'pull_request', refType: 'tag', refName: 'v0.3.0' },
    { eventName: 'workflow_dispatch', refType: 'unknown', refName: 'main' },
  ]) assert.throws(() => resolveReleaseTag(PACKAGE, context), /only allowed/);
  assert.throws(() => resolveReleaseTag(PACKAGE, { eventName: 'push', refType: 'tag', refName: 'v0.2.0' }), /exactly match/);
  assert.throws(() => resolveReleaseTag({ ...PACKAGE, version: '0.4.0-beta' }, { eventName: 'workflow_dispatch', refType: 'branch', refName: 'main' }), /stable semantic/);
});

test('release binding preserves extension identity and binds only an explicit GitHub repository', () => {
  const bound = boundManifest(PACKAGE, 'example-owner/frosted-background');
  assert.equal(bound.name, PACKAGE.name);
  assert.equal(bound.publisher, PACKAGE.publisher);
  assert.equal(bound.version, PACKAGE.version);
  assert.deepEqual(bound.frostedBackgroundUpdates, { repository: 'example-owner/frosted-background' });
  assert.equal(bound.repository.url, 'https://github.com/example-owner/frosted-background.git');
  assert.equal(PACKAGE.repository, undefined);
  for (const value of ['', undefined, 'https://github.com/a/b', 'a/../b', 'a/..', 'a/b?x=1', 'a/b\n']) {
    assert.throws(() => boundManifest(PACKAGE, value));
  }
});

test('release tags must exactly match the stable package version and existing extension identity', () => {
  assert.deepEqual(validateRelease(PACKAGE, 'v0.3.0'), {
    version: '0.3.0', extensionId: 'local-frosted.frosted-background', assetName: 'frosted-background-0.3.0.vsix',
  });
  for (const tag of [undefined, '', 'main', '0.3.0', 'v0.2.0', 'v0.3.0-beta.1', 'v0.3.0\n']) {
    assert.throws(() => validateRelease(PACKAGE, tag), /exactly match/);
  }
  for (const version of ['0.3.0-beta.1', '0.3.0+build', '01.3.0', '0.3', '../0.3.0', '0.3.0\n', 3]) {
    assert.throws(() => validateRelease({ ...PACKAGE, version }, `v${version}`), /stable semantic/);
  }
  assert.throws(() => validateRelease({ ...PACKAGE, publisher: 'new-publisher' }, 'v0.3.0'), /identity/);
});

test('update manifest contains the real package checksum and changes when the VSIX changes', async t => {
  const directory = await fs.mkdtemp(path.join(process.env.FROSTED_TEST_TMP || os.tmpdir(), 'frosted-release-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const packageFile = path.join(directory, 'package.json');
  const assetPath = path.join(directory, 'frosted-background-0.3.0.vsix');
  await fs.writeFile(packageFile, JSON.stringify(PACKAGE));
  const bytes = Buffer.from('A fixture payload whose exact bytes must be verified.\0', 'utf8');
  await fs.writeFile(assetPath, bytes);
  const result = await createReleaseManifest({ packageFile, assetDirectory: directory, tag: 'v0.3.0' });
  assert.deepEqual(result.manifest, {
    version: '0.3.0', extensionId: 'local-frosted.frosted-background', assetName: path.basename(assetPath),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  assert.deepEqual(JSON.parse(await fs.readFile(result.manifestPath, 'utf8')), result.manifest);
  assert.match(result.manifest.sha256, /^[a-f0-9]{64}$/);
  await fs.appendFile(assetPath, 'changed');
  const changed = await createReleaseManifest({ packageFile, assetDirectory: directory, tag: 'v0.3.0' });
  assert.notEqual(changed.manifest.sha256, result.manifest.sha256);
  assert.equal((await fs.readdir(directory)).some(name => name.includes('.tmp-')), false);
});

test('manifest creation fails closed for missing, empty, or mismatched release assets', async t => {
  const directory = await fs.mkdtemp(path.join(process.env.FROSTED_TEST_TMP || os.tmpdir(), 'frosted-release-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const packageFile = path.join(directory, 'package.json');
  await fs.writeFile(packageFile, JSON.stringify(PACKAGE));
  const options = { packageFile, assetDirectory: directory, tag: 'v0.3.0' };
  await assert.rejects(createReleaseManifest(options), { code: 'ENOENT' });
  await fs.writeFile(path.join(directory, 'frosted-background-0.3.0.vsix'), '');
  await assert.rejects(createReleaseManifest(options), /nonempty regular file/);
  await assert.rejects(createReleaseManifest({ ...options, tag: 'v0.4.0' }), /exactly match/);
  await assert.rejects(fs.stat(path.join(directory, 'update-manifest.json')), { code: 'ENOENT' });
});

test('release CLI rejects ambiguous or incomplete arguments', () => {
  assert.deepEqual(parseArguments(['--tag', 'v0.3.0', '--out', 'release files', '--validate-only']), {
    tag: 'v0.3.0', out: 'release files', validateOnly: true,
  });
  assert.throws(() => parseArguments(['--tag']), /requires a value/);
  assert.throws(() => parseArguments(['--out', '--validate-only']), /requires a value/);
  assert.throws(() => parseArguments(['--publish']), /Unknown argument/);
});
