// ==UserScript==
// @name         Page Highlight Search
// @namespace    https://github.com/prwhite
// @version      1.0.3
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

  const MAX_TERMS = 10;
  const MIN_TERM_LEN = 2;

  // Universal colors - mid-range that work on both light and dark backgrounds
  const HIGHLIGHT_COLORS = [
    '#204099', // blue
    '#209920', // green
    '#992040', // rose
    '#402099', // purple
    '#994020', // brown
    '#209999', // teal
    '#992099', // magenta
    '#206080', // slate
    '#999920', // olive
  ];

  let searchBoxVisible = false;

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
      }
    `);

    // Highlight colors
    for (let i = 0; i < HIGHLIGHT_COLORS.length; i++) {
      rules.push(`
        .${HILITE_CLASS}[data-term-idx="${i}"] {
          background: ${HIGHLIGHT_COLORS[i]};
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

    const parts = raw
      .split(/\s+/)
      .map(t => t.trim())
      .filter(Boolean);

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

  function buildTermRegexes(terms) {
    const sorted = [...terms].sort((a, b) => b.length - a.length);
    return sorted.map((t, idx) => ({
      re: new RegExp(escapeRegExp(t), 'gi'),
      idx,
    }));
  }

  function wrapMatchesByTermsInTextNode(textNode, termRes) {
    const text = textNode.nodeValue;
    if (!text) return;

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

    const frag = document.createDocumentFragment();
    let lastIdx = 0;

    for (const h of chosen) {
      if (h.start > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, h.start)));
      }

      const span = document.createElement('span');
      span.className = HILITE_CLASS;
      span.setAttribute(
        'data-term-idx',
        String(h.idx % HIGHLIGHT_COLORS.length)
      );
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

    if (!terms.length) return;

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
  }

  function createSearchBox() {
    const box = document.createElement('div');
    box.id = SEARCH_BOX_ID;

    const input = document.createElement('input');
    input.id = SEARCH_INPUT_ID;
    input.type = 'text';
    input.placeholder = 'Search terms...';

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

  function handleKeydown(e) {
    // Cmd+Shift+F (Mac) or Ctrl+Shift+F (Windows/Linux)
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      toggleSearchBox();
    }
  }

  function init() {
    document.addEventListener('keydown', handleKeydown, true);
  }

  init();
})();
