/* Annotate Tool - core/box-tool.js
 *
 * Factory for a point-anchored, draggable box of text. Currently the note
 * tool is its only caller, but create/drag/edit/delete/restore are all here
 * rather than in the tool file, so a second box-shaped tool - a "blur this
 * region" marker, say - is one more call to makeBoxTool with a different
 * styleFor and nothing duplicated.
 */
(function () {
  'use strict';
  const AT = (window.AT = window.AT || {});

  // Pointer travel, in px, above which a mousedown counts as a drag rather
  // than a click. Without this, the tiny mouse movement during an ordinary
  // click would nudge every note a pixel or two every time it was opened.
  const DRAG_THRESHOLD = 4;

  // How much of a note's text appears on its face before being cut. Roughly a
  // line and a half at the note's width - enough to recognise which note it is
  // without the box growing large enough to hide the page underneath.
  const PREVIEW_CHARS = 64;

  AT.makeBoxTool = function makeBoxTool(config) {
    const { id, label, className, styleFor, placeholder, hint } = config;

    let onClick = null;

    function openEditor(ann, node, ctx, clientX, clientY) {
      ctx.popover(clientX, clientY, (pop, close) => {
        const ta = document.createElement('textarea');
        ta.value = ann.text || '';
        ta.placeholder = placeholder;
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
          paint(ann, node);
          await AT.session.updateAnnotation(ann.id, {
            text: ann.text,
            // Re-read after painting: the box resizes to fit its new text.
            rect: AT.anchor.pageRect(node.getBoundingClientRect())
          });
          close();
          /* Capture AFTER the editor closes, not when the note was created -
           * a note is empty at creation, and a screenshot of a blank yellow
           * box tells a reviewer nothing. Waiting until Save means the image
           * shows the note actually saying something. */
          ctx.autoCapture(ann.id);
        });
        row.appendChild(save);
        pop.appendChild(row);

        setTimeout(() => {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }, 0);
      });
    }

    /* A note on the page is a label, not a document. Showing the whole body
     * would let one long note cover the very content it is commenting on, so
     * the face carries an opening extract and the full text lives in the
     * tooltip and the editor. */
    function preview(text) {
      const flat = String(text || '').replace(/\s+/g, ' ').trim();
      if (flat.length <= PREVIEW_CHARS) return flat;
      const cut = flat.slice(0, PREVIEW_CHARS);
      const lastSpace = cut.lastIndexOf(' ');
      // Only break at a space if one falls reasonably late, otherwise a long
      // unbroken string would be truncated to almost nothing.
      return (lastSpace > PREVIEW_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut) + '…';
    }

    function paint(ann, node) {
      const text = ann.text || '';
      node.textContent = preview(text);
      node.classList.toggle('empty', !text);
      // The "click to write" prompt lives here rather than in the box face, so
      // a saved note can use its whole face to show what it says. Hovering a
      // truncated note reveals the full text.
      node.title = text || 'Click to write…';

      // Custom properties are invisible to Object.assign on a style object;
      // they only exist through setProperty.
      const styles = styleFor(ann);
      for (const key of Object.keys(styles)) {
        if (key.startsWith('--')) node.style.setProperty(key, styles[key]);
        else node.style[key] = styles[key];
      }
    }

    /* Drag moves the box and, on release, re-derives the anchor from wherever
     * it landed - so a dragged note re-attaches to whatever element is now
     * underneath it rather than keeping a stale parent. */
    function makeDraggable(ann, node, ctx) {
      node.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        const startX = e.clientX;
        const startY = e.clientY;
        const originLeft = parseFloat(node.style.left) || 0;
        const originTop = parseFloat(node.style.top) || 0;
        let moved = false;

        function onMove(ev) {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (!moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
          moved = true;
          node.style.left = originLeft + dx + 'px';
          node.style.top = originTop + dy + 'px';
        }

        async function onUp(ev) {
          window.removeEventListener('mousemove', onMove, true);
          window.removeEventListener('mouseup', onUp, true);

          if (!moved) {
            openEditor(ann, node, ctx, ev.clientX, ev.clientY);
            return;
          }
          // Hide the box for the hit-test, otherwise elementFromPoint just
          // finds the box itself and every drag would anchor to our own UI.
          const prev = node.style.pointerEvents;
          node.style.pointerEvents = 'none';
          const anchor = AT.anchor.serializePoint(ev.clientX, ev.clientY);
          node.style.pointerEvents = prev;

          ann.anchor = anchor;
          ann.unplaced = false;
          node.classList.remove("unplaced");
          await AT.session.updateAnnotation(ann.id, {
            anchor: anchor,
            unplaced: false,
            rect: AT.anchor.pageRect(node.getBoundingClientRect())
          });
        }

        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('mouseup', onUp, true);
      });
    }

    function build(ann, pos, ctx) {
      const node = ctx.el('div', className);
      node.dataset.atId = ann.id;
      node.style.left = pos.x + 'px';
      node.style.top = pos.y + 'px';
      if (!pos.exact) node.classList.add('unplaced');
      paint(ann, node);
      makeDraggable(ann, node, ctx);
      ctx.layer.appendChild(node);
      return node;
    }

    return {
      id,
      label,

      arm(ctx) {
        onClick = async (e) => {
          if (AT.anchor.isOurs(e.target)) return;
          // Swallow the click so we do not follow a link or submit a form on
          // the page we are only meant to be marking up.
          e.preventDefault();
          e.stopPropagation();

          const anchor = AT.anchor.serializePoint(e.clientX, e.clientY);
          const ann = await AT.session.addAnnotation({
            type: id,
            color: ctx.color,
            text: '',
            anchor: anchor
          });
          if (!ann) return;

          const pos = AT.anchor.resolvePoint(anchor);
          const node = build(ann, pos, ctx);
          ctx.track(ann, [node]);
          await AT.session.updateAnnotation(ann.id, {
            rect: AT.anchor.pageRect(node.getBoundingClientRect())
          });
          await ctx.refreshCount();
          openEditor(ann, node, ctx, e.clientX, e.clientY);

          ctx.armTool(null); // one placement per arming - matches how people
                             // actually annotate, and avoids stray boxes
        };
        document.addEventListener('click', onClick, true);
        ctx.toast(hint);
      },

      disarm() {
        if (onClick) {
          document.removeEventListener('click', onClick, true);
          onClick = null;
        }
      },

      place(ann, ctx) {
        const pos = AT.anchor.resolvePoint(ann.anchor);
        if (!pos) return false;
        const node = build(ann, pos, ctx);
        ctx.track(ann, [node]);
        return pos.exact;
      }
    };
  };
})();
