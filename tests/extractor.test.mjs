import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTweetUrl, normalizeMetadata, normalizeExtractorResult, metadataFromDouyinShareHtml, renderPublicVideo } from '../lib/extractor.mjs';

test('normalizes trusted X/Twitter status URLs without tracking data', () => {
  assert.equal(normalizeTweetUrl(' https://www.twitter.com/example_1/status/12345?s=20#fragment '), 'https://x.com/example_1/status/12345');
  assert.equal(normalizeTweetUrl('http://mobile.x.com/i/web/status/12345/'), 'https://x.com/i/status/12345');
  assert.equal(normalizeTweetUrl('https://m.twitter.com/i/status/12345'), 'https://x.com/i/status/12345');
});

test('rejects URL authority confusion, ports, non-status paths, and malformed ids', () => {
  const bad = [null, {}, '', 'x.com/a/status/12', 'ftp://x.com/a/status/12',
    'https://x.com.evil.test/a/status/12', 'https://evil.test/x.com/a/status/12',
    'https://x.com@evil.test/a/status/12', 'https://user@x.com/a/status/12',
    'https://x.com:443/a/status/12', 'http://x.com:80/a/status/12',
    'https://api.x.com/a/status/12', 'https://x.com\\@evil.test/a/status/12',
    'https://x.com/a/status/not-a-number', 'https://x.com/a/status/12/more',
    'https://x.com/a', 'https://x.com/a/status/1%32', 'https://x.com/a/status/12\nmore'];
  for (const url of bad) assert.throws(() => normalizeTweetUrl(url), { code: 'INVALID_URL', status: 400 }, String(url));
});

const mp4 = (format_id, height, extras = {}) => ({
  format_id, height, width: height * 16 / 9, ext: 'mp4', protocol: 'https',
  url: `https://video.twimg.com/ext_tw_video/example/vid/${format_id}.mp4?tag=12`, ...extras,
});

test('keeps multiple videos, sorts quality, deduplicates quality and ids, prefers HTTPS', () => {
  const metadata = normalizeMetadata({
    title: 'Two videos', uploader: 'Example', entries: [
      { id: '111-0', title: 'First video', duration: 12, thumbnail: 'https://pbs.twimg.com/thumb.jpg', formats: [
        mp4('low', 360), mp4('high-insecure', 720, { url: 'http://video.twimg.com/high.mp4', protocol: 'http', tbr: 5000 }),
        mp4('high', 720, { tbr: 1500 }), mp4('high-duplicate', 720, { tbr: 1000 }),
        mp4('low', 240),
      ] },
      { id: '111-1', title: 'Second video', formats: [mp4('720p', 720, { acodec: 'none', filesize: 1234 })] },
      { id: '111-1', formats: [mp4('duplicate-video', 1080)] },
    ],
  });
  assert.equal(metadata.author, 'Example');
  assert.equal(metadata.videos.length, 2);
  assert.deepEqual(metadata.videos[0].formats.map((f) => [f.id, f.height]), [['high', 720], ['low', 360]]);
  assert.equal(metadata.videos[1].formats[0].hasAudio, false);
  assert.equal(metadata.videos[1].formats[0].filesize, 1234);
  assert.equal(metadata.thumbnail, 'https://pbs.twimg.com/thumb.jpg');
  assert.equal(metadata.duration, null);
});

test('only exposes direct Twitter MP4 URLs and trusted thumbnails', () => {
  const result = normalizeMetadata({ id: '1', thumbnail: 'https://evil.test/private', formats: [
    mp4('valid', 720), mp4('hls', 1080, { protocol: 'm3u8_native' }),
    mp4('remote', 1080, { url: 'https://evil.test/a.mp4' }),
    mp4('trick', 1080, { url: 'https://video.twimg.com.evil.test/a.mp4' }),
    mp4('credentials', 1080, { url: 'https://name@video.twimg.com/a.mp4' }),
    mp4('port', 1080, { url: 'https://video.twimg.com:443/a.mp4' }),
    mp4('playlist', 1080, { url: 'https://video.twimg.com/a.m3u8' }),
    mp4('file', 1080, { url: 'file:///secret.mp4' }),
    mp4('audio', 1080, { vcodec: 'none' }),
  ] });
  assert.equal(result.videos[0].formats.length, 1);
  assert.equal(result.videos[0].formats[0].id, 'valid');
  assert.equal(result.thumbnail, null);
});

test('caps multi-video results at eight entries and handles singleton metadata', () => {
  assert.equal(normalizeMetadata({ entries: Array.from({ length: 12 }, (_, i) => ({ id: `v-${i}`, formats: [mp4('720p', 720)] })) }).videos.length, 8);
  const single = normalizeMetadata({ id: 'single', duration: 4.2, url: 'https://video.twimg.com/a.mp4', ext: 'mp4' });
  assert.equal(single.duration, 4.2);
  assert.equal(single.videos[0].formats[0].label, '原始画质');
});

test('returns a specific no-media error for empty or unsuitable video metadata', () => {
  for (const metadata of [{}, { entries: [] }, { entries: [null] }, { formats: [mp4('bad', 720, { url: 'http://127.0.0.1/a.mp4' })] }]) {
    assert.throws(() => normalizeMetadata(metadata), { code: 'NO_MEDIA', status: 422 });
  }
  assert.throws(() => normalizeMetadata(null), { code: 'PARSE_FAILED' });
});

test('YouTube video-only MP4 pairs with trusted M4A and strips unsafe request headers', () => {
  const base = { protocol: 'https', url: 'https://rr1.googlevideo.com/videoplayback?id=video', ext: 'mp4', width: 1920, height: 1080, acodec: 'none', vcodec: 'avc1.640028' };
  const result = normalizeMetadata({ id: 'youtube-id', http_headers: { Cookie: 'secret', Authorization: 'secret', 'User-Agent': 'safe-agent', Referer: 'https://www.youtube.com/' }, formats: [
    { ...base, format_id: '137', filesize: 1000 },
    { ...base, format_id: 'unsafe-video', height: 2160, url: 'https://evil.test/video.mp4' },
    { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', protocol: 'https', abr: 128, filesize: 100, url: 'https://rr1.googlevideo.com/videoplayback?id=audio', http_headers: { 'User-Agent': 'audio-agent', 'X-Secret': 'secret' } },
    { format_id: 'unsafe-audio', ext: 'm4a', vcodec: 'none', acodec: 'aac', abr: 9999, url: 'https://evil.test/audio.m4a' },
  ] }, 'youtube');
  const format = result.videos[0].formats[0];
  assert.equal(result.platformLabel, 'YouTube');
  assert.equal(format.requiresMerge, true);
  assert.equal(format.audioExt, 'm4a');
  assert.equal(format.audioUrl, 'https://rr1.googlevideo.com/videoplayback?id=audio');
  assert.equal(format.filesize, 1100);
  assert.equal(format.filesizeApprox, true);
  assert.equal(format.watermark, 'source');
  assert.deepEqual(format.headers, { 'User-Agent': 'safe-agent', Referer: 'https://www.youtube.com/' });
  assert.deepEqual(format.audioHeaders, { 'User-Agent': 'audio-agent', Referer: 'https://www.youtube.com/' });
  assert.throws(() => normalizeMetadata({ formats: [{ ...base, format_id: 'no-audio' }] }, 'youtube'), { code: 'NO_MEDIA' });
});

test('successful yt-dlp exit without formats preserves YouTube bot and dependency failures', () => {
  const empty = { code: 0, stdout: JSON.stringify({ id: 'video', formats: [] }) };
  for (const [stderr, code, status] of [
    ["WARNING: Sign in to confirm you’re not a bot. Use --cookies-from-browser", 'PLATFORM_BLOCKED', 422],
    ['WARNING: No supported JavaScript runtime could be found. Only images are available', 'EXTRACTOR_SETUP', 503],
    ['WARNING: Signature solving failed: Some formats may be missing', 'EXTRACTOR_SETUP', 503],
    ['WARNING: web client https formats require a GVS PO Token which was not provided', 'PLATFORM_BLOCKED', 422],
    ['WARNING: The current session has been rate-limited by YouTube', 'RATE_LIMITED', 429],
  ]) assert.throws(() => normalizeExtractorResult({ ...empty, stderr }, 'youtube'), { code, status });
  assert.throws(() => normalizeExtractorResult({ code: 1, stdout: '', stderr: 'ERROR: Sign in to confirm you\'re not a bot' }, 'youtube'), { code: 'PLATFORM_BLOCKED' });
});

test('warnings about skipped clients do not discard working YouTube formats', () => {
  const result = normalizeExtractorResult({ code: 0, stderr: 'WARNING: Some formats require a GVS PO Token which was not provided', stdout: JSON.stringify({
    id: 'video', formats: [{ format_id: '18', ext: 'mp4', protocol: 'https', vcodec: 'h264', acodec: 'aac', url: 'https://rr1.googlevideo.com/videoplayback?id=video' }],
  }) }, 'youtube');
  assert.equal(result.videos[0].formats[0].id, '18');
});

test('failed extractor diagnostics report protocols without leaking URLs, titles, or raw warnings', () => {
  let failure;
  try {
    normalizeExtractorResult({ code: 0, stderr: 'WARNING: Only images are available; confidential-warning-secret', stdout: JSON.stringify({
      title: 'private-title-secret', http_headers: { Cookie: 'private-cookie-secret' }, formats: [
        { protocol: 'm3u8_native', vcodec: 'avc1.42', ext: 'mp4', url: 'https://manifest.googlevideo.com/api/manifest.m3u8?token=private-url-secret' },
        { protocol: 'mhtml', vcodec: 'none', url: 'https://private-host-secret.example/storyboard' },
        { protocol: 'https', vcodec: 'av01.00', ext: 'mp4', has_drm: true, url: 'https://rr1.googlevideo.com/videoplayback?token=private-url-secret' },
      ],
    }) }, 'youtube');
  } catch (error) { failure = error; }
  assert.equal(failure.code, 'NO_MEDIA');
  assert.equal(failure.diagnostics.totalFormats, 3);
  assert.deepEqual(failure.diagnostics.protocols, { m3u8_native: 1, mhtml: 1, https: 1 });
  assert.deepEqual(failure.diagnostics.videoCodecs, { h264: 1, none: 1, av1: 1 });
  assert.equal(failure.diagnostics.drmFormats, 1);
  assert.deepEqual(failure.diagnostics.clues, ['only_images']);
  assert.equal(failure.diagnostics.domains['manifest.googlevideo.com'], 1);
  assert.equal(failure.diagnostics.domains.untrusted_or_missing, 1);
  assert.doesNotMatch(JSON.stringify(failure.diagnostics), /private-|confidential-|https:|token=|Cookie/);
});

test('TikTok chooses evidence-backed playback over watermarked download at equal quality', () => {
  const base = { protocol: 'https', ext: 'mp4', width: 720, height: 1280, vcodec: 'h264', acodec: 'aac' };
  const result = normalizeMetadata({ formats: [
    { ...base, format_id: 'download', format_note: 'watermarked', tbr: 5000, url: 'https://v19.tiktokcdn.com/download' },
    { ...base, format_id: 'play', tbr: 1000, url: 'https://v19.tiktokcdn.com/play' },
    { ...base, height: 1920, format_id: 'unidentified', url: 'https://v19.tiktokcdn.com/unknown' },
    { ...base, height: 360, format_id: 'download-2', format_note: 'watermarked', url: 'https://v19.tiktokcdn.com/download-low' },
  ] }, 'tiktok');
  assert.deepEqual(result.videos[0].formats.map(({ id, watermark }) => [id, watermark]), [['play', 'none'], ['unidentified', 'unknown'], ['download-2', 'present']]);
  assert.equal(normalizeMetadata({ formats: [mp4('source', 720)] }).videos[0].formats[0].watermark, 'source');
});

test('Douyin fallback uses exact embedded playback URLs, selects requested id and rejects page shells', () => {
  const item = { aweme_id: '12345', desc: 'Example video', author: { nickname: 'Example' }, video: {
    width: 720, height: 1280, duration: 15000, has_watermark: true,
    play_addr: { url_list: ['https://v26-web.douyinvod.com/original?token=preserve'], data_size: 1000 },
    download_addr: { url_list: ['https://v26-web.douyinvod.com/playwm?token=preserve'], data_size: 2000 },
  } };
  const html = '<script>window._ROUTER_DATA = ' + JSON.stringify({ loaderData: { page: { videoInfoRes: { item_list: [item] } } } }) + '</script>';
  const result = normalizeMetadata(metadataFromDouyinShareHtml(html, '12345'), 'douyin');
  const selected = result.videos[0].formats[0];
  assert.equal(result.duration, 15);
  assert.equal(selected.url, 'https://v26-web.douyinvod.com/original?token=preserve');
  assert.equal(selected.watermark, 'none');
  assert.throws(() => metadataFromDouyinShareHtml(html, '99999'), { code: 'COOKIE_REQUIRED' });
  assert.throws(() => metadataFromDouyinShareHtml('<script>window._ROUTER_DATA = {"loaderData":{"page":{"abParams":{}}}}</script>', '12345'), { code: 'COOKIE_REQUIRED' });
});

test('live or unsupported codec metadata does not masquerade as a downloadable MP4', () => {
  assert.throws(() => normalizeMetadata({ is_live: true, formats: [mp4('live', 720)] }), { code: 'UNSUPPORTED_MEDIA' });
  assert.throws(() => normalizeMetadata({ formats: [{ ...mp4('bad', 720), vcodec: 'bytevc2' }] }), { code: 'NO_MEDIA' });
});

test('rendered player sources remain original webpage footage, never a no-watermark claim', () => {
  const result = normalizeMetadata({ id: '123', formats: [{ format_id: 'browser-play-0', ext: 'mp4', protocol: 'https',
    url: 'https://v26-web.douyinvod.com/video?__vid=123', _clipdock_webpage_original: true }] }, 'douyin');
  assert.equal(result.videos[0].formats[0].watermark, 'source');
  assert.equal(result.videos[0].formats[0].watermarkLabel, '网页原始画面');
});

test('portrait quality uses the short edge and trusted TikTok web playback IDs retain watermark evidence', () => {
  const formats = [
    { format_id: 'bytevc1_1080p_1593578-0', width: 1080, height: 1920, vcodec: 'h265', quality: 3, preference: -1, url: 'https://v16-webapp-prime.tiktok.com/video/high' },
    { format_id: 'bytevc1_720p_974500-0', width: 720, height: 1280, vcodec: 'h265', quality: 2, preference: -1, url: 'https://v16-webapp-prime.tiktok.com/video/medium' },
    { format_id: 'h264_540p_1487714-0', width: 576, height: 1024, vcodec: 'h264', quality: 1, preference: -1, url: 'https://v16-webapp-prime.tiktok.com/video/low' },
  ].map(format => ({ ...format, ext: 'mp4', protocol: 'https', acodec: 'aac' }));
  const trusted = normalizeMetadata({ extractor_key: 'TikTok', formats }, 'tiktok');
  assert.deepEqual(trusted.videos[0].formats.map(format => [format.label, format.watermark]), [['1080p', 'none'], ['720p', 'none'], ['576p', 'none']]);
  assert.equal(normalizeMetadata({ formats: [formats[0]] }, 'tiktok').videos[0].formats[0].watermark, 'unknown');
  assert.equal(normalizeMetadata({ extractor_key: 'TikTok', formats: [{ ...formats[0], format_note: 'Download video' }] }, 'tiktok').videos[0].formats[0].watermark, 'unknown');
  assert.equal(normalizeMetadata({ extractor_key: 'TikTok', formats: [{ ...formats[0], format_note: 'Download video, watermarked' }] }, 'tiktok').videos[0].formats[0].watermark, 'present');
});

test('browser renderer rejects unsupported targets before spawning and honors prior cancellation', async () => {
  await assert.rejects(renderPublicVideo('https://www.youtube.com/watch?v=jNQXAC9IVRw'), { code: 'INVALID_URL' });
  await assert.rejects(renderPublicVideo('https://www.douyin.com/video/123', { signal: AbortSignal.abort() }), { code: 'REQUEST_ABORTED' });
});

test('browser renderer rejects insufficient container memory before launching Python', async () => {
  await assert.rejects(renderPublicVideo('https://www.douyin.com/video/123', {
    readMemory: async () => ({ limitBytes: 512 * 1024 * 1024, usageBytes: 400 * 1024 * 1024 }),
  }), { code: 'BROWSER_RESOURCE_LIMIT', status: 503 });
});

test('missing browser Python returns an actionable setup error without fetching a page', async () => {
  const original = process.env.SCRAPLING_PYTHON;
  process.env.SCRAPLING_PYTHON = process.platform === 'win32' ? 'C:/clipdock-definitely-missing/python.exe' : '/clipdock-definitely-missing/python';
  try {
    await assert.rejects(renderPublicVideo('https://www.douyin.com/video/123', { readMemory: async () => null }), { code: 'BROWSER_MISSING', status: 503 });
  } finally {
    if (original === undefined) delete process.env.SCRAPLING_PYTHON; else process.env.SCRAPLING_PYTHON = original;
  }
});
