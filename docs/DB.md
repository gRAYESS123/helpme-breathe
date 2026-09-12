# Help Me Breathe — the database

The accounts and billing schema, as created by
`supabase/migrations/0001_accounts_billing.sql`. This page documents every
table, every column, the one RPC function, the triggers, the security model,
and the retention and reconciliation jobs that keep the data honest. How to
apply the migration is in `supabase/README.md`.

Source of truth for the *why* is the private design document
(`docs/private/ACCOUNTS_BILLING_DESIGN.md`, revision 2, 2026-09-11). Section
numbers below refer to it. Where this page and that document disagree, the
design document wins and this page has a bug.

Owner decisions this schema is built for: **D1** three free timer sessions per
device before sign-in; **D2** one plan, `monthly` ($10) or `yearly` ($100),
everything included; **D3** a 3-day card-required trial, one per person,
locked by a MAC'd device cookie and a peppered email hash. The
`practitioner_yearly` plan value ships in the enums so that a later D2 change
is a config change, not a migration.

---

## 1. Shape in one screen

```
auth.users ─────┬──< profiles            (cascade)     one row per account
 (Supabase)     ├──< subscriptions       (SET NULL)    one row per MoR subscription; detaches on delete
                ├──< checkout_intents    (cascade)     one row per checkout attempt; the reservation
                └──< embed_tokens        (cascade)     credential groups
                        └──< embed_credentials (cascade)  one row per issued jti

devices         no FK — outlives the account (device half of the trial lock, D1 counter)
trial_claims    no FK — outlives the account (email half of the trial lock)
webhook_events  no FK — idempotency + retry ledger + forensic trail
rate_limits     no FK — fixed-window counters for the money endpoints
```

Nine tables. Every timestamp is `timestamptz`. Every primary key that is not a
natural key is a `uuid` from `gen_random_uuid()` (pgcrypto).

### The three deliberate non-cascades

| Table | Relationship to `auth.users` | Why |
|---|---|---|
| `devices` | none (`trial_user_id` is a bare uuid) | The row must outlive account deletion, or deleting the account resets the device half of the trial lock. |
| `trial_claims` | none (`user_id` is a bare uuid) | Same: the email hash must survive the account, or one trial per person is unenforceable. |
| `subscriptions` | `user_id ... on delete set null` | Draft 1 cascaded it, which meant a deleted account with a still-live merchant-of-record subscription orphaned every later webhook. Now the row **detaches** (`user_id = null`, `detached_at` set) and is kept, so reconciliation still works (§11.5). |

Everything else (`profiles`, `checkout_intents`, `embed_tokens`,
`embed_credentials`) cascades from the account, because none of it has meaning
without one.

---

## 2. Security model — RLS enabled, zero policies (§3.3)

Every table has row level security **enabled** and **forced**, and **not one
policy**. All grants to `anon` and `authenticated` are revoked. The
`bump_rate_limit` function is executable only by `service_role`.

What that means in practice:

- The browser holds the publishable key and a Supabase session, but can read
  and write **nothing** through PostgREST. `auth.uid()` is never consulted
  because no policy exists to consult it. Everything the front end needs
  arrives in `GET /api/me`.
- `api/*` holds `SUPABASE_SECRET_KEY` (the `service_role` key), which carries
  the `BYPASSRLS` attribute and therefore passes `force row level security`.
  That key never leaves Vercel and never appears in a response.
- **Every handler is doing its own authorization by hand, with no safety net
  underneath.** A handler derives the user id from the verified JWT's `sub`
  (`api/_lib/supabase.js#verifyAccessToken`) — never from a request body, a
  query string, a cookie or `custom_data`. A handler that reads `body.user_id`
  is a security bug.
- `force row level security` also binds the table owner. That is harmless
  here because the SQL editor's `postgres` role and `service_role` both bypass
  RLS by role attribute (Supabase docs, Row Level Security: "On Supabase the
  owner is `postgres`, which has `bypassrls`"; and the secret key "authorizes
  access through the `service_role` Postgres role, which has the `bypassrls`
  attribute"). `BYPASSRLS` wins over `force`, which matters for the two
  `security definer` functions below: they run as `postgres` and write to
  forced tables. It protects against a future policy being added under the
  assumption that "the owner is exempt anyway".

Do not add a policy to make the dashboard's Table Editor more convenient. Use
the SQL editor.

---

## 3. Tables

Legend for the **Written by** column: task numbers are the build plan in §15
(`3` = entitlement-core, which also owns `api/cron/retention.js`; `4` = trial-guard;
`5` = mor-adapters, which also owns `api/cron/reconcile.js`; `8` = embed-credentials;
`12` = cleanup-integrate). The design's §3.4 says the crons are "task 13"; its §15
ownership table has no task 13, and that table wins.

### 3.1 `public.profiles` — one row per account

Created automatically by the `on_auth_user_created` trigger the moment
Supabase inserts an `auth.users` row (magic link or Google — one email address
is one user either way, §1 identity linking). Deleted by cascade when the
`auth.users` row is deleted.

| Column | Type | Null | Default | Meaning | Written by |
|---|---|---|---|---|---|
| `id` | `uuid` PK → `auth.users(id)` cascade | no | — | The Supabase user id. The same value is the `sub` in every entitlement token. | trigger |
| `email` | `text` | yes | — | Copied from `auth.users.email` at creation. Used as the **last-resort** join for a webhook that carries no usable reservation id (§6.3 step 3, compared lowercased). Not re-synced if the auth email later changes — see § 8. | trigger |
| `display_name` | `text` | yes | — | Optional. Nothing in the design sets it; reserved for `/account`. | — |
| `created_at` | `timestamptz` | no | `now()` | Account creation date. One of the few facts the privacy policy says an account stores. | trigger |
| `updated_at` | `timestamptz` | no | `now()` | Touched on every update by `profiles_touch`. | trigger |
| `marketing_opt_in` | `boolean` | no | `false` | Account-level marketing consent. Not written by any flow in the design (email capture still goes through `/api/subscribe` double opt-in); reserved. | — |
| `last_seen_at` | `timestamptz` | yes | — | Not written by any flow in the design; reserved. If a later task stamps it (the natural place is `GET /api/me`), record that here. | — |
| `deletion_requested_at` | `timestamptz` | yes | — | Not written by any flow in the design: §11.5's delete either completes (the row cascades away) or refuses (dispute open / past due). Reserved for a later soft-delete or for an audit mark on a refused request. | — |

**Indexes:** primary key only.

### 3.2 `public.subscriptions` — one row per merchant-of-record subscription

The system of record for entitlement. **`access_until` is the only column the
entitlement layer reads** (§3.1); every webhook writes it and no other code
re-derives access from statuses and dates. A user's effective entitlement is
the maximum `access_until` across all of their rows, with the status of the
row that produced it (§6.5).

| Column | Type | Null | Default | Meaning | Written by |
|---|---|---|---|---|---|
| `id` | `uuid` PK | no | `gen_random_uuid()` | Local row id. Not shown to users. | 5 |
| `user_id` | `uuid` → `auth.users(id)` **set null** | yes | — | The owning account. `null` after account deletion (see `detached_at`) or for a true orphan (see § 8). | 5, 3 |
| `provider` | `text` | no | `'paddle'` | Merchant-of-record adapter id (`paddle` or `fastspring`). Half of the natural key. | 5 |
| `provider_subscription_id` | `text` | no | — | The provider's subscription id (`sub_…`). With `provider`, the join key forever once resolved (§6.3). | 5 |
| `provider_customer_id` | `text` | yes | — | The provider's customer id (`ctm_…`). Second-choice join for a webhook with no usable reservation id. | 5 |
| `provider_price_id` | `text` | yes | — | The provider price the subscription is on (`pri_…`). Checked against the reservation at `sub.created` — a trial price with no `trial_granted` reservation is cancelled immediately (§6.3). | 5 |
| `plan` | `text` check | no | — | `monthly`, `yearly` or `practitioner_yearly`. Under D2 = one, only the first two occur. | 5 |
| `status` | `text` check | no | — | `trialing`, `active`, `past_due`, `paused`, `canceled` (the provider's five) plus the local `expired`, set only by the retention job. | 5, 3 |
| `had_trial` | `boolean` | no | `false` | This subscription began with a trial. Set from the reservation row, never from `custom_data`. | 5 |
| `ever_paid` | `boolean` | no | `false` | A non-zero `transaction.completed` has been seen. **Gates the past-due grace:** a decline at trial conversion (`ever_paid = false`) ends access at `trial_ends_at`, not seven days later (§6.5). | 5 |
| `trial_started_at` | `timestamptz` | yes | — | From the provider. | 5 |
| `trial_ends_at` | `timestamptz` | yes | — | From the provider. Becomes `access_until` while `trialing`. | 5 |
| `current_period_start` | `timestamptz` | yes | — | From the provider. `null` until the first paid period. | 5 |
| `current_period_end` | `timestamptz` | yes | — | From the provider. `access_until = current_period_end + 48h` while `active` (the 48 h covers renewal-webhook lag). | 5 |
| `next_billed_at` | `timestamptz` | yes | — | From the provider. Shown on `/account` as the next charge date. | 5 |
| `cancel_at` | `timestamptz` | yes | — | A scheduled cancellation (`effective_from: next_billing_period`, §5.9). Access continues to this moment. | 5 |
| `canceled_at` | `timestamptz` | yes | — | When the provider reported the cancellation. `access_until = coalesce(cancel_at, canceled_at)` once `canceled`. | 5 |
| `paused_at` | `timestamptz` | yes | — | When a pause took effect. Access continues to `current_period_end` (§6.5, the paused row). | 5 |
| `resume_at` | `timestamptz` | yes | — | When a paused subscription resumes (1 or 3 months, §5.8). | 5 |
| `past_due_since` | `timestamptz` | yes | — | First failed payment of the current dunning cycle. Cleared when dunning recovers. | 5 |
| `access_until` | `timestamptz` | yes | — | **The entitlement.** Computed by the §6.5 mapping on every event. `null` means no access. | 5 |
| `display_amount` | `numeric(12,2)` | yes | — | The amount the provider actually charges this customer, as the provider states it, taken from `transaction.completed`. Never computed by us. `null` before the first confirmed transaction. | 5 |
| `display_currency` | `text` | yes | — | ISO currency of `display_amount`, from the provider. | 5 |
| `display_tax_inclusive` | `boolean` | yes | — | Whether `display_amount` includes tax, as the provider presents it. | 5 |
| `dispute_open` | `boolean` | no | `false` | A chargeback or dispute is open. Blocks account deletion (§11.5). **Never auto-bans** — the owner decides from the flag (§13). | 5 |
| `live` | `boolean` | no | `true` | Whether the events for this row came from the provider's live environment. A sandbox event arriving in production is recorded as `ignored` and never reaches this table (§6.1). | 5 |
| `last_event_at` | `timestamptz` | yes | — | `occurred_at` of the last event applied. **Ordering is enforced by the write:** the update carries `and (last_event_at is null or last_event_at < $occurred)`; zero rows affected sets `needs_reconcile` (§6.3). | 5 |
| `needs_reconcile` | `boolean` | no | `false` | An out-of-order or failed event left this row possibly stale. The hourly reconcile job rewrites it from `provider.getSubscription()` and clears the flag. | 5 |
| `detached_at` | `timestamptz` | yes | — | Set by account deletion when the row is detached instead of cascaded. A row with `user_id is null and detached_at is null` is a **true orphan** and is reported by the reconcile job. | 3 |
| `created_at` | `timestamptz` | no | `now()` | | 5 |
| `updated_at` | `timestamptz` | no | `now()` | Touched by `subscriptions_touch`. | trigger |

**Constraints:** `unique (provider, provider_subscription_id)`.

**Indexes:**

| Index | Columns | Serves |
|---|---|---|
| `subscriptions_user_idx` | `(user_id)` | `GET /api/me`, export, delete |
| `subscriptions_access_idx` | `(user_id, access_until desc)` | the max-`access_until` entitlement read |
| `subscriptions_customer_idx` | `(provider, provider_customer_id)` | webhook resolution step 2 |
| `subscriptions_reconcile_idx` | `(needs_reconcile) where needs_reconcile` | the hourly reconcile scan |

**The `access_until` mapping (§6.5) — this table is the specification:**

| `status` | `access_until` |
|---|---|
| `trialing` | `trial_ends_at` |
| `active` | `current_period_end + 48h` |
| `past_due` and `ever_paid` | `least(past_due_since + 7d, coalesce(current_period_end, past_due_since) + 7d)` |
| `past_due` and not `ever_paid` | `coalesce(trial_ends_at, now())` — access ends on schedule |
| `paused` | `coalesce(current_period_end, now())` |
| `canceled` | `coalesce(cancel_at, canceled_at)` |
| `expired` | unchanged (already in the past) |

### 3.3 `public.devices` — the device half of the trial lock, and the D1 counter

No foreign key to `auth.users`, on purpose. Holds no email and no fingerprint
of any kind (§5.2 deleted fingerprinting entirely). `device_id` is the uuid
half of the self-authenticating `__Host-hmb_did` cookie
(`<uuid>.<base64url(hmac_sha256(DEVICE_PEPPER, uuid))>`, §5.1); a value whose
MAC does not verify never reaches this table — the server mints a fresh id
instead, and never resurrects a burned one.

| Column | Type | Null | Default | Meaning | Written by |
|---|---|---|---|---|---|
| `device_id` | `uuid` PK | no | `gen_random_uuid()` | The uuid half of the cookie. Issued only by `GET /api/me` and `POST /api/trial/eligibility`. | 3, 4 |
| `first_seen_at` | `timestamptz` | no | `now()` | | 3, 4 |
| `last_seen_at` | `timestamptz` | no | `now()` | Refreshed whenever the cookie is verified. Feeds the 24-month retention ceiling. | 3, 4 |
| `seen_count` | `integer` | no | `1` | Number of verified resolutions. Diagnostic. | 3, 4 |
| `free_sessions_used` | `integer` | no | `0` | **The D1 counter.** Completed timer sessions on this device before sign-in; `requireTimer()` compares it with `TIMER_FREE_SESSIONS` (= 3). Incremented by the `/api/session/count` beacon. Soft on purpose — clearing cookies resets it, and that is an accepted cost. | 4, 12 |
| `trial_reserved_until` | `timestamptz` | yes | — | A live 30-minute checkout reservation on this device. Blocks a parallel second checkout from the same device; an expired one is ignored and overwritten (§5.4 step 6). | 4 |
| `trial_consumed_at` | `timestamptz` | yes | — | A trial actually started on this device. **Soft** signal on its own (a household iPad is not fraud, §5.3 layer 4). | 5 |
| `trial_count` | `integer` | no | `0` | Trials started on this device. **`>= 2` is a hard no-trial signal** (§5.3 layer 3), so nobody farms one device indefinitely. | 5 |
| `trial_user_id` | `uuid` | yes | — | The account that used the trial here. Intentionally not a foreign key; nulled on account deletion (§11.5 step 5). | 5, 3 |
| `notes` | `text` | yes | — | Owner free text (support notes). Never written by code. | owner |

**Indexes:** `devices_consumed_idx` on `(trial_consumed_at) where trial_consumed_at is not null`.

### 3.4 `public.trial_claims` — the email half of the trial lock

Keyed on a **server-side** pepper-keyed hash: `email_hash =
hmac_sha256(TRIAL_PEPPER, normalize(email))`, where `normalize()` trims,
lowercases, IDNA-folds the domain and, for the gmail/googlemail family, strips
dots and `+` tags (§5.4 step 4). The hash is pseudonymised personal data, not
anonymous data — we hold the pepper — which is why it has a 24-month ceiling
(§11.4) rather than being kept "indefinitely". No foreign key to
`auth.users`, on purpose.

| Column | Type | Null | Default | Meaning | Written by |
|---|---|---|---|---|---|
| `email_hash` | `bytea` PK | no | — | The 32-byte HMAC. The only identifier. | 4 |
| `claimed_at` | `timestamptz` | no | `now()` | First reservation for this email. Feeds the 24-month ceiling and the conversion query in § 7. | 4 |
| `reserved_until` | `timestamptz` | yes | — | `now() + 30 min` at reservation. A `reserved` row past this is ignored, overwritten on the next attempt, and flipped to `expired` by the retention job. | 4, 3 |
| `outcome` | `text` check | no | `'reserved'` | State machine: `reserved` → `started` → `converted` / `cancelled` / `refunded` / `chargeback`; or `reserved` → `expired`. **Any outcome other than `expired` is a hard no-trial signal** (§5.3 layer 1). | 4, 5, 3 |
| `device_id` | `uuid` | yes | — | The device the reservation was made on. Not a foreign key. | 4 |
| `user_id` | `uuid` | yes | — | The account. Intentionally not a foreign key; nulled on account deletion (§11.5 step 5) while the hash stays. | 4, 3 |
| `provider` | `text` | yes | — | Filled when the trial starts at the provider. | 5 |
| `provider_customer_id` | `text` | yes | — | | 5 |
| `provider_subscription_id` | `text` | yes | — | | 5 |
| `updated_at` | `timestamptz` | no | `now()` | Touched by `trial_claims_touch`. | trigger |

**Indexes:** `trial_claims_user_idx (user_id)`, `trial_claims_device_idx (device_id)`.

### 3.5 `public.checkout_intents` — the reservation; the security pivot

Commercial terms are decided **here, server-side**, by `POST
/api/trial/eligibility`, and the browser only ever carries the opaque
`reservation_id` (as `custom_data.rid` on the provider transaction). Nothing
that comes back through the browser is trusted: at first webhook contact the
`rid` resolves to this row and every fact — user, device, email hash, plan,
whether a trial was granted, which price — is read from here (§5.4, §6.3).

| Column | Type | Null | Default | Meaning | Written by |
|---|---|---|---|---|---|
| `reservation_id` | `uuid` PK | no | `gen_random_uuid()` | The opaque id. The only value in `custom_data` besides a version number. | 4 |
| `user_id` | `uuid` → `auth.users(id)` cascade | no | — | From the verified JWT `sub`. | 4 |
| `email_hash` | `bytea` | yes | — | The same HMAC as `trial_claims.email_hash`, so the webhook can update the ledger without the email. | 4 |
| `device_id` | `uuid` | yes | — | The verified device. The webhook burns `devices.trial_consumed_at` from **this**, never from `custom_data`. | 4 |
| `plan` | `text` check | no | — | `monthly`, `yearly` or `practitioner_yearly`. | 4 |
| `trial_granted` | `boolean` | no | `false` | The ladder's verdict. A subscription arriving on a trial price with no matching `trial_granted = true` row is cancelled at the provider immediately (§6.3). | 4 |
| `price_id` | `text` | no | — | Chosen server-side from `(plan, trial)`. Never client-supplied. | 4 |
| `provider` | `text` | no | — | Adapter id. | 4 |
| `provider_transaction_id` | `text` | yes | — | The server-created transaction (`txn_…`) handed to the checkout overlay as `transactionId`. | 4 |
| `provider_customer_id` | `text` | yes | — | From `provider.ensureCustomer`. | 4 |
| `reasons` | `text[]` | no | `'{}'` | Machine-readable ladder output: `email_used`, `device_used`, `already_subscribed`, `trial_disabled`, `rate_limited`, `ledger_unavailable`, plus soft flags. Kept for support and for the reconcile job. | 4 |
| `created_at` | `timestamptz` | no | `now()` | | 4 |
| `expires_at` | `timestamptz` | no | `now() + 30 minutes` | The reservation window. Deleted by retention 7 days after expiry. | 4 |
| `consumed_at` | `timestamptz` | yes | — | Set when a webhook resolves this reservation (§6.3 step 1). | 5 |

**Indexes:** `checkout_intents_user_idx (user_id, created_at desc)`,
`checkout_intents_txn_idx (provider, provider_transaction_id)`.

### 3.6 `public.embed_tokens` — a subscriber's credential groups

A subscriber manages a **credential group** on `/account`. Each issued token
is its own row in `embed_credentials` with its own `jti`, so rotation can
expire the old one after an overlap and revocation can kill every `jti` in
the group at once (§9.3). Cascades from the account.

| Column | Type | Null | Default | Meaning | Written by |
|---|---|---|---|---|---|
| `id` | `uuid` PK | no | `gen_random_uuid()` | Local row id. | 8 |
| `user_id` | `uuid` → `auth.users(id)` cascade | no | — | The subscriber. | 8 |
| `token_id` | `text` unique | no | — | The group id (`et_…`), shown on `/account` and carried as `gid` in the credential payload. | 8 |
| `domains` | `text[]` | no | `'{}'` | Hostnames the white-label frame may be embedded on. Checked at frame-document time against `Referer` (§9.2). | 8 |
| `label` | `text` | yes | — | The subscriber's own name for it ("Clinic homepage"). | 8 |
| `created_at` | `timestamptz` | no | `now()` | | 8 |
| `revoked_at` | `timestamptz` | yes | — | Set by `DELETE /api/embed/token`. Invalidates **every** `jti` in the group immediately. | 8 |
| `last_seen_at` | `timestamptz` | yes | — | Last verified render. | 8 |
| `hit_count` | `bigint` | no | `0` | Verified renders, sampled 1-in-10 to keep the write cheap (§9.4). | 8 |
| `verify_count_30d` | `bigint` | no | `0` | Rolling 30-day count, so the owner can see one subscriber serving outsized volume — the data behind the D2 pricing question (§9.5). Maintained by task 8; the roll-off is task 8's to define. | 8 |

**Indexes:** `embed_tokens_user_idx (user_id)`.

### 3.7 `public.embed_credentials` — one row per issued embed credential

| Column | Type | Null | Default | Meaning | Written by |
|---|---|---|---|---|---|
| `jti` | `text` PK | no | — | The credential id (`ec_…`) carried in the `typ: 'emb'` token payload. | 8 |
| `token_id` | `text` → `embed_tokens(token_id)` cascade | no | — | The group. | 8 |
| `issued_at` | `timestamptz` | no | `now()` | | 8 |
| `expires_at` | `timestamptz` | no | — | Token `exp` (30 days from issue). | 8 |
| `superseded_at` | `timestamptz` | yes | — | Set on rotation (`GET /api/embed/token?rotate=1`). The credential hard-expires **48 hours** after this, long enough for a cached snippet to keep working while the subscriber updates it. | 8 |
| `revoked_at` | `timestamptz` | yes | — | Per-credential revocation, in addition to the group-level `embed_tokens.revoked_at`. | 8 |
| `last_seen_at` | `timestamptz` | yes | — | | 8 |
| `hit_count` | `bigint` | no | `0` | Sampled verified renders for this `jti`; `/account` shows it so a subscriber can see what is out there. | 8 |

**Indexes:** `embed_credentials_group_idx (token_id)`.

### 3.8 `public.webhook_events` — idempotency, replay defence, retry ledger, forensic trail

`status` is a **state machine**, not a flag: `received` → `processed` |
`ignored` | `failed`. A `failed` row is re-claimable (a provider retry or a
manual re-POST re-processes it); a `processed` row is a permanent no-op; an
`ignored` row is one the environment gate rejected (§6.1). The claim is a
single `insert … on conflict do update … where status in ('failed','received')
returning status` — zero rows back means already processed.

| Column | Type | Null | Default | Meaning | Written by |
|---|---|---|---|---|---|
| `provider` | `text` PK part | no | — | Adapter id. | 5 |
| `event_id` | `text` PK part | no | — | The provider's event id (`ntf_…`, or FastSpring `events[].id`). **The idempotency key.** | 5 |
| `event_type` | `text` | yes | — | Normalised type (`sub.activated`, `txn.completed`, …). | 5 |
| `occurred_at` | `timestamptz` | yes | — | From the provider. Drives the ordering guard on `subscriptions.last_event_at`. | 5 |
| `received_at` | `timestamptz` | no | `now()` | First arrival. Drives retention. | 5 |
| `processed_at` | `timestamptz` | yes | — | Set on `processed`. | 5 |
| `attempts` | `integer` | no | `0` | Incremented on every claim. The reconcile job stops re-driving at 10 and logs an error instead. | 5 |
| `status` | `text` check | no | `'received'` | `received`, `processed`, `ignored`, `failed`. | 5 |
| `error` | `text` | yes | — | Last failure message, or a named reason (`orphan_subscription`, `trial_price_without_reservation`, `live_flag_mismatch`). Cleared on re-claim. | 5 |
| `payload` | `jsonb` | yes | — | The raw event. **Nulled at 30 days only for `processed` rows** — a failed row keeps its evidence for as long as the problem exists. | 5, 3 |

**Indexes:** `webhook_events_received_idx (received_at desc)`,
`webhook_events_failed_idx (status, received_at desc) where status <> 'processed'`.

### 3.9 `public.rate_limits` — fixed-window counters

`api/_lib/ratelimit.js` is in-memory and per-instance; its own header says it
"is not a security control". The design puts `POST /api/trial/eligibility`
on this table through `bump_rate_limit` (§5.4 step 2); any other
money-touching endpoint that needs a real limit should use the same function
rather than the in-memory one.

| Column | Type | Null | Default | Meaning | Written by |
|---|---|---|---|---|---|
| `bucket` | `text` PK part | no | — | Namespaced key, e.g. `trial:<user uuid>`, `trial:ip:<ip /24>`. IP is a rate-limit dimension **only**, never a dedupe key (§5.2). | function |
| `window_start` | `timestamptz` PK part | no | — | Start of the fixed window, aligned to the epoch. | function |
| `count` | `integer` | no | `0` | Hits in this window. | function |

**Indexes:** `rate_limits_window_idx (window_start)` — for the retention delete.

---

## 4. Functions and triggers

### 4.1 `public.bump_rate_limit(p_bucket text, p_window_seconds integer, p_limit integer) → boolean`

`security definer`, `search_path = ''`. Computes the current fixed window
(`floor(epoch / p_window_seconds) * p_window_seconds`), upserts the counter
for `(p_bucket, window)`, and returns **`true` when the call is allowed**
(`count <= p_limit`) or `false` when the limit is exceeded. One round trip,
atomic under concurrency because the increment is inside the `on conflict`
update.

Called from `api/_lib/dblimit.js` as a PostgREST RPC with the secret key:

```
POST {SUPABASE_URL}/rest/v1/rpc/bump_rate_limit
{ "p_bucket": "trial:<sub>", "p_window_seconds": 3600, "p_limit": 6 }
```

The design's calls: `bump_rate_limit('trial:' || sub, 3600, 6)` and
`bump_rate_limit('trial:ip:' || ip24, 3600, 20)` on `POST
/api/trial/eligibility`. Exceeding the limit answers `trial: false`, HTTP 200
— the buy button still works (§5.3).

**Grants:** `EXECUTE` revoked from `anon`, `authenticated` **and `PUBLIC`**;
granted to `service_role`. The `PUBLIC` revoke is the migration's one addendum
beyond the design's §3.2 — without it, Postgres's default `PUBLIC` execute
grant would have let any holder of the publishable key call the RPC and fill a
named bucket, denying a real customer their trial.

### 4.2 `public.handle_new_user()` — trigger `on_auth_user_created`

`after insert on auth.users`, `security definer`, `search_path = ''`. Inserts
`profiles (id, email)` with `on conflict (id) do nothing`. This is the only
code path that creates a profile.

### 4.3 `public.touch_updated_at()` — triggers `*_touch`

`before update` on `profiles`, `subscriptions` and `trial_claims` — the three
tables that carry `updated_at`. Sets `new.updated_at = now()`. The other six
tables have no `updated_at` and no touch trigger.

---

## 5. Retention (§3.4) — `api/cron/retention.js`, weekly, `0 4 * * 1`

Every rule, the exact statement, and the reason. The job is owned by task 3
(`api/cron/retention.js`) and authenticated by `CRON_SECRET`.

| # | Statement | Why |
|---|---|---|
| 1 | `update public.webhook_events set payload = null where received_at < now() - interval '30 days' and payload is not null and status = 'processed'` | Payloads are the evidence for a failed event that still needs replaying. **Only `processed` rows lose theirs** (draft 1 nulled every payload at 30 days and destroyed exactly the evidence that mattered). |
| 2 | `delete from public.webhook_events where received_at < now() - interval '180 days' and status = 'processed'` | Processed rows are kept 180 days for disputes, then dropped. Failed and ignored rows are never auto-deleted. |
| 3 | `update public.trial_claims set outcome = 'expired' where outcome = 'reserved' and reserved_until < now()` | An abandoned checkout must not burn the trial. `expired` is the one outcome the ladder treats as "no trial used". |
| 4 | `delete from public.checkout_intents where expires_at < now() - interval '7 days'` | Reservations are 30 minutes; a week is ample for late webhooks and support. |
| 5 | `update public.subscriptions set status = 'expired' where status <> 'expired' and access_until < now() - interval '7 days'` | The local `expired` status. `access_until` is left unchanged (already past). |
| 6 | `delete from public.trial_claims where claimed_at < now() - interval '24 months'` | **A real ceiling, not "indefinitely."** The hash is pseudonymised personal data (we hold the pepper). 24 months is longer than anyone's patience for trial-hopping and short enough to defend (§11.4). |
| 7 | `delete from public.devices where coalesce(trial_consumed_at, last_seen_at) < now() - interval '24 months'` | Same ceiling for the device half, measured from last activity. |
| 8 | `delete from public.rate_limits where window_start < now() - interval '2 days'` | Windows are seconds to hours long; two days is generous. |
| 9 | `delete from public.embed_credentials where expires_at < now() - interval '30 days'` | An expired credential is dead weight after a month; the row is dropped. Groups (`embed_tokens`) are never auto-deleted. |

**Stated retention, as the privacy policy will phrase it (§11.4):** account
data while the account exists plus 30 days; invoices at the merchant of
record, not with us; webhook payloads 30 days (processed rows only), rows 180
days; `trial_claims` and `devices` 24 months from last activity — "otherwise
deleting an account would reset the free-trial limit".

---

## 6. Reconciliation (§3.4) — `api/cron/reconcile.js`, hourly, `17 * * * *`

Owned by task 5 (`api/cron/reconcile.js`), authenticated by `CRON_SECRET`.

1. For every `subscriptions` row with `needs_reconcile = true`, **or** touched
   by a `webhook_events` row with `status = 'failed'`, **or** whose
   `access_until` is in the past while `status in ('trialing','active')`:
   call `provider.getSubscription()`, rewrite authoritative state through the
   same §6.5 mapping, clear the flag.
2. Re-drive `webhook_events` rows with `status = 'failed'` and `attempts < 10`,
   oldest first, capped at 50 per run.
3. Emit a console error (visible in Vercel logs) for anything still failed
   after 10 attempts, and for any `subscriptions` row with `user_id is null and
   detached_at is null` — a true orphan.

Together with the webhook handler's non-2xx-on-failure and the state-machine
claim, this is what makes a failed event recoverable instead of silently lost
(§6.1).

---

## 7. Queries the owner will actually run (§12)

Server-side facts (conversions, renewals, declines, refunds, chargebacks) are
never sent to GA4. They live here.

```sql
-- trial-to-paid conversion, trials started 30-60 days ago
select count(*) filter (where outcome = 'converted')::float
     / nullif(count(*) filter (where outcome in ('converted','cancelled','expired')), 0) as conversion
from public.trial_claims
where claimed_at between now() - interval '60 days' and now() - interval '30 days';

-- retained, paying subscribers right now (the number the $2,000/month goal is about)
select plan, count(*) from public.subscriptions
where status in ('active','trialing') and access_until > now() group by 1;

-- monthly churn: cancellations as a share of the base
select date_trunc('month', canceled_at) as m, count(*) from public.subscriptions
where canceled_at is not null group by 1 order by 1 desc limit 6;

-- one subscriber serving outsized embed volume (the D2 signal)
select token_id, verify_count_30d from public.embed_tokens order by 2 desc limit 10;

-- anything the webhook pipeline has not finished with
select provider, event_id, event_type, status, attempts, error, received_at
from public.webhook_events where status <> 'processed' order by received_at desc;

-- true orphans: a subscription with no account and no detachment record
select id, provider, provider_subscription_id, status, created_at
from public.subscriptions where user_id is null and detached_at is null;
```

Owner checklist step 18: watch the first ten signups by hand in
`subscriptions`, `webhook_events` and `checkout_intents`. Any `webhook_events`
row not `processed`, any orphan, and any `trial_price_without_reservation`
error is a bug to fix before volume.

---

## 8. Account deletion — what happens to each table (§11.5)

`POST /api/account/delete`, in this order, because a deletion that silently
leaves billing running is the worst possible outcome:

1. **Refuse** if `subscriptions.dispute_open` or a `past_due` balance stands.
2. If a subscription is live, cancel it at the provider **and verify the
   cancellation returned** before touching Supabase.
3. **Detach** the subscription rows: `user_id = null`, `detached_at = now()`,
   provider ids kept. (The FK's `on delete set null` would null `user_id`
   anyway; the explicit step is what stamps `detached_at`, so the row is not
   mistaken for an orphan.)
4. Delete the `auth.users` row → cascades `profiles`, `checkout_intents`,
   `embed_tokens` and, through it, `embed_credentials`.
5. Null `trial_claims.user_id` and `devices.trial_user_id`; keep the hashes
   until the 24-month ceiling, so the person cannot take a second trial by
   deleting and re-creating the account.
6. Tell the user that the merchant of record holds its own copy as a separate
   controller.

**Caveat on `profiles.email`.** It is copied once, at creation. If a user
changes their email in Supabase Auth, the profile copy goes stale and the
last-resort webhook join (§6.3 step 3) could miss. The design has no email-
change flow, so this is a documented limitation, not a live defect; if one is
added later, add an `after update of email on auth.users` trigger in a new
migration.

---

## 9. What is deliberately not in this schema

- **No card data.** No number, expiry or CVV ever reaches us; the merchant of
  record holds the payment method. `display_amount` / `display_currency` are
  the only money columns and they are the provider's stated figure, never ours.
- **No fingerprint.** No column holds timezone, screen metrics, UA-CH or any
  browser characteristic. §5.2 deleted fingerprinting; there is nothing to
  store.
- **No licence keys, activations, seats or domain counts.** The one-plan model
  has none.
- **No raw email in the trial ledger.** Only the peppered HMAC.
- **No analytics.** GA4 events are client-side and consent-gated; nothing
  here is exported to it.
- **No RLS policies.** See § 2.
