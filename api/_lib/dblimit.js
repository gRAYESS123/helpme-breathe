/**
 * api/_lib/dblimit.js — Postgres-backed rate limiting.
 *
 * api/_lib/ratelimit.js is in-memory and per-instance; its own header says it
 * "is not a security control". The endpoints that gate money (trial
 * eligibility, checkout, embed-token minting, billing changes) use this one
 * instead: a fixed-window counter in public.rate_limits, bumped atomically by
 * the `bump_rate_limit(p_bucket, p_window_seconds, p_limit)` function from
 * supabase/migrations/0001_accounts_billing.sql (design §3.2), which returns
 * true when the request is allowed.
 *
 *   const allowed = await dblimit(`trial:${sub}`, 3600, 6);   // boolean, like bump_rate_limit
 *   if (allowed === false) ...
 *
 *   const rl = await dblimitCheck(`trial:${sub}`, 3600, 6);   // { allowed, reason, ... }
 *
 * `dblimit()` resolves to a plain boolean because that is the contract every
 * consumer (api/_lib/trialguard.js#runEligibility, the design's §5.4 step 2)
 * codes against: `true` allowed, `false` refused. `dblimitCheck()` is the same
 * call with the reason attached, for handlers that want to log why.
 *
 * Fail behaviour is CLOSED by default: if the database cannot answer, the
 * request is treated as over the limit (`reason: 'limiter_unavailable'`). The
 * callers are money-touching, and design §5.3 already fails a ledger error to
 * "no trial", so a limiter outage minting unlimited trials would be the wrong
 * direction. Pass `{ failOpen: true }` only for a path where locking a paying
 * subscriber out is worse than letting a burst through.
 *
 * Bucket keys never carry an email address or a raw IP. Use the user id
 * (`trial:<sub>`) or the /24 helper below (`trial:ip:<ipBucket(ip)>`), which
 * is a rate-limit dimension only and never a dedupe key (design §5.2).
 */

import { rpc } from './supabase.js';

/** Longest bucket key accepted. The column is text, but a key this long is a bug. */
export const MAX_BUCKET_LENGTH = 200;

/**
 * Coarsen an IP address to a bucket key: IPv4 -> first three octets (a /24),
 * IPv6 -> first four hextets (a /64). Anything unparseable becomes 'unknown',
 * which shares one bucket and therefore rate-limits itself harder, not softer.
 * @param {string} ip
 * @returns {string}
 */
export function ipBucket(ip) {
  const value = String(ip == null ? '' : ip).trim();
  if (!value) return 'unknown';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}`;
  // An IPv4-mapped address (::ffff:203.0.113.42) is an IPv4 client; bucket it
  // as one, or every such client would share a single /64 bucket.
  const mapped = /^\[?::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\]?$/i.exec(value);
  if (mapped) return mapped[1];
  if (value.includes(':')) {
    const expanded = expandIpv6(value);
    if (expanded) return expanded.slice(0, 4).join(':');
  }
  return 'unknown';
}

function expandIpv6(value) {
  let text = value;
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (!/^[0-9a-fA-F:.]+$/.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  // A dotted quad may only appear as the very last group.
  const groupsSoFar = [...head, ...tail];
  if (groupsSoFar.slice(0, -1).some((g) => g.includes('.'))) return null;
  if (groupsSoFar.some((g) => g.length === 0 || (g.length > 4 && !g.includes('.')))) return null;
  // An embedded IPv4 tail (::ffff:1.2.3.4) counts as two hextets.
  const tailLength = tail.length > 0 && tail[tail.length - 1].includes('.') ? tail.length + 1 : tail.length;
  const missing = 8 - head.length - tailLength;
  if (halves.length === 2 && missing < 0) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  const middle = halves.length === 2 ? new Array(Math.max(0, missing)).fill('0') : [];
  const groups = [...head, ...middle, ...tail];
  return groups.map((g) => (g.includes('.') ? g : g.toLowerCase().replace(/^0+(?=.)/, '') || '0'));
}

/**
 * Count one request against `bucket` in a fixed window, with the reason.
 *
 * @param {string} bucket        e.g. 'trial:<sub>' or 'trial:ip:<ipBucket>'
 * @param {number} windowSeconds e.g. 3600
 * @param {number} limit         e.g. 6 — allowed while count <= limit
 * @param {{failOpen?:boolean, ctx?:object}} [options] ctx is passed to rpc() for tests
 * @returns {Promise<{allowed:boolean, reason:'ok'|'limited'|'limiter_unavailable', bucket:string, windowSeconds:number, limit:number}>}
 */
export async function dblimitCheck(bucket, windowSeconds, limit, options = {}) {
  const key = String(bucket == null ? '' : bucket).trim();
  if (!key || key.length > MAX_BUCKET_LENGTH) throw new TypeError('dblimit(): bucket must be a non-empty string of at most 200 characters.');
  const window = Number(windowSeconds);
  const max = Number(limit);
  if (!Number.isInteger(window) || window <= 0) throw new TypeError('dblimit(): windowSeconds must be a positive integer.');
  if (!Number.isInteger(max) || max <= 0) throw new TypeError('dblimit(): limit must be a positive integer.');

  const base = { bucket: key, windowSeconds: window, limit: max };
  let result;
  try {
    result = await rpc('bump_rate_limit', { p_bucket: key, p_window_seconds: window, p_limit: max }, { ctx: options.ctx });
  } catch (error) {
    console.error('[dblimit] bump_rate_limit failed:', error && error.message ? error.message : 'error');
    const allowed = options.failOpen === true;
    return { ...base, allowed, reason: 'limiter_unavailable' };
  }

  // A scalar boolean function comes back as a bare JSON boolean; be strict about it.
  if (result === true) return { ...base, allowed: true, reason: 'ok' };
  if (result === false) return { ...base, allowed: false, reason: 'limited' };
  console.error('[dblimit] bump_rate_limit returned an unexpected value.');
  return { ...base, allowed: options.failOpen === true, reason: 'limiter_unavailable' };
}

/**
 * Count one request against `bucket` in a fixed window.
 *
 * The boolean form: exactly what `bump_rate_limit` returns, so a caller can
 * write `if ((await dblimit(...)) === false)` and be refused both when the
 * window is full and when the limiter itself is unreachable (fail closed).
 *
 * @param {string} bucket
 * @param {number} windowSeconds
 * @param {number} limit
 * @param {{failOpen?:boolean, ctx?:object}} [options]
 * @returns {Promise<boolean>} true = allowed
 */
export async function dblimit(bucket, windowSeconds, limit, options = {}) {
  const result = await dblimitCheck(bucket, windowSeconds, limit, options);
  return result.allowed === true;
}

/**
 * Apply several limits at once and allow only when every one allows. Buckets
 * are bumped in order and the first refusal stops the sequence, so a request
 * refused by its per-user limit does not also consume its IP budget.
 * @param {Array<[string, number, number]>} limits [bucket, windowSeconds, limit] tuples
 * @param {{failOpen?:boolean, ctx?:object}} [options]
 * @returns {Promise<{allowed:boolean, reason:string, results:object[]}>}
 */
export async function dblimitAll(limits, options = {}) {
  const results = [];
  for (const [bucket, windowSeconds, limit] of limits) {
    const result = await dblimitCheck(bucket, windowSeconds, limit, options);
    results.push(result);
    if (!result.allowed) return { allowed: false, reason: result.reason, results };
  }
  return { allowed: true, reason: 'ok', results };
}
