#!/usr/bin/env node
/**
 * tools/keygen.mjs — print one fresh 64-character secret.
 *
 *   node tools/keygen.mjs
 *
 * Writes NOTHING to disk. Prints one secret and what to do with it. Run it
 * once per secret the deployment needs — LICENSE_SECRET, TRIAL_PEPPER,
 * DEVICE_PEPPER and CRON_SECRET — on your own machine, paste each value
 * straight into the Vercel dashboard, and close the terminal. Never commit
 * one, never paste one into a chat, never mail one to yourself.
 */

import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';

/** 32 random bytes rendered as 64 hexadecimal characters. */
function generateSecret() {
  return randomBytes(32).toString('hex');
}

/** The kid that this secret will stamp into every token it signs. */
function kidFor(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8);
}

const secret = generateSecret();
const kid = kidFor(secret);

const lines = [
  '',
  'Secret (64 characters, 256 bits of entropy)',
  '---------------------------------------------------------------',
  secret,
  '---------------------------------------------------------------',
  '',
  'Which variable it is for',
  '  Run this script once per secret. Each run prints a new, unrelated value.',
  '  You need four: LICENSE_SECRET, TRIAL_PEPPER, DEVICE_PEPPER, CRON_SECRET.',
  '  Never reuse one value for two variables.',
  '',
  `If you use this value as LICENSE_SECRET, its key id (kid) is: ${kid}`,
  '  Every entitlement token signed with it carries that kid, so you can tell',
  '  at a glance which secret minted a token you are looking at. The kid is',
  '  meaningless for the peppers and CRON_SECRET; ignore it for those.',
  '',
  'What to do with it',
  '  1. Vercel dashboard -> your project -> Settings -> Environment Variables.',
  '  2. Add the variable with this value. Tick Production, Preview and',
  '     Development so local `vercel dev` behaves like production.',
  '  3. Redeploy. Nothing reads the variable until a new deployment starts.',
  '  4. Close this terminal. Clear your scrollback if it is saved anywhere.',
  '',
  'What NOT to do',
  '  - Do not commit it. `.env` is gitignored and must stay that way.',
  '  - Do not paste it into a chat, an issue, or a support ticket.',
  '  - Do not reuse it for anything else.',
  '',
  'Rotating',
  '  Generate a new value and replace the variable, then redeploy. Only rotate',
  '  if you believe the secret leaked; each one has a cost:',
  '  - LICENSE_SECRET: every existing entitlement token stops verifying (the',
  '    kid no longer matches), so offline use ends for every subscriber until',
  '    their next page load, when a fresh token is issued automatically.',
  '    See docs/API.md, "Rotating LICENSE_SECRET".',
  '  - TRIAL_PEPPER or DEVICE_PEPPER: every stored trial and device hash is',
  '    invalidated, so the trial locks reset and a second trial becomes',
  '    possible for everyone (per email for TRIAL_PEPPER, per device for',
  '    DEVICE_PEPPER); DEVICE_PEPPER also resets every free-session count.',
  '  - CRON_SECRET: Vercel builds the `Authorization: Bearer` header that the',
  '    two cron jobs (api/cron/reconcile.js hourly, api/cron/retention.js',
  '    weekly) send from this variable, so the cron header must be updated',
  '    with it: replace the variable in Vercel and redeploy. Until the new',
  '    deployment is live the crons fail closed (401) and nothing reconciles.',
  '',
];

console.log(lines.join('\n'));
