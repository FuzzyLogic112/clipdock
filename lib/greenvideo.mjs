import { constants, createCipheriv, createPublicKey, publicDecrypt, publicEncrypt } from 'node:crypto';
import { fetch as proxyFetch, EnvHttpProxyAgent } from 'undici';
import { normalizeVideoUrl, platformForUrl, isAllowedMediaUrl, isAllowedThumbnailUrl, parseSafeHttpUrl } from './platforms.mjs';

// Public frontend protocol observed on 2026-10-13: CkWcnjeT.js / j1yGq1Yf.js.
// This is an optional online provider, not a reconstruction of its private backend.
const ORIGIN = 'https://greenvideo.cc';
const IV = Buffer.from('a2Vkb3VAODk4OSE2MzIzMw==', 'base64');
const MAX_RESPONSE = 2 * 1024 * 1024;
const PAUSED = new Set(['youtube', 'douyin', 'ixigua']);
const PROVIDER_HOSTS = {
  twitter: ['twitter', 'x', 'x.com'], tiktok: ['tiktok'],
  kuaishou: ['kuaishou'], weibo: ['weibo'], xiaohongshu: ['xiaohongshu', 'xhs'],
  instagram: ['instagram', 'ins'], facebook: ['facebook', 'fb'],
  vimeo: ['vimeo'], pinterest: ['pinterest'],
};
const REFERER_HOSTS = {
  twitter: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'], tiktok: ['www.tiktok.com', 'tiktok.com'],
  kuaishou: ['www.kuaishou.com', 'kuaishou.com', 'www.kwai.com', 'kwai.com'],
  weibo: ['weibo.com', 'www.weibo.com', 'm.weibo.cn'], xiaohongshu: ['www.xiaohongshu.com', 'xiaohongshu.com'],
  instagram: ['www.instagram.com', 'instagram.com'], facebook: ['www.facebook.com', 'facebook.com', 'm.facebook.com'],
  vimeo: ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'], pinterest: ['www.pinterest.com', 'pinterest.com'],
};
let dispatcher;

export class GreenVideoError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'GreenVideoError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message, status) => new GreenVideoError(code, message, status);
const text = (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : fallback;
const number = value => value != null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

function providerError(code) {
  if (Number(code) === 555) return fail('NO_MEDIA', 'GreenVideo 未找到可下载的公开视频，请检查链接是否公开或已被删除。', 422);
  if (Number(code) === 4291) return fail('CAPTCHA_REQUIRED', 'GreenVideo 要求人工验证码，请稍后重试或使用原站解析。', 422);
  if (Number(code) === 429) return fail('RATE_LIMITED', 'GreenVideo 请求过于频繁，请稍后重试。', 429);
  if ([401, 403].includes(Number(code))) return fail('PROVIDER_ACCESS_REQUIRED', 'GreenVideo 当前要求登录或拒绝访问，无法继续匿名解析。', 422);
  if (Number(code) === 402) return fail('PROVIDER_PAYMENT_REQUIRED', 'GreenVideo 当前要求付费，无法继续匿名解析。', 422);
  return fail('PROVIDER_UNAVAILABLE', 'GreenVideo 暂时无法解析这个链接，请稍后重试。');
}

// Match the website's public-key envelope without downloading/executing third-party JavaScript.
// encryptLong uses one RSA block when it fits, otherwise fixed 117-character chunks.
export function encodeGreenVideoRequest(payload, keys) {
  try {
    if (typeof keys?.k1 !== 'string' || typeof keys?.k2 !== 'string' || keys.k1.length > 8192 || keys.k2.length > 8192) throw new Error();
    const key = createPublicKey({ key: Buffer.from(keys.k1, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'rsa' || ![1024, 2048, 3072, 4096].includes(key.asymmetricKeyDetails?.modulusLength)) throw new Error();
    const aesKey = publicDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(keys.k2, 'base64'));
    if (![16, 24, 32].includes(aesKey.length)) throw new Error();
    const cipher = createCipheriv(`aes-${aesKey.length * 8}-cbc`, aesKey, IV);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]).toString('base64');
    const chunkSize = encrypted.length <= key.asymmetricKeyDetails.modulusLength / 8 - 11 ? encrypted.length : 117;
    const blocks = [];
    for (let offset = 0; offset < encrypted.length; offset += chunkSize) {
      blocks.push(publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(encrypted.slice(offset, offset + chunkSize), 'ascii')));
    }
    return Buffer.concat(blocks).toString('base64');
  } catch {
    throw fail('PROVIDER_PROTOCOL_CHANGED', 'GreenVideo 的公开请求协议发生变化，当前适配器无法解析。');
  }
}

function itemsFor(data) {
  return Array.isArray(data?.videoItemVoList) ? data.videoItemVoList.slice(0, 100) : [];
}

function itemHeaders(item, platform) {
  const headers = { 'User-Agent': 'Mozilla/5.0' };
  if (!item.headers || typeof item.headers !== 'object' || Array.isArray(item.headers)) return headers;
  for (const [key, value] of Object.entries(item.headers)) {
    const name = key.toLowerCase();
    if (!['user-agent', 'referer', 'origin'].includes(name) || typeof value !== 'string' || value.length > 2048 || /[^\x20-\x7e\t]/.test(value)) continue;
    if (name !== 'user-agent') {
      const parsed = parseSafeHttpUrl(value);
      if (!parsed || parsed.protocol !== 'https:' || ![new URL(ORIGIN).hostname, ...(REFERER_HOSTS[platform] || [])].includes(parsed.hostname)) continue;
    }
    headers[{ 'user-agent': 'User-Agent', referer: 'Referer', origin: 'Origin' }[name]] = value;
  }
  return headers;
}

function metadataItem(data, platform, fallbackId) {
  const items = itemsFor(data);
  const title = text(data.displayTitle, '视频');
  const thumbnail = [data.coverUrl, data.cover, data.thumbnail, ...items.filter(item => /图片|封面|image|cover/i.test(item?.qualityAlias || '')).map(item => item.baseUrl)]
    .find(isAllowedThumbnailUrl) || null;
  const formats = [];
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== 'object') continue;
    if (['onlyForVip', 'live', 'hlsType', 'dashType', 'mustUseDownloader'].some(flag => item[flag] === true)) continue;
    if (item.canDownload === false) continue;
    if (item.fileType != null && String(item.fileType).toLowerCase() !== 'video') continue;
    if (item.fileExt != null && !/^\.?mp4$/i.test(String(item.fileExt))) continue;
    const label = text(item.qualityAlias);
    if (/图片|封面|image|cover|音频|audio|文本|text/i.test(label)) continue;
    if (!isAllowedMediaUrl(item.baseUrl, platform) || /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(item.baseUrl)) continue;
    if (item.canDirectDownload === false) continue;
    const height = number(item.height) || number(label.match(/(?:^|\s)(\d{3,4})[pP](?:\s|$)/)?.[1]);
    const format = {
      format_id: `green-${index}`, url: item.baseUrl, ext: 'mp4', protocol: 'https',
      width: number(item.width), height, filesize: number(item.size ?? item.fileSize ?? item.filesize),
      format_note: /有水印|带水印|watermarked/i.test(label) ? 'watermarked' : label,
      acodec: /无声|静音|无音频|video only/i.test(label) ? 'none' : 'unknown',
      vcodec: 'unknown', _clipdock_provider: 'greenvideo',
      http_headers: itemHeaders(item, platform),
    };
    // Provider labels do not prove a watermark-free playback source.
    formats.push(format);
  }
  const suppliedId = String(data.vid ?? data.id ?? fallbackId);
  return {
    id: /^[A-Za-z0-9_.-]{1,100}$/.test(suppliedId) ? suppliedId : fallbackId,
    title, thumbnail, duration: number(data.duration), formats,
    extractor_key: 'GreenVideo', sourceProvider: 'greenvideo',
    http_headers: { 'User-Agent': 'Mozilla/5.0' },
  };
}

export function normalizeGreenVideoResponse(data, { platform } = {}) {
  if (!data || typeof data !== 'object' || !PROVIDER_HOSTS[platform]) throw fail('PROVIDER_INVALID_RESPONSE', 'GreenVideo 返回了无法识别的结果。');
  const host = text(data.host).toLowerCase();
  if (!PROVIDER_HOSTS[platform].includes(host)) throw fail('PROVIDER_INVALID_RESPONSE', 'GreenVideo 返回的平台与输入链接不一致。');
  const parent = metadataItem(data, platform, 'green-video');
  const nested = Array.isArray(data.videoInfoVoList) ? data.videoInfoVoList.slice(0, 8) : [];
  const entries = nested.map((entry, index) => metadataItem({ ...entry, displayTitle: entry?.displayTitle || data.displayTitle }, platform, `green-${index}`))
    .filter(entry => entry.formats.length);
  if (parent.formats.length) entries.unshift(parent);
  if (!entries.length) throw fail('NO_DOWNLOADABLE_VIDEO', 'GreenVideo 未返回当前支持的视频直链；结果可能只有音频、分段播放清单，或需要在原站准备下载。', 422);
  return entries.length === 1 ? entries[0] : { ...parent, entries: entries.slice(0, 8) };
}

async function readJson(response) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw providerError(response.status);
  }
  if (number(response.headers.get('content-length')) > MAX_RESPONSE) {
    await response.body?.cancel().catch(() => {});
    throw fail('PROVIDER_INVALID_RESPONSE', 'GreenVideo 返回的数据过大。');
  }
  const reader = response.body?.getReader();
  if (!reader) throw fail('PROVIDER_INVALID_RESPONSE', 'GreenVideo 返回了空结果。');
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE) throw fail('PROVIDER_INVALID_RESPONSE', 'GreenVideo 返回的数据过大。');
      parts.push(Buffer.from(value));
    }
    const parsed = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof GreenVideoError || error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
    throw fail('PROVIDER_INVALID_RESPONSE', 'GreenVideo 返回的内容无法读取。');
  } finally { reader.releaseLock(); }
}

export async function extractGreenVideo(input, { platform, signal, timeoutMs = 45_000, fetchImpl } = {}) {
  const url = normalizeVideoUrl(input);
  const detected = platformForUrl(url);
  if (platform && platform !== detected) throw fail('INVALID_URL', '链接与指定平台不一致。', 400);
  platform = detected;
  if (PAUSED.has(platform)) throw fail('PROVIDER_PLATFORM_PAUSED', 'GreenVideo 当前暂停该平台解析，将使用本机解析器。', 422);
  if (!PROVIDER_HOSTS[platform]) throw fail('UNSUPPORTED_PLATFORM', 'GreenVideo 适配器尚未验证这个平台。', 422);
  const timeout = AbortSignal.timeout(Math.min(90_000, Math.max(1000, timeoutMs)));
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  requestSignal.throwIfAborted();
  if (!fetchImpl) {
    dispatcher ||= new EnvHttpProxyAgent();
    fetchImpl = (target, options) => proxyFetch(target, { ...options, dispatcher });
  }
  const request = async (endpoint, body) => {
    const response = await fetchImpl(`${ORIGIN}/api${endpoint}`, {
      method: body == null ? 'GET' : 'POST', redirect: 'error', signal: requestSignal,
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', Referer: `${ORIGIN}/`, Origin: ORIGIN,
        KdSystem: 'GreenVideo', ...(body == null ? {} : { 'Content-Type': 'application/json' }) },
      ...(body == null ? {} : { body }),
    });
    return readJson(response);
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const keys = await request('/auth/keys');
      if (Number(keys.code) !== 200) throw providerError(keys.code);
      const body = encodeGreenVideoRequest({ url }, keys.data);
      const result = await request('/video/cnSimpleExtract', body);
      if (Number(result.code) === 530 && attempt === 0) continue;
      if (Number(result.code) !== 200) throw providerError(result.code);
      return normalizeGreenVideoResponse(result.data, { platform });
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    if (timeout.aborted) throw fail('EXTRACT_TIMEOUT', 'GreenVideo 解析超时，请稍后重试。', 504);
    if (error instanceof GreenVideoError) throw error;
    throw fail('PROVIDER_UNAVAILABLE', '暂时无法连接 GreenVideo，请检查网络后重试。');
  }
}
