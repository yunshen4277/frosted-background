# Frosted Background · 毛玻璃背景

为 VS Code 的代码编辑区设置本地图片或视频背景。图片单独模糊，代码保持清晰；背景会跟随窗口、侧栏、终端和编辑区尺寸变化。界面默认英语，可随时切换简体中文和西班牙语。

## 安装和更新（0.12.0）

1. 已安装本插件时，在控制面板点击 **检查更新**。也可运行 **Extensions: Install from VSIX…**，选择 `frosted-background-0.12.0.vsix` 覆盖安装。
2. 按提示重载扩展，打开左侧背景图标或右下角 **Frosted**。
3. 首次启用需要确认对 VS Code 界面文件的修改。首次启用或升级播放器后，点击 **应用**，完成必要的一次窗口重载。
4. 后续选择素材、调节毛玻璃参数可实时生效；关闭面板不会关闭背景。

发布地址：[GitHub Releases](https://github.com/yunshen4277/frosted-background/releases)。插件内的更新来自此仓库；连接 GitHub 账号本身不会开启 VS Code 市场更新。后续版本继续保持 0.x，未经用户允许不进入 1.0。

## Wallpaper Engine 壁纸库

Windows 版可自动找到 Steam 安装和多个 Steam 库中的 Wallpaper Engine。控制面板显示已下载壁纸的缩略图、标题和类型，可以搜索，并一键把兼容图片或视频用作代码区背景。

- 打开面板后自动扫描本机已下载壁纸；默认只显示可用于代码区的项目，可切换为查看全部。
- 点击 **刷新** 读取刚下载的壁纸。没有自动找到安装时，点击 **选择文件夹**，选择包含 `wallpaper32.exe` 或 `wallpaper64.exe` 的 `wallpaper_engine` 安装文件夹。
- 搜索框按标题和类型筛选本地壁纸；点击卡片上的 **应用**，使用其实际本地媒体文件，同时保留当前毛玻璃和暂停设置。
- **在创意工坊搜索** 会用输入关键词打开 Steam 官方搜索页。通过 Steam 或 Wallpaper Engine 订阅并完成下载后，回到插件刷新壁纸库。
- 自动扫描不会启动 Wallpaper Engine，不会改变 Windows 桌面壁纸，也不会读取 Steam 登录信息。

### 支持范围

| 壁纸类型 | 代码区支持 |
| --- | --- |
| 已下载 MP4 / WebM 视频 | 使用本地视频文件，静音循环，支持暂停和速度调节 |
| 含独立本地图片文件的图片项目 | 使用该图片，支持全局毛玻璃效果 |
| Scene 场景、Web 互动、Application 应用 | 显示类型和不支持原因，不能直接用作代码区背景 |
| 未下载完整或大于 500 MiB 的文件 | 显示原因，不能应用 |

Wallpaper Engine 的场景、互动和应用类壁纸需要其专用渲染环境，不等同于视频文件。此版本没有把独立窗口或缩略图伪装成可用的动态背景，也不提供插件内直接订阅和下载整个创意工坊的功能。兼容性还取决于 VS Code 对文件内部编码的支持。

参考：[Wallpaper Engine 官方命令接口](https://help.wallpaperengine.io/en/functionality/cli.html)、[场景壁纸与视频的区别](https://help.wallpaperengine.io/en/functionality/export.html)、[Steam Workshop 查询接口](https://partner.steamgames.com/doc/webapi/IPublishedFileService#QueryFiles)。

## 本地素材与效果

- **选择图片 / 选择视频**：使用本机文件；原有本地素材入口保留。
- **柔和、清透、专注**：快速应用全局效果预设；可调整模糊、背景浓度、蒙层、亮度和饱和度。
- **等比铺满**：铺满编辑区，会裁掉部分边缘。
- **完整显示**：保持比例并显示整个画面，可能留白。
- **完整压缩**：整个画面拉伸或压缩到编辑区，始终完整显示，比例可能变化。
- 视频支持静音循环、暂停、继续、速度、失焦暂停和减少动态效果；普通效果调整保留播放进度。
- WebM 直接加载出现错误 4 时会尝试 MediaSource 兼容播放。容量不足或不支持编码会明确提示，不保证任意编码都能播放。

图片支持 PNG、JPG、JPEG、WebP、GIF、BMP、AVIF；视频支持 MP4、WebM。每个背景文件上限 500 MiB。

## 本次移除的功能

0.12.0 删除所有外部链接背景入口与相关下载、解析功能，包括 YouTube、Twitch、图片和视频直链以及 M3U8/HLS。删除区域效果、区域模板、自由选区和区域渐变；只保留全局毛玻璃设置。

升级时，旧区域配置不再参与渲染；旧 HLS 背景会停用。之前已缓存到本机的图片或视频仍属于本地文件，可以继续使用。不会删除用户以前下载的视频或 Wallpaper Engine 原始文件。

## 恢复与使用环境

官方 VS Code 扩展接口不能直接设置代码区图片或视频背景，本插件需要修改这份 VS Code 安装的界面文件。可能出现“安装似乎已损坏”的完整性提示；底部 **关闭背景并恢复** 可以撤销插件注入。VS Code 自身升级后可能需要重新应用。正在使用同一安装的其他窗口也可能需要重载。

需要桌面版 VS Code 和可写的安装目录；网页版不支持代码区背景。Wallpaper Engine 自动发现和壁纸库接入针对 Windows。三语切换仅影响插件界面，不改变 VS Code 显示语言。

## 开发与打包

无需运行时 npm 依赖。开发环境使用 Node.js，打包需要 `jszip`；浏览器测试需要 Playwright 和 Chromium/Chrome。

```sh
npm install --ignore-scripts
node --test --test-concurrency=1 test/*.test.js
node scripts/package.js
node scripts/verify-package.js ../frosted-background-0.12.0.vsix
```

`TESTING.md` 记录具体验证范围。发布流程生成 VSIX、源码 ZIP 和带 SHA-256 的更新清单。没有测试过的原生环境或壁纸类型不视为已经兼容。
