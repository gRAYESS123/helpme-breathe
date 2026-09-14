/**
 * POST /api/billing/switch — switch monthly to annual (design §5.8).
 *
 *   Authorization: Bearer <supabase access token>     (assertLiveUser: money-touching)
 *   { "plan": "yearly" }
 *   -> 200 { ok:true, plan:'yearly', next_billed_at, message }
 *
 * Offered only monthly -> yearly, and only where it saves the customer money:
 * an `active` monthly subscription. A trial is not switched (the trial price
 * carries the interval; let it convert first), and a past-due or paused one has
 * something else to sort out. The switch is prorated so the customer pays only
 * the difference now.
 *
 * The price id comes from the adapter's `priceIdFor({ plan:'yearly', trial:false })`,
 * i.e. from MOR_PRICE_YEARLY — never from the request.
 *
 * Errors: 401, 403 cross_origin, 400 bad_request, 404 no_subscription,
 * 409 { error: 'not_eligible', reason }, 429, 502, 503 (price not configured).
 */

import { requireLiveUser } from '../_lib/authz.js';
import { dblimit } from '../_lib/dblimit.js';
import { LIVE_STATUSES, createStore, toIso, toMs, winningRow } from '../_lib/entitlement.js';
import { isProduction, providerName, readEnv, requireEnv } from '../_lib/env.js';
import { PROVIDER_ENV_OPTIONAL, getProvider } from '../_lib/providers/index.js';
import { errorResponse, json, methodNotAllowed, preflight, readJsonBody, resolveSameOrigin } from '../_lib/respond.js';
import { db } from '../_lib/supabase.js';

export const config = { runtime: 'nodejs', maxDuration: 15 };

const METHODS = 'POST, OPTIONS';

export const LIMIT = Object.freeze({ window: 3600, max: 10 });

/** The only switch on offer: monthly -> yearly. */
export const SWITCHES = Object.freeze({ monthly: 'yearly' });

/**
 * Why a row may not switch, or null when it may.
 * @param {object|null} row
 * @param {string} targetPlan
 * @returns {string|null}
 */
export function ineligibleReason(row, targetPlan) {
  if (!row) return 'no_subscription';
  if (SWITCHES[row.plan] !== targetPlan) return row.plan === targetPlan ? 'already_on_plan' : 'unsupported_switch';
  if (row.status !== 'active') return `status_${row.status}`;
  if (row.cancel_at) return 'cancel_scheduled';
  return null;
}

/**
 * @param {object[]} rows
 * @returns {object|null}
 */
export function switchableRow(rows) {
  const live = (rows || []).filter((row) => row && LIVE_STATUSES.includes(String(row.status)) && row.provider_subscription_id);
  return winningRow(live);
}

/**
 * @param {{
 *   auth:(request:Request)=>Promise<{ok:boolean, sub?:string, response?:Response}>,
 *   store:{subscriptionsFor:(userId:string)=>Promise<object[]>},
 *   updateSubscription:(rowId:string, patch:object)=>Promise<unknown>,
 *   provider:object, providerCtx:object, env:Record<string,string>,
 *   limiter?:(sub:string)=>Promise<boolean>,
 * }} deps
 */
export function createSwitchHandler(deps) {
  const { auth, store, updateSubscription, provider, providerCtx, env } = deps;
  const limiter = deps.limiter || (async () => true);

  async function POST(request) {
    try {
      if (!resolveSameOrigin(request)) return json(403, { ok: false, error: 'cross_origin' }, { request, methods: METHODS });
      const user = await auth(request);
      if (!user.ok) return user.response;

      const body = await readJsonBody(request, { maxBytes: 1024 });
      if (!body.ok) return json(400, { ok: false, error: 'bad_request' }, { request, methods: METHODS });
      const targetPlan = typeof body.data.plan === 'string' ? body.data.plan.trim() : '';
      if (!Object.values(SWITCHES).includes(targetPlan)) {
        return json(400, { ok: false, error: 'bad_request', allowed: Object.values(SWITCHES) }, { request, methods: METHODS });
      }

      if (!(await limiter(user.sub))) return json(429, { ok: false, error: 'rate_limited' }, { request, methods: METHODS, headers: { 'Retry-After': '60' } });

      const row = switchableRow(await store.subscriptionsFor(user.sub));
      const reason = ineligibleReason(row, targetPlan);
      if (reason === 'no_subscription') return json(404, { ok: false, error: 'no_subscription' }, { request, methods: METHODS });
      if (reason) return json(409, { ok: false, error: 'not_eligible', reason }, { request, methods: METHODS });

      let priceId;
      try {
        priceId = provider.priceIdFor({ plan: targetPlan, trial: false }, env);
      } catch (error) {
        console.error('[billing-switch] price not configured', { reason: error && error.message ? error.message : String(error) });
        return json(503, { ok: false, error: 'not_configured' }, { request, methods: METHODS });
      }

      let result;
      try {
        result = await provider.changePlan(String(row.provider_subscription_id), priceId, { prorate: true }, { ...providerCtx, sub: user.sub });
      } catch (error) {
        console.error('[billing-switch] provider call failed', { reason: error && error.message ? error.message : String(error) });
        return json(502, { ok: false, error: 'provider_unavailable', message: 'We could not reach the billing service. Try again in a minute.' }, { request, methods: METHODS });
      }

      // Optimistic local view; the webhook (or the reconcile cron, via the
      // flag) writes the authoritative period dates.
      // The display amount belonged to the old price; until the next invoice
      // is paid the page says "the price shown to you at checkout".
      await updateSubscription(row.id, { plan: targetPlan, provider_price_id: priceId, needs_reconcile: true, display_amount: null, display_currency: null, display_tax_inclusive: null });

      const nextBilledAt = (result && (result.nextBilledAt || result.currentPeriodEnd)) || toIso(toMs(row.next_billed_at)) || null;
      return json(200, {
        ok: true,
        plan: targetPlan,
        next_billed_at: nextBilledAt,
        // Stripe's `create_prorations` adds the credit for the unused part of
        // this period to the NEXT invoice; nothing is invoiced today.
        message: 'You are now on the annual plan. Nothing is charged today: the unused part of this period is credited, and the annual charge is taken on your renewal date.',
      }, { request, methods: METHODS });
    } catch (error) {
      return errorResponse(error, request, { methods: METHODS, label: 'billing-switch' });
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
    updateSubscription: (rowId, patch) =>
      db(`subscriptions?id=eq.${encodeURIComponent(rowId)}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' }),
    provider: getProvider(providerName()),
    providerCtx: { env, fetchImpl: globalThis.fetch, isProd: isProduction() },
    env,
    limiter: (sub) => dblimit(`billing:switch:${sub}`, LIMIT.window, LIMIT.max),
  };
}

export async function POST(request) {
  try {
    return await createSwitchHandler(productionDeps()).POST(request);
  } catch (error) {
    return errorResponse(error, request, { methods: METHODS, label: 'billing-switch' });
  }
}

export async function OPTIONS(request) {
  return preflight(request, { methods: METHODS });
}

export async function GET(request) {
  return methodNotAllowed(request, METHODS);
}
