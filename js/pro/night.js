/**
 * js/pro/night.js — the manual night/day override.
 *
 * The site is daylight for every visitor, whatever the device asks for (the
 * OS dark preference stopped dimming the page on 2026-09-16). What this module
 * sells is the switch: it puts `night` or `day` on `<body>` and holds that
 * choice in this browser under the `hmb.night` flag. While a session is running it also asks
 * for a Screen Wake Lock so the phone does not sleep mid-practice, and releases
 * it the moment the session ends.
 *
 * Pro only. (`storage.saveSettings()` deliberately keeps only the four engine
 * settings, so preferences that belong to a module live as flags.)
 */

import { getFlag, setFlag } from '../storage.js';
import { requirePro, isPro, onChange } from '../entitlements.js';

const FLAG = 'night';
const NIGHT_CLASS = 'night';
const DAY_CLASS = 'day';

const toggles = new Set();
let enabled = false;
/* Has this browser made a choice at all? Until it has, neither class goes on
   the body and the visitor keeps whatever their device asked for. */
let overridden = false;
let wakeLock = null;
let sessionRunning = false;
let wired = false;

function applyBodyClass() {
  if (!document.body) return;
  document.body.classList.toggle(NIGHT_CLASS, overridden && enabled);
  document.body.classList.toggle(DAY_CLASS, overridden && !enabled);
}

function syncToggles() {
  for (const button of toggles) {
    button.setAttribute('aria-pressed', String(enabled));
    button.classList.toggle('is-on', enabled);
    button.classList.toggle('is-locked', !isPro());
    const pill = button.querySelector('.pro-pill');
    if (pill) pill.hidden = isPro();
  }
}

/* --------------------------------------------------------------- wake lock */

async function requestWakeLock() {
  if (!enabled || !sessionRunning) return;
  if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
  if (wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null; // denied, unsupported, or the tab was hidden — never fatal
  }
}

function releaseWakeLock() {
  if (!wakeLock) return;
  try {
    wakeLock.release();
  } catch {
    /* ignore */
  }
  wakeLock = null;
}

function wireOnce() {
  if (wired || typeof document === 'undefined') return;
  wired = true;

  document.addEventListener('hmb:session-start', () => {
    sessionRunning = true;
    requestWakeLock();
  });
  const stop = () => {
    sessionRunning = false;
    releaseWakeLock();
  };
  document.addEventListener('hmb:session-complete', stop);
  document.addEventListener('hmb:session-stop', stop);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWakeLock();
  });

  onChange(() => {
    if (!isPro() && overridden) {
      // The override is a paid control, so it lapses with the licence. Dropping
      // both classes hands the visitor back to their own device preference
      // rather than pinning them to a bright page.
      enabled = false;
      overridden = false;
      applyBodyClass();
      releaseWakeLock();
    }
    syncToggles();
  });
}

/** Turn night mode on or off. Returns the new state. */
export function setNight(next) {
  enabled = next === true;
  overridden = true;
  setFlag(FLAG, enabled);
  applyBodyClass();
  syncToggles();
  if (enabled) requestWakeLock();
  else releaseWakeLock();
  return enabled;
}

/** Is night mode on right now? */
export function nightEnabled() {
  return enabled;
}

/**
 * Add the night-mode toggle to one timer instance's tools slot.
 * @param {Element} rootEl the `[data-breathing-app]` element
 * @param {{quiet?:boolean}} [options] `quiet` on a `data-no-asks` page: a free
 *        visitor is shown no locked toggle, so the page carries no ask at all.
 */
export function initNight(rootEl, options = {}) {
  if (!rootEl) return;
  if (options.quiet === true && !isPro()) return;
  if (rootEl.dataset.proNight === 'on') return;
  rootEl.dataset.proNight = 'on';

  const tools = rootEl.querySelector('[data-slot="tools"]');
  if (!tools) return;

  wireOnce();

  // Restore the stored preference once, for a paid visitor. A stored `false`
  // is a real choice — "keep this page light whatever my phone says" — so it
  // is restored as an override too. Only an absent flag means "no choice yet".
  if (!toggles.size && isPro()) {
    const stored = getFlag(FLAG);
    if (stored === true || stored === false) {
      enabled = stored === true;
      overridden = true;
      applyBodyClass();
    }
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tool-btn night-toggle';
  button.textContent = 'Night mode';
  button.setAttribute('aria-pressed', 'false');

  const pill = document.createElement('span');
  pill.className = 'pro-pill';
  pill.setAttribute('aria-hidden', 'true');
  pill.textContent = 'Pro';
  button.appendChild(pill);

  button.addEventListener('click', () => {
    if (!requirePro('night')) return;
    setNight(!enabled);
  });

  toggles.add(button);
  tools.appendChild(button);
  syncToggles();
}
