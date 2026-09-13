/**
 * Help Me Breathe — "Lantern" brand tokens.
 *
 * The single source of truth for every generated brand asset (favicons, app
 * icons, the lockup, Open Graph cards, Pinterest pins). These values mirror
 * docs/BRAND.md; if the two ever disagree, docs/BRAND.md wins and this file
 * must be corrected, not the other way round.
 *
 * Nothing here defines a colour that does not also exist as a site token.
 */

/* ------------------------------------------------------------------ *
 * Day tokens — the one brand palette
 * ------------------------------------------------------------------ */
export const DAY = {
  paper: '#F4F6F5', // page ground — mist
  leaf: '#FFFFFF', // surface: cards
  ink: '#0F1B1E', // text, and the mark
  graphite: '#5C6B6E', // muted text
  rule: '#DDE3E1', // hairline between rows
  edge: '#DDE3E1', // legacy alias: nothing has a control outline any more
  track: '#EAEEEC', // wells
  green: '#1E5F5A', // links
  chalk: '#F7F8F7', // ink on a primary button
  clay: '#0F1B1E', // legacy alias: the price is ink now
  ok: '#1F6B4B',
  warn: '#8A5A0A',
  bad: '#B23A2E',
};

/* ------------------------------------------------------------------ *
 * Night tokens
 * ------------------------------------------------------------------ */
export const NIGHT = {
  paper: '#0F1620',
  leaf: '#182430',
  ink: '#EEF2F0',
  graphite: '#9DB0B3',
  rule: '#24343A',
  edge: '#24343A',
  track: '#1F2D3A',
  green: '#8FD3C4',
  chalk: '#0F1620',
  clay: '#EEF2F0',
  ok: '#6FCB9B',
  warn: '#E5B96A',
  bad: '#F09A8E',
};

/* ------------------------------------------------------------------ *
 * Technique accents — a RIM/FILL pair per technique.
 *
 * The rim is the working colour: it carries every text and control duty and
 * clears 5.3:1 on --paper. The fill is decoration only — the circle interior,
 * roughly L* 78-83, about 1.5:1 on paper, never a boundary.
 *
 * `box` was re-hued away from the concept board's #1C5140, which read as a
 * near-twin of the primary green. The replacement is the mulberry #6E3C69.
 *
 * THIS TABLE MIRRORS css/styles.css. docs/BRAND.md section 2 and
 * css/styles.css are the source of truth; if they move, move these values to
 * match rather than the other way round. The separation audit below runs in
 * HSL, which is not perceptually uniform — BRAND.md quotes the CIELAB LCh
 * numbers, which are the ones a rim is actually chosen on.
 * ------------------------------------------------------------------ */
export const TECHNIQUE_ORDER = ['478', 'box', 'coherent', 'sigh', 'extended', 'triangle', 'wim'];

/* Lantern: `rim` is the pattern's deep tone (the gauge, the active chip);
 * `fill` is the orb. 4-7-8 dims the room to dusk, so its working colour is
 * the moonlight orb itself. At night every rim lightens to its orb. */
export const ACCENTS = {
  478: { rim: '#1F2745', fill: '#C3C9E6', hue: 229.0, nightRim: '#C3C9E6', label: '4-7-8' },
  box: { rim: '#5B4A5E', fill: '#D6C7D7', hue: 291.0, nightRim: '#D6C7D7', label: 'Box' },
  coherent: { rim: '#7A4A52', fill: '#E3CACC', hue: 350.0, nightRim: '#E3CACC', label: 'Coherence' },
  sigh: { rim: '#2F5F66', fill: '#C6DCDE', hue: 187.6, nightRim: '#C6DCDE', label: 'Cyclic sighing' },
  extended: { rim: '#7A5F34', fill: '#E4D6BC', hue: 36.9, nightRim: '#E4D6BC', label: 'Extended exhale' },
  triangle: { rim: '#3E5670', fill: '#C9D5E2', hue: 211.2, nightRim: '#C9D5E2', label: 'Triangle' },
  wim: { rim: '#8A4E38', fill: '#E8CCBB', hue: 16.1, nightRim: '#E8CCBB', label: 'Energizing' },
};

/** The night fill collapses to one dark value — a dark ground cannot carry
 *  seven distinguishable tints, so the rim carries the hue instead. */
export const NIGHT_FILL = NIGHT.leaf;

/** Themes a manifest entry may name. `neutral` is for legal and policy pages:
 *  no technique owns them, so the ink/graphite pair stands in. */
export function accentFor(theme) {
  if (theme && ACCENTS[theme]) return ACCENTS[theme];
  return { rim: DAY.green, fill: DAY.track, hue: 155.5, nightRim: NIGHT.green, label: 'Help Me Breathe' };
}

/* ------------------------------------------------------------------ *
 * Type
 * ------------------------------------------------------------------ */
export const FONT_CSS_URL =
  'https://fonts.googleapis.com/css2?family=Figtree:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap';

export const DISPLAY_STACK =
  "'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
export const UI_STACK =
  "'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
export const MONO_STACK =
  "'DM Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Fallback-only stacks, used inside images/logo.svg where no webfont can be
 *  loaded. Kept identical to the site stacks minus the webfont name only when
 *  a renderer cannot supply Newsreader. */
export const SITE_LABEL = 'HELPMEBREATH.COM';

/* ------------------------------------------------------------------ *
 * Small colour helpers — used to verify the palette at build time.
 * ------------------------------------------------------------------ */
const toRgb = (h) => {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const channel = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

export function luminance(hex) {
  const [r, g, b] = toRgb(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export function hueOf(hex) {
  const [r, g, b] = toRgb(hex).map((v) => v / 255);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  if (!d) return 0;
  let h;
  if (mx === r) h = 60 * (((g - b) / d) % 6);
  else if (mx === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  return (h + 360) % 360;
}

export function lstar(hex) {
  const y = luminance(hex);
  return y > 0.008856 ? 116 * Math.pow(y, 1 / 3) - 16 : 903.3 * y;
}
