/**
 * tools/supabase.test.mjs — api/_lib/supabase.js, authz.js and dblimit.js.
 *
 *   node --test tools/supabase.test.mjs
 *
 * Zero dependencies, no network, no env. Keys are generated locally with
 * WebCrypto, the JWKS document is served by a stubbed fetch, and every
 * PostgREST call is captured by the same stub. No real Supabase project is
 * ever contacted; every key and URL here is an obvious TESTFIXTURE.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { b64urlEncode } from '../api/_lib/crypto.js';
import {
  CLOCK_SKEW_SECONDS,
  JWKS_MIN_FORCED_REFRESH_MS,
  JWKS_TTL_MS,
  MAX_TOKEN_LIFETIME_SECONDS,
  SupabaseError,
  algorithmForJwk,
  assertLiveUser,
  buildFilters,
  checkClaims,
  db,
  decodeJwt,
  deleteWhere,
  describeSupabaseConfig,
  expectedIssuer,
  indexJwks,
  insertOne,
  jwksCacheInfo,
  quoteInValue,
  resetJwksCache,
  rpc,
  select,
  supabaseUrl,
  updateWhere,
  upsertOne,
  verifyAccessToken,
} from '../api/_lib/supabase.js';
import {
  authUnavailable,
  bearerToken,
  requireLiveUser,
  requireUser,
  stripClientAssertedIdentity,
  unauthorized,
} from '../api/_lib/authz.js';
import { dblimit, dblimitAll, dblimitCheck, ipBucket } from '../api/_lib/dblimit.js';

/* ------------------------------------------------------------------ fixtures */

const SUPABASE_URL = 'https://testfixture-project.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const SECRET_KEY = 'sb_secret_TESTFIXTURE_not_a_real_key_0000000000';
const PUBLISHABLE_KEY = 'sb_publishable_TESTFIXTURE_not_a_real_key_00';
const USER_ID = '7d1c4a2e-9b3f-4c5d-8e6f-0a1b2c3d4e5f';
const SESSION_ID = '0f9e8d7c-6b5a-4433-9221-100f0e0d0c0b';
const EC_KID = 'testfixture-ec-kid-1';
const RSA_KID = 'testfixture-rsa-kid-1';

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

/** @type {{ec:CryptoKeyPair, rsa:CryptoKeyPair, jwks:object}} */
let fixtures;

async function makeFixtures() {
  const ec = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rsa = await subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const ecJwk = await subtle.exportKey('jwk', ec.publicKey);
  const rsaJwk = await subtle.exportKey('jwk', rsa.publicKey);
  const jwks = {
    keys: [
      { kty: 'EC', crv: 'P-256', x: ecJwk.x, y: ecJwk.y, kid: EC_KID, alg: 'ES256', use: 'sig', key_ops: ['verify'] },
      { kty: 'RSA', n: rsaJwk.n, e: rsaJwk.e, kid: RSA_KID, alg: 'RS256', use: 'sig', key_ops: ['verify'] },
    ],
  };
  return { ec, rsa, jwks };
}

function nowSeconds(nowMs) {
  return Math.floor(nowMs / 1000);
}

const NOW_MS = Date.UTC(2026, 8, 11, 12, 0, 0);

function baseClaims(nowMs = NOW_MS, overrides = {}) {
  const iat = nowSeconds(nowMs) - 60;
  return {
    iss: ISSUER,
    sub: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'testfixture@example.com',
    session_id: SESSION_ID,
    is_anonymous: false,
    aal: 'aal1',
    iat,
    exp: iat + 3600,
    ...overrides,
  };
}

/**
 * Sign a JWT with the fixture keys. `alg` picks the signing algorithm; the
 * header `alg`/`kid` default to the truthful values but can be overridden to
 * build attack tokens.
 */
async function signJwt(claims, { alg = 'ES256', header = {} } = {}) {
  const head = { alg, typ: 'JWT', kid: alg === 'ES256' ? EC_KID : RSA_KID, ...header };
  const signingInput = `${b64urlEncode(JSON.stringify(head))}.${b64urlEncode(JSON.stringify(claims))}`;
  let signature;
  if (alg === 'ES256') {
    signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, fixtures.ec.privateKey, encoder.encode(signingInput));
  } else if (alg === 'RS256') {
    signature = await subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, fixtures.rsa.privateKey, encoder.encode(signingInput));
  } else if (alg === 'HS256') {
    const key = await subtle.importKey('raw', encoder.encode('testfixture-hs256-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    signature = await subtle.sign('HMAC', key, encoder.encode(signingInput));
  } else {
    throw new Error(`unsupported test alg ${alg}`);
  }
  return `${signingInput}.${b64urlEncode(new Uint8Array(signature))}`;
}

/** A fetch stub that serves the JWKS and records every call. */
function jwksFetch(document = fixtures.jwks, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (status !== 200) return new Response('nope', { status });
    return new Response(JSON.stringify(document), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function verifyOptions(fetchImpl, extra = {}) {
  return { supabaseUrl: SUPABASE_URL, fetchImpl, now: NOW_MS, ...extra };
}

/** A SubtleCrypto proxy that counts importKey calls and otherwise delegates. */
function spySubtle() {
  const counts = { importKey: 0, verify: 0 };
  const proxy = {
    importKey: (...args) => {
      counts.importKey += 1;
      return subtle.importKey(...args);
    },
    verify: (...args) => {
      counts.verify += 1;
      return subtle.verify(...args);
    },
  };
  proxy.counts = counts;
  return proxy;
}

/** A fetch stub for PostgREST / auth calls with a scripted responder. */
function restFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url: String(url), init, method: init && init.method ? init.method : 'GET' };
    call.headers = Object.fromEntries(Object.entries((init && init.headers) || {}).map(([k, v]) => [k.toLowerCase(), v]));
    call.body = init && init.body ? JSON.parse(init.body) : undefined;
    calls.push(call);
    const out = await responder(call);
    if (out instanceof Response) return out;
    const { status = 200, body = null } = out || {};
    return new Response(body === null ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const CTX = { url: SUPABASE_URL, secretKey: SECRET_KEY };

test.before(async () => {
  fixtures = await makeFixtures();
});

test.beforeEach(() => {
  resetJwksCache();
});

/* ---------------------------------------------------------- env helpers */

test('supabaseUrl strips a trailing slash and expectedIssuer appends /auth/v1', () => {
  assert.equal(supabaseUrl({ supabaseUrl: `${SUPABASE_URL}/` }), SUPABASE_URL);
  assert.equal(expectedIssuer({ supabaseUrl: SUPABASE_URL }), ISSUER);
});

test('describeSupabaseConfig reports booleans only', () => {
  const info = describeSupabaseConfig();
  assert.deepEqual(Object.keys(info).sort(), ['publishable_key', 'secret_key', 'url']);
  for (const value of Object.values(info)) assert.equal(typeof value, 'boolean');
});

/* ------------------------------------------------------------ decodeJwt */

test('decodeJwt rejects missing, oversized and non-three-part tokens', () => {
  assert.equal(decodeJwt('').reason, 'missing');
  assert.equal(decodeJwt(undefined).reason, 'missing');
  assert.equal(decodeJwt('a.b').reason, 'malformed');
  assert.equal(decodeJwt('a..c').reason, 'malformed');
  assert.equal(decodeJwt('x'.repeat(9000)).reason, 'malformed');
  assert.equal(decodeJwt('!!!.###.$$$').reason, 'malformed');
  const arrayHeader = `${b64urlEncode('[1]')}.${b64urlEncode('{}')}.${b64urlEncode('sig')}`;
  assert.equal(decodeJwt(arrayHeader).reason, 'bad_header');
  const arrayPayload = `${b64urlEncode('{}')}.${b64urlEncode('[1]')}.${b64urlEncode('sig')}`;
  assert.equal(decodeJwt(arrayPayload).reason, 'bad_payload');
});

/* --------------------------------------------------------- JWK indexing */

test('algorithmForJwk derives the algorithm from the key, not from anything else', () => {
  assert.equal(algorithmForJwk(fixtures.jwks.keys[0]), 'ES256');
  assert.equal(algorithmForJwk(fixtures.jwks.keys[1]), 'RS256');
  assert.equal(algorithmForJwk({ kty: 'oct', k: 'AAAA' }), 'HS256');
  assert.equal(algorithmForJwk({ kty: 'EC', crv: 'P-384', x: 'a', y: 'b' }), null);
  // A JWK that claims a different alg than its own key type is unusable.
  assert.equal(algorithmForJwk({ ...fixtures.jwks.keys[0], alg: 'RS256' }), null);
  assert.equal(algorithmForJwk({ ...fixtures.jwks.keys[0], use: 'enc' }), null);
  assert.equal(algorithmForJwk(null), null);
});

test('indexJwks drops symmetric and malformed keys and logs the symmetric case once', () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const map = indexJwks({
      keys: [
        ...fixtures.jwks.keys,
        { kty: 'oct', k: 'AAAA', kid: 'sym-1' },
        { kty: 'oct', k: 'BBBB', kid: 'sym-2' },
        { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, // no kid
        'garbage',
      ],
    });
    assert.deepEqual(Array.from(map.keys()), [EC_KID, RSA_KID]);
    assert.equal(map.get(EC_KID).alg, 'ES256');
    assert.equal(map.get(RSA_KID).alg, 'RS256');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /symmetric JWT signing keys/);
  } finally {
    console.error = original;
  }
  assert.equal(indexJwks(null).size, 0);
  assert.equal(indexJwks({ keys: 'no' }).size, 0);
});

/* ---------------------------------------------------- verifyAccessToken */

test('a genuine ES256 token verifies and returns sub, email and claims', async () => {
  const fetchImpl = jwksFetch();
  const jwt = await signJwt(baseClaims());
  const result = await verifyAccessToken(jwt, verifyOptions(fetchImpl));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.sub, USER_ID);
  assert.equal(result.email, 'testfixture@example.com');
  assert.equal(result.claims.session_id, SESSION_ID);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
});

test('a genuine RS256 token verifies against the RSA key', async () => {
  const jwt = await signJwt(baseClaims(), { alg: 'RS256' });
  const result = await verifyAccessToken(jwt, verifyOptions(jwksFetch()));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.sub, USER_ID);
});

test('RS256 header against the EC key is rejected as alg_mismatch BEFORE importKey', async () => {
  // Attack: a token whose header names RS256 but points `kid` at the EC key.
  // The signature is irrelevant — the point is that no key import and no
  // verify call ever happens, because the algorithm is taken from the JWK.
  const spy = spySubtle();
  const jwt = await signJwt(baseClaims(), { alg: 'ES256', header: { alg: 'RS256', kid: EC_KID } });
  const result = await verifyAccessToken(jwt, verifyOptions(jwksFetch(), { subtle: spy }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'alg_mismatch');
  assert.equal(spy.counts.importKey, 0, 'importKey must not be called');
  assert.equal(spy.counts.verify, 0, 'verify must not be called');
});

test('ES256 header against the RSA key is rejected as alg_mismatch before importKey', async () => {
  const spy = spySubtle();
  const jwt = await signJwt(baseClaims(), { alg: 'RS256', header: { alg: 'ES256', kid: RSA_KID } });
  const result = await verifyAccessToken(jwt, verifyOptions(jwksFetch(), { subtle: spy }));
  assert.equal(result.reason, 'alg_mismatch');
  assert.equal(spy.counts.importKey, 0);
});

test('HS256 is refused outright, without fetching the JWKS, and logged', async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let result;
  const fetchImpl = jwksFetch();
  try {
    const jwt = await signJwt(baseClaims(), { alg: 'HS256', header: { kid: EC_KID } });
    result = await verifyAccessToken(jwt, verifyOptions(fetchImpl));
  } finally {
    console.error = original;
  }
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported_alg');
  assert.equal(fetchImpl.calls.length, 0, 'no JWKS fetch for a symmetric token');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /switch to asymmetric/);
});

test('alg "none" and unknown algorithms are refused', async () => {
  for (const alg of ['none', 'HS512', 'PS256', 'ES384', 'EdDSA']) {
    const jwt = await signJwt(baseClaims(), { alg: 'ES256', header: { alg, kid: EC_KID } });
    const result = await verifyAccessToken(jwt, verifyOptions(jwksFetch()));
    assert.equal(result.reason, 'unsupported_alg', alg);
  }
});

test('a JWKS carrying only a symmetric key can never verify anything', async () => {
  const jwt = await signJwt(baseClaims(), { alg: 'ES256', header: { kid: 'sym-1' } });
  const original = console.error;
  console.error = () => {};
  let result;
  try {
    result = await verifyAccessToken(jwt, verifyOptions(jwksFetch({ keys: [{ kty: 'oct', k: 'AAAA', kid: 'sym-1', alg: 'HS256' }] })));
  } finally {
    console.error = original;
  }
  assert.equal(result.reason, 'unknown_kid');
});

test('header without kid, with a non-JWT typ, or with crit is rejected', async () => {
  const noKid = await signJwt(baseClaims(), { header: { kid: undefined } });
  assert.equal((await verifyAccessToken(noKid, verifyOptions(jwksFetch()))).reason, 'bad_header');
  const badTyp = await signJwt(baseClaims(), { header: { typ: 'JWE' } });
  assert.equal((await verifyAccessToken(badTyp, verifyOptions(jwksFetch()))).reason, 'bad_header');
  const crit = await signJwt(baseClaims(), { header: { crit: ['exp'] } });
  assert.equal((await verifyAccessToken(crit, verifyOptions(jwksFetch()))).reason, 'bad_header');
  const lowerTyp = await signJwt(baseClaims(), { header: { typ: 'jwt' } });
  assert.equal((await verifyAccessToken(lowerTyp, verifyOptions(jwksFetch()))).ok, true);
});

test('a tampered payload fails the signature', async () => {
  const jwt = await signJwt(baseClaims());
  const [head, , sig] = jwt.split('.');
  const forged = `${head}.${b64urlEncode(JSON.stringify(baseClaims(NOW_MS, { sub: '00000000-0000-4000-8000-000000000000' })))}.${sig}`;
  const result = await verifyAccessToken(forged, verifyOptions(jwksFetch()));
  assert.equal(result.reason, 'bad_signature');
});

test('a signature by a different EC key fails', async () => {
  const other = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const head = { alg: 'ES256', typ: 'JWT', kid: EC_KID };
  const signingInput = `${b64urlEncode(JSON.stringify(head))}.${b64urlEncode(JSON.stringify(baseClaims()))}`;
  const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, other.privateKey, encoder.encode(signingInput));
  const jwt = `${signingInput}.${b64urlEncode(new Uint8Array(signature))}`;
  assert.equal((await verifyAccessToken(jwt, verifyOptions(jwksFetch()))).reason, 'bad_signature');
});

test('a truncated ES256 signature is rejected without calling verify', async () => {
  const spy = spySubtle();
  const jwt = await signJwt(baseClaims());
  const [head, body, sig] = jwt.split('.');
  const result = await verifyAccessToken(`${head}.${body}.${sig.slice(0, 20)}`, verifyOptions(jwksFetch(), { subtle: spy }));
  assert.equal(result.reason, 'bad_signature');
  assert.equal(spy.counts.verify, 0);
});

test('claim checks: expiry with 30 s skew', async () => {
  const fetchImpl = jwksFetch();
  const now = nowSeconds(NOW_MS);
  const justExpired = await signJwt(baseClaims(NOW_MS, { iat: now - 3600, exp: now - 10 }));
  assert.equal((await verifyAccessToken(justExpired, verifyOptions(fetchImpl))).ok, true, 'inside skew');
  const expired = await signJwt(baseClaims(NOW_MS, { iat: now - 3600, exp: now - CLOCK_SKEW_SECONDS }));
  assert.equal((await verifyAccessToken(expired, verifyOptions(fetchImpl))).reason, 'expired');
});

test('claim checks: exp - iat must not exceed 7200 seconds', async () => {
  const now = nowSeconds(NOW_MS);
  const ok = await signJwt(baseClaims(NOW_MS, { iat: now - 10, exp: now - 10 + MAX_TOKEN_LIFETIME_SECONDS }));
  assert.equal((await verifyAccessToken(ok, verifyOptions(jwksFetch()))).ok, true);
  const forgedLifetime = await signJwt(baseClaims(NOW_MS, { iat: now - 10, exp: now - 10 + MAX_TOKEN_LIFETIME_SECONDS + 1 }));
  assert.equal((await verifyAccessToken(forgedLifetime, verifyOptions(jwksFetch()))).reason, 'lifetime_too_long');
  const noIat = await signJwt(baseClaims(NOW_MS, { iat: undefined }));
  assert.equal((await verifyAccessToken(noIat, verifyOptions(jwksFetch()))).reason, 'bad_payload');
});

test('claim checks: iss, aud, role, session_id, sub, is_anonymous, iat, nbf', async () => {
  const fetchImpl = jwksFetch();
  const now = nowSeconds(NOW_MS);
  const cases = [
    [{ iss: 'https://other-project.supabase.co/auth/v1' }, 'bad_issuer'],
    [{ iss: `${SUPABASE_URL}/auth/v1/` }, 'bad_issuer'],
    [{ aud: 'anon' }, 'bad_audience'],
    [{ aud: ['anon'] }, 'bad_audience'],
    [{ aud: [] }, 'bad_audience'],
    [{ role: 'service_role' }, 'bad_role'],
    [{ role: 'anon' }, 'bad_role'],
    [{ session_id: undefined }, 'missing_session'],
    [{ session_id: '' }, 'missing_session'],
    [{ sub: 'not-a-uuid' }, 'bad_subject'],
    [{ sub: undefined }, 'bad_subject'],
    [{ is_anonymous: true }, 'anonymous'],
    [{ iat: now + 120, exp: now + 3600 }, 'issued_in_future'],
    [{ nbf: now + 120 }, 'not_yet_valid'],
    [{ exp: 'soon' }, 'bad_payload'],
  ];
  for (const [overrides, reason] of cases) {
    const jwt = await signJwt(baseClaims(NOW_MS, overrides));
    const result = await verifyAccessToken(jwt, verifyOptions(fetchImpl));
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.equal(result.reason, reason, JSON.stringify(overrides));
  }
  const arrayAud = await signJwt(baseClaims(NOW_MS, { aud: ['authenticated'] }));
  assert.equal((await verifyAccessToken(arrayAud, verifyOptions(fetchImpl))).ok, true);
  const nbfOk = await signJwt(baseClaims(NOW_MS, { nbf: now - 60 }));
  assert.equal((await verifyAccessToken(nbfOk, verifyOptions(fetchImpl))).ok, true);
});

test('checkClaims is pure and usable without keys', () => {
  const now = nowSeconds(NOW_MS);
  assert.equal(checkClaims(baseClaims(NOW_MS), { nowSeconds: now, issuer: ISSUER }).ok, true);
  assert.equal(checkClaims(baseClaims(NOW_MS, { exp: now - 3600, iat: now - 7200 }), { nowSeconds: now, issuer: ISSUER }).reason, 'expired');
  const inverted = checkClaims(baseClaims(NOW_MS, { iat: now, exp: now - 1 }), { nowSeconds: now, issuer: ISSUER });
  assert.equal(inverted.ok, false);
});

test('NumericDate claims must be JSON numbers, never strings', async () => {
  const fetchImpl = jwksFetch();
  const now = nowSeconds(NOW_MS);
  for (const overrides of [{ exp: String(now + 3600) }, { iat: String(now - 60) }, { nbf: String(now - 60) }, { exp: true }, { nbf: null }]) {
    const jwt = await signJwt(baseClaims(NOW_MS, overrides));
    const result = await verifyAccessToken(jwt, verifyOptions(fetchImpl));
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.equal(result.reason, 'bad_payload', JSON.stringify(overrides));
  }
});

test('a missing email claim yields an empty string, never undefined', async () => {
  const jwt = await signJwt(baseClaims(NOW_MS, { email: undefined }));
  const result = await verifyAccessToken(jwt, verifyOptions(jwksFetch()));
  assert.equal(result.ok, true);
  assert.equal(result.email, '');
});

/* ------------------------------------------------------------ JWKS cache */

test('the JWKS is fetched once and reused for 10 minutes', async () => {
  const fetchImpl = jwksFetch();
  const jwt = await signJwt(baseClaims());
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await verifyAccessToken(jwt, verifyOptions(fetchImpl))).ok, true);
  }
  assert.equal(fetchImpl.calls.length, 1);
  const info = jwksCacheInfo();
  assert.equal(info.cached, true);
  assert.deepEqual(info.kids, [EC_KID, RSA_KID]);

  // Still inside the TTL: no refetch.
  const later = NOW_MS + JWKS_TTL_MS - 1000;
  const jwtLater = await signJwt(baseClaims(later));
  assert.equal((await verifyAccessToken(jwtLater, verifyOptions(fetchImpl, { now: later }))).ok, true);
  assert.equal(fetchImpl.calls.length, 1);

  // Past the TTL: exactly one refetch.
  const expired = NOW_MS + JWKS_TTL_MS + 1000;
  const jwtExpired = await signJwt(baseClaims(expired));
  assert.equal((await verifyAccessToken(jwtExpired, verifyOptions(fetchImpl, { now: expired }))).ok, true);
  assert.equal(fetchImpl.calls.length, 2);
});

test('concurrent verifications share one in-flight JWKS fetch', async () => {
  const fetchImpl = jwksFetch();
  const jwt = await signJwt(baseClaims());
  const results = await Promise.all(Array.from({ length: 8 }, () => verifyAccessToken(jwt, verifyOptions(fetchImpl))));
  assert.ok(results.every((r) => r.ok));
  assert.equal(fetchImpl.calls.length, 1);
});

test('a kid miss forces exactly one refresh, then fails — never loops', async () => {
  const fetchImpl = jwksFetch();
  // Warm the cache well before the miss so the forced-refresh guard does not apply.
  const warm = await signJwt(baseClaims(NOW_MS));
  assert.equal((await verifyAccessToken(warm, verifyOptions(fetchImpl))).ok, true);
  assert.equal(fetchImpl.calls.length, 1);

  const later = NOW_MS + JWKS_MIN_FORCED_REFRESH_MS + 1000;
  const unknown = await signJwt(baseClaims(later), { header: { kid: 'testfixture-rotated-kid' } });
  const result = await verifyAccessToken(unknown, verifyOptions(fetchImpl, { now: later }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown_kid');
  assert.equal(fetchImpl.calls.length, 2, 'one forced refresh, no more');

  // A second unknown-kid token straight afterwards does not refetch again (guard).
  const again = await verifyAccessToken(unknown, verifyOptions(fetchImpl, { now: later + 1000 }));
  assert.equal(again.reason, 'unknown_kid');
  assert.equal(fetchImpl.calls.length, 2);
});

test('a kid miss that the refresh resolves (real rotation) succeeds', async () => {
  let document = { keys: [fixtures.jwks.keys[1]] }; // only the RSA key at first
  const fetchImpl = jwksFetch();
  const rotating = async (url, init) => {
    fetchImpl.calls.push({ url, init });
    return new Response(JSON.stringify(document), { status: 200 });
  };
  const rsaJwt = await signJwt(baseClaims(), { alg: 'RS256' });
  assert.equal((await verifyAccessToken(rsaJwt, verifyOptions(rotating))).ok, true);
  assert.equal(fetchImpl.calls.length, 1);

  document = fixtures.jwks; // the EC key is published
  const later = NOW_MS + JWKS_MIN_FORCED_REFRESH_MS + 1000;
  const ecJwt = await signJwt(baseClaims(later));
  const result = await verifyAccessToken(ecJwt, verifyOptions(rotating, { now: later }));
  assert.equal(result.ok, true, result.reason);
  assert.equal(fetchImpl.calls.length, 2);
});

test('a JWKS fetch failure is jwks_unavailable on a cold cache and falls back to stale keys on a warm one', async () => {
  const jwt = await signJwt(baseClaims());
  const failing = jwksFetch(fixtures.jwks, { status: 503 });
  const cold = await verifyAccessToken(jwt, verifyOptions(failing));
  assert.equal(cold.reason, 'jwks_unavailable');
  // The cold failure attempts the fetch at most twice (initial + forced), never more.
  assert.ok(failing.calls.length <= 2, `fetched ${failing.calls.length} times`);

  resetJwksCache();
  const good = jwksFetch();
  assert.equal((await verifyAccessToken(jwt, verifyOptions(good))).ok, true);
  const throwing = async () => {
    throw new Error('network down');
  };
  const later = NOW_MS + JWKS_TTL_MS + 1000;
  const stale = await verifyAccessToken(await signJwt(baseClaims(later)), verifyOptions(throwing, { now: later }));
  assert.equal(stale.ok, true, 'stale public keys still verify');
});

test('an imported CryptoKey is cached per kid, so importKey runs once', async () => {
  const spy = spySubtle();
  const jwt = await signJwt(baseClaims());
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await verifyAccessToken(jwt, verifyOptions(jwksFetch(), { subtle: spy }))).ok, true);
  }
  assert.equal(spy.counts.importKey, 1);
  assert.equal(spy.counts.verify, 3);
});

test('during an outage past the TTL, stale keys are served and the fetch is retried at most once per 30 s', async () => {
  const good = jwksFetch();
  const jwt = await signJwt(baseClaims());
  assert.equal((await verifyAccessToken(jwt, verifyOptions(good))).ok, true);

  const failing = jwksFetch(fixtures.jwks, { status: 503 });
  const t1 = NOW_MS + JWKS_TTL_MS + 1000;
  const later = await signJwt(baseClaims(t1));
  assert.equal((await verifyAccessToken(later, verifyOptions(failing, { now: t1 }))).ok, true, 'stale keys still verify');
  assert.equal(failing.calls.length, 1);
  // The next requests inside the guard window do not wait on a fetch at all.
  for (let i = 1; i <= 3; i += 1) {
    assert.equal((await verifyAccessToken(later, verifyOptions(failing, { now: t1 + i * 1000 }))).ok, true);
  }
  assert.equal(failing.calls.length, 1, 'no refetch inside the guard window');
  // Past the guard window: one more attempt.
  const t2 = t1 + JWKS_MIN_FORCED_REFRESH_MS + 1000;
  assert.equal((await verifyAccessToken(await signJwt(baseClaims(t2)), verifyOptions(failing, { now: t2 }))).ok, true);
  assert.equal(failing.calls.length, 2);
});

test('a cold-cache outage fails fast inside the guard window instead of refetching on every request', async () => {
  const failing = jwksFetch(fixtures.jwks, { status: 503 });
  const jwt = await signJwt(baseClaims());
  assert.equal((await verifyAccessToken(jwt, verifyOptions(failing))).reason, 'jwks_unavailable');
  const attempts = failing.calls.length;
  assert.ok(attempts >= 1 && attempts <= 2);
  for (let i = 1; i <= 3; i += 1) {
    assert.equal((await verifyAccessToken(jwt, verifyOptions(failing, { now: NOW_MS + i * 1000 }))).reason, 'jwks_unavailable');
  }
  assert.equal(failing.calls.length, attempts, 'no new fetch inside the guard window');
  // Past the window, Supabase is back: the next request fetches and verifies.
  const t2 = NOW_MS + JWKS_MIN_FORCED_REFRESH_MS + 1000;
  const good = jwksFetch();
  assert.equal((await verifyAccessToken(await signJwt(baseClaims(t2)), verifyOptions(good, { now: t2 }))).ok, true);
  assert.equal(good.calls.length, 1);
});

test('a JWK that omits alg and use is still usable; the algorithm comes from kty/crv', async () => {
  const bare = { keys: fixtures.jwks.keys.map(({ alg, use, key_ops, ...rest }) => rest) };
  assert.equal(algorithmForJwk(bare.keys[0]), 'ES256');
  assert.equal(algorithmForJwk(bare.keys[1]), 'RS256');
  assert.equal((await verifyAccessToken(await signJwt(baseClaims()), verifyOptions(jwksFetch(bare)))).ok, true);
  resetJwksCache();
  assert.equal((await verifyAccessToken(await signJwt(baseClaims(), { alg: 'RS256' }), verifyOptions(jwksFetch(bare)))).ok, true);
  resetJwksCache();
  // And the header still has to agree with the key even when the JWK carries no alg of its own.
  const spy = spySubtle();
  const cross = await signJwt(baseClaims(), { alg: 'ES256', header: { alg: 'RS256', kid: EC_KID } });
  const result = await verifyAccessToken(cross, verifyOptions(jwksFetch(bare), { subtle: spy }));
  assert.equal(result.reason, 'alg_mismatch');
  assert.equal(spy.counts.importKey, 0);
});

/* ---------------------------------------------------------------- db() */

test('db() sends the secret key in apikey and Authorization and parses JSON', async () => {
  const fetchImpl = restFetch(() => ({ status: 200, body: [{ id: 1 }] }));
  const rows = await db('subscriptions', { query: { select: 'id', user_id: `eq.${USER_ID}` }, ctx: { ...CTX, fetchImpl } });
  assert.deepEqual(rows, [{ id: 1 }]);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, `${SUPABASE_URL}/rest/v1/subscriptions?select=id&user_id=eq.${USER_ID}`);
  assert.equal(call.method, 'GET');
  assert.equal(call.headers.apikey, SECRET_KEY);
  assert.equal(call.headers.authorization, `Bearer ${SECRET_KEY}`);
  assert.equal(call.headers.accept, 'application/json');
  assert.equal(call.headers['content-type'], undefined);
});

test('db() throws SupabaseError on a non-2xx answer and never includes the key', async () => {
  const fetchImpl = restFetch(() => ({ status: 409, body: { code: '23505', message: 'duplicate key', hint: null } }));
  await assert.rejects(
    () => db('profiles', { method: 'POST', body: { id: USER_ID }, ctx: { ...CTX, fetchImpl } }),
    (error) => {
      assert.ok(error instanceof SupabaseError);
      assert.equal(error.status, 409);
      assert.equal(error.code, '23505');
      assert.equal(error.details, 'duplicate key');
      assert.equal(error.statusCode, 503);
      assert.ok(!error.message.includes(SECRET_KEY));
      assert.ok(!JSON.stringify(error).includes(SECRET_KEY));
      return true;
    },
  );
});

test('db() maps a network failure to SupabaseError reason network', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    () => db('profiles', { ctx: { ...CTX, fetchImpl } }),
    (error) => error instanceof SupabaseError && error.reason === 'network' && error.status === 0,
  );
});

test('db() returns null for an empty body and refuses bad paths', async () => {
  const fetchImpl = restFetch(() => new Response(null, { status: 204 }));
  assert.equal(await db('rate_limits', { method: 'DELETE', query: { window_start: 'lt.2026-01-01' }, ctx: { ...CTX, fetchImpl } }), null);
  await assert.rejects(() => db('../auth/v1/admin', { ctx: CTX }), TypeError);
  await assert.rejects(() => db('', { ctx: CTX }), TypeError);
});

test('db() accepts a ready-made query string in the path, as every store module passes one', async () => {
  const fetchImpl = restFetch(() => ({ status: 200, body: [{ id: 'a' }] }));
  const rows = await db(`subscriptions?user_id=eq.${USER_ID}&select=*&order=created_at.asc`, { ctx: { ...CTX, fetchImpl } });
  assert.deepEqual(rows, [{ id: 'a' }]);
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.pathname, '/rest/v1/subscriptions');
  assert.equal(url.searchParams.get('user_id'), `eq.${USER_ID}`);
  assert.equal(url.searchParams.get('order'), 'created_at.asc');

  // `..` inside a filter value is data, not traversal.
  await db('profiles?display_name=like.*..*', { ctx: { ...CTX, fetchImpl } });
  assert.equal(new URL(fetchImpl.calls[1].url).pathname, '/rest/v1/profiles');

  // Traversal in the path part is refused in every spelling the URL parser folds.
  for (const bad of ['rpc/../auth/v1/admin', 'rpc/%2e%2e/auth', 'rpc/%2E%2E/auth', './profiles', 'a/./b']) {
    await assert.rejects(() => db(bad, { ctx: { ...CTX, fetchImpl } }), TypeError, bad);
  }
  assert.equal(fetchImpl.calls.length, 2, 'no request left the process for a refused path');
});

test('db() folds a caller Prefer header and the prefer option into one header and never lets headers override the key', async () => {
  const fetchImpl = restFetch(() => ({ status: 201, body: [{ ok: 1 }] }));
  await db('devices', {
    method: 'POST',
    body: { device_id: USER_ID },
    headers: { Prefer: 'return=representation', APIKEY: 'attacker', Authorization: 'Bearer attacker' },
    prefer: 'return=representation',
    ctx: { ...CTX, fetchImpl },
  });
  const sent = fetchImpl.calls[0].init.headers;
  const names = Object.keys(sent).map((n) => n.toLowerCase());
  assert.equal(names.filter((n) => n === 'prefer').length, 1, 'exactly one Prefer header');
  assert.equal(sent.prefer, 'return=representation');
  assert.equal(new Headers(sent).get('prefer'), 'return=representation', 'not doubled by the Headers constructor');
  assert.equal(sent.apikey, SECRET_KEY);
  assert.equal(sent.authorization, `Bearer ${SECRET_KEY}`);
  assert.equal(names.filter((n) => n === 'apikey').length, 1);
});

test('buildFilters requires explicit operators and handles null, tuples and primitives', () => {
  assert.deepEqual(
    buildFilters({ user_id: ['eq', USER_ID], cancel_at: null, live: true, attempts: 3, status: 'in.("active","trialing")' }),
    { user_id: `eq.${USER_ID}`, cancel_at: 'is.null', live: 'eq.true', attempts: 'eq.3', status: 'in.("active","trialing")' },
  );
  assert.throws(() => buildFilters({ email: 'person@example.com' }), /operator prefix/);
  assert.throws(() => buildFilters({ 'bad column': ['eq', 1] }), /bad column/);
  assert.throws(() => buildFilters({ x: ['eq'] }), /\[operator, value\]/);
  assert.throws(() => buildFilters({ x: { eq: 1 } }), /unsupported/);
  assert.deepEqual(buildFilters(undefined), {});
  assert.equal(quoteInValue('a,b.c'), '"a,b.c"');
  assert.equal(quoteInValue('say "hi"'), '"say \\"hi\\""');
});

test('select() builds the query, honours single, order and limit', async () => {
  const fetchImpl = restFetch(() => ({ status: 200, body: [{ id: 'a' }, { id: 'b' }] }));
  const rows = await select('subscriptions', {
    columns: 'id,access_until',
    filters: { user_id: ['eq', USER_ID] },
    order: 'access_until.desc',
    limit: 5,
    ctx: { ...CTX, fetchImpl },
  });
  assert.equal(rows.length, 2);
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.pathname, '/rest/v1/subscriptions');
  assert.equal(url.searchParams.get('select'), 'id,access_until');
  assert.equal(url.searchParams.get('user_id'), `eq.${USER_ID}`);
  assert.equal(url.searchParams.get('order'), 'access_until.desc');
  assert.equal(url.searchParams.get('limit'), '5');

  const one = await select('profiles', { filters: { id: ['eq', USER_ID] }, single: true, ctx: { ...CTX, fetchImpl } });
  assert.deepEqual(one, { id: 'a' });
  assert.equal(new URL(fetchImpl.calls[1].url).searchParams.get('limit'), '1');

  const empty = restFetch(() => ({ status: 200, body: [] }));
  assert.equal(await select('profiles', { filters: { id: ['eq', USER_ID] }, single: true, ctx: { ...CTX, fetchImpl: empty } }), null);
  assert.deepEqual(await select('profiles', { ctx: { ...CTX, fetchImpl: empty } }), []);
});

test('insertOne() sends Prefer: return=representation and returns the row', async () => {
  const fetchImpl = restFetch((call) => ({ status: 201, body: [{ ...call.body, created_at: 'now' }] }));
  const row = await insertOne('checkout_intents', { user_id: USER_ID, plan: 'monthly' }, { ctx: { ...CTX, fetchImpl } });
  assert.equal(row.plan, 'monthly');
  const call = fetchImpl.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.prefer, 'return=representation');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.deepEqual(call.body, { user_id: USER_ID, plan: 'monthly' });
  await assert.rejects(() => insertOne('x', 'nope', { ctx: CTX }), TypeError);
});

test('upsertOne() sends merge-duplicates and on_conflict', async () => {
  const fetchImpl = restFetch((call) => ({ status: 201, body: [call.body] }));
  const row = await upsertOne('trial_claims', { email_hash: '\\xdead', outcome: 'reserved' }, { onConflict: 'email_hash', ctx: { ...CTX, fetchImpl } });
  assert.equal(row.outcome, 'reserved');
  const call = fetchImpl.calls[0];
  assert.equal(call.headers.prefer, 'resolution=merge-duplicates,return=representation');
  assert.equal(new URL(call.url).searchParams.get('on_conflict'), 'email_hash');
});

test('updateWhere() PATCHes with filters, returns matched rows, and refuses no filter', async () => {
  const fetchImpl = restFetch(() => ({ status: 200, body: [] }));
  const rows = await updateWhere(
    'subscriptions',
    { provider: ['eq', 'testfixture'], provider_subscription_id: ['eq', 'sub_TESTFIXTURE'], last_event_at: ['lt', '2026-09-11T00:00:00Z'] },
    { status: 'active' },
    { ctx: { ...CTX, fetchImpl } },
  );
  assert.deepEqual(rows, [], 'zero rows means the conditional update matched nothing');
  const call = fetchImpl.calls[0];
  assert.equal(call.method, 'PATCH');
  assert.equal(call.headers.prefer, 'return=representation');
  assert.equal(new URL(call.url).searchParams.get('last_event_at'), 'lt.2026-09-11T00:00:00Z');
  await assert.rejects(() => updateWhere('subscriptions', {}, { status: 'x' }, { ctx: CTX }), /refusing to update/);
  await assert.rejects(() => updateWhere('subscriptions', { id: ['eq', 1] }, null, { ctx: CTX }), TypeError);
});

test('deleteWhere() refuses an empty filter and returns deleted rows', async () => {
  const fetchImpl = restFetch(() => ({ status: 200, body: [{ bucket: 'x' }] }));
  const rows = await deleteWhere('rate_limits', { window_start: ['lt', '2026-09-09'] }, { ctx: { ...CTX, fetchImpl } });
  assert.equal(rows.length, 1);
  assert.equal(fetchImpl.calls[0].method, 'DELETE');
  await assert.rejects(() => deleteWhere('rate_limits', {}, { ctx: CTX }), /refusing to delete/);
});

test('rpc() POSTs named arguments to /rest/v1/rpc/<fn> and returns the scalar', async () => {
  const fetchImpl = restFetch(() => new Response('true', { status: 200 }));
  const out = await rpc('bump_rate_limit', { p_bucket: 'b', p_window_seconds: 60, p_limit: 5 }, { ctx: { ...CTX, fetchImpl } });
  assert.equal(out, true);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, `${SUPABASE_URL}/rest/v1/rpc/bump_rate_limit`);
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.body, { p_bucket: 'b', p_window_seconds: 60, p_limit: 5 });
  await assert.rejects(() => rpc('drop table; --', {}, { ctx: CTX }), TypeError);
});

/* ------------------------------------------------------- assertLiveUser */

function liveFetch({ userStatus = 200, userBody, jwksStatus = 200, throwOnUser = false } = {}) {
  return restFetch((call) => {
    if (call.url.endsWith('/.well-known/jwks.json')) {
      return jwksStatus === 200 ? { status: 200, body: fixtures.jwks } : { status: jwksStatus, body: null };
    }
    if (call.url.endsWith('/auth/v1/user')) {
      if (throwOnUser) throw new TypeError('fetch failed');
      return { status: userStatus, body: userBody === undefined ? { id: USER_ID, email: 'live@example.com' } : userBody };
    }
    throw new Error(`unexpected url ${call.url}`);
  });
}

function liveOptions(fetchImpl, extra = {}) {
  return { supabaseUrl: SUPABASE_URL, publishableKey: PUBLISHABLE_KEY, fetchImpl, now: NOW_MS, ...extra };
}

test('assertLiveUser calls /auth/v1/user with the user JWT and the publishable key', async () => {
  const fetchImpl = liveFetch();
  const jwt = await signJwt(baseClaims());
  const result = await assertLiveUser(jwt, liveOptions(fetchImpl));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.sub, USER_ID);
  assert.equal(result.email, 'live@example.com', 'the live record wins over the claim');
  assert.equal(result.user.id, USER_ID);
  const userCall = fetchImpl.calls.find((c) => c.url.endsWith('/auth/v1/user'));
  assert.ok(userCall);
  assert.equal(userCall.headers.apikey, PUBLISHABLE_KEY);
  assert.equal(userCall.headers.authorization, `Bearer ${jwt}`);
  assert.ok(!Object.values(userCall.headers).includes(SECRET_KEY), 'the secret key never goes to the auth endpoint');
});

test('assertLiveUser reports session_revoked on 401/403 and sub_mismatch on a different id', async () => {
  const jwt = await signJwt(baseClaims());
  assert.equal((await assertLiveUser(jwt, liveOptions(liveFetch({ userStatus: 401, userBody: { msg: 'invalid' } })))).reason, 'session_revoked');
  resetJwksCache();
  assert.equal((await assertLiveUser(jwt, liveOptions(liveFetch({ userStatus: 403, userBody: {} })))).reason, 'session_revoked');
  resetJwksCache();
  const mismatch = await assertLiveUser(jwt, liveOptions(liveFetch({ userBody: { id: '00000000-0000-4000-8000-000000000000' } })));
  assert.equal(mismatch.reason, 'sub_mismatch');
  assert.equal(mismatch.sub, null);
});

test('assertLiveUser fails closed as auth_unavailable on 5xx, bad JSON or a network error', async () => {
  const jwt = await signJwt(baseClaims());
  assert.equal((await assertLiveUser(jwt, liveOptions(liveFetch({ userStatus: 502, userBody: null })))).reason, 'auth_unavailable');
  resetJwksCache();
  assert.equal((await assertLiveUser(jwt, liveOptions(liveFetch({ throwOnUser: true })))).reason, 'auth_unavailable');
  resetJwksCache();
  const badJson = restFetch((call) =>
    call.url.endsWith('/jwks.json') ? { status: 200, body: fixtures.jwks } : new Response('<html>', { status: 200 }),
  );
  assert.equal((await assertLiveUser(jwt, liveOptions(badJson))).reason, 'auth_unavailable');
});

test('assertLiveUser never hits the network for a token that fails local verification', async () => {
  const fetchImpl = liveFetch();
  const expired = await signJwt(baseClaims(NOW_MS, { iat: nowSeconds(NOW_MS) - 7200, exp: nowSeconds(NOW_MS) - 3600 }));
  const result = await assertLiveUser(expired, liveOptions(fetchImpl));
  assert.equal(result.reason, 'expired');
  assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith('/auth/v1/user')).length, 0);
  const garbage = await assertLiveUser('not.a.jwt', liveOptions(fetchImpl));
  assert.equal(garbage.reason, 'malformed');
});

/* ---------------------------------------------------------------- authz */

function request(headers = {}, { origin = 'https://helpmebreath.com', method = 'GET' } = {}) {
  return new Request(`${origin}/api/me`, {
    method,
    headers: { host: 'helpmebreath.com', origin, ...headers },
  });
}

test('bearerToken extracts a bearer token and nothing else', () => {
  assert.equal(bearerToken(request({ authorization: 'Bearer abc.def.ghi' })), 'abc.def.ghi');
  assert.equal(bearerToken(request({ authorization: 'bearer   abc.def.ghi  ' })), 'abc.def.ghi');
  assert.equal(bearerToken(request({ authorization: 'Basic abc' })), '');
  assert.equal(bearerToken(request({ authorization: 'Bearer' })), '');
  assert.equal(bearerToken(request({ authorization: 'Bearer a b' })), '');
  assert.equal(bearerToken(request()), '');
  assert.equal(bearerToken(null), '');
});

test('requireUser answers 401 unauthenticated with no detail leaked, on every JWT failure', async () => {
  const missing = await requireUser(request());
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 401);
  assert.equal(missing.detail, 'missing');
  assert.equal(missing.response.status, 401);
  assert.deepEqual(await missing.response.json(), { ok: false, reason: 'unauthenticated' });
  assert.equal(missing.response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, max-age=0');
  assert.match(missing.response.headers.get('www-authenticate'), /^Bearer/);

  const jwt = await signJwt(baseClaims(NOW_MS, { role: 'service_role' }));
  const badRole = await requireUser(request({ authorization: `Bearer ${jwt}` }), { verify: verifyOptions(jwksFetch()) });
  assert.equal(badRole.status, 401);
  assert.equal(badRole.detail, 'bad_role');
  const body = await badRole.response.json();
  assert.equal(body.reason, 'unauthenticated');
  assert.ok(!JSON.stringify(body).includes('bad_role'), 'the detailed reason stays server-side');
});

test('requireUser returns sub, email, claims and the token on success', async () => {
  const jwt = await signJwt(baseClaims());
  const auth = await requireUser(request({ authorization: `Bearer ${jwt}` }), { verify: verifyOptions(jwksFetch()) });
  assert.equal(auth.ok, true);
  assert.equal(auth.sub, USER_ID);
  assert.equal(auth.email, 'testfixture@example.com');
  assert.equal(auth.token, jwt);
  assert.equal(auth.user, null, 'no live record without the live check');
  assert.equal(auth.response, undefined);
});

test('requireLiveUser performs the /auth/v1/user round-trip and maps outages to 503', async () => {
  const jwt = await signJwt(baseClaims());
  const ok = await requireLiveUser(request({ authorization: `Bearer ${jwt}` }), { verify: liveOptions(liveFetch()) });
  assert.equal(ok.ok, true);
  assert.equal(ok.user.id, USER_ID);
  assert.equal(ok.email, 'live@example.com');

  resetJwksCache();
  const revoked = await requireLiveUser(request({ authorization: `Bearer ${jwt}` }), { verify: liveOptions(liveFetch({ userStatus: 401, userBody: {} })) });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.detail, 'session_revoked');

  resetJwksCache();
  const down = await requireLiveUser(request({ authorization: `Bearer ${jwt}` }), { verify: liveOptions(liveFetch({ throwOnUser: true })) });
  assert.equal(down.ok, false);
  assert.equal(down.status, 503);
  assert.equal(down.response.status, 503);
  const body = await down.response.json();
  assert.equal(body.reason, 'auth_unavailable');
  assert.equal(down.response.headers.get('retry-after'), '30');
});

test('a cold JWKS outage is a 503, not a sign-out', async () => {
  const jwt = await signJwt(baseClaims());
  const auth = await requireUser(request({ authorization: `Bearer ${jwt}` }), { verify: verifyOptions(jwksFetch(fixtures.jwks, { status: 500 })) });
  assert.equal(auth.status, 503);
  assert.equal(auth.detail, 'jwks_unavailable');
});

test('unauthorized() and authUnavailable() carry same-origin CORS and no-store', async () => {
  const res = unauthorized(request({}, { origin: 'https://helpmebreath.com' }));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://helpmebreath.com');
  const cross = unauthorized(request({}, { origin: 'https://evil.example' }));
  assert.equal(cross.headers.get('access-control-allow-origin'), null);
  const down = authUnavailable(request());
  assert.equal(down.status, 503);
  assert.equal(down.headers.get('cdn-cache-control'), 'no-store');
});

test('stripClientAssertedIdentity removes fields a client may never assert', () => {
  const { body, stripped } = stripClientAssertedIdentity({ plan: 'monthly', device_mirror: 'x.y', user_id: 'attacker', price_id: 'pri_x', sub: 'z' });
  assert.deepEqual(body, { plan: 'monthly', device_mirror: 'x.y' });
  assert.deepEqual(stripped, ['user_id', 'sub', 'price_id']);
  assert.deepEqual(stripClientAssertedIdentity(null), { body: {}, stripped: [] });
  assert.deepEqual(stripClientAssertedIdentity([1]), { body: {}, stripped: [] });
});

/* -------------------------------------------------------------- dblimit */

function rpcFetch(value) {
  return restFetch((call) => {
    if (!call.url.endsWith('/rest/v1/rpc/bump_rate_limit')) throw new Error(`unexpected ${call.url}`);
    if (value instanceof Error) throw value;
    if (typeof value === 'number') return { status: value, body: { message: 'boom' } };
    return new Response(JSON.stringify(value), { status: 200 });
  });
}

test('dblimit calls bump_rate_limit with named arguments and resolves to the bare boolean', async () => {
  // The boolean contract is what api/_lib/trialguard.js#runEligibility codes
  // against (`userOk === false`): true = allowed, false = refused.
  const fetchImpl = rpcFetch(true);
  const allowed = await dblimit(`trial:${USER_ID}`, 3600, 6, { ctx: { ...CTX, fetchImpl } });
  assert.equal(allowed, true);
  assert.equal(fetchImpl.calls[0].url, `${SUPABASE_URL}/rest/v1/rpc/bump_rate_limit`);
  assert.equal(fetchImpl.calls[0].method, 'POST');
  assert.deepEqual(fetchImpl.calls[0].body, { p_bucket: `trial:${USER_ID}`, p_window_seconds: 3600, p_limit: 6 });
  assert.equal(fetchImpl.calls[0].headers.apikey, SECRET_KEY);

  const limited = await dblimit('trial:ip:203.0.113', 3600, 20, { ctx: { ...CTX, fetchImpl: rpcFetch(false) } });
  assert.equal(limited, false);
});

test('dblimitCheck returns the same decision with the reason attached', async () => {
  const ok = await dblimitCheck(`trial:${USER_ID}`, 3600, 6, { ctx: { ...CTX, fetchImpl: rpcFetch(true) } });
  assert.deepEqual(ok, { bucket: `trial:${USER_ID}`, windowSeconds: 3600, limit: 6, allowed: true, reason: 'ok' });
  const limited = await dblimitCheck('trial:ip:203.0.113', 3600, 20, { ctx: { ...CTX, fetchImpl: rpcFetch(false) } });
  assert.equal(limited.allowed, false);
  assert.equal(limited.reason, 'limited');
});

test('dblimit fails closed when the database cannot answer, and open only when asked', async () => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const down = await dblimitCheck('trial:x', 60, 5, { ctx: { ...CTX, fetchImpl: rpcFetch(new Error('fetch failed')) } });
    assert.equal(down.allowed, false);
    assert.equal(down.reason, 'limiter_unavailable');
    assert.equal(await dblimit('trial:x', 60, 5, { ctx: { ...CTX, fetchImpl: rpcFetch(new Error('fetch failed')) } }), false);

    const http = await dblimitCheck('trial:x', 60, 5, { ctx: { ...CTX, fetchImpl: rpcFetch(500) } });
    assert.equal(http.allowed, false);
    assert.equal(http.reason, 'limiter_unavailable');

    // A non-boolean answer (a misdeployed function) is treated as an outage, never as "allowed".
    const weird = await dblimitCheck('trial:x', 60, 5, { ctx: { ...CTX, fetchImpl: rpcFetch('yes') } });
    assert.equal(weird.allowed, false);
    assert.equal(weird.reason, 'limiter_unavailable');
    assert.equal(await dblimit('trial:x', 60, 5, { ctx: { ...CTX, fetchImpl: rpcFetch(1) } }), false);

    const open = await dblimitCheck('me:x', 60, 5, { failOpen: true, ctx: { ...CTX, fetchImpl: rpcFetch(new Error('fetch failed')) } });
    assert.equal(open.allowed, true);
    assert.equal(open.reason, 'limiter_unavailable');
    assert.equal(await dblimit('me:x', 60, 5, { failOpen: true, ctx: { ...CTX, fetchImpl: rpcFetch(500) } }), true);
  } finally {
    console.error = original;
  }
  assert.ok(logged.length >= 3);
  assert.ok(logged.every((line) => !line.includes(SECRET_KEY)));
});

test('dblimit validates its arguments', async () => {
  await assert.rejects(() => dblimit('', 60, 5, { ctx: CTX }), TypeError);
  await assert.rejects(() => dblimit('x'.repeat(201), 60, 5, { ctx: CTX }), TypeError);
  await assert.rejects(() => dblimit('b', 0, 5, { ctx: CTX }), TypeError);
  await assert.rejects(() => dblimit('b', 60.5, 5, { ctx: CTX }), TypeError);
  await assert.rejects(() => dblimit('b', 60, 0, { ctx: CTX }), TypeError);
  await assert.rejects(() => dblimit('b', 60, -1, { ctx: CTX }), TypeError);
});

test('dblimitAll stops at the first refusal so later buckets are not consumed', async () => {
  let calls = 0;
  const fetchImpl = restFetch((call) => {
    calls += 1;
    return new Response(JSON.stringify(call.body.p_bucket === 'a' ? false : true), { status: 200 });
  });
  const out = await dblimitAll([['a', 60, 1], ['b', 60, 1]], { ctx: { ...CTX, fetchImpl } });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'limited');
  assert.equal(calls, 1);

  calls = 0;
  const ok = await dblimitAll([['b', 60, 1], ['c', 60, 1]], { ctx: { ...CTX, fetchImpl } });
  assert.equal(ok.allowed, true);
  assert.equal(ok.results.length, 2);
  assert.equal(calls, 2);
});

test('ipBucket coarsens IPv4 to /24 and IPv6 to /64, never returning a full address', () => {
  assert.equal(ipBucket('203.0.113.42'), '203.0.113');
  assert.equal(ipBucket('  203.0.113.42 '), '203.0.113');
  assert.equal(ipBucket('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3:8d3');
  assert.equal(ipBucket('2001:db8::1'), '2001:db8:0:0');
  assert.equal(ipBucket('::1'), '0:0:0:0');
  assert.equal(ipBucket('[2001:DB8::1]'), '2001:db8:0:0');
  assert.equal(ipBucket('::ffff:203.0.113.42'), '203.0.113', 'an IPv4-mapped client is an IPv4 client');
  assert.equal(ipBucket('[::FFFF:203.0.113.42]'), '203.0.113');
  assert.equal(ipBucket('::ffff:203.0.113.42:1'), 'unknown');
  assert.equal(ipBucket('unknown'), 'unknown');
  assert.equal(ipBucket(''), 'unknown');
  assert.equal(ipBucket(null), 'unknown');
  assert.equal(ipBucket('1:2:3'), 'unknown');
  assert.equal(ipBucket('1::2::3'), 'unknown');
});
