/* Annotate Tool - Copyright (C) 2026 Mark Van de Velde
 * SPDX-License-Identifier: GPL-3.0-only
 * This program comes with ABSOLUTELY NO WARRANTY. See LICENSE for terms.
 */
/* Annotate Tool - review/review.js
 *
 * Opens an exported bundle and walks through it one annotation at a time.
 *
 * UNTRUSTED INPUT. This file renders a ZIP that somebody else made. Every
 * string from the bundle goes in through textContent, never innerHTML; no URL
 * from the bundle is ever navigated automatically; and nothing inside it is
 * treated as an instruction. That is the whole security posture of this page,
 * and it is why there is not a single innerHTML assignment below.
 *
 * STATE lives in chrome.storage.local under `at_review`, so closing the tab
 * mid-walkthrough does not lose your progress, and so the live walkthrough in
 * content/review-mode.js can read the same cursor.
 */
(function () {
  'use strict';

  const REVIEW_KEY = 'at_review';
  const app = document.getElementById('app');
  const fileInput = document.getElementById('file');

  /* bundle = { name, report (normalised), items[], shots: Map<file, dataUrl> } */
  let bundle = null;
  let cursor = 0;

  /* Who is replying. Shared with the annotate side, so a person who annotates
   * and then reviews is the same name in both. */
  let identityName = '';
  let nameBox = null;

  /* Half-typed replies, kept per annotation so stepping away and back does not
   * lose them. Deliberately separate from review.replies - a draft is not part
   * of the conversation until it is posted. */
  const drafts = Object.create(null);

  // Whether the AI data panel is open. Off by default - it is a large block of
  // text and most passes do not need it.
  let showAi = false;

  /* The live ResizeObserver on the current screenshot, disconnected whenever
   * the detail pane is rebuilt so observers do not accumulate. */
  let shotResize = null;

  /* Whether the screenshot is shown at 100% rather than fitted. Kept across
   * items deliberately: someone comparing the same detail on several findings
   * should not have to re-open the full-size view on every step. */
  let actualSize = false;

  function draftFor(id) {
    return drafts[id] || '';
  }

  /* Short, local, and unambiguous. The full ISO timestamp stays in the title
   * attribute and in the exported bundle. */
  function formatWhen(iso) {
    try {
      const d = new Date(iso);
      if (isNaN(d)) return iso;
      return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (_) {
      return iso;
    }
  }

  /* --- tiny DOM helpers ------------------------------------------------- */

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text; // never innerHTML - see header
    return node;
  }

  function button(label, cls, onClick) {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  /* --- persistence ------------------------------------------------------ */

  async function saveState() {
    if (!bundle) return;
    // Only the review state is persisted, not the screenshots: a bundle can be
    // tens of megabytes of PNG, and storing that just to remember a cursor
    // position would be a poor trade. Re-opening the file restores the rest.
    const statuses = {};
    bundle.items.forEach((it) => {
      const r = it.ann.review;
      if (r.status !== 'open' || r.replies.length) {
        statuses[it.ann.id] = {
          status: r.status,
          replies: r.replies,
          reviewedAt: r.reviewedAt
        };
      }
    });
    await chrome.storage.local.set({
      [REVIEW_KEY]: {
        drafts: drafts,
        /* A trimmed copy of the findings, so the assistant bridge can serve
         * review data from an ordinary tab. This page is a chrome-extension://
         * page and can never be read by another extension - publishing the
         * content here is how it gets out at all. No screenshots: a bundle is
         * tens of megabytes of PNG and none of that belongs in storage twice. */
        items: bundle.items.map((it) => ({
          id: it.ann.id,
          type: it.ann.type,
          author: it.ann.author || null,
          text: it.ann.text || '',
          comment: it.ann.comment || '',
          pageUrl: it.page.url,
          pageTitle: it.page.title,
          status: it.ann.review.status,
          replies: it.ann.review.replies
        })),
        bundleName: bundle.name,
        sessionId: bundle.report.session && bundle.report.session.id,
        cursor: cursor,
        statuses: statuses,
        updatedAt: new Date().toISOString()
      }
    });
  }

  async function loadState() {
    const got = await chrome.storage.local.get(REVIEW_KEY);
    return got[REVIEW_KEY] || null;
  }

  /* --- loading a bundle -------------------------------------------------- */

  /* Where this bundle is on disk, or null.
   *
   * Composed from the working folder's detected path and the filename, which
   * is the only honest way to get one: the File System Access API hands over a
   * folder handle carrying a `name` and nothing else, and a file dialog does
   * not tell the page the location of what was picked. So a path exists only
   * when the reader has run Detect in Settings AND opened the bundle from that
   * folder - and `verified` says which kind of path it is, because a typed one
   * is only as true as the typing. */
  async function bundlePath(fileName) {
    try {
      if (!AT.live || !AT.live.pathRecord) return null;
      const record = await AT.live.pathRecord();
      if (!record.path) return null;
      return {
        path: AT.live.joinPath(record.path, fileName),
        verified: !!record.verified
      };
    } catch (_) {
      return null;
    }
  }

  async function openFile(file, fromFolder) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entries = await AT.unzip.read(bytes);

    // Path-suffix match rather than an exact key: the bundle sits inside a
    // folder whose name we do not know in advance, and a re-zip may add
    // another level on top.
    const reportKey = Array.from(entries.keys()).find((k) => k.endsWith('report.json'));
    if (!reportKey) {
      throw new Error('no report.json inside - is this an Annotate Tool bundle?');
    }
    const reportEntry = entries.get(reportKey);
    if (!AT.unzip.verify(reportEntry)) {
      throw new Error('report.json failed its checksum - the bundle looks damaged');
    }

    let parsed;
    try {
      parsed = JSON.parse(AT.unzip.text(reportEntry));
    } catch (e) {
      throw new Error('report.json is not valid JSON (' + e.message + ')');
    }

    const report = AT.report.normalise(parsed); // throws with a clear message
    const prefix = reportKey.slice(0, reportKey.length - 'report.json'.length);

    // Screenshots are resolved up front so the detail pane never waits on IO
    // while stepping. Data URLs rather than blob URLs - nothing to revoke.
    const shots = new Map();
    entries.forEach((entry, key) => {
      if (!/\.png$/i.test(key)) return;
      const rel = key.startsWith(prefix) ? key.slice(prefix.length) : key;
      shots.set(rel, AT.unzip.dataUrl(entry, 'image/png'));
    });

    bundle = {
      name: file.name,
      report: report,
      items: AT.report.walkthrough(report),
      shots: shots,
      /* An absolute path to this ZIP, when one can honestly be produced.
       *
       * Only for a bundle opened FROM the working folder: a file dialog does
       * not tell the page where the file was, so anything else would be a
       * guess. Even then it depends on the folder path having been detected -
       * Chrome gives the extension the folder's NAME and nothing more, so
       * without that step there is no path to offer. */
      path: fromFolder ? await bundlePath(file.name) : null
    };
    cursor = 0;

    // Restore progress if this is the same bundle we were part-way through.
    const state = await loadState();
    if (state && state.bundleName === bundle.name && state.statuses) {
      bundle.items.forEach((it) => {
        const saved = state.statuses[it.ann.id];
        if (!saved) return;
        it.ann.review.status = saved.status || it.ann.review.status;
        it.ann.review.reviewedAt = saved.reviewedAt || it.ann.review.reviewedAt;
        // Restored replies must not be appended to whatever came in the
        // bundle, or reopening would duplicate the whole thread.
        if (Array.isArray(saved.replies)) it.ann.review.replies = saved.replies;
      });
      if (state.drafts) Object.assign(drafts, state.drafts);
      if (typeof state.cursor === 'number' && state.cursor < bundle.items.length) {
        cursor = state.cursor;
      }
    }
    render();
  }

  /* --- empty state / drop target ---------------------------------------- */

  function renderEmpty(errorText) {
    app.replaceChildren();
    const wrap = el('div', 'empty-state');
    const drop = el('div', 'drop');

    drop.appendChild(el('h1', null, 'Open a review bundle'));
    drop.appendChild(el('p', null,
      'Drop an exported .zip here, or choose one. Everything stays on this machine.'));
    drop.appendChild(button('Choose a ZIP…', 'go', () => fileInput.click()));

    if (errorText) drop.appendChild(el('p', 'err', errorText));

    /* Bundles already sitting in the working folder, if one is set up. Filled
     * in asynchronously so the drop zone never waits on disk - the file picker
     * above is always available regardless. */
    const recent = el('div', 'recent');
    drop.appendChild(recent);
    fillRecent(recent);

    // Drag-and-drop anywhere on the card.
    ['dragenter', 'dragover'].forEach((type) => {
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.add('over');
      });
    });
    ['dragleave', 'drop'].forEach((type) => {
      drop.addEventListener(type, () => drop.classList.remove('over'));
    });
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) await tryOpen(file);
    });

    wrap.appendChild(drop);
    app.appendChild(wrap);
  }

  /* --- bundles in the working folder -------------------------------------
   *
   * The point of the folder is skipping the file dialog on the way in as well
   * as on the way out. Everything here degrades quietly: no folder, no
   * permission or an empty folder all simply render nothing, because the file
   * picker beside it always works.
   */

  function formatSize(bytes) {
    if (!bytes) return '';
    return bytes >= 1024 * 1024
      ? (bytes / 1024 / 1024).toFixed(1) + ' MB'
      : Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  async function fillRecent(container) {
    let status;
    try {
      status = await AT.folder.status();
    } catch (_) {
      return;
    }
    if (status.permission === 'unsupported' || status.permission === 'missing') return;

    container.replaceChildren();

    /* The folder is set but Chrome wants the grant confirmed - the ordinary
     * state after a restart. Offered as a button rather than a listing,
     * because requestPermission needs a gesture we do not have here. */
    if (status.permission !== 'granted') {
      const row = el('div', 'recent-note');
      row.appendChild(el('span', null,
        status.permission === 'gone'
          ? 'The folder "' + status.name + '" is no longer reachable.'
          : 'Your folder "' + status.name + '" needs permission again.'));
      if (status.permission !== 'gone') {
        row.appendChild(button('Allow', 'quiet', async () => {
          try {
            if ((await AT.folder.grant()) === 'granted') fillRecent(container);
          } catch (_) { /* declined; the picker above still works */ }
        }));
      }
      container.appendChild(row);
      return;
    }

    let files = [];
    try {
      files = await AT.folder.list();
    } catch (_) {
      return;
    }
    if (!files.length) return;

    container.appendChild(el('h3', null, 'In "' + status.name + '"'));
    const list = el('div', 'recent-list');

    // Capped: this is a shortcut to recent work, not a file browser.
    files.slice(0, 8).forEach((entry) => {
      const row = button(entry.name, 'recent-item', async () => {
        try {
          const file = await AT.folder.read(entry.name);
          await tryOpen(file, true);
        } catch (e) {
          renderEmpty('Could not open ' + entry.name + ' — ' +
            AT.folder.describeError(e).text);
        }
      });
      const meta = el('span', 'recent-meta', formatSize(entry.size));
      row.appendChild(meta);
      list.appendChild(row);
    });
    container.appendChild(list);
  }

  /* `fromFolder` is how we know whether the bundle can be POINTED AT as well
   * as described. A file dialog deliberately withholds the path - browsers do
   * not give a page the location of what you picked - so a bundle opened that
   * way can only ever be named. One opened from the working folder is
   * different: we know its filename, and the folder's absolute path is
   * already detected, so the two compose into something a local agent can
   * open. */
  async function tryOpen(file, fromFolder) {
    try {
      await openFile(file, fromFolder);
    } catch (e) {
      renderEmpty('Could not open ' + file.name + ' — ' + e.message);
    }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // let the same file be re-picked after an error
    if (file) await tryOpen(file);
  });

  // The whole window accepts a drop, not just the card - once you are deep in
  // a walkthrough the card is gone, and dropping a second bundle should still
  // work without hunting for a button.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) await tryOpen(file);
  });

  /* --- the walkthrough --------------------------------------------------- */

  function current() {
    return bundle && bundle.items[cursor];
  }

  function move(delta) {
    if (!bundle || !bundle.items.length) return;
    cursor = Math.min(bundle.items.length - 1, Math.max(0, cursor + delta));
    render();
    saveState();
  }

  function goTo(index) {
    cursor = index;
    render();
    saveState();
  }

  /* Marks the current item and advances. Auto-advance is the whole point of a
   * walkthrough - it turns N items into a rhythm rather than N decisions about
   * where to click next. */
  function mark(status) {
    const item = current();
    if (!item) return;
    item.ann.review.status = status;
    item.ann.review.reviewedAt = new Date().toISOString();
    if (cursor < bundle.items.length - 1) cursor++;
    render();
    saveState();
  }

  /* Where the annotation sits inside its screenshot.
   *
   * The shot recorded the scroll offset at capture time and the annotation
   * recorded its page rect, so subtracting gives viewport coordinates. The
   * image may have been captured at a different device pixel ratio than it is
   * displayed at, so everything is expressed as a PERCENTAGE of the image -
   * which stays correct however the browser scales it. */
  function pinFor(ann, shot) {
    if (!ann.rect || !shot || !shot.scroll || !shot.viewport) return null;

    /* An annotation made inside an iframe has its rect in THAT frame's
     * coordinate space, while the screenshot is of the whole tab. Without
     * knowing where the frame sits in the top document - which a cross-origin
     * frame cannot tell us - the two cannot be reconciled. Drawing a pin from
     * mismatched coordinates would point confidently at the wrong thing, so
     * there is no pin for these; the detail pane says why instead. */
    if (ann.frame && ann.frame.path && ann.frame.path.length) return null;
    const vw = shot.viewport.w;
    const vh = shot.viewport.h;
    if (!vw || !vh) return null;

    const x = ann.rect.x - shot.scroll.x;
    const y = ann.rect.y - shot.scroll.y;
    // An annotation scrolled out of frame cannot be pinned honestly.
    if (x + ann.rect.w < 0 || y + ann.rect.h < 0 || x > vw || y > vh) return null;

    return {
      left: (x / vw) * 100,
      top: (y / vh) * 100,
      width: (Math.max(ann.rect.w, 8) / vw) * 100,
      height: (Math.max(ann.rect.h, 8) / vh) * 100
    };
  }

  function shotForItem(item) {
    const ann = item.ann;
    const list = item.page.screenshots || [];
    if (ann.shotId) {
      const found = list.find((s) => s.id === ann.shotId);
      if (found) return found;
    }
    return null;
  }

  /* --- rendering ---------------------------------------------------------- */

  function renderRail() {
    const rail = el('div', 'rail');
    let lastPage = -1;
    bundle.items.forEach((item, i) => {
      if (item.pageIndex !== lastPage) {
        lastPage = item.pageIndex;
        rail.appendChild(el('h2', null, item.page.title || item.page.url));
      }
      const status = item.ann.review.status;
      const row = el('div', 'row' + (i === cursor ? ' on' : '') +
        (status === 'done' ? ' done' : '') + (status === 'skipped' ? ' skipped' : ''));

      row.appendChild(el('span', 'mark', status === 'done' ? '✓' : status === 'skipped' ? '–' : ''));
      const dot = el('span', 'dot');
      dot.style.background = item.ann.color || '#888';
      row.appendChild(dot);
      row.appendChild(el('span', 'label',
        item.ann.text || item.ann.comment || AT.report.labelFor(item.ann)));

      row.addEventListener('click', () => goTo(i));
      rail.appendChild(row);
    });
    return rail;
  }

  /* --- the screenshot ------------------------------------------------------
   *
   * A viewport capture on a high-DPR display is a few thousand pixels wide,
   * scaled into a ~780px column - roughly a quarter size, which is too small
   * to read the very text a reviewer is complaining about. Two ways out:
   *
   *   HOVER  a 200px round glass showing that spot at 120% of the image's
   *          natural size. Non-destructive - the layout never moves, so you
   *          can sweep across a screenshot reading as you go.
   *   CLICK  swaps to a true 100% view in a scrollable frame, and back again.
   *          For when you need to study one area rather than glance at it.
   *
   * The magnifier is suppressed in the 100% view: magnifying something already
   * at full size just adds a lens that lags the cursor for no benefit.
   */
  function renderShot(ann, shot, src) {
    const view = el('div', 'shotview');
    const box = el('div', 'shotwrap');

    const img = document.createElement('img');
    img.src = src;
    img.alt = 'Screenshot for this annotation';
    img.draggable = false; // otherwise a drag-to-magnify becomes a file drag
    box.appendChild(img);

    /* The pin is positioned in PERCENTAGES of the wrapper, so it tracks the
     * image through both view modes without any recalculation. */
    const pin = pinFor(ann, shot);
    if (pin) {
      const marker = el('div', 'pin');
      marker.style.left = pin.left + '%';
      marker.style.top = pin.top + '%';
      marker.style.width = pin.width + '%';
      marker.style.height = pin.height + '%';
      box.appendChild(marker);
    }

    const lens = el('div', 'lens');
    lens.hidden = true;
    lens.style.width = AT.lens.SIZE + 'px';
    lens.style.height = AT.lens.SIZE + 'px';
    // Quoted: a data URL carries commas and semicolons that would otherwise
    // terminate the url() token early.
    lens.style.backgroundImage = 'url("' + src + '")';
    box.appendChild(lens);

    const hint = el('p', 'shothint', '');
    function paintHint() {
      hint.textContent = actualSize
        ? 'Showing 100%. Drag to move around · click to fit it again.'
        : 'Hover to magnify · click for 100%';
    }

    /* Where the 100% view opens, as fractions of the image.
     *
     * Starts at this annotation's own pin. That is what makes stepping through
     * a review at 100% work: each item arrives centred on the thing it is
     * about, rather than inheriting the scroll position of the last one. A
     * click or a pan overrides it for this item only - the next annotation
     * builds a fresh one from its own pin. */
    let focusPoint = AT.lens.pinCentre(pin);

    /* Total border across both edges of .shotview - 1px each side. Kept as a
     * constant next to the code that needs it; a mismatch with the stylesheet
     * would show up as the page shifting by two pixels on every toggle. */
    const FRAME_BORDER = 2;

    function fittedHeight() {
      return AT.lens.fittedBoxHeight({
        boxW: view.getBoundingClientRect().width,
        nw: img.naturalWidth,
        nh: img.naturalHeight,
        border: FRAME_BORDER
      });
    }

    function applyMode() {
      view.classList.toggle('actual', actualSize);
      img.style.width = actualSize && img.naturalWidth
        ? img.naturalWidth + 'px'
        : '';

      if (!actualSize) {
        lens.hidden = true;
        view.style.height = '';
        view.scrollLeft = 0;
        view.scrollTop = 0;
        paintHint();
        return;
      }

      lens.hidden = true;
      paintHint();

      /* Everything below depends on the frame being LAID OUT, and this runs
       * on a fresh render too - before the pane has been inserted into the
       * document. Measuring then returns zero, which collapsed the frame to
       * its 2px border and scrolled against nothing. One frame's delay
       * guarantees the element is in the page and sized.
       *
       * Height first, then scroll: reading clientHeight after setting the
       * height forces the layout, so the scroll is clamped against the real
       * window rather than a stale one. */
      requestAnimationFrame(() => {
        if (!actualSize || !img.naturalWidth) return;
        view.style.height = fittedHeight() + 'px';
        const s = AT.lens.focusScroll({
          fx: focusPoint.fx, fy: focusPoint.fy,
          nw: img.naturalWidth, nh: img.naturalHeight,
          cw: view.clientWidth, ch: view.clientHeight
        });
        view.scrollLeft = s.left;
        view.scrollTop = s.top;
      });
    }

    /* --- drag to pan the 100% view ------------------------------------
     *
     * The awkward part is that the same button does two things: a click
     * closes the view, a drag moves it. They are told apart by DISTANCE, the
     * same way the note tool distinguishes a click from a nudge - below the
     * threshold it is a click, above it the click is swallowed. Without that
     * suppression every pan would also close the view on release. */
    const DRAG_THRESHOLD = 4;
    let panning = null;
    let swallowClick = false;

    function onPanMove(e) {
      if (!panning) return;
      const dx = e.clientX - panning.x;
      const dy = e.clientY - panning.y;
      if (!panning.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      panning.moved = true;
      img.style.cursor = 'grabbing';
      // Dragging right pulls the image right, so the scroll offset decreases.
      view.scrollLeft = panning.left - dx;
      view.scrollTop = panning.top - dy;
    }

    function onPanUp() {
      window.removeEventListener('mousemove', onPanMove, true);
      window.removeEventListener('mouseup', onPanUp, true);
      if (!panning) return;
      const moved = panning.moved;
      panning = null;
      img.style.cursor = '';
      if (!moved) return;

      // A pan is not a click - suppress the click that follows this mouseup.
      swallowClick = true;
      // Remember where they panned to, so re-opening the view returns here.
      if (img.naturalWidth) {
        focusPoint = AT.lens.centreOf({
          scrollLeft: view.scrollLeft, scrollTop: view.scrollTop,
          cw: view.clientWidth, ch: view.clientHeight,
          nw: img.naturalWidth, nh: img.naturalHeight
        });
      }
    }

    img.addEventListener('mousedown', (e) => {
      if (!actualSize || e.button !== 0) return;
      e.preventDefault(); // no native image drag, no text selection
      panning = {
        x: e.clientX, y: e.clientY,
        left: view.scrollLeft, top: view.scrollTop,
        moved: false
      };
      window.addEventListener('mousemove', onPanMove, true);
      window.addEventListener('mouseup', onPanUp, true);
    });

    img.addEventListener('click', (e) => {
      e.preventDefault();
      if (swallowClick) {
        swallowClick = false;
        return; // that was the end of a drag, not a click
      }
      if (!actualSize) {
        // Remember WHERE they clicked, so the full-size view opens on it.
        const r = img.getBoundingClientRect();
        if (r.width && r.height) {
          focusPoint = {
            fx: (e.clientX - r.left) / r.width,
            fy: (e.clientY - r.top) / r.height
          };
        }
      }
      actualSize = !actualSize;
      applyMode();
    });

    box.addEventListener('mousemove', (e) => {
      if (actualSize || !img.naturalWidth) return;
      const r = img.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      // Off the image entirely (the wrapper can be a hair larger): no glass.
      if (mx < 0 || my < 0 || mx > r.width || my > r.height) {
        lens.hidden = true;
        return;
      }
      const g = AT.lens.compute({
        mx: mx, my: my,
        dw: r.width, dh: r.height,
        nw: img.naturalWidth, nh: img.naturalHeight
      });
      lens.hidden = false;
      lens.style.left = g.left + 'px';
      lens.style.top = g.top + 'px';
      lens.style.backgroundSize = g.bgW + 'px ' + g.bgH + 'px';
      lens.style.backgroundPosition = g.bgX + 'px ' + g.bgY + 'px';
    });

    box.addEventListener('mouseleave', () => { lens.hidden = true; });

    // naturalWidth is only known once the image has decoded; a data URL is
    // usually complete immediately, but not guaranteed.
    if (img.complete && img.naturalWidth) applyMode();
    else img.addEventListener('load', applyMode, { once: true });

    paintHint();
    view.appendChild(box);

    const shell = el('div');
    shell.appendChild(view);
    shell.appendChild(hint);

    /* The column narrows with the window, which would leave a locked height
     * stale and the image letterboxed or clipped. Watched with a
     * ResizeObserver rather than a window listener so it can be torn down: the
     * page rebuilds this pane on every step, and window listeners would pile
     * up one per annotation viewed.
     *
     * Only WIDTH changes are acted on. Reacting to height would feed back on
     * itself, since the callback sets the height of a box inside the observed
     * element. */
    if (shotResize) shotResize.disconnect();
    if (typeof ResizeObserver === 'function') {
      let lastWidth = 0;
      shotResize = new ResizeObserver((entries) => {
        const w = entries[0].contentRect.width;
        if (Math.abs(w - lastWidth) < 0.5) return;
        lastWidth = w;
        if (actualSize && img.naturalWidth) {
          view.style.height = fittedHeight() + 'px';
        }
      });
      shotResize.observe(shell);
    }

    return shell;
  }

  function renderDetail(item) {
    const detail = el('div', 'detail');
    const wrap = el('div', 'wrap');
    const ann = item.ann;

    const kind = el('div', 'kind');
    const dot = el('span', 'dot');
    dot.style.background = ann.color || '#888';
    kind.appendChild(dot);
    kind.appendChild(el('span', 'name', AT.report.labelFor(ann)));
    if (ann.unplaced) {
      const b = el('span', 'badge warn', 'unplaced');
      b.title = 'The tool could not re-find this on the live page. The content is intact.';
      kind.appendChild(b);
    }
    if (ann.review.status !== 'open') {
      kind.appendChild(el('span', 'badge' + (ann.review.status === 'done' ? ' done' : ''),
        ann.review.status));
    }
    if (ann.frame && ann.frame.path && ann.frame.path.length) {
      // Worth surfacing on its own account: "it's inside the embedded checkout"
      // is often the most useful fact about a finding.
      const b = el('span', 'badge', 'in an embedded frame');
      b.title = 'Made inside an iframe (' + (ann.frame.url || 'unknown source') +
        '). The screenshot shows the whole tab, so this one is not pinned.';
      kind.appendChild(b);
    }
    wrap.appendChild(kind);

    wrap.appendChild(el('div', 'quote', ann.text || '(no text captured)'));

    if (ann.comment) {
      const c = el('div', 'comment');
      c.appendChild(el('span', 'lbl', 'Reviewer comment'));
      c.appendChild(document.createTextNode(ann.comment));
      wrap.appendChild(c);
    }

    /* --- screenshot with pin --- */
    const shot = shotForItem(item);
    const src = shot && bundle.shots.get(shot.file);
    if (src) {
      wrap.appendChild(renderShot(ann, shot, src));
    } else {
      wrap.appendChild(el('div', 'noshot',
        bundle.report.upgradedFrom
          ? 'No screenshot — this bundle predates automatic capture.'
          : 'No screenshot was captured for this annotation.'));
    }

    /* --- page context --- */
    const meta = el('p', 'meta');
    meta.appendChild(document.createTextNode(
      (item.indexOnPage + 1) + ' of ' + item.pageTotal + ' on this page · '));
    // Rendered as a link so it is obvious where it goes, but nothing navigates
    // on its own - a bundle must never be able to send the reviewer anywhere.
    const link = el('a', null, item.page.url);
    link.href = item.page.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    meta.appendChild(link);
    wrap.appendChild(meta);

    /* --- the conversation --------------------------------------------- */

    if (ann.review.replies.length) {
      const thread = el('div', 'thread');
      ann.review.replies.forEach((r, i) => {
        const entry = el('div', 'entry' + (r.author === identityName ? ' mine' : ''));
        const head = el('div', 'entry-head');
        head.appendChild(el('span', 'who', r.author));
        if (r.at) {
          const when = el('span', 'when', formatWhen(r.at));
          when.title = r.at;
          head.appendChild(when);
        }
        entry.appendChild(head);
        entry.appendChild(el('div', 'entry-body', r.text));

        // Only the newest reply is withdrawable, and only by its author -
        // rewriting somebody else's side of a conversation is not ours to do.
        if (i === ann.review.replies.length - 1 && r.author === identityName) {
          const undo = button('Withdraw', 'quiet tiny', () => {
            ann.review.replies.pop();
            render();
            saveState();
          });
          entry.appendChild(undo);
        }
        thread.appendChild(entry);
      });
      wrap.appendChild(thread);
    }

    /* --- add a reply --------------------------------------------------- */
    const reply = el('div', 'reply');
    const label = el('label', null,
      ann.review.replies.length ? 'Add to the conversation' : 'Your reply');
    label.setAttribute('for', 'reply-box');
    reply.appendChild(label);

    const ta = document.createElement('textarea');
    ta.id = 'reply-box';
    ta.value = draftFor(ann.id);
    ta.placeholder = identityName
      ? 'Replying as ' + identityName + ' — goes back with the bundle.'
      : 'Set your name below first.';
    // Drafts are kept per annotation so moving away and back does not lose
    // half-typed text, but they are NOT replies until posted.
    ta.addEventListener('input', () => {
      drafts[ann.id] = ta.value;
      scheduleSave();
    });
    reply.appendChild(ta);

    const row = el('div', 'reply-row');
    const post = button('Post reply', 'go', () => {
      const text = ta.value.trim();
      if (!text) return;
      if (!identityName) {
        nameBox.focus();
        return;
      }
      ann.review.replies.push({
        author: identityName,
        at: new Date().toISOString(),
        text: text
      });
      delete drafts[ann.id];
      render();
      saveState();
    });
    row.appendChild(post);
    row.appendChild(el('span', 'hint',
      'Replies stack up, so a bundle can go back and forth as many times as needed.'));
    reply.appendChild(row);
    wrap.appendChild(reply);

    detail.appendChild(wrap);
    return detail;
  }

  let saveTimer = null;
  function scheduleSave() {
    // Typing a reply must not write to storage on every keystroke.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 400);
  }

  function render() {
    if (!bundle) return renderEmpty();
    if (!bundle.items.length) {
      return renderEmpty('That bundle has no annotations in it.');
    }

    const item = current();
    const done = bundle.items.filter((i) => i.ann.review.status !== 'open').length;

    app.replaceChildren();
    const shell = el('div', 'shell');
    shell.appendChild(renderRail());

    const main = el('div', 'main');

    const top = el('div', 'topbar');
    top.appendChild(el('span', 'count', (cursor + 1) + ' of ' + bundle.items.length));
    top.appendChild(button('←', '', () => move(-1)));
    top.appendChild(button('→', '', () => move(1)));
    top.appendChild(el('span', 'spacer'));
    top.appendChild(el('span', 'bundle', bundle.name));
    top.appendChild(button(showAi ? 'Hide AI data' : 'Data for AI', '', () => {
      showAi = !showAi;
      render();
    }));
    top.appendChild(button('Open live', 'blue', openLive));
    main.appendChild(top);

    const bar = el('div', 'progress');
    const fill = el('i');
    fill.style.width = (done / bundle.items.length * 100) + '%';
    bar.appendChild(fill);
    main.appendChild(bar);

    if (bundle.report.upgradedFrom) {
      main.appendChild(el('div', 'banner',
        'This bundle uses the older v' + bundle.report.upgradedFrom +
        ' format. It opens fine, but has no screenshots linked per annotation.'));
    }

    if (showAi) main.appendChild(renderAiPanel());

    main.appendChild(renderDetail(item));

    const actions = el('div', 'actions');
    actions.appendChild(button('Done', 'go', () => mark('done')));
    actions.appendChild(button('Skip', '', () => mark('skipped')));
    if (item.ann.review.status !== 'open') {
      actions.appendChild(button('Reopen', 'quiet', () => {
        item.ann.review.status = 'open';
        render();
        saveState();
      }));
    }
    actions.appendChild(el('span', 'spacer'));

    /* Your name, right where you reply. The reviewer is often not the person
     * who annotated, so this cannot be assumed from the session. */
    const nameWrap = el('span', 'namefield');
    nameWrap.appendChild(el('label', null, 'You'));
    nameBox = document.createElement('input');
    nameBox.type = 'text';
    nameBox.maxLength = 60;
    nameBox.placeholder = 'your name';
    nameBox.value = identityName;
    nameBox.addEventListener('change', async () => {
      identityName = nameBox.value.trim();
      await AT.store.setIdentity(identityName);
    });
    nameWrap.appendChild(nameBox);
    actions.appendChild(nameWrap);

    const hint = el('span', 'hint');
    hint.appendChild(document.createTextNode(done + ' of ' + bundle.items.length + ' handled · '));
    ['←', '→', 'D', 'S'].forEach((k, i) => {
      hint.appendChild(el('kbd', null, k));
      hint.appendChild(document.createTextNode(i < 3 ? ' ' : ' to move, mark, skip'));
    });
    actions.appendChild(hint);
    actions.appendChild(button('Export replies', 'go', exportReviewed));
    actions.appendChild(button('Close bundle', 'quiet', () => {
      bundle = null;
      renderEmpty();
    }));

    main.appendChild(actions);
    shell.appendChild(main);
    app.appendChild(shell);
  }

  /* --- keyboard ---------------------------------------------------------- */

  window.addEventListener('keydown', (e) => {
    if (!bundle) return;
    // Never steal keys while the reply box has focus.
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;

    switch (e.key) {
      case 'ArrowRight': case 'j': case 'J': move(1); e.preventDefault(); break;
      case 'ArrowLeft': case 'k': case 'K': move(-1); e.preventDefault(); break;
      case 'd': case 'D': mark('done'); e.preventDefault(); break;
      case 's': case 'S': mark('skipped'); e.preventDefault(); break;
      case 'Home': goTo(0); e.preventDefault(); break;
      case 'End': goTo(bundle.items.length - 1); e.preventDefault(); break;
    }
  });

  /* --- live walkthrough --------------------------------------------------- */

  /* Hands the current item to a real tab. The cursor goes to storage and the
   * tab is navigated; content/review-mode.js picks it up there. Navigation
   * happens ONLY from this click - never automatically on load - because the
   * URL comes from a file somebody else made. */
  async function openLive() {
    const item = current();
    if (!item) return;
    const url = item.page.url;
    if (!/^https?:/i.test(url)) {
      alert('That page is not an http(s) URL, so it cannot be opened live.');
      return;
    }
    /* The whole walkthrough goes to storage, not just the current item, so the
     * live HUD can step forward and back on its own without a round trip back
     * to this page. Deliberately TRIMMED: annotations and their page context
     * only. The screenshots stay here in memory - a bundle is tens of
     * megabytes of PNG and none of it is needed on the live page. */
    await chrome.storage.local.set({
      at_review_live: {
        items: bundle.items.map((it) => ({
          ann: it.ann,
          pageUrl: it.page.url,
          pageTitle: it.page.title
        })),
        index: cursor,
        total: bundle.items.length,
        startedAt: new Date().toISOString()
      }
    });
    // Through the service worker so ONE live tab is reused and navigated.
    // Creating a tab here directly is what left twenty tabs open after
    // stepping through twenty annotations.
    await chrome.runtime.sendMessage({ type: 'AT_OPEN_LIVE', url: url });
  }

  /* --- data for an AI assistant -------------------------------------------
   *
   * Until this existed, a bundle open in the review page was invisible to any
   * assistant helping the user: the content lived inside a ZIP and then in JS
   * memory, with only the current item rendered. An AI looking at the screen
   * could see one annotation out of forty, and had no way to reach the rest.
   *
   * This panel puts the whole record on the page as selectable text - so it is
   * readable by an assistant looking at the tab, copyable in one click for
   * pasting into a chat, and current, because it is generated from live state
   * including replies typed a moment ago.
   *
   * It leads with a plain-English preamble. A bare JSON dump makes a reader
   * guess at intent; naming the schema and the caveats up front is the
   * difference between useful triage and confident nonsense.
   */

  /* Both builders live in core/report.js as pure functions of the normalised
   * report, so the text handed to an assistant is testable without a DOM.
   * See AT.report.forAssistantMarkdown. */
  function aiMarkdown() {
    return AT.report.forAssistantMarkdown(bundle.report, {
      bundleName: bundle.name,
      bundlePath: bundle.path ? bundle.path.path : null,
      pathVerified: bundle.path ? bundle.path.verified : false
    });
  }

  function aiTextForItem(item) {
    return AT.report.forAssistantItem(item);
  }

  async function copyText(text, btn) {
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch (_) {
      // Clipboard permission can be refused; fall back to selecting the panel
      // so the user can copy by hand rather than being told nothing.
      const pre = document.getElementById('ai-json');
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      btn.textContent = 'Select & copy';
    }
    setTimeout(() => { btn.textContent = original; }, 1800);
  }

  function renderAiPanel() {
    const panel = el('div', 'aipanel');

    const head = el('div', 'aipanel-head');
    head.appendChild(el('strong', null, 'Data for an AI assistant'));
    /* The wording here matters. An earlier version claimed an assistant
     * "looking at this tab" could read this panel. That is false for any
     * browser-extension assistant: Chrome isolates chrome-extension:// origins
     * from each other, so one extension can never read another's pages. Copy
     * and paste is the route that actually works. */
    head.appendChild(el('span', 'hint',
      'Copy and paste this into a chat. A browser-extension assistant cannot ' +
      'read this page directly — Chrome isolates extensions from each other — ' +
      'so the clipboard is the way across.'));
    head.appendChild(el('span', 'spacer'));

    /* ONE copy button for the whole session, not a choice of formats.
     *
     * There was a JSON option beside this. On a real bundle it was 3.9x the
     * size for the same findings, all of the difference being anchors and
     * rects - which locate an annotation on a live page and say nothing in a
     * conversation. Offering both made the reader pick between "the one that
     * works" and "the one that is four times bigger", which is not a choice
     * worth having. */
    head.appendChild(button('Copy for a chat', 'go', (e) =>
      copyText(aiMarkdown(), e.target)));
    /* Kept separate because a long session is a lot to paste when the question
     * is about one finding. */
    head.appendChild(button('Copy this item', '', (e) =>
      copyText(aiTextForItem(current()), e.target)));
    head.appendChild(button('Hide', 'quiet', () => {
      showAi = false;
      render();
    }));
    panel.appendChild(head);

    /* The panel previews the MARKDOWN form, not the JSON: it is the one most
     * people will paste, and it is readable enough to check before sending. */
    const pre = el('pre', null, aiMarkdown());
    pre.id = 'ai-json';
    panel.appendChild(pre);
    return panel;
  }

  /* --- export ------------------------------------------------------------- */

  /* Rebuilds a bundle carrying the review state. The screenshots are the ones
   * that came IN - we re-emit the originals rather than dropping them, so the
   * reply bundle is a complete record on its own rather than something that
   * only makes sense next to the original. */
  async function exportReviewed() {
    if (!bundle) return;

    // Shared with the round-trip test - see AT.report.toSession.
    const { session, pixels } = AT.report.toSession(bundle.report, bundle.shots);

    let built;
    try {
      built = AT.report.build(session, pixels);
    } catch (e) {
      alert('Could not build the reply bundle: ' + e.message);
      return;
    }

    const blob = AT.zip.create(built.files);
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({
        url: url,
        filename: built.folder + '.zip',
        saveAs: true
      });
    } catch (e) {
      alert('Export did not complete: ' + (e.message || e));
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }

  /* --- staying in step with the live walkthrough ---------------------------
   *
   * The live HUD can now move between items and post replies of its own. Two
   * things have to flow back here, or returning from a walkthrough would land
   * on the wrong item and silently discard anything typed over there.
   */

  /* Set while this page is writing, so its own saves are not mistaken for the
   * live page's and merged back on top of themselves. */
  let selfWrite = false;

  const originalSaveState = saveState;
  saveState = async function () {
    selfWrite = true;
    try {
      await originalSaveState();
    } finally {
      selfWrite = false;
    }
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !bundle) return;

    /* Replies posted from the live page. Merged rather than reloaded: this
     * page may have half-typed drafts and a scroll position worth keeping. */
    if (changes[REVIEW_KEY] && !selfWrite) {
      const next = changes[REVIEW_KEY].newValue;
      if (next && next.statuses) {
        let touched = false;
        bundle.items.forEach((it) => {
          const incoming = next.statuses[it.ann.id];
          if (!incoming) return;
          const mine = it.ann.review;
          const theirs = incoming.replies || [];
          // Only the live page adds replies, so a longer thread is newer.
          if (theirs.length > mine.replies.length) {
            mine.replies = theirs;
            touched = true;
          }
          if (incoming.status && incoming.status !== mine.status) {
            mine.status = incoming.status;
            touched = true;
          }
        });
        if (touched) render();
      }
    }

    /* Stepping in the live view moves the cursor here too, so "Back to list"
     * arrives on the item the reviewer was actually looking at. */
    if (changes.at_review_live) {
      const live = changes.at_review_live.newValue;
      if (live && typeof live.index === 'number' &&
          live.index !== cursor && live.index < bundle.items.length) {
        cursor = live.index;
        render();
      }
    }
  });

  /* Tell the service worker which tab this is, so "Back to list" from a live
   * page can focus THIS tab instead of spawning another review page. */
  (async function boot() {
    try {
      await chrome.runtime.sendMessage({ type: 'AT_REGISTER_TAB', role: 'review' });
    } catch (_) { /* not fatal - the fallback is opening a new tab */ }

    /* Guarded, and the render happens either way. Reading a remembered name is
     * a convenience; if storage is unavailable the page must still come up and
     * let you open a bundle, rather than staying blank with no explanation. */
    try {
      const identity = await AT.store.getIdentity();
      identityName = identity ? identity.name : '';
    } catch (_) {
      identityName = '';
    }

    renderEmpty();
  })();
})();
