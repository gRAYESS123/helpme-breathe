# tools/render — the content pipeline

Records short breathing clips and Pinterest stills from `/render.html` with a
headless Chromium. Everything runs on your machine, nothing is uploaded, and
the marginal cost of one more post is a few seconds of CPU.

This folder has its **own** `package.json` on purpose. The site itself stays
dependency-free; Playwright lives here and only here.

One thing to know about deployment: the repo has no `.vercelignore`, so a static
Vercel deploy currently serves everything committed, `tools/` included — nothing
secret, but `https://helpmebreath.com/tools/render/batch.json` would be readable.
`node_modules/` and `out/` are not committed, so nothing large is uploaded. If you
want `tools/` off the deployment entirely, add a `.vercelignore` at the repo root
containing `tools/` and `docs/` (filed as an integration request; that file is not
owned by this tool).

---

## 1. Install (once)

```bash
cd tools/render
npm install
```

If Playwright says the browser is missing (it names the exact path it looked at):

```bash
npx playwright install chromium
```

That downloads ~300 MB into `%LOCALAPPDATA%\ms-playwright` on Windows — outside
the repo, shared by every project. It is only needed when Playwright is upgraded
to a version that wants a newer Chromium build.

### ffmpeg (optional, but you want it)

Clips come out of Chromium as VP8 `.webm`. Pinterest, TikTok, Instagram and
YouTube Shorts all prefer H.264 MP4 with a real audio track, so the tool muxes
to MP4 **when it can find a capable ffmpeg**. It looks in this order:

1. `ffmpeg` on `PATH`
2. `<playwright browsers dir>/ffmpeg-*/ffmpeg*`

Playwright ships its own ffmpeg, but that build only *encodes VP8* — no MP4
muxer, no H.264, no audio codecs. The tool detects that, says so, and keeps the
`.webm`. To get MP4s, install a full build:

```powershell
winget install Gyan.FFmpeg      # Windows
brew install ffmpeg             # macOS
sudo apt install ffmpeg         # Debian/Ubuntu
```

Open a new terminal afterwards so `PATH` picks it up.

### Ambient bed

`batch.json` → `defaults.audio` points at `audio/drone.m4a`, one of the six CC0
beds we generated ourselves (`drone`, `rain`, `ocean`, `night`, `forest`,
`brown-noise` — see `docs/AUDIO.md`). They are 60-second seamless loops, so
ffmpeg loops them to the clip length. Swap the bed per job with an `"audio"`
field, or change the default for the whole batch.

The path is resolved from the repo root. If the file is missing, clips get a
**silent** stereo track instead — still better than no audio stream at all,
because the platforms treat a video with no audio track as broken.

Never drop a track you do not hold the rights to into a clip you publish.

---

## 2. Run

```bash
cd tools/render

node render-short.mjs --list                    # the whole batch with indexes
node render-short.mjs --job 0 --out ./out       # one job
node render-short.mjs --job all --out ./out     # all 100
```

Useful flags:

| Flag | What it does |
|---|---|
| `--job <index\|slug\|all>` | which job to render (indexes are 0-based, from `--list`) |
| `--out <dir>` | where the files go (default `./out`) |
| `--kind video` / `--kind pin` | with `--job all`, restrict to one kind |
| `--only <substring>` | with `--job all`, only slugs containing this |
| `--seconds <n>` | override `job.seconds` — good for a quick smoke test |
| `--limit <n>` | stop after n jobs |
| `--headed` | watch the browser work |
| `--keep-webm` | keep the raw `.webm` after a successful mux |
| `--dry-run` | print the plan and render nothing |

A full `--job all` run takes roughly 15–20 minutes: the video jobs are real time
(12–25 s each) and the pins are a couple of seconds apiece.

### Editing `batch.json`

Each job is one object. The fields that matter:

| Field | Meaning |
|---|---|
| `kind` | `video` or `pin` |
| `slug` | filename stem — keep it unique |
| `technique` | a key from `js/techniques.js`: `478`, `box`, `coherent`, `sigh`, `extended`, `triangle`, `wim` |
| `size` | `story` (1080×1920), `pin` (1000×1500) or `square` (1080×1080) |
| `seconds` | clip length, 12–25 for video; ignored for pins |
| `caption` | the big headline — **80 characters max**, trimmed if longer |
| `sub` | the small line under the circle |
| `theme` | optional palette override, otherwise the technique's own |
| `url` | the page the post links to (a clean URL, no `.html`) |
| `pinDescription` | ready-to-paste Pinterest text, under 500 chars, link included |
| `phrase` | set to `false` to hide the engine's own phase sentence ("Breathe in slowly…") and leave only your `sub` |
| `poseMs` | pins only — how long to wait before the still, so the circle is caught mid-inhale (default 2600) |

`defaults` at the top of the file applies to every job unless the job overrides it.

---

## 3. What comes out

Everything lands in `tools/render/out/`, named `<slug>-<size>`:

| File | What it is |
|---|---|
| `<slug>-story.mp4` | 1080×1920 clip for TikTok / Reels / Shorts (`.webm` if there is no capable ffmpeg) |
| `<slug>-square.mp4` | 1080×1080 clip for a feed post |
| `<slug>-story.png` | poster frame, taken one second into the clip |
| `<slug>-pin.png` | 1000×1500 Pinterest still |

`out/` is scratch space — regenerate it, do not commit it. The one exception is
`out/sample.png`, a small reference frame kept in the repo so you can see what
the surface looks like without running anything.

That needs these two lines in the repo-root `.gitignore` (in this order — git
will not descend into a directory excluded with a trailing slash, so
`tools/render/out/` followed by a negation would silently keep `sample.png` out
too):

```gitignore
tools/render/out/*
!tools/render/out/sample.png
```

Pinterest descriptions live in `batch.json` (`pinDescription`), already under
500 characters and already carrying the page link. Copy them straight across.

The evergreen 1000×1500 pins for the technique and use-case pages are a separate
thing: they come from `tools/generate-images.py` and live in `images/pins/`,
because those ship with the site.

---

## 4. The weekly ritual (about 30 minutes)

1. **Render.** `node render-short.mjs --job all --out ./out` — or a slice, e.g.
   `--kind video --limit 8`, if you only need this week's batch.
2. **Look at every file before it goes out.** Captions are trimmed to 80
   characters, so a long one can end mid-word. Check the poster frames first;
   they are quick to scan and they catch layout problems.
3. **Pinterest — 5 to 10 pins.** Upload `<slug>-pin.png`, paste the matching
   `pinDescription`, set the destination link to the job's `url`. Spread them
   over the week rather than posting all ten at once.
4. **TikTok / Reels / Shorts — 2 to 3 clips.** Upload the story MP4. Caption =
   the job's `caption`; first comment = the page link. Do not put the link in the
   video itself.
5. **Log it.** Note which slugs went out where, so next week starts from a
   different part of the batch. A plain text file is enough.
6. **Refresh the batch every month or so.** Add captions that came out of real
   questions people asked, retire ones that went nowhere.

---

## 5. Upload checklist

Before anything goes public:

- [ ] The caption reads as a whole sentence — not cut off at 80 characters.
- [ ] Nothing on screen claims the timer treats, cures or replaces treatment for
      any condition. Describe the pattern, not an outcome.
- [ ] Energizing-breath posts carry the safety line (seated only, never in or
      near water) in the caption **and** the description.
- [ ] Panic and anxiety posts point at the crisis-safe pages and stay free of
      anything that reads as a sales pitch.
- [ ] The phrase "Wim Hof" appears nowhere — in the caption, the description,
      the hashtags or the filename.
- [ ] The destination link is a clean URL (`https://helpmebreath.com/box-breathing`),
      not a `.html` path.
- [ ] Pinterest: description under 500 characters, link set on the pin itself.
- [ ] TikTok / Shorts: no music you do not have the rights to. A silent track is
      fine; the platform's own library is fine; a random song is not.
- [ ] The clip actually loops cleanly — watch the last second before you post.

---

## 6. How it works, briefly

`render-short.mjs`:

1. Starts a tiny Node http server on a free port serving the repo root. No
   python, no dev server, and the ES modules get real MIME types.
2. Opens `/render.html?technique=…&size=…&caption=…` at the exact target
   viewport, with `context.recordVideo` set to the same size.
3. Waits for `body[data-render-running="true"]` — the engine sets that when the
   session actually starts — then holds for `job.seconds`.
4. Grabs the poster PNG one second in.
5. Closes the context (that is when Playwright flushes the `.webm`), then trims
   the page-load lead-in and muxes to MP4 if ffmpeg can.

`render.html` is a `noindex` capture surface. It reuses `css/styles.css` and the
real breathing engine in kiosk mode, hides every control, and makes exactly one
third-party request: Google Fonts, for Quicksand. Do not add analytics, ads or
anything else to it — whatever it loads ends up inside a video that gets
published.

---

## 7. Troubleshooting

**"Executable doesn't exist at …chrome-headless-shell.exe"**
Playwright was upgraded past the installed browser. `npx playwright install chromium`.

**"ffmpeg … cannot write MP4/H.264"**
That is Playwright's stripped ffmpeg. Install a full build (section 1) and open
a new terminal.

**The clip is blank or the circle never moves**
Open the same URL in a normal browser:
`node render-short.mjs --job 0 --headed`. If the page loads but never starts,
`js/app.js` failed — check the browser console.

**Fonts look wrong**
Quicksand comes from Google Fonts, so the render machine needs network access.
Without it the page falls back to a system sans-serif and the captures look off.
The tool checks: `render.html` records what actually painted in
`data-render-font`, and every job whose capture came out in a fallback face
prints a warning. If you see that warning, throw the batch away and render it
again on a connected machine — the difference is subtle enough to miss by eye.

**Does opening /render change anything in my browser?**
No. It confirms the energizing breath's safety acknowledgement on your behalf
(there is nobody at a capture surface to tap it), then removes the
`hmb.ack.*` key again unless it was already there before the page loaded. The
published `/energizing-breath` page still asks a real visitor every time.

**A caption is cut off**
`render.html` trims captions to 80 characters. Shorten it in `batch.json`.
