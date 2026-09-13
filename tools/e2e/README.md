# tools/e2e — the free-session gate, end to end

One file, `gate.e2e.mjs`. It drives the real pages in headless Chromium and
proves that the timer's free-session gate (`js/entitlements.js`
`requireTimer()`, design §8.1) **arms once sign-in is configured**. The unit
test `tools/gate.test.mjs` only pins the inert path (SUPABASE empty, every
session passes); this is the other half.

## Run it

```
npm run e2e
```

That is `node --test tools/e2e/gate.e2e.mjs`. It prints the standard
`node:test` summary and exits non-zero on any failure. About 9 seconds.

`npm test` does **not** include it: the `test` script globs `tools/*.test.mjs`
and this file is deliberately named `.e2e.mjs` in a subfolder, because it
needs a Chromium binary and a Playwright install, which the unit suites do
not. `tools/site-check.mjs` audits `.html` files only, so nothing in here is
treated as a page.

## What it needs

- Node 18+ (the repo's engine).
- Playwright from `tools/render/node_modules` (the render tool's own install,
  imported by relative path — the site itself stays dependency-free) and its
  Chromium, installed with `npx playwright install chromium` from
  `tools/render`.

## What it does not need

- **No Supabase project.** `GET /js/config.js` is intercepted and answered
  with the committed file plus TESTFIXTURE values for `SUPABASE.url` and
  `SUPABASE.publishableKey`, which is all `js/auth.js configured()` looks at.
  The committed `js/config.js` is never edited.
- **No network.** The repo root is served by a small node `http` server on an
  ephemeral `127.0.0.1` port, and every request to any other host is aborted
  (the CDN that hosts supabase-js, fonts, tag manager, the ad loader, the
  checkout overlay). `js/auth.js` never loads the auth library — with no
  cached session `ready()` returns before importing it — so `signedIn()` is
  false, which is the signed-out visitor the gate exists for. Service workers
  are blocked so `sw.js` cannot serve a cached config.

## What it covers

Each scenario runs in a fresh browser context with fixtures written into
`localStorage` before any page script runs: `hmb.history` in the exact
record shape `js/storage.js appendSession()` writes, `hmb.consent` set to
`essential` so the banner stays out of the way, and (scenario 5) an
`hmb.ent` token.

| # | Config | Page | Fixture | Expect |
|---|--------|------|---------|--------|
| 1 | ARMED | `/timer.html` | 3 completed sessions | Begin does **not** start a session. `hmb:preview` (reason `signed_out`) and `hmb:signin` (feature `timer`) fire, the preview card renders into `[data-slot="post-session"]` with a link to `/signin?next=…`, `body.timer-preview` is set, no `.ad-slot` has content. |
| 2 | ARMED | `/timer.html` | 2 completed sessions | Begin runs: `data-phase="inhale"` on the app root and the circle, `body.session-active`, `hmb:session-start`. |
| 3 | ARMED | `/breathing-exercises-for-panic-attacks.html` | 5 completed sessions | Crisis page (`data-open-timer`): Begin runs, no card, zero ad slots (design §16 test 24). |
| 4 | UNCONFIGURED (the committed config) | `/timer.html` | 3 completed sessions | Begin runs — the browser mirror of `tools/gate.test.mjs`. |
| 5 | ARMED | `/4-7-8-breathing.html` | 5 completed sessions + a v3 `pro` token with `exp` 14 days ahead | `isPro()` true, every `.ad-slot` removed, Begin runs. Then `page.clock.setFixedTime(now + 15 days)` and reload: `isPro()` false, the gate fires again (design §16 test 21). |

Scenario 5 also reloads once with the clock unchanged and expects the page to stay `pro` from the cached token alone (no server ever answers here). That is the token half of design §16 test 21; the offline-shell half (the service worker serving the page with the network off) is not exercised, because this harness blocks service workers, and belongs to the sandbox run. Every scenario also asserts that supabase-js was never requested and that every served request came from the local static server.

A "premise" test first checks that the committed `js/config.js` really is
unconfigured and that the fixture changes exactly the two SUPABASE values.

## How a session is told apart from the preview

The §8.2 preview state animates one demonstration cycle with the same
attributes the engine writes (`data-phase` on the app root and the circle,
`js/pro/preview.js runDemonstration()`), so `data-phase` alone cannot prove
that a session ran. The test therefore reads what only a real session does —
`body.session-active`, the `hmb:session-start` event, Begin becoming
disabled — and what only the demonstration does, `data-preview-demo="running"`
on the app root. A `data-phase` seen after a refused Start must belong to the
demonstration.

## The planted token

`js/entitlements.js` decodes the entitlement payload without verifying the
HMAC (design §7.3 step 3: local decoding is a convenience, the server is the
security boundary). The test builds `base64url(JSON) + '.' +
base64url(signature)` with `{ v: 3, typ: 'ent', tier: 'pro', exp: now + 14d }`
and a `TESTFIXTURE` signature string. Every key-like value in this folder
contains `TESTFIXTURE`, which is what GitHub push protection requires.
