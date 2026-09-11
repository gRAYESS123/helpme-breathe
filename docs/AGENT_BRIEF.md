# Help Me Breathe — Agent Brief (read fully before touching anything)

Repo root: `C:/Users/georg/Desktop/Side hustkes/Help Me Breath/helpme-breathe-main` (Windows; use forward slashes; Bash tool works).
Branch: `v2-business`. Deploy target: **Vercel** (owner connects GitHub + DNS manually). Static multi-page site + a few Vercel serverless functions under `api/`. **Zero npm runtime dependencies. No bundler. No framework. No database. No user accounts.**

## 1. What we are building and why

A free, excellent guided-breathing timer (already live at helpmebreath.com) turned into a small business:

| Tier | Price | What it unlocks |
|---|---|---|
| Free | $0 | All 7 techniques, all durations, audio + vibration cues, offline PWA, saved settings, session history, embeddable widget (with attribution) |
| Pro (lifetime) | $19 once ($14 founding for first 100) | Custom pattern builder + saved presets, streaks + 12-week heatmap + CSV export, ambient soundscapes, night mode, ad-free, Protocol Pack |
| Practitioner | $99/year | Everything in Pro + commercial-use licence, white-label embed (no attribution, own logo/colours), co-branded client session link, class/projector mode, client handout pack, homework-link builder, 25 activations, DPA + privacy attestation |
| Studio | $199/year | Practitioner across 10 domains + usage report |
| Protocol Pack | $19 once | Print-ready protocol cards; bundled free into Pro |

Revenue streams in priority order: (1) Practitioner licences — the $2k/month lever, (2) Pro lifetime unlocks, (3) AdSense on **content pages only**, (4) affiliates (Headspace, moonbird direct — never Calm, never Amazon), (5) Patreon/tips.

**Owner is a Lebanon-resident individual with no company.** Payments go through a **merchant of record** (Paddle primary, FastSpring fallback). **Never reference, link, or build on Stripe, PayPal, Gumroad, Lemon Squeezy, Polar, Creem, Ko-fi, Buy Me a Coffee, Kit Commerce or Freemius.** Every paid feature gate reads from ONE module (`js/entitlements.js`); every provider-specific call lives in ONE config object in `api/_lib/providers/`. Swapping the merchant of record must be a one-file change.

## 2. Hard rules (violations get the work rejected)

1. **Nothing that works today may stop working.** Every existing technique stays free. The existing `/4-7-8-breathing-technique` article (`blog/4-7-8-breathing-technique.html`) stays where it is and keeps its canonical.
2. **Never title, H1, meta or slug any page with the "Wim Hof" trademark.** Say "energizing breath"; the method may be mentioned once in body copy only.
3. **Never target the bare head terms** "breathing exercise" / "deep breathing" in a title or H1 — Google serves its own in-SERP widget there.
4. **Health claims:** cite only primary literature you actually opened with WebFetch during this task. Quote the sentence that supports the claim in your structured return. Never write "studies show" without a specific verified citation. Never imply the timer treats, cures or replaces treatment for any condition. Every breath-hold or fast-breathing technique carries an explicit contraindication block (pregnancy, cardiovascular conditions, uncontrolled hypertension, epilepsy, respiratory conditions, recent surgery, glaucoma, panic disorder for breath-holds). The energizing (`wim`) technique requires a one-tap safety acknowledgement before starting.
5. **Crisis-safe pages:** `/breathing-exercises-anxiety` and `/breathing-exercises-for-panic-attacks` carry a crisis helpline block near the top and **zero monetisation surfaces** (no ad slots, no paywall prompt, no email capture, no affiliate links). Set `<body data-no-ads="true" data-no-asks="true">`.
6. **No ad slot ever inside the breathing viewport**, on `/pro`, `/for-practitioners`, `/embed`, `/pro/thanks`, or on the crisis-safe pages. Ad slots go only on content/comparison pages, below the fold, with reserved `min-height` so CLS stays 0, and they hide while `body.session-active`.
7. **Widget attribution links are `rel="nofollow noopener"` — always, with no paid option to change it.**
8. **No user accounts, logins, passwords or databases.** Licence = HMAC-signed token in `localStorage`.
9. **Secrets never enter the repo or a chat session.** `LICENSE_SECRET` etc. live in Vercel env vars. `.env` is gitignored. Never log a full licence key.
10. **Brand (owner decision, 2026-09-10): the site is being rebranded to the "Paper and Ink" identity** documented in `docs/BRAND.md` (warm paper ground, charcoal ink, one deep green, Newsreader + IBM Plex Sans, a ring-with-a-gap mark, one palette with a per-technique rim/fill accent pair, no emoji, no gradients, no blur, not Quicksand). Follow `docs/BRAND.md` and the updated `docs/PAGE_CONTRACT.md`; keep every class name, `data-role`, `data-slot` and `data-action` the engine binds to.
    **Section 4 of this brief is stale on two points and `docs/PAGE_CONTRACT.md` wins:** the head block loads Newsreader + IBM Plex Sans, never Quicksand, and the favicon is `/favicon.svg` + `/favicon-32.png` + `/favicon-16.png`, never an emoji SVG data URI. `theme-color` is `#F5F1E8` with a `#15191A` dark-scheme entry listed first. Copy the head from `docs/PAGE_CONTRACT.md` §1, not from an unconverted page.
11. **No page under 500 words of real prose** on indexable content pages. No spun or padded text. Write like a careful, warm human, not a marketer.
12. **Accessibility:** full keyboard operation, ARIA live region for phase changes, 4.5:1 contrast, `prefers-reduced-motion` honoured, no flashing. Do NOT publish a formal WCAG/EN 301 549 conformance claim.
13. **Refund policy:** 14 days, unconditional, stated on `/pro` and in Terms, reachable from checkout.
14. **Zero third-party requests from the embed widget** (no fonts, no analytics, no ads inside the iframe).
15. Do not create native apps, memberships, newsletters, paid ads, backlink schemes, or enterprise/HR procurement material.

## 3. File ownership (parallel agents — this is how we avoid conflicts)

- **Shared core files** (`index.html`, `css/styles.css`, `js/techniques.js`, `js/app.js`, `js/storage.js`, `js/analytics.js`, `js/ads.js`, `vercel.json`, `sw.js`, `manifest.json`, `robots.txt`, `sitemap.xml`, `package.json`) are owned by the **Core** and **Integrate** agents only. Every other agent must NOT edit them. If you need a change there (a new nav link, a new rewrite, a CSS addition, a precache entry), put it in the `integration_requests` field of your structured return and the Integrate agent will apply it.
- Each build agent owns exactly the files listed in its task. Create only those. Page-specific CSS goes in a `<style>` block inside that page (or `css/<page>.css` if >150 lines), using the existing CSS custom properties.
- Never delete or rename files you do not own.

## 4. Technical conventions

### URLs and files
- Vercel `cleanUrls: true`: file `box-breathing.html` at the repo root serves `/box-breathing`. Link and canonicalise to the **clean URL** (`https://helpmebreath.com/box-breathing`), never to `.html`.
- Legal pages stay under `legal/` (`/legal/privacy-policy`, `/legal/terms-of-service`, `/legal/medical-disclaimer`).
- Product pages at root: `pro.html` → `/pro`, `pro/thanks.html` → `/pro/thanks`, `for-practitioners.html`, `embed.html`, `about.html`, `science.html`, `timer.html`.
- Embed runtime under `embed/v1/` (versioned; never break it). Client session link at `s/index.html` → `/s/?c=...`. Render capture surface at `render.html` (noindex).
- No SPA catch-all; unmatched paths return the real `404.html`.

### Every HTML page head (copy the pattern from `index.html` / `blog/4-7-8-breathing-technique.html`)
`<html lang="en">`, charset, viewport, `<title>` ≤ 65 chars, meta description 50–165 chars, absolute canonical, OG (title/description/type/url/image/site_name) + Twitter card, the four favicon links (`/favicon.svg`, `/favicon-32.png`, `/favicon-16.png`, `/images/apple-touch-icon.png` — never an emoji data URI), `manifest.json`, both `theme-color` metas (dark first), preconnect + the Newsreader / IBM Plex Sans font link (non-blocking pattern from `docs/PAGE_CONTRACT.md` §1), `css/styles.css`, GA4 snippet **with Consent Mode default denied** (copy exactly from `index.html` once Core has updated it), JSON-LD (`BreadcrumbList` on every page; `HowTo` + `FAQPage` on technique pages; `Article` on articles; `Product`/`Offer` only on `/pro`). Per-page OG image at `images/og/<slug>.jpg` (request generation via `integration_requests` if it does not exist).
- Root-relative paths for assets (`/css/styles.css`, `/js/app.js`) so pages in subfolders work.
- Scripts: `<script type="module" src="/js/app.js"></script>` plus any page module. No inline `onclick` handlers — use `data-action` attributes and `addEventListener`.

### The shared engine contract (implemented by Core in `js/`; documented in `docs/MODULE_API.md`, which is the source of truth if it differs from this summary)
- `js/techniques.js` — `TECHNIQUES` (keys: `478`, `box`, `coherent`, `triangle`, `wim`, `sigh`, `extended`), `TECHNIQUE_ORDER`, `getTechnique(key)`, `techniqueForPath(pathname)`, `patternToPhases({inhale, hold1, exhale, hold2})`. Each technique: `{ key, slug, name, shortName, emoji, theme, circleClass, phases:[{name, duration, class, text, frequency}], description, benefits[], contraindications[], requiresSafetyAck, sources[] }`.
- `js/storage.js` — `getSettings()`, `saveSettings(patch)`, `appendSession(record)`, `getHistory()`, `completedSessionCount()`, `getFlag(name)`, `setFlag(name, value)`. All keys under the `hmb.` namespace; every call is try/catch safe.
- `js/analytics.js` — `track(name, params)` → `gtag('event', …)` only when present and consented; `EVENTS` constant enumerates all event names (session_start, session_complete, session_abandon, technique_select, settings_open, third_session_reached, paywall_view, paywall_click, checkout_open, activate_attempt, activate_success, activate_fail, restore_success, capture_shown, capture_submit, support_click, pwa_install, outbound_affiliate_click, embed_snippet_copied).
- `js/app.js` — `createBreathingApp(rootEl, options)` returning `{ start, pause, stop, selectTechnique, setPattern, getState, destroy }`. **Multiple instances per page must work** (comparison pages embed two timers), so the engine uses `data-role="…"` attributes scoped to `rootEl`, not global ids. Auto-initialises every `[data-breathing-app]` element on DOMContentLoaded from `data-technique`, `data-duration`, `data-lock-technique`, `data-autostart`, `data-kiosk`. Dispatches `CustomEvent`s on `document`: `hmb:ready`, `hmb:technique-change`, `hmb:session-start`, `hmb:phase`, `hmb:session-pause`, `hmb:session-complete`, `hmb:session-stop` (detail includes `{ technique, seconds, breaths, completed, root }`). Toggles `body.session-active` while running. Applies the technique's `theme` class to `<body>` unless `data-lock-theme` is set.
- Standard timer markup: a `<section class="breathing-section" data-breathing-app data-technique="box" data-duration="300">` containing the same structure as `index.html`'s breathing section but with `data-role` attributes (`circle`, `circle-text`, `breathing-text`, `timer`, `progress-fill`, `progress-time`, `session-info`, `session-progress-fill`, `session-time-remaining`, `start`, `pause`, `stop`, `stats`, `breath-count`, `avg-breath`, `session-progress`, `technique-title`, `technique-info`, `settings-btn`, `settings-panel`, `sound-toggle`, `vibration-toggle`, `duration-select`, `technique-buttons`, `safety-ack`, `live-region`) and a `<div data-slot="post-session"></div>` where post-session cards (email capture, paywall) render. Copy the exact snippet from `docs/PAGE_CONTRACT.md`.
- `js/entitlements.js` — `isPro()`, `isPractitioner()`, `tier()` (`free|pro|practitioner|studio`), `requirePro(featureName)` (returns boolean; when false dispatches `hmb:paywall` with `{feature}`), `activate(key)` (Promise), `restore()`, `deactivate()`, `onChange(cb)`. Token stored at `localStorage['hmb.license']`.
- `js/ads.js` — `initAds()` injects the AdSense loader only when `!isPro()` and `document.body.dataset.noAds !== 'true'`, fills `.ad-slot[data-ad-slot]` elements, and never runs while `body.session-active`.

### Serverless functions (`api/`)
Vercel Node runtime with **Web-standard handlers** (`export async function POST(request) { return Response.json(...) }`), WebCrypto (`crypto.subtle`) for HMAC so the code is portable to Cloudflare Pages Functions with a two-line adapter. Env vars: `LICENSE_SECRET`, `MOR_PROVIDER` (`paddle|fastspring`), `MOR_API_KEY`, `MOR_WEBHOOK_SECRET`, `MOR_PRODUCT_LIFETIME`, `MOR_PRODUCT_MONTHLY`, `MOR_PRODUCT_PRACTITIONER`, `MOR_PRODUCT_STUDIO`, `MOR_PRODUCT_PACK`, `EMAIL_PROVIDER` (`brevo|mailerlite`), `EMAIL_API_KEY`, `EMAIL_LIST_ID`. Fail loudly if a required var is missing in production. Best-effort in-memory rate limiting per IP.

### Verification you must do before returning
- `node --check` every JS file you wrote; `python -c "import json,sys; json.load(open('file'))"` every JSON; parse every JSON-LD block you wrote with a small node one-liner.
- `node tools/site-check.mjs` from the repo root and fix every ERROR that mentions a file you own.
- Open every external citation URL with WebFetch and confirm the quoted sentence exists.
- Do not use the Browser pane (it is single-tab and shared) unless your task explicitly says you may.

## 5. Tone and copy

Calm, precise, kind. Second person. Short sentences. No hype, no exclamation marks in body copy, no "unlock your potential". Plain language about what the evidence does and does not show. British or American spelling is fine but be consistent within a page (default American). Author byline: Georges Rayess (not a clinician — say so honestly on `/about`).

## 6. Structured return

Every build agent returns JSON matching the schema it was given. Always include: `files_written[]`, `integration_requests[]` (each `{type: 'nav-link'|'rewrite'|'redirect'|'css'|'precache'|'og-image'|'other', detail}`), `citations[]` (`{url, quote, used_on}`), `owner_review_flags[]` (health claims or legal wording the owner must approve before publish), `known_gaps[]`.

## 7. Interfaces between build agents (agreed up front so parallel work fits together)

- **Timer markup slots** (Core includes both in every app root and in `docs/PAGE_CONTRACT.md`): `<div data-slot="tools"></div>` (next to the settings button; Pro modules inject "Your practice", "Soundscapes", "Custom pattern" buttons here) and `<div data-slot="post-session"></div>` (below the controls; paywall + email capture cards render here).
- **Pro entry module**: every app page loads `<script type="module" src="/js/pro/index.js"></script>` after `/js/app.js`. Core creates it as a one-line placeholder; the Pro agent replaces it. `js/pro/index.js` imports and initialises `patterns.js`, `streaks.js`, `paywall.js`, `capture.js`, `night.js` and `soundscapes.js` (the Audio agent owns `js/pro/soundscapes.js`, exporting `initSoundscapes(rootEl, { requirePro, track })`).
- **Checkout**: the Pro agent owns `js/checkout.js` exporting `checkout(sku)` (`sku` ∈ `lifetime|monthly|practitioner|studio|pack`) and `js/config.js` exporting `CHECKOUT` (`{ mode: 'link'|'paddle'|'waitlist', clientToken: '', urls: {...}, priceIds: {...} }`). Other pages call `checkout(sku)` from a `data-action="checkout" data-sku="practitioner"` button. When checkout is not configured yet, `checkout()` opens the founding-member waitlist capture instead of a dead link.
- **Licence token** (API agent): `base64url(payloadJSON) + "." + base64url(HMAC-SHA256)`; payload `{ v:1, tier, sub, iat, exp, kid, act, dom? }` where `dom` is an optional array of allowed hostnames for practitioner white-label embeds. Lifetime tokens expire in 30 days, subscription tokens in 7 days; the client keeps working 14 days past `exp` if the refresh call fails (offline grace).
- **Embed white-label check** (Embed agent): `embed/v1/frame.html?wl=<token>` POSTs the token to `/api/entitlement`; if tier is practitioner/studio and `dom` is absent or contains the referrer host, attribution is removed and branding params apply. Otherwise the free frame renders with attribution.
- **Client session link config** (Embed and Practitioner agents): `/s/?c=<base64url(JSON)>` where JSON is `{ t: techniqueKey, d: seconds, n: practitionerName, l: logoUrl, c: accentHex, m: message, wl: tokenOrEmpty }`. The Practitioner agent's link builder produces it; the Embed agent's `s/index.html` consumes it.
- **Email capture** posts `{ email, technique, source, consent: true }` to `/api/subscribe` and expects `{ ok: true, message }` or `{ ok: false, error }` (API agent).
- **Ad slots**: `<div class="ad-slot" data-ad-slot="in-content-1" aria-hidden="true"></div>` (Core styles reserve height; `js/ads.js` fills). Allowed only on content/comparison pages, never on the pages listed in rule 6.
- **OG images**: reference `/images/og/<slug>.jpg`; the Render agent generates one per slug in `tools/og-manifest.json`.
- **Vercel Hobby caveat (owner decision, not yours):** Vercel's fair-use policy restricts Hobby to non-commercial use. Build everything Vercel-native and portable; the owner will either upgrade to Vercel Pro or move to Cloudflare Pages. Keep `api/` handlers Web-standard so they port.
