/**
 * api/_lib/email/mailerlite.js — MailerLite adapter (the alternative).
 *
 * Verified against the MailerLite developer docs on 2026-09-09:
 *   - Base URL: "https://connect.mailerlite.com/api"
 *   - Auth header: "Authorization: Bearer XXX", plus "Content-Type:
 *     application/json" and "Accept: application/json" on every request.
 *   - POST /subscribers takes `email` (required), `fields`, `groups` and
 *     `status`. Status "Can be one of the following: active, unsubscribed,
 *     unconfirmed, bounced, junk".
 *   - "If a subscriber already exists, it will be updated with new values. This
 *     is non-destructive operation, so omitting fields or groups will not remove
 *     them from subscriber."
 *
 * We always send status "unconfirmed", which is MailerLite's double opt-in
 * state: the person receives a confirmation email and only becomes active after
 * clicking it. Turn double opt-in on for the group in the MailerLite dashboard —
 * that switch, not this code, is what sends the confirmation email.
 */

const MAILERLITE_BASE = 'https://connect.mailerlite.com/api';

/** MailerLite custom fields are lower case by convention. */
export function buildFields(contact) {
  const fields = {};
  if (contact.technique) fields.technique = contact.technique;
  if (contact.source) fields.source = contact.source;
  return fields;
}

export const mailerliteProvider = {
  id: 'mailerlite',
  requiredEnv: ['EMAIL_API_KEY', 'EMAIL_LIST_ID'],

  /**
   * @param {{email:string, technique?:string, source?:string}} contact
   * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
   * @returns {Promise<{ok:boolean, reason?:string, status?:number}>}
   */
  async subscribe(contact, ctx) {
    const fetchImpl = ctx.fetchImpl || globalThis.fetch;
    const base = (ctx.env.EMAIL_API_BASE || MAILERLITE_BASE).replace(/\/+$/, '');

    const groups = String(ctx.env.EMAIL_LIST_ID || '')
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (groups.length === 0) return { ok: false, reason: 'not_configured' };

    let response;
    try {
      response = await fetchImpl(`${base}/subscribers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.env.EMAIL_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          email: contact.email,
          status: 'unconfirmed',
          groups,
          fields: buildFields(contact),
        }),
      });
    } catch {
      return { ok: false, reason: 'provider_unavailable' };
    }

    if (response.status === 200 || response.status === 201) {
      return { ok: true, status: response.status };
    }
    if (response.status === 422) {
      return { ok: false, reason: 'invalid_email', status: response.status };
    }
    console.error('[subscribe] mailerlite rejected the request', { status: response.status });
    return { ok: false, reason: 'provider_error', status: response.status };
  },
};

export default mailerliteProvider;
