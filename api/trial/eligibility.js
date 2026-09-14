/**
 * POST /api/trial/eligibility — decides, reserves, and creates the transaction.
 *
 * Specification: docs/private/ACCOUNTS_BILLING_DESIGN.md §5.4. The logic lives
 * in api/_lib/trialguard.js (`runEligibility`); this file is the HTTP plumbing
 * and the ONE place the D3 flag `TRIAL_ENABLED` is read (§2 rule 6).
 *
 * Request
 *   Authorization: Bearer <supabase access token>
 *   { "plan": "monthly" | "yearly", "device_mirror": "<uuid>.<mac>" }
 *
 *   That is the whole body. No signals, no consent flag, no device id, and no
 *   client-supplied price. `device_mirror` is honoured only when its MAC
 *   verifies; anything else is discarded and counted as one soft signal. Any
 *   identity- or price-shaped key in the body is stripped and logged (§3.3).
 *
 * Response 200
 *   { ok, device_id, reservation_id, trial, plan,
 *     checkout: { provider, transaction_id }, price_preview, reasons }
 *
 *   There is no `price_id` in the response, by design: the browser opens the
 *   overlay with `transactionId` and the price was fixed on the server.
 *
 * Errors
 *   401 { ok:false, reason:'unauthenticated' }   JWT missing / invalid / session revoked
 *   503 { ok:false, reason:'auth_unavailable' }  the identity provider did not answer
 *   403 { ok:false, error:'cross_origin' }       not called from the site itself
 *   400 { ok:false, error:'bad_plan' | 'bad_request' }
 *   502 { ok:false, error:'checkout_unavailable' } the provider could not create a transaction
 *   503                                          configuration missing (never a value)
 *
 * A trial-ledger failure is NOT an error status: it is 200 with
 * `trial: false, reasons: ['ledger_unavailable']` and a no-trial transaction,
 * so the buyer can still subscribe at the full price (§5.3). A rate-limiter
 * outage is treated the same way (it is the same database).
 *
 * Every 2xx response sets `__Host-hmb_did` (§5.1); this endpoint and
 * GET /api/me are the issuers of that cookie for signed-in users.
 *
 * `createEligibilityHandler(deps)` is exported so tools/trialguard.test.mjs
 * can drive the whole HTTP path with stubbed dependencies and no network.
 */

import { db } from '../_lib/supabase.js';
import { requireLiveUser, stripClientAssertedIdentity } from '../_lib/authz.js';
import { dblimitCheck } from '../_lib/dblimit.js';
import { getProvider } from '../_lib/providers/index.js';
import { isProduction, providerName, readEnv, requireEnv } from '../_lib/env.js';
import {
  clientIp,
  errorResponse,
  json,
  methodNotAllowed,
  preflight,
  readJsonBody,
  resolveSameOrigin,
} from '../_lib/respond.js';
import {
  PLANS,
  createLedger,
  deviceCookieHeader,
  readDeviceCookie,
  runEligibility,
} from '../_lib/trialguard.js';

export const config = { runtime: 'nodejs', maxDuration: 20 };

const METHODS = 'POST, OPTIONS';

/** Env vars this endpoint needs. The trial prices are only required when D3 is on. */
export const REQUIRED_ENV = Object.freeze(['TRIAL_PEPPER', 'DEVICE_PEPPER', 'MOR_API_KEY', 'MOR_PRICE_MONTHLY', 'MOR_PRICE_YEARLY']);
export const TRIAL_ENV = Object.freeze(['MOR_PRICE_MONTHLY_TRIAL', 'MOR_PRICE_YEARLY_TRIAL']);
export const OPTIONAL_ENV = Object.freeze([
  'MOR_API_BASE',
  'MOR_SANDBOX',
  'SITE_ORIGIN',
  'MOR_API_USERNAME',
  'MOR_API_PASSWORD',
  'MOR_MANAGED_PAYMENTS',
]);

/**
 * The ONE place D3 is read. Anything but the literal string `true` is off,
 * which is the safer default for a flag that mints card-required trials.
 * @param {(name:string)=>string} [read] env reader (tests inject one)
 * @returns {boolean}
 */
export function trialEnabled(read = readEnv) {
  return String(read('TRIAL_ENABLED') || '').trim().toLowerCase() === 'true';
}

/**
 * Adapt the PostgREST helper to the request shape `createLedger()` expects:
 * `(method, path, { body, prefer })`, throwing on any non-2xx. The throw is
 * what makes the trial fail closed. `Prefer` is passed once, through the
 * helper's own option, never duplicated as a raw header.
 * @param {typeof db} dbImpl
 */
function ledgerRequestWith(dbImpl) {
  return (method, path, options = {}) => dbImpl(path, { method, body: options.body, prefer: options.prefer });
}

/**
 * The boolean limiter `runEligibility` expects, with one difference from a
 * plain `dblimit()`: an unreachable limiter THROWS instead of answering
 * `false`, so the caller reports `ledger_unavailable` (and alerts) rather than
 * `rate_limited`. Both fail closed on the trial; only the reason differs.
 * @param {typeof dblimitCheck} check
 */
function limiterWith(check) {
  return async (bucket, windowSeconds, limit) => {
    const result = await check(bucket, windowSeconds, limit);
    if (result.reason === 'limiter_unavailable') throw new Error('rate limiter unavailable');
    return result.allowed === true;
  };
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
 *   requireLiveUser?:typeof requireLiveUser,
 *   db?:typeof db,
 *   dblimitCheck?:typeof dblimitCheck,
 *   getProvider?:typeof getProvider,
 *   providerName?:typeof providerName,
 *   readEnv?:typeof readEnv,
 *   requireEnv?:typeof requireEnv,
 *   isProduction?:typeof isProduction,
 *   now?:()=>number,
 *   alert?:(kind:string, detail:object)=>void,
 * }} [deps]
 */
export function createEligibilityHandler(deps = {}) {
  const d = {
    requireLiveUser,
    db,
    dblimitCheck,
    getProvider,
    providerName,
    readEnv,
    requireEnv,
    isProduction,
    now: Date.now,
    alert: undefined,
    ...deps,
  };

  async function POST(request) {
    try {
      // Same-origin only. The site's own pages always send Origin on POST; a
      // cross-site form post cannot pass a JSON body and would still fail here.
      if (!resolveSameOrigin(request)) {
        return json(403, { ok: false, error: 'cross_origin' }, { request, methods: METHODS });
      }

      // Money-touching: the live check, not just a signature check (§4.5).
      // 401 on any JWT failure; 503 when Supabase itself did not answer.
      const auth = await d.requireLiveUser(request, { respond: { methods: METHODS } });
      if (!auth.ok) return auth.response;
      if (!auth.email) return json(401, { ok: false, reason: 'unauthenticated' }, { request, methods: METHODS });

      const body = await readJsonBody(request, { maxBytes: 2048 });
      if (!body.ok) return json(400, { ok: false, error: 'bad_request' }, { request, methods: METHODS });
      const { body: data, stripped } = stripClientAssertedIdentity(body.data);
      if (stripped.length > 0) console.warn('[trial] ignored client-asserted fields:', stripped.join(', '));

      const plan = typeof data.plan === 'string' ? data.plan.trim() : '';
      if (!PLANS.includes(plan)) {
        return json(400, { ok: false, error: 'bad_plan', plans: PLANS }, { request, methods: METHODS });
      }
      const mirror = typeof data.device_mirror === 'string' ? data.device_mirror.slice(0, 128) : '';

      const enabled = trialEnabled(d.readEnv);
      const provider = d.getProvider(d.providerName());
      // An adapter whose trial is a property of the session (not a second
      // price) does not need the _TRIAL variables; when they are set anyway,
      // they are used.
      const needsTrialPrices = enabled && provider.separateTrialPrices !== false;
      const env = {
        ...d.requireEnv(REQUIRED_ENV),
        ...(needsTrialPrices ? d.requireEnv(TRIAL_ENV) : {}),
      };
      for (const name of OPTIONAL_ENV) env[name] = d.readEnv(name);
      if (!needsTrialPrices) for (const name of TRIAL_ENV) env[name] = d.readEnv(name);

      const providerCtx = { env, fetchImpl: globalThis.fetch, isProd: d.isProduction(), sub: auth.sub };

      const result = await runEligibility({
        sub: auth.sub,
        email: auth.email,
        plan,
        cookie: readDeviceCookie(request),
        mirror,
        ip: clientIp(request),
        countryCode: (request.headers.get('x-vercel-ip-country') || '').toUpperCase().slice(0, 2),
        trialEnabled: enabled,
        env,
        ledger: createLedger(ledgerRequestWith(d.db)),
        dblimit: limiterWith(d.dblimitCheck),
        provider,
        providerCtx,
        now: d.now(),
        alert: d.alert,
      });

      return withCookie(json(result.status, result.body, { request, methods: METHODS }), result.cookieValue);
    } catch (error) {
      return errorResponse(error, request, { methods: METHODS, label: 'trial' });
    }
  }

  return {
    POST,
    GET: (request) => methodNotAllowed(request, METHODS),
    OPTIONS: (request) => preflight(request, { methods: METHODS }),
  };
}

const handler = createEligibilityHandler();

export const POST = handler.POST;
export const GET = handler.GET;
export const OPTIONS = handler.OPTIONS;
