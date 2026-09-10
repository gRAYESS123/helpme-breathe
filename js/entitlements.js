/**
 * js/entitlements.js — the ONLY module in the codebase that knows tiers exist.
 *
 * Every paid feature gate on the site calls `requirePro(feature)` from here.
 * Nothing else may read the licence token, and nothing else may decide what a
 * visitor is allowed to use. That is what makes swapping the merchant of record
 * a one-file change (js/config.js) instead of a rewrite.
 *
 * How validation works, in order:
 *
 *   1. Read the token from localStorage['hmb.license'].
 *   2. Decode the base64url payload in front of the '.' — locally, without
 *      verifying the signature. Local decoding is a convenience, never a
 *      security boundary: the real check is the HMAC verification the server
 *      does in /api/license and /api/entitlement.
 *   3. While `exp` has not passed, the payload's tier applies.
 *   4. Past `exp` but inside the 14-day offline grace window, the tier is KEPT
 *      (so a plane, a tunnel or a provider outage never locks a paying customer
 *      out of what they bought) and one silent refresh is attempted in the
 *      background: POST /api/entitlement { token, key? }. It never blocks, never
 *      throws, and a failure changes nothing. The same refresh runs inside the
 *      token's last week — or the second half of its life, whichever is
 *      shorter — so it renews before it can lapse at all.
 *   5. Past `exp` + 14 days, the tier falls back to free.
 *
 * The buyer's licence key is stored alongside the token at
 * localStorage['hmb.license.key']. The refresh endpoint can only re-check with
 * the merchant of record when it is handed the key, because the token carries
 * only a one-way hash of it — without the key a lifetime buyer would have to
 * paste it again every six weeks. It never leaves this module except in a
 * request body to /api/license or /api/entitlement.
 *
 * Token shape (the API agent owns the issuer):
 *   base64url(JSON payload) + '.' + base64url(HMAC-SHA256)
 *   payload = { v:1, tier, sub, iat, exp, kid, act, dom? }   // exp in seconds
 *
 * Never log, track or transmit a full licence key.
 */

const STORAGE_KEY = 'hmb.license';
const KEY_STORAGE_KEY = 'hmb.license.key';
const GRACE_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Renew silently once the token is inside its last week, before it can lapse —
 * but never earlier than halfway through its own life. `/api/entitlement`
 * rechecks on `min(7 days, half the token's lifetime)`, and a 7-day
 * subscription token is *always* inside its last week, so a flat 7-day rule
 * here would fire a refresh on every single page load for every subscriber and
 * get the cheap "same token back" answer every time. Matching the server's
 * arithmetic means the request only goes out when it can actually do something.
 */
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
const TIERS = ['free', 'pro', 'practitioner', 'studio'];

const LICENSE_ENDPOINT = '/api/license';
const ENTITLEMENT_ENDPOINT = '/api/entitlement';

/** @type {{tier:string, exp:number, payload:object|null, token:string|null, grace:boolean}} */
let state = { tier: 'free', exp: 0, payload: null, token: null, grace: false };

/** @type {Set<Function>} */
const listeners = new Set();

/** One silent refresh per page load, at most. */
let refreshAttempted = false;

const hasWindow = typeof window !== 'undefined';
const hasDocument = typeof document !== 'undefined';

function readToken() {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeToken(token) {
  try {
    if (token) window.localStorage.setItem(STORAGE_KEY, token);
    else window.localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * The buyer's own licence key, kept in their own browser.
 *
 * Tokens are short-lived on purpose (30 days for a lifetime licence, 7 for a
 * subscription) so a cancellation self-expires with no revocation list. The
 * refresh endpoint can only re-check with the merchant of record when it is
 * given the key itself, because the token carries a one-way hash of it. Without
 * this, a lifetime buyer would have to paste their key again every six weeks.
 *
 * It is written here, read here, sent only to /api/license and /api/entitlement,
 * and removed by deactivate(). It is never logged, never tracked, and never put
 * in a URL.
 */
function readKey() {
  try {
    return window.localStorage.getItem(KEY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeKey(key) {
  try {
    if (key) window.localStorage.setItem(KEY_STORAGE_KEY, key);
    else window.localStorage.removeItem(KEY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Decode base64url -> UTF-8 string. Returns null on anything malformed. */
function decodeSegment(segment) {
  try {
    const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice((b64.length + 3) % 4);
    const binary = window.atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Parse a token into its payload without verifying the signature.
 * Read-only helper for this module's own UI. Never use it as a gate —
 * `requirePro()` is the only gate.
 * @param {string|null} token
 * @returns {object|null}
 */
export function parseToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const json = decodeSegment(token.slice(0, dot));
  if (!json) return null;
  try {
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/** `exp` is issued in seconds; accept milliseconds too rather than locking someone out. */
function expiryMs(payload) {
  const raw = Number(payload && payload.exp) || 0;
  if (raw <= 0) return 0;
  return raw > 1e11 ? raw : raw * 1000;
}

function evaluate(token) {
  const payload = parseToken(token);
  if (!payload) return { tier: 'free', exp: 0, payload: null, token: token || null, grace: false };

  const claimed = TIERS.includes(payload.tier) ? payload.tier : 'free';
  const expMs = expiryMs(payload);
  const now = Date.now();
  const fresh = expMs > 0 && now < expMs;
  const inGrace = expMs > 0 && !fresh && now < expMs + GRACE_MS;

  return {
    tier: fresh || inGrace ? claimed : 'free',
    exp: expMs,
    payload,
    token: token || null,
    grace: inGrace,
  };
}

function notify() {
  for (const cb of listeners) {
    try {
      cb(state.tier, { exp: state.exp, payload: state.payload });
    } catch {
      /* a broken listener must not break the app */
    }
  }
}

function refreshFromStorage() {
  const before = state.tier;
  state = evaluate(readToken());
  if (state.tier !== before) notify();
  maybeSilentRefresh();
  return state.tier;
}

/* --------------------------------------------------------- silent refresh */

/**
 * Ask the server for a fresh token, in the background.
 *
 * It runs in two situations: inside the last week of the token's life (so it is
 * renewed before it can lapse) and past `exp` while the 14-day offline grace is
 * still holding the tier up. Fire-and-forget: it never blocks a caller, never
 * throws, and never shows an error. A cancelled subscription simply fails to
 * refresh and expires on its own when the grace window runs out — no revocation
 * list, no owner action.
 */
function renewWindowMs(payload, expMs) {
  const iat = Number(payload && payload.iat) || 0;
  const iatMs = iat > 1e11 ? iat : iat * 1000;
  const lifetime = iatMs > 0 && expMs > iatMs ? expMs - iatMs : 0;
  if (!lifetime) return RENEW_BEFORE_MS;
  return Math.min(RENEW_BEFORE_MS, Math.floor(lifetime / 2));
}

function maybeSilentRefresh() {
  if (refreshAttempted) return;
  if (!state.token) return;
  const window_ = renewWindowMs(state.payload, state.exp);
  const due = state.grace || (state.exp > 0 && Date.now() > state.exp - window_);
  if (!due) return;
  if (!hasWindow || typeof fetch !== 'function') return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  refreshAttempted = true;

  const token = state.token;
  const key = readKey();
  const run = () => {
    Promise.resolve()
      .then(() =>
        fetch(ENTITLEMENT_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(key ? { token, key } : { token }),
        }),
      )
      .then((response) => (response && response.ok ? response.json() : null))
      .then((data) => {
        if (!data || data.ok === false || typeof data.token !== 'string' || !data.token) return;
        if (data.token === token) return;
        writeToken(data.token);
        const before = state.tier;
        state = evaluate(data.token);
        if (state.tier !== before) notify();
      })
      .catch(() => {
        /* offline, blocked, provider down — the grace window covers it */
      });
  };

  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 4000 });
  else window.setTimeout(run, 1200);
}

if (hasWindow) refreshFromStorage();

/* --------------------------------------------------------------- public API */

/** 'free' | 'pro' | 'practitioner' | 'studio'. */
export function tier() {
  return state.tier;
}

/** True for pro, practitioner and studio. */
export function isPro() {
  return state.tier === 'pro' || state.tier === 'practitioner' || state.tier === 'studio';
}

/** True for practitioner and studio. */
export function isPractitioner() {
  return state.tier === 'practitioner' || state.tier === 'studio';
}

/**
 * Gate a paid feature. Returns true when the visitor may use it. When it
 * returns false it dispatches `hmb:paywall` with `{ feature }` so the paywall
 * module can explain the offer. **The only gate any feature may use.**
 * @param {string} featureName
 * @returns {boolean}
 */
export function requirePro(featureName) {
  if (isPro()) return true;
  if (hasDocument) {
    document.dispatchEvent(
      new CustomEvent('hmb:paywall', { detail: { feature: String(featureName || '') } }),
    );
  }
  return false;
}

/**
 * Exchange a licence key for a signed token and store it.
 *
 * `error` is a finished sentence from `/api/license`, meant to be shown to the
 * buyer as-is. `code` is the machine-readable reason beside it (`pack_only`,
 * `activation_limit`, `unrecognised_key`, …) so a page can add a friendlier
 * branch; it is absent when the failure never reached the server.
 *
 * @param {string} key the licence key, or a provider transaction reference
 * @returns {Promise<{ok:boolean, tier?:string, error?:string, code?:string}>}
 */
export async function activate(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return { ok: false, error: 'Enter your licence key.', code: 'missing_key' };
  if (typeof fetch !== 'function') {
    return { ok: false, error: 'This browser cannot reach the licence server.', code: 'no_fetch' };
  }
  try {
    const response = await fetch(LICENSE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: trimmed }),
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok || !data || data.ok === false || !data.token) {
      const error =
        (data && data.error) || 'That key could not be verified. Check it and try again.';
      const code = data && typeof data.code === 'string' ? data.code : 'rejected';
      return { ok: false, error, code };
    }
    writeToken(data.token);
    writeKey(trimmed);
    refreshAttempted = false;
    refreshFromStorage();
    if (!isPro()) {
      return {
        ok: false,
        error: 'That key is no longer active. Email contact@helpmebreath.com and we will sort it out.',
        code: 'inactive_token',
      };
    }
    return { ok: true, tier: tier() };
  } catch {
    return {
      ok: false,
      error: 'Could not reach the licence server. Check your connection and try again.',
      code: 'network',
    };
  }
}

/**
 * Re-read the stored token (after another tab activated, or on demand).
 * @returns {string} the tier after the re-read
 */
export function restore() {
  return refreshFromStorage();
}

/** Remove the stored licence from this browser and drop to free. */
export function deactivate() {
  writeToken(null);
  writeKey(null);
  refreshAttempted = false;
  refreshFromStorage();
}

/**
 * Subscribe to tier changes. Returns an unsubscribe function.
 * @param {(tier:string, info:{exp:number, payload:object|null}) => void} cb
 * @returns {() => void}
 */
export function onChange(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Everything the UI is allowed to know about the stored licence. Safe to
 * render: it contains no licence key and no email address.
 *
 * @returns {{
 *   tier:string, isPro:boolean, isPractitioner:boolean, hasLicense:boolean,
 *   exp:number, expiresAt:string|null, inGrace:boolean, graceEndsAt:string|null,
 *   canRenewSilently:boolean, activations:number|null, reference:string|null,
 *   keyId:string|null, domains:string[]|null, issuedAt:string|null
 * }}
 */
export function getLicenseInfo() {
  const p = state.payload || {};
  const expDate = state.exp ? new Date(state.exp) : null;
  const graceDate = state.exp ? new Date(state.exp + GRACE_MS) : null;
  const issued = Number(p.iat) || 0;
  const issuedMs = issued > 1e11 ? issued : issued * 1000;
  return {
    tier: state.tier,
    isPro: isPro(),
    isPractitioner: isPractitioner(),
    hasLicense: !!state.token,
    exp: state.exp,
    expiresAt: expDate ? expDate.toISOString() : null,
    inGrace: state.grace,
    graceEndsAt: graceDate ? graceDate.toISOString() : null,
    canRenewSilently: !!readKey(),
    activations: Number.isFinite(Number(p.act)) ? Number(p.act) : null,
    reference: typeof p.sub === 'string' ? p.sub : null,
    keyId: typeof p.kid === 'string' ? p.kid : null,
    domains: Array.isArray(p.dom) ? p.dom.slice() : null,
    issuedAt: issuedMs ? new Date(issuedMs).toISOString() : null,
  };
}

// Another tab activating a licence should light this one up too.
if (hasWindow) {
  window.addEventListener('storage', (event) => {
    if (event && event.key === STORAGE_KEY) refreshFromStorage();
  });
}
