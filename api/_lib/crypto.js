/**
 * api/_lib/crypto.js — base64url, SHA-256, HMAC-SHA256 and the licence token format.
 *
 * Zero dependencies. Everything here uses WebCrypto (`globalThis.crypto.subtle`)
 * and hand-rolled base64, so the same file runs unchanged on Vercel's Node
 * runtime, on Cloudflare Pages Functions and in `node --test`.
 *
 * Token format (agreed in docs/AGENT_BRIEF.md §7):
 *   base64url(JSON payload) + "." + base64url(HMAC-SHA256 over that first segment)
 *   payload = { v:1, tier, sub, iat, exp, kid, act, dom? }
 *
 * The signature covers the *encoded* first segment, not the raw JSON, so
 * verification never has to re-serialise JSON (key order would change the bytes).
 *
 * Never log a full licence key. `subFor(key)` is the only thing that may be logged.
 */

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Reverse lookup that accepts both the standard and the URL-safe alphabet. */
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i += 1) table[B64_ALPHABET.charCodeAt(i)] = i;
  for (let i = 0; i < B64URL_ALPHABET.length; i += 1) table[B64URL_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** The WebCrypto SubtleCrypto instance, or a clear error if the runtime lacks it. */
function subtle() {
  const webcrypto = globalThis.crypto;
  if (!webcrypto || !webcrypto.subtle) {
    throw new Error('WebCrypto is unavailable: globalThis.crypto.subtle is not defined in this runtime.');
  }
  return webcrypto.subtle;
}

/**
 * Coerce a string or binary input to a Uint8Array of UTF-8 bytes.
 * @param {string|Uint8Array|ArrayBuffer} input
 * @returns {Uint8Array}
 */
export function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return TEXT_ENCODER.encode(String(input));
}

function encodeWithAlphabet(bytes, alphabet, pad) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63];
    if (pad) out += '==';
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63];
    if (pad) out += '=';
  }
  return out;
}

/**
 * Standard base64 (padded). Used for HTTP Basic auth headers.
 * @param {string|Uint8Array|ArrayBuffer} input
 * @returns {string}
 */
export function base64Encode(input) {
  return encodeWithAlphabet(toBytes(input), B64_ALPHABET, true);
}

/**
 * base64url without padding.
 * @param {string|Uint8Array|ArrayBuffer} input
 * @returns {string}
 */
export function b64urlEncode(input) {
  return encodeWithAlphabet(toBytes(input), B64URL_ALPHABET, false);
}

/**
 * Decode base64 or base64url (padding optional) to bytes.
 * @param {string} value
 * @returns {Uint8Array}
 * @throws {Error} on any character outside the alphabet
 */
export function b64urlDecode(value) {
  const text = String(value == null ? '' : value).replace(/=+$/, '');
  const length = text.length;
  if (length % 4 === 1) throw new Error('Invalid base64url length.');
  const out = new Uint8Array(Math.floor((length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < length; i += 1) {
    const code = text.charCodeAt(i);
    const digit = code < 128 ? B64_LOOKUP[code] : -1;
    if (digit < 0) throw new Error('Invalid base64url character.');
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (buffer >> bits) & 0xff;
      outIndex += 1;
    }
  }
  return out.subarray(0, outIndex);
}

/**
 * Decode base64url to a UTF-8 string.
 * @param {string} value
 * @returns {string}
 */
export function b64urlDecodeToString(value) {
  return TEXT_DECODER.decode(b64urlDecode(value));
}

function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/**
 * SHA-256 as lowercase hex.
 * @param {string|Uint8Array} input
 * @returns {Promise<string>}
 */
export async function sha256Hex(input) {
  const digest = await subtle().digest('SHA-256', toBytes(input));
  return bytesToHex(new Uint8Array(digest));
}

/**
 * HMAC-SHA256.
 * @param {string|Uint8Array} secret
 * @param {string|Uint8Array} message
 * @returns {Promise<Uint8Array>} the raw 32-byte MAC
 */
export async function hmacSha256(secret, message) {
  const key = await subtle().importKey(
    'raw',
    toBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await subtle().sign('HMAC', key, toBytes(message));
  return new Uint8Array(signature);
}

/**
 * Key id: the first 8 hex characters of sha256(LICENSE_SECRET).
 * Rotating the secret changes the kid, so a token signed with the old secret is
 * rejected with a specific reason instead of a generic signature failure.
 * @param {string} secret
 * @returns {Promise<string>}
 */
export async function kidFor(secret) {
  return (await sha256Hex(secret)).slice(0, 8);
}

/**
 * Subject: the first 12 hex characters of sha256(licence key). This is the ONLY
 * derivative of a licence key that may be logged or stored.
 * @param {string} key
 * @returns {Promise<string>}
 */
export async function subFor(key) {
  return (await sha256Hex(String(key == null ? '' : key).trim())).slice(0, 12);
}

/**
 * Constant-time string comparison. Length is not secret here (signatures are a
 * fixed 43 base64url characters), so an early length exit is fine.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  const left = String(a == null ? '' : a);
  const right = String(b == null ? '' : b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

/**
 * Sign a payload into a licence token.
 * @param {object} payload must already contain v, tier, sub, iat, exp, kid, act (+ optional dom)
 * @param {string} secret LICENSE_SECRET
 * @returns {Promise<string>}
 */
export async function signToken(payload, secret) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('signToken(payload, secret): payload must be a plain object.');
  }
  if (!secret) throw new TypeError('signToken(payload, secret): secret is required.');
  const head = b64urlEncode(JSON.stringify(payload));
  const signature = await hmacSha256(secret, head);
  return `${head}.${b64urlEncode(signature)}`;
}

/**
 * Verify a licence token.
 *
 * Checks run in this order so the failure reason is always the most specific
 * one available: shape -> signature -> version -> kid -> expiry.
 *
 * @param {string} token
 * @param {string} secret
 * @param {{now?:number, allowExpired?:boolean, expectedKid?:string}} [options]
 * @returns {Promise<{ok:boolean, payload:object|null, reason:string}>}
 *   reason is one of: ok | expired_allowed | missing | malformed | bad_signature |
 *   bad_payload | bad_version | kid_mismatch | expired
 */
export async function verifyToken(token, secret, options = {}) {
  const { now = Date.now(), allowExpired = false, expectedKid } = options;

  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, payload: null, reason: 'missing' };
  }
  if (token.length > 4096) {
    return { ok: false, payload: null, reason: 'malformed' };
  }
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) {
    return { ok: false, payload: null, reason: 'malformed' };
  }
  if (!secret) return { ok: false, payload: null, reason: 'bad_signature' };

  const head = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  let expected;
  try {
    expected = b64urlEncode(await hmacSha256(secret, head));
  } catch {
    return { ok: false, payload: null, reason: 'bad_signature' };
  }
  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, payload: null, reason: 'bad_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(b64urlDecodeToString(head));
  } catch {
    return { ok: false, payload: null, reason: 'bad_payload' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, payload: null, reason: 'bad_payload' };
  }
  if (payload.v !== 1) {
    return { ok: false, payload, reason: 'bad_version' };
  }

  const kid = expectedKid || (await kidFor(secret));
  if (payload.kid !== kid) {
    return { ok: false, payload, reason: 'kid_mismatch' };
  }

  const expSeconds = Number(payload.exp);
  if (!Number.isFinite(expSeconds) || expSeconds <= 0) {
    return { ok: false, payload, reason: 'bad_payload' };
  }
  const expired = now >= expSeconds * 1000;
  if (expired && !allowExpired) {
    return { ok: false, payload, reason: 'expired' };
  }
  return { ok: true, payload, reason: expired ? 'expired_allowed' : 'ok' };
}

/**
 * Build the payload object for a token. Kept here so the exact field set lives
 * in one place; api/license.js and api/entitlement.js both use it.
 *
 * @param {{tier:string, sub:string, kid:string, act:number, days:number, domains?:string[], now?:number}} input
 * @returns {object} { v, tier, sub, iat, exp, kid, act, dom? }
 */
export function buildPayload(input) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const iat = Math.floor(now / 1000);
  const payload = {
    v: 1,
    tier: input.tier,
    sub: input.sub,
    iat,
    exp: iat + Math.round(input.days * 24 * 60 * 60),
    kid: input.kid,
    act: Number(input.act) || 0,
  };
  if (Array.isArray(input.domains) && input.domains.length > 0) {
    payload.dom = input.domains.slice();
  }
  return payload;
}
