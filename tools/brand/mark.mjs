/**
 * Help Me Breathe — the mark.
 *
 * Since 2026-09-29 the logo is the "b": an ink ring, a stem that rises from
 * the ring's left edge with a round cap, and a smaller teal ring inside. The
 * construction lives in B below (a 330 x 435 grid, rebuilt as exact geometry
 * from the owner's approved image, docs/private/brand/logo-b/). B_SMALL is
 * the same construction with heavier strokes for 16-32px, where the regular
 * weights smear.
 *
 * The older ring-with-a-gap helpers (ringPath, CANONICAL, ...) stay: the Open
 * Graph cards and pins still draw the large ring as a picture of the timer,
 * which is the product, not the logo. Every helper returns plain SVG source.
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
 * The "b" mark
 * ------------------------------------------------------------------ */

import { readFileSync } from 'node:fs';

/** Regular weight: every size from 40px up. */
export const B = { w: 330, h: 435, cx: 165, cy: 270, r: 145, stroke: 40, innerR: 70, innerStroke: 34, stemTop: 20 };
/** Small-size weight: favicons and anything under ~40px. */
export const B_SMALL = { w: 330, h: 435, cx: 165, cy: 270, r: 139, stroke: 56, innerR: 62, innerStroke: 46, stemTop: 28 };

/**
 * The mark's shapes, placed so the whole mark is `height` tall with its
 * top-left corner at (x, y). `ink` and `accent` may be colours or, for inline
 * page SVG, left out in favour of the given class names.
 */
export function bShapes({ x = 0, y = 0, height = B.h, ink, accent, geo = B, inkClass = '', accentClass = '' }) {
  const s = height / geo.h;
  const inkAttr = ink ? ` stroke="${ink}"` : '';
  const accAttr = accent ? ` stroke="${accent}"` : '';
  const ic = inkClass ? ` class="${inkClass}"` : '';
  const ac = accentClass ? ` class="${accentClass}"` : '';
  return `<g transform="translate(${round(x, 3)} ${round(y, 3)}) scale(${round(s, 5)})">` +
    `<circle${ic} cx="${geo.cx}" cy="${geo.cy}" r="${geo.r}" fill="none"${inkAttr} stroke-width="${geo.stroke}"/>` +
    `<path${ic} d="M${geo.cx - geo.r} ${geo.cy}V${geo.stemTop}" fill="none"${inkAttr} stroke-width="${geo.stroke}" stroke-linecap="round"/>` +
    `<circle${ac} cx="${geo.cx}" cy="${geo.cy}" r="${geo.innerR}" fill="none"${accAttr} stroke-width="${geo.innerStroke}"/></g>`;
}

/** Width of the mark at a given height. */
export const bWidth = (height, geo = B) => (geo.w / geo.h) * height;

/** A square document with the mark centred at `fill` of the height. */
export function bSquare({ size, ink, accent, fill = 0.94, geo = B, ground = null, rx = 0 }) {
  const h = size * fill;
  const x = (size - bWidth(h, geo)) / 2;
  const y = (size - h) / 2;
  const bg = ground ? `<rect width="${size}" height="${size}" rx="${round(rx, 2)}" fill="${ground}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Help Me Breathe">${bg}${bShapes({ x, y, height: h, ink, accent, geo })}</svg>`;
}

/* ------------------------------------------------------------------ *
 * Favicon
 * ------------------------------------------------------------------ */

/**
 * favicon.svg — the small-size mark, transparent ground. The colours follow
 * the browser chrome so the mark stays visible on a dark tab strip.
 */
export function faviconSvg({ day, night, accentDay, accentNight }) {
  const h = 32 * 0.94;
  const x = (32 - bWidth(h, B_SMALL)) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="Help Me Breathe">
  <title>Help Me Breathe</title>
  <style>
    .i { stroke: ${day}; } .a { stroke: ${accentDay}; }
    @media (prefers-color-scheme: dark) { .i { stroke: ${night}; } .a { stroke: ${accentNight}; } }
  </style>
  ${bShapes({ x, y: (32 - h) / 2, height: h, geo: B_SMALL, inkClass: 'i', accentClass: 'a' })}
</svg>
`;
}

/** Standalone favicon raster source at 16 or 32px. */
export function faviconDocument({ size, ink, accent }) {
  return bSquare({ size, ink, accent, geo: B_SMALL, fill: 0.94 });
}

/* ------------------------------------------------------------------ *
 * App icon
 * ------------------------------------------------------------------ */

/**
 * Maskable app icon: a mist tile with a 22% corner radius and the mark held
 * inside the central 80% safe zone (its height is 62% of the tile, so even
 * the stem's cap stays inside a circular mask).
 */
export function appIconSvg({ size, tile, ink, accent, radiusFraction = 0.22, squareTile = false }) {
  return bSquare({ size, ink, accent, fill: 0.62, ground: tile, rx: squareTile ? 0 : size * radiusFraction });
}

/* ------------------------------------------------------------------ *
 * Lockup
 * ------------------------------------------------------------------ */

const WORDMARK = JSON.parse(readFileSync(new URL('./wordmark.json', import.meta.url), 'utf8'));

/**
 * The wordmark as outlined paths, `size` px font size, baseline at (x, y).
 * Outlined because a standalone SVG cannot rely on Figtree being installed.
 */
export function wordmarkPath({ x, y, size, fill }) {
  const s = size / WORDMARK.unitsPerEm;
  return `<path transform="translate(${round(x, 3)} ${round(y, 3)}) scale(${round(s, 5)})" fill="${fill}" d="${WORDMARK.d}"/>`;
}
export const wordmarkWidth = (size) => (WORDMARK.advance / WORDMARK.unitsPerEm) * size;

/** Horizontal lockup geometry: mark 120 tall, wordmark 56px, gap 28. */
export const LOCKUP = (() => {
  const markH = 120;
  const fontSize = 56;
  const gap = 28;
  const markW = bWidth(markH);
  const textX = markW + gap;
  return { markH, markW, fontSize, gap, textX, baseline: round(markH * 0.8, 2), width: Math.ceil(textX + wordmarkWidth(fontSize) + 4), height: markH };
})();

/** images/logo.svg — the mark and the outlined wordmark. */
export function logoSvg({ ink, accent }) {
  const L = LOCKUP;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.width} ${L.height}" width="${L.width}" height="${L.height}" role="img" aria-label="Help Me Breathe">
  <title>Help Me Breathe</title>
  ${bShapes({ height: L.markH, ink, accent })}
  ${wordmarkPath({ x: L.textX, y: L.baseline, size: L.fontSize, fill: ink })}
</svg>
`;
}
