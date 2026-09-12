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
  CAPTURE_SHOWN: 'capture_shown',
  CAPTURE_SUBMIT: 'capture_submit',
  SUPPORT_CLICK: 'support_click',
  PWA_INSTALL: 'pwa_install',
  OUTBOUND_AFFILIATE_CLICK: 'outbound_affiliate_click',
  EMBED_SNIPPET_COPIED: 'embed_snippet_copied',
  // Accounts, trial and subscription (design section 12). Never with an
  // email, a user id, a device id, a token or a provider customer id.
  SIGNIN_VIEW: 'signin_view',
  SIGNIN_START: 'signin_start',
  SIGNIN_COMPLETE: 'signin_complete',
  SIGNIN_FAIL: 'signin_fail',
  SIGNIN_RESUME_CHECKOUT: 'signin_resume_checkout',
  SIGNOUT: 'signout',
  TIMER_PREVIEW_VIEW: 'timer_preview_view',
  TIMER_GATE_BLOCK: 'timer_gate_block',
  TRIAL_ELIGIBILITY_CHECK: 'trial_eligibility_check',
  TRIAL_START: 'trial_start',
  SUBSCRIBE_START: 'subscribe_start',
  TRIAL_CONVERT: 'trial_convert',
  SUBSCRIPTION_PAST_DUE: 'subscription_past_due',
  SUBSCRIPTION_CANCELED: 'subscription_canceled',
  MANAGE_BILLING_CLICK: 'manage_billing_click',
  CANCEL_SCREEN_VIEW: 'cancel_screen_view',
  RETENTION_OFFER_TAKEN: 'retention_offer_taken',
  CANCEL_CONFIRM: 'cancel_confirm',
  EMBED_TOKEN_CREATED: 'embed_token_created',
  ACCOUNT_EXPORT: 'account_export',
  ACCOUNT_DELETE_REQUEST: 'account_delete_request',
  PLAN_INTERVAL_TOGGLE: 'plan_interval_toggle',
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
