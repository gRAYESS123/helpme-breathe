/**
 * js/consent.js — cookie banner + Google Consent Mode v2 updates.
 *
 * IMPORTANT ORDERING NOTE
 * -----------------------
 * ES modules are deferred, so this file always runs *after* the inline head
 * script. The Consent Mode **defaults** must therefore be set inline, in the
 * head, before `gtag('config', …)`. Every page carries this exact block (see
 * docs/PAGE_CONTRACT.md):
 *
 *   <script>
 *     window.dataLayer = window.dataLayer || [];
 *     function gtag(){dataLayer.push(arguments);}
 *     gtag('consent', 'default', {
 *       ad_storage: 'denied', ad_user_data: 'denied',
 *       ad_personalization: 'denied', analytics_storage: 'denied',
 *       wait_for_update: 500
 *     });
 *     gtag('set', 'ads_data_redaction', true);
 *     gtag('js', new Date());
 *     gtag('config', 'G-TYLYLJSFHN', { anonymize_ip: true, cookie_expires: 63072000 });
 *     gtag('config', 'AW-18182683015');   // Google Ads, same gates; conversion only on /pro/thanks
 *   </script>
 *   <script async src="https://www.googletagmanager.com/gtag/js?id=G-TYLYLJSFHN"></script>
 *
 * This module then: replays the stored decision as a `consent update`, renders
 * and wires the banner when no decision has been made, and exposes the state to
 * the rest of the app.
 *
 * Stored at localStorage['hmb.consent'] as 'all' | 'essential'.
 */

const STORAGE_KEY = 'hmb.consent';
const BANNER_DELAY_MS = 1500;

/** @type {'all'|'essential'|null} */
let decision = null;
let banner = null;

function readDecision() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value === 'all' || value === 'essential') return value;
    // Migrate the pre-v2 key written by the old inline script.
    const legacy = window.localStorage.getItem('cookieConsent');
    if (legacy === 'all' || legacy === 'essential') return legacy;
  } catch {
    /* storage unavailable — treat as undecided, deny by default */
  }
  return null;
}

function writeDecision(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* ignore — the decision still applies for this page view */
  }
}

function gtagSafe() {
  return typeof window.gtag === 'function' ? window.gtag : null;
}

function applyConsent(value) {
  const granted = value === 'all';
  const gtag = gtagSafe();
  if (gtag) {
    gtag('consent', 'update', {
      analytics_storage: granted ? 'granted' : 'denied',
      ad_storage: granted ? 'granted' : 'denied',
      ad_user_data: granted ? 'granted' : 'denied',
      ad_personalization: granted ? 'granted' : 'denied',
    });
  }
  document.dispatchEvent(
    new CustomEvent('hmb:consent', { detail: { decision: value, analytics: granted, ads: granted } }),
  );
}

/** True when the visitor accepted analytics/measurement storage. */
export function hasAnalyticsConsent() {
  return decision === 'all';
}

/** True when the visitor accepted advertising storage. */
export function hasAdConsent() {
  return decision === 'all';
}

/** 'all' | 'essential' | null (no decision yet). */
export function consentState() {
  return decision;
}

/**
 * Record a decision, update Consent Mode and hide the banner.
 * @param {'all'|'essential'} value
 */
export function setConsent(value) {
  const next = value === 'all' ? 'all' : 'essential';
  decision = next;
  writeDecision(next);
  applyConsent(next);
  hideBanner();
}

function hideBanner() {
  if (!banner) return;
  banner.classList.remove('show');
  banner.setAttribute('hidden', '');
}

function buildBanner() {
  const existing = document.getElementById('cookieConsent');
  if (existing) return existing;

  const el = document.createElement('div');
  el.id = 'cookieConsent';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-label', 'Cookie choices');
  // Declining is listed first and carries exactly the same visual weight as
  // accepting. See docs/BRAND.md — the cookie banner is not a persuasion
  // surface.
  el.innerHTML = [
    '<p>We can set an analytics cookie to see which pages help people, and advertising cookies on article pages. ',
    'Choose &ldquo;Essential only&rdquo; and neither is set; the timer works exactly the same. ',
    '<a href="/legal/privacy-policy">Privacy Policy</a>.</p>',
    '<div class="cookie-buttons">',
    '<button type="button" class="cookie-btn secondary" data-action="consent-essential">Essential only</button>',
    '<button type="button" class="cookie-btn" data-action="consent-all">Accept all</button>',
    '</div>',
  ].join('');
  document.body.appendChild(el);
  return el;
}

function showBanner() {
  banner = buildBanner();
  banner.removeAttribute('hidden');
  banner.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button || !banner.contains(button)) return;
    const action = button.getAttribute('data-action');
    if (action === 'consent-all') setConsent('all');
    else if (action === 'consent-essential') setConsent('essential');
  });
  window.setTimeout(() => banner.classList.add('show'), BANNER_DELAY_MS);
}

function init() {
  decision = readDecision();
  if (decision) {
    // Replay the stored decision so Consent Mode leaves its denied defaults.
    applyConsent(decision);
    const existing = document.getElementById('cookieConsent');
    if (existing) {
      existing.classList.remove('show');
      existing.setAttribute('hidden', '');
    }
    return;
  }
  showBanner();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
