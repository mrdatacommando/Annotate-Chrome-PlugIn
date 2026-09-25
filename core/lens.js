/* Annotate Tool - Copyright (C) 2026 Mark Van de Velde
 * SPDX-License-Identifier: GPL-3.0-only
 * This program comes with ABSOLUTELY NO WARRANTY. See LICENSE for terms.
 */
/* Annotate Tool - core/lens.js
 *
 * Geometry for the review page's magnifier.
 *
 * Pure arithmetic, in its own module, because this is the part most likely to
 * be subtly wrong and the hardest to eyeball: a lens that is off by a fraction
 * still looks plausible while showing you the wrong part of the picture. The
 * invariant it must hold is simple to state and easy to assert - whatever sits
 * under the cursor must appear at the CENTRE of the lens - so it is worth
 * having somewhere a test can reach. See tests/lens.html.
 *
 * Percentages throughout are of the image's NATURAL size, the same meaning the
 * 100% view uses, so "120%" is 1.2x the image's own pixels rather than 1.2x
 * whatever the column happened to scale it down to.
 */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;
  const AT = (root.AT = root.AT || {});

  AT.lens = {
    SIZE: 200,   // diameter of the glass, px
    ZOOM: 1.2,   // 120% of the image's natural size

    /* o: { mx, my }   cursor, relative to the displayed image's top-left
     *    { dw, dh }   displayed size of the image
     *    { nw, nh }   natural size of the image
     *    { size }     lens diameter, { zoom } magnification
     *
     * returns the lens box position and the background-image placement that
     * puts the point under the cursor dead centre in the glass.
     */
    compute(o) {
      const size = o.size || AT.lens.SIZE;
      const zoom = o.zoom || AT.lens.ZOOM;

      // The magnified image, in px. background-size is set to this.
      const bgW = o.nw * zoom;
      const bgH = o.nh * zoom;

      // Where the cursor sits in the image, 0..1. Guarded because a zero
      // displayed size (an image not laid out yet) would divide by zero and
      // poison every downstream number with NaN.
      const fx = o.dw ? o.mx / o.dw : 0;
      const fy = o.dh ? o.my / o.dh : 0;

      return {
        // Lens centred on the cursor.
        left: o.mx - size / 2,
        top: o.my - size / 2,
        bgW: bgW,
        bgH: bgH,
        // Shift the magnified image so (fx, fy) lands at the lens centre.
        bgX: size / 2 - fx * bgW,
        bgY: size / 2 - fy * bgH
      };
    },

    /* Where to scroll the 100% view so a chosen point sits in the middle of
     * the frame.
     *
     * Without this, switching to 100% lands at the top-left corner and throws
     * away the one piece of information the click carried - which part the
     * reader wanted to see. On a 3000px-wide capture that means hunting with
     * scrollbars for the thing you just pointed at.
     *
     * o: { fx, fy }  the point of interest, as fractions of the image (0..1)
     *    { nw, nh }  the image at 100%
     *    { cw, ch }  the visible frame
     *
     * Clamped, so a point near an edge scrolls as far as it can and stops
     * rather than asking for a negative offset the browser would ignore
     * silently. An image smaller than its frame yields 0, not a negative. */
    focusScroll(o) {
      const maxLeft = Math.max(0, o.nw - o.cw);
      const maxTop = Math.max(0, o.nh - o.ch);
      return {
        left: Math.max(0, Math.min(maxLeft, o.fx * o.nw - o.cw / 2)),
        top: Math.max(0, Math.min(maxTop, o.fy * o.nh - o.ch / 2))
      };
    },

    /* Where the 100% view should open for a given annotation: the middle of
     * its pin.
     *
     * This is what makes stepping through a review at 100% useful - each item
     * arrives showing the thing it is about, rather than whatever corner or
     * previous position the scroll happened to be left at.
     *
     * Pins are expressed in PERCENTAGES of the image (that is how they are
     * positioned in CSS), so they are converted to the 0..1 fractions the
     * scrolling maths works in. With no pin - a framed annotation, or an older
     * bundle with no recorded rect - the middle of the image is the honest
     * default: a corner is not more informative, just further from anything.
     */
    pinCentre(pin) {
      if (!pin) return { fx: 0.5, fy: 0.5 };
      return {
        fx: (pin.left + pin.width / 2) / 100,
        fy: (pin.top + pin.height / 2) / 100
      };
    },

    /* The height the frame occupies while showing the FITTED image.
     *
     * Switching to 100% must not move anything else on the page, so the frame
     * keeps this exact footprint and becomes a scrollable window into a much
     * larger image. Computed rather than measured, because once the 100% view
     * is open the fitted layout no longer exists to measure - and measuring
     * then would pick up the scrollbar and drift.
     *
     * o: { boxW }   the frame's border-box width
     *    { nw, nh } the image's natural size
     *    { border } total border thickness across both edges
     */
    fittedBoxHeight(o) {
      const border = o.border || 0;
      if (!o.nw || !o.nh) return 0;
      const contentW = Math.max(0, o.boxW - border);
      // max-width:100% shrinks a wide image to fit but never stretches a
      // narrow one, so the displayed width is whichever is smaller.
      const shownW = Math.min(contentW, o.nw);
      return shownW * (o.nh / o.nw) + border;
    },

    /* The inverse of focusScroll: which part of the image is currently in the
     * middle of the frame. Used after a pan, so that leaving the 100% view and
     * returning lands where the reader left off rather than back at the point
     * they originally clicked. */
    centreOf(o) {
      return {
        fx: o.nw ? (o.scrollLeft + o.cw / 2) / o.nw : 0,
        fy: o.nh ? (o.scrollTop + o.ch / 2) / o.nh : 0
      };
    },

    /* Which fraction of the image is showing at the centre of the glass.
     * Exists so a test can assert the invariant directly rather than
     * re-deriving the same arithmetic it is meant to be checking. */
    centreFraction(lensBox, size) {
      const s = size || AT.lens.SIZE;
      return {
        x: lensBox.bgW ? (s / 2 - lensBox.bgX) / lensBox.bgW : 0,
        y: lensBox.bgH ? (s / 2 - lensBox.bgY) / lensBox.bgH : 0
      };
    }
  };
})();
