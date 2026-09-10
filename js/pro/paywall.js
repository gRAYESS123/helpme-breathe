/**
 * js/pro/paywall.js — the only place an upgrade offer is allowed to appear.
 *
 * Two entry points, both deliberately quiet:
 *
 *   1. The offer card. It renders in the completing instance's
 *      `[data-slot="post-session"]` on the THIRD completed session, once ever
 *      (flag `hmb.paywall.shown`), and is dismissible forever. Never on a first
 *      or second session, never mid-session, never on a page carrying
 *      `<body data-no-asks="true">`, and never to someone who has already paid.
 *
 *   2. The feature card. `requirePro('presets')` in js/entitlements.js
 *      dispatches `hmb:paywall` with `{ feature }`; this module answers with a
 *      small inline card that names the feature the visitor just reached for.
 *      Once per page load per feature. If a session is running it waits until
 *      the session ends rather than interrupting it.
 *
 * Protecting the free experience is the whole acquisition engine. When in
 * doubt, this module shows nothing.
 */

import { completedSessionCount, getFlag, setFlag } from '../storage.js';
import { track, EVENTS } from '../analytics.js';
import { PRICES, CHECKOUT } from '../config.js';
import { isPro } from '../entitlements.js';

const FLAG_SHOWN = 'paywall.shown';
const OFFER_SESSION = 3;

const FEATURE_COPY = {
  presets: {
    name: 'Saved presets',
    line: 'Building and running your own pattern is free. Saving it under a name, and sharing it as a link, is part of Pro.',
  },
  streaks: {
    name: 'Your practice history',
    line: 'The last seven days are free. Streaks, the 12-week heatmap, the per-technique breakdown and the CSV export are part of Pro.',
  },
  night: {
    name: 'Night mode',
    line: 'A near-black screen with warm, dimmed text for practising in the dark — and the screen stays awake while you breathe.',
  },
  soundscapes: {
    name: 'Ambient soundscapes',
    line: 'Six voice-free ambiences that play under the pacer and work offline once cached.',
  },
  share: {
    name: 'Shareable pattern links',
    line: 'Send a pattern to someone as a link that opens the timer already set up.',
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

function foundingActive() {
  return CHECKOUT.founding && Number(CHECKOUT.founding.cap) > 0;
}

function priceLine() {
  return foundingActive()
    ? `$${PRICES.founding} once for the first ${CHECKOUT.founding.cap} people, then $${PRICES.lifetime}. No subscription, ever.`
    : `$${PRICES.lifetime} once. No subscription, ever.`;
}

/* ------------------------------------------------------------------ pieces */

function buildCard({ heading, body, feature, dismissLabel, onDismiss }) {
  const card = document.createElement('div');
  card.className = 'post-session-card paywall-card';
  card.setAttribute('data-ask', 'paywall');
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
  price.textContent = priceLine();

  const actions = document.createElement('div');
  actions.className = 'paywall-actions';

  const buy = document.createElement('button');
  buy.type = 'button';
  buy.className = 'paywall-buy';
  buy.setAttribute('data-action', 'checkout');
  buy.setAttribute('data-sku', 'lifetime');
  buy.setAttribute('data-placement', feature ? `feature:${feature}` : 'third-session');
  buy.textContent = foundingActive() ? `Unlock Pro — $${PRICES.founding}` : `Unlock Pro — $${PRICES.lifetime}`;

  const more = document.createElement('a');
  more.className = 'paywall-more';
  more.href = '/pro';
  more.textContent = 'See everything in Pro';
  more.addEventListener('click', () => {
    track(EVENTS.PAYWALL_CLICK, { feature: feature || 'offer', target: 'pro-page' });
  });

  actions.append(buy, more);

  const reassure = document.createElement('p');
  reassure.className = 'form-note';
  reassure.textContent =
    'Every technique on this site stays free and unlimited. 14-day refund, no questions asked.';

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
  if (completedSessionCount() !== OFFER_SESSION) return;

  const root = detail.root;
  const container = root && root.querySelector ? root.querySelector('[data-slot="post-session"]') : null;
  if (!container) return;

  const card = buildCard({
    heading: 'Three sessions in',
    body:
      'You have practised three times. If this is becoming a habit, Pro adds your own patterns and saved presets, ' +
      'your streak and 12-week heatmap, ambient soundscapes, night mode and no ads anywhere on the site.',
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
    line: 'That one is part of Pro. Everything you were already using stays free.',
  };

  shownFeatures.add(key);

  const card = buildCard({
    heading: `${copy.name} is part of Pro`,
    body: copy.line,
    feature: key,
    dismissLabel: 'Hide this',
  });

  container.innerHTML = '';
  container.appendChild(card);
  if (container.scrollIntoView) container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  track(EVENTS.PAYWALL_VIEW, { feature: key });
}

function flushPending() {
  if (!pendingFeature) return;
  const feature = pendingFeature;
  pendingFeature = null;
  // Let the post-session cards render first. If the third-session offer took
  // the slot, that offer says more than the feature card would — leave it.
  window.setTimeout(() => {
    if (document.querySelector('[data-ask="paywall"]')) return;
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
}

/** Exported for /pro and for tests: has the third-session offer been shown? */
export function offerAlreadyShown() {
  return getFlag(FLAG_SHOWN) === true;
}
