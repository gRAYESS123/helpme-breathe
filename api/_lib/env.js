/**
 * api/_lib/env.js — environment access with loud failure in production and
 * harmless placeholders in development.
 *
 * Nothing in this file may ever return a secret to a caller that will put it in
 * a response body. `describeConfig()` returns booleans only; that is what
 * /api/health serves.
 */

/**
 * Every variable the API knows about, with the one-line meaning kept in
 * .env.example. The accounts and billing build (2026-09-11,
 * docs/private/ACCOUNTS_BILLING_DESIGN.md section 10.2) added the Supabase,
 * pepper, price, cron and alert variables and retired MOR_PRODUCT_*.
 */
export const KNOWN_VARS = [
  // signing
  'LICENSE_SECRET',
  // accounts
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'TRIAL_PEPPER',
  'DEVICE_PEPPER',
  'TRIAL_ENABLED',
  'SITE_ORIGIN',
  // merchant of record
  'MOR_PROVIDER',
  'MOR_API_KEY',
  'MOR_API_BASE',
  'MOR_WEBHOOK_SECRET',
  'MOR_CLIENT_TOKEN',
  'MOR_SANDBOX',
  'MOR_PRICE_MONTHLY_TRIAL',
  'MOR_PRICE_MONTHLY',
  'MOR_PRICE_YEARLY_TRIAL',
  'MOR_PRICE_YEARLY',
  'MOR_STOREFRONT',
  'MOR_API_USERNAME',
  'MOR_API_PASSWORD',
  'MOR_MANAGED_PAYMENTS',
  // jobs and alerts
  'CRON_SECRET',
  'ALERT_EMAIL',
  // email capture (the third-session card) and alert delivery
  'EMAIL_PROVIDER',
  'EMAIL_API_KEY',
  'EMAIL_LIST_ID',
  'EMAIL_FROM',
  'EMAIL_DOI_TEMPLATE_ID',
  'EMAIL_DOI_REDIRECT_URL',
  'EMAIL_API_BASE',
  // CORS
  'ALLOWED_ORIGINS',
];

/** Development stand-ins. Never valid against a real provider — that is the point. */
export const DEV_DEFAULTS = Object.freeze({
  // 64 characters, obviously fake, so a token minted in dev can never verify in production.
  LICENSE_SECRET: 'dev-license-secret-not-for-production-'.padEnd(64, '0'),
  MOR_PROVIDER: 'paddle',
  MOR_SANDBOX: 'true',
  EMAIL_PROVIDER: 'resend',
  EMAIL_LIST_ID: '0',
  EMAIL_DOI_TEMPLATE_ID: '0',
  EMAIL_DOI_REDIRECT_URL: 'https://helpmebreath.com/pro/thanks?confirmed=1',
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
 * The payment rail in use. One env var switches the whole rail. `stripe` is
 * a payment processor, not a merchant of record; the MOR_* names are kept.
 * @returns {'paddle'|'fastspring'|'stripe'}
 */
export function providerName() {
  const value = readEnv('MOR_PROVIDER', DEV_DEFAULTS.MOR_PROVIDER).toLowerCase();
  if (value === 'fastspring' || value === 'stripe') return value;
  return 'paddle';
}

/**
 * The email service provider in use. Unknown values fall back to the default,
 * the same way providerName() does.
 * @returns {'resend'|'brevo'|'mailerlite'}
 */
export function emailProviderName() {
  const value = readEnv('EMAIL_PROVIDER', DEV_DEFAULTS.EMAIL_PROVIDER).toLowerCase();
  if (value === 'brevo' || value === 'mailerlite') return value;
  return 'resend';
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
 *
 * `missing` lists what a WORKING deployment needs: sign-in, the entitlement
 * token, the trial ledger, checkout, webhooks and the two cron jobs. The trial
 * price ids are needed unless TRIAL_ENABLED is literally "false" — that read is
 * for this report only; the product decision is made in api/trial/eligibility.js
 * and nowhere else.
 * @returns {{provider:string, email:string, env:string, sandbox:boolean, managed_payments:boolean|null, configured:Record<string,boolean>, missing:string[]}}
 */
export function describeConfig() {
  const provider = providerName();
  const email = emailProviderName();

  const configured = {};
  for (const name of KNOWN_VARS) configured[name.toLowerCase()] = hasEnv(name);

  const required = [
    'LICENSE_SECRET',
    'SUPABASE_URL',
    'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_SECRET_KEY',
    'TRIAL_PEPPER',
    'DEVICE_PEPPER',
    'SITE_ORIGIN',
    'MOR_API_KEY',
    'MOR_WEBHOOK_SECRET',
    'MOR_CLIENT_TOKEN',
    'MOR_PRICE_MONTHLY',
    'MOR_PRICE_YEARLY',
    'CRON_SECRET',
    'ALERT_EMAIL',
    'EMAIL_API_KEY',
  ];
  // Stripe's trial is a property of the checkout session, not of a second
  // price, and its hosted page needs no client token.
  if (readEnv('TRIAL_ENABLED').toLowerCase() !== 'false' && provider !== 'stripe') {
    required.push('MOR_PRICE_MONTHLY_TRIAL', 'MOR_PRICE_YEARLY_TRIAL');
  }
  if (provider === 'stripe') required.splice(required.indexOf('MOR_CLIENT_TOKEN'), 1);
  if (provider === 'fastspring') required.push('MOR_STOREFRONT');
  // The email adapter's own needs. Resend runs the double opt-in itself, so it
  // needs a sender and the redirect but no template; Brevo owns the template.
  // SITE_ORIGIN and LICENSE_SECRET, which the confirmation link also needs, are
  // already in the list above.
  if (email === 'resend') required.push('EMAIL_LIST_ID', 'EMAIL_FROM', 'EMAIL_DOI_REDIRECT_URL');
  if (email === 'brevo') required.push('EMAIL_LIST_ID', 'EMAIL_DOI_TEMPLATE_ID', 'EMAIL_DOI_REDIRECT_URL');
  const missing = required.filter((name) => !hasEnv(name));

  // The MODE, not the values: `sandbox` is what api/webhooks/mor.js gates
  // live events on (anything but the literal `true` is live), and
  // `managed_payments` is whether Stripe sells as merchant of record (on unless
  // literally `false`; null for any other provider).
  const sandbox = readEnv('MOR_SANDBOX').toLowerCase() === 'true';
  const managedPayments = provider === 'stripe' ? readEnv('MOR_MANAGED_PAYMENTS').toLowerCase() !== 'false' : null;

  return { provider, email, env: envName(), sandbox, managed_payments: managedPayments, configured, missing };
}
