/**
 * GET /api/account/export — the data-portability endpoint the privacy policy
 * promises (design §11.4 item 7, §11.5).
 *
 *   Authorization: Bearer <supabase access token>   (assertLiveUser — money-adjacent)
 *
 * Returns `Content-Disposition: attachment` JSON containing: the `profiles`
 * row, every `subscriptions` row (provider ids included), and a note that the
 * payment provider holds its own copy as a separate controller. Those two
 * tables are everything an account owns. No hashes, no peppers, no other
 * user's data — every query is keyed on the verified JWT `sub`.
 *
 * `createExportHandler(deps)` is exported for the test suite.
 */

import { bearerToken, createStore, toIso } from '../_lib/entitlement.js';
import { createLimiter, rateLimitHeaders } from '../_lib/ratelimit.js';
import { clientIp, errorResponse, json, methodNotAllowed, preflight } from '../_lib/respond.js';

export const config = { runtime: 'nodejs', maxDuration: 15 };

const METHODS = 'GET, OPTIONS';

const limiter = createLimiter({ name: 'account-export', limit: 10, windowMs: 60 * 1000 });

/** Wording shown to the user. Names no provider: the site never does (AGENT_BRIEF §1). */
export const CONTROLLER_NOTE =
  'This file holds everything Help Me Breathe stores about your account. ' +
  'Payments are processed by a payment provider, which keeps its own copy of your ' +
  'payment and invoice records as a separate data controller; contact it directly ' +
  'for a copy of those. Email contact@helpmebreath.com if anything here looks wrong.';

/**
 * Strip a row down to what belongs to the person. Nothing here is a hash or a
 * secret today; the allowlists make sure that stays true if columns are added.
 */
const PROFILE_FIELDS = ['id', 'email', 'display_name', 'created_at', 'updated_at', 'marketing_opt_in', 'last_seen_at', 'deletion_requested_at'];
const SUBSCRIPTION_FIELDS = [
  'id', 'provider', 'provider_subscription_id', 'provider_customer_id', 'provider_price_id', 'plan', 'status',
  'had_trial', 'ever_paid', 'trial_started_at', 'trial_ends_at', 'current_period_start', 'current_period_end',
  'next_billed_at', 'cancel_at', 'canceled_at', 'paused_at', 'resume_at', 'past_due_since', 'access_until',
  'display_amount', 'display_currency', 'display_tax_inclusive', 'dispute_open', 'live', 'created_at', 'updated_at',
];

function pick(row, fields) {
  const out = {};
  if (!row || typeof row !== 'object') return out;
  for (const field of fields) if (field in row) out[field] = row[field];
  return out;
}

/**
 * @param {{
 *   assertLiveUser:(jwt:string)=>Promise<{ok:boolean, sub?:string, email?:string, reason?:string}>,
 *   store:ReturnType<typeof createStore>, now?:()=>number, limiter?:{check:Function}
 * }} deps
 */
export function createExportHandler(deps) {
  const { assertLiveUser, store, now = () => Date.now() } = deps;
  const rate = deps.limiter || limiter;

  async function GET(request) {
    try {
      const limit = rate.check(clientIp(request));
      if (!limit.ok) {
        return json(429, { ok: false, reason: 'rate_limited' }, { request, methods: METHODS, headers: rateLimitHeaders(limit, { includeRetryAfter: true }) });
      }
      const jwt = bearerToken(request);
      if (!jwt) return json(401, { ok: false, reason: 'unauthenticated' }, { request, methods: METHODS });
      const identity = await assertLiveUser(jwt);
      if (!identity || !identity.ok || typeof identity.sub !== 'string' || !identity.sub) {
        return json(401, { ok: false, reason: 'unauthenticated' }, { request, methods: METHODS });
      }
      const sub = identity.sub;

      const [profile, subscriptions] = await Promise.all([
        store.profileFor(sub),
        store.subscriptionsFor(sub),
      ]);

      const body = {
        ok: true,
        exported_at: toIso(now()),
        account: {
          id: sub,
          email: typeof identity.email === 'string' ? identity.email : profile && profile.email ? profile.email : null,
        },
        profile: profile ? pick(profile, PROFILE_FIELDS) : null,
        subscriptions: subscriptions.map((row) => pick(row, SUBSCRIPTION_FIELDS)),
        note: CONTROLLER_NOTE,
      };

      const stamp = toIso(now()).slice(0, 10);
      return json(200, body, {
        request,
        methods: METHODS,
        headers: { 'Content-Disposition': `attachment; filename="helpmebreath-account-${stamp}.json"` },
      });
    } catch (error) {
      return errorResponse(error, request, { methods: METHODS, label: 'account-export' });
    }
  }

  async function OPTIONS(request) {
    return preflight(request, { methods: METHODS });
  }

  return { GET, OPTIONS };
}

/* ------------------------------------------------------------- wiring ----- */

let depsPromise = null;

async function defaultDeps() {
  if (depsPromise) return depsPromise;
  depsPromise = (async () => {
    const supabase = await import('../_lib/supabase.js');
    return { assertLiveUser: supabase.assertLiveUser, store: createStore(supabase.db) };
  })();
  depsPromise.catch(() => {
    depsPromise = null;
  });
  return depsPromise;
}

/** @param {Request} request */
export async function GET(request) {
  try {
    return createExportHandler(await defaultDeps()).GET(request);
  } catch (error) {
    return errorResponse(error, request, { methods: METHODS, label: 'account-export' });
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
