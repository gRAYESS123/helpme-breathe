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
import { EMAIL_PROVIDER_IDS, getEmailProvider, messageForEmailReason } from '../api/_lib/email/index.js';
import { isAlreadySubscribed } from '../api/_lib/email/brevo.js';
import {
  CONFIRM_MAX_AGE_SECONDS,
  CONFIRM_SUBJECT,
  buildConfirmEmail,
  confirm as resendConfirm,
  isAlreadyAContact,
  mintConfirmToken,
  resendProvider,
  verifyConfirmToken,
} from '../api/_lib/email/resend.js';

import {
  CONFIRM_PAGES,
  GET as subscribeGet,
  POST as subscribePost,
  validateSubscribe,
  EMAIL_RE,
  SUCCESS_MESSAGE,
} from '../api/subscribe.js';
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
    assert.equal(emailProviderName(), 'resend', 'the mailing default since 2026-09-13');
  });
  withEnv({ MOR_PROVIDER: 'FastSpring', EMAIL_PROVIDER: 'MailerLite' }, () => {
    assert.equal(providerName(), 'fastspring');
    assert.equal(emailProviderName(), 'mailerlite');
  });
  withEnv({ EMAIL_PROVIDER: 'Brevo' }, () => {
    assert.equal(emailProviderName(), 'brevo', 'the older adapters stay reachable');
  });
  withEnv({ MOR_PROVIDER: 'nonsense', EMAIL_PROVIDER: 'nonsense' }, () => {
    assert.equal(providerName(), 'paddle', 'an unknown value falls back to the primary');
    assert.equal(emailProviderName(), 'resend', 'an unknown value falls back to the default');
  });
});

test('describeConfig: the default mailing adapter needs a sender and a list, never a template', () => {
  withEnv(
    {
      EMAIL_PROVIDER: undefined,
      EMAIL_API_KEY: undefined,
      EMAIL_LIST_ID: undefined,
      EMAIL_FROM: undefined,
      EMAIL_DOI_TEMPLATE_ID: undefined,
      EMAIL_DOI_REDIRECT_URL: undefined,
    },
    () => {
      const report = describeConfig();
      assert.equal(report.email, 'resend');
      for (const name of ['EMAIL_API_KEY', 'EMAIL_LIST_ID', 'EMAIL_FROM', 'EMAIL_DOI_REDIRECT_URL', 'SITE_ORIGIN', 'LICENSE_SECRET']) {
        assert.ok(report.missing.includes(name) || report.configured[name.toLowerCase()], `${name} is required or already set`);
      }
      assert.equal(report.missing.includes('EMAIL_DOI_TEMPLATE_ID'), false, 'the template is Brevo-only');
      assert.equal(report.configured.email_from, false, 'EMAIL_FROM is a known variable');
    },
  );
  withEnv({ EMAIL_PROVIDER: 'brevo', EMAIL_DOI_TEMPLATE_ID: undefined, EMAIL_FROM: undefined }, () => {
    const report = describeConfig();
    assert.ok(report.missing.includes('EMAIL_DOI_TEMPLATE_ID'), 'Brevo still needs its template');
    assert.equal(report.missing.includes('EMAIL_FROM'), false, 'and not the sender');
  });
  withEnv({ EMAIL_PROVIDER: 'mailerlite', EMAIL_DOI_TEMPLATE_ID: undefined, EMAIL_FROM: undefined, EMAIL_LIST_ID: undefined }, () => {
    const report = describeConfig();
    assert.equal(report.missing.includes('EMAIL_DOI_TEMPLATE_ID'), false);
    assert.equal(report.missing.includes('EMAIL_FROM'), false);
    assert.equal(report.missing.includes('EMAIL_LIST_ID'), false, 'MailerLite is unchanged');
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
  assert.doesNotMatch(serialised, /paddle|fastspring|brevo|mailerlite|resend/i, 'no merchant of record or email service is named while none is configured');
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
  assert.equal(getEmailProvider('resend').id, 'resend');
  assert.equal(getEmailProvider('brevo').id, 'brevo');
  assert.equal(getEmailProvider('mailerlite').id, 'mailerlite');
  assert.deepEqual([...EMAIL_PROVIDER_IDS], ['resend', 'brevo', 'mailerlite']);
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

/* ------------------------------------------------------------ resend adapter */

/** Fixtures. Every key-like value carries TESTFIXTURE so push protection lets it through. */
const RESEND_ENV = Object.freeze({
  EMAIL_API_KEY: 're_TESTFIXTURE0000',
  EMAIL_LIST_ID: 'seg_TESTFIXTURE0000',
  EMAIL_FROM: 'Help Me Breathe <hello@helpmebreath.com>',
  EMAIL_DOI_REDIRECT_URL: 'https://helpmebreath.com/pro/thanks?confirmed=1',
  SITE_ORIGIN: 'https://helpmebreath.com',
  LICENSE_SECRET: SECRET,
  EMAIL_API_BASE: 'https://mail.test',
});

const CONTACT = { email: 'a@b.co', technique: 'box', source: 'post-session' };
const CONTACT_PATH = '/contacts/a%40b.co';
const NOW = 1_800_000_000;

/** The routes a signup and a confirmation need. */
const SEGMENT_PATH = `${CONTACT_PATH}/segments/seg_TESTFIXTURE0000`;
function resendRoutes(overrides = {}) {
  return {
    'POST /emails': { status: 200, body: { id: 'e0000000-0000-4000-8000-TESTFIXTURE0' } },
    [`PATCH ${CONTACT_PATH}`]: { status: 200, body: { object: 'contact', id: 'c0000000-0000-4000-8000-TESTFIXTURE0' } },
    [`POST ${SEGMENT_PATH}`]: { status: 200, body: { id: 'seg_TESTFIXTURE0000' } },
    'POST /contacts': { status: 200, body: { object: 'contact', id: 'c0000000-0000-4000-8000-TESTFIXTURE0' } },
    ...overrides,
  };
}

/** Pull the token out of the confirmation email's link. */
function tokenFromSend(call) {
  const body = JSON.parse(call.init.body);
  const match = body.text.match(/https:\/\/helpmebreath\.com\/api\/subscribe\?confirm=(\S+)/);
  assert.ok(match, 'the text body carries the confirmation link');
  return decodeURIComponent(match[1]);
}

test('resend token: mint -> verify round-trips the address, technique, source and time', async () => {
  const token = await mintConfirmToken({ email: 'A@B.co', technique: 'box', source: 'post-session' }, SECRET, NOW);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/, 'base64url payload, one dot, a 43-character signature');

  const verified = await verifyConfirmToken(token, SECRET, NOW + 60);
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.payload, { e: 'a@b.co', t: 'box', s: 'post-session', iat: NOW });

  const bare = await mintConfirmToken({ email: 'a@b.co' }, SECRET, NOW);
  const bareVerified = await verifyConfirmToken(bare, SECRET, NOW);
  assert.deepEqual(bareVerified.payload, { e: 'a@b.co', t: null, s: null, iat: NOW });

  const decoded = JSON.parse(b64urlDecodeToString(token.split('.')[0]));
  assert.equal(decoded.typ, 'doi', 'a confirmation token can never pass for an entitlement token');
  const asEntitlement = await verifyToken(token, SECRET);
  assert.equal(asEntitlement.ok, false);
});

test('resend token: a tampered signature, the wrong secret, a 49-hour-old token and junk are refused', async () => {
  const token = await mintConfirmToken(CONTACT, SECRET, NOW);
  const [head, signature] = token.split('.');

  const flipped = signature[0] === 'A' ? 'B' : 'A';
  const tampered = await verifyConfirmToken(`${head}.${flipped}${signature.slice(1)}`, SECRET, NOW);
  assert.deepEqual(tampered, { ok: false, reason: 'confirm_invalid' });

  const otherHead = b64urlEncode(JSON.stringify({ typ: 'doi', e: 'x@y.co', t: null, s: null, iat: NOW }));
  const swapped = await verifyConfirmToken(`${otherHead}.${signature}`, SECRET, NOW);
  assert.deepEqual(swapped, { ok: false, reason: 'confirm_invalid' }, 'the payload is covered by the signature');

  const wrongSecret = await verifyConfirmToken(token, OTHER_SECRET, NOW);
  assert.deepEqual(wrongSecret, { ok: false, reason: 'confirm_invalid' });

  const stale = await verifyConfirmToken(token, SECRET, NOW + 49 * 60 * 60);
  assert.deepEqual(stale, { ok: false, reason: 'confirm_expired' });
  const justInTime = await verifyConfirmToken(token, SECRET, NOW + CONFIRM_MAX_AGE_SECONDS);
  assert.equal(justInTime.ok, true, 'exactly 48 hours is still good');

  const future = await verifyConfirmToken(token, SECRET, NOW - 60 * 60);
  assert.deepEqual(future, { ok: false, reason: 'confirm_invalid' }, 'a token from an hour in the future is refused');

  for (const junk of ['', 'nodot', '.', 'a.', '.b', 'a.b.c', 'x'.repeat(2000), null, undefined, 42]) {
    const result = await verifyConfirmToken(junk, SECRET, NOW);
    assert.equal(result.ok, false, `refused: ${String(junk).slice(0, 20)}`);
    assert.equal(result.reason, 'confirm_invalid');
  }

  const entitlementShaped = await signToken({ v: 3, typ: 'ent', sub: 'abc', iat: NOW, exp: NOW + 100, kid: 'k' }, SECRET);
  const crossed = await verifyConfirmToken(entitlementShaped, SECRET, NOW);
  assert.deepEqual(crossed, { ok: false, reason: 'confirm_invalid' }, 'an entitlement token is not a confirmation');

  assert.equal((await verifyConfirmToken(token, '', NOW)).ok, false, 'no secret, no verification');
});

test('resend: the confirmation email has one link, no images and the ignore line', () => {
  const link = 'https://helpmebreath.com/api/subscribe?confirm=abc.def';
  const email = buildConfirmEmail(link);
  assert.equal(email.subject, CONFIRM_SUBJECT);
  assert.equal(email.subject, 'Confirm your email for Help Me Breathe');
  assert.equal((email.html.match(/<a /g) || []).length, 1, 'exactly one link');
  assert.equal(email.html.includes('<img'), false, 'no images, no tracking pixel');
  assert.ok(email.html.includes(`href="${link}"`));
  assert.ok(email.text.includes(link));
  assert.match(email.text, /If you did not ask for this, ignore this email/);
  assert.match(email.html, /If you did not ask for this, ignore this email/);
  assert.match(email.text, /48 hours/);
  assert.doesNotMatch(email.html + email.text + email.subject, /resend/i, 'the mailing service is never named');
  assert.doesNotMatch(email.html + email.text, /[\u{1F300}-\u{1FAFF}]/u, 'no emoji');
});

test('resend: a signup sends one confirmation email and stores nothing', async () => {
  const fetchImpl = stubFetch(resendRoutes());
  const result = await resendProvider.subscribe(CONTACT, { env: RESEND_ENV, fetchImpl, nowSeconds: NOW });
  assert.deepEqual(result, { ok: true, status: 200 });

  assert.deepEqual(
    fetchImpl.calls.map((call) => `${call.method} ${call.path}`),
    ['POST /emails'],
    'exactly one request, and it is the email: no contact is created on a stranger\'s say-so',
  );
  const call = fetchImpl.calls[0];
  assert.equal(call.init.headers.Authorization, 'Bearer re_TESTFIXTURE0000');
  assert.equal(call.url.startsWith('https://mail.test/'), true, 'EMAIL_API_BASE is honoured');
  assert.equal(call.init.body.includes('re_TESTFIXTURE0000'), false, 'the key is never in a body');
  assert.ok(call.init.signal, 'every request carries a timeout signal');

  const sent = JSON.parse(call.init.body);
  assert.equal(sent.from, 'Help Me Breathe <hello@helpmebreath.com>');
  assert.deepEqual(sent.to, ['a@b.co']);
  assert.equal(sent.subject, 'Confirm your email for Help Me Breathe');
  assert.ok(sent.text.includes('https://helpmebreath.com/api/subscribe?confirm='));
  assert.ok(sent.html.includes('href="https://helpmebreath.com/api/subscribe?confirm='));

  const token = tokenFromSend(call);
  const verified = await verifyConfirmToken(token, SECRET, NOW);
  assert.equal(verified.ok, true, 'the link carries a token the same secret verifies');
  assert.deepEqual(verified.payload, { e: 'a@b.co', t: 'box', s: 'post-session', iat: NOW });
});

test('resend: a repeat signup costs exactly the same single request, so timing tells nobody who is on the list', async () => {
  const fetchImpl = stubFetch(resendRoutes());
  await resendProvider.subscribe(CONTACT, { env: RESEND_ENV, fetchImpl });
  await resendProvider.subscribe(CONTACT, { env: RESEND_ENV, fetchImpl });
  assert.deepEqual(
    fetchImpl.calls.map((call) => `${call.method} ${call.path}`),
    ['POST /emails', 'POST /emails'],
  );

  // "Already exists" answers are recognised for the confirmation step's race.
  assert.equal(isAlreadyAContact(409, {}), true);
  assert.equal(isAlreadyAContact(422, { message: 'Contact already exists' }), true);
  assert.equal(isAlreadyAContact(422, { message: 'Invalid email' }), false);
  assert.equal(isAlreadyAContact(500, { message: 'already exists' }), false);
});

test('resend: outages are provider_unavailable, a rejected address is invalid_email, a bad key is not_configured', async () => {
  const down = stubFetch(resendRoutes({ 'POST /emails': { status: 500, body: { name: 'application_error', message: 'An unexpected error occurred.' } } }));
  assert.deepEqual(await resendProvider.subscribe(CONTACT, { env: RESEND_ENV, fetchImpl: down }), {
    ok: false,
    reason: 'provider_unavailable',
    status: 500,
  });

  const quota = stubFetch(resendRoutes({ 'POST /emails': { status: 429, body: { name: 'daily_quota_exceeded', message: 'You have exceeded your daily email sending quota.' } } }));
  assert.equal((await resendProvider.subscribe(CONTACT, { env: RESEND_ENV, fetchImpl: quota })).reason, 'provider_unavailable');

  const offline = async () => {
    throw new Error('ECONNRESET');
  };
  assert.deepEqual(await resendProvider.subscribe(CONTACT, { env: RESEND_ENV, fetchImpl: offline }), {
    ok: false,
    reason: 'provider_unavailable',
  });

  const badAddress = stubFetch(
    resendRoutes({
      'POST /emails': {
        status: 422,
        body: { name: 'validation_error', message: 'Invalid \`to\` field. The email address needs to follow the \`email@example.com\` format.' },
      },
    }),
  );
  assert.deepEqual(await resendProvider.subscribe(CONTACT, { env: RESEND_ENV, fetchImpl: badAddress }), {
    ok: false,
    reason: 'invalid_email',
    status: 422,
  });

  const restrictedKey = stubFetch(resendRoutes({ 'POST /emails': { status: 401, body: { name: 'restricted_api_key', message: 'This API key is restricted to only send emails' } } }));
  assert.equal(
    (await resendProvider.subscribe(CONTACT, { env: RESEND_ENV, fetchImpl: restrictedKey })).reason,
    'not_configured',
    'a key problem is the owner\'s to fix, and is reported like a missing variable',
  );
  const unverifiedDomain = stubFetch(resendRoutes({ 'POST /emails': { status: 403, body: { name: 'validation_error', message: 'The helpmebreath.com domain is not verified.' } } }));
  assert.equal((await resendProvider.subscribe(CONTACT, { env: RESEND_ENV, fetchImpl: unverifiedDomain })).reason, 'not_configured');

  assert.equal((await resendProvider.subscribe({ email: 'not an address' }, { env: RESEND_ENV, fetchImpl: down })).reason, 'invalid_email');
  assert.equal(down.calls.length, 1, 'an invalid address never reaches the network');
});

test('resend: refuses to call out when it is not configured', async () => {
  for (const patch of [
    { EMAIL_LIST_ID: '' },
    { EMAIL_LIST_ID: '0' },
    { EMAIL_FROM: 'dev-missing-EMAIL_FROM' },
    { SITE_ORIGIN: 'dev-missing-SITE_ORIGIN' },
    { LICENSE_SECRET: '' },
  ]) {
    const fetchImpl = stubFetch(resendRoutes());
    const result = await resendProvider.subscribe(CONTACT, { env: { ...RESEND_ENV, ...patch }, fetchImpl });
    assert.deepEqual(result, { ok: false, reason: 'not_configured' }, JSON.stringify(patch));
    assert.equal(fetchImpl.calls.length, 0);
  }
  assert.deepEqual(resendProvider.requiredEnv, [
    'EMAIL_API_KEY',
    'EMAIL_LIST_ID',
    'EMAIL_FROM',
    'EMAIL_DOI_REDIRECT_URL',
    'SITE_ORIGIN',
    'LICENSE_SECRET',
  ]);
});

test('resend: confirm() flips the contact, adds it to the segment, creates it when new, and twice is fine', async () => {
  const token = await mintConfirmToken(CONTACT, SECRET, NOW);
  const fetchImpl = stubFetch(resendRoutes());

  const first = await resendConfirm(token, { env: RESEND_ENV, fetchImpl, nowSeconds: NOW + 3600 });
  assert.equal(first.ok, true);
  assert.equal(first.who, (await sha256Hex('a@b.co')).slice(0, 12), 'only the hash prefix comes back for the log');

  const second = await resendConfirm(token, { env: RESEND_ENV, fetchImpl, nowSeconds: NOW + 7200 });
  assert.equal(second.ok, true, 'idempotent');

  assert.deepEqual(
    fetchImpl.calls.map((call) => `${call.method} ${call.path}`),
    [`PATCH ${CONTACT_PATH}`, `POST ${SEGMENT_PATH}`, `PATCH ${CONTACT_PATH}`, `POST ${SEGMENT_PATH}`],
    'flip, then join the segment (PATCH has no segments field); an existing team-wide contact lands on our list',
  );
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { unsubscribed: false });
  assert.equal(fetchImpl.calls[1].init.body, undefined, 'the segment call has no body');
  for (const call of fetchImpl.calls) assert.equal(call.init.headers.Authorization, 'Bearer re_TESTFIXTURE0000');

  // New to the team: the click is the consent, so it is created subscribed, in the segment, in one call.
  const fresh = stubFetch(resendRoutes({ [`PATCH ${CONTACT_PATH}`]: { status: 404, body: { name: 'not_found', message: 'Contact not found' } } }));
  const created = await resendConfirm(token, { env: RESEND_ENV, fetchImpl: fresh, nowSeconds: NOW });
  assert.equal(created.ok, true);
  assert.deepEqual(fresh.calls.map((call) => `${call.method} ${call.path}`), [`PATCH ${CONTACT_PATH}`, 'POST /contacts']);
  assert.deepEqual(JSON.parse(fresh.calls[1].init.body), { email: 'a@b.co', unsubscribed: false, segments: [{ id: 'seg_TESTFIXTURE0000' }] });

  // Two confirmations racing: the loser's create says "exists" and it falls back to the flip.
  const raced = stubFetch(
    resendRoutes({
      [`PATCH ${CONTACT_PATH}`]: (() => {
        let n = 0;
        return () => (n++ === 0 ? { status: 404, body: {} } : { status: 200, body: { object: 'contact' } });
      })(),
      'POST /contacts': { status: 409, body: { name: 'resource_locked', message: 'Contact already exists' } },
    }),
  );
  assert.equal((await resendConfirm(token, { env: RESEND_ENV, fetchImpl: raced, nowSeconds: NOW })).ok, true);
  assert.deepEqual(
    raced.calls.map((call) => `${call.method} ${call.path}`),
    [`PATCH ${CONTACT_PATH}`, 'POST /contacts', `PATCH ${CONTACT_PATH}`, `POST ${SEGMENT_PATH}`],
  );

  const down = stubFetch(resendRoutes({ [`PATCH ${CONTACT_PATH}`]: { status: 500, body: {} } }));
  assert.equal((await resendConfirm(token, { env: RESEND_ENV, fetchImpl: down, nowSeconds: NOW })).reason, 'provider_unavailable');

  // inspect() is the read-only half: same verdicts, no network.
  const quiet = stubFetch(resendRoutes());
  const look = await resendProvider.inspect(token, { env: RESEND_ENV, fetchImpl: quiet, nowSeconds: NOW });
  assert.equal(look.ok, true);
  assert.equal(look.who, first.who);
  assert.equal((await resendProvider.inspect(token, { env: RESEND_ENV, fetchImpl: quiet, nowSeconds: NOW + 49 * 3600 })).reason, 'confirm_expired');
  assert.equal(quiet.calls.length, 0, 'inspect never calls out');
});

test('resend: confirm() refuses a bad or stale token before any network call', async () => {
  const token = await mintConfirmToken(CONTACT, SECRET, NOW);
  const fetchImpl = stubFetch(resendRoutes());

  assert.deepEqual(await resendConfirm('garbage', { env: RESEND_ENV, fetchImpl, nowSeconds: NOW }), { ok: false, reason: 'confirm_invalid' });
  assert.deepEqual(await resendConfirm(token, { env: RESEND_ENV, fetchImpl, nowSeconds: NOW + 49 * 3600 }), { ok: false, reason: 'confirm_expired' });
  assert.deepEqual(await resendConfirm(token, { env: { ...RESEND_ENV, LICENSE_SECRET: OTHER_SECRET }, fetchImpl, nowSeconds: NOW }), {
    ok: false,
    reason: 'confirm_invalid',
  });
  assert.equal(fetchImpl.calls.length, 0);

  for (const reason of ['confirm_invalid', 'confirm_expired']) {
    const sentence = messageForEmailReason(reason);
    assert.match(sentence, /sign up again/i);
    assert.doesNotMatch(sentence, /resend|brevo|mailerlite/i, 'provider-neutral');
  }
});

/* ------------------------------------------------- GET /api/subscribe?confirm */

const SUBSCRIBE_URL = 'https://helpmebreath.com/api/subscribe';

/** The environment a live Resend deployment would have, pointed at the stub host. */
const RESEND_PROCESS_ENV = Object.freeze({
  VERCEL_ENV: 'development',
  NODE_ENV: 'development',
  EMAIL_PROVIDER: 'resend',
  ...RESEND_ENV,
});

let ipCounter = 0;

/** A GET to the confirmation route from a fresh IP, so the per-IP limiter never bleeds between tests. */
function confirmRequest(token, options = {}) {
  ipCounter += 1;
  const query = token === undefined ? '' : `?confirm=${encodeURIComponent(token)}`;
  return new Request(`${SUBSCRIBE_URL}${query}`, {
    method: 'GET',
    headers: { 'x-real-ip': options.ip || `203.0.113.${ipCounter}`, 'x-forwarded-host': 'helpmebreath.com' },
  });
}

/** Run `fn` with the global fetch swapped for a stub; the handler has no deps hook and needs none. */
async function withFetch(fetchImpl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('GET /api/subscribe?confirm=<valid> shows a Confirm button and writes nothing', async () => {
  const token = await mintConfirmToken(CONTACT, SECRET, Math.floor(Date.now() / 1000));
  const fetchImpl = stubFetch(resendRoutes());

  const response = await withEnv(RESEND_PROCESS_ENV, () => withFetch(fetchImpl, () => subscribeGet(confirmRequest(token))));

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const body = await response.text();
  assert.match(body, /<form method="post" action="\/api\/subscribe">/);
  assert.ok(body.includes(`name="confirm" value="${token}"`), 'the button carries the same token back');
  assert.match(body, /Confirm my email/);
  assert.doesNotMatch(body, /a@b\.co/, 'the address is never on the page');
  assert.equal(fetchImpl.calls.length, 0, 'a GET is a look, not a click: a mail gateway fetching the link confirms nobody');
});

test('POST /api/subscribe with the Confirm form flips the contact and answers 302 to the env redirect', async () => {
  const token = await mintConfirmToken(CONTACT, SECRET, Math.floor(Date.now() / 1000));
  const fetchImpl = stubFetch(resendRoutes());
  const request = new Request(SUBSCRIBE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': '203.0.113.240', 'x-forwarded-host': 'helpmebreath.com' },
    body: new URLSearchParams({ confirm: token }).toString(),
  });

  const response = await withEnv(RESEND_PROCESS_ENV, () => withFetch(fetchImpl, () => subscribePost(request)));

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://helpmebreath.com/pro/thanks?confirmed=1');
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(await response.text(), '');
  assert.deepEqual(fetchImpl.calls.map((call) => `${call.method} ${call.path}`), [`PATCH ${CONTACT_PATH}`, `POST ${SEGMENT_PATH}`]);
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { unsubscribed: false });
  assert.equal(fetchImpl.calls[0].url, `https://mail.test${CONTACT_PATH}`);

  // A JSON body carrying { confirm } is the same click.
  const viaJson = stubFetch(resendRoutes());
  const jsonRequest = siteRequest({
    url: SUBSCRIBE_URL,
    method: 'POST',
    origin: 'https://helpmebreath.com',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.241' },
    body: JSON.stringify({ confirm: token }),
  });
  const second = await withEnv(RESEND_PROCESS_ENV, () => withFetch(viaJson, () => subscribePost(jsonRequest)));
  assert.equal(second.status, 302);

  // A bad token on the button gets the calm page, never the token back.
  const bad = stubFetch(resendRoutes());
  const badRequest = new Request(SUBSCRIBE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': '203.0.113.242', 'x-forwarded-host': 'helpmebreath.com' },
    body: new URLSearchParams({ confirm: 'eyJ0eXAiOiJkb2kifQ.TESTFIXTUREnotasignature0000000000000000000' }).toString(),
  });
  const refused = await withEnv(RESEND_PROCESS_ENV, () => withFetch(bad, () => subscribePost(badRequest)));
  assert.equal(refused.status, 400);
  assert.equal((await refused.text()).includes('TESTFIXTUREnotasignature'), false);
  assert.equal(bad.calls.length, 0);
});

test('GET /api/subscribe?confirm=<bad> answers a calm page that never echoes the token or names the service', async () => {
  const bad = 'eyJ0eXAiOiJkb2kifQ.TESTFIXTUREnotasignature0000000000000000000';
  const fetchImpl = stubFetch(resendRoutes());

  const response = await withEnv(RESEND_PROCESS_ENV, () => withFetch(fetchImpl, () => subscribeGet(confirmRequest(bad))));
  assert.equal(response.status, CONFIRM_PAGES.confirm_invalid.status);
  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex');
  const body = await response.text();
  assert.equal(body.includes(bad), false, 'the token is never echoed');
  assert.equal(body.includes('TESTFIXTURE'), false);
  assert.doesNotMatch(body, /resend|brevo|mailerlite/i);
  assert.match(body, /sign up again/i);
  assert.equal(fetchImpl.calls.length, 0, 'nothing reaches the mailing service');

  const stale = await mintConfirmToken(CONTACT, SECRET, Math.floor(Date.now() / 1000) - 49 * 3600);
  const expired = await withEnv(RESEND_PROCESS_ENV, () => withFetch(fetchImpl, () => subscribeGet(confirmRequest(stale))));
  assert.equal(expired.status, 410);
  const expiredBody = await expired.text();
  assert.match(expiredBody, /expired/i);
  assert.match(expiredBody, /48 hours/);
  assert.equal(expiredBody.includes(stale), false);
  assert.equal(expiredBody.includes('a@b.co'), false, 'the address is never echoed');

  const empty = await withEnv(RESEND_PROCESS_ENV, () => withFetch(fetchImpl, () => subscribeGet(confirmRequest(''))));
  assert.equal(empty.status, 400, 'an empty token is a bad token, not a 405');
});

test('POST the Confirm form when the mailing service is down keeps the link alive', async () => {
  const token = await mintConfirmToken(CONTACT, SECRET, Math.floor(Date.now() / 1000));
  const fetchImpl = stubFetch(resendRoutes({ [`PATCH ${CONTACT_PATH}`]: { status: 503, body: { name: 'service_unavailable' } } }));
  const request = new Request(SUBSCRIBE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': '203.0.113.243', 'x-forwarded-host': 'helpmebreath.com' },
    body: new URLSearchParams({ confirm: token }).toString(),
  });
  const response = await withEnv(RESEND_PROCESS_ENV, () => withFetch(fetchImpl, () => subscribePost(request)));
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.match(body, /open the link again/i);
  assert.equal(body.includes(token), false);
});

test('GET /api/subscribe without ?confirm stays 405, and so does ?confirm for an adapter without confirm()', async () => {
  const plain = await withEnv(RESEND_PROCESS_ENV, () => subscribeGet(confirmRequest(undefined)));
  assert.equal(plain.status, 405);
  assert.equal(plain.headers.get('allow'), 'POST, OPTIONS');

  const token = await mintConfirmToken(CONTACT, SECRET, Math.floor(Date.now() / 1000));
  const fetchImpl = stubFetch({});
  const brevo = await withEnv({ ...RESEND_PROCESS_ENV, EMAIL_PROVIDER: 'brevo' }, () =>
    withFetch(fetchImpl, () => subscribeGet(confirmRequest(token))),
  );
  assert.equal(brevo.status, 405, 'that adapter runs its own confirmation flow');
  assert.equal(fetchImpl.calls.length, 0);
});

test('GET /api/subscribe?confirm shares the per-IP limiter with the form', async () => {
  const token = await mintConfirmToken(CONTACT, SECRET, Math.floor(Date.now() / 1000));
  const fetchImpl = stubFetch(resendRoutes());
  const ip = '198.51.100.77';

  await withEnv(RESEND_PROCESS_ENV, () =>
    withFetch(fetchImpl, async () => {
      for (let i = 0; i < 5; i += 1) {
        const response = await subscribeGet(confirmRequest(token, { ip }));
        assert.equal(response.status, 200, `request ${i + 1} is within the limit`);
      }
      const sixth = await subscribeGet(confirmRequest(token, { ip }));
      assert.equal(sixth.status, 429);
      assert.equal(sixth.headers.get('retry-after') !== null, true);
      assert.match(sixth.headers.get('content-type'), /text\/html/);
    }),
  );
  assert.equal(fetchImpl.calls.length, 0, 'looking never reaches the mailing service');
});

test('subscribe: a preview deployment without a real LICENSE_SECRET mints nothing and confirms nobody', async () => {
  const previewEnv = { ...RESEND_PROCESS_ENV, VERCEL_ENV: 'preview', NODE_ENV: 'production', LICENSE_SECRET: undefined };
  const fetchImpl = stubFetch(resendRoutes());

  // The form: 503, and no email goes out.
  const signup = siteRequest({
    url: SUBSCRIBE_URL,
    method: 'POST',
    origin: 'https://helpmebreath.com',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.250' },
    body: JSON.stringify({ email: 'someone@example.com', consent: true }),
  });
  const refused = await withEnv(previewEnv, () => withFetch(fetchImpl, () => subscribePost(signup)));
  assert.equal(refused.status, 503);

  // A token signed with the public placeholder secret: the page says not set up, the button writes nothing.
  const forged = await mintConfirmToken({ email: 'victim@example.com' }, DEV_DEFAULTS.LICENSE_SECRET, Math.floor(Date.now() / 1000));
  const look = await withEnv(previewEnv, () => withFetch(fetchImpl, () => subscribeGet(confirmRequest(forged))));
  assert.equal(look.status, 503);
  const click = new Request(SUBSCRIBE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': '203.0.113.251', 'x-forwarded-host': 'helpmebreath.com' },
    body: new URLSearchParams({ confirm: forged }).toString(),
  });
  const pressed = await withEnv(previewEnv, () => withFetch(fetchImpl, () => subscribePost(click)));
  assert.equal(pressed.status, 503);
  assert.equal(fetchImpl.calls.length, 0, 'zero requests to the mailing service');

  // And the adapter itself refuses the placeholder even when it is passed explicitly.
  const withDevSecret = { ...RESEND_ENV, LICENSE_SECRET: DEV_DEFAULTS.LICENSE_SECRET };
  assert.equal((await resendProvider.subscribe(CONTACT, { env: withDevSecret, fetchImpl })).reason, 'not_configured');
  assert.equal((await resendConfirm(forged, { env: withDevSecret, fetchImpl })).reason, 'not_configured');
  assert.equal(fetchImpl.calls.length, 0);
});

test('resend token: the address inside a token is validated like a typed one, and iat must be a number', async () => {
  const sign = async (payload) => {
    const head = b64urlEncode(JSON.stringify(payload));
    return `${head}.${b64urlEncode(await hmacSha256(SECRET, head))}`;
  };
  const cases = [
    { typ: 'doi', e: 'a@b.co/../../emails?x=', t: null, s: null, iat: NOW },
    { typ: 'doi', e: 'A@B.CO', t: null, s: null, iat: NOW },
    { typ: 'doi', e: '\u212Aevin@example.com', t: null, s: null, iat: NOW },
    { typ: 'doi', e: 'a@b.co', t: null, s: null, iat: String(NOW) },
  ];
  for (const payload of cases) {
    const result = await verifyConfirmToken(await sign(payload), SECRET, NOW);
    assert.deepEqual(result, { ok: false, reason: 'confirm_invalid' }, JSON.stringify(payload));
  }
  const good = await verifyConfirmToken(await sign({ typ: 'doi', e: 'a@b.co', t: null, s: null, iat: NOW }), SECRET, NOW);
  assert.equal(good.ok, true);
});

test('subscribe: look-alike addresses are refused before case folding', () => {
  const kelvin = validateSubscribe({ email: '\u212Aevin@example.com', consent: true });
  assert.equal(kelvin.ok, false, 'the Kelvin sign would fold to a plain k');
  assert.equal(kelvin.field, 'email');
  const plain = validateSubscribe({ email: 'Kevin@Example.com', consent: true });
  assert.equal(plain.ok, true);
  assert.equal(plain.value.email, 'kevin@example.com');
});

test('POST /api/subscribe through the default adapter says the same sentence for a new and a repeat address', async () => {
  const body = JSON.stringify({ email: 'New.Person@Example.com', technique: 'box', source: 'post-session', consent: true });
  const request = () =>
    siteRequest({
      url: SUBSCRIBE_URL,
      method: 'POST',
      origin: 'https://helpmebreath.com',
      headers: { 'content-type': 'application/json', 'x-real-ip': '192.0.2.9' },
      body,
    });

  const fresh = stubFetch(resendRoutes());
  const first = await withEnv(RESEND_PROCESS_ENV, () => withFetch(fresh, () => subscribePost(request())));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, message: SUCCESS_MESSAGE });
  assert.deepEqual(fresh.calls.map((call) => `${call.method} ${call.path}`), ['POST /emails']);
  assert.deepEqual(JSON.parse(fresh.calls[0].init.body).to, ['new.person@example.com'], 'lower-cased before it leaves');

  const repeat = stubFetch(resendRoutes());
  const second = await withEnv(RESEND_PROCESS_ENV, () => withFetch(repeat, () => subscribePost(request())));
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { ok: true, message: SUCCESS_MESSAGE }, 'identical, so list membership never leaks');
  assert.deepEqual(repeat.calls.map((call) => `${call.method} ${call.path}`), ['POST /emails'], 'and identical work, so timing leaks nothing either');

  const down = stubFetch(resendRoutes({ 'POST /emails': { status: 500, body: {} } }));
  const third = await withEnv(RESEND_PROCESS_ENV, () => withFetch(down, () => subscribePost(request())));
  assert.equal(third.status, 502);
  const failure = await third.json();
  assert.equal(failure.ok, false);
  assert.doesNotMatch(failure.error, /resend/i);
});

/* Last on purpose: the shared sending budget is module state and this test spends it. */
test('POST /api/subscribe shares one sending budget across everyone', async () => {
  const fetchImpl = stubFetch(resendRoutes());
  let accepted = 0;
  let limited = null;
  await withEnv(RESEND_PROCESS_ENV, () =>
    withFetch(fetchImpl, async () => {
      for (let i = 0; i < 40 && !limited; i += 1) {
        const request = siteRequest({
          url: SUBSCRIBE_URL,
          method: 'POST',
          origin: 'https://helpmebreath.com',
          headers: { 'content-type': 'application/json', 'x-real-ip': `198.51.100.${100 + i}` },
          body: JSON.stringify({ email: `person${i}@example.com`, consent: true }),
        });
        const response = await subscribePost(request);
        if (response.status === 200) accepted += 1;
        else if (response.status === 429) limited = response;
        else assert.fail(`unexpected ${response.status}`);
      }
    }),
  );
  assert.ok(limited, 'the budget eventually says no');
  assert.ok(accepted <= 20, `no more than twenty emails an hour from everyone (sent ${accepted})`);
  assert.equal(limited.headers.get('retry-after') !== null, true);
  const sentence = (await limited.json()).error;
  assert.match(sentence, /try again in an hour/i);
  assert.equal(fetchImpl.calls.length, accepted, 'a refused request never reaches the mailing service');
});

test('POST /api/subscribe (JSON) from a foreign origin is refused before any work, like every other state-changing POST', async () => {
  const fetchImpl = stubFetch(resendRoutes());
  const foreign = siteRequest({
    url: SUBSCRIBE_URL,
    method: 'POST',
    origin: 'https://evil.example',
    headers: { 'content-type': 'text/plain', 'x-real-ip': '192.0.2.77' },
    body: JSON.stringify({ email: 'victim@example.com', consent: true }),
  });
  const response = await withEnv(RESEND_PROCESS_ENV, () => withFetch(fetchImpl, () => subscribePost(foreign)));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: 'cross_origin' });
  assert.equal(fetchImpl.calls.length, 0, 'no email is sent for a cross-site request');
  // No Origin header at all (a non-browser client) is refused the same way.
  const bare = new Request(SUBSCRIBE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '192.0.2.78', 'x-forwarded-host': 'helpmebreath.com' },
    body: JSON.stringify({ email: 'victim@example.com', consent: true }),
  });
  assert.equal((await withEnv(RESEND_PROCESS_ENV, () => withFetch(fetchImpl, () => subscribePost(bare)))).status, 403);
});
