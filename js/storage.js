/**
 * js/storage.js — every localStorage read and write on the site goes through here.
 *
 * Rules:
 *   - Every key lives under the `hmb.` namespace.
 *   - Every call is try/catch safe. Private browsing, disabled storage and quota
 *     errors must never break the timer, so a same-tab in-memory mirror is used
 *     as a fallback and the app behaves identically (it just forgets on reload).
 *   - Nothing here is sent anywhere. No identifiers, no network.
 *
 * Contract (see docs/MODULE_API.md):
 *   getSettings(), saveSettings(patch),
 *   appendSession(record), getHistory(), completedSessionCount(),
 *   startedSessionCount(), recordSessionStart(),
 *   getFlag(name), setFlag(name, value),
 *   clearHistory(), setPersistence(enabled)
 */

const NS = 'hmb.';
const KEY_SETTINGS = NS + 'settings';
const KEY_HISTORY = NS + 'history';
/** Sessions STARTED on this device: the free allowance counts these. */
const KEY_STARTED = NS + 'sessions_started';

/** Oldest entries are evicted once history passes this length. */
export const HISTORY_LIMIT = 500;

export const DEFAULT_SETTINGS = {
  technique: '478',
  duration: 600,
  sound: true,
  vibration: true,
};

/** Same-tab mirror used when localStorage is unavailable or throws. */
const memory = new Map();

/** Set false to keep everything in memory for the rest of the page's life. */
let persistence = true;

/**
 * Turn persistence on or off at runtime. Settings are functional storage (a
 * user preference, no identifier, never transmitted), so it defaults to on.
 * @param {boolean} enabled
 */
export function setPersistence(enabled) {
  persistence = enabled !== false;
}

function backing() {
  if (!persistence) return null;
  try {
    const ls = window.localStorage;
    // Touch it: Safari in Lockdown/private mode throws on access, not on use.
    const probe = NS + 'probe';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

function readRaw(key) {
  const ls = backing();
  if (ls) {
    try {
      const value = ls.getItem(key);
      if (value !== null) return value;
    } catch {
      /* fall through to the memory mirror */
    }
  }
  return memory.has(key) ? memory.get(key) : null;
}

function writeRaw(key, value) {
  memory.set(key, value);
  const ls = backing();
  if (!ls) return false;
  try {
    ls.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeRaw(key) {
  memory.delete(key);
  const ls = backing();
  if (!ls) return;
  try {
    ls.removeItem(key);
  } catch {
    /* ignore */
  }
}

function readJson(key, fallback) {
  const raw = readRaw(key);
  if (raw == null) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    return writeRaw(key, JSON.stringify(value));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ settings */

/**
 * Only the settings this browser has actually chosen. Keys the visitor never
 * touched are absent, which is what lets a page's own `data-technique` /
 * `data-duration` act as a first-visit default without overriding a real choice.
 * @returns {Partial<{technique:string, duration:number, sound:boolean, vibration:boolean}>}
 */
export function getSavedSettings() {
  const stored = readJson(KEY_SETTINGS, null);
  const out = {};
  if (stored && typeof stored === 'object') {
    if (typeof stored.technique === 'string') out.technique = stored.technique;
    if (Number.isFinite(Number(stored.duration))) out.duration = Number(stored.duration);
    if (typeof stored.sound === 'boolean') out.sound = stored.sound;
    if (typeof stored.vibration === 'boolean') out.vibration = stored.vibration;
  }
  return out;
}

/**
 * Saved settings merged over the defaults. Always returns a complete object.
 * @returns {{technique:string, duration:number, sound:boolean, vibration:boolean}}
 */
export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...getSavedSettings() };
}

/**
 * Merge a patch into the saved settings. Only the keys you pass (and the keys
 * already saved) are written, so untouched settings stay untouched.
 * @param {Partial<{technique:string, duration:number, sound:boolean, vibration:boolean}>} patch
 * @returns {object} the complete settings after the merge
 */
export function saveSettings(patch) {
  const next = { ...getSavedSettings(), ...(patch && typeof patch === 'object' ? patch : {}) };
  writeJson(KEY_SETTINGS, next);
  return { ...DEFAULT_SETTINGS, ...next };
}

/* ------------------------------------------------------------------- history */

/**
 * Every stored session record, oldest first.
 * @returns {Array<{date:string, technique:string, seconds:number, breaths:number, completed:boolean}>}
 */
export function getHistory() {
  const list = readJson(KEY_HISTORY, []);
  return Array.isArray(list) ? list.filter((r) => r && typeof r === 'object') : [];
}

/**
 * Append one session record. Caps the list at HISTORY_LIMIT, oldest evicted.
 * @param {{date?:string, technique:string, seconds:number, breaths:number, completed:boolean}} record
 * @returns {object|null} the stored record, or null when the input was unusable
 */
export function appendSession(record) {
  if (!record || typeof record !== 'object') return null;
  const entry = {
    date: typeof record.date === 'string' ? record.date : new Date().toISOString(),
    technique: String(record.technique || 'unknown'),
    seconds: Math.max(0, Math.round(Number(record.seconds) || 0)),
    breaths: Math.max(0, Math.round(Number(record.breaths) || 0)),
    completed: record.completed === true,
  };
  const history = getHistory();
  history.push(entry);
  while (history.length > HISTORY_LIMIT) history.shift();
  writeJson(KEY_HISTORY, history);
  return entry;
}

/** How many stored sessions ran to completion. */
export function completedSessionCount() {
  let n = 0;
  for (const record of getHistory()) if (record.completed === true) n++;
  return n;
}

/**
 * How many sessions have been STARTED on this device — a Begin that ran,
 * finished or not. The free allowance counts starts, so stopping early or
 * closing the tab spends one too; counting only completions let anyone run
 * the timer forever by never finishing a session.
 * @returns {number}
 */
export function startedSessionCount() {
  const n = Number(readJson(KEY_STARTED, 0));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Count one started session.
 * @returns {number} the new count
 */
export function recordSessionStart() {
  const n = startedSessionCount() + 1;
  writeJson(KEY_STARTED, n);
  return n;
}

/** Remove every stored session record. */
export function clearHistory() {
  removeRaw(KEY_HISTORY);
}

/* --------------------------------------------------------------------- flags */

/**
 * Read a namespaced flag. `getFlag('ack.wim')` reads `hmb.ack.wim`.
 * @param {string} name
 * @returns {string|boolean|null} true/false for booleans, the string otherwise
 */
export function getFlag(name) {
  if (!name) return null;
  const raw = readRaw(NS + String(name));
  if (raw === null) return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

/**
 * Write a namespaced flag. Passing null or undefined removes it.
 * @param {string} name
 * @param {string|boolean|number|null} value
 */
export function setFlag(name, value) {
  if (!name) return;
  const key = NS + String(name);
  if (value === null || value === undefined) {
    removeRaw(key);
    return;
  }
  writeRaw(key, typeof value === 'string' ? value : String(value));
}
