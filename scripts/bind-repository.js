#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function boundManifest(pkg, repository) {
  if (typeof repository !== 'string' || repository.trim() !== repository || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) {
    throw new Error('Provide the publishing GitHub repository as owner/repository.');
  }
  const [owner, name] = repository.split('/');
  if (owner.includes('--') || ['.', '..'].includes(name)) throw new Error('Invalid GitHub repository.');
  const url = 'https://github.com/' + repository;
  return { ...pkg, repository: { type: 'git', url: url + '.git' }, homepage: url + '#readme',
    bugs: { url: url + '/issues' }, frostedBackgroundUpdates: { repository } };
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/bind-repository.js owner/repository');
  const file = path.resolve(__dirname, '../package.json');
  const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
  const bound = boundManifest(pkg, process.argv[2]);
  await fs.writeFile(file, JSON.stringify(bound, null, 2) + '\n');
  console.log('Update source bound to ' + bound.frostedBackgroundUpdates.repository);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { boundManifest };
