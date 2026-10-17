// ==UserScript==
// @name         BiliMusic - B站纯音频播放器
// @namespace    https://github.com/
// @version      0.1.0
// @description  清空 B站页面，只留一个极简音频播放器：搜索、播放、音量/进度/循环、合集上下曲，屏蔽视频与登录弹窗
// @author       you
// @match        https://www.bilibili.com/*
// @match        https://bilibili.com/*
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/* ------------------------------------------------------------------
 *  原理速览（探测 B站后确认）
 *  1) 搜索  : GET api.bilibili.com/x/web-interface/search/type   —— 无需 wbi 签名
 *  2) 播放流: GET api.bilibili.com/x/player/playurl 的 dash.audio[] —— 纯音频，不下载视频流
 *  3) 播放器: MediaSource(MSE) 手动喂 dash 音频分片，纯音频、不碰视频流
 *  4) 合集  : GET api.bilibili.com/x/web-interface/view 的 pages[](分P) / ugc_season[](合集)
 *  5) 音量  : 音频元素音量（页面内音量），与系统音量无关 ✔
 *  6) 弹窗  : MutationObserver 秒杀 .bili-mini-mask，并从源头阻止 body 滚动锁
 * ------------------------------------------------------------------ */

(function () {
  'use strict';

  /* ========================= 配置 ========================= */
  const API = 'https://api.bilibili.com';
  const STORE = 'biliMusic.v1';

  // 常用音质：30280=192K, 30232=132K, 30216=64K
  const AUDIO_Q = [30280, 30232, 30216];

  /* ========================= 工具 ========================= */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /** 毫秒 -> m:ss / h:mm:ss */
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }

  /** "4:31" / "222:28" -> 秒 */
  function parseDur(str) {
    if (typeof str === 'number') return str;
    if (!str) return 0;
    const p = String(str).split(':').map(Number).filter((n) => !isNaN(n));
    return p.reduce((a, b) => a * 60 + b, 0);
  }

  /** 去掉搜索结果里的 <em class="keyword"> 高亮标签 与 HTML 实体 */
  function plainTitle(html) {
    if (!html) return '';
    const d = document.createElement('textarea');
    d.innerHTML = String(html).replace(/<[^>]+>/g, '');
    return d.value.trim();
  }

  function toast(msg, ms = 2200) {
    const el = $('#bm-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('on'), ms);
  }

  /** 统一修正 URL 协议：// 和 http:// 都转成 https://（B站接口会混着返回） */
  function fixUrl(u) {
    if (!u) return '';
    u = String(u).trim();
    if (u.startsWith('//')) return 'https:' + u;
    if (u.startsWith('http://')) return 'https://' + u.slice(7);
    return u;
  }

  const kw = (s) => encodeURIComponent(s);

  /** 拼接「专辑 - 曲目」标题，避免两段重复或包含关系 */
  function joinTitle(album, part) {
    album = (album || '').trim();
    part = (part || '').trim();
    if (!album) return part;
    if (!part) return album;
    if (album === part || album.includes(part)) return album;
    if (part.includes(album)) return part;
    return album + ' — ' + part;
  }

  /* ========================= 全局状态 ========================= */
  const state = {
    list: [],        // 搜索结果
    idx: -1,         // 当前在播放列表中的下标
    playing: false,
    current: null,   // 当前曲目 {bvid, aid, cid, title, author}
    parts: [],       // 当前视频的分P / 合集列表
    partIdx: -1,
    albumTitle: '',  // 当前专辑/视频标题
    quality: 0,
    codecs: '',
    // —— 搜索结果分页 ——
    keyword: '',     // 当前搜索词
    page: 0,         // 已加载到第几页
    total: 0,        // 接口报的总条数
    loadingMore: false,
    noMore: false,
  };

  /* ========================= 1. 屏蔽层 =========================
   *  在任何 UI 之前先跑，保证从 document-start 起 B站页面就“不存在”
   * =========================================================== */

  // 1.1 掐死 popstate / 滚动锁，避免 B站路由把页面拉回去
  // 注意：B站元素大多嵌在 #app 内部，不是 body 直接子元素，
  // 所以必须隐藏 body 的所有兄弟节点（含 #app 整个 SPA），而不仅是直接子元素。
  const css = document.createElement('style');
  css.id = 'bm-kill-css';
  css.textContent = `
    html, body { background:#0f1115 !important; }
    html { overflow: hidden !important; }
    body > *:not(#bm-root):not(#bm-toast):not(#bm-audio-host):not(script):not(style):not(link) { display: none !important; }
    #app, .app-v1, .bili-header, #bilibili-player, .bpx-player-container,
    .bili-mini-mask, .login-panel-popover, .browser-tip { display: none !important; }
    #bm-root { display: block !important; }
    #bm-audio-host { display: block !important; }
  `;

  // 1.2 登录弹窗猎杀
  const POPUP_SEL = [
    '.bili-mini-mask', '.bili-mini-login', '.bili-mini', '.login-scan-box',
    '.bili-login', '#login-tip', '.login-panel-popover', '.bili-account-mask',
  ].join(',');

  function killPopups() {
    let hit = false;
    $$(POPUP_SEL).forEach((el) => {
      if (el.closest('#bm-root')) return; // 别误杀自己
      el.remove();
      hit = true;
    });
    return hit;
  }

  const obs = new MutationObserver(() => {
    if (killPopups()) document.body && document.body.style.removeProperty('overflow');
  });

  /**
   * 等 document.documentElement 出现再动手。
   *
   * 在 document-start 阶段（WebView2 的 AddScriptToExecuteOnDocumentCreated、
   * 或 Playwright 的 addInitScript）注入时，文档元素可能还没建出来，
   * 此时 document.documentElement 是 null，直接 appendChild 会抛异常，
   * 导致整个脚本中断（接口、UI 全都不会出现）。
   */
  function whenDocumentRoot(fn) {
    if (document.documentElement) return fn();
    const timer = setInterval(() => {
      if (document.documentElement) {
        clearInterval(timer);
        fn();
      }
    }, 1);
  }

  function startFirewall() {
    whenDocumentRoot(() => {
      document.documentElement.appendChild(css);
      obs.observe(document.documentElement, { childList: true, subtree: true });
      killPopups();

      // Esc / 定时兜底：B站会用 setTimeout 延迟弹
      setInterval(killPopups, 800);

      // B站弹窗时会给 body 加 overflow:hidden + padding-right，实时反弹
      new MutationObserver(() => {
        const b = document.body;
        if (b && b.style.overflow === 'hidden' && !$('.bili-mini-mask')) {
          b.style.removeProperty('overflow');
          b.style.removeProperty('padding-right');
        }
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'], subtree: true });
    });
  }

  /* ========================= 2. 网络层 ========================= */
  async function api(path, params = {}) {
    const q = new URLSearchParams(params).toString();
    const r = await fetch(`${API}${path}${q ? '?' + q : ''}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j.code !== 0) throw new Error(j.message || ('code ' + j.code));
    return j.data;
  }

  /**
   * 搜索视频。
   * B站的搜索接口就是一页一页给的：page_size 最大 50，page 上限 50。
   * 所以这里一次拉 50 条，剩下的交给「滚到底自动加载下一页」。
   */
  async function searchVideos(keyword, page = 1) {
    const d = await api('/x/web-interface/search/type', {
      search_type: 'video', keyword, page, page_size: 50,
    });
    return {
      total: d.numResults || 0,
      page: d.page || page,
      items: (d.result || []).map((it) => ({
        bvid: it.bvid,
        aid: it.aid,
        title: plainTitle(it.title),
        author: it.author,
        duration: parseDur(it.duration),
        durText: it.duration,
        pic: fixUrl(it.pic),
        tag: it.tag,
      })),
    };
  }

  /** 取详情：分P + 合集 */
  async function getDetail(bvid) {
    const d = await api('/x/web-interface/view', { bvid });
    const parts = [];

    // 合集优先（ugc_season）
    if (d.ugc_season && d.ugc_season.sections) {
      d.ugc_season.sections.forEach((sec) => {
        (sec.episodes || []).forEach((ep) => {
          parts.push({
            bvid: ep.bvid, aid: ep.aid, cid: ep.cid,
            title: ep.title || ep.long_title || '',
            duration: ep.arc ? ep.arc.duration : 0,
          });
        });
      });
    }
    // 分P
    if (!parts.length && d.pages && d.pages.length) {
      d.pages.forEach((p) => parts.push({
        bvid: d.bvid, aid: d.aid, cid: p.cid,
        title: p.part, duration: p.duration, page: p.page,
      }));
    }
    // 单视频也塞一条，方便统一处理
    if (!parts.length) {
      parts.push({
        bvid: d.bvid, aid: d.aid, cid: d.cid,
        title: d.title, duration: d.duration,
      });
    }

    return {
      bvid: d.bvid, aid: d.aid, cid: d.cid,
      title: d.title, author: d.owner ? d.owner.name : '',
      pic: fixUrl(d.pic),
      duration: d.duration,
      parts,
      isCollection: parts.length > 1,
      seasonTitle: d.ugc_season ? d.ugc_season.title : '',
    };
  }

  /** 取纯音频流地址 */
  async function getAudioUrl(bvid, cid) {
    const d = await api('/x/player/playurl', {
      bvid, cid, fnval: 16, fourk: 1, fnver: 0, platform: 'pc',
    });
    const dash = d.dash;
    if (!dash || !dash.audio || !dash.audio.length) throw new Error('该视频没有音频流');

    // 按偏好挑档（30280=192K，30232=132K，30216=64K）
    let pick = null;
    for (const q of AUDIO_Q) {
      pick = dash.audio.find((a) => a.id === q);
      if (pick) break;
    }
    if (!pick) pick = dash.audio[dash.audio.length - 1];

    const urls = [pick.baseUrl || pick.base_url, ...(pick.backupUrl || pick.backup_url || [])];
    // codecs 很重要：30280/30232 是 mp4a.40.2，30216 是 mp4a.40.5，
    // 用错的 MIME 建 SourceBuffer 会导致 append 成功但无法解码
    return {
      urls: urls.filter(Boolean),
      quality: pick.id,
      bandwidth: pick.bandwidth,
      mimeType: pick.mimeType || 'audio/mp4',
      codecs: pick.codecs || 'mp4a.40.2',
    };
  }

  /* ========================= 3. 音频引擎 =========================
   *  踩坑记录（已在真实页面验证）：
   *  ✗ <audio src=dash音频URL>        -> ERR_ABORTED / error 4
   *                                      B站的 mcdn P2P 节点会让原生元素直接放弃
   *  ✗ crossOrigin='anonymous'        -> 更糟，直接 DEMUXER_ERROR
   *  ✓ MediaSource + 手动 fetch 喂流  -> 稳定可用（下方实现）
   *  MSE 探测：MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.5"') === true
   * ============================================================= */
  const AUDIO_FALLBACK_CODEC = 'audio/mp4;codecs="mp4a.40.5"';
  /**
   * B站播放器自己用的 MIME 就是 'audio/mp4;codecs="mp4a.40.5"'
   * （无空格！且不管接口标的 40.2 还是 40.5 都用 40.5，实测与 B站一致才最稳）
   */
  const MSE_MIME = AUDIO_FALLBACK_CODEC;
  /**
   * ★ 只判断「有没有 MediaSource」，不要拿 isTypeSupported 当门槛。
   * Android WebView 对 AAC 的 isTypeSupported 经常误报 false，
   * 但真正 addSourceBuffer 时反而能成功——以它为准会把 MSE 这条路直接掐掉。
   */
  const MSE_OK = typeof MediaSource !== 'undefined';

  /**
   * 环境下能力自检：
   * 有些浏览器（如 VS Code 内嵌的 Code-OSS Electron）虽然
   * MediaSource.isTypeSupported 和 mediaCapabilities.decodingInfo
   * 都报「支持」，但实际上根本没编译 AAC 解码器，
   * 表现为 play() 抛 NotSupportedError / decodeAudioData 报 EncodingError。
   * 用一段真实 AAC 数据试探最靠谱。
   */
  async function probeAacSupport() {
    try {
      // 用 0.1 秒静音 AAC 帧探测（避免真的下东西）
      const r = await fetch('https://api.bilibili.com/x/player/playurl?bvid=BV1GJ411x7h7&cid=137649199&fnval=16', { credentials: 'omit' });
      const j = await r.json();
      if (j.code !== 0 || !j.data.dash.audio.length) return null;
      const u = j.data.dash.audio[0].baseUrl || j.data.dash.audio[0].base_url;
      const res = await fetch(u, { credentials: 'omit', headers: { Range: 'bytes=0-65535' } });
      const buf = await res.arrayBuffer();
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      await ctx.decodeAudioData(buf);
      ctx.close();
      return true;
    } catch (e) {
      console.warn('[BiliMusic] AAC 自检失败：', e.name, e.message);
      return false;
    }
  }

  /** 音量的「主值」（audio 元素会被替换，音量必须独立保存） */
  let _vol = 0.8;
  let _muted = false;
  /** 当前 MSE 会话 */
  let mse = null;   // { ms, sb, ac, url }
  /** 承载 audio 的隐藏容器（挂进 DOM 能提高自动播放通过率） */
  let audioHost = null;
  /** 音频元素（会被 swapAudio 替换） */
  let audio = newAudio();

  function mountAudio(a) {
    if (!document.body) return;
    if (!audioHost) {
      audioHost = document.createElement('div');
      audioHost.id = 'bm-audio-host';
      audioHost.style.cssText =
        'position:fixed;left:0;bottom:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1';
      document.body.appendChild(audioHost);
    }
    audioHost.appendChild(a);
  }

  function newAudio() {
    const a = new Audio();
    a.preload = 'auto';
    a.setAttribute('playsinline', '');
    a.volume = 0.8;
    bindAudioEvents(a);
    mountAudio(a);
    return a;
  }

  /** 切歌前调用：丢掉旧元素，换一个干净的 Audio 对象 */
  function swapAudio() {
    const old = audio;
    try { old.pause(); old.removeAttribute('src'); } catch (e) {}
    const a = newAudio();
    a.volume = _vol;
    a.muted = _muted;
    audio = a;
    return a;
  }

  function teardownMse() {
    if (!mse) return;
    try { mse.ac && mse.ac.abort(); } catch (e) {}
    try { mse.sb && mse.ms.removeSourceBuffer(mse.sb); } catch (e) {}
    try { mse.url && URL.revokeObjectURL(mse.url); } catch (e) {}
    mse = null;
  }

  /** 单段 append 上限（避免 QuotaExceededError） */
  const APPEND_CHUNK = 512 * 1024;
  /** 首次预取量：要小！下载太久会让「用户手势」过期，play() 就会被拒 */
  const PRELOAD = 384 * 1024;
  /**
   * 单条线路取数据的超时。
   * B站会按 UA 返回不同 CDN：桌面 UA 走 edge.mountaintoys.cn:4483，
   * 移动 UA 走 mcdn.bilivideo.cn:8082 —— 都是非标准端口的 P2P 节点，
   * 在某些网络或模拟器下会挂住不返回。不自己超时的话，状态栏会永远停在「加载中…」。
   */
  const PREFETCH_TIMEOUT = 9000;

  /**
   * 用 MSE 播放 B站 dash 音频。
   *
   * 血泪教训（全部在真实页面复现验证过）：
   *  1) 直接给 <audio>/<video> 设 dash 的 .m4s URL 或它的 Blob 都会失败：
   *       DEMUXER_ERROR_NO_SUPPORTED_STREAMS / error 4
   *     Chrome 的解复用器不认 B站这种 fMP4（iso5 brand + 分片），只有 MSE 能处理。
   *  2) SourceBuffer 的 MIME 必须用接口返回的真实 codecs：
   *       30280/30232 -> mp4a.40.2，30216 -> mp4a.40.5
   *  3) **play() 之前绝不能 endOfStream()**，否则 play() 直接报
   *       NotSupportedError: Failed to load because no supported source was found
   *     即使 buffered/duration 都已正常解析出来也会失败。
   *  4) 首次预取要小（< 500KB）：等太久会让用户手势过期，play() 同样被拒。
   *  5) 不能用 sb.mode='sequence'（append 成功但无声）。
   *  6) 同一个 Audio 元素「play 完再换 MediaSource」会 detach，故用 swapAudio()。
   */
  /**
   * 是否运行在 Android WebView 里。
   * 注意不能只看 navigator.userAgent —— 安卓外壳会把 UA 伪装成桌面 Chrome，
   * 但 userAgentData.platform 仍然是 'Android'（桌面用户手动改 UA 也能被正确识别）。
   */
  const IS_ANDROID = (() => {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) ||
      navigator.platform || '';
    return /android/i.test(p) || /android/i.test(navigator.userAgent || '');
  })();

  /**
   * 候选 MIME。
   * ★ 两端的正确取值是相反的，别乱调顺序：
   *   - 桌面 WebView2/Chrome：API 报 mp4a.40.2，但必须用 **40.5** 建 SourceBuffer，
   *     否则 append 不报错却解不出声（实测过）
   *   - Android WebView：反过来，用接口给的真实 codecs 才行
   */
  function mimeCandidates(codecs) {
    const real = codecs ? 'audio/mp4;codecs="' + codecs + '"' : null;
    const list = IS_ANDROID
      ? [real, MSE_MIME, 'audio/mp4;codecs="mp4a.40.2"', 'audio/mp4']
      : [MSE_MIME, real, 'audio/mp4;codecs="mp4a.40.2"', 'audio/mp4'];
    return list.filter((m, i) => m && list.indexOf(m) === i);
  }

  async function playViaMse(urls, codecs) {
    if (typeof MediaSource === 'undefined') throw new Error('浏览器没有 MediaSource');
    // ① 先取数据（此时还没有 MediaSource，慢一点也不会 detach）
    const pre = await prefetch(urls);
    if (!pre) throw new Error('取音频数据失败（' + (_prefetchErr || '所有线路均不可用') + '）');

    // ② 建 MSE 并灌入预取数据
    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    const ac = pre.ac;
    mse = { ms, sb: null, ac, url };
    audio.src = url;

    await new Promise((r) => {
      if (ms.readyState === 'open') return r();
      ms.addEventListener('sourceopen', r, { once: true });
    });
    if (ms.readyState !== 'open') throw new Error('MediaSource 未能打开');

    // 依次试候选 MIME：不同 WebView 认的写法不一样（带空格 / 不带 / 40.2 还是 40.5）
    let sb = null;
    let lastErr = null;
    for (const mime of mimeCandidates(codecs)) {
      try { sb = ms.addSourceBuffer(mime); break; }
      catch (e) {
        lastErr = e;
        console.warn('[BiliMusic] addSourceBuffer 失败：' + mime + ' → ' + e.name + ' ' + e.message);
      }
    }
    if (!sb) {
      throw new Error('addSourceBuffer 全部失败：' + (lastErr ? lastErr.name : '未知') +
        (lastErr && lastErr.message ? '（' + lastErr.message + '）' : ''));
    }
    mse.sb = sb;

    for (const c of pre.chunks) await appendChunk(sb, c);

    // ③ 开播（不要 endOfStream！），最多重试 3 次
    let played = false;
    for (let i = 0; i < 3 && !played; i++) {
      try { await audio.play(); played = true; }
      catch (e) {
        if (i === 2) {
          teardownMse();
          if (e.name === 'NotSupportedError') {
            throw new Error('当前浏览器无法解码 AAC 音频（缺解码器）。请用正式版 Chrome / Edge 打开。');
          }
          throw new Error('play() 被拒：' + e.name + ' ' + e.message);
        }
        await new Promise((r) => setTimeout(r, 350));
      }
    }

    state.playing = true;
    updateUI();
    setStatus('');
    startHeartbeat();

    // ④ 后台继续灌剩余数据，全灌完才 endOfStream
    if (pre.reader) drainRest(pre.reader, sb, ms, ac);
    else if (pre.rest.length) drainRestFromArray(pre.rest, sb, ms);
  }

  /** 上一次 prefetch 失败的原因（拼进错误提示，否则永远只看到一句「全部线路失败」） */
  let _prefetchErr = '';

  /** 预取一小块，返回 { chunks, rest, reader, ac } */
  async function prefetch(urls) {
    const errs = [];
    for (const u of urls) {
      const ac = new AbortController();
      let timedOut = false;
      // 非标准端口的 P2P 节点可能一直不返回，必须自己超时
      const tk = setTimeout(() => { timedOut = true; try { ac.abort(); } catch (e) {} }, PREFETCH_TIMEOUT);
      try {
        const res = await fetch(u, { credentials: 'omit', signal: ac.signal });
        if (!res.ok) { errs.push('HTTP ' + res.status); continue; }
        if (!res.body) { errs.push('浏览器不支持流式读取'); continue; }
        const reader = res.body.getReader();

        const chunks = [];
        let n = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return { chunks: mergeForAppend(chunks), rest: [], reader: null, ac };
          chunks.push(value);
          n += value.length;
          if (n >= PRELOAD) return { chunks: mergeForAppend(chunks), rest: [], reader, ac };
        }
      } catch (e) {
        const why = timedOut ? '连接超时(' + (PREFETCH_TIMEOUT / 1000) + 's)' : ((e && e.message) || String(e));
        errs.push(why);
        console.warn('[BiliMusic] 线路不可用：' + u.slice(0, 80) + ' → ' + why);
        try { ac.abort(); } catch (err) {}
        continue;
      } finally {
        clearTimeout(tk);
      }
    }
    _prefetchErr = errs.length ? errs[0] : '接口没有给出可用地址';
    return null;
  }

  /** 把小分片合并成 ~512KB 的大块，减少 appendBuffer 次数 */
  function mergeForAppend(chunks) {
    const out = [];
    let cur = new Uint8Array(0);
    for (const c of chunks) {
      const merged = new Uint8Array(cur.length + c.length);
      merged.set(cur, 0);
      merged.set(c, cur.length);
      cur = merged;
      if (cur.length >= APPEND_CHUNK) { out.push(cur); cur = new Uint8Array(0); }
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /** 剩余分片持续追加（后台，不阻塞 UI） */
  async function drainRest(reader, sb, ms, ac) {
    if (!reader) return;
    let buf = [];
    let n = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf.push(value);
        n += value.length;
        // 攒够 512KB 再 append，减少次数
        if (n >= APPEND_CHUNK) {
          for (const c of mergeForAppend(buf)) await appendChunk(sb, c);
          buf = []; n = 0;
        }
        // 缓冲快满时，等播放消费掉一点再继续
        if (sb.buffered.length && sb.buffered.end(sb.buffered.length - 1) - audio.currentTime > 90) {
          await waitCanAppend(sb, audio);
        }
      }
      for (const c of mergeForAppend(buf)) await appendChunk(sb, c);
      if (ms.readyState === 'open') { try { ms.endOfStream(); } catch (e) {} }
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('[BiliMusic] 数据流中断：', e.message);
    }
  }

  /** 已全部下载完的情况下，把剩余块依次 append（后台） */
  async function drainRestFromArray(rest, sb, ms) {
    try {
      for (const c of rest) await appendChunk(sb, c);
      if (ms.readyState === 'open') { try { ms.endOfStream(); } catch (e) {} }
    } catch (e) {
      console.warn('[BiliMusic] 追加失败：', e.message);
    }
  }

  /** 缓冲太满时，等播放推进后再 append */
  function waitCanAppend(sb, a) {
    return new Promise((resolve) => {
      const tick = () => {
        if (!sb.buffered.length) return resolve();
        const ahead = sb.buffered.end(sb.buffered.length - 1) - a.currentTime;
        if (ahead < 60 || a.ended) return resolve();
        setTimeout(tick, 1500);
      };
      setTimeout(tick, 1500);
    });
  }

  /** 把分片塞进 SourceBuffer（等待上一次 append 完成） */
  function appendChunk(sb, chunk) {
    return new Promise((resolve, reject) => {
      const doAppend = () => {
        try { sb.appendBuffer(chunk); } catch (e) { return reject(e); }
        const onEnd = () => { sb.removeEventListener('updateend', onEnd); resolve(); };
        sb.addEventListener('updateend', onEnd);
      };
      try {
        if (sb.updating) {
          sb.addEventListener('updateend', function once() {
            sb.removeEventListener('updateend', once);
            doAppend();
          });
        } else doAppend();
      } catch (e) { reject(e); }
    });
  }

  /**
   * 统一的 play() 包装：永远接住 rejection。
   * 否则在源不受支持 / 自动播放被拒时，控制台会飘出未处理的 Promise 错误。
   */
  function safePlay() {
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch((e) => {
        if (e && e.name !== 'AbortError') {
          console.warn('[BiliMusic] play() 被拒：', e.name, e.message);
        }
      });
    }
    return p;
  }

  function setVol(v) {
    _vol = Math.max(0, Math.min(1, v));
    audio.volume = _vol;
    persist();
    updateVolUI();
  }

  let urlTry = 0;
  async function loadAndPlay(item) {
    if (!item) return;
    try {
      setStatus('加载中…');
      teardownMse();
      swapAudio();                    // 换一个干净的 Audio 元素，避免异步 load 竞态
      state.current = item;
      const { urls, quality, codecs } = await getAudioUrl(item.bvid, item.cid);
      urlTry = 0;
      state.quality = quality;
      state.codecs = codecs;
      await playUrls(urls, codecs);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      setStatus('加载失败：' + e.message);
      toast('播放失败：' + e.message);
    }
  }

  async function playUrls(urls, codecs) {
    if (!urls || !urls.length) { setStatus('没有可用音频线路'); return; }

    if (MSE_OK) {
      try {
        await playViaMse(urls, codecs);
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
        console.warn('[BiliMusic] MSE 失败，退回原生播放：', e.name, e.message);
        const cause = e.message || e.name;
        setStatus('MSE 失败：' + cause + ' → 尝试直连…');
        teardownMse();
        swapAudio();
        nativePlay(urls, 0, cause);
        return;
      }
    }
    // 兜底：原生 <audio src>
    nativePlay(urls, 0, '当前 WebView 不支持 MediaSource');
  }

  /**
   * 兜底：直接给 <audio> 设 dash 地址。
   * 桌面端基本不会成功（B站这种 fMP4 只有 MSE 能吃），留着只是多一条路。
   * ★ cause 必须带下来：否则两条路都失败时用户只看到「全部线路失败」，
   *   完全不知道 MSE 阶段到底报了什么，没法排查。
   */
  function nativePlay(urls, i, cause) {
    if (i >= urls.length) {
      const msg = cause ? '播放失败：' + cause : '所有线路均不可用';
      setStatus(msg);
      toast(msg, 6000);
      return;
    }
    const a = audio;
    a.src = urls[i];
    a.load();
    a.play().then(() => {
      state.playing = true;
      updateUI();
      setStatus('');
      startHeartbeat();
    }).catch(() => nativePlay(urls, i + 1, cause));
  }

  /* ---- 播放进度心跳（未登录会静默失败，无妨） ---- */
  let hbTimer = null;
  function startHeartbeat() {
    stopHeartbeat();
    hbTimer = setInterval(() => {
      if (!state.current || audio.paused) return;
      const csrf = (document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/) || [])[1] || '';
      const body = new URLSearchParams({
        bvid: state.current.bvid,
        cid: state.current.cid,
        played_time: String(Math.floor(audio.currentTime)),
        realtime: '2',
        type: '3',
        play_type: '0',
      });
      body.set('csrf', csrf); // 未登录 csrf 为空 -> 服务端返回未登录，不影响播放
      fetch(`${API}/x/player/heartbeat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }).catch(() => {});
    }, 15000);
  }
  function stopHeartbeat() { if (hbTimer) clearInterval(hbTimer); hbTimer = null; }

  /* ---- 音频事件（每个 Audio 元素都要绑一次） ---- */
  function bindAudioEvents(a) {
    a.addEventListener('timeupdate', () => {
      const d = a.duration || 0;
      if (d > 0 && isFinite(d)) {
        seekBar.value = String((a.currentTime / d) * 1000);
        paintProgress();
      }
      timeNow.textContent = fmt(a.currentTime);
      // 安卓通知栏：进度低频同步（Android 14 的通知会展示进度条）
      if (a === audio && Date.now() - _lastPosPush > 4000) {
        _lastPosPush = Date.now();
        notifyNative(true);
      }
    });
    a.addEventListener('loadedmetadata', () => {
      if (isFinite(a.duration)) timeTotal.textContent = fmt(a.duration);
      updateUI();
    });
    a.addEventListener('durationchange', () => {
      if (isFinite(a.duration)) timeTotal.textContent = fmt(a.duration);
    });
    a.addEventListener('play', () => { state.playing = true; updateUI(); });
    a.addEventListener('pause', () => { state.playing = false; updateUI(); });
    a.addEventListener('ended', () => {
      if (loopOne) { a.currentTime = 0; a.play().catch(() => {}); return; }
      playNext(true);
    });
    a.addEventListener('error', () => {
      // MSE 场景下 error 可能来自正在被替换的旧元素，忽略
      if (a === audio && a.src && !a.src.startsWith('blob:') && a.error) {
        setStatus('音频流出错（' + a.error.code + '），尝试备用线路…');
      }
    });
    a.addEventListener('volumechange', () => { if (a === audio) updateVolUI(); });
  }

  /* ========================= 4. UI ========================= */
  const root = document.createElement('div');
  root.id = 'bm-root';
  root.innerHTML = `
    <div class="bm-wrap">
      <header class="bm-head">
        <div class="bm-logo"><span>♪</span> BiliMusic</div>
        <form class="bm-search" id="bm-form">
          <input id="bm-input" type="search" placeholder="搜索歌曲 / 歌手 / 关键词，回车搜索" autocomplete="off" spellcheck="false" />
          <button type="submit" title="搜索">搜索</button>
        </form>
      </header>

      <main class="bm-body">
        <section class="bm-panel" id="bm-results">
          <div class="bm-panel-hd">
            <span>搜索结果</span>
            <em id="bm-count"></em>
          </div>
          <ul class="bm-list" id="bm-list"></ul>
        </section>

        <section class="bm-panel" id="bm-queue">
          <div class="bm-panel-hd">
            <span id="bm-queue-title">播放队列</span>
            <button type="button" id="bm-queue-toggle" class="bm-mini">收起</button>
          </div>
          <ul class="bm-list" id="bm-queue-list"></ul>
        </section>
      </main>

      <footer class="bm-player" id="bm-player">
        <div class="bm-cover" id="bm-cover">
          <div class="bm-cover-ph">♪</div>
        </div>

        <div class="bm-meta">
          <div class="bm-title" id="bm-title" title="">未在播放</div>
          <div class="bm-sub" id="bm-sub">搜索一首歌开始吧</div>
        </div>

        <div class="bm-ctrl">
          <button class="bm-btn" id="bm-prev" title="上一曲（合集/分P）" disabled>
            <svg viewBox="0 0 24 24"><path d="M7 6v12M20 6l-9 6 9 6z"/></svg>
          </button>
          <button class="bm-btn bm-btn-main" id="bm-toggle" title="播放 / 暂停">
            <svg id="bm-icon-play" viewBox="0 0 24 24"><path d="M8 5l12 7-12 7z"/></svg>
            <svg id="bm-icon-pause" viewBox="0 0 24 24" style="display:none"><path d="M8 5h3v14H8zM13 5h3v14h-3z"/></svg>
          </button>
          <button class="bm-btn" id="bm-next" title="下一曲（合集/分P）" disabled>
            <svg viewBox="0 0 24 24"><path d="M17 6v12M4 6l9 6-9 6z"/></svg>
          </button>
        </div>

        <div class="bm-progress">
          <span class="bm-time" id="bm-time-now">0:00</span>
          <div class="bm-bar" id="bm-bar">
            <div class="bm-bar-fill" id="bm-bar-fill"></div>
            <div class="bm-bar-knob" id="bm-bar-knob"></div>
            <input type="range" id="bm-seek" min="0" max="1000" value="0" step="1" />
          </div>
          <span class="bm-time" id="bm-time-total">0:00</span>
        </div>

        <div class="bm-right">
          <button class="bm-btn bm-btn-sm" id="bm-loop" title="单曲循环">
            <svg viewBox="0 0 24 24"><path d="M17 2l4 4-4 4M7 22l-4-4 4-4M3 6h14a4 4 0 014 4M21 18H7a4 4 0 01-4-4"/></svg>
          </button>
          <button class="bm-btn bm-btn-sm" id="bm-vol-btn" title="静音 / 恢复">
            <svg id="bm-icon-vol" viewBox="0 0 24 24"><path d="M11 5L6 9H3v6h3l5 4zM16 8a5 5 0 010 8"/></svg>
            <svg id="bm-icon-mute" viewBox="0 0 24 24" style="display:none"><path d="M11 5L6 9H3v6h3l5 4zM16 9l5 6M21 9l-5 6"/></svg>
          </button>
          <div class="bm-vbar" id="bm-vbar">
            <div class="bm-bar-fill" id="bm-vol-fill"></div>
            <input type="range" id="bm-vol" min="0" max="100" value="80" step="1" />
          </div>
          <span class="bm-vol-num" id="bm-vol-num">80</span>
        </div>

        <div class="bm-status" id="bm-status"></div>
      </footer>
    </div>
  `;

  const seekBar = $('#bm-seek', root);
  const timeNow = $('#bm-time-now', root);
  const timeTotal = $('#bm-time-total', root);
  const listEl = $('#bm-list', root);
  const queueEl = $('#bm-queue-list', root);
  const volEl = $('#bm-vol', root);

  function setStatus(t) { $('#bm-status', root).textContent = t || ''; }

  function paintProgress() {
    const v = Number(seekBar.value) / 1000 * 100;
    $('#bm-bar-fill', root).style.width = v + '%';
    $('#bm-bar-knob', root).style.left = v + '%';
  }
  function updateVolUI() {
    const v = _muted ? 0 : _vol;
    $('#bm-vol-fill', root).style.width = v * 100 + '%';
    volEl.value = String(Math.round(_vol * 100));
    $('#bm-vol-num', root).textContent = String(Math.round(_vol * 100));
    const mute = _muted || _vol === 0;
    $('#bm-icon-vol', root).style.display = mute ? 'none' : '';
    $('#bm-icon-mute', root).style.display = mute ? '' : 'none';
  }

  let loopOne = false;
  function updateUI() {
    // 播放/暂停图标
    $('#bm-icon-play', root).style.display = state.playing ? 'none' : '';
    $('#bm-icon-pause', root).style.display = state.playing ? '' : 'none';

    // 上下曲可用性：只有合集/多分P 才亮
    const has = state.parts.length > 1;
    $('#bm-prev', root).disabled = !has;
    $('#bm-next', root).disabled = !has;

    // 标题
    const cur = state.current;
    $('#bm-title', root).textContent = cur ? cur.title : '未在播放';
    $('#bm-title', root).title = cur ? cur.title : '';
    $('#bm-sub', root).textContent = cur
      ? (cur.author || '') + (has ? `　·　${state.partIdx + 1}/${state.parts.length}` : '')
      : '搜索一首歌开始吧';

    // 高亮：搜索结果按 bvid 匹配（同一视频的分P/合集都算当前）
    $$('.bm-item', listEl).forEach((el) => {
      el.classList.toggle('on', !!cur && el.dataset.bvid === cur.bvid);
    });
    // 队列按 partIdx 高亮
    if (state.partIdx >= 0) {
      $$('.bm-item', queueEl).forEach((el) => {
        el.classList.toggle('on', Number(el.dataset.partIdx) === state.partIdx);
      });
    }

    loadCover(cur);
    notifyNative();
  }

  /* ---- 封面（失败则退回占位符） ---- */
  let coverSeq = 0;
  async function loadCover(item) {
    const box = $('#bm-cover', root);
    if (!item) { box.innerHTML = '<div class="bm-cover-ph">♪</div>'; return; }
    const seq = ++coverSeq;
    const url = item.pic || `https://i0.hdslb.com/bfs/archive/${item.bvid}.jpg`;
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      if (seq !== coverSeq) return;
      box.innerHTML = '';
      box.appendChild(img);
    };
    img.onerror = () => {
      if (seq !== coverSeq) return;
      box.innerHTML = '<div class="bm-cover-ph">♪</div>';
    };
    img.src = url;
  }

  /* ---- 搜索结果列表（增量渲染 + 滑到底自动翻页） ---- */
  let moreEl = null;          // 列表底部的状态行
  const PAGE_SIZE = 50;       // 与 searchVideos 里保持一致

  /** 造一条搜索结果 */
  function makeResultItem(it, i) {
    const li = document.createElement('li');
    li.className = 'bm-item';
    li.dataset.idx = String(i);
    li.dataset.bvid = it.bvid;
    li.innerHTML = `
      <div class="bm-item-idx">${i + 1}</div>
      <div class="bm-item-main">
        <div class="bm-item-title"></div>
        <div class="bm-item-meta"></div>
      </div>
      <div class="bm-item-dur">${it.durText || fmt(it.duration)}</div>
    `;
    $('.bm-item-title', li).textContent = it.title;
    $('.bm-item-title', li).title = it.title;
    $('.bm-item-meta', li).textContent = it.author || '';
    li.addEventListener('click', () => playFromList(i));
    return li;
  }

  /** 往列表尾巴追加一批（不重建已有节点，滚动位置不会跳） */
  function appendResults(items, baseIdx) {
    if (moreEl) moreEl.remove();
    const frag = document.createDocumentFragment();
    items.forEach((it, k) => frag.appendChild(makeResultItem(it, baseIdx + k)));
    listEl.appendChild(frag);
    if (moreEl) listEl.appendChild(moreEl);   // 状态行始终在最后
  }

  /** 列表底部的状态行（可点重试） */
  function setMoreState(text) {
    if (!moreEl) {
      moreEl = document.createElement('li');
      moreEl.className = 'bm-more';
      moreEl.addEventListener('click', () => {
        if (!state.loadingMore && !state.noMore) loadResults(false);
      });
    }
    moreEl.textContent = text;
    listEl.appendChild(moreEl);
  }

  function updateCount() {
    const loaded = state.list.length;
    const total = state.total;
    $('#bm-count', root).textContent = !loaded ? ''
      : (total > loaded ? `已加载 ${loaded} / 共 ${total}` : `${loaded} 条`);
  }

  /**
   * 搜索 / 加载下一页。
   * reset=true 表示换了新关键词，从第 1 页重来；否则接在当前列表后面。
   */
  async function loadResults(reset = false) {
    if (state.loadingMore || !state.keyword) return;
    if (!reset && state.noMore) return;

    const next = reset ? 1 : state.page + 1;
    state.loadingMore = true;

    if (reset) {
      state.page = 0;
      state.total = 0;
      state.noMore = false;
      state.list = [];
      moreEl = null;
      listEl.innerHTML = '';
      updateCount();
      setStatus('搜索中…');
    } else {
      setMoreState('正在加载下一页…');
    }

    try {
      const r = await searchVideos(state.keyword, next);
      const base = state.list.length;
      state.list.push(...r.items);
      state.page = next;
      if (r.total) state.total = r.total;

      if (!state.list.length) {
        listEl.innerHTML = '<li class="bm-empty">没有结果，换个关键词试试</li>';
        state.noMore = true;
      } else {
        appendResults(r.items, base);
        // 到底的几种情形：空页 / 不满一页 / 已达总数 / 碰到接口页码上限
        const done = !r.items.length
          || r.items.length < PAGE_SIZE
          || (state.total && state.list.length >= state.total)
          || next >= 50;
        if (done) {
          state.noMore = true;
          setMoreState(`—— 已经到底了，共 ${state.list.length} 条 ——`);
        } else {
          setMoreState('↓ 滑到底自动加载下一页');
        }
      }
      updateCount();
      if (reset) {
        listEl.scrollTop = 0;
        setStatus('');
      }
    } catch (err) {
      if (reset) {
        state.page = 0;
        setStatus('搜索失败：' + err.message);
        toast('搜索失败：' + err.message);
      } else {
        toast('加载失败：' + err.message);
        setMoreState('加载失败，点这里重试');
      }
    } finally {
      state.loadingMore = false;
    }
  }

  function renderQueue() {
    queueEl.innerHTML = '';
    const parts = state.parts;
    const panel = $('#bm-queue', root);
    const toggleBtn = $('#bm-queue-toggle', root);
    // 手机窄屏：队列没内容就别白占一屏；有内容了再自动展开。
    // 用户手动点过切换按钮之后完全听他的（dataset.userToggled）。
    const autoFold = window.matchMedia('(max-width: 640px)').matches &&
      panel.dataset.userToggled !== '1';

    if (parts.length <= 1) {
      queueEl.innerHTML = '<li class="bm-empty">当前视频没有合集 / 多分P</li>';
      $('#bm-queue-title', root).textContent = '播放队列';
      if (autoFold) { panel.classList.add('fold'); toggleBtn.textContent = '展开'; }
      return;
    }
    if (autoFold) { panel.classList.remove('fold'); toggleBtn.textContent = '收起'; }
    $('#bm-queue-title', root).textContent = (state.current && state.current.seasonTitle) || '合集 / 分P';
    const frag = document.createDocumentFragment();
    parts.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'bm-item bm-item-sm' + (i === state.partIdx ? ' on' : '');
      li.dataset.idx = String(i);
      li.dataset.partIdx = String(i);
      li.innerHTML = `
        <div class="bm-item-idx">${i + 1}</div>
        <div class="bm-item-main"><div class="bm-item-title"></div></div>
        <div class="bm-item-dur">${fmt(p.duration)}</div>
      `;
      $('.bm-item-title', li).textContent = p.title || ('第 ' + (i + 1) + ' 集');
      $('.bm-item-title', li).title = p.title || '';
      li.addEventListener('click', () => playPart(i));
      frag.appendChild(li);
    });
    queueEl.appendChild(frag);
  }

  /* ---- 播放驱动 ---- */
  async function playFromList(i) {
    const it = state.list[i];
    if (!it) return;
    state.idx = i;
    try {
      setStatus('读取视频信息…');
      const det = await getDetail(it.bvid);
      state.parts = det.parts;
      // 合集场景：点哪一集就从哪一集开始；找不到就用第一集
      let start = det.parts.findIndex((p) => p.bvid === it.bvid);
      if (start < 0) start = 0;
      state.partIdx = start;
      state.albumTitle = det.title;
      renderQueue();
      const p0 = det.parts[start];
      await loadAndPlay({
        bvid: p0.bvid || det.bvid,
        cid: p0.cid || det.cid,
        title: det.parts.length > 1 ? joinTitle(det.seasonTitle || det.title, p0.title) : det.title,
        author: det.author,
        pic: det.pic,
        seasonTitle: det.seasonTitle,
      });
      updateUI();
      toast(`▶ ${det.title}`);
    } catch (e) {
      setStatus('出错：' + e.message);
      toast('出错：' + e.message);
    }
  }

  async function playPart(i) {
    const p = state.parts[i];
    if (!p) return;
    state.partIdx = i;
    const cur = state.current;
    const album = (cur && cur.seasonTitle) || state.albumTitle || (state.list[state.idx] ? state.list[state.idx].title : '');
    await loadAndPlay({
      bvid: p.bvid || (cur && cur.bvid),
      cid: p.cid,
      title: state.parts.length > 1 ? joinTitle(album, p.title) : (album || p.title),
      author: cur ? cur.author : '',
      pic: cur ? cur.pic : '',
      seasonTitle: cur ? cur.seasonTitle : '',
    });
    renderQueue();
    updateUI();
  }

  function playNext(auto = false) {
    if (state.parts.length <= 1) {
      if (auto) setStatus('播放结束');
      return;
    }
    if (state.partIdx >= state.parts.length - 1) {
      // 播完了，从第 0 首重来（循环）
      playPart(0);
    } else {
      playPart(state.partIdx + 1);
    }
  }

  function playPrev() {
    if (state.parts.length <= 1) return;
    if (audio.currentTime > 4) { audio.currentTime = 0; return; } // 先回开头
    playPart(state.partIdx <= 0 ? state.parts.length - 1 : state.partIdx - 1);
  }

  /* ---- 事件绑定 ---- */
  $('#bm-form', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#bm-input', root).value.trim();
    if (!q || q === state.keyword && state.loadingMore) return;
    state.keyword = q;
    loadResults(true);            // 从第 1 页重来
  });

  // 搜索结果滑到底 → 自动加载下一页
  listEl.addEventListener('scroll', () => {
    if (state.loadingMore || state.noMore || !state.list.length) return;
    if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 160) {
      loadResults(false);
    }
  });

  $('#bm-toggle', root).addEventListener('click', () => {
    if (!audio.src) {
      if (state.list.length) playFromList(0);
      else $('#bm-input', root).focus();
      return;
    }
    if (audio.paused) safePlay();
    else audio.pause();
  });

  $('#bm-next', root).addEventListener('click', () => playNext(false));
  $('#bm-prev', root).addEventListener('click', playPrev);

  $('#bm-loop', root).addEventListener('click', () => {
    loopOne = !loopOne;
    $('#bm-loop', root).classList.toggle('on', loopOne);
    toast(loopOne ? '单曲循环：开' : '单曲循环：关');
  });

  seekBar.addEventListener('input', () => {
    if (audio.duration) {
      audio.currentTime = (Number(seekBar.value) / 1000) * audio.duration;
      paintProgress();
    }
  });

  volEl.addEventListener('input', () => {
    _muted = false;
    audio.muted = false;
    setVol(Number(volEl.value) / 100);
  });
  $('#bm-vol-btn', root).addEventListener('click', () => {
    _muted = !_muted;
    audio.muted = _muted;
    persist();
    updateVolUI();
  });

  $('#bm-queue-toggle', root).addEventListener('click', (e) => {
    const p = $('#bm-queue', root);
    p.classList.toggle('fold');
    p.dataset.userToggled = '1';   // 用户自己动过，之后别再自动折叠
    e.target.textContent = p.classList.contains('fold') ? '展开' : '收起';
  });

  // 键盘：空格播放/暂停（避免在输入框里触发）
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (audio.paused) safePlay(); else audio.pause();
    }
    if (e.code === 'ArrowRight' && e.ctrlKey) playNext(false);
    if (e.code === 'ArrowLeft' && e.ctrlKey) playPrev();
  });

  /* ---- 音量持久化 ---- */
  function persist() {
    try {
      localStorage.setItem(STORE, JSON.stringify({ volume: _vol, muted: _muted, loopOne }));
    } catch (e) {}
  }
  function restore() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE) || '{}');
      if (typeof s.volume === 'number') _vol = s.volume;
      if (typeof s.muted === 'boolean') _muted = s.muted;
      if (typeof s.loopOne === 'boolean') { loopOne = s.loopOne; $('#bm-loop', root).classList.toggle('on', loopOne); }
    } catch (e) {}
    audio.volume = _vol;
    audio.muted = _muted;
  }

  /* ========================= 5. 启动 ========================= */
  /**
   * 锁定视口：禁掉双指缩放和双击放大，并让页面按设备宽度排版。
   *
   * 安卓外壳里 WebView 已经关了 useWideViewPort，这里是给
   * 「手机浏览器手动注入 / 油猴」场景兜底；桌面端无副作用（桌面浏览器忽略）。
   */
  function lockViewport() {
    try {
      // B站自己那份 width=980 的 viewport 会干扰，先清掉
      $$('meta[name="viewport"]').forEach((m) => m.remove());
      const m = document.createElement('meta');
      m.name = 'viewport';
      m.content = 'width=device-width, initial-scale=1, maximum-scale=1, ' +
                  'minimum-scale=1, user-scalable=no, viewport-fit=cover';
      (document.head || document.documentElement).appendChild(m);
    } catch (e) {
      console.warn('[BiliMusic] 视口锁定失败：', e);
    }
  }

  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;

    lockViewport();

    document.body.appendChild(root);
    document.body.appendChild((() => {
      const t = document.createElement('div');
      t.id = 'bm-toast';
      return t;
    })());

    restore();
    updateVolUI();
    paintProgress();
    updateUI();
    renderQueue();

    // 抢占焦点到搜索框
    setTimeout(() => $('#bm-input', root).focus(), 60);

    killPopups();
    console.log('%c[BiliMusic] 已启动', 'color:#4ea1ff;font-weight:bold');
  }

  // 任何一步出问题都不该拖掉后面的初始化
  try {
    startFirewall();
  } catch (e) {
    console.warn('[BiliMusic] 屏蔽层初始化失败：', e);
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });

  /* ========================= 6. 安卓外壳通知栏桥 =========================
   *  桌面端没有 window.BiliMusicAndroid，下面所有调用都会安全跳过，
   *  所以这一层对 Windows / 油猴 / Snippet 完全无影响。
   *
   *  JS → Kotlin：window.BiliMusicAndroid.onState(json)
   *  Kotlin → JS：window.__bmCmd('play'|'pause'|'toggle'|'next'|'prev')
   * ============================================================= */
  function nativeBridge() {
    const b = window.BiliMusicAndroid;
    return (b && typeof b.onState === 'function') ? b : null;
  }

  var _lastNativeKey = '';
  var _lastPosPush = 0;

  /** 把当前播放状态推给安卓外壳，用于刷新通知栏 / 媒体控件 */
  function notifyNative(force) {
    const bridge = nativeBridge();
    if (!bridge) return;
    const cur = state.current;
    const a = audio;
    const has = state.parts.length > 1;
    const payload = {
      playing: !!state.playing,
      title: cur ? (cur.title || '') : '',
      author: cur ? (cur.author || '') : '',
      cover: cur ? (cur.pic || '') : '',
      duration: isFinite(a.duration) ? a.duration : 0,
      position: isFinite(a.currentTime) ? a.currentTime : 0,
      hasPrev: has,
      hasNext: has,
    };
    // 进度一直在变，只在「非进度字段」变化时才推，避免每秒刷通知
    const key = [payload.playing, payload.title, payload.author,
                 payload.duration, payload.hasPrev, payload.hasNext].join('|');
    if (!force && key === _lastNativeKey) return;
    _lastNativeKey = key;
    try { bridge.onState(JSON.stringify(payload)); } catch (e) {}
  }

  /**
   * 供安卓通知栏按钮调用。
   * 整个包在 try 里：通知栏的点击不应该因为异常而卡死。
   */
  window.__bmCmd = function (cmd) {
    try {
      const hasSrc = !!(audio.src || audio.currentSrc);
      switch (cmd) {
        case 'play':
          if (hasSrc) safePlay();
          else if (state.current) playPart(state.partIdx);
          break;
        case 'pause':
          audio.pause();
          break;
        case 'toggle':
          if (state.playing) audio.pause();
          else if (hasSrc) safePlay();
          else if (state.current) playPart(state.partIdx);
          break;
        case 'next':
          playNext();
          break;
        case 'prev':
          playPrev();
          break;
        default:
          return false;
      }
      return true;
    } catch (e) {
      console.warn('[BiliMusic] 通知栏命令失败：', cmd, e);
      return false;
    }
  };

  // 暴露一点调试接口（audio 会被替换，用 getter 取实时对象）
  window.__biliMusic = {
    state,
    get audio() { return audio; },
    get mse() { return mse; },
    searchVideos, getDetail, getAudioUrl, boot,
    playFromList, playPart, playNext, playPrev,
    probeAacSupport,
    /** 一键自检：把结果丢到控制台 */
    diagnose: async () => {
      const r = {};
      r.MSE_OK = MSE_OK;
      r.mime = MSE_MIME;
      r.isSupported = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(MSE_MIME);
      r.canPlayType = document.createElement('audio').canPlayType(MSE_MIME);
      r.aacDecodable = await probeAacSupport();
      if (!r.aacDecodable) {
        console.error('%c[BiliMusic] 当前浏览器无法解码 B站的 AAC 音频流。\n' +
          '常见原因：VS Code 内嵌浏览器 / 开源版 Electron 不带专有解码器。\n' +
          '解决：用正式版 Chrome 或 Edge 打开 B站，再跑本脚本。', 'color:#f66;font-weight:bold');
      } else {
        console.log('%c[BiliMusic] 环境自检通过，可以正常播放。', 'color:#4ea1ff;font-weight:bold');
      }
      console.table ? console.log(r) : console.log(r);
      return r;
    },
  };
})();

/* ==================================================================
 *  6. 样式
 * ================================================================== */
(function injectCss() {
  if (document.getElementById('bm-css')) return;
  const s = document.createElement('style');
  s.id = 'bm-css';
  s.textContent = `
  #bm-root, #bm-toast { all: initial; }
  #bm-root * { box-sizing: border-box; }
  #bm-root {
    --bg:#0f1115; --panel:#171a21; --panel2:#1e222b; --line:#272c37;
    --fg:#e8ecf3; --dim:#8b95a7; --acc:#4ea1ff; --acc2:#22d3a6;
    position: fixed; inset: 0; z-index: 2147483000;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    font-size: 14px; color: var(--fg); background: var(--bg);
    display: flex; flex-direction: column;
    /* 手机上防双击放大 / 双击延迟 */
    touch-action: manipulation;
    -webkit-text-size-adjust: 100%;
  }
  #bm-root .bm-wrap { display: flex; flex-direction: column; height: 100%; min-height: 0; }

  /* ---------- 顶栏 ---------- */
  #bm-root .bm-head {
    display: flex; align-items: center; gap: 18px;
    padding: 14px 22px; border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, #191d26, #12151b);
    flex: 0 0 auto;
  }
  #bm-root .bm-logo {
    display: flex; align-items: center; gap: 8px;
    font-size: 17px; font-weight: 700; letter-spacing: .3px;
    color: #fff; white-space: nowrap;
  }
  #bm-root .bm-logo span {
    display: grid; place-items: center; width: 26px; height: 26px;
    border-radius: 8px; font-size: 15px;
    background: linear-gradient(135deg, var(--acc), var(--acc2)); color: #06202e;
  }
  #bm-root .bm-search { display: flex; gap: 10px; flex: 1; max-width: 720px; }
  #bm-root .bm-search input {
    flex: 1; height: 40px; padding: 0 16px; border-radius: 20px;
    border: 1px solid var(--line); background: #0d1015; color: var(--fg);
    font-size: 14px; outline: none; transition: border-color .15s, box-shadow .15s;
  }
  #bm-root .bm-search input::placeholder { color: #5d6879; }
  #bm-root .bm-search input:focus { border-color: var(--acc); box-shadow: 0 0 0 3px rgba(78,161,255,.14); }
  #bm-root .bm-search input::-webkit-search-cancel-button { filter: invert(.6); }
  #bm-root .bm-search button {
    height: 40px; padding: 0 22px; border-radius: 20px; border: 0; cursor: pointer;
    background: linear-gradient(135deg, var(--acc), #2f7fe0); color: #fff;
    font-size: 14px; font-weight: 600; transition: filter .15s, transform .1s;
  }
  #bm-root .bm-search button:hover { filter: brightness(1.12); }
  #bm-root .bm-search button:active { transform: scale(.97); }

  /* ---------- 主体 ---------- */
  #bm-root .bm-body {
    flex: 1 1 auto; min-height: 0; display: grid;
    grid-template-columns: minmax(0,1fr) minmax(0,340px); gap: 14px;
    padding: 14px 22px 8px;
  }
  #bm-root .bm-panel {
    display: flex; flex-direction: column; min-height: 0;
    background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
    overflow: hidden;
  }
  #bm-root .bm-panel.fold .bm-list { display: none; }
  #bm-root .bm-panel-hd {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid var(--line);
    font-size: 13px; font-weight: 600; color: var(--dim); flex: 0 0 auto;
    letter-spacing: .4px;
  }
  #bm-root .bm-panel-hd em { font-style: normal; color: #5d6879; font-weight: 400; }
  #bm-root .bm-mini {
    border: 1px solid var(--line); background: transparent; color: var(--dim);
    border-radius: 8px; padding: 3px 10px; font-size: 12px; cursor: pointer;
  }
  #bm-root .bm-mini:hover { color: var(--fg); border-color: #3a4152; }

  #bm-root .bm-list { list-style: none; margin: 0; padding: 6px; overflow-y: auto; flex: 1 1 auto; min-height: 0; }
  #bm-root .bm-list::-webkit-scrollbar { width: 9px; }
  #bm-root .bm-list::-webkit-scrollbar-thumb { background: #2c3240; border-radius: 6px; }
  #bm-root .bm-list::-webkit-scrollbar-thumb:hover { background: #3a4152; }

  #bm-root .bm-item {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 12px; border-radius: 10px; cursor: pointer;
    transition: background .12s;
  }
  #bm-root .bm-item:hover { background: var(--panel2); }
  #bm-root .bm-item.on { background: rgba(78,161,255,.13); box-shadow: inset 2px 0 0 var(--acc); }
  #bm-root .bm-item.on .bm-item-title { color: var(--acc); }
  #bm-root .bm-item-idx { width: 26px; text-align: center; color: #55606f; font-variant-numeric: tabular-nums; flex: 0 0 auto; }
  #bm-root .bm-item.on .bm-item-idx { color: var(--acc); }
  #bm-root .bm-item-main { flex: 1; min-width: 0; }
  #bm-root .bm-item-title {
    font-size: 13.5px; color: var(--fg); white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis;
  }
  #bm-root .bm-item-meta { font-size: 12px; color: var(--dim); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #bm-root .bm-item-dur { font-size: 12px; color: #5d6879; font-variant-numeric: tabular-nums; flex: 0 0 auto; }
  #bm-root .bm-item-sm { padding: 8px 12px; }
  #bm-root .bm-empty { padding: 26px 10px; text-align: center; color: #55606f; font-size: 13px; }
  #bm-root .bm-more {
    padding: 15px 10px 18px; text-align: center; color: #55606f;
    font-size: 12.5px; cursor: pointer; user-select: none;
    transition: color .15s;
  }
  #bm-root .bm-more:hover { color: var(--acc); }

  /* ---------- 底部播放器 ---------- */
  #bm-root .bm-player {
    flex: 0 0 auto; display: grid;
    grid-template-columns: 56px minmax(140px, 1fr) auto minmax(220px, 1.4fr) auto;
    align-items: center; gap: 18px;
    padding: 12px 22px; border-top: 1px solid var(--line);
    background: linear-gradient(180deg, #161a22, #10131a);
    position: relative;
  }
  #bm-root .bm-cover {
    width: 56px; height: 56px; border-radius: 10px; overflow: hidden;
    background: var(--panel2); display: grid; place-items: center; flex: 0 0 auto;
  }
  #bm-root .bm-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  #bm-root .bm-cover-ph { font-size: 22px; color: #46506180; }

  #bm-root .bm-meta { min-width: 0; }
  #bm-root .bm-title {
    font-size: 14px; font-weight: 600; color: #fff;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #bm-root .bm-sub { font-size: 12px; color: var(--dim); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* 按钮 */
  #bm-root .bm-btn {
    display: grid; place-items: center; width: 38px; height: 38px;
    border-radius: 50%; border: 1px solid var(--line); background: #1b202a;
    color: var(--fg); cursor: pointer; transition: all .14s;
  }
  #bm-root .bm-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
  #bm-root #bm-icon-play, #bm-root #bm-icon-pause { fill: currentColor; stroke: none; }
  #bm-root .bm-btn:hover:not(:disabled) { background: #232936; border-color: #3a4152; color: #fff; }
  #bm-root .bm-btn:disabled { opacity: .32; cursor: not-allowed; }
  #bm-root .bm-btn-main {
    width: 48px; height: 48px; border: 0;
    background: linear-gradient(135deg, var(--acc), #2f7fe0); color: #fff;
    box-shadow: 0 4px 16px rgba(78,161,255,.3);
  }
  #bm-root .bm-btn-main:hover:not(:disabled) { filter: brightness(1.1); background: linear-gradient(135deg, var(--acc), #2f7fe0); }
  #bm-root .bm-btn-main svg { width: 20px; height: 20px; }
  #bm-root .bm-btn-sm { width: 32px; height: 32px; border: 0; background: transparent; color: var(--dim); }
  #bm-root .bm-btn-sm svg { width: 16px; height: 16px; }
  #bm-root .bm-btn-sm:hover:not(:disabled) { color: var(--fg); background: #232936; }
  #bm-root .bm-btn-sm.on { color: var(--acc); background: rgba(78,161,255,.14); }
  #bm-root .bm-ctrl { display: flex; align-items: center; gap: 14px; }

  /* 进度条 */
  #bm-root .bm-progress { display: flex; align-items: center; gap: 12px; min-width: 0; }
  #bm-root .bm-time { font-size: 11.5px; color: var(--dim); font-variant-numeric: tabular-nums; flex: 0 0 auto; width: 44px; text-align: center; }
  #bm-root .bm-bar { position: relative; flex: 1; height: 18px; display: flex; align-items: center; min-width: 0; }
  #bm-root .bm-bar::before {
    content: ''; position: absolute; left: 0; right: 0; height: 4px;
    border-radius: 2px; background: #262c38;
  }
  #bm-root .bm-bar-fill {
    position: absolute; left: 0; height: 4px; border-radius: 2px; width: 0;
    background: linear-gradient(90deg, var(--acc), var(--acc2));
    pointer-events: none;
  }
  #bm-root .bm-bar-knob {
    position: absolute; width: 11px; height: 11px; border-radius: 50%;
    background: #fff; left: 0; transform: translateX(-50%);
    box-shadow: 0 0 0 3px rgba(78,161,255,.22); opacity: 0; transition: opacity .15s;
    pointer-events: none;
  }
  #bm-root .bm-bar:hover .bm-bar-knob { opacity: 1; }
  #bm-root .bm-bar input[type=range] {
    -webkit-appearance: none; appearance: none; position: absolute; inset: 0;
    width: 100%; height: 100%; margin: 0; background: transparent; cursor: pointer;
  }
  #bm-root .bm-bar input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%;
    background: transparent; border: 0;
  }

  /* 音量 */
  #bm-root .bm-right { display: flex; align-items: center; gap: 8px; }
  #bm-root .bm-vbar { position: relative; width: 90px; height: 18px; display: flex; align-items: center; }
  #bm-root .bm-vbar::before {
    content: ''; position: absolute; left: 0; right: 0; height: 4px;
    border-radius: 2px; background: #262c38;
  }
  #bm-root .bm-vbar .bm-bar-fill { background: linear-gradient(90deg, var(--acc2), var(--acc)); }
  #bm-root .bm-vbar input[type=range] {
    -webkit-appearance: none; appearance: none; position: absolute; inset: 0;
    width: 100%; height: 100%; margin: 0; background: transparent; cursor: pointer;
  }
  #bm-root .bm-vbar input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 13px; height: 13px; border-radius: 50%;
    background: #fff; box-shadow: 0 0 0 3px rgba(34,211,166,.2); cursor: pointer;
  }
  #bm-root .bm-vol-num { font-size: 11.5px; color: var(--dim); width: 26px; text-align: right; font-variant-numeric: tabular-nums; }

  #bm-root .bm-status {
    position: absolute; top: -26px; left: 22px;
    font-size: 12px; color: var(--acc); pointer-events: none;
    background: #10131ae6; padding: 3px 10px; border-radius: 8px;
    opacity: 0; transition: opacity .2s;
  }
  #bm-root .bm-status:not(:empty) { opacity: 1; }

  /* Toast */
  #bm-toast {
    position: fixed; left: 50%; bottom: 110px; transform: translate(-50%, 12px);
    z-index: 2147483001; padding: 10px 20px; border-radius: 22px;
    background: #232936f2; color: #fff; font-size: 13.5px;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    border: 1px solid #343b4a; box-shadow: 0 8px 30px #0009;
    opacity: 0; pointer-events: none; transition: all .22s;
    max-width: 70vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #bm-toast.on { opacity: 1; transform: translate(-50%, 0); }

  @media (max-width: 900px) {
    #bm-root .bm-body { grid-template-columns: 1fr; grid-template-rows: minmax(0,1fr) auto; }
    #bm-root #bm-queue { max-height: 30vh; }
    #bm-root .bm-player { grid-template-columns: 48px minmax(0,1fr) auto; row-gap: 10px; }
    #bm-root .bm-progress { grid-column: 1 / -1; order: 5; }
    /* 音量条不能隐藏——那是网页内音量，和系统音量无关。窄屏下换到单独一行。 */
    #bm-root .bm-right { grid-column: 1 / -1; order: 6; justify-content: flex-end; }
  }

  /* ---------- 手机竖屏：单列 + 紧凑播放器 ---------- */
  @media (max-width: 640px) {
    #bm-root { font-size: 13.5px; }

    /* 顶栏：logo 只留图标，把宽度让给搜索框 */
    #bm-root .bm-head { padding: 10px 12px; gap: 10px; }
    #bm-root .bm-logo { font-size: 0; gap: 0; }
    #bm-root .bm-logo span { width: 24px; height: 24px; font-size: 14px; border-radius: 7px; }
    #bm-root .bm-search { flex: 1 1 auto; max-width: none; gap: 8px; }
    #bm-root .bm-search input { height: 36px; padding: 0 14px; font-size: 13.5px; }
    #bm-root .bm-search button { height: 36px; padding: 0 16px; font-size: 13.5px; }

    /* 主体：单列，间距收紧 */
    #bm-root .bm-body { padding: 10px 10px 6px; gap: 10px; }
    #bm-root .bm-panel { border-radius: 12px; }
    #bm-root .bm-panel-hd { padding: 9px 12px; font-size: 12.5px; }
    #bm-root #bm-queue { max-height: 32vh; }
    #bm-root #bm-queue.fold { max-height: none; }

    #bm-root .bm-item { padding: 9px 10px; gap: 9px; }
    #bm-root .bm-item-title { font-size: 13px; }
    #bm-root .bm-item-meta { font-size: 11.5px; margin-top: 2px; }
    #bm-root .bm-item-idx { width: 22px; font-size: 12px; }
    #bm-root .bm-item-dur { font-size: 11.5px; }

    /* 播放器改成三行：封面/信息/控制 → 进度 → 循环+音量 */
    #bm-root .bm-player {
      grid-template-columns: 40px minmax(0,1fr) auto;
      grid-template-areas:
        "cover meta ctrl"
        "progress progress progress"
        "right right right";
      gap: 8px 10px;
      padding: 10px 12px calc(10px + env(safe-area-inset-bottom, 0px));
    }
    #bm-root .bm-cover { grid-area: cover; width: 40px; height: 40px; border-radius: 8px; }
    #bm-root .bm-meta { grid-area: meta; }
    #bm-root .bm-ctrl { grid-area: ctrl; gap: 6px; }
    #bm-root .bm-progress { grid-area: progress; gap: 8px; order: 0; }
    #bm-root .bm-right { grid-area: right; display: flex; justify-content: flex-end; gap: 6px; order: 0; }

    #bm-root .bm-title { font-size: 13px; }
    #bm-root .bm-sub { font-size: 11.5px; margin-top: 2px; }
    #bm-root .bm-btn { width: 34px; height: 34px; }
    #bm-root .bm-btn-main { width: 44px; height: 44px; }
    #bm-root .bm-btn-main svg { width: 18px; height: 18px; }
    #bm-root .bm-btn-sm { width: 30px; height: 30px; }
    #bm-root .bm-time { width: 36px; font-size: 11px; }
    #bm-root .bm-vbar { width: 64px; }
    #bm-root .bm-vol-num { width: 22px; font-size: 11px; }
    #bm-root .bm-status { left: 12px; top: -24px; }

    #bm-toast { bottom: 150px; max-width: 86vw; }
  }
  `;
  // document-start 阶段 head 可能还没建出来（documentElement 也可能是 null），
  // 所以等宿主节点可用再挂，别让这一大块样式白丢
  const attach = () => {
    const host = document.head || document.documentElement;
    if (!host) return false;
    host.appendChild(s);
    return true;
  };
  if (!attach()) {
    const timer = setInterval(() => { if (attach()) clearInterval(timer); }, 1);
  }
})();
