import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isAllowedMediaUrl } from './platforms.mjs';

const defaultRoot = fileURLToPath(new URL('../.runtime/media/', import.meta.url));
const MAX_BYTES = 1024 ** 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const COMMON_TYPES = ['application/octet-stream', 'binary/octet-stream'];
const mediaError = (message, code, status = 502) => Object.assign(new Error(message), { code, status });
const abortedError = signal => signal?.reason?.code && signal.reason.status
  ? signal.reason : mediaError('准备下载已取消，请重新选择清晰度。', 'REQUEST_ABORTED', 499);

function runFfmpeg(args, { signal, ffmpegPath, captureOutput = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError(signal));
    const child = spawn(ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg', args, {
      shell: false, windowsHide: true, stdio: ['ignore', captureOutput ? 'pipe' : 'ignore', 'pipe'],
    });
    let output = ''; let errorBytes = 0; let failure;
    const onAbort = () => { failure ||= abortedError(signal); child.kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', chunk => { if (output.length < 8192) output += chunk.toString('utf8').slice(0, 8192 - output.length); });
    child.stderr.on('data', chunk => {
      errorBytes += chunk.length;
      if (errorBytes > 64 * 1024 && !failure) {
        failure = mediaError('音视频合并返回异常，请重新解析后再试。', 'MERGE_FAILED');
        child.kill();
      }
    });
    child.on('error', e => {
      failure ||= e.code === 'ENOENT'
        ? mediaError('未找到 FFmpeg，请安装后重新启动网站。', 'FFMPEG_MISSING', 503)
        : mediaError('无法启动音视频合并工具，请检查 FFmpeg 安装。', 'MERGE_FAILED');
    });
    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (failure) return reject(failure);
      if (code !== 0) return reject(mediaError('音视频合并失败，请重新解析后再试。', 'MERGE_FAILED'));
      resolve(output);
    });
  });
}

export async function getFfmpegHealth({ ffmpegPath } = {}) {
  const control = new AbortController();
  const timeout = setTimeout(() => control.abort(mediaError('FFmpeg 检查超时。', 'TIMEOUT', 504)), 8000);
  try {
    const output = await runFfmpeg(['-version'], { ffmpegPath, signal: control.signal, captureOutput: true });
    return { available: true, version: output.match(/^ffmpeg version\s+(\S+)/)?.[1] || 'installed' };
  } catch (e) {
    return { available: false, error: e.message, code: e.code };
  } finally { clearTimeout(timeout); }
}

function requestHeaders(headers = {}) {
  const safe = { 'user-agent': 'Mozilla/5.0', 'accept-encoding': 'identity' };
  for (const [name, value] of Object.entries(headers)) {
    if (/^(user-agent|referer|origin|accept|accept-language)$/i.test(name)
      && typeof value === 'string' && value.length <= 4096 && !/[\r\n]/.test(value)) safe[name.toLowerCase()] = value;
  }
  return safe;
}

function positiveOption(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.min(value, fallback) : fallback;
}

/** Download two trusted media streams to local files, then mux them without re-encoding. */
export async function prepareMergedMedia(ticket, options = {}) {
  const { signal, onProgress, fetchMedia, ffmpegPath } = options;
  if (typeof fetchMedia !== 'function') throw mediaError('媒体下载服务未配置。', 'DOWNLOAD_FAILED');
  if (ticket?.platform !== 'youtube' || (ticket.audioExt && ticket.audioExt !== 'm4a')
    || !isAllowedMediaUrl(ticket?.url, ticket?.platform) || !isAllowedMediaUrl(ticket?.audioUrl, ticket?.platform)) {
    throw mediaError('音视频来源地址无效，请重新解析。', 'UNSAFE_MEDIA');
  }
  if (signal?.aborted) throw abortedError(signal);
  const control = new AbortController();
  const relayAbort = () => control.abort(mediaError('准备下载已取消，请重新选择清晰度。', 'REQUEST_ABORTED', 499));
  signal?.addEventListener('abort', relayAbort, { once: true });
  const timeout = setTimeout(() => control.abort(mediaError('准备视频超时，请选择较低清晰度后重试。', 'TIMEOUT', 504)), positiveOption(options.timeoutMs, 8 * 60_000));
  const maxBytes = positiveOption(options.maxBytes, MAX_BYTES);
  const idleTimeoutMs = positiveOption(options.idleTimeoutMs, 60_000);
  let root; let directory; let received = 0;
  const sizes = [null, null];
  const progress = (stage, amount) => { try { onProgress?.({ stage, progress: amount }); } catch { /* UI reporting must not interrupt a download. */ } };
  const cleanup = async () => {
    if (!directory) return;
    const target = path.resolve(directory);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(target) !== root || !path.basename(target).startsWith('clipdock-')) {
      throw mediaError('临时文件清理路径无效。', 'CLEANUP_FAILED', 500);
    }
    // Only remove this job's directory; never recurse through a computed parent path.
    await fs.rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  };

  async function download(url, headers, file, index) {
    let idle;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => control.abort(mediaError('视频下载长时间没有响应，请稍后重试。', 'TIMEOUT', 504)), idleTimeoutMs);
    };
    let response;
    try {
      touch();
      for (let redirects = 0; redirects <= 3; redirects++) {
        if (!isAllowedMediaUrl(url, ticket.platform)) throw mediaError('音视频来源地址无效，请重新解析。', 'UNSAFE_MEDIA');
        response = await fetchMedia(url, { redirect: 'manual', signal: control.signal, headers: requestHeaders(headers) });
        touch();
        if (!REDIRECTS.has(response.status)) break;
        const location = response.headers.get('location');
        await response.body?.cancel(); response = null;
        if (!location || redirects === 3) throw mediaError('视频源跳转异常，请重新解析。', 'DOWNLOAD_FAILED');
        try { url = new URL(location, url).href; }
        catch { throw mediaError('视频源跳转地址无效，请重新解析。', 'UNSAFE_MEDIA'); }
      }
      const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const types = index === 0 ? ['video/mp4', ...COMMON_TYPES] : ['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'video/mp4', ...COMMON_TYPES];
      if (response.status !== 200 || !response.body || !types.includes(type)) {
        throw mediaError('视频或音频源暂时不可用，请重新解析。', 'DOWNLOAD_FAILED');
      }
      const length = response.headers.get('content-length');
      sizes[index] = length && /^\d+$/.test(length) ? Number(length) : null;
      if (sizes.reduce((sum, size) => sum + (size || 0), 0) > maxBytes) throw mediaError('视频超过本机单次准备的 1 GB 限制，请选择较低清晰度。', 'MEDIA_TOO_LARGE', 413);
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          touch(); received += chunk.length;
          if (received > maxBytes) return callback(mediaError('视频超过本机单次准备的 1 GB 限制，请选择较低清晰度。', 'MEDIA_TOO_LARGE', 413));
          const total = sizes.every(size => size !== null) ? sizes[0] + sizes[1] : null;
          progress('downloading', total > 0 ? Math.min(90, Math.floor(received / total * 90)) : null);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(file, { flags: 'wx' }), { signal: control.signal });
    } finally {
      clearTimeout(idle);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }

  try {
    await runFfmpeg(['-version'], { signal: control.signal, ffmpegPath });
    if (control.signal.aborted) throw abortedError(control.signal);
    await fs.mkdir(path.resolve(options.rootDir || defaultRoot), { recursive: true });
    root = await fs.realpath(path.resolve(options.rootDir || defaultRoot));
    directory = await fs.mkdtemp(path.join(root, 'clipdock-'));
    const videoPath = path.join(directory, 'video.mp4');
    const audioPath = path.join(directory, 'audio.m4a');
    const mergedPath = path.join(directory, 'merged.mp4');
    progress('downloading', null);
    const downloads = [download(ticket.url, ticket.headers, videoPath, 0), download(ticket.audioUrl, ticket.audioHeaders || ticket.headers, audioPath, 1)];
    try { await Promise.all(downloads); }
    catch (e) { control.abort(e.status ? e : mediaError('视频下载连接中断，请稍后重试。', 'DOWNLOAD_FAILED')); await Promise.allSettled(downloads); throw e; }
    progress('merging', null);
    await runFfmpeg([
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-n',
      '-protocol_whitelist', 'file', '-i', videoPath,
      '-protocol_whitelist', 'file', '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', mergedPath,
    ], { signal: control.signal, ffmpegPath });
    const { size } = await fs.stat(mergedPath);
    if (size === 0) throw mediaError('合并结果为空，请重新解析后再试。', 'MERGE_FAILED');
    await Promise.all([fs.unlink(videoPath), fs.unlink(audioPath)]);
    if (control.signal.aborted) throw abortedError(control.signal);
    return { path: mergedPath, size, cleanup };
  } catch (e) {
    await cleanup();
    if (control.signal.aborted) throw abortedError(control.signal);
    if (e.status && e.code) throw e;
    throw mediaError('准备视频失败，请重新解析后再试。', 'DOWNLOAD_FAILED');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', relayAbort);
  }
}
