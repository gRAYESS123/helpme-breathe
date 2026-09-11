/**
 * Help Me Breathe — the mark.
 *
 * A ring with a single gap at twelve o'clock. Canonical geometry: radius 40 on
 * a 100-unit grid, stroke 9, butt caps, a 48deg gap centred at the top. That
 * yields exactly the path in docs/BRAND.md:
 *
 *   M66.27 13.46 A40 40 0 1 1 33.73 13.46
 *
 * Small sizes thicken the stroke and widen the gap so the opening survives a
 * single device pixel. Every helper below returns plain SVG source strings so
 * they can be written to disk or handed to a headless browser unchanged.
 */

const round = (n, p = 2) => {
  const v = Number(n.toFixed(p));
  return Object.is(v, -0) ? 0 : v;
};

/**
 * Arc path for a ring with a gap centred at twelve o'clock.
 * @param {number} cx centre x
 * @param {number} cy centre y
 * @param {number} r  radius (to the stroke centreline)
 * @param {number} gapDeg total angular width of the gap, in degrees
 */
export function ringPath(cx, cy, r, gapDeg, precision = 2) {
  const half = (gapDeg / 2) * (Math.PI / 180);
  const top = -Math.PI / 2;
  const start = top + half; // clockwise from the top edge of the gap
  const end = top - half;
  const sx = cx + r * Math.cos(start);
  const sy = cy + r * Math.sin(start);
  const ex = cx + r * Math.cos(end);
  const ey = cy + r * Math.sin(end);
  const largeArc = 360 - gapDeg > 180 ? 1 : 0;
  return `M${round(sx, precision)} ${round(sy, precision)} A${round(r, precision)} ${round(
    r,
    precision
  )} 0 ${largeArc} 1 ${round(ex, precision)} ${round(ey, precision)}`;
}

/** The canonical 100-grid geometry. */
export const CANONICAL = { grid: 100, cx: 50, cy: 50, r: 40, stroke: 9, gap: 48 };

/** Stroke-to-radius ratio of the canonical mark (9 / 40). Scaling by this
 *  keeps the ring's weight identical at any size. */
export const STROKE_RATIO = CANONICAL.stroke / CANONICAL.r;

export function canonicalPath() {
  return ringPath(CANONICAL.cx, CANONICAL.cy, CANONICAL.r, CANONICAL.gap);
}

/**
 * A ring sized to fit a square box of `size` units, with the given stroke as a
 * fraction of that box and the given gap.
 */
export function ringForBox({ size, strokeFraction, gapDeg, pad = 0 }) {
  const stroke = size * strokeFraction;
  const r = size / 2 - stroke / 2 - pad;
  return {
    cx: size / 2,
    cy: size / 2,
    r: round(r, 3),
    stroke: round(stroke, 3),
    gap: gapDeg,
    d: ringPath(size / 2, size / 2, r, gapDeg, 3),
  };
}

/** Ring markup only — no wrapper. */
export function ringMarkup(ring, color, extra = '') {
  return `<path d="${ring.d}" fill="none" stroke="${color}" stroke-width="${ring.stroke}" stroke-linecap="butt"${
    extra ? ' ' + extra : ''
  }/>`;
}

/* ------------------------------------------------------------------ *
 * Favicon
 * ------------------------------------------------------------------ */

/** 32px geometry: stroke 16% of the grid, gap 52deg. */
export const FAVICON_32 = ringForBox({ size: 32, strokeFraction: 0.16, gapDeg: 52, pad: 0.5 });
/** 16px geometry: stroke 20% of the grid, gap 56deg. */
export const FAVICON_16 = ringForBox({ size: 16, strokeFraction: 0.2, gapDeg: 56, pad: 0.25 });

/**
 * favicon.svg — written at the 32px geometry, ring only, transparent ground.
 * SVG has no way to swap geometry by rendered size, so the 16px deltas ship as
 * a separate raster (favicon-16.png). The colour, however, can respond to the
 * browser chrome, so it does.
 */
export function faviconSvg({ day, night }) {
  const r = FAVICON_32;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="Help Me Breathe">
  <title>Help Me Breathe</title>
  <style>
    .ring { stroke: ${day}; }
    @media (prefers-color-scheme: dark) { .ring { stroke: ${night}; } }
  </style>
  <path class="ring" d="${r.d}" fill="none" stroke="${day}" stroke-width="${r.stroke}" stroke-linecap="butt"/>
</svg>
`;
}

/** Standalone ring document, used to raster the two favicon PNGs. */
export function ringDocument({ size, ring, color }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  ${ringMarkup(ring, color)}
</svg>`;
}

/* ------------------------------------------------------------------ *
 * App icon
 * ------------------------------------------------------------------ */

/**
 * Maskable app icon: a green tile with a 22% corner radius and a paper ring
 * held inside the central 80% safe zone.
 */
export function appIconSvg({ size, tile, ring: ringColor, radiusFraction = 0.22, safeZone = 0.8, squareTile = false }) {
  const safeRadius = (size * safeZone) / 2;
  // r + stroke/2 <= safeRadius, with stroke = STROKE_RATIO * r
  const r = safeRadius / (1 + STROKE_RATIO / 2);
  const stroke = r * STROKE_RATIO;
  const ring = {
    r: round(r, 2),
    stroke: round(stroke, 2),
    d: ringPath(size / 2, size / 2, r, CANONICAL.gap, 2),
  };
  const rx = squareTile ? 0 : round(size * radiusFraction, 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Help Me Breathe">
  <rect width="${size}" height="${size}" rx="${rx}" fill="${tile}"/>
  ${ringMarkup(ring, ringColor)}
</svg>`;
}

/* ------------------------------------------------------------------ *
 * Lockup
 * ------------------------------------------------------------------ */

/**
 * Horizontal lockup geometry. Clear space on every side equals the ring stroke
 * times four, which is what sets the viewBox padding.
 */
export const LOCKUP = (() => {
  const r = 24;
  const stroke = round(r * STROKE_RATIO, 2); // 5.4
  const clear = stroke * 4; // 21.6
  const outer = r + stroke / 2; // 26.7
  const cy = 60;
  const cx = round(clear + outer, 2); // 48.3
  return {
    width: 480,
    height: 120,
    cx,
    cy,
    r,
    stroke,
    clear,
    outer,
    d: ringPath(cx, cy, r, CANONICAL.gap, 2),
    textX: round(cx + outer + clear, 2),
    baseline: 74,
    fontSize: 44,
    tracking: -0.012,
  };
})();

/**
 * images/logo.svg — ring plus a real <text> wordmark. A webfont cannot be
 * embedded in a standalone SVG that other sites may hotlink, so the wordmark
 * names Newsreader and falls back through the display stack. The outlined
 * raster (images/logo.png) is the one to use where the exact letterforms
 * matter.
 */
export function logoSvg({ ring: ringColor, ink, displayStack }) {
  const L = LOCKUP;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.width} ${L.height}" width="${L.width}" height="${L.height}" role="img" aria-label="Help Me Breathe">
  <title>Help Me Breathe</title>
  <path d="${L.d}" fill="none" stroke="${ringColor}" stroke-width="${L.stroke}" stroke-linecap="butt"/>
  <text x="${L.textX}" y="${L.baseline}" fill="${ink}" font-family="${displayStack.replace(/"/g, '&quot;')}" font-size="${L.fontSize}" font-weight="500" letter-spacing="${round(
    L.fontSize * L.tracking,
    3
  )}">Help Me Breathe</text>
</svg>
`;
}
