# Help Me Breathe — the API

Accounts and one subscription plan. Everything runs on Vercel's Node runtime
using Web-standard handlers, with **zero npm runtime dependencies**: `fetch` and
WebCrypto only, so the same files port to Cloudflare Pages Functions with a
two-line adapter.

Identity is Supabase (email link, 6-digit code, or Google — no passwords). State
is Postgres, reached over PostgREST with the secret key. The schema is
documented in **[`docs/DB.md`](DB.md)** and created by the migrations in
`supabase/` — this file does not repeat either.

The old licence-key model is gone: there is no `/api/license`, no key, no
activation count, no SKU, no `MOR_PRODUCT_*` variable and no waitlist mode.

| Route | Method | Auth | What it does |
|---|---|---|---|
| `/api/me` | `GET` | Bearer JWT | The one endpoint the signed-in front end calls: user, entitlement, trial hint, free-session count, signed token, cookies. |
| `/api/session/count` | `GET`, `POST` | none (POST same-origin) | The free-session counter for a device. |
| `/api/trial/eligibility` | `POST` | Bearer JWT (live) | Decides trial-or-not, reserves it, and creates the checkout transaction. |
| `/api/billing/portal` | `POST` | Bearer JWT (live) | Mints customer-portal links. |
| `/api/billing/cancel` | `POST` | Bearer JWT (live) | Cancels at period end, or immediately. |
| `/api/billing/pause` | `POST` | Bearer JWT (live) | Pauses an active subscription for 1 or 3 months. |
| `/api/billing/switch` | `POST` | Bearer JWT (live) | Switches monthly → yearly, prorated. |
| `/api/account/signout` | `POST` | none | Clears the entitlement cookie. |
| `/api/account/export` | `GET` | Bearer JWT (live) | Data portability: a JSON attachment of everything we hold. |
| `/api/account/delete` | `POST` | Bearer JWT (live) | Cancels at the provider first, then deletes the account. |
| `/api/webhooks/mor` | `POST` | webhook signature | Every merchant-of-record event. |
| `/api/cron/reconcile` | `GET` | `CRON_SECRET` | Hourly: re-drive failed events, rewrite flagged subscriptions. |
| `/api/cron/retention` | `GET` | `CRON_SECRET` | Weekly: the eight retention statements. |
| `/api/subscribe` | `POST` | none (same-origin) | Double opt-in email signup. Unchanged. |
| `/api/health` | `GET` | none | Which environment variables are set. Booleans and names only. |

## Files

```
api/
  me.js                       GET  /api/me
  subscribe.js                POST /api/subscribe
  health.js                   GET  /api/health
  account/
    signout.js  export.js  delete.js
  billing/
    portal.js  cancel.js  pause.js  switch.js
  trial/
    eligibility.js
  session/
    count.js
  webhooks/
    mor.js                    one endpoint for every merchant of record
  cron/
    reconcile.js  retention.js
  _lib/
    authz.js                  requireUser / requireLiveUser / bearerToken
    crypto.js                 base64url, SHA-256, HMAC-SHA256, signToken / verifyToken
    supabase.js               verifyAccessToken, db() (PostgREST), assertLiveUser
    entitlement.js            accessUntilFor, entitlementFor, the v3 token, the cookies
    trialguard.js             the device cookie, the trial ledger, runEligibility
    env.js                    KNOWN_VARS, requireEnv, isProduction, describeConfig
    respond.js                json(), CORS, body reading, error mapping
    ratelimit.js              in-memory per-IP counters
    dblimit.js                per-user counters in Postgres
    providers/
      index.js                the merchant-of-record seam: adapter contract, plans, prices
      paddle.js               primary adapter
      fastspring.js           fallback adapter
    email/
      index.js  brevo.js  mailerlite.js
tools/
  keygen.mjs                  prints a 64-character secret, writes nothing
  api.test.mjs  webhook.test.mjs  trialguard.test.mjs
  supabase.test.mjs  entitlement.test.mjs
  site-check.mjs              the whole-site linter
```

Vercel deploys every file under `api/` as a function **except** the ones it
ignores. From the Vercel docs on adding utility files to `/api`: *"To avoid
turning these files into functions, Vercel ignores files with the following
characters: Files that start with an underscore, `_`."* That is why every shared
module lives under `api/_lib/`.

`package.json` already has `"type": "module"`, which the Node runtime requires
for `.js` files that use ESM.

## Handler shape

```js
export const config = { runtime: 'nodejs', maxDuration: 15 };

export async function POST(request) {
  return json(200, { ok: true }, { request, methods: 'POST, OPTIONS' });
}
export async function OPTIONS(request) { … }
```

`runtime` is optional — Vercel defaults to `nodejs` — but it is written out so a
reader does not have to know the default. `maxDuration` is set per endpoint
because each makes one or two outbound calls and should give up rather than hang.

---

## Authentication

Four kinds, and nothing else.

| Kind | How | Used by |
|---|---|---|
| **Bearer JWT** | `Authorization: Bearer <Supabase access token>`, verified locally against the JWKS (`verifyAccessToken`). | `GET /api/me` — the hot path, called on every page load of a signed-in visitor. |
| **Bearer JWT (live)** | The same, plus a round trip to Supabase's `/auth/v1/user` (`assertLiveUser` / `requireLiveUser`), so a session signed out or revoked inside its hour is refused. | Every money-touching call: trial eligibility, portal, cancel, pause, switch, export, delete. |
| **Same-origin** | The `Origin` header must match the site, or an entry in `ALLOWED_ORIGINS` (`resolveSameOrigin`). | `POST /api/session/count`, `POST /api/subscribe`, and every billing and trial POST **in addition to** the JWT. |
| **`CRON_SECRET`** | `Authorization: Bearer <CRON_SECRET>`, compared with `timingSafeEqual`. Vercel sends it on every cron invocation. | The two cron endpoints. |
| **Webhook signature** | Verified by the adapter over the **raw request body** (`verifyWebhook(rawBody, headers, MOR_WEBHOOK_SECRET)`). | `POST /api/webhooks/mor`. |

The user id always comes from the verified token's `sub`. **No handler ever
takes a user id, an email or a price from a request body.**
`stripClientAssertedIdentity()` removes and logs any identity- or price-shaped
key that turns up in one.

Every JWT failure answers the same way — `401 { ok: false, reason:
'unauthenticated' }` — so the client has one code path. When Supabase itself did
not answer, the status is `503` with `reason: 'auth_unavailable'` and a
`Retry-After`, because that is our fault and not the caller's.

CORS is same-origin on every endpoint. Every API response is `no-store`.

### Cookies

| Cookie | Set by | Attributes | What it is |
|---|---|---|---|
| `__Host-hmb_ent` | `GET /api/me` | `Path=/; Secure; SameSite=Lax; Max-Age=1209600` | The signed v3 entitlement token, 14 days. Readable by script on purpose: it is the repair path when Safari sweeps `localStorage`. Cleared by `POST /api/account/signout`. |
| `__Host-hmb_did` | `GET /api/me`, `POST /api/session/count`, `POST /api/trial/eligibility` | `Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=63072000` | `<uuid>.<mac>` — the device anchor for the free-session count and the trial lock, 2 years. Never cleared by sign-out: it is a device, not a session. |

The `__Host-hmb_did` value is mirrored back in the response body so the browser
can re-supply it as `X-HMB-Device-Mirror` (on `GET /api/me`) or as
`device_mirror` in a JSON body (on the two POSTs) after storage is swept. A MAC
that does not verify is discarded. **No fingerprinting, anywhere.**

---

## `GET /api/me`

The one endpoint the signed-in front end calls.

**Request** — `Authorization: Bearer <access token>`, optionally
`X-HMB-Device-Mirror: <uuid>.<mac>`. The mirror is read from the header only: a
GET has no body, and an identifier must never travel in a query string where it
would land in request logs and `Referer` headers. A `?device_mirror=` parameter
is deliberately ignored.

**Response — 200**

```json
{
  "ok": true,
  "user": { "id": "…uuid…", "email": "person@example.com", "created_at": "2026-09-01T…" },
  "entitlement": {
    "tier": "pro", "status": "active", "plan": "yearly",
    "trial_ends_at": null, "current_period_end": "2027-09-11T…",
    "cancel_at": null, "access_until": "2027-09-13T…",
    "next_charge": { "amount": "100.00", "currency": "USD", "tax_inclusive": true, "at": "2027-09-11T…" },
    "provider": "…", "ui": "active"
  },
  "trial": { "available": false, "reason": "already_subscribed" },
  "free_sessions_used": 3,
  "token": "eyJ2IjozL…",
  "token_exp": 1789000000,
  "device_id": "…uuid….…mac…"
}
```

Both cookies are set on every call. A signed-in user with no subscription gets a
**200** with `tier: "free"` and a free token, so the client has one code path.

| Status | Body | When |
|---|---|---|
| 200 | as above | Normal. |
| 200 | `+ "stale": true` | The entitlement read failed **and** the caller's own `__Host-hmb_ent` verified for the same user. It is handed straight back. A paying subscriber is never locked out by our outage. |
| 401 | `{ ok: false, reason: "unauthenticated" }` | Missing or invalid JWT. |
| 429 | `{ ok: false, reason: "rate_limited" }` | More than 120 calls a minute from one IP. |
| 503 | `{ ok: false, reason: "entitlement_unavailable" }` | The read failed and there was no usable cached token. The client keeps its `localStorage` copy. |

Rules this handler keeps: the entitlement is read from Postgres only — the
provider is never called; `next_charge` comes from `subscriptions.display_*`,
never a constant; `assertLiveUser` is **not** used here, because it runs on every
page load and the JWT's own hour is the boundary. The device half never blocks
the entitlement half: if the device layer is unavailable the entitlement still
answers and only the cookie and counter are omitted.

The `trial` object here is a cheap hint for the account page. `POST
/api/trial/eligibility` is the authority.

---

## `GET` / `POST /api/session/count`

The free-session counter. No account needed.

```
GET  /api/session/count                      read the count for this device
POST /api/session/count { device_mirror? }   count one completed session
```

Both answer `{ ok: true, device_id, free_sessions_used }` and set
`__Host-hmb_did`, minting a MAC'd id when the browser has none. That is how a
signed-out visitor who has never called `/api/me` gets a device anchor at all.

The counter is **soft**: it never denies anything by itself,
`js/entitlements.js#requireTimer()` reads it, and clearing cookies resets it.
What it must not allow is a third-party page planting a device id on a
stranger's browser, so:

- **POST is same-origin only**, and the mirror is read from a JSON body, which a
  cross-site form post cannot send;
- **GET reads only the cookie** — never a query parameter, never a mirror;
- **GET never writes.** No row is inserted and nothing is bumped, so a crawler
  without a cookie cannot fill the `devices` table. The row is created by the
  first POST.

On a ledger outage the answer is 200 `{ ok: false, free_sessions_used: null }`
with a MAC'd cookie, and the client falls back to its local count. More than 30
beacons a minute from one IP gets a 429; a cross-origin POST gets
`403 { ok: false, error: "cross_origin" }`.

---

## `POST /api/trial/eligibility`

Decides, reserves, and creates the transaction. This is the **only** place the
`TRIAL_ENABLED` flag is read, and the only place a checkout transaction is
created.

**Request** — `Authorization: Bearer <access token>` (live), same-origin.

```json
{ "plan": "monthly", "device_mirror": "<uuid>.<mac>" }
```

That is the whole body. No signals, no consent flag, no device id and **no
client-supplied price**. `device_mirror` is honoured only when its MAC verifies;
anything else is discarded and counted as one soft signal.

**Response — 200**

```json
{
  "ok": true,
  "device_id": "…", "reservation_id": "…uuid…",
  "trial": true, "plan": "monthly",
  "checkout": { "provider": "…", "transaction_id": "txn_…" },
  "price_preview": { "amount": "10.00", "currency": "USD", "tax_inclusive": true, "formatted": "$10.00" },
  "reasons": []
}
```

There is no `price_id` in the response, by design: the browser opens the overlay
with `transactionId` and the price was fixed on the server.

| Status | Body | When |
|---|---|---|
| 200 | `trial: false, reasons: ["ledger_unavailable"]` | A trial-ledger or rate-limiter outage. **Not** an error: the buyer can still subscribe at the full price. |
| 400 | `{ ok: false, error: "bad_plan", plans: [...] }` or `"bad_request"` | |
| 401 | `{ ok: false, reason: "unauthenticated" }` | JWT missing, invalid, or the session was revoked. |
| 403 | `{ ok: false, error: "cross_origin" }` | Not called from the site itself. |
| 502 | `{ ok: false, error: "checkout_unavailable" }` | The provider could not create a transaction. |
| 503 | `{ ok: false, reason: "auth_unavailable" }` / configuration missing | Never a value, only a variable name. |

Every 2xx sets `__Host-hmb_did`. The plan enum is `monthly` and `yearly` —
two billing periods for the one plan. Anything else is `400 bad_plan`.

> **2026-09-12.** The enum used to carry a third value, for a separate
> professional plan, so that offering one would be a config change rather than a
> migration. The owner closed that option permanently: one plan, everything
> included, for individuals. The value and its price variable are gone from the
> server, as is the whole layer that was built on top of them.

---

## The billing endpoints

All four are `POST`, all four need a **live** bearer JWT and a same-origin
`Origin`, and all four name their `effective_from` explicitly in every branch
rather than letting the provider's default decide. None of them names a payment
company: `MOR_PROVIDER` picks the adapter.

Shared errors: `401` unauthenticated, `403 cross_origin`, `400 bad_request`,
`404 no_subscription`, `429 rate_limited` (per user, counted in Postgres),
`502 provider_unavailable`.

### `POST /api/billing/portal`

No body. Answers
`{ ok, overview, cancel, update_payment_method, expires_in }`. Links are minted
per request and never stored — portal sessions are temporary and must not be
cached. `/account` fetches them on click, not on load. Limit: 30 an hour per
user.

### `POST /api/billing/cancel`

```json
{ "when": "period_end" }   // default: keeps what was paid for, or the rest of the trial
{ "when": "now" }          // the secondary "end it now" link, never the default
```

Answers `{ ok, effective_from, status, cancel_at, access_until, message }`.

| Status | `when` | `effective_from` |
|---|---|---|
| `trialing` | `period_end` | `next_billing_period` |
| `active`, `past_due` | `period_end` | `next_billing_period` |
| `paused` | `period_end` | `immediately` |
| any | `now` | `immediately` |

Paused is the one status where "end of period" means immediately: nothing is
charged while paused and the paid period has already run out, so there is
nothing left to keep — and the provider documents immediate cancellation as its
own behaviour for paused subscriptions. Never worse than the provider's own
portal: both default to the end of the period. Limit: 10 an hour per user.

### `POST /api/billing/pause`

```json
{ "months": 1 }   // or 3
```

Answers `{ ok, effective_from: "next_billing_period", resume_at, access_until,
message }`. Only an `active` subscription can pause: a trial has nothing to
pause, a past-due one has a card to fix first, and a paused one already is.
Extra errors: `409 { error: "not_active" | "cancel_scheduled" }`.
`access_until` stays as stored until the provider's pause webhook writes the new
value.

### `POST /api/billing/switch`

```json
{ "plan": "yearly" }
```

Answers `{ ok, plan: "yearly", next_billed_at, message }`. Monthly → yearly
only, and only from an `active` monthly subscription with no cancellation
scheduled. The switch is prorated. The price id comes from the adapter's
`priceIdFor({ plan: 'yearly', trial: false })`, i.e. from `MOR_PRICE_YEARLY` —
never from the request. Extra errors:
`409 { error: "not_eligible", reason }`, `503` when the price is not configured.

---

## The account endpoints

### `POST /api/account/signout`

Clears `__Host-hmb_ent` and answers `200 { ok: true }`. That is its only job. No
bearer token is needed: the cookie belongs to the caller's own browser and
clearing it grants nothing to anyone. `__Host-hmb_did` is deliberately **not**
cleared. `js/auth.js` calls this after clearing the Supabase session and the
`hmb.ent` / `hmb.ent.snapshot` keys.

### `GET /api/account/export`

Live bearer JWT. Returns `Content-Disposition: attachment` JSON containing the
`profiles` row, every `subscriptions` row (provider ids included), and a note
that the merchant of record holds its own copy as a separate controller. Those
two tables are everything an account owns. Field allowlists keep hashes and
secrets out of it, and every query is keyed on the verified `sub`. Limit: 10 a
minute per IP.

### `POST /api/account/delete`

Live bearer JWT. Deletion that does not fight the subscription, in this order
and no other:

1. **Refuse** while a payment dispute is open or a `past_due` balance stands.
2. **Cancel every live subscription at the merchant of record first, and verify
   the cancellation came back**, before touching Supabase. A cancel that does not
   verify aborts the whole request with nothing changed.
3. **Detach, do not cascade,** the subscription rows: `user_id = null`,
   `detached_at = now()`, provider ids kept — so a later webhook for a still-live
   subscription reconciles instead of becoming an orphan.
4. Delete the `auth.users` row, cascading `profiles` and `checkout_intents`.
5. Null `trial_claims.user_id` and `devices.trial_user_id`, keeping the hashes
   until the 24-month ceiling — otherwise deleting an account would reset the
   free-trial limit.

Cancellation uses `effective_from: 'next_billing_period'`. A row whose
`cancel_at` is already set is not cancelled a second time.

| Status | Body |
|---|---|
| 200 | `{ ok: true, deleted: true, subscriptions_cancelled, note }` |
| 409 | `{ ok: false, reason: "dispute_open" \| "past_due", message }` |
| 502 | `{ ok: false, reason: "cancel_failed", message }` — **nothing was changed** |

Limit: 5 a minute per IP.

---

## `POST /api/webhooks/mor`

One endpoint for every merchant of record. `MOR_PROVIDER` picks the adapter;
nothing in this file names a provider. The body is read **once, as text**, and
that exact string is what the adapter hashes — never `readJsonBody()`, never
`JSON.parse`-then-`stringify`.

| Status | When |
|---|---|
| `200 ok` | Every event in the delivery was processed or ignored. |
| `400 bad request` | Unreadable body, or the adapter parsed no event. |
| `401 invalid signature` | `verifyWebhook` said no. |
| `500 retry` / `503 retry` | At least one event failed, or the store was unreachable. The provider retries. |
| `503 not configured` | A required variable is unset. |

### The state machine

`webhook_events.status` moves `received → processed | ignored | failed`.

- **Claim.** The `(provider, event_id)` row is claimed before the event is
  applied. A `failed` or `received` row is **re-claimable**; a `processed` or
  `ignored` row is a permanent no-op. So a manual re-POST of a failed event is
  re-processed, not skipped.
- **Failure keeps evidence.** An event whose processing throws is answered with
  a non-2xx so the provider retries, and its row is marked `failed` with the
  payload **kept**. The retention cron nulls payloads only on `processed` rows.
- **The environment gate.** An event whose `live` flag disagrees with
  `MOR_SANDBOX` is recorded as `ignored` and never touches a subscription. A
  missing flag is `live_flag_unknown` and is also ignored. Anything but the
  literal `true` in `MOR_SANDBOX` means live, which is the strict reading: a
  forgotten variable on a live deployment must not accept sandbox events.
- **Ordering is enforced by the write.** `last_event_at < occurred_at` is a
  filter on the `UPDATE`; zero rows affected sets `needs_reconcile = true` for
  the hourly cron. Terminal cancellation is a separate statement guarded on
  `status <> 'canceled'`, so a stale update can never resurrect a subscription.
- **`custom_data` is a hint, never a fact.** The only field read from it is
  `rid`, an opaque uuid; every fact comes from the `checkout_intents` row it
  names. A `custom_data.user_id`, if one ever appears, is ignored and logged.
- **`access_until` has one writer.** This handler, through
  `api/_lib/entitlement.js#accessUntilFor()`, so the formula lives once.

Normalised event types: `sub.created`, `sub.trialing`, `sub.activated`,
`sub.updated`, `sub.past_due`, `sub.paused`, `sub.resumed`, `sub.canceled`,
`txn.completed`, `txn.failed`, `txn.refunded`, `txn.chargeback`, `ignore`.
Subscription statuses: `trialing`, `active`, `past_due`, `paused`, `canceled`,
plus our local `expired`.

The full specification — the handler, the signature, `applyEvent`, the
`access_until` table and the trial lifecycle — is in the private design
document; `docs/DB.md` documents the tables.

---

## The two cron jobs

Both are `GET`, both refuse a request without `Authorization: Bearer
<CRON_SECRET>`, and both are declared in `vercel.json`.

### `/api/cron/reconcile` — hourly, `17 * * * *`

"Reconciliation, not hope." Three passes, each capped and each logged:

1. **Re-drive** `webhook_events` rows with `status = 'failed'` and
   `attempts < 10`, oldest first, capped at 50: re-parse the kept payload
   through the adapter, re-claim (`attempts += 1`), apply. The live-flag gate
   applies here too. This runs first so that a re-driven event which turns out
   to be older than the row is repaired by the next pass in the same run.
2. **Rewrite** every `subscriptions` row with `needs_reconcile = true`, or whose
   `access_until` is in the past while `status in ('trialing','active')` — a
   renewal webhook that never arrived. `provider.getSubscription()` is
   authoritative; the flag is then cleared. Capped at 50.
3. **Alert** on anything still failed after 10 attempts, and on any subscription
   with `user_id is null and detached_at is null` — a true orphan. Vercel
   surfaces these in the function logs.

Answers `{ ok, ran_at, results }` with `200`, or `500` when a step failed.

### `/api/cron/retention` — weekly, `0 4 * * 1`

Eight idempotent statements, in order: null webhook payloads older than 30 days
**on `processed` rows only**; delete processed events older than 180 days; expire
stale trial reservations; delete checkout intents 7 days past expiry; mark
subscriptions `expired` 7 days past `access_until`; delete trial claims and
devices older than 24 months; prune the rate-limit table. A step that fails is
logged and the remaining steps still run; the response is `500` when any failed,
so the invocation shows red in the Vercel log.

Answers `{ ok, ran_at, results }`.

---

## `POST /api/subscribe`

Unchanged by the accounts work. Double opt-in email signup, proxied so the
mailing key never reaches a browser.

**Request**

```json
{ "email": "person@example.com", "technique": "478", "source": "post-session", "consent": true }
```

`consent` must be literally `true`. `technique` and `source` are optional short
slugs used as tags. The address is lower-cased and validated server-side: shape,
length (254 total, 64 in the local part), no doubled dots, no leading or
trailing dot.

**Response — 200** `{ "ok": true, "message": "Check your inbox to confirm" }`

The answer is identical whether the address is new or already on the list.
Telling a stranger which addresses are subscribed would be a leak, and the
person at the form needs the same instruction either way.

**Failure** `{ "ok": false, "error": "…", "field": "email" }` — 400 for
validation, 429 for more than 5 a minute from one IP (and 3 an hour to the same
address, keyed on a hash), 502 when the mailing service is unreachable, 503 when
it is not configured.

Both adapters create the contact **unconfirmed** and let the provider send the
confirmation email. Brevo uses `POST /v3/contacts/doubleOptinConfirmation`.
MailerLite uses `POST /api/subscribers` with `status: "unconfirmed"` — turn
double opt-in on for the group in the dashboard, because that switch, not this
code, sends the email.

Only a 12-character hash prefix of the address is ever logged.

---

## `GET /api/health`

```json
{
  "ok": false,
  "provider": "paddle",
  "email": "brevo",
  "env": "production",
  "time": "2026-09-12T10:00:00.000Z",
  "configured": { "license_secret": true, "supabase_url": true, "mor_api_key": false, "…": false },
  "missing": ["MOR_API_KEY"]
}
```

`configured` has one lowercased key for **every** name in `KNOWN_VARS`, set or
not. `missing` lists only what a *working* deployment needs: sign-in, the
entitlement token, the trial ledger, checkout, webhooks and the two cron jobs —
see the **Required** column below.

Booleans and variable names only. No value from the environment appears here —
not truncated, not hashed, not hinted at. The names are already public in
`.env.example`, so listing which ones are unset costs nothing and saves the
owner from guessing after a deploy. The `kid` is deliberately omitted even
though it is technically public.

`ok` is `false` when something in `missing` is unset. The endpoint still answers
**200**: it is a report, not a probe that should take the site down.

---

## Environment variables

The full list, matching `KNOWN_VARS` in `api/_lib/env.js` and `.env.example`
one-to-one. **Required** means "counted in `/api/health`'s `missing`".

| Variable | Required | Notes |
|---|---|---|
| `LICENSE_SECRET` | yes | 64 characters from `node tools/keygen.mjs`. Signs every entitlement token. Rotating it signs every subscriber out of offline use until their next page load. |
| `SUPABASE_URL` | yes | `https://<ref>.supabase.co`. The same value goes into `js/config.js` (public). |
| `SUPABASE_PUBLISHABLE_KEY` | yes | The publishable (anon) key. Public by design; the server copy is used only to call the auth API. |
| `SUPABASE_SECRET_KEY` | yes | The secret (service role) key. Server only. Bypasses row level security. Never in the repo, never in a response. |
| `TRIAL_PEPPER` | yes | 64 characters. HMAC key for the one-way email hash in the trial ledger. Rotating it resets every email trial lock. |
| `DEVICE_PEPPER` | yes | 64 characters. HMAC key for the device cookie. Rotating it resets every free-session count and device trial signal. |
| `TRIAL_ENABLED` | no | `true` offers the 3-day card-required trial; `false` sells a straight subscription. Read only by `api/trial/eligibility.js`. Anything but the literal `true` is off. |
| `SITE_ORIGIN` | yes | The site's own origin, used to build callback URLs and for the same-origin check. |
| `MOR_PROVIDER` | no | `paddle` (default) or `fastspring`. One variable switches the whole payment rail. |
| `MOR_API_KEY` | yes | Paddle: an API key beginning `pdl_live_apikey_` (or `pdl_sdbx_apikey_`). FastSpring: `username:password`. |
| `MOR_API_BASE` | no | Overrides the provider's API base URL. Leave empty in production. |
| `MOR_WEBHOOK_SECRET` | yes | The signing secret of the webhook notification destination. One per environment: delete the sandbox destination at go-live. |
| `MOR_CLIENT_TOKEN` | yes | The client-side checkout token (`test_…` or `live_…`). Public by design; the same value goes into `js/config.js`. |
| `MOR_SANDBOX` | no | Literally `true` on every sandbox deployment, `false` at go-live. Also gates the webhook live-flag check. |
| `MOR_PRICE_MONTHLY_TRIAL` | unless `TRIAL_ENABLED=false` | The monthly price carrying the 3-day trial period. |
| `MOR_PRICE_MONTHLY` | yes | The monthly price, no trial. |
| `MOR_PRICE_YEARLY_TRIAL` | unless `TRIAL_ENABLED=false` | The yearly price carrying the trial. |
| `MOR_PRICE_YEARLY` | yes | The yearly price, no trial. |
| `MOR_STOREFRONT` | FastSpring only | The popup storefront URL. |
| `MOR_API_USERNAME` | no | FastSpring only, and only if you prefer two variables to the `username:password` form of `MOR_API_KEY`. |
| `MOR_API_PASSWORD` | no | The other half of the pair above. |
| `CRON_SECRET` | yes | 64 characters. The bearer token Vercel's two cron jobs must present. |
| `ALERT_EMAIL` | yes | Where orphaned webhooks, forged trials and stuck events are reported. |
| `EMAIL_PROVIDER` | no | `brevo` (default) or `mailerlite`. |
| `EMAIL_API_KEY` | yes | The mailing service key. `/api/subscribe` is the only thing that ever sees it. |
| `EMAIL_LIST_ID` | Brevo only | Brevo list id (comma separated for several) or MailerLite group id. |
| `EMAIL_DOI_TEMPLATE_ID` | Brevo only | Numeric id of the double opt-in template. |
| `EMAIL_DOI_REDIRECT_URL` | Brevo only | Where a confirmed email subscriber lands: `https://helpmebreath.com/pro/thanks?confirmed=1` (the page then shows an email-confirmed message, not a purchase). |
| `EMAIL_API_BASE` | no | Test hook. Leave empty in production. |
| `ALLOWED_ORIGINS` | no | Extra origins allowed to call the same-origin endpoints, comma separated. Normally empty: the API and the site share an origin. |

Missing variables behave differently by environment. `VERCEL_ENV=production`
throws `MissingEnvError`, which becomes a 503 and a log line naming the variable
and never a value. Preview and development get `DEV_DEFAULTS` where one exists
and an obvious `dev-missing-<NAME>` placeholder otherwise, so a local request
fails at the provider with a 401 instead of silently pretending to work. **A
preview deployment is not production**, which is what lets you point a preview at
the sandbox.

Three public values are duplicated in `js/config.js` on purpose, because the
browser needs them: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and
`MOR_CLIENT_TOKEN`. Nothing else is.

---

## The provider adapter contract

Swapping the merchant of record is a one-file change: write a new adapter next
to `paddle.js` / `fastspring.js`, add it to `listProviders()`, and set
`MOR_PROVIDER`. Nothing outside `api/_lib/providers/` names a payment company —
and `tools/site-check.mjs` fails the build if anything does.

**Adapter contract v3.** `ADAPTER_METHODS` in `api/_lib/providers/index.js` is
the enforced list; `assertAdapter(adapter)` throws if one is missing.

```js
{
  id: 'paddle',
  // checkout
  priceIdFor({ plan, trial }, env),                 // -> string
  async ensureCustomer(email, ctx),                 // -> { id, existed }   (409-tolerant)
  async createCheckoutSession({ priceId, customerId, customData }, ctx),
                                                    // -> { transactionId, status?, checkoutUrl? }
  async pricePreview({ priceId, countryCode, customerIp }, ctx),
                                                    // -> { amount, currency, taxInclusive, formatted }
  // webhooks
  async verifyWebhook(rawBody, headers, secret),    // -> { ok, reason? }
  parseEvents(rawBody, ctx?),                       // -> NormalizedEvent[]
  // management
  async getSubscription(subscriptionId, ctx),       // -> NormalizedEvent-shaped state
  async cancelSubscription(subscriptionId, { effectiveFrom }, ctx),
  async pauseSubscription(subscriptionId, { resumeAt, effectiveFrom }, ctx),
  async changePlan(subscriptionId, priceId, { prorate }, ctx),
  async createPortalSession(customerId, subscriptionIds, ctx),
}
```

`ctx` is `{ env, fetchImpl?, isProd?, sub? }` — always call through
`ctx.fetchImpl` when it is present, which is how the test suite runs offline.

**Every adapter produces exactly one event shape** (`normalizeEvent()` fills
every field, `null` when unknown, so consumers never guard against `undefined`):

```
id, type, providerEventType, occurredAt, live, reservationId,
providerSubscriptionId, providerCustomerId, providerPriceId, providerTransactionId,
customerEmail, status, plan, hadTrial,
trialStartsAt, trialEndsAt, currentPeriodStart, currentPeriodEnd, nextBilledAt,
canceledAt, pausedAt, scheduledChange: { action, effectiveAt, resumeAt } | null,
amount, currency, taxInclusive, totalIsZero, customDataUserIdSeen, payload
```

`payload` is the provider's own delivery for that event, exactly as parsed, so
`webhook_events.payload` can be fed back through `parseEvents()` to re-drive a
failed row.

The plan↔price mapping is **ours, not the provider's**, so it is shared:
`PRICE_ENV` maps each `(plan, trial)` pair to an env var, `priceIdFor()` reads
it, and `planForPriceId()` / `isTrialPriceId()` resolve a provider id back to a
plan. The browser never sees a price id and never chooses one.

Errors: every provider call that fails throws a `ProviderError` carrying
`status`, `code` and `reason` (`provider_unavailable`, `provider_error`,
`not_found`, `conflict`, `bad_request`, `unauthorized`, `rate_limited`), which
the endpoints turn into a calm 502 or 503. **Adapters never log a customer
email, a transaction id or a subscription id**, and a test enforces it.

The email seam works the same way: `api/_lib/email/index.js`, an adapter with
`id`, `requiredEnv` and `subscribe(contact, ctx)`, then `EMAIL_PROVIDER`.

---

## The entitlement token (v3)

```
base64url(JSON payload) + "." + base64url(HMAC-SHA256 over the first segment)
```

The signature covers the **encoded** first segment, not the raw JSON, so
verification never re-serialises — key order would change the bytes.

```json
{ "v": 3, "typ": "ent", "sub": "…uuid…", "tier": "pro", "st": "active",
  "plan": "yearly", "pe": 1789000000,
  "iat": 1788000000, "exp": 1789209600, "kid": "9f2a1c04" }
```

| Field | Meaning |
|---|---|
| `v` | Always `3`. |
| `typ` | Always `ent`. It is the only token type there is; a payload that says anything else is refused with `bad_type`. |
| `sub` | The Supabase user id. |
| `tier` | `pro` or `free`. |
| `st` | `trialing` \| `active` \| `past_due` \| `paused` \| `canceled` \| `none`. |
| `plan` | `monthly`, `yearly`, or `null`. |
| `pe` | Trial end or period end, seconds. `0` when unknown. |
| `iat`, `exp` | Seconds since epoch. |
| `kid` | First 8 hex characters of `sha256(LICENSE_SECRET)`, so a rotation is detectable as `kid_mismatch` rather than a generic signature failure. |

**Lifetime.** `exp = min(iat + 14 days, access_until + 24h)` for a pro token;
`iat + 14 days` for a free one, which grants nothing. Those 14 days **are** the
offline grace: there is no grace past `exp`, and the `access_until + 24h` cap
means a cancelled subscriber cannot stay offline into extra days.

**Entitlement, in one sentence:** a user's effective entitlement is the maximum
`access_until` across all their subscription rows, together with the status of
the row that produced that maximum. `access_until` is read exactly as stored and
never recomputed at read time.

`accessUntilFor(row)` is the only writer's formula:

| Status | `access_until` |
|---|---|
| `trialing` | `trial_ends_at` |
| `active` | `current_period_end + 48h` (covers renewal-webhook lag) |
| `past_due`, ever paid | `least(past_due_since, current_period_end) + 7 days` |
| `past_due`, never paid | `coalesce(trial_ends_at, now())` — no grace; a declined card must not turn 3 trial days into 10 |
| `paused` | `coalesce(current_period_end, now())` — a pause stops the next charge, it does not take away paid days |
| `canceled` | `coalesce(cancel_at, canceled_at)` |
| `expired` | unchanged |

### Rotating `LICENSE_SECRET`

Generate a new one with `node tools/keygen.mjs`, replace the variable, redeploy.
Every existing token fails with `kid_mismatch`. Subscribers get a fresh token on
their next `GET /api/me` — one page load, no action from them — but an
**offline** subscriber drops to free until they are online again. Only rotate if
you believe the secret leaked.
There is no dual-secret grace period; adding one would keep the old secret
around, which defeats the purpose.

---

## Security model, and what it does not do

**Authorization is by hand, on purpose.** Every `db()` call uses
`SUPABASE_SECRET_KEY` and bypasses row level security, which means every handler
is doing its own authorization: derive the user id from
`verifyAccessToken().sub`, never from a request body. RLS is still on in the
database as the second lock — see `docs/DB.md`.

**The JWT verifier trusts the header for two things only:** `kid` (which key to
look up) and `alg` (which must *agree* with the key found, or the token is
rejected). The algorithm is derived from the matched JWK, never from the header.
HS256 anywhere — header or JWK — is refused outright, because it would mean the
project still uses symmetric signing keys and a verifier holding the secret
could mint tokens. After the signature: `exp` (30 s skew), `nbf`, `iat`, `iss`,
`aud`, `role`, `session_id`, `sub` shape, `is_anonymous`, and
`exp - iat <= 7200` so a forged lifetime cannot outlive the hour Supabase
issues.

**Client-side enforcement is bypassable by design.** Every paid feature ships in
the same static JavaScript as the free ones, so a determined person can open
devtools and turn a flag on. The signature stops forgery, not inspection. What
actually protects the business is that the plan is $10 a month, and that the one
thing a bypass does not grant — an account that survives a cache clear, with its
history and its settings on every device — is server-side. **Do not build DRM on
top of this.**

**Rate limiting is two-tier.** Per-IP counters live in an in-memory `Map` inside
a warm function instance: Vercel may run several and recycle them at any moment,
so the real limit is "a few times the configured number". It stops a careless
script; it is not a security control. Per-user limits that matter — starting a
trial, cancelling, pausing — are counted in Postgres instead.

**The free-session counter is soft and says so.** It never denies anything by
itself, clearing cookies resets it, and that is accepted: the alternative is
fingerprinting, which rule 8 forbids.

**Secrets never leave the server.** `EMAIL_API_KEY`, `MOR_API_KEY` and
`SUPABASE_SECRET_KEY` are used only in outbound request headers. Nothing logs a
token, a key, an email address, a provider customer id or any environment value:
addresses are logged as a 12-character hash prefix and `/api/health` returns
booleans.

**Everything is `no-store`.** No API response should ever sit in a CDN or a
browser cache; `vercel.json` sets `Cache-Control: no-store` and
`X-Robots-Tag: noindex` on `/api/*`.

---

## Local development and testing

```bash
node --test tools/api.test.mjs        # the endpoints, the token, CORS, env
node --test tools/supabase.test.mjs   # the JWT verifier and the PostgREST helper
node --test tools/webhook.test.mjs    # the state machine and both adapters
node --test tools/trialguard.test.mjs # the device cookie, the ledger, eligibility
node --test tools/entitlement.test.mjs
node --check api/me.js                # and every other file under api/
node tools/keygen.mjs                 # prints a secret, writes nothing
node tools/site-check.mjs             # the whole-site linter
npm test                              # node --test "tools/*.test.mjs": every suite under tools/, these five included
```

No test touches the network and none needs an environment variable. Every
endpoint exports a `create…Handler(deps)` factory for exactly this reason, and
provider adapters take `fetchImpl` on their context. `MOR_API_BASE` and
`EMAIL_API_BASE` point the adapters at a stub host.

`tools/site-check.mjs` also enforces the rules that belong to this model, each
under its own rule id: `open-timer-allowlist` / `open-timer-missing`
(`data-open-timer` may appear only on the two crisis pages, and must appear on
both of them); `provider-outside-seam` (no payment company may be named in
`api/` or `js/` outside `api/_lib/providers/`, `api/_lib/env.js`, `js/config.js`
and `js/checkout.js`); `second-plan` (no trace of a practitioner plan or a plan
switch); `copy-truth` ("free forever", "always free", "no sign-up" and
unqualified "no account" are refused as copy); and `paywall-markup`
(`isAccessibleForFree: false` may not appear in structured data, because only
the interactive timer is gated and never the prose). See
`tools/README-site-check.md`.

To exercise the real thing, run `vercel dev` with a `.env` holding sandbox
credentials. A sandbox provider key is refused on a production deployment before
any network call is made, so there is no way to accidentally ship one.
