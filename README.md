# 拾帧 ClipDock 1.2

支持本机运行或完整容器部署。在线部署步骤、环境变量和资源说明见 [部署文档](docs/deployment.md)。GitHub 保存源码，Render 运行解析和下载后端。

在浏览器中解析公开的视频，选择清晰度并下载 MP4。当前提供 5 个平台入口：**X / Twitter、TikTok、Instagram、微博、Pinterest**。支持 X 多视频下载、平台短链接和分享文字输入。

解析方式可选择“自动选择”“本地解析”或“GreenVideo 扩展解析”。本地方式使用 `yt-dlp`；TikTok 必要时通过新建的临时匿名 Chrome 读取公开播放器数据。GreenVideo 方式使用对方公开网页所用的协议获取媒体信息；其后台代码没有被恢复，本项目也不宣称支持所有网站。

**自动或 GreenVideo 方式可能将你提交的视频链接发送到 GreenVideo。** 如希望只由本机连接目标视频平台，请选择“本地解析”。不读取已有浏览器会话或账号 Cookie，遇到登录、付费或验证码要求时返回错误。识别链接并不代表这个平台或每条视频都能成功下载；逐项状态见 [验证记录](验证记录.md)，逆向依据见 [GreenVideo 分析报告](docs/greenvideo-analysis.md)。

## 解析方式与平台范围

| 方式 | 行为 |
| --- | --- |
| 自动选择 | 先尝试本地；失败时可转 GreenVideo。结果显示实际来源。 |
| 本地解析 | 本机直接连接视频平台；不向 GreenVideo 发送链接。 |
| GreenVideo 扩展解析 | 将链接发送给 GreenVideo，再筛选其返回的可信视频直链。 |

Pinterest 和 Instagram 已完成真实解析、完整下载和解码；微博已完成解析及范围下载，未下载整条长视频。平台入口、地址校验或离线测试通过，都不等于每条视频均可下载；相同链接本机和云端的结果也可能不同。当前 GreenVideo 接入仍受其访问限制影响，详情见验证记录。历史报告中出现的其他平台不属于当前开放范围。

## 无水印功能的含义

TikTok 优先选择提取器明确提供的无平台水印播放源。同一清晰度有多个来源时，优先无水印版本。页面按来源信息区分“无平台水印源”“含平台水印”“水印状态未确认”和“原始画面”，不会把未知来源标成已去水印。

X 保存原始画面，不额外添加水印。当前不做画面裁剪、模糊或 AI 擦除，因此作者已经嵌入画面的文字、Logo、字幕仍会保留。无法取得无水印源时，页面会如实标注可用来源。

GreenVideo 返回的“无水印”文字标签不会自动视为已验证的无水印来源；新增平台也不承诺擦除画面水印。

## 启动与停止

当前电脑的项目依赖与匿名浏览器环境已准备好，可直接运行 `start.cmd`。验证环境为 Node.js `20.19.6`、yt-dlp `2026.08.19` 和 FFmpeg `9.0.1`。换一台电脑使用时，请先完成下文的依赖准备。

Windows 下双击项目目录中的 `start.cmd`。启动脚本会在缺少 npm 依赖时运行 `npm ci`，然后启动服务。首次安装依赖需要联网。首次启用 TikTok 的匿名浏览器解析时，还需安装 Python 和 Google Chrome，并运行一次 `setup-browser.cmd`，详见下文。

也可以在 PowerShell 中运行：

```powershell
Set-Location '你的项目目录\clipdock'
npm ci
npm start
```

看到启动地址后，用浏览器打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。保留终端窗口；需要停止时，在该窗口按 `Ctrl+C`。

服务仅监听 `127.0.0.1`，供这台电脑使用。手机和其他电脑不能通过局域网直接访问。

## 使用方法

1. 复制具体视频链接，或只包含一个有效链接的分享文字。可使用 X 帖子、TikTok 视频、Instagram Reel / 帖子、微博帖子和 Pinterest Pin。
2. 选择解析方式，粘贴链接并点击解析。解析整体最长约 120 秒，包含回退和必要的公开页面加载时间；界面显示等待状态、实际解析来源或具体错误。
3. 查看清晰度、水印状态，点击下载，由浏览器保存 MP4。

不接受用户主页、直播、纯播放列表、搜索页或未列出平台的链接。只含图片或音频的帖子不会被当成视频下载；封面可以随视频结果显示。一个 X 帖子有多个视频时，每个视频分别选择画质并下载。

最近 8 条解析记录保存在当前浏览器的本地存储中，可在页面清空。清空浏览器站点数据也会删除这些记录。切换浏览器或端口后，历史记录不会自动迁移。

解析结果和下载凭证在服务内存中缓存 20 分钟，按链接及所选解析方式隔离；更换解析方式不会误用另一方式的结果。重启服务后缓存失效。历史记录不保存视频文件；旧下载链接失效时，请重新解析帖子。

微博、Pinterest 等短链接由本机按受信规则展开，最多跟随 5 次同平台跳转；拒绝私网、跨平台跳转及登录页。无法安全展开时会显示错误。

视频直链以流式转发方式下载。解析与下载并发受服务配置限制；繁忙时会提示稍后重试，当前没有自动排队。

## 依赖准备

- **Node.js 20.19 或更新版本**，包含 npm：[官方下载](https://nodejs.org/en/download)。安装后重新打开终端，运行 `node --version` 和 `npm --version` 检查。
- **yt-dlp**：[官方安装说明](https://github.com/yt-dlp/yt-dlp#installation) · [官方发行版本](https://github.com/yt-dlp/yt-dlp/releases)。Windows 可使用官方提供的 `yt-dlp.exe`，放到 PATH 中，或通过 `YTDLP_PATH` 指定完整路径。
- **FFmpeg**：[官方下载与安装入口](https://ffmpeg.org/download.html)。完整运行环境和容器检查保留此工具；当前 5 个平台的入口下载视频直链。加入 PATH 或通过 `FFMPEG_PATH` 指定 `ffmpeg.exe`。
- **npm 依赖**：在项目目录运行 `npm ci`，按锁文件安装依赖。其中 `undici` 用于支持本地媒体下载的 HTTP 代理配置。
- **Python 3.10 或更新版本、Google Chrome**：用于 TikTok 的匿名浏览器解析。安装 [Python](https://www.python.org/downloads/windows/) 和 [Google Chrome](https://www.google.com/chrome/) 后，双击 `setup-browser.cmd`。脚本创建项目专用 `.venv`，并按 `requirements-browser.txt` 安装固定版本 `scrapling[fetchers]==0.4.15`；随后重启网站。此步骤不会安装浏览器扩展或读取已有账号会话。

运行 `yt-dlp --version` 和 `ffmpeg -version` 检查依赖。缺少匿名浏览器环境时，不依赖浏览器回退的常规解析仍可使用；需要浏览器回退的 TikTok 链接会提示运行 `setup-browser.cmd`。

也可以在 PowerShell 中手动准备匿名浏览器依赖：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-browser.txt
```

每次浏览器解析使用单独的新临时配置目录，完成或取消后清理；不复用已打开的 Chrome、登录状态或用户资料目录。

## 环境配置

配置在启动服务的终端中设置，随后执行 `npm start`。修改后需要重启服务；项目不会自动读取 `.env` 文件。

### 指定解析器与端口

```powershell
$env:YTDLP_PATH = 'D:\Tools\yt-dlp.exe'
$env:FFMPEG_PATH = 'D:\Tools\ffmpeg.exe'
$env:SCRAPLING_PYTHON = 'D:\Tools\scrapling-env\Scripts\python.exe'
$env:PORT = '4318'
npm start
```

此时访问 [http://127.0.0.1:4318](http://127.0.0.1:4318)。没有配置时，解析器从 PATH 查找 `yt-dlp` 和 `ffmpeg`，匿名浏览器使用项目的 `.venv\Scripts\python.exe`，端口为 `4317`。`SCRAPLING_PYTHON` 仅在使用其他已安装相同依赖的 Python 环境时设置；使用 `setup-browser.cmd` 默认安装方式时无需设置。

### 网络代理

本机网络需要能够访问目标平台和它的视频服务器。浏览器能访问，不一定代表 Node.js 和 yt-dlp 已使用同一代理。已有本地 HTTP 代理时，可在启动前配置以下环境变量；将示例端口改成自己的代理端口：

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:7890'
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
$env:NO_PROXY = '127.0.0.1,localhost'
npm start
```

本地下载服务及 GreenVideo 请求支持 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`，yt-dlp 子进程继承启动环境。匿名 Chrome 回退也会继承代理配置，并尊重 `NO_PROXY` 的目标排除规则；不会固定使用另一条代理。请使用 HTTP 代理地址；本配置不直接支持 SOCKS 代理。TLS 证书验证保持开启。

示例变量仅对当前终端及其启动的进程生效。新开终端后需要重新设置。若不再使用代理，清除变量后重启：

```powershell
Remove-Item Env:HTTP_PROXY, Env:HTTPS_PROXY, Env:NO_PROXY -ErrorAction SilentlyContinue
npm start
```

## 支持范围与常见问题

- **需要登录、私密、地区限制或已删除的帖子**：可能无法解析。当前版本面向无需登录的公开帖子。
- **TikTok 限制 IP**：程序会在可用时尝试匿名公开网页；如果网页也不给出视频信息，则停止。不会读取已有账号会话、自动登录或跳过验证码。当前实测结果见 [验证记录](验证记录.md)。
- **GreenVideo 要求验证码或请求过于频繁**：本次解析停止，不自动解题、不循环重试。可以稍后重试，或在提供本地解析的平台改选“本地解析”。它是外部服务，其可用性不由本项目控制。
- **匿名浏览器环境未就绪**：安装 Python 3.10+ 和 Google Chrome，运行 `setup-browser.cmd` 后重启网站；自定义 Python 环境还需确认安装了 `requirements-browser.txt` 中的依赖。
- **浏览器解析内存不足**：容器内存接近保护阈值时会终止当前浏览器任务，防止它拖垮其他下载。稍后重试不一定解决资源不足；同一视频可尝试在内存更充足的本地部署运行。
- **没有可下载视频**：图片帖子、直播或仅提供分段流的媒体可能没有可用的 MP4。当前不合并 M3U8 分段，也不做转码。
- **画质选项较少**：只展示媒体源实际提供的 MP4；不提高分辨率、不生成假画质。
- **解析器未就绪**：检查 `yt-dlp --version`，或设置正确的 `YTDLP_PATH`。更换程序路径后重启服务。
- **连接失败或超时**：检查目标平台的网络访问及代理配置。解析和视频下载均需要联网。
- **请求过于频繁**：稍后再试；X 和本地服务都可能限制请求频率。
- **解析成功但下载失败**：点击重新解析刷新媒体链接。视频服务器返回 403、失效地址等下载源错误后，服务会标记该次解析缓存不可复用，下一次解析重新获取平台信息；同时检查视频服务器是否能通过当前网络访问。
- **端口被占用**：停止已运行的实例，或设置其他 `PORT`。

平台接口和媒体策略可能变化，支持范围会受解析器版本及远端服务状态影响。本项目不保证每个公开帖子都可下载。

## 维护与测试

使用安装 yt-dlp 时对应的方式更新解析器。官方独立可执行文件通常可运行 `yt-dlp -U`；通过包管理器安装的版本应使用该包管理器更新。更新后执行 `yt-dlp --version` 并重启服务。

更新项目 npm 依赖锁文件后运行 `npm ci`。更新 `requirements-browser.txt` 后重新运行 `setup-browser.cmd`。不要关闭 TLS 证书验证来处理连接错误，应修复代理或证书配置。

运行本地测试：

```powershell
npm test
```

测试覆盖当前 5 平台入口与下架平台拒绝、同平台短链受控跳转、水印来源判断、媒体整理、下载来源限制、解析来源路由与缓存隔离、GreenVideo 密码学封装和验证码错误处理，以及容器内存保护、浏览器进程清理和解析错误诊断；离线测试通过不代表所有真实链接均可访问。需要调试代码时可使用 `npm run dev`，Node.js 会在源文件变动时重启服务。

## 项目结构

```text
clipdock/
  server.mjs                 本地服务启动入口
  start.cmd                  Windows 启动脚本
  setup-browser.cmd          安装项目专用匿名浏览器解析环境
  requirements-browser.txt   匿名浏览器解析依赖与固定版本
  lib/
    server.mjs               API、缓存、下载转发与静态文件服务
    extractor.mjs            yt-dlp 调用、匿名浏览器回退与媒体整理
    resolver.mjs             自动 / 本地 / GreenVideo 解析路由
    greenvideo.mjs           GreenVideo 公开协议客户端与结果筛选
    shortlinks.mjs           同平台短链接受控展开
    platforms.mjs            平台链接与 CDN 来源校验
    media.mjs                内部媒体处理与临时文件清理
  public/
    index.html               页面结构
    styles.css               页面样式
    app.js                   解析交互、下载与本地历史
    favicon.svg              网站图标
  tests/                     本地自动化测试
  docs/greenvideo-analysis.md GreenVideo 公开前端分析与验证边界
  scripts/
    render_public_video.py   在新匿名 Chrome 中读取公开视频
    tiktok_player.py         从 TikTok 公开页面数据读取播放来源
  package.json               npm 命令与依赖声明
  package-lock.json          npm 依赖锁文件
```
