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
`vercel.json` (valid JSON, every local rewrite/redirect destination exists), orphan
pages, and an INFO roll-up of every outbound host.

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
  files only; `.css` files are read for `clay-on-timer` and `api/**/*.js` / `js/**/*.js`
  for `provider-outside-seam` and `second-plan`, but nothing else in JS or CSS is checked,
  so placeholder text living in `js/app.js` or `css/styles.css` is not caught.
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
