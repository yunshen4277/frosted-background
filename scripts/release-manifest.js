#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const EXTENSION_ID = 'local-frosted.frosted-background';
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function validateRelease(pkg, tag) {
  if (!pkg || typeof pkg.version !== 'string' || pkg.version.trim() !== pkg.version || !STABLE_VERSION.test(pkg.version)) {
    throw new Error('Only stable semantic versions such as 0.3.0 can be released.');
  }
  const extensionId = `${pkg.publisher}.${pkg.name}`;
  if (extensionId !== EXTENSION_ID) {
    throw new Error(`Extension identity must remain ${EXTENSION_ID} so existing installations can update.`);
  }
  if (typeof tag !== 'string' || tag !== `v${pkg.version}`) {
    throw new Error(`Release tag must exactly match package.json: v${pkg.version}.`);
  }
  return {
    version: pkg.version,
    extensionId,
    assetName: `frosted-background-${pkg.version}.vsix`,
  };
}

function resolveReleaseTag(pkg, { eventName, refType, refName }) {
  let tag;
  if (refType === 'tag' && ['push', 'workflow_dispatch'].includes(eventName)) tag = refName;
  else if (eventName === 'workflow_dispatch' && refType === 'branch' && refName === 'main') tag = `v${pkg?.version}`;
  else throw new Error('Release is only allowed from a stable version tag or a manual run on main.');
  validateRelease(pkg, tag);
  return tag;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function createReleaseManifest({ packageFile, assetDirectory, tag }) {
  const pkg = JSON.parse(await fsp.readFile(packageFile, 'utf8'));
  const metadata = validateRelease(pkg, tag);
  const assetPath = path.join(assetDirectory, metadata.assetName);
  const info = await fsp.lstat(assetPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) {
    throw new Error('The release VSIX must be a nonempty regular file in the asset directory.');
  }
  const manifest = { ...metadata, sha256: await sha256File(assetPath) };
  const manifestPath = path.join(assetDirectory, 'update-manifest.json');
  const temporary = `${manifestPath}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await fsp.writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    await fsp.rename(temporary, manifestPath);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
  return { manifest, manifestPath, assetPath };
}

function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--validate-only') result.validateOnly = true;
    else if (arg === '--resolve-ci-tag') result.resolveCiTag = true;
    else if (arg === '--tag' || arg === '--out') {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${arg} requires a value.`);
      result[arg.slice(2)] = args[++index];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const root = path.resolve(__dirname, '..');
  const packageFile = path.join(root, 'package.json');
  const pkg = JSON.parse(await fsp.readFile(packageFile, 'utf8'));
  if (options.resolveCiTag) {
    const tag = resolveReleaseTag(pkg, { eventName: process.env.GITHUB_EVENT_NAME, refType: process.env.GITHUB_REF_TYPE, refName: process.env.GITHUB_REF_NAME });
    console.log(tag);
    return tag;
  }
  // Explicit tag is required outside Actions; a branch name can never become a release.
  const tag = options.tag || (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined);
  const metadata = validateRelease(pkg, tag);
  if (options.validateOnly) {
    console.log(`Validated ${tag}: ${metadata.extensionId}@${metadata.version}`);
    return metadata;
  }
  const result = await createReleaseManifest({
    packageFile,
    assetDirectory: options.out ? path.resolve(options.out) : path.dirname(root),
    tag,
  });
  console.log(`Update manifest: ${result.manifestPath}`);
  console.log(`SHA-256: ${result.manifest.sha256}`);
  return result;
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { EXTENSION_ID, validateRelease, resolveReleaseTag, sha256File, createReleaseManifest, parseArguments, main };
