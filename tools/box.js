/* Annotate Tool - tools/box.js
 *
 * Drag out a rectangle: a solid outline in the current colour, with a 10% fill
 * that appears only on hover.
 *
 * NOT to be confused with core/box-tool.js, which is the factory behind the
 * NOTE tool (a point-anchored, draggable box of text). This file is the drawn
 * rectangle you pull around part of a page.
 *
 * WHY outline-only rather than the region highlight's permanent tint: a box is
 * for framing something you still need to read - a table, a form, a paragraph
 * of terms. A filled overlay sits between the reviewer and that content. The
 * fill on hover gives the "yes, this one" feedback without ever obscuring what
 * is underneath while you are looking at it.
 *
 * The fill is done in CSS with color-mix rather than by computing an rgba() in
 * JS, so a single inline custom property drives both the border and the hover
 * wash and they can never drift apart.
 */
(function () {
  'use strict';
  const AT = (window.AT = window.AT || {});
  AT.tools = AT.tools || {};

  // Below this, in either dimension, a drag is a stray click rather than an
  // attempt to frame something.
  const MIN_BOX = 10;

  let downAt = null;
  let band = null;
  let onMouseDown = null;
  let onMouseMove = null;
  let onMouseUp = null;

  function clearBand(ctx) {
    if (band) {
      band.remove();
      band = null;
    }
  }

  function paintTitle(ann, node) {
    node.title = ann.text
      ? ann.text
      : 'Click to say what this box is marking';
  }

  function draw(ann, ctx) {
    const pos = AT.anchor.resolvePoint(ann.anchor);
    if (!pos) return null;
    const size = (ann.anchor && ann.anchor.size) || { w: 0, h: 0 };

    const node = ctx.el('div', 'abox');
    node.dataset.atId = ann.id;
    node.style.left = pos.x + 'px';
    node.style.top = pos.y + 'px';
    node.style.width = size.w + 'px';
    node.style.height = size.h + 'px';
    // One property drives the outline AND the hover wash - see the header.
    node.style.setProperty('--at-line', ann.color);
    paintTitle(ann, node);
    if (!pos.exact) node.classList.add('unplaced');

    node.addEventListener('click', (e) => {
      if (!ctx.isActive) return;
      e.preventDefault();
      e.stopPropagation();
      openEditor(ann, node, ctx, e.clientX, e.clientY);
    });

    ctx.layer.appendChild(node);
    return node;
  }

  function openEditor(ann, node, ctx, clientX, clientY) {
    ctx.popover(clientX, clientY, (pop, close) => {
      const ta = document.createElement('textarea');
      ta.value = ann.text || '';
      ta.placeholder = 'What is inside this box?';
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
        ann.text = ta.value;
        await AT.session.updateAnnotation(ann.id, { text: ann.text });
        paintTitle(ann, node);
        close();
        /* Captured after the editor closes, so the shot shows the finished
         * box rather than an empty outline with a popover over it. */
        ctx.autoCapture(ann.id);
      });
      row.appendChild(save);

      pop.appendChild(row);
      setTimeout(() => ta.focus(), 0);
    });
  }

  AT.tools.box = {
    id: 'box',
    label: 'Box',

    arm(ctx) {
      downAt = null;

      onMouseDown = (e) => {
        if (e.button !== 0 || AT.anchor.isOurs(e.target)) {
          downAt = null;
          return;
        }
        /* Suppresses the text selection and native image drag that would
         * otherwise start under the cursor. A box is pure geometry - it never
         * wants whatever the browser thinks is being selected. */
        e.preventDefault();
        downAt = { x: e.clientX, y: e.clientY };
      };

      onMouseMove = (e) => {
        if (!downAt) return;
        const x = Math.min(downAt.x, e.clientX);
        const y = Math.min(downAt.y, e.clientY);
        const w = Math.abs(e.clientX - downAt.x);
        const h = Math.abs(e.clientY - downAt.y);
        if (w < MIN_BOX && h < MIN_BOX) return;

        if (!band) {
          band = ctx.el('div', 'abox');
          band.style.setProperty('--at-line', ctx.color);
          band.style.pointerEvents = 'none';
          ctx.layer.appendChild(band);
        }
        band.style.left = x + window.scrollX + 'px';
        band.style.top = y + window.scrollY + 'px';
        band.style.width = w + 'px';
        band.style.height = h + 'px';
      };

      onMouseUp = async (e) => {
        if (AT.anchor.isOurs(e.target)) {
          downAt = null;
          clearBand(ctx);
          return;
        }
        const start = downAt;
        downAt = null;
        clearBand(ctx);
        if (!start) return;

        const w = Math.abs(e.clientX - start.x);
        const h = Math.abs(e.clientY - start.y);
        if (w < MIN_BOX || h < MIN_BOX) return;

        const left = Math.min(start.x, e.clientX);
        const top = Math.min(start.y, e.clientY);

        const anchor = AT.anchor.serializePoint(left, top);
        anchor.kind = 'box';
        anchor.size = { w: Math.round(w), h: Math.round(h) };

        const ann = await AT.session.addAnnotation({
          type: 'box',
          color: ctx.color,
          text: '',
          anchor: anchor,
          rect: AT.anchor.pageRect({ left: left, top: top, width: w, height: h })
        });
        if (!ann) return;

        const node = draw(ann, ctx);
        ctx.track(ann, node ? [node] : []);
        await ctx.refreshCount();
        ctx.armTool(null);

        // Same as the note and arrow tools: ask for the words while the user
        // still has in mind why they drew it.
        if (node) openEditor(ann, node, ctx, e.clientX, e.clientY);
      };

      document.addEventListener('mousedown', onMouseDown, true);
      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('mouseup', onMouseUp, true);
      ctx.toast('Drag a box around what you want to mark. Esc to stop.');
    },

    disarm(ctx) {
      downAt = null;
      clearBand(ctx);
      if (onMouseDown) document.removeEventListener('mousedown', onMouseDown, true);
      if (onMouseMove) document.removeEventListener('mousemove', onMouseMove, true);
      if (onMouseUp) document.removeEventListener('mouseup', onMouseUp, true);
      onMouseDown = onMouseMove = onMouseUp = null;
    },

    place(ann, ctx) {
      const node = draw(ann, ctx);
      if (!node) return false;
      ctx.track(ann, [node]);
      return !node.classList.contains('unplaced');
    }
  };
})();
