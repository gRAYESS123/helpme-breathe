/**
 * tools/e2e/gate.e2e.mjs — the free-session gate in a real browser, ARMED.
 *
 *   npm run e2e            (= node --test tools/e2e/gate.e2e.mjs)
 *
 * tools/gate.test.mjs pins the inert path: while SUPABASE in js/config.js is
 * empty, requireTimer() lets every session through. This file proves the
 * other half — that the gate ARMS the moment sign-in is configured — without
 * a Supabase project, without the network and without changing site code:
 *
 *   - the repo root is served over a small node http server on 127.0.0.1;
 *   - GET /js/config.js is answered from a fixture, never from disk: SUPABASE.url and
 *     SUPABASE.publishableKey swapped for TESTFIXTURE values, so js/auth.js
 *     configured() is true ("ARMED" below). "UNCONFIGURED" serves the real
 *     file, which is how the site ships today;
 *   - every request to a host other than 127.0.0.1 is aborted (the CDN that
 *     hosts supabase-js, fonts, tag manager, the ad loader, the checkout
 *     overlay). js/auth.js never reaches the library: ready() returns before
 *     importing it when there is no cached session (`if (!cached && ...)
 *     return`), and even a failed import is swallowed by its try/catch, so
 *     signedIn() stays false and nothing throws. That is the signed-out
 *     visitor the gate is meant for;
 *   - service workers are blocked, so sw.js cannot serve a cached config.
 *
 * Fixtures are written straight into localStorage before any page script
 * runs, in the exact shapes the modules read:
 *   hmb.history       js/storage.js appendSession(): [{ date, technique,
 *                     seconds, breaths, completed: true }, …]
 *   hmb.consent       js/consent.js: 'essential' (keeps the banner away)
 *   hmb.ent           js/entitlements.js: base64url(JSON) + '.' +
 *                     base64url(signature). The client decodes the payload
 *                     WITHOUT verifying the HMAC (design §7.3 step 3), so a
 *                     TESTFIXTURE signature is accepted here; the server is
 *                     the security boundary, never this decode.
 *
 * How "the engine ran" and "the engine did not run" are told apart. The §8.2
 * preview state deliberately animates ONE demonstration cycle with the same
 * attributes the engine writes (data-phase on the app root and the circle,
 * js/pro/preview.js runDemonstration), so data-phase alone cannot prove a
 * session. What only a real session does: body.session-active (js/app.js
 * setBodySessionActive), the hmb:session-start event, and Begin becoming
 * disabled. What only the demonstration does: data-preview-demo="running" on
 * the app root. Both sides are asserted.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright lives under tools/render (the render tool's own install), so the
// site itself stays dependency-free. Relative import, resolved from this file.
const { chromium } = await import('../render/node_modules/playwright/index.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const WAIT_MS = 15000;
const DAY_MS = 24 * 60 * 60 * 1000;

const READY = '[data-breathing-app][data-pro-patterns="on"]';
const BEGIN = '[data-breathing-app] [data-action="start"]';
const PREVIEW_CARD = '[data-breathing-app] [data-slot="post-session"] [data-ask="preview"]';

/* ------------------------------------------------------------ static server */

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

async function fileExists(abs) {
  try {
    return (await fs.stat(abs)).isFile();
  } catch {
    return false;
  }
}

/**
 * Map a request path onto a file under ROOT the way Vercel does for this site
 * (vercel.json: cleanUrls true, so `/signin` is signin.html). Anything that
 * would escape ROOT is a 404.
 */
async function resolveFile(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const abs = path.resolve(ROOT, '.' + pathname);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  if (await fileExists(abs)) return abs;
  if (!path.extname(abs) && (await fileExists(abs + '.html'))) return abs + '.html';
  return null;
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }
    const abs = await resolveFile(req.url || '/');
    if (!abs) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const type = CONTENT_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    try {
      const body = await fs.readFile(abs);
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('read error');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

/* ---------------------------------------------------------------- fixtures */

const FIXTURE_URL = 'https://testfixture.supabase.co';
const FIXTURE_KEY = 'sb_publishable_TESTFIXTURE0000000000000000';

/**
 * js/config.js with the SUPABASE block's two values set to `url` and `key`,
 * whatever the committed file holds (the owner fills it in for real at some
 * point; the harness must not depend on that). Nothing else in the file changes.
 */
function configWith(source, url, key) {
  const start = source.indexOf('export const SUPABASE = Object.freeze({');
  const end = source.indexOf('});', start);
  if (start < 0 || end < 0) throw new Error('js/config.js: SUPABASE block not found');
  let block = source.slice(start, end);
  let hits = 0;
  block = block.replace(/(\burl:\s*)'[^']*'/, (m, p) => {
    hits += 1;
    return `${p}'${url}'`;
  });
  block = block.replace(/(\bpublishableKey:\s*)'[^']*'/, (m, p) => {
    hits += 1;
    return `${p}'${key}'`;
  });
  if (hits !== 2) throw new Error(`js/config.js: expected url and publishableKey in the SUPABASE block, rewrote ${hits}`);
  return source.slice(0, start) + block + source.slice(end);
}

/** The exact record shape js/storage.js appendSession() writes. */
function completedSessions(count, technique = '478') {
  const list = [];
  for (let i = 0; i < count; i++) {
    const day = String(1 + i).padStart(2, '0');
    list.push({ date: `2026-09-${day}T10:00:00.000Z`, technique, seconds: 600, breaths: 30, completed: true });
  }
  return list;
}

function base64url(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A v3 entitlement token (design §7.2) the client will accept: v 3, typ
 * 'ent', tier 'pro', exp 14 days ahead. The signature bytes are a TESTFIXTURE
 * string, which is fine because js/entitlements.js never verifies them.
 */
function proToken(nowMs) {
  const nowS = Math.floor(nowMs / 1000);
  const payload = {
    v: 3,
    typ: 'ent',
    sub: 'TESTFIXTURE-user-0000',
    tier: 'pro',
    st: 'active',
    plan: 'monthly',
    pe: nowS + 30 * 86400,
    iat: nowS,
    exp: nowS + 14 * 86400,
    kid: 'TESTFIXTURE',
  };
  return `${base64url(JSON.stringify(payload))}.${base64url('TESTFIXTURE-signature-not-verified-client-side')}`;
}

/* ------------------------------------------------------------ browser glue */

let realConfig = '';
let armedConfigText = '';
let unarmedConfigText = '';
let browser = null;
let server = null;
let origin = '';

before(async () => {
  realConfig = await fs.readFile(path.join(ROOT, 'js', 'config.js'), 'utf8');
  armedConfigText = configWith(realConfig, FIXTURE_URL, FIXTURE_KEY);
  unarmedConfigText = configWith(realConfig, '', '');
  ({ server, origin } = await startServer());
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  try {
    if (browser) await browser.close();
  } finally {
    browser = null;
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    server = null;
  }
});

/**
 * Open a fresh context for one scenario, run `fn(page)`, close it. The route
 * handler aborts every off-host request and, when `armed`, answers
 * /js/config.js with the filled-in file.
 *
 * @param {{armed:boolean, storage:Record<string,string>}} options
 * @param {(page:import('playwright').Page, ctx:{errors:string[]}) => Promise<void>} fn
 */
async function withScenario(options, fn) {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 1200, height: 900 },
    locale: 'en-US',
  });
  const errors = [];
  const requested = []; // every URL the page asked for that reached the static server
  const aborted = []; // every off-origin URL the route refused
  try {
    await context.addInitScript((items) => {
      try {
        for (const key of Object.keys(items)) window.localStorage.setItem(key, items[key]);
      } catch {
        /* about:blank has no storage; the real origin does */
      }
    }, options.storage);
    await context.addInitScript(() => {
      const log = [];
      window.__hmbEvents = log;
      const types = ['hmb:ready', 'hmb:preview', 'hmb:signin', 'hmb:paywall', 'hmb:session-start', 'hmb:session-complete'];
      for (const type of types) {
        document.addEventListener(type, (event) => {
          const d = (event && event.detail) || {};
          log.push({
            type,
            reason: d.reason == null ? null : String(d.reason),
            feature: d.feature == null ? null : String(d.feature),
            technique: d.technique == null ? null : String(d.technique),
          });
        });
      }
    });

    const page = await context.newPage();
    page.on('pageerror', (err) => errors.push(String((err && err.message) || err)));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== '127.0.0.1') {
        aborted.push(url.href);
        await route.abort('blockedbyclient');
        return;
      }
      requested.push(url.href);
      if (url.pathname === '/js/config.js') {
        // Always served from the fixture, never from disk: ARMED fills the
        // SUPABASE block in, UNARMED blanks it, whatever the committed file says.
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript; charset=utf-8',
          headers: { 'Cache-Control': 'no-store' },
          body: options.armed ? armedConfigText : unarmedConfigText,
        });
        return;
      }
      await route.fallback();
    });
    await fn(page, { errors, requested, aborted });
    // Network isolation is asserted, not assumed: supabase-js (the one CDN
    // load js/auth.js can make) was never even requested, and everything that
    // was served came from the static server.
    assert.ok(
      !requested.concat(aborted).some((u) => u.includes('supabase-js')),
      `supabase-js was never requested (aborted: ${aborted.join(', ') || 'none'})`,
    );
    assert.ok(requested.every((u) => new URL(u).hostname === '127.0.0.1'), 'every served request was same-origin');
  } finally {
    await context.close();
  }
}

async function waitForApp(page) {
  await page.waitForSelector(READY, { state: 'attached', timeout: WAIT_MS });
  await page.waitForFunction(() => window.__hmbEvents && window.__hmbEvents.some((e) => e.type === 'hmb:ready'), null, {
    timeout: WAIT_MS,
  });
  // js/entitlements.js imports js/auth.js statically (that is where
  // configured() comes from) but defers auth.ready() to an idle callback
  // (2.5 s cap); js/ads.js boots on DOMContentLoaded. Give both a moment so
  // every module that could change the gate's answer has reported in.
  await page.waitForTimeout(400);
}

async function openTimerPage(page, pagePath) {
  await page.goto(origin + pagePath, { waitUntil: 'domcontentloaded' });
  await waitForApp(page);
}

/** What the page's own modules say. Never guesses from the DOM alone. */
async function snapshot(page) {
  return page.evaluate(async () => {
    const auth = await import('/js/auth.js');
    const ent = await import('/js/entitlements.js');
    const root = document.querySelector('[data-breathing-app]');
    const circle = root && root.querySelector('[data-role="circle"]');
    const start = root && root.querySelector('[data-action="start"]');
    const card = root && root.querySelector('[data-slot="post-session"] [data-ask="preview"]');
    const signin = card && card.querySelector('a[data-preview-action="signin"]');
    const slots = Array.from(document.querySelectorAll('.ad-slot'));
    const crisis = document.querySelector('.crisis-block');
    const crisisVisible = !!crisis && crisis.getClientRects().length > 0 && getComputedStyle(crisis).visibility !== 'hidden';
    return {
      crisisBlockVisible: crisisVisible,
      configured: auth.configured(),
      authSignedIn: auth.signedIn(),
      signedIn: ent.signedIn(),
      isPro: ent.isPro(),
      tier: ent.tier(),
      freeSessionsUsed: ent.getLicenseInfo().freeSessionsUsed,
      bodyTier: document.body.dataset.tier || null,
      openTimer: document.body.dataset.openTimer === 'true' || document.body.dataset.openTimer === '',
      sessionActive: document.body.classList.contains('session-active'),
      previewClass: document.body.classList.contains('timer-preview'),
      rootPhase: root ? root.dataset.phase || null : null,
      circlePhase: circle ? circle.dataset.phase || null : null,
      previewDemo: root ? root.dataset.previewDemo || null : null,
      beginDisabled: start ? start.disabled : null,
      card: card
        ? {
            className: card.className,
            reason: card.getAttribute('data-reason'),
            feature: card.getAttribute('data-feature'),
            heading: (card.querySelector('h3') || {}).textContent || '',
            signinHref: signin ? signin.getAttribute('href') : null,
          }
        : null,
      adSlots: slots.length,
      adSlotsWithContent: slots.filter((s) => s.children.length > 0 || s.textContent.trim() !== '').length,
      events: window.__hmbEvents || [],
    };
  });
}

function eventsOf(snap, type) {
  return snap.events.filter((e) => e.type === type);
}

/** Click Begin and give the gate one tick to answer. */
async function pressBegin(page) {
  await page.click(BEGIN);
  await page.waitForTimeout(250);
}

/** The engine is running a session: root and circle in the first phase, body flagged, Begin disabled. */
async function assertSessionRunning(page, label) {
  await page.waitForSelector('[data-breathing-app][data-phase="inhale"]', { state: 'attached', timeout: WAIT_MS });
  await page.waitForSelector('body.session-active', { state: 'attached', timeout: WAIT_MS });
  const s = await snapshot(page);
  assert.equal(s.rootPhase, 'inhale', `${label}: app root data-phase`);
  assert.equal(s.circlePhase, 'inhale', `${label}: circle data-phase`);
  assert.equal(s.sessionActive, true, `${label}: body.session-active`);
  assert.equal(s.previewDemo, null, `${label}: not the preview demonstration`);
  assert.equal(s.beginDisabled, true, `${label}: Begin is disabled while running`);
  assert.equal(eventsOf(s, 'hmb:session-start').length, 1, `${label}: one hmb:session-start`);
  assert.equal(eventsOf(s, 'hmb:preview').length, 0, `${label}: no hmb:preview`);
  assert.equal(eventsOf(s, 'hmb:signin').length, 0, `${label}: no hmb:signin`);
  assert.equal(eventsOf(s, 'hmb:paywall').length, 0, `${label}: no hmb:paywall`);
  assert.equal(s.previewClass, false, `${label}: body has no timer-preview class`);
  return s;
}

/** The gate refused Start: no session, the §8.2 preview instead. */
async function assertGateFired(page, label) {
  await page.waitForSelector(PREVIEW_CARD, { state: 'attached', timeout: WAIT_MS });
  const s = await snapshot(page);
  assert.equal(s.sessionActive, false, `${label}: no body.session-active`);
  assert.equal(eventsOf(s, 'hmb:session-start').length, 0, `${label}: no hmb:session-start`);
  assert.equal(s.beginDisabled, false, `${label}: Begin stays enabled (nothing is running)`);
  // data-phase, if present at all, belongs to the one demonstration cycle
  // js/pro/preview.js animates, which flags itself on the root.
  if (s.rootPhase !== null || s.circlePhase !== null) {
    assert.equal(s.previewDemo, 'running', `${label}: data-phase is the preview demonstration, not a session`);
  }
  assert.deepEqual(
    eventsOf(s, 'hmb:preview').map((e) => e.reason),
    ['signed_out'],
    `${label}: hmb:preview with reason signed_out`,
  );
  assert.deepEqual(
    eventsOf(s, 'hmb:signin').map((e) => e.feature),
    ['timer'],
    `${label}: hmb:signin for the timer`,
  );
  assert.equal(eventsOf(s, 'hmb:paywall').length, 0, `${label}: signed out, so no hmb:paywall`);
  assert.equal(s.previewClass, true, `${label}: body.timer-preview`);
  assert.ok(s.card, `${label}: the preview card rendered into [data-slot="post-session"]`);
  assert.match(s.card.className, /\bpreview-card\b/, `${label}: card class`);
  assert.equal(s.card.feature, 'timer', `${label}: card data-feature`);
  assert.equal(s.card.reason, 'signed_out', `${label}: card data-reason`);
  assert.equal(s.card.heading, 'Create an account to keep going', `${label}: card heading`);
  assert.ok(s.card.signinHref, `${label}: the card has a sign-in link`);
  const href = new URL(s.card.signinHref, origin);
  assert.equal(href.pathname, '/signin', `${label}: sign-in link goes to /signin`);
  assert.equal(href.searchParams.get('next'), new URL(page.url()).pathname, `${label}: next= returns here`);
  assert.equal(s.adSlots, 0, `${label}: js/ads.js removed every .ad-slot on hmb:preview (§8.3)`);
  return s;
}

/* ------------------------------------------------------------------- tests */

test('premise: the fixture arms and blanks js/config.js without touching anything else', () => {
  assert.ok(armedConfigText.includes(`url: '${FIXTURE_URL}'`));
  assert.ok(armedConfigText.includes(`publishableKey: '${FIXTURE_KEY}'`));
  assert.ok(unarmedConfigText.includes("url: ''"));
  assert.ok(unarmedConfigText.includes("publishableKey: ''"));
  for (const text of [armedConfigText, unarmedConfigText]) {
    assert.ok(text.includes('export const TIMER_FREE_SESSIONS = 3;'), 'D1 is untouched');
    assert.ok(/clientToken:\s*'[^']*'/.test(text), 'the CHECKOUT block is intact (the harness never opens a checkout; every off-origin request is refused)');
  }
  const strip = (t) => t.replace(/(\b(?:url|publishableKey):\s*)'[^']*'/g, "$1''");
  assert.equal(strip(armedConfigText), strip(unarmedConfigText), 'the two fixtures differ only in the two SUPABASE values');
  assert.equal(strip(realConfig), strip(unarmedConfigText), 'and only in those values from the committed file');
});

test('1. ARMED + 3 completed sessions on /timer.html: Begin does not run, the preview card renders', async () => {
  await withScenario(
    { armed: true, storage: { 'hmb.history': JSON.stringify(completedSessions(3)), 'hmb.consent': 'essential' } },
    async (page, ctx) => {
      await openTimerPage(page, '/timer.html');
      const before = await snapshot(page);
      assert.equal(before.configured, true, 'js/auth.js configured() is true with the fixture config');
      assert.equal(before.authSignedIn, false, 'js/auth.js signedIn() is false (no session, library never loaded)');
      assert.equal(before.signedIn, false);
      assert.equal(before.isPro, false);
      assert.equal(before.freeSessionsUsed, 3, 'the local history count is what the gate reads');
      assert.equal(before.openTimer, false, '/timer is not a crisis page');
      assert.equal(before.adSlots, 0, '/timer carries no ad slot markup');

      await pressBegin(page);
      await assertGateFired(page, 'scenario 1');
      assert.deepEqual(ctx.errors, [], 'no uncaught page errors');
    },
  );
});

test('1b. ARMED + 3 STARTED sessions (none completed) on /timer.html: Begin does not run — stopping early spends a session too', async () => {
  await withScenario(
    { armed: true, storage: { 'hmb.sessions_started': '3', 'hmb.consent': 'essential' } },
    async (page, ctx) => {
      await openTimerPage(page, '/timer.html');
      const before = await snapshot(page);
      assert.equal(before.freeSessionsUsed, 3, 'started sessions count, finished or not');
      await pressBegin(page);
      await assertGateFired(page, 'scenario 1b');
      const s = await snapshot(page);
      assert.equal(s.rootPhase, null, 'scenario 1b: nothing animates once the allowance is spent');
      assert.deepEqual(ctx.errors, [], 'no uncaught page errors');
    },
  );
});

test('2. ARMED + 2 completed sessions on /timer.html: Begin runs', async () => {
  await withScenario(
    { armed: true, storage: { 'hmb.history': JSON.stringify(completedSessions(2)), 'hmb.consent': 'essential' } },
    async (page, ctx) => {
      await openTimerPage(page, '/timer.html');
      const before = await snapshot(page);
      assert.equal(before.configured, true);
      assert.equal(before.freeSessionsUsed, 2, 'one session left under D1 = 3');

      await pressBegin(page);
      const s = await assertSessionRunning(page, 'scenario 2');
      assert.equal(s.card, null, 'no preview card');
      assert.deepEqual(ctx.errors, [], 'no uncaught page errors');
    },
  );
});

test('3. ARMED + 5 completed sessions on /breathing-exercises-for-panic-attacks.html: Begin runs, no card, no ad slot (design §16 test 24)', async () => {
  await withScenario(
    { armed: true, storage: { 'hmb.history': JSON.stringify(completedSessions(5, 'sigh')), 'hmb.consent': 'essential' } },
    async (page, ctx) => {
      await openTimerPage(page, '/breathing-exercises-for-panic-attacks.html');
      const before = await snapshot(page);
      assert.equal(before.configured, true);
      assert.equal(before.openTimer, true, 'body carries data-open-timer');
      assert.equal(before.freeSessionsUsed, 5, 'well past D1');
      assert.equal(before.signedIn, false);
      assert.equal(before.adSlots, 0, 'zero ad slots on a crisis page');
      assert.equal(before.crisisBlockVisible, true, 'the helpline block is rendered and visible');

      await pressBegin(page);
      const s = await assertSessionRunning(page, 'scenario 3');
      assert.equal(s.card, null, 'no preview card');
      assert.equal(s.adSlots, 0, 'still zero ad slots');
      assert.equal(s.crisisBlockVisible, true, 'the helpline block is still visible while the timer runs');
      assert.deepEqual(ctx.errors, [], 'no uncaught page errors');
    },
  );
});

test('4. UNARMED (SUPABASE blanked) + 3 completed sessions on /timer.html: Begin runs (mirror of tools/gate.test.mjs)', async () => {
  await withScenario(
    { armed: false, storage: { 'hmb.history': JSON.stringify(completedSessions(3)), 'hmb.consent': 'essential' } },
    async (page, ctx) => {
      await openTimerPage(page, '/timer.html');
      const before = await snapshot(page);
      assert.equal(before.configured, false, 'js/auth.js configured() is false with SUPABASE blanked');
      assert.equal(before.freeSessionsUsed, 3, 'at the D1 limit');
      assert.equal(before.signedIn, false);
      assert.equal(before.isPro, false);

      await pressBegin(page);
      const s = await assertSessionRunning(page, 'scenario 4');
      assert.equal(s.card, null, 'no preview card');
      assert.deepEqual(ctx.errors, [], 'no uncaught page errors');
    },
  );
});

test('5. ARMED + 5 sessions + a pro token on /4-7-8-breathing.html: runs and strips ad slots; 15 days later the gate fires (design §16 test 21)', async () => {
  const pageHtml = await fs.readFile(path.join(ROOT, '4-7-8-breathing.html'), 'utf8');
  assert.match(pageHtml, /class="ad-slot"/, 'premise: this page ships an ad slot for the pro tier to remove');

  const now = Date.now();
  await withScenario(
    {
      armed: true,
      storage: {
        'hmb.history': JSON.stringify(completedSessions(5)),
        'hmb.consent': 'essential',
        'hmb.ent': proToken(now),
      },
    },
    async (page, ctx) => {
      await openTimerPage(page, '/4-7-8-breathing.html');
      const before = await snapshot(page);
      assert.equal(before.configured, true);
      assert.equal(before.freeSessionsUsed, 5, 'well past D1');
      assert.equal(before.isPro, true, 'the planted token decodes to pro (exp 14 days ahead)');
      assert.equal(before.tier, 'pro');
      assert.equal(before.bodyTier, 'pro', 'body[data-tier] stamped');
      await page.waitForFunction(() => document.querySelectorAll('.ad-slot').length === 0, null, { timeout: WAIT_MS });
      const stripped = await snapshot(page);
      assert.equal(stripped.adSlots, 0, 'js/ads.js removed every .ad-slot for the pro tier');

      await pressBegin(page);
      const running = await assertSessionRunning(page, 'scenario 5 (pro)');
      assert.equal(running.card, null, 'no preview card for a subscriber');
      assert.equal(running.adSlots, 0, 'ad slots stay gone');

      // Reload with the same clock: the cached token alone keeps the page pro
      // (no server answered; every off-origin request is refused). This is
      // the token half of design §16 test 21; the offline-shell half needs the
      // service worker, which this harness blocks, and is left to the sandbox run.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForApp(page);
      const again = await snapshot(page);
      assert.equal(again.isPro, true, 'still pro after a reload from the cached token alone');
      assert.equal(again.tier, 'pro');
      assert.equal(again.bodyTier, 'pro');
      await page.waitForFunction(() => document.querySelectorAll('.ad-slot').length === 0, null, { timeout: WAIT_MS });

      // Advance the clock 15 days and reload. The token's exp (14 days) is
      // behind the fixed time, so the decode yields free and the free-session
      // gate is back in charge. Playwright's clock is set before the reload so
      // it applies from the first script of the new document.
      await page.clock.setFixedTime(now + 15 * DAY_MS);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForApp(page);

      const later = await snapshot(page);
      assert.equal(later.isPro, false, 'isPro() is false once exp is behind Date.now()');
      assert.equal(later.tier, 'free');
      assert.equal(later.bodyTier, 'free');
      assert.equal(later.freeSessionsUsed, 5);
      assert.equal(later.signedIn, false);
      assert.ok(later.adSlots > 0, `the ad slot markup is back for the free tier (${later.adSlots})`);

      await pressBegin(page);
      await assertGateFired(page, 'scenario 5 (expired)'); // ...and hmb:preview strips the slots again
      assert.deepEqual(ctx.errors, [], 'no uncaught page errors');
    },
  );
});
