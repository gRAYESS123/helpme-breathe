/**
 * GET /api/cron/reconcile — the hourly reconciliation job (design §3.4, §6.1).
 *
 * vercel.json: { "path": "/api/cron/reconcile", "schedule": "17 * * * *" }
 * Vercel sends `Authorization: Bearer <CRON_SECRET>`; refused without it.
 *
 * "Reconciliation, not hope." Three passes, each capped and each logged:
 *
 *   1. Re-drive `webhook_events` rows with `status = 'failed'` and
 *      `attempts < 10`, oldest first, capped at 50: re-parse the KEPT payload
 *      through the adapter, re-claim (attempts += 1), applyEvent. The live-flag
 *      gate applies here too. This runs FIRST so that a re-driven event which
 *      turns out to be older than the row (and therefore flags it) is repaired
 *      by the next pass in the same run.
 *   2. Every `subscriptions` row with `needs_reconcile = true` (a webhook whose
 *      ordered UPDATE matched zero rows, or a plan switch awaiting its webhook),
 *      or whose `access_until` is in the past while `status in ('trialing',
 *      'active')` (a renewal webhook that never arrived): call
 *      `provider.getSubscription()` and rewrite authoritative state, then clear
 *      the flag. Capped at 50 per run.
 *   3. Emit a console error for anything still failed after 10 attempts, and
 *      for any subscription with `user_id is null and detached_at is null`
 *      (a true orphan). Vercel surfaces these in the function logs.
 *
 * Every step is idempotent; a run that overlaps a webhook is safe because the
 * same store and the same ordered writes are used.
 */

import { timingSafeEqual } from '../_lib/crypto.js';
import { bearerToken, toIso } from '../_lib/entitlement.js';
import { isProduction, readEnv, requireEnv } from '../_lib/env.js';
import { sandboxMode } from '../_lib/providers/index.js';
import { errorResponse, json, methodNotAllowed } from '../_lib/respond.js';
import { applyEvent, createWebhookStore, defaultAlert, patchForEvent, productionDeps as webhookDeps } from '../webhooks/mor.js';
import { db } from '../_lib/supabase.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const METHODS = 'GET';

/** Caps from §3.4. */
export const MAX_SUBSCRIPTIONS_PER_RUN = 50;
export const MAX_EVENTS_PER_RUN = 50;
export const MAX_ATTEMPTS = 10;

function reasonOf(error) {
  return error && error.message ? String(error.message).slice(0, 300) : String(error);
}

/**
 * Rewrite one subscription row from the provider's authoritative state.
 * @param {object} row
 * @param {{store:object, provider:object, providerCtx:object, nowMs:number}} deps
 * @returns {Promise<'rewritten'|'skipped'>}
 */
export async function reconcileSubscription(row, deps) {
  const { store, provider, providerCtx, nowMs } = deps;
  const state = await provider.getSubscription(String(row.provider_subscription_id), providerCtx);
  if (!state || !state.status) return 'skipped';
  const before = { status: row.status, had_trial: row.had_trial === true, ever_paid: row.ever_paid === true };
  const fields = patchForEvent(state, row, { nowMs });
  fields.needs_reconcile = false;
  fields.last_event_at = state.occurredAt || toIso(nowMs);
  const subscriptionId = String(row.provider_subscription_id);
  await store.updateByKey(row.provider, subscriptionId, fields);
  // The §6.6 ledger side effects the missing webhook would have written.
  if (fields.status === 'active' && before.status !== 'active' && before.had_trial) {
    await store.setTrialOutcome(row.provider, subscriptionId, 'converted', ['reserved', 'started']);
  } else if (fields.status === 'canceled' && before.status !== 'canceled' && !(before.ever_paid || fields.ever_paid)) {
    await store.setTrialOutcome(row.provider, subscriptionId, 'cancelled', ['reserved', 'started']);
  }
  return 'rewritten';
}

/**
 * Re-drive one failed webhook_events row from its kept payload.
 * @param {object} row a webhook_events row with `payload`
 * @param {{store:object, provider:object, providerCtx:object, env:object, alert:Function, now:()=>number}} deps
 * @returns {Promise<'processed'|'ignored'|'failed'|'skipped'>}
 */
export async function redriveEvent(row, deps) {
  const { store, provider, providerCtx, env, alert, now } = deps;
  if (row.provider !== provider.id) return 'skipped';
  let events;
  try {
    events = provider.parseEvents(typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload), { env });
  } catch (error) {
    await store.markFailed(provider.id, row.event_id, new Error(`payload_unparseable: ${reasonOf(error)}`));
    return 'failed';
  }
  const event = events.find((e) => e && e.id === row.event_id);
  if (!event) {
    await store.markFailed(provider.id, row.event_id, new Error('payload_missing_event'));
    return 'failed';
  }
  if (event.live !== !sandboxMode(env)) {
    await store.markIgnored(provider.id, event, event.live == null ? 'live_flag_unknown' : 'live_flag_mismatch');
    return 'ignored';
  }
  const claim = await store.claimEvent(provider.id, event);
  if (claim === 'already_processed') return 'skipped';
  try {
    const result = await applyEvent(event, { store, provider, providerCtx, env, alert, now });
    if (result.action === 'ignored') {
      await store.markIgnored(provider.id, event, result.reason || 'ignored');
      return 'ignored';
    }
    await store.markProcessed(provider.id, event.id, { error: result.error || null, nowIso: toIso(now()) });
    return 'processed';
  } catch (error) {
    await store.markFailed(provider.id, event.id, error);
    return 'failed';
  }
}

/**
 * @param {{
 *   store:object, provider:object, providerCtx:object, env:Record<string,string>,
 *   cronSecret:string, alert?:Function, now?:()=>number
 * }} deps
 */
export function createReconcileHandler(deps) {
  const { store, provider, providerCtx, env, cronSecret } = deps;
  const alert = deps.alert || defaultAlert;
  const now = deps.now || (() => Date.now());

  async function GET(request) {
    try {
      const presented = bearerToken(request);
      if (!cronSecret || !presented || !timingSafeEqual(presented, cronSecret)) {
        return json(401, { ok: false, reason: 'unauthorized' }, { request, methods: METHODS });
      }

      const at = now();
      const nowIso = toIso(at);
      const results = {
        subscriptions_checked: 0,
        subscriptions_rewritten: 0,
        subscriptions_failed: 0,
        events_redriven: 0,
        events_processed: 0,
        events_ignored: 0,
        events_failed: 0,
        events_exhausted: 0,
        orphans: 0,
      };
      let stepFailures = 0;

      // 1. Failed webhook events, oldest first.
      try {
        const rows = await store.failedEvents(MAX_EVENTS_PER_RUN, MAX_ATTEMPTS);
        for (const row of rows) {
          results.events_redriven += 1;
          const outcome = await redriveEvent(row, { store, provider, providerCtx, env, alert, now });
          if (outcome === 'processed') results.events_processed += 1;
          else if (outcome === 'ignored') results.events_ignored += 1;
          else if (outcome === 'failed') results.events_failed += 1;
        }
      } catch (error) {
        stepFailures += 1;
        console.error('[reconcile] event pass failed', { reason: reasonOf(error) });
      }

      // 2. Subscriptions disagreeing with the provider (after the re-drive, so a
      //    stale re-driven event that flagged its row is repaired in this run).
      try {
        const rows = await store.subscriptionsToReconcile(nowIso, MAX_SUBSCRIPTIONS_PER_RUN);
        for (const row of rows) {
          results.subscriptions_checked += 1;
          try {
            const outcome = await reconcileSubscription(row, { store, provider, providerCtx, nowMs: now() });
            if (outcome === 'rewritten') results.subscriptions_rewritten += 1;
          } catch (error) {
            results.subscriptions_failed += 1;
            console.error('[reconcile] subscription rewrite failed', { reason: reasonOf(error) });
          }
        }
      } catch (error) {
        stepFailures += 1;
        console.error('[reconcile] subscription pass failed', { reason: reasonOf(error) });
      }

      // 3. What a human must look at.
      try {
        const exhausted = await store.exhaustedEvents(MAX_ATTEMPTS);
        results.events_exhausted = exhausted.length;
        for (const row of exhausted) {
          console.error('[reconcile] webhook event still failed after 10 attempts', {
            event_type: row.event_type,
            attempts: row.attempts,
            error: row.error,
          });
        }
        const orphans = await store.orphanSubscriptions();
        results.orphans = orphans.length;
        for (const row of orphans) {
          console.error('[reconcile] orphan subscription (no owner, never detached)', { status: row.status, created_at: row.created_at });
        }
        if (exhausted.length > 0 || orphans.length > 0) alert('reconcile_attention', { exhausted: exhausted.length, orphans: orphans.length });
      } catch (error) {
        stepFailures += 1;
        console.error('[reconcile] report pass failed', { reason: reasonOf(error) });
      }

      console.log('[reconcile] run', { at: nowIso, ...results });
      return json(stepFailures > 0 ? 500 : 200, { ok: stepFailures === 0, ran_at: nowIso, results }, { request, methods: METHODS });
    } catch (error) {
      return errorResponse(error, request, { methods: METHODS, label: 'reconcile' });
    }
  }

  return { GET };
}

/* --------------------------------------------------------------- wiring --- */

export function productionDeps() {
  // Production: a missing CRON_SECRET is a 503 that names the variable.
  // Preview/development: requireEnv() would hand back the well-known
  // `dev-missing-CRON_SECRET` placeholder, which would make this endpoint
  // callable by anyone against whatever database the preview points at.
  // An unset secret therefore means "no caller is ever authorised" (401).
  if (isProduction()) requireEnv(['CRON_SECRET']);
  const cronSecret = readEnv('CRON_SECRET');
  const shared = webhookDeps();
  return { ...shared, store: createWebhookStore(db), cronSecret };
}

/** @param {Request} request */
export async function GET(request) {
  try {
    return await createReconcileHandler(productionDeps()).GET(request);
  } catch (error) {
    return errorResponse(error, request, { methods: METHODS, label: 'reconcile' });
  }
}

/** @param {Request} request */
export async function POST(request) {
  return methodNotAllowed(request, METHODS);
}
