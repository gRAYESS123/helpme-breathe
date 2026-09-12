/**
 * tools/entitlement.test.mjs — entitlement core (design §6.5, §7.1, §7.2, §11.5, §3.4).
 *
 *   node --test tools/entitlement.test.mjs
 *
 * Zero dependencies, no network. Every handler runs through its `create*Handler`
 * factory with stubbed dependencies. Fixtures are obviously fake (TESTFIXTURE).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bytesToHex, kidFor, signToken, verifyToken } from '../api/_lib/crypto.js';
import {
  ACTIVE_LAG_MS,
  PAST_DUE_GRACE_MS,
  TOKEN_ACCESS_SLACK_MS,
  TOKEN_MAX_AGE_MS,
  accessUntilFor,
  buildEntitlementPayload,
  clearEntitlementCookie,
  commercialFor,
  createStore,
  deviceCookie,
  entitlementCookie,
  entitlementFor,
  readCookie,
  signEntitlement,
  verifyEntitlementToken,
  winningRow,
} from '../api/_lib/entitlement.js';
import { createMeHandler } from '../api/me.js';
import { createExportHandler } from '../api/account/export.js';
import { MESSAGES, cancellationVerified, createDeleteHandler } from '../api/account/delete.js';
import { createRetentionHandler, retentionSteps } from '../api/cron/retention.js';

const SECRET = 'TESTFIXTURE-license-secret-not-real-'.padEnd(64, 'x');
const USER = '11111111-2222-4333-8444-555555555555';
const OTHER_USER = '99999999-8888-4777-8666-555555555555';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-11T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function setCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const raw = response.headers.get('set-cookie');
  return raw ? [raw] : [];
}

/** A plausible subscriptions row; override what the test cares about. */
function row(overrides = {}) {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    user_id: USER,
    provider: 'testfixture',
    provider_subscription_id: 'sub_TESTFIXTURE0001',
    provider_customer_id: 'ctm_TESTFIXTURE0001',
    plan: 'monthly',
    status: 'active',
    had_trial: false,
    ever_paid: true,
    trial_started_at: null,
    trial_ends_at: null,
    current_period_start: iso(NOW - 10 * DAY),
    current_period_end: iso(NOW + 20 * DAY),
    next_billed_at: iso(NOW + 20 * DAY),
    cancel_at: null,
    canceled_at: null,
    paused_at: null,
    resume_at: null,
    past_due_since: null,
    access_until: null,
    display_amount: '10.00',
    display_currency: 'USD',
    display_tax_inclusive: false,
    dispute_open: false,
    live: true,
    last_event_at: iso(NOW - DAY),
    created_at: iso(NOW - 40 * DAY),
    updated_at: iso(NOW - DAY),
    ...overrides,
  };
}

/** Write the row the way the webhook would: access_until from the §6.5 formula. */
function stored(overrides = {}, at = NOW) {
  const r = row(overrides);
  const access = accessUntilFor(r, at);
  return { ...r, access_until: access == null ? null : iso(access) };
}

/* ------------------------------------------------------------- crypto ----- */

test('crypto: bytesToHex is exported and verifyToken accepts v1 and v3 only', async () => {
  assert.equal(bytesToHex(new Uint8Array([0, 15, 255])), '000fff');
  const kid = await kidFor(SECRET);
  const iat = Math.floor(NOW / 1000);
  for (const v of [1, 3]) {
    const token = await signToken({ v, tier: 'pro', sub: 'x', iat, exp: iat + 60, kid }, SECRET);
    const result = await verifyToken(token, SECRET, { now: NOW });
    assert.equal(result.ok, true, `v${v} verifies`);
  }
  const v2 = await signToken({ v: 2, tier: 'pro', sub: 'x', iat, exp: iat + 60, kid }, SECRET);
  assert.equal((await verifyToken(v2, SECRET, { now: NOW })).reason, 'bad_version');
});

/* ------------------------------------------------ §6.5 column 2 ------------ */

test('§6.5 trialing: access_until = trial_ends_at', () => {
  const ends = NOW + 3 * DAY;
  assert.equal(accessUntilFor(row({ status: 'trialing', ever_paid: false, trial_ends_at: iso(ends) }), NOW), ends);
});

test('§6.5 active: access_until = current_period_end + 48h', () => {
  const end = NOW + 20 * DAY;
  assert.equal(accessUntilFor(row({ status: 'active', current_period_end: iso(end) }), NOW), end + ACTIVE_LAG_MS);
  assert.equal(ACTIVE_LAG_MS, 48 * HOUR);
});

test('§6.5 past_due AND ever_paid: least(past_due_since + 7d, coalesce(current_period_end, past_due_since) + 7d)', () => {
  const since = NOW - DAY;
  // Period end before the decline: the cap bites.
  const earlyEnd = NOW - 3 * DAY;
  assert.equal(
    accessUntilFor(row({ status: 'past_due', ever_paid: true, past_due_since: iso(since), current_period_end: iso(earlyEnd) }), NOW),
    earlyEnd + PAST_DUE_GRACE_MS,
  );
  // Period end after the decline: 7 days from the decline.
  assert.equal(
    accessUntilFor(row({ status: 'past_due', ever_paid: true, past_due_since: iso(since), current_period_end: iso(NOW + 20 * DAY) }), NOW),
    since + PAST_DUE_GRACE_MS,
  );
  // No period end at all: coalesce to past_due_since.
  assert.equal(
    accessUntilFor(row({ status: 'past_due', ever_paid: true, past_due_since: iso(since), current_period_end: null }), NOW),
    since + PAST_DUE_GRACE_MS,
  );
  assert.equal(PAST_DUE_GRACE_MS, 7 * DAY);
});

test('§6.5 past_due AND NOT ever_paid: coalesce(trial_ends_at, now()) — no grace, ever', () => {
  const trialEnd = NOW - HOUR;
  const r = row({
    status: 'past_due', ever_paid: false, had_trial: true, trial_ends_at: iso(trialEnd),
    past_due_since: iso(NOW), current_period_end: null,
  });
  assert.equal(accessUntilFor(r, NOW), trialEnd, 'access ends at trial end');
  assert.notEqual(accessUntilFor(r, NOW), NOW + PAST_DUE_GRACE_MS, 'never 7 days later');
  // A declined trial with no trial_ends_at recorded: now(), not later.
  assert.equal(accessUntilFor(row({ status: 'past_due', ever_paid: false, trial_ends_at: null }), NOW), NOW);
});

test('§6.5 paused: coalesce(current_period_end, now()) — keeps the days already paid for', () => {
  const end = NOW + 12 * DAY;
  assert.equal(accessUntilFor(row({ status: 'paused', paused_at: iso(NOW), current_period_end: iso(end) }), NOW), end);
  assert.equal(accessUntilFor(row({ status: 'paused', paused_at: iso(NOW), current_period_end: null }), NOW), NOW);
});

test('§6.5 canceled: coalesce(cancel_at, canceled_at)', () => {
  const cancelAt = NOW + 5 * DAY;
  assert.equal(accessUntilFor(row({ status: 'canceled', cancel_at: iso(cancelAt), canceled_at: iso(NOW) }), NOW), cancelAt);
  assert.equal(accessUntilFor(row({ status: 'canceled', cancel_at: null, canceled_at: iso(NOW - DAY) }), NOW), NOW - DAY);
});

test('§6.5 expired: unchanged; unknown status: nothing', () => {
  const past = NOW - 30 * DAY;
  assert.equal(accessUntilFor(row({ status: 'expired', access_until: iso(past) }), NOW), past);
  assert.equal(accessUntilFor(row({ status: 'something_else' }), NOW), null);
  assert.equal(accessUntilFor(null, NOW), null);
});

/* ------------------------------------------ §6.5 columns 3 and 4 ----------- */

test('§6.5 entitlementFor trialing: pro until trial end, then free', () => {
  const r = stored({ status: 'trialing', ever_paid: false, had_trial: true, trial_ends_at: iso(NOW + 2 * DAY), display_amount: null, display_currency: null });
  const before = entitlementFor([r], NOW);
  assert.equal(before.tier, 'pro');
  assert.equal(before.status, 'trialing');
  assert.equal(before.ui, 'trial_ends');
  assert.equal(before.next_charge.at, iso(NOW + 2 * DAY));
  assert.equal(before.next_charge.amount, null, 'null before the first confirmed transaction');
  const after = entitlementFor([r], NOW + 2 * DAY + 1);
  assert.equal(after.tier, 'free');
  assert.equal(after.status, 'trialing');
});

test('§6.5 entitlementFor active: pro through period end + 48h, next_charge from display_*', () => {
  const r = stored({ status: 'active', display_amount: '11.90', display_currency: 'EUR', display_tax_inclusive: true });
  const e = entitlementFor([r], NOW);
  assert.equal(e.tier, 'pro');
  assert.equal(e.ui, 'active_renews');
  assert.deepEqual(e.next_charge, { amount: '11.90', currency: 'EUR', tax_inclusive: true, at: iso(NOW + 20 * DAY) });
  assert.equal(entitlementFor([r], NOW + 20 * DAY + ACTIVE_LAG_MS - 1).tier, 'pro');
  assert.equal(entitlementFor([r], NOW + 20 * DAY + ACTIVE_LAG_MS).tier, 'free');
});

test('§6.5 entitlementFor past_due and ever_paid: pro for the grace, banner key', () => {
  const r = stored({ status: 'past_due', ever_paid: true, past_due_since: iso(NOW - DAY), current_period_end: iso(NOW + 20 * DAY) });
  const e = entitlementFor([r], NOW);
  assert.equal(e.tier, 'pro');
  assert.equal(e.status, 'past_due');
  assert.equal(e.ui, 'past_due_grace');
  const afterGrace = entitlementFor([r], NOW + 6 * DAY);
  assert.equal(afterGrace.tier, 'free', 'grace ends 7 days after the decline');
  assert.equal(afterGrace.status, 'past_due');
  assert.equal(afterGrace.ui, 'lapsed', 'the "access pauses on {date}" banner is not shown after that date');
});

test('§6.5 entitlementFor past_due and not ever_paid: free the moment the trial ends', () => {
  const r = stored({ status: 'past_due', ever_paid: false, had_trial: true, trial_ends_at: iso(NOW - HOUR), past_due_since: iso(NOW - HOUR), current_period_end: null });
  const e = entitlementFor([r], NOW);
  assert.equal(e.tier, 'free');
  assert.equal(e.status, 'past_due');
  assert.equal(e.ui, 'past_due_declined_at_trial');
  assert.equal(entitlementFor([r], NOW - 2 * HOUR).tier, 'pro', 'still pro inside the trial');
});

test('§6.5 entitlementFor paused: pro to the end of the period already paid for', () => {
  const r = stored({ status: 'paused', paused_at: iso(NOW), resume_at: iso(NOW + 30 * DAY), current_period_end: iso(NOW + 12 * DAY) });
  const e = entitlementFor([r], NOW + 1);
  assert.equal(e.tier, 'pro', 'a courtesy pause does not revoke access the same second');
  assert.equal(e.ui, 'paused_resumes');
  assert.equal(e.next_charge.at, iso(NOW + 30 * DAY));
  assert.equal(entitlementFor([r], NOW + 12 * DAY).tier, 'free');
});

test('§6.5 entitlementFor canceled: pro until the date, then free with status still canceled', () => {
  const r = stored({ status: 'canceled', cancel_at: iso(NOW + 5 * DAY), canceled_at: iso(NOW) });
  assert.equal(entitlementFor([r], NOW).tier, 'pro');
  assert.equal(entitlementFor([r], NOW).ui, 'canceled_until');
  assert.equal(entitlementFor([r], NOW).cancel_at, iso(NOW + 5 * DAY));
  const later = entitlementFor([r], NOW + 5 * DAY);
  assert.equal(later.tier, 'free');
  assert.equal(later.status, 'canceled');
  assert.equal(later.ui, 'canceled');
});

test('§6.5 entitlementFor expired and no row: free', () => {
  const e = entitlementFor([stored({ status: 'expired', access_until: iso(NOW - 30 * DAY) })], NOW);
  assert.equal(e.tier, 'free');
  assert.equal(e.status, 'expired');
  assert.equal(e.ui, 'no_active_subscription');
  for (const rows of [[], null, undefined]) {
    const none = entitlementFor(rows, NOW);
    assert.equal(none.tier, 'free');
    assert.equal(none.status, 'none');
    assert.equal(none.plan, null);
    assert.equal(none.next_charge, null);
    assert.equal(none.access_until, null);
    assert.equal(none.ui, 'no_subscription');
  }
});

test('entitlementFor: maximum access_until across rows wins, with that row\'s status', () => {
  const old = stored({ id: 'aaaaaaaa-0000-4000-8000-000000000002', status: 'canceled', cancel_at: iso(NOW - 40 * DAY), canceled_at: iso(NOW - 60 * DAY), plan: 'monthly' });
  const fresh = stored({ status: 'active', plan: 'yearly', current_period_end: iso(NOW + 300 * DAY) });
  const e = entitlementFor([old, fresh], NOW);
  assert.equal(e.status, 'active');
  assert.equal(e.plan, 'yearly');
  assert.equal(winningRow([old, fresh]), fresh);
  assert.equal(winningRow([fresh, old]), fresh);
  // A row that has no access_until yet never beats one that has.
  const unwritten = row({ id: 'aaaaaaaa-0000-4000-8000-000000000003', access_until: null, status: 'trialing' });
  assert.equal(winningRow([unwritten, old]), old);
  assert.equal(entitlementFor([unwritten], NOW).tier, 'free', 'a missing access_until grants nothing');
});

test('commercial claim: D2=one makes every pro entitlement commercial; D2=two only the practitioner plan', () => {
  assert.equal(commercialFor('monthly'), true);
  assert.equal(commercialFor('yearly', { practitionerPlanOffered: false }), true);
  assert.equal(commercialFor('monthly', { practitionerPlanOffered: true }), false);
  assert.equal(commercialFor('practitioner_yearly', { practitionerPlanOffered: true }), true);
  assert.equal(commercialFor(null), false);
  const lapsed = stored({ status: 'canceled', cancel_at: iso(NOW - DAY), canceled_at: iso(NOW - DAY) });
  assert.equal(entitlementFor([lapsed], NOW).commercial, false, 'no commercial rights without access');
});

/* ------------------------------------------------------------ token v3 ----- */

test('token v3: shape and exp = min(iat + 14d, access_until + 24h)', async () => {
  const kid = await kidFor(SECRET);
  const iat = Math.floor(NOW / 1000);
  const soon = NOW + 3 * DAY;
  const capped = buildEntitlementPayload({ sub: USER, tier: 'pro', status: 'canceled', plan: 'monthly', commercial: true, accessUntilMs: soon, periodEndMs: soon, kid, now: NOW });
  assert.equal(capped.v, 3);
  assert.equal(capped.typ, 'ent');
  assert.equal(capped.sub, USER);
  assert.equal(capped.st, 'canceled');
  assert.equal(capped.com, 1);
  assert.equal(capped.pe, Math.floor(soon / 1000));
  assert.equal(capped.iat, iat);
  assert.equal(capped.exp, Math.floor((soon + TOKEN_ACCESS_SLACK_MS) / 1000), 'capped at access_until + 24h');

  const far = buildEntitlementPayload({ sub: USER, tier: 'pro', status: 'active', plan: 'yearly', accessUntilMs: NOW + 300 * DAY, kid, now: NOW });
  assert.equal(far.exp, iat + TOKEN_MAX_AGE_MS / 1000, 'flat 14 days for a long subscription');

  const free = buildEntitlementPayload({ sub: USER, tier: 'free', status: 'none', kid, now: NOW });
  assert.equal(free.tier, 'free');
  assert.equal(free.com, 0);
  assert.equal(free.pe, 0);
  assert.equal(free.plan, null);
  assert.equal(free.exp, iat + TOKEN_MAX_AGE_MS / 1000);
});

test('token v3: signs, verifies, and has NO grace past exp', async () => {
  const entitlement = entitlementFor([stored({ status: 'canceled', cancel_at: iso(NOW + 3 * DAY), canceled_at: iso(NOW) })], NOW);
  const { token, payload } = await signEntitlement({ sub: USER, entitlement, secret: SECRET, now: NOW });
  assert.equal(payload.tier, 'pro');
  assert.equal((await verifyEntitlementToken(token, SECRET, { now: NOW })).ok, true);
  assert.equal((await verifyEntitlementToken(token, SECRET, { now: payload.exp * 1000 - 1 })).ok, true);
  const atExp = await verifyEntitlementToken(token, SECRET, { now: payload.exp * 1000 });
  assert.equal(atExp.ok, false);
  assert.equal(atExp.reason, 'expired');
  const dayLater = await verifyEntitlementToken(token, SECRET, { now: payload.exp * 1000 + DAY });
  assert.equal(dayLater.ok, false, 'a cancelled subscriber does not get 28 offline days');
  // Wrong typ is refused even with a good signature.
  const kid = await kidFor(SECRET);
  const emb = await signToken({ v: 3, typ: 'emb', sub: USER, iat: payload.iat, exp: payload.exp, kid }, SECRET);
  assert.equal((await verifyEntitlementToken(emb, SECRET, { now: NOW })).reason, 'bad_type');
  assert.equal((await verifyEntitlementToken(emb, SECRET, { now: NOW, typ: 'emb' })).ok, true);
});

test('cookies: exact attribute sets', () => {
  assert.equal(entitlementCookie('abc.def'), '__Host-hmb_ent=abc.def; Path=/; Secure; SameSite=Lax; Max-Age=1209600');
  assert.equal(clearEntitlementCookie(), '__Host-hmb_ent=; Path=/; Secure; SameSite=Lax; Max-Age=0');
  assert.equal(deviceCookie('u.m'), '__Host-hmb_did=u.m; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=63072000');
  assert.ok(!entitlementCookie('x').includes('HttpOnly'), 'the entitlement cookie must be script-readable (§7.1)');
  const req = new Request('https://helpmebreath.com/api/me', { headers: { cookie: 'a=1; __Host-hmb_ent=tok.sig; b=2' } });
  assert.equal(readCookie(req, '__Host-hmb_ent'), 'tok.sig');
  assert.equal(readCookie(req, 'missing'), '');
});

/* ----------------------------------------------------------- GET /api/me --- */

function meDeps(overrides = {}) {
  const rows = overrides.rows === undefined ? [stored({ status: 'trialing', ever_paid: false, had_trial: true, trial_ends_at: iso(NOW + 3 * DAY), display_amount: null, display_currency: null })] : overrides.rows;
  return {
    verifyAccessToken: async (jwt) => (jwt === 'good-jwt' ? { ok: true, sub: USER, email: 'person@example.com' } : { ok: false, reason: 'bad' }),
    store: {
      subscriptionsFor: async (id) => {
        assert.equal(id, USER, 'queries use the JWT sub');
        if (overrides.dbError) throw new Error('supabase timeout');
        return rows;
      },
      profileFor: async () => ({ id: USER, email: 'person@example.com', created_at: iso(NOW - 5 * DAY) }),
    },
    resolveDevice: async (request, options) => ({ cookieValue: 'TESTFIXTURE-uuid.TESTFIXTURE-mac', freeSessionsUsed: 3, mirror: options.mirror }),
    secret: SECRET,
    trialEnabled: true,
    now: () => NOW,
    limiter: { check: () => ({ ok: true }) },
    ...overrides.deps,
  };
}

const meRequest = (headers = {}) =>
  new Request('https://helpmebreath.com/api/me', { headers: { authorization: 'Bearer good-jwt', ...headers } });

test('/api/me: 401 without a valid JWT', async () => {
  const { GET } = createMeHandler(meDeps());
  const missing = await GET(new Request('https://helpmebreath.com/api/me'));
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { ok: false, reason: 'unauthenticated' });
  const bad = await GET(meRequest({ authorization: 'Bearer nope' }));
  assert.equal(bad.status, 401);
  assert.equal(setCookies(bad).length, 0);
});

test('/api/me: 200 with both Set-Cookie headers, §7.1 shape, next_charge from the row', async () => {
  const deps = meDeps({ rows: [stored({ status: 'active', display_amount: '9.99', display_currency: 'GBP', display_tax_inclusive: true })] });
  const { GET } = createMeHandler(deps);
  const response = await GET(meRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, max-age=0');
  const cookies = setCookies(response);
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], /^__Host-hmb_ent=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; Secure; SameSite=Lax; Max-Age=1209600$/);
  assert.equal(cookies[1], '__Host-hmb_did=TESTFIXTURE-uuid.TESTFIXTURE-mac; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=63072000');

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.user, { id: USER, email: 'person@example.com', created_at: iso(NOW - 5 * DAY) });
  assert.equal(body.entitlement.tier, 'pro');
  assert.equal(body.entitlement.status, 'active');
  assert.equal(body.entitlement.plan, 'monthly');
  assert.equal(body.entitlement.commercial, true);
  assert.equal(body.entitlement.provider, 'testfixture');
  assert.deepEqual(body.entitlement.next_charge, { amount: '9.99', currency: 'GBP', tax_inclusive: true, at: iso(NOW + 20 * DAY) });
  assert.ok(!('row' in body.entitlement), 'no internal row leaks');
  assert.deepEqual(body.trial, { available: false, reason: 'already_subscribed' });
  assert.equal(body.free_sessions_used, 3);
  assert.equal(body.device_id, 'TESTFIXTURE-uuid.TESTFIXTURE-mac');
  assert.equal(typeof body.token, 'string');
  const verified = await verifyEntitlementToken(body.token, SECRET, { now: NOW });
  assert.equal(verified.ok, true);
  assert.equal(verified.payload.sub, USER);
  assert.equal(verified.payload.st, 'active');
  assert.equal(body.token_exp, verified.payload.exp);
  assert.ok(cookies[0].includes(body.token), 'the cookie carries the same token as the body');
});

test('/api/me: trialing user gets in_trial; amount is null before the first transaction', async () => {
  const { GET } = createMeHandler(meDeps());
  const body = await (await GET(meRequest())).json();
  assert.equal(body.entitlement.status, 'trialing');
  assert.deepEqual(body.trial, { available: false, reason: 'in_trial' });
  assert.equal(body.entitlement.next_charge.amount, null);
  assert.equal(body.entitlement.next_charge.at, iso(NOW + 3 * DAY));
});

test('/api/me: signed-in user with no subscription gets 200, tier free, a free token, trial unchecked', async () => {
  const { GET } = createMeHandler(meDeps({ rows: [] }));
  const response = await GET(meRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.entitlement.tier, 'free');
  assert.equal(body.entitlement.status, 'none');
  assert.equal(body.entitlement.next_charge, null);
  assert.deepEqual(body.trial, { available: true, reason: 'unchecked' });
  const verified = await verifyEntitlementToken(body.token, SECRET, { now: NOW });
  assert.equal(verified.payload.tier, 'free');
  assert.equal(setCookies(response).length, 2);
});

test('/api/me: TRIAL_ENABLED=false answers trial_disabled', async () => {
  const { GET } = createMeHandler(meDeps({ rows: [], deps: { trialEnabled: false } }));
  const body = await (await GET(meRequest())).json();
  assert.deepEqual(body.trial, { available: false, reason: 'trial_disabled' });
});

test('/api/me: the device mirror is read from the header only, never the query string', async () => {
  let seenMirror = null;
  const deps = meDeps({ deps: { resolveDevice: async (request, options) => { seenMirror = options.mirror; return { cookieValue: 'TESTFIXTURE-uuid.TESTFIXTURE-mac', freeSessionsUsed: 0 }; } } });
  const { GET } = createMeHandler(deps);
  await GET(new Request('https://helpmebreath.com/api/me?device_mirror=TESTFIXTURE-from-query', { headers: { authorization: 'Bearer good-jwt' } }));
  assert.equal(seenMirror, '', 'a query-string mirror is ignored (it would land in request logs)');
  await GET(meRequest({ 'x-hmb-device-mirror': ' TESTFIXTURE-from-header ' }));
  assert.equal(seenMirror, 'TESTFIXTURE-from-header');
});

test('/api/me: an empty email claim falls through to the profile row', async () => {
  const { GET } = createMeHandler(meDeps({ deps: { verifyAccessToken: async () => ({ ok: true, sub: USER, email: '' }) } }));
  const body = await (await GET(meRequest())).json();
  assert.equal(body.user.email, 'person@example.com');
});

test('/api/me: device layer failure or absence never blocks the entitlement', async () => {
  const throwing = createMeHandler(meDeps({ deps: { resolveDevice: async () => { throw new Error('boom'); } } }));
  const r1 = await throwing.GET(meRequest());
  assert.equal(r1.status, 200);
  assert.equal(setCookies(r1).length, 1, 'only the entitlement cookie');
  assert.equal((await r1.json()).device_id, null);
  const absent = createMeHandler(meDeps({ deps: { resolveDevice: null } }));
  const r2 = await absent.GET(meRequest());
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).free_sessions_used, null);
});

test('/api/me: entitlement read failure fails OPEN to a valid cached cookie for the same user', async () => {
  const entitlement = entitlementFor([stored({ status: 'active' })], NOW);
  const { token } = await signEntitlement({ sub: USER, entitlement, secret: SECRET, now: NOW - DAY });
  const { GET } = createMeHandler(meDeps({ dbError: true }));
  const response = await GET(meRequest({ cookie: `__Host-hmb_ent=${token}` }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.stale, true);
  assert.equal(body.token, token);
  assert.equal(body.entitlement.tier, 'pro');
  assert.equal(body.entitlement.status, 'active');
  assert.equal(body.entitlement.ui, 'stale');
  assert.equal(body.entitlement.current_period_end, iso(NOW + 20 * DAY), 'pe is the period end for an active row');
  assert.equal(body.entitlement.trial_ends_at, null);
  assert.equal(body.entitlement.access_until, null, 'the token does not carry access_until, so none is invented');
  assert.equal(body.entitlement.next_charge, null);
  assert.ok(setCookies(response)[0].includes(token), 'the cached token is re-issued, not cleared');

  // Someone else's cookie is not honoured.
  const foreign = await signEntitlement({ sub: OTHER_USER, entitlement, secret: SECRET, now: NOW });
  const refused = await GET(meRequest({ cookie: `__Host-hmb_ent=${foreign.token}` }));
  assert.equal(refused.status, 503);
  assert.deepEqual(await refused.json(), { ok: false, reason: 'entitlement_unavailable' });

  // No cookie: 503, and the client keeps its localStorage copy.
  const none = await GET(meRequest());
  assert.equal(none.status, 503);
  assert.ok(!setCookies(none).some((c) => c.startsWith('__Host-hmb_ent=')), 'never clears the entitlement cookie on our outage');
});

test('/api/me: 429 when the limiter refuses', async () => {
  const { GET } = createMeHandler(meDeps({ deps: { limiter: { check: () => ({ ok: false, limit: 1, remaining: 0, resetAt: NOW + 1000, retryAfter: 1 }) } } }));
  assert.equal((await GET(meRequest())).status, 429);
});

/* ------------------------------------------------------------- signout ----- */

test('/api/account/signout clears exactly the entitlement cookie', async () => {
  const { POST, GET } = await import('../api/account/signout.js');
  const response = await POST(new Request('https://helpmebreath.com/api/account/signout', { method: 'POST' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(setCookies(response), ['__Host-hmb_ent=; Path=/; Secure; SameSite=Lax; Max-Age=0']);
  assert.ok(!setCookies(response).some((c) => c.includes('hmb_did')), 'the device anchor is never cleared');
  assert.equal((await GET(new Request('https://helpmebreath.com/api/account/signout'))).status, 405);
});

/* -------------------------------------------------------------- export ----- */

function accountStore(state) {
  return {
    subscriptionsFor: async (id) => state.subscriptions.filter((r) => r.user_id === id),
    profileFor: async (id) => (state.profile && state.profile.id === id ? state.profile : null),
    embedTokensFor: async (id) => state.embedTokens.filter((r) => r.user_id === id),
    embedCredentialsFor: async (ids) => state.credentials.filter((r) => ids.includes(r.token_id)),
    detachSubscriptions: async (id, nowIso) => {
      state.calls.push(['detach', id, nowIso]);
      const mine = state.subscriptions.filter((r) => r.user_id === id);
      for (const r of mine) {
        r.user_id = null;
        r.detached_at = nowIso;
      }
      return mine.map((r) => ({ id: r.id }));
    },
    unlinkTrialLedger: async (id) => {
      state.calls.push(['unlink', id]);
    },
  };
}

function accountState(overrides = {}) {
  return {
    calls: [],
    profile: { id: USER, email: 'person@example.com', created_at: iso(NOW - 5 * DAY), secret_column_that_should_not_leak: 'TESTFIXTURE' },
    subscriptions: [
      stored({ status: 'active' }),
      stored({ id: 'aaaaaaaa-0000-4000-8000-000000000009', user_id: OTHER_USER, provider_subscription_id: 'sub_TESTFIXTURE_OTHER' }),
    ],
    embedTokens: [{ id: 'e1', user_id: USER, token_id: 'et_TESTFIXTURE1', domains: ['clinic.example'], label: 'Clinic', created_at: iso(NOW) }],
    credentials: [{ jti: 'ec_TESTFIXTURE1', token_id: 'et_TESTFIXTURE1', issued_at: iso(NOW), expires_at: iso(NOW + 30 * DAY) }],
    ...overrides,
  };
}

const liveUser = async (jwt) => (jwt === 'good-jwt' ? { ok: true, sub: USER, email: 'person@example.com' } : { ok: false });

test('/api/account/export: attachment JSON with only this account\'s data', async () => {
  const state = accountState();
  const { GET } = createExportHandler({ assertLiveUser: liveUser, store: accountStore(state), now: () => NOW, limiter: { check: () => ({ ok: true }) } });
  const response = await GET(new Request('https://helpmebreath.com/api/account/export', { headers: { authorization: 'Bearer good-jwt' } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="helpmebreath-account-2026-09-11.json"');
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.account.id, USER);
  assert.equal(body.profile.email, 'person@example.com');
  assert.ok(!('secret_column_that_should_not_leak' in body.profile), 'profile fields are allowlisted');
  assert.equal(body.subscriptions.length, 1);
  assert.equal(body.subscriptions[0].provider_subscription_id, 'sub_TESTFIXTURE0001', 'provider ids included');
  assert.equal(body.embed_tokens.length, 1);
  assert.equal(body.embed_credentials.length, 1);
  assert.match(body.note, /merchant of record/);
  assert.ok(!JSON.stringify(body).includes('sub_TESTFIXTURE_OTHER'), 'no other user\'s data');
  const unauth = await GET(new Request('https://helpmebreath.com/api/account/export'));
  assert.equal(unauth.status, 401);
});

/* -------------------------------------------------------------- delete ----- */

function deleteHandler(state, providerImpl, extra = {}) {
  const provider = {
    id: 'testfixture',
    cancelSubscription: async (id, options, ctx) => {
      state.calls.push(['cancel', id, options.effectiveFrom]);
      return providerImpl(id, options, ctx);
    },
  };
  return createDeleteHandler({
    assertLiveUser: liveUser,
    store: accountStore(state),
    provider,
    providerCtx: { env: { MOR_API_KEY: 'TESTFIXTURE' } },
    deleteAuthUser: async (id) => {
      state.calls.push(['deleteAuthUser', id]);
    },
    now: () => NOW,
    limiter: { check: () => ({ ok: true }) },
    ...extra,
  });
}

const deleteRequest = () => new Request('https://helpmebreath.com/api/account/delete', { method: 'POST', headers: { authorization: 'Bearer good-jwt' } });

test('cancellationVerified accepts only a confirmed cancellation', () => {
  assert.equal(cancellationVerified({ ok: true }), true);
  assert.equal(cancellationVerified({ status: 'canceled' }), true);
  assert.equal(cancellationVerified({ status: 'active', scheduledChange: { action: 'cancel', effectiveAt: iso(NOW + DAY) } }), true);
  assert.equal(cancellationVerified({ ok: false, reason: 'provider_unavailable' }), false);
  assert.equal(cancellationVerified({ status: 'active' }), false);
  assert.equal(cancellationVerified(undefined), false);
  assert.equal(cancellationVerified(null), false);
});

test('/api/account/delete: refused while a dispute is open, nothing touched', async () => {
  const state = accountState({ subscriptions: [stored({ status: 'active', dispute_open: true })] });
  const { POST } = deleteHandler(state, async () => ({ ok: true }));
  const response = await POST(deleteRequest());
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.reason, 'dispute_open');
  assert.equal(body.message, MESSAGES.dispute_open);
  assert.deepEqual(state.calls, []);
});

test('/api/account/delete: refused while past_due, nothing touched', async () => {
  const state = accountState({ subscriptions: [stored({ status: 'past_due', ever_paid: true, past_due_since: iso(NOW - DAY) })] });
  const { POST } = deleteHandler(state, async () => ({ ok: true }));
  const response = await POST(deleteRequest());
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, 'past_due');
  assert.deepEqual(state.calls, []);
});

test('/api/account/delete: an unverified cancellation aborts before Supabase is touched', async () => {
  const notOk = accountState();
  const r1 = await deleteHandler(notOk, async () => ({ ok: false, reason: 'provider_unavailable' })).POST(deleteRequest());
  assert.equal(r1.status, 502);
  assert.equal((await r1.json()).reason, 'cancel_failed');
  assert.deepEqual(notOk.calls, [['cancel', 'sub_TESTFIXTURE0001', 'next_billing_period']]);
  assert.equal(notOk.subscriptions[0].user_id, USER, 'not detached');

  const throwing = accountState();
  const r2 = await deleteHandler(throwing, async () => { throw new Error('network'); }).POST(deleteRequest());
  assert.equal(r2.status, 502);
  assert.deepEqual(throwing.calls, [['cancel', 'sub_TESTFIXTURE0001', 'next_billing_period']]);
});

test('/api/account/delete: cancel-and-verify, detach (not cascade), delete auth user, unlink ledger — in that order', async () => {
  const state = accountState({
    subscriptions: [
      stored({ status: 'trialing', ever_paid: false, had_trial: true, trial_ends_at: iso(NOW + 2 * DAY) }),
      stored({ id: 'aaaaaaaa-0000-4000-8000-000000000004', provider_subscription_id: 'sub_TESTFIXTURE0004', status: 'canceled', cancel_at: iso(NOW - 40 * DAY), canceled_at: iso(NOW - 60 * DAY) }),
      stored({ id: 'aaaaaaaa-0000-4000-8000-000000000005', provider_subscription_id: 'sub_TESTFIXTURE0005', status: 'active', cancel_at: iso(NOW + 10 * DAY) }),
      stored({ id: 'aaaaaaaa-0000-4000-8000-000000000009', user_id: OTHER_USER, provider_subscription_id: 'sub_TESTFIXTURE_OTHER' }),
    ],
  });
  const { POST } = deleteHandler(state, async () => ({ status: 'active', scheduledChange: { action: 'cancel', effectiveAt: iso(NOW + 2 * DAY) } }));
  const response = await POST(deleteRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.deleted, true);
  assert.equal(body.subscriptions_cancelled, 1, 'only the live row without a scheduled cancel is cancelled');
  assert.equal(body.subscriptions_detached, 3);
  assert.match(body.message, /merchant of record/);
  assert.deepEqual(setCookies(response), ['__Host-hmb_ent=; Path=/; Secure; SameSite=Lax; Max-Age=0']);

  assert.deepEqual(state.calls, [
    ['cancel', 'sub_TESTFIXTURE0001', 'next_billing_period'],
    ['detach', USER, iso(NOW)],
    ['deleteAuthUser', USER],
    ['unlink', USER],
  ]);
  const mine = state.subscriptions.filter((r) => r.provider_subscription_id !== 'sub_TESTFIXTURE_OTHER');
  for (const r of mine) {
    assert.equal(r.user_id, null, 'detached');
    assert.equal(r.detached_at, iso(NOW));
    assert.ok(r.provider_subscription_id, 'provider ids kept');
  }
  const other = state.subscriptions.find((r) => r.provider_subscription_id === 'sub_TESTFIXTURE_OTHER');
  assert.equal(other.user_id, OTHER_USER, 'someone else\'s row untouched');
});

test('/api/account/delete: 401 without a live user; 405 on GET', async () => {
  const state = accountState();
  const handler = deleteHandler(state, async () => ({ ok: true }));
  const r = await handler.POST(new Request('https://helpmebreath.com/api/account/delete', { method: 'POST' }));
  assert.equal(r.status, 401);
  assert.deepEqual(state.calls, []);
  const { GET } = await import('../api/account/delete.js');
  assert.equal((await GET(new Request('https://helpmebreath.com/api/account/delete'))).status, 405);
});

/* ----------------------------------------------------------- retention ----- */

test('retention: nine steps, payload nulling restricted to processed rows', () => {
  const steps = retentionSteps(NOW);
  assert.equal(steps.length, 9);
  const nulling = steps[0];
  assert.equal(nulling.name, 'webhook_payloads_nulled');
  assert.equal(nulling.method, 'PATCH');
  assert.deepEqual(nulling.body, { payload: null });
  assert.match(nulling.path, /status=eq\.processed/, 'ONLY processed rows');
  assert.match(nulling.path, /payload=not\.is\.null/);
  assert.match(nulling.path, new RegExp(`received_at=lt\\.${encodeURIComponent(iso(NOW - 30 * DAY)).replace(/[.+]/g, '\\$&')}`));

  const deleting = steps[1];
  assert.equal(deleting.method, 'DELETE');
  assert.match(deleting.path, /status=eq\.processed/, 'failed and ignored rows are never deleted');

  assert.match(steps[2].path, /outcome=eq\.reserved&reserved_until=lt\./);
  assert.deepEqual(steps[2].body, { outcome: 'expired' });
  assert.match(steps[4].path, /status=neq\.expired&access_until=lt\./);
  assert.deepEqual(steps[4].body, { status: 'expired' });
  assert.match(steps[6].path, /^devices\?or=\(and\(trial_consumed_at\.not\.is\.null,trial_consumed_at\.lt\./);
  for (const step of steps) assert.ok(step.sql, `${step.name} keeps its SQL for the reader`);
});

test('retention handler: bearer-gated, runs every step, reports counts, 500 if any step fails', async () => {
  const seen = [];
  const db = async (path, options) => {
    assert.equal(options.prefer, 'return=representation');
    seen.push([options.method, path.split('?')[0]]);
    if (path.startsWith('rate_limits')) throw new Error('timeout');
    return [{ id: 1 }, { id: 2 }];
  };
  const { GET } = createRetentionHandler({ db, cronSecret: 'TESTFIXTURE-cron-secret', now: () => NOW });

  const unauth = await GET(new Request('https://helpmebreath.com/api/cron/retention'));
  assert.equal(unauth.status, 401);
  const wrong = await GET(new Request('https://helpmebreath.com/api/cron/retention', { headers: { authorization: 'Bearer nope' } }));
  assert.equal(wrong.status, 401);
  assert.equal(seen.length, 0, 'nothing runs without the secret');

  const response = await GET(new Request('https://helpmebreath.com/api/cron/retention', { headers: { authorization: 'Bearer TESTFIXTURE-cron-secret' } }));
  assert.equal(response.status, 500, 'one step failed');
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.results.webhook_payloads_nulled, 2);
  assert.equal(body.results.rate_limits_deleted, 'failed');
  assert.equal(body.results.embed_credentials_deleted, 2, 'later steps still ran');
  assert.equal(seen.length, 9);
  assert.deepEqual(seen[0], ['PATCH', 'webhook_events']);

  const healthy = createRetentionHandler({ db: async () => [], cronSecret: 'TESTFIXTURE-cron-secret', now: () => NOW });
  assert.equal((await healthy.GET(new Request('https://helpmebreath.com/api/cron/retention', { headers: { authorization: 'Bearer TESTFIXTURE-cron-secret' } }))).status, 200);
});

test('retention handler: an unset secret authorises nobody — not even the dev placeholder', async () => {
  let ran = 0;
  const db = async () => { ran += 1; return []; };
  for (const cronSecret of ['', undefined, null]) {
    const { GET } = createRetentionHandler({ db, cronSecret, now: () => NOW });
    for (const authorization of ['Bearer ', 'Bearer dev-missing-CRON_SECRET', 'Bearer undefined', 'Bearer null']) {
      const response = await GET(new Request('https://helpmebreath.com/api/cron/retention', { headers: { authorization } }));
      assert.equal(response.status, 401, `${JSON.stringify(cronSecret)} / ${authorization}`);
    }
  }
  assert.equal(ran, 0);
});

/* --------------------------------------------------------------- store ----- */

test('createStore: PostgREST paths are keyed on the uuid and refuse anything else', async () => {
  const seen = [];
  const db = async (path, options = {}) => {
    seen.push([options.method || 'GET', path, options.body || null, options.prefer || null]);
    return [];
  };
  const store = createStore(db);
  await store.subscriptionsFor(USER);
  await store.detachSubscriptions(USER, iso(NOW));
  await store.unlinkTrialLedger(USER);
  await store.embedCredentialsFor(['et_ok', 'bad;drop']);
  assert.equal(seen[0][1], `subscriptions?user_id=eq.${USER}&select=*&order=created_at.asc`);
  assert.equal(seen[1][0], 'PATCH');
  assert.deepEqual(seen[1][2], { user_id: null, detached_at: iso(NOW) });
  assert.equal(seen[1][3], 'return=representation');
  assert.equal(seen[2][1], `trial_claims?user_id=eq.${USER}`);
  assert.equal(seen[3][1], `devices?trial_user_id=eq.${USER}`);
  assert.equal(seen[4][1], 'embed_credentials?token_id=in.(et_ok)&select=*&order=issued_at.asc');
  await assert.rejects(() => store.subscriptionsFor('1 or 1=1'), TypeError);
  assert.throws(() => createStore(null), TypeError);
});
