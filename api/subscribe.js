/**
 * POST /api/subscribe — double opt-in email signup, proxied so the API key never
 * reaches a browser.
 *
 * Request  { email, technique?, source?, consent: true }
 * Response { ok: true, message: "Check your inbox to confirm" }
 *          { ok: false, error }
 *
 * The response is deliberately the same whether the address is new or already on
 * the list. Telling a stranger which addresses are subscribed would be a leak,
 * and the person in front of the form only needs one instruction either way.
 *
 * `consent` must be literally `true`. The checkbox on the page is the record of
 * consent; the provider's confirmation email is the second half of it. We never
 * add a confirmed contact.
 */

import { sha256Hex } from './_lib/crypto.js';
import { emailProviderName, requireEnv, readEnv } from './_lib/env.js';
import { getEmailProvider, messageForEmailReason } from './_lib/email/index.js';
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

/** Five a minute per client IP, as specified. */
const limiter = createLimiter({ name: 'subscribe', limit: 5, windowMs: 60 * 1000 });

/** The confirmation sentence. One string, used for every success. */
export const SUCCESS_MESSAGE = 'Check your inbox to confirm';

/**
 * RFC-ish: strict enough to catch typos, loose enough not to reject a real
 * address. The deliverability judgement belongs to the email provider, which
 * gets the last word — a 400 from it becomes "check it for a typo".
 */
export const EMAIL_RE =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Technique keys and acquisition sources are slugs. */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9_.:/-]*$/;

export const MAX_EMAIL_LENGTH = 254;
export const MAX_LOCAL_LENGTH = 64;
export const MAX_TECHNIQUE_LENGTH = 40;
export const MAX_SOURCE_LENGTH = 60;

/**
 * Validate and normalise a subscribe request body.
 *
 * @param {object} body
 * @returns {{ok:true, value:{email:string, technique:string, source:string}}
 *          |{ok:false, field:string, error:string}}
 */
export function validateSubscribe(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, field: 'body', error: 'Send a JSON body.' };
  }

  if (body.consent !== true) {
    return {
      ok: false,
      field: 'consent',
      error: 'Tick the box to say you are happy to receive the email.',
    };
  }

  const rawEmail = typeof body.email === 'string' ? body.email.trim() : '';
  if (!rawEmail) {
    return { ok: false, field: 'email', error: 'Enter your email address.' };
  }
  if (rawEmail.length > MAX_EMAIL_LENGTH) {
    return { ok: false, field: 'email', error: 'That address is too long.' };
  }
  const email = rawEmail.toLowerCase();
  const at = email.lastIndexOf('@');
  const local = at > 0 ? email.slice(0, at) : '';
  if (
    !EMAIL_RE.test(email) ||
    local.length === 0 ||
    local.length > MAX_LOCAL_LENGTH ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    email.includes('..')
  ) {
    return { ok: false, field: 'email', error: 'That does not look like an email address.' };
  }

  let technique = '';
  if (body.technique != null && body.technique !== '') {
    if (typeof body.technique !== 'string') {
      return { ok: false, field: 'technique', error: 'Technique must be a short name.' };
    }
    technique = body.technique.trim().toLowerCase();
    if (technique.length > MAX_TECHNIQUE_LENGTH || !SLUG_RE.test(technique)) {
      return { ok: false, field: 'technique', error: 'Technique must be a short name.' };
    }
  }

  let source = '';
  if (body.source != null && body.source !== '') {
    if (typeof body.source !== 'string') {
      return { ok: false, field: 'source', error: 'Source must be a short name.' };
    }
    source = body.source.trim().toLowerCase();
    if (source.length > MAX_SOURCE_LENGTH || !SOURCE_RE.test(source)) {
      return { ok: false, field: 'source', error: 'Source must be a short name.' };
    }
  }

  return { ok: true, value: { email, technique, source } };
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
        { ok: false, error: 'That is a few too many tries. Wait a minute and try again.' },
        rateLimitHeaders(rate, { includeRetryAfter: true }),
      );
    }

    const parsed = await readJsonBody(request, { maxBytes: 2048 });
    if (!parsed.ok) {
      return respond(400, { ok: false, error: 'Send a small JSON body with your email address.' });
    }

    const valid = validateSubscribe(parsed.data);
    if (!valid.ok) {
      return respond(400, { ok: false, error: valid.error, field: valid.field });
    }

    const providerId = emailProviderName();
    const provider = getEmailProvider(providerId);
    const env = requireEnv(provider.requiredEnv);
    const apiBase = readEnv('EMAIL_API_BASE');
    if (apiBase) env.EMAIL_API_BASE = apiBase;

    const result = await provider.subscribe(valid.value, { env });

    // Only ever log a hash prefix of the address, the same discipline the
    // licence endpoints apply to keys.
    const who = (await sha256Hex(valid.value.email)).slice(0, 12);

    if (!result.ok) {
      console.warn('[subscribe] failed', {
        who,
        provider: providerId,
        reason: result.reason,
        technique: valid.value.technique || null,
      });
      // A configuration hole is our fault, not the network's: 503 matches the
      // MissingEnvError path so the owner sees one status for "not set up yet".
      let status = 502;
      if (result.reason === 'invalid_email') status = 400;
      else if (result.reason === 'not_configured') status = 503;
      return respond(status, { ok: false, error: messageForEmailReason(result.reason) });
    }

    console.log('[subscribe] accepted', {
      who,
      provider: providerId,
      technique: valid.value.technique || null,
      source: valid.value.source || null,
    });

    return respond(200, { ok: true, message: SUCCESS_MESSAGE });
  } catch (error) {
    return errorResponse(error, request, { methods: METHODS, label: 'subscribe' });
  }
}
