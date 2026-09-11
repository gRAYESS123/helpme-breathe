/**
 * js/config.js — the ONE file the owner edits after creating the plan at the
 * merchant of record. Nothing else in the codebase knows a provider exists.
 *
 * The offer, decided 2026-09-11 (docs/private/ACCOUNTS_BILLING_DESIGN.md):
 *
 *   One plan, everything included.
 *   $10 a month or $100 a year (US list price), 3-day free trial with a card
 *   on file, one free trial per person. Cancel any time.
 *
 * Swapping merchant of record is meant to be a one-file change: edit `mode`,
 * `clientToken`, `urls` and `priceIds` below and redeploy. No feature file, no
 * page and no gate changes.
 *
 * --------------------------------------------------------------------------
 * HOW TO FILL THIS IN (owner checklist)
 * --------------------------------------------------------------------------
 *
 * A. Hosted payment links ("link" mode)
 *    1. In the merchant-of-record dashboard create two prices on one product:
 *         Help Me Breathe — monthly   $10 / month,  3-day trial
 *         Help Me Breathe — yearly    $100 / year,  3-day trial
 *    2. Copy each price's hosted checkout link into `urls` below.
 *    3. Set `mode: 'link'`.
 *    4. Set the success URL of both to https://helpmebreath.com/pro/thanks
 *
 * B. Overlay checkout on our own page ("paddle" mode — Paddle Billing v2)
 *    1. Paddle dashboard → Developer tools → Authentication → Client-side
 *       tokens. Create one and paste it into `clientToken`. A client-side
 *       token is public by design. An API key is NOT — it belongs in a Vercel
 *       env var, never here.
 *    2. Catalog → Products → copy the two price ids (`pri_…`) into `priceIds`.
 *    3. Checkout → Website approval: add helpmebreath.com, or the overlay
 *       refuses to open.
 *    4. Checkout → Default payment link: https://helpmebreath.com/pro/thanks
 *    5. Set `mode: 'paddle'`.
 *
 * C. Not selling yet ("waitlist" mode — the default)
 *    Every checkout button opens an email capture card instead of a dead link.
 *    Nothing to configure. This is what ships until step A or B is done.
 *
 *    While this stays on 'waitlist', /pro's structured data must say
 *    https://schema.org/PreOrder, which it does. Flip it to InStock in
 *    pro.html in the same commit that turns checkout on.
 *
 * Sandbox testing: set `sandbox: true` to point Paddle at its sandbox
 * environment. Set it back to false before taking real money.
 */

/** The two billing intervals of the one plan. Keys of `urls` and `priceIds`. */
export const SKUS = Object.freeze(['monthly', 'yearly']);

/** Alias, in the language of the billing design: a "plan" is an interval. */
export const PLANS = SKUS;

export const CHECKOUT = {
  /**
   * 'waitlist' — collect emails, no payment yet (default)
   * 'link'     — open the hosted payment link in `urls[plan]`
   * 'paddle'   — open Paddle Billing's overlay checkout using `priceIds[plan]`
   */
  mode: 'waitlist',

  /** Paddle client-side token (starts with `live_` or `test_`). Public by design. */
  clientToken: '',

  /** Set true to use Paddle's sandbox environment. Only used in 'paddle' mode. */
  sandbox: false,

  /** Hosted payment links, used when `mode: 'link'`. */
  urls: {
    monthly: '',
    yearly: '',
  },

  /** Provider price ids, used when `mode: 'paddle'`. */
  priceIds: {
    monthly: '',
    yearly: '',
  },

  /** Free-trial length in days, card required, one per person. 0 disables. */
  trialDays: 3,

  /**
   * Kept so older modules that read it keep working; there is no founding
   * offer under the one-plan model.
   */
  founding: { code: '', cap: 0 },
};

/**
 * Display prices in US dollars. Used by /pro, the home page band and the
 * offer cards so the numbers live in one place. These are what the page
 * *says*; the provider is what actually charges, so keep them in step.
 */
export const PRICES = Object.freeze({
  monthly: 10,
  yearly: 100,
});

/** Human labels for each interval, used in analytics params and card copy. */
export const SKU_LABELS = Object.freeze({
  monthly: 'Monthly plan',
  yearly: 'Yearly plan',
});

/**
 * The merchant-of-record line, kept in one place so one edit changes every
 * page. Replace the provider name in the same commit that turns checkout on.
 */
export const MOR_LEGAL =
  'Payments are handled by a merchant of record, who acts as the seller for this purchase. ' +
  'The price you see at checkout includes any VAT or sales tax due in your country.';

/** True when `sku` is an interval we know how to sell. */
export function isKnownSku(sku) {
  return SKUS.includes(String(sku || ''));
}

/**
 * What `checkout(plan)` will actually do right now. Kept here so the UI can
 * ask without duplicating the rules.
 * @param {string} sku
 * @returns {'link'|'paddle'|'waitlist'}
 */
export function resolvedMode(sku) {
  const key = String(sku || '');
  if (CHECKOUT.mode === 'link' && CHECKOUT.urls[key]) return 'link';
  if (CHECKOUT.mode === 'paddle' && CHECKOUT.clientToken && CHECKOUT.priceIds[key]) return 'paddle';
  return 'waitlist';
}
