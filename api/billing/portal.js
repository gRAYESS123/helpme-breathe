/**
 * POST /api/billing/portal — mint customer-portal links (design §5.7).
 *
 *   Authorization: Bearer <supabase access token>     (assertLiveUser: money-touching)
 *   -> 200 { ok:true, overview, cancel, update_payment_method, expires_in }
 *
 * Links are minted per request and never stored: the provider says portal
 * sessions "are temporary and shouldn't be cached". Every response is
 * `Cache-Control: no-store` (api/_lib/respond.js). /account fetches these on
 * click, not on load.
 *
 * Errors
 *   401 { ok:false, reason:'unauthenticated' }
 *   403 { ok:false, error:'cross_origin' }
 *   404 { ok:false, error:'no_subscription' }   nothing to manage
 *   429 { ok:false, error:'rate_limited' }
 *   502 { ok:false, error:'provider_unavailable' }
 *
 * No provider is named here; MOR_PROVIDER picks the adapter.
 */

import { requireLiveUser } from '../_lib/authz.js';
import { dblimit } from '../_lib/dblimit.js';
import { LIVE_STATUSES, createStore, winningRow } from '../_lib/entitlement.js';
import { isProduction, providerName, readEnv, requireEnv } from '../_lib/env.js';
import { PROVIDER_ENV_OPTIONAL, getProvider } from '../_lib/providers/index.js';
import { errorResponse, json, methodNotAllowed, preflight, resolveSameOrigin } from '../_lib/respond.js';
import { db } from '../_lib/supabase.js';

export const config = { runtime: 'nodejs', maxDuration: 15 };

const METHODS = 'POST, OPTIONS';

/** Per-user limit on portal links: generous, since every /account click mints one. */
export const LIMIT = Object.freeze({ window: 3600, max: 30 });

/**
 * The subscription /account is managing: the live row with the furthest access.
 * @param {object[]} rows
 * @returns {object|null}
 */
export function manageableRow(rows) {
  const live = (rows || []).filter((row) => row && LIVE_STATUSES.includes(String(row.status)) && row.provider_subscription_id);
  return winningRow(live);
}

/**
 * @param {{
 *   auth:(request:Request)=>Promise<{ok:boolean, sub?:string, response?:Response}>,
 *   store:{subscriptionsFor:(userId:string)=>Promise<object[]>},
 *   provider:object, providerCtx:object,
 *   limiter?:(sub:string)=>Promise<boolean>,
 * }} deps
 */
export function createPortalHandler(deps) {
  const { auth, store, provider, providerCtx } = deps;
  const limiter = deps.limiter || (async () => true);

  async function POST(request) {
    try {
      if (!resolveSameOrigin(request)) return json(403, { ok: false, error: 'cross_origin' }, { request, methods: METHODS });
      const user = await auth(request);
      if (!user.ok) return user.response;

      if (!(await limiter(user.sub))) return json(429, { ok: false, error: 'rate_limited' }, { request, methods: METHODS, headers: { 'Retry-After': '60' } });

      const row = manageableRow(await store.subscriptionsFor(user.sub));
      if (!row || !row.provider_customer_id) return json(404, { ok: false, error: 'no_subscription' }, { request, methods: METHODS });

      let session;
      try {
        session = await provider.createPortalSession(String(row.provider_customer_id), [String(row.provider_subscription_id)], { ...providerCtx, sub: user.sub });
      } catch (error) {
        console.error('[billing-portal] provider call failed', { reason: error && error.message ? error.message : String(error) });
        return json(502, { ok: false, error: 'provider_unavailable', message: 'We could not reach the billing service. Try again in a minute, or use the link in your emailed receipt.' }, { request, methods: METHODS });
      }

      return json(
        200,
        {
          ok: true,
          overview: session.overview || null,
          cancel: session.cancel || null,
          update_payment_method: session.update_payment_method || null,
          expires_in: Number.isFinite(session.expires_in) ? session.expires_in : 900,
        },
        { request, methods: METHODS },
      );
    } catch (error) {
      return errorResponse(error, request, { methods: METHODS, label: 'billing-portal' });
    }
  }

  return { POST };
}

/* --------------------------------------------------------------- wiring --- */

function productionDeps() {
  const env = requireEnv(['MOR_API_KEY']);
  for (const name of PROVIDER_ENV_OPTIONAL) env[name] = readEnv(name);
  return {
    auth: (request) => requireLiveUser(request, { respond: { methods: METHODS } }),
    store: createStore(db),
    provider: getProvider(providerName()),
    providerCtx: { env, fetchImpl: globalThis.fetch, isProd: isProduction() },
    limiter: (sub) => dblimit(`billing:portal:${sub}`, LIMIT.window, LIMIT.max, { failOpen: true }),
  };
}

export async function POST(request) {
  try {
    return await createPortalHandler(productionDeps()).POST(request);
  } catch (error) {
    return errorResponse(error, request, { methods: METHODS, label: 'billing-portal' });
  }
}

export async function OPTIONS(request) {
  return preflight(request, { methods: METHODS });
}

export async function GET(request) {
  return methodNotAllowed(request, METHODS);
}
