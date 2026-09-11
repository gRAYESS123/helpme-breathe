/**
 * js/checkout.js — the only module that opens a payment flow.
 *
 * Everything provider-specific is read from js/config.js. Pages just write:
 *
 *   <button type="button" data-action="checkout" data-plan="monthly">Start free trial</button>
 *
 * and this module handles the click. `data-plan` is 'monthly' or 'yearly' —
 * the two intervals of the one plan. Three modes (see js/config.js):
 *
 *   link      → open the hosted payment link for that interval in a new tab
 *   paddle    → Paddle Billing v2 overlay checkout on our own page
 *   waitlist  → no payment configured yet: render the email capture card
 *               instead of a dead link (the default)
 *
 * Paddle Billing v2, verified against developer.paddle.com on 2026-09-09:
 *   - script: https://cdn.paddle.com/paddle/v2/paddle.js
 *   - Paddle.Environment.set("sandbox") for testing, then
 *     Paddle.Initialize({ token: "<client-side token>" })
 *   - Paddle.Checkout.open({ items: [{ priceId, quantity }], settings: { … } })
 *     where settings.displayMode is "inline" or "overlay" and settings.successUrl
 *     is the "URL to redirect to on checkout completion. Must start with
 *     http:// or https://".
 *   - A transaction reaches a page as a `_ptxn` query parameter: "You don't
 *     need to do anything to get Paddle.js to open a checkout, it automatically
 *     opens a checkout for the transaction when the query parameter is present."
 *     /pro/thanks reads `_ptxn` for that reason. Paddle's docs do NOT promise
 *     that `_ptxn` is appended to successUrl, so /pro/thanks also accepts a
 *     `?key=` licence key and always offers manual entry.
 */

import { CHECKOUT, PRICES, SKU_LABELS, isKnownSku, resolvedMode } from './config.js';
import { track, EVENTS } from './analytics.js';

const PADDLE_SCRIPT = 'https://cdn.paddle.com/paddle/v2/paddle.js';
const THANKS_URL = 'https://helpmebreath.com/pro/thanks';

const DEDUPE_MS = 1200;

let paddleLoader = null;
let paddleInitialised = false;
/**
 * The in-flight (or just-finished) call, so a double-fired click collapses into
 * one checkout. `promise` is stored rather than the resolved value, because the
 * second click usually arrives while the first is still opening — returning a
 * half-finished `null` there would break any caller that reads `result.ok`.
 */
let lastCall = { sku: null, at: 0, promise: null };

/* --------------------------------------------------------------- providers */

function loadPaddle() {
  if (paddleLoader) return paddleLoader;
  paddleLoader = new Promise((resolve, reject) => {
    if (window.Paddle) {
      resolve(window.Paddle);
      return;
    }
    const script = document.createElement('script');
    script.src = PADDLE_SCRIPT;
    script.async = true;
    script.onload = () => (window.Paddle ? resolve(window.Paddle) : reject(new Error('paddle-missing')));
    script.onerror = () => reject(new Error('paddle-blocked'));
    document.head.appendChild(script);
  });
  return paddleLoader;
}

async function openPaddle(sku) {
  const Paddle = await loadPaddle();
  if (!paddleInitialised) {
    if (CHECKOUT.sandbox && Paddle.Environment && typeof Paddle.Environment.set === 'function') {
      Paddle.Environment.set('sandbox');
    }
    Paddle.Initialize({ token: CHECKOUT.clientToken });
    paddleInitialised = true;
  }
  Paddle.Checkout.open({
    items: [{ priceId: CHECKOUT.priceIds[sku], quantity: 1 }],
    settings: {
      successUrl: `${THANKS_URL}?sku=${encodeURIComponent(sku)}`,
      displayMode: 'overlay',
    },
  });
  return { ok: true, mode: 'paddle', sku };
}

function openLink(sku) {
  const url = CHECKOUT.urls[sku];
  const opened = window.open(url, '_blank', 'noopener');
  if (!opened) window.location.href = url;
  return { ok: true, mode: 'link', sku };
}

/* ---------------------------------------------------------------- waitlist */

/**
 * The waitlist card, per SKU.
 *
 * One plan, two intervals: the copy names the interval's own price and the
 * trial length from js/config.js so a button and the card under it can never
 * disagree.
 *
 * @param {string} sku
 * @returns {{title:string, message:string, consentLabel:string, note:string, successMessage:string}}
 */
function waitlistCopy(sku) {
  const price = PRICES[sku] || PRICES.monthly;
  const period = sku === 'yearly' ? 'a year' : 'a month';
  const trial = CHECKOUT.trialDays > 0 ? `${CHECKOUT.trialDays} days free, then ` : '';

  return {
    title: 'Tell me when subscriptions open',
    message: `Subscriptions open soon — ${trial}$${price} ${period}, everything included`,
    consentLabel:
      ' Email me once when subscriptions open. You can unsubscribe from any email, and the address is used for nothing else.',
    note: 'One email to confirm, then one when checkout opens. Nothing else.',
    successMessage:
      'You are on the list. Confirm the address from the email that just went out and you will hear from us the day checkout opens.',
  };
}

function waitlistContainer(trigger, container) {
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc) return null;

  if (container) return container;

  if (trigger && typeof trigger.closest === 'function') {
    const explicit = trigger.closest('[data-checkout-slot]');
    if (explicit) return explicit;
    const app = trigger.closest('[data-breathing-app]');
    const slot = app && app.querySelector('[data-slot="post-session"]');
    if (slot) return slot;
  }

  const pageSlot = doc.querySelector('[data-checkout-slot]');
  if (pageSlot) return pageSlot;

  if (trigger && trigger.parentNode) {
    const host = doc.createElement('div');
    host.className = 'checkout-waitlist-host';
    // `.table-scroll` first: a checkout button now lives in a pricing-matrix
    // header cell, and a card dropped inside the table would be invalid markup.
    const anchor =
      trigger.closest('.table-scroll, .pricing-card, .cta-block, section, p') || trigger;
    anchor.parentNode.insertBefore(host, anchor.nextSibling);
    return host;
  }

  const main = doc.querySelector('main') || doc.body;
  if (!main) return null;
  const host = doc.createElement('div');
  host.className = 'checkout-waitlist-host';
  main.appendChild(host);
  return host;
}

async function openWaitlist(sku, trigger, target) {
  const container = waitlistContainer(trigger, target);
  if (!container) return { ok: false, mode: 'waitlist', sku, error: 'no-container' };
  const copy = waitlistCopy(sku);
  try {
    const mod = await import('./pro/capture.js');
    mod.renderCaptureCard(container, {
      // /api/subscribe accepts a slug source; this keeps the SKU signal without
      // adding a field the endpoint would ignore.
      source: `waitlist:${sku}`,
      message: copy.message,
      title: copy.title,
      submitLabel: 'Keep me posted',
      consentLabel: copy.consentLabel,
      note: copy.note,
      successMessage: copy.successMessage,
    });
  } catch {
    // capture.js missing or blocked: say so plainly rather than doing nothing.
    container.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'post-session-card';
    card.setAttribute('data-ask', 'waitlist');
    const heading = document.createElement('h3');
    heading.textContent = copy.title;
    const body = document.createElement('p');
    body.textContent = `${copy.message}. Email contact@helpmebreath.com and you are on the list.`;
    card.append(heading, body);
    container.appendChild(card);
  }
  if (container.scrollIntoView) {
    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  return { ok: true, mode: 'waitlist', sku };
}

/* ------------------------------------------------------------------ public */

/**
 * Open checkout for one SKU.
 *
 * @param {'monthly'|'yearly'} sku
 * @param {{trigger?:Element, container?:Element, placement?:string}} [options]
 * @returns {Promise<{ok:boolean, mode:string, sku:string, error?:string}>}
 */
export function checkout(sku, options = {}) {
  const key = String(sku || '');
  if (!isKnownSku(key)) {
    return Promise.resolve({ ok: false, mode: 'none', sku: key, error: 'unknown-sku' });
  }

  // Some pages wire their own delegated handler AND load this module, so one
  // click can reach checkout() twice. Collapse repeats of the same SKU so the
  // visitor sees one checkout and analytics sees one event.
  const now = Date.now();
  if (lastCall.sku === key && lastCall.promise && now - lastCall.at < DEDUPE_MS) {
    return lastCall.promise;
  }
  lastCall.sku = key;
  lastCall.at = now;

  const promise = runCheckout(key, options);
  lastCall.promise = promise;
  return promise;
}

async function runCheckout(key, options) {
  const mode = resolvedMode(key);
  const trigger = options.trigger || null;
  const target = options.container || null;

  track(EVENTS.CHECKOUT_OPEN, {
    sku: key,
    plan: key,
    trial: CHECKOUT.trialDays > 0,
    mode,
    price: PRICES[key] || null,
    placement: options.placement || 'page',
  });

  try {
    if (mode === 'link') return openLink(key);
    if (mode === 'paddle') return await openPaddle(key);
    return await openWaitlist(key, trigger, target);
  } catch {
    // A blocked script or a refused popup must never leave a dead button.
    return openWaitlist(key, trigger, target);
  }
}

/** The label a button should show for an interval, e.g. "Yearly plan". */
export function skuLabel(sku) {
  return SKU_LABELS[String(sku || '')] || 'Help Me Breathe Pro';
}

/* ------------------------------------------------------- delegated clicks */

function onDocumentClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;
  const trigger = target.closest('[data-action="checkout"]');
  if (!trigger) return;
  event.preventDefault();

  // `data-plan` is the name the billing design uses; `data-sku` is the older
  // spelling and still works. Both name an interval of the one plan.
  const sku = trigger.getAttribute('data-plan') || trigger.getAttribute('data-sku') || 'monthly';
  const placement = trigger.getAttribute('data-placement') || undefined;

  // A checkout button inside an offer card is also a paywall click.
  const fromPaywall = trigger.closest('[data-ask="paywall"]');
  if (fromPaywall) {
    track(EVENTS.PAYWALL_CLICK, {
      sku,
      feature: fromPaywall.getAttribute('data-feature') || 'offer',
    });
  }

  checkout(sku, { trigger, placement });
}

// `window.__hmbCheckoutBound` is the agreed flag: a page that wires its own
// delegated checkout handler sets it, and this module then stays out of the way
// rather than firing the same click twice.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (!window.__hmbCheckoutBound) {
    window.__hmbCheckoutBound = true;
    document.addEventListener('click', onDocumentClick);
  }
}
