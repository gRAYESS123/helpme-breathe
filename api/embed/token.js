/**
 * /api/embed/token — a subscriber's embed credentials
 * (docs/private/ACCOUNTS_BILLING_DESIGN.md §9.3).
 *
 *   POST   /api/embed/token                       { domains[], label? }  -> mint a new group
 *   GET    /api/embed/token                                             -> list groups + credentials
 *   GET    /api/embed/token?rotate=1&token_id=et_… (or body)           -> rotate one group
 *   DELETE /api/embed/token                       { token_id }          -> revoke a whole group
 *
 * Every call needs `Authorization: Bearer <Supabase access token>` and goes
 * through assertLiveUser() (§4.5), because minting a credential is a
 * money-touching call. Identity comes from the verified JWT's `sub`; nothing in
 * the body ever names a user (§3.3).
 *
 * THE GROUP MODEL
 *
 * `token_id` (the `gid` claim) names a credential GROUP the subscriber sees on
 * /account. Every issued credential is its own embed_credentials row with its
 * own `jti`. Rotating a group issues a fresh `jti` and stamps `superseded_at`
 * on the live ones, which then keep verifying for 48 hours — long enough that
 * a cached snippet keeps working while the subscriber updates it. Revoking a
 * group stamps `revoked_at` on the group AND on each of its credentials, so
 * every `jti` dies at once and the frame's per-row check agrees with the
 * group check whichever it reads first.
 *
 * WHO MAY MINT
 *
 * Any subscriber whose access has not lapsed AND whose plan carries the `com`
 * claim, decided by api/entitlement.js#ownerStanding() — a thin wrapper over
 * the same api/_lib/entitlement.js#entitlementFor() that api/me.js and the
 * frame use. One plan includes everything, so that is every subscriber:
 * commercialFor() answers true for every plan we sell. (The design once held
 * a second, practitioner-only plan that would have narrowed this; the owner
 * closed that option on 2026-09-12.)
 *
 * Credentials expire 30 days after issue (§9.3's example: iat + 30 d) and the
 * frame additionally checks the row's `expires_at`, the group's `revoked_at`
 * and the subscriber's `access_until` on every render, so a cancelled
 * subscription stops white-labelling at the next page load regardless of `exp`.
 *
 * Provider-neutral: nothing here knows which merchant of record is in use.
 */

import { bearerToken } from '../_lib/authz.js';
import { kidFor, signToken } from '../_lib/crypto.js';
import { dblimitCheck } from '../_lib/dblimit.js';
import { readEnv, requireEnv } from '../_lib/env.js';
import {
  errorResponse,
  json,
  methodNotAllowed,
  preflight,
  readJsonBody,
} from '../_lib/respond.js';
import { assertLiveUser } from '../_lib/supabase.js';
import {
  GROUP_ID_RE,
  OWNER_COLUMNS,
  ROTATION_OVERLAP_MS,
  normalizeDomainList,
  ownerStanding,
  randomId,
  rest,
} from '../entitlement.js';
import { FRAME_PATH } from './frame.js';

export { bearerToken };

export const config = { runtime: 'nodejs', maxDuration: 15 };

const METHODS = 'GET, POST, DELETE, OPTIONS';

/** How long an issued credential verifies for. */
export const CREDENTIAL_DAYS = 30;

/** Domains per group. */
export const MAX_DOMAINS = 10;

/** Label length on /account. */
export const MAX_LABEL = 60;

/** Mint/rotate/revoke calls per subscriber per hour, counted in Postgres. */
const LIMIT_BUCKET_SECONDS = 3600;
const LIMIT_PER_HOUR = 30;

/** RFC 1123 hostname: labels of letters, digits and hyphens, dot separated. */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/* ------------------------------------------------------------- validation --- */

/**
 * Validate and normalise the domains a credential is bound to.
 *
 * Each entry is put through the URL parser so a pasted `https://Clinic.Example/`
 * becomes `clinic.example` and an IDN becomes its punycode form — which is
 * also how the Referer header will spell it. Wildcards are refused: the frame
 * compares exact hostnames, so `*.clinic.example` would never match anything.
 * Our own site is refused because a credential bound to helpmebreath.com would
 * white-label our own /embed preview, which is not what the feature is for.
 *
 * @param {unknown} input
 * @returns {{ok:true, domains:string[]}|{ok:false, reason:string}}
 */
export function validateDomains(input) {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, reason: 'domains_required' };
  if (input.length > MAX_DOMAINS) return { ok: false, reason: 'too_many_domains' };

  const ownHost = (() => {
    try {
      return new URL(readEnv('SITE_ORIGIN', 'https://helpmebreath.com')).hostname.toLowerCase();
    } catch {
      return 'helpmebreath.com';
    }
  })();

  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string' || raw.length > 300) return { ok: false, reason: 'invalid_domain' };
    let text = raw.trim().toLowerCase();
    if (!text) return { ok: false, reason: 'invalid_domain' };
    if (text.includes('*')) return { ok: false, reason: 'wildcard_not_allowed' };
    if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = `https://${text}`;
    let host;
    try {
      host = new URL(text).hostname.replace(/\.$/, '');
    } catch {
      return { ok: false, reason: 'invalid_domain' };
    }
    if (!host || host.length > 253 || !HOSTNAME_RE.test(host)) return { ok: false, reason: 'invalid_domain' };
    if (host === ownHost || host.endsWith(`.${ownHost}`)) return { ok: false, reason: 'own_site_not_allowed' };
    if (!out.includes(host)) out.push(host);
  }
  return { ok: true, domains: out };
}

/**
 * A short human label: plain text, no control characters, trimmed.
 * @param {unknown} input
 * @returns {string}
 */
export function cleanLabel(input) {
  if (typeof input !== 'string') return '';
  let out = '';
  for (let i = 0; i < input.length && out.length < MAX_LABEL; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) out += ' ';
    else if (code >= 32 && code !== 127) out += input.charAt(i);
  }
  return out.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------ the ledger --- */

/** Site origin for snippets. */
function siteOrigin() {
  return readEnv('SITE_ORIGIN', 'https://helpmebreath.com').replace(/\/+$/, '');
}

/** HTML-attribute-safe: the token alphabet is [A-Za-z0-9._~-] so this is belt and braces. */
function attr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * The two snippets a subscriber can paste. The loader form is what /embed
 * recommends (it resizes itself); the iframe form is for hosts that strip
 * script tags. Both point white-label loads at the frame function, and the
 * iframe form pins a referrer policy so a host page with `no-referrer` set
 * site-wide still sends the origin the domain check needs.
 */
export function snippetsFor(token) {
  const origin = siteOrigin();
  const wl = attr(token);
  return {
    snippet: `<script src="${origin}/embed/v1/breathe.js" data-wl="${wl}"></script>`,
    iframe_snippet:
      `<iframe src="${origin}${FRAME_PATH}?wl=${wl}" title="Guided breathing exercise" ` +
      'referrerpolicy="strict-origin-when-cross-origin" loading="lazy" allow="screen-wake-lock" ' +
      'style="display:block;width:100%;max-width:100%;height:560px;border:0;background:transparent"></iframe>',
  };
}

/**
 * Sign one credential for a group.
 * @returns {Promise<{token:string, jti:string, issued_at:string, expires_at:string}>}
 */
async function issueCredential({ sub, gid, domains, jti, now, secret }) {
  const iat = Math.floor(now / 1000);
  const exp = iat + CREDENTIAL_DAYS * 24 * 60 * 60;
  const payload = { v: 3, typ: 'emb', sub, gid, jti, dom: domains.slice(), iat, exp, kid: await kidFor(secret) };
  return {
    token: await signToken(payload, secret),
    jti,
    issued_at: new Date(iat * 1000).toISOString(),
    expires_at: new Date(exp * 1000).toISOString(),
  };
}

/** Is the credential row still usable, on this clock? */
function credentialLive(row, now) {
  if (!row || row.revoked_at) return false;
  const expires = row.expires_at ? Date.parse(row.expires_at) : NaN;
  if (!Number.isFinite(expires) || now >= expires) return false;
  const superseded = row.superseded_at ? Date.parse(row.superseded_at) : NaN;
  if (Number.isFinite(superseded) && now >= superseded + ROTATION_OVERLAP_MS) return false;
  return true;
}

function publicCredential(row, now) {
  const superseded = row.superseded_at ? Date.parse(row.superseded_at) : NaN;
  return {
    jti: row.jti,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    superseded_at: row.superseded_at || null,
    overlap_ends_at: Number.isFinite(superseded) ? new Date(superseded + ROTATION_OVERLAP_MS).toISOString() : null,
    revoked_at: row.revoked_at || null,
    last_seen_at: row.last_seen_at || null,
    hit_count: Number(row.hit_count || 0),
    live: credentialLive(row, now),
  };
}

/* ------------------------------------------------------------------ core --- */

/**
 * The default collaborators: the authoritative session check from
 * api/_lib/supabase.js, the never-throwing ledger reader shared with the
 * frame, and the Postgres-backed limiter from api/_lib/dblimit.js. Tests hand
 * `handle()` stubs with the same shape.
 */
function defaultDeps() {
  return {
    assertLiveUser,
    rest,
    limit: (bucket, windowSeconds, limit) => dblimitCheck(bucket, windowSeconds, limit),
    now: () => Date.now(),
    secret: () => requireEnv(['LICENSE_SECRET']).LICENSE_SECRET,
    newId: randomId,
  };
}

/**
 * Handle one request with the given collaborators. Exported so tests can run
 * the whole endpoint with a stubbed authenticator and ledger.
 *
 * @param {Request} request
 * @param {{
 *   assertLiveUser:(jwt:string)=>Promise<{ok:boolean, sub?:string|null, reason?:string}>,
 *   rest:Function,
 *   limit:(bucket:string, windowSeconds:number, limit:number)=>Promise<{allowed:boolean, reason:string}>,
 *   now:()=>number, secret:()=>string, newId:(prefix:string)=>string
 * }} deps
 * @returns {Promise<Response>}
 */
export async function handle(request, deps) {
  const respond = (status, body, headers) => json(status, body, { request, methods: METHODS, headers });
  const method = request.method.toUpperCase();

  try {
    if (method === 'OPTIONS') return preflight(request, { methods: METHODS });
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
      return methodNotAllowed(request, METHODS);
    }

    const jwt = bearerToken(request);
    if (!jwt) return respond(401, { ok: false, reason: 'unauthenticated' });

    // Money-touching: the round-trip to /auth/v1/user, not just the local JWT
    // check (§4.5). Identity is the verified `sub` and nothing else (§3.3).
    const who = await deps.assertLiveUser(jwt);
    if (!who || !who.ok) {
      const unavailable = who && (who.reason === 'auth_unavailable' || who.reason === 'jwks_unavailable');
      if (unavailable) {
        return respond(503, { ok: false, reason: 'auth_unavailable', error: 'Sign-in is briefly unavailable. Please try again in a minute.' }, { 'Retry-After': '30' });
      }
      return respond(401, { ok: false, reason: 'unauthenticated' });
    }
    const sub = typeof who.sub === 'string' ? who.sub : '';
    if (!sub) return respond(401, { ok: false, reason: 'unauthenticated' });

    const now = deps.now();
    const nowIso = new Date(now).toISOString();

    // Read the body once, for the methods that carry one.
    let body = {};
    if (method !== 'GET') {
      const parsed = await readJsonBody(request, { maxBytes: 4096 });
      if (!parsed.ok && parsed.reason !== 'not_json') return respond(400, { ok: false, reason: 'bad_request' });
      body = parsed.ok ? parsed.data : {};
    }
    const url = new URL(request.url);
    const wantsRotate = url.searchParams.get('rotate') === '1' || body.rotate === true;

    /* ------------------------------------------------------------- list --- */

    if (method === 'GET' && !wantsRotate) {
      const groups = await deps.rest('GET', 'embed_tokens', {
        query: {
          user_id: `eq.${sub}`,
          select: 'token_id,label,domains,created_at,revoked_at,last_seen_at,hit_count,verify_count_30d',
          order: 'created_at.desc',
          limit: '50',
        },
        timeoutMs: 8000,
      });
      if (!groups.ok) return respond(503, { ok: false, reason: 'ledger_unavailable' });
      const rows = Array.isArray(groups.data) ? groups.data : [];

      let credentials = [];
      const ids = rows.map((row) => row.token_id).filter((id) => GROUP_ID_RE.test(String(id || '')));
      if (ids.length) {
        const creds = await deps.rest('GET', 'embed_credentials', {
          query: {
            token_id: `in.(${ids.join(',')})`,
            select: 'jti,token_id,issued_at,expires_at,superseded_at,revoked_at,last_seen_at,hit_count',
            order: 'issued_at.desc',
            limit: '500',
          },
          timeoutMs: 8000,
        });
        if (!creds.ok) return respond(503, { ok: false, reason: 'ledger_unavailable' });
        credentials = Array.isArray(creds.data) ? creds.data : [];
      }

      return respond(200, {
        ok: true,
        frame_path: FRAME_PATH,
        groups: rows.map((row) => ({
          token_id: row.token_id,
          label: row.label || '',
          domains: normalizeDomainList(row.domains),
          created_at: row.created_at,
          revoked_at: row.revoked_at || null,
          last_seen_at: row.last_seen_at || null,
          hit_count: Number(row.hit_count || 0),
          verify_count_30d: Number(row.verify_count_30d || 0),
          credentials: credentials
            .filter((cred) => cred.token_id === row.token_id)
            .map((cred) => publicCredential(cred, now)),
        })),
      });
    }

    /* ---------------------------------------------- the money-touching calls --- */

    // Subscriber only, with the `com` claim (§7.2, §9.3): every row for the
    // user goes through entitlementFor(), the one function that decides tier
    // and commercial rights, so this gate, api/me.js and the frame agree.
    const subs = await deps.rest('GET', 'subscriptions', {
      query: { user_id: `eq.${sub}`, select: OWNER_COLUMNS, order: 'created_at.asc', limit: '50' },
      timeoutMs: 8000,
    });
    if (!subs.ok) return respond(503, { ok: false, reason: 'ledger_unavailable' });
    const owner = ownerStanding(subs.data, now);
    if (owner.reason === 'lapsed') return respond(403, { ok: false, reason: 'subscription_required' });
    if (!owner.ok) return respond(403, { ok: false, reason: 'commercial_plan_required' });

    // Counted in Postgres (api/_lib/dblimit.js), not in per-instance memory.
    // A limiter that cannot be reached is a no: nothing below could be written
    // either, and failing closed here costs one retry, not a credential.
    const limit = await deps.limit(`embed:${sub}`, LIMIT_BUCKET_SECONDS, LIMIT_PER_HOUR);
    if (!limit || limit.reason === 'limiter_unavailable') return respond(503, { ok: false, reason: 'ledger_unavailable' });
    if (!limit.allowed) return respond(429, { ok: false, reason: 'rate_limited' }, { 'Retry-After': '3600' });

    const secret = deps.secret();

    /* ------------------------------------------------------------ revoke --- */

    if (method === 'DELETE') {
      const gid = typeof body.token_id === 'string' ? body.token_id.trim() : String(url.searchParams.get('token_id') || '').trim();
      if (!GROUP_ID_RE.test(gid)) return respond(400, { ok: false, reason: 'token_id_required' });

      const group = await deps.rest('PATCH', 'embed_tokens', {
        query: { token_id: `eq.${gid}`, user_id: `eq.${sub}`, revoked_at: 'is.null', select: 'token_id' },
        body: { revoked_at: nowIso },
        prefer: 'return=representation',
        timeoutMs: 8000,
      });
      if (!group.ok) return respond(503, { ok: false, reason: 'ledger_unavailable' });
      if (!Array.isArray(group.data) || group.data.length === 0) {
        // Nothing to stamp: either not this subscriber's group, or already
        // revoked. Revoking twice is a no-op with the original timestamp, so a
        // double click on /account never reads as "not found".
        const existing = await deps.rest('GET', 'embed_tokens', {
          query: { token_id: `eq.${gid}`, user_id: `eq.${sub}`, select: 'token_id,revoked_at', limit: '1' },
          timeoutMs: 8000,
        });
        if (!existing.ok) return respond(503, { ok: false, reason: 'ledger_unavailable' });
        const row = Array.isArray(existing.data) ? existing.data[0] : null;
        if (!row || !row.revoked_at) return respond(404, { ok: false, reason: 'not_found' });
        return respond(200, { ok: true, token_id: gid, revoked_at: row.revoked_at, credentials_revoked: [], already_revoked: true });
      }

      const creds = await deps.rest('PATCH', 'embed_credentials', {
        query: { token_id: `eq.${gid}`, revoked_at: 'is.null', select: 'jti' },
        body: { revoked_at: nowIso },
        prefer: 'return=representation',
        timeoutMs: 8000,
      });
      // The group row is already revoked, which the frame checks first; a
      // failure here only means the per-credential stamp is missing.
      const revoked = creds.ok && Array.isArray(creds.data) ? creds.data.map((row) => row.jti) : [];
      console.log('[embed-token] revoked', { sub, gid, credentials: revoked.length });
      return respond(200, { ok: true, token_id: gid, revoked_at: nowIso, credentials_revoked: revoked });
    }

    /* ------------------------------------------------------------ rotate --- */

    if (wantsRotate) {
      const gid = typeof body.token_id === 'string' ? body.token_id.trim() : String(url.searchParams.get('token_id') || '').trim();
      if (!GROUP_ID_RE.test(gid)) return respond(400, { ok: false, reason: 'token_id_required' });

      const group = await deps.rest('GET', 'embed_tokens', {
        query: { token_id: `eq.${gid}`, user_id: `eq.${sub}`, select: 'token_id,domains,revoked_at', limit: '1' },
        timeoutMs: 8000,
      });
      if (!group.ok) return respond(503, { ok: false, reason: 'ledger_unavailable' });
      const row = Array.isArray(group.data) ? group.data[0] : null;
      if (!row) return respond(404, { ok: false, reason: 'not_found' });
      if (row.revoked_at) return respond(409, { ok: false, reason: 'revoked' });

      const domains = normalizeDomainList(row.domains);
      const jti = deps.newId('ec_');
      const issued = await issueCredential({ sub, gid, domains, jti, now, secret });

      const inserted = await deps.rest('POST', 'embed_credentials', {
        body: { jti, token_id: gid, issued_at: issued.issued_at, expires_at: issued.expires_at },
        prefer: 'return=minimal',
        timeoutMs: 8000,
      });
      if (!inserted.ok) return respond(503, { ok: false, reason: 'ledger_unavailable' });

      // Only after the new one exists: the old ones start their 48-hour overlap.
      const superseded = await deps.rest('PATCH', 'embed_credentials', {
        query: { token_id: `eq.${gid}`, jti: `neq.${jti}`, superseded_at: 'is.null', revoked_at: 'is.null', select: 'jti' },
        body: { superseded_at: nowIso },
        prefer: 'return=representation',
        timeoutMs: 8000,
      });
      const supersededIds = superseded.ok && Array.isArray(superseded.data) ? superseded.data.map((r) => r.jti) : [];

      console.log('[embed-token] rotated', { sub, gid, jti, superseded: supersededIds.length });
      return respond(200, {
        ok: true,
        action: 'rotate',
        token_id: gid,
        jti,
        expires_at: issued.expires_at,
        token: issued.token,
        domains,
        superseded: supersededIds,
        overlap_ends_at: new Date(now + ROTATION_OVERLAP_MS).toISOString(),
        ...snippetsFor(issued.token),
      });
    }

    /* -------------------------------------------------------------- mint --- */

    const domains = validateDomains(body.domains);
    if (!domains.ok) return respond(400, { ok: false, reason: domains.reason });
    const label = cleanLabel(body.label);

    const gid = deps.newId('et_');
    const jti = deps.newId('ec_');

    const group = await deps.rest('POST', 'embed_tokens', {
      body: { user_id: sub, token_id: gid, domains: domains.domains, label: label || null },
      prefer: 'return=minimal',
      timeoutMs: 8000,
    });
    if (!group.ok) return respond(503, { ok: false, reason: 'ledger_unavailable' });

    const issued = await issueCredential({ sub, gid, domains: domains.domains, jti, now, secret });
    const inserted = await deps.rest('POST', 'embed_credentials', {
      body: { jti, token_id: gid, issued_at: issued.issued_at, expires_at: issued.expires_at },
      prefer: 'return=minimal',
      timeoutMs: 8000,
    });
    if (!inserted.ok) {
      // Do not leave an empty group behind. Best effort; the row is harmless if this fails too.
      await deps.rest('DELETE', 'embed_tokens', { query: { token_id: `eq.${gid}`, user_id: `eq.${sub}` }, timeoutMs: 4000 });
      return respond(503, { ok: false, reason: 'ledger_unavailable' });
    }

    console.log('[embed-token] created', { sub, gid, jti, domains: domains.domains.length });
    return respond(200, {
      ok: true,
      action: 'create',
      token_id: gid,
      jti,
      expires_at: issued.expires_at,
      token: issued.token,
      domains: domains.domains,
      label,
      ...snippetsFor(issued.token),
    });
  } catch (error) {
    return errorResponse(error, request, { methods: METHODS, label: 'embed-token' });
  }
}

/* ------------------------------------------------------------- handlers --- */

export async function OPTIONS(request) {
  return preflight(request, { methods: METHODS });
}

export async function GET(request) {
  return handle(request, defaultDeps());
}

export async function POST(request) {
  return handle(request, defaultDeps());
}

export async function DELETE(request) {
  return handle(request, defaultDeps());
}
