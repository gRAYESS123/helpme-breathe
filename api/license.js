/**
 * POST /api/license — exchange a licence key for a signed entitlement token.
 *
 * Request  { key: string, domains?: string[] }
 * Response { ok: true, token, tier, activations, max }
 *          { ok: false, error, code }
 *
 * The merchant of record is the only ledger. There is no database: the key is
 * looked up live, the activation counter lives in the provider's own record, and
 * the answer is a short-lived HMAC token the browser keeps in localStorage.
 *
 * Never log a full licence key. `sub` — the first 12 hex characters of its
 * SHA-256 — is the only identifier that appears in a log line.
 */

import { buildPayload, kidFor, signToken, subFor } from './_lib/crypto.js';
import { isProduction, providerName, readEnv, requireEnv } from './_lib/env.js';
import {
  SKU_TIER,
  SKU_TOKEN_DAYS,
  getProvider,
  limitsForTier,
  messageForReason,
  normalizeDomains,
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
const MAX_KEY_LENGTH = 200;

/** Optional variables the adapters read when they are present. */
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
 * Activation is a rare, deliberate act. Ten attempts a minute from one address
 * is generous for a person and useless for someone guessing keys — though key
 * guessing is not really the threat here, since a Paddle transaction id is 26
 * random characters.
 */
const limiter = createLimiter({ name: 'license', limit: 10, windowMs: 60 * 1000 });

/**
 * Whitespace, control characters and DEL never appear in a licence key.
 * Written as a code-point scan rather than a regex so no control character ever
 * has to be typed into this source file.
 * @param {string} key
 * @returns {boolean}
 */
export function hasForbiddenKeyChar(key) {
  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    if (code <= 32 || code === 127) return true;
  }
  return false;
}

/**
 * Validate the request body.
 * @param {object} body
 * @returns {{ok:true, key:string, domains:string[]}|{ok:false, error:string, code:string}}
 */
export function validateLicenseRequest(body) {
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) {
    return { ok: false, code: 'missing_key', error: 'Enter your licence key.' };
  }
  if (key.length > MAX_KEY_LENGTH) {
    return { ok: false, code: 'bad_key', error: 'That key is too long to be a licence key.' };
  }
  // FastSpring order ids contain hyphens, so only whitespace and control
  // characters disqualify a key here. The adapter does the real shape check.
  if (hasForbiddenKeyChar(key)) {
    return { ok: false, code: 'bad_key', error: 'That key contains characters a licence key never has.' };
  }

  let domains = [];
  if (body.domains != null) {
    if (!Array.isArray(body.domains)) {
      return { ok: false, code: 'bad_domains', error: 'Domains must be a list of hostnames.' };
    }
    const normalized = normalizeDomains(body.domains, 10);
    if (normalized.domains.length === 0 && normalized.rejected.length > 0) {
      return {
        ok: false,
        code: 'bad_domains',
        error: 'None of those look like hostnames. Use a bare domain such as clinic.example.',
      };
    }
    domains = normalized.domains;
  }

  return { ok: true, key, domains };
}

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function OPTIONS(request) {
  return preflight(request, { methods: METHODS });
}

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function GET(request) {
  return methodNotAllowed(request, METHODS);
}

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  const respond = (status, body, headers) => json(status, body, { request, methods: METHODS, headers });

  try {
    const rate = limiter.check(clientIp(request));
    if (!rate.ok) {
      return respond(
        429,
        { ok: false, code: 'rate_limited', error: 'Too many attempts. Wait a minute and try again.' },
        rateLimitHeaders(rate, { includeRetryAfter: true }),
      );
    }

    const parsed = await readJsonBody(request, { maxBytes: 2048 });
    if (!parsed.ok) {
      return respond(400, {
        ok: false,
        code: 'bad_request',
        error: 'Send a small JSON body with your licence key.',
      });
    }

    const valid = validateLicenseRequest(parsed.data);
    if (!valid.ok) {
      return respond(400, { ok: false, code: valid.code, error: valid.error });
    }

    const { LICENSE_SECRET } = requireEnv(['LICENSE_SECRET']);

    // The provider adapter gets its own env object. LICENSE_SECRET is not in it:
    // an adapter has no business holding the signing secret.
    const providerEnv = requireEnv(['MOR_API_KEY']);
    // Product ids and the optional API base are read leniently: a deployment may
    // legitimately sell only some of the five SKUs.
    for (const name of OPTIONAL_ENV) {
      const value = readEnv(name);
      if (value) providerEnv[name] = value;
    }

    const isProd = isProduction();
    const provider = getProvider(providerName());
    const sub = await subFor(valid.key);

    // `sub` travels with the adapter context so an adapter can log a caller
    // without ever touching the key itself (AGENT_BRIEF section 2 rule 9: a
    // Paddle transaction id or a FastSpring order id IS the licence key).
    const providerCtx = { env: providerEnv, isProd, sub };

    const lookup = await provider.lookup(valid.key, providerCtx);
    if (!lookup.ok) {
      console.warn('[license] rejected', { sub, provider: provider.id, reason: lookup.reason });
      const status =
        lookup.reason === 'provider_unavailable' || lookup.reason === 'provider_error' ? 502 : 422;
      return respond(status, {
        ok: false,
        code: lookup.reason,
        error: lookup.message || messageForReason(lookup.reason, provider),
      });
    }

    const record = lookup.record;

    // The Protocol Pack is a download, not an app licence. Say so plainly rather
    // than issuing a token that unlocks nothing.
    if (record.sku === 'pack') {
      return respond(422, {
        ok: false,
        code: 'pack_only',
        error:
          'That key is for the Protocol Pack, which is a download rather than an app licence. ' +
          'The download link is in your receipt email. The pack is included free with Pro.',
      });
    }

    const tier = SKU_TIER[record.sku];
    const limits = limitsForTier(tier);

    if (record.activations >= limits.activations) {
      console.warn('[license] activation cap reached', {
        sub,
        tier,
        activations: record.activations,
        max: limits.activations,
      });
      return respond(409, {
        ok: false,
        code: 'activation_limit',
        error:
          `This licence is already active on ${limits.activations} devices, which is the limit for ` +
          'this tier. Reply to your receipt email and we will free a slot for you.',
        activations: record.activations,
        max: limits.activations,
      });
    }

    // Domains only mean something for the white-label tiers.
    const requestedDomains = limits.domains > 0 ? valid.domains : [];
    if (requestedDomains.length > 0) {
      const merged = new Set([...record.domains, ...requestedDomains]);
      if (merged.size > limits.domains) {
        return respond(409, {
          ok: false,
          code: 'domain_limit',
          error:
            `This licence covers ${limits.domains} domain${limits.domains === 1 ? '' : 's'} and ` +
            `${record.domains.length} ${record.domains.length === 1 ? 'is' : 'are'} already registered. ` +
            'Reply to your receipt email to change them.',
          domains: record.domains,
          maxDomains: limits.domains,
        });
      }
    }

    const activation = await provider.recordActivation(
      record,
      { domains: requestedDomains },
      providerCtx,
    );
    if (!activation.ok) {
      // A ledger write failure must not strand a paying customer, so the token
      // is still issued — but it is issued for ONE DAY instead of the usual
      // 30 or 7. An unwritable ledger means the activation cap is not being
      // counted at all, and a full-length token would quietly turn that into an
      // uncapped licence for a month. A one-day token keeps the buyer working
      // and re-checks tomorrow, so the condition self-corrects the moment the
      // ledger is writable again. The adapter has already logged the cause.
      console.warn('[license] ledger not updated; issuing a short token', {
        sub,
        provider: provider.id,
        reason: activation.reason,
      });
    }

    const kid = await kidFor(LICENSE_SECRET);
    const payload = buildPayload({
      tier,
      sub,
      kid,
      act: activation.activations,
      days: activation.ok ? SKU_TOKEN_DAYS[record.sku] : 1,
      domains: activation.domains,
    });
    const token = await signToken(payload, LICENSE_SECRET);

    console.log('[license] issued', {
      sub,
      tier,
      sku: record.sku,
      provider: provider.id,
      activations: activation.activations,
      ledger: activation.ok ? 'written' : activation.reason,
    });

    return respond(200, {
      ok: true,
      token,
      tier,
      activations: activation.activations,
      max: limits.activations,
      domains: activation.domains,
      exp: payload.exp,
    });
  } catch (error) {
    return errorResponse(error, request, { methods: METHODS, label: 'license' });
  }
}
