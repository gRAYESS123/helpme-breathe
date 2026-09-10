/**
 * js/config.js — the ONE file the owner edits after creating products at the
 * merchant of record. Nothing else in the codebase knows a provider exists.
 *
 * Swapping merchant of record is meant to be a one-file change: edit `mode`,
 * `clientToken`, `urls` and `priceIds` below and redeploy. No feature file, no
 * page and no gate changes.
 *
 * --------------------------------------------------------------------------
 * HOW TO FILL THIS IN (owner checklist)
 * --------------------------------------------------------------------------
 *
 * A. Simplest path — hosted payment links ("link" mode)
 *    1. In your merchant-of-record dashboard create five products:
 *         Pro lifetime            $19 one-time   (founding price $14, see `founding`)
 *         Pro monthly             $3.99/month    (optional; delete if you skip it)
 *         Practitioner licence    $99/year
 *         Studio licence          $199/year
 *         Protocol Pack           $19 one-time
 *    2. For each one, copy its hosted checkout / payment link.
 *    3. Paste each link into `urls` below, keeping the same key names.
 *    4. Set `mode: 'link'`.
 *    5. Set the success/redirect URL of every product to
 *         https://helpmebreath.com/pro/thanks
 *       so buyers land on the activation page.
 *
 * B. Overlay checkout on our own page ("paddle" mode — Paddle Billing v2)
 *    1. Paddle dashboard → Developer tools → Authentication → Client-side
 *       tokens. Create one and paste it into `clientToken` below. A client-side
 *       token is public by design: it is safe in this file. An API key is NOT —
 *       never paste an API key here, it belongs in a Vercel env var.
 *    2. Paddle dashboard → Catalog → Products → each price has an id that looks
 *       like `pri_01h1vjfevh5etwq3rb416a23h2`. Paste those into `priceIds`.
 *    3. Paddle dashboard → Checkout → Website approval: add `helpmebreath.com`
 *       (and any preview domain) to the approved domains list, or the overlay
 *       refuses to open.
 *    4. Paddle dashboard → Checkout → Default payment link: set it to
 *       https://helpmebreath.com/pro/thanks — Paddle appends `?_ptxn=txn_…` to
 *       that link when it emails or links a transaction, and /pro/thanks reads it.
 *    5. Set `mode: 'paddle'`.
 *
 * C. Not selling yet ("waitlist" mode — the default)
 *    Every checkout button opens the founding-member email capture card instead
 *    of a dead link. Nothing to configure. This is what ships until step A or B
 *    is done, so the buttons are never broken.
 *
 * Sandbox testing: set `sandbox: true` to point Paddle at its sandbox
 * environment. Set it back to false before taking real money.
 */

/** Every SKU the site can sell. Keys of `urls` and `priceIds` match this list. */
export const SKUS = Object.freeze(['lifetime', 'monthly', 'practitioner', 'studio', 'pack']);

export const CHECKOUT = {
  /**
   * 'waitlist' — collect founding-member emails, no payment yet (default)
   * 'link'     — open the hosted payment link in `urls[sku]`
   * 'paddle'   — open Paddle Billing's overlay checkout using `priceIds[sku]`
   */
  mode: 'waitlist',

  /**
   * Paddle client-side token (starts with `live_` or `test_`). Public by
   * design. Only used when `mode: 'paddle'`.
   */
  clientToken: '',

  /** Set true to use Paddle's sandbox environment. Only used in 'paddle' mode. */
  sandbox: false,

  /**
   * Hosted payment links, used when `mode: 'link'`.
   * Paste the full https:// URL for each product. Leave a SKU empty and its
   * button falls back to the waitlist card rather than breaking.
   */
  urls: {
    lifetime: '',
    monthly: '',
    practitioner: '',
    studio: '',
    pack: '',
  },

  /**
   * Provider price ids, used when `mode: 'paddle'`.
   * Paddle Billing ids look like `pri_01h1vjfevh5etwq3rb416a23h2`.
   */
  priceIds: {
    lifetime: '',
    monthly: '',
    practitioner: '',
    studio: '',
    pack: '',
  },

  /**
   * Founding-member offer: the first `cap` lifetime buyers pay $14 instead of
   * $19. `code` is the discount code to create in the provider dashboard and to
   * show on /pro. When the cap is reached, delete the code at the provider and
   * set `cap: 0` here so the page stops advertising it.
   */
  founding: {
    code: 'FOUNDING14',
    cap: 100,
  },
};

/**
 * Display prices in US dollars. Used by /pro and by the offer cards so the
 * numbers live in one place. These are what the page *says*; the provider is
 * what actually charges, so keep them in step.
 */
export const PRICES = Object.freeze({
  lifetime: 19,
  founding: 14,
  monthly: 3.99,
  practitioner: 99,
  studio: 199,
  pack: 19,
});

/** Human labels for each SKU, used in analytics params and card copy. */
export const SKU_LABELS = Object.freeze({
  lifetime: 'Pro lifetime',
  monthly: 'Pro monthly',
  practitioner: 'Practitioner licence',
  studio: 'Studio licence',
  pack: 'Protocol Pack',
});

/** True when `sku` is one we know how to sell. */
export function isKnownSku(sku) {
  return SKUS.includes(String(sku || ''));
}

/**
 * What `checkout(sku)` will actually do right now. Kept here so the UI can ask
 * without duplicating the rules.
 * @param {string} sku
 * @returns {'link'|'paddle'|'waitlist'}
 */
export function resolvedMode(sku) {
  const key = String(sku || '');
  if (CHECKOUT.mode === 'link' && CHECKOUT.urls[key]) return 'link';
  if (CHECKOUT.mode === 'paddle' && CHECKOUT.clientToken && CHECKOUT.priceIds[key]) return 'paddle';
  return 'waitlist';
}
