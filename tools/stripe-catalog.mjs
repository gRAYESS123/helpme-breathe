#!/usr/bin/env node
/**
 * tools/stripe-catalog.mjs — create the Stripe catalog and the webhook endpoint.
 *
 * The Stripe MCP server is registered but authenticates per session, so this
 * is the offline equivalent of Stripe's "Set up Managed Payments" blueprint
 * (2026-09-14): one product with an eligible tax code and a default monthly
 * price, plus the yearly price this site sells, and optionally the webhook
 * endpoint that `api/webhooks/mor.js` listens on.
 *
 * Usage (from the repo root, in YOUR terminal — the key is read from the
 * environment and is never printed, written or echoed):
 *
 *   STRIPE_SECRET_KEY=sk_test_… node tools/stripe-catalog.mjs
 *   STRIPE_SECRET_KEY=sk_test_… node tools/stripe-catalog.mjs --webhook https://helpmebreath.com/api/webhooks/mor
 *   STRIPE_SECRET_KEY=sk_live_… node tools/stripe-catalog.mjs               (live: the same, once)
 *
 * PowerShell:  $env:STRIPE_SECRET_KEY = 'sk_test_…'; node tools/stripe-catalog.mjs
 *
 * Get the key from the Stripe dashboard → Developers → API keys. Test-mode
 * keys create a test-mode catalog; run again with the live key at go-live.
 *
 * Idempotent: a product carrying `metadata[hmb]=catalog` is reused, and an
 * existing price with the same amount and interval is reused. Prints the
 * variable names and values to paste into Vercel. The webhook signing secret
 * is shown ONCE — Stripe never shows it again.
 */

import { encodeForm } from '../api/_lib/providers/stripe.js';

const BLUEPRINT_VERSION = '2026-02-25.preview';
const API = 'https://api.stripe.com';

/** The eligible digital-product tax code from Stripe's Managed Payments blueprint. */
const TAX_CODE = 'txcd_10103100';

/** The one plan, two intervals (js/config.js PLANS; US list prices in cents). */
const PRODUCT = { name: 'Help Me Breathe', description: 'One plan, everything included: every breathing pattern and session length, your own patterns, streaks and history, soundscapes, night mode, no ads, offline use.' };
const PRICES = [
  { key: 'MOR_PRICE_MONTHLY', unit_amount: 1000, interval: 'month', nickname: 'Monthly, $10' },
  { key: 'MOR_PRICE_YEARLY', unit_amount: 10000, interval: 'year', nickname: 'Yearly, $100' },
];

/** The events api/_lib/providers/stripe.js maps; anything else is recorded as ignore. */
const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
];

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
if (!/^(sk|rk)_(test|live)_/.test(key)) {
  console.error('Set STRIPE_SECRET_KEY in the environment (sk_test_… or sk_live_…, from the Stripe dashboard → Developers → API keys). It is never printed.');
  process.exit(2);
}
const live = /^(sk|rk)_live_/.test(key);

async function stripe(path, { method = 'GET', body, version } = {}) {
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  if (version) headers['Stripe-Version'] = version;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = encodeForm(body);
  }
  const response = await fetch(`${API}${path}`, { method, headers, body: payload });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = data && data.error ? data.error : {};
    throw new Error(`Stripe ${method} ${path.split('?')[0]} answered ${response.status}: ${err.message || err.code || 'unknown error'}`);
  }
  return data;
}

async function ensureProduct() {
  const existing = await stripe('/v1/products/search?' + new URLSearchParams({ query: "active:'true' AND metadata['hmb']:'catalog'", limit: '1' }));
  if (existing.data && existing.data[0]) return { product: existing.data[0], created: false };
  // The blueprint's product call: an eligible tax code and a default monthly price.
  const product = await stripe('/v1/products', {
    method: 'POST',
    version: BLUEPRINT_VERSION,
    body: {
      name: PRODUCT.name,
      description: PRODUCT.description,
      tax_code: TAX_CODE,
      metadata: { hmb: 'catalog' },
      default_price_data: { unit_amount: PRICES[0].unit_amount, currency: 'usd', recurring: { interval: PRICES[0].interval }, tax_behavior: 'exclusive' },
    },
  });
  return { product, created: true };
}

async function ensurePrice(product, spec) {
  const list = await stripe(`/v1/prices?product=${encodeURIComponent(product.id)}&active=true&limit=100`);
  const hit = (list.data || []).find((p) => p.currency === 'usd' && p.unit_amount === spec.unit_amount && p.recurring && p.recurring.interval === spec.interval);
  if (hit) return { price: hit, created: false };
  const price = await stripe('/v1/prices', {
    method: 'POST',
    body: { product: product.id, currency: 'usd', unit_amount: spec.unit_amount, recurring: { interval: spec.interval }, nickname: spec.nickname, tax_behavior: 'exclusive', metadata: { hmb: spec.key } },
  });
  return { price, created: true };
}

async function ensureWebhook(url) {
  const list = await stripe('/v1/webhook_endpoints?limit=100');
  const hit = (list.data || []).find((w) => w.url === url && w.status === 'enabled');
  if (hit) return { endpoint: hit, created: false };
  const endpoint = await stripe('/v1/webhook_endpoints', {
    method: 'POST',
    body: { url, enabled_events: WEBHOOK_EVENTS, description: 'Help Me Breathe — api/webhooks/mor', metadata: { hmb: 'webhook' } },
  });
  return { endpoint, created: true };
}

const out = [];
try {
  console.log(`Stripe ${live ? 'LIVE' : 'test'} mode.`);
  const { product, created } = await ensureProduct();
  console.log(`${created ? 'Created' : 'Reused'} product "${product.name}" (${product.id}), tax code ${product.tax_code || TAX_CODE}.`);
  for (const spec of PRICES) {
    const { price, created: madePrice } = await ensurePrice(product, spec);
    console.log(`${madePrice ? 'Created' : 'Reused'} price ${spec.nickname}: ${price.id}`);
    out.push([spec.key, price.id]);
  }
  out.push(['MOR_PROVIDER', 'stripe']);
  out.push(['MOR_SANDBOX', live ? 'false' : 'true']);
  out.push(['MOR_MANAGED_PAYMENTS', 'true']);

  const webhookUrl = flagValue('--webhook');
  if (webhookUrl) {
    if (!/^https:\/\//.test(webhookUrl)) throw new Error('--webhook must be an https URL');
    const { endpoint, created: madeHook } = await ensureWebhook(webhookUrl);
    console.log(`${madeHook ? 'Created' : 'Reused'} webhook endpoint ${endpoint.id} → ${endpoint.url} (${(endpoint.enabled_events || []).length} events).`);
    if (endpoint.secret) out.push(['MOR_WEBHOOK_SECRET', endpoint.secret]);
    else console.log('Its signing secret was shown when it was created and cannot be read back: Developers → Webhooks → the endpoint → Reveal, or delete it and run again.');
  }

  console.log('\nPaste into Vercel → Settings → Environment Variables → Production:\n');
  for (const [name, value] of out) console.log(`  ${name}=${value}`);
  console.log('\nThen redeploy and open /api/health. The secret key itself (MOR_API_KEY) you paste from the dashboard; this script never prints it.');
} catch (error) {
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
}
