/**
 * POST /api/account/signout — clears the entitlement cookie. That is its only job.
 *
 *   Set-Cookie: __Host-hmb_ent=; Path=/; Secure; SameSite=Lax; Max-Age=0
 *
 * js/auth.js calls this after clearing the Supabase session and the
 * `hmb.ent` / `hmb.ent.snapshot` storage keys (design §4.3). No bearer token
 * is needed: the cookie belongs to the caller's own browser and clearing it
 * grants nothing to anyone. `__Host-hmb_did` is deliberately NOT cleared — it
 * is a device anchor, not a session.
 *
 * Same-origin CORS, no-store, 200 { ok: true }.
 */

import { clearEntitlementCookie } from '../_lib/entitlement.js';
import { json, methodNotAllowed, preflight } from '../_lib/respond.js';

export const config = { runtime: 'nodejs', maxDuration: 5 };

const METHODS = 'POST, OPTIONS';

/** @param {Request} request */
export async function POST(request) {
  const response = json(200, { ok: true }, { request, methods: METHODS });
  response.headers.append('Set-Cookie', clearEntitlementCookie());
  return response;
}

/** @param {Request} request */
export async function OPTIONS(request) {
  return preflight(request, { methods: METHODS });
}

/** @param {Request} request */
export async function GET(request) {
  return methodNotAllowed(request, METHODS);
}
