# 在线部署

ClipDock 需要持续运行的 Node 服务、Python / yt-dlp、FFmpeg 和 Chrome。GitHub 保存代码及执行检查；在线后端使用仓库内的 Docker 镜像。GitHub Pages 不能运行这些后端进程。

## Render

1. 在 Render 连接有权读取此 GitHub 仓库的账号，创建 **Blueprint**，选择本仓库和 `main` 分支。
2. 确认配置来自根目录 `render.yaml`，实例类型为 **Free**，区域为 Singapore；本配置不创建付费数据库或磁盘。
3. 等待 GitHub 检查和镜像构建完成。成功后使用 Render 控制台实际分配的 HTTPS 网址。
4. 打开网站，再检查 `/api/health`：`ok`、`extractor.available`、`ffmpeg.available` 均应为 `true`。Render 的存活探测使用轻量 `/healthz`。用一条自己有权下载的公开链接验证解析与下载；健康检查成功本身不证明每个平台可下载。

服务自动读取 Render 提供的 `RENDER_EXTERNAL_URL`。无需填写或猜测子域名。自定义域名部署时将 `PUBLIC_ORIGIN` 设置为浏览器访问的完整 HTTPS origin，例如 `https://video.example.com`，不要带路径。

部署后请核对 Render 实际运行的 Git 提交。通过公开仓库 URL 创建的服务不支持自动部署；需要手动发布，或先连接 Git provider。即使接口显示 `autoDeploy`，也应以实际部署记录为准。[Render 部署来源说明](https://render.com/docs/web-services#deploy-your-own-code)

| 配置 | 默认值 / 作用 |
| --- | --- |
| `HOST` | 容器使用 `0.0.0.0`，本地启动仍可使用环回地址 |
| `PORT` | Blueprint 为 `10000`，普通 Docker 为 `4317` |
| `PUBLIC_ORIGIN` | 可选，自定义公开 HTTPS origin |
| `RENDER_EXTERNAL_URL` | Render 自动注入的网站 origin |
| `MAX_PARSE_JOBS` | 云端 `1`，限制同时解析数量 |
| `MAX_MERGE_JOBS` | 云端 `1`，限制同时下载合并数量 |
| `MAX_DOWNLOADS` | 云端 `2`，限制同时传输视频数量 |
| `SCRAPLING_PYTHON` | 镜像内 Python `/opt/clipdock-venv/bin/python` |
| `YTDLP_PATH` | 镜像内解析器 `/opt/clipdock-venv/bin/yt-dlp` |

Free 实例有休眠、内存和流量限制；空闲 15 分钟后休眠，下一次访问需要等待唤醒。下载缓存位于临时文件系统，重启或休眠后需重新解析。Chrome 播放器页面可能超过 Free 的 512 MB 内存；本配置限制并发，但不能保证所有页面都能运行。发生内存不足时可继续使用本地版本，或由账号持有人自行决定是否升级实例。[Render 免费服务说明](https://render.com/docs/free)

云服务器出口 IP 和地区会影响平台可用性。登录、验证码、地区限制和第三方解析限流仍可能发生；部署不会自动获得相应访问权限。GreenVideo 解析会向该服务发送所提交的视频链接，界面会标明解析来源。

## 本地 Docker 验证

镜像目标为 Linux amd64；Google Chrome 官方 Debian 包不提供此方案所需的 Linux arm64 版本。构建会从官方 Node 镜像、Debian、Google、PyPI 和 npm 下载依赖。

```sh
docker build --platform linux/amd64 -t clipdock:check .
docker run --rm clipdock:check python scripts/container_smoke.py
docker run --rm -p 127.0.0.1:4317:4317 clipdock:check
```

第二条命令验证非 root 用户、可写缓存、真实服务启动、yt-dlp、FFmpeg、11 个平台入口，以及真实 Chrome 执行本地页面 JavaScript。它不依赖第三方视频是否可用，适合 GitHub Actions 的 Ubuntu runner。随后访问 `http://127.0.0.1:4317`。

Docker 使用 `tini` 回收退出的子进程，应用以 `node` 用户运行。Chrome 通过现有 Scrapling / Playwright 默认启动配置运行，不导入本机浏览器环境。`.dockerignore` 只允许应用代码和依赖清单进入构建上下文。

版本固定：yt-dlp `2026.08.19`、Scrapling `0.4.15`、Playwright `1.63.0`；npm 依赖由 lockfile 固定。Node 22、Debian 安全更新和 Chrome stable 在重新构建时获取该通道的更新版本。

## GitHub Actions 容器检查

在 Ubuntu runner 完成 `actions/checkout` 后执行上面的 `docker build` 和 `docker run ... container_smoke.py` 两条命令。仓库普通单元测试可另行执行 `npm ci` 与 `npm test`，测试环境需安装 FFmpeg。

本配置没有付费自动升级、定时保活或后台抓取。在线网址只能以托管平台实际创建服务后的返回值为准。
