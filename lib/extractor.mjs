import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetch as proxyFetch, EnvHttpProxyAgent } from 'undici';
import { normalizeVideoUrl, normalizeSupportedVideoUrl, platformForUrl, isAllowedMediaUrl, isAllowedThumbnailUrl, parseSafeHttpUrl, PLATFORM_LABELS, platformInputHosts } from './platforms.mjs';
import { readContainerMemory, memoryPressure, watchContainerMemory } from './resource-guard.mjs';
export { normalizeVideoUrl } from './platforms.mjs';

const OUTPUT_LIMIT = 8 * 1024 * 1024;
const TOTAL_TIMEOUT = 120_000;
const TRUSTED_HOSTS = new Set(
  ['x.com', 'twitter.com'].flatMap((host) => [host, `www.${host}`, `m.${host}`, `mobile.${host}`]),
);

export class ExtractorError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'ExtractorError';
    this.code = code;
    this.status = status;
  }
}

function invalidUrl() {
  return new ExtractorError('INVALID_URL', '请粘贴完整的 X / Twitter 帖子链接，例如 https://x.com/用户名/status/帖子编号。', 400);
}

export function normalizeTweetUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) throw invalidUrl();
  const value = input.trim();
  const authority = value.match(/^https?:\/\/([^/?#]+)/i)?.[1];
  // Check the original authority too: URL removes explicit default ports.
  if (!authority || /[:@\\]/.test(authority) || /[\s\\]/.test(value)) throw invalidUrl();
  let parsed;
  try { parsed = new URL(value); } catch { throw invalidUrl(); }
  if (!TRUSTED_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.username || parsed.password || parsed.port) throw invalidUrl();
  const path = parsed.pathname.match(/^\/(?:([A-Za-z0-9_]{1,15})\/status|i\/web\/status)\/(\d+)\/?$/);
  if (!path) throw invalidUrl();
  return `https://x.com/${path[1] || 'i'}/status/${path[2]}`;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function text(value, fallback = '', limit = 500) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : fallback;
}

function safeId(value, fallback) {
  const id = typeof value === 'number' ? String(value) : value;
  return typeof id === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(id) ? id : fallback;
}

function thumbnailFor(metadata) {
  const options = [metadata.thumbnail, ...(Array.isArray(metadata.thumbnails) ? metadata.thumbnails.slice(-20).reverse().map((entry) => entry?.url) : [])];
  for (const option of options) {
    if (isAllowedThumbnailUrl(option)) return option;
  }
  return null;
}

function safeHeaders(metadata, format, platform) {
  const result = { 'User-Agent': 'Mozilla/5.0' };
  const allowed = { 'user-agent': 'User-Agent', referer: 'Referer', origin: 'Origin', accept: 'Accept', 'accept-language': 'Accept-Language' };
  const input = { ...metadata.http_headers, ...format.http_headers };
  for (const [key, value] of Object.entries(input)) {
    const normalized = key.toLowerCase();
    if (!allowed[normalized] || typeof value !== 'string' || value.length > 2048 || /[^\x20-\x7e\t]/.test(value)) continue;
    if (normalized === 'referer' || normalized === 'origin') {
      const url = parseSafeHttpUrl(value);
      const origins = platformInputHosts(platform);
      if (metadata.extractor_key === 'GreenVideo') origins.push('greenvideo.cc');
      if (!url || !origins.includes(url.hostname)) continue;
    }
    result[allowed[normalized]] = value;
  }
  return result;
}

function watermarkFor(format, platform, metadata) {
  if (platform === 'twitter' || platform === 'youtube') return 'source';
  if (format._clipdock_webpage_original === true) return 'source';
  const note = typeof format.format_note === 'string' ? format.format_note : '';
  if (/\bwatermarked\b/i.test(note)) return 'present';
  if (!['douyin', 'tiktok'].includes(platform)) return 'unknown';
  // yt-dlp tiktok.py: play_addr / play are playback streams; download is explicitly watermarked.
  // Exact upstream fields are kept intact; this never constructs a URL by editing "playwm".
  if (/^(?:play|play_addr(?:_h264|_bytevc1)?)(?:-\d+)?$/.test(format.format_id || '')
    || /^(?:Direct|Playback) video(?: \(API\))?$/.test(note)
    || format._clipdock_playback_source === true) return 'none';
  // TikTok._extract_web_formats derives these exact IDs only from bitrateInfo[].PlayAddr.
  // Unlike App download_addr, that branch leaves format_note empty and sets preference=-1.
  // Require the upstream extractor identity and its full marker combination, not just an ID.
  if (platform === 'tiktok' && metadata.extractor_key === 'TikTok' && !note
    && /^(?:h264|bytevc1)_\d+p_\d+(?:-\d+)?$/.test(format.format_id || '')
    && format.preference === -1 && typeof format.quality === 'number') return 'none';
  return 'unknown';
}

const watermarkLabels = { none: '无平台水印源', present: '含平台水印', unknown: '水印状态未确认', source: '原始画面' };

function formatsFor(metadata, platform) {
  const rawFormats = Array.isArray(metadata.formats) ? metadata.formats.slice(0, 200) : [];
  if (metadata.url) rawFormats.push(metadata);
  const direct = format => format && typeof format === 'object' && isAllowedMediaUrl(format.url, platform)
    && !format.has_drm && (!format.protocol || ['http', 'https'].includes(format.protocol))
    && !/\.(?:m3u8|mpd)(?:[?#]|$)/i.test(format.url);
  const audio = platform === 'youtube' ? rawFormats.filter(format => direct(format)
    && format.vcodec === 'none' && format.ext === 'm4a' && format.acodec !== 'none')
    .sort((a, b) => (finiteNumber(b.language_preference) || 0) - (finiteNumber(a.language_preference) || 0)
      || (finiteNumber(b.abr) || finiteNumber(b.tbr) || 0) - (finiteNumber(a.abr) || finiteNumber(a.tbr) || 0)
      || Number(/-drc/.test(a.format_id || '')) - Number(/-drc/.test(b.format_id || '')))[0] : null;
  const candidates = [];
  for (const [index, format] of rawFormats.entries()) {
    if (!direct(format)) continue;
    const url = format.url;
    if ((format.ext && format.ext !== 'mp4') || format.vcodec === 'none') continue;
    if (platform === 'twitter' && !/\.mp4$/i.test(new URL(url).pathname)) continue;
    if (/bytevc2|UNPLAYABLE/i.test(`${format.vcodec || ''} ${format.format_note || ''}`)) continue;
    const requiresMerge = platform === 'youtube' && format.acodec === 'none';
    if (requiresMerge && !audio) continue;
    const width = finiteNumber(format.width);
    const height = finiteNumber(format.height);
    const bitrate = finiteNumber(format.tbr) ?? finiteNumber(format.vbr);
    const watermark = watermarkFor(format, platform, metadata);
    const videoSize = finiteNumber(format.filesize) ?? finiteNumber(format.filesize_approx);
    const audioSize = requiresMerge ? finiteNumber(audio.filesize) ?? finiteNumber(audio.filesize_approx) : null;
    candidates.push({
      id: safeId(format.format_id, `mp4-${height || index + 1}`),
      label: height && width ? `${Math.min(width, height)}p` : height ? `${height}p` : width ? `${width}px` : '原始画质',
      width, height, ext: 'mp4',
      filesize: requiresMerge ? (videoSize !== null && audioSize !== null ? videoSize + audioSize : null) : videoSize,
      filesizeApprox: requiresMerge || (finiteNumber(format.filesize) === null && finiteNumber(format.filesize_approx) !== null),
      // Twitter's direct MP4 variants are muxed unless the extractor explicitly marks them silent.
      hasAudio: requiresMerge || format.acodec !== 'none',
      bitrate, url, headers: safeHeaders(metadata, format, platform),
      watermark, watermarkLabel: format._clipdock_webpage_original === true ? '网页原始画面' : watermarkLabels[watermark], requiresMerge,
      ...(requiresMerge ? { audioUrl: audio.url, audioExt: 'm4a', audioHeaders: safeHeaders(metadata, audio, platform) } : {}),
      _codecPreference: /^(?:avc1|h264)/i.test(format.vcodec || '') ? 1 : 0,
    });
  }
  const watermarkRank = { none: 0, source: 0, unknown: 1, present: 2 };
  candidates.sort((a, b) => watermarkRank[a.watermark] - watermarkRank[b.watermark]
    || (b.height || 0) - (a.height || 0)
    || (b.width || 0) - (a.width || 0)
    || Number(b.hasAudio) - Number(a.hasAudio)
    || b._codecPreference - a._codecPreference
    || Number(b.url.startsWith('https:')) - Number(a.url.startsWith('https:'))
    || (b.bitrate || 0) - (a.bitrate || 0));
  const ids = new Set();
  const urls = new Set();
  const qualities = new Set();
  return candidates.filter((format) => {
    const quality = format.height || format.width ? `${format.width || 0}x${format.height || 0}` : format.url;
    if (ids.has(format.id) || urls.has(format.url) || qualities.has(quality)) return false;
    ids.add(format.id);
    urls.add(format.url);
    qualities.add(quality);
    return true;
  }).slice(0, 20).map(({ _codecPreference, ...format }) => format);
}

export function normalizeMetadata(metadata, platform = 'twitter') {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new ExtractorError('PARSE_FAILED', '暂时无法读取视频信息，请稍后重试。');
  }
  if (!Object.hasOwn(PLATFORM_LABELS, platform)) throw new ExtractorError('INVALID_URL', '不支持这个视频平台。', 400);
  if (metadata.is_live || ['is_live', 'is_upcoming', 'post_live'].includes(metadata.live_status)) {
    throw new ExtractorError('UNSUPPORTED_MEDIA', '暂不支持正在直播、预告或尚未生成回放的视频。', 422);
  }
  const entries = Array.isArray(metadata.entries) ? metadata.entries.slice(0, 64) : [metadata];
  const videos = [];
  const ids = new Set();
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const formats = formatsFor(entry, platform);
    if (!formats.length) continue;
    const id = safeId(entry.id, `video-${index + 1}`);
    if (ids.has(id)) continue;
    ids.add(id);
    videos.push({
      id,
      title: text(entry.title, text(metadata.title, `视频 ${videos.length + 1}`)),
      duration: finiteNumber(entry.duration),
      thumbnail: thumbnailFor(entry) || thumbnailFor(metadata),
      formats,
    });
    if (videos.length === 8) break;
  }
  if (!videos.length) {
    throw new ExtractorError('NO_MEDIA', '这个链接没有可下载的 MP4 视频。图片、直播或部分受限媒体暂不支持。', 422);
  }
  const first = entries.find((entry) => entry && typeof entry === 'object') || {};
  return {
    platform, platformLabel: PLATFORM_LABELS[platform],
    title: text(metadata.title, videos[0].title),
    author: text(metadata.uploader || metadata.creator || metadata.uploader_id || metadata.channel
      || first.uploader || first.creator || first.uploader_id || first.channel, '未知作者', 120),
    duration: finiteNumber(metadata.duration) ?? (videos.length === 1 ? videos[0].duration : null),
    thumbnail: thumbnailFor(metadata) || videos[0].thumbnail,
    videos,
  };
}

function executable() {
  return process.env.YTDLP_PATH?.trim() || 'yt-dlp';
}

function runExtractor(args, { signal, timeout = TOTAL_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ExtractorError('REQUEST_ABORTED', '解析已取消。', 499));
      return;
    }
    let settled = false;
    let totalBytes = 0;
    const stdout = [];
    const stderr = [];
    let timer;
    const child = spawn(executable(), args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const stop = (error) => {
      child.kill();
      finish(error);
    };
    const onAbort = () => stop(new ExtractorError('REQUEST_ABORTED', '解析已取消。', 499));
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop(new ExtractorError('EXTRACTOR_TIMEOUT', '解析超时，请检查网络连接后重试。', 504)), timeout);
    const capture = (chunks) => (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > OUTPUT_LIMIT) {
        stop(new ExtractorError('PARSE_FAILED', '帖子信息过大，暂时无法解析。'));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.on('error', (error) => {
      const missing = error.code === 'ENOENT' || error.code === 'EACCES';
      finish(new ExtractorError(missing ? 'EXTRACTOR_MISSING' : 'PARSE_FAILED', missing
        ? '未找到可用的 yt-dlp 解析器，请按使用说明安装或配置 YTDLP_PATH。'
        : '无法启动视频解析器，请检查本机配置。', missing ? 503 : 502));
    });
    child.on('close', (code) => finish(null, {
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    // Covers an abort arriving between the initial check and listener registration.
    if (signal?.aborted) onAbort();
  });
}

function classifyFailure(stderr, platform) {
  // Help links and signed URL parameters are not evidence of an access error.
  stderr = String(stderr).replace(/https?:\/\/[^\s<>"']+/g, '[URL]');
  const label = PLATFORM_LABELS[platform];
  if (/ip address is blocked|ip.*blocked|geo.?restrict|not available in your (?:country|region)|access denied|captcha|verification challenge|confirm (?:that )?you(?:'|’)?re not a bot/i.test(stderr)) {
    return new ExtractorError('PLATFORM_BLOCKED', `${label} 限制了当前网络的访问，或要求完成平台验证。暂时无法解析这个视频。`, 422);
  }
  if (platform === 'youtube' && /No supported JavaScript runtime|JavaScript runtime.*(?:not found|not supported)|Signature solving failed|n challenge solving failed|challenge solver script.*(?:missing|not available|not found)/i.test(stderr)) {
    return new ExtractorError('EXTRACTOR_SETUP', 'YouTube 播放地址解析失败：请更新 yt-dlp 及其 default 依赖，并检查 Node.js 运行环境。', 503);
  }
  if (platform === 'youtube' && /(?:require.*PO Token|PO Token.*(?:not provided|missing|required))/i.test(stderr)) {
    return new ExtractorError('PLATFORM_BLOCKED', 'YouTube 未向当前服务提供可下载的视频地址，可能要求播放验证。请稍后重试，或使用能正常访问该视频的本地部署。', 422);
  }
  if (/fresh cookies|cookies? (?:are |is )?(?:needed|required)/i.test(stderr)) {
    return new ExtractorError('COOKIE_REQUIRED', `${label} 当前要求有效的平台会话。此版本不会读取浏览器 Cookie，请换一个公开链接或稍后重试。`, 422);
  }
  if (/429|too many requests|rate.?limit/i.test(stderr)) return new ExtractorError('RATE_LIMITED', `${label} 暂时限制了请求频率，请稍后再试。`, 429);
  if (/login|log.?in|sign.?in|protected|private|authentication|age.?restrict|sensitive|cookies? are needed|401|403|not authorized/i.test(stderr)) {
    return new ExtractorError('AUTH_REQUIRED', '这个视频需要登录或受到访问限制。目前仅支持无需登录的公开视频。', 422);
  }
  if (/no video|does not contain|no media|not available|not found|404|deleted|unavailable|no formats|requested format/i.test(stderr)) {
    return new ExtractorError('NO_MEDIA', '未找到可下载的视频。帖子可能已删除、没有视频，或当前无法访问。', 422);
  }
  if (/timed? ?out|timeout|connection|network|resolve|dns|ssl|certificate|proxy|unable to download|remote end closed|502|503|504/i.test(stderr)) {
    return new ExtractorError('NETWORK_ERROR', `暂时无法连接 ${label}，请确认服务所在网络能够访问该平台后重试。`);
  }
  return new ExtractorError('PARSE_FAILED', `暂时无法解析这个视频，可能是 ${label} 接口发生变化，请稍后重试或更新解析器。`);
}

function extractorDiagnostics(result, metadata) {
  const entries = Array.isArray(metadata?.entries) ? metadata.entries.slice(0, 64) : [metadata];
  const formats = entries.flatMap(entry => entry && typeof entry === 'object'
    ? [...(Array.isArray(entry.formats) ? entry.formats.slice(0, 200) : []), ...(entry.url ? [entry] : [])] : []);
  const count = values => {
    const totals = new Map();
    for (const value of values) {
      const key = totals.has(value) || totals.size < 20 ? value : 'other';
      totals.set(key, (totals.get(key) || 0) + 1);
    }
    return Object.fromEntries(totals);
  };
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const clues = [
    ['bot_challenge', /captcha|verification challenge|confirm (?:that )?you(?:'|’)?re not a bot/i],
    ['js_runtime', /No supported JavaScript runtime|JavaScript runtime.*(?:not found|not supported)/i],
    ['js_solver', /Signature solving failed|n challenge solving failed|challenge solver script.*(?:missing|not available|not found)/i],
    ['po_token', /(?:require.*PO Token|PO Token.*(?:not provided|missing|required))/i],
    ['only_images', /Only images are available/i],
    ['rate_limited', /429|too many requests|rate.?limit/i],
    ['login_required', /login|log.?in|sign.?in|authentication|fresh cookies/i],
    ['network', /timed? ?out|timeout|connection|unable to download|certificate/i],
  ].filter(([, pattern]) => pattern.test(stderr)).map(([clue]) => clue);
  const codec = value => {
    if (!value) return 'unknown';
    if (value === 'none') return 'none';
    return /^(?:avc|h264)/i.test(value) ? 'h264' : /^(?:hevc|h265|hev|hvc)/i.test(value) ? 'h265'
      : /^(?:av01|av1)/i.test(value) ? 'av1' : /^(?:vp0?9)/i.test(value) ? 'vp9' : 'other';
  };
  return {
    exitCode: Number.isInteger(result.code) ? result.code : null,
    totalFormats: formats.length,
    protocols: count(formats.map(format => ['http', 'https', 'm3u8_native', 'm3u8', 'http_dash_segments', 'mhtml'].includes(format?.protocol) ? format.protocol : 'other')),
    videoCodecs: count(formats.map(format => codec(format?.vcodec))),
    domains: count(formats.map(format => {
      const url = parseSafeHttpUrl(format?.url);
      return url && Object.keys(PLATFORM_LABELS).some(platform => isAllowedMediaUrl(format.url, platform)) ? url.hostname : 'untrusted_or_missing';
    })),
    drmFormats: formats.filter(format => format?.has_drm).length,
    clues,
  };
}

// --ignore-no-formats-error can exit successfully with metadata but no video,
// including when YouTube requests a bot check. Keep its warnings until after
// normalization; otherwise every such failure is incorrectly shown as NO_MEDIA.
export function normalizeExtractorResult(result, platform) {
  let metadata;
  try {
    if (result.code !== 0) throw classifyFailure(result.stderr || '', platform);
    try { metadata = JSON.parse(result.stdout); } catch {
      throw new ExtractorError('PARSE_FAILED', '解析器没有返回有效的视频信息，请稍后重试。');
    }
    try { return normalizeMetadata(metadata, platform); } catch (error) {
      if (error.code === 'NO_MEDIA' && result.stderr) {
        const cause = classifyFailure(result.stderr, platform);
        if (!['PARSE_FAILED', 'NO_MEDIA'].includes(cause.code)) throw cause;
      }
      throw error;
    }
  } catch (error) {
    // Only bounded counts and controlled labels are logged. Never retain raw
    // stderr, media URLs, request headers, cookies, or the video's title here.
    error.diagnostics = extractorDiagnostics(result, metadata);
    throw error;
  }
}

const mobileAgent = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

function routerDataFromHtml(html) {
  const marker = /(?:window\.)?_ROUTER_DATA\s*=\s*/g.exec(html);
  if (!marker) return null;
  const start = marker.index + marker[0].length;
  if (html[start] !== '{') return null;
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      if (--depth === 0) {
        try { return JSON.parse(html.slice(start, index + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export function metadataFromDouyinShareHtml(html, expectedId) {
  const router = routerDataFromHtml(html);
  const queue = [{ node: router?.loaderData, depth: 0 }];
  let item;
  for (let scanned = 0; queue.length && scanned < 500; scanned++) {
    const { node, depth } = queue.shift();
    if (!node || typeof node !== 'object' || depth > 8) continue;
    if (node.video && String(node.aweme_id || node.item_id || node.id || '') === expectedId) { item = node; break; }
    for (const value of Object.values(node)) if (value && typeof value === 'object') queue.push({ node: value, depth: depth + 1 });
  }
  if (!item) throw new ExtractorError('COOKIE_REQUIRED', '抖音分享页未提供公开视频信息，当前可能需要有效的平台会话或平台验证。', 422);
  const video = item.video;
  const rawFormats = [];
  const addAddress = (address, id, note, bitrate) => {
    for (const [index, url] of (Array.isArray(address?.url_list) ? address.url_list : []).entries()) {
      rawFormats.push({ format_id: `${id}-${index}`, format_note: note, url, ext: 'mp4', acodec: 'aac', vcodec: 'h264',
        width: address.width || video.width, height: address.height || video.height, filesize: address.data_size, tbr: bitrate,
        _clipdock_playback_source: id !== 'download_addr', http_headers: { 'User-Agent': mobileAgent, Referer: 'https://www.iesdouyin.com/' } });
    }
  };
  addAddress(video.play_addr, 'play_addr', 'Direct video');
  addAddress(video.play_addr_h264, 'play_addr_h264', 'Direct video');
  for (const [index, variant] of (Array.isArray(video.bit_rate) ? video.bit_rate : []).slice(0, 20).entries()) {
    addAddress(variant.play_addr, `playback-${index}`, 'Playback video', finiteNumber(variant.bit_rate) / 1000);
  }
  if (video.download_addr) addAddress(video.download_addr, 'download_addr', video.has_watermark ? 'Download video, watermarked' : 'Download video');
  const author = item.author || {};
  return { id: expectedId, title: item.desc || '抖音视频', uploader: author.nickname || author.unique_id || author.short_id,
    duration: finiteNumber(video.duration ?? item.duration) === null ? null : Number(video.duration ?? item.duration) / 1000,
    thumbnails: (video.cover?.url_list || video.origin_cover?.url_list || []).map(url => ({ url })), formats: rawFormats };
}

async function douyinShareFallback(url, { signal, timeout }) {
  const dispatcher = new EnvHttpProxyAgent();
  const timerSignal = AbortSignal.timeout(Math.max(1, timeout));
  const combinedSignal = signal ? AbortSignal.any([signal, timerSignal]) : timerSignal;
  const allowedPageHosts = new Set(['v.douyin.com', 'www.douyin.com', 'douyin.com', 'www.iesdouyin.com', 'iesdouyin.com']);
  let resolvedVideoUrl = null;
  async function requestPage(target) {
    let current = target;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const parsed = parseSafeHttpUrl(current);
      if (!parsed || !allowedPageHosts.has(parsed.hostname)) throw new ExtractorError('PLATFORM_BLOCKED', '抖音分享链接跳转到不支持的页面。', 422);
      const response = await proxyFetch(current, { dispatcher, signal: combinedSignal, redirect: 'manual', headers: { 'User-Agent': mobileAgent, Accept: 'text/html' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 3) throw new ExtractorError('PLATFORM_BLOCKED', '抖音分享链接跳转异常，请使用完整视频链接。', 422);
        current = new URL(location, current).href;
        continue;
      }
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new ExtractorError('PLATFORM_BLOCKED', '抖音暂未允许读取这个公开分享页。', 422);
      }
      let bytes = 0; const chunks = [];
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) throw new ExtractorError('PARSE_FAILED', '分享页信息过大，暂时无法解析。');
        chunks.push(Buffer.from(chunk));
      }
      return { url: current, html: Buffer.concat(chunks).toString('utf8') };
    }
  }
  try {
    let id = new URL(url).pathname.match(/\/video\/(\d+)/)?.[1];
    let page;
    if (!id) {
      page = await requestPage(url);
      id = new URL(page.url).pathname.match(/\/video\/(\d+)/)?.[1];
      if (!id) throw new ExtractorError('INVALID_URL', '这个抖音短链接没有指向视频，请复制完整视频链接。', 400);
    }
    resolvedVideoUrl = `https://www.douyin.com/video/${id}`;
    if (!page || !new URL(page.url).hostname.endsWith('iesdouyin.com')) page = await requestPage(`https://www.iesdouyin.com/share/video/${id}/`);
    return normalizeMetadata(metadataFromDouyinShareHtml(page.html, id), 'douyin');
  } catch (error) {
    if (signal?.aborted) throw new ExtractorError('REQUEST_ABORTED', '解析已取消。', 499);
    if (error instanceof ExtractorError) { error.resolvedVideoUrl = resolvedVideoUrl; throw error; }
    throw new ExtractorError(timerSignal.aborted ? 'EXTRACTOR_TIMEOUT' : 'NETWORK_ERROR', '暂时无法读取抖音分享页，请检查网络后重试。', timerSignal.aborted ? 504 : 502);
  } finally { await dispatcher.destroy(); }
}

async function stopRendererTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      // Only this task's Python process and its descendants are targeted.
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill(); resolve(); }, 4000);
      const done = () => { clearTimeout(timer); resolve(); };
      killer.once('error', () => { child.kill(); done(); });
      killer.once('close', done);
    });
  } else {
    // The renderer has its own process group, including the browser it creates.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

export async function renderPublicVideo(url, { signal, timeout = 75_000, readMemory = readContainerMemory } = {}) {
  const canonical = normalizeVideoUrl(url);
  const platform = platformForUrl(canonical);
  const supported = /^https:\/\/www\.douyin\.com\/video\/\d+$/.test(canonical)
    || /^https:\/\/www\.tiktok\.com\/@[A-Za-z0-9_.-]{1,100}\/video\/\d+$/.test(canonical)
    || /^https:\/\/www\.tiktokv\.com\/share\/video\/\d+\/$/.test(canonical);
  if (!supported) {
    throw new ExtractorError('INVALID_URL', '请使用完整的抖音或 TikTok 视频链接进行匿名浏览器解析。', 400);
  }
  if (signal?.aborted) throw new ExtractorError('REQUEST_ABORTED', '解析已取消。', 499);
  const memoryError = pressure => {
    console.warn(JSON.stringify({ event: 'browser_memory_limit', platform, limitBytes: pressure.limitBytes,
      usageBytes: pressure.usageBytes, thresholdBytes: pressure.thresholdBytes,
      ...(pressure.breakdown ? { breakdown: pressure.breakdown } : {}) }));
    return new ExtractorError('BROWSER_RESOURCE_LIMIT', '当前服务器内存不足以运行此视频的浏览器解析。请稍后重试，或使用内存更充足的本地部署。', 503);
  };
  let containerMemory;
  try { containerMemory = memoryPressure(await readMemory()); } catch { /* No reliable cgroup data: keep normal behavior. */ }
  if (signal?.aborted) throw new ExtractorError('REQUEST_ABORTED', '解析已取消。', 499);
  if (containerMemory?.exceeded) throw memoryError(containerMemory);
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const python = process.env.SCRAPLING_PYTHON?.trim() || path.join(projectRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const profile = await fs.mkdtemp(path.join(temporaryRoot, 'clipdock-render-'));
  try {
    const metadata = await new Promise((resolve, reject) => {
      let settled = false; let stopping = false; let bytes = 0;
      const chunks = [];
      const duration = Math.max(3000, Math.min(90_000, timeout));
      const child = spawn(python, [path.join(projectRoot, 'scripts/render_public_video.py'), canonical,
        '--timeout-ms', String(Math.max(3000, duration - 1000)), '--profile-dir', profile], {
        windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
      let timer;
      let stopMemoryWatch = () => {};
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopMemoryWatch();
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(value);
      };
      const stop = async error => {
        if (settled || stopping) return;
        stopping = true;
        clearTimeout(timer);
        stopMemoryWatch();
        await stopRendererTree(child);
        finish(error);
      };
      const onAbort = () => { void stop(new ExtractorError('REQUEST_ABORTED', '解析已取消。', 499)); };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { void stop(new ExtractorError('EXTRACTOR_TIMEOUT', '匿名浏览器解析超时，请稍后重试。', 504)); }, duration);
      if (containerMemory) stopMemoryWatch = watchContainerMemory(pressure => {
        void stop(memoryError(pressure));
      }, { readMemory });
      const capture = collect => chunk => {
        if (settled || stopping) return;
        bytes += chunk.length;
        if (bytes > OUTPUT_LIMIT) { void stop(new ExtractorError('PARSE_FAILED', '网页解析信息过大。')); return; }
        if (collect) chunks.push(chunk);
      };
      child.stdout.on('data', capture(true));
      child.stderr.on('data', capture(false));
      child.once('error', () => finish(new ExtractorError('BROWSER_MISSING', '未找到匿名浏览器解析环境，请运行 setup-browser.cmd。', 503)));
      child.once('close', () => {
        if (settled || stopping) return;
        let output;
        try { output = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
          finish(new ExtractorError('PARSE_FAILED', '匿名浏览器未返回有效的视频信息。'));
          return;
        }
        if (!output.ok) {
          const code = ['BROWSER_MISSING', 'PLATFORM_BLOCKED', 'EXTRACTOR_TIMEOUT', 'INVALID_URL', 'NO_MEDIA'].includes(output.code) ? output.code : 'PARSE_FAILED';
          const messages = { BROWSER_MISSING: '匿名浏览器环境未就绪，请运行 setup-browser.cmd 并检查 Chrome 安装。',
            PLATFORM_BLOCKED: '匿名浏览器未获得视频播放地址，平台可能要求登录或验证。',
            EXTRACTOR_TIMEOUT: '匿名浏览器解析超时，请稍后重试。', INVALID_URL: '请使用完整的抖音或 TikTok 视频链接。',
            NO_MEDIA: '这个视频已删除、作者不可用，或没有公开媒体。', PARSE_FAILED: '匿名浏览器暂时无法解析视频。' };
          finish(new ExtractorError(code, messages[code], code === 'BROWSER_MISSING' ? 503 : code === 'EXTRACTOR_TIMEOUT' ? 504 : 422));
          return;
        }
        finish(null, output.metadata);
      });
      if (signal?.aborted) onAbort();
    });
    return normalizeMetadata(metadata, platform);
  } finally {
    // This directory was created above for this request; never remove a browser/user profile.
    const resolvedProfile = path.resolve(profile);
    if (path.dirname(resolvedProfile) === temporaryRoot && path.basename(resolvedProfile).startsWith('clipdock-render-')) {
      await fs.rm(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}

async function resolveTikTokBrowserTarget(url, { signal, timeout }) {
  const dispatcher = new EnvHttpProxyAgent();
  const timed = AbortSignal.timeout(Math.max(1, timeout));
  const combined = signal ? AbortSignal.any([signal, timed]) : timed;
  let current = url;
  try {
    for (let redirects = 0; redirects < 4; redirects++) {
      const canonical = normalizeVideoUrl(current);
      if (platformForUrl(canonical) !== 'tiktok') throw new ExtractorError('INVALID_URL', '短链接没有指向 TikTok 视频。', 400);
      if (/\/@[^/]+\/video\/\d+$/.test(canonical) || /www\.tiktokv\.com\/share\/video\/\d+\/$/.test(canonical)) return canonical;
      const response = await proxyFetch(canonical, { dispatcher, signal: combined, redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (![301,302,303,307,308].includes(response.status) || !location) break;
      current = new URL(location, canonical).href;
    }
    throw new ExtractorError('PLATFORM_BLOCKED', 'TikTok 短链接暂时无法解析，请复制完整视频链接。', 422);
  } finally { await dispatcher.destroy(); }
}

export async function getExtractorHealth() {
  try {
    const result = await runExtractor(['--ignore-config', '--version'], { timeout: 8000 });
    const version = result.stdout.trim();
    return { available: result.code === 0 && /^\d{4}\.\d{2}\.\d{2}(?:[.\w+-]*)?$/.test(version), version: /^\d{4}\.\d{2}\.\d{2}(?:[.\w+-]*)?$/.test(version) ? version : null };
  } catch { return { available: false, version: null }; }
}

export async function extractVideo(inputUrl, { signal } = {}) {
  const url = normalizeSupportedVideoUrl(inputUrl);
  const platform = platformForUrl(url);
  const deadline = Date.now() + TOTAL_TIMEOUT;
  const failures = [];
  let browserUrl = url;
  for (const api of platform === 'twitter' ? ['syndication', 'graphql'] : [null]) {
    const remaining = deadline - Date.now();
    if (remaining < 1000) break;
    try {
      const result = await runExtractor([
        '--ignore-config', '--no-cache-dir', '--skip-download', '--dump-single-json',
        '--no-progress', '--no-colors', '--ignore-no-formats-error',
        '--socket-timeout', '12', '--extractor-retries', '0', '--retries', '0',
        ...(platform === 'twitter' ? ['--playlist-items', '1:8', '--extractor-args', `twitter:api=${api}`] : ['--no-playlist']),
        ...(platform === 'youtube' ? ['--js-runtimes', `node:${process.execPath}`] : []), '--', url,
      ], { signal, timeout: Math.min(remaining, ['douyin', 'tiktok'].includes(platform) ? 20_000 : api === 'syndication' ? 35_000 : remaining) });
      return normalizeExtractorResult(result, platform);
    } catch (error) {
      if (!(error instanceof ExtractorError)) throw new ExtractorError('PARSE_FAILED', '暂时无法解析视频，请稍后重试。');
      if (error.diagnostics) console.warn(JSON.stringify({ event: 'extractor_failure', platform, code: error.code, ...error.diagnostics }));
      if (['EXTRACTOR_MISSING', 'REQUEST_ABORTED'].includes(error.code)) throw error;
      failures.push(error);
    }
  }
  if (platform === 'douyin' && deadline - Date.now() >= 1000) {
    try { return await douyinShareFallback(url, { signal, timeout: Math.min(15_000, deadline - Date.now()) }); }
    catch (error) {
      if (error.code === 'REQUEST_ABORTED') throw error;
      if (/^https:\/\/www\.douyin\.com\/video\/\d+$/.test(error.resolvedVideoUrl || '')) browserUrl = error.resolvedVideoUrl;
      failures.push(error);
    }
  }
  if (platform === 'tiktok' && deadline - Date.now() >= 5000) {
    try { browserUrl = await resolveTikTokBrowserTarget(url, { signal, timeout: Math.min(10_000, deadline - Date.now()) }); }
    catch (error) {
      if (signal?.aborted) throw new ExtractorError('REQUEST_ABORTED', '解析已取消。', 499);
      browserUrl = null;
      failures.push(error instanceof ExtractorError ? error : new ExtractorError('PLATFORM_BLOCKED', 'TikTok 短链接暂时无法解析，请使用完整视频链接。', 422));
    }
  }
  if (['douyin', 'tiktok'].includes(platform) && browserUrl && deadline - Date.now() >= 5000) {
    try { return await renderPublicVideo(browserUrl, { signal, timeout: Math.min(75_000, deadline - Date.now()) }); }
    catch (error) {
      if (['REQUEST_ABORTED', 'NO_MEDIA', 'BROWSER_RESOURCE_LIMIT'].includes(error.code)) throw error;
      failures.push(error);
    }
  }
  // Prefer a specific actionable failure to an opaque failure from the fallback API.
  const priority = ['BROWSER_RESOURCE_LIMIT', 'BROWSER_MISSING', 'EXTRACTOR_SETUP', 'PLATFORM_BLOCKED', 'COOKIE_REQUIRED', 'RATE_LIMITED', 'AUTH_REQUIRED', 'UNSUPPORTED_MEDIA', 'NO_MEDIA', 'NETWORK_ERROR', 'EXTRACTOR_TIMEOUT', 'PARSE_FAILED'];
  failures.sort((a, b) => priority.indexOf(a.code) - priority.indexOf(b.code));
  throw failures[0] || new ExtractorError('EXTRACTOR_TIMEOUT', '解析超时，请稍后重试。', 504);
}

export async function extractTweet(url, options = {}) {
  return extractVideo(normalizeTweetUrl(url), options);
}
