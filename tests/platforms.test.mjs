import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVideoUrl, platformForUrl, isAllowedMediaUrl, isAllowedThumbnailUrl, platformCatalog, thumbnailHostCatalog, PLATFORM_LABELS } from '../lib/platforms.mjs';

test('canonicalizes supported video links and one Douyin share-text URL', () => {
  const cases = [
    ['https://youtu.be/jNQXAC9IVRw?si=tracking', 'https://www.youtube.com/watch?v=jNQXAC9IVRw', 'youtube'],
    ['https://m.youtube.com/shorts/jNQXAC9IVRw?feature=share', 'https://www.youtube.com/watch?v=jNQXAC9IVRw', 'youtube'],
    ['https://music.youtube.com/watch?v=jNQXAC9IVRw&list=abc', 'https://www.youtube.com/watch?v=jNQXAC9IVRw', 'youtube'],
    ['2.34 复制打开抖音，看看视频 https://v.douyin.com/AbCd_12/ 10/13', 'https://v.douyin.com/AbCd_12/', 'douyin'],
    ['https://www.iesdouyin.com/share/video/6963263655114722595/?region=CN', 'https://www.douyin.com/video/6963263655114722595', 'douyin'],
    ['https://www.tiktok.com/@example.name/video/7170520270497680683?lang=en', 'https://www.tiktok.com/@example.name/video/7170520270497680683', 'tiktok'],
    ['https://vt.tiktok.com/AbcD123/?test=1', 'https://vt.tiktok.com/AbcD123/', 'tiktok'],
    ['https://www.tiktokv.com/share/video/7668090902816017671/', 'https://www.tiktokv.com/share/video/7668090902816017671/', 'tiktok'],
    ['https://twitter.com/name/status/123#x', 'https://x.com/name/status/123', 'twitter'],
  ];
  for (const [input, canonical, platform] of cases) {
    assert.equal(normalizeVideoUrl(input), canonical);
    assert.equal(platformForUrl(input), platform);
  }
});

test('rejects unsupported pages, playlists, malformed IDs and authority confusion', () => {
  for (const input of [null, {}, 'https://www.youtube.com/playlist?list=123', 'https://youtube.com/live/jNQXAC9IVRw',
    'https://youtube.com/watch?v=short', 'https://youtube.com/watch?v=jNQXAC9IVRw&v=bbbbbbbbbbb',
    'https://youtube.com/@name', 'https://www.tiktok.com/@person', 'https://www.tiktok.com/@person/live',
    'https://douyin.com/user/123', 'https://live.douyin.com/123', 'https://youtube.com:443/watch?v=jNQXAC9IVRw',
    'https://name@youtube.com/watch?v=jNQXAC9IVRw', 'https://youtube.com.evil.test/watch?v=jNQXAC9IVRw',
    'https://youtube.com\\@evil.test/watch?v=jNQXAC9IVRw', 'http://127.0.0.1/video/123',
    '分享 https://v.douyin.com/Abc123/ https://v.douyin.com/Def456/']) {
    assert.throws(() => normalizeVideoUrl(input), { code: 'INVALID_URL', status: 400 }, String(input));
  }
});

test('media allowlists are platform-specific and enforce HTTPS and host boundaries', () => {
  assert.equal(isAllowedMediaUrl('https://rr1---sn-test.googlevideo.com/videoplayback?id=123', 'youtube'), true);
  assert.equal(isAllowedMediaUrl('https://v19.tiktokcdn.com/video/test', 'tiktok'), true);
  assert.equal(isAllowedMediaUrl('https://v26-web.douyinvod.com/video/test', 'douyin'), true);
  assert.equal(isAllowedMediaUrl('https://v19-webapp-prime.tiktok.com/video/test', 'tiktok'), true);
  for (const url of ['http://rr1.googlevideo.com/videoplayback', 'https://rr1.googlevideo.com:443/videoplayback',
    'https://user@rr1.googlevideo.com/videoplayback', 'https://rr1.googlevideo.com.evil.test/a',
    'https://127.0.0.1/a', 'http://169.254.169.254/latest', 'file:///secret', 'https://[::1]/a',
    'https://rr1.googlevideo.com./a', 'https://evil.test/a']) assert.equal(isAllowedMediaUrl(url, 'youtube'), false, url);
  assert.equal(isAllowedMediaUrl('https://rr1.googlevideo.com/videoplayback', 'twitter'), false);
  assert.equal(isAllowedMediaUrl('https://video.twimg.com/a.mp4', 'unknown'), false);
  assert.equal(isAllowedMediaUrl(null, 'douyin'), false);
});

test('thumbnail rules reject null, unsafe schemes and malicious suffix hosts', () => {
  assert.equal(isAllowedThumbnailUrl('https://i.ytimg.com/vi/example/default.jpg'), true);
  assert.equal(isAllowedThumbnailUrl('https://p16.tiktokcdn.com/cover.webp'), true);
  for (const url of [null, undefined, 'data:image/png;base64,foo', 'http://i.ytimg.com/a.jpg',
    'https://i.ytimg.com.evil.test/a.jpg', 'https://user@pbs.twimg.com/a.jpg', 'https://127.0.0.1/a.jpg']) {
    assert.equal(isAllowedThumbnailUrl(url), false);
  }
});

test('canonicalizes seven additional platforms and preserves only required access parameters', () => {
  const cases = [
    ['https://www.kuaishou.com/short-video/3xn9abc123?shareToken=tracking', 'https://www.kuaishou.com/short-video/3xn9abc123', 'kuaishou'],
    ['https://v.kuaishou.com/AbC123/?foo=bar', 'https://v.kuaishou.com/AbC123', 'kuaishou'],
    ['https://www.weibo.com/7827771738/N4xlMvjhI?from=feed', 'https://weibo.com/7827771738/N4xlMvjhI', 'weibo'],
    ['https://m.weibo.cn/detail/4189191225395228', 'https://m.weibo.cn/status/4189191225395228', 'weibo'],
    ['https://video.weibo.com/show?fid=1034:4967272104787984', 'https://weibo.com/tv/show/1034:4967272104787984', 'weibo'],
    ['https://t.cn/AbCd123', 'https://t.cn/AbCd123', 'weibo'],
    ['https://instagram.com/example.name/reels/Chunk8-jurw/?igsh=tracking', 'https://www.instagram.com/reel/Chunk8-jurw/', 'instagram'],
    ['https://www.instagram.com/p/BQ0eAlwhDrw/', 'https://www.instagram.com/p/BQ0eAlwhDrw/', 'instagram'],
    ['https://m.facebook.com/example/videos/637842556329505/?fref=nf', 'https://www.facebook.com/watch/?v=637842556329505', 'facebook'],
    ['https://www.facebook.com/video.php?v=637842556329505', 'https://www.facebook.com/watch/?v=637842556329505', 'facebook'],
    ['https://www.facebook.com/reel/1195289147628387/', 'https://www.facebook.com/reel/1195289147628387', 'facebook'],
    ['https://www.facebook.com/share/r/AbCd123/?mibextid=tracking', 'https://www.facebook.com/share/r/AbCd123/', 'facebook'],
    ['https://fb.watch/AbCd123/', 'https://fb.watch/AbCd123/', 'facebook'],
    ['https://www.pinterest.ca/pin/example-title--441282463481903715/', 'https://www.pinterest.com/pin/441282463481903715/', 'pinterest'],
    ['https://co.pinterest.com/pin/824721750502199491/', 'https://www.pinterest.com/pin/824721750502199491/', 'pinterest'],
    ['https://pin.it/AbCd123', 'https://pin.it/AbCd123', 'pinterest'],
    ['https://www.vimeo.com/76979871?autoplay=1', 'https://vimeo.com/76979871', 'vimeo'],
    ['https://player.vimeo.com/video/76979871?h=abc123def4&autoplay=1', 'https://player.vimeo.com/video/76979871?h=abc123def4', 'vimeo'],
    ['https://vimeo.com/76979871/abc123def4', 'https://vimeo.com/76979871/abc123def4', 'vimeo'],
    ['https://www.xiaohongshu.com/discovery/item/6411CF99000000001300B6D9?xsec_token=fixture%3D&xsec_source=pc_share&tracking=1', 'https://www.xiaohongshu.com/explore/6411cf99000000001300b6d9?xsec_token=fixture%3D&xsec_source=pc_share', 'xiaohongshu'],
    ['https://xhslink.com/a/AbCd123?x=1', 'https://xhslink.com/a/AbCd123', 'xiaohongshu'],
  ];
  for (const [input, canonical, platform] of cases) {
    assert.equal(normalizeVideoUrl(input), canonical, input);
    assert.equal(normalizeVideoUrl(canonical), canonical, 'canonical URL must be idempotent');
    assert.equal(platformForUrl(input), platform);
    assert.equal(normalizeVideoUrl(`分享这个视频：“${input}” 复制打开`), canonical);
  }
});

test('new platform URLs reject profile, playlist, live, malformed and ambiguous inputs', () => {
  for (const input of [
    'https://www.kuaishou.com/profile/example', 'https://live.kuaishou.com/u/example', 'https://www.kuaishou.com/short-video/a',
    'https://weibo.com/u/123456', 'https://video.weibo.com/show?fid=bad', 'https://video.weibo.com/show?fid=1034:4967272104787984&fid=1034:4967272104787985',
    'https://instagram.com/example', 'https://instagram.com/reels/audio/12345', 'https://instagram.com/stories/example/12345',
    'https://facebook.com/example', 'https://facebook.com/watch/', 'https://facebook.com/watch/live/?v=12345', 'https://facebook.com/watch?v=12345&v=12346',
    'https://facebook.com/groups/example/videos/', 'https://facebook.com/share/p/AbCd123/',
    'https://pinterest.com/example/board/', 'https://pinterest.com/pin/not-a-number', 'https://pinterest.com.evil.test/pin/12345',
    'https://vimeo.com/showcase/12345', 'https://vimeo.com/channels/staffpicks', 'https://vimeo.com/event/12345', 'https://player.vimeo.com/video/12345?h=a&h=b',
    'https://xiaohongshu.com/user/profile/6411cf99000000001300b6d9', 'https://xiaohongshu.com/explore/not-a-note',
    'https://xiaohongshu.com/explore/6411cf99000000001300b6d9?xsec_token=one&xsec_token=two',
    'https://www.instagram.com:443/reel/Chunk8-jurw/', 'https://127.0.0.1/short-video/abcdef',
    'https://user@www.facebook.com/reel/1195289147628387', 'https://pin.it\\@evil.test/AbCd123',
    '分享 https://pin.it/AbCd123 https://vimeo.com/76979871', 'x'.repeat(4097),
  ]) assert.throws(() => normalizeVideoUrl(input), { code: 'INVALID_URL', status: 400 }, input);
});

test('additional platform media and image rules remain bounded to evidence-backed CDN roots', () => {
  for (const [platform, url] of [
    ['kuaishou', 'https://v2.kwaicdn.com/video/example.mp4'],
    ['weibo', 'https://f.video.weibocdn.com/video/example.mp4'],
    ['instagram', 'https://scontent-itm1-1.cdninstagram.com/video/example.mp4'],
    ['facebook', 'https://video.fdac127-1.fna.fbcdn.net/video/example.mp4'],
    ['pinterest', 'https://v1.pinimg.com/videos/example.mp4'],
    ['xiaohongshu', 'https://sns-video-bd.xhscdn.com/example.mp4'],
    ['vimeo', 'https://skyfire.vimeocdn.com/video/example.mp4'],
    ['vimeo', 'https://vod-progressive.akamaized.net/video/example.mp4'],
  ]) {
    assert.equal(isAllowedMediaUrl(url, platform), true);
    const parsed = new URL(url);
    for (const bad of [url.replace('https:', 'http:'), `https://${parsed.host}:443${parsed.pathname}`,
      `https://user@${parsed.host}${parsed.pathname}`, `https://${parsed.host}.evil.test${parsed.pathname}`,
      'https://127.0.0.1/a.mp4', 'https://[::1]/a.mp4', 'https://169.254.169.254/a.mp4',
      'https://arbitrary-cloud-storage.example/a.mp4']) assert.equal(isAllowedMediaUrl(bad, platform), false, bad);
  }
  assert.equal(isAllowedMediaUrl('https://v1.pinimg.com/video.mp4', 'instagram'), false);
  assert.equal(isAllowedMediaUrl('https://cdninstagram.com/video.mp4', 'facebook'), false);
  assert.equal(isAllowedMediaUrl('https://unrelated.akamaized.net/video.mp4', 'vimeo'), false);
  assert.equal(isAllowedMediaUrl('https://evil.vod-progressive.akamaized.net/video.mp4', 'vimeo'), false);
  for (const url of ['https://wx1.sinaimg.cn/large/cover.jpg', 'https://i.vimeocdn.com/video/12345',
    'https://i.pinimg.com/cover.jpg', 'https://sns-webpic-qc.xhscdn.com/cover.jpg', 'https://p2.a.yximgs.com/cover.jpg']) assert.equal(isAllowedThumbnailUrl(url), true);
  assert.equal(isAllowedThumbnailUrl('https://i.vimeocdn.com.evil.test/cover.jpg'), false);
});

test('platform and image catalogs expose independent copies of the validation policy', () => {
  const catalog = platformCatalog();
  assert.equal(catalog.length, 11);
  assert.deepEqual(catalog.map(item => item.id), Object.keys(PLATFORM_LABELS));
  for (const item of catalog) {
    assert.equal(item.label, PLATFORM_LABELS[item.id]);
    assert.ok(item.inputHosts.length > 0);
  }
  catalog[0].inputHosts.push('evil.test');
  assert.equal(platformCatalog()[0].inputHosts.includes('evil.test'), false);
  const thumbnails = thumbnailHostCatalog();
  thumbnails.exact.push('evil.test'); thumbnails.roots.push('evil.test');
  assert.equal(isAllowedThumbnailUrl('https://evil.test/a.jpg'), false);
  assert.equal(thumbnailHostCatalog().roots.includes('evil.test'), false);
});
