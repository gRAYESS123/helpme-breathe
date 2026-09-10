/**
 * api/_lib/ratelimit.js — best-effort, in-memory, per-instance rate limiting.
 *
 * There is no database and there never will be one, so this is deliberately
 * modest: a fixed window counter in a Map that lives as long as the warm
 * function instance. Vercel may run several instances at once and may recycle
 * them at any moment, so the real-world limit is "a few times the configured
 * limit" rather than an exact number. That is enough to stop a careless script
 * and a casual abuser; it is not a security control and docs/API.md says so.
 */

/** Default: five requests per minute, the email signup budget. */
export const DEFAULT_LIMIT = 5;
export const DEFAULT_WINDOW_MS = 60 * 1000;

/**
 * Create a limiter. Each limiter owns its own Map, so buckets never collide
 * between endpoints.
 *
 * @param {{name?:string, limit?:number, windowMs?:number, maxKeys?:number}} [options]
 * @returns {{
 *   name:string, limit:number, windowMs:number,
 *   check:(key:string, now?:number)=>{ok:boolean, limit:number, remaining:number, resetAt:number, retryAfter:number},
 *   peek:(key:string, now?:number)=>number,
 *   reset:()=>void,
 *   size:()=>number
 * }}
 */
export function createLimiter(options = {}) {
  const name = options.name || 'default';
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_LIMIT;
  const windowMs =
    Number.isFinite(options.windowMs) && options.windowMs > 0 ? Math.floor(options.windowMs) : DEFAULT_WINDOW_MS;
  const maxKeys = Number.isFinite(options.maxKeys) && options.maxKeys > 0 ? Math.floor(options.maxKeys) : 5000;

  /** @type {Map<string, {count:number, resetAt:number}>} */
  const hits = new Map();

  function prune(now) {
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
    // Hard cap on memory: if pruning was not enough, drop the oldest insertions.
    if (hits.size > maxKeys) {
      const excess = hits.size - maxKeys;
      let dropped = 0;
      for (const key of hits.keys()) {
        hits.delete(key);
        dropped += 1;
        if (dropped >= excess) break;
      }
    }
  }

  return {
    name,
    limit,
    windowMs,

    /**
     * Count one request against `key`.
     * @param {string} key normally the client IP
     * @param {number} [now]
     */
    check(key, now = Date.now()) {
      const bucketKey = String(key == null ? 'unknown' : key);
      if (hits.size > maxKeys / 2) prune(now);

      let entry = hits.get(bucketKey);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(bucketKey, entry);
      }
      entry.count += 1;

      const remaining = Math.max(0, limit - entry.count);
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      return {
        ok: entry.count <= limit,
        limit,
        remaining,
        resetAt: entry.resetAt,
        retryAfter,
      };
    },

    /**
     * Current count for a key without incrementing it.
     * @param {string} key
     * @param {number} [now]
     * @returns {number}
     */
    peek(key, now = Date.now()) {
      const entry = hits.get(String(key));
      if (!entry || entry.resetAt <= now) return 0;
      return entry.count;
    },

    reset() {
      hits.clear();
    },

    size() {
      return hits.size;
    },
  };
}

/**
 * Standard rate-limit headers for a limiter result.
 * @param {{limit:number, remaining:number, resetAt:number, retryAfter:number}} result
 * @param {{includeRetryAfter?:boolean}} [options]
 * @returns {Record<string,string>}
 */
export function rateLimitHeaders(result, options = {}) {
  const headers = {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000))),
  };
  if (options.includeRetryAfter) headers['Retry-After'] = String(result.retryAfter);
  return headers;
}
