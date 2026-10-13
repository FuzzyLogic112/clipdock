import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt, privateEncrypt } from 'node:crypto';
import { encodeGreenVideoRequest, extractGreenVideo, normalizeGreenVideoResponse } from '../lib/greenvideo.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const aesKey = Buffer.from('0123456789abcdef');
const keys = {
  k1: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  k2: privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, aesKey).toString('base64'),
};
const url = 'https://www.tiktok.com/@kittenlovesyou/video/7403699928150674706';
const media = 'https://v16-webapp-prime.tiktok.com/video/test?signature=example';
const resultData = () => ({ host: 'tiktok', vid: '7403699928150674706', displayTitle: '公开测试', videoItemVoList: [
  { quality: 'video', qualityAlias: '视频 720p', baseUrl: media, canDirectDownload: true },
  { quality: 'audio', qualityAlias: '音频', baseUrl: media },
  { quality: 'cover', qualityAlias: '图片', baseUrl: 'https://p16.tiktokcdn.com/cover.jpg' },
] });
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

function decodeRequest(body) {
  const encrypted = Buffer.from(body, 'base64');
  const chunks = [];
  assert.equal(encrypted.length % 256, 0);
  for (let offset = 0; offset < encrypted.length; offset += 256) {
    const padded = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, encrypted.subarray(offset, offset + 256));
    assert.equal(padded[0], 0);
    assert.equal(padded[1], 2);
    const endPadding = padded.indexOf(0, 2);
    assert.ok(endPadding >= 10);
    const chunk = padded.subarray(endPadding + 1);
    assert.ok(chunk.length <= (encrypted.length === 256 ? 245 : 117), 'matches the frontend short/long envelope branches');
    chunks.push(chunk);
  }
  const decipher = createDecipheriv('aes-128-cbc', aesKey, Buffer.from('a2Vkb3VAODk4OSE2MzIzMw==', 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(Buffer.concat(chunks).toString('ascii'), 'base64')), decipher.final()]).toString('utf8'));
}

test('public protocol envelope preserves UTF-8 JSON and uses 117-character RSA blocks', () => {
  assert.equal(Buffer.from(encodeGreenVideoRequest({ url }, keys), 'base64').length, 256);
  const payload = { url, note: '中文字和 emoji 🎬'.repeat(20) };
  const encrypted = encodeGreenVideoRequest(payload, keys);
  assert.deepEqual(decodeRequest(encrypted), payload);
  assert.throws(() => encodeGreenVideoRequest(payload, { k1: 'bad', k2: 'bad' }), { code: 'PROVIDER_PROTOCOL_CHANGED' });
});

test('anonymous provider sends only the canonical URL and public protocol headers', async () => {
  const calls = [];
  const metadata = await extractGreenVideo(`${url}?tracking=secret`, {
    fetchImpl: async (target, options) => {
      calls.push({ target, options });
      if (target.endsWith('/auth/keys')) return response({ code: 200, data: keys });
      assert.deepEqual(decodeRequest(options.body), { url });
      return response({ code: 200, data: resultData() });
    },
  });
  assert.equal(calls.length, 2);
  for (const { target, options } of calls) {
    assert.equal(new URL(target).origin, 'https://greenvideo.cc');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.KdSystem, 'GreenVideo');
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Authorization, undefined);
  }
  assert.equal(metadata.title, '公开测试');
  assert.equal(metadata.sourceProvider, 'greenvideo');
  assert.equal(metadata.formats.length, 1);
  assert.equal(metadata.formats[0].height, 720);
  assert.equal(metadata.thumbnail, 'https://p16.tiktokcdn.com/cover.jpg');
  assert.equal(metadata.formats[0]._clipdock_playback_source, undefined);
});

test('rejects paused platforms and platform confusion before any request', async () => {
  const fetchImpl = () => { throw new Error('must not fetch'); };
  await assert.rejects(extractGreenVideo('https://youtu.be/jNQXAC9IVRw', { fetchImpl }), { code: 'PROVIDER_PLATFORM_PAUSED' });
  await assert.rejects(extractGreenVideo('https://www.douyin.com/video/7693299883440684131', { fetchImpl }), { code: 'PROVIDER_PLATFORM_PAUSED' });
  await assert.rejects(extractGreenVideo(url, { platform: 'twitter', fetchImpl }), { code: 'INVALID_URL' });
});

test('does not bypass captcha, login or payment responses and refreshes expired keys only once', async () => {
  for (const [code, expected] of [[4291, 'CAPTCHA_REQUIRED'], [429, 'RATE_LIMITED'], [403, 'PROVIDER_ACCESS_REQUIRED'], [402, 'PROVIDER_PAYMENT_REQUIRED'], [555, 'NO_MEDIA']]) {
    let calls = 0;
    await assert.rejects(extractGreenVideo(url, { fetchImpl: async target => {
      calls++;
      return response(target.endsWith('/auth/keys') ? { code: 200, data: keys } : { code });
    } }), { code: expected });
    assert.equal(calls, 2);
  }
  let calls = 0;
  const metadata = await extractGreenVideo(url, { fetchImpl: async target => {
    calls++;
    return response(target.endsWith('/auth/keys') ? { code: 200, data: keys }
      : calls === 2 ? { code: 530 } : { code: 200, data: resultData() });
  } });
  assert.equal(calls, 4);
  assert.equal(metadata.id, '7403699928150674706');
});

test('filters unsafe CDN URLs, HLS, provider staging links and misleading watermark labels', () => {
  const data = resultData();
  data.videoItemVoList = [
    { qualityAlias: '视频 无水印', baseUrl: media },
    { qualityAlias: '视频', baseUrl: 'https://v16-webapp-prime.tiktok.com.evil.test/a.mp4' },
    { qualityAlias: '视频', baseUrl: 'https://127.0.0.1/a.mp4' },
    { qualityAlias: '视频', baseUrl: 'https://v16-webapp-prime.tiktok.com/a.m3u8' },
    { qualityAlias: '视频', baseUrl: media, canDirectDownload: false },
  ];
  const metadata = normalizeGreenVideoResponse(data, { platform: 'tiktok' });
  assert.equal(metadata.formats.length, 1);
  assert.equal(metadata.formats[0]._clipdock_provider_watermark, undefined);
  assert.equal(metadata.formats[0]._clipdock_playback_source, undefined);
  assert.throws(() => normalizeGreenVideoResponse({ ...data, host: 'youtube' }, { platform: 'tiktok' }), { code: 'PROVIDER_INVALID_RESPONSE' });
  assert.throws(() => normalizeGreenVideoResponse({ ...data, videoItemVoList: [] }, { platform: 'tiktok' }), { code: 'NO_DOWNLOADABLE_VIDEO' });
});

test('does not accept VIP, live, manifests, app-only downloads or explicit non-video file types', () => {
  const data = resultData();
  data.videoItemVoList = [
    ...['onlyForVip', 'live', 'hlsType', 'dashType', 'mustUseDownloader'].map(flag => ({ qualityAlias: '视频', baseUrl: media, [flag]: true })),
    { qualityAlias: '视频', baseUrl: media, canDownload: false },
    { qualityAlias: '视频', baseUrl: media, fileType: 'audio' },
    { qualityAlias: '视频', baseUrl: media, fileExt: 'm3u8' },
    { qualityAlias: '视频', baseUrl: media, fileExt: 'mp3' },
    { qualityAlias: '视频', baseUrl: media, fileType: 'video', fileExt: 'mp4', size: 12345, headers: {
      'User-Agent': 'ExampleBrowser/1', Referer: url, Origin: 'https://127.0.0.1', Cookie: 'private', Authorization: 'private', 'X-Forwarded-For': '127.0.0.1',
    } },
  ];
  const metadata = normalizeGreenVideoResponse(data, { platform: 'tiktok' });
  assert.equal(metadata.formats.length, 1);
  assert.equal(metadata.formats[0].filesize, 12345);
  assert.deepEqual(metadata.formats[0].http_headers, { 'User-Agent': 'ExampleBrowser/1', Referer: url });
  data.videoItemVoList = [{ qualityAlias: '视频', baseUrl: media, headers: 'not executable and not parsed' }];
  assert.deepEqual(normalizeGreenVideoResponse(data, { platform: 'tiktok' }).formats[0].http_headers, { 'User-Agent': 'Mozilla/5.0' });
});

test('bounds response size, handles non-JSON error pages and obeys caller cancellation', async () => {
  await assert.rejects(extractGreenVideo(url, { fetchImpl: async () => new Response('<html>challenge</html>') }), { code: 'PROVIDER_INVALID_RESPONSE' });
  await assert.rejects(extractGreenVideo(url, { fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }), { code: 'PROVIDER_INVALID_RESPONSE' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(extractGreenVideo(url, { signal: controller.signal, fetchImpl: () => { throw new Error('must not fetch'); } }), { name: 'AbortError' });
});
