/* Annotate Tool - Copyright (C) 2026 Mark Van de Velde
 * SPDX-License-Identifier: GPL-3.0-only
 * This program comes with ABSOLUTELY NO WARRANTY. See LICENSE for terms.
 */
/* Annotate Tool - tools/arrow.js
 *
 * Two-click arrow: click the tail, click the head. Drawn as SVG into the
 * overlay's document-sized <svg>, so it can span the whole page.
 *
 * BOTH ENDPOINTS ARE ANCHORED INDEPENDENTLY. An arrow's whole job is to say
 * "this thing relates to that thing", so if the page reflows and the two ends
 * move by different amounts, the arrow must stretch rather than translate.
 * That is why there is no single origin + delta - see core/anchor.js.
 *
 * The arrowhead is drawn as an explicit polygon rather than an SVG <marker>.
 * Markers inherit stroke-width scaling in ways that make a thin arrow's head
 * nearly invisible and a thick one's head enormous, and getting consistent
 * results across page zoom levels is more code than just placing the triangle.
 */
(function () {
  'use strict';
  const AT = (window.AT = window.AT || {});
  AT.tools = AT.tools || {};

  const NS = 'http://www.w3.org/2000/svg';
  const WIDTH = 3;
  const HEAD = 13; // arrowhead length in px
  const HIT_WIDTH = 14; // invisible fat stroke that makes the arrow clickable

  // The label sits this far above the arrow's tail, clear of the shaft.
  const LABEL_OFFSET = 30;
  // Marks the label as our note rather than page content.
  const LABEL_PREFIX = '✎ '; // pencil

  let pending = null; // first click of a pair, held until the second
  let ghost = null; // rubber-band line following the cursor
  let onClick = null;
  let onMove = null;

  function svgEl(tag, attrs) {
    const node = document.createElementNS(NS, tag);
    for (const k of Object.keys(attrs || {})) node.setAttribute(k, attrs[k]);
    return node;
  }

  function draw(ann, from, to, ctx) {
    const group = svgEl('g', { 'data-at-id': ann.id });
    group.style.pointerEvents = 'auto';
    group.style.cursor = 'pointer';

    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    // Stop the shaft short of the tip so the line does not poke through the
    // arrowhead's point at low zoom.
    const shaftX = to.x - Math.cos(angle) * (HEAD * 0.85);
    const shaftY = to.y - Math.sin(angle) * (HEAD * 0.85);

    // Invisible wide stroke first: gives a forgiving click target without
    // making the visible arrow fat.
    group.appendChild(
      svgEl('line', {
        x1: from.x, y1: from.y, x2: to.x, y2: to.y,
        stroke: 'transparent', 'stroke-width': HIT_WIDTH
      })
    );

    group.appendChild(
      svgEl('line', {
        x1: from.x, y1: from.y, x2: shaftX, y2: shaftY,
        stroke: ann.color, 'stroke-width': WIDTH, 'stroke-linecap': 'round'
      })
    );

    const spread = 0.42; // radians either side of the shaft
    const points = [
      to.x + ',' + to.y,
      (to.x - Math.cos(angle - spread) * HEAD) + ',' + (to.y - Math.sin(angle - spread) * HEAD),
      (to.x - Math.cos(angle + spread) * HEAD) + ',' + (to.y - Math.sin(angle + spread) * HEAD)
    ].join(' ');
    group.appendChild(svgEl('polygon', { points: points, fill: ann.color }));

    group.addEventListener('click', (e) => {
      if (!ctx.isActive) return;
      e.preventDefault();
      e.stopPropagation();
      openEditor(ann, ctx, e.clientX, e.clientY);
    });

    ctx.svg.appendChild(group);
    return group;
  }

  /* An arrow that carries a note has to SAY so on the page.
   *
   * Without this the note is invisible until you happen to click the arrow -
   * which means that on a page with several arrows you cannot tell which of
   * them you already wrote something on. The label is drawn in the HTML layer
   * rather than as SVG text: CSS gives ellipsis truncation, a tooltip and
   * consistent styling with the note tool for free, none of which SVG text
   * does without a lot of measuring. */
  function drawLabel(ann, from, ctx) {
    if (!ann.text || !String(ann.text).trim()) return null;

    const label = ctx.el('div', 'arrow-label');
    label.dataset.atId = ann.id;
    label.textContent = LABEL_PREFIX + String(ann.text).replace(/\s+/g, ' ').trim();
    label.title = ann.text;
    label.style.setProperty('--at-ring', ann.color);
    // Sits just above the tail, which is where the reader's eye starts.
    label.style.left = from.x + 'px';
    label.style.top = (from.y - LABEL_OFFSET) + 'px';

    label.addEventListener('click', (e) => {
      if (!ctx.isActive) return;
      e.preventDefault();
      e.stopPropagation();
      openEditor(ann, ctx, e.clientX, e.clientY);
    });

    ctx.layer.appendChild(label);
    return label;
  }

  /* Redraws just the label after an edit, so saving a note makes it appear
   * immediately rather than on the next reload. */
  function refreshLabel(ann, ctx) {
    const existing = ctx.layer.querySelector(
      '.arrow-label[data-at-id="' + CSS.escape(ann.id) + '"]');
    if (existing) existing.remove();
    if (!ann.anchor || !ann.anchor.from) return;
    const from = AT.anchor.resolvePoint(ann.anchor.from);
    if (from) drawLabel(ann, from, ctx);
  }

  function openEditor(ann, ctx, clientX, clientY) {
    ctx.popover(clientX, clientY, (pop, close, onClose) => {
      /* The screenshot is taken when this editor CLOSES, not when the arrow
       * was drawn. Two separate bugs came from getting that wrong, and the
       * second one is not obvious.
       *
       * 1. The shot fired before anything had been typed, so the image showed
       *    an arrow with no label and the record carried no text.
       *
       * 2. The editor appeared IN the shot, on top of the thing being
       *    annotated - even though withChromeHidden() hides popovers. It hides
       *    the ones it can see: it collects them, THEN waits two animation
       *    frames before capturing. Capture started at draw time, when there
       *    was no popover yet, and openEditor created one during that wait. A
       *    race, not a missing case - and capturing after the editor is gone
       *    removes the race rather than patching around it.
       *
       * The note and box tools already captured on Save; the arrow did not,
       * because it opens its editor automatically after drawing.
       *
       * Registered here rather than only in Save so that dismissing the editor
       * still captures: unlike an empty note, an arrow is a real mark whether
       * or not anything was typed on it. Delete clears it - there is nothing
       * left to photograph. */
      onClose(() => ctx.autoCapture(ann.id));
      const ta = document.createElement('textarea');
      ta.value = ann.text || '';
      ta.placeholder = 'What is this arrow pointing out?';
      pop.appendChild(ta);

      const row = ctx.el('div', 'pop-row');
      const del = ctx.el('button', 'btn danger', 'Delete');
      del.type = 'button';
      del.addEventListener('click', async () => {
        ctx.untrack(ann.id);
        await AT.session.removeAnnotation(ann.id);
        await ctx.refreshCount();
        pop._onClose = null; // nothing left to photograph
        close();
      });
      row.appendChild(del);
      row.appendChild(ctx.el('div', 'spacer'));

      const save = ctx.el('button', 'btn primary', 'Save');
      save.type = 'button';
      save.addEventListener('click', async () => {
        ann.text = ta.value;
        await AT.session.updateAnnotation(ann.id, { text: ann.text });
        refreshLabel(ann, ctx);
        close();
      });
      row.appendChild(save);
      pop.appendChild(row);
      setTimeout(() => ta.focus(), 0);
    });
  }

  function clearGhost() {
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
  }

  AT.tools.arrow = {
    id: 'arrow',
    label: 'Arrow',

    arm(ctx) {
      pending = null;

      onMove = (e) => {
        if (!pending) return;
        const from = AT.anchor.resolvePoint(pending.anchor);
        if (!from) return;
        if (!ghost) {
          ghost = svgEl('line', {
            stroke: ctx.color,
            'stroke-width': WIDTH,
            'stroke-dasharray': '6 5',
            'stroke-linecap': 'round',
            opacity: '0.75'
          });
          ctx.svg.appendChild(ghost);
        }
        ghost.setAttribute('x1', from.x);
        ghost.setAttribute('y1', from.y);
        ghost.setAttribute('x2', e.clientX + window.scrollX);
        ghost.setAttribute('y2', e.clientY + window.scrollY);
      };

      onClick = async (e) => {
        if (AT.anchor.isOurs(e.target)) return;
        e.preventDefault();
        e.stopPropagation();

        const anchor = AT.anchor.serializePoint(e.clientX, e.clientY);

        if (!pending) {
          pending = { anchor: anchor };
          ctx.toast('Now click where the arrow should point.');
          return;
        }

        const ann = await AT.session.addAnnotation({
          type: 'arrow',
          color: ctx.color,
          text: '',
          anchor: { kind: 'arrow', from: pending.anchor, to: anchor }
        });
        pending = null;
        clearGhost();
        if (!ann) return;

        const from = AT.anchor.resolvePoint(ann.anchor.from);
        const to = AT.anchor.resolvePoint(ann.anchor.to);
        if (from && to) {
          const group = draw(ann, from, to, ctx);
          ctx.track(ann, [group]);
          // Bounding box of the two endpoints, in page coordinates - already
          // page-space, so it does not go through AT.anchor.pageRect.
          await AT.session.updateAnnotation(ann.id, {
            rect: {
              x: Math.round(Math.min(from.x, to.x)),
              y: Math.round(Math.min(from.y, to.y)),
              w: Math.round(Math.abs(to.x - from.x)),
              h: Math.round(Math.abs(to.y - from.y))
            }
          });
        }
        await ctx.refreshCount();
        ctx.armTool(null);

        /* Open the editor straight away, the same as the note tool does. An
         * arrow with nothing written on it only says "look here"; prompting
         * for the note at the moment of drawing is what makes the label
         * useful, and saving it makes the label appear immediately. */
        if (from && to) openEditor(ann, ctx, to.x - window.scrollX, to.y - window.scrollY);
      };

      document.addEventListener('click', onClick, true);
      document.addEventListener('mousemove', onMove, true);
      ctx.toast('Click the start of the arrow, then its target. Esc to stop.');
    },

    disarm() {
      pending = null;
      clearGhost();
      if (onClick) {
        document.removeEventListener('click', onClick, true);
        onClick = null;
      }
      if (onMove) {
        document.removeEventListener('mousemove', onMove, true);
        onMove = null;
      }
    },

    place(ann, ctx) {
      if (!ann.anchor || !ann.anchor.from || !ann.anchor.to) return false;
      const from = AT.anchor.resolvePoint(ann.anchor.from);
      const to = AT.anchor.resolvePoint(ann.anchor.to);
      if (!from || !to) return false;
      const group = draw(ann, from, to, ctx);
      // The label is tracked alongside the arrow so teardown removes both.
      const label = drawLabel(ann, from, ctx);
      ctx.track(ann, label ? [group, label] : [group]);
      return from.exact && to.exact;
    },

    /* A label added AFTER the initial track (by saving a note on an arrow that
     * had none) is not in the tracked node list, so teardown has to sweep for
     * it by id rather than relying on that list. */
    remove(ann, ctx) {
      if (!ctx || !ctx.layer) return;
      const stray = ctx.layer.querySelector(
        '.arrow-label[data-at-id="' + CSS.escape(ann.id) + '"]');
      if (stray) stray.remove();
    }
  };
})();
