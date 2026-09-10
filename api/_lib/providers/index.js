/**
 * api/_lib/providers/index.js — the merchant-of-record seam.
 *
 * Swapping the merchant of record is a one-file change: write a new adapter next
 * to paddle.js / fastspring.js, add it to PROVIDERS below, and set MOR_PROVIDER.
 * Nothing outside this folder knows the name of a payment company.
 *
 * The owner is a Lebanon-resident individual with no company, so the rail is
 * always a merchant of record. Paddle is primary, FastSpring is the hedge.
 *
 * Adapter contract
 * ----------------
 * {
 *   id: 'paddle',
 *   keyHint: string,                       // shown to a person who pasted the wrong thing
 *   looksLikeKey(key): boolean,
 *   async lookup(key, ctx): LookupResult,
 *   async recordActivation(record, { domains }, ctx): { ok, activations, reason? }
 * }
 *
 * LookupResult = { ok: true, record } | { ok: false, reason, message? }
 *
 * record = {
 *   provider, orderId, sku, tier, live,
 *   activations, maxActivations, maxDomains, domains,
 *   subscriptionStatus, ref  // ref holds provider-internal ids the adapter needs to write back
 * }
 *
 * ctx = { env, fetchImpl, isProd }
 */

import { paddleProvider } from './paddle.js';
import { fastspringProvider } from './fastspring.js';

/** Every adapter id, in the order they were adopted. */
export const PROVIDER_IDS = Object.freeze(['paddle', 'fastspring']);

/**
 * Every adapter, keyed by the value of MOR_PROVIDER.
 *
 * This is a function rather than a top-level object on purpose: the adapters
 * import their shared constants back from this file, and building the table at
 * module-evaluation time would hit the temporal dead zone when an adapter is
 * the entry point of the import graph (which is exactly what the test suite
 * does). Function bodies run after every module in the cycle is initialised.
 *
 * @returns {Record<string, object>}
 */
export function listProviders() {
  return { paddle: paddleProvider, fastspring: fastspringProvider };
}

/** Internal SKUs. These are ours, not any provider's. */
export const SKUS = Object.freeze(['lifetime', 'monthly', 'practitioner', 'studio', 'pack']);

/** Which env var holds the provider's product/price id(s) for each SKU. */
export const PRODUCT_ENV = Object.freeze({
  lifetime: 'MOR_PRODUCT_LIFETIME',
  monthly: 'MOR_PRODUCT_MONTHLY',
  practitioner: 'MOR_PRODUCT_PRACTITIONER',
  studio: 'MOR_PRODUCT_STUDIO',
  pack: 'MOR_PRODUCT_PACK',
});

/** SKU -> the tier the token carries. `pack` is not an app tier (see api/license.js). */
export const SKU_TIER = Object.freeze({
  lifetime: 'pro',
  monthly: 'pro',
  practitioner: 'practitioner',
  studio: 'studio',
  pack: 'pack',
});

/**
 * Token lifetime in days. A lifetime purchase can never be revoked for
 * non-payment, so it gets the long token; anything renewing gets seven days so
 * a cancellation stops working within a week with no revocation list.
 */
export const SKU_TOKEN_DAYS = Object.freeze({
  lifetime: 30,
  monthly: 7,
  practitioner: 7,
  studio: 7,
  pack: 30,
});

/** True when the SKU renews and therefore needs a subscription status check. */
export const SKU_IS_SUBSCRIPTION = Object.freeze({
  lifetime: false,
  monthly: true,
  practitioner: true,
  studio: true,
  pack: false,
});

/** Activation and white-label domain caps per tier (AGENT_BRIEF §1). */
export const TIER_LIMITS = Object.freeze({
  free: { activations: 0, domains: 0 },
  pack: { activations: 0, domains: 0 },
  pro: { activations: 6, domains: 0 },
  practitioner: { activations: 25, domains: 1 },
  studio: { activations: 25, domains: 10 },
});

/** Ranking used when one order contains several products. */
export const SKU_RANK = Object.freeze({
  pack: 1,
  lifetime: 2,
  monthly: 2,
  practitioner: 3,
  studio: 4,
});

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

/**
 * Build the product-id -> SKU map from MOR_PRODUCT_* .
 *
 * Each variable may hold several ids separated by commas or whitespace. That
 * matters because a Paddle transaction exposes both a price id (`pri_…`) and a
 * product id (`pro_…`), and because a founding-member price is a second price id
 * against the same product.
 *
 * @param {Record<string,string>} env
 * @returns {Map<string,string>} lowercased id -> sku
 */
export function productSkuMap(env) {
  const map = new Map();
  for (const sku of SKUS) {
    const raw = env[PRODUCT_ENV[sku]];
    if (!raw) continue;
    for (const id of String(raw).split(/[\s,]+/)) {
      const trimmed = id.trim().toLowerCase();
      if (trimmed) map.set(trimmed, sku);
    }
  }
  return map;
}

/**
 * Resolve a set of provider product/price identifiers to our best SKU.
 * @param {Array<string|null|undefined>} ids
 * @param {Record<string,string>} env
 * @returns {string|null}
 */
export function skuForProductIds(ids, env) {
  const map = productSkuMap(env);
  let best = null;
  for (const id of ids || []) {
    if (!id) continue;
    const sku = map.get(String(id).trim().toLowerCase());
    if (!sku) continue;
    if (!best || (SKU_RANK[sku] || 0) > (SKU_RANK[best] || 0)) best = sku;
  }
  return best;
}

/**
 * Limits for a tier, with a safe zero default.
 * @param {string} tier
 * @returns {{activations:number, domains:number}}
 */
export function limitsForTier(tier) {
  return TIER_LIMITS[tier] || TIER_LIMITS.free;
}

/**
 * Normalise something a person typed into a hostname.
 * Accepts "https://Example.com/path", "example.com:443", "EXAMPLE.com".
 * @param {string} value
 * @returns {string} '' when it is not a plausible hostname
 */
export function normalizeDomain(value) {
  let text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text) return '';
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  text = text.split('/')[0].split('?')[0].split('#')[0];
  text = text.replace(/^[^@]*@/, '');
  text = text.split(':')[0];
  text = text.replace(/\.$/, '');
  if (text.length === 0 || text.length > 253) return '';
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(text)) return '';
  return text;
}

/**
 * Clean, de-duplicate and cap a list of domains.
 * @param {unknown} input
 * @param {number} max
 * @returns {{domains:string[], rejected:string[]}}
 */
export function normalizeDomains(input, max = 10) {
  const rejected = [];
  const out = [];
  if (!Array.isArray(input)) return { domains: out, rejected };
  for (const value of input.slice(0, 50)) {
    const domain = normalizeDomain(value);
    if (!domain) {
      if (String(value || '').trim()) rejected.push(String(value).trim().slice(0, 64));
      continue;
    }
    if (!out.includes(domain)) out.push(domain);
    if (out.length >= max) break;
  }
  return { domains: out, rejected };
}

/**
 * Merge stored and newly requested domains without duplicates.
 * @param {string[]} stored
 * @param {string[]} incoming
 * @returns {string[]}
 */
export function mergeDomains(stored, incoming) {
  const out = [];
  for (const list of [stored || [], incoming || []]) {
    for (const value of list) {
      const domain = normalizeDomain(value);
      if (domain && !out.includes(domain)) out.push(domain);
    }
  }
  return out;
}

/**
 * A human sentence for each machine reason a lookup can fail with. These strings
 * are shown to the buyer, so they are calm and actionable.
 * @param {string} reason
 * @param {object} [adapter]
 * @returns {string}
 */
export function messageForReason(reason, adapter) {
  const hint = adapter && adapter.keyHint ? ` ${adapter.keyHint}` : '';
  switch (reason) {
    case 'unrecognised_key':
      return `That does not look like a licence key.${hint}`;
    case 'not_found':
      return 'We could not find that key. Check it against your receipt email, or reply to it and we will sort it out.';
    case 'not_paid':
      return 'That order has not completed yet. If you have just paid, give it a minute and try again.';
    case 'canceled':
      return 'That order was cancelled, so it does not carry a licence.';
    case 'refunded':
      return 'That order was refunded, so the licence attached to it is no longer active.';
    case 'test_mode':
      return 'That is a test-mode order. Test keys do not work on the live site.';
    case 'unknown_product':
      return 'That order is not for a Help Me Breathe licence. Check your receipt, or reply to it and we will help.';
    case 'subscription_inactive':
      return 'That subscription is not active. Renew it and your licence will start working again straight away.';
    case 'provider_unavailable':
      return 'We could not reach the licence server. Please try again in a moment.';
    case 'provider_error':
      return 'The licence server returned an error. Please try again in a moment.';
    default:
      return 'That key could not be verified. Check it and try again.';
  }
}
