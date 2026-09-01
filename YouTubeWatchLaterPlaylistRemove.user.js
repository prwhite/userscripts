// ==UserScript==
// @name         YouTube Playlist Quick Remove
// @namespace    https://github.com/prwhite
// @version      1.1.0
// @description  Adds a quick-remove (×) button to each video on any editable YouTube playlist page — Watch Later, Liked videos, and your own playlists
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
    const BUTTON_CLASS = 'pl-quick-remove-btn';

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
    async function removeFromPlaylist(setVideoId, playlistId) {
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
                    actions: [{
                        setVideoId: setVideoId,
                        action: 'ACTION_REMOVE_VIDEO'
                    }],
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

            // Apply optimistic UI
            renderer.style.transition = 'opacity 0.3s';
            renderer.style.opacity = '0.3';
            const titleEl = renderer.querySelector('#video-title');
            if (titleEl) titleEl.style.textDecoration = 'line-through';

            const result = await removeFromPlaylist(setVideoId, playlistId);

            if (result.success) {
                button.style.display = 'none';
            } else {
                // Revert on failure
                renderer.style.opacity = '1';
                if (titleEl) titleEl.style.textDecoration = '';
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
        if (retryTimer) return;
        let retries = 0;
        retryTimer = setInterval(() => {
            if (!isPlaylistPage()) { clearInterval(retryTimer); retryTimer = null; return; }
            document.querySelectorAll('ytd-playlist-video-renderer').forEach(processRenderer);
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
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    if (node.tagName === 'YTD-PLAYLIST-VIDEO-RENDERER') {
                        processRenderer(node);
                    } else if (node.querySelectorAll) {
                        node.querySelectorAll('ytd-playlist-video-renderer').forEach(processRenderer);
                    }
                }
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    function teardownObserver() {
        if (observer) { observer.disconnect(); observer = null; }
        if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
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

    // Initial (hard-load) entry.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
