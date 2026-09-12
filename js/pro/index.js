/**
 * js/pro/index.js — the Pro entry module.
 *
 * Every page with a timer loads this after /js/app.js:
 *
 *   <script type="module" src="/js/pro/index.js"></script>
 *
 * It injects css/pro.css once, wires the paywall and the email capture (both
 * document-level, both quiet by default), and adds the per-instance tools —
 * "Custom pattern", "Your practice" and "Night mode" — to every
 * `[data-breathing-app]` on the page as each one announces `hmb:ready`.
 *
 * Soundscapes live in js/pro/soundscapes.js, owned by another agent and loaded
 * with a dynamic import inside try/catch: if the file is missing, blocked or
 * throws, the page carries on exactly as before.
 *
 * Nothing here imports anything the core does not export.
 */

import { initPaywall } from './paywall.js';
import { initPreview } from './preview.js';
import { initCapture } from './capture.js';
import { initPatterns } from './patterns.js';
import { initStreaks } from './streaks.js';
import { initNight } from './night.js';
import { requirePro } from '../entitlements.js';
import { track } from '../analytics.js';
// Installs the delegated handler for `[data-action="checkout"]` buttons.
import '../checkout.js';

export const PRO_MODULE_READY = true;

const CSS_HREF = '/css/pro.css';

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.querySelector('link[data-hmb-pro-css]')) return;
  if (document.querySelector(`link[rel="stylesheet"][href="${CSS_HREF}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = CSS_HREF;
  link.setAttribute('data-hmb-pro-css', '');
  document.head.appendChild(link);
}

async function initSoundscapesFor(rootEl) {
  try {
    const mod = await import('./soundscapes.js');
    if (mod && typeof mod.initSoundscapes === 'function') {
      mod.initSoundscapes(rootEl, { requirePro, track });
    }
  } catch {
    // The audio module is optional. A missing or broken file must never take
    // the breathing timer down with it.
  }
}

/**
 * `data-no-asks="true"` marks the crisis-safe pages. The tools still work
 * there — a paying visitor keeps night mode on the anxiety page — but a free
 * visitor is shown no locked control and no mention of Pro.
 */
function isQuietPage() {
  return !!(document.body && document.body.dataset && document.body.dataset.noAsks === 'true');
}

function initInstance(rootEl, instance) {
  if (!rootEl) return;
  const options = { quiet: isQuietPage() };
  try {
    initPatterns(rootEl, instance, options);
  } catch {
    /* one broken tool must not stop the others */
  }
  try {
    initStreaks(rootEl, options);
  } catch {
    /* ignore */
  }
  try {
    initNight(rootEl, options);
  } catch {
    /* ignore */
  }
  initSoundscapesFor(rootEl);
}

if (typeof document !== 'undefined') {
  injectStyles();
  initPaywall();
  // The timer's preview state (design section 8.2): one demonstration cycle
  // and the account card when Start is refused by requireTimer().
  initPreview();
  initCapture();

  document.addEventListener('hmb:ready', (event) => {
    const detail = event.detail || {};
    initInstance(detail.root, detail.instance);
  });

  // Safety net: if this module is loaded late (a cached page, an injected
  // script), pick up instances that announced `hmb:ready` before we listened.
  const sweep = () => {
    const roots = document.querySelectorAll('[data-breathing-app]');
    if (!roots.length) return;
    let pending = false;
    for (const root of roots) if (root.dataset.proPatterns !== 'on') pending = true;
    if (!pending) return;
    import('../app.js')
      .then((app) => {
        for (const root of roots) {
          if (root.dataset.proPatterns === 'on') continue;
          const instance = app.getApp(root);
          if (instance) initInstance(root, instance);
        }
      })
      .catch(() => {
        /* the engine is not on this page; nothing to attach to */
      });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.setTimeout(sweep, 0));
  } else {
    window.setTimeout(sweep, 0);
  }
}
