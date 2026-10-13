# GreenVideo 接入依据与验证边界

分析日期：2026-10-13。目标：[greenvideo.cc](https://greenvideo.cc/)。

## 观察到的工作方式

官网使用 Nuxt/Vue。前端统一提交视频链接，由 GreenVideo 后端识别平台并返回标题、视频、音频、图片等条目；各平台的完整提取逻辑不在公开前端中。首页宣传的 1000+ 平台不代表本项目逐个验证了这些平台。

公开前端当前主动暂停 YouTube、抖音和西瓜解析，`/ytb` 页面也调用同一组件。ClipDock 尊重这个范围，YouTube 和抖音继续使用本机解析器。

| 公开资源 | 恢复的信息 |
| --- | --- |
| [DxWwmly_.js](https://greenvideo.cc/_nuxt/DxWwmly_.js) | 首页参数、平台目录、解析历史摘要 |
| [CfusUZS4.js](https://greenvideo.cc/_nuxt/CfusUZS4.js) | 解析入口、结果分组、平台暂停、验证码与下载准备 |
| [CkWcnjeT.js](https://greenvideo.cc/_nuxt/CkWcnjeT.js) | 公钥获取、请求包装与本地历史 |
| [j1yGq1Yf.js](https://greenvideo.cc/_nuxt/j1yGq1Yf.js) | AES/RSA 请求封装 |

请求流程为 GET `/api/auth/keys` 获取公开密钥材料，再对 `{url}` 进行 AES-CBC/PKCS7 和 RSA-PKCS1-v1.5 封装，POST `/api/video/cnSimpleExtract`。短消息用一个 RSA 块，长消息固定 117 个 ASCII 字符分块。客户端用 Node 内置密码学实现该公开协议，不下载执行对方脚本。

返回对象包含 `displayTitle`、`host`、`hostAlias`、`vid`、`videoItemVoList` 和其他分组列表。媒体项包含 `qualityAlias`、`baseUrl`、`fileType`、`fileExt`、`size`、`canDirectDownload` 等字段。普通直链可直接下载；需要对方服务端准备的任务由官网另一组 API 处理，目前未接入 ClipDock。

## 本项目接入范围

独立模块 `lib/greenvideo.mjs` 可供用户选择在线解析。只有选中的视频链接会发送到 GreenVideo；不读取浏览器账号、登录 Cookie 或授权令牌。

模块只接收已允许平台的可信 HTTPS CDN 视频直链。拒绝 VIP、直播、HLS/DASH、仅专用下载器、禁止下载以及非 MP4 视频条目；图片仅可作为封面，音频条目不会被伪装成视频。请求头仅允许清洗后的 User-Agent、Referer、Origin。

验证码、登录、付费、频率限制都作为明确错误返回。公钥失效时最多刷新重试一次。对方给出的“无水印”文字标签不会自动成为本项目已验证的无水印证明；画面内已合成的作者标志不会被擦除。

## 实测与未验证部分

- 匿名官网 UI 首次解析公开 TikTok 样例 `@kittenlovesyou/video/7403699928150674706` 成功，显示视频、音频、图片三项。
- 后续另一个样例返回资源不存在；再次解析触发业务码 `4291` 验证码，随后停止官网解析请求，没有绕过验证。
- Node 适配器一次现场请求未得到成功业务结果；协议细节之后按保存的公开脚本和 HAR 修正。修正版本通过离线测试，但本轮没有再次请求受限接口，因此不能宣称适配器已完成在线下载验收。
- 7 项适配器测试覆盖实际密码学往返、短/长消息、平台范围、验证码与错误处理、媒体筛选、响应上限和取消。测试使用本机生成的 RSA 密钥及固定样本，不依赖线上服务。

REA 对 5 份原始 JavaScript 均语法解析成功；语义图因资源上限存在部分覆盖，不代表后台源码已恢复。原始文件、SHA-256、请求证据和更细报告保存在本次工作区外的 `D:/CodexStorage/CodexHome/tmp/greenvideo-analysis/`。

静态父证据：`ev_c0597ce6a06510384f5c8d0e1265f38ba92d419bc92098b9a74b82db7756effa`；摘要证据：`ev_88528781d67c619b8749ead3bad455e3fc36c36788fc18f236bca6380434fcd1`。运行时证据见该目录 `rea-browser-evidence.json` 与 `tiktok-flow.har`。
