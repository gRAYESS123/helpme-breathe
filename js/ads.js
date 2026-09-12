/**
 * js/ads.js — AdSense loading and slot filling, in one place.
 *
 * Rules this module enforces so nobody else has to think about them:
 *   - never loads when isPro()
 *   - never loads when <body data-no-ads="true">
 *   - never loads or fills while body.session-active is present
 *   - waits for a consent decision, and requests non-personalised ads when
 *     advertising storage was declined
 *   - defers until first interaction or 3s idle so it cannot hurt LCP
 *
 * Ad slots are allowed on content and comparison pages only, below the fold.
 * They are forbidden on the timer viewport, /pro, /for-practitioners, /embed,
 * /pro/thanks and the crisis-safe pages (see docs/AGENT_BRIEF.md rule 6).
 *
 * Markup: <div class="ad-slot" data-ad-slot="in-content-1" aria-hidden="true"></div>
 */

import { isPro, onChange } from './entitlements.js';
import { consentState, hasAdConsent } from './consent.js';

const CLIENT = 'ca-pub-7348129075274196';
const LOADER = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${CLIENT}`;
const IDLE_MS = 3000;

let loaderRequested = false;
let started = false;

function adsAllowedOnThisPage() {
  const body = document.body;
  if (!body) return false;
  if (body.dataset.noAds === 'true') return false;
  if (body.classList.contains('session-active')) return false;
  // The preview state (design section 8.3): the first thing a person sees on
  // a timer page is never an ad beside a sign-in prompt.
  if (body.classList.contains('timer-preview')) return false;
  if (isPro()) return false;
  return true;
}

function slots() {
  return Array.from(document.querySelectorAll('.ad-slot[data-ad-slot]'));
}

function injectLoader() {
  if (loaderRequested) return;
  loaderRequested = true;
  window.adsbygoogle = window.adsbygoogle || [];
  if (!hasAdConsent()) {
    // Non-personalised ads: no advertising identifiers are read or written.
    window.adsbygoogle.requestNonPersonalizedAds = 1;
  }
  const script = document.createElement('script');
  script.async = true;
  script.src = LOADER;
  script.crossOrigin = 'anonymous';
  document.head.appendChild(script);
}

function fillSlot(slot) {
  if (slot.dataset.adFilled === 'true') return;
  const unit = slot.getAttribute('data-ad-slot');
  if (!unit) return;
  slot.dataset.adFilled = 'true';

  const ins = document.createElement('ins');
  ins.className = 'adsbygoogle';
  ins.style.display = 'block';
  ins.setAttribute('data-ad-client', CLIENT);
  ins.setAttribute('data-ad-slot', unit);
  ins.setAttribute('data-ad-format', slot.dataset.adFormat || 'auto');
  ins.setAttribute('data-full-width-responsive', 'true');
  slot.appendChild(ins);

  try {
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  } catch {
    /* blocked or offline — the reserved space simply stays empty */
  }
}

/**
 * Load AdSense (once) and fill every eligible slot on the page.
 * Safe to call more than once; it becomes a no-op after the first success.
 */
export function initAds() {
  if (!adsAllowedOnThisPage()) return;
  const targets = slots();
  if (!targets.length) return;
  injectLoader();
  targets.forEach(fillSlot);
}

/** Remove every ad container from the page (used when a licence activates). */
export function removeAds() {
  for (const slot of slots()) slot.remove();
}

function startWhenIdle() {
  if (started) return;
  started = true;
  const go = () => initAds();
  const once = { once: true, passive: true };
  window.addEventListener('pointerdown', go, once);
  window.addEventListener('keydown', go, once);
  window.addEventListener('scroll', go, once);
  window.setTimeout(go, IDLE_MS);
}

function boot() {
  // A paying customer bought "ad-free". Returning early is not enough: the
  // reserved 280px container and its "Advertisement" label would still occupy
  // the layout. Strip them.
  if (isPro()) {
    removeAds();
    return;
  }
  if (!adsAllowedOnThisPage()) return;
  if (!slots().length) return;
  // Wait for a consent decision before requesting anything from Google.
  if (consentState() === null) {
    document.addEventListener('hmb:consent', () => startWhenIdle(), { once: true });
    return;
  }
  startWhenIdle();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
  // A session starting after ads loaded: CSS hides the slots, nothing to do here.
  document.addEventListener('hmb:session-complete', () => initAds());
  document.addEventListener('hmb:session-stop', () => initAds());
  // The preview card took the slot: strip any ad already on the page.
  document.addEventListener('hmb:preview', () => removeAds());
  // A licence activated mid-session strips the slots immediately, without a reload.
  onChange(() => {
    if (isPro()) removeAds();
  });
}
