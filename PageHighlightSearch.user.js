// ==UserScript==
// @name         Page Highlight Search
// @namespace    https://github.com/prwhite
// @version      1.0.9
// @description  Universal page search with multi-term highlighting. Cmd+Shift+F (Mac) or Ctrl+Shift+F (Win/Linux) to toggle.
// @author       prwhite
// @include      /^https?:\/\/.*/
// @noframes
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/PageHighlightSearch.user.js
// @downloadURL  https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/PageHighlightSearch.user.js
// ==/UserScript==

(() => {
  'use strict';

  const STYLE_ID = 'tm-page-search-style';
  const HILITE_CLASS = 'tm-page-search-hilite';
  const SEARCH_BOX_ID = 'tm-page-search-box';
  const SEARCH_INPUT_ID = 'tm-page-search-input';
  const SEARCH_COUNT_ID = 'tm-page-search-count';

  const MAX_TERMS = 10;
  const MIN_TERM_LEN = 2;

  // Light text (dark bg) colors - vivid backgrounds
  // Ordered for maximum contrast between adjacent colors
  const LIGHT_BG_COLORS = [
    '#ff7eb3', // vivid pink
    '#4eecd5', // vivid aqua
    '#ffab5c', // vivid orange
    '#b8a4ff', // vivid lavender
    '#6de862', // vivid green
    '#5cb8ff', // vivid sky blue
    '#c4ff4d', // vivid lime
    '#e87fff', // vivid magenta
    '#5cd1ff', // vivid cyan
  ];

  // Dark text (light bg) colors - darker backgrounds with ~9f peak
  // Ordered for maximum contrast between adjacent colors
  const DARK_BG_COLORS = [
    '#9f1030', // dark rose
    '#109f9f', // dark teal
    '#30109f', // dark purple
    '#9f9f10', // dark olive
    '#10309f', // dark blue
    '#9f3010', // dark brown
    '#109f10', // dark green
    '#9f109f', // dark magenta
    '#103060', // dark slate
  ];

  // Cache for computed text luminance per element
  const luminanceCache = new WeakMap();

  let searchBoxVisible = false;

  // Double-tap F detection
  const DOUBLE_TAP_MS = 300;
  let lastFTime = 0;

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;

    const rules = [];
    rules.push(`
      .${HILITE_CLASS} {
        padding: 0 .12em;
        border-radius: .18em;
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
      }
      #${SEARCH_BOX_ID} {
        position: fixed;
        top: 10px;
        right: 10px;
        z-index: 2147483647;
        background: #fff;
        border: 1px solid #ccc;
        border-radius: 6px;
        padding: 8px 12px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 14px;
      }
      #${SEARCH_INPUT_ID} {
        width: 250px;
        padding: 6px 10px;
        border: 1px solid #ddd;
        border-radius: 4px;
        font-size: 14px;
        outline: none;
      }
      #${SEARCH_INPUT_ID}:focus {
        border-color: #5cb8ff;
        box-shadow: 0 0 0 2px rgba(92,184,255,0.2);
      }
      #${SEARCH_COUNT_ID} {
        margin-left: 10px;
        color: #666;
        font-size: 13px;
      }
      @media (prefers-color-scheme: dark) {
        #${SEARCH_BOX_ID} {
          background: #1a1a1a;
          border-color: #444;
        }
        #${SEARCH_INPUT_ID} {
          background: #2a2a2a;
          border-color: #555;
          color: #eee;
        }
        #${SEARCH_INPUT_ID}:focus {
          border-color: #10307f;
          box-shadow: 0 0 0 2px rgba(16,48,127,0.3);
        }
        #${SEARCH_COUNT_ID} {
          color: #999;
        }
      }
    `);

    // Highlight colors - light bg (for dark text)
    for (let i = 0; i < LIGHT_BG_COLORS.length; i++) {
      rules.push(`
        .${HILITE_CLASS}[data-term-idx="${i}"][data-bg-mode="light"] {
          background: ${LIGHT_BG_COLORS[i]};
        }
      `);
    }

    // Highlight colors - dark bg (for light text)
    for (let i = 0; i < DARK_BG_COLORS.length; i++) {
      rules.push(`
        .${HILITE_CLASS}[data-term-idx="${i}"][data-bg-mode="dark"] {
          background: ${DARK_BG_COLORS[i]};
        }
      `);
    }

    style.textContent = rules.join('\n');
    document.head.appendChild(style);
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function parseSearchTerms(raw) {
    if (!raw || !raw.trim()) return [];

    // Match quoted phrases or individual words
    const regex = /"([^"]+)"|(\S+)/g;
    const parts = [];
    let match;
    while ((match = regex.exec(raw)) !== null) {
      // match[1] is quoted content, match[2] is unquoted word
      const term = match[1] || match[2];
      if (term) parts.push(term.trim());
    }

    const uniq = [];
    for (const p of parts) {
      const lower = p.toLowerCase();
      if (lower.length < MIN_TERM_LEN) continue;
      if (!uniq.includes(lower)) uniq.push(lower);
      if (uniq.length >= MAX_TERMS) break;
    }
    return uniq;
  }

  function shouldSkipNode(node) {
    if (!node || !node.parentElement) return true;
    const p = node.parentElement;

    if (p.closest('script, style, noscript')) return true;
    if (p.closest('textarea, input, select, option, button')) return true;
    if (p.isContentEditable || p.closest('[contenteditable="true"]')) return true;
    if (p.closest(`.${HILITE_CLASS}`)) return true;
    if (p.closest(`#${SEARCH_BOX_ID}`)) return true;

    return false;
  }

  function getTextLuminance(el) {
    // Check cache first
    if (luminanceCache.has(el)) {
      return luminanceCache.get(el);
    }

    const color = getComputedStyle(el).color;
    // Parse rgb(r, g, b) or rgba(r, g, b, a)
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) {
      luminanceCache.set(el, 0.5); // fallback to middle
      return 0.5;
    }

    const r = parseInt(match[1], 10);
    const g = parseInt(match[2], 10);
    const b = parseInt(match[3], 10);
    // Relative luminance formula
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

    luminanceCache.set(el, luminance);
    return luminance;
  }

  function getBgModeForElement(el) {
    const luminance = getTextLuminance(el);
    // Dark text (low luminance) needs light background, light text needs dark background
    return luminance > 0.5 ? 'dark' : 'light';
  }

  function buildTermRegexes(terms) {
    // Create regexes with original input order for color assignment
    const withOriginalIdx = terms.map((t, idx) => ({
      term: t,
      originalIdx: idx,
    }));
    // Sort by length (longest first) for correct overlap handling
    withOriginalIdx.sort((a, b) => b.term.length - a.term.length);
    // Return regexes preserving original index for color
    return withOriginalIdx.map(({ term, originalIdx }) => ({
      re: new RegExp(escapeRegExp(term), 'gi'),
      idx: originalIdx,
    }));
  }

  function wrapMatchesByTermsInTextNode(textNode, termRes) {
    const text = textNode.nodeValue;
    if (!text) return;

    const parent = textNode.parentElement;
    if (!parent) return;

    const hits = [];

    for (const { re, idx } of termRes) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (end > start) hits.push({ start, end, idx });
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    }

    if (!hits.length) return;

    hits.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return (b.end - b.start) - (a.end - a.start);
    });

    const chosen = [];
    let cursor = 0;
    for (const h of hits) {
      if (h.start < cursor) continue;
      chosen.push(h);
      cursor = h.end;
    }

    // Determine bg mode based on text color of parent element
    const bgMode = getBgModeForElement(parent);
    const colorCount = LIGHT_BG_COLORS.length;

    const frag = document.createDocumentFragment();
    let lastIdx = 0;

    for (const h of chosen) {
      if (h.start > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, h.start)));
      }

      const span = document.createElement('span');
      span.className = HILITE_CLASS;
      span.setAttribute('data-term-idx', String(h.idx % colorCount));
      span.setAttribute('data-bg-mode', bgMode);
      span.textContent = text.slice(h.start, h.end);
      frag.appendChild(span);

      lastIdx = h.end;
    }

    if (lastIdx < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    }

    textNode.parentNode.replaceChild(frag, textNode);
  }

  function clearHighlights() {
    const spans = document.querySelectorAll(`.${HILITE_CLASS}`);
    for (const span of spans) {
      const parent = span.parentNode;
      if (!parent) continue;
      const text = document.createTextNode(span.textContent || '');
      parent.replaceChild(text, span);
      parent.normalize();
    }
  }

  function highlightTerms(terms) {
    clearHighlights();
    updateHitCount(0);

    if (!terms.length) return 0;

    const termRes = buildTermRegexes(terms);

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (shouldSkipNode(node)) return NodeFilter.FILTER_REJECT;
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const n of nodes) {
      wrapMatchesByTermsInTextNode(n, termRes);
    }

    // Count total highlights
    const count = document.querySelectorAll(`.${HILITE_CLASS}`).length;
    updateHitCount(count);
    return count;
  }

  function updateHitCount(count) {
    const countEl = document.getElementById(SEARCH_COUNT_ID);
    if (countEl) {
      countEl.textContent = count > 0 ? `${count} match${count === 1 ? '' : 'es'}` : '';
    }
  }

  function createSearchBox() {
    const box = document.createElement('div');
    box.id = SEARCH_BOX_ID;

    const input = document.createElement('input');
    input.id = SEARCH_INPUT_ID;
    input.type = 'text';
    input.placeholder = 'Search terms...';

    const count = document.createElement('span');
    count.id = SEARCH_COUNT_ID;

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const terms = parseSearchTerms(input.value);
        highlightTerms(terms);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideSearchBox();
      }
    });

    box.appendChild(input);
    box.appendChild(count);
    return box;
  }

  function showSearchBox() {
    ensureStyles();

    let box = document.getElementById(SEARCH_BOX_ID);
    if (!box) {
      box = createSearchBox();
      document.body.appendChild(box);
    }

    box.style.display = 'block';
    searchBoxVisible = true;

    const input = document.getElementById(SEARCH_INPUT_ID);
    if (input) {
      input.focus();
      input.select();
    }
  }

  function hideSearchBox() {
    const box = document.getElementById(SEARCH_BOX_ID);
    if (box) {
      box.style.display = 'none';
    }
    searchBoxVisible = false;
    clearHighlights();
  }

  function toggleSearchBox() {
    if (searchBoxVisible) {
      hideSearchBox();
    } else {
      showSearchBox();
    }
  }

  function isInEditableContext() {
    const el = document.activeElement;
    if (!el) return false;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function handleKeydown(e) {
    // Cmd+Shift+F (Mac) or Ctrl+Shift+F (Windows/Linux)
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      toggleSearchBox();
      return;
    }

    // Double-tap F (only when not in an editable field)
    if (e.key.toLowerCase() === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (isInEditableContext()) return;

      const now = Date.now();
      if (now - lastFTime < DOUBLE_TAP_MS) {
        e.preventDefault();
        toggleSearchBox();
        lastFTime = 0; // reset to prevent triple-tap
      } else {
        lastFTime = now;
      }
    }
  }

  function init() {
    document.addEventListener('keydown', handleKeydown, true);
  }

  init();
})();
