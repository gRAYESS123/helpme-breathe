/**
 * api/_lib/email/resend.js — Resend adapter (the default since 2026-09-13).
 *
 * Verified against the Resend API reference on 2026-09-13:
 *   - Base URL `https://api.resend.com`; every request carries
 *     `Authorization: Bearer <API key>`. 400 "Check that the parameters were
 *     correct", 401 key missing, 403 key invalid, 404, 429 "The rate limit was
 *     exceeded" (10 requests a second per team), 5xx "an error with Resend
 *     servers". (https://resend.com/docs/api-reference/introduction)
 *   - Error names (https://resend.com/docs/api-reference/errors): 400
 *     `validation_error`, 422 `missing_required_field` / `invalid_parameter`,
 *     403 `validation_error` when the sending domain is not verified, 429
 *     `rate_limit_exceeded` / `daily_quota_exceeded` / `monthly_quota_exceeded`,
 *     500 `application_error`, 503 `service_unavailable`.
 *   - POST /emails `{ from, to, subject, html, text }` -> 200 `{ id }`. `from`
 *     "To include a friendly name, pass as `Name <email@example.com>`".
 *     (https://resend.com/docs/api-reference/emails/send-email)
 *   - POST /contacts `{ email, unsubscribed, segments: [{ id }] }` -> 200
 *     `{ object: "contact", id }`. Contacts are global to the team ("Each email
 *     address is treated as a single Contact across your team"); Audiences
 *     "are deprecated in favor of Segments", so EMAIL_LIST_ID is a segment id.
 *     What the endpoint does when the address already exists is NOT
 *     documented, so a 409 or an "already exists" message is treated as
 *     "exists" and the contact is then updated instead.
 *     (https://resend.com/docs/api-reference/contacts/create-contact)
 *   - PATCH /contacts/{email} `{ unsubscribed: false }` -> 200 `{ object, id }`;
 *     the body has no `segments` field.
 *     (https://resend.com/docs/api-reference/contacts/update-contact)
 *   - POST /contacts/{id_or_email}/segments/{segment_id}, no body -> 200
 *     `{ id }`: adds an existing contact to a segment.
 *     (https://resend.com/docs/api-reference/contacts/add-contact-to-segment)
 *   - Custom properties must exist before they can be set: "If the properties
 *     don't exist, they are not added to the Contact and the call fails." So
 *     this adapter sends none; technique and source ride in the token and in
 *     the (hash-prefix-only) log line.
 *     (https://resend.com/docs/dashboard/audiences/properties)
 *
 * Resend has no double opt-in of its own, so this adapter IS the double opt-in:
 *
 *   subscribe()  send ONE confirmation email carrying a signed link. Nothing is
 *                stored anywhere: an address typed into the form by a stranger
 *                never becomes a contact, cannot fill the contact quota, and
 *                costs exactly one request whether or not it is already on the
 *                list (so timing tells nobody who is subscribed).
 *   confirm()    verify the link's signature and age, then make the contact
 *                exist and be subscribed: PATCH it to `unsubscribed: false` and
 *                add it to the segment, or create it subscribed if it is new.
 *                The click is the consent; nothing is written before it.
 *
 * The handler shows the link as a page with a Confirm button and calls
 * confirm() from that button's POST, never from the GET itself, so a mail
 * gateway that fetches every link at delivery cannot confirm on the reader's
 * behalf. A confirmation is idempotent within the link's 48 hours.
 *
 * The confirmation link is `${SITE_ORIGIN}/api/subscribe?confirm=<token>` where
 * the token is base64url(JSON payload) + "." + base64url(HMAC-SHA256 over that
 * first segment), signed with LICENSE_SECRET — the same shape as the
 * entitlement token in api/_lib/crypto.js, with `typ: "doi"` so the two can
 * never be mistaken for one another. Payload `{ typ, e, t, s, iat }`: the
 * lower-cased address, technique or null, source or null, unix seconds.
 * A token older than 48 hours is refused.
 *
 * The API key lives only in this process. Only a 12-character hash prefix of an
 * address is ever logged; the address itself never is. The signing secret must
 * be a real one: the well-known development placeholder in api/_lib/env.js is
 * refused here, so a preview deployment can never mint or accept a token.
 */

import { b64urlDecodeToString, b64urlEncode, hmacSha256, sha256Hex, timingSafeEqual } from '../crypto.js';
import { DEV_DEFAULTS } from '../env.js';
import { normaliseAddress } from './address.js';

/** Every request to Resend is abandoned after this long; the caller sees a network failure. */
const REQUEST_TIMEOUT_MS = 8000;

const RESEND_BASE = 'https://api.resend.com';

/** Marks a confirmation token so it can never pass for an entitlement token. */
export const CONFIRM_TOKEN_TYPE = 'doi';

/** A confirmation link is good for two days. */
export const CONFIRM_MAX_AGE_SECONDS = 48 * 60 * 60;

/** A token whose `iat` is further in the future than this is refused. */
const CLOCK_SKEW_SECONDS = 5 * 60;

/** Longer than any token this file mints; a cheap first filter. */
const MAX_TOKEN_LENGTH = 1024;

export const CONFIRM_SUBJECT = 'Confirm your email for Help Me Breathe';

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Mint a confirmation token for a contact.
 *
 * @param {{email:string, technique?:string|null, source?:string|null}} contact
 * @param {string} secret LICENSE_SECRET
 * @param {number} [issuedAt] unix seconds, defaults to now
 * @returns {Promise<string>}
 */
export async function mintConfirmToken(contact, secret, issuedAt = nowSeconds()) {
  if (!contact || typeof contact !== 'object') {
    throw new TypeError('mintConfirmToken(contact, secret): contact must be an object.');
  }
  if (!secret) throw new TypeError('mintConfirmToken(contact, secret): secret is required.');
  const email = String(contact.email == null ? '' : contact.email).trim().toLowerCase();
  if (!email) throw new TypeError('mintConfirmToken(contact, secret): contact.email is required.');
  const payload = {
    typ: CONFIRM_TOKEN_TYPE,
    e: email,
    t: contact.technique ? String(contact.technique) : null,
    s: contact.source ? String(contact.source) : null,
    iat: Math.floor(Number(issuedAt)),
  };
  const head = b64urlEncode(JSON.stringify(payload));
  const signature = await hmacSha256(secret, head);
  return `${head}.${b64urlEncode(signature)}`;
}

/**
 * Verify a confirmation token: shape, signature (constant-time), payload, age.
 *
 * @param {string} token
 * @param {string} secret LICENSE_SECRET
 * @param {number} [now] unix seconds, defaults to now
 * @returns {Promise<{ok:true, payload:{e:string, t:string|null, s:string|null, iat:number}}
 *          |{ok:false, reason:'confirm_invalid'|'confirm_expired'}>}
 */
export async function verifyConfirmToken(token, secret, now = nowSeconds()) {
  const invalid = { ok: false, reason: 'confirm_invalid' };
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return invalid;
  if (!secret) return invalid;

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) return invalid;
  const head = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  let expected;
  try {
    expected = b64urlEncode(await hmacSha256(secret, head));
  } catch {
    return invalid;
  }
  if (!timingSafeEqual(provided, expected)) return invalid;

  let payload;
  try {
    payload = JSON.parse(b64urlDecodeToString(head));
  } catch {
    return invalid;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return invalid;
  if (payload.typ !== CONFIRM_TOKEN_TYPE) return invalid;
  // The address inside a token is checked exactly like a typed one, and must
  // already be in its normalised (lower-case) form: nothing else reaches a URL.
  const address = normaliseAddress(payload.e);
  if (!address.ok || address.email !== payload.e) return invalid;

  const iat = payload.iat;
  if (typeof iat !== 'number' || !Number.isFinite(iat) || iat <= 0) return invalid;
  if (iat > now + CLOCK_SKEW_SECONDS) return invalid;
  if (now - iat > CONFIRM_MAX_AGE_SECONDS) return { ok: false, reason: 'confirm_expired' };

  return {
    ok: true,
    payload: {
      e: payload.e,
      t: typeof payload.t === 'string' && payload.t ? payload.t : null,
      s: typeof payload.s === 'string' && payload.s ? payload.s : null,
      iat,
    },
  };
}

/**
 * The confirmation link. The token is base64url plus one dot, so it needs no
 * encoding, but encodeURIComponent() is applied anyway so the link can never be
 * malformed by a future change to the token format.
 * @param {string} siteOrigin
 * @param {string} token
 * @returns {string}
 */
export function confirmLink(siteOrigin, token) {
  return `${String(siteOrigin).replace(/\/+$/, '')}/api/subscribe?confirm=${encodeURIComponent(token)}`;
}

/**
 * The two bodies of the confirmation email. One link, no images, no tracking,
 * and a line saying to ignore it. Everything in it is static except the link.
 * @param {string} link
 * @returns {{subject:string, text:string, html:string}}
 */
export function buildConfirmEmail(link) {
  const text = [
    'Hello,',
    '',
    'Someone, probably you, asked for occasional email from Help Me Breathe at this address.',
    '',
    'To confirm, open this link:',
    link,
    '',
    'The link works for 48 hours.',
    '',
    'If you did not ask for this, ignore this email. Nothing more will be sent.',
    '',
    'Help Me Breathe',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<body style="margin:0;padding:24px;background:#f5f1e8;color:#15191a;font-family:Georgia,serif;font-size:17px;line-height:1.6;">',
    '<p>Hello,</p>',
    '<p>Someone, probably you, asked for occasional email from Help Me Breathe at this address.</p>',
    `<p><a href="${link}" style="color:#15191a;">Confirm your email address</a></p>`,
    '<p>The link works for 48 hours.</p>',
    '<p>If you did not ask for this, ignore this email. Nothing more will be sent.</p>',
    '<p>Help Me Breathe</p>',
    '</body>',
    '</html>',
  ].join('\n');

  return { subject: CONFIRM_SUBJECT, text, html };
}

/** The ONLY derivative of an address that may be logged. */
async function whoFor(email) {
  return (await sha256Hex(email)).slice(0, 12);
}

/**
 * One request to Resend. Never throws: a network failure comes back as
 * `{ network: true }`. The body is parsed as JSON when there is one; it is
 * never logged, because Resend echoes the address in validation messages.
 * @param {{env:Record<string,string>, fetchImpl?:Function}} ctx
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @returns {Promise<{network:boolean, status:number, body:object|null}>}
 */
async function call(ctx, method, path, body) {
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  const base = (ctx.env.EMAIL_API_BASE || RESEND_BASE).replace(/\/+$/, '');
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${ctx.env.EMAIL_API_KEY}`,
      Accept: 'application/json',
    },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  }

  let response;
  try {
    response = await fetchImpl(`${base}${path}`, init);
  } catch {
    // A refused connection, a DNS failure or the timeout above: all "network".
    return { network: true, status: 0, body: null };
  }

  let parsed = null;
  if (response.status !== 204) {
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
  }
  return { network: false, status: response.status, body: parsed };
}

function is2xx(status) {
  return status >= 200 && status < 300;
}

/**
 * Was this a rejection of the address itself, as opposed to a configuration or
 * server problem? Resend does not document its message texts, so this is a
 * best-effort read of a 400/422 body; anything unclear stays `provider_error`,
 * which the endpoint turns into a calm 502 rather than blaming the address.
 * @param {number} status
 * @param {object|null} body
 * @param {RegExp} pattern words that mean "the address"
 * @returns {boolean}
 */
function rejectedTheAddress(status, body, pattern) {
  if (status !== 400 && status !== 422) return false;
  const message = String((body && body.message) || '').toLowerCase();
  return pattern.test(message);
}

/**
 * Did Resend say the contact is already there? Undocumented, so both a 409 and
 * an "already exists" message are accepted. A repeat signup is a success.
 * @param {number} status
 * @param {object|null} body
 * @returns {boolean}
 */
export function isAlreadyAContact(status, body) {
  if (status === 409) return true;
  if (status < 400 || status >= 500) return false;
  const message = String((body && body.message) || '').toLowerCase();
  return message.includes('already') && message.includes('exist');
}

/**
 * Map a non-2xx status to the seam's reason vocabulary. A 401 or 403 is a key
 * that is missing, restricted to sending only, or a domain that is not
 * verified: the owner's problem, reported as "not configured" so it shows up
 * as the same 503 a missing variable does, not as an outage.
 * @param {number} status
 * @returns {'provider_unavailable'|'provider_error'|'not_configured'}
 */
function reasonForStatus(status) {
  if (status >= 500 || status === 429) return 'provider_unavailable';
  if (status === 401 || status === 403) return 'not_configured';
  return 'provider_error';
}

/**
 * Read and sanity-check the variables this adapter needs. Blank or placeholder
 * values mean "not configured", never a call with junk in it.
 * @param {Record<string,string>} env
 * @returns {{ok:true, listId:string, from:string, origin:string, secret:string}|{ok:false}}
 */
function readConfig(env) {
  const listId = String(env.EMAIL_LIST_ID || '').trim();
  const from = String(env.EMAIL_FROM || '').trim();
  const origin = String(env.SITE_ORIGIN || '').trim();
  const redirect = String(env.EMAIL_DOI_REDIRECT_URL || '').trim();
  const secret = String(env.LICENSE_SECRET || '');
  if (
    !listId ||
    listId === '0' ||
    !from.includes('@') ||
    !/^https?:\/\//i.test(origin) ||
    !/^https?:\/\//i.test(redirect) ||
    !isUsableSecret(secret)
  ) {
    return { ok: false };
  }
  return { ok: true, listId, from, origin, redirect, secret };
}

/**
 * A secret is usable when it is set, long enough to be random, and not the
 * development placeholder that api/_lib/env.js hands out on preview
 * deployments — that string is in a public repository, and a token signed
 * with it must never confirm anyone.
 * @param {string} secret
 * @returns {boolean}
 */
export function isUsableSecret(secret) {
  const value = String(secret || '');
  if (value.length < 32) return false;
  if (value === DEV_DEFAULTS.LICENSE_SECRET) return false;
  if (value.startsWith('dev-')) return false;
  return true;
}

export const resendProvider = {
  id: 'resend',
  requiredEnv: ['EMAIL_API_KEY', 'EMAIL_LIST_ID', 'EMAIL_FROM', 'EMAIL_DOI_REDIRECT_URL', 'SITE_ORIGIN', 'LICENSE_SECRET'],

  /**
   * Send the confirmation email. That is all: no lookup, no contact, no write.
   *
   * @param {{email:string, technique?:string, source?:string}} contact
   * @param {{env:Record<string,string>, fetchImpl?:Function, nowSeconds?:number}} ctx
   * @returns {Promise<{ok:boolean, reason?:string, status?:number}>}
   */
  async subscribe(contact, ctx) {
    const config = readConfig(ctx.env);
    if (!config.ok) return { ok: false, reason: 'not_configured' };

    const address = normaliseAddress(contact && contact.email);
    if (!address.ok) return { ok: false, reason: 'invalid_email' };
    const email = address.email;
    const who = await whoFor(email);

    const issuedAt = Number.isFinite(ctx.nowSeconds) ? ctx.nowSeconds : nowSeconds();
    const token = await mintConfirmToken(
      { email, technique: contact.technique || null, source: contact.source || null },
      config.secret,
      issuedAt,
    );
    const message = buildConfirmEmail(confirmLink(config.origin, token));
    const sent = await call(ctx, 'POST', '/emails', {
      from: config.from,
      to: [email],
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    if (sent.network) return { ok: false, reason: 'provider_unavailable' };
    if (is2xx(sent.status)) return { ok: true, status: sent.status };
    if (rejectedTheAddress(sent.status, sent.body, /`to`|"to"|'to'|recipient/)) {
      return { ok: false, reason: 'invalid_email', status: sent.status };
    }
    console.error('[subscribe] confirmation email failed', { who, status: sent.status });
    return { ok: false, reason: reasonForStatus(sent.status), status: sent.status };
  },

  /**
   * Look at a confirmation token without touching anything: signature, age,
   * address. The handler renders the Confirm page from this answer.
   *
   * @param {string} token
   * @param {{env:Record<string,string>, nowSeconds?:number}} ctx
   * @returns {Promise<{ok:true, who:string}|{ok:false, reason:string}>}
   */
  async inspect(token, ctx) {
    const config = readConfig(ctx.env);
    if (!config.ok) return { ok: false, reason: 'not_configured' };
    const now = Number.isFinite(ctx.nowSeconds) ? ctx.nowSeconds : nowSeconds();
    const verified = await verifyConfirmToken(token, config.secret, now);
    if (!verified.ok) return { ok: false, reason: verified.reason };
    return { ok: true, who: await whoFor(verified.payload.e) };
  },

  /**
   * Verify a confirmation token, then make the contact exist and be subscribed.
   * Called from the Confirm button's POST, never from a bare GET.
   *
   * @param {string} token
   * @param {{env:Record<string,string>, fetchImpl?:Function, nowSeconds?:number}} ctx
   * @returns {Promise<{ok:boolean, reason?:string, status?:number, who?:string}>}
   */
  async confirm(token, ctx) {
    const config = readConfig(ctx.env);
    if (!config.ok) return { ok: false, reason: 'not_configured' };

    const now = Number.isFinite(ctx.nowSeconds) ? ctx.nowSeconds : nowSeconds();
    const verified = await verifyConfirmToken(token, config.secret, now);
    if (!verified.ok) return { ok: false, reason: verified.reason };

    const email = verified.payload.e;
    const who = await whoFor(email);
    const path = `/contacts/${encodeURIComponent(email)}`;
    const fail = (label, result) => {
      console.error(`[subscribe] ${label}`, { who, status: result.status });
      return { ok: false, reason: reasonForStatus(result.status), status: result.status, who };
    };

    // 1. Flip an existing contact to subscribed.
    const updated = await call(ctx, 'PATCH', path, { unsubscribed: false });
    if (updated.network) return { ok: false, reason: 'provider_unavailable', who };

    if (updated.status === 404) {
      // 2. New to the team: create it subscribed and in the segment. A race with
      //    another confirmation of the same link is an "exists" answer, which
      //    step 3 handles like any existing contact.
      const created = await call(ctx, 'POST', '/contacts', {
        email,
        unsubscribed: false,
        segments: [{ id: config.listId }],
      });
      if (created.network) return { ok: false, reason: 'provider_unavailable', who };
      if (is2xx(created.status)) return { ok: true, status: created.status, who };
      if (!isAlreadyAContact(created.status, created.body)) return fail('confirm create failed', created);
      const again = await call(ctx, 'PATCH', path, { unsubscribed: false });
      if (again.network) return { ok: false, reason: 'provider_unavailable', who };
      if (!is2xx(again.status)) return fail('confirm update failed', again);
    } else if (!is2xx(updated.status)) {
      return fail('confirm update failed', updated);
    }

    // 3. PATCH cannot set segments, so an existing contact (team-wide, maybe
    //    from another list) is added to ours explicitly. Being there already
    //    is not an error.
    const joined = await call(ctx, 'POST', `${path}/segments/${encodeURIComponent(config.listId)}`);
    if (joined.network) return { ok: false, reason: 'provider_unavailable', who };
    if (!is2xx(joined.status) && !isAlreadyAContact(joined.status, joined.body)) {
      return fail('confirm segment failed', joined);
    }
    return { ok: true, status: 200, who };
  },
};

/** Plain-function form of the adapter method, for callers that prefer it. */
export function confirm(token, ctx) {
  return resendProvider.confirm(token, ctx);
}

export default resendProvider;
