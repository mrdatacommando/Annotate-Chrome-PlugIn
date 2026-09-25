/* Annotate Tool - popup/popup.js
 *
 * Start and end sessions, and show what the current one holds.
 *
 * The popup is the ONLY place a session can be started. With <all_urls> the
 * content script is present on every page the user opens, so starting from the
 * toolbar button is a deliberate, visible act rather than something that could
 * happen by brushing against the page.
 */
(function () {
  'use strict';

  const subEl = document.getElementById('sub');
  const bodyEl = document.getElementById('body');

  /* Pages where Chrome refuses to run content scripts. Worth naming explicitly
   * in the UI: without this the extension just appears broken on those tabs. */
  const BLOCKED = /^(chrome|edge|about|devtools|view-source|chrome-extension):|^https:\/\/chromewebstore\.google\.com|^https:\/\/chrome\.google\.com\/webstore/i;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function stat(label, value) {
    const row = el('div', 'stat');
    row.appendChild(el('span', null, label));
    row.appendChild(el('b', null, String(value)));
    return row;
  }

  async function currentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  async function render() {
    bodyEl.replaceChildren();

    const session = await AT.session.get();
    const tab = await currentTab();
    const blocked = tab && tab.url ? BLOCKED.test(tab.url) : false;
    const isFile = tab && tab.url ? /^file:/i.test(tab.url) : false;

    if (session && session.active) {
      const counts = await AT.session.counts();
      subEl.textContent = 'Session running since ' +
        new Date(session.startedAt).toLocaleTimeString();

      bodyEl.appendChild(stat('Annotating as', session.author || 'Unknown'));
      bodyEl.appendChild(stat('Pages', counts.pages));
      bodyEl.appendChild(stat('Annotations', counts.annotations));
      bodyEl.appendChild(stat('Screenshots', counts.shots));

      if (blocked) {
        bodyEl.appendChild(
          el('div', 'box warn',
             'This tab is a restricted Chrome page, so nothing can be ' +
             'annotated here. Other tabs are unaffected.')
        );
      } else if (isFile) {
        bodyEl.appendChild(
          el('div', 'box warn',
             'Local files need "Allow access to file URLs" enabled for this ' +
             'extension on chrome://extensions.')
        );
      }

      /* --- assistant bridge -------------------------------------------
       *
       * Per-origin and opt-in, because on a connected site ANY script on the
       * page can query the bridge - the assistant and the site's own code are
       * indistinguishable from inside. Read-only for the same reason, and the
       * list is cleared when the session ends.
       *
       * Only http(s): a chrome:// or extension page has no origin worth
       * connecting and no content script to answer with. */
      const origin = tab && tab.url && /^https?:/i.test(tab.url)
        ? new URL(tab.url).origin
        : null;

      const bridge = (await chrome.storage.local.get('at_bridge')).at_bridge
        || { origins: [] };
      const connected = origin && bridge.origins.indexOf(origin) > -1;

      const bridgeBox = el('div', 'box');
      const bridgeLabel = el('div', 'bridgehead', 'AI assistant');
      bridgeBox.appendChild(bridgeLabel);

      if (!origin) {
        bridgeBox.appendChild(el('div', 'bridgenote',
          'Open a normal web page to connect one.'));
      } else {
        bridgeBox.appendChild(el('div', 'bridgenote',
          connected
            ? 'Connected on ' + origin + ' — an assistant on this site can ' +
              'read your findings, and the page carries a copy for a local ' +
              'agent to pick up. Read-only. The toolbar shows a badge while ' +
              'it does.'
            : 'Let an assistant on ' + origin + ' read this session and your ' +
              'review bundle, and publish a copy into the page for a local ' +
              'agent. Read-only, this site only, until the session ends.'));

        const toggle = el('button', connected ? 'quiet' : 'blue',
          connected ? 'Disconnect ' + new URL(origin).host : 'Connect Claude in Chrome');
        toggle.addEventListener('click', async () => {
          toggle.disabled = true;
          const next = connected
            ? bridge.origins.filter((o) => o !== origin)
            : bridge.origins.concat([origin]);
          await chrome.storage.local.set({
            at_bridge: { origins: next, updatedAt: new Date().toISOString() }
          });
          // The content script is watching storage, so the tab in front of the
          // user starts (or stops) answering immediately - no reload.
          render();
        });
        bridgeBox.appendChild(toggle);
      }

      // Every connected site, so it is never a mystery which are listening.
      const others = bridge.origins.filter((o) => o !== origin);
      if (others.length) {
        bridgeBox.appendChild(el('div', 'bridgenote',
          'Also connected: ' + others.join(', ')));
      }
      bodyEl.appendChild(bridgeBox);

      const end = el('button', 'stop', 'End session & export');
      end.addEventListener('click', async () => {
        end.disabled = true;
        await AT.session.end();
        await chrome.runtime.sendMessage({ type: 'AT_OPEN_VIEWER' });
        window.close();
      });
      bodyEl.appendChild(end);

      const discard = el('button', 'quiet', 'Discard session');
      discard.addEventListener('click', async () => {
        // Deliberately a two-step confirm: this throws away work that exists
        // nowhere else, and the button sits right under "End session".
        if (discard.dataset.armed !== '1') {
          discard.dataset.armed = '1';
          discard.textContent = 'Really discard? Click again';
          discard.classList.add('warn');
          setTimeout(() => {
            discard.dataset.armed = '';
            discard.textContent = 'Discard session';
            discard.classList.remove('warn');
          }, 4000);
          return;
        }
        await AT.session.discard();
        render();
      });
      bodyEl.appendChild(discard);
      return;
    }

    // No active session. A closed-but-unexported session can still be reached.
    if (session && !session.active) {
      subEl.textContent = 'Last session ended, not yet exported.';
      const open = el('button', 'go', 'Open export view');
      open.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'AT_OPEN_VIEWER' });
        window.close();
      });
      bodyEl.appendChild(open);
    } else {
      subEl.textContent = 'No session running.';
      bodyEl.appendChild(
        el('div', 'box',
           'Start a session, then browse and mark up as many pages as you ' +
           'like. Everything exports together as one ZIP.')
      );
    }

    /* Identity. Asked for once, then shown as an editable line so it is never
     * a mystery whose name is going onto the annotations. */
    const identity = await AT.store.getIdentity();

    const nameRow = el('div', 'box');
    const nameLabel = el('label', null, identity ? 'Annotating as' : 'Your name');
    nameLabel.setAttribute('for', 'at-name');
    nameRow.appendChild(nameLabel);

    const nameInput = document.createElement('input');
    nameInput.id = 'at-name';
    nameInput.type = 'text';
    nameInput.maxLength = 60;
    nameInput.placeholder = 'e.g. Mark';
    nameInput.value = identity ? identity.name : '';
    nameRow.appendChild(nameInput);
    bodyEl.appendChild(nameRow);

    const start = el('button', 'go', 'Start session');
    start.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) {
        // Blocking rather than defaulting to "Unknown": the whole point of
        // capturing a name is that the bundle says who found each thing, and
        // a silent anonymous session defeats it.
        nameInput.focus();
        nameLabel.textContent = 'Please enter a name first';
        nameLabel.className = 'warn';
        return;
      }
      start.disabled = true;
      await AT.store.setIdentity(name);
      await AT.session.start(name);
      render();
    });
    bodyEl.appendChild(start);

    // Review mode is reachable with no session of your own, because the person
    // reviewing a bundle is usually not the person who made it.
    const review = el('button', null, 'Open a review bundle…');
    review.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'AT_OPEN_REVIEW' });
      window.close();
    });
    bodyEl.appendChild(review);

    const settings = el('button', 'quiet', 'Settings');
    settings.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
      window.close();
    });
    bodyEl.appendChild(settings);

    if (blocked) {
      bodyEl.appendChild(
        el('div', 'box warn',
           'Note: this tab is a restricted Chrome page and cannot be ' +
           'annotated. Switch to a normal page after starting.')
      );
    }
  }

  render();
})();
