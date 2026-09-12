/**
 * tools/trialguard.test.mjs — the trial lock's test suite.
 *
 *   node --test tools/trialguard.test.mjs
 *
 * Zero dependencies, no network, no Supabase, no merchant of record. The ledger
 * is an in-memory fake with the same interface `createLedger()` produces, the
 * provider is a stub, and `dblimit` is a stub, so every branch of §5.1–§5.4 in
 * docs/private/ACCOUNTS_BILLING_DESIGN.md runs offline.
 *
 * All secrets here are TESTFIXTURE placeholders and never valid anywhere.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVICE_COOKIE,
  FREE_SESSIONS_CAP,
  PLANS,
  REASONS,
  RESERVATION_MINUTES,
  SOFT,
  byteaLiteral,
  claimBlocks,
  createLedger,
  decide,
  deviceCookieHeader,
  emailHash,
  emailHashLiteral,
  foldDomain,
  ipBucket,
  mintDeviceId,
  normalizeEmail,
  parseCookies,
  planAvailable,
  priceIdFor,
  readDeviceCookie,
  resolveDevice,
  runEligibility,
  runSessionCount,
  signDeviceId,
  verifyDeviceValue,
} from '../api/_lib/trialguard.js';
import { createEligibilityHandler, trialEnabled, REQUIRED_ENV, TRIAL_ENV } from '../api/trial/eligibility.js';
import { createSessionCountHandler } from '../api/session/count.js';
import { authUnavailable, unauthorized } from '../api/_lib/authz.js';

// ------------------------------------------------------------- fixtures ----

const TRIAL_PEPPER = 'TESTFIXTURE-trial-pepper-'.padEnd(64, 'x');
const DEVICE_PEPPER = 'TESTFIXTURE-device-pepper-'.padEnd(64, 'y');
const OTHER_PEPPER = 'TESTFIXTURE-other-pepper-'.padEnd(64, 'z');

const ENV = Object.freeze({
  TRIAL_PEPPER,
  DEVICE_PEPPER,
  MOR_PRICE_MONTHLY_TRIAL: 'TESTFIXTURE_price_monthly_trial',
  MOR_PRICE_MONTHLY: 'TESTFIXTURE_price_monthly',
  MOR_PRICE_YEARLY_TRIAL: 'TESTFIXTURE_price_yearly_trial',
  MOR_PRICE_YEARLY: 'TESTFIXTURE_price_yearly',
});

const NOW = Date.parse('2026-09-11T12:00:00.000Z');
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

/** An in-memory ledger with the same interface createLedger() returns. */
function fakeLedger(seed = {}) {
  const state = {
    claims: new Map(Object.entries(seed.claims || {})),
    subscriptions: new Set(seed.subscriptions || []),
    devices: new Map(Object.entries(seed.devices || {})),
    intents: [],
    calls: [],
    failOn: new Set(seed.failOn || []),
  };
  const maybeFail = (name) => {
    state.calls.push(name);
    if (state.failOn.has(name) || state.failOn.has('*')) throw new Error(`TESTFIXTURE ledger failure in ${name}`);
  };
  const ledger = {
    state,
    async findClaim(hash) {
      maybeFail('findClaim');
      return state.claims.get(hash) || null;
    },
    async userHasSubscription(userId) {
      maybeFail('userHasSubscription');
      return state.subscriptions.has(userId);
    },
    async findDevice(id) {
      maybeFail('findDevice');
      return state.devices.get(id) ? { ...state.devices.get(id) } : null;
    },
    async insertDevice(row) {
      maybeFail('insertDevice');
      state.devices.set(row.device_id, { ...row });
      return { ...row };
    },
    async touchDevice(id, patch) {
      maybeFail('touchDevice');
      const row = state.devices.get(id);
      if (row) Object.assign(row, patch);
      return null;
    },
    async findLiveClaimForDevice(deviceId, nowIso) {
      maybeFail('findLiveClaimForDevice');
      for (const claim of state.claims.values()) {
        if (claim.device_id === deviceId && claim.outcome === 'reserved' && claim.reserved_until > nowIso) return { ...claim };
      }
      return null;
    },
    async reserveClaim(row) {
      maybeFail('reserveClaim');
      state.claims.set(row.email_hash, { ...state.claims.get(row.email_hash), ...row });
      return { ...row };
    },
    async findLiveIntent({ userId, plan, nowIso }) {
      maybeFail('findLiveIntent');
      const hits = state.intents
        .filter((i) => i.user_id === userId && i.plan === plan && i.trial_granted && !i.consumed_at && i.expires_at > nowIso && i.provider_transaction_id)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return hits[0] ? { ...hits[0] } : null;
    },
    async insertIntent(row) {
      maybeFail('insertIntent');
      state.intents.push({ ...row });
      return { ...row };
    },
    async updateIntent(id, patch) {
      maybeFail('updateIntent');
      const row = state.intents.find((i) => i.reservation_id === id);
      if (row) Object.assign(row, patch);
      return null;
    },
  };
  return ledger;
}

/** A merchant-of-record stub. Records every call; never names a real company. */
function fakeProvider(options = {}) {
  const calls = [];
  let txn = 0;
  return {
    id: 'TESTFIXTURE_mor',
    calls,
    async ensureCustomer(email) {
      calls.push(['ensureCustomer', email]);
      if (options.customerFails) throw new Error('TESTFIXTURE provider down');
      return { id: 'ctm_TESTFIXTURE', existed: options.customerExists === true };
    },
    async createCheckoutSession(args) {
      calls.push(['createCheckoutSession', args]);
      if (options.transactionFails) throw new Error('TESTFIXTURE transaction failed');
      txn += 1;
      return { transactionId: `txn_TESTFIXTURE_${txn}` };
    },
    async pricePreview({ priceId }) {
      calls.push(['pricePreview', priceId]);
      if (options.previewFails) throw new Error('TESTFIXTURE preview failed');
      return { amount: '10.00', currency: 'USD', taxInclusive: false, formatted: '$10.00' };
    },
  };
}

const allow = async () => true;

async function run(overrides = {}) {
  const ledger = overrides.ledger || fakeLedger();
  const provider = overrides.provider || fakeProvider();
  const alerts = [];
  const result = await runEligibility({
    sub: USER_A,
    email: 'Person@Example.com',
    plan: 'monthly',
    trialEnabled: true,
    env: ENV,
    ledger,
    dblimit: allow,
    provider,
    now: NOW,
    alert: (kind, detail) => alerts.push({ kind, detail }),
    ...overrides,
  });
  return { result, ledger, provider, alerts };
}

// ------------------------------------------------------ normalizeEmail -----

test('normalizeEmail trims, lowercases and IDNA-folds the domain', () => {
  assert.equal(normalizeEmail('  Person@Example.COM  '), 'person@example.com');
  assert.equal(normalizeEmail('Käthe@Bücher.example'), 'käthe@xn--bcher-kva.example');
  assert.equal(normalizeEmail('a@b.example.'), 'a@b.example');
  assert.equal(foldDomain('Bücher.Example'), 'xn--bcher-kva.example');
});

test('normalizeEmail strips dots and +tags for the gmail family only', () => {
  assert.equal(normalizeEmail('First.Last+promo@gmail.com'), 'firstlast@gmail.com');
  assert.equal(normalizeEmail('f.i.r.s.t@GoogleMail.com'), 'first@gmail.com');
  assert.equal(normalizeEmail('first.last+promo@example.com'), 'first.last+promo@example.com');
  assert.equal(normalizeEmail('first.last@notgmail.com'), 'first.last@notgmail.com');
});

test('normalizeEmail leaves non-addresses untouched apart from trim and case', () => {
  assert.equal(normalizeEmail('nonsense'), 'nonsense');
  assert.equal(normalizeEmail('@nope'), '@nope');
  assert.equal(normalizeEmail(null), '');
});

// ----------------------------------------------------------- emailHash -----

test('emailHash is deterministic across aliases and depends on the pepper', async () => {
  const a = await emailHash('First.Last+x@gmail.com', TRIAL_PEPPER);
  const b = await emailHash('firstlast@gmail.com', TRIAL_PEPPER);
  const c = await emailHash('firstlast@gmail.com', OTHER_PEPPER);
  assert.equal(a.length, 32);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.notDeepEqual(Array.from(a), Array.from(c));
  await assert.rejects(() => emailHash('x@example.com', ''), /TRIAL_PEPPER/);
});

test('emailHashLiteral is a Postgres hex bytea literal', async () => {
  const literal = await emailHashLiteral('x@example.com', TRIAL_PEPPER);
  assert.match(literal, /^\\x[0-9a-f]{64}$/);
  assert.equal(byteaLiteral(new Uint8Array([0, 255, 16])), '\\x00ff10');
});

// --------------------------------------------------------- device cookie ---

test('device cookie: sign, verify, tamper', async () => {
  const id = mintDeviceId();
  assert.match(id, /^[0-9a-f-]{36}$/);
  const value = await signDeviceId(id, DEVICE_PEPPER);
  assert.equal(value.length, 80);
  assert.deepEqual(await verifyDeviceValue(value, DEVICE_PEPPER), { ok: true, deviceId: id, reason: 'ok' });

  const flipped = value.slice(0, -1) + (value.endsWith('A') ? 'B' : 'A');
  assert.equal((await verifyDeviceValue(flipped, DEVICE_PEPPER)).reason, 'bad_mac');
  assert.equal((await verifyDeviceValue(value, OTHER_PEPPER)).reason, 'bad_mac');
  assert.equal((await verifyDeviceValue(id, DEVICE_PEPPER)).reason, 'malformed');
  assert.equal((await verifyDeviceValue(`${id}.short`, DEVICE_PEPPER)).reason, 'malformed');
  assert.equal((await verifyDeviceValue('', DEVICE_PEPPER)).reason, 'missing');
  assert.equal((await verifyDeviceValue(42, DEVICE_PEPPER)).reason, 'missing');
  await assert.rejects(() => signDeviceId('not-a-uuid', DEVICE_PEPPER), /uuid/);
});

test('device cookie header is the exact §5.1 shape', async () => {
  const value = await signDeviceId(mintDeviceId(), DEVICE_PEPPER);
  const header = deviceCookieHeader(value);
  assert.equal(header, `__Host-hmb_did=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=63072000`);
  assert.equal(DEVICE_COOKIE, '__Host-hmb_did');
});

test('parseCookies and readDeviceCookie', () => {
  const cookies = parseCookies('a=1; __Host-hmb_did=abc.def; b=2; a=dupe');
  assert.equal(cookies.get('a'), '1');
  assert.equal(cookies.get('__Host-hmb_did'), 'abc.def');
  assert.equal(parseCookies(null).size, 0);
  const request = new Request('https://helpmebreath.com/api/x', { headers: { cookie: '__Host-hmb_did=v.m' } });
  assert.equal(readDeviceCookie(request), 'v.m');
  assert.equal(readDeviceCookie(new Request('https://helpmebreath.com/api/x')), '');
});

test('ipBucket is /24 for IPv4 and /48 for IPv6, never the full address', () => {
  assert.equal(ipBucket('203.0.113.77'), '203.0.113.0/24');
  assert.equal(ipBucket('2001:db8:abcd:12::1'), '2001:0db8:abcd::/48');
  assert.equal(ipBucket('::1'), '0000:0000:0000::/48');
  assert.equal(ipBucket('unknown'), 'unknown');
  assert.equal(ipBucket('not an ip'), 'unknown');
  assert.equal(ipBucket(''), 'unknown');
});

// --------------------------------------------------------- resolveDevice ---

test('resolveDevice: verified cookie with a row is used and touched', async () => {
  const id = mintDeviceId();
  const value = await signDeviceId(id, DEVICE_PEPPER);
  const ledger = fakeLedger({ devices: { [id]: { device_id: id, seen_count: 3, free_sessions_used: 1, trial_count: 0 } } });
  const out = await resolveDevice({ cookie: value, pepper: DEVICE_PEPPER, ledger, now: NOW });
  assert.equal(out.deviceId, id);
  assert.equal(out.source, 'cookie');
  assert.equal(out.minted, false);
  assert.equal(out.forged, false);
  assert.equal(ledger.state.devices.get(id).seen_count, 4);
});

test('resolveDevice: verified cookie with no row inserts that id', async () => {
  const id = mintDeviceId();
  const value = await signDeviceId(id, DEVICE_PEPPER);
  const ledger = fakeLedger();
  const out = await resolveDevice({ cookie: value, pepper: DEVICE_PEPPER, ledger, now: NOW });
  assert.equal(out.deviceId, id);
  assert.ok(ledger.state.devices.has(id));
  assert.equal(ledger.state.devices.get(id).free_sessions_used, 0);
});

test('resolveDevice: no cookie and no mirror mints a fresh MAC-verifiable id', async () => {
  const ledger = fakeLedger();
  const out = await resolveDevice({ pepper: DEVICE_PEPPER, ledger, now: NOW });
  assert.equal(out.minted, true);
  assert.equal(out.source, 'minted');
  assert.equal((await verifyDeviceValue(out.value, DEVICE_PEPPER)).deviceId, out.deviceId);
  assert.ok(ledger.state.devices.has(out.deviceId));
});

test('resolveDevice: a verified mirror repairs a swept cookie', async () => {
  const id = mintDeviceId();
  const value = await signDeviceId(id, DEVICE_PEPPER);
  const ledger = fakeLedger({ devices: { [id]: { device_id: id, seen_count: 1, trial_count: 1, trial_consumed_at: '2026-09-01T00:00:00Z' } } });
  const out = await resolveDevice({ cookie: '', mirror: value, pepper: DEVICE_PEPPER, ledger, now: NOW });
  assert.equal(out.deviceId, id);
  assert.equal(out.source, 'mirror');
  assert.equal(out.forged, false);
});

test('resolveDevice: a forged mirror mints a NEW row and never resurrects the burned one', async () => {
  const burned = mintDeviceId();
  const ledger = fakeLedger({
    devices: { [burned]: { device_id: burned, seen_count: 9, trial_count: 1, trial_consumed_at: '2026-09-01T00:00:00Z' } },
  });
  // The attacker knows the burned uuid but not DEVICE_PEPPER, so the MAC is wrong.
  const forgedMirror = await signDeviceId(burned, OTHER_PEPPER);
  const out = await resolveDevice({ cookie: '', mirror: forgedMirror, pepper: DEVICE_PEPPER, ledger, now: NOW });
  assert.equal(out.forged, true);
  assert.equal(out.minted, true);
  assert.notEqual(out.deviceId, burned);
  assert.equal(ledger.state.devices.size, 2);
  assert.equal(ledger.state.devices.get(burned).seen_count, 9, 'the burned row was not touched');
  assert.equal(ledger.state.devices.get(burned).trial_consumed_at, '2026-09-01T00:00:00Z');
  assert.ok(!ledger.state.calls.includes('findDevice'), 'an unverified id is never even looked up');
});

test('resolveDevice: a bare uuid in the mirror (test 10) is forged, not honoured', async () => {
  const ledger = fakeLedger();
  const out = await resolveDevice({ cookie: '', mirror: mintDeviceId(), pepper: DEVICE_PEPPER, ledger, now: NOW });
  assert.equal(out.forged, true);
  assert.equal(out.minted, true);
});

test('resolveDevice: a malformed cookie is never resurrected; a verified mirror still wins', async () => {
  const id = mintDeviceId();
  const mirror = await signDeviceId(id, DEVICE_PEPPER);
  const ledger = fakeLedger({ devices: { [id]: { device_id: id, seen_count: 1, trial_count: 0 } } });
  const out = await resolveDevice({ cookie: 'garbage', mirror, pepper: DEVICE_PEPPER, ledger, now: NOW });
  assert.equal(out.deviceId, id);
  assert.equal(out.forged, false, 'a verified mirror is not a forgery even when the cookie is junk');
  const minted = await resolveDevice({ cookie: 'garbage', pepper: DEVICE_PEPPER, ledger, now: NOW });
  assert.equal(minted.minted, true);
});

test('resolveDevice: a consumed id is never discarded in favour of a newer one', async () => {
  const consumed = mintDeviceId();
  const fresh = mintDeviceId();
  const ledger = fakeLedger({
    devices: {
      [consumed]: { device_id: consumed, seen_count: 1, trial_count: 1, trial_consumed_at: '2026-09-01T00:00:00Z' },
      [fresh]: { device_id: fresh, seen_count: 1, trial_count: 0 },
    },
  });
  const out = await resolveDevice({
    cookie: await signDeviceId(fresh, DEVICE_PEPPER),
    mirror: await signDeviceId(consumed, DEVICE_PEPPER),
    pepper: DEVICE_PEPPER,
    ledger,
    now: NOW,
  });
  assert.equal(out.deviceId, consumed);
});

// ----------------------------------------------------------- claimBlocks ---

test('claimBlocks follows the §5.3 layer-1 reading of trial_claims', () => {
  const soon = new Date(NOW + 10 * 60 * 1000).toISOString();
  const past = new Date(NOW - 10 * 60 * 1000).toISOString();
  assert.equal(claimBlocks(null, USER_A, NOW), false);
  assert.equal(claimBlocks({ outcome: 'expired' }, USER_A, NOW), false);
  assert.equal(claimBlocks({ outcome: 'reserved', reserved_until: past, user_id: USER_B }, USER_A, NOW), false, 'stale reservation');
  assert.equal(claimBlocks({ outcome: 'reserved', reserved_until: soon, user_id: USER_A }, USER_A, NOW), false, 'own live reservation');
  assert.equal(claimBlocks({ outcome: 'reserved', reserved_until: soon, user_id: USER_B }, USER_A, NOW), true, 'someone else is mid-checkout');
  for (const outcome of ['started', 'converted', 'cancelled', 'refunded', 'chargeback']) {
    assert.equal(claimBlocks({ outcome }, USER_A, NOW), true, outcome);
  }
});

// ---------------------------------------------------------------- decide ---

test('decide: a clean first-timer gets the trial', () => {
  assert.deepEqual(decide({ trialEnabled: true, now: NOW, userId: USER_A }), { trial: true, reasons: [], soft: [] });
});

test('decide: hard signal 1 — email already claimed', () => {
  const out = decide({ trialEnabled: true, now: NOW, userId: USER_A, claim: { outcome: 'started' } });
  assert.equal(out.trial, false);
  assert.deepEqual(out.reasons, [REASONS.EMAIL_USED]);
});

test('decide: hard signal 2 — any subscription row, ever', () => {
  const out = decide({ trialEnabled: true, now: NOW, userId: USER_A, subscriptionExists: true });
  assert.equal(out.trial, false);
  assert.deepEqual(out.reasons, [REASONS.ALREADY_SUBSCRIBED]);
});

test('decide: hard signal 3 — trial_count >= 2 on the device', () => {
  const out = decide({ trialEnabled: true, now: NOW, userId: USER_A, device: { trial_count: 2, trial_consumed_at: '2026-09-01T00:00:00Z' } });
  assert.equal(out.trial, false);
  assert.deepEqual(out.reasons, [REASONS.DEVICE_USED]);
});

test('decide: a live reservation on the device for another email is hard', () => {
  const out = decide({ trialEnabled: true, now: NOW, userId: USER_A, deviceReservedByOther: true });
  assert.equal(out.trial, false);
  assert.deepEqual(out.reasons, [REASONS.DEVICE_USED]);
});

test('decide: one soft signal alone grants the trial and flags it', () => {
  const seen = decide({ trialEnabled: true, now: NOW, userId: USER_A, device: { trial_count: 1, trial_consumed_at: '2026-09-01T00:00:00Z' } });
  assert.equal(seen.trial, true);
  assert.deepEqual(seen.soft, [SOFT.DEVICE_SEEN]);
  const forged = decide({ trialEnabled: true, now: NOW, userId: USER_A, forged: true });
  assert.equal(forged.trial, true);
  assert.deepEqual(forged.soft, [SOFT.FORGED_DEVICE]);
  const customer = decide({ trialEnabled: true, now: NOW, userId: USER_A, customerExists: true });
  assert.equal(customer.trial, true);
  assert.deepEqual(customer.soft, [SOFT.CUSTOMER_EXISTS]);
});

test('decide: any two soft signals refuse the trial', () => {
  const a = decide({ trialEnabled: true, now: NOW, userId: USER_A, device: { trial_count: 1, trial_consumed_at: '2026-09-01T00:00:00Z' }, forged: true });
  assert.equal(a.trial, false);
  assert.deepEqual(a.reasons, [REASONS.DEVICE_USED]);
  assert.deepEqual(a.soft, [SOFT.DEVICE_SEEN, SOFT.FORGED_DEVICE]);
  const b = decide({ trialEnabled: true, now: NOW, userId: USER_A, forged: true, customerExists: true });
  assert.equal(b.trial, false);
  assert.deepEqual(b.reasons, [REASONS.DEVICE_USED, REASONS.EMAIL_USED]);
  const c = decide({ trialEnabled: true, now: NOW, userId: USER_A, device: { trial_count: 1, trial_consumed_at: '2026-09-01T00:00:00Z' }, customerExists: true });
  assert.equal(c.trial, false);
});

test('decide: hard signals win over soft ones and TRIAL_ENABLED=false short-circuits', () => {
  const out = decide({ trialEnabled: true, now: NOW, userId: USER_A, subscriptionExists: true, forged: true });
  assert.deepEqual(out.reasons, [REASONS.ALREADY_SUBSCRIBED]);
  assert.deepEqual(decide({ trialEnabled: false, claim: null }), { trial: false, reasons: [REASONS.TRIAL_DISABLED], soft: [] });
});

// ------------------------------------------------------------- priceIdFor --

test('priceIdFor chooses server-side from (plan, trial) and prefers the adapter', () => {
  assert.equal(priceIdFor({ plan: 'monthly', trial: true }, ENV), 'TESTFIXTURE_price_monthly_trial');
  assert.equal(priceIdFor({ plan: 'monthly', trial: false }, ENV), 'TESTFIXTURE_price_monthly');
  assert.equal(priceIdFor({ plan: 'yearly', trial: true }, ENV), 'TESTFIXTURE_price_yearly_trial');
  assert.equal(priceIdFor({ plan: 'yearly', trial: false }, ENV), 'TESTFIXTURE_price_yearly');
  assert.equal(priceIdFor({ plan: 'nope', trial: false }, ENV), '');
  const adapter = { priceIdFor: ({ plan, trial }) => `adapter_${plan}_${trial ? 'trial' : 'paid'}` };
  assert.equal(priceIdFor({ plan: 'monthly', trial: true }, ENV, adapter), 'adapter_monthly_trial');
  assert.equal(planAvailable('monthly', ENV), true);
  assert.equal(planAvailable('yearly', ENV), true);
  // Sellable means "known plan AND a paid price in env" — a known plan whose
  // price var is blank is not sellable on this deployment.
  assert.equal(planAvailable('yearly', { ...ENV, MOR_PRICE_YEARLY: '' }), false);
  // One plan, two billing periods. There is no third value to configure.
  assert.equal(planAvailable('retired_second_plan', ENV), false);
  assert.equal(planAvailable('retired_second_plan', { ...ENV, MOR_PRICE_RETIRED: 'TESTFIXTURE_retired' }), false);
  assert.deepEqual(PLANS, ['monthly', 'yearly']);
});

// --------------------------------------------------------- runEligibility --

test('eligibility: clean first-timer -> trial, reservation, intent, transaction, no price id', async () => {
  const { result, ledger, provider } = await run();
  assert.equal(result.status, 200);
  const body = result.body;
  assert.equal(body.ok, true);
  assert.equal(body.trial, true);
  assert.equal(body.plan, 'monthly');
  assert.deepEqual(body.reasons, []);
  assert.match(body.reservation_id, /^[0-9a-f-]{36}$/);
  assert.equal(body.checkout.provider, 'TESTFIXTURE_mor');
  assert.equal(body.checkout.transaction_id, 'txn_TESTFIXTURE_1');
  assert.equal(body.price_preview.formatted, '$10.00');
  assert.ok(!('price_id' in body), 'the response never carries a price id');
  assert.ok(!JSON.stringify(body).includes('TESTFIXTURE_price'), 'no price id anywhere in the body');
  assert.equal((await verifyDeviceValue(body.device_id, DEVICE_PEPPER)).ok, true);
  assert.equal(result.cookieValue, body.device_id);

  // The transaction was created with the TRIAL price and custom_data = { rid, v } only.
  const txnCall = provider.calls.find((c) => c[0] === 'createCheckoutSession')[1];
  assert.equal(txnCall.priceId, 'TESTFIXTURE_price_monthly_trial');
  assert.equal(txnCall.customerId, 'ctm_TESTFIXTURE');
  assert.deepEqual(Object.keys(txnCall.customData).sort(), ['rid', 'v']);
  assert.equal(txnCall.customData.rid, body.reservation_id);
  assert.equal(txnCall.customData.v, 3);

  // The intent is the authoritative record.
  assert.equal(ledger.state.intents.length, 1);
  const intent = ledger.state.intents[0];
  assert.equal(intent.reservation_id, body.reservation_id);
  assert.equal(intent.user_id, USER_A);
  assert.equal(intent.trial_granted, true);
  assert.equal(intent.price_id, 'TESTFIXTURE_price_monthly_trial');
  assert.equal(intent.provider_transaction_id, 'txn_TESTFIXTURE_1');
  assert.equal(intent.provider_customer_id, 'ctm_TESTFIXTURE');
  assert.match(intent.email_hash, /^\\x[0-9a-f]{64}$/);
  assert.equal(intent.expires_at, new Date(NOW + 30 * 60 * 1000).toISOString());
});

test('eligibility: the 30-minute reservation is written to trial_claims and devices', async () => {
  const { result, ledger } = await run();
  const hash = await emailHashLiteral('person@example.com', TRIAL_PEPPER);
  const claim = ledger.state.claims.get(hash);
  assert.ok(claim, 'a trial_claims row keyed on the peppered hash');
  assert.equal(claim.outcome, 'reserved');
  assert.equal(claim.reserved_until, new Date(NOW + RESERVATION_MINUTES * 60 * 1000).toISOString());
  assert.equal(RESERVATION_MINUTES, 30);
  assert.equal(claim.user_id, USER_A);
  assert.equal(claim.provider, 'TESTFIXTURE_mor');
  const device = ledger.state.devices.get((await verifyDeviceValue(result.body.device_id, DEVICE_PEPPER)).deviceId);
  assert.equal(device.trial_reserved_until, claim.reserved_until);
  assert.equal(device.trial_consumed_at, undefined, 'a reservation is not a consumption; the webhook burns it');
});

test('eligibility: an expired reservation is ignored and overwritten (abandoned checkout keeps the trial)', async () => {
  const hash = await emailHashLiteral('person@example.com', TRIAL_PEPPER);
  const stale = new Date(NOW - 60 * 60 * 1000).toISOString();
  const ledger = fakeLedger({ claims: { [hash]: { email_hash: hash, outcome: 'reserved', reserved_until: stale, user_id: USER_B } } });
  const { result } = await run({ ledger });
  assert.equal(result.body.trial, true);
  assert.equal(ledger.state.claims.get(hash).user_id, USER_A);
  assert.equal(ledger.state.claims.get(hash).reserved_until, new Date(NOW + 30 * 60 * 1000).toISOString());
});

test('eligibility: a live reservation by another user blocks (email_used)', async () => {
  const hash = await emailHashLiteral('person@example.com', TRIAL_PEPPER);
  const live = new Date(NOW + 5 * 60 * 1000).toISOString();
  const ledger = fakeLedger({ claims: { [hash]: { email_hash: hash, outcome: 'reserved', reserved_until: live, user_id: USER_B } } });
  const { result } = await run({ ledger });
  assert.equal(result.body.trial, false);
  assert.deepEqual(result.body.reasons, [REASONS.EMAIL_USED]);
});

test('eligibility: the same user retrying inside a live reservation gets the SAME transaction', async () => {
  const ledger = fakeLedger();
  const first = await run({ ledger });
  const second = await run({ ledger, now: NOW + 2 * 60 * 1000 });
  assert.equal(second.result.body.trial, true);
  assert.equal(second.result.body.reused, true);
  assert.equal(second.result.body.reservation_id, first.result.body.reservation_id);
  assert.equal(second.result.body.checkout.transaction_id, first.result.body.checkout.transaction_id);
  assert.equal(ledger.state.intents.length, 1, 'no second intent, no second trial');
});

test('eligibility: a live reservation on the same device for a DIFFERENT email blocks the parallel checkout', async () => {
  const ledger = fakeLedger();
  const first = await run({ ledger });
  const second = await run({ ledger, sub: USER_B, email: 'other@example.com', cookie: first.result.body.device_id });
  assert.equal(second.result.body.trial, false);
  assert.deepEqual(second.result.body.reasons, [REASONS.DEVICE_USED]);
});

test('eligibility: hard signal — email already used (started)', async () => {
  const hash = await emailHashLiteral('person@example.com', TRIAL_PEPPER);
  const ledger = fakeLedger({ claims: { [hash]: { email_hash: hash, outcome: 'started', user_id: USER_A } } });
  const { result, provider } = await run({ ledger });
  assert.equal(result.status, 200);
  assert.equal(result.body.trial, false);
  assert.deepEqual(result.body.reasons, [REASONS.EMAIL_USED]);
  const txn = provider.calls.find((c) => c[0] === 'createCheckoutSession')[1];
  assert.equal(txn.priceId, 'TESTFIXTURE_price_monthly', 'the no-trial price, chosen server-side');
  assert.equal(ledger.state.claims.get(hash).outcome, 'started', 'the consumed claim is untouched');
  assert.equal(ledger.state.intents[0].trial_granted, false);
});

test('eligibility: hard signal — gmail alias of a used address is the same address', async () => {
  const hash = await emailHashLiteral('firstlast@gmail.com', TRIAL_PEPPER);
  const ledger = fakeLedger({ claims: { [hash]: { email_hash: hash, outcome: 'converted' } } });
  const { result } = await run({ ledger, email: 'First.Last+again@googlemail.com' });
  assert.equal(result.body.trial, false);
  assert.deepEqual(result.body.reasons, [REASONS.EMAIL_USED]);
});

test('eligibility: hard signal — user has or had a subscription row', async () => {
  const ledger = fakeLedger({ subscriptions: [USER_A] });
  const { result } = await run({ ledger });
  assert.equal(result.body.trial, false);
  assert.deepEqual(result.body.reasons, [REASONS.ALREADY_SUBSCRIBED]);
});

test('eligibility: hard signal — device trial_count >= 2 (test 9, third account)', async () => {
  const id = mintDeviceId();
  const cookie = await signDeviceId(id, DEVICE_PEPPER);
  const ledger = fakeLedger({ devices: { [id]: { device_id: id, seen_count: 2, trial_count: 2, trial_consumed_at: '2026-09-01T00:00:00Z' } } });
  const { result } = await run({ ledger, cookie });
  assert.equal(result.body.trial, false);
  assert.deepEqual(result.body.reasons, [REASONS.DEVICE_USED]);
  assert.equal(result.body.device_id, cookie, 'the burned cookie is kept, not replaced');
});

test('eligibility: soft signal — device seen once grants with a flag (test 9, second account)', async () => {
  const id = mintDeviceId();
  const cookie = await signDeviceId(id, DEVICE_PEPPER);
  const ledger = fakeLedger({ devices: { [id]: { device_id: id, seen_count: 2, trial_count: 1, trial_consumed_at: '2026-09-01T00:00:00Z' } } });
  const { result } = await run({ ledger, cookie });
  assert.equal(result.body.trial, true);
  assert.deepEqual(result.body.reasons, []);
  assert.deepEqual(ledger.state.intents[0].reasons, ['soft:device_seen'], 'the intent row is flagged');
});

test('eligibility: two soft signals — forged mirror on a seen device -> no trial', async () => {
  const seen = mintDeviceId();
  const ledger = fakeLedger({ devices: { [seen]: { device_id: seen, seen_count: 1, trial_count: 1, trial_consumed_at: '2026-09-01T00:00:00Z' } } });
  // Layer 4 needs the seen device to be the verified one; layer 5 needs a mirror
  // whose MAC fails. A verified cookie with a forged mirror is NOT flagged
  // (cookie wins), so simulate the two soft signals via layer 6 + layer 5:
  const forgedMirror = await signDeviceId(seen, OTHER_PEPPER);
  const { result } = await run({ ledger, mirror: forgedMirror, provider: fakeProvider({ customerExists: true }) });
  assert.equal(result.body.trial, false);
  assert.deepEqual(result.body.reasons, [REASONS.DEVICE_USED, REASONS.EMAIL_USED]);
  assert.ok(ledger.state.intents[0].reasons.includes('soft:forged_device'));
  assert.ok(ledger.state.intents[0].reasons.includes('soft:customer_exists'));
  assert.equal(ledger.state.devices.get(seen).trial_consumed_at, '2026-09-01T00:00:00Z', 'burned row untouched');
});

test('eligibility: two soft signals — seen device + provider customer exists -> no trial', async () => {
  const id = mintDeviceId();
  const cookie = await signDeviceId(id, DEVICE_PEPPER);
  const ledger = fakeLedger({ devices: { [id]: { device_id: id, seen_count: 1, trial_count: 1, trial_consumed_at: '2026-09-01T00:00:00Z' } } });
  const { result } = await run({ ledger, cookie, provider: fakeProvider({ customerExists: true }) });
  assert.equal(result.body.trial, false);
  assert.deepEqual(result.body.reasons, [REASONS.DEVICE_USED, REASONS.EMAIL_USED]);
});

test('eligibility: forged mirror alone is one soft signal — trial granted, new device minted, burned row untouched', async () => {
  const burned = mintDeviceId();
  const ledger = fakeLedger({ devices: { [burned]: { device_id: burned, seen_count: 4, trial_count: 1, trial_consumed_at: '2026-09-01T00:00:00Z' } } });
  const { result } = await run({ ledger, mirror: `${burned}.${'A'.repeat(43)}` });
  assert.equal(result.body.trial, true);
  const newId = (await verifyDeviceValue(result.body.device_id, DEVICE_PEPPER)).deviceId;
  assert.notEqual(newId, burned);
  assert.equal(ledger.state.devices.get(burned).seen_count, 4);
  assert.equal(ledger.state.devices.get(burned).trial_reserved_until, undefined, 'the reservation landed on the new row');
  assert.ok(ledger.state.devices.get(newId).trial_reserved_until);
  assert.deepEqual(ledger.state.intents[0].reasons, ['soft:forged_device']);
});

test('eligibility: provider customer lookup failure drops layer 6 and continues', async () => {
  const provider = fakeProvider({ customerFails: true });
  const { result } = await run({ provider });
  assert.equal(result.status, 200);
  assert.equal(result.body.trial, true);
  const txn = provider.calls.find((c) => c[0] === 'createCheckoutSession')[1];
  assert.equal(txn.customerId, null);
});

test('eligibility: FORCED LEDGER ERROR fails closed — trial:false, not trial:true', async () => {
  // A verified cookie so that findDevice is actually on the path.
  const cookie = await signDeviceId(mintDeviceId(), DEVICE_PEPPER);
  for (const failing of ['findClaim', 'userHasSubscription', 'findDevice', 'insertDevice', 'findLiveClaimForDevice', 'reserveClaim', 'touchDevice']) {
    const ledger = fakeLedger({ failOn: [failing] });
    const { result, alerts, provider } = await run({ ledger, cookie });
    assert.ok(ledger.state.calls.includes(failing), `${failing}: the failing call was on the path`);
    assert.equal(result.status, 200, `${failing}: still a usable answer`);
    assert.equal(result.body.ok, true, failing);
    assert.equal(result.body.trial, false, `${failing}: never trial:true on a ledger failure`);
    assert.deepEqual(result.body.reasons, [REASONS.LEDGER_UNAVAILABLE], failing);
    assert.equal(alerts.length, 1, `${failing}: alerted`);
    assert.equal(alerts[0].kind, 'ledger_unavailable');
    assert.ok(!JSON.stringify(alerts).includes('example.com'), 'the alert never carries the email');
    const txn = provider.calls.find((c) => c[0] === 'createCheckoutSession');
    assert.ok(txn, `${failing}: the no-trial checkout is still created`);
    assert.equal(txn[1].priceId, 'TESTFIXTURE_price_monthly', `${failing}: full price`);
    assert.equal(ledger.state.intents.length, 0, `${failing}: no intent written during an outage`);
    assert.match(result.body.reservation_id, /^[0-9a-f-]{36}$/, 'a reservation id still rides in custom_data');
  }
});

test('eligibility: rate limiter failure (Postgres down) is a ledger failure, fails closed', async () => {
  const { result } = await run({ dblimit: async () => { throw new Error('TESTFIXTURE rate limit rpc down'); } });
  assert.equal(result.body.trial, false);
  assert.deepEqual(result.body.reasons, [REASONS.LEDGER_UNAVAILABLE]);
});

test('eligibility: intent insert failure after a grant downgrades to no trial', async () => {
  const ledger = fakeLedger({ failOn: ['insertIntent'] });
  const { result, alerts, provider } = await run({ ledger });
  assert.equal(result.body.trial, false);
  assert.ok(result.body.reasons.includes(REASONS.LEDGER_UNAVAILABLE));
  assert.equal(alerts[0].kind, 'intent_insert_failed');
  const txn = provider.calls.find((c) => c[0] === 'createCheckoutSession')[1];
  assert.equal(txn.priceId, 'TESTFIXTURE_price_monthly');
});

test('eligibility: rate limit exceeded -> trial:false, HTTP 200, checkout still works', async () => {
  const buckets = [];
  const dblimit = async (bucket) => {
    buckets.push(bucket);
    return !bucket.startsWith('trial:ip:');
  };
  const { result, ledger } = await run({ dblimit, ip: '203.0.113.9' });
  assert.equal(result.status, 200);
  assert.equal(result.body.trial, false);
  assert.deepEqual(result.body.reasons, [REASONS.RATE_LIMITED]);
  assert.ok(result.body.checkout.transaction_id);
  assert.deepEqual(buckets.sort(), [`trial:${USER_A}`, 'trial:ip:203.0.113.0/24']);
  assert.ok(!ledger.state.calls.includes('findClaim'), 'the ladder does not run when rate limited');
});

test('eligibility: TRIAL_ENABLED=false -> trial_disabled, no claim written, no ladder read', async () => {
  const { result, ledger, provider } = await run({ trialEnabled: false });
  assert.equal(result.status, 200);
  assert.equal(result.body.trial, false);
  assert.deepEqual(result.body.reasons, [REASONS.TRIAL_DISABLED]);
  assert.equal(ledger.state.claims.size, 0);
  assert.ok(!ledger.state.calls.includes('findClaim'));
  assert.equal(provider.calls.find((c) => c[0] === 'createCheckoutSession')[1].priceId, 'TESTFIXTURE_price_monthly');
  assert.ok(result.cookieValue, 'the cookie is still issued for the D1 counter');
});

test('eligibility: yearly plan uses the yearly prices; unknown or unconfigured plan is 400', async () => {
  const { result, provider } = await run({ plan: 'yearly' });
  assert.equal(result.body.trial, true);
  assert.equal(provider.calls.find((c) => c[0] === 'createCheckoutSession')[1].priceId, 'TESTFIXTURE_price_yearly_trial');
  const bad = await run({ plan: 'lifetime' });
  assert.equal(bad.result.status, 400);
  assert.equal(bad.result.body.error, 'bad_plan');
  assert.deepEqual(bad.result.body.plans, ['monthly', 'yearly'], 'the refusal names the plans we sell');

  // The retired second plan is now simply an unknown plan: refused, and no
  // env var can bring it back.
  const retired = await run({ plan: 'retired_second_plan' });
  assert.equal(retired.result.status, 400);
  assert.equal(retired.result.body.error, 'bad_plan');
  const retiredConfigured = await run({
    plan: 'retired_second_plan',
    env: { ...ENV, MOR_PRICE_RETIRED: 'TESTFIXTURE_price_retired' },
  });
  assert.equal(retiredConfigured.result.status, 400, 'no env var revives a plan that no longer exists');
  assert.equal(retiredConfigured.result.body.error, 'bad_plan');
});

test('eligibility: a plan with no trial price never offers a trial and writes no reservation', async () => {
  // A monthly plan whose trial price env var is missing: still sellable at the
  // full price, never a trial, and the ladder is skipped entirely.
  const { result, ledger, provider } = await run({ env: { ...ENV, MOR_PRICE_MONTHLY_TRIAL: '' } });
  assert.equal(result.status, 200, 'never a 503: the buyer can still subscribe at full price');
  assert.equal(result.body.trial, false);
  assert.deepEqual(result.body.reasons, [REASONS.TRIAL_DISABLED]);
  assert.equal(ledger.state.claims.size, 0, 'no reservation for a trial that cannot be sold');
  assert.ok(!ledger.state.calls.includes('findClaim'), 'the ladder is not run');
  assert.equal(provider.calls.find((c) => c[0] === 'createCheckoutSession')[1].priceId, 'TESTFIXTURE_price_monthly');
  assert.equal(ledger.state.intents[0].trial_granted, false);

  // Same for yearly.
  const yearly = await run({ plan: 'yearly', env: { ...ENV, MOR_PRICE_YEARLY_TRIAL: '' } });
  assert.equal(yearly.result.status, 200);
  assert.equal(yearly.result.body.trial, false);
  assert.equal(yearly.ledger.state.claims.size, 0);
  assert.equal(yearly.provider.calls.find((c) => c[0] === 'createCheckoutSession')[1].priceId, 'TESTFIXTURE_price_yearly');
});

test('eligibility: a refused caller does not also consume the network bucket; an intent failure on a no-trial answer alerts once', async () => {
  const buckets = [];
  const dblimit = async (bucket) => {
    buckets.push(bucket);
    return false;
  };
  await run({ dblimit, ip: '203.0.113.9' });
  assert.deepEqual(buckets, [`trial:${USER_A}`], 'the /24 bucket is not bumped once the user bucket refused');

  const ledger = fakeLedger({ failOn: ['insertIntent', 'updateIntent'] });
  const { result, alerts } = await run({ ledger, trialEnabled: false });
  assert.equal(result.status, 200);
  assert.equal(result.body.trial, false);
  assert.deepEqual(alerts.map((a) => a.kind), ['intent_insert_failed'], 'no second alert for an update of a row that was never written');
  assert.ok(!ledger.state.calls.includes('updateIntent'));
});

test('eligibility: provider transaction failure is 502 and no trial is minted', async () => {
  const { result } = await run({ provider: fakeProvider({ transactionFails: true }) });
  assert.equal(result.status, 502);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error, 'checkout_unavailable');
});

test('eligibility: price preview failure is not fatal', async () => {
  const { result } = await run({ provider: fakeProvider({ previewFails: true }) });
  assert.equal(result.status, 200);
  assert.equal(result.body.price_preview, null);
});

test('eligibility: missing session or peppers never guesses', async () => {
  const noUser = await run({ sub: '', email: '' });
  assert.equal(noUser.result.status, 401);
  const noPepper = await run({ env: { ...ENV, TRIAL_PEPPER: '' } });
  assert.equal(noPepper.result.status, 503);
});

// ------------------------------------------------------ runSessionCount ----

test('session count: mints a device, increments, reads back, caps', async () => {
  const ledger = fakeLedger();
  const env = { DEVICE_PEPPER };
  const a = await runSessionCount({ increment: true, env, ledger, now: NOW });
  assert.equal(a.status, 200);
  assert.equal(a.body.ok, true);
  assert.equal(a.body.free_sessions_used, 1);
  assert.equal((await verifyDeviceValue(a.cookieValue, DEVICE_PEPPER)).ok, true);

  const b = await runSessionCount({ cookie: a.cookieValue, increment: true, env, ledger, now: NOW + 1000 });
  assert.equal(b.body.free_sessions_used, 2);
  assert.equal(b.cookieValue, a.cookieValue);

  const read = await runSessionCount({ cookie: a.cookieValue, increment: false, env, ledger, now: NOW + 2000 });
  assert.equal(read.body.free_sessions_used, 2);

  const id = (await verifyDeviceValue(a.cookieValue, DEVICE_PEPPER)).deviceId;
  ledger.state.devices.get(id).free_sessions_used = FREE_SESSIONS_CAP;
  const capped = await runSessionCount({ cookie: a.cookieValue, increment: true, env, ledger, now: NOW + 3000 });
  assert.equal(capped.body.free_sessions_used, FREE_SESSIONS_CAP);
});

test('session count: a verified mirror repairs the cookie; a forged one mints', async () => {
  const ledger = fakeLedger();
  const env = { DEVICE_PEPPER };
  const a = await runSessionCount({ increment: true, env, ledger, now: NOW });
  const repaired = await runSessionCount({ mirror: a.cookieValue, increment: true, env, ledger, now: NOW });
  assert.equal(repaired.cookieValue, a.cookieValue);
  assert.equal(repaired.body.free_sessions_used, 2);
  const forged = await runSessionCount({ mirror: `${mintDeviceId()}.${'B'.repeat(43)}`, increment: true, env, ledger, now: NOW });
  assert.notEqual(forged.cookieValue, a.cookieValue);
  assert.equal((await verifyDeviceValue(forged.cookieValue, DEVICE_PEPPER)).ok, true, 'a fresh MAC-verifiable id');
  assert.equal(forged.body.free_sessions_used, 1);
  assert.deepEqual(Object.keys(forged.body).sort(), ['device_id', 'free_sessions_used', 'ok'], 'exactly the documented shape; no forged flag leaks');
  assert.equal(ledger.state.devices.get(id(a.cookieValue)).free_sessions_used, 2, 'the real device row is untouched by the forged call');
});

test('session count: a read (GET) never writes — no row for a cookieless or unknown id, no seen_count bump', async () => {
  const ledger = fakeLedger();
  const env = { DEVICE_PEPPER };

  // No cookie: a MAC'd value comes back, count 0, and NOTHING is inserted.
  const read = await runSessionCount({ increment: false, env, ledger, now: NOW });
  assert.equal(read.status, 200);
  assert.equal(read.body.ok, true);
  assert.equal(read.body.free_sessions_used, 0);
  assert.equal((await verifyDeviceValue(read.cookieValue, DEVICE_PEPPER)).ok, true);
  assert.equal(ledger.state.devices.size, 0, 'a crawler cannot grow the devices table with GETs');
  assert.ok(!ledger.state.calls.includes('insertDevice'));
  assert.ok(!ledger.state.calls.includes('touchDevice'));

  // The first POST with that very cookie is the "verifies, no row -> insert" path.
  const post = await runSessionCount({ cookie: read.cookieValue, increment: true, env, ledger, now: NOW + 1000 });
  assert.equal(post.cookieValue, read.cookieValue, 'the minted id is kept, not replaced');
  assert.equal(post.body.free_sessions_used, 1);
  assert.equal(ledger.state.devices.size, 1);

  // A read of a known row bumps nothing.
  const before = { ...ledger.state.devices.get(id(read.cookieValue)) };
  const again = await runSessionCount({ cookie: read.cookieValue, increment: false, env, ledger, now: NOW + 2000 });
  assert.equal(again.body.free_sessions_used, 1);
  assert.deepEqual(ledger.state.devices.get(id(read.cookieValue)), before, 'seen_count and last_seen_at unchanged on a read');
});

/** The uuid half of a MAC'd cookie value (test helper; the MAC is verified elsewhere). */
function id(value) {
  return String(value).slice(0, 36);
}

test('session count: ledger outage still hands out a MAC-verifiable cookie and reports unavailable', async () => {
  const ledger = fakeLedger({ failOn: ['*'] });
  const out = await runSessionCount({ increment: true, env: { DEVICE_PEPPER }, ledger, now: NOW });
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.free_sessions_used, null);
  assert.equal((await verifyDeviceValue(out.cookieValue, DEVICE_PEPPER)).ok, true);
  const missing = await runSessionCount({ increment: true, env: {}, ledger, now: NOW });
  assert.equal(missing.status, 503);
});

// ---------------------------------------------------------- createLedger ---

test('createLedger builds PostgREST requests with bytea-safe filters and the right Prefer headers', async () => {
  const seen = [];
  const request = async (method, path, options) => {
    seen.push({ method, path, options });
    if (method === 'GET') return [];
    if (method === 'POST') return [options.body];
    return null;
  };
  const ledger = createLedger(request);
  const hash = await emailHashLiteral('x@example.com', TRIAL_PEPPER);

  assert.equal(await ledger.findClaim(hash), null);
  assert.equal(seen[0].method, 'GET');
  assert.ok(seen[0].path.startsWith('trial_claims?'));
  assert.ok(seen[0].path.includes(`email_hash=eq.${encodeURIComponent(hash)}`), 'backslash is URL-encoded');
  assert.ok(!seen[0].path.includes('\\'), 'no raw backslash in the query');

  assert.equal(await ledger.userHasSubscription(USER_A), false);
  assert.ok(seen[1].path.includes(`user_id=eq.${USER_A}`));

  const row = { device_id: mintDeviceId(), seen_count: 1 };
  assert.deepEqual(await ledger.insertDevice(row), row);
  assert.equal(seen[2].options.prefer, 'return=representation');

  await ledger.touchDevice(row.device_id, { seen_count: 2 });
  assert.equal(seen[3].method, 'PATCH');
  assert.equal(seen[3].options.prefer, 'return=minimal');
  assert.ok(seen[3].path.includes(`device_id=eq.${row.device_id}`));

  await ledger.reserveClaim({ email_hash: hash, outcome: 'reserved' });
  assert.ok(seen[4].path.includes('on_conflict=email_hash'));
  assert.equal(seen[4].options.prefer, 'resolution=merge-duplicates,return=representation');

  await ledger.findLiveClaimForDevice(row.device_id, new Date(NOW).toISOString());
  assert.ok(seen[5].path.includes('outcome=eq.reserved'));
  assert.ok(seen[5].path.includes('reserved_until=gt.'));

  await ledger.findLiveIntent({ userId: USER_A, plan: 'monthly', nowIso: new Date(NOW).toISOString() });
  assert.ok(seen[6].path.includes('trial_granted=is.true'));
  assert.ok(seen[6].path.includes('consumed_at=is.null'));
  assert.ok(seen[6].path.includes('provider_transaction_id=not.is.null'));

  await ledger.insertIntent({ reservation_id: 'r' });
  await ledger.updateIntent('r', { consumed_at: null });
  assert.equal(seen[8].method, 'PATCH');
  assert.ok(seen[8].path.includes('reservation_id=eq.r'));

  // A throwing request propagates: that is what makes the trial fail closed.
  const broken = createLedger(async () => { throw new Error('TESTFIXTURE 500'); });
  await assert.rejects(() => broken.findClaim(hash), /TESTFIXTURE 500/);
});

// ------------------------------------------------------- no fingerprint ----

test('the module contains no fingerprinting code', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = fileURLToPath(new URL('../api/_lib/trialguard.js', import.meta.url));
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const source = stripComments(await readFile(path, 'utf8')).toLowerCase();
  for (const banned of ['canvas', 'webgl', 'audiocontext', 'hardwareconcurrency', 'devicememory', 'navigator.', 'screen.', 'user-agent', 'fp_hash', 'fingerprint(']) {
    assert.ok(!source.includes(banned), `trialguard.js must not mention ${banned}`);
  }
  for (const handler of ['../api/trial/eligibility.js', '../api/session/count.js']) {
    const text = stripComments(await readFile(fileURLToPath(new URL(handler, import.meta.url)), 'utf8')).toLowerCase();
    for (const banned of ['canvas', 'webgl', 'audiocontext', 'hardwareconcurrency', 'devicememory', 'fp_hash', ['pad', 'dle'].join(''), ['fast', 'spring'].join(''), 'price_id"']) {
      assert.ok(!text.includes(banned), `${handler} must not mention ${banned}`);
    }
    assert.ok(!/signals|consent/.test(text), `${handler} reads no client signals and no consent flag`);
  }
});

// ------------------------------------------------------- HTTP handlers ----
//
// The two Vercel handlers, driven end to end with stubbed dependencies: a
// PostgREST-shaped in-memory database, a stubbed identity check, a stubbed
// limiter and the provider stub above. Nothing here touches the network.


const ORIGIN = 'https://helpmebreath.com';

/**
 * A PostgREST-shaped `db(path, { method, body, prefer })` over in-memory
 * tables. Understands the filters createLedger() builds; anything else is
 * treated as "no match" for GET. Records every call so the tests can assert
 * on headers and writes.
 */
function fakeDb(options = {}) {
  const tables = { trial_claims: [], subscriptions: [], devices: [], checkout_intents: [] };
  const calls = [];
  const db = async (path, opts = {}) => {
    const [table, qs = ''] = String(path).split('?');
    const query = new URLSearchParams(qs);
    const method = opts.method || 'GET';
    calls.push({ table, method, query, opts });
    if (options.failOn && (options.failOn === '*' || options.failOn === table || options.failOn === `${method} ${table}`)) {
      throw new Error(`TESTFIXTURE PostgREST failure on ${method} ${table}`);
    }
    const rows = tables[table];
    if (!rows) throw new Error(`TESTFIXTURE unknown table ${table}`);
    const filters = [...query.entries()].filter(([k]) => !['select', 'limit', 'order', 'on_conflict'].includes(k));
    const matches = (row) =>
      filters.every(([column, expr]) => {
        if (expr.startsWith('eq.')) return String(row[column]) === expr.slice(3);
        if (expr === 'is.null') return row[column] == null;
        if (expr === 'is.true') return row[column] === true;
        if (expr === 'not.is.null') return row[column] != null;
        if (expr.startsWith('gt.')) return String(row[column] || '') > expr.slice(3);
        return false;
      });
    if (method === 'GET') return rows.filter(matches);
    if (method === 'POST') {
      const conflictKey = query.get('on_conflict');
      if (conflictKey) {
        const existing = rows.find((r) => r[conflictKey] === opts.body[conflictKey]);
        if (existing) {
          Object.assign(existing, opts.body);
          return [existing];
        }
      }
      rows.push({ ...opts.body });
      return [opts.body];
    }
    if (method === 'PATCH') {
      for (const row of rows.filter(matches)) Object.assign(row, opts.body);
      return null;
    }
    throw new Error(`TESTFIXTURE unsupported method ${method}`);
  };
  return { db, tables, calls };
}

function httpEnv(overrides = {}) {
  const values = { ...ENV, MOR_API_KEY: 'TESTFIXTURE_api_key', TRIAL_ENABLED: 'true', ...overrides };
  return {
    readEnv: (name) => String(values[name] == null ? '' : values[name]),
    requireEnv: (names) => {
      const out = {};
      const missing = [];
      for (const name of names) {
        if (values[name]) out[name] = values[name];
        else missing.push(name);
      }
      if (missing.length) {
        const error = new Error(`Missing required environment variables: ${missing.join(', ')}`);
        error.name = 'MissingEnvError';
        error.statusCode = 503;
        throw error;
      }
      return out;
    },
  };
}

function eligibilityHandler(overrides = {}) {
  const fake = overrides.fake || fakeDb(overrides.dbOptions);
  const provider = overrides.provider || fakeProvider();
  const alerts = [];
  const handler = createEligibilityHandler({
    requireLiveUser: async (request, { respond }) => {
      const header = request.headers.get('authorization') || '';
      if (!header) return { ok: false, status: 401, response: unauthorized(request, respond) };
      if (header === 'Bearer TESTFIXTURE_unavailable') return { ok: false, status: 503, response: authUnavailable(request, respond) };
      if (header === 'Bearer TESTFIXTURE_revoked') return { ok: false, status: 401, response: unauthorized(request, respond) };
      return { ok: true, sub: USER_A, email: 'Person@Example.com', claims: {}, token: 'x', user: {} };
    },
    db: fake.db,
    dblimitCheck: overrides.dblimitCheck || (async (bucket, windowSeconds, limit) => ({ allowed: true, reason: 'ok', bucket, windowSeconds, limit })),
    getProvider: () => provider,
    providerName: () => 'TESTFIXTURE_mor',
    isProduction: () => true,
    now: () => NOW,
    alert: (kind, detail) => alerts.push({ kind, detail }),
    ...httpEnv(overrides.env),
  });
  return { handler, fake, provider, alerts };
}

function postEligibility(body, headers = {}) {
  const init = {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'x-forwarded-host': 'helpmebreath.com',
      authorization: 'Bearer TESTFIXTURE_jwt',
      'content-type': 'application/json',
      'x-vercel-forwarded-for': '203.0.113.9',
      ...headers,
    },
  };
  for (const [name, value] of Object.entries(init.headers)) if (value === null) delete init.headers[name];
  init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}/api/trial/eligibility`, init);
}

test('trialEnabled(): only the literal true (any case) turns D3 on', () => {
  for (const [value, expected] of [['true', true], ['TRUE', true], [' true ', true], ['1', false], ['yes', false], ['on', false], ['', false], ['false', false]]) {
    assert.equal(trialEnabled(() => value), expected, JSON.stringify(value));
  }
  assert.ok(REQUIRED_ENV.includes('TRIAL_PEPPER') && REQUIRED_ENV.includes('DEVICE_PEPPER'));
  assert.deepEqual([...TRIAL_ENV], ['MOR_PRICE_MONTHLY_TRIAL', 'MOR_PRICE_YEARLY_TRIAL']);
});

test('POST /api/trial/eligibility: foreign or missing Origin is 403 before any identity or database call', async () => {
  const { handler, fake } = eligibilityHandler();
  for (const origin of ['https://evil.example', null]) {
    const response = await handler.POST(postEligibility({ plan: 'monthly' }, { origin }));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'cross_origin');
    assert.equal(response.headers.get('set-cookie'), null, 'no cookie on a refused request');
  }
  assert.equal(fake.calls.length, 0);
});

test('POST /api/trial/eligibility: 401 on a missing or revoked session, 503 when the identity provider is down; never a guess', async () => {
  const { handler, fake } = eligibilityHandler();
  const missing = await handler.POST(postEligibility({ plan: 'monthly' }, { authorization: null }));
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { ok: false, reason: 'unauthenticated' });

  const revoked = await handler.POST(postEligibility({ plan: 'monthly' }, { authorization: 'Bearer TESTFIXTURE_revoked' }));
  assert.equal(revoked.status, 401);

  const down = await handler.POST(postEligibility({ plan: 'monthly' }, { authorization: 'Bearer TESTFIXTURE_unavailable' }));
  assert.equal(down.status, 503);
  assert.equal((await down.json()).reason, 'auth_unavailable');
  assert.equal(fake.calls.length, 0, 'the ledger is never consulted for an unidentified caller');
});

test('POST /api/trial/eligibility: 400 on a bad body or plan; a GET is 405', async () => {
  const { handler } = eligibilityHandler();
  const notJson = await handler.POST(postEligibility('not json'));
  assert.equal(notJson.status, 400);
  assert.equal((await notJson.json()).error, 'bad_request');
  const badPlan = await handler.POST(postEligibility({ plan: 'lifetime' }));
  assert.equal(badPlan.status, 400);
  assert.equal((await badPlan.json()).error, 'bad_plan');

  // 2026-09-12: there is one plan. The retired second plan value is refused
  // like any other unknown plan — there is no env var left that accepts it.
  const retiredPlan = await handler.POST(postEligibility({ plan: 'retired_second_plan' }));
  assert.equal(retiredPlan.status, 400);
  const retiredBody = await retiredPlan.json();
  assert.equal(retiredBody.error, 'bad_plan');
  assert.deepEqual(retiredBody.plans, ['monthly', 'yearly']);

  const noPlan = await handler.POST(postEligibility({ device_mirror: 'x' }));
  assert.equal(noPlan.status, 400);
  const get = await handler.GET(new Request(`${ORIGIN}/api/trial/eligibility`, { headers: { origin: ORIGIN, 'x-forwarded-host': 'helpmebreath.com' } }));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST, OPTIONS');
});

test('POST /api/trial/eligibility: the full path; cookie header exact, no price id, custom_data {rid, v}, Prefer sent once', async () => {
  const { handler, fake, provider } = eligibilityHandler();
  const response = await handler.POST(postEligibility({ plan: 'monthly', device_mirror: '' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, max-age=0');
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.trial, true);
  assert.equal(body.plan, 'monthly');
  assert.match(body.reservation_id, /^[0-9a-f-]{36}$/);
  assert.equal(body.checkout.provider, 'TESTFIXTURE_mor');
  assert.equal(body.checkout.transaction_id, 'txn_TESTFIXTURE_1');
  assert.deepEqual(body.reasons, []);
  assert.deepEqual(Object.keys(body).sort(), ['checkout', 'device_id', 'ok', 'plan', 'price_preview', 'reasons', 'reservation_id', 'trial']);
  assert.ok(!JSON.stringify(body).includes('TESTFIXTURE_price'), 'no price id anywhere in the response');

  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0], `${DEVICE_COOKIE}=${body.device_id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=63072000`);
  assert.equal((await verifyDeviceValue(body.device_id, DEVICE_PEPPER)).ok, true);

  const txn = provider.calls.find((c) => c[0] === 'createCheckoutSession')[1];
  assert.equal(txn.priceId, 'TESTFIXTURE_price_monthly_trial');
  assert.deepEqual(txn.customData, { rid: body.reservation_id, v: 3 });

  // Writes went to the right tables, with Prefer through the helper option only.
  const writes = fake.calls.filter((c) => c.method !== 'GET');
  assert.ok(writes.length >= 4);
  for (const call of writes) {
    assert.equal(typeof call.opts.prefer, 'string', `${call.method} ${call.table} carries a Prefer`);
    assert.equal(call.opts.headers, undefined, 'Prefer is never duplicated as a raw header');
  }
  assert.equal(fake.tables.trial_claims.length, 1);
  assert.equal(fake.tables.trial_claims[0].outcome, 'reserved');
  assert.equal(fake.tables.checkout_intents.length, 1);
  assert.equal(fake.tables.checkout_intents[0].provider_transaction_id, 'txn_TESTFIXTURE_1');
  assert.equal(fake.tables.checkout_intents[0].user_id, USER_A, 'user id from the verified session');
  assert.equal(fake.tables.devices.length, 1);
});

test('POST /api/trial/eligibility: identity- and price-shaped body fields are stripped and ignored', async () => {
  const { handler, fake, provider } = eligibilityHandler();
  const response = await handler.POST(
    postEligibility({ plan: 'monthly', user_id: USER_B, price_id: 'TESTFIXTURE_attacker_price', device_id: mintDeviceId(), email: 'other@example.com' }),
  );
  assert.equal(response.status, 200);
  const txn = provider.calls.find((c) => c[0] === 'createCheckoutSession')[1];
  assert.equal(txn.priceId, 'TESTFIXTURE_price_monthly_trial', 'the server chose the price');
  assert.equal(fake.tables.checkout_intents[0].user_id, USER_A, 'the body cannot pick the user');
  assert.equal(provider.calls.find((c) => c[0] === 'ensureCustomer')[1], 'Person@Example.com', 'the body cannot pick the email');
});

test('POST /api/trial/eligibility: TRIAL_ENABLED unset means off, and the trial price vars are then not required', async () => {
  const { handler, fake } = eligibilityHandler({ env: { TRIAL_ENABLED: '', MOR_PRICE_MONTHLY_TRIAL: '', MOR_PRICE_YEARLY_TRIAL: '' } });
  const response = await handler.POST(postEligibility({ plan: 'monthly' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.trial, false);
  assert.deepEqual(body.reasons, [REASONS.TRIAL_DISABLED]);
  assert.equal(fake.tables.trial_claims.length, 0);

  // With D3 on, a missing trial price is a loud 503, never a guess.
  const missing = eligibilityHandler({ env: { MOR_PRICE_MONTHLY_TRIAL: '' } });
  const refused = await missing.handler.POST(postEligibility({ plan: 'monthly' }));
  assert.equal(refused.status, 503);
  assert.ok(!JSON.stringify(await refused.json()).includes('TESTFIXTURE'), 'no value leaks');
});

test('POST /api/trial/eligibility: a limiter outage and a database outage both fail closed on the trial, over HTTP', async () => {
  const limiterDown = eligibilityHandler({
    dblimitCheck: async (bucket, windowSeconds, limit) => ({ allowed: false, reason: 'limiter_unavailable', bucket, windowSeconds, limit }),
  });
  let response = await limiterDown.handler.POST(postEligibility({ plan: 'monthly' }));
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.trial, false);
  assert.deepEqual(body.reasons, [REASONS.LEDGER_UNAVAILABLE], 'an unreachable limiter is reported as the ledger outage it is, not as rate_limited');
  assert.equal(limiterDown.alerts.length, 1);

  const dbDown = eligibilityHandler({ dbOptions: { failOn: 'trial_claims' } });
  response = await dbDown.handler.POST(postEligibility({ plan: 'monthly' }));
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.trial, false);
  assert.deepEqual(body.reasons, [REASONS.LEDGER_UNAVAILABLE]);
  assert.equal(body.checkout.transaction_id, 'txn_TESTFIXTURE_1', 'the full-price checkout still exists');
  const txn = dbDown.provider.calls.find((c) => c[0] === 'createCheckoutSession')[1];
  assert.equal(txn.priceId, 'TESTFIXTURE_price_monthly');
  assert.equal(dbDown.alerts[0].kind, 'ledger_unavailable');
  assert.ok(!JSON.stringify(dbDown.alerts).includes('example.com'));

  const limited = eligibilityHandler({
    dblimitCheck: async (bucket, windowSeconds, limit) => ({ allowed: false, reason: 'limited', bucket, windowSeconds, limit }),
  });
  response = await limited.handler.POST(postEligibility({ plan: 'monthly' }));
  body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.reasons, [REASONS.RATE_LIMITED]);
  assert.equal(limited.alerts.length, 0, 'a genuine rate limit is not an outage');
});

test('POST /api/trial/eligibility: a repeat trialist gets the no-trial transaction and a one-word reason', async () => {
  const fake = fakeDb();
  fake.tables.trial_claims.push({ email_hash: await emailHashLiteral('person@example.com', TRIAL_PEPPER), outcome: 'converted', user_id: USER_B });
  const { handler, provider } = eligibilityHandler({ fake });
  const response = await handler.POST(postEligibility({ plan: 'yearly' }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.trial, false);
  assert.deepEqual(body.reasons, [REASONS.EMAIL_USED]);
  assert.equal(provider.calls.find((c) => c[0] === 'createCheckoutSession')[1].priceId, 'TESTFIXTURE_price_yearly');
  assert.equal(fake.tables.checkout_intents[0].trial_granted, false);
});

function countHandler(overrides = {}) {
  const fake = overrides.fake || fakeDb(overrides.dbOptions);
  const handler = createSessionCountHandler({
    db: fake.db,
    requireEnv: () => ({ DEVICE_PEPPER }),
    limiter: overrides.limiter || { check: () => ({ ok: true, limit: 30, remaining: 29, resetMs: 60000 }) },
    now: () => NOW,
  });
  return { handler, fake };
}

function countRequest(method, options = {}) {
  const headers = { 'x-forwarded-host': 'helpmebreath.com', 'x-vercel-forwarded-for': '203.0.113.9', ...(options.headers || {}) };
  if (options.cookie) headers.cookie = `${DEVICE_COOKIE}=${options.cookie}`;
  const init = { method, headers };
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body || {});
  }
  return new Request(`${ORIGIN}/api/session/count${options.query || ''}`, init);
}

test('GET /api/session/count: needs no Origin, mints a cookie, reads only the cookie, and never writes', async () => {
  const { handler, fake } = countHandler();
  const response = await handler.GET(countRequest('GET', { query: `?device_mirror=${mintDeviceId()}.${'B'.repeat(43)}` }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['device_id', 'free_sessions_used', 'ok']);
  assert.equal(body.ok, true);
  assert.equal(body.free_sessions_used, 0);
  assert.equal((await verifyDeviceValue(body.device_id, DEVICE_PEPPER)).ok, true);
  assert.equal(response.headers.getSetCookie()[0], deviceCookieHeader(body.device_id));
  assert.equal(fake.calls.filter((c) => c.method !== 'GET').length, 0, 'a read writes nothing');
  assert.equal(fake.tables.devices.length, 0);

  // A GET with a verified cookie reports the stored count without bumping it.
  fake.tables.devices.push({ device_id: body.device_id.slice(0, 36), seen_count: 4, free_sessions_used: 2, trial_count: 0 });
  const again = await handler.GET(countRequest('GET', { cookie: body.device_id }));
  const read = await again.json();
  assert.equal(read.device_id, body.device_id);
  assert.equal(read.free_sessions_used, 2);
  assert.equal(fake.tables.devices[0].seen_count, 4);
});

test('POST /api/session/count: same-origin only; counts one session and accepts only a MAC-verified mirror', async () => {
  const { handler, fake } = countHandler();
  const foreign = await handler.POST(countRequest('POST', { headers: { origin: 'https://evil.example' } }));
  assert.equal(foreign.status, 403);
  assert.equal(fake.calls.length, 0);
  const noOrigin = await handler.POST(countRequest('POST'));
  assert.equal(noOrigin.status, 403);

  const first = await handler.POST(countRequest('POST', { headers: { origin: ORIGIN }, body: { device_mirror: '' } }));
  assert.equal(first.status, 200);
  const a = await first.json();
  assert.equal(a.free_sessions_used, 1);
  assert.equal(fake.tables.devices.length, 1);
  assert.equal(first.headers.getSetCookie()[0], deviceCookieHeader(a.device_id));

  // Cookie swept, mirror supplied: the same device continues.
  const second = await handler.POST(countRequest('POST', { headers: { origin: ORIGIN }, body: { device_mirror: a.device_id } }));
  const b = await second.json();
  assert.equal(b.device_id, a.device_id);
  assert.equal(b.free_sessions_used, 2);

  // A bare uuid (test 10) or a wrong-MAC mirror is not honoured: a new id, the old row untouched.
  const forged = await handler.POST(countRequest('POST', { headers: { origin: ORIGIN }, body: { device_mirror: mintDeviceId() } }));
  const c = await forged.json();
  assert.notEqual(c.device_id, a.device_id);
  assert.equal(c.free_sessions_used, 1);
  assert.equal(fake.tables.devices.find((r) => r.device_id === a.device_id.slice(0, 36)).free_sessions_used, 2);

  // A non-JSON body is tolerated: the beacon still counts on the cookie alone.
  const junk = await handler.POST(new Request(`${ORIGIN}/api/session/count`, { method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-host': 'helpmebreath.com', cookie: `${DEVICE_COOKIE}=${a.device_id}` }, body: 'junk' }));
  assert.equal(junk.status, 200);
  assert.equal((await junk.json()).free_sessions_used, 3);
});

test('/api/session/count: the in-memory limiter answers 429 and a database outage answers 200 ok:false with a cookie', async () => {
  const limited = countHandler({ limiter: { check: () => ({ ok: false, limit: 30, remaining: 0, resetMs: 1000, retryAfterSeconds: 1 }) } });
  const refused = await limited.handler.GET(countRequest('GET'));
  assert.equal(refused.status, 429);

  const down = countHandler({ dbOptions: { failOn: '*' } });
  const response = await down.handler.POST(countRequest('POST', { headers: { origin: ORIGIN } }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.free_sessions_used, null, 'the client falls back to its local count');
  assert.equal((await verifyDeviceValue(body.device_id, DEVICE_PEPPER)).ok, true);
  assert.equal(response.headers.getSetCookie()[0], deviceCookieHeader(body.device_id));
});
