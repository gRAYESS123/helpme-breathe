/**
 * Help Me Breathe — "Paper and Ink" brand tokens.
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
  paper: '#F5F1E8', // page ground — warm leaflet stock
  leaf: '#FFFDF7', // surface: cards, panels, header
  ink: '#1C2320', // text
  graphite: '#575F58', // muted text
  rule: '#E3DCCC', // decorative hairline ONLY
  edge: '#83887E', // control outlines
  track: '#DFD8C7', // progress trough, input wells
  green: '#0F5136', // primary
  chalk: '#FFFFFF', // ink on primary
  clay: '#8A4B24', // commerce accent — paid surfaces only
  ok: '#1B6B45',
  warn: '#7E5406',
  bad: '#A32721',
};

/* ------------------------------------------------------------------ *
 * Night tokens
 * ------------------------------------------------------------------ */
export const NIGHT = {
  paper: '#15191A',
  leaf: '#1E2426',
  ink: '#EDE7DA',
  graphite: '#A7AEA4',
  rule: '#2E3536',
  edge: '#767D77',
  track: '#2B3233',
  green: '#5FBF92',
  chalk: '#15191A',
  clay: '#D9A279',
  ok: '#6FCB9B',
  warn: '#E0B25C',
  bad: '#F0918A',
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

export const ACCENTS = {
  478: { rim: '#33407F', fill: '#C5C5E0', hue: 229.7, nightRim: '#93A2E8', label: '4-7-8' },
  box: { rim: '#6E3C69', fill: '#DABFD6', hue: 306.0, nightRim: '#D59CCB', label: 'Box' },
  coherent: { rim: '#8C2F49', fill: '#E5BDC4', hue: 343.2, nightRim: '#F2909F', label: 'Coherence' },
  sigh: { rim: '#125A62', fill: '#A2CFD5', hue: 186.0, nightRim: '#5FC7D1', label: 'Cyclic sighing' },
  extended: { rim: '#7A5310', fill: '#D8C4AD', hue: 37.9, nightRim: '#E0B25C', label: 'Extended exhale' },
  triangle: { rim: '#2C5273', fill: '#B5C9E2', hue: 207.9, nightRim: '#8FBBE3', label: 'Triangle' },
  wim: { rim: '#993A20', fill: '#E4BFB4', hue: 12.9, nightRim: '#F0916B', label: 'Energizing' },
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
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&display=swap';

export const DISPLAY_STACK =
  "'Newsreader', ui-serif, Georgia, 'Times New Roman', serif";
export const UI_STACK =
  "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

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
