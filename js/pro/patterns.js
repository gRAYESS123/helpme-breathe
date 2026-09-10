/**
 * js/pro/patterns.js — the custom pattern builder.
 *
 * Free, for everyone: build a pattern with the four sliders, see it described
 * in plain words, and run it. That part is deliberately not gated — it is the
 * best demonstration of what the timer can do.
 *
 * Pro: save the pattern as a named preset, rename and delete presets, and copy
 * a share link. Both gated controls stay visible and explain themselves rather
 * than disappearing.
 *
 * Share links look like:
 *   https://helpmebreath.com/timer?p=4-7-8-0&name=My%20wind-down
 * and this module applies `?p=` when the page is /timer, for anyone, paid or not.
 */

import { patternToPhases, cycleSeconds } from '../techniques.js';
import { getFlag, setFlag } from '../storage.js';
import { requirePro, isPro, onChange } from '../entitlements.js';

const PRESETS_FLAG = 'presets';
const MAX_SECONDS = 30;
const SHARE_BASE = 'https://helpmebreath.com/timer';

let uid = 0;

/* ------------------------------------------------------------------ store */

/** @returns {Array<{id:string,name:string,inhale:number,hold1:number,exhale:number,hold2:number}>} */
export function getPresets() {
  const raw = getFlag(PRESETS_FLAG);
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        id: String(p.id || ''),
        name: String(p.name || 'Preset'),
        inhale: clamp(p.inhale),
        hold1: clamp(p.hold1),
        exhale: clamp(p.exhale),
        hold2: clamp(p.hold2),
      }))
      .filter((p) => p.id && (p.inhale > 0 || p.exhale > 0));
  } catch {
    return [];
  }
}

function savePresets(list) {
  setFlag(PRESETS_FLAG, JSON.stringify(list));
}

function clamp(value) {
  const n = Math.round(Number(value) || 0);
  return Math.min(Math.max(n, 0), MAX_SECONDS);
}

function newId() {
  return `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/* -------------------------------------------------------------- describing */

function describe(pattern) {
  const parts = [];
  if (pattern.inhale > 0) parts.push(`in for ${pattern.inhale}`);
  if (pattern.hold1 > 0) parts.push(`hold for ${pattern.hold1}`);
  if (pattern.exhale > 0) parts.push(`out for ${pattern.exhale}`);
  if (pattern.hold2 > 0) parts.push(`hold empty for ${pattern.hold2}`);
  if (!parts.length) return 'Set an inhale or an exhale to build a pattern.';

  const phases = patternToPhases(pattern);
  const total = cycleSeconds(phases);
  const perMinute = total > 0 ? Math.round((60 / total) * 10) / 10 : 0;
  return `Breathe ${parts.join(', ')}. One cycle takes ${total} seconds — about ${perMinute} breaths a minute.`;
}

function shareUrl(pattern, name) {
  const p = `${pattern.inhale}-${pattern.hold1}-${pattern.exhale}-${pattern.hold2}`;
  const label = String(name || '').trim();
  return `${SHARE_BASE}?p=${p}${label ? `&name=${encodeURIComponent(label)}` : ''}`;
}

/** Parse `4-7-8-0` (1 to 4 parts) into a pattern object, or null. */
export function parsePatternParam(value) {
  if (typeof value !== 'string' || !value) return null;
  const parts = value.split('-').map((n) => Number(n));
  if (!parts.length || parts.length > 4 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const pattern = {
    inhale: clamp(parts[0]),
    hold1: clamp(parts[1] || 0),
    exhale: clamp(parts[2] || 0),
    hold2: clamp(parts[3] || 0),
  };
  if (pattern.inhale <= 0 && pattern.exhale <= 0) return null;
  return pattern;
}

/* -------------------------------------------------------------------- UI */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function lockPill() {
  const pill = el('span', 'pro-pill', 'Pro');
  pill.setAttribute('aria-hidden', 'true');
  return pill;
}

function syncLocks(buttons) {
  const unlocked = isPro();
  for (const button of buttons) {
    button.classList.toggle('is-locked', !unlocked);
    const pill = button.querySelector('.pro-pill');
    if (pill) pill.hidden = unlocked;
  }
}

/**
 * Wire the pattern builder onto one timer instance.
 * @param {Element} rootEl the `[data-breathing-app]` element
 * @param {{setPattern:Function}} instance the engine API from `hmb:ready`
 * @param {{quiet?:boolean}} [options] `quiet` on a `data-no-asks` page: the
 *        builder still works, but a free visitor is shown no locked control and
 *        no mention of Pro at all.
 */
export function initPatterns(rootEl, instance, options = {}) {
  const quiet = options.quiet === true;
  if (!rootEl || !instance || typeof instance.setPattern !== 'function') return;
  if (rootEl.dataset.proPatterns === 'on') return;
  rootEl.dataset.proPatterns = 'on';

  const tools = rootEl.querySelector('[data-slot="tools"]');
  if (!tools) return;

  const id = `patterns-${++uid}`;
  const pattern = { inhale: 4, hold1: 4, exhale: 6, hold2: 0 };

  /* toggle button */
  const toggle = el('button', 'tool-btn', 'Custom pattern');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', id);
  tools.appendChild(toggle);

  /* panel */
  const panel = el('div', 'pro-panel');
  panel.id = id;
  panel.hidden = true;
  panel.setAttribute('data-pro-panel', 'patterns');

  const title = el('h3', 'pro-panel-title', 'Build your own pattern');
  const help = el(
    'p',
    'pro-panel-help',
    'Set each part in seconds. Zero skips that part. You need an inhale or an exhale.',
  );
  panel.append(title, help);

  const sliders = el('div', 'slider-grid');
  const fields = [
    ['inhale', 'Inhale'],
    ['hold1', 'Hold after inhale'],
    ['exhale', 'Exhale'],
    ['hold2', 'Hold after exhale'],
  ];
  const inputs = {};
  const readouts = {};

  for (const [key, label] of fields) {
    const row = el('div', 'slider-row');
    const labelEl = el('label', 'slider-label', label);
    labelEl.setAttribute('for', `${id}-${key}`);

    const input = document.createElement('input');
    input.type = 'range';
    input.id = `${id}-${key}`;
    input.min = '0';
    input.max = String(MAX_SECONDS);
    input.step = '1';
    input.value = String(pattern[key]);

    const readout = el('output', 'slider-value', `${pattern[key]}s`);
    readout.setAttribute('for', `${id}-${key}`);

    input.addEventListener('input', () => {
      pattern[key] = clamp(input.value);
      readout.textContent = `${pattern[key]}s`;
      refresh();
    });

    inputs[key] = input;
    readouts[key] = readout;
    row.append(labelEl, input, readout);
    sliders.appendChild(row);
  }
  panel.appendChild(sliders);

  const preview = el('p', 'pattern-preview');
  preview.setAttribute('aria-live', 'polite');
  panel.appendChild(preview);

  /* name + actions */
  const nameRow = el('div', 'pattern-name-row');
  const nameLabel = el('label', 'slider-label', 'Name');
  nameLabel.setAttribute('for', `${id}-name`);
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.id = `${id}-name`;
  nameInput.placeholder = 'My wind-down';
  nameInput.maxLength = 40;
  nameRow.append(nameLabel, nameInput);
  panel.appendChild(nameRow);

  const actions = el('div', 'pro-panel-actions');

  const runBtn = el('button', 'pro-btn pro-btn-primary', 'Run this pattern');
  runBtn.type = 'button';

  const saveBtn = el('button', 'pro-btn', 'Save preset');
  saveBtn.type = 'button';
  saveBtn.appendChild(lockPill());

  const shareBtn = el('button', 'pro-btn', 'Copy share link');
  shareBtn.type = 'button';
  shareBtn.appendChild(lockPill());

  // On a crisis-safe page a free visitor never sees a locked control.
  const showGated = !quiet || isPro();
  if (showGated) actions.append(runBtn, saveBtn, shareBtn);
  else actions.append(runBtn);
  panel.appendChild(actions);

  const status = el('p', 'pro-panel-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  panel.appendChild(status);

  const shareOut = document.createElement('input');
  shareOut.type = 'text';
  shareOut.className = 'share-url';
  shareOut.readOnly = true;
  shareOut.hidden = true;
  shareOut.setAttribute('aria-label', 'Share link');
  panel.appendChild(shareOut);

  const presetsWrap = el('div', 'preset-list');
  panel.appendChild(presetsWrap);

  const paywallSlot = el('div', '');
  paywallSlot.setAttribute('data-paywall-slot', '');
  panel.appendChild(paywallSlot);

  tools.parentNode.insertBefore(panel, tools.nextSibling);

  /* ------------------------------------------------------------- behaviour */

  function valid() {
    return pattern.inhale > 0 || pattern.exhale > 0;
  }

  function refresh() {
    preview.textContent = describe(pattern);
    runBtn.disabled = !valid();
    saveBtn.disabled = !valid();
    shareBtn.disabled = !valid();
  }

  function say(text, kind) {
    status.textContent = text || '';
    status.classList.toggle('is-error', kind === 'error');
  }

  function applyPattern(next, name) {
    pattern.inhale = clamp(next.inhale);
    pattern.hold1 = clamp(next.hold1);
    pattern.exhale = clamp(next.exhale);
    pattern.hold2 = clamp(next.hold2);
    for (const [key] of fields) {
      inputs[key].value = String(pattern[key]);
      readouts[key].textContent = `${pattern[key]}s`;
    }
    if (name !== undefined) nameInput.value = name;
    refresh();
  }

  function renderPresets() {
    presetsWrap.innerHTML = '';
    if (quiet && !isPro()) return;
    const list = getPresets();
    if (!list.length) {
      const empty = el(
        'p',
        'pro-panel-help',
        isPro()
          ? 'No saved presets yet. Build one above and press Save preset.'
          : 'Saved presets are part of Pro. You can still build and run any pattern for free.',
      );
      presetsWrap.appendChild(empty);
      return;
    }

    const heading = el('h4', 'preset-heading', 'Your presets');
    presetsWrap.appendChild(heading);

    const ul = el('ul', 'preset-items');
    for (const preset of list) {
      const li = el('li', 'preset-item');

      const label = el(
        'button',
        'preset-load',
        `${preset.name} · ${preset.inhale}-${preset.hold1}-${preset.exhale}-${preset.hold2}`,
      );
      label.type = 'button';
      label.addEventListener('click', () => {
        applyPattern(preset, preset.name);
        say(`Loaded "${preset.name}". Press Run this pattern to start.`);
      });

      const rename = el('button', 'preset-action', 'Rename');
      rename.type = 'button';
      rename.addEventListener('click', () => startRename(li, preset));

      const remove = el('button', 'preset-action', 'Delete');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        savePresets(getPresets().filter((p) => p.id !== preset.id));
        renderPresets();
        say(`Deleted "${preset.name}".`);
      });

      li.append(label, rename, remove);
      ul.appendChild(li);
    }
    presetsWrap.appendChild(ul);
  }

  function startRename(li, preset) {
    li.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = preset.name;
    input.maxLength = 40;
    input.setAttribute('aria-label', `Rename ${preset.name}`);

    const ok = el('button', 'preset-action', 'Save');
    ok.type = 'button';
    ok.addEventListener('click', () => {
      const next = String(input.value || '').trim() || preset.name;
      savePresets(getPresets().map((p) => (p.id === preset.id ? { ...p, name: next } : p)));
      renderPresets();
      say(`Renamed to "${next}".`);
    });

    const cancel = el('button', 'preset-action', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', renderPresets);

    li.append(input, ok, cancel);
    input.focus();
    input.select();
  }

  toggle.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      refresh();
      renderPresets();
      inputs.inhale.focus();
    }
  });

  runBtn.addEventListener('click', () => {
    if (!valid()) return;
    const name = String(nameInput.value || '').trim();
    instance.setPattern({ ...pattern }, name ? { name } : {});
    say('Ready. Press Begin Practice to start.');
  });

  saveBtn.addEventListener('click', () => {
    if (!valid()) return;
    if (!requirePro('presets')) return;
    const name = String(nameInput.value || '').trim() || `${pattern.inhale}-${pattern.hold1}-${pattern.exhale}-${pattern.hold2}`;
    const list = getPresets();
    list.push({ id: newId(), name, ...pattern });
    savePresets(list);
    renderPresets();
    say(`Saved "${name}".`);
  });

  shareBtn.addEventListener('click', async () => {
    if (!valid()) return;
    if (!requirePro('presets')) return;
    const url = shareUrl(pattern, nameInput.value);
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        copied = true;
      }
    } catch {
      copied = false;
    }
    shareOut.value = url;
    shareOut.hidden = false;
    if (copied) {
      say('Link copied. Anyone who opens it gets this pattern, free.');
    } else {
      say('Copy this link — anyone who opens it gets this pattern, free.');
      shareOut.focus();
      shareOut.select();
    }
  });

  const gated = [saveBtn, shareBtn];
  syncLocks(gated);
  onChange(() => {
    syncLocks(gated);
    renderPresets();
  });

  refresh();
  renderPresets();

  /* ------------------------------------------------- ?p= on the /timer hub */

  const shared = readSharedPattern();
  if (shared) {
    applyPattern(shared.pattern, shared.name || '');
    instance.setPattern({ ...shared.pattern }, shared.name ? { name: shared.name } : {});
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    say(
      shared.name
        ? `Loaded the shared pattern "${shared.name}". Press Begin Practice when you are ready.`
        : 'Loaded a shared pattern. Press Begin Practice when you are ready.',
    );
  }
}

/** `?p=4-7-8-0&name=My%20wind-down` on /timer, for anyone, paid or not. */
function readSharedPattern() {
  if (typeof window === 'undefined') return null;
  const path = window.location.pathname.replace(/\.html$/, '').replace(/\/+$/, '');
  if (path !== '/timer') return null;
  const params = new URLSearchParams(window.location.search);
  const pattern = parsePatternParam(params.get('p'));
  if (!pattern) return null;
  const name = (params.get('name') || params.get('n') || '').slice(0, 40);
  return { pattern, name };
}
