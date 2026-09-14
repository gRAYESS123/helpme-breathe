/**
 * js/app.js — the breathing engine.
 *
 * Replaces the old js/scripts.js. Everything the old script did is here, plus:
 *   - multiple independent timers on one page (comparison pages embed two)
 *   - no global element ids: every lookup is `[data-role="…"]` scoped to the root
 *   - settings and session history persisted through js/storage.js
 *   - an ARIA live region announcing each phase
 *   - prefers-reduced-motion honoured (the circle holds one size, a pacing ring
 *     draws round it, and the progress bar advances in whole-second steps)
 *   - a one-tap safety acknowledgement for techniques that need one
 *   - kiosk / projector mode with Screen Wake Lock
 *   - CustomEvents on `document` so other modules never reach into the engine
 *
 * Public API (see docs/MODULE_API.md):
 *   createBreathingApp(rootEl, options) -> { start, pause, stop, selectTechnique,
 *                                            setPattern, getState, destroy }
 *   getApps(), getApp(rootEl)
 *
 * Auto-initialises every `[data-breathing-app]` on DOMContentLoaded.
 */

import {
  TECHNIQUES,
  TECHNIQUE_ORDER,
  DEFAULT_TECHNIQUE,
  getTechnique,
  techniqueForPath,
  patternToPhases,
  cycleSeconds,
  needsCautionBlock,
  THEME_CLASSES,
  CIRCLE_CLASSES,
} from './techniques.js';
import * as storage from './storage.js';
import { track, EVENTS } from './analytics.js';
import { requireTimer, signedIn } from './entitlements.js';

/* ========================================================================== *
 * Audio — one AudioContext for the whole page, shared by every instance.
 * ========================================================================== */

class OptimizedAudioSystem {
  constructor() {
    this.audioContext = null;
    this.isInitialized = false;
    this.masterGain = null;
    this.isSupported = this.checkAudioSupport();
    this.activeNodes = new Set();
  }

  checkAudioSupport() {
    return typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);
  }

  async init() {
    if (!this.isSupported || this.isInitialized) return;
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.setValueAtTime(0.3, this.audioContext.currentTime);
      this.masterGain.connect(this.audioContext.destination);
      this.isInitialized = true;
    } catch (error) {
      console.warn('Audio initialization failed:', error);
      this.isSupported = false;
    }
  }

  createBreathSound(frequency, duration, type = 'inhale') {
    if (!this.isSupported || !this.isInitialized || !frequency || !duration) return;

    const now = this.audioContext.currentTime;
    const endTime = now + duration;

    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    const filter = this.audioContext.createBiquadFilter();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, now);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(frequency * 2, now);

    if (type === 'inhale') {
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.15, now + duration * 0.7);
      gain.gain.linearRampToValueAtTime(0, endTime);
    } else if (type === 'exhale') {
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.12, now + Math.min(0.2, duration * 0.2));
      gain.gain.exponentialRampToValueAtTime(0.01, endTime);
    } else {
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.05, now + Math.min(1, duration * 0.3));
      gain.gain.setValueAtTime(0.05, Math.max(now + 0.01, endTime - 1));
      gain.gain.linearRampToValueAtTime(0, endTime);
    }

    osc.connect(gain);
    gain.connect(filter);
    filter.connect(this.masterGain);

    osc.start(now);
    osc.stop(endTime);

    this.activeNodes.add({ endTime, nodes: [osc] });
    window.setTimeout(() => this.cleanup(), duration * 1000 + 100);
  }

  cleanup() {
    const now = this.audioContext ? this.audioContext.currentTime : 0;
    for (const node of this.activeNodes) {
      if (node.endTime < now - 1) this.activeNodes.delete(node);
    }
  }

  stop() {
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close();
      } catch {
        /* ignore */
      }
    }
    this.activeNodes.clear();
    this.isInitialized = false;
    this.audioContext = null;
  }
}

export const audioSystem = new OptimizedAudioSystem();

/* ========================================================================== *
 * Page-level helpers
 * ========================================================================== */

const TICK_MS = 50;
const MIN_RECORDED_SECONDS = 30;
const DURATION_OPTIONS = [300, 600, 900, 1200, -1];

/** @type {Array<{root:HTMLElement, api:object, internals:object}>} */
const instances = [];
let activeSessions = 0;

const reducedMotion =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false, addEventListener: () => {} };

function prefersReducedMotion() {
  return !!reducedMotion.matches;
}

function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function setBodySessionActive(delta) {
  activeSessions = Math.max(0, activeSessions + delta);
  if (!document.body) return;
  document.body.classList.toggle('session-active', activeSessions > 0);
}

function themeLocked(rootEl) {
  return (
    rootEl.hasAttribute('data-lock-theme') ||
    document.documentElement.hasAttribute('data-lock-theme') ||
    (document.body && document.body.hasAttribute('data-lock-theme'))
  );
}

function emit(name, detail) {
  document.dispatchEvent(new CustomEvent(name, { detail, bubbles: false }));
}

function vibrate(pattern, enabled) {
  if (!enabled || typeof navigator === 'undefined' || !navigator.vibrate) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* ignore */
  }
}

/**
 * Human label for a duration the page's <select> does not already offer, e.g.
 * a `?d=30` deep link. Rounding straight to minutes turned 30 seconds into
 * "1 minutes", so seconds and singulars are spelled out.
 * @param {number} totalSeconds
 */
function durationLabel(totalSeconds) {
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const minutes = s / 60;
  if (Number.isInteger(minutes)) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const whole = Math.floor(minutes);
  const rest = s - whole * 60;
  return `${whole} min ${rest} s`;
}

/** Base phase class ('inhale' | 'hold' | 'exhale') from a phase's class string. */
function phaseKind(phase) {
  const first = String((phase && phase.class) || '').trim().split(/\s+/)[0];
  return first || String((phase && phase.name) || '').toLowerCase();
}

/**
 * The value written to `data-phase` on the app root and on the circle.
 * Same as phaseKind, except that cyclic sighing's short second inhale is its
 * own kind ('topup') — the CSS needs it, and it also guarantees that two
 * consecutive phases never share a value, which is what makes the
 * phase-word cross-fade and the reduced-motion pacing ring restart.
 */
function phaseState(phase) {
  const classes = String((phase && phase.class) || '').trim().split(/\s+/);
  if (classes.indexOf('inhale-short') !== -1) return 'topup';
  return phaseKind(phase);
}

/**
 * stroke-dashoffset of an empty ring, in the ring's own units. Must match
 * --ring-arc in css/styles.css (312 degrees of a circle with r=150).
 */
const RING_EMPTY = 816.81;

/**
 * The pattern in words, for the line under the technique name:
 * "In 4 · Hold 7 · Out 8". Cyclic sighing's short second inhale reads as
 * "In 2 · Sip 1 · Out 6". Seconds are shown as written in the technique.
 */
function patternLine(phases) {
  if (!Array.isArray(phases) || !phases.length) return '';
  const parts = [];
  for (const phase of phases) {
    const kind = phaseState(phase);
    const label = kind === 'inhale' ? 'In' : kind === 'exhale' ? 'Out' : kind === 'topup' ? 'Sip' : 'Hold';
    const seconds = Number(phase && phase.duration) || 0;
    parts.push(`${label} ${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}`);
  }
  return parts.join(' · ');
}

/* ========================================================================== *
 * createBreathingApp
 * ========================================================================== */

/**
 * Boot one breathing timer inside `rootEl`.
 * @param {HTMLElement} rootEl element carrying the timer markup
 * @param {object} [options]
 * @returns {{start:Function, pause:Function, stop:Function, selectTechnique:Function,
 *            setPattern:Function, getState:Function, destroy:Function}}
 */
export function createBreathingApp(rootEl, options = {}) {
  if (!rootEl || rootEl.nodeType !== 1) {
    throw new TypeError('createBreathingApp(rootEl): rootEl must be an element');
  }
  const existing = instances.find((i) => i.root === rootEl);
  if (existing) return existing.api;

  const data = rootEl.dataset;
  const query = readQuery();

  const lockTechnique = options.lockTechnique !== undefined ? !!options.lockTechnique : 'lockTechnique' in data;
  const kiosk = options.kiosk !== undefined ? !!options.kiosk : 'kiosk' in data;
  const autostart = options.autostart !== undefined ? !!options.autostart : 'autostart' in data;

  const stored = storage.getSettings();
  // Only what this browser actually chose — a page's data-* attributes are a
  // first-visit default and must not override a real preference.
  const saved = storage.getSavedSettings();

  const initialKey = resolveInitialTechnique({
    query,
    options,
    data,
    saved,
    lockTechnique,
  });

  const initialDuration = resolveInitialDuration({ query, options, data, saved, kiosk });

  /* ------------------------------------------------------------- elements */
  const q = (role) => rootEl.querySelector(`[data-role="${role}"]`);
  const el = {
    circle: q('circle'),
    circleText: q('circle-text'),
    phaseCount: q('phase-count'),
    breathingText: q('breathing-text'),
    timer: q('timer'),
    progressFill: q('progress-fill'),
    progressTime: q('progress-time'),
    sessionInfo: q('session-info'),
    sessionProgressFill: q('session-progress-fill'),
    sessionTimeRemaining: q('session-time-remaining'),
    start: q('start'),
    pause: q('pause'),
    stop: q('stop'),
    stats: q('stats'),
    breathCount: q('breath-count'),
    avgBreath: q('avg-breath'),
    sessionProgress: q('session-progress'),
    techniqueTitle: q('technique-title'),
    techniqueEyebrow: q('technique-eyebrow'),
    patternLine: q('pattern-line'),
    techniqueInfo: q('technique-info'),
    settingsBtn: q('settings-btn'),
    settingsPanel: q('settings-panel'),
    soundToggle: q('sound-toggle'),
    vibrationToggle: q('vibration-toggle'),
    durationSelect: q('duration-select'),
    techniqueButtons: q('technique-buttons'),
    safetyAck: q('safety-ack'),
    safetyAckBody: q('safety-ack-body'),
    liveRegion: q('live-region'),
  };

  /* ---------------------------------------------------------------- state */
  const state = {
    key: initialKey,
    technique: getTechnique(initialKey) || TECHNIQUES[DEFAULT_TECHNIQUE],
    phases: (getTechnique(initialKey) || TECHNIQUES[DEFAULT_TECHNIQUE]).phases,
    custom: null,
    running: false,
    paused: false,
    phaseIndex: 0,
    phaseCarry: 0,
    phaseAnchor: 0,
    breaths: 0,
    sessionCarry: 0,
    sessionAnchor: 0,
    duration: initialDuration,
    sound: stored.sound !== false,
    vibration: stored.vibration !== false,
  };

  let ticker = null;
  let wakeLock = null;
  let destroyed = false;
  let statsHideTimer = null;
  let resetTimer = null;
  /** CSS classes currently applied to the circle from the running phase. */
  let phaseClasses = [];
  // Where the ring gauge stands right now: RING_EMPTY (an empty rail) or 0 (full).
  let ringLevel = RING_EMPTY;

  /* ------------------------------------------------------------- rendering */

  function currentPhase() {
    return state.phases[state.phaseIndex] || state.phases[0];
  }

  function sessionElapsed() {
    if (!state.running) return state.sessionCarry;
    if (state.paused) return state.sessionCarry;
    return state.sessionCarry + (nowMs() - state.sessionAnchor) / 1000;
  }

  function announce(text) {
    if (!el.liveRegion) return;
    el.liveRegion.textContent = text;
  }

  function setText(node, text) {
    if (node) node.textContent = text;
  }

  function applyTheme() {
    if (themeLocked(rootEl) || !document.body) return;
    const theme = state.technique && state.technique.theme;
    if (!theme) return;
    for (const cls of THEME_CLASSES) {
      if (cls !== theme) document.body.classList.remove(cls);
    }
    document.body.classList.add(theme);
  }

  function applyCircleClass() {
    if (!el.circle) return;
    for (const cls of CIRCLE_CLASSES) el.circle.classList.remove(cls);
    const circleClass = state.technique && state.technique.circleClass;
    if (circleClass) el.circle.classList.add(circleClass);
    const cycle = cycleSeconds(state.phases);
    el.circle.style.animationDuration = cycle > 0 ? `${cycle}s` : '';
  }

  /**
   * Put the phase's own classes on the circle. A phase may declare more than
   * one (cyclic sighing's short top-up inhale is `inhale inhale-short`), so the
   * whole list is applied and removed together.
   */
  function applyPhaseClasses(phase) {
    // data-phase goes on the app root as well as on the circle: the phase word,
    // the count and the reduced-motion pacing ring all live outside the circle
    // now, and CSS closes the notch on a hold from this attribute.
    const kind = phaseState(phase);
    rootEl.dataset.phase = kind;
    rootEl.style.setProperty('--phase-duration', `${Number(phase && phase.duration) || 0}s`);
    // The ring around the disc is a breath gauge: it fills on an in-breath,
    // drains on an out-breath and stays where it is through a hold. CSS reads
    // the two ends of each sweep from these properties (stroke-dashoffset in
    // the ring's own units: RING_EMPTY is an empty rail, 0 is a full one).
    const from = ringLevel;
    if (kind === 'inhale' || kind === 'topup') ringLevel = 0;
    else if (kind === 'exhale') ringLevel = RING_EMPTY;
    rootEl.style.setProperty('--ring-from', String(from));
    rootEl.style.setProperty('--ring-to', String(ringLevel));
    // The custom-paced disc's target for this phase; a hold keeps the last one.
    if (kind === 'inhale') rootEl.style.setProperty('--disc-scale', '1');
    else if (kind === 'topup') rootEl.style.setProperty('--disc-scale', '1.08');
    else if (kind === 'exhale') rootEl.style.setProperty('--disc-scale', '0.72');
    if (!el.circle) return;
    for (const cls of phaseClasses) el.circle.classList.remove(cls);
    phaseClasses = String((phase && phase.class) || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (const cls of phaseClasses) el.circle.classList.add(cls);
    el.circle.dataset.phase = kind;
  }

  function clearPhaseClasses() {
    delete rootEl.dataset.phase;
    rootEl.style.removeProperty('--phase-duration');
    rootEl.style.removeProperty('--ring-from');
    rootEl.style.removeProperty('--ring-to');
    rootEl.style.removeProperty('--disc-scale');
    delete rootEl.dataset.paused;
    if (el.circle) el.circle.style.transform = '';
    ringLevel = RING_EMPTY;
    if (!el.circle) return;
    for (const cls of phaseClasses) el.circle.classList.remove(cls);
    phaseClasses = [];
    delete el.circle.dataset.phase;
  }

  function restartCircleAnimation() {
    if (!el.circle || prefersReducedMotion()) return;
    el.circle.style.animation = 'none';
    // Force a reflow so the animation restarts from 0 with the new technique.
    void el.circle.offsetHeight;
    el.circle.style.animation = '';
    // Clearing the `animation` shorthand also clears the inline
    // animation-duration applyCircleClass() just set. For the seven built-ins
    // css/styles.css carries the same value on .technique-<key>, but a custom
    // pattern (js/pro/patterns.js) has no technique-* class and would fall back
    // to the 10s default, so the circle would run at the wrong pace. Put the
    // real cycle length back.
    const cycle = cycleSeconds(state.phases);
    if (cycle > 0) el.circle.style.animationDuration = `${cycle}s`;
  }

  function renderTechniqueCopy() {
    const t = state.technique;
    setText(el.techniqueTitle, t.name);
    setText(el.techniqueEyebrow, t.shortName || t.title || '');
    setText(el.patternLine, patternLine(state.phases));
    if (el.techniqueInfo && !el.techniqueInfo.hasAttribute('data-static')) {
      el.techniqueInfo.replaceChildren();
      const h3 = document.createElement('h3');
      h3.textContent = t.title || t.name;
      const p = document.createElement('p');
      p.textContent = t.description || '';
      el.techniqueInfo.append(h3, p);
      // Hard rule 4: every breath-hold or fast-breathing pattern carries a
      // visible contraindication block wherever it can be chosen. Rendering it
      // here means the wording follows whatever the visitor actually selected,
      // on every page that hosts the engine, without per-page markup.
      if (needsCautionBlock(t)) {
        const box = document.createElement('div');
        box.className = 'callout callout--caution technique-cautions';
        box.setAttribute('data-role', 'technique-cautions');
        const h4 = document.createElement('h4');
        h4.textContent = 'Before you start this pattern';
        const ul = document.createElement('ul');
        for (const line of t.contraindications) {
          const li = document.createElement('li');
          li.textContent = line;
          ul.appendChild(li);
        }
        box.append(h4, ul);
        el.techniqueInfo.appendChild(box);
      }
    }
    if (el.safetyAckBody && Array.isArray(t.contraindications) && t.contraindications.length) {
      el.safetyAckBody.replaceChildren();
      const ul = document.createElement('ul');
      for (const line of t.contraindications) {
        const li = document.createElement('li');
        li.textContent = line;
        ul.appendChild(li);
      }
      el.safetyAckBody.appendChild(ul);
    }
  }

  function renderTechniqueButtons() {
    const buttons = rootEl.querySelectorAll('[data-action="select-technique"][data-technique]');
    for (const button of buttons) {
      const isActive = button.getAttribute('data-technique') === state.key;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    }
  }

  function syncButtons() {
    if (el.start) {
      el.start.disabled = state.running && !state.paused;
      el.start.textContent = state.paused ? 'Resume' : 'Begin Practice';
    }
    if (el.pause) el.pause.disabled = !state.running || state.paused;
    if (el.stop) el.stop.disabled = !state.running;
  }

  function resetDisplay() {
    setText(el.circleText, 'Ready');
    setText(el.phaseCount, '');
    setText(el.breathingText, 'Press Begin to start your practice');
    setText(el.timer, '00:00');
    if (el.progressFill) el.progressFill.style.width = '0%';
    setText(el.progressTime, '');
    if (el.circle) el.circle.classList.remove('active');
    clearPhaseClasses();
    if (el.sessionInfo) el.sessionInfo.style.display = 'none';
    if (el.sessionProgressFill) el.sessionProgressFill.style.width = '0%';
    setText(el.sessionTimeRemaining, '');
    setText(el.breathCount, '0');
    setText(el.avgBreath, '0s');
    setText(el.sessionProgress, '0%');
  }

  function updateStats(elapsed) {
    setText(el.breathCount, String(state.breaths));
    const avg = state.breaths > 0 ? Math.round(elapsed / state.breaths) : 0;
    setText(el.avgBreath, `${avg}s`);
    if (el.sessionProgress) {
      el.sessionProgress.textContent =
        state.duration > 0 ? `${Math.round(clamp((elapsed / state.duration) * 100, 0, 100))}%` : '∞';
    }
  }

  function updateSessionProgress(elapsed) {
    if (state.duration <= 0) {
      if (el.sessionInfo) el.sessionInfo.style.display = 'none';
      return;
    }
    if (el.sessionInfo) el.sessionInfo.style.display = 'block';
    const progress = clamp(elapsed / state.duration, 0, 1);
    if (el.sessionProgressFill) el.sessionProgressFill.style.width = `${progress * 100}%`;
    const remaining = Math.max(state.duration - elapsed, 0);
    setText(
      el.sessionTimeRemaining,
      `${Math.floor(remaining / 60)}:${String(Math.floor(remaining % 60)).padStart(2, '0')} remaining`,
    );
  }

  /* --------------------------------------------------------------- phases */

  function enterPhase(anchor) {
    const phase = currentPhase();
    if (!phase) return;
    state.phaseCarry = 0;
    state.phaseAnchor = anchor === undefined ? nowMs() : anchor;

    if (state.phaseIndex === 0) state.breaths += 1;

    setText(el.circleText, phase.name);
    setText(el.phaseCount, String(Math.max(1, Math.ceil(phase.duration))));
    setText(el.breathingText, phase.text);
    applyPhaseClasses(phase);

    const unit = phase.duration === 1 ? 'second' : 'seconds';
    announce(`${phase.name} for ${phase.duration} ${unit}`);

    if (state.sound && phase.frequency > 0) {
      try {
        audioSystem.createBreathSound(phase.frequency, phase.duration, phaseKind(phase));
      } catch (error) {
        console.warn('Audio error:', error);
      }
    }

    if (phase.name === 'Inhale') vibrate([50, 100, 50], state.vibration);
    else if (phase.name === 'Exhale') vibrate([100, 50, 100], state.vibration);

    emit('hmb:phase', {
      ...baseDetail(),
      phase: phase.name,
      phaseKind: phaseKind(phase),
      phaseIndex: state.phaseIndex,
      phaseDuration: phase.duration,
    });
  }

  function tick() {
    if (!state.running || state.paused) return;
    const t = nowMs();
    const phase = currentPhase();
    if (!phase) return;

    const phaseElapsed = state.phaseCarry + (t - state.phaseAnchor) / 1000;
    const phaseProgress = clamp(phaseElapsed / phase.duration, 0, 1);
    // Reduced motion: the bar still advances, but in whole-second steps rather
    // than as a continuous slide.
    const shownProgress = prefersReducedMotion()
      ? clamp(Math.floor(phaseElapsed) / phase.duration, 0, 1)
      : phaseProgress;
    if (el.progressFill) el.progressFill.style.width = `${shownProgress * 100}%`;
    const remainingInPhase = Math.max(0, Math.ceil(phase.duration - phaseElapsed));
    setText(el.progressTime, `${remainingInPhase}s`);
    setText(el.phaseCount, String(Math.max(1, remainingInPhase)));

    const elapsed = state.sessionCarry + (t - state.sessionAnchor) / 1000;
    setText(el.timer, formatClock(elapsed));
    updateSessionProgress(elapsed);
    updateStats(elapsed);

    if (state.duration > 0 && elapsed >= state.duration) {
      finish(true, state.duration);
      return;
    }
    if (phaseElapsed >= phase.duration) {
      state.phaseIndex = (state.phaseIndex + 1) % state.phases.length;
      enterPhase(t);
    }
  }

  function startTicker() {
    if (ticker === null) ticker = window.setInterval(tick, TICK_MS);
  }

  function stopTicker() {
    if (ticker !== null) {
      window.clearInterval(ticker);
      ticker = null;
    }
  }

  /* ----------------------------------------------------------- wake lock */

  async function requestWakeLock() {
    if (!kiosk || typeof navigator === 'undefined' || !navigator.wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      wakeLock = null;
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

  /* ------------------------------------------------------------ lifecycle */

  function baseDetail() {
    return {
      technique: state.key,
      seconds: Math.round(sessionElapsed()),
      breaths: state.breaths,
      completed: false,
      root: rootEl,
      instance: api,
    };
  }

  /* A one-line suggestion, offered once, after a session that began late.
     Armed at start so a session that runs past midnight still counts as late,
     never rendered during a session, and never on a `data-no-asks` page. */
  let nightHintArmed = false;

  function prefersDark() {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    );
  }

  function armNightHint() {
    const hour = new Date().getHours();
    const body = document.body;
    nightHintArmed =
      (hour >= 21 || hour < 6) &&
      !!body &&
      body.dataset.noAsks !== 'true' &&
      !body.classList.contains('night') &&
      !body.classList.contains('day') &&
      // The page already follows the device. Offering to "dim the page" to
      // someone looking at a dark page sells them what they can see they have.
      !prefersDark() &&
      storage.getFlag('night-hint-dismissed') !== true;
  }

  function showNightHint() {
    if (!nightHintArmed) return;
    nightHintArmed = false;
    const slot = rootEl.querySelector('[data-slot="post-session"]');
    if (!slot || slot.querySelector('.night-hint')) return;
    const line = document.createElement('p');
    line.className = 'night-hint';
    line.append(
      document.createTextNode(
        'Practising this late? Pro adds a night switch, so the page stays dark even in daylight.',
      ),
    );
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'night-hint-dismiss';
    dismiss.textContent = 'No thanks';
    dismiss.addEventListener('click', () => {
      storage.setFlag('night-hint-dismissed', true);
      line.remove();
    });
    line.appendChild(dismiss);
    slot.appendChild(line);
  }

  function showSafetyAck() {
    if (!el.safetyAck) return false;
    el.safetyAck.hidden = false;
    el.safetyAck.classList.add('show');
    const confirm = el.safetyAck.querySelector('[data-action="safety-ack-confirm"]');
    if (confirm && typeof confirm.focus === 'function') confirm.focus();
    return true;
  }

  function hideSafetyAck() {
    if (!el.safetyAck) return;
    el.safetyAck.hidden = true;
    el.safetyAck.classList.remove('show');
  }

  function needsSafetyAck() {
    const t = state.technique;
    if (!t || !t.requiresSafetyAck) return false;
    return storage.getFlag(`ack.${state.key}`) !== true;
  }

  /**
   * Preview mode (design section 8.2): nothing runs, nothing is counted, no
   * audio, no vibration. Dispatch `hmb:preview` so js/pro/preview.js can show
   * the account card; the disc stays still and the page stays fully readable.
   */
  function enterPreview() {
    const reason = signedIn() ? 'no_subscription' : 'signed_out';
    if (el.circle) el.circle.classList.remove('active');
    emit('hmb:preview', {
      ...baseDetail(),
      reason,
      phases: state.phases.map((p) => ({ ...p })),
    });
  }

  function start() {
    if (destroyed) return;
    if (state.running && state.paused) {
      resume();
      return;
    }
    if (state.running) return;

    if (needsSafetyAck()) {
      if (showSafetyAck()) return;
    }
    hideSafetyAck();

    // The one gate on Start (design section 8.1). The two crisis pages carry
    // data-open-timer and pass straight through; a
    // subscriber passes; a device inside its free sessions passes. Otherwise
    // the engine enters the preview state instead of running: js/pro/preview.js
    // renders the account card and nothing animates. A session counts against
    // the allowance the moment it STARTS (js/entitlements.js listens for
    // hmb:session-start), finished or not.
    if (!requireTimer({ technique: state.key })) {
      enterPreview();
      return;
    }

    audioSystem.init();
    if (resetTimer) {
      window.clearTimeout(resetTimer);
      resetTimer = null;
    }
    if (statsHideTimer) {
      window.clearTimeout(statsHideTimer);
      statsHideTimer = null;
    }

    state.duration = readDurationFromSelect();
    state.running = true;
    state.paused = false;
    state.phaseIndex = 0;
    state.breaths = 0;
    state.sessionCarry = 0;
    state.sessionAnchor = nowMs();

    if (el.stats) el.stats.style.display = 'flex';
    if (el.sessionInfo) el.sessionInfo.style.display = state.duration > 0 ? 'block' : 'none';
    if (el.circle) {
      el.circle.classList.add('active');
      applyCircleClass();
      restartCircleAnimation();
    }

    setBodySessionActive(1);
    syncButtons();
    vibrate(100, state.vibration);
    requestWakeLock();

    enterPhase(state.sessionAnchor);
    startTicker();

    armNightHint();
    emit('hmb:session-start', { ...baseDetail(), duration: state.duration });
    track(EVENTS.SESSION_START, {
      technique: state.key,
      duration_seconds: state.duration,
      kiosk: kiosk ? 1 : 0,
    });
  }

  function resume() {
    if (!state.running || !state.paused) return;
    const t = nowMs();
    state.paused = false;
    state.phaseAnchor = t;
    state.sessionAnchor = t;
    delete rootEl.dataset.paused;
    if (el.circle) {
      // A custom-paced disc was frozen inline by pause(); let it move again.
      el.circle.style.transform = '';
      // `.active` flips animation-play-state back to running, so the keyframes
      // carry on from exactly where the pause froze them — in step with the
      // engine's phase pointer. Restarting them here (as a technique swap
      // does) snapped the orb back to the start of the inhale for the rest
      // of the session.
      el.circle.classList.add('active');
    }
    const phase = currentPhase();
    setText(el.breathingText, phase ? phase.text : '');
    // Announce the phase again on resume: without this the live region still
    // reads "Paused" and a screen-reader user gets no confirmation that Space
    // restarted the session.
    if (phase) {
      const unit = phase.duration === 1 ? 'second' : 'seconds';
      announce(`Resumed. ${phase.name} for ${phase.duration} ${unit}`);
    } else {
      announce('Resumed');
    }
    syncButtons();
    startTicker();
  }

  function pause() {
    if (!state.running || state.paused) return;
    const t = nowMs();
    state.phaseCarry += (t - state.phaseAnchor) / 1000;
    state.sessionCarry += (t - state.sessionAnchor) / 1000;
    state.paused = true;
    stopTicker();
    // The ring gauge reads this to freeze its sweep alongside the disc.
    rootEl.dataset.paused = '';
    if (el.circle) {
      if (el.circle.classList.contains('custom-pace')) {
        // A transition cannot be paused: pin the disc where it is.
        el.circle.style.transform = getComputedStyle(el.circle).transform;
      }
      el.circle.classList.remove('active');
    }
    setText(el.breathingText, 'Paused — press Begin to continue');
    announce('Paused');
    syncButtons();
    emit('hmb:session-pause', baseDetail());
  }

  function finish(completed, elapsedOverride) {
    if (!state.running) return;
    const elapsed = elapsedOverride === undefined ? sessionElapsed() : elapsedOverride;
    const seconds = Math.max(0, Math.round(elapsed));
    const breaths = state.breaths;
    const techniqueKey = state.key;

    state.running = false;
    state.paused = false;
    stopTicker();
    setBodySessionActive(-1);
    releaseWakeLock();
    syncButtons();

    if (el.circle) el.circle.classList.remove('active');

    if (completed) {
      setText(el.circleText, 'Done');
      setText(el.breathingText, 'Session complete. Well done.');
      announce('Session complete');
      vibrate([200, 100, 200, 100, 200], state.vibration);
    } else {
      announce('Session stopped');
      vibrate([100, 50, 100], state.vibration);
    }

    if (completed || seconds >= MIN_RECORDED_SECONDS) {
      storage.appendSession({
        date: new Date().toISOString(),
        technique: techniqueKey,
        seconds,
        breaths,
        completed: !!completed,
      });
    }

    const detail = {
      technique: techniqueKey,
      seconds,
      breaths,
      completed: !!completed,
      root: rootEl,
      instance: api,
    };

    if (completed) {
      emit('hmb:session-complete', detail);
      track(EVENTS.SESSION_COMPLETE, { technique: techniqueKey, seconds, breaths });
      const completedCount = storage.completedSessionCount();
      if (completedCount >= 3 && storage.getFlag('third-session-tracked') !== true) {
        storage.setFlag('third-session-tracked', true);
        track(EVENTS.THIRD_SESSION_REACHED, { technique: techniqueKey, sessions: completedCount });
      }
    } else {
      emit('hmb:session-stop', detail);
      if (seconds > 0) {
        track(EVENTS.SESSION_ABANDON, { technique: techniqueKey, seconds, breaths });
      }
    }

    showNightHint();

    resetTimer = window.setTimeout(() => {
      resetTimer = null;
      if (state.running) return;
      setText(el.circleText, 'Ready');
      if (!completed) setText(el.breathingText, 'Press Begin to start your practice');
      if (el.progressFill) el.progressFill.style.width = '0%';
      setText(el.progressTime, '');
      setText(el.timer, '00:00');
      if (el.sessionInfo) el.sessionInfo.style.display = 'none';
      clearPhaseClasses();
      statsHideTimer = window.setTimeout(() => {
        statsHideTimer = null;
        if (!state.running && el.stats) el.stats.style.display = 'none';
      }, 3000);
    }, 600);

    if (kiosk && completed) {
      window.setTimeout(() => {
        if (!destroyed && !state.running) start();
      }, 3000);
    }
  }

  function stop() {
    if (!state.running) return;
    finish(false);
  }

  function toggle() {
    if (state.running && !state.paused) pause();
    else start();
  }

  /* ------------------------------------------------------- technique swap */

  function selectTechnique(key, opts = {}) {
    if (destroyed) return null;
    if (lockTechnique && !opts.force) return state.technique;
    const technique = getTechnique(key);
    if (!technique) return null;
    if (state.key === key && !opts.force && !state.custom && !opts.silent) return technique;

    if (state.running) finish(false);

    state.key = key;
    state.technique = technique;
    state.phases = technique.phases;
    state.custom = null;
    state.phaseIndex = 0;

    applyTheme();
    syncThemeColor(key);
    applyCircleClass();
    renderTechniqueCopy();
    renderTechniqueButtons();
    resetDisplay();
    syncButtons();
    hideSafetyAck();

    if (!opts.silent) {
      storage.saveSettings({ technique: key });
      track(EVENTS.TECHNIQUE_SELECT, { technique: key });
    }
    emit('hmb:technique-change', { ...baseDetail(), technique: key });
    return technique;
  }

  /**
   * Run an ad-hoc pattern (the Pro pattern builder uses this).
   * @param {{inhale?:number, hold1?:number, exhale?:number, hold2?:number}} pattern
   * @param {{name?:string, title?:string, description?:string}} [meta]
   */
  function setPattern(pattern, meta = {}) {
    const phases = patternToPhases(pattern);
    if (!phases.length) return null;
    if (state.running) finish(false);

    const base = state.technique;
    state.custom = {
      ...base,
      key: 'custom',
      // Its own disc: the engine paces it phase by phase (data-phase and
      // --disc-scale on the root), because a fixed keyframe cannot know the
      // user's proportions. The base technique's keyframe was scaled onto it
      // before, so the orb contradicted the pattern it was pacing.
      circleClass: 'custom-pace',
      slug: '',
      name: meta.name || 'Custom pattern',
      shortName: meta.name || 'Custom',
      title: meta.title || meta.name || 'Custom pattern',
      description: meta.description || 'Your own pattern. It runs exactly like the built-in ones.',
      phases,
      requiresSafetyAck: false,
    };
    state.technique = state.custom;
    state.phases = phases;
    state.key = 'custom';
    state.phaseIndex = 0;

    applyCircleClass();
    renderTechniqueCopy();
    renderTechniqueButtons();
    resetDisplay();
    syncButtons();
    emit('hmb:technique-change', { ...baseDetail(), technique: 'custom', pattern: { ...pattern } });
    return phases;
  }

  function getState() {
    return {
      technique: state.key,
      phases: state.phases.map((p) => ({ ...p })),
      running: state.running,
      paused: state.paused,
      phaseIndex: state.phaseIndex,
      breaths: state.breaths,
      seconds: Math.round(sessionElapsed()),
      duration: state.duration,
      sound: state.sound,
      vibration: state.vibration,
      kiosk,
      lockTechnique,
    };
  }

  /* ------------------------------------------------------------- settings */

  function readDurationFromSelect() {
    if (kiosk && !('duration' in rootEl.dataset) && !query.d) return -1;
    if (!el.durationSelect) return state.duration;
    const value = parseInt(el.durationSelect.value, 10);
    return Number.isFinite(value) ? value : state.duration;
  }

  function primeDurationSelect() {
    if (!el.durationSelect) return;
    const wanted = String(state.duration);
    const hasOption = Array.from(el.durationSelect.options).some((o) => o.value === wanted);
    if (!hasOption && DURATION_OPTIONS.indexOf(state.duration) === -1 && state.duration > 0) {
      const option = document.createElement('option');
      option.value = wanted;
      option.textContent = durationLabel(state.duration);
      el.durationSelect.appendChild(option);
    }
    el.durationSelect.value = wanted;
    if (el.durationSelect.value !== wanted) {
      state.duration = parseInt(el.durationSelect.value, 10) || 600;
    }
  }

  function setToggleState(node, on) {
    if (!node) return;
    node.classList.toggle('active', !!on);
    node.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (!node.hasAttribute('role')) node.setAttribute('role', 'button');
    if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '0');
  }

  function toggleSound() {
    state.sound = !state.sound;
    setToggleState(el.soundToggle, state.sound);
    storage.saveSettings({ sound: state.sound });
    if (state.sound) audioSystem.init();
  }

  function toggleVibration() {
    state.vibration = !state.vibration;
    setToggleState(el.vibrationToggle, state.vibration);
    storage.saveSettings({ vibration: state.vibration });
  }

  function openSettings(open) {
    if (!el.settingsPanel) return;
    const willOpen = open === undefined ? !el.settingsPanel.classList.contains('show') : !!open;
    el.settingsPanel.classList.toggle('show', willOpen);
    if (el.settingsBtn) el.settingsBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) track(EVENTS.SETTINGS_OPEN, { technique: state.key });
  }

  /* --------------------------------------------------------------- events */

  function onClick(event) {
    const actionEl = event.target.closest('[data-action]');
    if (actionEl && rootEl.contains(actionEl)) {
      const action = actionEl.getAttribute('data-action');
      switch (action) {
        case 'start':
          event.preventDefault();
          start();
          return;
        case 'pause':
          event.preventDefault();
          pause();
          return;
        case 'stop':
          event.preventDefault();
          stop();
          return;
        case 'select-technique':
          event.preventDefault();
          selectTechnique(actionEl.getAttribute('data-technique'));
          return;
        case 'toggle-settings':
          event.preventDefault();
          event.stopPropagation();
          openSettings();
          return;
        case 'safety-ack-confirm':
          event.preventDefault();
          storage.setFlag(`ack.${state.key}`, true);
          hideSafetyAck();
          start();
          return;
        case 'safety-ack-cancel':
          event.preventDefault();
          hideSafetyAck();
          if (el.start && typeof el.start.focus === 'function') el.start.focus();
          return;
        default:
          break;
      }
    }

    const roleEl = event.target.closest('[data-role]');
    if (!roleEl || !rootEl.contains(roleEl)) return;
    const role = roleEl.getAttribute('data-role');
    if (role === 'sound-toggle') {
      event.preventDefault();
      toggleSound();
    } else if (role === 'vibration-toggle') {
      event.preventDefault();
      toggleVibration();
    } else if (role === 'settings-btn') {
      event.preventDefault();
      event.stopPropagation();
      openSettings();
    }
  }

  function onRootKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    const roleEl = event.target.closest('[data-role]');
    if (!roleEl || !rootEl.contains(roleEl)) return;
    const role = roleEl.getAttribute('data-role');
    if (role === 'sound-toggle') {
      event.preventDefault();
      toggleSound();
    } else if (role === 'vibration-toggle') {
      event.preventDefault();
      toggleVibration();
    }
  }

  function onDurationChange() {
    const value = parseInt(el.durationSelect.value, 10);
    if (!Number.isFinite(value)) return;
    state.duration = value;
    storage.saveSettings({ duration: value });
    if (el.sessionInfo) el.sessionInfo.style.display = state.running && value > 0 ? 'block' : 'none';
    if (state.running) updateSessionProgress(sessionElapsed());
  }

  function onDocumentClick(event) {
    if (!el.settingsPanel || !el.settingsPanel.classList.contains('show')) return;
    if (el.settingsPanel.contains(event.target)) return;
    if (el.settingsBtn && el.settingsBtn.contains(event.target)) return;
    openSettings(false);
  }

  rootEl.addEventListener('click', onClick);
  rootEl.addEventListener('keydown', onRootKeydown);
  if (el.durationSelect) el.durationSelect.addEventListener('change', onDurationChange);
  document.addEventListener('click', onDocumentClick);

  /* ----------------------------------------------------------------- boot */

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (state.running) {
      state.running = false;
      setBodySessionActive(-1);
    }
    stopTicker();
    releaseWakeLock();
    if (resetTimer) window.clearTimeout(resetTimer);
    if (statsHideTimer) window.clearTimeout(statsHideTimer);
    rootEl.removeEventListener('click', onClick);
    rootEl.removeEventListener('keydown', onRootKeydown);
    if (el.durationSelect) el.durationSelect.removeEventListener('change', onDurationChange);
    document.removeEventListener('click', onDocumentClick);
    const index = instances.findIndex((i) => i.root === rootEl);
    if (index !== -1) instances.splice(index, 1);
  }

  const api = { start, pause, stop, selectTechnique, setPattern, getState, destroy };
  instances.push({ root: rootEl, api, internals: { toggle, state } });

  if (kiosk) {
    rootEl.classList.add('kiosk');
    rootEl.setAttribute('data-kiosk-active', 'true');
  }
  if (el.safetyAck) el.safetyAck.hidden = true;
  if (el.liveRegion) {
    el.liveRegion.setAttribute('aria-live', 'polite');
    el.liveRegion.setAttribute('aria-atomic', 'true');
    if (!el.liveRegion.classList.contains('live-region')) el.liveRegion.classList.add('live-region');
  }
  if (el.settingsBtn) {
    el.settingsBtn.setAttribute('aria-expanded', 'false');
    if (!el.settingsBtn.hasAttribute('data-action')) el.settingsBtn.setAttribute('data-action', 'toggle-settings');
  }

  setToggleState(el.soundToggle, state.sound);
  setToggleState(el.vibrationToggle, state.vibration);
  primeDurationSelect();

  if (el.vibrationToggle && (typeof navigator === 'undefined' || !navigator.vibrate)) {
    const row = el.vibrationToggle.closest('.setting-item');
    if (row) row.style.display = 'none';
  }

  selectTechnique(state.key, { silent: true, force: true });
  resetDisplay();
  syncButtons();

  emit('hmb:ready', { ...baseDetail(), duration: state.duration });

  if (autostart || kiosk) {
    window.setTimeout(() => {
      if (!destroyed && !state.running) start();
    }, 300);
  }

  return api;
}

/* ========================================================================== *
 * Option resolution
 * ========================================================================== */

function readQuery() {
  try {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('t');
    const d = params.get('d');
    return {
      t: t && getTechnique(t) ? t : null,
      d: d && Number.isFinite(parseInt(d, 10)) ? parseInt(d, 10) : null,
    };
  } catch {
    return { t: null, d: null };
  }
}

function resolveInitialTechnique({ query, options, data, saved, lockTechnique }) {
  if (query.t) return query.t;
  if (options.technique && getTechnique(options.technique)) return options.technique;
  if (lockTechnique && data.technique && getTechnique(data.technique)) return data.technique;
  if (saved.technique && getTechnique(saved.technique)) return saved.technique;
  if (data.technique && getTechnique(data.technique)) return data.technique;
  const fromPath = techniqueForPath(window.location.pathname);
  if (fromPath) return fromPath.key;
  return DEFAULT_TECHNIQUE;
}

function resolveInitialDuration({ query, options, data, saved, kiosk }) {
  if (query.d !== null && query.d !== undefined) return query.d;
  if (Number.isFinite(Number(options.duration))) return Number(options.duration);
  if (Number.isFinite(Number(saved.duration))) return Number(saved.duration);
  if (data.duration && Number.isFinite(parseInt(data.duration, 10))) return parseInt(data.duration, 10);
  return kiosk ? -1 : 600;
}

/* ========================================================================== *
 * Page-level wiring (registered once)
 * ========================================================================== */

/** Every live instance, in DOM order. */
export function getApps() {
  return instances.map((i) => i.api);
}

/** The instance whose root is `rootEl`, or null. */
export function getApp(rootEl) {
  const found = instances.find((i) => i.root === rootEl);
  return found ? found.api : null;
}

/**
 * The light-scheme theme-color meta follows the stage: Deep Sleep paints the
 * dusk band from the top of the page, and the browser chrome should match it
 * (the installed app's shortcut opens straight into that state).
 * @param {string} key
 */
function syncThemeColor(key) {
  if (typeof document === 'undefined') return;
  const meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (meta) meta.setAttribute('content', key === '478' ? '#1F2745' : '#F4F6F5');
}

function focusedInstance() {
  if (!instances.length) return null;
  const active = document.activeElement;
  if (active) {
    const owner = instances.find((i) => i.root.contains(active));
    if (owner) return owner;
  }
  // Nothing in a timer has focus. The shortcuts still work while the timer is
  // on screen (press Space to begin), but not once the reader has scrolled
  // down into the article: there Space must page down, S must type, and a
  // digit must not start a session out of view (WCAG 2.1.4).
  if (active && active !== document.body) return null;
  const rect = instances[0].root.getBoundingClientRect();
  const visible = rect.bottom > 0 && rect.top < window.innerHeight;
  return visible ? instances[0] : null;
}

function onGlobalKeydown(event) {
  const target = event.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
  if (target && target.isContentEditable) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  const owner = focusedInstance();
  if (!owner) return;

  if (event.code === 'Space') {
    // Space on a focused button is that button's own activation, not ours.
    if (target && target.closest && target.closest('button, [role="button"], a[href]')) return;
    event.preventDefault();
    owner.internals.toggle();
    return;
  }
  if (event.code === 'KeyS') {
    if (owner.api.getState().running) {
      event.preventDefault();
      owner.api.stop();
    }
    return;
  }
  const digit = /^Digit([1-7])$/.exec(event.code);
  if (digit) {
    const key = TECHNIQUE_ORDER[Number(digit[1]) - 1];
    if (key) {
      event.preventDefault();
      owner.api.selectTechnique(key);
    }
  }
}

function showKeyboardHint() {
  const hint = document.querySelector('[data-role="keyboard-hint"]');
  if (!hint) return;
  window.setTimeout(() => {
    hint.classList.add('show');
    window.setTimeout(() => hint.classList.remove('show'), 5000);
  }, 3000);
}

function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const host = window.location.hostname;
  const secure = window.location.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1';
  if (!secure) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {
      /* the site works fine without it */
    });
  });
}

/**
 * The site header collapses its nav behind a menu button on narrow screens.
 * One delegated listener, registered once per page; it touches nothing the
 * breathing engine owns.
 */
function wireSiteNav() {
  document.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-action="toggle-nav"]');
    if (!toggle) return;
    event.preventDefault();
    const nav = document.getElementById(toggle.getAttribute('aria-controls') || 'site-nav');
    if (!nav) return;
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    nav.classList.toggle('is-open', open);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const toggle = document.querySelector('[data-action="toggle-nav"][aria-expanded="true"]');
    if (!toggle) return;
    const nav = document.getElementById(toggle.getAttribute('aria-controls') || 'site-nav');
    toggle.setAttribute('aria-expanded', 'false');
    if (nav) nav.classList.remove('is-open');
    toggle.focus();
  });
}

function wireInstallTracking() {
  window.addEventListener('beforeinstallprompt', () => {
    track(EVENTS.PWA_INSTALL, { stage: 'available' });
  });
  window.addEventListener('appinstalled', () => {
    track(EVENTS.PWA_INSTALL, { stage: 'installed' });
  });
}

function initAll() {
  const roots = document.querySelectorAll('[data-breathing-app]');
  for (const root of roots) {
    try {
      createBreathingApp(root);
    } catch (error) {
      console.error('Breathing app failed to initialise:', error);
    }
  }
  if (roots.length) {
    showKeyboardHint();
    document.addEventListener(
      'click',
      () => {
        if (!audioSystem.isInitialized) audioSystem.init();
      },
      { once: true },
    );
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', onGlobalKeydown);
  wireSiteNav();
  wireInstallTracking();
  registerServiceWorker();

  window.addEventListener('beforeunload', () => {
    for (const item of instances) {
      const s = item.api.getState();
      if (s.running) track(EVENTS.SESSION_ABANDON, { technique: s.technique, seconds: s.seconds, breaths: s.breaths });
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll, { once: true });
  } else {
    initAll();
  }
}
