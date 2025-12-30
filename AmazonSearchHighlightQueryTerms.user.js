// ==UserScript==
// @name         Amazon Search - Highlight Query Terms
// @namespace    https://github.com/prwhite
// @version      1.3.4
// @description  Highlights each search term (from k=...) on Amazon search results pages, each term with its own pastel background color.
// @include      /^https:\/\/www\.amazon\.[a-z.]+\/s.*/
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/AmazonSearchHighlightQueryTerms.user.js
// @downloadURL  https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/AmazonSearchHighlightQueryTerms.user.js
// ==/UserScript==

(() => {
  'use strict';

  const STYLE_ID = 'tm-amzn-hilite-style';
  const HILITE_CLASS = 'tm-amzn-hilite';

  const MAX_TERMS = 10;
  const MIN_TERM_LEN = 2;

  // Semi-saturated pastel backgrounds (no yellow, no text color overrides)
  const TERM_BG_COLORS = [
    '#bfe8ff', // sky blue
    '#c8f2c2', // mint green
    '#ffd1e1', // soft pink
    '#d8d0ff', // lavender
    '#ffd7b5', // peach
    '#c9fff1', // aqua
    '#f3c6ff', // lilac
    '#d8f0ff', // pale cyan
    '#e6ffb8', // yellow-green (distinct from Amazon yellow)
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
    `);

    for (let i = 0; i < TERM_BG_COLORS.length; i++) {
      rules.push(`
        .${HILITE_CLASS}[data-term-idx="${i}"] {
          background: ${TERM_BG_COLORS[i]};
        }
      `);
    }

    style.textContent = rules.join('\n');
    document.head.appendChild(style);
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function getSearchTermsFromUrl() {
    const url = new URL(window.location.href);
    const raw =
      (url.searchParams.get('k') ||
       url.searchParams.get('field-keywords') ||
       '').trim();

    if (!raw) return [];

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

  function getSearchResultRoots() {
    const cards = Array.from(
      document.querySelectorAll('div[data-component-type="s-search-result"]')
    );
    if (cards.length) return cards;

    const main = document.querySelector('div.s-main-slot');
    return main ? [main] : [];
  }

  function shouldSkipNode(node) {
    if (!node || !node.parentElement) return true;
    const p = node.parentElement;

    if (p.closest('script, style, noscript')) return true;
    if (p.closest('textarea, input, select, option, button')) return true;
    if (p.isContentEditable || p.closest('[contenteditable="true"]')) return true;
    if (p.closest(`.${HILITE_CLASS}`)) return true;

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
        String(h.idx % TERM_BG_COLORS.length)
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

  function run() {
    ensureStyles();

    const terms = getSearchTermsFromUrl();
    if (!terms.length) return;

    const roots = getSearchResultRoots();
    if (!roots.length) return;

    for (const r of roots) highlightTermsInRoot(r, terms);
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

  run();
  observeAndRerun();
})();