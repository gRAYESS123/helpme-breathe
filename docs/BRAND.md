# Help Me Breathe — Brand Guide

**Lantern.** Owner decision, 2026-09-13, on the second pass of the proposal
board (the first pass drew eight comments; every one of them is a rule below).
It replaces Paper and Ink (2026-09-10 to 2026-09-13).

The breathing circle is a soft light in still air. The **stage** is where you
breathe: daylight, faintly coloured by the pattern you chose, slowly moving,
with the orb as the light in the middle. The **page** is where you read: the
same quiet ground, rounded white cards, one deep teal for links, black pills
for actions. Deep Sleep dims the room to dusk, never black. Night mode, chosen
or preferred, makes the whole site the dimmed room. One mark stays from the
previous identity: the ring with a 48° gap at twelve o'clock, as the logo and
as the gauge around the orb.

The name stays **Help Me Breathe**. No emoji anywhere, at any size.

`css/styles.css` is the implementation of this document. `docs/PAGE_CONTRACT.md`
is the copy-paste recipe for building or converting a page.

---

## 1. The owner's rules

These came from the owner's own comments on the board. They are not up for
re-interpretation by an agent.

1. **A calming animated background is valuable.** Three washes of the
   pattern's colour drift behind the orb on a loop of about a minute. Keep it.
2. **No black background unless it is necessary, like sleep.** Every stage is
   daylight. Deep Sleep dims to dusk (`#1F2745`, a deep blue). Night mode is
   the only time the whole site goes dark, and the visitor chooses it (or
   their OS prefers it).
3. **No borders, only rounded cards.** Nothing has a `border`. A card is a
   rounded shape lifted by one soft shadow; a control is a filled pill; a
   field is a well. The only lines are hairlines between the rows of a list
   or a table.
4. **No coloured dot circles**, on chips, on cards, anywhere. A pattern is
   named in words and counted in mono. The only circles on the site are the
   orb, its halos, the gauge and the mark.
5. **No cheap hues.** The seven pattern colours are tonal and low in chroma:
   a deep tone and a soft orb of the same hue. Pastel-on-black is gone.
6. **No coloured stripe on the caution card.** The caution is a sand card,
   the crisis block a rose card. The words carry the weight.

---

## 2. Tokens

### The page, day

| Token | Value | Role |
|---|---|---|
| `--ground` | `#F4F6F5` | Page ground. Mist. |
| `--surface` | `#FFFFFF` | Cards. |
| `--well` | `#EAEEEC` | Fields, quiet pills, the trough. |
| `--ink` | `#0F1B1E` | Text. Also the mark and every primary button. |
| `--muted` | `#5C6B6E` | Muted text. |
| `--line` | `#DDE3E1` | A hairline **between rows**. Never around a shape. |
| `--link` | `#1E5F5A` | Links, the active nav item, the focus ring. |
| `--action` / `--on-action` | `#0F1B1E` / `#F7F8F7` | Primary buttons and their label. |
| `--sand` | `#F5EEE0` | The caution card. |
| `--rose` | `#F6E6E3` | The crisis card. |
| `--ok` / `--warn` / `--bad` | `#1F6B4B` / `#8A5A0A` / `#B23A2E` | Status text only. |
| `--lift` | `0 1px 2px rgba(15,27,30,.04), 0 14px 34px -22px rgba(15,27,30,.28)` | The card shadow. |
| `--lift-high` | `0 2px 4px rgba(15,27,30,.05), 0 24px 48px -24px rgba(15,27,30,.35)` | Something raised: a popover, the consent sheet, the mobile menu. |

### The page, night

| Token | Value |
|---|---|
| `--ground` | `#0F1620` |
| `--surface` | `#182430` |
| `--well` | `#1F2D3A` |
| `--ink` | `#EEF2F0` |
| `--muted` | `#9DB0B3` |
| `--line` | `#24343A` |
| `--link` | `#8FD3C4` |
| `--action` / `--on-action` | `#EEF2F0` / `#0F1620` |
| `--sand` / `--rose` | `#2B2A22` / `#33262A` |
| `--ok` / `--warn` / `--bad` | `#6FCB9B` / `#E5B96A` / `#F09A8E` |

Night is a choice, never a device default: the OS dark preference does not change the page (owner decision 2026-09-16). `body.night` — set by the Pro night toggle in `js/pro/night.js` —
redefines every token for the dimmed room; `body.day` is the explicit way back.

### The stage

The stage's colours are a second set, `--stage-bg`, `--stage-ink`,
`--stage-muted`, `--stage-surface`, `--stage-well`, `--stage-line`,
`--stage-link`, `--stage-action`, `--stage-on-action`, `--stage-sand`,
`--stage-rose`, `--track`, `--chip-on`, `--on-chip`. In daylight they equal
the page's. Deep Sleep sets them to dusk; night sets them to night. Inside
`.breathing-section` — and, on a page with a timer, in the site header and
the page title above it — the page tokens are **remapped** to the stage
tokens (`--ink: var(--stage-ink)` and so on), so any component placed there
reads the right colours without knowing which room it is in.

| Dusk (Deep Sleep, day) | Value |
|---|---|
| `--stage-bg` | `#1F2745` |
| `--stage-ink` / `--stage-muted` | `#EEF2F0` / `#A9B2CC` |
| `--stage-surface` | `#2A3253` |
| `--stage-well` / `--stage-line` / `--track` | `rgba(238,242,240,.09)` / `.14` / `.14` |
| `--stage-link` | `#B9C3F0` |
| `--stage-action` / `--stage-on-action` | `#EEF2F0` / `#1F2745` |
| `--stage-sand` / `--stage-rose` | `#3A3552` / `#3F2F3E` |

**Every colour is a token.** No component may define a colour that exists
only inside a media query or a `.night` block.

### Legacy aliases

The Paper and Ink names still resolve, in the new palette, so `css/pro.css`,
`css/account.css` and any page not yet converted keep rendering: `--paper`,
`--leaf`, `--graphite`, `--rule`, `--edge` (now a hairline, not an outline),
`--green` (now `--link`), `--chalk`, `--clay` (now `--ink`), `--track`,
`--shadow-sheet`, `--shadow-lift`, `--rim` (now `--pat`), `--fill` (now
`--orb`), `--display` and `--ui` (both Figtree). Do not use them in new work.

---

## 3. The seven patterns

Each pattern is a **deep tone** (`--pat-*`: the gauge, the eyebrow, the active
chip) and an **orb** (`--orb-*`: the disc), with three **washes** for the air.
All seven measure at least 5.5:1 as a deep tone on the ground and carry white
chip text at 6:1 or better. The phase word is ink on every orb, at 10.7:1 or
better.

| Pattern | Deep tone | Orb | Air |
|---|---|---|---|
| Deep Sleep (`478`) | dusk, `#C3C9E6` as the working colour | `#C3C9E6` | `#39447E` `#2B3D6B` `#4A3E72` on `#1F2745` |
| Focus & Grounding (`box`) | plum `#5B4A5E` | `#D6C7D7` | `#E4D2E4` `#F0E2DC` `#D2DADE` |
| Heart Coherence (`coherent`) | dusty rose `#7A4A52` | `#E3CACC` | `#F0D5D7` `#F2E6D8` `#D9DEE2` |
| Cyclic Sighing (`sigh`) | sea `#2F5F66` | `#C6DCDE` | `#D0E6E8` `#E5ECDE` `#DADBEA` |
| Extended Exhale (`extended`) | sand `#7A5F34` | `#E4D6BC` | `#EEE0C4` `#EAE2D7` `#D8E0DD` |
| Quick Calm (`triangle`) | slate `#3E5670` | `#C9D5E2` | `#D4E0EC` `#E8E6DC` `#D6DEDE` |
| Energizing Breath (`wim`) | terracotta `#8A4E38` | `#E8CCBB` | `#F2D8C8` `#EEE6DA` `#DCE0DE` |

**Deep Sleep dims the room.** `body.theme-478` — and a 4-7-8 timer root on
any other page, via `[data-breathing-app][data-technique="478"]` — sets the
dusk stage tokens. Every other pattern is daylight. A technique switch
cross-fades the room over 500ms: the stage tokens and the washes are
registered with `@property` so the transition is smooth.

**At night** the deep tones lighten to their orbs (`--pat-*` = `--orb-*`),
because a deep tone on a night ground would not clear 3:1, and the washes
are the pattern's colour mixed into the night ground at 12–22%.

---

## 4. Type

| Face | Where |
|---|---|
| **Figtree 300** (Google Fonts, OFL) | Display: `h1`, `h2`, the phase word, the hero. Never under 24px. |
| **Figtree 400 / 500 / 600** | Everything else: body, `h3` and below, nav, buttons, chips, labels, forms. Nothing a person taps is lighter than 500. |
| **DM Mono 400 / 500** | Anything counted: the pattern line ("In 4 · Hold 7 · Out 8"), the count under the phase word, the session clock, prices, dates, table numerics, and every small uppercase label (`.eyebrow`, breadcrumbs, footer headings). |

The real unit of the site is the second. Counts, clocks, prices and dates in
mono line up, tabulate for free, and mark the instrument out from the prose.

Micro type floor is **12px** (`--fs-micro: 0.75rem`). Body is 16px / 1.6.

```
--sans: 'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
        'Helvetica Neue', Arial, sans-serif;
--mono: 'DM Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
```

Loading (preconnect + non-blocking, on every page):

```
https://fonts.googleapis.com/css2?family=Figtree:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap
```

---

## 5. The mark

Unchanged in geometry from Paper and Ink: a ring, radius 40 on a 100-unit
grid, stroke 9, butt caps, a **48° gap centred at twelve o'clock**.

```html
<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
  <path d="M66.27 13.46 A40 40 0 1 1 33.73 13.46"
        fill="none" stroke="currentColor" stroke-width="9"/>
</svg>
```

- **Ink on mist** in normal use; **bone** at night and on the dusk stage. The
  lockup inherits `currentColor`, so it is always the same colour as the
  wordmark beside it.
- **Wordmark:** Figtree 500, "Help Me Breathe", 17px, tracking `-0.01em`.
- At 420px and below the lockup shortens to the ring.

### Favicon and app icon

`tools/brand/build-assets.mjs --only=icons,logo` regenerates everything from
`tools/brand/tokens.mjs`: `favicon.svg` (ink ring, bone in dark chrome, on a
transparent ground), `favicon-16.png`, `favicon-32.png`, and the app icons as
an **ink tile with a mist ring** (`images/icon-192.png`, `icon-512.png`,
`apple-touch-icon.png`). `manifest.json` carries `background_color #F4F6F5`
and `theme_color #0F1B1E`; every page's `theme-color` is `#F4F6F5` with a
`#0F1620` dark-scheme entry listed first.

The Open Graph cards and the Pinterest pins (`images/og/`, `images/pins/`)
were rendered under Paper and Ink and have **not** been re-rendered yet. They
are images; nothing on the site depends on them being updated first.

---

## 6. The stage

`css/styles.css` section 7. Three objects, one idea.

- **The orb** (`.breathing-circle`) is the pattern's tint, 74% of the stage
  at full inhale, scaling between 0.72 and 1.00 with the breath, lit from
  within by a soft glow (`box-shadow` in the orb's own colour at 55%). Two
  **halo rings** are drawn on it as pseudo-elements at −6% and −13%, in the
  deep tone at 22% and 11% opacity, so they scale with it and just reach the
  gauge at the top of the breath. The phase word sits on it in ink
  (`--disc-ink: #0F1B1E`) in Figtree 300, with the count beneath in mono.
- **The gauge** (`.ring-track` / `.ring-live` / `.ring-bridge` at r=150 on a
  320 stage) is the mark, alive: a 2px rail in `--track` with the 48° gap; a
  3px live arc in the deep tone that **fills clockwise on an in-breath,
  drains on an out-breath and holds through a hold**; and a bridge that
  closes the gap for as long as you hold. `js/app.js` publishes `--ring-from`
  / `--ring-to` (816.81 empty, 0 full) at every phase boundary. This contract
  is unchanged.
- **The air** (`.breathing-section > .air`, three `<i>` washes) is dropped in
  by `js/stage.js` and reaches from the top of the page to the bottom of the
  timer section. Each wash is a radial of one of the pattern's air colours,
  84vmin across (the third 64vmin), drifting and swelling over 52–64 seconds
  and reversing. `js/stage.js` also measures `--stage-h` and `--stage-above`
  so the stage's ground (painted as a band on `body`) ends exactly where the
  section does. Without the script the band is one screen tall and the
  washes start at the section — still correct.

The **app bar** is left-aligned: the eyebrow (the pattern's short name, mono),
the pattern's name (Figtree 500), the pattern line (mono), and the gear at the
right as a well circle. Begin is the black pill; Pause takes it over while a
session runs; Stop is a well pill. The seven chips are well pills with no dot;
the active one is filled in the pattern's deep tone (its orb at dusk and at
night). On a phone the chips scroll sideways in one row.

**Two timers on one page** (`.timer-pair`): each timer root is its own room —
a rounded card in its own stage colours — and the page-wide band and the
washes are off.

---

## 7. Motion

| | |
|---|---|
| Inhale | orb 0.72 → 1.00, `cubic-bezier(.33, 0, .20, 1)` |
| Exhale | 1.00 → 0.72, `cubic-bezier(.42, 0, .30, 1)` |
| Hold | still (0.4% drift) |
| Cyclic sighing top-up | overshoots to 1.08 |
| Phase word | cross-fade, 160ms, opacity only |
| Gauge | `stroke-dashoffset`, linear, over the phase duration |
| Bridge | 240ms linear, opacity only |
| The air | each wash: translate 7% / 5% and scale 1 → 1.14, 52–64s, ease-in-out, alternate |
| Technique switch | stage tokens, washes and orb cross-fade over 500ms; the page below never moves |
| A press | 1px of travel, no transition |

The pattern keyframes (`breathe-478` … `breathe-wim`) are unchanged: each
block's percentages are that pattern's phase boundaries, and the cycle length
is declared in CSS as well as inline by `js/app.js`. Change a duration in
`js/techniques.js` and you must change the matching `animation-duration`.

### Reduced motion

Targeted rules, never a blanket transition kill. The orb holds one size
(0.86); the gauge still fills and drains; the count still ticks; the bridge
opens and closes instantly; **the air holds still**; the technique cross-fade
is off. Audio and vibration cues are not motion and are not touched.

---

## 8. Components

| Component | Rule |
|---|---|
| Buttons | pills (`--radius-pill`), no border, 44px minimum rendered height (52px for Begin). Primary = `--action` / `--on-action`. Secondary = `--well`. Quiet = text in `--link`. Hover on a primary is opacity .88, never a colour change. |
| Chips | well pills, no dot. Active = the pattern's `--chip-on` fill with `--on-chip` text, weight 600. |
| Fields | wells (`--well`), radius 14px, no border. The focus ring is the boundary. |
| Switch | a well track with a muted knob; `--action` with an `--on-action` knob when on. The track is 30px, the hit area 44px. |
| Settings | a sheet: `--surface`, radius 18px, `--lift-high`. |
| Cards | `--surface`, radius 18px (24px for the plan card), `--lift`. Hover lifts to `--lift-high`. Never a border. |
| Caution callout | a `--sand` card, no stripe. |
| Crisis block | a `--rose` card; helpline numbers in mono. |
| Neutral callout | a `--surface` card. |
| Steps | one card per step, the number in mono (`01`, `02` …) at the left. |
| FAQ | one card per question. |
| Article header | breadcrumb (mono eyebrow) → `h1` (Figtree 300) → lead → a hairline-ruled strip: author and role on the left, Published / Reviewed dates in mono on the right. **The site has no medical reviewer. Never invent one.** |
| Pricing | the price is the biggest thing on the surface, in mono, in ink; the tax line beneath in the same voice; the interval switch a segmented pill on a well; the trial terms in one well; one black pill. No matrix, no columns, no ticks and crosses. |
| Consent sheet | a rounded `--surface` sheet along the bottom edge. **Decline is listed first and weighted exactly the same as Accept**; both are well pills. |
| Ad slot | a well, radius 18px, the "Advertisement" label in mono. Reserved height so CLS stays 0. |
| Footer | hairline top rule, four link columns with mono headings, the authorship byline, the legal row. |
| Site header | on every page: the lockup and nav Timer · Guides · Science · Pro. **White on a reading page; transparent on the stage.** The Pro link is not accent-coloured. At 640px and below the nav collapses into a lifted sheet behind a Menu pill. |

---

## 9. Do and don't

**Do**

- Let the pattern's colour touch four things: the orb, the gauge, the eyebrow,
  the active chip.
- Put anything counted in DM Mono.
- Keep the page ground identical on every reading page.
- Write the count, the phase and the remaining time as plain text. A person
  half-asleep should not have to interpret a colour.

**Don't**

- Don't draw a border. If a shape needs an edge, it needs a shadow or a fill.
- Don't put a dot next to a name.
- Don't make anything black that is not the dusk room or a primary button.
- Don't put a coloured stripe on a card.
- Don't add a third shadow, a fourth wash, or a gradient anywhere but the air.
- Don't reach for an emoji.

---

## 10. Measured contrast

Computed with the WCAG 2.x relative-luminance formula. Nothing on the site sits
below 4.5:1 as text or 3:1 as a control.

| Pair | Ratio |
|---|---|
| ink on ground / on white | 16.18 / 17.56 |
| muted on ground / on white | 5.11 / 5.55 |
| link on white / on ground | 7.40 / 6.81 |
| on-action on action | 17.56 |
| ink on sand / on rose | 15.21 / 14.51 |
| muted on sand / in a well | 4.81 / 4.74 |
| each deep tone on ground | box 7.48 · coherent 6.61 · sigh 6.56 · extended 5.51 · triangle 6.98 · wim 5.99 |
| white on each deep tone (the active chip) | 8.12 · 7.17 · 7.12 · 5.98 · 7.58 · 6.51 |
| ink on each orb (the phase word) | 10.88 · 11.36 · 12.29 · 12.25 · 11.79 · 11.53; dusk orb 10.72 |
| bone on dusk / dusk muted on dusk | 12.96 / 6.92 |
| dusk orb on dusk (the gauge) | 8.94 |
| NIGHT ink on ground / on surface | 16.09 / 14.26 |
| NIGHT muted on surface | 6.97 |
| NIGHT link on ground | 10.63 |

Do **not** publish a formal WCAG or EN 301 549 conformance claim. This table is
our own measurement, nothing more.

---

## 11. Where this could go wrong

1. **The dusk room on a daytime page.** Deep Sleep dims the room wherever it
   is the pattern, including `/breathing-exercises-anxiety`, which opens on
   4-7-8. If that reads wrong, the fix is the page's `data-technique`, not the
   rule.
2. **The washes are subtle by design.** On a low-contrast panel they can
   vanish. Before raising their chroma, raise their size; the tints are one
   step from the ground so the text on top never loses contrast.
3. **`:has()` carries the stage band.** Browsers without it (Firefox before
   121, Safari before 15.4) get a white header on a timer page and no band;
   the timer itself is unaffected.
4. **`@property` carries the cross-fade.** Without it the technique switch
   cuts instead of fading. Nothing breaks.
5. **Three drifting elements on a phone.** They are transform-only and
   `will-change: transform`; if a low-end device stutters, drop the third
   wash before touching the orb.
6. **Figtree 300 on low-DPI Windows** thins out under 24px. The system already
   forbids it there; if a page sets 300 at body size, that is a bug in the
   page.
