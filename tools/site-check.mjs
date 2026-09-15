#!/usr/bin/env node
/**
 * tools/site-check.mjs — zero-dependency static-site QA gate for Help Me Breathe.
 *
 *   node tools/site-check.mjs [--root <dir>] [--json <outfile>] [--base https://helpmebreath.com]
 *
 * Discovers every .html file under <root>, builds a model of the site's public URL
 * space from vercel.json (or the legacy Netlify _redirects file), then runs per-page
 * and site-wide SEO / link / asset / PWA checks.
 *
 * Exit code 1 when any ERROR is reported, otherwise 0.
 *
 * No npm packages. HTML is parsed with a small tolerant regex tokenizer — good enough
 * for QA on hand-written static pages, and it never throws on malformed markup.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/* ======================================================================== *
 * CLI
 * ======================================================================== */

function parseArgs(argv) {
  const opts = { root: process.cwd(), json: null, base: 'https://helpmebreath.com' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opts.root = argv[++i];
    else if (a === '--json') opts.json = argv[++i];
    else if (a === '--base') opts.base = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--root=')) opts.root = a.slice(7);
    else if (a.startsWith('--json=')) opts.json = a.slice(7);
    else if (a.startsWith('--base=')) opts.base = a.slice(7);
    else {
      console.error(`site-check: unknown argument "${a}"`);
      process.exit(2);
    }
  }
  return opts;
}

const USAGE = `site-check — static-site QA gate (zero dependencies, Node 18+)

Usage:
  node tools/site-check.mjs [options]

Options:
  --root <dir>     Site root to scan (default: current working directory)
  --json <file>    Also write findings as a JSON array to <file>
  --base <url>     Canonical site origin (default: https://helpmebreath.com)
  -h, --help       Show this help

Exit code: 1 if any ERROR was reported, else 0.
`;

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const ROOT = path.resolve(opts.root);
if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  console.error(`site-check: --root "${ROOT}" is not a directory`);
  process.exit(2);
}

/** Normalised base: origin without a trailing slash, e.g. "https://helpmebreath.com". */
const BASE = opts.base.replace(/\/+$/, '');
let BASE_HOST = '';
try {
  BASE_HOST = new URL(BASE).host.toLowerCase();
} catch {
  console.error(`site-check: --base "${opts.base}" is not a valid absolute URL`);
  process.exit(2);
}

/* ======================================================================== *
 * Findings
 * ======================================================================== */

/** @type {{level:'ERROR'|'WARN'|'INFO', file:string|null, line:number|null, rule:string, message:string}[]} */
const findings = [];

function add(level, file, line, rule, message) {
  findings.push({
    level,
    file: file ?? null,
    line: Number.isFinite(line) && line > 0 ? line : null,
    rule,
    message: String(message),
  });
}
const ERR = (file, line, rule, msg) => add('ERROR', file, line, rule, msg);
const WARN = (file, line, rule, msg) => add('WARN', file, line, rule, msg);
const INFO = (file, line, rule, msg) => add('INFO', file, line, rule, msg);

/* ======================================================================== *
 * Filesystem discovery
 * ======================================================================== */

const SKIP_DIRS = new Set(['node_modules', '.git', '.vercel', '.next', '.cache', 'dist-cache']);

/**
 * Directories that live in the repo but are not the site. `docs/private` holds
 * the brand concept boards: standalone design comps with no head, no canonical
 * and demo form fields, deliberately. Auditing them as if they were pages
 * buries the report in errors nobody will ever act on. Paths are posix-style
 * and relative to ROOT; a prefix match skips the whole subtree.
 */
const SKIP_PATHS = ['docs/private'];

/** posix-style path relative to ROOT */
function rel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    WARN(rel(dir) || '.', null, 'fs-unreadable', `cannot read directory: ${e.message}`);
    return acc;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const relDir = rel(abs);
      if (SKIP_PATHS.some((p) => relDir === p || relDir.startsWith(p + '/'))) continue;
      walk(abs, acc);
    } else if (entry.isFile()) {
      acc.push(abs);
    }
  }
  return acc;
}

const allAbsFiles = walk(ROOT);
/** Set of every file in the site, as posix paths relative to ROOT. */
const allFiles = new Set(allAbsFiles.map(rel));
/** Case-insensitive lookup, so we can flag case-only mismatches on Windows. */
const filesLower = new Map();
for (const f of allFiles) filesLower.set(f.toLowerCase(), f);

const htmlFiles = [...allFiles].filter((f) => /\.html?$/i.test(f)).sort();

function readText(relPath) {
  try {
    return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  } catch {
    return null;
  }
}

/* ======================================================================== *
 * URL model: vercel.json / _redirects
 * ======================================================================== */

/**
 * Turn a Vercel/Netlify-style source pattern into a RegExp plus the names of its
 * capture groups. Supports `:param`, `:param*`, `(.*)` and bare `*` (splat).
 */
function patternToRegex(source) {
  const names = [];
  let out = '^';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '(' && source.slice(i, i + 4) === '(.*)') {
      names.push(null);
      out += '(.*)';
      i += 4;
      continue;
    }
    if (ch === ':') {
      const m = /^:([A-Za-z_][A-Za-z0-9_]*)(\*|\+|\?)?/.exec(source.slice(i));
      if (m) {
        names.push(m[1]);
        out += m[2] === '*' || m[2] === '+' ? '(.*)' : '([^/]+)';
        i += m[0].length;
        continue;
      }
    }
    if (ch === '*') {
      names.push('splat');
      out += '(.*)';
      i += 1;
      continue;
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  out += '$';
  let re;
  try {
    re = new RegExp(out);
  } catch {
    re = null;
  }
  return { re, names };
}

/** Substitute :param / :splat / $1 placeholders in a destination. */
function applyDestination(destination, names, match) {
  let dest = destination;
  names.forEach((name, idx) => {
    const value = match[idx + 1] ?? '';
    if (name) dest = dest.split(`:${name}`).join(value);
    dest = dest.split(`$${idx + 1}`).join(value);
  });
  // Any leftover :splat with no named splat group -> last capture.
  if (dest.includes(':splat') && match.length > 1) {
    dest = dest.split(':splat').join(match[match.length - 1] ?? '');
  }
  return dest;
}

/** @type {{cleanUrls:boolean, trailingSlash:boolean|null, rewrites:any[], redirects:any[], source:string}} */
const urlModel = {
  cleanUrls: false,
  trailingSlash: null,
  rewrites: [],
  redirects: [],
  source: 'none',
};

function compileRule(source, destination, kind, statusCode, origin) {
  const { re, names } = patternToRegex(source);
  if (!re) {
    WARN(origin, null, 'url-model', `could not compile ${kind} source pattern "${source}"`);
    return null;
  }
  return { source, destination, kind, statusCode, re, names, origin, literal: !/[:*()]/.test(source) };
}

function loadVercelJson() {
  if (!allFiles.has('vercel.json')) return false;
  const raw = readText('vercel.json');
  if (raw == null) {
    ERR('vercel.json', null, 'vercel-json', 'file exists but could not be read');
    return true;
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    ERR('vercel.json', jsonErrorLine(raw, e), 'vercel-json', `invalid JSON: ${e.message}`);
    return true;
  }
  urlModel.source = 'vercel.json';
  urlModel.cleanUrls = cfg.cleanUrls === true;
  urlModel.trailingSlash = typeof cfg.trailingSlash === 'boolean' ? cfg.trailingSlash : null;

  for (const r of Array.isArray(cfg.rewrites) ? cfg.rewrites : []) {
    if (!r || typeof r.source !== 'string' || typeof r.destination !== 'string') {
      WARN('vercel.json', null, 'vercel-json', 'rewrite entry missing string source/destination');
      continue;
    }
    // Under cleanUrls Vercel serves `blog/x.html` at `/blog/x` and answers a
    // rewrite whose destination keeps the `.html` with a 404 (seen live on
    // 2026-09-14 for /4-7-8-breathing-technique). Fail the build for it.
    if (urlModel.cleanUrls && /\.html?(?:[?#]|$)/i.test(r.destination)) {
      ERR('vercel.json', null, 'vercel-json', `rewrite ${r.source} -> ${r.destination}: with cleanUrls the destination must be the clean path (no .html), or Vercel answers 404`);
    }
    const rule = compileRule(r.source, r.destination, 'rewrite', 200, 'vercel.json');
    if (rule) urlModel.rewrites.push(rule);
  }
  let hostRules = 0;
  for (const r of Array.isArray(cfg.redirects) ? cfg.redirects : []) {
    if (!r || typeof r.source !== 'string' || typeof r.destination !== 'string') {
      WARN('vercel.json', null, 'vercel-json', 'redirect entry missing string source/destination');
      continue;
    }
    // A rule conditioned on the host (www -> apex) canonicalises the origin;
    // it is not part of the path URL space this model checks.
    if (Array.isArray(r.has) && r.has.some((h) => h && h.type === 'host')) {
      hostRules++;
      continue;
    }
    const status = r.statusCode ?? (r.permanent === false ? 307 : 308);
    const rule = compileRule(r.source, r.destination, 'redirect', status, 'vercel.json');
    if (rule) urlModel.redirects.push(rule);
  }
  INFO(
    'vercel.json',
    null,
    'url-model',
    `URL model from vercel.json: cleanUrls=${urlModel.cleanUrls}, trailingSlash=${urlModel.trailingSlash}, ` +
      `${urlModel.rewrites.length} rewrite(s), ${urlModel.redirects.length} redirect(s), ${hostRules} host-level rule(s)`,
  );
  return true;
}

function loadNetlifyRedirects() {
  if (!allFiles.has('_redirects')) return false;
  const raw = readText('_redirects');
  if (raw == null) return false;
  urlModel.source = '_redirects';
  // Netlify serves pretty URLs by default; without vercel.json that is the closest model.
  urlModel.cleanUrls = false;
  const lines = raw.split(/\r?\n/);
  let hostRules = 0;
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const text = line.replace(/^\s+/, '');
    if (!text || text.startsWith('#')) return;
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      WARN('_redirects', lineNo, 'url-model', `unparseable rule: "${text}"`);
      return;
    }
    const [source, destination, statusRaw] = parts;
    if (/^https?:\/\//i.test(source)) {
      // Host-level canonicalisation rule — not part of the path URL space.
      hostRules++;
      return;
    }
    const status = parseInt((statusRaw || '301').replace('!', ''), 10) || 301;
    const kind = status === 200 ? 'rewrite' : 'redirect';
    const rule = compileRule(source, destination, kind, status, '_redirects');
    if (!rule) return;
    rule.line = lineNo;
    (kind === 'rewrite' ? urlModel.rewrites : urlModel.redirects).push(rule);
  });
  INFO(
    '_redirects',
    null,
    'url-model',
    `URL model from legacy _redirects: ${urlModel.rewrites.length} rewrite(s), ` +
      `${urlModel.redirects.length} redirect(s), ${hostRules} host-level rule(s)`,
  );
  return true;
}

const hasVercelJson = loadVercelJson();
if (!hasVercelJson) {
  const hasLegacy = loadNetlifyRedirects();
  if (hasLegacy) {
    WARN(
      '_redirects',
      null,
      'hosting-config',
      'no vercel.json found — Vercel ignores the Netlify _redirects file, so these rewrites/redirects ' +
        'will NOT be applied in production. Port them to vercel.json (rewrites/redirects/cleanUrls).',
    );
  } else {
    WARN(null, null, 'hosting-config', 'no vercel.json and no _redirects file — URL model is filesystem-only');
  }
}

/* ------------------------------------------------------------------ paths -- */

/** Normalise a URL path: strip query/hash, resolve . and .., collapse slashes. */
function normalizePath(p) {
  if (typeof p !== 'string' || p === '') return null;
  let s = p.split('#')[0].split('?')[0];
  if (!s.startsWith('/')) s = '/' + s;
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep raw when percent-decoding fails */
  }
  const out = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return '/' + out.join('/');
}

/** Resolve a possibly-relative URL against the URL path a page is served at. */
function resolveAgainst(basePath, target) {
  if (target.startsWith('/')) return normalizePath(target);
  const dir = basePath.endsWith('/') ? basePath : basePath.slice(0, basePath.lastIndexOf('/') + 1);
  return normalizePath(dir + target);
}

/* ---------------------------------------------------------- public URL map -- */

/** public URL path -> file (posix, relative to ROOT) */
const publicMap = new Map();
/** file -> public URL paths that serve it directly from the filesystem */
const fileToPaths = new Map();

function registerPath(urlPath, file) {
  const key = normalizePath(urlPath);
  if (key == null) return;
  if (!publicMap.has(key)) publicMap.set(key, file);
  if (!fileToPaths.has(file)) fileToPaths.set(file, []);
  const list = fileToPaths.get(file);
  if (!list.includes(key)) list.push(key);
}

for (const file of allFiles) {
  registerPath('/' + file, file);
  const isHtml = /\.html?$/i.test(file);
  const baseName = file.split('/').pop();
  if (isHtml && /^index\.html?$/i.test(baseName)) {
    const dir = file.includes('/') ? '/' + file.slice(0, file.lastIndexOf('/')) : '/';
    registerPath(dir, file);
  }
  if (isHtml && urlModel.cleanUrls) {
    registerPath('/' + file.replace(/\.html?$/i, ''), file);
  }
}

const MAX_HOPS = 8;

/**
 * Resolve a public URL path through the URL model.
 * @returns {null | {file:string|null, via:'direct'|'rewrite'|'redirect', chain:string[], external?:string, rule?:any}}
 */
function resolveUrl(urlPath, seen = new Set(), hops = 0) {
  const key = normalizePath(urlPath);
  if (key == null || hops > MAX_HOPS || seen.has(key)) return null;
  seen.add(key);

  if (publicMap.has(key)) return { file: publicMap.get(key), via: 'direct', chain: [key] };

  // A cleanUrls-style request for a directory index we did not register explicitly.
  if (publicMap.has(key === '/' ? '/index.html' : key + '/index.html')) {
    const f = publicMap.get(key === '/' ? '/index.html' : key + '/index.html');
    return { file: f, via: 'direct', chain: [key] };
  }

  for (const kind of ['rewrites', 'redirects']) {
    for (const rule of urlModel[kind]) {
      const m = rule.re.exec(key);
      if (!m) continue;
      let dest = applyDestination(rule.destination, rule.names, m);
      if (/^https?:\/\//i.test(dest)) {
        let host = '';
        try {
          host = new URL(dest).host.toLowerCase();
        } catch {
          /* ignore */
        }
        if (host && host !== BASE_HOST) {
          return { file: null, via: rule.kind, chain: [key, dest], external: dest, rule };
        }
        try {
          dest = new URL(dest).pathname;
        } catch {
          /* ignore */
        }
      }
      const sub = resolveUrl(dest, seen, hops + 1);
      if (sub) {
        return {
          file: sub.file,
          // A rewrite chain that ends in a redirect is still a redirect for the visitor.
          via: rule.kind === 'redirect' || sub.via === 'redirect' ? 'redirect' : 'rewrite',
          chain: [key, ...sub.chain],
          rule,
        };
      }
    }
  }
  return null;
}

/** Every public URL path known to serve `file` (filesystem paths + literal rewrites). */
function servedPathsFor(file) {
  const paths = [...(fileToPaths.get(file) || [])];
  for (const rule of urlModel.rewrites) {
    if (!rule.literal) continue;
    const r = resolveUrl(rule.source);
    if (r && r.file === file && !paths.includes(normalizePath(rule.source))) {
      paths.push(normalizePath(rule.source));
    }
  }
  return paths;
}

/* ======================================================================== *
 * Tiny tolerant HTML tokenizer
 * ======================================================================== */

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

/** Replace every <!-- ... --> with same-length whitespace so offsets stay valid. */
function maskComments(src) {
  return src.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Inverse of maskComments: keep only comment bodies, same length, offsets intact. */
function commentsOnly(src) {
  const out = src.replace(/[^\n]/g, ' ').split('');
  const re = /<!--([\s\S]*?)(?:-->|$)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + 4;
    for (let i = 0; i < m[1].length; i++) {
      if (src[start + i] !== '\n') out[start + i] = src[start + i];
    }
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return out.join('');
}

function makeLineLookup(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“',
  rdquo: '”', bull: '•', middot: '·', copy: '©', trade: '™',
};

function decodeEntities(text) {
  if (typeof text !== 'string' || !text.includes('&')) return text ?? '';
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
  });
}

const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(attrText, attrTextIndex) {
  /** @type {{name:string, value:string, index:number, valueIndex:number}[]} */
  const list = [];
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(attrText)) !== null) {
    if (m[0] === '' || m[0] === '/') {
      if (ATTR_RE.lastIndex === m.index) ATTR_RE.lastIndex++;
      continue;
    }
    const name = m[1];
    if (!name || name === '/') continue;
    const rawValue = m[2] ?? m[3] ?? m[4] ?? '';
    const valueOffset = m[2] !== undefined || m[3] !== undefined
      ? m.index + m[0].indexOf(rawValue === '' ? '=' : rawValue)
      : m.index;
    list.push({
      name: name.toLowerCase(),
      rawName: name,
      value: rawValue,
      decoded: decodeEntities(rawValue),
      index: attrTextIndex + m.index,
      valueIndex: attrTextIndex + Math.max(valueOffset, 0),
      hasValue: m[2] !== undefined || m[3] !== undefined || m[4] !== undefined,
    });
  }
  return list;
}

/**
 * Tokenize an HTML document.
 * @returns {{tags:any[], texts:{text:string,index:number}[], rawText:{name:string,text:string,index:number,attrs:any[],tagLine:number}[]}}
 */
function tokenize(src) {
  const masked = maskComments(src);
  const lineOf = makeLineLookup(src);
  const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:._-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

  const tags = [];
  const texts = [];
  const rawText = [];
  let pos = 0;

  while (pos < masked.length) {
    TAG_RE.lastIndex = pos;
    const m = TAG_RE.exec(masked);
    if (!m) {
      if (pos < masked.length) texts.push({ text: masked.slice(pos), index: pos });
      break;
    }
    if (m.index > pos) texts.push({ text: masked.slice(pos, m.index), index: pos });

    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    let attrText = m[3] || '';
    const prefixLen = 1 + m[1].length + m[2].length;
    const attrIndex = m.index + prefixLen;
    let selfClosing = false;
    if (/\/\s*$/.test(attrText)) {
      selfClosing = true;
      attrText = attrText.replace(/\/\s*$/, ' ');
    }
    const attrs = closing ? [] : parseAttrs(attrText, attrIndex);
    const tag = {
      name,
      closing,
      selfClosing: selfClosing || VOID_TAGS.has(name),
      attrs,
      index: m.index,
      line: lineOf(m.index),
      end: m.index + m[0].length,
      attr(n) {
        const a = attrs.find((x) => x.name === n);
        return a ? a.decoded : undefined;
      },
      rawAttr(n) {
        const a = attrs.find((x) => x.name === n);
        return a ? a.value : undefined;
      },
      attrNode(n) {
        return attrs.find((x) => x.name === n);
      },
    };
    tags.push(tag);
    pos = tag.end;

    if (!closing && !tag.selfClosing && RAW_TEXT_TAGS.has(name)) {
      const closeRe = new RegExp(`</${name}\\s*>`, 'i');
      const restIndex = masked.slice(tag.end).search(closeRe);
      if (restIndex === -1) {
        rawText.push({ name, text: masked.slice(tag.end), index: tag.end, attrs, tagLine: tag.line });
        pos = masked.length;
      } else {
        const innerStart = tag.end;
        const innerEnd = tag.end + restIndex;
        rawText.push({
          name,
          text: masked.slice(innerStart, innerEnd),
          index: innerStart,
          attrs,
          tagLine: tag.line,
        });
        const closeMatch = closeRe.exec(masked.slice(innerEnd));
        pos = innerEnd + (closeMatch ? closeMatch[0].length : 0);
        tags.push({
          name,
          closing: true,
          selfClosing: false,
          attrs: [],
          index: innerEnd,
          line: lineOf(innerEnd),
          end: pos,
          attr: () => undefined,
          rawAttr: () => undefined,
          attrNode: () => undefined,
        });
      }
    }
  }
  return { tags, texts, rawText, masked, lineOf };
}

/* ======================================================================== *
 * Link classification
 * ======================================================================== */

const IGNORED_SCHEMES = /^(mailto:|tel:|sms:|javascript:|data:|blob:|about:|ftp:|geo:|whatsapp:|intent:)/i;

/**
 * Classify a URL string found in markup.
 * @returns {{kind:'skip'|'fragment'|'external'|'internal', path?:string, fragment?:string, host?:string, insecure?:boolean}}
 */
function classifyUrl(raw) {
  const value = (raw || '').trim();
  if (!value) return { kind: 'skip' };
  if (value.includes('{') || value.includes('}')) return { kind: 'skip', reason: 'template' };
  if (IGNORED_SCHEMES.test(value)) return { kind: 'skip' };
  if (value.startsWith('#')) return { kind: 'fragment', fragment: value.slice(1) };
  if (value.startsWith('//')) {
    let host = '';
    try {
      host = new URL('https:' + value).host.toLowerCase();
    } catch {
      /* ignore */
    }
    return host === BASE_HOST
      ? { kind: 'internal', path: value.replace(/^\/\/[^/]*/, '') || '/' }
      : { kind: 'external', host };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    if (!/^https?:/i.test(value)) return { kind: 'skip' };
    let u;
    try {
      u = new URL(value);
    } catch {
      return { kind: 'skip' };
    }
    const host = u.host.toLowerCase();
    const insecure = u.protocol === 'http:';
    if (host === BASE_HOST) {
      return { kind: 'internal', path: u.pathname + (u.hash || ''), host, insecure, absolute: true };
    }
    return { kind: 'external', host, insecure };
  }
  return { kind: 'internal', path: value };
}

/* ======================================================================== *
 * Per-page analysis
 * ======================================================================== */

const PLACEHOLDER_PATTERNS = [
  { re: /lorem ipsum/gi, label: 'lorem ipsum' },
  { re: /\bTODO\b/gi, label: 'TODO' },
  { re: /\bTBD\b/gi, label: 'TBD' },
  { re: /coming soon/gi, label: 'coming soon' },
  { re: /INSERT_/g, label: 'INSERT_' },
  { re: /\bXXX+\b/g, label: 'XXX' },
  { re: /\[placeholder\]/gi, label: '[placeholder]' },
  { re: /example\.com/gi, label: 'example.com' },
];

/** Pages that exist to be served on error/offline, never indexed. */
const UTILITY_PAGES = new Set(['404.html', 'offline.html', '500.html']);

/** @type {Map<string, {file:string, line:number}>} */
const canonicalOwners = new Map();
/** @type {Map<string, any>} */
const pages = new Map();
const externalHosts = new Map();

function jsonErrorLine(text, err) {
  const m = /position (\d+)/.exec(err && err.message ? err.message : '');
  if (!m) return null;
  const pos = parseInt(m[1], 10);
  return text.slice(0, pos).split('\n').length;
}

function analysePage(file) {
  const src = readText(file);
  if (src == null) {
    ERR(file, null, 'file-unreadable', 'could not read file');
    return null;
  }
  const { tags, texts, rawText, lineOf, masked } = tokenize(src);
  const page = {
    file,
    src,
    masked,
    commentsOnly: commentsOnly(src),
    lineOf,
    tags,
    texts,
    rawText,
    canonical: null,
    canonicalLine: null,
    indexable: true,
    utility: UTILITY_PAGES.has(file) || UTILITY_PAGES.has(file.split('/').pop()),
    ids: new Set(),
    servedPaths: servedPathsFor(file),
    primaryPath: null,
  };

  const openTags = tags.filter((t) => !t.closing);
  const metas = openTags.filter((t) => t.name === 'meta');
  const links = openTags.filter((t) => t.name === 'link');

  const metaByName = (name) =>
    metas.find((t) => (t.attr('name') || '').toLowerCase() === name.toLowerCase());
  const metaByProp = (prop) =>
    metas.find((t) => (t.attr('property') || '').toLowerCase() === prop.toLowerCase());

  for (const t of openTags) {
    const id = t.attr('id');
    if (id) page.ids.add(id);
  }

  /* ---------------------------------------------------------- robots/noindex */
  const robotsMeta = metaByName('robots');
  const robotsValue = (robotsMeta?.attr('content') || '').toLowerCase();
  if (/\bnoindex\b/.test(robotsValue)) page.indexable = false;
  if (page.utility) page.indexable = false;

  /* ------------------------------------------------------------ document head */
  const htmlTag = openTags.find((t) => t.name === 'html');
  if (!htmlTag) {
    ERR(file, 1, 'html-tag', 'no <html> element found');
  } else if (!htmlTag.attr('lang') || !htmlTag.attr('lang').trim()) {
    ERR(file, htmlTag.line, 'html-lang', '<html> is missing a non-empty lang attribute');
  }

  const charsetMeta = metas.find(
    (t) =>
      t.attrNode('charset') ||
      ((t.attr('http-equiv') || '').toLowerCase() === 'content-type' &&
        /charset=/i.test(t.attr('content') || '')),
  );
  if (!charsetMeta) ERR(file, htmlTag ? htmlTag.line : 1, 'meta-charset', 'missing <meta charset>');

  const viewportMeta = metaByName('viewport');
  if (!viewportMeta || !(viewportMeta.attr('content') || '').trim()) {
    ERR(file, viewportMeta ? viewportMeta.line : 1, 'meta-viewport', 'missing <meta name="viewport"> with content');
  }

  /* ------------------------------------------------------------------- title */
  const titleRaw = rawText.find((r) => r.name === 'title');
  const titleText = decodeEntities((titleRaw?.text || '').trim()).replace(/\s+/g, ' ');
  if (!titleRaw || !titleText) {
    ERR(file, titleRaw ? titleRaw.tagLine : 1, 'title', '<title> is missing or empty');
  } else if (titleText.length > 65) {
    WARN(file, titleRaw.tagLine, 'title-length', `<title> is ${titleText.length} chars (>65): "${titleText}"`);
  }

  /* --------------------------------------------------------------- H1 count */
  const h1s = openTags.filter((t) => t.name === 'h1');
  if (h1s.length === 0) ERR(file, 1, 'h1-count', 'no <h1> found (expected exactly one)');
  else if (h1s.length > 1) {
    ERR(
      file,
      h1s[1].line,
      'h1-count',
      `${h1s.length} <h1> elements found (expected exactly one); others at lines ${h1s.map((t) => t.line).join(', ')}`,
    );
  }

  /* ---------------------------------------------------------- description */
  const descMeta = metaByName('description');
  const descValue = (descMeta?.attr('content') || '').trim();
  if (page.indexable) {
    if (!descMeta || !descValue) {
      ERR(file, descMeta ? descMeta.line : 1, 'meta-description', 'missing <meta name="description">');
    } else if (descValue.length < 50 || descValue.length > 165) {
      WARN(
        file,
        descMeta.line,
        'meta-description-length',
        `meta description is ${descValue.length} chars (expected 50-165)`,
      );
    }
  }

  /* ------------------------------------------------------------- canonical */
  const canonicalLinks = links.filter((t) => (t.attr('rel') || '').toLowerCase().split(/\s+/).includes('canonical'));
  if (page.indexable) {
    if (canonicalLinks.length === 0) {
      ERR(file, 1, 'canonical-missing', 'no <link rel="canonical"> on an indexable page');
    } else {
      if (canonicalLinks.length > 1) {
        ERR(file, canonicalLinks[1].line, 'canonical-duplicate-tag', `${canonicalLinks.length} canonical tags in one page`);
      }
      const tag = canonicalLinks[0];
      const href = (tag.attr('href') || '').trim();
      page.canonicalLine = tag.line;
      if (!href) {
        ERR(file, tag.line, 'canonical-empty', 'canonical link has an empty href');
      } else if (!/^https?:\/\//i.test(href)) {
        ERR(file, tag.line, 'canonical-relative', `canonical must be an absolute URL, got "${href}"`);
      } else if (!href.startsWith(BASE + '/') && href.replace(/\/$/, '') !== BASE) {
        ERR(file, tag.line, 'canonical-host', `canonical "${href}" does not start with base "${BASE}"`);
      } else {
        page.canonical = href;
        const cPath = normalizePath(new URL(href).pathname);
        page.canonicalPath = cPath;
        const resolved = resolveUrl(cPath);
        if (!resolved || !resolved.file) {
          ERR(file, tag.line, 'canonical-unresolvable', `canonical path "${cPath}" does not resolve to any file`);
        } else if (resolved.file !== file) {
          ERR(
            file,
            tag.line,
            'canonical-mismatch',
            `canonical path "${cPath}" resolves to ${resolved.file} (via ${resolved.via}), not to this page`,
          );
        } else if (resolved.via === 'redirect') {
          ERR(
            file,
            tag.line,
            'canonical-redirect',
            `canonical path "${cPath}" only reaches this page through a redirect (${resolved.chain.join(' -> ')})`,
          );
        } else {
          page.primaryPath = cPath;
          if (urlModel.trailingSlash === true && cPath !== '/' && !new URL(href).pathname.endsWith('/') && !/\.[a-z0-9]+$/i.test(cPath)) {
            WARN(file, tag.line, 'canonical-trailing-slash', 'vercel.json sets trailingSlash:true but canonical has no trailing slash');
          }
          if (urlModel.trailingSlash === false && cPath !== '/' && new URL(href).pathname.endsWith('/')) {
            WARN(file, tag.line, 'canonical-trailing-slash', 'vercel.json sets trailingSlash:false but canonical has a trailing slash');
          }
        }
        const normalizedCanonical = href.replace(/\/+$/, '') || BASE;
        const owner = canonicalOwners.get(normalizedCanonical);
        if (owner && owner.file !== file) {
          ERR(
            file,
            tag.line,
            'canonical-duplicate',
            `canonical "${href}" is also declared by ${owner.file}:${owner.line}`,
          );
        } else if (!owner) {
          canonicalOwners.set(normalizedCanonical, { file, line: tag.line });
        }
      }
    }
  }

  if (!page.primaryPath) {
    const candidates = page.servedPaths;
    page.primaryPath =
      candidates.find((p) => !/\.html?$/i.test(p)) || candidates[0] || '/' + file;
  }

  /* ------------------------------------------------------- social meta tags */
  if (page.indexable) {
    const og = {
      title: metaByProp('og:title') || metaByName('og:title'),
      description: metaByProp('og:description') || metaByName('og:description'),
      image: metaByProp('og:image') || metaByName('og:image'),
      url: metaByProp('og:url') || metaByName('og:url'),
    };
    for (const key of ['title', 'description', 'image', 'url']) {
      const tag = og[key];
      if (!tag || !(tag.attr('content') || '').trim()) {
        ERR(file, tag ? tag.line : 1, `og-${key}`, `missing <meta property="og:${key}">`);
      }
    }
    const imageTag = og.image;
    const imageUrl = (imageTag?.attr('content') || '').trim();
    if (imageUrl) {
      if (!/^https?:\/\//i.test(imageUrl)) {
        ERR(file, imageTag.line, 'og-image-absolute', `og:image must be an absolute URL, got "${imageUrl}"`);
      } else {
        const cls = classifyUrl(imageUrl);
        if (cls.kind === 'internal') {
          const r = resolveUrl(cls.path);
          if (!r || !r.file) {
            ERR(file, imageTag.line, 'og-image-missing', `og:image "${imageUrl}" does not resolve to a file in the repo`);
          }
        } else {
          WARN(file, imageTag.line, 'og-image-external', `og:image is hosted off-site (${cls.host || 'unknown host'})`);
        }
      }
    }
    const ogUrl = (og.url?.attr('content') || '').trim();
    if (ogUrl && page.canonical) {
      const a = ogUrl.replace(/\/+$/, '') || BASE;
      const b = page.canonical.replace(/\/+$/, '') || BASE;
      if (a !== b) {
        ERR(file, og.url.line, 'og-url-canonical', `og:url "${ogUrl}" does not match canonical "${page.canonical}"`);
      }
    }
    const twCard = metaByName('twitter:card') || metaByProp('twitter:card');
    if (!twCard || !(twCard.attr('content') || '').trim()) {
      ERR(file, 1, 'twitter-card', 'missing <meta name="twitter:card">');
    }
  } else {
    INFO(
      file,
      null,
      'utility-page',
      'non-indexable page (404/offline or robots noindex) — canonical, social-meta, description and sitemap checks skipped',
    );
  }

  /* -------------------------------------------------------------- <img> alt */
  for (const t of openTags.filter((x) => x.name === 'img')) {
    const altNode = t.attrNode('alt');
    const role = (t.attr('role') || '').toLowerCase();
    const ariaHidden = (t.attr('aria-hidden') || '').toLowerCase();
    const decorativeOk = role === 'presentation' || role === 'none' || ariaHidden === 'true';
    if (!altNode) {
      ERR(file, t.line, 'img-alt', `<img src="${t.attr('src') || ''}"> has no alt attribute`);
    } else if (!altNode.decoded.trim() && !decorativeOk) {
      ERR(
        file,
        t.line,
        'img-alt-empty',
        `<img src="${t.attr('src') || ''}"> has alt="" without role="presentation" or aria-hidden="true"`,
      );
    }
  }

  /* --------------------------------------------------- target=_blank / rel */
  for (const t of openTags.filter((x) => x.name === 'a' || x.name === 'area')) {
    if ((t.attr('target') || '').toLowerCase() !== '_blank') continue;
    const relValue = (t.attr('rel') || '').toLowerCase();
    if (!relValue.split(/[\s,]+/).includes('noopener')) {
      ERR(
        file,
        t.line,
        'target-blank-noopener',
        `<a target="_blank" href="${t.attr('href') || ''}"> is missing rel="noopener"`,
      );
    }
  }

  /* ------------------------------------------------------------ inline JS */
  const inlineHandlers = [];
  for (const t of openTags) {
    for (const a of t.attrs) {
      if (/^on[a-z]+$/.test(a.name)) inlineHandlers.push({ tag: t.name, attr: a.name, line: t.line });
    }
  }
  if (inlineHandlers.length) {
    const preview = inlineHandlers.slice(0, 5).map((h) => `${h.attr} on <${h.tag}> line ${h.line}`).join('; ');
    INFO(
      file,
      inlineHandlers[0].line,
      'inline-handlers',
      `${inlineHandlers.length} inline event handler attribute(s): ${preview}${inlineHandlers.length > 5 ? '; …' : ''}`,
    );
  }

  /* --------------------------------------------------------------- links */
  const URL_ATTRS = new Map([
    ['href', new Set(['a', 'link', 'area', 'base'])],
    ['src', new Set(['img', 'script', 'iframe', 'source', 'video', 'audio', 'embed', 'track', 'input'])],
    ['poster', new Set(['video'])],
    ['data-src', null],
    ['srcset', new Set(['img', 'source'])],
    ['data-srcset', null],
  ]);

  for (const t of openTags) {
    for (const attr of t.attrs) {
      const allowed = URL_ATTRS.get(attr.name);
      if (allowed === undefined) continue;
      if (allowed && !allowed.has(t.name)) continue;
      const values =
        attr.name === 'srcset' || attr.name === 'data-srcset'
          ? attr.decoded.split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean)
          : [attr.decoded];
      for (const value of values) checkLink(page, t, attr, value);
    }
  }

  /* ------------------------------------------------------------- JSON-LD */
  for (const raw of rawText.filter((r) => r.name === 'script')) {
    const type = (raw.attrs.find((a) => a.name === 'type')?.decoded || '').toLowerCase();
    if (type !== 'application/ld+json') continue;
    const body = raw.text;
    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      const offset = jsonErrorLine(body, e);
      ERR(
        file,
        offset ? raw.tagLine + offset - 1 : raw.tagLine,
        'jsonld-parse',
        `application/ld+json does not parse: ${e.message}`,
      );
      continue;
    }
    const roots = Array.isArray(data) ? data : [data];
    for (const root of roots) {
      if (!root || typeof root !== 'object') {
        ERR(file, raw.tagLine, 'jsonld-shape', 'application/ld+json root is not an object');
        continue;
      }
      if (!root['@context']) {
        ERR(file, raw.tagLine, 'jsonld-context', 'JSON-LD block has no @context');
      }
      checkJsonLdUrls(page, root, raw.tagLine, new Set());
    }
  }

  /* --------------------------------------------------------- placeholders */
  checkPlaceholders(page);

  /* -------------------------------------------------- wrong host / http */
  checkHostHygiene(page);

  return page;
}

/* --------------------------------------------------------------- helpers -- */

function checkLink(page, tag, attr, value) {
  const file = page.file;
  const line = page.lineOf(attr.valueIndex);
  const cls = classifyUrl(value);

  if (cls.kind === 'skip') return;

  if (cls.kind === 'fragment') {
    if (cls.fragment && !page.ids.has(cls.fragment) && !/^(top|main-content)$/.test(cls.fragment)) {
      WARN(file, line, 'fragment-target', `in-page link "#${cls.fragment}" has no matching id in this document`);
    }
    return;
  }

  if (cls.kind === 'external') {
    if (cls.host) externalHosts.set(cls.host, (externalHosts.get(cls.host) || 0) + 1);
    if (cls.insecure) {
      WARN(file, line, 'mixed-content', `${attr.name}="${value}" uses insecure http:// — will be blocked/downgraded`);
    }
    return;
  }

  // internal
  const rawPath = cls.path || '/';
  const hash = rawPath.includes('#') ? rawPath.slice(rawPath.indexOf('#') + 1) : '';
  const bare = hash ? rawPath.slice(0, rawPath.indexOf('#')) : rawPath;
  if (bare === '' && hash) return; // pure fragment written as "#x" is handled above

  const candidateBases = [];
  if (page.primaryPath) candidateBases.push(page.primaryPath);
  for (const p of page.servedPaths) if (!candidateBases.includes(p)) candidateBases.push(p);
  if (!candidateBases.length) candidateBases.push('/' + page.file);

  const results = candidateBases.map((basePath) => {
    const target = resolveAgainst(basePath, bare === '' ? basePath : bare);
    return { basePath, target, res: resolveUrl(target) };
  });

  const ok = results.filter((r) => r.res && (r.res.file || r.res.external));
  if (!ok.length) {
    const tried = [...new Set(results.map((r) => r.target))];
    // A case-only mismatch works on Windows/macOS but 404s on Vercel's Linux hosts.
    for (const target of tried) {
      const actual = filesLower.get(target.replace(/^\//, '').toLowerCase());
      if (actual) {
        ERR(
          file,
          line,
          'link-case',
          `${attr.name}="${value}" differs only in letter case from the real file "${actual}" — ` +
            'this works locally on Windows but 404s on Vercel (case-sensitive Linux)',
        );
        return;
      }
    }
    ERR(
      file,
      line,
      'broken-link',
      `${attr.name}="${value}" does not resolve to any file (tried ${tried.join(', ')})`,
    );
    return;
  }

  const first = ok[0];
  if (ok.length < results.length && !bare.startsWith('/')) {
    WARN(
      file,
      line,
      'relative-link-ambiguous',
      `relative ${attr.name}="${value}" only resolves from some of this page's URLs ` +
        `(${results.filter((r) => !(r.res && r.res.file)).map((r) => r.basePath).join(', ')} fail)`,
    );
  }

  if (first.res.external) {
    WARN(file, line, 'link-offsite-redirect', `${attr.name}="${value}" redirects off-site to ${first.res.external}`);
    return;
  }

  if (first.res.via === 'redirect') {
    INFO(
      file,
      line,
      'link-via-redirect',
      `${attr.name}="${value}" resolves via redirect (${first.res.chain.join(' -> ')} => ${first.res.file})`,
    );
  } else if (first.res.via === 'rewrite') {
    INFO(
      file,
      line,
      'link-via-rewrite',
      `${attr.name}="${value}" resolves via rewrite (${first.res.chain.join(' -> ')} => ${first.res.file})`,
    );
  }
}

const JSONLD_URL_KEYS = new Set(['url', 'image', 'item', 'contenturl', 'thumbnailurl', 'logo', 'sameas']);

function checkJsonLdUrls(page, node, line, seen) {
  if (node == null || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const child of node) checkJsonLdUrls(page, child, line, seen);
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    const lowerKey = key.toLowerCase();
    if (JSONLD_URL_KEYS.has(lowerKey)) {
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        if (typeof item === 'string') {
          verifyJsonLdUrl(page, key, item, line);
        } else if (item && typeof item === 'object') {
          checkJsonLdUrls(page, item, line, seen);
        }
      }
      continue;
    }
    if (value && typeof value === 'object') checkJsonLdUrls(page, value, line, seen);
  }
}

function verifyJsonLdUrl(page, key, value, line) {
  const cls = classifyUrl(value);
  if (cls.kind !== 'internal') return; // off-site (sameAs, external logos) is out of scope
  const bare = value.split('#')[0];
  if (!bare) return;
  const target = resolveAgainst(page.primaryPath || '/' + page.file, bare.startsWith('http') ? new URL(bare).pathname : bare);
  const res = resolveUrl(target);
  if (!res || !res.file) {
    WARN(
      page.file,
      line,
      'jsonld-url',
      `JSON-LD "${key}": "${value}" does not resolve to a file or page on ${BASE_HOST}`,
    );
  }
}

function checkPlaceholders(page) {
  const spans = [];
  for (const t of page.texts) spans.push({ text: t.text, index: t.index, where: 'text' });
  for (const tag of page.tags) {
    if (tag.closing) continue;
    for (const a of tag.attrs) {
      if (!a.hasValue) continue;
      if (/^(href|src|srcset|data-src)$/.test(a.name) && /^data:/i.test(a.value)) continue;
      spans.push({ text: a.value, index: a.valueIndex, where: `attribute ${a.name} on <${tag.name}>` });
    }
  }
  for (const raw of page.rawText) {
    const type = (raw.attrs?.find((a) => a.name === 'type')?.decoded || '').toLowerCase();
    if (raw.name === 'title') spans.push({ text: raw.text, index: raw.index, where: 'title' });
    if (raw.name === 'script' && type === 'application/ld+json') {
      spans.push({ text: raw.text, index: raw.index, where: 'JSON-LD' });
    }
  }

  for (const span of spans) {
    for (const { re, label } of PLACEHOLDER_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(span.text)) !== null) {
        const line = page.lineOf(span.index + m.index);
        ERR(
          page.file,
          line,
          'placeholder',
          `placeholder text "${label}" found in ${span.where}: "${snippet(span.text, m.index)}"`,
        );
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    }
  }

  // Inline (non-JSON-LD) scripts: same patterns, but only a warning.
  for (const raw of page.rawText) {
    if (raw.name !== 'script') continue;
    const type = (raw.attrs?.find((a) => a.name === 'type')?.decoded || '').toLowerCase();
    if (type && type !== 'text/javascript' && type !== 'module' && type !== 'application/javascript') continue;
    for (const { re, label } of PLACEHOLDER_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(raw.text)) !== null) {
        WARN(
          page.file,
          page.lineOf(raw.index + m.index),
          'placeholder-script',
          `placeholder text "${label}" found in inline script: "${snippet(raw.text, m.index)}"`,
        );
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    }
  }
}

function snippet(text, index) {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + 40);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

function checkHostHygiene(page) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const apex = BASE_HOST.replace(/^www\./, '');
  const patterns = [
    { re: new RegExp('http://' + esc(BASE_HOST), 'gi'), label: `http://${BASE_HOST}` },
    { re: new RegExp('www\\.' + esc(apex), 'gi'), label: `www.${apex}` },
  ];
  // page.masked has every <!-- comment --> blanked out, so a hit there is live markup.
  for (const { re, label } of patterns) {
    for (const [source, level] of [
      [page.masked, 'ERROR'],
      [page.commentsOnly, 'WARN'],
    ]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(source)) !== null) {
        const msg =
          `non-canonical host reference "${label}" — use ${BASE} instead` +
          `${level === 'WARN' ? ' (inside an HTML comment)' : ''}: "${snippet(source, m.index)}"`;
        add(level, page.file, page.lineOf(m.index), 'wrong-host', msg);
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    }
  }
}

/* ======================================================================== *
 * Run per-page analysis
 * ======================================================================== */

if (!htmlFiles.length) {
  ERR(null, null, 'no-pages', `no .html files found under ${ROOT}`);
}

for (const file of htmlFiles) {
  try {
    const page = analysePage(file);
    if (page) pages.set(file, page);
  } catch (e) {
    ERR(file, null, 'internal-error', `site-check crashed while analysing this file: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
  }
}

/* ======================================================================== *
 * Site-wide checks
 * ======================================================================== */

const indexablePages = [...pages.values()].filter((p) => p.indexable);

/* ---------------------------------------------------------------- sitemap */
function checkSitemap() {
  if (!allFiles.has('sitemap.xml')) {
    ERR(null, null, 'sitemap-missing', 'sitemap.xml not found at the site root');
    return;
  }
  const xml = readText('sitemap.xml');
  if (xml == null) {
    ERR('sitemap.xml', null, 'sitemap-unreadable', 'sitemap.xml could not be read');
    return;
  }
  const lineOf = makeLineLookup(xml);
  if (!/<urlset[\s>]/i.test(xml) && !/<sitemapindex[\s>]/i.test(xml)) {
    ERR('sitemap.xml', 1, 'sitemap-parse', 'no <urlset> or <sitemapindex> root element');
  }
  // Cheap well-formedness signals.
  const badAmp = /&(?!(?:[a-zA-Z]+|#[0-9]+|#x[0-9a-fA-F]+);)/.exec(xml);
  if (badAmp) {
    ERR('sitemap.xml', lineOf(badAmp.index), 'sitemap-parse', 'raw "&" that is not an XML entity (invalid XML)');
  }
  const openUrls = (xml.match(/<url>/gi) || []).length;
  const closeUrls = (xml.match(/<\/url>/gi) || []).length;
  if (openUrls !== closeUrls) {
    ERR('sitemap.xml', 1, 'sitemap-parse', `unbalanced <url> tags (${openUrls} open, ${closeUrls} close)`);
  }

  const locRe = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  const listed = new Set();
  let m;
  let count = 0;
  while ((m = locRe.exec(xml)) !== null) {
    count++;
    const line = lineOf(m.index);
    const loc = decodeEntities(m[1].trim());
    if (!/^https?:\/\//i.test(loc)) {
      ERR('sitemap.xml', line, 'sitemap-loc-absolute', `<loc> must be an absolute URL, got "${loc}"`);
      continue;
    }
    if (!loc.startsWith(BASE + '/') && loc.replace(/\/$/, '') !== BASE) {
      ERR('sitemap.xml', line, 'sitemap-loc-host', `<loc> "${loc}" is not on base "${BASE}"`);
      continue;
    }
    const locPath = normalizePath(new URL(loc).pathname);
    const res = resolveUrl(locPath);
    if (!res || !res.file) {
      ERR('sitemap.xml', line, 'sitemap-loc-broken', `<loc> "${loc}" does not resolve to any file`);
      continue;
    }
    if (res.via === 'redirect') {
      ERR(
        'sitemap.xml',
        line,
        'sitemap-loc-redirect',
        `<loc> "${loc}" is a redirect (${res.chain.join(' -> ')}) — sitemaps must list final URLs`,
      );
      continue;
    }
    const page = pages.get(res.file);
    if (!page) {
      ERR('sitemap.xml', line, 'sitemap-loc-not-page', `<loc> "${loc}" resolves to ${res.file}, which is not an HTML page`);
      continue;
    }
    listed.add(page.file);
    if (!page.indexable) {
      ERR('sitemap.xml', line, 'sitemap-loc-noindex', `<loc> "${loc}" points at non-indexable page ${page.file}`);
      continue;
    }
    if (!page.canonical) {
      ERR(
        'sitemap.xml',
        line,
        'sitemap-loc-canonical',
        `<loc> "${loc}" -> ${page.file} which declares no usable canonical URL`,
      );
      continue;
    }
    const a = loc.replace(/\/+$/, '') || BASE;
    const b = page.canonical.replace(/\/+$/, '') || BASE;
    if (a !== b) {
      ERR(
        'sitemap.xml',
        line,
        'sitemap-loc-canonical',
        `<loc> "${loc}" does not equal the canonical of ${page.file} ("${page.canonical}")`,
      );
    }
  }
  if (count === 0) ERR('sitemap.xml', 1, 'sitemap-empty', 'sitemap contains no <loc> entries');

  for (const page of indexablePages) {
    if (!listed.has(page.file)) {
      WARN(page.file, null, 'sitemap-missing-page', `indexable page is not listed in sitemap.xml`);
    }
  }
  INFO('sitemap.xml', null, 'sitemap', `${count} <loc> entr${count === 1 ? 'y' : 'ies'}, ${indexablePages.length} indexable page(s) on disk`);
}

/* ----------------------------------------------------------------- robots */
function checkRobots() {
  if (!allFiles.has('robots.txt')) {
    ERR(null, null, 'robots-missing', 'robots.txt not found at the site root');
    return;
  }
  const txt = readText('robots.txt') || '';
  const lines = txt.split(/\r?\n/);

  lines.forEach((line, i) => {
    if (/^\s*Disallow:\s*\/\s*$/i.test(line)) {
      ERR(
        'robots.txt',
        i + 1,
        'robots-disallow-all',
        '"Disallow: /" blocks the whole site from crawlers',
      );
    }
  });

  const sitemapLines = [];
  lines.forEach((line, i) => {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (m) sitemapLines.push({ url: m[1], line: i + 1 });
  });
  if (!sitemapLines.length) {
    ERR('robots.txt', null, 'robots-sitemap', 'no "Sitemap:" line found');
    return;
  }
  const expected = `${BASE}/sitemap.xml`;
  const match = sitemapLines.find((s) => s.url.replace(/\/+$/, '') === expected);
  if (!match) {
    ERR(
      'robots.txt',
      sitemapLines[0].line,
      'robots-sitemap',
      `Sitemap line points at "${sitemapLines[0].url}", expected "${expected}"`,
    );
  }
}

/* --------------------------------------------------------------- manifest */
function checkManifest() {
  const candidates = ['manifest.json', 'manifest.webmanifest', 'site.webmanifest'];
  const found = candidates.find((c) => allFiles.has(c));
  if (!found) {
    WARN(null, null, 'manifest-missing', 'no web app manifest found at the site root');
    return;
  }
  const raw = readText(found) || '';
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    ERR(found, jsonErrorLine(raw, e), 'manifest-parse', `invalid JSON: ${e.message}`);
    return;
  }
  const lineOf = makeLineLookup(raw);
  const lineFor = (needle) => {
    const idx = raw.indexOf(needle);
    return idx === -1 ? null : lineOf(idx);
  };
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  if (!icons.length) WARN(found, null, 'manifest-icons', 'manifest declares no icons');
  for (const icon of icons) {
    const src = typeof icon?.src === 'string' ? icon.src : null;
    if (!src) {
      ERR(found, null, 'manifest-icon-src', 'icon entry has no string "src"');
      continue;
    }
    const res = resolveUrl(resolveAgainst('/' + found, src));
    if (!res || !res.file) {
      ERR(found, lineFor(src), 'manifest-icon-missing', `icon "${src}" does not resolve to a file`);
    }
  }
  for (const key of ['start_url', 'scope']) {
    const value = manifest[key];
    if (typeof value !== 'string') continue;
    const res = resolveUrl(resolveAgainst('/' + found, value));
    if (!res || !res.file) {
      WARN(found, lineFor(value), `manifest-${key}`, `${key} "${value}" does not resolve to a page`);
    }
  }
  const referenced = [...pages.values()].some((p) =>
    p.tags.some(
      (t) => !t.closing && t.name === 'link' && (t.attr('rel') || '').toLowerCase().split(/\s+/).includes('manifest'),
    ),
  );
  if (!referenced) WARN(found, null, 'manifest-unlinked', 'no page contains <link rel="manifest">');
}

/* ------------------------------------------------------------ service worker */
function checkServiceWorker() {
  const candidates = ['sw.js', 'service-worker.js', 'serviceworker.js'];
  const found = candidates.find((c) => allFiles.has(c));
  if (!found) {
    INFO(null, null, 'sw-missing', 'no service worker (sw.js) at the site root');
    return;
  }
  const src = readText(found) || '';
  const lineOf = makeLineLookup(src);
  const m = /PRECACHE_URLS\s*(?::[^=]*)?=\s*\[([\s\S]*?)\]/.exec(src);
  if (!m) {
    WARN(found, null, 'sw-precache', 'could not find a PRECACHE_URLS array literal to validate');
    return;
  }
  const arrayStart = m.index + m[0].indexOf('[');
  const body = m[1];
  const entryRe = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let entry;
  let n = 0;
  while ((entry = entryRe.exec(body)) !== null) {
    n++;
    const value = entry[2];
    const line = lineOf(arrayStart + 1 + entry.index);
    if (value.includes('${')) {
      WARN(found, line, 'sw-precache-dynamic', `PRECACHE_URLS entry "${value}" is a template literal — not validated`);
      continue;
    }
    const cls = classifyUrl(value);
    if (cls.kind === 'external') {
      INFO(found, line, 'sw-precache-external', `PRECACHE_URLS entry "${value}" is cross-origin — not validated`);
      continue;
    }
    if (cls.kind !== 'internal') continue;
    const res = resolveUrl(normalizePath(cls.path));
    if (!res || !res.file) {
      ERR(
        found,
        line,
        'sw-precache-broken',
        `PRECACHE_URLS entry "${value}" does not resolve to a file — cache.addAll() will reject and the SW install will fail`,
      );
    } else if (res.via === 'redirect') {
      ERR(
        found,
        line,
        'sw-precache-redirect',
        `PRECACHE_URLS entry "${value}" is a redirect (${res.chain.join(' -> ')}) — cache.addAll() rejects on redirects`,
      );
    }
  }
  if (n === 0) WARN(found, null, 'sw-precache', 'PRECACHE_URLS array is empty or unparseable');
  else INFO(found, null, 'sw-precache', `${n} PRECACHE_URLS entr${n === 1 ? 'y' : 'ies'} validated`);
}

/* ------------------------------------------------------------------ ads.txt */
function checkAdsTxt() {
  if (allFiles.has('ads.txt')) {
    const txt = (readText('ads.txt') || '').trim();
    const records = txt.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
    INFO('ads.txt', null, 'ads-txt', `present with ${records.length} record(s)`);
  } else {
    INFO(null, null, 'ads-txt', 'ads.txt not present (AdSense recommends one when serving ads)');
  }
}

/* ------------------------------------------------- --clay on the timer ---- */
/**
 * docs/BRAND.md section 1: "--clay ... Never on the timer screen." Section 8
 * repeats it, and section 10.8 predicted that a discipline with no mechanism
 * behind it would eventually leak — it did, into the post-session paywall card
 * in css/pro.css. This is the mechanism it asked for.
 *
 * A stylesheet rule whose selector is scoped to the breathing section or to the
 * post-session slot may not use var(--clay). The commerce accent belongs on
 * /pro; the timer is not for sale.
 */
function checkClayOnTimer() {
  const TIMER_SCOPES = ['.breathing-section', '[data-slot="post-session"]', '.post-session-card', '.paywall-card'];
  for (const file of [...allFiles].filter((f) => f.endsWith('.css')).sort()) {
    const raw = readText(file);
    if (raw == null) continue;
    const lineOf = makeLineLookup(raw);
    // Strip comments so a mention in prose is not a finding.
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = ruleRe.exec(css)) !== null) {
      const selector = m[1];
      const body = m[2];
      if (!body.includes('var(--clay)')) continue;
      const scope = TIMER_SCOPES.find((s2) => selector.includes(s2));
      if (!scope) continue;
      ERR(
        file,
        lineOf(m.index + m[1].length),
        'clay-on-timer',
        `var(--clay) under a timer-scoped selector (${scope}). BRAND.md sections 1 and 8: ` +
          'the commerce accent never appears on the timer screen.',
      );
    }
  }
}

/* -------------------------------------------------------------- vercel.json */
function checkVercelJson() {
  if (!allFiles.has('vercel.json')) return;
  const raw = readText('vercel.json');
  if (raw == null) return;
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return; // already reported at load time
  }
  const lineOf = makeLineLookup(raw);
  const lineFor = (needle) => {
    const idx = raw.indexOf(needle);
    return idx === -1 ? null : lineOf(idx);
  };
  const check = (kind, entries) => {
    for (const e of Array.isArray(entries) ? entries : []) {
      const dest = e && typeof e.destination === 'string' ? e.destination : null;
      if (!dest) continue;
      if (/^https?:\/\//i.test(dest)) {
        let host = '';
        try {
          host = new URL(dest).host.toLowerCase();
        } catch {
          /* ignore */
        }
        if (host && host !== BASE_HOST) continue; // off-site destination is intentional
      }
      if (dest.includes(':') || dest.includes('$')) continue; // parameterised — cannot verify statically
      const res = resolveUrl(resolveAgainst('/', /^https?:/i.test(dest) ? new URL(dest).pathname : dest));
      if (!res || !res.file) {
        ERR(
          'vercel.json',
          lineFor(dest),
          `vercel-${kind}-destination`,
          `${kind} "${e.source}" -> "${dest}" does not resolve to a file in the repo`,
        );
      }
    }
  };
  check('rewrite', cfg.rewrites);
  check('redirect', cfg.redirects);
  if (allFiles.has('_redirects')) {
    WARN(
      '_redirects',
      null,
      'hosting-config',
      'both vercel.json and the legacy Netlify _redirects file exist — _redirects is dead weight on Vercel; delete it to avoid drift',
    );
  }
}

/* ------------------------------------------- accounts model guardrails ---- */
/**
 * Four checks added with the accounts and billing build (2026-09-11 decision,
 * docs/private/ACCOUNTS_BILLING_DESIGN.md section 15, task 12).
 *
 *  1. `data-open-timer` is a safety feature, not a config knob: it runs the
 *     timer for anyone, forever. It belongs on the two crisis pages only, and
 *     must be present there.
 *  2. No provider is named in api/ or js/ outside the seam (the adapters, the
 *     env registry, js/config.js and js/checkout.js), so one env var can swap
 *     the payment rail. And no trace of a second plan: one plan, no switch.
 *  3. The "no account / free forever" promises that were true before accounts
 *     existed must not come back. A short allowlist covers the sentences that
 *     are still true (the first three sessions).
 *  4. Gated timer pages keep `isAccessibleForFree: true`; the prose is never
 *     paywalled, so paywall structured data would be a false signal.
 */
const OPEN_TIMER_ALLOWED = new Set([
  'breathing-exercises-anxiety.html',
  'breathing-exercises-for-panic-attacks.html',
]);
const OPEN_TIMER_REQUIRED = ['breathing-exercises-anxiety.html', 'breathing-exercises-for-panic-attacks.html'];
const PROVIDER_SEAM = ['api/_lib/providers/', 'api/_lib/env.js', 'js/config.js', 'js/checkout.js'];
const PROVIDER_RE = /\b(paddle|fastspring|stripe)\b/gi;
/** Owner decision 2026-09-12: one plan, no practitioner or therapist plan, no switch for one. */
const SECOND_PLAN_RE = /practitioner_yearly|MOR_PRICE_PRACTITIONER|practitionerPlanOffered|PLAN_MODE/g;
const COPY_TRUTH_HARD = [
  { re: /free forever/gi, label: 'free forever' },
  { re: /always free/gi, label: 'always free' },
  { re: /no sign-?ups?\b(?!\s+form)/gi, label: 'no sign-up' },
];
const NO_ACCOUNT_RE = /\bno account\b/gi;
/** Sentences that are still true after accounts exist. Tested against ~120 chars around the match. */
const NO_ACCOUNT_ALLOW = [
  /(first|three|3)\b[^.]{0,80}sessions?[^.]{0,60}no account/i,
  /no account (is )?(needed|required) for the first/i,
  /(without|with) (an? )?account/i,
  /no account manager/i,
  /about having no account/i,
  /no account,? (no client record|no database)/i,
];

/**
 * google-tag / ads-conversion (2026-09-15): every page that carries the GA4
 * config must carry the Google Ads config and the ads_data_redaction flag in
 * the same head block (docs/PAGE_CONTRACT.md §1), and the Purchase conversion
 * label may appear on /pro/thanks and nowhere else.
 */
const GA_ID = 'G-TYLYLJSFHN';
const ADS_ID = 'AW-18182683015';
const ADS_CONVERSION_LABEL = 'AW-18182683015/HePwCKi-7PgcEIfzlt5D';
const ADS_CONVERSION_PAGE = 'pro/thanks.html';

function checkGoogleTag() {
  for (const page of [...pages.values()].sort((a, b) => a.file.localeCompare(b.file))) {
    const raw = readText(page.file);
    if (raw == null) continue;
    const lineOf = makeLineLookup(raw);
    const gaAt = raw.indexOf(`gtag('config', '${GA_ID}'`);
    const adsAt = raw.indexOf(`gtag('config', '${ADS_ID}'`);
    if (gaAt >= 0 && adsAt < 0) {
      ERR(page.file, lineOf(gaAt), 'google-tag', `configures ${GA_ID} without ${ADS_ID}; the head block in docs/PAGE_CONTRACT.md carries both`);
    }
    if (adsAt >= 0 && gaAt < 0) {
      ERR(page.file, lineOf(adsAt), 'google-tag', `configures ${ADS_ID} without ${GA_ID}`);
    }
    if (gaAt >= 0 && !raw.includes("gtag('set', 'ads_data_redaction', true)")) {
      ERR(page.file, lineOf(gaAt), 'google-tag', "the head block must set ads_data_redaction before gtag('config', …)");
    }
    if (gaAt >= 0 && adsAt >= 0 && adsAt < gaAt) {
      ERR(page.file, lineOf(adsAt), 'google-tag', `${ADS_ID} must be configured after ${GA_ID}, as the contract block does`);
    }
    const labelAt = raw.indexOf(ADS_CONVERSION_LABEL);
    if (labelAt >= 0 && page.file !== ADS_CONVERSION_PAGE) {
      ERR(page.file, lineOf(labelAt), 'ads-conversion', `the Purchase conversion fires on ${ADS_CONVERSION_PAGE} only`);
    }
    if (page.file === ADS_CONVERSION_PAGE && labelAt < 0) {
      ERR(page.file, null, 'ads-conversion', `must report the Purchase conversion (${ADS_CONVERSION_LABEL})`);
    }
  }
}

function checkAccountsModel() {
  // 1. data-open-timer
  for (const page of pages.values()) {
    const body = page.tags.find((t) => !t.closing && t.name === 'body');
    const has = !!(body && body.attrNode('data-open-timer'));
    if (has && !OPEN_TIMER_ALLOWED.has(page.file)) {
      ERR(
        page.file,
        body.line,
        'open-timer-allowlist',
        'data-open-timer runs the timer for anyone, forever; it is allowed only on the two crisis pages',
      );
    }
  }
  for (const file of OPEN_TIMER_REQUIRED) {
    const page = pages.get(file);
    if (!page) continue;
    const body = page.tags.find((t) => !t.closing && t.name === 'body');
    if (!body || !body.attrNode('data-open-timer')) {
      ERR(file, body ? body.line : null, 'open-timer-missing', 'a crisis page must carry data-open-timer="true" on <body> so the timer runs without an account');
    }
  }

  // 2. provider names outside the seam
  for (const file of [...allFiles].filter((f) => /^(api|js)\/.*\.js$/.test(f)).sort()) {
    if (PROVIDER_SEAM.some((seam) => file.startsWith(seam))) continue;
    const raw = readText(file);
    if (raw == null) continue;
    const lineOf = makeLineLookup(raw);
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
    PROVIDER_RE.lastIndex = 0;
    let m;
    while ((m = PROVIDER_RE.exec(code)) !== null) {
      ERR(file, lineOf(m.index), 'provider-outside-seam', `"${m[0]}" named outside the provider seam; go through api/_lib/providers/ or js/config.js`);
    }
  }
  for (const file of [...allFiles].filter((f) => /^(api|js)\/.*\.js$/.test(f)).sort()) {
    const raw = readText(file);
    if (raw == null) continue;
    const lineOf = makeLineLookup(raw);
    SECOND_PLAN_RE.lastIndex = 0;
    let m;
    while ((m = SECOND_PLAN_RE.exec(raw)) !== null) {
      ERR(file, lineOf(m.index), 'second-plan', `"${m[0]}": there is one plan and no switch for a second (owner decision 2026-09-12)`);
    }
  }

  // 3. copy truth
  for (const page of pages.values()) {
    const spans = [];
    for (const t of page.texts) spans.push({ text: t.text, index: t.index, where: 'text' });
    for (const tag of page.tags) {
      if (tag.closing || tag.name !== 'meta') continue;
      const content = tag.attrNode('content');
      if (content && content.hasValue) spans.push({ text: content.value, index: content.valueIndex, where: 'meta content' });
    }
    for (const raw of page.rawText) {
      const type = (raw.attrs?.find((a) => a.name === 'type')?.decoded || '').toLowerCase();
      if (raw.name === 'title') spans.push({ text: raw.text, index: raw.index, where: 'title' });
      if (raw.name === 'script' && type === 'application/ld+json') spans.push({ text: raw.text, index: raw.index, where: 'JSON-LD' });
    }
    for (const span of spans) {
      for (const { re, label } of COPY_TRUTH_HARD) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(span.text)) !== null) {
          ERR(page.file, page.lineOf(span.index + m.index), 'copy-truth', `"${label}" is no longer true now that accounts exist (${span.where}): "${snippet(span.text, m.index)}"`);
        }
      }
      NO_ACCOUNT_RE.lastIndex = 0;
      let m;
      while ((m = NO_ACCOUNT_RE.exec(span.text)) !== null) {
        const around = span.text.slice(Math.max(0, m.index - 120), m.index + 60);
        if (NO_ACCOUNT_ALLOW.some((re) => re.test(around))) continue;
        ERR(page.file, page.lineOf(span.index + m.index), 'copy-truth', `"no account" claim needs qualifying (${span.where}): "${snippet(span.text, m.index)}"`);
      }
    }
  }

  // 4. paywall structured data
  for (const page of pages.values()) {
    for (const raw of page.rawText) {
      const type = (raw.attrs?.find((a) => a.name === 'type')?.decoded || '').toLowerCase();
      if (raw.name !== 'script' || type !== 'application/ld+json') continue;
      const m = /"isAccessibleForFree"\s*:\s*false/.exec(raw.text);
      if (m) {
        ERR(page.file, page.lineOf(raw.index + m.index), 'paywall-markup', 'isAccessibleForFree:false marks the prose as paywalled; only the interactive timer is gated (design section 8.4)');
      }
      if (/"cssSelector"/.test(raw.text) && /"hasPart"/.test(raw.text)) {
        ERR(page.file, page.lineOf(raw.index), 'paywall-markup', 'hasPart/cssSelector paywall markup is not allowed (design section 8.4)');
      }
    }
  }
}

/* ------------------------------------------------------- CSP origins ------ */
/**
 * The site-wide Content-Security-Policy in vercel.json is report-only, and
 * docs/private/KNOWN_GAPS.md lists promoting it to enforcing as deferred. The
 * day it is promoted, every origin a page or its scripts touch must already be
 * allowed by the directive that governs that kind of fetch, or the browser
 * drops the request silently and the timer goes down with it.
 *
 * This rule is the static half of that promotion check. It parses each
 * Content-Security-Policy / Content-Security-Policy-Report-Only header for the
 * "/(.*)" source into directives, then walks every page the checker already
 * walks plus the JavaScript those pages load (static and dynamic imports
 * followed transitively, inline <script> bodies included) and the stylesheets
 * they link, collecting every absolute URL by the directive that would govern
 * it:
 *
 *   <script src>, <link rel=modulepreload>, import()/import from, and a
 *   script element's .src assignment           -> script-src
 *   <link rel=stylesheet>, <link rel=preload as=style>, CSS @import
 *                                              -> style-src
 *   <link rel=preload as=font>, @font-face url(), fonts.gstatic.com
 *                                              -> font-src
 *   <img src/srcset>, <source srcset>, <video poster>, icons, CSS url()
 *                                              -> img-src
 *   <video/audio/source/track src>              -> media-src
 *   <iframe src>                                -> frame-src
 *   <embed src>, <object data>                  -> object-src
 *   <link rel=manifest>                         -> manifest-src
 *   <form action>, formaction=                  -> form-action
 *   fetch(), XMLHttpRequest.open(), EventSource, WebSocket, sendBeacon
 *                                              -> connect-src
 *   new Worker(), serviceWorker.register()      -> worker-src
 *   <link rel=preconnect>                       -> the directive the page uses
 *                                                 that origin for, else
 *                                                 style-src (fonts.gstatic.com:
 *                                                 font-src)
 *
 * Matching honours 'self' (the --base host), 'none', '*', scheme-only sources
 * (https:, wss:, data:), wildcard subdomains (https://*.paddle.com matches
 * a.paddle.com, not paddle.com), ports and path prefixes, and the CSP3
 * fallback chain (frame-src -> child-src -> default-src; form-action has no
 * fallback). Plain <a href> links and prose are never fetched by the page and
 * are never collected. api/ and tools/ are not scanned.
 *
 * Deliberately not modelled: URLs assembled at runtime (the Supabase project
 * URL from js/config.js, Paddle's own sub-requests, gtag/AdSense beacons and
 * frames). The report-only telemetry is the only evidence for those.
 */
const CSP_SOURCE_PATTERN = '/(.*)';
const CSP_HEADER_KEYS = new Set(['content-security-policy', 'content-security-policy-report-only']);
/** CSP3 fallback order for each fetch kind this rule collects. */
const CSP_FALLBACK = {
  'script-src': ['script-src-elem', 'script-src', 'default-src'],
  'style-src': ['style-src-elem', 'style-src', 'default-src'],
  'font-src': ['font-src', 'default-src'],
  'img-src': ['img-src', 'default-src'],
  'media-src': ['media-src', 'default-src'],
  'connect-src': ['connect-src', 'default-src'],
  'frame-src': ['frame-src', 'child-src', 'default-src'],
  'worker-src': ['worker-src', 'child-src', 'script-src', 'default-src'],
  'object-src': ['object-src', 'default-src'],
  'manifest-src': ['manifest-src', 'default-src'],
  'form-action': ['form-action'],
  'base-uri': ['base-uri'],
};
const CSP_DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' };
const CSP_HOST_SOURCE_RE = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d+|\*))?(\/\S*)?$/;
/** Directories never scanned for CSP origins: serverless code and the tooling. */
const CSP_SKIP_PREFIXES = ['api/', 'tools/'];
const CSP_HTTP_VERBS = /^(get|post|put|patch|delete|head|options)$/i;

/** Every CSP header for the site-wide source in vercel.json. */
function loadCspHeaders() {
  if (!allFiles.has('vercel.json')) return [];
  const raw = readText('vercel.json');
  if (raw == null) return [];
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return []; // already reported at load time
  }
  const lineOf = makeLineLookup(raw);
  const out = [];
  for (const entry of Array.isArray(cfg.headers) ? cfg.headers : []) {
    if (!entry || entry.source !== CSP_SOURCE_PATTERN) continue;
    for (const h of Array.isArray(entry.headers) ? entry.headers : []) {
      if (!h || typeof h.key !== 'string' || typeof h.value !== 'string') continue;
      if (!CSP_HEADER_KEYS.has(h.key.toLowerCase())) continue;
      const idx = raw.indexOf(h.value) !== -1 ? raw.indexOf(h.value) : raw.indexOf(h.key);
      out.push({
        name: h.key,
        value: h.value,
        source: entry.source,
        line: idx === -1 ? null : lineOf(idx),
        policy: parseCsp(h.value),
      });
    }
  }
  return out;
}

/** "a b; c d" -> Map { a => [b], c => [d] }. A repeated directive is ignored, as browsers do. */
function parseCsp(value) {
  const directives = new Map();
  for (const part of String(value).split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const name = tokens[0].toLowerCase();
    if (!directives.has(name)) directives.set(name, tokens.slice(1));
  }
  return directives;
}

/** The directive that governs a fetch of this kind after fallback, or null when the policy leaves it unrestricted. */
function cspGoverning(policy, directive) {
  for (const name of CSP_FALLBACK[directive] || [directive]) {
    if (policy.has(name)) return { name, sources: policy.get(name) };
  }
  return null;
}

/** CSP3 scheme-part matching: http also covers https, ws covers wss/http/https, wss covers https. */
function cspSchemeMatches(source, actual) {
  if (source === actual) return true;
  if (source === 'http') return actual === 'https';
  if (source === 'ws') return actual === 'wss' || actual === 'http' || actual === 'https';
  if (source === 'wss') return actual === 'https';
  return false;
}

function cspIsSelf(u) {
  if (u.hostname.toLowerCase() !== BASE_HOST.replace(/:\d+$/, '')) return false;
  const scheme = u.protocol.slice(0, -1);
  if (scheme !== 'https' && scheme !== 'wss') return false;
  return !u.port || u.port === CSP_DEFAULT_PORTS[u.protocol];
}

/** Does one source expression allow this URL? */
function cspSourceAllows(source, u) {
  const s = source.toLowerCase();
  const scheme = u.protocol.slice(0, -1);
  if (s === "'none'") return false;
  if (s === "'self'") return cspIsSelf(u);
  if (s.startsWith("'")) return false; // 'unsafe-inline', 'strict-dynamic', nonces, hashes: not host sources
  if (s === '*') return scheme !== 'data' && scheme !== 'blob' && scheme !== 'filesystem';
  const schemeOnly = /^([a-z][a-z0-9+.-]*):$/.exec(s);
  if (schemeOnly) return cspSchemeMatches(schemeOnly[1], scheme);
  const m = CSP_HOST_SOURCE_RE.exec(s);
  if (!m) return false;
  const [, srcScheme, hostPattern, port, pathPart] = m;
  if (srcScheme) {
    if (!cspSchemeMatches(srcScheme, scheme)) return false;
  } else if (!cspSchemeMatches('https', scheme)) {
    return false; // a schemeless host-source takes the page's scheme, and the site is https
  }
  const host = u.hostname.toLowerCase();
  if (hostPattern === '*') {
    /* any host */
  } else if (hostPattern.startsWith('*.')) {
    const suffix = hostPattern.slice(1); // ".paddle.com"
    if (!host.endsWith(suffix) || host.length <= suffix.length) return false;
  } else if (host !== hostPattern) {
    return false;
  }
  const actualPort = u.port || CSP_DEFAULT_PORTS[u.protocol] || '';
  if (port) {
    if (port !== '*' && port !== actualPort) return false;
  } else if (u.port && u.port !== CSP_DEFAULT_PORTS[u.protocol]) {
    return false;
  }
  if (pathPart && pathPart !== '/') {
    if (pathPart.endsWith('/')) {
      if (!u.pathname.toLowerCase().startsWith(pathPart)) return false;
    } else if (u.pathname.toLowerCase() !== pathPart) {
      return false;
    }
  }
  return true;
}

/** Absolute network/data URL or null: relative paths, fragments, mailto:, javascript: and templates are not origins. */
function cspUrlOf(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.includes('{') || value.includes('}')) return null;
  const s = value.startsWith('//') ? 'https:' + value : value;
  if (!/^(https?|wss?|data|blob):/i.test(s)) return null;
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

function cspOriginOf(u) {
  return u.protocol === 'data:' || u.protocol === 'blob:' ? u.protocol : `${u.protocol}//${u.host}`;
}

/**
 * Light JavaScript scan. Returns two same-length views of the source: `code`
 * with comments blanked, and `bare` with comments, string bodies, template
 * bodies and regex bodies blanked too (quotes kept). Call sites are located in
 * `bare`, so a "fetch(" inside a string is not a call; their arguments are
 * read back from `code` at the same offsets. Newlines are preserved, so an
 * index in either view maps to a line in the original.
 */
function cspScanJs(src) {
  const code = src.split('');
  const bare = src.split('');
  const n = src.length;
  const blank = (arr, from, to) => {
    for (let k = from; k < to && k < n; k++) if (arr[k] !== '\n') arr[k] = ' ';
  };
  const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]/;
  const REGEX_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

  const skipString = (i, quote) => {
    let j = i + 1;
    while (j < n && src[j] !== quote && src[j] !== '\n') {
      if (src[j] === '\\') j++;
      j++;
    }
    blank(bare, i + 1, j);
    return Math.min(j + 1, n);
  };
  const skipTemplate = (i) => {
    let j = i + 1;
    while (j < n) {
      const ch = src[j];
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '`') break;
      if (ch === '$' && src[j + 1] === '{') {
        let depth = 1;
        j += 2;
        while (j < n && depth > 0) {
          const c = src[j];
          if (c === '{') depth++;
          else if (c === '}') depth--;
          else if (c === '"' || c === "'") {
            j = skipString(j, c);
            continue;
          } else if (c === '`') {
            j = skipTemplate(j);
            continue;
          }
          j++;
        }
        continue;
      }
      j++;
    }
    blank(bare, i + 1, j);
    return Math.min(j + 1, n);
  };
  const regexAhead = (i) => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(src[k])) k--;
    if (k < 0) return true;
    if (REGEX_BEFORE.test(src[k])) return true;
    if (/[\w$]/.test(src[k])) {
      let w = k;
      while (w >= 0 && /[\w$]/.test(src[w])) w--;
      return REGEX_WORDS.has(src.slice(w + 1, k + 1));
    }
    return false;
  };

  let i = 0;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(code, i, stop);
      blank(bare, i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(code, i, stop);
      blank(bare, i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(i, ch);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(i);
      continue;
    }
    if (ch === '/' && regexAhead(i)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        const c = src[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        j++;
      }
      blank(bare, i + 1, j);
      i = Math.min(j + 1, n);
      continue;
    }
    i++;
  }
  return { code: code.join(''), bare: bare.join('') };
}

/** The simple argument (string, template, identifier) starting at `p` in `bare`, or null. */
function cspJsArgAt(js, p) {
  const { code, bare } = js;
  while (p < bare.length && /\s/.test(bare[p])) p++;
  const ch = bare[p];
  if (ch === '"' || ch === "'" || ch === '`') {
    const end = bare.indexOf(ch, p + 1);
    if (end === -1) return null;
    return { kind: ch === '`' ? 'template' : 'string', value: code.slice(p + 1, end), index: p + 1, end: end + 1 };
  }
  const m = /^[A-Za-z_$][\w$]*/.exec(bare.slice(p, p + 200));
  if (m) return { kind: 'ident', value: m[0], index: p, end: p + m[0].length };
  return null;
}

/** Up to `count` simple arguments of a call whose "(" ends at `p`; stops at the first argument it cannot read. */
function cspJsArgsAt(js, p, count) {
  const args = [];
  let pos = p;
  for (let k = 0; k < count; k++) {
    const arg = cspJsArgAt(js, pos);
    if (!arg) break;
    args.push(arg);
    pos = arg.end;
    while (pos < js.bare.length && /\s/.test(js.bare[pos])) pos++;
    if (js.bare[pos] !== ',') break;
    pos++;
  }
  return args;
}

/**
 * Turn a call argument into a URL: a string literal directly, a template
 * literal by its static prefix (only when that prefix carries the whole host),
 * an identifier via a `const NAME = '...'` in the same source. `index` is the
 * call site, so a finding points at the line that does the loading, not at
 * the constant it reads.
 */
function cspJsArgUrl(js, arg) {
  const resolved = cspJsArgValue(js, arg, 0);
  return resolved ? { ...resolved, index: arg.index } : null;
}

function cspJsArgValue(js, arg, depth) {
  if (!arg || depth > 3) return null;
  if (arg.kind === 'string') return { url: cspUrlOf(arg.value), spec: arg.value };
  if (arg.kind === 'template') {
    const prefix = arg.value.split('${')[0];
    if (arg.value.includes('${') && !/^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+[/?#]/i.test(prefix)) {
      return { url: null, spec: null };
    }
    return { url: cspUrlOf(prefix), spec: arg.value.includes('${') ? null : arg.value };
  }
  const re = new RegExp(`(?:^|[^\\w$.])(?:const|let|var)\\s+${arg.value.replace(/\$/g, '\\$')}\\s*=`, 'g');
  const m = re.exec(js.bare);
  if (!m) return null;
  return cspJsArgValue(js, cspJsArgAt(js, m.index + m[0].length), depth + 1);
}

/**
 * Collect CSP-relevant references from JavaScript source.
 * @param {string} src
 * @param {{file:string, lineOf:(i:number)=>number, basePath:string}} ctx
 * @returns {{refs:any[], follow:string[]}} refs by directive; same-origin scripts to scan next
 */
function cspCollectFromJs(src, ctx) {
  const js = cspScanJs(src);
  const { bare } = js;
  const refs = [];
  const follow = [];

  const note = (via, resolved, directive) => {
    if (!resolved || !resolved.url) return;
    refs.push({
      file: ctx.file,
      line: ctx.lineOf(resolved.index),
      via,
      directive,
      u: resolved.url,
      url: resolved.url.href,
      origin: cspOriginOf(resolved.url),
    });
  };
  const followOrNote = (via, resolved) => {
    if (!resolved) return;
    if (resolved.url) {
      note(via, resolved, 'script-src');
      return;
    }
    if (!resolved.spec || cspUrlOf(resolved.spec)) return;
    const target = resolveUrl(resolveAgainst(ctx.basePath, resolved.spec));
    if (target && target.file && /\.m?js$/i.test(target.file)) follow.push(target.file);
  };

  // Static imports and re-exports: import x from 'spec' / import 'spec' / export { x } from 'spec'.
  const staticRe = /(?:^|[^\w$.])(import|export)(?=[\s{*'"])/g;
  let m;
  while ((m = staticRe.exec(bare)) !== null) {
    let p = m.index + m[0].length;
    while (p < bare.length && /\s/.test(bare[p])) p++;
    let quoteAt = -1;
    if (bare[p] === '"' || bare[p] === "'") {
      if (m[1] === 'import') quoteAt = p;
    } else {
      const q = bare.slice(p).search(/['"]/);
      if (q !== -1 && /\bfrom\s*$/.test(bare.slice(p, p + q))) quoteAt = p + q;
    }
    if (quoteAt === -1) continue;
    followOrNote(m[1] === 'import' ? 'import from' : 'export from', cspJsArgUrl(js, cspJsArgAt(js, quoteAt)));
  }

  const calls = [
    { re: /(?:^|[^\w$.])import\s*\(/g, via: 'import()', follow: true },
    { re: /(?:^|[^\w$.]|(?:window|globalThis|self)\.)fetch\s*\(/g, via: 'fetch()', directive: 'connect-src' },
    { re: /navigator\.sendBeacon\s*\(/g, via: 'navigator.sendBeacon()', directive: 'connect-src' },
    { re: /new\s+EventSource\s*\(/g, via: 'new EventSource()', directive: 'connect-src' },
    { re: /new\s+WebSocket\s*\(/g, via: 'new WebSocket()', directive: 'connect-src' },
    { re: /new\s+(?:Shared)?Worker\s*\(/g, via: 'new Worker()', directive: 'worker-src' },
    { re: /serviceWorker\.register\s*\(/g, via: 'serviceWorker.register()', directive: 'worker-src', followWorker: true },
  ];
  for (const call of calls) {
    call.re.lastIndex = 0;
    while ((m = call.re.exec(bare)) !== null) {
      const resolved = cspJsArgUrl(js, cspJsArgAt(js, m.index + m[0].length));
      if (call.follow) followOrNote(call.via, resolved);
      else if (call.followWorker) {
        if (resolved && resolved.url) note(call.via, resolved, call.directive);
        else if (resolved && resolved.spec) {
          const target = resolveUrl(resolveAgainst(ctx.basePath, resolved.spec));
          if (target && target.file && /\.m?js$/i.test(target.file)) follow.push(target.file);
        }
      } else note(call.via, resolved, call.directive);
    }
  }

  // XMLHttpRequest: xhr.open(method, url). window.open(url, '_blank') never yields an absolute second argument.
  const openRe = /\.open\s*\(/g;
  while ((m = openRe.exec(bare)) !== null) {
    const args = cspJsArgsAt(js, m.index + m[0].length, 2);
    if (args.length < 2) continue;
    if (args[0].kind === 'string' && !CSP_HTTP_VERBS.test(args[0].value)) continue;
    if (args[0].kind === 'template') continue;
    note('XMLHttpRequest.open()', cspJsArgUrl(js, args[1]), 'connect-src');
  }

  // Script elements built in code: const s = document.createElement('script'); s.src = URL;
  const createRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$.]*\s*\|\|\s*)?document\.createElement\s*\(/g;
  while ((m = createRe.exec(bare)) !== null) {
    const tagArg = cspJsArgAt(js, m.index + m[0].length);
    if (!tagArg || tagArg.kind !== 'string' || tagArg.value.toLowerCase() !== 'script') continue;
    const name = m[1].replace(/\$/g, '\\$');
    const srcRe = new RegExp(`(?:^|[^\\w$.])${name}\\.src\\s*=(?!=)`, 'g');
    let s;
    while ((s = srcRe.exec(bare)) !== null) {
      note(`${m[1]}.src =`, cspJsArgUrl(js, cspJsArgAt(js, s.index + s[0].length)), 'script-src');
    }
    const setRe = new RegExp(`(?:^|[^\\w$.])${name}\\.setAttribute\\s*\\(`, 'g');
    while ((s = setRe.exec(bare)) !== null) {
      const args = cspJsArgsAt(js, s.index + s[0].length, 2);
      if (args.length === 2 && args[0].kind === 'string' && args[0].value.toLowerCase() === 'src') {
        note(`${m[1]}.setAttribute('src')`, cspJsArgUrl(js, args[1]), 'script-src');
      }
    }
  }

  return { refs, follow };
}

/** Collect CSP-relevant references from CSS text: @import -> style-src, @font-face url() -> font-src, other url() -> img-src. */
function cspCollectFromCss(cssText, ctx) {
  const refs = [];
  const css = cssText.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const note = (via, value, index, directive) => {
    const u = cspUrlOf(value);
    if (!u) return;
    refs.push({ file: ctx.file, line: ctx.lineOf(index), via, directive, u, url: u.href, origin: cspOriginOf(u) });
  };
  const importRe = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1/g;
  let m;
  while ((m = importRe.exec(css)) !== null) note('@import', m[2], m.index, 'style-src');
  const fontFaceRanges = [];
  const faceRe = /@font-face\s*\{[^}]*\}/g;
  while ((m = faceRe.exec(css)) !== null) fontFaceRanges.push([m.index, m.index + m[0].length]);
  const urlRe = /url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g;
  while ((m = urlRe.exec(css)) !== null) {
    if (/@import\s*$/.test(css.slice(Math.max(0, m.index - 12), m.index))) continue;
    const inFace = fontFaceRanges.some(([a, b]) => m.index >= a && m.index < b);
    note(inFace ? '@font-face url()' : 'url()', m[2], m.index, inFace ? 'font-src' : 'img-src');
  }
  return refs;
}

function cspSkipped(file) {
  return CSP_SKIP_PREFIXES.some((p) => file.startsWith(p));
}

function checkCspOrigins() {
  const headers = loadCspHeaders();
  if (!headers.length) {
    INFO(
      'vercel.json',
      null,
      'csp-origins',
      `no Content-Security-Policy or Content-Security-Policy-Report-Only header for "${CSP_SOURCE_PATTERN}" — nothing to check`,
    );
    return;
  }

  /** file -> {refs, follow}; each script and stylesheet is scanned once. */
  const scriptCache = new Map();
  const cssCache = new Map();
  const scanScript = (file) => {
    if (!scriptCache.has(file)) {
      const raw = readText(file);
      scriptCache.set(
        file,
        raw == null ? { refs: [], follow: [] } : cspCollectFromJs(raw, { file, lineOf: makeLineLookup(raw), basePath: '/' + file }),
      );
    }
    return scriptCache.get(file);
  };
  const scanCss = (file) => {
    if (!cssCache.has(file)) {
      const raw = readText(file);
      cssCache.set(file, raw == null ? [] : cspCollectFromCss(raw, { file, lineOf: makeLineLookup(raw) }));
    }
    return cssCache.get(file);
  };

  const allRefs = [];
  for (const page of pages.values()) {
    if (cspSkipped(page.file)) continue;
    const basePath = page.primaryPath || '/' + page.file;
    const pageRefs = [];
    const preconnects = [];
    const scripts = new Set();
    const sheets = new Set();

    const note = (tag, attrName, value, directive, via) => {
      const attr = tag.attrNode(attrName);
      const u = cspUrlOf(value);
      if (!u) return;
      pageRefs.push({
        file: page.file,
        line: attr ? page.lineOf(attr.valueIndex) : tag.line,
        via: via || `<${tag.name} ${attrName}>`,
        directive,
        u,
        url: u.href,
        origin: cspOriginOf(u),
      });
    };
    const localFile = (value) => {
      const cls = classifyUrl(value);
      if (cls.kind !== 'internal') return null;
      const res = resolveUrl(resolveAgainst(basePath, (cls.path || '/').split('#')[0] || '/'));
      return res && res.file ? res.file : null;
    };
    const srcsetValues = (attr) => attr.decoded.split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);

    for (const tag of page.tags) {
      if (tag.closing) continue;
      const name = tag.name;
      if (name === 'script') {
        const type = (tag.attr('type') || '').trim().toLowerCase();
        const src = tag.attr('src');
        if (src && (!type || type === 'module' || type === 'text/javascript' || type === 'application/javascript')) {
          note(tag, 'src', src, 'script-src');
          const local = localFile(src);
          if (local && /\.m?js$/i.test(local)) scripts.add(local);
        }
      } else if (name === 'link') {
        const rels = (tag.attr('rel') || '').toLowerCase().split(/\s+/).filter(Boolean);
        const href = tag.attr('href');
        if (!href) continue;
        const as = (tag.attr('as') || '').trim().toLowerCase();
        if (rels.includes('stylesheet') || (rels.includes('preload') && as === 'style')) {
          note(tag, 'href', href, 'style-src', `<link rel="${rels.includes('stylesheet') ? 'stylesheet' : 'preload'}"${as ? ` as="${as}"` : ''}>`);
          const local = localFile(href);
          if (local && /\.css$/i.test(local)) sheets.add(local);
        } else if (rels.includes('modulepreload') || (rels.includes('preload') && as === 'script')) {
          note(tag, 'href', href, 'script-src', `<link rel="${rels.includes('modulepreload') ? 'modulepreload' : 'preload'}">`);
          const local = localFile(href);
          if (local && /\.m?js$/i.test(local)) scripts.add(local);
        } else if (rels.includes('preload') && as) {
          const map = { font: 'font-src', image: 'img-src', fetch: 'connect-src', audio: 'media-src', video: 'media-src', track: 'media-src', worker: 'worker-src', object: 'object-src' };
          if (map[as]) note(tag, 'href', href, map[as], `<link rel="preload" as="${as}">`);
        } else if (rels.includes('preconnect') || rels.includes('dns-prefetch')) {
          const u = cspUrlOf(href);
          if (u) {
            const attr = tag.attrNode('href');
            preconnects.push({
              file: page.file,
              line: attr ? page.lineOf(attr.valueIndex) : tag.line,
              via: `<link rel="${rels.includes('preconnect') ? 'preconnect' : 'dns-prefetch'}">`,
              u,
              url: u.href,
              origin: cspOriginOf(u),
            });
          }
        } else if (rels.some((r) => /icon$/.test(r) || r === 'apple-touch-icon-precomposed')) {
          note(tag, 'href', href, 'img-src', `<link rel="${rels.join(' ')}">`);
        } else if (rels.includes('manifest')) {
          note(tag, 'href', href, 'manifest-src', '<link rel="manifest">');
        }
      } else if (name === 'iframe' || name === 'frame') {
        if (tag.attr('src')) note(tag, 'src', tag.attr('src'), 'frame-src');
      } else if (name === 'embed') {
        if (tag.attr('src')) note(tag, 'src', tag.attr('src'), 'object-src');
      } else if (name === 'object') {
        if (tag.attr('data')) note(tag, 'data', tag.attr('data'), 'object-src');
      } else if (name === 'img') {
        if (tag.attr('src')) note(tag, 'src', tag.attr('src'), 'img-src');
        const srcset = tag.attrNode('srcset');
        if (srcset) for (const v of srcsetValues(srcset)) note(tag, 'srcset', v, 'img-src');
      } else if (name === 'source') {
        const srcset = tag.attrNode('srcset');
        if (srcset) for (const v of srcsetValues(srcset)) note(tag, 'srcset', v, 'img-src');
        if (tag.attr('src')) note(tag, 'src', tag.attr('src'), 'media-src');
      } else if (name === 'video' || name === 'audio' || name === 'track') {
        if (tag.attr('src')) note(tag, 'src', tag.attr('src'), 'media-src');
        if (name === 'video' && tag.attr('poster')) note(tag, 'poster', tag.attr('poster'), 'img-src');
      } else if (name === 'input') {
        if ((tag.attr('type') || '').toLowerCase() === 'image' && tag.attr('src')) note(tag, 'src', tag.attr('src'), 'img-src');
        if (tag.attr('formaction')) note(tag, 'formaction', tag.attr('formaction'), 'form-action');
      } else if (name === 'button') {
        if (tag.attr('formaction')) note(tag, 'formaction', tag.attr('formaction'), 'form-action');
      } else if (name === 'form') {
        if (tag.attr('action')) note(tag, 'action', tag.attr('action'), 'form-action');
      } else if (name === 'base') {
        if (tag.attr('href')) note(tag, 'href', tag.attr('href'), 'base-uri');
      }
      const style = tag.attrNode('style');
      if (style && style.hasValue && /url\(/i.test(style.decoded)) {
        pageRefs.push(...cspCollectFromCss(style.decoded, { file: page.file, lineOf: () => page.lineOf(style.valueIndex) }).map((r) => ({ ...r, via: `style="${r.via}"` })));
      }
    }

    // Inline <script> bodies (not JSON-LD) and <style> blocks.
    for (const raw of page.rawText) {
      const type = (raw.attrs?.find((a) => a.name === 'type')?.decoded || '').trim().toLowerCase();
      if (raw.name === 'script') {
        if (type && type !== 'module' && type !== 'text/javascript' && type !== 'application/javascript') continue;
        if (raw.attrs?.some((a) => a.name === 'src')) continue; // body of an external script tag is ignored by browsers
        const { refs, follow } = cspCollectFromJs(raw.text, {
          file: page.file,
          lineOf: (i) => page.lineOf(raw.index + i),
          basePath,
        });
        pageRefs.push(...refs.map((r) => ({ ...r, via: `inline <script> ${r.via}` })));
        for (const f of follow) scripts.add(f);
      } else if (raw.name === 'style') {
        pageRefs.push(...cspCollectFromCss(raw.text, { file: page.file, lineOf: (i) => page.lineOf(raw.index + i) }).map((r) => ({ ...r, via: `<style> ${r.via}` })));
      }
    }

    // Follow the module graph the page loads.
    const queue = [...scripts];
    const visited = new Set();
    while (queue.length) {
      const file = queue.shift();
      if (visited.has(file) || cspSkipped(file)) continue;
      visited.add(file);
      const { refs, follow } = scanScript(file);
      pageRefs.push(...refs);
      for (const f of follow) if (!visited.has(f)) queue.push(f);
    }
    for (const file of sheets) {
      if (cspSkipped(file)) continue;
      pageRefs.push(...scanCss(file));
    }

    // A preconnect is checked under whatever directive the page uses that
    // origin for; a preconnect nothing on the page fetches from is a fonts
    // hint (fonts.gstatic.com -> font-src, otherwise style-src).
    const covered = new Map();
    for (const r of pageRefs) {
      if (!covered.has(r.origin)) covered.set(r.origin, new Set());
      covered.get(r.origin).add(r.directive);
    }
    for (const pc of preconnects) {
      const used = covered.get(pc.origin);
      if (used && used.size) continue;
      pageRefs.push({ ...pc, directive: pc.u.hostname.toLowerCase() === 'fonts.gstatic.com' ? 'font-src' : 'style-src' });
    }
    allRefs.push(...pageRefs);
  }

  const origins = new Map(); // origin -> Set(directive), 'self' excluded
  const exercised = new Set();
  for (const ref of allRefs) {
    exercised.add(ref.directive);
    if (cspIsSelf(ref.u)) continue;
    if (!origins.has(ref.origin)) origins.set(ref.origin, new Set());
    origins.get(ref.origin).add(ref.directive);
  }
  const originList = [...origins.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([origin, dirs]) => `${origin} (${[...dirs].sort().join(', ')})`)
    .join(', ');

  for (const header of headers) {
    const seen = new Set();
    for (const ref of allRefs) {
      const gov = cspGoverning(header.policy, ref.directive);
      if (!gov) continue;
      if (gov.sources.some((s) => cspSourceAllows(s, ref.u))) continue;
      const key = `${ref.file}|${ref.line}|${ref.origin}|${ref.directive}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ERR(
        ref.file,
        ref.line,
        'csp-origins',
        `${ref.via} loads ${ref.origin}, which ${ref.directive}` +
          `${gov.name !== ref.directive ? ` (falling back to ${gov.name})` : ''} in the ${header.name} header for "${header.source}" ` +
          `does not allow — an enforcing policy would block "${ref.url}"`,
      );
    }
    INFO(
      'vercel.json',
      header.line,
      'csp-origins',
      `${header.name} for "${header.source}": ${header.policy.size} directive(s) in the policy, ` +
        `${exercised.size} exercised (${[...exercised].sort().join(', ') || 'none'}); ` +
        `${pages.size} page(s), ${scriptCache.size} script(s), ${cssCache.size} stylesheet(s) scanned; ` +
        `${origins.size} external origin(s) found${origins.size ? `: ${originList}` : ''}; ${seen.size} not allowed`,
    );
  }
}

/* ------------------------------------------------------ orphan/extra pages */
function checkOrphans() {
  // Indexable pages nothing on the site links to are dead ends for crawlers.
  const linkTargets = new Set();
  for (const page of pages.values()) {
    for (const tag of page.tags) {
      if (tag.closing || tag.name !== 'a') continue;
      const href = tag.attr('href');
      if (!href) continue;
      const cls = classifyUrl(href);
      if (cls.kind !== 'internal') continue;
      const res = resolveUrl(resolveAgainst(page.primaryPath || '/' + page.file, cls.path.split('#')[0] || '/'));
      if (res && res.file && res.file !== page.file) linkTargets.add(res.file);
    }
  }
  for (const page of indexablePages) {
    if (page.primaryPath === '/') continue; // the homepage is reachable by definition
    if (!linkTargets.has(page.file)) {
      WARN(page.file, null, 'page-orphan', 'indexable page is not linked from any other page (orphan)');
    }
  }
  if (externalHosts.size) {
    const list = [...externalHosts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([host, n]) => `${host} (${n})`)
      .join(', ');
    INFO(null, null, 'external-hosts', `outbound hosts referenced: ${list}`);
  }
}

try {
  checkSitemap();
} catch (e) {
  ERR('sitemap.xml', null, 'internal-error', `sitemap check failed: ${e.message}`);
}
try {
  checkRobots();
} catch (e) {
  ERR('robots.txt', null, 'internal-error', `robots check failed: ${e.message}`);
}
try {
  checkManifest();
} catch (e) {
  ERR('manifest.json', null, 'internal-error', `manifest check failed: ${e.message}`);
}
try {
  checkServiceWorker();
} catch (e) {
  ERR('sw.js', null, 'internal-error', `service worker check failed: ${e.message}`);
}
try {
  checkAdsTxt();
} catch (e) {
  ERR('ads.txt', null, 'internal-error', `ads.txt check failed: ${e.message}`);
}
try {
  checkVercelJson();
} catch (e) {
  ERR('vercel.json', null, 'internal-error', `vercel.json check failed: ${e.message}`);
}
try {
  checkClayOnTimer();
} catch (e) {
  ERR(null, null, 'internal-error', `--clay check failed: ${e.message}`);
}
try {
  checkAccountsModel();
  checkGoogleTag();
} catch (e) {
  ERR(null, null, 'internal-error', `accounts-model check failed: ${e.message}`);
}
try {
  checkCspOrigins();
} catch (e) {
  ERR('vercel.json', null, 'internal-error', `csp-origins check failed: ${e.message}`);
}
try {
  checkOrphans();
} catch (e) {
  ERR(null, null, 'internal-error', `reachability check failed: ${e.message}`);
}

/* ======================================================================== *
 * Report
 * ======================================================================== */

const RANK = { ERROR: 0, WARN: 1, INFO: 2 };
findings.sort((a, b) => {
  if (RANK[a.level] !== RANK[b.level]) return RANK[a.level] - RANK[b.level];
  const fa = a.file || '';
  const fb = b.file || '';
  if (fa !== fb) return fa < fb ? -1 : 1;
  return (a.line || 0) - (b.line || 0);
});

const counts = {
  ERROR: findings.filter((f) => f.level === 'ERROR').length,
  WARN: findings.filter((f) => f.level === 'WARN').length,
  INFO: findings.filter((f) => f.level === 'INFO').length,
};

function where(f) {
  if (!f.file) return '(site)';
  return f.line ? `${f.file}:${f.line}` : f.file;
}

function printGroup(level, heading) {
  const items = findings.filter((f) => f.level === level);
  const out = ['', `${heading} (${items.length})`, '-'.repeat(78)];
  if (!items.length) {
    out.push('  none');
    return out.join('\n');
  }
  const width = Math.min(52, Math.max(...items.map((f) => where(f).length)) + 2);
  for (const f of items) {
    out.push(`  ${where(f).padEnd(width)} [${f.rule}] ${f.message}`);
  }
  return out.join('\n');
}

const header = [
  '',
  '='.repeat(78),
  ' site-check — static site QA report',
  '='.repeat(78),
  ` root       : ${ROOT}`,
  ` base URL   : ${BASE}`,
  ` URL model  : ${urlModel.source} (cleanUrls=${urlModel.cleanUrls}, trailingSlash=${urlModel.trailingSlash})`,
  ` html pages : ${htmlFiles.length} (${indexablePages.length} indexable)`,
  ` files      : ${allFiles.size}`,
].join('\n');

process.stdout.write(header + '\n');
process.stdout.write(printGroup('ERROR', 'ERRORS') + '\n');
process.stdout.write(printGroup('WARN', 'WARNINGS') + '\n');
process.stdout.write(printGroup('INFO', 'INFO') + '\n');
process.stdout.write(
  `\n${'='.repeat(78)}\n${htmlFiles.length} pages, ${counts.ERROR} errors, ${counts.WARN} warnings\n${'='.repeat(78)}\n`,
);

if (opts.json) {
  const outPath = path.resolve(opts.json);
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(findings, null, 2) + '\n', 'utf8');
    process.stdout.write(`JSON report written to ${outPath}\n`);
  } catch (e) {
    process.stderr.write(`site-check: could not write JSON report to ${outPath}: ${e.message}\n`);
    process.exit(1);
  }
}

process.exit(counts.ERROR > 0 ? 1 : 0);
