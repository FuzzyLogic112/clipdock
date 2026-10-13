import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetch as proxyFetch, EnvHttpProxyAgent } from 'undici';
import { getExtractorHealth } from './extractor.mjs';
import { resolveVideo, normalizeProvider, PROVIDERS } from './resolver.mjs';
import { normalizeVideoUrl, platformForUrl, isAllowedMediaUrl, isAllowedThumbnailUrl, PLATFORM_LABELS, platformCatalog, thumbnailHostCatalog } from './platforms.mjs';
import { prepareMergedMedia, getFfmpegHealth } from './media.mjs';
import { normalizePublicOrigin } from './config.mjs';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp' };
const error = (message, status = 400, code = 'INVALID_REQUEST') => Object.assign(new Error(message), { status, code });
const platformNames = PLATFORM_LABELS;
const imageCatalog = thumbnailHostCatalog();
const imagePolicy = [...imageCatalog.exact.map(host => `https://${host}`), ...imageCatalog.roots.flatMap(host => [`https://${host}`, `https://*.${host}`])].join(' ');
const thumbnail = value => isAllowedThumbnailUrl(value) ? value : null;
function safeHeaders(input) {
  const result = { 'user-agent':'Mozilla/5.0', 'accept-encoding':'identity' };
  for (const [name,value] of Object.entries(input || {})) {
    if (['user-agent','referer','origin','accept','accept-language'].includes(name.toLowerCase()) && typeof value === 'string' && value.length < 2048 && !/[\r\n]/.test(value)) result[name.toLowerCase()] = value;
  }
  return result;
}

function json(res, status, data, extra = {}) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw error('请使用 JSON 提交链接。', 415);
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4096) throw error('提交内容过长，请只粘贴帖子链接。', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw error('请求内容无效，请重新粘贴链接。'); }
}

export function createClipdockServer(options = {}) {
  const publicOrigin = normalizePublicOrigin(options.publicOrigin);
  const publicHost = publicOrigin ? new URL(publicOrigin).host : '';
  const deploymentMode = publicOrigin ? 'online' : 'local';
  const extractor = options.resolveVideo || options.extractVideo || options.extractTweet || resolveVideo;
  const health = options.getExtractorHealth || getExtractorHealth;
  const ffmpegHealth = options.getFfmpegHealth || getFfmpegHealth;
  const prepareMedia = options.prepareMergedMedia || prepareMergedMedia;
  const mediaDispatcher = options.fetchMedia ? null : new EnvHttpProxyAgent();
  const fetchMedia = options.fetchMedia || ((url, init) => proxyFetch(url, { ...init, dispatcher: mediaDispatcher }));
  const now = options.now || Date.now;
  const ttl = options.cacheTtlMs ?? 20 * 60_000;
  const jobs = new Map(); const pending = new Map(); const tickets = new Map(); const clients = new Map();
  const controllers = new Set();
  let mergeCount = 0;
  let downloadCount = 0;

  function discardTicket(ticket) {
    if (!ticket) return;
    ticket.control?.abort();
    ticket.discarded = true;
    if (!ticket.readers) ticket.file?.cleanup().catch(() => {});
  }

  function removeJob(url, job) {
    for (const token of job.tokens) { discardTicket(tickets.get(token)); tickets.delete(token); }
    jobs.delete(url);
  }
  function cleanup() {
    for (const [url, job] of jobs) if (job.expires <= now()) removeJob(url, job);
    for (const [ip, record] of clients) if (record.until <= now()) clients.delete(ip);
  }
  function consumeRate(req) {
    const ip = req.socket.remoteAddress;
    let entry = clients.get(ip);
    if (!entry || entry.until <= now()) { entry = { count: 0, until: now() + 60_000 }; clients.set(ip, entry); }
    if (++entry.count > (options.maxRequestsPerMinute ?? 20)) throw error('请求有些频繁，请稍等一分钟再试。', 429, 'RATE_LIMITED');
  }
  function packageResult(url, metadata, cacheKey) {
    const id = randomUUID(); const expires = now() + ttl; const tokens = [];
    const platform = platformForUrl(url);
    const videos = (metadata.videos || []).map(video => ({
      id: video.id, title: video.title, duration: video.duration, thumbnail: thumbnail(video.thumbnail),
      formats: (video.formats || []).filter(format => isAllowedMediaUrl(format.url,platform) && (!format.requiresMerge || isAllowedMediaUrl(format.audioUrl,platform))).map(format => {
        const token = randomBytes(24).toString('hex'); tokens.push(token);
        const label = String(format.label || '视频');
        const filename = `clipdock-${String(video.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0,40)}-${label.replace(/[^a-zA-Z0-9_-]/g, '').slice(0,20) || 'video'}.mp4`;
        const requiresMerge = Boolean(format.requiresMerge);
        tickets.set(token, { url: format.url, audioUrl:format.audioUrl, audioExt:format.audioExt, headers:safeHeaders(format.headers), audioHeaders:safeHeaders(format.audioHeaders), platform, requiresMerge, expires, filename, status:requiresMerge ? 'idle' : 'ready', readers:0 });
        const watermark = ['none','present','unknown','source'].includes(format.watermark) ? format.watermark : 'unknown';
        return { id: format.id, label, width: format.width, height: format.height, ext: 'mp4', filesize: format.filesize, filesizeApprox: format.filesizeApprox || false, hasAudio: format.hasAudio, bitrate: format.bitrate, requiresMerge, watermark, watermarkLabel:format.watermarkLabel || '水印状态未确认', downloadUrl: `/api/download/${token}` };
      }),
    })).filter(video => video.formats.length);
    if (!videos.length) throw error('这条帖子暂时没有可直接下载的视频。', 422, 'NO_MEDIA');
    const provider = metadata.provider === 'greenvideo' ? 'greenvideo' : 'local';
    const payload = { success: true, id, sourceUrl: url, platform, platformLabel:platformNames[platform], provider, providerLabel:provider === 'greenvideo' ? 'GreenVideo 扩展解析' : '内置解析', title: metadata.title, author: metadata.author, duration: metadata.duration, thumbnail: thumbnail(metadata.thumbnail), videos, expiresAt: new Date(expires).toISOString() };
    while (jobs.size >= 40) { const [key, old] = jobs.entries().next().value; removeJob(key, old); }
    jobs.set(cacheKey, { payload, tokens, expires });
    return payload;
  }

  async function parse(req, res) {
    consumeRate(req);
    const body = await readBody(req);
    const url = normalizeVideoUrl(body?.url);
    const provider = normalizeProvider(body?.provider);
    const cacheKey = `${provider}:${url}`;
    const cached = jobs.get(cacheKey);
    if (cached && cached.expires > now() && !cached.invalidated) return json(res, 200, cached.payload);
    if (cached) removeJob(cacheKey, cached);
    if (!pending.has(cacheKey)) {
      if (pending.size >= (options.maxParseJobs ?? 2)) throw error('已有视频正在解析，请稍后重试。', 429, 'BUSY');
      const control = new AbortController(); controllers.add(control);
      const promise = Promise.resolve().then(() => extractor(url, { signal: control.signal, provider }))
        .then(metadata => packageResult(url, metadata, cacheKey))
        .finally(() => { pending.delete(cacheKey); controllers.delete(control); });
      pending.set(cacheKey, promise);
    }
    json(res, 200, await pending.get(cacheKey));
  }

  function getTicket(token) {
    const ticket = tickets.get(token);
    if (!ticket || ticket.expires <= now()) throw error('下载链接已过期，请重新解析视频。',410,'LINK_EXPIRED');
    return ticket;
  }
  function preparationResult(ticket,token) {
    return { success:true, status:ticket.status === 'idle' ? 'preparing' : ticket.status, stage:ticket.stage || (ticket.status === 'ready' ? 'ready':'waiting'), progress:ticket.status === 'ready' ? 100 : ticket.progress ?? null, downloadUrl:`/api/download/${token}`, ...(ticket.failure ? { error:ticket.failure.message, code:ticket.failure.code } : {}) };
  }
  function prepare(req,res,token) {
    const ticket = getTicket(token);
    if (req.method === 'POST' && ['idle','failed'].includes(ticket.status)) {
      consumeRate(req);
      if (mergeCount >= (options.maxMergeJobs ?? 2)) throw error('已有视频正在准备下载，请稍后再试。',429,'BUSY');
      // Keep a bounded number of completed local files. Direct downloads are streamed.
      const completed = [...tickets.values()].filter(t=>t.file && !t.readers);
      while (completed.length >= 4) {
        const old = completed.shift();
        old.file.cleanup().catch(()=>{}); old.file = null; old.status = 'idle'; old.stage = 'waiting';
      }
      const control = new AbortController();
      ticket.control = control; controllers.add(control); mergeCount++;
      ticket.status = 'preparing'; ticket.stage = 'downloading'; ticket.progress = null; ticket.failure = null;
      Promise.resolve().then(()=>prepareMedia(ticket,{signal:control.signal,fetchMedia,onProgress:update=>{
        if (ticket.status !== 'preparing') return;
        ticket.stage = ['downloading','merging'].includes(update.stage) ? update.stage : 'downloading';
        ticket.progress = Number.isFinite(update.progress) ? Math.min(99,Math.max(0,update.progress)) : null;
      }})).then(async file=>{
        if (ticket.discarded || control.signal.aborted) { await file.cleanup(); return; }
        ticket.file = file; ticket.status = 'ready'; ticket.stage = 'ready'; ticket.progress = 100;
      }).catch(e=>{
        ticket.status = 'failed'; ticket.stage = 'failed';
        ticket.failure = { message:e.code ? e.message : '视频准备失败，请重试。', code:e.code || 'PREPARE_FAILED' };
      }).finally(()=>{mergeCount--; controllers.delete(control); ticket.control=null;});
    }
    const result = preparationResult(ticket,token);
    json(res,result.status === 'preparing' ? 202 : 200,result);
  }

  async function localDownload(req,res,ticket) {
    const file = ticket.file;
    const size = file.size;
    let start = 0, end = size - 1;
    const range = req.headers.range;
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match || (!match[1] && !match[2])) throw error('下载范围格式无效。',416);
      if (!match[1]) start = Math.max(0,size-Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end,Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw error('下载范围不可用。',416);
    }
    const headers = { 'Content-Type':'video/mp4', 'Content-Disposition':`attachment; filename="${ticket.filename}"`, 'Cache-Control':'private, no-store', 'Accept-Ranges':'bytes','Content-Length':end-start+1 };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    ticket.readers++;
    res.setTimeout(60_000, () => res.destroy());
    try { res.writeHead(range ? 206 : 200,headers); await pipeline(createReadStream(file.path,{start,end}),res); }
    catch { if (res.headersSent) res.destroy(); else throw error('本地视频文件不可用，请重新解析。',410,'LINK_EXPIRED'); }
    finally { ticket.readers--; if (ticket.discarded && !ticket.readers) await file.cleanup().catch(()=>{}); }
  }

  async function download(req, res, token) {
    const ticket = getTicket(token);
    if (ticket.requiresMerge) {
      if (ticket.status !== 'ready' || !ticket.file) throw error('请先在页面点击下载，等待音视频准备完成。',409,'PREPARE_REQUIRED');
      return localDownload(req,res,ticket);
    }
    const range = req.headers.range;
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw error('下载范围格式无效。', 416);
    const control = new AbortController(); controllers.add(control);
    const onClose = () => control.abort();
    res.on('close', onClose);
    const timeout = setTimeout(() => control.abort(), 25_000);
    let response;
    try {
      let url = ticket.url;
      for (let redirect = 0; redirect <= 3; redirect++) {
        if (!isAllowedMediaUrl(url,ticket.platform)) throw error('视频来源地址无效，请重新解析。', 502, 'UNSAFE_MEDIA');
        response = await fetchMedia(url, { redirect: 'manual', signal: control.signal, headers: { ...ticket.headers, ...(range ? { Range: range } : {}) } });
        if (![301,302,303,307,308].includes(response.status)) break;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirect === 3) throw error('视频地址跳转异常，请重新解析。', 502, 'MEDIA_REDIRECT');
        url = new URL(location, url).href;
      }
      clearTimeout(timeout);
      if (response.status === 416) { await response.body?.cancel(); throw error('下载范围不可用，请重新下载。', 416); }
      if (![200,206].includes(response.status) || !response.body) { await response.body?.cancel(); throw error('视频源暂时不可用，请重新解析后再试。', 502, 'MEDIA_UNAVAILABLE'); }
      const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
      if (!['video/mp4','video/mpeg','application/octet-stream','binary/octet-stream'].includes(contentType)) { await response.body.cancel(); throw error('视频源返回了非视频内容，请重新解析。', 502, 'MEDIA_UNAVAILABLE'); }
      const headers = { 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${ticket.filename}"`, 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes' };
      if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') { await response.body.cancel(); throw error('视频源返回了不支持的压缩传输，请重试。',502,'MEDIA_UNAVAILABLE'); }
      for (const key of ['content-length','content-range']) { const value = response.headers.get(key); if (value) headers[key] = value; }
      res.writeHead(response.status, headers);
      res.setTimeout(60_000, () => control.abort());
      await pipeline(Readable.fromWeb(response.body), res);
    } catch (e) {
      // A rejected/expired CDN URL must not be handed back by the next parse.
      if (['MEDIA_UNAVAILABLE','MEDIA_REDIRECT','DOWNLOAD_FAILED'].includes(e.code)) {
        for (const job of jobs.values()) if (job.tokens.includes(token)) job.invalidated = true;
      }
      if (res.headersSent) res.destroy();
      else if (e.status) throw e;
      else throw error('视频下载连接中断，请稍后重试。', 502, 'DOWNLOAD_FAILED');
    } finally {
      clearTimeout(timeout); res.off('close', onClose); controllers.delete(control); control.abort();
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' ${imagePolicy} data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
    try {
      cleanup();
      const host = (req.headers.host || '').toLowerCase();
      const localHost = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host);
      if (!localHost && (!publicHost || host !== publicHost)) throw error('请使用已配置的网站地址访问。',403,'HOST_REJECTED');
      const origin = host === publicHost ? publicOrigin : `http://${host}`;
      if (!req.url.startsWith('/') || req.url.startsWith('//')) throw error('请求路径无效。');
      const url = new URL(req.url, origin);
      if (req.headers.origin && req.headers.origin !== origin) throw error('请从本站页面发起请求。',403,'ORIGIN_REJECTED');
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res,200,{ok:true,service:'clipdock'});
      if (req.method === 'GET' && url.pathname === '/api/platforms') return json(res,200,{deploymentMode,platforms:platformCatalog(),providers:PROVIDERS,imageHosts:[...imageCatalog.exact,...imageCatalog.roots]});
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const [extractor,ffmpeg] = await Promise.all([health(),ffmpegHealth()]);
        return json(res,200,{ ok: true, service:'clipdock', deploymentMode, extractor, ffmpeg, activeJobs: pending.size, activeDownloads:mergeCount, activeStreams:downloadCount, platforms:Object.entries(platformNames).map(([id,label])=>({id,label})) });
      }
      if (req.method === 'POST' && url.pathname === '/api/parse-video') return await parse(req,res);
      if (['GET','POST'].includes(req.method) && /^\/api\/prepare\/[a-f0-9]{48}$/.test(url.pathname)) return prepare(req,res,url.pathname.split('/').pop());
      if (req.method === 'GET' && /^\/api\/download\/[a-f0-9]{48}$/.test(url.pathname)) {
        if (downloadCount >= (options.maxDownloads ?? 4)) throw error('下载任务较多，请稍后再试。',429,'BUSY');
        downloadCount++;
        try { return await download(req,res,url.pathname.split('/').pop()); }
        finally { downloadCount--; }
      }
      if (url.pathname.startsWith('/api/')) throw error('接口不存在。',404,'NOT_FOUND');
      if (!['GET','HEAD'].includes(req.method)) throw error('不支持此请求方法。',405);
      let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { throw error('路径无效。'); }
      if (pathname.includes('\0') || pathname.includes('\\')) throw error('路径无效。');
      const file = path.resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(publicRoot) || !types[path.extname(file)]) throw error('页面不存在。',404,'NOT_FOUND');
      let bytes; try { bytes = await fs.readFile(file); } catch { throw error('页面不存在。',404,'NOT_FOUND'); }
      res.writeHead(200,{ 'Content-Type':types[path.extname(file)], 'Content-Length':bytes.length, 'Cache-Control':'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (e) {
      const status = Number.isInteger(e.status) && e.status >= 400 && e.status <= 599 ? e.status : 500;
      json(res, status, { success:false, error: e.code && status !== 500 ? e.message : '处理失败，请稍后再试。', code:e.code || 'INTERNAL_ERROR' }, status === 429 ? { 'Retry-After':'60' } : {});
    }
  });
  server.requestTimeout = 140_000;
  server.headersTimeout = 15_000;
  server.on('close', () => {
    clearInterval(sweeper);
    for (const c of controllers) c.abort();
    for (const ticket of tickets.values()) discardTicket(ticket);
    mediaDispatcher?.destroy().catch(() => {});
  });
  const sweeper = setInterval(cleanup,60_000); sweeper.unref();
  return server;
}
