/* Annotate Tool - tools/note.js
 *
 * Sticky note: a coloured block of text pinned to a spot on the page.
 * All behaviour comes from core/box-tool.js; this file only describes how a
 * note differs from a text box.
 */
(function () {
  'use strict';
  const AT = (window.AT = window.AT || {});
  AT.tools = AT.tools || {};

  AT.tools.note = AT.makeBoxTool({
    id: 'note',
    label: 'Note',
    className: 'note',
    placeholder: 'What should someone know about this?',
    hint: 'Click anywhere on the page to drop a sticky note. Esc to stop.',

    /* The note IS the colour, so the swatch fills the background. Text is
     * forced dark because every swatch in the palette is a light, saturated
     * sticky-note colour - inheriting the page's text colour would give white
     * on yellow on a dark-themed site. */
    styleFor(ann) {
      return {
        background: ann.color,
        color: '#1a1a1a'
      };
    }
  });
})();
