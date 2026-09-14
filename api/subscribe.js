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
 * consent; the confirmation email is the second half of it. We never add a
 * confirmed contact.
 *
 * GET /api/subscribe?confirm=<token> — the second half, for the adapters that
 * run the double opt-in themselves (the default one does; it has no built-in
 * confirmation flow). The token is minted and signed by the adapter when it
 * sends the confirmation email. The GET has NO side effects: a valid token
 * renders a small page with one Confirm button, and only that button's POST
 * (a form body carrying the token) flips the contact to subscribed and answers
 * 302 to EMAIL_DOI_REDIRECT_URL — read from the environment, never from the
 * request. That split exists because mail gateways fetch every link they
 * deliver; a fetch must never count as consent. An invalid or expired token
 * gets a small plain page saying so and inviting the person to sign up again;
 * the token and the address are never echoed on those pages. A GET without
 * ?confirm is still 405. One serverless function, because the function count
 * matters.
 *
 * Two guards that are not about the visitor: on a preview deployment with no
 * real LICENSE_SECRET nothing is minted or accepted (the placeholder secret is
 * in a public repository), and the whole form shares one sending budget so it
 * can never spend the mailing account's daily quota — the same account sends
 * the sign-in emails.
 */

import { sha256Hex } from './_lib/crypto.js';
import { emailProviderName, hasEnv, isProduction, requireEnv, readEnv } from './_lib/env.js';
import { EMAIL_RE, MAX_EMAIL_LENGTH, MAX_LOCAL_LENGTH, normaliseAddress } from './_lib/email/address.js';
import { getEmailProvider, messageForEmailReason } from './_lib/email/index.js';
import { createLimiter, rateLimitHeaders } from './_lib/ratelimit.js';
import {
  NO_STORE_HEADERS,
  clientIp,
  errorResponse,
  json,
  methodNotAllowed,
  preflight,
  readJsonBody,
  resolveSameOrigin,
} from './_lib/respond.js';

export const config = { runtime: 'nodejs', maxDuration: 15 };

const METHODS = 'POST, OPTIONS';

/** Five a minute per client IP, as specified. */
const limiter = createLimiter({ name: 'subscribe', limit: 5, windowMs: 60 * 1000 });

/**
 * A second limiter, keyed on a hash of the address rather than on the caller.
 *
 * The IP bucket alone is not enough: a double opt-in confirmation email goes to
 * whatever address the body names, so one address could be mailed repeatedly
 * from a rotating set of sources. Three confirmation emails an hour to the same
 * address is more than anyone needs and far less than a mailbox would call
 * abuse, and it keeps the sending reputation of the domain out of it. The key is
 * the same 12-character hash prefix the logs use — the address itself is never a
 * bucket key.
 */
const addressLimiter = createLimiter({ name: 'subscribe-address', limit: 3, windowMs: 60 * 60 * 1000 });

/**
 * A third limiter with one shared key: how many confirmation emails this
 * instance will send in an hour, from everyone. The mailing account's free
 * tier is 100 emails a day and the same account carries the sign-in emails, so
 * a wordlist pointed at this form must not be able to spend the day's quota.
 * Twenty an hour is more than a small site's real signups and a small slice of
 * the quota.
 */
const GLOBAL_SEND_LIMIT = 20;
const globalLimiter = createLimiter({ name: 'subscribe-global', limit: GLOBAL_SEND_LIMIT, windowMs: 60 * 60 * 1000 });
const GLOBAL_KEY = 'everyone';

/** The confirmation sentence. One string, used for every success. */
export const SUCCESS_MESSAGE = 'Check your inbox to confirm';

/** The address rules live in ./_lib/email/address.js; re-exported for the tests. */
export { EMAIL_RE, MAX_EMAIL_LENGTH, MAX_LOCAL_LENGTH };

/** Technique keys and acquisition sources are slugs. */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9_.:/-]*$/;

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

  const address = normaliseAddress(body.email);
  if (!address.ok) {
    if (address.reason === 'empty') return { ok: false, field: 'email', error: 'Enter your email address.' };
    if (address.reason === 'too_long') return { ok: false, field: 'email', error: 'That address is too long.' };
    return { ok: false, field: 'email', error: 'That does not look like an email address.' };
  }
  const email = address.email;

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
 * A short, calm HTML page for the confirmation link. Every string in it is
 * static: nothing from the request is ever interpolated.
 * @param {number} status
 * @param {string} title
 * @param {string} text
 * @param {Record<string,string>} [headers]
 * @returns {Response}
 */
function confirmPage(status, title, text, headers = {}, extraHtml = '') {
  const body =
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    `<title>${title}</title>` +
    '<style>body{margin:0;padding:48px 24px;background:#f5f1e8;color:#15191a;font-family:Georgia,serif;font-size:18px;line-height:1.6}' +
    'main{max-width:34em;margin:0 auto}h1{font-size:1.5em;font-weight:normal;margin:0 0 .75em}a{color:inherit}' +
    'button{font:inherit;padding:.6em 1.2em;background:#0f5136;color:#fff;border:0;border-radius:4px;cursor:pointer}</style></head>' +
    `<body><main><h1>${title}</h1><p>${text}</p>${extraHtml}<p><a href="/">Back to Help Me Breathe</a></p></main></body></html>\n`;
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex',
      ...NO_STORE_HEADERS,
      ...headers,
    },
  });
}

/** The pages the confirmation link can land on when it does not redirect. */
export const CONFIRM_PAGES = Object.freeze({
  confirm_invalid: {
    status: 400,
    title: 'This link is not valid',
    text: 'The confirmation link did not check out. Sign up again from the site and we will send a fresh one. Nothing else is needed.',
  },
  confirm_expired: {
    status: 410,
    title: 'This link has expired',
    text: 'Confirmation links work for 48 hours. Sign up again from the site and we will send a fresh one. Nothing else is needed.',
  },
  unavailable: {
    status: 502,
    title: 'We could not confirm your address just now',
    text: 'Please open the link again in a few minutes. It stays valid for 48 hours from when it was sent.',
  },
  too_many: {
    status: 429,
    title: 'That is a few too many tries',
    text: 'Wait a minute and open the link again.',
  },
  not_configured: {
    status: 503,
    title: 'Email signup is not switched on yet',
    text: 'This part of the site is not set up. Nothing was recorded; please try again another day.',
  },
  confirm_ready: {
    status: 200,
    title: 'One more click',
    text: 'Press the button to confirm that you want occasional email from Help Me Breathe at this address. Nothing is sent until you do.',
  },
});

/** Only base64url plus one dot ever reaches this; escaping is belt and braces. */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * The confirmation flow cannot run without a real signing secret. Production
 * fails loudly through requireEnv(); a preview or development deployment with
 * no LICENSE_SECRET set would otherwise be handed the public placeholder.
 * @returns {boolean}
 */
function signingSecretUsable() {
  return isProduction() || hasEnv('LICENSE_SECRET');
}

/** The adapter, its env and whether it runs its own confirmation flow. */
function confirmingProvider() {
  const providerId = emailProviderName();
  const provider = getEmailProvider(providerId);
  if (typeof provider.confirm !== 'function' || typeof provider.inspect !== 'function') return null;
  const env = requireEnv(provider.requiredEnv);
  const apiBase = readEnv('EMAIL_API_BASE');
  if (apiBase) env.EMAIL_API_BASE = apiBase;
  return { providerId, provider, env };
}

/**
 * The button's POST: verify, write, redirect. Shared by the form body and a
 * JSON body carrying { confirm }.
 * @param {Request} request
 * @param {string} token
 * @returns {Promise<Response>}
 */
async function completeConfirmation(request, token) {
  const page = (key, headers) => {
    const spec = CONFIRM_PAGES[key];
    return confirmPage(spec.status, spec.title, spec.text, headers);
  };
  const rate = limiter.check(clientIp(request));
  if (!rate.ok) return page('too_many', rateLimitHeaders(rate, { includeRetryAfter: true }));
  if (!signingSecretUsable()) return page('not_configured');

  const ctx = confirmingProvider();
  if (!ctx) return methodNotAllowed(request, METHODS);

  const result = await ctx.provider.confirm(String(token || ''), { env: ctx.env });
  if (result.ok) {
    console.log('[subscribe] confirmed', { who: result.who || null, provider: ctx.providerId });
    // The destination comes from the environment and only from there.
    return new Response(null, {
      status: 302,
      headers: { Location: ctx.env.EMAIL_DOI_REDIRECT_URL, ...NO_STORE_HEADERS },
    });
  }
  if (result.reason === 'confirm_invalid' || result.reason === 'confirm_expired') {
    console.warn('[subscribe] confirm refused', { provider: ctx.providerId, reason: result.reason });
    return page(result.reason);
  }
  if (result.reason === 'not_configured') return page('not_configured');
  console.warn('[subscribe] confirm failed', {
    who: result.who || null,
    provider: ctx.providerId,
    reason: result.reason,
    status: result.status || null,
  });
  return page('unavailable');
}

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function GET(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return methodNotAllowed(request, METHODS);
  }
  if (!url.searchParams.has('confirm')) return methodNotAllowed(request, METHODS);

  const page = (key, headers, extra) => {
    const spec = CONFIRM_PAGES[key];
    return confirmPage(spec.status, spec.title, spec.text, headers, extra);
  };

  try {
    // The same per-IP bucket as the form. A confirmation click is one request;
    // anything hammering this path is not a person with an inbox.
    const rate = limiter.check(clientIp(request));
    if (!rate.ok) return page('too_many', rateLimitHeaders(rate, { includeRetryAfter: true }));
    if (!signingSecretUsable()) return page('not_configured');

    const ctx = confirmingProvider();
    if (!ctx) return methodNotAllowed(request, METHODS);

    // Look, do not touch: the signature and age are checked so the page can say
    // the right thing, but nothing is written until the button is pressed.
    const token = url.searchParams.get('confirm') || '';
    const look = await ctx.provider.inspect(token, { env: ctx.env });
    if (!look.ok) {
      if (look.reason === 'not_configured') return page('not_configured');
      console.warn('[subscribe] confirm link refused', { provider: ctx.providerId, reason: look.reason });
      return page(look.reason === 'confirm_expired' ? 'confirm_expired' : 'confirm_invalid');
    }
    const form =
      '<form method="post" action="/api/subscribe">' +
      `<input type="hidden" name="confirm" value="${escapeHtml(token)}">` +
      '<p><button type="submit">Confirm my email</button></p></form>';
    return page('confirm_ready', {}, form);
  } catch (error) {
    return errorResponse(error, request, { methods: METHODS, label: 'subscribe' });
  }
}

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  const respond = (status, body, headers) => json(status, body, { request, methods: METHODS, headers });

  try {
    // The Confirm button posts a form; a JSON body may carry { confirm } too.
    const contentType = String(request.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      let token = '';
      try {
        const form = await request.formData();
        token = String(form.get('confirm') || '');
      } catch {
        token = '';
      }
      return completeConfirmation(request, token);
    }

    // The JSON signup is a browser call from this site only. (The form branch
    // above stays outside the check: a top-level form navigation does not
    // carry an Origin header in every browser, and its signed token is the gate.)
    if (!resolveSameOrigin(request)) return respond(403, { ok: false, error: 'cross_origin' });

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
    if (parsed.data && typeof parsed.data === 'object' && typeof parsed.data.confirm === 'string') {
      return completeConfirmation(request, parsed.data.confirm);
    }

    const valid = validateSubscribe(parsed.data);
    if (!valid.ok) {
      return respond(400, { ok: false, error: valid.error, field: valid.field });
    }

    // Only ever a hash prefix of the address, the same discipline the licence
    // endpoints apply to keys. Computed here so it can key the second limiter.
    const who = (await sha256Hex(valid.value.email)).slice(0, 12);

    const perAddress = addressLimiter.check(who);
    if (!perAddress.ok) {
      return respond(
        429,
        {
          ok: false,
          error:
            'We have already tried to send a confirmation email to that address recently. Check your inbox ' +
            'and spam folder, and try again in an hour if it has not arrived.',
        },
        rateLimitHeaders(perAddress, { includeRetryAfter: true }),
      );
    }

    if (!signingSecretUsable()) {
      return respond(503, { ok: false, error: messageForEmailReason('not_configured') });
    }

    // The shared sending budget, checked last so a rejected request never
    // spends it.
    const budget = globalLimiter.check(GLOBAL_KEY);
    if (!budget.ok) {
      return respond(
        429,
        { ok: false, error: 'A lot of people are signing up right now. Please try again in an hour.' },
        rateLimitHeaders(budget, { includeRetryAfter: true }),
      );
    }

    const providerId = emailProviderName();
    const provider = getEmailProvider(providerId);
    const env = requireEnv(provider.requiredEnv);
    const apiBase = readEnv('EMAIL_API_BASE');
    if (apiBase) env.EMAIL_API_BASE = apiBase;

    const result = await provider.subscribe(valid.value, { env });

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
