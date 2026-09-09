# Module API — Help Me Breathe

The exported surface of every shared module in `js/`. **This file is the source of
truth.** If `docs/AGENT_BRIEF.md` and this file disagree, this file wins.

Rules that apply everywhere:

- Everything is a native ES module. No bundler, no npm runtime dependencies.
- Load with `<script type="module" src="/js/app.js"></script>` — root-relative,
  so pages in subfolders work.
- No inline `onclick`. Use `data-action` attributes; the engine delegates.
- Nothing in `js/` reads or writes a cookie. Only `localStorage`, only under the
  `hmb.` namespace, always inside `try/catch`.

Load order on a page with a timer:

```html
<script type="module" src="/js/consent.js"></script>
<script type="module" src="/js/app.js"></script>
<script type="module" src="/js/pro/index.js"></script>
<!-- only on pages that carry an ad slot -->
<script type="module" src="/js/ads.js"></script>
```

`js/app.js` imports `techniques.js`, `storage.js` and `analytics.js` itself, and
`analytics.js` imports `consent.js`, so those tags are all you need.

---

## `js/techniques.js`

Pure data and pure functions. No DOM, no storage, no network — safe to import
from the app, a landing page, or the sandboxed embed frame.

```js
import {
  TECHNIQUES, TECHNIQUE_ORDER, DEFAULT_TECHNIQUE,
  THEME_CLASSES, CIRCLE_CLASSES,
  getTechnique, techniqueForPath, patternToPhases, cycleSeconds,
} from '/js/techniques.js';
```

### Exports

| Export | Type | Notes |
|---|---|---|
| `TECHNIQUES` | `Record<string, Technique>` | Keyed by technique key. |
| `TECHNIQUE_ORDER` | `string[]` | `['478','box','coherent','sigh','extended','triangle','wim']`. Display order **and** the order the `1`–`7` keyboard shortcuts follow. |
| `DEFAULT_TECHNIQUE` | `string` | `'478'`. |
| `THEME_CLASSES` | `string[]` | Every `body` theme class the engine may add or remove. |
| `CIRCLE_CLASSES` | `string[]` | Every circle class the engine may add or remove. |
| `getTechnique(key)` | `Technique \| null` | Safe lookup; never throws. |
| `techniqueForPath(pathname)` | `Technique \| null` | Resolves a URL to a technique. |
| `patternToPhases(pattern)` | `Phase[]` | Builds phases from a 4-part pattern. |
| `cycleSeconds(phases)` | `number` | Total seconds in one full cycle. |

### The `Technique` object

```js
{
  key: '478',
  slug: '4-7-8-breathing',        // clean URL of its landing page, no leading slash
  name: '🌙 Deep Sleep',           // display name, includes the emoji
  shortName: '4-7-8',             // for pills, tables and tight spaces
  emoji: '🌙',
  title: 'Deep Sleep & Relaxation', // plain-language heading, no emoji
  theme: 'theme-478',             // class the engine puts on <body>
  circleClass: 'technique-478',   // class the engine puts on the circle
  phases: [
    { name: 'Inhale', duration: 4, class: 'inhale', text: '…', frequency: 174.61 },
    { name: 'Hold',   duration: 7, class: 'hold',   text: '…', frequency: 0 },
    { name: 'Exhale', duration: 8, class: 'exhale', text: '…', frequency: 130.81 },
  ],
  description: '…',               // 1–2 plain sentences, no health claims
  benefits: ['Many people use it to …'],
  contraindications: ['…'],       // never empty
  requiresSafetyAck: false,       // true only for 'wim'
  sources: [],                    // ALWAYS empty here — page agents own citations
}
```

`title` is an addition to the shape sketched in `AGENT_BRIEF.md §4`; it exists so
a page can print a heading without an emoji in it. Everything else matches.

`sources` is deliberately empty. A citation may only appear on a page whose
author opened the source with WebFetch and quoted the supporting sentence.

### The seven techniques

| Key | Slug | Pattern (s) | Cycle | Theme | Circle class | Safety ack |
|---|---|---|---|---|---|---|
| `478` | `4-7-8-breathing` | in 4 / hold 7 / out 8 | 19s | `theme-478` | `technique-478` | no |
| `box` | `box-breathing` | in 4 / hold 4 / out 4 / hold 4 | 16s | `theme-box` | `technique-box` | no |
| `coherent` | `heart-coherence-breathing` | in 5 / out 5 | 10s | `theme-coherent` | `technique-coherent` | no |
| `sigh` | `cyclic-sighing` | in 2 / in 1 / out 6 | 9s | `theme-sigh` | `technique-sigh` | no |
| `extended` | `extended-exhale-breathing` | in 4 / out 6 | 10s | `theme-extended` | `technique-extended` | no |
| `triangle` | `triangle-breathing` | in 3 / hold 3 / out 3 | 9s | `theme-triangle` | `technique-triangle` | no |
| `wim` | `energizing-breath` | in 2 / out 1 | 3s | `theme-wim` | `technique-wim` | **yes** |

`sigh` has **two consecutive inhale phases**. The short top-up carries
`class: 'inhale inhale-short'`; the engine applies every class in that string to
the circle, so `.inhale-short` styling works.

Never write "Wim Hof" in a title, H1, meta description or slug. The `wim` key and
the `theme-wim` class are internal names only; the display name is
`☀️ Energizing Breath`.

### `techniqueForPath(pathname)`

Matches the last path segment against every `slug`, after stripping `.html`, a
trailing slash and any query or fragment. Also accepts these aliases:
`4-7-8-breathing-technique` and `478-breathing` → `478`, `coherent-breathing` →
`coherent`, `physiological-sigh` → `sigh`, `extended-exhale` → `extended`.
Returns `null` for anything else (including `/timer` and `/`).

```js
techniqueForPath('/box-breathing');       // TECHNIQUES.box
techniqueForPath('/box-breathing.html');  // TECHNIQUES.box
techniqueForPath('/timer');               // null
```

### `patternToPhases({ inhale, hold1, exhale, hold2 })`

Every part is optional and defaults to `0`. Zero-length parts are omitted, values
are rounded to whole seconds and clamped to 1–300.

```js
patternToPhases({ inhale: 5, exhale: 5 });
// [ { name:'Inhale', duration:5, class:'inhale', text:'Breathe in for 5 seconds',  frequency:174.61 },
//   { name:'Exhale', duration:5, class:'exhale', text:'Breathe out for 5 seconds', frequency:130.81 } ]
```

---

## `js/storage.js`

Every `localStorage` read and write on the site. Keys live under `hmb.`. When
storage is unavailable (private mode, Lockdown, quota) it transparently falls
back to a same-tab in-memory mirror and the app behaves identically — it just
forgets on reload.

```js
import {
  getSettings, getSavedSettings, saveSettings,
  appendSession, getHistory, completedSessionCount, clearHistory,
  getFlag, setFlag,
  setPersistence, HISTORY_LIMIT, DEFAULT_SETTINGS,
} from '/js/storage.js';
```

| Function | Returns | Notes |
|---|---|---|
| `getSettings()` | `{ technique, duration, sound, vibration }` | Always complete; defaults merged in. |
| `getSavedSettings()` | a partial of the same shape | **Only** what this browser actually chose. Keys never touched are absent — this is what lets a page's `data-technique` act as a first-visit default without overriding a real preference. |
| `saveSettings(patch)` | the complete merged settings | Writes only the keys you pass plus the keys already saved. |
| `appendSession(record)` | the stored record, or `null` | Caps history at `HISTORY_LIMIT` (500), oldest evicted. |
| `getHistory()` | `SessionRecord[]` | Oldest first. Never `null`. |
| `completedSessionCount()` | `number` | Records with `completed === true`. |
| `clearHistory()` | `void` | |
| `getFlag(name)` | `true \| false \| string \| null` | `getFlag('ack.wim')` reads `hmb.ack.wim`. |
| `setFlag(name, value)` | `void` | `null`/`undefined` removes the flag. |
| `setPersistence(enabled)` | `void` | `false` keeps everything in memory for the rest of the page's life. |

Keys in use: `hmb.settings`, `hmb.history`, `hmb.consent` (owned by `consent.js`),
`hmb.license` (owned by `entitlements.js`), `hmb.ack.<techniqueKey>`,
`hmb.third-session-tracked`.

```js
// SessionRecord
{ date: '2026-09-09T10:04:11.238Z', technique: 'box', seconds: 300, breaths: 18, completed: true }
```

**Consent note.** Settings and history are functional storage: a preference, no
identifier, never transmitted. They are written regardless of the cookie choice.
`BUILD_SPEC.json` FEAT-01 asks for consent-gated persistence; call
`setPersistence(false)` from `consent.js` if the owner decides to gate it.

---

## `js/consent.js`

Cookie banner plus Google Consent Mode v2 updates. Import it or just load it —
it self-initialises on `DOMContentLoaded` and injects its own banner markup, so
pages carry no banner HTML.

```js
import { hasAnalyticsConsent, hasAdConsent, consentState, setConsent } from '/js/consent.js';
```

| Function | Returns | Notes |
|---|---|---|
| `hasAnalyticsConsent()` | `boolean` | True only after the visitor chose "Accept all". |
| `hasAdConsent()` | `boolean` | Same decision today; separated so they can diverge. |
| `consentState()` | `'all' \| 'essential' \| null` | `null` means no decision yet. |
| `setConsent(value)` | `void` | `'all'` or `'essential'`. Persists and pushes a Consent Mode update. |

Dispatches `hmb:consent` on `document` with
`{ decision, analytics: boolean, ads: boolean }` whenever a decision is made or
replayed on load.

**The denied defaults are NOT in this file.** ES modules are deferred, so they
must be pushed by the inline head script *before* `gtag('config', …)`. Copy that
block from `docs/PAGE_CONTRACT.md` verbatim onto every page.

---

## `js/analytics.js`

```js
import { track, EVENTS } from '/js/analytics.js';

track(EVENTS.PAYWALL_VIEW, { feature: 'patterns' });
```

`track(name, params)` forwards to `gtag('event', name, params)` and returns
`true` when it actually sent. It is a no-op when `gtag` is missing or analytics
consent has not been granted; up to 20 events are queued and replayed once if the
visitor later accepts.

`EVENTS` is frozen and enumerates every allowed name:

`session_start`, `session_complete`, `session_abandon`, `technique_select`,
`settings_open`, `third_session_reached`, `paywall_view`, `paywall_click`,
`checkout_open`, `activate_attempt`, `activate_success`, `activate_fail`,
`restore_success`, `capture_shown`, `capture_submit`, `support_click`,
`pwa_install`, `outbound_affiliate_click`, `embed_snippet_copied`.

Never pass an email address, a licence key, or free-text user input as a param.

---

## `js/entitlements.js`

> **Functional stub. The Pro agent replaces this file.** The API below is the
> contract; do not change it. Today it decodes the token payload without
> verifying the signature — real verification is server-side in `/api/entitlement`.

```js
import { isPro, isPractitioner, tier, requirePro, activate, restore, deactivate, onChange, parseToken } from '/js/entitlements.js';
```

| Function | Returns | Notes |
|---|---|---|
| `tier()` | `'free' \| 'pro' \| 'practitioner' \| 'studio'` | |
| `isPro()` | `boolean` | True for pro, practitioner and studio. |
| `isPractitioner()` | `boolean` | True for practitioner and studio. |
| `requirePro(featureName)` | `boolean` | When `false`, dispatches `hmb:paywall` with `{ feature }`. **The only gate any feature may use.** |
| `activate(key)` | `Promise<{ok, tier?, error?}>` | POSTs `{ key }` to `/api/license`, stores the returned `{ token }`. |
| `restore()` | `string` (tier) | Re-reads `localStorage['hmb.license']`. |
| `deactivate()` | `void` | Removes the token, drops to free. |
| `onChange(cb)` | unsubscribe fn | `cb(tier, { exp, payload })`. |
| `parseToken(token)` | `object \| null` | Decodes the base64url payload **without verifying the signature**. Read-only helper for debugging and for the Pro agent's own UI; never use it as a gate — `requirePro()` is the only gate. |

Token: `base64url(payloadJSON) + '.' + base64url(HMAC-SHA256)`, payload
`{ v, tier, sub, iat, exp, kid, act, dom? }`. `exp` is in seconds. A tier stays
valid until `exp + 14 days` (offline grace), then falls back to free. A `storage`
event on `hmb.license` re-evaluates, so activating in one tab lights up the others.

Never log, track or transmit a full licence key.

---

## `js/ads.js`

```js
import { initAds, removeAds } from '/js/ads.js';
```

Self-initialises. It refuses to do anything when `isPro()`, when
`<body data-no-ads="true">`, when `body.session-active` is present, or when the
page has no `.ad-slot[data-ad-slot]`. It waits for a consent decision, then for
first interaction or 3s idle, then injects the AdSense loader
(`ca-pub-7348129075274196`) and fills each slot. When advertising storage was
declined it sets `requestNonPersonalizedAds = 1`.

---

## `js/app.js` — the engine

```js
import { createBreathingApp, getApps, getApp, audioSystem } from '/js/app.js';
```

Every `[data-breathing-app]` element is initialised automatically on
`DOMContentLoaded`. Call `createBreathingApp` yourself only for a timer you add
to the DOM later.

### `createBreathingApp(rootEl, options?)`

`rootEl` is any element that **contains the whole timer UI** — including the
technique buttons, if the page has them. On `index.html` that is `<main>`; on a
technique page it is the `<section class="breathing-section">`. Every lookup is
`rootEl.querySelector('[data-role="…"]')`, so **multiple timers per page work**
and the engine uses no element ids at all.

Options (each falls back to the matching `data-` attribute on the root):

| Option | Attribute | Meaning |
|---|---|---|
| `technique` | `data-technique` | Starting technique key. |
| `duration` | `data-duration` | Session length in seconds; `-1` = unlimited. |
| `lockTechnique` | `data-lock-technique` | Ignore technique changes (a fixed technique page). |
| `autostart` | `data-autostart` | Start ~300ms after init. |
| `kiosk` | `data-kiosk` | Projector mode: oversized type, controls hidden, autostart, loop, Screen Wake Lock. |
| — | `data-lock-theme` | On the root, `<body>` or `<html>`: do not touch the `<body>` theme class. |

**Resolution order.** Technique: `?t=` → `options.technique` →
`data-technique` (when `data-lock-technique`) → saved setting → `data-technique`
→ `techniqueForPath(location.pathname)` → `DEFAULT_TECHNIQUE`.
Duration: `?d=` → `options.duration` → saved setting → `data-duration` → 600
(or `-1` in kiosk mode). So `data-duration` is the default for a first-time
visitor, and a returning visitor keeps the length they chose.

`/timer?t=box&d=300` therefore opens the hub timer on box breathing for five
minutes. An unknown `t` is ignored rather than erroring.

### Returned API

```js
const app = createBreathingApp(document.querySelector('[data-breathing-app]'));

app.start();                       // start, or resume from paused
app.pause();
app.stop();                        // ends the session; records it if >= 30s
app.selectTechnique('box');        // no-op when data-lock-technique is set
app.selectTechnique('box', { force: true });   // override the lock
app.setPattern({ inhale: 4, hold1: 4, exhale: 6 }, { name: 'My wind-down' });
app.getState();
app.destroy();                     // removes listeners and deregisters
```

`getState()` returns:

```js
{
  technique: 'box',   // 'custom' after setPattern()
  phases: [ … ],      // a copy
  running: false, paused: false,
  phaseIndex: 0, breaths: 0, seconds: 0,
  duration: 600, sound: true, vibration: true,
  kiosk: false, lockTechnique: false,
}
```

`getApps()` returns every live instance in DOM order; `getApp(rootEl)` returns one.

### `data-role` reference

Every one is optional — a missing role is simply not driven.

`circle`, `circle-text`, `breathing-text`, `timer`, `progress-fill`,
`progress-time`, `session-info`, `session-progress-fill`,
`session-time-remaining`, `start`, `pause`, `stop`, `stats`, `breath-count`,
`avg-breath`, `session-progress`, `technique-title`, `technique-info`,
`settings-btn`, `settings-panel`, `sound-toggle`, `vibration-toggle`,
`duration-select`, `technique-buttons`, `safety-ack`, `safety-ack-body`,
`live-region`.

Plus one page-level role, looked up on `document`: `keyboard-hint`.

`technique-info` is rendered from the technique unless it carries `data-static`,
in which case the engine leaves your markup alone.

### `data-action` reference

Delegated from the root. Never use inline `onclick`.

`start`, `pause`, `stop`, `select-technique` (with `data-technique="box"`),
`toggle-settings`, `safety-ack-confirm`, `safety-ack-cancel`.

Plus one page-level action, delegated from `document`: `support` (fires
`support_click`; add `data-support-label="patreon"` to name it).

### Slots

- `<div class="tools-row" data-slot="tools"></div>` — Pro modules inject
  "Your practice", "Soundscapes", "Custom pattern" buttons here.
- `<div data-slot="post-session"></div>` — paywall and capture cards render here.

`[data-slot]:empty` is `display: none`, so an unfilled slot occupies no space.

### Events (on `document`)

| Event | When |
|---|---|
| `hmb:ready` | Instance initialised. |
| `hmb:technique-change` | Technique or custom pattern changed. |
| `hmb:session-start` | A session began. |
| `hmb:phase` | Each phase change. |
| `hmb:session-pause` | Paused. |
| `hmb:session-complete` | Ran to the full duration. |
| `hmb:session-stop` | Stopped early. |
| `hmb:consent` | From `consent.js`. |
| `hmb:paywall` | From `entitlements.js`, `{ feature }`. |

Every engine event carries at least:

```js
{ technique, seconds, breaths, completed, root, instance }
```

`hmb:phase` adds `{ phase, phaseKind, phaseIndex, phaseDuration }`;
`hmb:ready` and `hmb:session-start` add `{ duration }`.

```js
document.addEventListener('hmb:session-complete', (e) => {
  if (e.detail.completed) renderCard(e.detail.root.querySelector('[data-slot="post-session"]'));
});
```

### Behaviour worth knowing

- **`body.session-active`** is added while any instance has a session, and stays
  on through a pause so an ad or an ask cannot appear mid-practice. It is removed
  on stop and on complete.
- **History.** A `{date, technique, seconds, breaths, completed}` record is
  appended on complete, and on stop when at least 30 seconds elapsed
  (`completed: false`). Nothing is recorded for a 5-second try.
- **`third_session_reached`** fires once, the first time
  `completedSessionCount()` reaches 3; guarded by the `hmb.third-session-tracked` flag.
- **Safety acknowledgement.** When `technique.requiresSafetyAck` is true and
  `hmb.ack.<key>` is not set, pressing Begin reveals `[data-role="safety-ack"]`
  (populated from `contraindications`) instead of starting. Confirming sets the
  flag and starts.
- **Keyboard.** `Space` start/pause, `S` stop, `1`–`7` pick the technique at that
  index of `TECHNIQUE_ORDER`. Shortcuts go to the instance containing
  `document.activeElement`, else the first instance on the page. Ignored inside
  inputs, selects, textareas and contenteditable, and `Space` is left alone when
  a button or link has focus.
- **Reduced motion.** With `prefers-reduced-motion: reduce` the engine does not
  restart the scale animation; the circle's `data-phase` attribute
  (`inhale`/`hold`/`exhale`) drives opacity and brightness instead.
- **Announcements.** `[data-role="live-region"]` gets `Inhale for 4 seconds` on
  every phase change, plus `Paused`, `Resumed. Inhale for 4 seconds`,
  `Session stopped`, `Session complete`.
- **Timing.** One `setInterval(50ms)` per instance drives progress, phase
  advance and the session clock. Elapsed time is measured from timestamps, so a
  throttled background tab loses smoothness but not accuracy.
- **Audio.** One `AudioContext` for the page (`audioSystem`), started on first
  user gesture. Phases with `frequency: 0` are silent.
- **Service worker.** `app.js` registers `/sw.js` on https and on localhost.

---

## `js/pro/index.js`

A one-line placeholder that exports `PRO_MODULE_READY = false`. The Pro agent
replaces it with the real entry module (patterns, streaks, paywall, capture,
night mode, soundscapes). Every app page already loads it, so shipping the real
module needs no HTML change.
