import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVideo } from '../lib/resolver.mjs';

const localResult = { title: 'sample', videos: [{ id: 'sample', formats: [] }] };
const tiktok = 'https://www.tiktok.com/@example/video/1234567890';
const remoteResult = { id: 'remote', title: 'Public sample', formats: [{
  format_id: 'remote', ext: 'mp4', url: 'https://v16-webapp-prime.tiktok.com/video/test.mp4',
}] };

test('自动选择保留本地成功结果，不向外部发送链接', async () => {
  let remoteCalls = 0;
  const result = await resolveVideo(tiktok, { localExtractor: async () => localResult, remoteExtractor: async () => { remoteCalls++; } });
  assert.equal(result.provider, 'local'); assert.equal(remoteCalls, 0);
});

test('本地失败后自动使用扩展解析，保留未知水印而不假称去水印', async () => {
  const result = await resolveVideo(tiktok, { localExtractor: async () => { throw new Error('Unavailable'); }, remoteExtractor: async () => remoteResult });
  assert.equal(result.provider, 'greenvideo'); assert.equal(result.videos[0].formats[0].watermark, 'unknown');
});

test('显式本地不会回退，显式扩展不会执行本地，验证码错误保留', async () => {
  let localCalls = 0, remoteCalls = 0;
  const localExtractor = async () => { localCalls++; throw Object.assign(new Error('local'), { code: 'PLATFORM_BLOCKED' }); };
  const remoteExtractor = async () => { remoteCalls++; throw Object.assign(new Error('请到原站完成验证'), { code: 'CAPTCHA_REQUIRED', status: 422 }); };
  await assert.rejects(resolveVideo(tiktok, { provider: 'local', localExtractor, remoteExtractor }), { code: 'PLATFORM_BLOCKED' });
  assert.equal(remoteCalls, 0);
  await assert.rejects(resolveVideo(tiktok, { provider: 'greenvideo', localExtractor, remoteExtractor }), { code: 'CAPTCHA_REQUIRED' });
  assert.equal(localCalls, 1); assert.equal(remoteCalls, 1);
});

test('已暂停的平台不发送GreenVideo，非法方式及预先中止不执行提取器', async () => {
  const localExtractor = async () => { throw new Error('must not call'); };
  const remoteExtractor = localExtractor;
  for (const url of ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://www.douyin.com/video/123']) {
    await assert.rejects(resolveVideo(url, { provider: 'greenvideo', localExtractor, remoteExtractor }), { code: 'PROVIDER_UNSUPPORTED' });
  }
  await assert.rejects(resolveVideo(tiktok, { provider: 'anything', localExtractor, remoteExtractor }), { code: 'INVALID_PROVIDER' });
  await assert.rejects(resolveVideo(tiktok, { signal: AbortSignal.abort(), localExtractor, remoteExtractor }), { code: 'REQUEST_ABORTED' });
  await assert.rejects(resolveVideo(tiktok, {
    localExtractor: async () => { throw Object.assign(new Error('拒绝跳转'), { code: 'INVALID_REDIRECT' }); },
    remoteExtractor,
  }), { code: 'INVALID_REDIRECT' });
});
