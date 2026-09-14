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

import { describeConfig, hasEnv } from './_lib/env.js';
import { errorResponse, json, methodNotAllowed, preflight } from './_lib/respond.js';

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
export async function GET(request) {
  try {
    const report = describeConfig();
    return json(
      200,
      {
        ok: report.missing.length === 0,
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
