# Page Contract — Help Me Breathe

Copy-paste blocks for building or converting a page to the **Lantern**
identity (owner decision, 2026-09-10). Everything here is exact: paste it, then
change only what the notes tell you to change. `docs/BRAND.md` says why.

A faster start for a new page: copy `templates/technique-page.template.html`,
delete its `<meta name="robots" content="noindex, nofollow">` line, and replace
the `{{PLACEHOLDERS}}`: `{{TITLE}}`, `{{DESCRIPTION}}`, `{{SLUG}}`, `{{H1}}`,
`{{SUBTITLE}}`, `{{BREADCRUMB_NAME}}`, `{{THEME}}`, `{{CIRCLE_CLASS}}`,
`{{TECHNIQUE}}`, `{{DURATION}}`, `{{OG_IMAGE}}`, `{{PUBLISHED}}`, `{{UPDATED}}`,
`{{PROSE}}`, `{{JSONLD}}`.

Rules that are not negotiable:

- Link and canonicalise to **clean URLs** (`/box-breathing`), never `.html`.
- Root-relative asset paths (`/css/styles.css`, `/js/app.js`).
- Exactly one `<h1>` per page. No `<h1>` inside the prose you write.
- No inline `onclick`. `data-action` only.
- No ad slot, no paywall prompt, no email capture and no affiliate link on
  `/breathing-exercises-anxiety`, `/breathing-exercises-for-panic-attacks`,
  `/pro` or `/pro/thanks`.
- Never put "Wim Hof" in a title, H1, meta description or slug.
- **No emoji. Anywhere. In any file.** Not in nav labels, not in card titles,
  not in a favicon data URI, not in a footer.
- No gradient, no `backdrop-filter`, no glow `box-shadow`, no `text-shadow`,
  no Quicksand, no Patreon brand red.

---

## 0. Conversion recipe — turning an old page into a Lantern page

Work top to bottom. Everything in **DELETE** is gone from the design system, so
leaving it in produces unstyled markup, not a fallback.

### DELETE

| Delete | Where it usually is |
|---|---|
| The Quicksand `<link rel="preload">` **and** its `<noscript>` twin | head |
| Any `fonts.googleapis.com` / `fonts.gstatic.com` link or preconnect (fonts are self-hosted since 2026-09-17) | head |
| The emoji favicon: the `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,...">` whose data URI contains an SVG `<text>` glyph | head |
| `<meta name="theme-color" content="#8b5cf6">` | head |
| `<div class="nature-bg"></div>` | first child of `<body>` |
| Every `<div class="natural-element …">` (stars, leaves, ripples, clouds, sun-rays) | after `nature-bg` |
| `<div class="breathing-aura"></div>` | inside `.breathing-container` |
| `<div class="breathing-particles">` and its six `<span class="particle-float">` | inside `.breathing-container` |
| The `<svg class="breathing-svg-filter">` block containing `<filter id="fluid-effect">` | inside `.breathing-container` (index only) |
| `class="patreon-btn"` | support links |
| Every emoji in a technique name, nav label, card title, switcher link or footer | everywhere |

### ADD / REPLACE

1. **Head** — replace the favicon, theme-color and font blocks with §1 below.
2. **Site header** — paste §2 immediately after the skip link, before
   `<div class="container">`. It goes on **every** page, timer or not.
3. **Article header** — if the page has a breadcrumb + `h1`, rewrap it as §3.
4. **Timer section** — if the page has a timer, replace the whole
   `.breathing-section` with §4. The changes inside it are: the `.app-bar`
   wrapper around the `h2` + settings button, an SVG gear instead of the emoji,
   the caliper/pacer `<svg>`, the `.circle-notch`, and `.circle-text-container`
   moved **out of** `.breathing-circle` and given a `[data-role="phase-count"]`.
5. **Technique switcher** — §5, plain text labels.
6. **Prose** — unchanged markup; use the callout/crisis/citation blocks in §7
   where the page has warnings or sources.
7. **Footer** — replace the three `<nav class="footer-nav">` blocks with the
   four-column block in §8, plus the byline and legal row.
8. **Support links** — delete the whole block (`class="patreon-btn"`,
   `.support-options` and its heading). Nothing replaces it: there is no
   support ask anywhere on the site (§9).

### CHECK

Run these from the repo root and drive both to zero for the file you changed:

```
grep -nE "Quicksand|linear-gradient|radial-gradient|conic-gradient|backdrop-filter|text-shadow|blur\(|nature-bg|natural-element|breathing-particles|particle-float|breathing-aura|breathing-svg-filter|fluid-effect|patreon-btn|#8b5cf6|#1e1b4b|#f96854" <file>

python -c "import re,sys; pat=re.compile('[\U0001F300-\U0001FAFF\u2600-\u27BF\U0001F900-\U0001F9FF\uFE0F]'); [print(f, len(pat.findall(open(f,encoding='utf-8').read()))) for f in sys.argv[1:]]" <file>
```

Then `node tools/site-check.mjs` and fix every ERROR naming your file.

---

## 1. The `<head>` block

Replace the `{{…}}` values. Everything else is verbatim, **including the order
of the consent script** — the denied defaults must be pushed before
`gtag('config', …)`, and ES modules are deferred, so this cannot move into
`js/consent.js`. The Google Ads config (`AW-18182683015`, added 2026-09-15) is part of
the block; the Purchase conversion event lives only in `/pro/thanks` (see
`docs/MODULE_API.md` § Google Ads). `tools/site-check.mjs` rule `google-tag` fails the
build when a page carries one id without the other. The dark `theme-color` must come **first**: the first matching
one wins.

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">

    <title>{{TITLE}}</title>
    <meta name="description" content="{{DESCRIPTION}}">

    <link rel="canonical" href="https://helpmebreath.com/{{SLUG}}">

    <meta name="author" content="Georges Rayess">
    <meta name="robots" content="index, follow">

    <!-- Open Graph -->
    <meta property="og:title" content="{{TITLE}}">
    <meta property="og:description" content="{{DESCRIPTION}}">
    <meta property="og:type" content="article">
    <meta property="og:url" content="https://helpmebreath.com/{{SLUG}}">
    <meta property="og:image" content="https://helpmebreath.com/images/og/{{OG_IMAGE}}">
    <meta property="og:site_name" content="Help Me Breathe">

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="{{TITLE}}">
    <meta name="twitter:description" content="{{DESCRIPTION}}">
    <meta name="twitter:image" content="https://helpmebreath.com/images/og/{{OG_IMAGE}}">

    <!-- Favicon: the ring with a gap. Never an emoji data URI. -->
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
    <link rel="icon" href="/favicon-16.png" sizes="16x16" type="image/png">
    <link rel="apple-touch-icon" sizes="180x180" href="/images/apple-touch-icon.png">

    <!-- PWA -->
    <link rel="manifest" href="/manifest.json">
    <meta name="theme-color" content="#0F1620" media="(prefers-color-scheme: dark)">
    <meta name="theme-color" content="#F4F6F5">

    <!-- PERFORMANCE
         Fonts are self-hosted (2026-09-17). The @font-face rules sit at the top
         of /css/styles.css and the files under /fonts/, so there is no font
         origin to preconnect to. Do NOT add a <link rel="preload" as="font">:
         the LCP element on every page is a text block, font-display:swap paints
         it in the fallback at once, and a high-priority font preload measurably
         delayed the stylesheet (+780ms LCP when measured on 2026-09-17). -->
    <link rel="preload" href="/css/styles.css" as="style">
    <link rel="stylesheet" href="/css/styles.css">

    <!-- The module graph, started in parallel. Copy the list from
         templates/technique-page.template.html and drop any module this page
         does not load. It must match the page's own <script type="module">
         entries plus their static imports; dynamic import() targets
         (checkout.js, pro/soundscapes.js) stay out so they remain lazy. -->
    <link rel="modulepreload" href="/js/consent.js" fetchpriority="low">
    <link rel="modulepreload" href="/js/app.js" fetchpriority="low">
    <!-- …see the template for the full list… -->

    fetchpriority="low" is load-bearing, not decoration: at default priority
    these hints outrank /css/styles.css for bandwidth and push first paint out
    by ~780ms on a 1.6Mbps link. Keep it on every one of them.

    <!-- Google Consent Mode v2 — denied defaults BEFORE gtag config. Verbatim. -->
    <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('consent', 'default', {
            'ad_storage': 'denied',
            'ad_user_data': 'denied',
            'ad_personalization': 'denied',
            'analytics_storage': 'denied',
            'wait_for_update': 500
        });
        // With advertising storage denied, ad click identifiers are redacted from what
        // the browser sends (Consent Mode v2).
        gtag('set', 'ads_data_redaction', true);
        // Ad traffic only: keep the click id alive across same-site navigation when
        // ad_storage is denied. Gated on the query string so organic visitors never
        // get a _gl= parameter stapled to every internal link.
        if (/[?&](gclid|gbraid|wbraid|_gl)=/.test(location.search)) {
            gtag('set', 'url_passthrough', true);
        }
        gtag('js', new Date());
        gtag('config', 'G-TYLYLJSFHN', {
            'anonymize_ip': true,
            'cookie_expires': 63072000
        });
        // Google Ads: conversion measurement rides on the same Google tag and the
        // same Consent Mode gates. The Purchase conversion itself fires only on /pro/thanks.
        gtag('config', 'AW-18182683015');
    </script>
    <!-- The tag is fetched late (2026-09-17): at the first of idle-after-load,
         the visitor's first interaction, or a 2.5s ceiling. Everything above
         this point is unchanged and must stay put -- the consent defaults and
         both config calls queue into dataLayer, and gtag.js replays that queue
         in order when it arrives. Copy the injector verbatim from
         templates/technique-page.template.html. -->
    <script>
        /* …deferred gtag injector, verbatim from the template… */
    </script>

    <!-- JSON-LD blocks go here. See section 10. -->
</head>
```

| Value | Rule |
|---|---|
| `{{TITLE}}` | ≤ 65 characters. Never the bare head terms "breathing exercise" or "deep breathing". |
| `{{DESCRIPTION}}` | 50–165 characters. Same string in the meta, OG and Twitter tags. |
| `{{SLUG}}` | No leading slash, no `.html`. Legal pages use `legal/<name>`. |
| `{{OG_IMAGE}}` | `<slug>.jpg`. If `images/og/<slug>.jpg` does not exist, file an `og-image` integration request and point at `/images/og-breathing-timer.jpg` meanwhile. |

Do **not** paste an AdSense loader tag. `js/ads.js` injects it, only when it is
allowed.

## 2. `<body>`, the site header and the page frame

```html
<body class="theme-box article-page technique-page">
    <a class="skip-link" href="#main">Skip to main content</a>

    <header class="site-header">
        <div class="site-header-inner">
            <a class="lockup" href="/" aria-label="Help Me Breathe, home">
                <svg class="lockup-mark" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
                    <path d="M66.27 13.46 A40 40 0 1 1 33.73 13.46" fill="none" stroke="currentColor" stroke-width="9"/>
                </svg>
                <span class="wordmark">Help Me Breathe</span>
            </a>
            <button class="nav-toggle" type="button" data-action="toggle-nav" aria-controls="site-nav" aria-expanded="false">Menu</button>
            <nav class="site-nav" id="site-nav" aria-label="Main">
                <a href="/timer">Timer</a>
                <a href="/guides">Guides</a>
                <a href="/science">Science</a>
                <a href="/pro">Pro</a>
            </nav>
        </div>
    </header>

    <div class="container">
        <header class="article-header"><!-- section 3 --></header>

        <main id="main">
            <!-- timer section, switcher, prose, ad slot -->
        </main>

        <footer class="footer"><!-- section 8 --></footer>
    </div>

    <div class="keyboard-hint" data-role="keyboard-hint">
        Press <kbd>Space</kbd> to start or pause • <kbd>S</kbd> to stop
    </div>

    <script type="module" src="/js/consent.js"></script>
    <script type="module" src="/js/app.js"></script>
    <script type="module" src="/js/pro/index.js"></script>
    <!-- only on pages that carry an ad slot -->
    <script type="module" src="/js/ads.js"></script>
</body>
</html>
```

Notes:

- Add `aria-current="page"` to **one** `.site-nav` link, the one whose section
  this page belongs to. Do not remove the link — the header is identical
  everywhere.
- The `Menu` button needs no page script. `js/app.js` wires
  `[data-action="toggle-nav"]` once per page, and every page already loads it.
- The **Pro link is not accent-coloured.** It is a nav item like the others.
- Body classes: `theme-*` (the technique's theme from `js/techniques.js`),
  `article-page` (prose typography), `technique-page` (timer on top, prose
  below). Crisis-safe pages also carry
  `data-no-ads="true" data-no-asks="true" data-open-timer="true"` on `<body>`
  (and nowhere else: `tools/site-check.mjs` enforces the allowlist).
- The cookie banner is **not** page markup. `js/consent.js` injects it, with
  "Essential only" listed first.

## 3. The article header block

Breadcrumb eyebrow, `h1`, lead, then a hairline-ruled strip: author name and
role on the left, dates in tabular figures on the right.

```html
<header class="article-header">
    <nav aria-label="Breadcrumb">
        <ol class="breadcrumb">
            <li><a href="/">Home</a></li>
            <li><a href="/timer">Breathing timers</a></li>
            <li>Box breathing</li>
        </ol>
    </nav>
    <h1>Box Breathing Timer</h1>
    <p class="lead">One sentence saying what the page gives you.</p>
    <div class="article-meta">
        <p class="article-byline"><strong>Georges Rayess</strong> <span class="article-role">— writes and maintains Help Me Breathe. Not a clinician.</span></p>
        <p class="article-dates">Published 2026-09-10 &middot; Updated 2026-09-10</p>
    </div>
</header>
```

**The site has no medical reviewer. Never invent one.** If a page has not been
reviewed by anyone, it says Published and Updated and nothing else. Writing
"Reviewed by …" for a review that did not happen is a fabricated credential.

On a page with no author strip (a legal page, `/pro`), drop `.article-meta`
and keep the breadcrumb, `h1` and lead.

## 4. The timer section — exact snippet

Paste this inside `<main>`. It carries every `data-role` the engine knows and
both slots. Change only the four marked spots: `data-technique`,
`data-duration` (default seconds for a first-time visitor; `-1` = unlimited),
`data-lock-technique` (delete it on a hub page that lets people switch), and the
circle's `technique-*` class.

```html
<section class="breathing-section"
         data-breathing-app
         data-technique="box"
         data-duration="300"
         data-lock-technique
         aria-labelledby="timer-heading">

    <div class="app-bar">
        <div class="technique-head">
            <p class="technique-eyebrow" data-role="technique-eyebrow"></p>
            <h2 id="timer-heading" data-role="technique-title">Box breathing</h2>
            <p class="pattern-line" data-role="pattern-line"></p>
        </div>
        <button class="settings-btn" type="button" data-role="settings-btn" data-action="toggle-settings" aria-label="Open settings" aria-expanded="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false">
                <circle cx="12" cy="12" r="3.2"/>
                <path d="M12 2.8v2.4M12 18.8v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7"/>
            </svg>
        </button>
    </div>

    <div class="settings-panel" data-role="settings-panel">
        <div class="setting-item">
            <span class="setting-label" id="label-sound">Sound</span>
            <div class="toggle-switch active" data-role="sound-toggle" role="button" tabindex="0" aria-pressed="true" aria-labelledby="label-sound"></div>
        </div>
        <div class="setting-item">
            <span class="setting-label" id="label-vibration">Vibration</span>
            <div class="toggle-switch active" data-role="vibration-toggle" role="button" tabindex="0" aria-pressed="true" aria-labelledby="label-vibration"></div>
        </div>
        <div class="setting-item">
            <label class="setting-label" for="session-duration">Session length</label>
            <select id="session-duration" class="duration-select" data-role="duration-select">
                <option value="180">3 minutes</option>
                <option value="300">5 minutes</option>
                <option value="600">10 minutes</option>
                <option value="900">15 minutes</option>
                <option value="1200">20 minutes</option>
                <option value="-1">Unlimited</option>
            </select>
        </div>
    </div>

    <div class="breathing-container">
        <svg class="breathing-guides" viewBox="0 0 320 320" aria-hidden="true" focusable="false">
            <circle class="ring-track" cx="160" cy="160" r="150"/>
            <circle class="ring-live" cx="160" cy="160" r="150"/>
            <circle class="ring-bridge" cx="160" cy="160" r="150"/>
        </svg>
        <div class="breathing-circle technique-box" data-role="circle">
            <span class="circle-notch" aria-hidden="true"></span>
        </div>
        <div class="circle-text-container">
            <span class="phase-word" data-role="circle-text">Ready</span>
            <span class="phase-count" data-role="phase-count"></span>
        </div>
    </div>

    <p class="breathing-text" data-role="breathing-text">Press Begin to start your practice</p>

    <div class="session-info" data-role="session-info" style="display: none;">
        <div class="session-progress">
            <div class="session-progress-fill" data-role="session-progress-fill"></div>
        </div>
        <div class="session-time-remaining" data-role="session-time-remaining"></div>
    </div>

    <div class="progress-bar">
        <div class="progress-fill" data-role="progress-fill"></div>
        <div class="progress-time" data-role="progress-time"></div>
    </div>

    <div class="timer" data-role="timer">00:00</div>

    <div class="session-stats" data-role="stats" style="display: none;">
        <div class="stat-item">
            <span class="stat-value" data-role="breath-count">0</span>
            <span class="stat-label">Breaths</span>
        </div>
        <div class="stat-item">
            <span class="stat-value" data-role="avg-breath">0s</span>
            <span class="stat-label">Avg. breath</span>
        </div>
        <div class="stat-item">
            <span class="stat-value" data-role="session-progress">0%</span>
            <span class="stat-label">Progress</span>
        </div>
    </div>

    <div class="controls">
        <button class="control-btn" type="button" data-role="start" data-action="start">Begin Practice</button>
        <button class="control-btn" type="button" data-role="pause" data-action="pause" disabled>Pause</button>
        <button class="control-btn" type="button" data-role="stop" data-action="stop" disabled>Stop</button>
    </div>

    <div class="safety-ack" data-role="safety-ack" hidden>
        <h3>Read this before you start this pattern</h3>
        <div data-role="safety-ack-body"></div>
        <div class="safety-ack-actions">
            <button class="control-btn" type="button" data-action="safety-ack-confirm">I understand, begin</button>
            <button class="control-btn" type="button" data-action="safety-ack-cancel">Not now</button>
        </div>
    </div>

    <!-- SLOT: post-session cards (paywall, printable capture) -->
    <div data-slot="post-session"></div>

    <!-- Technique pills go here on a hub page (see "Technique pills" below). -->

    <!-- SLOT: Pro tools (custom pattern, your practice, soundscapes, night mode) -->
    <div class="tools-row" data-slot="tools"></div>

    <div class="technique-info" data-role="technique-info"></div>

    <p class="live-region" data-role="live-region" aria-live="polite" aria-atomic="true"></p>
</section>
```

### What changed from the old snippet, and why

| Change | Reason |
|---|---|
| `<h2 data-role="technique-title">` sits inside `<div class="technique-head">` with an eyebrow (`data-role="technique-eyebrow"`, the technique's short name) and a pattern line (`data-role="pattern-line"`, "In 4 · Hold 7 · Out 8"); the head and the settings button are wrapped in `<div class="app-bar">` | The engine fills all three from the technique. The gear stays **inside the app root** because the engine scopes every `[data-role]` lookup to that root, and a comparison page carries two timers. |
| The settings button contains an inline SVG gear, not the gear emoji | No emoji. |
| `<svg class="breathing-guides">` carries three circles at r=150: `ring-track`, `ring-live`, `ring-bridge` | The mark around the disc: the rail with its 48° gap, the gauge that fills with the breath, and the bridge that closes the gap on a hold. See `docs/BRAND.md` §5. The old `caliper` / `pacer-ring` circles are legacy and draw nothing. |
| `<span class="circle-notch">` inside the circle | Legacy. Keep it in the markup; it draws nothing — the gap lives on the ring now. |
| The tools slot sits **below** the controls and pills, directly above `technique-info` | The Pro tools are a quieter row under the technique choice, not a bar above the controls. |
| `.circle-text-container` moved **out of** `.breathing-circle` | So the phase word does not scale with the circle. Pages that still nest it inside keep working, but move it when you convert. |
| `[data-role="phase-count"]` added | The engine writes the per-second count into it. Without the span there is no count; nothing else breaks. |
| `.breathing-aura`, `.breathing-particles`, `#fluid-effect` deleted | Gone from the design system. |

### Still true

- **Both slots are required** on every page with a timer, even if nothing fills
  them today. `[data-slot]:empty` is `display: none`, so they cost nothing.
- The **safety-ack panel is required** too. The engine only shows it for
  techniques with `requiresSafetyAck` (today: `wim`) and fills
  `[data-role="safety-ack-body"]` from that technique's contraindications.
- `[data-role="technique-info"]` is filled from the technique. Add `data-static`
  to it if you want to write that copy yourself.
- **App root.** `data-breathing-app` must sit on an element containing the whole
  timer UI. If your page has technique buttons **outside** the
  `.breathing-section`, move `data-breathing-app` up to the common ancestor (see
  `index.html`, where it is on `<main>`). The engine also writes `data-phase`
  and `--phase-duration` onto that element.
- **Two timers on one page** (comparison pages): duplicate the section, give each
  a different `data-technique`, wrap them in `<div class="timer-pair">`, and
  **suffix every `id`** (`timer-heading-a`, `label-sound-a`,
  `session-duration-a`, …, and the matching `for` / `aria-labelledby`).
  `data-role` values stay the same — they are scoped per root.
- **Kiosk mode** (`data-kiosk`) requires `data-breathing-app` on the
  `.breathing-section` itself.

### Technique pills

Plain text labels, one per technique. Each pill wears its own technique's
accent dot automatically from `data-technique`; you add no colour.

```html
<div class="technique-buttons" data-role="technique-buttons" role="group" aria-labelledby="technique-picker-heading">
    <button class="technique-btn active" type="button" data-action="select-technique" data-technique="478" aria-pressed="true">Deep Sleep</button>
    <button class="technique-btn" type="button" data-action="select-technique" data-technique="box" aria-pressed="false">Focus &amp; Grounding</button>
    <button class="technique-btn" type="button" data-action="select-technique" data-technique="coherent" aria-pressed="false">Heart Coherence</button>
    <button class="technique-btn" type="button" data-action="select-technique" data-technique="sigh" aria-pressed="false">Cyclic Sighing</button>
    <button class="technique-btn" type="button" data-action="select-technique" data-technique="extended" aria-pressed="false">Extended Exhale</button>
    <button class="technique-btn" type="button" data-action="select-technique" data-technique="triangle" aria-pressed="false">Quick Calm</button>
    <button class="technique-btn" type="button" data-action="select-technique" data-technique="wim" aria-pressed="false">Energizing Breath</button>
</div>
```

## 5. Technique switcher

Put it directly after the timer section. Mark the current page with
`aria-current="page"`. **No emoji in the labels.**

```html
<nav class="technique-switcher" aria-label="Other breathing timers">
    <a href="/4-7-8-breathing">4-7-8</a>
    <a href="/box-breathing" aria-current="page">Box</a>
    <a href="/heart-coherence-breathing">Coherence</a>
    <a href="/cyclic-sighing">Cyclic sighing</a>
    <a href="/extended-exhale-breathing">Extended exhale</a>
    <a href="/triangle-breathing">Triangle</a>
    <a href="/energizing-breath">Energizing</a>
    <a href="/timer">All timers</a>
</nav>
```

## 6. Prose container

```html
<article class="prose">
    <section>
        <h2>How to do box breathing</h2>
        <p class="lead">One or two sentences that answer the query directly.</p>
        <p>…</p>
    </section>

    <section>
        <h2>Step by step</h2>
        <div class="steps-container">
            <div class="step">
                <h3>1. Sit down</h3>
                <p>…</p>
            </div>
        </div>
    </section>

    <section>
        <h2>Common questions</h2>
        <div class="faq-item">
            <h3>Question exactly as written in the FAQPage JSON-LD?</h3>
            <p>Answer exactly as written in the FAQPage JSON-LD.</p>
        </div>
    </section>
</article>
```

Available classes inside `.article-page`: `.lead`, `.steps-container` + `.step`,
`.faq-item`, `.cta-block`, `.cta-block-final`, `.cta-button`,
`.cta-button-large`, `.cta-subtext`, `.related-techniques`, `.card-grid` +
`.link-card`, `.breadcrumb`, `.callout`, `.callout--caution`, `.crisis-block`,
`.citations`, `.table-scroll` + `.data-table`.

Copy rules: at least 500 words of real prose on any indexable content page,
900+ on a technique landing page. Second person, short sentences, no hype, no
exclamation marks. Every breath-hold or fast-breathing technique gets an
explicit contraindication block. Never write "studies show" without a citation
you opened yourself with WebFetch and quoted in your structured return.

## 7. Callout, crisis block, citations, tables

### Contraindication callout — a `--sand` card, no stripe

```html
<div class="callout callout--caution">
    <h3>Who should be careful</h3>
    <p>This pattern holds the breath twice per cycle…</p>
    <ul>
        <li>…</li>
    </ul>
</div>
```

A neutral aside uses `<div class="callout">` on its own (a white card).

### Crisis block — a `--rose` card; the numbers set themselves in mono

Required near the top of `/breathing-exercises-anxiety` and
`/breathing-exercises-for-panic-attacks`. Those pages carry **zero**
monetisation surfaces and `<body data-no-ads="true" data-no-asks="true"
data-open-timer="true">`: the timer runs for anyone there, always.

```html
<div class="crisis-block">
    <h2>If you need a person right now</h2>
    <p>A breathing timer is not the right tool for a crisis. These lines are.</p>
    <ul>
        <li><strong>Lebanon</strong> — Embrace Lifeline: <a href="tel:1564">1564</a></li>
        <li><strong>United States and Canada</strong> — call or text <a href="tel:988">988</a></li>
        <li><strong>United Kingdom and Ireland</strong> — Samaritans: <a href="tel:116123">116 123</a></li>
        <li><strong>Anywhere else</strong> — <a href="https://findahelpline.com" target="_blank" rel="noopener noreferrer">findahelpline.com</a></li>
    </ul>
</div>
```

### Citations

```html
<section class="citations">
    <h2>Sources</h2>
    <ol>
        <li>Author A, Author B. Title of the paper. <em>Journal</em>, 2023. <a href="https://…">https://…</a></li>
    </ol>
</section>
```

### Tables

Wrap every table so it scrolls inside its own box rather than pushing the page
sideways. Numeric columns get `class="num"` for tabular figures.

```html
<div class="table-scroll">
    <table class="data-table">
        <thead><tr><th>Pattern</th><th>Cycle</th><th class="num">Breaths / min</th></tr></thead>
        <tbody><tr><td>Box</td><td>4-4-4-4</td><td class="num">3.75</td></tr></tbody>
    </table>
</div>
```

## 8. Footer

Four link columns, an authorship byline naming a person, then the legal row.
Drop the link to the page you are on. On the crisis-safe pages, remove the
`/pro` link.

```html
<footer class="footer">
    <div class="footer-cols">
        <nav class="footer-nav" aria-label="Breathing timers">
            <p class="footer-heading">Timers</p>
            <a href="/timer">All timers</a>
            <a href="/4-7-8-breathing">4-7-8 breathing</a>
            <a href="/box-breathing">Box breathing</a>
            <a href="/heart-coherence-breathing">Heart coherence</a>
            <a href="/cyclic-sighing">Cyclic sighing</a>
            <a href="/extended-exhale-breathing">Extended exhale</a>
            <a href="/triangle-breathing">Triangle breathing</a>
            <a href="/energizing-breath">Energizing breath</a>
        </nav>

        <nav class="footer-nav" aria-label="Guides">
            <p class="footer-heading">Guides</p>
            <a href="/breathing-exercises-anxiety">For anxious moments</a>
            <a href="/breathing-exercises-for-sleep">For sleep</a>
            <a href="/breathing-exercises-for-panic-attacks">For panic attacks</a>
            <a href="/breathing-exercises-for-focus">For focus</a>
            <a href="/breathing-exercises-for-high-blood-pressure">For blood pressure</a>
            <a href="/4-7-8-breathing-technique">4-7-8 full guide</a>
        </nav>

        <nav class="footer-nav" aria-label="Compare and research">
            <p class="footer-heading">Compare</p>
            <a href="/box-breathing-vs-4-7-8">Box vs 4-7-8</a>
            <a href="/breathing-apps-compared">Apps compared</a>
            <a href="/science">What the research says</a>
        </nav>

        <nav class="footer-nav" aria-label="About and products">
            <p class="footer-heading">The site</p>
            <a href="/about">About</a>
            <a href="/pro">Pro</a>
            <a href="/account">Your account</a>
        </nav>
    </div>

    <p class="footer-byline">Written and maintained by Georges Rayess. Not a clinician — <a href="/about">what that means for what you read here</a>.</p>

    <div class="legal-links">
        <a href="/legal/privacy-policy">Privacy Policy</a>
        <a href="/legal/terms-of-service">Terms of Service</a>
        <a href="/legal/refund-policy">Refund Policy</a>
        <a href="/legal/medical-disclaimer">Medical Disclaimer</a>
        <a href="mailto:contact@helpmebreath.com">Contact</a>
    </div>
</footer>
```

The old "Made for a calmer, more mindful world." line and the bullet separators
between the legal links are gone: the byline names a person, and the legal row
spaces itself.

## 9. Plan links and checkout buttons

Never `alert()`, never Ko-fi, Buy Me a Coffee, PayPal, Stripe, Gumroad, Lemon
Squeezy, Polar, Creem, Freemius or Patreon. There is no "support us" ask
anywhere on the site (revised 2026-09-11: Patreon cannot pay out to the owner).

There is **one plan**: everything included, $10 a month or $100 a year, 3-day
free trial with a card on file, "One free trial per person." A page that needs
to point at it uses a plain link to `/pro` ("See the plan") or a checkout
button:

```html
<button class="checkout-btn" type="button" data-action="checkout" data-plan="monthly">Start the free trial</button>
```

`data-plan` is `monthly` or `yearly`. `js/checkout.js` handles the click; while
`CHECKOUT.clientToken` in `js/config.js` is empty the button renders a calm
"Checkout is not open yet" card instead of a checkout, so it is never dead
(there is no waitlist mode and no capture card here). A page that carries a
checkout button must load `/js/checkout.js` (or `/js/pro/index.js`, which
imports it). Put a `<div data-checkout-slot></div>` under the button so the
card lands there. Prices and the trial length come from `PLANS` in
`js/config.js` (`PLANS.monthly.price`, `PLANS.yearly.price`,
`PLANS.trialDays`, `PLANS.refundDays`); do not hard-code them in a script.

## 10. The plan card (`/pro`)

`/pro` is the only page that carries Product and Offer structured data, and
the only page with the full plan card (`.plan`, `.plan-card`, `.plan-toggle`,
`.included-list` in `css/pro.css`): an interval toggle, the price, the honest
trial statement, one button, the fine print, and one list of what is included.
No matrix, no tiers, no ticks and crosses. The price is mono ink and the button is the black pill; nothing wears a commerce colour any more. (Historical note: `--clay` appeared on the price and
the button here and on the home page's `.plan-band`, and nowhere near the
timer.

Structured data on `/pro`: two `Offer`s (10.00 USD, `unitCode` `MON`; 100.00
USD, `unitCode` `ANN`), `availability` `https://schema.org/PreOrder` until
checkout is genuinely open, then `InStock` in the same commit that turns it on.

Write "Yes", "—" or the actual limit as words. Never a tick emoji.

## 11. Ad slot

```html
<aside class="ad-slot" data-ad-slot="in-content-1" role="complementary" aria-label="Advertisement"></aside>
<aside class="ad-slot ad-slot--leaderboard" data-ad-slot="leaderboard-1" role="complementary" aria-label="Advertisement"></aside>
```

**Not `aria-hidden="true"`.** AdSense injects links and an iframe into this
container; hiding the container from assistive technology while leaving its
contents in the tab order is the axe `aria-hidden-focus` failure, and WCAG 4.1.2
and 2.4.3 with it. Label the region instead — the visible "Advertisement" label
the CSS prints then has a real accessible counterpart.

A well (`--well`, radius 18px, no border) with an "Advertisement" label in mono.
Height is reserved in CSS (280px, or 90px for the leaderboard variant) so
toggling measures CLS 0. `body.session-active .ad-slot { display: none }` hides
them while someone is breathing, and
`body[data-tier="pro"] .ad-slot { display: none }` keeps
a paying customer from ever seeing reserved ad space (`js/ads.js` also removes
the nodes outright).

**Allowed:** content pages, use-case pages and comparison pages — below the fold,
never between the Begin button and the circle. At most two in-content units per
page. Add `<script type="module" src="/js/ads.js"></script>`.

**Forbidden:** `/`, `/timer`, any technique landing page's timer viewport, `/pro`,
`/pro/thanks`, `/breathing-exercises-anxiety`,
`/breathing-exercises-for-panic-attacks`.

Any monetisation ask that is not an ad slot (upgrade card, capture form,
sign-in card) gets `data-ask="…"` so the same CSS rule hides it during a session.

## 12. JSON-LD patterns

Every page gets a **BreadcrumbList**. Technique pages add **HowTo** and
**FAQPage**. Articles add **Article**/**BlogPosting**. `Product`/`Offer` belongs
only on `/pro`. Every FAQ question and answer must also appear as visible text.
`Organization.logo` stays `https://helpmebreath.com/images/logo.png`.

### BreadcrumbList (every page)

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://helpmebreath.com/" },
    { "@type": "ListItem", "position": 2, "name": "Breathing timers", "item": "https://helpmebreath.com/timer" },
    { "@type": "ListItem", "position": 3, "name": "Box breathing", "item": "https://helpmebreath.com/box-breathing" }
  ]
}
</script>
```

### HowTo (technique pages)

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to practise box breathing",
  "description": "A four-count pattern: in, hold, out, hold.",
  "image": "https://helpmebreath.com/images/og/box-breathing.jpg",
  "totalTime": "PT5M",
  "estimatedCost": { "@type": "MonetaryAmount", "currency": "USD", "value": "0" },
  "supply": [
    { "@type": "HowToSupply", "name": "A quiet spot" },
    { "@type": "HowToSupply", "name": "A chair or the floor" }
  ],
  "tool": [
    { "@type": "HowToTool", "name": "Help Me Breathe box breathing timer", "url": "https://helpmebreath.com/box-breathing" }
  ],
  "step": [
    { "@type": "HowToStep", "name": "Sit down", "text": "Sit upright…", "url": "https://helpmebreath.com/box-breathing#step1" },
    { "@type": "HowToStep", "name": "Breathe in for four", "text": "…" },
    { "@type": "HowToStep", "name": "Hold for four", "text": "…" },
    { "@type": "HowToStep", "name": "Breathe out for four", "text": "…" },
    { "@type": "HowToStep", "name": "Hold empty for four", "text": "…" }
  ]
}
</script>
```

### FAQPage

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "How long should I do box breathing for?",
      "acceptedAnswer": { "@type": "Answer", "text": "Three to five minutes is a good first session…" }
    }
  ]
}
</script>
```

### Article / BlogPosting

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "Box breathing, step by step",
  "description": "…",
  "image": "https://helpmebreath.com/images/og/box-breathing.jpg",
  "datePublished": "2026-09-09",
  "dateModified": "2026-09-10",
  "author": { "@type": "Person", "name": "Georges Rayess", "url": "https://helpmebreath.com/about" },
  "publisher": {
    "@type": "Organization",
    "name": "Help Me Breathe",
    "logo": { "@type": "ImageObject", "url": "https://helpmebreath.com/images/logo.png" }
  },
  "mainEntityOfPage": { "@type": "WebPage", "@id": "https://helpmebreath.com/box-breathing" }
}
</script>
```

## 13. Forbidden-pattern checklist

Run against every page you touch. Every one of these must return nothing.

- [ ] `Quicksand`
- [ ] `linear-gradient` or `radial-gradient` in a page `<style>` block (the
      only gradients on the site are the stage band and the three washes in
      `css/styles.css`; a page never adds its own)
- [ ] `backdrop-filter`
- [ ] `text-shadow`
- [ ] `nature-bg`
- [ ] `natural-element`
- [ ] `breathing-particles`
- [ ] `breathing-aura`
- [ ] `fluid-effect`
- [ ] `breathing-svg-filter`
- [ ] `particle-float`
- [ ] `patreon-btn`
- [ ] `filter:` with a `blur(` — `backdrop-filter` is not the only one that hides
- [ ] the old palette hexes anywhere in the file: `#8b5cf6`, `#1e1b4b`, `#f96854`
- [ ] any emoji codepoint. The two that hide in old markup are the gear
      (`U+2699`, on the settings button — now an inline SVG) and the lungs
      (`U+1FAC1`, in the old favicon data URI). They are written here as
      codepoints on purpose: this checklist has to pass its own emoji scan.
- [ ] `theme-color` still `#8b5cf6`
- [ ] an emoji favicon `data:` URI
- [ ] a `box-shadow` that is not `var(--lift)` or `var(--lift-high)`
- [ ] a hard-coded hex in a page `<style>` block instead of a token
- [ ] a `border` on a card, a button, a field or a chip (Lantern has none; a
      hairline `border-top` / `border-bottom` between the rows of a list or
      table is the one allowed line)
- [ ] a coloured dot (`::before` disc, `<i>` bullet) beside a name
- [ ] a coloured left stripe (`border-left`) on a callout
- [ ] a font-weight below 300, or 300 on anything under 24px or clickable
- [ ] a font-size below 12px
- [ ] a serif face anywhere; a monospace face on anything that is not a number,
      a date, a price or a small uppercase label

## 13a. If your page needs its own `<style>` block

Page-specific CSS is allowed (in the page, or `css/<page>.css` above 150 lines).
Four rules, because these are the ones that break the identity quietly:

1. **Every colour is a `var(--token)`.** No hex, no `rgb()`, no named colour.
   If you need a colour the system does not have, you need a token, which means
   an `integration_request` — not a local hex.
2. **Never define a colour that only exists inside a media query or a `.night`
   block.** The token sets already flip for you. A rule like
   `@media (prefers-color-scheme: dark) { .my-thing { color: #ccc } }` is the
   exact bug this identity is built to avoid: it will be wrong for the visitor
   who has set `body.day`, and wrong again when a token changes.
   The one exception is `@media print`, which is not a theme but a different
   physical substrate: `css/styles.css` §10 and `css/print.css` re-declare the
   whole token set there in literal ink-on-paper values. Do not copy that
   pattern for anything on a screen.
3. **Nothing has a border.** A card is `--surface` + `--lift`; a control is
   a filled pill (`--action` or `--well`); a field is a `--well`. `--line` is a
   hairline between rows only. `--edge` still resolves, as a hairline, for
   unconverted pages; do not reach for it.
4. **Do not restyle the phase word, the timer digits or any `.control-btn`.**
   The phase word is the largest type on a timer screen and the timer digits are
   sans with tabular figures; a page-level override that breaks either of those
   is a design-system change, not a page change.

Also: nothing is smaller than 12px, nothing clickable is lighter than weight
500, anything counted is `var(--mono)`, and anything clickable is `var(--sans)`.

## 14. Checklist before you hand a page over

- [ ] `<html lang="en">`, charset, viewport present.
- [ ] `<title>` ≤ 65 chars; not the bare "breathing exercise" / "deep breathing" head term.
- [ ] Meta description 50–165 chars, and the same string in OG and Twitter tags.
- [ ] Absolute canonical to the clean URL; no other page claims it.
- [ ] OG title/description/type/url/image/site_name + `twitter:card` all present.
- [ ] The four favicon links and both `theme-color` metas, dark one first.
- [ ] The Figtree + DM Mono font link, preload + `<noscript>` twin.
- [ ] Exactly one `<h1>`; heading levels do not skip.
- [ ] Consent + GA4 block pasted verbatim, defaults before config.
- [ ] Every JSON-LD block parses (`JSON.parse`) and every FAQ answer also appears as visible text.
- [ ] Site header present, identical to §2, with `aria-current="page"` on one nav link.
- [ ] Timer section pasted whole: the app bar, every `data-role` including `phase-count`, the guides SVG, the notch, both `data-slot` containers, the safety-ack panel, the live region.
- [ ] `data-breathing-app` is on an element containing the technique buttons, if the page has any.
- [ ] Ids are unique — suffixed per timer when a page has two.
- [ ] Technique switcher present with `aria-current="page"` on this page, plain text labels.
- [ ] Four-column footer, byline, legal row.
- [ ] ≥ 500 words of real prose (≥ 900 on a technique landing page).
- [ ] Contraindication block for any hold or fast-breathing technique.
- [ ] Medical disclaimer link present.
- [ ] No invented medical reviewer.
- [ ] No inline `onclick`; every control uses `data-action`.
- [ ] No AdSense script tag pasted by hand; `js/ads.js` only, and only where ads are allowed.
- [ ] Crisis-safe pages: `data-no-ads="true" data-no-asks="true" data-open-timer="true"`, zero monetisation, crisis lines near the top including Embrace 1564.
- [ ] Root-relative asset paths; clean-URL links only.
- [ ] §13 forbidden-pattern checklist all clear.
- [ ] Any page `<style>` block obeys §13a: tokens only, no colour defined solely
      inside a media or `.night` block, no border on any shape.
- [ ] If the file was copied from `templates/technique-page.template.html`, the `noindex` meta is **deleted**.
- [ ] `node tools/site-check.mjs` reports no ERROR mentioning your file.
- [ ] `node tools/build-sitemap.mjs` lists your page (it will not if the canonical is missing).
