'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UpdateController } = require('../src/updater');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve));
}

function harness(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frosted-updater-test-'));
  const state = new Map(Object.entries(options.state || {}));
  const configuration = { updateMode: options.mode || 'automatic' };
  const timers = new Map();
  const calls = { find: [], download: [], command: [], info: [], warning: [], error: [], changes: [], log: [], writes: [], configuration: [], exclusive: 0 };
  const now = options.now || 1780000000000;
  const release = {
    version: '0.3.1',
    assetUrl: 'https://github.com/example/frosted-background/releases/download/v0.3.1/frosted-background-0.3.1.vsix',
    manifestUrl: 'https://github.com/example/frosted-background/releases/download/v0.3.1/update-manifest.json',
    pageUrl: 'https://github.com/example/frosted-background/releases/tag/v0.3.1',
  };
  const filePath = path.join(directory, 'updates', 'verified-update.vsix');
  const uri = filename => ({ scheme: 'file', fsPath: filename, path: filename.replace(/\\/g, '/'), toString: () => 'file:///' + filename.replace(/\\/g, '/') });
  const vscode = {
    version: '1.144.1',
    UIKind: { Desktop: 1, Web: 2 },
    ConfigurationTarget: { Global: 1 },
    ProgressLocation: { Notification: 15 },
    env: { uiKind: 1 },
    Uri: { file: uri },
    workspace: {
      textDocuments: [{ isDirty: true }],
      getConfiguration: () => ({
        get: (key, fallback) => configuration[key] ?? fallback,
        update: async (key, value, target) => { configuration[key] = value; calls.configuration.push({ key, value, target }); },
      }),
    },
    window: {
      showInformationMessage: async (...args) => {
        calls.info.push(args);
        return typeof options.info === 'function' ? options.info(...args) : options.info;
      },
      showErrorMessage: async (...args) => { calls.error.push(args); },
      showWarningMessage: async (...args) => { calls.warning.push(args); },
      withProgress: async (_configuration, callback) => callback({ report() {} }),
    },
    commands: {
      executeCommand: async (name, ...args) => {
        calls.command.push([name, ...args]);
        if (name === 'workbench.extensions.installExtension' && options.install) return options.install(...args);
      },
    },
  };
  const context = {
    subscriptions: [],
    globalStorageUri: uri(directory),
    globalState: {
      get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
      update: async (key, value) => { calls.writes.push([key, value]); state.set(key, value); },
    },
  };
  const services = {
    now: () => now,
    setTimeout: (callback, delay) => {
      const timer = { unref() {} };
      timers.set(timer, { callback, delay });
      return timer;
    },
    clearTimeout: timer => timers.delete(timer),
    findRelease: async argument => {
      calls.find.push(argument);
      if (options.find) return options.find(argument);
      return Object.hasOwn(options, 'release') ? options.release : release;
    },
    downloadRelease: async argument => {
      calls.download.push(argument);
      if (options.download) return options.download(argument);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'verified VSIX fixture');
      return { filePath, version: release.version, engines: { vscode: '^1.90.0' } };
    },
  };
  const controller = new UpdateController(vscode, context, {
    repository: options.repository === undefined ? 'example/frosted-background' : options.repository,
    extensionId: 'local-frosted.frosted-background', currentVersion: '0.3.0',
    log: error => calls.log.push(error),
    onChange: value => calls.changes.push({ ...value }),
    runExclusive: async callback => { calls.exclusive++; return callback(); },
  }, services);
  t.after(() => { controller.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { controller, calls, state, timers, configuration, filePath, directory, release, now };
}

test('an unconfigured repository stays offline even for a manual check', async t => {
  const env = harness(t, { repository: '' });
  env.controller.start();
  await env.controller.check(true);
  assert.equal(env.controller.getState().status, 'unconfigured');
  assert.equal(env.calls.find.length, 0);
  assert.equal(env.calls.download.length, 0);
  assert.equal(env.calls.command.length, 0);
  assert.equal(env.timers.size, 0);
});

test('automatic updates install only the verified local VSIX and never reload on their own', async t => {
  const env = harness(t);
  await env.controller.check();
  await settle();
  assert.equal(env.calls.find.length, 1);
  assert.equal(env.calls.find[0].repository, 'example/frosted-background');
  assert.equal(env.calls.find[0].extensionId, 'local-frosted.frosted-background');
  assert.equal(env.calls.find[0].currentVersion, '0.3.0');
  assert.equal(env.calls.download.length, 1);
  assert.equal(env.calls.download[0].extensionId, 'local-frosted.frosted-background');
  assert.deepEqual(env.calls.download[0].release, env.release);
  assert.equal(env.calls.command.length, 1);
  assert.equal(env.calls.command[0][0], 'workbench.extensions.installExtension');
  assert.equal(env.calls.command[0][1].scheme, 'file');
  assert.equal(env.calls.command[0][1].fsPath, env.filePath);
  assert.equal(env.state.get('pendingUpdateVersion'), '0.3.1');
  assert.equal(env.controller.getState().status, 'pending');
  assert.equal(env.controller.getState().pendingVersion, '0.3.1');
  assert.equal(env.calls.info.some(message => message.includes('重载窗口')), true);
  assert.equal(fs.existsSync(env.filePath), false, 'a consumed update download does not accumulate in the cache');
});

test('pending bookkeeping is written only after VS Code accepts the install', async t => {
  const installation = deferred();
  const env = harness(t, { install: () => installation.promise });
  const checking = env.controller.check();
  await settle();
  assert.equal(env.calls.command[0][0], 'workbench.extensions.installExtension');
  assert.equal(env.state.has('pendingUpdateVersion'), false);
  assert.equal(env.controller.getState().status, 'installing');
  installation.resolve();
  await checking;
  assert.equal(env.state.get('pendingUpdateVersion'), '0.3.1');
});

test('a reload is executed only after the user selects the reload action', async t => {
  const env = harness(t, { info: (...args) => args.includes('重载窗口') ? '重载窗口' : undefined });
  await env.controller.check(true);
  await settle();
  assert.deepEqual(env.calls.command.map(call => call[0]), ['workbench.extensions.installExtension', 'workbench.action.reloadWindow']);
});

test('notify mode reports an available update without downloading when the action is dismissed', async t => {
  const env = harness(t, { mode: 'notify' });
  await env.controller.check(true);
  assert.equal(env.calls.find.length, 1);
  assert.equal(env.calls.download.length, 0);
  assert.equal(env.calls.command.length, 0);
  assert.equal(env.controller.getState().status, 'available');
  assert.equal(env.controller.getState().availableVersion, '0.3.1');
  assert.equal(env.calls.info.some(message => message.includes('安装更新')), true);
});

test('notify mode installs when the user selects install and leaves the reload optional', async t => {
  const env = harness(t, { mode: 'notify', info: (...args) => args.includes('安装更新') ? '安装更新' : undefined });
  await env.controller.check(true);
  await settle();
  assert.equal(env.calls.download.length, 1);
  assert.deepEqual(env.calls.command.map(call => call[0]), ['workbench.extensions.installExtension']);
  assert.equal(env.controller.getState().status, 'pending');
});

test('off mode performs no background checks but permits an explicit manual update', async t => {
  const env = harness(t, { mode: 'off', info: (...args) => args.includes('安装更新') ? '安装更新' : undefined });
  env.controller.start();
  await env.controller.check();
  assert.equal(env.calls.find.length, 0);
  await env.controller.check(true);
  assert.equal(env.calls.find.length, 1);
  assert.equal(env.calls.download.length, 1);
  assert.equal(env.controller.getState().status, 'pending');
});

test('automatic checks honor their interval while manual checks bypass it', async t => {
  const now = 1780000000000;
  const env = harness(t, { now, state: { lastUpdateCheckAt: now - 60000 }, release: null });
  await env.controller.check();
  assert.equal(env.calls.find.length, 0);
  await env.controller.check(true);
  assert.equal(env.calls.find.length, 1);
  assert.equal(env.calls.download.length, 0);
  assert.equal(env.controller.getState().status, 'idle');
});

test('a previously installed pending version is not installed again before activation', async t => {
  const env = harness(t, { state: { pendingUpdateVersion: '0.3.1' } });
  await env.controller.check();
  await env.controller.check(true);
  assert.equal(env.calls.find.length, 0);
  assert.equal(env.calls.download.length, 0);
  assert.equal(env.calls.command.length, 0);
  assert.equal(env.controller.getState().status, 'pending');
});

test('simultaneous update checks cannot download or install twice', async t => {
  const finding = deferred();
  const env = harness(t, { find: () => finding.promise });
  const first = env.controller.check(true);
  const second = env.controller.check(true);
  await settle();
  assert.equal(env.calls.find.length, 1);
  finding.resolve(env.release);
  await Promise.all([first, second]);
  assert.equal(env.calls.download.length, 1);
  assert.equal(env.calls.command.filter(call => call[0] === 'workbench.extensions.installExtension').length, 1);
});

test('failed checks, downloads and installs preserve pending state and allow manual retry', async t => {
  for (const stage of ['find', 'download', 'install']) {
    await t.test(stage, async child => {
      let failing = true;
      let env;
      const operation = async () => {
        if (failing) throw new Error('test update failure');
        if (stage === 'find') return env.release;
        if (stage === 'download') return { filePath: env.filePath, version: '0.3.1', engines: { vscode: '^1.90.0' } };
      };
      env = harness(child, { [stage]: operation });
      await env.controller.check(true).catch(() => {});
      assert.equal(env.controller.getState().status, 'error');
      assert.equal(env.state.has('pendingUpdateVersion'), false);
      assert.equal(env.calls.command.some(call => call[0] === 'workbench.action.reloadWindow'), false);
      failing = false;
      await env.controller.check(true);
      assert.equal(env.controller.getState().status, 'pending');
      assert.equal(env.state.get('pendingUpdateVersion'), '0.3.1');
    });
  }
});

test('disposing during a check prevents a late download or installation', async t => {
  const finding = deferred();
  const env = harness(t, { find: () => finding.promise });
  const checking = env.controller.check(true);
  await settle();
  env.controller.dispose();
  finding.resolve(env.release);
  await checking.catch(() => {});
  assert.equal(env.calls.download.length, 0);
  assert.equal(env.calls.command.length, 0);
  assert.equal(env.state.has('pendingUpdateVersion'), false);
});

test('disposing during download prevents installation even when the download later resolves', async t => {
  const downloading = deferred();
  const env = harness(t, { download: () => downloading.promise });
  const checking = env.controller.check(true);
  await settle();
  assert.equal(env.calls.download.length, 1);
  env.controller.dispose();
  downloading.resolve({ filePath: env.filePath, version: '0.3.1', engines: { vscode: '^1.90.0' } });
  await checking.catch(() => {});
  assert.equal(env.calls.command.length, 0);
  assert.equal(env.state.has('pendingUpdateVersion'), false);
});

test('mode changes are stored globally and disposal clears scheduled work', async t => {
  const env = harness(t);
  env.controller.start();
  assert.ok(env.timers.size > 0);
  assert.ok([...env.timers.values()].some(timer => timer.delay === 30000));
  await env.controller.setMode('off');
  assert.equal(env.configuration.updateMode, 'off');
  assert.equal(env.calls.configuration.at(-1).target, 1);
  assert.equal(env.controller.getState().mode, 'off');
  env.controller.dispose();
  assert.equal(env.timers.size, 0);
});

test('turning automatic updates off during a background check prevents the later download', async t => {
  const finding = deferred();
  const env = harness(t, { find: () => finding.promise });
  const checking = env.controller.check();
  await settle();
  await env.controller.setMode('off');
  finding.resolve(env.release);
  await checking;
  assert.equal(env.calls.download.length, 0);
  assert.equal(env.calls.command.length, 0);
  assert.equal(env.state.has('pendingUpdateVersion'), false);
});

test('turning automatic updates off during a download prevents a late installation', async t => {
  const downloading = deferred();
  const env = harness(t, { download: () => downloading.promise });
  const checking = env.controller.check();
  await settle();
  await env.controller.setMode('off');
  downloading.resolve({ filePath: env.filePath, version: '0.3.1', engines: { vscode: '^1.90.0' } });
  await checking;
  assert.equal(env.calls.command.length, 0);
  assert.equal(env.state.has('pendingUpdateVersion'), false);
});

test('a failed VSIX installation removes its verified download without deleting unrelated cache files', async t => {
  const env = harness(t, { install: async () => { throw new Error('Installation rejected'); } });
  fs.mkdirSync(path.dirname(env.filePath), { recursive: true });
  const unrelated = path.join(path.dirname(env.filePath), 'keep.txt');
  fs.writeFileSync(unrelated, 'user-owned file');
  await env.controller.check(true);
  assert.equal(env.controller.getState().status, 'error');
  assert.equal(fs.existsSync(env.filePath), false, 'failed attempts do not retain one VSIX each');
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'user-owned file');
});

test('background update failures update status and logs without showing warning notifications', async t => {
  const env = harness(t, { find: async () => { throw new Error('Offline'); } });
  await env.controller.check();
  assert.equal(env.controller.getState().status, 'error');
  assert.equal(env.calls.log.length, 1);
  assert.equal(env.calls.warning.length, 0);
  assert.equal(env.calls.error.length, 0);
  assert.equal(env.calls.command.length, 0);
});
