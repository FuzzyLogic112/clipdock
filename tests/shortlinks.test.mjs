import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalUrl } from '../lib/shortlinks.mjs';

function redirect(location, status = 302, onCancel = () => {}) {
  return { status, headers: new Headers(location ? { location } : {}), body: { cancel: async () => onCancel() } };
}

test('complete video links normalize without networking; original Douyin and TikTok short links retain their own flow', async () => {
  const noFetch = async () => assert.fail('No short-link fetch expected');
  for (const [input, expected] of [
    ['https://www.pinterest.ca/pin/664281013778109217/?utm=tracking', 'https://www.pinterest.com/pin/664281013778109217/'],
    ['https://weibo.com/7827771738/N4xlMvjhI', 'https://weibo.com/7827771738/N4xlMvjhI'],
    ['https://www.instagram.com/reel/Chunk8-jurw/', 'https://www.instagram.com/reel/Chunk8-jurw/'],
    ['https://vimeo.com/76979871?h=abc123def4', 'https://vimeo.com/76979871?h=abc123def4'],
    ['https://v.douyin.com/AbCd123/', 'https://v.douyin.com/AbCd123/'],
    ['https://vt.tiktok.com/AbCd123/', 'https://vt.tiktok.com/AbCd123/'],
  ]) assert.equal(await resolveLocalUrl(input, { fetchImpl: noFetch }), expected);
});

test('same-platform redirects resolve short links and discard bodies without forwarding cookies', async () => {
  for (const [input, target, expected] of [
    ['https://t.cn/AbCd123', 'https://m.weibo.cn/detail/4189191225395228', 'https://m.weibo.cn/status/4189191225395228'],
    ['https://pin.it/AbCd123', 'https://www.pinterest.ca/pin/664281013778109217/?utm=share', 'https://www.pinterest.com/pin/664281013778109217/'],
    ['https://fb.watch/AbCd123/', 'https://m.facebook.com/reel/1195289147628387/', 'https://www.facebook.com/reel/1195289147628387'],
    ['https://www.facebook.com/share/r/AbCd123/', '/reel/1195289147628387/', 'https://www.facebook.com/reel/1195289147628387'],
    ['https://v.kuaishou.com/AbCd123', 'https://www.kuaishou.com/short-video/3xn9abc123', 'https://www.kuaishou.com/short-video/3xn9abc123'],
  ]) {
    let fetched = 0; let cancelled = 0;
    const result = await resolveLocalUrl(input, { fetchImpl: async (url, options) => {
      fetched++; assert.equal(url, input); assert.equal(options.redirect, 'manual');
      assert.equal(Object.keys(options.headers).some(key => /cookie|authorization/i.test(key)), false);
      return redirect(target, 302, () => cancelled++);
    } });
    assert.equal(result, expected); assert.equal(fetched, 1); assert.equal(cancelled, 1);
  }
});

test('Xiaohongshu redirect preserves required access parameters and supports a bounded intermediate hop', async () => {
  const requests = [];
  const responses = [
    redirect('/a/SecondCode', 307),
    redirect('https://www.xiaohongshu.com/discovery/item/6411cf99000000001300b6d9?xsec_token=fixture%3D&xsec_source=pc_share&utm=tracking', 301),
  ];
  assert.equal(await resolveLocalUrl('https://xhslink.com/FirstCode', { fetchImpl: async url => {
    requests.push(url); return responses.shift();
  } }), 'https://www.xiaohongshu.com/explore/6411cf99000000001300b6d9?xsec_token=fixture%3D&xsec_source=pc_share');
  assert.deepEqual(requests, ['https://xhslink.com/FirstCode', 'https://xhslink.com/a/SecondCode']);
});

test('rejects cross-platform, private, downgraded and authority-confused redirects before fetching the destination', async () => {
  for (const destination of [
    'https://127.0.0.1/video', 'https://[::1]/video', 'https://169.254.169.254/latest',
    'https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://evil.test/video',
    'http://www.pinterest.com/pin/664281013778109217/',
    'https://www.pinterest.com:443/pin/664281013778109217/',
    '//www.pinterest.com:443/pin/664281013778109217/',
    'https://user@www.pinterest.com/pin/664281013778109217/',
    'https://www.pinterest.com.evil.test/pin/664281013778109217/',
    'https://www.pinterest.com\\@evil.test/pin/664281013778109217/', 'javascript:alert(1)',
  ]) {
    let calls = 0; let cancelled = 0;
    await assert.rejects(resolveLocalUrl('https://pin.it/AbCd123', { fetchImpl: async () => {
      calls++; return redirect(destination, 302, () => cancelled++);
    } }), { code: 'INVALID_REDIRECT' }, destination);
    assert.equal(calls, 1); assert.equal(cancelled, 1);
  }
});

test('rejects unresolved 200 pages, login destinations, missing locations, loops and excess redirects', async () => {
  let cancelled = 0;
  await assert.rejects(resolveLocalUrl('https://pin.it/AbCd123', { fetchImpl: async () => redirect(null, 200, () => cancelled++) }), { code: 'SHORT_LINK_UNRESOLVED' });
  assert.equal(cancelled, 1);
  await assert.rejects(resolveLocalUrl('https://pin.it/AbCd123', { fetchImpl: async () => redirect(null) }), { code: 'SHORT_LINK_UNRESOLVED' });
  const loginResponses = [redirect('https://www.pinterest.com/login/'), redirect(null, 200)];
  await assert.rejects(resolveLocalUrl('https://pin.it/AbCd123', { fetchImpl: async () => loginResponses.shift() }), { code: 'SHORT_LINK_UNRESOLVED' });
  let calls = 0;
  await assert.rejects(resolveLocalUrl('https://pin.it/AbCd123', { fetchImpl: async () => { calls++; return redirect('/AbCd123'); } }), { code: 'SHORT_LINK_UNRESOLVED' });
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(resolveLocalUrl('https://pin.it/AbCd123', { fetchImpl: async () => redirect(`/NextCode${++calls}`) }), { code: 'SHORT_LINK_UNRESOLVED' });
  assert.equal(calls, 5);
});

test('caller cancellation and timeout terminate pending requests, including a fetch that ignores its signal', async () => {
  const prior = new AbortController(); prior.abort();
  await assert.rejects(resolveLocalUrl('https://pin.it/AbCd123', { signal: prior.signal, fetchImpl: async () => assert.fail('Already aborted') }), { code: 'REQUEST_ABORTED' });
  const active = new AbortController();
  let pendingSignal;
  const pending = resolveLocalUrl('https://pin.it/AbCd123', { signal: active.signal, fetchImpl: (_url, { signal }) => {
    pendingSignal = signal; return new Promise(() => {});
  } });
  active.abort();
  await assert.rejects(pending, { code: 'REQUEST_ABORTED' });
  assert.equal(pendingSignal.aborted, true);
  await assert.rejects(resolveLocalUrl('https://pin.it/AbCd123', { timeoutMs: 10, fetchImpl: () => new Promise(() => {}) }), { code: 'EXTRACTOR_TIMEOUT', status: 504 });
  let finishFetch; let bodyCancelled = false;
  const late = resolveLocalUrl('https://pin.it/AbCd123', { timeoutMs: 10, fetchImpl: () => new Promise(resolve => { finishFetch = resolve; }) });
  await assert.rejects(late, { code: 'EXTRACTOR_TIMEOUT' });
  finishFetch(redirect('/SecondCode', 302, () => { bodyCancelled = true; }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bodyCancelled, true);
});
