'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DEFAULTS } = require('../src/config');
const { BackgroundPanel } = require('../src/panel');

const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let index = 0; index < 5; index++) await tick(); }

function harness(options = {}) {
  const calls = { messages: [], choose: [], apply: [], restore: [], reload: [], log: [] };
  const saved = new Map(Object.entries(options.state || {}));
  let onMessage;
  let onDispose;
  let onVisible;
  const uri = filename => ({
    scheme: 'file', fsPath: filename, path: filename.replace(/\\/g, '/'),
    toString: () => 'file:///' + filename.replace(/\\/g, '/')
  });
  const vscode = { Uri: { file: uri, joinPath: (base, ...segments) => uri(path.join(base.fsPath, ...segments)) } };
  const context = {
    extensionUri: uri(path.resolve(__dirname, '..')),
    asAbsolutePath: filename => path.resolve(__dirname, '..', filename),
    subscriptions: [],
    globalState: { get: (key, fallback) => saved.has(key) ? saved.get(key) : fallback }
  };
  const webview = {
    cspSource: 'vscode-webview://test',
    options: {},
    html: '',
    asWebviewUri: value => ({ toString: () => 'vscode-webview-resource://test/' + encodeURIComponent(value.fsPath) }),
    postMessage: async value => { calls.messages.push(clone(value)); return true; },
    onDidReceiveMessage: callback => { onMessage = callback; return { dispose() {} }; }
  };
  const view = {
    webview, visible: true,
    onDidDispose: callback => { onDispose = callback; return { dispose() {} }; },
    onDidChangeVisibility: callback => { onVisible = callback; return { dispose() {} }; },
    show() {}
  };
  const provider = new BackgroundPanel(vscode, context, {
    readConfig: () => ({ ...DEFAULTS, ...(options.config || {}) }),
    chooseMedia: async kind => {
      calls.choose.push(kind);
      return typeof options.choose === 'function' ? options.choose(kind) : options.choose;
    },
    apply: async (mediaPath, config) => {
      calls.apply.push({ mediaPath, config: clone(config) });
      if (options.apply) return options.apply(mediaPath, config);
      saved.set('mediaPath', mediaPath);
      saved.set('enabled', true);
      return { needsReload: true, notice: 'Applied' };
    },
    restore: async () => {
      calls.restore.push(true);
      if (options.restore) return options.restore();
      saved.set('enabled', false);
      return { needsReload: true, notice: 'Restored' };
    },
    reload: async () => { calls.reload.push(true); },
    log: error => calls.log.push(error),
    isBusy: () => options.busy === true
  });
  provider.resolveWebviewView(view);
  return {
    provider, webview, calls, saved,
    send: async message => { await onMessage(message); await settle(); },
    dispose: () => provider.dispose(),
    close: () => onDispose?.(),
    visible: () => onVisible?.(),
    latestState: () => [...calls.messages].reverse().find(value => value.type === 'state')
  };
}

test('panel serves local scripts under a restrictive CSP', async () => {
  const env = harness();
  await env.send({ type: 'ready' });
  assert.equal(env.webview.options.enableScripts, true);
  assert.match(env.webview.html, /Content-Security-Policy/);
  assert.match(env.webview.html, /default-src ['"]none['"]/);
  assert.doesNotMatch(env.webview.html, /script-src[^;\n]*unsafe-inline/);
  assert.ok(env.calls.messages.length > 0);
  env.dispose();
});

test('unknown or malformed messages cannot invoke file or settings operations', async () => {
  const env = harness({ state: { mediaPath: 'D:/saved.png' } });
  for (const message of [null, false, 'apply', [], {}, { type: 'delete' }, { type: 'apply', config: null }, { type: 'apply', config: [] }, { type: 'apply', config: 'bad' }]) {
    await env.send(message);
  }
  assert.equal(env.calls.choose.length, 0);
  assert.equal(env.calls.apply.length, 0);
  assert.equal(env.calls.restore.length, 0);
  assert.equal(env.calls.reload.length, 0);
  env.dispose();
});

test('applying cannot select a path supplied by webview content', async () => {
  const env = harness();
  await env.send({ type: 'apply', config: DEFAULTS, mediaPath: 'C:/unselected.png', source: 'file:///C:/unselected.png' });
  assert.equal(env.calls.apply.length, 0);
  assert.equal(env.calls.choose.length, 0);
  env.dispose();
});

test('native file selection becomes the draft and apply passes only normalized visual settings', async () => {
  const file = 'D:/照片/background & spaces.png';
  const env = harness({ choose: file });
  await env.send({ type: 'chooseMedia', kind: 'image', mediaPath: 'C:/ignored.png' });
  assert.deepEqual(env.calls.choose, ['image']);
  assert.equal(env.calls.apply.length, 0, 'choosing a file only updates the draft');
  await env.send({
    type: 'apply', mediaPath: 'C:/ignored.png',
    config: { blur: 999, opacity: -1, fit: 'contain', brightness: NaN, position: 'url(evil)',
      source: 'https://example.com/video', mediaPath: 'C:/ignored.png', rendererPath: 'C:/injected.js',
      respectReducedMotion: false, pauseWhenUnfocused: 'false' }
  });
  assert.deepEqual(env.calls.apply, [{ mediaPath: file, config: {
    ...DEFAULTS, blur: 60, opacity: 0.05, fit: 'contain', respectReducedMotion: false
  } }]);
  assert.equal(env.calls.reload.length, 0, 'applying does not reload without an explicit reload request');
  env.dispose();
});

test('canceling a new file choice preserves the previous draft media', async () => {
  let selected = 'D:/first.webm';
  const env = harness({ choose: () => selected });
  await env.send({ type: 'chooseMedia', kind: 'video' });
  selected = undefined;
  await env.send({ type: 'chooseMedia', kind: 'image' });
  await env.send({ type: 'apply', config: DEFAULTS });
  assert.equal(env.calls.apply[0].mediaPath, 'D:/first.webm');
  env.dispose();
});

test('failed apply preserves selected draft for retry and releases the busy state', async () => {
  let failure = true;
  const env = harness({
    choose: 'D:/new.png', state: { mediaPath: 'D:/previous.png', enabled: true },
    apply: async () => { if (failure) throw new Error('Read-only installation'); return { needsReload: true }; }
  });
  await env.send({ type: 'chooseMedia', kind: 'image' });
  await env.send({ type: 'apply', config: { ...DEFAULTS, blur: 22 } });
  assert.equal(env.calls.apply.length, 1);
  assert.equal(env.saved.get('mediaPath'), 'D:/previous.png');
  assert.equal(env.calls.log.length, 1);
  assert.equal(env.calls.reload.length, 0);
  failure = false;
  await env.send({ type: 'apply', config: { ...DEFAULTS, blur: 22 } });
  assert.equal(env.calls.apply.length, 2);
  assert.equal(env.calls.apply[1].mediaPath, 'D:/new.png');
  assert.equal(env.calls.apply[1].config.blur, 22);
  env.dispose();
});

test('duplicate apply and restore requests cannot overlap an in-flight apply', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const env = harness({ state: { mediaPath: 'D:/saved.png' }, apply: async () => pending });
  const first = env.send({ type: 'apply', config: DEFAULTS });
  await settle();
  assert.equal(env.calls.apply.length, 1);
  await env.send({ type: 'apply', config: DEFAULTS });
  await env.send({ type: 'restore' });
  assert.equal(env.calls.apply.length, 1);
  assert.equal(env.calls.restore.length, 0);
  finish({ needsReload: true });
  await first;
  await settle();
  await env.send({ type: 'restore' });
  assert.equal(env.calls.restore.length, 1);
  env.dispose();
});

test('host command activity prevents competing panel operations', async () => {
  const env = harness({ state: { mediaPath: 'D:/saved.png' }, busy: true, choose: 'D:/new.png' });
  await env.send({ type: 'apply', config: DEFAULTS });
  await env.send({ type: 'restore' });
  await env.send({ type: 'chooseMedia', kind: 'image' });
  assert.equal(env.calls.apply.length, 0);
  assert.equal(env.calls.restore.length, 0);
  assert.equal(env.calls.choose.length, 0);
  env.dispose();
});

test('restore and reload call the dedicated host callbacks without accepting injected arguments', async () => {
  const env = harness({ state: { enabled: true, mediaPath: 'D:/saved.png' } });
  await env.send({ type: 'restore', appRoot: 'C:/other-app' });
  assert.equal(env.calls.restore.length, 1);
  assert.equal(env.calls.apply.length, 0);
  assert.equal(env.calls.reload.length, 0);
  await env.send({ type: 'reload', command: 'other.extension.command' });
  assert.equal(env.calls.reload.length, 1);
  env.dispose();
});

test('canceled consent keeps the selected draft and does not reset controls or request reload', async () => {
  const env = harness({ choose: 'D:/draft.png', apply: async () => ({ cancelled: true }) });
  await env.send({ type: 'chooseMedia', kind: 'image' });
  await env.send({ type: 'apply', config: { ...DEFAULTS, blur: 25 } });
  assert.equal(env.calls.apply.length, 1);
  assert.equal(env.latestState().media.name, 'draft.png');
  assert.equal(env.latestState().resetDraft, false);
  assert.equal(env.latestState().needsReload, false);
  assert.equal(env.latestState().busy, false);
  assert.equal(env.calls.reload.length, 0);
  env.dispose();
});

test('disposed provider ignores later webview requests', async () => {
  const env = harness({ state: { mediaPath: 'D:/saved.png' }, choose: 'D:/new.png' });
  env.dispose();
  await env.send({ type: 'chooseMedia', kind: 'image' });
  await env.send({ type: 'apply', config: DEFAULTS });
  await env.send({ type: 'restore' });
  assert.equal(env.calls.choose.length, 0);
  assert.equal(env.calls.apply.length, 0);
  assert.equal(env.calls.restore.length, 0);
});
