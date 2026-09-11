#!/usr/bin/env node
/**
 * Help Me Breathe — brand asset builder ("Paper and Ink").
 *
 * Renders every shipped brand raster from the templates in this folder using
 * Playwright's Chromium, so the real Newsreader and IBM Plex Sans letterforms
 * are baked into the images. Hand-written vectors (favicon.svg, logo.svg) are
 * emitted from the same geometry module the rasters use, so the ring can never
 * drift between formats.
 *
 * Usage (from the repo root):
 *
 *   node tools/brand/build-assets.mjs                 # build everything
 *   node tools/brand/build-assets.mjs --only=og       # og cards only
 *   node tools/brand/build-assets.mjs --only=pins
 *   node tools/brand/build-assets.mjs --only=icons
 *   node tools/brand/build-assets.mjs --only=logo
 *   node tools/brand/build-assets.mjs --verify        # no render, just audit
 *   node tools/brand/build-assets.mjs --palette       # print the palette report
 *
 * Playwright is not a dependency of the site. It lives in tools/render, and
 * this script reaches into that install rather than adding one of its own.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

import {
  DAY,
  NIGHT,
  ACCENTS,
  TECHNIQUE_ORDER,
  DISPLAY_STACK,
  contrast,
  hueOf,
  lstar,
} from './tokens.mjs';
import { faviconSvg, logoSvg, appIconSvg, ringDocument, FAVICON_16, FAVICON_32 } from './mark.mjs';
import { ogHtml, pinHtml, logoHtml, svgHtml } from './templates.mjs';
import { imageSize } from './imagesize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const RENDER_PKG = join(ROOT, 'tools', 'render', 'package.json');

const OG_MAX_BYTES = 150 * 1024;
const JPEG_QUALITY = 82;

const args = process.argv.slice(2);
const flag = (name) => args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const only = value('only');
const wants = (group) => !only || only.split(',').map((s) => s.trim()).includes(group);

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */
const results = [];
const problems = [];

function record(relPath, expect) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    problems.push(`MISSING ${relPath}`);
    return;
  }
  let info;
  try {
    info = imageSize(abs);
  } catch (err) {
    problems.push(`UNREADABLE ${relPath}: ${err.message}`);
    return;
  }
  if (expect?.width && info.width !== expect.width) {
    problems.push(`WIDTH ${relPath}: got ${info.width}, expected ${expect.width}`);
  }
  if (expect?.height && info.height !== expect.height) {
    problems.push(`HEIGHT ${relPath}: got ${info.height}, expected ${expect.height}`);
  }
  if (expect?.maxBytes && info.bytes > expect.maxBytes) {
    problems.push(`TOO BIG ${relPath}: ${(info.bytes / 1024).toFixed(1)} KB > ${(expect.maxBytes / 1024).toFixed(0)} KB`);
  }
  results.push({ file: relPath, ...info });
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

/* ------------------------------------------------------------------ *
 * Palette audit — printed on every build so a bad accent cannot ship quietly.
 * ------------------------------------------------------------------ */
function paletteReport() {
  const lines = [];
  lines.push('Technique accents — day');
  lines.push('key        rim      hue     rim/paper  fill     fill L*  ink/fill');
  const greenHue = hueOf(DAY.green);
  for (const key of TECHNIQUE_ORDER) {
    const a = ACCENTS[key];
    lines.push(
      [
        key.padEnd(10),
        a.rim,
        `${hueOf(a.rim).toFixed(1)}°`.padStart(7),
        `${contrast(a.rim, DAY.paper).toFixed(2)}:1`.padStart(10),
        ' ',
        a.fill,
        lstar(a.fill).toFixed(1).padStart(7),
        `${contrast(DAY.ink, a.fill).toFixed(2)}:1`.padStart(10),
      ].join(' ')
    );
    if (contrast(a.rim, DAY.paper) < 5.3) problems.push(`ACCENT ${key}: rim contrast below 5.3:1 on paper`);
    const fl = lstar(a.fill);
    if (fl < 78 || fl > 83) problems.push(`ACCENT ${key}: fill L* ${fl.toFixed(1)} outside 78-83`);
    if (contrast(DAY.ink, a.fill) < 7) problems.push(`ACCENT ${key}: phase word below 7:1 on its fill`);
  }
  lines.push('');
  lines.push(`Primary green hue ${greenHue.toFixed(1)}°. Separations from the green and between rims:`);
  const hues = TECHNIQUE_ORDER.map((k) => [k, hueOf(ACCENTS[k].rim)]);
  for (const [key, h] of hues) {
    const dGreen = Math.min(Math.abs(h - greenHue), 360 - Math.abs(h - greenHue));
    const nearest = hues
      .filter(([k2]) => k2 !== key)
      .map(([k2, h2]) => {
        const d = Math.abs(h - h2);
        return [k2, Math.min(d, 360 - d)];
      })
      .sort((a, b) => a[1] - b[1])[0];
    lines.push(
      `  ${key.padEnd(10)} ${h.toFixed(1).padStart(6)}°   green ${dGreen.toFixed(1).padStart(5)}°   nearest ${nearest[0]} ${nearest[1].toFixed(1)}°`
    );
    if (key === 'box' && (dGreen < 28 || nearest[1] < 28)) {
      problems.push('ACCENT box: must sit at least 28° from the green and from every other rim');
    }
  }
  lines.push('');
  lines.push('Night rims (fills collapse to one dark value, ' + NIGHT.leaf + ')');
  for (const key of TECHNIQUE_ORDER) {
    const a = ACCENTS[key];
    lines.push(
      `  ${key.padEnd(10)} ${a.nightRim}  ${`${contrast(a.nightRim, NIGHT.paper).toFixed(2)}:1`.padStart(8)} on night paper`
    );
    if (contrast(a.nightRim, NIGHT.paper) < 4.5) problems.push(`ACCENT ${key}: night rim below 4.5:1 on night paper`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Playwright
 * ------------------------------------------------------------------ */
async function withBrowser(fn) {
  const require = createRequire(RENDER_PKG);
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (err) {
    throw new Error(
      `Playwright not found under tools/render. Run: cd tools/render && npm install && npx playwright install chromium\n(${err.message})`
    );
  }
  const browser = await chromium.launch({ args: ['--font-render-hinting=none', '--force-color-profile=srgb'] });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

const FONT_PROBES = [
  '500 78px Newsreader',
  '500 44px Newsreader',
  '500 30px Newsreader',
  '400 27px "IBM Plex Sans"',
  '500 17px "IBM Plex Sans"',
  '600 17px "IBM Plex Sans"',
];

async function settleFonts(page) {
  await page.evaluate(async (probes) => {
    try {
      await Promise.all(probes.map((p) => document.fonts.load(p, 'Help Me Breathe')));
    } catch {
      /* a missing probe must not stop the render */
    }
    await document.fonts.ready;
  }, FONT_PROBES);
  // One extra frame so the relayout after the swap is painted.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Shrink `.title` and `.sub` until every (nowrap) line fits its column. */
async function fitText(page) {
  await page.evaluate(() => {
    const shrink = (el, min) => {
      if (!el) return;
      const box = el.parentElement;
      let size = parseFloat(getComputedStyle(el).fontSize);
      const fits = () => [...el.children].every((c) => c.scrollWidth <= box.clientWidth + 0.5);
      while (!fits() && size > min) {
        size -= 1;
        el.style.fontSize = `${size}px`;
      }
    };
    shrink(document.querySelector('.title'), 34);
    shrink(document.querySelector('.sub'), 18);
  });
}

async function shoot(browser, { html, width, height, out, type = 'png', quality, transparent = false, fit = false }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await settleFonts(page);
    if (fit) {
      await fitText(page);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    }
    const buf = await page.screenshot({
      type,
      ...(type === 'jpeg' ? { quality } : {}),
      omitBackground: transparent,
      clip: { x: 0, y: 0, width, height },
    });
    mkdirSync(dirname(join(ROOT, out)), { recursive: true });
    writeFileSync(join(ROOT, out), buf);
  } finally {
    await page.close();
  }
}

/* ------------------------------------------------------------------ *
 * Vector assets — written straight from the geometry module.
 * ------------------------------------------------------------------ */
function writeVectors() {
  const favicon = faviconSvg({ day: DAY.green, night: NIGHT.green });
  writeFileSync(join(ROOT, 'favicon.svg'), favicon, 'utf8');

  const logo = logoSvg({ ring: DAY.green, ink: DAY.ink, displayStack: DISPLAY_STACK });
  mkdirSync(join(ROOT, 'images'), { recursive: true });
  writeFileSync(join(ROOT, 'images', 'logo.svg'), logo, 'utf8');

  record('favicon.svg', { width: 32, height: 32 });
  record('images/logo.svg', { width: 480, height: 120 });
}

/* ------------------------------------------------------------------ *
 * Build groups
 * ------------------------------------------------------------------ */
async function buildIcons(browser) {
  // Favicon rasters: the 16px file carries its own thicker geometry.
  await shoot(browser, {
    html: svgHtml({ svg: ringDocument({ size: 16, ring: FAVICON_16, color: DAY.green }), width: 16, height: 16 }),
    width: 16,
    height: 16,
    out: 'favicon-16.png',
    transparent: true,
  });
  await shoot(browser, {
    html: svgHtml({ svg: ringDocument({ size: 32, ring: FAVICON_32, color: DAY.green }), width: 32, height: 32 }),
    width: 32,
    height: 32,
    out: 'favicon-32.png',
    transparent: true,
  });
  record('favicon-16.png', { width: 16, height: 16 });
  record('favicon-32.png', { width: 32, height: 32 });

  // App icons: green tile, paper ring, ring inside the central 80%.
  // The PWA tiles keep the 22% corner radius with TRANSPARENT corners, not
  // white ones: manifest.json declares them "any maskable", and a launcher
  // mask (circle or squircle) falls inside a 22%-radius rounded rect at every
  // point, so nothing transparent is ever revealed. White corners would show.
  //
  // iOS ignores alpha and composites the touch icon on an opaque ground, so
  // that one ships full-bleed square and lets iOS round it.
  const tiles = [
    { size: 192, out: 'images/icon-192.png', squareTile: false, transparent: true },
    { size: 512, out: 'images/icon-512.png', squareTile: false, transparent: true },
    { size: 180, out: 'images/apple-touch-icon.png', squareTile: true, transparent: false },
  ];
  for (const t of tiles) {
    const svg = appIconSvg({ size: t.size, tile: DAY.green, ring: DAY.paper, squareTile: t.squareTile });
    await shoot(browser, {
      html: svgHtml({ svg, width: t.size, height: t.size }),
      width: t.size,
      height: t.size,
      out: t.out,
      transparent: t.transparent,
    });
    record(t.out, { width: t.size, height: t.size });
  }
}

async function buildLogo(browser) {
  await shoot(browser, {
    html: logoHtml({ width: 1200, height: 300, ringColor: DAY.green, ink: DAY.ink }),
    width: 1200,
    height: 300,
    out: 'images/logo.png',
    transparent: true,
  });
  record('images/logo.png', { width: 1200, height: 300 });
}

async function buildCards(browser, manifest, group) {
  for (const entry of manifest) {
    const isPin = entry.layout === 'pin';
    if (group === 'og' && isPin) continue;
    if (group === 'pins' && !isPin) continue;
    const [w, h] = entry.size;
    const html = isPin ? pinHtml(entry) : ogHtml(entry);
    await shoot(browser, {
      html,
      width: w,
      height: h,
      out: entry.file,
      type: 'jpeg',
      quality: JPEG_QUALITY,
      fit: true,
    });
    record(entry.file, { width: w, height: h, maxBytes: OG_MAX_BYTES });
    process.stdout.write(`  ${entry.file}\n`);
  }
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function main() {
  const manifestPath = join(ROOT, 'tools', 'og-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  console.log('Help Me Breathe — brand assets ("Paper and Ink")\n');
  console.log(paletteReport());
  console.log('');

  if (flag('palette')) {
    finish();
    return;
  }

  if (flag('verify')) {
    if (wants('vectors')) {
      record('favicon.svg', { width: 32, height: 32 });
      record('images/logo.svg', { width: 480, height: 120 });
    }
    if (wants('icons')) {
      record('favicon-16.png', { width: 16, height: 16 });
      record('favicon-32.png', { width: 32, height: 32 });
      record('images/icon-192.png', { width: 192, height: 192 });
      record('images/icon-512.png', { width: 512, height: 512 });
      record('images/apple-touch-icon.png', { width: 180, height: 180 });
    }
    if (wants('logo')) record('images/logo.png', { width: 1200, height: 300 });
    for (const entry of manifest) {
      const isPin = entry.layout === 'pin';
      if (!wants(isPin ? 'pins' : 'og')) continue;
      record(entry.file, { width: entry.size[0], height: entry.size[1], maxBytes: OG_MAX_BYTES });
    }
    finish();
    return;
  }

  if (wants('vectors')) {
    console.log('Vectors');
    writeVectors();
    console.log('  favicon.svg\n  images/logo.svg');
  }

  await withBrowser(async (browser) => {
    if (wants('icons')) {
      console.log('Icons');
      await buildIcons(browser);
      console.log('  favicon-16.png, favicon-32.png, apple-touch-icon.png, icon-192.png, icon-512.png');
    }
    if (wants('logo')) {
      console.log('Logo');
      await buildLogo(browser);
      console.log('  images/logo.png');
    }
    if (wants('og')) {
      console.log('Open Graph cards');
      await buildCards(browser, manifest, 'og');
    }
    if (wants('pins')) {
      console.log('Pinterest pins');
      await buildCards(browser, manifest, 'pins');
    }
  });

  finish();
}

function finish() {
  console.log('');
  if (results.length) {
    const total = results.reduce((n, r) => n + r.bytes, 0);
    const biggest = [...results].sort((a, b) => b.bytes - a.bytes).slice(0, 3);
    console.log(`${results.length} file(s) checked, ${kb(total)} total.`);
    console.log('Largest: ' + biggest.map((b) => `${b.file} ${kb(b.bytes)}`).join(', '));
  }
  if (problems.length) {
    console.error('\nPROBLEMS');
    for (const p of problems) console.error('  ' + p);
    process.exitCode = 1;
  } else {
    console.log('All checks passed.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
