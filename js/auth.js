/**
 * js/auth.js — the ONLY module in the codebase that knows Supabase exists.
 *
 * Design: docs/private/ACCOUNTS_BILLING_DESIGN.md §4 (auth flows), §4.3
 * (sessions and sign-out), §4.4 (resuming checkout after sign-in), §5.1 (the
 * device mirror), §13 (the 6-digit code fallback).
 *
 * What this module does
 *   - Sign-in by magic link, by 6-digit code, or with Google. No passwords,
 *     anywhere.
 *   - Holds the session (Supabase's own storage, `localStorage`) and answers
 *     `signedIn()` / `user()` synchronously from a cached copy of it.
 *   - Hands out the Supabase access token to callers that talk to `/api/*`.
 *   - Signs out: local session, `hmb.ent*` keys, then `POST /api/account/signout`.
 *   - Keeps the MAC'd device mirror (`hmb.did`) that `/api/me` returns.
 *
 * What it never does
 *   - Talk to PostgREST. The browser reads product data only through
 *     `GET /api/me` (design §2, rule 1).
 *   - Expose tokens on `user()`. `accessToken()` is the one way out, and it is
 *     asynchronous because a refresh may be needed.
 *   - Read or write a cookie. `__Host-hmb_ent` and `__Host-hmb_did` are set by
 *     the server; the mirror in `localStorage` is a copy of a value the server
 *     already returned in a response body.
 *
 * The supabase-js import
 *   The URL is pinned to an exact version — never `@2` — because a silent bump
 *   in the module that owns sign-in is not a risk worth taking (§4.1). It is
 *   loaded with a dynamic `import()` rather than a static one, deliberately:
 *   `js/entitlements.js` re-exports `signedIn()` from here, so this module sits
 *   in the import graph of every timer page, and a static cross-origin import
 *   would make a blocked CDN, a strict content blocker or an offline PWA load
 *   fail the whole graph — `requireTimer()` included — which would break the
 *   14-day offline promise. With a lazy import the library is fetched only when
 *   there is a session to keep alive, an auth parameter in the URL, or a
 *   sign-in to start; a signed-out visitor reading an article never fetches it,
 *   and an offline subscriber keeps `signedIn()` from the cached session.
 *
 * `flowType: 'pkce'` is NOT the JS default. Without it tokens land in the URL
 * fragment. Add `cdn.jsdelivr.net` to any CSP `script-src`, and the Supabase
 * project URL to `connect-src`.
 *
 * Contract (design §4.1):
 *   signedIn(), user(), accessToken(), signInWithEmail(email, { intent, next }),
 *   signInWithCode(email, { intent, next }), verifyCode(email, code),
 *   signInWithGoogle({ intent, next }), signOut(), onAuthChange(cb), ready().
 * Plus the helpers the two auth pages and js/entitlements.js need:
 *   callbackUrl(), validateNext(), validateIntent(), parseAuthParams(),
 *   completeCallback(), storeDeviceMirror(), readDeviceMirror(), apiFetch(),
 *   fetchMe(), openSignIn().
 */

import * as CONFIG from './config.js';
import { track } from './analytics.js';

/** Pinned. Exact version, never a range. */
export const SUPABASE_JS_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm';

/**
 * Supabase's own session storage, under a fixed key so this module can read the
 * cached session synchronously without guessing the library's default name.
 * The PKCE code verifier lives beside it at `<key>-code-verifier`.
 */
const SESSION_STORAGE_KEY = 'sb-hmb-auth-token';
const ENTITLEMENT_KEYS = ['hmb.ent', 'hmb.ent.snapshot'];
const DEVICE_MIRROR_KEY = 'hmb.did';
const METHOD_KEY = 'hmb.signin.method';
const IDB_NAME = 'hmb';
const IDB_STORE = 'kv';

const INTENT_RE = /^(none|subscribe:(monthly|yearly))$/;
const DEVICE_MIRROR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{16,128}$/i;
const OTP_TYPES = new Set(['email', 'magiclink', 'signup', 'recovery', 'invite', 'email_change']);
const METHODS = new Set(['magic_link', 'otp_code', 'google']);

const hasWindow = typeof window !== 'undefined';
const hasDocument = typeof document !== 'undefined';

/* ------------------------------------------------------------- config ---- */

/** Public Supabase values from js/config.js. Absent until the owner fills them in. */
function supabaseConfig() {
  const cfg = CONFIG && CONFIG.SUPABASE && typeof CONFIG.SUPABASE === 'object' ? CONFIG.SUPABASE : {};
  const url = typeof cfg.url === 'string' ? cfg.url.trim().replace(/\/+$/, '') : '';
  const key = typeof cfg.publishableKey === 'string' ? cfg.publishableKey.trim() : '';
  return { url, publishableKey: key };
}

/** True when the owner has filled in `SUPABASE` in js/config.js. */
export function configured() {
  const cfg = supabaseConfig();
  return /^https:\/\/[^/]+$/.test(cfg.url) && cfg.publishableKey.length > 0;
}

/* ------------------------------------------------------------ storage ---- */

function readLocal(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key, value) {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The session exactly as supabase-js persists it: `{ access_token,
 * refresh_token, expires_at, user }`. Returns null for anything unparseable.
 */
function readStoredSession() {
  if (!hasWindow) return null;
  const raw = readLocal(SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const session = parsed && typeof parsed === 'object' && parsed.currentSession ? parsed.currentSession : parsed;
    if (!session || typeof session !== 'object') return null;
    if (typeof session.access_token !== 'string' || !session.user) return null;
    return session;
  } catch {
    return null;
  }
}

function sessionLive(session) {
  if (!session) return false;
  if (typeof session.refresh_token === 'string' && session.refresh_token) return true;
  const exp = Number(session.expires_at) || 0;
  return exp * 1000 > Date.now();
}

/* -------------------------------------------------------------- state ---- */

/** @type {object|null} the cached session, kept in step with supabase-js */
let cached = hasWindow ? readStoredSession() : null;
/** @type {Promise<object>|null} the supabase-js client, once loaded */
let clientPromise = null;
/** @type {Promise<void>|null} */
let readyPromise = null;
/** @type {Set<Function>} */
const listeners = new Set();

function emit(event) {
  const detail = { event, signedIn: signedIn(), user: user() };
  for (const cb of listeners) {
    try {
      cb(detail);
    } catch {
      // A listener's failure is its own.
    }
  }
  if (hasDocument) {
    try {
      document.dispatchEvent(new CustomEvent('hmb:auth', { detail }));
    } catch {
      // No CustomEvent (very old engines): nothing to announce.
    }
  }
}

function setCached(session, event) {
  const before = signedIn();
  const beforeId = user() ? user().id : null;
  cached = session && typeof session === 'object' ? session : null;
  const after = signedIn();
  const afterId = user() ? user().id : null;
  if (before !== after || beforeId !== afterId || event) emit(event || (after ? 'SIGNED_IN' : 'SIGNED_OUT'));
}

/* --------------------------------------------------------- public state --- */

/** Synchronous, from the cached session. Never touches the network. */
export function signedIn() {
  return sessionLive(cached);
}

/** `{ id, email } | null`. Never exposes tokens. */
export function user() {
  if (!sessionLive(cached) || !cached.user) return null;
  const u = cached.user;
  return {
    id: typeof u.id === 'string' ? u.id : '',
    email: typeof u.email === 'string' ? u.email : '',
    created_at: typeof u.created_at === 'string' ? u.created_at : null,
  };
}

/* ------------------------------------------------------------- client ---- */

function urlHasAuthParams() {
  if (!hasWindow) return false;
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.has('code') || q.has('token_hash') || q.has('error') || q.has('error_description')) return true;
    const hash = String(window.location.hash || '');
    return /(^#|&)(access_token|error|error_description)=/.test(hash);
  } catch {
    return false;
  }
}

/**
 * Load supabase-js (pinned URL) and build the one client. Rejects when the
 * project is not configured or the CDN cannot be reached; callers treat that
 * as "auth unavailable", never as "signed out".
 */
function loadClient() {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    if (!hasWindow) throw new Error('auth_no_window');
    const cfg = supabaseConfig();
    if (!configured()) throw new Error('auth_not_configured');
    const mod = await import(/* webpackIgnore: true */ SUPABASE_JS_URL);
    if (!mod || typeof mod.createClient !== 'function') throw new Error('auth_module_shape');
    const client = mod.createClient(cfg.url, cfg.publishableKey, {
      auth: {
        flowType: 'pkce', // NOT the JS default; without it tokens land in the URL fragment
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: SESSION_STORAGE_KEY,
      },
    });
    client.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION') {
        setCached(session, session ? null : undefined);
        return;
      }
      setCached(session, event);
    });
    return client;
  })();
  clientPromise.catch(() => {
    clientPromise = null;
  });
  return clientPromise;
}

/**
 * Resolves once the initial session read is done. Loads the library only when
 * there is something for it to do: a session to keep alive or an auth
 * parameter in the URL. Never rejects.
 */
export function ready() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (!hasWindow || !configured()) return;
    if (!cached && !urlHasAuthParams()) return;
    try {
      const client = await loadClient();
      const { data, error } = await client.auth.getSession();
      if (data && data.session) setCached(data.session, null);
      // A null session WITH an error is a refresh that could not run (offline,
      // rate limited): keep the cached copy. Without one, the session is gone.
      else if (!error && cached && !urlHasAuthParams()) setCached(null, 'SIGNED_OUT');
    } catch {
      // Offline or the CDN is blocked: keep the cached session as it is.
    }
  })();
  return readyPromise;
}

/**
 * The Supabase access token for `Authorization: Bearer`, refreshed if needed.
 * Resolves null when signed out, or when a refresh is impossible offline and
 * the cached token has expired.
 */
export async function accessToken() {
  if (!hasWindow || !configured()) return null;
  await ready();
  if (!cached) return null;
  try {
    const client = await loadClient();
    const { data, error } = await client.auth.getSession();
    if (data && data.session) {
      setCached(data.session, null);
      return data.session.access_token || null;
    }
    if (!error) {
      setCached(null, 'SIGNED_OUT');
      return null;
    }
  } catch {
    // Fall through to the cached token.
  }
  if (!cached) return null;
  const exp = Number(cached.expires_at) || 0;
  return exp * 1000 > Date.now() + 30000 ? cached.access_token : null;
}

/* --------------------------------------------------------- next/intent --- */

/**
 * `next` must be a same-origin path: begins with `/`, no `//`, no scheme, no
 * backslash trick. Anything else is discarded silently (design §4.1).
 * @param {unknown} value
 * @returns {string} the path, or '' when invalid
 */
export function validateNext(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return '';
  if (/[\s\u0000-\u001f\u007f]/.test(v)) return '';
  if (/^\/[^/?#]*:/.test(v)) return '';
  if (v.length > 512) return '';
  if (v.startsWith('/auth/callback')) return '';
  return v;
}

/**
 * `intent` must match `^(none|subscribe:(monthly|yearly))$`.
 * @param {unknown} value
 * @returns {string} the intent, or 'none'
 */
export function validateIntent(value) {
  if (typeof value !== 'string') return 'none';
  return INTENT_RE.test(value) ? value : 'none';
}

/** The plan named by a `subscribe:<plan>` intent, or null. */
export function intentPlan(intent) {
  const v = validateIntent(intent);
  return v.startsWith('subscribe:') ? v.slice('subscribe:'.length) : null;
}

/**
 * `${origin}/auth/callback?next=<same-origin path>&intent=<intent>`.
 * Uses the page's own origin so preview deployments work (the owner's Supabase
 * redirect allow-list covers them, design §14 step 2).
 */
export function callbackUrl(intent, next, origin) {
  const base = origin || (hasWindow ? window.location.origin : 'https://helpmebreath.com');
  const params = new URLSearchParams();
  const safeNext = validateNext(next);
  const safeIntent = validateIntent(intent);
  if (safeNext) params.set('next', safeNext);
  params.set('intent', safeIntent);
  return `${base}/auth/callback?${params.toString()}`;
}

/**
 * The sign-in page URL for a gate to send someone to (design §4.4 step 1).
 * @param {{next?:string, intent?:string}} [options]
 */
export function signInUrl(options = {}) {
  const params = new URLSearchParams();
  const safeNext = validateNext(options.next);
  const safeIntent = validateIntent(options.intent);
  if (safeNext) params.set('next', safeNext);
  if (safeIntent !== 'none') params.set('intent', safeIntent);
  const qs = params.toString();
  return qs ? `/signin?${qs}` : '/signin';
}

/** Navigate to /signin, preserving where to come back to and what to resume. */
export function openSignIn(options = {}) {
  const url = signInUrl(options);
  if (hasWindow) window.location.assign(url);
  return { ok: true, url };
}

/**
 * Everything /auth/callback and /signin read from the URL, validated.
 * @param {string} [search] defaults to `location.search`
 */
export function parseAuthParams(search) {
  const q = new URLSearchParams(typeof search === 'string' ? search : hasWindow ? window.location.search : '');
  const type = String(q.get('type') || '').toLowerCase();
  return {
    code: q.get('code') || '',
    tokenHash: q.get('token_hash') || '',
    type: OTP_TYPES.has(type) ? type : '',
    error: q.get('error') || '',
    errorCode: q.get('error_code') || '',
    errorDescription: q.get('error_description') || '',
    next: validateNext(q.get('next')),
    intent: validateIntent(q.get('intent')),
    plan: intentPlan(q.get('intent')),
  };
}

/* ----------------------------------------------------------- sign in ----- */

function rememberMethod(method) {
  if (METHODS.has(method)) writeLocal(METHOD_KEY, method);
}

/** The method the last sign-in in this browser was started with, or 'unknown'. */
export function lastSignInMethod() {
  const v = readLocal(METHOD_KEY);
  return METHODS.has(v) ? v : 'unknown';
}

function normalizeEmailInput(email) {
  const v = String(email || '').trim();
  if (v.length < 6 || v.length > 254) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return '';
  return v;
}

/**
 * Map a supabase-js error onto a machine reason and a sentence a person can act
 * on. Never surfaces a stack trace.
 */
export function describeAuthError(error) {
  const status = error && Number.isFinite(error.status) ? error.status : 0;
  const code = error && typeof error.code === 'string' ? error.code : '';
  const message = error && typeof error.message === 'string' ? error.message.toLowerCase() : '';
  if (!error) return { reason: 'unknown', message: 'Something went wrong. Please try again.' };
  if (message.includes('failed to fetch') || message.includes('networkerror') || message.includes('load failed') || code === 'network_error') {
    return { reason: 'network', message: 'We could not reach the sign-in service. Check your connection and try again.' };
  }
  if (status === 429 || code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit' || message.includes('rate limit')) {
    return { reason: 'rate_limited', message: 'Too many requests. Wait a minute, then try again.' };
  }
  if (code === 'otp_expired' || message.includes('expired')) {
    return { reason: 'expired', message: 'That link or code has expired. Send a new one.' };
  }
  if (code === 'pkce_verifier' || message.includes('code verifier') || message.includes('verifier')) {
    return { reason: 'verifier_missing', message: 'That link was opened in a different browser or tab from the one that asked for it. Send a new one, or use the 6-digit code.' };
  }
  if (code === 'bad_code_verifier' || code === 'flow_state_not_found' || code === 'flow_state_expired') {
    return { reason: 'verifier_missing', message: 'That link was opened in a different browser or tab from the one that asked for it. Send a new one, or use the 6-digit code.' };
  }
  if (code === 'otp_disabled' || code === 'email_provider_disabled') {
    return { reason: 'disabled', message: 'Email sign-in is not available right now. Email contact@helpmebreath.com.' };
  }
  if (code === 'validation_failed' || message.includes('invalid email') || message.includes('unable to validate email')) {
    return { reason: 'bad_email', message: 'That does not look like an email address.' };
  }
  if (status === 403 || status === 401 || code === 'invalid_credentials' || message.includes('invalid') || message.includes('already been used') || message.includes('token has')) {
    return { reason: 'used', message: 'That link or code is no longer valid. Links work once. Send a new one.' };
  }
  return { reason: 'unknown', message: 'Something went wrong. Please try again, or use the 6-digit code.' };
}

async function clientOrError() {
  if (!configured()) {
    return { client: null, error: { reason: 'not_configured', message: 'Sign-in is not switched on yet. Email contact@helpmebreath.com if you were expecting it.' } };
  }
  try {
    return { client: await loadClient(), error: null };
  } catch {
    return { client: null, error: { reason: 'network', message: 'We could not load the sign-in service. Check your connection and try again.' } };
  }
}

/**
 * Email a magic link. `signInWithOtp` creates the account if it does not
 * exist (`shouldCreateUser` at its default, design §4.1).
 * @param {string} email
 * @param {{intent?:string, next?:string}} [options]
 * @returns {Promise<{ok:boolean, error?:string, reason?:string}>}
 */
export async function signInWithEmail(email, options = {}) {
  const address = normalizeEmailInput(email);
  if (!address) return { ok: false, reason: 'bad_email', error: 'That does not look like an email address.' };
  const { client, error } = await clientOrError();
  if (!client) return { ok: false, reason: error.reason, error: error.message };
  rememberMethod('magic_link');
  track('signin_start', { method: 'magic_link' });
  const { error: err } = await client.auth.signInWithOtp({
    email: address,
    options: { emailRedirectTo: callbackUrl(options.intent, options.next) },
  });
  if (err) {
    const d = describeAuthError(err);
    return { ok: false, reason: d.reason, error: d.message };
  }
  return { ok: true };
}

/**
 * The 6-digit code fallback (design §13): the same `signInWithOtp`, verified
 * with `verifyCode()`, which a link-scanner's prefetch cannot burn. The email
 * still carries the link too, so the redirect is kept.
 */
export async function signInWithCode(email, options = {}) {
  const address = normalizeEmailInput(email);
  if (!address) return { ok: false, reason: 'bad_email', error: 'That does not look like an email address.' };
  const { client, error } = await clientOrError();
  if (!client) return { ok: false, reason: error.reason, error: error.message };
  rememberMethod('otp_code');
  track('signin_start', { method: 'otp_code' });
  const { error: err } = await client.auth.signInWithOtp({
    email: address,
    options: { emailRedirectTo: callbackUrl(options.intent, options.next) },
  });
  if (err) {
    const d = describeAuthError(err);
    return { ok: false, reason: d.reason, error: d.message };
  }
  return { ok: true };
}

/**
 * Verify a 6-digit code typed by the person. Establishes the session on this
 * page — no redirect through the callback is needed.
 */
export async function verifyCode(email, code) {
  const address = normalizeEmailInput(email);
  const token = String(code || '').replace(/\D/g, '');
  if (!address) return { ok: false, reason: 'bad_email', error: 'That does not look like an email address.' };
  if (token.length !== 6) return { ok: false, reason: 'bad_code', error: 'Enter the 6-digit code from the email.' };
  const { client, error } = await clientOrError();
  if (!client) return { ok: false, reason: error.reason, error: error.message };
  const { data, error: err } = await client.auth.verifyOtp({ email: address, token, type: 'email' });
  if (err) {
    const d = describeAuthError(err);
    return { ok: false, reason: d.reason, error: d.message };
  }
  if (data && data.session) setCached(data.session, 'SIGNED_IN');
  return { ok: signedIn(), reason: signedIn() ? undefined : 'no_session' };
}

/**
 * Google, through Supabase's OAuth (`signInWithOAuth`). Navigates away; the
 * promise resolves only if the redirect could not start.
 */
export async function signInWithGoogle(options = {}) {
  const { client, error } = await clientOrError();
  if (!client) return { ok: false, reason: error.reason, error: error.message };
  rememberMethod('google');
  track('signin_start', { method: 'google' });
  const { error: err } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: callbackUrl(options.intent, options.next) },
  });
  if (err) {
    const d = describeAuthError(err);
    return { ok: false, reason: d.reason, error: d.message };
  }
  return { ok: true };
}

/**
 * Establish the session on /auth/callback from whichever shape the email
 * template produced (design §4.2): `?token_hash=&type=` is exchanged with
 * `verifyOtp`; `?code=` is exchanged by `detectSessionInUrl` on load and, if
 * that did not produce a session, explicitly with `exchangeCodeForSession`.
 *
 * @param {{code?:string, tokenHash?:string, type?:string, error?:string, errorCode?:string, errorDescription?:string}} params
 * @returns {Promise<{ok:boolean, reason?:string, message?:string}>}
 */
export async function completeCallback(params = {}) {
  if (!configured()) {
    return { ok: false, reason: 'not_configured', message: 'Sign-in is not switched on yet.' };
  }
  let client;
  try {
    client = await loadClient();
  } catch {
    return { ok: false, reason: 'network', message: 'We could not load the sign-in service. Check your connection and reload this page.' };
  }
  await ready();

  if (params.error || params.errorDescription) {
    const d = describeAuthError({ code: params.errorCode || params.error, message: params.errorDescription || params.error });
    if (!signedIn()) return { ok: false, reason: d.reason === 'unknown' ? 'expired' : d.reason, message: d.message };
  }

  if (params.tokenHash) {
    const { data, error } = await client.auth.verifyOtp({ token_hash: params.tokenHash, type: params.type || 'email' });
    if (error) {
      const d = describeAuthError(error);
      if (!signedIn()) return { ok: false, reason: d.reason, message: d.message };
    } else if (data && data.session) {
      setCached(data.session, 'SIGNED_IN');
    }
  }

  if (params.code && !signedIn()) {
    const { data, error } = await client.auth.exchangeCodeForSession(params.code);
    if (error) {
      const d = describeAuthError(error);
      if (!signedIn()) return { ok: false, reason: d.reason, message: d.message };
    } else if (data && data.session) {
      setCached(data.session, 'SIGNED_IN');
    }
  }

  // detectSessionInUrl may have finished the exchange before we got here.
  try {
    const { data } = await client.auth.getSession();
    if (data && data.session) setCached(data.session, null);
  } catch {
    // Keep whatever we have.
  }

  if (signedIn()) return { ok: true };
  return { ok: false, reason: 'no_session', message: 'That sign-in link has expired or was already used. Send a new one.' };
}

/* ----------------------------------------------------------- sign out ---- */

function clearEntitlementStorage() {
  for (const key of ENTITLEMENT_KEYS) writeLocal(key, null);
}

/**
 * Clears the Supabase session (this device only — `scope: 'local'` revokes this
 * session at the server and leaves the person's other devices signed in),
 * removes `hmb.ent` and `hmb.ent.snapshot`, and asks the server to drop the
 * `__Host-hmb_ent` cookie. `__Host-hmb_did` is NOT cleared: it is a device
 * anchor, not a session (design §4.3).
 */
export async function signOut() {
  track('signout', {});
  try {
    if (configured() && (cached || clientPromise)) {
      const client = await loadClient();
      await client.auth.signOut({ scope: 'local' });
    }
  } catch {
    // Offline or the library failed: fall through and clear locally anyway.
  }
  writeLocal(SESSION_STORAGE_KEY, null);
  writeLocal(`${SESSION_STORAGE_KEY}-code-verifier`, null);
  clearEntitlementStorage();
  setCached(null, 'SIGNED_OUT');
  try {
    await fetch('/api/account/signout', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } catch {
    // The cookie dies with its Max-Age if this does not reach the server.
  }
}

/**
 * Subscribe to auth changes. `cb({ event, signedIn, user })`. Returns an
 * unsubscribe function.
 */
export function onAuthChange(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/* ------------------------------------------------------ device mirror ----- */

function idbWrite(key, value) {
  if (!hasWindow || !window.indexedDB) return;
  try {
    const open = window.indexedDB.open(IDB_NAME, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    open.onsuccess = () => {
      try {
        const db = open.result;
        const tx = db.transaction(IDB_STORE, 'readwrite');
        if (value == null) tx.objectStore(IDB_STORE).delete(key);
        else tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => db.close();
        tx.onerror = () => db.close();
      } catch {
        // Best effort.
      }
    };
  } catch {
    // Best effort: IndexedDB is a second copy, never the only one.
  }
}

function idbRead(key) {
  return new Promise((resolve) => {
    if (!hasWindow || !window.indexedDB) {
      resolve(null);
      return;
    }
    try {
      const open = window.indexedDB.open(IDB_NAME, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        try {
          const db = open.result;
          const tx = db.transaction(IDB_STORE, 'readonly');
          const req = tx.objectStore(IDB_STORE).get(key);
          req.onsuccess = () => {
            db.close();
            resolve(typeof req.result === 'string' ? req.result : null);
          };
          req.onerror = () => {
            db.close();
            resolve(null);
          };
        } catch {
          resolve(null);
        }
      };
    } catch {
      resolve(null);
    }
  });
}

/** True when a string has the `<uuid>.<base64url mac>` shape of §5.1. */
export function isDeviceMirror(value) {
  return typeof value === 'string' && DEVICE_MIRROR_RE.test(value);
}

/**
 * Store the MAC'd device value `/api/me` and `/api/trial/eligibility` return
 * (design §5.1). Written to `localStorage['hmb.did']` and IndexedDB so the
 * Safari-sweep repair path has two copies. A value without the right shape is
 * ignored; the server never trusts it anyway.
 */
export function storeDeviceMirror(value) {
  if (!isDeviceMirror(value)) return false;
  writeLocal(DEVICE_MIRROR_KEY, value);
  idbWrite('did', value);
  return true;
}

/** The stored mirror, or '' when there is none. Synchronous. */
export function readDeviceMirror() {
  const v = readLocal(DEVICE_MIRROR_KEY);
  return isDeviceMirror(v) ? v : '';
}

/* ------------------------------------------------------------- fetch ----- */

/**
 * `fetch` against our own API with the Supabase bearer token and the device
 * mirror header. Same-origin, no-store. Resolves `{ status, ok, body }` where
 * `body` is the parsed JSON (or `{ ok:false, reason:'bad_response' }`).
 *
 * `status` 401 means the server did not accept the session; callers send the
 * person to /signin. `status` 0 means the network failed.
 *
 * @param {string} path e.g. '/api/me'
 * @param {{method?:string, body?:object, raw?:boolean, signal?:AbortSignal}} [options]
 */
export async function apiFetch(path, options = {}) {
  const token = await accessToken();
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const mirror = readDeviceMirror();
  if (mirror) headers['X-HMB-Device-Mirror'] = mirror;
  const init = {
    method: options.method || 'GET',
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: options.signal,
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    return { status: 0, ok: false, body: { ok: false, reason: 'network' }, response: null };
  }
  if (options.raw) return { status: response.status, ok: response.ok, body: null, response };
  let body;
  try {
    body = await response.json();
  } catch {
    body = { ok: false, reason: 'bad_response' };
  }
  return { status: response.status, ok: response.ok && body && body.ok !== false, body, response };
}

/**
 * `GET /api/me` (design §7.1). Stores the returned device mirror. Returns the
 * body on success, or `{ ok:false, reason }`.
 */
export async function fetchMe() {
  if (!signedIn()) return { ok: false, reason: 'unauthenticated' };
  const result = await apiFetch('/api/me');
  if (result.body && typeof result.body.device_id === 'string') storeDeviceMirror(result.body.device_id);
  if (result.status === 401) {
    return { ok: false, reason: 'unauthenticated' };
  }
  if (!result.ok) {
    return { ok: false, reason: (result.body && result.body.reason) || `http_${result.status}`, status: result.status };
  }
  return result.body;
}

/* ------------------------------------------------------------ wiring ----- */

if (hasWindow) {
  // Another tab signed in or out: refresh the cached session and tell the page.
  window.addEventListener('storage', (event) => {
    if (!event || event.key !== SESSION_STORAGE_KEY) return;
    setCached(readStoredSession(), undefined);
  });

  // Safari-sweep repair: if localStorage lost the mirror but IndexedDB kept it.
  if (!readDeviceMirror()) {
    idbRead('did').then((v) => {
      if (isDeviceMirror(v) && !readDeviceMirror()) writeLocal(DEVICE_MIRROR_KEY, v);
    });
  }

  // Keep a live session alive: start the library when there is one.
  if (cached || urlHasAuthParams()) ready();
}
