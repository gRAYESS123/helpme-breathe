# Page Contract — Help Me Breathe

Copy-paste blocks for building a page. Everything here is exact: paste it, then
change only what the notes tell you to change.

A faster start: copy `templates/technique-page.template.html`, delete its
`<meta name="robots" content="noindex, nofollow">` line, and replace the
`{{PLACEHOLDERS}}`. Placeholders in that file are `{{TITLE}}`, `{{DESCRIPTION}}`,
`{{SLUG}}`, `{{H1}}`, `{{SUBTITLE}}`, `{{BREADCRUMB_NAME}}`, `{{THEME}}`,
`{{CIRCLE_CLASS}}`, `{{TECHNIQUE}}`, `{{DURATION}}`, `{{OG_IMAGE}}`,
`{{PROSE}}`, `{{JSONLD}}`.

Rules that are not negotiable:

- Link and canonicalise to **clean URLs** (`/box-breathing`), never `.html`.
- Root-relative asset paths (`/css/styles.css`, `/js/app.js`).
- Exactly one `<h1>` per page. No `<h1>` inside the prose you write.
- No inline `onclick`. `data-action` only.
- No ad slot, no paywall prompt, no email capture and no affiliate link on
  `/breathing-exercises-anxiety`, `/breathing-exercises-for-panic-attacks`,
  `/pro`, `/pro/thanks`, `/for-practitioners` or `/embed`.
- Never put "Wim Hof" in a title, H1, meta description or slug.

---

## 1. The `<head>` block

Replace the five `{{…}}` values. Everything else is verbatim, **including the
order of the consent script** — the denied defaults must be pushed before
`gtag('config', …)`, and ES modules are deferred, so this cannot move into
`js/consent.js`.

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

    <!-- Favicon -->
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='24' font-size='24'>🫁</text></svg>">
    <link rel="apple-touch-icon" sizes="180x180" href="/images/apple-touch-icon.png">

    <!-- PWA -->
    <link rel="manifest" href="/manifest.json">
    <meta name="theme-color" content="#8b5cf6">

    <!-- PERFORMANCE -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="preload" href="/css/styles.css" as="style">
    <link rel="stylesheet" href="/css/styles.css">

    <link rel="preload" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300;400;500;600&display=swap" as="style" onload="this.onload=null;this.rel='stylesheet'">
    <noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@300;400;500;600&display=swap"></noscript>

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
        gtag('js', new Date());
        gtag('config', 'G-09WY9JD4YM', {
            'anonymize_ip': true,
            'cookie_expires': 63072000
        });
    </script>
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-09WY9JD4YM"></script>

    <!-- JSON-LD blocks go here. See section 6. -->
</head>
```

Rules for the values:

| Value | Rule |
|---|---|
| `{{TITLE}}` | ≤ 65 characters. Never the bare head terms "breathing exercise" or "deep breathing". |
| `{{DESCRIPTION}}` | 50–165 characters. Same string in the meta, OG and Twitter tags. |
| `{{SLUG}}` | No leading slash, no `.html`. Legal pages use `legal/<name>`. |
| `{{OG_IMAGE}}` | `<slug>.jpg`. If `images/og/<slug>.jpg` does not exist, file an `og-image` integration request and point at `/images/og-breathing-timer.jpg` meanwhile. |

Do **not** paste an AdSense loader tag. `js/ads.js` injects it, only when it is allowed.

## 2. `<body>` and the page frame

```html
<body class="theme-box article-page technique-page">
    <a class="skip-link" href="#main">Skip to main content</a>

    <div class="nature-bg"></div>

    <div class="natural-element star star-1"></div>
    <div class="natural-element star star-2"></div>
    <div class="natural-element star star-3"></div>
    <div class="natural-element star star-4"></div>
    <div class="natural-element leaf leaf-1"></div>
    <div class="natural-element leaf leaf-2"></div>
    <div class="natural-element leaf leaf-3"></div>
    <div class="natural-element ripple ripple-1"></div>
    <div class="natural-element ripple ripple-2"></div>
    <div class="natural-element ripple ripple-3"></div>
    <div class="natural-element cloud cloud-1"></div>
    <div class="natural-element sun-ray sun-ray-1"></div>
    <div class="natural-element sun-ray sun-ray-2"></div>
    <div class="natural-element sun-ray sun-ray-3"></div>

    <div class="container">
        <header>
            <nav aria-label="Breadcrumb">
                <ol class="breadcrumb">
                    <li><a href="/">Home</a></li>
                    <li><a href="/timer">Breathing timers</a></li>
                    <li>Box breathing</li>
                </ol>
            </nav>
            <div class="header-content">
                <h1>Box Breathing Timer</h1>
                <p class="subtitle">One sentence saying what the page gives you.</p>
            </div>
        </header>

        <main id="main">
            <!-- timer section, switcher, prose, ad slot -->
        </main>

        <footer class="footer"><!-- section 7 --></footer>
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

Body classes:

- `theme-*` — the technique's theme (`js/techniques.js` → `technique.theme`).
  The engine re-applies it on load; setting it statically only avoids a flash.
- `article-page` — turns on the prose typography system.
- `technique-page` — timer on top, prose below, single column.
- Crisis-safe pages must also carry `data-no-ads="true" data-no-asks="true"` on
  `<body>`.

The cookie banner is **not** page markup. `js/consent.js` injects it.

## 3. The timer section — exact snippet

Paste this inside `<main>`. It carries every `data-role` the engine knows and
both slots. Change only the four marked spots.

The four spots to change: `data-technique` (the technique key), `data-duration`
(default seconds for a first-time visitor; `-1` = unlimited), `data-lock-technique`
(delete it on a hub page that lets people switch), and the circle's technique
class. HTML comments never go inside a tag, so they are not shown inline below.

```html
<section class="breathing-section"
         data-breathing-app
         data-technique="box"
         data-duration="300"
         data-lock-technique
         aria-labelledby="timer-heading">

    <button class="settings-btn" type="button" data-role="settings-btn" data-action="toggle-settings" aria-label="Open settings" aria-expanded="false">⚙️</button>

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

    <h2 id="timer-heading" data-role="technique-title">Box breathing</h2>

    <div class="breathing-container">
        <div class="breathing-aura"></div>
        <div class="breathing-circle technique-box" data-role="circle">
            <div class="circle-text-container">
                <span data-role="circle-text">Ready</span>
            </div>
        </div>
        <div class="breathing-particles" aria-hidden="true">
            <span class="particle-float"></span>
            <span class="particle-float"></span>
            <span class="particle-float"></span>
            <span class="particle-float"></span>
            <span class="particle-float"></span>
            <span class="particle-float"></span>
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

    <!-- SLOT: Pro tools ("Your practice", "Soundscapes", "Custom pattern") -->
    <div class="tools-row" data-slot="tools"></div>

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

    <div class="technique-info" data-role="technique-info"></div>

    <p class="live-region" data-role="live-region" aria-live="polite" aria-atomic="true"></p>
</section>
```

Notes:

- **Both slots are required** on every page with a timer, even if nothing fills
  them today. `[data-slot]:empty` is `display: none`, so they cost nothing.
- The **safety-ack panel is required** too. The engine only shows it for
  techniques with `requiresSafetyAck` (today: `wim`), and fills
  `[data-role="safety-ack-body"]` from that technique's contraindications.
- `[data-role="technique-info"]` is filled from the technique. Add `data-static`
  to it if you want to write that copy yourself.
- **App root.** `data-breathing-app` must sit on an element containing the whole
  timer UI. If your page has technique buttons **outside** the
  `.breathing-section`, move `data-breathing-app` up to the common ancestor (see
  `index.html`, where it is on `<main>`).
- **Two timers on one page** (comparison pages): duplicate the section, give each
  a different `data-technique`, wrap them in `<div class="timer-pair">`, and
  **suffix every `id`** (`label-sound-a` / `label-sound-b`,
  `session-duration-a` / `session-duration-b`, and the matching `for`/
  `aria-labelledby`). `data-role` values stay the same — they are scoped per root.
- **Kiosk mode** (`data-kiosk`) requires `data-breathing-app` on the
  `.breathing-section` itself.

## 4. Technique switcher

Put it directly after the timer section. Mark the current page with
`aria-current="page"` and drop that page's own link target.

```html
<nav class="technique-switcher" aria-label="Other breathing timers">
    <a href="/4-7-8-breathing">🌙 4-7-8</a>
    <a href="/box-breathing" aria-current="page">🌿 Box</a>
    <a href="/heart-coherence-breathing">💗 Coherence</a>
    <a href="/cyclic-sighing">🌊 Cyclic sighing</a>
    <a href="/extended-exhale-breathing">🌅 Extended exhale</a>
    <a href="/triangle-breathing">☁️ Triangle</a>
    <a href="/energizing-breath">☀️ Energizing</a>
    <a href="/timer">All timers</a>
</nav>
```

## 5. Prose container

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
            <div class="step">
                <h3>2. Breathe in for four</h3>
                <p>…</p>
            </div>
        </div>
    </section>

    <section>
        <h2>Who should be careful</h2>
        <ul>
            <li>…</li>
        </ul>
    </section>

    <section>
        <h2>Common questions</h2>
        <div class="faq-item">
            <h3>Question exactly as written in the FAQPage JSON-LD?</h3>
            <p>Answer exactly as written in the FAQPage JSON-LD.</p>
        </div>
    </section>

    <section>
        <h2>A note on what this is</h2>
        <p>Nothing here is medical care and none of it replaces treatment. Read the
        <a href="/legal/medical-disclaimer">medical disclaimer</a>.</p>
    </section>
</article>
```

Available classes inside `.article-page`: `.lead`, `.steps-container` + `.step`,
`.faq-item`, `.cta-block`, `.cta-block-final`, `.cta-button`,
`.cta-button-large`, `.cta-subtext`, `.related-techniques`, `.card-grid` +
`.link-card`, `.breadcrumb`.

Copy rules: at least 500 words of real prose on any indexable content page,
900+ on a technique landing page. Second person, short sentences, no hype, no
exclamation marks. Every breath-hold or fast-breathing technique gets an explicit
contraindication block. Never write "studies show" without a citation you opened
yourself with WebFetch and quoted in your structured return.

## 6. JSON-LD patterns

Every page gets a **BreadcrumbList**. Technique pages add **HowTo** and
**FAQPage**. Articles add **Article**/**BlogPosting**. `Product`/`Offer` belongs
only on `/pro`. Every FAQ question and answer must also appear as visible text.

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
  "dateModified": "2026-09-09",
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

## 7. Ad slot

```html
<div class="ad-slot" data-ad-slot="in-content-1" aria-hidden="true"></div>
<div class="ad-slot ad-slot--leaderboard" data-ad-slot="leaderboard-1" aria-hidden="true"></div>
```

Height is reserved in CSS (280px, or 90px for the leaderboard variant) so
toggling measures CLS 0. `body.session-active .ad-slot { display: none }` hides
them while someone is breathing.

**Allowed:** content pages, use-case pages and comparison pages — below the fold,
never between the Begin button and the circle. At most two in-content units per
page. Add `<script type="module" src="/js/ads.js"></script>`.

**Forbidden:** `/`, `/timer`, any technique landing page's timer viewport, `/pro`,
`/pro/thanks`, `/for-practitioners`, `/embed`, `/breathing-exercises-anxiety`,
`/breathing-exercises-for-panic-attacks`. On the crisis-safe pages, also set
`<body data-no-ads="true" data-no-asks="true">` and load no `ads.js` at all.

Any monetisation ask that is not an ad slot (tip button, upgrade card, capture
form) gets `data-ask="…"` so the same CSS rule hides it during a session.

## 8. Footer

```html
<footer class="footer">
    <p>Made for a calmer, more mindful world.</p>

    <nav class="footer-nav" aria-label="Breathing timers">
        <a href="/timer">All timers</a>
        <a href="/4-7-8-breathing">4-7-8 breathing</a>
        <a href="/box-breathing">Box breathing</a>
        <a href="/heart-coherence-breathing">Heart coherence</a>
        <a href="/cyclic-sighing">Cyclic sighing</a>
        <a href="/extended-exhale-breathing">Extended exhale</a>
        <a href="/triangle-breathing">Triangle breathing</a>
        <a href="/energizing-breath">Energizing breath</a>
    </nav>

    <nav class="footer-nav" aria-label="Guides and comparisons">
        <a href="/breathing-exercises-anxiety">For anxious moments</a>
        <a href="/breathing-exercises-for-sleep">For sleep</a>
        <a href="/breathing-exercises-for-panic-attacks">For panic attacks</a>
        <a href="/breathing-exercises-for-focus">For focus</a>
        <a href="/box-breathing-vs-4-7-8">Box vs 4-7-8</a>
        <a href="/breathing-apps-compared">Apps compared</a>
        <a href="/4-7-8-breathing-technique">4-7-8 full guide</a>
    </nav>

    <nav class="footer-nav" aria-label="About and products">
        <a href="/science">What the research says</a>
        <a href="/about">About</a>
        <a href="/pro">Pro</a>
        <a href="/for-practitioners">For practitioners</a>
        <a href="/embed">Embed the timer</a>
    </nav>

    <div class="legal-links">
        <a href="/legal/privacy-policy">Privacy Policy</a>
        <span aria-hidden="true" style="opacity: 0.5">•</span>
        <a href="/legal/terms-of-service">Terms of Service</a>
        <span aria-hidden="true" style="opacity: 0.5">•</span>
        <a href="/legal/medical-disclaimer">Medical Disclaimer</a>
        <span aria-hidden="true" style="opacity: 0.5">•</span>
        <a href="mailto:contact@helpmebreath.com">Contact</a>
    </div>
</footer>
```

Drop the link to the page you are on. On the crisis-safe pages, remove the `/pro`
and `/for-practitioners` links.

## 9. Support and upgrade links

Never `alert()`, never Ko-fi, Buy Me a Coffee, PayPal, Stripe, Gumroad, Lemon
Squeezy, Polar, Creem or Freemius. Only these two, and only outside a session:

```html
<a class="patreon-btn" href="https://www.patreon.com/GeorgesRayess"
   target="_blank" rel="noopener noreferrer"
   data-action="support" data-support-label="patreon">Support on Patreon</a>

<a class="pro-link" href="/pro"
   data-action="support" data-support-label="pro">Unlock Pro — one payment, forever</a>
```

Checkout buttons belong to the Pro agent:
`<button data-action="checkout" data-sku="practitioner">`.

## 10. Checklist before you hand a page over

- [ ] `<html lang="en">`, charset, viewport present.
- [ ] `<title>` ≤ 65 chars; not the bare "breathing exercise" / "deep breathing" head term.
- [ ] Meta description 50–165 chars, and the same string in OG and Twitter tags.
- [ ] Absolute canonical to the clean URL; no other page claims it.
- [ ] OG title/description/type/url/image/site_name + `twitter:card` all present.
- [ ] Exactly one `<h1>`; heading levels do not skip.
- [ ] Consent + GA4 block pasted verbatim, defaults before config.
- [ ] Every JSON-LD block parses (`JSON.parse`) and every FAQ answer also appears as visible text.
- [ ] Timer section pasted whole: every `data-role`, both `data-slot` containers, the safety-ack panel, the live region.
- [ ] `data-breathing-app` is on an element containing the technique buttons, if the page has any.
- [ ] Ids are unique — suffixed per timer when a page has two.
- [ ] Technique switcher present with `aria-current="page"` on this page.
- [ ] ≥ 500 words of real prose (≥ 900 on a technique landing page).
- [ ] Contraindication block for any hold or fast-breathing technique.
- [ ] Medical disclaimer link present.
- [ ] No inline `onclick`; every control uses `data-action`.
- [ ] No AdSense script tag pasted by hand; `js/ads.js` only, and only where ads are allowed.
- [ ] Crisis-safe pages: `data-no-ads="true" data-no-asks="true"`, zero monetisation, crisis lines near the top.
- [ ] Root-relative asset paths; clean-URL links only.
- [ ] If the file was copied from `templates/technique-page.template.html`, the `noindex` meta is **deleted**.
- [ ] `node tools/site-check.mjs` reports no ERROR mentioning your file.
- [ ] `node tools/build-sitemap.mjs` lists your page (it will not if the canonical is missing).
