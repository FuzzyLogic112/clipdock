import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createClipdockServer } from '../lib/server.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tweet = 'https://x.com/example/status/1234567890123456789';
const metadata = () => ({ title:'测试视频',author:'作者',duration:12,thumbnail:null,videos:[{id:'video-1',title:'测试视频',duration:12,thumbnail:null,formats:[{id:'720',label:'720p',width:1280,height:720,ext:'mp4',filesize:12,hasAudio:true,bitrate:1000,url:'https://video.twimg.com/test/video.mp4'}]}] });
async function fixture(t, options = {}) {
  const server = createClipdockServer({ extractTweet: async () => metadata(), getExtractorHealth:async()=>({available:true,version:'test'}), ...options });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=> { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const parse = (base, url = tweet, headers = {}) => fetch(base+'/api/parse-video',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({url})});

test('真实路由返回元信息及受控下载地址，并复用同一帖子解析结果', async t => {
  let calls = 0;
  const base = await fixture(t,{extractTweet:async()=>{calls++; await new Promise(resolve=>setTimeout(resolve,15)); return metadata();}});
  const [a,b] = await Promise.all([parse(base),parse(base)]);
  const first=await a.json(), second=await b.json();
  assert.equal(a.status,200); assert.equal(first.id,second.id); assert.equal(calls,1);
  assert.match(first.videos[0].formats[0].downloadUrl,/^\/api\/download\/[a-f0-9]{48}$/);
  assert.equal(first.videos[0].formats[0].url,undefined);
  await parse(base); assert.equal(calls,1);
});

test('平台目录可用于前端且解析方式隔离缓存、报告实际来源', async t => {
  const providers = [];
  const base = await fixture(t, { resolveVideo: async (_url, options) => {
    providers.push(options.provider);
    return { ...metadata(), provider: options.provider === 'greenvideo' ? 'greenvideo' : 'local' };
  } });
  const catalog = await (await fetch(base + '/api/platforms')).json();
  assert.equal(catalog.platforms.length, 11);
  assert.ok(catalog.platforms.find(row => row.id === 'weibo').inputHosts.includes('weibo.com'));
  assert.deepEqual(catalog.providers.map(row => row.id), ['auto', 'local', 'greenvideo']);
  const request = provider => fetch(base + '/api/parse-video', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: tweet, provider }) });
  const first = await (await request('local')).json();
  const second = await (await request('greenvideo')).json();
  assert.notEqual(first.id, second.id);
  assert.equal(second.provider, 'greenvideo');
  assert.equal((await (await request('greenvideo')).json()).id, second.id);
  assert.deepEqual(providers, ['local', 'greenvideo']);
  assert.equal((await request('untrusted')).status, 400);
});

test('下载流返回附件，转发合法Range，并保留206响应', async t => {
  let seen;
  const base = await fixture(t,{fetchMedia:async(url,options)=>{seen={url,options};return new Response('abc',{status:206,headers:{'Content-Type':'video/mp4','Content-Length':'3','Content-Range':'bytes 0-2/12'}});}});
  const parsed=await (await parse(base)).json();
  const response=await fetch(base+parsed.videos[0].formats[0].downloadUrl,{headers:{Range:'bytes=0-2'}});
  assert.equal(response.status,206); assert.equal(await response.text(),'abc');
  assert.match(response.headers.get('content-disposition'),/^attachment;/);
  assert.equal(seen.options.headers.Range,'bytes=0-2');
  assert.equal(seen.url,'https://video.twimg.com/test/video.mp4');
});

test('不接受任意URL、跨站请求或不存在的下载票据', async t => {
  const base=await fixture(t);
  assert.equal((await parse(base,'http://127.0.0.1/private')).status,400);
  assert.equal((await parse(base,tweet,{Origin:'https://example.com'})).status,403);
  assert.equal((await fetch(base+'/api/download/'+'a'.repeat(48))).status,410);
  const hostStatus=await new Promise((resolve,reject)=>http.get(base+'/api/health',{headers:{Host:'evil.example'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject));
  assert.equal(hostStatus,403);
});

test('拒绝解析器返回的非受信媒体来源', async t => {
  const base=await fixture(t,{extractTweet:async()=>{const m=metadata();m.videos[0].formats[0].url='http://127.0.0.1:9999/secret';return m;}});
  const response=await parse(base); assert.equal(response.status,422);
  assert.equal((await response.json()).code,'NO_MEDIA');
});

test('拒绝媒体重定向到内部地址', async t => {
  let calls=0;
  const base=await fixture(t,{fetchMedia:async()=>{calls++;return new Response('',{status:302,headers:{Location:'http://127.0.0.1/secret'}});}});
  const parsed=await (await parse(base)).json();
  const response=await fetch(base+parsed.videos[0].formats[0].downloadUrl);
  assert.equal(response.status,502); assert.equal((await response.json()).code,'UNSAFE_MEDIA'); assert.equal(calls,1);
});

test('过期的下载链接提示重新解析', async t => {
  let clock=Date.now();
  const base=await fixture(t,{now:()=>clock,cacheTtlMs:1000});
  const parsed=await (await parse(base)).json(); clock+=1001;
  const response=await fetch(base+parsed.videos[0].formats[0].downloadUrl);
  assert.equal(response.status,410); assert.equal((await response.json()).code,'LINK_EXPIRED');
});

test('媒体源拒绝下载后再次解析会刷新地址而不复用失败缓存', async t => {
  let calls = 0;
  const base = await fixture(t, {
    extractTweet: async () => { calls++; return metadata(); },
    fetchMedia: async () => new Response('Forbidden', { status: 403 }),
  });
  const first = await (await parse(base)).json();
  const rejected = await fetch(base + first.videos[0].formats[0].downloadUrl);
  assert.equal(rejected.status, 502);
  assert.equal((await rejected.json()).code, 'MEDIA_UNAVAILABLE');
  const refreshed = await (await parse(base)).json();
  assert.equal(calls, 2);
  assert.notEqual(refreshed.id, first.id);
  assert.equal((await fetch(base + first.videos[0].formats[0].downloadUrl)).status, 410);
});

test('解析失败保留用户可理解的错误，限制过量请求', async t => {
  const base=await fixture(t,{maxRequestsPerMinute:1,extractTweet:async()=>{throw Object.assign(new Error('帖子未公开。'),{code:'AUTH_REQUIRED',status:422});}});
  const response=await parse(base); assert.equal(response.status,422); assert.equal((await response.json()).error,'帖子未公开。');
  const limited=await parse(base); assert.equal(limited.status,429); assert.equal(limited.headers.get('retry-after'),'60');
});

test('四平台结果保留真实水印状态，下载地址和媒体请求头不泄露', async t => {
  const cases = [
    ['https://www.youtube.com/watch?v=jNQXAC9IVRw','youtube','https://rr1---sn-test.googlevideo.com/videoplayback?id=1','source'],
    ['https://www.douyin.com/video/6963263655114722595','douyin','https://v3.douyinvod.com/video/test.mp4','none'],
    ['https://www.tiktok.com/@example/video/7170520270497680683','tiktok','https://v16.tiktokcdn.com/video/test.mp4','present'],
  ];
  for (const [url,platform,media,watermark] of cases) {
    const base=await fixture(t,{extractVideo:async()=>{const m=metadata();Object.assign(m.videos[0].formats[0],{url:media,watermark,watermarkLabel:'测试状态',headers:{Cookie:'should-not-leak'}});return m;}});
    const response=await parse(base,url); assert.equal(response.status,200);
    const data=await response.json(), format=data.videos[0].formats[0];
    assert.equal(data.platform,platform); assert.equal(format.watermark,watermark);
    assert.equal(format.headers,undefined); assert.equal(format.url,undefined);
    const prepared=await fetch(base+format.downloadUrl.replace('/download/','/prepare/'),{method:'POST'});
    assert.equal(prepared.status,200); assert.equal((await prepared.json()).status,'ready');
  }
});

test('音视频准备去重，完成后支持本地附件与范围下载', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clipdock-server-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const filePath=path.join(dir,'test.mp4'); await fs.writeFile(filePath,'merged-content');
  let calls=0, finish;
  const base=await fixture(t,{extractVideo:async()=>{const m=metadata();Object.assign(m.videos[0].formats[0],{url:'https://rr1---sn-test.googlevideo.com/videoplayback?id=v',audioUrl:'https://rr1---sn-test.googlevideo.com/videoplayback?id=a',requiresMerge:true});return m;},prepareMergedMedia:async(ticket,{onProgress})=>{
    calls++;onProgress({stage:'merging',progress:null});await new Promise(resolve=>{finish=resolve;});
    return {path:filePath,size:14,cleanup:async()=>{}};
  }});
  const data=await (await parse(base,'https://youtu.be/jNQXAC9IVRw')).json();
  const downloadUrl=data.videos[0].formats[0].downloadUrl, prepareUrl=base+downloadUrl.replace('/download/','/prepare/');
  assert.equal((await fetch(base+downloadUrl)).status,409);
  const [first,second]=await Promise.all([fetch(prepareUrl,{method:'POST'}),fetch(prepareUrl,{method:'POST'})]);
  assert.equal(first.status,202); assert.equal(second.status,202); assert.equal(calls,1);
  assert.equal((await (await fetch(prepareUrl)).json()).stage,'merging'); finish();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await (await fetch(prepareUrl)).json()).status,'ready');
  const full=await fetch(base+downloadUrl); assert.equal(await full.text(),'merged-content');
  const partial=await fetch(base+downloadUrl,{headers:{Range:'bytes=2-5'}});
  assert.equal(partial.status,206); assert.equal(partial.headers.get('content-range'),'bytes 2-5/14'); assert.equal(await partial.text(),'rged');
  assert.equal((await fetch(base+downloadUrl,{headers:{Range:'bytes=99-'}})).status,416);
});

test('拒绝另一平台的媒体源和不安全的合并音轨', async t => {
  for (const bad of [
    {url:'https://video.twimg.com/video.mp4'},
    {url:'https://rr1---sn-test.googlevideo.com/videoplayback?id=v',audioUrl:'http://127.0.0.1/secret',requiresMerge:true},
  ]) {
    const base=await fixture(t,{extractVideo:async()=>{const m=metadata();Object.assign(m.videos[0].formats[0],bad);return m;}});
    assert.equal((await parse(base,'https://youtu.be/jNQXAC9IVRw')).status,422);
  }
});

test('准备失败保留可理解错误，重试可以重新启动任务', async t => {
  let calls=0;
  const base=await fixture(t,{extractVideo:async()=>{const m=metadata();Object.assign(m.videos[0].formats[0],{url:'https://rr1---sn-test.googlevideo.com/videoplayback?v',audioUrl:'https://rr1---sn-test.googlevideo.com/videoplayback?a',requiresMerge:true});return m;},prepareMergedMedia:async()=>{calls++;throw Object.assign(new Error('请安装 FFmpeg。'),{code:'FFMPEG_MISSING',status:503});}});
  const data=await (await parse(base,'https://youtu.be/jNQXAC9IVRw')).json();
  const prepareUrl=base+data.videos[0].formats[0].downloadUrl.replace('/download/','/prepare/');
  await fetch(prepareUrl,{method:'POST'});
  const failed=await (await fetch(prepareUrl)).json();
  assert.equal(failed.status,'failed'); assert.equal(failed.code,'FFMPEG_MISSING'); assert.match(failed.error,/FFmpeg/);
  await fetch(prepareUrl,{method:'POST'}); assert.equal(calls,2);
});
