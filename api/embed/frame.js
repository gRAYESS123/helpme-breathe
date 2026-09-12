/**
 * GET /api/embed/frame — the embed widget document, with the white-label
 * verdict decided at render time (docs/private/ACCOUNTS_BILLING_DESIGN.md §9.2).
 *
 * WHY THE CHECK LIVES HERE
 *
 * The embedding origin is observable on exactly one request: the fetch of the
 * frame document itself. When <iframe src="https://helpmebreath.com/…?wl=…">
 * sits on clinic.example.com, the browser sends `Sec-Fetch-Dest: iframe`,
 * `Sec-Fetch-Site: cross-site` and a `Referer` carrying the clinic's origin.
 * Anything the frame fetches afterwards is same-origin to us and says nothing
 * about the clinic. So this function reads those three headers, verifies the
 * `wl` credential against its signature and the ledger, and inlines the verdict
 * into the HTML as `window.__HMB_EMBED`. The runtime never re-asks.
 *
 * EVERY FAILURE IS THE FREE WIDGET
 *
 * No referer, wrong host, missing fetch metadata, expired, revoked, rotated
 * past its overlap, owner lapsed, malformed `wl`, ledger down, rate limited —
 * each of those renders the ordinary attributed widget. A clinic's visitor
 * never sees an error page because of a billing state they know nothing about.
 * The only thing that can fail outright is reading the template from disk, and
 * that falls back to the static copy of the same document.
 *
 * URL
 *
 * Vercel gives the filesystem precedence over rewrites ("The `source` property
 * should NOT be a file because precedence is given to the filesystem prior to
 * rewrites being applied" — vercel.com/docs/project-configuration/vercel-json),
 * so while embed/v1/frame.html exists as a static file, a rewrite of that path
 * cannot reach this function. This function therefore answers at its native
 * path, FRAME_PATH, and embed/v1/breathe.js points white-label embeds here
 * directly. Free embeds keep loading the static, CDN-cached document.
 *
 * DEPLOYMENT NOTE — the template is read from disk at runtime, and Vercel's
 * file tracer cannot see a readFile() whose path is computed. vercel.json must
 * carry `"functions": { "api/embed/frame.js": { "includeFiles": "embed/v1/frame.html" } }`
 * so the file ships inside this function's bundle. Without it every request
 * takes the 302 fallback below to the static document, which is the free
 * widget: safe, but never white-labelled.
 *
 * ZERO THIRD-PARTY REQUESTS (AGENT_BRIEF rule 14) — this function only changes
 * one inline script in the document; it adds no request of any kind.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { requireEnv } from '../_lib/env.js';
import { createLimiter } from '../_lib/ratelimit.js';
import { clientIp } from '../_lib/respond.js';
import {
  WL_RE,
  credentialStatus,
  normalizeDomainList,
  recordHit,
  verifyEmbedCredential,
} from '../entitlement.js';

export const config = { runtime: 'nodejs', maxDuration: 10 };

/** Where white-label embeds load the frame document from. */
export const FRAME_PATH = '/api/embed/frame';

/** Where free embeds load it from: the static file, cacheable. */
export const STATIC_FRAME_PATH = '/embed/v1/frame';

/** 120/min per IP (§9.4). Exceeding it serves the free widget, never a 429 page. */
const limiter = createLimiter({ name: 'embed-frame', limit: 120, windowMs: 60 * 1000 });

/** The template, in the order tried. The second name exists so a later rename
 *  of the static file (to let a vercel.json rewrite fire) needs no edit here. */
const TEMPLATE_NAMES = ['frame.html', 'frame.tpl.html'];

/** Response headers. The CSP mirrors vercel.json's `/embed/v1/(.*)` block so the
 *  document behaves identically whichever path served it; `frame-ancestors *`
 *  also makes browsers ignore any X-Frame-Options a wider header rule adds. */
const FRAME_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'CDN-Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; font-src 'self'; connect-src 'self'; base-uri 'self'; " +
    "object-src 'none'; form-action 'none'; frame-ancestors *",
  'X-Robots-Tag': 'noindex',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Access-Control-Allow-Origin': '*',
});

/* ------------------------------------------------------- the domain check --- */

/**
 * Is this request a cross-site iframe load from a page on one of `domains`?
 *
 * Strict on purpose. Fetch metadata must be present and say "iframe from
 * another site"; a top-level open, a same-origin preview on /embed, or a
 * browser too old to send the headers all answer no. The referer is compared by
 * exact hostname: a credential for `clinic.example.com` does not cover
 * `www.clinic.example.com` unless that is listed too (§9.3 lists both).
 *
 * @param {Headers} headers
 * @param {string[]} domains
 * @returns {{ok:boolean, reason:string, host:string}}
 *   reason: ok | no_fetch_metadata | not_framed | not_cross_site | no_referer | domain
 */
export function decideEmbedding(headers, domains) {
  const dest = String(headers.get('sec-fetch-dest') || '').trim().toLowerCase();
  const site = String(headers.get('sec-fetch-site') || '').trim().toLowerCase();
  const referer = String(headers.get('referer') || '').trim();

  if (!dest || !site) return { ok: false, reason: 'no_fetch_metadata', host: '' };
  if (dest !== 'iframe' && dest !== 'frame') return { ok: false, reason: 'not_framed', host: '' };
  if (site !== 'cross-site') return { ok: false, reason: 'not_cross_site', host: '' };
  if (!referer) return { ok: false, reason: 'no_referer', host: '' };

  let host = '';
  try {
    const url = new URL(referer);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'no_referer', host: '' };
    host = url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return { ok: false, reason: 'no_referer', host: '' };
  }
  if (!host) return { ok: false, reason: 'no_referer', host: '' };

  const allowed = normalizeDomainList(domains).includes(host);
  return { ok: allowed, reason: allowed ? 'ok' : 'domain', host };
}

/* ------------------------------------------------------------ the verdict --- */

/**
 * Decide the verdict for one request. Pure apart from the ledger reads, which
 * are injectable for tests.
 *
 * @param {Request} request
 * @param {{now?:number, fetchImpl?:typeof fetch, sample?:number, ip?:string}} [options]
 * @returns {Promise<{whitelabel:boolean, reason:string}>} the full reason; renderFrame() coarsens it
 */
export async function decideVerdict(request, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  const rate = limiter.check(options.ip || clientIp(request), now);
  if (!rate.ok) return { whitelabel: false, reason: 'rate_limited' };

  let wl = '';
  try {
    wl = String(new URL(request.url).searchParams.get('wl') || '').trim();
  } catch {
    wl = '';
  }
  if (!wl) return { whitelabel: false, reason: 'no_credential' };
  if (!WL_RE.test(wl)) return { whitelabel: false, reason: 'malformed' };

  let secret;
  try {
    secret = requireEnv(['LICENSE_SECRET']).LICENSE_SECRET;
  } catch {
    return { whitelabel: false, reason: 'unavailable' };
  }

  const verified = await verifyEmbedCredential(wl, secret, { now });
  if (!verified.ok) return { whitelabel: false, reason: verified.reason };

  // Headers first: they cost nothing, and a lifted snippet on the wrong site
  // should not cause three ledger reads.
  const embedding = decideEmbedding(request.headers, verified.payload.dom);
  if (!embedding.ok) return { whitelabel: false, reason: embedding.reason };

  const status = await credentialStatus(verified.payload, {
    now,
    fetchImpl: options.fetchImpl,
  });
  if (!status.ok) return { whitelabel: false, reason: status.reason };

  // The ledger's domain list must agree with the signed one. It cannot be
  // edited today, but a stricter list in the database always wins.
  if (status.domains.length && !status.domains.includes(embedding.host)) {
    return { whitelabel: false, reason: 'domain' };
  }

  await recordHit(status, { now, sample: options.sample, fetchImpl: options.fetchImpl });
  return { whitelabel: true, reason: 'ok' };
}

/* ----------------------------------------------------------- the document --- */

let templatePromise = null;

/** Candidate locations: next to this bundle's source tree, then the working directory. */
function templateCandidates() {
  const out = [];
  for (const name of TEMPLATE_NAMES) {
    out.push(new URL(`../../embed/v1/${name}`, import.meta.url));
    out.push(join(process.cwd(), 'embed', 'v1', name));
  }
  return out;
}

/**
 * Read embed/v1/frame.html once per warm instance.
 * @returns {Promise<string>}
 */
export async function loadTemplate() {
  if (!templatePromise) {
    templatePromise = (async () => {
      let lastError = null;
      for (const candidate of templateCandidates()) {
        try {
          return await readFile(candidate, 'utf8');
        } catch (error) {
          lastError = error;
        }
      }
      templatePromise = null; // let the next request try again
      throw lastError || new Error('embed frame template not found');
    })();
  }
  return templatePromise;
}

/**
 * What the served document may say about why it is not white-labelled.
 *
 * The full reason stays on the server (and in the /account listing). The
 * document goes to a clinic's visitors, and "lapsed" or "revoked" in its
 * source would tell any of them about the clinic's billing with us. So the
 * inlined reason keeps only what helps a subscriber debug their own snippet —
 * where the frame is, what it was sent — and folds every ledger verdict into
 * one word.
 */
const PUBLIC_REASONS = Object.freeze({
  ok: 'ok',
  no_credential: 'no_credential',
  malformed: 'malformed',
  missing: 'malformed',
  bad_signature: 'invalid',
  bad_payload: 'invalid',
  bad_version: 'invalid',
  kid_mismatch: 'invalid',
  wrong_type: 'invalid',
  expired: 'expired',
  superseded: 'expired',
  no_fetch_metadata: 'not_embedded',
  not_framed: 'not_embedded',
  not_cross_site: 'not_embedded',
  no_referer: 'no_referer',
  domain: 'domain',
  rate_limited: 'unavailable',
  unavailable: 'unavailable',
});

/** @param {string} reason @returns {string} */
export function publicReason(reason) {
  return PUBLIC_REASONS[String(reason || '')] || 'denied';
}

/** JSON that is safe inside a <script> element. */
function scriptSafeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Inline the verdict into the template. The template carries an empty
 * `<script data-hmb-verdict>` in its head; served statically that leaves
 * `window.__HMB_EMBED` undefined and the runtime treats it as the free widget.
 * Only `whitelabel` and the coarsened reason are written (see PUBLIC_REASONS).
 *
 * @param {string} template
 * @param {{whitelabel:boolean, reason:string}} verdict
 * @returns {string}
 */
export function renderFrame(template, verdict) {
  const inlined = { v: 1, whitelabel: verdict.whitelabel === true, reason: publicReason(verdict.reason) };
  const script =
    `<script data-hmb-verdict>window.__HMB_EMBED = ${scriptSafeJson(inlined)};</script>`;
  const marker = /<script data-hmb-verdict>[\s\S]*?<\/script>/;
  if (marker.test(template)) return template.replace(marker, () => script);
  return template.replace(/<\/head>/i, () => `${script}\n</head>`);
}

/* ------------------------------------------------------------- handlers --- */

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function GET(request) {
  let verdict;
  try {
    verdict = await decideVerdict(request);
  } catch (error) {
    console.error('[embed-frame] verdict failed:', error && error.message ? error.message : error);
    verdict = { whitelabel: false, reason: 'unavailable' };
  }

  let template;
  try {
    template = await loadTemplate();
  } catch (error) {
    console.error('[embed-frame] template unreadable:', error && error.message ? error.message : error);
    // The static copy of the same document, attribution intact. Guarded so a
    // future rewrite of that path back to this function cannot loop.
    let target = null;
    try {
      const url = new URL(request.url);
      if (!url.searchParams.has('hmb_static')) {
        url.pathname = STATIC_FRAME_PATH;
        url.searchParams.set('hmb_static', '1');
        target = url.toString();
      }
    } catch {
      target = null;
    }
    if (target) return Response.redirect(target, 302);
    return new Response('<!DOCTYPE html><title>Guided breathing</title><p>The breathing timer is briefly unavailable. Please try again in a minute.</p>', {
      status: 503,
      headers: { ...FRAME_HEADERS, 'Retry-After': '60' },
    });
  }

  return new Response(renderFrame(template, verdict), { status: 200, headers: FRAME_HEADERS });
}

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function HEAD(request) {
  const response = await GET(request);
  return new Response(null, { status: response.status, headers: response.headers });
}

/** The document is read-only; everything else is a 405 with no body. */
export async function POST() {
  return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
}
