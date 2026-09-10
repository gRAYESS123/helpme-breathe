/**
 * api/_lib/providers/paddle.js — Paddle Billing adapter (primary merchant of record).
 *
 * Verified against the Paddle Developer docs on 2026-09-09:
 *   - Base URLs: live https://api.paddle.com , sandbox https://sandbox-api.paddle.com
 *     ("Sandbox and live accounts use different credentials. Generate them in each
 *     account separately." — developer.paddle.com/sdks/sandbox)
 *   - Auth: "To authenticate, pass your Paddle API key using the `Authorization`
 *     header and the `Bearer` prefix." Keys match
 *     ^pdl_(live|sdbx)_apikey_[a-z\d]{26}_[a-zA-Z\d]{22}_[a-zA-Z\d]{3}$
 *   - GET /transactions/{id}: id matches ^txn_[a-z\d]{26}$ ; statuses are
 *     draft, ready, billed, paid, completed, canceled, past_due ; `include`
 *     accepts address, adjustments, adjustments_totals, available_payment_methods,
 *     business, customer, discount.
 *   - Adjustment `action` is one of credit, refund, chargeback, chargeback_reverse,
 *     chargeback_warning, chargeback_warning_reverse, credit_reverse ; `status` is
 *     pending_approval, approved, rejected, reversed.
 *   - Subscription `status` is active, canceled, past_due, paused, trialing.
 *
 * WHERE THE ACTIVATION COUNTER LIVES — and why it is not on the transaction.
 *
 * The obvious place would be `custom_data` on the transaction, but Paddle is
 * explicit: "You can update transactions that are `draft` or `ready`. `billed`
 * and `completed` transactions are considered records for tax and legal
 * purposes, so they can't be changed." Every paid order we look at is `billed`,
 * `paid` or `completed`, so PATCH /transactions/{id} is not available to us.
 *
 * The customer entity has no such restriction: PATCH /customers/{id} "Updates a
 * customer using its ID." and accepts `custom_data` ("Your own structured
 * key-value data"). So the ledger lives on the CUSTOMER, keyed by transaction id:
 *
 *   customer.custom_data.hmb_activations = {
 *     "txn_01h…": { "n": 2, "max": 6, "doms": ["clinic.example"], "first": "…", "last": "…" }
 *   }
 *
 * That keeps one ledger per purchase even when a customer buys twice, and it
 * preserves any other keys the owner may have put in custom_data (we read,
 * merge, then write). It is best effort and racy under simultaneous
 * activations — there is no database and no compare-and-swap — which is fine at
 * this scale and documented in docs/API.md.
 *
 * Required API key permissions: transaction.read, customer.read, customer.write,
 * subscription.read. Without customer.write the counter cannot be incremented and
 * the cap silently stops biting; the adapter logs a loud warning when that happens.
 */

import {
  SKU_IS_SUBSCRIPTION,
  SKU_TIER,
  limitsForTier,
  mergeDomains,
  skuForProductIds,
} from './index.js';

const LIVE_BASE = 'https://api.paddle.com';
const SANDBOX_BASE = 'https://sandbox-api.paddle.com';

/** Key on the customer's custom_data that holds our per-transaction ledger. */
export const LEDGER_KEY = 'hmb_activations';

/** Paddle transaction ids, the thing a buyer pastes as their licence key. */
const TRANSACTION_ID_RE = /^txn_[a-z0-9]{26}$/i;

/** Transaction statuses that mean money has actually been taken. */
const PAID_STATUSES = new Set(['billed', 'paid', 'completed']);

/** Adjustment actions that revoke a licence when they are live. */
const REVOKING_ACTIONS = new Set(['refund', 'chargeback', 'chargeback_warning']);

/** Adjustment statuses that mean the adjustment is not in force. */
const INERT_ADJUSTMENT_STATUSES = new Set(['rejected', 'reversed']);

/** Subscription statuses we still honour. `past_due` is Paddle retrying a card. */
const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due']);

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
  const override = (env.MOR_API_BASE || '').trim();
  if (override) return override.replace(/\/+$/, '');
  return isSandboxKey(env.MOR_API_KEY) ? SANDBOX_BASE : LIVE_BASE;
}

async function paddleFetch(ctx, path, init = {}) {
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  const url = `${baseUrlFor(ctx.env)}${path}`;
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${ctx.env.MOR_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
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
    return { ok: false, status: response.status, body, reason: response.status === 404 ? 'not_found' : 'provider_error' };
  }
  return { ok: true, status: response.status, body };
}

/**
 * Every product/price identifier a transaction can offer us, so the
 * MOR_PRODUCT_* variables can hold either a `pro_…` product id or a `pri_…`
 * price id (or both).
 * @param {object} transaction
 * @returns {string[]}
 */
export function collectProductIds(transaction) {
  const ids = [];
  const push = (value) => {
    if (value && typeof value === 'string') ids.push(value);
  };
  for (const item of transaction.items || []) {
    push(item.price && item.price.id);
    push(item.price && item.price.product_id);
    push(item.product && item.product.id);
    push(item.price_id);
  }
  const lineItems = (transaction.details && transaction.details.line_items) || [];
  for (const line of lineItems) {
    push(line.price_id);
    push(line.product && line.product.id);
  }
  return ids;
}

/**
 * True when any adjustment on the transaction revokes it.
 * @param {Array<object>} adjustments
 * @returns {boolean}
 */
export function hasRevokingAdjustment(adjustments) {
  for (const adjustment of adjustments || []) {
    const action = String(adjustment.action || '').toLowerCase();
    const status = String(adjustment.status || '').toLowerCase();
    if (!REVOKING_ACTIONS.has(action)) continue;
    if (INERT_ADJUSTMENT_STATUSES.has(status)) continue;
    return true;
  }
  return false;
}

/**
 * Pull our ledger entry for one transaction out of a customer's custom_data.
 * @param {object|null} customer
 * @param {string} transactionId
 * @returns {{n:number, doms:string[], first:string|null, last:string|null}}
 */
export function readLedger(customer, transactionId) {
  const empty = { n: 0, doms: [], first: null, last: null };
  if (!customer || !customer.custom_data || typeof customer.custom_data !== 'object') return empty;
  const ledger = customer.custom_data[LEDGER_KEY];
  if (!ledger || typeof ledger !== 'object') return empty;
  const entry = ledger[transactionId];
  if (!entry || typeof entry !== 'object') return empty;
  return {
    n: Number.isFinite(Number(entry.n)) ? Math.max(0, Math.floor(Number(entry.n))) : 0,
    doms: Array.isArray(entry.doms) ? entry.doms.filter((d) => typeof d === 'string') : [],
    first: typeof entry.first === 'string' ? entry.first : null,
    last: typeof entry.last === 'string' ? entry.last : null,
  };
}

export const paddleProvider = {
  id: 'paddle',
  keyHint: 'A Paddle licence key starts with "txn_" and is on your receipt email.',

  /**
   * @param {string} key
   * @returns {boolean}
   */
  looksLikeKey(key) {
    return TRANSACTION_ID_RE.test(String(key || '').trim());
  },

  /**
   * Verify a key against Paddle and read the activation ledger.
   * @param {string} key the Paddle transaction id
   * @param {{env:Record<string,string>, fetchImpl?:Function, isProd?:boolean}} ctx
   */
  async lookup(key, ctx) {
    const transactionId = String(key || '').trim();
    if (!TRANSACTION_ID_RE.test(transactionId)) {
      return { ok: false, reason: 'unrecognised_key' };
    }

    const sandbox = isSandboxKey(ctx.env.MOR_API_KEY);
    if (sandbox && ctx.isProd) {
      // A sandbox API key on a production deployment can only ever resolve
      // test-mode orders. Refuse before making the call.
      return { ok: false, reason: 'test_mode' };
    }

    const result = await paddleFetch(
      ctx,
      `/transactions/${encodeURIComponent(transactionId)}?include=customer,adjustments`,
    );
    if (!result.ok) return { ok: false, reason: result.reason };

    const transaction = (result.body && result.body.data) || null;
    if (!transaction) return { ok: false, reason: 'not_found' };

    const status = String(transaction.status || '').toLowerCase();
    if (status === 'canceled') return { ok: false, reason: 'canceled' };
    if (!PAID_STATUSES.has(status)) return { ok: false, reason: 'not_paid' };

    if (hasRevokingAdjustment(transaction.adjustments)) {
      return { ok: false, reason: 'refunded' };
    }

    const sku = skuForProductIds(collectProductIds(transaction), ctx.env);
    if (!sku) return { ok: false, reason: 'unknown_product' };

    let subscriptionStatus = null;
    if (SKU_IS_SUBSCRIPTION[sku] && transaction.subscription_id) {
      const sub = await paddleFetch(ctx, `/subscriptions/${encodeURIComponent(transaction.subscription_id)}`);
      if (!sub.ok) {
        // A missing subscription is a hard no; an unreachable Paddle is a soft no.
        return { ok: false, reason: sub.reason === 'not_found' ? 'subscription_inactive' : sub.reason };
      }
      subscriptionStatus = String((sub.body && sub.body.data && sub.body.data.status) || '').toLowerCase();
      if (!LIVE_SUBSCRIPTION_STATUSES.has(subscriptionStatus)) {
        return { ok: false, reason: 'subscription_inactive' };
      }
    }

    const tier = SKU_TIER[sku];
    const limits = limitsForTier(tier);
    const customer = transaction.customer || null;
    const ledger = readLedger(customer, transactionId);

    return {
      ok: true,
      record: {
        provider: 'paddle',
        orderId: transactionId,
        sku,
        tier,
        live: !sandbox,
        status,
        subscriptionStatus,
        activations: ledger.n,
        maxActivations: limits.activations,
        maxDomains: limits.domains,
        domains: ledger.doms,
        ref: {
          customerId: transaction.customer_id || (customer && customer.id) || null,
          customerCustomData:
            customer && customer.custom_data && typeof customer.custom_data === 'object'
              ? customer.custom_data
              : {},
          subscriptionId: transaction.subscription_id || null,
          firstActivation: ledger.first,
        },
      },
    };
  },

  /**
   * Increment the activation counter and store the domain list.
   * Read-modify-write on customer.custom_data; other keys are preserved.
   *
   * @param {object} record from lookup()
   * @param {{domains?:string[]}} input
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<{ok:boolean, activations:number, domains:string[], reason?:string}>}
   */
  async recordActivation(record, input, ctx) {
    const domains = mergeDomains(record.domains, (input && input.domains) || []);
    const activations = record.activations + 1;
    const customerId = record.ref && record.ref.customerId;

    if (!customerId) {
      console.warn('[paddle] no customer on transaction; activation not recorded', {
        order: record.orderId,
      });
      return { ok: false, activations, domains, reason: 'no_customer' };
    }

    const nowIso = new Date().toISOString();
    const existing = (record.ref && record.ref.customerCustomData) || {};
    const previousLedger =
      existing[LEDGER_KEY] && typeof existing[LEDGER_KEY] === 'object' ? existing[LEDGER_KEY] : {};

    const customData = {
      ...existing,
      [LEDGER_KEY]: {
        ...previousLedger,
        [record.orderId]: {
          n: activations,
          max: record.maxActivations,
          doms: domains,
          first: (record.ref && record.ref.firstActivation) || nowIso,
          last: nowIso,
        },
      },
    };

    const result = await paddleFetch(ctx, `/customers/${encodeURIComponent(customerId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ custom_data: customData }),
    });

    if (!result.ok) {
      console.warn(
        '[paddle] could not write the activation ledger. Check that the API key has ' +
          'customer.write permission, otherwise activation caps will not be enforced.',
        { order: record.orderId, status: result.status },
      );
      return { ok: false, activations, domains, reason: 'ledger_write_failed' };
    }

    return { ok: true, activations, domains };
  },
};

export default paddleProvider;
