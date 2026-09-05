// ==UserScript==
// @name         YouTube Mark Watched (PoC)
// @namespace    https://github.com/prwhite
// @version      0.5.0
// @description  PROOF OF CONCEPT — mark the current video watched (playhead→end, syncs to phone/TV) via a real session + hidden-flush; un-mark by removing it from watch history. On-demand only.
// @author       prwhite
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * WHY THIS EXISTS
 * ---------------
 * A desktop-only "read" dot can't reach the phone app or Apple TV. The one signal that
 * syncs across every surface is YouTube's server-side watch progress (the red bar /
 * resume position). Distilled videos sit at 0. This writes it — and can retract it.
 *
 * MARK WATCHED (verified 2026-09-02..03 against the live site + network traces)
 * ----------------------------------------------------------------------------
 * - Forging a stats/watchtime ping (synthetic cpn) → 204 but IGNORED. Progress only
 *   counts for a ping tied to a REAL session (real cpn + real media).
 * - A genuine playthrough doesn't record while the tab stays open. YouTube commits the
 *   position on the page-hide/unload flush (also fired on SPA video-switch), not the
 *   in-page pings. And you don't need to play THROUGH — a seek moves the playhead and
 *   the flush reports where it lands — BUT you must flush WHILE the session is still
 *   active near the end (a post-ENDED flush emits nothing).
 * - Recipe: mute + play → seek to the last ~2s → let it reach ~99.6% (still playing) →
 *   simulate tab-hide (spoof visibilityState + dispatch visibilitychange & pagehide) so
 *   the player emits its own commit ping. Cost: ~1-2s muted playback (brief GPU spin).
 *
 * UN-MARK / RESET (the important discovery)
 * -----------------------------------------
 * You CANNOT "reset to 0" through the player: watchtime only ever ADVANCES the furthest
 * position (seeking backward produces no ping — verified). The server's watched state is
 * monotonic. The real retract is "Remove from watch history": browse FEhistory → find
 * this video's removal feedbackToken → POST youtubei/v1/feedback. A pure API call — no
 * playback, no player teardown — and it clears the bar everywhere.
 *
 * TO CONFIRM ON YOUR ACCOUNT: Mark → History / full thumbnail bar / phone+TV. Un-mark →
 * that bar CLEARS. Test throwaway videos, not in a playlist. The same recipe is wired
 * into ytdistill (auto-mark after a distill + the overlay's watched pill).
 */

(function () {
  'use strict';

  const BTN_ID = 'ytmw-poc-btn';
  const LOG_ID = 'ytmw-poc-log';

  function player() { return document.getElementById('movie_player'); }

  function playerResponse() {
    try {
      const mp = player();
      if (mp && typeof mp.getPlayerResponse === 'function') {
        const pr = mp.getPlayerResponse();
        if (pr && pr.videoDetails) return pr;
      }
    } catch (e) { /* fall through */ }
    try { if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse; } catch (e) { /* noop */ }
    return null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { try { if (pred()) return true; } catch (e) { /* keep polling */ } await sleep(150); }
    return false;
  }

  function log(msg) {
    // eslint-disable-next-line no-console
    console.log('[YT Mark Watched PoC]', msg);
    const el = document.getElementById(LOG_ID);
    if (el) { el.textContent = msg; el.style.opacity = '1'; }
  }

  // ===== YouTube InnerTube auth (SAPISIDHASH) — same pattern as the WL scripts =====
  function getClientVersion() {
    try { return window.ytcfg?.data_?.INNERTUBE_CLIENT_VERSION || window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') || '2.20250101.00.00'; }
    catch (e) { return '2.20250101.00.00'; }
  }
  function getApiKey() {
    try { return window.ytcfg?.data_?.INNERTUBE_API_KEY || window.ytcfg?.get?.('INNERTUBE_API_KEY') || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; }
    catch (e) { return 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; }
  }
  function getSapisid() {
    for (const name of ['SAPISID', '__Secure-3PAPISID', 'SAPISID1P']) {
      const m = document.cookie.match(new RegExp(`${name}=([^;]+)`));
      if (m) return m[1];
    }
    return null;
  }
  async function sapisidHash(sapisid, origin) {
    const ts = Math.floor(Date.now() / 1000);
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${ts} ${sapisid} ${origin}`));
    const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${ts}_${hex}`;
  }
  async function apiHeaders() {
    const origin = 'https://www.youtube.com';
    const h = { 'Content-Type': 'application/json', 'X-Origin': origin, 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': getClientVersion() };
    const sapisid = getSapisid();
    if (sapisid) { const hash = await sapisidHash(sapisid, origin); if (hash) h['Authorization'] = `SAPISIDHASH ${hash}`; }
    return h;
  }
  async function ytiPost(endpoint, extra) {
    const headers = await apiHeaders();
    if (!headers['Authorization']) throw new Error('not logged in (no SAPISID)');
    const body = Object.assign({ context: { client: { clientName: 'WEB', clientVersion: getClientVersion(), hl: 'en', gl: 'US' } } }, extra);
    const resp = await fetch(`https://www.youtube.com/youtubei/v1/${endpoint}?key=${getApiKey()}&prettyPrint=false`, {
      method: 'POST', headers, credentials: 'include', body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`${endpoint} HTTP ${resp.status}`);
    return resp.json();
  }

  // Find the "remove from watch history" feedbackToken for a videoId in the FEhistory
  // feed: the smallest subtree that contains BOTH the videoId and a feedbackToken.
  function tokenForVideo(root, videoId) {
    let answer = null;
    function walk(node) {
      if (!node || typeof node !== 'object') return { vid: false, tok: null };
      let vid = node.videoId === videoId;
      let tok = (typeof node.feedbackToken === 'string' && node.feedbackToken)
        || (node.feedbackEndpoint && node.feedbackEndpoint.feedbackToken) || null;
      for (const k in node) {
        const r = walk(node[k]);
        if (r.vid) vid = true;
        if (r.tok && !tok) tok = r.tok;
      }
      if (vid && tok && !answer) answer = tok;   // deepest co-occurrence wins (children set it first)
      return { vid, tok };
    }
    walk(root);
    return answer;
  }

  async function removeFromHistory(videoId) {
    const feed = await ytiPost('browse', { browseId: 'FEhistory' });
    const token = tokenForVideo(feed, videoId);
    if (!token) throw new Error('not found in watch history (already gone, or not recorded yet)');
    await ytiPost('feedback', { feedbackTokens: [token], isFeedbackTokenUnencrypted: false, shouldMerge: false });
    return true;
  }

  // ===== MARK WATCHED: real session + hidden-flush near the end =====
  function spoofHidden() {
    const saved = [];
    const set = (key, val) => {
      try {
        const own = Object.getOwnPropertyDescriptor(document, key);
        Object.defineProperty(document, key, { configurable: true, get: () => val });
        saved.push([key, own]);
      } catch (e) { /* noop */ }
    };
    set('visibilityState', 'hidden');
    set('hidden', true);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));   // pagehide is what actually fires the commit flush
    return function restore() {
      for (const [key, own] of saved) {
        try { if (own) Object.defineProperty(document, key, own); else delete document[key]; } catch (e) { /* noop */ }
      }
      try { document.dispatchEvent(new Event('visibilitychange')); } catch (e) { /* noop */ }
    };
  }

  let running = false;
  async function markWatched() {
    if (running) { log('Already running…'); return; }
    const mp = player();
    const pr = playerResponse();
    if (!mp || !pr || typeof mp.seekTo !== 'function') { log('Player not ready.'); return; }
    const vd = pr.videoDetails || {};
    const len = parseInt(vd.lengthSeconds || '0', 10);
    const vid = vd.videoId || '(unknown)';
    if (vd.isLiveContent || !len) { log('Live or no duration — cannot mark watched.'); return; }

    running = true;
    const gv = () => { try { return (mp.getVideoStats && mp.getVideoStats()) || {}; } catch (e) { return {}; } };
    const wasMuted = (() => { try { return mp.isMuted && mp.isMuted(); } catch (e) { return false; } })();
    let restore = null;

    try {
      log(`Marking watched: ${vid} (len=${len}s)…`);
      try { mp.mute(); } catch (e) { /* noop */ }
      mp.playVideo();
      const started = await waitFor(() => mp.getPlayerState() === 1 && gv().cpn && gv().el === 'detailpage', 12000);
      if (!started) { log(`${vid}: content never started (ad still running?). Try again in a moment.`); return; }
      const cpn = gv().cpn;

      // Seek to the last couple seconds and flush WHILE still playing (~99.6%). Do not
      // wait for ENDED — a post-ENDED flush commits nothing.
      mp.seekTo(Math.max(0, len - 2), true);
      mp.playVideo();
      await waitFor(() => mp.getCurrentTime() >= len - 0.4, 12000);
      const cmt = Math.round(mp.getCurrentTime());

      restore = spoofHidden();
      await sleep(1500);
      restore(); restore = null;

      try { mp.pauseVideo(); } catch (e) { /* noop */ }
      if (!wasMuted) { try { mp.unMute(); } catch (e) { /* noop */ } }
      log(`${vid}: marked WATCHED (cmt≈${cmt}/${len}) · cpn=${cpn}. Check History / thumbnail bar / phone+TV.`);
    } catch (e) {
      if (restore) { try { restore(); } catch (e2) { /* noop */ } }
      if (!wasMuted) { try { mp.unMute(); } catch (e2) { /* noop */ } }
      log(`${vid}: error — ${(e && e.message) || e}`);
    } finally {
      running = false;
    }
  }

  async function unmark() {
    if (running) { log('Already running…'); return; }
    const pr = playerResponse();
    const vid = (pr && pr.videoDetails && pr.videoDetails.videoId) || '';
    if (!vid) { log('No video.'); return; }
    running = true;
    try {
      log(`Un-marking ${vid} (removing from watch history)…`);
      await removeFromHistory(vid);
      log(`${vid}: removed from watch history ✓. Check the thumbnail bar / feed / phone+TV.`);
    } catch (e) {
      log(`${vid}: un-mark error — ${(e && e.message) || e}`);
    } finally {
      running = false;
    }
  }

  // ===== minimal UI: two fixed buttons, visible only on watch pages =====
  function mkButton(label, bg, fg, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:9px 14px;border:none;border-radius:18px;cursor:pointer;text-align:left;'
      + `background:${bg};color:${fg};box-shadow:0 2px 8px rgba(0,0,0,.4);`;
    b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    return b;
  }
  function ensureButton() {
    if (document.getElementById(BTN_ID)) return;
    const wrap = document.createElement('div');
    wrap.id = BTN_ID;
    wrap.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;display:flex;flex-direction:column;gap:6px;'
      + 'font:600 13px/1.3 "Roboto",Arial,sans-serif;';
    const out = document.createElement('div');
    out.id = LOG_ID;
    out.style.cssText = 'max-width:340px;padding:6px 10px;border-radius:8px;background:rgba(20,20,22,.92);'
      + 'color:#e8e8ea;opacity:0;transition:opacity .2s;white-space:pre-wrap;';
    wrap.append(
      mkButton('⏱ Mark watched (PoC)', '#3ea6ff', '#0a0a0a', markWatched),
      mkButton('↺ Un-mark / remove from history (PoC)', 'rgba(20,20,22,.92)', '#e8e8ea', unmark),
      out,
    );
    document.body.appendChild(wrap);
  }
  function removeButton() {
    const el = document.getElementById(BTN_ID);
    if (el) el.remove();
  }
  function sync() {
    if (location.pathname.startsWith('/watch')) ensureButton();
    else removeButton();
  }

  window.addEventListener('yt-navigate-finish', sync);
  window.addEventListener('yt-page-data-updated', sync);
  window.__ytMarkWatched = markWatched;   // console: __ytMarkWatched()
  window.__ytUnmark = unmark;             // console: __ytUnmark()
  sync();
})();
