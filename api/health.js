/**
 * GET /api/health — is this deployment wired up?
 *
 * Response {
 *   ok, provider, email, env, time,
 *   configured: { license_secret: true, mor_api_key: false, … },
 *   missing: ['MOR_API_KEY']
 * }
 *
 * Booleans and variable NAMES only. No value from the environment ever appears
 * in this response — not truncated, not hashed, not hinted at. The names are
 * already public in .env.example, so listing which ones are unset costs nothing
 * and saves the owner from guessing after a deploy.
 *
 * `ok` is false when a variable a working deployment actually needs is missing.
 * The endpoint still answers 200 in that case: it is a report, not a probe that
 * should take the site down.
 *
 * `provider` and `email` are null until MOR_PROVIDER / EMAIL_PROVIDER are
 * actually set in the environment. describeConfig() falls back to the code
 * defaults so `missing` can be computed, but this response is public and no
 * merchant of record or email service may be named on the site before one has
 * accepted the owner in writing. The `missing` list is unaffected.
 */

import { describeConfig, hasEnv, isProduction, providerName, readEnv } from './_lib/env.js';
import { errorResponse, json, methodNotAllowed, preflight } from './_lib/respond.js';
import { getProvider } from './_lib/providers/index.js';
import { bearerToken } from './_lib/authz.js';
import { timingSafeEqual } from './_lib/crypto.js';

export const config = { runtime: 'nodejs', maxDuration: 10 };

const METHODS = 'GET, OPTIONS';

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
export async function POST(request) {
  return methodNotAllowed(request, METHODS);
}

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
/** Uptime monitors default to HEAD; answer it with GET's status and headers. */
export async function HEAD(request) {
  const response = await GET(request);
  return new Response(null, { status: response.status, headers: response.headers });
}


/**
 * Opt-in credential probe: `GET /api/health?probe=credentials` with
 * `Authorization: Bearer <CRON_SECRET>`.
 *
 * The plain report says only whether MOR_API_KEY is *set*. That is what let a
 * Stripe publishable key sit there looking healthy while checkout was dead
 * (2026-09-16). This asks the provider whether it accepts the key.
 *
 * Gated on CRON_SECRET because it makes an outbound provider call, and opt-in
 * so the ordinary health check stays free and instant. Returns a verdict only:
 * no key, no customer data, no provider ids.
 *
 * @param {Request} request
 * @returns {Promise<{checked:boolean, ok?:boolean, reason?:string, message?:string, live?:boolean}>}
 */
async function probeCredentials(request) {
  const secret = readEnv('CRON_SECRET');
  const presented = bearerToken(request);
  if (!secret || !presented || !timingSafeEqual(presented, secret)) {
    return { checked: false, reason: 'unauthorized' };
  }
  let provider;
  try {
    provider = getProvider(providerName());
  } catch {
    return { checked: false, reason: 'no_provider' };
  }
  if (!provider || typeof provider.verifyCredentials !== 'function') {
    return { checked: false, reason: 'unsupported' };
  }
  const verdict = await provider.verifyCredentials({
    env: process.env,
    fetchImpl: globalThis.fetch,
    isProd: isProduction(),
  });
  return { checked: true, ...verdict };
}

export async function GET(request) {
  try {
    const report = describeConfig();
    const wantsProbe = new URL(request.url).searchParams.get('probe') === 'credentials';
    const provider_auth = wantsProbe ? await probeCredentials(request) : undefined;
    return json(
      200,
      {
        ok: report.missing.length === 0,
        ...(provider_auth ? { provider_auth } : {}),
        provider: hasEnv('MOR_PROVIDER') ? report.provider : null,
        // Mode flags, never values: is the rail pointed at the sandbox / test
        // mode, and (Stripe) does it sell as merchant of record.
        sandbox: report.sandbox,
        managed_payments: hasEnv('MOR_PROVIDER') ? report.managed_payments : null,
        email: hasEnv('EMAIL_PROVIDER') ? report.email : null,
        env: report.env,
        time: new Date().toISOString(),
        configured: report.configured,
        missing: report.missing,
      },
      { request, methods: METHODS },
    );
  } catch (error) {
    return errorResponse(error, request, { methods: METHODS, label: 'health' });
  }
}
