/**
 * api/_lib/providers/index.js — the merchant-of-record seam.
 *
 * Swapping the merchant of record is a one-file change: write a new adapter next
 * to paddle.js / fastspring.js, add it to listProviders() below, and set
 * MOR_PROVIDER. Nothing outside this folder knows the name of a payment company
 * (docs/private/ACCOUNTS_BILLING_DESIGN.md §10.1; enforced by tools/site-check).
 *
 * The owner is a Lebanon-resident individual with no company. Paddle (a
 * merchant of record) was primary and FastSpring the hedge; on 2026-09-14
 * Paddle's identity verification stalled and the owner switched to Stripe,
 * which is NOT a merchant of record — see stripe.js for what that changes.
 *
 * ADAPTER CONTRACT v3 (design §10.1)
 * ----------------------------------
 * {
 *   id: 'paddle',
 *   // checkout
 *   priceIdFor({ plan, trial }, env),                        // -> string
 *   async ensureCustomer(email, ctx),                        // -> { id, existed }   (409-tolerant)
 *   async createCheckoutSession({ priceId, customerId, customData, trial?, plan? }, ctx),
 *                                                            // -> { transactionId, status?, checkoutUrl? }
 *   async checkoutUrlFor?(transactionId, ctx),               // -> string|null (hosted-page adapters)
 *   async enrichEvent?(event, ctx),                           // -> event (fill ids a payload lacks)
 *   async verifyCredentials?(ctx),                            // -> { ok, reason?, message?, live? }
 *   separateTrialPrices?: boolean,                           // false = the trial is a session property
 *   async pricePreview({ priceId, countryCode, customerIp }, ctx),
 *                                                            // -> { amount, currency, taxInclusive, formatted }
 *   // webhooks
 *   async verifyWebhook(rawBody, headers, secret),           // -> { ok, reason? }
 *   parseEvents(rawBody, ctx?),                              // -> NormalizedEvent[]
 *   // management
 *   async getSubscription(subscriptionId, ctx),              // -> NormalizedEvent-shaped state
 *   async cancelSubscription(subscriptionId, { effectiveFrom }, ctx),
 *   async pauseSubscription(subscriptionId, { resumeAt, effectiveFrom }, ctx),
 *   async changePlan(subscriptionId, priceId, { prorate }, ctx),
 *   async createPortalSession(customerId, subscriptionIds, ctx),
 * }
 *
 * ctx = { env, fetchImpl?, isProd? }
 *
 * NormalizedEvent (design §6.2) — every adapter produces exactly this shape:
 * {
 *   id, type, occurredAt, live, reservationId,
 *   providerSubscriptionId, providerCustomerId, providerPriceId, providerTransactionId,
 *   customerEmail, status, plan, hadTrial,
 *   trialStartsAt, trialEndsAt, currentPeriodStart, currentPeriodEnd, nextBilledAt,
 *   canceledAt, pausedAt, scheduledChange: { action, effectiveAt, resumeAt } | null,
 *   amount, currency, taxInclusive, totalIsZero,
 * }
 *
 * Every provider call that fails throws a ProviderError carrying `status`,
 * `code` and `reason`; the endpoints turn that into a calm 502/503. Adapters
 * never log a customer email, a transaction id or a subscription id.
 */

import { paddleProvider } from './paddle.js';
import { fastspringProvider } from './fastspring.js';
import { stripeProvider } from './stripe.js';

/** Every adapter id, in the order they were adopted. */
export const PROVIDER_IDS = Object.freeze(['paddle', 'fastspring', 'stripe']);

/**
 * Every adapter, keyed by the value of MOR_PROVIDER.
 *
 * A function rather than a top-level object on purpose: the adapters import
 * their shared helpers back from this file, and building the table at
 * module-evaluation time would hit the temporal dead zone when an adapter is
 * the entry point of the import graph (which is what the test suite does).
 *
 * @returns {Record<string, object>}
 */
export function listProviders() {
  return { paddle: paddleProvider, fastspring: fastspringProvider, stripe: stripeProvider };
}

/**
 * Pick the adapter named by MOR_PROVIDER.
 * @param {string} name
 * @returns {object} the adapter
 * @throws {Error} when the name is unknown
 */
export function getProvider(name) {
  const key = String(name || '').toLowerCase();
  const provider = listProviders()[key];
  if (!provider) {
    throw new Error(`Unknown MOR_PROVIDER "${key}". Supported values: ${PROVIDER_IDS.join(', ')}.`);
  }
  return provider;
}

// --------------------------------------------------------------------------
// Plans and prices (design §3.2 plan enum, §10.2 env vars)
// --------------------------------------------------------------------------

/** The plan enum, exactly as the subscriptions.plan CHECK constraint spells it. */
export const PLANS = Object.freeze(['monthly', 'yearly']);

/**
 * Which env var holds the provider price id (Paddle `pri_…`) or product path
 * (FastSpring) for each (plan, trial) pair. `null` would mean "this plan has
 * no trial price"; both plans carry one today.
 */
export const PRICE_ENV = Object.freeze({
  monthly: Object.freeze({ trial: 'MOR_PRICE_MONTHLY_TRIAL', paid: 'MOR_PRICE_MONTHLY' }),
  yearly: Object.freeze({ trial: 'MOR_PRICE_YEARLY_TRIAL', paid: 'MOR_PRICE_YEARLY' }),
});

/**
 * True for a plan name we sell.
 * @param {unknown} plan
 * @returns {boolean}
 */
export function isPlan(plan) {
  return PLANS.includes(String(plan || ''));
}

/**
 * The provider price id for a (plan, trial) pair, read from env — never from
 * the browser (design §5.4 step 7, §5.5). Shared by both adapters because the
 * env-var layout is ours, not the provider's.
 *
 * @param {{plan:string, trial?:boolean}} input
 * @param {Record<string,string>} env
 * @returns {string}
 * @throws {Error} when the plan is unknown or the env var is unset
 */
export function priceIdFor(input, env) {
  const plan = String((input && input.plan) || '');
  const wantTrial = Boolean(input && input.trial);
  const slot = PRICE_ENV[plan];
  if (!slot) throw new Error(`Unknown plan "${plan}". Supported plans: ${PLANS.join(', ')}.`);
  const varName = wantTrial ? slot.trial : slot.paid;
  if (!varName) throw new Error(`Plan "${plan}" has no trial price.`);
  const value = String((env && env[varName]) || '').trim();
  if (!value) throw new Error(`Missing environment variable ${varName} for plan "${plan}".`);
  return value;
}

/**
 * The full price table from env: every configured price id with its plan and
 * whether it carries a trial. Missing vars are simply absent.
 *
 * @param {Record<string,string>} env
 * @returns {Map<string, {plan:string, trial:boolean}>} lowercased id -> meaning
 */
export function priceTable(env) {
  const map = new Map();
  for (const plan of PLANS) {
    const slot = PRICE_ENV[plan];
    for (const [kind, varName] of [['trial', slot.trial], ['paid', slot.paid]]) {
      if (!varName) continue;
      const value = String((env && env[varName]) || '').trim().toLowerCase();
      if (value) map.set(value, { plan, trial: kind === 'trial' });
    }
  }
  return map;
}

/**
 * Resolve a provider price id (or product path) to our plan.
 * @param {string|null|undefined} priceId
 * @param {Record<string,string>} env
 * @returns {{plan:string, trial:boolean}|null}
 */
export function planForPriceId(priceId, env) {
  if (!priceId) return null;
  return priceTable(env).get(String(priceId).trim().toLowerCase()) || null;
}

/**
 * True when the price id is one of the trial prices (design §6.3, the
 * unconditional trial-price check).
 * @param {string|null|undefined} priceId
 * @param {Record<string,string>} env
 * @returns {boolean}
 */
export function isTrialPriceId(priceId, env) {
  const hit = planForPriceId(priceId, env);
  return Boolean(hit && hit.trial);
}

// --------------------------------------------------------------------------
// Normalised events
// --------------------------------------------------------------------------

/** Every normalised event type an adapter may emit (design §6.2, plus txn.chargeback). */
export const EVENT_TYPES = Object.freeze([
  'sub.created',
  'sub.trialing',
  'sub.activated',
  'sub.updated',
  'sub.past_due',
  'sub.paused',
  'sub.resumed',
  'sub.canceled',
  'txn.completed',
  'txn.failed',
  'txn.refunded',
  'txn.chargeback',
  'ignore',
]);

/** The five provider statuses plus our local `expired` (design §6.4). */
export const SUBSCRIPTION_STATUSES = Object.freeze([
  'trialing',
  'active',
  'past_due',
  'paused',
  'canceled',
  'expired',
]);

/** Values `effective_from` may take. Always passed explicitly (design §5.9). */
export const EFFECTIVE_FROM = Object.freeze(['next_billing_period', 'immediately']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The reservation id out of a provider `custom_data` object. It is the ONLY
 * field ever read from custom_data (design §6.3): an opaque uuid, or null.
 * `custom_data.user_id`, if it ever appears, is ignored here and logged by
 * applyEvent.
 *
 * @param {unknown} customData
 * @returns {string|null}
 */
export function reservationIdFrom(customData) {
  if (!customData || typeof customData !== 'object') return null;
  const rid = customData.rid;
  if (typeof rid !== 'string' || !UUID_RE.test(rid)) return null;
  return rid.toLowerCase();
}

/**
 * Build a normalised event with every field present (null when unknown), so
 * consumers never have to guard against undefined.
 *
 * @param {Partial<object>} partial
 * @returns {object}
 */
export function normalizeEvent(partial) {
  const p = partial || {};
  const type = EVENT_TYPES.includes(p.type) ? p.type : 'ignore';
  const scheduled =
    p.scheduledChange && typeof p.scheduledChange === 'object' && p.scheduledChange.action
      ? {
          action: String(p.scheduledChange.action),
          effectiveAt: p.scheduledChange.effectiveAt || null,
          resumeAt: p.scheduledChange.resumeAt || null,
        }
      : null;
  return {
    id: p.id ? String(p.id) : null,
    type,
    providerEventType: p.providerEventType ? String(p.providerEventType) : null,
    occurredAt: p.occurredAt || null,
    live: typeof p.live === 'boolean' ? p.live : null,
    reservationId: p.reservationId || null,
    providerSubscriptionId: p.providerSubscriptionId || null,
    providerCustomerId: p.providerCustomerId || null,
    providerPriceId: p.providerPriceId || null,
    providerTransactionId: p.providerTransactionId || null,
    customerEmail: p.customerEmail || null,
    status: SUBSCRIPTION_STATUSES.includes(p.status) ? p.status : null,
    plan: isPlan(p.plan) ? p.plan : null,
    hadTrial: typeof p.hadTrial === 'boolean' ? p.hadTrial : null,
    trialStartsAt: p.trialStartsAt || null,
    trialEndsAt: p.trialEndsAt || null,
    currentPeriodStart: p.currentPeriodStart || null,
    currentPeriodEnd: p.currentPeriodEnd || null,
    nextBilledAt: p.nextBilledAt || null,
    canceledAt: p.canceledAt || null,
    pausedAt: p.pausedAt || null,
    scheduledChange: scheduled,
    amount: p.amount == null ? null : String(p.amount),
    currency: p.currency ? String(p.currency).toUpperCase() : null,
    taxInclusive: typeof p.taxInclusive === 'boolean' ? p.taxInclusive : null,
    totalIsZero: typeof p.totalIsZero === 'boolean' ? p.totalIsZero : null,
    fullyRefunded: typeof p.fullyRefunded === 'boolean' ? p.fullyRefunded : null,
    customDataUserIdSeen: Boolean(p.customDataUserIdSeen),
    // The provider's own delivery for THIS event, exactly as parsed, so that
    // webhook_events.payload can be fed back through parseEvents() to re-drive
    // a failed row (design §3.4, §6.1). Null for API-originated state.
    payload: p.payload && typeof p.payload === 'object' ? p.payload : null,
  };
}

// --------------------------------------------------------------------------
// Env vars the adapters read (design §10.2) — one list, shared by every endpoint
// --------------------------------------------------------------------------

/** Vars a provider call cannot work without. `requireEnv()` these. */
export const PROVIDER_ENV_REQUIRED = Object.freeze(['MOR_API_KEY']);

/** Vars an adapter reads when present. `readEnv()` these; blank means unset. */
export const PROVIDER_ENV_OPTIONAL = Object.freeze([
  'MOR_API_BASE',
  'MOR_API_USERNAME',
  'MOR_API_PASSWORD',
  'MOR_SANDBOX',
  'MOR_STOREFRONT',
  'MOR_PRICE_MONTHLY_TRIAL',
  'MOR_PRICE_MONTHLY',
  'MOR_PRICE_YEARLY_TRIAL',
  'MOR_PRICE_YEARLY',
  'MOR_MANAGED_PAYMENTS',
  'SITE_ORIGIN',
]);

/**
 * True when this deployment is configured against the sandbox (design §10.2:
 * `MOR_SANDBOX` is `true` until go-live and "also gates the `live` flag check
 * in §6.1"). Anything but the literal `true` means live, which is the strict
 * reading: a forgotten var on a live deployment must not accept sandbox events.
 * @param {Record<string,string>} env
 * @returns {boolean}
 */
export function sandboxMode(env) {
  return String((env && env.MOR_SANDBOX) || '').trim().toLowerCase() === 'true';
}

// --------------------------------------------------------------------------
// Money and time helpers shared by the adapters
// --------------------------------------------------------------------------

const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/**
 * Number of minor-unit digits for a currency.
 * @param {string} currency
 * @returns {number}
 */
export function currencyExponent(currency) {
  const code = String(currency || '').toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/**
 * Convert a lowest-denomination integer string ("1000" for 10 USD, as Paddle
 * sends it) into a decimal string ("10.00"). Never floats: this is money.
 *
 * @param {string|number|null|undefined} minor
 * @param {string} currency
 * @returns {string|null}
 */
export function moneyFromMinor(minor, currency) {
  if (minor == null || minor === '') return null;
  const text = String(minor).trim();
  if (!/^-?\d+$/.test(text)) return null;
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  const exp = currencyExponent(currency);
  if (exp === 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.padStart(exp + 1, '0');
  const whole = padded.slice(0, padded.length - exp);
  const frac = padded.slice(padded.length - exp);
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/**
 * Format a decimal number (as FastSpring sends prices) into a fixed decimal
 * string for the given currency.
 * @param {number|string|null|undefined} value
 * @param {string} currency
 * @returns {string|null}
 */
export function moneyFromDecimal(value, currency) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(currencyExponent(currency));
}

/**
 * Milliseconds-since-epoch (FastSpring) to ISO 8601, or null.
 * @param {unknown} ms
 * @returns {string|null}
 */
export function isoFromMillis(ms) {
  if (ms == null || ms === '') return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

/**
 * Validate an ISO/RFC 3339 timestamp string; returns it normalised or null.
 * @param {unknown} value
 * @returns {string|null}
 */
export function isoOrNull(value) {
  if (typeof value !== 'string' || !value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

/**
 * Lowercase hex of raw bytes. (api/_lib/crypto.js keeps its own copy private;
 * task 3 exports it, at which point this one can go.)
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

// --------------------------------------------------------------------------
// Errors and the fetch wrapper contract
// --------------------------------------------------------------------------

/**
 * Thrown by an adapter when the provider says no or cannot be reached.
 * `reason` is one of provider_unavailable | provider_error | not_found |
 * conflict | bad_request | unauthorized | rate_limited. Never carries a body
 * the endpoint might echo.
 */
export class ProviderError extends Error {
  /**
   * @param {string} reason
   * @param {{status?:number, code?:string, message?:string, cause?:unknown}} [info]
   */
  constructor(reason, info = {}) {
    super(info.message || `Provider call failed: ${reason}`);
    this.name = 'ProviderError';
    this.reason = reason;
    this.status = Number.isFinite(info.status) ? info.status : 0;
    this.code = info.code || null;
    if (info.cause) this.cause = info.cause;
  }
}

/**
 * Map an HTTP status to a ProviderError reason.
 * @param {number} status
 * @returns {string}
 */
export function reasonForStatus(status) {
  if (!status) return 'provider_unavailable';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'bad_request';
  return 'provider_error';
}

/** Method names every v3 adapter must implement. Used by tests and by getProvider callers that want to fail early. */
export const ADAPTER_METHODS = Object.freeze([
  'priceIdFor',
  'ensureCustomer',
  'createCheckoutSession',
  'pricePreview',
  'verifyWebhook',
  'parseEvents',
  'getSubscription',
  'cancelSubscription',
  'pauseSubscription',
  'changePlan',
  'createPortalSession',
]);

/**
 * Throw if an adapter misses part of the v3 contract.
 * @param {object} adapter
 */
export function assertAdapter(adapter) {
  if (!adapter || typeof adapter.id !== 'string') throw new Error('Adapter has no id.');
  for (const name of ADAPTER_METHODS) {
    if (typeof adapter[name] !== 'function') {
      throw new Error(`Adapter "${adapter.id}" is missing ${name}().`);
    }
  }
}

/**
 * Normalise a headers-ish value (Headers, plain object, or Map) to a getter.
 * @param {unknown} headers
 * @returns {(name:string)=>string|null}
 */
export function headerGetter(headers) {
  if (!headers) return () => null;
  if (typeof headers.get === 'function') return (name) => headers.get(name);
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[String(k).toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
  return (name) => (lower[String(name).toLowerCase()] == null ? null : String(lower[String(name).toLowerCase()]));
}
