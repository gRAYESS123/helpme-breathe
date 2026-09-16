/**
 * js/config.js — the ONE file the owner edits for public provider values.
 *
 * Nothing in here is secret. The Supabase publishable key and the checkout
 * client-side token are public by design; an API key or a secret key is NOT
 * and belongs in a Vercel env var, never in this file.
 *
 * The offer, decided 2026-09-11 (docs/private/ACCOUNTS_BILLING_DESIGN.md):
 *
 *   One plan, everything included. $10 a month or $100 a year (US list
 *   price), billed in advance, renewing automatically until cancelled, tax
 *   added at checkout where it applies. 3-day card-required trial, one free
 *   trial per person. 14-day unconditional refund.
 *
 * Payments (since 2026-09-14): Stripe, under its Managed Payments service, as
 * merchant of record — Stripe is the seller on the receipt, collects tax and
 * owns refunds and disputes. If Stripe declines Managed Payments for the
 * account, checkout closes ("Checkout could not start") rather than selling
 * under a model the legal pages do not describe; the way on is to enable
 * Managed Payments in Stripe, or to set MOR_MANAGED_PAYMENTS=false in Vercel in
 * the same change that rewrites MOR_LEGAL and the legal pages to name the
 * owner as seller (docs/private/HANDOVER.md §0.0).
 *
 * Five exports, and only five:
 *
 *   SUPABASE             url + publishable key, read by js/auth.js only
 *   CHECKOUT             the checkout-open switch + sandbox flag, read by js/checkout.js only
 *   PLANS                the one plan and its two intervals
 *   TIMER_FREE_SESSIONS  D1 — read in exactly one place, js/entitlements.js#requireTimer
 *   MOR_LEGAL            the merchant-of-record sentence, one place, every page
 *
 * There is no `mode`, no hosted payment link, no price id and no waitlist any
 * more. The browser never chooses a price: js/checkout.js asks
 * POST /api/trial/eligibility, which creates the transaction server-side and
 * hands back a transaction id (design §5.4–§5.5). D3 (`TRIAL_ENABLED`) lives
 * in the server env and is read only by api/trial/eligibility.js — the client
 * learns whether a trial applies from that answer, never from a flag here.
 *
 * --------------------------------------------------------------------------
 * HOW TO FILL THIS IN (owner checklist, design §14)
 * --------------------------------------------------------------------------
 *
 *  1. Supabase → Project settings → API: copy the project URL and the
 *     publishable key into SUPABASE below. Same two values go into Vercel as
 *     SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.
 *  2. Stripe dashboard → Developers → API keys: copy the PUBLISHABLE key
 *     (`pk_test_…` or `pk_live_…`) into CHECKOUT.clientToken. It is public by
 *     design and is only the switch that opens checkout: the hosted Stripe page
 *     needs nothing from the browser. Never the secret key (`sk_…`).
 *  3. Keep CHECKOUT.sandbox `true` while the key is a `pk_test_` key. Flip it
 *     to `false` in the same edit that swaps in the `pk_live_` key — never one
 *     without the other.
 *  4. Leave previewPriceIds empty. Client-side price previews belonged to the
 *     overlay checkout; the hosted page shows the total, with tax, itself.
 *
 * While CHECKOUT.clientToken is empty, every checkout button renders a calm
 * "Checkout is not open yet" card instead of a dead link.
 */

/** Supabase project, public values only (design §10.2). */
export const SUPABASE = Object.freeze({
  /** `https://<ref>.supabase.co` */
  url: 'https://mxlfbtlpjwgeaigmcmbd.supabase.co',
  /** The publishable (anon) key. Public by design. */
  publishableKey: 'sb_publishable_XVUyMqPbYiPy2dOhzOAd5g_2jbRisbs',
});

/** The checkout switch, public values only (design §5.5). */
export const CHECKOUT = Object.freeze({
  /** Stripe publishable key (`pk_test_…` or `pk_live_…`). Public by design. Empty = checkout closed. */
  clientToken: 'pk_test_51UFWrUJITN5qhUboKYU77EQ246ztUZFxXLRMUTRZpAQPn47ZABCKFvq7TmR4nKp558fMidFNtOfeGn1gnrI2k56w00i59eSpdM',
  /**
   * `true` points the overlay at the provider's sandbox. It defaults to `true`
   * because the safer mistake is a live token refusing to open in sandbox, not
   * a test token silently pointed at production. Set `false` at go-live.
   */
  sandbox: true,
  /**
   * Optional. The public no-trial price ids (`pri_…`), used by /pro ONLY to
   * show the localized total for the visitor's country before checkout
   * (design §5.6). Never used to open a checkout: the server picks the price.
   * Leave empty and the card shows the US list price with "plus any tax".
   */
  previewPriceIds: Object.freeze({ monthly: '', yearly: '' }),
});

/**
 * PLANS. One plan, everything included; two billing intervals. Owner decisions of 2026-09-11
 * and 2026-09-12: there is no practitioner or therapist plan and there will
 * not be one, so nothing here is a switch. Everything downstream reads
 * `PLANS.available`.
 *
 * Prices are US-dollar list prices for copy. What a person is actually charged
 * comes from the provider's own price preview and receipt (design §5.6), never
 * from these numbers.
 */
const PLAN_DEFINITIONS = Object.freeze({
  monthly: Object.freeze({
    key: 'monthly',
    label: 'Monthly plan',
    price: 10,
    currency: 'USD',
    interval: 'month',
    per: 'a month',
  }),
  yearly: Object.freeze({
    key: 'yearly',
    label: 'Yearly plan',
    price: 100,
    currency: 'USD',
    interval: 'year',
    per: 'a year',
  }),
});

export const PLANS = Object.freeze({
  /** The plan keys a button may carry in `data-plan`, in display order. */
  available: Object.freeze(['monthly', 'yearly']),
  /** The interval a bare checkout button (no `data-plan`) opens. */
  default: 'monthly',
  /** Trial length in days, for copy only. Whether a trial applies is decided by the server. */
  trialDays: 3,
  /** Refund window in days (docs/AGENT_BRIEF.md rule 13). */
  refundDays: 14,
  monthly: PLAN_DEFINITIONS.monthly,
  yearly: PLAN_DEFINITIONS.yearly,
});

/**
 * D1 — how many started sessions a device may run before the timer asks for
 * an account. Owner decision 2026-09-11: 3. Read only in js/entitlements.js
 * (requireTimer() gates on it, freeAllowance() shows it). Never branch on it
 * anywhere else.
 */
export const TIMER_FREE_SESSIONS = 3;

/**
 * The merchant-of-record line, kept in one place so one edit changes every
 * page. Stripe (Managed Payments) was chosen in writing on 2026-09-14 and is
 * named.
 */
export const MOR_LEGAL =
  'Payments are handled by Stripe as merchant of record, who acts as the seller of record for this purchase. ' +
  'The price you see at checkout includes any VAT or sales tax due in your country.';
