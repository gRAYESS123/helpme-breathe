#!/usr/bin/env node
/**
 * tools/keygen.mjs — print a fresh LICENSE_SECRET.
 *
 *   node tools/keygen.mjs
 *
 * Writes NOTHING to disk. Prints one secret and what to do with it. Run it on
 * your own machine, paste the value straight into the Vercel dashboard, and
 * close the terminal. Never commit it, never paste it into a chat, never mail
 * it to yourself.
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
  'LICENSE_SECRET (64 characters, 256 bits of entropy)',
  '---------------------------------------------------------------',
  secret,
  '---------------------------------------------------------------',
  '',
  `Key id (kid) this secret produces: ${kid}`,
  'Every token signed with it carries that kid, so you can tell at a glance',
  'which secret minted a token you are looking at.',
  '',
  'What to do with it',
  '  1. Vercel dashboard -> your project -> Settings -> Environment Variables.',
  '  2. Add LICENSE_SECRET with this value. Tick Production, Preview and',
  '     Development so local `vercel dev` behaves like production.',
  '  3. Redeploy. Nothing reads the variable until a new deployment starts.',
  '  4. Close this terminal. Clear your scrollback if it is saved anywhere.',
  '',
  'What NOT to do',
  '  - Do not commit it. `.env` is gitignored and must stay that way.',
  '  - Do not paste it into a chat, an issue, or a support ticket.',
  '  - Do not reuse it for anything else.',
  '',
  'Rotating it',
  '  Generate a new one and replace the variable. Every existing licence token',
  '  stops verifying immediately (the kid no longer matches), so every customer',
  '  re-activates with the key from their receipt. That costs them one click and',
  '  it burns one activation slot each, so only rotate if you believe the secret',
  '  leaked. See docs/API.md, "Rotating LICENSE_SECRET".',
  '',
];

console.log(lines.join('\n'));
