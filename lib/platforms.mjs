export const PLATFORM_LABELS = Object.freeze({
  twitter: 'X / Twitter', youtube: 'YouTube', douyin: '抖音', tiktok: 'TikTok',
  kuaishou: '快手', weibo: '微博', instagram: 'Instagram', facebook: 'Facebook',
  pinterest: 'Pinterest', vimeo: 'Vimeo', xiaohongshu: '小红书',
});

// Product availability is narrower than the legacy URL/metadata helpers below.
// Check this policy before starting any extractor or third-party request.
export const SUPPORTED_PLATFORMS = Object.freeze(['twitter', 'tiktok', 'instagram', 'weibo', 'pinterest']);

const twitterHosts = ['x.com', 'twitter.com'].flatMap(host => [host, `www.${host}`, `m.${host}`, `mobile.${host}`]);
const youtubeHosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'];
const douyinHosts = ['douyin.com', 'www.douyin.com', 'v.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com'];
const tiktokHosts = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'www.tiktokv.com'];
const pinterestDomains = ['com', 'fr', 'de', 'ch', 'jp', 'cl', 'ca', 'it', 'co.uk', 'nz', 'ru', 'com.au', 'at', 'pt', 'co.kr', 'es', 'com.mx', 'dk', 'ph', 'th', 'com.uy', 'co', 'nl', 'info', 'kr', 'ie', 'vn', 'com.vn', 'ec', 'mx', 'in', 'pe', 'co.at', 'hu', 'co.in', 'co.nz', 'id', 'com.ec', 'com.py', 'tw', 'be', 'uk', 'com.bo', 'com.pe'];
const inputHosts = {
  twitter: twitterHosts,
  youtube: [...youtubeHosts, 'youtu.be', 'www.youtu.be'],
  douyin: douyinHosts,
  tiktok: tiktokHosts,
  kuaishou: ['kuaishou.com', 'www.kuaishou.com', 'v.kuaishou.com'],
  weibo: ['weibo.com', 'www.weibo.com', 'm.weibo.cn', 'video.weibo.com', 't.cn'],
  instagram: ['instagram.com', 'www.instagram.com'],
  facebook: ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'fb.watch'],
  pinterest: [...pinterestDomains.flatMap(suffix => [`pinterest.${suffix}`, `www.pinterest.${suffix}`]), 'co.pinterest.com', 'au.pinterest.com', 'pin.it'],
  vimeo: ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'],
  xiaohongshu: ['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.com'],
};
const platformByHost = new Map(Object.entries(inputHosts).flatMap(([id, hosts]) => hosts.map(host => [host, id])));

// Copies keep API consumers from mutating the validation policy.
export function platformCatalog() {
  return SUPPORTED_PLATFORMS.map(id => ({ id, label: PLATFORM_LABELS[id], inputHosts: platformInputHosts(id) }));
}

export function platformInputHosts(platform) {
  return [...(inputHosts[platform] || [])];
}

function invalid() {
  return Object.assign(new Error('请粘贴支持平台的单条视频链接或分享文字；暂不支持主页、直播和播放列表。'), { code: 'INVALID_URL', status: 400 });
}

export function parseSafeHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\s\\]/.test(value)) return null;
  const authority = value.match(/^https?:\/\/([^/?#]+)/i)?.[1];
  // Reject explicit default ports as well: URL() would silently erase them.
  if (!authority || /[:@]/.test(authority)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.hostname.endsWith('.')) return null;
    return url;
  } catch { return null; }
}

function inputPlatform(host) {
  return platformByHost.get(host) || null;
}

function retainedQuery(url, names) {
  const query = new URLSearchParams();
  for (const name of names) {
    const values = url.searchParams.getAll(name);
    if (values.length > 1 || (values[0] && (values[0].length > 1024 || /[\x00-\x20\x7f]/.test(values[0])))) throw invalid();
    if (values[0]) query.set(name, values[0]);
  }
  return query.size ? `?${query}` : '';
}

function canonicalize(value) {
  const url = parseSafeHttpUrl(value);
  if (!url) throw invalid();
  const platform = inputPlatform(url.hostname);
  let match;
  if (platform === 'twitter') {
    match = url.pathname.match(/^\/(?:([A-Za-z0-9_]{1,15})\/status|i\/web\/status)\/(\d+)\/?$/);
    if (match) return `https://x.com/${match[1] || 'i'}/status/${match[2]}`;
  } else if (platform === 'youtube') {
    let id;
    if (['youtu.be', 'www.youtu.be'].includes(url.hostname)) id = url.pathname.match(/^\/([\w-]{11})\/?$/)?.[1];
    else if (url.pathname === '/watch' && url.searchParams.getAll('v').length === 1) id = url.searchParams.get('v');
    else id = url.pathname.match(/^\/shorts\/([\w-]{11})\/?$/)?.[1];
    if (id && /^[\w-]{11}$/.test(id)) return `https://www.youtube.com/watch?v=${id}`;
  } else if (platform === 'douyin') {
    if (url.hostname === 'v.douyin.com') {
      match = url.pathname.match(/^\/([A-Za-z0-9_-]{4,80})\/?$/);
      if (match) return `https://v.douyin.com/${match[1]}/`;
    } else if (['iesdouyin.com', 'www.iesdouyin.com'].includes(url.hostname)) {
      match = url.pathname.match(/^\/share\/video\/(\d+)\/?$/);
      if (match) return `https://www.douyin.com/video/${match[1]}`;
    } else {
      match = url.pathname.match(/^\/video\/(\d+)\/?$/);
      if (match) return `https://www.douyin.com/video/${match[1]}`;
    }
  } else if (platform === 'tiktok') {
    if (['vm.tiktok.com', 'vt.tiktok.com'].includes(url.hostname)) {
      match = url.pathname.match(/^\/([A-Za-z0-9_-]{4,80})\/?$/);
      if (match) return `https://${url.hostname}/${match[1]}/`;
    } else if ((match = url.pathname.match(/^\/t\/([A-Za-z0-9_-]{4,80})\/?$/))) {
      return `https://www.tiktok.com/t/${match[1]}/`;
    } else if ((match = url.pathname.match(/^\/@([A-Za-z0-9_.-]{1,100})\/video\/(\d+)\/?$/))) {
      return `https://www.tiktok.com/@${match[1]}/video/${match[2]}`;
    } else if (url.hostname === 'www.tiktokv.com' && (match = url.pathname.match(/^\/share\/video\/(\d+)\/?$/))) {
      return `https://www.tiktokv.com/share/video/${match[1]}/`;
    }
  } else if (platform === 'kuaishou') {
    if (url.hostname === 'v.kuaishou.com' && (match = url.pathname.match(/^\/([A-Za-z0-9_-]{4,100})\/?$/))) {
      return `https://v.kuaishou.com/${match[1]}`;
    }
    if (['kuaishou.com', 'www.kuaishou.com'].includes(url.hostname)
      && (match = url.pathname.match(/^\/short-video\/([A-Za-z0-9_-]{5,100})\/?$/))) {
      return `https://www.kuaishou.com/short-video/${match[1]}`;
    }
  } else if (platform === 'weibo') {
    if (url.hostname === 't.cn' && (match = url.pathname.match(/^\/([A-Za-z0-9]{4,32})\/?$/))) return `https://t.cn/${match[1]}`;
    if (url.hostname === 'm.weibo.cn' && (match = url.pathname.match(/^\/(?:status|detail)\/([A-Za-z0-9]{5,32})\/?$/))) {
      return `https://m.weibo.cn/status/${match[1]}`;
    }
    if (['weibo.com', 'www.weibo.com'].includes(url.hostname)
      && (match = url.pathname.match(/^\/(\d+)\/([A-Za-z0-9]{5,32})\/?$/))) {
      return `https://weibo.com/${match[1]}/${match[2]}`;
    }
    const fid = url.hostname === 'video.weibo.com' && /^\/show\/?$/.test(url.pathname) && url.searchParams.getAll('fid').length === 1
      ? url.searchParams.get('fid') : ['weibo.com', 'www.weibo.com'].includes(url.hostname) ? url.pathname.match(/^\/tv\/show\/(\d+:(?:[\da-f]{32}|\d{16,}))\/?$/)?.[1] : null;
    if (fid && /^\d+:(?:[\da-f]{32}|\d{16,})$/.test(fid)) return `https://weibo.com/tv/show/${fid}`;
  } else if (platform === 'instagram') {
    match = url.pathname.match(/^\/(?:[A-Za-z0-9_.]{1,30}\/)?(p|tv|reels?)\/([A-Za-z0-9_-]{5,64})\/?$/);
    if (match) return `https://www.instagram.com/${match[1] === 'reels' ? 'reel' : match[1]}/${match[2]}/`;
  } else if (platform === 'facebook') {
    if (url.hostname === 'fb.watch' && (match = url.pathname.match(/^\/([A-Za-z0-9_-]{4,100})\/?$/))) return `https://fb.watch/${match[1]}/`;
    if (url.hostname !== 'fb.watch') {
      if ((match = url.pathname.match(/^\/reel\/(\d+)\/?$/))) return `https://www.facebook.com/reel/${match[1]}`;
      if ((match = url.pathname.match(/^\/share\/(r|v)\/([A-Za-z0-9_-]{4,100})\/?$/))) return `https://www.facebook.com/share/${match[1]}/${match[2]}/`;
      let videoId;
      if (/^\/(?:watch\/?|video(?:\/video)?\.php)$/.test(url.pathname) && url.searchParams.getAll('v').length === 1) videoId = url.searchParams.get('v');
      else videoId = url.pathname.match(/^\/[A-Za-z0-9_.-]+\/videos\/(?:vb\.\d+\/)?(\d+)\/?$/)?.[1];
      if (videoId && /^\d+$/.test(videoId)) return `https://www.facebook.com/watch/?v=${videoId}`;
    }
  } else if (platform === 'pinterest') {
    if (url.hostname === 'pin.it' && (match = url.pathname.match(/^\/([A-Za-z0-9_-]{4,100})\/?$/))) return `https://pin.it/${match[1]}`;
    if (url.hostname !== 'pin.it' && (match = url.pathname.match(/^\/pin\/(?:[A-Za-z0-9_-]+--)?(\d+)\/?$/))) return `https://www.pinterest.com/pin/${match[1]}/`;
  } else if (platform === 'vimeo') {
    if (url.hostname === 'player.vimeo.com' && (match = url.pathname.match(/^\/video\/(\d+)\/?$/))) {
      return `https://player.vimeo.com/video/${match[1]}${retainedQuery(url, ['h'])}`;
    }
    if (['vimeo.com', 'www.vimeo.com'].includes(url.hostname)
      && (match = url.pathname.match(/^\/(\d+)(?:\/([A-Za-z0-9]{6,64}))?\/?$/))) {
      return `https://vimeo.com/${match[1]}${match[2] ? `/${match[2]}` : ''}${retainedQuery(url, ['h'])}`;
    }
  } else if (platform === 'xiaohongshu') {
    if (url.hostname === 'xhslink.com' && (match = url.pathname.match(/^\/(?:([A-Za-z])\/)?([A-Za-z0-9_-]{4,100})\/?$/))) return `https://xhslink.com/${match[1] ? `${match[1]}/` : ''}${match[2]}`;
    if (url.hostname !== 'xhslink.com' && (match = url.pathname.match(/^\/(?:explore|discovery\/item)\/([\da-f]{24})\/?$/i))) {
      return `https://www.xiaohongshu.com/explore/${match[1].toLowerCase()}${retainedQuery(url, ['xsec_token', 'xsec_source'])}`;
    }
  }
  throw invalid();
}

export function normalizeVideoUrl(input) {
  if (typeof input !== 'string' || input.length > 4096) throw invalid();
  const value = input.trim();
  if (/^https?:\/\/[^\s]+$/i.test(value)) return canonicalize(value);
  const matches = value.match(/https?:\/\/[^\s<>"'`“”‘’，。；！？、（）【】《》]+/gi) || [];
  if (matches.length !== 1) throw invalid();
  return canonicalize(matches[0].replace(/[),.;!\]}]+$/, ''));
}

export function normalizeSupportedVideoUrl(input) {
  const url = normalizeVideoUrl(input);
  if (!SUPPORTED_PLATFORMS.includes(inputPlatform(new URL(url).hostname))) {
    throw Object.assign(new Error('当前支持 X / Twitter、TikTok、Instagram、微博和 Pinterest。此平台已下架。'),
      { code: 'PLATFORM_UNSUPPORTED', status: 400 });
  }
  return url;
}

export function platformForUrl(value) {
  const canonical = normalizeVideoUrl(value);
  return inputPlatform(new URL(canonical).hostname);
}

const inDomains = (host, roots) => roots.some(root => host === root || host.endsWith(`.${root}`));

// Extractor URLs are API data, not a fixed CDN list. Evidence for bounded CDN roots:
// youtube: actual yt-dlp output + yt-dlp/extractor/tenplay.py's googlevideo host.
// TikTok: yt-dlp issues/4138 media URL; issues/17393 page CSP lists the CDN roots.
// Douyin: yt-dlp issues/9667 contains v26-web.douyinvod.com and v3-dy-o.zjcdn.com.
// No generic cloud-storage, arbitrary IP, user-supplied origin or arbitrary URL fallback.
const tiktokMediaRoots = ['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'tiktokv.com', 'byteoversea.com', 'ibytedtos.com'];
const douyinMediaRoots = ['douyinvod.com'];
// Evidence is from upstream extractor code or captured upstream issue output:
// Instagram: yt-dlp/yt-dlp#16327 comments (scontent-*.cdninstagram.com).
// Facebook: yt-dlp/yt-dlp#2092 (video.*.fbcdn.net).
// Pinterest: yt-dlp/yt-dlp#17167 (v1.pinimg.com).
// Weibo: yt-dlp/yt-dlp#4673 comments (f.video.weibocdn.com).
// Xiaohongshu: yt_dlp/extractor/xiaohongshu.py's original video URL.
// Vimeo: yt-dlp/yt-dlp#5630 (skyfire.vimeocdn.com, vod-progressive.akamaized.net).
// Kuaishou: K12f/BlueCatKoKo@e4eb414edb9c3c667e4817d3002f72a437078239,
// src/BlueCatKoKo.Ui/Assets/kuaishou-video.json: mainMvUrls v1/v2.kwaicdn.com.
// Do not add generic cloud-storage domains for providers lacking media evidence.
const additionalMediaRoots = {
  kuaishou: ['kwaicdn.com'], weibo: ['video.weibocdn.com'], instagram: ['cdninstagram.com', 'fbcdn.net'],
  facebook: ['fbcdn.net'], pinterest: ['pinimg.com'], vimeo: ['vimeocdn.com'], xiaohongshu: ['xhscdn.com'],
};
// Douyin's official jingxuan page CSP also lists byteimg.com and douyinpic.com.
const thumbnailExact = ['pbs.twimg.com', 'video.twimg.com', 'i.vimeocdn.com'];
const thumbnailRoots = ['ytimg.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'byteoversea.com', 'ibytedtos.com', 'ibyteimg.com', 'byteimg.com', 'douyinpic.com',
  'sinaimg.cn', 'cdninstagram.com', 'fbcdn.net', 'pinimg.com', 'xhscdn.com', 'a.yximgs.com'];

export function thumbnailHostCatalog() {
  return { exact: [...thumbnailExact], roots: [...thumbnailRoots] };
}

export function isAllowedMediaUrl(value, platform = 'twitter') {
  const url = parseSafeHttpUrl(value);
  if (!url || url.protocol !== 'https:') return false;
  const host = url.hostname;
  if (platform === 'twitter') return host === 'video.twimg.com';
  if (platform === 'youtube') return inDomains(host, ['googlevideo.com']);
  if (platform === 'douyin') return inDomains(host, douyinMediaRoots) || host === 'v3-dy-o.zjcdn.com';
  if (platform === 'tiktok') return inDomains(host, tiktokMediaRoots) || /^v\d+-webapp(?:-prime)?\.tiktok\.com$/.test(host);
  if (platform === 'vimeo' && host === 'vod-progressive.akamaized.net') return true;
  return inDomains(host, additionalMediaRoots[platform] || []);
}

export function isAllowedThumbnailUrl(value) {
  const url = parseSafeHttpUrl(value);
  return Boolean(url && url.protocol === 'https:' && (thumbnailExact.includes(url.hostname) || inDomains(url.hostname, thumbnailRoots)));
}
