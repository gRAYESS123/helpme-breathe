/**
 * tools/stripe.test.mjs — the Stripe adapter, offline.
 *
 *   node --test tools/stripe.test.mjs
 *
 * Every provider call goes through a recording fetch stub that decodes the
 * form-encoded body Stripe expects. Every key and id is an obviously fake
 * TESTFIXTURE placeholder — realistic-looking keys trip GitHub push protection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bytesToHex, hmacSha256 } from '../api/_lib/crypto.js';
import { PROVIDER_IDS, assertAdapter, getProvider, listProviders, ProviderError } from '../api/_lib/providers/index.js';
import {
  API_VERSION,
  CHECKOUT_SESSION_TTL_SECONDS,
  MANAGED_PAYMENTS_VERSION,
  TRIAL_PERIOD_DAYS,
  encodeForm,
  managedPaymentsEnabled,
  parseStripeSignature,
  refineUpdate,
  statusFor,
  stripeProvider,
} from '../api/_lib/providers/stripe.js';
import { createWebhookHandler } from '../api/webhooks/mor.js';

/* ------------------------------------------------------------- fixtures ---- */

const SECRET = 'whsec_TESTFIXTURE_not_a_real_secret';
const ENV = Object.freeze({
  MOR_API_KEY: 'sk_test_TESTFIXTURE_not_a_real_key',
  MOR_API_BASE: 'https://stripe.testfixture.invalid',
  MOR_SANDBOX: 'true',
  SITE_ORIGIN: 'https://helpmebreath.com',
  MOR_PRICE_MONTHLY: 'price_TESTFIXTURE_monthly',
  MOR_PRICE_YEARLY: 'price_TESTFIXTURE_yearly',
});
/** A plain Stripe account: no Managed Payments, the owner sells. */
const ENV_PLAIN = Object.freeze({ ...ENV, MOR_MANAGED_PAYMENTS: 'false' });
const ENV_WITH_TRIAL_PRICES = Object.freeze({
  ...ENV,
  MOR_PRICE_MONTHLY_TRIAL: 'price_TESTFIXTURE_monthly_trial',
  MOR_PRICE_YEARLY_TRIAL: 'price_TESTFIXTURE_yearly_trial',
});

const RID = '3f2b9c40-0000-4000-8000-00000000000a';
const SUB = 'sub_TESTFIXTURE00000000000001';
const CUS = 'cus_TESTFIXTURE00000000000001';
const INV = 'in_TESTFIXTURE000000000000001';
const CH = 'ch_TESTFIXTURE000000000000001';
const CS = 'cs_test_TESTFIXTURE0000000000001';

const T0 = Date.parse('2026-09-14T10:00:00Z');
const unix = (offsetMs = 0) => Math.floor((T0 + offsetMs) / 1000);
const iso = (offsetMs = 0) => new Date(T0 + offsetMs).toISOString();
const DAY = 24 * 3600 * 1000;

/** Recording fetch stub; decodes Stripe's form bodies into nested objects. */
function fetchStub(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const key = `${method} ${u.pathname}`;
    const form = init.body ? Object.fromEntries(new URLSearchParams(String(init.body)).entries()) : null;
    const call = { key, url: u, init, form, headers: init.headers || {} };
    calls.push(call);
    const route = routes[key] ?? routes[`${method} *`];
    if (route === undefined) return new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such thing' } }), { status: 404 });
    const out = typeof route === 'function' ? route(call) : route;
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  impl.calls = calls;
  return impl;
}

function ctxWith(fetchImpl, env = ENV) {
  return { env, fetchImpl, isProd: false, now: T0 };
}

async function sign(raw, t = unix(), secret = SECRET) {
  return `t=${t},v1=${bytesToHex(await hmacSha256(secret, `${t}.${raw}`))}`;
}

function stripeEvent(type, object, { id = 'evt_TESTFIXTURE00000000000001', previous = undefined, livemode = false, created = unix() } = {}) {
  const data = { object };
  if (previous !== undefined) data.previous_attributes = previous;
  return { id, object: 'event', type, created, livemode, data };
}

function subscription(overrides = {}) {
  return {
    id: SUB,
    object: 'subscription',
    status: 'trialing',
    customer: CUS,
    currency: 'usd',
    created: unix(),
    trial_start: unix(),
    trial_end: unix(3 * DAY),
    current_period_start: unix(),
    current_period_end: unix(3 * DAY),
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    pause_collection: null,
    latest_invoice: INV,
    metadata: { rid: RID, v: '3' },
    items: { object: 'list', data: [{ id: 'si_TESTFIXTURE0000000000001', price: { id: ENV.MOR_PRICE_MONTHLY, currency: 'usd', unit_amount: 1000 } }] },
    ...overrides,
  };
}

function invoice(overrides = {}) {
  return {
    id: INV,
    object: 'invoice',
    customer: CUS,
    customer_email: 'person@example.com',
    subscription: SUB,
    subscription_details: { metadata: { rid: RID, v: '3' } },
    status: 'paid',
    billing_reason: 'subscription_cycle',
    currency: 'usd',
    amount_paid: 1050,
    total: 1050,
    created: unix(),
    total_tax_amounts: [{ amount: 50 }],
    lines: { data: [{ price: { id: ENV.MOR_PRICE_MONTHLY }, period: { start: unix(3 * DAY), end: unix(33 * DAY) } }] },
    ...overrides,
  };
}

/* ================================================================ index ==== */

test('stripe is a registered adapter and implements contract v3', () => {
  assert.ok(PROVIDER_IDS.includes('stripe'));
  assert.equal(getProvider('stripe').id, 'stripe');
  assert.equal(getProvider('STRIPE').id, 'stripe');
  for (const adapter of Object.values(listProviders())) assertAdapter(adapter);
  assert.equal(stripeProvider.separateTrialPrices, false, 'the trial is a session property, not a second price');
});

test('priceIdFor: the paid price stands in for a missing trial price', () => {
  assert.equal(stripeProvider.priceIdFor({ plan: 'monthly', trial: true }, ENV), ENV.MOR_PRICE_MONTHLY);
  assert.equal(stripeProvider.priceIdFor({ plan: 'yearly', trial: false }, ENV), ENV.MOR_PRICE_YEARLY);
  assert.equal(stripeProvider.priceIdFor({ plan: 'monthly', trial: true }, ENV_WITH_TRIAL_PRICES), ENV_WITH_TRIAL_PRICES.MOR_PRICE_MONTHLY_TRIAL);
  // A Paddle price left in the trial variable by an earlier configuration is ignored.
  assert.equal(stripeProvider.priceIdFor({ plan: 'monthly', trial: true }, { ...ENV, MOR_PRICE_MONTHLY_TRIAL: 'pri_TESTFIXTURE_left_over' }), ENV.MOR_PRICE_MONTHLY);
  assert.throws(() => stripeProvider.priceIdFor({ plan: 'monthly', trial: false }, { ...ENV, MOR_PRICE_MONTHLY: '' }), /Missing environment variable MOR_PRICE_MONTHLY/);
});

test('encodeForm writes Stripe bracket notation and keeps empty strings', () => {
  const body = encodeForm({ mode: 'subscription', line_items: [{ price: 'p', quantity: 1 }], automatic_tax: { enabled: true }, skip: undefined, gone: null, pause_collection: '' });
  assert.equal(
    body,
    'mode=subscription&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&automatic_tax%5Benabled%5D=true&pause_collection=',
  );
});

/* ============================================================ signature ==== */

test('verifyWebhook: a valid Stripe-Signature over the exact raw body passes', async () => {
  const raw = JSON.stringify(stripeEvent('customer.subscription.created', subscription()));
  const header = await sign(raw);
  assert.deepEqual(await stripeProvider.verifyWebhook(raw, new Headers({ 'Stripe-Signature': header }), SECRET, { now: T0 }), { ok: true });
  assert.deepEqual(parseStripeSignature(`t=1,v1=aa,v0=zz,v1=bb`), { t: '1', v1: ['aa', 'bb'] });
});

test('verifyWebhook: tampering, re-serialising, staleness and malformed headers all fail closed', async () => {
  const raw = JSON.stringify(stripeEvent('customer.subscription.created', subscription()));
  const header = await sign(raw);
  assert.equal((await stripeProvider.verifyWebhook(raw.replace('"trialing"', '"active"  '), { 'stripe-signature': header }, SECRET, { now: T0 })).reason, 'bad_signature');
  assert.equal((await stripeProvider.verifyWebhook(JSON.stringify(JSON.parse(raw), null, 2), { 'stripe-signature': header }, SECRET, { now: T0 })).reason, 'bad_signature');
  assert.equal((await stripeProvider.verifyWebhook(raw, { 'stripe-signature': header }, SECRET, { now: T0 + 299 * 1000 })).ok, true);
  assert.equal((await stripeProvider.verifyWebhook(raw, { 'stripe-signature': header }, SECRET, { now: T0 + 301 * 1000 })).reason, 'stale_timestamp');
  assert.equal((await stripeProvider.verifyWebhook(raw, { 'stripe-signature': `t=${unix()}` }, SECRET, { now: T0 })).reason, 'missing_signature');
  assert.equal((await stripeProvider.verifyWebhook(raw, { 'stripe-signature': `t=${unix()},v1=abc` }, SECRET, { now: T0 })).reason, 'bad_signature');
  assert.equal((await stripeProvider.verifyWebhook(raw, {}, SECRET, { now: T0 })).reason, 'missing_signature');
  assert.equal((await stripeProvider.verifyWebhook(raw, { 'stripe-signature': 'x' }, '', { now: T0 })).reason, 'no_secret');
  assert.equal((await stripeProvider.verifyWebhook(Buffer.from(raw), { 'stripe-signature': 'x' }, SECRET, { now: T0 })).reason, 'raw_body_required');
  // Secret rotation: Stripe sends one v1 per active secret; any one matches.
  const t = unix();
  const other = bytesToHex(await hmacSha256('whsec_TESTFIXTURE_old', `${t}.${raw}`));
  const ours = bytesToHex(await hmacSha256(SECRET, `${t}.${raw}`));
  assert.equal((await stripeProvider.verifyWebhook(raw, { 'stripe-signature': `t=${t},v1=${other},v1=${ours}` }, SECRET, { now: T0 })).ok, true);
});

/* ========================================================== parseEvents ==== */

test('parseEvents: a trialing subscription arrives as sub.created with every field named', () => {
  const body = stripeEvent('customer.subscription.created', subscription());
  const [event] = stripeProvider.parseEvents(JSON.stringify(body), { env: ENV });
  assert.equal(event.id, body.id);
  assert.equal(event.type, 'sub.created');
  assert.equal(event.providerEventType, 'customer.subscription.created');
  assert.equal(event.occurredAt, iso());
  assert.equal(event.live, false, 'livemode is the live flag');
  assert.equal(event.reservationId, RID);
  assert.equal(event.providerSubscriptionId, SUB);
  assert.equal(event.providerCustomerId, CUS);
  assert.equal(event.providerPriceId, ENV.MOR_PRICE_MONTHLY);
  assert.equal(event.plan, 'monthly');
  assert.equal(event.status, 'trialing');
  assert.equal(event.hadTrial, true);
  assert.equal(event.trialStartsAt, iso());
  assert.equal(event.trialEndsAt, iso(3 * DAY));
  assert.equal(event.currentPeriodEnd, iso(3 * DAY));
  assert.equal(event.nextBilledAt, iso(3 * DAY));
  assert.equal(event.canceledAt, null);
  assert.equal(event.scheduledChange, null);
  assert.equal(event.currency, 'USD');
  assert.equal(event.amount, null, 'money comes from invoices only');
  assert.deepEqual(event.payload, body, 'the whole delivery is kept for re-drive');
  assert.equal(event.customDataUserIdSeen, false);
});

test('parseEvents: an updated subscription is refined by what changed', () => {
  const parse = (object, previous) => stripeProvider.parseEvents(JSON.stringify(stripeEvent('customer.subscription.updated', object, { previous })), { env: ENV })[0];

  const activated = parse(subscription({ status: 'active', current_period_start: unix(3 * DAY), current_period_end: unix(33 * DAY) }), { status: 'trialing' });
  assert.equal(activated.type, 'sub.activated');
  assert.equal(activated.status, 'active');
  assert.equal(activated.hadTrial, true, 'trial_end stays on the object after the trial');

  const scheduled = parse(subscription({ status: 'active', cancel_at_period_end: true, canceled_at: unix(), current_period_end: unix(30 * DAY) }), { cancel_at_period_end: false });
  assert.equal(scheduled.type, 'sub.updated');
  assert.deepEqual(scheduled.scheduledChange, { action: 'cancel', effectiveAt: iso(30 * DAY), resumeAt: null });
  assert.equal(scheduled.nextBilledAt, null);
  assert.equal(scheduled.canceledAt, null, 'canceled_at on a scheduled cancel is not a cancellation date');

  const paused = parse(subscription({ status: 'active', pause_collection: { behavior: 'void', resumes_at: unix(60 * DAY) }, current_period_end: unix(30 * DAY) }), { pause_collection: null });
  assert.equal(paused.type, 'sub.paused');
  assert.equal(paused.status, 'paused');
  assert.deepEqual(paused.scheduledChange, { action: 'pause', effectiveAt: iso(30 * DAY), resumeAt: iso(60 * DAY) });

  const resumed = parse(subscription({ status: 'active', pause_collection: null }), { pause_collection: { behavior: 'void', resumes_at: unix(60 * DAY) } });
  assert.equal(resumed.type, 'sub.resumed');

  const pastDue = parse(subscription({ status: 'past_due' }), { status: 'active' });
  assert.equal(pastDue.type, 'sub.past_due');
  assert.equal(pastDue.status, 'past_due');

  const unpaid = parse(subscription({ status: 'unpaid' }), { status: 'past_due' });
  assert.equal(unpaid.status, 'past_due');

  const plain = parse(subscription({ status: 'active' }), { metadata: {} });
  assert.equal(plain.type, 'sub.updated');

  assert.equal(refineUpdate(subscription({ status: 'canceled' }), { status: 'active' }), 'sub.canceled');
  assert.equal(statusFor({ status: 'incomplete' }), null);
  const incomplete = parse(subscription({ status: 'incomplete' }), {});
  assert.equal(incomplete.type, 'ignore', 'a subscription that has not been paid for yet is not a state we track');
});

test('parseEvents: a deleted subscription is the terminal cancel, dated', () => {
  const body = stripeEvent('customer.subscription.deleted', subscription({ status: 'canceled', canceled_at: unix(5 * DAY), ended_at: unix(5 * DAY) }));
  const [event] = stripeProvider.parseEvents(JSON.stringify(body), { env: ENV });
  assert.equal(event.type, 'sub.canceled');
  assert.equal(event.status, 'canceled');
  assert.equal(event.canceledAt, iso(5 * DAY));
  assert.equal(event.nextBilledAt, null);
});

test('parseEvents: invoices are the money — the $0 trial invoice, a paid renewal with tax, a failure, and the newer payload shape', () => {
  const zero = stripeProvider.parseEvents(JSON.stringify(stripeEvent('invoice.paid', invoice({ amount_paid: 0, total: 0, total_tax_amounts: [], billing_reason: 'subscription_create' }))), { env: ENV })[0];
  assert.equal(zero.type, 'txn.completed');
  assert.equal(zero.totalIsZero, true);
  assert.equal(zero.amount, '0.00');
  assert.equal(zero.providerSubscriptionId, SUB);
  assert.equal(zero.reservationId, RID, 'subscription metadata rides on the invoice');
  assert.equal(zero.customerEmail, 'person@example.com');

  const paid = stripeProvider.parseEvents(JSON.stringify(stripeEvent('invoice.paid', invoice())), { env: ENV })[0];
  assert.equal(paid.totalIsZero, false);
  assert.equal(paid.amount, '10.50');
  assert.equal(paid.currency, 'USD');
  assert.equal(paid.taxInclusive, true, 'amount_paid includes the tax Stripe collected');
  assert.equal(paid.providerTransactionId, INV);
  assert.equal(paid.plan, 'monthly');
  assert.equal(paid.currentPeriodStart, iso(3 * DAY));
  assert.equal(paid.currentPeriodEnd, iso(33 * DAY));
  assert.equal(paid.status, null, 'an invoice never sets the subscription status');

  const failed = stripeProvider.parseEvents(JSON.stringify(stripeEvent('invoice.payment_failed', invoice({ status: 'open', amount_paid: 0 }))), { env: ENV })[0];
  assert.equal(failed.type, 'txn.failed');

  // API versions from 2025-03-31 move the subscription under `parent` and the
  // price under `pricing`; the invoice is still read.
  const basil = invoice({ subscription: undefined, subscription_details: undefined, parent: { subscription_details: { subscription: SUB, metadata: { rid: RID } } } });
  basil.lines = { data: [{ pricing: { price_details: { price: ENV.MOR_PRICE_YEARLY } }, period: { start: unix(), end: unix(365 * DAY) } }] };
  basil.total_tax_amounts = undefined;
  basil.total_taxes = [{ amount: 100 }];
  const newer = stripeProvider.parseEvents(JSON.stringify(stripeEvent('invoice.paid', basil)), { env: ENV })[0];
  assert.equal(newer.providerSubscriptionId, SUB);
  assert.equal(newer.reservationId, RID);
  assert.equal(newer.plan, 'yearly');
  assert.equal(newer.taxInclusive, true);
});

test('parseEvents: refunds and disputes name a charge, never a subscription; unknown types are recorded as ignore', () => {
  const refund = stripeProvider.parseEvents(JSON.stringify(stripeEvent('charge.refunded', { id: CH, object: 'charge', amount: 1050, amount_refunded: 1050, currency: 'usd', invoice: INV, customer: CUS })), { env: ENV })[0];
  assert.equal(refund.type, 'txn.refunded');
  assert.equal(refund.providerSubscriptionId, null);
  assert.equal(refund.providerTransactionId, INV);
  assert.equal(refund.amount, '10.50');
  assert.equal(refund.fullyRefunded, false, 'without refunded:true it is a partial refund');
  const full = stripeProvider.parseEvents(JSON.stringify(stripeEvent('charge.refunded', { id: CH, object: 'charge', amount: 1050, amount_refunded: 1050, refunded: true, currency: 'usd', invoice: INV, customer: CUS })), { env: ENV })[0];
  assert.equal(full.fullyRefunded, true);

  const dispute = stripeProvider.parseEvents(JSON.stringify(stripeEvent('charge.dispute.created', { id: 'dp_TESTFIXTURE1', object: 'dispute', amount: 1050, currency: 'usd', charge: CH })), { env: ENV })[0];
  assert.equal(dispute.type, 'txn.chargeback');
  assert.equal(dispute.providerTransactionId, CH);

  const oneOff = stripeProvider.parseEvents(JSON.stringify(stripeEvent('checkout.session.completed', { id: CS, object: 'checkout.session', mode: 'payment' })), { env: ENV })[0];
  assert.equal(oneOff.type, 'ignore', 'a one-off payment session is not ours');
  assert.equal(oneOff.id, 'evt_TESTFIXTURE00000000000001');

  assert.throws(() => stripeProvider.parseEvents('not json', { env: ENV }), /not JSON/);
  assert.throws(() => stripeProvider.parseEvents(JSON.stringify({ type: 'x' }), { env: ENV }), /no id/);
});

test('parseEvents: checkout.session.completed is the blueprint\'s success signal — a txn.completed with the ids, the email and the reservation', () => {
  const paid = stripeProvider.parseEvents(JSON.stringify(stripeEvent('checkout.session.completed', {
    id: CS, object: 'checkout.session', mode: 'subscription', subscription: SUB, customer: CUS, client_reference_id: RID,
    customer_details: { email: 'person@example.com' }, amount_total: 1050, currency: 'usd', payment_status: 'paid', total_details: { amount_tax: 50 },
  })), { env: ENV })[0];
  assert.equal(paid.type, 'txn.completed');
  assert.equal(paid.providerSubscriptionId, SUB);
  assert.equal(paid.providerCustomerId, CUS);
  assert.equal(paid.providerTransactionId, CS);
  assert.equal(paid.reservationId, RID, 'client_reference_id carries the reservation when metadata does not');
  assert.equal(paid.customerEmail, 'person@example.com');
  assert.equal(paid.amount, '10.50');
  assert.equal(paid.taxInclusive, true);
  assert.equal(paid.totalIsZero, false);
  assert.equal(paid.plan, null, 'the session carries no price; the subscription events carry the plan');

  const trial = stripeProvider.parseEvents(JSON.stringify(stripeEvent('checkout.session.completed', {
    id: CS, mode: 'subscription', subscription: SUB, customer: CUS, metadata: { rid: RID }, amount_total: 0, currency: 'usd', payment_status: 'no_payment_required',
  })), { env: ENV })[0];
  assert.equal(trial.totalIsZero, true, 'the $0 start of a trial is noted, never counted as money');
  assert.equal(trial.reservationId, RID);
});

/* ========================================================== enrichEvent ==== */

test('enrichEvent: a refund is tied to its subscription through the invoice; a dispute through the charge', async () => {
  const fetchImpl = fetchStub({
    [`GET /v1/invoices/${INV}`]: invoice(),
    [`GET /v1/charges/${CH}`]: { id: CH, invoice: INV, customer: CUS },
  });
  const refund = stripeProvider.parseEvents(JSON.stringify(stripeEvent('charge.refunded', { id: CH, amount_refunded: 1050, currency: 'usd', invoice: INV })), { env: ENV })[0];
  const enriched = await stripeProvider.enrichEvent(refund, ctxWith(fetchImpl));
  assert.equal(enriched.providerSubscriptionId, SUB);
  assert.equal(enriched.providerCustomerId, CUS);
  assert.equal(enriched.reservationId, RID);
  assert.equal(enriched.type, 'txn.refunded');

  const dispute = stripeProvider.parseEvents(JSON.stringify(stripeEvent('charge.dispute.created', { id: 'dp_1', amount: 1050, currency: 'usd', charge: CH })), { env: ENV })[0];
  const enrichedDispute = await stripeProvider.enrichEvent(dispute, ctxWith(fetchImpl));
  assert.equal(enrichedDispute.providerSubscriptionId, SUB);
  assert.deepEqual(fetchImpl.calls.map((c) => c.key), [`GET /v1/invoices/${INV}`, `GET /v1/charges/${CH}`, `GET /v1/invoices/${INV}`]);

  // A one-off charge with no invoice is nothing of ours; a subscription event is untouched.
  const oneOff = await stripeProvider.enrichEvent(stripeProvider.parseEvents(JSON.stringify(stripeEvent('charge.refunded', { id: CH, amount_refunded: 500, currency: 'usd', invoice: null })), { env: ENV })[0], ctxWith(fetchStub({ [`GET /v1/charges/${CH}`]: { id: CH, invoice: null } })));
  assert.equal(oneOff.providerSubscriptionId, null);
  const sub = stripeProvider.parseEvents(JSON.stringify(stripeEvent('customer.subscription.created', subscription())), { env: ENV })[0];
  assert.equal(await stripeProvider.enrichEvent(sub, ctxWith(fetchStub({}))), sub);

  // An API outage throws, so the event is marked failed and retried rather than ignored.
  const down = fetchStub({ [`GET /v1/invoices/${INV}`]: () => new Response('{}', { status: 503 }) });
  await assert.rejects(() => stripeProvider.enrichEvent(refund, ctxWith(down)), /503/);
});

/* ============================================================= checkout ==== */

test('ensureCustomer: the lookup is the dedupe, then a create', async () => {
  const found = fetchStub({ 'GET /v1/customers': { object: 'list', data: [{ id: CUS, email: 'person@example.com' }] } });
  assert.deepEqual(await stripeProvider.ensureCustomer('person@example.com', ctxWith(found)), { id: CUS, existed: true });
  assert.equal(found.calls.length, 1);
  assert.equal(found.calls[0].url.searchParams.get('email'), 'person@example.com');
  assert.equal(found.calls[0].headers.Authorization, `Bearer ${ENV.MOR_API_KEY}`);
  assert.equal(found.calls[0].headers['Stripe-Version'], API_VERSION);

  const fresh = fetchStub({ 'GET /v1/customers': { object: 'list', data: [] }, 'POST /v1/customers': { id: 'cus_TESTFIXTURE_new' } });
  assert.deepEqual(await stripeProvider.ensureCustomer('person@example.com', ctxWith(fresh)), { id: 'cus_TESTFIXTURE_new', existed: false });
  assert.equal(fresh.calls[1].form.email, 'person@example.com');
  assert.equal(fresh.calls[1].headers['Content-Type'], 'application/x-www-form-urlencoded');
  await assert.rejects(() => stripeProvider.ensureCustomer('', ctxWith(fresh)), /email is required/);
});

test('createCheckoutSession: Managed Payments by default — Stripe as merchant of record, on the preview version', async () => {
  const fetchImpl = fetchStub({ 'POST /v1/checkout/sessions': { id: CS, status: 'open', url: 'https://checkout.stripe.com/c/pay/TESTFIXTURE' } });
  assert.equal(managedPaymentsEnabled(ENV), true, 'on unless literally false');
  assert.equal(managedPaymentsEnabled(ENV_PLAIN), false);
  const out = await stripeProvider.createCheckoutSession({ priceId: ENV.MOR_PRICE_MONTHLY, customerId: CUS, customData: { rid: RID, v: 3 }, trial: true }, ctxWith(fetchImpl));
  assert.equal(out.transactionId, CS);
  const call = fetchImpl.calls[0];
  assert.equal(call.form['managed_payments[enabled]'], 'true');
  assert.equal(call.headers['Stripe-Version'], MANAGED_PAYMENTS_VERSION, 'the blueprint\'s version header on this call only');
  assert.equal(call.form['automatic_tax[enabled]'], undefined, 'the merchant of record collects tax; the seller does not ask for it');
  assert.equal(call.form['customer_update[address]'], undefined);
  assert.equal(call.form['subscription_data[trial_period_days]'], String(TRIAL_PERIOD_DAYS));
  assert.equal(call.form['subscription_data[metadata][rid]'], RID);
  assert.equal(call.headers['Idempotency-Key'], `hmb-cs-${RID}-managed`);
});

test('createCheckoutSession: when Stripe refuses Managed Payments nothing is sold under another model — the call fails and the log says what to do', async () => {
  const fetchImpl = fetchStub({
    'POST /v1/checkout/sessions': () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', param: 'managed_payments', message: 'Your account is not eligible for Managed Payments.' } }), { status: 400 }),
  });
  const err = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await assert.rejects(
      () => stripeProvider.createCheckoutSession({ priceId: ENV.MOR_PRICE_MONTHLY, customerId: CUS, customData: { rid: RID, v: 3 }, trial: true }, ctxWith(fetchImpl)),
      (e) => e instanceof ProviderError && e.reason === 'managed_payments_refused',
    );
  } finally {
    console.error = err;
  }
  assert.equal(fetchImpl.calls.length, 1, 'no second shape is tried: the legal pages name Stripe as the seller');
  assert.match(errors.join('\n'), /managed payments refused/);
  assert.match(errors.join('\n'), /MOR_MANAGED_PAYMENTS=false/);
  // A version rejection is a refusal too: the account is not on the preview.
  const fetchVersion = fetchStub({
    'POST /v1/checkout/sessions': () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid Stripe API version: 2026-02-25.preview' } }), { status: 400 }),
  });
  console.error = () => {};
  try {
    await assert.rejects(() => stripeProvider.createCheckoutSession({ priceId: ENV.MOR_PRICE_MONTHLY, customerId: CUS, customData: { rid: RID, v: 3 }, trial: true }, ctxWith(fetchVersion)), /Managed Payments/);
  } finally {
    console.error = err;
  }
  assert.equal(fetchVersion.calls.length, 1);
});

test('createCheckoutSession: a plain account — the trial, the price, the customer and the reservation are fixed server-side', async () => {
  const fetchImpl = fetchStub({ 'POST /v1/checkout/sessions': { id: CS, status: 'open', url: 'https://checkout.stripe.com/c/pay/TESTFIXTURE' } });
  const out = await stripeProvider.createCheckoutSession({ priceId: ENV.MOR_PRICE_MONTHLY, customerId: CUS, customData: { rid: RID, v: 3 }, trial: true }, ctxWith(fetchImpl, ENV_PLAIN));
  assert.deepEqual(out, { transactionId: CS, status: 'open', checkoutUrl: 'https://checkout.stripe.com/c/pay/TESTFIXTURE' });
  const form = fetchImpl.calls[0].form;
  assert.equal(form.mode, 'subscription');
  assert.equal(form['line_items[0][price]'], ENV.MOR_PRICE_MONTHLY);
  assert.equal(form['line_items[0][quantity]'], '1');
  assert.equal(form.customer, CUS);
  assert.equal(form.client_reference_id, RID);
  assert.equal(form['metadata[rid]'], RID);
  assert.equal(form['subscription_data[metadata][rid]'], RID);
  assert.equal(form['subscription_data[trial_period_days]'], String(TRIAL_PERIOD_DAYS));
  assert.equal(form.payment_method_collection, 'always', 'a card is required for the trial');
  assert.equal(form.success_url, `https://helpmebreath.com/pro/thanks?rid=${RID}`);
  assert.equal(form.cancel_url, 'https://helpmebreath.com/pro?checkout=cancelled');
  assert.equal(form['automatic_tax[enabled]'], 'true');
  assert.equal(form['customer_update[address]'], 'auto');
  assert.equal(Number(form.expires_at), unix() + CHECKOUT_SESSION_TTL_SECONDS);
  assert.equal(fetchImpl.calls[0].headers['Idempotency-Key'], `hmb-cs-${RID}-tax`);
  assert.equal(fetchImpl.calls[0].form['managed_payments[enabled]'], undefined);
  assert.ok(!('price_id' in form) && !('items' in form), 'nothing Paddle-shaped leaks into a Stripe call');

  const noTrial = fetchStub({ 'POST /v1/checkout/sessions': { id: CS, status: 'open', url: 'https://checkout.stripe.com/c/pay/x' } });
  await stripeProvider.createCheckoutSession({ priceId: ENV.MOR_PRICE_YEARLY, customerId: CUS, customData: { rid: RID, v: 3 }, trial: false }, ctxWith(noTrial, ENV_PLAIN));
  assert.equal(noTrial.calls[0].form['subscription_data[trial_period_days]'], undefined, 'no trial, no trial days');

  const named = fetchStub({ 'POST /v1/checkout/sessions': { id: CS, status: 'open', url: 'https://checkout.stripe.com/c/pay/x' } });
  await stripeProvider.createCheckoutSession({ priceId: ENV.MOR_PRICE_YEARLY, customerId: CUS, customData: { rid: RID, v: 3 }, trial: true, plan: 'yearly' }, ctxWith(named, ENV_PLAIN));
  assert.equal(named.calls[0].form.success_url, `https://helpmebreath.com/pro/thanks?rid=${RID}&plan=yearly`, 'the plan name rides the return URL for /pro/thanks');
  assert.equal(named.calls[0].form['metadata[plan]'], undefined, 'the plan is not sent to Stripe as metadata');
  const odd = fetchStub({ 'POST /v1/checkout/sessions': { id: CS, status: 'open', url: 'https://checkout.stripe.com/c/pay/x' } });
  await stripeProvider.createCheckoutSession({ priceId: ENV.MOR_PRICE_YEARLY, customerId: CUS, customData: { rid: RID, v: 3 }, trial: true, plan: 'lifetime' }, ctxWith(odd, ENV_PLAIN));
  assert.equal(odd.calls[0].form.success_url, `https://helpmebreath.com/pro/thanks?rid=${RID}`, 'an unknown plan name is dropped, not forwarded');
  assert.equal(noTrial.calls[0].form['subscription_data[metadata][rid]'], RID);
});

test('createCheckoutSession: on a plain account, when Stripe Tax is not enabled the session is created without it', async () => {
  let attempt = 0;
  const fetchImpl = fetchStub({
    'POST /v1/checkout/sessions': () => {
      attempt += 1;
      if (attempt === 1) return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'You must enable Stripe Tax to use automatic_tax.' } }), { status: 400 });
      return { id: CS, status: 'open', url: 'https://checkout.stripe.com/c/pay/x' };
    },
  });
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const out = await stripeProvider.createCheckoutSession({ priceId: ENV.MOR_PRICE_MONTHLY, customerId: CUS, customData: { rid: RID, v: 3 }, trial: true }, ctxWith(fetchImpl, ENV_PLAIN));
    assert.equal(out.transactionId, CS);
  } finally {
    console.warn = warn;
  }
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].form['automatic_tax[enabled]'], undefined);
  assert.equal(fetchImpl.calls[1].form['customer_update[address]'], undefined);
  assert.equal(fetchImpl.calls[1].headers['Idempotency-Key'], `hmb-cs-${RID}-notax`);
  assert.match(warnings.join('\n'), /automatic tax refused/);

  // Any other 400 is the caller's problem, not something to retry around.
  const other = fetchStub({ 'POST /v1/checkout/sessions': () => new Response(JSON.stringify({ error: { message: 'No such price' } }), { status: 400 }) });
  await assert.rejects(() => stripeProvider.createCheckoutSession({ priceId: 'price_nope', customerId: CUS, customData: { rid: RID } }, ctxWith(other, ENV_PLAIN)), /400/);
  assert.equal(other.calls.length, 1);
});

test('checkoutUrlFor: only an open session is handed back', async () => {
  const open = fetchStub({ [`GET /v1/checkout/sessions/${CS}`]: { id: CS, status: 'open', url: 'https://checkout.stripe.com/c/pay/x' } });
  assert.equal(await stripeProvider.checkoutUrlFor(CS, ctxWith(open)), 'https://checkout.stripe.com/c/pay/x');
  const expired = fetchStub({ [`GET /v1/checkout/sessions/${CS}`]: { id: CS, status: 'expired', url: null } });
  assert.equal(await stripeProvider.checkoutUrlFor(CS, ctxWith(expired)), null);
  assert.equal(await stripeProvider.checkoutUrlFor('', ctxWith(expired)), null);
});

test('pricePreview: the list price, with tax for the country when Stripe Tax answers', async () => {
  const withTax = fetchStub({
    [`GET /v1/prices/${ENV.MOR_PRICE_MONTHLY}`]: { id: ENV.MOR_PRICE_MONTHLY, unit_amount: 1000, currency: 'usd' },
    'POST /v1/tax/calculations': { amount_total: 1200, tax_amount_exclusive: 200 },
  });
  assert.deepEqual(await stripeProvider.pricePreview({ priceId: ENV.MOR_PRICE_MONTHLY, countryCode: 'de' }, ctxWith(withTax)), { amount: '12.00', currency: 'USD', taxInclusive: true, formatted: '$12.00' });
  assert.equal(withTax.calls[1].form['customer_details[address][country]'], 'DE');
  assert.equal(withTax.calls[1].form['line_items[0][amount]'], '1000');

  const noTax = fetchStub({
    [`GET /v1/prices/${ENV.MOR_PRICE_MONTHLY}`]: { id: ENV.MOR_PRICE_MONTHLY, unit_amount: 1000, currency: 'usd' },
    'POST /v1/tax/calculations': () => new Response(JSON.stringify({ error: { message: 'Stripe Tax is not enabled' } }), { status: 400 }),
  });
  assert.deepEqual(await stripeProvider.pricePreview({ priceId: ENV.MOR_PRICE_MONTHLY, countryCode: 'DE' }, ctxWith(noTax)), { amount: '10.00', currency: 'USD', taxInclusive: false, formatted: '$10.00' });

  const noCountry = fetchStub({ [`GET /v1/prices/${ENV.MOR_PRICE_YEARLY}`]: { unit_amount: 10000, currency: 'usd' } });
  assert.equal((await stripeProvider.pricePreview({ priceId: ENV.MOR_PRICE_YEARLY }, ctxWith(noCountry))).amount, '100.00');
  assert.equal(noCountry.calls.length, 1, 'no country, no tax calculation');
});

/* =========================================================== management ==== */

test('cancelSubscription: immediately deletes, at period end schedules; effectiveFrom is never defaulted', async () => {
  const now = fetchStub({ [`DELETE /v1/subscriptions/${SUB}`]: subscription({ status: 'canceled', canceled_at: unix(), ended_at: unix() }) });
  const gone = await stripeProvider.cancelSubscription(SUB, { effectiveFrom: 'immediately' }, ctxWith(now));
  assert.equal(gone.status, 'canceled');
  assert.equal(gone.canceledAt, iso());
  assert.equal(gone.providerEventType, 'api.cancel');
  assert.equal(gone.live, false, 'a test key is not live');

  const later = fetchStub({ [`POST /v1/subscriptions/${SUB}`]: subscription({ status: 'active', cancel_at_period_end: true, canceled_at: unix(), current_period_end: unix(30 * DAY) }) });
  const scheduled = await stripeProvider.cancelSubscription(SUB, { effectiveFrom: 'next_billing_period' }, ctxWith(later));
  assert.equal(later.calls[0].form.cancel_at_period_end, 'true');
  assert.equal(scheduled.status, 'active');
  assert.deepEqual(scheduled.scheduledChange, { action: 'cancel', effectiveAt: iso(30 * DAY), resumeAt: null });

  await assert.rejects(() => stripeProvider.cancelSubscription(SUB, {}, ctxWith(later)), /effectiveFrom must be passed explicitly/);
});

test('pauseSubscription: pause_collection voids invoices until resumes_at', async () => {
  const fetchImpl = fetchStub({ [`POST /v1/subscriptions/${SUB}`]: subscription({ status: 'active', pause_collection: { behavior: 'void', resumes_at: unix(60 * DAY) }, current_period_end: unix(30 * DAY) }) });
  const out = await stripeProvider.pauseSubscription(SUB, { resumeAt: iso(60 * DAY), effectiveFrom: 'next_billing_period' }, ctxWith(fetchImpl));
  assert.equal(fetchImpl.calls[0].form['pause_collection[behavior]'], 'void');
  assert.equal(fetchImpl.calls[0].form['pause_collection[resumes_at]'], String(unix(60 * DAY)));
  assert.equal(out.status, 'paused');
  assert.deepEqual(out.scheduledChange, { action: 'pause', effectiveAt: iso(30 * DAY), resumeAt: iso(60 * DAY) });
  await assert.rejects(() => stripeProvider.pauseSubscription(SUB, { resumeAt: 'soon', effectiveFrom: 'next_billing_period' }, ctxWith(fetchImpl)), /RFC 3339/);
});

test('changePlan: reads the item id, then swaps the price with prorations', async () => {
  const fetchImpl = fetchStub({
    [`GET /v1/subscriptions/${SUB}`]: subscription({ status: 'active' }),
    [`POST /v1/subscriptions/${SUB}`]: subscription({ status: 'active', items: { data: [{ id: 'si_TESTFIXTURE0000000000001', price: { id: ENV.MOR_PRICE_YEARLY } }] }, current_period_end: unix(365 * DAY) }),
  });
  const out = await stripeProvider.changePlan(SUB, ENV.MOR_PRICE_YEARLY, { prorate: true }, ctxWith(fetchImpl));
  assert.equal(fetchImpl.calls[1].form['items[0][id]'], 'si_TESTFIXTURE0000000000001');
  assert.equal(fetchImpl.calls[1].form['items[0][price]'], ENV.MOR_PRICE_YEARLY);
  assert.equal(fetchImpl.calls[1].form.proration_behavior, 'create_prorations');
  assert.equal(out.plan, 'yearly');
  assert.equal(out.nextBilledAt, iso(365 * DAY));
});

test('createPortalSession: one link per flow, the overview standing in for a flow the portal refuses', async () => {
  const fetchImpl = fetchStub({
    'POST /v1/billing_portal/sessions': (call) => {
      const flow = call.form['flow_data[type]'];
      if (flow === 'subscription_cancel') return new Response(JSON.stringify({ error: { message: 'cancel not enabled' } }), { status: 400 });
      return { url: `https://billing.stripe.com/p/session/${flow || 'overview'}` };
    },
  });
  const out = await stripeProvider.createPortalSession(CUS, [SUB], ctxWith(fetchImpl));
  assert.equal(out.overview, 'https://billing.stripe.com/p/session/overview');
  assert.equal(out.update_payment_method, 'https://billing.stripe.com/p/session/payment_method_update');
  assert.equal(out.cancel, out.overview, 'a refused flow falls back to the overview');
  assert.equal(out.expires_in, 300);
  const cancelCall = fetchImpl.calls.find((c) => c.form['flow_data[type]'] === 'subscription_cancel');
  assert.equal(cancelCall.form['flow_data[subscription_cancel][subscription]'], SUB);
  for (const call of fetchImpl.calls) assert.equal(call.form.return_url, 'https://helpmebreath.com/account');
});

test('stripeRequest: a publishable key in MOR_API_KEY is refused before the call, naming the fix', async () => {
  // The live outage of 2026-09-16: MOR_API_KEY held the publishable key, so
  // /api/health said mor_api_key true, Stripe answered 403 secret_key_required,
  // and /api/trial/eligibility surfaced a bare 502 with "Checkout could not start".
  const never = async () => { throw new Error('the adapter must not reach the network with a pk_ key'); };
  for (const key of ['pk_live_TESTFIXTURE_not_a_real_key', 'pk_test_TESTFIXTURE_not_a_real_key']) {
    await assert.rejects(
      () => stripeProvider.getSubscription(SUB, ctxWith(never, { ...ENV, MOR_API_KEY: key })),
      (e) => e.reason === 'unauthorized' && /publishable/i.test(e.message) && /CHECKOUT\.clientToken/.test(e.message),
      `a ${key.slice(0, 7)} key must be refused with the remedy in the message`,
    );
  }
});

test('stripeRequest: a missing key, an outage and a Stripe error each become a calm ProviderError', async () => {
  await assert.rejects(() => stripeProvider.getSubscription(SUB, ctxWith(fetchStub({}), { ...ENV, MOR_API_KEY: '' })), (e) => e.reason === 'unauthorized');
  const down = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(() => stripeProvider.getSubscription(SUB, ctxWith(down)), (e) => e.reason === 'provider_unavailable');
  const limited = fetchStub({ [`GET /v1/subscriptions/${SUB}`]: () => new Response(JSON.stringify({ error: { code: 'rate_limit' } }), { status: 429 }) });
  await assert.rejects(() => stripeProvider.getSubscription(SUB, ctxWith(limited)), (e) => e.reason === 'rate_limited' && e.code === 'rate_limit' && !/sub_/.test(e.message));
});

/* ============================================================== handler ==== */

/** The slice of the webhook store a refund on an existing row touches. */
function refundStore(row) {
  const calls = [];
  return {
    calls,
    async claimEvent() { calls.push('claim'); return 'claimed'; },
    async markIgnored(_p, _e, reason) { calls.push(`ignored:${reason}`); },
    async markProcessed() { calls.push('processed'); },
    async markFailed(_p, _e, error) { calls.push(`failed:${error && error.message}`); },
    async findSubscription() { return row; },
    async setTrialOutcome(_p, _s, outcome) { calls.push(`outcome:${outcome}`); },
  };
}

test('webhook handler: a refund is enriched through the invoice before it is applied, and the live-flag gate reads livemode', async () => {
  const fetchImpl = fetchStub({ [`GET /v1/invoices/${INV}`]: invoice() });
  const store = refundStore({ id: 'row', provider: 'stripe', provider_subscription_id: SUB, user_id: 'u', status: 'active', ever_paid: true });
  const handler = createWebhookHandler({ store, provider: stripeProvider, providerCtx: ctxWith(fetchImpl), env: ENV, secret: SECRET, now: () => T0 });
  const raw = JSON.stringify(stripeEvent('charge.refunded', { id: CH, amount_refunded: 1050, currency: 'usd', invoice: INV }));
  const response = await handler.POST(new Request('https://helpmebreath.com/api/webhooks/mor', { method: 'POST', headers: { 'stripe-signature': await sign(raw) }, body: raw }));
  assert.equal(response.status, 200);
  assert.deepEqual(store.calls, ['claim', 'outcome:refunded', 'processed']);

  // A live event on a test-mode deployment is recorded and never applied.
  const liveRaw = JSON.stringify(stripeEvent('charge.refunded', { id: CH, amount_refunded: 1050, currency: 'usd', invoice: INV }, { livemode: true }));
  const gated = refundStore({ id: 'row', provider: 'stripe', provider_subscription_id: SUB, status: 'active' });
  const gatedHandler = createWebhookHandler({ store: gated, provider: stripeProvider, providerCtx: ctxWith(fetchImpl), env: ENV, secret: SECRET, now: () => T0 });
  const gatedResponse = await gatedHandler.POST(new Request('https://helpmebreath.com/api/webhooks/mor', { method: 'POST', headers: { 'stripe-signature': await sign(liveRaw) }, body: liveRaw }));
  assert.equal(gatedResponse.status, 200);
  assert.deepEqual(gated.calls, ['ignored:live_flag_mismatch']);

  // A bad signature never reaches the store.
  const forged = createWebhookHandler({ store: refundStore(null), provider: stripeProvider, providerCtx: ctxWith(fetchImpl), env: ENV, secret: SECRET, now: () => T0 });
  const rejected = await forged.POST(new Request('https://helpmebreath.com/api/webhooks/mor', { method: 'POST', headers: { 'stripe-signature': await sign(raw, unix(), 'whsec_TESTFIXTURE_wrong') }, body: raw }));
  assert.equal(rejected.status, 401);
});

test('no adapter method ever puts an email, a session id, a subscription id or a customer id in an error message', async () => {
  const errors = [];
  const capture = (p) => p.catch((e) => errors.push(String(e && e.message)));
  const down = fetchStub({ 'GET *': () => new Response('{}', { status: 500 }), 'POST *': () => new Response('{}', { status: 500 }), 'DELETE *': () => new Response('{}', { status: 500 }) });
  const ctx = ctxWith(down);
  await capture(stripeProvider.ensureCustomer('person@example.com', ctx));
  await capture(stripeProvider.createCheckoutSession({ priceId: 'price_x', customerId: CUS, customData: { rid: RID } }, ctx));
  await capture(stripeProvider.getSubscription(SUB, ctx));
  await capture(stripeProvider.cancelSubscription(SUB, { effectiveFrom: 'immediately' }, ctx));
  await capture(stripeProvider.createPortalSession(CUS, [SUB], ctx));
  assert.ok(errors.length >= 5);
  for (const message of errors) {
    assert.doesNotMatch(message, /person@example\.com|cus_|sub_|cs_|price_x/, message);
  }
});
