/**
 * js/pro/paywall.js — the only place an upgrade offer is allowed to appear.
 *
 * One plan, two intervals (docs/private/ACCOUNTS_BILLING_DESIGN.md D2). Two
 * entry points, both deliberately quiet:
 *
 *   1. The offer card. It renders in the completing instance's
 *      `[data-slot="post-session"]` on the THIRD completed session, once ever
 *      (flag `hmb.paywall.shown`), and is dismissible forever. Never on a
 *      first or second session, never mid-session, never on a page carrying
 *      `<body data-no-asks="true">`, and never to someone who already pays.
 *
 *   2. The feature card. `requirePro('presets')` in js/entitlements.js
 *      dispatches `hmb:paywall` with `{ feature }`, and `requireAccount()`
 *      dispatches `hmb:signin`; this module answers both with a small inline
 *      card that names the feature the visitor just reached for. Once per page
 *      load per feature. If a session is running it waits until the session
 *      ends rather than interrupting it.
 *
 * The timer itself is NOT this module's card: `feature: 'timer'` is handled
 * by js/pro/preview.js (the §8.2 preview state) and ignored here, so the
 * post-session slot never carries two cards for one Start.
 *
 * Every button is a plain `data-action="checkout"` button. js/checkout.js
 * decides what it does: signed out → /signin with the intent to subscribe,
 * signed in → the server-created checkout. So the card needs no sign-in
 * branch of its own.
 *
 * Protecting the free experience is the whole acquisition engine. When in
 * doubt, this module shows nothing.
 */

import { completedSessionCount, getFlag, setFlag } from '../storage.js';
import { track, EVENTS } from '../analytics.js';
import { PLANS } from '../config.js';
import { isPro, signedIn, getLicenseInfo } from '../entitlements.js';

const FLAG_SHOWN = 'paywall.shown';
const OFFER_SESSION = 3;

const FEATURE_COPY = {
  presets: {
    name: 'Saved presets',
    line: 'Building and running your own pattern is free. Saving it under a name, and sharing it as a link, is part of the plan.',
  },
  streaks: {
    name: 'Your practice history',
    line: 'The last seven days are free. Streaks, the 12-week heatmap, the per-technique breakdown and the CSV export are part of the plan.',
  },
  night: {
    name: 'The night switch',
    line: 'The page already follows your device, free. The plan adds the switch, so you can hold it dark on a bright phone or light on a dark one — and it keeps the screen awake while you breathe.',
  },
  soundscapes: {
    name: 'Ambient soundscapes',
    line: 'Six voice-free ambiences that play under the pacer and work offline once cached.',
  },
  share: {
    name: 'Shareable pattern links',
    line: 'Send a pattern to someone as a link that opens the timer already set up.',
  },
  'handout-branding': {
    name: 'Branded handouts',
    line: 'Printable handouts with your own name and logo are part of the plan, alongside client links and the white-label embed.',
  },
};

const shownFeatures = new Set();
let wired = false;
let pendingFeature = null;

function asksBlocked() {
  const body = document.body;
  if (!body) return true;
  if (body.dataset && body.dataset.noAsks === 'true') return true;
  return false;
}

function sessionRunning() {
  return !!(document.body && document.body.classList.contains('session-active'));
}

/**
 * The one sentence every card carries, in the design's own words (§8.2):
 * "$10 a month or $100 a year — everything included. 14 days, unconditional refund."
 */
export function planLine() {
  return `$${PLANS.monthly.price} a month or $${PLANS.yearly.price} a year — everything included. ${PLANS.refundDays} days, unconditional refund.`;
}

/**
 * Whether a trial may honestly be promised on a button. Only a signed-in
 * visitor whose last /api/me said `trial.available: true` gets trial wording;
 * everyone else sees "Subscribe". The server decides at checkout either way.
 */
function trialKnownAvailable() {
  const info = getLicenseInfo();
  return signedIn() && info.trialAvailable === true;
}

/* ------------------------------------------------------------------ pieces */

/**
 * The card. Exported so js/pro/preview.js renders the same body and buttons
 * under its own heading and copy.
 *
 * @param {{
 *   heading:string, body:string, feature:string|null, ask?:string,
 *   dismissLabel?:string, onDismiss?:Function, primaryLabel?:string, note?:string
 * }} options
 * @returns {HTMLElement}
 */
export function buildCard({ heading, body, feature, ask, dismissLabel, onDismiss, primaryLabel, note }) {
  const card = document.createElement('div');
  card.className = 'post-session-card paywall-card';
  card.setAttribute('data-ask', ask || 'paywall');
  if (feature) card.setAttribute('data-feature', feature);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'card-dismiss';
  dismiss.setAttribute('aria-label', dismissLabel || 'Dismiss this offer');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => {
    card.remove();
    if (typeof onDismiss === 'function') onDismiss();
  });

  const h = document.createElement('h3');
  h.textContent = heading;

  const p = document.createElement('p');
  p.textContent = body;

  const price = document.createElement('p');
  price.className = 'paywall-price';
  price.textContent = planLine();

  const actions = document.createElement('div');
  actions.className = 'paywall-actions';

  const placement = feature ? `feature:${feature}` : 'third-session';

  const monthly = document.createElement('button');
  monthly.type = 'button';
  monthly.className = 'paywall-buy';
  monthly.setAttribute('data-action', 'checkout');
  monthly.setAttribute('data-plan', 'monthly');
  monthly.setAttribute('data-placement', placement);
  if (primaryLabel) monthly.textContent = primaryLabel;
  else if (trialKnownAvailable()) monthly.textContent = `Start the ${PLANS.trialDays}-day free trial`;
  else monthly.textContent = `Subscribe — $${PLANS.monthly.price} a month`;

  const yearly = document.createElement('button');
  yearly.type = 'button';
  yearly.className = 'pro-btn';
  yearly.setAttribute('data-action', 'checkout');
  yearly.setAttribute('data-plan', 'yearly');
  yearly.setAttribute('data-placement', placement);
  yearly.textContent = `Yearly — $${PLANS.yearly.price}`;

  const more = document.createElement('a');
  more.className = 'paywall-more';
  more.href = '/pro';
  more.textContent = 'See everything included';
  more.addEventListener('click', () => {
    track(EVENTS.PAYWALL_CLICK, { feature: feature || 'offer', target: 'pro-page' });
  });

  actions.append(monthly, yearly, more);

  const reassure = document.createElement('p');
  reassure.className = 'form-note';
  reassure.textContent =
    note ||
    `Cancel any time from your account page. ${PLANS.refundDays}-day refund, no reason needed. One free trial per person.`;

  card.append(dismiss, h, p, price, actions, reassure);
  return card;
}

/* ------------------------------------------------------------- offer card */

function onSessionComplete(event) {
  flushPending(event);

  const detail = event.detail || {};
  if (detail.completed !== true) return;
  if (asksBlocked()) return;
  // Someone who already paid must never be sold to again. The flag is left
  // alone so the offer is still there if they ever drop back to free.
  if (isPro()) return;
  if (getFlag(FLAG_SHOWN) === true) return;
  // `<` not `!==`. A user whose exact third session lands on a data-no-asks page
  // returns above before the flag is set; with strict equality the count then
  // passes three and the offer could never appear again, on any page, ever. The
  // FLAG_SHOWN guard above already keeps it to one showing.
  if (completedSessionCount() < OFFER_SESSION) return;

  const root = detail.root;
  const container = root && root.querySelector ? root.querySelector('[data-slot="post-session"]') : null;
  if (!container) return;

  const card = buildCard({
    heading: 'Three sessions in',
    body:
      'You have practised three times. If this is becoming a habit, one plan unlocks everything: your own patterns and saved presets, ' +
      'your streak and 12-week heatmap, ambient soundscapes, night mode, and no ads anywhere on the site.',
    feature: null,
    dismissLabel: 'No thanks, hide this',
  });

  container.innerHTML = '';
  container.appendChild(card);
  setFlag(FLAG_SHOWN, true);
  track(EVENTS.PAYWALL_VIEW, { feature: 'third-session', sessions: OFFER_SESSION });
}

/* ----------------------------------------------------------- feature card */

function isVisible(node) {
  if (!node) return false;
  if (node.offsetParent !== null) return true;
  return typeof node.getClientRects === 'function' && node.getClientRects().length > 0;
}

/**
 * Where a feature card goes.
 *
 * A `[data-paywall-slot]` lives inside the panel that owns the locked control,
 * so a card shown from an open panel lands right under the button that was
 * pressed. Those panels are hidden when closed, though — the "Night mode"
 * toggle sits in the tools row and every panel can be shut — so an invisible
 * slot is never used. The post-session slot next to the timer is the fallback,
 * because it is always in the page and always visible.
 */
function featureSlot() {
  const slots = Array.from(document.querySelectorAll('[data-paywall-slot]'));
  const visibleSlot = slots.find(isVisible);
  if (visibleSlot) return visibleSlot;

  const active = document.activeElement;
  const app = active && active.closest ? active.closest('[data-breathing-app]') : null;
  // An empty post-session slot is `display: none`, so it never tests as
  // visible — filling it is what makes it appear. Take it as it is.
  const near = app && app.querySelector('[data-slot="post-session"]');
  if (near) return near;

  const post = document.querySelector('[data-slot="post-session"]');
  if (post) return post;

  return slots.length ? slots[0] : null;
}

function showFeatureCard(feature) {
  if (asksBlocked()) return;
  // `requirePro()` only dispatches when the visitor is free, but this module
  // must not depend on that being the only source of the event.
  if (isPro()) return;
  const key = String(feature || '').trim() || 'pro';
  // The timer's own gate renders the preview card (js/pro/preview.js).
  if (key === 'timer') return;
  if (shownFeatures.has(key)) return;

  if (sessionRunning()) {
    // Never interrupt a practice. Show it when the session ends.
    pendingFeature = key;
    return;
  }

  const container = featureSlot();
  if (!container) return;

  const copy = FEATURE_COPY[key] || {
    name: 'This feature',
    line: 'That one is part of the plan. Everything you were already using stays free.',
  };

  shownFeatures.add(key);

  const card = buildCard({
    heading: signedIn() ? `${copy.name} is part of the plan` : `${copy.name} needs an account`,
    body: signedIn()
      ? copy.line
      : `${copy.line} Create an account or sign in, and subscribe from there.`,
    feature: key,
    dismissLabel: 'Hide this',
  });

  container.innerHTML = '';
  container.appendChild(card);
  if (container.scrollIntoView) container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  track(EVENTS.PAYWALL_VIEW, { feature: key });
  if (!signedIn()) track(EVENTS.SIGNIN_VIEW || 'signin_view', { source: 'paywall', feature: key });
}

function flushPending() {
  if (!pendingFeature) return;
  const feature = pendingFeature;
  pendingFeature = null;
  // Let the post-session cards render first. If the third-session offer or
  // the preview card took the slot, that card says more than this one would.
  window.setTimeout(() => {
    if (document.querySelector('[data-ask="paywall"], [data-ask="preview"]')) return;
    showFeatureCard(feature);
  }, 0);
}

function onPaywallRequest(event) {
  const detail = event.detail || {};
  showFeatureCard(detail.feature);
}

/** Register the document-level listeners. Safe to call more than once. */
export function initPaywall() {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  document.addEventListener('hmb:session-complete', onSessionComplete);
  document.addEventListener('hmb:session-stop', flushPending);
  document.addEventListener('hmb:paywall', onPaywallRequest);
  document.addEventListener('hmb:signin', onPaywallRequest);
}

/** Exported for /pro and for tests: has the third-session offer been shown? */
export function offerAlreadyShown() {
  return getFlag(FLAG_SHOWN) === true;
}
