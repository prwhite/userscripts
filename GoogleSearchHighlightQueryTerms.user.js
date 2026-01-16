// ==UserScript==
// @name         Google Search - Highlight Query Terms
// @namespace    https://github.com/prwhite
// @version      1.0.18
// @description  Highlights each search term on Google search results pages. Double-tap F to toggle.
// @author       prwhite
// @include      /^https:\/\/www\.google\.[a-z.]+\/search.*/
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/GoogleSearchHighlightQueryTerms.user.js
// @downloadURL  https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/GoogleSearchHighlightQueryTerms.user.js
// ==/UserScript==

(() => {
  'use strict';

  const STYLE_ID = 'tm-google-hilite-style';
  const HILITE_CLASS = 'tm-google-hilite';
  const STORAGE_KEY = 'tm-google-hilite-enabled';

  const MAX_TERMS = 10;
  const MIN_TERM_LEN = 2;

  // Double-tap F detection
  const DOUBLE_TAP_MS = 300;
  let lastFTime = 0;
  let highlightsEnabled = sessionStorage.getItem(STORAGE_KEY) === '1';

  // Light mode: vivid backgrounds with dark text
  // Ordered for maximum contrast between adjacent colors
  // First colors distinct from PageHighlightSearch (which starts pink, aqua, orange)
  const LIGHT_MODE_COLORS = [
    '#5cb8ff', // vivid sky blue
    '#6de862', // vivid green
    '#b8a4ff', // vivid lavender
    '#ffab5c', // vivid orange
    '#4eecd5', // vivid aqua
    '#ff7eb3', // vivid pink
    '#c4ff4d', // vivid lime
    '#e87fff', // vivid magenta
    '#5cd1ff', // vivid cyan
  ];

  // Dark mode: darker backgrounds with ~9f peak
  // Ordered for maximum contrast between adjacent colors
  const DARK_MODE_COLORS = [
    '#10309f', // dark blue
    '#109f10', // dark green
    '#30109f', // dark purple
    '#9f9f10', // dark olive
    '#109f9f', // dark teal
    '#9f1030', // dark rose
    '#9f3010', // dark brown
    '#9f109f', // dark magenta
    '#103060', // dark slate
  ];

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
      #tads, #bottomads {
        opacity: 0.5;
      }
      #tads:hover, #bottomads:hover {
        opacity: 1;
      }
    `);

    // Light mode colors (default)
    for (let i = 0; i < LIGHT_MODE_COLORS.length; i++) {
      rules.push(`
        .${HILITE_CLASS}[data-term-idx="${i}"] {
          background: ${LIGHT_MODE_COLORS[i]};
        }
      `);
    }

    // Dark mode colors via media query
    const darkRules = [];
    for (let i = 0; i < DARK_MODE_COLORS.length; i++) {
      darkRules.push(`
        .${HILITE_CLASS}[data-term-idx="${i}"] {
          background: ${DARK_MODE_COLORS[i]};
        }
      `);
    }
    rules.push(`@media (prefers-color-scheme: dark) { ${darkRules.join('')} }`);

    style.textContent = rules.join('\n');
    document.head.appendChild(style);
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function getSearchTermsFromUrl() {
    const url = new URL(window.location.href);
    const raw = (url.searchParams.get('q') || '').trim();

    if (!raw) return [];

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

  function getSearchResultRoots() {
    const roots = [];

    // Main results container
    const rcnt = document.getElementById('rcnt');
    if (rcnt) roots.push(rcnt);

    // AI Overview container (not inside #rcnt)
    const aiOverview = document.getElementById('m-x-content');
    if (aiOverview) roots.push(aiOverview);

    if (roots.length) return roots;

    // Fallback: try individual containers

    const searchDiv = document.getElementById('search');
    if (searchDiv) roots.push(searchDiv);

    const tads = document.getElementById('tads');
    if (tads) roots.push(tads);

    const bottomads = document.getElementById('bottomads');
    if (bottomads) roots.push(bottomads);

    if (roots.length) return roots;

    // Fallback to rso (results container)
    const rso = document.getElementById('rso');
    if (rso) return [rso];

    // Last resort: main content area
    const main = document.querySelector('#main, #center_col');
    return main ? [main] : [];
  }

  function shouldSkipNode(node) {
    if (!node || !node.parentElement) return true;
    const p = node.parentElement;

    if (p.closest('script, style, noscript')) return true;
    if (p.closest('textarea, input, select, option, button')) return true;
    if (p.isContentEditable || p.closest('[contenteditable="true"]')) return true;
    if (p.closest(`.${HILITE_CLASS}`)) return true;

    // Skip navigation and footer
    if (p.closest('#hdtb, #foot')) return true;

    return false;
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
        String(h.idx % LIGHT_MODE_COLORS.length)
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

  function highlightTermsInRoot(root, terms) {
    const termRes = buildTermRegexes(terms);

    const walker = document.createTreeWalker(
      root,
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

  function run() {
    if (!highlightsEnabled) return;

    ensureStyles();

    const terms = getSearchTermsFromUrl();
    if (!terms.length) return;

    const roots = getSearchResultRoots();
    if (!roots.length) return;

    for (const r of roots) highlightTermsInRoot(r, terms);
  }

  function toggleHighlights() {
    highlightsEnabled = !highlightsEnabled;
    sessionStorage.setItem(STORAGE_KEY, highlightsEnabled ? '1' : '0');

    if (highlightsEnabled) {
      run();
    } else {
      clearHighlights();
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
    // Double-tap F (only when not in an editable field)
    if (e.key.toLowerCase() === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (isInEditableContext()) return;

      const now = Date.now();
      if (now - lastFTime < DOUBLE_TAP_MS) {
        e.preventDefault();
        toggleHighlights();
        lastFTime = 0; // reset to prevent triple-tap
      } else {
        lastFTime = now;
      }
    }
  }

  function observeAndRerun() {
    let pending = false;
    const mo = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        run();
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // Initialize
  document.addEventListener('keydown', handleKeydown, true);
  run();
  observeAndRerun();
})();
