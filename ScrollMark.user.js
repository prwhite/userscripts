// ==UserScript==
// @name         ScrollMark
// @namespace    https://github.com/prwhite
// @version      1.1.0
// @description  Shows temporary lines at your previous scroll position and where your cursor was, to help track where you left off reading
// @author       prwhite
// @include      /^https?:\/\/.*/
// @noframes
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/ScrollMark.user.js
// @downloadURL  https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/ScrollMark.user.js
// ==/UserScript==

(() => {
  'use strict';

  // === CONFIGURATION ===
  const SCROLL_DEBOUNCE_MS = 750; // Time to detect scroll has stopped
  const FADE_DURATION_MS = 750;  // Fade out duration
  const LINE_HEIGHT_PX = 4;
  const EDGE_LINE_COLOR = 'rgba(255, 0, 0, 0.25)';    // red: previous viewport edge
  const CURSOR_LINE_COLOR = 'rgba(64, 220, 96, 0.4)'; // green: where the cursor was

  // === STATE ===
  let markers = [];
  let scrollStopTimer = null;
  let fadeTimer = null;
  let isScrolling = false;
  let lastScrollY = window.scrollY;
  let lastViewportTop = window.scrollY;
  let lastViewportBottom = window.scrollY + window.innerHeight;
  let lastScrollTime = 0;
  let lastMouseClientY = null; // last known cursor Y (viewport coords), or null if unseen

  function createMarker(yPosition, color) {
    const el = document.createElement('div');
    el.style.cssText = `
      position: absolute;
      left: 0;
      width: 100%;
      height: ${LINE_HEIGHT_PX}px;
      background-color: ${color};
      pointer-events: none;
      z-index: 2147483647;
      transition: opacity ${FADE_DURATION_MS}ms ease-out;
    `;
    el.style.top = `${yPosition}px`;
    return el;
  }

  function removeMarkers() {
    for (const m of markers) {
      if (m && m.parentNode) m.parentNode.removeChild(m);
    }
    markers = [];
  }

  function startFadeOut() {
    if (!markers.length) return;
    for (const m of markers) m.style.opacity = '0';
    fadeTimer = setTimeout(removeMarkers, FADE_DURATION_MS);
  }

  function checkIfStopped() {
    const elapsed = Date.now() - lastScrollTime;
    if (elapsed >= SCROLL_DEBOUNCE_MS) {
      // Actually stopped scrolling
      scrollStopTimer = null;
      isScrolling = false;
      startFadeOut();
    } else {
      // Still scrolling, check again after remaining time
      scrollStopTimer = setTimeout(checkIfStopped, SCROLL_DEBOUNCE_MS - elapsed);
    }
  }

  function onScroll() {
    const currentScrollY = window.scrollY;
    const currentViewportTop = window.scrollY;
    const currentViewportBottom = window.scrollY + window.innerHeight;
    const scrollingDown = currentScrollY > lastScrollY;

    lastScrollTime = Date.now();

    // First scroll event after being stopped — place the markers
    if (!isScrolling) {
      isScrolling = true;

      // Clear any fade in progress
      if (fadeTimer) {
        clearTimeout(fadeTimer);
        fadeTimer = null;
      }
      removeMarkers();

      // Only create markers if body exists (may not on document-start)
      if (document.body) {
        // Red: the viewport edge you were reading from, by scroll direction
        // - Scrolling down: previous viewport bottom
        // - Scrolling up: previous viewport top
        const edgeY = scrollingDown ? lastViewportBottom : lastViewportTop;
        markers.push(createMarker(edgeY, EDGE_LINE_COLOR));

        // Green: where the cursor was sitting when the scroll began. Convert its
        // viewport Y to a document Y using the pre-scroll offset (lastScrollY),
        // so it pins to the text that was under the cursor.
        if (lastMouseClientY !== null) {
          markers.push(createMarker(lastMouseClientY + lastScrollY, CURSOR_LINE_COLOR));
        }

        for (const m of markers) document.body.appendChild(m);
      }
    }

    // Always update tracked positions
    lastScrollY = currentScrollY;
    lastViewportTop = currentViewportTop;
    lastViewportBottom = currentViewportBottom;

    // Start a single self-rescheduling timer instead of clearing/resetting constantly
    if (!scrollStopTimer) {
      scrollStopTimer = setTimeout(checkIfStopped, SCROLL_DEBOUNCE_MS);
    }
  }

  // Initialize
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('mousemove', (e) => { lastMouseClientY = e.clientY; }, { passive: true });
})();
