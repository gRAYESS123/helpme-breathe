/**
 * api/_lib/email/index.js — the email service seam.
 *
 * Same rule as the payment seam: one env var (EMAIL_PROVIDER) switches the
 * whole thing, and no file outside this folder names an email company.
 *
 * Adapter contract
 * ----------------
 * {
 *   id: 'resend',
 *   requiredEnv: string[],                       // checked by requireEnv() before the call
 *   async subscribe(contact, ctx): { ok, reason?, status? }
 *   async inspect?(token, ctx):    { ok, who? | reason }     // only when the adapter runs the
 *   async confirm?(token, ctx):    { ok, reason?, status? }  // double opt-in itself: inspect
 *                                                            // never writes; confirm does
 * }
 *
 * contact = { email, technique, source }
 * ctx     = { env, fetchImpl }
 *
 * Nobody is ever marked subscribed on our say-so. Brevo and MailerLite create
 * the contact unconfirmed and send the confirmation email themselves. Resend
 * has no double opt-in of its own, so its adapter sends the email and stores
 * nothing; GET /api/subscribe?confirm=<token> shows a Confirm button after
 * `inspect()`, and the button's POST calls `confirm()`, which is the first and
 * only write.
 */

import { brevoProvider } from './brevo.js';
import { mailerliteProvider } from './mailerlite.js';
import { resendProvider } from './resend.js';

/** Every adapter id. The first is the default. */
export const EMAIL_PROVIDER_IDS = Object.freeze(['resend', 'brevo', 'mailerlite']);

/**
 * Built lazily for the same import-cycle reason as the payment providers.
 * @returns {Record<string, object>}
 */
export function listEmailProviders() {
  return { resend: resendProvider, brevo: brevoProvider, mailerlite: mailerliteProvider };
}

/**
 * @param {string} name value of EMAIL_PROVIDER
 * @returns {object} the adapter
 * @throws {Error} when the name is unknown
 */
export function getEmailProvider(name) {
  const key = String(name || '').toLowerCase();
  const provider = listEmailProviders()[key];
  if (!provider) {
    throw new Error(`Unknown EMAIL_PROVIDER "${key}". Supported values: ${EMAIL_PROVIDER_IDS.join(', ')}.`);
  }
  return provider;
}

/**
 * A calm sentence for each machine reason. Shown to the person who typed their
 * address, so it never mentions the provider by name and never says whether the
 * address was already on the list.
 * @param {string} reason
 * @returns {string}
 */
export function messageForEmailReason(reason) {
  switch (reason) {
    case 'provider_unavailable':
      return 'We could not reach the mailing service. Please try again in a moment.';
    case 'invalid_email':
      return 'That address was rejected. Check it for a typo and try again.';
    case 'not_configured':
      return 'Email signup is not switched on yet. Please try again later.';
    case 'confirm_invalid':
      return 'This confirmation link is not valid. Sign up again from the site and we will send a fresh one.';
    case 'confirm_expired':
      return 'This confirmation link has expired. Links work for 48 hours. Sign up again from the site and we will send a fresh one.';
    default:
      return 'We could not sign you up just now. Please try again in a moment.';
  }
}
