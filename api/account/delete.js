/**
 * POST /api/account/delete — account deletion that does not fight the
 * subscription (design §11.5), in this order and no other:
 *
 *   1. REFUSE while a payment dispute is open or a past_due balance stands.
 *   2. Cancel every live subscription at the merchant of record FIRST and
 *      VERIFY the cancellation came back, before touching Supabase. A deletion
 *      that silently leaves billing running is the worst possible outcome, so
 *      a cancel that does not verify aborts the whole request with nothing
 *      changed.
 *   3. DETACH, do not cascade, the subscription rows: user_id = null,
 *      detached_at = now(), provider ids kept — so later webhooks for a
 *      still-live subscription still reconcile instead of becoming orphans.
 *   4. Delete the auth.users row (cascading profiles and checkout_intents).
 *   5. Null trial_claims.user_id and devices.trial_user_id; keep the hashes
 *      until the 24-month ceiling, or deleting an account would reset the
 *      free-trial limit.
 *   6. Tell the user that the merchant of record holds its own copy as a
 *      separate controller.
 *
 *   Authorization: Bearer <supabase access token>   (assertLiveUser)
 *
 * Response 200 { ok:true, deleted:true, subscriptions_cancelled, note }
 *          409 { ok:false, reason:'dispute_open'|'past_due', message }
 *          502 { ok:false, reason:'cancel_failed', message }  — nothing was changed
 *
 * Cancellation uses `effective_from: 'next_billing_period'` (§5.9's default in
 * every branch, symmetric with the provider's own portal): the person keeps
 * nothing they have not paid for, and nothing further is charged. A row whose
 * `cancel_at` is already set (a scheduled cancellation the provider has
 * already confirmed by webhook) is not cancelled a second time.
 *
 * `createDeleteHandler(deps)` is exported for the test suite.
 */

import {
  LIVE_STATUSES,
  bearerToken,
  clearEntitlementCookie,
  createStore,
  toIso,
} from '../_lib/entitlement.js';
import { isProduction, providerName, readEnv, requireEnv } from '../_lib/env.js';
import { getProvider } from '../_lib/providers/index.js';
import { createLimiter, rateLimitHeaders } from '../_lib/ratelimit.js';
import { clientIp, errorResponse, json, methodNotAllowed, preflight } from '../_lib/respond.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

const METHODS = 'POST, OPTIONS';

const limiter = createLimiter({ name: 'account-delete', limit: 5, windowMs: 60 * 1000 });

export const MESSAGES = Object.freeze({
  dispute_open:
    "We can't delete this account while a payment dispute is open. Email contact@helpmebreath.com and we'll sort it out.",
  past_due:
    "We can't delete this account while a payment is outstanding. Update your card or cancel from your account page first, or email contact@helpmebreath.com and we'll sort it out.",
  cancel_failed:
    "We couldn't confirm that your subscription was cancelled, so nothing has been deleted. Try again in a minute, or email contact@helpmebreath.com.",
  done:
    'Your account has been deleted. Payments are handled by a merchant of record, which keeps its own copy of your ' +
    'payment record as a separate data controller; contact it directly to have that erased too.',
});

/**
 * Did the adapter confirm the cancellation? Accepts the adapter contract's
 * NormalizedEvent-shaped state (`status: 'canceled'` or a scheduled cancel) or
 * a plain `{ ok: true }`. Anything else is NOT verified.
 * @param {unknown} result
 * @returns {boolean}
 */
export function cancellationVerified(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.ok === false) return false;
  if (result.status === 'canceled') return true;
  if (result.scheduledChange && result.scheduledChange.action === 'cancel') return true;
  return result.ok === true;
}

/**
 * @param {{
 *   assertLiveUser:(jwt:string)=>Promise<{ok:boolean, sub?:string, email?:string}>,
 *   store:ReturnType<typeof createStore>,
 *   provider:{id:string, cancelSubscription:(id:string, options:{effectiveFrom:string}, ctx:object)=>Promise<object>},
 *   providerCtx?:object,
 *   deleteAuthUser:(userId:string)=>Promise<void>,
 *   now?:()=>number, limiter?:{check:Function}
 * }} deps
 */
export function createDeleteHandler(deps) {
  const { assertLiveUser, store, provider, providerCtx = {}, deleteAuthUser, now = () => Date.now() } = deps;
  const rate = deps.limiter || limiter;

  const respond = (request, status, body, headers, clearCookie = false) => {
    const response = json(status, body, { request, methods: METHODS, headers });
    if (clearCookie) response.headers.append('Set-Cookie', clearEntitlementCookie());
    return response;
  };

  async function POST(request) {
    try {
      const limit = rate.check(clientIp(request));
      if (!limit.ok) {
        return respond(request, 429, { ok: false, reason: 'rate_limited' }, rateLimitHeaders(limit, { includeRetryAfter: true }));
      }
      const jwt = bearerToken(request);
      if (!jwt) return respond(request, 401, { ok: false, reason: 'unauthenticated' });
      const identity = await assertLiveUser(jwt);
      if (!identity || !identity.ok || typeof identity.sub !== 'string' || !identity.sub) {
        return respond(request, 401, { ok: false, reason: 'unauthenticated' });
      }
      const sub = identity.sub;
      const rows = await store.subscriptionsFor(sub);

      // 1. Refuse while a dispute is open or a past_due balance stands.
      if (rows.some((row) => row && row.dispute_open === true)) {
        return respond(request, 409, { ok: false, reason: 'dispute_open', message: MESSAGES.dispute_open });
      }
      if (rows.some((row) => row && row.status === 'past_due')) {
        return respond(request, 409, { ok: false, reason: 'past_due', message: MESSAGES.past_due });
      }

      // 2. Cancel at the provider and verify, before touching Supabase.
      const toCancel = rows.filter(
        (row) => row && LIVE_STATUSES.includes(String(row.status)) && row.provider_subscription_id && !row.cancel_at,
      );
      let cancelled = 0;
      for (const row of toCancel) {
        let result;
        try {
          result = await provider.cancelSubscription(
            String(row.provider_subscription_id),
            { effectiveFrom: 'next_billing_period' },
            { ...providerCtx, sub },
          );
        } catch (error) {
          console.error('[account-delete] cancel threw', { provider: provider.id, reason: error && error.message ? error.message : String(error) });
          return respond(request, 502, { ok: false, reason: 'cancel_failed', message: MESSAGES.cancel_failed });
        }
        if (!cancellationVerified(result)) {
          console.error('[account-delete] cancel not verified', { provider: provider.id, reason: result && result.reason ? result.reason : 'unverified' });
          return respond(request, 502, { ok: false, reason: 'cancel_failed', message: MESSAGES.cancel_failed });
        }
        cancelled += 1;
      }

      // 3. Detach, do not cascade.
      const nowIso = toIso(now());
      const detached = await store.detachSubscriptions(sub, nowIso);

      // 4. Delete the auth.users row (cascades profiles and checkout_intents).
      await deleteAuthUser(sub);

      // 5. Keep the trial ledger, drop the link.
      await store.unlinkTrialLedger(sub);

      console.log('[account-delete] done', { subscriptions_cancelled: cancelled, subscriptions_detached: detached.length });

      // 6. Say who else holds a copy.
      return respond(
        request,
        200,
        {
          ok: true,
          deleted: true,
          subscriptions_cancelled: cancelled,
          subscriptions_detached: detached.length,
          message: MESSAGES.done,
        },
        undefined,
        true,
      );
    } catch (error) {
      return errorResponse(error, request, { methods: METHODS, label: 'account-delete' });
    }
  }

  async function OPTIONS(request) {
    return preflight(request, { methods: METHODS });
  }

  return { POST, OPTIONS };
}

/* ------------------------------------------------------------- wiring ----- */

/** Optional variables the adapters read when present. */
const OPTIONAL_PROVIDER_ENV = ['MOR_API_BASE', 'MOR_API_USERNAME', 'MOR_API_PASSWORD', 'MOR_SANDBOX'];

/**
 * Delete a user through the Supabase Auth admin API — verified against
 * supabase/auth-js GoTrueAdminApi.deleteUser: `DELETE {auth}/admin/users/{id}`
 * with `{ should_soft_delete }`, service key in `apikey` + `Authorization`.
 * Used only when api/_lib/supabase.js does not export its own `deleteAuthUser`.
 */
async function deleteAuthUserViaAdminApi(userId) {
  const env = requireEnv(['SUPABASE_URL', 'SUPABASE_SECRET_KEY']);
  const base = env.SUPABASE_URL.replace(/\/+$/, '');
  const response = await fetch(`${base}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ should_soft_delete: false }),
  });
  if (!response.ok) {
    const error = new Error(`auth admin delete failed with HTTP ${response.status}`);
    error.statusCode = 502;
    throw error;
  }
}

let depsPromise = null;

async function defaultDeps() {
  if (depsPromise) return depsPromise;
  depsPromise = (async () => {
    const supabase = await import('../_lib/supabase.js');
    const providerEnv = requireEnv(['MOR_API_KEY']);
    for (const name of OPTIONAL_PROVIDER_ENV) {
      const value = readEnv(name);
      if (value) providerEnv[name] = value;
    }
    return {
      assertLiveUser: supabase.assertLiveUser,
      store: createStore(supabase.db),
      provider: getProvider(providerName()),
      providerCtx: { env: providerEnv, isProd: isProduction() },
      deleteAuthUser:
        typeof supabase.deleteAuthUser === 'function' ? supabase.deleteAuthUser : deleteAuthUserViaAdminApi,
    };
  })();
  depsPromise.catch(() => {
    depsPromise = null;
  });
  return depsPromise;
}

/** @param {Request} request */
export async function POST(request) {
  try {
    return createDeleteHandler(await defaultDeps()).POST(request);
  } catch (error) {
    return errorResponse(error, request, { methods: METHODS, label: 'account-delete' });
  }
}

/** @param {Request} request */
export async function OPTIONS(request) {
  return preflight(request, { methods: METHODS });
}

/** @param {Request} request */
export async function GET(request) {
  return methodNotAllowed(request, METHODS);
}
