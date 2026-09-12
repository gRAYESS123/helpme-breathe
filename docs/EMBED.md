# The embeddable widget and the client session link

Everything a third-party site loads from us, plus the co-branded link a
subscriber sends to a client.

| File | URL | What it is |
|---|---|---|
| `embed/v1/breathe.js` | `/embed/v1/breathe.js` | The loader. A classic script the host page includes; it replaces itself with an iframe. ~3 KB, ~1.4 KB gzipped. |
| `embed/v1/frame.html` | `/embed/v1/frame` | The widget itself — **the free, attributed one**. A static file, CDN-cacheable, running the shared engine. |
| `api/embed/frame.js` | `/api/embed/frame` | **The same document**, served by a function that decides the white-label verdict at render time and inlines it. |
| `embed/v1/frame.css` | `/embed/v1/frame.css` | The widget's only stylesheet. |
| `api/embed/token.js` | `/api/embed/token` | Mint, list, rotate and revoke a subscriber's embed credentials. Driven from `/account`. |
| `s/index.html` | `/s/?c=…` | The client session link. First-party, not an embed. |

The marketing and configurator page is `/embed` (`embed.html`).

### Why there are two frame URLs

One document, two paths. Vercel gives the filesystem precedence over rewrites —
*"The `source` property should NOT be a file because precedence is given to the
filesystem prior to rewrites being applied"* — so while `embed/v1/frame.html`
exists as a static file, no rewrite of that path can reach a function. The
function therefore answers at its own path, and the loader sends white-label
embeds there directly:

- **no `data-wl`** → `/embed/v1/frame`, the static file. Cached, fast, attributed.
- **`data-wl` set** → `/api/embed/frame`, the function. Same HTML, plus
  `window.__HMB_EMBED = { whitelabel, reason }` decided for that one request.

`vercel.json` must carry
`"functions": { "api/embed/frame.js": { "includeFiles": "embed/v1/frame.html" } }`,
because Vercel's file tracer cannot see a `readFile()` whose path is computed.
Without it the function falls back to the static document on every request —
safe, but never white-labelled.

---

## 1. Quick start

```html
<script src="https://helpmebreath.com/embed/v1/breathe.js"
        data-technique="box"
        data-duration="300"
        data-theme="auto"
        data-sound="1"></script>
```

The loader reads its own `data-*` attributes, builds
`/embed/v1/frame?technique=box&duration=300&…`, inserts an iframe in its own
place and removes itself. Several snippets on one page work; each iframe is
resized independently.

The iframe it creates:

```html
<iframe src="https://helpmebreath.com/embed/v1/frame?…"
        title="Guided breathing exercise"
        loading="lazy"
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        allow="screen-wake-lock"
        data-hmb-embed="1"
        style="display:block;width:100%;max-width:100%;min-height:420px;border:0;background:transparent"></iframe>
```

`allow-same-origin` is required: the frame reads `localStorage` for the sound
preference, which is a same-origin operation. It makes no API call of its own —
the white-label verdict is already in the document (§4).
`allow-popups-to-escape-sandbox` is there for one link:
without it the attribution link's new tab would inherit the frame's sandbox and
land the reader on a crippled copy of helpmebreath.com. The frame opens no other
window. Modern browsers partition that storage to the host site,
so nothing is shared between the widget on one site and the widget on another,
or with helpmebreath.com itself.

**Anyone can also point an iframe at the frame URL directly** and skip the
loader. They then lose automatic resizing and have to set a height.
`/embed/v1/frame.html` resolves too — `vercel.json` sets `cleanUrls`, so the
`.html` form 308-redirects to the clean URL. The loader uses the clean URL to
avoid that redirect on every widget load.

---

## 2. Parameters

Each loader attribute maps to the frame query parameter of the same name. Every
value is validated in the frame's head script before anything reads it; an
invalid value is discarded and the default applies. Nothing invalid is ever
"best-effort corrected".

| Attribute / param | Accepted | Default | Notes |
|---|---|---|---|
| `technique` | a key from `js/techniques.js` (`478`, `box`, `coherent`, `sigh`, `extended`, `triangle`, `wim`) | `478` | Shape-checked in the head script, resolved for real by `getTechnique()`. The frame is always `data-lock-technique`: there is no pattern switcher inside a widget. |
| `duration` | whole seconds, 30–7200, or `-1` for unlimited | `300` | Passed to the engine as `?d=`, which outranks a saved preference — the site owner's choice wins. |
| `theme` | `auto` \| `light` \| `dark` | `auto` | The **surround**, not the pattern's palette. See §3. |
| `accent` | six hex digits, `#` optional | the pattern's own rim colour | Sets `--rim` — the circle's ring, the progress fill and the reduced-motion pacer — and forces `--fill` to `var(--leaf)` so the phase word keeps its contrast whatever colour is chosen. Nothing checks that an arbitrary hex clears 3:1 on either ground. |
| `logo` | an `https:` URL, ≤ 500 chars | none | **Rendered only after white-label verification.** The one cross-origin request the frame can make, and only for a verified credential. |
| `brand` | plain text, ≤ 40 chars | none | Free tier. Written with `textContent`; control characters are stripped. Does not remove attribution. |
| `sound` | `0` \| `1` | the engine's default (on) | A *first-visit* default. If the visitor has already used the sound toggle in this embed, their choice stands. |
| `mode` | `normal` \| `kiosk` \| `class` | `normal` | See §3. |
| `wl` | an embed credential, 8–4096 chars of `[A-Za-z0-9._~-]` | none | See §4. Setting it also sends the iframe to `/api/embed/frame` instead of the static file. |

Anything shorter than the `wl` minimum, or outside that character set, is
treated as absent — which means the free, attributed widget.

---

## 3. Modes and the surround theme

**`theme` picks which token set the frame runs on.** There are no gradients
anywhere in the widget: the circle is a ring in the technique's rim colour with
a light interior, on a leaf card, on a paper ground. `theme=light` uses the day
token set (warm paper ground, leaf card); `theme=dark` uses the night set (dark
ground, dark circle interior, a light rim and a bone phase word); `theme=auto`
follows the visitor's `prefers-color-scheme`. Every pair inside the card is a
token, so all three surrounds carry the same measured contrast.

**`mode=normal`** — a timer sized to the host page. Reports its height (§5).

**`mode=kiosk`** — free tier. `data-kiosk` on the app root, so `js/app.js`
autostarts, loops on completion and takes a Screen Wake Lock. Controls, settings
and stats are hidden and the circle is sized from `vmin`. Because that sizing is
viewport-relative, **kiosk mode does not report a height** — measuring it would
feed back into the size the host gave it. It posts `{type:'hmb:resize',
height:0, mode:'kiosk'}` once so the host knows to size the iframe itself.

> One caveat: the energizing pattern (`wim`) requires a safety acknowledgement
> before its first session (hard rule 4). In kiosk mode that panel appears and
> waits for one tap. Acknowledge it once on the device and the flag is stored;
> after that the kiosk autostarts normally.

**`mode=class`** — part of the plan. Oversized phase text for a projector, plus a
full-width **Start class** button that also resumes. It renders immediately when
a `wl` credential is present and **downgrades to `normal` if verification
fails**, rather than making every legitimate class start in the wrong layout.

Class mode never speaks. Phase names reach the room visually and reach a screen
reader through `[data-role="live-region"]`; the frame calls no speech API. A
timer that talks over a teacher is worse than one that does not.

### The safety block is not optional

Four of the seven patterns hold the breath and one is a fast pattern, and hard
rule 4 says every one of those carries an explicit contraindication block. The
host page cannot be relied on to provide it, so the frame carries its own:
`<details class="hmb-safety">`, collapsed by default, holding one static
sentence ("Paced breathing is a self-care practice, not medical care…"), the
running technique's own `contraindications` array rendered with `textContent`,
and a link to `/legal/medical-disclaimer`.

It sits **outside** `[data-hmb-attrib]`, so white-labelling removes the
attribution and never the safety copy — a subscription buys the removal of our
name, not the removal of a health warning. `/s/` carries the same block for the same
reason. Kiosk mode hides it along with the rest of the chrome, because a signage
screen has no reader; that is the one place the host is responsible for posting
it. Opening the block fires a resize report, so the host iframe grows to fit.

---

## 4. White-label verification

The **only** thing that removes the attribution footer. A subscriber gets it by
minting a credential on `/account` for the domains they will embed on.

### Credentials, groups and rotation

There are no licence keys, no device activations and **no domain counts** — the
plan includes the white-label embed, and the domain list exists to bind a
credential to a site, not to meter it.

`/account` drives `/api/embed/token` (live bearer JWT on every call):

| Action | What happens |
|---|---|
| **Mint** | Creates a **group** (`token_id`, e.g. `et_…`) holding up to 10 domains and an optional label, and issues its first credential. You get back the credential and the two ready-made snippets. |
| **List** | Every group with its domains, its credentials, and their hit counts. |
| **Rotate** | Issues a fresh credential for the same group and stamps `superseded_at` on the live ones, which **keep verifying for 48 hours**. Long enough that a snippet already pasted into a site keeps working while it is updated. |
| **Revoke** | Stamps `revoked_at` on the group **and** on every credential in it, so every one dies at once and the frame's per-row check agrees with the group check whichever it reads first. |

A credential is a v3 signed token with `typ: 'emb'`, payload
`{ v:3, typ:'emb', sub, gid, jti, dom[], iat, exp, kid }`, and it **expires 30
days after issue**. The account entitlement token (`typ: 'ent'`) is refused here:
it is a 14-day bearer credential for the signed-in browser and has no business in
a shareable link.

Domains are normalised through the URL parser, so a pasted `https://Clinic.Example/`
becomes `clinic.example` and an IDN becomes its punycode form — which is how the
`Referer` header will spell it. **Wildcards are refused** (the check is an exact
hostname match, so `*.clinic.example` would never match anything), and so is
helpmebreath.com itself.

### The check happens at document time

The embedding origin is observable on **exactly one request**: the fetch of the
frame document itself. When `<iframe src="https://helpmebreath.com/api/embed/frame?wl=…">`
sits on `clinic.example`, the browser sends `Sec-Fetch-Dest: iframe`,
`Sec-Fetch-Site: cross-site` and a `Referer` carrying the clinic's origin.
Everything the frame fetches afterwards is same-origin to us and says nothing
about the clinic. So `api/embed/frame.js` reads those three headers, verifies the
credential, and inlines the verdict:

```js
window.__HMB_EMBED = { whitelabel: true, reason: 'ok' };
```

**The runtime never re-asks.** The frame makes no API call at all — earlier
revisions had it POST to `/api/entitlement` with a `host` field, which could not
work: the frame is served from our own origin, so that request was same-origin
and `Origin`/`Referer` always said helpmebreath.com.

The order of checks, cheapest first:

1. rate limit (120/min per IP);
2. `wl` present and matching `[A-Za-z0-9._~-]{8,4096}`;
3. signature, version, `typ`, payload shape, `kid`, expiry;
4. **the headers**: fetch metadata must be present and say "iframe, cross-site",
   and the `Referer`'s hostname must be **exactly** one of the credential's
   domains — `clinic.example` does not cover `www.clinic.example` unless that is
   listed too;
5. **the ledger**, three reads in parallel: the `jti` row, its group, and the
   issuing subscriber's subscription rows. The credential must not be revoked,
   must not be more than 48 hours past `superseded_at`, must not be past
   `expires_at`; the group must not be revoked; and the subscriber must still
   have access **and** the `com` claim, decided by the same `entitlementFor()`
   the account page uses;
6. if the ledger holds a stricter domain list than the signed one, the stricter
   list wins.

A verified render is counted, sampled 1-in-10, so the write stays cheap.

### Every failure is the free widget

No referer, wrong host, missing fetch metadata, expired, revoked, rotated past
its overlap, owner lapsed, malformed `wl`, ledger down, rate limited — **each of
those renders the ordinary attributed widget**. A clinic's visitor never sees an
error page because of a billing state they know nothing about, and a 429 never
puts an error where a breathing timer should be. The only thing that can fail
outright is reading the template from disk, and that falls back to the static
copy of the same document.

The attribution is in the markup from the start and removed by script only on a
`whitelabel: true` verdict, so a JavaScript failure can never silently drop it.

### What the document may say about why

The full reason stays on the server and in the `/account` listing. The document
goes to a clinic's visitors, so "lapsed" or "revoked" in its source would tell
any of them about the clinic's billing with us. The inlined `reason` keeps only
what helps a subscriber debug their own snippet and folds every ledger verdict
into one word:

`ok`, `no_credential`, `malformed`, `invalid`, `expired`, `not_embedded`,
`no_referer`, `domain`, `unavailable`, `denied`.

### The attribution link never changes

```html
<a href="https://helpmebreath.com/?utm_source=embed" target="_blank" rel="nofollow noopener">Powered by Help Me Breathe</a>
```

`rel="nofollow noopener"` is not configurable. There is no parameter, tier or
price that makes it a followed link (AGENT_BRIEF hard rule 7). Google's
[spam policies](https://developers.google.com/search/docs/essentials/spam-policies)
list low-quality or keyword-rich links embedded in widgets distributed across
sites as link spam, so a followed link here would be a liability for us and for
every site that installed the widget.

### The client session link asks a different question

`/s/` is served from helpmebreath.com, so there is no embedding host and the
`dom` claim does not apply — it restricts where a subscriber may white-label an
*embed*. The only question there is whether the credential is genuine and still
live, so `/s/` is the **one** caller of `POST /api/entitlement`:

```json
{ "token": "<the wl value>" }
```
```json
{ "ok": true, "typ": "emb", "tier": "pro", "whitelabel": true, "gid": "et_…", "exp": 1789000000 }
```

There is no `host` parameter, and a `host` in the body is ignored. A well-formed
request always gets **HTTP 200** with the verdict in `ok`; only a missing or
malformed body (400) or a flood (429) gets a non-200, so the page has one code
path: `ok && whitelabel` removes the attribution, anything else leaves the free,
attributed page exactly as it was. The verdict is cached in `sessionStorage`
under `hmb.wls.<last 24 chars of the credential>`.

Both checks fail closed in exactly the same way.

### The two snippets

`/api/embed/token` hands back both, ready to paste, with the credential already
in place:

```html
<script src="https://helpmebreath.com/embed/v1/breathe.js" data-wl="…"></script>
```

```html
<iframe src="https://helpmebreath.com/api/embed/frame?wl=…"
        title="Guided breathing exercise"
        referrerpolicy="strict-origin-when-cross-origin"
        loading="lazy" allow="screen-wake-lock"
        style="display:block;width:100%;max-width:100%;height:560px;border:0;background:transparent"></iframe>
```

The loader form is what `/embed` recommends — it resizes itself. The iframe form
is for hosts that strip script tags, and it pins `referrerpolicy` so a host page
with `no-referrer` set site-wide still sends the origin the domain check needs.
The loader sets the same attribute on the iframe it creates, for the same reason.

---

## 5. The postMessage protocol

All messages go from the frame to `window.parent`. The frame targets the parent
origin taken from `document.referrer` when it has one, and `*` otherwise; the
payloads carry no private data.

| Message | When | Payload |
|---|---|---|
| `hmb:resize` | on load, on every layout change (`ResizeObserver` on the shell, coalesced to one `requestAnimationFrame`), and on each phase and session event | `{ type, height }` — CSS pixels, capped at 4000. In kiosk mode: `{ type, height: 0, mode: 'kiosk' }` |
| `hmb:session-start` | a session began | `{ type, technique, seconds, breaths, completed }` |
| `hmb:session-complete` | ran the full duration | same shape, `completed: true` |
| `hmb:session-stop` | stopped early | same shape, `completed: false` |

The loader listens for `hmb:resize` only, and applies it defensively:

- the message must come from the frame's own origin (derived from the loader's
  own `src`, so a preview deployment works);
- the message's `source` must be the `contentWindow` of one of the iframes the
  loader created, which is what makes several widgets on a page independent;
- `height` must parse as a number greater than zero; `0` and anything else is
  ignored, leaving the iframe at whatever size the host gave it;
- exactly one listener is registered per page, no matter how many snippets are
  on it.

A host page that wants the session events can listen itself:

```js
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://helpmebreath.com') return;
  if (event.data && event.data.type === 'hmb:session-complete') {
    // your own analytics, your own consent basis
  }
});
```

We deliberately do not send anything to the host that the host could not already
observe, and the widget itself records nothing.

---

## 6. The client session link — `/s/?c=…`

A subscriber sends a client one URL. All the configuration is in the URL, nothing
about the recipient is stored anywhere, and the recipient needs no account: `/s/`
carries `data-open-timer`, so the timer runs for them, forever.

`c` is `base64url(JSON)` of:

```json
{
  "t": "coherent",
  "d": 600,
  "n": "Dr Amina Haddad",
  "l": "https://example.com/logo.png",
  "c": "0ea5e9",
  "m": "Ten minutes, twice a day, before you eat.",
  "wl": "<embed credential or empty>"
}
```

| Field | Meaning | Validation |
|---|---|---|
| `t` | technique key | `[a-z0-9_-]{1,20}`, then `getTechnique()` |
| `d` | seconds | 30–7200, or `-1` |
| `n` | the sender's name | ≤ 60 chars, control characters stripped, whitespace collapsed |
| `l` | logo URL | `https:` only, ≤ 500 chars, shown only after verification |
| `c` | accent | six hex digits |
| `m` | note to the client | ≤ 280 chars, same cleaning as `n` |
| `wl` | embed credential | 8–4096 chars of `[A-Za-z0-9._~-]` |

The whole encoded string is capped at 2000 characters and must match
`[A-Za-z0-9_-]+=*` before it is even decoded. **Any failure — a missing `c`, a
payload that is not base64url, JSON that does not parse, or JSON that is not an
object — redirects to `/timer`.** A half-configured page is worse than a
generic one.

The page renders "Prepared for you by *n*", the note, the pattern preselected
and locked, and the same attribution rule as the widget. It is `noindex,
nofollow` and carries `data-no-ads="true" data-no-asks="true" data-open-timer`:
a link a client was told to use is not a place to sell anything, and it is not a
place to ask them for an account either.

The link builder on `/for-practitioners` produces these URLs; this page only
consumes them.

---

## 7. Security notes

**Everything in a URL is attacker-controlled.** These pages render
attacker-supplied strings on helpmebreath.com's own origin, which makes them the
highest-value XSS target in the repo. The rules:

- **No `innerHTML`, ever, for a value that came from a URL.** Text goes in with
  `textContent`; URLs go in with `setAttribute` after being parsed by `new URL()`
  and checked for `https:`. Both files hold to this — if you extend them, keep
  holding to it.
- Every field is length-capped **before** it is decoded and again after.
- Control characters (`< 0x20` and `0x7f`) are stripped from every free-text
  field rather than escaped, so nothing exotic reaches the DOM.
- `javascript:`, `data:` and `http:` logo URLs are rejected by the protocol
  check, not by a blocklist.

**The frame makes zero third-party requests** (hard rule 14 / FEAT-13). Inside
it there is one same-origin stylesheet and the shared engine modules. No web
font, no analytics, no advertising library, no consent script, no remote image —
and, since the white-label verdict is inlined at document time, no API call
either. `api/embed/frame.js` only rewrites one inline script in the document; it
adds no request of any kind. Two consequences to preserve:

- `frame.css` uses a system font stack and inlines every colour. Never add
  `@import` or a font CDN to it.
- `js/analytics.js` pulls in `js/consent.js`, which injects a cookie banner
  unless it finds a `#cookieConsent` element. The frame ships an empty one and
  `frame.css` keeps it hidden, so the host site's visitors never see our banner
  for a widget that sets no cookies. `track()` is a no-op in the frame anyway —
  there is no `gtag`.
- `/s/` does the same, for a different reason. A client session link carries no
  GA4 tag on purpose: its `?c=` payload holds the practitioner's name and their
  note to the client, and a page-view hit would send that whole query string to
  Google. `compliance/privacy-attestation.html` states that analytics never runs
  inside a client session link, so the banner — which announces analytics and
  advertising cookies — would be false there. Do not add `gtag` to `s/index.html`
  without rewriting that attestation first.

**Headers** (already in `vercel.json`, confirm before deploy):

```
/((?!embed/|s/|s$|api/embed/frame).*)   X-Frame-Options: DENY
/embed/(.*)                             Content-Security-Policy: frame-ancestors *
/embed/v1/(.*)                          Access-Control-Allow-Origin: *
/s, /s/(.*)                             Content-Security-Policy: frame-ancestors *
/api/embed/frame                        Content-Security-Policy: frame-ancestors *
/api/(.*)                               Cache-Control: no-store; X-Robots-Tag: noindex
```

The permissive framing is scoped to `/embed/*`, `/s/*` and the one API path that
serves a document; the rest of the site stays frame-denied. `api/embed/frame.js`
sets the same CSP on its own response as well, and `frame-ancestors *` makes
browsers ignore any `X-Frame-Options` a wider rule adds.

**The credential in a URL is not a secret.** It is visible in the host page's
HTML and it can be copied. That is acceptable because the signed `dom` claim
binds it to the subscriber's own domains, because the document-time check refuses
anything that is not a cross-site iframe load from one of them, and because the
worst outcome of a copied credential is a missing attribution line, not access to
anyone's data. A credential that does leak is rotated or revoked from `/account`
in one click; rotation keeps the old one alive for 48 hours, revocation kills it
at once.

`/api/embed/frame` is rate limited to 120/min per IP and answers `Cache-Control:
private, no-store` — the verdict is per request and must never be cached.

**Attribution cannot be removed client-side by editing the page**, in any way
that matters — the file a visitor loads is ours, and a host site that patches
its own copy of the DOM is breaching the terms of use, not defeating a security
control. This is a licensing boundary, not a technical one, and it is
deliberately not worth engineering further.

---

## 8. Versioning policy

**`/embed/v1/*` is frozen.** Snippets are pasted into other people's websites
and are never updated. Anything that could change the layout, behaviour or
parameter meaning of an existing embed is a new version:

- Bug fixes, accessibility fixes, security fixes and new techniques (which
  arrive automatically through `js/techniques.js`) ship into v1.
- New optional parameters may be added to v1 **only** if omitting them leaves
  behaviour byte-for-byte identical.
- Anything else — renaming or repurposing a parameter, changing a default,
  restructuring the layout, changing the postMessage shape — ships as
  `embed/v2/` alongside v1. v1 keeps working indefinitely.
- Never delete a version directory. If a version must be retired, make it render
  a static line pointing at `/embed`, and only after the owner has checked
  referrer logs.

The shared engine in `js/` is the one coupling to watch: v1's frame imports
`/js/app.js` and `/js/techniques.js` from the live site, so an engine change
reaches every existing embed. That is intentional — it is how a fixed timing bug
or a new pattern reaches installed widgets — but it means **changes to the
engine's `data-role` contract or its `?t=` / `?d=` precedence are breaking
changes for the widget**, and `docs/MODULE_API.md` is the contract that protects
it.

`api/embed/frame.js` serves the **same** `embed/v1/frame.html`, so the freeze
covers both paths. Changing the template changes what every white-label embed
renders too; changing `FRAME_PATH` breaks every snippet already pasted into a
site and would itself be a v2.

---

## 9. Verifying a change

From the repo root:

```bash
node --check embed/v1/breathe.js
node --check api/embed/frame.js api/embed/token.js
node --test tools/embed.test.mjs     # the verdict, the domain check, the ledger
node tools/site-check.mjs            # no ERROR may mention an embed file
grep -nEi "https?://" embed/v1/frame.html embed/v1/frame.css
```

That last grep must return only two `href`s to helpmebreath.com (the attribution
link and the medical-disclaimer link — both user-initiated navigations, neither a
subresource), the SVG namespace inside the favicon data URI, and comments.
Anything else is a third-party request and a hard-rule violation. Check the byte
size of the loader too: it is budgeted at under 3 KB uncompressed.

Then load, by hand:

- `/embed` — the configurator, the live preview and the copied snippet.
- `/embed/v1/frame?technique=wim&duration=180` — the safety acknowledgement.
- `/embed/v1/frame?mode=kiosk&technique=box` — autostart, loop, no controls.
- `/api/embed/frame?wl=<a credential minted on /account>` opened **directly** —
  it must render the free, attributed widget, because a top-level open is not a
  cross-site iframe load. Then the same credential inside an iframe on a page
  served from one of its domains — that one must white-label.
- `/s/?c=<a payload you encoded yourself>` and `/s/?c=nonsense` — the second
  must land on `/timer`.
- Any of the above with `prefers-reduced-motion: reduce` — the circle must hold
  one size (scale 0.86) while a ring drawn around its circumference by
  `stroke-dashoffset` carries the pace; the per-second count still ticks and the
  notch still opens and closes instantly.
