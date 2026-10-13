'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('parse-form');
  const urlInput = $('post-url');
  const parseButton = $('parse-button');
  const pasteButton = $('paste-button');
  const providerSelect = $('provider-select');
  const historyKey = 'clipdock.history.v1';
  const state = { controller: null, history: [], toastTimer: null, loadingTimer: null, preparations: new Set(), catalogReady: false };
  const platformNames = { youtube: 'YouTube', douyin: '抖音', tiktok: 'TikTok', twitter: 'X / Twitter', x: 'X / Twitter' };
  const supportedHosts = new Set([
    'x.com', 'www.x.com', 'mobile.x.com', 'm.x.com',
    'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'm.twitter.com',
    'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
    'douyin.com', 'www.douyin.com', 'v.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com',
    'tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com',
    'www.tiktokv.com',
  ]);
  const imageHosts = new Set(['pbs.twimg.com', 'video.twimg.com']);
  const imageRoots = ['ytimg.com', 'byteimg.com', 'ibyteimg.com', 'douyinpic.com', 'ibytedtos.com', 'byteoversea.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com'];
  const providerNames = { auto: '自动选择', local: '内置解析', greenvideo: 'GreenVideo 扩展' };

  function create(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function updateProviderHelp() {
    const provider = providerSelect.value;
    $('provider-description').textContent = {
      auto: '优先内置，必要时使用扩展解析。',
      local: '由本站服务器直接解析视频平台。',
      greenvideo: '目前暂停 YouTube、抖音解析。',
    }[provider] || '由本站服务器直接解析视频平台。';
    $('provider-disclosure').hidden = provider === 'local';
  }

  function renderPlatformCatalog(platforms) {
    const commonIds = new Set(['youtube', 'douyin', 'tiktok', 'twitter']);
    const symbols = { youtube: '▶', douyin: '♪', tiktok: '♪', twitter: '𝕏' };
    const common = $('platform-list');
    const extra = $('extra-platform-list');
    common.replaceChildren();
    extra.replaceChildren();
    platforms.forEach((platform) => {
      const item = create('li');
      if (symbols[platform.id]) {
        const symbol = create('span', `platform-symbol ${platform.id === 'twitter' ? 'x' : platform.id}-symbol`, symbols[platform.id]);
        symbol.setAttribute('aria-hidden', 'true');
        item.append(symbol);
      }
      item.append(create('span', '', platform.label));
      (commonIds.has(platform.id) ? common : extra).append(item);
    });
    const extraCount = platforms.filter((platform) => !commonIds.has(platform.id)).length;
    $('more-platforms').hidden = !extraCount;
    $('more-platforms-label').textContent = `更多 ${extraCount} 个平台`;
  }

  async function loadPlatformCatalog() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const validHost = (value) => typeof value === 'string' && value.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(value);
    try {
      const response = await fetch('/api/platforms', { signal: controller.signal, cache: 'no-store' });
      const data = await response.json();
      const platforms = data && data.platforms;
      if (!response.ok || !Array.isArray(platforms) || !platforms.length || platforms.length > 50 || platforms.some((platform) =>
        !platform || !/^[a-z][a-z0-9_-]{0,31}$/.test(platform.id) || typeof platform.label !== 'string' || !platform.label.trim() || platform.label.length > 60 ||
        !Array.isArray(platform.inputHosts) || !platform.inputHosts.length || platform.inputHosts.some((host) => !validHost(host)))) throw new Error('invalid-catalog');
      const providers = Array.isArray(data.providers) ? data.providers.filter((provider) => provider && Object.hasOwn(providerNames, provider.id)) : [];
      if (!providers.some((provider) => provider.id === 'local')) throw new Error('missing-local-provider');
      supportedHosts.clear();
      platforms.forEach((platform) => {
        platformNames[platform.id] = platform.label;
        platform.inputHosts.forEach((host) => supportedHosts.add(host.toLowerCase()));
      });
      if (Array.isArray(data.imageHosts)) {
        data.imageHosts.filter(validHost).forEach((host) => { if (!imageRoots.includes(host.toLowerCase())) imageRoots.push(host.toLowerCase()); });
      }
      providerSelect.replaceChildren();
      providers.forEach((provider) => {
        const option = create('option', '', providerNames[provider.id]);
        option.value = provider.id;
        providerSelect.append(option);
      });
      providerSelect.value = providers.some((provider) => provider.id === 'auto') ? 'auto' : 'local';
      state.catalogReady = true;
      renderPlatformCatalog(platforms);
    } catch {
      $('catalog-notice').textContent = '未能读取扩展平台列表，暂保留 YouTube、抖音、TikTok 和 X / Twitter 的内置解析。请刷新页面重试。';
      $('catalog-notice').hidden = false;
      providerSelect.value = 'local';
    } finally {
      clearTimeout(timer);
      providerSelect.disabled = !state.catalogReady || !!state.controller;
      updateProviderHelp();
      loadHistory();
    }
  }

  function toast(message) {
    clearTimeout(state.toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
  }

  function formMessage(message = '') {
    $('form-message').textContent = message;
    $('form-message').hidden = !message;
    urlInput.setAttribute('aria-invalid', message ? 'true' : 'false');
    urlInput.closest('.input-wrap').classList.toggle('invalid', !!message);
  }

  function setView(view) {
    ['empty-state', 'loading-state', 'error-state', 'results'].forEach((id) => { $(id).hidden = id !== view; });
    $('result-region').setAttribute('aria-busy', view === 'loading-state' ? 'true' : 'false');
    const busy = view === 'loading-state';
    parseButton.disabled = busy;
    parseButton.querySelector('span').textContent = busy ? '解析中…' : '解析视频';
    pasteButton.disabled = busy;
    providerSelect.disabled = busy || !state.catalogReady;
    urlInput.readOnly = busy;
    clearTimeout(state.loadingTimer);
    if (busy) {
      $('loading-detail').textContent = '正在读取视频信息，请稍候…';
      $('app-announcement').textContent = '正在解析视频，请稍候。';
      state.loadingTimer = setTimeout(() => { $('loading-detail').textContent = '仍在连接并读取视频信息，请再等一会儿…'; }, 16000);
    }
  }

  function normalizeUrl(value) {
    const text = String(value || '').trim();
    if (!text) throw new Error('请先粘贴一个视频链接，或包含链接的分享文字。');
    const fullUrls = text.match(/https?:\/\/[^\s<>"'“”‘’]+/gi) || [];
    const bareUrls = Array.from(text.matchAll(/(?:^|[\s（(])((?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"'“”‘’]+)/gi), (match) => `https://${match[1]}`);
    const candidates = Array.from(new Set([...fullUrls, ...bareUrls]));
    if (candidates.length > 1) throw new Error('检测到多个链接，请每次只粘贴一个视频的分享链接。');
    for (const candidate of candidates) {
      const trimmed = candidate.replace(/[，。；：！？、…）】》,.;!?)\]}]+$/, '');
      if (trimmed.length > 2048) continue;
      let parsed;
      try { parsed = new URL(trimmed); } catch { continue; }
      const host = parsed.hostname.toLowerCase();
      if (!['http:', 'https:'].includes(parsed.protocol) || !supportedHosts.has(host) || parsed.username || parsed.password || parsed.port) continue;
      parsed.protocol = 'https:';
      parsed.hash = '';
      if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) {
        parsed.pathname = parsed.pathname.replace(/\/(?:video|photo)\/\d+\/?$/, '');
        parsed.search = '';
      }
      return parsed.href;
    }
    throw new Error('没有找到支持的视频链接。请粘贴上方平台的视频分享链接，每次一个。');
  }

  function safeImage(value) {
    if (typeof value !== 'string') return null;
    try {
      const parsed = new URL(value, window.location.origin);
      if (parsed.username || parsed.password) return null;
      if (parsed.origin === location.origin && parsed.pathname.startsWith('/api/')) return parsed.href;
      if (parsed.protocol === 'https:' && !parsed.port && (imageHosts.has(parsed.hostname) || imageRoots.some((root) => parsed.hostname === root || parsed.hostname.endsWith(`.${root}`)))) return parsed.href;
    } catch { /* Unsupported image URL. */ }
    return null;
  }

  function safeDownload(value) {
    if (typeof value !== 'string') return null;
    try {
      const parsed = new URL(value, window.location.origin);
      return parsed.origin === window.location.origin && !parsed.username && !parsed.password && /^\/api\/download\/[A-Za-z0-9_-]{16,128}$/.test(parsed.pathname) ? parsed.href : null;
    } catch { return null; }
  }

  function durationText(value) {
    const total = Math.max(0, Math.floor(Number(value) || 0));
    if (!total) return '';
    const seconds = String(total % 60).padStart(2, '0');
    const minutes = Math.floor(total / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
  }

  function sizeText(value) {
    const size = Number(value);
    if (!Number.isFinite(size) || size <= 0) return '';
    return size >= 1073741824 ? `${(size / 1073741824).toFixed(1)} GB` : `${(size / 1048576).toFixed(1)} MB`;
  }

  function authorText(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return String(value.name || value.username || '');
    return '';
  }

  function imageElement(src, className, alt, fallback) {
    const safe = safeImage(src);
    if (!safe) return fallback;
    const image = create('img', className);
    image.src = safe;
    image.alt = alt;
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => { image.replaceWith(fallback); }, { once: true });
    return image;
  }

  function downloadIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  function watermarkText(format) {
    if (typeof format.watermarkLabel === 'string' && format.watermarkLabel.trim()) return format.watermarkLabel;
    return { none: '无平台水印', present: '含平台水印', source: '原始视频源', unknown: '水印状态未确认' }[format.watermark] || '水印状态未确认';
  }

  function cancelPreparations() {
    for (const task of state.preparations) {
      task.silent = true;
      task.controller.abort();
    }
  }

  function waitForPoll(signal) {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(new DOMException('Waiting canceled', 'AbortError'));
      };
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 1200);
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function preparationStatus(endpoint, method, signal) {
    const response = await fetch(endpoint, { method, signal, cache: 'no-store', headers: { Accept: 'application/json' } });
    let data;
    try { data = await response.json(); }
    catch (error) {
      if (signal.aborted) throw error;
      throw new Error('暂时无法读取下载准备状态，请重新尝试。');
    }
    if (!response.ok || !data || !data.success || data.status === 'failed') {
      throw new Error(data && typeof data.error === 'string' && data.error ? data.error : '视频准备失败，请重试下载；链接过期时请重新解析。');
    }
    if (!['ready', 'preparing'].includes(data.status)) throw new Error('下载准备状态异常，请重新尝试。');
    return data;
  }

  function createDownloadControls(formats, videoIndex, expiresAt) {
    const area = create('div', 'video-download-area');
    const controls = create('div', 'video-controls');
    const select = create('select', 'format-select');
    select.setAttribute('aria-label', `视频 ${videoIndex + 1} 的清晰度、水印与音轨规格`);
    formats.forEach((format, formatIndex) => {
      const label = String(format.label || (format.height ? `${format.height}p` : '原始规格'));
      const ext = typeof format.ext === 'string' ? format.ext.toUpperCase() : '';
      const size = sizeText(format.filesize);
      const pieces = [
        label,
        ext && !label.toUpperCase().includes(ext) ? ext : '',
        size ? `${format.filesizeApprox ? '约 ' : ''}${size}` : '',
        watermarkText(format),
        format.requiresMerge ? '需合并音轨' : format.hasAudio === false ? '无音轨' : '',
      ].filter(Boolean);
      const option = create('option', '', pieces.join(' · '));
      option.value = String(formatIndex);
      select.append(option);
    });
    const download = create('button', 'button button-primary download-button');
    download.type = 'button';
    const icon = downloadIcon();
    const buttonSpinner = create('span', 'button-spinner');
    buttonSpinner.setAttribute('aria-hidden', 'true');
    buttonSpinner.hidden = true;
    const buttonLabel = create('span', '', '下载视频');
    download.append(icon, buttonSpinner, buttonLabel);
    controls.append(select, download);

    const specStatus = create('div', 'format-status');
    const watermarkBadge = create('span', 'watermark-badge');
    const mergeBadge = create('span', 'merge-badge', '画面与音轨将自动合并');
    specStatus.append(watermarkBadge, mergeBadge);
    const feedback = create('p', 'video-feedback');
    feedback.setAttribute('role', 'status');
    feedback.hidden = true;
    const preparation = create('div', 'download-preparation');
    preparation.hidden = true;
    const progress = create('progress', 'download-progress');
    progress.max = 100;
    progress.setAttribute('aria-label', `视频 ${videoIndex + 1} 的下载准备进度`);
    const cancel = create('button', 'text-button cancel-download', '取消等待');
    cancel.type = 'button';
    preparation.append(progress, cancel);
    area.append(controls, specStatus, feedback, preparation);

    let running = null;
    function selectedFormat() { return formats[Number(select.value)] || formats[0]; }
    function updateSpecStatus() {
      const selected = selectedFormat();
      watermarkBadge.textContent = watermarkText(selected);
      watermarkBadge.className = `watermark-badge ${selected.watermark === 'none' ? 'watermark-clean' : selected.watermark === 'present' ? 'watermark-present' : 'watermark-neutral'}`;
      mergeBadge.hidden = !selected.requiresMerge;
    }
    function setFeedback(message) {
      if (feedback.textContent !== message) feedback.textContent = message;
      feedback.hidden = !message;
    }
    function setPreparing(busy) {
      download.disabled = busy;
      select.disabled = busy;
      buttonSpinner.hidden = !busy;
      icon.toggleAttribute('hidden', busy);
      preparation.hidden = !busy;
      download.setAttribute('aria-busy', busy ? 'true' : 'false');
      buttonLabel.textContent = busy ? '准备中…' : '下载视频';
    }
    updateSpecStatus();
    select.addEventListener('change', () => { updateSpecStatus(); setFeedback(''); buttonLabel.textContent = '下载视频'; });
    cancel.addEventListener('click', () => { if (running) running.controller.abort(); });

    download.addEventListener('click', async () => {
      if (running) return;
      if (expiresAt && Date.now() >= expiresAt) {
        setFeedback('下载链接已过期，请重新解析上方的视频链接。');
        toast('下载链接已过期，重新解析后即可继续。');
        return;
      }
      const downloadUrl = safeDownload(selectedFormat().downloadUrl);
      if (!downloadUrl) { setFeedback('下载地址无效，请重新解析视频。'); return; }
      const token = new URL(downloadUrl).pathname.split('/').pop();
      const endpoint = `/api/prepare/${encodeURIComponent(token)}`;
      const task = { controller: new AbortController(), silent: false, timedOut: false };
      running = task;
      state.preparations.add(task);
      const timer = setTimeout(() => { task.timedOut = true; task.controller.abort(); }, 10 * 60 * 1000);
      let failed = false;
      setPreparing(true);
      progress.removeAttribute('value');
      setFeedback('正在准备视频下载…');
      try {
        let response = await preparationStatus(endpoint, 'POST', task.controller.signal);
        while (true) {
          if (task.controller.signal.aborted) throw new DOMException('Waiting canceled', 'AbortError');
          if (response.status === 'ready') {
            const anchor = create('a');
            anchor.href = downloadUrl;
            anchor.setAttribute('download', '');
            anchor.hidden = true;
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            setFeedback('已请求保存视频，请在浏览器下载列表中确认进度。');
            break;
          }
          const stage = response.stage === 'downloading' ? '正在下载视频素材' : response.stage === 'merging' ? '正在合并画面和音轨' : '正在准备视频';
          const measuredProgress = typeof response.progress === 'number' && Number.isFinite(response.progress) ? Math.min(100, Math.max(0, response.progress)) : null;
          if (measuredProgress === null) progress.removeAttribute('value');
          else progress.value = measuredProgress;
          setFeedback(measuredProgress === null ? `${stage}…` : `${stage} · ${Math.round(measuredProgress)}%`);
          await waitForPoll(task.controller.signal);
          response = await preparationStatus(endpoint, 'GET', task.controller.signal);
        }
      } catch (error) {
        if (!task.silent) {
          if (task.timedOut) {
            setFeedback('等待已超过 10 分钟。视频可能仍在准备，请稍后点击下载重试。');
          } else if (task.controller.signal.aborted) {
            setFeedback('已取消页面等待。视频可能仍在准备中，再次点击下载可继续查看。');
          } else {
            failed = true;
            setFeedback(error instanceof TypeError ? '无法连接服务，请检查网络连接，然后重试下载。' : error.message || '视频准备失败，请重新尝试。');
          }
        }
      } finally {
        clearTimeout(timer);
        state.preparations.delete(task);
        if (running === task) running = null;
        setPreparing(false);
        if (failed) buttonLabel.textContent = '重试下载';
      }
    });
    return area;
  }

  function renderResults(data, sourceUrl) {
    const videos = Array.isArray(data.videos) ? data.videos : [];
    if (!videos.length) throw new Error('这个链接没有返回可下载的视频，请确认原视频可公开访问。');
    const expiresAt = data.expiresAt ? new Date(data.expiresAt).getTime() : null;
    const author = authorText(data.author);
    const platform = typeof data.platformLabel === 'string' ? data.platformLabel : platformNames[data.platform] || '';
    let canonicalUrl = sourceUrl;
    if (typeof data.sourceUrl === 'string') {
      try { canonicalUrl = normalizeUrl(data.sourceUrl); } catch { /* Keep the submitted supported URL. */ }
    }
    $('source-link').href = canonicalUrl;
    $('video-count').textContent = `${videos.length} 段`;
    $('result-platform').textContent = platform;
    $('result-platform').hidden = !platform;
    const provider = ['local', 'greenvideo'].includes(data.provider) ? data.providerLabel || providerNames[data.provider] : '';
    $('result-provider').textContent = provider;
    $('result-provider').hidden = !provider;
    $('result-summary').textContent = [author, typeof data.title === 'string' ? data.title : ''].filter(Boolean).join(' · ');
    cancelPreparations();
    const list = $('video-list');
    list.replaceChildren();
    videos.forEach((video, index) => {
      const card = create('article', 'video-card');
      const thumbnail = create('div', 'thumbnail-wrap');
      const placeholder = create('span', 'thumbnail-placeholder', '▶');
      placeholder.setAttribute('aria-hidden', 'true');
      thumbnail.append(imageElement(video.thumbnail || data.thumbnail, 'video-thumb', `视频 ${index + 1} 的封面`, placeholder));
      const duration = durationText(video.duration || data.duration);
      if (duration) thumbnail.append(create('span', 'duration-badge', duration));
      const copy = create('div', 'video-copy');
      copy.append(create('h3', '', video.title || data.title || `视频 ${index + 1}`));
      copy.append(create('p', 'video-meta', [videos.length > 1 ? `视频 ${index + 1} / ${videos.length}` : '公开视频', author, duration].filter(Boolean).join(' · ')));
      const formats = (Array.isArray(video.formats) ? video.formats : [])
        .filter((format) => format && safeDownload(format.downloadUrl))
        .sort((first, second) => Number(second.watermark === 'none') - Number(first.watermark === 'none'));
      if (!formats.length) {
        copy.append(create('p', 'no-formats', '这段视频暂时没有可下载的规格，请稍后重新解析。'));
      } else {
        copy.append(createDownloadControls(formats, index, expiresAt));
      }
      card.append(thumbnail, copy);
      list.append(card);
    });
    setView('results');
    $('app-announcement').textContent = `解析完成，找到 ${videos.length} 段视频。可以选择清晰度并下载。`;
    addHistory({ url: canonicalUrl, title: data.title || videos[0].title || `${platform || '公开'}视频`, author, platform, thumbnail: data.thumbnail || videos[0].thumbnail, timestamp: Date.now() });
  }

  async function parse() {
    if (state.controller) return;
    formMessage();
    let sourceUrl;
    try { sourceUrl = normalizeUrl(urlInput.value); }
    catch (error) { formMessage(error.message); urlInput.focus(); return; }
    urlInput.value = sourceUrl;
    cancelPreparations();
    setView('loading-state');
    const controller = new AbortController();
    state.controller = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 180000);
    try {
      const response = await fetch('/api/parse-video', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: sourceUrl, provider: providerSelect.value || 'local' }), signal: controller.signal,
      });
      let data;
      try { data = await response.json(); }
      catch { throw new Error('服务返回了无法读取的结果，请刷新页面后重试。'); }
      if (!response.ok || !data || !data.success) throw new Error(data && typeof data.error === 'string' && data.error ? data.error : '暂时无法解析这个视频，请稍后重试。');
      renderResults(data, sourceUrl);
    } catch (error) {
      if (controller.signal.aborted && !timedOut) {
        setView('empty-state');
        toast('已取消解析。');
      } else {
        $('error-detail').textContent = timedOut ? '等待时间有些长，请检查网络连接后重新尝试。' : error instanceof TypeError ? '无法连接服务，请稍后重试。' : error.message || '暂时无法解析，请稍后再试。';
        setView('error-state');
        $('app-announcement').textContent = `解析失败。${$('error-detail').textContent}`;
      }
    } finally {
      clearTimeout(timer);
      if (state.controller === controller) state.controller = null;
    }
  }

  function loadHistory() {
    try {
      const stored = JSON.parse(localStorage.getItem(historyKey) || '[]');
      state.history = Array.isArray(stored) ? stored.filter((item) => {
        if (!item || typeof item !== 'object' || typeof item.title !== 'string' || !Number.isFinite(item.timestamp)) return false;
        try { normalizeUrl(item.url); return true; } catch { return false; }
      }).slice(0, 8) : [];
    } catch { state.history = []; }
    renderHistory();
  }

  function saveHistory() {
    try { localStorage.setItem(historyKey, JSON.stringify(state.history)); }
    catch { toast('浏览器暂时无法保存历史记录，本次解析和下载不受影响。'); }
    renderHistory();
  }

  function addHistory(item) {
    state.history = [item, ...state.history.filter((existing) => existing.url !== item.url)].slice(0, 8);
    saveHistory();
  }

  function renderHistory() {
    $('history-empty').hidden = state.history.length > 0;
    $('clear-history').hidden = state.history.length === 0;
    const list = $('history-list');
    list.replaceChildren();
    state.history.forEach((item) => {
      const li = create('li', 'history-item');
      const button = create('button', 'history-button');
      button.type = 'button';
      button.title = `重新解析：${item.title}`;
      const placeholder = create('span', 'history-thumb history-thumb-placeholder', '▶');
      placeholder.setAttribute('aria-hidden', 'true');
      button.append(imageElement(item.thumbnail, 'history-thumb', '', placeholder));
      const copy = create('span', 'history-copy');
      copy.append(create('span', 'history-title', item.title));
      const date = new Date(item.timestamp);
      const stamp = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
      copy.append(create('span', 'history-time', [item.platform, stamp].filter(Boolean).join(' · ')));
      button.append(copy);
      button.addEventListener('click', () => {
        if (state.controller) { toast('当前视频正在解析，完成或取消后可以解析其他链接。'); return; }
        urlInput.value = item.url;
        formMessage();
        parse();
        form.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      });
      li.append(button);
      list.append(li);
    });
  }

  async function health() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('/api/health', { signal: controller.signal, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error('not-ready');
      $('runtime-mode').textContent = data.deploymentMode === 'online' ? '在线服务' : '本机运行';
      const notices = [];
      if (data.extractor && data.extractor.available === false) notices.push('视频解析组件暂不可用，请稍后重试。');
      if (data.ffmpeg && data.ffmpeg.available === false) notices.push('音视频合并暂不可用；无需合并的规格仍可下载。');
      $('health-notice').textContent = notices.join(' ');
      $('health-notice').hidden = notices.length === 0;
    } catch {
      $('health-notice').textContent = '暂时无法连接服务，请稍后刷新页面重试。';
      $('health-notice').hidden = false;
    } finally { clearTimeout(timer); }
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); parse(); });
  providerSelect.addEventListener('change', updateProviderHelp);
  urlInput.addEventListener('input', () => { if (!$('form-message').hidden) formMessage(); });
  urlInput.addEventListener('paste', (event) => {
    if (urlInput.readOnly) return;
    const text = event.clipboardData && event.clipboardData.getData('text');
    if (text && /[\r\n]/.test(text)) {
      event.preventDefault();
      urlInput.setRangeText(text.replace(/\s+/g, ' ').slice(0, 8192), urlInput.selectionStart, urlInput.selectionEnd, 'end');
      formMessage();
    }
  });
  $('retry-button').addEventListener('click', () => { parse(); });
  $('cancel-button').addEventListener('click', () => { if (state.controller) state.controller.abort(); });
  $('clear-history').addEventListener('click', () => { state.history = []; saveHistory(); toast('最近解析记录已清空。'); });
  pasteButton.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('unavailable');
      const text = await navigator.clipboard.readText();
      if (!text.trim()) { toast('剪贴板里还没有链接，请先复制一个视频分享链接。'); return; }
      urlInput.value = text.trim().replace(/\s+/g, ' ').slice(0, 8192);
      formMessage();
      urlInput.focus();
    } catch {
      urlInput.focus();
      toast('浏览器未允许读取剪贴板。请在输入框中按 Ctrl+V，或长按后选择粘贴。');
    }
  });
  window.addEventListener('storage', (event) => { if (event.key === historyKey) loadHistory(); });
  window.addEventListener('pagehide', cancelPreparations);
  loadPlatformCatalog();
  health();
})();
