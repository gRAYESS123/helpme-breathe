# `tools/site-check.mjs` — pre-deploy QA gate

Zero-dependency Node script (Node 18+, tested on Node 24) that validates the static
site before a deploy. No npm packages, no build step, no network calls.

```bash
node tools/site-check.mjs
node tools/site-check.mjs --root . --base https://helpmebreath.com
node tools/site-check.mjs --json site-check.json
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--root <dir>` | cwd | Site root to scan. Skipped: any `node_modules`, `.git`, `.vercel`, `.next`, `.cache` or `dist-cache` directory, and the `docs/private` subtree (brand concept boards and private specs, not pages) |
| `--base <url>` | `https://helpmebreath.com` | Canonical origin; drives canonical/sitemap/host checks |
| `--json <file>` | – | Also write findings as `[{level, file, line, rule, message}]` |
| `-h`, `--help` | – | Usage |

**Exit code: `1` if any ERROR was reported, else `0`.** Warnings and info never fail
the build, so this is safe as a CI gate and a pre-push hook:

```yaml
# .github/workflows/qa.yml
- run: node tools/site-check.mjs --json site-check.json
```

## URL model

Every check that involves a link, canonical, sitemap entry or precache entry goes
through one shared model of the site's public URL space:

1. **`vercel.json`** if present — honours `cleanUrls`, `trailingSlash`, `rewrites`
   and `redirects`. Source patterns support `:param`, `:param*`, `(.*)` and `*`;
   destinations support `:param`, `:splat` and `$1`.
2. Otherwise the legacy **`_redirects`** file (Netlify `/from /to 200|301` format).
   `200` rules are treated as rewrites, everything else as redirects. Rules whose
   source is a full URL (host canonicalisation) are counted but not applied to paths.
3. Otherwise filesystem-only.

Mapping: `index.html` → `/`, `a/index.html` → `/a`, `a/b.html` → `/a/b.html`
(plus `/a/b` when `cleanUrls` is on). Resolution follows rewrites then redirects,
up to 8 hops, with cycle detection.

The distinction matters in the report:

* **rewrite** (200, URL unchanged) → `INFO link-via-rewrite`; a canonical reached
  this way is *valid*.
* **redirect** (30x, URL changes) → `INFO link-via-redirect` for a link (works, but
  costs a hop), and an **ERROR** for a canonical, a sitemap `<loc>` or a service-worker
  precache entry, because those must be final URLs.

Relative URLs are resolved against every public URL the page is served at (the
canonical first). A relative link that only works from *some* of those URLs gets
`WARN relative-link-ambiguous`.

## What it checks

**Per page** — `<html lang>`, `<meta charset>`, viewport, exactly one `<h1>`,
`<title>` (missing → ERROR, > 65 chars → WARN), meta description (missing → ERROR,
outside 50–165 chars → WARN), canonical (present, absolute, on `--base`, resolves to
*this* page, unique across the site), `og:title` / `og:description` / `og:image`
(absolute + local file exists) / `og:url` (matches canonical), `twitter:card`,
`<img>` alt text (`alt=""` allowed only with `role="presentation"` / `aria-hidden`),
`target="_blank"` without `rel="noopener"`, every internal `href` / `src` / `srcset` /
`poster` / `data-src`, in-page `#fragment` targets, `application/ld+json` (parses,
has `@context`, and its `url` / `image` / `logo.url` / `item` values on the site
domain resolve → WARN), placeholder text (`lorem ipsum`, `TODO`, `TBD`, `coming soon`,
`INSERT_`, `XXX`, `[placeholder]`, `example.com`), non-canonical host references
(`http://helpmebreath.com`, `www.helpmebreath.com`), insecure `http://` assets, and
an INFO count of inline `on*=` handlers.

**Site-wide** — `sitemap.xml` (parses, every `<loc>` absolute, on base, resolves to an
indexable page whose canonical equals the loc; indexable pages missing from it → WARN),
`robots.txt` (`Sitemap:` line matches `<base>/sitemap.xml`, no site-wide `Disallow: /`),
`manifest.json` (parses, icon files exist, `start_url`/`scope` resolve, linked from a
page), `sw.js` (`PRECACHE_URLS` entries all resolve and are not redirects — a single bad
entry makes `cache.addAll()` reject and the SW install fail), `ads.txt` (INFO),
`vercel.json` (valid JSON, every local rewrite/redirect destination exists), the
site-wide Content-Security-Policy against every origin the pages and their scripts
actually load (`csp-origins`, below), orphan pages, and an INFO roll-up of every
outbound host.

## Accounts-model and brand rules

Added with the one-plan, one-account model (2026-09-11) and the Paper and Ink
brand. Each finding names its rule id, and every one of these is an ERROR:

| Rule id | What it refuses |
| --- | --- |
| `open-timer-allowlist` | `data-open-timer` on any `<body>` other than the two crisis pages (`breathing-exercises-anxiety.html`, `breathing-exercises-for-panic-attacks.html`). It runs the timer for anyone, forever, so it is a safety feature, not a config knob. |
| `open-timer-missing` | Either crisis page without `data-open-timer="true"` on `<body>`. |
| `provider-outside-seam` | A payment company named (outside comments) in any `api/**/*.js` or `js/**/*.js` file other than the seam: `api/_lib/providers/`, `api/_lib/env.js`, `js/config.js`, `js/checkout.js`. One env var must be able to swap the rail. |
| `second-plan` | Any trace of a practitioner or therapist plan, or a switch for one, in `api/` or `js/` (owner decision 2026-09-12: one plan, no switch). |
| `copy-truth` | "free forever", "always free", "no sign-up", and an unqualified "no account" in page text, `<title>`, `<meta content>` or JSON-LD. A short allowlist keeps the sentences that are still true ("the first three sessions need no account"). |
| `paywall-markup` | `isAccessibleForFree: false`, or `hasPart` + `cssSelector` paywall markup, in JSON-LD. Only the interactive timer is gated, never the prose. |
| `clay-on-timer` | `var(--clay)` in any `.css` rule whose selector is scoped to `.breathing-section`, `[data-slot="post-session"]`, `.post-session-card` or `.paywall-card`. The commerce accent belongs on `/pro`; the timer is not for sale (`docs/BRAND.md` §1 and §8). |

## CSP origins (`csp-origins`)

`vercel.json` ships a site-wide `Content-Security-Policy-Report-Only` for `/(.*)`.
It is report-only on purpose: `docs/private/KNOWN_GAPS.md` lists promoting it to
enforcing as deferred until the first configured deploy has been exercised with the
console open. `csp-origins` exists so that promotion can happen without taking the
site down. The day the header is renamed to `Content-Security-Policy`, every origin a
page or its scripts touch must already be allowed by the directive that governs that
fetch, or the browser drops the request silently and the timer goes with it.

The rule parses each `Content-Security-Policy` / `Content-Security-Policy-Report-Only`
header for the `/(.*)` source into directives, then walks every page the checker
already walks, the JavaScript those pages load (`<script src>`, then static and
dynamic `import`s followed transitively, inline `<script>` bodies included, plus the
service worker they register) and the stylesheets they link, and collects every
absolute URL by the directive that would govern it:

| Collected from | Directive |
| --- | --- |
| `<script src>`, `<link rel="modulepreload">`, `import … from 'https://…'`, `import('https://…')`, a `document.createElement('script')` element's `.src =` or `setAttribute('src', …)` | `script-src` |
| `<link rel="stylesheet">`, `<link rel="preload" as="style">`, CSS `@import` | `style-src` |
| `<link rel="preload" as="font">`, `@font-face { src: url(…) }`, any `fonts.gstatic.com` preconnect | `font-src` |
| `<img src>` / `srcset`, `<source srcset>`, `<video poster>`, `<input type="image">`, icon `<link>`s, CSS `url(…)`, inline `style="url(…)"` | `img-src` |
| `<video src>`, `<audio src>`, `<source src>`, `<track src>` | `media-src` |
| `<iframe src>` | `frame-src` |
| `<embed src>`, `<object data>` | `object-src` |
| `<link rel="manifest">` | `manifest-src` |
| `<form action>`, `formaction=` | `form-action` |
| `<base href>` | `base-uri` |
| `fetch()`, `XMLHttpRequest.open()`, `new EventSource()`, `new WebSocket()`, `navigator.sendBeacon()` | `connect-src` |
| `new Worker()`, `navigator.serviceWorker.register()` | `worker-src` |
| `<link rel="preconnect">` / `dns-prefetch` | whatever directive the page uses that origin for; when nothing on the page fetches from it, `style-src` (`fonts.gstatic.com`: `font-src`) |

In JavaScript the URL may be a string literal, a template literal whose static prefix
carries the whole host (`` `https://pagead2.googlesyndication.com/…?client=${CLIENT}` ``),
or an identifier declared with `const` / `let` / `var` in the same file. Comments,
string bodies and regex literals are blanked before call sites are located, so a
`fetch(` inside a string or a URL in a comment is not a reference, and a finding
points at the line that does the loading, not at the constant it reads.

Matching follows CSP3. `'self'` is the `--base` host over `https:` or `wss:`;
`'none'` matches nothing; `*` matches any network origin; scheme-only sources
(`https:`, `wss:`, `data:`) match by scheme; `https://*.paddle.com` matches
`js.paddle.com` and not `paddle.com`; a schemeless host takes the page's scheme, so
`*.supabase.co` alone would not allow `wss://`; ports and path prefixes are honoured;
and the fallback chain applies (`frame-src` → `child-src` → `default-src`,
`worker-src` → `child-src` → `script-src` → `default-src`; `form-action` and
`base-uri` never fall back). A directive absent from the policy and from its fallbacks
leaves that kind of fetch unrestricted.

Every reference the governing directive would not allow is an **ERROR `csp-origins`**
at the file and line that loads it, naming the origin, the directive (and the one it
fell back to), the header, and the full URL. Plain `<a href>` links, `og:` and JSON-LD
URLs and prose are never fetched by the page and are never collected. `api/` and
`tools/` are not scanned. When no CSP header exists for `/(.*)`, one
`INFO csp-origins` says so and nothing is checked.

One `INFO csp-origins` per header summarises the run: directives in the policy, which
of them the site actually exercises, how many pages, scripts and stylesheets were
scanned, and every external origin found with the directive(s) it appeared under.
Read that line before promoting: it is the list of origins the enforcing policy must
keep.

What it cannot see: URLs assembled at runtime, and the requests third-party scripts
make on their own once they run. The Supabase project URL comes from `js/config.js` at
runtime (the policy's `https://*.supabase.co` and `wss://*.supabase.co` are meant to
cover it, but nothing static proves it). The Stripe checkout is a top-level
navigation to `checkout.stripe.com`, which a CSP does not govern (the Paddle
origins in the policy serve the retired overlay path). `gtag.js` and
`adsbygoogle.js` each load further origins after they start: Google's CSP guidance for
gtag.js lists `https://*.analytics.google.com` and `https://www.googletagmanager.com`
under `connect-src` and `https://www.googletagmanager.com` under `frame-src`, none of
which the current policy names, and its guidance for its ad tags says the domains
change over time and only a nonce-based policy is supported. The report-only telemetry
on the first configured deploy is the only evidence for those, which is why
`KNOWN_GAPS.md` gates the promotion on exercising sign-in, a sandbox checkout and the
timer gate with the console open. This rule guards the half that can be proved from
the repo.

## Severity conventions

* **ERROR** — breaks the deploy: broken link, wrong canonical, unparseable JSON/JSON-LD,
  placeholder copy shipped to users, a precache entry that will brick the service worker.
* **WARN** — should be fixed but will not break production.
* **INFO** — context (redirect hops, inline-handler counts, outbound hosts, ads.txt).

Also worth knowing: `link-case` is an ERROR for a path that differs from the real file
only in letter case. That works on Windows/macOS and 404s on Vercel's case-sensitive
Linux hosts, so it is exactly the class of bug that only appears after deploy.

## Non-indexable pages

`404.html`, `offline.html`, `500.html` and any page with
`<meta name="robots" content="noindex">` are treated as utility pages: canonical,
social-meta, meta-description and sitemap-membership checks are skipped for them
(one `INFO utility-page` line says so). Structural checks (lang, charset, viewport,
`<h1>`, title, links, placeholders) still apply.

## Limitations

* **Regex tokenizer, not a real parser.** It is deliberately tolerant — it never throws
  on malformed markup, and a file it cannot make sense of yields findings rather than a
  crash (an unrecoverable file produces one `ERROR internal-error`). It does not build a
  DOM, so it cannot see nesting errors, unclosed elements or CSS-derived visibility. An
  unterminated `<script>`/`<style>` swallows the rest of the document, which is what a
  browser does too, but it means later checks on that file report nothing.
* **Static only.** Nothing is fetched over the network: external links are recorded but
  never verified, and JS-injected markup is invisible. The per-page checks run on `.html`
  files only; `.css` files are read for `clay-on-timer`, `api/**/*.js` / `js/**/*.js`
  for `provider-outside-seam` and `second-plan`, and the scripts and stylesheets a page
  loads for `csp-origins`, but nothing else in JS or CSS is checked, so placeholder text
  living in `js/app.js` or `css/styles.css` is not caught. `csp-origins` reads JavaScript
  with a light scanner, not a parser: a URL built by string concatenation, read from
  config, or passed through a function is invisible to it.
* **URL-model approximations.** Vercel's real precedence is redirects → filesystem →
  rewrites; this script tries the filesystem first, then rewrites, then redirects, which
  can differ if a redirect deliberately shadows an existing file. `has`/`missing`
  conditions on Vercel rules are ignored, and parameterised destinations
  (`:slug`, `$1`) are not verified in the `vercel.json` destination-exists check.
* **No performance, accessibility or content-quality auditing.** No Lighthouse, no
  contrast checks, no Core Web Vitals, no schema validation against schema.org's
  vocabulary (only that the JSON parses and its URLs resolve).
* Duplicate-canonical detection reports on whichever file is scanned second
  (alphabetical order), so the pair is `file` plus the other file named in the message.
