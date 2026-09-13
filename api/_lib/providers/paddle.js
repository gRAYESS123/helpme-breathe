/**
 * api/_lib/providers/paddle.js — Paddle Billing adapter (primary merchant of record).
 *
 * Adapter contract v3: see api/_lib/providers/index.js. Built against the
 * SANDBOX; the owner's Step 0 (design §14) gates go-live, not this code.
 *
 * Verified against developer.paddle.com on 2026-09-11 (exact field names relied on):
 *
 *   POST /transactions            body `items[] { price_id, quantity }`, `customer_id`,
 *                                 `custom_data`, `collection_mode`; 201 returns `data.id`
 *                                 (`txn_…`), `data.status` (`draft` | `ready` | …),
 *                                 `data.checkout.url`, `data.customer_id`.
 *                                 "Draft: Transaction is missing required fields …
 *                                 before customer details are captured." "Ready:
 *                                 Transaction has all of the required fields."
 *   POST /customers               body `email` (required), `name`, `custom_data`, `locale`;
 *                                 returns `data.id` (`ctm_…`). Duplicate email:
 *                                 HTTP 409, `error.code` = `customer_already_exists`,
 *                                 `error.detail` = "customer email conflicts with
 *                                 customer of id %s" — the existing id is in the detail.
 *   POST /pricing-preview         body `items[] { price_id, quantity }`, optional
 *                                 `address.country_code`, `customer_ip_address`,
 *                                 `currency_code`; returns `data.currency_code`,
 *                                 `data.details.line_items[] { price.tax_mode, totals
 *                                 { subtotal, discount, tax, total }, formatted_totals
 *                                 { … total } }`. `tax_mode` ∈ internal (inclusive) |
 *                                 external | account_setting | location.
 *   POST /subscriptions/{id}/cancel  body `effective_from` ∈ `next_billing_period`
 *                                 (default, creates `scheduled_change`) | `immediately`.
 *                                 "You can't reinstate a canceled subscription."
 *                                 Paused subscriptions cancel immediately by default.
 *   POST /subscriptions/{id}/pause   body `effective_from` (same values, default
 *                                 next_billing_period), `resume_at` (RFC 3339),
 *                                 `on_resume` ∈ continue_existing_billing_period |
 *                                 start_new_billing_period. Status stays `active`
 *                                 until the scheduled change takes effect.
 *   PATCH /subscriptions/{id}     body `items[] { price_id, quantity }`; "When making
 *                                 changes to items … you must include the
 *                                 `proration_billing_mode` field" ∈ prorated_immediately |
 *                                 prorated_next_billing_period | full_immediately |
 *                                 full_next_billing_period | do_not_bill.
 *                                 `scheduled_change: null` removes a scheduled change.
 *   POST /customers/{customer_id}/portal-sessions  body `subscription_ids[]`; returns
 *                                 `data.urls.general.overview`, `data.urls.subscriptions[]
 *                                 { id, cancel_subscription, update_subscription_payment_method }`.
 *                                 "Customer portal sessions are temporary and shouldn't be cached."
 *   GET /subscriptions/{id}       entity: `id`, `status` ∈ active | canceled | past_due |
 *                                 paused | trialing, `customer_id`, `currency_code`,
 *                                 `started_at`, `first_billed_at`, `next_billed_at`,
 *                                 `paused_at`, `canceled_at`, `current_billing_period
 *                                 { starts_at, ends_at }`, `scheduled_change { action,
 *                                 effective_at, resume_at }`, `items[] { status, quantity,
 *                                 trial_dates { starts_at, ends_at }, price { id,
 *                                 product_id, trial_period, unit_price { amount,
 *                                 currency_code }, tax_mode } }`, `custom_data`.
 *                                 `unit_price.amount` is "in the lowest denomination for
 *                                 the currency, e.g. 10 USD = 1000 (cents)".
 *   Webhooks                      body `{ event_id, event_type, occurred_at, notification_id,
 *                                 data }`. `event_id`: "Unique ID for this event, prefixed
 *                                 with `evt_`. Use this to deduplicate events you may
 *                                 receive more than once." `notification_id`: "Unique ID
 *                                 for this delivery attempt, prefixed with `ntf_`. Different
 *                                 from `event_id` because a single event can produce
 *                                 multiple notifications." `occurred_at`: "RFC 3339
 *                                 timestamp of when the event occurred. Use this to handle
 *                                 events that arrive out of order." "at-least-once
 *                                 delivery"; a non-200 (or no answer within five seconds)
 *                                 is retried with exponential backoff.
 *                                 (developer.paddle.com/webhooks/about/how-webhooks-work)
 *                                 NOTE: the subscription entity has NO `transaction_id`.
 *   Signature                     header `Paddle-Signature: ts=<unix>;h1=<hex>`; signed
 *                                 payload is `ts + ":" + raw_body`; HMAC-SHA256, hex.
 *                                 "Don't transform or process the raw body of the
 *                                 request". "During secret rotation, more than one `h1`
 *                                 is returned". SDK default tolerance is 5 s — we use
 *                                 300 s on purpose (design §6.2).
 *   transaction.completed         entity: `id`, `status`, `customer_id`, `subscription_id`,
 *                                 `currency_code`, `origin`, `custom_data`, `billing_period
 *                                 { starts_at, ends_at }`, `details.totals { subtotal, tax,
 *                                 total, grand_total, currency_code }` (lowest
 *                                 denomination strings), `items[].price.id`.
 *   adjustment.created/updated    entity: `action` ∈ credit | refund | chargeback |
 *                                 chargeback_reverse | chargeback_warning |
 *                                 chargeback_warning_reverse | credit_reverse; `status` ∈
 *                                 pending_approval | approved | rejected | reversed;
 *                                 `subscription_id`, `transaction_id`, `customer_id`,
 *                                 `totals { subtotal, tax, total, fee, retained_fee,
 *                                 earnings, currency_code }`. (Not in the §14 step 13
 *                                 subscription list; optional, see normalizeAdjustment.)
 *
 * The notification envelope carries no live/sandbox flag. Paddle's sandbox and
 * live accounts have separate credentials ("Sandbox and live accounts use
 * different credentials"), so `live` is derived from the API key prefix
 * (`pdl_sdbx_` / `pdl_live_`) of the account this deployment is configured
 * for. The §6.1 gate then means "MOR_SANDBOX must agree with the credentials",
 * which is exactly the go-live misconfiguration (§14 step 17) it exists to catch.
 *
 * Nothing here logs an email, a transaction id, a subscription id or a customer id.
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

const LIVE_BASE = 'https://api.paddle.com';
const SANDBOX_BASE = 'https://sandbox-api.paddle.com';

/** Tolerance for the Paddle-Signature timestamp, seconds. Wider than the SDK's 5 s on purpose (design §6.2). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** The request header that carries the webhook signature (case-insensitive). */
export const SIGNATURE_HEADER = 'paddle-signature';

/** Portal links are minted per request; this is how long /account may hold one before asking again. */
export const PORTAL_SESSION_TTL_SECONDS = 900;

/** Paddle event_type -> normalised type. Anything absent is `ignore`. */
export const EVENT_MAP = Object.freeze({
  'subscription.created': 'sub.created',
  'subscription.trialing': 'sub.trialing',
  'subscription.activated': 'sub.activated',
  'subscription.updated': 'sub.updated',
  'subscription.past_due': 'sub.past_due',
  'subscription.paused': 'sub.paused',
  'subscription.resumed': 'sub.resumed',
  'subscription.canceled': 'sub.canceled',
  'transaction.completed': 'txn.completed',
  'transaction.payment_failed': 'txn.failed',
  // Adjustments are refined by `data.action` in normalizeAdjustment(): a
  // chargeback (or its warning) -> txn.chargeback, a refund -> txn.refunded,
  // anything else -> ignore. Subscribe the destination to these two if the
  // owner wants dispute flags to arrive by webhook (design §13).
  'adjustment.created': 'txn.refunded',
  'adjustment.updated': 'txn.refunded',
});

/** Adjustment actions that open a dispute flag (design §13, chargeback row). */
const CHARGEBACK_ACTIONS = new Set(['chargeback', 'chargeback_warning']);

/** Adjustment statuses that mean the adjustment is not in force. */
const INERT_ADJUSTMENT_STATUSES = new Set(['rejected', 'reversed']);

const CUSTOMER_ID_RE = /ctm_[a-z0-9]{26}/i;

/**
 * True for a sandbox API key.
 * @param {string} apiKey
 * @returns {boolean}
 */
export function isSandboxKey(apiKey) {
  return /^pdl_sdbx_/i.test(String(apiKey || ''));
}

/**
 * The API base for the given key. MOR_API_BASE overrides both, which is how the
 * test suite points the adapter at a stub.
 * @param {Record<string,string>} env
 * @returns {string}
 */
export function baseUrlFor(env) {
  const override = ((env && env.MOR_API_BASE) || '').trim();
  if (override) return override.replace(/\/+$/, '');
  return isSandboxKey(env && env.MOR_API_KEY) ? SANDBOX_BASE : LIVE_BASE;
}

/**
 * Whether this deployment's credentials are live. Used as the event `live` flag
 * (see the file header for why).
 * @param {Record<string,string>} env
 * @returns {boolean}
 */
export function credentialsAreLive(env) {
  return !isSandboxKey(env && env.MOR_API_KEY);
}

/**
 * One Paddle API call. Throws ProviderError on any non-2xx or network failure;
 * returns `body.data`.
 *
 * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
 * @param {string} path
 * @param {{method?:string, body?:object}} [init]
 * @returns {Promise<any>}
 */
export async function paddleRequest(ctx, path, init = {}) {
  const fetchImpl = (ctx && ctx.fetchImpl) || globalThis.fetch;
  const env = (ctx && ctx.env) || {};
  const url = `${baseUrlFor(env)}${path}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: init.method || 'GET',
      headers: {
        Authorization: `Bearer ${env.MOR_API_KEY || ''}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (error) {
    throw new ProviderError('provider_unavailable', { cause: error });
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const err = (body && body.error) || {};
    throw new ProviderError(reasonForStatus(response.status), {
      status: response.status,
      code: err.code || null,
      // The detail may name a customer id; it is kept on the error for the
      // 409 path and must never be logged or echoed.
      message: `Paddle ${init.method || 'GET'} ${path.split('?')[0].replace(/\/[a-z]+_[a-z0-9]+/gi, '/{id}')} -> ${response.status}${err.code ? ` ${err.code}` : ''}`,
      cause: err.detail ? { detail: String(err.detail) } : undefined,
    });
  }
  return body && body.data !== undefined ? body.data : body;
}

/**
 * The first item of a subscription or transaction, preferring an active one.
 * @param {object} entity
 * @returns {object|null}
 */
function primaryItem(entity) {
  const items = Array.isArray(entity && entity.items) ? entity.items : [];
  return items.find((it) => it && it.status === 'active') || items[0] || null;
}

/**
 * Normalise a Paddle subscription entity into the event shape (design §6.2).
 * @param {object} sub
 * @param {{type?:string, id?:string, occurredAt?:string, providerEventType?:string, live?:boolean, env?:object}} extra
 * @returns {object}
 */
export function normalizeSubscription(sub, extra = {}) {
  const s = sub || {};
  const item = primaryItem(s);
  const price = item && item.price ? item.price : null;
  const priceId = (price && price.id) || (item && item.price_id) || null;
  const plan = planForPriceId(priceId, extra.env || {});
  const trialDates = item && item.trial_dates ? item.trial_dates : null;
  const hadTrial = Boolean(
    (trialDates && (trialDates.starts_at || trialDates.ends_at)) || (price && price.trial_period) || (plan && plan.trial),
  );
  const period = s.current_billing_period || null;
  const sc = s.scheduled_change || null;
  const customData = s.custom_data && typeof s.custom_data === 'object' ? s.custom_data : null;
  return normalizeEvent({
    id: extra.id || null,
    type: extra.type || 'sub.updated',
    providerEventType: extra.providerEventType || null,
    occurredAt: isoOrNull(extra.occurredAt) || isoOrNull(s.updated_at) || null,
    live: typeof extra.live === 'boolean' ? extra.live : null,
    reservationId: reservationIdFrom(customData),
    customDataUserIdSeen: Boolean(customData && customData.user_id != null),
    providerSubscriptionId: s.id || null,
    providerCustomerId: s.customer_id || null,
    providerPriceId: priceId,
    providerTransactionId: null, // the subscription entity carries no transaction id
    customerEmail: null, // the subscription entity carries no email
    status: s.status || null,
    plan: plan ? plan.plan : null,
    hadTrial,
    trialStartsAt: isoOrNull(trialDates && trialDates.starts_at),
    trialEndsAt: isoOrNull(trialDates && trialDates.ends_at),
    currentPeriodStart: isoOrNull(period && period.starts_at),
    currentPeriodEnd: isoOrNull(period && period.ends_at),
    nextBilledAt: isoOrNull(s.next_billed_at),
    canceledAt: isoOrNull(s.canceled_at),
    pausedAt: isoOrNull(s.paused_at),
    scheduledChange: sc && sc.action ? { action: sc.action, effectiveAt: isoOrNull(sc.effective_at), resumeAt: isoOrNull(sc.resume_at) } : null,
    amount: null, // money is taken from transaction.completed only (design §5.6)
    currency: s.currency_code || null,
    taxInclusive: null,
    totalIsZero: null,
  });
}

/**
 * Normalise a Paddle transaction entity into the event shape.
 * @param {object} txn
 * @param {{type?:string, id?:string, occurredAt?:string, providerEventType?:string, live?:boolean, env?:object}} extra
 * @returns {object}
 */
export function normalizeTransaction(txn, extra = {}) {
  const t = txn || {};
  const item = primaryItem(t);
  const price = item && item.price ? item.price : null;
  const priceId = (price && price.id) || (item && item.price_id) || null;
  const plan = planForPriceId(priceId, extra.env || {});
  const totals = (t.details && t.details.totals) || {};
  const currency = totals.currency_code || t.currency_code || null;
  const amount = moneyFromMinor(totals.total, currency);
  const tax = moneyFromMinor(totals.tax, currency);
  const period = t.billing_period || null;
  const customData = t.custom_data && typeof t.custom_data === 'object' ? t.custom_data : null;
  return normalizeEvent({
    id: extra.id || null,
    type: extra.type || 'ignore',
    providerEventType: extra.providerEventType || null,
    occurredAt: isoOrNull(extra.occurredAt) || isoOrNull(t.updated_at) || null,
    live: typeof extra.live === 'boolean' ? extra.live : null,
    reservationId: reservationIdFrom(customData),
    customDataUserIdSeen: Boolean(customData && customData.user_id != null),
    providerSubscriptionId: t.subscription_id || null,
    providerCustomerId: t.customer_id || null,
    providerPriceId: priceId,
    providerTransactionId: t.id || null,
    customerEmail: null,
    status: null,
    plan: plan ? plan.plan : null,
    hadTrial: plan ? plan.trial : null,
    currentPeriodStart: isoOrNull(period && period.starts_at),
    currentPeriodEnd: isoOrNull(period && period.ends_at),
    amount,
    currency,
    // `total` always includes whatever tax Paddle collected; the flag says
    // whether the displayed amount actually contains any.
    taxInclusive: amount == null ? null : Boolean(tax && Number(tax) > 0),
    totalIsZero: amount == null ? null : Number(amount) === 0,
  });
}

/**
 * Normalise a Paddle adjustment entity (adjustment.created / adjustment.updated)
 * into the event shape. Verified field names: `action` (credit | refund |
 * chargeback | chargeback_reverse | chargeback_warning |
 * chargeback_warning_reverse | credit_reverse), `status` (pending_approval |
 * approved | rejected | reversed), `subscription_id`, `transaction_id`,
 * `customer_id`, `totals { total, currency_code }`.
 *
 * Only an adjustment that is in force counts: a chargeback or chargeback
 * warning -> `txn.chargeback`; an approved refund -> `txn.refunded`; anything
 * else (a credit, a reversal, a rejected or still-pending refund) -> `ignore`.
 *
 * @param {object} adj
 * @param {{type?:string, id?:string, occurredAt?:string, providerEventType?:string, live?:boolean, env?:object}} extra
 * @returns {object}
 */
export function normalizeAdjustment(adj, extra = {}) {
  const a = adj || {};
  const action = String(a.action || '').toLowerCase();
  const status = String(a.status || '').toLowerCase();
  const inert = INERT_ADJUSTMENT_STATUSES.has(status);
  let type = 'ignore';
  if (!inert && CHARGEBACK_ACTIONS.has(action)) type = 'txn.chargeback';
  else if (!inert && action === 'refund' && status === 'approved') type = 'txn.refunded';
  const totals = a.totals || {};
  const currency = totals.currency_code || a.currency_code || null;
  const amount = moneyFromMinor(totals.total, currency);
  return normalizeEvent({
    id: extra.id || null,
    type,
    providerEventType: extra.providerEventType || null,
    occurredAt: isoOrNull(extra.occurredAt) || isoOrNull(a.updated_at) || isoOrNull(a.created_at) || null,
    live: typeof extra.live === 'boolean' ? extra.live : null,
    providerSubscriptionId: a.subscription_id || null,
    providerCustomerId: a.customer_id || null,
    providerTransactionId: a.transaction_id || null,
    amount,
    currency,
    totalIsZero: amount == null ? null : Number(amount) === 0,
  });
}

/**
 * Parse `Paddle-Signature: ts=…;h1=…[;h1=…]`. Several h1 values appear during
 * secret rotation, so h1 is always a list.
 * @param {string|null} header
 * @returns {{ts:string|null, h1:string[]}}
 */
export function parsePaddleSignature(header) {
  const out = { ts: null, h1: [] };
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 'ts') out.ts = value;
    else if (key === 'h1' && value) out.h1.push(value);
  }
  return out;
}

export const paddleProvider = {
  id: 'paddle',

  // ------------------------------------------------------------ checkout --

  /**
   * @param {{plan:string, trial?:boolean}} input
   * @param {Record<string,string>} env
   * @returns {string}
   */
  priceIdFor(input, env) {
    return sharedPriceIdFor(input, env);
  },

  /**
   * Resolve or create the Paddle customer for an email. Paddle enforces unique
   * customer emails and answers 409 `customer_already_exists` with the existing
   * id in `error.detail`; that is both the lookup and a free layer-6 signal
   * (design §5.4 step 9).
   *
   * @param {string} email
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<{id:string, existed:boolean}>}
   */
  async ensureCustomer(email, ctx) {
    const address = String(email || '').trim();
    if (!address) throw new ProviderError('bad_request', { message: 'ensureCustomer: email is required.' });
    try {
      const created = await paddleRequest(ctx, '/customers', { method: 'POST', body: { email: address } });
      if (!created || !created.id) throw new ProviderError('provider_error', { message: 'Paddle POST /customers returned no id.' });
      return { id: created.id, existed: false };
    } catch (error) {
      if (!(error instanceof ProviderError) || error.status !== 409) throw error;
      const detail = error.cause && error.cause.detail ? String(error.cause.detail) : '';
      const match = detail.match(CUSTOMER_ID_RE);
      if (match) return { id: match[0], existed: true };
      // Belt and braces: the detail format is documented but not contractual.
      const list = await paddleRequest(ctx, `/customers?email=${encodeURIComponent(address)}&status=active`);
      const rows = Array.isArray(list) ? list : [];
      const hit = rows.find((c) => c && c.id && String(c.email || '').toLowerCase() === address.toLowerCase()) || rows[0];
      if (hit && hit.id) return { id: hit.id, existed: true };
      throw new ProviderError('conflict', { status: 409, code: 'customer_already_exists', message: 'Paddle reports the customer exists but no id could be resolved.' });
    }
  },

  /**
   * Create the transaction server-side so the browser only ever carries a
   * `transactionId` (design §5.5). The price, the customer and the custom data
   * are fixed here, before the overlay exists.
   *
   * @param {{priceId:string, customerId?:string|null, customData?:object}} input
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<{transactionId:string, status:string|null, checkoutUrl:string|null}>}
   */
  async createCheckoutSession(input, ctx) {
    const priceId = String((input && input.priceId) || '').trim();
    if (!priceId) throw new ProviderError('bad_request', { message: 'createCheckoutSession: priceId is required.' });
    const body = {
      items: [{ price_id: priceId, quantity: 1 }],
      collection_mode: 'automatic',
    };
    if (input.customerId) body.customer_id = String(input.customerId);
    if (input.customData && typeof input.customData === 'object') body.custom_data = input.customData;
    const txn = await paddleRequest(ctx, '/transactions', { method: 'POST', body });
    if (!txn || !txn.id) throw new ProviderError('provider_error', { message: 'Paddle POST /transactions returned no id.' });
    return {
      transactionId: txn.id,
      status: txn.status || null,
      checkoutUrl: (txn.checkout && txn.checkout.url) || null,
    };
  },

  /**
   * Localised, tax-aware price for one price id (design §5.6). Returns the
   * line's `totals.total` (which includes any tax Paddle would collect) and
   * Paddle's own formatted string.
   *
   * @param {{priceId:string, countryCode?:string|null, postalCode?:string|null, customerIp?:string|null, currencyCode?:string|null}} input
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<{amount:string, currency:string, taxInclusive:boolean, formatted:string|null, taxMode:string|null}>}
   */
  async pricePreview(input, ctx) {
    const priceId = String((input && input.priceId) || '').trim();
    if (!priceId) throw new ProviderError('bad_request', { message: 'pricePreview: priceId is required.' });
    const body = { items: [{ price_id: priceId, quantity: 1 }] };
    if (input.countryCode) {
      body.address = { country_code: String(input.countryCode).toUpperCase() };
      if (input.postalCode) body.address.postal_code = String(input.postalCode);
    } else if (input.customerIp) {
      body.customer_ip_address = String(input.customerIp);
    }
    if (input.currencyCode) body.currency_code = String(input.currencyCode).toUpperCase();
    const preview = await paddleRequest(ctx, '/pricing-preview', { method: 'POST', body });
    const line = ((preview && preview.details && preview.details.line_items) || [])[0];
    if (!line) throw new ProviderError('provider_error', { message: 'Paddle pricing preview returned no line items.' });
    const currency = (preview && preview.currency_code) || null;
    const totals = line.totals || {};
    const amount = moneyFromMinor(totals.total, currency);
    const tax = moneyFromMinor(totals.tax, currency);
    if (amount == null || !currency) throw new ProviderError('provider_error', { message: 'Paddle pricing preview had no total.' });
    return {
      amount,
      currency,
      taxInclusive: Boolean(tax && Number(tax) > 0),
      formatted: (line.formatted_totals && line.formatted_totals.total) || null,
      taxMode: (line.price && line.price.tax_mode) || null,
    };
  },

  // ------------------------------------------------------------ webhooks --

  /**
   * Verify `Paddle-Signature` over the EXACT raw body (design §6.2). The
   * caller must pass the body as read by `request.text()`, untouched.
   *
   * @param {string} raw
   * @param {Headers|Record<string,string>} headers
   * @param {string} secret MOR_WEBHOOK_SECRET
   * @param {{now?:number}} [options]
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async verifyWebhook(raw, headers, secret, options = {}) {
    if (!secret) return { ok: false, reason: 'no_secret' };
    if (typeof raw !== 'string') return { ok: false, reason: 'raw_body_required' };
    const get = headerGetter(headers);
    const { ts, h1 } = parsePaddleSignature(get(SIGNATURE_HEADER));
    if (!ts || h1.length === 0) return { ok: false, reason: 'missing_signature' };

    // Wider than Paddle's 5-second SDK default ON PURPOSE: a cold-started Vercel
    // function plus network latency can exceed 5000 ms, and rejecting there just
    // makes Paddle retry into the same wall. Replay protection comes from the
    // event id in public.webhook_events, not from a stopwatch.
    const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
    const age = Math.abs(nowMs / 1000 - Number(ts));
    if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: 'stale_timestamp' };

    const expected = bytesToHex(await hmacSha256(secret, `${ts}:${raw}`));
    // The repo's timingSafeEqual() length-checks first, so a truncated or
    // malformed h1 returns false instead of throwing a 500 that Paddle retries.
    for (const candidate of h1) {
      if (timingSafeEqual(expected, candidate.toLowerCase())) return { ok: true };
    }
    return { ok: false, reason: 'bad_signature' };
  },

  /**
   * One Paddle notification -> one normalised event. Unknown event types come
   * back as `ignore` so they are still recorded, never dropped silently.
   *
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
    const env = (ctx && ctx.env) || {};
    const providerEventType = String(body.event_type || '');
    const type = EVENT_MAP[providerEventType] || 'ignore';
    const extra = {
      id: body.event_id || body.notification_id || null,
      type,
      providerEventType,
      occurredAt: body.occurred_at || null,
      live: credentialsAreLive(env),
      env,
    };
    if (!extra.id) throw new ProviderError('bad_request', { message: 'Webhook has no event_id.' });
    const data = body.data && typeof body.data === 'object' ? body.data : {};
    let event;
    if (providerEventType.startsWith('transaction.')) event = normalizeTransaction(data, extra);
    else if (providerEventType.startsWith('subscription.')) event = normalizeSubscription(data, extra);
    else if (providerEventType.startsWith('adjustment.')) event = normalizeAdjustment(data, extra);
    else event = normalizeEvent({ ...extra, type: 'ignore' });
    // The whole notification, as delivered, is what webhook_events.payload keeps
    // and what api/cron/reconcile.js feeds back through parseEvents() to re-drive
    // a failed row. One Paddle notification is one event, so it is stored whole.
    event.payload = body;
    return [event];
  },

  // ---------------------------------------------------------- management --

  /**
   * @param {string} subscriptionId
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<object>} normalised state, `type: 'sub.updated'`
   */
  async getSubscription(subscriptionId, ctx) {
    const sub = await paddleRequest(ctx, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
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
    const sub = await paddleRequest(ctx, `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
      method: 'POST',
      body: { effective_from: effectiveFrom },
    });
    return normalizeSubscription(sub, { type: 'sub.updated', providerEventType: 'api.cancel', live: credentialsAreLive(ctx.env), env: ctx.env });
  },

  /**
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
    const sub = await paddleRequest(ctx, `/subscriptions/${encodeURIComponent(subscriptionId)}/pause`, {
      method: 'POST',
      body: { effective_from: effectiveFrom, resume_at: resumeAt, on_resume: 'start_new_billing_period' },
    });
    return normalizeSubscription(sub, { type: 'sub.updated', providerEventType: 'api.pause', live: credentialsAreLive(ctx.env), env: ctx.env });
  },

  /**
   * Swap the single item for another catalogue price. `proration_billing_mode`
   * is required by Paddle whenever items change, and is always stated.
   * @param {string} subscriptionId
   * @param {string} priceId
   * @param {{prorate:boolean}} options
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<object>} normalised state
   */
  async changePlan(subscriptionId, priceId, options, ctx) {
    const target = String(priceId || '').trim();
    if (!target) throw new ProviderError('bad_request', { message: 'changePlan: priceId is required.' });
    const prorate = Boolean(options && options.prorate);
    const sub = await paddleRequest(ctx, `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'PATCH',
      body: {
        items: [{ price_id: target, quantity: 1 }],
        proration_billing_mode: prorate ? 'prorated_immediately' : 'full_next_billing_period',
      },
    });
    return normalizeSubscription(sub, { type: 'sub.updated', providerEventType: 'api.update', live: credentialsAreLive(ctx.env), env: ctx.env });
  },

  /**
   * Mint authenticated customer-portal links. Never cache the result.
   * @param {string} customerId
   * @param {string[]} subscriptionIds
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<{overview:string|null, cancel:string|null, update_payment_method:string|null, expires_in:number}>}
   */
  async createPortalSession(customerId, subscriptionIds, ctx) {
    const id = String(customerId || '').trim();
    if (!id) throw new ProviderError('bad_request', { message: 'createPortalSession: customerId is required.' });
    const ids = (Array.isArray(subscriptionIds) ? subscriptionIds : []).filter(Boolean).map(String);
    const session = await paddleRequest(ctx, `/customers/${encodeURIComponent(id)}/portal-sessions`, {
      method: 'POST',
      body: { subscription_ids: ids },
    });
    const urls = (session && session.urls) || {};
    const subs = Array.isArray(urls.subscriptions) ? urls.subscriptions : [];
    const first = subs.find((s) => s && ids.includes(s.id)) || subs[0] || {};
    return {
      overview: (urls.general && urls.general.overview) || null,
      cancel: first.cancel_subscription || null,
      update_payment_method: first.update_subscription_payment_method || null,
      expires_in: PORTAL_SESSION_TTL_SECONDS,
    };
  },
};

export default paddleProvider;
