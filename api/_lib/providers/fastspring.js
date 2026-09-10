/**
 * api/_lib/providers/fastspring.js — FastSpring adapter (the hedge if Paddle declines).
 *
 * Verified against the FastSpring Developer docs on 2026-09-09:
 *   - "All API requests must be sent to: `https://api.fastspring.com`"
 *   - Authentication is HTTP Basic: "Encode your username and password using
 *     **Base64** within your request headers." The credentials are an API
 *     username/password pair created in the FastSpring dashboard, not a bearer token.
 *   - GET /orders/{order_id} returns `id` ("Unique ID, same as order ID"),
 *     `reference`, `live` ("Indicates if the order is a live order or a test
 *     order; 'true' indicates a live order"), `completed`, `changed`, and
 *     `items` where each item carries `product` (the product path).
 *   - POST /orders "Updates order tags and attributes." with a body of
 *     { "orders": [ { "order": "…", "tags": { … } } ] }.
 *   - GET /subscriptions/{id} returns `state` ("Current state of the
 *     subscription (e.g., trial, active, canceled)") and `active`
 *     ("Indicates if the subscription is active"), a boolean.
 *
 * WHERE THE ACTIVATION COUNTER LIVES.
 *
 * FastSpring order tags are writable after the sale (POST /orders), so the
 * ledger lives directly on the order:
 *
 *   order.tags.hmb_act = '{"n":2,"doms":["clinic.example"],"first":"…"}'
 *
 * Tag values are strings, hence the JSON-in-a-string. One order, one ledger —
 * simpler than the Paddle shape because FastSpring lets us write to the order itself.
 *
 * SECOND KNOWN LIMIT, ALSO FLAGGED FOR THE OWNER: the documented response schema
 * for GET /orders/{id} does not list a `tags` field, only the update endpoint
 * does. If a real order does not echo its tags back, `readLedger()` returns zero
 * every time and the activation cap stops biting on FastSpring — licences are
 * still issued, nobody is stranded, and the ledger is still written. Confirm this
 * against one real order before FastSpring ever becomes the primary rail.
 *
 * KNOWN LIMIT, FLAGGED FOR THE OWNER: the documented order schema does not
 * expose a refund flag, so this adapter cannot detect a refund from the order
 * alone. It therefore checks three things: `completed`, `live`, and — for
 * subscription products — `active` on the subscription. For a refunded one-off
 * order the revocation path is a manual tag: set `hmb_revoked` to any non-empty
 * value on the order in the FastSpring dashboard and this adapter refuses the
 * key from the next call onwards. A handful of defensive field checks
 * (`refunded`, `returned`, `status === 'refunded'`) are also applied in case a
 * newer API version starts sending them.
 */

import {
  SKU_IS_SUBSCRIPTION,
  SKU_TIER,
  limitsForTier,
  mergeDomains,
  skuForProductIds,
} from './index.js';
import { base64Encode } from '../crypto.js';

const BASE = 'https://api.fastspring.com';

/** Tag on the order that holds our ledger. */
export const LEDGER_TAG = 'hmb_act';

/** Tag the owner sets by hand to kill a licence after a refund. */
export const REVOKED_TAG = 'hmb_revoked';

/** FastSpring order ids look like `abcDEFgHiJklM1N-3OP9q`. Keep the check loose but bounded. */
const ORDER_ID_RE = /^[A-Za-z0-9_.\-]{8,64}$/;

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
  const user = (env.MOR_API_USERNAME || '').trim();
  const pass = (env.MOR_API_PASSWORD || '').trim();
  const pair = user || pass ? `${user}:${pass}` : String(env.MOR_API_KEY || '').trim();
  return `Basic ${base64Encode(pair)}`;
}

/**
 * @param {Record<string,string>} env
 * @returns {string}
 */
export function baseUrlFor(env) {
  const override = (env.MOR_API_BASE || '').trim();
  return override ? override.replace(/\/+$/, '') : BASE;
}

async function fastspringFetch(ctx, path, init = {}) {
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  const url = `${baseUrlFor(ctx.env)}${path}`;
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: {
        Authorization: basicAuthHeader(ctx.env),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'helpmebreath/1.0 (+https://helpmebreath.com)',
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    return { ok: false, status: 0, reason: 'provider_unavailable', error };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      body,
      reason: response.status === 404 ? 'not_found' : 'provider_error',
    };
  }
  return { ok: true, status: response.status, body };
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
 * True when the order carries any signal that the money came back.
 * @param {object} order
 * @returns {boolean}
 */
export function looksRevoked(order) {
  const tags = order.tags && typeof order.tags === 'object' ? order.tags : {};
  if (String(tags[REVOKED_TAG] || '').trim()) return true;
  if (order.refunded === true || order.returned === true) return true;
  if (String(order.status || '').toLowerCase() === 'refunded') return true;
  return false;
}

/**
 * Product paths on an order, which is what MOR_PRODUCT_* holds for FastSpring.
 * @param {object} order
 * @returns {string[]}
 */
export function collectProductIds(order) {
  const ids = [];
  for (const item of order.items || []) {
    if (item && typeof item.product === 'string') ids.push(item.product);
    if (item && item.product && typeof item.product === 'object' && typeof item.product.path === 'string') {
      ids.push(item.product.path);
    }
  }
  return ids;
}

/**
 * The first subscription id on the order, if any.
 * @param {object} order
 * @returns {string|null}
 */
export function collectSubscriptionId(order) {
  for (const item of order.items || []) {
    if (item && typeof item.subscription === 'string' && item.subscription) return item.subscription;
  }
  return null;
}

/**
 * Read our ledger out of the order tags.
 * @param {object} order
 * @returns {{n:number, doms:string[], first:string|null}}
 */
export function readLedger(order) {
  const empty = { n: 0, doms: [], first: null };
  const tags = order && order.tags && typeof order.tags === 'object' ? order.tags : {};
  const raw = tags[LEDGER_TAG];
  if (!raw || typeof raw !== 'string') return empty;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  return {
    n: Number.isFinite(Number(parsed.n)) ? Math.max(0, Math.floor(Number(parsed.n))) : 0,
    doms: Array.isArray(parsed.doms) ? parsed.doms.filter((d) => typeof d === 'string') : [],
    first: typeof parsed.first === 'string' ? parsed.first : null,
  };
}

export const fastspringProvider = {
  id: 'fastspring',
  keyHint: 'A FastSpring licence key is the order id printed on your receipt.',

  /**
   * @param {string} key
   * @returns {boolean}
   */
  looksLikeKey(key) {
    return ORDER_ID_RE.test(String(key || '').trim());
  },

  /**
   * @param {string} key the FastSpring order id
   * @param {{env:Record<string,string>, fetchImpl?:Function, isProd?:boolean}} ctx
   */
  async lookup(key, ctx) {
    const orderId = String(key || '').trim();
    if (!ORDER_ID_RE.test(orderId)) return { ok: false, reason: 'unrecognised_key' };

    const result = await fastspringFetch(ctx, `/orders/${encodeURIComponent(orderId)}`);
    if (!result.ok) return { ok: false, reason: result.reason };

    const order = firstRecord(result.body);
    if (!order || !order.id) return { ok: false, reason: 'not_found' };

    const live = order.live === true;
    if (!live && ctx.isProd) return { ok: false, reason: 'test_mode' };
    if (order.completed !== true) return { ok: false, reason: 'not_paid' };
    if (looksRevoked(order)) return { ok: false, reason: 'refunded' };

    const sku = skuForProductIds(collectProductIds(order), ctx.env);
    if (!sku) return { ok: false, reason: 'unknown_product' };

    let subscriptionStatus = null;
    const subscriptionId = collectSubscriptionId(order);
    if (SKU_IS_SUBSCRIPTION[sku] && subscriptionId) {
      const sub = await fastspringFetch(ctx, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
      if (!sub.ok) {
        return { ok: false, reason: sub.reason === 'not_found' ? 'subscription_inactive' : sub.reason };
      }
      const subscription = firstRecord(sub.body) || {};
      subscriptionStatus = String(subscription.state || '').toLowerCase() || null;
      if (subscription.active !== true) return { ok: false, reason: 'subscription_inactive' };
    }

    const tier = SKU_TIER[sku];
    const limits = limitsForTier(tier);
    const ledger = readLedger(order);

    return {
      ok: true,
      record: {
        provider: 'fastspring',
        orderId: order.id,
        sku,
        tier,
        live,
        status: order.completed === true ? 'completed' : 'incomplete',
        subscriptionStatus,
        activations: ledger.n,
        maxActivations: limits.activations,
        maxDomains: limits.domains,
        domains: ledger.doms,
        ref: {
          subscriptionId,
          tags: order.tags && typeof order.tags === 'object' ? order.tags : {},
          firstActivation: ledger.first,
        },
      },
    };
  },

  /**
   * @param {object} record
   * @param {{domains?:string[]}} input
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<{ok:boolean, activations:number, domains:string[], reason?:string}>}
   */
  async recordActivation(record, input, ctx) {
    const domains = mergeDomains(record.domains, (input && input.domains) || []);
    const activations = record.activations + 1;
    const nowIso = new Date().toISOString();

    // FastSpring's docs do not say whether a tag update replaces the whole tag
    // map or merges into it, so every tag already on the order is written back
    // alongside ours. If it merges, this is a no-op; if it replaces, nothing the
    // owner put on the order is lost.
    const existingTags =
      record.ref && record.ref.tags && typeof record.ref.tags === 'object' ? record.ref.tags : {};
    const tags = {};
    for (const [name, value] of Object.entries(existingTags)) {
      if (typeof value === 'string') tags[name] = value;
    }
    tags[LEDGER_TAG] = JSON.stringify({
      n: activations,
      doms: domains,
      first: (record.ref && record.ref.firstActivation) || nowIso,
      last: nowIso,
    });

    const payload = { orders: [{ order: record.orderId, tags }] };

    const result = await fastspringFetch(ctx, '/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (!result.ok) {
      console.warn(
        '[fastspring] could not write the activation ledger. Check that the API ' +
          'credentials may update orders, otherwise activation caps will not be enforced.',
        { order: record.orderId, status: result.status },
      );
      return { ok: false, activations, domains, reason: 'ledger_write_failed' };
    }

    return { ok: true, activations, domains };
  },
};

export default fastspringProvider;
