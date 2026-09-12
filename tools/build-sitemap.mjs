#!/usr/bin/env node
/**
 * tools/build-sitemap.mjs — regenerate sitemap.xml from the file tree.
 *
 *   node tools/build-sitemap.mjs [--root <dir>] [--base https://helpmebreath.com] [--dry]
 *
 * Rules:
 *   - every .html file under <root> is a candidate
 *   - skipped: pages with <meta name="robots" content="noindex">, 404.html,
 *     offline.html, 500.html, render.html, and anything under
 *     templates/, docs/, node_modules/, .git/, api/
 *   - the <loc> is the page's own <link rel="canonical"> when it has one (so the
 *     sitemap can never disagree with the canonical), otherwise the clean URL
 *   - <lastmod> is the file's last commit date (git log -1 --format=%cI),
 *     falling back to the filesystem mtime
 *   - priority: / = 1.0, technique and use-case pages = 0.8, legal = 0.3,
 *     everything else = 0.5
 *
 * Zero dependencies. Node 18+.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const opts = { root: process.cwd(), base: 'https://helpmebreath.com', dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opts.root = argv[++i];
    else if (a === '--base') opts.base = argv[++i];
    else if (a === '--dry') opts.dry = true;
    else if (a.startsWith('--root=')) opts.root = a.slice(7);
    else if (a.startsWith('--base=')) opts.base = a.slice(7);
    else {
      console.error(`build-sitemap: unknown argument "${a}"`);
      process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(opts.root);
const BASE = opts.base.replace(/\/+$/, '');

/* --------------------------------------------------------------- discovery */

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.vercel',
  '.next',
  'embed',
  's',
  'templates',
  'docs',
  'api',
  'tools',
]);

const SKIP_FILES = new Set(['404.html', 'offline.html', '500.html', 'render.html']);

function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, acc);
    } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
      acc.push(abs);
    }
  }
  return acc;
}

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

/* ------------------------------------------------------------ page reading */

function readText(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

function isNoindex(html) {
  const m = /<meta[^>]+name=["']robots["'][^>]*>/i.exec(html);
  if (!m) return false;
  const content = /content=["']([^"']*)["']/i.exec(m[0]);
  return !!content && /\bnoindex\b/i.test(content[1]);
}

function canonicalOf(html) {
  const m = /<link[^>]+rel=["']canonical["'][^>]*>/i.exec(html);
  if (!m) return null;
  const href = /href=["']([^"']+)["']/i.exec(m[0]);
  return href ? href[1].trim() : null;
}

/** Clean URL for a file, mirroring vercel.json cleanUrls + trailingSlash:false. */
function cleanUrlFor(relPath) {
  const base = relPath.replace(/\.html?$/i, '');
  if (base === 'index') return `${BASE}/`;
  if (base.endsWith('/index')) return `${BASE}/${base.slice(0, -'/index'.length)}`;
  return `${BASE}/${base}`;
}

/* ------------------------------------------------------------------ lastmod */

let gitAvailable = true;

function gitLastModified(relPath) {
  if (!gitAvailable) return null;
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', relPath], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    gitAvailable = false;
    return null;
  }
}

function lastModifiedFor(relPath, abs) {
  const fromGit = gitLastModified(relPath);
  if (fromGit) return fromGit.slice(0, 10);
  try {
    return new Date(fs.statSync(abs).mtime).toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/* ----------------------------------------------------------------- priority */

async function techniqueSlugs() {
  const modulePath = path.join(ROOT, 'js', 'techniques.js');
  try {
    const mod = await import(pathToFileURL(modulePath).href);
    return new Set(Object.values(mod.TECHNIQUES).map((t) => t.slug).filter(Boolean));
  } catch {
    return new Set([
      '4-7-8-breathing',
      'box-breathing',
      'heart-coherence-breathing',
      'triangle-breathing',
      'energizing-breath',
      'cyclic-sighing',
      'extended-exhale-breathing',
    ]);
  }
}

function priorityFor(urlPath, slugs) {
  if (urlPath === '/' || urlPath === '') return '1.0';
  const slug = urlPath.replace(/^\/+/, '').replace(/\/+$/, '');
  if (slug.startsWith('legal/')) return '0.3';
  if (slugs.has(slug)) return '0.8';
  if (/^breathing-exercises/.test(slug)) return '0.8';
  return '0.5';
}

function changefreqFor(priority) {
  if (priority === '1.0') return 'weekly';
  if (priority === '0.3') return 'yearly';
  return 'monthly';
}

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* --------------------------------------------------------------------- run */

const slugs = await techniqueSlugs();
const entries = [];

for (const abs of walk(ROOT)) {
  const relPath = rel(abs);
  const baseName = relPath.split('/').pop();
  if (SKIP_FILES.has(baseName)) continue;

  const html = readText(abs);
  if (!html) continue;
  if (isNoindex(html)) continue;

  const canonical = canonicalOf(html);
  if (!canonical) {
    // A page with no canonical must not be listed: the sitemap would disagree
    // with the page and site-check would (correctly) flag it.
    console.warn(`build-sitemap: skipping ${relPath} — no <link rel="canonical">`);
    continue;
  }
  let loc = /^https?:\/\//i.test(canonical) ? canonical : cleanUrlFor(relPath);
  if (!loc.startsWith(`${BASE}/`) && loc.replace(/\/+$/, '') !== BASE) {
    // A canonical pointing off-site means the page is deliberately not ours.
    continue;
  }
  loc = loc.replace(/\/+$/, '') || BASE;
  if (loc === BASE) loc = `${BASE}/`;

  let urlPath;
  try {
    urlPath = new URL(loc).pathname;
  } catch {
    continue;
  }

  const priority = priorityFor(urlPath, slugs);
  entries.push({
    loc,
    lastmod: lastModifiedFor(relPath, abs),
    priority,
    changefreq: changefreqFor(priority),
    file: relPath,
  });
}

// Deduplicate (two files must never claim the same canonical) and sort.
const seen = new Map();
for (const entry of entries) {
  if (seen.has(entry.loc)) {
    console.warn(`build-sitemap: duplicate canonical "${entry.loc}" (${seen.get(entry.loc).file} and ${entry.file})`);
    continue;
  }
  seen.set(entry.loc, entry);
}

const sorted = [...seen.values()].sort((a, b) => {
  if (a.priority !== b.priority) return Number(b.priority) - Number(a.priority);
  return a.loc.localeCompare(b.loc);
});

const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...sorted.map((e) =>
    [
      '  <url>',
      `    <loc>${escapeXml(e.loc)}</loc>`,
      `    <lastmod>${e.lastmod}</lastmod>`,
      `    <changefreq>${e.changefreq}</changefreq>`,
      `    <priority>${e.priority}</priority>`,
      '  </url>',
    ].join('\n'),
  ),
  '</urlset>',
  '',
].join('\n');

if (opts.dry) {
  process.stdout.write(xml);
} else {
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), xml, 'utf8');
  console.log(`build-sitemap: wrote sitemap.xml with ${sorted.length} URL(s)`);
  for (const e of sorted) console.log(`  ${e.priority}  ${e.loc}`);
}
