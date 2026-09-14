/**
 * js/checkout.js — the only module that opens a payment flow.
 *
 * Pages just write:
 *
 *   <button type="button" data-action="checkout" data-plan="monthly">Subscribe</button>
 *
 * and this module handles the click. `data-plan` is one of `PLANS.available`
 * from js/config.js ('monthly' or 'yearly'). Rebuilt
 * 2026-09-11 against docs/private/ACCOUNTS_BILLING_DESIGN.md §4.4 and §5.5.
 *
 * The price is never client-chosen. `subscribe(plan)`:
 *
 *   1. With no checkout token configured, renders a calm "Checkout is not open
 *      yet" card. There is no waitlist and no founding offer any more.
 *   2. With no signed-in session, sends the visitor to /signin carrying
 *      `next` and `intent=subscribe:<plan>`; /auth/callback calls subscribe()
 *      again once the session exists, on the callback page, with no page load
 *      in between (§4.4) — which is why Paddle.Initialize() is guarded by the
 *      module-level `paddleInitialised` flag: it may run only once per page.
 *   3. POSTs { plan, device_mirror } to /api/trial/eligibility with the
 *      Supabase bearer token. The server decides trial-or-not, picks the
 *      price, creates the transaction and answers with a transaction id.
 *   4. Opens the overlay with `transactionId` — NEVER an items array, NEVER a
 *      priceId — so nothing in devtools can swap in the trial price (§5.5).
 *
 * The overlay API, verified against developer.paddle.com on 2026-09-11:
 *   - script https://cdn.paddle.com/paddle/v2/paddle.js
 *   - Paddle.Environment.set('sandbox'), then Paddle.Initialize({ token })
 *   - Paddle.Checkout.open({ transactionId, settings }) — "Paddle ID of an
 *     existing transaction to use for this checkout. Use this instead of an
 *     items array to create a checkout for a transaction you previously
 *     created." `settings.allowLogout: false` keeps the buyer on the account
 *     email; `settings.successUrl` must start with https://.
 *
 * Since 2026-09-14 the server may answer with `checkout.checkout_url` instead:
 * a hosted checkout page (Stripe Checkout). Then this module simply navigates
 * there — no script, no overlay, and the page returns to /pro/thanks?rid=…
 * exactly as the overlay did. Which of the two happens is the server's
 * decision; nothing on the page changes.
 *
 * Nothing else in js/ knows a provider exists. This file is the seam on the
 * client, api/_lib/providers/ is the seam on the server, and js/config.js
 * holds the public values.
 */

import { CHECKOUT, PLANS } from './config.js';
import { track, EVENTS } from './analytics.js';
import { readDeviceMirror } from './entitlements.js';

const PADDLE_SCRIPT = 'https://cdn.paddle.com/paddle/v2/paddle.js';
const ELIGIBILITY_ENDPOINT = '/api/trial/eligibility';
const SIGNIN_PATH = '/signin';
const THANKS_PATH = '/pro/thanks';
const CANONICAL_ORIGIN = 'https://helpmebreath.com';
const AUTH_MODULE = './auth.js';

const DEDUPE_MS = 1200;
const SUPPORT_EMAIL = 'contact@helpmebreath.com';

let paddleLoader = null;
/** Paddle.Initialize() may run only once per page — and §4.4 re-enters checkout without a page load. */
let paddleInitialised = false;
/**
 * The in-flight (or just-finished) call, so a double-fired click collapses into
 * one checkout. `promise` is stored rather than the resolved value, because the
 * second click usually arrives while the first is still opening.
 */
let lastCall = { plan: null, at: 0, promise: null };

/* ------------------------------------------------------------------ helpers */

function isKnownPlan(plan) {
  return PLANS.available.includes(String(plan || ''));
}

/** The human label for an interval, e.g. "Yearly plan". */
export function planLabel(plan) {
  const def = PLANS[String(plan || '')];
  return def && def.label ? def.label : 'Help Me Breathe';
}

/** Retired spelling, kept so nothing that imported it breaks. */
export const skuLabel = planLabel;

function siteOrigin() {
  if (typeof location !== 'undefined' && location.protocol === 'https:' && location.origin) {
    return location.origin;
  }
  return CANONICAL_ORIGIN;
}

function currentPath() {
  if (typeof location === 'undefined') return '/';
  return `${location.pathname}${location.search}`;
}

/** A same-origin path: begins with one `/`, never `//`, never a scheme. */
function safeNext(value) {
  const next = String(value || '').trim();
  if (!next.startsWith('/') || next.startsWith('//') || /[\s\\]/.test(next) || /^\/[a-z][a-z0-9+.-]*:/i.test(next)) {
    return '/';
  }
  return next;
}

function prefersDark() {
  if (typeof document === 'undefined' || !document.body) return false;
  if (document.body.classList.contains('night')) return true;
  if (document.body.classList.contains('day')) return false;
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

async function loadAuth() {
  try {
    const mod = await import(AUTH_MODULE);
    if (mod && typeof mod.accessToken === 'function') {
      if (typeof mod.ready === 'function') {
        try {
          await mod.ready();
        } catch {
          /* same as signed out */
        }
      }
      return mod;
    }
  } catch {
    /* js/auth.js missing or its CDN import blocked: treat as signed out */
  }
  return null;
}

async function accessToken() {
  const mod = await loadAuth();
  if (!mod) return null;
  try {
    return (await mod.accessToken()) || null;
  } catch {
    return null;
  }
}

async function postJson(url, body, bearer) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${bearer}`,
    },
    credentials: 'same-origin',
    cache: 'no-store',
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { status: response.status, ok: response.ok, data };
}

/* ----------------------------------------------------------------- provider */

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
    script.onerror = () => {
      paddleLoader = null; // a blocked script may load on the next attempt
      reject(new Error('paddle-blocked'));
    };
    document.head.appendChild(script);
  });
  return paddleLoader;
}

async function openOverlay(intent) {
  const Paddle = await loadPaddle();
  if (!paddleInitialised) {
    const token = String(CHECKOUT.clientToken || '');
    if (CHECKOUT.sandbox && /^(live_|pk_live_)/.test(token)) {
      console.warn('[checkout] a live client token with CHECKOUT.sandbox = true; check js/config.js');
    }
    if (!CHECKOUT.sandbox && /^(test_|pk_test_)/.test(token)) {
      console.warn('[checkout] a test client token with CHECKOUT.sandbox = false; check js/config.js');
    }
    if (CHECKOUT.sandbox && Paddle.Environment && typeof Paddle.Environment.set === 'function') {
      Paddle.Environment.set('sandbox');
    }
    Paddle.Initialize({ token }); // only once per page
    paddleInitialised = true;
  }
  Paddle.Checkout.open({
    transactionId: intent.checkout.transaction_id, // NOT items[], NOT a priceId
    settings: {
      displayMode: 'overlay',
      successUrl: `${siteOrigin()}${THANKS_PATH}?rid=${encodeURIComponent(intent.reservation_id)}`,
      allowLogout: false,
      theme: prefersDark() ? 'dark' : 'light',
    },
  });
}

/* -------------------------------------------------------------------- cards */

/**
 * Where an inline card goes: an explicit `[data-checkout-slot]`, the nearest
 * timer's post-session slot, or a host inserted after the button.
 */
function cardContainer(trigger, container) {
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
    host.className = 'checkout-card-host';
    // `.table-scroll` first: a card dropped inside a table would be invalid markup.
    const anchor = trigger.closest('.table-scroll, .plan-card, .pricing-card, .cta-block, section, p') || trigger;
    anchor.parentNode.insertBefore(host, anchor.nextSibling);
    return host;
  }

  const main = doc.querySelector('main') || doc.body;
  if (!main) return null;
  const host = doc.createElement('div');
  host.className = 'checkout-card-host';
  main.appendChild(host);
  return host;
}

function renderCard(container, { kind, heading, lines, dismissLabel }) {
  container.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'post-session-card checkout-card';
  card.setAttribute('data-ask', 'checkout');
  card.setAttribute('data-checkout-card', kind);
  card.setAttribute('role', 'status');

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'card-dismiss';
  dismiss.setAttribute('aria-label', dismissLabel || 'Hide this');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => card.remove());

  const h = document.createElement('h3');
  h.textContent = heading;
  card.append(dismiss, h);

  for (const line of lines) {
    const p = document.createElement('p');
    if (line && typeof line === 'object' && line.email) {
      p.append(document.createTextNode(line.before || ''));
      const a = document.createElement('a');
      a.href = `mailto:${line.email}`;
      a.textContent = line.email;
      p.append(a, document.createTextNode(line.after || ''));
    } else {
      p.textContent = String(line);
    }
    card.appendChild(p);
  }

  container.appendChild(card);
  if (container.scrollIntoView) container.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return card;
}

/** Checkout has no client token yet: say so calmly, and never leave a dead button. */
function renderNotOpenCard(plan, trigger, target) {
  const container = cardContainer(trigger, target);
  if (!container) return { ok: false, mode: 'closed', plan, error: 'no-container' };
  const def = PLANS[plan] || PLANS[PLANS.default];
  renderCard(container, {
    kind: 'not-open',
    heading: 'Checkout is not open yet',
    lines: [
      `Subscriptions are nearly ready — $${PLANS.monthly.price} a month or $${PLANS.yearly.price} a year, everything included.`,
      `Until then, everything you were already using stays exactly as it is. The ${def.label.toLowerCase()} will be here when checkout opens.`,
      { before: 'Questions? Email ', email: SUPPORT_EMAIL, after: '.' },
    ],
  });
  return { ok: false, mode: 'closed', plan };
}

/** The server could not start a checkout: a plain explanation, no dead end. */
function renderUnavailableCard(plan, trigger, target, reason) {
  const container = cardContainer(trigger, target);
  if (!container) return { ok: false, mode: 'error', plan, error: reason };
  renderCard(container, {
    kind: 'unavailable',
    heading: 'Checkout could not start',
    lines: [
      'Nothing was charged. Try again in a minute — if it keeps happening, the problem is on our side, not yours.',
      { before: 'Email ', email: SUPPORT_EMAIL, after: ' and we will sort it out.' },
    ],
  });
  return { ok: false, mode: 'error', plan, error: reason };
}

/**
 * One sentence, shown when the server says this is a straight subscription
 * rather than a trial (§5.4). Rendered under the button so it is there when
 * the overlay closes. "One free trial per person" — those exact words.
 */
function renderNoTrialNote(plan, trigger, target, reasons) {
  const list = Array.isArray(reasons) ? reasons : [];
  if (list.includes('trial_disabled')) return; // trials are simply off; nothing to explain
  const container = cardContainer(trigger, target);
  if (!container) return;
  const def = PLANS[plan] || PLANS[PLANS.default];
  renderCard(container, {
    kind: 'no-trial',
    heading: 'A straight subscription this time',
    lines: [
      `You've had the free trial before, so this is a straight subscription — $${def.price} ${def.per}, cancel any time, ${PLANS.refundDays}-day refund. One free trial per person.`,
      { before: "If that's not right, email ", email: SUPPORT_EMAIL, after: '.' },
    ],
  });
}

/* ---------------------------------------------------------------- sign-in */

/**
 * Send a signed-out visitor to /signin, carrying where to come back to and
 * what they were trying to do. /auth/callback resumes the intent (§4.4).
 * @param {{next?:string, intent?:string}} options
 * @returns {{ok:false, mode:'signin', url:string}}
 */
export function openSignIn(options = {}) {
  const next = safeNext(options.next || currentPath());
  const intent = /^(none|subscribe:(monthly|yearly))$/.test(String(options.intent || ''))
    ? String(options.intent)
    : 'none';
  const params = new URLSearchParams({ next, intent });
  const url = `${SIGNIN_PATH}?${params.toString()}`;
  if (typeof location !== 'undefined' && typeof location.assign === 'function') location.assign(url);
  return { ok: false, mode: 'signin', url };
}

/* ------------------------------------------------------------------ public */

/**
 * Start a subscription for one interval of the plan.
 *
 * @param {'monthly'|'yearly'} plan
 * @param {{trigger?:Element, container?:Element, placement?:string}} [options]
 * @returns {Promise<{ok:boolean, mode:string, plan:string, trial?:boolean, reservationId?:string, error?:string}>}
 */
export function subscribe(plan, options = {}) {
  const key = String(plan || PLANS.default);
  if (!isKnownPlan(key)) {
    return Promise.resolve({ ok: false, mode: 'none', plan: key, error: 'unknown-plan' });
  }

  // Some pages wire their own delegated handler AND load this module, so one
  // click can reach subscribe() twice. Collapse repeats of the same plan so the
  // visitor sees one checkout and analytics sees one event.
  const now = Date.now();
  if (lastCall.plan === key && lastCall.promise && now - lastCall.at < DEDUPE_MS) {
    return lastCall.promise;
  }
  lastCall.plan = key;
  lastCall.at = now;

  const promise = runSubscribe(key, options);
  lastCall.promise = promise;
  return promise;
}

/**
 * Retired spelling, kept as an alias of subscribe() so every existing
 * `checkout(sku)` caller keeps working. The old SKUs other than the two
 * intervals were never sold and resolve to `unknown-plan`.
 * @param {string} sku
 * @param {object} [options]
 */
export function checkout(sku, options = {}) {
  return subscribe(sku, options);
}

async function runSubscribe(plan, options) {
  const trigger = options.trigger || null;
  const target = options.container || null;
  const placement = options.placement || 'page';

  if (!CHECKOUT.clientToken) return renderNotOpenCard(plan, trigger, target);

  const bearer = await accessToken();
  if (!bearer) {
    track(EVENTS.CHECKOUT_OPEN, { plan, trial: null, mode: 'signin', placement });
    return { ...openSignIn({ next: currentPath(), intent: `subscribe:${plan}` }), plan };
  }

  let result;
  try {
    result = await postJson(ELIGIBILITY_ENDPOINT, { plan, device_mirror: readDeviceMirror() }, bearer);
  } catch {
    return renderUnavailableCard(plan, trigger, target, 'network');
  }

  if (result.status === 401) {
    // The session died inside its hour. Sign in again; the intent brings them back.
    return { ...openSignIn({ next: currentPath(), intent: `subscribe:${plan}` }), plan };
  }
  const intent = result.data;
  if (!result.ok || !intent || intent.ok !== true || !intent.checkout || !intent.checkout.transaction_id) {
    const reason = intent && (intent.error || intent.reason) ? String(intent.error || intent.reason) : `http-${result.status}`;
    return renderUnavailableCard(plan, trigger, target, reason);
  }

  const trial = intent.trial === true;
  const hostedUrl = typeof intent.checkout.checkout_url === 'string' && /^https:\/\//.test(intent.checkout.checkout_url) ? intent.checkout.checkout_url : '';
  track(EVENTS.TRIAL_ELIGIBILITY_CHECK || 'trial_eligibility_check', {
    eligible: trial,
    reason: Array.isArray(intent.reasons) && intent.reasons.length ? String(intent.reasons[0]) : 'eligible',
    plan,
  });
  track(EVENTS.CHECKOUT_OPEN, { plan, trial, mode: hostedUrl ? 'redirect' : 'overlay', placement });

  if (!trial) renderNoTrialNote(plan, trigger, target, intent.reasons);

  if (hostedUrl) {
    // The hosted page is the checkout. The no-trial note above is still on the
    // page when the visitor comes back with the browser's back button.
    if (typeof location !== 'undefined' && typeof location.assign === 'function') location.assign(hostedUrl);
    return { ok: true, mode: 'redirect', plan, trial, reservationId: intent.reservation_id || null };
  }

  try {
    await openOverlay(intent);
  } catch (error) {
    // A blocked script must never leave a dead button.
    return renderUnavailableCard(plan, trigger, target, error && error.message ? error.message : 'overlay');
  }

  return { ok: true, mode: 'overlay', plan, trial, reservationId: intent.reservation_id || null };
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
  const plan = trigger.getAttribute('data-plan') || trigger.getAttribute('data-sku') || PLANS.default;
  const placement = trigger.getAttribute('data-placement') || undefined;

  // A checkout button inside an offer card is also a paywall click.
  const fromPaywall = trigger.closest('[data-ask="paywall"], [data-ask="preview"]');
  if (fromPaywall) {
    track(EVENTS.PAYWALL_CLICK, {
      plan,
      feature: fromPaywall.getAttribute('data-feature') || 'offer',
    });
  }

  subscribe(plan, { trigger, placement });
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
