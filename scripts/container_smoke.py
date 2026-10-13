"""Offline container smoke check: dependencies, service, writable cache, Chrome JS.

Run from the built image as its ordinary user:
    docker run --rm clipdock:check python scripts/container_smoke.py
No third-party video, cookies, signed CDN URL or external page is requested.
"""
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from urllib.request import ProxyHandler, build_opener


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'<!doctype html><title>waiting</title><script>document.title="clipdock-chrome-ok"</script>'
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def main():
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        raise RuntimeError("Smoke check must run as the non-root image user")
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryFile(dir=root / ".runtime") as cache:
        cache.write(b"clipdock-cache-check")

    # Check the same entry point and dependencies that production uses.
    env = os.environ.copy()
    env.update(HOST="0.0.0.0", PORT="4317")
    for key in ("PUBLIC_ORIGIN", "RENDER_EXTERNAL_URL"):
        env.pop(key, None)
    opener = build_opener(ProxyHandler({}))
    with tempfile.TemporaryFile(mode="w+b") as log:
        process = subprocess.Popen(["node", "server.mjs"], cwd=root, env=env,
                                   stdout=log, stderr=subprocess.STDOUT)
        try:
            health = None
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline and process.poll() is None:
                try:
                    with opener.open("http://127.0.0.1:4317/api/health", timeout=10) as response:
                        health = json.load(response)
                    break
                except OSError:
                    time.sleep(0.2)
            if not health:
                log.seek(0)
                raise RuntimeError("Service did not become ready: " + log.read().decode(errors="replace")[-3000:])
            assert health.get("ok") and health.get("service") == "clipdock", health
            assert health.get("extractor", {}).get("available"), health
            assert health.get("ffmpeg", {}).get("available"), health
            with opener.open("http://127.0.0.1:4317/healthz", timeout=5) as response:
                assert response.status == 200
            with opener.open("http://127.0.0.1:4317/api/platforms", timeout=5) as response:
                catalog = json.load(response)
            assert len(catalog["platforms"]) >= 11, catalog
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    # A real Chrome launch through Scrapling catches missing libraries, wrong
    # channel installation, profile permissions and container launch failures.
    from scrapling.fetchers import DynamicFetcher
    page_title = []
    with ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler) as fixture:
        thread = threading.Thread(target=fixture.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="clipdock-render-") as profile:
                with contextlib.redirect_stdout(sys.stderr):
                    DynamicFetcher.fetch(
                        f"http://127.0.0.1:{fixture.server_port}/", headless=True,
                        real_chrome=True, user_data_dir=profile, google_search=False,
                        network_idle=False, load_dom=True, timeout=15000, retries=1,
                        page_action=lambda page: page_title.append(page.title()))
        finally:
            fixture.shutdown()
            thread.join(timeout=5)
    assert page_title == ["clipdock-chrome-ok"], page_title
    checks = ["cache-write", "http", "yt-dlp", "ffmpeg", "platforms", "chrome-js"]
    if hasattr(os, "geteuid"):
        checks.insert(0, "non-root")
    print(json.dumps({"ok": True, "checks": checks}))


if __name__ == "__main__":
    main()
