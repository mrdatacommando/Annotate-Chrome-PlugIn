/* Annotate Tool - Copyright (C) 2026 Mark Van de Velde
 * SPDX-License-Identifier: GPL-3.0-only
 * This program comes with ABSOLUTELY NO WARRANTY. See LICENSE for terms.
 */
/* Annotate Tool - core/folder.js
 *
 * A working folder on the local disk, chosen once and remembered, where
 * bundles are saved and reopened without a file dialog every time.
 *
 * WHY the File System Access API rather than Google Drive: this needs no
 * OAuth, no cloud project, no scope verification and no weekly re-login - and
 * it can point at ANY folder, including a synced Drive/OneDrive/Dropbox one,
 * which gets cloud sync for free from a client that already works. A Drive API
 * integration could only ever offer a folder the extension itself created,
 * because the Picker needs remotely-hosted code that MV3 forbids.
 *
 * THREE THINGS THE API DOES NOT GIVE US, each of which shapes the code below:
 *
 *   1. No path. A handle exposes `name` and nothing more - "Reviews", never
 *      "D:\Work\Reviews". The UI can only ever name the folder.
 *   2. No lasting permission. The handle survives a browser restart in
 *      IndexedDB; the GRANT often does not. Re-asking needs a user gesture,
 *      so permission is checked before use and surfaced, never assumed.
 *   3. No notification when the folder goes away. A moved or deleted folder
 *      turns every call into an exception, so "still there?" is an explicit
 *      state rather than a try/catch around the real work.
 *
 * The parts that are pure - naming, sorting, classifying failures - are kept
 * out of the API calls so they can be tested headlessly. Everything touching
 * the filesystem needs a real gesture and a real disk, and is verified by hand.
 */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;
  const AT = (root.AT = root.AT || {});

  const DB_NAME = 'at_folder';
  const DB_STORE = 'handles';
  const HANDLE_KEY = 'working';

  /* --- pure helpers (tested) ------------------------------------------- */

  const pure = {
    /* Bundles are named by report.build(); this only guards against a name
     * that could escape the chosen folder. A handle from the picker is scoped
     * to that directory, but getFileHandle() with a slash in the name throws
     * rather than nesting, and a clear message beats a DOM exception. */
    safeName(name) {
      const clean = String(name || '')
        .replace(/[\\/]+/g, '-')
        .replace(/[\x00-\x1f<>:"|?*]+/g, '')
        .replace(/^\.+/, '')
        .trim();
      return clean || 'bundle.zip';
    },

    /* Only our own bundles are offered for reopening. A folder synced from
     * Drive is full of unrelated files, and a review page that listed all of
     * them would be a file browser nobody asked for. */
    isBundle(name) {
      return /\.zip$/i.test(String(name || ''));
    },

    /* Pulls the sortable parts out of a bundle name:
     *   annotate-session-2026-09-10-1432.zip              round 0
     *   annotate-session-2026-09-10-1432-reviewed.zip     round 0.5
     *   annotate-session-2026-09-10-1432-reply-2.zip      round 2
     * Returns null for anything that is not one of ours. */
    bundleKey(name) {
      const m = /^annotate-session-(\d{4}-\d{2}-\d{2}-\d{4})(-reviewed|-reply-(\d+))?/i
        .exec(String(name || ''));
      if (!m) return null;
      let round = 0;
      if (m[3]) round = parseInt(m[3], 10);
      // A reviewed pass is newer than the bundle it answers but older than any
      // numbered reply round, so it sits between them.
      else if (m[2]) round = 0.5;
      return { stamp: m[1], round: round };
    },

    /* Newest first.
     *
     * NOT a plain string sort. The timestamp part orders correctly as a
     * string, but the suffixes do not: "-1432.zip" sorts ABOVE
     * "-1432-reply-2.zip" because "." outranks "-", which would put a bundle
     * ahead of the reply that answers it. The round is compared as a number
     * instead. lastModified is only the final tie-break, for files that
     * arrived in the folder some other way. */
    sortBundles(files) {
      return files.slice().sort((a, b) => {
        const ka = pure.bundleKey(a.name);
        const kb = pure.bundleKey(b.name);
        if (ka && kb) {
          if (ka.stamp !== kb.stamp) return ka.stamp < kb.stamp ? 1 : -1;
          if (ka.round !== kb.round) return kb.round - ka.round;
        } else if (ka || kb) {
          // Our own bundles first; a stray zip is less likely to be wanted.
          return ka ? -1 : 1;
        }
        if (a.name !== b.name) return a.name < b.name ? 1 : -1;
        return (b.lastModified || 0) - (a.lastModified || 0);
      });
    },

    /* Turns a raw DOMException into something worth showing a person.
     * Distinguishing "you said no" from "the folder is gone" matters: one is
     * fixed by clicking allow, the other by choosing a new folder. */
    describeError(err) {
      const name = (err && err.name) || '';
      const message = (err && err.message) || String(err || '');
      /* Also where a BLOCKED folder lands.
       *
       * Chrome refuses a set of sensitive folders outright - Downloads,
       * Desktop, Documents, your home folder, Windows, Program Files - with
       * its own dialog saying the folder "contains system files". That dialog
       * is Chrome's, not ours: if the reader backs out of it we simply see a
       * cancel, indistinguishable from changing their mind. So the message
       * carries the fix for the case we cannot detect. */
      if (name === 'AbortError') {
        return {
          kind: 'cancelled',
          text: 'No folder was chosen. If Chrome said the folder "contains ' +
                'system files", it blocks that one - pick a subfolder inside ' +
                'it instead, which is allowed.'
        };
      }
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        return {
          kind: 'denied',
          text: 'Permission to use that folder was declined. Choose it again to retry.'
        };
      }
      if (name === 'NotFoundError') {
        return {
          kind: 'missing',
          text: 'That folder is no longer there - it may have been moved, renamed or deleted. Choose it again.'
        };
      }
      if (name === 'NoModificationAllowedError' || name === 'InvalidStateError') {
        return {
          kind: 'locked',
          text: 'That file is open in another program and could not be written.'
        };
      }
      return { kind: 'error', text: message || 'The folder could not be used.' };
    },

    /* Whether the API exists at all. Chromium-only, and absent in a service
     * worker even there - the picker needs a window. */
    supported() {
      return typeof root.showDirectoryPicker === 'function';
    }
  };

  AT.folderPure = pure;

  /* --- handle storage --------------------------------------------------- */

  /* A directory handle is a structured-cloneable object, so IndexedDB can hold
   * it verbatim. chrome.storage cannot - it serialises to JSON, which would
   * quietly reduce the handle to an empty object. That single fact is why this
   * module carries its own tiny database instead of using AT.store. */
  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDelete(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /* --- the folder ------------------------------------------------------- */

  AT.folder = {
    supported: pure.supported,
    safeName: pure.safeName,
    describeError: pure.describeError,

    /* Asks for a folder. MUST be called straight from a click - the picker is
     * gesture-gated and throws otherwise. */
    async pick() {
      const handle = await root.showDirectoryPicker({
        id: 'annotate-tool-bundles', // Chrome reopens at the last-used spot
        mode: 'readwrite',
        startIn: 'documents'
      });
      await idbSet(HANDLE_KEY, handle);
      return handle;
    },

    async stored() {
      try {
        return await idbGet(HANDLE_KEY);
      } catch (_) {
        return null;
      }
    },

    async forget() {
      await idbDelete(HANDLE_KEY);
    },

    /* What the settings page needs to render, without doing anything that
     * requires a gesture. `permission` is the honest current state:
     *   granted - ready to use
     *   prompt  - the handle is fine but the user must allow it again, which
     *             is the ordinary state after a browser restart
     *   denied  - refused
     *   missing - no folder chosen yet
     *   gone    - chosen once, but the folder is no longer reachable
     */
    async status() {
      if (!pure.supported()) {
        return { permission: 'unsupported', name: null };
      }
      const handle = await AT.folder.stored();
      if (!handle) return { permission: 'missing', name: null };

      let permission;
      try {
        permission = await handle.queryPermission({ mode: 'readwrite' });
      } catch (_) {
        return { permission: 'gone', name: handle.name || null };
      }

      /* queryPermission answering "granted" is not proof the folder still
       * exists - a deleted folder still reports granted until something
       * actually touches it. One cheap read settles it. */
      if (permission === 'granted') {
        try {
          const it = handle.values();
          await it.next();
        } catch (_) {
          return { permission: 'gone', name: handle.name || null };
        }
      }
      return { permission: permission, name: handle.name || null };
    },

    /* Re-asks for permission. Also gesture-gated, so it belongs on a button. */
    async grant() {
      const handle = await AT.folder.stored();
      if (!handle) return 'missing';
      return handle.requestPermission({ mode: 'readwrite' });
    },

    /* The handle, ready to use, or null when it is not usable right now. The
     * caller decides whether to prompt - this never does, because it may be
     * running without a gesture to spend. */
    async ready() {
      const handle = await AT.folder.stored();
      if (!handle) return null;
      try {
        const permission = await handle.queryPermission({ mode: 'readwrite' });
        return permission === 'granted' ? handle : null;
      } catch (_) {
        return null;
      }
    },

    async write(name, blob) {
      const handle = await AT.folder.ready();
      if (!handle) throw Object.assign(new Error('no folder'), { name: 'NotAllowedError' });
      const file = await handle.getFileHandle(pure.safeName(name), { create: true });
      const writable = await file.createWritable();
      try {
        await writable.write(blob);
      } finally {
        // close() commits the file; skipping it on an error path would leave
        // a zero-length bundle behind looking like a successful save.
        await writable.close();
      }
      return pure.safeName(name);
    },

    /* Bundles in the folder, newest first. Names and sizes only - reading
     * every ZIP to list them would be tens of megabytes for a directory the
     * user might only be glancing at. */
    async list() {
      const handle = await AT.folder.ready();
      if (!handle) return [];
      const out = [];
      for await (const entry of handle.values()) {
        if (entry.kind !== 'file' || !pure.isBundle(entry.name)) continue;
        try {
          const file = await entry.getFile();
          out.push({
            name: entry.name,
            size: file.size,
            lastModified: file.lastModified
          });
        } catch (_) {
          // A file that vanished mid-listing is simply not listed.
        }
      }
      return pure.sortBundles(out);
    },

    async read(name) {
      const handle = await AT.folder.ready();
      if (!handle) throw Object.assign(new Error('no folder'), { name: 'NotAllowedError' });
      const file = await handle.getFileHandle(pure.safeName(name));
      return file.getFile();
    }
  };
})();
