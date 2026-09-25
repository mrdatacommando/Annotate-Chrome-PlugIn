/* Annotate Tool - Copyright (C) 2026 Mark Van de Velde
 * SPDX-License-Identifier: GPL-3.0-only
 * This program comes with ABSOLUTELY NO WARRANTY. See LICENSE for terms.
 */
/* Annotate Tool - content/live-dom.js
 *
 * Publishes the running session into the page's own DOM, so a local AI agent
 * looking at the tab finds it without being told it exists.
 *
 * WHY a DOM package as well as the postMessage bridge in content/bridge.js.
 * The bridge is an ASK: the caller has to know the message shape, send a
 * request and wait for a reply. That is fine for an agent someone has already
 * pointed at this extension, and useless for one that has merely been handed a
 * page. This is the passive half - a block of JSON sitting in the document
 * that says what tool produced it, what the schema is, and where the live file
 * on disk can be found. Anything that can read the page can read it.
 *
 * The two share their consent: an origin the user connected in the popup gets
 * both, and disconnecting or ending the session removes both. One control, one
 * mental model.
 *
 * WHAT IS INJECTED, and why in that shape:
 *
 *   <meta name="annotate-tool-live" content="annotate-live-v1">
 *     A cheap, greppable marker. An agent can check one selector to learn that
 *     this page carries session data at all.
 *
 *   <script type="application/json" id="annotate-tool-live">...</script>
 *     The payload. A script element with a non-JS type is INERT - the browser
 *     will not execute it - so this cannot run anything, and the content is
 *     not rendered to the human reader either. A div would be visible and
 *     would fight the page's own styles.
 *
 * WHAT IS NOT DONE HERE, deliberately:
 *
 *   - Nothing reads FROM the page. There is no route back into the extension
 *     through this file.
 *   - Page content is never included, only what the user recorded themselves.
 *   - The package is removed the moment the session ends or the origin is
 *     disconnected. Data that outlives its purpose is data nobody remembers
 *     agreeing to.
 *
 * The visible badge in the toolbar is part of the feature, not decoration: for
 * as long as this page can read the session, the user can see that it can.
 */
(function () {
  'use strict';
  const AT = (window.AT = window.AT || {});

  const MARKER = 'annotate-tool-live';
  const BRIDGE_KEY = 'at_bridge';
  const SESSION_KEY = 'at_session';
  const PATH_KEY = 'at_folder_path';

  /* --- being FOUND, as opposed to being readable ------------------------
   *
   * The payload below is complete and correct and, on its own, almost
   * undiscoverable: a script element in <head> is only found by something that
   * already knows to look for it.
   *
   * 1. An attribute on <html>. Costs nothing, renders nothing, and is the
   *    conventional place to advertise "this page has X" - one selector check
   *    rather than a hunt through <head>.
   *
   * WHAT WAS HERE AND IS NOT ANY MORE: a prefix on the page TITLE. The theory
   * was sound - a browser assistant is pushed the tab title on every turn, so
   * retitling announces the session with no effort on its part. Measured over
   * several sessions, it never once acted on it.
   *
   * Removed rather than kept on the chance it might help, because it was not
   * free: browser history records a page's title at visit time, so every page
   * visited during a session kept "[Annotating]" in the reader's history
   * permanently. It also had to be re-applied against single-page apps that
   * rename themselves, and stripped again everywhere core/session.js RECORDS a
   * title, or the decoration ended up in exported bundles as the page's real
   * name. A permanent cost for an unobserved benefit. */
  const ATTR = 'data-annotate-tool';

  /* 2. A line of plain text in the light DOM.
   *
   * The one that turned out to matter most, and the one I left out first time.
   * Reading the page text is what an assistant does before anything else - and
   * NONE of the above reaches it. Script contents, meta tags and attributes
   * are absent from innerText, and the title travels a different channel
   * entirely rather than arriving as body text. So an assistant asked to find
   * annotations read the page, found nothing, and fell back to scrolling and
   * screenshotting while the data sat in the DOM beside it.
   *
   * Clipped rather than displayed: measured, innerText INCLUDES text hidden by
   * the clip technique and excludes display:none and visibility:hidden. So
   * this reaches anything reading the page while taking up no space, altering
   * no layout, and staying out of the screenshots the reviewer is capturing.
   * aria-hidden keeps it away from screen readers, which have no use for it. */
  const NOTICE_ID = 'annotate-tool-notice';
  const NOTICE_CSS = [
    'position:absolute!important',
    'width:1px!important',
    'height:1px!important',
    'padding:0!important',
    'margin:-1px!important',
    'border:0!important',
    'overflow:hidden!important',
    'clip:rect(0 0 0 0)!important',
    'white-space:nowrap!important',
    // Not display:none or visibility:hidden - either would remove it from
    // innerText, which is the entire point of the element.
    'pointer-events:none!important'
  ].join(';');

  /* The DOM write is debounced because annotating is bursty - dragging a note
   * commits on every move - and re-serialising the payload on each one would
   * be wasted work in the page's own main thread. Matches the cadence used for
   * auto-capture coalescing. */
  const DEBOUNCE_MS = 400;

  let connected = false;
  let timer = null;
  let lastJson = null;

  function isConnectedOrigin(record) {
    if (!record || !Array.isArray(record.origins)) return false;
    return record.origins.indexOf(location.origin) > -1;
  }

  function existing() {
    return {
      meta: document.querySelector('meta[name="' + MARKER + '"]'),
      data: document.getElementById(MARKER),
      notice: document.getElementById(NOTICE_ID),
      noticeStyle: document.getElementById(NOTICE_ID + '-style')
    };
  }

  /* WHERE the notice goes, which turned out to matter more than what it says.
   *
   * Appending to <body> is the obvious choice and it is wrong. Page-text
   * extraction does not return the body: it picks a CONTENT REGION and returns
   * only that. Measured against a real extractor - on a page with a <main>, it
   * reported `Source element: <main>` and returned nothing else. Header text,
   * body-appended text and clipped text all outside <main> were absent.
   *
   * Most real applications have a <main>. So the notice was appended
   * to the body, sat outside it, and was never returned - which is why an
   * assistant asked to find annotations read the page, got nothing, and fell
   * back to screenshots. The same measurement confirmed the fix: clipped and
   * aria-hidden text INSIDE <main> comes back intact.
   *
   * APPENDED, never inserted first. core/anchor.js locates annotations with
   * positional selectors, and adding an element before existing siblings would
   * renumber them and break restoration of every annotation already made.
   * Appending leaves every existing index untouched. */
  function contentRegion() {
    return document.querySelector('main, [role="main"], article') || document.body;
  }

  function setNotice(payload) {
    const host = contentRegion();
    if (!host) return; // pre-body; refresh() runs again on the next change
    let node = document.getElementById(NOTICE_ID);
    if (!node) {
      node = document.createElement('div');
      node.id = NOTICE_ID;
      node.setAttribute('aria-hidden', 'true');
      /* A class rather than a style attribute. The inline version was a long
       * run of semicolon-separated key:value pairs, and an assistant that
       * tried to read this element reported the content came back redacted as
       * "cookie/query-string-shaped data". Unproven as the cause, but the
       * shape is avoidable at no cost, so it is avoided. */
      node.className = NOTICE_ID;
      host.appendChild(node);
    } else if (node.parentNode !== host) {
      // An SPA re-rendered its main region and took the notice with it.
      host.appendChild(node);
    }
    const text = AT.live.noticeText(payload, location.href);
    if (node.textContent !== text) node.textContent = text;
  }

  /* One stylesheet, injected once. Scoped by id so the page cannot style it by
   * accident and it cannot style the page. */
  function ensureNoticeStyle() {
    if (document.getElementById(NOTICE_ID + '-style')) return;
    const head = document.head || document.documentElement;
    if (!head) return;
    const style = document.createElement('style');
    style.id = NOTICE_ID + '-style';
    style.textContent = '#' + NOTICE_ID + '{' + NOTICE_CSS + '}';
    head.appendChild(style);
  }

  function remove() {
    const found = existing();
    if (found.meta && found.meta.parentNode) found.meta.parentNode.removeChild(found.meta);
    if (found.data && found.data.parentNode) found.data.parentNode.removeChild(found.data);
    if (found.notice && found.notice.parentNode) {
      found.notice.parentNode.removeChild(found.notice);
    }
    if (found.noticeStyle && found.noticeStyle.parentNode) {
      found.noticeStyle.parentNode.removeChild(found.noticeStyle);
    }
    // Every trace goes together. A marker left on a page with no payload
    // behind it sends a reader looking for something that is not there.
    if (document.documentElement) document.documentElement.removeAttribute(ATTR);
    lastJson = null;
    if (AT.overlay && AT.overlay.setAiState) AT.overlay.setAiState(false);
  }

  function inject(payload) {
    /* The markers are set before the early return below: the payload is
     * unchanged on most calls, but the title is not ours to assume - an SPA
     * may have just rewritten it, and the attribute may have been lost with a
     * replaced documentElement. Both are idempotent, so re-asserting costs
     * nothing and skipping them would let the markers rot while the data
     * stayed perfectly current. */
    if (document.documentElement) {
      document.documentElement.setAttribute(ATTR, 'active');
    }
    ensureNoticeStyle();
    setNotice(payload);

    const json = JSON.stringify(payload, null, 2);
    // Rewriting identical text would still dirty the DOM and wake any observer
    // the page has on it, for no change at all.
    if (json === lastJson) return;
    lastJson = json;

    const head = document.head || document.documentElement;
    const found = existing();

    let meta = found.meta;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', MARKER);
      head.appendChild(meta);
    }
    meta.setAttribute('content', payload.schema);

    let node = found.data;
    if (!node) {
      node = document.createElement('script');
      // Inert by type: the browser parses this as data and never executes it.
      node.type = 'application/json';
      node.id = MARKER;
      head.appendChild(node);
    }
    node.textContent = json;

    /* Signed AFTER the payload is final and in a SEPARATE element, which is
     * not fussiness - it is what makes the signature checkable.
     *
     * A signature living inside the object it signs cannot be verified without
     * agreeing on how to remove it again, and any disagreement about key order
     * or whitespace breaks the digest. Keeping it beside the payload means a
     * verifier hashes one thing: the literal text of #annotate-tool-live,
     * exactly as it can read it. */

    const loc = payload.location || {};
    const detail = loc.path
      ? 'This page can read the current session. Live data: ' + loc.path
      : 'This page can read the current session. Live data: folder "' +
        (loc.folder || 'not set') + '", file ' + loc.file +
        ' (set the folder path in Settings to publish a full path).';
    if (AT.overlay && AT.overlay.setAiState) AT.overlay.setAiState(true, detail);
  }

  async function refresh() {
    if (!connected) {
      remove();
      return;
    }
    let payload = null;
    try {
      payload = await AT.live.current({ toolVersion: version() });
    } catch (_) {
      payload = null;
    }
    // No active session means no package - an ended session left advertised
    // would look live to a reader with no way to tell the difference.
    if (!payload) remove();
    else inject(payload);
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(refresh, DEBOUNCE_MS);
  }

  function version() {
    try {
      return chrome.runtime.getManifest().version;
    } catch (_) {
      return 'unknown';
    }
  }

  async function boot() {
    if (location.protocol === 'chrome-extension:') return;
    /* Top frame only. Every subframe injecting its own copy would give a
     * reader several packages per page with no way to tell which is current -
     * and they would all say the same thing. */
    if (!AT.session || !AT.session.IS_TOP) return;
    if (!AT.live) return;

    try {
      const got = await chrome.storage.local.get(BRIDGE_KEY);
      connected = isConnectedOrigin(got[BRIDGE_KEY]);
    } catch (_) {
      connected = false;
    }
    await refresh();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      /* Connecting from the popup has to take effect on the tab already in
       * front of the user - the same reason bridge.js watches this key. */
      if (changes[BRIDGE_KEY]) {
        connected = isConnectedOrigin(changes[BRIDGE_KEY].newValue);
        refresh();
        return;
      }
      // The session itself changed, or the typed path did.
      if (changes[SESSION_KEY] || changes[PATH_KEY]) schedule();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // For the harness; nothing here is otherwise reachable from outside.
  AT.liveDom = {
    _connected: () => connected,
    _refresh: refresh,
    _remove: remove,
    MARKER,
    ATTR,
    NOTICE_ID
  };
})();
