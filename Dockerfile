# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

ARG YTDLP_VERSION=2026.08.19
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317 \
    MAX_PARSE_JOBS=1 \
    MAX_MERGE_JOBS=1 \
    MAX_DOWNLOADS=2 \
    NODE_OPTIONS=--max-old-space-size=128 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    SCRAPLING_PYTHON=/opt/clipdock-venv/bin/python \
    YTDLP_PATH=/opt/clipdock-venv/bin/yt-dlp \
    PATH=/opt/clipdock-venv/bin:$PATH

# Google distributes its Linux Chrome package for amd64. apt resolves the
# browser's native dependencies; no desktop display or user profile is copied.
RUN test "$(dpkg --print-architecture)" = amd64 \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl ffmpeg fonts-liberation python3 python3-venv tini \
    && curl --fail --show-error --location --retry 3 \
       https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
       --output /tmp/google-chrome.deb \
    && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
    && rm /tmp/google-chrome.deb \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/clipdock-venv

WORKDIR /app
COPY requirements-browser.txt ./
RUN python -m pip install --no-cache-dir \
      -r requirements-browser.txt 'playwright==1.63.0' "yt-dlp[default]==${YTDLP_VERSION}" \
    && python -m pip check

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server.mjs ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY scripts/ ./scripts/
RUN mkdir .runtime && chown node:node .runtime

USER node
EXPOSE 4317
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]
