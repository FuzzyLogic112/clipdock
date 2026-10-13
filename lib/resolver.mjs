import { extractVideo, normalizeMetadata } from './extractor.mjs';
import { extractGreenVideo } from './greenvideo.mjs';
import { normalizeSupportedVideoUrl, platformForUrl } from './platforms.mjs';
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
  const url = normalizeSupportedVideoUrl(input);
  const platform = platformForUrl(url);
  const provider = normalizeProvider(options.provider);
  const local = options.localExtractor || extractVideo;
  const remote = options.remoteExtractor || extractGreenVideo;
  const order = provider === 'auto' ? ['local', 'greenvideo'] : [provider];
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
