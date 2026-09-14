/**
 * api/_lib/providers/stripe.js — Stripe Billing adapter.
 *
 * Adapter contract v3: see api/_lib/providers/index.js. Adopted 2026-09-14
 * after Paddle's identity verification stalled; the owner already holds a
 * Stripe account.
 *
 * STRIPE IS NOT A MERCHANT OF RECORD. With Paddle the payment company was the
 * seller: it collected VAT and sales tax everywhere, issued the receipt and
 * owned refunds and chargebacks. With Stripe the site's owner is the seller.
 * Stripe Tax can calculate and collect tax at checkout (every session below
 * asks for it and falls back gracefully when Tax is not switched on), but
 * registering for and filing that tax, refunds and disputes are the owner's.
 * docs/private/PAYOUT_RAILS.md records why Paddle was chosen first.
 *
 * Written from Stripe's API reference (api version 2024-06-20 pinned on every
 * call, so responses have a stable shape). Field names relied on:
 *
 *   POST /v1/checkout/sessions   `mode=subscription`, `line_items[0][price]`,
 *                                `customer`, `client_reference_id`, `metadata[rid]`,
 *                                `subscription_data[metadata][rid]`,
 *                                `subscription_data[trial_period_days]`,
 *                                `payment_method_collection=always` (a card is
 *                                required even for a trial), `success_url`,
 *                                `cancel_url`, `expires_at` (30 min to 24 h),
 *                                `automatic_tax[enabled]`, `customer_update[address]=auto`
 *                                (required with automatic tax and an existing
 *                                customer). Returns `id` (`cs_…`), `url`, `status`
 *                                ∈ open | complete | expired.
 *   GET  /v1/checkout/sessions/{id}   `url` is null unless `status` is `open`.
 *   GET  /v1/customers?email=&limit=1 `data[]`; POST /v1/customers `email`.
 *                                Stripe does NOT enforce unique emails: the
 *                                lookup-then-create is the dedupe.
 *   GET  /v1/prices/{id}         `unit_amount` (minor units), `currency`.
 *   POST /v1/tax/calculations    `currency`, `line_items[0][amount]`,
 *                                `line_items[0][tax_behavior]=exclusive`,
 *                                `customer_details[address][country]`,
 *                                `customer_details[address_source]=billing`;
 *                                returns `amount_total`, `tax_amount_exclusive`.
 *                                Fails when Stripe Tax is not enabled — best effort.
 *   Subscription object          `id`, `status` ∈ trialing | active | past_due |
 *                                unpaid | canceled | incomplete | incomplete_expired |
 *                                paused, `customer`, `items.data[0].{id, price.id}`,
 *                                `trial_start`, `trial_end`, `current_period_start`,
 *                                `current_period_end` (on the item in api versions
 *                                from 2025-03-31 — both places are read),
 *                                `cancel_at_period_end`, `cancel_at`, `canceled_at`
 *                                (set when a cancellation is merely SCHEDULED, so
 *                                it is only reported once the status is canceled),
 *                                `ended_at`, `pause_collection { behavior, resumes_at }`,
 *                                `metadata`, `currency`. Timestamps are unix seconds.
 *   DELETE /v1/subscriptions/{id}          cancels immediately.
 *   POST /v1/subscriptions/{id}            `cancel_at_period_end=true`;
 *                                `pause_collection[behavior]=void` +
 *                                `pause_collection[resumes_at]` (invoices during
 *                                the pause are voided; the paid period runs on,
 *                                which is `next_billing_period` semantics);
 *                                `items[0][id]` + `items[0][price]` +
 *                                `proration_behavior` ∈ create_prorations | none.
 *   POST /v1/billing_portal/sessions  `customer`, `return_url`, optional
 *                                `flow_data[type]` ∈ payment_method_update |
 *                                subscription_cancel (+ `flow_data[subscription_cancel]
 *                                [subscription]`); returns `url`. The portal must
 *                                be configured once in the dashboard (live mode
 *                                needs a saved configuration).
 *   Invoice object               `id` (`in_…`), `customer`, `customer_email`,
 *                                `subscription` (or `parent.subscription_details.
 *                                subscription` from 2025-03-31), `subscription_details.
 *                                metadata` (copied from the subscription; or
 *                                `parent.subscription_details.metadata`),
 *                                `amount_paid`, `total`, `currency`, `billing_reason`,
 *                                `total_tax_amounts[]` (or `total_taxes[]`),
 *                                `lines.data[0].{period.start, period.end, price.id}`
 *                                (or `pricing.price_details.price`).
 *   Charge object                `id`, `amount_refunded`, `currency`, `invoice`,
 *                                `customer`. No subscription id: enrichEvent()
 *                                looks it up through the invoice.
 *   Dispute object               `id`, `charge`, `amount`, `currency`.
 *   Webhooks                     body `{ id (evt_…), type, created, livemode,
 *                                data { object, previous_attributes? } }`.
 *   Signature                    header `Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]`;
 *                                signed payload is `t + "." + raw_body`;
 *                                HMAC-SHA256 with the endpoint's `whsec_…` secret
 *                                used as-is. Tolerance 300 s (design §6.2).
 *
 * `live` comes from the event's own `livemode`, and for API-originated state
 * from the key prefix (`sk_live_` / `rk_live_`). The §6.1 gate means
 * MOR_SANDBOX must agree with the key: `true` with a test key, `false` live.
 *
 * Nothing here logs an email, a session id, a subscription id or a customer id.
 */

import {
  ProviderError,
  bytesToHex,
  headerGetter,
  isoOrNull,
  moneyFromMinor,
  normalizeEvent,
  planForPriceId,
  priceIdFor as sharedPriceIdFor,
  reasonForStatus,
  reservationIdFrom,
} from './index.js';
import { hmacSha256, timingSafeEqual } from '../crypto.js';

const LIVE_BASE = 'https://api.stripe.com';
const DEFAULT_SITE_ORIGIN = 'https://helpmebreath.com';

/** Pinned so every API response has the shape the normalisers below read. */
export const API_VERSION = '2024-06-20';

/** Tolerance for the Stripe-Signature timestamp, seconds (design §6.2). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** The request header that carries the webhook signature (case-insensitive). */
export const SIGNATURE_HEADER = 'stripe-signature';

/** The card-required trial, in days. The same number as PLANS.trialDays in js/config.js. */
export const TRIAL_PERIOD_DAYS = 3;

/** A Checkout Session outlives the 30-minute reservation by one minute. Stripe's floor is 30 minutes. */
export const CHECKOUT_SESSION_TTL_SECONDS = 31 * 60;

/** Portal links are single-use and short-lived; /account asks again after this. */
export const PORTAL_SESSION_TTL_SECONDS = 300;

/** Stripe event type -> normalised type. Anything absent is `ignore`. */
export const EVENT_MAP = Object.freeze({
  'customer.subscription.created': 'sub.created',
  // Refined by previous_attributes in refineUpdate(): trialing -> active is
  // sub.activated, a pause_collection appearing is sub.paused, and so on.
  'customer.subscription.updated': 'sub.updated',
  'customer.subscription.deleted': 'sub.canceled',
  'customer.subscription.paused': 'sub.paused',
  'customer.subscription.resumed': 'sub.resumed',
  // invoice.paid, not invoice.payment_succeeded: both fire for a card payment,
  // and one of them has to be the record.
  'invoice.paid': 'txn.completed',
  'invoice.payment_failed': 'txn.failed',
  'charge.refunded': 'txn.refunded',
  'charge.dispute.created': 'txn.chargeback',
});

/** Stripe subscription status -> ours (design §6.4). `null` means "not a state we track yet". */
export const STATUS_MAP = Object.freeze({
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  paused: 'paused',
  canceled: 'canceled',
  incomplete_expired: 'canceled',
  incomplete: null,
});

/* ----------------------------------------------------------- credentials -- */

/**
 * True for a test-mode secret or restricted key.
 * @param {string} apiKey
 * @returns {boolean}
 */
export function isTestKey(apiKey) {
  return /^(sk|rk)_test_/i.test(String(apiKey || ''));
}

/**
 * Whether this deployment's credentials are live. API-originated state carries
 * this as its `live` flag; webhook events carry Stripe's own `livemode`.
 * @param {Record<string,string>} env
 * @returns {boolean}
 */
export function credentialsAreLive(env) {
  return !isTestKey(env && env.MOR_API_KEY);
}

/**
 * The API base. MOR_API_BASE overrides it, which is how the test suite points
 * the adapter at a stub. Stripe has one host for test and live keys.
 * @param {Record<string,string>} env
 * @returns {string}
 */
export function baseUrlFor(env) {
  const override = ((env && env.MOR_API_BASE) || '').trim();
  return override ? override.replace(/\/+$/, '') : LIVE_BASE;
}

function siteOrigin(env) {
  const origin = String((env && env.SITE_ORIGIN) || '').trim().replace(/\/+$/, '');
  return /^https:\/\//i.test(origin) ? origin : DEFAULT_SITE_ORIGIN;
}

/* --------------------------------------------------------------- request -- */

/**
 * Flatten a plain object into Stripe's bracket-notation form body:
 * `{ line_items: [{ price: 'x' }] }` -> `line_items[0][price]=x`.
 * `null` and `undefined` are skipped; an empty string is sent (it is how a
 * field such as `pause_collection` is cleared).
 *
 * @param {object} body
 * @returns {string}
 */
export function encodeForm(body) {
  const pairs = [];
  const walk = (value, prefix) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${prefix}[${index}]`));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, prefix ? `${prefix}[${key}]` : key);
      return;
    }
    pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  };
  walk(body || {}, '');
  return pairs.join('&');
}

/**
 * `/v1/subscriptions/sub_123?x=1` -> `/v1/subscriptions/{id}`: the shape of a
 * call for an error message, with no identifier in it.
 * @param {string} path
 * @returns {string}
 */
export function describePath(path) {
  const clean = String(path || '').split('?')[0];
  const parts = clean.split('/').filter(Boolean);
  return '/' + parts.map((part, i) => (i >= 2 && /[_0-9]/.test(part) ? '{id}' : part)).join('/');
}

/**
 * One Stripe API call. Throws ProviderError on any non-2xx or network failure;
 * returns the parsed JSON body.
 *
 * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
 * @param {string} path e.g. `/v1/customers`
 * @param {{method?:string, body?:object, idempotencyKey?:string}} [init]
 * @returns {Promise<any>}
 */
export async function stripeRequest(ctx, path, init = {}) {
  const fetchImpl = (ctx && ctx.fetchImpl) || globalThis.fetch;
  const env = (ctx && ctx.env) || {};
  const apiKey = String(env.MOR_API_KEY || '').trim();
  if (!apiKey) throw new ProviderError('unauthorized', { status: 401, message: 'MOR_API_KEY is not set.' });
  const method = (init.method || 'GET').toUpperCase();
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Stripe-Version': API_VERSION,
  };
  let body;
  if (init.body !== undefined && method !== 'GET') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = encodeForm(init.body);
  }
  if (init.idempotencyKey) headers['Idempotency-Key'] = String(init.idempotencyKey);

  let response;
  try {
    response = await fetchImpl(`${baseUrlFor(env)}${path}`, {
      method,
      headers,
      body,
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
    });
  } catch (error) {
    throw new ProviderError('provider_unavailable', { message: 'Stripe could not be reached.', cause: error });
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const err = data && data.error && typeof data.error === 'object' ? data.error : {};
    throw new ProviderError(reasonForStatus(response.status), {
      status: response.status,
      code: err.code || err.type || null,
      // The resource, never the id: `/v1/subscriptions/{id}`.
      message: `Stripe ${method} ${describePath(path)} answered ${response.status}${err.code ? ` (${err.code})` : ''}.`,
      cause: err,
    });
  }
  return data;
}

/* ----------------------------------------------------------- normalisers -- */

function idOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value.id) return String(value.id);
  return null;
}

/** Unix seconds -> ISO 8601, or null. */
export function isoFromUnix(seconds) {
  if (seconds == null || seconds === '') return null;
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function unixFromIso(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function firstItem(sub) {
  const items = sub && sub.items && Array.isArray(sub.items.data) ? sub.items.data : [];
  return items[0] || null;
}

function subscriptionPriceId(sub) {
  const item = firstItem(sub);
  if (!item) return null;
  return idOf(item.price) || idOf(item.plan) || null;
}

/**
 * Our status for a Stripe subscription. A subscription with a `pause_collection`
 * is paused for us whatever Stripe calls it: nothing is charged and access
 * runs to the end of the paid period (design §6.5).
 * @param {object} sub
 * @returns {string|null}
 */
export function statusFor(sub) {
  const s = sub || {};
  const mapped = Object.prototype.hasOwnProperty.call(STATUS_MAP, s.status) ? STATUS_MAP[s.status] : null;
  if (mapped === 'active' && s.pause_collection) return 'paused';
  return mapped;
}

/**
 * Normalise a Stripe subscription object into the event shape (design §6.2).
 * @param {object} sub
 * @param {{type?:string, id?:string, occurredAt?:string, providerEventType?:string, live?:boolean, env?:object}} extra
 * @returns {object}
 */
export function normalizeSubscription(sub, extra = {}) {
  const s = sub || {};
  const item = firstItem(s);
  const priceId = subscriptionPriceId(s);
  const plan = planForPriceId(priceId, extra.env || {});
  const status = statusFor(s);
  const periodStart = s.current_period_start != null ? s.current_period_start : item && item.current_period_start;
  const periodEnd = s.current_period_end != null ? s.current_period_end : item && item.current_period_end;
  const pause = s.pause_collection && typeof s.pause_collection === 'object' ? s.pause_collection : null;
  const cancelScheduled = Boolean(s.cancel_at_period_end || s.cancel_at) && status !== 'canceled';
  let scheduledChange = null;
  if (cancelScheduled) {
    scheduledChange = { action: 'cancel', effectiveAt: isoFromUnix(s.cancel_at) || isoFromUnix(periodEnd), resumeAt: null };
  } else if (pause) {
    scheduledChange = { action: 'pause', effectiveAt: isoFromUnix(periodEnd), resumeAt: isoFromUnix(pause.resumes_at) };
  }
  const metadata = s.metadata && typeof s.metadata === 'object' ? s.metadata : null;
  return normalizeEvent({
    id: extra.id || null,
    type: status == null ? 'ignore' : extra.type || 'sub.updated',
    providerEventType: extra.providerEventType || null,
    occurredAt: isoOrNull(extra.occurredAt) || isoFromUnix(s.created) || null,
    live: typeof extra.live === 'boolean' ? extra.live : null,
    reservationId: reservationIdFrom(metadata),
    customDataUserIdSeen: Boolean(metadata && metadata.user_id != null),
    providerSubscriptionId: s.id || null,
    providerCustomerId: idOf(s.customer),
    providerPriceId: priceId,
    providerTransactionId: idOf(s.latest_invoice),
    customerEmail: null,
    status,
    plan: plan ? plan.plan : null,
    hadTrial: s.trial_end != null || s.trial_start != null || status === 'trialing',
    trialStartsAt: isoFromUnix(s.trial_start),
    trialEndsAt: isoFromUnix(s.trial_end),
    currentPeriodStart: isoFromUnix(periodStart),
    currentPeriodEnd: isoFromUnix(periodEnd),
    nextBilledAt: status === 'canceled' || cancelScheduled || pause ? null : isoFromUnix(periodEnd),
    // Stripe sets canceled_at the moment a cancellation is SCHEDULED, so it is
    // only a cancellation date once the status says so.
    canceledAt: status === 'canceled' ? isoFromUnix(s.canceled_at) || isoFromUnix(s.ended_at) : null,
    pausedAt: null, // the store stamps paused_at when the status turns paused
    scheduledChange,
    amount: null, // money is taken from invoice.paid only (design §5.6)
    currency: s.currency ? String(s.currency).toUpperCase() : null,
    taxInclusive: null,
    totalIsZero: null,
  });
}

function invoiceSubscriptionId(inv) {
  const direct = idOf(inv.subscription);
  if (direct) return direct;
  const parent = inv.parent && inv.parent.subscription_details;
  return parent ? idOf(parent.subscription) : null;
}

function invoiceMetadata(inv) {
  const details = inv.subscription_details && typeof inv.subscription_details === 'object' ? inv.subscription_details : null;
  if (details && details.metadata && typeof details.metadata === 'object') return details.metadata;
  const parent = inv.parent && inv.parent.subscription_details;
  if (parent && parent.metadata && typeof parent.metadata === 'object') return parent.metadata;
  return null;
}

function invoiceLine(inv) {
  const lines = inv.lines && Array.isArray(inv.lines.data) ? inv.lines.data : [];
  return lines[0] || null;
}

function invoicePriceId(inv) {
  const line = invoiceLine(inv);
  if (!line) return null;
  const pricing = line.pricing && line.pricing.price_details;
  return idOf(line.price) || (pricing && idOf(pricing.price)) || idOf(line.plan) || null;
}

function invoiceTaxMinor(inv) {
  const lists = [inv.total_tax_amounts, inv.total_taxes].filter(Array.isArray);
  for (const list of lists) {
    let sum = 0;
    for (const row of list) sum += Number((row && row.amount) || 0) || 0;
    if (list.length > 0) return sum;
  }
  return Number(inv.tax || 0) || 0;
}

/**
 * Normalise a Stripe invoice into the event shape (`txn.completed` / `txn.failed`).
 * @param {object} inv
 * @param {{type?:string, id?:string, occurredAt?:string, providerEventType?:string, live?:boolean, env?:object}} extra
 * @returns {object}
 */
export function normalizeInvoice(inv, extra = {}) {
  const i = inv || {};
  const currency = i.currency ? String(i.currency).toUpperCase() : null;
  const paidMinor = i.amount_paid != null ? i.amount_paid : i.total;
  const amount = moneyFromMinor(paidMinor, currency);
  const priceId = invoicePriceId(i);
  const plan = planForPriceId(priceId, extra.env || {});
  const line = invoiceLine(i);
  const period = line && line.period && typeof line.period === 'object' ? line.period : null;
  const metadata = invoiceMetadata(i);
  return normalizeEvent({
    id: extra.id || null,
    type: extra.type || 'txn.completed',
    providerEventType: extra.providerEventType || null,
    occurredAt: isoOrNull(extra.occurredAt) || isoFromUnix(i.created) || null,
    live: typeof extra.live === 'boolean' ? extra.live : null,
    reservationId: reservationIdFrom(metadata),
    customDataUserIdSeen: Boolean(metadata && metadata.user_id != null),
    providerSubscriptionId: invoiceSubscriptionId(i),
    providerCustomerId: idOf(i.customer),
    providerPriceId: priceId,
    providerTransactionId: i.id || null,
    customerEmail: i.customer_email || null,
    status: null,
    plan: plan ? plan.plan : null,
    hadTrial: null,
    trialStartsAt: null,
    trialEndsAt: null,
    currentPeriodStart: isoFromUnix(period && period.start),
    currentPeriodEnd: isoFromUnix(period && period.end),
    nextBilledAt: undefined,
    canceledAt: null,
    pausedAt: null,
    scheduledChange: null,
    amount,
    currency,
    taxInclusive: amount == null ? null : invoiceTaxMinor(i) > 0,
    totalIsZero: amount == null ? null : Number(paidMinor) === 0,
  });
}

/**
 * A refunded charge or a dispute. Neither object carries the subscription id;
 * `enrichEvent()` resolves it through the invoice before applyEvent runs.
 * @param {object} obj a charge or a dispute
 * @param {{type:string, id?:string, occurredAt?:string, providerEventType?:string, live?:boolean}} extra
 * @returns {object}
 */
export function normalizeChargeEvent(obj, extra) {
  const o = obj || {};
  const currency = o.currency ? String(o.currency).toUpperCase() : null;
  const minor = extra.type === 'txn.refunded' ? o.amount_refunded : o.amount;
  const amount = moneyFromMinor(minor, currency);
  return normalizeEvent({
    id: extra.id || null,
    type: extra.type,
    providerEventType: extra.providerEventType || null,
    occurredAt: isoOrNull(extra.occurredAt) || isoFromUnix(o.created) || null,
    live: typeof extra.live === 'boolean' ? extra.live : null,
    providerSubscriptionId: null,
    providerCustomerId: idOf(o.customer),
    // A charge names its invoice; a dispute names its charge. enrichEvent()
    // follows whichever it is back to the subscription.
    providerTransactionId: idOf(o.invoice) || idOf(o.charge) || o.id || null,
    customerEmail: (o.billing_details && o.billing_details.email) || null,
    amount,
    currency,
    taxInclusive: null,
    totalIsZero: amount == null ? null : Number(minor) === 0,
  });
}

/**
 * Turn a `customer.subscription.updated` into the specific event it is, from
 * what changed (`previous_attributes`).
 * @param {object} sub the subscription as it is now
 * @param {object} prev `data.previous_attributes`
 * @returns {string} normalised type
 */
export function refineUpdate(sub, prev) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const now = statusFor(sub);
  if (now === 'canceled') return 'sub.canceled';
  const hadPause = Object.prototype.hasOwnProperty.call(p, 'pause_collection');
  if (hadPause && !p.pause_collection && sub.pause_collection) return 'sub.paused';
  if (hadPause && p.pause_collection && !sub.pause_collection) return 'sub.resumed';
  if (now === 'past_due') return 'sub.past_due';
  if (now === 'paused') return p.status && p.status !== 'paused' ? 'sub.paused' : 'sub.updated';
  if (now === 'active' && p.status && p.status !== 'active') return 'sub.activated';
  if (now === 'trialing' && p.status && p.status !== 'trialing') return 'sub.trialing';
  return 'sub.updated';
}

/* ------------------------------------------------------------- signature -- */

/**
 * `t=<unix>,v1=<hex>[,v1=<hex>]` -> { t, v1[] }. Unknown schemes are ignored.
 * @param {string|null} header
 * @returns {{t:string|null, v1:string[]}}
 */
export function parseStripeSignature(header) {
  const out = { t: null, v1: [] };
  for (const part of String(header || '').split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && !out.t) out.t = value;
    else if (key === 'v1' && value) out.v1.push(value);
  }
  return out;
}

/* ---------------------------------------------------------------- price ---- */

function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}

/* --------------------------------------------------------------- adapter -- */

export const stripeProvider = {
  id: 'stripe',

  /**
   * The trial is a property of the Checkout Session (`trial_period_days`), not
   * of the price, so MOR_PRICE_*_TRIAL is optional: api/trial/eligibility.js
   * reads this flag before requiring those variables.
   */
  separateTrialPrices: false,

  // ------------------------------------------------------------ checkout --

  /**
   * The env price id for (plan, trial). When no separate trial price is
   * configured the paid price is used for both — the session carries the trial.
   * @param {{plan:string, trial?:boolean}} input
   * @param {Record<string,string>} env
   * @returns {string}
   */
  priceIdFor(input, env) {
    if (input && input.trial) {
      try {
        return sharedPriceIdFor(input, env);
      } catch {
        return sharedPriceIdFor({ plan: input.plan, trial: false }, env);
      }
    }
    return sharedPriceIdFor(input, env);
  },

  /**
   * Resolve or create the Stripe customer for an email. Stripe allows several
   * customers with one email, so the lookup comes first and is the dedupe;
   * `existed` is the layer-6 signal (design §5.4 step 9).
   *
   * @param {string} email
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<{id:string, existed:boolean}>}
   */
  async ensureCustomer(email, ctx) {
    const address = String(email || '').trim();
    if (!address) throw new ProviderError('bad_request', { message: 'ensureCustomer: email is required.' });
    const found = await stripeRequest(ctx, `/v1/customers?email=${encodeURIComponent(address)}&limit=1`);
    const rows = found && Array.isArray(found.data) ? found.data : [];
    const hit = rows.find((c) => c && c.id && !c.deleted);
    if (hit) return { id: String(hit.id), existed: true };
    const created = await stripeRequest(ctx, '/v1/customers', { method: 'POST', body: { email: address } });
    if (!created || !created.id) throw new ProviderError('provider_error', { message: 'Stripe POST /v1/customers returned no id.' });
    return { id: String(created.id), existed: false };
  },

  /**
   * Create the Checkout Session server-side. The browser is handed the
   * session's URL and nothing else: the price, the customer, the trial and the
   * reservation id are fixed here (design §5.5). Tax is asked for on every
   * session; when Stripe Tax is not enabled on the account the session is
   * created without it and the fact is logged, so checkout never dies on a
   * dashboard setting.
   *
   * @param {{priceId:string, customerId?:string|null, customData?:object, trial?:boolean}} input
   * @param {{env:Record<string,string>, fetchImpl?:Function, now?:number}} ctx
   * @returns {Promise<{transactionId:string, status:string|null, checkoutUrl:string|null}>}
   */
  async createCheckoutSession(input, ctx) {
    const priceId = String((input && input.priceId) || '').trim();
    if (!priceId) throw new ProviderError('bad_request', { message: 'createCheckoutSession: priceId is required.' });
    const env = (ctx && ctx.env) || {};
    const origin = siteOrigin(env);
    const custom = input.customData && typeof input.customData === 'object' ? input.customData : {};
    const rid = typeof custom.rid === 'string' ? custom.rid : null;
    const metadata = {};
    for (const [key, value] of Object.entries(custom)) if (value != null) metadata[key] = String(value);
    const nowMs = Number.isFinite(ctx && ctx.now) ? ctx.now : Date.now();
    const trial = input.trial === true;

    const body = {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer: input.customerId ? String(input.customerId) : undefined,
      client_reference_id: rid || undefined,
      metadata: Object.keys(metadata).length ? metadata : undefined,
      subscription_data: {
        metadata: Object.keys(metadata).length ? metadata : undefined,
        trial_period_days: trial ? TRIAL_PERIOD_DAYS : undefined,
      },
      payment_method_collection: 'always',
      success_url: `${origin}/pro/thanks${rid ? `?rid=${encodeURIComponent(rid)}` : ''}`,
      cancel_url: `${origin}/pro?checkout=cancelled`,
      expires_at: Math.floor(nowMs / 1000) + CHECKOUT_SESSION_TTL_SECONDS,
      automatic_tax: { enabled: true },
      customer_update: input.customerId ? { address: 'auto', name: 'auto' } : undefined,
    };

    let session;
    try {
      session = await stripeRequest(ctx, '/v1/checkout/sessions', { method: 'POST', body, idempotencyKey: rid ? `hmb-cs-${rid}` : undefined });
    } catch (error) {
      if (!(error instanceof ProviderError) || error.status !== 400 || !/tax/i.test(String((error.cause && error.cause.message) || ''))) throw error;
      // Stripe Tax is not switched on for this account: sell without automatic
      // tax rather than not at all, and say so in the log.
      console.warn('[stripe] automatic tax refused by the account; session created without it');
      delete body.automatic_tax;
      delete body.customer_update;
      session = await stripeRequest(ctx, '/v1/checkout/sessions', { method: 'POST', body, idempotencyKey: rid ? `hmb-cs-${rid}-notax` : undefined });
    }
    if (!session || !session.id) throw new ProviderError('provider_error', { message: 'Stripe POST /v1/checkout/sessions returned no id.' });
    return { transactionId: String(session.id), status: session.status || null, checkoutUrl: session.url || null };
  },

  /**
   * The URL of an existing session, or null once it is no longer open. Lets
   * the eligibility endpoint hand a retrying buyer the same session back.
   * @param {string} sessionId
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<string|null>}
   */
  async checkoutUrlFor(sessionId, ctx) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    const session = await stripeRequest(ctx, `/v1/checkout/sessions/${encodeURIComponent(id)}`);
    return session && session.status === 'open' && session.url ? String(session.url) : null;
  },

  /**
   * The price as configured, plus tax for the visitor's country when Stripe
   * Tax is enabled (design §5.6). Without Tax the list price comes back with
   * `taxInclusive: false`, which the page shows as "plus any tax".
   *
   * @param {{priceId:string, countryCode?:string|null}} input
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<{amount:string, currency:string, taxInclusive:boolean, formatted:string|null}>}
   */
  async pricePreview(input, ctx) {
    const priceId = String((input && input.priceId) || '').trim();
    if (!priceId) throw new ProviderError('bad_request', { message: 'pricePreview: priceId is required.' });
    const price = await stripeRequest(ctx, `/v1/prices/${encodeURIComponent(priceId)}`);
    const currency = price && price.currency ? String(price.currency).toUpperCase() : null;
    const unit = price && price.unit_amount != null ? price.unit_amount : null;
    const base = moneyFromMinor(unit, currency);
    if (base == null || !currency) throw new ProviderError('provider_error', { message: 'Stripe price has no unit amount.' });

    const country = String((input && input.countryCode) || '').toUpperCase().slice(0, 2);
    if (/^[A-Z]{2}$/.test(country)) {
      try {
        const calc = await stripeRequest(ctx, '/v1/tax/calculations', {
          method: 'POST',
          body: {
            currency: currency.toLowerCase(),
            line_items: [{ amount: unit, reference: priceId, tax_behavior: 'exclusive' }],
            customer_details: { address: { country }, address_source: 'billing' },
          },
        });
        const total = moneyFromMinor(calc && calc.amount_total, currency);
        const tax = Number(calc && calc.tax_amount_exclusive) || 0;
        if (total != null) return { amount: total, currency, taxInclusive: tax > 0, formatted: formatMoney(total, currency) };
      } catch {
        // Stripe Tax not enabled, or the country unsupported: the list price stands.
      }
    }
    return { amount: base, currency, taxInclusive: false, formatted: formatMoney(base, currency) };
  },

  // ------------------------------------------------------------ webhooks --

  /**
   * Verify `Stripe-Signature` over the EXACT raw body (design §6.2).
   * @param {string} raw
   * @param {Headers|Record<string,string>} headers
   * @param {string} secret MOR_WEBHOOK_SECRET (`whsec_…`)
   * @param {{now?:number}} [options]
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async verifyWebhook(raw, headers, secret, options = {}) {
    if (!secret) return { ok: false, reason: 'no_secret' };
    if (typeof raw !== 'string') return { ok: false, reason: 'raw_body_required' };
    const get = headerGetter(headers);
    const { t, v1 } = parseStripeSignature(get(SIGNATURE_HEADER));
    if (!t || v1.length === 0) return { ok: false, reason: 'missing_signature' };
    const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
    const age = Math.abs(nowMs / 1000 - Number(t));
    if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: 'stale_timestamp' };
    const expected = bytesToHex(await hmacSha256(secret, `${t}.${raw}`));
    for (const candidate of v1) {
      if (timingSafeEqual(expected, candidate.toLowerCase())) return { ok: true };
    }
    return { ok: false, reason: 'bad_signature' };
  },

  /**
   * One Stripe event -> one normalised event. Unknown types come back as
   * `ignore` so they are still recorded, never dropped silently.
   * @param {string} raw the exact body
   * @param {{env?:Record<string,string>}} [ctx]
   * @returns {object[]}
   */
  parseEvents(raw, ctx = {}) {
    let body;
    try {
      body = JSON.parse(String(raw));
    } catch {
      throw new ProviderError('bad_request', { message: 'Webhook body is not JSON.' });
    }
    if (!body || typeof body !== 'object') throw new ProviderError('bad_request', { message: 'Webhook body is not an object.' });
    if (!body.id) throw new ProviderError('bad_request', { message: 'Webhook has no id.' });
    const env = (ctx && ctx.env) || {};
    const providerEventType = String(body.type || '');
    let type = EVENT_MAP[providerEventType] || 'ignore';
    const object = body.data && body.data.object && typeof body.data.object === 'object' ? body.data.object : {};
    if (providerEventType === 'customer.subscription.updated') type = refineUpdate(object, body.data.previous_attributes);
    const extra = {
      id: String(body.id),
      type,
      providerEventType,
      occurredAt: isoFromUnix(body.created),
      live: typeof body.livemode === 'boolean' ? body.livemode : null,
      env,
    };
    let event;
    if (type === 'ignore') event = normalizeEvent({ ...extra, type: 'ignore' });
    else if (type.startsWith('sub.')) event = normalizeSubscription(object, extra);
    else if (type === 'txn.completed' || type === 'txn.failed') event = normalizeInvoice(object, extra);
    else event = normalizeChargeEvent(object, extra);
    // The whole event, as delivered, is what webhook_events.payload keeps and
    // what api/cron/reconcile.js feeds back through parseEvents() to re-drive
    // a failed row.
    event.payload = body;
    return [event];
  },

  /**
   * A refund or a dispute names a charge, never a subscription. Resolve the
   * subscription through the invoice before applyEvent runs. Throws when the
   * lookup fails so the event is marked failed and retried, not ignored.
   * @param {object} event normalised
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<object>} the same event, or a copy with the ids filled in
   */
  async enrichEvent(event, ctx) {
    if (!event || event.providerSubscriptionId) return event;
    if (event.type !== 'txn.refunded' && event.type !== 'txn.chargeback') return event;
    let ref = event.providerTransactionId ? String(event.providerTransactionId) : '';
    if (!ref) return event;
    if (/^(ch|py)_/.test(ref)) {
      const charge = await stripeRequest(ctx, `/v1/charges/${encodeURIComponent(ref)}`);
      ref = idOf(charge && charge.invoice) || '';
      if (!ref) return event; // a one-off charge: nothing of ours to note
    }
    if (!/^in_/.test(ref)) return event;
    const invoice = await stripeRequest(ctx, `/v1/invoices/${encodeURIComponent(ref)}`);
    const subscriptionId = invoiceSubscriptionId(invoice || {});
    if (!subscriptionId) return event;
    return {
      ...event,
      providerSubscriptionId: subscriptionId,
      providerCustomerId: event.providerCustomerId || idOf(invoice.customer),
      providerTransactionId: ref,
      reservationId: event.reservationId || reservationIdFrom(invoiceMetadata(invoice)),
    };
  },

  // ---------------------------------------------------------- management --

  /**
   * @param {string} subscriptionId
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<object>} normalised state, `type: 'sub.updated'`
   */
  async getSubscription(subscriptionId, ctx) {
    const sub = await stripeRequest(ctx, `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
    return normalizeSubscription(sub, { type: 'sub.updated', providerEventType: 'api.get', live: credentialsAreLive(ctx.env), env: ctx.env });
  },

  /**
   * `effectiveFrom` is REQUIRED — every caller states it (design §5.9).
   * @param {string} subscriptionId
   * @param {{effectiveFrom:'next_billing_period'|'immediately'}} options
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<object>} normalised state
   */
  async cancelSubscription(subscriptionId, options, ctx) {
    const effectiveFrom = options && options.effectiveFrom;
    if (effectiveFrom !== 'next_billing_period' && effectiveFrom !== 'immediately') {
      throw new ProviderError('bad_request', { message: 'cancelSubscription: effectiveFrom must be passed explicitly.' });
    }
    const path = `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`;
    const sub =
      effectiveFrom === 'immediately'
        ? await stripeRequest(ctx, path, { method: 'DELETE' })
        : await stripeRequest(ctx, path, { method: 'POST', body: { cancel_at_period_end: true } });
    return normalizeSubscription(sub, { type: 'sub.updated', providerEventType: 'api.cancel', live: credentialsAreLive(ctx.env), env: ctx.env });
  },

  /**
   * Stripe's `pause_collection` voids every invoice until `resumes_at`; the
   * period already paid for runs on. That is `next_billing_period`, and it is
   * the only value Stripe offers, so `immediately` is honoured the same way.
   * @param {string} subscriptionId
   * @param {{resumeAt:string, effectiveFrom:'next_billing_period'|'immediately'}} options
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<object>} normalised state
   */
  async pauseSubscription(subscriptionId, options, ctx) {
    const effectiveFrom = options && options.effectiveFrom;
    if (effectiveFrom !== 'next_billing_period' && effectiveFrom !== 'immediately') {
      throw new ProviderError('bad_request', { message: 'pauseSubscription: effectiveFrom must be passed explicitly.' });
    }
    const resumeAt = isoOrNull(options && options.resumeAt);
    if (!resumeAt) throw new ProviderError('bad_request', { message: 'pauseSubscription: resumeAt must be an RFC 3339 datetime.' });
    const sub = await stripeRequest(ctx, `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'POST',
      body: { pause_collection: { behavior: 'void', resumes_at: unixFromIso(resumeAt) } },
    });
    return normalizeSubscription(sub, { type: 'sub.updated', providerEventType: 'api.pause', live: credentialsAreLive(ctx.env), env: ctx.env });
  },

  /**
   * Swap the single item for another price. Stripe needs the item id, so the
   * subscription is read first. `proration_behavior` is always stated.
   * @param {string} subscriptionId
   * @param {string} priceId
   * @param {{prorate:boolean}} options
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<object>} normalised state
   */
  async changePlan(subscriptionId, priceId, options, ctx) {
    const target = String(priceId || '').trim();
    if (!target) throw new ProviderError('bad_request', { message: 'changePlan: priceId is required.' });
    const path = `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`;
    const current = await stripeRequest(ctx, path);
    const item = firstItem(current);
    if (!item || !item.id) throw new ProviderError('provider_error', { message: 'Stripe subscription has no item to change.' });
    const sub = await stripeRequest(ctx, path, {
      method: 'POST',
      body: {
        items: [{ id: String(item.id), price: target }],
        proration_behavior: options && options.prorate ? 'create_prorations' : 'none',
      },
    });
    return normalizeSubscription(sub, { type: 'sub.updated', providerEventType: 'api.update', live: credentialsAreLive(ctx.env), env: ctx.env });
  },

  /**
   * Mint customer-portal links. Three sessions, one per link, because a flow
   * is fixed at creation; a flow the portal configuration does not allow falls
   * back to the overview. Never cache the result.
   * @param {string} customerId
   * @param {string[]} subscriptionIds
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<{overview:string|null, cancel:string|null, update_payment_method:string|null, expires_in:number}>}
   */
  async createPortalSession(customerId, subscriptionIds, ctx) {
    const id = String(customerId || '').trim();
    if (!id) throw new ProviderError('bad_request', { message: 'createPortalSession: customerId is required.' });
    const ids = (Array.isArray(subscriptionIds) ? subscriptionIds : []).filter(Boolean).map(String);
    const returnUrl = `${siteOrigin(ctx && ctx.env)}/account`;
    const mint = (flow) =>
      stripeRequest(ctx, '/v1/billing_portal/sessions', { method: 'POST', body: { customer: id, return_url: returnUrl, flow_data: flow } }).then((s) => (s && s.url ? String(s.url) : null));
    const overview = await mint(undefined);
    const optional = async (flow) => {
      try {
        return await mint(flow);
      } catch {
        return null;
      }
    };
    const [update, cancel] = await Promise.all([
      optional({ type: 'payment_method_update' }),
      ids[0] ? optional({ type: 'subscription_cancel', subscription_cancel: { subscription: ids[0] } }) : Promise.resolve(null),
    ]);
    return {
      overview,
      cancel: cancel || overview,
      update_payment_method: update || overview,
      expires_in: PORTAL_SESSION_TTL_SECONDS,
    };
  },
};

export default stripeProvider;
