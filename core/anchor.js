/* Annotate Tool - Copyright (C) 2026 Mark Van de Velde
 * SPDX-License-Identifier: GPL-3.0-only
 * This program comes with ABSOLUTELY NO WARRANTY. See LICENSE for terms.
 */
/* Annotate Tool - core/anchor.js
 *
 * Turns a live DOM position into something we can write to storage, and turns
 * it back again after a reload.
 *
 * DESIGN: deliberately "light" anchoring. Annotations only need to survive a
 * reload or a re-visit WITHIN an open session, not weeks of site redesign, so
 * we spend nothing on the heavy machinery (range normalisation, fuzzy
 * diff-based relocation) that a permanent-annotation product would need.
 *
 * Two independent locators are stored for every text anchor:
 *   1. a CSS path   - fast, exact, first thing to break on a re-render
 *   2. a text quote - prefix/exact/suffix, survives DOM reshuffles as long as
 *                     the words are still on the page
 *
 * Restore leans on the quote and uses the path only to sanity-check it. A path
 * that resolves to the wrong text is treated as a miss, because silently
 * highlighting the wrong sentence is worse than not highlighting at all. If
 * both locators fail the annotation is flagged unplaced rather than dropped -
 * see core/session.js for how those surface in the UI and in the export.
 */
(function () {
  'use strict';
  const AT = (window.AT = window.AT || {});

  const QUOTE_CONTEXT = 32; // chars of prefix/suffix kept for disambiguation
  const MAX_PATH_DEPTH = 12;
  const OVERLAY_HOST_ID = 'at-overlay-host';

  /* The machine-readable notice content/live-dom.js publishes for an AI agent.
   * Unlike the overlay, it is placed INSIDE the page's main content region -
   * it has to be, or text extraction never returns it - which puts it directly
   * in the path of everything below. It must be excluded by name: its text
   * talks about annotations, so leaving it walkable would let it match a
   * reviewer's own quoted text and anchor a highlight onto our own notice. */
  const NOTICE_ID = 'annotate-tool-notice';

  /* --- element paths -------------------------------------------------- */

  function isOurs(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !el.closest) return false;
    return !!el.closest('#' + OVERLAY_HOST_ID + ', #' + NOTICE_ID);
  }

  /* The topmost PAGE element at a point, ignoring our own overlay.
   *
   * elementFromPoint() alone is not enough: our notes and region boxes are
   * hit-testable by design (you have to be able to click them), so any point
   * underneath one reports the overlay host instead of the page content. That
   * would anchor a new annotation to our own UI, or describe a boxed image as
   * an anonymous region. elementsFromPoint() returns the whole stack topmost
   * first, so we can simply skip our own layers and take what the user
   * actually pointed at. */
  function elementUnder(clientX, clientY) {
    if (document.elementsFromPoint) {
      const stack = document.elementsFromPoint(clientX, clientY);
      for (const candidate of stack) {
        if (!isOurs(candidate)) return candidate;
      }
      return null;
    }
    const single = document.elementFromPoint(clientX, clientY);
    return single && !isOurs(single) ? single : null;
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < MAX_PATH_DEPTH) {
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
        parts.unshift('#' + CSS.escape(node.id));
        return parts.join(' > ');
      }
      const tag = node.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') {
        parts.unshift(tag);
        break;
      }
      const parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      let idx = 1;
      for (const sib of parent.children) {
        if (sib === node) break;
        if (sib.tagName === node.tagName) idx++;
      }
      parts.unshift(tag + ':nth-of-type(' + idx + ')');
      node = parent;
    }
    return parts.join(' > ');
  }

  function resolvePath(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch (_) {
      return null; // a stored path can become syntactically invalid; don't throw
    }
  }

  /* --- flat text index ------------------------------------------------ */

  /* Builds one string of all visible page text plus a map back to the text
   * nodes that produced it, so a quote match can be converted into a real
   * Range. Rebuilt on demand rather than cached: the DOM may have changed
   * between restores and a stale index would relocate annotations wrongly. */
  function buildTextIndex() {
    const segments = [];
    let text = '';
    if (!document.body) return { text, segments };

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT;
        }
        if (isOurs(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let n;
    while ((n = walker.nextNode())) {
      segments.push({
        node: n,
        start: text.length,
        end: text.length + n.nodeValue.length
      });
      text += n.nodeValue;
    }
    return { text, segments };
  }

  function locate(index, offset) {
    // Binary search for the segment containing `offset`.
    let lo = 0;
    let hi = index.segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = index.segments[mid];
      if (offset < seg.start) hi = mid - 1;
      else if (offset >= seg.end) lo = mid + 1;
      else return { node: seg.node, offset: offset - seg.start };
    }
    const last = index.segments[index.segments.length - 1];
    return last ? { node: last.node, offset: last.node.nodeValue.length } : null;
  }

  function rangeFromOffsets(index, start, end) {
    if (end <= start) return null;
    const a = locate(index, start);
    const b = locate(index, end - 1);
    if (!a || !b) return null;
    const range = document.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset + 1);
    } catch (_) {
      return null;
    }
    return range;
  }

  /* --- quotes --------------------------------------------------------- */

  function quoteForRange(range) {
    const index = buildTextIndex();
    const exact = range.toString();
    if (!exact) return null;

    // Find where this range sits in the flat index by matching the start
    // container, rather than searching for the text - the same words may
    // appear many times and we want THIS occurrence.
    let base = -1;
    for (const seg of index.segments) {
      if (seg.node === range.startContainer) {
        base = seg.start + range.startOffset;
        break;
      }
    }
    if (base < 0) base = index.text.indexOf(exact); // fallback
    if (base < 0) return { prefix: '', exact, suffix: '' };

    return {
      prefix: index.text.slice(Math.max(0, base - QUOTE_CONTEXT), base),
      exact,
      suffix: index.text.slice(base + exact.length, base + exact.length + QUOTE_CONTEXT)
    };
  }

  function commonPrefixLen(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }

  function commonSuffixLen(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
  }

  /* Finds the best occurrence of a quote. Every occurrence of `exact` is
   * scored by how much of its stored prefix/suffix context still matches, so
   * repeated phrases ("Read more", "Submit") relocate to the right one. */
  function findQuote(quote) {
    if (!quote || !quote.exact) return null;
    const index = buildTextIndex();
    const text = index.text;
    const exact = quote.exact;

    let best = null;
    let bestScore = -1;
    let from = 0;
    for (;;) {
      const at = text.indexOf(exact, from);
      if (at < 0) break;
      from = at + 1;

      const prefix = text.slice(Math.max(0, at - QUOTE_CONTEXT), at);
      const suffix = text.slice(at + exact.length, at + exact.length + QUOTE_CONTEXT);
      const score =
        commonSuffixLen(prefix, quote.prefix || '') +
        commonPrefixLen(suffix, quote.suffix || '');

      if (score > bestScore) {
        bestScore = score;
        best = at;
      }
    }
    if (best === null) return null;
    return rangeFromOffsets(index, best, best + exact.length);
  }

  /* --- public API ------------------------------------------------------ */

  AT.anchor = {
    QUOTE_CONTEXT,
    cssPath,
    resolvePath,
    buildTextIndex,
    rangeFromOffsets,
    findQuote,
    isOurs,
    elementUnder,

    /* Text selection -> storable anchor. */
    serializeRange(range) {
      const startEl =
        range.startContainer.nodeType === 1
          ? range.startContainer
          : range.startContainer.parentElement;
      return {
        kind: 'quote',
        selector: cssPath(startEl),
        quote: quoteForRange(range)
      };
    },

    /* Storable anchor -> live Range, or null if the text is gone.
     * The CSS path only CONFIRMS that a quote match sits where we expect; it
     * is never trusted on its own. */
    resolveRange(anchor) {
      if (!anchor || !anchor.quote) return null;
      const range = findQuote(anchor.quote);
      if (!range) return null;

      if (anchor.selector) {
        const expected = resolvePath(anchor.selector);
        const actual =
          range.startContainer.nodeType === 1
            ? range.startContainer
            : range.startContainer.parentElement;
        // A mismatch is tolerated - the page may legitimately have re-rendered
        // around the text. We reject only when the path resolves somewhere
        // that does not contain the match AND the quote carried no context to
        // disambiguate with, i.e. we have no real evidence either way.
        if (
          expected &&
          actual &&
          !expected.contains(actual) &&
          !(anchor.quote.prefix || anchor.quote.suffix)
        ) {
          return null;
        }
      }
      return range;
    },

    /* Point (sticky note, text box, arrow endpoint) -> storable anchor.
     * Stored relative to an element rather than as absolute page pixels, so a
     * reflow - different window width, an expanded cookie banner - carries the
     * note along with the content it was attached to. */
    serializePoint(clientX, clientY) {
      const pageX = clientX + window.scrollX;
      const pageY = clientY + window.scrollY;

      // elementUnder() looks past our own overlay, so dropping a note on top
      // of an existing note still anchors to the page content beneath both.
      let el = elementUnder(clientX, clientY);
      if (!el || el === document.documentElement) el = document.body;

      const rect = el.getBoundingClientRect();
      return {
        kind: 'point',
        selector: cssPath(el),
        offset: {
          x: Math.round(pageX - (rect.left + window.scrollX)),
          y: Math.round(pageY - (rect.top + window.scrollY))
        },
        // Absolute page coords kept purely as a last-resort fallback for when
        // the anchor element is gone entirely.
        page: { x: Math.round(pageX), y: Math.round(pageY) }
      };
    },

    /* A client-space rect (getBoundingClientRect) as PAGE coordinates.
     * Recorded on every annotation so the review page can work out where it
     * sat inside a screenshot: page coordinate minus the shot's scroll offset
     * gives the position within the captured image. */
    pageRect(rect) {
      if (!rect) return null;
      return {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      };
    },

    /* Storable point anchor -> {x, y} in document coordinates. */
    resolvePoint(anchor) {
      if (!anchor) return null;
      const el = resolvePath(anchor.selector);
      if (el) {
        const rect = el.getBoundingClientRect();
        return {
          x: rect.left + window.scrollX + (anchor.offset ? anchor.offset.x : 0),
          y: rect.top + window.scrollY + (anchor.offset ? anchor.offset.y : 0),
          exact: true
        };
      }
      if (anchor.page) return { x: anchor.page.x, y: anchor.page.y, exact: false };
      return null;
    }
  };
})();
