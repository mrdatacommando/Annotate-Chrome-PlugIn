/* Annotate Tool - content/overlay.js
 *
 * The on-page UI: a floating toolbar, the layer that annotations are drawn
 * into, and the tool arming/disarming state machine.
 *
 * ISOLATION: everything we render lives inside a CLOSED shadow root. Closed
 * rather than open so a page script poking at document.querySelector cannot
 * reach in and restyle or read our UI. The trade is that WE have to hold the
 * root reference ourselves - there is no host.shadowRoot to fall back on.
 *
 * COORDINATES: the annotation layer is position:absolute at the document
 * origin and every annotation is placed in DOCUMENT coordinates. That makes
 * scrolling completely free - no scroll handler, no repaint, no jitter, which
 * matters because scroll handlers on a page you do not control are the fastest
 * way to make a site feel broken. Only resize needs a reflow pass.
 *
 * CAVEAT: absolute positioning resolves against the initial containing block,
 * which sits at the document origin - unless <html> itself is positioned. That
 * is rare enough to accept; syncLayer() re-reads offsets on resize so the
 * damage would be a constant shift rather than drift.
 *
 * VISIBILITY: the toolbar only exists while a session is active. With
 * <all_urls> host permission this extension is present on every page the user
 * visits, so it must show absolutely nothing until they have explicitly opted
 * that browsing session in.
 */
(function () {
  'use strict';
  const AT = (window.AT = window.AT || {});

  const HOST_ID = 'at-overlay-host';
  const Z = 2147483000; // just under the int32 ceiling browsers clamp to

  let shadow = null;
  let host = null;
  let layer = null;
  let svg = null;
  let bar = null;
  let countEl = null;
  let aiEl = null;
  let cursorStyle = null;

  let armed = null; // id of the armed tool, or null
  let activeSession = false;
  let placed = new Map(); // annotation id -> { ann, nodes: [] }

  const COLORS = ['#f4c430', '#ff8a3d', '#ff5d5d', '#57c98a', '#4aa3f0', '#b07cff'];
  let currentColor = COLORS[0];

  // Window in which an existing auto-capture is reused rather than taking a
  // fresh one. Long enough to cover a burst of annotating, short enough that
  // a genuinely changed page gets its own image. See api.autoCapture.
  const AUTO_REUSE_MS = 4000;
  let lastAutoShot = null;

  /* --- styles ---------------------------------------------------------- */

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }

.layer {
  position: absolute; top: 0; left: 0;
  width: 0; height: 0;
  pointer-events: none;
}
/* The SVG must NOT take width/height from CSS. A CSS width overrides the
 * width ATTRIBUTE, so a zero width here collapses the viewport that the
 * viewBox maps into - scaling every arrow to nothing and drawing a blank
 * page. Its size is set inline by syncLayer() instead.
 * (Reminder: no backticks anywhere in this stylesheet - it is a JS template
 * literal and one would close it early.) */
.arrows {
  position: absolute; top: 0; left: 0;
  pointer-events: none; overflow: visible;
}

.bar {
  position: fixed; right: 16px; bottom: 16px;
  display: flex; align-items: center; gap: 2px;
  padding: 6px; border-radius: 12px;
  background: #1c1f26; color: #f2f4f8;
  box-shadow: 0 6px 24px rgba(0,0,0,.34), 0 0 0 1px rgba(255,255,255,.08);
  pointer-events: auto; user-select: none;
  font-size: 13px; line-height: 1;
}
.bar[hidden] { display: none !important; }
.bar.dragging { opacity: .82; }

.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 9px; border: 0; border-radius: 8px;
  background: transparent; color: inherit;
  font: inherit; cursor: pointer; white-space: nowrap;
}
.btn:hover { background: rgba(255,255,255,.10); }
.btn.on { background: #3b82f6; color: #fff; }
.btn.primary { background: #2f6f4f; color: #fff; }
.btn.primary:hover { background: #3a8a62; }
.btn svg { width: 15px; height: 15px; display: block; }

.grip { padding: 0 6px; cursor: grab; opacity: .45; font-size: 15px; }
.grip:active { cursor: grabbing; }
.sep { width: 1px; align-self: stretch; margin: 2px 5px; background: rgba(255,255,255,.15); }
.count { padding: 0 8px; opacity: .72; font-variant-numeric: tabular-nums; }

/* The AI-access badge. Deliberately not subtle: while it shows, this page can
 * read the session, and a reader should never have to go looking to find that
 * out. Hidden entirely when nothing is connected. */
.ai {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 8px; border-radius: 7px;
  background: rgba(74,222,128,.14); color: #86efac;
  box-shadow: inset 0 0 0 1px rgba(134,239,172,.34);
  font-size: 11px; letter-spacing: .02em; cursor: help;
}
.ai[hidden] { display: none !important; }
.ai .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #4ade80; flex: none;
}

.swatches { display: flex; gap: 3px; padding: 0 4px; }
.sw {
  width: 15px; height: 15px; border-radius: 50%;
  border: 2px solid transparent; cursor: pointer; padding: 0;
}
.sw.on { border-color: #fff; }

.toast {
  position: fixed; right: 16px; bottom: 74px;
  max-width: 320px; padding: 9px 13px; border-radius: 9px;
  background: #1c1f26; color: #f2f4f8;
  box-shadow: 0 6px 24px rgba(0,0,0,.34);
  font-size: 12.5px; line-height: 1.45;
  pointer-events: none; opacity: 0; transition: opacity .18s;
}
.toast.show { opacity: 1; }
.toast.warn { background: #6b3410; }

/* --- shared popover ------------------------------------------------- */
.pop {
  position: fixed; width: 250px; padding: 10px;
  border-radius: 10px; background: #1c1f26; color: #f2f4f8;
  box-shadow: 0 8px 28px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.08);
  pointer-events: auto; font-size: 13px;
}
.pop textarea {
  width: 100%; min-height: 68px; resize: vertical;
  padding: 7px; border-radius: 7px;
  border: 1px solid rgba(255,255,255,.16);
  background: #12151b; color: inherit; font: inherit;
}
.pop textarea:focus { outline: 2px solid #3b82f6; outline-offset: -1px; }
.pop .pop-quote {
  margin: 0 0 8px; padding: 6px 8px; border-radius: 6px;
  background: rgba(255,255,255,.06); font-size: 12px; line-height: 1.4;
  max-height: 76px; overflow: auto; opacity: .85;
}
.pop .pop-row { display: flex; gap: 6px; margin-top: 8px; }
.pop .pop-row .btn { flex: 0 0 auto; padding: 6px 10px; font-size: 12.5px; }
.pop .pop-row .spacer { flex: 1 1 auto; }
.pop .danger { color: #ff9a9a; }
.pop .danger:hover { background: rgba(255,90,90,.18); }

/* --- annotations on the page ---------------------------------------- */
.note {
  position: absolute; pointer-events: auto;
  max-width: 260px; min-width: 130px; min-height: 44px;
  padding: 8px 10px; border-radius: 3px;
  font-size: 13px; line-height: 1.4; color: #1a1a1a;
  box-shadow: 0 3px 10px rgba(0,0,0,.28);
  cursor: move; white-space: pre-wrap; overflow-wrap: anywhere;
}
/* An empty note shows no placeholder TEXT any more - the prompt moved to the
 * title tooltip so that a saved note can use the whole face to preview its
 * own content. The dashed edge is what says "nothing written here yet". */
.note.empty {
  box-shadow: 0 3px 10px rgba(0,0,0,.28), inset 0 0 0 2px rgba(0,0,0,.22);
}

/* An arrow's note, shown beside its tail. Without this an arrow carrying a
 * comment looks identical to one carrying nothing, and you would have to click
 * every arrow on the page to find out which is which. */
.arrow-label {
  position: absolute; pointer-events: auto; cursor: pointer;
  max-width: 240px; padding: 4px 9px; border-radius: 6px;
  font-size: 12px; line-height: 1.35;
  background: rgba(255,255,255,.97); color: #14171d;
  box-shadow: 0 0 0 2px var(--at-ring, #4aa3f0), 0 2px 8px rgba(0,0,0,.22);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* Box tool: a solid outline in the current colour, with the fill appearing
 * only on hover. Nothing sits between the reviewer and the content they are
 * framing until they point at it. color-mix keeps the wash tied to the same
 * custom property as the border, so the two can never drift apart. */
.abox {
  position: absolute; pointer-events: auto; cursor: pointer;
  border: 2px solid var(--at-line, #4aa3f0);
  border-radius: 4px;
  background: transparent;
  transition: background-color .12s ease;
}
.abox:hover {
  background: color-mix(in srgb, var(--at-line, #4aa3f0) 10%, transparent);
}

/* Region highlight: a translucent box over whatever it covers, so it works on
 * images, video posters, canvases and anything else that has no text to wrap. */
.region {
  position: absolute; pointer-events: auto;
  border: 2px solid; border-radius: 3px;
  cursor: pointer;
}
.unplaced { outline: 2px dashed #ff8a3d; outline-offset: 2px; }
`;

  /* --- helpers --------------------------------------------------------- */

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function icon(path) {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      path +
      '</svg>'
    );
  }

  const ICONS = {
    highlight: icon('<path d="M4 20h16"/><path d="M6 16l8.5-8.5a2.1 2.1 0 013 3L9 19H6z"/>'),
    note: icon('<path d="M4 4h16v11l-5 5H4z"/><path d="M20 15h-5v5"/>'),
    box: icon('<rect x="4" y="5" width="16" height="14" rx="2"/>'),
    arrow: icon('<path d="M5 19L19 5"/><path d="M12 5h7v7"/>'),
    shot: icon('<path d="M3 7h4l2-2h6l2 2h4v12H3z"/><circle cx="12" cy="13" r="3.5"/>'),
    end: icon('<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>')
  };

  /* Keeps the drawing layer the size of the document so SVG arrows spanning
   * the full page are not clipped. */
  function syncLayer() {
    const doc = document.documentElement;
    const w = Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0);
    const h = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0);
    if (svg) {
      // Inline styles, not just attributes - see the .arrows note in the CSS.
      // Kept 1:1 with the viewBox so annotation coordinates are plain document
      // pixels with no scaling factor to reason about.
      svg.style.width = w + 'px';
      svg.style.height = h + 'px';
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    }
  }

  /* --- toolbar --------------------------------------------------------- */

  function toolButton(id, label, iconSvg) {
    const b = el('button', 'btn');
    b.type = 'button';
    b.dataset.tool = id;
    b.title = label;
    b.innerHTML = iconSvg + '<span>' + label + '</span>';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = armed === id ? null : id;
      api.armTool(next);
      if (next && api.reportBlockedFrames) api.reportBlockedFrames();
    });
    return b;
  }

  function buildBar() {
    bar = el('div', 'bar');
    bar.hidden = true;

    const grip = el('span', 'grip', '⁙');
    grip.title = 'Drag to move';
    bar.appendChild(grip);
    makeDraggable(grip);

    ['highlight', 'note', 'box', 'arrow'].forEach((id) => {
      const tool = AT.tools && AT.tools[id];
      if (tool) bar.appendChild(toolButton(id, tool.label, ICONS[id]));
    });

    bar.appendChild(el('div', 'sep'));

    const swatches = el('div', 'swatches');
    COLORS.forEach((c) => {
      const s = el('button', 'sw' + (c === currentColor ? ' on' : ''));
      s.type = 'button';
      s.style.background = c;
      s.title = c;
      s.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        currentColor = c;
        swatches.querySelectorAll('.sw').forEach((n) => n.classList.remove('on'));
        s.classList.add('on');
      });
      swatches.appendChild(s);
    });
    bar.appendChild(swatches);

    bar.appendChild(el('div', 'sep'));

    const shotBtn = el('button', 'btn');
    shotBtn.type = 'button';
    shotBtn.title = 'Capture the visible area, annotations included';
    shotBtn.innerHTML = ICONS.shot + '<span>Shot</span>';
    shotBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      api.capture();
    });
    bar.appendChild(shotBtn);

    countEl = el('span', 'count', '0');
    bar.appendChild(countEl);

    /* Sits next to the count rather than anywhere else on the page: this is
     * the one piece of UI the user already watches while annotating, so it is
     * where a change in who can see their session will actually be noticed. */
    aiEl = el('span', 'ai');
    aiEl.hidden = true;
    aiEl.appendChild(el('span', 'dot'));
    aiEl.appendChild(el('span', 'ai-text', 'AI access'));
    bar.appendChild(aiEl);

    const endBtn = el('button', 'btn primary');
    endBtn.type = 'button';
    endBtn.title = 'End the session and open the export view';
    endBtn.innerHTML = ICONS.end + '<span>End &amp; Export</span>';
    endBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      api.endSession();
    });
    bar.appendChild(endBtn);

    return bar;
  }

  /* The toolbar sits over the page, so it will eventually cover the one thing
   * the user wants to annotate. Dragging is stored per-tab only - a remembered
   * position would be wrong on the next site's layout anyway. */
  function makeDraggable(handle) {
    let startX = 0;
    let startY = 0;
    let originRight = 16;
    let originBottom = 16;

    function onMove(e) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      bar.style.right = Math.max(4, originRight - dx) + 'px';
      bar.style.bottom = Math.max(4, originBottom - dy) + 'px';
    }
    function onUp() {
      bar.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
    }
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startY = e.clientY;
      originRight = parseInt(bar.style.right || '16', 10);
      originBottom = parseInt(bar.style.bottom || '16', 10);
      bar.classList.add('dragging');
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
    });
  }

  /* --- mount ----------------------------------------------------------- */

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText =
      'all:initial;position:absolute;top:0;left:0;width:0;height:0;' +
      'z-index:' + Z + ';pointer-events:none;';

    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'arrows');
    shadow.appendChild(svg);

    layer = el('div', 'layer');
    shadow.appendChild(layer);

    /* The toolbar is built ONLY in the top frame. Every frame needs its own
     * drawing layer - an annotation inside an iframe has to be positioned in
     * that frame's coordinate space - but a page with six iframes would
     * otherwise sprout six toolbars, most of them clipped inside a 300px box. */
    if (AT.session.IS_TOP) {
      shadow.appendChild(buildBar());
    }

    // documentElement rather than body: a page that replaces its own body
    // (SPA route change, some frameworks on hydration) would otherwise take
    // our UI with it.
    /* KEYSTROKES MUST NOT ESCAPE OUR UI.
     *
     * Keyboard events raised inside a CLOSED shadow root are retargeted to the
     * host element before anything outside sees them. Sites that bind
     * single-letter shortcuts guard them with something like
     *
     *     if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
     *
     * and that guard sees our host DIV, not the textarea the user is actually
     * typing in - so the page happily treats "n" as its own new/next shortcut
     * and calls preventDefault(). The letter never reaches the note.
     *
     * Stopping propagation at the shadow ROOT, in the bubble phase, fixes it:
     * the event still reaches our textarea (which is the target, below this
     * node) and is handled normally, but it never crosses into the page.
     *
     * Residual limit: a page listening in the CAPTURE phase on window or
     * document still sees the event first. Nothing can be done about that
     * without also blocking our own input, and it is far rarer than the
     * bubble-phase pattern above. */
    ['keydown', 'keypress', 'keyup', 'input', 'beforeinput'].forEach((type) => {
      shadow.addEventListener(type, (e) => e.stopPropagation());
    });

    document.documentElement.appendChild(host);
    syncLayer();
  }

  /* --- cursor ---------------------------------------------------------- */

  /* Shadow CSS cannot reach the page, so arming a tool needs one small style
   * element in the page itself. Removed the moment the tool is disarmed. */
  function setCursor(on) {
    if (on && !cursorStyle) {
      cursorStyle = document.createElement('style');
      cursorStyle.setAttribute('data-at-cursor', '1');
      cursorStyle.textContent = 'html, html * { cursor: crosshair !important; }';
      document.head.appendChild(cursorStyle);
    } else if (!on && cursorStyle) {
      cursorStyle.remove();
      cursorStyle = null;
    }
  }

  /* --- public API ------------------------------------------------------- */

  const api = {
    get shadow() { return shadow; },
    get layer() { return layer; },
    get svg() { return svg; },
    get color() { return currentColor; },
    get armed() { return armed; },
    COLORS,
    el,
    syncLayer,

    toast(message, kind) {
      if (!shadow) return;
      let t = shadow.querySelector('.toast');
      if (!t) {
        t = el('div', 'toast');
        shadow.appendChild(t);
      }
      t.className = 'toast' + (kind ? ' ' + kind : '');
      t.textContent = message;
      requestAnimationFrame(() => t.classList.add('show'));
      clearTimeout(t._timer);
      t._timer = setTimeout(() => t.classList.remove('show'), 2600);
    },

    /* Shows or hides the AI-access badge.
     *
     * This is the "confirm with the user" half of exposing session data to a
     * local agent. Consent is granted once, in the popup; this is what keeps
     * it honest afterwards, by making the state visible for as long as it
     * lasts rather than only at the moment it was agreed to.
     *
     * The tooltip carries the detail - which folder, whether a path was
     * typed - because the badge itself has room for two words. */
    setAiState(on, detail) {
      if (!aiEl) return; // subframe, or the bar is not built yet
      aiEl.hidden = !on;
      if (on) aiEl.title = detail || 'This page can read the current session.';
    },

    /* Arms a tool in THIS frame only. Cross-frame arming goes through
     * armEverywhere - see the note there. */
    armLocal(id) {
      if (armed && AT.tools[armed] && AT.tools[armed].disarm) {
        AT.tools[armed].disarm(api);
      }
      armed = id;
      setCursor(!!id);
      if (bar) {
        bar.querySelectorAll('.btn[data-tool]').forEach((b) => {
          b.classList.toggle('on', b.dataset.tool === id);
        });
      }
      if (id && AT.tools[id] && AT.tools[id].arm) AT.tools[id].arm(api);
    },

    /* The toolbar lives in the top frame, but a click the user makes may land
     * inside an iframe - whose events never reach the top document. So arming
     * has to reach every frame in the tab, via the service worker. Each frame
     * then listens for its own events locally. */
    armTool(id) {
      api.armLocal(id);
      try {
        chrome.runtime.sendMessage({
          type: 'AT_BROADCAST',
          state: { armed: id, color: currentColor, from: AT.session.FRAME_KEY }
        });
      } catch (_) {
        // Broadcast is an enhancement; this frame is already armed correctly.
      }
    },

    /* Hides our own chrome so it does not appear in a screenshot, runs `fn`,
     * then restores.
     *
     * Two nested rAFs, because one is not enough to guarantee the compositor
     * has actually painted the hidden state before the capture is taken.
     *
     * The setTimeout is NOT belt-and-braces - it is required. rAF is throttled
     * to zero in a background or hidden tab, so awaiting it alone would hang
     * the capture forever the moment the tab lost focus. Whichever fires first
     * wins; the timeout is long enough that the paint will normally have
     * happened anyway. */
    async withChromeHidden(fn) {
      /* Hides our CONTROLS but deliberately leaves the annotation layer
       * showing - the whole value of the screenshot is that the highlight,
       * note or arrow appears in it. The popover and toast are included
       * because an editor left open over the very thing being photographed is
       * the most likely way to ruin the shot. */
      /* `bar` is NULL in a subframe - the toolbar is only built in the top
       * frame. Reading bar.hidden unguarded threw a TypeError here, and
       * autoCapture swallows its errors, so every annotation made inside an
       * iframe silently got no screenshot at all. */
      const chrome_ = [bar, shadow.querySelector('.pop'), shadow.querySelector('.toast')]
        .filter(Boolean);
      const restore = chrome_.map((node) => ({ node, visibility: node.style.visibility }));
      chrome_.forEach((node) => { node.style.visibility = 'hidden'; });

      const wasHidden = bar ? bar.hidden : null;
      if (bar) bar.hidden = true;
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        requestAnimationFrame(() => requestAnimationFrame(finish));
        setTimeout(finish, 120);
      });
      try {
        return await fn();
      } finally {
        if (bar) bar.hidden = wasHidden;
        restore.forEach((r) => { r.node.style.visibility = r.visibility; });
      }
    },

    /* Gets the pixels, hiding whatever chrome is on screen first.
     *
     * captureVisibleTab photographs the whole TAB, not a frame - so when the
     * request comes from inside an iframe, hiding that frame's own popover is
     * not enough: the top frame's toolbar is also on screen and would land in
     * the picture. The capture is therefore delegated to the top frame, which
     * hides its own controls before taking it. The subframe still hides its
     * editor first, since that sits over the very thing being photographed. */
    async grabPixels() {
      if (!AT.session.IS_TOP) {
        const res = await chrome.runtime.sendMessage({ type: 'AT_CAPTURE_VIA_TOP' });
        if (!res || !res.ok) {
          throw new Error(res && res.error ? res.error : 'capture failed');
        }
        return res.dataUrl;
      }
      const res = await chrome.runtime.sendMessage({ type: 'AT_CAPTURE' });
      if (!res || !res.ok) {
        throw new Error(res && res.error ? res.error : 'capture failed');
      }
      return res.dataUrl;
    },

    /* Captures the viewport for one annotation, so every item in a review has
     * a picture rather than bare text.
     *
     * Best-effort by design: annotating must never block or fail because a
     * screenshot could not be taken, so everything here is swallowed.
     *
     * COALESCING matters more than it looks. Chrome rate-limits
     * captureVisibleTab to roughly two per second, so marking up five things
     * in quick succession would otherwise queue three seconds of captures and
     * store five near-identical images. If the last shot was recent and the
     * page has not scrolled, that image is still an accurate picture of the
     * viewport, so it is reused for the new annotation instead. */
    async autoCapture(annId) {
      if (!annId) return;
      try {
        const now = Date.now();
        if (
          lastAutoShot &&
          now - lastAutoShot.at < AUTO_REUSE_MS &&
          lastAutoShot.x === window.scrollX &&
          lastAutoShot.y === window.scrollY &&
          lastAutoShot.url === location.href
        ) {
          await AT.session.attachShot(annId, lastAutoShot.id);
          return;
        }

        const dataUrl = await api.withChromeHidden(() => api.grabPixels());

        const id = AT.session.newId('shot');
        await AT.store.putShot(id, dataUrl);
        await AT.session.addShot({ id, auto: true });
        await AT.session.attachShot(annId, id);

        lastAutoShot = {
          id: id,
          at: Date.now(),
          x: window.scrollX,
          y: window.scrollY,
          url: location.href
        };
      } catch (_) {
        // Silent: a page that forbids capture (or a throttle burst) must not
        // interrupt the annotation the user just made.
      }
    },

    async capture() {
      try {
        const dataUrl = await api.withChromeHidden(() => api.grabPixels());
        const id = AT.session.newId('shot');
        await AT.store.putShot(id, dataUrl);
        await AT.session.addShot({ id, note: '' });
        await api.refreshCount();
        api.toast('Screenshot captured');
      } catch (e) {
        api.toast('Could not capture: ' + e.message, 'warn');
      }
    },

    async endSession() {
      await AT.session.end();
      await chrome.runtime.sendMessage({ type: 'AT_OPEN_VIEWER' });
    },

    async refreshCount() {
      const c = await AT.session.counts();
      if (countEl) {
        countEl.textContent = String(c.annotations + c.shots);
        countEl.title =
          c.annotations + ' annotation(s), ' + c.shots + ' screenshot(s), across ' +
          c.pages + ' page(s)';
      }
    },

    /* Draws every stored annotation for this URL. Anything whose anchor can no
     * longer be resolved is marked unplaced rather than dropped, and the user
     * is told once - silently losing their notes would be far worse. */
    async restoreAll() {
      const anns = await AT.session.annotationsForPage();
      let lost = 0;
      for (const ann of anns) {
        const tool = AT.tools[ann.type];
        if (!tool || !tool.place) continue;
        let ok = false;
        try {
          ok = tool.place(ann, api);
        } catch (_) {
          ok = false;
        }
        if (!ok) {
          lost++;
          if (!ann.unplaced) await AT.session.updateAnnotation(ann.id, { unplaced: true });
        } else if (ann.unplaced) {
          await AT.session.updateAnnotation(ann.id, { unplaced: false });
        }
      }
      if (lost) {
        api.toast(
          lost + ' annotation' + (lost > 1 ? 's' : '') +
            ' could not be re-placed on this page. The content is safe and will ' +
            'still be exported.',
          'warn'
        );
      }
      await api.refreshCount();
    },

    /* A single shared popover, used by every tool for editing and deleting.
     * Shared rather than per-tool so that opening one always closes the last -
     * two stacked editors over a page you are reviewing is disorienting.
     * Positioned in fixed coordinates and clamped to the viewport, because a
     * popover anchored near the page edge would otherwise open off-screen. */
    /* `build` receives (pop, close, onClose). Calling onClose(fn) registers
     * something to run once the popover is off the screen - used by the tools
     * to take their screenshot after the editor is gone rather than over it. */
    popover(clientX, clientY, build) {
      api.closePopover();
      const pop = el('div', 'pop');
      build(pop, () => api.closePopover(), (fn) => { pop._onClose = fn; });

      pop.style.visibility = 'hidden';
      shadow.appendChild(pop);

      const w = pop.offsetWidth || 240;
      const h = pop.offsetHeight || 140;
      const x = Math.min(Math.max(8, clientX), window.innerWidth - w - 8);
      const y = Math.min(Math.max(8, clientY), window.innerHeight - h - 8);
      pop.style.left = x + 'px';
      pop.style.top = y + 'px';
      pop.style.visibility = '';

      /* Close on an outside click. Deferred by a tick so the click that opened
       * this popover does not immediately close it again.
       *
       * TWO listeners, and the reason is subtle enough to be worth stating:
       * events raised inside a CLOSED shadow root are RETARGETED to the host
       * before anything outside the tree sees them. A window listener asking
       * `pop.contains(e.target)` therefore always sees #at-overlay-host and
       * never the button - so it judged every click on Save or Delete to be
       * "outside" and tore the popover down on mousedown, before the button's
       * click event could run. Edits were silently discarded.
       *
       * Outside the tree we can only ask "did this come from our host at all";
       * inside the tree targets are not retargeted, so the shadow-level
       * listener can tell the popover apart from the rest of our chrome and
       * still close it when the toolbar is clicked. */
      setTimeout(() => {
        const onOutside = (e) => {
          if (e.target === host) return; // ours - let the shadow listener judge
          api.closePopover();
        };
        const onInside = (e) => {
          if (!pop.contains(e.target)) api.closePopover();
        };
        window.addEventListener('mousedown', onOutside, true);
        shadow.addEventListener('mousedown', onInside, true);
        pop._onOutside = onOutside;
        pop._onInside = onInside;
      }, 0);

      return pop;
    },

    closePopover() {
      if (!shadow) return;
      const existing = shadow.querySelector('.pop');
      if (existing) {
        if (existing._onOutside) {
          window.removeEventListener('mousedown', existing._onOutside, true);
        }
        if (existing._onInside) {
          shadow.removeEventListener('mousedown', existing._onInside, true);
        }
        /* Read and cleared BEFORE the callback runs. A tool uses this to take
         * a screenshot once the editor is gone, and that screenshot path can
         * close a popover itself - without clearing first, that would re-enter
         * here and fire the same callback again. */
        const after = existing._onClose;
        existing._onClose = null;
        existing.remove();
        if (after) {
          /* Deferred past a paint so the name is honest: the callback runs
           * when the popover is off the SCREEN, not merely out of the tree.
           *
           * The timeout is not belt-and-braces. requestAnimationFrame does not
           * fire in a tab that is not being painted - a backgrounded tab, or a
           * headless browser - so a bare double-rAF silently never runs. That
           * is precisely how this was caught: the regression test saw the
           * editor close and no screenshot ever taken. withChromeHidden()
           * guards the same way for the same reason. */
          let ran = false;
          const once = () => {
            if (ran) return;
            ran = true;
            after();
          };
          requestAnimationFrame(() => requestAnimationFrame(once));
          setTimeout(once, 120);
        }
      }
    },

    track(ann, nodes) {
      placed.set(ann.id, { ann, nodes: nodes });
    },

    untrack(id) {
      const rec = placed.get(id);
      if (!rec) return;
      // Text highlights live in the PAGE's DOM, not in our layer, so removing
      // our own nodes is not enough to undo them. The tool's own remove() hook
      // is what puts the page back as it was found.
      const tool = AT.tools[rec.ann.type];
      if (tool && tool.remove) {
        try {
          tool.remove(rec.ann, api);
        } catch (_) {
          /* a half-removed annotation must not block the rest of teardown */
        }
      }
      rec.nodes.forEach((n) => n.remove && n.remove());
      placed.delete(id);
    },

    async setActive(on) {
      activeSession = on;
      if (bar) bar.hidden = !on;
      if (!on) {
        api.armLocal(null);
        placed.forEach((_, id) => api.untrack(id));
        placed.clear();
      }
    },

    get isActive() { return activeSession; }
  };

  AT.overlay = api;

  /* --- boot ------------------------------------------------------------- */

  async function boot() {
    // Never mount on our own extension pages.
    if (location.protocol === 'chrome-extension:') return;

    mount();

    const active = await AT.session.isActive();
    await api.setActive(active);
    if (active) await api.restoreAll();

    // Cross-tab sync: starting a session from the popup in one tab must light
    // up the toolbar in every other open tab too.
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'local' || !changes[AT.store.SESSION_KEY]) return;
      const next = changes[AT.store.SESSION_KEY].newValue;
      const nowActive = !!(next && next.active);
      if (nowActive !== activeSession) {
        await api.setActive(nowActive);
        if (nowActive) await api.restoreAll();
      } else if (nowActive) {
        await api.refreshCount();
      }
    });

    /* Captures on behalf of a subframe. Only the top frame answers, because
     * only the top frame's toolbar is on screen - a subframe hiding its own
     * chrome cannot hide ours. */
    if (AT.session.IS_TOP) {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || msg.type !== 'AT_CAPTURE_FOR_FRAME') return;
        api.withChromeHidden(() =>
          chrome.runtime.sendMessage({ type: 'AT_CAPTURE' })
        )
          .then((res) => sendResponse(res || { ok: false, error: 'no pixels' }))
          .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
        return true; // async reply
      });
    }

    /* Arming broadcast from the top frame's toolbar. Every frame - including
     * the one that sent it - gets this; the sender skips it so it does not
     * re-arm itself and lose the tool's own setup. */
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'AT_UI_STATE' || !msg.state) return;
      if (msg.state.from === AT.session.FRAME_KEY) return;
      if (msg.state.color) currentColor = msg.state.color;
      if (activeSession) api.armLocal(msg.state.armed || null);
    });

    /* Tells the user which frames on this page can never be annotated, rather
     * than leaving them clicking at something that will not respond. Only the
     * top frame reports, and only once per arming. */
    if (AT.session.IS_TOP) {
      api.reportBlockedFrames = function () {
        const sandboxed = Array.from(document.querySelectorAll('iframe[sandbox]'))
          .filter((f) => {
            const s = f.getAttribute('sandbox') || '';
            return s.indexOf('allow-scripts') < 0;
          });
        const pdfs = document.querySelectorAll(
          'embed[type="application/pdf"], object[type="application/pdf"]');
        const blocked = sandboxed.length + pdfs.length;
        if (blocked) {
          api.toast(
            blocked + ' embedded ' + (blocked > 1 ? 'frames' : 'frame') +
            ' on this page cannot be annotated (sandboxed or PDF). Use a ' +
            'region highlight or a screenshot over ' +
            (blocked > 1 ? 'them' : 'it') + ' instead.',
            'warn'
          );
        }
      };
    }

    window.addEventListener('resize', () => {
      syncLayer();
      // Point anchors are element-relative, so a reflow moves them. Cheapest
      // correct response is to redraw from stored anchors.
      if (activeSession) {
        placed.forEach((_, id) => api.untrack(id));
        api.restoreAll();
      }
    });

    window.addEventListener(
      'keydown',
      (e) => {
        if (!activeSession) return;
        if (e.key !== 'Escape') return;
        /* Escape closes an open editor first, and only disarms the tool once
         * there is nothing to close. Registered on window in the CAPTURE
         * phase, so it still runs even though the shadow root stops keys from
         * bubbling out of our UI. */
        if (shadow && shadow.querySelector('.pop')) {
          api.closePopover();
          e.preventDefault();
        } else if (armed) {
          api.armTool(null);
          e.preventDefault();
        }
      },
      true
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
