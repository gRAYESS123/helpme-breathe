/**
 * GET /api/cron/retention — the weekly retention job (design §3.4, §11.4 item 5).
 *
 * vercel.json: { "path": "/api/cron/retention", "schedule": "0 4 * * 1" }
 *
 * Vercel sends `Authorization: Bearer <CRON_SECRET>` on every invocation
 * (vercel.com/docs/cron-jobs/manage-cron-jobs, "Securing cron jobs"); the
 * request is refused without it, so the endpoint is not publicly callable.
 *
 * The eight statements of §3.4, in order, as PostgREST calls. The first one is
 * the one that matters most and the one draft 1 got wrong: payloads are
 * nulled ONLY on `processed` rows, so a `failed` event keeps its evidence for
 * as long as the problem does. Every statement is idempotent — Vercel cron
 * delivery is best effort and can invoke twice.
 *
 * A step that fails is logged and the remaining steps still run; the response
 * is 500 when any step failed so the invocation shows red in the Vercel log.
 *
 * `createRetentionHandler(deps)` and `retentionSteps(now)` are exported for the
 * test suite.
 */

import { timingSafeEqual } from '../_lib/crypto.js';
import { bearerToken, toIso } from '../_lib/entitlement.js';
import { isProduction, readEnv, requireEnv } from '../_lib/env.js';
import { errorResponse, json, methodNotAllowed } from '../_lib/respond.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const METHODS = 'GET';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30.4375 * DAY_MS; // Postgres `interval '24 months'` is calendar months; 24 × 30.44 days is within a day of it.

/**
 * The statements, as data, for a given "now". Each is
 * `{ name, method, path, body?, sql }` where `sql` is the §3.4 original for
 * the reader, and `path` is its PostgREST translation.
 *
 * @param {number} nowMs
 * @returns {Array<{name:string, method:'PATCH'|'DELETE', path:string, body?:object, sql:string}>}
 */
export function retentionSteps(nowMs) {
  const at = Number.isFinite(nowMs) ? nowMs : Date.now();
  const iso = (offsetMs) => encodeURIComponent(toIso(at - offsetMs));
  const now = iso(0);

  return [
    {
      name: 'webhook_payloads_nulled',
      method: 'PATCH',
      // ONLY processed rows — a failed row keeps its payload for replay.
      path: `webhook_events?received_at=lt.${iso(30 * DAY_MS)}&payload=not.is.null&status=eq.processed&select=event_id`,
      body: { payload: null },
      sql: "update public.webhook_events set payload = null where received_at < now() - interval '30 days' and payload is not null and status = 'processed'",
    },
    {
      name: 'webhook_events_deleted',
      method: 'DELETE',
      path: `webhook_events?received_at=lt.${iso(180 * DAY_MS)}&status=eq.processed&select=event_id`,
      sql: "delete from public.webhook_events where received_at < now() - interval '180 days' and status = 'processed'",
    },
    {
      name: 'trial_reservations_expired',
      method: 'PATCH',
      path: `trial_claims?outcome=eq.reserved&reserved_until=lt.${now}&select=outcome`,
      body: { outcome: 'expired' },
      sql: "update public.trial_claims set outcome = 'expired' where outcome = 'reserved' and reserved_until < now()",
    },
    {
      name: 'checkout_intents_deleted',
      method: 'DELETE',
      path: `checkout_intents?expires_at=lt.${iso(7 * DAY_MS)}&select=reservation_id`,
      sql: "delete from public.checkout_intents where expires_at < now() - interval '7 days'",
    },
    {
      name: 'subscriptions_expired',
      method: 'PATCH',
      path: `subscriptions?status=neq.expired&access_until=lt.${iso(7 * DAY_MS)}&select=id`,
      body: { status: 'expired' },
      sql: "update public.subscriptions set status = 'expired' where status <> 'expired' and access_until < now() - interval '7 days'",
    },
    {
      name: 'trial_claims_deleted',
      method: 'DELETE',
      path: `trial_claims?claimed_at=lt.${iso(24 * MONTH_MS)}&select=outcome`,
      sql: "delete from public.trial_claims where claimed_at < now() - interval '24 months'",
    },
    {
      name: 'devices_deleted',
      method: 'DELETE',
      // coalesce(trial_consumed_at, last_seen_at) < cutoff, spelled as an OR of the two branches.
      path:
        `devices?or=(and(trial_consumed_at.not.is.null,trial_consumed_at.lt.${iso(24 * MONTH_MS)}),` +
        `and(trial_consumed_at.is.null,last_seen_at.lt.${iso(24 * MONTH_MS)}))&select=device_id`,
      sql: "delete from public.devices where coalesce(trial_consumed_at, last_seen_at) < now() - interval '24 months'",
    },
    {
      name: 'rate_limits_deleted',
      method: 'DELETE',
      path: `rate_limits?window_start=lt.${iso(2 * DAY_MS)}&select=bucket`,
      sql: "delete from public.rate_limits where window_start < now() - interval '2 days'",
    },
  ];
}

/**
 * @param {{
 *   db:(path:string, options?:object)=>Promise<any>,
 *   cronSecret:string,
 *   now?:()=>number
 * }} deps
 */
export function createRetentionHandler(deps) {
  const { db, cronSecret, now = () => Date.now() } = deps;

  async function GET(request) {
    try {
      const presented = bearerToken(request);
      if (!cronSecret || !presented || !timingSafeEqual(presented, cronSecret)) {
        return json(401, { ok: false, reason: 'unauthorized' }, { request, methods: METHODS });
      }

      const at = now();
      const results = {};
      let failed = 0;
      for (const step of retentionSteps(at)) {
        try {
          const rows = await db(step.path, {
            method: step.method,
            prefer: 'return=representation',
            ...(step.body ? { body: step.body } : {}),
          });
          results[step.name] = Array.isArray(rows) ? rows.length : 0;
        } catch (error) {
          failed += 1;
          results[step.name] = 'failed';
          console.error('[retention] step failed', { step: step.name, reason: error && error.message ? error.message : String(error) });
        }
      }
      console.log('[retention] run', { at: toIso(at), ...results });
      return json(failed > 0 ? 500 : 200, { ok: failed === 0, ran_at: toIso(at), results }, { request, methods: METHODS });
    } catch (error) {
      return errorResponse(error, request, { methods: METHODS, label: 'retention' });
    }
  }

  return { GET };
}

/* ------------------------------------------------------------- wiring ----- */

let depsPromise = null;

async function defaultDeps() {
  if (depsPromise) return depsPromise;
  depsPromise = (async () => {
    // Production: a missing CRON_SECRET is a 503 that names the variable.
    // Preview/development: requireEnv() would hand back the well-known
    // `dev-missing-CRON_SECRET` placeholder, which would make this endpoint
    // callable by anyone against whatever database the preview points at.
    // An unset secret therefore means "no caller is ever authorised" (401).
    if (isProduction()) requireEnv(['CRON_SECRET']);
    const cronSecret = readEnv('CRON_SECRET');
    const supabase = await import('../_lib/supabase.js');
    return { db: supabase.db, cronSecret };
  })();
  depsPromise.catch(() => {
    depsPromise = null;
  });
  return depsPromise;
}

/** @param {Request} request */
export async function GET(request) {
  try {
    return createRetentionHandler(await defaultDeps()).GET(request);
  } catch (error) {
    return errorResponse(error, request, { methods: METHODS, label: 'retention' });
  }
}

/** @param {Request} request */
export async function POST(request) {
  return methodNotAllowed(request, METHODS);
}
