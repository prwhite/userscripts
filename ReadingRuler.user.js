// ==UserScript==
// @name         Reading Ruler
// @namespace    https://github.com/prwhite
// @version      1.1.0
// @description  Highlights the single line of prose under your cursor to help track where you are while reading. Double-tap R to toggle.
// @author       prwhite
// @include      /^https?:\/\/.*/
// @noframes
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/ReadingRuler.user.js
// @downloadURL  https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/ReadingRuler.user.js
// ==/UserScript==

(() => {
  'use strict';

  // === CONFIGURATION ===
  const OVERLAY_ID = 'tm-reading-ruler';
  const STORAGE_KEY = 'tm-reading-ruler-enabled';
  const LINE_COLOR = 'rgba(90, 230, 120, 0.25)'; // green, 25% alpha (mirrors ScrollMark's red)

  const DOUBLE_TAP_MS = 300;

  // Substance thresholds — suppress the ruler on small blocks (search-result
  // snippets, labels, cards) so it only lights up on real running prose.
  const MIN_BLOCK_LINES = 3;    // block must render at least this many lines...
  const MIN_BLOCK_CHARS = 400;  // ...or hold at least this many characters
  const HEADING_FONT_RATIO = 1.8; // font >= this * body size is treated as a heading
  const MAX_LINE_HEIGHT_RATIO = 3; // ignore "lines" taller than this * lineHeight (inline media)

  // Blocks whose text should never get the ruler
  const SKIP_TAGS = new Set([
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'A', 'BUTTON', 'LABEL', 'SUMMARY', 'CODE', 'PRE',
    'INPUT', 'TEXTAREA', 'SELECT', 'OPTION',
  ]);
  const SKIP_INLINE = 'a, button, label, summary, code, pre';
  const SKIP_LANDMARK = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]';
  const BLOCK_DISPLAYS = new Set(['block', 'list-item', 'flow-root', 'table-cell', 'table-caption']);

  // === STATE ===
  let enabled = sessionStorage.getItem(STORAGE_KEY) === '1';
  let lastRTime = 0;
  let overlay = null;
  let rafPending = false;
  let lastX = 0;
  let lastY = 0;

  // Bar geometry + freeze-on-scroll state
  let barVisible = false;
  let barGeom = null;   // { left, top, width, height } of the shown bar
  let frozen = false;   // during scroll the bar sticks to its text instead of retracking
  let freezeScrollX = 0;
  let freezeScrollY = 0;
  let freezeLeft = 0;
  let freezeTop = 0;

  // === OVERLAY ===
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = `
      position: fixed;
      left: 0;
      top: 0;
      width: 0;
      height: 0;
      background-color: ${LINE_COLOR};
      pointer-events: none;
      z-index: 2147483647;
      display: none;
    `;
    (document.body || document.documentElement).appendChild(overlay);
    return overlay;
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
    barVisible = false;
    frozen = false;
  }

  function showBar(left, top, width, height) {
    const el = ensureOverlay();
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.style.display = 'block';
    barGeom = { left, top, width, height };
    barVisible = true;
  }

  // === GEOMETRY ===

  // Text node + offset under a viewport point (standard API, then WebKit/Safari)
  function caretFromPoint(x, y) {
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) return { node: pos.offsetNode, offset: pos.offset };
    }
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) return { node: r.startContainer, offset: r.startOffset };
    }
    return null;
  }

  // Nearest block-level ancestor — establishes the paragraph's left/right margins
  function nearestBlock(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el !== document.body) {
      if (BLOCK_DISPLAYS.has(getComputedStyle(el).display)) return el;
      el = el.parentElement;
    }
    return el; // document.body as last resort
  }

  function isSkippableBlock(block, node) {
    if (!block) return true;
    if (SKIP_TAGS.has(block.tagName)) return true;

    const p = node.parentElement;
    if (p && p.closest(SKIP_INLINE)) return true; // text inside a link/control
    if (block.closest(SKIP_LANDMARK)) return true; // page chrome

    const bodyFs = parseFloat(getComputedStyle(document.body).fontSize) || 16;
    const fs = parseFloat(getComputedStyle(block).fontSize) || bodyFs;
    if (fs >= bodyFs * HEADING_FONT_RATIO) return true; // heading-sized

    return false;
  }

  // Small-block suppression: only real paragraphs qualify
  function isSubstantial(block, lineHeight) {
    const cs = getComputedStyle(block);
    const rect = block.getBoundingClientRect();
    const contentHeight = rect.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const lines = contentHeight / lineHeight;
    if (lines >= MIN_BLOCK_LINES) return true;
    return (block.textContent || '').trim().length >= MIN_BLOCK_CHARS;
  }

  function getLineHeight(block) {
    const cs = getComputedStyle(block);
    const lh = parseFloat(cs.lineHeight);
    if (lh) return lh;
    return (parseFloat(cs.fontSize) || 16) * 1.2; // 'normal' fallback
  }

  // Vertical band of the specific line: rect of one character at the caret
  function lineRectAt(node, offset) {
    const len = node.nodeValue ? node.nodeValue.length : 0;
    if (!len) return null;

    let start = offset;
    let end = offset + 1;
    if (end > len) { start = len - 1; end = len; }
    if (start < 0) start = 0;

    const r = document.createRange();
    try {
      r.setStart(node, start);
      r.setEnd(node, end);
    } catch (e) {
      return null;
    }
    const rect = r.getBoundingClientRect();
    if (!rect || !rect.height) return null;
    return rect;
  }

  // Horizontal extent of the block's content box (inside padding + border)
  function blockContentBox(block) {
    const cs = getComputedStyle(block);
    const rect = block.getBoundingClientRect();
    const left = rect.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
    const right = rect.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
    return { left, width: Math.max(0, right - left) };
  }

  // === UPDATE ===
  function update() {
    rafPending = false;
    if (!enabled) return;
    frozen = false; // a live recompute always leaves us tracking the mouse

    const caret = caretFromPoint(lastX, lastY);
    if (!caret || !caret.node || caret.node.nodeType !== Node.TEXT_NODE) return hideOverlay();
    if (!caret.node.nodeValue || !caret.node.nodeValue.trim()) return hideOverlay();

    const block = nearestBlock(caret.node);
    if (isSkippableBlock(block, caret.node)) return hideOverlay();

    const lineHeight = getLineHeight(block);
    if (!isSubstantial(block, lineHeight)) return hideOverlay();

    const lineRect = lineRectAt(caret.node, caret.offset);
    if (!lineRect) return hideOverlay();
    if (lineRect.height > lineHeight * MAX_LINE_HEIGHT_RATIO) return hideOverlay(); // inline media, not a text line

    // Only show when the cursor is genuinely within this line's band (not the gap between lines)
    if (lastY < lineRect.top - 2 || lastY > lineRect.bottom + 2) return hideOverlay();

    const { left, width } = blockContentBox(block);
    showBar(left, lineRect.top, width, lineRect.height);
  }

  function requestUpdate() {
    if (!enabled || rafPending) return;
    rafPending = true;
    requestAnimationFrame(update);
  }

  // === EVENTS ===
  function onMouseMove(e) {
    // Scrolling content under a stationary pointer fires synthetic mousemoves with
    // unchanged client coordinates. Ignore those so a scroll can't unfreeze the bar.
    if (e.clientX === lastX && e.clientY === lastY) return;

    lastX = e.clientX;
    lastY = e.clientY;
    if (!enabled) return;
    frozen = false; // mouse actually moved → resume live tracking
    if (e.buttons) { hideOverlay(); return; } // don't fight text selection / drags
    requestUpdate();
  }

  // While scrolling, don't retrack under the cursor — keep the current line
  // highlighted and stuck to its text until the mouse moves again.
  function onScroll() {
    if (!enabled || !barVisible) return; // nothing shown → don't highlight while scrolling

    if (!frozen) {
      frozen = true;
      freezeScrollX = window.scrollX;
      freezeScrollY = window.scrollY;
      freezeLeft = barGeom.left;
      freezeTop = barGeom.top;
    }

    // Translate the frozen bar by the scroll delta so it follows its text
    overlay.style.left = `${freezeLeft - (window.scrollX - freezeScrollX)}px`;
    overlay.style.top = `${freezeTop - (window.scrollY - freezeScrollY)}px`;
  }

  function setEnabled(on) {
    enabled = on;
    sessionStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    if (on) requestUpdate();
    else hideOverlay();
  }

  function isInEditableContext() {
    const el = document.activeElement;
    if (!el) return false;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function handleKeydown(e) {
    // Double-tap R (only when not in an editable field)
    if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (isInEditableContext()) return;

      const now = Date.now();
      if (now - lastRTime < DOUBLE_TAP_MS) {
        e.preventDefault();
        setEnabled(!enabled);
        lastRTime = 0; // reset to prevent triple-tap
      } else {
        lastRTime = now;
      }
    }
  }

  // === INIT ===
  document.addEventListener('keydown', handleKeydown, true);
  document.addEventListener('mousemove', onMouseMove, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
})();
