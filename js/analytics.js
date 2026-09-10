/**
 * js/analytics.js — the only place the site talks to GA4.
 *
 * `track(name, params)` forwards to gtag('event', …) and is a no-op when
 * gtag is absent or the visitor has not granted analytics consent. Nothing
 * here ever sends an email address, a licence key or any free-text input.
 *
 * Contract (see docs/MODULE_API.md): EVENTS, track(name, params).
 */

import { hasAnalyticsConsent } from './consent.js';

/** Every event name the site is allowed to send. */
export const EVENTS = Object.freeze({
  SESSION_START: 'session_start',
  SESSION_COMPLETE: 'session_complete',
  SESSION_ABANDON: 'session_abandon',
  TECHNIQUE_SELECT: 'technique_select',
  SETTINGS_OPEN: 'settings_open',
  THIRD_SESSION_REACHED: 'third_session_reached',
  PAYWALL_VIEW: 'paywall_view',
  PAYWALL_CLICK: 'paywall_click',
  CHECKOUT_OPEN: 'checkout_open',
  ACTIVATE_ATTEMPT: 'activate_attempt',
  ACTIVATE_SUCCESS: 'activate_success',
  ACTIVATE_FAIL: 'activate_fail',
  RESTORE_SUCCESS: 'restore_success',
  CAPTURE_SHOWN: 'capture_shown',
  CAPTURE_SUBMIT: 'capture_submit',
  SUPPORT_CLICK: 'support_click',
  PWA_INSTALL: 'pwa_install',
  OUTBOUND_AFFILIATE_CLICK: 'outbound_affiliate_click',
  EMBED_SNIPPET_COPIED: 'embed_snippet_copied',
});

const ALLOWED = new Set(Object.values(EVENTS));

/** Events queued before consent, replayed once (and only once) if granted. */
const pending = [];
const PENDING_LIMIT = 20;

function send(name, params) {
  const gtag = typeof window !== 'undefined' && typeof window.gtag === 'function' ? window.gtag : null;
  if (!gtag) return false;
  try {
    gtag('event', name, params || {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Record one product event.
 * @param {string} name one of EVENTS
 * @param {object} [params] flat, non-personal parameters
 * @returns {boolean} true when the event actually reached gtag
 */
export function track(name, params) {
  if (!name) return false;
  if (!ALLOWED.has(name) && typeof console !== 'undefined') {
    console.warn(`[analytics] unknown event "${name}" — add it to EVENTS in js/analytics.js`);
  }
  const payload = params && typeof params === 'object' ? { ...params } : {};
  if (!hasAnalyticsConsent()) {
    if (pending.length < PENDING_LIMIT) pending.push({ name, payload });
    return false;
  }
  return send(name, payload);
}

if (typeof document !== 'undefined') {
  document.addEventListener('hmb:consent', (event) => {
    if (!event.detail || event.detail.analytics !== true) {
      pending.length = 0;
      return;
    }
    while (pending.length) {
      const item = pending.shift();
      send(item.name, item.payload);
    }
  });
}
