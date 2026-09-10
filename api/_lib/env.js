/**
 * api/_lib/env.js — environment access with loud failure in production and
 * harmless placeholders in development.
 *
 * Nothing in this file may ever return a secret to a caller that will put it in
 * a response body. `describeConfig()` returns booleans only; that is what
 * /api/health serves.
 */

/** Every variable the API knows about, with the one-line meaning kept in .env.example. */
export const KNOWN_VARS = [
  'LICENSE_SECRET',
  'MOR_PROVIDER',
  'MOR_API_KEY',
  'MOR_API_BASE',
  'MOR_WEBHOOK_SECRET',
  'MOR_PRODUCT_LIFETIME',
  'MOR_PRODUCT_MONTHLY',
  'MOR_PRODUCT_PRACTITIONER',
  'MOR_PRODUCT_STUDIO',
  'MOR_PRODUCT_PACK',
  'MOR_API_USERNAME',
  'MOR_API_PASSWORD',
  'EMAIL_PROVIDER',
  'EMAIL_API_KEY',
  'EMAIL_LIST_ID',
  'EMAIL_DOI_TEMPLATE_ID',
  'EMAIL_DOI_REDIRECT_URL',
  'EMAIL_API_BASE',
  'ALLOWED_ORIGINS',
];

/** Development stand-ins. Never valid against a real provider — that is the point. */
export const DEV_DEFAULTS = Object.freeze({
  // 64 characters, obviously fake, so a token minted in dev can never verify in production.
  LICENSE_SECRET: 'dev-license-secret-not-for-production-'.padEnd(64, '0'),
  MOR_PROVIDER: 'paddle',
  EMAIL_PROVIDER: 'brevo',
  EMAIL_LIST_ID: '0',
  EMAIL_DOI_TEMPLATE_ID: '0',
  EMAIL_DOI_REDIRECT_URL: 'https://helpmebreath.com/pro/thanks',
});

/** Thrown by requireEnv() in production. Carries the missing names, never the values. */
export class MissingEnvError extends Error {
  /** @param {string[]} missing */
  constructor(missing) {
    const one = missing.length === 1;
    super(
      `Missing required environment variable${one ? '' : 's'}: ${missing.join(', ')}. ` +
        `Set ${one ? 'it' : 'them'} in the Vercel project settings ` +
        '(Settings -> Environment Variables) and redeploy. See docs/API.md and .env.example.',
    );
    this.name = 'MissingEnvError';
    this.missing = missing.slice();
    this.statusCode = 503;
  }
}

/**
 * True on a production deployment. Vercel sets VERCEL_ENV to
 * production | preview | development; preview deployments are NOT production, so
 * sandbox credentials are allowed there.
 * @returns {boolean}
 */
export function isProduction() {
  const vercelEnv = readRaw('VERCEL_ENV');
  if (vercelEnv) return vercelEnv === 'production';
  return readRaw('NODE_ENV') === 'production';
}

/** The environment label reported by /api/health. */
export function envName() {
  return readRaw('VERCEL_ENV') || readRaw('NODE_ENV') || 'development';
}

function readRaw(name) {
  const source = typeof process !== 'undefined' && process && process.env ? process.env : {};
  const value = source[name];
  if (value == null) return '';
  const trimmed = String(value).trim();
  return trimmed;
}

/**
 * Read one variable. Returns '' when unset or blank.
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function readEnv(name, fallback = '') {
  const value = readRaw(name);
  return value || fallback;
}

/**
 * True when the variable is set to a non-blank value.
 * @param {string} name
 * @returns {boolean}
 */
export function hasEnv(name) {
  return readRaw(name) !== '';
}

/**
 * Require a set of variables.
 *
 * In production a missing variable throws MissingEnvError, which the endpoints
 * turn into a 503 with a message that names the variable but never a value.
 * In development the known defaults are used and anything still missing gets an
 * obvious `dev-missing-<NAME>` placeholder, so a local request fails at the
 * provider with a 401 rather than silently pretending to work.
 *
 * @param {string[]} names
 * @returns {Record<string, string>}
 */
export function requireEnv(names) {
  const wanted = Array.isArray(names) ? names : [names];
  const out = {};
  const missing = [];
  for (const name of wanted) {
    const value = readRaw(name);
    if (value) {
      out[name] = value;
      continue;
    }
    if (isProduction()) {
      missing.push(name);
      continue;
    }
    out[name] = Object.prototype.hasOwnProperty.call(DEV_DEFAULTS, name)
      ? DEV_DEFAULTS[name]
      : `dev-missing-${name}`;
  }
  if (missing.length > 0) throw new MissingEnvError(missing);
  return out;
}

/**
 * The merchant of record in use. One env var switches the whole payment rail.
 * @returns {'paddle'|'fastspring'}
 */
export function providerName() {
  const value = readEnv('MOR_PROVIDER', DEV_DEFAULTS.MOR_PROVIDER).toLowerCase();
  return value === 'fastspring' ? 'fastspring' : 'paddle';
}

/**
 * The email service provider in use.
 * @returns {'brevo'|'mailerlite'}
 */
export function emailProviderName() {
  const value = readEnv('EMAIL_PROVIDER', DEV_DEFAULTS.EMAIL_PROVIDER).toLowerCase();
  return value === 'mailerlite' ? 'mailerlite' : 'brevo';
}

/**
 * Extra origins allowed to call the same-origin endpoints, comma separated.
 * Normally empty: the API and the site share an origin.
 * @returns {string[]}
 */
export function allowedOrigins() {
  return readEnv('ALLOWED_ORIGINS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Booleans only — safe to serve publicly from /api/health.
 * @returns {{provider:string, email:string, env:string, configured:Record<string,boolean>, missing:string[]}}
 */
export function describeConfig() {
  const provider = providerName();
  const email = emailProviderName();

  const configured = {
    license_secret: hasEnv('LICENSE_SECRET'),
    mor_provider: hasEnv('MOR_PROVIDER'),
    mor_api_key: hasEnv('MOR_API_KEY'),
    mor_api_base: hasEnv('MOR_API_BASE'),
    mor_webhook_secret: hasEnv('MOR_WEBHOOK_SECRET'),
    mor_product_lifetime: hasEnv('MOR_PRODUCT_LIFETIME'),
    mor_product_monthly: hasEnv('MOR_PRODUCT_MONTHLY'),
    mor_product_practitioner: hasEnv('MOR_PRODUCT_PRACTITIONER'),
    mor_product_studio: hasEnv('MOR_PRODUCT_STUDIO'),
    mor_product_pack: hasEnv('MOR_PRODUCT_PACK'),
    email_provider: hasEnv('EMAIL_PROVIDER'),
    email_api_key: hasEnv('EMAIL_API_KEY'),
    email_list_id: hasEnv('EMAIL_LIST_ID'),
    email_doi_template_id: hasEnv('EMAIL_DOI_TEMPLATE_ID'),
    email_doi_redirect_url: hasEnv('EMAIL_DOI_REDIRECT_URL'),
  };

  // Which variables a working deployment actually needs, given the two provider choices.
  const required = ['LICENSE_SECRET', 'MOR_API_KEY', 'MOR_PRODUCT_LIFETIME', 'EMAIL_API_KEY', 'EMAIL_LIST_ID'];
  if (email === 'brevo') required.push('EMAIL_DOI_TEMPLATE_ID', 'EMAIL_DOI_REDIRECT_URL');
  const missing = required.filter((name) => !hasEnv(name));

  return { provider, email, env: envName(), configured, missing };
}
