// ==UserScript==
// @name         Amazon Orders - Not Arrived Filter Tab
// @namespace    https://github.com/prwhite
// @version      1.2.5
// @description  Adds a "Not Arrived" tab to Amazon Your Orders and hides orders that are fully delivered; optionally hides delivered shipments inside mixed orders.
// @author       prwhite
// @include      /^https:\/\/www\.amazon\.[a-z.]+\/(gp\/css\/order-history|gp\/your-account\/order-history|your-orders\/).*/
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/AmazonOrdersNotArrivedFilterTab.user.js
// @downloadURL  https://raw.githubusercontent.com/prwhite/userscripts/refs/heads/main/AmazonOrdersNotArrivedFilterTab.user.js
// ==/UserScript==

(() => {
  'use strict';

  const STORAGE_KEY = 'amzn_orders_not_arrived_filter_enabled';
  const TAB_ID = 'tm-not-arrived-tab';
  const STYLE_ID = 'tm-not-arrived-style';

  // --- Behavior toggles ---
  // When filter is enabled, if an order has both delivered and not-delivered shipments,
  // hide only the delivered shipment boxes (leave not-delivered visible).
  const HIDE_DELIVERED_SHIPMENTS_WITHIN_MIXED_ORDERS = true;

  // --- Status matching ---
  const ARRIVED_PRIMARY_RE = /\bdelivered\b/i; // matches "Delivered December 22", etc.

  function isEnabled() {
    return localStorage.getItem(STORAGE_KEY) === '1';
  }

  function setEnabled(v) {
    localStorage.setItem(STORAGE_KEY, v ? '1' : '0');
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${TAB_ID}.page-tabs__tab { cursor: pointer; user-select: none; }
      #${TAB_ID}.page-tabs__tab a { text-decoration: none; }

      .tm-hidden-order { display: none !important; }
      .tm-hidden-shipment { display: none !important; }
    `;
    document.head.appendChild(style);
  }

  function getTabsUl() {
    const li = document.querySelector('li.page-tabs__tab');
    return li ? li.closest('ul') : null;
  }

  function createTabLi() {
    const li = document.createElement('li');
    li.id = TAB_ID;
    li.className = 'page-tabs__tab';

    const a = document.createElement('a');
    a.className = 'a-link-normal';
    a.href = 'javascript:void(0)';
    a.textContent = 'Not Arrived';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      toggle();
    });

    li.appendChild(a);
    return li;
  }

  function updateTabAppearance() {
    const li = document.getElementById(TAB_ID);
    if (!li) return;
    li.classList.toggle('page-tabs__tab--selected', isEnabled());
  }

  function ensureTab() {
    const ul = getTabsUl();
    if (!ul) return;

    if (document.getElementById(TAB_ID)) {
      updateTabAppearance();
      return;
    }

    const newLi = createTabLi();
    const firstLi = ul.querySelector('li.page-tabs__tab');
    if (firstLi && firstLi.nextSibling) ul.insertBefore(newLi, firstLi.nextSibling);
    else ul.appendChild(newLi);

    updateTabAppearance();
  }

  function getOrderGroups() {
    return Array.from(document.querySelectorAll('div.a-box-group'));
  }

  function getDeliveryBoxesWithin(orderGroup) {
    return Array.from(orderGroup.querySelectorAll('div.a-box.delivery-box'));
  }

  function getPrimaryStatusText(deliveryBox) {
    const primary = deliveryBox.querySelector('.delivery-box__primary-text');
    if (primary && primary.textContent) return primary.textContent.trim();

    const h3 = deliveryBox.querySelector('.yohtmlc-shipment-status-primaryText h3');
    if (h3 && h3.textContent) return h3.textContent.trim();

    return '';
  }

  function deliveryBoxIsArrived(deliveryBox) {
    const t = getPrimaryStatusText(deliveryBox);
    return t ? ARRIVED_PRIMARY_RE.test(t) : false;
  }

  function orderGroupIsFullyArrived(orderGroup) {
    const boxes = getDeliveryBoxesWithin(orderGroup);
    if (boxes.length === 0) return false; // conservative: don't hide if layout unknown
    return boxes.every(deliveryBoxIsArrived);
  }

  function clearShipmentHiding(orderGroup) {
    // Unhide any shipment boxes + hr separators we hid previously
    orderGroup.querySelectorAll('.tm-hidden-shipment').forEach((el) => el.classList.remove('tm-hidden-shipment'));
  }

  function hideDeliveredShipmentsWithin(orderGroup) {
    const boxes = getDeliveryBoxesWithin(orderGroup);
    if (boxes.length === 0) return;

    const arrivedFlags = boxes.map(deliveryBoxIsArrived);
    const hasNotArrived = arrivedFlags.some((x) => !x);
    const hasArrived = arrivedFlags.some((x) => x);

    // Only do the "partial hiding" behavior when it's a mixed order.
    if (!(hasArrived && hasNotArrived)) return;

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (!arrivedFlags[i]) continue;

      // Hide the delivered shipment box itself
      box.classList.add('tm-hidden-shipment');

      // Hide separators adjacent to it so you don't get floating <hr> lines.
      // Amazon often inserts <hr class="a-spacing-none a-divider-normal"> between delivery-boxes.
      const prev = box.previousElementSibling;
      const next = box.nextElementSibling;

      if (prev && prev.tagName === 'HR') prev.classList.add('tm-hidden-shipment');
      if (next && next.tagName === 'HR') next.classList.add('tm-hidden-shipment');
    }
  }

  function applyFilter() {
    ensureTab();
    updateTabAppearance();

    const enabled = isEnabled();
    const groups = getOrderGroups();

    for (const g of groups) {
      // Always clear per-shipment hiding first, so toggling off restores everything cleanly.
      clearShipmentHiding(g);

      if (!enabled) {
        g.classList.remove('tm-hidden-order');
        continue;
      }

      const fullyArrived = orderGroupIsFullyArrived(g);
      g.classList.toggle('tm-hidden-order', fullyArrived);

      if (!fullyArrived && HIDE_DELIVERED_SHIPMENTS_WITHIN_MIXED_ORDERS) {
        hideDeliveredShipmentsWithin(g);
      }
    }
  }

  function toggle() {
    setEnabled(!isEnabled());
    applyFilter();
  }

  function setupObserver() {
    const mo = new MutationObserver(() => {
      if (setupObserver._pending) return;
      setupObserver._pending = true;
      queueMicrotask(() => {
        setupObserver._pending = false;
        applyFilter();
      });
    });

    mo.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    ensureStyles();
    ensureTab();
    applyFilter();
    setupObserver();
  }

  init();
})();
