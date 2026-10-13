import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareMergedMedia, getFfmpegHealth } from '../lib/media.mjs';

const exec = promisify(execFile);
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ticket = { platform: 'youtube', url: 'https://rr1---sn-test.googlevideo.com/videoplayback?stream=video', audioUrl: 'https://rr1---sn-test.googlevideo.com/videoplayback?stream=audio', audioExt: 'm4a' };
const mediaResponse = (content, audio = false, extra = {}) => new Response(content, { headers: { 'Content-Type': audio ? 'audio/mp4' : 'video/mp4', ...extra } });

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'clipdock-media-test-'));
  const rootDir = path.join(parent, 'jobs');
  await fs.mkdir(rootDir);
  t.after(async () => {
    const resolved = path.resolve(parent);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('clipdock-media-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { parent, rootDir };
}

test('真实 FFmpeg 合并分离音视频，输出含视频和音频并能幂等清理', async t => {
  const health = await getFfmpegHealth();
  if (!health.available) return t.skip('测试环境未安装 FFmpeg');
  const { parent, rootDir } = await fixture(t);
  const sourceVideo = path.join(parent, 'source.mp4');
  const sourceAudio = path.join(parent, 'source.m4a');
  await exec(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10:d=0.3', '-an', '-c:v', 'mpeg4', sourceVideo], { windowsHide: true });
  await exec(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-vn', '-c:a', 'aac', sourceAudio], { windowsHide: true });
  const video = await fs.readFile(sourceVideo); const audio = await fs.readFile(sourceAudio);
  const progress = []; const receivedHeaders = [];
  const merged = await prepareMergedMedia({ ...ticket, headers: { Authorization: 'not-forwarded', Cookie: 'not-forwarded', Referer: 'https://www.youtube.com/' } }, {
    rootDir, onProgress: event => progress.push(event),
    fetchMedia: async (url, init) => {
      receivedHeaders.push(init.headers);
      assert.equal(init.redirect, 'manual');
      const isAudio = url.includes('stream=audio'); const bytes = isAudio ? audio : video;
      return mediaResponse(bytes, isAudio, { 'Content-Length': String(bytes.length) });
    },
  });
  assert.ok(merged.size > 0);
  assert.equal((await fs.stat(merged.path)).size, merged.size);
  assert.ok(path.relative(await fs.realpath(rootDir), merged.path).startsWith('clipdock-'));
  const decoded = await exec(ffmpegPath, ['-hide_banner', '-i', merged.path, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { windowsHide: true });
  assert.match(decoded.stderr, /Video:/);
  assert.match(decoded.stderr, /Audio:/);
  assert.ok(progress.some(event => event.stage === 'downloading' && Number.isFinite(event.progress)));
  assert.ok(progress.some(event => event.stage === 'merging' && event.progress === null));
  assert.equal(receivedHeaders[0].cookie, undefined);
  assert.equal(receivedHeaders[0].authorization, undefined);
  assert.equal(receivedHeaders[0].referer, 'https://www.youtube.com/');
  assert.deepEqual(await fs.readdir(path.dirname(merged.path)), ['merged.mp4']);
  await merged.cleanup(); await merged.cleanup();
  assert.deepEqual(await fs.readdir(rootDir), []);
});

test('拒绝媒体重定向到私网并清理本次任务', async t => {
  const { rootDir } = await fixture(t); const requested = [];
  await assert.rejects(prepareMergedMedia(ticket, {
    rootDir,
    fetchMedia: async url => {
      requested.push(url);
      if (url.includes('stream=video')) return new Response('', { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
      return mediaResponse('audio', true);
    },
  }), { code: 'UNSAFE_MEDIA' });
  assert.ok(requested.every(url => url.startsWith('https://rr1---sn-test.googlevideo.com/')));
  assert.deepEqual(await fs.readdir(rootDir), []);
});

test('大小限制同时检查声明长度与实际下载字节，失败后没有残留', async t => {
  const { rootDir } = await fixture(t);
  for (const declared of [true, false]) {
    await assert.rejects(prepareMergedMedia(ticket, {
      rootDir, maxBytes: 10,
      fetchMedia: async url => mediaResponse('this data is more than ten bytes', url.includes('audio'), declared ? { 'Content-Length': '31' } : {}),
    }), { code: 'MEDIA_TOO_LARGE', status: 413 });
    assert.deepEqual(await fs.readdir(rootDir), []);
  }
});

test('中止与没有数据的下载均及时终止并清理临时文件', async t => {
  const { rootDir } = await fixture(t);
  for (const shouldAbort of [true, false]) {
    const control = new AbortController(); let aborted;
    await assert.rejects(prepareMergedMedia(ticket, {
      rootDir, signal: control.signal, idleTimeoutMs: 80,
      onProgress: event => { if (shouldAbort && event.stage === 'downloading') aborted ||= setTimeout(() => control.abort(), 10); },
      fetchMedia: async url => mediaResponse(new ReadableStream(), url.includes('audio')),
    }), { code: shouldAbort ? 'REQUEST_ABORTED' : 'TIMEOUT' });
    clearTimeout(aborted);
    assert.deepEqual(await fs.readdir(rootDir), []);
  }
});

test('FFmpeg 缺失时明确报告依赖错误且不开始下载', async t => {
  const { rootDir } = await fixture(t);
  const missing = path.join(rootDir, 'missing-ffmpeg.exe');
  assert.equal((await getFfmpegHealth({ ffmpegPath: missing })).available, false);
  let calls = 0;
  await assert.rejects(prepareMergedMedia(ticket, { rootDir, ffmpegPath: missing, fetchMedia: async () => { calls++; } }), { code: 'FFMPEG_MISSING', status: 503 });
  assert.equal(calls, 0);
  assert.deepEqual(await fs.readdir(rootDir), []);
});

test('拒绝不支持的音频类型和伪装成媒体的 HTML', async t => {
  const { rootDir } = await fixture(t);
  await assert.rejects(prepareMergedMedia({ ...ticket, audioExt: 'webm' }, { rootDir, fetchMedia: async () => assert.fail('不应发起下载') }), { code: 'UNSAFE_MEDIA' });
  await assert.rejects(prepareMergedMedia(ticket, { rootDir, fetchMedia: async () => new Response('<html>login required</html>', { headers: { 'Content-Type': 'text/html' } }) }), { code: 'DOWNLOAD_FAILED' });
  assert.deepEqual(await fs.readdir(rootDir), []);
});
