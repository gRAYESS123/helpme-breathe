/**
 * api/_lib/trialguard.js — the trial lock: email hash, MAC'd device cookie,
 * the decision ladder, the 30-minute reservation, and the free-session counter.
 *
 * Specification: docs/private/ACCOUNTS_BILLING_DESIGN.md §5.1–§5.4 and §13.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN
 *
 *   There is no fingerprint. No canvas, no WebGL, no audio, no screen metrics,
 *   no UA-CH, no client-posted "signals", no consent interstitial (§5.2). The
 *   only two identifiers are:
 *
 *     1. `email_hash = HMAC-SHA256(TRIAL_PEPPER, normalizeEmail(email))`,
 *        computed HERE, on the server, from the email on the verified session.
 *     2. `__Host-hmb_did`, a server-set first-party cookie whose value is
 *        `<uuid v4>.<base64url(HMAC-SHA256(DEVICE_PEPPER, uuid))>`. A value whose
 *        MAC does not verify is never looked up and never resurrected; a fresh
 *        id is minted instead (§5.1).
 *
 *   Request headers (IP, UA) are used as a rate-limit dimension only and are
 *   never stored, never hashed and never used as a dedupe key.
 *
 * NOTHING THE BROWSER SENDS IS AUTHORITATIVE
 *
 *   The request body is `{ plan, device_mirror }` and nothing else. The user id
 *   comes from the verified session, the price id is chosen here from
 *   `(plan, trial)`, and the browser only ever receives an opaque
 *   `reservation_id` and the provider's `transaction_id` — never a price id.
 *
 * FAIL BEHAVIOUR (§5.3, narrowed)
 *
 *   A trial-ledger failure yields `trial: false` with `reasons: ['ledger_unavailable']`
 *   and an alert — never `trial: true`. The no-trial checkout is still created,
 *   so a database blip costs the buyer nothing but the trial and costs us no
 *   signup. A provider customer-lookup failure drops layer 6 and continues.
 *
 * DEPENDENCY INJECTION
 *
 *   Everything that touches the network is injected: `ledger` (built by
 *   `createLedger()` on top of the PostgREST helper in api/_lib/supabase.js),
 *   `dblimit`, `provider`, `now`. That is what lets tools/trialguard.test.mjs
 *   exercise every branch offline, and what keeps this file free of any
 *   provider name (§10.1).
 */

import { b64urlEncode, hmacSha256, timingSafeEqual } from './crypto.js';

// --------------------------------------------------------------- constants --

/** The device cookie. `__Host-` prefix: Secure, Path=/, no Domain. */
export const DEVICE_COOKIE = '__Host-hmb_did';

/** Two years, in seconds. */
export const DEVICE_COOKIE_MAX_AGE = 63072000;

/** How long a granted trial is held for while the buyer is in the overlay. */
export const RESERVATION_MINUTES = 30;

/** The plans the server accepts. D2 = `one` ships without a practitioner price. */
export const PLANS = Object.freeze(['monthly', 'yearly', 'practitioner_yearly']);

/** Which env var holds the provider price id for each (plan, trial) pair. */
export const PRICE_ENV = Object.freeze({
  monthly: Object.freeze({ trial: 'MOR_PRICE_MONTHLY_TRIAL', paid: 'MOR_PRICE_MONTHLY' }),
  yearly: Object.freeze({ trial: 'MOR_PRICE_YEARLY_TRIAL', paid: 'MOR_PRICE_YEARLY' }),
  practitioner_yearly: Object.freeze({ trial: '', paid: 'MOR_PRICE_PRACTITIONER' }),
});

/** Machine-readable reasons a trial is refused (§5.4). The list is closed. */
export const REASONS = Object.freeze({
  EMAIL_USED: 'email_used',
  DEVICE_USED: 'device_used',
  ALREADY_SUBSCRIBED: 'already_subscribed',
  TRIAL_DISABLED: 'trial_disabled',
  RATE_LIMITED: 'rate_limited',
  LEDGER_UNAVAILABLE: 'ledger_unavailable',
});

/** Soft signals (§5.3 layers 4–6). Any two together refuse the trial. */
export const SOFT = Object.freeze({
  DEVICE_SEEN: 'device_seen',
  FORGED_DEVICE: 'forged_device',
  CUSTOMER_EXISTS: 'customer_exists',
});

/** Which public reason a soft signal maps onto when two of them combine. */
const SOFT_TO_REASON = Object.freeze({
  [SOFT.DEVICE_SEEN]: REASONS.DEVICE_USED,
  [SOFT.FORGED_DEVICE]: REASONS.DEVICE_USED,
  [SOFT.CUSTOMER_EXISTS]: REASONS.EMAIL_USED,
});

/** Trial-claim outcomes that count as "this address has had its trial". */
const CONSUMED_OUTCOMES = new Set(['started', 'converted', 'cancelled', 'refunded', 'chargeback']);

/** Upper bound on the free-session counter so a runaway client cannot grow a row forever. */
export const FREE_SESSIONS_CAP = 100000;

// ------------------------------------------------------------------ email ---

const GMAIL_FAMILY = new Set(['gmail.com', 'googlemail.com']);

/**
 * IDNA-fold a domain to its ASCII (punycode) form using the WHATWG URL parser,
 * which applies UTS #46 processing. Anything the parser refuses is returned
 * lowercased and otherwise untouched — the hash is still deterministic.
 * @param {string} domain
 * @returns {string}
 */
export function foldDomain(domain) {
  const text = String(domain == null ? '' : domain).trim().toLowerCase().replace(/\.+$/, '');
  if (!text) return '';
  try {
    const host = new URL(`http://${text}/`).hostname;
    if (host && !host.includes('/')) return host.replace(/\.+$/, '');
  } catch {
    // fall through
  }
  return text;
}

/**
 * Canonical form of an email address for the trial ledger (§5.4 step 4).
 *
 *   - trim, lowercase
 *   - IDNA-fold the domain
 *   - gmail / googlemail: strip dots and `+tag` in the local part, and fold
 *     googlemail.com onto gmail.com (Google delivers both to one mailbox, so
 *     treating them as one address is the safer choice for a one-per-person rule)
 *
 * Deliberately NOT done: sub-addressing for other domains, disposable-domain
 * blocklists (§13: they are wrong often enough to lose real customers).
 *
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeEmail(input) {
  const text = String(input == null ? '' : input).trim().toLowerCase();
  const at = text.lastIndexOf('@');
  if (at <= 0 || at === text.length - 1) return text;
  let local = text.slice(0, at);
  let domain = foldDomain(text.slice(at + 1));
  if (GMAIL_FAMILY.has(domain)) {
    domain = 'gmail.com';
    const plus = local.indexOf('+');
    if (plus !== -1) local = local.slice(0, plus);
    local = local.replace(/\./g, '');
  }
  return `${local}@${domain}`;
}

/**
 * The peppered one-way hash of an email address. Raw 32 bytes.
 * @param {string} email
 * @param {string} pepper TRIAL_PEPPER
 * @returns {Promise<Uint8Array>}
 */
export async function emailHash(email, pepper) {
  if (!pepper || typeof pepper !== 'string') {
    throw new TypeError('emailHash(email, pepper): TRIAL_PEPPER is required.');
  }
  return hmacSha256(pepper, normalizeEmail(email));
}

/**
 * Postgres bytea literal in hex input format, e.g. `\x0a1b…`. This is the
 * string PostgREST accepts for a bytea column both in a JSON body and in an
 * `eq.` filter.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function byteaLiteral(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, '0');
  return `\\x${hex}`;
}

/**
 * `emailHash()` as the bytea literal the ledger stores and filters on.
 * @param {string} email
 * @param {string} pepper
 * @returns {Promise<string>}
 */
export async function emailHashLiteral(email, pepper) {
  return byteaLiteral(await emailHash(email, pepper));
}

// ----------------------------------------------------------------- device ---

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAC_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_DEVICE_VALUE_LENGTH = 36 + 1 + 43;

/**
 * A fresh device id. Never derived from anything the browser sent.
 * @returns {string} lowercase uuid v4
 */
export function mintDeviceId() {
  return globalThis.crypto.randomUUID();
}

/**
 * Sign a device id into the cookie value `uuid.mac`.
 * @param {string} uuid
 * @param {string} pepper DEVICE_PEPPER
 * @returns {Promise<string>}
 */
export async function signDeviceId(uuid, pepper) {
  if (!pepper || typeof pepper !== 'string') {
    throw new TypeError('signDeviceId(uuid, pepper): DEVICE_PEPPER is required.');
  }
  if (!UUID_V4_RE.test(String(uuid))) throw new TypeError('signDeviceId: uuid must be a lowercase uuid v4.');
  return `${uuid}.${b64urlEncode(await hmacSha256(pepper, uuid))}`;
}

/**
 * Verify a cookie or mirror value. Shape is checked before any crypto so a
 * garbage value costs nothing.
 *
 * @param {unknown} value
 * @param {string} pepper
 * @returns {Promise<{ok:boolean, deviceId:string|null, reason:string}>}
 *   reason: ok | missing | malformed | bad_mac
 */
export async function verifyDeviceValue(value, pepper) {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, deviceId: null, reason: 'missing' };
  if (value.length !== MAX_DEVICE_VALUE_LENGTH) return { ok: false, deviceId: null, reason: 'malformed' };
  const dot = value.indexOf('.');
  if (dot !== 36) return { ok: false, deviceId: null, reason: 'malformed' };
  const uuid = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!UUID_V4_RE.test(uuid) || !MAC_RE.test(mac)) return { ok: false, deviceId: null, reason: 'malformed' };
  if (!pepper) return { ok: false, deviceId: null, reason: 'bad_mac' };
  const expected = b64urlEncode(await hmacSha256(pepper, uuid));
  if (!timingSafeEqual(mac, expected)) return { ok: false, deviceId: null, reason: 'bad_mac' };
  return { ok: true, deviceId: uuid, reason: 'ok' };
}

/**
 * Parse a Cookie request header. Values are not URL-decoded: ours never need it.
 * @param {string|null|undefined} header
 * @returns {Map<string,string>}
 */
export function parseCookies(header) {
  const out = new Map();
  const text = String(header == null ? '' : header);
  if (!text) return out;
  for (const part of text.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

/**
 * The device cookie value on a request, or ''.
 * @param {Request} request
 * @returns {string}
 */
export function readDeviceCookie(request) {
  return parseCookies(request.headers.get('cookie')).get(DEVICE_COOKIE) || '';
}

/**
 * The Set-Cookie header value for the device cookie (§5.1, verbatim).
 * @param {string} value the MAC'd `uuid.mac`
 * @returns {string}
 */
export function deviceCookieHeader(value) {
  return `${DEVICE_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${DEVICE_COOKIE_MAX_AGE}`;
}

/**
 * The rate-limit bucket for an IP: /24 for IPv4, /48 for IPv6. Used only as a
 * bucket key, never stored (§5.3 layer 7).
 * @param {string} ip
 * @returns {string}
 */
export function ipBucket(ip) {
  const text = String(ip == null ? '' : ip).trim();
  if (!text || text === 'unknown') return 'unknown';
  if (text.includes(':')) {
    const groups = expandIpv6(text);
    if (!groups) return 'unknown';
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  const parts = text.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return 'unknown';
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

function expandIpv6(text) {
  const clean = text.replace(/^\[|\]$/g, '').split('%')[0];
  const halves = clean.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const groups = [...head, ...new Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => g.toLowerCase().padStart(4, '0'));
}

/**
 * Resolve the device for a request per the §5.1 table.
 *
 *   cookie verifies, row exists        -> use it
 *   cookie verifies, no row            -> insert with that id
 *   cookie present but fails/malformed -> never resurrect; a verified mirror
 *                                         may still be used, else mint
 *   no cookie, mirror verifies         -> accept it (Safari-sweep repair)
 *   no cookie, mirror fails            -> mint, and flag `forged_device`
 *   no cookie, no mirror               -> mint
 *
 * A verified id whose `trial_consumed_at` is set is never discarded in favour
 * of a newer one: when both the cookie and the mirror verify and name different
 * rows, the consumed one wins.
 *
 * `readOnly: true` (the GET beacon) never writes: no row is inserted for a
 * minted or unknown id and `seen_count` is not bumped, so a crawler hitting
 * GET /api/session/count without a cookie cannot grow the devices table. The
 * MAC'd value is still returned so the cookie exists; the row is inserted on
 * the first POST, which is the "cookie verifies, no row" path above.
 *
 * @param {{
 *   cookie?:string, mirror?:unknown, pepper:string, now?:number, readOnly?:boolean,
 *   ledger:{ findDevice:(id:string)=>Promise<object|null>, insertDevice:(row:object)=>Promise<object|null>, touchDevice:(id:string, patch:object)=>Promise<unknown> }
 * }} input
 * @returns {Promise<{deviceId:string, value:string, row:object, minted:boolean, forged:boolean, persisted:boolean, source:'cookie'|'mirror'|'minted'}>}
 */
export async function resolveDevice(input) {
  const { cookie = '', mirror, pepper, ledger, readOnly = false } = input;
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const nowIso = new Date(now).toISOString();

  const candidates = [];
  const cookieCheck = cookie ? await verifyDeviceValue(cookie, pepper) : { ok: false, reason: 'missing' };
  if (cookieCheck.ok) candidates.push({ id: cookieCheck.deviceId, value: cookie, source: 'cookie' });

  let forged = false;
  if (typeof mirror === 'string' && mirror.length > 0) {
    const mirrorCheck = await verifyDeviceValue(mirror, pepper);
    if (mirrorCheck.ok) {
      if (!candidates.some((c) => c.id === mirrorCheck.deviceId)) {
        candidates.push({ id: mirrorCheck.deviceId, value: mirror, source: 'mirror' });
      }
    } else if (!cookieCheck.ok) {
      // No trustworthy cookie and a mirror that is not ours: one soft signal.
      forged = true;
    }
  }

  let chosen = null;
  let row = null;
  if (candidates.length > 0) {
    const rows = [];
    for (const candidate of candidates) {
      const found = await ledger.findDevice(candidate.id);
      rows.push({ candidate, row: found || null });
    }
    // Prefer a consumed row; among consumed rows, the one with the most trials
    // then the earliest consumption. Otherwise the cookie wins over the mirror.
    const consumed = rows
      .filter((r) => r.row && r.row.trial_consumed_at)
      .sort((a, b) => {
        const byCount = (Number(b.row.trial_count) || 0) - (Number(a.row.trial_count) || 0);
        if (byCount !== 0) return byCount;
        return Date.parse(a.row.trial_consumed_at) - Date.parse(b.row.trial_consumed_at);
      });
    const pick = consumed[0] || rows[0];
    chosen = pick.candidate;
    row = pick.row;
  }

  let minted = false;
  if (!chosen) {
    const id = mintDeviceId();
    chosen = { id, value: await signDeviceId(id, pepper), source: 'minted' };
    minted = true;
  }

  let persisted = Boolean(row);
  if (!row) {
    const fresh = {
      device_id: chosen.id,
      first_seen_at: nowIso,
      last_seen_at: nowIso,
      seen_count: 1,
      free_sessions_used: 0,
      trial_count: 0,
    };
    if (readOnly) {
      row = fresh;
    } else {
      row = (await ledger.insertDevice(fresh)) || fresh;
      persisted = true;
    }
  } else if (!readOnly) {
    const seen = (Number(row.seen_count) || 0) + 1;
    await ledger.touchDevice(chosen.id, { last_seen_at: nowIso, seen_count: seen });
    row = { ...row, last_seen_at: nowIso, seen_count: seen };
  }

  return { deviceId: chosen.id, value: chosen.value, row, minted, forged, persisted, source: chosen.source };
}

// ---------------------------------------------------------------- ladder ----

/**
 * Does an existing trial_claims row block this user (§5.3 layer 1)?
 *
 *   outcome 'expired'                          -> no
 *   outcome 'reserved', reserved_until passed  -> no (stale; overwritten)
 *   outcome 'reserved', live, same user        -> no (the same person retrying;
 *                                                 the live intent is reused)
 *   outcome 'reserved', live, other user       -> yes
 *   anything else (started, converted, …)      -> yes
 *
 * @param {object|null} claim
 * @param {string} userId
 * @param {number} now ms
 * @returns {boolean}
 */
export function claimBlocks(claim, userId, now) {
  if (!claim) return false;
  const outcome = String(claim.outcome || '');
  if (outcome === 'expired') return false;
  if (outcome === 'reserved') {
    const until = Date.parse(claim.reserved_until || '');
    if (!Number.isFinite(until) || until <= now) return false;
    if (claim.user_id && userId && claim.user_id === userId) return false;
    return true;
  }
  // started, converted, cancelled, refunded, chargeback — and anything
  // unrecognised, which is the safer reading of a row we did not expect.
  if (!CONSUMED_OUTCOMES.has(outcome)) console.warn('[trial] unexpected trial_claims.outcome; treating as consumed:', outcome);
  return true;
}

/**
 * The decision ladder (§5.3). Pure. Each layer may only downgrade the offer.
 *
 * @param {{
 *   trialEnabled?:boolean,
 *   claim?:object|null,             // trial_claims row for this email_hash
 *   subscriptionExists?:boolean,    // layer 2
 *   device?:object|null,            // devices row for the verified device
 *   deviceReservedByOther?:boolean, // a live reservation on this device for another email
 *   forged?:boolean,                // layer 5
 *   customerExists?:boolean,        // layer 6
 *   userId?:string,
 *   now?:number
 * }} input
 * @returns {{trial:boolean, reasons:string[], soft:string[]}}
 */
export function decide(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  if (input.trialEnabled === false) return { trial: false, reasons: [REASONS.TRIAL_DISABLED], soft: [] };

  const reasons = [];
  const soft = [];

  // Hard signals.
  if (claimBlocks(input.claim || null, input.userId, now)) reasons.push(REASONS.EMAIL_USED);
  if (input.subscriptionExists) reasons.push(REASONS.ALREADY_SUBSCRIBED);
  const device = input.device || null;
  if (device && (Number(device.trial_count) || 0) >= 2) reasons.push(REASONS.DEVICE_USED);
  if (input.deviceReservedByOther && !reasons.includes(REASONS.DEVICE_USED)) reasons.push(REASONS.DEVICE_USED);

  // Soft signals.
  if (device && device.trial_consumed_at) soft.push(SOFT.DEVICE_SEEN);
  if (input.forged) soft.push(SOFT.FORGED_DEVICE);
  if (input.customerExists) soft.push(SOFT.CUSTOMER_EXISTS);

  if (reasons.length > 0) return { trial: false, reasons, soft };
  if (soft.length >= 2) {
    const mapped = [];
    for (const signal of soft) {
      const reason = SOFT_TO_REASON[signal];
      if (reason && !mapped.includes(reason)) mapped.push(reason);
    }
    return { trial: false, reasons: mapped, soft };
  }
  return { trial: true, reasons: [], soft };
}

/**
 * Pick the provider price id server-side from (plan, trial). Prefers the
 * adapter's own `priceIdFor` when the adapter implements contract v3, else the
 * MOR_PRICE_* env vars. Returns '' when the price is not configured, which the
 * caller turns into a 503 rather than a guess.
 *
 * @param {{plan:string, trial:boolean}} choice
 * @param {Record<string,string>} env
 * @param {object} [provider]
 * @returns {string}
 */
export function priceIdFor(choice, env, provider) {
  const plan = String(choice.plan || '');
  const trial = choice.trial === true;
  if (provider && typeof provider.priceIdFor === 'function') {
    try {
      const fromAdapter = provider.priceIdFor({ plan, trial }, env);
      if (fromAdapter) return String(fromAdapter);
    } catch {
      // fall back to the env map
    }
  }
  const names = PRICE_ENV[plan];
  if (!names) return '';
  const name = trial ? names.trial : names.paid;
  if (!name) return '';
  return String((env && env[name]) || '').trim();
}

/**
 * Is this plan sellable given the configured prices? `practitioner_yearly`
 * exists only when MOR_PRICE_PRACTITIONER is set (D2 = `two`).
 * @param {string} plan
 * @param {Record<string,string>} env
 * @param {object} [provider]
 * @returns {boolean}
 */
export function planAvailable(plan, env, provider) {
  if (!PLANS.includes(plan)) return false;
  return priceIdFor({ plan, trial: false }, env, provider) !== '';
}

// ---------------------------------------------------------------- ledger ----

/**
 * Build the ledger on top of a PostgREST request function.
 *
 * `request(method, path, { body, prefer })` must return the parsed JSON body
 * (an array for selects, an array or object for `return=representation`,
 * `null` for 204) and THROW on any non-2xx status or network failure. Throwing
 * is load-bearing: `runEligibility` catches it and fails closed on the trial.
 *
 * `path` is relative to `/rest/v1/`, query string included.
 *
 * @param {(method:string, path:string, options?:{body?:unknown, prefer?:string})=>Promise<any>} request
 * @returns {object} the ledger interface used by resolveDevice / runEligibility / runSessionCount
 */
export function createLedger(request) {
  const first = (rows) => (Array.isArray(rows) ? rows[0] || null : rows && typeof rows === 'object' ? rows : null);
  const q = (params) => new URLSearchParams(params).toString();

  return {
    async findClaim(emailHashLit) {
      const rows = await request(
        'GET',
        `trial_claims?${q({
          select: 'email_hash,outcome,reserved_until,user_id,device_id,claimed_at',
          email_hash: `eq.${emailHashLit}`,
          limit: '1',
        })}`,
      );
      return first(rows);
    },

    async userHasSubscription(userId) {
      const rows = await request('GET', `subscriptions?${q({ select: 'id', user_id: `eq.${userId}`, limit: '1' })}`);
      return Array.isArray(rows) ? rows.length > 0 : Boolean(rows);
    },

    async findDevice(deviceId) {
      const rows = await request(
        'GET',
        `devices?${q({
          select:
            'device_id,first_seen_at,last_seen_at,seen_count,free_sessions_used,trial_reserved_until,trial_consumed_at,trial_count,trial_user_id',
          device_id: `eq.${deviceId}`,
          limit: '1',
        })}`,
      );
      return first(rows);
    },

    async insertDevice(row) {
      const out = await request('POST', 'devices', { body: row, prefer: 'return=representation' });
      return first(out) || row;
    },

    async touchDevice(deviceId, patch) {
      return request('PATCH', `devices?${q({ device_id: `eq.${deviceId}` })}`, {
        body: patch,
        prefer: 'return=minimal',
      });
    },

    async findLiveClaimForDevice(deviceId, nowIso) {
      const rows = await request(
        'GET',
        `trial_claims?${q({
          select: 'email_hash,outcome,reserved_until,user_id,device_id',
          device_id: `eq.${deviceId}`,
          outcome: 'eq.reserved',
          reserved_until: `gt.${nowIso}`,
          limit: '1',
        })}`,
      );
      return first(rows);
    },

    async reserveClaim(row) {
      const out = await request('POST', `trial_claims?${q({ on_conflict: 'email_hash' })}`, {
        body: row,
        prefer: 'resolution=merge-duplicates,return=representation',
      });
      return first(out) || row;
    },

    async findLiveIntent({ userId, plan, nowIso }) {
      const rows = await request(
        'GET',
        `checkout_intents?${q({
          select: 'reservation_id,plan,trial_granted,price_id,provider,provider_transaction_id,provider_customer_id,expires_at,reasons',
          user_id: `eq.${userId}`,
          plan: `eq.${plan}`,
          trial_granted: 'is.true',
          consumed_at: 'is.null',
          expires_at: `gt.${nowIso}`,
          provider_transaction_id: 'not.is.null',
          order: 'created_at.desc',
          limit: '1',
        })}`,
      );
      return first(rows);
    },

    async insertIntent(row) {
      const out = await request('POST', 'checkout_intents', { body: row, prefer: 'return=representation' });
      return first(out) || row;
    },

    async updateIntent(reservationId, patch) {
      return request('PATCH', `checkout_intents?${q({ reservation_id: `eq.${reservationId}` })}`, {
        body: patch,
        prefer: 'return=minimal',
      });
    },
  };
}

// ------------------------------------------------------------ eligibility --

/**
 * Default alert sink: a console error, which Vercel surfaces in the function
 * logs. The handler may inject a mailer once ALERT_EMAIL delivery exists.
 * @param {string} kind
 * @param {Record<string,unknown>} detail never contains an email, a hash or a pepper
 */
function defaultAlert(kind, detail) {
  console.error(`[trial] ALERT ${kind}`, JSON.stringify(detail || {}));
}

function isoPlusMinutes(now, minutes) {
  return new Date(now + minutes * 60 * 1000).toISOString();
}

/**
 * Best-effort, never throws.
 * @param {object} provider
 * @param {{priceId:string, countryCode:string}} args
 * @param {object} ctx
 */
async function previewPrice(provider, args, ctx) {
  if (!provider || typeof provider.pricePreview !== 'function' || !args.priceId) return null;
  try {
    const out = await provider.pricePreview(args, ctx);
    if (!out || typeof out !== 'object') return null;
    return {
      amount: out.amount == null ? null : String(out.amount),
      currency: out.currency == null ? null : String(out.currency),
      tax_inclusive: out.taxInclusive === true,
      formatted: out.formatted == null ? null : String(out.formatted),
    };
  } catch {
    return null;
  }
}

/**
 * POST /api/trial/eligibility, minus the HTTP plumbing (§5.4).
 *
 * Runs the eleven steps in order: rate limit (Postgres), device, email hash,
 * D3 flag, ladder, reservation, price, intent, provider customer, provider
 * transaction, response. Returns what the handler needs to build the response.
 *
 * @param {{
 *   sub:string, email:string, plan:string,
 *   cookie?:string, mirror?:unknown, ip?:string, countryCode?:string,
 *   trialEnabled:boolean,
 *   env:Record<string,string>,          // TRIAL_PEPPER, DEVICE_PEPPER, MOR_PRICE_*, provider vars
 *   ledger:object,                      // createLedger()
 *   dblimit:(bucket:string, windowSeconds:number, limit:number)=>Promise<boolean>,
 *   provider:object,                    // the merchant-of-record adapter
 *   providerCtx?:object,                // passed to every adapter call
 *   now?:number, alert?:(kind:string, detail:object)=>void
 * }} input
 * @returns {Promise<{status:number, body:object, cookieValue:string|null}>}
 */
export async function runEligibility(input) {
  const {
    sub,
    email,
    plan,
    cookie = '',
    mirror,
    ip = 'unknown',
    countryCode = '',
    trialEnabled,
    env,
    ledger,
    dblimit,
    provider,
  } = input;
  const alert = typeof input.alert === 'function' ? input.alert : defaultAlert;
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const nowIso = new Date(now).toISOString();
  const providerCtx = input.providerCtx || { env, fetchImpl: globalThis.fetch, sub };

  if (!sub || !email) return { status: 401, body: { ok: false, reason: 'unauthenticated' }, cookieValue: null };
  if (!planAvailable(plan, env, provider)) {
    return { status: 400, body: { ok: false, error: 'bad_plan', plans: PLANS.filter((p) => planAvailable(p, env, provider)) }, cookieValue: null };
  }
  if (!env.TRIAL_PEPPER || !env.DEVICE_PEPPER) {
    return { status: 503, body: { ok: false, error: 'not_configured' }, cookieValue: null };
  }

  // A plan with no trial price configured (practitioner_yearly under D2, or a
  // missing MOR_PRICE_*_TRIAL) never offers a trial. Decided before the
  // ladder so no reservation is ever written for a trial that cannot be sold.
  const trialOffered = trialEnabled === true && priceIdFor({ plan, trial: true }, env, provider) !== '';

  const reasons = [];
  let soft = [];
  let trial = false;
  let ledgerFailed = false;
  let intentWritten = false;
  let device = null;
  let hashLit = null;
  let reusedIntent = null;
  let customerId = null;

  // Steps 2–6 touch the ledger. Any failure here fails CLOSED on the trial.
  try {
    // 2. Rate limits, in Postgres. The user bucket is bumped first so a caller
    // refused on their own budget does not also consume their network's.
    const userOk = await dblimit(`trial:${sub}`, 3600, 6);
    const ipOk = userOk === false ? true : await dblimit(`trial:ip:${ipBucket(ip)}`, 3600, 20);
    const rateLimited = userOk === false || ipOk === false;

    // 3. Device.
    device = await resolveDevice({ cookie, mirror, pepper: env.DEVICE_PEPPER, ledger, now });

    // 4. Email hash — server-side, from the verified session's email.
    hashLit = await emailHashLiteral(email, env.TRIAL_PEPPER);

    if (rateLimited) {
      reasons.push(REASONS.RATE_LIMITED);
    } else if (!trialOffered) {
      // 5. D3 off, or no trial price for this plan: no ledger reads for trial
      // purposes, no claim written.
      reasons.push(REASONS.TRIAL_DISABLED);
    } else {
      // 6. The ladder.
      const [claim, subscriptionExists, liveOnDevice] = await Promise.all([
        ledger.findClaim(hashLit),
        ledger.userHasSubscription(sub),
        ledger.findLiveClaimForDevice(device.deviceId, nowIso),
      ]);
      const deviceReservedByOther = Boolean(liveOnDevice && liveOnDevice.email_hash !== hashLit);

      // Layer 6 needs the provider customer, so it is resolved before the
      // ladder runs. A failure here drops the layer and continues (§5.3).
      let customerExists = false;
      try {
        const customer = await ensureCustomer(provider, email, providerCtx);
        customerExists = customer.existed === true;
        customerId = customer.id || null;
      } catch (error) {
        console.warn('[trial] provider customer lookup failed; layer 6 dropped:', error && error.message);
      }

      const verdict = decide({
        trialEnabled: true,
        claim,
        subscriptionExists,
        device: device.row,
        deviceReservedByOther,
        forged: device.forged,
        customerExists,
        userId: sub,
        now,
      });
      trial = verdict.trial;
      soft = verdict.soft;
      reasons.push(...verdict.reasons);

      if (trial) {
        // The same person retrying inside a live reservation gets the SAME
        // transaction back, so two tabs cannot mint two trials.
        if (claim && claim.outcome === 'reserved' && claim.user_id === sub && Date.parse(claim.reserved_until || '') > now) {
          reusedIntent = await ledger.findLiveIntent({ userId: sub, plan, nowIso });
        }
        if (!reusedIntent) {
          const reservedUntil = isoPlusMinutes(now, RESERVATION_MINUTES);
          await ledger.reserveClaim({
            email_hash: hashLit,
            claimed_at: nowIso,
            reserved_until: reservedUntil,
            outcome: 'reserved',
            device_id: device.deviceId,
            user_id: sub,
            provider: provider.id,
            provider_customer_id: customerId,
            provider_subscription_id: null,
          });
          await ledger.touchDevice(device.deviceId, { trial_reserved_until: reservedUntil });
        }
      }
    }
  } catch (error) {
    ledgerFailed = true;
    trial = false;
    reasons.length = 0;
    reasons.push(REASONS.LEDGER_UNAVAILABLE);
    alert('ledger_unavailable', { sub, plan, message: error && error.message ? String(error.message) : String(error) });
  }

  if (reusedIntent) {
    const price = await previewPrice(provider, { priceId: reusedIntent.price_id, countryCode }, providerCtx);
    return {
      status: 200,
      body: {
        ok: true,
        device_id: device.value,
        reservation_id: reusedIntent.reservation_id,
        trial: true,
        plan,
        checkout: { provider: provider.id, transaction_id: reusedIntent.provider_transaction_id },
        price_preview: price,
        reasons: [],
        reused: true,
      },
      cookieValue: device.value,
    };
  }

  // 7. Price, server-side, from (plan, trial).
  const priceId = priceIdFor({ plan, trial }, env, provider);
  if (!priceId) {
    return { status: 503, body: { ok: false, error: 'price_not_configured' }, cookieValue: device ? device.value : null };
  }

  // 8. The intent. Its id is minted here so it exists even if the insert fails
  // during a ledger outage (the no-trial price carries no security property).
  const reservationId = globalThis.crypto.randomUUID();
  const storedReasons = [...reasons, ...soft.map((s) => `soft:${s}`)];
  if (!ledgerFailed) {
    try {
      await ledger.insertIntent({
        reservation_id: reservationId,
        user_id: sub,
        email_hash: hashLit,
        device_id: device ? device.deviceId : null,
        plan,
        trial_granted: trial,
        price_id: priceId,
        provider: provider.id,
        reasons: storedReasons,
        created_at: nowIso,
        expires_at: isoPlusMinutes(now, RESERVATION_MINUTES),
      });
      intentWritten = true;
    } catch (error) {
      if (trial) {
        // A granted trial with no authoritative intent row cannot be honoured:
        // the webhook backstop (§6.3) would cancel it. Fall back to no trial.
        trial = false;
        reasons.push(REASONS.LEDGER_UNAVAILABLE);
        ledgerFailed = true;
      }
      alert('intent_insert_failed', { sub, plan, message: error && error.message ? String(error.message) : String(error) });
    }
  }
  const finalPriceId = trial ? priceId : priceIdFor({ plan, trial: false }, env, provider);

  // 9. Provider customer (already resolved when the ladder ran).
  if (!customerId) {
    try {
      const customer = await ensureCustomer(provider, email, providerCtx);
      customerId = customer.id || null;
    } catch (error) {
      console.warn('[trial] provider customer lookup failed:', error && error.message);
    }
  }

  // 10. Provider transaction, with custom_data = { rid, v } and nothing else.
  let transactionId = null;
  try {
    const session = await provider.createCheckoutSession(
      { priceId: finalPriceId, customerId, customData: { rid: reservationId, v: 3 } },
      providerCtx,
    );
    transactionId = session && session.transactionId ? String(session.transactionId) : null;
  } catch (error) {
    console.error('[trial] provider transaction failed:', error && error.message);
  }
  if (!transactionId) {
    return {
      status: 502,
      body: { ok: false, error: 'checkout_unavailable', reasons },
      cookieValue: device ? device.value : null,
    };
  }
  if (intentWritten) {
    try {
      await ledger.updateIntent(reservationId, {
        provider_transaction_id: transactionId,
        provider_customer_id: customerId,
        price_id: finalPriceId,
        trial_granted: trial,
      });
    } catch (error) {
      alert('intent_update_failed', { sub, reservationId, message: error && error.message ? String(error.message) : String(error) });
    }
  }

  // 11. Respond. No price id anywhere in the body.
  const price = await previewPrice(provider, { priceId: finalPriceId, countryCode }, providerCtx);
  return {
    status: 200,
    body: {
      ok: true,
      device_id: device ? device.value : null,
      reservation_id: reservationId,
      trial,
      plan,
      checkout: { provider: provider.id, transaction_id: transactionId },
      price_preview: price,
      reasons: trial ? [] : dedupe(reasons),
    },
    cookieValue: device ? device.value : null,
  };
}

async function ensureCustomer(provider, email, ctx) {
  if (!provider || typeof provider.ensureCustomer !== 'function') return { id: null, existed: false };
  const out = await provider.ensureCustomer(email, ctx);
  if (!out || typeof out !== 'object') return { id: null, existed: false };
  return { id: out.id ? String(out.id) : null, existed: out.existed === true };
}

function dedupe(list) {
  const out = [];
  for (const item of list) if (!out.includes(item)) out.push(item);
  return out;
}

// ---------------------------------------------------------- session count --

/**
 * The free-session counter beacon (D1). Resolves the device, optionally
 * increments `devices.free_sessions_used`, and returns the count. This is a
 * soft counter by design (§7.3): it never denies anything by itself; the
 * client gate reads it.
 *
 * A read (`increment: false`, the GET) never writes: an unknown or minted id
 * is handed back as a MAC'd cookie value with a count of 0 and no row, so a
 * cookieless crawler cannot fill the devices table. The row is inserted by
 * the first POST.
 *
 * @param {{
 *   cookie?:string, mirror?:unknown, increment:boolean,
 *   env:{DEVICE_PEPPER:string}, ledger:object, now?:number
 * }} input
 * @returns {Promise<{status:number, body:object, cookieValue:string|null}>}
 */
export async function runSessionCount(input) {
  const { cookie = '', mirror, increment, env, ledger } = input;
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  if (!env || !env.DEVICE_PEPPER) return { status: 503, body: { ok: false, error: 'not_configured' }, cookieValue: null };

  let device;
  try {
    device = await resolveDevice({ cookie, mirror, pepper: env.DEVICE_PEPPER, ledger, now, readOnly: increment !== true });
  } catch (error) {
    // Ledger down: still hand out a MAC'd id so the cookie exists; the row is
    // inserted on the next successful call. The client falls back to its
    // local count.
    console.warn('[session] ledger unavailable:', error && error.message);
    let value = null;
    try {
      const check = cookie ? await verifyDeviceValue(cookie, env.DEVICE_PEPPER) : { ok: false };
      value = check.ok ? cookie : await signDeviceId(mintDeviceId(), env.DEVICE_PEPPER);
    } catch {
      value = null;
    }
    return { status: 200, body: { ok: false, error: 'unavailable', device_id: value, free_sessions_used: null }, cookieValue: value };
  }

  let used = Number(device.row.free_sessions_used) || 0;
  if (increment && used < FREE_SESSIONS_CAP) {
    used += 1;
    try {
      await ledger.touchDevice(device.deviceId, { free_sessions_used: used, last_seen_at: new Date(now).toISOString() });
    } catch (error) {
      console.warn('[session] increment failed:', error && error.message);
      used -= 1;
    }
  }

  // Exactly the §5.4/§7.3 shape. Whether a mirror was forged is not reported:
  // the caller learns nothing useful from it and the minted id already answers.
  return {
    status: 200,
    body: { ok: true, device_id: device.value, free_sessions_used: used },
    cookieValue: device.value,
  };
}
