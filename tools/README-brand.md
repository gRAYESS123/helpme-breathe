# Brand assets — how to regenerate

Every shipped brand image is generated. Nothing in `images/` or the favicons is
hand-edited; if one of them looks wrong, fix the source in `tools/brand/` or the
copy in `tools/og-manifest.json` and rebuild.

The identity is **"Paper and Ink"** (owner decision, 2026-09-10): warm paper
ground, charcoal ink, one deep green, Newsreader + IBM Plex Sans, a ring with a
gap at twelve o'clock. No emoji, no gradients, no blur, no glow, no shadows.
`docs/BRAND.md` is the written source of truth; `tools/brand/tokens.mjs` is the
machine-readable copy of it.

## Quick start

```bash
# once, if the renderer has never been installed on this machine
cd tools/render && npm install && npx playwright install chromium

# from the repo root
node tools/brand/build-assets.mjs
```

That writes 44 files and then audits every one of them: the file exists, its
pixel dimensions match the manifest, and no social card exceeds 150 KB. The run
exits non-zero if any check fails.

### Partial builds

```bash
node tools/brand/build-assets.mjs --only=vectors   # favicon.svg, images/logo.svg
node tools/brand/build-assets.mjs --only=icons     # favicons + app icons
node tools/brand/build-assets.mjs --only=logo      # images/logo.png
node tools/brand/build-assets.mjs --only=og        # Open Graph cards
node tools/brand/build-assets.mjs --only=pins      # Pinterest pins
node tools/brand/build-assets.mjs --only=og,pins   # comma-separated is fine
```

### Audit without rendering

```bash
node tools/brand/build-assets.mjs --verify     # check what is on disk
node tools/brand/build-assets.mjs --palette    # print the accent report only
```

## What gets written

| File | Size | Notes |
|---|---|---|
| `favicon.svg` | 32-unit viewBox | Hand-written vector, ring only, transparent ground. Green on light chrome, night green under `prefers-color-scheme: dark`. |
| `favicon-16.png` | 16 × 16 | Its own thicker geometry: stroke 20% of the grid, gap 56°. |
| `favicon-32.png` | 32 × 32 | Stroke 16%, gap 52°. Same geometry as `favicon.svg`. |
| `images/logo.svg` | 480 × 120 | Ring plus a real `<text>` wordmark naming Newsreader with the display fallback stack. |
| `images/logo.png` | 1200 × 300 | The same lockup with Newsreader actually rendered, on transparent. Use this where the letterforms must be exact. |
| `images/apple-touch-icon.png` | 180 × 180 | Full-bleed green square; iOS applies its own corner mask. |
| `images/icon-192.png` | 192 × 192 | Maskable: green tile, 22% radius, **transparent** corners, paper ring inside the central 80%. |
| `images/icon-512.png` | 512 × 512 | Same, larger. |
| `images/og/<slug>.jpg` | 1200 × 630 | One per entry in `tools/og-manifest.json`. |
| `images/og-breathing-timer.jpg` | 1200 × 630 | Site-wide default card. |
| `images/twitter-breathing-timer.jpg` | 1200 × 600 | Twitter/X variant of the same. |
| `images/4-7-8-breathing-guide-og.jpg` | 1200 × 630 | Card for the long-standing `/blog/4-7-8-breathing-technique` article. |
| `images/pins/<slug>.jpg` | 1000 × 1500 | Pinterest pin for every technique and use-case page. |

Social cards are JPEG at quality 82. In practice they land between 25 and 62 KB,
comfortably under the 150 KB budget the builder enforces.

## The geometry

`tools/brand/mark.mjs` owns the ring and nothing else does. The canonical mark
is a circle of radius 40 on a 100-unit grid, stroke 9, butt caps, with a 48°
gap centred at twelve o'clock:

```
M66.27 13.46 A40 40 0 1 1 33.73 13.46
```

`ringPath(cx, cy, r, gapDeg)` reproduces that string exactly when called with
the canonical numbers, which is the regression test: if a change to the maths
breaks it, `canonicalPath()` stops matching the path printed in `docs/BRAND.md`.

Everything else scales from `STROKE_RATIO` (9 / 40), so the ring's weight is
identical at 16 px and at 512 px. The two favicon sizes are the deliberate
exceptions — a 9/40 stroke disappears at 16 px, so those two thicken the stroke
and widen the gap so the opening survives a single device pixel.

SVG cannot swap geometry by rendered size, so `favicon.svg` ships at the 32 px
geometry and `favicon-16.png` carries the small-size drawing. Serve both:

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="icon" href="/favicon-16.png" sizes="16x16" type="image/png">
<link rel="apple-touch-icon" href="/images/apple-touch-icon.png">
```

## Why the PWA tiles have transparent corners

`manifest.json` declares `icon-192` and `icon-512` as `"purpose": "any maskable"`.
A maskable icon must survive whatever shape the launcher crops it to, so the
corners cannot be white — they would show as white wedges the moment a launcher
uses a shape wider than the tile.

They are transparent instead, and the 22% radius stays. That is safe: an
inscribed circle and Android's squircle both fall *inside* a 22%-radius rounded
rectangle at every point, so no launcher mask ever reveals the transparency,
and anything that renders the icon unmasked gets the rounded tile the brand
asks for.

`apple-touch-icon.png` is the exception. iOS discards alpha and composites the
icon on an opaque ground, so that file ships full-bleed square and lets iOS
apply its own corner radius.

## Editing the social cards

`tools/og-manifest.json` is a flat array. Each entry:

```json
{
  "file": "images/og/box-breathing.jpg",
  "layout": "og",
  "size": [1200, 630],
  "theme": "box",
  "kicker": "Box breathing · 4-4-4-4",
  "title_lines": ["Box Breathing", "Timer & Guide"],
  "sub_lines": ["Equal counts in, hold, out, hold", "— with a free guided timer"]
}
```

- `layout` is `"og"` (a wide card: lockup top-left, ring right, left-aligned
  type) or `"pin"` (a tall card: ring above centred type).
- `theme` is one of the seven technique keys — `478`, `box`, `coherent`,
  `sigh`, `extended`, `triangle`, `wim` — or `neutral` for legal and policy
  pages. It tints the kicker and raises that technique's bar in the signature
  strip along the bottom. It never tints the ring: the mark stays green.
- `title_lines` and `sub_lines` are literal line breaks, not wrapped text. Each
  line is set `white-space: nowrap`; if a line is too long for its column the
  renderer steps the type down (to a floor of 34 px for titles, 18 px for
  sub-lines) rather than wrapping it. If you see shrunken type, shorten the
  line — do not fight the auto-fit.
- Add a page's card by adding an entry. Keep the slug identical to whatever the
  page's `og:image` points at.

Write the copy the way the site is written: calm, second person, no hype, no
exclamation marks, no emoji.

## The palette report

Every run prints the technique accents and then checks them:

- each **rim** clears 5.3:1 on `--paper`;
- each **fill** lands at L\* 78–83 and carries the phase word (`--ink`) at 7:1
  or better;
- the **box** rim sits at least 28° from the primary green and from every other
  rim;
- each **night rim** clears 4.5:1 on the night ground.

A failure is reported as a `PROBLEM` and fails the build.

`box` is the one accent that was changed from the concept board. The board's
`#1C5140` sat within a couple of degrees of `--green #0F5136` — a near-twin
that would have made the box technique read as "the default". It is now the
mulberry `#6E3C69` (HSL 306.0°, CIELAB LCh 329.8°), which clears 28° from the
primary green and from every other rim in **both** CIELAB LCh and OKLCH.

The accent table in `tools/brand/tokens.mjs` mirrors `css/styles.css`.
`docs/BRAND.md` §2 and `css/styles.css` are the source of truth; the generator
follows them.

Two of the inherited rims sit closer to each other than 28° (`478`/`triangle`
at 21.8°, `sigh`/`triangle` at 21.9°, `extended`/`wim` at 25.0°). Those are the
owner-approved board values and were left alone; they are distinguishable
because they also differ in lightness, and because a pill never relies on
colour alone.

## Fonts

The templates load Newsreader and IBM Plex Sans from Google Fonts and wait for
`document.fonts.ready` plus two animation frames before capturing, so the
rasters contain the real letterforms rather than a fallback. **The build needs
network access.** If it is offline the cards still render, but in Georgia and
Arial — check one output before committing after any build on a flaky
connection.

Nothing about this affects the site: these are static images.

## Dependencies

The site itself has zero runtime dependencies and that does not change. The
builder borrows Playwright from `tools/render/node_modules` via `createRequire`
pointed at `tools/render/package.json`; it does not add a `package.json` of its
own and nothing under `tools/brand/` is served to a browser.

## History

`tools/generate-images.py` (Pillow) produced the previous, pre-rebrand images
and was deleted on 2026-09-10. This Node builder replaces it entirely.
