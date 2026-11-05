# Frosted Background · 毛玻璃背景

为 VS Code 的整个代码编辑区设置本地图片或视频背景。背景单独模糊，代码文字保持清晰；窗口缩放、侧栏展开、面板调整和编辑器分屏时，背景自动跟随编辑区大小。

## 安装和使用（0.6.0）

1. 在 VS Code 中按 `Ctrl+Shift+P`（macOS：`Cmd+Shift+P`），运行 **Extensions: Install from VSIX… / 扩展: 从 VSIX 安装…**。
2. 选择 `frosted-background-0.6.0.vsix`。如果安装过旧版，覆盖安装后重载窗口。
3. 点击状态栏右下角的 **Frosted**，或者左侧活动栏的背景图标，打开控制面板。也可以运行 **Frosted Background: Open Control Panel**（中文 VS Code 中为 **毛玻璃背景: 打开控制面板**）。界面默认英文；在顶部 **Language** 下拉框选择 **简体中文** 后，可按下面的中文按钮操作。
4. 在面板里点击 **选择图片** 或 **选择视频**，选择本机文件。拖动滑块即可查看面板内预览，代码文字不会被模糊。
5. 调整满意后点击 **应用到编辑区**。首次启用时阅读界面修改说明，再点击 **启用背景**。
6. 点击面板里的 **重载窗口**，背景就会出现在代码区。后续调整窗口大小时自动适应。

**从旧版升级后，已授权且启用的背景会在自动更新模式下迁移到新版渲染器，并提示重载。** 旧背景和最后应用的参数会沿用，无需先卸载旧版。原图即使移动或删除，也可使用经过校验的本地缓存完成迁移。如果没有自动迁移提示，在面板里点击“应用到编辑区”，再重载即可。

面板集中包含图片/视频选择、效果预览、柔和/清透/专注预设、模糊程度、背景浓度、玻璃蒙层、亮度、饱和度、画面布局及视频播放选项。点击“亮度与色彩”可展开更多滑块；选择视频后显示播放选项。**滑块即时更新的是面板预览，编辑区需要应用后重载。**

点击控制面板顶部的 **× 关闭控制面板** 可收起侧栏，当前背景继续显示，未应用的参数也会保留。再次点击活动栏背景图标或状态栏“毛玻璃”即可打开。底部的“关闭背景并恢复”用于停用背景，是另一项操作。

想把小面板放到右侧，可以在 VS Code 中把“毛玻璃背景”视图容器拖到辅助侧栏。插件的关闭按钮收起默认的主侧栏；移动到辅助侧栏后，请使用 VS Code 自带的关闭辅助侧栏入口。面板使用当前主题配色，支持窄侧栏和键盘操作。

原有命令仍保留供快捷键或脚本调用；命令面板主要显示统一入口，以及应用和恢复命令，减少零散选项。

## 语言 / Language / Idioma

面板顶部的语言菜单支持 **English**、**简体中文**、**Español**。首次使用和首次升级到 0.6.0 时默认英语；选择会保存在本机，重新打开面板或重启 VS Code 后继续使用。

切换立即更新面板、状态栏、更新状态和后续操作提示，无需点击应用或重载。未应用的参数、所选媒体和视频播放进度会保留；正在应用背景或检查更新时也能切换。语言选择只改变插件自身的界面，不修改工作区和 VS Code 的显示语言。

VS Code 命令面板、活动栏名称及系统设置中的扩展说明使用 VS Code 自己的显示语言，支持英／中／西，其他语言回退英语。它们与面板顶部的语言选择独立；已经弹出的系统通知保留弹出时的语言。

**English:** Use **Language → English / 简体中文 / Español** at the top of the controls. English is the default. Changes apply immediately and are saved locally; no reload is needed for a language change.

**Español:** Usa **Idioma → English / 简体中文 / Español** en la parte superior del panel. El inglés es el idioma predeterminado. El cambio es inmediato y se guarda en este equipo; no necesitas recargar la ventana para cambiar el idioma.

## GitHub 自动更新

**首次需要手动安装带更新功能的 0.3.0 或更新版本。** 将旧版本仅仅上传到 GitHub，并不会给已安装的 0.1.0/0.2.0 增加在线更新能力。

从本仓库 Releases 下载的版本会绑定当前发布仓库。面板底部的“插件更新”集中显示版本、更新方式和检查结果：

- **自动更新**（默认）：启动约 30 秒后检查，此后每 6 小时检查一次。有新版时自动下载、校验并调用 VS Code 安装。
- **仅通知**：发现新版时通知，由你决定是否安装。
- **关闭**：停止后台检查，仍可点击“检查更新”。

插件不会自行重载窗口。安装完成后点击“重载窗口”以启用新版；如果新版需要迁移背景渲染器，迁移结束后可能再提示重载一次。不会自动关闭正在编辑的文件。

更新只接受绑定仓库的稳定版 Releases，核对版本、扩展标识和 SHA-256，使用 VS Code 自带的安装命令。校验失败、网络不通或 VS Code 不兼容时保留现有版本。SHA-256 用于发现文件损坏，并不代替对仓库发布者的信任。

自动更新会连接 GitHub 获取发布信息及安装包，不上传你的图片、视频、代码或本地文件路径。不需要在插件里填写 GitHub Token；目前只支持公开仓库。

源码默认不绑定账号。GitHub 工作流在打包时自动写入实际的 `owner/repository`；本地未绑定的开发包会显示“尚未绑定 GitHub 发布仓库”，不会连接任意默认仓库。手动打包前可运行 `node scripts/bind-repository.js <你的账号>/<仓库名>`。

## 效果

- 图片：PNG、JPG/JPEG、WebP、GIF、BMP、AVIF；实际解码能力取决于当前 VS Code 内置浏览器。
- 视频：WebM、MP4，始终静音、循环播放。推荐 **WebM（VP8/VP9）**；MP4 能否播放取决于当前 VS Code 的视频解码支持，扩展不会转码。
- 0.4.0 调整了本地视频加载方式，兼容 VS Code 的本地资源协议。首帧需等待缓存视频读取完成，较大文件可能稍有等待；这不会增加浏览器本身不支持的编码能力。
- `cover`：默认等比铺满，宽高比不一致时裁剪边缘，不拉伸。
- `contain`：保留整个画面，空白区域显示主题底色。
- `fill`（完整压缩）：将图片或视频的完整画面按可见代码区的宽高压缩铺满，不按原比例放大裁剪。窗口再小也保留全幅内容，可能出现横向或纵向变形；希望保持原始比例时可选择“完整显示”。
- 深色、浅色主题使用相应的主题底色作为毛玻璃蒙层。
- 滚动时顶部置顶代码行（Sticky Scroll）使用半透明毛玻璃，不再出现不透明黑条；置顶行保持清晰、可点击。
- 失去焦点时默认暂停视频，窗口隐藏时始终暂停。遵循系统的“减少动态效果”设置。
- 整个编辑区使用同一幅背景，分屏不会重复创建视频播放器。
- 只影响编辑区，侧栏、终端等区域保持原有外观。独立 Webview 编辑器有自己的页面，不保证透明显示背景。

建议使用 1080p 图片或短视频。大型、高帧率或 4K 视频会增加 GPU、内存占用及首次加载等待。单个文件上限为 500 MiB。

## 设置

| 设置 | 默认值 | 用途 |
| --- | --- | --- |
| `frostedBackground.blur` | `14` | 模糊半径，0–60 像素 |
| `frostedBackground.opacity` | `0.35` | 背景浓度，0.05–1 |
| `frostedBackground.tintOpacity` | `0.18` | 主题色毛玻璃蒙层浓度，0–0.9 |
| `frostedBackground.saturation` | `1` | 饱和度，0–2 |
| `frostedBackground.brightness` | `1` | 亮度，0.2–2 |
| `frostedBackground.fit` | `"cover"` | 等比铺满 / 完整显示 / 完整压缩 |
| `frostedBackground.position` | `"center center"` | 居中、顶部、底部、左侧或右侧 |
| `frostedBackground.playbackRate` | `1` | 视频速度，0.25–2 倍 |
| `frostedBackground.pauseWhenUnfocused` | `true` | 失去焦点时暂停视频 |
| `frostedBackground.respectReducedMotion` | `true` | 遵循减少动态效果设置 |
| `frostedBackground.updateMode` | `"automatic"` | 自动更新 / 仅通知 / 关闭 |

更明显的毛玻璃效果可以从 `blur: 20`、`opacity: 0.45` 开始调整。若背景影响阅读，降低 `opacity` 或提高 `tintOpacity`。

## 运行方式与限制

VS Code [官方扩展接口不允许访问编辑器 DOM 或加载自定义界面样式](https://code.visualstudio.com/api/extension-capabilities/overview#restrictions)。因此，本插件通过在桌面版 VS Code 的 `workbench.html` 中加入带标记的本地脚本，创建背景层。它不是官方支持的界面定制接口。

- **可能显示“安装似乎已损坏”的完整性提示**。插件不会修改或绕过 VS Code 的校验机制。
- 首次启用时保留 HTML 备份。恢复时仅去掉本插件的标记块，保留其他工具后来写入的内容。
- 图片或视频被复制到 VS Code 安装目录内的专用资源文件夹，不上传到任何服务。原文件路径只存于本机扩展状态。手动重新应用时仍需要原文件存在；如果已经移动或删除，请重新选择文件。插件升级时可复用已校验的缓存媒体。
- 视频由独立的本地播放页面读取缓存并播放，不修改工作台页面原有的内容安全策略（CSP），也不会加载远程视频。
- 切换背景时保留旧媒体副本，避免打断其他尚未重载的窗口；运行恢复命令时清理这些副本。
- 生效范围是**当前这份 VS Code 安装**，所有窗口和配置文件共用最后应用的背景。已打开的其他窗口也需要重载。切换配置文件不会自动切换背景。
- 更新 VS Code 后，运行 **应用设置 / 更新后修复**。VS Code 更新也可能改变内部界面结构，需要更新此扩展。
- 需要安装目录可写。Windows 用户安装版通常更合适；受管理员管理或只读的安装无法应用。
- 仅用于桌面版 VS Code。远程开发时应安装到本机一侧，并选择本机文件；不支持 vscode.dev 等网页版。
- 元素结构只针对 VS Code；未承诺兼容 Cursor 等衍生编辑器。其他背景或自定义 CSS 插件可能发生冲突。

## 关闭和卸载

**卸载前先运行“毛玻璃背景: 关闭背景并恢复原状”，并重载所有窗口。** 随后可正常卸载扩展。VS Code 没有可靠的扩展卸载回调，仅卸载扩展不会自动清除已经写入的界面文件。

也可以在控制面板底部点击 **关闭背景并恢复**，再点击 **重载窗口**。

如果已经先卸载了扩展，重新安装本 VSIX，然后执行恢复命令。也可以重新安装同版本或更新版本的 VS Code 来恢复原始界面资源。

恢复命令会移除插件自己的注入标记和已识别的资源，其他工具的修改不会被旧备份覆盖。恢复后保留的原始 HTML 备份仅用于手动排查。

## 开发

扩展运行时使用 Node.js 内置库，不依赖额外运行时包。入口为 `src/extension.js`，界面注入和文件恢复逻辑在 `src/patcher.js`，背景渲染在 `media/renderer.js`，统一面板由 `src/panel.js`、`src/panel-ui.js` 与 `media/panel.*` 实现。

```sh
npm install
npm test
npm run package
```

打包生成 VSIX 和完整源码 ZIP。可以在本目录按 F5 启动扩展开发窗口；注意启用背景仍会修改该开发窗口使用的 VS Code 安装，建议使用独立的测试安装。

自动化测试包含文件注入、恢复、配置边界及模拟扩展命令。浏览器渲染测试需要 Playwright 和可运行的 Chromium 浏览器；详见 `test` 目录。离线打包可使用 `node scripts/package.js --modules <已有的 node_modules 目录>`。

Chrome / Playwright 回归验证的是浏览器中的编辑区模拟页面和本地视频播放器，不等同于原生 VS Code 窗口验收；不同 VS Code 版本的视频编码能力仍需在实际安装中确认。

更新传输及安装流程测试使用离线响应，不会下载或安装远程扩展。公开仓库的上传与 Releases 端到端检查须在建立 GitHub 连接、发布首个版本后完成。

## 维护者发布新版本

首次可以完全通过 GitHub 网页发布：

1. 将源码上传到公开仓库的 `main` 分支根目录，保留 `.github/workflows`、`scripts`、`src`、`media` 和 `test` 目录；不要只上传源码 ZIP。
2. 在仓库 **Actions → CI** 等待检查通过。确认 `package.json` 是要发布的稳定版本（当前为 `0.4.0`）。
3. 打开 **Actions → Release → Run workflow**，分支选择 **main**，再点击 **Run workflow**。无需预先创建标签或 Release。
4. 工作流从 `package.json` 派生版本标签（当前为 `v0.4.0`），完成仓库绑定、测试、打包与校验后，为本次运行的提交创建标签和公开 Release，上传 VSIX、源码 ZIP 与 `update-manifest.json`。
5. 从新建 Release 下载并手动安装一次 VSIX，此安装包才包含当前仓库的自动更新来源。

后续发布时，先修改代码并增加 `package.json` 的稳定版本号（例如 `0.4.1`），提交到 `main` 并等待 CI 通过，再运行上述 Release 工作流。也可以直接创建并推送匹配版本的标签（例如 `v0.4.1`）触发发布；工作流仍会严格核对实际标签和包版本。

只允许从 `main` 手动运行或从版本标签发布。已有 Release 不会被覆盖；如果标签已经存在但尚无 Release，请在 **Run workflow** 的引用选择器中选择该标签。不要先在网页手动创建同名 Release，否则工作流会停止，保留已有发布和资产。

工作流使用仓库自带的 `GITHUB_TOKEN`，不要求把个人 Token 放进代码或设置仓库密钥。保留扩展标识 `local-frosted.frosted-background`，已有安装才能正常升级。仅上传或推送代码不会触发用户端更新；需要手动运行 Release 工作流或推送新版本标签，并成功发布新版本。

浏览器测试使用项目自带的短 WebM 测试视频，验证真实解码与播放。测试素材由简单色块生成，无需下载媒体。PowerShell 示例：

```powershell
$env:PLAYWRIGHT_MODULE = 'C:\path\to\node_modules\playwright'
$env:BROWSER_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node --test test/renderer.browser.test.js
node --test test/panel.browser.test.js
```

`FROSTED_TEST_TMP` 可以指定测试临时文件目录；`RENDERER_ARTIFACT_DIR` 可以指定测试截图保存目录。未设置 `PLAYWRIGHT_MODULE` 时，普通单元测试会跳过浏览器测试。
