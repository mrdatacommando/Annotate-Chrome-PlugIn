/* Annotate Tool - background.js (MV3 service worker)
 *
 * Does the things a content script cannot: capture the tab, own the extension's
 * tabs, and relay messages between frames.
 *
 * A service worker is killed and restarted freely by Chrome, so NOTHING here
 * may rely on a module-level variable surviving between calls. Anything that
 * must persist (which tab is the review tab) goes to storage. The capture
 * queue is the one exception, and only because losing it is harmless: the
 * worst case is a capture happening sooner than it strictly had to.
 */

/* These three are written against `self` as readily as `window`, so the worker
 * reuses them rather than carrying a second copy of the same logic.
 *
 * The worker is the ONLY component that can write the live session mirror.
 * Content scripts run in the page's origin, so their `indexedDB` is the
 * page's - they can see neither the stored folder handle nor the screenshot
 * pixels. No extension page is reliably open while somebody is annotating.
 * That leaves here.
 *
 * pick() would fail in a worker (showDirectoryPicker needs a window) but
 * nothing here calls it; the folder is chosen on the options page. */
importScripts('core/store.js', 'core/folder.js', 'core/live.js');

const TABS_KEY = 'at_tabs';

/* --- screenshots ------------------------------------------------------- */

/* Chrome rate-limits tabs.captureVisibleTab to roughly two calls per second
 * and rejects the excess with MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND. With
 * auto-capture on every annotation, a burst of marking up would otherwise fail
 * outright, so every capture is funnelled through one chain with a minimum gap. */
const MIN_CAPTURE_GAP_MS = 600;
let captureChain = Promise.resolve();
let lastCaptureAt = 0;

function queueCapture(windowId) {
  const run = async () => {
    const wait = Math.max(0, MIN_CAPTURE_GAP_MS - (Date.now() - lastCaptureAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      lastCaptureAt = Date.now();
      return { ok: true, dataUrl };
    } catch (e) {
      lastCaptureAt = Date.now();
      return { ok: false, error: describeCaptureError(e) };
    }
  };
  captureChain = captureChain.then(run, run);
  return captureChain;
}

/* Chrome's raw messages here are opaque ("Cannot access contents of the page").
 * The most common cause by far is a restricted page, so say that plainly. */
function describeCaptureError(e) {
  const raw = (e && e.message) || String(e);
  if (/cannot access|extension manifest|activeTab/i.test(raw)) {
    return 'this page does not allow screenshots (Chrome blocks captures on ' +
           'chrome:// pages, the Web Store and the built-in PDF viewer)';
  }
  if (/MAX_CAPTURE/i.test(raw)) {
    return 'captures are coming too fast; try again in a moment';
  }
  return raw;
}

/* --- tab bookkeeping ---------------------------------------------------- */

/* WHY we track tab ids rather than querying for them: chrome.tabs.query({url})
 * needs either the "tabs" permission or a host permission matching the URL,
 * and <all_urls> does not cover chrome-extension:// pages. Recording the id
 * when the page announces itself keeps the permission set unchanged. */

async function getTabs() {
  const got = await chrome.storage.local.get(TABS_KEY);
  return got[TABS_KEY] || {};
}

async function setTab(role, tabId) {
  const tabs = await getTabs();
  tabs[role] = tabId;
  await chrome.storage.local.set({ [TABS_KEY]: tabs });
}

/* Brings an existing tab forward, or reports that it is gone. Focusing the
 * WINDOW as well as the tab matters: the review tab is often in a different
 * window from the page being walked through, and activating a tab in an
 * unfocused window looks like nothing happened. */
async function focusTab(tabId) {
  if (typeof tabId !== 'number') return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return true;
  } catch (_) {
    return false; // closed since we recorded it
  }
}

/* Focus the existing tab for this role, or make one. This is what stops
 * "Back to list" spawning a fresh review tab on every step. */
async function openSingleton(role, url) {
  const tabs = await getTabs();
  if (await focusTab(tabs[role])) return { ok: true, reused: true };
  const tab = await chrome.tabs.create({ url });
  await setTab(role, tab.id);
  return { ok: true, reused: false };
}

/* The live walkthrough reuses ONE tab and navigates it. Without this, stepping
 * through twenty annotations left twenty tabs open. */
async function openLive(url) {
  const tabs = await getTabs();
  if (typeof tabs.live === 'number') {
    try {
      await chrome.tabs.get(tabs.live);
      await chrome.tabs.update(tabs.live, { url: url, active: true });
      const tab = await chrome.tabs.get(tabs.live);
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true, reused: true };
    } catch (_) {
      // fall through and make a new one
    }
  }
  const tab = await chrome.tabs.create({ url });
  await setTab('live', tab.id);
  return { ok: true, reused: false };
}

/* --- messages ----------------------------------------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'AT_CAPTURE') {
    // null means "the current window" to captureVisibleTab.
    const windowId = sender.tab ? sender.tab.windowId : null;
    queueCapture(windowId).then(sendResponse);
    return true; // keep the channel open for the async reply
  }

  /* A capture requested from inside an iframe. captureVisibleTab photographs
   * the whole tab, so the TOP frame has to hide its toolbar first - a subframe
   * can only hide its own chrome. Relayed to frame 0, which takes the shot. */
  if (msg.type === 'AT_CAPTURE_VIA_TOP') {
    if (!sender.tab) {
      sendResponse({ ok: false, error: 'no tab' });
      return true;
    }
    chrome.tabs
      .sendMessage(sender.tab.id, { type: 'AT_CAPTURE_FOR_FRAME' }, { frameId: 0 })
      .then((res) => sendResponse(res || { ok: false, error: 'no reply from top frame' }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  /* A subframe cannot read window.top.location cross-origin, but the browser
   * knows perfectly well which page the tab is on - so ask it. This is how an
   * annotation made inside an iframe gets filed under the page the user was
   * actually looking at, rather than under the frame's own URL. */
  if (msg.type === 'AT_PAGE_URL') {
    sendResponse({
      ok: true,
      url: (sender.tab && sender.tab.url) || null,
      title: (sender.tab && sender.tab.title) || null
    });
    return true;
  }

  /* Session mutations from a subframe are relayed to the TOP frame, which owns
   * the session record. Without this, several frames would each read-modify-
   * write the same storage key and quietly lose one another's annotations. */
  if (msg.type === 'AT_SESSION_OP') {
    if (!sender.tab) {
      sendResponse({ ok: false, error: 'no tab' });
      return true;
    }
    chrome.tabs
      .sendMessage(
        sender.tab.id,
        { type: 'AT_SESSION_EXEC', op: msg.op, args: msg.args },
        { frameId: 0 }
      )
      .then((res) => sendResponse(res || { ok: false, error: 'no reply from top frame' }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  /* Broadcasts the armed tool / colour to every frame in the tab, so clicking
   * Highlight in the top toolbar arms the tool inside the iframes too. */
  if (msg.type === 'AT_BROADCAST') {
    if (!sender.tab) {
      sendResponse({ ok: false });
      return true;
    }
    chrome.tabs
      .sendMessage(sender.tab.id, { type: 'AT_UI_STATE', state: msg.state })
      .catch(() => {}); // frames without our script are expected
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'AT_REGISTER_TAB') {
    // An extension page telling us which tab it is living in.
    if (sender.tab && msg.role) {
      setTab(msg.role, sender.tab.id).then(() => sendResponse({ ok: true }));
      return true;
    }
    sendResponse({ ok: false });
    return true;
  }


  if (msg.type === 'AT_OPEN_REVIEW') {
    openSingleton('review', chrome.runtime.getURL('review/review.html'))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === 'AT_OPEN_VIEWER') {
    openSingleton('viewer', chrome.runtime.getURL('viewer/viewer.html'))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === 'AT_OPEN_LIVE') {
    openLive(msg.url)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});

/* Forget a tab id as soon as its tab closes, so the next open makes a fresh
 * one instead of trying to focus a tab that is gone. */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tabs = await getTabs();
  let changed = false;
  for (const role of Object.keys(tabs)) {
    if (tabs[role] === tabId) {
      delete tabs[role];
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [TABS_KEY]: tabs });
});

/* --- the live session mirror ---------------------------------------------
 *
 * Keeps live/annotate-live.json in the working folder in step with the session
 * as it is annotated, so a local AI agent can read the current state at any
 * moment without anything being pushed at it.
 *
 * Driven by storage.onChanged rather than by the annotation code calling in:
 * every mutation already lands in `at_session`, from any frame and any tab, so
 * watching the key catches all of them and there is no path that can forget to
 * report itself.
 *
 * ON TIMERS IN A SERVICE WORKER: a pending setTimeout does NOT keep the worker
 * alive, so a debounced write can in principle be dropped when Chrome shuts
 * the worker down. That is survivable here and nowhere else in the extension:
 * the mirror is a convenience, the next annotation writes it again, and the
 * exported bundle - the thing that actually matters - is built from storage,
 * not from this file. The debounce is kept short for the same reason.
 */
const LIVE_DEBOUNCE_MS = 400;
let liveTimer = null;
const VERSION = chrome.runtime.getManifest().version;

async function mirrorLive() {
  const result = await self.AT.live.writeNow({ toolVersion: VERSION });
  if (!result.ok) return result;

  /* Screenshots are written once each, named by shot id. Doing it here rather
   * than at capture time means a shot taken before the folder was granted is
   * still picked up later, and writeShot() skips anything already on disk. */
  const session = await self.AT.store.getSession();
  for (const shot of (session && session.shots) || []) {
    await self.AT.live.writeShot(shot.id);
  }
  return result;
}

function scheduleLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    mirrorLive().catch(() => {
      // Never surfaced as an exception: live mirroring must not be able to
      // interfere with the session it is mirroring.
    });
  }, LIVE_DEBOUNCE_MS);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!changes.at_session && !changes.at_folder_path) return;

  const change = changes.at_session;
  const now = change ? change.newValue : null;
  const before = change ? change.oldValue : null;
  const active = !!(now && now.active);

  /* A session that has just ended takes its mirror with it. Data left on disk
   * after the thing it was recorded for is over is data nobody remembers
   * agreeing to - and a stale file that still reads as live would mislead the
   * very agent it was written for.
   *
   * "Just ended" is read from the CHANGE (oldValue active, newValue not)
   * rather than from a flag on this worker. Chrome restarts the worker freely,
   * so a remembered flag would be false again by the time the session ended
   * and the mirror would simply be left behind. */
  if (change && !!(before && before.active) && !active) {
    clearTimeout(liveTimer);
    self.AT.live.clear().catch(() => {});
    return;
  }
  scheduleLive();
});

/* --- diagnostic: can THIS worker write to the working folder? -------------
 *
 * Not part of any feature. It exists because the answer decides the shape of
 * live-session writing, and I would rather measure it than assume it.
 *
 * The worker is the only component alive while a session records: content
 * scripts run in the PAGE's origin so they cannot see the extension's
 * IndexedDB, and no extension page is reliably open. So either the worker can
 * drive a stored directory handle or live writing needs a different home.
 *
 * The specific doubt: a handle survives in IndexedDB and queryPermission() may
 * well answer "granted", but the grant was made in a window, and a worker has
 * no user activation to spend if Chrome decides to re-ask. Whether the grant
 * carries across is not something the spec settles for extensions.
 *
 * Run it from the service worker console (chrome://extensions -> "service
 * worker"):  await probeFolderWrite()
 */
self.probeFolderWrite = async function probeFolderWrite() {
  const steps = [];
  const note = (label, ok, detail) => {
    steps.push((ok ? 'ok   ' : 'FAIL ') + label + (detail ? ' :: ' + detail : ''));
  };

  try {
    note('AT.folder loaded in the worker', !!(self.AT && self.AT.folder));
    note('showDirectoryPicker absent here (expected)',
      typeof self.showDirectoryPicker === 'undefined');

    const handle = await self.AT.folder.stored();
    note('a stored handle came back from IndexedDB', !!handle,
      handle ? 'name=' + handle.name : 'none - choose a folder in Settings first');
    if (!handle) return steps.join('\n');

    let permission = null;
    try {
      permission = await handle.queryPermission({ mode: 'readwrite' });
      note('queryPermission answered', true, permission);
    } catch (e) {
      note('queryPermission threw', false, String(e && e.message ? e.message : e));
      return steps.join('\n');
    }

    /* The question that matters. "granted" above is necessary but not
     * sufficient - it says nothing about whether a write from a worker with no
     * activation is actually allowed through. */
    if (permission !== 'granted') {
      note('write attempted', false,
        'permission is "' + permission + '", not "granted" - a window would ' +
        'have to re-ask before the worker could write');
      return steps.join('\n');
    }

    const name = 'at-worker-probe.tmp';
    try {
      const file = await handle.getFileHandle(name, { create: true });
      const writable = await file.createWritable();
      await writable.write(new Blob([JSON.stringify({ probe: true, at: Date.now() })]));
      await writable.close();
      note('THE WORKER WROTE A FILE', true, name);
    } catch (e) {
      note('THE WORKER COULD NOT WRITE', false,
        (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e)));
      return steps.join('\n');
    }

    // Read it back: a createWritable() that resolves is not proof of a file on
    // disk, and live writing will overwrite the same file repeatedly.
    try {
      const file = await handle.getFileHandle(name);
      const text = await (await file.getFile()).text();
      note('and read it back', /"probe":true/.test(text), text.slice(0, 60));
    } catch (e) {
      note('but could not read it back', false, String(e && e.message ? e.message : e));
    }

    // Live writing needs deletes too (clearing a finished session), and it
    // leaves no litter in the reader's folder.
    try {
      await handle.removeEntry(name);
      note('and removed it again', true);
    } catch (e) {
      note('could not remove it - delete ' + name + ' by hand', false,
        String(e && e.message ? e.message : e));
    }
  } catch (e) {
    note('threw', false, (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : String(e)));
  }

  return steps.join('\n');
};
