/**
 * tools/api.test.mjs — the API's test suite.
 *
 *   node --test tools/api.test.mjs
 *
 * Zero dependencies, no network, no Vercel. Every provider call goes through an
 * injected `fetchImpl`, so the suite runs offline and never touches a real
 * merchant of record or a real mailing list.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  b64urlDecode,
  b64urlDecodeToString,
  b64urlEncode,
  base64Encode,
  buildPayload,
  hmacSha256,
  kidFor,
  sha256Hex,
  signToken,
  subFor,
  timingSafeEqual,
  verifyToken,
} from '../api/_lib/crypto.js';

import {
  DEV_DEFAULTS,
  MissingEnvError,
  describeConfig,
  emailProviderName,
  providerName,
  requireEnv,
} from '../api/_lib/env.js';

import { createLimiter, rateLimitHeaders } from '../api/_lib/ratelimit.js';

import {
  corsHeaders,
  json,
  preflight,
  readJsonBody,
  resolveSameOrigin,
} from '../api/_lib/respond.js';

import { PROVIDER_IDS, getProvider, listProviders } from '../api/_lib/providers/index.js';

import { paddleProvider } from '../api/_lib/providers/paddle.js';
import { fastspringProvider } from '../api/_lib/providers/fastspring.js';
import { getEmailProvider } from '../api/_lib/email/index.js';
import { isAlreadySubscribed } from '../api/_lib/email/brevo.js';

import { validateSubscribe, EMAIL_RE, SUCCESS_MESSAGE } from '../api/subscribe.js';
import { GET as healthGet } from '../api/health.js';

/* ------------------------------------------------------------------ helpers */

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef0123456789abcdef01';
const OTHER_SECRET = 'other-secret-0123456789abcdef0123456789abcdef0123456789abcde';

const TXN = 'txn_01hqwertyuiopasdfghjklzxcv';
const CTM = 'ctm_01hqwertyuiopasdfghjklzxcv';

const DAY = 24 * 60 * 60 * 1000;

/**
 * A fetch stub. `routes` maps "METHOD path" (path includes the query string) to
 * either a response descriptor or a function of (url, init).
 */
function stubFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const parsed = new URL(url);
    const key = `${method} ${parsed.pathname}${parsed.search}`;
    calls.push({ method, url, path: parsed.pathname, search: parsed.search, init });
    let entry = routes[key];
    if (entry === undefined) entry = routes[`${method} ${parsed.pathname}`];
    if (entry === undefined) {
      return { ok: false, status: 404, json: async () => ({ error: 'no stub for ' + key }) };
    }
    const value = typeof entry === 'function' ? await entry(url, init) : entry;
    const status = value.status || 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => value.body,
    };
  };
  impl.calls = calls;
  return impl;
}

/** A Request the same-origin CORS logic will accept. */
function siteRequest(options = {}) {
  return new Request(options.url || 'https://helpmebreath.com/api/license', {
    method: options.method || 'POST',
    headers: {
      'x-forwarded-host': 'helpmebreath.com',
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.headers || {}),
    },
    ...(options.body ? { body: options.body } : {}),
  });
}

/**
 * Run `fn` with a patched process.env, restoring every touched key afterwards.
 * `undefined` in the patch means "unset". A sync `fn` is restored on return; an
 * async `fn` (a request handler) is restored once its promise settles.
 */
function withEnv(patch, fn) {
  const saved = {};
  for (const [name, value] of Object.entries(patch)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const restore = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  let result;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

/* --------------------------------------------------------------- base64url */

test('base64url round-trips text, bytes and every byte value', () => {
  for (const sample of ['', 'a', 'ab', 'abc', 'hello world', 'ünïcødé — em dash']) {
    assert.equal(b64urlDecodeToString(b64urlEncode(sample)), sample);
  }

  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) all[i] = i;
  const decoded = b64urlDecode(b64urlEncode(all));
  assert.deepEqual(Array.from(decoded), Array.from(all));
});

test('base64url output is URL safe and unpadded', () => {
  const encoded = b64urlEncode(new Uint8Array([251, 255, 190, 0]));
  assert.equal(encoded.includes('+'), false);
  assert.equal(encoded.includes('/'), false);
  assert.equal(encoded.includes('='), false);
});

test('base64Encode produces padded standard base64 for Basic auth', () => {
  assert.equal(base64Encode('user:pass'), 'dXNlcjpwYXNz');
  assert.equal(base64Encode('a'), 'YQ==');
  assert.equal(base64Encode('ab'), 'YWI=');
});

test('b64urlDecode rejects characters outside the alphabet', () => {
  assert.throws(() => b64urlDecode('abc$'), /Invalid base64url character/);
});

/* ------------------------------------------------------------------ hashing */

test('sha256Hex matches a known vector', async () => {
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('hmacSha256 matches RFC 4231 test case 1', async () => {
  const key = new Uint8Array(20).fill(0x0b);
  const mac = await hmacSha256(key, 'Hi There');
  const hex = Array.from(mac)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  assert.equal(hex, 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
});

test('kidFor is the first 8 hex characters of sha256(secret)', async () => {
  assert.equal(await kidFor(SECRET), (await sha256Hex(SECRET)).slice(0, 8));
  assert.notEqual(await kidFor(SECRET), await kidFor(OTHER_SECRET));
});

test('subFor is the first 12 hex characters of sha256(key) and trims input', async () => {
  const sub = await subFor('txn_abc');
  assert.equal(sub.length, 12);
  assert.equal(sub, (await sha256Hex('txn_abc')).slice(0, 12));
  assert.equal(await subFor('  txn_abc  '), sub);
});

test('timingSafeEqual compares by value, not by identity', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
});

/* -------------------------------------------------------------- token round trip */

test('signToken/verifyToken round trip returns the exact payload', async () => {
  const kid = await kidFor(SECRET);
  const payload = buildPayload({
    tier: 'pro',
    sub: 'a1b2c3d4e5f6',
    kid,
    act: 3,
    days: 7,
    domains: ['example.test'],
  });

  const token = await signToken(payload, SECRET);
  assert.equal(token.split('.').length, 2);

  const result = await verifyToken(token, SECRET);
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'ok');
  assert.deepEqual(result.payload, payload);
  assert.equal(result.payload.v, 1);
  assert.deepEqual(Object.keys(result.payload).sort(), ['act', 'dom', 'exp', 'iat', 'kid', 'sub', 'tier', 'v']);
});

test('buildPayload omits dom when no domains are given and sets exp from days', async () => {
  const now = 1_700_000_000_000;
  const payload = buildPayload({ tier: 'pro', sub: 's', kid: 'k', act: 1, days: 30, now });
  assert.equal('dom' in payload, false);
  assert.equal(payload.iat, Math.floor(now / 1000));
  assert.equal(payload.exp - payload.iat, 30 * 24 * 60 * 60);
});

test('verifyToken reports expiry, and allowExpired lets an expired token through', async () => {
  const kid = await kidFor(SECRET);
  const now = Date.now();
  const payload = buildPayload({ tier: 'pro', sub: 's', kid, act: 1, days: 30, now: now - 31 * DAY });
  const token = await signToken(payload, SECRET);

  const strict = await verifyToken(token, SECRET, { now });
  assert.equal(strict.ok, false);
  assert.equal(strict.reason, 'expired');
  assert.equal(strict.payload.tier, 'pro', 'the payload is still returned so callers can apply grace');

  const lenient = await verifyToken(token, SECRET, { now, allowExpired: true });
  assert.equal(lenient.ok, true);
  assert.equal(lenient.reason, 'expired_allowed');
});

test('verifyToken rejects a tampered payload and a tampered signature', async () => {
  const kid = await kidFor(SECRET);
  const payload = buildPayload({ tier: 'pro', sub: 's', kid, act: 1, days: 30 });
  const token = await signToken(payload, SECRET);
  const [head, sig] = token.split('.');

  // Upgrade the tier in the payload, keep the original signature.
  const forgedHead = b64urlEncode(JSON.stringify({ ...payload, tier: 'studio' }));
  const forged = await verifyToken(`${forgedHead}.${sig}`, SECRET);
  assert.equal(forged.ok, false);
  assert.equal(forged.reason, 'bad_signature');

  // Flip one character of the signature.
  const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
  const tamperedSig = await verifyToken(`${head}.${flipped}`, SECRET);
  assert.equal(tamperedSig.ok, false);
  assert.equal(tamperedSig.reason, 'bad_signature');

  // A token signed with a different secret must not verify.
  const wrongSecretToken = await signToken(payload, OTHER_SECRET);
  const wrongSecret = await verifyToken(wrongSecretToken, SECRET);
  assert.equal(wrongSecret.ok, false);
  assert.equal(wrongSecret.reason, 'bad_signature');
});

test('verifyToken reports kid_mismatch after a secret rotation', async () => {
  // Signed correctly with the current secret, but stamped with the old kid.
  const stale = buildPayload({ tier: 'pro', sub: 's', kid: await kidFor(OTHER_SECRET), act: 1, days: 30 });
  const token = await signToken(stale, SECRET);

  const result = await verifyToken(token, SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'kid_mismatch');
  assert.equal(result.payload.tier, 'pro');

  // expectedKid lets a caller skip the hash when it already knows the kid.
  const good = buildPayload({ tier: 'pro', sub: 's', kid: await kidFor(SECRET), act: 1, days: 30 });
  const goodToken = await signToken(good, SECRET);
  const withKid = await verifyToken(goodToken, SECRET, { expectedKid: await kidFor(SECRET) });
  assert.equal(withKid.ok, true);
});

test('verifyToken rejects malformed input without throwing', async () => {
  const cases = [
    ['', 'missing'],
    [null, 'missing'],
    ['nodot', 'malformed'],
    ['.abc', 'malformed'],
    ['abc.', 'malformed'],
    ['a.b.c', 'malformed'],
  ];
  for (const [input, reason] of cases) {
    const result = await verifyToken(input, SECRET);
    assert.equal(result.ok, false, `expected ${JSON.stringify(input)} to fail`);
    assert.equal(result.reason, reason, `for input ${JSON.stringify(input)}`);
  }
});

test('verifyToken rejects a correctly signed payload with the wrong version', async () => {
  const kid = await kidFor(SECRET);
  const head = b64urlEncode(JSON.stringify({ v: 2, tier: 'studio', sub: 's', iat: 1, exp: 9e9, kid, act: 1 }));
  const sig = b64urlEncode(await hmacSha256(SECRET, head));
  const result = await verifyToken(`${head}.${sig}`, SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_version');
});

test('verifyToken rejects a payload that is not an object', async () => {
  const head = b64urlEncode(JSON.stringify(['not', 'an', 'object']));
  const sig = b64urlEncode(await hmacSha256(SECRET, head));
  const result = await verifyToken(`${head}.${sig}`, SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_payload');
});

/* ---------------------------------------------------------------- rate limiter */

test('the rate limiter allows the limit and blocks the next request', () => {
  const limiter = createLimiter({ name: 'test', limit: 3, windowMs: 1000 });
  const now = 1_000_000;

  assert.equal(limiter.check('1.2.3.4', now).ok, true);
  assert.equal(limiter.check('1.2.3.4', now).ok, true);
  const third = limiter.check('1.2.3.4', now);
  assert.equal(third.ok, true);
  assert.equal(third.remaining, 0);

  const fourth = limiter.check('1.2.3.4', now);
  assert.equal(fourth.ok, false);
  assert.equal(fourth.remaining, 0);
  assert.equal(fourth.limit, 3);
  assert.ok(fourth.retryAfter >= 1);
});

test('the rate limiter buckets by key and resets when the window rolls over', () => {
  const limiter = createLimiter({ name: 'test', limit: 2, windowMs: 1000 });
  const now = 5_000_000;

  limiter.check('a', now);
  limiter.check('a', now);
  assert.equal(limiter.check('a', now).ok, false);
  assert.equal(limiter.check('b', now).ok, true, 'a different address has its own budget');

  assert.equal(limiter.check('a', now + 1001).ok, true, 'the window rolled over');
  assert.equal(limiter.peek('a', now + 1001), 1);
});

test('the rate limiter prunes expired buckets rather than growing forever', () => {
  const limiter = createLimiter({ name: 'test', limit: 1, windowMs: 10, maxKeys: 20 });
  for (let i = 0; i < 200; i += 1) limiter.check(`ip-${i}`, 1_000 + i);
  assert.ok(limiter.size() <= 20, `expected at most 20 buckets, saw ${limiter.size()}`);
});

test('rateLimitHeaders reports the limit and only adds Retry-After when asked', () => {
  const limiter = createLimiter({ name: 'test', limit: 2, windowMs: 1000 });
  const result = limiter.check('x');
  const plain = rateLimitHeaders(result);
  assert.equal(plain['RateLimit-Limit'], '2');
  assert.equal('Retry-After' in plain, false);
  assert.equal('Retry-After' in rateLimitHeaders(result, { includeRetryAfter: true }), true);
});

/* ------------------------------------------------------------------- responses */

test('json() is always no-store and always JSON', async () => {
  const response = json(200, { ok: true }, { request: siteRequest() });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await response.json(), { ok: true });
});

test('CORS: the same origin is echoed, a foreign origin is not', () => {
  const same = siteRequest({ origin: 'https://helpmebreath.com' });
  assert.equal(resolveSameOrigin(same), 'https://helpmebreath.com');
  assert.equal(corsHeaders(same)['Access-Control-Allow-Origin'], 'https://helpmebreath.com');

  const foreign = siteRequest({ origin: 'https://evil.example' });
  assert.equal(resolveSameOrigin(foreign), '');
  assert.equal(corsHeaders(foreign)['Access-Control-Allow-Origin'], undefined);
  assert.equal(corsHeaders(foreign).Vary, 'Origin');
});

test('CORS: ALLOWED_ORIGINS adds an extra origin without opening the door', () => {
  withEnv({ ALLOWED_ORIGINS: 'https://staging.helpmebreath.com' }, () => {
    const staging = siteRequest({ origin: 'https://staging.helpmebreath.com' });
    assert.equal(resolveSameOrigin(staging), 'https://staging.helpmebreath.com');
    const other = siteRequest({ origin: 'https://evil.example' });
    assert.equal(resolveSameOrigin(other), '');
  });
});

test('CORS: anyOrigin is a flat star and never allows credentials', () => {
  const headers = corsHeaders(siteRequest({ origin: 'https://someone-elses-site.example' }), {
    anyOrigin: true,
  });
  assert.equal(headers['Access-Control-Allow-Origin'], '*');
  assert.equal('Access-Control-Allow-Credentials' in headers, false);
});

test('preflight answers 204 with the allowed methods', () => {
  const response = preflight(siteRequest({ origin: 'https://helpmebreath.com', method: 'OPTIONS' }), {
    methods: 'POST, OPTIONS',
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
});

test('readJsonBody rejects oversized, non-JSON and non-object bodies', async () => {
  const tooBig = siteRequest({ body: JSON.stringify({ pad: 'x'.repeat(5000) }) });
  assert.deepEqual(await readJsonBody(tooBig, { maxBytes: 128 }), { ok: false, reason: 'too_large' });

  const notJson = siteRequest({ body: 'not json at all' });
  assert.deepEqual(await readJsonBody(notJson), { ok: false, reason: 'not_json' });

  const array = siteRequest({ body: '[1,2,3]' });
  assert.deepEqual(await readJsonBody(array), { ok: false, reason: 'not_object' });

  const good = siteRequest({ body: '{"key":"txn_1"}' });
  const parsed = await readJsonBody(good);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data, { key: 'txn_1' });
});

/* ------------------------------------------------------------------ environment */

test('requireEnv throws a named error in production and lists every missing name', () => {
  withEnv({ VERCEL_ENV: 'production', LICENSE_SECRET: undefined, MOR_API_KEY: undefined }, () => {
    assert.throws(
      () => requireEnv(['LICENSE_SECRET', 'MOR_API_KEY']),
      (error) => {
        assert.ok(error instanceof MissingEnvError);
        assert.deepEqual(error.missing, ['LICENSE_SECRET', 'MOR_API_KEY']);
        assert.match(error.message, /LICENSE_SECRET, MOR_API_KEY/);
        assert.match(error.message, /Vercel/);
        return true;
      },
    );
  });
});

test('requireEnv returns safe placeholders in development', () => {
  withEnv({ VERCEL_ENV: 'development', NODE_ENV: 'development', LICENSE_SECRET: undefined, MOR_API_KEY: undefined }, () => {
    const env = requireEnv(['LICENSE_SECRET', 'MOR_API_KEY']);
    assert.equal(env.LICENSE_SECRET, DEV_DEFAULTS.LICENSE_SECRET);
    assert.equal(env.LICENSE_SECRET.length, 64, 'the dev secret is the same length as a real one');
    assert.match(env.MOR_API_KEY, /^dev-missing-/, 'an obviously fake value fails at the provider, not silently');
  });
});

test('a preview deployment is not production', () => {
  withEnv({ VERCEL_ENV: 'preview', LICENSE_SECRET: undefined }, () => {
    assert.doesNotThrow(() => requireEnv(['LICENSE_SECRET']));
  });
});

test('provider names fall back to the primaries and ignore case', () => {
  withEnv({ MOR_PROVIDER: undefined, EMAIL_PROVIDER: undefined }, () => {
    assert.equal(providerName(), 'paddle');
    assert.equal(emailProviderName(), 'brevo');
  });
  withEnv({ MOR_PROVIDER: 'FastSpring', EMAIL_PROVIDER: 'MailerLite' }, () => {
    assert.equal(providerName(), 'fastspring');
    assert.equal(emailProviderName(), 'mailerlite');
  });
  withEnv({ MOR_PROVIDER: 'nonsense' }, () => {
    assert.equal(providerName(), 'paddle', 'an unknown value falls back to the primary');
  });
});

test('describeConfig reports booleans and names only, never a value', () => {
  withEnv(
    {
      LICENSE_SECRET: 'super-secret-value',
      MOR_API_KEY: undefined,
      EMAIL_PROVIDER: 'mailerlite',
      EMAIL_API_KEY: 'another-secret',
      EMAIL_LIST_ID: '42',
      MOR_PRICE_MONTHLY: undefined,
    },
    () => {
      const report = describeConfig();
      assert.equal(report.configured.license_secret, true);
      assert.equal(report.configured.mor_api_key, false);
      assert.equal(report.email, 'mailerlite');
      assert.ok(report.missing.includes('MOR_API_KEY'));
      assert.ok(report.missing.includes('MOR_PRICE_MONTHLY'));

      const serialised = JSON.stringify(report);
      assert.equal(serialised.includes('super-secret-value'), false);
      assert.equal(serialised.includes('another-secret'), false);
    },
  );
});

const HEALTH_URL = 'https://helpmebreath.com/api/health';

/** Every provider-shaped variable unset, plus one required secret unset so `ok` must be false. */
const NOTHING_CONFIGURED = {
  MOR_PROVIDER: undefined,
  EMAIL_PROVIDER: undefined,
  MOR_API_KEY: undefined,
  MOR_STOREFRONT: undefined,
};

test('health: provider and email are null until MOR_PROVIDER / EMAIL_PROVIDER are actually set', async () => {
  const response = await withEnv(NOTHING_CONFIGURED, () => healthGet(new Request(HEALTH_URL)));
  assert.equal(response.status, 200, 'a report, not a probe');
  const body = await response.json();

  assert.equal(body.ok, false);
  assert.equal(body.provider, null, 'the code default must not leak into a public response');
  assert.equal(body.email, null, 'the code default must not leak into a public response');
  assert.equal(body.configured.mor_provider, false);
  assert.equal(body.configured.email_provider, false);
  assert.ok(body.missing.includes('MOR_API_KEY'), 'the missing list is unchanged');
  assert.equal(typeof body.env, 'string');
  assert.ok(!Number.isNaN(Date.parse(body.time)));

  const serialised = JSON.stringify(body);
  assert.doesNotMatch(serialised, /paddle|fastspring|brevo|mailerlite/i, 'no merchant of record or email service is named while none is configured');
});

test('health: a provider that is set in the environment is reported by name', async () => {
  const response = await withEnv({ ...NOTHING_CONFIGURED, MOR_PROVIDER: 'fastspring' }, () => healthGet(new Request(HEALTH_URL)));
  const body = await response.json();

  assert.equal(body.provider, 'fastspring');
  assert.equal(body.email, null, 'the other field stays null when its variable is unset');
  assert.equal(body.configured.mor_provider, true);
  assert.ok(body.missing.includes('MOR_STOREFRONT'), "the provider's own requirement still counts");
  assert.equal(body.ok, false);
});

test('getProvider and getEmailProvider reject unknown names loudly', () => {
  assert.equal(getProvider('paddle').id, 'paddle');
  assert.equal(getProvider('fastspring').id, 'fastspring');
  assert.equal(getEmailProvider('brevo').id, 'brevo');
  assert.equal(getEmailProvider('mailerlite').id, 'mailerlite');
  assert.throws(() => getProvider('acme-payments'), /Unknown MOR_PROVIDER/);
  assert.throws(() => getEmailProvider('nope'), /Unknown EMAIL_PROVIDER/);
});

/* ---------------------------------------------------------- subscribe validation */

test('subscribe: a good submission is accepted and normalised', () => {
  const result = validateSubscribe({
    email: '  Person@Example.COM ',
    technique: '478',
    source: 'blog/4-7-8',
    consent: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { email: 'person@example.com', technique: '478', source: 'blog/4-7-8' });
});

test('subscribe: consent must be literally true', () => {
  for (const consent of [false, undefined, null, 'true', 1, 'yes']) {
    const result = validateSubscribe({ email: 'a@b.co', consent });
    assert.equal(result.ok, false, `consent ${JSON.stringify(consent)} must be refused`);
    assert.equal(result.field, 'consent');
  }
  assert.equal(validateSubscribe({ email: 'a@b.co', consent: true }).ok, true);
});

test('subscribe: bad addresses are refused with a human sentence', () => {
  const bad = [
    '',
    '   ',
    'no-at-sign',
    'two@@at.com',
    'trailing.@example.com',
    '.leading@example.com',
    'double..dot@example.com',
    'spaces in@example.com',
    'no-tld@example',
    `${'a'.repeat(65)}@example.com`,
    `${'a'.repeat(250)}@example.com`,
  ];
  for (const email of bad) {
    const result = validateSubscribe({ email, consent: true });
    assert.equal(result.ok, false, `expected ${JSON.stringify(email)} to be refused`);
    assert.equal(result.field, 'email');
    assert.match(result.error, /[a-z]/);
  }

  for (const email of ['a@b.co', 'first.last+tag@sub.example.co.uk', 'x_y-z%w@example.com']) {
    assert.equal(validateSubscribe({ email, consent: true }).ok, true, `expected ${email} to be accepted`);
  }
  assert.equal(EMAIL_RE.test('person@example.com'), true);
});

test('subscribe: technique and source must be short slugs', () => {
  assert.equal(validateSubscribe({ email: 'a@b.co', consent: true, technique: 'box' }).ok, true);
  assert.equal(validateSubscribe({ email: 'a@b.co', consent: true, technique: 'BOX' }).value.technique, 'box');
  assert.equal(validateSubscribe({ email: 'a@b.co', consent: true, technique: '<script>' }).ok, false);
  assert.equal(validateSubscribe({ email: 'a@b.co', consent: true, technique: 'x'.repeat(50) }).ok, false);
  assert.equal(validateSubscribe({ email: 'a@b.co', consent: true, technique: 42 }).ok, false);
  assert.equal(validateSubscribe({ email: 'a@b.co', consent: true, source: 'x'.repeat(80) }).ok, false);
  assert.equal(validateSubscribe({ email: 'a@b.co', consent: true, source: 'post-session' }).ok, true);
  // Absent optional fields are fine and come back as empty strings.
  assert.deepEqual(validateSubscribe({ email: 'a@b.co', consent: true }).value, {
    email: 'a@b.co',
    technique: '',
    source: '',
  });
});

test('subscribe: the success sentence is the one the client contract expects', () => {
  assert.equal(SUCCESS_MESSAGE, 'Check your inbox to confirm');
});

test('brevo: a repeat signup is treated as success so list membership never leaks', () => {
  assert.equal(isAlreadySubscribed(400, { code: 'duplicate_parameter' }), true);
  assert.equal(isAlreadySubscribed(400, { message: 'Contact already exist' }), true);
  assert.equal(isAlreadySubscribed(400, { code: 'invalid_parameter', message: 'Invalid email' }), false);
  assert.equal(isAlreadySubscribed(500, { code: 'duplicate_parameter' }), false);
});

test('email adapters send an unconfirmed contact and never leak the key', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 201, json: async () => ({}) };
  };

  const brevo = getEmailProvider('brevo');
  const brevoResult = await brevo.subscribe(
    { email: 'a@b.co', technique: 'box', source: 'post-session' },
    {
      env: {
        EMAIL_API_KEY: 'brevo-secret',
        EMAIL_LIST_ID: '36',
        EMAIL_DOI_TEMPLATE_ID: '2',
        EMAIL_DOI_REDIRECT_URL: 'https://helpmebreath.com/pro/thanks',
        EMAIL_API_BASE: 'https://brevo.test/v3',
      },
      fetchImpl,
    },
  );
  assert.equal(brevoResult.ok, true);
  assert.equal(calls[0].url, 'https://brevo.test/v3/contacts/doubleOptinConfirmation');
  const brevoBody = JSON.parse(calls[0].init.body);
  assert.deepEqual(brevoBody.includeListIds, [36]);
  assert.equal(brevoBody.templateId, 2);
  assert.equal(brevoBody.attributes.TECHNIQUE, 'box');
  assert.equal(calls[0].init.headers['api-key'], 'brevo-secret');
  assert.equal(calls[0].init.body.includes('brevo-secret'), false, 'the key is never in the body');

  const mailerlite = getEmailProvider('mailerlite');
  const mlResult = await mailerlite.subscribe(
    { email: 'a@b.co', technique: 'box', source: 'post-session' },
    {
      env: { EMAIL_API_KEY: 'ml-secret', EMAIL_LIST_ID: '123', EMAIL_API_BASE: 'https://ml.test/api' },
      fetchImpl,
    },
  );
  assert.equal(mlResult.ok, true);
  assert.equal(calls[1].url, 'https://ml.test/api/subscribers');
  const mlBody = JSON.parse(calls[1].init.body);
  assert.equal(mlBody.status, 'unconfirmed', 'double opt-in is not optional');
  assert.deepEqual(mlBody.groups, ['123']);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer ml-secret');
});

test('email adapters refuse to call out when they are not configured', async () => {
  const brevo = getEmailProvider('brevo');
  const result = await brevo.subscribe(
    { email: 'a@b.co' },
    { env: { EMAIL_API_KEY: 'k', EMAIL_LIST_ID: '', EMAIL_DOI_TEMPLATE_ID: '', EMAIL_DOI_REDIRECT_URL: '' } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
});
