// ==UserScript==
// @name         Amazon Cart Highlight Changes
// @namespace    https://github.com/prwhite
// @version      1.5
// @description  Highlights price changes on Amazon cart page.
// @author       You
// @match        https://www.amazon.com/gp/cart/view.html*
// @match        https://www.amazon.com/cart*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/prwhite/userscripts/main/AmazonCartHighlightChanges.user.js
// @downloadURL  https://raw.githubusercontent.com/prwhite/userscripts/main/AmazonCartHighlightChanges.user.js
// ==/UserScript==

(function() {
    'use strict';

    function highlightText(node) {
        if (!node || node.nodeType !== Node.TEXT_NODE) return;
        if (["STYLE", "SCRIPT"].includes(node.parentNode.tagName) || node.parentNode.dataset.highlighted) return;

        const words = {
            "decreased": "background-color: green; color: white; padding: 2px 4px; border-radius: 3px;",
            "increased": "background-color: red; color: white; padding: 2px 4px; border-radius: 3px;"
        };

        let text = node.nodeValue;
        let changed = false;

        Object.keys(words).forEach((word) => {
            let regex = new RegExp(`(${word})`, "gi");
            if (regex.test(text)) {
                changed = true;
                text = text.replace(regex, `<span style="${words[word]}">$1</span>`);
            }
        });

        if (changed) {
            let span = document.createElement("span");
            span.innerHTML = text;
            span.dataset.highlighted = "true";  
            node.parentNode.replaceChild(span, node);
        }
    }

    function debugHighlight() {
        console.log("Running Debug Highlighting...");

        document.querySelectorAll("*").forEach((elem) => {
            if (elem.childNodes.length) {
                Array.from(elem.childNodes).forEach(highlightText);
            }
        });

        console.log("Highlighting complete.");
    }

    window.addEventListener('load', () => {
        debugHighlight();  // Run once, no observer
    });
})();
