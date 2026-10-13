import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { normalizeMetadata } from '../lib/extractor.mjs';
import { isAllowedMediaUrl } from '../lib/platforms.mjs';

const script = await fs.readFile(new URL('../scripts/douyin_player.js', import.meta.url), 'utf8');
const id = '7693299883440684131';
function readPlayer(data, href = `https://www.iesdouyin.com/share/video/${id}/`, videos = []) {
  const evaluate = vm.runInNewContext(`(${script})`, { URL, window:{_ROUTER_DATA:{loaderData:data}},
    location:{href}, navigator:{userAgent:'test'}, document:{title:'公开样例 - 抖音', querySelector:()=>null, querySelectorAll:()=>videos} });
  return JSON.parse(JSON.stringify(evaluate(id)));
}
const item = () => ({ aweme_id:id, desc:'公开视频', author:{nickname:'test'}, video:{width:576,height:1024,duration:12300,
  play_addr:{url_list:['https://v3.douyinvod.com/public.mp4']},
  download_addr:{url_list:['https://v3.douyinvod.com/watermarked.mp4']} } });

test('抖音移动分享页直接读取对应视频数据，无需加载媒体', () => {
  const metadata = readPlayer({videoPage:{data:item()}});
  assert.equal(metadata.id,id); assert.equal(metadata.duration,12.3);
  assert.equal(metadata.formats.length,1);
  const result=normalizeMetadata(metadata,'douyin');
  assert.equal(result.videos[0].formats[0].watermark,'none');
  assert.equal(result.videos[0].formats[0].label,'576p');
});

test('分享页拒绝其他视频、错平台、私网及伪造CDN', () => {
  const other=item(); other.aweme_id='999';
  assert.equal(readPlayer({item:other}),null);
  assert.equal(readPlayer({item:item()},`https://example.com/share/video/${id}/`),null);
  for (const url of ['http://127.0.0.1/private','https://douyinvod.com.evil.example/a.mp4','https://user:secret@v3.douyinvod.com/a.mp4']) {
    const bad=item(); bad.video.play_addr.url_list=[url]; assert.equal(readPlayer({item:bad}),null);
  }
});

test('保留桌面播放器来源，必须匹配原视频ID', () => {
  const video={currentSrc:`https://v3.douyinvod.com/player.mp4?__vid=${id}`,src:'',duration:3,videoWidth:576,videoHeight:1024,querySelectorAll:()=>[]};
  const result=readPlayer({},`https://www.douyin.com/video/${id}`, [video]);
  assert.equal(result.formats[0]._clipdock_webpage_original,true);
  video.currentSrc='https://v3.douyinvod.com/player.mp4?__vid=999';
  assert.equal(readPlayer({},`https://www.douyin.com/video/${id}`, [video]),null);
});

test('Instagram共享Meta视频CDN可用，仍拒绝跨平台与相似域名', () => {
  const url='https://instagram.flhr10-2.fna.fbcdn.net/v/test.mp4';
  assert.equal(isAllowedMediaUrl(url,'instagram'),true);
  assert.equal(isAllowedMediaUrl(url,'douyin'),false);
  assert.equal(isAllowedMediaUrl('https://instagram.fna.fbcdn.net.evil.example/a.mp4','instagram'),false);
  assert.equal(normalizeMetadata({id:'ig',formats:[{url,ext:'mp4',vcodec:'h264'}]},'instagram').videos.length,1);
});
