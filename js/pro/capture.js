/**
 * js/pro/capture.js — the post-session email capture card.
 *
 * One inline card on the page's own stock, never a modal, never an overlay,
 * never on top of the breathing circle. It appears in the completing instance's
 * `[data-slot="post-session"]` after a completed session, offering an occasional
 * email from the site: new patterns and guides, no more than once a month,
 * double opt-in through the email provider (POST /api/subscribe).
 *
 * Rules it obeys:
 *   - once ever per browser (flag `hmb.capture.shown`)
 *   - never on a page with `<body data-no-asks="true">` (the crisis-safe pages)
 *   - never while `body.session-active`
 *   - never on the same completion as the Pro offer card — the offer wins and
 *     the capture waits for the next completed session
 *
 * Nothing else renders this card. js/checkout.js draws its own "Checkout is not
 * open yet" card while checkout is closed; there is no waitlist any more.
 */

import { getFlag, setFlag } from '../storage.js';
import { track, EVENTS } from '../analytics.js';

const FLAG_SHOWN = 'capture.shown';
const SUBSCRIBE_ENDPOINT = '/api/subscribe';

let uid = 0;
let wired = false;

function asksBlocked() {
  const body = document.body;
  if (!body) return true;
  if (body.dataset && body.dataset.noAsks === 'true') return true;
  if (body.classList.contains('session-active')) return true;
  return false;
}

/* ------------------------------------------------------------------- card */

/**
 * Render the capture card into `container`, replacing whatever was there.
 *
 * @param {Element} container
 * @param {{
 *   source?:string, technique?:string, message?:string, title?:string,
 *   submitLabel?:string, consentLabel?:string, note?:string,
 *   successMessage?:string, markShown?:boolean
 * }} [options] The copy options let a caller describe exactly the email the
 *   person is agreeing to receive; the consent line must always match what is
 *   actually sent. `markShown` defaults to true only for the post-session card.
 * @returns {Element|null} the card element
 */
function renderCaptureCard(container, options = {}) {
  if (!container || typeof document === 'undefined') return null;

  const source = options.source || 'post-session';
  const technique = options.technique || '';
  const id = `capture-${++uid}`;

  const title = options.title || 'Want an occasional note from Help Me Breathe?';
  const message =
    options.message || 'New patterns and guides, no more than once a month. Unsubscribe in one click.';
  const submitLabel = options.submitLabel || 'Sign me up';
  const consentText =
    options.consentLabel ||
    ' Yes, email me now and then. You can unsubscribe from any email, and the address is used for nothing else.';
  const noteText =
    options.note || 'One email to confirm the address first. Nothing is sent until you confirm.';
  const successText = options.successMessage || 'Check your inbox and confirm the address.';
  // Only the post-session card spends the "asked once" budget. A card a visitor
  // opened deliberately somewhere else must not silently use that budget up.
  const marksShown =
    options.markShown === undefined ? source === 'post-session' : options.markShown === true;

  container.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'post-session-card capture-card';
  card.setAttribute('data-ask', 'capture');
  card.setAttribute('data-source', source);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'card-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss this card');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => {
    if (marksShown) setFlag(FLAG_SHOWN, true);
    card.remove();
  });

  const heading = document.createElement('h3');
  heading.textContent = title;

  const body = document.createElement('p');
  body.textContent = message;

  const form = document.createElement('form');
  form.noValidate = true;

  const label = document.createElement('label');
  label.className = 'sr-only';
  label.setAttribute('for', `${id}-email`);
  label.textContent = 'Your email address';

  const input = document.createElement('input');
  input.type = 'email';
  input.id = `${id}-email`;
  input.name = 'email';
  input.required = true;
  input.autocomplete = 'email';
  input.placeholder = 'you@example.org';

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = submitLabel;

  const consentRow = document.createElement('p');
  consentRow.className = 'form-note capture-consent';

  const consent = document.createElement('input');
  consent.type = 'checkbox';
  consent.id = `${id}-consent`;
  consent.name = 'consent';

  const consentLabel = document.createElement('label');
  consentLabel.setAttribute('for', `${id}-consent`);
  consentLabel.textContent = consentText;

  consentRow.append(consent, consentLabel);

  const note = document.createElement('p');
  note.className = 'form-note';
  note.textContent = noteText;

  const status = document.createElement('p');
  status.className = 'form-error';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  form.append(label, input, submit, consentRow, note, status);
  card.append(dismiss, heading, body, form);
  container.appendChild(card);

  function fail(text) {
    status.hidden = false;
    status.classList.remove('form-success');
    status.textContent = text;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = String(input.value || '').trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      fail('That does not look like an email address. Check it and try again.');
      input.focus();
      return;
    }
    if (!consent.checked) {
      fail('Tick the box so we know it is fine to email you.');
      consent.focus();
      return;
    }

    submit.disabled = true;
    const original = submit.textContent;
    submit.textContent = 'Sending…';
    status.hidden = true;

    // No email address, ever, in an analytics parameter.
    track(EVENTS.CAPTURE_SUBMIT, { technique: technique || 'none', source });

    let data = null;
    let ok = false;
    try {
      const response = await fetch(SUBSCRIBE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, technique, source, consent: true }),
      });
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      ok = response.ok && (!data || data.ok !== false);
    } catch {
      ok = false;
    }

    submit.disabled = false;
    submit.textContent = original;

    if (!ok) {
      fail(
        (data && data.error) ||
          'That did not go through. Try again in a moment, or email contact@helpmebreath.com.',
      );
      return;
    }

    if (marksShown) setFlag(FLAG_SHOWN, true);
    form.remove();
    body.textContent = (data && data.message) || successText;
    heading.textContent = 'Almost there';
  });

  return card;
}

/* ------------------------------------------------------------ session hook */

function onSessionComplete(event) {
  const detail = event.detail || {};
  if (detail.completed !== true) return;
  if (asksBlocked()) return;
  if (getFlag(FLAG_SHOWN) === true) return;

  // The Pro offer card wins when both are eligible; the capture waits.
  if (document.querySelector('[data-ask="paywall"]')) return;

  const root = detail.root;
  const container = root && root.querySelector ? root.querySelector('[data-slot="post-session"]') : null;
  if (!container) return;
  if (container.querySelector('[data-ask]')) return;

  const technique = detail.technique || '';
  renderCaptureCard(container, { source: 'post-session', technique });
  // The flag is set when the person acts on the card (dismiss or submit), not
  // here: a card that rendered below the fold and was never seen must come
  // back after the next session.
  track(EVENTS.CAPTURE_SHOWN, { technique: technique || 'none', source: 'post-session' });
}

/** Register the one document-level listener. Safe to call more than once. */
export function initCapture() {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  document.addEventListener('hmb:session-complete', onSessionComplete);
}
