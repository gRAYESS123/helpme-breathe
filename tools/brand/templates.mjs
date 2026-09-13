/**
 * Help Me Breathe — HTML templates for the rendered brand assets.
 *
 * Everything here is plain HTML + CSS rendered by headless Chromium so the
 * real Newsreader and IBM Plex Sans letterforms land in the raster. No
 * gradients, no blur, no glow, no shadow, no emoji — the printed-page rules
 * apply to the social cards exactly as they do to the site.
 */

import { DAY, FONT_CSS_URL, DISPLAY_STACK, UI_STACK, SITE_LABEL, TECHNIQUE_ORDER, ACCENTS, accentFor } from './tokens.mjs';
import { ringPath, STROKE_RATIO, CANONICAL } from './mark.mjs';

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const round = (n, p = 2) => Number(n.toFixed(p));

function head(extraCss) {
  return `<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONT_CSS_URL}">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body { -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }
  .display { font-family: ${DISPLAY_STACK}; }
  .ui { font-family: ${UI_STACK}; }
${extraCss}
</style>`;
}

/** A ring sized to a given radius, as a standalone inline SVG block. */
function ringSvg({ r, color, gap = CANONICAL.gap }) {
  const stroke = r * STROKE_RATIO;
  const box = (r + stroke / 2) * 2;
  const d = ringPath(box / 2, box / 2, r, gap, 2);
  return `<svg width="${round(box)}" height="${round(box)}" viewBox="0 0 ${round(box)} ${round(
    box
  )}" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="${round(
    stroke
  )}" stroke-linecap="butt"/></svg>`;
}

/** The seven technique rims laid end to end — the site's table of contents. */
function signatureStrip({ x, y, width, active, base = 6, tall = 11 }) {
  const n = TECHNIQUE_ORDER.length;
  const gap = 4;
  const cell = (width - gap * (n - 1)) / n;
  const bars = TECHNIQUE_ORDER.map((key, i) => {
    const on = key === active;
    const h = on ? tall : base;
    const left = round(x + i * (cell + gap));
    return `<i style="position:absolute;left:${left}px;top:${round(
      y + (base - h)
    )}px;width:${round(cell)}px;height:${h}px;background:${ACCENTS[key].rim}"></i>`;
  }).join('');
  return `<div style="position:absolute;left:0;top:0">${bars}</div>`;
}

/** Small lockup used in the corner of every card. */
function lockup({ x, y, size, ringColor, ink }) {
  const r = size / 2;
  const stroke = r * STROKE_RATIO;
  return `<div style="position:absolute;left:${x}px;top:${y}px;display:flex;align-items:center;gap:${round(
    size * 0.52
  )}px">
    ${ringSvg({ r, color: ringColor })}
    <span class="display" style="font-size:${round(size * 1.02)}px;font-weight:500;letter-spacing:-0.012em;color:${ink};line-height:1">Help Me Breathe</span>
  </div>`;
}

/* ------------------------------------------------------------------ *
 * Open Graph card
 * ------------------------------------------------------------------ */

export function ogHtml(entry) {
  const [W, H] = entry.size;
  const accent = accentFor(entry.theme);
  const rim = entry.theme === 'neutral' ? DAY.graphite : accent.rim;
  const pad = 40;
  const gutter = 88;
  const stripY = H - 74;
  const footerY = H - 132;

  const ringR = Math.round(H * 0.2);
  const ringStroke = ringR * STROKE_RATIO;
  const ringBox = (ringR + ringStroke / 2) * 2;
  const ringLeft = W - pad - 30 - ringBox;
  const ringTop = Math.round((H - ringBox) / 2 + 6);

  // The text column is anchored to its own bottom so the sub-line always
  // clears the footer, whatever the title runs to.
  const textTop = 138;
  const textBottom = 176;
  const textWidth = ringLeft - gutter - 44;

  const titleSize = entry.title_lines.length >= 3 ? 58 : entry.title_lines.length === 2 ? 72 : 78;

  const title = entry.title_lines.map((l) => `<span style="display:block">${esc(l)}</span>`).join('');
  const sub = entry.sub_lines.map((l) => `<span style="display:block">${esc(l)}</span>`).join('');

  return `<!-- og card -->
${head(`
  .card { position: relative; width: ${W}px; height: ${H}px; background: ${DAY.paper}; overflow: hidden; }
  .frame { position: absolute; inset: ${pad}px; border: 1px solid ${DAY.rule}; }
  .kicker { font-size: 17px; font-weight: 600; letter-spacing: .18em; text-transform: uppercase; color: ${rim}; margin: 0 0 20px; }
  .title { font-size: ${titleSize}px; font-weight: 500; letter-spacing: -0.018em; line-height: 1.06; color: ${DAY.ink}; margin: 0; }
  .title span, .sub span, .kicker { white-space: nowrap; }
  .hair { height: 1px; background: ${DAY.rule}; margin: 30px 0 26px; }
  .sub { font-size: 27px; font-weight: 400; line-height: 1.34; color: ${DAY.graphite}; margin: 0; }
  .label { font-size: 16px; font-weight: 500; letter-spacing: .2em; text-transform: uppercase; }
`)}
<div class="card">
  <div class="frame"></div>
  ${lockup({ x: gutter, y: 78, size: 30, ringColor: DAY.green, ink: DAY.ink })}
  <div style="position:absolute;left:${ringLeft}px;top:${ringTop}px">${ringSvg({ r: ringR, color: DAY.green })}</div>
  <div style="position:absolute;left:${gutter}px;top:${textTop}px;bottom:${textBottom}px;width:${textWidth}px;display:flex;flex-direction:column;justify-content:center">
    <div>
      <p class="ui kicker">${esc(entry.kicker || 'Guided breathing')}</p>
      <h1 class="display title">${title}</h1>
      <div class="hair"></div>
      <p class="ui sub">${sub}</p>
    </div>
  </div>
  <div class="ui label" style="position:absolute;left:${gutter}px;top:${footerY}px;color:${DAY.ink}">${SITE_LABEL}</div>
  <div class="ui label" style="position:absolute;right:${gutter}px;top:${footerY}px;color:${DAY.graphite}">${esc(entry.footer || 'Three sessions free · Offline')}</div>
  ${signatureStrip({ x: gutter, y: stripY, width: W - gutter * 2, active: entry.theme })}
</div>`;
}

/* ------------------------------------------------------------------ *
 * Pinterest pin
 * ------------------------------------------------------------------ */

export function pinHtml(entry) {
  const [W, H] = entry.size;
  const accent = accentFor(entry.theme);
  const rim = entry.theme === 'neutral' ? DAY.graphite : accent.rim;
  const pad = 40;
  const gutter = 88;
  const stripY = H - 104;
  const footerY = H - 176;

  const ringR = 140;

  const titleSize = entry.title_lines.length >= 3 ? 74 : 84;
  const title = entry.title_lines.map((l) => `<span style="display:block">${esc(l)}</span>`).join('');
  const sub = entry.sub_lines.map((l) => `<span style="display:block">${esc(l)}</span>`).join('');

  return `<!-- pin -->
${head(`
  .card { position: relative; width: ${W}px; height: ${H}px; background: ${DAY.paper}; overflow: hidden; }
  .frame { position: absolute; inset: ${pad}px; border: 1px solid ${DAY.rule}; }
  .stack { position: absolute; left: ${gutter}px; right: ${gutter}px; top: ${pad}px; bottom: 210px;
           display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 104px; }
  .kicker { font-size: 19px; font-weight: 600; letter-spacing: .2em; text-transform: uppercase; color: ${rim}; margin: 0 0 26px; }
  .title { font-size: ${titleSize}px; font-weight: 500; letter-spacing: -0.018em; line-height: 1.12; color: ${DAY.ink}; margin: 0; }
  .title span, .sub span, .kicker { white-space: nowrap; }
  .hair { width: 220px; height: 1px; background: ${DAY.rule}; margin: 40px auto 34px; }
  .sub { font-size: 33px; font-weight: 400; line-height: 1.36; color: ${DAY.graphite}; margin: 0; }
  .label { font-size: 17px; font-weight: 500; letter-spacing: .22em; text-transform: uppercase; }
`)}
<div class="card">
  <div class="frame"></div>
  <div class="stack">
    ${ringSvg({ r: ringR, color: DAY.green })}
    <div style="width:100%;text-align:center">
      <p class="ui kicker">${esc(entry.kicker || 'Guided breathing')}</p>
      <h1 class="display title">${title}</h1>
      <div class="hair"></div>
      <p class="ui sub">${sub}</p>
    </div>
  </div>
  <div class="ui label" style="position:absolute;left:0;top:${footerY}px;width:${W}px;text-align:center;color:${DAY.ink}">${SITE_LABEL}</div>
  ${signatureStrip({ x: gutter, y: stripY, width: W - gutter * 2, active: entry.theme, base: 7, tall: 13 })}
</div>`;
}

/* ------------------------------------------------------------------ *
 * Logo raster (transparent)
 * ------------------------------------------------------------------ */

export function logoHtml({ width, height, ringColor, ink }) {
  // The 480x120 lockup scaled to the raster size.
  const scale = width / 480;
  const r = 24 * scale;
  const stroke = r * STROKE_RATIO;
  const clear = stroke * 4;
  const outer = r + stroke / 2;
  const fontSize = 44 * scale;
  return `<!-- lockup -->
${head(`
  .lockup { position: relative; width: ${width}px; height: ${height}px; display: flex; align-items: center; padding-left: ${round(
    clear
  )}px; }
  .word { font-size: ${round(fontSize)}px; font-weight: 500; letter-spacing: -0.012em; color: ${ink}; line-height: 1; margin-left: ${round(
    clear
  )}px; }
`)}
<div class="lockup">
  ${ringSvg({ r, color: ringColor })}
  <span class="display word">Help Me Breathe</span>
</div>`;
}

/** SVG document wrapper for rastering a hand-written mark at an exact size. */
export function svgHtml({ svg, width, height }) {
  return `${head(`
  .stage { width: ${width}px; height: ${height}px; }
  .stage svg { display: block; width: 100%; height: 100%; }
`)}
<div class="stage">${svg}</div>`;
}
