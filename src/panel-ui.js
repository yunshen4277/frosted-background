'use strict';

const { normalizeLanguage, t } = require('../media/i18n');

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function renderPanelHtml({ cspSource, scriptUri, styleUri, i18nUri, nonce, language = 'en' }) {
  language = normalizeLanguage(language);
  const text = key => escapeAttribute(t(language, key));
  const label = key => `<span data-i18n="${escapeAttribute(key)}">${text(key)}</span>`;
  const asset = escapeAttribute(cspSource);
  const token = escapeAttribute(nonce);
  return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${asset} data:; media-src ${asset}; style-src ${asset}; script-src 'nonce-${token}';">
  <link href="${escapeAttribute(styleUri)}" rel="stylesheet">
  <title data-i18n="毛玻璃背景">${text("毛玻璃背景")}</title>
</head>
<body>
  <main id="panel" aria-busy="true">
    <div class="panel-toolbar"><label for="language">${label("语言")}</label><select id="language" data-i18n-aria-label="语言" aria-label="${text("语言")}"><option value="en"${language === 'en' ? ' selected' : ''}>English</option><option value="zh-CN"${language === 'zh-CN' ? ' selected' : ''}>简体中文</option><option value="es"${language === 'es' ? ' selected' : ''}>Español</option></select><button type="button" class="close-panel-button" id="close-panel" data-i18n-aria-label="关闭控制面板" aria-label="${text("关闭控制面板")}" data-i18n-title="关闭控制面板" title="${text("关闭控制面板")}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button></div>
    <header class="panel-heading">
      <div><div class="eyebrow"><span class="brand-dot"></span>FROSTED / EDITOR</div><h1>${label("毛玻璃背景")}</h1></div>
      <div class="heading-actions"><span class="status-pill" id="status"><span></span><span id="status-text">${label("连接中")}</span></span></div>
    </header>

    <section class="preview-section" data-i18n-aria-label="背景效果预览" aria-label="${text("背景效果预览")}">
      <div class="preview" id="preview">
        <div class="preview-base" aria-hidden="true"></div>
        <div class="preview-media" id="preview-media" aria-hidden="true"></div>
        <div class="preview-tint" aria-hidden="true"></div>
        <div class="preview-topline"><span class="preview-caption">${label("效果预览")}</span><span class="preview-live"><span></span>${label("实时")}</span></div>
        <div class="preview-code" aria-hidden="true">
          <div><i>01</i><span class="syntax-muted">${label("// 留一点风景给灵感")}</span></div>
          <div><i>02</i><span class="syntax-purple">const</span> <span class="syntax-blue">focus</span> = {</div>
          <div><i>03</i>&nbsp;&nbsp;clarity: <span class="syntax-green">'always'</span>,</div>
          <div><i>04</i>&nbsp;&nbsp;inspiration: <span class="syntax-orange">∞</span></div>
          <div><i>05</i>};</div>
        </div>
        <span class="preview-empty" id="preview-empty">${label("选择一张图片，或一段风景")}</span>
        <span class="preview-error" id="preview-error" hidden></span>
      </div>
      <div class="media-caption"><span class="media-kind" id="media-kind">${label("未选择背景")}</span><span class="media-name" id="media-name">${label("从本机选择文件")}</span></div>
      <div class="media-actions">
        <button type="button" class="secondary-button" id="choose-image"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2"/><circle cx="7" cy="7.5" r="1.3"/><path d="m3 14 4-4 3.5 3 2.5-2.5 4 4"/></svg>${label("选择图片")}</button>
        <button type="button" class="secondary-button" id="choose-video"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="m8 7 5 3-5 3Z"/></svg>${label("选择视频")}</button>
      </div>
    </section>

    <section class="effects-section" aria-labelledby="effects-heading">
      <div class="section-heading"><h2 id="effects-heading">${label("玻璃质感")}</h2><button type="button" class="text-button" id="reset" data-i18n-title="将效果恢复为默认值" title="${text("将效果恢复为默认值")}">${label("恢复默认")}</button></div>
      <div class="presets" role="group" data-i18n-aria-label="效果预设" aria-label="${text("效果预设")}"><button type="button" class="preset" data-preset="soft" aria-pressed="false"><span>◌</span>${label("柔和")}</button><button type="button" class="preset" data-preset="clear" aria-pressed="false"><span>◇</span>${label("清透")}</button><button type="button" class="preset" data-preset="focus" aria-pressed="false"><span>◎</span>${label("专注")}</button></div>
      <div class="range-control"><div class="control-label"><label for="blur">${label("模糊程度")}</label><output for="blur" id="blur-value">14 px</output></div><input type="range" id="blur" min="0" max="60" step="1" value="14"><div class="range-hints"><span>${label("清晰")}</span><span>${label("朦胧")}</span></div></div>
      <div class="range-control"><div class="control-label"><label for="opacity">${label("背景浓度")}</label><output for="opacity" id="opacity-value">35%</output></div><input type="range" id="opacity" min="0.05" max="1" step="0.01" value="0.35"></div>
      <div class="range-control"><div class="control-label"><label for="tintOpacity">${label("玻璃蒙层")}</label><output for="tintOpacity" id="tintOpacity-value">18%</output></div><input type="range" id="tintOpacity" min="0" max="0.9" step="0.01" value="0.18"></div>
      <details class="advanced"><summary>${label("亮度与色彩")}<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg></summary><div class="advanced-content">
        <div class="range-control"><div class="control-label"><label for="brightness">${label("亮度")}</label><output for="brightness" id="brightness-value">100%</output></div><input type="range" id="brightness" min="0.2" max="2" step="0.05" value="1"></div>
        <div class="range-control"><div class="control-label"><label for="saturation">${label("饱和度")}</label><output for="saturation" id="saturation-value">100%</output></div><input type="range" id="saturation" min="0" max="2" step="0.05" value="1"></div>
      </div></details>
    </section>

    <section class="layout-section" aria-labelledby="layout-heading">
      <div class="section-heading"><h2 id="layout-heading">${label("画面布局")}</h2><span class="subtle-label">${label("随窗口自适应")}</span></div>
      <fieldset class="fit-control" aria-describedby="fit-description"><legend class="sr-only">${label("背景缩放方式")}</legend><label><input type="radio" name="fit" value="cover" checked><span>${label("等比铺满")}</span></label><label><input type="radio" name="fit" value="contain"><span>${label("完整显示")}</span></label><label><input type="radio" name="fit" value="fill"><span>${label("完整压缩")}</span></label></fieldset>
      <p class="fit-description" id="fit-description">${label("等比铺满，允许裁剪边缘")}</p>
      <div class="select-control"><label for="position">${label("对齐位置")}</label><select id="position"><option value="center center" data-i18n="居中">${text("居中")}</option><option value="center top" data-i18n="顶部">${text("顶部")}</option><option value="center bottom" data-i18n="底部">${text("底部")}</option><option value="left center" data-i18n="靠左">${text("靠左")}</option><option value="right center" data-i18n="靠右">${text("靠右")}</option></select></div>
    </section>

    <section class="video-section" id="video-section" aria-labelledby="video-heading" hidden>
      <div class="section-heading"><h2 id="video-heading">${label("视频播放")}</h2><span class="subtle-label">${label("静音 · 循环")}</span></div>
      <div class="range-control"><div class="control-label"><label for="playbackRate">${label("播放速度")}</label><output for="playbackRate" id="playbackRate-value">1×</output></div><input type="range" id="playbackRate" min="0.25" max="2" step="0.25" value="1"></div>
      <label class="switch-control" for="pauseWhenUnfocused"><span>${label("切换窗口时暂停")}<small>${label("减少后台资源占用")}</small></span><input type="checkbox" role="switch" id="pauseWhenUnfocused" checked><span class="switch-track" aria-hidden="true"></span></label>
      <label class="switch-control" for="respectReducedMotion"><span>${label("跟随系统减少动态效果")}</span><input type="checkbox" role="switch" id="respectReducedMotion" checked><span class="switch-track" aria-hidden="true"></span></label>
    </section>

    <section class="update-section" id="update-section" aria-labelledby="update-heading" hidden>
      <div class="section-heading"><h2 id="update-heading">${label("插件更新")}</h2><span class="version-label" id="current-version"></span></div>
      <div class="select-control update-mode-control"><label for="update-mode">${label("更新方式")}</label><select id="update-mode"><option value="automatic" data-i18n="自动更新">${text("自动更新")}</option><option value="notify" data-i18n="仅通知">${text("仅通知")}</option><option value="off" data-i18n="关闭">${text("关闭")}</option></select></div>
      <div class="update-action-row"><button type="button" class="secondary-button check-update-button" id="check-updates">${label("检查更新")}</button><span class="available-version" id="available-version" hidden></span></div>
      <div class="update-message" id="update-message" role="status"></div>
    </section>

    <div class="feedback" id="error" role="alert" hidden></div>
    <div class="notice" id="notice" role="status" hidden></div>
    <div class="panel-footnote">${label("预览即时更新，编辑区效果应用后重载生效。")}</div>
  </main>
  <footer class="action-bar">
    <div class="draft-label" id="draft-label" aria-live="polite">${label("把喜欢的风景，放进代码里")}</div>
    <button type="button" class="primary-button" id="apply" disabled><span id="apply-label">${label("应用到编辑区")}</span><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10m-4-4 4 4-4 4"/></svg></button>
    <div class="footer-secondary"><button type="button" class="text-button" id="restore" disabled>${label("关闭背景并恢复")}</button><button type="button" class="reload-button" id="reload" hidden>${label("重载窗口 ↗")}</button></div>
  </footer>
  <script nonce="${token}" src="${escapeAttribute(i18nUri)}"></script>
  <script nonce="${token}" src="${escapeAttribute(scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { renderPanelHtml };
