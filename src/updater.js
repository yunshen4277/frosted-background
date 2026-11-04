'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const transport = require('./github-update');
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const MODES = ['automatic', 'notify', 'off'];

class UpdateController {
  constructor(vscode, context, options, services = {}) {
    this.vscode = vscode;
    this.context = context;
    this.options = options;
    this.services = { ...transport, now: Date.now, setTimeout, clearTimeout, ...services };
    this.disposed = false;
    this.inFlight = null;
    this.timer = undefined;
    this.abort = new AbortController();
    const pending = context.globalState.get('pendingUpdateVersion');
    const currentParts = options.currentVersion.split('.').map(Number);
    const pendingParts = typeof pending === 'string' && /^\d+\.\d+\.\d+$/.test(pending) ? pending.split('.').map(Number) : null;
    const newer = pendingParts && pendingParts.some((part, index) => part > currentParts[index] && pendingParts.slice(0, index).every((previous, i) => previous === currentParts[i]));
    this.state = {
      currentVersion: options.currentVersion, repository: options.repository || '', mode: this.readMode(),
      status: !options.repository ? 'unconfigured' : newer ? 'pending' : 'idle',
      message: !options.repository ? '尚未绑定 GitHub 发布仓库。' : newer ? `已安装 ${pending}，重载窗口后加载新版。` : '更新来自此插件的 GitHub 发布仓库。',
      availableVersion: null, pendingVersion: newer ? pending : null
    };
    if (pending && !newer) context.globalState.update('pendingUpdateVersion', undefined).catch(error => options.log(error));
  }

  readMode() {
    const mode = this.vscode.workspace.getConfiguration('frostedBackground').get('updateMode');
    return MODES.includes(mode) ? mode : 'automatic';
  }

  getState() { return { ...this.state, mode: this.readMode() }; }

  publish(changes) {
    if (this.disposed) return;
    this.state = { ...this.state, mode: this.readMode(), ...changes };
    this.options.onChange?.(this.getState());
  }

  async setMode(mode) {
    if (!MODES.includes(mode) || this.disposed) return;
    await this.vscode.workspace.getConfiguration('frostedBackground').update('updateMode', mode, this.vscode.ConfigurationTarget.Global);
    this.publish({ mode });
  }

  start() {
    if (this.disposed || !this.options.repository || this.timer !== undefined) return;
    const schedule = delay => {
      this.timer = this.services.setTimeout(async () => {
        this.timer = undefined;
        await this.check(false);
        if (!this.disposed) schedule(CHECK_INTERVAL);
      }, delay);
      this.timer?.unref?.();
    };
    schedule(30000);
  }

  check(manual = false) {
    if (this.disposed) return Promise.resolve(this.getState());
    if (this.inFlight) return this.inFlight;
    const work = async () => {
      try {
        if (!this.options.repository) {
          this.publish({ status: 'unconfigured', message: '尚未绑定 GitHub 发布仓库，当前版本不能在线更新。' });
          return this.getState();
        }
        if (this.state.pendingVersion) {
          this.publish({ status: 'pending', message: `已安装 ${this.state.pendingVersion}，重载窗口后加载新版。` });
          if (manual) this.offerReload();
          return this.getState();
        }
        const mode = this.readMode();
        if (!manual && mode === 'off') return this.getState();
        const previous = this.context.globalState.get('lastUpdateCheckAt', 0);
        if (!manual && previous > 0 && this.services.now() - previous < CHECK_INTERVAL) return this.getState();
        const execute = this.options.runExclusive || (callback => callback());
        return await (async () => {
          if (this.disposed) return this.getState();
          this.publish({ status: 'checking', message: '正在检查 GitHub 更新…' });
          const release = await this.services.findRelease({
            repository: this.options.repository, currentVersion: this.options.currentVersion,
            extensionId: this.options.extensionId, signal: this.abort.signal
          });
          if (this.disposed) return this.getState();
          await this.context.globalState.update('lastUpdateCheckAt', this.services.now());
          if (!release) {
            this.publish({ status: 'idle', message: '当前已是最新发布版本。', availableVersion: null });
            return this.getState();
          }
          this.publish({ status: 'available', message: `发现新版本 ${release.version}。`, availableVersion: release.version });
          const activeMode = this.readMode();
          if (!manual && activeMode === 'off') return this.getState();
          let install = activeMode === 'automatic';
          let explicitInstall = false;
          if (!install) {
            if (manual || this.context.globalState.get('lastNotifiedUpdate') !== release.version) {
              await this.context.globalState.update('lastNotifiedUpdate', release.version);
              if (manual) {
                const choice = await this.vscode.window.showInformationMessage(`毛玻璃背景有新版本 ${release.version}。`, '安装更新');
                install = choice === '安装更新';
                explicitInstall = install;
              } else {
                this.vscode.window.showInformationMessage(`毛玻璃背景有新版本 ${release.version}。`, '查看更新').then(choice => {
                  if (choice === '查看更新' && !this.disposed) return this.check(true);
                }).then(undefined, error => this.options.log(error));
              }
            }
          }
          if (!install || this.disposed) return this.getState();
          this.publish({ status: 'installing', message: `正在下载并验证 ${release.version}…` });
          const storage = this.context.globalStorageUri?.fsPath;
          if (!storage) throw new Error('无法定位本机更新缓存目录。');
          const directory = path.join(storage, 'updates');
          let downloaded;
          try {
            downloaded = await this.services.downloadRelease({
              release, repository: this.options.repository, extensionId: this.options.extensionId,
              currentVersion: this.options.currentVersion, directory, signal: this.abort.signal
            });
            if (this.disposed) return this.getState();
            if (!explicitInstall && this.readMode() !== 'automatic') {
              this.publish({ status: 'available', message: '自动安装已停止；可手动检查并安装此版本。' });
              return this.getState();
            }
            await execute(() => this.vscode.commands.executeCommand('workbench.extensions.installExtension', this.vscode.Uri.file(downloaded.filePath)));
            if (this.disposed) return this.getState();
            await this.context.globalState.update('pendingUpdateVersion', release.version);
            this.publish({ status: 'pending', message: `已安装 ${release.version}，重载窗口后加载新版。`, pendingVersion: release.version });
          } finally {
            // Delete only this validated download, never recursively remove storage.
            if (downloaded && path.dirname(path.resolve(downloaded.filePath)) === path.resolve(directory)) {
              await fs.unlink(downloaded.filePath).catch(error => { if (error.code !== 'ENOENT') this.options.log(error); });
            }
          }
          this.offerReload();
          return this.getState();
        })();
      } catch (error) {
        if (!this.disposed) {
          this.options.log(error);
          this.publish({ status: 'error', message: '更新未完成：' + (error.message || String(error)) });
          if (manual) this.vscode.window.showWarningMessage(this.state.message);
        }
        return this.getState();
      }
    };
    this.inFlight = work().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  offerReload() {
    this.vscode.window.showInformationMessage('毛玻璃背景新版已安装，重载后启用。背景渲染器迁移完成后可能还会提示再重载一次。', '重载窗口').then(choice => {
      if (choice === '重载窗口' && !this.disposed) return this.vscode.commands.executeCommand('workbench.action.reloadWindow');
    }).then(undefined, error => this.options.log(error));
  }

  dispose() {
    this.disposed = true;
    this.abort.abort();
    if (this.timer !== undefined) this.services.clearTimeout(this.timer);
    this.timer = undefined;
  }
}

module.exports = { UpdateController, CHECK_INTERVAL };
