/* Annotate Tool - Copyright (C) 2026 Mark Van de Velde
 * SPDX-License-Identifier: GPL-3.0-only
 * This program comes with ABSOLUTELY NO WARRANTY. See LICENSE for terms.
 */
/* Annotate Tool - content/bridge.js
 *
 * A read-only window onto the current session and the loaded review bundle,
 * for an AI assistant driving this tab.
 *
 * WHY postMessage rather than externally_connectable, which is Chrome's
 * official cross-extension channel:
 *
 *   - externally_connectable is a MANIFEST key, read once at load. There is no
 *     runtime API to add an origin, so a "connect on this site" button cannot
 *     work through it.
 *   - Its patterns must contain at least a second-level domain, so a bare
 *     wildcard host - or even a whole TLD - is rejected outright. It can never
 *     cover "wherever the user happens to be".
 *     (Written out rather than shown: a literal wildcard pattern contains the
 *     characters that end a block comment, which is how this file first failed
 *     to parse.)
 *
 * A content script shares the window with the page, so page scripts and this
 * script can talk by postMessage. That works on every origin, needs no
 * manifest entry, and can be switched on and off while the tab sits there -
 * which is what an opt-in button actually requires.
 *
 * THE TRUST MODEL, stated plainly: on a connected origin ANY script on that
 * page can call this, not only the assistant. Page script is page script and
 * the two are indistinguishable. Three things follow, and they are the whole
 * design:
 *
 *   1. Nothing here writes. No action can create, change or delete anything.
 *   2. It answers only on origins the user connected by hand, and the list is
 *      cleared when the session ends.
 *   3. It never returns page content - only what the user themselves recorded.
 *
 * A NOTE ON FIELD NAMES - not decoration, part of the contract.
 *
 * An assistant's pipeline redacts values by field NAME before the model ever
 * sees them, replacing the content with "[BLOCKED: Sensitive key]". Measured
 * against a live one, the rule is:
 *
 *   - any name CONTAINING "auth", case-insensitively. Not a prefix match:
 *     `coauthor` and `authentic` are blocked as surely as `authorization`.
 *   - `session`
 *   - `token`
 *
 * Sensible defaults - those names usually do carry credentials - but they
 * silently gut a payload that means something else by them. Hence `summary`
 * rather than `session`, and `by` rather than `author`. Names outside the rule
 * are untouched: `name`, `user` and `username` all pass, which shows this is
 * about the KEY and not about the content being personal.
 *
 * The exported bundle still says `author`; it is read from a file and never
 * travels this path.
 */
(function () {
  'use strict';
  const AT = (window.AT = window.AT || {});

  const BRIDGE_KEY = 'at_bridge';
  const REVIEW_KEY = 'at_review';
  const REQUEST = 'AT_BRIDGE_REQUEST';
  const REPLY = 'AT_BRIDGE_REPLY';
  const VERSION = 'v1';

  let connected = false;
  let listening = false;

  /* Origin checks only mean something on http(s), and they are keyed on the
   * PROTOCOL rather than on the origin string - because those two disagree.
   *
   * Measured on a local file: location.origin reads "file://" while the
   * event.origin of that same page's own postMessage reads "null". Comparing
   * them therefore never matches, and a strict check silently ignores every
   * message. Not a security property, just an asymmetry in how the two are
   * spelled.
   *
   * Anywhere but http(s), the page is its own single origin and same-window
   * is the only check worth making. The popup will not offer to connect such
   * a page anyway; this is the difference between the script no-opping on one
   * and behaving sensibly. */
  const STRICT_ORIGIN = /^https?:$/.test(location.protocol);
  const TARGET = STRICT_ORIGIN ? location.origin : '*';

  function fromThisPage(event) {
    if (event.source !== window) return false;
    return STRICT_ORIGIN ? event.origin === location.origin : true;
  }

  function isConnectedOrigin(record) {
    if (!record || !Array.isArray(record.origins)) return false;
    return record.origins.indexOf(location.origin) > -1;
  }

  /* --- what the bridge is willing to say -------------------------------- */

  async function buildSummary() {
    const stored = await AT.store.getSession();
    if (!stored || !stored.active) return null;

    const pages = stored.pages || [];
    const here = AT.session.normalizeUrl(location.href);
    const page = pages.find((p) => p.url === here) || null;

    return {
      active: true,
      by: stored.author || null,
      startedAt: stored.startedAt || null,
      pages: pages.length,
      annotations: pages.reduce((n, p) => n + (p.annotations || []).length, 0),
      screenshots: (stored.shots || []).length,
      // Just this page's, since that is what an assistant looking at this tab
      // can actually act on.
      onThisPage: page
        ? (page.annotations || []).map(describe)
        : []
    };
  }

  /* Deliberately a projection, not the raw record. Anchors, selectors and
   * screenshot ids are of no use to a reader and would only bulk out the
   * reply; what matters is what was marked and what was said about it. */
  function describe(a) {
    return {
      id: a.id,
      type: a.type,
      by: a.author || null,
      text: a.text || '',
      comment: a.comment || '',
      unplaced: !!a.unplaced,
      inEmbeddedFrame: !!(a.frame && a.frame.path && a.frame.path.length)
    };
  }

  async function buildReview() {
    const got = await chrome.storage.local.get(REVIEW_KEY);
    const state = got[REVIEW_KEY];
    if (!state || !Array.isArray(state.items) || !state.items.length) return null;

    return {
      bundle: state.bundleName || null,
      updatedAt: state.updatedAt || null,
      items: state.items.map((it) => ({
        id: it.id,
        type: it.type,
        by: it.author || null,
        text: it.text || '',
        comment: it.comment || '',
        page: it.pageTitle || it.pageUrl || null,
        url: it.pageUrl || null,
        status: it.status || 'open',
        /* Rebuilt rather than passed through: each reply carries its own
         * `author`, which the redaction rule would blank just as surely as the
         * annotation's. Nested keys count too. */
        replies: (it.replies || []).map((r) => ({
          by: r.author || null,
          at: r.at || null,
          text: r.text || ''
        }))
      }))
    };
  }

  const ACTIONS = {
    async ping() {
      return { tool: 'Annotate Tool', bridge: VERSION, origin: location.origin };
    },
    async summary() {
      return { summary: await buildSummary() };
    },
    async review() {
      return { review: await buildReview() };
    },
    async all() {
      return { summary: await buildSummary(), review: await buildReview() };
    }
  };

  /* --- the listener ------------------------------------------------------ */

  async function onMessage(event) {
    if (!connected) return;

    /* Three checks, each closing a different hole: a message from another
     * frame or window, a message forged with a different origin, and anything
     * that is not addressed to us. */
    if (!fromThisPage(event)) return;
    const data = event.data;
    if (!data || data.type !== REQUEST) return;

    const id = data.id || null;
    const action = String(data.action || 'ping');

    let body;
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
      // Named rather than a bare failure, so a caller can discover the API
      // without documentation.
      body = {
        ok: false,
        error: 'unknown action: ' + action,
        actions: Object.keys(ACTIONS)
      };
    } else {
      try {
        body = Object.assign({ ok: true }, await ACTIONS[action]());
      } catch (e) {
        body = { ok: false, error: String(e && e.message ? e.message : e) };
      }
    }

    body.type = REPLY;
    body.id = id;
    body.readOnly = true; // nothing this bridge exposes can change anything
    // Targeted, not "*": a reply broadcast to any origin could be read by an
    // embedding page we know nothing about.
    window.postMessage(body, TARGET);
  }

  function setConnected(next) {
    connected = next;
    if (connected && !listening) {
      window.addEventListener('message', onMessage);
      listening = true;
    }
    // The listener stays attached once added; `connected` is the gate. Removing
    // and re-adding would race with a message already in flight.
  }

  /* --- boot -------------------------------------------------------------- */

  async function boot() {
    if (location.protocol === 'chrome-extension:') return;
    // Only the top frame answers. Every subframe replying would give a caller
    // several answers to one question with no way to tell them apart.
    if (!AT.session || !AT.session.IS_TOP) return;

    try {
      const got = await chrome.storage.local.get(BRIDGE_KEY);
      setConnected(isConnectedOrigin(got[BRIDGE_KEY]));
    } catch (_) {
      setConnected(false);
    }

    /* Connecting from the popup takes effect immediately, without reloading
     * the page - the button would feel broken otherwise, since the tab the
     * user is connecting is the one already in front of them. */
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[BRIDGE_KEY]) return;
      setConnected(isConnectedOrigin(changes[BRIDGE_KEY].newValue));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // For the harness; the listener is otherwise unreachable from outside.
  AT.bridge = {
    _connected: () => connected,
    _setConnected: setConnected,
    _actions: () => Object.keys(ACTIONS)
  };
})();
