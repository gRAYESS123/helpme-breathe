/**
 * js/pro/preview.js — the timer's preview state (design §8.2).
 *
 * A timer page past the free-session allowance is NOT a wall. The page stays
 * fully readable — description, contraindications, the science, the FAQ — and
 * the breathing section still shows the circle. When js/app.js's start()
 * finds `requireTimer()` false it enters preview mode instead of running and
 * dispatches `hmb:preview` on `document` with
 *
 *   { reason: 'free_sessions_used' | 'signed_out' | 'no_subscription',
 *     root, instance, technique, phases? }
 *
 * This module answers by doing two things:
 *
 *   1. It leaves the disc still. (Until 2026-09-14 it animated one
 *      demonstration cycle; the owner asked for the timer to be plainly
 *      behind the plan, so nothing moves once the allowance is spent.)
 *
 *   2. It renders one card into the instance's `[data-slot="post-session"]`:
 *
 *        Create an account to keep going
 *        $10 a month or $100 a year — everything included. 14 days, unconditional refund.
 *        [Create account or sign in] · [See what's included]
 *
 *      and, for a signed-in visitor without a subscription, the same card with
 *      the two checkout buttons instead of the sign-in link.
 *
 * It also stamps `body.timer-preview` so js/ads.js refuses to fill a slot
 * while the preview is showing (§8.3): the first thing a person sees on a
 * timer page is never an ad next to a sign-in prompt.
 *
 * The two crisis pages carry `data-open-timer`, so
 * requireTimer() never fails there and this module never renders.
 */

import { getTechnique, cycleSeconds } from '../techniques.js';
import { PLANS } from '../config.js';
import { isPro, signedIn, status, onChange, getLicenseInfo } from '../entitlements.js';
import { track, EVENTS } from '../analytics.js';
import { buildCard, planLine } from './paywall.js';

const PREVIEW_CLASS = 'timer-preview';
const SIGNIN_PATH = '/signin';

/**
 * stroke-dashoffset of an empty ring, in the ring's own units. Must match
 * RING_EMPTY in js/app.js and --ring-arc in css/styles.css (312 degrees of a
 * circle with r=150). Duplicated here because the engine does not export it.
 */
const RING_EMPTY = 816.81;

let wired = false;

/** Running demonstrations, one per app root. */
const demos = new WeakMap();

/* ------------------------------------------------------------------ helpers */

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function asksBlocked() {
  const body = document.body;
  return !body || (body.dataset && body.dataset.noAsks === 'true');
}

function resolveRoot(detail) {
  if (detail.root && detail.root.querySelector) return detail.root;
  return document.querySelector('[data-breathing-app]');
}

function resolvePhases(detail) {
  if (Array.isArray(detail.phases) && detail.phases.length) return detail.phases;
  if (detail.instance && typeof detail.instance.getState === 'function') {
    try {
      const state = detail.instance.getState();
      if (state && Array.isArray(state.phases) && state.phases.length) return state.phases;
    } catch {
      /* fall through to the technique */
    }
  }
  const technique = getTechnique(detail.technique);
  return technique ? technique.phases : [];
}

function phaseKind(phase) {
  const first = String((phase && phase.class) || '').trim().split(/\s+/)[0];
  return first || String((phase && phase.name) || '').toLowerCase();
}

function phaseState(phase) {
  const classes = String((phase && phase.class) || '').trim().split(/\s+/);
  if (classes.indexOf('inhale-short') !== -1) return 'topup';
  return phaseKind(phase);
}

function setText(node, text) {
  if (node) node.textContent = text;
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return '';
  }
}

/* ------------------------------------------------------- demonstration */

/**
 * Animate one cycle of `phases` on the timer inside `root`, then put the
 * circle back to "Ready". Uses the same attributes the engine writes
 * (`data-phase`, `--phase-duration`, `--ring-from`/`--ring-to`, the phase
 * classes) so css/styles.css renders it identically. Idempotent: a second
 * call while a demonstration runs does nothing.
 *
 * @param {Element} root the `[data-breathing-app]` element
 * @param {Array<{name:string, duration:number, class:string, text:string}>} phases
 * @returns {boolean} true when a demonstration started
 */
export function runDemonstration(root, phases) {
  if (!root || !Array.isArray(phases) || !phases.length) return false;
  if (demos.has(root)) return false;
  if (document.body && document.body.classList.contains('session-active')) return false;

  const el = {
    circle: root.querySelector('[data-role="circle"]'),
    circleText: root.querySelector('[data-role="circle-text"]'),
    phaseCount: root.querySelector('[data-role="phase-count"]'),
    breathingText: root.querySelector('[data-role="breathing-text"]'),
    liveRegion: root.querySelector('[data-role="live-region"]'),
  };
  const restore = {
    circleText: el.circleText ? el.circleText.textContent : '',
    breathingText: el.breathingText ? el.breathingText.textContent : '',
  };

  const demo = { timer: null, phaseClasses: [], ringLevel: RING_EMPTY };
  demos.set(root, demo);
  root.dataset.previewDemo = 'running';

  const cycle = cycleSeconds(phases);
  if (el.circle) {
    el.circle.classList.add('active');
    if (!prefersReducedMotion()) {
      el.circle.style.animation = 'none';
      void el.circle.offsetHeight; // restart the scale animation from zero
      el.circle.style.animation = '';
    }
    if (cycle > 0) el.circle.style.animationDuration = `${cycle}s`;
  }

  const applyPhase = (phase) => {
    const kind = phaseState(phase);
    root.dataset.phase = kind;
    root.style.setProperty('--phase-duration', `${Number(phase.duration) || 0}s`);
    const from = demo.ringLevel;
    if (kind === 'inhale' || kind === 'topup') demo.ringLevel = 0;
    else if (kind === 'exhale') demo.ringLevel = RING_EMPTY;
    root.style.setProperty('--ring-from', String(from));
    root.style.setProperty('--ring-to', String(demo.ringLevel));
    if (el.circle) {
      for (const cls of demo.phaseClasses) el.circle.classList.remove(cls);
      demo.phaseClasses = String(phase.class || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      for (const cls of demo.phaseClasses) el.circle.classList.add(cls);
      el.circle.dataset.phase = kind;
    }
    setText(el.circleText, phase.name);
    setText(el.phaseCount, String(Math.max(1, Math.ceil(Number(phase.duration) || 1))));
    setText(el.breathingText, phase.text || '');
    const unit = Number(phase.duration) === 1 ? 'second' : 'seconds';
    setText(el.liveRegion, `Preview. ${phase.name} for ${phase.duration} ${unit}`);
  };

  const clear = () => {
    delete root.dataset.phase;
    delete root.dataset.previewDemo;
    root.style.removeProperty('--phase-duration');
    root.style.removeProperty('--ring-from');
    root.style.removeProperty('--ring-to');
    if (el.circle) {
      for (const cls of demo.phaseClasses) el.circle.classList.remove(cls);
      el.circle.classList.remove('active');
      delete el.circle.dataset.phase;
    }
    demos.delete(root);
  };

  let index = 0;
  const step = () => {
    if (index >= phases.length) {
      clear();
      setText(el.circleText, restore.circleText || 'Ready');
      setText(el.breathingText, restore.breathingText || 'Press Begin to start your practice');
      setText(el.phaseCount, '');
      return;
    }
    const phase = phases[index];
    index += 1;
    applyPhase(phase);
    demo.timer = window.setTimeout(step, Math.max(250, (Number(phase.duration) || 1) * 1000));
  };

  demo.cancel = () => {
    if (demo.timer) window.clearTimeout(demo.timer);
    demo.timer = null;
    clear();
    setText(el.phaseCount, '');
  };

  step();
  return true;
}

function cancelDemonstration(root) {
  const demo = root && demos.get(root);
  if (demo && typeof demo.cancel === 'function') demo.cancel();
}

/* ------------------------------------------------------------------ card */

function signInHref() {
  const next = `${location.pathname}${location.search}`;
  const params = new URLSearchParams({ next, intent: 'none' });
  return `${SIGNIN_PATH}?${params.toString()}`;
}

/**
 * Render the §8.2 card into `container`.
 * @param {Element} container
 * @param {{reason?:string, technique?:string}} options
 * @returns {HTMLElement|null}
 */
export function renderPreviewCard(container, options = {}) {
  if (!container) return null;
  const reason = String(options.reason || 'free_sessions_used');
  const info = getLicenseInfo();
  const ended = signedIn() && status() === 'canceled' && !isPro();

  let card;
  if (!signedIn()) {
    card = document.createElement('div');
    card.className = 'post-session-card paywall-card preview-card';
    card.setAttribute('data-ask', 'preview');
    card.setAttribute('data-feature', 'timer');
    card.setAttribute('data-reason', reason);

    const h = document.createElement('h3');
    h.textContent = 'Create an account to keep going';

    const body = document.createElement('p');
    body.textContent =
      'The free sessions on this device are used up. An account and the plan keep the timer running, on every device you sign in on.';

    const price = document.createElement('p');
    price.className = 'paywall-price';
    price.textContent = planLine();

    const actions = document.createElement('div');
    actions.className = 'paywall-actions';

    const signin = document.createElement('a');
    signin.className = 'paywall-buy';
    signin.href = signInHref();
    signin.setAttribute('data-preview-action', 'signin');
    signin.textContent = 'Create account or sign in';
    signin.addEventListener('click', () => {
      track(EVENTS.PAYWALL_CLICK, { feature: 'timer', target: 'signin' });
    });

    const more = document.createElement('a');
    more.className = 'paywall-more';
    more.href = '/pro';
    more.textContent = "See what's included";
    more.addEventListener('click', () => {
      track(EVENTS.PAYWALL_CLICK, { feature: 'timer', target: 'pro-page' });
    });

    actions.append(signin, more);

    const note = document.createElement('p');
    note.className = 'form-note';
    note.textContent = 'Sign-in is an email link or a Google account. No password. One free trial per person.';

    card.append(h, body, price, actions, note);
  } else {
    const endedOn = ended ? formatDate(info.accessUntil || info.periodEnd) : '';
    card = buildCard({
      heading: ended ? 'Your subscription ended' : 'Subscribe to keep going',
      body: ended
        ? `Your subscription ended${endedOn ? ` on ${endedOn}` : ''}. Resubscribe and the timer, your presets and your history pick up where they left off.`
        : "You're signed in, and the free sessions on this device are used up. One plan, everything included, keeps the timer running.",
      feature: 'timer',
      ask: 'preview',
      dismissLabel: 'Hide this',
      primaryLabel: ended ? `Resubscribe — $${PLANS.monthly.price} a month` : undefined,
      note: `Everything on this page stays readable. Cancel any time from your account page. ${PLANS.refundDays}-day refund, no reason needed.`,
    });
    card.setAttribute('data-reason', reason);
  }

  container.innerHTML = '';
  container.appendChild(card);
  return card;
}

function clearPreview(root) {
  if (document.body) document.body.classList.remove(PREVIEW_CLASS);
  const scope = root && root.querySelector ? root : document;
  for (const card of scope.querySelectorAll('[data-ask="preview"]')) card.remove();
  cancelDemonstration(root);
}

/* ------------------------------------------------------------------ wiring */

function onPreview(event) {
  const detail = (event && event.detail) || {};
  const root = resolveRoot(detail);
  if (!root) return;
  if (isPro()) return; // the gate has been overtaken by a refresh; nothing to preview

  if (document.body) document.body.classList.add(PREVIEW_CLASS);

  // Nothing animates: the timer is part of the plan, and the card says so.
  if (asksBlocked()) return; // a quiet page asks nothing (the crisis pages never reach here)

  const container = root.querySelector('[data-slot="post-session"]');
  const card = renderPreviewCard(container, { reason: detail.reason, technique: detail.technique });
  if (!card) return;
  if (container && container.scrollIntoView) {
    container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  const reason = String(detail.reason || 'free_sessions_used');
  track(EVENTS.TIMER_PREVIEW_VIEW || 'timer_preview_view', { technique: detail.technique || '', reason });
  if (!signedIn()) track(EVENTS.SIGNIN_VIEW || 'signin_view', { source: 'preview', feature: 'timer' });
}

function onSessionStart(event) {
  const detail = (event && event.detail) || {};
  clearPreview(detail.root || null);
}

/** Register the document-level listeners. Safe to call more than once. */
export function initPreview() {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  document.addEventListener('hmb:preview', onPreview);
  document.addEventListener('hmb:session-start', onSessionStart);
  // A chip tap or a pattern change mid-demo: stop demonstrating the old
  // pattern on a disc the engine has just reset.
  document.addEventListener('hmb:technique-change', (event) => {
    const detail = (event && event.detail) || {};
    cancelDemonstration(detail.root || null);
  });
  onChange(() => {
    if (isPro()) clearPreview(null);
  });
}
