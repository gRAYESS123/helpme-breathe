# The plan — how it works

Everything paid on Help Me Breathe lives behind three files and never leaks past
them:

| File | Owns |
|---|---|
| `js/entitlements.js` | what the visitor may do (`free` / `pro`) |
| `js/auth.js` | who the visitor is (Supabase; the only module that knows it exists) |
| `js/config.js` | the public provider values the owner edits |

If you change merchant of record, you edit `js/config.js` and
`api/_lib/providers/`. If you change what the plan unlocks, you edit the module
that owns that feature. Nothing else moves.

---

## 1. What is for sale

**One plan, everything included, for one person.** Owner decision, 2026-09-11.

Owner decision, 2026-09-12: the practitioner layer was removed from the product
entirely. There is no practitioner plan, no practitioner page, no client
handouts, no compliance pack, no client session links, no embed widget and no
commercial-use right. Help Me Breathe is a personal guided-breathing timer.

| What | Price | What it covers |
|---|---|---|
| Free | $0 | Every technique, every duration, audio and vibration cues, the offline PWA, saved settings, session history. **Three timer sessions on this device before the timer asks for an account.** |
| The plan, monthly | $10/month (US list) | Everything: custom patterns and saved presets, streaks and a 12-week history with CSV export, ambient soundscapes, night mode, no ads, offline use |
| The plan, yearly | $100/year (US list) | The same plan, billed once a year |

Billed in advance and renewing automatically until cancelled; tax is added at
checkout by the merchant of record. A **3-day trial** requires a card, does not
charge it during the trial, and charges the price shown at checkout when the
3 days end unless the customer cancels first. Cancelling takes two clicks from
the account page. **One free trial per person.** 14-day unconditional refund by
email to contact@helpmebreath.com.

**An account is for one person or one household.** Sign-in is an email link, a
6-digit code, or a Google account — **no passwords, anywhere**.

There are no tiers, no lifetime unlock, no licence keys, no device activations,
no domain counts and no waitlist. The merchant of record is not named on the
site: write "a merchant of record" until the owner has chosen one in writing.

The US list prices in `PLANS` are **copy only**. What a person is actually
charged comes from the provider's own price preview and receipt.

---

## 2. Gating

Two gates, and only two.

```js
import { requirePro, requireTimer } from '/js/entitlements.js';

saveButton.addEventListener('click', () => {
  if (!requirePro('presets')) return;   // dispatches hmb:paywall, returns false
  savePreset();
});
```

`requirePro(feature)` is the **only** gate a paid feature may use.
`requireTimer()` is called by the engine on Start and by nothing else. Nothing
in the codebase reads the entitlement token directly, and nothing else decides
what a visitor may do.

### The matrix

| Surface | Signed out, under 3 sessions | Signed out, 3 sessions used | Signed in, no subscription | Subscriber |
|---|---|---|---|---|
| The timer on `/`, `/timer`, a technique page | runs | **preview** + sign-in card | **preview** + checkout card | runs |
| The two crisis pages | runs | runs | runs | runs |
| Presets, streaks, night switch, soundscapes, shareable pattern links | locked, visible | locked, visible | locked, visible | unlocked |
| Everything that is prose | free | free | free | free |

`TIMER_FREE_SESSIONS = 3` in `js/config.js` is read in exactly one place,
`requireTimer()`. The count is per device (`__Host-hmb_did`, mirrored at
`hmb.did`), server-authoritative when online and the local count otherwise. It
is **soft**: clearing cookies resets it. That is accepted — the alternative is
fingerprinting, which hard rule 8 forbids.

### `data-open-timer` — the two crisis pages, forever

```html
<body data-open-timer="true">
```

`requireTimer()` returns `true` immediately for any page carrying it. It is a
**safety feature, not a config knob**, and `tools/site-check.mjs` fails the build
if it appears anywhere but these two files, or is missing from either:

- `breathing-exercises-anxiety.html`
- `breathing-exercises-for-panic-attacks.html`

A person in a panic attack never meets an account prompt.

### The preview state

A timer page past the allowance is **not a wall**. The prose, the
contraindications, the science and the FAQ stay exactly as they were — and so
does the circle. When Start finds `requireTimer()` false, `js/app.js` enters
preview mode, dispatches `hmb:preview` with
`{ reason: 'signed_out' | 'no_subscription', … }`, and `js/pro/preview.js`:

1. animates **one continuous demonstration cycle** at the technique's real pace,
   phase word, count and ring included, so the visitor sees what they would get
   and can follow along by eye. Nothing is timed, counted, recorded, spoken or
   vibrated;
2. renders **one card** into `[data-slot="post-session"]` — "Create an account to
   keep going", `$10 a month or $100 a year — everything included. 14 days,
   unconditional refund.`, and either the sign-in link or the two checkout
   buttons;
3. stamps `body.timer-preview`, which makes `js/ads.js` refuse to fill a slot.
   The first thing a person sees on a timer page is never an ad next to a
   sign-in prompt.

Structured data on those pages must **not** carry `isAccessibleForFree: false`:
only the interactive timer is gated, never the article. `site-check` enforces it.

### Locked, not hidden

Gated controls stay **visible and locked**, never hidden. A visitor who cannot
see that a thing exists cannot decide to buy it. Where a feature card lands: the
first **visible** `[data-paywall-slot]` — each Pro panel carries one — and
otherwise the timer's `[data-slot="post-session"]`. A hidden slot is never used.

The one exception is a page carrying `<body data-no-asks="true">` (the crisis
pages): there a free visitor sees no locked control and no mention of the plan at
all, while a subscriber keeps every tool.

---

## 3. The pages

| Path | File | What it is |
|---|---|---|
| `/pro` | `pro.html` | The offer: the plan, the two intervals, what is included, the trial and refund disclosures, the FAQ. Checkout buttons are plain `data-action="checkout" data-plan="…"`. |
| `/pro/thanks` | `pro/thanks.html` | Where checkout lands. It does **not** load the provider's checkout script — a visitor arriving with the provider's own transaction parameter would otherwise have a checkout re-open on top of their thank-you page. |
| `/signin` | `signin.html` | Email link, 6-digit code, or Google. Carries `?next=` and `?intent=subscribe:<plan>` through. |
| `/auth/callback` | `auth/callback.html` | Completes the sign-in and **resumes the intent**: a visitor who clicked Subscribe while signed out is taken straight into checkout on this page, with no further page load. |
| `/account` | `account.html` | Your account, your plan, your data. |

`/account` is where the plan is managed: the current status and next charge from
`GET /api/me`; portal links minted on click by `POST /api/billing/portal`;
pause (1 or 3 months), switch to yearly, and cancel — each stating, before the
confirm button, exactly what will happen and on which date; and the two data
controls, export (`GET /api/account/export`) and delete
(`POST /api/account/delete`).

`/signin`, `/auth/callback` and `/account` are in the service worker's
never-cache list. They always come from the network.

---

## 4. Checkout

```html
<button type="button" data-action="checkout" data-plan="monthly">Subscribe</button>
```

```js
import { subscribe } from '/js/checkout.js';
subscribe('yearly');
```

`data-plan` is `monthly` or `yearly` — the two intervals of the one plan. **A
button never carries a price id**, and the browser never chooses a price.
`data-sku` and the SKUs retired on 2026-09-11 (`lifetime`, `practitioner`,
`studio`, `pack`) are gone and must not come back; `checkout(sku)` survives only
as an alias of `subscribe(plan)`.

What a click does:

1. **No checkout token configured** (`CHECKOUT.clientToken` empty) → a calm
   "Checkout is not open yet" card, so a button is never dead. There is no
   waitlist and no founding offer.
2. **Signed out** → `/signin?next=…&intent=subscribe:<plan>`, and
   `/auth/callback` resumes it.
3. `POST /api/trial/eligibility` with `{ plan, device_mirror }` and the Supabase
   bearer token. **The server** decides whether a trial applies, picks the price
   from its own environment, creates the transaction, and answers with a
   transaction id and a localised price preview.
4. The overlay opens with that transaction id — never an items array, never a
   price id.

Trial wording on a button is only used when the visitor is signed in **and**
their last `/api/me` said `trial.available: true`. Everyone else sees
"Subscribe". The server decides at checkout either way, so the button never
promises something the checkout then withdraws.

### What the owner edits in `js/config.js`

Five exports, nothing secret:

| Export | What to put in it |
|---|---|
| `SUPABASE` | The project URL and the **publishable** (anon) key, from Supabase → Project settings → API. The same two values also go into Vercel as `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. |
| `CHECKOUT.clientToken` | The merchant of record's **client-side** token (`test_…` or `live_…`), from its dashboard. Public by design. The same value goes into Vercel as `MOR_CLIENT_TOKEN`. An **API key is not public** and belongs only in Vercel. |
| `CHECKOUT.sandbox` | `true` while the token is a `test_` token. Flip to `false` in the same edit that swaps in the `live_` token — never one without the other. |
| `CHECKOUT.previewPriceIds` | Optional. The public **no-trial** price ids, used by `/pro` only to show a localised total before checkout. Leave empty and the card shows the US list price with "plus any tax". |
| `MOR_LEGAL` | The merchant-of-record sentence. One place, every page. Replace "a merchant of record" with the provider's legal name in the same commit that turns checkout on. |

`PLANS` and `TIMER_FREE_SESSIONS` are owner decisions, not configuration to be
tuned per page: there is one plan with two intervals and no switch for a second
(owner decision 2026-09-12: no practitioner or therapist plan, ever), and
`TIMER_FREE_SESSIONS` is read in `requireTimer()` and nowhere else.

Website approval for helpmebreath.com must have passed at the provider or the
overlay refuses to open; sandbox works meanwhile.

### Swapping provider

1. Create the four prices at the new provider (monthly and yearly, each with and
   without the trial period).
2. Write `api/_lib/providers/<name>.js` to the v3 adapter contract in
   [`docs/API.md`](API.md) and add it to `listProviders()`.
3. Point `MOR_PROVIDER`, `MOR_API_KEY`, `MOR_WEBHOOK_SECRET`, `MOR_CLIENT_TOKEN`
   and the four `MOR_PRICE_*` variables at it in Vercel.
4. Update `CHECKOUT.clientToken` in `js/config.js`.
5. Redeploy.

No feature file, no page and no gate changes. Existing subscriptions are moved at
the provider; entitlement tokens keep working until their `exp`.

---

## 5. The modules

| File | What it does |
|---|---|
| `js/pro/index.js` | Entry point. Injects `css/pro.css` once, wires the paywall and capture, initialises the per-instance tools on every `hmb:ready`, imports `js/checkout.js`, and dynamically imports `./soundscapes.js` inside try/catch so a missing audio module can never break a page. |
| `js/pro/preview.js` | The preview state (§2): one demonstration cycle and one account card, plus `body.timer-preview`. |
| `js/pro/patterns.js` | "Custom pattern": four sliders, a live plain-words preview, **Run** (free), **Save preset** and **Copy share link** (plan). Presets live at `hmb.presets`. On `/timer` it reads `?p=4-7-8-0&name=…` and applies it, for anyone. |
| `js/pro/streaks.js` | "Your practice": current and longest streak, total minutes, sessions this week, a 12-week heatmap with an aria-label per day, a per-technique breakdown, CSV export. Free sees the last seven days plus a blurred heatmap. |
| `js/pro/paywall.js` | The offer card on the third completed session (once ever, flag `hmb.paywall.shown`, dismissible forever) and the inline feature card driven by `hmb:paywall` / `hmb:signin`. **`feature: 'timer'` is deliberately ignored here** — that is `preview.js`'s card, so the post-session slot never carries two cards for one Start. Exports `buildCard()` and `planLine()` so `preview.js` renders the same body and buttons under its own heading. |
| `js/pro/capture.js` | The post-session printable offer: email + consent → `POST /api/subscribe`. Once ever (`hmb.capture.shown`), never on `data-no-asks` pages, never on the same completion as the offer card. |
| `js/pro/night.js` | The night switch (plan): `body.night`, plus `navigator.wakeLock` while a session runs. Persisted at `hmb.night`. |
| `css/pro.css` | Panels, sliders, heatmap, night mode, the offer, preview and capture cards, and the `/pro` page furniture. |

Feature names passed to `requirePro()`, each with its own card copy: `presets`,
`streaks`, `night`, `soundscapes`, `share`. Plus `timer`, which `preview.js`
answers.

### Storage keys this layer owns

`hmb.ent`, `hmb.ent.snapshot`, `hmb.did` (all three inside
`js/entitlements.js`), `hmb.presets`, `hmb.night`, `hmb.paywall.shown`,
`hmb.capture.shown`. The flags go through `js/storage.js`, so they are try/catch
safe and fall back to an in-memory mirror when storage is blocked.

`hmb.license` and `hmb.license.key` are **retired**. `js/entitlements.js` deletes
them on first load and sets a flag; `/account` renders a one-time "email us with
your receipt" banner from it for anyone who held a key.

---

## 6. Events

All names come from `EVENTS` in `js/analytics.js`. Nothing here ever sends an
email address, a user id, a device id, a token, a provider customer id or any
free-text input.

| Event | Fired by | Params |
|---|---|---|
| `timer_gate_block` | `entitlements.js` | `{ technique, reason, free_sessions_used }` — `reason` is `signed_out` or `no_subscription` |
| `timer_preview_view` | `preview.js` | `{ technique, reason }` |
| `paywall_view` | `paywall.js` | `{ feature }`, plus `{ sessions }` on the third-session offer card (`feature: 'third-session'`) |
| `paywall_click` | `paywall.js`, `preview.js`, `checkout.js` | `{ feature, target }` for a link to `/pro` or `/signin`; `{ feature, plan }` for a checkout button inside an offer card |
| `signin_view` | `paywall.js`, `preview.js`, `/signin` | `{ source, feature }` |
| `signin_start` | `auth.js` | `{ method: 'magic_link' \| 'otp_code' \| 'google' }` |
| `signin_complete` / `signin_fail` | `/signin`, `/auth/callback` | `{ method }`, plus `{ reason }` on failure |
| `signin_resume_checkout` | `/signin`, `/auth/callback` | `{ plan }` |
| `signout` | `auth.js` | `{}` |
| `trial_eligibility_check` | `checkout.js` | `{ eligible, reason, plan }` |
| `checkout_open` | `checkout.js` | `{ plan, trial, mode: 'signin' \| 'overlay', placement }` |
| `trial_start` / `subscribe_start` | `/pro/thanks` | `{ plan }` — whichever the entitlement says, once, after checkout |
| `plan_interval_toggle` | `/pro` | `{ plan }` |
| `subscription_past_due` / `subscription_canceled` | `/account` | `{ plan }` |
| `manage_billing_click` | `/account` | `{ target }` |
| `cancel_screen_view` / `cancel_confirm` | `/account` | `{ status_at_cancel }` |
| `retention_offer_taken` | `/account` | `{ offer: 'pause_1' \| 'pause_3' \| 'annual' }` |
| `account_export` / `account_delete_request` | `/account` | `{}` / `{ had_subscription }` |
| `capture_shown` / `capture_submit` | `capture.js` | `{ technique, source }` |

`third_session_reached` is fired by the engine, not by this layer.
`trial_convert` is declared in `EVENTS` but **not fired anywhere yet** — the
conversion is only visible server-side today.

The retired activation events (`activate_attempt`, `activate_success`,
`activate_fail`, `restore_success`) are gone.

---

## 7. Rules this layer will not break

- **Every existing technique stays free**, and so does every word of prose. The
  plan adds tools around the practice; the gate is the timer's session count and
  the paid tools, never the content.
- **The timer runs for anyone, forever, on the two `data-open-timer` crisis
  pages.** That list is enforced by `site-check` and is not negotiable.
- No offer appears before the third completed session, and no offer appears
  twice.
- No offer of any kind is shown to someone who already pays. `paywall.js` checks
  `isPro()` on both paths, and deliberately leaves `hmb.paywall.shown` unset in
  that case, so the offer is still available if a subscription ever lapses.
- No ask of any kind renders while `body.session-active` — `css/styles.css` hides
  `[data-ask]` during a session, and these modules do not work around it.
- No offer, no capture and no locked control on a page with
  `<body data-no-asks="true">`.
- **No ad beside a sign-in prompt**: `body.timer-preview` makes `js/ads.js`
  refuse the page.
- **No passwords, and no card details ever reach us.** The account stores the
  email address, the sign-in identities, the creation date, the plan, its status
  and period dates, and the provider's subscription and customer ids. Nothing
  else.
- **No browser fingerprinting, ever.** The trial lock is a one-way hash of the
  email address plus a random identifier in a first-party cookie.
- 14-day unconditional refund, stated on `/pro` and reachable from checkout.
  `legal/terms-of-service.html` carries it as section 10; section 5 of the same
  page carries the automatic-renewal block and the trial-to-paid block, and
  `/pro` must show the same two disclosures, in the same words, before checkout.
- **Write the trial rule in exactly these words: "One free trial per person."**
  And the account rule as **"An account is for one person or one household."**
