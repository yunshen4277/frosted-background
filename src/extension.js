'use strict';

const vscode = require('vscode');
const path = require('node:path');
const { DEFAULTS, normalizeConfig } = require('./config');
const patcher = require('./patcher');
const { BackgroundPanel } = require('./panel');
const { UpdateController } = require('./updater');
const { normalizeLanguage, t, localizedError, describeError: translateError } = require('./localization');
const { resolveMediaLink } = require('./remote-media');
const { resolveYouTubeLink } = require('./youtube-media');
const { classifyLink, normalizeRemoteSource, displayName } = require('../media/source');

function activate(context) {
  const readLanguage = () => normalizeLanguage(context.globalState.get('language'));
  const text = (key, params) => t(readLanguage(), key, params);
  const output = vscode.window.createOutputChannel('Frosted Background');
  context.subscriptions.push(output);
  let busy = false;
  let changeTimer;
  let disposed = false;
  const mediaDownloads = new Set();
  let savingConfig = false;
  let liveConfigBusy = false;
  let runtimeReady = false;
  let panel;
  let updater;
  const extensionVersion = context.extension?.packageJSON?.version || '0.11.0';
  const readSelection = () => context.globalState.get('mediaSource') || context.globalState.get('mediaPath');
  const windowSession = typeof vscode.env.sessionId === 'string' && vscode.env.sessionId !== 'someValue.sessionId' ? vscode.env.sessionId : '';
  const bootstrapKey = windowSession ? 'bootstrapRequired:' + windowSession : undefined;
  const markBootstrapRequired = async () => {
    if (!disposed && bootstrapKey && !runtimeReady) await context.globalState.update(bootstrapKey, true);
  };
  // Snapshot the renderer that this window loaded. Publishing new files does
  // not load a bootstrap into an already-running window.
  const appliedVersionAtActivation = context.globalState.get('lastAppliedExtensionVersion');
  const initialStatus = vscode.env.uiKind === vscode.UIKind.Desktop && context.globalState.get('enabled', false)
    ? patcher.status({ appRoot: vscode.env.appRoot }).then(async state => {
      if (disposed) return state;
      // The workbench session survives extension-host restarts, unlike activate().
      // Keep a same-session bootstrap requirement until the actual window reloads.
      runtimeReady = Boolean(windowSession) && !context.globalState.get(bootstrapKey, false)
        && state.installed && state.liveProtocol === 1 && appliedVersionAtActivation === extensionVersion;
      if (!runtimeReady) await markBootstrapRequired();
      panel?.refresh();
      return state;
    }) : Promise.resolve().then(async () => {
      if (vscode.env.uiKind === vscode.UIKind.Desktop) await markBootstrapRequired();
      return { installed: false };
    });
  initialStatus.catch(() => {});

  const readConfig = () => {
    const config = vscode.workspace.getConfiguration('frostedBackground');
    return normalizeConfig(Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, config.get(key)])));
  };

  function requireDesktop() {
    if (vscode.env.uiKind !== vscode.UIKind.Desktop) throw localizedError('此插件需要桌面版 VS Code，网页版不支持编辑区背景。');
  }

  function describeError(error) {
    return translateError(readLanguage(), error);
  }

  async function runExclusive(callback) {
    if (busy) throw localizedError('正在处理背景，请稍候。');
    busy = true;
    panel?.refresh();
    try {
      requireDesktop();
      return await callback();
    } finally {
      busy = false;
      panel?.refresh();
    }
  }

  const command = (name, callback) => {
    context.subscriptions.push(vscode.commands.registerCommand('frostedBackground.' + name, async () => {
      if (busy) return vscode.window.showInformationMessage(text('正在处理背景，请稍候。'));
      try {
        return await runExclusive(callback);
      } catch (error) {
        output.appendLine(new Date().toISOString() + ' ' + (error.stack || String(error)));
        const action = text('查看日志');
        const answer = await vscode.window.showErrorMessage(text('毛玻璃背景：{error}', { error: describeError(error) }), action);
        if (answer === action) output.show();
      }
    }));
  };

  async function confirmFirstUse() {
    if (context.globalState.get('injectionConsent', false)) return true;
    const action = text('启用背景');
    const choice = await vscode.window.showWarningMessage(
      text('毛玻璃背景需要修改当前 VS Code 的界面文件。'),
      { modal: true, detail: text('官方扩展接口不支持代码区图片或视频背景。启用后可能出现“安装似乎已损坏”的完整性提示；可通过“关闭背景并恢复原状”撤销。此设置影响这份 VS Code 安装的所有窗口，更新 VS Code 后需要重新应用。') },
      action
    );
    if (choice !== action) return false;
    await context.globalState.update('injectionConsent', true);
    return true;
  }

  function offerReload(message) {
    // A notification can stay open indefinitely. Release the command lock after
    // the file operation, so ignoring this notification cannot block recovery.
    const action = text('立即重载');
    vscode.window.showInformationMessage(text('{message} 重载窗口后生效；其他已打开窗口也需重载。', { message }), action).then(choice => {
      if (choice === action && !disposed) return vscode.commands.executeCommand('workbench.action.reloadWindow');
    }).then(undefined, error => output.appendLine(text('重载窗口：{error}', { error: describeError(error) })));
  }

  async function saveConfig(values) {
    const current = readConfig();
    const config = vscode.workspace.getConfiguration('frostedBackground');
    savingConfig = true;
    clearTimeout(changeTimer);
    try {
      for (const key of Object.keys(DEFAULTS)) {
        const changed = key === 'regions' ? JSON.stringify(current[key]) !== JSON.stringify(values[key]) : current[key] !== values[key];
        if (changed) await config.update(key, values[key], vscode.ConfigurationTarget.Global);
      }
    } finally { savingConfig = false; }
  }

  async function applyMedia(mediaPath, configOverride, fromPanel = false) {
    if (disposed) return { cancelled: true };
    const remote = typeof mediaPath === 'object' ? normalizeRemoteSource(mediaPath) : undefined;
    if (!(await confirmFirstUse())) return { cancelled: true };
    await initialStatus.catch(() => {});
    await markBootstrapRequired();
    if (disposed) return { cancelled: true };
    const config = configOverride ? normalizeConfig(configOverride) : readConfig();
    let settingsError;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: text('正在应用毛玻璃背景…'), cancellable: false }, async () => {
      const result = await patcher.apply({
        appRoot: vscode.env.appRoot,
        rendererPath: context.asAbsolutePath('media/renderer.js'),
        ...(remote ? { mediaSource: remote } : { mediaPath }),
        config
      });
      // Retain the source path only on this machine. It is never written to workspace settings.
      await context.globalState.update('mediaPath', remote ? undefined : mediaPath);
      await context.globalState.update('mediaSource', remote);
      await context.globalState.update('enabled', true);
      await context.globalState.update('lastVersion', vscode.version);
      await context.globalState.update('lastAppliedExtensionVersion', extensionVersion);
      output.appendLine(text('已应用：{path}', { path: result.workbenchPath }));
      if (configOverride) {
        try { await saveConfig(config); }
        catch (error) {
          // The background was already published successfully. Keep the panel's
          // draft and offer reload even if writing preferences failed afterward.
          settingsError = describeError(error);
          output.appendLine(text('背景已应用，但设置保存失败：{error}', { error: settingsError }));
        }
      }
    });
    if (!fromPanel) {
      panel?.refresh({ syncMedia: true, resetDraft: true });
      if (!runtimeReady) offerReload(text('背景已准备好。'));
    }
    const noticeKey = runtimeReady
      ? (settingsError ? '背景已实时应用，但设置保存失败，可稍后重试：{error}' : null)
      : (settingsError ? '背景已应用，重载窗口后生效。但设置保存失败，可稍后重试：{error}' : '首次启用或升级后需要重载一次，之后更换背景和调整效果将自动生效。');
    const noticeParams = { error: settingsError };
    return { needsReload: !runtimeReady, resetDraft: !settingsError,
      noticeKey, noticeParams, notice: noticeKey ? text(noticeKey, noticeParams) : null };
  }

  async function applyLiveConfig(configOverride) {
    if (!runtimeReady || !context.globalState.get('enabled', false)) throw localizedError('请先应用背景并重载一次，以启用实时调整。');
    liveConfigBusy = true;
    try {
      return await runExclusive(async () => {
        const config = normalizeConfig(configOverride);
        await patcher.updateConfig({ appRoot: vscode.env.appRoot, config });
        try { await saveConfig(config); }
        catch (error) { throw localizedError('背景已实时应用，但设置保存失败，可稍后重试：{error}', { error: describeError(error) }); }
        return { needsReload: false, resetDraft: true, notice: null };
      });
    } finally { liveConfigBusy = false; }
  }

  async function chooseMediaFile(kind) {
    const extensions = kind === 'video' ? ['mp4', 'webm'] : ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'];
    const files = await vscode.window.showOpenDialog({
      title: text(kind === 'video' ? '选择背景视频（静音循环；建议 WebM）' : '选择背景图片'),
      openLabel: text('设为毛玻璃背景'), canSelectMany: false, canSelectFiles: true, canSelectFolders: false,
      filters: { [text(kind === 'video' ? '视频' : '图片')]: extensions },
      defaultUri: context.globalState.get('mediaPath') ? vscode.Uri.file(context.globalState.get('mediaPath')) : undefined
    });
    if (!files || !files[0]) return;
    if (files[0].scheme !== 'file') throw localizedError('请选择本机上的图片或视频。远程工作区中的文件需要先保存到本机。');
    return files[0].fsPath;
  }

  async function chooseMedia(kind) {
    const mediaPath = await chooseMediaFile(kind);
    if (mediaPath) return applyMedia(mediaPath);
  }

  async function chooseMediaLink(url, kind) {
    const source = classifyLink(url, kind);
    const youtube = source.type === 'platform' && source.platform === 'YouTube';
    if (source.type === 'platform' && !youtube) {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(source.url));
      if (!opened) throw localizedError('无法打开官方播放页，请检查默认浏览器。');
      return { openedExternal: true };
    }
    const abort = new AbortController();
    mediaDownloads.add(abort);
    try { return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: text(youtube ? '正在准备 YouTube 背景…' : '正在加载外部媒体…'), cancellable: true }, async (progress, token) => {
      const cancellation = token?.onCancellationRequested(() => abort.abort());
      if (token?.isCancellationRequested) abort.abort();
      try {
        const resolve = youtube ? resolveYouTubeLink : resolveMediaLink;
        const selected = await resolve(source.url, kind, {
          directory: path.join(context.globalStorageUri.fsPath, youtube ? 'youtube-media' : 'external-media'), signal: abort.signal,
          onStage: stage => {
            const key = { prepare: '首次使用正在准备 YouTube 辅助工具…', resolve: '正在读取 YouTube 视频…', download: '正在缓存 YouTube 背景视频…' }[stage];
            if (key) progress?.report({ message: text(key) });
          },
          onProgress: bytes => progress?.report({ message: text('已下载 {size} MB', { size: Math.round(bytes / 1024 / 1024) }) })
        });
        if (disposed || abort.signal.aborted) throw localizedError('已取消链接加载或加载超时。');
        return selected;
      } finally { cancellation?.dispose(); }
    }); } finally { mediaDownloads.delete(abort); }
  }

  async function restoreBackground(fromPanel = false) {
    const result = await patcher.restore({ appRoot: vscode.env.appRoot });
    await context.globalState.update('enabled', false);
    output.appendLine(text('已移除当前安装的背景注入。'));
    for (const error of result.cleanupErrors || []) output.appendLine(text('清理旧资源：{error}', { error }));
    const baseNoticeKey = result.cleanupErrors?.length ? '已关闭背景；部分旧资源仍被占用，可重载后再次关闭背景以清理。' : '已恢复原状。';
    const notice = text(baseNoticeKey);
    if (!fromPanel) {
      panel?.refresh();
      if (!runtimeReady) offerReload(notice);
    }
    const noticeKey = runtimeReady ? baseNoticeKey : baseNoticeKey + ' 重载窗口后生效。';
    return { needsReload: !runtimeReady, noticeKey, notice: text(noticeKey) };
  }

  // Hiding the controls is a layout action, so it does not acquire the
  // background operation lock or restore/disable the current background.
  const closePanel = () => vscode.commands.executeCommand('workbench.action.closeSidebar');
  context.subscriptions.push(vscode.commands.registerCommand('frostedBackground.closePanel', closePanel));
  panel = new BackgroundPanel(vscode, context, {
    readConfig,
    isBusy: () => busy && !liveConfigBusy,
    isLiveEnabled: () => runtimeReady && context.globalState.get('enabled', false),
    needsBootstrap: () => context.globalState.get('enabled', false) && !runtimeReady,
    liveConfig: applyLiveConfig,
    chooseMedia: kind => runExclusive(() => chooseMediaFile(kind)),
    chooseUrl: (url, kind) => runExclusive(() => chooseMediaLink(url, kind)),
    apply: (mediaPath, config) => runExclusive(() => applyMedia(mediaPath, config, true)),
    restore: () => runExclusive(() => restoreBackground(true)),
    reload: () => vscode.commands.executeCommand('workbench.action.reloadWindow'),
    closePanel,
    readUpdateState: () => updater?.getState() || null,
    checkUpdates: () => updater.check(true),
    setUpdateMode: mode => updater.setMode(mode),
    onLanguageChanged: () => { refreshStatusLanguage(); updater?.refreshLanguage(); },
    log: error => output.appendLine(error.stack || String(error))
  });
  context.subscriptions.push(panel);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('frostedBackground.controls', panel));
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 40);
  function refreshStatusLanguage() {
    statusItem.text = '$(color-mode) ' + text('毛玻璃');
    statusItem.tooltip = text('打开毛玻璃背景控制面板');
  }
  refreshStatusLanguage();
  statusItem.command = 'frostedBackground.openPanel';
  statusItem.show();
  context.subscriptions.push(statusItem);

  updater = new UpdateController(vscode, context, {
    repository: context.extension?.packageJSON?.frostedBackgroundUpdates?.repository || '',
    currentVersion: extensionVersion,
    extensionId: 'local-frosted.frosted-background',
    runExclusive,
    log: error => output.appendLine(text('插件更新：{error}', { error: error.stack || String(error) })),
    onChange: () => panel.refresh()
  });
  context.subscriptions.push(updater);
  context.subscriptions.push(vscode.commands.registerCommand('frostedBackground.checkUpdates', () => updater.check(true)));
  if (vscode.env.uiKind === vscode.UIKind.Desktop) updater.start();

  const openPanel = () => vscode.commands.executeCommand('frostedBackground.controls.focus');
  command('openPanel', openPanel);
  command('selectImage', () => chooseMedia('image'));
  command('selectVideo', () => chooseMedia('video'));
  command('openSettings', openPanel);
  command('apply', async () => {
    const mediaPath = readSelection();
    if (!mediaPath) {
      const kind = await vscode.window.showQuickPick([
        { label: '$(file-media) ' + text('选择图片'), kind: 'image' },
        { label: '$(play-circle) ' + text('选择视频'), kind: 'video' }
      ], { placeHolder: text('选择背景类型') });
      if (kind) await chooseMedia(kind.kind);
      return;
    }
    await applyMedia(mediaPath);
  });
  command('restore', () => restoreBackground());
  command('status', async () => {
    const state = await patcher.status({ appRoot: vscode.env.appRoot });
    const mediaPath = readSelection();
    await vscode.window.showInformationMessage(
      text('毛玻璃背景：{status}{media}。当前 VS Code {version}。', {
        status: text(state.installed ? '已应用' : '未应用'),
        media: mediaPath ? text('；上次选择：{name}', { name: typeof mediaPath === 'string' ? path.basename(mediaPath) : displayName(mediaPath.url) }) : '', version: vscode.version
      })
    );
  });

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('frostedBackground') || savingConfig) return;
    panel.refresh();
    if (!Object.keys(DEFAULTS).some(key => event.affectsConfiguration('frostedBackground.' + key))) return;
    if (!context.globalState.get('enabled', false)) return;
    clearTimeout(changeTimer);
    const applyChangedConfig = async () => {
      if (disposed || !context.globalState.get('enabled', false)) return;
      if (runtimeReady) {
        if (busy || panel.pending || panel.liveApplying) {
          changeTimer = setTimeout(applyChangedConfig, 300);
          return;
        }
        try { await applyLiveConfig(readConfig()); panel.refresh({ resetDraft: true }); }
        catch (error) { panel.error = error; panel.refresh(); output.appendLine(describeError(error)); }
        return;
      }
      const action = text('应用设置');
      const choice = await vscode.window.showInformationMessage(text('毛玻璃效果设置已修改，应用后重载窗口即可生效。'), action);
      if (choice === action && !disposed) await vscode.commands.executeCommand('frostedBackground.apply');
    };
    changeTimer = setTimeout(applyChangedConfig, 300);
  }));
  context.subscriptions.push({ dispose: () => { disposed = true; clearTimeout(changeTimer); for (const download of mediaDownloads) download.abort(); mediaDownloads.clear(); } });

  // An extension update can refresh an already-enabled, consented background.
  // A missing patch (such as after VS Code itself updates) always needs manual apply.
  if (vscode.env.uiKind === vscode.UIKind.Desktop && context.globalState.get('enabled', false)) {
    initialStatus.then(async state => {
      if (disposed || busy || !context.globalState.get('enabled', false)) return;
      const upgraded = context.globalState.get('lastAppliedExtensionVersion') !== extensionVersion;
      if (state.installed && !upgraded) return;
      if (state.installed && upgraded && context.globalState.get('injectionConsent', false) && updater.readMode() === 'automatic') {
        try {
          await runExclusive(async () => {
            await markBootstrapRequired();
            await patcher.reapply({ appRoot: vscode.env.appRoot, rendererPath: context.asAbsolutePath('media/renderer.js') });
            await context.globalState.update('lastAppliedExtensionVersion', extensionVersion);
          });
          offerReload(text('新版背景效果已自动准备好。'));
          return;
        } catch (error) {
          output.appendLine(text('自动迁移背景未完成：{error}', { error: describeError(error) }));
        }
      }
      const message = text(state.installed ? '毛玻璃背景已更新，请在控制面板中应用一次，让新效果生效。' : '背景尚未应用到这份 VS Code 安装（例如更新之后），可以在控制面板重新应用。');
      const action = text('打开控制面板');
      const choice = await vscode.window.showInformationMessage(message, action);
      if (choice === action && !disposed) await vscode.commands.executeCommand('frostedBackground.openPanel');
    }).catch(error => output.appendLine(text('启动检查：{error}', { error: describeError(error) })));
  }
}

function deactivate() {}
module.exports = { activate, deactivate };
