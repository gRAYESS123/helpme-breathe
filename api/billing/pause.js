/**
 * POST /api/billing/pause — pause for one or three months (design §5.8).
 *
 *   Authorization: Bearer <supabase access token>     (assertLiveUser: money-touching)
 *   { "months": 1 | 3 }
 *   -> 200 { ok:true, effective_from:'next_billing_period', resume_at, access_until, message }
 *
 * "Nothing is charged while paused." The pause takes effect at the end of the
 * period already paid for — `effective_from` is passed explicitly as
 * `next_billing_period` in every branch — so a courtesy pause never takes away
 * days the customer has paid for (§6.5, the paused row). `access_until` stays
 * as stored until the provider's `subscription.paused` webhook writes the new
 * value through the ordered update.
 *
 * Only an `active` subscription can pause: a trial has nothing to pause, a
 * past-due one has a card to fix first, and a paused one is already paused.
 *
 * Errors: 401, 403 cross_origin, 400 bad_request, 404 no_subscription,
 * 409 { error: 'not_active' | 'cancel_scheduled' }, 429, 502.
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

/** The only pause lengths offered on the cancel screen. */
export const MONTHS = Object.freeze([1, 3]);

const MONTH_MS = 30.4375 * 24 * 60 * 60 * 1000;

/**
 * When the pause ends: `months` after the end of the period already paid for
 * (or after now, when no period end is known).
 * @param {object} row
 * @param {number} months
 * @param {number} nowMs
 * @returns {string} ISO datetime
 */
export function resumeAtFor(row, months, nowMs) {
  const base = toMs(row && row.current_period_end) ?? nowMs;
  return toIso(Math.max(base, nowMs) + months * MONTH_MS);
}

/**
 * @param {object[]} rows
 * @returns {object|null}
 */
export function pausableRow(rows) {
  const live = (rows || []).filter((row) => row && LIVE_STATUSES.includes(String(row.status)) && row.provider_subscription_id);
  return winningRow(live);
}

/**
 * @param {{
 *   auth:(request:Request)=>Promise<{ok:boolean, sub?:string, response?:Response}>,
 *   store:{subscriptionsFor:(userId:string)=>Promise<object[]>},
 *   updateSubscription:(rowId:string, patch:object)=>Promise<unknown>,
 *   provider:object, providerCtx:object,
 *   limiter?:(sub:string)=>Promise<boolean>, now?:()=>number,
 * }} deps
 */
export function createPauseHandler(deps) {
  const { auth, store, updateSubscription, provider, providerCtx } = deps;
  const limiter = deps.limiter || (async () => true);
  const now = deps.now || (() => Date.now());

  async function POST(request) {
    try {
      if (!resolveSameOrigin(request)) return json(403, { ok: false, error: 'cross_origin' }, { request, methods: METHODS });
      const user = await auth(request);
      if (!user.ok) return user.response;

      const body = await readJsonBody(request, { maxBytes: 1024 });
      if (!body.ok) return json(400, { ok: false, error: 'bad_request' }, { request, methods: METHODS });
      const months = Number(body.data.months);
      if (!MONTHS.includes(months)) return json(400, { ok: false, error: 'bad_request', allowed: MONTHS }, { request, methods: METHODS });

      if (!(await limiter(user.sub))) return json(429, { ok: false, error: 'rate_limited' }, { request, methods: METHODS, headers: { 'Retry-After': '60' } });

      const row = pausableRow(await store.subscriptionsFor(user.sub));
      if (!row) return json(404, { ok: false, error: 'no_subscription' }, { request, methods: METHODS });
      if (row.status !== 'active') return json(409, { ok: false, error: 'not_active', status: row.status }, { request, methods: METHODS });
      if (row.cancel_at) return json(409, { ok: false, error: 'cancel_scheduled', cancel_at: toIso(toMs(row.cancel_at)) }, { request, methods: METHODS });

      const at = now();
      const resumeAt = resumeAtFor(row, months, at);
      const effectiveFrom = 'next_billing_period';
      const unit = row.plan === 'yearly' || row.plan === 'practitioner_yearly' ? 'year' : 'month';
      let result;
      try {
        result = await provider.pauseSubscription(
          String(row.provider_subscription_id),
          { resumeAt, effectiveFrom, periods: unit === 'year' ? 1 : months, unit },
          { ...providerCtx, sub: user.sub, now: at },
        );
      } catch (error) {
        console.error('[billing-pause] provider call failed', { reason: error && error.message ? error.message : String(error), effective_from: effectiveFrom });
        return json(502, { ok: false, error: 'provider_unavailable', message: 'We could not reach the billing service. Try again in a minute.' }, { request, methods: METHODS });
      }

      const sc = result && result.scheduledChange;
      const effectiveAt = (sc && sc.action === 'pause' && sc.effectiveAt) || toIso(toMs(row.current_period_end)) || null;
      const resume = (sc && sc.action === 'pause' && sc.resumeAt) || resumeAt;
      await updateSubscription(row.id, { resume_at: resume });

      return json(200, {
        ok: true,
        effective_from: effectiveFrom,
        effective_at: effectiveAt,
        resume_at: resume,
        access_until: toIso(toMs(row.access_until)),
        message: `Paused. Nothing is charged while paused; your subscription resumes on ${resume}.`,
      }, { request, methods: METHODS });
    } catch (error) {
      return errorResponse(error, request, { methods: METHODS, label: 'billing-pause' });
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
    limiter: (sub) => dblimit(`billing:pause:${sub}`, LIMIT.window, LIMIT.max),
  };
}

export async function POST(request) {
  try {
    return await createPauseHandler(productionDeps()).POST(request);
  } catch (error) {
    return errorResponse(error, request, { methods: METHODS, label: 'billing-pause' });
  }
}

export async function OPTIONS(request) {
  return preflight(request, { methods: METHODS });
}

export async function GET(request) {
  return methodNotAllowed(request, METHODS);
}
