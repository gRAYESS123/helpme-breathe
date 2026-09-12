/**
 * tools/gate.test.mjs — the browser-side timer gate (js/entitlements.js
 * requireTimer, design §8.1) while sign-in is not configured.
 *
 *   node --test tools/gate.test.mjs
 *
 * Zero dependencies, no network, no browser. js/entitlements.js is imported
 * under Node with a small stub of window/document/localStorage installed
 * first, and js/config.js is read as committed (SUPABASE empty), which is the
 * state the site ships in until the owner fills the values in.
 *
 * What is pinned down: with three completed sessions in hmb.history — the
 * D1 limit — the gate still passes, dispatches no `hmb:signin` or
 * `hmb:paywall`, and the free-session beacon never touches fetch. The crisis
 * pages pass regardless. The premise (auth unconfigured, the count at the
 * limit, signed out, free tier) is asserted too, so the pass cannot be
 * explained by anything but the "sign-in does not exist yet" branch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------ browser stub */

const store = new Map();
const localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => {
    store.set(key, String(value));
  },
  removeItem: (key) => {
    store.delete(key);
  },
};

/** Every event js/entitlements.js dispatched on `document`, in order. */
const dispatched = [];
/** Every listener the modules registered on `document`, by event type. */
const documentListeners = new Map();
const noop = () => {};
const body = { dataset: {}, appendChild: noop };
const document = {
  readyState: 'loading', // js/consent.js waits for DOMContentLoaded, which never comes
  cookie: '',
  body,
  addEventListener: (type, fn) => {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(fn);
  },
  removeEventListener: noop,
  dispatchEvent: (event) => {
    dispatched.push({ type: event.type, detail: event.detail });
    return true;
  },
  getElementById: () => null,
};
const location = { pathname: '/timer', search: '', hash: '' };
const window = {
  localStorage,
  location,
  addEventListener: noop,
  removeEventListener: noop,
  setTimeout,
  clearTimeout,
  atob: (value) => atob(value),
  requestIdleCallback: (fn) => fn(),
};
Object.assign(globalThis, { window, document, localStorage, location });

/** Records every call; the beacon must never reach it while unconfigured. */
const fetchCalls = [];
globalThis.fetch = async (...args) => {
  fetchCalls.push(args);
  return { ok: true, status: 200, json: async () => ({ ok: true, free_sessions_used: 99 }) };
};

/** The exact record shape js/storage.js appendSession() writes. */
function completedSession(day, technique) {
  return { date: `2026-09-${day}T10:00:00.000Z`, technique, seconds: 600, breaths: 30, completed: true };
}
localStorage.setItem(
  'hmb.history',
  JSON.stringify([completedSession('10', '478'), completedSession('11', 'box'), completedSession('12', '478')]),
);

// The stubs must exist before the module graph evaluates.
const { TIMER_FREE_SESSIONS } = await import('../js/config.js');
const { completedSessionCount } = await import('../js/storage.js');
const { configured } = await import('../js/auth.js');
const ent = await import('../js/entitlements.js');

/* ------------------------------------------------------------------- tests */

test('premise: sign-in is not configured and the device is at the free-session limit', () => {
  assert.equal(configured(), false, 'js/config.js SUPABASE must be empty for these tests');
  assert.equal(TIMER_FREE_SESSIONS, 3, 'D1');
  assert.equal(completedSessionCount(), 3);
  assert.equal(ent.signedIn(), false);
  assert.equal(ent.isPro(), false);
  assert.equal(ent.getLicenseInfo().freeSessionsUsed, 3);
});

test('auth unconfigured + three completed local sessions: requireTimer() passes silently', () => {
  dispatched.length = 0;
  assert.equal(ent.requireTimer({ technique: '478' }), true);
  assert.equal(ent.requireTimer(), true, 'no context is fine too');
  assert.deepEqual(dispatched, [], 'no hmb:signin, no hmb:paywall');
});

test('auth unconfigured: a server count past the limit changes nothing', () => {
  dispatched.length = 0;
  localStorage.setItem('hmb.ent.snapshot', JSON.stringify({ at: Date.now(), user: null, free_sessions_used: 10 }));
  assert.equal(ent.restore(), 'free');
  assert.equal(ent.getLicenseInfo().freeSessionsUsed, 10, 'the snapshot count is what the gate would read');
  assert.equal(ent.requireTimer({ technique: 'box' }), true);
  assert.deepEqual(dispatched, []);
  localStorage.removeItem('hmb.ent.snapshot');
  ent.restore();
});

test('crisis page (data-open-timer) passes, with or without a value', () => {
  dispatched.length = 0;
  body.dataset.openTimer = 'true';
  assert.equal(ent.requireTimer({ technique: '478' }), true);
  body.dataset.openTimer = '';
  assert.equal(ent.requireTimer({ technique: '478' }), true);
  delete body.dataset.openTimer;
  assert.deepEqual(dispatched, []);
});

test('auth unconfigured: the hmb:session-complete listener does not beacon either', async () => {
  fetchCalls.length = 0;
  const listeners = documentListeners.get('hmb:session-complete') || [];
  assert.equal(listeners.length, 1, 'js/entitlements.js registers exactly one completion listener');
  listeners[0]({ detail: { completed: true, technique: '478', seconds: 600, breaths: 30 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls.length, 0, 'POST /api/session/count was never sent');
});

test('auth unconfigured: the free-session beacon stays off the network', async () => {
  fetchCalls.length = 0;
  assert.equal(await ent.recordFreeSession(), null);
  assert.equal(await ent.recordFreeSession(), null, 'a second call is just as quiet');
  assert.equal(fetchCalls.length, 0, 'POST /api/session/count was never sent');
  assert.equal(localStorage.getItem('hmb.ent.snapshot'), null, 'and nothing was written back');
});
