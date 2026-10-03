/* Annotate Tool - Copyright (C) 2026 Mark Van de Velde
 * SPDX-License-Identifier: GPL-3.0-only
 * This program comes with ABSOLUTELY NO WARRANTY. See LICENSE for terms.
 */
/* Annotate Tool - viewer/viewer.js
 *
 * Reviews a finished session and writes the ZIP.
 *
 * The session is NOT cleared automatically after export. chrome.downloads is
 * asked to show a Save As dialog, which the user can cancel - clearing on
 * "download started" would throw away the whole session on a mis-click. So
 * clearing is a separate, explicit button that only appears once a download
 * has actually begun.
 */
(function () {
  'use strict';

  const app = document.getElementById('app');

  const TYPE_LABEL = {
    highlight: 'Highlight',
    note: 'Note',
    box: 'Box',
    arrow: 'Arrow'
  };

  // A region highlight is type "highlight" with a region anchor - see the
  // matching helper in core/report.js.
  function labelFor(a) {
    if (a.type === 'highlight' && a.anchor && a.anchor.kind === 'region') {
      return 'Region highlight';
    }
    return TYPE_LABEL[a.type] || a.type;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function metric(value, label) {
    const box = el('div', 'metric');
    box.appendChild(el('b', null, String(value)));
    box.appendChild(el('span', null, label));
    return box;
  }

  async function loadShotPixels(session) {
    const map = new Map();
    for (const shot of session.shots || []) {
      const pixels = await AT.store.getShot(shot.id);
      if (pixels) map.set(shot.id, pixels);
    }
    return map;
  }

  /* Which field holds the user's OWN words.
   *
   * A highlight's `text` is quoted FROM the page, so it is a record of what
   * the page said, not something to edit: changing it would make the bundle
   * claim wording that was never there, and break the quote anchor that
   * re-finds the passage on the live page. The comment is the user's. Every
   * other tool keeps what the user typed in `text`. */
  function writableField(a) {
    return a.type === 'highlight' ? 'comment' : 'text';
  }

  /* Destructive actions ask once, in place. The same two-step the popup uses
   * for Discard session: no dialog to misfire, and the question stays attached
   * to the thing it is about. It disarms itself, so a half-pressed button is
   * never left sitting armed for a later stray click. */
  function dangerButton(label, armedLabel, onConfirm) {
    const b = el('button', 'mini', label);
    let armed = false;
    let timer = null;
    b.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        b.textContent = armedLabel;
        b.classList.add('armed');
        timer = setTimeout(() => {
          armed = false;
          b.textContent = label;
          b.classList.remove('armed');
        }, 4000);
        return;
      }
      clearTimeout(timer);
      b.disabled = true;
      await onConfirm();
    });
    return b;
  }

  /* Reads the session back, changes it, writes it whole. Reading back rather
   * than editing the copy this render was built from matters: the session is
   * also being written by the content script on every page still open, so a
   * stale copy would quietly undo whatever was annotated in between. */
  async function mutate(fn, rerender) {
    const session = await AT.store.getSession();
    if (!session) return;
    fn(session);
    await AT.store.setSession(session);
    if (rerender === false) return;
    /* Only after a removal: the pixels for a screenshot nothing references any
     * more would otherwise sit in storage until the session was discarded. */
    await AT.store.sweepOrphanShots((session.shots || []).map((s) => s.id));
    await render();
  }

  async function deletePage(url) {
    await mutate((session) => {
      session.pages = (session.pages || []).filter((p) => p.url !== url);
      /* Its screenshots go with it - keeping them would export pictures of a
       * page the bundle no longer mentions. */
      session.shots = (session.shots || []).filter((s) => s.pageUrl !== url);
    });
  }

  async function deleteAnnotation(url, id) {
    await mutate((session) => {
      const page = (session.pages || []).find((p) => p.url === url);
      if (!page) return;
      const victim = (page.annotations || []).find((a) => a.id === id);
      page.annotations = (page.annotations || []).filter((a) => a.id !== id);

      /* The screenshot taken for this annotation goes too - but only if
       * nothing else points at it. autoCapture REUSES a recent shot rather
       * than taking a second picture of the same view, so two annotations can
       * share one; and a screenshot taken on its own belongs to no annotation
       * and must survive regardless. */
      const shotId = victim && victim.shotId;
      if (!shotId) return;
      const stillUsed = (session.pages || []).some((p) =>
        (p.annotations || []).some((a) => a.shotId === shotId));
      if (!stillUsed) {
        session.shots = (session.shots || []).filter((s) => s.id !== shotId);
      }
    });
  }

  /* Saved on blur rather than per keystroke, and without a re-render: the same
   * reasoning as the screenshot captions, plus re-rendering mid-edit would
   * tear the field out from under the person typing in it. */
  async function saveField(url, id, field, value) {
    await mutate((session) => {
      const page = (session.pages || []).find((p) => p.url === url);
      const ann = page && (page.annotations || []).find((a) => a.id === id);
      if (ann) ann[field] = value;
    }, false);
  }

  function renderPage(page, shots, pixels) {
    const card = el('div', 'card');

    const head = el('div', 'pagehead');
    const heading = el('div');
    heading.appendChild(el('h2', null, page.title || page.url));
    heading.appendChild(el('p', 'url', page.url));
    head.appendChild(heading);
    head.appendChild(dangerButton('Delete page', 'Delete this page?',
      () => deletePage(page.url)));
    card.appendChild(head);

    const anns = page.annotations || [];
    if (anns.length) {
      const table = el('table');
      const headRow = el('tr');
      ['Type', 'Content', 'Comment', ''].forEach((h) => headRow.appendChild(el('th', null, h)));
      table.appendChild(headRow);

      anns.forEach((a) => {
        const tr = el('tr');

        const typeCell = el('td');
        const dot = el('span', 'dot');
        dot.style.background = a.color || '#888';
        typeCell.appendChild(dot);
        typeCell.appendChild(document.createTextNode(labelFor(a)));
        if (a.unplaced) {
          typeCell.appendChild(document.createTextNode(' '));
          const flag = el('span', 'unplaced', 'unplaced');
          flag.title =
            'The exact spot could not be re-found on the live page. The ' +
            'content is intact and will be exported.';
          typeCell.appendChild(flag);
        }
        tr.appendChild(typeCell);

        const contentCell = el('td', null, a.text || '—');
        const commentCell = el('td', null, a.comment || '—');
        tr.appendChild(contentCell);
        tr.appendChild(commentCell);

        const field = writableField(a);
        const target = field === 'comment' ? commentCell : contentCell;

        const acts = el('td', 'rowacts');
        const edit = el('button', 'mini', 'Edit');
        edit.title = field === 'comment'
          ? 'Edit your comment. The quoted text above is what the page said, ' +
            'and stays as it was.'
          : 'Edit what you wrote here.';
        edit.addEventListener('click', () => {
          if (target.querySelector('textarea')) return;
          const ta = document.createElement('textarea');
          ta.value = a[field] || '';
          ta.rows = 2;
          let settled = false;
          const show = (value) => {
            settled = true;
            target.replaceChildren(document.createTextNode(value || '—'));
          };
          ta.addEventListener('blur', async () => {
            if (settled) return;
            const value = ta.value.trim();
            a[field] = value;
            show(value);
            await saveField(page.url, a.id, field, value);
          });
          /* Escape abandons the edit. `settled` stops the blur that removing
           * the textarea causes from then saving it anyway. Enter is left
           * alone, because a comment is allowed more than one line. */
          ta.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') show(a[field]);
          });
          target.replaceChildren(ta);
          ta.focus();
        });
        acts.appendChild(edit);
        acts.appendChild(dangerButton('Delete', 'Really delete?',
          () => deleteAnnotation(page.url, a.id)));
        tr.appendChild(acts);

        table.appendChild(tr);
      });
      card.appendChild(table);
    }

    const pageShots = shots.filter((s) => s.pageUrl === page.url);
    if (pageShots.length) {
      const grid = el('div', 'shots');
      pageShots.forEach((shot) => {
        const box = el('div', 'shot');
        const img = document.createElement('img');
        const src = getPixels(pixels, shot.id);
        if (src) img.src = src;
        img.alt = shot.note || 'Screenshot';
        box.appendChild(img);

        const input = document.createElement('input');
        input.value = shot.note || '';
        input.placeholder = 'Caption this screenshot…';
        // Captions are saved on blur rather than per keystroke: each write
        // re-serialises the session object, and doing that on every character
        // would be wasteful for no benefit.
        input.addEventListener('blur', async () => {
          const session = await AT.store.getSession();
          if (!session) return;
          const target = (session.shots || []).find((s) => s.id === shot.id);
          if (target) {
            target.note = input.value;
            await AT.store.setSession(session);
          }
        });
        box.appendChild(input);
        grid.appendChild(box);
      });
      card.appendChild(grid);
    }

    if (!anns.length && !pageShots.length) {
      card.appendChild(el('p', 'empty', 'No annotations recorded on this page.'));
    }
    return card;
  }

  function getPixels(map, id) {
    return map instanceof Map ? map.get(id) : map[id];
  }

  async function exportZip(session, pixels, statusEl, clearBtn) {
    statusEl.textContent = 'Building archive…';
    let built;
    try {
      built = AT.report.build(session, pixels);
    } catch (e) {
      statusEl.textContent = 'Could not build the report: ' + e.message;
      return;
    }

    let blob;
    try {
      blob = AT.zip.create(built.files);
    } catch (e) {
      statusEl.textContent = 'Could not build the ZIP: ' + e.message;
      return;
    }

    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({
        url: url,
        filename: built.folder + '.zip',
        saveAs: true
      });
      statusEl.textContent =
        'Export started — ' + built.files.length + ' files, ' +
        Math.round(blob.size / 1024) + ' KB. Check your downloads.';
      clearBtn.hidden = false;
    } catch (e) {
      // A cancelled Save As dialog lands here too, which is why nothing is
      // deleted on this path.
      statusEl.textContent = 'Export did not complete: ' + (e.message || e);
    } finally {
      // Give the download a moment to read the blob before revoking it.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }

  /* Writes the bundle into the working folder instead of downloading it.
   *
   * Permission is re-requested from inside the click when needed - this is the
   * only place in the export path with a user gesture to spend, and after a
   * browser restart Chrome routinely wants the grant confirmed again. */
  async function saveToFolder(session, pixels, statusEl) {
    statusEl.textContent = 'Building archive…';
    let built;
    let blob;
    try {
      built = AT.report.build(session, pixels);
      blob = AT.zip.create(built.files);
    } catch (e) {
      statusEl.textContent = 'Could not build the bundle: ' + e.message;
      return;
    }

    try {
      let handle = await AT.folder.ready();
      if (!handle) {
        const granted = await AT.folder.grant();
        if (granted !== 'granted') {
          statusEl.textContent =
            'That folder is not available. Check Settings, or use Export ZIP.';
          return;
        }
      }
      const name = await AT.folder.write(built.folder + '.zip', blob);
      const where = await AT.folder.status();
      statusEl.textContent =
        'Saved ' + name + ' to "' + (where.name || 'the folder') + '" — ' +
        Math.round(blob.size / 1024) + ' KB.';
      // Same as a download: clearing stays an explicit, separate decision.
      const clear = document.getElementById('at-clear-btn');
      if (clear) clear.hidden = false;
    } catch (e) {
      statusEl.textContent = 'Could not save: ' + AT.folder.describeError(e).text;
    }
  }

  async function render() {
    app.replaceChildren();

    const session = await AT.store.getSession();
    if (!session) {
      app.appendChild(el('h1', null, 'No session'));
      app.appendChild(
        el('p', 'sub', 'Nothing to export. Start a session from the toolbar button.')
      );
      return;
    }

    const pixels = await loadShotPixels(session);
    const pages = session.pages || [];
    const shots = session.shots || [];
    const annCount = pages.reduce((n, p) => n + (p.annotations || []).length, 0);
    const unplaced = pages.reduce(
      (n, p) => n + (p.annotations || []).filter((a) => a.unplaced).length, 0);
    const missingPixels = shots.filter((s) => !pixels.has(s.id)).length;

    app.appendChild(el('h1', null, 'Annotation session'));
    app.appendChild(
      el('p', 'sub',
        'Started ' + new Date(session.startedAt).toLocaleString() +
        (session.endedAt ? ' · ended ' + new Date(session.endedAt).toLocaleTimeString()
                         : ' · still running'))
    );

    const summary = el('div', 'card');
    const row = el('div', 'row');
    row.appendChild(metric(pages.length, 'pages'));
    row.appendChild(metric(annCount, 'annotations'));
    row.appendChild(metric(shots.length, 'screenshots'));
    if (unplaced) row.appendChild(metric(unplaced, 'unplaced'));
    summary.appendChild(row);
    app.appendChild(summary);

    if (unplaced) {
      app.appendChild(
        el('div', 'banner',
          unplaced + ' annotation' + (unplaced > 1 ? 's' : '') +
          ' could not be re-placed on the live page after a reload. The ' +
          'content is intact and will be exported — only the position is ' +
          'uncertain.')
      );
    }
    if (missingPixels) {
      app.appendChild(
        el('div', 'banner',
          missingPixels + ' screenshot' + (missingPixels > 1 ? 's have' : ' has') +
          ' lost image data and will be skipped in the export.')
      );
    }

    pages.forEach((page) => app.appendChild(renderPage(page, shots, pixels)));

    const actions = el('div', 'actions');
    const exportBtn = el('button', 'go', 'Export ZIP');

    /* Saving to the working folder, when one is set up. Offered ALONGSIDE the
     * download rather than replacing it: the download always works, and this
     * is the shortcut for people who have chosen a folder. */
    const saveBtn = el('button', null, 'Save to folder');
    saveBtn.hidden = true;
    AT.folder.status().then((st) => {
      if (st.permission === 'granted') {
        saveBtn.hidden = false;
        saveBtn.title = 'Save into "' + st.name + '"';
      } else if (st.permission === 'prompt' || st.permission === 'denied') {
        // The folder is set but not currently usable. Showing the button and
        // letting the click re-ask is better than hiding it and looking broken.
        saveBtn.hidden = false;
        saveBtn.textContent = 'Save to folder…';
        saveBtn.title = 'Chrome will ask to confirm access to "' + st.name + '"';
      }
    }).catch(() => {});

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        const fresh = await AT.store.getSession();
        await saveToFolder(fresh || session, pixels, status);
      } finally {
        saveBtn.disabled = false;
      }
    });
    const clearBtn = el('button', null, 'Clear session');
    clearBtn.id = 'at-clear-btn';
    clearBtn.hidden = true;
    const status = el('p', 'note', '');

    exportBtn.addEventListener('click', async () => {
      exportBtn.disabled = true;
      // Re-read: captions may have been edited since the initial load.
      const fresh = await AT.store.getSession();
      await exportZip(fresh || session, pixels, status, clearBtn);
      exportBtn.disabled = false;
    });

    clearBtn.addEventListener('click', async () => {
      if (clearBtn.dataset.armed !== '1') {
        clearBtn.dataset.armed = '1';
        clearBtn.textContent = 'Really clear? Click again';
        return;
      }
      await AT.store.removeShots(shots.map((s) => s.id));
      await AT.store.clearSession();
      await AT.store.sweepOrphanShots([]);
      render();
    });

    actions.appendChild(exportBtn);
    actions.appendChild(document.createTextNode(' '));
    actions.appendChild(saveBtn);
    actions.appendChild(document.createTextNode(' '));
    actions.appendChild(clearBtn);
    actions.appendChild(status);
    app.appendChild(actions);
  }

  render();
})();
