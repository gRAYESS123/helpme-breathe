#!/usr/bin/env node
/**
 * tools/render/render-short.mjs — the zero-marginal-cost content pipeline.
 *
 * Points a headless Chromium at /render.html, records a short breathing clip
 * (or grabs a Pinterest still), and writes the files a weekly posting session
 * needs. Nothing is uploaded from here; the outputs go to disk and a human
 * posts them.
 *
 *   cd tools/render
 *   npm install
 *   node render-short.mjs --list
 *   node render-short.mjs --job 0 --out ./out
 *   node render-short.mjs --job all --out ./out
 *
 * Options
 *   --job <index|slug|all>   which batch.json job to render (0-based index)
 *   --out <dir>              output directory (default ./out, relative to cwd)
 *   --batch <file>           batch file (default ./batch.json)
 *   --kind <video|pin>       with --job all, render only this kind
 *   --only <substring>       with --job all, only jobs whose slug contains this
 *   --seconds <n>            override job.seconds (handy for a smoke test)
 *   --limit <n>              stop after n jobs
 *   --headed                 show the browser (debugging)
 *   --keep-webm              keep the raw .webm even after a successful mux
 *   --list                   print the batch and exit
 *   --dry-run                print what would be rendered and exit
 *
 * How it works
 *   1. A tiny built-in http server serves the repo root on a free port. No
 *      python, no dev dependency, and /render.html gets real MIME types so the
 *      ES modules load.
 *   2. Playwright opens render.html at the exact target viewport with the
 *      job's parameters, waits for body[data-render-running="true"], then holds
 *      for job.seconds while context.recordVideo captures the page.
 *   3. A poster PNG is taken one second into the run.
 *   4. If a *capable* ffmpeg is on the machine, the clip is trimmed to the
 *      breathing itself and muxed to H.264 MP4 with the ambient bed (or a
 *      silent track, because TikTok and Shorts both prefer a real audio
 *      stream). Otherwise the .webm is kept and the reason is printed.
 *
 * ffmpeg is looked for in this order:
 *   1. `ffmpeg` on PATH
 *   2. <playwright browsers dir>/ffmpeg-* /ffmpeg*(.exe)
 * Playwright's own bundled build is encode-VP8-only — no MP4 muxer, no H.264,
 * no audio codecs — so it is detected, reported, and skipped. Install a full
 * ffmpeg (winget install Gyan.FFmpeg) to get MP4s.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** Capture sizes. `size` in batch.json must be one of these keys. */
const SIZES = {
  story: { width: 1080, height: 1920 },
  pin: { width: 1000, height: 1500 },
  square: { width: 1080, height: 1080 },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

/* ========================================================================== *
 * CLI
 * ========================================================================== */

function parseArgs(argv) {
  const opts = {
    job: null,
    out: null,
    batch: path.join(HERE, 'batch.json'),
    kind: null,
    only: null,
    seconds: null,
    limit: null,
    headed: false,
    keepWebm: false,
    list: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq !== -1 ? a.slice(0, eq) : a;
    const inlineValue = a.startsWith('--') && eq !== -1 ? a.slice(eq + 1) : null;
    const next = () => (inlineValue !== null ? inlineValue : argv[++i]);

    switch (flag) {
      case '--job': opts.job = next(); break;
      case '--out': opts.out = next(); break;
      case '--batch': opts.batch = path.resolve(process.cwd(), next()); break;
      case '--kind': opts.kind = String(next() || '').toLowerCase(); break;
      case '--only': opts.only = String(next() || '').toLowerCase(); break;
      case '--seconds': opts.seconds = Number(next()); break;
      case '--limit': opts.limit = Number(next()); break;
      case '--headed': opts.headed = true; break;
      case '--keep-webm': opts.keepWebm = true; break;
      case '--list': opts.list = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--help':
      case '-h': opts.help = true; break;
      default:
        console.error(`render-short: unknown argument "${a}"`);
        process.exit(2);
    }
  }
  return opts;
}

const USAGE = `render-short — record breathing clips and pin stills from /render.html

Usage:
  node render-short.mjs --job <index|slug|all> --out ./out

Options:
  --job <index|slug|all>  job to render (0-based index; see --list)
  --out <dir>             output directory (default ./out)
  --batch <file>          batch file (default ./batch.json)
  --kind <video|pin>      with --job all, restrict to one kind
  --only <substring>      with --job all, restrict to matching slugs
  --seconds <n>           override job.seconds
  --limit <n>             stop after n jobs
  --headed                show the browser
  --keep-webm             keep the raw .webm after a successful mux
  --list                  print the batch and exit
  --dry-run               print the plan and exit
  -h, --help              this help
`;

/* ========================================================================== *
 * Static file server (repo root, free port, no dependencies)
 * ========================================================================== */

function startServer(root) {
  const server = http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }

    // Resolve inside the root, always. A "../" in the URL must not escape it.
    const unsafe = path.join(root, pathname);
    const resolved = path.resolve(unsafe);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let file = resolved;
    try {
      const stat = await fsp.stat(file).catch(() => null);
      if (stat && stat.isDirectory()) file = path.join(file, 'index.html');
      else if (!stat && !path.extname(file)) file = `${file}.html`;  // Vercel cleanUrls
      const body = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

/* ========================================================================== *
 * ffmpeg discovery and capabilities
 * ========================================================================== */

function playwrightBrowserDirs() {
  const dirs = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') {
    dirs.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  }
  const home = os.homedir();
  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright'));
  } else if (process.platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Caches', 'ms-playwright'));
  } else {
    dirs.push(path.join(home, '.cache', 'ms-playwright'));
  }
  return dirs;
}

/** `ffmpeg` on PATH first, then the ffmpeg-* folder Playwright installs. */
function findFfmpeg() {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const probe = spawnSync(finder, ['ffmpeg'], { encoding: 'utf8', shell: false });
  if (probe.status === 0 && probe.stdout) {
    const first = probe.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return { bin: first, source: 'PATH' };
  }

  for (const dir of playwrightBrowserDirs()) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('ffmpeg-')) continue;
      const inner = path.join(dir, entry.name);
      let files;
      try {
        files = fs.readdirSync(inner);
      } catch {
        continue;
      }
      const match = files.find((f) => /^ffmpeg([-_].+)?(\.exe)?$/i.test(f));
      if (match) return { bin: path.join(inner, match), source: 'playwright' };
    }
  }
  return null;
}

function ffmpegCapabilities(bin) {
  const read = (args) => {
    const r = spawnSync(bin, args, { encoding: 'utf8' });
    return `${r.stdout || ''}${r.stderr || ''}`;
  };
  const encoders = read(['-hide_banner', '-encoders']);
  const muxers = read(['-hide_banner', '-muxers']);
  return {
    h264: /\blibx264\b/.test(encoders) || /\bh264_/.test(encoders),
    aac: /\s(aac|libfdk_aac)\s/.test(encoders),
    mp4: /\s(mp4)\s/.test(muxers),
    anullsrc: /\banullsrc\b/.test(read(['-hide_banner', '-filters'])),
  };
}

function run(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => resolve({ ok: false, stderr: String(err && err.message) }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stderr }));
  });
}

/* ========================================================================== *
 * Batch file
 * ========================================================================== */

function loadBatch(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    console.error(`render-short: batch file not found: ${file}`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`render-short: ${file} is not valid JSON — ${err.message}`);
    process.exit(2);
  }
  const defaults = (parsed && parsed.defaults) || {};
  const jobs = Array.isArray(parsed) ? parsed : (parsed && parsed.jobs) || [];
  if (!jobs.length) {
    console.error(`render-short: ${file} contains no jobs`);
    process.exit(2);
  }
  return jobs.map((job, index) => normalizeJob({ ...defaults, ...job }, index, file));
}

function normalizeJob(job, index, file) {
  const kind = (job.kind || (job.size === 'pin' ? 'pin' : 'video')).toLowerCase();
  const size = (job.size || (kind === 'pin' ? 'pin' : 'story')).toLowerCase();
  if (!SIZES[size]) {
    console.error(`render-short: ${file} job ${index} has unknown size "${size}" `
      + `(use ${Object.keys(SIZES).join(', ')})`);
    process.exit(2);
  }
  if (!job.slug) {
    console.error(`render-short: ${file} job ${index} has no slug`);
    process.exit(2);
  }
  const seconds = kind === 'pin' ? 0 : Math.max(3, Number(job.seconds) || 15);
  return {
    index,
    kind,
    size,
    slug: String(job.slug),
    technique: job.technique || '478',
    theme: job.theme || null,
    caption: String(job.caption || '').slice(0, 80),
    sub: String(job.sub || ''),
    seconds,
    loop: job.loop !== false,
    // `"phrase": false` hides the engine's phase sentence under the circle.
    phrase: job.phrase !== false,
    poseMs: Number.isFinite(Number(job.poseMs)) ? Number(job.poseMs) : 2600,
    audio: job.audio || null,
    url: job.url || 'https://helpmebreath.com/',
    pinDescription: job.pinDescription || '',
  };
}

/* ========================================================================== *
 * Rendering
 * ========================================================================== */

function jobUrl(job, port) {
  const params = new URLSearchParams();
  params.set('technique', job.technique);
  params.set('size', job.size);
  if (job.caption) params.set('caption', job.caption);
  if (job.sub) params.set('sub', job.sub);
  if (job.theme) params.set('theme', job.theme);
  if (job.phrase === false) params.set('phrase', '0');
  params.set('autostart', '1');
  if (job.loop) params.set('loop', '1');
  params.set('d', '-1');
  return `http://127.0.0.1:${port}/render.html?${params.toString()}`;
}

/**
 * render.html reports what typeface actually painted in data-render-font.
 * Quicksand comes from Google Fonts, so a render machine with no network
 * produces a whole batch in a system sans-serif that looks almost, but not
 * quite, right. Say so rather than letting it pass.
 */
async function fontWarning(page) {
  const state = await page.getAttribute('body', 'data-render-font').catch(() => null);
  if (!state || state === 'quicksand') return null;
  if (state === 'fallback') {
    return 'Quicksand did not load (Google Fonts unreachable?) — this capture is in a '
      + 'fallback system font. Check the network and render it again.';
  }
  return `could not confirm the font loaded (data-render-font="${state}") — check the capture before posting`;
}

async function renderPin(browser, job, port, outDir) {
  const size = SIZES[job.size];
  const context = await browser.newContext({
    viewport: size,
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  const written = [];
  const warnings = [];
  try {
    await page.goto(jobUrl(job, port), { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('body[data-render-running="true"]', { timeout: 30000 });
    const font = await fontWarning(page);
    if (font) warnings.push(font);
    // Hold until the circle is near the top of an inhale — a full circle reads
    // better in a feed than a deflated one.
    await page.waitForTimeout(job.poseMs);
    const file = path.join(outDir, `${job.slug}-${job.size}.png`);
    await page.screenshot({ path: file, type: 'png' });
    written.push(file);
  } finally {
    await context.close();
  }
  return { written, warnings };
}

async function renderVideo(browser, job, port, outDir, ffmpeg, opts) {
  const size = SIZES[job.size];
  const rawDir = path.join(outDir, '.raw');
  await fsp.mkdir(rawDir, { recursive: true });

  const context = await browser.newContext({
    viewport: size,
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
    recordVideo: { dir: rawDir, size },
  });

  const page = await context.newPage();
  const startedAt = Date.now();
  const written = [];
  const warnings = [];
  let leadMs = 0;

  const posterFile = path.join(outDir, `${job.slug}-${job.size}.png`);
  try {
    await page.goto(jobUrl(job, port), { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('body[data-render-running="true"]', { timeout: 30000 });
    leadMs = Date.now() - startedAt;

    const font = await fontWarning(page);
    if (font) warnings.push(font);

    await page.waitForTimeout(1000);
    await page.screenshot({ path: posterFile, type: 'png' });
    written.push(posterFile);

    const remaining = job.seconds * 1000 - 1000;
    if (remaining > 0) await page.waitForTimeout(remaining);
  } finally {
    const video = page.video();
    await context.close();          // the .webm is only flushed on close
    if (video) {
      try {
        const rawWebm = await video.path();
        const dest = path.join(outDir, `${job.slug}-${job.size}.webm`);
        await fsp.copyFile(rawWebm, dest);
        await fsp.rm(rawWebm, { force: true });

        const muxed = await mux(dest, job, leadMs, ffmpeg);
        warnings.push(...muxed.warnings);
        written.push(...muxed.written);
        if (!muxed.written.length || opts.keepWebm) written.push(dest);
        else await fsp.rm(dest, { force: true });
      } catch (err) {
        warnings.push(`could not save the recording — ${err && err.message ? err.message : err}`);
      }
    } else {
      warnings.push('no video was recorded (recordVideo returned nothing)');
    }
  }
  await fsp.rm(rawDir, { recursive: true, force: true }).catch(() => {});
  return { written, warnings };
}

/**
 * Trim the load-in and mux to MP4 with the ambient bed (or silence).
 * Returns `{ written: [], warnings: [...] }` when muxing is not possible —
 * the caller then keeps the .webm.
 */
async function mux(webmPath, job, leadMs, ffmpeg) {
  const warnings = [];
  if (!ffmpeg) {
    warnings.push('no ffmpeg found (PATH or the Playwright browsers folder) — keeping the .webm');
    return { written: [], warnings };
  }
  if (!ffmpeg.caps.mp4 || !ffmpeg.caps.h264) {
    warnings.push(
      `ffmpeg at ${ffmpeg.bin} cannot write MP4/H.264 `
      + `(mp4 muxer: ${ffmpeg.caps.mp4 ? 'yes' : 'no'}, libx264: ${ffmpeg.caps.h264 ? 'yes' : 'no'}) — `
      + 'keeping the .webm. Install a full build (Windows: winget install Gyan.FFmpeg) for MP4s.'
    );
    return { written: [], warnings };
  }

  const outPath = webmPath.replace(/\.webm$/i, '.mp4');
  const trim = Math.max(0, (leadMs - 250) / 1000);            // keep a short calm beat
  const audioPath = job.audio ? path.resolve(REPO_ROOT, job.audio) : null;
  const hasAudio = Boolean(audioPath && fs.existsSync(audioPath));
  if (job.audio && !hasAudio) {
    warnings.push(`ambient bed not found at ${audioPath} — writing a silent track instead`);
  }
  // The silent track is synthesised with the lavfi anullsrc source. A build
  // without it would fail on the -i, so fall back to a video-only MP4 rather
  // than producing nothing.
  const silent = !hasAudio;
  if (silent && !ffmpeg.caps.anullsrc) {
    warnings.push('this ffmpeg has no anullsrc filter — writing an MP4 with no audio track. '
      + 'TikTok and Shorts prefer a real audio stream, so add an "audio" path to the job '
      + 'or install a full ffmpeg build.');
  }
  const withAudio = hasAudio || ffmpeg.caps.anullsrc;

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (trim > 0) args.push('-ss', trim.toFixed(3));
  args.push('-i', webmPath);

  if (hasAudio) args.push('-stream_loop', '-1', '-i', audioPath);
  else if (withAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');

  args.push('-map', '0:v:0');
  if (withAudio) args.push('-map', '1:a:0', '-shortest');
  args.push(
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-crf', '20', '-preset', 'veryfast', '-r', '30'
  );
  if (withAudio) args.push('-c:a', ffmpeg.caps.aac ? 'aac' : 'libmp3lame', '-b:a', '128k');
  args.push('-movflags', '+faststart', outPath);

  const result = await run(ffmpeg.bin, args);
  if (!result.ok) {
    warnings.push(`ffmpeg failed — keeping the .webm. ${String(result.stderr).trim().split('\n').slice(-3).join(' ')}`);
    await fsp.rm(outPath, { force: true }).catch(() => {});
    return { written: [], warnings };
  }
  return { written: [outPath], warnings };
}

/* ========================================================================== *
 * Main
 * ========================================================================== */

function selectJobs(jobs, opts) {
  if (opts.job === null || opts.job === undefined) {
    console.error('render-short: --job is required (an index, a slug, or "all"). Try --list.');
    process.exit(2);
  }
  const wanted = String(opts.job).toLowerCase();
  let selected;
  if (wanted === 'all') {
    selected = jobs.slice();
  } else if (/^\d+$/.test(wanted)) {
    const index = Number(wanted);
    if (!jobs[index]) {
      console.error(`render-short: no job at index ${index} (batch has ${jobs.length}). Try --list.`);
      process.exit(2);
    }
    selected = [jobs[index]];
  } else {
    selected = jobs.filter((j) => j.slug.toLowerCase() === wanted);
    if (!selected.length) selected = jobs.filter((j) => j.slug.toLowerCase().includes(wanted));
    if (!selected.length) {
      console.error(`render-short: no job matching "${opts.job}". Try --list.`);
      process.exit(2);
    }
  }
  if (opts.kind) selected = selected.filter((j) => j.kind === opts.kind);
  if (opts.only) selected = selected.filter((j) => j.slug.toLowerCase().includes(opts.only));
  if (Number.isFinite(opts.limit) && opts.limit > 0) selected = selected.slice(0, opts.limit);
  if (Number.isFinite(opts.seconds) && opts.seconds > 0) {
    selected = selected.map((j) => ({ ...j, seconds: j.kind === 'pin' ? 0 : opts.seconds }));
  }
  return selected;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const jobs = loadBatch(opts.batch);

  if (opts.list) {
    for (const job of jobs) {
      const when = job.kind === 'pin' ? 'still' : `${job.seconds}s`;
      console.log(
        `${String(job.index).padStart(3)}  ${job.kind.padEnd(5)}  ${job.size.padEnd(6)}  `
        + `${when.padEnd(6)}  ${job.technique.padEnd(9)}  ${job.slug.padEnd(38)}  ${job.caption}`
      );
    }
    console.log(`\n${jobs.length} jobs `
      + `(${jobs.filter((j) => j.kind === 'video').length} video, `
      + `${jobs.filter((j) => j.kind === 'pin').length} pin)`);
    return 0;
  }

  const selected = selectJobs(jobs, opts);
  if (!selected.length) {
    console.error('render-short: nothing to render — --kind/--only/--limit filtered every job out. '
      + 'Try --list, or --dry-run to see the plan.');
    return 2;
  }
  const outDir = path.resolve(process.cwd(), opts.out || './out');

  if (opts.dryRun) {
    console.log(`would render ${selected.length} job(s) into ${outDir}:`);
    for (const job of selected) console.log(`  ${job.index}  ${job.kind}  ${job.slug}-${job.size}`);
    return 0;
  }

  if (!fs.existsSync(path.join(REPO_ROOT, 'render.html'))) {
    console.error(`render-short: render.html not found at ${REPO_ROOT}. `
      + 'Run this from inside the repo (tools/render).');
    return 2;
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    console.error('render-short: playwright is not installed.\n'
      + '  cd tools/render && npm install\n'
      + `  (import error: ${err && err.message})`);
    return 2;
  }

  await fsp.mkdir(outDir, { recursive: true });

  const found = findFfmpeg();
  const ffmpeg = found ? { ...found, caps: ffmpegCapabilities(found.bin) } : null;
  if (ffmpeg) {
    console.log(`ffmpeg: ${ffmpeg.bin} (${ffmpeg.source}) `
      + `mp4=${ffmpeg.caps.mp4} h264=${ffmpeg.caps.h264} aac=${ffmpeg.caps.aac}`);
  } else {
    console.log('ffmpeg: not found — clips will stay as .webm');
  }

  const { server, port } = await startServer(REPO_ROOT);
  console.log(`serving ${REPO_ROOT} on http://127.0.0.1:${port}`);

  const browser = await chromium.launch({
    headless: !opts.headed,
    args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none'],
  });

  const allWarnings = [];
  let done = 0;
  let failed = 0;

  try {
    for (const job of selected) {
      const label = `[${job.index}] ${job.slug}-${job.size} (${job.kind})`;
      process.stdout.write(`${label} … `);
      const startedAt = Date.now();
      try {
        const result = job.kind === 'pin'
          ? await renderPin(browser, job, port, outDir)
          : await renderVideo(browser, job, port, outDir, ffmpeg, opts);
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`ok in ${secs}s -> ${result.written.map((f) => path.basename(f)).join(', ')}`);
        for (const w of result.warnings) {
          console.log(`      warning: ${w}`);
          allWarnings.push(`${job.slug}: ${w}`);
        }
        done += 1;
      } catch (err) {
        failed += 1;
        console.log(`FAILED — ${err && err.message ? err.message : err}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  console.log(`\n${done} rendered, ${failed} failed. Output: ${outDir}`);
  if (allWarnings.length) {
    const unique = [...new Set(allWarnings.map((w) => w.replace(/^[^:]+: /, '')))];
    console.log('\nWarnings:');
    for (const w of unique) console.log(`  - ${w}`);
  }
  return failed ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
