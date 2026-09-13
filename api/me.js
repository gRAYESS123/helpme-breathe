/**
 * GET /api/me — the one endpoint the front end calls (design §7.1).
 *
 *   Authorization: Bearer <supabase access token>
 *
 * Response 200
 *   { ok: true, user, entitlement, trial, free_sessions_used, token, token_exp, device_id }
 * with, on every call,
 *   Set-Cookie: __Host-hmb_ent=<token>; Path=/; Secure; SameSite=Lax; Max-Age=1209600
 *   Set-Cookie: __Host-hmb_did=<uuid.mac>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=63072000
 *
 * Errors: 401 { ok:false, reason:'unauthenticated' } on JWT failure. A signed-in
 * user with no subscription gets 200 with tier 'free' and a free token, so the
 * client has one code path.
 *
 * Rules this handler keeps (design §2, §3.3, §5.3):
 *   - the user id comes from the verified JWT `sub`, never from the request;
 *   - the entitlement is read from Postgres only — the provider is never called;
 *   - `next_charge` is read from `subscriptions.display_*`, never a constant;
 *   - if the entitlement read fails, FAIL OPEN to the caller's own cached token:
 *     a valid `__Host-hmb_ent` for the same user is handed back with
 *     `stale: true`; without one the answer is 503 and the client keeps its
 *     localStorage copy. A paying subscriber is never locked out by our outage.
 *   - `assertLiveUser` is NOT used here (it runs on every page load); the JWT's
 *     own hour is the boundary.
 *
 * The device half (`__Host-hmb_did`, `free_sessions_used`) comes from
 * api/_lib/trialguard.js (task 4): the §5.1 cookie/mirror rules, the
 * never-resurrect rule and the devices row live there; this handler only
 * hands the value back as a cookie and in the body. The localStorage mirror is
 * supplied ONLY as the `X-HMB-Device-Mirror` request header — a GET has no
 * body, and an identifier must never travel in a query string, where it would
 * land in request logs and Referer headers. If the device layer is unavailable
 * the entitlement still answers; only the device cookie and counter are omitted.
 *
 * D3 (`TRIAL_ENABLED`) is read in exactly one place, api/trial/eligibility.js
 * (design §2 rule 6); this handler imports that reader rather than the env var.
 *
 * `createMeHandler(deps)` is exported so the test suite can run the handler
 * with stubbed dependencies and no network.
 */

import { kidFor } from './_lib/crypto.js';
import {
  ENT_COOKIE,
  TIER_PRO,
  bearerToken,
  createStore,
  deviceCookie,
  entitlementCookie,
  entitlementFor,
  readCookie,
  signEntitlement,
  toIso,
  verifyEntitlementToken,
} from './_lib/entitlement.js';
import { requireEnv } from './_lib/env.js';
import { createLimiter, rateLimitHeaders } from './_lib/ratelimit.js';
import { clientIp, errorResponse, json, methodNotAllowed, preflight } from './_lib/respond.js';

export const config = { runtime: 'nodejs', maxDuration: 15 };

const METHODS = 'GET, OPTIONS';

/** Generous: every page load of a signed-in visitor calls this. */
const limiter = createLimiter({ name: 'me', limit: 120, windowMs: 60 * 1000 });

/**
 * The mirror of the device cookie, if the client supplied one — header only.
 * A `?device_mirror=` query parameter is deliberately ignored.
 * @param {Request} request
 * @returns {string}
 */
function readMirror(request) {
  const header = request.headers.get('x-hmb-device-mirror');
  return header && header.trim() ? header.trim().slice(0, 200) : '';
}

/**
 * The trial hint for the account page. Cheap and derived from what /api/me
 * already holds; POST /api/trial/eligibility is the authority (§5.4).
 */
function trialHint(rows, entitlement, trialEnabled) {
  if (!trialEnabled) return { available: false, reason: 'trial_disabled' };
  if (Array.isArray(rows) && rows.length > 0) {
    return {
      available: false,
      reason: entitlement.status === 'trialing' ? 'in_trial' : 'already_subscribed',
    };
  }
  return { available: true, reason: 'unchecked' };
}

/**
 * Build the handler from its dependencies.
 *
 * @param {{
 *   verifyAccessToken:(jwt:string)=>Promise<{ok:boolean, sub?:string, email?:string, reason?:string}>,
 *   store:{subscriptionsFor:(id:string)=>Promise<object[]>, profileFor:(id:string)=>Promise<object|null>},
 *   resolveDevice?:(request:Request, options:{mirror:string, now:number})=>Promise<{cookieValue:string, deviceId?:string, freeSessionsUsed?:number}|null>,
 *   secret:string, kid?:string, trialEnabled?:boolean,
 *   now?:()=>number, limiter?:{check:Function}
 * }} deps
 * @returns {{GET:(request:Request)=>Promise<Response>, OPTIONS:(request:Request)=>Promise<Response>}}
 */
export function createMeHandler(deps) {
  const {
    verifyAccessToken,
    store,
    resolveDevice = null,
    secret,
    trialEnabled = false,
    now = () => Date.now(),
  } = deps;
  const rate = deps.limiter || limiter;
  let kidPromise = deps.kid ? Promise.resolve(deps.kid) : null;

  const respond = (request, status, body, headers, cookies = []) => {
    const response = json(status, body, { request, methods: METHODS, headers });
    for (const cookie of cookies) response.headers.append('Set-Cookie', cookie);
    return response;
  };

  async function GET(request) {
    try {
      const limit = rate.check(clientIp(request));
      if (!limit.ok) {
        return respond(request, 429, { ok: false, reason: 'rate_limited' }, rateLimitHeaders(limit, { includeRetryAfter: true }));
      }

      const jwt = bearerToken(request);
      if (!jwt) return respond(request, 401, { ok: false, reason: 'unauthenticated' });
      const identity = await verifyAccessToken(jwt);
      if (!identity || !identity.ok || typeof identity.sub !== 'string' || !identity.sub) {
        return respond(request, 401, { ok: false, reason: 'unauthenticated' });
      }
      const sub = identity.sub;
      const at = now();
      if (!kidPromise) kidPromise = kidFor(secret);
      const kid = await kidPromise;

      // The device half never blocks the entitlement half.
      const cookies = [];
      let deviceId = null;
      let freeSessionsUsed = null;
      if (typeof resolveDevice === 'function') {
        try {
          const device = await resolveDevice(request, { mirror: readMirror(request), now: at, userId: sub });
          if (device && typeof device.cookieValue === 'string' && device.cookieValue) {
            cookies.push(deviceCookie(device.cookieValue));
            deviceId = device.cookieValue;
            freeSessionsUsed = Number.isFinite(device.freeSessionsUsed) ? device.freeSessionsUsed : null;
          }
        } catch (error) {
          console.warn('[me] device resolution failed', { reason: error && error.message ? error.message : String(error) });
        }
      }

      let rows;
      let profile = null;
      try {
        rows = await store.subscriptionsFor(sub);
        profile = await store.profileFor(sub).catch(() => null);
      } catch (error) {
        console.error('[me] entitlement read failed', { reason: error && error.message ? error.message : String(error) });
        return failOpen(request, sub, identity, at, kid, cookies, deviceId, freeSessionsUsed);
      }

      const entitlement = entitlementFor(rows, at);
      const signed = await signEntitlement({ sub, entitlement, secret, kid, now: at });
      cookies.unshift(entitlementCookie(signed.token));

      const body = {
        ok: true,
        user: {
          id: sub,
          email: emailOf(identity, profile),
          created_at: profile && profile.created_at ? toIso(Date.parse(profile.created_at)) : null,
        },
        entitlement: publicEntitlement(entitlement),
        trial: trialHint(rows, entitlement, trialEnabled),
        free_sessions_used: freeSessionsUsed,
        token: signed.token,
        token_exp: signed.payload.exp,
        device_id: deviceId,
      };
      return respond(request, 200, body, undefined, cookies);
    } catch (error) {
      return errorResponse(error, request, { methods: METHODS, label: 'me' });
    }
  }

  /**
   * §5.3: "Entitlement read fails elsewhere (/api/me) — fail open to the cached
   * token." The caller's own `__Host-hmb_ent`, if it verifies for the same
   * user, is handed straight back; the cookie is NOT cleared.
   */
  async function failOpen(request, sub, identity, at, kid, cookies, deviceId, freeSessionsUsed) {
    const cached = readCookie(request, ENT_COOKIE);
    const verified = cached ? await verifyEntitlementToken(cached, secret, { now: at, expectedKid: kid }) : { ok: false };
    if (!verified.ok || verified.payload.sub !== sub) {
      return respond(request, 503, { ok: false, reason: 'entitlement_unavailable' }, { 'Retry-After': '30' }, cookies);
    }
    const payload = verified.payload;
    cookies.unshift(entitlementCookie(cached));
    // The token carries `pe` (trial end or period end), never `access_until`
    // itself, so only the field `pe` actually is gets a value here.
    const status = typeof payload.st === 'string' && payload.st ? payload.st : 'none';
    const periodEnd = Number.isFinite(payload.pe) && payload.pe > 0 ? toIso(payload.pe * 1000) : null;
    return respond(
      request,
      200,
      {
        ok: true,
        stale: true,
        user: { id: sub, email: emailOf(identity, null), created_at: null },
        entitlement: {
          tier: payload.tier === TIER_PRO ? TIER_PRO : 'free',
          status,
          plan: payload.plan || null,
          trial_ends_at: status === 'trialing' ? periodEnd : null,
          current_period_end: status === 'trialing' ? null : periodEnd,
          cancel_at: null,
          access_until: null,
          next_charge: null,
          provider: null,
          ui: 'stale',
        },
        trial: { available: false, reason: 'unavailable' },
        free_sessions_used: freeSessionsUsed,
        token: cached,
        token_exp: payload.exp,
        device_id: deviceId,
      },
      undefined,
      cookies,
    );
  }

  async function OPTIONS(request) {
    return preflight(request, { methods: METHODS });
  }

  return { GET, OPTIONS };
}

/**
 * The address to show: the verified JWT's claim first, the profile row second.
 * `verifyAccessToken` returns '' (not undefined) when the claim is absent, so
 * an empty string must fall through rather than win.
 */
function emailOf(identity, profile) {
  if (identity && typeof identity.email === 'string' && identity.email) return identity.email;
  if (profile && typeof profile.email === 'string' && profile.email) return profile.email;
  return null;
}

/** The `entitlement` object of §7.1 — nothing internal, no row. */
function publicEntitlement(entitlement) {
  return {
    tier: entitlement.tier,
    status: entitlement.status,
    plan: entitlement.plan,
    trial_ends_at: entitlement.trial_ends_at,
    current_period_end: entitlement.current_period_end,
    cancel_at: entitlement.cancel_at,
    access_until: entitlement.access_until,
    next_charge: entitlement.next_charge,
    provider: entitlement.provider,
    ui: entitlement.ui,
  };
}

/* ------------------------------------------------------------- wiring ----- */

let depsPromise = null;

/**
 * Production dependencies, loaded lazily so this module evaluates (and the
 * test suite runs) without api/_lib/supabase.js or api/_lib/trialguard.js on
 * disk. supabase.js is required; trialguard.js is optional (see the header).
 */
async function defaultDeps() {
  if (depsPromise) return depsPromise;
  depsPromise = (async () => {
    const env = requireEnv(['LICENSE_SECRET']);
    const supabase = await import('./_lib/supabase.js');
    let resolveDevice = null;
    try {
      const trialguard = await import('./_lib/trialguard.js');
      const pepper = requireEnv(['DEVICE_PEPPER']).DEVICE_PEPPER;
      const ledger = trialguard.createLedger((method, path, options = {}) =>
        supabase.db(path, { method, body: options.body, prefer: options.prefer }),
      );
      // Adapt trialguard's resolveDevice({ cookie, mirror, pepper, now, ledger })
      // to the (request, { mirror, now }) shape this handler calls.
      resolveDevice = async (request, options) => {
        const device = await trialguard.resolveDevice({
          cookie: trialguard.readDeviceCookie(request),
          mirror: options.mirror || undefined,
          pepper,
          now: options.now,
          ledger,
        });
        return {
          cookieValue: device.value,
          deviceId: device.deviceId,
          freeSessionsUsed: Number(device.row && device.row.free_sessions_used) || 0,
        };
      };
    } catch (error) {
      console.warn('[me] device layer unavailable; answering without __Host-hmb_did', {
        reason: error && error.message ? error.message : String(error),
      });
    }
    // D3 is read by api/trial/eligibility.js and nowhere else (§2 rule 6).
    // If that module cannot load, the trial cannot be started either, so
    // "disabled" is the truthful hint.
    let trialEnabled = false;
    try {
      const eligibility = await import('./trial/eligibility.js');
      trialEnabled = typeof eligibility.trialEnabled === 'function' ? eligibility.trialEnabled() === true : false;
    } catch (error) {
      console.warn('[me] trial module unavailable; trial hint reads as disabled', {
        reason: error && error.message ? error.message : String(error),
      });
    }
    return {
      verifyAccessToken: supabase.verifyAccessToken,
      store: createStore(supabase.db),
      resolveDevice,
      secret: env.LICENSE_SECRET,
      trialEnabled,
    };
  })();
  depsPromise.catch(() => {
    depsPromise = null;
  });
  return depsPromise;
}

/** @param {Request} request */
export async function GET(request) {
  try {
    return (await createMeHandler(await defaultDeps())).GET(request);
  } catch (error) {
    return errorResponse(error, request, { methods: METHODS, label: 'me' });
  }
}

/** @param {Request} request */
export async function OPTIONS(request) {
  return preflight(request, { methods: METHODS });
}

/** @param {Request} request */
export async function POST(request) {
  return methodNotAllowed(request, METHODS);
}
