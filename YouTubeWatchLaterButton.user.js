// ==UserScript==
// @name         YouTube Watch Later Button
// @namespace    https://github.com/prwhite
// @version      1.2.2
// @description  Adds a convenient "Watch Later" toggle button on YouTube video pages
// @author       payton
// @match        https://www.youtube.com/watch*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/YouTubeWatchLaterButton.user.js
// @downloadURL  https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/YouTubeWatchLaterButton.user.js
// ==/UserScript==

(function() {
    'use strict';

    const BUTTON_ID = 'custom-watch-later-btn';
    const PLAYLIST_ID = 'WL';

    // Clock icon SVG paths
    const ICON_OUTLINE = 'M14.97 16.95 10 13.87V7h2v5.76l4.03 2.49-1.06 1.7zM12 3c-4.96 0-9 4.04-9 9s4.04 9 9 9 9-4.04 9-9-4.04-9-9-9m0-1c5.52 0 10 4.48 10 10s-4.48 10-10 10S2 17.52 2 12 6.48 2 12 2z';
    const ICON_FILLED = 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.03 14.19-4.97-3.07V7h1.5v5.32l4.27 2.66-.8 1.21z';

    // ========== UTILITIES ==========

    // Extract video ID from URL
    function getVideoId() {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('v');
    }

    // Get YouTube's internal client version
    function getClientVersion() {
        try {
            return window.ytcfg?.data_?.INNERTUBE_CLIENT_VERSION ||
                   window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') ||
                   '2.20241201.00.00';
        } catch (e) {
            return '2.20241201.00.00';
        }
    }

    // Get YouTube's internal API key
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

    // Get SAPISID cookie (try multiple cookie names)
    function getSapisid() {
        const cookieNames = ['SAPISID', '__Secure-3PAPISID', 'SAPISID1P'];
        for (const name of cookieNames) {
            const match = document.cookie.match(new RegExp(`${name}=([^;]+)`));
            if (match) return match[1];
        }
        return null;
    }

    // Generate SAPISIDHASH for authentication
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

    // Build headers for YouTube API requests
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

    // Check if video is in Watch Later playlist
    async function checkWatchLaterStatus(videoId) {
        const apiKey = getApiKey();
        const headers = await buildApiHeaders();

        if (!headers['Authorization']) return null;

        try {
            const response = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${apiKey}&prettyPrint=false`, {
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
                    browseId: 'VLWL',
                })
            });

            if (!response.ok) return null;

            const data = await response.json();
            return JSON.stringify(data).includes(videoId);
        } catch (e) {
            return null;
        }
    }

    // Add or remove video from Watch Later
    async function toggleWatchLater(videoId, shouldAdd) {
        const apiKey = getApiKey();
        const headers = await buildApiHeaders();

        if (!headers['Authorization']) {
            return { success: false, error: 'Not logged in' };
        }

        const action = shouldAdd ? 'ACTION_ADD_VIDEO' : 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID';
        const actionPayload = shouldAdd
            ? { addedVideoId: videoId, action }
            : { removedVideoId: videoId, action };

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
                    actions: [actionPayload],
                    playlistId: PLAYLIST_ID
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

    // Show toast notification
    function showToast(message) {
        // Remove existing toast
        const existing = document.getElementById('wl-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'wl-toast';
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

    // Create the Watch Later button
    function createButton(initialState = false) {
        const container = document.createElement('div');
        container.id = BUTTON_ID;
        container.style.cssText = 'display: inline-flex; align-items: center; margin-left: 8px;';

        const button = document.createElement('button');
        button.setAttribute('aria-label', 'Watch Later');
        button.style.cssText = `
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 0 16px;
            height: 36px;
            min-width: 36px;
            border-radius: 18px;
            border: none;
            background-color: var(--yt-spec-badge-chip-background, rgba(255,255,255,0.1));
            color: var(--yt-spec-text-primary, #f1f1f1);
            font-size: 14px;
            font-family: "Roboto", "Arial", sans-serif;
            font-weight: 500;
            cursor: pointer;
            gap: 6px;
            transition: background-color 0.2s;
        `;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '24');
        svg.setAttribute('height', '24');
        svg.style.cssText = 'fill: currentColor; pointer-events: none;';

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        svg.appendChild(path);

        const label = document.createElement('span');
        label.style.cssText = 'pointer-events: none;';

        button.appendChild(svg);
        button.appendChild(label);
        container.appendChild(button);

        // State management
        let isInWatchLater = initialState;
        let isProcessing = false;

        function updateUI(inWatchLater) {
            isInWatchLater = inWatchLater;
            path.setAttribute('d', inWatchLater ? ICON_FILLED : ICON_OUTLINE);
            label.textContent = inWatchLater ? 'Saved' : 'Later';
            button.setAttribute('aria-pressed', String(inWatchLater));
        }

        // Initialize UI
        updateUI(initialState);

        // Hover effects
        button.addEventListener('mouseenter', () => {
            if (!isProcessing) {
                button.style.backgroundColor = 'var(--yt-spec-button-chip-background-hover, rgba(255,255,255,0.2))';
            }
        });

        button.addEventListener('mouseleave', () => {
            button.style.backgroundColor = 'var(--yt-spec-badge-chip-background, rgba(255,255,255,0.1))';
        });

        // Click handler
        button.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (isProcessing) return;

            const videoId = getVideoId();
            if (!videoId) {
                showToast('Error: Could not get video ID');
                return;
            }

            isProcessing = true;
            button.style.opacity = '0.6';
            button.style.cursor = 'wait';
            label.textContent = '...';

            const shouldAdd = !isInWatchLater;
            const result = await toggleWatchLater(videoId, shouldAdd);

            isProcessing = false;
            button.style.opacity = '1';
            button.style.cursor = 'pointer';

            if (result.success) {
                updateUI(shouldAdd);
                showToast(shouldAdd ? 'Added to Watch Later' : 'Removed from Watch Later');
            } else {
                updateUI(isInWatchLater); // Restore previous state
                showToast(`Error: ${result.error}`);
            }
        });

        // Method to update state externally
        container.updateState = updateUI;

        return container;
    }

    // ========== BUTTON INSERTION ==========

    // List of selectors to try for the button container
    const CONTAINER_SELECTORS = [
        '#top-level-buttons-computed',
        'ytd-watch-metadata #actions #top-level-buttons-computed',
        '#above-the-fold #top-level-buttons-computed',
        '#menu-container #top-level-buttons-computed',
        'ytd-menu-renderer #top-level-buttons-computed',
        '#actions ytd-menu-renderer',
        'ytd-watch-metadata #actions',
    ];

    function findButtonContainer() {
        for (const selector of CONTAINER_SELECTORS) {
            const el = document.querySelector(selector);
            if (el) return el;
        }
        return null;
    }

    async function insertButton() {
        const videoId = getVideoId();

        if (!window.location.pathname.startsWith('/watch')) return;
        if (!videoId) return;
        if (document.getElementById(BUTTON_ID)) return;

        const container = findButtonContainer();
        if (!container) return;

        // Check initial Watch Later status
        let initialState = false;
        const status = await checkWatchLaterStatus(videoId);
        if (status !== null) {
            initialState = status;
        }

        // Double-check button hasn't been inserted while we were checking status
        if (document.getElementById(BUTTON_ID)) return;

        const button = createButton(initialState);
        container.prepend(button);
    }

    // ========== INITIALIZATION & NAVIGATION ==========

    let insertionAttempts = 0;
    let insertionInterval = null;
    let lastVideoId = null;

    function tryInsertButton() {
        insertionAttempts++;

        const videoId = getVideoId();

        // If video changed, remove old button
        if (videoId !== lastVideoId) {
            const oldButton = document.getElementById(BUTTON_ID);
            if (oldButton) oldButton.remove();
            lastVideoId = videoId;
        }

        insertButton();

        // Stop trying after button is inserted or max attempts
        if (document.getElementById(BUTTON_ID) || insertionAttempts >= 50) {
            stopInsertionLoop();
        }
    }

    function startInsertionLoop() {
        if (insertionInterval) return;
        insertionAttempts = 0;
        insertionInterval = setInterval(tryInsertButton, 200);
        tryInsertButton();
    }

    function stopInsertionLoop() {
        if (insertionInterval) {
            clearInterval(insertionInterval);
            insertionInterval = null;
        }
    }

    function handleNavigation() {
        stopInsertionLoop();
        if (window.location.pathname.startsWith('/watch')) {
            setTimeout(startInsertionLoop, 500);
        }
    }

    function init() {
        // Listen for YouTube's SPA navigation
        window.addEventListener('yt-navigate-finish', handleNavigation);
        window.addEventListener('yt-navigate-start', stopInsertionLoop);
        window.addEventListener('popstate', handleNavigation);

        // Start if we're already on a watch page
        if (window.location.pathname.startsWith('/watch')) {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => setTimeout(startInsertionLoop, 1000));
            } else {
                setTimeout(startInsertionLoop, 1000);
            }
        }

        // Fallback: watch for DOM changes
        const observer = new MutationObserver((mutations) => {
            if (!window.location.pathname.startsWith('/watch')) return;
            if (document.getElementById(BUTTON_ID)) return;

            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.id === 'top-level-buttons-computed' ||
                            node.querySelector?.('#top-level-buttons-computed')) {
                            tryInsertButton();
                            return;
                        }
                    }
                }
            }
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    // Start
    init();
})();
