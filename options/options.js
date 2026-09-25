/* Annotate Tool - Copyright (C) 2026 Mark Van de Velde
 * SPDX-License-Identifier: GPL-3.0-only
 * This program comes with ABSOLUTELY NO WARRANTY. See LICENSE for terms.
 */
/* Annotate Tool - options/options.js
 *
 * Settings. Currently: your name, and the working folder.
 *
 * The folder picker lives HERE rather than in the popup because it is
 * gesture-gated and the popup closes the moment focus moves to the system
 * dialog - the pick would be cancelled by the act of making it.
 *
 * Every state the folder can be in is shown plainly, because two of them look
 * identical from the outside and are fixed in completely different ways:
 * "allow it again" (ordinary, after a browser restart) versus "that folder is
 * gone" (needs a new choice). Collapsing them into one "not working" message
 * would send people to the wrong remedy.
 */
(function () {
  'use strict';

  const app = document.getElementById('app');

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, cls, onClick) {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  let message = null; // { text, good }

  function say(text, good) {
    message = { text: text, good: !!good };
    render();
  }

  /* --- identity --------------------------------------------------------- */

  function renderIdentity(identity) {
    const card = el('div', 'card');
    card.appendChild(el('h2', null, 'Your name'));
    card.appendChild(el('p', null,
      'Goes onto every annotation and reply you make, so a bundle says who ' +
      'found each thing.'));

    const label = el('label', null, 'Name');
    label.setAttribute('for', 'name');
    card.appendChild(label);

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'name';
    input.maxLength = 60;
    input.placeholder = 'e.g. Mark';
    input.value = identity ? identity.name : '';
    card.appendChild(input);

    const row = el('div', 'row');
    row.style.marginTop = '12px';
    row.appendChild(button('Save name', 'go', async () => {
      await AT.store.setIdentity(input.value);
      say('Name saved.', true);
    }));
    card.appendChild(row);
    return card;
  }

  /* --- working folder ---------------------------------------------------- */

  const FOLDER_STATE = {
    granted: { icon: 'ð', state: 'Ready', warn: false },
    prompt: {
      icon: 'ð',
      state: 'Needs permission again â Chrome asks after a restart',
      warn: true
    },
    denied: { icon: 'ð', state: 'Permission was declined', warn: true },
    gone: { icon: 'ð', state: 'No longer reachable â moved, renamed or deleted', warn: true },
    missing: { icon: 'ð', state: 'No folder chosen yet', warn: false },
    unsupported: { icon: 'ð«', state: 'Not available in this browser', warn: true }
  };

  function renderFolder(status) {
    const card = el('div', 'card');
    card.appendChild(el('h2', null, 'Working folder'));
    card.appendChild(el('p', null,
      'Save exported bundles straight to a folder, and reopen them without a ' +
      'file dialog. Point it at a synced Drive, OneDrive or Dropbox folder and ' +
      'they sync themselves â nothing is sent anywhere by this extension. ' +
      'Pick a folder of its own, such as Documents\\Annotate Reviews; you can ' +
      'create one from inside the chooser.'));

    const info = FOLDER_STATE[status.permission] || FOLDER_STATE.missing;
    const box = el('div', 'folder' + (info.warn ? ' warn' : ''));
    box.appendChild(el('span', 'icon', info.icon));

    const text = el('div');
    text.appendChild(el('div', 'name', status.name || 'None selected'));
    text.appendChild(el('div', 'state', info.state));
    box.appendChild(text);
    card.appendChild(box);

    if (status.permission === 'unsupported') {
      card.appendChild(el('p', 'msg bad',
        'This needs the File System Access API, which Chrome has and some ' +
        'other browsers do not.'));
      return card;
    }

    const row = el('div', 'row');

    row.appendChild(button(
      status.permission === 'missing' ? 'Choose a folderâ¦' : 'Choose a different folderâ¦',
      'go',
      async () => {
        try {
          const handle = await AT.folder.pick();
          /* The name is mirrored into storage because the handle itself is
           * only readable here: a content script's indexedDB belongs to the
           * page, not the extension, so the live DOM package could never see
           * it otherwise. */
          await AT.live.setFolderName(handle.name);
          /* A path confirmed for the OLD folder says nothing about this one,
           * and a stale path is the one failure here that is silent - the
           * extension carries on writing to the right place while telling an
           * agent to look somewhere else. Cleared rather than kept. */
          await AT.live.setTypedPath('');
          say('Using the folder "' + handle.name + '".', true);
        } catch (e) {
          const described = AT.folder.describeError(e);
          // Cancelling a picker is not an error worth shouting about.
          if (described.kind === 'cancelled') render();
          else say(described.text, false);
        }
      }
    ));

    /* The common case after a browser restart: the folder is fine, Chrome just
     * wants the grant confirmed. One button, not a re-pick. */
    if (status.permission === 'prompt' || status.permission === 'denied') {
      row.appendChild(button('Allow access', 'blue', async () => {
        try {
          const result = await AT.folder.grant();
          if (result === 'granted') say('Access granted.', true);
          else say('Access was not granted.', false);
        } catch (e) {
          say(AT.folder.describeError(e).text, false);
        }
      }));
    }

    if (status.permission !== 'missing') {
      row.appendChild(button('Forget folder', 'quiet', async () => {
        await AT.folder.forget();
        await AT.live.setFolderName(null);
        await AT.live.setTypedPath('');
        say('Folder forgotten. Bundles will download as usual.', true);
      }));
    }

    card.appendChild(row);

    /* Two behaviours of this API surprise everyone who meets it, so they are
     * stated here rather than left to be discovered. */
    const note = el('div', 'note');
    note.appendChild(el('strong', null, 'Worth knowing'));
    const list = el('ul');
    /* First, because it is the one people hit immediately. Chrome refuses
     * these folders with a dialog reading "contains system files", which is
     * baffling for Downloads - and it never reaches this extension, so the
     * only place to explain it is before the fact. */
    list.appendChild(el('li', null,
      'Chrome will not allow Downloads, Desktop, Documents, your home folder ' +
      'or system folders to be chosen directly â it says they "contain ' +
      'system files". A subfolder inside any of them works: choose ' +
      'Downloads\\Annotate Reviews rather than Downloads itself.'));
    list.appendChild(el('li',
      null,
      'Chrome only tells the extension the folder\'s name, never its full ' +
      'path â so "' + (status.name || 'Reviews') + '" is all this page can show.'));
    list.appendChild(el('li', null,
      'After you restart Chrome you may be asked to allow the folder once ' +
      'more. The choice is remembered; the permission is what expires.'));
    list.appendChild(el('li', null,
      'Nothing is uploaded. Files are written to that folder on this machine.'));
    note.appendChild(list);
    card.appendChild(note);

    return card;
  }

  /* --- live data for a local AI ------------------------------------------ */

  /* The one setting in this extension that it cannot verify, so it is built to
   * say so rather than to look reassuring.
   *
   * While a session records, the extension mirrors it to a file inside the
   * working folder and advertises that file in the page for a local AI agent
   * to find. The advertisement needs an absolute path - and Chrome will not
   * give the extension one. It knows the folder is called "Reviews"; it cannot
   * know it is D:\Work\Reviews, and no API will tell it.
   *
   * So the reader types it. What they type is passed along untouched and
   * marked unverified in the payload every time, because it is only as true as
   * their typing: move the folder afterwards and the extension keeps writing
   * to the right place through the handle while still reporting the old path.
   * Leaving it blank is a perfectly good choice - the package then names the
   * folder and filename and lets the agent find them. */
  const DETECT_FAIL = {
    'no-folder': 'Choose a working folder first, and allow access to it.',
    unavailable: 'Automatic detection is not available here.',
    cancelled: 'Nothing was saved, so the path was not detected. You can type it instead.',
    unreadable: 'Chrome did not report where the file was saved. Type the path instead.'
  };

  /* Nothing here touches the field directly. detectPath() stores the path on
   * success, and say() re-renders the whole page from storage - so setting
   * input.value first would only be overwritten a moment later. Letting the
   * re-render be the single way results reach the screen keeps the field and
   * the stored value from being able to disagree. */
  async function detectPath() {
    const result = await AT.live.detectPath();

    if (result.ok) {
      say('Detected and confirmed: ' + result.path, true);
      return;
    }
    /* The one failure worth explaining properly. The reader did save the file,
     * just not where the working folder is - so the path IS known and is
     * simply the wrong one. Saying which folder they landed in is what makes
     * the mistake obvious. */
    if (result.reason === 'elsewhere') {
      say('That was saved to ' + (result.savedTo || 'another folder') +
          ', which is not your working folder. Nothing was stored â run it ' +
          'again and save into the folder you chose above.', false);
      return;
    }
    say(DETECT_FAIL[result.reason] || 'The path could not be detected.', false);
  }

  function renderLive(status, record) {
    const typedPath = record.path;
    const card = el('div', 'card');
    card.appendChild(el('h2', null, 'Live data for a local AI'));
    card.appendChild(el('p', null,
      'While a session is recording, the current annotations are written to ' +
      'live\\annotate-live.json inside your working folder, updating as you ' +
      'go, with screenshots alongside. Any page you have connected to an ' +
      'assistant also carries a copy in its own HTML, so an agent that cannot ' +
      'read files still gets everything. Connect a site from the extension ' +
      'popup; the toolbar shows a badge whenever a page can read your session.'));

    if (status.permission === 'missing' || status.permission === 'unsupported') {
      card.appendChild(el('p', 'msg bad',
        'Choose a working folder above and the live file will be written there.'));
    }

    const label = el('label', null, 'Full path to your working folder (optional)');
    label.setAttribute('for', 'folderpath');
    card.appendChild(label);

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'folderpath';
    input.maxLength = 400;
    input.spellcheck = false;
    input.placeholder = 'e.g. D:\\Work\\Annotate Reviews';
    input.value = typedPath || '';
    card.appendChild(input);

    const preview = el('div', 'state');
    preview.style.marginTop = '8px';
    /* Shows what an agent will actually be told, and whether that came from a
     * check or from typing. The distinction is the whole point of the card:
     * one of these the extension stands behind, the other it is repeating. */
    function updatePreview(value, verified) {
      const p = AT.live.pointer(status.name, String(value || '').trim(), verified);
      if (!p.path) {
        preview.textContent = 'An agent will be told: folder "' +
          (p.folder || 'not set') + '", file ' + p.file +
          ' â and will have to locate it itself.';
        return;
      }
      preview.textContent = 'An agent will be told: ' + p.path +
        (p.pathVerified
          ? ' â confirmed to be this folder.'
          : ' â passed on as typed, not checked.');
    }
    updatePreview(input.value, record.verified);
    // Editing invalidates a previous confirmation: what is in the box is no
    // longer the string that was checked.
    input.addEventListener('input', () => updatePreview(input.value, false));
    card.appendChild(preview);

    const row = el('div', 'row');
    row.style.marginTop = '12px';

    /* Offered first, because it is both easier and better: it fills the box in
     * AND confirms the answer, which typing cannot do. */
    row.appendChild(button('Detect automaticallyâ¦', 'blue', detectPath));

    row.appendChild(button('Save path', 'go', async () => {
      const saved = await AT.live.setTypedPath(input.value);
      updatePreview(input.value, false);
      say(saved ? 'Path saved. It is passed on as typed, not checked.' : 'Path cleared.', true);
    }));
    card.appendChild(row);

    const how = el('div', 'state');
    how.style.marginTop = '8px';
    how.textContent = 'Detecting saves a small file through a Save dialog. ' +
      'Choose your working folder in that dialog; the extension reads where ' +
      'it went, confirms it really is that folder, then deletes it.';
    card.appendChild(how);

    const note = el('div', 'note');
    note.appendChild(el('strong', null, 'Why this is not automatic'));
    const list = el('ul');
    list.appendChild(el('li', null,
      'When you choose a folder, Chrome tells the extension its name and ' +
      'nothing else â never the path. That is why this cannot simply be ' +
      'filled in when you pick the folder.'));
    list.appendChild(el('li', null,
      'Detecting works around it: saving a file tells the extension where ' +
      'that file went. Finding the same file back inside your working folder ' +
      'is what confirms the two are the same place.'));
    /* Said plainly because the failure is silent: everything keeps working
     * except the one line the agent relies on. */
    list.appendChild(el('li', null,
      'Either way the path is only right for as long as the folder stays ' +
      'put. Move or rename it and the extension keeps writing to it ' +
      'correctly, while this path quietly goes wrong. Choosing a different ' +
      'folder clears it.'));
    list.appendChild(el('li', null,
      'A path you type is passed on unchecked, and the data says so.'));
    list.appendChild(el('li', null,
      'Leave it blank if you would rather not publish a path. The agent is ' +
      'still told the folder name and filename.'));
    list.appendChild(el('li', null,
      'The live folder is deleted when a session ends.'));
    note.appendChild(list);
    card.appendChild(note);

    return card;
  }

  /* --- render ------------------------------------------------------------ */

  async function render() {
    app.replaceChildren();

    const identity = await AT.store.getIdentity().catch(() => null);
    app.appendChild(renderIdentity(identity));

    const status = await AT.folder.status().catch(() => ({
      permission: 'missing', name: null
    }));
    app.appendChild(renderFolder(status));

    /* Keeps the mirrored name honest without anyone having to remember to
     * update it - the handle is readable here and nowhere else, so this page
     * is the only one that can correct a drift. */
    if (status.name) await AT.live.setFolderName(status.name).catch(() => {});

    const record = await AT.live.pathRecord()
      .catch(() => ({ path: null, verified: false, at: null }));
    app.appendChild(renderLive(status, record));

    if (message) {
      app.appendChild(el('p', 'msg ' + (message.good ? 'good' : 'bad'), message.text));
      message = null; // shown once, not sticky across the next render
    }
  }

  /* Version comes from the manifest so the notice cannot drift out of date.
   * Guarded: the test harness stubs chrome.storage but not runtime.getManifest. */
  try {
    const slot = document.getElementById("version");
    const v = chrome.runtime.getManifest && chrome.runtime.getManifest().version;
    if (slot && v) slot.textContent = "v" + v + " — ";
  } catch (_) { /* notice still reads correctly without it */ }

  render();
})();
