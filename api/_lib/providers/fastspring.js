/**
 * api/_lib/providers/fastspring.js — FastSpring adapter (the hedge if the primary
 * merchant of record declines the owner).
 *
 * Adapter contract v3: see api/_lib/providers/index.js. FastSpring is the hedge,
 * not the plan (design §10.3), so this adapter is complete but built against
 * documentation only; every note marked SANDBOX-CONFIRM below must be checked
 * against a real FastSpring test account before this rail ever goes primary.
 *
 * Verified against developer.fastspring.com on 2026-09-11 (exact field names relied on):
 *
 *   Webhooks                 body `{ events: [ { id, type, live, processed, created, data } ] }`.
 *                            `id`: "A unique identifier for the event"; `live`: whether the
 *                            event came from live or test orders; `created`: milliseconds.
 *                            "Automatic retries carry identical event IDs; manual retries
 *                            generate new ones." "Build your handler to deduplicate by event ID."
 *   Signature                "The resulting digest will be encoded to base64 and included in
 *                            the X-FS-Signature header of the webhook." HMAC-SHA256 over the
 *                            raw body with the secret. (reference/message-security)
 *   subscription.activated   "This webhook only fires when a customer starts a new subscription,
 *                            including new trials. It does not fire on rebills." data: `id`,
 *                            `active`, `state` (active | overdue | deactivated | trial | canceled),
 *                            `live`, `currency`, `account.id`, `account.contact.email`,
 *                            `product` (path), `begin`, `end`, `next` (ms), `nextChargeDate`,
 *                            `nextChargeTotal`, `subtotal` ("before taxes"), `quantity`, `autoRenew`.
 *   subscription.charge.completed  "It does not fire for the initial purchase; instead, we
 *                            send `completed` and `activated` webhooks." data: `order { id,
 *                            reference, total, currency, live }`, `subscription { id, state, … }`,
 *                            `account`. `total` is post-tax.
 *   subscription.canceled    "when a customer cancels a subscription via the customer portal";
 *                            data: `active`, `state: canceled`, `canceledDate`, `deactivationDate`
 *                            — "the subscription may still be active until deactivationDate".
 *                            => a SCHEDULED cancel. Never revoke on it (design §10.3).
 *   subscription.deactivated "when a subscription deactivates. This occurs at the end of the
 *                            billing period following a cancellation." data: `active: false`,
 *                            `state: deactivated`, `deactivationDate` (ms). => the hard revoke.
 *   subscription.payment.overdue  `state: overdue`.
 *   GET /subscriptions/{id}  `id`, `active`, `state`, `changed` (ms), `live`, `currency`,
 *                            `account`, `product`, `quantity`, `autoRenew`, `price`,
 *                            `priceDisplay`, `subtotal`, `nextChargeDate`.
 *   DELETE /subscriptions/{id}?billingPeriod=0|1   `0`: "Cancels the subscription
 *                            immediately"; `1` (default): "Cancels the subscription at the end
 *                            of the current billing period". Response `subscriptions[] {
 *                            subscription, action, result }`, result "success".
 *   POST /subscriptions/{id}/pause   body `{ pausePeriodCount }` (integer, required).
 *                            "The subscription pauses on the next billing cycle."
 *   POST /subscriptions      body `{ subscriptions: [ { subscription, product, quantity,
 *                            prorate } ] }`; response `subscriptions[] { subscription, action,
 *                            result, proration? }`.
 *   POST /v2/checkouts/{checkoutPath}/sessions   body `customer.accountId`,
 *                            `cart.lineItems[] { productPath, quantity }`, `orderTags`,
 *                            `country`, `live`; response `id`, `expires`,
 *                            `checkoutUrls.webcheckoutUrl`, `checkoutStatus`.
 *                            "Everything needed to launch the buyer into checkout —
 *                            including the session ID — is returned directly in this
 *                            response." (This is newer than design §10.3's "no equivalent";
 *                            SANDBOX-CONFIRM that the storefront path in MOR_STOREFRONT is
 *                            the `checkoutPath` this endpoint wants.)
 *   GET /accounts?email=…    "Only return accounts with the given email address."
 *   POST /accounts           body `contact { first, last, email }` (all required),
 *                            `language`, `country`; response `account` (the id), `result`.
 *   GET /accounts/{id}/authenticate  response `accounts[] { url, account, result, action }`,
 *                            plus an `expires` timestamp.
 *   Authentication           HTTP Basic, "Encode your username and password using Base64".
 *
 * Money: FastSpring sends decimal numbers (10.0), not minor units — moneyFromDecimal().
 * Time: milliseconds since epoch — isoFromMillis().
 *
 * WHAT CANNOT BE HAD HERE (design §10.3): a session tag is order-level and appears in
 * no subscription payload, so `reservationId` is best-effort (read from
 * `data.tags.rid` when present) and the §6.3 resolution ladder falls back to the
 * account id and the email. The unconditional trial-price check at sub.created is
 * therefore the ONLY trial-lock enforcement on this rail, which is why it is
 * unconditional.
 *
 * Nothing here logs an email, an order id, a subscription id or an account id.
 */

import {
  ProviderError,
  headerGetter,
  isoFromMillis,
  isoOrNull,
  moneyFromDecimal,
  normalizeEvent,
  planForPriceId,
  priceIdFor as sharedPriceIdFor,
  reasonForStatus,
  reservationIdFrom,
  sandboxMode,
} from './index.js';
import { base64Encode, hmacSha256, timingSafeEqual } from '../crypto.js';

const BASE = 'https://api.fastspring.com';

/** The request header that carries the webhook signature (case-insensitive). */
export const SIGNATURE_HEADER = 'x-fs-signature';

/** Portal links: how long /account may hold one before asking again. FastSpring returns its own `expires`. */
export const PORTAL_SESSION_TTL_SECONDS = 900;

/** FastSpring event type -> normalised type. Anything absent is `ignore`. */
export const EVENT_MAP = Object.freeze({
  'subscription.activated': 'sub.created',
  'subscription.updated': 'sub.updated',
  'subscription.payment.overdue': 'sub.past_due',
  'subscription.paused': 'sub.paused',
  'subscription.resumed': 'sub.resumed',
  // A SCHEDULED cancel: the subscription is still active until deactivationDate.
  'subscription.canceled': 'sub.updated',
  'subscription.deactivated': 'sub.canceled',
  'subscription.charge.completed': 'txn.completed',
  'subscription.charge.failed': 'txn.failed',
  'order.completed': 'txn.completed',
  'return.created': 'txn.refunded',
});

/** FastSpring subscription `state` -> our status enum. */
export const STATE_MAP = Object.freeze({
  trial: 'trialing',
  active: 'active',
  overdue: 'past_due',
  paused: 'paused',
  canceled: 'canceled',
  deactivated: 'canceled',
});

/**
 * Build the Basic auth header.
 *
 * MOR_API_KEY holds `username:password`. MOR_API_USERNAME / MOR_API_PASSWORD are
 * honoured too, for owners who prefer two variables.
 *
 * @param {Record<string,string>} env
 * @returns {string}
 */
export function basicAuthHeader(env) {
  const user = ((env && env.MOR_API_USERNAME) || '').trim();
  const pass = ((env && env.MOR_API_PASSWORD) || '').trim();
  const pair = user || pass ? `${user}:${pass}` : String((env && env.MOR_API_KEY) || '').trim();
  return `Basic ${base64Encode(pair)}`;
}

/**
 * @param {Record<string,string>} env
 * @returns {string}
 */
export function baseUrlFor(env) {
  const override = ((env && env.MOR_API_BASE) || '').trim();
  return override ? override.replace(/\/+$/, '') : BASE;
}

/**
 * The `checkoutPath` for POST /v2/checkouts/{checkoutPath}/sessions, taken from
 * MOR_STOREFRONT (design §10.2: "FastSpring only: the popup checkout URL").
 * A full URL is reduced to its last path segment; a bare path is used as is.
 * @param {Record<string,string>} env
 * @returns {string} '' when unset
 */
export function checkoutPathFor(env) {
  const raw = String((env && env.MOR_STOREFRONT) || '').trim();
  if (!raw) return '';
  const noQuery = raw.split('?')[0].split('#')[0].replace(/\/+$/, '');
  const segments = noQuery.split('/').filter(Boolean);
  if (segments.length === 0) return '';
  const last = segments[segments.length - 1];
  // "store.onfastspring.com" alone: the storefront is the host, use its first label.
  if (segments.length === 1 && last.includes('.')) return last.split('.')[0];
  return last;
}

/**
 * One FastSpring API call. Throws ProviderError on any non-2xx or network
 * failure; returns the parsed body.
 *
 * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
 * @param {string} path
 * @param {{method?:string, body?:object}} [init]
 * @returns {Promise<any>}
 */
export async function fastspringRequest(ctx, path, init = {}) {
  const fetchImpl = (ctx && ctx.fetchImpl) || globalThis.fetch;
  const env = (ctx && ctx.env) || {};
  const url = `${baseUrlFor(env)}${path}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: init.method || 'GET',
      headers: {
        Authorization: basicAuthHeader(env),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'helpmebreath/1.0 (+https://helpmebreath.com)',
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
    throw new ProviderError(reasonForStatus(response.status), {
      status: response.status,
      code: body && typeof body.error === 'string' ? body.error : null,
      message: `FastSpring ${init.method || 'GET'} ${path.split('?')[0].replace(/\/[^/]{8,}(?=\/|$)/g, '/{id}')} -> ${response.status}`,
    });
  }
  return body;
}

/**
 * FastSpring sometimes returns a single object and sometimes a one-element array.
 * @param {unknown} body
 * @returns {object|null}
 */
export function firstRecord(body) {
  if (Array.isArray(body)) return body.length > 0 && body[0] && typeof body[0] === 'object' ? body[0] : null;
  if (body && typeof body === 'object') return body;
  return null;
}

/**
 * The account id and email out of a subscription/order payload, whichever
 * shape FastSpring used: a bare id string, or an expanded `{ id, contact: { email } }`.
 * @param {unknown} account
 * @returns {{id:string|null, email:string|null}}
 */
export function accountRef(account) {
  if (typeof account === 'string') return { id: account || null, email: null };
  if (!account || typeof account !== 'object') return { id: null, email: null };
  const id = account.id || account.account || null;
  const email = account.contact && typeof account.contact === 'object' && typeof account.contact.email === 'string' ? account.contact.email : null;
  return { id: id ? String(id) : null, email };
}

/**
 * Our status for a FastSpring subscription payload. A `canceled` state with
 * `active: true` is a scheduled cancel and stays `active` here; the hard
 * revoke arrives as `deactivated`.
 * @param {object} sub
 * @returns {string|null}
 */
export function statusFor(sub) {
  const state = String((sub && sub.state) || '').toLowerCase();
  if (state === 'canceled' && sub && sub.active === true) return 'active';
  return STATE_MAP[state] || null;
}

/**
 * Normalise a FastSpring subscription payload (webhook data or GET /subscriptions/{id}).
 * @param {object} sub
 * @param {{type?:string, id?:string, occurredAt?:string, providerEventType?:string, live?:boolean, env?:object, payload?:object}} extra
 * @returns {object}
 */
export function normalizeSubscription(sub, extra = {}) {
  const s = sub || {};
  const product = typeof s.product === 'string' ? s.product : s.product && s.product.path ? String(s.product.path) : null;
  const plan = planForPriceId(product, extra.env || {});
  const status = statusFor(s);
  const account = accountRef(s.account);
  const tags = s.tags && typeof s.tags === 'object' ? s.tags : null;
  const deactivation = isoFromMillis(s.deactivationDate);
  const isTrial = String(s.state || '').toLowerCase() === 'trial';
  const begin = isoFromMillis(s.begin);
  const next = isoFromMillis(s.next) || isoFromMillis(s.nextChargeDate) || isoOrNull(s.nextChargeDate);
  const scheduledCancel = String(s.state || '').toLowerCase() === 'canceled' && s.active === true;
  const pauseScheduled = s.isPauseScheduled === true || s.paused === true;
  let scheduledChange = null;
  if (scheduledCancel) scheduledChange = { action: 'cancel', effectiveAt: deactivation || next, resumeAt: null };
  else if (pauseScheduled) scheduledChange = { action: 'pause', effectiveAt: isoFromMillis(s.pauseDate), resumeAt: isoFromMillis(s.resumeDate) };
  return normalizeEvent({
    id: extra.id || null,
    type: extra.type || 'sub.updated',
    providerEventType: extra.providerEventType || null,
    occurredAt: isoOrNull(extra.occurredAt) || isoFromMillis(s.changed) || null,
    live: typeof extra.live === 'boolean' ? extra.live : typeof s.live === 'boolean' ? s.live : null,
    reservationId: reservationIdFrom(tags),
    customDataUserIdSeen: Boolean(tags && tags.user_id != null),
    providerSubscriptionId: s.id || s.subscription || null,
    providerCustomerId: account.id,
    providerPriceId: product,
    providerTransactionId: null,
    customerEmail: account.email,
    status,
    plan: plan ? plan.plan : null,
    hadTrial: Boolean(isTrial || (plan && plan.trial)),
    trialStartsAt: isTrial ? begin : null,
    trialEndsAt: isTrial ? next : null,
    currentPeriodStart: isTrial ? null : begin,
    currentPeriodEnd: isTrial ? null : next,
    nextBilledAt: next,
    canceledAt: isoFromMillis(s.canceledDate) || (status === 'canceled' ? deactivation : null),
    pausedAt: isoFromMillis(s.pauseDate),
    scheduledChange,
    amount: null, // money is taken from the charge/order payloads only (design §5.6)
    currency: s.currency || null,
    taxInclusive: null,
    totalIsZero: null,
    payload: extra.payload || null,
  });
}

/**
 * Normalise a charge/order payload (subscription.charge.completed, order.completed,
 * return.created) into the event shape.
 * @param {object} data
 * @param {{type?:string, id?:string, occurredAt?:string, providerEventType?:string, live?:boolean, env?:object, payload?:object}} extra
 * @returns {object}
 */
export function normalizeCharge(data, extra = {}) {
  const d = data || {};
  const order = d.order && typeof d.order === 'object' ? d.order : d;
  const sub = d.subscription && typeof d.subscription === 'object' ? d.subscription : null;
  const items = Array.isArray(order.items) ? order.items : [];
  const subscriptionId =
    (sub && (sub.id || sub.subscription)) ||
    (typeof d.subscription === 'string' ? d.subscription : null) ||
    items.map((it) => (it && typeof it.subscription === 'string' ? it.subscription : null)).find(Boolean) ||
    null;
  const product =
    (sub && typeof sub.product === 'string' ? sub.product : null) ||
    items.map((it) => (it && typeof it.product === 'string' ? it.product : null)).find(Boolean) ||
    null;
  const plan = planForPriceId(product, extra.env || {});
  const currency = order.currency || (sub && sub.currency) || null;
  const amount = moneyFromDecimal(order.total, currency);
  const tax = moneyFromDecimal(order.tax, currency);
  const account = accountRef(d.account || order.account || (sub && sub.account));
  const tags = order.tags && typeof order.tags === 'object' ? order.tags : null;
  return normalizeEvent({
    id: extra.id || null,
    type: extra.type || 'ignore',
    providerEventType: extra.providerEventType || null,
    occurredAt: isoOrNull(extra.occurredAt) || isoFromMillis(order.changed) || null,
    live: typeof extra.live === 'boolean' ? extra.live : typeof order.live === 'boolean' ? order.live : null,
    reservationId: reservationIdFrom(tags),
    customDataUserIdSeen: Boolean(tags && tags.user_id != null),
    providerSubscriptionId: subscriptionId,
    providerCustomerId: account.id,
    providerPriceId: product,
    providerTransactionId: order.id || order.reference || null,
    customerEmail: account.email,
    status: sub ? statusFor(sub) : null,
    plan: plan ? plan.plan : null,
    hadTrial: plan ? plan.trial : null,
    currentPeriodStart: sub ? isoFromMillis(sub.begin) : null,
    currentPeriodEnd: sub ? isoFromMillis(sub.next) : null,
    amount,
    currency,
    taxInclusive: amount == null ? null : Boolean(tax && Number(tax) > 0),
    totalIsZero: amount == null ? null : Number(amount) === 0,
    payload: extra.payload || null,
  });
}

/**
 * Turn the `subscriptions[]` answer of a write into a verdict.
 * @param {unknown} body
 * @returns {{ok:boolean, action:string|null}}
 */
export function writeResult(body) {
  const list = body && Array.isArray(body.subscriptions) ? body.subscriptions : [];
  const first = list[0] || null;
  if (!first) return { ok: false, action: null };
  return { ok: String(first.result || '').toLowerCase() === 'success', action: first.action || null };
}

/**
 * Number of billing periods between now and `resumeAt`, at least 1.
 * @param {string} resumeAt ISO datetime
 * @param {number} nowMs
 * @param {'month'|'year'} unit
 * @returns {number}
 */
export function periodsUntil(resumeAt, nowMs, unit = 'month') {
  const target = Date.parse(resumeAt);
  if (!Number.isFinite(target)) return 1;
  const days = (target - nowMs) / (24 * 60 * 60 * 1000);
  const per = unit === 'year' ? 365.25 : 30.4375;
  return Math.max(1, Math.round(days / per));
}

export const fastspringProvider = {
  id: 'fastspring',

  // ------------------------------------------------------------ checkout --

  /**
   * @param {{plan:string, trial?:boolean}} input
   * @param {Record<string,string>} env
   * @returns {string} a product path
   */
  priceIdFor(input, env) {
    return sharedPriceIdFor(input, env);
  },

  /**
   * Resolve or create the FastSpring account for an email. Lookup first
   * (GET /accounts?email=), create when absent (POST /accounts). An existing
   * account is the layer-6 soft signal (design §5.3).
   *
   * SANDBOX-CONFIRM: `contact.first`/`last` are required by the schema; the
   * placeholders below are overwritten by whatever the buyer types at checkout.
   *
   * @param {string} email
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<{id:string, existed:boolean}>}
   */
  async ensureCustomer(email, ctx) {
    const address = String(email || '').trim();
    if (!address) throw new ProviderError('bad_request', { message: 'ensureCustomer: email is required.' });
    const found = await fastspringRequest(ctx, `/accounts?email=${encodeURIComponent(address)}`);
    const list = found && Array.isArray(found.accounts) ? found.accounts : [];
    for (const entry of list) {
      const ref = accountRef(entry);
      if (ref.id) return { id: ref.id, existed: true };
    }
    const created = await fastspringRequest(ctx, '/accounts', {
      method: 'POST',
      body: { contact: { first: 'Help Me Breathe', last: 'Subscriber', email: address } },
    });
    const id = created && (created.account || created.id);
    if (!id) throw new ProviderError('provider_error', { message: 'FastSpring POST /accounts returned no account id.' });
    return { id: String(id), existed: false };
  },

  /**
   * Create the checkout session server-side so the price is fixed before the
   * buyer sees anything (design §5.5). `transactionId` is the session id; the
   * page may also redirect to `checkoutUrl`.
   *
   * @param {{priceId:string, customerId?:string|null, customData?:object, countryCode?:string|null}} input
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<{transactionId:string, status:string|null, checkoutUrl:string|null}>}
   */
  async createCheckoutSession(input, ctx) {
    const productPath = String((input && input.priceId) || '').trim();
    if (!productPath) throw new ProviderError('bad_request', { message: 'createCheckoutSession: priceId is required.' });
    const env = (ctx && ctx.env) || {};
    const checkoutPath = checkoutPathFor(env);
    if (!checkoutPath) throw new ProviderError('bad_request', { message: 'createCheckoutSession: MOR_STOREFRONT is not set.' });
    const body = {
      cart: { lineItems: [{ productPath, quantity: 1 }] },
      // MOR_SANDBOX=true -> a test session; anything else -> live (design §10.2).
      live: !sandboxMode(env),
    };
    if (input.customerId) body.customer = { accountId: String(input.customerId) };
    if (input.customData && typeof input.customData === 'object') body.orderTags = input.customData;
    if (input.countryCode) body.country = String(input.countryCode).toUpperCase();
    const session = await fastspringRequest(ctx, `/v2/checkouts/${encodeURIComponent(checkoutPath)}/sessions`, { method: 'POST', body });
    if (!session || !session.id) throw new ProviderError('provider_error', { message: 'FastSpring session returned no id.' });
    return {
      transactionId: String(session.id),
      status: session.checkoutStatus || null,
      checkoutUrl: (session.checkoutUrls && session.checkoutUrls.webcheckoutUrl) || null,
    };
  },

  /**
   * Localised price for one product path via GET /products/price/{path}.
   * SANDBOX-CONFIRM the response shape: `products[0].pricing[<currency>] { price, display, tax? }`.
   *
   * @param {{priceId:string, countryCode?:string|null, currencyCode?:string|null}} input
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<{amount:string, currency:string, taxInclusive:boolean, formatted:string|null}>}
   */
  async pricePreview(input, ctx) {
    const productPath = String((input && input.priceId) || '').trim();
    if (!productPath) throw new ProviderError('bad_request', { message: 'pricePreview: priceId is required.' });
    const query = [];
    if (input.countryCode) query.push(`country=${encodeURIComponent(String(input.countryCode).toUpperCase())}`);
    if (input.currencyCode) query.push(`currency=${encodeURIComponent(String(input.currencyCode).toUpperCase())}`);
    const body = await fastspringRequest(ctx, `/products/price/${encodeURIComponent(productPath)}${query.length ? `?${query.join('&')}` : ''}`);
    const product = body && Array.isArray(body.products) ? body.products[0] : firstRecord(body);
    const pricing = product && product.pricing && typeof product.pricing === 'object' ? product.pricing : null;
    if (!pricing) throw new ProviderError('provider_error', { message: 'FastSpring price lookup returned no pricing.' });
    const wanted = input.currencyCode ? String(input.currencyCode).toUpperCase() : null;
    const currency = wanted && pricing[wanted] ? wanted : Object.keys(pricing)[0];
    const entry = currency ? pricing[currency] : null;
    const amount = entry ? moneyFromDecimal(entry.price, currency) : null;
    if (amount == null || !currency) throw new ProviderError('provider_error', { message: 'FastSpring price lookup had no total.' });
    const tax = entry ? moneyFromDecimal(entry.tax, currency) : null;
    return {
      amount,
      currency,
      taxInclusive: Boolean(tax && Number(tax) > 0),
      formatted: entry && entry.display ? String(entry.display) : null,
    };
  },

  // ------------------------------------------------------------ webhooks --

  /**
   * `X-FS-Signature` = base64(HMAC-SHA256(secret, rawBody)). Same primitives as
   * the primary adapter, base64 instead of hex (design §10.3). The caller must
   * pass the body exactly as `request.text()` returned it.
   *
   * @param {string} raw
   * @param {Headers|Record<string,string>} headers
   * @param {string} secret MOR_WEBHOOK_SECRET
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async verifyWebhook(raw, headers, secret) {
    if (!secret) return { ok: false, reason: 'no_secret' };
    if (typeof raw !== 'string') return { ok: false, reason: 'raw_body_required' };
    const get = headerGetter(headers);
    const presented = String(get(SIGNATURE_HEADER) || '').trim();
    if (!presented) return { ok: false, reason: 'missing_signature' };
    const expected = base64Encode(await hmacSha256(secret, raw));
    // The repo's timingSafeEqual() length-checks first: a malformed header
    // returns false rather than throwing.
    if (!timingSafeEqual(expected, presented)) return { ok: false, reason: 'bad_signature' };
    return { ok: true };
  },

  /**
   * One delivery -> every event in `events[]`, in order, de-duplicated on id.
   * A handler that read `events[0]` would drop renewals (design §10.3).
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
    if (!body || typeof body !== 'object' || !Array.isArray(body.events)) {
      throw new ProviderError('bad_request', { message: 'Webhook body has no events[].' });
    }
    const env = (ctx && ctx.env) || {};
    const out = [];
    const seen = new Set();
    for (const ev of body.events) {
      if (!ev || typeof ev !== 'object' || !ev.id) continue;
      const id = String(ev.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const providerEventType = String(ev.type || '');
      const type = EVENT_MAP[providerEventType] || 'ignore';
      const extra = {
        id,
        type,
        providerEventType,
        occurredAt: isoFromMillis(ev.created),
        live: typeof ev.live === 'boolean' ? ev.live : null,
        env,
        // Stored per event so the reconcile cron can re-drive exactly one of a batch.
        payload: { events: [ev] },
      };
      const data = ev.data && typeof ev.data === 'object' ? ev.data : {};
      if (type === 'ignore') out.push(normalizeEvent({ ...extra, type: 'ignore' }));
      else if (type.startsWith('txn.')) out.push(normalizeCharge(data, extra));
      else out.push(normalizeSubscription(data, extra));
    }
    return out;
  },

  // ---------------------------------------------------------- management --

  /**
   * @param {string} subscriptionId
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<object>} normalised state, `type: 'sub.updated'`
   */
  async getSubscription(subscriptionId, ctx) {
    const body = await fastspringRequest(ctx, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    const sub = firstRecord(body && Array.isArray(body.subscriptions) ? body.subscriptions : body);
    if (!sub) throw new ProviderError('not_found', { status: 404, message: 'FastSpring subscription not found.' });
    return normalizeSubscription(sub, { type: 'sub.updated', providerEventType: 'api.get', env: ctx.env });
  },

  /**
   * DELETE /subscriptions/{id}?billingPeriod=0|1. `effectiveFrom` is REQUIRED
   * (design §5.9): `next_billing_period` -> 1, `immediately` -> 0.
   * @param {string} subscriptionId
   * @param {{effectiveFrom:'next_billing_period'|'immediately'}} options
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<object>} normalised state with `ok`
   */
  async cancelSubscription(subscriptionId, options, ctx) {
    const effectiveFrom = options && options.effectiveFrom;
    if (effectiveFrom !== 'next_billing_period' && effectiveFrom !== 'immediately') {
      throw new ProviderError('bad_request', { message: 'cancelSubscription: effectiveFrom must be passed explicitly.' });
    }
    const billingPeriod = effectiveFrom === 'immediately' ? 0 : 1;
    const body = await fastspringRequest(ctx, `/subscriptions/${encodeURIComponent(subscriptionId)}?billingPeriod=${billingPeriod}`, { method: 'DELETE' });
    const verdict = writeResult(body);
    if (!verdict.ok) throw new ProviderError('provider_error', { message: 'FastSpring did not confirm the cancellation.' });
    const state = await this.getSubscription(subscriptionId, ctx).catch(() => null);
    if (state) {
      if (billingPeriod === 0) state.status = 'canceled';
      else if (!state.scheduledChange) state.scheduledChange = { action: 'cancel', effectiveAt: state.currentPeriodEnd || state.nextBilledAt, resumeAt: null };
      return { ...state, ok: true };
    }
    // The write was confirmed but the read-back failed: report what we know.
    return {
      ...normalizeEvent({
        type: 'sub.updated',
        providerEventType: 'api.cancel',
        providerSubscriptionId: subscriptionId,
        status: billingPeriod === 0 ? 'canceled' : null,
        scheduledChange: billingPeriod === 0 ? null : { action: 'cancel', effectiveAt: null },
      }),
      ok: true,
    };
  },

  /**
   * POST /subscriptions/{id}/pause { pausePeriodCount }. FastSpring pauses on
   * the next billing cycle, which is exactly design §5.8's "access continues
   * to the end of the period already paid for"; `effectiveFrom` is accepted
   * for contract symmetry and must be `next_billing_period`.
   * @param {string} subscriptionId
   * @param {{resumeAt:string, effectiveFrom:'next_billing_period'|'immediately', periods?:number, unit?:'month'|'year'}} options
   * @param {{env:Record<string,string>, fetchImpl?:Function, now?:number}} ctx
   * @returns {Promise<object>} normalised state
   */
  async pauseSubscription(subscriptionId, options, ctx) {
    const effectiveFrom = options && options.effectiveFrom;
    if (effectiveFrom !== 'next_billing_period' && effectiveFrom !== 'immediately') {
      throw new ProviderError('bad_request', { message: 'pauseSubscription: effectiveFrom must be passed explicitly.' });
    }
    if (effectiveFrom !== 'next_billing_period') {
      throw new ProviderError('bad_request', { message: 'pauseSubscription: this rail only pauses at the next billing period.' });
    }
    const resumeAt = isoOrNull(options && options.resumeAt);
    if (!resumeAt) throw new ProviderError('bad_request', { message: 'pauseSubscription: resumeAt must be an RFC 3339 datetime.' });
    const nowMs = Number.isFinite(ctx && ctx.now) ? ctx.now : Date.now();
    const periods = Number.isInteger(options.periods) && options.periods > 0 ? options.periods : periodsUntil(resumeAt, nowMs, options.unit || 'month');
    const body = await fastspringRequest(ctx, `/subscriptions/${encodeURIComponent(subscriptionId)}/pause`, {
      method: 'POST',
      body: { pausePeriodCount: periods },
    });
    const sub = firstRecord(body && Array.isArray(body.subscriptions) ? body.subscriptions : body);
    const state = normalizeSubscription(sub || { id: subscriptionId }, { type: 'sub.updated', providerEventType: 'api.pause', env: ctx.env });
    if (!state.scheduledChange) state.scheduledChange = { action: 'pause', effectiveAt: state.currentPeriodEnd || state.nextBilledAt, resumeAt };
    return state;
  },

  /**
   * POST /subscriptions with the new product path.
   * @param {string} subscriptionId
   * @param {string} priceId a product path
   * @param {{prorate:boolean}} options
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<object>} normalised state
   */
  async changePlan(subscriptionId, priceId, options, ctx) {
    const product = String(priceId || '').trim();
    if (!product) throw new ProviderError('bad_request', { message: 'changePlan: priceId is required.' });
    const body = await fastspringRequest(ctx, '/subscriptions', {
      method: 'POST',
      body: { subscriptions: [{ subscription: subscriptionId, product, quantity: 1, prorate: Boolean(options && options.prorate) }] },
    });
    const verdict = writeResult(body);
    if (!verdict.ok) throw new ProviderError('provider_error', { message: 'FastSpring did not confirm the plan change.' });
    const state = await this.getSubscription(subscriptionId, ctx).catch(() => null);
    return state || normalizeEvent({ type: 'sub.updated', providerEventType: 'api.update', providerSubscriptionId: subscriptionId, providerPriceId: product });
  },

  /**
   * GET /accounts/{id}/authenticate -> one authenticated portal URL. FastSpring
   * has no per-subscription deep links; every link is the same portal.
   * @param {string} customerId the account id
   * @param {string[]} subscriptionIds unused on this rail
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<{overview:string|null, cancel:string|null, update_payment_method:string|null, expires_in:number}>}
   */
  async createPortalSession(customerId, subscriptionIds, ctx) {
    const id = String(customerId || '').trim();
    if (!id) throw new ProviderError('bad_request', { message: 'createPortalSession: customerId is required.' });
    const body = await fastspringRequest(ctx, `/accounts/${encodeURIComponent(id)}/authenticate`);
    const entry = firstRecord(body && Array.isArray(body.accounts) ? body.accounts : body);
    const url = entry && typeof entry.url === 'string' ? entry.url : null;
    if (!url) throw new ProviderError('provider_error', { message: 'FastSpring returned no portal url.' });
    let expiresIn = PORTAL_SESSION_TTL_SECONDS;
    const expires = Date.parse(String((entry && entry.expires) || (body && body.expires) || ''));
    if (Number.isFinite(expires)) expiresIn = Math.max(60, Math.min(PORTAL_SESSION_TTL_SECONDS, Math.floor((expires - Date.now()) / 1000)));
    return { overview: url, cancel: url, update_payment_method: url, expires_in: expiresIn };
  },
};

export default fastspringProvider;
