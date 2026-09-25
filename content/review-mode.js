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
    live.index = index;
    await chrome.storage.local.set({ [LIVE_KEY]: live });
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

  function renderPane(ann) {
    const pane = el('div', 'pane');
    pane.hidden = !expanded;
    if (!expanded) return pane;

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

  /* placed: whether the current annotation could be drawn on this page.
   * Passed in rather than recomputed, since only the caller knows. */
  function render(placed) {
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
    const details = el('button', 'btn',
      (expanded ? 'Hide' : 'Details') + (replies.length ? ' (' + replies.length + ')' : ''));
    details.type = 'button';
    details.title = 'See the discussion and add a reply';
    details.addEventListener('click', () => {
      expanded = !expanded;
      render(placed);
    });
    hud.appendChild(details);

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

    index = Math.min(Math.max(0, live.index | 0), items.length - 1);
    const item = items[index];

    // Only act on the page this item belongs to. Without it every tab opened
    // afterwards would try to render the same annotation.
    if (!samePage(item.pageUrl, location.href)) return;

    try {
      const id = await AT.store.getIdentity();
      identityName = id ? id.name : '';
    } catch (_) {
      identityName = '';
    }

    // The overlay boots on document_idle too; give it a moment to exist.
    setTimeout(() => {
      mount();
      const ok = place(item.ann);
      if (ok) scrollTo(item.ann);
      render(ok);
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
    _expanded: () => expanded
  };
})();
