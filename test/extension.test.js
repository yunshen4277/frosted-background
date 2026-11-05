'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DEFAULTS } = require('../src/config');

const extensionFile = path.resolve(__dirname, '../src/extension.js');
const extensionSource = fs.readFileSync(extensionFile, 'utf8');

function harness(options = {}) {
  const handlers = new Map();
  const state = new Map(Object.entries({ language: 'zh-CN', lastAppliedExtensionVersion: '0.2.0', ...(options.state || {}) }));
  const configuration = { ...(options.config || {}) };
  const timers = new Map();
  const calls = { apply: [], reapply: [], updateConfig: [], restore: [], status: [], open: [], warning: [], info: [], error: [], command: [], state: [], progress: [], log: [], configurationWrites: [], providers: [], statusBars: [] };
  const uri = file => ({ scheme: 'file', fsPath: file, path: file.replace(/\\/g, '/'), toString: () => 'file:///' + file.replace(/\\/g, '/') });
  const context = {
    subscriptions: [],
    extensionUri: uri(path.resolve(path.dirname(extensionFile), '..')),
    extension: { packageJSON: { version: options.version || '0.2.0' } },
    asAbsolutePath: name => path.resolve(path.dirname(extensionFile), '..', name),
    globalState: {
      get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
      update: async (key, value) => { calls.state.push([key, value]); state.set(key, value); }
    }
  };
  const patcher = {
    updateConfig: async data => {
      calls.updateConfig.push(data);
      if (options.updateConfig) return options.updateConfig(data);
      return { workbenchPath: 'test/workbench.html', liveProtocol: 1 };
    },
    apply: async data => {
      calls.apply.push(data);
      if (options.apply) return options.apply(data);
      return { workbenchPath: 'test/workbench.html' };
    },
    reapply: async data => {
      calls.reapply.push(data);
      if (options.reapply) return options.reapply(data);
      return { workbenchPath: 'test/workbench.html' };
    },
    restore: async data => {
      calls.restore.push(data);
      if (options.restore) return options.restore(data);
      return { workbenchPath: 'test/workbench.html' };
    },
    status: async data => {
      calls.status.push(data);
      if (options.status) return options.status(data);
      return { installed: options.installed ?? true, liveProtocol: options.liveProtocol, workbenchPath: 'test/workbench.html' };
    }
  };
  const vscode = {
    UIKind: { Desktop: 1, Web: 2 },
    ProgressLocation: { Notification: 15 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    version: '1.144.1',
    env: { uiKind: options.web ? 2 : 1, appRoot: 'test/app-root', sessionId: options.sessionId || 'test-window-session' },
    Uri: { file: uri, joinPath: (base, ...segments) => uri(path.join(base.fsPath, ...segments)) },
    commands: {
      registerCommand: (name, callback) => { handlers.set(name, callback); return { dispose() {} }; },
      executeCommand: async (name, ...args) => {
        calls.command.push([name, ...args]);
        if (handlers.has(name)) return handlers.get(name)(...args);
      }
    },
    window: {
      registerWebviewViewProvider: (id, provider, settings) => {
        calls.providers.push({ id, provider, settings });
        return { dispose() {} };
      },
      createStatusBarItem: (alignment, priority) => {
        const item = { alignment, priority, visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
        calls.statusBars.push(item);
        return item;
      },
      createOutputChannel: () => ({ appendLine: line => calls.log.push(line), show() {}, dispose() {} }),
      showOpenDialog: async config => { calls.open.push(config); return options.files; },
      showWarningMessage: async (...args) => { calls.warning.push(args); return options.consent; },
      showInformationMessage: async (...args) => {
        calls.info.push(args);
        return typeof options.info === 'function' ? options.info(...args) : options.info;
      },
      showErrorMessage: async (...args) => { calls.error.push(args); return undefined; },
      showQuickPick: async () => options.quickPick,
      withProgress: async (config, work) => { calls.progress.push(config); return work(); }
    },
    workspace: {
      getConfiguration: () => ({
        get: key => configuration[key],
        inspect: key => ({ globalValue: configuration[key] }),
        update: async (key, value, target) => {
          calls.configurationWrites.push({ key, value, target });
          if (options.updateConfiguration) await options.updateConfiguration(key, value, target);
          configuration[key] = value;
          calls.configurationListener?.({ affectsConfiguration: namespace => namespace === 'frostedBackground' || namespace === 'frostedBackground.' + key });
        }
      }),
      onDidChangeConfiguration: callback => { calls.configurationListener = callback; return { dispose() {} }; }
    }
  };
  const sandbox = {
    module: { exports: {} },
    require: name => {
      if (name === 'vscode') return vscode;
      if (name === './patcher') return patcher;
      if (name === './config') return require('../src/config');
      if (name === './panel') return require('../src/panel');
      if (name === './updater') return require('../src/updater');
      if (name === './localization') return require('../src/localization');
      return require(name);
    },
    setTimeout: options.captureTimers ? (callback, delay) => {
      const timer = {};
      timers.set(timer, { callback, delay });
      return timer;
    } : setTimeout,
    clearTimeout: options.captureTimers ? timer => timers.delete(timer) : clearTimeout,
    Error
  };
  vm.runInNewContext(extensionSource, sandbox, { filename: extensionFile });
  sandbox.module.exports.activate(context);
  return {
    calls, state, context, configuration, timers,
    run: name => handlers.get('frostedBackground.' + name)(),
    dispose: () => context.subscriptions.forEach(item => item.dispose())
  };
}

async function settle() { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); }

test('a loaded live renderer applies new media and settings without reload or repeated media copies', async () => {
  const env = harness({ version: '0.7.0', liveProtocol: 1, captureTimers: true,
    files: [{ scheme: 'file', fsPath: 'D:/new.webm' }],
    state: { enabled: true, mediaPath: 'D:/old.png', injectionConsent: true, lastAppliedExtensionVersion: '0.7.0' }
  });
  const panel = attachPanel(env);
  await settle();
  await panel.send({ type: 'chooseMedia', kind: 'video', config: { ...DEFAULTS, blur: 25 } });
  assert.equal(env.calls.apply.length, 1);
  assert.equal(panel.latest().needsReload, false);
  assert.equal(panel.latest().liveEnabled, true);
  await panel.send({ type: 'liveConfig', requestId: 1, config: { ...DEFAULTS, blur: 30, fit: 'fill' } });
  assert.equal(env.calls.updateConfig.length, 1);
  assert.equal(env.calls.updateConfig[0].config.blur, 30);
  assert.equal(env.calls.apply.length, 1);
  assert.equal(env.configuration.blur, 30);
  assert.equal(panel.latest().liveAck, 1);
  assert.equal(env.calls.command.length, 0);
  assert.equal(env.calls.info.length, 0);
  await panel.send({ type: 'restore' });
  assert.equal(panel.latest().needsReload, false);
  assert.equal(panel.latest().liveEnabled, false);
  assert.equal(env.calls.command.length, 0);
  env.dispose();
});

test('publishing a live bootstrap cannot mark the running legacy window ready before reload', async () => {
  const env = harness({ version: '0.7.0', liveProtocol: undefined, captureTimers: true,
    state: { enabled: true, mediaPath: 'D:/old.png', injectionConsent: true, lastAppliedExtensionVersion: '0.7.0' }
  });
  const panel = attachPanel(env);
  await settle();
  await panel.send({ type: 'apply', config: DEFAULTS });
  assert.equal(panel.latest().needsReload, true);
  assert.equal(panel.latest().liveEnabled, false);
  await panel.send({ type: 'liveConfig', requestId: 1, config: { blur: 24 } });
  assert.equal(env.calls.updateConfig.length, 0);
  assert.equal(panel.latest().liveAck, 1);
  await panel.send({ type: 'apply', config: DEFAULTS, reloadAfterApply: true });
  assert.deepEqual(env.calls.command, [['workbench.action.reloadWindow']]);
  env.dispose();
});

test('live settings save failures keep retry feedback without asking for reload', async () => {
  const env = harness({ version: '0.7.0', liveProtocol: 1, captureTimers: true,
    state: { enabled: true, mediaPath: 'D:/saved.png', injectionConsent: true, lastAppliedExtensionVersion: '0.7.0' },
    updateConfiguration: async () => { throw new Error('Settings locked'); }
  });
  const panel = attachPanel(env);
  await settle();
  await panel.send({ type: 'liveConfig', requestId: 7, config: { ...DEFAULTS, blur: 29 } });
  assert.equal(env.calls.updateConfig.length, 1);
  assert.equal(panel.latest().needsReload, false);
  assert.equal(panel.latest().resetDraft, false);
  assert.equal(panel.latest().liveAck, 7);
  assert.match(panel.latest().error, /Settings locked/);
  assert.equal(env.calls.command.length, 0);
  env.dispose();
});

test('extension-host restart keeps the bootstrap requirement until the workbench session changes', async () => {
  const before = harness({ version: '0.7.0', liveProtocol: undefined, captureTimers: true, sessionId: 'window-before-reload',
    state: { enabled: true, mediaPath: 'D:/saved.png', injectionConsent: true, lastAppliedExtensionVersion: '0.7.0' } });
  const panel = attachPanel(before);
  await settle();
  await panel.send({ type: 'apply', config: DEFAULTS });
  const saved = Object.fromEntries(before.state);
  assert.equal(saved['bootstrapRequired:window-before-reload'], true);
  before.dispose();
  for (const [sessionId, ready] of [['window-before-reload', false], ['window-after-reload', true]]) {
    const next = harness({ version: '0.7.0', liveProtocol: 1, captureTimers: true, sessionId, state: saved });
    const nextPanel = attachPanel(next);
    await settle();
    await nextPanel.send({ type: 'ready' });
    assert.equal(nextPanel.latest().liveEnabled, ready);
    assert.equal(nextPanel.latest().needsReload, !ready);
    assert.equal(next.calls.command.length, 0);
    next.dispose();
  }
});

test('a window opened while disabled still requires reload after another window enables the bootstrap', async () => {
  const before = harness({ version: '0.7.0', captureTimers: true, sessionId: 'previously-disabled-window', state: { enabled: false } });
  await settle();
  const saved = Object.fromEntries(before.state);
  assert.equal(saved['bootstrapRequired:previously-disabled-window'], true);
  before.dispose();
  const restarted = harness({ version: '0.7.0', liveProtocol: 1, captureTimers: true, sessionId: 'previously-disabled-window',
    state: { ...saved, enabled: true, injectionConsent: true, mediaPath: 'D:/saved.png', lastAppliedExtensionVersion: '0.7.0' } });
  const panel = attachPanel(restarted);
  await settle();
  await panel.send({ type: 'ready' });
  assert.equal(panel.latest().liveEnabled, false);
  assert.equal(panel.latest().needsReload, true);
  restarted.dispose();
});

function attachPanel(env) {
  let receive;
  const messages = [];
  const webview = {
    cspSource: 'vscode-webview://extension-test', options: {}, html: '',
    asWebviewUri: value => ({ toString: () => 'vscode-webview-resource://test/' + encodeURIComponent(value.fsPath) }),
    postMessage: async message => { messages.push(JSON.parse(JSON.stringify(message))); return true; },
    onDidReceiveMessage: callback => { receive = callback; return { dispose() {} }; }
  };
  env.calls.providers[0].provider.resolveWebviewView({
    webview, visible: true,
    onDidDispose: () => ({ dispose() {} }),
    onDidChangeVisibility: () => ({ dispose() {} })
  });
  return {
    messages,
    send: async message => { await receive(message); await settle(); },
    latest: () => messages.at(-1)
  };
}

test('region changes are saved structurally and successful live edits remain quiet', async () => {
  const env = harness({ version: '0.9.0', liveProtocol: 1, captureTimers: true,
    state: { enabled: true, mediaPath: 'D:/saved.png', injectionConsent: true, lastAppliedExtensionVersion: '0.9.0' } });
  const panel = attachPanel(env);
  await settle();
  const regions = { enabled: true, items: [{ id: 'left', name: 'Clear', points: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]], feather: 0.06, blur: 0, opacity: 1, tintOpacity: 0, brightness: 1, saturation: 1 }] };
  await panel.send({ type: 'liveConfig', requestId: 1, config: { ...DEFAULTS, regions } });
  assert.deepEqual(env.calls.updateConfig[0].config.regions, regions);
  assert.deepEqual(env.calls.configurationWrites, [{ key: 'regions', value: regions, target: 1 }]);
  assert.equal(panel.latest().notice, null);
  assert.equal(panel.latest().needsReload, false);
  await panel.send({ type: 'liveConfig', requestId: 2, config: { ...DEFAULTS, regions: JSON.parse(JSON.stringify(regions)) } });
  assert.equal(env.calls.configurationWrites.length, 1, 'equivalent region objects are not repeatedly persisted');
  assert.equal(env.timers.size, 0, 'internal writes do not schedule a competing effect update');
  const softerRegions = { ...regions, items: regions.items.map(region => ({ ...region, feather: 0.12 })) };
  await panel.send({ type: 'liveConfig', requestId: 3, config: { ...DEFAULTS, regions: softerRegions } });
  assert.equal(env.calls.configurationWrites.length, 2, 'a feather-only edit persists once');
  assert.deepEqual(env.calls.updateConfig.at(-1).config.regions, softerRegions);
  assert.equal(panel.latest().needsReload, false);
  await panel.send({ type: 'apply', config: { ...DEFAULTS, regions: softerRegions } });
  assert.equal(panel.latest().notice, null, 'manual successful live apply has no redundant banner');
  assert.equal(env.calls.command.length, 0);
  env.dispose();
});

test('canceling either file picker never patches or requests first-use consent', async () => {
  for (const command of ['selectImage', 'selectVideo']) {
    for (const files of [undefined, []]) {
      const env = harness({ files });
      await env.run(command);
      assert.equal(env.calls.open.length, 1);
      assert.equal(env.calls.apply.length, 0);
      assert.equal(env.calls.warning.length, 0);
      assert.equal(env.calls.state.filter(([key]) => !key.startsWith('bootstrapRequired:')).length, 0);
      env.dispose();
    }
  }
});

test('declining first-use consent leaves files and enabled state unchanged', async () => {
  const env = harness({ files: [{ scheme: 'file', fsPath: 'D:/photos/background.jpg' }] });
  await env.run('selectImage');
  assert.equal(env.calls.warning.length, 1);
  assert.equal(env.calls.warning[0][1].modal, true);
  assert.equal(env.calls.apply.length, 0);
  assert.equal(env.state.has('injectionConsent'), false);
  assert.equal(env.state.has('mediaPath'), false);
  assert.equal(env.calls.command.length, 0);
  env.dispose();
});

test('choosing an image applies normalized settings, then persists state and offers reload', async () => {
  const file = 'D:/照片/背景 with spaces.jpg';
  const env = harness({
    files: [{ scheme: 'file', fsPath: file }], consent: '启用背景', info: '立即重载',
    config: { blur: 18, opacity: 0.42, fit: 'contain', saturation: 999 }
  });
  await env.run('selectImage');
  assert.equal(env.calls.apply.length, 1);
  const applied = env.calls.apply[0];
  assert.equal(applied.appRoot, 'test/app-root');
  assert.equal(applied.mediaPath, file);
  assert.equal(applied.rendererPath, path.resolve(__dirname, '../media/renderer.js'));
  assert.deepEqual(applied.config, { ...DEFAULTS, blur: 18, opacity: 0.42, fit: 'contain', saturation: 2 });
  assert.equal(env.calls.progress.length, 1);
  assert.equal(env.state.get('enabled'), true);
  assert.equal(env.state.get('mediaPath'), file);
  assert.equal(env.state.get('lastVersion'), '1.144.1');
  assert.equal(env.state.get('injectionConsent'), true);
  assert.deepEqual(env.calls.command, [['workbench.action.reloadWindow']]);
  env.dispose();
});

test('video selection accepts WebM and reuses existing consent', async () => {
  const env = harness({ files: [{ scheme: 'file', fsPath: 'D:/loop.webm' }], state: { injectionConsent: true } });
  await env.run('selectVideo');
  assert.deepEqual(Array.from(env.calls.open[0].filters['视频']), ['mp4', 'webm']);
  assert.equal(env.calls.warning.length, 0);
  assert.equal(env.calls.apply[0].mediaPath, 'D:/loop.webm');
  assert.equal(env.state.get('enabled'), true);
  env.dispose();
});

test('failed application keeps the previous selected file and does not reload', async () => {
  const env = harness({
    files: [{ scheme: 'file', fsPath: 'D:/new.jpg' }],
    state: { injectionConsent: true, mediaPath: 'D:/previous.jpg', enabled: true },
    apply: async () => { throw Object.assign(new Error('Read-only installation'), { code: 'EACCES' }); }
  });
  await env.run('selectImage');
  assert.equal(env.calls.error.length, 1);
  assert.match(env.calls.error[0][0], /无法写入 VS Code 安装目录/);
  assert.equal(env.state.get('mediaPath'), 'D:/previous.jpg');
  assert.equal(env.state.get('enabled'), true);
  assert.equal(env.calls.command.length, 0);
  env.dispose();
});

test('failed restore keeps enabled state so the user can retry recovery', async () => {
  const env = harness({
    state: { enabled: true, mediaPath: 'D:/background.jpg' },
    restore: async () => { throw new Error('Could not restore original file'); }
  });
  await env.run('restore');
  assert.equal(env.calls.restore.length, 1);
  assert.equal(env.state.get('enabled'), true);
  assert.equal(env.calls.state.filter(([key]) => !key.startsWith('bootstrapRequired:')).length, 0);
  assert.equal(env.calls.error.length, 1);
  assert.equal(env.calls.command.length, 0);
  env.dispose();
});

test('successful restore disables state and reloads only after explicit reload choice', async () => {
  const env = harness({ state: { enabled: true }, info: '立即重载' });
  await env.run('restore');
  assert.equal(env.calls.restore[0].appRoot, 'test/app-root');
  assert.equal(env.state.get('enabled'), false);
  assert.deepEqual(env.calls.command, [['workbench.action.reloadWindow']]);
  env.dispose();
});

test('web UI and remote file selections are rejected before patching', async () => {
  const web = harness({ web: true });
  await web.run('selectImage');
  assert.equal(web.calls.open.length, 0);
  assert.equal(web.calls.apply.length, 0);
  assert.match(web.calls.error[0][0], /桌面版 VS Code/);
  web.dispose();
  const remote = harness({ files: [{ scheme: 'vscode-remote', fsPath: '/tmp/image.jpg' }] });
  await remote.run('selectImage');
  assert.equal(remote.calls.apply.length, 0);
  assert.equal(remote.calls.warning.length, 0);
  assert.match(remote.calls.error[0][0], /本机/);
  remote.dispose();
});

test('reapplying uses the last local file without reopening the picker', async () => {
  const env = harness({ state: { injectionConsent: true, mediaPath: 'D:/saved.png' } });
  await env.run('apply');
  assert.equal(env.calls.open.length, 0);
  assert.equal(env.calls.warning.length, 0);
  assert.equal(env.calls.apply[0].mediaPath, 'D:/saved.png');
  env.dispose();
});

test('concurrent commands cannot race an apply operation against restore', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const env = harness({
    state: { injectionConsent: true, mediaPath: 'D:/saved.png' },
    apply: async () => { await pending; return { workbenchPath: 'test/workbench.html' }; }
  });
  const applying = env.run('apply');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.calls.apply.length, 1);
  await env.run('restore');
  assert.equal(env.calls.restore.length, 0);
  assert.ok(env.calls.info.some(args => args[0].includes('正在处理背景')));
  await env.run('closePanel');
  assert.equal(env.calls.command.at(-1)[0], 'workbench.action.closeSidebar', 'the controls can be hidden while applying');
  finish();
  await applying;
  assert.equal(env.state.get('enabled'), true);
  env.dispose();
});

test('an unanswered reload notification does not block a later restore', async () => {
  let dismiss;
  const notification = new Promise(resolve => { dismiss = resolve; });
  const env = harness({
    state: { injectionConsent: true, mediaPath: 'D:/saved.png' },
    info: () => notification
  });
  try {
    let applied = false;
    const applying = env.run('apply').then(() => { applied = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.calls.apply.length, 1);
    assert.equal(applied, true, 'apply must release its command lock without waiting for notification dismissal');
    await applying;
    await env.run('restore');
    assert.equal(env.calls.restore.length, 1);
    assert.equal(env.state.get('enabled'), false);
    assert.equal(env.calls.info.length, 2);
    assert.equal(env.calls.info.some(args => args[0].includes('正在处理背景')), false);
    assert.equal(env.calls.command.length, 0);
  } finally {
    env.dispose();
    dismiss(undefined);
  }
});

test('restoring with leftover occupied assets disables the background and explains cleanup recovery', async () => {
  const env = harness({
    state: { enabled: true },
    restore: async () => ({ workbenchPath: 'test/workbench.html', cleanupErrors: ['media.webm: EBUSY', 'renderer.js: EPERM'] })
  });
  await env.run('restore');
  assert.equal(env.state.get('enabled'), false);
  assert.equal(env.calls.error.length, 0);
  assert.ok(env.calls.log.includes('清理旧资源：media.webm: EBUSY'));
  assert.ok(env.calls.log.includes('清理旧资源：renderer.js: EPERM'));
  assert.equal(env.calls.info.length, 1);
  assert.match(env.calls.info[0][0], /部分旧资源仍被占用/);
  assert.match(env.calls.info[0][0], /重载后再次.*清理/);
  env.dispose();
});

test('the activity view, status bar and both settings commands lead to the same panel', async () => {
  const env = harness();
  assert.equal(env.calls.providers.length, 1);
  assert.equal(env.calls.providers[0].id, 'frostedBackground.controls');
  assert.equal(env.calls.statusBars.length, 1);
  assert.equal(env.calls.statusBars[0].visible, true);
  assert.equal(env.calls.statusBars[0].command, 'frostedBackground.openPanel');
  await env.run('openPanel');
  await env.run('openSettings');
  await env.run('closePanel');
  const panel = attachPanel(env);
  await panel.send({ type: 'closePanel' });
  assert.deepEqual(env.calls.command, [
    ['frostedBackground.controls.focus'], ['frostedBackground.controls.focus'],
    ['workbench.action.closeSidebar'], ['workbench.action.closeSidebar']
  ]);
  assert.equal(env.calls.apply.length, 0);
  assert.equal(env.calls.restore.length, 0, 'closing the controls never turns off the background');
  assert.equal(env.calls.configurationWrites.length, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.ok(manifest.contributes.menus['view/title'].some(item => item.command === 'frostedBackground.closePanel' && item.when === 'view == frostedBackground.controls'));
  env.dispose();
});

test('panel apply patches once, saves only known global settings and suppresses its own change notifications', async () => {
  const file = 'D:/selected-background.png';
  const env = harness({
    files: [{ scheme: 'file', fsPath: file }], captureTimers: true,
    state: { injectionConsent: true, enabled: true, mediaPath: 'D:/previous.png' }
  });
  const panel = attachPanel(env);
  await panel.send({ type: 'chooseMedia', kind: 'image', mediaPath: 'C:/ignored.png', config: { ...DEFAULTS, blur: 22, opacity: 0.6, source: 'file:///C:/injected.js' } });
  assert.equal(env.calls.apply.length, 1);
  assert.equal(env.calls.progress.length, 1);
  assert.equal(env.calls.apply[0].mediaPath, file);
  assert.deepEqual(env.calls.apply[0].config, { ...DEFAULTS, blur: 22, opacity: 0.6 });
  assert.deepEqual(env.calls.configurationWrites, [
    { key: 'blur', value: 22, target: 1 }, { key: 'opacity', value: 0.6, target: 1 }
  ]);
  assert.equal(env.state.get('mediaPath'), file);
  assert.equal(env.state.get('lastAppliedExtensionVersion'), '0.2.0');
  assert.equal(env.calls.info.length, 0, 'panel status should not create a competing notification flow');
  assert.equal(env.timers.size, 0, 'internal settings writes must not schedule change notices');
  assert.equal(panel.latest().needsReload, true);
  assert.equal(panel.latest().resetDraft, true);
  assert.equal(env.calls.command.length, 0);
  await panel.send({ type: 'reload' });
  assert.deepEqual(env.calls.command, [['workbench.action.reloadWindow']]);
  env.dispose();
});

test('panel patch failures preserve previous applied state, selected draft and saved settings', async () => {
  const env = harness({
    files: [{ scheme: 'file', fsPath: 'D:/new.png' }], captureTimers: true,
    state: { injectionConsent: true, enabled: true, mediaPath: 'D:/previous.png' },
    apply: async () => { throw new Error('Write failed'); }
  });
  const panel = attachPanel(env);
  await panel.send({ type: 'chooseMedia', kind: 'image', config: { ...DEFAULTS, blur: 24 } });
  assert.equal(env.calls.apply.length, 1);
  assert.equal(env.calls.configurationWrites.length, 0);
  assert.equal(env.state.get('mediaPath'), 'D:/previous.png');
  assert.equal(env.state.get('enabled'), true);
  assert.equal(panel.latest().media.name, 'new.png');
  assert.equal(panel.latest().resetDraft, false);
  assert.match(panel.latest().error, /Write failed/);
  assert.equal(env.calls.command.length, 0);
  env.dispose();
});

test('panel native picker rejects remote URIs before changing draft or patching', async () => {
  const env = harness({
    files: [{ scheme: 'vscode-remote', fsPath: '/remote/background.png' }],
    state: { mediaPath: 'D:/previous.png' }
  });
  const panel = attachPanel(env);
  await panel.send({ type: 'chooseMedia', kind: 'image' });
  assert.equal(env.calls.apply.length, 0);
  assert.equal(panel.latest().media.name, 'previous.png');
  assert.match(panel.latest().error, /本机/);
  env.dispose();
});

test('a pending panel apply also blocks command-based recovery until the operation completes', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const env = harness({
    state: { injectionConsent: true, mediaPath: 'D:/saved.png' },
    apply: async () => pending
  });
  const panel = attachPanel(env);
  await panel.send({ type: 'apply', config: DEFAULTS });
  assert.equal(env.calls.apply.length, 1);
  await env.run('restore');
  assert.equal(env.calls.restore.length, 0);
  assert.ok(env.calls.info.some(args => args[0].includes('正在处理背景')));
  finish({ workbenchPath: 'test/workbench.html' });
  await settle();
  await env.run('restore');
  assert.equal(env.calls.restore.length, 1);
  env.dispose();
});

test('startup distinguishes an extension upgrade from a missing installation patch without changing files', async () => {
  const upgrade = harness({ state: { enabled: true, lastAppliedExtensionVersion: '0.1.0' }, installed: true, info: '打开控制面板' });
  await settle();
  assert.equal(upgrade.calls.apply.length, 0);
  assert.match(upgrade.calls.info[0][0], /已更新/);
  assert.deepEqual(upgrade.calls.command, [['frostedBackground.openPanel'], ['frostedBackground.controls.focus']]);
  upgrade.dispose();
  const missing = harness({ state: { enabled: true }, installed: false });
  await settle();
  assert.equal(missing.calls.apply.length, 0);
  assert.match(missing.calls.info[0][0], /尚未应用/);
  missing.dispose();
  const current = harness({ state: { enabled: true }, installed: true });
  await settle();
  assert.equal(current.calls.info.length, 0);
  assert.equal(current.calls.apply.length, 0);
  current.dispose();
});

test('a settings-save failure after a successful patch preserves the draft and still offers reload', async () => {
  const env = harness({
    state: { injectionConsent: true, mediaPath: 'D:/saved.png' }, captureTimers: true,
    updateConfiguration: async () => { throw new Error('Settings file is read-only'); }
  });
  const panel = attachPanel(env);
  await panel.send({ type: 'apply', config: { ...DEFAULTS, blur: 28 } });
  assert.equal(env.calls.apply.length, 1);
  assert.equal(env.calls.apply[0].config.blur, 28);
  assert.equal(env.state.get('enabled'), true);
  assert.equal(env.state.get('mediaPath'), 'D:/saved.png');
  assert.equal(panel.latest().needsReload, true);
  assert.equal(panel.latest().resetDraft, false);
  assert.equal(panel.latest().error, null);
  assert.match(panel.latest().notice, /背景已应用/);
  assert.match(panel.latest().notice, /设置保存失败/);
  assert.ok(env.calls.log.some(line => line.includes('Settings file is read-only')));
  await panel.send({ type: 'reload' });
  assert.deepEqual(env.calls.command, [['workbench.action.reloadWindow']]);
  env.dispose();
});

test('panel actions ignored during a command operation receive the final idle state afterward', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const env = harness({
    state: { injectionConsent: true, mediaPath: 'D:/saved.png' },
    apply: async () => pending
  });
  const panel = attachPanel(env);
  const applying = env.run('apply');
  await settle();
  assert.equal(panel.latest().busy, true);
  await panel.send({ type: 'restore' });
  assert.equal(env.calls.restore.length, 0);
  finish({ workbenchPath: 'test/workbench.html' });
  await applying;
  await settle();
  assert.equal(panel.latest().busy, false, 'the shared command lock must not leave the webview stuck busy');
  await panel.send({ type: 'restore' });
  assert.equal(env.calls.restore.length, 1);
  assert.equal(panel.latest().busy, false);
  env.dispose();
});

test('an automatic extension upgrade refreshes the cached background without reopening the original media', async t => {
  const env = harness({
    version: '0.3.0',
    state: { enabled: true, injectionConsent: true, mediaPath: 'Z:/deleted-original.png', lastAppliedExtensionVersion: '0.2.0' },
    config: { updateMode: 'automatic', blur: 57, fit: 'contain' },
  });
  t.after(() => env.dispose());
  await settle();
  assert.equal(env.calls.reapply.length, 1);
  assert.equal(env.calls.reapply[0].appRoot, 'test/app-root');
  assert.equal(env.calls.reapply[0].rendererPath, path.resolve(__dirname, '../media/renderer.js'));
  assert.deepEqual(Object.keys(env.calls.reapply[0]).sort(), ['appRoot', 'rendererPath'], 'migration reuses the cached configuration and media instead of current drafts');
  assert.equal(env.calls.apply.length, 0);
  assert.equal(env.calls.open.length, 0);
  assert.equal(env.calls.warning.length, 0);
  assert.equal(env.calls.configurationWrites.length, 0);
  assert.equal(env.state.get('mediaPath'), 'Z:/deleted-original.png');
  assert.equal(env.state.get('enabled'), true);
  assert.equal(env.state.get('lastAppliedExtensionVersion'), '0.3.0');
  assert.equal(env.calls.info.length, 1);
  assert.match(env.calls.info[0][0], /自动准备好/);
  assert.equal(env.calls.info[0][1], '立即重载');
  assert.equal(env.calls.command.length, 0, 'migration never reloads a window automatically');
});

test('migration records the new applied version only after the cached patch succeeds', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const env = harness({
    version: '0.3.0', state: { enabled: true, injectionConsent: true },
    reapply: () => pending,
  });
  t.after(() => env.dispose());
  await settle();
  assert.equal(env.calls.reapply.length, 1);
  assert.equal(env.state.get('lastAppliedExtensionVersion'), '0.2.0');
  assert.equal(env.calls.info.length, 0);
  finish({ workbenchPath: 'test/workbench.html' });
  await settle();
  assert.equal(env.state.get('lastAppliedExtensionVersion'), '0.3.0');
  assert.equal(env.calls.command.length, 0);
});

test('automatic migration preserves all activation and preference guards', async t => {
  const cases = [
    { name: 'background is disabled', state: { enabled: false, injectionConsent: true } },
    { name: 'injection consent is absent', state: { enabled: true, injectionConsent: false } },
    { name: 'notify mode', state: { enabled: true, injectionConsent: true }, config: { updateMode: 'notify' } },
    { name: 'updates switched off', state: { enabled: true, injectionConsent: true }, config: { updateMode: 'off' } },
    { name: 'VS Code patch is missing', state: { enabled: true, injectionConsent: true }, installed: false },
    { name: 'current renderer already applied', state: { enabled: true, injectionConsent: true, lastAppliedExtensionVersion: '0.3.0' } },
    { name: 'web editor', state: { enabled: true, injectionConsent: true }, web: true },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async child => {
      const env = harness({ version: '0.3.0', ...entry });
      child.after(() => env.dispose());
      await settle();
      assert.equal(env.calls.reapply.length, 0);
      assert.equal(env.calls.apply.length, 0);
      assert.equal(env.calls.open.length, 0);
      assert.equal(env.calls.command.length, 0);
      assert.equal(env.state.get('lastAppliedExtensionVersion'), entry.state.lastAppliedExtensionVersion || '0.2.0');
      if (entry.installed === false) assert.match(env.calls.info[0][0], /尚未应用/);
    });
  }
});

test('permission or cached-media migration failures retain the previous applied version and offer the panel', async t => {
  for (const code of ['EACCES', 'ENOENT']) {
    await t.test(code, async child => {
      const env = harness({
        version: '0.3.0',
        state: { enabled: true, injectionConsent: true, mediaPath: 'Z:/original.png' },
        reapply: async () => { throw Object.assign(new Error('Migration failed: ' + code), { code }); },
        info: '打开控制面板',
      });
      child.after(() => env.dispose());
      await settle();
      assert.equal(env.calls.reapply.length, 1);
      assert.equal(env.calls.apply.length, 0);
      assert.equal(env.state.get('lastAppliedExtensionVersion'), '0.2.0');
      assert.equal(env.state.get('enabled'), true);
      assert.equal(env.state.get('mediaPath'), 'Z:/original.png');
      assert.ok(env.calls.log.some(message => message.includes(code)));
      assert.ok(env.calls.info.some(message => message.includes('打开控制面板')));
      assert.deepEqual(env.calls.command, [['frostedBackground.openPanel'], ['frostedBackground.controls.focus']]);
    });
  }
});

test('a migrated background reloads only when its notification action is chosen', async t => {
  const env = harness({
    version: '0.3.0', state: { enabled: true, injectionConsent: true }, info: '立即重载',
  });
  t.after(() => env.dispose());
  await settle();
  assert.equal(env.calls.reapply.length, 1);
  assert.deepEqual(env.calls.command, [['workbench.action.reloadWindow']]);
});

test('the update panel remains offline until bound and changing update mode does not trigger effect reapply notices', async t => {
  const env = harness({
    version: '0.3.0', captureTimers: true,
    state: { enabled: true, injectionConsent: true, lastAppliedExtensionVersion: '0.3.0' },
  });
  t.after(() => env.dispose());
  const panel = attachPanel(env);
  await panel.send({ type: 'ready' });
  assert.equal(panel.latest().update.status, 'unconfigured');
  assert.equal(panel.latest().update.currentVersion, '0.3.0');
  await panel.send({ type: 'setUpdateMode', mode: 'off' });
  assert.deepEqual(env.calls.configurationWrites, [{ key: 'updateMode', value: 'off', target: 1 }]);
  assert.equal(panel.latest().update.mode, 'off');
  assert.equal(env.timers.size, 0, 'changing only updateMode does not schedule a background-effect notice');
  assert.equal(env.calls.info.length, 0);
  await env.run('checkUpdates');
  await settle();
  assert.equal(panel.latest().update.status, 'unconfigured');
  assert.equal(env.calls.apply.length, 0);
  assert.equal(env.calls.reapply.length, 0);
  assert.equal(env.calls.command.length, 0);
  env.calls.configurationListener({ affectsConfiguration: name => ['frostedBackground', 'frostedBackground.blur'].includes(name) });
  assert.equal(env.timers.size, 1, 'actual effect changes still schedule their normal notice');
});

test('disposing before startup inspection completes prevents cached-media migration', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const env = harness({
    version: '0.3.0', state: { enabled: true, injectionConsent: true }, status: () => pending,
  });
  env.dispose();
  finish({ installed: true, workbenchPath: 'test/workbench.html' });
  await settle();
  assert.equal(env.calls.reapply.length, 0);
  assert.equal(env.calls.info.length, 0);
});

test('closing the background while startup inspection is pending prevents a stale automatic migration', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const env = harness({
    version: '0.3.0', state: { enabled: true, injectionConsent: true }, status: () => pending,
  });
  t.after(() => env.dispose());
  await env.run('restore');
  assert.equal(env.state.get('enabled'), false);
  finish({ installed: true, workbenchPath: 'test/workbench.html' });
  await settle();
  assert.equal(env.calls.reapply.length, 0, 'an earlier startup snapshot must not undo the user closing the background');
  assert.equal(env.state.get('lastAppliedExtensionVersion'), '0.2.0');
});

test('an absent or unsupported language uses English for native controls and consent', async t => {
  for (const language of [undefined, 'fr', { toString: () => 'es' }]) {
    await t.test(String(language), async child => {
      const env = harness({
        state: { language }, files: [{ scheme: 'file', fsPath: 'D:/wallpaper.png' }],
        consent: 'Enable Background', info: 'Reload Now'
      });
      child.after(() => env.dispose());
      await env.run('selectImage');
      assert.equal(env.calls.open[0].title, 'Choose a background image');
      assert.equal(env.calls.open[0].openLabel, 'Use as Background');
      assert.ok(env.calls.open[0].filters.Image);
      assert.match(env.calls.warning[0][0], /needs to modify/);
      assert.match(env.calls.warning[0][1].detail, /installation integrity warning/);
      assert.equal(env.calls.statusBars[0].text, '$(color-mode) Frosted');
      assert.equal(env.calls.progress[0].title, 'Applying Frosted Background…');
      assert.equal(env.calls.apply.length, 1);
      assert.deepEqual(env.calls.command, [['workbench.action.reloadWindow']]);
    });
  }
});

test('saved Spanish is used by native file dialogs, status and recovery notices', async t => {
  const env = harness({
    state: { language: 'es', injectionConsent: true },
    files: [{ scheme: 'file', fsPath: 'D:/loop.webm' }]
  });
  t.after(() => env.dispose());
  await env.run('selectVideo');
  assert.match(env.calls.open[0].title, /Elige un vídeo de fondo/);
  assert.equal(env.calls.open[0].openLabel, 'Usar como fondo');
  assert.deepEqual(Array.from(env.calls.open[0].filters['Vídeo']), ['mp4', 'webm']);
  assert.equal(env.calls.statusBars[0].tooltip, 'Abrir los controles del fondo');
  await env.run('status');
  assert.match(env.calls.info.at(-1)[0], /Fondo esmerilado: Aplicado; última selección: loop.webm/);
  await env.run('restore');
  assert.match(env.calls.info.at(-1)[0], /Se ha restaurado la interfaz original/);
  assert.equal(env.calls.info.at(-1)[1], 'Recargar ahora');
});

test('changing the saved language refreshes status and update text without applying the background', async t => {
  const env = harness({ state: { language: undefined, mediaPath: 'D:/wallpaper.png' } });
  t.after(() => env.dispose());
  const panel = attachPanel(env);
  await panel.send({ type: 'ready' });
  assert.match(panel.latest().update.message, /No GitHub release repository/);
  await env.context.globalState.update('language', 'es');
  env.calls.providers[0].provider.callbacks.onLanguageChanged();
  await settle();
  assert.equal(env.calls.statusBars[0].text, '$(color-mode) Fondo');
  assert.match(panel.latest().update.message, /No se ha configurado/);
  assert.equal(panel.latest().media.name, 'wallpaper.png');
  assert.equal(env.calls.apply.length, 0);
  assert.equal(env.calls.restore.length, 0);
  assert.equal(env.calls.configurationWrites.length, 0);
  assert.equal(env.calls.command.length, 0);
  await env.run('selectImage');
  assert.equal(env.calls.open[0].title, 'Elige una imagen de fondo');
});

test('common patch errors are translated while their technical details are retained', async t => {
  const permission = harness({
    state: { language: 'es', injectionConsent: true, mediaPath: 'D:/wallpaper.png' },
    apply: async () => { throw Object.assign(new Error('Read-only installation'), { code: 'EACCES' }); }
  });
  t.after(() => permission.dispose());
  await permission.run('apply');
  assert.match(permission.calls.error[0][0], /No se puede escribir en la carpeta de instalación/);
  assert.match(permission.calls.error[0][0], /Read-only installation/);
  assert.equal(permission.calls.error[0][1], 'Ver registro');
  const invalid = harness({
    state: { language: undefined, injectionConsent: true, mediaPath: 'D:/wallpaper.png' },
    apply: async () => { throw new Error('背景文件过大，请选择不超过 500 MB 的文件。'); }
  });
  t.after(() => invalid.dispose());
  await invalid.run('apply');
  assert.match(invalid.calls.error[0][0], /Choose a file no larger than 500 MB/);
  assert.doesNotMatch(invalid.calls.error[0][0], /[\u3400-\u9fff]/);
});

test('a reload action already displayed remains valid after changing the language', async t => {
  let choose;
  const answer = new Promise(resolve => { choose = resolve; });
  const env = harness({
    state: { language: undefined, injectionConsent: true, mediaPath: 'D:/wallpaper.png' }, info: () => answer
  });
  t.after(() => env.dispose());
  await env.run('apply');
  assert.equal(env.calls.info[0][1], 'Reload Now');
  await env.context.globalState.update('language', 'es');
  env.calls.providers[0].provider.callbacks.onLanguageChanged();
  choose('Reload Now');
  await settle();
  assert.deepEqual(env.calls.command, [['workbench.action.reloadWindow']]);
});
