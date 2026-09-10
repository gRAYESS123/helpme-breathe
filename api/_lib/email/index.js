/**
 * api/_lib/email/index.js — the email service seam.
 *
 * Same rule as the payment seam: one env var (EMAIL_PROVIDER) switches the
 * whole thing, and no file outside this folder names an email company.
 *
 * Adapter contract
 * ----------------
 * {
 *   id: 'brevo',
 *   requiredEnv: string[],                       // checked by requireEnv() before the call
 *   async subscribe(contact, ctx): { ok, reason?, status? }
 * }
 *
 * contact = { email, technique, source }
 * ctx     = { env, fetchImpl }
 *
 * Every adapter MUST create the contact unconfirmed and let the provider send
 * the confirmation email. We never mark anyone subscribed on our say-so.
 */

import { brevoProvider } from './brevo.js';
import { mailerliteProvider } from './mailerlite.js';

/** Every adapter id. */
export const EMAIL_PROVIDER_IDS = Object.freeze(['brevo', 'mailerlite']);

/**
 * Built lazily for the same import-cycle reason as the payment providers.
 * @returns {Record<string, object>}
 */
export function listEmailProviders() {
  return { brevo: brevoProvider, mailerlite: mailerliteProvider };
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
    default:
      return 'We could not sign you up just now. Please try again in a moment.';
  }
}
