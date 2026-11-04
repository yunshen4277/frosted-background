'use strict';

const vscode = require('vscode');
const path = require('node:path');
const { DEFAULTS, normalizeConfig } = require('./config');
const patcher = require('./patcher');
const { BackgroundPanel } = require('./panel');
const { UpdateController } = require('./updater');

function activate(context) {
  const output = vscode.window.createOutputChannel('毛玻璃背景');
  context.subscriptions.push(output);
  let busy = false;
  let changeTimer;
  let disposed = false;
  let savingConfig = false;
  let panel;
  let updater;
  const extensionVersion = context.extension?.packageJSON?.version || '0.5.0';

  const readConfig = () => {
    const config = vscode.workspace.getConfiguration('frostedBackground');
    return normalizeConfig(Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, config.get(key)])));
  };

  function requireDesktop() {
    if (vscode.env.uiKind !== vscode.UIKind.Desktop) throw new Error('此插件需要桌面版 VS Code，网页版不支持编辑区背景。');
  }

  function describeError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error && ['EACCES', 'EPERM', 'EROFS'].includes(error.code)) {
      return '无法写入 VS Code 安装目录。请使用安装在当前用户目录、且目录可写的 VS Code；macOS 请先将应用移到“应用程序”。详细信息：' + message;
    }
    if (error && error.code === 'ENOSPC') return '磁盘空间不足，请释放空间后再试。';
    return message;
  }

  async function runExclusive(callback) {
    if (busy) throw new Error('正在处理背景，请稍候。');
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
      if (busy) return vscode.window.showInformationMessage('正在处理背景，请稍候。');
      try {
        return await runExclusive(callback);
      } catch (error) {
        output.appendLine(new Date().toISOString() + ' ' + (error.stack || String(error)));
        const answer = await vscode.window.showErrorMessage('毛玻璃背景：' + describeError(error), '查看日志');
        if (answer === '查看日志') output.show();
      }
    }));
  };

  async function confirmFirstUse() {
    if (context.globalState.get('injectionConsent', false)) return true;
    const choice = await vscode.window.showWarningMessage(
      '毛玻璃背景需要修改当前 VS Code 的界面文件。',
      { modal: true, detail: '官方扩展接口不支持代码区图片或视频背景。启用后可能出现“安装似乎已损坏”的完整性提示；可通过“关闭背景并恢复原状”撤销。此设置影响这份 VS Code 安装的所有窗口，更新 VS Code 后需要重新应用。' },
      '启用背景'
    );
    if (choice !== '启用背景') return false;
    await context.globalState.update('injectionConsent', true);
    return true;
  }

  function offerReload(message) {
    // A notification can stay open indefinitely. Release the command lock after
    // the file operation, so ignoring this notification cannot block recovery.
    vscode.window.showInformationMessage(message + ' 重载窗口后生效；其他已打开窗口也需重载。', '立即重载').then(choice => {
      if (choice === '立即重载' && !disposed) return vscode.commands.executeCommand('workbench.action.reloadWindow');
    }).then(undefined, error => output.appendLine('重载窗口：' + describeError(error)));
  }

  async function saveConfig(values) {
    const current = readConfig();
    const config = vscode.workspace.getConfiguration('frostedBackground');
    savingConfig = true;
    clearTimeout(changeTimer);
    try {
      for (const key of Object.keys(DEFAULTS)) {
        if (current[key] !== values[key]) await config.update(key, values[key], vscode.ConfigurationTarget.Global);
      }
    } finally { savingConfig = false; }
  }

  async function applyMedia(mediaPath, configOverride, fromPanel = false) {
    if (!(await confirmFirstUse())) return { cancelled: true };
    const config = configOverride ? normalizeConfig(configOverride) : readConfig();
    let settingsError;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在应用毛玻璃背景…', cancellable: false }, async () => {
      const result = await patcher.apply({
        appRoot: vscode.env.appRoot,
        rendererPath: context.asAbsolutePath('media/renderer.js'),
        mediaPath,
        config
      });
      // Retain the source path only on this machine. It is never written to workspace settings.
      await context.globalState.update('mediaPath', mediaPath);
      await context.globalState.update('enabled', true);
      await context.globalState.update('lastVersion', vscode.version);
      await context.globalState.update('lastAppliedExtensionVersion', extensionVersion);
      output.appendLine('已应用：' + result.workbenchPath);
      if (configOverride) {
        try { await saveConfig(config); }
        catch (error) {
          // The background was already published successfully. Keep the panel's
          // draft and offer reload even if writing preferences failed afterward.
          settingsError = describeError(error);
          output.appendLine('背景已应用，但设置保存失败：' + settingsError);
        }
      }
    });
    if (!fromPanel) {
      panel?.refresh({ syncMedia: true, resetDraft: true });
      offerReload('背景已准备好。');
    }
    return { needsReload: true, resetDraft: !settingsError,
      notice: settingsError ? '背景已应用，重载窗口后生效。但设置保存失败，可稍后重试：' + settingsError : '背景已应用，重载窗口后生效。其他已打开窗口也需重载。' };
  }

  async function chooseMediaFile(kind) {
    const extensions = kind === 'video' ? ['mp4', 'webm'] : ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'];
    const files = await vscode.window.showOpenDialog({
      title: kind === 'video' ? '选择背景视频（静音循环；建议 WebM）' : '选择背景图片',
      openLabel: '设为毛玻璃背景', canSelectMany: false, canSelectFiles: true, canSelectFolders: false,
      filters: { [kind === 'video' ? '视频' : '图片']: extensions },
      defaultUri: context.globalState.get('mediaPath') ? vscode.Uri.file(context.globalState.get('mediaPath')) : undefined
    });
    if (!files || !files[0]) return;
    if (files[0].scheme !== 'file') throw new Error('请选择本机上的图片或视频。远程工作区中的文件需要先保存到本机。');
    return files[0].fsPath;
  }

  async function chooseMedia(kind) {
    const mediaPath = await chooseMediaFile(kind);
    if (mediaPath) return applyMedia(mediaPath);
  }

  async function restoreBackground(fromPanel = false) {
    const result = await patcher.restore({ appRoot: vscode.env.appRoot });
    await context.globalState.update('enabled', false);
    output.appendLine('已移除当前安装的背景注入。');
    for (const error of result.cleanupErrors || []) output.appendLine('清理旧资源：' + error);
    const notice = result.cleanupErrors?.length ? '已关闭背景；部分旧资源仍被占用，可重载后再次关闭背景以清理。' : '已恢复原状。';
    if (!fromPanel) {
      panel?.refresh();
      offerReload(notice);
    }
    return { needsReload: true, notice: notice + ' 重载窗口后生效。' };
  }

  // Hiding the controls is a layout action, so it does not acquire the
  // background operation lock or restore/disable the current background.
  const closePanel = () => vscode.commands.executeCommand('workbench.action.closeSidebar');
  context.subscriptions.push(vscode.commands.registerCommand('frostedBackground.closePanel', closePanel));
  panel = new BackgroundPanel(vscode, context, {
    readConfig,
    isBusy: () => busy,
    chooseMedia: kind => runExclusive(() => chooseMediaFile(kind)),
    apply: (mediaPath, config) => runExclusive(() => applyMedia(mediaPath, config, true)),
    restore: () => runExclusive(() => restoreBackground(true)),
    reload: () => vscode.commands.executeCommand('workbench.action.reloadWindow'),
    closePanel,
    readUpdateState: () => updater?.getState() || null,
    checkUpdates: () => updater.check(true),
    setUpdateMode: mode => updater.setMode(mode),
    log: error => output.appendLine(error.stack || String(error))
  });
  context.subscriptions.push(panel);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('frostedBackground.controls', panel));
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 40);
  statusItem.text = '$(color-mode) 毛玻璃';
  statusItem.tooltip = '打开毛玻璃背景控制面板';
  statusItem.command = 'frostedBackground.openPanel';
  statusItem.show();
  context.subscriptions.push(statusItem);

  updater = new UpdateController(vscode, context, {
    repository: context.extension?.packageJSON?.frostedBackgroundUpdates?.repository || '',
    currentVersion: extensionVersion,
    extensionId: 'local-frosted.frosted-background',
    runExclusive,
    log: error => output.appendLine('插件更新：' + (error.stack || String(error))),
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
    const mediaPath = context.globalState.get('mediaPath');
    if (!mediaPath) {
      const kind = await vscode.window.showQuickPick([
        { label: '$(file-media) 选择图片', kind: 'image' },
        { label: '$(play-circle) 选择视频', kind: 'video' }
      ], { placeHolder: '选择背景类型' });
      if (kind) await chooseMedia(kind.kind);
      return;
    }
    await applyMedia(mediaPath);
  });
  command('restore', () => restoreBackground());
  command('status', async () => {
    const state = await patcher.status({ appRoot: vscode.env.appRoot });
    const mediaPath = context.globalState.get('mediaPath');
    await vscode.window.showInformationMessage(
      '毛玻璃背景：' + (state.installed ? '已应用' : '未应用') +
      (mediaPath ? '；上次选择：' + path.basename(mediaPath) : '') + '。当前 VS Code ' + vscode.version + '。'
    );
  });

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('frostedBackground') || savingConfig) return;
    panel.refresh();
    if (!Object.keys(DEFAULTS).some(key => event.affectsConfiguration('frostedBackground.' + key))) return;
    if (!context.globalState.get('enabled', false)) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(async () => {
      if (disposed) return;
      const choice = await vscode.window.showInformationMessage('毛玻璃效果设置已修改，应用后重载窗口即可生效。', '应用设置');
      if (choice === '应用设置' && !disposed) await vscode.commands.executeCommand('frostedBackground.apply');
    }, 1200);
  }));
  context.subscriptions.push({ dispose: () => { disposed = true; clearTimeout(changeTimer); } });

  // An extension update can refresh an already-enabled, consented background.
  // A missing patch (such as after VS Code itself updates) always needs manual apply.
  if (vscode.env.uiKind === vscode.UIKind.Desktop && context.globalState.get('enabled', false)) {
    patcher.status({ appRoot: vscode.env.appRoot }).then(async state => {
      if (disposed || busy || !context.globalState.get('enabled', false)) return;
      const upgraded = context.globalState.get('lastAppliedExtensionVersion') !== extensionVersion;
      if (state.installed && !upgraded) return;
      if (state.installed && upgraded && context.globalState.get('injectionConsent', false) && updater.readMode() === 'automatic') {
        try {
          await runExclusive(async () => {
            await patcher.reapply({ appRoot: vscode.env.appRoot, rendererPath: context.asAbsolutePath('media/renderer.js') });
            await context.globalState.update('lastAppliedExtensionVersion', extensionVersion);
          });
          offerReload('新版背景效果已自动准备好。');
          return;
        } catch (error) {
          output.appendLine('自动迁移背景未完成：' + describeError(error));
        }
      }
      const message = state.installed ? '毛玻璃背景已更新，请在控制面板中应用一次，让新效果生效。' : '背景尚未应用到这份 VS Code 安装（例如更新之后），可以在控制面板重新应用。';
      const choice = await vscode.window.showInformationMessage(message, '打开控制面板');
      if (choice === '打开控制面板' && !disposed) await vscode.commands.executeCommand('frostedBackground.openPanel');
    }).catch(error => output.appendLine('启动检查：' + describeError(error)));
  }
}

function deactivate() {}
module.exports = { activate, deactivate };
