/**
 * api/_lib/supabase.js — Supabase from a Vercel function without supabase-js.
 *
 * Three jobs, all over `fetch` + WebCrypto, zero npm dependencies
 * (docs/private/ACCOUNTS_BILLING_DESIGN.md §2 rule 2 and §4.5):
 *
 *   verifyAccessToken(jwt)   who is calling — JWKS-verified Supabase access token
 *   db(path, options)        PostgREST over fetch with the secret key (+ wrappers)
 *   assertLiveUser(jwt)      network round-trip to /auth/v1/user for money-touching calls
 *
 * Why not supabase-js on the server: Node refuses `https:` ESM specifiers
 * (ERR_UNSUPPORTED_ESM_URL_SCHEME) and adding the npm package would be this
 * repo's first runtime dependency. The browser side (js/auth.js) still uses the
 * pinned jsDelivr build for sign-in only.
 *
 * Security properties of the verifier, in the order they are enforced:
 *
 *   1. The token header is attacker-supplied. It contributes exactly two
 *      things: `kid` (which key to look up) and `alg` (which must AGREE with
 *      the key we found, or the token is rejected). The verification algorithm
 *      is derived from the matched JWK's `kty`/`crv`, never from the header.
 *      A header saying RS256 against an EC key is rejected before importKey
 *      is ever called.
 *   2. HS256 anywhere — header or JWK — is refused outright and logged, because
 *      it means the project still uses symmetric signing keys and a verifier
 *      holding the symmetric secret could mint tokens.
 *   3. After the signature: exp (30 s skew), nbf, iat, iss, aud, role,
 *      session_id, sub shape, is_anonymous, and exp - iat <= 7200 so a forged
 *      lifetime cannot outlive the hour Supabase issues.
 *
 * JWKS caching: module scope, 10 minutes, one in-flight fetch at a time. A
 * `kid` miss forces exactly one refresh and then fails. Never loops.
 *
 * Every RLS-bypassing call in here uses SUPABASE_SECRET_KEY, which means every
 * handler calling db() is doing its own authorization by hand (§3.3). Derive
 * the user id from verifyAccessToken().sub, never from a request body.
 *
 * Nothing in this file logs a token, a key, or an email address.
 */

import { b64urlDecode, b64urlDecodeToString } from './crypto.js';
import { readEnv, requireEnv } from './env.js';

/* ------------------------------------------------------------------ config */

/** JWKS cache lifetime. Supabase's own edge caches the document for 10 minutes too. */
export const JWKS_TTL_MS = 10 * 60 * 1000;

/**
 * A `kid` miss forces a refresh, but not more often than this. Without the
 * guard, a stream of tokens carrying junk kids would turn every request into a
 * JWKS fetch. A real rotation is still picked up within this window.
 */
export const JWKS_MIN_FORCED_REFRESH_MS = 30 * 1000;

/** Clock skew tolerated on exp / nbf / iat, in seconds. */
export const CLOCK_SKEW_SECONDS = 30;

/** Supabase issues one-hour access tokens; anything claiming more than 2 h is forged. */
export const MAX_TOKEN_LIFETIME_SECONDS = 7200;

/** Longest access token we will even look at. Real ones are well under 2 KB. */
export const MAX_JWT_LENGTH = 8192;

/** Outbound request timeouts. Short on purpose: a hung fetch is a hung function. */
export const JWKS_FETCH_TIMEOUT_MS = 5000;
export const DB_TIMEOUT_MS = 8000;
export const AUTH_USER_TIMEOUT_MS = 5000;

const EXPECTED_AUDIENCE = 'authenticated';
const EXPECTED_ROLE = 'authenticated';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* --------------------------------------------------------------- env access */

/**
 * SUPABASE_URL without a trailing slash. Throws MissingEnvError in production
 * when unset; in development returns the obvious `dev-missing-...` placeholder
 * so a local call fails at the network, never silently.
 * @param {{supabaseUrl?:string}} [options]
 * @returns {string}
 */
export function supabaseUrl(options = {}) {
  const raw = options.supabaseUrl || requireEnv(['SUPABASE_URL']).SUPABASE_URL;
  return String(raw).trim().replace(/\/+$/, '');
}

/**
 * The issuer a genuine token must carry.
 * @param {{supabaseUrl?:string}} [options]
 * @returns {string}
 */
export function expectedIssuer(options = {}) {
  return `${supabaseUrl(options)}/auth/v1`;
}

function subtleFrom(options) {
  if (options && options.subtle) return options.subtle;
  const webcrypto = globalThis.crypto;
  if (!webcrypto || !webcrypto.subtle) {
    throw new Error('WebCrypto is unavailable: globalThis.crypto.subtle is not defined in this runtime.');
  }
  return webcrypto.subtle;
}

function fetchFrom(options) {
  if (options && typeof options.fetchImpl === 'function') return options.fetchImpl;
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  throw new Error('fetch is unavailable in this runtime.');
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

/* -------------------------------------------------------------- JWKS cache */

/**
 * @typedef {{alg:'ES256'|'RS256', jwk:object, cryptoKey:CryptoKey|null}} CachedKey
 * @typedef {{keys:Map<string,CachedKey>|null, fetchedAt:number, inflight:Promise<Map<string,CachedKey>>|null, fetchCount:number}} JwksState
 */

/** @type {JwksState & {attemptedAt:number}} */
const jwksState = { keys: null, fetchedAt: 0, attemptedAt: 0, inflight: null, fetchCount: 0 };

let symmetricWarned = false;

/** Forget every cached key. Tests call this; production never needs to. */
export function resetJwksCache() {
  jwksState.keys = null;
  jwksState.fetchedAt = 0;
  jwksState.attemptedAt = 0;
  jwksState.inflight = null;
  jwksState.fetchCount = 0;
  symmetricWarned = false;
}

/** Read-only view of the cache for tests and /api/health style introspection. */
export function jwksCacheInfo() {
  return {
    cached: jwksState.keys !== null,
    kids: jwksState.keys ? Array.from(jwksState.keys.keys()) : [],
    fetchedAt: jwksState.fetchedAt,
    fetchCount: jwksState.fetchCount,
    inflight: jwksState.inflight !== null,
  };
}

function warnSymmetric() {
  if (symmetricWarned) return;
  symmetricWarned = true;
  console.error(
    '[supabase] project still uses symmetric JWT signing keys; switch to asymmetric in Settings -> JWT Keys.',
  );
}

/**
 * Decide the verification algorithm from the KEY, not from the token header.
 * @param {object} jwk
 * @returns {'ES256'|'RS256'|'HS256'|null} null = unusable key of some other shape
 */
export function algorithmForJwk(jwk) {
  if (!jwk || typeof jwk !== 'object') return null;
  if (jwk.kty === 'oct') return 'HS256';
  let derived = null;
  if (jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string') {
    derived = 'ES256';
  } else if (jwk.kty === 'RSA' && typeof jwk.n === 'string' && typeof jwk.e === 'string') {
    derived = 'RS256';
  }
  if (!derived) return null;
  // A JWK that names a different algorithm than its own key type is not a key we understand.
  if (typeof jwk.alg === 'string' && jwk.alg !== derived) return null;
  if (typeof jwk.use === 'string' && jwk.use !== 'sig') return null;
  return derived;
}

/**
 * Turn a JWKS document into the cache map. Keys we cannot use are dropped
 * (and a symmetric key is logged), so a later kid match can only ever land on
 * an EC P-256 or RSA public key.
 * @param {unknown} document
 * @returns {Map<string,CachedKey>}
 */
export function indexJwks(document) {
  const map = new Map();
  const list = document && typeof document === 'object' && Array.isArray(document.keys) ? document.keys : [];
  for (const jwk of list) {
    if (!jwk || typeof jwk !== 'object' || typeof jwk.kid !== 'string' || !jwk.kid) continue;
    const alg = algorithmForJwk(jwk);
    if (alg === 'HS256') {
      warnSymmetric();
      continue;
    }
    if (!alg) continue;
    if (map.has(jwk.kid)) continue; // first wins; a duplicate kid is a malformed document
    map.set(jwk.kid, { alg, jwk, cryptoKey: null });
  }
  return map;
}

/**
 * Fetch (or reuse) the JWKS. One in-flight fetch at a time; a failed refresh
 * falls back to the stale set when there is one, because a stale set of public
 * keys can only reject, never grant, anything new.
 *
 * While a stale set exists, a new fetch is attempted at most once per
 * JWKS_MIN_FORCED_REFRESH_MS whether the trigger is a TTL expiry or a kid
 * miss. Without that, a Supabase outage past the TTL would make every request
 * wait out the 5 s fetch timeout before falling back to the stale keys.
 *
 * @param {{force?:boolean, now?:number, supabaseUrl?:string, fetchImpl?:Function}} options
 * @returns {Promise<Map<string,CachedKey>>}
 */
async function loadJwks(options) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const force = options.force === true;
  const fresh = jwksState.keys !== null && now - jwksState.fetchedAt < JWKS_TTL_MS;

  if (!force && fresh) return jwksState.keys;
  if (jwksState.inflight) return jwksState.inflight;
  if (now - jwksState.attemptedAt < JWKS_MIN_FORCED_REFRESH_MS && jwksState.fetchCount > 0) {
    // Inside the guard window: serve the stale set, or fail fast on a cold
    // cache rather than make every request wait out the fetch timeout.
    if (jwksState.keys !== null) return jwksState.keys;
    throw new Error('JWKS unavailable; last fetch attempt failed less than 30 s ago.');
  }

  const url = `${supabaseUrl(options)}/auth/v1/.well-known/jwks.json`;
  const fetchImpl = fetchFrom(options);

  jwksState.inflight = (async () => {
    try {
      jwksState.fetchCount += 1;
      jwksState.attemptedAt = now;
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: timeoutSignal(JWKS_FETCH_TIMEOUT_MS),
      });
      if (!response || !response.ok) {
        throw new Error(`JWKS fetch failed with status ${response ? response.status : 'unknown'}.`);
      }
      const document = await response.json();
      const keys = indexJwks(document);
      jwksState.keys = keys;
      jwksState.fetchedAt = now;
      return keys;
    } catch (error) {
      if (jwksState.keys !== null) return jwksState.keys;
      throw error;
    } finally {
      jwksState.inflight = null;
    }
  })();

  return jwksState.inflight;
}

/* --------------------------------------------------------- JWT primitives */

function fail(reason, extra = {}) {
  return { ok: false, sub: null, email: '', claims: null, reason, ...extra };
}

/**
 * Split and decode the three JWT segments without trusting any of them.
 * @param {string} jwt
 * @returns {{ok:true, header:object, payload:object, signature:Uint8Array, signingInput:string}|{ok:false, reason:string}}
 */
export function decodeJwt(jwt) {
  if (typeof jwt !== 'string' || jwt.length === 0) return { ok: false, reason: 'missing' };
  if (jwt.length > MAX_JWT_LENGTH) return { ok: false, reason: 'malformed' };
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return { ok: false, reason: 'malformed' };

  let header;
  let payload;
  let signature;
  try {
    header = JSON.parse(b64urlDecodeToString(parts[0]));
    payload = JSON.parse(b64urlDecodeToString(parts[1]));
    signature = b64urlDecode(parts[2]);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) return { ok: false, reason: 'bad_header' };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'bad_payload' };
  return { ok: true, header, payload, signature, signingInput: `${parts[0]}.${parts[1]}` };
}

/**
 * Minimal public JWK for WebCrypto: only the members the algorithm needs.
 * Extra members (kid, use, key_ops, x5c...) are dropped so the import cannot
 * be steered by anything but the key material itself.
 */
function cleanPublicJwk(jwk, alg) {
  if (alg === 'ES256') return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true };
  return { kty: 'RSA', n: jwk.n, e: jwk.e, ext: true };
}

async function importVerifyKey(subtle, entry) {
  if (entry.cryptoKey) return entry.cryptoKey;
  const params =
    entry.alg === 'ES256'
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const key = await subtle.importKey('jwk', cleanPublicJwk(entry.jwk, entry.alg), params, false, ['verify']);
  entry.cryptoKey = key;
  return key;
}

const TEXT_ENCODER = new TextEncoder();

async function verifySignature(subtle, entry, signature, signingInput) {
  if (entry.alg === 'ES256' && signature.length !== 64) return false;
  const key = await importVerifyKey(subtle, entry);
  const params = entry.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  return subtle.verify(params, key, signature, TEXT_ENCODER.encode(signingInput));
}

/**
 * Claim checks, pure and synchronous, so they can be tested without keys.
 * @param {object} claims
 * @param {{nowSeconds:number, issuer:string}} context
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function checkClaims(claims, context) {
  const now = context.nowSeconds;
  const skew = CLOCK_SKEW_SECONDS;

  // NumericDate claims must be JSON numbers. A string "3600" is not a date,
  // and coercing it would let a malformed payload through on a technicality.
  const { exp, iat } = claims;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return { ok: false, reason: 'bad_payload' };
  if (typeof iat !== 'number' || !Number.isFinite(iat) || iat <= 0) return { ok: false, reason: 'bad_payload' };
  if (now >= exp + skew) return { ok: false, reason: 'expired' };
  if (iat > now + skew) return { ok: false, reason: 'issued_in_future' };
  if (claims.nbf !== undefined) {
    const nbf = claims.nbf;
    if (typeof nbf !== 'number' || !Number.isFinite(nbf)) return { ok: false, reason: 'bad_payload' };
    if (nbf > now + skew) return { ok: false, reason: 'not_yet_valid' };
  }
  if (exp - iat > MAX_TOKEN_LIFETIME_SECONDS) return { ok: false, reason: 'lifetime_too_long' };
  if (exp <= iat) return { ok: false, reason: 'bad_payload' };

  if (claims.iss !== context.issuer) return { ok: false, reason: 'bad_issuer' };

  const aud = claims.aud;
  const audOk =
    aud === EXPECTED_AUDIENCE || (Array.isArray(aud) && aud.length > 0 && aud.includes(EXPECTED_AUDIENCE));
  if (!audOk) return { ok: false, reason: 'bad_audience' };

  if (claims.role !== EXPECTED_ROLE) return { ok: false, reason: 'bad_role' };
  if (typeof claims.session_id !== 'string' || claims.session_id.length === 0) {
    return { ok: false, reason: 'missing_session' };
  }
  if (typeof claims.sub !== 'string' || !UUID_RE.test(claims.sub)) return { ok: false, reason: 'bad_subject' };
  // We never enable anonymous sign-ins; an anonymous token has no email and no account.
  if (claims.is_anonymous === true) return { ok: false, reason: 'anonymous' };
  return { ok: true };
}

/**
 * Verify a Supabase access token against the project's JWKS.
 *
 * @param {string} jwt
 * @param {{
 *   now?:number,             // ms since epoch; tests inject it
 *   supabaseUrl?:string,     // overrides SUPABASE_URL; tests inject it
 *   fetchImpl?:Function,     // overrides global fetch; tests stub the JWKS
 *   subtle?:SubtleCrypto,    // overrides crypto.subtle; tests spy on importKey
 * }} [options]
 * @returns {Promise<{ok:boolean, sub:string|null, email:string, claims:object|null, reason?:string}>}
 *   reason on failure is one of: missing | malformed | bad_header | bad_payload |
 *   unsupported_alg | alg_mismatch | unknown_kid | jwks_unavailable | bad_signature |
 *   expired | issued_in_future | not_yet_valid | lifetime_too_long | bad_issuer |
 *   bad_audience | bad_role | missing_session | bad_subject | anonymous
 */
export async function verifyAccessToken(jwt, options = {}) {
  const decoded = decodeJwt(jwt);
  if (!decoded.ok) return fail(decoded.reason);
  const { header, payload, signature, signingInput } = decoded;

  // Header: only `kid` and `alg` are read, and `alg` is only ever COMPARED.
  if (typeof header.alg !== 'string' || typeof header.kid !== 'string' || header.kid.length === 0) {
    return fail('bad_header');
  }
  if (header.typ !== undefined && String(header.typ).toUpperCase() !== 'JWT') return fail('bad_header');
  if (header.crit !== undefined) return fail('bad_header'); // no critical extensions are understood
  if (header.alg === 'HS256' || header.alg === 'none' || /^HS/i.test(header.alg)) {
    warnSymmetric();
    return fail('unsupported_alg');
  }
  if (header.alg !== 'ES256' && header.alg !== 'RS256') return fail('unsupported_alg');

  // Key lookup: cache, then exactly one forced refresh on a miss. Never loops.
  let keys;
  try {
    keys = await loadJwks(options);
  } catch {
    return fail('jwks_unavailable');
  }
  let entry = keys.get(header.kid);
  if (!entry) {
    try {
      keys = await loadJwks({ ...options, force: true });
    } catch {
      return fail('jwks_unavailable');
    }
    entry = keys.get(header.kid);
    if (!entry) return fail('unknown_kid');
  }

  // The algorithm comes from the key. The header must agree, or we stop here,
  // before importKey and before any cryptography happens.
  if (entry.alg !== header.alg) return fail('alg_mismatch');

  let valid = false;
  try {
    valid = await verifySignature(subtleFrom(options), entry, signature, signingInput);
  } catch {
    valid = false;
  }
  if (!valid) return fail('bad_signature');

  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const check = checkClaims(payload, {
    nowSeconds: Math.floor(nowMs / 1000),
    issuer: expectedIssuer(options),
  });
  if (!check.ok) return fail(check.reason);

  return {
    ok: true,
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : '',
    claims: payload,
  };
}

/* ---------------------------------------------------------- PostgREST db() */

/** Thrown by db() on a non-2xx PostgREST answer or a network failure. Never carries a key. */
export class SupabaseError extends Error {
  /**
   * @param {string} message
   * @param {{status?:number, code?:string, details?:unknown, hint?:string, reason?:string}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'SupabaseError';
    this.status = Number.isFinite(info.status) ? info.status : 0;
    this.code = info.code || '';
    this.details = info.details == null ? null : info.details;
    this.hint = info.hint || '';
    this.reason = info.reason || (this.status ? 'http' : 'network');
    // Surfaces as 503 through respond.js#errorResponse: the database, not the caller, is at fault.
    this.statusCode = 503;
  }
}

/**
 * Resolve the connection details for db(). Tests inject `ctx`; production
 * reads SUPABASE_URL and SUPABASE_SECRET_KEY from the environment.
 * @param {{url?:string, secretKey?:string, fetchImpl?:Function}} [ctx]
 */
function dbContext(ctx = {}) {
  const url = supabaseUrl({ supabaseUrl: ctx.url });
  const secretKey = ctx.secretKey || requireEnv(['SUPABASE_SECRET_KEY']).SUPABASE_SECRET_KEY;
  return { url, secretKey, fetchImpl: fetchFrom(ctx) };
}

/**
 * Turn a filter object into PostgREST query parameters.
 *
 *   { user_id: ['eq', sub], status: ['in', '("active","trialing")'], cancel_at: null }
 *   -> user_id=eq.<sub>&status=in.("active","trialing")&cancel_at=is.null
 *
 * Values: a `[operator, value]` tuple; `null` (is.null); a boolean or number
 * (eq.); or a string that ALREADY carries its operator (`'eq.foo'`, used
 * verbatim). A bare string without an operator is a programming error and
 * throws, because guessing `eq.` for an email-shaped value is exactly how a
 * filter silently matches nothing.
 *
 * @param {Record<string, unknown>} filters
 * @returns {Record<string,string>}
 */
export function buildFilters(filters) {
  const out = {};
  if (!filters || typeof filters !== 'object') return out;
  for (const [column, raw] of Object.entries(filters)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) throw new TypeError(`buildFilters: bad column name "${column}".`);
    if (raw === null) {
      out[column] = 'is.null';
    } else if (Array.isArray(raw)) {
      if (raw.length !== 2 || typeof raw[0] !== 'string') {
        throw new TypeError(`buildFilters: filter for "${column}" must be [operator, value].`);
      }
      out[column] = `${raw[0]}.${raw[1] === null ? 'null' : String(raw[1])}`;
    } else if (typeof raw === 'boolean' || typeof raw === 'number') {
      out[column] = `eq.${raw}`;
    } else if (typeof raw === 'string') {
      if (!/^[a-z]+\./.test(raw)) {
        throw new TypeError(`buildFilters: filter for "${column}" needs an operator prefix such as "eq.".`);
      }
      out[column] = raw;
    } else {
      throw new TypeError(`buildFilters: unsupported filter value for "${column}".`);
    }
  }
  return out;
}

/**
 * Quote one value for use inside an `in.(...)` list. PostgREST needs quotes
 * when the value contains `,`, `.`, `:`, `(` or `)`.
 * @param {string|number} value
 * @returns {string}
 */
export function quoteInValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Low-level PostgREST request. Every wrapper below goes through here.
 *
 * @param {string} path e.g. 'subscriptions' or 'rpc/bump_rate_limit'
 * @param {{
 *   method?:'GET'|'POST'|'PATCH'|'DELETE',
 *   query?:Record<string, string|number|boolean|undefined|null>,
 *   body?:unknown,
 *   prefer?:string,
 *   headers?:Record<string,string>,
 *   timeoutMs?:number,
 *   ctx?:{url?:string, secretKey?:string, fetchImpl?:Function},
 * }} [options]
 * @returns {Promise<unknown>} the parsed JSON body, or null for an empty body
 * @throws {SupabaseError}
 */
export async function db(path, options = {}) {
  const { url, secretKey, fetchImpl } = dbContext(options.ctx);
  const method = options.method || 'GET';
  const cleanPath = String(path || '').replace(/^\/+/, '');
  // Callers may pass a ready-made query string (`subscriptions?user_id=eq.x`);
  // only the path part in front of it is checked for traversal, because a
  // filter value can legitimately contain `..` (a `like` pattern, say).
  // The WHATWG URL parser also folds `%2e%2e` into `..`, so that spelling is
  // refused as well.
  const pathOnly = cleanPath.split('?')[0];
  const dotSegment = (segment) => /^\.{1,2}$/.test(segment.replace(/%2e/gi, '.'));
  if (!pathOnly || pathOnly.split('/').some(dotSegment)) {
    throw new TypeError(`db(): bad path "${path}".`);
  }

  const target = new URL(`${url}/rest/v1/${cleanPath}`);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null) continue;
      target.searchParams.append(key, String(value));
    }
  }

  // Header names are lowercased so a caller's `Prefer` and our `prefer` never
  // become two values on one header (the Headers constructor would join them).
  const headers = {
    apikey: secretKey,
    authorization: `Bearer ${secretKey}`,
    accept: 'application/json',
  };
  for (const [name, value] of Object.entries(options.headers || {})) {
    if (value === undefined || value === null) continue;
    headers[String(name).toLowerCase()] = String(value);
  }
  if (options.prefer) headers.prefer = options.prefer;
  // The secret key is never overridable through options.headers.
  headers.apikey = secretKey;
  headers.authorization = `Bearer ${secretKey}`;
  const hasBody = options.body !== undefined;
  if (hasBody) headers['content-type'] = 'application/json';

  let response;
  try {
    response = await fetchImpl(target.toString(), {
      method,
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: timeoutSignal(options.timeoutMs || DB_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SupabaseError(`PostgREST ${method} ${cleanPath}: network failure.`, {
      reason: 'network',
      details: error && error.name ? error.name : 'error',
    });
  }

  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const info = data && typeof data === 'object' ? data : {};
    throw new SupabaseError(`PostgREST ${method} ${cleanPath} -> ${response.status}${info.code ? ` (${info.code})` : ''}.`, {
      status: response.status,
      code: info.code,
      details: info.message || info.details || null,
      hint: info.hint,
      reason: 'http',
    });
  }
  return data;
}

/**
 * SELECT rows.
 * @param {string} table
 * @param {{columns?:string, filters?:Record<string,unknown>, order?:string, limit?:number, offset?:number, single?:boolean, ctx?:object}} [options]
 * @returns {Promise<object[]|object|null>} an array, or with `single` the first row or null
 */
export async function select(table, options = {}) {
  const query = { select: options.columns || '*', ...buildFilters(options.filters) };
  if (options.order) query.order = options.order;
  if (Number.isFinite(options.limit)) query.limit = Math.max(0, Math.floor(options.limit));
  if (Number.isFinite(options.offset)) query.offset = Math.max(0, Math.floor(options.offset));
  if (options.single && !Number.isFinite(options.limit)) query.limit = 1;
  const rows = await db(table, { method: 'GET', query, ctx: options.ctx });
  const list = Array.isArray(rows) ? rows : [];
  if (options.single) return list.length > 0 ? list[0] : null;
  return list;
}

/**
 * INSERT one row and return it.
 * @param {string} table
 * @param {object} row
 * @param {{columns?:string, ctx?:object}} [options]
 * @returns {Promise<object|null>}
 */
export async function insertOne(table, row, options = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('insertOne(): row must be an object.');
  const data = await db(table, {
    method: 'POST',
    query: options.columns ? { select: options.columns } : undefined,
    body: row,
    prefer: 'return=representation',
    ctx: options.ctx,
  });
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

/**
 * UPSERT one row on its primary key or a named unique constraint, returning it.
 * @param {string} table
 * @param {object} row
 * @param {{onConflict?:string, columns?:string, ctx?:object}} [options] onConflict: comma-separated column list
 * @returns {Promise<object|null>}
 */
export async function upsertOne(table, row, options = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('upsertOne(): row must be an object.');
  const query = {};
  if (options.onConflict) query.on_conflict = options.onConflict;
  if (options.columns) query.select = options.columns;
  const data = await db(table, {
    method: 'POST',
    query,
    body: row,
    prefer: 'resolution=merge-duplicates,return=representation',
    ctx: options.ctx,
  });
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

/**
 * UPDATE rows matching the filters and return them. Refuses an empty filter
 * set: an unfiltered PATCH would rewrite the whole table.
 * @param {string} table
 * @param {Record<string,unknown>} filters
 * @param {object} patch
 * @param {{columns?:string, ctx?:object}} [options]
 * @returns {Promise<object[]>} the rows actually updated (zero-length means nothing matched)
 */
export async function updateWhere(table, filters, patch, options = {}) {
  const query = buildFilters(filters);
  if (Object.keys(query).length === 0) throw new TypeError('updateWhere(): refusing to update without a filter.');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('updateWhere(): patch must be an object.');
  if (options.columns) query.select = options.columns;
  const data = await db(table, {
    method: 'PATCH',
    query,
    body: patch,
    prefer: 'return=representation',
    ctx: options.ctx,
  });
  return Array.isArray(data) ? data : [];
}

/**
 * DELETE rows matching the filters. Refuses an empty filter set.
 * @param {string} table
 * @param {Record<string,unknown>} filters
 * @param {{ctx?:object}} [options]
 * @returns {Promise<object[]>} the deleted rows
 */
export async function deleteWhere(table, filters, options = {}) {
  const query = buildFilters(filters);
  if (Object.keys(query).length === 0) throw new TypeError('deleteWhere(): refusing to delete without a filter.');
  const data = await db(table, {
    method: 'DELETE',
    query,
    prefer: 'return=representation',
    ctx: options.ctx,
  });
  return Array.isArray(data) ? data : [];
}

/**
 * Call a Postgres function through PostgREST (`POST /rest/v1/rpc/<name>`).
 * Arguments are passed by name in the JSON body; a scalar function returns its
 * bare value.
 * @param {string} fn
 * @param {Record<string,unknown>} [args]
 * @param {{ctx?:object}} [options]
 * @returns {Promise<unknown>}
 */
export async function rpc(fn, args = {}, options = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(fn))) throw new TypeError(`rpc(): bad function name "${fn}".`);
  return db(`rpc/${fn}`, { method: 'POST', body: args || {}, ctx: options.ctx });
}

/* --------------------------------------------------------- assertLiveUser */

/**
 * Authoritative "is this session still alive" check for money-touching calls
 * only (start checkout, cancel, pause, switch, export, delete). Verifies the JWT locally first — garbage never reaches the network —
 * then asks GET /auth/v1/user with the user's own bearer token and the
 * PUBLISHABLE key in `apikey`. Catches a session signed out or revoked while
 * its JWT is still inside its hour.
 *
 * Fails CLOSED: if Supabase cannot be reached, the answer is "no", with
 * reason `auth_unavailable`, so a handler can answer 503 rather than proceed.
 *
 * @param {string} jwt
 * @param {{now?:number, supabaseUrl?:string, publishableKey?:string, fetchImpl?:Function, subtle?:SubtleCrypto}} [options]
 * @returns {Promise<{ok:boolean, sub:string|null, email:string, claims:object|null, user:object|null, reason?:string}>}
 *   failure reasons: any verifyAccessToken reason | session_revoked | sub_mismatch | auth_unavailable
 */
export async function assertLiveUser(jwt, options = {}) {
  const verified = await verifyAccessToken(jwt, options);
  if (!verified.ok) return { ...verified, user: null };

  const url = supabaseUrl(options);
  const publishableKey =
    options.publishableKey || requireEnv(['SUPABASE_PUBLISHABLE_KEY']).SUPABASE_PUBLISHABLE_KEY;
  const fetchImpl = fetchFrom(options);

  let response;
  try {
    response = await fetchImpl(`${url}/auth/v1/user`, {
      method: 'GET',
      headers: {
        apikey: publishableKey,
        authorization: `Bearer ${jwt}`,
        accept: 'application/json',
      },
      signal: timeoutSignal(AUTH_USER_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, sub: null, email: '', claims: null, user: null, reason: 'auth_unavailable' };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, sub: null, email: '', claims: null, user: null, reason: 'session_revoked' };
  }
  if (!response.ok) {
    return { ok: false, sub: null, email: '', claims: null, user: null, reason: 'auth_unavailable' };
  }

  let user;
  try {
    user = await response.json();
  } catch {
    return { ok: false, sub: null, email: '', claims: null, user: null, reason: 'auth_unavailable' };
  }
  if (!user || typeof user !== 'object' || user.id !== verified.sub) {
    return { ok: false, sub: null, email: '', claims: null, user: null, reason: 'sub_mismatch' };
  }

  return {
    ok: true,
    sub: verified.sub,
    email: typeof user.email === 'string' && user.email ? user.email : verified.email,
    claims: verified.claims,
    user,
  };
}

/**
 * True when the Supabase server-side configuration is present. Booleans only;
 * safe for /api/health.
 * @returns {{url:boolean, publishable_key:boolean, secret_key:boolean}}
 */
export function describeSupabaseConfig() {
  return {
    url: readEnv('SUPABASE_URL') !== '',
    publishable_key: readEnv('SUPABASE_PUBLISHABLE_KEY') !== '',
    secret_key: readEnv('SUPABASE_SECRET_KEY') !== '',
  };
}
