// ==UserScript==
// @name         YouTube Watch Later Playlist Quick Remove
// @namespace    https://github.com/prwhite
// @version      1.0.1
// @description  Adds a quick-remove button to each video on the Watch Later playlist page
// @author       prwhite
// @match        https://www.youtube.com/playlist?list=WL
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/YouTubeWatchLaterPlaylistRemove.user.js
// @downloadURL  https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/YouTubeWatchLaterPlaylistRemove.user.js
// ==/UserScript==

(function() {
    'use strict';

    const PROCESSED_ATTR = 'data-wl-remove-processed';
    const BUTTON_CLASS = 'wl-quick-remove-btn';

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

    async function removeFromWatchLater(setVideoId) {
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
                    playlistId: 'WL'
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
        const existing = document.getElementById('wl-remove-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'wl-remove-toast';
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

    function createRemoveButton(setVideoId, renderer) {
        const button = document.createElement('button');
        button.className = BUTTON_CLASS;
        button.setAttribute('aria-label', 'Remove from Watch Later');
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

            const result = await removeFromWatchLater(setVideoId);

            if (result.success) {
                button.style.display = 'none';
            } else {
                // Revert on failure
                renderer.style.opacity = '1';
                if (titleEl) titleEl.style.textDecoration = '';
                button.style.opacity = '1';
                button.style.cursor = 'pointer';
                button.dataset.processing = 'false';

                console.error('[WL Quick Remove] Failed to remove video:', result.error);
                showToast(`Failed to remove: ${result.error}`);
            }
        });

        return button;
    }

    // ========== INJECTION ==========

    function processRenderer(el) {
        if (el.hasAttribute(PROCESSED_ATTR)) return;
        el.setAttribute(PROCESSED_ATTR, 'true');

        const setVideoId = el.data?.setVideoId;
        if (!setVideoId) return;

        const thumbnail = el.querySelector('ytd-thumbnail');
        if (!thumbnail) return;

        // Ensure thumbnail is positioned for absolute child
        const computedPos = getComputedStyle(thumbnail).position;
        if (computedPos === 'static') {
            thumbnail.style.position = 'relative';
        }

        const button = createRemoveButton(setVideoId, el);
        thumbnail.appendChild(button);
    }

    function processAllRenderers() {
        document.querySelectorAll('ytd-playlist-video-renderer').forEach(processRenderer);
    }

    // ========== INITIALIZATION ==========

    function isWatchLaterPage() {
        return window.location.pathname === '/playlist' &&
               new URLSearchParams(window.location.search).get('list') === 'WL';
    }

    function init() {
        if (!isWatchLaterPage()) return;

        // Process existing items
        processAllRenderers();

        // Watch for new items (infinite scroll)
        const observer = new MutationObserver((mutations) => {
            if (!isWatchLaterPage()) return;

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

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    // Listen for YouTube SPA navigation
    window.addEventListener('yt-navigate-finish', () => {
        if (isWatchLaterPage()) init();
    });
    window.addEventListener('yt-page-data-updated', () => {
        if (isWatchLaterPage()) init();
    });

    // Initial load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1000));
    } else {
        setTimeout(init, 1000);
    }
})();
