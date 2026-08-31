// ==UserScript==
// @name         ytdistill
// @namespace    https://github.com/prwhite
// @version      1.1.1
// @description  Distill a YouTube video into the paragraph it should have been — one-click OpenAI summary overlay.
// @author       prwhite
// @include      /^https:\/\/(www|m)\.youtube\.com\/watch\?.*/
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      api.openai.com
// @connect      sponsor.ajay.app
// @connect      youtube.com
// @connect      www.youtube.com
// @updateURL    https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/ytdistill/ytdistill.user.js
// @downloadURL  https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/ytdistill/ytdistill.user.js
// ==/UserScript==

/*
 * Phase 2 of ytdistill (see ytdistill-design.md). Single-file Tampermonkey PoC,
 * happy path. Pipeline: player-response (meta) -> reuse YouTube's own pot-bearing
 * caption request -> json3 -> rolling-window dedupe + [mm:ss] markers ->
 * SponsorBlock -> OpenAI structured output -> shadow-DOM overlay.
 *
 * Caption acquisition (the hard part, 2026): YouTube's get_transcript endpoint is
 * dead (deterministic 400) and a bare timedtext fetch returns an empty 200 without
 * a PO ("pot") token that YouTube mints via BotGuard. So instead of minting a token,
 * we hook the page's own XHR from the isolated world (via unsafeWindow, at
 * document-start) and reuse YouTube's own pot-bearing caption request — capturing
 * its json3 response directly when we can (no second request), and only refetching
 * the captured URL via GM_xmlhttpRequest as a fallback. Key is stored via
 * GM_setValue, never in the script. Dedupe stays faithful to captions.py.
 */

(() => {
  'use strict';

  // ===== CONFIG =====
  const VERSION = '1.1.1';   // keep in sync with the @version header above
  const MODEL = 'gpt-4.1';
  const LANG = 'en';
  const MARKER_INTERVAL = 30;
  const KEY_STORE = 'ytdistill_openai_key';
  const CACHE_PREFIX = 'ytdistill_cache_';
  const MODE_STORE = 'ytdistill_mode';       // persistent "auto-distill mode" toggle
  const STATS_STORE = 'ytdistill_stats';     // persistent time-saved scoreboard
  const HASH_TRIGGER = '#ytdistill';         // a page opened just to distill (e.g. from a Distill action)
  const BTN_ID = 'ytdistill-btn';
  const MODE_BTN_ID = 'ytdistill-mode-btn';
  const OVERLAY_ID = 'ytdistill-overlay';

  // Single source of truth mirror of prompts/distill.md.
  const SYSTEM_PROMPT = [
    'You are extracting the substance from a YouTube video transcript. The reader has chosen NOT to watch the video; assume they are impatient and technically literate. Most videos withhold their content to maximise watch time — defeat that structure, do not reproduce it.',
    '',
    'FIRST classify: TEASE (title/thumbnail poses a question or promises a reveal and the video defers answering), LISTICLE (enumerated items/tips/products/mistakes), TUTORIAL (a procedure to follow), REVIEW (evaluation ending in a verdict), NARRATIVE (story/essay/documentary with no single extractable claim).',
    '',
    'THEN: TEASE — state the withheld thing plainly in the opening sentence, no preamble; if the video never answers, say so explicitly. LISTICLE — extract every item in the video\'s order with rank, a short label, one line of detail; note promised-vs-delivered mismatches in gaps; do not merge items. TUTORIAL — ordered steps including prerequisites/versions/hardware mentioned in passing. REVIEW — lead with verdict and price, then reasoning. NARRATIVE — the arc in three sentences; do not invent a thesis.',
    '',
    'RULES: Never write "the video discusses/explains/covers" or "this video" — state content directly. Never describe structure. Prefer the creator\'s specific numbers/names/versions/prices. The transcript is machine-generated (no punctuation, mangled jargon); repair obvious mis-transcriptions from the title only where confident, else write as heard and flag in gaps. Summarise ONLY what is in the transcript — if the title implies a story the transcript does not contain, follow the transcript, not the title. Only emit a timestamp you can ground in a [mm:ss] marker; never one beyond the last marker; if you cannot ground it use null (do not default to 0). If the transcript is too thin/corrupted/off-topic, say so in payload. gaps = only real omissions (unsupported claim, undisclosed sponsorship, promised-vs-delivered mismatch, "link in description" replacing an explanation); empty is valid.',
  ].join('\n');

  const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'payload', 'tease', 'points', 'notes', 'gaps'],
    properties: {
      kind: { type: 'string', enum: ['tease', 'listicle', 'tutorial', 'review', 'narrative'] },
      payload: { type: 'string' },
      tease: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['question', 'answer', 'answered_at_s'],
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
          answered_at_s: { type: ['integer', 'null'] },
        },
      },
      points: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['rank', 'label', 'detail', 'at_s'],
          properties: {
            rank: { type: 'integer' },
            label: { type: 'string' },
            detail: { type: 'string' },
            at_s: { type: ['integer', 'null'] },
          },
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
      gaps: { type: 'array', items: { type: 'string' } },
    },
  };

  // ===== GM helpers =====
  const gmGet = (k, d) => { try { return GM_getValue(k, d); } catch (e) { return d; } };
  const gmSet = (k, v) => { try { GM_setValue(k, v); } catch (e) { /* ignore */ } };
  function gmXhr(opts, label) {
    const what = label ? `${label} ` : '';
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest(Object.assign({ timeout: 60000 }, opts, {
        onload: resolve,
        onerror: () => reject(new Error(`${what}network error`)),
        ontimeout: () => reject(new Error(`${what}request timed out`)),
      }));
    });
  }

  function getKey() {
    let key = gmGet(KEY_STORE, '');
    if (!key) {
      key = (prompt('Paste your OpenAI API key (stored locally by Tampermonkey, never in the script):') || '').trim();
      if (key) gmSet(KEY_STORE, key);
    }
    return key;
  }

  // ===== URL / player response =====
  function getVideoId() {
    return new URLSearchParams(location.search).get('v') || '';
  }

  function extractBalanced(str, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < str.length; i++) {
      const c = str[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return str.slice(start, i + 1); }
    }
    return null;
  }

  // Get the CURRENT video's player response. The live player is authoritative:
  // <script> ytInitialPlayerResponse holds only the first-loaded video's data, so
  // scraping it returns stale info after an SPA navigation. Fall back to the scrape
  // (and the page global) only if the live player isn't reachable yet.
  function getPlayerResponse() {
    try {
      const mp = PAGE.document.getElementById('movie_player');
      if (mp && typeof mp.getPlayerResponse === 'function') {
        const pr = mp.getPlayerResponse();
        if (pr && pr.videoDetails) return pr;
      }
    } catch (e) { /* fall back to scrape */ }
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent;
      if (!t || t.indexOf('ytInitialPlayerResponse') === -1) continue;
      const idx = t.indexOf('ytInitialPlayerResponse');
      const brace = t.indexOf('{', idx);
      if (brace === -1) continue;
      const json = extractBalanced(t, brace);
      if (json) { try { return JSON.parse(json); } catch (e) { /* keep scanning */ } }
    }
    try { if (PAGE.ytInitialPlayerResponse) return PAGE.ytInitialPlayerResponse; } catch (e) { /* isolated */ }
    return null;
  }

  function getMeta(pr) {
    const vd = pr.videoDetails || {};
    return {
      video_id: vd.videoId || getVideoId(),
      title: vd.title || document.title.replace(/ - YouTube$/, ''),
      channel: vd.author || '',
      duration_s: parseInt(vd.lengthSeconds || '0', 10),
      description: vd.shortDescription || '',
      thumbnails: (vd.thumbnail && vd.thumbnail.thumbnails) || [],
    };
  }

  // ===== caption acquisition via YouTube's own (pot-bearing) request =====
  // We don't fetch captions "cold": a bare timedtext URL returns an empty 200
  // without a PO ("pot") token, and get_transcript is dead. Instead we hook the
  // PAGE's XHR (through unsafeWindow, at document-start): .open records the pot-bearing
  // timedtext URL YouTube builds, and .send captures that request's json3 RESPONSE
  // when it completes — so in the common case we read YouTube's own caption body with
  // no second request. Refetching the URL via GM_xmlhttpRequest is only a fallback.

  const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  const capturedTT = Object.create(null);   // videoId -> { url, status, body } from YouTube's own caption request
  let ttHookInstalled = false;
  let ttHookError = null;
  let ttSeen = 0;                            // total /api/timedtext requests observed (diagnostic)
  let lastNudge = 'skipped';                 // last nudgeCaptions(true) result (diagnostic)
  let distillAttempts = 0;                   // runDistill invocations this page load (diagnostic: retry vs fresh)

  function idFromUrl(url) {
    const m = /[?&]v=([\w-]{6,})/.exec(url);
    return m ? m[1] : '';
  }

  function recFor(url) {
    const id = idFromUrl(url) || getVideoId();
    return capturedTT[id] || (capturedTT[id] = {});
  }

  function noteTimedtext(url) {
    if (typeof url !== 'string' || url.indexOf('/api/timedtext') === -1) return;
    ttSeen++;
    const rec = recFor(url);
    if (!rec.url || /[?&]pot=/.test(url)) rec.url = url;   // prefer a pot-bearing URL for any fallback refetch
  }

  function installTimedtextHook() {
    if (ttHookInstalled) return;
    try {
      const proto = PAGE.XMLHttpRequest && PAGE.XMLHttpRequest.prototype;
      if (!proto) throw new Error('no XMLHttpRequest on page');
      const origOpen = proto.open;
      proto.open = function (method, url) {
        try {
          if (typeof url === 'string' && url.indexOf('/api/timedtext') !== -1) {
            ttSeen++;
            const rec = recFor(url);
            this.__ytdRec = rec;
            if (!rec.url || /[?&]pot=/.test(url)) rec.url = url;   // prefer pot-bearing for any refetch
          }
        } catch (e) { /* noop */ }
        return origOpen.apply(this, arguments);
      };
      const origSend = proto.send;
      proto.send = function () {                      // capture YouTube's OWN response — avoids a second request
        try {
          const rec = this.__ytdRec;
          if (rec) {
            this.addEventListener('loadend', function () {
              try {
                rec.status = this.status;
                let body = '';
                try { body = this.responseText || ''; } catch (e) { body = ''; }   // responseType may block responseText
                if (body && body.charAt(0) === '{') rec.body = body;
              } catch (e) { /* noop */ }
            });
          }
        } catch (e) { /* noop */ }
        return origSend.apply(this, arguments);
      };
      const origFetch = PAGE.fetch;                  // cover fetch too, in case YT switches transports (URL only)
      if (origFetch) {
        PAGE.fetch = function (input) {
          try { noteTimedtext(typeof input === 'string' ? input : (input && input.url) || ''); } catch (e) { /* noop */ }
          return origFetch.apply(this, arguments);
        };
      }
      ttHookInstalled = true;
    } catch (e) {
      ttHookError = String((e && e.message) || e);
    }
  }

  function captionTracks(pr) {
    const tl = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    return (tl && tl.captionTracks) || [];
  }

  // The exact languageCode to activate — a video's captions may be 'en-US', 'en-GB',
  // or auto in another language; a hardcoded 'en' silently no-ops on those.
  function preferredLang(tracks) {
    if (!tracks.length) return LANG;
    const t = tracks.find((x) => (x.languageCode || '').split('-')[0] === LANG) || tracks[0];
    return t.languageCode || LANG;
  }

  // Force YouTube to fetch the caption file for videos where it didn't preload it.
  // `reset` first UNLOADS the captions module (then reloads) — the standard way to
  // un-stick a module that wedged when driven before the player was ready, so a plain
  // re-nudge silently no-ops until a full page reload. Returns 'ok' (drove the API),
  // 'noapi' (player caption API missing — YouTube may have changed it), or 'error'.
  function nudgeCaptions(on, lang, reset) {
    try {
      const mp = PAGE.document.getElementById('movie_player');
      if (!mp || typeof mp.loadModule !== 'function' || typeof mp.setOption !== 'function') return 'noapi';
      if (on) {
        if (reset && typeof mp.unloadModule === 'function') { try { mp.unloadModule('captions'); } catch (e) { /* noop */ } }
        mp.loadModule('captions');
        mp.setOption('captions', 'track', { languageCode: lang || LANG });
      } else {
        mp.setOption('captions', 'track', {});   // clear the track again afterward
      }
      return 'ok';
    } catch (e) { return 'error'; }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchTimedtext(url) {
    const u = /[?&]fmt=/.test(url) ? url.replace(/([?&])fmt=[^&]*/, '$1fmt=json3') : url + '&fmt=json3';
    const resp = await gmXhr({ method: 'GET', url: u, timeout: 20000 }, 'caption');   // captions return fast; fail quick if degraded
    const raw = (resp.responseText || '').trim();
    if (resp.status !== 200 || raw.charAt(0) !== '{') {
      throw new Error(`caption download failed (HTTP ${resp.status}${raw ? '' : ', empty body'}) — usually temporary; retry shortly or try another network.`);
    }
    return raw;
  }

  function parseJson3(raw) {
    const data = JSON.parse(raw);
    return (data.events || [])
      .filter((e) => e.segs)
      .map((e) => {
        const start = (e.tStartMs || 0) / 1000;
        const end = start + (e.dDurationMs || 0) / 1000;
        const text = e.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
        return { start, end, text };
      })
      .filter((c) => c.text);
  }

  // Get captions via YouTube's own machinery. The auto-preload it fires on load is
  // often ABORTED (status 0) before delivering a body, so a captured record is not
  // proof of a usable response — we treat status as diagnostic only. If we don't
  // already hold a completed body, nudge YouTube to actually fetch+complete a caption
  // file (same source the transcript panel uses) and read its response; refetch the
  // captured URL ourselves only as a fallback.
  // A compact machine-state string appended to every caption error, so a
  // screenshot tells us exactly which mechanism broke when YouTube changes things.
  function capDiagStr(rec) {
    const uw = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? 'yes' : 'no';
    const bits = [
      `hook=${ttHookInstalled ? 'ok' : (ttHookError ? 'fail' : 'off')}`,
      `unsafeWindow=${uw}`,
      `timedtext=${ttSeen}`,
    ];
    bits.push(`nudge=${lastNudge}`);
    bits.push(`attempt=${distillAttempts}`);
    if (rec && rec.status != null) bits.push(`ytStatus=${rec.status}`);
    return bits.join(' · ');
  }

  // Build a caption error carrying: a human message, a `capKind` (which mechanism),
  // a `transient` flag (retry vs. the script needs updating), and the diag string.
  function capError(msg, kind, opts) {
    const e = new Error(msg);
    e.capKind = kind;
    e.transient = !!(opts && opts.transient);
    e.capDiag = capDiagStr(opts && opts.rec);
    return e;
  }

  function cuesFrom(rec) {
    let cues;
    try { cues = parseJson3(rec.body); }
    catch (e) {
      throw capError(`Couldn't parse YouTube's caption data — the caption format may have changed. (${(e && e.message) || e})`, 'parsefail', { rec });
    }
    if (!cues.length) throw capError('YouTube returned caption data with no cues.', 'nocues', { rec });
    return { cues, source: /[?&]kind=asr/.test(rec.url || '') ? 'auto_captions' : 'manual_captions' };
  }

  async function acquireCues(pr) {
    const id = getVideoId();
    let rec = capturedTT[id];
    const tracks = captionTracks(pr);

    // Genuinely no captions -> say so plainly (unless we somehow already captured one).
    if (!tracks.length && !(rec && (rec.body || rec.url))) {
      throw capError('This video has no captions or transcript to distill.', 'nocaptions', { rec });
    }

    let nudge = 'skipped';
    if (!rec || !rec.body) {                            // no completed body yet -> make YouTube fetch one
      const lang = preferredLang(tracks);
      nudge = nudgeCaptions(true, lang);
      lastNudge = nudge;
      for (let i = 0; i < 30; i++) {                    // wait up to ~9s for a completed caption body
        await sleep(300);
        rec = capturedTT[id];
        if (rec && rec.body) break;
        // If no caption request has even STARTED yet, the player likely wasn't ready
        // when we first nudged (loadModule is async) or the module wedged — re-nudge
        // every ~1.5s, resetting the captions module to un-stick a wedged one.
        if (nudge === 'ok' && !(rec && rec.url) && i % 5 === 4) nudgeCaptions(true, lang, true);
      }
      if (nudge === 'ok') nudgeCaptions(false);
      rec = capturedTT[id];
    }

    if (rec && rec.body) return cuesFrom(rec);          // YouTube's own completed response — no extra request

    if (rec && rec.url) {                               // fallback: refetch the pot URL ourselves
      try { rec.body = await fetchTimedtext(rec.url); }
      catch (e) { throw capError((e && e.message) || String(e), 'fetchfail', { rec, transient: true }); }
      return cuesFrom(rec);
    }

    // Nothing usable was captured — classify why so the message is actionable.
    if (ttHookError) throw capError(`Couldn't read YouTube's captions: the page network hook failed to install (${ttHookError}). Tampermonkey may be blocking cross-world access.`, 'hookfail', { rec });
    if (!ttHookInstalled) throw capError("Couldn't read YouTube's captions: the page network hook isn't installed.", 'hookfail', { rec });
    if (nudge === 'noapi' || nudge === 'error') throw capError("Couldn't activate YouTube's captions — its player caption API (loadModule/setOption) may have changed.", 'apichange', { rec });
    throw capError('YouTube made no caption request after captions were activated.', 'norequest', { rec, transient: true });
  }

  function overlap(prevTail, cur, maxWin = 60) {
    const lim = Math.min(prevTail.length, cur.length, maxWin);
    for (let k = lim; k > 0; k--) {
      let ok = true;
      for (let i = 0; i < k; i++) { if (prevTail[prevTail.length - k + i] !== cur[i]) { ok = false; break; } }
      if (ok) return k;
    }
    return 0;
  }

  function dedupeRolling(cues) {
    const words = [];
    for (const c of cues) {
      const toks = c.text.split(/\s+/).filter(Boolean);
      if (!toks.length) continue;
      const tail = words.slice(-60).map((x) => x.w);
      const k = overlap(tail, toks);
      for (let i = k; i < toks.length; i++) words.push({ w: toks[i], start: c.start });
    }
    return words;
  }

  function flattenCues(cues) {
    const words = [];
    for (const c of cues) for (const w of c.text.split(/\s+/).filter(Boolean)) words.push({ w, start: c.start });
    return words;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function toTranscript(words, interval) {
    const out = [];
    let last = -1;
    for (const { w, start } of words) {
      const b = Math.floor(start / interval);
      if (b !== last) { const t = b * interval; out.push(`[${pad2(Math.floor(t / 60))}:${pad2(t % 60)}]`); last = b; }
      out.push(w);
    }
    return out.join(' ');
  }

  function cleanCaptions(cues, source) {
    const words = source === 'auto_captions' ? dedupeRolling(cues) : flattenCues(cues);
    return toTranscript(words, MARKER_INTERVAL);
  }

  // ===== SponsorBlock =====
  async function getSponsorSegments(videoId) {
    try {
      const cats = encodeURIComponent(JSON.stringify(['sponsor', 'selfpromo', 'interaction', 'intro', 'outro']));
      const resp = await gmXhr({ method: 'GET', url: `https://sponsor.ajay.app/api/skipSegments?videoID=${encodeURIComponent(videoId)}&categories=${cats}`, timeout: 15000 }, 'sponsorblock');
      if (resp.status === 404) return [];
      return (JSON.parse(resp.responseText) || []).map((s) => s.segment);
    } catch (e) { return []; }
  }

  function filterCues(cues, segments) {
    if (!segments.length) return cues;
    return cues.filter((c) => {
      const mid = (c.start + c.end) / 2;
      return !segments.some(([a, b]) => a <= mid && mid <= b);
    });
  }

  // ===== OpenAI =====
  function fmtDuration(sec) {
    sec = Math.floor(sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
  }

  function buildUserContent(meta, transcript) {
    const parts = [
      `Title: ${meta.title}`,
      `Channel: ${meta.channel}`,
      `Duration: ${fmtDuration(meta.duration_s)}`,
    ];
    if (meta.description) parts.push('Description (first 500 chars):\n' + meta.description.slice(0, 500));
    parts.push('Transcript (machine-generated, [mm:ss] markers every ~30s):\n' + transcript);
    return parts.join('\n\n');
  }

  async function distill(meta, transcript, key) {
    const body = {
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserContent(meta, transcript) },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'distillation', strict: true, schema: SCHEMA } },
    };
    const resp = await gmXhr({
      method: 'POST',
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      data: JSON.stringify(body),
    }, 'OpenAI');
    if (resp.status === 401) {
      gmSet(KEY_STORE, '');   // drop the bad key so Retry re-prompts for a fresh one
      throw new Error('OpenAI rejected the API key (HTTP 401). It has been cleared — click Retry to enter a new one.');
    }
    if (resp.status === 429) {
      throw new Error('OpenAI is rate-limiting or the account is out of quota (HTTP 429). Wait a moment and Retry.');
    }
    if (resp.status < 200 || resp.status >= 300) {
      let detail = (resp.responseText || '').slice(0, 200);
      try { detail = JSON.parse(resp.responseText).error.message || detail; } catch (e) { /* keep raw */ }
      throw new Error(`OpenAI request failed (HTTP ${resp.status}): ${detail}`);
    }
    const data = JSON.parse(resp.responseText);
    return JSON.parse(data.choices[0].message.content);
  }

  function estimateReadSeconds(s) {
    let words = (s.payload || '').split(/\s+/).length;
    if (s.tease) words += (s.tease.answer || '').split(/\s+/).length;
    for (const p of s.points || []) words += (p.label + ' ' + p.detail).split(/\s+/).length;
    for (const n of s.notes || []) words += n.split(/\s+/).length;
    return Math.max(5, Math.round(words / 3.3));
  }

  // ===== overlay UI (shadow DOM) =====
  let overlayHost = null;

  function seekTo(seconds) {
    allowPlayUntil = Date.now() + 4000;   // this is user-initiated — let it play past the autoplay guard
    // Seek via YouTube's own player API (robust in Safari); fall back to the raw <video>.
    let seeked = false;
    try {
      const mp = PAGE.document.getElementById('movie_player');
      if (mp && typeof mp.seekTo === 'function') { mp.seekTo(seconds, true); if (mp.playVideo) mp.playVideo(); seeked = true; }
    } catch (e) { /* fall back */ }
    if (!seeked) {
      const v = document.querySelector('video');
      if (v) { try { v.currentTime = seconds; v.play && v.play(); } catch (e) { /* ignore */ } }
    }
    // Reflect the position in the address bar too (shareable, like YouTube's native &t= links).
    try { const u = new URL(location.href); u.searchParams.set('t', seconds + 's'); history.replaceState(history.state, '', u.toString()); } catch (e) { /* ignore */ }
    closeOverlay();
  }

  // DOM builder — no innerHTML, no HTML strings, so nothing reaches a
  // Trusted-Types-governed sink (YouTube enforces require-trusted-types-for).
  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.indexOf('data-') === 0) e.setAttribute(k, v);
        else e[k] = v;
      }
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  function tsNode(atS) {
    if (atS === null || atS === undefined) return null;
    // Real &t= deep link for the current video: the seconds are visible in the URL,
    // cmd-click opens it in a new tab, and a plain click is intercepted to seek in place.
    let href = '#';
    try { const u = new URL(location.href); u.searchParams.set('t', atS + 's'); href = u.toString(); } catch (e) { /* keep # */ }
    return h('a', { class: 'ts', href, 'data-seek': String(atS), text: `[${fmtDuration(atS)}]` });
  }

  function closeButton() {
    return h('button', { class: 'close', title: 'Close (Esc)', text: '×' });
  }

  function quietBlock(title, items, isGaps) {
    const ul = h('ul');
    for (const it of items) ul.append(h('li', { text: it }));
    return h('div', { class: isGaps ? 'quiet gaps' : 'quiet' }, h('h2', { text: title }), ul);
  }

  function spinnerNode() { return h('span', { class: 'spinner' }); }

  function stepIcon(state) {
    if (state === 'active') return spinnerNode();
    if (state === 'done') return h('span', { class: 'ico done', text: '✓' });
    return h('span', { class: 'ico pending', text: '•' });
  }

  // A staged progress view: header spinner + a checklist that advances. Returns
  // { node, set(key) } — set() marks steps before `key` done, `key` active, rest pending.
  function makeProgress(steps) {
    const frag = document.createDocumentFragment();
    frag.append(closeButton());
    frag.append(h('div', { class: 'ph' }, h('span', { text: 'Distilling…' })));
    const list = h('div', { class: 'steps' });
    const rows = Object.create(null);
    const order = [];
    for (const st of steps) {
      const ico = stepIcon('pending');
      const row = h('div', { class: 'step', 'data-state': 'pending' }, ico, h('span', { class: 'lbl', text: st.label }));
      row.__ico = ico;
      rows[st.key] = row;
      order.push(st.key);
      list.append(row);
    }
    frag.append(list);
    function paint(key, state) {
      const row = rows[key];
      if (!row || row.getAttribute('data-state') === state) return;
      row.setAttribute('data-state', state);
      const ni = stepIcon(state);
      row.replaceChild(ni, row.__ico);
      row.__ico = ni;
    }
    return {
      node: frag,
      set(key) {
        const idx = order.indexOf(key);
        order.forEach((k, i) => paint(k, i < idx ? 'done' : i === idx ? 'active' : 'pending'));
      },
    };
  }

  // Classic two-rectangles "copy" glyph, built as SVG (no innerHTML → Trusted-Types safe).
  function copyIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '14', height: '14', fill: 'none',
      stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
    const rect = document.createElementNS(NS, 'rect');
    for (const [k, v] of Object.entries({ x: '9', y: '9', width: '13', height: '13', rx: '2', ry: '2' })) rect.setAttribute(k, v);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');
    svg.append(rect, path);
    return svg;
  }

  // Plaintext/markdown failure report — copyable so it can be pasted instead of screenshotted.
  function failureReport(err, ctx) {
    const msg = (err && err.message) || String(err);
    const diag = (err && err.capDiag) || '';
    const title = (ctx && ctx.title) || '';
    const url = (ctx && ctx.url) || location.href;
    return [
      '**ytdistill couldn’t finish**',
      title ? `- Video: ${title}` : null,
      `- URL: ${url}`,
      `- Error: ${msg}`,
      diag ? `- Diagnostics: \`${diag}\`` : null,
      `- Version: v${VERSION} · ${MODEL}`,
    ].filter(Boolean).join('\n');
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    } catch (e) { /* fall through */ }
    return new Promise((resolve, reject) => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('copy failed'));
      } catch (e) { reject(e); }
    });
  }

  // A helpful error view: message + transient/structural hint + machine diagnostics
  // + Retry and Copy buttons. Threaded from any thrown error (caption errors carry capKind).
  function buildError(err, ctx) {
    const msg = (err && err.message) || String(err);
    const kind = err && err.capKind;
    const diag = err && err.capDiag;
    const url = (ctx && ctx.url) || location.href;
    const title = (ctx && ctx.title) || document.title.replace(/ - YouTube$/, '');
    let hint;
    if (err && err.transient) hint = 'This is usually temporary — Retry now, or try again from a different network/VPN.';
    else if (kind === 'nocaptions') hint = 'Only videos with captions (or an auto-generated transcript) can be distilled.';
    else if (kind === 'hookfail' || kind === 'apichange' || kind === 'parsefail' || kind === 'nocues') {
      hint = 'This looks like YouTube changed something ytdistill relies on. If it keeps happening, the script needs an update — the line below says which mechanism broke.';
    } else {
      hint = 'Try again; if it persists, YouTube may have changed something ytdistill depends on.';
    }

    const frag = document.createDocumentFragment();
    frag.append(closeButton());
    frag.append(h('div', { class: 'err-title', text: 'ytdistill couldn’t finish' }));
    frag.append(h('p', { class: 'err-msg', text: msg }));
    frag.append(h('p', { class: 'err-hint', text: hint }));

    // Repro context — so the whole failure can be reproduced from a screenshot alone.
    const repro = h('div', { class: 'err-ctx' });
    if (title) repro.append(h('div', { class: 'ctx-title', text: title }));
    if (url) repro.append(h('div', { class: 'ctx-url', text: url }));
    if (title || url) frag.append(repro);
    if (diag) frag.append(h('p', { class: 'err-diag', text: diag }));

    const retry = h('button', { class: 'btn', text: 'Retry' });
    retry.addEventListener('click', () => { closeOverlay(); runDistill(); });

    const copyLabel = h('span', { text: 'Copy' });
    const copy = h('button', { class: 'btn ghost', title: 'Copy failure report' }, copyIcon(), copyLabel);
    copy.addEventListener('click', () => {
      copyText(failureReport(err, { url, title }))
        .then(() => { copyLabel.textContent = 'Copied'; setTimeout(() => { copyLabel.textContent = 'Copy'; }, 1500); })
        .catch(() => { copyLabel.textContent = 'Copy failed'; });
    });

    frag.append(h('div', { class: 'btn-row' }, retry, copy));
    frag.append(h('div', { class: 'footer', text: `ytdistill v${VERSION} · ${MODEL}` }));
    return frag;
  }

  function buildSummary(s, meta) {
    const read = estimateReadSeconds(s);
    const saved = Math.max(0, meta.duration_s - read);
    const frag = document.createDocumentFragment();
    frag.append(closeButton());
    frag.append(h('h1', { text: meta.title }));
    frag.append(h('div', { class: 'meta' },
      `${meta.channel} · ${fmtDuration(meta.duration_s)} · ~${read}s read vs ${fmtDuration(meta.duration_s)} watch · saves ~${fmtDuration(saved)} · `,
      h('span', { class: 'kind', text: s.kind })));
    frag.append(h('p', { class: 'payload', text: s.payload }));

    if (meta.thumbnails && meta.thumbnails.length) {
      const strip = h('div', { class: 'thumbs' });
      meta.thumbnails.slice().sort((a, b) => (b.width * b.height) - (a.width * a.height)).slice(0, 4)
        .forEach((t) => strip.append(h('img', { src: t.url, alt: '', loading: 'lazy' })));
      frag.append(strip);
    }
    if (s.tease) {
      const ans = h('div', { class: 'a' }, `${s.tease.answer} `);
      const t = tsNode(s.tease.answered_at_s); if (t) ans.append(t);
      frag.append(h('div', { class: 'tease' }, h('div', { class: 'q', text: s.tease.question }), ans));
    }
    if (s.points && s.points.length) {
      const ol = h('ol', { class: 'points' });
      for (const p of s.points) {
        const li = h('li', null, h('span', { class: 'label', text: p.label }), ` — ${p.detail} `);
        const t = tsNode(p.at_s); if (t) li.append(t);
        ol.append(li);
      }
      frag.append(ol);
    }
    if (s.notes && s.notes.length) frag.append(quietBlock('Notes', s.notes, false));
    if (s.gaps && s.gaps.length) frag.append(quietBlock('Gaps', s.gaps, true));

    const st = statsSummary();
    frag.append(h('div', { class: 'foot' },
      h('div', { class: 'scoreboard', text: `⏱ ${fmtSaved(st.today)} saved today · ${fmtSaved(st.week)} this week · ${fmtSaved(st.all)} all-time` }),
      h('div', { class: 'footer', text: `ytdistill v${VERSION} · ${MODEL}` })));
    return frag;
  }

  const OVERLAY_CSS = `
    :host { all: initial; }
    .wrap { position: fixed; inset: 0; z-index: 2147483647; overflow-y: auto;
      background: rgba(20,20,22,0.97); color: #e8e8ea; line-height: 1.5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    @media (prefers-color-scheme: light) { .wrap { background: rgba(255,255,255,0.98); color: #1a1a1a; } }
    .inner { max-width: 720px; margin: 0 auto; padding: 48px 24px 96px; position: relative; }
    .close { position: fixed; top: 16px; right: 20px; font-size: 28px; line-height: 1;
      background: none; border: none; color: inherit; cursor: pointer; opacity: .6; }
    .close:hover { opacity: 1; }
    h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 6px; }
    .meta { color: #9a9aa2; font-size: .85rem; margin: 0 0 24px; }
    .kind { text-transform: uppercase; letter-spacing: .05em; font-size: .72rem; }
    .payload { font-size: 1.45rem; line-height: 1.4; font-weight: 600; margin: 0 0 28px; }
    .thumbs { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 8px; margin: 0 0 28px; }
    .thumbs img { height: 96px; border-radius: 6px; }
    .tease { border-left: 3px solid #6db3ff; padding: 2px 14px; margin: 0 0 24px; }
    .tease .q { color: #9a9aa2; margin-bottom: 4px; }
    .tease .a { font-weight: 600; }
    ol.points { padding-left: 1.4em; margin: 0 0 24px; }
    ol.points li { margin: 0 0 12px; }
    ol.points .label { font-weight: 600; }
    a.ts { color: #6db3ff; text-decoration: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
    a.ts:hover { text-decoration: underline; }
    .quiet { background: rgba(255,255,255,0.06); border-radius: 8px; padding: 12px 16px; margin: 0 0 16px; }
    @media (prefers-color-scheme: light) { .quiet { background: #f4f4f5; } }
    .quiet h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: #9a9aa2; margin: 0 0 8px; }
    .quiet ul { margin: 0; padding-left: 1.2em; } .quiet li { margin: 0 0 6px; font-size: .92rem; }
    .footer { color: #9a9aa2; font-size: .72rem; margin-top: 40px; }
    .foot { margin-top: 40px; }
    .foot .footer { margin-top: 5px; }
    .scoreboard { color: #cfcfd4; font-size: .85rem; }
    @media (prefers-color-scheme: light) { .scoreboard { color: #444; } }
    .loading, .error { font-size: 1.1rem; padding: 40px 0; }
    .error { color: #ff6b6b; white-space: pre-wrap; }

    /* progress (staged loading) */
    .ph { display: flex; align-items: center; gap: 12px; font-size: 1.2rem; font-weight: 600; margin: 8px 0 26px; }
    .spinner { width: 18px; height: 18px; border: 2px solid rgba(128,128,128,.35); border-top-color: #6db3ff;
      border-radius: 50%; box-sizing: border-box; flex: none; animation: ytd-spin .8s linear infinite; }
    @keyframes ytd-spin { to { transform: rotate(360deg); } }
    .steps { display: flex; flex-direction: column; gap: 14px; }
    .step { display: flex; align-items: center; gap: 12px; font-size: 1.02rem; transition: opacity .25s; }
    .step[data-state="pending"] { opacity: .4; }
    .step[data-state="done"] { opacity: .65; }
    .step .ico { width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; flex: none; font-weight: 700; }
    .step .ico.done { color: #57c98a; }
    .step .ico.pending { color: #9a9aa2; }

    /* error view */
    .err-title { color: #ff6b6b; font-size: 1.2rem; font-weight: 700; margin: 0 0 10px; }
    .err-msg { font-size: 1.02rem; line-height: 1.5; margin: 0; white-space: pre-wrap; }
    .err-hint { color: #cfcfd4; font-size: .95rem; margin: 12px 0 0; }
    @media (prefers-color-scheme: light) { .err-hint { color: #444; } }
    .err-ctx { margin: 16px 0 0; }
    .err-ctx .ctx-title { color: #cfcfd4; font-size: .9rem; font-weight: 600; margin-bottom: 3px; }
    .err-ctx .ctx-url { color: #9a9aa2; font-size: .78rem; word-break: break-all;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .err-diag { color: #9a9aa2; font-size: .76rem; margin: 10px 0 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
    .btn-row { display: flex; gap: 10px; align-items: center; margin-top: 22px; }
    .btn { display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 16px;
      border: none; border-radius: 17px; cursor: pointer; font: 600 13px/1 -apple-system, system-ui, sans-serif;
      background: #6db3ff; color: #0a0a0a; }
    .btn:hover { filter: brightness(1.08); }
    .btn.ghost { background: transparent; color: #cfcfd4; border: 1px solid rgba(255,255,255,.25); }
    .btn.ghost:hover { background: rgba(255,255,255,.08); filter: none; }
    @media (prefers-color-scheme: light) { .btn.ghost { color: #444; border-color: rgba(0,0,0,.2); }
      .btn.ghost:hover { background: rgba(0,0,0,.05); } }
    .btn svg { display: block; }
  `;

  function ensureOverlay() {
    if (overlayHost && overlayHost.isConnected) return overlayHost;
    if (overlayHost) { try { document.body.appendChild(overlayHost); return overlayHost; } catch (e) { /* rebuild below */ } }
    overlayHost = document.createElement('div');
    overlayHost.id = OVERLAY_ID;
    const shadow = overlayHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const inner = document.createElement('div');
    inner.className = 'inner';
    wrap.appendChild(inner);
    shadow.append(style, wrap);
    document.body.appendChild(overlayHost);
    // events (delegated inside the shadow root)
    wrap.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a.ts');
      if (a) {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;   // let the browser open the real &t= deep link
        e.preventDefault(); seekTo(parseInt(a.dataset.seek, 10)); return;
      }
      if (e.target.classList && e.target.classList.contains('close')) closeOverlay();
    });
    return overlayHost;
  }

  function setOverlayContent(node) {
    ensureOverlay();
    overlayHost.shadowRoot.querySelector('.inner').replaceChildren(node);
    overlayHost.style.display = 'block';
  }

  function closeOverlay() { if (overlayHost) overlayHost.style.display = 'none'; }
  function overlayVisible() { return overlayHost && overlayHost.style.display !== 'none'; }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlayVisible()) closeOverlay(); }, true);

  // ===== distill mode + time-saved scoreboard =====
  function modeOn() { return !!gmGet(MODE_STORE, false); }
  function setMode(on) { gmSet(MODE_STORE, !!on); }

  // A page should behave "distilled" (no autoplay, auto-summary) when global mode is
  // on, or when it was opened just to distill (a #ytdistill hash from a Distill action).
  function distillArrival() {
    return modeOn() || location.hash === HASH_TRIGGER || /[?&]ytdistill=1\b/.test(location.search);
  }

  // Never let a video play during a distilled arrival — the point is not to watch, and
  // (bonus) not decoding video eases Safari's GPU. A timestamp click grants a short
  // window so seek-to-play still works.
  let allowPlayUntil = 0;
  function installPlayGuard() {
    try {
      document.addEventListener('play', (e) => {
        try {
          if (!distillArrival() || Date.now() < allowPlayUntil) return;
          const t = e.target;
          if (t && t.tagName === 'VIDEO' && !t.paused) t.pause();
        } catch (err) { /* noop */ }
      }, true);
    } catch (e) { /* noop */ }
  }

  // Auto-run a distill on arrival when appropriate; one-shot per video id, never prompts
  // for a key, and waits (via startAutoDistillLoop) until the player data is ready.
  let autoDistilledFor = null;
  function maybeAutoDistill() {
    if (!location.pathname.startsWith('/watch')) return;
    const id = getVideoId();
    if (!id || autoDistilledFor === id) return;
    if (!distillArrival() || !gmGet(KEY_STORE, '') || !getPlayerResponse()) return;
    autoDistilledFor = id;
    if (location.hash === HASH_TRIGGER) {          // one-shot trigger: drop it so the page is normal afterward
      try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) { /* noop */ }
    }
    runDistill();
  }
  function startAutoDistillLoop() {
    let n = 0;
    const iv = setInterval(() => {
      maybeAutoDistill();
      const id = getVideoId();
      if ((id && autoDistilledFor === id) || ++n > 40) clearInterval(iv);   // ~10s to become ready
    }, 250);
    maybeAutoDistill();
  }

  // Time-saved scoreboard, persisted in GM storage; each video is counted once, ever.
  function loadStats() {
    let s = {};
    try { s = JSON.parse(gmGet(STATS_STORE, '') || '{}'); } catch (e) { s = {}; }
    return { allTime: s.allTime || 0, seen: Array.isArray(s.seen) ? s.seen : [], events: Array.isArray(s.events) ? s.events : [] };
  }
  function recordSaved(videoId, savedSec) {
    if (!videoId || !(savedSec > 0)) return;
    const s = loadStats();
    if (s.seen.indexOf(videoId) !== -1) return;    // don't double-count re-distills of the same video
    s.seen.push(videoId);
    s.allTime += savedSec;
    const now = Date.now();
    s.events.push({ t: now, s: savedSec });
    const cutoff = now - 8 * 86400000;             // keep ~8 days for the today/week windows
    s.events = s.events.filter((e) => e.t >= cutoff);
    try { gmSet(STATS_STORE, JSON.stringify(s)); } catch (e) { /* noop */ }
  }
  function statsSummary() {
    const s = loadStats();
    const d = new Date();
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const weekAgo = Date.now() - 7 * 86400000;
    let today = 0, week = 0;
    for (const e of s.events) { if (e.t >= midnight) today += e.s; if (e.t >= weekAgo) week += e.s; }
    return { today, week, all: s.allTime };
  }
  function fmtSaved(sec) {
    sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${sec}s`;
  }

  // ===== orchestration =====
  let busy = false;

  async function runDistill() {
    if (busy) return;
    if (overlayVisible()) { closeOverlay(); return; }

    const videoId = getVideoId();
    if (!videoId) return;

    // instant re-open from cache
    const cached = gmGet(CACHE_PREFIX + videoId, null);
    if (cached) {
      try { const { summary, meta } = JSON.parse(cached); setOverlayContent(buildSummary(summary, meta)); return; } catch (e) { /* recompute */ }
    }

    const key = getKey();
    if (!key) return;

    busy = true;
    distillAttempts++;
    const prog = makeProgress([
      { key: 'captions', label: 'Grabbing captions' },
      { key: 'sponsor', label: 'Checking SponsorBlock' },
      { key: 'summary', label: `Summarizing (${MODEL})` },
    ]);
    setOverlayContent(prog.node);
    const v = document.querySelector('video');
    if (v && !v.paused) v.pause();

    let meta = null;
    try {
      const pr = getPlayerResponse();
      if (!pr) throw new Error('Could not read this video’s player data — YouTube’s player API may have changed (update ytdistill).');
      meta = getMeta(pr);

      prog.set('captions');
      const { cues, source } = await acquireCues(pr);

      prog.set('sponsor');
      const segments = await getSponsorSegments(meta.video_id);
      const transcript = cleanCaptions(filterCues(cues, segments), source);
      if (!transcript.trim()) throw new Error('The caption track was empty after cleaning — nothing to summarize.');

      prog.set('summary');
      const summary = await distill(meta, transcript, key);
      gmSet(CACHE_PREFIX + videoId, JSON.stringify({ summary, meta }));
      recordSaved(videoId, Math.max(0, meta.duration_s - estimateReadSeconds(summary)));
      setOverlayContent(buildSummary(summary, meta));
    } catch (err) {
      setOverlayContent(buildError(err, { url: location.href, title: meta && meta.title }));
    } finally {
      busy = false;
    }
  }

  // ===== button injection + SPA nav =====
  function createButton() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.textContent = '✦ Distill';
    btn.title = 'Distill this video (ytdistill)';
    btn.style.cssText = [
      'display:inline-flex', 'align-items:center', 'height:36px', 'padding:0 16px',
      'margin-left:8px', 'border:none', 'border-radius:18px', 'cursor:pointer',
      'font:500 14px/1 "Roboto","Arial",sans-serif',
      'background:var(--yt-spec-badge-chip-background, rgba(255,255,255,0.1))',
      'color:var(--yt-spec-text-primary, #f1f1f1)',
    ].join(';');
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); runDistill(); });
    return btn;
  }

  // "Auto-distill" toggle — persists globally. When on, every /watch page skips autoplay
  // and summarizes itself automatically.
  function createModeToggle() {
    const btn = document.createElement('button');
    btn.id = MODE_BTN_ID;
    const base = ['display:inline-flex', 'align-items:center', 'gap:6px', 'height:36px', 'padding:0 14px',
      'margin-left:8px', 'border-radius:18px', 'cursor:pointer', 'font:500 14px/1 "Roboto","Arial",sans-serif', 'border:1px solid transparent'];
    function paint() {
      const on = modeOn();
      btn.textContent = on ? '⚡ Auto-distill: On' : '⚡ Auto-distill: Off';
      btn.style.cssText = base.concat(on
        ? ['background:#3ea6ff', 'color:#0a0a0a', 'border-color:#3ea6ff']
        : ['background:var(--yt-spec-badge-chip-background, rgba(255,255,255,0.1))', 'color:var(--yt-spec-text-secondary, #aaa)']
      ).join(';');
      btn.title = on
        ? 'Auto-distill is ON — new videos don’t autoplay and get summarized automatically. Click to turn off.'
        : 'Turn ON auto-distill — new videos don’t autoplay and get summarized automatically.';
    }
    paint();
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      setMode(!modeOn()); paint();
      if (modeOn()) startAutoDistillLoop();   // distill the current page right away when enabling
    });
    return btn;
  }

  function injectButton() {
    if (!location.pathname.startsWith('/watch')) return;
    if (document.getElementById(BTN_ID)) return;
    const host = document.querySelector('ytd-watch-metadata #title, #title.ytd-watch-metadata, h1.ytd-watch-metadata');
    if (!host) return;
    host.appendChild(createButton());
    host.appendChild(createModeToggle());
  }

  function startInjectLoop() {
    let n = 0;
    const iv = setInterval(() => {
      injectButton();
      if (document.getElementById(BTN_ID) || ++n > 40) clearInterval(iv);
    }, 250);
    injectButton();
  }

  // Seeded on init so the first post-load settling events aren't mistaken for a nav.
  let lastNavId = getVideoId();
  function onNavigate() {
    const id = getVideoId();
    if (id !== lastNavId) {                 // a REAL navigation to a different video
      lastNavId = id;
      const old = document.getElementById(BTN_ID); if (old) old.remove();
      const oldToggle = document.getElementById(MODE_BTN_ID); if (oldToggle) oldToggle.remove();
      closeOverlay();
      autoDistilledFor = null;              // let the new video auto-distill
    }
    // Same-video "settling" re-layouts fire these events repeatedly — don't tear the
    // overlay down for those; just make sure our controls are (re)present.
    if (location.pathname.startsWith('/watch')) { startInjectLoop(); startAutoDistillLoop(); }
  }

  // Install the page hooks FIRST (document-start) so they're in place before YouTube
  // fires its caption XHR / autoplays; then the DOM/button work, which tolerates a
  // late-loading page via its retry loop.
  installTimedtextHook();
  installPlayGuard();
  window.addEventListener('yt-navigate-finish', onNavigate);
  window.addEventListener('yt-page-data-updated', onNavigate);
  if (location.pathname.startsWith('/watch')) { startInjectLoop(); startAutoDistillLoop(); }
})();
