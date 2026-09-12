/**
 * api/_lib/authz.js — request-level authorization for the account endpoints.
 *
 * Every gated handler starts the same way:
 *
 *   const auth = await requireUser(request);          // GET /api/me and other reads
 *   if (!auth.ok) return auth.response;
 *   // auth.sub is the ONLY user id a handler may use
 *
 *   const auth = await requireLiveUser(request);      // money-touching calls
 *   if (!auth.ok) return auth.response;
 *
 * The difference: requireUser verifies the JWT locally against the JWKS (no
 * network once the keys are cached), which is what the hot path wants;
 * requireLiveUser adds the round-trip to /auth/v1/user so a session that was
 * signed out or revoked inside its hour is refused (design §4.5). Use the
 * live form for: start checkout, mint an embed token, cancel, pause, switch,
 * export, delete. Never on GET /api/me.
 *
 * Contract with the design (§3.3, §5.3, §7.1):
 *   - the user id comes from the verified token's `sub`, never from a body;
 *   - a JWT failure is 401 { ok:false, reason:'unauthenticated' } — never guess;
 *   - the detailed failure reason is returned to the handler for logging as
 *     `detail`, but never sent to the client and never logged with the token.
 */

import { json } from './respond.js';
import { assertLiveUser, verifyAccessToken } from './supabase.js';

/** Reasons that mean "Supabase could not answer", which is our fault, not the caller's. */
const UNAVAILABLE_REASONS = new Set(['jwks_unavailable', 'auth_unavailable']);

/**
 * Pull the bearer token out of the Authorization header. Returns '' when the
 * header is missing, not a bearer scheme, or not token-shaped.
 * @param {Request} request
 * @returns {string}
 */
export function bearerToken(request) {
  if (!request || !request.headers || typeof request.headers.get !== 'function') return '';
  const header = request.headers.get('authorization') || '';
  const match = /^\s*Bearer\s+([A-Za-z0-9\-_.]+)\s*$/i.exec(header);
  return match ? match[1] : '';
}

/**
 * The 401 every gated endpoint returns on any JWT failure. One shape, one
 * reason, so the client has one code path (design §7.1).
 * @param {Request} request
 * @param {{methods?:string, anyOrigin?:boolean, headers?:Record<string,string>}} [respond]
 * @returns {Response}
 */
export function unauthorized(request, respond = {}) {
  return json(
    401,
    { ok: false, reason: 'unauthenticated' },
    {
      request,
      methods: respond.methods,
      anyOrigin: respond.anyOrigin,
      headers: { 'WWW-Authenticate': 'Bearer realm="helpmebreath"', ...(respond.headers || {}) },
    },
  );
}

/**
 * The 503 for "the identity provider did not answer". Distinct from 401 on
 * purpose: the client must not treat our outage as a sign-out.
 * @param {Request} request
 * @param {{methods?:string, anyOrigin?:boolean, headers?:Record<string,string>}} [respond]
 * @returns {Response}
 */
export function authUnavailable(request, respond = {}) {
  return json(
    503,
    { ok: false, reason: 'auth_unavailable', error: 'Sign-in is briefly unavailable. Please try again in a minute.' },
    { request, methods: respond.methods, anyOrigin: respond.anyOrigin, headers: { 'Retry-After': '30', ...(respond.headers || {}) } },
  );
}

function failure(request, reason, respond) {
  const unavailable = UNAVAILABLE_REASONS.has(reason);
  return {
    ok: false,
    status: unavailable ? 503 : 401,
    detail: reason,
    sub: null,
    email: '',
    claims: null,
    token: '',
    response: unavailable ? authUnavailable(request, respond) : unauthorized(request, respond),
  };
}

/**
 * Identify the caller from the bearer token, locally.
 *
 * @param {Request} request
 * @param {{
 *   live?:boolean,                                   // also hit /auth/v1/user (see requireLiveUser)
 *   respond?:{methods?:string, anyOrigin?:boolean, headers?:Record<string,string>},
 *   verify?:object,                                  // passed through to the verifier (tests: fetchImpl, now, supabaseUrl, subtle, publishableKey)
 * }} [options]
 * @returns {Promise<
 *   {ok:true, sub:string, email:string, claims:object, token:string, user:object|null} |
 *   {ok:false, status:401|503, detail:string, sub:null, email:'', claims:null, token:'', response:Response}
 * >}
 */
export async function requireUser(request, options = {}) {
  const respond = options.respond || {};
  const token = bearerToken(request);
  if (!token) return failure(request, 'missing', respond);

  const verifyOptions = options.verify || {};
  const result = options.live
    ? await assertLiveUser(token, verifyOptions)
    : await verifyAccessToken(token, verifyOptions);

  if (!result.ok) return failure(request, result.reason || 'unauthenticated', respond);

  return {
    ok: true,
    sub: result.sub,
    email: result.email || '',
    claims: result.claims,
    token,
    user: options.live && result.user ? result.user : null,
  };
}

/**
 * requireUser() plus the authoritative /auth/v1/user round-trip. Money-touching
 * calls only.
 * @param {Request} request
 * @param {{respond?:object, verify?:object}} [options]
 */
export function requireLiveUser(request, options = {}) {
  return requireUser(request, { ...options, live: true });
}

/**
 * Guard against a handler that reads a user id from the request body. Call it
 * on any parsed body before using it; it strips the fields a client must never
 * be allowed to assert (design §3.3, §6.3) and reports whether any were present
 * so the handler can log the attempt.
 * @param {object} body
 * @returns {{body:object, stripped:string[]}}
 */
export function stripClientAssertedIdentity(body) {
  const forbidden = ['user_id', 'userId', 'sub', 'email', 'price_id', 'priceId', 'device_id', 'deviceId', 'tier', 'plan_override'];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { body: {}, stripped: [] };
  const clean = { ...body };
  const stripped = [];
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(clean, key)) {
      delete clean[key];
      stripped.push(key);
    }
  }
  return { body: clean, stripped };
}
