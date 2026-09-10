/**
 * POST /api/entitlement — silent token refresh.
 *
 * Request  { token: string, key?: string }
 * Response { ok: true, token, tier, exp, act, dom?, refreshed, stale? }
 *          { ok: false, reason, tier?, exp? }
 *
 * Two paths:
 *
 *   CHEAP PATH (the common one). The token verifies and is not yet inside its
 *   recheck window. Nothing is asked of the merchant of record; the same token is
 *   handed straight back. This is what the embed frame calls on every load to
 *   decide whether to drop the attribution line, and it costs one HMAC.
 *
 *   RECHECK PATH. The token is inside its recheck window, or already expired.
 *   Now the provider is asked again, so a cancelled subscription or a refunded
 *   order stops working within a week without any revocation list and without a
 *   database.
 *
 * THE RECHECK WINDOW IS NEVER THE WHOLE TOKEN LIFETIME
 *
 * Subscription tokens live seven days (docs/AGENT_BRIEF.md §7). A flat "recheck
 * inside the last seven days" rule would therefore mark every practitioner token
 * stale the second it was minted, and the embed frame — which has only the token
 * and never the key — would never get a usable answer. So the window is
 * `min(7 days, half the token's own lifetime)`: 7 days for a 30-day lifetime
 * token, 3.5 days for a 7-day subscription token.
 *
 * WHY `key` IS OPTIONAL AND WHAT HAPPENS WITHOUT IT
 *
 * The token payload is fixed by docs/AGENT_BRIEF.md §7 and carries `sub`, a
 * one-way hash of the licence key. A hash cannot be turned back into a key, so a
 * recheck genuinely needs the key itself. The client therefore sends it along
 * when it has it (see the integration note in docs/API.md).
 *
 * When it does not, the answer depends on whether the token is still inside its
 * own lifetime. An unexpired token is valid — that is what the signature and
 * `exp` mean — so the honest answer is `ok: true` with `stale: true`, and the
 * caller keeps working until `exp`. Only an EXPIRED token with no key gets
 * `ok: false, reason: 'refresh_required'`, at which point the client leans on its
 * own 14-day offline grace. A refresh never increments the activation counter —
 * it is not an activation.
 *
 * CORS: this endpoint answers `Access-Control-Allow-Origin: *` because the embed
 * frame and the client session link are rendered inside third-party sites. See
 * the note at the top of api/_lib/respond.js for what that does and does not
 * expose. Credentials are never allowed, so no cookie is ever attached.
 */

import { buildPayload, kidFor, signToken, subFor, verifyToken } from './_lib/crypto.js';
import { isProduction, providerName, readEnv, requireEnv } from './_lib/env.js';
import {
  SKU_TIER,
  SKU_TOKEN_DAYS,
  getProvider,
  limitsForTier,
  messageForReason,
} from './_lib/providers/index.js';
import { createLimiter, rateLimitHeaders } from './_lib/ratelimit.js';
import {
  clientIp,
  errorResponse,
  json,
  methodNotAllowed,
  preflight,
  readJsonBody,
} from './_lib/respond.js';

export const config = { runtime: 'nodejs', maxDuration: 15 };

const METHODS = 'POST, OPTIONS';

/**
 * The longest a token may go unchecked once it is near expiry. Capped again at
 * half the token's own lifetime, so a 7-day subscription token is not born stale.
 */
export const RECHECK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The client keeps working this long past `exp` when refreshes fail (AGENT_BRIEF §7). */
export const OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

/** Optional variables the adapters read when present. */
const OPTIONAL_ENV = [
  'MOR_PRODUCT_LIFETIME',
  'MOR_PRODUCT_MONTHLY',
  'MOR_PRODUCT_PRACTITIONER',
  'MOR_PRODUCT_STUDIO',
  'MOR_PRODUCT_PACK',
  'MOR_API_BASE',
  'MOR_API_USERNAME',
  'MOR_API_PASSWORD',
];

/**
 * Refreshes are cheap and frequent; the limit only exists to stop a runaway loop.
 * It is deliberately generous because a whole office behind one NAT address, or a
 * busy practitioner site with several embeds, shares a bucket — and a 429 here
 * would put the attribution line back on a paying customer's widget.
 */
const limiter = createLimiter({ name: 'entitlement', limit: 120, windowMs: 60 * 1000 });

/**
 * Where a token sits relative to its expiry and the offline grace window.
 *
 * `recheckWindowMs` is `min(RECHECK_WINDOW_MS, lifetime / 2)`, where lifetime is
 * the token's own `exp - iat`. Without the second half of that expression a
 * 7-day subscription token would be inside its recheck window from the moment it
 * was signed, and the embed frame (token only, never the key) could never get a
 * usable answer.
 *
 * @param {object} payload a verified token payload
 * @param {number} [now] milliseconds since epoch
 * @returns {{expMs:number, msToExpiry:number, lifetimeMs:number, recheckWindowMs:number,
 *            expired:boolean, needsRecheck:boolean, withinGrace:boolean, graceEndsMs:number}}
 */
export function refreshWindow(payload, now = Date.now()) {
  const expSeconds = Number(payload && payload.exp);
  const iatSeconds = Number(payload && payload.iat);
  const expMs = Number.isFinite(expSeconds) ? expSeconds * 1000 : 0;
  const lifetimeMs =
    Number.isFinite(iatSeconds) && expSeconds > iatSeconds ? (expSeconds - iatSeconds) * 1000 : 0;
  const recheckWindowMs =
    lifetimeMs > 0 ? Math.min(RECHECK_WINDOW_MS, Math.floor(lifetimeMs / 2)) : RECHECK_WINDOW_MS;
  const msToExpiry = expMs - now;
  const graceEndsMs = expMs + OFFLINE_GRACE_MS;
  return {
    expMs,
    msToExpiry,
    lifetimeMs,
    recheckWindowMs,
    expired: msToExpiry <= 0,
    needsRecheck: msToExpiry <= recheckWindowMs,
    withinGrace: msToExpiry <= 0 && now < graceEndsMs,
    graceEndsMs,
  };
}

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
    if (!parsed.ok) {
      return respond(400, { ok: false, reason: 'bad_request' });
    }

    const token = typeof parsed.data.token === 'string' ? parsed.data.token.trim() : '';
    const key = typeof parsed.data.key === 'string' ? parsed.data.key.trim() : '';
    if (!token) return respond(400, { ok: false, reason: 'missing_token' });

    const env = requireEnv(['LICENSE_SECRET']);
    const secret = env.LICENSE_SECRET;

    // allowExpired: an expired token is still a question worth answering, and
    // the answer depends on the provider, not on the clock alone.
    const verified = await verifyToken(token, secret, { allowExpired: true });
    if (!verified.ok || !verified.payload) {
      return respond(200, { ok: false, reason: verified.reason });
    }

    const payload = verified.payload;
    const window = refreshWindow(payload);

    /** Hand the caller's own token back. `stale` says a recheck was wanted but could not run. */
    const keepToken = (stale) =>
      respond(200, {
        ok: true,
        token,
        tier: payload.tier,
        exp: payload.exp,
        act: payload.act,
        ...(payload.dom ? { dom: payload.dom } : {}),
        refreshed: false,
        ...(stale ? { stale: true } : {}),
      });

    if (!window.needsRecheck) {
      // Cheap path: still comfortably valid, hand the same token back untouched.
      return keepToken(false);
    }

    if (!key) {
      // An unexpired token is valid — that is what the signature and `exp` mean.
      // The embed frame only ever has the token, so answering `ok: false` here
      // would silently kill every white-label embed. Say yes, and say it is stale.
      if (!window.expired) return keepToken(true);

      return respond(200, {
        ok: false,
        reason: 'refresh_required',
        tier: payload.tier,
        exp: payload.exp,
        expired: true,
        graceEnds: Math.floor(window.graceEndsMs / 1000),
      });
    }

    // The key must be the one this token was minted for. Without this check the
    // wide-open CORS policy would let anyone swap a Pro key onto a Studio token.
    const sub = await subFor(key);
    if (sub !== payload.sub) {
      console.warn('[entitlement] key does not match token subject', { sub, tokenSub: payload.sub });
      return respond(200, { ok: false, reason: 'key_mismatch' });
    }

    // A fresh env object for the adapter. LICENSE_SECRET stays out of it.
    const providerEnv = requireEnv(['MOR_API_KEY']);
    for (const name of OPTIONAL_ENV) {
      const value = readEnv(name);
      if (value) providerEnv[name] = value;
    }

    const provider = getProvider(providerName());
    // `sub` rides along so the adapter can name the caller in a log line without
    // ever handling the key itself (AGENT_BRIEF section 2 rule 9).
    const lookup = await provider.lookup(key, { env: providerEnv, isProd: isProduction(), sub });

    if (!lookup.ok) {
      console.warn('[entitlement] recheck failed', { sub, provider: provider.id, reason: lookup.reason });

      // A provider outage must never revoke a paying customer. While the token
      // is still inside its own lifetime the answer is simply "keep what you
      // have"; past expiry we say so explicitly and let the client's grace logic
      // take over. A hard rejection (refunded, cancelled) falls through to the
      // plain `ok: false` below, which is the point of rechecking at all.
      const transient = lookup.reason === 'provider_unavailable' || lookup.reason === 'provider_error';
      if (transient && !window.expired) return keepToken(true);
      if (transient && window.withinGrace) {
        return respond(200, {
          ok: false,
          reason: 'provider_unavailable',
          tier: payload.tier,
          exp: payload.exp,
          graceEnds: Math.floor(window.graceEndsMs / 1000),
        });
      }
      return respond(200, {
        ok: false,
        reason: lookup.reason,
        message: messageForReason(lookup.reason, provider),
      });
    }

    const record = lookup.record;
    if (record.sku === 'pack') {
      return respond(200, { ok: false, reason: 'pack_only' });
    }

    const tier = SKU_TIER[record.sku];
    const limits = limitsForTier(tier);
    const kid = await kidFor(secret);

    // A refresh is not an activation: the counter is read, never incremented.
    const fresh = buildPayload({
      tier,
      sub,
      kid,
      act: record.activations,
      days: SKU_TOKEN_DAYS[record.sku],
      domains: limits.domains > 0 ? record.domains : [],
    });
    const freshToken = await signToken(fresh, secret);

    console.log('[entitlement] refreshed', { sub, tier, sku: record.sku, provider: provider.id });

    return respond(200, {
      ok: true,
      token: freshToken,
      tier,
      exp: fresh.exp,
      act: fresh.act,
      ...(fresh.dom ? { dom: fresh.dom } : {}),
      refreshed: true,
    });
  } catch (error) {
    return errorResponse(error, request, { methods: METHODS, anyOrigin: true, label: 'entitlement' });
  }
}
