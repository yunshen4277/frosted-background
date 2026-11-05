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
  const calls = { messages: [], choose: [], apply: [], live: [], restore: [], reload: [], closePanel: [], log: [], languageChanged: [], writes: [] };
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
    globalState: {
      get: (key, fallback) => saved.has(key) ? saved.get(key) : fallback,
      update: async (key, value) => {
        calls.writes.push({ key, value });
        if (options.optimisticState) saved.set(key, value);
        if (options.update) await options.update(key, value);
        saved.set(key, value);
      }
    }
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
    isLiveEnabled: () => options.liveEnabled === true,
    needsBootstrap: () => options.needsBootstrap === true,
    liveConfig: async config => {
      calls.live.push(clone(config));
      if (options.liveConfig) return options.liveConfig(config);
      options.config = config;
      return { needsReload: false, resetDraft: true };
    },
    chooseMedia: async kind => {
      calls.choose.push(kind);
      return typeof options.choose === 'function' ? options.choose(kind) : options.choose;
    },
    apply: async (mediaPath, config) => {
      calls.apply.push({ mediaPath, config: clone(config) });
      if (options.apply) return options.apply(mediaPath, config);
      saved.set('mediaPath', mediaPath);
      saved.set('enabled', true);
      return { needsReload: true, noticeKey: '首次启用或升级后需要重载一次，之后更换背景和调整效果将自动生效。' };
    },
    restore: async () => {
      calls.restore.push(true);
      if (options.restore) return options.restore();
      saved.set('enabled', false);
      return { needsReload: true, notice: 'Restored' };
    },
    reload: async () => { calls.reload.push(true); },
    closePanel: async () => { calls.closePanel.push(true); },
    onLanguageChanged: () => { calls.languageChanged.push(saved.get('language')); },
    log: error => calls.log.push(error),
    isBusy: () => options.busy === true
  });
  provider.resolveWebviewView(view);
  return {
    provider, webview, calls, saved, view,
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

test('native file selection automatically applies only normalized visual settings', async () => {
  const file = 'D:/照片/background & spaces.png';
  const env = harness({ choose: file });
  await env.send({
    type: 'chooseMedia', kind: 'image', mediaPath: 'C:/ignored.png',
    config: { blur: 999, opacity: -1, fit: 'contain', brightness: NaN, position: 'url(evil)',
      source: 'https://example.com/video', mediaPath: 'C:/ignored.png', rendererPath: 'C:/injected.js',
      respectReducedMotion: false, pauseWhenUnfocused: 'false' }
  });
  assert.deepEqual(env.calls.choose, ['image']);
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

test('stretch layout survives the panel host normalization for both media kinds', async () => {
  for (const kind of ['image', 'video']) {
    const mediaPath = kind === 'video' ? 'D:/stretch.webm' : 'D:/stretch.png';
    const env = harness({ choose: mediaPath });
    await env.send({ type: 'chooseMedia', kind, config: { ...DEFAULTS, fit: 'fill', blur: 21, position: 'center bottom' } });
    assert.deepEqual(env.calls.apply, [{ mediaPath, config: { ...DEFAULTS, fit: 'fill', blur: 21, position: 'center bottom' } }]);
    env.dispose();
  }
});

test('failed apply preserves selected draft for retry and releases the busy state', async () => {
  let failure = true;
  const env = harness({
    choose: 'D:/new.png', state: { mediaPath: 'D:/previous.png', enabled: true },
    apply: async () => { if (failure) throw new Error('Read-only installation'); return { needsReload: true }; }
  });
  await env.send({ type: 'chooseMedia', kind: 'image', config: { ...DEFAULTS, blur: 22 } });
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

test('closing during host activity only hides the panel and leaves state and draft media intact', async () => {
  const env = harness({ state: { enabled: true, mediaPath: 'D:/saved.png' }, busy: true });
  env.provider.mediaPath = 'D:/unsaved-selection.webm';
  env.provider.notice = 'Keep this notice';
  env.provider.error = 'Keep this error';
  const messages = env.calls.messages.length;
  await env.send({ type: 'closePanel', enabled: false, mediaPath: 'D:/injected.png', config: { blur: 0 } });
  assert.deepEqual(env.calls.closePanel, [true]);
  assert.equal(env.saved.get('enabled'), true);
  assert.equal(env.saved.get('mediaPath'), 'D:/saved.png');
  assert.equal(env.provider.mediaPath, 'D:/unsaved-selection.webm');
  assert.equal(env.provider.notice, 'Keep this notice');
  assert.equal(env.provider.error, 'Keep this error');
  assert.equal(env.calls.messages.length, messages, 'closing does not refresh or reset the draft');
  assert.equal(env.calls.restore.length + env.calls.apply.length + env.calls.reload.length, 0);
  env.dispose();
});

test('closing is also available while a panel apply is pending', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const env = harness({ state: { mediaPath: 'D:/saved.png' }, apply: async () => pending });
  const applying = env.send({ type: 'apply', config: { ...DEFAULTS, blur: 24 } });
  await settle();
  assert.equal(env.provider.pending, true);
  await env.send({ type: 'closePanel' });
  assert.equal(env.calls.closePanel.length, 1);
  assert.equal(env.provider.pending, true, 'closing does not cancel or unlock the in-flight operation');
  assert.equal(env.calls.restore.length, 0);
  finish({ needsReload: true });
  await applying;
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
  await env.send({ type: 'chooseMedia', kind: 'image', config: { ...DEFAULTS, blur: 25 } });
  assert.equal(env.calls.apply.length, 1);
  assert.equal(env.latestState().media.name, 'draft.png');
  assert.equal(env.latestState().resetDraft, false);
  assert.equal(env.latestState().needsReload, false);
  assert.equal(env.latestState().busy, false);
  assert.equal(env.calls.reload.length, 0);
  env.dispose();
});

test('language defaults to English and persists the selected language when the view reopens', async () => {
  const env = harness();
  await env.send({ type: 'ready' });
  assert.equal(env.latestState().language, 'en');
  assert.match(env.webview.html, /<html lang="en">/);
  assert.equal(env.view.title, 'Background Controls');
  await env.send({ type: 'setLanguage', language: 'es' });
  assert.equal(env.saved.get('language'), 'es');
  assert.equal(env.latestState().language, 'es');
  assert.deepEqual(env.calls.languageChanged, ['es']);
  env.close();
  env.provider.resolveWebviewView(env.view);
  assert.match(env.webview.html, /<html lang="es">/);
  const reopened = harness({ state: Object.fromEntries(env.saved) });
  await reopened.send({ type: 'ready' });
  assert.equal(reopened.latestState().language, 'es');
  for (const invalid of ['de', 'zh', '<script>', null, {}, ['en']]) await env.send({ type: 'setLanguage', language: invalid });
  assert.deepEqual(env.calls.writes, [{ key: 'language', value: 'es' }]);
  reopened.dispose();
  env.dispose();
});

test('language can change while applying without altering the draft or operation lock', async () => {
  let finish;
  const env = harness({ state: { mediaPath: 'D:/saved.png', enabled: true }, apply: () => new Promise(resolve => { finish = resolve; }) });
  env.provider.mediaPath = 'D:/draft.webm';
  const applying = env.provider.receive({ type: 'apply', config: { ...DEFAULTS, blur: 23 } });
  await settle();
  await env.provider.receive({ type: 'setLanguage', language: 'zh-CN' });
  assert.equal(env.latestState().language, 'zh-CN');
  assert.equal(env.latestState().busy, true);
  assert.equal(env.latestState().resetDraft, false);
  assert.equal(env.provider.mediaPath, 'D:/draft.webm');
  assert.equal(env.saved.get('mediaPath'), 'D:/saved.png');
  assert.equal(env.calls.apply.length, 1);
  assert.equal(env.calls.restore.length + env.calls.reload.length, 0);
  assert.deepEqual(env.calls.writes, [{ key: 'language', value: 'zh-CN' }]);
  finish({ needsReload: true });
  await applying;
  assert.equal(env.latestState().language, 'zh-CN');
  assert.equal(env.latestState().busy, false);
  env.dispose();
});

test('quick language choices save in order and keep the last choice', async () => {
  let finishFirst;
  const env = harness({ update: (_key, value) => value === 'es' ? new Promise(resolve => { finishFirst = resolve; }) : undefined });
  const first = env.provider.receive({ type: 'setLanguage', language: 'es' });
  await settle();
  const second = env.provider.receive({ type: 'setLanguage', language: 'zh-CN' });
  await settle();
  assert.equal(env.latestState().language, 'zh-CN');
  assert.equal(env.calls.writes.length, 1);
  finishFirst();
  await Promise.all([first, second]);
  assert.equal(env.saved.get('language'), 'zh-CN');
  assert.deepEqual(env.calls.languageChanged, ['zh-CN']);
  assert.equal(env.latestState().resetDraft, false);
  env.dispose();
});

test('failed language saving restores the saved choice and keeps feedback and media usable', async () => {
  const env = harness({ state: { language: 'en', mediaPath: 'D:/saved.png' }, update: async () => { throw new Error('Storage unavailable'); } });
  env.provider.notice = 'Keep notice';
  await env.provider.receive({ type: 'setLanguage', language: 'es' });
  assert.equal(env.latestState().language, 'en');
  assert.match(env.latestState().error, /Storage unavailable/);
  assert.equal(env.latestState().notice, 'Keep notice');
  assert.equal(env.latestState().resetDraft, false);
  assert.equal(env.latestState().busy, false);
  assert.deepEqual(env.calls.languageChanged, ['en']);
  assert.equal(env.calls.apply.length + env.calls.restore.length + env.calls.reload.length, 0);
  env.dispose();
});

test('existing panel notices and errors change language without repeating an action', async () => {
  const env = harness({ choose: 'D:/wallpaper.png' });
  await env.provider.receive({ type: 'apply', config: DEFAULTS });
  const englishError = env.latestState().error;
  await env.provider.receive({ type: 'setLanguage', language: 'zh-CN' });
  assert.equal(env.latestState().error, '请先选择一张图片或一段视频。');
  assert.notEqual(env.latestState().error, englishError);
  await env.provider.receive({ type: 'chooseMedia', kind: 'image' });
  const chineseNotice = env.latestState().notice;
  await env.provider.receive({ type: 'setLanguage', language: 'es' });
  assert.notEqual(env.latestState().notice, chineseNotice);
  assert.equal(env.calls.choose.length, 1);
  assert.equal(env.calls.apply.length, 1);
  assert.equal(env.latestState().media.name, 'wallpaper.png');
  env.dispose();
});

test('failed Memento disk writes roll back its optimistic in-memory language', async () => {
  const env = harness({ state: { language: 'zh-CN' }, optimisticState: true,
    update: async (_key, language) => { if (language === 'es') throw new Error('Disk write failed'); } });
  await env.provider.receive({ type: 'setLanguage', language: 'es' });
  assert.equal(env.latestState().language, 'zh-CN');
  assert.equal(env.saved.get('language'), 'zh-CN', 'native notifications must also read the restored choice');
  assert.equal(env.latestState().resetDraft, false);
  assert.match(env.latestState().error, /Disk write failed/);
  await env.provider.receive({ type: 'setLanguage', language: 'en' });
  assert.equal(env.latestState().language, 'en');
  assert.equal(env.saved.get('language'), 'en');
  assert.equal(env.latestState().error, null);
  env.dispose();
  // If an earlier queued choice succeeds, a later failure must also refresh
  // native labels to that successful choice rather than leave the old locale.
  const rapid = harness({ state: { language: 'en' }, optimisticState: true,
    update: async (_key, language) => { if (language === 'zh-CN') throw new Error('Disk write failed'); } });
  await Promise.all([
    rapid.provider.receive({ type: 'setLanguage', language: 'es' }),
    rapid.provider.receive({ type: 'setLanguage', language: 'zh-CN' }),
  ]);
  assert.equal(rapid.saved.get('language'), 'es');
  assert.equal(rapid.latestState().language, 'es');
  assert.deepEqual(rapid.calls.languageChanged, ['es']);
  rapid.dispose();
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

test('the combined Apply action reloads only after a successful bootstrap apply', async () => {
  for (const result of [{ needsReload: true }, { needsReload: false }, { cancelled: true }, { needsReload: true, resetDraft: false }]) {
    const env = harness({ state: { mediaPath: 'D:/saved.png' }, apply: async () => result });
    await env.send({ type: 'apply', config: DEFAULTS, reloadAfterApply: true });
    assert.equal(env.calls.reload.length, result.needsReload && !result.cancelled && result.resetDraft !== false ? 1 : 0);
    env.dispose();
  }
  const env = harness({ state: { mediaPath: 'D:/saved.png' }, apply: async () => { throw new Error('Disk failure'); } });
  await env.send({ type: 'apply', config: DEFAULTS, reloadAfterApply: true });
  assert.equal(env.calls.reload.length, 0);
  assert.match(env.latestState().error, /Disk failure/);
  env.dispose();
});

test('live settings are acknowledged, normalized, and never trigger media copies or reloads', async () => {
  const env = harness({ liveEnabled: true, state: { mediaPath: 'D:/saved.png', enabled: true } });
  await env.send({ type: 'liveConfig', requestId: 1, config: { blur: 999, source: 'https://example.test/a', fit: 'fill' } });
  assert.deepEqual(env.calls.live, [{ ...DEFAULTS, blur: 60, fit: 'fill' }]);
  assert.equal(env.latestState().liveAck, 1);
  assert.equal(env.latestState().liveApplying, false);
  assert.equal(env.latestState().resetDraft, true);
  assert.equal(env.calls.apply.length + env.calls.reload.length, 0);
  await env.send({ type: 'liveConfig', requestId: 1, config: DEFAULTS });
  await env.send({ type: 'liveConfig', requestId: NaN, config: DEFAULTS });
  await env.send({ type: 'liveConfig', requestId: 2, config: [] });
  assert.equal(env.calls.live.length, 1);
  env.dispose();
});

test('live settings stay serialized and media selection waits for the active write', async () => {
  let release;
  const events = [];
  const env = harness({ liveEnabled: true, state: { mediaPath: 'D:/saved.png', enabled: true },
    liveConfig: async () => { events.push('live start'); await new Promise(resolve => { release = resolve; }); events.push('live end'); return { needsReload: false }; },
    choose: () => { events.push('choose'); return 'D:/new.webm'; }
  });
  const write = env.provider.receive({ type: 'liveConfig', requestId: 1, config: { ...DEFAULTS, blur: 22 } });
  await settle();
  assert.equal(env.latestState().busy, false);
  assert.equal(env.latestState().liveApplying, true);
  await env.provider.receive({ type: 'closePanel' });
  assert.equal(env.calls.closePanel.length, 1);
  const choose = env.provider.receive({ type: 'chooseMedia', kind: 'video', config: { ...DEFAULTS, blur: 25 } });
  await settle();
  assert.deepEqual(events, ['live start']);
  release();
  await Promise.all([write, choose]);
  assert.deepEqual(events, ['live start', 'live end', 'choose']);
  assert.equal(env.calls.apply[0].config.blur, 25);
  assert.equal(env.latestState().liveAck, 1);
  env.dispose();
});

test('failed live writes acknowledge without clearing the draft and permit a later retry', async () => {
  let fail = true;
  const env = harness({ liveEnabled: true, state: { mediaPath: 'D:/saved.png', enabled: true }, liveConfig: async () => {
    if (fail) throw new Error('Disk full');
    return { needsReload: false, resetDraft: true };
  } });
  await env.send({ type: 'liveConfig', requestId: 4, config: { blur: 20 } });
  assert.equal(env.latestState().liveAck, 4);
  assert.equal(env.latestState().resetDraft, false);
  assert.match(env.latestState().error, /Disk full/);
  fail = false;
  await env.send({ type: 'liveConfig', requestId: 5, config: { blur: 28 } });
  assert.equal(env.latestState().liveAck, 5);
  assert.equal(env.latestState().error, null);
  assert.equal(env.calls.live.length, 2);
  env.dispose();
});

test('a failed new media selection cannot live-edit the previous background through its draft', async () => {
  const env = harness({ liveEnabled: true, choose: 'D:/bad.webm', state: { mediaPath: 'D:/saved.png', enabled: true }, apply: async () => { throw new Error('Copy failed'); } });
  await env.send({ type: 'chooseMedia', kind: 'video', config: DEFAULTS });
  assert.equal(env.latestState().liveEnabled, false);
  await env.send({ type: 'liveConfig', requestId: 1, config: { blur: 28 } });
  assert.equal(env.calls.live.length, 0);
  assert.equal(env.latestState().liveAck, 1);
  assert.equal(env.latestState().resetDraft, false);
  env.dispose();
});

test('failed reselection of the same source path also blocks live edits until retry succeeds', async () => {
  let fail = true;
  const env = harness({ liveEnabled: true, choose: 'D:/saved.png', state: { mediaPath: 'D:/saved.png', enabled: true }, apply: async () => {
    if (fail) throw new Error('Copy failed');
    return { needsReload: false };
  } });
  await env.send({ type: 'chooseMedia', kind: 'image', config: DEFAULTS });
  assert.equal(env.latestState().liveEnabled, false);
  await env.send({ type: 'liveConfig', requestId: 1, config: { blur: 28 } });
  assert.equal(env.calls.live.length, 0);
  fail = false;
  await env.send({ type: 'apply', config: DEFAULTS });
  assert.equal(env.latestState().liveEnabled, true);
  env.dispose();
});

test('foreground success clears an earlier live-write conflict from the same message turn', async () => {
  const env = harness({ liveEnabled: true, choose: 'D:/new.png', state: { mediaPath: 'D:/saved.png', enabled: true } });
  const live = env.provider.receive({ type: 'liveConfig', requestId: 1, config: { blur: 28 } });
  const choose = env.provider.receive({ type: 'chooseMedia', kind: 'image', config: { ...DEFAULTS, blur: 28 } });
  await Promise.all([live, choose]);
  assert.equal(env.calls.apply.length, 1);
  assert.equal(env.latestState().error, null);
  assert.equal(env.latestState().liveAck, 1);
  env.dispose();
});
