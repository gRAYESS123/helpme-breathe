/**
 * tools/embed.test.mjs — embed credentials (design §9).
 *
 *   node --test tools/embed.test.mjs
 *
 * Covers api/entitlement.js (verifier + ledger reader), api/embed/frame.js
 * (the document-time domain check and the inlined verdict) and
 * api/embed/token.js (mint / rotate / revoke under the group model). Every
 * ledger call goes to an in-memory fake of PostgREST; nothing touches the
 * network. All secrets are TESTFIXTURE placeholders.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

process.env.LICENSE_SECRET = 'TESTFIXTURE-license-secret-not-real';
process.env.SUPABASE_URL = 'https://testfixture.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'TESTFIXTURE-supabase-secret-not-real';
process.env.SITE_ORIGIN = 'https://helpmebreath.com';

// Lives in tools/; HMB_REPO_ROOT lets it run from anywhere else.
const REPO = process.env.HMB_REPO_ROOT
  ? pathToFileURL(process.env.HMB_REPO_ROOT.replace(/[\/]+$/, '') + '/')
  : new URL('../', import.meta.url);
const [{ signToken, kidFor }, entitlement, frame, token] = await Promise.all([
  import(new URL('api/_lib/crypto.js', REPO)),
  import(new URL('api/entitlement.js', REPO)),
  import(new URL('api/embed/frame.js', REPO)),
  import(new URL('api/embed/token.js', REPO)),
]);

const SECRET = process.env.LICENSE_SECRET;
const USER = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER_USER = '1b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const GID = 'et_testfixturegroup01';
const JTI = 'ec_testfixturecred001';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-11T12:00:00Z');

/* ---------------------------------------------------------------- helpers */

async function credential(overrides = {}, secret = SECRET) {
  const iat = Math.floor(NOW / 1000);
  const payload = {
    v: 3,
    typ: 'emb',
    sub: USER,
    gid: GID,
    jti: JTI,
    dom: ['clinic.example.com', 'www.clinic.example.com'],
    iat,
    exp: iat + 30 * 24 * 60 * 60,
    kid: await kidFor(SECRET),
    ...overrides,
  };
  return signToken(payload, secret);
}

/** An in-memory PostgREST. Only the operators the code under test uses. */
function fakeLedger(seed = {}) {
  const tables = {
    embed_credentials: [],
    embed_tokens: [],
    subscriptions: [],
    ...seed,
  };
  const calls = [];

  function matches(row, key, filter) {
    const [op, ...rest] = filter.split('.');
    const value = rest.join('.');
    if (op === 'eq') return String(row[key]) === value;
    if (op === 'neq') return String(row[key]) !== value;
    if (op === 'is' && value === 'null') return row[key] == null;
    if (op === 'in') {
      const list = value.replace(/^\(|\)$/g, '').split(',').map((v) => v.replace(/^"|"$/g, ''));
      return list.includes(String(row[key]));
    }
    throw new Error(`fakeLedger: unsupported filter ${key}=${filter}`);
  }

  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/rest\/v1\//, '');
    const method = (init.method || 'GET').toUpperCase();
    const query = Object.fromEntries(parsed.searchParams.entries());
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, query, body });

    if (tables.__fail) return new Response('{"message":"down"}', { status: 503 });

    if (path === 'rpc/bump_rate_limit') return Response.json(true);

    const rows = tables[path];
    if (!rows) return new Response('{"message":"no such table"}', { status: 404 });
    const filters = Object.entries(query).filter(([k]) => !['select', 'order', 'limit', 'offset'].includes(k));
    const hit = (row) => filters.every(([k, f]) => matches(row, k, f));

    if (method === 'GET') {
      let out = rows.filter(hit);
      if (query.order && query.order.startsWith('access_until.desc')) {
        out = out.slice().sort((a, b) => (Date.parse(b.access_until || 0) || 0) - (Date.parse(a.access_until || 0) || 0));
      }
      if (query.limit) out = out.slice(0, Number(query.limit));
      return Response.json(out);
    }
    if (method === 'POST') {
      rows.push({ ...body });
      return new Response(null, { status: 201 });
    }
    if (method === 'PATCH') {
      const changed = rows.filter(hit);
      for (const row of changed) Object.assign(row, body);
      return Response.json(changed);
    }
    if (method === 'DELETE') {
      const gone = rows.filter(hit);
      for (const row of gone) rows.splice(rows.indexOf(row), 1);
      return Response.json(gone);
    }
    return new Response(null, { status: 405 });
  }

  return { tables, calls, fetchImpl };
}

function seededLedger(overrides = {}) {
  const iso = (ms) => new Date(ms).toISOString();
  return fakeLedger({
    embed_tokens: [
      { token_id: GID, user_id: USER, domains: ['clinic.example.com', 'www.clinic.example.com'], revoked_at: null, hit_count: 0, verify_count_30d: 0, ...(overrides.group || {}) },
    ],
    embed_credentials: [
      { jti: JTI, token_id: GID, issued_at: iso(NOW - DAY), expires_at: iso(NOW + 29 * DAY), superseded_at: null, revoked_at: null, hit_count: 0, ...(overrides.credential || {}) },
    ],
    subscriptions: [
      { user_id: USER, status: 'active', plan: 'monthly', access_until: iso(NOW + 20 * DAY), ...(overrides.subscription || {}) },
    ],
  });
}

function frameRequest(wl, headers = {}) {
  const url = new URL('https://helpmebreath.com/api/embed/frame');
  if (wl) url.searchParams.set('wl', wl);
  return new Request(url, {
    headers: {
      'sec-fetch-dest': 'iframe',
      'sec-fetch-site': 'cross-site',
      referer: 'https://clinic.example.com/',
      ...headers,
    },
  });
}

/* ------------------------------------------------ verifyEmbedCredential */

test('verifyEmbedCredential accepts a v3 emb credential and reports its payload', async () => {
  const wl = await credential();
  const out = await entitlement.verifyEmbedCredential(wl, SECRET, { now: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.payload.gid, GID);
  assert.equal(out.payload.jti, JTI);
});

test('verifyEmbedCredential refuses the account token (typ ent), v1 tokens, forgeries and expiry', async () => {
  const ent = await credential({ typ: 'ent' });
  assert.equal((await entitlement.verifyEmbedCredential(ent, SECRET, { now: NOW })).reason, 'wrong_type');

  const v1 = await signToken({ v: 1, tier: 'practitioner', sub: 'abc123def456', iat: 1, exp: 4102444800, kid: await kidFor(SECRET), act: 1 }, SECRET);
  assert.equal((await entitlement.verifyEmbedCredential(v1, SECRET, { now: NOW })).reason, 'wrong_type');

  const forged = await credential({}, 'TESTFIXTURE-wrong-secret');
  assert.equal((await entitlement.verifyEmbedCredential(forged, SECRET, { now: NOW })).reason, 'bad_signature');

  const expired = await credential({ exp: Math.floor(NOW / 1000) - 1 });
  assert.equal((await entitlement.verifyEmbedCredential(expired, SECRET, { now: NOW })).reason, 'expired');

  const badShape = await credential({ jti: 'nope' });
  assert.equal((await entitlement.verifyEmbedCredential(badShape, SECRET, { now: NOW })).reason, 'bad_payload');

  assert.equal((await entitlement.verifyEmbedCredential('', SECRET, { now: NOW })).reason, 'missing');
});

/* ------------------------------------------------------- decideEmbedding */

test('decideEmbedding needs fetch metadata, an iframe, cross-site, and a referer on the list', () => {
  const h = (extra) => new Headers({ 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site', referer: 'https://clinic.example.com/page', ...extra });
  const dom = ['clinic.example.com'];
  assert.deepEqual(frame.decideEmbedding(h({}), dom), { ok: true, reason: 'ok', host: 'clinic.example.com' });
  assert.equal(frame.decideEmbedding(new Headers({ referer: 'https://clinic.example.com/' }), dom).reason, 'no_fetch_metadata');
  assert.equal(frame.decideEmbedding(h({ 'sec-fetch-dest': 'document' }), dom).reason, 'not_framed');
  assert.equal(frame.decideEmbedding(h({ 'sec-fetch-site': 'same-origin' }), dom).reason, 'not_cross_site');
  assert.equal(frame.decideEmbedding(h({ referer: '' }), dom).reason, 'no_referer');
  assert.equal(frame.decideEmbedding(h({ referer: 'not a url' }), dom).reason, 'no_referer');
  assert.equal(frame.decideEmbedding(h({ referer: 'https://other.example.org/' }), dom).reason, 'domain');
  // A parent on a listed host but a credential for a different one: exact match only.
  assert.equal(frame.decideEmbedding(h({ referer: 'https://www.clinic.example.com/' }), dom).reason, 'domain');
  // Case and trailing dot are normalised; the path is irrelevant.
  assert.equal(frame.decideEmbedding(h({ referer: 'https://Clinic.Example.COM./deep/path?x=1' }), dom).ok, true);
});

/* ---------------------------------------------------------- decideVerdict */

test('decideVerdict: a live credential from a listed host white-labels and counts the hit', async () => {
  const ledger = seededLedger();
  const wl = await credential();
  const out = await frame.decideVerdict(frameRequest(wl), { now: NOW, fetchImpl: ledger.fetchImpl, sample: 0, ip: '203.0.113.1' });
  assert.deepEqual(out, { whitelabel: true, reason: 'ok' });
  const patches = ledger.calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.length, 2, 'credential and group hit counters both bumped');
  assert.equal(ledger.tables.embed_credentials[0].hit_count, 1);
  assert.equal(ledger.tables.embed_tokens[0].verify_count_30d, 1);
});

test('decideVerdict: sampling keeps the write cheap', async () => {
  const ledger = seededLedger();
  const wl = await credential();
  await frame.decideVerdict(frameRequest(wl), { now: NOW, fetchImpl: ledger.fetchImpl, sample: 0.5, ip: '203.0.113.2' });
  assert.equal(ledger.calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('decideVerdict: every failure mode is the free widget, never a throw', async () => {
  const wl = await credential();
  const cases = [
    ['no credential', () => seededLedger(), frameRequest(''), 'no_credential'],
    ['malformed wl', () => seededLedger(), frameRequest('!!!not-a-token'), 'malformed'],
    ['forged wl', () => seededLedger(), frameRequest(await credential({}, 'TESTFIXTURE-wrong')), 'bad_signature'],
    ['no referer', () => seededLedger(), frameRequest(wl, { referer: '' }), 'no_referer'],
    ['wrong host', () => seededLedger(), frameRequest(wl, { referer: 'https://thief.example.net/' }), 'domain'],
    ['opened top-level', () => seededLedger(), frameRequest(wl, { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' }), 'not_framed'],
    ['old browser without fetch metadata', () => seededLedger(), new Request(`https://helpmebreath.com/api/embed/frame?wl=${wl}`, { headers: { referer: 'https://clinic.example.com/' } }), 'no_fetch_metadata'],
    ['group revoked', () => seededLedger({ group: { revoked_at: new Date(NOW - 1000).toISOString() } }), frameRequest(wl), 'revoked'],
    ['credential revoked', () => seededLedger({ credential: { revoked_at: new Date(NOW - 1000).toISOString() } }), frameRequest(wl), 'revoked'],
    ['rotated past its 48h overlap', () => seededLedger({ credential: { superseded_at: new Date(NOW - 49 * 60 * 60 * 1000).toISOString() } }), frameRequest(wl), 'superseded'],
    ['row expired', () => seededLedger({ credential: { expires_at: new Date(NOW - 1000).toISOString() } }), frameRequest(wl), 'expired'],
    ['owner lapsed', () => seededLedger({ subscription: { access_until: new Date(NOW - DAY).toISOString(), status: 'canceled' } }), frameRequest(wl), 'lapsed'],
    ['owner never subscribed', () => { const l = seededLedger(); l.tables.subscriptions.length = 0; return l; }, frameRequest(wl), 'lapsed'],
    ['unknown jti', () => { const l = seededLedger(); l.tables.embed_credentials.length = 0; return l; }, frameRequest(wl), 'unknown'],
    ['group belongs to someone else', () => seededLedger({ group: { user_id: OTHER_USER } }), frameRequest(wl), 'mismatch'],
    ['ledger down', () => { const l = seededLedger(); l.tables.__fail = true; return l; }, frameRequest(wl), 'unavailable'],
    ['LICENSE_SECRET rotated (kid mismatch)', () => seededLedger(), frameRequest(await credential({ kid: 'deadbeef' })), 'kid_mismatch'],
    ['owner past_due after a trial that never paid: access ended at trial end', () => seededLedger({ subscription: { status: 'past_due', access_until: new Date(NOW - 1000).toISOString() } }), frameRequest(wl), 'lapsed'],
  ];
  let ip = 10;
  for (const [label, make, request, reason] of cases) {
    const ledger = make();
    const out = await frame.decideVerdict(request, { now: NOW, fetchImpl: ledger.fetchImpl, sample: 1, ip: `203.0.113.${ip += 1}` });
    assert.equal(out.whitelabel, false, label);
    assert.equal(out.reason, reason, label);
  }
});

test('decideVerdict: every plan we sell carries the com claim; a row with no live access does not', async () => {
  const wl = await credential();
  for (const plan of ['monthly', 'yearly']) {
    const live = seededLedger({ subscription: { plan } });
    const out = await frame.decideVerdict(frameRequest(wl), { now: NOW, fetchImpl: live.fetchImpl, sample: 1, ip: '203.0.113.60' });
    assert.deepEqual(out, { whitelabel: true, reason: 'ok' }, plan);
  }
  const lapsed = seededLedger({ subscription: { plan: 'monthly', status: 'canceled', access_until: new Date(NOW - DAY).toISOString() } });
  const gone = await frame.decideVerdict(frameRequest(wl), { now: NOW, fetchImpl: lapsed.fetchImpl, sample: 1, ip: '203.0.113.61' });
  assert.deepEqual(gone, { whitelabel: false, reason: 'lapsed' });
  // Two rows: the entitlement takes the one with the later access_until (section 13).
  const churned = seededLedger({ subscription: { status: 'canceled', access_until: new Date(NOW - DAY).toISOString() } });
  churned.tables.subscriptions.push({ user_id: USER, status: 'active', plan: 'monthly', access_until: new Date(NOW + 10 * DAY).toISOString() });
  const back = await frame.decideVerdict(frameRequest(wl), { now: NOW, fetchImpl: churned.fetchImpl, sample: 1, ip: '203.0.113.62' });
  assert.deepEqual(back, { whitelabel: true, reason: 'ok' });
});

test('decideVerdict: a rotated credential still verifies inside its 48h overlap', async () => {
  const ledger = seededLedger({ credential: { superseded_at: new Date(NOW - 47 * 60 * 60 * 1000).toISOString() } });
  const wl = await credential();
  const out = await frame.decideVerdict(frameRequest(wl), { now: NOW, fetchImpl: ledger.fetchImpl, sample: 1, ip: '203.0.113.50' });
  assert.equal(out.whitelabel, true);
});

test('decideVerdict: the per-IP limit degrades to the free widget, not a 429', async () => {
  const ledger = seededLedger();
  const wl = await credential();
  let last;
  for (let i = 0; i < 121; i += 1) {
    last = await frame.decideVerdict(frameRequest(wl), { now: NOW, fetchImpl: ledger.fetchImpl, sample: 1, ip: '198.51.100.7' });
  }
  assert.deepEqual(last, { whitelabel: false, reason: 'rate_limited' });
});

/* ------------------------------------------------------------ renderFrame */

test('renderFrame inlines the verdict at the marker, coarsens the reason and escapes it for a script element', () => {
  const template = '<html><head><script data-hmb-verdict></script></head><body></body></html>';
  const html = frame.renderFrame(template, { whitelabel: false, reason: '</script><script>alert(1)' });
  assert.equal(html.includes('</script><script>alert'), false);
  assert.match(html, /window\.__HMB_EMBED = \{"v":1,"whitelabel":false,"reason":"denied"\};<\/script>/);
  // A template without the marker still gets the verdict before </head>.
  const fallback = frame.renderFrame('<html><head></head><body></body></html>', { whitelabel: true, reason: 'ok' });
  assert.match(fallback, /"whitelabel":true[^]*<\/head>/);
  // Only a literal `true` white-labels; anything else the verdict object says is false.
  assert.match(frame.renderFrame(template, { whitelabel: 'true', reason: 'ok' }), /"whitelabel":false/);
});

test('publicReason never lets the served document name the subscriber billing state', () => {
  // Debuggable by the subscriber: where the frame is, what it was sent.
  assert.equal(frame.publicReason('no_referer'), 'no_referer');
  assert.equal(frame.publicReason('domain'), 'domain');
  assert.equal(frame.publicReason('not_framed'), 'not_embedded');
  assert.equal(frame.publicReason('no_fetch_metadata'), 'not_embedded');
  assert.equal(frame.publicReason('bad_signature'), 'invalid');
  assert.equal(frame.publicReason('superseded'), 'expired');
  // Ledger verdicts about the account fold into one word.
  for (const hidden of ['lapsed', 'revoked', 'not_commercial', 'unknown', 'mismatch', 'anything-new']) {
    assert.equal(frame.publicReason(hidden), 'denied', hidden);
  }
  for (const reason of ['lapsed', 'revoked', 'not_commercial']) {
    const html = frame.renderFrame('<head><script data-hmb-verdict></script></head>', { whitelabel: false, reason });
    assert.equal(html.includes(reason), false, reason);
  }
});

test('GET /api/embed/frame serves the real template, private and uncached, with the verdict inlined', async () => {
  const response = await frame.GET(frameRequest(''));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors \*/);
  const html = await response.text();
  assert.match(html, /window\.__HMB_EMBED = \{"v":1,"whitelabel":false,"reason":"no_credential"\}/);
  assert.match(html, /data-open-timer="true"/);
  assert.match(html, /Powered by Help Me Breathe/);
  // Rule 14: nothing in the document points off-origin except the attribution
  // and disclaimer links (anchors), which are not requests.
  const requests = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  for (const url of requests) assert.match(url, /^https:\/\/helpmebreath\.com\//, `off-origin reference: ${url}`);
  assert.equal(/<link[^>]+href="https?:\/\//.test(html), false, 'no external stylesheet or font');
  assert.equal(/<script[^>]+src="https?:\/\//.test(html), false, 'no external script');
});

test('GET /api/embed/frame end to end: a listed host gets whitelabel:true, an unlisted one the attributed widget', async () => {
  const ledger = seededLedger();
  const wl = await credential();
  const original = globalThis.fetch;
  globalThis.fetch = ledger.fetchImpl;
  try {
    const good = await frame.GET(frameRequest(wl, { 'x-real-ip': '198.51.100.20' }));
    assert.equal(good.status, 200);
    assert.match(await good.text(), /window\.__HMB_EMBED = \{"v":1,"whitelabel":true,"reason":"ok"\}/);
    const thief = await frame.GET(frameRequest(wl, { referer: 'https://thief.example.net/', 'x-real-ip': '198.51.100.21' }));
    const html = await thief.text();
    assert.match(html, /"whitelabel":false,"reason":"domain"/);
    assert.match(html, /Powered by Help Me Breathe/);
    const head = await frame.HEAD(frameRequest(wl, { 'x-real-ip': '198.51.100.22' }));
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const post = await frame.POST();
    assert.equal(post.status, 405);
  } finally {
    globalThis.fetch = original;
  }
});

/* ----------------------------------------------------------- token.js */

test('validateDomains normalises, deduplicates and refuses wildcards and our own host', () => {
  const ok = token.validateDomains([' https://Clinic.Example.com/path ', 'www.clinic.example.com', 'clinic.example.com']);
  assert.deepEqual(ok, { ok: true, domains: ['clinic.example.com', 'www.clinic.example.com'] });
  assert.equal(token.validateDomains([]).reason, 'domains_required');
  assert.equal(token.validateDomains('clinic.example.com').reason, 'domains_required');
  assert.equal(token.validateDomains(['*.clinic.example.com']).reason, 'wildcard_not_allowed');
  assert.equal(token.validateDomains(['helpmebreath.com']).reason, 'own_site_not_allowed');
  assert.equal(token.validateDomains(['embed.helpmebreath.com']).reason, 'own_site_not_allowed');
  assert.equal(token.validateDomains(['not a host']).reason, 'invalid_domain');
  assert.equal(token.validateDomains(new Array(11).fill('a.example')).reason, 'too_many_domains');
});

function tokenDeps(ledger, overrides = {}) {
  let n = 0;
  return {
    assertLiveUser: async (jwt) => (jwt === 'TESTFIXTURE-live-jwt' ? { ok: true, sub: USER } : { ok: false, reason: 'bad_signature' }),
    rest: (method, path, options = {}) => entitlement.rest(method, path, { ...options, fetchImpl: ledger.fetchImpl }),
    limit: async () => ({ allowed: true, reason: 'ok' }),
    now: () => NOW,
    secret: () => SECRET,
    newId: (prefix) => `${prefix}testfixture${String((n += 1)).padStart(6, '0')}`,
    ...overrides,
  };
}

function tokenRequest(method, body, extra = {}) {
  return new Request(`https://helpmebreath.com/api/embed/token${extra.query || ''}`, {
    method,
    headers: { authorization: `Bearer ${extra.jwt || 'TESTFIXTURE-live-jwt'}`, 'content-type': 'application/json', ...(extra.headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('POST /api/embed/token refuses without a live session and without a subscription', async () => {
  const ledger = seededLedger();
  const anon = await token.handle(new Request('https://helpmebreath.com/api/embed/token', { method: 'POST' }), tokenDeps(ledger));
  assert.equal(anon.status, 401);
  const stale = await token.handle(tokenRequest('POST', { domains: ['a.example'] }, { jwt: 'TESTFIXTURE-stale' }), tokenDeps(ledger));
  assert.equal(stale.status, 401);

  const lapsed = seededLedger({ subscription: { access_until: new Date(NOW - 1).toISOString() } });
  const res = await token.handle(tokenRequest('POST', { domains: ['a.example'] }), tokenDeps(lapsed));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reason, 'subscription_required');

  const outage = seededLedger();
  const down = await token.handle(tokenRequest('POST', { domains: ['a.example'] }), tokenDeps(outage, { assertLiveUser: async () => ({ ok: false, reason: 'auth_unavailable' }) }));
  assert.equal(down.status, 503);
});

test('POST mints a group with one credential; the credential verifies and the ledger agrees', async () => {
  const ledger = seededLedger();
  ledger.tables.embed_tokens.length = 0;
  ledger.tables.embed_credentials.length = 0;
  const res = await token.handle(tokenRequest('POST', { domains: ['Clinic.Example.com'], label: 'Clinic\thomepage' }), tokenDeps(ledger));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.token_id, /^et_/);
  assert.match(body.jti, /^ec_/);
  assert.deepEqual(body.domains, ['clinic.example.com']);
  assert.equal(body.label, 'Clinic homepage');
  assert.match(body.snippet, /breathe\.js" data-wl="/);
  assert.match(body.iframe_snippet, /\/api\/embed\/frame\?wl=/);
  assert.equal(body.expires_at, new Date(NOW + 30 * DAY).toISOString());

  const verified = await entitlement.verifyEmbedCredential(body.token, SECRET, { now: NOW });
  assert.equal(verified.ok, true);
  assert.equal(verified.payload.sub, USER);
  assert.equal(verified.payload.gid, body.token_id);
  assert.equal(verified.payload.jti, body.jti);

  assert.equal(ledger.tables.embed_tokens.length, 1);
  assert.equal(ledger.tables.embed_tokens[0].user_id, USER);
  assert.equal(ledger.tables.embed_credentials.length, 1);
  assert.equal(ledger.tables.embed_credentials[0].token_id, body.token_id);

  // Nothing in the request body is trusted for identity.
  const spoof = await token.handle(tokenRequest('POST', { domains: ['b.example'], user_id: OTHER_USER }), tokenDeps(ledger));
  assert.equal((await spoof.json()).ok, true);
  assert.equal(ledger.tables.embed_tokens[1].user_id, USER);
});

test('GET ?rotate=1 issues a new jti and supersedes the old ones, which then live 48h', async () => {
  const ledger = seededLedger();
  const res = await token.handle(tokenRequest('GET', undefined, { query: `?rotate=1&token_id=${GID}` }), tokenDeps(ledger));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.action, 'rotate');
  assert.notEqual(body.jti, JTI);
  assert.deepEqual(body.superseded, [JTI]);
  assert.equal(body.overlap_ends_at, new Date(NOW + entitlement.ROTATION_OVERLAP_MS).toISOString());

  const old = ledger.tables.embed_credentials.find((r) => r.jti === JTI);
  assert.equal(old.superseded_at, new Date(NOW).toISOString());
  const fresh = ledger.tables.embed_credentials.find((r) => r.jti === body.jti);
  assert.equal(fresh.superseded_at, undefined);

  // The old credential keeps verifying for 47h and stops at 49h.
  const oldWl = await credential();
  const during = await entitlement.credentialStatus((await entitlement.verifyEmbedCredential(oldWl, SECRET, { now: NOW })).payload, { now: NOW + 47 * 60 * 60 * 1000, fetchImpl: ledger.fetchImpl });
  assert.equal(during.ok, true);
  const after = await entitlement.credentialStatus((await entitlement.verifyEmbedCredential(oldWl, SECRET, { now: NOW })).payload, { now: NOW + 49 * 60 * 60 * 1000, fetchImpl: ledger.fetchImpl });
  assert.equal(after.reason, 'superseded');

  // Somebody else's group cannot be rotated.
  const foreign = seededLedger({ group: { user_id: OTHER_USER } });
  const nope = await token.handle(tokenRequest('GET', undefined, { query: `?rotate=1&token_id=${GID}` }), tokenDeps(foreign));
  assert.equal(nope.status, 404);
});

test('DELETE revokes the whole group: every jti dies at once', async () => {
  const ledger = seededLedger();
  ledger.tables.embed_credentials.push({ jti: 'ec_testfixturecred002', token_id: GID, issued_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 30 * DAY).toISOString(), superseded_at: null, revoked_at: null, hit_count: 0 });
  const res = await token.handle(tokenRequest('DELETE', { token_id: GID }), tokenDeps(ledger));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.credentials_revoked.sort(), [JTI, 'ec_testfixturecred002'].sort());
  assert.equal(ledger.tables.embed_tokens[0].revoked_at, new Date(NOW).toISOString());
  for (const row of ledger.tables.embed_credentials) assert.equal(row.revoked_at, new Date(NOW).toISOString());

  const wl = await credential();
  const verdict = await frame.decideVerdict(frameRequest(wl), { now: NOW + 1000, fetchImpl: ledger.fetchImpl, sample: 1, ip: '203.0.113.99' });
  assert.deepEqual(verdict, { whitelabel: false, reason: 'revoked' });

  // Revoking twice is a no-op that repeats the original timestamp; a group
  // that is not this subscriber's is a 404; a revoked group cannot be rotated.
  const again = await token.handle(tokenRequest('DELETE', { token_id: GID }), tokenDeps(ledger));
  assert.equal(again.status, 200);
  const twice = await again.json();
  assert.equal(twice.already_revoked, true);
  assert.equal(twice.revoked_at, new Date(NOW).toISOString());
  assert.deepEqual(twice.credentials_revoked, []);
  const foreign = await token.handle(tokenRequest('DELETE', { token_id: GID }), tokenDeps(seededLedger({ group: { user_id: OTHER_USER } })));
  assert.equal(foreign.status, 404);
  const rotate = await token.handle(tokenRequest('GET', undefined, { query: `?rotate=1&token_id=${GID}` }), tokenDeps(ledger));
  assert.equal(rotate.status, 409);
});

test('GET lists nothing for a subscriber with no groups, without a malformed in.() query', async () => {
  const ledger = seededLedger();
  ledger.tables.embed_tokens.length = 0;
  const res = await token.handle(tokenRequest('GET'), tokenDeps(ledger));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).groups, []);
  assert.equal(ledger.calls.some((c) => c.path === 'embed_credentials'), false);
});

test('GET lists groups with their credentials and live flags', async () => {
  const ledger = seededLedger({ credential: { superseded_at: new Date(NOW - 50 * 60 * 60 * 1000).toISOString() } });
  const res = await token.handle(tokenRequest('GET'), tokenDeps(ledger));
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.frame_path, '/api/embed/frame');
  assert.equal(body.groups.length, 1);
  assert.equal(body.groups[0].token_id, GID);
  assert.equal(body.groups[0].credentials[0].jti, JTI);
  assert.equal(body.groups[0].credentials[0].live, false);
});

test('the limiter fails closed; a lapsed subscriber may not mint, a live one on either plan may', async () => {
  const ledger = seededLedger();
  const limited = await token.handle(tokenRequest('POST', { domains: ['a.example'] }), tokenDeps(ledger, { limit: async () => ({ allowed: false, reason: 'limited' }) }));
  assert.equal(limited.status, 429);
  const down = await token.handle(tokenRequest('POST', { domains: ['a.example'] }), tokenDeps(ledger, { limit: async () => ({ allowed: false, reason: 'limiter_unavailable' }) }));
  assert.equal(down.status, 503);

  const lapsed = seededLedger({ subscription: { plan: 'monthly', status: 'canceled', access_until: new Date(NOW - DAY).toISOString() } });
  const refused = await token.handle(tokenRequest('POST', { domains: ['a.example'] }), tokenDeps(lapsed));
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).reason, 'subscription_required');

  for (const plan of ['monthly', 'yearly']) {
    const live = seededLedger({ subscription: { plan } });
    const okRes = await token.handle(tokenRequest('POST', { domains: ['a.example'] }), tokenDeps(live));
    assert.equal(okRes.status, 200, plan);
  }
});

/* ------------------------------------------------- POST /api/entitlement */

test('POST /api/entitlement confirms a live credential for /s/ and says nothing about domains', async () => {
  const ledger = seededLedger();
  const wl = await credential();
  const original = globalThis.fetch;
  globalThis.fetch = ledger.fetchImpl;
  try {
    const res = await entitlement.POST(new Request('https://helpmebreath.com/api/entitlement', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://anything.example' },
      body: JSON.stringify({ token: wl, host: 'thief.example.net' }),
    }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.whitelabel, true);
    assert.equal(body.typ, 'emb');
    assert.equal('dom' in body, false);

    ledger.tables.embed_tokens[0].revoked_at = new Date(NOW).toISOString();
    const revoked = await (await entitlement.POST(new Request('https://helpmebreath.com/api/entitlement', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: wl }),
    }))).json();
    assert.deepEqual(revoked, { ok: false, reason: 'revoked' });

    const ent = await credential({ typ: 'ent' });
    const wrong = await (await entitlement.POST(new Request('https://helpmebreath.com/api/entitlement', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ent }),
    }))).json();
    assert.deepEqual(wrong, { ok: false, reason: 'wrong_type' });
  } finally {
    globalThis.fetch = original;
  }
});
