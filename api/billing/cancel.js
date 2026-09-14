/**
 * POST /api/billing/cancel — cancel the subscription (design §5.9).
 *
 *   Authorization: Bearer <supabase access token>     (assertLiveUser: money-touching)
 *   { "when": "period_end" }   default: keeps what was paid for / the remaining trial days
 *   { "when": "now" }          the secondary "end it now" link, never the default
 *
 *   -> 200 { ok:true, effective_from, status, cancel_at, access_until, message }
 *
 * `effective_from` is ALWAYS passed explicitly to the adapter, in every branch:
 *
 *   | status               | when        | effective_from        |
 *   |----------------------|-------------|-----------------------|
 *   | trialing             | period_end  | next_billing_period   (pending §16 test 6)
 *   | active, past_due     | period_end  | next_billing_period   |
 *   | paused               | period_end  | immediately           |
 *   | any                  | now         | immediately           |
 *
 * Paused is the one status where "end of period" is `immediately`: nothing is
 * charged while paused, the paid period has already run out (§6.5 gives a
 * paused row access only to `current_period_end`), so there is nothing left
 * to keep — and the provider documents immediate cancellation as its own
 * behaviour for paused subscriptions ("Canceling immediately is the default
 * behavior for paused subscriptions"), so this path is never worse than the
 * provider's portal.
 *
 * The account page states, before the confirm button, exactly what will happen
 * and on which date; this endpoint returns that date. Never worse than the
 * provider's own portal: both paths default to the end of the period.
 *
 * Errors: 401, 403 cross_origin, 400 bad_request, 404 no_subscription,
 * 429 rate_limited, 502 provider_unavailable.
 */

import { requireLiveUser } from '../_lib/authz.js';
import { dblimit } from '../_lib/dblimit.js';
import { LIVE_STATUSES, accessUntilFor, createStore, toIso, toMs, winningRow } from '../_lib/entitlement.js';
import { isProduction, providerName, readEnv, requireEnv } from '../_lib/env.js';
import { PROVIDER_ENV_OPTIONAL, getProvider } from '../_lib/providers/index.js';
import { errorResponse, json, methodNotAllowed, preflight, readJsonBody, resolveSameOrigin } from '../_lib/respond.js';
import { db } from '../_lib/supabase.js';

export const config = { runtime: 'nodejs', maxDuration: 15 };

const METHODS = 'POST, OPTIONS';

export const LIMIT = Object.freeze({ window: 3600, max: 10 });

/** The two values the client may send. Anything else is a 400. */
export const WHEN = Object.freeze(['period_end', 'now']);

/**
 * §5.9's table as a function. Every branch names its value; there is no default
 * that falls through to the provider's own.
 * @param {string} status the subscription's current status
 * @param {'period_end'|'now'} when
 * @returns {'next_billing_period'|'immediately'}
 */
export function effectiveFromFor(status, when) {
  if (when === 'now') return 'immediately';
  switch (String(status)) {
    case 'trialing':
      return 'next_billing_period';
    case 'active':
    case 'past_due':
      return 'next_billing_period';
    case 'paused':
      // Nothing is charged and nothing is left to keep (see the file header).
      return 'immediately';
    default:
      return 'next_billing_period';
  }
}

/**
 * The subscription a cancel applies to: the live row with the furthest access.
 * @param {object[]} rows
 * @returns {object|null}
 */
export function cancellableRow(rows) {
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
export function createCancelHandler(deps) {
  const { auth, store, updateSubscription, provider, providerCtx } = deps;
  const limiter = deps.limiter || (async () => true);
  const now = deps.now || (() => Date.now());

  async function POST(request) {
    try {
      if (!resolveSameOrigin(request)) return json(403, { ok: false, error: 'cross_origin' }, { request, methods: METHODS });
      const user = await auth(request);
      if (!user.ok) return user.response;

      let when = 'period_end';
      const declared = Number(request.headers.get('content-length') || '0');
      if (declared > 0) {
        const body = await readJsonBody(request, { maxBytes: 1024 });
        if (!body.ok) return json(400, { ok: false, error: 'bad_request' }, { request, methods: METHODS });
        if (body.data.when !== undefined) {
          if (!WHEN.includes(body.data.when)) return json(400, { ok: false, error: 'bad_request', allowed: WHEN }, { request, methods: METHODS });
          when = body.data.when;
        }
      }

      if (!(await limiter(user.sub))) return json(429, { ok: false, error: 'rate_limited' }, { request, methods: METHODS, headers: { 'Retry-After': '60' } });

      const row = cancellableRow(await store.subscriptionsFor(user.sub));
      if (!row) return json(404, { ok: false, error: 'no_subscription' }, { request, methods: METHODS });

      const at = now();
      const nowIso = toIso(at);

      // Already scheduled and not being asked to end now: idempotent answer.
      if (when === 'period_end' && row.cancel_at) {
        return json(200, {
          ok: true,
          effective_from: 'next_billing_period',
          status: row.status,
          cancel_at: toIso(toMs(row.cancel_at)),
          access_until: toIso(toMs(row.access_until)),
          already_scheduled: true,
          message: `Your subscription is already set to end on ${toIso(toMs(row.cancel_at))}.`,
        }, { request, methods: METHODS });
      }

      const effectiveFrom = effectiveFromFor(row.status, when);
      let result;
      try {
        result = await provider.cancelSubscription(String(row.provider_subscription_id), { effectiveFrom }, { ...providerCtx, sub: user.sub });
      } catch (error) {
        console.error('[billing-cancel] provider call failed', { reason: error && error.message ? error.message : String(error), effective_from: effectiveFrom });
        return json(502, { ok: false, error: 'provider_unavailable', message: 'We could not reach the billing service. Try again in a minute, or cancel from the link in your emailed receipt.' }, { request, methods: METHODS });
      }

      let patch;
      let cancelAt;
      let accessUntil;
      if (effectiveFrom === 'immediately') {
        // A paused row ends at the provider now (nothing is being collected),
        // but the days already paid for are kept: its access_until was frozen
        // at the last paid period end, and that date becomes cancel_at.
        const frozen = toMs(row.access_until);
        const keepUntil = row.status === 'paused' && when !== 'now' && frozen != null && frozen > at ? toIso(frozen) : null;
        patch = { status: 'canceled', canceled_at: nowIso, cancel_at: keepUntil };
        accessUntil = toIso(accessUntilFor({ ...row, ...patch }, at));
        patch.access_until = accessUntil;
        cancelAt = keepUntil || nowIso;
      } else {
        const sc = result && result.scheduledChange;
        cancelAt =
          (sc && sc.action === 'cancel' && sc.effectiveAt) ||
          toIso(toMs(row.status === 'trialing' ? row.trial_ends_at : row.current_period_end)) ||
          toIso(toMs(row.next_billed_at)) ||
          null;
        patch = { cancel_at: cancelAt };
        accessUntil = toIso(toMs(row.access_until));
      }
      // The webhook remains the system of record; this write is the optimistic
      // local view so /account is right on the very next load.
      await updateSubscription(row.id, patch);

      const message =
        effectiveFrom === 'immediately'
          ? row.status === 'paused' && when !== 'now'
            ? cancelAt !== nowIso
              ? `Your paused subscription has ended. Nothing more will be charged, and you keep access until ${cancelAt}.`
              : 'Your paused subscription has ended. Nothing more will be charged.'
            : 'Your subscription has ended. Nothing more will be charged.'
          : row.status === 'trialing'
            ? `Your trial will end on ${cancelAt || 'its last day'} and your card will not be charged.`
            : `Your subscription will end on ${cancelAt || 'the end of the current period'}. You keep access until then and nothing more is charged.`;

      return json(200, { ok: true, effective_from: effectiveFrom, status: patch.status || row.status, cancel_at: cancelAt, access_until: accessUntil, message }, { request, methods: METHODS });
    } catch (error) {
      return errorResponse(error, request, { methods: METHODS, label: 'billing-cancel' });
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
    // Fail open: a subscriber who cannot cancel keeps being billed, which is
    // worse than a burst of cancel calls while the limiter is down.
    limiter: (sub) => dblimit(`billing:cancel:${sub}`, LIMIT.window, LIMIT.max, { failOpen: true }),
  };
}

export async function POST(request) {
  try {
    return await createCancelHandler(productionDeps()).POST(request);
  } catch (error) {
    return errorResponse(error, request, { methods: METHODS, label: 'billing-cancel' });
  }
}

export async function OPTIONS(request) {
  return preflight(request, { methods: METHODS });
}

export async function GET(request) {
  return methodNotAllowed(request, METHODS);
}
