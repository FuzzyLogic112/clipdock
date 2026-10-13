"""Read one public Douyin/TikTok player in a fresh Chrome profile.

No stealth mode, account session, cookie export, challenge solving, or arbitrary URLs.
stdout is exactly one JSON object; browser diagnostics go to stderr.
"""
import argparse
import contextlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from urllib.parse import urlsplit, unquote
from urllib.request import proxy_bypass_environment


PLAYER_DATA = r"""(expectedId) => {
  if (location.hostname !== 'www.douyin.com' || location.pathname.replace(/\/$/, '') !== '/video/' + expectedId) return null;
  const trusted = value => {
    try { const u = new URL(value, location.href); return u.protocol === 'https:' && !u.port && !u.username && !u.password
      && (u.hostname === 'douyinvod.com' || u.hostname.endsWith('.douyinvod.com'))
      && u.searchParams.get('__vid') === expectedId ? u.href : null; } catch { return null; }
  };
  for (const video of document.querySelectorAll('video')) {
    const urls = [...new Set([video.currentSrc, video.src, ...Array.from(video.querySelectorAll('source')).map(s => s.src)].map(trusted).filter(Boolean))];
    if (!urls.length) continue;
    const meta = name => document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]')?.content;
    const description = meta('description') || '';
    const author = description.match(/ - (.+?)于\d{8}发布/)?.[1] || '';
    return { id: expectedId, title: document.title.replace(/\s*-\s*抖音\s*$/, ''), uploader: author,
      thumbnail: meta('lark:url:video_cover_image_url') || meta('og:image'),
      duration: Number.isFinite(video.duration) && video.duration >= 0 ? video.duration : null,
      formats: urls.slice(0, 8).map((url, index) => ({ format_id: 'browser-play-' + index, url, ext: 'mp4', protocol: 'https',
        width: video.videoWidth || null, height: video.videoHeight || null, _clipdock_webpage_original: true,
        http_headers: { 'User-Agent': navigator.userAgent, Referer: 'https://www.douyin.com/' } })) };
  }
  return null;
}"""


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def error(code, message):
    emit({"ok": False, "code": code, "message": message})
    return 1


def browser_proxy(url):
    """Use the same explicitly configured HTTP proxy as the local downloader."""
    host = urlsplit(url).hostname
    no_proxy = os.environ.get("no_proxy", os.environ.get("NO_PROXY", ""))
    if proxy_bypass_environment(host, {"no": no_proxy}):
        return None
    value = (os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY")
             or os.environ.get("http_proxy") or os.environ.get("HTTP_PROXY"))
    if not value:
        return None
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError("Unsupported HTTP proxy configuration")
    server_host = "[" + parsed.hostname + "]" if ":" in parsed.hostname else parsed.hostname
    config = {"server": parsed.scheme + "://" + server_host + (":" + str(parsed.port) if parsed.port else "")}
    if parsed.username is not None:
        config["username"] = unquote(parsed.username)
    if parsed.password is not None:
        config["password"] = unquote(parsed.password)
    return config


@contextlib.contextmanager
def fresh_profile(provided):
    if provided:
        profile = Path(provided).resolve()
        temporary_root = Path(tempfile.gettempdir()).resolve()
        if profile.parent != temporary_root or not profile.name.startswith("clipdock-render-") or not profile.is_dir() or any(profile.iterdir()):
            raise ValueError("Only an empty task-created temporary profile is accepted")
        # The Node caller owns cleanup, including cancellation and hard timeouts.
        yield str(profile)
    else:
        with tempfile.TemporaryDirectory(prefix="clipdock-render-") as profile:
            yield profile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--timeout-ms", type=int, default=60000)
    parser.add_argument("--profile-dir")
    args = parser.parse_args()
    match = re.fullmatch(r"https://www\.douyin\.com/video/(\d+)", args.url)
    platform = "douyin"
    if not match:
        match = re.fullmatch(r"https://www\.tiktok\.com/@[A-Za-z0-9_.-]{1,100}/video/(\d+)", args.url)
        platform = "tiktok"
    if not match:
        match = re.fullmatch(r"https://www\.tiktokv\.com/share/video/(\d+)/", args.url)
        platform = "tiktok"
    if not match:
        return error("INVALID_URL", "匿名浏览器仅支持规范的抖音或 TikTok 视频链接。")
    if args.timeout_ms < 3000 or args.timeout_ms > 90000:
        return error("INVALID_REQUEST", "浏览器解析时间必须介于 3 秒与 90 秒。")
    try:
        with contextlib.redirect_stdout(sys.stderr):
            from scrapling.fetchers import DynamicFetcher
            if platform == "tiktok":
                from tiktok_player import PLAYER_DATA as player_script
            else:
                player_script = PLAYER_DATA
    except ImportError:
        return error("BROWSER_MISSING", "缺少匿名浏览器解析依赖，请运行 setup-browser.cmd。")

    result = None
    deadline = time.monotonic() + args.timeout_ms / 1000 - 2

    def inspect_player(page):
        nonlocal result
        # Match the successful anonymous-browser check: normal JavaScript gets time to render.
        page.wait_for_timeout(max(0, min(8000, int((deadline - time.monotonic()) * 1000))))
        while time.monotonic() < deadline:
            result = page.evaluate(player_script, match.group(1))
            if result:
                return
            # This is an ordinary page load, never a CAPTCHA or login interaction.
            challenges = page.locator('[id*="captcha"], [class*="captcha_verify"], iframe[src*="captcha"]')
            if any(challenges.nth(index).is_visible() for index in range(min(challenges.count(), 8))):
                return
            page.wait_for_timeout(750)

    try:
        with fresh_profile(args.profile_dir) as profile:
            with contextlib.redirect_stdout(sys.stderr):
                DynamicFetcher.fetch(args.url, headless=True, real_chrome=True,
                    proxy=browser_proxy(args.url),
                    user_data_dir=profile, google_search=False, disable_resources=False,
                    network_idle=False, load_dom=True, wait=0, locale="zh-CN",
                    timeout=min(args.timeout_ms - 1000, 30000), retries=1,
                    page_action=inspect_player)
        if result:
            if result.get("_clipdock_error") == "NO_MEDIA":
                return error("NO_MEDIA", "这个视频已删除、作者不可用，或没有公开媒体。")
            return emit({"ok": True, "metadata": result}) or 0
        return error("PLATFORM_BLOCKED", "匿名浏览器未获得这个视频的公开播放地址，平台可能要求登录或验证。")
    except Exception as exc:
        message = str(exc).lower()
        if any(fragment in message for fragment in ["executable doesn't exist", "executable does not exist", "chromium distribution", "browser executable", "please run the following command", "not found at"]):
            return error("BROWSER_MISSING", "未找到可用的 Chrome 浏览器，请运行 setup-browser.cmd 并检查 Chrome 安装。")
        if "timeout" in message or time.monotonic() >= deadline:
            return error("EXTRACTOR_TIMEOUT", "匿名浏览器解析超时，请稍后重试。")
        return error("PLATFORM_BLOCKED", "匿名浏览器暂时无法读取这个公开视频，请检查网络或稍后重试。")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
