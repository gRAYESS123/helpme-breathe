# The Pro layer — how it works

Everything paid on Help Me Breathe lives behind two files and never leaks past
them:

| File | Owns |
|---|---|
| `js/entitlements.js` | who the visitor is (`free` / `pro` / `practitioner` / `studio`) |
| `js/config.js` | who takes the money |

If you change merchant of record, you edit `js/config.js`. If you change what
the plan unlocks, you edit the module that owns that feature. Nothing else moves.

---

## 0. What is for sale (owner decision, 2026-09-11)

**One plan, everything included, for individuals and practitioners alike.**

| What | Price | What it covers |
|---|---|---|
| Free | $0 | The timer, every technique, every duration, the embeddable widget with attribution. No account needed |
| The plan, monthly | $10/month (US list) | Everything, including the practitioner features: commercial use, white-label embed, client links, class mode, handouts, compliance pack |
| The plan, yearly | $100/year (US list) | The same plan, billed once a year |

Billed in advance and renewing automatically until cancelled; tax is added at
checkout by the merchant of record. A **3-day free trial** needs a card, does not
charge it during the trial, and charges the price shown at checkout when the
3 days end unless the customer cancels first. Cancelling takes two clicks from the
account page. **One free trial per person.** 14-day unconditional refund by email.

**An account is for one person or one household.** Sign-in is an email link or a
Google account; there are no passwords.

There are no tiers, no lifetime unlock, no licence keys, no device activations and
no domain counts. The merchant of record is not chosen yet, and **nothing on the
site may name a provider** — write "a merchant of record". The Paddle specifics in
section 2 are a worked example of one provider's integration, kept because the
research is still good, not a commitment to it.

**Sections 1 and 2 below still describe the licence-key model.**
`js/entitlements.js`, `js/checkout.js` and the server API are being rebuilt
against this offer. This section is authoritative on what is sold; those sections
are a record of how the retired model worked.

---

## 1. Gating

`requirePro(featureName)` is the **only** gate any feature may use. Nothing else
in the codebase reads `localStorage['hmb.license']`, and nothing else decides
what a visitor may do.

```js
import { requirePro } from '/js/entitlements.js';

saveButton.addEventListener('click', () => {
  if (!requirePro('presets')) return;   // dispatches hmb:paywall, returns false
  savePreset();
});
```

When it returns `false` it dispatches `hmb:paywall` on `document` with
`{ feature }`. `js/pro/paywall.js` listens and shows a small card naming that
feature, once per page load per feature. A feature module never builds its own
upgrade prompt.

Where that card lands: the first **visible** `[data-paywall-slot]` — each Pro
panel carries one, so a card raised from an open panel appears under the control
that was pressed — and otherwise the timer's `[data-slot="post-session"]`. A
hidden slot is never used; the night-mode toggle sits in the tools row with every
panel closed, and a card rendered into a closed panel would be invisible.

Gated controls stay **visible and locked**, never hidden. A visitor who cannot
see that a thing exists cannot decide to buy it. The one exception is a page
carrying `<body data-no-asks="true">` (the crisis-safe pages): there a free
visitor sees no locked control and no mention of Pro at all, while a paying
visitor keeps every tool.

### The exported surface

```js
import {
  isPro, isPractitioner, tier, requirePro,
  activate, restore, deactivate, onChange,
  getLicenseInfo, parseToken,
} from '/js/entitlements.js';
```

| Function | Returns | Notes |
|---|---|---|
| `tier()` | `'free' \| 'pro' \| 'practitioner' \| 'studio'` | |
| `isPro()` | `boolean` | true for pro, practitioner and studio |
| `isPractitioner()` | `boolean` | true for practitioner and studio |
| `requirePro(feature)` | `boolean` | the only gate; dispatches `hmb:paywall` when false |
| `activate(key)` | `Promise<{ok, tier?, error?, code?}>` | POSTs `{ key }` to `/api/license`, stores `{ token }`. `error` is the server's finished sentence, shown to the buyer as-is; `code` is the reason to branch on (`pack_only`, `activation_limit`, `unrecognised_key`, …) |
| `restore()` | `string` | re-reads the stored token, returns the tier |
| `deactivate()` | `void` | removes the token, drops to free |
| `onChange(cb)` | unsubscribe fn | `cb(tier, { exp, payload })` |
| `getLicenseInfo()` | object | everything the UI may render: tier, expiry, grace state, activation count, key id, domains. **Never the key itself.** |
| `parseToken(token)` | `object \| null` | decodes the payload without verifying the signature — debugging only, never a gate |

### Token lifetime and the offline grace path

The token is `base64url(payloadJSON) + '.' + base64url(HMAC-SHA256)` with
payload `{ v, tier, sub, iat, exp, kid, act, dom? }`; `exp` is in seconds.

1. **Before `exp`** — the payload's tier applies. Inside the token's last week —
   or the second half of its life, whichever is shorter — a silent refresh runs
   so it renews before it can lapse. That arithmetic mirrors `/api/entitlement`,
   which rechecks on `min(7 days, half the token's lifetime)`: a subscription
   token lives exactly 7 days, so a flat "last week" rule on the client would
   fire a pointless refresh on every page load and always get the same token
   back.
2. **Past `exp`, inside 14 days** — the tier is *kept*, and one silent refresh is
   attempted: `POST /api/entitlement { token, key? }`. It runs on an idle
   callback, it never blocks anything, it never throws, and a failure changes
   nothing. This is what keeps a paying customer working on a plane, in a
   tunnel, or through a provider outage.
3. **Past `exp` + 14 days** — free.

**Why the key is stored.** `/api/entitlement` can only re-check with the merchant
of record when it is handed the licence key, because the token carries `sub`, a
one-way hash of the key. Given only a token it answers `refresh_required`. So
`activate()` stores the key at `localStorage['hmb.license.key']` next to the
token and the refresh sends it. Without that, a lifetime buyer would be asked to
paste their key again every six weeks (30-day token + 14-day grace). The key is
written and read only in `js/entitlements.js`, sent only to `/api/license` and
`/api/entitlement`, cleared by `deactivate()`, and never logged, tracked or put
in a URL.

Lifetime licences get 30-day tokens and subscriptions get 7-day tokens, so a
cancelled subscription self-expires within about three weeks with no revocation
list and no owner action.

Client-side decoding is a convenience, not a security boundary. The signature is
verified server-side in `/api/license` and `/api/entitlement`. Someone who edits
their own `localStorage` gets Pro features in their own browser and nothing else;
there is nothing there worth defending harder than that.

A `storage` event on `hmb.license` re-evaluates, so activating in one tab lights
up the others.

---

## 2. Checkout

```js
import { checkout } from '/js/checkout.js';
checkout('practitioner');
```

Or, from any page, with no JavaScript of its own:

```html
<button type="button" data-action="checkout" data-sku="monthly">Start the free trial — $10 a month</button>
```

`js/checkout.js` installs one delegated click handler on `document`, so any page
that loads it (every timer page does, via `js/pro/index.js`) gets working
buttons. A page with checkout buttons and no timer must load it directly:

```html
<script type="module" src="/js/checkout.js"></script>
```

A page that wires its **own** delegated checkout handler (as
`for-practitioners.html` does) sets `window.__hmbCheckoutBound = true`; this
module then does not add a second listener. As a belt-and-braces measure,
`checkout()` also collapses repeat calls for the same SKU inside 1.2 seconds, so
one click can never open two checkouts or send two `checkout_open` events.

SKUs: `monthly` and `yearly` — the one plan, billed either way. `lifetime`,
`practitioner`, `studio` and `pack` are retired with the tiers and must not come
back.

### The three modes

`CHECKOUT.mode` in `js/config.js`:

| Mode | What a click does |
|---|---|
| `waitlist` | Renders the email capture card — "Checkout opens soon". **This is the default, so a button is never dead.** No price promise and no founding offer: there is one price, and it is $10 a month or $100 a year. |
| `link` | Opens `CHECKOUT.urls[sku]` (a hosted payment link) in a new tab. |
| `paddle` | Opens Paddle Billing's overlay checkout using `CHECKOUT.priceIds[sku]`. |

`resolvedMode(sku)` degrades safely: `link` mode with an empty URL, or `paddle`
mode with no client token or no price id, falls back to `waitlist` for that SKU
rather than breaking.

### Configuring it (the owner's job, once)

**Hosted links (simplest).** Create the two products — the monthly plan and the
yearly plan, each with the 3-day card-required trial — at the merchant of record,
paste each hosted payment link into `CHECKOUT.urls`, set both products' success
URL to `https://helpmebreath.com/pro/thanks`, and set `mode: 'link'`.

**Paddle Billing overlay.** Verified against developer.paddle.com on 2026-09-09:

- Script: `https://cdn.paddle.com/paddle/v2/paddle.js`, loaded lazily on the
  first checkout click, never on page load.
- `Paddle.Environment.set("sandbox")` (only when `CHECKOUT.sandbox` is true),
  then `Paddle.Initialize({ token: "<client-side token>" })`. A client-side token
  is public by design and belongs in `js/config.js`; an **API key is not** and
  belongs in a Vercel env var.
- `Paddle.Checkout.open({ items: [{ priceId, quantity: 1 }], settings: { … } })`.
  In the settings object, `displayMode` is `"inline"` or `"overlay"`, and
  `successUrl` is documented as the "URL to redirect to on checkout completion.
  Must start with `http://` or `https://`." We pass
  `https://helpmebreath.com/pro/thanks?sku=<sku>`.
- Add `helpmebreath.com` to Paddle's approved domains, or the overlay refuses to
  open.

**How the transaction reaches the success page.** Paddle's checkout payment
links are "made up of your default payment link with a `_ptxn` query parameter
appended", and "You don't need to do anything to get Paddle.js to open a
checkout, it automatically opens a checkout for the transaction when the query
parameter is present."

Two consequences we build for:

1. `/pro/thanks` **does not** load paddle.js. If it did, a visitor arriving with
   `?_ptxn=…` would have a checkout re-open on top of their thank-you page.
2. Paddle's documentation does **not** promise that `_ptxn` is appended to
   `successUrl`. So `/pro/thanks` reads, in order: `?key=` / `?k=` / `?license=`
   (our own format), then `?_ptxn=` / `?ptxn=` / `?transaction_id=` /
   `?transactionId=` / `?orderId=` (provider references), and always offers
   manual key entry as the path that cannot fail. `/api/license` is expected to
   accept either a licence key or a provider transaction reference in `{ key }`.

### Swapping provider

1. Create the products at the new provider.
2. Edit `js/config.js`: `mode`, `clientToken`, `urls`, `priceIds`.
3. Point `MOR_PROVIDER` and the product env vars at the new provider in Vercel,
   and update `api/_lib/providers/` (API agent's territory).
4. Redeploy.

No feature file, no page and no gate changes. Existing tokens keep working until
they expire, and the offline grace path covers the gap while subscriptions are
moved across.

---

## 3. The modules

| File | What it does |
|---|---|
| `js/pro/index.js` | Entry point. Injects `css/pro.css` once, wires the paywall and capture, initialises the per-instance tools on every `hmb:ready`, imports `js/checkout.js`, and dynamically imports `./soundscapes.js` inside try/catch so a missing audio module can never break a page. |
| `js/pro/patterns.js` | "Custom pattern": four sliders (0–30s, at least one of inhale/exhale non-zero), a live plain-words preview, **Run** (free), **Save preset** and **Copy share link** (Pro). Presets live at `hmb.presets` as `[{id,name,inhale,hold1,exhale,hold2}]`, with rename and delete. On `/timer` it reads `?p=4-7-8-0&name=…` and applies it, for anyone. |
| `js/pro/streaks.js` | "Your practice": current and longest streak, total minutes, sessions this week, a 12-week heatmap with an aria-label per day, a per-technique breakdown, and CSV export via a Blob. Free sees the last seven days plus a blurred heatmap and a Pro badge. |
| `js/pro/paywall.js` | The offer card on the third completed session (once ever, flag `hmb.paywall.shown`, dismissible forever), and the inline feature card driven by `hmb:paywall`. Never mid-session — a feature card raised during a session waits until it ends. Never on `data-no-asks` pages, and never to a visitor who is already `isPro()`. |
| `js/pro/capture.js` | The post-session printable offer: email + consent → `POST /api/subscribe { email, technique, source, consent: true }`. Once ever (`hmb.capture.shown`), never on `data-no-asks` pages, and never on the same completion as the offer card — the offer wins and the capture waits for the next one. Exports `renderCaptureCard(container, options)` so checkout's waitlist reuses it — `title`, `message`, `submitLabel`, `consentLabel`, `note` and `successMessage` are overridable, because a consent line has to describe the email actually being agreed to, and `markShown` (default: only for `source: 'post-session'`) decides whether that card spends the once-ever budget. |
| `js/pro/night.js` | Night-mode toggle (Pro): `body.night` from `css/pro.css`, plus `navigator.wakeLock` while a session runs. Persisted at `hmb.night` — module preferences live as flags because `storage.saveSettings()` deliberately keeps only the four engine settings. |
| `css/pro.css` | Panels, sliders, heatmap, night mode, the offer and capture cards (extending `.post-session-card`), and the `/pro` page furniture. |

### Storage keys this layer owns

`hmb.license`, `hmb.license.key`, `hmb.presets`, `hmb.night`,
`hmb.paywall.shown`, `hmb.capture.shown`. The flags go through `js/storage.js`,
so they are try/catch safe and fall back to an in-memory mirror when storage is
blocked; the two licence keys are read and written inside
`js/entitlements.js`, equally guarded, because nothing else may touch them.

---

## 4. Events

All names come from `EVENTS` in `js/analytics.js`. Nothing here ever sends an
email address, a licence key or any free-text input.

| Event | Fired by | Params |
|---|---|---|
| `paywall_view` | `paywall.js` | `{ feature }` — `third-session` for the offer card, otherwise the feature name |
| `paywall_click` | `checkout.js`, `paywall.js` | `{ feature, sku }` or `{ feature, target: 'pro-page' }` |
| `checkout_open` | `checkout.js` | `{ sku, mode, price, placement }` |
| `capture_shown` | `capture.js` | `{ technique, source }` |
| `capture_submit` | `capture.js` | `{ technique, source }` |
| `activate_attempt` | `/pro`, `/pro/thanks` | `{ source }` |
| `activate_success` | `/pro`, `/pro/thanks` | `{ tier, source }` |
| `activate_fail` | `/pro`, `/pro/thanks` | `{ source, reason }` |
| `restore_success` | `/pro`, `/pro/thanks` | `{ tier }` |

`third_session_reached` is fired by the engine, not by this layer.

---

## 5. Rules this layer will not break

- Every existing technique stays free and unlimited. Pro adds tools around the
  practice; it never removes any of it.
- No offer appears before the third completed session, and no offer appears
  twice.
- No offer of any kind is shown to someone who has already paid. `paywall.js`
  checks `isPro()` on both paths; the `hmb.paywall.shown` flag is deliberately
  left unset in that case, so the offer is still available if a licence ever
  lapses back to free.
- No ask of any kind renders while `body.session-active` — `css/styles.css`
  hides `[data-ask]` during a session, and these modules do not try to work
  around that.
- No offer, no capture and no locked control on a page with
  `<body data-no-asks="true">`.
- A licence key is never logged, tracked or put in a URL, and is transmitted
  only in the request body of `/api/license` (activation) and
  `/api/entitlement` (the silent refresh, which needs the key because the
  token carries only a one-way hash of it).
- 14-day unconditional refund, stated on `/pro` and reachable from checkout.
  `legal/terms-of-service.html` now carries it as section 10, "The 14-day refund
  policy", so `/pro` can say so outright and link straight to it. Section 5 of
  the same page carries the automatic-renewal block and the trial-to-paid block;
  `/pro` must show the same two disclosures, in the same words, before checkout.
