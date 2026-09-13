/**
 * /api/session/count — the free-session counter beacon (D1, TIMER_FREE_SESSIONS).
 *
 * Specification: docs/private/ACCOUNTS_BILLING_DESIGN.md §0.2 D1, §5.1, §7.3.
 *
 *   GET  /api/session/count                      read the count for this device
 *   POST /api/session/count { device_mirror? }   count one completed session
 *
 * Both answer `{ ok: true, device_id, free_sessions_used }` and set the
 * `__Host-hmb_did` cookie, minting a MAC'd id when the browser has none. That
 * is how a signed-out visitor who has never called GET /api/me gets a device
 * anchor at all; the counter and the trial lock share one cookie by design.
 *
 * No account is needed. The counter is soft (§7.3): it never denies anything
 * by itself, `js/entitlements.js#requireTimer` reads it, and clearing cookies
 * resets it. What this endpoint must NOT allow is a third-party page planting a
 * device id on a stranger's browser, so:
 *
 *   - POST is same-origin only (Origin must match the site), and the mirror is
 *     read from a JSON body, which a cross-site form post cannot send;
 *   - GET reads only the cookie, never a query parameter, and never a mirror;
 *   - GET never writes: no row is inserted and nothing is bumped, so a crawler
 *     without a cookie cannot fill the devices table. The row is created by
 *     the first POST.
 *
 * On a ledger outage the answer is 200 `{ ok:false, free_sessions_used:null }`
 * with a MAC'd cookie, and the client falls back to its local count.
 *
 * No fingerprinting. No signals in the body other than the MAC'd mirror.
 *
 * `createSessionCountHandler(deps)` is exported so tools/trialguard.test.mjs
 * can drive the HTTP path with a stubbed database and no network.
 */

import { db } from '../_lib/supabase.js';
import { requireEnv } from '../_lib/env.js';
import { createLimiter, rateLimitHeaders } from '../_lib/ratelimit.js';
import {
  clientIp,
  errorResponse,
  json,
  preflight,
  readJsonBody,
  resolveSameOrigin,
} from '../_lib/respond.js';
import { createLedger, deviceCookieHeader, readDeviceCookie, runSessionCount } from '../_lib/trialguard.js';

export const config = { runtime: 'nodejs', maxDuration: 10 };

const METHODS = 'GET, POST, OPTIONS';

/**
 * Adapt the PostgREST helper to `createLedger()`'s request shape. `Prefer` is
 * passed once, through the helper's own option, never as a raw header too.
 * @param {typeof db} dbImpl
 */
function ledgerRequestWith(dbImpl) {
  return (method, path, options = {}) => dbImpl(path, { method, body: options.body, prefer: options.prefer });
}

function withCookie(response, cookieValue) {
  if (cookieValue) response.headers.append('Set-Cookie', deviceCookieHeader(cookieValue));
  return response;
}

/**
 * Build the handler with explicit dependencies. Production uses the defaults;
 * the test suite injects stubs.
 *
 * @param {{
 *   db?:typeof db,
 *   requireEnv?:typeof requireEnv,
 *   limiter?:{check:(key:string)=>object},
 *   now?:()=>number,
 * }} [deps]
 */
export function createSessionCountHandler(deps = {}) {
  const d = {
    db,
    requireEnv,
    /** A session takes minutes to complete; 30 beacons a minute per IP is generous. */
    limiter: createLimiter({ name: 'session-count', limit: 30, windowMs: 60 * 1000 }),
    now: Date.now,
    ...deps,
  };

  async function handle(request, { increment, mirror }) {
    const limit = d.limiter.check(clientIp(request));
    if (!limit.ok) {
      return json(
        429,
        { ok: false, error: 'rate_limited' },
        { request, methods: METHODS, headers: rateLimitHeaders(limit, { includeRetryAfter: true }) },
      );
    }

    const env = d.requireEnv(['DEVICE_PEPPER']);
    const result = await runSessionCount({
      cookie: readDeviceCookie(request),
      mirror,
      increment,
      env,
      ledger: createLedger(ledgerRequestWith(d.db)),
      now: d.now(),
    });
    return withCookie(json(result.status, result.body, { request, methods: METHODS }), result.cookieValue);
  }

  async function GET(request) {
    try {
      return await handle(request, { increment: false, mirror: '' });
    } catch (error) {
      return errorResponse(error, request, { methods: METHODS, label: 'session' });
    }
  }

  async function POST(request) {
    try {
      if (!resolveSameOrigin(request)) {
        return json(403, { ok: false, error: 'cross_origin' }, { request, methods: METHODS });
      }
      const body = await readJsonBody(request, { maxBytes: 1024 });
      const mirror =
        body.ok && typeof body.data.device_mirror === 'string' ? body.data.device_mirror.slice(0, 128) : '';
      return await handle(request, { increment: true, mirror });
    } catch (error) {
      return errorResponse(error, request, { methods: METHODS, label: 'session' });
    }
  }

  return {
    GET,
    POST,
    OPTIONS: (request) => preflight(request, { methods: METHODS }),
  };
}

const handler = createSessionCountHandler();

export const GET = handler.GET;
export const POST = handler.POST;
export const OPTIONS = handler.OPTIONS;
