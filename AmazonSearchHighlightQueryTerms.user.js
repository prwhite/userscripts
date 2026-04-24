// ==UserScript==
// @name         Amazon Search - Highlight Query Terms
// @namespace    https://github.com/prwhite
// @version      1.6.0
// @description  Highlights each search term on Amazon search results and product pages. Dims low-quality search cards. Double-tap A to toggle.
// @author       prwhite
// @include      /^https:\/\/www\.amazon\.[a-z.]+\/s.*/
// @include      /^https:\/\/www\.amazon\.[a-z.]+\/.*\/dp\/.*/
// @include      /^https:\/\/www\.amazon\.[a-z.]+\/dp\/.*/
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

  // Card dimming thresholds
  const DIM_LOW_STARS_THRESHOLD = 4;
  const DIM_MIN_REVIEWS = 50;
  const DIM_ATTR = 'data-tm-dimmed';

  const STORAGE_KEY = 'tm-amzn-hilite-enabled';
  const DOUBLE_TAP_MS = 300;

  let lastATime = 0;
  let enhancementsEnabled = sessionStorage.getItem(STORAGE_KEY) !== '0';

  // High saturation backgrounds
  // Ordered for maximum contrast between adjacent colors
  // First colors distinct from PageHighlightSearch (which starts pink, aqua, orange)
  const TERM_BG_COLORS = [
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

  // ========== CARD DIMMING ==========

  function getCardRating(card) {
    const alt = card.querySelector('span.a-icon-alt');
    if (!alt) return null;
    const match = alt.textContent.match(/([\d.]+)\s+out of\s+5/);
    return match ? parseFloat(match[1]) : null;
  }

  function getCardReviewCount(card) {
    const link = card.querySelector('a[aria-label$="ratings"]');
    if (!link) return null;
    const match = link.getAttribute('aria-label').match(/([\d,]+)/);
    return match ? parseInt(match[1].replace(/,/g, ''), 10) : null;
  }

  function dimCards() {
    const cards = document.querySelectorAll('div[data-component-type="s-search-result"]');

    for (const card of cards) {
      if (card.hasAttribute(DIM_ATTR)) continue;

      const rating = getCardRating(card);
      const reviewCount = getCardReviewCount(card);

      const noRatings = rating === null && reviewCount === null;
      const lowStars = rating !== null && rating < DIM_LOW_STARS_THRESHOLD;
      const lowReviews = reviewCount !== null && reviewCount < DIM_MIN_REVIEWS;

      card.setAttribute(DIM_ATTR, 'true');
      if (!noRatings && !lowStars && !lowReviews) {
        card.style.backgroundColor = '#ccffcc';
      }
    }
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function getSearchTermsFromUrl() {
    const url = new URL(window.location.href);
    const raw =
      (url.searchParams.get('k') ||
       url.searchParams.get('field-keywords') ||
       url.searchParams.get('keywords') ||
       '').trim();

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
    const cards = Array.from(
      document.querySelectorAll('div[data-component-type="s-search-result"]')
    );
    if (cards.length) return cards;

    const main = document.querySelector('div.s-main-slot');
    if (main) return [main];

    const productMain = document.getElementById('dp-container') ||
                        document.getElementById('ppd') ||
                        document.querySelector('#centerCol');
    if (productMain) return [productMain];

    return [];
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

  function clearEnhancements() {
    // Remove highlights
    const spans = document.querySelectorAll(`.${HILITE_CLASS}`);
    for (const span of spans) {
      const parent = span.parentNode;
      if (!parent) continue;
      const text = document.createTextNode(span.textContent || '');
      parent.replaceChild(text, span);
      parent.normalize();
    }

    // Remove card dimming/coloring
    const dimmed = document.querySelectorAll(`[${DIM_ATTR}]`);
    for (const card of dimmed) {
      card.removeAttribute(DIM_ATTR);
      card.style.backgroundColor = '';
    }
  }

  function toggleEnhancements() {
    enhancementsEnabled = !enhancementsEnabled;
    sessionStorage.setItem(STORAGE_KEY, enhancementsEnabled ? '1' : '0');

    if (enhancementsEnabled) {
      run();
    } else {
      clearEnhancements();
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
    if (e.key.toLowerCase() === 'a' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (isInEditableContext()) return;

      const now = Date.now();
      if (now - lastATime < DOUBLE_TAP_MS) {
        e.preventDefault();
        toggleEnhancements();
        lastATime = 0;
      } else {
        lastATime = now;
      }
    }
  }

  function run() {
    if (!enhancementsEnabled) return;

    ensureStyles();

    const terms = getSearchTermsFromUrl();
    if (terms.length) {
      const roots = getSearchResultRoots();
      for (const r of roots) highlightTermsInRoot(r, terms);
    }

    dimCards();
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
  document.addEventListener('keydown', handleKeydown, true);
})();