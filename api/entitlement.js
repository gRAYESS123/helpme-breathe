/**
 * POST /api/entitlement — is this embed credential live?
 *
 * Request  { token: string }
 * Response { ok: true,  typ: 'emb', tier: 'pro', whitelabel: true, exp, gid }
 *          { ok: false, reason }
 *
 * WHAT THIS ENDPOINT IS FOR NOW (docs/private/ACCOUNTS_BILLING_DESIGN.md §9.2)
 *
 * The client session link at /s/?c=… carries a subscriber's embed credential in
 * its `wl` field. That page is hosted on helpmebreath.com itself, so the only
 * question is whether the credential is genuine and still live: signed by us,
 * not expired, not revoked, not past its rotation overlap, and issued by a
 * subscriber whose access has not lapsed and whose plan carries the `com`
 * claim (§7.2 — every plan does; there is one plan). This endpoint answers exactly
 * that, from the signature and the ledger in Postgres, through the same
 * api/_lib/entitlement.js#entitlementFor() that api/me.js uses.
 *
 * WHAT IT NO LONGER CLAIMS
 *
 * Earlier revisions said this endpoint checked the embedding domain. It could
 * not: the embed frame is served from our own origin, so its POST here was
 * same-origin and `Origin`/`Referer` always said helpmebreath.com. The domain
 * check now happens where the embedding origin is actually observable — on the
 * frame *document* request, in api/embed/frame.js — and the frame never calls
 * this endpoint at all. There is no `host` parameter, no `dom` comparison, and
 * a `host` in the body is ignored.
 *
 * WHAT IT ACCEPTS
 *
 * Only v3 credentials with `typ: 'emb'` (§7.2, §9.3). The account entitlement
 * token (`typ: 'ent'`) is a 14-day bearer credential for the signed-in browser
 * and has no business inside a shareable link, so it is refused here with
 * `wrong_type`. A retired v1 licence token is refused the same way whether or
 * not api/_lib/crypto.js still accepts its version: it is not an embed
 * credential, which is the clean deletion §11.1 asks for.
 *
 * A well-formed request always gets a 200 with the verdict in `ok`. Only a
 * missing or malformed body (400) or a flood (429) gets a non-200, so the /s/
 * page has one code path: `ok && whitelabel` removes the attribution, anything
 * else leaves the free, attributed page exactly as it was.
 *
 * CORS is `*` with no credentials, as before: the answer exposes nothing the
 * caller does not already hold (the payload half of a token is plain base64url
 * JSON) and never sets a cookie.
 *
 * SHARED HELPERS
 *
 * api/embed/frame.js and api/embed/token.js import the credential verifier and
 * the ledger reader from this file. The ledger reader is a never-throwing
 * wrapper around api/_lib/supabase.js#db() — the one PostgREST client in the
 * repo — because the frame is an unauthenticated hot path that must degrade to
 * "cannot verify" rather than to a stack trace. Everything here is `fetch` +
 * WebCrypto over api/_lib/crypto.js.
 */

import { b64urlEncode, verifyToken } from './_lib/crypto.js';
import { entitlementFor } from './_lib/entitlement.js';
import { readEnv, requireEnv } from './_lib/env.js';
import { createLimiter, rateLimitHeaders } from './_lib/ratelimit.js';
import {
  clientIp,
  errorResponse,
  json,
  methodNotAllowed,
  preflight,
  readJsonBody,
} from './_lib/respond.js';
import { db } from './_lib/supabase.js';

export const config = { runtime: 'nodejs', maxDuration: 15 };

const METHODS = 'POST, OPTIONS';

/** A rotated credential keeps working this long after its successor is issued (§9.3). */
export const ROTATION_OVERLAP_MS = 48 * 60 * 60 * 1000;

/** Shape of the two ids a credential carries. Short, URL-safe, ours. */
export const GROUP_ID_RE = /^et_[A-Za-z0-9_-]{8,64}$/;
export const CREDENTIAL_ID_RE = /^ec_[A-Za-z0-9_-]{8,64}$/;

/** A Supabase user id. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A `wl` value as it arrives in a query string or a /s/ payload. */
export const WL_RE = /^[A-Za-z0-9._~-]{8,4096}$/;

/**
 * Generous on purpose: an office behind one NAT address shares a bucket, and a
 * 429 here would put the attribution line back on a paying subscriber's page.
 */
const limiter = createLimiter({ name: 'entitlement', limit: 120, windowMs: 60 * 1000 });

/* ------------------------------------------------------------ the ledger --- */

/**
 * The Postgres connection, or null when the deployment has no Supabase yet.
 * Read per call, never cached, so a redeploy with new env values takes effect.
 * @returns {{url:string, key:string}|null}
 */
export function ledgerConfig() {
  const url = readEnv('SUPABASE_URL').replace(/\/+$/, '');
  const key = readEnv('SUPABASE_SECRET_KEY');
  if (!url || !key || !/^https:\/\//.test(url)) return null;
  return { url, key };
}

/**
 * One PostgREST call with the secret key, through api/_lib/supabase.js#db().
 * Never throws: an unconfigured ledger, a network error, a timeout or a
 * non-2xx comes back as `{ ok: false }` so every caller degrades to "cannot
 * verify" rather than to a stack trace. The frame's rendering path must never
 * surface a database error to a clinic's visitor (§9.2).
 *
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
 * @param {string} path e.g. 'embed_credentials' or 'rpc/bump_rate_limit'
 * @param {{query?:Record<string,string>, body?:unknown, prefer?:string, timeoutMs?:number, fetchImpl?:typeof fetch}} [options]
 * @returns {Promise<{ok:boolean, status:number, data:any, reason?:string}>}
 */
export async function rest(method, path, options = {}) {
  const cfg = ledgerConfig();
  if (!cfg) return { ok: false, status: 0, data: null, reason: 'ledger_unconfigured' };

  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 2500;
  try {
    const data = await db(path, {
      method,
      query: options.query,
      body: options.body,
      prefer: options.prefer,
      timeoutMs,
      ctx: { url: cfg.url, secretKey: cfg.key, fetchImpl: options.fetchImpl },
    });
    return { ok: true, status: 200, data: data === undefined ? null : data };
  } catch (error) {
    const status = error && Number.isFinite(error.status) ? error.status : 0;
    // SupabaseError messages name the path and status, never a key or a row.
    console.warn('[entitlement] ledger call failed', {
      method,
      path,
      status,
      reason: error && error.reason ? error.reason : 'error',
    });
    return { ok: false, status, data: null, reason: status ? 'ledger_error' : 'ledger_unavailable' };
  }
}

/**
 * Does the subscriber still have access? The maximum `access_until` across
 * their subscription rows is the one column the entitlement layer reads (§3.1,
 * §6.5). No row, or every row in the past, means lapsed.
 *
 * @param {Array<{access_until?:string|null}>|null|undefined} rows
 * @param {number} [now]
 * @returns {boolean}
 */
export function ownerLive(rows, now = Date.now()) {
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => {
    const until = row && row.access_until ? Date.parse(row.access_until) : NaN;
    return Number.isFinite(until) && until > now;
  });
}

/** The columns the owner check needs. `select=*` would drag display_* along for nothing. */
export const OWNER_COLUMNS = 'access_until,status,plan,last_event_at,updated_at,created_at';

/**
 * The issuing subscriber's standing, through the same function api/me.js uses
 * (api/_lib/entitlement.js#entitlementFor), so the frame, the /s/ link and
 * the account page can never disagree about who is a subscriber and who holds
 * the `com` claim. There is one plan and it includes commercial use, so every
 * live pro entitlement is commercial; a credential minted before the
 * subscription lapses stops white-labelling at the next load.
 *
 * `not_commercial` stays in the vocabulary as the "pro but no `com`" branch —
 * unreachable while one plan is the whole offer, and the caller's fallback.
 *
 * @param {object[]|null|undefined} rows every `subscriptions` row for the user
 * @param {number} now
 * @returns {{ok:boolean, reason:'ok'|'lapsed'|'not_commercial', plan:string|null}}
 */
export function ownerStanding(rows, now) {
  const ent = entitlementFor(Array.isArray(rows) ? rows : [], now);
  if (ent.tier !== 'pro') return { ok: false, reason: 'lapsed', plan: ent.plan };
  if (!ent.commercial) return { ok: false, reason: 'not_commercial', plan: ent.plan };
  return { ok: true, reason: 'ok', plan: ent.plan };
}

/** Lowercase, trimmed, no trailing dot, no wildcard prefix; empties dropped. */
export function normalizeDomainList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const host = entry.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

/* ------------------------------------------------------- the credential --- */

/**
 * Verify an embed credential's signature and shape.
 *
 * Payload (§9.3): { v:3, typ:'emb', sub, gid, jti, dom[], iat, exp, kid }.
 *
 * api/_lib/crypto.js#verifyToken accepts `v === 1 || v === 3` (the
 * entitlement-core task's edit) and checks shape -> signature -> version ->
 * kid -> expiry. It is called with `allowExpired` so that an expired credential
 * is reported as `expired` here only after its signature and type have been
 * checked — a forged token never learns which clock it failed on.
 *
 * @param {string} token
 * @param {string} secret LICENSE_SECRET
 * @param {{now?:number}} [options]
 * @returns {Promise<{ok:boolean, payload:object|null, reason:string}>}
 *   reason: ok | missing | malformed | bad_signature | bad_payload | bad_version |
 *           kid_mismatch | wrong_type | expired
 */
export async function verifyEmbedCredential(token, secret, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const verified = await verifyToken(token, secret, { now, allowExpired: true });
  if (!verified.ok) return { ok: false, payload: null, reason: verified.reason };

  const payload = verified.payload;
  if (!payload || payload.v !== 3 || payload.typ !== 'emb') {
    return { ok: false, payload: null, reason: 'wrong_type' };
  }
  if (
    typeof payload.sub !== 'string' || !UUID_RE.test(payload.sub) ||
    typeof payload.gid !== 'string' || !GROUP_ID_RE.test(payload.gid) ||
    typeof payload.jti !== 'string' || !CREDENTIAL_ID_RE.test(payload.jti) ||
    !Array.isArray(payload.dom) || payload.dom.length > 20 ||
    !Number.isFinite(Number(payload.iat)) || !Number.isFinite(Number(payload.exp))
  ) {
    return { ok: false, payload: null, reason: 'bad_payload' };
  }
  if (now >= Number(payload.exp) * 1000) {
    return { ok: false, payload, reason: 'expired' };
  }
  return { ok: true, payload, reason: 'ok' };
}

/**
 * Check a signature-verified credential against the ledger: the `jti` row, its
 * group, and the issuing subscriber's access. Three reads, in parallel — the
 * payload is signed, so `gid` and `sub` can be looked up directly and
 * cross-checked afterwards rather than chained.
 *
 * Any ledger failure answers `unavailable`. The frame and /s/ treat that as
 * "attribution stays"; nothing here ever grants on a blank.
 *
 * @param {object} payload a payload from verifyEmbedCredential()
 * @param {{now?:number, fetchImpl?:typeof fetch, timeoutMs?:number}} [options]
 * @returns {Promise<{ok:boolean, reason:string, credential?:object, group?:object, domains?:string[]}>}
 *   reason: ok | unavailable | unknown | mismatch | revoked | superseded | expired | lapsed | not_commercial
 */
export async function credentialStatus(payload, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const io = { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs };

  const [cred, group, subs] = await Promise.all([
    rest('GET', 'embed_credentials', {
      ...io,
      query: {
        jti: `eq.${payload.jti}`,
        select: 'jti,token_id,issued_at,expires_at,superseded_at,revoked_at,hit_count',
        limit: '1',
      },
    }),
    rest('GET', 'embed_tokens', {
      ...io,
      query: {
        token_id: `eq.${payload.gid}`,
        select: 'token_id,user_id,domains,revoked_at,hit_count,verify_count_30d',
        limit: '1',
      },
    }),
    rest('GET', 'subscriptions', {
      ...io,
      query: {
        user_id: `eq.${payload.sub}`,
        select: OWNER_COLUMNS,
        order: 'created_at.asc',
        limit: '50',
      },
    }),
  ]);

  if (!cred.ok || !group.ok || !subs.ok) return { ok: false, reason: 'unavailable' };

  const credential = Array.isArray(cred.data) ? cred.data[0] : null;
  const groupRow = Array.isArray(group.data) ? group.data[0] : null;
  if (!credential || !groupRow) return { ok: false, reason: 'unknown' };
  if (credential.token_id !== payload.gid || groupRow.user_id !== payload.sub) {
    return { ok: false, reason: 'mismatch' };
  }
  if (groupRow.revoked_at || credential.revoked_at) return { ok: false, reason: 'revoked' };

  const superseded = credential.superseded_at ? Date.parse(credential.superseded_at) : NaN;
  if (Number.isFinite(superseded) && now >= superseded + ROTATION_OVERLAP_MS) {
    return { ok: false, reason: 'superseded' };
  }
  const expires = credential.expires_at ? Date.parse(credential.expires_at) : NaN;
  if (!Number.isFinite(expires) || now >= expires) return { ok: false, reason: 'expired' };

  const owner = ownerStanding(subs.data, now);
  if (!owner.ok) return { ok: false, reason: owner.reason };

  return {
    ok: true,
    reason: 'ok',
    credential,
    group: groupRow,
    domains: normalizeDomainList(groupRow.domains),
  };
}

/**
 * Count a verified render, sampled 1-in-10 so the write stays cheap (§9.4).
 * Best effort: a failure here changes nothing for the visitor.
 *
 * @param {{credential:object, group:object}} status from credentialStatus()
 * @param {{now?:number, sample?:number, fetchImpl?:typeof fetch}} [options]
 * @returns {Promise<boolean>} whether a write was attempted
 */
export async function recordHit(status, options = {}) {
  const roll = Number.isFinite(options.sample) ? options.sample : Math.random();
  if (roll >= 0.1) return false;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const seen = new Date(now).toISOString();
  const io = { fetchImpl: options.fetchImpl, timeoutMs: 1500, prefer: 'return=minimal' };
  await Promise.all([
    rest('PATCH', 'embed_credentials', {
      ...io,
      query: { jti: `eq.${status.credential.jti}` },
      body: { hit_count: Number(status.credential.hit_count || 0) + 1, last_seen_at: seen },
    }),
    rest('PATCH', 'embed_tokens', {
      ...io,
      query: { token_id: `eq.${status.group.token_id}` },
      body: {
        hit_count: Number(status.group.hit_count || 0) + 1,
        verify_count_30d: Number(status.group.verify_count_30d || 0) + 1,
        last_seen_at: seen,
      },
    }),
  ]);
  return true;
}

/** A short random id for a group or a credential: 15 random bytes, base64url. */
export function randomId(prefix) {
  const bytes = new Uint8Array(15);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}${b64urlEncode(bytes)}`;
}

/* ------------------------------------------------------------- handlers --- */

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function OPTIONS(request) {
  return preflight(request, { methods: METHODS, anyOrigin: true });
}

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function GET(request) {
  return methodNotAllowed(request, METHODS, { anyOrigin: true });
}

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  const respond = (status, body, headers) =>
    json(status, body, { request, methods: METHODS, anyOrigin: true, headers });

  try {
    const rate = limiter.check(clientIp(request));
    if (!rate.ok) {
      return respond(
        429,
        { ok: false, reason: 'rate_limited' },
        rateLimitHeaders(rate, { includeRetryAfter: true }),
      );
    }

    const parsed = await readJsonBody(request, { maxBytes: 8192 });
    if (!parsed.ok) return respond(400, { ok: false, reason: 'bad_request' });

    const token = typeof parsed.data.token === 'string' ? parsed.data.token.trim() : '';
    if (!token) return respond(400, { ok: false, reason: 'missing_token' });
    if (!WL_RE.test(token)) return respond(200, { ok: false, reason: 'malformed' });

    const env = requireEnv(['LICENSE_SECRET']);
    const verified = await verifyEmbedCredential(token, env.LICENSE_SECRET);
    if (!verified.ok) return respond(200, { ok: false, reason: verified.reason });

    const status = await credentialStatus(verified.payload);
    if (!status.ok) return respond(200, { ok: false, reason: status.reason });

    // Awaited: a serverless instance may freeze the moment the response is
    // returned, so a fire-and-forget write here would often never land.
    await recordHit(status);

    return respond(200, {
      ok: true,
      typ: 'emb',
      tier: 'pro',
      whitelabel: true,
      gid: verified.payload.gid,
      exp: Number(verified.payload.exp),
    });
  } catch (error) {
    return errorResponse(error, request, { methods: METHODS, anyOrigin: true, label: 'entitlement' });
  }
}
