/**
 * js/entitlements.js — the ONLY module in the codebase that knows tiers exist.
 *
 * ⚠️  FUNCTIONAL STUB. The Pro agent replaces this file. The exported API below
 *     is the contract every other module codes against, so it must not change.
 *
 * What this stub does today:
 *   - reads the licence token from localStorage['hmb.license']
 *   - decodes the base64url JSON payload before the '.' (it does NOT verify the
 *     HMAC signature — that check belongs in the real implementation, which will
 *     re-verify server-side via /api/entitlement)
 *   - treats the tier as valid while `exp + 14 days` of offline grace has not
 *     passed; after that it falls back to free
 *   - activate(key) POSTs { key } to /api/license and stores the returned { token }
 *
 * Token shape (API agent owns the issuer):
 *   base64url(JSON payload) + '.' + base64url(HMAC-SHA256)
 *   payload = { v:1, tier, sub, iat, exp, kid, act, dom? }
 *
 * Never log, track or transmit a full licence key.
 */

const STORAGE_KEY = 'hmb.license';
const GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const TIERS = ['free', 'pro', 'practitioner', 'studio'];

/** @type {{tier:string, exp:number, payload:object|null, token:string|null}} */
let state = { tier: 'free', exp: 0, payload: null, token: null };

/** @type {Set<Function>} */
const listeners = new Set();

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

function evaluate(token) {
  const payload = parseToken(token);
  if (!payload) return { tier: 'free', exp: 0, payload: null, token: token || null };

  const tier = TIERS.includes(payload.tier) ? payload.tier : 'free';
  // `exp` is seconds since epoch (the API agent issues it that way).
  const expSeconds = Number(payload.exp) || 0;
  const expMs = expSeconds > 1e11 ? expSeconds : expSeconds * 1000;
  const stillValid = expMs > 0 && Date.now() < expMs + GRACE_MS;
  return {
    tier: stillValid ? tier : 'free',
    exp: expMs,
    payload,
    token: token || null,
  };
}

function notify() {
  for (const cb of listeners) {
    try {
      cb(tier(), { exp: state.exp, payload: state.payload });
    } catch {
      /* a broken listener must not break the app */
    }
  }
}

function refreshFromStorage() {
  const before = state.tier;
  state = evaluate(readToken());
  if (state.tier !== before) notify();
  return state.tier;
}

refreshFromStorage();

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
 * module can react; callers should not build their own tier checks.
 * @param {string} featureName
 * @returns {boolean}
 */
export function requirePro(featureName) {
  if (isPro()) return true;
  document.dispatchEvent(new CustomEvent('hmb:paywall', { detail: { feature: String(featureName || '') } }));
  return false;
}

/**
 * Exchange a licence key for a signed token.
 * @param {string} key
 * @returns {Promise<{ok:boolean, tier?:string, error?:string}>}
 */
export async function activate(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return { ok: false, error: 'Enter your licence key.' };
  try {
    const response = await fetch('/api/license', {
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
    if (!response.ok || !data || !data.token) {
      const error = (data && data.error) || 'That key could not be verified. Check it and try again.';
      return { ok: false, error };
    }
    writeToken(data.token);
    refreshFromStorage();
    return { ok: true, tier: tier() };
  } catch {
    return { ok: false, error: 'Could not reach the licence server. Check your connection and try again.' };
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

// Another tab activating a licence should light this one up too.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event && event.key === STORAGE_KEY) refreshFromStorage();
  });
}
