// ==UserScript==
// @name         Page Highlight Search
// @namespace    https://github.com/prwhite
// @version      1.1.1
// @description  Universal page search with multi-term highlighting. Terms persist per-site or globally and re-apply on new pages and tabs. Cmd+Shift+F (Mac) or Ctrl+Shift+F (Win/Linux), or double-tap F, to toggle.
// @author       prwhite
// @include      /^https?:\/\/.*/
// @noframes
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
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
  const SEARCH_TOKENS_ID = 'tm-page-search-tokens';
  const SCOPE_CHIP_ID = 'tm-page-search-scope';

  // GM storage is scoped to the script, not the origin — that's what lets terms
  // be shared across sites (global scope) and across tabs.
  const STORE_KEY = 'tm-page-search-state';

  const MAX_TERMS = 10;
  const MIN_TERM_LEN = 2;

  // Debounce observer-driven highlighting on a macrotask (see startObserver)
  const OBSERVER_DEBOUNCE_MS = 200;

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

  // Dark text (light bg) colors - same hues as LIGHT_BG_COLORS but darker
  // This ensures the legend always matches regardless of which palette is used
  const DARK_BG_COLORS = [
    '#b24a78', // dark pink (from #ff7eb3)
    '#2a9e8e', // dark aqua (from #4eecd5)
    '#b27030', // dark orange (from #ffab5c)
    '#7a6ab2', // dark lavender (from #b8a4ff)
    '#3da030', // dark green (from #6de862)
    '#3080b2', // dark sky blue (from #5cb8ff)
    '#7a9f20', // dark lime (from #c4ff4d)
    '#a248b2', // dark magenta (from #e87fff)
    '#3090b2', // dark cyan (from #5cd1ff)
  ];

  // Cache for computed text luminance per element
  const luminanceCache = new WeakMap();

  let searchBoxVisible = false;
  let observer = null;
  let observerTimer = null;
  let pendingRoots = new Set();
  let highlighting = false;

  // Double-tap F detection
  const DOUBLE_TAP_MS = 300;
  let lastFTime = 0;

  // === PERSISTED STATE ===
  // {
  //   scope:  'site' | 'global',   // which term set is in play
  //   active: bool,                // highlights on? (box visible === active)
  //   terms:  { global: [...], sites: { 'amazon.com': [...] } }
  // }
  let state = { scope: 'site', active: false, terms: { global: [], sites: {} } };

  function siteKey() {
    return location.hostname.replace(/^www\./, '');
  }

  function loadState() {
    try {
      const raw = GM_getValue(STORE_KEY, null);
      if (!raw) return state;
      const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return {
        scope: s.scope === 'global' ? 'global' : 'site',
        active: !!s.active,
        terms: {
          global: Array.isArray(s.terms && s.terms.global) ? s.terms.global : [],
          sites: (s.terms && s.terms.sites && typeof s.terms.sites === 'object') ? s.terms.sites : {},
        },
      };
    } catch (e) {
      return { scope: 'site', active: false, terms: { global: [], sites: {} } };
    }
  }

  function saveState() {
    try {
      GM_setValue(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      // storage failure shouldn't break highlighting
    }
  }

  function getEffectiveTerms() {
    if (state.scope === 'global') return state.terms.global.slice();
    return (state.terms.sites[siteKey()] || []).slice();
  }

  function setEffectiveTerms(terms) {
    if (state.scope === 'global') {
      state.terms.global = terms;
    } else {
      state.terms.sites[siteKey()] = terms;
    }
    saveState();
  }

  // Round-trip terms back into an editable expression (re-quoting phrases)
  function termsToExpression(terms) {
    return terms.map((t) => (t.includes(' ') ? `"${t}"` : t)).join(' ');
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;

    const rules = [];
    rules.push(`
      .${HILITE_CLASS} {
        display: inline;
        padding: 0 .12em;
        border-radius: .18em;
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
        line-height: inherit;
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
      #${SCOPE_CHIP_ID} {
        margin-left: 10px;
        padding: 2px 8px;
        border-radius: 10px;
        background: #eee;
        color: #444;
        font-size: 12px;
        cursor: pointer;
        user-select: none;
      }
      #${SCOPE_CHIP_ID}:hover {
        background: #ddd;
      }
      #${SEARCH_TOKENS_ID} {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        min-height: 32px;
        padding: 4px 8px;
        border: 1px solid #ddd;
        border-radius: 4px;
        cursor: text;
        outline: none;
      }
      #${SEARCH_TOKENS_ID}:focus {
        border-color: #5cb8ff;
        box-shadow: 0 0 0 2px rgba(92,184,255,0.2);
      }
      #${SEARCH_TOKENS_ID}:empty {
        display: none;
      }
      .tm-search-token {
        padding: 2px 8px;
        border-radius: 4px;
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
        #${SCOPE_CHIP_ID} {
          background: #333;
          color: #bbb;
        }
        #${SCOPE_CHIP_ID}:hover {
          background: #444;
        }
        #${SEARCH_TOKENS_ID} {
          border-color: #555;
        }
        #${SEARCH_TOKENS_ID}:focus {
          border-color: #10307f;
          box-shadow: 0 0 0 2px rgba(16,48,127,0.3);
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

  // Our own DOM edits would otherwise re-trigger the observer
  function withObserverPaused(fn) {
    if (observer) observer.disconnect();
    try {
      fn();
    } finally {
      if (observer && searchBoxVisible && document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    }
  }

  function clearHighlights() {
    withObserverPaused(() => {
      const spans = document.querySelectorAll(`.${HILITE_CLASS}`);
      for (const span of spans) {
        const parent = span.parentNode;
        if (!parent) continue;
        const text = document.createTextNode(span.textContent || '');
        parent.replaceChild(text, span);
        parent.normalize();
      }
    });
  }

  function refreshHitCount() {
    updateHitCount(document.querySelectorAll(`.${HILITE_CLASS}`).length);
  }

  function collectTextNodes(root) {
    const nodes = [];

    if (root.nodeType === Node.TEXT_NODE) {
      if (!shouldSkipNode(root) && root.nodeValue && root.nodeValue.trim()) nodes.push(root);
      return nodes;
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return nodes;

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
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  // Wrap matches inside the given roots. Idempotent — shouldSkipNode() skips
  // text already inside a highlight span — so the observer can hand us just the
  // subtrees that arrived rather than forcing a re-walk of the whole page.
  function applyHighlightsToRoots(roots, terms) {
    if (!terms.length || highlighting) return 0;

    highlighting = true; // re-entrancy guard
    try {
      const termRes = buildTermRegexes(terms);
      withObserverPaused(() => {
        for (const root of roots) {
          if (!root || !root.isConnected) continue;
          for (const n of collectTextNodes(root)) {
            wrapMatchesByTermsInTextNode(n, termRes);
          }
        }
      });
    } finally {
      highlighting = false;
    }

    refreshHitCount();
    return document.querySelectorAll(`.${HILITE_CLASS}`).length;
  }

  function applyHighlights(terms) {
    if (!terms.length || !document.body) {
      updateHitCount(0);
      return 0;
    }
    return applyHighlightsToRoots([document.body], terms);
  }

  // Full reset — used when the term set itself changes
  function rehighlight(terms) {
    clearHighlights();
    return applyHighlights(terms);
  }

  function startObserver() {
    if (observer || !document.body) return;

    observer = new MutationObserver((mutations) => {
      const box = document.getElementById(SEARCH_BOX_ID);
      let queued = false;

      for (const m of mutations) {
        for (const node of m.addedNodes) {
          const isEl = node.nodeType === Node.ELEMENT_NODE;
          if (!isEl && node.nodeType !== Node.TEXT_NODE) continue;

          // Never react to our own UI. The hit count and token chips live inside
          // the box, and reacting to them would retrigger this observer forever.
          if (box && (node === box || box.contains(node))) continue;
          if (isEl && node.classList && node.classList.contains(HILITE_CLASS)) continue;

          pendingRoots.add(node);
          queued = true;
        }
      }

      if (!queued || observerTimer) return;

      // Debounce on a macrotask. Chaining microtasks here starves the event loop
      // and freezes the tab outright.
      observerTimer = setTimeout(() => {
        observerTimer = null;
        const roots = [...pendingRoots];
        pendingRoots.clear();
        if (!searchBoxVisible || !roots.length) return;
        const terms = getEffectiveTerms();
        if (terms.length) applyHighlightsToRoots(roots, terms);
      }, OBSERVER_DEBOUNCE_MS);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observerTimer) {
      clearTimeout(observerTimer);
      observerTimer = null;
    }
    pendingRoots.clear();
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function updateHitCount(count) {
    const countEl = document.getElementById(SEARCH_COUNT_ID);
    if (countEl) {
      countEl.textContent = count > 0 ? `${count} match${count === 1 ? '' : 'es'}` : '';
    }
  }

  function updateScopeChip() {
    const chip = document.getElementById(SCOPE_CHIP_ID);
    if (!chip) return;
    chip.textContent = state.scope === 'global' ? 'Global' : `Site: ${siteKey()}`;
    chip.title = 'Click to switch between this site\'s terms and global terms';
  }

  function toggleScope() {
    state.scope = state.scope === 'global' ? 'site' : 'global';
    saveState();
    updateScopeChip();

    const terms = getEffectiveTerms();
    rehighlight(terms);

    if (terms.length) {
      showTokensView(terms);
    } else {
      // Nothing saved in the scope we just switched to — offer an empty input
      showTokensView([]);
      const input = document.getElementById(SEARCH_INPUT_ID);
      if (input) {
        input.value = '';
        input.focus();
      }
    }
  }

  function showTokensView(terms, focus = true) {
    const box = document.getElementById(SEARCH_BOX_ID);
    if (!box) return;

    const input = document.getElementById(SEARCH_INPUT_ID);
    let tokens = document.getElementById(SEARCH_TOKENS_ID);

    // Create tokens container if needed
    if (!tokens) {
      tokens = document.createElement('div');
      tokens.id = SEARCH_TOKENS_ID;
      tokens.tabIndex = 0; // Make focusable
      tokens.addEventListener('click', switchToInputView);
      tokens.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          hideSearchBox();
        } else if (e.key === 'Enter' || e.key === 'Backspace') {
          // Any typing intent switches to input
          e.preventDefault();
          switchToInputView();
        } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
          // Single character typed - switch to input and let it through
          switchToInputView();
        }
      });
      box.insertBefore(tokens, input);
    }

    tokens.replaceChildren();   // TT-safe clear (runs on every site, incl. Trusted-Types ones)

    if (!terms.length) {
      tokens.style.display = 'none';
      if (input) input.style.display = 'block';
      return;
    }

    const colorCount = LIGHT_BG_COLORS.length;
    for (let i = 0; i < terms.length; i++) {
      const span = document.createElement('span');
      span.className = 'tm-search-token';
      span.textContent = terms[i];
      span.style.background = LIGHT_BG_COLORS[i % colorCount];
      tokens.appendChild(span);
    }

    // Show tokens, hide input
    tokens.style.display = 'flex';
    if (input) input.style.display = 'none';
    // Auto-applied page loads must not steal focus from the page
    if (focus) tokens.focus();
  }

  function switchToInputView() {
    const input = document.getElementById(SEARCH_INPUT_ID);
    const tokens = document.getElementById(SEARCH_TOKENS_ID);

    if (tokens) tokens.style.display = 'none';
    if (input) {
      // Prefill from stored terms so they're editable, not retyped from scratch
      const terms = getEffectiveTerms();
      if (terms.length && !input.value.trim()) {
        input.value = termsToExpression(terms);
      }
      input.style.display = 'block';
      input.focus();
      input.select();
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

    const scope = document.createElement('span');
    scope.id = SCOPE_CHIP_ID;
    scope.addEventListener('click', toggleScope);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const terms = parseSearchTerms(input.value);
        setEffectiveTerms(terms); // persists to the current scope
        rehighlight(terms);
        showTokensView(terms);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideSearchBox();
      }
    });

    box.appendChild(input);
    box.appendChild(count);
    box.appendChild(scope);
    return box;
  }

  function ensureBox() {
    let box = document.getElementById(SEARCH_BOX_ID);
    if (!box) {
      box = createSearchBox();
      document.body.appendChild(box);
    }
    return box;
  }

  function showSearchBox() {
    ensureStyles();
    const box = ensureBox();

    box.style.display = 'block';
    searchBoxVisible = true;
    state.active = true;
    saveState();
    updateScopeChip();
    startObserver();

    // Stored terms come straight back — no retyping
    const terms = getEffectiveTerms();
    if (terms.length) {
      rehighlight(terms);
      showTokensView(terms);
    } else {
      showTokensView([]);
      const input = document.getElementById(SEARCH_INPUT_ID);
      if (input) {
        input.focus();
        input.select();
      }
    }
  }

  function hideSearchBox() {
    const box = document.getElementById(SEARCH_BOX_ID);
    if (box) box.style.display = 'none';

    searchBoxVisible = false;
    // Closing the box turns highlighting off, but the terms stay saved so that
    // reopening (here or in a new tab) restores them.
    state.active = false;
    saveState();

    clearHighlights();
    stopObserver();
    showTokensView([], false);
  }

  function toggleSearchBox() {
    if (searchBoxVisible) {
      hideSearchBox();
    } else {
      showSearchBox();
    }
  }

  // On a fresh page/tab: if highlighting was left on and this scope has terms,
  // bring them straight back without a keypress — and without stealing focus.
  function autoApplyOnLoad() {
    if (!state.active) return;

    const terms = getEffectiveTerms();
    if (!terms.length) return; // nothing saved for this scope — stay out of the way

    ensureStyles();
    const box = ensureBox();
    box.style.display = 'block';
    searchBoxVisible = true;

    updateScopeChip();
    startObserver();
    applyHighlights(terms);
    showTokensView(terms, false);
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
    state = loadState();
    document.addEventListener('keydown', handleKeydown, true);

    // @run-at document-start — body isn't there yet
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', autoApplyOnLoad);
    } else {
      autoApplyOnLoad();
    }
  }

  init();
})();
