import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createClipdockServer } from '../lib/server.mjs';
import { runtimeConfig } from '../lib/config.mjs';

const publicOrigin = 'https://clipdock.example.com';
const source = 'https://x.com/example/status/1234567890123456789';
const metadata = { title:'video', videos:[{ id:'1', formats:[{ id:'mp4', url:'https://video.twimg.com/test.mp4' }] }] };
async function fixture(t, options = {}) {
  const server = createClipdockServer({ publicOrigin, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
function request(base, path = '/', headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method: body ? 'POST' : 'GET', headers: { Host:'clipdock.example.com', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status:res.statusCode, body:Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('云端接受配置的 HTTPS 来源，拒绝未知域名及转发头伪造', async t => {
  const base = await fixture(t, { extractVideo:async () => metadata });
  assert.equal((await request(base)).status, 200);
  const parsed = await request(base, '/api/parse-video', { Origin:publicOrigin, 'Content-Type':'application/json' }, JSON.stringify({url:source}));
  assert.equal(parsed.status, 200);
  assert.match(JSON.parse(parsed.body).videos[0].formats[0].downloadUrl, /^\/api\/download\//);
  assert.equal((await request(base, '/api/platforms', { Origin:'https://evil.example' })).status, 403);
  assert.equal((await request(base, '/', { Host:'evil.example', 'X-Forwarded-Host':'clipdock.example.com' })).status, 403);
  assert.equal((await request(base, '/', { Origin:'http://clipdock.example.com', 'X-Forwarded-Proto':'https' })).status, 403);
  assert.equal((await fetch(base + '/healthz')).status, 200);
});

test('健康探针不启动外部进程，目录明确报告云端运行', async t => {
  let checks = 0;
  const base = await fixture(t, { getExtractorHealth:async () => { checks++; return {}; }, getFfmpegHealth:async () => { checks++; return {}; } });
  assert.equal((await request(base, '/healthz')).status, 200);
  assert.equal(checks, 0);
  assert.equal(JSON.parse((await request(base, '/api/platforms')).body).deploymentMode, 'online');
});

test('Render 自动域名与显式域名配置有效，错误配置在启动前失败', () => {
  assert.equal(runtimeConfig({}).host, '127.0.0.1');
  const config = runtimeConfig({ RENDER_EXTERNAL_URL:publicOrigin + '/', HOST:'0.0.0.0', PORT:'10000', MAX_PARSE_JOBS:'1', MAX_MERGE_JOBS:'1' });
  assert.equal(config.publicOrigin, publicOrigin); assert.equal(config.port, 10000); assert.equal(config.maxParseJobs, 1);
  assert.equal(runtimeConfig({ PUBLIC_ORIGIN:'https://custom.example', RENDER_EXTERNAL_URL:publicOrigin }).publicOrigin, 'https://custom.example');
  for (const value of ['https://example.com/path', 'http://example.com', 'https://user:pass@example.com', 'https://example.com/?secret=yes']) assert.throws(() => runtimeConfig({ PUBLIC_ORIGIN:value }));
  assert.throws(() => runtimeConfig({ MAX_PARSE_JOBS:'0' }));
  assert.throws(() => runtimeConfig({ MAX_DOWNLOADS:'99' }));
});

test('云端单解析并发限制会返回 BUSY，任务结束后恢复', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let started;
  const startedSignal = new Promise(resolve => { started = resolve; });
  const base = await fixture(t, { maxParseJobs:1, extractVideo:async () => { started(); await waiting; return metadata; } });
  t.after(() => release());
  const submit = url => request(base, '/api/parse-video', { Origin:publicOrigin, 'Content-Type':'application/json' }, JSON.stringify({url}));
  const first = submit(source); await startedSignal;
  const blocked = await submit(source.replace('1234567890123456789', '1234567890123456780'));
  assert.equal(blocked.status, 429); assert.equal(JSON.parse(blocked.body).code, 'BUSY');
  release(); assert.equal((await first).status, 200);
  assert.equal((await submit(source.replace('1234567890123456789', '1234567890123456780'))).status, 200);
});

test('云端下载并发上限保护流量，结束后释放名额', async t => {
  let body;
  const base = await fixture(t, { maxDownloads:1, extractVideo:async () => metadata, fetchMedia:async () => new Response(new ReadableStream({ start(controller) { body = controller; controller.enqueue(new TextEncoder().encode('abc')); } }), { headers:{'Content-Type':'video/mp4'} }) });
  const result = JSON.parse((await request(base, '/api/parse-video', { 'Content-Type':'application/json' }, JSON.stringify({url:source}))).body);
  const download = result.videos[0].formats[0].downloadUrl;
  const first = await fetch(base + download);
  const blocked = await fetch(base + download);
  assert.equal(blocked.status, 429); assert.equal((await blocked.json()).code, 'BUSY');
  body.close(); assert.equal(await first.text(), 'abc');
  await new Promise(resolve => setImmediate(resolve));
  const next = await fetch(base + download); assert.equal(next.status, 200);
  body.close(); await next.text();
});
