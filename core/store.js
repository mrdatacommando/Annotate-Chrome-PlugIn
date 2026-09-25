/* Annotate Tool - core/store.js
 *
 * Thin wrapper over chrome.storage.local. Loaded by the content script, the
 * popup and the viewer, so it must not touch the DOM or assume a page context.
 *
 * WHY screenshots live under their own keys instead of inside the session
 * object: chrome.storage.local serialises the ENTIRE value on every get and
 * every set. A full-viewport PNG is comfortably 300KB-2MB as a base64 data URL.
 * If those sat inside `at_session`, then dragging a sticky note - which writes
 * the session on every commit - would re-serialise every screenshot taken so
 * far. Keeping only shot METADATA in the session keeps that object small and
 * cheap to write, and the heavy pixels are fetched only at export time.
 *
 * WHY unlimitedStorage is in the manifest: storage.local is capped at ~10MB
 * without it, which a dozen screenshots will exceed.
 */
(function () {
  'use strict';
  /* `self` in the service worker, `window` everywhere else: the worker needs
   * getShot() to write live screenshots, and a second copy of this would be a
   * second thing to keep in step. */
  const root = typeof window !== 'undefined' ? window : self;
  const AT = (root.AT = root.AT || {});

  const SESSION_KEY = 'at_session';
  const SHOT_PREFIX = 'at_shot_';
  const IDENTITY_KEY = 'at_identity';

  /* --- orphaned content scripts -------------------------------------------
   *
   * Reloading the extension does NOT tear down the content scripts already
   * running in open tabs. They keep running, detached from an extension that
   * no longer exists, and their next chrome.storage call rejects with
   * "Extension context invalidated" - an uncaught promise rejection in the
   * page's console, on a page the reader is still looking at.
   *
   * Nothing can revive that script; only reloading the page brings back a
   * live one. What this does is make it fail QUIETLY, so a reload during
   * development does not fill somebody's console with errors from a dead
   * copy of the extension.
   *
   * chrome.runtime.id is the test: it is present while the context is alive
   * and undefined once it is gone. Reading it can itself throw, hence the
   * try. A dead context reports "no session", which is true - this script
   * can no longer see one. */
  function alive() {
    try {
      return !!(root.chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  /* Wraps a storage call so an invalidated context resolves to a fallback
   * instead of rejecting. Only a dead context is swallowed; every other
   * failure is left to reach the caller, because a storage error that is not
   * this one is a real bug and hiding it would cost hours. */
  async function guard(fn, fallback) {
    if (!alive()) return fallback;
    try {
      return await fn();
    } catch (e) {
      const message = String((e && e.message) || e);
      if (/Extension context invalidated|Receiving end does not exist/i.test(message)) {
        return fallback;
      }
      throw e;
    }
  }

  AT.store = {
    alive,
    SESSION_KEY,
    SHOT_PREFIX,
    IDENTITY_KEY,

    /* Who this person is, for attributing annotations and replies.
     *
     * Asked for once and remembered. There is deliberately no attempt to
     * detect it: chrome.identity would need an extra permission, only works
     * when signed into Chrome, and would put the user's email address into
     * every bundle they share with anyone. A name they typed themselves is
     * both more reliable and less of a disclosure. */
    async getIdentity() {
      return guard(async () => {
        const got = await chrome.storage.local.get(IDENTITY_KEY);
        const id = got[IDENTITY_KEY];
        return id && id.name ? id : null;
      }, null);
    },

    async setIdentity(name) {
      const clean = String(name || '').trim().slice(0, 60);
      if (!clean) {
        await chrome.storage.local.remove(IDENTITY_KEY);
        return null;
      }
      const identity = { name: clean, setAt: new Date().toISOString() };
      await chrome.storage.local.set({ [IDENTITY_KEY]: identity });
      return identity;
    },

    async getSession() {
      return guard(async () => {
        const got = await chrome.storage.local.get(SESSION_KEY);
        return got[SESSION_KEY] || null;
      }, null);
    },

    async setSession(session) {
      return guard(async () => {
        await chrome.storage.local.set({ [SESSION_KEY]: session });
        return session;
      }, session);
    },

    async clearSession() {
      return guard(() => chrome.storage.local.remove(SESSION_KEY), undefined);
    },

    /* Screenshots ------------------------------------------------------- */

    async putShot(id, dataUrl) {
      return guard(() => chrome.storage.local.set({ [SHOT_PREFIX + id]: dataUrl }), undefined);
    },

    async getShot(id) {
      return guard(async () => {
        const key = SHOT_PREFIX + id;
        const got = await chrome.storage.local.get(key);
        return got[key] || null;
      }, null);
    },

    async removeShot(id) {
      return guard(() => chrome.storage.local.remove(SHOT_PREFIX + id), undefined);
    },

    /* Drops every shot blob. Called when a session ends, AFTER the ZIP has
     * been built - otherwise we would delete the pixels we are exporting. */
    async removeShots(ids) {
      if (!ids || !ids.length) return;
      return guard(
        () => chrome.storage.local.remove(ids.map((id) => SHOT_PREFIX + id)), undefined);
    },

    /* Belt-and-braces cleanup: sweeps any at_shot_* key that no longer has a
     * matching entry in the session. Guards against shots orphaned by a crash
     * between putShot() and the session write. */
    async sweepOrphanShots(knownIds) {
      const known = new Set((knownIds || []).map((id) => SHOT_PREFIX + id));
      const all = await guard(() => chrome.storage.local.get(null), {});
      const orphans = Object.keys(all).filter(
        (k) => k.startsWith(SHOT_PREFIX) && !known.has(k)
      );
      if (orphans.length) await chrome.storage.local.remove(orphans);
      return orphans.length;
    },

    async usageBytes() {
      // getBytesInUse is not implemented for local storage in every Chrome
      // build when unlimitedStorage is set, so treat a throw as "unknown".
      try {
        return await chrome.storage.local.getBytesInUse(null);
      } catch (_) {
        return null;
      }
    }
  };
})();
