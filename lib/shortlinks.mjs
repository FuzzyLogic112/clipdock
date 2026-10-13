import { fetch as proxyFetch, EnvHttpProxyAgent } from 'undici';
import { normalizeVideoUrl, parseSafeHttpUrl, platformCatalog, platformForUrl } from './platforms.mjs';

const shortHosts = new Set(['t.cn', 'pin.it', 'fb.watch', 'xhslink.com', 'v.kuaishou.com']);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maxRedirects = 5;
const failure = (code, message, status = 422) => Object.assign(new Error(message), { code, status });
const unresolved = () => failure('SHORT_LINK_UNRESOLVED', '这个分享短链接暂时无法展开，请复制平台上的完整视频链接。');
const invalidRedirect = () => failure('INVALID_REDIRECT', '分享链接跳转到了不支持的地址，请使用同一平台的完整视频链接。');
const cancelled = () => failure('REQUEST_ABORTED', '解析已取消。', 499);

function isShortlink(url, platform) {
  return shortHosts.has(url.hostname)
    || (platform === 'facebook' && /^\/share\/(?:r|v)\//.test(url.pathname));
}

function redirectTarget(location, current, hosts) {
  if (typeof location !== 'string' || !location || location.length > 4096 || /[\s\\]/.test(location)) throw invalidRedirect();
  let target;
  // Validate the raw authority before URL() erases an explicit default port.
  if (/^[a-z][a-z\d+.-]*:/i.test(location)) target = parseSafeHttpUrl(location);
  else if (location.startsWith('//')) target = parseSafeHttpUrl(`https:${location}`);
  else {
    try { target = parseSafeHttpUrl(new URL(location, current).href); }
    catch { throw invalidRedirect(); }
  }
  if (!target || target.protocol !== 'https:' || !hosts.has(target.hostname)) throw invalidRedirect();
  target.hash = '';
  return target.href;
}

function completeVideoUrl(current, platform) {
  try {
    const canonical = normalizeVideoUrl(current);
    if (platformForUrl(canonical) !== platform || isShortlink(new URL(canonical), platform)) return null;
    return canonical;
  } catch { return null; }
}

// Fetch implementations normally honor signal themselves. This also bounds custom
// implementations and disposes a response that arrives after cancellation.
function awaitResponse(pending, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    Promise.resolve(pending).then(response => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        Promise.resolve(response?.body?.cancel()).catch(() => {});
        reject(signal.reason);
      } else resolve(response);
    }, error => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

/** Expand new-platform share links without handing arbitrary redirects to yt-dlp. */
export async function resolveLocalUrl(input, { signal, fetchImpl, timeoutMs = 12_000 } = {}) {
  if (signal?.aborted) throw cancelled();
  const canonical = normalizeVideoUrl(input);
  const platform = platformForUrl(canonical);
  if (!isShortlink(new URL(canonical), platform)) return canonical;
  const hosts = new Set(platformCatalog().find(entry => entry.id === platform).inputHosts);
  const control = new AbortController();
  const onAbort = () => control.abort(cancelled());
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timeout = setTimeout(() => control.abort(failure('EXTRACTOR_TIMEOUT', '分享短链接解析超时，请使用完整视频链接或稍后重试。', 504)),
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 120_000) : 12_000);
  const dispatcher = fetchImpl ? null : new EnvHttpProxyAgent();
  const fetchPage = fetchImpl || ((url, init) => proxyFetch(url, { ...init, dispatcher }));
  let current = canonical;
  const visited = new Set();
  try {
    for (let redirects = 0; redirects < maxRedirects; redirects++) {
      if (control.signal.aborted) throw control.signal.reason;
      if (visited.has(current)) throw unresolved();
      visited.add(current);
      const response = await awaitResponse(fetchPage(current, {
        redirect: 'manual', signal: control.signal,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
      }), control.signal);
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (control.signal.aborted) throw control.signal.reason;
      if (!redirectStatuses.has(response.status) || !location) throw unresolved();
      current = redirectTarget(location, current, hosts);
      const complete = completeVideoUrl(current, platform);
      if (complete) return complete;
    }
    throw unresolved();
  } catch (error) {
    if (control.signal.aborted) throw control.signal.reason;
    if (['SHORT_LINK_UNRESOLVED', 'INVALID_REDIRECT'].includes(error?.code)) throw error;
    throw unresolved();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
    await dispatcher?.destroy();
  }
}
