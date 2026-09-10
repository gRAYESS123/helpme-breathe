# The embeddable widget and the client session link

Everything a third-party site loads from us, plus the co-branded link a
practitioner sends to a client. Three files serve the widget and one serves the
link:

| File | URL | What it is |
|---|---|---|
| `embed/v1/breathe.js` | `/embed/v1/breathe.js` | The loader. A classic script the host page includes; it replaces itself with an iframe. ~3 KB, ~1.4 KB gzipped. |
| `embed/v1/frame.html` | `/embed/v1/frame` | The widget itself. A standalone page running the shared engine. |
| `embed/v1/frame.css` | `/embed/v1/frame.css` | The widget's only stylesheet. |
| `s/index.html` | `/s/?c=…` | The client session link. First-party, not an embed. |

The marketing and configurator page is `/embed` (`embed.html`).

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
preference and calls `/api/entitlement` for the white-label check, and both are
same-origin operations. `allow-popups-to-escape-sandbox` is there for one link:
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
| `accent` | six hex digits, `#` optional | the pattern's own colour | Replaces `--theme-primary`, `--theme-glow` and `--progress-color`. |
| `logo` | an `https:` URL, ≤ 500 chars | none | **Rendered only after white-label verification.** The one cross-origin request the frame can make, and only for a verified licence. |
| `brand` | plain text, ≤ 40 chars | none | Free tier. Written with `textContent`; control characters are stripped. Does not remove attribution. |
| `sound` | `0` \| `1` | the engine's default (on) | A *first-visit* default. If the visitor has already used the sound toggle in this embed, their choice stands. |
| `mode` | `normal` \| `kiosk` \| `class` | `normal` | See §3. |
| `wl` | a licence token, 8–4096 chars of `[A-Za-z0-9._~-]` | none | See §4. |

Anything shorter than the `wl` minimum, or outside that character set, is
treated as absent — which means the free, attributed widget.

---

## 3. Modes and the surround theme

**`theme` controls the surround only.** The card that holds the timer always
keeps the pattern's own dark gradient, because those seven gradients are where
the site's contrast ratios were measured (see the contrast notes in
`css/styles.css`). `theme=light` paints the *page around the card* pale;
`theme=dark` paints it with the same gradient; `theme=auto` follows the
visitor's `prefers-color-scheme`. No text/background pair inside the card
changes between the three.

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

**`mode=class`** — Practitioner tier. Oversized phase text for a projector,
plus a full-width **Start class** button that also resumes. It renders
immediately when a `wl` token is present and **downgrades to `normal` if
verification fails**, rather than making every legitimate class start in the
wrong layout.

Class mode never speaks. Phase names reach the room visually and reach a screen
reader through `[data-role="live-region"]`; the frame calls no speech API. A
timer that talks over a teacher is worse than one that does not.

---

## 4. White-label verification

The **only** thing that removes the attribution footer.

### The flow

1. The frame renders with attribution in the markup — not added by script, so a
   JavaScript failure cannot silently drop it.
2. If `wl` is present and well-formed, the frame `POST`s to `/api/entitlement`:

   ```json
   { "token": "<the wl value>", "host": "<the host page's hostname>" }
   ```

   `host` comes from `document.referrer`. With
   `Referrer-Policy: strict-origin-when-cross-origin` that is the host page's
   origin, which is all we need. It is sent for the server's benefit; the frame
   also checks the domain claim itself.
3. The response is the token's payload — either at the top level or under
   `payload`. `api/entitlement.js` (API agent) answers the top-level shape, and
   answers **HTTP 200 with `ok: false`** for a bad, expired or unverifiable
   token rather than a 4xx, so `ok` is the field that decides, not the status
   code alone. The frame also sends `host` (the referrer hostname); the endpoint
   currently ignores it and the frame checks the `dom` claim itself.

   ```json
   { "ok": true, "tier": "practitioner", "dom": ["willowyoga.com"] }
   ```

4. Attribution is removed, and `logo` and class mode are applied, **only** when
   all of these hold:
   - the response is 2xx and parses as JSON, and `ok` is not `false`;
   - `tier` is `practitioner` or `studio`;
   - `dom` is absent or empty, **or** it contains the referrer host. A claim
     matches the host itself and any subdomain of it, and a leading `*.` is
     stripped before comparison.
5. The verdict — positive **or** negative — is cached in `sessionStorage` under
   `hmb.wl.<last 24 chars of the token>` for the life of the tab, so a page with
   several widgets makes one request. `/s/` caches its own verdict under
   `hmb.wls.<last 24 chars>`: it is a different question (tier only, no domain
   claim) and a different value shape, so it gets a different key.

### Fail closed, always

Attribution stays when the API is unreachable, times out (4s), returns non-2xx,
returns unparseable JSON, returns `ok: false`, returns a `free` or `pro` tier,
or returns a `dom` claim that does not include this host. It also stays when
`dom` is set but the browser sent no referrer at all — an unknown host cannot
satisfy a domain restriction.

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

### `dom` on the client session link

`/s/` is served from helpmebreath.com, so there is no embedding host and the
`dom` claim does not apply — it restricts where a practitioner may white-label
an *embed*. The client link therefore checks the tier only. Both checks fail
closed in exactly the same way.

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

A practitioner sends a client one URL. All the configuration is in the URL,
there is no database, and nothing about the recipient is stored anywhere.

`c` is `base64url(JSON)` of:

```json
{
  "t": "coherent",
  "d": 600,
  "n": "Dr Amina Haddad",
  "l": "https://example.com/logo.png",
  "c": "0ea5e9",
  "m": "Ten minutes, twice a day, before you eat.",
  "wl": "<licence token or empty>"
}
```

| Field | Meaning | Validation |
|---|---|---|
| `t` | technique key | `[a-z0-9_-]{1,20}`, then `getTechnique()` |
| `d` | seconds | 30–7200, or `-1` |
| `n` | practitioner name | ≤ 60 chars, control characters stripped, whitespace collapsed |
| `l` | logo URL | `https:` only, ≤ 500 chars, shown only after verification |
| `c` | accent | six hex digits |
| `m` | note to the client | ≤ 280 chars, same cleaning as `n` |
| `wl` | licence token | 8–4096 chars of `[A-Za-z0-9._~-]` |

The whole encoded string is capped at 2000 characters and must match
`[A-Za-z0-9_-]+=*` before it is even decoded. **Any failure — a missing `c`, a
payload that is not base64url, JSON that does not parse, or JSON that is not an
object — redirects to `/timer`.** A half-configured page is worse than a
generic one.

The page renders "Prepared for you by *n*", the note, the pattern preselected
and locked, and the same attribution rule as the widget. It is `noindex,
nofollow` and carries `data-no-ads="true" data-no-asks="true"`: a link a client
was told to use is not a place to sell anything.

The Practitioner agent's link builder produces these URLs; this page only
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
font, no analytics, no advertising library, no consent script, no remote image.
Two consequences to preserve:

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
/(?!embed/|s/|s$).*   X-Frame-Options: DENY
/embed/(.*)           Content-Security-Policy: frame-ancestors *
/s, /s/(.*)           Content-Security-Policy: frame-ancestors *
/embed/v1/(.*)        Access-Control-Allow-Origin: *
```

The permissive framing is scoped to `/embed/*` and `/s/*`; the rest of the site
stays frame-denied.

**The licence token in a URL is not a secret.** It identifies a licence, it is
visible in the host page's HTML, and it can be copied. That is acceptable
because the `dom` claim binds it to the practitioner's own domains and because
the worst outcome of a copied token is a missing attribution line, not access to
anyone's data. `/api/entitlement` should still rate-limit per IP.

**Attribution cannot be removed client-side by editing the page**, in any way
that matters — the file a visitor loads is ours, and a host site that patches
its own copy of the DOM is breaching the licence terms, not defeating a security
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

---

## 9. Verifying a change

From the repo root:

```bash
node --check embed/v1/breathe.js
node tools/site-check.mjs            # no ERROR may mention an embed file
grep -nEi "https?://" embed/v1/frame.html embed/v1/frame.css
```

That last grep must return only the attribution link, the SVG namespace in the
favicon data URI and comments — anything else is a third-party request and a
hard-rule violation. Check the byte size of the loader too: it is budgeted at
under 3 KB uncompressed.

Then load, by hand:

- `/embed` — the configurator, the live preview and the copied snippet.
- `/embed/v1/frame?technique=wim&duration=180` — the safety acknowledgement.
- `/embed/v1/frame?mode=kiosk&technique=box` — autostart, loop, no controls.
- `/s/?c=<a payload you encoded yourself>` and `/s/?c=nonsense` — the second
  must land on `/timer`.
- Any of the above with `prefers-reduced-motion: reduce` — the circle must stop
  scaling and change brightness instead.
