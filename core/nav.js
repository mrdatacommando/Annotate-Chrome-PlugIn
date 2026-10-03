/* Annotate Tool - Copyright (C) 2026 Mark Van de Velde
 * SPDX-License-Identifier: GPL-3.0-only
 * This program comes with ABSOLUTELY NO WARRANTY. See LICENSE for terms.
 */
/* Annotate Tool - core/nav.js
 *
 * Notices that the page changed underneath us without a page load.
 *
 * A single-page app swaps its whole view with history.pushState and never
 * reloads. Nothing in the extension used to notice: the content script boots
 * once at document_idle, draws the annotations for the URL it found, and then
 * sits there. Navigate within the app and the previous page's marks stay on
 * screen over content they have nothing to do with.
 *
 * WHY POLLING, which looks crude:
 *
 *   - pushState and replaceState fire no event at all. There is no
 *     `onpushstate`.
 *   - Patching history.pushState from a content script does NOT help. Content
 *     scripts run in an isolated world with their own JS globals; the page's
 *     History is a different object reached through a different wrapper, so
 *     the page's own calls never touch our patch. This is the trap worth
 *     writing down, because the patch LOOKS like it works - it just silently
 *     never fires.
 *   - chrome.webNavigation.onHistoryStateUpdated does see them, but the
 *     webNavigation permission puts "Read your browsing history" on the
 *     install prompt. That is a poor trade for a few hundred milliseconds.
 *
 * So: popstate and hashchange where they apply, because they are real DOM
 * events and cost nothing, and a poll to catch the rest.
 *
 * Detection only - no chrome.* here, so it is testable without an extension
 * context. Deciding what to redraw is content/overlay.js's job.
 */
(function () {
  const AT = (window.AT = window.AT || {});

  /* Fast enough that a redraw reads as part of the navigation, slow enough to
   * be invisible: a string compare 2.5 times a second. Only the top frame
   * polls - see content/overlay.js - so a page of twenty iframes still runs
   * exactly one of these. */
  const POLL_MS = 400;

  /* Hash is NOT part of a page's identity here, because AT.session.normalizeUrl
   * strips it: `#section-2` is the same document, and keeping it would scatter
   * one page's annotations across several report entries.
   *
   * The consequence is worth stating plainly: an app that routes ENTIRELY in
   * the hash (`#/orders/42`) files every route under one page. That follows
   * from the existing normalisation rule rather than from anything here, and
   * changing it would re-file every annotation ever recorded. */
  function normalize(href) {
    if (AT.session && AT.session.normalizeUrl) return AT.session.normalizeUrl(href);
    try {
      const u = new URL(href);
      u.hash = '';
      return u.toString();
    } catch (_) {
      return String(href || '');
    }
  }

  let listeners = [];
  let last = null;
  let timer = null;
  let handler = null;

  function fire(next, prev) {
    /* A copy, so a listener that unsubscribes itself does not reindex the
     * array mid-loop; and one throwing listener must not strand the others. */
    listeners.slice().forEach((fn) => {
      try {
        fn(next, prev);
      } catch (_) {}
    });
  }

  AT.nav = {
    POLL_MS: POLL_MS,
    normalize: normalize,

    samePage(a, b) {
      return normalize(a) === normalize(b);
    },

    /* The URL this module last saw, already normalised. */
    current() {
      return last;
    },

    onChange(fn) {
      listeners.push(fn);
      return function off() {
        listeners = listeners.filter((f) => f !== fn);
      };
    },

    /* Records where we are without calling anybody. The first observation is
     * where the page already is, not a navigation to it. */
    seed(href) {
      last = normalize(href);
      return last;
    },

    /* Returns true when this was a real page change. Exported rather than kept
     * private so tests can drive navigation directly, with no timers and no
     * History to fake. */
    check(href) {
      const next = normalize(href);
      if (last === null) {
        last = next;
        return false;
      }
      if (next === last) return false;
      const prev = last;
      last = next;
      fire(next, prev);
      return true;
    },

    /* Idempotent: calling it twice does not double up listeners or timers. */
    start(win) {
      const w = win || window;
      if (last === null) AT.nav.seed(w.location.href);
      if (handler) return AT.nav;
      handler = function () {
        AT.nav.check(w.location.href);
      };
      w.addEventListener('popstate', handler);
      w.addEventListener('hashchange', handler);
      timer = w.setInterval(handler, POLL_MS);
      return AT.nav;
    },

    stop(win) {
      const w = win || window;
      if (timer) {
        w.clearInterval(timer);
        timer = null;
      }
      if (handler) {
        w.removeEventListener('popstate', handler);
        w.removeEventListener('hashchange', handler);
        handler = null;
      }
    },

    /* Tests only: back to a clean module between cases. */
    _reset(win) {
      AT.nav.stop(win);
      listeners = [];
      last = null;
    }
  };
})();
