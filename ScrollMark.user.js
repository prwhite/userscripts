// ==UserScript==
// @name         ScrollMark
// @namespace    https://github.com/prwhite
// @version      1.0.7
// @description  Shows a temporary line at your previous scroll position to help track where you left off reading
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
  const SCROLL_DEBOUNCE_MS = 150; // Time to detect scroll has stopped
  const FADE_DURATION_MS = 1000;  // Fade out duration
  const LINE_HEIGHT_PX = 4;
  const LINE_COLOR = 'rgba(255, 0, 0, 0.25)'; // Red, 25% alpha

  // === STATE ===
  let marker = null;
  let scrollStopTimer = null;
  let fadeTimer = null;
  let isScrolling = false;
  let markerPosition = null;  // Where the marker is placed (document Y)
  let lastScrollY = window.scrollY;
  let lastViewportTop = window.scrollY;
  let lastViewportBottom = window.scrollY + window.innerHeight;

  function createMarker(yPosition) {
    const el = document.createElement('div');
    el.style.cssText = `
      position: absolute;
      left: 0;
      width: 100%;
      height: ${LINE_HEIGHT_PX}px;
      background-color: ${LINE_COLOR};
      pointer-events: none;
      z-index: 2147483647;
      transition: opacity ${FADE_DURATION_MS}ms ease-out;
    `;
    el.style.top = `${yPosition}px`;
    return el;
  }

  function removeMarker() {
    if (marker && marker.parentNode) {
      marker.parentNode.removeChild(marker);
    }
    marker = null;
    markerPosition = null;
  }

  function startFadeOut() {
    if (marker) {
      marker.style.opacity = '0';
      fadeTimer = setTimeout(removeMarker, FADE_DURATION_MS);
    }
  }

  function onScroll() {
    const currentScrollY = window.scrollY;
    const currentViewportTop = window.scrollY;
    const currentViewportBottom = window.scrollY + window.innerHeight;
    const scrollingDown = currentScrollY > lastScrollY;

    // First scroll event after being stopped — place marker
    if (!isScrolling) {
      isScrolling = true;

      // Clear any fade in progress
      if (fadeTimer) {
        clearTimeout(fadeTimer);
        fadeTimer = null;
      }
      removeMarker();

      // Place marker based on scroll direction:
      // - Scrolling down: mark previous viewport bottom (where you were reading)
      // - Scrolling up: mark previous viewport top (where you were at top)
      // Only create marker if body exists (may not on document-start)
      if (document.body) {
        markerPosition = scrollingDown ? lastViewportBottom : lastViewportTop;
        marker = createMarker(markerPosition);
        document.body.appendChild(marker);
      }
    }

    // Always update tracked positions
    lastScrollY = currentScrollY;
    lastViewportTop = currentViewportTop;
    lastViewportBottom = currentViewportBottom;

    // Reset the "scroll stopped" timer
    if (scrollStopTimer) {
      clearTimeout(scrollStopTimer);
    }
    scrollStopTimer = setTimeout(() => {
      scrollStopTimer = null;
      isScrolling = false;
      startFadeOut();
    }, SCROLL_DEBOUNCE_MS);
  }

  // Initialize
  window.addEventListener('scroll', onScroll, { passive: true });
})();
