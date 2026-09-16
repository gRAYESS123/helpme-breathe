/**
 * js/entitlements.js — the ONLY module in the codebase that knows tiers exist.
 *
 * Every paid feature gate on the site calls `requirePro(feature)` from here and
 * the timer's Start calls `requireTimer()`. Nothing else may read the
 * entitlement token, and nothing else may decide what a visitor is allowed to
 * use. Rebuilt 2026-09-11 for the one-plan, one-account model
 * (docs/private/ACCOUNTS_BILLING_DESIGN.md §7.3); the licence-key model is gone.
 *
 * Preserved exactly, so no existing gate changes:
 *   tier(), isPro(), requirePro(feature), onChange(cb), restore(), parseToken(),
 *   getLicenseInfo(), and the `hmb:paywall` event.
 *
 * Removed: activate(key) and deactivate() — both keep a one-release stub that
 * logs a deprecation so a page still in a service-worker cache does not throw.
 *
 * Added: signedIn(), account(), status(), refresh({ force }),
 * requireAccount(feature), requireTimer(), readDeviceMirror(),
 * recordFreeSession(), hadLegacyLicence(), dismissLegacyNotice().
 *
 * How the entitlement is read, offline-first (§7.3):
 *
 *   1. localStorage['hmb.ent']
 *   2. if absent, the `__Host-hmb_ent` cookie (the Safari-sweep repair path —
 *      the one cookie read in js/, and it is read, never written)
 *   3. decode the payload locally, WITHOUT verifying the signature. Local
 *      decoding is a convenience, never a security boundary: the server
 *      verifies the HMAC on every request that matters.
 *   4. now < exp → the tier applies; otherwise free. There is no grace past
 *      `exp` for a v3 token: the 14 days the server puts into `exp` IS the
 *      offline grace, capped at access_until + 24h so a cancelled subscriber
 *      cannot stay offline into extra days.
 *   5. refresh when online and the token is older than 24 hours, or whenever
 *      `hmb:auth` fires. Fire-and-forget; a failure changes nothing.
 *
 * Token v3 (design §7.2): base64url(JSON) + '.' + base64url(HMAC-SHA256),
 *   { v:3, typ:'ent', sub, tier:'pro'|'free', st, plan, pe, iat, exp, kid }
 *
 * Supabase proves WHO (js/auth.js); this token proves WHAT they may do. The
 * auth module is loaded lazily and defensively: it imports supabase-js from a
 * CDN, and a blocked or offline CDN must never take the breathing timer down
 * with it. Signed-in state falls back to the last /api/me snapshot until the
 * auth module reports in. The one static import from js/auth.js is
 * `configured()`, which only reads js/config.js — js/auth.js fetches
 * supabase-js with a dynamic import of its own, so that edge adds no CDN
 * dependency to the timer pages.
 *
 * The free-session gate arms only once sign-in exists. While SUPABASE in
 * js/config.js is empty, requireTimer() lets every session through and the
 * session beacon stays off the network, so a visitor is never shown a sign-in
 * card that leads to "Accounts are not open yet".
 *
 * Storage keys: hmb.ent, hmb.ent.snapshot, hmb.did. The retired hmb.license and
 * hmb.license.key are deleted on first load (§11.1 grandfather shim).
 */

import { TIMER_FREE_SESSIONS } from './config.js';
import { completedSessionCount, getFlag, recordSessionStart, setFlag, startedSessionCount } from './storage.js';
import { track, EVENTS } from './analytics.js';
import { configured as authConfigured } from './auth.js';

const TOKEN_KEY = 'hmb.ent';
const SNAPSHOT_KEY = 'hmb.ent.snapshot';
const DEVICE_KEY = 'hmb.did';
const LEGACY_KEYS = ['hmb.license', 'hmb.license.key'];
/** Storage flag (hmb.legacy-license): a licence key was found and removed. */
const LEGACY_FLAG = 'legacy-license';

const ENT_COOKIE = '__Host-hmb_ent';
const ME_ENDPOINT = '/api/me';
const COUNT_ENDPOINT = '/api/session/count';
const AUTH_MODULE = './auth.js';

const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const TIERS = ['free', 'pro'];
const STATUSES = ['trialing', 'active', 'past_due', 'paused', 'canceled'];
const TOKEN_VERSION = 3;

const hasWindow = typeof window !== 'undefined';
const hasDocument = typeof document !== 'undefined';

/**
 * @typedef {object} EntState
 * @property {string} tier 'free' | 'pro'
 * @property {number} exp token expiry, ms
 * @property {object|null} payload decoded token payload
 * @property {string|null} token the raw token
 * @property {boolean} fresh now < exp
 */

/** @type {EntState} */
let state = { tier: 'free', exp: 0, payload: null, token: null, fresh: false };

/** The last /api/me answer minus the token, mirrored in localStorage. */
let snapshot = null;

/** @type {Set<Function>} */
const listeners = new Set();

/** The auth module once it has loaded, or null while it has not / could not. */
let auth = null;
let authLoader = null;

/** One /api/me call in flight at a time. */
let refreshInFlight = null;

/** Last beacon timestamp, so two callers on one completion count once. */
let lastBeaconAt = 0;

/* ------------------------------------------------------------- storage io */

function readItem(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(key, value) {
  try {
    if (value == null || value === '') window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Safari-sweep repair path: `__Host-hmb_ent` is server-set and exempt from
 * script-storage eviction. Read only, never written, never sent anywhere by
 * this module (the browser attaches it to same-origin requests itself).
 */
function readEntitlementCookie() {
  if (!hasDocument) return null;
  try {
    const raw = document.cookie || '';
    if (!raw) return null;
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      if (part.slice(0, eq).trim() !== ENT_COOKIE) continue;
      const value = part.slice(eq + 1).trim();
      return value ? decodeURIComponent(value) : null;
    }
  } catch {
    /* an unreadable cookie jar is the same as no cookie */
  }
  return null;
}

function readToken() {
  return readItem(TOKEN_KEY) || readEntitlementCookie();
}

function readSnapshot() {
  const raw = readItem(SNAPSHOT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeSnapshot(value) {
  snapshot = value && typeof value === 'object' ? value : null;
  writeItem(SNAPSHOT_KEY, snapshot ? JSON.stringify(snapshot) : null);
  announceAllowance();
}

/**
 * The free-session count may have moved (a start, a server read, a fresh
 * /api/me). Anything drawing the allowance re-reads `freeAllowance()` on this;
 * it carries no data of its own.
 */
function announceAllowance() {
  if (!hasDocument || typeof CustomEvent !== 'function') return;
  try {
    document.dispatchEvent(new CustomEvent('hmb:allowance'));
  } catch {
    /* a page without CustomEvent simply re-reads on the next paint */
  }
}

/* ----------------------------------------------------------------- token */

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
 * `requirePro()` and `requireTimer()` are the only gates.
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

/** Unix seconds (or, defensively, milliseconds) → milliseconds. */
function toMs(value) {
  const raw = Number(value) || 0;
  if (raw <= 0) return 0;
  return raw > 1e11 ? raw : raw * 1000;
}

/**
 * @param {string|null} token
 * @returns {EntState}
 */
function evaluate(token) {
  const payload = parseToken(token);
  const empty = { tier: 'free', exp: 0, payload: null, token: token || null, fresh: false };
  if (!payload) return empty;
  // Only an account entitlement counts. A retired v1 licence token in this
  // slot is decoded for display and ignored as a tier.
  const isEnt = Number(payload.v) === TOKEN_VERSION && (payload.typ === 'ent' || payload.typ == null);
  const claimed = isEnt && TIERS.includes(payload.tier) ? payload.tier : 'free';
  const expMs = toMs(payload.exp);
  const fresh = expMs > 0 && Date.now() < expMs;
  return { tier: fresh ? claimed : 'free', exp: expMs, payload, token: token || null, fresh };
}

/* -------------------------------------------------------------- notify */

/**
 * Stamp the current tier on <body> so CSS can respond to it — specifically so
 * a paid tier reserves no ad space at all. A presentation hint, never a gate.
 */
function stampTier() {
  if (!hasDocument) return;
  const apply = () => {
    if (document.body) document.body.dataset.tier = state.tier;
  };
  if (document.body) apply();
  else document.addEventListener('DOMContentLoaded', apply, { once: true });
}

function notify() {
  stampTier();
  for (const cb of listeners) {
    try {
      cb(state.tier, { exp: state.exp, payload: state.payload, status: status() });
    } catch {
      /* a broken listener must not break the app */
    }
  }
}

/** A short signature of what listeners care about, to notify only on change. */
function signature() {
  const acct = account();
  return [state.tier, status(), state.exp, acct ? acct.id : ''].join('|');
}

function refreshFromStorage() {
  const before = signature();
  state = evaluate(readToken());
  snapshot = readSnapshot();
  if (signature() !== before) notify();
  return state.tier;
}

/* ------------------------------------------------------------- migration */

/**
 * §11.1 grandfather shim, one release only: a licence key from the retired
 * model is removed and a flag left behind so /account and /pro can show the
 * one-time "email us with your receipt" notice.
 */
function migrateLegacyLicence() {
  let found = false;
  for (const key of LEGACY_KEYS) {
    if (readItem(key) != null) found = true;
    writeItem(key, null);
  }
  if (found) setFlag(LEGACY_FLAG, true);
}

/** True when a retired licence key was found on this browser and not yet acknowledged. */
export function hadLegacyLicence() {
  return getFlag(LEGACY_FLAG) === true;
}

/** Called by the page that showed the one-time notice. */
export function dismissLegacyNotice() {
  setFlag(LEGACY_FLAG, null);
}

/* ------------------------------------------------------------- auth glue */

function isOnline() {
  return !(typeof navigator !== 'undefined' && navigator.onLine === false);
}

/**
 * Load js/auth.js lazily for everything except `configured()`, which is the
 * one static import above. auth.js is the only module that knows Supabase
 * exists; it fetches supabase-js from a CDN behind its own dynamic import, so
 * no timer page depends on that CDN answering. If it cannot load, this module
 * behaves as "signed out until told otherwise" and the timer keeps working.
 * @returns {Promise<object|null>}
 */
function loadAuth() {
  if (auth) return Promise.resolve(auth);
  if (authLoader) return authLoader;
  if (!hasWindow) return Promise.resolve(null);
  authLoader = import(AUTH_MODULE)
    .then(async (mod) => {
      if (!mod || typeof mod.signedIn !== 'function') return null;
      try {
        if (typeof mod.ready === 'function') await mod.ready();
      } catch {
        /* an initial session read that fails is the same as signed out */
      }
      // The auth module may change the answer to signedIn(); tell gates.
      const before = signature();
      auth = mod;
      wireAuth(mod);
      if (signature() !== before) notify();
      if (signedIn()) maybeRefresh();
      return mod;
    })
    .catch(() => null);
  return authLoader;
}

function wireAuth(mod) {
  try {
    if (typeof mod.onAuthChange === 'function') mod.onAuthChange(() => onAuthEvent());
  } catch {
    /* a module without the hook still answers signedIn(); hmb:auth covers the rest */
  }
}

/**
 * Sign-in or sign-out happened in this tab. `storage` events only fire in
 * OTHER tabs, so re-read explicitly, then ask the server for the current
 * entitlement. Nothing is cleared here on our own initiative: js/auth.js
 * removes hmb.ent and hmb.ent.snapshot on sign-out, and a transient auth event
 * must never cost a subscriber their offline token.
 */
function onAuthEvent() {
  refreshFromStorage();
  if (signedIn()) refresh({ force: true });
}

function maybeRefresh() {
  if (!isOnline()) return;
  if (!signedIn()) return;
  const iat = toMs(state.payload && state.payload.iat);
  const due = !state.token || !iat || Date.now() > iat + REFRESH_AFTER_MS || !state.fresh;
  if (due) refresh();
}

/* --------------------------------------------------------- device mirror */

/**
 * The localStorage mirror of the `__Host-hmb_did` device cookie. The cookie is
 * HttpOnly, so script cannot read it; the server hands the MAC'd value back in
 * JSON so it can be re-supplied after Safari sweeps script storage. Copying
 * someone else's only ever costs you a trial; inventing one gains nothing.
 * @returns {string}
 */
export function readDeviceMirror() {
  const value = readItem(DEVICE_KEY);
  return typeof value === 'string' && /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}$/i.test(value) ? value : '';
}

function writeDeviceMirror(value) {
  if (typeof value === 'string' && value && value.length <= 200) writeItem(DEVICE_KEY, value);
}

/* ---------------------------------------------------------------- refresh */

/**
 * GET /api/me: store the token, mirror the device id, remember the snapshot,
 * notify listeners. Fire-and-forget safe: never throws, resolves to the parsed
 * body on success and null on anything else. A failure changes nothing — the
 * cached token is the fallback, by design (§5.3, "fail open").
 *
 * @param {{force?:boolean}} [options] `force` ignores the 24-hour rule.
 * @returns {Promise<object|null>}
 */
export async function refresh(options = {}) {
  const force = !!(options && options.force);
  if (!hasWindow || typeof fetch !== 'function') return null;
  if (!isOnline()) return null;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const mod = await loadAuth();
      if (!mod || !mod.signedIn()) return null;
      if (!force) {
        const iat = toMs(state.payload && state.payload.iat);
        if (state.token && state.fresh && iat && Date.now() < iat + REFRESH_AFTER_MS) return null;
      }
      const bearer = await mod.accessToken();
      if (!bearer) return null;

      const headers = { Authorization: `Bearer ${bearer}`, Accept: 'application/json' };
      const mirror = readDeviceMirror();
      if (mirror) headers['X-HMB-Device-Mirror'] = mirror;

      const response = await fetch(ME_ENDPOINT, {
        method: 'GET',
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok || !data || data.ok !== true) return null;

      if (typeof data.token === 'string' && data.token) writeItem(TOKEN_KEY, data.token);
      if (typeof data.device_id === 'string') writeDeviceMirror(data.device_id);
      writeSnapshot({
        at: Date.now(),
        user: data.user && typeof data.user === 'object' ? data.user : null,
        entitlement: data.entitlement && typeof data.entitlement === 'object' ? data.entitlement : null,
        trial: data.trial && typeof data.trial === 'object' ? data.trial : null,
        free_sessions_used: Number.isFinite(Number(data.free_sessions_used))
          ? Number(data.free_sessions_used)
          : null,
        token_exp: Number(data.token_exp) || null,
      });
      refreshFromStorage();
      return data;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/* ------------------------------------------------------ free-session count */

/**
 * The D1 counter: sessions STARTED on this device. The larger of the server's
 * figure (from /api/me, the start beacon, or the read on load) and the local
 * count — whichever remembers more. Counting only completed sessions let a
 * visitor run the timer forever by stopping early; a start is what spends a
 * free session now. Still soft on purpose: clearing every trace resets it,
 * and the alternative is a wall on a breathing timer.
 */
function freeSessionsUsed() {
  const local = Math.max(startedSessionCount(), completedSessionCount());
  const server = snapshot ? Number(snapshot.free_sessions_used) : NaN;
  if (snapshot && Number.isFinite(server) && snapshot.free_sessions_used !== null) return Math.max(server, local);
  return local;
}

/**
 * POST the free-session beacon for one STARTED session. Called from the
 * `hmb:session-start` listener below; exported so the engine may call it
 * explicitly instead. Either way, one start counts once. Skipped entirely
 * while sign-in is not configured: the gate is inert then, and
 * /api/session/count has nothing to count against.
 * @returns {Promise<number|null>} the server's count, or null
 */
export async function recordFreeSession() {
  if (!authConfigured()) return null;
  const now = Date.now();
  if (now - lastBeaconAt < 2000) return null;
  lastBeaconAt = now;
  if (!hasWindow || typeof fetch !== 'function' || !isOnline()) return null;
  try {
    const mirror = readDeviceMirror();
    const response = await fetch(COUNT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(mirror ? { device_mirror: mirror } : {}),
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok || !data) return null;
    if (typeof data.device_id === 'string') writeDeviceMirror(data.device_id);
    const count = Number(data.free_sessions_used);
    if (data.ok === true && Number.isFinite(count)) {
      writeSnapshot({ ...(snapshot || {}), free_sessions_used: count });
      return count;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A session started: spend one free session, locally and on the server. The
 * crisis pages never count (they run for anyone, forever) and a subscriber
 * has nothing to count against.
 */
function onSessionStart() {
  if (isPro()) return;
  if (hasDocument && document.body && openTimerPage()) return;
  recordSessionStart();
  announceAllowance();
  recordFreeSession();
}

/**
 * Read the device's server-side count once per page load for a signed-out
 * visitor, so the allowance survives a cleared localStorage while the device
 * cookie lives. A read never writes on the server; a failure changes nothing.
 */
function primeFreeSessionCount() {
  if (!authConfigured() || !hasWindow || typeof fetch !== 'function' || !isOnline()) return;
  if (snapshot && snapshot.user) return; // signed in: /api/me carries the count
  fetch(COUNT_ENDPOINT, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (!data || data.ok !== true) return;
      if (typeof data.device_id === 'string') writeDeviceMirror(data.device_id);
      const count = Number(data.free_sessions_used);
      if (!Number.isFinite(count)) return;
      const known = snapshot ? Number(snapshot.free_sessions_used) : NaN;
      writeSnapshot({ ...(snapshot || {}), free_sessions_used: Number.isFinite(known) ? Math.max(known, count) : count });
    })
    .catch(() => {});
}

/* --------------------------------------------------------------- public API */

/** 'free' | 'pro'. */
export function tier() {
  return state.tier;
}

/** True for a live subscription (trialing, active, paused or past-due grace). */
export function isPro() {
  return state.tier === 'pro';
}

/** True when a Supabase session exists (or, before the auth module reports in, when the last /api/me had a user). */
export function signedIn() {
  if (auth) {
    try {
      return !!auth.signedIn();
    } catch {
      return false;
    }
  }
  return !!(snapshot && snapshot.user && snapshot.user.id);
}

/** `{ id, email } | null`. Never a token. */
export function account() {
  if (auth) {
    try {
      const user = auth.user();
      if (user && user.id) return { id: String(user.id), email: user.email ? String(user.email) : null };
      return null;
    } catch {
      return null;
    }
  }
  const user = snapshot && snapshot.user;
  return user && user.id ? { id: String(user.id), email: user.email ? String(user.email) : null } : null;
}

/** 'trialing' | 'active' | 'past_due' | 'paused' | 'canceled' | 'none'. */
export function status() {
  const fromToken = state.fresh && state.payload ? state.payload.st : null;
  if (STATUSES.includes(fromToken)) return fromToken;
  const fromSnapshot = snapshot && snapshot.entitlement ? snapshot.entitlement.status : null;
  if (STATUSES.includes(fromSnapshot)) return fromSnapshot;
  return 'none';
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
 * Gate on having an account at all. True when signed in; otherwise dispatches
 * `hmb:signin` with `{ feature, next }` and returns false.
 * @param {string} featureName
 * @returns {boolean}
 */
export function requireAccount(featureName) {
  if (signedIn()) return true;
  if (hasDocument) {
    const next = hasWindow ? `${location.pathname}${location.search}` : '/';
    document.dispatchEvent(
      new CustomEvent('hmb:signin', { detail: { feature: String(featureName || ''), next } }),
    );
  }
  return false;
}

/**
 * `data-open-timer` is a safety feature, not a config knob: the two crisis
 * pages run the timer for anyone, forever.
 */
function openTimerPage() {
  const value = document.body && document.body.dataset ? document.body.dataset.openTimer : undefined;
  return value === 'true' || value === '';
}

/**
 * The free allowance as the interface may show it: `{ used, total, left }`,
 * or null when there is nothing to count down — sign-in not configured, a
 * subscriber, a crisis page. Reads TIMER_FREE_SESSIONS beside requireTimer()
 * so the count on screen and the gate can never disagree; nothing outside
 * this module branches on the number. Re-read on `hmb:allowance`.
 * @returns {{used:number, total:number, left:number}|null}
 */
export function freeAllowance() {
  if (!hasDocument) return null;
  if (openTimerPage()) return null;
  if (!authConfigured()) return null;
  if (isPro()) return null;
  const used = freeSessionsUsed();
  return { used, total: TIMER_FREE_SESSIONS, left: Math.max(0, TIMER_FREE_SESSIONS - used) };
}

/**
 * The single gate js/app.js calls on Start (design §8.1). This and
 * freeAllowance() above are the only places TIMER_FREE_SESSIONS (D1) is read.
 *
 * When it returns false the engine enters preview mode and dispatches
 * `hmb:preview` with `{ reason }`, where reason is `'signed_out'` when this
 * gate dispatched `hmb:signin` and `'no_subscription'` when it dispatched
 * `hmb:paywall` (feature `'timer'`). `context.technique` is only for analytics.
 *
 * The gate arms only once sign-in exists (SUPABASE filled in, js/auth.js
 * `configured()`). Until then every session passes, so nobody is sent to a
 * sign-in card that can only say "Accounts are not open yet".
 *
 * @param {{technique?:string}} [context]
 * @returns {boolean}
 */
export function requireTimer(context = {}) {
  if (!hasDocument) return true;
  if (openTimerPage()) return true; // crisis pages
  if (!authConfigured()) return true; // sign-in does not exist yet: nothing to gate behind
  if (isPro()) return true;
  const used = freeSessionsUsed(); // device counter, server-authoritative when online
  if (used < TIMER_FREE_SESSIONS) return true; // D1
  const reason = signedIn() ? 'no_subscription' : 'signed_out';
  track(EVENTS.TIMER_GATE_BLOCK || 'timer_gate_block', {
    technique: context && context.technique ? String(context.technique) : undefined,
    reason,
    free_sessions_used: used,
  });
  if (!signedIn()) return requireAccount('timer');
  return requirePro('timer');
}

/**
 * @deprecated Licence keys are retired. Kept for one release so a cached page
 * does not throw. Asks the server for the current account entitlement instead.
 * @returns {Promise<{ok:boolean, tier?:string, error?:string, code?:string}>}
 */
export async function activate() {
  console.warn('[entitlements] activate() is deprecated: Help Me Breathe now uses accounts.');
  await refresh({ force: true });
  if (isPro()) return { ok: true, tier: tier() };
  return {
    ok: false,
    error: 'Help Me Breathe now uses accounts. Sign in, and your subscription follows your email address.',
    code: 'deprecated',
  };
}

/**
 * @deprecated Kept for one release. Signs the account out through js/auth.js
 * when it is available and drops this browser to free.
 */
export function deactivate() {
  console.warn('[entitlements] deactivate() is deprecated: use signOut() from js/auth.js.');
  loadAuth()
    .then((mod) => (mod && typeof mod.signOut === 'function' ? mod.signOut() : null))
    .catch(() => null)
    .finally(() => {
      writeItem(TOKEN_KEY, null);
      writeSnapshot(null);
      refreshFromStorage();
    });
}

/**
 * Re-read the stored token (after another tab signed in, or on demand).
 * @returns {string} the tier after the re-read
 */
export function restore() {
  return refreshFromStorage();
}

/**
 * Subscribe to tier changes. Returns an unsubscribe function.
 * @param {(tier:string, info:{exp:number, payload:object|null, status:string}) => void} cb
 * @returns {() => void}
 */
export function onChange(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Everything the UI is allowed to know. Safe to render: no token, no bearer
 * credential. The pre-2026-09-11 fields are kept (some are always null now)
 * so existing pages keep reading the same shape.
 *
 * @returns {{
 *   tier:string, isPro:boolean, hasLicense:boolean,
 *   exp:number, expiresAt:string|null, inGrace:boolean, graceEndsAt:string|null,
 *   canRenewSilently:boolean, activations:number|null, reference:string|null,
 *   keyId:string|null, domains:string[]|null, issuedAt:string|null,
 *   status:string, plan:string|null, periodEnd:string|null,
 *   account:{id:string,email:string|null}|null, signedIn:boolean,
 *   trialAvailable:boolean|null, trialReason:string|null,
 *   nextCharge:object|null, accessUntil:string|null, freeSessionsUsed:number
 * }}
 */
export function getLicenseInfo() {
  const p = state.payload || {};
  const ent = (snapshot && snapshot.entitlement) || {};
  const expDate = state.exp ? new Date(state.exp) : null;
  const issuedMs = toMs(p.iat);
  const periodMs = toMs(p.pe);
  const plan = typeof p.plan === 'string' ? p.plan : typeof ent.plan === 'string' ? ent.plan : null;
  return {
    tier: state.tier,
    isPro: isPro(),
    hasLicense: !!state.token,
    exp: state.exp,
    expiresAt: expDate ? expDate.toISOString() : null,
    inGrace: false,
    graceEndsAt: null,
    canRenewSilently: signedIn(),
    activations: null,
    reference: typeof p.sub === 'string' ? p.sub : null,
    keyId: typeof p.kid === 'string' ? p.kid : null,
    domains: null,
    issuedAt: issuedMs ? new Date(issuedMs).toISOString() : null,
    status: status(),
    plan,
    periodEnd: periodMs ? new Date(periodMs).toISOString() : null,
    account: account(),
    signedIn: signedIn(),
    trialAvailable:
      snapshot && snapshot.trial && typeof snapshot.trial.available === 'boolean'
        ? snapshot.trial.available
        : null,
    trialReason: snapshot && snapshot.trial && typeof snapshot.trial.reason === 'string' ? snapshot.trial.reason : null,
    nextCharge: ent.next_charge && typeof ent.next_charge === 'object' ? { ...ent.next_charge } : null,
    accessUntil: typeof ent.access_until === 'string' ? ent.access_until : null,
    freeSessionsUsed: freeSessionsUsed(),
  };
}

/* ------------------------------------------------------------------- boot */

if (hasWindow) {
  migrateLegacyLicence();
  state = evaluate(readToken());
  snapshot = readSnapshot();
  stampTier();

  // Another tab signing in or out should light this one up too.
  window.addEventListener('storage', (event) => {
    if (!event) return;
    if (event.key === TOKEN_KEY || event.key === SNAPSHOT_KEY || event.key === null) refreshFromStorage();
  });

  if (hasDocument) {
    document.addEventListener('hmb:auth', onAuthEvent);
    document.addEventListener('hmb:session-start', onSessionStart);
  }

  // Load the auth module in the background; it decides whether a refresh is
  // due. A page that never loads js/auth.js keeps the cached token, unchanged.
  const boot = () => {
    loadAuth();
    primeFreeSessionCount();
  };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(boot, { timeout: 2500 });
  else window.setTimeout(boot, 300);

  window.addEventListener('online', () => maybeRefresh());
}
