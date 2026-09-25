/* Annotate Tool - tools/highlight.js
 *
 * Marks part of a page. Two shapes, one tool:
 *
 *   TEXT highlight   - drag across words. The text nodes get wrapped so the
 *                      mark follows the text as it wraps and reflows.
 *   REGION highlight - drag anywhere that yields no text selection. Draws a
 *                      translucent box instead, which is the only thing that
 *                      works over images, canvases, video posters, SVG charts
 *                      and CSS background art.
 *
 * The two are told apart by RESULT, not by guessing up front: on mouseup, if
 * the browser produced a selection we wrap it, and if it did not we treat the
 * drag as a region. Dragging across an image never creates a selection, so an
 * image reliably becomes a region without the user choosing a mode.
 *
 * WHY the text path touches the page DOM when nothing else does: a highlight
 * has to follow text across lines, columns and breakpoints. A rectangle drawn
 * in the overlay would come apart the moment the text reflowed.
 *
 * WHY the tag is <at-hl> and not <span>: an unknown element inherits nothing
 * from the page's stylesheet. `span { ... }` rules are common; `at-hl { ... }`
 * rules do not exist on anyone's site.
 *
 * WHY NOT the CSS Custom Highlight API, which would avoid the DOM entirely:
 * highlights painted that way are not hit-testable, so clicking one to attach
 * a comment would mean reverse-engineering the position through
 * caretRangeFromPoint. Commenting is the point of the tool.
 *
 * Wrapping is reversible: unwrap() restores the original text and normalises
 * the parent, so ending a session leaves the page as it was found.
 */
(function () {
  'use strict';
  const AT = (window.AT = window.AT || {});
  AT.tools = AT.tools || {};

  const TAG = 'at-hl';

  // Below this, in either dimension, a drag is treated as a stray click rather
  // than an attempt to box something.
  const MIN_REGION = 10;

  /* --- shared ---------------------------------------------------------- */

  /* #rrggbb -> rgba() at the given alpha. Region fills must be translucent or
   * they would hide the very image being pointed at. */
  function tint(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return 'rgba(244,196,48,' + alpha + ')';
    const n = parseInt(m[1], 16);
    return (
      'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) +
      ',' + alpha + ')'
    );
  }

  /* Gives a region a human-readable identity for the report. "Region at
   * 120,340" tells a reviewer nothing; "Image: pricing-table.png" does. */
  function describeRegion(clientX, clientY, w, h) {
    // Looks past our own overlay - see AT.anchor.elementUnder. Without this, a
    // note lying over the boxed area would make every region anonymous.
    const el = AT.anchor.elementUnder(clientX, clientY);

    if (el) {
      const img = el.tagName === 'IMG' ? el : el.querySelector && el.querySelector('img');
      if (img) {
        if (img.alt && img.alt.trim()) return 'Image: ' + img.alt.trim();
        if (img.currentSrc || img.src) {
          const src = img.currentSrc || img.src;
          const file = src.split('?')[0].split('#')[0].split('/').pop();
          if (file) return 'Image: ' + decodeURIComponent(file);
        }
        return 'Image';
      }
      if (el.tagName === 'CANVAS') return 'Canvas element';
      if (el.tagName === 'VIDEO') return 'Video';
      if (el.tagName === 'SVG' || el.ownerSVGElement) return 'SVG graphic';

      // Fall back to a short snippet of whatever text is in there.
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) return 'Region: ' + (text.length > 60 ? text.slice(0, 60) + '…' : text);
    }
    return 'Region (' + Math.round(w) + '×' + Math.round(h) + ')';
  }

  /* Union of several elements' boxes. A highlight spanning three lines is
   * three separate <at-hl> nodes, and the review page wants the one rectangle
   * that encloses the lot. */
  function boundsOf(nodes) {
    if (!nodes || !nodes.length) return null;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    nodes.forEach((n) => {
      const r = n.getBoundingClientRect();
      if (!r.width && !r.height) return;
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    });
    if (left === Infinity) return null;
    return { left, top, width: right - left, height: bottom - top };
  }

  function openEditor(ann, ctx, clientX, clientY) {
    ctx.popover(clientX, clientY, (pop, close) => {
      pop.appendChild(ctx.el('div', 'pop-quote', ann.text));

      const ta = document.createElement('textarea');
      ta.value = ann.comment || '';
      ta.placeholder = 'Comment on this highlight…';
      pop.appendChild(ta);

      const row = ctx.el('div', 'pop-row');

      const del = ctx.el('button', 'btn danger', 'Delete');
      del.type = 'button';
      del.addEventListener('click', async () => {
        ctx.untrack(ann.id);
        await AT.session.removeAnnotation(ann.id);
        await ctx.refreshCount();
        close();
      });
      row.appendChild(del);
      row.appendChild(ctx.el('div', 'spacer'));

      const save = ctx.el('button', 'btn primary', 'Save');
      save.type = 'button';
      save.addEventListener('click', async () => {
        ann.comment = ta.value.trim();
        await AT.session.updateAnnotation(ann.id, { comment: ann.comment });
        // Reflect the comment on the page: a commented text highlight gets an
        // underline, a commented region gets its tooltip updated.
        document
          .querySelectorAll(TAG + '[data-at-id="' + CSS.escape(ann.id) + '"]')
          .forEach((m) => {
            m.style.borderBottom = ann.comment ? '2px solid rgba(0,0,0,.45)' : '';
          });
        const box = ctx.layer.querySelector('.region[data-at-id="' + CSS.escape(ann.id) + '"]');
        if (box) box.title = ann.comment || ann.text || '';
        close();
      });
      row.appendChild(save);

      pop.appendChild(row);
      setTimeout(() => ta.focus(), 0);
    });
  }

  /* --- text highlights -------------------------------------------------- */

  /* Splits the range's boundary text nodes so every node is then WHOLLY inside
   * or wholly outside the range, and returns the ones inside.
   *
   * splitText() is specified to update live Range boundary points, so after
   * splitting, `range` already points at the correct (new) nodes - which is
   * why the collection walk happens afterwards rather than being computed up
   * front and patched. */
  function sliceRange(range) {
    if (
      range.endContainer.nodeType === 3 &&
      range.endOffset > 0 &&
      range.endOffset < range.endContainer.nodeValue.length
    ) {
      range.endContainer.splitText(range.endOffset);
    }
    if (range.startContainer.nodeType === 3 && range.startOffset > 0) {
      range.startContainer.splitText(range.startOffset);
    }

    const root =
      range.commonAncestorContainer.nodeType === 3
        ? range.commonAncestorContainer.parentNode
        : range.commonAncestorContainer;

    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.length) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT;
        }
        if (AT.anchor.isOurs(n)) return NodeFilter.FILTER_REJECT;
        return range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    let n;
    while ((n = walker.nextNode())) nodes.push(n);

    // intersectsNode() is also true for a node that merely ABUTS a boundary,
    // which after splitting means the leftover head and tail fragments - the
    // very text the user did not select. The comparisons below must therefore
    // be STRICT: a node touching the range at exactly one point has zero
    // overlap and must be excluded, or the highlight bleeds past the selection.
    return nodes.filter((node) => {
      const probe = document.createRange();
      probe.selectNodeContents(node);
      const startsBeforeEnd = range.compareBoundaryPoints(Range.END_TO_START, probe) < 0;
      const endsAfterStart = range.compareBoundaryPoints(Range.START_TO_END, probe) > 0;
      return startsBeforeEnd && endsAfterStart;
    });
  }

  function wrap(range, ann) {
    const nodes = sliceRange(range);
    const wraps = [];
    for (const node of nodes) {
      const mark = document.createElement(TAG);
      mark.setAttribute('data-at-id', ann.id);
      mark.style.cssText =
        'background-color:' + ann.color + ';' +
        'color:inherit;border-radius:2px;padding:0;margin:0;' +
        'cursor:pointer;box-decoration-break:clone;' +
        '-webkit-box-decoration-break:clone;';
      if (ann.comment) mark.style.borderBottom = '2px solid rgba(0,0,0,.45)';
      node.parentNode.insertBefore(mark, node);
      mark.appendChild(node);
      wraps.push(mark);
    }
    return wraps;
  }

  function unwrap(id) {
    const marks = document.querySelectorAll(TAG + '[data-at-id="' + CSS.escape(id) + '"]');
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      mark.remove();
      // Re-joins the text nodes we split, so a later highlight over the same
      // paragraph sees clean text rather than our fragmentation.
      if (parent) parent.normalize();
    });
  }

  function bindClicks(wraps, ann, ctx) {
    wraps.forEach((mark) => {
      mark.addEventListener('click', (e) => {
        // Only intercept while a session runs, so a leftover highlight never
        // swallows a real link click.
        if (!ctx.isActive) return;
        e.preventDefault();
        e.stopPropagation();
        openEditor(ann, ctx, e.clientX, e.clientY);
      });
    });
  }

  /* --- region highlights ------------------------------------------------ */

  function drawRegion(ann, ctx) {
    const pos = AT.anchor.resolvePoint(ann.anchor);
    if (!pos) return null;
    const size = (ann.anchor && ann.anchor.size) || { w: 0, h: 0 };

    const box = ctx.el('div', 'region');
    box.dataset.atId = ann.id;
    box.style.left = pos.x + 'px';
    box.style.top = pos.y + 'px';
    box.style.width = size.w + 'px';
    box.style.height = size.h + 'px';
    box.style.borderColor = ann.color;
    box.style.background = tint(ann.color, 0.22);
    box.title = ann.comment || ann.text || '';
    if (!pos.exact) box.classList.add('unplaced');

    box.addEventListener('click', (e) => {
      if (!ctx.isActive) return;
      e.preventDefault();
      e.stopPropagation();
      openEditor(ann, ctx, e.clientX, e.clientY);
    });

    ctx.layer.appendChild(box);
    return box;
  }

  /* --- arming ----------------------------------------------------------- */

  let downAt = null;
  let band = null;
  let onMouseDown = null;
  let onMouseMove = null;
  let onMouseUp = null;
  let onDragStart = null;

  function clearBand() {
    if (band) {
      band.remove();
      band = null;
    }
  }

  AT.tools.highlight = {
    id: 'highlight',
    label: 'Highlight',

    arm(ctx) {
      downAt = null;

      onMouseDown = (e) => {
        if (e.button !== 0 || AT.anchor.isOurs(e.target)) {
          downAt = null;
          return;
        }
        downAt = { x: e.clientX, y: e.clientY };
      };

      /* Without this, dragging across an image starts the browser's native
       * image drag - you get a drag ghost and no region. Suppressing dragstart
       * while the tool is armed is what makes images selectable at all. */
      onDragStart = (e) => {
        if (!AT.anchor.isOurs(e.target)) e.preventDefault();
      };

      onMouseMove = (e) => {
        if (!downAt) return;
        // While the browser is building a text selection we stay out of the
        // way; an empty selection means we are dragging over something with no
        // text, which is exactly the region case.
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) {
          clearBand();
          return;
        }
        const x = Math.min(downAt.x, e.clientX);
        const y = Math.min(downAt.y, e.clientY);
        const w = Math.abs(e.clientX - downAt.x);
        const h = Math.abs(e.clientY - downAt.y);
        if (w < MIN_REGION && h < MIN_REGION) return;

        if (!band) {
          band = ctx.el('div', 'region');
          band.style.borderColor = ctx.color;
          band.style.background = tint(ctx.color, 0.22);
          band.style.pointerEvents = 'none';
          ctx.layer.appendChild(band);
        }
        band.style.left = x + window.scrollX + 'px';
        band.style.top = y + window.scrollY + 'px';
        band.style.width = w + 'px';
        band.style.height = h + 'px';
      };

      onMouseUp = async (e) => {
        // Ignore mouseups inside our own UI - selecting text in the comment
        // box must not create a highlight of the comment box.
        if (AT.anchor.isOurs(e.target)) {
          downAt = null;
          clearBand();
          return;
        }

        const start = downAt;
        downAt = null;
        clearBand();

        const sel = window.getSelection();
        const text = sel && !sel.isCollapsed ? sel.toString().trim() : '';

        /* --- text --- */
        if (text) {
          const range = sel.getRangeAt(0);
          const anchor = AT.anchor.serializeRange(range);
          const ann = await AT.session.addAnnotation({
            type: 'highlight',
            color: ctx.color,
            text: text,
            anchor: anchor
          });
          if (!ann) return;
          const wraps = wrap(range, ann);
          bindClicks(wraps, ann, ctx);
          ctx.track(ann, []); // page-DOM wraps are torn down by remove()

          // Rect is read from the WRAPPED nodes, not the range: the range
          // collapses once the selection is cleared.
          await AT.session.updateAnnotation(ann.id, {
            rect: AT.anchor.pageRect(boundsOf(wraps))
          });
          sel.removeAllRanges();
          await ctx.refreshCount();
          ctx.autoCapture(ann.id);
          return;
        }

        /* --- region --- */
        if (!start) return;
        const w = Math.abs(e.clientX - start.x);
        const h = Math.abs(e.clientY - start.y);
        if (w < MIN_REGION || h < MIN_REGION) return;

        const left = Math.min(start.x, e.clientX);
        const top = Math.min(start.y, e.clientY);

        const anchor = AT.anchor.serializePoint(left, top);
        anchor.kind = 'region';
        anchor.size = { w: Math.round(w), h: Math.round(h) };

        const ann = await AT.session.addAnnotation({
          type: 'highlight',
          color: ctx.color,
          text: describeRegion(left + w / 2, top + h / 2, w, h),
          anchor: anchor,
          rect: AT.anchor.pageRect({ left: left, top: top, width: w, height: h })
        });
        if (!ann) return;

        const box = drawRegion(ann, ctx);
        ctx.track(ann, box ? [box] : []);
        await ctx.refreshCount();
        ctx.autoCapture(ann.id);
      };

      document.addEventListener('mousedown', onMouseDown, true);
      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('mouseup', onMouseUp, true);
      document.addEventListener('dragstart', onDragStart, true);
      ctx.toast('Select text to highlight it, or drag a box over an image. Esc to stop.');
    },

    disarm() {
      downAt = null;
      clearBand();
      if (onMouseDown) document.removeEventListener('mousedown', onMouseDown, true);
      if (onMouseMove) document.removeEventListener('mousemove', onMouseMove, true);
      if (onMouseUp) document.removeEventListener('mouseup', onMouseUp, true);
      if (onDragStart) document.removeEventListener('dragstart', onDragStart, true);
      onMouseDown = onMouseMove = onMouseUp = onDragStart = null;
    },

    /* Restore after a reload. Returns false when the target can no longer be
     * found, which the overlay turns into an "unplaced" flag. */
    place(ann, ctx) {
      if (ann.anchor && ann.anchor.kind === 'region') {
        const box = drawRegion(ann, ctx);
        if (!box) return false;
        ctx.track(ann, [box]);
        // A region whose anchor element vanished falls back to raw page
        // coordinates, which are unreliable after a reflow - report that.
        return !box.classList.contains('unplaced');
      }

      unwrap(ann.id); // guard against a double restore stacking wraps
      const range = AT.anchor.resolveRange(ann.anchor);
      if (!range) return false;
      const wraps = wrap(range, ann);
      if (!wraps.length) return false;
      bindClicks(wraps, ann, ctx);
      ctx.track(ann, []);
      return true;
    },

    /* Called by the overlay when an annotation is untracked, so ending a
     * session or deleting a highlight leaves the page markup as found. */
    remove(ann) {
      unwrap(ann.id);
    },

    // Exposed for the test harness.
    _sliceRange: sliceRange,
    _wrap: wrap,
    _unwrap: unwrap,
    _tint: tint,
    _describeRegion: describeRegion
  };
})();
