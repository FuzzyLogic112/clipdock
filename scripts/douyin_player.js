(expectedId) => {
  const page = new URL(location.href);
  const sharePage = ['www.iesdouyin.com', 'iesdouyin.com'].includes(page.hostname)
    && page.pathname.replace(/\/$/, '') === '/share/video/' + expectedId;
  const desktopPage = page.hostname === 'www.douyin.com'
    && page.pathname.replace(/\/$/, '') === '/video/' + expectedId;
  if (!sharePage && !desktopPage) return null;
  const trusted = value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.port && !url.username && !url.password
        && (url.hostname === 'douyinvod.com' || url.hostname.endsWith('.douyinvod.com') || url.hostname === 'v3-dy-o.zjcdn.com') ? url.href : null;
    } catch { return null; }
  };
  // The mobile share page embeds metadata for this exact public video. Reading
  // it does not require loading or playing the video's bytes in Chrome.
  const queue = [{ value:window._ROUTER_DATA?.loaderData, depth:0 }];
  for (let count = 0; queue.length && count < 500; count++) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || depth > 8) continue;
    if (value.video && String(value.aweme_id || value.item_id || value.id || '') === expectedId) {
      const video = value.video;
      const formats = [];
      const add = (address, id, note = '') => {
        for (const [index, raw] of (Array.isArray(address?.url_list) ? address.url_list.slice(0, 8) : []).entries()) {
          const url = trusted(raw);
          if (!url) continue;
          formats.push({ format_id:id + '-' + index, url, ext:'mp4', protocol:'https',
            width:address.width || video.width, height:address.height || video.height,
            filesize:address.data_size, format_note:note, _clipdock_playback_source:true,
            http_headers:{'User-Agent':navigator.userAgent, Referer:page.origin + '/'} });
        }
      };
      add(video.play_addr, 'play_addr');
      add(video.play_addr_h264, 'play_addr_h264');
      for (const [index, variant] of (Array.isArray(video.bit_rate) ? video.bit_rate.slice(0, 20) : []).entries()) {
        add(variant.play_addr, 'playback-' + index, variant.gear_name || '');
      }
      if (formats.length) return { id:expectedId, title:value.desc || '抖音视频', uploader:value.author?.nickname || '',
        thumbnail:video.cover?.url_list?.[0], duration:Number(video.duration || value.duration) / 1000 || null, formats };
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') queue.push({value:child, depth:depth+1});
  }
  if (!desktopPage) return null;
  for (const video of document.querySelectorAll('video')) {
    const urls = [...new Set([video.currentSrc, video.src, ...Array.from(video.querySelectorAll('source')).map(s => s.src)]
      .map(trusted).filter(url => url && new URL(url).searchParams.get('__vid') === expectedId))];
    if (!urls.length) continue;
    const meta = name => document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]')?.content;
    const description = meta('description') || '';
    return { id:expectedId, title:document.title.replace(/\s*-\s*抖音\s*$/, ''),
      uploader:description.match(/ - (.+?)于\d{8}发布/)?.[1] || '',
      thumbnail:meta('lark:url:video_cover_image_url') || meta('og:image'),
      duration:Number.isFinite(video.duration) && video.duration >= 0 ? video.duration : null,
      formats:urls.slice(0, 8).map((url, index) => ({ format_id:'browser-play-' + index, url, ext:'mp4', protocol:'https',
        width:video.videoWidth || null, height:video.videoHeight || null, _clipdock_webpage_original:true,
        http_headers:{'User-Agent':navigator.userAgent, Referer:'https://www.douyin.com/'} })) };
  }
  return null;
}
