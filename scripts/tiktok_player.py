"""Read TikTok's public hydration data without evaluating scripts or exporting cookies."""

PLAYER_DATA = r"""(expectedId) => {
  if (location.hostname !== 'www.tiktok.com' || typeof expectedId !== 'string' || !/^\d{1,30}$/.test(expectedId)) return null;
  const element = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
  const source = element?.textContent;
  if (!source || source.length > 8 * 1024 * 1024) return null;
  let detail;
  try { detail = JSON.parse(source)?.__DEFAULT_SCOPE__?.['webapp.video-detail']; }
  catch { return null; }
  const item = detail?.itemInfo?.itemStruct;
  if (!item || item.id !== expectedId || (detail.statusCode !== undefined && detail.statusCode !== 0)
      || item.privateItem === true || item.secret === true || item.forFriend === true || item.isProhibited === true) return null;
  const video = item.video;
  if (!video || typeof video !== 'object') return null;
  const number = value => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const trusted = value => {
    if (typeof value !== 'string' || value.length > 16384 || /[\s\\]/.test(value)) return null;
    const authority = value.match(/^https:\/\/([^/?#]+)/i)?.[1];
    if (!authority || /[:@]/.test(authority)) return null;
    try {
      const url = new URL(value);
      const roots = ['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'tiktokv.com', 'byteoversea.com', 'ibytedtos.com'];
      return url.protocol === 'https:' && !url.username && !url.password && !url.port
        && (roots.some(root => url.hostname === root || url.hostname.endsWith('.' + root))
          || /^v\d+-webapp(?:-prime)?\.tiktok\.com$/.test(url.hostname)) ? url.href : null;
    } catch { return null; }
  };
  const formats = [];
  const urls = new Set();
  const ids = new Map();
  function addPlayback(rawUrls, stream, baseId, fallback = {}) {
    const codec = stream.CodecType || stream.codecType || fallback.codecType;
    if (typeof codec === 'string' && /bytevc2|UNPLAYABLE/i.test(codec)) return;
    const container = stream.Format || stream.format || fallback.format;
    if (container && String(container).toLowerCase() !== 'mp4') return;
    const address = stream.PlayAddr || stream.PlayAddrStruct || stream;
    for (const raw of rawUrls.slice(0, 8)) {
      const url = trusted(raw);
      if (!url || urls.has(url) || formats.length >= 64) continue;
      const base = String(baseId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 70) || 'play';
      const suffix = ids.get(base) || 0;
      ids.set(base, suffix + 1);
      const format = {
        format_id: base + (suffix ? '-' + suffix : ''), url, ext: 'mp4', protocol: 'https',
        width: number(address.Width ?? stream.width ?? fallback.width),
        height: number(address.Height ?? stream.height ?? fallback.height),
        filesize: number(address.DataSize ?? stream.size ?? fallback.size),
        tbr: number(stream.Bitrate ?? stream.bitrate ?? fallback.bitrate) === null
          ? null : number(stream.Bitrate ?? stream.bitrate ?? fallback.bitrate) / 1000,
        _clipdock_playback_source: true, format_note: 'Playback video',
        http_headers: { 'User-Agent': navigator.userAgent, Referer: 'https://www.tiktok.com/' },
      };
      if (typeof codec === 'string' && codec.length <= 80) format.vcodec = codec;
      const audioCodec = stream.AudioCodecType || stream.audioCodecType || fallback.audioCodecType;
      if (typeof audioCodec === 'string' && /^(?:aac|mp4a(?:\.[a-z0-9.]+)?)$/i.test(audioCodec)) format.acodec = audioCodec;
      urls.add(url); formats.push(format);
    }
  }
  const primary = video.PlayAddrStruct && typeof video.PlayAddrStruct === 'object' ? video.PlayAddrStruct : {};
  addPlayback([video.playAddr, ...(Array.isArray(primary.UrlList) ? primary.UrlList : [])], { ...video, PlayAddrStruct: primary }, 'play', video);
  for (const [index, variant] of (Array.isArray(video.bitrateInfo) ? video.bitrateInfo.slice(0, 40) : []).entries()) {
    if (!variant || typeof variant !== 'object') continue;
    const address = variant.PlayAddr || variant.PlayAddrStruct;
    if (!address || typeof address !== 'object') continue;
    addPlayback(Array.isArray(address.UrlList) ? address.UrlList : [], variant, 'play-' + (variant.GearName || index), {});
  }
  if (!formats.length) return null;
  return {
    id: item.id,
    title: typeof item.desc === 'string' ? item.desc : '',
    uploader: typeof item.author?.nickname === 'string' ? item.author.nickname : '',
    duration: number(video.duration),
    thumbnail: typeof video.cover === 'string' ? video.cover : typeof video.originCover === 'string' ? video.originCover : null,
    formats,
  };
}"""
