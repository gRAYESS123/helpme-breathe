/**
 * api/_lib/respond.js — JSON responses, cache headers, CORS and body reading.
 *
 * CORS policy, decided deliberately:
 *
 *   /api/license, /api/subscribe, /api/health -> SAME ORIGIN ONLY. The Origin
 *     header is echoed back only when its host equals the request host (or one
 *     of ALLOWED_ORIGINS). A cross-site page therefore cannot read the response.
 *
 *   /api/entitlement -> Access-Control-Allow-Origin: * , because the embed frame
 *     is rendered inside third-party sites and the client session link at /s/ is
 *     framed too. What that exposes is exactly one thing: whether a token that
 *     the caller already possesses is a valid, unexpired token, and what tier
 *     and domains it claims. It exposes no secret, no key, no email, no order
 *     data, and it never sets Access-Control-Allow-Credentials, so no browser
 *     will attach cookies to it. A caller who does not already hold a token
 *     learns nothing; a caller who holds one already knows its contents,
 *     because the payload half of the token is plain base64url JSON.
 *
 * Every response is `no-store`. None of these endpoints returns anything a CDN
 * or a browser should ever keep.
 */

import { allowedOrigins } from './env.js';

/** Cache headers applied to every API response. */
export const NO_STORE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
});

/**
 * Extract the caller's origin when it is the site's own origin.
 * @param {Request} request
 * @returns {string} the origin to echo, or '' for "do not send CORS headers"
 */
export function resolveSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return '';
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return '';
  }
  const host =
    request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
  if (host && parsed.host.toLowerCase() === host.toLowerCase()) return parsed.origin;
  const allowlist = allowedOrigins();
  if (allowlist.includes(parsed.origin)) return parsed.origin;
  return '';
}

/**
 * Build the CORS headers for a response.
 * @param {Request} request
 * @param {{anyOrigin?:boolean, methods?:string}} [options]
 * @returns {Record<string,string>}
 */
export function corsHeaders(request, options = {}) {
  const methods = options.methods || 'POST, OPTIONS';
  if (options.anyOrigin) {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
  }
  const origin = request ? resolveSameOrigin(request) : '';
  if (!origin) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * A JSON response with no-store cache headers and the right CORS headers.
 *
 * @param {number} status
 * @param {unknown} body serialised with JSON.stringify
 * @param {{request?:Request, anyOrigin?:boolean, methods?:string, headers?:Record<string,string>}} [options]
 * @returns {Response}
 */
export function json(status, body, options = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...NO_STORE_HEADERS,
    ...corsHeaders(options.request, options),
    ...(options.headers || {}),
  };
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * The 204 answer to a CORS preflight.
 * @param {Request} request
 * @param {{anyOrigin?:boolean, methods?:string}} [options]
 * @returns {Response}
 */
export function preflight(request, options = {}) {
  return new Response(null, {
    status: 204,
    headers: {
      ...NO_STORE_HEADERS,
      ...corsHeaders(request, options),
    },
  });
}

/**
 * 405 with an Allow header.
 * @param {Request} request
 * @param {string} methods e.g. 'POST, OPTIONS'
 * @param {{anyOrigin?:boolean}} [options]
 * @returns {Response}
 */
export function methodNotAllowed(request, methods, options = {}) {
  return json(
    405,
    { ok: false, error: `Use ${methods.split(',')[0].trim()} for this endpoint.` },
    { request, methods, anyOrigin: options.anyOrigin, headers: { Allow: methods } },
  );
}

/**
 * The caller's IP, best effort. Used only as a rate-limit bucket key — never
 * stored, never logged.
 *
 * ORDER MATTERS, AND IT IS NOT THE OBVIOUS ONE.
 *
 * `x-forwarded-for` is a chain, and the caller controls its head: anyone can
 * send `X-Forwarded-For: 1.2.3.4` and the platform appends its own hop to the
 * end of whatever arrived. Reading the FIRST entry therefore handed an abuser a
 * fresh rate-limit bucket on every request, which defeated every limiter on the
 * site — including the one in front of /api/subscribe, i.e. an email-bombing
 * vector from our own sending domain.
 *
 * So: the platform-set header first (`x-vercel-forwarded-for`, which the client
 * cannot inject), then `x-real-ip`, and only then the LAST entry of the
 * forwarded chain, which is the hop the platform appended rather than the one
 * the caller wrote.
 *
 * @param {Request} request
 * @returns {string}
 */
export function clientIp(request) {
  const platform = request.headers.get('x-vercel-forwarded-for');
  if (platform) {
    const value = platform.split(',').pop().trim();
    if (value) return value;
  }

  const real = request.headers.get('x-real-ip');
  if (real && real.trim()) return real.trim();

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const last = forwarded.split(',').pop().trim();
    if (last) return last;
  }

  return 'unknown';
}

/**
 * Read and parse a small JSON request body.
 *
 * @param {Request} request
 * @param {{maxBytes?:number}} [options]
 * @returns {Promise<{ok:true, data:object}|{ok:false, reason:'too_large'|'not_json'|'not_object'}>}
 */
export async function readJsonBody(request, options = {}) {
  const maxBytes = options.maxBytes || 4096;

  const declared = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: 'too_large' };
  }

  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (text.length > maxBytes) return { ok: false, reason: 'too_large' };
  if (!text.trim()) return { ok: false, reason: 'not_json' };

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'not_object' };
  }
  return { ok: true, data };
}

/**
 * Turn an unexpected error into a response without leaking internals.
 * MissingEnvError is the one exception: its message names the missing variable
 * (never the value) because that is exactly what the owner needs to see.
 *
 * @param {unknown} error
 * @param {Request} request
 * @param {{anyOrigin?:boolean, methods?:string, label?:string}} [options]
 * @returns {Response}
 */
export function errorResponse(error, request, options = {}) {
  const label = options.label || 'api';
  const status = error && Number.isFinite(error.statusCode) ? error.statusCode : 500;
  if (error && error.name === 'MissingEnvError') {
    console.error(`[${label}] configuration error:`, error.message);
    return json(
      503,
      { ok: false, error: 'This service is not configured yet. Please try again later.' },
      { request, ...options },
    );
  }
  console.error(`[${label}] unexpected error:`, error && error.message ? error.message : error);
  return json(
    status === 503 ? 503 : 500,
    { ok: false, error: 'Something went wrong on our side. Please try again.' },
    { request, ...options },
  );
}
