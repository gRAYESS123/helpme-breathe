/**
 * POST /api/webhooks/mor — one endpoint for every merchant of record.
 *
 * Specification: docs/private/ACCOUNTS_BILLING_DESIGN.md §6.1 (the handler),
 * §6.2 (signature, by the adapter), §6.3 (applyEvent), §6.5 (access_until via
 * api/_lib/entitlement.js#accessUntilFor) and §6.6 (the trial lifecycle).
 * MOR_PROVIDER picks the adapter; nothing in this file names a provider.
 *
 * The four properties that make a failed event recoverable, all here:
 *
 *   1. The body is read ONCE, as text, and that exact string is what the
 *      adapter hashes. Never readJsonBody(), never JSON.parse-then-stringify.
 *   2. An event whose processing throws is answered with a non-2xx so the
 *      provider retries; its row is `failed` with the payload KEPT.
 *   3. The claim is a state machine (received -> processed | ignored | failed):
 *      a `failed` or `received` row is re-claimable, a `processed` or `ignored`
 *      row is a permanent no-op. A manual re-POST of a failed event is
 *      re-processed, not skipped.
 *   4. Ordering is enforced by the WRITE: `last_event_at < occurred_at` is a
 *      filter on the UPDATE, and zero rows affected flags the row for
 *      api/cron/reconcile.js. Terminal cancellation is a separate statement
 *      guarded on `status <> 'canceled'`, so a stale update never resurrects.
 *
 * Plus the environment gate: an event whose `live` flag disagrees with
 * MOR_SANDBOX is recorded as `ignored` and never touches a subscription.
 *
 * `custom_data` is a hint, never a fact: the only field read from it is `rid`,
 * and every fact comes from the `checkout_intents` row it names.
 *
 * Exports for the test suite and the reconcile cron: createWebhookStore(db),
 * applyEvent(event, deps), createWebhookHandler(deps), patchForEvent(),
 * productionDeps().
 */

import { accessUntilFor, toIso } from '../_lib/entitlement.js';
import { isProduction, providerName, readEnv, requireEnv } from '../_lib/env.js';
import {
  PROVIDER_ENV_OPTIONAL,
  getProvider,
  isTrialPriceId,
  planForPriceId,
  sandboxMode,
} from '../_lib/providers/index.js';
import { methodNotAllowed } from '../_lib/respond.js';
import { db as supabaseDb } from '../_lib/supabase.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

const METHODS = 'POST';

/** Longest error text kept on a webhook_events row. */
const MAX_ERROR_LENGTH = 500;

/** Postgres unique-violation code, as PostgREST relays it. */
const UNIQUE_VIOLATION = '23505';

/** Statuses that mean "a sub.* event should set this status". */
const STATUS_FOR_TYPE = Object.freeze({
  'sub.trialing': 'trialing',
  'sub.activated': 'active',
  'sub.past_due': 'past_due',
  'sub.paused': 'paused',
  'sub.resumed': 'active',
  'sub.canceled': 'canceled',
});

const SUB_EVENT_TYPES = new Set(['sub.created', 'sub.trialing', 'sub.activated', 'sub.updated', 'sub.past_due', 'sub.paused', 'sub.resumed', 'sub.canceled']);

/* -------------------------------------------------------------- helpers ---- */

/**
 * Default alert sink: a console error, which Vercel surfaces in the function
 * logs and which §14 step 18 tells the owner to watch. Never carries an email.
 * @param {string} kind
 * @param {Record<string,unknown>} detail
 */
export function defaultAlert(kind, detail) {
  console.error(`[webhook] ALERT ${kind}`, JSON.stringify(detail || {}));
}

function enc(value) {
  return encodeURIComponent(String(value));
}

function errorText(error) {
  const text = error && error.message ? String(error.message) : String(error);
  return text.slice(0, MAX_ERROR_LENGTH);
}

function isUniqueViolation(error) {
  return Boolean(error && (error.code === UNIQUE_VIOLATION || error.status === 409));
}

/* ---------------------------------------------------------------- store ---- */

/**
 * Every read and write the handler and the reconcile cron need, over the
 * PostgREST helper from api/_lib/supabase.js (`db(path, options)`, secret key,
 * RLS bypassed — so every method here is doing its own authorization: the only
 * identities ever written come from `checkout_intents`, never from a payload).
 *
 * `db(path, { method?, body?, prefer? })` resolves to the parsed JSON body (an
 * array for reads and `return=representation` writes, null for 204) and
 * REJECTS with a SupabaseError (carrying `.code`, e.g. '23505') on any non-2xx.
 *
 * @param {(path:string, options?:object) => Promise<any>} db
 */
export function createWebhookStore(db) {
  if (typeof db !== 'function') throw new TypeError('createWebhookStore(db): db must be a function.');
  const list = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
  const one = async (path) => list(await db(path)).at(0) || null;
  const patch = (path, body) => db(path, { method: 'PATCH', body, prefer: 'return=representation' }).then(list);

  return {
    /* ---- webhook_events: the state machine (§6.1) ---- */

    /**
     * insert … on conflict do update set status='received', attempts+1, error=null
     *   where status in ('failed','received') returning status
     * expressed as read -> insert | compare-and-set patch.
     * @returns {Promise<'claimed'|'already_processed'>}
     */
    async claimEvent(provider, event) {
      const key = `webhook_events?provider=eq.${enc(provider)}&event_id=eq.${enc(event.id)}`;
      let existing = await one(`${key}&select=status,attempts`);
      if (!existing) {
        try {
          await db('webhook_events', {
            method: 'POST',
            prefer: 'return=minimal',
            body: {
              provider,
              event_id: event.id,
              event_type: event.providerEventType || event.type,
              occurred_at: event.occurredAt,
              payload: event.payload,
              status: 'received',
              attempts: 1,
            },
          });
          return 'claimed';
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          existing = await one(`${key}&select=status,attempts`);
          if (!existing) throw error;
        }
      }
      if (existing.status === 'processed' || existing.status === 'ignored') return 'already_processed';
      const attempts = Number(existing.attempts) || 0;
      const rows = await patch(`${key}&status=in.(failed,received)&attempts=eq.${attempts}&select=status`, {
        status: 'received',
        attempts: attempts + 1,
        error: null,
      });
      return rows.length > 0 ? 'claimed' : 'already_processed';
    },

    async markProcessed(provider, eventId, options = {}) {
      await patch(`webhook_events?provider=eq.${enc(provider)}&event_id=eq.${enc(eventId)}&select=status`, {
        status: 'processed',
        processed_at: options.nowIso || new Date().toISOString(),
        error: options.error ? String(options.error).slice(0, MAX_ERROR_LENGTH) : null,
      });
    },

    /** attempts was bumped at claim; the payload is deliberately NOT touched. */
    async markFailed(provider, eventId, error) {
      await patch(`webhook_events?provider=eq.${enc(provider)}&event_id=eq.${enc(eventId)}&select=status`, {
        status: 'failed',
        error: errorText(error),
      });
    },

    /** Record an event we will never act on. A processed row is never downgraded. */
    async markIgnored(provider, event, reason) {
      const key = `webhook_events?provider=eq.${enc(provider)}&event_id=eq.${enc(event.id)}`;
      try {
        await db('webhook_events', {
          method: 'POST',
          prefer: 'return=minimal',
          body: {
            provider,
            event_id: event.id,
            event_type: event.providerEventType || event.type,
            occurred_at: event.occurredAt,
            payload: event.payload,
            status: 'ignored',
            attempts: 1,
            error: reason,
            processed_at: new Date().toISOString(),
          },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        await patch(`${key}&status=in.(failed,received)&select=status`, { status: 'ignored', error: reason, processed_at: new Date().toISOString() });
      }
    },

    async failedEvents(limit = 50, maxAttempts = 10) {
      return list(await db(`webhook_events?status=eq.failed&attempts=lt.${maxAttempts}&payload=not.is.null&order=received_at.asc&limit=${limit}&select=*`));
    },

    async exhaustedEvents(maxAttempts = 10) {
      return list(await db(`webhook_events?status=eq.failed&attempts=gte.${maxAttempts}&select=provider,event_id,event_type,attempts,error`));
    },

    /* ---- subscriptions ---- */

    async findSubscription(provider, subscriptionId) {
      return one(`subscriptions?provider=eq.${enc(provider)}&provider_subscription_id=eq.${enc(subscriptionId)}&select=*&limit=1`);
    },

    /** Resolution ladder step 2: an earlier subscription of the same provider customer that still has an owner. */
    async findSubscriptionByCustomer(provider, customerId) {
      return one(`subscriptions?provider=eq.${enc(provider)}&provider_customer_id=eq.${enc(customerId)}&user_id=not.is.null&order=created_at.desc&limit=1&select=*`);
    },

    async insertSubscription(row) {
      const rows = list(await db('subscriptions', { method: 'POST', body: row, prefer: 'return=representation' }));
      return rows[0] || null;
    },

    /**
     * The conditional, ordered UPDATE of §6.3. Zero rows = stale or racing.
     * `lte`, not `lt`: Stripe stamps every event of one billing action with
     * the same whole-second `created` (checkout.session.completed,
     * customer.subscription.created and invoice.paid share it), so siblings
     * apply in delivery order while genuinely older events are still refused.
     * Replays of one event are stopped earlier, by event id.
     */
    async updateOrdered(provider, subscriptionId, fields, occurredAt) {
      const at = enc(occurredAt);
      return patch(
        `subscriptions?provider=eq.${enc(provider)}&provider_subscription_id=eq.${enc(subscriptionId)}` +
          `&or=(last_event_at.is.null,last_event_at.lte.${at})&select=*`,
        { ...fields, last_event_at: occurredAt },
      );
    },

    /** Terminal cancellation: unconditional, guarded only on status <> canceled. */
    async cancelTerminal(provider, subscriptionId, fields) {
      return patch(
        `subscriptions?provider=eq.${enc(provider)}&provider_subscription_id=eq.${enc(subscriptionId)}&status=neq.canceled&select=*`,
        { ...fields, status: 'canceled' },
      );
    },

    /** Unconditional write by key: reconcile rewrites, dispute flags, needs_reconcile. */
    async updateByKey(provider, subscriptionId, fields) {
      return patch(`subscriptions?provider=eq.${enc(provider)}&provider_subscription_id=eq.${enc(subscriptionId)}&select=*`, fields);
    },

    async flagReconcile(provider, subscriptionId) {
      return patch(`subscriptions?provider=eq.${enc(provider)}&provider_subscription_id=eq.${enc(subscriptionId)}&select=id`, { needs_reconcile: true });
    },

    async subscriptionsToReconcile(nowIso, limit = 50) {
      const flagged = list(await db(`subscriptions?needs_reconcile=is.true&order=updated_at.asc&limit=${limit}&select=*`));
      // past_due and paused can strand too (a lost dunning-recovery or resume
      // webhook), so they are re-read as well.
      const lapsed = list(await db(`subscriptions?status=in.(trialing,active,past_due,paused)&access_until=lt.${enc(nowIso)}&order=access_until.asc&limit=${limit}&select=*`));
      const seen = new Set();
      const out = [];
      for (const row of [...flagged, ...lapsed]) {
        const key = `${row.provider}:${row.provider_subscription_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
        if (out.length >= limit) break;
      }
      return out;
    },

    /** A true orphan: never owned and never detached by an account deletion. */
    async orphanSubscriptions() {
      return list(await db('subscriptions?user_id=is.null&detached_at=is.null&select=id,provider,status,created_at'));
    },

    /* ---- checkout_intents (§6.3 step 1) ---- */

    async findIntent(reservationId) {
      return one(`checkout_intents?reservation_id=eq.${enc(reservationId)}&select=*&limit=1`);
    },

    async consumeIntent(reservationId, nowIso) {
      return patch(`checkout_intents?reservation_id=eq.${enc(reservationId)}&consumed_at=is.null&select=reservation_id`, { consumed_at: nowIso });
    },

    /**
     * The unconditional trial-price check, fallback rung: does THIS user hold a
     * trial reservation with this provider for THIS price, made shortly before
     * the event? Narrowed on purpose — any old trial reservation must not
     * bless a later devtools checkout.
     * @param {string} userId
     * @param {string} provider
     * @param {{priceId?:string|null, notBefore?:string|null}} [match]
     */
    async hasTrialIntent(userId, provider, match = {}) {
      let path = `checkout_intents?user_id=eq.${enc(userId)}&provider=eq.${enc(provider)}&trial_granted=is.true`;
      if (match.priceId) path += `&price_id=eq.${enc(match.priceId)}`;
      if (match.notBefore) path += `&created_at=gte.${enc(match.notBefore)}`;
      const row = await one(`${path}&select=reservation_id&limit=1`);
      return Boolean(row);
    },

    /**
     * §5.3 layer 2 as a backstop at the webhook: a user who has, or ever had,
     * any OTHER subscription row (any provider, any status) never gets a
     * second trial, whatever a replayed or pre-minted reservation says.
     */
    async hasOtherSubscription(userId, provider, subscriptionId) {
      // Filtered in JS rather than with an `or=(…neq…)` clause so a provider id
      // never has to be quoted for PostgREST's list syntax. A user has a handful
      // of rows at most; the limit is a safety cap, not a page.
      const rows = list(await db(`subscriptions?user_id=eq.${enc(userId)}&select=provider,provider_subscription_id&limit=20`));
      return rows.some((r) => !(r.provider === provider && r.provider_subscription_id === subscriptionId));
    },

    /* ---- profiles (§6.3 step 3) ---- */

    async profileByEmail(email) {
      const address = String(email || '').trim().toLowerCase();
      if (!address) return null;
      return one(`profiles?email=eq.${enc(address)}&select=id,email&limit=1`);
    },

    /* ---- trial_claims and devices (§6.6, from the reservation row only) ---- */

    async startTrialClaim(emailHash, fields) {
      return patch(`trial_claims?email_hash=eq.${enc(emailHash)}&outcome=in.(reserved,expired)&select=outcome`, { ...fields, outcome: 'started' });
    },

    async setTrialOutcome(provider, subscriptionId, outcome, fromOutcomes) {
      const from = (fromOutcomes || []).map(enc).join(',');
      return patch(
        `trial_claims?provider=eq.${enc(provider)}&provider_subscription_id=eq.${enc(subscriptionId)}&outcome=in.(${from})&select=outcome`,
        { outcome },
      );
    },

    async consumeDevice(deviceId, userId, nowIso) {
      const device = await one(`devices?device_id=eq.${enc(deviceId)}&select=device_id,trial_count`);
      if (!device) return [];
      return patch(`devices?device_id=eq.${enc(deviceId)}&select=device_id`, {
        trial_consumed_at: nowIso,
        trial_count: (Number(device.trial_count) || 0) + 1,
        trial_user_id: userId,
        trial_reserved_until: null,
      });
    },
  };
}

/* ------------------------------------------------------------ applyEvent -- */

/**
 * The fields a normalised event writes to a `subscriptions` row, merged over
 * what is already there, with `access_until` recomputed from §6.5. Pure.
 *
 * @param {object} event normalised
 * @param {object|null} existing the current row, or null on first contact
 * @param {{plan?:string|null, hadTrial?:boolean, nowMs:number}} ctx
 * @returns {object} fields to write (never includes last_event_at; the store adds it)
 */
export function patchForEvent(event, existing, ctx) {
  const prev = existing || {};
  const nowIso = toIso(ctx.nowMs);
  const type = event.type;
  const fields = {};

  const plan = event.plan || ctx.plan || prev.plan || null;
  if (plan) fields.plan = plan;
  if (event.providerCustomerId) fields.provider_customer_id = event.providerCustomerId;
  if (event.providerPriceId) fields.provider_price_id = event.providerPriceId;
  if (typeof event.live === 'boolean') fields.live = event.live;

  if (SUB_EVENT_TYPES.has(type)) {
    const status = STATUS_FOR_TYPE[type] || event.status || prev.status || 'active';
    fields.status = status;
    fields.had_trial = Boolean(prev.had_trial || event.hadTrial || ctx.hadTrial || status === 'trialing');
    if (event.trialStartsAt) fields.trial_started_at = event.trialStartsAt;
    if (event.trialEndsAt) fields.trial_ends_at = event.trialEndsAt;
    if (event.currentPeriodStart) fields.current_period_start = event.currentPeriodStart;
    if (event.currentPeriodEnd) fields.current_period_end = event.currentPeriodEnd;
    if (event.nextBilledAt !== undefined) fields.next_billed_at = event.nextBilledAt;

    const sc = event.scheduledChange;
    if (type === 'sub.canceled') {
      fields.cancel_at = (sc && sc.action === 'cancel' && sc.effectiveAt) || prev.cancel_at || null;
      fields.canceled_at = event.canceledAt || prev.canceled_at || nowIso;
    } else {
      // A subscription snapshot carries its scheduled change (or none): a
      // cleared scheduled cancel must clear cancel_at too.
      fields.cancel_at = sc && sc.action === 'cancel' ? sc.effectiveAt || null : null;
      if (event.canceledAt) fields.canceled_at = event.canceledAt;
    }
    if (sc && sc.action === 'pause') fields.resume_at = sc.resumeAt || null;
    else if (status !== 'paused') fields.resume_at = null;
    fields.paused_at = event.pausedAt || (status === 'paused' ? prev.paused_at || nowIso : null);

    if (type === 'sub.past_due') fields.past_due_since = prev.past_due_since || nowIso;
    else if (status === 'active' || status === 'trialing') fields.past_due_since = null;

    if (type === 'sub.activated') fields.ever_paid = true;
  }

  if (type === 'txn.completed' && event.totalIsZero === false) {
    fields.ever_paid = true;
    if (event.amount != null) fields.display_amount = event.amount;
    if (event.currency) fields.display_currency = event.currency;
    if (typeof event.taxInclusive === 'boolean') fields.display_tax_inclusive = event.taxInclusive;
    if (event.currentPeriodStart) fields.current_period_start = event.currentPeriodStart;
    if (event.currentPeriodEnd) fields.current_period_end = event.currentPeriodEnd;
    if (!prev.status && event.status) fields.status = event.status;
    fields.had_trial = Boolean(prev.had_trial || ctx.hadTrial || event.hadTrial);
  }

  if (type === 'txn.chargeback') fields.dispute_open = true;

  const merged = { ...prev, ...fields };
  if (merged.status) fields.access_until = toIso(accessUntilFor(merged, ctx.nowMs));
  return fields;
}

/**
 * §6.3 resolution ladder at first contact. Returns the owner (or null), the
 * intent row when `rid` named one, and which rung answered.
 */
async function resolveOwner(event, deps) {
  const { store, provider } = deps;
  let intent = null;
  if (event.reservationId) {
    intent = await store.findIntent(event.reservationId);
    if (intent && intent.provider && intent.provider !== provider.id) intent = null;
  }
  if (intent && intent.user_id) return { userId: intent.user_id, intent, source: 'reservation' };
  if (event.providerCustomerId) {
    const prior = await store.findSubscriptionByCustomer(provider.id, event.providerCustomerId);
    if (prior && prior.user_id) return { userId: prior.user_id, intent, source: 'customer' };
  }
  if (event.customerEmail) {
    const profile = await store.profileByEmail(event.customerEmail);
    if (profile && profile.id) return { userId: profile.id, intent, source: 'email' };
  }
  return { userId: null, intent, source: 'none' };
}

/** How far back the fallback reservation lookup may reach from the event. */
const TRIAL_INTENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Does a subscription on a trial price have a legitimate reservation behind
 * it? (§5.5 "unconditional server-side backstop", §6.3 "the trial-price check".)
 *
 * In order:
 *   0. No owner at all -> not granted (an orphan on a trial price is cancelled,
 *      never provisioned).
 *   1. §5.3 layer 2, re-applied here as a backstop: a user who has, or ever
 *      had, any OTHER subscription row gets no trial — whatever `rid` says.
 *      This closes the two replays a browser can attempt with a reservation
 *      id it was legitimately handed: re-using it after the trial it bought,
 *      and pre-minting several reservations while still eligible.
 *   2. The reservation named by `rid` (first contact) grants only when it was
 *      granted a trial AND belongs to the resolved owner.
 *   3. A row that already passed this check (owner set, trialing, had_trial)
 *      stays granted when the sibling sub.trialing / sub.created arrives.
 *   4. Otherwise a reservation for this user, this provider, THIS price, made
 *      within the last seven days before the event.
 *
 * @returns {Promise<boolean>}
 */
async function trialGranted({ event, existing, intent, userId, occurredAt }, deps) {
  const { store, provider } = deps;
  if (!userId) return false;
  const subscriptionId = event.providerSubscriptionId;
  if (await store.hasOtherSubscription(userId, provider.id, subscriptionId)) return false;
  if (intent && intent.trial_granted === true && intent.user_id === userId) return true;
  if (existing && existing.user_id === userId && existing.status === 'trialing' && existing.had_trial === true) return true;
  const occurredMs = Date.parse(occurredAt);
  const notBefore = Number.isFinite(occurredMs) ? toIso(occurredMs - TRIAL_INTENT_WINDOW_MS) : null;
  return store.hasTrialIntent(userId, provider.id, { priceId: event.providerPriceId, notBefore });
}

/**
 * Apply one normalised event to the system of record (§6.3, §6.6).
 *
 * Throws when the event could not be applied — the caller marks the row
 * `failed` and answers non-2xx so the provider retries. Returns
 * `{ action, error? }` otherwise; `error` is a note kept on the processed row
 * (`trial_price_without_reservation`).
 *
 * @param {object} event normalised event from an adapter
 * @param {{
 *   store:ReturnType<typeof createWebhookStore>,
 *   provider:object, providerCtx:object, env:Record<string,string>,
 *   alert?:(kind:string, detail:object)=>void, now?:()=>number
 * }} deps
 * @returns {Promise<{action:string, error?:string, reason?:string}>}
 */
export async function applyEvent(event, deps) {
  const { store, provider, providerCtx, env } = deps;
  const alert = deps.alert || defaultAlert;
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  const nowIso = toIso(nowMs);
  const providerId = provider.id;

  if (!event || event.type === 'ignore') return { action: 'ignored', reason: 'unhandled_event_type' };
  const subscriptionId = event.providerSubscriptionId;
  if (!subscriptionId) return { action: 'ignored', reason: 'no_subscription' };
  if (event.customDataUserIdSeen) {
    console.warn('[webhook] custom_data carried a user_id; discarded, never used to resolve', { type: event.type });
  }
  const occurredAt = event.occurredAt || nowIso;

  let existing = await store.findSubscription(providerId, subscriptionId);
  let intent = null;
  let userId = existing ? existing.user_id : null;
  let source = existing ? 'row' : null;

  if (!existing) {
    // Money-neutral events never create a row: a $0 trial transaction, a
    // failed charge or an adjustment before the subscription itself is known
    // is simply noted.
    if (
      event.type === 'txn.failed' ||
      event.type === 'txn.refunded' ||
      event.type === 'txn.chargeback' ||
      (event.type === 'txn.completed' && event.totalIsZero !== false)
    ) {
      return { action: 'noted', reason: 'no_row_yet' };
    }
    const resolved = await resolveOwner(event, deps);
    userId = resolved.userId;
    intent = resolved.intent;
    source = resolved.source;
    if (intent) await store.consumeIntent(intent.reservation_id, nowIso);
  }

  // The unconditional trial-price check (§5.5, §6.3): a trial price with no
  // matching reservation for this user is cancelled at the provider, now.
  // It runs on sub.created / sub.trialing, and on any first contact that
  // would insert a trialing row (an out-of-order sub.updated must not slip a
  // trial in ahead of the check).
  // A trial price, or (for an adapter whose trial is not a separate price)
  // a subscription that arrives already trialing.
  const trialPriced = isTrialPriceId(event.providerPriceId, env) || (event.hadTrial === true && event.status === 'trialing');
  const trialContact =
    event.type === 'sub.created' ||
    event.type === 'sub.trialing' ||
    (!existing && SUB_EVENT_TYPES.has(event.type) && event.status === 'trialing');
  if (trialPriced && trialContact && !(existing && existing.status === 'canceled')) {
    const granted = await trialGranted({ event, existing, intent, userId, occurredAt }, deps);
    if (!granted) {
      await provider.cancelSubscription(subscriptionId, { effectiveFrom: 'immediately' }, providerCtx);
      const fields = {
        provider: providerId,
        provider_subscription_id: subscriptionId,
        provider_customer_id: event.providerCustomerId || (existing && existing.provider_customer_id) || null,
        provider_price_id: event.providerPriceId,
        plan: event.plan || (existing && existing.plan) || 'monthly',
        status: 'canceled',
        had_trial: true,
        canceled_at: nowIso,
        cancel_at: null,
        live: typeof event.live === 'boolean' ? event.live : true,
        last_event_at: occurredAt,
      };
      fields.access_until = toIso(accessUntilFor(fields, nowMs));
      if (existing) await store.updateByKey(providerId, subscriptionId, fields);
      else {
        try {
          await store.insertSubscription({ ...fields, user_id: userId });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          await store.updateByKey(providerId, subscriptionId, fields);
        }
      }
      alert('trial_price_without_reservation', { type: event.type, source, has_owner: Boolean(userId) });
      return { action: 'rejected_trial', error: 'trial_price_without_reservation' };
    }
  }

  const planHint = (intent && intent.plan) || (planForPriceId(event.providerPriceId, env) || {}).plan || null;
  const hadTrialHint = Boolean(intent && intent.trial_granted === true);
  const fields = patchForEvent(event, existing, { plan: planHint, hadTrial: hadTrialHint, nowMs });

  // An existing row nobody owns (and nobody detached) is an orphan; every
  // retry re-runs the ladder so a later sign-up on that email attaches it.
  let orphan = false;
  if (existing && !existing.user_id && !existing.detached_at) {
    const resolved = await resolveOwner(event, deps);
    if (resolved.userId) {
      userId = resolved.userId;
      source = resolved.source;
      fields.user_id = userId;
      if (resolved.intent) await store.consumeIntent(resolved.intent.reservation_id, nowIso);
    } else {
      orphan = true;
    }
  }

  /* ---- first contact: insert ---- */
  let inserted = false;
  if (!existing) {
    if (!fields.plan) throw new Error('unknown_plan: the price id maps to no MOR_PRICE_* env var');
    if (!fields.status) fields.status = 'active';
    const row = {
      ...fields,
      user_id: userId,
      provider: providerId,
      provider_subscription_id: subscriptionId,
      last_event_at: occurredAt,
    };
    try {
      existing = await store.insertSubscription(row);
      inserted = true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A sibling event inserted first; fall through to the ordered update.
      existing = await store.findSubscription(providerId, subscriptionId);
      if (!existing) throw error;
    }
  }

  if (inserted) {
    // The reservation's side effects (§6.6) — from the intent row, never from custom_data.
    if (intent && intent.trial_granted === true && fields.status === 'trialing') {
      if (intent.email_hash) {
        await store.startTrialClaim(intent.email_hash, {
          user_id: userId,
          device_id: intent.device_id || null,
          provider: providerId,
          provider_customer_id: event.providerCustomerId || intent.provider_customer_id || null,
          provider_subscription_id: subscriptionId,
        });
      }
      if (intent.device_id && userId) await store.consumeDevice(intent.device_id, userId, nowIso);
    }
    if (event.type === 'sub.activated' || (event.type === 'txn.completed' && event.totalIsZero === false)) {
      await store.setTrialOutcome(providerId, subscriptionId, 'converted', ['reserved', 'started']);
    }
    if (!userId) {
      // Written with user_id = null so it is visible; the event stays failed
      // (and re-driven by the cron) until an owner can be found.
      alert('orphan_subscription', { type: event.type, has_email: Boolean(event.customerEmail), has_customer: Boolean(event.providerCustomerId) });
      throw new Error('orphan_subscription');
    }
    return { action: 'inserted', source };
  }

  /* ---- existing row ---- */
  let result;
  if (event.type === 'txn.failed') {
    result = { action: 'noted' };
  } else if (event.type === 'txn.refunded') {
    await store.setTrialOutcome(providerId, subscriptionId, 'refunded', ['reserved', 'started', 'converted']);
    if (event.fullyRefunded === true && existing.status !== 'canceled') {
      // The refund policy promises that a refund ends the subscription and the
      // access with it. A partial (goodwill) refund changes nothing.
      try {
        await provider.cancelSubscription(subscriptionId, { effectiveFrom: 'immediately' }, providerCtx);
      } catch (error) {
        alert('refund_cancel_failed', { reason: error && error.message ? error.message : String(error) });
        await store.flagReconcile(providerId, subscriptionId);
      }
      await store.cancelTerminal(providerId, subscriptionId, { canceled_at: nowIso, cancel_at: null, access_until: nowIso, last_event_at: occurredAt });
      result = { action: 'updated', reason: 'refund' };
    } else {
      result = { action: 'noted', reason: 'refund' };
    }
  } else if (event.type === 'txn.chargeback') {
    await store.updateByKey(providerId, subscriptionId, { dispute_open: true });
    await store.setTrialOutcome(providerId, subscriptionId, 'chargeback', ['reserved', 'started', 'converted', 'cancelled', 'refunded']);
    alert('chargeback', { type: event.type });
    result = { action: 'updated', reason: 'chargeback' };
  } else if (event.type === 'sub.canceled') {
    // Terminal and unconditional (guarded on status <> canceled), so a stale
    // sub.updated can never resurrect a cancelled subscription.
    const rows = await store.cancelTerminal(providerId, subscriptionId, { ...fields, last_event_at: occurredAt });
    if (!(existing.ever_paid || fields.ever_paid)) {
      await store.setTrialOutcome(providerId, subscriptionId, 'cancelled', ['reserved', 'started']);
    }
    result = { action: rows.length > 0 ? 'canceled' : 'already_canceled' };
  } else if (event.type === 'txn.completed' && event.totalIsZero !== false) {
    // A $0 trial transaction: nothing to record beyond the event itself.
    result = { action: 'noted', reason: 'zero_total' };
  } else if (existing.status === 'canceled' && SUB_EVENT_TYPES.has(event.type)) {
    // Never resurrect. The terminal state wins regardless of timestamps.
    result = { action: 'stale', reason: 'already_canceled' };
  } else {
    const rows = await store.updateOrdered(providerId, subscriptionId, fields, occurredAt);
    if (rows.length === 0) {
      await store.flagReconcile(providerId, subscriptionId);
      result = { action: 'stale', reason: 'older_than_last_event' };
    } else {
      // §6.6: money moved — sub.activated (the provider has successfully billed the
      // customer") or a non-zero transaction. Either one alone converts the
      // claim, so losing the other webhook does not leave it `started`.
      if (event.type === 'sub.activated' || (event.type === 'txn.completed' && event.totalIsZero === false)) {
        await store.setTrialOutcome(providerId, subscriptionId, 'converted', ['reserved', 'started']);
      }
      result = { action: 'updated' };
    }
  }

  if (orphan) {
    alert('orphan_subscription', { type: event.type, has_email: Boolean(event.customerEmail), has_customer: Boolean(event.providerCustomerId) });
    throw new Error('orphan_subscription');
  }
  return result;
}

/* -------------------------------------------------------------- handler --- */

/**
 * @param {{
 *   store:ReturnType<typeof createWebhookStore>,
 *   provider:object, providerCtx:object, env:Record<string,string>,
 *   secret:string, alert?:Function, now?:()=>number
 * }} deps
 */
export function createWebhookHandler(deps) {
  const { store, provider, providerCtx, env, secret } = deps;
  const alert = deps.alert || defaultAlert;
  const now = deps.now || (() => Date.now());
  const expectLive = !sandboxMode(env);

  async function POST(request) {
    let raw;
    try {
      raw = await request.text(); // READ THE BODY EXACTLY ONCE, AS TEXT
    } catch {
      return new Response('bad request', { status: 400 });
    }

    const check = await provider.verifyWebhook(raw, request.headers, secret, { now: now() });
    if (!check || !check.ok) {
      console.warn('[webhook] rejected', { reason: (check && check.reason) || 'invalid' });
      return new Response('invalid signature', { status: 401 });
    }

    let events;
    try {
      events = provider.parseEvents(raw, { env });
    } catch (error) {
      console.warn('[webhook] unparseable body', { reason: error && error.message });
      return new Response('bad request', { status: 400 });
    }

    let failed = 0;
    try {
      for (const event of events) {
        if (!event || !event.id) continue;
        // Environment gate: a sandbox destination left registered must never
        // write real entitlements into the production database.
        if (event.live !== expectLive) {
          await store.markIgnored(provider.id, event, event.live == null ? 'live_flag_unknown' : 'live_flag_mismatch');
          continue;
        }
        const claim = await store.claimEvent(provider.id, event);
        if (claim === 'already_processed') continue;
        try {
          const full = typeof provider.enrichEvent === 'function' ? await provider.enrichEvent(event, providerCtx) : event;
          const result = await applyEvent(full, { store, provider, providerCtx, env, alert, now });
          if (result.action === 'ignored') await store.markIgnored(provider.id, event, result.reason || 'ignored');
          else await store.markProcessed(provider.id, event.id, { error: result.error || null, nowIso: toIso(now()) });
        } catch (error) {
          console.error('[webhook] event failed', { type: event.type, reason: errorText(error) });
          await store.markFailed(provider.id, event.id, error); // attempts += 1 at claim, payload KEPT
          failed += 1;
        }
      }
    } catch (error) {
      // The ledger itself is unreachable: let the provider retry the whole delivery.
      console.error('[webhook] ledger error', { reason: errorText(error) });
      return new Response('retry', { status: 503 });
    }

    // A provider retry is the cheapest possible recovery. Use it.
    return failed > 0 ? new Response('retry', { status: 500 }) : new Response('ok', { status: 200 });
  }

  return { POST };
}

/* --------------------------------------------------------------- wiring --- */

/**
 * Build the production dependencies from the environment. Exported so the
 * reconcile cron shares exactly the same wiring.
 * @returns {{store:object, provider:object, providerCtx:object, env:Record<string,string>, secret:string}}
 */
export function productionDeps() {
  // Production: a missing secret is a 503 that names the variable.
  // Preview/development: requireEnv() would hand back the well-known
  // `dev-missing-MOR_WEBHOOK_SECRET` placeholder, and a preview deployment
  // pointed at a real database would then accept any body signed with it.
  // An unset secret therefore means "no delivery ever verifies" (401).
  if (isProduction()) requireEnv(['MOR_WEBHOOK_SECRET']);
  const env = requireEnv(['MOR_API_KEY']);
  env.MOR_WEBHOOK_SECRET = readEnv('MOR_WEBHOOK_SECRET');
  for (const name of PROVIDER_ENV_OPTIONAL) env[name] = readEnv(name);
  const provider = getProvider(providerName());
  return {
    env,
    secret: env.MOR_WEBHOOK_SECRET,
    provider,
    providerCtx: { env, fetchImpl: globalThis.fetch, isProd: isProduction() },
    store: createWebhookStore(supabaseDb),
  };
}

/** @param {Request} request */
export async function POST(request) {
  try {
    return await createWebhookHandler(productionDeps()).POST(request);
  } catch (error) {
    console.error('[webhook] configuration error', { reason: errorText(error) });
    return new Response('not configured', { status: 503 });
  }
}

/** @param {Request} request */
export async function GET(request) {
  return methodNotAllowed(request, METHODS);
}

/** @param {Request} request */
export async function OPTIONS(request) {
  return methodNotAllowed(request, METHODS);
}

