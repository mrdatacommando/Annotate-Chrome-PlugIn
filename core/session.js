/* Annotate Tool - Copyright (C) 2026 Mark Van de Velde
 * SPDX-License-Identifier: GPL-3.0-only
 * This program comes with ABSOLUTELY NO WARRANTY. See LICENSE for terms.
 */
/* Annotate Tool - core/session.js
 *
 * The session is the unit the user actually cares about: press Start, browse
 * across as many pages as you like leaving annotations, press End and get one
 * ZIP covering the lot.
 *
 * SHAPE (as stored under `at_session`):
 *   {
 *     id, startedAt, endedAt, active,
 *     pages: [ { url, title, viewport:{w,h}, visitedAt, annotations:[...] } ],
 *     shots: [ { id, name, pageUrl, createdAt, note, viewport } ]
 *   }
 *
 * `pages` is an ARRAY, not a map keyed by URL, because the report reads far
 * better in the order the reviewer actually walked the site. Lookup by URL is
 * a linear scan over a handful of entries - not worth a second index.
 *
 * Shot pixels are NOT here; only metadata. See core/store.js for why.
 *
 * CONCURRENCY: every mutation is a read-modify-write, serialised through a
 * per-tab promise chain so two edits in the same tab cannot interleave. Two
 * DIFFERENT tabs annotating simultaneously can still clobber one another -
 * accepted deliberately, because a human reviews one tab at a time, and the
 * alternative (a lock in storage, with stale-lock recovery) costs more than
 * the bug is worth here.
 */
(function () {
  'use strict';
  const AT = (window.AT = window.AT || {});

  let queue = Promise.resolve();

  /* --- frames -----------------------------------------------------------
   *
   * The content script now runs in EVERY frame, because mouse and selection
   * events inside an iframe never reach the parent document - so without
   * injecting into the frame itself, nothing the user does in there is
   * observable at all.
   *
   * Two consequences are handled here:
   *
   * 1. A subframe cannot read window.top.location cross-origin, so it has no
   *    idea which page it is part of. Annotations must still be filed under
   *    the page the USER is looking at, not the frame's own URL, so the top
   *    URL is fetched once from the service worker (which knows the tab's URL)
   *    and cached.
   *
   * 2. Several frames read-modify-writing the same storage key would lose each
   *    other's annotations. Every MUTATION from a subframe is therefore
   *    relayed to the top frame, which owns the session record. Reads are left
   *    alone - they cannot clobber anything.
   */

  const IS_TOP = (function () {
    try {
      return window.top === window;
    } catch (_) {
      return false; // cross-origin access threw, so we are definitely framed
    }
  })();

  let topUrlCache = null;

  async function topPageUrl() {
    if (IS_TOP) return normalizeUrl(location.href);
    if (topUrlCache) return topUrlCache;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'AT_PAGE_URL' });
      if (res && res.url) {
        topUrlCache = normalizeUrl(res.url);
        return topUrlCache;
      }
    } catch (_) {
      /* fall through */
    }
    // Last resort: the frame's own URL. Wrong, but better than dropping the
    // annotation entirely - and the frame path on the anchor still identifies
    // where it came from.
    return normalizeUrl(location.href);
  }

  /* This frame's position in the tab, as a chain of indices from the top
   * (e.g. [1, 0] = second iframe, then its first child).
   *
   * window.frames.length and identity comparison of window objects are both
   * allowed cross-origin, which is what makes this work at all - the frame's
   * URL is not, and would be useless anyway for an ad frame that reloads. */
  function framePath() {
    const path = [];
    try {
      let win = window;
      while (win !== win.top) {
        const parent = win.parent;
        const siblings = parent.frames;
        let index = -1;
        for (let i = 0; i < siblings.length; i++) {
          if (siblings[i] === win) {
            index = i;
            break;
          }
        }
        if (index < 0) return path; // detached; give up rather than guess
        path.unshift(index);
        win = parent;
      }
    } catch (_) {
      /* partial path is still better than none */
    }
    return path;
  }

  const FRAME_PATH = framePath();
  const FRAME_KEY = FRAME_PATH.join('.');

  /* Relays one mutation to the top frame and returns its result. */
  async function delegate(op, args) {
    const res = await chrome.runtime.sendMessage({
      type: 'AT_SESSION_OP',
      op: op,
      args: args || []
    });
    if (!res || res.ok === false) {
      throw new Error((res && res.error) || 'session relay failed');
    }
    return res.result;
  }

  /* Serialises mutations so concurrent calls in this tab cannot interleave
   * their read-modify-write cycles. */
  function enqueue(fn) {
    const next = queue.then(fn, fn);
    // Keep the chain alive even if one mutation throws.
    queue = next.catch(() => {});
    return next;
  }

  function newId(prefix) {
    return (
      prefix +
      '_' +
      Date.now().toString(36) +
      '_' +
      Math.random().toString(36).slice(2, 7)
    );
  }

  /* Hash is stripped: `#section-2` is the same document for review purposes,
   * and keeping it would scatter one page's annotations across several
   * report entries. Query IS kept - `?id=42` is genuinely a different page. */
  function normalizeUrl(href) {
    try {
      const u = new URL(href || location.href);
      u.hash = '';
      return u.toString();
    } catch (_) {
      return href || location.href;
    }
  }

  function viewport() {
    return {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio || 1
    };
  }

  function scrollPos() {
    return { x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
  }

  /* Finds this page's record, creating it on first annotation. We do NOT
   * create a page record just for visiting - a session that recorded every URL
   * the user passed through would bury the real findings in noise. */
  function pageFor(session, url, create) {
    const key = url || normalizeUrl();
    let page = session.pages.find((p) => p.url === key);
    if (!page && create) {
      page = {
        url: key,
        title: document.title || key,
        viewport: viewport(),
        visitedAt: new Date().toISOString(),
        annotations: []
      };
      session.pages.push(page);
    }
    return page || null;
  }

  /* The top frame executes mutations on behalf of subframes. Registered only
   * in the top frame so a nested frame can never answer for the tab. */
  if (IS_TOP && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'AT_SESSION_EXEC') return;
      const fn = AT.session && AT.session[msg.op];
      // Only the mutating API is reachable this way - a relayed message must
      // not be able to call arbitrary members of the session object.
      const allowed = [
        'addAnnotation', 'updateAnnotation', 'removeAnnotation',
        'addShot', 'attachShot'
      ];
      if (typeof fn !== 'function' || allowed.indexOf(msg.op) < 0) {
        sendResponse({ ok: false, error: 'unknown session op: ' + msg.op });
        return true;
      }
      Promise.resolve(fn.apply(AT.session, msg.args || []))
        .then((result) => sendResponse({ ok: true, result: result }))
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
      return true; // async reply
    });
  }

  AT.session = {
    IS_TOP,
    FRAME_PATH,
    FRAME_KEY,
    topPageUrl,
    normalizeUrl,
    newId,

    async get() {
      return AT.store.getSession();
    },

    async isActive() {
      const s = await AT.store.getSession();
      return !!(s && s.active);
    },

    async start(author) {
      return enqueue(async () => {
        const existing = await AT.store.getSession();
        if (existing && existing.active) return existing;
        const session = {
          id: newId('s'),
          startedAt: new Date().toISOString(),
          endedAt: null,
          active: true,
          // Captured once at session start and stamped onto every annotation,
          // so a bundle says who found each thing rather than arriving
          // anonymous. See AT.store.getIdentity for why it is asked for.
          author: String(author || '').trim() || 'Unknown',
          pages: [],
          shots: []
        };
        await AT.store.setSession(session);
        return session;
      });
    },

    /* Marks the session closed but does NOT delete it - the viewer still has
     * to read it to build the ZIP. Teardown happens in the viewer once the
     * export has actually been written. */
    async end() {
      return enqueue(async () => {
        const session = await AT.store.getSession();
        if (!session) return null;
        session.active = false;
        session.endedAt = new Date().toISOString();
        await AT.store.setSession(session);
        /* Assistant connections are scoped to the session that granted them.
         * A permission that outlives what it was granted for is one nobody
         * remembers agreeing to. */
        await chrome.storage.local.remove('at_bridge');
        return session;
      });
    },

    async discard() {
      return enqueue(async () => {
        const session = await AT.store.getSession();
        const shotIds = session ? (session.shots || []).map((s) => s.id) : [];
        await AT.store.removeShots(shotIds);
        await AT.store.clearSession();
        await chrome.storage.local.remove('at_bridge');
        await AT.store.sweepOrphanShots([]);
      });
    },

    /* --- annotations ---------------------------------------------------- */

    async addAnnotation(partial) {
      /* Stamped in the ORIGINATING frame, before any relay, so the annotation
       * records where it was actually made. Restore uses this to put it back
       * in the right frame - a selector alone is meaningless without knowing
       * which document it applies to. */
      const stamped = Object.assign({}, partial, {
        frame: FRAME_PATH.length ? { path: FRAME_PATH, url: location.href } : null
      });
      if (!IS_TOP) return delegate('addAnnotation', [stamped]);

      return enqueue(async () => {
        const session = await AT.store.getSession();
        if (!session || !session.active) return null;

        const ann = Object.assign(
          {
            id: newId('a'),
            createdAt: new Date().toISOString(),
            type: 'note',
            color: '#f4c430',
            text: '',
            comment: '',
            // Stamped from the session rather than read at export time, so an
            // annotation keeps the name of whoever actually made it even if
            // the identity is changed later.
            author: session.author || 'Unknown',
            anchor: null,
            unplaced: false
          },
          stamped
        );

        const page = pageFor(session, await topPageUrl(), true);
        page.title = document.title || page.title; // titles can load late
        page.annotations.push(ann);
        await AT.store.setSession(session);
        return ann;
      });
    },

    async updateAnnotation(id, patch) {
      if (!IS_TOP) return delegate('updateAnnotation', Array.prototype.slice.call(arguments));
      return enqueue(async () => {
        const session = await AT.store.getSession();
        if (!session) return null;
        for (const page of session.pages) {
          const ann = page.annotations.find((a) => a.id === id);
          if (ann) {
            Object.assign(ann, patch);
            await AT.store.setSession(session);
            return ann;
          }
        }
        return null;
      });
    },

    async removeAnnotation(id) {
      if (!IS_TOP) return delegate('removeAnnotation', Array.prototype.slice.call(arguments));
      return enqueue(async () => {
        const session = await AT.store.getSession();
        if (!session) return false;
        for (const page of session.pages) {
          const i = page.annotations.findIndex((a) => a.id === id);
          if (i >= 0) {
            page.annotations.splice(i, 1);
            await AT.store.setSession(session);
            return true;
          }
        }
        return false;
      });
    },

    /* Annotations belonging to the current URL, for restore-on-load. */
    /* Only the annotations belonging to THIS frame. Every frame runs its own
     * restore pass, and an anchor from a different document would either miss
     * or - worse - match the wrong element. */
    async annotationsForPage() {
      const session = await AT.store.getSession();
      if (!session) return [];
      const page = pageFor(session, await topPageUrl(), false);
      if (!page) return [];
      return page.annotations.filter(
        (a) => ((a.frame && a.frame.path) || []).join('.') === FRAME_KEY
      );
    },

    /* --- screenshots ---------------------------------------------------- */

    /* Records shot METADATA. The caller is responsible for having already
     * written the pixels via AT.store.putShot() under the same id, so a failed
     * pixel write never leaves a dangling reference in the report. */
    async addShot(meta) {
      if (!IS_TOP) return delegate('addShot', [meta]);
      return enqueue(async () => {
        const session = await AT.store.getSession();
        if (!session || !session.active) return null;
        const shot = Object.assign(
          {
            id: newId('shot'),
            name: '',
            pageUrl: normalizeUrl(),
            pageTitle: document.title || '',
            createdAt: new Date().toISOString(),
            note: '',
            viewport: viewport(),
            // Scroll offset at capture time. A page coordinate minus this is
            // the coordinate INSIDE the captured image, which is what lets the
            // review page pin an annotation on the screenshot.
            scroll: scrollPos(),
            auto: false
          },
          meta
        );
        session.shots.push(shot);
        // Make sure the page appears in the report even if its only content is
        // a screenshot with no other annotations on it.
        pageFor(session, shot.pageUrl, true);
        await AT.store.setSession(session);
        return shot;
      });
    },

    /* Links a screenshot to the annotation it illustrates.
     *
     * If the annotation already had an AUTO shot, that one is dropped: editing
     * a note re-captures it, and keeping both would leave the review page
     * showing a picture of the note before the text was typed. A shot the user
     * took deliberately is never replaced this way. */
    async attachShot(annId, shotId) {
      if (!IS_TOP) return delegate('attachShot', Array.prototype.slice.call(arguments));
      return enqueue(async () => {
        const session = await AT.store.getSession();
        if (!session) return null;

        let target = null;
        for (const page of session.pages) {
          const found = page.annotations.find((a) => a.id === annId);
          if (found) {
            target = found;
            break;
          }
        }
        if (!target) return null;

        const previousId = target.shotId;
        target.shotId = shotId;

        let stale = null;
        if (previousId && previousId !== shotId) {
          const i = (session.shots || []).findIndex(
            (s) => s.id === previousId && s.auto
          );
          if (i >= 0) {
            stale = session.shots[i].id;
            session.shots.splice(i, 1);
          }
        }

        await AT.store.setSession(session);
        // Delete the pixels only after the session write succeeds, so a
        // failure here can never leave a reference to a shot that is gone.
        if (stale) await AT.store.removeShot(stale);
        return target;
      });
    },

    async counts() {
      const session = await AT.store.getSession();
      if (!session) return { annotations: 0, shots: 0, pages: 0 };
      return {
        annotations: session.pages.reduce((n, p) => n + p.annotations.length, 0),
        shots: (session.shots || []).length,
        pages: session.pages.length
      };
    }
  };
})();
