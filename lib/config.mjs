export function normalizePublicOrigin(value = '') {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw new Error('PUBLIC_ORIGIN 必须是完整的 HTTPS 网站地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('PUBLIC_ORIGIN 必须是 HTTPS 来源地址，不含路径、账号或查询参数');
  }
  return url.origin;
}

function limit(value, fallback, name, maximum) {
  const number = Number(value || fallback);
  if (!Number.isInteger(number) || number < 1 || number > maximum) throw new Error(`${name} 必须是 1–${maximum} 的整数`);
  return number;
}

export function runtimeConfig(env = process.env) {
  return {
    port: limit(env.PORT, 4317, 'PORT', 65535),
    host: env.HOST || '127.0.0.1',
    publicOrigin: normalizePublicOrigin(env.PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL || ''),
    maxParseJobs: limit(env.MAX_PARSE_JOBS, 2, 'MAX_PARSE_JOBS', 4),
    maxMergeJobs: limit(env.MAX_MERGE_JOBS, 2, 'MAX_MERGE_JOBS', 4),
    maxDownloads: limit(env.MAX_DOWNLOADS, 4, 'MAX_DOWNLOADS', 8),
  };
}
