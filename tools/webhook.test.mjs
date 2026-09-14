/**
 * tools/webhook.test.mjs — the merchant-of-record adapters, the webhook handler,
 * applyEvent, the four billing endpoints and the reconcile cron.
 *
 *   node --test tools/webhook.test.mjs
 *
 * No network: every provider call goes through a recording fetch stub and
 * every database call through an in-memory store with the same interface as
 * createWebhookStore(db). Every secret and id below is an obviously fake
 * TESTFIXTURE placeholder — realistic-looking keys trip GitHub push protection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { base64Encode, bytesToHex, hmacSha256 } from '../api/_lib/crypto.js';
import {
  ADAPTER_METHODS,
  PROVIDER_IDS,
  assertAdapter,
  getProvider,
  isTrialPriceId,
  listProviders,
  moneyFromMinor,
  normalizeEvent,
  planForPriceId,
  priceIdFor,
  reservationIdFrom,
  sandboxMode,
} from '../api/_lib/providers/index.js';
import { applyEvent, createWebhookHandler, createWebhookStore, patchForEvent, productionDeps as webhookProductionDeps } from '../api/webhooks/mor.js';
import { createPortalHandler } from '../api/billing/portal.js';
import { createCancelHandler, effectiveFromFor } from '../api/billing/cancel.js';
import { createPauseHandler, resumeAtFor } from '../api/billing/pause.js';
import { createSwitchHandler, ineligibleReason } from '../api/billing/switch.js';
import { createReconcileHandler, productionDeps as reconcileProductionDeps, reconcileSubscription } from '../api/cron/reconcile.js';

/* ------------------------------------------------------------- fixtures ---- */

const [PRIMARY, FALLBACK] = PROVIDER_IDS;
const primary = getProvider(PRIMARY);
const fallback = getProvider(FALLBACK);

const SECRET = 'TESTFIXTURE-webhook-secret-not-real';
const CRON_SECRET = 'TESTFIXTURE-cron-secret-not-real';

const ENV = Object.freeze({
  MOR_API_KEY: 'pdl_sdbx_TESTFIXTURE_not_a_real_key',
  MOR_API_BASE: 'https://mor.testfixture.invalid',
  MOR_SANDBOX: 'true',
  MOR_STOREFRONT: 'https://testfixture.onfastspring.com/popup-testfixture',
  MOR_PRICE_MONTHLY_TRIAL: 'pri_TESTFIXTURE_monthly_trial',
  MOR_PRICE_MONTHLY: 'pri_TESTFIXTURE_monthly',
  MOR_PRICE_YEARLY_TRIAL: 'pri_TESTFIXTURE_yearly_trial',
  MOR_PRICE_YEARLY: 'pri_TESTFIXTURE_yearly',
});

const USER = 'b0a2c1de-0000-4000-8000-000000000001';
const USER2 = 'b0a2c1de-0000-4000-8000-000000000002';
const RID = '3f2b9c40-0000-4000-8000-00000000000a';
const DEVICE = '8e1f0000-0000-4000-8000-00000000000d';
const EMAIL_HASH = '\\x00testfixture00';
const SUB = 'sub_01testfixture0000000000000';
const CTM = 'ctm_01testfixture0000000000000';
const TXN = 'txn_01testfixture0000000000000';

const T0 = Date.parse('2026-09-14T10:00:00Z');
const iso = (offsetMs = 0) => new Date(T0 + offsetMs).toISOString();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** Recording fetch stub. `routes` maps `${METHOD} ${path}` to a body or a function(url, init). */
function fetchStub(routes, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${(init.method || 'GET').toUpperCase()} ${u.pathname}`;
    const call = { key, url: u, init, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const route = routes[key] ?? routes[`${(init.method || 'GET').toUpperCase()} *`];
    if (route === undefined) return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
    const out = typeof route === 'function' ? route(call) : route;
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
  };
  impl.calls = calls;
  return impl;
}

function ctxWith(fetchImpl, env = ENV) {
  return { env, fetchImpl, isProd: false };
}

async function signPrimary(raw, ts = Math.floor(T0 / 1000), secret = SECRET) {
  return `ts=${ts};h1=${bytesToHex(await hmacSha256(secret, `${ts}:${raw}`))}`;
}

async function signFallback(raw, secret = SECRET) {
  return base64Encode(await hmacSha256(secret, raw));
}

/** A notification from the primary provider. */
function primaryNotification(eventType, data, { id = 'evt_01testfixture0000000000000', occurredAt = iso() } = {}) {
  return { event_id: id, event_type: eventType, occurred_at: occurredAt, notification_id: 'ntf_01testfixture0000000000000', data };
}

function subscriptionEntity(overrides = {}) {
  return {
    id: SUB,
    status: 'trialing',
    customer_id: CTM,
    currency_code: 'USD',
    started_at: iso(),
    next_billed_at: iso(3 * DAY),
    paused_at: null,
    canceled_at: null,
    current_billing_period: null,
    scheduled_change: null,
    custom_data: { rid: RID, v: 3 },
    items: [
      {
        status: 'trialing',
        quantity: 1,
        trial_dates: { starts_at: iso(), ends_at: iso(3 * DAY) },
        price: { id: ENV.MOR_PRICE_MONTHLY_TRIAL, product_id: 'pro_TESTFIXTURE', trial_period: { interval: 'day', frequency: 3 }, unit_price: { amount: '1000', currency_code: 'USD' } },
      },
    ],
    ...overrides,
  };
}

function transactionEntity(overrides = {}) {
  return {
    id: TXN,
    status: 'completed',
    customer_id: CTM,
    subscription_id: SUB,
    currency_code: 'USD',
    origin: 'subscription_recurring',
    custom_data: { rid: RID, v: 3 },
    billing_period: { starts_at: iso(3 * DAY), ends_at: iso(33 * DAY) },
    details: { totals: { subtotal: '1000', tax: '190', total: '1190', grand_total: '1190', currency_code: 'USD' } },
    items: [{ price: { id: ENV.MOR_PRICE_MONTHLY_TRIAL }, quantity: 1 }],
    ...overrides,
  };
}

/* ------------------------------------------------------ in-memory store ---- */

/**
 * Same interface as createWebhookStore(db), backed by arrays, with the same
 * semantics (ordered update filter, terminal cancel guard, claim CAS).
 */
function memoryStore(seed = {}) {
  const events = new Map();
  const subs = (seed.subscriptions || []).map((r) => ({ ...r }));
  const intents = (seed.intents || []).map((r) => ({ ...r }));
  const profiles = seed.profiles || [];
  const claims = (seed.claims || []).map((r) => ({ ...r }));
  const devices = (seed.devices || []).map((r) => ({ ...r }));
  const calls = [];
  const key = (p, id) => `${p}:${id}`;
  const findSub = (p, id) => subs.find((r) => r.provider === p && r.provider_subscription_id === id) || null;
  let nextId = 1;

  const store = {
    calls,
    events,
    subs,
    intents,
    claims,
    devices,
    async claimEvent(provider, event) {
      calls.push(['claimEvent', event.id]);
      const k = key(provider, event.id);
      const row = events.get(k);
      if (!row) {
        events.set(k, { provider, event_id: event.id, event_type: event.providerEventType, occurred_at: event.occurredAt, payload: event.payload, status: 'received', attempts: 1, error: null });
        return 'claimed';
      }
      if (row.status === 'processed' || row.status === 'ignored') return 'already_processed';
      row.status = 'received';
      row.attempts += 1;
      row.error = null;
      return 'claimed';
    },
    async markProcessed(provider, id, options = {}) {
      calls.push(['markProcessed', id]);
      const row = events.get(key(provider, id));
      if (row) Object.assign(row, { status: 'processed', processed_at: options.nowIso || iso(), error: options.error || null });
    },
    async markFailed(provider, id, error) {
      calls.push(['markFailed', id]);
      const row = events.get(key(provider, id));
      if (row) Object.assign(row, { status: 'failed', error: error && error.message ? error.message : String(error) });
    },
    async markIgnored(provider, event, reason) {
      calls.push(['markIgnored', event.id, reason]);
      const k = key(provider, event.id);
      const row = events.get(k);
      if (!row) events.set(k, { provider, event_id: event.id, event_type: event.providerEventType, payload: event.payload, status: 'ignored', attempts: 1, error: reason });
      else if (row.status === 'failed' || row.status === 'received') Object.assign(row, { status: 'ignored', error: reason });
    },
    async failedEvents(limit = 50, maxAttempts = 10) {
      return [...events.values()].filter((r) => r.status === 'failed' && r.attempts < maxAttempts && r.payload).slice(0, limit);
    },
    async exhaustedEvents(maxAttempts = 10) {
      return [...events.values()].filter((r) => r.status === 'failed' && r.attempts >= maxAttempts);
    },
    async findSubscription(provider, id) {
      return findSub(provider, id) ? { ...findSub(provider, id) } : null;
    },
    async findSubscriptionByCustomer(provider, customerId) {
      const hit = [...subs].reverse().find((r) => r.provider === provider && r.provider_customer_id === customerId && r.user_id);
      return hit ? { ...hit } : null;
    },
    async insertSubscription(row) {
      calls.push(['insertSubscription', row.provider_subscription_id]);
      if (findSub(row.provider, row.provider_subscription_id)) {
        const error = new Error('duplicate');
        error.code = '23505';
        throw error;
      }
      const full = { id: `row-${nextId++}`, ever_paid: false, had_trial: false, dispute_open: false, needs_reconcile: false, live: true, ...row };
      subs.push(full);
      return { ...full };
    },
    async updateOrdered(provider, id, fields, occurredAt) {
      calls.push(['updateOrdered', id, occurredAt]);
      const row = findSub(provider, id);
      if (!row) return [];
      if (row.last_event_at && !(Date.parse(row.last_event_at) <= Date.parse(occurredAt))) return []; // lte, as the real store
      Object.assign(row, fields, { last_event_at: occurredAt });
      return [{ ...row }];
    },
    async cancelTerminal(provider, id, fields) {
      calls.push(['cancelTerminal', id]);
      const row = findSub(provider, id);
      if (!row || row.status === 'canceled') return [];
      Object.assign(row, fields, { status: 'canceled' });
      return [{ ...row }];
    },
    async updateByKey(provider, id, fields) {
      calls.push(['updateByKey', id, Object.keys(fields)]);
      const row = findSub(provider, id);
      if (!row) return [];
      Object.assign(row, fields);
      return [{ ...row }];
    },
    async flagReconcile(provider, id) {
      calls.push(['flagReconcile', id]);
      const row = findSub(provider, id);
      if (row) row.needs_reconcile = true;
      return row ? [{ id: row.id }] : [];
    },
    async subscriptionsToReconcile(nowIso, limit = 50) {
      return subs.filter((r) => r.needs_reconcile || (['trialing', 'active'].includes(r.status) && r.access_until && Date.parse(r.access_until) < Date.parse(nowIso))).slice(0, limit).map((r) => ({ ...r }));
    },
    async orphanSubscriptions() {
      return subs.filter((r) => !r.user_id && !r.detached_at).map((r) => ({ ...r }));
    },
    async findIntent(rid) {
      const hit = intents.find((r) => r.reservation_id === rid);
      return hit ? { ...hit } : null;
    },
    async consumeIntent(rid, nowIso) {
      calls.push(['consumeIntent', rid]);
      const hit = intents.find((r) => r.reservation_id === rid);
      if (hit && !hit.consumed_at) hit.consumed_at = nowIso;
      return hit ? [hit] : [];
    },
    async hasTrialIntent(userId, provider, match = {}) {
      calls.push(['hasTrialIntent', userId, match.priceId || null, match.notBefore || null]);
      return intents.some(
        (r) =>
          r.user_id === userId &&
          r.provider === provider &&
          r.trial_granted === true &&
          (!match.priceId || r.price_id === match.priceId) &&
          (!match.notBefore || !r.created_at || Date.parse(r.created_at) >= Date.parse(match.notBefore)),
      );
    },
    async hasOtherSubscription(userId, provider, subscriptionId) {
      calls.push(['hasOtherSubscription', userId, subscriptionId]);
      return subs.some((r) => r.user_id === userId && !(r.provider === provider && r.provider_subscription_id === subscriptionId));
    },
    async profileByEmail(email) {
      const hit = profiles.find((p) => p.email === String(email).toLowerCase());
      return hit ? { ...hit } : null;
    },
    async startTrialClaim(emailHash, fields) {
      calls.push(['startTrialClaim', emailHash]);
      const hit = claims.find((c) => c.email_hash === emailHash && ['reserved', 'expired'].includes(c.outcome));
      if (!hit) return [];
      Object.assign(hit, fields, { outcome: 'started' });
      return [hit];
    },
    async setTrialOutcome(provider, id, outcome, from) {
      calls.push(['setTrialOutcome', id, outcome]);
      const hit = claims.find((c) => c.provider === provider && c.provider_subscription_id === id && from.includes(c.outcome));
      if (!hit) return [];
      hit.outcome = outcome;
      return [hit];
    },
    async consumeDevice(deviceId, userId, nowIso) {
      calls.push(['consumeDevice', deviceId]);
      const hit = devices.find((d) => d.device_id === deviceId);
      if (!hit) return [];
      Object.assign(hit, { trial_consumed_at: nowIso, trial_count: (hit.trial_count || 0) + 1, trial_user_id: userId, trial_reserved_until: null });
      return [hit];
    },
  };
  return store;
}

function seededIntent(overrides = {}) {
  return {
    reservation_id: RID,
    user_id: USER,
    email_hash: EMAIL_HASH,
    device_id: DEVICE,
    plan: 'monthly',
    trial_granted: true,
    price_id: ENV.MOR_PRICE_MONTHLY_TRIAL,
    provider: PRIMARY,
    provider_transaction_id: TXN,
    provider_customer_id: CTM,
    consumed_at: null,
    ...overrides,
  };
}

function providerStub(overrides = {}) {
  const calls = [];
  return {
    calls,
    id: PRIMARY,
    priceIdFor: (input, env) => priceIdFor(input, env),
    async cancelSubscription(id, options, ctx) {
      calls.push(['cancelSubscription', id, options.effectiveFrom]);
      return overrides.cancel ? overrides.cancel(id, options, ctx) : { ok: true, status: options.effectiveFrom === 'immediately' ? 'canceled' : 'active', scheduledChange: options.effectiveFrom === 'immediately' ? null : { action: 'cancel', effectiveAt: iso(30 * DAY), resumeAt: null } };
    },
    async pauseSubscription(id, options) {
      calls.push(['pauseSubscription', id, options.effectiveFrom, options.resumeAt]);
      return { ok: true, status: 'active', scheduledChange: { action: 'pause', effectiveAt: iso(30 * DAY), resumeAt: options.resumeAt } };
    },
    async changePlan(id, priceId, options) {
      calls.push(['changePlan', id, priceId, options.prorate]);
      return { ok: true, status: 'active', nextBilledAt: iso(365 * DAY) };
    },
    async createPortalSession(customerId, ids) {
      calls.push(['createPortalSession', customerId, ids]);
      return { overview: 'https://portal.testfixture.invalid/overview', cancel: 'https://portal.testfixture.invalid/cancel', update_payment_method: 'https://portal.testfixture.invalid/pay', expires_in: 900 };
    },
    async getSubscription(id) {
      calls.push(['getSubscription', id]);
      return overrides.getSubscription ? overrides.getSubscription(id) : normalizeEvent({ type: 'sub.updated', occurredAt: iso(40 * DAY), providerSubscriptionId: id, status: 'active', plan: 'monthly', currentPeriodStart: iso(33 * DAY), currentPeriodEnd: iso(63 * DAY), nextBilledAt: iso(63 * DAY) });
    },
    verifyWebhook: primary.verifyWebhook,
    parseEvents: primary.parseEvents,
    ...overrides,
  };
}

function webhookRequest(raw, headers) {
  return new Request('https://helpmebreath.com/api/webhooks/mor', { method: 'POST', headers, body: raw });
}

async function postPrimary(handler, notification, { ts, secret } = {}) {
  const raw = JSON.stringify(notification);
  const sig = await signPrimary(raw, ts, secret);
  return handler.POST(webhookRequest(raw, { 'paddle-signature': sig, 'content-type': 'application/json' }));
}

/* ============================================================ index.js ====== */

test('both adapters implement contract v3', () => {
  for (const adapter of Object.values(listProviders())) assertAdapter(adapter);
  assert.equal(ADAPTER_METHODS.length, 11);
  assert.throws(() => assertAdapter({ id: 'x' }), /missing priceIdFor/);
  assert.throws(() => getProvider('stripe-is-not-a-thing-here'), /Unknown MOR_PROVIDER/);
});

test('priceIdFor reads the server env and never a browser value', () => {
  assert.equal(priceIdFor({ plan: 'monthly', trial: true }, ENV), ENV.MOR_PRICE_MONTHLY_TRIAL);
  assert.equal(priceIdFor({ plan: 'yearly', trial: false }, ENV), ENV.MOR_PRICE_YEARLY);
  assert.throws(() => priceIdFor({ plan: 'lifetime' }, ENV), /Unknown plan/);
  // One plan, two billing periods: anything else is an unknown plan, including
  // the second plan the design once reserved room for.
  assert.throws(() => priceIdFor({ plan: 'retired_second_plan', trial: false }, ENV), /Unknown plan/);
  assert.throws(() => priceIdFor({ plan: 'monthly', trial: false }, { ...ENV, MOR_PRICE_MONTHLY: '' }), /Missing environment variable MOR_PRICE_MONTHLY/);
  assert.deepEqual(planForPriceId(ENV.MOR_PRICE_YEARLY_TRIAL, ENV), { plan: 'yearly', trial: true });
  assert.equal(isTrialPriceId(ENV.MOR_PRICE_MONTHLY_TRIAL, ENV), true);
  assert.equal(isTrialPriceId(ENV.MOR_PRICE_MONTHLY, ENV), false);
  assert.equal(isTrialPriceId('pri_TESTFIXTURE_unknown', ENV), false);
});

test('reservationIdFrom reads ONLY rid, and only a uuid', () => {
  assert.equal(reservationIdFrom({ rid: RID, v: 3, user_id: 'attacker' }), RID);
  assert.equal(reservationIdFrom({ rid: 'not-a-uuid' }), null);
  assert.equal(reservationIdFrom({ user_id: USER }), null);
  assert.equal(reservationIdFrom(null), null);
});

test('money helpers never use floats for minor units', () => {
  assert.equal(moneyFromMinor('1190', 'USD'), '11.90');
  assert.equal(moneyFromMinor('5', 'USD'), '0.05');
  assert.equal(moneyFromMinor('1000', 'JPY'), '1000');
  assert.equal(moneyFromMinor('12345', 'KWD'), '12.345');
  assert.equal(moneyFromMinor('abc', 'USD'), null);
  assert.equal(sandboxMode({ MOR_SANDBOX: 'true' }), true);
  assert.equal(sandboxMode({ MOR_SANDBOX: 'false' }), false);
  assert.equal(sandboxMode({}), false);
});

/* ========================================== primary adapter: webhooks ====== */

test('primary verifyWebhook: a valid signature over the exact raw body passes', async () => {
  const raw = JSON.stringify(primaryNotification('subscription.created', subscriptionEntity()));
  const sig = await signPrimary(raw);
  const result = await primary.verifyWebhook(raw, new Headers({ 'Paddle-Signature': sig }), SECRET, { now: T0 });
  assert.deepEqual(result, { ok: true });
});

test('primary verifyWebhook: one tampered byte fails; re-serialised JSON fails', async () => {
  const raw = JSON.stringify(primaryNotification('subscription.created', subscriptionEntity()));
  const sig = await signPrimary(raw);
  const tampered = raw.replace('"trialing"', '"active"  ');
  assert.equal((await primary.verifyWebhook(tampered, { 'paddle-signature': sig }, SECRET, { now: T0 })).reason, 'bad_signature');
  const reserialised = JSON.stringify(JSON.parse(raw), null, 2);
  assert.equal((await primary.verifyWebhook(reserialised, { 'paddle-signature': sig }, SECRET, { now: T0 })).reason, 'bad_signature');
});

test('primary verifyWebhook: 300 s tolerance, not 5 s', async () => {
  const raw = '{"a":1}';
  const ts = Math.floor(T0 / 1000);
  const sig = await signPrimary(raw, ts);
  assert.equal((await primary.verifyWebhook(raw, { 'paddle-signature': sig }, SECRET, { now: T0 + 120 * 1000 })).ok, true);
  assert.equal((await primary.verifyWebhook(raw, { 'paddle-signature': sig }, SECRET, { now: T0 + 299 * 1000 })).ok, true);
  assert.equal((await primary.verifyWebhook(raw, { 'paddle-signature': sig }, SECRET, { now: T0 + 301 * 1000 })).reason, 'stale_timestamp');
  assert.equal((await primary.verifyWebhook(raw, { 'paddle-signature': sig }, SECRET, { now: T0 - 301 * 1000 })).reason, 'stale_timestamp');
});

test('primary verifyWebhook: malformed or truncated h1 returns false instead of throwing', async () => {
  const raw = '{"a":1}';
  const ts = Math.floor(T0 / 1000);
  assert.equal((await primary.verifyWebhook(raw, { 'paddle-signature': `ts=${ts};h1=abc` }, SECRET, { now: T0 })).reason, 'bad_signature');
  assert.equal((await primary.verifyWebhook(raw, { 'paddle-signature': `ts=${ts}` }, SECRET, { now: T0 })).reason, 'missing_signature');
  assert.equal((await primary.verifyWebhook(raw, {}, SECRET, { now: T0 })).reason, 'missing_signature');
  assert.equal((await primary.verifyWebhook(raw, { 'paddle-signature': `ts=nope;h1=abc` }, SECRET, { now: T0 })).reason, 'stale_timestamp');
  assert.equal((await primary.verifyWebhook(raw, { 'paddle-signature': 'x' }, '', { now: T0 })).reason, 'no_secret');
  assert.equal((await primary.verifyWebhook(Buffer.from(raw), { 'paddle-signature': 'x' }, SECRET, { now: T0 })).reason, 'raw_body_required');
});

test('primary verifyWebhook: several h1 during secret rotation — any one matches', async () => {
  const raw = '{"a":1}';
  const ts = Math.floor(T0 / 1000);
  const oldSig = bytesToHex(await hmacSha256('TESTFIXTURE-old-secret', `${ts}:${raw}`));
  const newSig = bytesToHex(await hmacSha256(SECRET, `${ts}:${raw}`));
  const header = `ts=${ts};h1=${oldSig};h1=${newSig}`;
  assert.equal((await primary.verifyWebhook(raw, { 'paddle-signature': header }, SECRET, { now: T0 })).ok, true);
});

test('primary parseEvents: notification -> normalised event with the exact field names', () => {
  const body = primaryNotification('subscription.created', subscriptionEntity());
  const [event] = primary.parseEvents(JSON.stringify(body), { env: ENV });
  assert.equal(event.id, 'evt_01testfixture0000000000000');
  assert.equal(event.type, 'sub.created');
  assert.equal(event.providerEventType, 'subscription.created');
  assert.equal(event.occurredAt, iso());
  assert.equal(event.live, false, 'a sandbox API key means sandbox events');
  assert.equal(event.reservationId, RID);
  assert.equal(event.providerSubscriptionId, SUB);
  assert.equal(event.providerCustomerId, CTM);
  assert.equal(event.providerPriceId, ENV.MOR_PRICE_MONTHLY_TRIAL);
  assert.equal(event.status, 'trialing');
  assert.equal(event.plan, 'monthly');
  assert.equal(event.hadTrial, true);
  assert.equal(event.trialStartsAt, iso());
  assert.equal(event.trialEndsAt, iso(3 * DAY));
  assert.equal(event.nextBilledAt, iso(3 * DAY));
  assert.equal(event.amount, null, 'money comes from transactions only');
  assert.deepEqual(event.payload, body, 'the delivery is kept for the retry ledger');
});

test('primary parseEvents: transaction.completed carries totals, period and zero-total flag', () => {
  const [event] = primary.parseEvents(JSON.stringify(primaryNotification('transaction.completed', transactionEntity())), { env: ENV });
  assert.equal(event.type, 'txn.completed');
  assert.equal(event.amount, '11.90');
  assert.equal(event.currency, 'USD');
  assert.equal(event.taxInclusive, true);
  assert.equal(event.totalIsZero, false);
  assert.equal(event.currentPeriodStart, iso(3 * DAY));
  assert.equal(event.currentPeriodEnd, iso(33 * DAY));
  assert.equal(event.providerTransactionId, TXN);
  const [zero] = primary.parseEvents(
    JSON.stringify(primaryNotification('transaction.completed', transactionEntity({ details: { totals: { subtotal: '0', tax: '0', total: '0', currency_code: 'USD' } } }))),
    { env: ENV },
  );
  assert.equal(zero.totalIsZero, true);
  assert.equal(zero.amount, '0.00');
});

test('primary parseEvents: unknown types are `ignore`, scheduled changes and custom_data.user_id are surfaced', () => {
  const [ignored] = primary.parseEvents(JSON.stringify(primaryNotification('customer.updated', { id: CTM })), { env: ENV });
  assert.equal(ignored.type, 'ignore');
  const [updated] = primary.parseEvents(
    JSON.stringify(primaryNotification('subscription.updated', subscriptionEntity({ status: 'active', scheduled_change: { action: 'cancel', effective_at: iso(30 * DAY), resume_at: null }, custom_data: { rid: RID, user_id: USER2 } }))),
    { env: ENV },
  );
  assert.deepEqual(updated.scheduledChange, { action: 'cancel', effectiveAt: iso(30 * DAY), resumeAt: null });
  assert.equal(updated.customDataUserIdSeen, true);
  assert.equal(updated.reservationId, RID);
  assert.throws(() => primary.parseEvents('not json'), /not JSON/);
  assert.throws(() => primary.parseEvents(JSON.stringify({ event_type: 'x' })), /no event_id/);
});

/* ============================================ primary adapter: API calls ==== */

test('primary parseEvents: adjustments — a chargeback or its warning is txn.chargeback, an approved refund is txn.refunded, the rest ignore', () => {
  const adj = (action, status) => ({ id: 'adj_01testfixture0000000000000', action, status, subscription_id: SUB, transaction_id: TXN, customer_id: CTM, totals: { subtotal: '1000', tax: '190', total: '1190', fee: '0', retained_fee: '0', earnings: '0', currency_code: 'USD' } });
  const parse = (action, status, type = 'adjustment.created') => primary.parseEvents(JSON.stringify(primaryNotification(type, adj(action, status), { id: `evt_TESTFIXTURE_${action}` })), { env: ENV })[0];
  const cb = parse('chargeback', 'approved');
  assert.equal(cb.type, 'txn.chargeback');
  assert.equal(cb.providerSubscriptionId, SUB);
  assert.equal(cb.providerTransactionId, TXN);
  assert.equal(cb.amount, '11.90');
  assert.equal(parse('chargeback_warning', 'pending_approval', 'adjustment.updated').type, 'txn.chargeback');
  assert.equal(parse('refund', 'approved').type, 'txn.refunded');
  assert.equal(parse('refund', 'pending_approval').type, 'ignore');
  assert.equal(parse('chargeback', 'reversed').type, 'ignore');
  assert.equal(parse('chargeback_reverse', 'approved').type, 'ignore');
  assert.equal(parse('credit', 'approved').type, 'ignore');
});

test('primary ensureCustomer: 409 customer_already_exists yields the existing id', async () => {
  const fetchImpl = fetchStub({
    'POST /customers': () => new Response(JSON.stringify({ error: { type: 'request_error', code: 'customer_already_exists', detail: `customer email conflicts with customer of id ${CTM}` } }), { status: 409 }),
  });
  const out = await primary.ensureCustomer('person@example.com', ctxWith(fetchImpl));
  assert.deepEqual(out, { id: CTM, existed: true });
  assert.equal(fetchImpl.calls[0].body.email, 'person@example.com');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, `Bearer ${ENV.MOR_API_KEY}`);
  assert.ok(fetchImpl.calls[0].url.origin === 'https://mor.testfixture.invalid');
});

test('primary ensureCustomer: a fresh email is created', async () => {
  const fetchImpl = fetchStub({ 'POST /customers': { data: { id: CTM, email: 'person@example.com' } } });
  assert.deepEqual(await primary.ensureCustomer('person@example.com', ctxWith(fetchImpl)), { id: CTM, existed: false });
  await assert.rejects(primary.ensureCustomer('', ctxWith(fetchImpl)), /email is required/);
});

test('primary createCheckoutSession: POST /transactions with items[], customer_id, custom_data, collection_mode', async () => {
  const fetchImpl = fetchStub({ 'POST /transactions': { data: { id: TXN, status: 'ready', checkout: { url: 'https://checkout.testfixture.invalid/?_ptxn=' + TXN } } } });
  const out = await primary.createCheckoutSession({ priceId: ENV.MOR_PRICE_MONTHLY_TRIAL, customerId: CTM, customData: { rid: RID, v: 3 } }, ctxWith(fetchImpl));
  assert.deepEqual(out, { transactionId: TXN, status: 'ready', checkoutUrl: 'https://checkout.testfixture.invalid/?_ptxn=' + TXN });
  assert.deepEqual(fetchImpl.calls[0].body, {
    items: [{ price_id: ENV.MOR_PRICE_MONTHLY_TRIAL, quantity: 1 }],
    collection_mode: 'automatic',
    customer_id: CTM,
    custom_data: { rid: RID, v: 3 },
  });
});

test('primary pricePreview: POST /pricing-preview returns the tax-aware total and formatted string', async () => {
  const fetchImpl = fetchStub({
    'POST /pricing-preview': {
      data: { currency_code: 'EUR', details: { line_items: [{ price: { id: ENV.MOR_PRICE_MONTHLY, tax_mode: 'account_setting' }, totals: { subtotal: '850', discount: '0', tax: '162', total: '1012' }, formatted_totals: { total: '€10.12' } }] } },
    },
  });
  const out = await primary.pricePreview({ priceId: ENV.MOR_PRICE_MONTHLY, countryCode: 'de' }, ctxWith(fetchImpl));
  assert.deepEqual(out, { amount: '10.12', currency: 'EUR', taxInclusive: true, formatted: '€10.12', taxMode: 'account_setting' });
  assert.deepEqual(fetchImpl.calls[0].body, { items: [{ price_id: ENV.MOR_PRICE_MONTHLY, quantity: 1 }], address: { country_code: 'DE' } });
});

test('primary management calls: cancel/pause need an explicit effective_from; PATCH carries proration_billing_mode; portal links are read', async () => {
  const fetchImpl = fetchStub({
    [`POST /subscriptions/${SUB}/cancel`]: { data: subscriptionEntity({ status: 'active', scheduled_change: { action: 'cancel', effective_at: iso(30 * DAY), resume_at: null } }) },
    [`POST /subscriptions/${SUB}/pause`]: { data: subscriptionEntity({ status: 'active', scheduled_change: { action: 'pause', effective_at: iso(30 * DAY), resume_at: iso(60 * DAY) } }) },
    [`PATCH /subscriptions/${SUB}`]: { data: subscriptionEntity({ status: 'active', items: [{ status: 'active', price: { id: ENV.MOR_PRICE_YEARLY } }] }) },
    [`GET /subscriptions/${SUB}`]: { data: subscriptionEntity({ status: 'paused', paused_at: iso() }) },
    [`POST /customers/${CTM}/portal-sessions`]: { data: { urls: { general: { overview: 'https://portal.testfixture.invalid/o' }, subscriptions: [{ id: SUB, cancel_subscription: 'https://portal.testfixture.invalid/c', update_subscription_payment_method: 'https://portal.testfixture.invalid/p' }] } } },
  });
  const ctx = ctxWith(fetchImpl);

  await assert.rejects(primary.cancelSubscription(SUB, {}, ctx), /effectiveFrom must be passed explicitly/);
  await assert.rejects(primary.pauseSubscription(SUB, { resumeAt: iso(60 * DAY) }, ctx), /effectiveFrom must be passed explicitly/);

  const canceled = await primary.cancelSubscription(SUB, { effectiveFrom: 'next_billing_period' }, ctx);
  assert.deepEqual(fetchImpl.calls.at(-1).body, { effective_from: 'next_billing_period' });
  assert.equal(canceled.scheduledChange.action, 'cancel');
  await primary.cancelSubscription(SUB, { effectiveFrom: 'immediately' }, ctx);
  assert.deepEqual(fetchImpl.calls.at(-1).body, { effective_from: 'immediately' });

  const paused = await primary.pauseSubscription(SUB, { effectiveFrom: 'next_billing_period', resumeAt: iso(60 * DAY) }, ctx);
  assert.deepEqual(fetchImpl.calls.at(-1).body, { effective_from: 'next_billing_period', resume_at: iso(60 * DAY), on_resume: 'start_new_billing_period' });
  assert.equal(paused.scheduledChange.resumeAt, iso(60 * DAY));

  const switched = await primary.changePlan(SUB, ENV.MOR_PRICE_YEARLY, { prorate: true }, ctx);
  assert.deepEqual(fetchImpl.calls.at(-1).body, { items: [{ price_id: ENV.MOR_PRICE_YEARLY, quantity: 1 }], proration_billing_mode: 'prorated_immediately' });
  assert.equal(switched.providerPriceId, ENV.MOR_PRICE_YEARLY);
  assert.equal(switched.plan, 'yearly');

  const state = await primary.getSubscription(SUB, ctx);
  assert.equal(state.status, 'paused');
  assert.equal(state.pausedAt, iso());

  const portal = await primary.createPortalSession(CTM, [SUB], ctx);
  assert.deepEqual(portal, { overview: 'https://portal.testfixture.invalid/o', cancel: 'https://portal.testfixture.invalid/c', update_payment_method: 'https://portal.testfixture.invalid/p', expires_in: 900 });
  assert.deepEqual(fetchImpl.calls.at(-1).body, { subscription_ids: [SUB] });
});

test('primary: a network failure or a 5xx is a ProviderError, never a thrown fetch', async () => {
  const down = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(primary.getSubscription(SUB, ctxWith(down)), (e) => e.name === 'ProviderError' && e.reason === 'provider_unavailable');
  await assert.rejects(primary.getSubscription(SUB, ctxWith(fetchStub({}))), (e) => e.name === 'ProviderError' && e.reason === 'not_found' && e.status === 404);
  const serverError = fetchStub({ [`GET /subscriptions/${SUB}`]: () => new Response('{}', { status: 502 }) });
  await assert.rejects(primary.getSubscription(SUB, ctxWith(serverError)), (e) => e.name === 'ProviderError' && e.reason === 'provider_error' && e.status === 502);
});

/* =========================================== fallback adapter (hedge) ====== */

test('fallback verifyWebhook: base64 HMAC in X-FS-Signature, exact raw body', async () => {
  const raw = JSON.stringify({ events: [{ id: 'TESTFIXTUREevent1', type: 'subscription.activated', live: false, created: T0, data: {} }] });
  const sig = await signFallback(raw);
  assert.deepEqual(await fallback.verifyWebhook(raw, new Headers({ 'X-FS-Signature': sig }), SECRET), { ok: true });
  assert.equal((await fallback.verifyWebhook(raw + ' ', { 'x-fs-signature': sig }, SECRET)).reason, 'bad_signature');
  assert.equal((await fallback.verifyWebhook(raw, { 'x-fs-signature': 'short' }, SECRET)).reason, 'bad_signature');
  assert.equal((await fallback.verifyWebhook(raw, {}, SECRET)).reason, 'missing_signature');
});

test('fallback parseEvents: batches are iterated, de-duplicated, and mapped (scheduled cancel does not revoke)', () => {
  const activated = { id: 'TESTFIXTUREev1', type: 'subscription.activated', live: false, created: T0, data: { id: 'TESTFIXTUREsub1', active: true, state: 'trial', live: false, currency: 'USD', account: { id: 'TESTFIXTUREacct', contact: { email: 'Person@Example.com' } }, product: ENV.MOR_PRICE_MONTHLY_TRIAL, begin: T0, next: T0 + 3 * DAY, autoRenew: true } };
  const canceled = { id: 'TESTFIXTUREev2', type: 'subscription.canceled', live: false, created: T0 + DAY, data: { id: 'TESTFIXTUREsub1', active: true, state: 'canceled', canceledDate: T0 + DAY, deactivationDate: T0 + 3 * DAY, product: ENV.MOR_PRICE_MONTHLY_TRIAL, account: 'TESTFIXTUREacct' } };
  const deactivated = { id: 'TESTFIXTUREev3', type: 'subscription.deactivated', live: false, created: T0 + 3 * DAY, data: { id: 'TESTFIXTUREsub1', active: false, state: 'deactivated', deactivationDate: T0 + 3 * DAY, product: ENV.MOR_PRICE_MONTHLY_TRIAL } };
  const charge = { id: 'TESTFIXTUREev4', type: 'subscription.charge.completed', live: false, created: T0 + 33 * DAY, data: { order: { id: 'TESTFIXTUREorder', total: 11.9, tax: 1.9, currency: 'USD', live: false }, subscription: { id: 'TESTFIXTUREsub1', state: 'active', product: ENV.MOR_PRICE_MONTHLY_TRIAL, begin: T0 + 3 * DAY, next: T0 + 33 * DAY }, account: { id: 'TESTFIXTUREacct' } } };
  const raw = JSON.stringify({ events: [activated, canceled, deactivated, charge, activated] });
  const events = fallback.parseEvents(raw, { env: ENV });
  assert.equal(events.length, 4, 'duplicate ids are dropped');

  assert.equal(events[0].type, 'sub.created');
  assert.equal(events[0].status, 'trialing');
  assert.equal(events[0].customerEmail, 'Person@Example.com');
  assert.equal(events[0].providerCustomerId, 'TESTFIXTUREacct');
  assert.equal(events[0].trialEndsAt, iso(3 * DAY));
  assert.equal(events[0].live, false);
  assert.deepEqual(events[0].payload, { events: [activated] }, 'one event per ledger row');

  assert.equal(events[1].type, 'sub.updated', 'subscription.canceled is a SCHEDULED cancel');
  assert.equal(events[1].status, 'active');
  assert.deepEqual(events[1].scheduledChange, { action: 'cancel', effectiveAt: iso(3 * DAY), resumeAt: null });

  assert.equal(events[2].type, 'sub.canceled', 'subscription.deactivated is the hard revoke');
  assert.equal(events[2].status, 'canceled');
  assert.equal(events[2].canceledAt, iso(3 * DAY));

  assert.equal(events[3].type, 'txn.completed');
  assert.equal(events[3].amount, '11.90');
  assert.equal(events[3].taxInclusive, true);
  assert.equal(events[3].totalIsZero, false);
  assert.equal(events[3].providerSubscriptionId, 'TESTFIXTUREsub1');
  assert.throws(() => fallback.parseEvents('{"nope":1}'), /no events/);
});

test('fallback management calls hit the documented paths with explicit effective_from', async () => {
  const fetchImpl = fetchStub({
    'GET /accounts': { accounts: [] },
    'POST /accounts': { account: 'TESTFIXTUREacct', result: 'success' },
    'POST /v2/checkouts/popup-testfixture/sessions': { id: 'TESTFIXTUREsession', expires: iso(HOUR), checkoutStatus: 'READY_FOR_CHECKOUT', checkoutUrls: { webcheckoutUrl: 'https://testfixture.onfastspring.com/session/TESTFIXTUREsession' } },
    'DELETE /subscriptions/TESTFIXTUREsub1': { subscriptions: [{ subscription: 'TESTFIXTUREsub1', action: 'subscription.cancel', result: 'success' }] },
    'GET /subscriptions/TESTFIXTUREsub1': { id: 'TESTFIXTUREsub1', active: true, state: 'active', live: false, currency: 'USD', product: ENV.MOR_PRICE_MONTHLY, begin: T0, next: T0 + 30 * DAY, account: 'TESTFIXTUREacct' },
    'POST /subscriptions/TESTFIXTUREsub1/pause': { id: 'TESTFIXTUREsub1', active: true, state: 'active', product: ENV.MOR_PRICE_MONTHLY, isPauseScheduled: true, pauseDate: T0 + 30 * DAY, resumeDate: T0 + 60 * DAY },
    'POST /subscriptions': { subscriptions: [{ subscription: 'TESTFIXTUREsub1', action: 'subscription.update', result: 'success' }] },
    'GET /accounts/TESTFIXTUREacct/authenticate': { accounts: [{ account: 'TESTFIXTUREacct', url: 'https://testfixture.onfastspring.com/account/x', result: 'success', action: 'account.authenticate.get' }] },
  });
  const ctx = ctxWith(fetchImpl);

  assert.deepEqual(await fallback.ensureCustomer('person@example.com', ctx), { id: 'TESTFIXTUREacct', existed: false });
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, `Basic ${base64Encode(ENV.MOR_API_KEY)}`);

  const session = await fallback.createCheckoutSession({ priceId: ENV.MOR_PRICE_MONTHLY, customerId: 'TESTFIXTUREacct', customData: { rid: RID, v: 3 } }, ctx);
  assert.equal(session.transactionId, 'TESTFIXTUREsession');
  assert.deepEqual(fetchImpl.calls.at(-1).body, { cart: { lineItems: [{ productPath: ENV.MOR_PRICE_MONTHLY, quantity: 1 }] }, live: false, customer: { accountId: 'TESTFIXTUREacct' }, orderTags: { rid: RID, v: 3 } });

  await assert.rejects(fallback.cancelSubscription('TESTFIXTUREsub1', {}, ctx), /effectiveFrom must be passed explicitly/);
  const scheduled = await fallback.cancelSubscription('TESTFIXTUREsub1', { effectiveFrom: 'next_billing_period' }, ctx);
  assert.equal(fetchImpl.calls.find((c) => c.key.startsWith('DELETE')).url.searchParams.get('billingPeriod'), '1');
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.scheduledChange.action, 'cancel');
  await fallback.cancelSubscription('TESTFIXTUREsub1', { effectiveFrom: 'immediately' }, ctx);
  assert.equal(fetchImpl.calls.filter((c) => c.key.startsWith('DELETE')).at(-1).url.searchParams.get('billingPeriod'), '0');

  const paused = await fallback.pauseSubscription('TESTFIXTUREsub1', { effectiveFrom: 'next_billing_period', resumeAt: iso(60 * DAY), periods: 1 }, { ...ctx, now: T0 });
  assert.deepEqual(fetchImpl.calls.at(-1).body, { pausePeriodCount: 1 });
  assert.equal(paused.scheduledChange.action, 'pause');
  await assert.rejects(fallback.pauseSubscription('TESTFIXTUREsub1', { effectiveFrom: 'immediately', resumeAt: iso(60 * DAY) }, ctx), /next billing period/);

  await fallback.changePlan('TESTFIXTUREsub1', ENV.MOR_PRICE_YEARLY, { prorate: true }, ctx);
  assert.deepEqual(fetchImpl.calls.find((c) => c.key === 'POST /subscriptions').body, { subscriptions: [{ subscription: 'TESTFIXTUREsub1', product: ENV.MOR_PRICE_YEARLY, quantity: 1, prorate: true }] });

  const portal = await fallback.createPortalSession('TESTFIXTUREacct', [], ctx);
  assert.equal(portal.overview, 'https://testfixture.onfastspring.com/account/x');
  assert.equal(portal.cancel, portal.overview);
});

/* ================================================== webhook handler ======== */

function handlerWith({ store = memoryStore(), provider = providerStub(), env = ENV, alerts = [] } = {}) {
  const alert = (kind, detail) => alerts.push({ kind, detail });
  const handler = createWebhookHandler({ store, provider, providerCtx: ctxWith(fetchStub({}), env), env, secret: SECRET, alert, now: () => T0 + 60 * 1000 });
  return { handler, store, provider, alerts };
}

test('handler: a tampered body is 401 and nothing is written (test 19)', async () => {
  const { handler, store } = handlerWith();
  const raw = JSON.stringify(primaryNotification('subscription.created', subscriptionEntity()));
  const sig = await signPrimary(raw);
  const response = await handler.POST(webhookRequest(raw.replace('trialing', 'active  '), { 'paddle-signature': sig }));
  assert.equal(response.status, 401);
  assert.equal(store.events.size, 0);
  assert.equal(store.subs.length, 0);
});

test('handler: the live-flag gate records `ignored` and writes no entitlement (test 20)', async () => {
  // Sandbox credentials (live:false events) on a deployment that says MOR_SANDBOX=false.
  const env = { ...ENV, MOR_SANDBOX: 'false' };
  const store = memoryStore({ intents: [seededIntent()] });
  const { handler } = handlerWith({ store, env });
  const response = await postPrimary(handler, primaryNotification('subscription.created', subscriptionEntity()));
  assert.equal(response.status, 200);
  const row = [...store.events.values()][0];
  assert.equal(row.status, 'ignored');
  assert.equal(row.error, 'live_flag_mismatch');
  assert.equal(store.subs.length, 0);
});

test('handler: trial start — insert from the reservation row, never from custom_data (test 7)', async () => {
  const store = memoryStore({
    intents: [seededIntent()],
    claims: [{ email_hash: EMAIL_HASH, outcome: 'reserved', provider: null, provider_subscription_id: null }],
    devices: [{ device_id: DEVICE, trial_count: 0, trial_consumed_at: null }],
  });
  const { handler } = handlerWith({ store });
  const entity = subscriptionEntity({ custom_data: { rid: RID, v: 3, user_id: USER2 } }); // the attacker-editable field is ignored
  const response = await postPrimary(handler, primaryNotification('subscription.created', entity));
  assert.equal(response.status, 200);

  assert.equal(store.subs.length, 1);
  const row = store.subs[0];
  assert.equal(row.user_id, USER, 'owner comes from checkout_intents, not custom_data.user_id');
  assert.equal(row.status, 'trialing');
  assert.equal(row.had_trial, true);
  assert.equal(row.plan, 'monthly');
  assert.equal(row.provider_customer_id, CTM);
  assert.equal(row.provider_price_id, ENV.MOR_PRICE_MONTHLY_TRIAL);
  assert.equal(row.trial_ends_at, iso(3 * DAY));
  assert.equal(row.access_until, iso(3 * DAY), '§6.5: trialing -> access_until = trial_ends_at');
  assert.equal(row.last_event_at, iso());
  assert.equal(row.ever_paid, false);

  assert.equal(store.intents[0].consumed_at, iso(60 * 1000));
  assert.equal(store.claims[0].outcome, 'started');
  assert.equal(store.claims[0].provider_subscription_id, SUB);
  assert.equal(store.claims[0].user_id, USER);
  assert.equal(store.devices[0].trial_consumed_at, iso(60 * 1000));
  assert.equal(store.devices[0].trial_count, 1);
  assert.equal(store.devices[0].trial_user_id, USER);

  const ev = [...store.events.values()][0];
  assert.equal(ev.status, 'processed');
  assert.equal(ev.attempts, 1);
});

test('handler: the devtools attack — trial price with no reservation is cancelled immediately and alerted (test 5)', async () => {
  const store = memoryStore({ profiles: [{ id: USER2, email: 'attacker@example.com' }] });
  const { handler, provider, alerts } = handlerWith({ store });
  const entity = subscriptionEntity({ custom_data: {} });
  const response = await postPrimary(handler, primaryNotification('subscription.created', entity));
  assert.equal(response.status, 200);
  assert.deepEqual(provider.calls, [['cancelSubscription', SUB, 'immediately']]);
  assert.equal(store.subs.length, 1);
  assert.equal(store.subs[0].status, 'canceled');
  assert.equal(store.subs[0].had_trial, true);
  assert.ok(Date.parse(store.subs[0].access_until) <= T0 + 60 * 1000, 'no pro entitlement is ever issued');
  const ev = [...store.events.values()][0];
  assert.equal(ev.status, 'processed');
  assert.equal(ev.error, 'trial_price_without_reservation');
  assert.equal(alerts[0].kind, 'trial_price_without_reservation');
});

/** A provider stub whose parseEvents surfaces a customer email (the subscription entity carries none; a sibling transaction would). */
function emailSurfacingProvider(email, base = providerStub()) {
  return { ...base, calls: base.calls, parseEvents: (raw, ctx) => primary.parseEvents(raw, ctx).map((e) => ({ ...e, customerEmail: email })) };
}

test('handler: a trial price WITH a fresh reservation for the user passes even when custom_data is stripped (ladder step 3)', async () => {
  const store = memoryStore({ intents: [seededIntent({ created_at: iso(-10 * 60 * 1000) })], profiles: [{ id: USER, email: 'person@example.com' }] });
  const provider = emailSurfacingProvider('Person@Example.com');
  const { handler } = handlerWith({ store, provider });
  await postPrimary(handler, primaryNotification('subscription.created', subscriptionEntity({ custom_data: null })));
  assert.equal(provider.calls.length, 0, 'not cancelled');
  const row = store.subs.find((r) => r.provider_subscription_id === SUB);
  assert.equal(row.user_id, USER, 'resolved via the profile email (ladder step 3)');
  assert.equal(row.status, 'trialing');
});

test('handler: layer 2 backstop — a user with any prior subscription row never gets a trial, even when a stripped rid resolves by customer id', async () => {
  const store = memoryStore({ intents: [seededIntent()], subscriptions: [{ provider: PRIMARY, provider_subscription_id: 'sub_01testfixtureprevious00000', provider_customer_id: CTM, user_id: USER, status: 'expired', plan: 'monthly', last_event_at: iso(-90 * DAY) }] });
  const { handler, provider, alerts } = handlerWith({ store });
  await postPrimary(handler, primaryNotification('subscription.created', subscriptionEntity({ custom_data: null })));
  assert.deepEqual(provider.calls, [['cancelSubscription', SUB, 'immediately']]);
  const row = store.subs.find((r) => r.provider_subscription_id === SUB);
  assert.equal(row.user_id, USER, 'still attributed via ladder step 2 so the owner can see who did it');
  assert.equal(row.status, 'canceled');
  assert.equal(alerts[0].kind, 'trial_price_without_reservation');
});

test('handler: replaying a reservation id after the trial it bought is cancelled (a rid is not a second trial)', async () => {
  // The user completed one trial with RID (row exists, intent consumed), then
  // called Checkout.open({ items:[trial price], customData:{ rid: RID } }) from devtools.
  const store = memoryStore({
    intents: [seededIntent({ consumed_at: iso(-2 * DAY) })],
    subscriptions: [trialingRow({ last_event_at: iso(-2 * DAY), trial_ends_at: iso(DAY), access_until: iso(DAY) })],
  });
  const { handler, provider } = handlerWith({ store });
  const second = subscriptionEntity({ id: 'sub_01testfixturesecondtrial00' });
  await postPrimary(handler, primaryNotification('subscription.created', second, { id: 'evt_TESTFIXTURE_replay' }));
  assert.deepEqual(provider.calls, [['cancelSubscription', 'sub_01testfixturesecondtrial00', 'immediately']]);
  assert.equal(store.subs.find((r) => r.provider_subscription_id === 'sub_01testfixturesecondtrial00').status, 'canceled');
  assert.equal(store.subs.find((r) => r.provider_subscription_id === SUB).status, 'trialing', 'the first trial is untouched');
});

test('handler: a pre-minted second reservation does not buy a second trial while the first is live', async () => {
  const RID2 = '3f2b9c40-0000-4000-8000-00000000000b';
  const store = memoryStore({
    intents: [seededIntent({ consumed_at: iso(-DAY) }), seededIntent({ reservation_id: RID2, consumed_at: null })],
    subscriptions: [trialingRow({ last_event_at: iso(-DAY) })],
  });
  const { handler, provider } = handlerWith({ store });
  const second = subscriptionEntity({ id: 'sub_01testfixturesecondtrial00', custom_data: { rid: RID2, v: 3 } });
  await postPrimary(handler, primaryNotification('subscription.created', second, { id: 'evt_TESTFIXTURE_preminted' }));
  assert.deepEqual(provider.calls, [['cancelSubscription', 'sub_01testfixturesecondtrial00', 'immediately']]);
});

test('handler: sub.trialing after a granted sub.created stays granted; a stale reservation (older than 7 days, or another price) does not bless a stripped-rid trial', async () => {
  // 1. Granted row, sibling sub.trialing arrives: no cancel.
  const granted = memoryStore({ subscriptions: [trialingRow({ last_event_at: iso(-1000) })] });
  const g = handlerWith({ store: granted });
  await postPrimary(g.handler, primaryNotification('subscription.trialing', subscriptionEntity({ custom_data: null }), { id: 'evt_TESTFIXTURE_trialing' }));
  assert.equal(g.provider.calls.length, 0);
  assert.equal(granted.subs[0].status, 'trialing');

  // 2. Fallback rung: the reservation must be for THIS price and recent.
  for (const intent of [seededIntent({ created_at: iso(-8 * DAY) }), seededIntent({ price_id: ENV.MOR_PRICE_YEARLY_TRIAL })]) {
    const store = memoryStore({ intents: [intent], profiles: [{ id: USER, email: 'person@example.com' }] });
    const provider = emailSurfacingProvider('person@example.com');
    const { handler } = handlerWith({ store, provider });
    await postPrimary(handler, primaryNotification('subscription.created', subscriptionEntity({ custom_data: null })));
    assert.deepEqual(provider.calls, [['cancelSubscription', SUB, 'immediately']]);
  }
});

test('handler: an out-of-order sub.updated that would insert a trialing row runs the trial-price check too', async () => {
  const store = memoryStore({ profiles: [{ id: USER2, email: 'attacker@example.com' }] });
  const provider = emailSurfacingProvider('attacker@example.com');
  const { handler } = handlerWith({ store, provider });
  await postPrimary(handler, primaryNotification('subscription.updated', subscriptionEntity({ custom_data: {} })));
  assert.deepEqual(provider.calls, [['cancelSubscription', SUB, 'immediately']]);
  assert.equal(store.subs[0].status, 'canceled');
});

test('handler: a chargeback adjustment before the subscription is known is noted, not inserted', async () => {
  const store = memoryStore();
  const { handler, provider } = handlerWith({ store });
  const adj = { id: 'adj_01testfixture0000000000000', action: 'chargeback', status: 'approved', subscription_id: SUB, transaction_id: TXN, customer_id: CTM, totals: { total: '1190', currency_code: 'USD' } };
  const response = await postPrimary(handler, primaryNotification('adjustment.created', adj, { id: 'evt_TESTFIXTURE_adj' }));
  assert.equal(response.status, 200);
  assert.equal(store.subs.length, 0);
  assert.equal(provider.calls.length, 0);
  assert.equal([...store.events.values()][0].status, 'processed');
});

test('handler: applyEvent throwing -> 500, row `failed` with payload KEPT, then a re-POST re-processes (test 17)', async () => {
  const store = memoryStore({ intents: [seededIntent()] });
  let boom = true;
  const flaky = {
    ...store,
    async insertSubscription(row) {
      if (boom) throw new Error('TESTFIXTURE supabase timeout');
      return store.insertSubscription(row);
    },
  };
  const { handler } = handlerWith({ store: flaky });
  const notification = primaryNotification('subscription.created', subscriptionEntity());
  const first = await postPrimary(handler, notification);
  assert.equal(first.status, 500, 'non-2xx so the provider retries');
  const ev = [...store.events.values()][0];
  assert.equal(ev.status, 'failed');
  assert.equal(ev.attempts, 1);
  assert.match(ev.error, /supabase timeout/);
  assert.deepEqual(ev.payload, notification, 'payload retained for replay');

  boom = false;
  const second = await postPrimary(handler, notification);
  assert.equal(second.status, 200);
  assert.equal(ev.status, 'processed');
  assert.equal(ev.attempts, 2);
  assert.equal(store.subs.length, 1);
});

test('handler: replaying a processed event is a no-op — one row, nothing written twice (test 18)', async () => {
  const store = memoryStore({ intents: [seededIntent()], devices: [{ device_id: DEVICE, trial_count: 0 }] });
  const { handler } = handlerWith({ store });
  const notification = primaryNotification('subscription.created', subscriptionEntity());
  await postPrimary(handler, notification);
  const before = store.calls.length;
  const again = await postPrimary(handler, notification);
  assert.equal(again.status, 200);
  assert.equal(store.events.size, 1);
  assert.equal(store.devices[0].trial_count, 1);
  assert.deepEqual(store.calls.slice(before), [['claimEvent', notification.event_id]]);
});

test('handler: unknown event types are recorded as ignored, one-off transactions are noted', async () => {
  const store = memoryStore();
  const { handler } = handlerWith({ store });
  await postPrimary(handler, primaryNotification('customer.updated', { id: CTM }, { id: 'evt_TESTFIXTURE_a' }));
  assert.equal(store.events.get(`${PRIMARY}:evt_TESTFIXTURE_a`).status, 'ignored');
  await postPrimary(handler, primaryNotification('transaction.completed', transactionEntity({ subscription_id: null }), { id: 'evt_TESTFIXTURE_b' }));
  assert.equal(store.events.get(`${PRIMARY}:evt_TESTFIXTURE_b`).status, 'ignored');
  assert.equal(store.subs.length, 0);
});

test('handler: an orphan is written visibly with user_id null, the event stays failed, and an alert fires', async () => {
  const store = memoryStore();
  const { handler, alerts } = handlerWith({ store });
  const response = await postPrimary(handler, primaryNotification('subscription.created', subscriptionEntity({ custom_data: null, items: [{ status: 'active', price: { id: ENV.MOR_PRICE_MONTHLY } }], status: 'active', current_billing_period: { starts_at: iso(), ends_at: iso(30 * DAY) } })));
  assert.equal(response.status, 500);
  assert.equal(store.subs.length, 1);
  assert.equal(store.subs[0].user_id, null);
  assert.equal([...store.events.values()][0].status, 'failed');
  assert.equal([...store.events.values()][0].error, 'orphan_subscription');
  assert.equal(alerts[0].kind, 'orphan_subscription');
});

/* ========================================================= applyEvent ====== */

function deps(store, provider = providerStub(), alerts = []) {
  return { store, provider, providerCtx: ctxWith(fetchStub({})), env: ENV, alert: (kind, detail) => alerts.push({ kind, detail }), now: () => T0 + 10 * DAY };
}

function parsed(eventType, data, opts) {
  return primary.parseEvents(JSON.stringify(primaryNotification(eventType, data, opts)), { env: ENV })[0];
}

const trialingRow = (overrides = {}) => ({
  id: 'row-seed',
  provider: PRIMARY,
  provider_subscription_id: SUB,
  provider_customer_id: CTM,
  provider_price_id: ENV.MOR_PRICE_MONTHLY_TRIAL,
  user_id: USER,
  plan: 'monthly',
  status: 'trialing',
  had_trial: true,
  ever_paid: false,
  trial_started_at: iso(),
  trial_ends_at: iso(3 * DAY),
  access_until: iso(3 * DAY),
  last_event_at: iso(),
  live: false,
  needs_reconcile: false,
  ...overrides,
});

test('applyEvent: trial conversion — activated + non-zero txn set active, ever_paid, display_*, converted (test 11)', async () => {
  const store = memoryStore({ subscriptions: [trialingRow()], claims: [{ email_hash: EMAIL_HASH, outcome: 'started', provider: PRIMARY, provider_subscription_id: SUB }] });
  const d = deps(store);
  const activated = parsed('subscription.activated', subscriptionEntity({ status: 'active', current_billing_period: { starts_at: iso(3 * DAY), ends_at: iso(33 * DAY) }, next_billed_at: iso(33 * DAY), items: [{ status: 'active', trial_dates: { starts_at: iso(), ends_at: iso(3 * DAY) }, price: { id: ENV.MOR_PRICE_MONTHLY_TRIAL } }] }), { id: 'evt_TESTFIXTURE_act', occurredAt: iso(3 * DAY + 1000) });
  assert.deepEqual(await applyEvent(activated, d), { action: 'updated' });
  const row = store.subs[0];
  assert.equal(row.status, 'active');
  assert.equal(row.ever_paid, true);
  assert.equal(row.current_period_end, iso(33 * DAY));
  assert.equal(row.access_until, iso(33 * DAY + 48 * HOUR), '§6.5: active -> period end + 48h');
  assert.equal(row.past_due_since, null);

  const txn = parsed('transaction.completed', transactionEntity(), { id: 'evt_TESTFIXTURE_txn', occurredAt: iso(3 * DAY + 2000) });
  assert.deepEqual(await applyEvent(txn, d), { action: 'updated' });
  assert.equal(row.display_amount, '11.90');
  assert.equal(row.display_currency, 'USD');
  assert.equal(row.display_tax_inclusive, true);
  assert.equal(store.claims[0].outcome, 'converted');
});

test('applyEvent: out-of-order events — the older occurred_at is refused and flagged for reconcile (test 16)', async () => {
  const store = memoryStore({ subscriptions: [trialingRow()] });
  const d = deps(store);
  const later = parsed('transaction.completed', transactionEntity(), { id: 'evt_TESTFIXTURE_1', occurredAt: iso(3 * DAY + 2000) });
  const earlier = parsed('subscription.activated', subscriptionEntity({ status: 'active', current_billing_period: { starts_at: iso(3 * DAY), ends_at: iso(33 * DAY) } }), { id: 'evt_TESTFIXTURE_2', occurredAt: iso(3 * DAY + 1000) });
  assert.equal((await applyEvent(later, d)).action, 'updated');
  assert.deepEqual(await applyEvent(earlier, d), { action: 'stale', reason: 'older_than_last_event' });
  assert.equal(store.subs[0].last_event_at, iso(3 * DAY + 2000));
  assert.equal(store.subs[0].needs_reconcile, true);
  assert.equal(store.subs[0].status, 'trialing', 'the stale write did not land');
});

test('applyEvent: a stale sub.updated after sub.canceled never resurrects (test 16b)', async () => {
  const store = memoryStore({ subscriptions: [{ ...trialingRow(), status: 'active', ever_paid: true, current_period_end: iso(33 * DAY), access_until: iso(35 * DAY), last_event_at: iso(3 * DAY) }] });
  const d = deps(store);
  const canceled = parsed('subscription.canceled', subscriptionEntity({ status: 'canceled', canceled_at: iso(20 * DAY), current_billing_period: { starts_at: iso(3 * DAY), ends_at: iso(33 * DAY) } }), { id: 'evt_TESTFIXTURE_c', occurredAt: iso(20 * DAY) });
  assert.deepEqual(await applyEvent(canceled, d), { action: 'canceled' });
  assert.equal(store.subs[0].status, 'canceled');
  assert.equal(store.subs[0].access_until, iso(20 * DAY), '§6.5: canceled -> coalesce(cancel_at, canceled_at)');

  const stale = parsed('subscription.updated', subscriptionEntity({ status: 'active', current_billing_period: { starts_at: iso(3 * DAY), ends_at: iso(33 * DAY) } }), { id: 'evt_TESTFIXTURE_s', occurredAt: iso(19 * DAY) });
  assert.deepEqual(await applyEvent(stale, d), { action: 'stale', reason: 'already_canceled' });
  assert.equal(store.subs[0].status, 'canceled');
  // Even a LATER update cannot resurrect a terminal state.
  const later = parsed('subscription.updated', subscriptionEntity({ status: 'active' }), { id: 'evt_TESTFIXTURE_l', occurredAt: iso(21 * DAY) });
  assert.equal((await applyEvent(later, d)).action, 'stale');
  assert.equal(store.subs[0].status, 'canceled');
  // A second sub.canceled is a no-op.
  assert.deepEqual(await applyEvent(canceled, d), { action: 'already_canceled' });
});

test('applyEvent: decline at conversion — past_due with ever_paid=false ends access at trial end, not 7 days later (test 12)', async () => {
  const store = memoryStore({ subscriptions: [trialingRow()] });
  const d = deps(store);
  const failed = parsed('transaction.payment_failed', transactionEntity({ status: 'past_due' }), { id: 'evt_TESTFIXTURE_pf', occurredAt: iso(3 * DAY + 500) });
  assert.deepEqual(await applyEvent(failed, d), { action: 'noted' });
  const pastDue = parsed('subscription.past_due', subscriptionEntity({ status: 'past_due' }), { id: 'evt_TESTFIXTURE_pd', occurredAt: iso(3 * DAY + 1000) });
  assert.equal((await applyEvent(pastDue, d)).action, 'updated');
  const row = store.subs[0];
  assert.equal(row.status, 'past_due');
  assert.equal(row.ever_paid, false);
  assert.equal(row.past_due_since, iso(10 * DAY), 'set from now() on first past_due');
  assert.equal(row.access_until, iso(3 * DAY), 'access ends on schedule');
});

test('applyEvent: a paying subscriber past due keeps 7 days; dunning recovery via activated clears it (test 12b)', async () => {
  const paid = { ...trialingRow(), status: 'active', ever_paid: true, current_period_end: iso(33 * DAY), access_until: iso(35 * DAY), last_event_at: iso(3 * DAY) };
  const store = memoryStore({ subscriptions: [paid] });
  const d = { ...deps(store), now: () => T0 + 33 * DAY };
  const pastDue = parsed('subscription.past_due', subscriptionEntity({ status: 'past_due', current_billing_period: { starts_at: iso(3 * DAY), ends_at: iso(33 * DAY) } }), { id: 'evt_TESTFIXTURE_pd2', occurredAt: iso(33 * DAY + 1000) });
  await applyEvent(pastDue, d);
  assert.equal(store.subs[0].access_until, iso(40 * DAY), 'least(past_due_since+7d, period_end+7d)');
  const recovered = parsed('subscription.activated', subscriptionEntity({ status: 'active', current_billing_period: { starts_at: iso(33 * DAY), ends_at: iso(63 * DAY) } }), { id: 'evt_TESTFIXTURE_rec', occurredAt: iso(35 * DAY) });
  await applyEvent(recovered, d);
  assert.equal(store.subs[0].status, 'active');
  assert.equal(store.subs[0].past_due_since, null);
  assert.equal(store.subs[0].access_until, iso(63 * DAY + 48 * HOUR));
});

test('applyEvent: pause keeps the paid period; resume, scheduled cancel and its removal are tracked', async () => {
  const active = { ...trialingRow(), status: 'active', ever_paid: true, current_period_start: iso(3 * DAY), current_period_end: iso(33 * DAY), access_until: iso(35 * DAY), last_event_at: iso(3 * DAY) };
  const store = memoryStore({ subscriptions: [active] });
  const d = deps(store);
  const period = { starts_at: iso(3 * DAY), ends_at: iso(33 * DAY) };
  const paused = parsed('subscription.paused', subscriptionEntity({ status: 'paused', paused_at: iso(33 * DAY), current_billing_period: period }), { id: 'evt_TESTFIXTURE_p', occurredAt: iso(33 * DAY) });
  await applyEvent(paused, d);
  assert.equal(store.subs[0].status, 'paused');
  assert.equal(store.subs[0].paused_at, iso(33 * DAY));
  assert.equal(store.subs[0].access_until, iso(35 * DAY), 'paused keeps the access the paid period set (frozen; Stripe rolls current_period_end on during a pause)');

  const resumed = parsed('subscription.resumed', subscriptionEntity({ status: 'active', current_billing_period: { starts_at: iso(60 * DAY), ends_at: iso(90 * DAY) } }), { id: 'evt_TESTFIXTURE_r', occurredAt: iso(60 * DAY) });
  await applyEvent(resumed, d);
  assert.equal(store.subs[0].status, 'active');
  assert.equal(store.subs[0].paused_at, null);
  assert.equal(store.subs[0].access_until, iso(90 * DAY + 48 * HOUR));

  const scheduled = parsed('subscription.updated', subscriptionEntity({ status: 'active', current_billing_period: { starts_at: iso(60 * DAY), ends_at: iso(90 * DAY) }, scheduled_change: { action: 'cancel', effective_at: iso(90 * DAY), resume_at: null } }), { id: 'evt_TESTFIXTURE_sc', occurredAt: iso(61 * DAY) });
  await applyEvent(scheduled, d);
  assert.equal(store.subs[0].cancel_at, iso(90 * DAY));
  assert.equal(store.subs[0].status, 'active', 'a scheduled cancel does not revoke');
  assert.equal(store.subs[0].access_until, iso(90 * DAY + 48 * HOUR));

  const unscheduled = parsed('subscription.updated', subscriptionEntity({ status: 'active', current_billing_period: { starts_at: iso(60 * DAY), ends_at: iso(90 * DAY) }, scheduled_change: null }), { id: 'evt_TESTFIXTURE_us', occurredAt: iso(62 * DAY) });
  await applyEvent(unscheduled, d);
  assert.equal(store.subs[0].cancel_at, null, 'a cleared scheduled change clears cancel_at');
});

test('applyEvent: cancel during the trial marks the claim cancelled; a $0 txn is only noted; a refund and a chargeback update the ledger', async () => {
  const store = memoryStore({ subscriptions: [trialingRow()], claims: [{ email_hash: EMAIL_HASH, outcome: 'started', provider: PRIMARY, provider_subscription_id: SUB }] });
  const alerts = [];
  const d = deps(store, providerStub(), alerts);
  const zero = parsed('transaction.completed', transactionEntity({ details: { totals: { total: '0', tax: '0', currency_code: 'USD' } } }), { id: 'evt_TESTFIXTURE_z', occurredAt: iso(1000) });
  assert.deepEqual(await applyEvent(zero, d), { action: 'noted', reason: 'zero_total' });
  assert.equal(store.subs[0].ever_paid, false);

  const canceled = parsed('subscription.canceled', subscriptionEntity({ status: 'canceled', canceled_at: iso(DAY) }), { id: 'evt_TESTFIXTURE_cx', occurredAt: iso(DAY) });
  assert.equal((await applyEvent(canceled, d)).action, 'canceled');
  assert.equal(store.claims[0].outcome, 'cancelled');
  assert.equal(store.subs[0].access_until, iso(DAY));

  const chargeback = normalizeEvent({ id: 'evt_TESTFIXTURE_cb', type: 'txn.chargeback', occurredAt: iso(5 * DAY), live: false, providerSubscriptionId: SUB });
  assert.equal((await applyEvent(chargeback, d)).action, 'updated');
  assert.equal(store.subs[0].dispute_open, true);
  assert.equal(store.claims[0].outcome, 'chargeback');
  assert.equal(alerts.at(-1).kind, 'chargeback');
});

test('applyEvent: a full refund ends the subscription and the access with it (refund policy); a partial refund is only noted', async () => {
  const store = memoryStore({ subscriptions: [{ ...trialingRow(), status: 'active', ever_paid: true, current_period_end: iso(30 * DAY), access_until: iso(30 * DAY + 48 * HOUR) }], claims: [{ email_hash: EMAIL_HASH, outcome: 'converted', provider: PRIMARY, provider_subscription_id: SUB }] });
  const provider = providerStub();
  const d = deps(store, provider, []);
  const partial = normalizeEvent({ id: 'evt_TESTFIXTURE_rp', type: 'txn.refunded', occurredAt: iso(2 * DAY), live: false, providerSubscriptionId: SUB, amount: '2.00', currency: 'USD', fullyRefunded: false });
  assert.deepEqual(await applyEvent(partial, d), { action: 'noted', reason: 'refund' });
  assert.equal(store.subs[0].status, 'active', 'a goodwill partial refund changes nothing');
  assert.deepEqual(provider.calls, []);

  const full = normalizeEvent({ id: 'evt_TESTFIXTURE_rf', type: 'txn.refunded', occurredAt: iso(3 * DAY), live: false, providerSubscriptionId: SUB, amount: '10.00', currency: 'USD', fullyRefunded: true });
  assert.deepEqual(await applyEvent(full, d), { action: 'updated', reason: 'refund' });
  assert.deepEqual(provider.calls, [['cancelSubscription', SUB, 'immediately']], 'ended at the provider so nothing is charged again');
  assert.equal(store.subs[0].status, 'canceled');
  assert.equal(store.subs[0].access_until, iso(10 * DAY), 'access ends at the time of the refund (the handler clock)');
  assert.equal(store.claims[0].outcome, 'refunded');
});

test('applyEvent: a no-trial subscription resolves by email (ladder step 3) and an unknown price id fails loudly', async () => {
  const store = memoryStore({ profiles: [{ id: USER2, email: 'person@example.com' }] });
  const d = deps(store);
  const event = normalizeEvent({ id: 'evt_TESTFIXTURE_em', type: 'sub.created', occurredAt: iso(), live: false, providerSubscriptionId: 'sub_01testfixtureemailresolve0', providerCustomerId: 'ctm_01testfixtureemail00000000', providerPriceId: ENV.MOR_PRICE_YEARLY, customerEmail: 'Person@Example.com', status: 'active', plan: 'yearly', currentPeriodStart: iso(), currentPeriodEnd: iso(365 * DAY) });
  assert.deepEqual(await applyEvent(event, d), { action: 'inserted', source: 'email' });
  assert.equal(store.subs[0].user_id, USER2);
  assert.equal(store.subs[0].plan, 'yearly');
  assert.equal(store.subs[0].access_until, iso(365 * DAY + 48 * HOUR));

  const unknown = normalizeEvent({ id: 'evt_TESTFIXTURE_up', type: 'sub.created', occurredAt: iso(), live: false, providerSubscriptionId: 'sub_01testfixtureunknownprice0', providerPriceId: 'pri_TESTFIXTURE_not_configured', customerEmail: 'person@example.com', status: 'active' });
  await assert.rejects(applyEvent(unknown, d), /unknown_plan/);
});

test('patchForEvent is pure and covers every §6.5 status', () => {
  const nowMs = T0;
  const base = { status: 'active', current_period_end: iso(30 * DAY), ever_paid: true };
  const mk = (type, extra) => normalizeEvent({ type, occurredAt: iso(), ...extra });
  assert.equal(patchForEvent(mk('sub.trialing', { trialEndsAt: iso(3 * DAY) }), null, { nowMs }).access_until, iso(3 * DAY));
  assert.equal(patchForEvent(mk('sub.activated', { currentPeriodEnd: iso(30 * DAY) }), null, { nowMs }).access_until, iso(30 * DAY + 48 * HOUR));
  assert.equal(patchForEvent(mk('sub.paused', {}), base, { nowMs }).access_until, iso(30 * DAY));
  assert.equal(patchForEvent(mk('sub.past_due', {}), base, { nowMs }).access_until, iso(7 * DAY));
  assert.equal(patchForEvent(mk('sub.past_due', {}), { status: 'trialing', trial_ends_at: iso(3 * DAY), ever_paid: false }, { nowMs }).access_until, iso(3 * DAY));
  assert.equal(patchForEvent(mk('sub.canceled', { canceledAt: iso(5 * DAY) }), base, { nowMs }).access_until, iso(5 * DAY));
  assert.equal(patchForEvent(mk('sub.canceled', { scheduledChange: { action: 'cancel', effectiveAt: iso(30 * DAY) } }), base, { nowMs }).access_until, iso(30 * DAY));
  const chargeback = patchForEvent(mk('txn.chargeback', {}), base, { nowMs });
  assert.equal(chargeback.dispute_open, true);
  assert.equal(chargeback.status, undefined, 'a transaction event never sets status on an existing row');
});

/* ========================================================= store paths ===== */

test('createWebhookStore builds the conditional ordered UPDATE, the terminal cancel and the claim CAS as PostgREST calls', async () => {
  const log = [];
  const responses = [];
  const db = async (path, options = {}) => {
    log.push({ path: decodeURIComponent(path), method: options.method || 'GET', body: options.body, prefer: options.prefer });
    return responses.shift() ?? [];
  };
  const store = createWebhookStore(db);

  await store.updateOrdered(PRIMARY, SUB, { status: 'active' }, iso());
  assert.equal(log.at(-1).method, 'PATCH');
  assert.match(log.at(-1).path, /provider=eq\./);
  assert.match(log.at(-1).path, new RegExp(`provider_subscription_id=eq\\.${SUB}`));
  assert.match(log.at(-1).path, /or=\(last_event_at\.is\.null,last_event_at\.lte\./, 'ordering enforced by the write; lte because Stripe stamps sibling events with the same second');
  assert.deepEqual(log.at(-1).body, { status: 'active', last_event_at: iso() });
  assert.equal(log.at(-1).prefer, 'return=representation', 'zero rows must be observable');

  await store.cancelTerminal(PRIMARY, SUB, { canceled_at: iso() });
  assert.match(log.at(-1).path, /status=neq\.canceled/);
  assert.equal(log.at(-1).body.status, 'canceled');

  // claim: no row -> insert
  responses.push([]);
  responses.push(null);
  assert.equal(await store.claimEvent(PRIMARY, { id: 'evt_TESTFIXTURE_1', type: 'sub.created', providerEventType: 'subscription.created', occurredAt: iso(), payload: { a: 1 } }), 'claimed');
  assert.equal(log.at(-1).method, 'POST');
  assert.deepEqual(log.at(-1).body.payload, { a: 1 });
  assert.equal(log.at(-1).body.status, 'received');
  assert.equal(log.at(-1).body.attempts, 1);

  // claim: processed row -> permanent no-op
  responses.push([{ status: 'processed', attempts: 1 }]);
  assert.equal(await store.claimEvent(PRIMARY, { id: 'evt_TESTFIXTURE_2' }), 'already_processed');

  // claim: failed row -> compare-and-set re-claim
  responses.push([{ status: 'failed', attempts: 3 }]);
  responses.push([{ status: 'received' }]);
  assert.equal(await store.claimEvent(PRIMARY, { id: 'evt_TESTFIXTURE_3' }), 'claimed');
  assert.match(log.at(-1).path, /status=in\.\(failed,received\)&attempts=eq\.3/);
  assert.deepEqual(log.at(-1).body, { status: 'received', attempts: 4, error: null });

  // claim: concurrent insert (23505) -> re-read
  responses.push([]);
  responses.push(Promise.reject(Object.assign(new Error('dup'), { code: '23505' })));
  responses.push([{ status: 'received', attempts: 1 }]);
  responses.push([]);
  const dbWithReject = async (path, options = {}) => {
    const next = responses.shift();
    log.push({ path, method: options.method || 'GET' });
    return next instanceof Promise ? next : next ?? [];
  };
  const store2 = createWebhookStore(dbWithReject);
  assert.equal(await store2.claimEvent(PRIMARY, { id: 'evt_TESTFIXTURE_4' }), 'already_processed', 'lost the CAS race to the sibling');

  await store.markFailed(PRIMARY, 'evt_TESTFIXTURE_5', new Error('x'.repeat(900)));
  assert.equal(log.at(-1).body.status, 'failed');
  assert.equal(log.at(-1).body.error.length, 500);
  assert.equal(log.at(-1).body.payload, undefined, 'payload never touched on failure');

  await store.startTrialClaim(EMAIL_HASH, { user_id: USER });
  assert.match(log.at(-1).path, /trial_claims\?email_hash=eq\.\\x00testfixture00&outcome=in\.\(reserved,expired\)/);
  await store.subscriptionsToReconcile(iso(), 50);
  assert.match(log.at(-2).path, /needs_reconcile=is\.true/);
  assert.match(log.at(-1).path, /status=in\.\(trialing,active,past_due,paused\)&access_until=lt\./, 'a lost dunning-recovery or resume webhook strands past_due and paused rows too');
  await store.orphanSubscriptions();
  assert.match(log.at(-1).path, /user_id=is\.null&detached_at=is\.null/);

  // the narrowed trial-reservation lookup and the layer-2 backstop
  responses.push([{ reservation_id: RID }]);
  assert.equal(await store.hasTrialIntent(USER, PRIMARY, { priceId: ENV.MOR_PRICE_MONTHLY_TRIAL, notBefore: iso(-7 * DAY) }), true);
  assert.equal(log.at(-1).path, `checkout_intents?user_id=eq.${USER}&provider=eq.${PRIMARY}&trial_granted=is.true&price_id=eq.${ENV.MOR_PRICE_MONTHLY_TRIAL}&created_at=gte.${iso(-7 * DAY)}&select=reservation_id&limit=1`);
  responses.push([{ provider: PRIMARY, provider_subscription_id: SUB }]);
  assert.equal(await store.hasOtherSubscription(USER, PRIMARY, SUB), false, 'its own row does not count');
  assert.equal(log.at(-1).path, `subscriptions?user_id=eq.${USER}&select=provider,provider_subscription_id&limit=20`);
  responses.push([{ provider: PRIMARY, provider_subscription_id: 'sub_01testfixtureprevious00000' }]);
  assert.equal(await store.hasOtherSubscription(USER, PRIMARY, SUB), true);
  assert.throws(() => createWebhookStore(null), /must be a function/);
});

/* =================================================== billing endpoints ===== */

function billingRequest(path, body) {
  return new Request(`https://helpmebreath.com/api/billing/${path}`, {
    method: 'POST',
    headers: { origin: 'https://helpmebreath.com', host: 'helpmebreath.com', authorization: 'Bearer TESTFIXTURE.jwt.value', 'content-type': 'application/json', ...(body === undefined ? {} : { 'content-length': String(JSON.stringify(body).length) }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function billingDeps(rows, provider = providerStub()) {
  const updates = [];
  return {
    updates,
    provider,
    deps: {
      auth: async () => ({ ok: true, sub: USER, email: 'person@example.com' }),
      store: { subscriptionsFor: async () => rows },
      updateSubscription: async (id, patch) => updates.push([id, patch]),
      provider,
      providerCtx: ctxWith(fetchStub({})),
      env: ENV,
      now: () => T0 + 10 * DAY,
    },
  };
}

const activeRow = () => ({ ...trialingRow(), status: 'active', ever_paid: true, current_period_start: iso(3 * DAY), current_period_end: iso(33 * DAY), next_billed_at: iso(33 * DAY), access_until: iso(35 * DAY), cancel_at: null });

test('billing/portal: mints links per request from the live row and never caches', async () => {
  const { deps: d, provider } = billingDeps([activeRow()]);
  const response = await createPortalHandler(d).POST(billingRequest('portal'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, max-age=0');
  const body = await response.json();
  assert.deepEqual(body, { ok: true, overview: 'https://portal.testfixture.invalid/overview', cancel: 'https://portal.testfixture.invalid/cancel', update_payment_method: 'https://portal.testfixture.invalid/pay', expires_in: 900 });
  assert.deepEqual(provider.calls, [['createPortalSession', CTM, [SUB]]]);

  const none = await createPortalHandler(billingDeps([]).deps).POST(billingRequest('portal'));
  assert.equal(none.status, 404);
  const crossSite = await createPortalHandler(d).POST(new Request('https://helpmebreath.com/api/billing/portal', { method: 'POST', headers: { origin: 'https://evil.example', host: 'helpmebreath.com' } }));
  assert.equal(crossSite.status, 403);
  const unauth = await createPortalHandler({ ...d, auth: async () => ({ ok: false, response: new Response('no', { status: 401 }) }) }).POST(billingRequest('portal'));
  assert.equal(unauth.status, 401);
  const limited = await createPortalHandler({ ...d, limiter: async () => false }).POST(billingRequest('portal'));
  assert.equal(limited.status, 429);
});

test('billing/cancel: effective_from is explicit in every branch of §5.9', async () => {
  assert.equal(effectiveFromFor('trialing', 'period_end'), 'next_billing_period');
  assert.equal(effectiveFromFor('active', 'period_end'), 'next_billing_period');
  assert.equal(effectiveFromFor('past_due', 'period_end'), 'next_billing_period');
  assert.equal(effectiveFromFor('paused', 'period_end'), 'immediately', 'nothing is charged while paused and the paid period has run out');
  for (const status of ['trialing', 'active', 'past_due', 'paused']) assert.equal(effectiveFromFor(status, 'now'), 'immediately');

  // trialing, default: keeps the remaining trial days (the provider schedules the change at the trial end)
  const trial = billingDeps([trialingRow()], providerStub({ cancel: async () => ({ ok: true, status: 'trialing', scheduledChange: { action: 'cancel', effectiveAt: iso(3 * DAY), resumeAt: null } }) }));
  let response = await createCancelHandler(trial.deps).POST(billingRequest('cancel'));
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.effective_from, 'next_billing_period');
  assert.equal(body.cancel_at, iso(3 * DAY), 'the trial end');
  assert.equal(body.status, 'trialing');
  assert.deepEqual(trial.provider.calls, [['cancelSubscription', SUB, 'next_billing_period']]);
  assert.deepEqual(trial.updates, [['row-seed', { cancel_at: iso(3 * DAY) }]]);

  // active, default: the provider's scheduled_change date is stored in cancel_at (test 14)
  const active = billingDeps([activeRow()]);
  response = await createCancelHandler(active.deps).POST(billingRequest('cancel', { when: 'period_end' }));
  body = await response.json();
  assert.equal(body.effective_from, 'next_billing_period');
  assert.equal(body.cancel_at, iso(30 * DAY), 'from the provider scheduledChange');
  assert.equal(body.access_until, iso(35 * DAY), 'access continues to period end');

  // explicit "now": immediately, access ends now
  const now = billingDeps([activeRow()]);
  response = await createCancelHandler(now.deps).POST(billingRequest('cancel', { when: 'now' }));
  body = await response.json();
  assert.equal(body.effective_from, 'immediately');
  assert.equal(body.status, 'canceled');
  assert.equal(body.access_until, iso(10 * DAY));
  assert.deepEqual(now.provider.calls, [['cancelSubscription', SUB, 'immediately']]);
  assert.equal(now.updates[0][1].status, 'canceled');

  // paused, default: explicit `immediately` at the provider (nothing is being collected),
  // and the days already paid for are kept: the frozen access_until becomes cancel_at.
  const paused = billingDeps([{ ...activeRow(), status: 'paused', paused_at: iso(5 * DAY), access_until: iso(35 * DAY) }]);
  response = await createCancelHandler(paused.deps).POST(billingRequest('cancel'));
  body = await response.json();
  assert.equal(body.effective_from, 'immediately');
  assert.equal(body.status, 'canceled');
  assert.deepEqual(paused.provider.calls, [['cancelSubscription', SUB, 'immediately']]);
  assert.match(body.message, /paused subscription has ended/);
  assert.match(body.message, /keep access until/);
  assert.equal(paused.updates[0][1].cancel_at, iso(35 * DAY), 'paid days kept');
  assert.equal(paused.updates[0][1].access_until, iso(35 * DAY));
  // a paused row whose paid period has already run out ends now
  const lapsed = billingDeps([{ ...activeRow(), status: 'paused', paused_at: iso(-40 * DAY), access_until: iso(-5 * DAY) }]);
  response = await createCancelHandler(lapsed.deps).POST(billingRequest('cancel'));
  body = await response.json();
  assert.equal(lapsed.updates[0][1].cancel_at, null);
  assert.doesNotMatch(body.message, /keep access/);

  // already scheduled: idempotent, no provider call
  const scheduled = billingDeps([{ ...activeRow(), cancel_at: iso(33 * DAY) }]);
  response = await createCancelHandler(scheduled.deps).POST(billingRequest('cancel'));
  body = await response.json();
  assert.equal(body.already_scheduled, true);
  assert.equal(scheduled.provider.calls.length, 0);

  // bad input, no subscription, provider down
  assert.equal((await createCancelHandler(active.deps).POST(billingRequest('cancel', { when: 'yesterday' }))).status, 400);
  assert.equal((await createCancelHandler(billingDeps([]).deps).POST(billingRequest('cancel'))).status, 404);
  const down = billingDeps([activeRow()], providerStub({ cancel: async () => { throw new Error('TESTFIXTURE down'); } }));
  assert.equal((await createCancelHandler(down.deps).POST(billingRequest('cancel'))).status, 502);
  assert.equal(down.updates.length, 0, 'nothing written locally when the provider refused');
});

test('billing/pause: 1 or 3 months, next_billing_period, access to the paid period end (test 15)', async () => {
  // Calendar months, an hour before the renewal that should be collected:
  // 2026-10-17T10:00Z + 1 month = 2026-11-17T10:00Z, less an hour.
  const R1 = '2026-11-17T09:00:00.000Z';
  assert.equal(resumeAtFor({ current_period_end: iso(33 * DAY) }, 1, T0), R1);
  assert.equal(resumeAtFor({}, 3, T0), '2026-12-14T09:00:00.000Z');
  // The day is clamped to the target month: 31 Jan + 1 month = 28 Feb (2027), never 3 Mar.
  assert.equal(resumeAtFor({ current_period_end: '2027-01-31T00:00:00.000Z' }, 1, T0), '2027-02-27T23:00:00.000Z');

  const active = billingDeps([activeRow()]);
  const response = await createPauseHandler(active.deps).POST(billingRequest('pause', { months: 1 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.effective_from, 'next_billing_period');
  assert.equal(body.effective_at, iso(30 * DAY));
  assert.equal(body.resume_at, R1);
  assert.equal(body.access_until, iso(35 * DAY), 'not revoked');
  assert.deepEqual(active.provider.calls, [['pauseSubscription', SUB, 'next_billing_period', R1]]);
  assert.deepEqual(active.updates, [['row-seed', { resume_at: R1 }]]);

  assert.equal((await createPauseHandler(active.deps).POST(billingRequest('pause', { months: 2 }))).status, 400);
  assert.equal((await createPauseHandler(billingDeps([trialingRow()]).deps).POST(billingRequest('pause', { months: 1 }))).status, 409);
  assert.equal((await createPauseHandler(billingDeps([{ ...activeRow(), cancel_at: iso(33 * DAY) }]).deps).POST(billingRequest('pause', { months: 3 }))).status, 409);
  assert.equal((await createPauseHandler(billingDeps([]).deps).POST(billingRequest('pause', { months: 1 }))).status, 404);
});

test('billing/switch: only monthly -> yearly on an active row, price from env, prorated', async () => {
  assert.equal(ineligibleReason(null, 'yearly'), 'no_subscription');
  assert.equal(ineligibleReason({ plan: 'yearly', status: 'active' }, 'yearly'), 'already_on_plan');
  assert.equal(ineligibleReason({ plan: 'monthly', status: 'trialing' }, 'yearly'), 'status_trialing');
  assert.equal(ineligibleReason({ plan: 'monthly', status: 'active', cancel_at: iso() }, 'yearly'), 'cancel_scheduled');
  assert.equal(ineligibleReason({ plan: 'monthly', status: 'active' }, 'yearly'), null);

  const active = billingDeps([activeRow()]);
  const response = await createSwitchHandler(active.deps).POST(billingRequest('switch', { plan: 'yearly' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.plan, 'yearly');
  assert.equal(body.next_billed_at, iso(365 * DAY));
  assert.deepEqual(active.provider.calls, [['changePlan', SUB, ENV.MOR_PRICE_YEARLY, true]]);
  assert.deepEqual(active.updates, [['row-seed', { plan: 'yearly', provider_price_id: ENV.MOR_PRICE_YEARLY, needs_reconcile: true, display_amount: null, display_currency: null, display_tax_inclusive: null }]], 'the old price is not quoted as the next charge');

  assert.equal((await createSwitchHandler(active.deps).POST(billingRequest('switch', { plan: 'monthly' }))).status, 400);
  assert.equal((await createSwitchHandler(billingDeps([trialingRow()]).deps).POST(billingRequest('switch', { plan: 'yearly' }))).status, 409);
  const noPrice = billingDeps([activeRow()]);
  noPrice.deps.env = { ...ENV, MOR_PRICE_YEARLY: '' };
  assert.equal((await createSwitchHandler(noPrice.deps).POST(billingRequest('switch', { plan: 'yearly' }))).status, 503);
});

/* ======================================================= reconcile cron ==== */

function cronRequest(secret = CRON_SECRET) {
  return new Request('https://helpmebreath.com/api/cron/reconcile', { method: 'GET', headers: secret ? { authorization: `Bearer ${secret}` } : {} });
}

test('reconcile: refuses without CRON_SECRET', async () => {
  const handler = createReconcileHandler({ store: memoryStore(), provider: providerStub(), providerCtx: {}, env: ENV, cronSecret: CRON_SECRET });
  assert.equal((await handler.GET(cronRequest(''))).status, 401);
  assert.equal((await handler.GET(cronRequest('TESTFIXTURE-wrong'))).status, 401);
});

test('reconcile: rewrites flagged and lapsed rows from getSubscription, re-drives failed events, reports what is left', async () => {
  const flagged = { ...trialingRow(), needs_reconcile: true };
  const lapsed = { ...activeRow(), provider_subscription_id: 'sub_01testfixturelapsed0000000', access_until: iso(-DAY), last_event_at: iso(-40 * DAY) };
  const fine = { ...activeRow(), provider_subscription_id: 'sub_01testfixturefine000000000' };
  const store = memoryStore({ subscriptions: [flagged, lapsed, fine], intents: [seededIntent()], claims: [{ email_hash: EMAIL_HASH, outcome: 'started', provider: PRIMARY, provider_subscription_id: SUB }] });

  // a failed event with a kept payload, and one that is exhausted
  const failedNotification = primaryNotification('subscription.activated', subscriptionEntity({ status: 'active', current_billing_period: { starts_at: iso(3 * DAY), ends_at: iso(33 * DAY) } }), { id: 'evt_TESTFIXTURE_failed', occurredAt: iso(3 * DAY) });
  store.events.set(`${PRIMARY}:evt_TESTFIXTURE_failed`, { provider: PRIMARY, event_id: 'evt_TESTFIXTURE_failed', event_type: 'subscription.activated', status: 'failed', attempts: 2, error: 'TESTFIXTURE timeout', payload: failedNotification });
  store.events.set(`${PRIMARY}:evt_TESTFIXTURE_gaveup`, { provider: PRIMARY, event_id: 'evt_TESTFIXTURE_gaveup', event_type: 'subscription.updated', status: 'failed', attempts: 10, error: 'orphan_subscription', payload: { x: 1 } });
  store.subs.push({ ...activeRow(), provider_subscription_id: 'sub_01testfixtureorphan0000000', user_id: null, detached_at: null });

  const provider = providerStub();
  const alerts = [];
  const handler = createReconcileHandler({ store, provider, providerCtx: {}, env: ENV, cronSecret: CRON_SECRET, alert: (k, d) => alerts.push({ k, d }), now: () => T0 + 20 * DAY });
  const response = await handler.GET(cronRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.results.subscriptions_checked, 2, 'the flagged row and the lapsed row, not the fine one');
  assert.equal(body.results.subscriptions_rewritten, 2);
  assert.equal(body.results.events_redriven, 1);
  assert.equal(body.results.events_processed, 1);
  assert.equal(body.results.events_exhausted, 1);
  assert.equal(body.results.orphans, 1);

  const rewritten = store.subs.find((r) => r.provider_subscription_id === SUB);
  assert.equal(rewritten.needs_reconcile, false);
  assert.equal(rewritten.status, 'active');
  assert.equal(rewritten.current_period_end, iso(63 * DAY));
  assert.equal(rewritten.access_until, iso(63 * DAY + 48 * HOUR));
  assert.equal(rewritten.last_event_at, iso(20 * DAY), 'stamped with the time of the read, never the subscription creation time the API object carries');
  assert.equal(store.claims[0].outcome, 'converted', 'the ledger side effect of the missed conversion webhook');
  assert.ok(provider.calls.some((c) => c[0] === 'getSubscription' && c[1] === 'sub_01testfixturelapsed0000000'));
  assert.ok(!provider.calls.some((c) => c[1] === 'sub_01testfixturefine000000000'));

  const redriven = store.events.get(`${PRIMARY}:evt_TESTFIXTURE_failed`);
  assert.equal(redriven.status, 'processed');
  assert.equal(redriven.attempts, 3);
  assert.equal(alerts.at(-1).k, 'reconcile_attention');
  assert.deepEqual(alerts.at(-1).d, { exhausted: 1, orphans: 1 });
});

test('reconcile: a re-driven event that fails again stays failed with its payload; the live gate still applies', async () => {
  const store = memoryStore();
  const notification = primaryNotification('subscription.created', subscriptionEntity({ custom_data: null, items: [{ status: 'active', price: { id: ENV.MOR_PRICE_MONTHLY } }], status: 'active', current_billing_period: { starts_at: iso(), ends_at: iso(30 * DAY) } }), { id: 'evt_TESTFIXTURE_orphan' });
  store.events.set(`${PRIMARY}:evt_TESTFIXTURE_orphan`, { provider: PRIMARY, event_id: 'evt_TESTFIXTURE_orphan', status: 'failed', attempts: 1, payload: notification });
  const handler = createReconcileHandler({ store, provider: providerStub(), providerCtx: {}, env: ENV, cronSecret: CRON_SECRET, alert: () => {}, now: () => T0 });
  const body = await (await handler.GET(cronRequest())).json();
  assert.equal(body.results.events_failed, 1);
  const row = store.events.get(`${PRIMARY}:evt_TESTFIXTURE_orphan`);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 2);
  assert.deepEqual(row.payload, notification);

  const liveStore = memoryStore();
  liveStore.events.set(`${PRIMARY}:evt_TESTFIXTURE_live`, { provider: PRIMARY, event_id: 'evt_TESTFIXTURE_live', status: 'failed', attempts: 1, payload: primaryNotification('subscription.created', subscriptionEntity(), { id: 'evt_TESTFIXTURE_live' }) });
  const gated = createReconcileHandler({ store: liveStore, provider: providerStub(), providerCtx: {}, env: { ...ENV, MOR_SANDBOX: 'false' }, cronSecret: CRON_SECRET, alert: () => {}, now: () => T0 });
  const gatedBody = await (await gated.GET(cronRequest())).json();
  assert.equal(gatedBody.results.events_ignored, 1);
  assert.equal(liveStore.events.get(`${PRIMARY}:evt_TESTFIXTURE_live`).status, 'ignored');
  assert.equal(liveStore.subs.length, 0);
});

test('reconcile: a rewrite that converts or cancels a trial writes the §6.6 ledger outcome the lost webhook would have', async () => {
  const converted = memoryStore({ subscriptions: [{ ...trialingRow(), needs_reconcile: true }], claims: [{ email_hash: EMAIL_HASH, outcome: 'started', provider: PRIMARY, provider_subscription_id: SUB }] });
  await reconcileSubscription(converted.subs[0], { store: converted, provider: providerStub(), providerCtx: {}, nowMs: T0 + 5 * DAY });
  assert.equal(converted.subs[0].status, 'active');
  assert.equal(converted.claims[0].outcome, 'converted');

  const cancelled = memoryStore({ subscriptions: [{ ...trialingRow(), needs_reconcile: true }], claims: [{ email_hash: EMAIL_HASH, outcome: 'started', provider: PRIMARY, provider_subscription_id: SUB }] });
  const provider = providerStub({ getSubscription: (id) => normalizeEvent({ type: 'sub.updated', occurredAt: iso(2 * DAY), providerSubscriptionId: id, status: 'canceled', plan: 'monthly', canceledAt: iso(2 * DAY) }) });
  await reconcileSubscription(cancelled.subs[0], { store: cancelled, provider, providerCtx: {}, nowMs: T0 + 5 * DAY });
  assert.equal(cancelled.subs[0].status, 'canceled');
  assert.equal(cancelled.subs[0].access_until, iso(2 * DAY));
  assert.equal(cancelled.claims[0].outcome, 'cancelled');
});

/* ============================================ preview-deployment secrets == */

/** Run `fn` with a patched process.env, restoring every touched key afterwards. */
async function withEnv(patch, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('wiring: a preview deployment with no MOR_WEBHOOK_SECRET verifies nothing — the dev placeholder never becomes a usable secret', async () => {
  const placeholder = 'dev-missing-MOR_WEBHOOK_SECRET';
  await withEnv({ VERCEL_ENV: 'preview', NODE_ENV: 'test', MOR_WEBHOOK_SECRET: null, MOR_API_KEY: null, MOR_PROVIDER: null, CRON_SECRET: null }, async () => {
    const deps = webhookProductionDeps();
    assert.equal(deps.secret, '', 'no secret, not the placeholder');
    const handler = createWebhookHandler({ ...deps, store: memoryStore() });
    const raw = JSON.stringify(primaryNotification('subscription.created', subscriptionEntity()));
    const response = await handler.POST(webhookRequest(raw, { 'paddle-signature': await signPrimary(raw, Math.floor(Date.now() / 1000), placeholder) }));
    assert.equal(response.status, 401);

    const cron = reconcileProductionDeps();
    assert.equal(cron.cronSecret, '');
    const reconcile = createReconcileHandler({ ...cron, store: memoryStore() });
    const forged = await reconcile.GET(new Request('https://helpmebreath.com/api/cron/reconcile', { headers: { authorization: 'Bearer dev-missing-CRON_SECRET' } }));
    assert.equal(forged.status, 401);
  });
  await withEnv({ VERCEL_ENV: 'production', MOR_WEBHOOK_SECRET: null, MOR_API_KEY: 'pdl_sdbx_TESTFIXTURE_not_a_real_key', CRON_SECRET: null }, async () => {
    assert.throws(() => webhookProductionDeps(), /MOR_WEBHOOK_SECRET/);
    assert.throws(() => reconcileProductionDeps(), /CRON_SECRET/);
  });
});
