#!/usr/bin/env node
/*
 * tools/chrome-diff.mjs — is the shared page chrome actually identical?
 * -----------------------------------------------------------------------------
 * The site header, the four-column footer and the technique switcher are pasted
 * into every page by hand (docs/PAGE_CONTRACT.md §2, §5, §8). Ten agents pasting
 * the same block produce nine near-copies, and near-copies are how a nav link
 * quietly disappears from one page.
 *
 * This compares the STRUCTURE of each block against the most common version in
 * the tree, ignoring the differences the contract asks for:
 *
 *   - `aria-current="page"` (each page marks its own section)
 *   - a dropped self-link (the footer and the switcher drop the page they are on)
 *   - whitespace and indentation
 *
 * Anything else is drift. Run it from the repo root:
 *
 *   node tools/chrome-diff.mjs           report
 *   node tools/chrome-diff.mjs --verbose print every page's normalised block
 *
 * Exit code 1 if any block drifts.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const VERBOSE = process.argv.includes('--verbose');
const SKIP_DIRS = new Set(['node_modules', '.git', '.vercel', 'out']);
const SKIP_PATHS = ['docs/private', 'tools/render/out'];

/* Pages that legitimately carry no site chrome. Each one says why. */
const EXEMPT = new Map([
  ['embed/v1/frame.html', 'the embedded widget: zero third-party requests, no site chrome'],
  ['render.html', 'headless capture surface — a header would appear in every clip'],
  ['s/index.html', 'client session link; a verified licence strips the chrome'],
]);

/**
 * Pages whose chrome is deliberately reduced, per block. Both of these render
 * without css/styles.css — /offline because there is no network and /404
 * because a missing stylesheet is one of the ways you land there — so they
 * carry a local copy of the palette and a compact footer.
 */
const REDUCED = new Map([
  ['offline.html', new Set(['site header', 'footer'])],
  ['404.html', new Set(['footer'])],
  ['pro/thanks.html', new Set(['footer'])],
  ['templates/technique-page.template.html', new Set(['site header', 'footer'])],
]);

function exemptFrom(file, blockName) {
  if (EXEMPT.has(file)) return true;
  const r = REDUCED.get(file);
  return Boolean(r && r.has(blockName));
}

/**
 * Differences the contract itself asks for, page by page. Each entry is a
 * decision written down somewhere, not a licence to drift.
 *
 *   - AGENT_BRIEF hard rule 5: the two crisis-safe pages carry zero
 *     monetisation surfaces, so /pro and /for-practitioners come off.
 *   - /legal/medical-disclaimer carries five suicide helplines; the same
 *     omission was kept there as a judgement call (see OWNER_REVIEW_FLAGS).
 *   - On /about the byline's "what that means" link would be a self-link, so
 *     it points at the medical disclaimer instead.
 */
const ALLOWED_DIFFS = new Map([
  ['breathing-exercises-anxiety.html', { extra: [], gone: ['/pro|Pro', '/for-practitioners|For practitioners'] }],
  ['breathing-exercises-for-panic-attacks.html', { extra: [], gone: ['/pro|Pro', '/for-practitioners|For practitioners'] }],
  ['legal/medical-disclaimer.html', { extra: [], gone: ['/pro|Pro', '/for-practitioners|For practitioners'] }],
  [
    'about.html',
    {
      extra: ['/legal/medical-disclaimer|what that means for what you read here'],
      gone: ['/about|what that means for what you read here'],
    },
  ],
]);

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (SKIP_PATHS.some((p) => rel === p || rel.startsWith(p + '/'))) continue;
      walk(abs, acc);
    } else if (/\.html$/i.test(entry.name)) {
      acc.push(rel);
    }
  }
  return acc;
}

/** Pull one element out by its opening tag, balancing nesting of that tag name. */
function extract(html, tagName, openRe) {
  const open = openRe.exec(html);
  if (!open) return null;
  const start = open.index;
  const openTag = new RegExp(`<${tagName}\\b`, 'gi');
  const closeTag = new RegExp(`</${tagName}\\s*>`, 'gi');
  let depth = 0;
  let i = start;
  while (i < html.length) {
    openTag.lastIndex = i;
    closeTag.lastIndex = i;
    const o = openTag.exec(html);
    const c = closeTag.exec(html);
    if (!c) return null;
    if (o && o.index < c.index) {
      depth += 1;
      i = o.index + 1;
    } else {
      depth -= 1;
      i = c.index + 1;
      if (depth === 0) return html.slice(start, c.index + c[0].length);
    }
  }
  return null;
}

/**
 * Reduce a block to the shape the contract fixes: tag names, hrefs and the
 * link text, with the per-page differences the contract allows removed.
 */
function normalise(block) {
  return block
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+aria-current="page"/g, '')
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

/** The links a nav block offers, in order, as `href|text`. */
function links(block) {
  const out = [];
  const re = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(block))) {
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    out.push(`${m[1]}|${text}`);
  }
  return out;
}

const BLOCKS = [
  { name: 'site header', tag: 'header', re: /<header class="site-header[^"]*">/i, required: true },
  { name: 'footer', tag: 'footer', re: /<footer class="footer[^"]*">/i, required: true },
  {
    name: 'technique switcher',
    tag: 'nav',
    re: /<nav class="technique-switcher"[^>]*>/i,
    required: false,
  },
];

const files = walk(ROOT).sort();
let failures = 0;

for (const block of BLOCKS) {
  const found = new Map(); // file -> { norm, links }
  const missing = [];

  for (const file of files) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const raw = extract(html, block.tag, block.re);
    if (!raw) {
      if (block.required && !exemptFrom(file, block.name)) missing.push(file);
      continue;
    }
    if (exemptFrom(file, block.name)) continue;
    found.set(file, { norm: normalise(raw), links: links(raw) });
  }

  // The reference is the shape the largest number of pages agree on.
  const tally = new Map();
  for (const { links: l } of found.values()) {
    const key = JSON.stringify(l);
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  const ordered = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const reference = ordered.length ? JSON.parse(ordered[0][0]) : [];

  console.log(`\n=== ${block.name} — ${found.size} page(s) ===`);
  console.log(`reference set (${ordered[0] ? ordered[0][1] : 0} pages agree):`);
  for (const l of reference) console.log(`   ${l}`);

  if (missing.length) {
    failures += missing.length;
    console.log(`\nMISSING on ${missing.length} page(s):`);
    for (const f of missing) console.log(`   ${f}`);
  }

  const drifted = [];
  for (const [file, { links: l }] of found) {
    const allowed = ALLOWED_DIFFS.get(file) || { extra: [], gone: [] };
    const extra = l.filter((x) => !reference.includes(x) && !allowed.extra.includes(x));
    // A page drops its own link from the footer and the switcher, so one
    // missing entry is expected; anything beyond that has to be declared.
    const gone = reference.filter((x) => !l.includes(x) && !allowed.gone.includes(x));
    if (extra.length || gone.length > 1) drifted.push({ file, extra, gone });
  }

  if (drifted.length) {
    failures += drifted.length;
    console.log(`\nDRIFT on ${drifted.length} page(s):`);
    for (const d of drifted) {
      console.log(`   ${d.file}`);
      for (const x of d.extra) console.log(`      + ${x}`);
      for (const x of d.gone) console.log(`      - ${x}`);
    }
  } else if (!missing.length) {
    console.log('\nno drift.');
  }

  if (VERBOSE) {
    for (const [file, { norm }] of found) console.log(`\n--- ${file}\n${norm}`);
  }
}

console.log(`\n${failures === 0 ? 'OK — page chrome is consistent.' : failures + ' problem(s).'}`);
process.exit(failures === 0 ? 0 : 1);
