// ==UserScript==
// @name         YouTube Playlist Quick Remove
// @namespace    https://github.com/prwhite
// @version      1.2.0
// @description  Adds a quick-remove (×) button to each video on any editable YouTube playlist page — Watch Later, Liked videos, and your own playlists — plus a one-click "Remove N watched" for the loaded videos you have already watched
// @author       prwhite
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/YouTubeWatchLaterPlaylistRemove.user.js
// @downloadURL  https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/YouTubeWatchLaterPlaylistRemove.user.js
// ==/UserScript==

(function() {
    'use strict';

    const PROCESSED_ATTR = 'data-pl-remove-processed';
    const REMOVED_ATTR = 'data-pl-removed';          // holds the setVideoId that was removed
    const BUTTON_CLASS = 'pl-quick-remove-btn';
    const BULK_BTN_ID = 'pl-remove-watched-btn';

    // "Watched", for the bulk button: this row's resume-playback progress (the red bar
    // under the thumbnail) is at or above this percent. YouTube doesn't document the
    // cutoff its own Watch Later "Remove watched videos" uses; 90 catches anything
    // played to the end (incl. ytdistill's auto-mark, which lands at ~99.6%) while
    // sparing videos you bailed on early.
    const WATCHED_PERCENT = 90;
    // setVideoIds per edit_playlist request. The endpoint's per-request limit isn't
    // documented; a rejected chunk falls back to one request per video.
    const BULK_CHUNK = 50;

    // X icon SVG path
    const ICON_X = 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';

    // ========== UTILITIES ==========

    function getClientVersion() {
        try {
            return window.ytcfg?.data_?.INNERTUBE_CLIENT_VERSION ||
                   window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') ||
                   '2.20241201.00.00';
        } catch (e) {
            return '2.20241201.00.00';
        }
    }

    function getApiKey() {
        try {
            return window.ytcfg?.data_?.INNERTUBE_API_KEY ||
                   window.ytcfg?.get?.('INNERTUBE_API_KEY') ||
                   'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
        } catch (e) {
            return 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
        }
    }

    // ========== PAGE DETECTION ==========

    // The playlist id lives in the ?list= param and is exactly what the edit
    // endpoint wants: 'WL' (Watch Later), 'LL' (Liked), or a 'PL…'/'FL…' id.
    function getPlaylistId() {
        if (window.location.pathname !== '/playlist') return null;
        return new URLSearchParams(window.location.search).get('list') || null;
    }

    function isPlaylistPage() {
        return !!getPlaylistId();
    }

    // ========== AUTHENTICATION ==========

    function getSapisid() {
        const cookieNames = ['SAPISID', '__Secure-3PAPISID', 'SAPISID1P'];
        for (const name of cookieNames) {
            const match = document.cookie.match(new RegExp(`${name}=([^;]+)`));
            if (match) return match[1];
        }
        return null;
    }

    async function generateSapisidHash(sapisid, origin) {
        const timestamp = Math.floor(Date.now() / 1000);
        const dataToHash = `${timestamp} ${sapisid} ${origin}`;

        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(dataToHash);
            const hashBuffer = await crypto.subtle.digest('SHA-1', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            return `${timestamp}_${hashHex}`;
        } catch (e) {
            return null;
        }
    }

    async function buildApiHeaders() {
        const sapisid = getSapisid();
        const origin = 'https://www.youtube.com';

        const headers = {
            'Content-Type': 'application/json',
            'X-Origin': origin,
            'X-Youtube-Client-Name': '1',
            'X-Youtube-Client-Version': getClientVersion(),
        };

        if (sapisid) {
            const hash = await generateSapisidHash(sapisid, origin);
            if (hash) {
                headers['Authorization'] = `SAPISIDHASH ${hash}`;
            }
        }

        return headers;
    }

    // ========== YOUTUBE API ==========

    // Works for any playlist the signed-in user can edit (Watch Later, Liked,
    // and their own playlists). Non-editable playlists never expose a setVideoId,
    // so no button is created for them and this is never reached.
    // Takes one setVideoId or an array of them (one request, one action each).
    async function removeFromPlaylist(setVideoIds, playlistId) {
        const ids = Array.isArray(setVideoIds) ? setVideoIds : [setVideoIds];
        const apiKey = getApiKey();
        const headers = await buildApiHeaders();

        if (!headers['Authorization']) {
            return { success: false, error: 'Not logged in' };
        }

        try {
            const response = await fetch(`https://www.youtube.com/youtubei/v1/browse/edit_playlist?key=${apiKey}&prettyPrint=false`, {
                method: 'POST',
                headers: headers,
                credentials: 'include',
                body: JSON.stringify({
                    context: {
                        client: {
                            clientName: 'WEB',
                            clientVersion: getClientVersion(),
                            hl: 'en',
                            gl: 'US',
                        }
                    },
                    actions: ids.map(setVideoId => ({ setVideoId, action: 'ACTION_REMOVE_VIDEO' })),
                    playlistId: playlistId
                })
            });

            if (!response.ok) {
                return { success: false, error: `HTTP ${response.status}` };
            }

            const data = await response.json();
            if (data.status === 'STATUS_SUCCEEDED' || data.playlistEditResults) {
                return { success: true };
            }

            return { success: false, error: 'Unexpected response' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // ========== UI ==========

    function showToast(message) {
        const existing = document.getElementById('pl-remove-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'pl-remove-toast';
        toast.textContent = message;
        Object.assign(toast.style, {
            position: 'fixed',
            bottom: '70px',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '12px 24px',
            borderRadius: '4px',
            backgroundColor: '#323232',
            color: '#fff',
            fontSize: '14px',
            fontFamily: '"Roboto", "Arial", sans-serif',
            fontWeight: '400',
            zIndex: '9999',
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
            transition: 'opacity 0.3s',
        });

        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ========== ROW STATE ==========

    // Optimistic fade while a removal is in flight; reverted on failure.
    function fadeRow(el) {
        el.style.transition = 'opacity 0.3s';
        el.style.opacity = '0.3';
        const titleEl = el.querySelector('#video-title');
        if (titleEl) titleEl.style.textDecoration = 'line-through';
    }
    function unfadeRow(el) {
        el.style.opacity = '1';
        const titleEl = el.querySelector('#video-title');
        if (titleEl) titleEl.style.textDecoration = '';
    }
    // Confirmed gone server-side: stays faded, loses its × and drops out of the watched
    // count. YouTube itself leaves the row in the DOM until a reload. The attribute
    // stores WHICH setVideoId went, so a row element YouTube later recycles for a
    // different video is not mistaken for removed.
    function markRowRemoved(el, setVideoId) {
        el.setAttribute(REMOVED_ATTR, setVideoId || 'true');
        fadeRow(el);
        const btn = el.querySelector('.' + BUTTON_CLASS);
        if (btn) btn.style.display = 'none';
    }
    function isRowRemoved(el) {
        const gone = el.getAttribute(REMOVED_ATTR);
        return !!gone && (gone === 'true' || gone === el.data?.setVideoId);
    }

    // ========== REMOVE WATCHED (loaded rows) ==========

    // Percent of the video already watched, as YouTube reports it for this row: the
    // resume-playback thumbnail overlay that draws the red bar. Read from the
    // renderer's Polymer data first, then from the rendered bar's width as a fallback.
    // 0 when there is no overlay, i.e. never started.
    function watchedPercent(el) {
        try {
            const overlays = el.data?.thumbnailOverlays;
            if (Array.isArray(overlays)) {
                for (const o of overlays) {
                    const r = o && o.thumbnailOverlayResumePlaybackRenderer;
                    if (r && typeof r.percentDurationWatched === 'number') return r.percentDurationWatched;
                }
            }
        } catch (e) { /* fall through to the DOM */ }
        try {
            const bar = el.querySelector('ytd-thumbnail-overlay-resume-playback-renderer #progress');
            const w = bar ? parseFloat(bar.style.width) : NaN;
            if (!isNaN(w)) return w;
        } catch (e) { /* noop */ }
        return 0;
    }

    // Loaded rows that are removable (have a setVideoId), not already removed, and
    // watched past the threshold. "Loaded" = rendered so far: YouTube fetches ~100
    // rows per scroll-load and keeps them all in the DOM.
    function watchedRows() {
        const rows = [];
        document.querySelectorAll('ytd-playlist-video-renderer').forEach(el => {
            if (!el.data?.setVideoId) return;
            if (isRowRemoved(el)) return;
            if (watchedPercent(el) >= WATCHED_PERCENT) rows.push(el);
        });
        return rows;
    }

    let bulkRunning = false;
    let bulkDone = 0;
    let bulkTotal = 0;

    async function removeWatchedLoaded() {
        if (bulkRunning) return { done: 0, failed: 0, total: 0 };
        const playlistId = getPlaylistId();
        const items = watchedRows().map(el => ({ el, id: el.data.setVideoId }));
        if (!playlistId || !items.length) return { done: 0, failed: 0, total: 0 };

        bulkRunning = true; bulkDone = 0; bulkTotal = items.length;
        let failed = 0;
        const pending = new Set(items.map(it => it.el));   // not yet settled either way
        updateBulkPill();
        try {
            items.forEach(it => fadeRow(it.el));
            for (let i = 0; i < items.length; i += BULK_CHUNK) {
                if (getPlaylistId() !== playlistId) break;   // navigated away mid-run
                const chunk = items.slice(i, i + BULK_CHUNK);
                const batch = await removeFromPlaylist(chunk.map(it => it.id), playlistId);
                if (batch.success) {
                    chunk.forEach(it => { markRowRemoved(it.el, it.id); pending.delete(it.el); });
                    bulkDone += chunk.length;
                } else {
                    // Chunk rejected (over the per-request limit, or one stale id poisoning
                    // the whole request): retry one request per video.
                    console.warn('[Playlist Quick Remove] Batch of', chunk.length, 'rejected:', batch.error, '— retrying one at a time');
                    for (const it of chunk) {
                        if (getPlaylistId() !== playlistId) break;
                        const one = await removeFromPlaylist(it.id, playlistId);
                        if (one.success) { markRowRemoved(it.el, it.id); bulkDone++; }
                        else { unfadeRow(it.el); failed++; console.error('[Playlist Quick Remove] Failed to remove video:', one.error); }
                        pending.delete(it.el);
                    }
                }
                updateBulkPill();
            }
        } finally {
            pending.forEach(unfadeRow);   // anything never attempted (navigated away)
            bulkRunning = false;
            scheduleBulkUpdate();
            if (getPlaylistId() === playlistId) {
                showToast(failed
                    ? `Removed ${bulkDone} of ${bulkTotal} watched videos (${failed} failed)`
                    : `Removed ${bulkDone} watched video${bulkDone === 1 ? '' : 's'}`);
            }
        }
        return { done: bulkDone, failed, total: bulkTotal };
    }

    // The fixed "Remove N watched" pill. Two-state destructive control: the first click
    // arms it (snaps red, states the count, asks to confirm), a second click while armed
    // runs the removal, and moving the pointer off cools it back over ~500ms.
    let bulkArmed = false;
    const PILL_REST = 'rgba(32, 32, 36, 0.95)';
    const PILL_ARMED = 'rgba(204, 0, 0, 0.95)';

    function ensureBulkPill() {
        let btn = document.getElementById(BULK_BTN_ID);
        if (btn) return btn;
        btn = document.createElement('button');
        btn.id = BULK_BTN_ID;
        btn.style.cssText = `
            position: fixed;
            right: 24px;
            bottom: 24px;
            z-index: 9998;
            padding: 10px 16px;
            border: none;
            border-radius: 20px;
            background-color: ${PILL_REST};
            color: #e8e8ea;
            font: 600 13px/1.2 "Roboto", "Arial", sans-serif;
            cursor: pointer;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
            transition: background-color 0.5s, opacity 0.2s;
        `;
        btn.addEventListener('mouseleave', () => setArmed(false));
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (bulkRunning) return;
            if (!bulkArmed) { setArmed(true); return; }
            setArmed(false);
            removeWatchedLoaded();
        });
        document.body.appendChild(btn);
        return btn;
    }
    function removeBulkPill() {
        bulkArmed = false;
        const btn = document.getElementById(BULK_BTN_ID);
        if (btn) btn.remove();
    }
    function setArmed(on) {
        if (bulkArmed === !!on) return;
        bulkArmed = !!on;
        const btn = document.getElementById(BULK_BTN_ID);
        // Arming snaps to red at once; disarming cools back over ~500ms.
        if (btn) btn.style.transition = on ? 'background-color 0s, opacity 0.2s' : 'background-color 0.5s, opacity 0.2s';
        updateBulkPill();
    }

    function updateBulkPill() {
        if (!isPlaylistPage()) { removeBulkPill(); return; }
        const n = watchedRows().length;
        if (!n && !bulkRunning) { removeBulkPill(); return; }   // nothing to do: stay out of the way
        const btn = ensureBulkPill();
        if (bulkRunning) {
            btn.textContent = `Removing watched… ${bulkDone}/${bulkTotal}`;
            btn.style.backgroundColor = PILL_REST;
            btn.style.opacity = '0.75';
            btn.style.cursor = 'default';
        } else if (bulkArmed) {
            btn.textContent = `Remove ${n} watched? Click again to confirm`;
            btn.style.backgroundColor = PILL_ARMED;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
        } else {
            btn.textContent = `Remove ${n} watched`;
            btn.style.backgroundColor = PILL_REST;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
        }
        btn.title = `Remove the ${n} loaded video${n === 1 ? '' : 's'} watched ≥ ${WATCHED_PERCENT}% from this playlist. First click arms, second click confirms.`;
    }

    // Coalesce the many DOM ticks (rows landing, Polymer data filling in) into one recount.
    let bulkUpdateTimer = null;
    function scheduleBulkUpdate() {
        if (bulkUpdateTimer) return;
        bulkUpdateTimer = setTimeout(() => { bulkUpdateTimer = null; updateBulkPill(); }, 150);
    }

    function createRemoveButton(setVideoId, playlistId, renderer) {
        const button = document.createElement('button');
        button.className = BUTTON_CLASS;
        button.setAttribute('aria-label', 'Remove from playlist');
        button.title = 'Remove from playlist';
        button.style.cssText = `
            position: absolute;
            top: 4px;
            right: 4px;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            border: none;
            background-color: rgba(0, 0, 0, 0.7);
            color: #fff;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
            z-index: 10;
            transition: background-color 0.2s, opacity 0.2s;
        `;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        svg.style.cssText = 'fill: currentColor; pointer-events: none;';

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', ICON_X);
        svg.appendChild(path);
        button.appendChild(svg);

        button.addEventListener('mouseenter', () => {
            button.style.backgroundColor = 'rgba(255, 0, 0, 0.8)';
        });

        button.addEventListener('mouseleave', () => {
            button.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
        });

        button.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (button.dataset.processing === 'true') return;
            button.dataset.processing = 'true';
            button.style.opacity = '0.5';
            button.style.cursor = 'wait';

            fadeRow(renderer);   // optimistic

            const result = await removeFromPlaylist(setVideoId, playlistId);

            if (result.success) {
                markRowRemoved(renderer, setVideoId);
                scheduleBulkUpdate();
            } else {
                unfadeRow(renderer);
                button.style.opacity = '1';
                button.style.cursor = 'pointer';
                button.dataset.processing = 'false';

                console.error('[Playlist Quick Remove] Failed to remove video:', result.error);
                showToast(`Failed to remove: ${result.error}`);
            }
        });

        return button;
    }

    // ========== INJECTION ==========

    function processRenderer(el) {
        if (el.hasAttribute(PROCESSED_ATTR)) return;

        const setVideoId = el.data?.setVideoId;
        if (!setVideoId) return; // not editable, or Polymer .data not populated yet — don't mark processed

        const thumbnail = el.querySelector('ytd-thumbnail');
        if (!thumbnail) return;

        const playlistId = getPlaylistId();
        if (!playlistId) return;

        el.setAttribute(PROCESSED_ATTR, 'true');

        // Ensure thumbnail is positioned for absolute child
        const computedPos = getComputedStyle(thumbnail).position;
        if (computedPos === 'static') {
            thumbnail.style.position = 'relative';
        }

        const button = createRemoveButton(setVideoId, playlistId, el);
        thumbnail.appendChild(button);
    }

    // Some renderers land in the DOM a tick before their Polymer .data (which holds
    // setVideoId) is populated, so a single pass misses them; re-scan briefly. Guarded
    // to a single running timer so repeated init() calls can't stack intervals.
    let retryTimer = null;
    function processAllRenderers() {
        document.querySelectorAll('ytd-playlist-video-renderer').forEach(processRenderer);
        scheduleBulkUpdate();
        if (retryTimer) return;
        let retries = 0;
        retryTimer = setInterval(() => {
            if (!isPlaylistPage()) { clearInterval(retryTimer); retryTimer = null; return; }
            document.querySelectorAll('ytd-playlist-video-renderer').forEach(processRenderer);
            scheduleBulkUpdate();
            if (++retries >= 25) { clearInterval(retryTimer); retryTimer = null; }
        }, 200);
    }

    // ========== LIFECYCLE ==========

    // One observer, attached only while on a playlist page and torn down on the way
    // out, so we never leave a subtree observer running on watch/home pages (and never
    // stack duplicates across YouTube's repeated page-data events).
    let observer = null;
    function ensureObserver() {
        if (observer) return;
        observer = new MutationObserver((mutations) => {
            if (!isPlaylistPage()) return;
            let added = false;
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    if (node.tagName === 'YTD-PLAYLIST-VIDEO-RENDERER') {
                        processRenderer(node); added = true;
                    } else if (node.querySelectorAll) {
                        const found = node.querySelectorAll('ytd-playlist-video-renderer');
                        if (found.length) { found.forEach(processRenderer); added = true; }
                    }
                }
            }
            // New rows (a scroll-load) can land a tick before their Polymer data; the
            // bounded retry pass picks up any stragglers and recounts the watched pill.
            if (added) processAllRenderers();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    function teardownObserver() {
        if (observer) { observer.disconnect(); observer = null; }
        if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
        if (bulkUpdateTimer) { clearTimeout(bulkUpdateTimer); bulkUpdateTimer = null; }
        removeBulkPill();
    }

    function init() {
        if (!isPlaylistPage()) { teardownObserver(); return; }
        processAllRenderers();
        ensureObserver();
    }

    // ========== INITIALIZATION ==========

    // YouTube is a SPA: a userscript is only INJECTED on a real document load (hard
    // reload or direct open), never on an in-site navigation. Scoping @match to the
    // playlist URL therefore meant arriving at a playlist by clicking inside YouTube
    // did nothing until you reloaded. Matching all of youtube.com puts this script in
    // place at document-start on whatever page you start from, so the SPA navigation
    // events below actually fire for us. init() gates all real work on isPlaylistPage().
    window.addEventListener('yt-navigate-finish', init);
    window.addEventListener('yt-page-data-updated', init);

    // Console handle for poking at it (e.g. __plQuickRemove.watchedRows().length).
    window.__plQuickRemove = { watchedPercent, watchedRows, removeWatchedLoaded, updateBulkPill, WATCHED_PERCENT };

    // Initial (hard-load) entry.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
