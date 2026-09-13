/**
 * api/_lib/email/address.js — the one place an email address is checked.
 *
 * Shared by api/subscribe.js (the form) and the adapters that verify a signed
 * confirmation token (the address inside a token is validated exactly like a
 * typed one before it is used in a URL path or a JSON body). Lives in its own
 * module so the handler and the adapters never import each other.
 *
 * The rules are deliberately ASCII-only. The raw string is checked BEFORE any
 * case folding, because `toLowerCase()` maps some non-ASCII letters onto ASCII
 * ones (the Kelvin sign becomes "k") and what is checked must be what is
 * stored.
 */

/**
 * RFC-ish: strict enough to catch typos, loose enough not to reject a real
 * address. The deliverability judgement belongs to the email provider, which
 * gets the last word — a 400 from it becomes "check it for a typo".
 */
export const EMAIL_RE =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export const MAX_EMAIL_LENGTH = 254;
export const MAX_LOCAL_LENGTH = 64;

/** Printable ASCII only; anything else is refused before it can be folded. */
const ASCII_RE = /^[\x21-\x7E]+$/;

/**
 * Validate and normalise an address.
 *
 * @param {unknown} raw
 * @returns {{ok:true, email:string}|{ok:false, reason:'empty'|'too_long'|'invalid'}}
 */
export function normaliseAddress(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_EMAIL_LENGTH) return { ok: false, reason: 'too_long' };
  if (!ASCII_RE.test(trimmed)) return { ok: false, reason: 'invalid' };

  const at = trimmed.lastIndexOf('@');
  const local = at > 0 ? trimmed.slice(0, at) : '';
  if (
    !EMAIL_RE.test(trimmed) ||
    local.length === 0 ||
    local.length > MAX_LOCAL_LENGTH ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    trimmed.includes('..')
  ) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, email: trimmed.toLowerCase() };
}
