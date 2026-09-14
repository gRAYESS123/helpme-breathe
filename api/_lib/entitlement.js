/**
 * api/_lib/entitlement.js — subscription rows -> tier, and the signed v3 token.
 *
 * Specification: docs/private/ACCOUNTS_BILLING_DESIGN.md §6.5 (the mapping),
 * §7.1 (GET /api/me) and §7.2 (token v3). Owner decisions D1 and D3 apply.
 * There is one plan — monthly or yearly billing of the same thing — so no
 * plan-shaped branch survives in here beyond the enum itself.
 *
 * Two pure functions carry the whole rule set:
 *
 *   accessUntilFor(row, now)       — column 2 of the §6.5 table: what a webhook
 *                                    writes into `subscriptions.access_until`
 *                                    for a given status. The webhook handler
 *                                    (api/webhooks/mor.js) is the ONLY writer;
 *                                    it calls this so the formula lives once.
 *
 *   entitlementFor(rows, now)      — columns 3 and 4: the effective entitlement
 *                                    for a user, from `access_until` as STORED.
 *                                    "A user's effective entitlement is the
 *                                    maximum access_until across all their
 *                                    subscription rows, together with the
 *                                    status of the row that produced that
 *                                    maximum." Nothing here re-derives access
 *                                    from statuses and dates (§3.1).
 *
 * Plus the token: buildEntitlementPayload() / signEntitlement() /
 * verifyEntitlementToken(), and the two Set-Cookie strings /api/me emits.
 *
 * Zero dependencies. Nothing in this file touches the network.
 */

import { kidFor, signToken, verifyToken } from './crypto.js';

export const TIER_PRO = 'pro';
export const TIER_FREE = 'free';

/** `subscriptions.plan` values (§3.2). One plan, billed monthly or yearly. */
export const PLANS = Object.freeze(['monthly', 'yearly']);

/** `subscriptions.status` values: the provider's five plus the local `expired`. */
export const STATUSES = Object.freeze(['trialing', 'active', 'past_due', 'paused', 'canceled', 'expired']);

/** Statuses under which the merchant of record may still charge the card. */
export const LIVE_STATUSES = Object.freeze(['trialing', 'active', 'past_due', 'paused']);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** §6.5: `active` access runs 48 h past the period end to cover renewal-webhook lag. */
export const ACTIVE_LAG_MS = 48 * HOUR_MS;
/** §6.5: a paying subscriber whose card fails keeps access for 7 days. */
export const PAST_DUE_GRACE_MS = 7 * DAY_MS;
/** §7.2: a token lives at most 14 days. That IS the offline grace; there is none past `exp`. */
export const TOKEN_MAX_AGE_MS = 14 * DAY_MS;
/** §7.2: `exp` is capped at `access_until + 24h`. */
export const TOKEN_ACCESS_SLACK_MS = 24 * HOUR_MS;

/** Cookie names (§5.1, §7.1). */
export const ENT_COOKIE = '__Host-hmb_ent';
export const DEVICE_COOKIE = '__Host-hmb_did';
export const ENT_COOKIE_MAX_AGE = 1209600; // 14 days
export const DEVICE_COOKIE_MAX_AGE = 63072000; // 2 years

/* ------------------------------------------------------------------ time --- */

/**
 * Milliseconds since epoch for a timestamptz value from PostgREST (ISO string),
 * a Date, or a number. `null` when absent or unparseable.
 * @param {unknown} value
 * @returns {number|null}
 */
export function toMs(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * ISO-8601 for a millisecond timestamp, or `null`.
 * @param {number|null} ms
 * @returns {string|null}
 */
export function toIso(ms) {
  return ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

function nowMs(now) {
  const value = toMs(now);
  return value == null ? Date.now() : value;
}

/* --------------------------------------------------- §6.5 column 2 ---------- */

/**
 * What `access_until` must be set to for a row in a given status — §6.5,
 * column 2, one branch per row of the table.
 *
 * Returns milliseconds since epoch, or `null` for "no access" (`expired` keeps
 * whatever it already holds; a status this function does not know grants
 * nothing, which is the safe default).
 *
 * @param {object} row a `subscriptions` row (or the normalised event about to be written)
 * @param {number|string|Date} [now]
 * @returns {number|null}
 */
export function accessUntilFor(row, now) {
  if (!row || typeof row !== 'object') return null;
  const at = nowMs(now);
  const status = String(row.status || '');

  switch (status) {
    case 'trialing':
      // `trial_ends_at`
      return toMs(row.trial_ends_at);

    case 'active': {
      // `current_period_end + 48h` — the 48 h covers renewal-webhook lag.
      const end = toMs(row.current_period_end);
      return end == null ? null : end + ACTIVE_LAG_MS;
    }

    case 'past_due': {
      const since = toMs(row.past_due_since) ?? at;
      if (row.ever_paid === true) {
        // least(past_due_since + 7d, coalesce(current_period_end, past_due_since) + 7d)
        const periodEnd = toMs(row.current_period_end) ?? since;
        return Math.min(since + PAST_DUE_GRACE_MS, periodEnd + PAST_DUE_GRACE_MS);
      }
      // Never paid (declined at trial conversion): coalesce(trial_ends_at, now()).
      // No grace — a zero-balance card must not turn 3 trial days into 10.
      return toMs(row.trial_ends_at) ?? at;
    }

    case 'paused':
      // Frozen at the value the last paid period set. Stripe keeps rolling
      // `current_period_end` forward during a pause (invoices are voided, not
      // skipped), so re-deriving from it would hand out the whole pause free.
      // A pause stops the next charge; it neither takes away nor adds days.
      return toMs(row.access_until) ?? toMs(row.current_period_end) ?? at;

    case 'canceled':
      // coalesce(cancel_at, canceled_at)
      return toMs(row.cancel_at) ?? toMs(row.canceled_at);

    case 'expired':
      // unchanged (past)
      return toMs(row.access_until);

    default:
      return null;
  }
}

/* ----------------------------------------------- §6.5 columns 3 and 4 ------- */

/**
 * The user-facing status vocabulary. `none` when there is no row at all.
 * @param {object|null} row
 * @returns {string}
 */
function statusOf(row) {
  if (!row) return 'none';
  const status = String(row.status || '');
  return STATUSES.includes(status) ? status : 'none';
}

/**
 * Pick the row that produces the maximum `access_until`. A row whose
 * `access_until` is null never wins over one that has a value; among rows that
 * all lack one, the most recently updated wins so `/account` still shows the
 * right status. Ties on `access_until` go to the row with the later
 * `last_event_at` / `updated_at`, then to the earlier position.
 *
 * @param {object[]} rows
 * @returns {object|null}
 */
export function winningRow(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let best = null;
  let bestAccess = null;
  let bestTouched = null;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const access = toMs(row.access_until);
    const touched = toMs(row.last_event_at) ?? toMs(row.updated_at) ?? toMs(row.created_at) ?? 0;
    if (best === null) {
      best = row;
      bestAccess = access;
      bestTouched = touched;
      continue;
    }
    if (access == null && bestAccess != null) continue;
    if (access != null && bestAccess == null) {
      best = row;
      bestAccess = access;
      bestTouched = touched;
      continue;
    }
    if (access != null && bestAccess != null && access !== bestAccess) {
      if (access > bestAccess) {
        best = row;
        bestAccess = access;
        bestTouched = touched;
      }
      continue;
    }
    if (touched > bestTouched) {
      best = row;
      bestAccess = access;
      bestTouched = touched;
    }
  }
  return best;
}

/**
 * The effective entitlement for one user — §6.5 columns 3 and 4 as data.
 *
 * Reads `access_until` exactly as stored; never recomputes it. A row with no
 * `access_until` grants nothing (the safe choice when a webhook has not yet
 * written it).
 *
 * @param {object[]|null|undefined} rows every `subscriptions` row for the user
 * @param {number|string|Date} [now]
 * @returns {{
 *   tier:'pro'|'free', status:string, plan:string|null,
 *   trial_ends_at:string|null, current_period_end:string|null, cancel_at:string|null,
 *   access_until:string|null, access_until_ms:number|null,
 *   next_charge:{amount:string|null, currency:string|null, tax_inclusive:boolean|null, at:string|null}|null,
 *   provider:string|null, provider_subscription_id:string|null, provider_customer_id:string|null,
 *   ever_paid:boolean, had_trial:boolean, dispute_open:boolean, ui:string, row:object|null
 * }}
 */
export function entitlementFor(rows, now) {
  const at = nowMs(now);
  const row = winningRow(rows);
  const status = statusOf(row);
  const accessMs = row ? toMs(row.access_until) : null;
  const live = accessMs != null && at < accessMs;
  const tier = live ? TIER_PRO : TIER_FREE;
  const plan = row && PLANS.includes(String(row.plan)) ? String(row.plan) : null;

  const trialEndsMs = row ? toMs(row.trial_ends_at) : null;
  const periodEndMs = row ? toMs(row.current_period_end) : null;
  const cancelAtMs = row ? (toMs(row.cancel_at) ?? toMs(row.canceled_at)) : null;

  return {
    tier,
    status,
    plan,
    trial_ends_at: toIso(trialEndsMs),
    current_period_end: toIso(periodEndMs),
    cancel_at: toIso(cancelAtMs),
    access_until: toIso(accessMs),
    access_until_ms: accessMs,
    next_charge: nextChargeFor(row, status, live, { trialEndsMs, periodEndMs }),
    provider: row && row.provider ? String(row.provider) : null,
    provider_subscription_id: row && row.provider_subscription_id ? String(row.provider_subscription_id) : null,
    provider_customer_id: row && row.provider_customer_id ? String(row.provider_customer_id) : null,
    ever_paid: Boolean(row && row.ever_paid),
    had_trial: Boolean(row && row.had_trial),
    dispute_open: Boolean(row && row.dispute_open),
    ui: uiTextFor(status, live, { trialEndsMs, periodEndMs, cancelAtMs, accessMs, everPaid: Boolean(row && row.ever_paid) }),
    row,
  };
}

/**
 * `next_charge` for /api/me (§7.1). Amount and currency come from
 * `subscriptions.display_*` — what the provider stated to this customer —
 * and are `null` until the first confirmed transaction. Never a constant.
 */
function nextChargeFor(row, status, live, dates) {
  if (!row) return null;
  const amount = row.display_amount == null ? null : String(row.display_amount);
  const currency = row.display_currency == null ? null : String(row.display_currency);
  const taxInclusive = typeof row.display_tax_inclusive === 'boolean' ? row.display_tax_inclusive : null;

  let atMs = null;
  if (status === 'trialing') atMs = dates.trialEndsMs;
  else if (status === 'active') atMs = toMs(row.next_billed_at) ?? dates.periodEndMs;
  else if (status === 'paused') atMs = toMs(row.resume_at);
  else if (status === 'past_due') atMs = null; // dunning; the provider decides when it retries
  if (!live && status !== 'paused') atMs = null;

  return { amount, currency, tax_inclusive: taxInclusive, at: toIso(atMs) };
}

/**
 * Column 4 of §6.5 as a machine key the UI maps to copy. The wording itself
 * lives in the page (task 6); this is just which sentence applies.
 */
function uiTextFor(status, live, dates) {
  switch (status) {
    case 'trialing':
      return live ? 'trial_ends' : 'trial_over';
    case 'active':
      return live ? 'active_renews' : 'lapsed';
    case 'past_due':
      // Never paid: the trial ended and the card was declined — one sentence
      // whether or not the trial's last hours are still running. Ever paid:
      // the banner runs while the 7-day grace does; after it, access has lapsed.
      if (!dates.everPaid) return 'past_due_declined_at_trial';
      return live ? 'past_due_grace' : 'lapsed';
    case 'paused':
      return live ? 'paused_resumes' : 'paused_period_over';
    case 'canceled':
      return live ? 'canceled_until' : 'canceled';
    case 'expired':
      return 'no_active_subscription';
    default:
      return 'no_subscription';
  }
}

/* ------------------------------------------------------------ token v3 ----- */

/**
 * Build the v3 entitlement payload (§7.2).
 *
 *   exp = min(iat + 14 days, access_until + 24h)  when the tier is pro
 *   exp = iat + 14 days                            for a free token (grants nothing)
 *
 * @param {{
 *   sub:string, tier:'pro'|'free', status?:string, plan?:string|null,
 *   accessUntilMs?:number|null, periodEndMs?:number|null, kid:string, now?:number
 * }} input
 * @returns {{v:3, typ:'ent', sub:string, tier:string, st:string, plan:string|null, pe:number, iat:number, exp:number, kid:string}}
 */
export function buildEntitlementPayload(input) {
  if (!input || typeof input.sub !== 'string' || !input.sub) {
    throw new TypeError('buildEntitlementPayload: sub (the Supabase user id) is required.');
  }
  if (typeof input.kid !== 'string' || !input.kid) {
    throw new TypeError('buildEntitlementPayload: kid is required.');
  }
  const at = nowMs(input.now);
  const iat = Math.floor(at / 1000);
  const tier = input.tier === TIER_PRO ? TIER_PRO : TIER_FREE;
  const maxExp = iat + Math.floor(TOKEN_MAX_AGE_MS / 1000);
  let exp = maxExp;
  const accessMs = toMs(input.accessUntilMs);
  if (tier === TIER_PRO && accessMs != null) {
    exp = Math.min(maxExp, Math.floor((accessMs + TOKEN_ACCESS_SLACK_MS) / 1000));
  }
  const pe = toMs(input.periodEndMs);
  return {
    v: 3,
    typ: 'ent',
    sub: input.sub,
    tier,
    st: typeof input.status === 'string' && input.status ? input.status : 'none',
    plan: input.plan && PLANS.includes(String(input.plan)) ? String(input.plan) : null,
    pe: pe == null ? 0 : Math.floor(pe / 1000),
    iat,
    exp,
    kid: input.kid,
  };
}

/**
 * Sign an entitlement for a user from their computed entitlement.
 * @param {{sub:string, entitlement:object, secret:string, now?:number, kid?:string}} input
 * @returns {Promise<{token:string, payload:object}>}
 */
export async function signEntitlement(input) {
  const { sub, entitlement, secret } = input;
  if (!secret) throw new TypeError('signEntitlement: secret is required.');
  const kid = input.kid || (await kidFor(secret));
  const payload = buildEntitlementPayload({
    sub,
    tier: entitlement.tier,
    status: entitlement.status,
    plan: entitlement.plan,
    accessUntilMs: entitlement.access_until_ms,
    periodEndMs: toMs(entitlement.trial_ends_at) ?? toMs(entitlement.current_period_end),
    kid,
    now: input.now,
  });
  const token = await signToken(payload, secret);
  return { token, payload };
}

/**
 * Verify a v3 entitlement token. No grace past `exp` — the 14 days IS the grace.
 *
 * `typ: 'ent'` is the only token type there is.
 *
 * @param {string} token
 * @param {string} secret
 * @param {{now?:number, expectedKid?:string}} [options]
 * @returns {Promise<{ok:boolean, payload:object|null, reason:string}>}
 *   reason adds `bad_type` to verifyToken()'s list.
 */
export async function verifyEntitlementToken(token, secret, options = {}) {
  const result = await verifyToken(token, secret, {
    now: options.now,
    expectedKid: options.expectedKid,
    allowExpired: false,
  });
  if (!result.ok) return result;
  const payload = result.payload;
  if (payload.v !== 3 || payload.typ !== 'ent' || typeof payload.sub !== 'string' || !payload.sub) {
    return { ok: false, payload, reason: 'bad_type' };
  }
  return result;
}

/* --------------------------------------------------------------- cookies --- */

/**
 * `Set-Cookie` for the entitlement token. Deliberately NOT HttpOnly (§7.1):
 * js/entitlements.js reads it offline after Safari sweeps localStorage.
 * @param {string} token
 * @returns {string}
 */
export function entitlementCookie(token) {
  return `${ENT_COOKIE}=${token}; Path=/; Secure; SameSite=Lax; Max-Age=${ENT_COOKIE_MAX_AGE}`;
}

/** `Set-Cookie` that clears the entitlement token — the only job of /api/account/signout. */
export function clearEntitlementCookie() {
  return `${ENT_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * `Set-Cookie` for the MAC'd device id (§5.1). HttpOnly: script gets the value
 * from the JSON body instead, as the localStorage mirror.
 * @param {string} value `<uuid>.<base64url mac>`
 * @returns {string}
 */
export function deviceCookie(value) {
  return `${DEVICE_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${DEVICE_COOKIE_MAX_AGE}`;
}

/**
 * Read one cookie from a request's Cookie header.
 * @param {Request|{headers:Headers}} request
 * @param {string} name
 * @returns {string} '' when absent
 */
export function readCookie(request, name) {
  const header = request && request.headers ? request.headers.get('cookie') : '';
  if (!header) return '';
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

/**
 * The bearer token from an Authorization header, or ''.
 * @param {Request|{headers:Headers}} request
 * @returns {string}
 */
export function bearerToken(request) {
  const header = request && request.headers ? request.headers.get('authorization') : '';
  if (!header) return '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : '';
}

/* --------------------------------------------------------- data access ----- */

/**
 * The narrow set of reads and writes this task needs, over `db()` from
 * api/_lib/supabase.js (PostgREST over fetch, secret key, RLS bypassed).
 *
 * `db(path, { method?, body?, prefer? })` contract (api/_lib/supabase.js):
 * `path` is the part after `/rest/v1/`; the promise resolves to the parsed
 * JSON body (an array for reads and for `Prefer: return=representation`
 * writes, `null` for a 204) and REJECTS with a SupabaseError on any non-2xx. Every handler here does its own
 * authorization by hand: the user id always comes from the verified JWT.
 *
 * @param {(path:string, options?:object) => Promise<any>} db
 */
export function createStore(db) {
  if (typeof db !== 'function') throw new TypeError('createStore(db): db must be a function.');
  const uuid = (value) => {
    const text = String(value == null ? '' : value);
    if (!/^[0-9a-f-]{36}$/i.test(text)) throw new TypeError('createStore: not a uuid.');
    return text;
  };
  const asArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);

  return {
    /** Every subscriptions row for a user, live-flag agnostic (the webhook gate already filtered). */
    async subscriptionsFor(userId) {
      return asArray(await db(`subscriptions?user_id=eq.${uuid(userId)}&select=*&order=created_at.asc`));
    },
    async profileFor(userId) {
      const rows = asArray(await db(`profiles?id=eq.${uuid(userId)}&select=*&limit=1`));
      return rows[0] || null;
    },
    /** §11.5 step 3: detach, never cascade. Provider ids are kept. */
    async detachSubscriptions(userId, nowIso) {
      return asArray(
        await db(`subscriptions?user_id=eq.${uuid(userId)}&select=id,provider,provider_subscription_id`, {
          method: 'PATCH',
          prefer: 'return=representation',
          // Only the marker: `user_id` is cleared by `on delete set null` when
          // the auth user goes, so a failed deletion leaves the rows attached
          // and the whole request retryable.
          body: { detached_at: nowIso },
        }),
      );
    },
    /** §11.5 step 5: keep the hashes, drop the link to the deleted user. */
    async unlinkTrialLedger(userId) {
      const id = uuid(userId);
      await db(`trial_claims?user_id=eq.${id}`, { method: 'PATCH', prefer: 'return=minimal', body: { user_id: null } });
      await db(`devices?trial_user_id=eq.${id}`, { method: 'PATCH', prefer: 'return=minimal', body: { trial_user_id: null } });
    },
  };
}
