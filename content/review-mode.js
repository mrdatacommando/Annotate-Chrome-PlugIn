/* Annotate Tool - Copyright (C) 2026 Mark Van de Velde
 * SPDX-License-Identifier: GPL-3.0-only
 * This program comes with ABSOLUTELY NO WARRANTY. See LICENSE for terms.
 */
/* Annotate Tool - content/review-mode.js
 *
 * The live half of the walkthrough. The review page writes the whole (trimmed)
 * item list to `at_review_live` and opens the recorded URL; this script picks
 * it up on the real page, re-places the current annotation, scrolls to it, and
 * shows a HUD that can step through the rest.
 *
 * READ-ONLY WITH RESPECT TO THE PAGE. No tools are armed and nothing is written
 * to the annotate session. The one thing it does write is a REPLY, into the
 * review state - which is a comment on somebody's finding, not a change to the
 * finding itself.
 *
 * The HUD is deliberately a different colour from the annotate toolbar so the
 * two modes can never be confused at a glance.
 *
 * Stepping is done here rather than by asking the review page each time,
 * because the review page may be in another window - a round trip per item
 * would make the arrows feel broken. Moving within one page re-places in situ;
 * moving to an item on a different page navigates the tab.
 */
(function () {
  'use strict';
  const AT = (window.AT = window.AT || {});

  const LIVE_KEY = 'at_review_live';
  const REVIEW_KEY = 'at_review';
  const HUD_ID = 'at-review-hud';

  let shadow = null;
  let host = null;
  let live = null;      // the whole stored record
  let items = [];       // live.items
  let index = 0;
  let expanded = false;
  let identityName = '';
  /* Whether a review-scoped session is running: the reviewer is adding
   * findings of their own, not just replying to somebody else's. */
  let annotating = false;
  /* How many of `items` came from the bundle itself; anything past this is
   * the reviewer's own, appended by loadMine(). */
  let bundleCount = 0;
  let mineIds = new Set();
  /* A session running that is NOT attached to this bundle. */
  let stray = false;

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }

.dock {
  position: fixed; left: 50%; transform: translateX(-50%);
  bottom: 18px; z-index: 2147483000;
  display: flex; flex-direction: column; gap: 8px;
  width: min(720px, calc(100vw - 32px));
  pointer-events: none;
}

.hud {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px; border-radius: 12px;
  /* Purple, not the annotate toolbar's near-black: at a glance this must read
     as a read-only review pass, not a session you can mark up. */
  background: #3b2a63; color: #f3efff;
  box-shadow: 0 8px 28px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.12);
  font-size: 13px; line-height: 1; pointer-events: auto;
}
.tag {
  padding: 3px 8px; border-radius: 99px;
  background: rgba(255,255,255,.16); font-size: 11px;
  text-transform: uppercase; letter-spacing: .05em; white-space: nowrap;
}
.count { font-variant-numeric: tabular-nums; opacity: .85; white-space: nowrap; }
.text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn {
  border: 0; border-radius: 8px; padding: 6px 10px;
  background: rgba(255,255,255,.14); color: inherit;
  font: inherit; font-size: 12.5px; cursor: pointer; white-space: nowrap;
}
.btn:hover { background: rgba(255,255,255,.24); }
.btn:disabled { opacity: .35; cursor: default; }
.btn.primary { background: #6d4fd0; }
.btn.step { padding: 6px 11px; font-weight: 600; }
.warn { color: #ffc48a; white-space: nowrap; }

/* --- the expanded review pane --- */
.pane {
  pointer-events: auto;
  max-height: min(52vh, 460px); overflow: auto;
  padding: 14px 16px; border-radius: 12px;
  background: #241a3f; color: #f3efff;
  box-shadow: 0 8px 28px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.12);
  font-size: 13px; line-height: 1.5;
}
.pane[hidden] { display: none; }
.pane h3 { margin: 0 0 2px; font-size: 13px; }
.pane .by { margin: 0 0 10px; font-size: 11.5px; opacity: .7; }
.pane .quote {
  margin: 0 0 10px; padding: 9px 11px; border-radius: 8px;
  background: rgba(255,255,255,.08);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.pane .said {
  margin: 0 0 10px; padding: 8px 11px; border-left: 3px solid #6d4fd0;
  background: rgba(255,255,255,.05); border-radius: 0 8px 8px 0;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.pane .lbl {
  display: block; font-size: 10.5px; text-transform: uppercase;
  letter-spacing: .05em; opacity: .6; margin-bottom: 3px;
}
.entry {
  padding: 8px 11px; border-radius: 8px; margin-bottom: 8px;
  background: rgba(255,255,255,.06);
}
.entry .who { font-weight: 600; }
.entry .when { opacity: .6; font-size: 11.5px; margin-left: 6px; }
.entry .body { margin-top: 3px; white-space: pre-wrap; overflow-wrap: anywhere; }
.none { opacity: .6; font-style: italic; margin-bottom: 10px; }
.pane textarea {
  width: 100%; min-height: 64px; resize: vertical;
  padding: 8px 10px; border-radius: 8px;
  border: 1px solid rgba(255,255,255,.18);
  background: rgba(0,0,0,.28); color: inherit; font: inherit; font-size: 13px;
}
.pane textarea:focus { outline: 2px solid #6d4fd0; outline-offset: -1px; }
.paneRow { display: flex; align-items: center; gap: 10px; margin-top: 9px; }
.paneRow .spacer { flex: 1; }
.paneRow .note { font-size: 11.5px; opacity: .65; }
`;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text; // bundle content is untrusted
    return node;
  }

  function esc(id) {
    return window.CSS && CSS.escape ? CSS.escape(id) : String(id);
  }

  function samePage(a, b) {
    try {
      const x = new URL(a);
      const y = new URL(b);
      return x.origin === y.origin && x.pathname === y.pathname;
    } catch (_) {
      return false;
    }
  }

  function when(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return isNaN(d) ? iso : d.toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
    } catch (_) {
      return iso;
    }
  }

  /* --- mounting ---------------------------------------------------------- */

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = HUD_ID;
    host.style.cssText =
      'all:initial;position:absolute;top:0;left:0;width:0;height:0;' +
      'z-index:2147483000;pointer-events:none;';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    /* Same reason as the annotate overlay: a closed shadow root retargets key
     * events to the host, which defeats the "am I typing in a field?" guard
     * that sites put on their single-letter shortcuts. Without this the reply
     * box would silently lose letters on any page with shortcuts. */
    ['keydown', 'keypress', 'keyup', 'input', 'beforeinput'].forEach((type) => {
      shadow.addEventListener(type, (e) => e.stopPropagation());
    });

    document.documentElement.appendChild(host);
  }

  function overlayContext() {
    return AT.overlay || null;
  }

  /* --- drawing the annotation on the page -------------------------------- */

  function clearDrawn() {
    document.querySelectorAll('at-hl[data-at-id]').forEach((n) => {
      if (n.dataset.atReview === '1') {
        const parent = n.parentNode;
        while (n.firstChild) parent.insertBefore(n.firstChild, n);
        n.remove();
        if (parent) parent.normalize();
      }
    });
    const ov = overlayContext();
    if (ov && ov.layer) {
      ov.layer.querySelectorAll('[data-at-review="1"]').forEach((n) => n.remove());
    }
    if (ov && ov.svg) {
      ov.svg.querySelectorAll('[data-at-review="1"]').forEach((n) => n.remove());
    }
  }

  function place(ann) {
    const ov = overlayContext();
    if (!ov || !AT.tools || !AT.tools[ann.type]) return false;
    let placed = false;
    try {
      placed = !!AT.tools[ann.type].place(ann, ov);
      document.querySelectorAll('at-hl[data-at-id="' + esc(ann.id) + '"]')
        .forEach((n) => { n.dataset.atReview = '1'; });
      if (ov.layer) {
        ov.layer.querySelectorAll('[data-at-id="' + esc(ann.id) + '"]')
          .forEach((n) => { n.dataset.atReview = '1'; });
      }
      if (ov.svg) {
        ov.svg.querySelectorAll('[data-at-id="' + esc(ann.id) + '"]')
          .forEach((n) => n.setAttribute('data-at-review', '1'));
      }
    } catch (_) {
      placed = false;
    }
    return placed;
  }

  /* Every OTHER finding on this page, drawn alongside the one being stepped to.
   *
   * Only while the reviewer is adding annotations of their own. The
   * walkthrough proper is a guided one-at-a-time pass and showing everything
   * would take that away; while adding, the opposite is what you need - you
   * cannot sensibly mark something up without seeing what has already been
   * raised on the same page.
   */
  function placeOthers() {
    if (!annotating) return;
    items.forEach((item, i) => {
      if (i === index) return;
      if (!samePage(item.pageUrl, location.href)) return;
      /* Idempotent on purpose. Starting to annotate reaches here twice - once
       * from the button, once from the storage change that starting the
       * session causes - and more paths will arrive later. Drawing the same
       * finding twice leaves two stacked copies and two click handlers. */
      if (alreadyDrawn(item.ann.id)) return;
      if (!place(item.ann)) return;
      bindReviewClick(item.ann.id, i);
    });
  }

  function alreadyDrawn(id) {
    const sel = '[data-at-review="1"][data-at-id="' + esc(id) + '"]';
    if (document.querySelector('at-hl' + sel)) return true;
    const ov = overlayContext();
    if (ov && ov.layer && ov.layer.querySelector(sel)) return true;
    if (ov && ov.svg && ov.svg.querySelector(sel)) return true;
    return false;
  }

  /* Back to the walkthrough's normal state: only the finding being stepped to.
   * Everything is cleared and the current one re-placed, rather than trying to
   * pick the others back out - clearDrawn only ever touches review-drawn
   * nodes, so the reviewer's own annotations are untouched either way. */
  function clearOthers() {
    clearDrawn();
    const item = items[index];
    if (!item || !samePage(item.pageUrl, location.href)) return;
    const ok = place(item.ann);
    render(ok);
    if (ok) bindReviewClick(item.ann.id, index);
  }

  /* Their findings are read-only here.
   *
   * place() goes through the TOOL, which wires its own editor - and that
   * editor writes through AT.session, where these annotations do not exist.
   * Left alone it would open, accept an edit and save nothing. So the click is
   * taken first, in the capture phase, and stopped before it reaches the
   * editor; what it does instead is select the finding and open the
   * discussion, which is the thing you actually want to do with somebody
   * else's note. */
  function bindReviewClick(id, i) {
    const ov = overlayContext();
    const nodes = [];
    document.querySelectorAll('at-hl[data-at-id="' + esc(id) + '"]')
      .forEach((n) => nodes.push(n));
    if (ov && ov.layer) {
      ov.layer.querySelectorAll('[data-at-id="' + esc(id) + '"]')
        .forEach((n) => nodes.push(n));
    }
    if (ov && ov.svg) {
      ov.svg.querySelectorAll('[data-at-id="' + esc(id) + '"]')
        .forEach((n) => nodes.push(n));
    }
    nodes.forEach((n) => {
      n.style.cursor = 'pointer';
      n.addEventListener('click', (e) => {
        /* An armed tool wins. A tool that did what it says everywhere except
         * on top of somebody else's mark would be the harder thing to predict,
         * and Esc disarms it in one key. */
        if (ov && ov.isArmed && ov.isArmed()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        expanded = true;
        /* Already the current one: there is nothing to step to, just open the
         * discussion. goTo returns early for its own index, so without this
         * clicking the finding you are already on would do nothing at all. */
        if (i === index) render(lastPlaced);
        else goTo(i);
      }, true);
    });
  }

  function scrollTo(ann) {
    let y = null;
    if (ann.anchor && ann.anchor.kind === 'quote') {
      const range = AT.anchor.resolveRange(ann.anchor);
      if (range) y = range.getBoundingClientRect().top + window.scrollY;
    } else if (ann.anchor) {
      const pos = AT.anchor.resolvePoint(
        ann.anchor.kind === 'arrow' ? ann.anchor.from : ann.anchor);
      if (pos) y = pos.y;
    }
    if (y == null && ann.rect) y = ann.rect.y;
    if (y == null) return;
    // A third down the viewport, clear of the sticky headers most sites have.
    window.scrollTo({ top: Math.max(0, y - window.innerHeight / 3), behavior: 'smooth' });
  }

  /* --- stepping ----------------------------------------------------------- */

  async function saveLive() {
    /* Clamped to the bundle's own items. The reviewer's additions are appended
     * to the end of the list here, but the review page builds its own order by
     * page - so an index past the bundle's count would land "Back to list" on
     * something arbitrary. The bundle items are the shared frame of reference;
     * the additions are not. */
    live.index = Math.min(index, Math.max(0, bundleCount - 1));
    await chrome.storage.local.set({ [LIVE_KEY]: live });
  }

  /* The reviewer's own additions, appended to the walkthrough list so the
   * arrows step through theirs and yours together. Rebuilt rather than
   * appended to, so an edit or a deletion made anywhere shows up here. */
  async function loadMine() {
    items = items.slice(0, bundleCount);
    mineIds = new Set();
    let session = null;
    try {
      session = await AT.store.getSession();
    } catch (_) {
      return;
    }
    if (!session || !session.reviewOf) return;
    if (live && live.bundleName && session.reviewOf !== live.bundleName) return;
    (session.pages || []).forEach((p) => {
      (p.annotations || []).forEach((a) => {
        items.push({ ann: a, pageUrl: p.url, pageTitle: p.title, mine: true });
        mineIds.add(a.id);
      });
    });
    if (index >= items.length) index = Math.max(0, items.length - 1);
  }

  async function goTo(next) {
    if (next < 0 || next >= items.length || next === index) return;
    index = next;
    await saveLive(); // the review page follows this, so Back to list lands right

    const target = items[index];
    if (samePage(target.pageUrl, location.href)) {
      // Same document: swap the drawing without a navigation.
      clearDrawn();
      render();
      const ok = place(target.ann);
      if (ok) scrollTo(target.ann);
      render(ok);
      /* The one being stepped to needs the same treatment as the rest: left
       * unbound it keeps the TOOL's editor, which offers Delete on an
       * annotation that is not the reviewer's to delete. */
      if (ok) bindReviewClick(target.ann.id, index);
      /* clearDrawn() took the rest of the page with it. */
      placeOthers();
    } else {
      // Different page: the content script there will pick up the new index.
      chrome.runtime.sendMessage({ type: 'AT_OPEN_LIVE', url: target.pageUrl });
    }
  }

  /* --- replying ----------------------------------------------------------- */

  /* Writes into the REVIEW state, which the review page merges back. Kept in
   * `at_review` rather than somewhere of its own so there is exactly one place
   * a reply can live, whichever side of the walkthrough typed it. */
  async function postReply(ann, text) {
    const clean = String(text || '').trim();
    if (!clean) return false;

    const got = await chrome.storage.local.get(REVIEW_KEY);
    const state = got[REVIEW_KEY] || { statuses: {} };
    state.statuses = state.statuses || {};

    /* Seeded from whichever thread is authoritative, NOT from an empty array.
     *
     * `at_review` only holds entries for items the reviewer has already
     * touched, so an annotation whose discussion arrived IN THE BUNDLE has no
     * entry here. Starting fresh would silently drop the other side of the
     * conversation - the reply would look like the first thing anyone had
     * said. Fall back to the annotation's own thread when there is no saved
     * state for it yet. */
    const existing = state.statuses[ann.id];
    const base = existing && Array.isArray(existing.replies)
      ? existing.replies
      : ((ann.review && ann.review.replies) || []);

    const entry = {
      status: (existing && existing.status) ||
              (ann.review && ann.review.status) || 'open',
      replies: base.slice(),
      reviewedAt: (existing && existing.reviewedAt) || null
    };
    entry.replies.push({
      author: identityName || 'Unknown',
      at: new Date().toISOString(),
      text: clean
    });
    state.statuses[ann.id] = entry;
    state.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ [REVIEW_KEY]: state });

    // Keep the in-memory copy in step so the pane shows it immediately.
    ann.review = ann.review || { status: 'open', replies: [] };
    ann.review.replies = entry.replies;
    await saveLive();
    return true;
  }

  /* --- the HUD ------------------------------------------------------------ */

  function renderMinePane(pane, ann) {
    pane.appendChild(el('h3', null, 'Your annotation'));
    pane.appendChild(el('p', 'by',
      (ann.type || 'annotation') + ' · not yet in the bundle'));

    /* The same rule the review and export pages use: edit what the user
     * wrote. On a highlight that is the comment, because its text is quoted
     * FROM the page. */
    const field = ann.type === 'highlight' ? 'comment' : 'text';
    if (field === 'comment' && ann.text) {
      const said = el('div', 'said');
      said.appendChild(el('span', 'lbl', 'Highlighted'));
      said.appendChild(document.createTextNode(ann.text));
      pane.appendChild(said);
    }

    const ta = document.createElement('textarea');
    ta.value = ann[field] || '';
    ta.rows = 3;
    ta.placeholder = field === 'comment' ? 'Your comment' : 'What you noticed';
    pane.appendChild(ta);

    const row = el('div', 'actions');
    const save = el('button', 'btn primary', 'Save');
    save.type = 'button';
    save.addEventListener('click', async () => {
      save.disabled = true;
      ann[field] = ta.value.trim();
      await AT.session.updateAnnotation(ann.id, { [field]: ann[field] });
      /* The storage change reloads the list and re-renders; this just closes
       * the pane so the save reads as finished. */
      expanded = false;
    });
    row.appendChild(save);
    pane.appendChild(row);
    return pane;
  }

  function renderPane(ann) {
    const pane = el('div', 'pane');
    pane.hidden = !expanded;
    if (!expanded) return pane;

    /* Your own addition. There is no discussion to have with yourself, and the
     * useful thing to do with it here is fix what you wrote - so the pane
     * edits rather than replies. */
    if (mineIds.has(ann.id)) return renderMinePane(pane, ann);

    pane.appendChild(el('h3', null, ann.text || '(no text captured)'));
    pane.appendChild(el('p', 'by',
      (ann.type || 'annotation') + (ann.author ? ' · by ' + ann.author : '')));

    if (ann.comment) {
      const said = el('div', 'said');
      said.appendChild(el('span', 'lbl', 'Comment'));
      said.appendChild(document.createTextNode(ann.comment));
      pane.appendChild(said);
    }

    const replies = (ann.review && ann.review.replies) || [];
    pane.appendChild(el('span', 'lbl', 'Discussion'));
    if (!replies.length) {
      pane.appendChild(el('p', 'none', 'No replies yet.'));
    } else {
      replies.forEach((r) => {
        const entry = el('div', 'entry');
        const head = el('div');
        head.appendChild(el('span', 'who', r.author || 'Unknown'));
        if (r.at) head.appendChild(el('span', 'when', when(r.at)));
        entry.appendChild(head);
        entry.appendChild(el('div', 'body', r.text));
        pane.appendChild(entry);
      });
    }

    const ta = document.createElement('textarea');
    ta.placeholder = identityName
      ? 'Reply as ' + identityName + '…'
      : 'Set your name on the review page first.';
    pane.appendChild(ta);

    const row = el('div', 'paneRow');
    const post = el('button', 'btn primary', 'Post reply');
    post.type = 'button';
    post.addEventListener('click', async () => {
      post.disabled = true;
      const ok = await postReply(ann, ta.value);
      post.disabled = false;
      if (ok) {
        ta.value = '';
        render(); // redraw the thread with the new entry
      }
    });
    row.appendChild(post);
    row.appendChild(el('span', 'spacer'));
    row.appendChild(el('span', 'note',
      'Replies go back with the bundle.'));
    pane.appendChild(row);

    return pane;
  }

  /* What the last caller that actually knew told us, so a re-render triggered
   * from somewhere else - a session starting, say - does not have to guess and
   * accidentally hide the "not found here" warning. */
  let lastPlaced;

  /* placed: whether the current annotation could be drawn on this page.
   * Passed in rather than recomputed, since only the caller knows. */
  function render(placed) {
    if (placed !== undefined) lastPlaced = placed;
    if (!shadow) return;
    const previous = shadow.querySelector('.dock');
    if (previous) previous.remove();

    const item = items[index];
    if (!item) return;
    const ann = item.ann;

    const dock = el('div', 'dock');
    dock.appendChild(renderPane(ann));

    const hud = el('div', 'hud');
    hud.appendChild(el('span', 'tag', 'Reviewing'));
    hud.appendChild(el('span', 'count', (index + 1) + ' of ' + items.length));

    const prev = el('button', 'btn step', '←');
    prev.type = 'button';
    prev.title = 'Previous annotation';
    prev.disabled = index === 0;
    prev.addEventListener('click', () => goTo(index - 1));
    hud.appendChild(prev);

    const next = el('button', 'btn step', '→');
    next.type = 'button';
    next.title = 'Next annotation';
    next.disabled = index >= items.length - 1;
    next.addEventListener('click', () => goTo(index + 1));
    hud.appendChild(next);

    const label = ann.text || ann.comment || (ann.type || 'annotation');
    const text = el('span', 'text', label);
    text.title = label;
    hud.appendChild(text);

    if (placed === false) {
      const warn = el('span', 'warn', 'not found here');
      warn.title =
        'The anchor could not be resolved on this page - it may have changed, ' +
        'or this may be a different environment. The bundle still has the ' +
        'original screenshot.';
      hud.appendChild(warn);
    }

    const replies = (ann.review && ann.review.replies) || [];
    const mine = mineIds.has(ann.id);

    if (mine) {
      /* Which side of the bundle you are looking at, said plainly. Yours is
       * not in the bundle yet - it goes in when the reply is exported - and
       * until then it is the one thing here you can change or remove. */
      const tag = el('span', 'warn', 'yours · not yet in the bundle');
      tag.title =
        'You added this during the review. It is part of your reply once you ' +
        'export, and until then you can edit or delete it.';
      hud.appendChild(tag);

      const edit = el('button', 'btn', expanded ? 'Hide' : 'Edit');
      edit.type = 'button';
      edit.title = 'Change what you wrote';
      edit.addEventListener('click', () => {
        expanded = !expanded;
        render(placed);
      });
      hud.appendChild(edit);

      const del = el('button', 'btn', 'Delete');
      del.type = 'button';
      del.title = 'Remove this annotation of yours';
      del.addEventListener('click', async () => {
        if (del.dataset.armed !== '1') {
          del.dataset.armed = '1';
          del.textContent = 'Really delete?';
          setTimeout(() => {
            if (!del.isConnected) return;
            delete del.dataset.armed;
            del.textContent = 'Delete';
          }, 4000);
          return;
        }
        del.disabled = true;
        await AT.session.removeAnnotation(ann.id);
      });
      hud.appendChild(del);
    } else {
      const details = el('button', 'btn',
        (expanded ? 'Hide' : 'Details') + (replies.length ? ' (' + replies.length + ')' : ''));
      details.type = 'button';
      details.title = 'See the discussion and add a reply';
      details.addEventListener('click', () => {
        expanded = !expanded;
        render(placed);
      });
      hud.appendChild(details);
    }

    /* Add findings of your own while you are here.
     *
     * Reviewing a bundle and noticing something nobody has raised yet are the
     * same sitting, and until now the second one had nowhere to go: the
     * session that records annotations is exactly what a loaded bundle
     * blocks. Starting it FROM here attaches it to this bundle instead, so
     * the tools, the screenshots and the restore-after-reload all work as
     * they normally do, and what you mark comes back inside the reply. */
    if (stray) {
      /* A session running that has nothing to do with this bundle. Its
       * annotations are invisible to the review page and the toolbar offers to
       * export them as a bundle of their own - which is almost never what
       * somebody mid-review wanted. Say so, and offer to point it at the right
       * place rather than make them throw the work away. */
      const warn = el('span', 'warn', 'separate session running');
      warn.title =
        'A session is running that is not part of this bundle. What it ' +
        'records will export on its own rather than going back with your ' +
        'replies.';
      hud.appendChild(warn);

      const attach = el('button', 'btn', 'Attach to this bundle');
      attach.type = 'button';
      attach.title =
        'Make that session part of this review, so what it recorded goes back ' +
        'with your replies.';
      attach.addEventListener('click', async () => {
        attach.disabled = true;
        await AT.session.attachToReview((live && live.bundleName) || null);
      });
      hud.appendChild(attach);
    } else if (!annotating) {
      const add = el('button', 'btn', 'Add annotations');
      add.type = 'button';
      add.title = identityName
        ? 'Mark up this page yourself. Your findings go back with your replies.'
        : 'Set your name on the review page first.';
      add.disabled = !identityName;
      add.addEventListener('click', async () => {
        add.disabled = true;
        const started = await AT.session.start(identityName, {
          reviewOf: (live && live.bundleName) || null
        });
        if (!started) {
          add.disabled = false;
          return;
        }
        annotating = true;
        render(placed);
        /* The rest of this page's findings appear now: you cannot sensibly
         * mark something up without seeing what has already been raised. */
        placeOthers();
      });
      hud.appendChild(add);
    } else {
      const mine = el('span', 'warn', 'adding annotations — use the toolbar');
      mine.title =
        'The annotation toolbar is live on this page. What you mark is ' +
        'attached to this bundle and comes back with your replies.';
      hud.appendChild(mine);
    }

    const back = el('button', 'btn primary', 'Back to list');
    back.type = 'button';
    back.addEventListener('click', async () => {
      await clearLive();
      teardown();
      chrome.runtime.sendMessage({ type: 'AT_OPEN_REVIEW' });
    });
    hud.appendChild(back);

    const dismiss = el('button', 'btn', 'Dismiss');
    dismiss.type = 'button';
    dismiss.addEventListener('click', async () => {
      await clearLive();
      teardown();
    });
    hud.appendChild(dismiss);

    dock.appendChild(hud);
    shadow.appendChild(dock);
  }

  async function clearLive() {
    await chrome.storage.local.remove(LIVE_KEY);
  }

  function teardown() {
    const ov = overlayContext();
    if (ov && ov.setAside) ov.setAside(false);
    clearDrawn();
    if (host) {
      host.remove();
      host = null;
      shadow = null;
    }
  }

  /* --- boot --------------------------------------------------------------- */

  async function boot() {
    if (location.protocol === 'chrome-extension:') return;

    const got = await chrome.storage.local.get(LIVE_KEY);
    live = got[LIVE_KEY];
    if (!live) return;

    /* Older records carried a single annotation rather than the list. Accepted
     * so a walkthrough started before this version does not simply do nothing;
     * stepping is just limited to the one item it knows about. */
    items = Array.isArray(live.items) && live.items.length
      ? live.items
      : (live.annotation ? [{ ann: live.annotation, pageUrl: live.pageUrl }] : []);
    if (!items.length) return;
    bundleCount = items.length;

    index = Math.min(Math.max(0, live.index | 0), items.length - 1);

    try {
      const id = await AT.store.getIdentity();
      identityName = id ? id.name : '';
    } catch (_) {
      identityName = '';
    }

    /* Is a review-scoped session already running? The reviewer may have
     * started one, navigated, and come back - the HUD has to come up showing
     * that rather than offering to start a second. */
    try {
      const open = await AT.store.getSession();
      annotating = !!(open && open.active && open.reviewOf);
      stray = !!(open && open.active && !open.reviewOf);
    } catch (_) {
      annotating = false;
      stray = false;
    }
    await loadMine();

    /* The session can also be ended from the popup or the review page while
     * this HUD is on screen, in which case the bar has to go back to offering
     * to start one. */
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[AT.store.SESSION_KEY]) return;
      const next = changes[AT.store.SESSION_KEY].newValue;
      const now = !!(next && next.active && next.reviewOf);
      stray = !!(next && next.active && !next.reviewOf);
      /* The list is reloaded whatever changed, not only when the mode flips:
       * marking something, editing it or deleting it all land here, and the
       * bar is showing that list. */
      loadMine().then(() => {
        const flipped = now !== annotating;
        annotating = now;
        if (!host) return;
        render(lastPlaced);
        if (!flipped) return;
        if (now) placeOthers();
        else clearOthers();
      });
    });

    syncToPage();

    /* A single-page app can navigate off this item's page - or back onto it -
     * with no page load for boot() to fire on. Without this the walkthrough
     * HUD sits on a page it has nothing to say about, pointing at an
     * annotation that belongs somewhere else. */
    if (AT.nav) {
      AT.nav.onChange(syncToPage);
      AT.nav.start();
    }
  }

  /* Mounts or tears down for whatever page we are on NOW. Split out of boot()
   * so it can run again after an in-page navigation: a walkthrough item
   * belongs to exactly one page, and whether we are on it can change without
   * anything reloading. */
  function syncToPage() {
    if (!items.length) return;
    const item = items[index];

    // Only act on the page this item belongs to. Without it every tab opened
    // afterwards would try to render the same annotation.
    if (!samePage(item.pageUrl, location.href)) {
      teardown();
      return;
    }

    if (host) return; // already up for this page

    // The overlay boots on document_idle too; give it a moment to exist.
    setTimeout(() => {
      /* Re-checked: 250ms is long enough for a fast app to have moved on
       * again, and mounting onto the wrong page is the bug being fixed. */
      const now = items[index];
      if (!now || !samePage(now.pageUrl, location.href)) return;
      mount();
      const ov = overlayContext();
      if (ov && ov.setAside) ov.setAside(true);
      const ok = place(now.ann);
      if (ok) scrollTo(now.ann);
      render(ok);
      if (ok) bindReviewClick(now.ann.id, index);
      placeOthers();
    }, 250);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  /* Exposed for the test harness only. The HUD lives in a CLOSED shadow root,
   * so there is otherwise no way to assert what it is showing - and the
   * stepping and reply paths are worth asserting. Same convention as the
   * highlight tool's _wrap/_sliceRange hooks. */
  AT.reviewMode = {
    _shadow: () => shadow,
    _index: () => index,
    _items: () => items,
    _goTo: goTo,
    _expanded: () => expanded,
    /* The in-page navigation decision, reachable directly because a harness
     * cannot navigate: history.pushState throws a SecurityError on file://
     * (measured), so there is no way to change location.href for real. */
    _syncToPage: syncToPage
  };
})();
