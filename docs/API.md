# Help Me Breathe — the API

Four serverless functions. No database, no accounts, no npm dependencies, no
bundler. Everything runs on Vercel's Node runtime using Web-standard handlers, so
the same files port to Cloudflare Pages Functions with a two-line adapter.

| Route | Method | What it does |
|---|---|---|
| `/api/license` | `POST` | Turns a licence key into a signed entitlement token. |
| `/api/entitlement` | `POST` | Refreshes a token, re-checking the merchant of record only when it is nearly stale. |
| `/api/subscribe` | `POST` | Double opt-in email signup, proxied so the mailing key never reaches a browser. |
| `/api/health` | `GET` | Which environment variables are set. Booleans and names only. |

## Files

```
api/
  license.js                  POST /api/license
  entitlement.js              POST /api/entitlement
  subscribe.js                POST /api/subscribe
  health.js                   GET  /api/health
  _lib/
    crypto.js                 base64url, SHA-256, HMAC-SHA256, signToken / verifyToken
    env.js                    requireEnv, isProduction, describeConfig
    respond.js                json(), CORS, body reading, error mapping
    ratelimit.js              in-memory per-IP counters
    providers/
      index.js                the merchant-of-record seam: SKUs, tiers, caps, domains
      paddle.js               Paddle Billing adapter (primary)
      fastspring.js           FastSpring adapter (fallback)
    email/
      index.js                the email seam
      brevo.js                Brevo double opt-in adapter (default)
      mailerlite.js           MailerLite adapter
tools/
  keygen.mjs                  prints a LICENSE_SECRET, writes nothing
  api.test.mjs                node --test suite, no network
```

Vercel deploys every file under `api/` as a function **except** the ones it
ignores. From the Vercel docs on adding utility files to `/api`: *"To avoid
turning these files into functions, Vercel ignores files with the following
characters: Files that start with an underscore, `_` … If your file uses any of
the above, it will not be turned into a function."* That is why every shared
module lives under `api/_lib/`.

`package.json` already has `"type": "module"`, which the Node runtime requires
for `.js` files that use ESM.

## Handler shape

```js
export const config = { runtime: 'nodejs', maxDuration: 15 };

export async function POST(request) {
  return json(200, { ok: true }, { request });
}
export async function OPTIONS(request) { … }
```

`runtime` is optional — Vercel defaults to `nodejs` — but it is written out so a
reader does not have to know the default. `maxDuration` is set because each of
these endpoints makes one or two outbound calls and should give up rather than
hang.

---

## `POST /api/license`

Exchanges a licence key for a token. This is the only endpoint that increments
the activation counter.

**Request**

```json
{ "key": "txn_01hqwertyuiopasdfghjklzxcv", "domains": ["clinic.example"] }
```

`domains` is optional and only means something for Practitioner and Studio,
which get white-label embeds. For Pro it is ignored rather than rejected.
Hostnames are normalised: scheme, port, path and case are stripped.

**Response — 200**

```json
{
  "ok": true,
  "token": "eyJ2IjoxLCJ0aWVy….q0Xk…",
  "tier": "practitioner",
  "activations": 3,
  "max": 25,
  "domains": ["clinic.example"],
  "exp": 1789000000
}
```

**Response — failure**

```json
{ "ok": false, "code": "activation_limit", "error": "This licence is already active on 25 devices…" }
```

`error` is a finished sentence meant to be shown to the buyer as-is. `code` is
for the client to branch on.

| Status | `code` | When |
|---|---|---|
| 400 | `missing_key`, `bad_key`, `bad_domains`, `bad_request` | The request never reaches the provider. |
| 409 | `activation_limit` | The provider's counter is already at the cap. |
| 409 | `domain_limit` | More domains than the tier allows. |
| 422 | `unrecognised_key`, `not_found`, `not_paid`, `canceled`, `refunded`, `test_mode`, `unknown_product`, `subscription_inactive`, `pack_only` | The key is real input but does not grant a licence. |
| 429 | `rate_limited` | More than 10 attempts a minute from one client IP. |
| 502 | `provider_unavailable`, `provider_error` | The merchant of record did not answer. |
| 503 | — | A required environment variable is missing. |

### The Protocol Pack is not a licence

`MOR_PRODUCT_PACK` maps to the internal SKU `pack`, and `pack` is not an app
tier — the pack is a print-ready PDF, and it is included free with Pro. A pack
key therefore gets a 422 with `code: "pack_only"` and a sentence pointing at the
download link in the receipt, rather than a token that unlocks nothing. **If the
owner would rather the pack unlock something in the app, that is a one-line
change in `api/license.js` plus a new tier — flag it before launch.**

---

## `POST /api/entitlement`

Refreshes a token. Two paths:

- **Cheap path.** The token verifies and is not yet inside its recheck window.
  The same token comes straight back. One HMAC, no outbound call. This is what
  the embed frame calls on every load.
- **Recheck path.** The token is inside its recheck window, or already expired.
  The merchant of record is asked again, so a cancelled subscription or a
  refunded order stops working within a week — with no revocation list and no
  database.

**The recheck window is `min(7 days, half the token's own lifetime)`** — 7 days
for a 30-day lifetime token, 3.5 days for a 7-day subscription token. The second
half of that expression matters: subscription tokens live exactly 7 days, so a
flat "recheck inside the last 7 days" rule would mark every practitioner token
stale the moment it was signed, and the embed frame — which holds the token and
never the key — would never get a usable answer.

**Request**

```json
{ "token": "eyJ2IjoxLCJ0aWVy….q0Xk…", "key": "txn_01hq…" }
```

`key` is optional. It exists because the token payload carries `sub`, which is a
one-way hash of the licence key, and a hash cannot be turned back into a key — so
a genuine recheck needs the key itself. When `key` is supplied it must hash to
the token's `sub`, otherwise the answer is `key_mismatch`; that check is what
stops anyone pairing a Pro key with a Studio token.

When `key` is absent and a recheck is due, the answer depends on whether the
token is still inside its own lifetime:

- **Not yet expired** → `{ ok: true, …, "refreshed": false, "stale": true }`.
  An unexpired token *is* valid — that is what the signature and `exp` mean — so
  the honest answer is yes, with a flag saying the provider could not be asked.
  This is the normal answer for an embed frame on a third-party site.
- **Already expired** → `{ ok: false, reason: "refresh_required" }`, and the
  client falls back to its own 14-day offline grace.

**A refresh never increments the activation counter.**

**Response — 200, valid**

```json
{ "ok": true, "token": "…", "tier": "studio", "exp": 1789000000, "act": 3, "dom": ["a.example"], "refreshed": true }
```

`refreshed` is `true` only when the merchant of record was actually asked and a
new token was minted. `stale: true` (present only when true) means the token is
past its recheck point but could not be re-verified, because no `key` was sent or
because the provider was unreachable. Either way `ok: true` means "use it".

**Response — 200, not valid**

```json
{ "ok": false, "reason": "bad_signature" }
```

A well-formed request always gets a 200; the verdict is in `ok`. Only a missing
or malformed body (400) or a flood (429) gets a non-200. `reason` is one of
`missing_token`, `malformed`, `bad_signature`, `bad_payload`, `bad_version`,
`kid_mismatch`, `refresh_required`, `key_mismatch`, `pack_only`,
`provider_unavailable`, or any provider reason from the table above.

Note what is *not* in that list: a plain `expired`. The token is verified with
`allowExpired`, because an expired token is still a question worth answering —
an expired token with a `key` gets a real recheck and usually a brand-new token,
and an expired token without one gets `refresh_required` plus `graceEnds`. The
clock alone never decides.

More than 120 refreshes a minute from one client IP gets a 429. The limit is
deliberately generous: an office behind one NAT address, or a busy practitioner
site with several embeds on a page, shares a bucket, and a 429 here would put the
attribution line back on a paying customer's widget.

A provider outage while the token is still valid answers `ok: true` with
`stale: true`. Once the token has expired, an outage inside the offline grace
window answers `provider_unavailable` **with** `tier` and `graceEnds`. Either
way the customer keeps working rather than being logged out because a third
party had a bad afternoon. A *hard* rejection — refunded, cancelled, subscription
inactive — is different: it answers `ok: false` with that reason even while the
token is technically still valid, because that is the whole point of rechecking.

### CORS on this endpoint is `*`, deliberately

`/api/entitlement` sends `Access-Control-Allow-Origin: *` because the embed frame
and the client session link are rendered inside third-party sites. What that
exposes is exactly one thing: whether a token the caller **already holds** is
valid, and what tier and domains it claims. It exposes no secret, no key, no
email and no order data. It never sends
`Access-Control-Allow-Credentials`, so no browser attaches a cookie to it. A
caller without a token learns nothing; a caller with one already knows its
contents, because the payload half of a token is plain base64url JSON that
anyone can read. The signature is what they cannot forge.

Every other endpoint is same-origin only: the `Origin` header is echoed back
only when its host matches the request host, or matches an entry in
`ALLOWED_ORIGINS`.

---

## `POST /api/subscribe`

**Request**

```json
{ "email": "person@example.com", "technique": "478", "source": "post-session", "consent": true }
```

`consent` must be literally `true`. `technique` and `source` are optional short
slugs used as tags. The email is lower-cased and validated server-side: shape,
length (254 total, 64 in the local part), no doubled dots, no leading or
trailing dot.

**Response — 200**

```json
{ "ok": true, "message": "Check your inbox to confirm" }
```

The answer is identical whether the address is new or already on the list.
Telling a stranger which addresses are subscribed would be a leak, and the
person at the form needs the same instruction either way.

**Response — failure**

```json
{ "ok": false, "error": "That does not look like an email address.", "field": "email" }
```

400 for validation, 429 for more than 5 requests a minute from one client IP,
502 when the mailing service is unreachable, 503 when it is not configured
(either a required variable is unset in production, or the list/template ids are
present but unusable).

Both adapters create the contact **unconfirmed** and let the provider send the
confirmation email. Brevo uses `POST /v3/contacts/doubleOptinConfirmation`,
which is itself the double opt-in flow. MailerLite uses `POST /api/subscribers`
with `status: "unconfirmed"` — turn double opt-in on for the group in the
MailerLite dashboard, because that switch, not this code, sends the email.

Only a 12-character hash prefix of the address is ever logged.

---

## `GET /api/health`

```json
{
  "ok": false,
  "provider": "paddle",
  "email": "brevo",
  "env": "production",
  "time": "2026-09-09T10:00:00.000Z",
  "configured": { "license_secret": true, "mor_api_key": false, "…": false },
  "missing": ["MOR_API_KEY"]
}
```

Booleans and variable names only. No value from the environment appears here —
not truncated, not hashed, not hinted at. The `kid` is deliberately omitted even
though it is technically public, because there is no reason to publish anything
derived from `LICENSE_SECRET` on an unauthenticated endpoint.

`ok` is `false` when a variable a working deployment needs is unset. The
endpoint still answers 200: it is a report, not a probe that should take the
site down.

---

## Environment variables

Every variable, with a one-line comment each, is in `.env.example`. The short
version:

| Variable | Required | Notes |
|---|---|---|
| `LICENSE_SECRET` | yes | 64 characters from `node tools/keygen.mjs`. |
| `MOR_PROVIDER` | no | `paddle` (default) or `fastspring`. |
| `MOR_API_KEY` | yes | Paddle: `pdl_live_apikey_…`. FastSpring: `username:password`. |
| `MOR_API_BASE` | no | Overrides the API base URL. Leave empty in production. |
| `MOR_WEBHOOK_SECRET` | no | Reserved for the auto-activation webhook flow. |
| `MOR_PRODUCT_LIFETIME` | yes | Pro lifetime. Several ids may be comma separated. |
| `MOR_PRODUCT_MONTHLY` | no | Pro monthly, if it is ever offered. |
| `MOR_PRODUCT_PRACTITIONER` | for that tier | Practitioner $99/yr. |
| `MOR_PRODUCT_STUDIO` | for that tier | Studio $199/yr. |
| `MOR_PRODUCT_PACK` | no | Protocol Pack. Refused as a licence, see above. |
| `MOR_API_USERNAME` / `MOR_API_PASSWORD` | no | FastSpring alternative to the `user:pass` form. |
| `EMAIL_PROVIDER` | no | `brevo` (default) or `mailerlite`. |
| `EMAIL_API_KEY` | yes | Never leaves the server. |
| `EMAIL_LIST_ID` | yes | Brevo list id (numeric) or MailerLite group id. |
| `EMAIL_DOI_TEMPLATE_ID` | Brevo only | Numeric id of the double opt-in template. |
| `EMAIL_DOI_REDIRECT_URL` | Brevo only | Where a confirmed subscriber lands. |
| `EMAIL_API_BASE` | no | Test hook. Leave empty in production. |
| `ALLOWED_ORIGINS` | no | Extra origins for the same-origin endpoints. |

Missing variables behave differently by environment. `VERCEL_ENV=production`
throws `MissingEnvError`, which becomes a 503 and a log line naming the
variable. Preview and development get `DEV_DEFAULTS` where one exists and an
obvious `dev-missing-<NAME>` placeholder otherwise, so a local request fails at
the provider with a 401 instead of silently pretending to work. **A preview
deployment is not production**, which is what lets you point a preview at the
Paddle sandbox.

Each product variable may hold several ids separated by commas or spaces. That
matters for Paddle, where a transaction exposes both a price id (`pri_…`) and a
product id (`pro_…`), and where the $14 founding price is a second price id
against the same product. Put both in; the highest-ranked match wins if an order
contains several products.

---

## Swapping the merchant of record

One file, one variable.

1. Write `api/_lib/providers/<name>.js` exporting an adapter:

   ```js
   export const myProvider = {
     id: 'myprovider',
     keyHint: 'Your licence key is on your receipt.',
     looksLikeKey(key) { … },
     async lookup(key, ctx) { … },              // -> { ok, record } | { ok: false, reason }
     async recordActivation(record, input, ctx) { … },
   };
   ```

2. Add it to `listProviders()` in `api/_lib/providers/index.js`.
3. Set `MOR_PROVIDER=<name>` and redeploy.

Nothing outside `api/_lib/providers/` names a payment company. `lookup()` must
return a `record` of `{ provider, orderId, sku, tier, live, status,
subscriptionStatus, activations, maxActivations, maxDomains, domains, ref }`;
`ref` is for whatever provider-internal ids `recordActivation` needs to write
back. `ctx` is `{ env, fetchImpl, isProd, sub }` — always call through
`ctx.fetchImpl` when it is present, which is how the test suite runs offline.
`ctx.sub` is the 12-character hash of the licence key and is the **only**
identifier an adapter may log: for both Paddle and FastSpring the order id *is*
the licence key the buyer pastes, so `record.orderId` must never appear in a log
line.

The email seam works the same way: `api/_lib/email/index.js`, adapter with
`id`, `requiredEnv` and `subscribe(contact, ctx)`, then `EMAIL_PROVIDER`.

### Paddle specifics

- Base URLs: live `https://api.paddle.com`, sandbox `https://sandbox-api.paddle.com`.
  The adapter picks one from the shape of `MOR_API_KEY` (`pdl_sdbx_…` means
  sandbox), and **refuses a sandbox key on a production deployment before making
  any network call**.
- The licence key a buyer pastes is the **transaction id** from the receipt,
  matching `^txn_[a-z\d]{26}$`.
- Verification is `GET /transactions/{id}?include=customer,adjustments`. The
  order must be `billed`, `paid` or `completed`; `canceled` and `draft`/`ready`
  are refused. Any adjustment whose `action` is `refund`, `chargeback` or
  `chargeback_warning` and whose `status` is not `rejected` or `reversed` revokes
  the licence. A partial `credit` does not.
- For renewing SKUs the subscription is checked too. `active`, `trialing` and
  `past_due` are honoured (`past_due` is Paddle retrying a card); `canceled` and
  `paused` are refused.
- **The activation counter lives on the customer, not the transaction.** Paddle
  is explicit that *"`billed` and `completed` transactions are considered records
  for tax and legal purposes, so they can't be changed"*, so `PATCH
  /transactions/{id}` is not available. `PATCH /customers/{id}` accepts
  `custom_data`, so the ledger is:

  ```json
  { "hmb_activations": { "txn_01h…": { "n": 2, "max": 6, "doms": ["clinic.example"],
                                       "first": "…", "last": "…" } } }
  ```

  One entry per purchase, so a customer who buys twice keeps two counters. The
  adapter reads the customer's existing `custom_data`, merges, and writes it
  back, so anything else the owner keeps there survives.
- **Required API key permissions:** `transaction.read`, `customer.read`,
  `customer.write`, `subscription.read`. Without `customer.write` the counter
  cannot be incremented and the cap silently stops biting — the adapter logs a
  loud warning when the write fails, and the token is still issued so a paying
  customer is never stranded by a permissions mistake.
- **To free an activation slot**, edit `hmb_activations` on the customer in the
  Paddle dashboard: lower `n`, or delete the entry for that transaction.

### FastSpring specifics

- Base URL `https://api.fastspring.com`. Authentication is HTTP Basic with the
  API username and password created in the dashboard; put them in `MOR_API_KEY`
  as `username:password`, or use `MOR_API_USERNAME` / `MOR_API_PASSWORD`.
- The licence key is the **order id** from the receipt.
- Verification is `GET /orders/{id}`: `live` must be true in production,
  `completed` must be true, and the product path must match one of the
  `MOR_PRODUCT_*` variables. Subscription products are checked with `GET
  /subscriptions/{id}`, where `active` must be true.
- The ledger lives in the order's tags, written with `POST /orders`
  (*"Updates order tags and attributes."*). Tag values are strings, so it is
  JSON-in-a-string under the tag `hmb_act`. Every tag already on the order is
  written back alongside it, because the docs do not say whether a tag update
  merges into the existing map or replaces it.
- **Known limit, unverified against a live account:** the documented response
  schema for `GET /orders/{id}` does not list a `tags` field — only the update
  endpoint documents tags. If a real order does not echo its tags back, the
  adapter reads an activation count of zero every time and the device cap stops
  biting on FastSpring. Licences are still issued and nobody is stranded. Confirm
  this against one real order before FastSpring ever becomes the primary rail.
- **Known limit:** FastSpring's documented order schema does not expose a refund
  flag, so a refunded one-off order cannot be detected from the order alone. The
  revocation path is a manual tag: set `hmb_revoked` to any non-empty value on
  the order in the FastSpring dashboard and the adapter refuses the key from the
  next call onwards. Three undocumented fields (`refunded`, `returned`,
  `status === "refunded"`) are also checked defensively in case a future API
  version starts sending them. Subscription refunds are covered, because the
  subscription goes inactive.
- **To free an activation slot**, edit the `hmb_act` tag on the order.

---

## The licence token

```
base64url(JSON payload) + "." + base64url(HMAC-SHA256 over the first segment)
```

The signature covers the **encoded** first segment, not the raw JSON, so
verification never re-serialises JSON — key order would change the bytes.

```json
{ "v": 1, "tier": "practitioner", "sub": "a1b2c3d4e5f6",
  "iat": 1788000000, "exp": 1788604800, "kid": "9f2a1c04",
  "act": 3, "dom": ["clinic.example"] }
```

| Field | Meaning |
|---|---|
| `v` | Format version. Always `1`. Anything else is refused. |
| `tier` | `pro`, `practitioner` or `studio`. |
| `sub` | First 12 hex characters of `sha256(licence key)`. The only key derivative that may be logged. |
| `iat`, `exp` | Seconds since epoch. |
| `kid` | First 8 hex characters of `sha256(LICENSE_SECRET)`, so a rotation is detectable as `kid_mismatch` rather than a generic signature failure. |
| `act` | Activation count at the moment of issue. |
| `dom` | Optional. Allowed hostnames for white-label embeds. Absent means "any". |

**Lifetimes.** A lifetime purchase gets 30 days; anything that renews gets 7.
That is the whole revocation mechanism: a cancelled subscriber's last token runs
out within a week, so there is no revocation list to keep and nothing to clean up.

**Offline grace.** The client keeps working for 14 days past `exp` when refreshes
fail, then falls back to free. `refreshWindow()` in `api/entitlement.js` is the
single source of truth for that arithmetic and is covered by the test suite.

### How the client uses it

`js/entitlements.js` owns the client side and is the only module that knows tiers
exist. It stores the token at `localStorage['hmb.license']`, decodes the payload
without verifying the signature (a read-only convenience — `requirePro()` is the
only gate), and re-evaluates on a `storage` event so activating in one tab lights
up the others.

```
activate(key)  -> POST /api/license      { key }            -> store { token }
refresh()      -> POST /api/entitlement  { token, key? }    -> replace { token }
```

**Integration note for the Pro agent:** for the recheck path to work, the client
needs to keep the licence key alongside the token — for example at
`localStorage['hmb.licensekey']` — and pass it as `key` on refresh. Without it a
token still works right up to its `exp` (the answer is `ok: true, stale: true`),
but it can never be renewed, so the customer eventually has to re-paste their key
by hand, which burns another activation slot. Calling `/api/license` again
instead of `/api/entitlement` is *not* the fallback: that increments the counter.

---

## Security model, and what it does not do

**What the signature buys.** A token cannot be forged without `LICENSE_SECRET`,
and the secret only exists in the deployment's environment. Editing the payload
in `localStorage` breaks the signature. Copying someone else's token works, but
so does copying their licence key, which is the same problem one step earlier.

**What it does not buy.** Client-side enforcement is bypassable **by design**.
Every paid feature ships in the same static JavaScript as the free ones, so a
determined person can open devtools and turn a flag on. That is a deliberate
trade for a site with no accounts, no server rendering and no database. The
business defence is that Pro costs $19 once, the Practitioner tier's value is the
commercial-use licence and the white-label domain list — things a bypass does not
grant — and the people who would bypass it were never going to pay. **Do not
build DRM on top of this.** Nothing here should be treated as protecting a
secret; it protects a purchase record.

**Activation counting is coarse.** An "activation" is one successful
`/api/license` call. There is no device identifier in the contract, so a person
who clears their browser storage and re-activates burns another slot. Six slots
for a lifetime Pro licence is generous enough that this is a support email, not
a wall — and the fix is one edit in the provider dashboard.

**The ledger is racy.** Two simultaneous activations read the same counter and
both write `n + 1`, so one increment is lost. There is no compare-and-swap
without a database, and losing an increment errs toward the customer.

**Rate limiting is best effort.** The counters live in an in-memory `Map` inside
a warm function instance. Vercel may run several instances and recycle them at
any moment, so the real limit is "a few times the configured number". It stops a
careless script; it is not a security control.

**Secrets never leave the server.** `EMAIL_API_KEY` and `MOR_API_KEY` are used
only in outbound request headers. Nothing logs a full licence key, a full email
address or any environment value: keys are logged as `sub`, addresses as a
12-character hash prefix, and `/api/health` returns booleans. This matters more
than it looks, because on both rails the *order id* is the licence key — so
`record.orderId` is as sensitive as the key itself and never reaches a log line.
Provider adapters get `ctx.sub` for exactly this reason, and a test enforces it.

**Everything is `no-store`.** No API response should ever sit in a CDN or a
browser cache.

### Rotating `LICENSE_SECRET`

Generate a new one with `node tools/keygen.mjs`, replace the variable, redeploy.
Every existing token immediately fails with `kid_mismatch`, so every customer
re-activates from the key in their receipt — one click each, and one more
activation slot each. Only rotate if you believe the secret leaked. There is no
dual-secret grace period; adding one would mean keeping the old secret around,
which defeats the purpose of rotating.

---

## Local development and testing

```bash
node --test tools/api.test.mjs      # 74 tests, no network, no env needed
node --check api/license.js         # and every other file under api/
node tools/keygen.mjs               # prints a secret, writes nothing
npm test                            # runs everything under tools/
```

The suite covers the token round trip, expiry, tampering (payload and
signature), `kid` mismatch after rotation, the grace-window arithmetic, the rate
limiter, CORS behaviour on both policies, `requireEnv` in production versus
development, product-id mapping for both providers with a mocked `fetch`
(including refunds, chargebacks, cancelled subscriptions, sandbox keys in
production and ledger writes), and every branch of subscribe validation. One
test exists purely to hold a hard rule in place: it captures `console.warn`
while both adapters fail a ledger write and asserts that no order id — which on
both rails *is* the licence key — ever appears in the output.

Provider adapters take `fetchImpl` on their context, which is how the tests run
offline. `MOR_API_BASE` and `EMAIL_API_BASE` point the adapters at a stub host.

To exercise the real thing, run `vercel dev` with a `.env` holding sandbox
credentials. A sandbox Paddle key works on preview and development but is
refused on production, so there is no way to accidentally ship one.
