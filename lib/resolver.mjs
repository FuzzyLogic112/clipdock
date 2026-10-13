import { extractVideo, normalizeMetadata } from './extractor.mjs';
import { extractGreenVideo } from './greenvideo.mjs';
import { normalizeVideoUrl, platformForUrl } from './platforms.mjs';
import { resolveLocalUrl } from './shortlinks.mjs';

export const PROVIDERS = Object.freeze([
  { id: 'auto', label: '自动选择' },
  { id: 'local', label: '本地解析' },
  { id: 'greenvideo', label: 'GreenVideo 扩展解析' },
]);

const problem = (code, message, status = 422) => Object.assign(new Error(message), { code, message, status });
export function normalizeProvider(value = 'auto') {
  if (!PROVIDERS.some(provider => provider.id === value)) throw problem('INVALID_PROVIDER', '请选择有效的解析方式。', 400);
  return value;
}

export async function resolveVideo(input, options = {}) {
  const url = normalizeVideoUrl(input);
  const platform = platformForUrl(url);
  const provider = normalizeProvider(options.provider);
  const local = options.localExtractor || extractVideo;
  const remote = options.remoteExtractor || extractGreenVideo;
  const localOnly = ['youtube', 'douyin'].includes(platform);
  const remoteOnly = platform === 'kuaishou';
  if (provider === 'greenvideo' && localOnly) throw problem('PROVIDER_UNSUPPORTED', 'GreenVideo 已暂停此平台，请选择本地解析或自动选择。');
  if (provider === 'local' && remoteOnly) throw problem('PROVIDER_UNSUPPORTED', '快手目前使用 GreenVideo 扩展解析，请选择自动或 GreenVideo。');
  const order = provider === 'local' || (provider === 'auto' && localOnly) ? ['local']
    : provider === 'greenvideo' || remoteOnly ? ['greenvideo'] : ['local', 'greenvideo'];
  const started = Date.now();
  let lastError;
  for (const kind of order) {
    if (options.signal?.aborted) throw problem('REQUEST_ABORTED', '解析已取消。', 499);
    const remaining = 120_000 - (Date.now() - started);
    if (remaining < 1000) break;
    const budget = Math.min(remaining, kind === 'local' && order.length > 1 ? 65_000 : 120_000);
    const timer = AbortSignal.timeout(budget);
    const signal = options.signal ? AbortSignal.any([options.signal, timer]) : timer;
    try {
      const metadata = kind === 'local' ? await local(await resolveLocalUrl(url, { signal }), { signal })
        : normalizeMetadata(await remote(url, { platform, signal, timeoutMs: Math.min(45_000, budget) }), platform);
      return { ...metadata, provider: kind, providerLabel: kind === 'local' ? '本地解析' : 'GreenVideo 扩展解析' };
    } catch (error) {
      if (options.signal?.aborted) throw problem('REQUEST_ABORTED', '解析已取消。', 499);
      lastError = timer.aborted ? problem('EXTRACTOR_TIMEOUT', '解析超时，请稍后重试。', 504) : error;
      if (['INVALID_URL', 'INVALID_PROVIDER', 'INVALID_REDIRECT'].includes(error.code)) throw error;
    }
  }
  throw lastError || problem('EXTRACTOR_TIMEOUT', '解析超时，请稍后重试。', 504);
}
