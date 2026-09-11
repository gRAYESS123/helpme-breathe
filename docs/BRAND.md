# Help Me Breathe — Brand Guide

**Paper and Ink.** Owner decision, 2026-09-10.

The site is a printed leaflet that happens to run. Warm paper, charcoal ink,
one deep green, a serif for the words you read and a sans for everything you
operate. One mark: a ring with a single gap at the top, because the pause
between breaths is the part that does the work. The breathing circle is that
mark alive.

The name stays **Help Me Breathe**. There is no emoji anywhere on the site, in
any file, at any size. No gradient backgrounds. No blur. No glow. No shadowed
type. Not Quicksand.

`css/styles.css` is the implementation of this document. `docs/PAGE_CONTRACT.md`
is the copy-paste recipe for building or converting a page.

---

## 1. Tokens

One palette for the whole site. Techniques differ only by a rim/fill accent
pair on the breathing circle, the progress bar and small labels — never by the
colour of the page.

### Day

| Token | Value | Role |
|---|---|---|
| `--paper` | `#F5F1E8` | Page ground. Warm leaflet stock. |
| `--leaf` | `#FFFDF7` | Surface: cards, panels, the header, the breathing section. |
| `--ink` | `#1C2320` | Text. Charcoal with a green undertone. |
| `--graphite` | `#575F58` | Muted text: captions, metadata, labels. |
| `--rule` | `#E3DCCC` | **Decorative hairline only.** Never a control's boundary. The one deliberate exception is `.control-btn:disabled`, where the point is that the control is *not* operable — a disabled control is the single state WCAG 1.4.11 exempts, and giving it an `--edge` boundary would make it look live. |
| `--edge` | `#83887E` | **Control outlines**: buttons, inputs, toggles, pills, tools, the settings button. |
| `--track` | `#DFD8C7` | Progress trough, input wells, the featured pricing column. |
| `--green` | `#0F5136` | Primary: the Begin button, links, the focus ring, the active nav item. |
| `--chalk` | `#FFFFFF` | Ink on primary. |
| `--clay` | `#8A4B24` | **Commerce accent.** Paid surfaces only — price figures, the Practitioner flag, checkout buttons. Never on the timer screen. |
| `--ok` | `#1B6B45` | Success. |
| `--warn` | `#7E5406` | Caution: the contraindication rule. |
| `--bad` | `#A32721` | Danger: the crisis block border, form errors. |

### Night

| Token | Value |
|---|---|
| `--paper` | `#15191A` |
| `--leaf` | `#1E2426` |
| `--ink` | `#EDE7DA` |
| `--graphite` | `#A7AEA4` |
| `--rule` | `#2E3536` |
| `--edge` | `#767D77` |
| `--track` | `#2B3233` |
| `--green` | `#5FBF92` |
| `--chalk` | `#15191A` |
| `--clay` | `#D9A279` |
| `--ok` | `#6FCB9B` |
| `--warn` | `#E0B25C` |
| `--bad` | `#F0918A` |

### Dark by preference

Night is honoured for **every** visitor, not only for people who bought Pro.
`@media (prefers-color-scheme: dark)` redefines the tokens on `body:not(.day)`,
so an explicit `body.day` opts back out. `body.night` — set by the Pro night
toggle in `js/pro/night.js` — redefines them again after the media query, so a
manual choice always wins in both directions.

**Every colour is a token.** No component may define a colour that exists only
inside a media query or a `.night` block. If a component needs a colour, it
needs a token.

### Shadows

There are exactly two, and nothing else in the system is allowed a `box-shadow`.

```
--shadow-sheet: 0 1px 0 rgba(28,35,32,.05);
--shadow-lift:  0 1px 0 rgba(28,35,32,.05), 0 10px 28px -20px rgba(28,35,32,.45);
```

`--shadow-sheet` is a sheet lying on the stock (cards, the breathing section).
`--shadow-lift` is something raised above the page (the settings popover, the
cookie banner, the keyboard hint, the collapsed mobile nav). Night swaps both
for black-based equivalents. Focus rings are `outline`, never a shadow.

### Legacy aliases

The old token names still resolve, so a page that has not been converted yet
keeps rendering: `--bg-primary`, `--text-primary`, `--text-secondary`,
`--surface`, `--border`, `--shadow`, `--theme-primary`, `--theme-secondary`,
`--theme-glow`, `--progress-color`. They are declared on `body` (not on
`:root`) so that they resolve against whichever token set is live.
`--theme-glow` is now `transparent`: any surviving `0 0 60px var(--theme-glow)`
renders as nothing. `--border` maps to `--rule`, which is decorative — **new
work must use `--edge` for a control's boundary.**

---

## 2. The seven technique pairs

Each technique gets a **pair**. The deep **rim** hue carries every text and
control duty. The chalky **fill** is the circle's interior — decoration, not a
boundary, and deliberately about 1.5:1 against the page so the circle stays
soft. That is the honest reading of WCAG 1.4.11: the 3px rim is the thing that
identifies the control, and it measures 6.06–8.54:1 on paper.

### Day

| Technique | Rim | Fill | Rim L\* / C / hue |
|---|---|---|---|
| 4-7-8 (`478`) | `#33407F` | `#C5C5E0` | 29.2 / 40.4 / **292.1°** |
| Box (`box`) | `#6E3C69` | `#DABFD6` | 33.1 / 33.7 / **329.8°** |
| Coherence (`coherent`) | `#8C2F49` | `#E5BDC4` | 34.2 / 42.0 / **7.8°** |
| Cyclic sighing (`sigh`) | `#125A62` | `#A2CFD5` | 34.6 / 21.0 / **210.8°** |
| Extended exhale (`extended`) | `#7A5310` | `#D8C4AD` | 38.5 / 43.3 / **76.1°** |
| Triangle (`triangle`) | `#2C5273` | `#B5C9E2` | 33.6 / 23.1 / **263.5°** |
| Energizing (`wim`) | `#993A20` | `#E4BFB4` | 37.7 / 52.4 / **43.0°** |

Every fill is placed at L\* 80.3 with chroma 14.8–15.5 on the rim's own hue, so
all seven measure 1.50:1 on paper and 9.46:1 or better against the phase word.

### Hue separation, and why box changed

The primary green `#0F5136` sits at hue **159.5°**. The concept board's box rim
was `#1C5140` at **167.7°** — 8.2° from the primary, a near-twin that made the
box pill read as "the site's green" rather than as a technique. It has been
replaced with a mulberry at **329.8°**, chosen at the midpoint of the largest
gap left in the wheel.

Eight hues, sorted, with each one's nearest-neighbour gap:

| Hue | Owner | Nearest neighbour |
|---|---|---|
| 7.8° | coherent | 35.2° |
| 43.0° | wim | 33.1° |
| 76.1° | extended | 33.1° |
| 159.5° | **primary green** | 51.4° |
| 210.8° | sigh | 51.4° |
| 263.5° | triangle | 28.7° |
| 292.1° | 478 | 28.7° |
| 329.8° | box | 37.7° |

Smallest gap anywhere: **28.7°** (478 / triangle). Every rim is at least 28°
from the primary green and from every other rim.

**The 28° rule is measured in CIELAB LCh (D65). Never in HSL.** HSL hue is not
perceptually uniform and compresses badly exactly where three of these rims sit
— the blue-to-violet arc. `#33407F` and `#613878` are 48.7° apart in HSL and
only **23.9°** apart in CIELAB LCh; they read as the same colour on a pill row.
`#6E3C69` was chosen because it clears the rule in **both** perceptual spaces:
28.7° in CIELAB LCh and 36.0° in OKLCH. If a rim is ever re-picked, quote the
CIELAB LCh number, and check OKLCH as a second opinion.

> `tools/brand/tokens.mjs` audits this separation in **HSL**, which is not
> perceptually uniform. Its table now mirrors this one exactly (box `#6E3C69` /
> `#DABFD6`, night rim `#D59CCB`), and `node tools/brand/build-assets.mjs
> --palette` re-verifies it. This document and `css/styles.css` remain the
> source of truth; the generator follows them. Any social card rendered before
> 2026-09-10 carries the older `#613878` box violet and needs re-rendering.

### Night

At night the fills collapse to **one** value — `#1E2426`, the night surface.
A dark ground cannot carry seven distinguishable tints, and a light filled disc
at two in the morning is a torch in the face. The rim carries the hue.

| Technique | Night rim |
|---|---|
| 4-7-8 | `#93A2E8` |
| Box | `#D59CCB` (derived: hue 331.4°, L\* 71, C 33) |
| Coherence | `#F2909F` |
| Cyclic sighing | `#5FC7D1` |
| Extended exhale | `#E0B25C` |
| Triangle | `#8FBBE3` |
| Energizing | `#F0916B` |

**Night circle = dark fill, light rim, bone phase word. Never a light filled
disc at night.**

---

## 3. Type

| Face | Where |
|---|---|
| **Newsreader** (Google Fonts, OFL; `opsz 6..72`; 400/500/600) | Display, `h1`, `h2`, the wordmark, the phase word inside the circle, technique titles, price figures, post-session headings, the article lead. |
| **IBM Plex Sans** (400/500/600) | Everything a person operates or scans: body, `h3` and below, nav, buttons, pills, labels, forms, tables, metadata, the timer digits, every number that changes. |

**The rule: the moment a line of type is clickable, it is sans.** A serif that
can be tapped is a serif that will be misread at one in the morning.

Nothing lighter than 400, anywhere. Micro type floor is **11px**
(`--fs-micro: 0.6875rem`). The timer digits and every numeric column carry
`font-variant-numeric: tabular-nums`.

```
--display: 'Newsreader', ui-serif, Georgia, 'Times New Roman', serif;
--ui: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
      'Helvetica Neue', Arial, sans-serif;
```

Loading (preconnect + non-blocking, on every page except the embed widget):

```
https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&display=swap
```

**The embed widget loads no webfont at all.** Hard rule 14: zero third-party
requests from inside that iframe. It uses the fallback stacks.

Measured on the shipped timer at a 1240px viewport: phase word 40px Newsreader,
`h1` 36px Newsreader, timer digits 28px IBM Plex Sans. The phase word is the
largest thing on the breathing screen, by design.

---

## 4. The mark

A ring: a circle of radius 40 on a 100-unit grid, stroke 9 (9% of the grid),
butt caps — not round; this is an instrument, not a bubble — with a **48° gap
centred at twelve o'clock**, which is 13.3% of the circumference.

```html
<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
  <path d="M66.27 13.46 A40 40 0 1 1 33.73 13.46"
        fill="none" stroke="currentColor" stroke-width="9"/>
</svg>
```

- **Green on paper** in normal use. **Paper on green** when it sits on the
  primary. **Ink** in monochrome.
- **Wordmark:** Newsreader 500, "Help Me Breathe", tracking `-0.012em`.
- **Lockup:** ring + wordmark, with clear space on every side equal to the
  stroke width times four. At the header's 26px mark that is a 0.6rem gap.
- At 375px the lockup **shortens to the ring** and the wordmark is hidden.

### Favicon and app icon

| Size | Stroke | Gap | Ground |
|---|---|---|---|
| 16px | 20% of the grid | 56° | transparent, ring in `--green` |
| 32px | 16% of the grid | 52° | transparent, ring in `--green` |
| 192 / 512 app icon | 9% (the master) | 48° | `#0F5136` tile, radius 22%, paper ring, maskable safe zone respected |

The stroke thickens and the gap widens as the icon shrinks so that both survive
a single device pixel. The favicon ring is green on a **transparent** ground so
it reads on light and dark browser chrome alike.

Pages reference `/favicon.svg`, `/favicon-32.png`, `/favicon-16.png` and
`/images/apple-touch-icon.png`. **Never an emoji data URI.**

---

## 5. The breathing object

The circle is the mark, running.

- A **ring**: 3px rim in the technique's rim colour, with a light fill.
- A **notch** at twelve o'clock — a small bar in the surface colour laid over
  the rim — is the mark's gap. When the pattern reaches a **hold** the notch
  fades out over 240ms, so the ring completes itself for as long as you are
  holding your breath, and reopens over 240ms when the hold ends.
- Two fixed **dotted caliper rings** sit around the live circle: the outer marks
  a full inhale, the inner marks a full exhale. The live circle travels between
  them. On the 320-unit stage they are at r=136 and r=100; the circle is 260
  units across and scales between 0.72 and 1.00.
- The **phase word** is the largest text on the screen — Newsreader, larger than
  the timer digits — with a per-second count beneath it (`Inhale` / `3`). Both
  sit outside the scaled circle so they never shrink with it.
- During a hold the circle is **still**, with a 0.4% drift so the frame never
  reads as a crashed tab. The progress bar keeps moving.
- **Begin is disabled while a session runs. Pause is the primary control during
  a session. Stop is secondary.**

---

## 6. Motion

Scale is the whole animation.

| | |
|---|---|
| Inhale | 0.72 → 1.00, `cubic-bezier(.33, 0, .20, 1)` |
| Exhale | 1.00 → 0.72, `cubic-bezier(.42, 0, .30, 1)` |
| Hold | still (0.4% drift) |
| Cyclic sighing top-up | overshoots to 1.08 |
| Phase word | cross-fade, 160ms, opacity only |
| Notch | 240ms linear, opacity only |
| Technique switch | the accent tokens cross-fade over 400ms; the page ground never moves |

Each pattern has its own keyframe block whose percentages are that pattern's
phase boundaries. The cycle length is declared **in CSS** as well as inline by
`js/app.js`: the engine clears the whole `animation` shorthand to force a
restart on a technique swap, which also clears its own inline duration, so CSS
has to carry the canonical value. Change a phase duration in
`js/techniques.js` and you must change the matching `animation-duration` in
`css/styles.css`.

### Reduced motion

`prefers-reduced-motion: reduce` gets **targeted rules, never a blanket
transition kill** — the old blanket rule murdered the phase cross-fade, which is
the one cue a person actually needs.

- The circle holds one size (scale 0.86) and its scale animation is off.
- The pace is carried by a ring drawn around the circle's circumference via
  `stroke-dashoffset`, linear, over the phase duration. `js/app.js` publishes
  `--phase-duration` on the app root at each boundary, and four animation names
  (one per phase kind) guarantee the ring restarts every time.
- The numeric count still ticks.
- The progress bar still advances, in whole-second steps (`js/app.js` quantises
  it under this preference).
- The notch still opens and closes — instantly.
- **Audio and vibration cues are exempt.** They are not motion.

---

## 7. Components

| Component | Rule |
|---|---|
| Buttons | radius 8px, **1px borders only**, minimum **44px rendered height** (measure the box, not the padding). Primary = green / chalk. Secondary = leaf with an `--edge` border. Quiet = borderless graphite. |
| Technique pills | radius 999px, `--edge` border, an accent dot (`::before`) in **that technique's own** rim colour. Active = a doubled border in the rim colour (`::after` inset ring, so nothing shifts) **plus weight 600** — never colour alone. |
| Settings | a printed form in a popover: leaf, `--edge` border, `--shadow-lift`. The toggle has an `--edge` border in its off state and turns green when on; the track is 30px but the hit area is 44px. Native `<select>` for the duration. |
| App bar | technique title left, settings gear right, hairline beneath, sitting directly under the site header so the two read as one header stack. |
| Technique card | a 3px top rule in the rim colour. |
| Contraindication callout | 3px `--warn` left rule on leaf. |
| Crisis block | a full 1px `--bad` border on leaf. Carries **Embrace 1564** (Lebanon) alongside 988, 116 123 and findahelpline.com. |
| Article header | breadcrumb eyebrow → `h1` → lead → a hairline-ruled strip with the author's name and role on the left and Published / Reviewed dates in tabular figures on the right. **The site has no medical reviewer. Never invent one.** |
| Pricing | a full feature matrix with the **Practitioner** column featured: flagged "Most practitioners", tinted with `--track`, and the only filled primary button. Pro gets a secondary button. Directly under the table, a small line saying the price is in US dollars, invoiced, sold by our merchant of record who collects any VAT or sales tax, and that there is a 14-day unconditional refund. |
| Cookie banner | a leaf card. **Decline is listed first and weighted exactly the same as Accept.** |
| Ad slot | 1px dashed `--edge` on paper, label in `--graphite` (never `--edge` for text), reserved height so CLS stays 0. |
| Footer | 1px `--ink` top rule, four link columns, an authorship byline naming a person, then the legal row. |
| Site header | on **every** page: leaf ground, hairline bottom rule, the lockup linking to `/`, nav Timer · Guides · Science · For practitioners · Pro. **The Pro link is not accent-coloured.** At 640px and below the nav collapses behind a menu button; at 420px and below the wordmark drops and the lockup is the ring alone. |

---

## 8. Do and don't

**Do**

- Let the accent touch three things: the circle, the progress fill, the pill dot.
- Use `--edge` for anything a person can operate, `--rule` for anything they
  merely read across.
- Set numbers that change in tabular figures.
- Keep the page ground identical on every page and in every technique.
- Write the count, the phase and the remaining time as plain text. A person
  half-asleep should not have to interpret a colour.

**Don't**

- Don't use `--clay` on the timer screen. It is the commerce voice; the timer is
  not for sale.
- Don't colour the Pro link in the nav. It is a page, not a pitch.
- Don't put a technique hue on the page background, the header, or body text.
- Don't add a third shadow.
- Don't use `--rule` as a control boundary or `--edge` as a text colour.
- Don't reach for an emoji, a gradient, a blur or a glow. They are gone on
  purpose.

---

## 9. Measured contrast

Computed in Node with the WCAG 2.x relative-luminance formula (sRGB
linearisation, then `(L_light + 0.05) / (L_dark + 0.05)`).
**163 pairs checked, 0 failures.** Minimum text ratio 4.64:1; minimum control
ratio 3.22:1. `tools/` has no contrast runner; the audit is re-run by parsing
the token blocks straight out of `css/styles.css`, so the table cannot drift
from the stylesheet without someone noticing.

Three pairs were missing from the first audit and one of them failed. They are
in the table now:

- The **session progress fill** was `--edge` on `--track` — `#83887E` on
  `#DFD8C7`, **2.55:1**. It is `--graphite` now (4.64:1 day, 5.75:1 night).
- The **caliper rings** were `--edge` at `opacity: 0.5`, an effective
  `#C1C3BB` at **1.75:1**. They mark full inhale and full exhale, so they carry
  no opacity now: plain `--edge`, 3.22:1 on `--paper` (the kiosk ground) and
  3.57:1 on `--leaf`. `opacity: 0.9` was tried first and still failed on paper
  at 2.79:1.
- The **breadcrumb separator glyph** was drawn in `--rule` at 1.15:1. A
  separator is type, not a hairline; it inherits `--graphite` now.

| Pair | Foreground | Background | Ratio | Needs | |
|---|---|---|---|---|---|
| body text on page ground | `#1C2320` | `#F5F1E8` | 14.21 | 4.5 | PASS |
| body text on surface | `#1C2320` | `#FFFDF7` | 15.75 | 4.5 | PASS |
| muted text on page ground | `#575F58` | `#F5F1E8` | 5.85 | 4.5 | PASS |
| muted text on surface | `#575F58` | `#FFFDF7` | 6.49 | 4.5 | PASS |
| link / primary text on ground | `#0F5136` | `#F5F1E8` | 8.28 | 4.5 | PASS |
| link / primary text on surface | `#0F5136` | `#FFFDF7` | 9.17 | 4.5 | PASS |
| button label on primary | `#FFFFFF` | `#0F5136` | 9.33 | 4.5 | PASS |
| commerce accent on ground | `#8A4B24` | `#F5F1E8` | 5.99 | 4.5 | PASS |
| commerce accent on surface | `#8A4B24` | `#FFFDF7` | 6.63 | 4.5 | PASS |
| label on commerce accent | `#FFFFFF` | `#8A4B24` | 6.75 | 4.5 | PASS |
| success on surface | `#1B6B45` | `#FFFDF7` | 6.38 | 4.5 | PASS |
| warning on surface | `#7E5406` | `#FFFDF7` | 6.54 | 4.5 | PASS |
| danger on surface | `#A32721` | `#FFFDF7` | 7.19 | 4.5 | PASS |
| muted text on progress trough | `#575F58` | `#DFD8C7` | 4.64 | 4.5 | PASS |
| control outline on ground | `#83887E` | `#F5F1E8` | 3.22 | 3.0 | PASS |
| control outline on surface | `#83887E` | `#FFFDF7` | 3.57 | 3.0 | PASS |
| session progress fill on trough | `#575F58` | `#DFD8C7` | 4.64 | 3.0 | PASS |
| caliper ring on surface | `#83887E` | `#FFFDF7` | 3.57 | 3.0 | PASS |
| caliper ring on ground (kiosk) | `#83887E` | `#F5F1E8` | 3.22 | 3.0 | PASS |
| breadcrumb separator on surface | `#575F58` | `#FFFDF7` | 6.49 | 4.5 | PASS |
| link-card boundary on surface | `#83887E` | `#FFFDF7` | 3.57 | 3.0 | PASS |
| focus ring on ground | `#0F5136` | `#F5F1E8` | 8.28 | 3.0 | PASS |
| progress trough on ground | `#DFD8C7` | `#F5F1E8` | 1.26 | — | decoration |
| hairline rule on ground | `#E3DCCC` | `#F5F1E8` | 1.21 | — | decoration |
| rim (478) on ground | `#33407F` | `#F5F1E8` | 8.54 | 3.0 | PASS |
| rim (box) on ground | `#6E3C69` | `#F5F1E8` | 7.41 | 3.0 | PASS |
| rim (coherent) on ground | `#8C2F49` | `#F5F1E8` | 7.12 | 3.0 | PASS |
| rim (sigh) on ground | `#125A62` | `#F5F1E8` | 6.99 | 3.0 | PASS |
| rim (extended) on ground | `#7A5310` | `#F5F1E8` | 6.06 | 3.0 | PASS |
| rim (triangle) on ground | `#2C5273` | `#F5F1E8` | 7.27 | 3.0 | PASS |
| rim (wim) on ground | `#993A20` | `#F5F1E8` | 6.25 | 3.0 | PASS |
| rim (478) on its own fill | `#33407F` | `#C5C5E0` | 5.70 | 3.0 | PASS |
| rim (box) on its own fill | `#6E3C69` | `#DABFD6` | 4.94 | 3.0 | PASS |
| rim (coherent) on its own fill | `#8C2F49` | `#E5BDC4` | 4.74 | 3.0 | PASS |
| rim (sigh) on its own fill | `#125A62` | `#A2CFD5` | 4.66 | 3.0 | PASS |
| rim (extended) on its own fill | `#7A5310` | `#D8C4AD` | 4.04 | 3.0 | PASS |
| rim (triangle) on its own fill | `#2C5273` | `#B5C9E2` | 4.85 | 3.0 | PASS |
| rim (wim) on its own fill | `#993A20` | `#E4BFB4` | 4.16 | 3.0 | PASS |
| phase word on fill (478) | `#1C2320` | `#C5C5E0` | 9.49 | 7.0 | PASS |
| phase word on fill (box) | `#1C2320` | `#DABFD6` | 9.46 | 7.0 | PASS |
| phase word on fill (coherent) | `#1C2320` | `#E5BDC4` | 9.47 | 7.0 | PASS |
| phase word on fill (sigh) | `#1C2320` | `#A2CFD5` | 9.48 | 7.0 | PASS |
| phase word on fill (extended) | `#1C2320` | `#D8C4AD` | 9.48 | 7.0 | PASS |
| phase word on fill (triangle) | `#1C2320` | `#B5C9E2` | 9.47 | 7.0 | PASS |
| phase word on fill (wim) | `#1C2320` | `#E4BFB4` | 9.47 | 7.0 | PASS |
| fill (478) on ground | `#C5C5E0` | `#F5F1E8` | 1.50 | — | decoration |
| fill (box) on ground | `#DABFD6` | `#F5F1E8` | 1.50 | — | decoration |
| fill (coherent) on ground | `#E5BDC4` | `#F5F1E8` | 1.50 | — | decoration |
| fill (sigh) on ground | `#A2CFD5` | `#F5F1E8` | 1.50 | — | decoration |
| fill (extended) on ground | `#D8C4AD` | `#F5F1E8` | 1.50 | — | decoration |
| fill (triangle) on ground | `#B5C9E2` | `#F5F1E8` | 1.50 | — | decoration |
| fill (wim) on ground | `#E4BFB4` | `#F5F1E8` | 1.50 | — | decoration |
| NIGHT body text on ground | `#EDE7DA` | `#15191A` | 14.37 | 4.5 | PASS |
| NIGHT body text on surface | `#EDE7DA` | `#1E2426` | 12.76 | 4.5 | PASS |
| NIGHT muted on ground | `#A7AEA4` | `#15191A` | 7.79 | 4.5 | PASS |
| NIGHT muted on surface | `#A7AEA4` | `#1E2426` | 6.91 | 4.5 | PASS |
| NIGHT link / primary on ground | `#5FBF92` | `#15191A` | 7.89 | 4.5 | PASS |
| NIGHT label on primary | `#15191A` | `#5FBF92` | 7.89 | 4.5 | PASS |
| NIGHT commerce accent on ground | `#D9A279` | `#15191A` | 7.92 | 4.5 | PASS |
| NIGHT success on surface | `#6FCB9B` | `#1E2426` | 8.01 | 4.5 | PASS |
| NIGHT warning on surface | `#E0B25C` | `#1E2426` | 8.01 | 4.5 | PASS |
| NIGHT danger on surface | `#F0918A` | `#1E2426` | 6.83 | 4.5 | PASS |
| NIGHT control outline on ground | `#767D77` | `#15191A` | 4.19 | 3.0 | PASS |
| NIGHT control outline on surface | `#767D77` | `#1E2426` | 3.72 | 3.0 | PASS |
| NIGHT session progress fill on trough | `#A7AEA4` | `#2B3233` | 5.75 | 3.0 | PASS |
| NIGHT caliper ring on surface | `#767D77` | `#1E2426` | 3.72 | 3.0 | PASS |
| NIGHT caliper ring on ground (kiosk) | `#767D77` | `#15191A` | 4.19 | 3.0 | PASS |
| NIGHT rim (478) on ground | `#93A2E8` | `#15191A` | 7.23 | 3.0 | PASS |
| NIGHT rim (box) on ground | `#D59CCB` | `#15191A` | 7.97 | 3.0 | PASS |
| NIGHT rim (coherent) on ground | `#F2909F` | `#15191A` | 7.81 | 3.0 | PASS |
| NIGHT rim (sigh) on ground | `#5FC7D1` | `#15191A` | 8.92 | 3.0 | PASS |
| NIGHT rim (extended) on ground | `#E0B25C` | `#15191A` | 9.02 | 3.0 | PASS |
| NIGHT rim (triangle) on ground | `#8FBBE3` | `#15191A` | 8.76 | 3.0 | PASS |
| NIGHT rim (wim) on ground | `#F0916B` | `#15191A` | 7.56 | 3.0 | PASS |
| NIGHT rim (478) on the one dark fill | `#93A2E8` | `#1E2426` | 6.42 | 3.0 | PASS |
| NIGHT rim (box) on the one dark fill | `#D59CCB` | `#1E2426` | 7.07 | 3.0 | PASS |
| NIGHT rim (coherent) on the one dark fill | `#F2909F` | `#1E2426` | 6.94 | 3.0 | PASS |
| NIGHT rim (sigh) on the one dark fill | `#5FC7D1` | `#1E2426` | 7.92 | 3.0 | PASS |
| NIGHT rim (extended) on the one dark fill | `#E0B25C` | `#1E2426` | 8.01 | 3.0 | PASS |
| NIGHT rim (triangle) on the one dark fill | `#8FBBE3` | `#1E2426` | 7.78 | 3.0 | PASS |
| NIGHT rim (wim) on the one dark fill | `#F0916B` | `#1E2426` | 6.71 | 3.0 | PASS |
| NIGHT phase word on the one dark fill | `#EDE7DA` | `#1E2426` | 12.76 | 7.0 | PASS |

Do **not** publish a formal WCAG or EN 301 549 conformance claim (hard rule 12).
This table is our own measurement, nothing more.

---

## 10. Where this could go wrong

An honest register of the bets in this identity, and what to do if one of them
turns out badly.

1. **Warm paper is bright on OLED.** `#F5F1E8` full-screen on a modern phone at
   night is a lot of light. This is why dark-by-preference is honoured for
   everyone rather than sold as a Pro feature, and why the night circle is a
   dark disc with a light rim. If people still complain, dim `--paper` toward
   `#EFEADF` before touching anything else — the contrast table has headroom.

2. **Newsreader is fragile below 30px on low-DPI Windows.** It is an optical-size
   serif and at 13–15px on a 96dpi panel the hairlines thin out. The system
   already forbids serif on anything small or clickable; if a page turns out to
   be setting Newsreader at body size, that is a bug in the page, not a reason
   to change the face.

3. **Box vs the primary green.** The board's box rim was 8.2° from `--green` and
   read as the site colour rather than as a technique. It is now mulberry at
   329.8°. If mulberry ever tests badly for "grounding", move it — but keep the
   28° minimum from the primary and from every other rim, and re-run the hue
   table.

4. **28.7° is the tightest hue gap** (478 vs triangle, both blues). They are far
   apart in chroma (40.4 vs 23.1) which does most of the separating work, but
   the pill dot is only 9px. That is why the active state is a doubled border
   *plus* weight 600, and why every pill carries its name in words.

5. **The fill is 1.5:1 against the page.** That is deliberate — the rim is the
   boundary — but it will look "washed out" to anyone expecting the old solid
   disc. Resist raising it. Raising the fill's chroma is what pushes the phase
   word toward failing.

6. **If session completion drops after this rebrand, slow the exhale easing
   before you restore anything.** The most likely cause is that the exhale now
   ends decisively rather than fading away. Try
   `cubic-bezier(.42, 0, .18, 1)` on the exhale, then a longer notch fade.
   Do not bring back the glow: it was never what made people finish.

7. **The notch fade depends on a CSS transition.** In a throttled preview the
   transition can sit pinned at its start value. On a real, visible tab it runs;
   the cascade itself was verified (removing the transition puts the notch at
   opacity 0 during a hold). If the closed notch is ever reported as not
   working in a real browser, move it to a keyframe animation keyed to
   `[data-phase]` — the mechanism is already used for the phase word and the
   reduced-motion pacing ring.

8. **`--clay` on paid surfaces only** is a discipline, not a mechanism. Nothing
   in the CSS stops someone putting a clay price on the timer screen. If it
   starts leaking, add a lint rule rather than a new token.
