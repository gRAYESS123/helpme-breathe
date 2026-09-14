/**
 * js/techniques.js — the single source of truth for every breathing pattern.
 *
 * Pure data + pure functions. No DOM, no storage, no network, no side effects,
 * so this module is safe to import from the app, from a technique landing page

 *
 * Contract (see docs/MODULE_API.md):
 *   TECHNIQUES          map of key -> technique object
 *   TECHNIQUE_ORDER     display order used by the UI and the 1-7 keyboard keys
 *   DEFAULT_TECHNIQUE   key used when nothing else is specified
 *   getTechnique(key)
 *   techniqueForPath(pathname)
 *   patternToPhases({ inhale, hold1, exhale, hold2 })
 *
 * A technique object is:
 *   {
 *     key, slug, name, shortName, emoji, title,
 *     theme, circleClass, rim, fill,
 *     phases: [{ name, duration, class, text, frequency }],
 *     description, benefits[], contraindications[],
 *     requiresSafetyAck, sources[]
 *   }
 *
 * `emoji` is retained as an empty string: the brand carries no emoji, but the
 * field stays so that nothing reading it breaks. `rim` and `fill` are the
 * technique's day accent pair; the site itself uses the CSS tokens
 * (--rim-<key> / --fill-<key>) and only surfaces that cannot read the
 * stylesheet, such as the render harness, should read these.
 *
 * `sources` is intentionally empty here. Page agents own citations: a claim is
 * only allowed on a page where the author opened and quoted the source.
 */

/** Note used for phases that make no sound (holds). */
const SILENT = 0;

/** Wording reused for the three gentle patterns (no hold, no fast breathing). */
const GENTLE_NOTE = [
  'This pattern has no breath-holds and no fast breathing, so most people find it comfortable.',
  'Practice sitting or lying down — never while driving, cycling or in water.',
  'Stop if you feel dizzy, light-headed or short of breath, and check with a clinician first if you have a heart or lung condition or you are pregnant.',
];

/** @type {Record<string, any>} */
export const TECHNIQUES = {
  478: {
    key: '478',
    slug: '4-7-8-breathing',
    name: 'Deep Sleep',
    shortName: '4-7-8',
    emoji: '',
    rim: '#33407F',
    fill: '#C5C5E0',
    title: '4-7-8 breathing',
    theme: 'theme-478',
    circleClass: 'technique-478',
    phases: [
      { name: 'Inhale', duration: 4, class: 'inhale', text: 'Breathe in slowly through your nose', frequency: 174.61 },
      { name: 'Hold', duration: 7, class: 'hold', text: 'Hold, without straining', frequency: SILENT },
      { name: 'Exhale', duration: 8, class: 'exhale', text: 'Let it out slowly through your mouth', frequency: 130.81 },
    ],
    description:
      'A slow four-count inhale, a seven-count hold, then a long eight-count exhale. The long exhale is what makes it feel restful, which is why people reach for it at bedtime.',
    benefits: [
      'Many people use it as a wind-down cue before sleep.',
      'Many people use it when they want a longer exhale than they would settle into on their own.',
      'It gives you something specific to count, which some people find easier than "just relax".',
    ],
    contraindications: [
      'The seven-second hold is the part to be careful with. Shorten or skip it if it feels like a struggle.',
      'Speak to a clinician before practising breath-holds if you are pregnant, or if you live with a cardiovascular condition, uncontrolled high blood pressure, epilepsy, a respiratory condition such as asthma or COPD, glaucoma, or you have had surgery recently.',
      'If you live with panic attacks, holding the breath can feel like the start of one. Try extended exhale or cyclic sighing instead.',
      'Practice sitting or lying down — never while driving, cycling or in water.',
      'Stop if you feel dizzy, light-headed or short of breath.',
    ],
    requiresSafetyAck: false,
    sources: [],
  },

  box: {
    key: 'box',
    slug: 'box-breathing',
    name: 'Focus & Grounding',
    shortName: 'Box',
    emoji: '',
    rim: '#6E3C69',
    fill: '#DABFD6',
    title: 'Box breathing',
    theme: 'theme-box',
    circleClass: 'technique-box',
    phases: [
      { name: 'Inhale', duration: 4, class: 'inhale', text: 'Breathe in for four', frequency: 146.83 },
      { name: 'Hold', duration: 4, class: 'hold', text: 'Hold for four', frequency: SILENT },
      { name: 'Exhale', duration: 4, class: 'exhale', text: 'Breathe out for four', frequency: 110 },
      { name: 'Hold', duration: 4, class: 'hold', text: 'Stay empty for four', frequency: SILENT },
    ],
    description:
      'Four equal counts: in, hold, out, hold. The even rhythm is easy to remember and easy to keep, which is why it is taught for situations where you need to stay steady.',
    benefits: [
      'Many people use it to steady themselves before something demanding.',
      'Many people use it when they want a rhythm they can count without thinking about it.',
      'The equal counts make it simple to teach to someone else.',
    ],
    contraindications: [
      'This pattern holds the breath twice per cycle, once full and once empty.',
      'Speak to a clinician before practising breath-holds if you are pregnant, or if you live with a cardiovascular condition, uncontrolled high blood pressure, epilepsy, a respiratory condition such as asthma or COPD, glaucoma, or you have had surgery recently.',
      'If you live with panic attacks, the empty hold in particular can feel uncomfortable. Shorten it, or use extended exhale instead.',
      'Practice sitting or lying down — never while driving, cycling or in water.',
      'Stop if you feel dizzy, light-headed or short of breath.',
    ],
    requiresSafetyAck: false,
    sources: [],
  },

  coherent: {
    key: 'coherent',
    slug: 'heart-coherence-breathing',
    name: 'Heart Coherence',
    shortName: 'Coherence',
    emoji: '',
    rim: '#8C2F49',
    fill: '#E5BDC4',
    title: 'Heart coherence breathing',
    theme: 'theme-coherent',
    circleClass: 'technique-coherent',
    phases: [
      { name: 'Inhale', duration: 5, class: 'inhale', text: 'Breathe in for five', frequency: 220 },
      { name: 'Exhale', duration: 5, class: 'exhale', text: 'Breathe out for five', frequency: 164.81 },
    ],
    description:
      'Five seconds in, five seconds out — six breaths a minute, with no holds. It is the slowest pattern here that most people can keep up comfortably for a long stretch.',
    benefits: [
      'Many people use it for longer sits, because there is nothing to hold and nothing to count past five.',
      'Many people use it as a daily practice rather than a rescue technique.',
      'The even in-and-out is gentle on the chest compared with patterns that hold.',
    ],
    contraindications: GENTLE_NOTE.slice(),
    requiresSafetyAck: false,
    sources: [],
  },

  sigh: {
    key: 'sigh',
    slug: 'cyclic-sighing',
    name: 'Cyclic Sighing',
    shortName: 'Cyclic sighing',
    emoji: '',
    rim: '#125A62',
    fill: '#A2CFD5',
    title: 'Cyclic sighing',
    theme: 'theme-sigh',
    circleClass: 'technique-sigh',
    phases: [
      { name: 'Inhale', duration: 2, class: 'inhale', text: 'Breathe in through your nose', frequency: 246.94 },
      { name: 'Inhale', duration: 1, class: 'inhale inhale-short', text: 'Top up with a short second sip', frequency: 293.66 },
      { name: 'Exhale', duration: 6, class: 'exhale', text: 'Let it all out slowly through your mouth', frequency: 174.61 },
    ],
    description:
      'A full nasal inhale, a short second sip of air on top of it, then a long slow exhale through the mouth. It copies the shape of a natural sigh.',
    benefits: [
      'Many people use it when they want something short — a handful of cycles rather than a long sit.',
      'Many people use it because the double inhale is a distinct physical cue that is hard to do absent-mindedly.',
      'It needs no counting past six and no breath-holds.',
    ],
    contraindications: GENTLE_NOTE.slice(),
    requiresSafetyAck: false,
    sources: [],
  },

  extended: {
    key: 'extended',
    slug: 'extended-exhale-breathing',
    name: 'Extended Exhale',
    shortName: 'Extended exhale',
    emoji: '',
    rim: '#7A5310',
    fill: '#D8C4AD',
    title: 'Extended exhale breathing',
    theme: 'theme-extended',
    circleClass: 'technique-extended',
    phases: [
      { name: 'Inhale', duration: 4, class: 'inhale', text: 'Breathe in gently through your nose', frequency: 196 },
      { name: 'Exhale', duration: 6, class: 'exhale', text: 'Let the out-breath run longer than the in-breath', frequency: 155.56 },
    ],
    description:
      'Four seconds in, six seconds out, nothing held. It is the simplest way to make your exhale longer than your inhale without learning a count.',
    benefits: [
      'Many people use it as a first pattern, because there is nothing to hold and only two numbers to remember.',
      'Many people use it in place of 4-7-8 when breath-holds feel uncomfortable.',
      'It works quietly in public — you can do it without anyone noticing.',
    ],
    contraindications: GENTLE_NOTE.slice(),
    requiresSafetyAck: false,
    sources: [],
  },

  triangle: {
    key: 'triangle',
    slug: 'triangle-breathing',
    name: 'Quick Calm',
    shortName: 'Triangle',
    emoji: '',
    rim: '#2C5273',
    fill: '#B5C9E2',
    title: 'Triangle breathing',
    theme: 'theme-triangle',
    circleClass: 'technique-triangle',
    phases: [
      { name: 'Inhale', duration: 3, class: 'inhale', text: 'Breathe in for three', frequency: 261.63 },
      { name: 'Hold', duration: 3, class: 'hold', text: 'Hold for three', frequency: SILENT },
      { name: 'Exhale', duration: 3, class: 'exhale', text: 'Breathe out for three', frequency: 196 },
    ],
    description:
      'Three counts in, three held, three out. Short cycles and one number to remember, which is why it is often the pattern taught to children.',
    benefits: [
      'Many people use it when they only have a minute.',
      'Many people teach it to children and teenagers because a single count of three covers the whole pattern.',
      'The short cycle makes it easier to keep than slower patterns when you are already agitated.',
    ],
    contraindications: [
      'This pattern holds the breath for three seconds each cycle.',
      'Speak to a clinician before practising breath-holds if you are pregnant, or if you live with a cardiovascular condition, uncontrolled high blood pressure, epilepsy, a respiratory condition such as asthma or COPD, glaucoma, or you have had surgery recently.',
      'If you live with panic attacks, skip the hold and use extended exhale instead.',
      'Practice sitting or lying down — never while driving, cycling or in water.',
      'Stop if you feel dizzy, light-headed or short of breath.',
    ],
    requiresSafetyAck: false,
    sources: [],
  },

  wim: {
    key: 'wim',
    slug: 'energizing-breath',
    name: 'Energizing Breath',
    shortName: 'Energizing',
    emoji: '',
    rim: '#993A20',
    fill: '#E4BFB4',
    title: 'Energizing breath',
    theme: 'theme-wim',
    circleClass: 'technique-wim',
    phases: [
      { name: 'Inhale', duration: 2, class: 'inhale', text: 'Breathe in fully', frequency: 329.63 },
      { name: 'Exhale', duration: 1, class: 'exhale', text: 'Let it go', frequency: 246.94 },
    ],
    description:
      'Fast, rhythmic breathing: a two-second inhale and a one-second release, repeated. This is a stimulating pattern, not a calming one — it is the opposite of everything else here.',
    benefits: [
      'Many people use it in the morning, or before exercise, instead of a slow pattern.',
      'Many people use it for a short burst — a couple of minutes, not a long sit.',
    ],
    contraindications: [
      'Read this before you start. Fast breathing changes your blood chemistry and can make you light-headed or make you faint.',
      'Never practise this pattern in or near water, while driving, while standing, or anywhere a faint would hurt you. Sit down or lie down.',
      'Do not practise it if you are pregnant.',
      'Do not practise it if you have a cardiovascular condition, uncontrolled high blood pressure, a history of stroke or aneurysm, epilepsy or a seizure disorder, a respiratory condition such as asthma or COPD, glaucoma, or you have had surgery recently — unless a clinician who knows your history has told you it is fine.',
      'Do not practise it if you live with panic attacks or a history of hyperventilation. It can reproduce the same sensations.',
      'Never combine it with breath-holds in water. People have drowned doing this.',
      'Stop immediately if you feel dizzy, tingling, tightness in the chest, or anything that worries you.',
    ],
    requiresSafetyAck: true,
    sources: [],
  },
};

/** Display order. Also the order the 1-7 keyboard shortcuts follow. */
export const TECHNIQUE_ORDER = ['478', 'box', 'coherent', 'sigh', 'extended', 'triangle', 'wim'];

/** Key used when nothing else is specified. */
export const DEFAULT_TECHNIQUE = '478';

/** Every CSS theme class this module can put on <body>. */
export const THEME_CLASSES = TECHNIQUE_ORDER.map((k) => TECHNIQUES[k].theme);

/** Every CSS circle class this module can put on the breathing circle. */
export const CIRCLE_CLASSES = [...TECHNIQUE_ORDER.map((k) => TECHNIQUES[k].circleClass), 'custom-pace'];

/**
 * Look a technique up by key.
 * @param {string} key
 * @returns {object|null}
 */
export function getTechnique(key) {
  if (key == null) return null;
  return Object.prototype.hasOwnProperty.call(TECHNIQUES, String(key)) ? TECHNIQUES[String(key)] : null;
}

/**
 * True when a technique holds the breath or speeds it up, and therefore needs a
 * visible contraindication block wherever it can be selected (hard rule 4).
 * The three gentle patterns share GENTLE_NOTE, which is a comfort note rather
 * than a contraindication list, so they answer false.
 * @param {string|object} technique a key or a technique object
 * @returns {boolean}
 */
export function needsCautionBlock(technique) {
  const t = typeof technique === 'string' ? getTechnique(technique) : technique;
  if (!t || !Array.isArray(t.contraindications) || !t.contraindications.length) return false;
  return t.contraindications[0] !== GENTLE_NOTE[0];
}

/** Extra URL paths that should resolve to a technique but are not its own slug. */
const PATH_ALIASES = {
  '4-7-8-breathing-technique': '478',
  '478-breathing': '478',
  'coherent-breathing': 'coherent',
  'physiological-sigh': 'sigh',
  'extended-exhale': 'extended',
};

/**
 * Resolve a URL pathname to a technique, or null when the path is not a
 * technique page. Handles clean URLs, `.html`, trailing slashes and `index`.
 *
 *   techniqueForPath('/box-breathing')       -> TECHNIQUES.box
 *   techniqueForPath('/box-breathing.html')  -> TECHNIQUES.box
 *   techniqueForPath('/timer')               -> null
 *
 * @param {string} pathname
 * @returns {object|null}
 */
export function techniqueForPath(pathname) {
  if (!pathname) return null;
  let p = String(pathname);
  const q = p.search(/[?#]/);
  if (q !== -1) p = p.slice(0, q);
  p = p.replace(/\/+$/, '');
  const segment = p.split('/').pop() || '';
  const slug = segment.replace(/\.html?$/i, '').toLowerCase();
  if (!slug || slug === 'index') return null;

  for (const key of TECHNIQUE_ORDER) {
    if (TECHNIQUES[key].slug === slug) return TECHNIQUES[key];
  }
  if (Object.prototype.hasOwnProperty.call(PATH_ALIASES, slug)) {
    return TECHNIQUES[PATH_ALIASES[slug]];
  }
  return null;
}

/** Clamp to a whole number of seconds, 0..300. */
function seconds(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 300);
}

function plural(n) {
  return n === 1 ? '' : 's';
}

/**
 * Turn a four-part pattern into a phase array the engine can run.
 * Zero-length parts are omitted, so { inhale: 5, exhale: 5 } yields two phases.
 *
 * @param {{inhale?:number, hold1?:number, exhale?:number, hold2?:number}} pattern
 * @returns {Array<{name:string,duration:number,class:string,text:string,frequency:number}>}
 */
export function patternToPhases(pattern) {
  const { inhale = 0, hold1 = 0, exhale = 0, hold2 = 0 } = pattern || {};
  const i = seconds(inhale);
  const h1 = seconds(hold1);
  const e = seconds(exhale);
  const h2 = seconds(hold2);
  const phases = [];

  if (i > 0) {
    phases.push({
      name: 'Inhale',
      duration: i,
      class: 'inhale',
      text: `Breathe in for ${i} second${plural(i)}`,
      frequency: 174.61,
    });
  }
  if (h1 > 0) {
    phases.push({
      name: 'Hold',
      duration: h1,
      class: 'hold',
      text: `Hold for ${h1} second${plural(h1)}`,
      frequency: SILENT,
    });
  }
  if (e > 0) {
    phases.push({
      name: 'Exhale',
      duration: e,
      class: 'exhale',
      text: `Breathe out for ${e} second${plural(e)}`,
      frequency: 130.81,
    });
  }
  if (h2 > 0) {
    phases.push({
      name: 'Hold',
      duration: h2,
      class: 'hold',
      text: `Stay empty for ${h2} second${plural(h2)}`,
      frequency: SILENT,
    });
  }
  return phases;
}

/** Total seconds in one full cycle of a phase array. */
export function cycleSeconds(phases) {
  if (!Array.isArray(phases)) return 0;
  return phases.reduce((total, phase) => total + (Number(phase && phase.duration) || 0), 0);
}
