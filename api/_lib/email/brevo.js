/**
 * api/_lib/email/brevo.js — Brevo adapter (default).
 *
 * Verified against the Brevo developer docs on 2026-09-09:
 *   - Endpoint: POST https://api.brevo.com/v3/contacts/doubleOptinConfirmation
 *   - Four fields are mandatory: `email` ("Email address where the confirmation
 *     email will be sent"), `includeListIds` ("Lists under user account where
 *     contact should be added"), `redirectionUrl` ("URL of the web page that user
 *     will be redirected to after clicking on the double opt in URL") and
 *     `templateId` ("Id of the Double opt-in (DOI) template").
 *   - `attributes` is optional: "key-value pairs where values can be either a
 *     string, integer, array, or boolean".
 *   - "The API key should be passed in the request headers as `api-key` for
 *     authentication." A 201 means "DOI Contact created".
 *
 * This endpoint IS the double opt-in: Brevo sends the confirmation email and the
 * contact only lands on the list after the person clicks. We never create a
 * confirmed contact.
 *
 * The API key lives only in this process. It is never returned, never logged and
 * never sent to the browser.
 */

const BREVO_BASE = 'https://api.brevo.com/v3';

/** Brevo attribute names are conventionally upper case. */
export function buildAttributes(contact) {
  const attributes = {};
  if (contact.technique) attributes.TECHNIQUE = contact.technique;
  if (contact.source) attributes.SOURCE = contact.source;
  attributes.SIGNUP_SITE = 'helpmebreath.com';
  return attributes;
}

/**
 * Brevo answers a repeat signup with a 400. Treat "already exists" as success:
 * telling a stranger whether an address is on the list is a privacy leak, and a
 * person re-submitting the form should simply be told to check their inbox.
 * @param {number} status
 * @param {object|null} body
 * @returns {boolean}
 */
export function isAlreadySubscribed(status, body) {
  if (status !== 400) return false;
  const code = String((body && body.code) || '').toLowerCase();
  const message = String((body && body.message) || '').toLowerCase();
  if (code === 'duplicate_parameter') return true;
  return message.includes('already') && (message.includes('exist') || message.includes('subscrib'));
}

export const brevoProvider = {
  id: 'brevo',
  requiredEnv: ['EMAIL_API_KEY', 'EMAIL_LIST_ID', 'EMAIL_DOI_TEMPLATE_ID', 'EMAIL_DOI_REDIRECT_URL'],

  /**
   * @param {{email:string, technique?:string, source?:string}} contact
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<{ok:boolean, reason?:string, status?:number}>}
   */
  async subscribe(contact, ctx) {
    const fetchImpl = ctx.fetchImpl || globalThis.fetch;
    const base = (ctx.env.EMAIL_API_BASE || BREVO_BASE).replace(/\/+$/, '');

    const listIds = String(ctx.env.EMAIL_LIST_ID || '')
      .split(/[\s,]+/)
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);
    const templateId = Number(ctx.env.EMAIL_DOI_TEMPLATE_ID);
    const redirectionUrl = String(ctx.env.EMAIL_DOI_REDIRECT_URL || '').trim();

    if (listIds.length === 0 || !Number.isFinite(templateId) || templateId <= 0 || !redirectionUrl) {
      return { ok: false, reason: 'not_configured' };
    }

    let response;
    try {
      response = await fetchImpl(`${base}/contacts/doubleOptinConfirmation`, {
        method: 'POST',
        headers: {
          'api-key': ctx.env.EMAIL_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          email: contact.email,
          includeListIds: listIds,
          templateId,
          redirectionUrl,
          attributes: buildAttributes(contact),
        }),
      });
    } catch {
      return { ok: false, reason: 'provider_unavailable' };
    }

    if (response.status === 201 || response.status === 204 || response.status === 200) {
      return { ok: true, status: response.status };
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (isAlreadySubscribed(response.status, body)) {
      return { ok: true, status: response.status };
    }
    if (response.status === 400) {
      return { ok: false, reason: 'invalid_email', status: response.status };
    }
    // Log the status only. The body can echo the address back and we do not want it in the logs.
    console.error('[subscribe] brevo rejected the request', { status: response.status });
    return { ok: false, reason: 'provider_error', status: response.status };
  },
};

export default brevoProvider;
