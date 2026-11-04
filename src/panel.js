'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULTS, normalizeConfig } = require('./config');
const { renderPanelHtml } = require('./panel-ui');

// A webview can change values, but only the native file picker chooses paths.
class BackgroundPanel {
  constructor(vscode, context, callbacks) {
    this.vscode = vscode;
    this.context = context;
    this.callbacks = callbacks;
    this.mediaPath = context.globalState.get('mediaPath');
    this.pending = false;
    this.error = null;
    this.notice = null;
    this.needsReload = false;
    this.disposables = [];
    this.disposed = false;
  }

  resolveWebviewView(view) {
    this.clearViewSubscriptions();
    this.view = view;
    const mediaRoot = this.vscode.Uri.file(this.context.asAbsolutePath('media'));
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    webview.html = renderPanelHtml({
      cspSource: webview.cspSource,
      scriptUri: webview.asWebviewUri(this.vscode.Uri.file(this.context.asAbsolutePath('media/panel.js'))).toString(),
      styleUri: webview.asWebviewUri(this.vscode.Uri.file(this.context.asAbsolutePath('media/panel.css'))).toString(),
      nonce: crypto.randomBytes(24).toString('base64')
    });
    this.disposables.push(webview.onDidReceiveMessage(message => {
      this.receive(message).catch(error => {
        this.callbacks.log(error);
      });
    }));
    this.disposables.push(view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
      this.clearViewSubscriptions();
    }));
    if (view.onDidChangeVisibility) this.disposables.push(view.onDidChangeVisibility(() => {
      if (view.visible) this.refresh();
    }));
  }

  refresh({ resetDraft = false, syncMedia = false } = {}) {
    if (syncMedia) this.mediaPath = this.context.globalState.get('mediaPath');
    if (!this.view || this.disposed) return;
    const webview = this.view.webview;
    const roots = [this.vscode.Uri.file(this.context.asAbsolutePath('media'))];
    let media = null;
    if (this.mediaPath) {
      roots.push(this.vscode.Uri.file(path.dirname(this.mediaPath)));
      media = {
        name: path.basename(this.mediaPath),
        kind: /\.(mp4|webm)$/i.test(this.mediaPath) ? 'video' : 'image',
        uri: webview.asWebviewUri(this.vscode.Uri.file(this.mediaPath)).toString()
      };
    }
    webview.options = { enableScripts: true, localResourceRoots: roots };
    const update = this.callbacks.readUpdateState?.() || null;
    const state = {
      type: 'state', config: this.callbacks.readConfig(), defaults: { ...DEFAULTS },
      enabled: this.context.globalState.get('enabled', false), media,
      busy: this.pending || this.callbacks.isBusy(), error: this.error,
      notice: this.notice, needsReload: this.needsReload || Boolean(update?.pendingVersion), resetDraft, update
    };
    return Promise.resolve(webview.postMessage(state)).catch(error => this.callbacks.log(error));
  }

  async receive(message) {
    if (this.disposed || !message || typeof message !== 'object' || Array.isArray(message)) return;
    if (!['ready', 'chooseMedia', 'apply', 'restore', 'reload', 'checkUpdates', 'setUpdateMode'].includes(message.type)) return;
    if (message.type === 'ready') return this.refresh();
    if (this.pending || this.callbacks.isBusy()) return;
    if (message.type === 'chooseMedia' && !['image', 'video'].includes(message.kind)) return;
    if (message.type === 'apply' && (!message.config || typeof message.config !== 'object' || Array.isArray(message.config))) return;
    if (message.type === 'setUpdateMode' && !['automatic', 'notify', 'off'].includes(message.mode)) return;
    this.pending = true;
    this.error = null;
    this.notice = null;
    await this.refresh();
    let resetDraft = false;
    try {
      if (message.type === 'chooseMedia') {
        const selected = await this.callbacks.chooseMedia(message.kind);
        if (selected) {
          this.mediaPath = selected;
          this.notice = '已载入预览，调整后点击“应用到编辑区”。';
        }
      } else if (message.type === 'apply') {
        if (!this.mediaPath) throw new Error('请先选择一张图片或一段视频。');
        const result = await this.callbacks.apply(this.mediaPath, normalizeConfig(message.config));
        if (!result?.cancelled) {
          this.needsReload = result?.needsReload !== false;
          this.notice = result?.notice || '背景已应用，重载窗口后在编辑区生效。';
          resetDraft = result?.resetDraft !== false;
        }
      } else if (message.type === 'restore') {
        const result = await this.callbacks.restore();
        this.needsReload = result?.needsReload !== false;
        this.notice = result?.notice || '背景已关闭，重载窗口后恢复原界面。';
      } else if (message.type === 'reload') {
        if (this.needsReload || this.callbacks.readUpdateState?.()?.pendingVersion) await this.callbacks.reload();
      } else if (message.type === 'checkUpdates') {
        await this.callbacks.checkUpdates?.();
      } else if (message.type === 'setUpdateMode') {
        await this.callbacks.setUpdateMode?.(message.mode);
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.callbacks.log(error);
    } finally {
      this.pending = false;
      await this.refresh({ resetDraft });
    }
  }

  clearViewSubscriptions() {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  dispose() {
    this.disposed = true;
    this.view = undefined;
    this.clearViewSubscriptions();
  }
}

module.exports = { BackgroundPanel };
