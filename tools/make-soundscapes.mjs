#!/usr/bin/env node
/**
 * tools/make-soundscapes.mjs — build the ambient audio pack.
 *
 * Everything in `audio/` is SYNTHESISED here, sample by sample, from a seeded
 * pseudo-random generator and a handful of filters. Nothing is downloaded, no
 * recording or sample library is involved, and no AI voice or music service is
 * called. That removes the licence question entirely: the output is our own
 * work and ships as CC0.
 *
 * Six 60-second seamless beds:
 *
 *   rain    filtered white noise with random droplet transients
 *   ocean   pink-ish noise under a slow ten-second swell
 *   brown   brown noise, high end rolled off
 *   drone   detuned sines around 55–110 Hz with slow LFOs
 *   forest  a soft noise floor with sparse gentle chirps
 *   night   very quiet noise with a slow low pulse
 *
 * Plus three one-shot cue tones (inhale rising, exhale falling, hold soft) at
 * the same pitches the Web Audio engine already uses, for optional use.
 *
 * Each bed is rendered to 44.1 kHz mono 16-bit WAV, then encoded to Opus in Ogg
 * (.ogg) and AAC in MP4 (.m4a) with ffmpeg. The WAVs are deleted afterwards
 * unless --keep-wav is passed.
 *
 * Zero npm dependencies. Node 18+.
 *
 * Usage:
 *   node tools/make-soundscapes.mjs                 build everything
 *   node tools/make-soundscapes.mjs --only=rain,night
 *   node tools/make-soundscapes.mjs --keep-wav      leave the intermediate WAVs
 *   node tools/make-soundscapes.mjs --seconds=30    shorter loops
 *   node tools/make-soundscapes.mjs --bitrate=40    target kbps for the beds
 *   node tools/make-soundscapes.mjs --ffmpeg=C:/path/to/ffmpeg.exe
 *   node tools/make-soundscapes.mjs --help
 *
 * ---------------------------------------------------------------------------
 * How the loops are made seamless
 * ---------------------------------------------------------------------------
 * Three separate tricks, one per kind of layer:
 *
 *  - Noise layers are rendered LONGER than the loop (loop + crossfade + a
 *    warm-up the filters eat), then the tail is equal-power crossfaded into the
 *    head. The last sample therefore flows into the first with no click and no
 *    filter start-up transient.
 *  - Tonal layers and every LFO use frequencies that are an exact integer
 *    multiple of 1/loopSeconds, so they complete a whole number of cycles and
 *    are periodic over the loop by construction.
 *  - One-shot transients (droplets, chirps) are written with a modulo index, so
 *    an event scheduled near the end wraps around into the beginning.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const SR = 44100; // sample rate of the rendered WAVs
const FALLBACK_SR = 22050; // only used when there is no usable ffmpeg
const CROSSFADE_SECONDS = 2; // tail-into-head blend inside the render
const WARMUP_SECONDS = 1; // discarded; lets the filters settle
const MAX_ENCODED_BYTES = 400 * 1024; // BUILD_SPEC FEAT-12 asks for < 400 KB
const LICENSE = 'Generated procedurally by Help Me Breathe; CC0';

/* ========================================================================== *
 * Arguments
 * ========================================================================== */

function parseArgs(argv) {
  const opts = {
    only: null,
    keepWav: false,
    seconds: 60,
    bitrate: 48,
    out: path.join(REPO_ROOT, 'audio'),
    ffmpeg: process.env.HMB_FFMPEG || null,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--keep-wav') opts.keepWav = true;
    else if (arg.startsWith('--only=')) opts.only = arg.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('--seconds=')) opts.seconds = Math.max(5, Math.min(300, Number(arg.slice(10)) || 60));
    else if (arg.startsWith('--bitrate=')) opts.bitrate = Math.max(16, Math.min(160, Number(arg.slice(10)) || 48));
    else if (arg.startsWith('--out=')) opts.out = path.resolve(REPO_ROOT, arg.slice(6));
    else if (arg.startsWith('--ffmpeg=')) opts.ffmpeg = arg.slice(9);
    else {
      console.error(`Unknown argument: ${arg}`);
      opts.help = true;
    }
  }
  return opts;
}

function printHelp() {
  console.log(
    [
      'make-soundscapes — synthesise the Help Me Breathe ambient pack',
      '',
      '  --only=rain,ocean   build only these beds (cues are always rebuilt)',
      '  --seconds=60        loop length in seconds',
      '  --bitrate=48        target kbps for the encoded beds',
      '  --keep-wav          keep the intermediate 44.1 kHz WAVs',
      '  --out=audio         output directory, relative to the repo root',
      '  --ffmpeg=PATH       use this ffmpeg binary',
      '  --help              this text',
      '',
      'Output: audio/<name>.ogg, audio/<name>.m4a, audio/manifest.json',
    ].join('\n'),
  );
}

/* ========================================================================== *
 * Deterministic noise and small DSP helpers
 * ========================================================================== */

/** mulberry32 — small, fast, deterministic. Same seed, same bed, every run. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed derived from the bed name, so names map to stable output. */
function seedFor(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function white(n, rng) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rng() * 2 - 1;
  return out;
}

/** Paul Kellet's economy pink filter. */
function pink(n, rng) {
  const out = new Float32Array(n);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

/** Leaky integrator: 6 dB/octave down, i.e. brown / red noise. */
function brown(n, rng) {
  const out = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = rng() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    out[i] = last * 3.5;
  }
  return out;
}

function onePoleCoefficient(fc, sr) {
  return 1 - Math.exp((-2 * Math.PI * fc) / sr);
}

/** One-pole lowpass, in place. */
function lowpass(buf, fc, sr = SR) {
  const a = onePoleCoefficient(fc, sr);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += a * (buf[i] - y);
    buf[i] = y;
  }
  return buf;
}

/** One-pole highpass (input minus its lowpass), in place. */
function highpass(buf, fc, sr = SR) {
  const a = onePoleCoefficient(fc, sr);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += a * (buf[i] - y);
    buf[i] -= y;
  }
  return buf;
}

/** Two cascaded one-poles: a gentler, more natural roll-off. */
function lowpass2(buf, fc, sr = SR) {
  return lowpass(lowpass(buf, fc, sr), fc, sr);
}

/**
 * Filter an already-seamless buffer without breaking the seam.
 *
 * A one-pole filter starts from zero state, so its first samples carry a
 * transient the last samples do not — enough to click on a quiet bed. Running
 * the filter over two back-to-back copies and keeping the second means the
 * state entering sample 0 is the same state that leaves sample n-1, so the
 * result stays periodic.
 */
function circularFilter(buf, apply) {
  const n = buf.length;
  const doubled = new Float32Array(n * 2);
  doubled.set(buf, 0);
  doubled.set(buf, n);
  apply(doubled);
  const out = new Float32Array(n);
  out.set(doubled.subarray(n));
  return out;
}

function rmsOf(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

function peakOf(buf) {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

function scaleInPlace(buf, gain) {
  for (let i = 0; i < buf.length; i++) buf[i] *= gain;
  return buf;
}

/**
 * Scale to a target RMS, then pull back if that would clip. A single uniform
 * gain, so seamlessness is untouched.
 */
function normalise(buf, targetRms, peakCeiling = 0.94) {
  const rms = rmsOf(buf);
  let gain = rms > 1e-9 ? targetRms / rms : 1;
  const peak = peakOf(buf);
  if (peak * gain > peakCeiling) gain = peak > 1e-9 ? peakCeiling / peak : 1;
  return scaleInPlace(buf, gain);
}

/**
 * Render a seamless noise layer.
 *
 * @param {number} n loop length in samples
 * @param {number} xf crossfade length in samples
 * @param {(len:number)=>Float32Array} generate produces raw noise of a length
 * @param {(buf:Float32Array)=>Float32Array} [shape] filter chain, applied in place
 */
function seamlessNoise(n, xf, generate, shape, sr = SR) {
  const warm = Math.round(WARMUP_SECONDS * sr);
  const raw = generate(warm + n + xf);
  const shaped = shape ? shape(raw) : raw;
  const body = shaped.subarray(warm); // length n + xf

  const out = new Float32Array(n);
  out.set(body.subarray(0, n));
  for (let i = 0; i < xf; i++) {
    const t = i / xf;
    const gTail = Math.cos((t * Math.PI) / 2); // 1 → 0
    const gHead = Math.sin((t * Math.PI) / 2); // 0 → 1
    out[i] = body[n + i] * gTail + body[i] * gHead;
  }
  return out;
}

/**
 * A sine that is exactly periodic over the loop: the frequency is snapped to
 * the nearest integer multiple of 1/loopSeconds.
 */
function addPeriodicSine(target, hz, amp, phase, loopSeconds, sr = SR) {
  const n = target.length;
  const cycles = Math.max(1, Math.round(hz * loopSeconds));
  const w = (2 * Math.PI * cycles) / n;
  for (let i = 0; i < n; i++) target[i] += amp * Math.sin(w * i + phase);
  return cycles / loopSeconds; // the frequency actually used
}

/**
 * A unipolar 0..1 LFO with a whole number of cycles across the loop.
 * `shape` bends it: > 1 makes the peaks narrower.
 */
function periodicLfo(n, cycles, shape = 1) {
  const out = new Float32Array(n);
  const w = (2 * Math.PI * Math.max(1, Math.round(cycles))) / n;
  for (let i = 0; i < n; i++) {
    const v = 0.5 - 0.5 * Math.cos(w * i);
    out[i] = shape === 1 ? v : Math.pow(v, shape);
  }
  return out;
}

/** Add a buffer into another with a per-sample gain envelope. */
function mixWithEnvelope(target, layer, env, gain = 1) {
  for (let i = 0; i < target.length; i++) target[i] += layer[i] * env[i] * gain;
  return target;
}

function mixFlat(target, layer, gain = 1) {
  for (let i = 0; i < target.length; i++) target[i] += layer[i] * gain;
  return target;
}

/**
 * Write a short event into the loop, wrapping past the end back to the start —
 * which is exactly what makes a random transient loop-safe.
 */
function addWrapped(target, startSample, event) {
  const n = target.length;
  const start = ((Math.round(startSample) % n) + n) % n;
  for (let j = 0; j < event.length; j++) target[(start + j) % n] += event[j];
  return target;
}

/** A damped sine — one rain drop, one tick. */
function dampedSine(freq, tauSeconds, amp, sr = SR) {
  const len = Math.max(4, Math.round(tauSeconds * 6 * sr));
  const out = new Float32Array(len);
  const w = (2 * Math.PI * freq) / sr;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    out[i] = amp * Math.sin(w * i) * Math.exp(-t / tauSeconds);
  }
  return out;
}

/** A short frequency-swept note under a raised-cosine window — one chirp. */
function chirp(f0, f1, durationSeconds, amp, harmonic = 0.3, sr = SR) {
  const len = Math.max(8, Math.round(durationSeconds * sr));
  const out = new Float32Array(len);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const f = f0 + (f1 - f0) * t;
    phase += (2 * Math.PI * f) / sr;
    const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * t); // 0 → 1 → 0
    out[i] = amp * env * (Math.sin(phase) + harmonic * Math.sin(2 * phase));
  }
  return out;
}

/* ========================================================================== *
 * The six beds
 * ========================================================================== */

/**
 * Rain: a bright hiss over a duller body, plus scattered droplets. The hiss
 * breathes very slightly so it does not sound like a machine.
 */
function renderRain(n, xf, rng, loopSeconds) {
  const out = new Float32Array(n);

  const hiss = seamlessNoise(n, xf, (len) => white(len, rng), (b) => lowpass2(highpass(b, 1100), 7500));
  const body = seamlessNoise(n, xf, (len) => pink(len, rng), (b) => lowpass2(b, 900));

  const breathe = periodicLfo(n, Math.round(loopSeconds / 20)); // ~20 s
  const hissEnv = new Float32Array(n);
  for (let i = 0; i < n; i++) hissEnv[i] = 0.85 + 0.15 * breathe[i];

  mixWithEnvelope(out, hiss, hissEnv, 1.0);
  mixFlat(out, body, 0.55);

  // Droplets: about three a second, each a short damped ring with a click.
  const drops = Math.round(loopSeconds * 3);
  for (let d = 0; d < drops; d++) {
    const at = rng() * n;
    const freq = 1700 + rng() * 2600;
    const tau = 0.008 + rng() * 0.017;
    const amp = 0.05 + rng() * 0.13;
    addWrapped(out, at, dampedSine(freq, tau, amp));
  }

  return normalise(out, 0.15);
}

/**
 * Ocean: a low body of pink noise that swells every ten seconds, with a
 * brighter foam layer that only really arrives at the crest.
 */
function renderOcean(n, xf, rng, loopSeconds) {
  const out = new Float32Array(n);

  const body = seamlessNoise(n, xf, (len) => pink(len, rng), (b) => lowpass2(b, 620));
  const foam = seamlessNoise(n, xf, (len) => white(len, rng), (b) => lowpass2(highpass(b, 1400), 6000));

  const swellCycles = Math.max(1, Math.round(loopSeconds / 10)); // a 10 s swell
  const swell = periodicLfo(n, swellCycles, 1.6);
  const drift = periodicLfo(n, Math.max(1, Math.round(loopSeconds / 30))); // slow depth drift

  const bodyEnv = new Float32Array(n);
  const foamEnv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const depth = 0.78 + 0.22 * drift[i];
    const s = swell[i] * depth;
    bodyEnv[i] = 0.34 + 0.66 * s;
    foamEnv[i] = Math.pow(s, 2.4);
  }

  mixWithEnvelope(out, body, bodyEnv, 1.0);
  mixWithEnvelope(out, foam, foamEnv, 0.55);

  return normalise(out, 0.145);
}

/** Brown noise: even, deep, nothing moving. */
function renderBrown(n, xf, rng) {
  const out = seamlessNoise(n, xf, (len) => brown(len, rng), (b) => lowpass(highpass(b, 22), 2600));
  return normalise(out, 0.17);
}

/**
 * Low drone: six sines between 55 and 110 Hz, each snapped to a whole number of
 * cycles across the loop so the stack is periodic. The small offsets beat
 * against each other, which is what makes it move without an LFO doing the work.
 */
function renderDrone(n, xf, rng, loopSeconds) {
  const out = new Float32Array(n);

  const partials = [
    { hz: 55.0, amp: 0.5, lfo: 1 },
    { hz: 55.05, amp: 0.38, lfo: 2 },
    { hz: 82.5, amp: 0.22, lfo: 3 },
    { hz: 82.62, amp: 0.16, lfo: 2 },
    { hz: 110.0, amp: 0.14, lfo: 1 },
    { hz: 110.08, amp: 0.1, lfo: 3 },
  ];

  for (const partial of partials) {
    const voice = new Float32Array(n);
    addPeriodicSine(voice, partial.hz, partial.amp, rng() * Math.PI * 2, loopSeconds);
    const lfo = periodicLfo(n, partial.lfo);
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) env[i] = 0.62 + 0.38 * lfo[i];
    mixWithEnvelope(out, voice, env, 1);
  }

  // A breath of air over the top so it is not a pure test tone.
  const air = seamlessNoise(n, xf, (len) => pink(len, rng), (b) => lowpass2(highpass(b, 200), 2200));
  mixFlat(out, air, 0.05);

  // Circular, or the filter's start-up transient becomes a click at the seam.
  const smoothed = circularFilter(out, (b) => lowpass(b, 1800));
  return normalise(smoothed, 0.12);
}

/**
 * Forest: a quiet floor of leaves and wind, with a bird every few seconds and
 * the occasional lower call.
 */
function renderForest(n, xf, rng, loopSeconds) {
  const out = new Float32Array(n);

  const floorLayer = seamlessNoise(n, xf, (len) => pink(len, rng), (b) => lowpass2(highpass(b, 180), 2400));
  const leaves = seamlessNoise(n, xf, (len) => white(len, rng), (b) => lowpass2(highpass(b, 2500), 9000));

  const wind = periodicLfo(n, Math.max(1, Math.round(loopSeconds / 15)), 1.4);
  const floorEnv = new Float32Array(n);
  const leafEnv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    floorEnv[i] = 0.7 + 0.3 * wind[i];
    leafEnv[i] = 0.25 + 0.75 * Math.pow(wind[i], 1.8);
  }

  mixWithEnvelope(out, floorLayer, floorEnv, 0.9);
  mixWithEnvelope(out, leaves, leafEnv, 0.12);

  // Songs: one to three notes, a soft sweep each, a few seconds apart.
  const songs = Math.max(2, Math.round(loopSeconds / 3.2));
  for (let s = 0; s < songs; s++) {
    let at = rng() * n;
    const notes = 1 + Math.floor(rng() * 3);
    const base = 2300 + rng() * 2300;
    const amp = 0.05 + rng() * 0.09;
    for (let k = 0; k < notes; k++) {
      const dur = 0.045 + rng() * 0.065;
      const bend = 1 + (rng() * 0.5 - 0.2);
      addWrapped(out, at, chirp(base, base * bend, dur, amp, 0.28));
      at += (dur + 0.06 + rng() * 0.09) * SR;
    }
  }

  // A few lower calls, well spaced.
  const calls = Math.max(1, Math.round(loopSeconds / 20));
  for (let c = 0; c < calls; c++) {
    const at = rng() * n;
    const f = 300 + rng() * 200;
    addWrapped(out, at, chirp(f, f * 0.92, 0.22 + rng() * 0.12, 0.05, 0.18));
  }

  return normalise(out, 0.085);
}

/**
 * Night: almost silence, with a slow low pulse every twelve seconds. Deliberately
 * the quietest bed in the pack — it is meant to sit beneath the cue tones.
 */
function renderNight(n, xf, rng, loopSeconds) {
  const out = new Float32Array(n);

  const floorLayer = seamlessNoise(n, xf, (len) => brown(len, rng), (b) => lowpass(highpass(b, 30), 1400));
  const airLayer = seamlessNoise(n, xf, (len) => pink(len, rng), (b) => lowpass2(highpass(b, 900), 5200));

  mixFlat(out, floorLayer, 0.8);
  mixFlat(out, airLayer, 0.06);

  // The pulse: a low tone under a slow raised-cosine swell, five times a minute.
  const pulseCycles = Math.max(1, Math.round(loopSeconds / 12));
  const pulse = periodicLfo(n, pulseCycles, 2.6);
  const tone = new Float32Array(n);
  addPeriodicSine(tone, 48, 0.6, 0, loopSeconds);
  addPeriodicSine(tone, 96, 0.18, Math.PI / 3, loopSeconds);
  addPeriodicSine(tone, 144, 0.06, Math.PI / 5, loopSeconds);
  mixWithEnvelope(out, tone, pulse, 0.5);

  return normalise(out, 0.055);
}

const BEDS = [
  {
    name: 'rain',
    label: 'Rain',
    description: 'Steady rain with scattered drops.',
    render: renderRain,
  },
  {
    name: 'ocean',
    label: 'Ocean',
    description: 'Slow waves with a ten-second swell.',
    render: renderOcean,
  },
  {
    name: 'brown-noise',
    label: 'Brown noise',
    description: 'A deep, even hiss with the high end rolled off.',
    render: renderBrown,
  },
  {
    name: 'drone',
    label: 'Low drone',
    description: 'A quiet bass hum that drifts slowly.',
    render: renderDrone,
  },
  {
    name: 'forest',
    label: 'Forest',
    description: 'Leaves and wind, with a bird now and then.',
    render: renderForest,
  },
  {
    name: 'night',
    label: 'Night',
    description: 'Almost silence, with a slow low pulse.',
    render: renderNight,
  },
];

/* ========================================================================== *
 * The three cue tones
 * ========================================================================== */

/**
 * One-shots, not loops, so they get real fades at both ends. Pitches match the
 * frequencies js/app.js already synthesises live: 174.61 Hz on the inhale,
 * 130.81 Hz on the exhale.
 */
function renderCue(kind, sr = SR) {
  const specs = {
    'cue-inhale': { from: 174.61, to: 261.63, seconds: 1.1 },
    'cue-exhale': { from: 174.61, to: 130.81, seconds: 1.3 },
    'cue-hold': { from: 146.83, to: 146.83, seconds: 0.9 },
  };
  const spec = specs[kind];
  const len = Math.round(spec.seconds * sr);
  const out = new Float32Array(len);

  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const f = spec.from + (spec.to - spec.from) * t;
    phase += (2 * Math.PI * f) / sr;

    let env;
    if (kind === 'cue-inhale') {
      // Swells towards the end, like the live inhale tone.
      env = t < 0.72 ? t / 0.72 : 1 - (t - 0.72) / 0.28;
    } else if (kind === 'cue-exhale') {
      // Quick in, long exponential release.
      env = t < 0.12 ? t / 0.12 : Math.exp(-(t - 0.12) * 4.2);
    } else {
      // A soft bell.
      env = Math.pow(0.5 - 0.5 * Math.cos(2 * Math.PI * t), 0.8);
    }

    const fifth = kind === 'cue-hold' ? 0.22 * Math.sin(phase * 1.5) : 0;
    out[i] = env * (Math.sin(phase) + 0.12 * Math.sin(2 * phase) + fifth);
  }

  // Hard fade the last 12 ms so nothing clicks on the way out.
  const tail = Math.min(len, Math.round(0.012 * sr));
  for (let i = 0; i < tail; i++) out[len - 1 - i] *= i / tail;

  const peak = peakOf(out);
  if (peak > 1e-9) scaleInPlace(out, 0.6 / peak);
  return out;
}

const CUES = [
  { name: 'cue-inhale', label: 'Inhale cue', description: 'A rising tone for the start of an inhale.' },
  { name: 'cue-exhale', label: 'Exhale cue', description: 'A falling tone for the start of an exhale.' },
  { name: 'cue-hold', label: 'Hold cue', description: 'A soft bell for a hold.' },
];

/* ========================================================================== *
 * WAV
 * ========================================================================== */

function writeWav(filePath, samples, sr = SR) {
  const n = samples.length;
  const dataBytes = n * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // format: PCM
  buf.writeUInt16LE(1, 22); // channels: mono
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < n; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }

  fs.writeFileSync(filePath, buf);
  return buf.length;
}

/** Cheap linear-interpolation resample, used only by the no-ffmpeg fallback. */
function resample(samples, fromSr, toSr) {
  if (fromSr === toSr) return samples;
  const ratio = toSr / fromSr;
  const n = Math.floor(samples.length * ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = src - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

/* ========================================================================== *
 * ffmpeg
 * ========================================================================== */

/** Expand a path with a single `*` in one segment. Returns absolute paths. */
function globOneStar(pattern) {
  const parts = pattern.split('/');
  const starIndex = parts.findIndex((part) => part.includes('*'));
  if (starIndex === -1) return fs.existsSync(pattern) ? [pattern] : [];

  const base = parts.slice(0, starIndex).join('/');
  const matcher = new RegExp(`^${parts[starIndex].split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  const rest = parts.slice(starIndex + 1);

  let entries;
  try {
    entries = fs.readdirSync(base);
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (!matcher.test(entry)) continue;
    const next = [base, entry, ...rest].join('/');
    if (rest.length === 0) {
      if (fs.existsSync(next)) results.push(next);
    } else {
      results.push(...globOneStar(next));
    }
  }
  return results;
}

function ffmpegCandidates(explicit) {
  const list = [];
  if (explicit) list.push(explicit);
  list.push('ffmpeg');

  const localAppData = (process.env.LOCALAPPDATA || '').replace(/\\/g, '/');
  const appData = (process.env.APPDATA || '').replace(/\\/g, '/');

  if (localAppData) {
    // Playwright ships an ffmpeg, but its default build is video-only — the
    // probe below is what actually decides whether a candidate is usable.
    list.push(...globOneStar(`${localAppData}/ms-playwright/ffmpeg-*/ffmpeg.exe`));
    list.push(...globOneStar(`${localAppData}/ms-playwright/ffmpeg-*/ffmpeg-win64.exe`));
    list.push(...globOneStar(`${localAppData}/ms-playwright/ffmpeg-*/ffmpeg-*.exe`));
    // imageio-ffmpeg (a Python package) bundles a full gyan.dev build.
    list.push(...globOneStar(`${localAppData}/Python/*/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg*.exe`));
    list.push(...globOneStar(`${localAppData}/Programs/Python/*/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg*.exe`));
    list.push(...globOneStar(`${localAppData}/Microsoft/WinGet/Packages/*/ffmpeg*/bin/ffmpeg.exe`));
  }
  if (appData) {
    list.push(...globOneStar(`${appData}/Python/*/site-packages/imageio_ffmpeg/binaries/ffmpeg*.exe`));
  }
  list.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg');
  list.push('C:/ProgramData/chocolatey/bin/ffmpeg.exe', 'C:/ffmpeg/bin/ffmpeg.exe');

  return [...new Set(list)];
}

/** A candidate is only useful if it can actually encode Opus and AAC. */
function probeFfmpeg(bin) {
  let result;
  try {
    result = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 30000 });
  } catch {
    return null;
  }
  if (!result || result.status !== 0 || !result.stdout) return null;
  const out = result.stdout;
  const opus = /\blibopus\b/.test(out) ? 'libopus' : /^\s*A\S*\s+opus\b/m.test(out) ? 'opus' : null;
  const aac = /^\s*A\S*\s+aac\b/m.test(out) ? 'aac' : null;
  if (!opus || !aac) return null;
  return { bin, opus, aac };
}

function findFfmpeg(explicit) {
  const tried = [];
  for (const candidate of ffmpegCandidates(explicit)) {
    const probed = probeFfmpeg(candidate);
    tried.push(candidate);
    if (probed) return { ...probed, tried };
  }
  return { bin: null, tried };
}

function runFfmpeg(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 300000 });
  if (!result || result.status !== 0) {
    const detail = (result && (result.stderr || result.stdout)) || 'no output';
    throw new Error(`ffmpeg failed (${result ? result.status : 'spawn error'}):\n${detail.trim().slice(0, 800)}`);
  }
}

/**
 * Encode one WAV to one target, stepping the bitrate down if the result is over
 * the size cap. Ambient noise is not kind to perceptual codecs, so the check is
 * worth doing rather than assuming bitrate × duration.
 */
function encodeOne(ff, wavPath, outPath, format, bitrates, maxBytes) {
  let last = null;
  for (const kbps of bitrates) {
    const args =
      format === 'ogg'
        ? [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', wavPath,
            '-ac', '1',
            '-c:a', ff.opus,
            '-b:a', `${kbps}k`,
            '-vbr', 'on',
            '-compression_level', '10',
            '-application', 'audio',
            '-frame_duration', '60',
            outPath,
          ]
        : [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', wavPath,
            '-ac', '1',
            '-c:a', ff.aac,
            '-b:a', `${kbps}k`,
            '-movflags', '+faststart',
            outPath,
          ];
    runFfmpeg(ff.bin, args);
    const size = fs.statSync(outPath).size;
    last = { kbps, size };
    if (size <= maxBytes) return last;
  }
  return last;
}

/* ========================================================================== *
 * Build
 * ========================================================================== */

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }

  fs.mkdirSync(opts.out, { recursive: true });

  const ff = findFfmpeg(opts.ffmpeg);
  if (ff.bin) {
    console.log(`ffmpeg: ${ff.bin}  (opus=${ff.opus}, aac=${ff.aac})`);
  } else {
    console.warn('ffmpeg: NOT FOUND with both an Opus and an AAC encoder.');
    console.warn('  Falling back to WAV-only output: 30 s beds at 22.05 kHz and full-rate cue tones.');
    console.warn('  Install ffmpeg and re-run to produce the real .ogg / .m4a pack.');
  }

  const beds = opts.only ? BEDS.filter((bed) => opts.only.includes(bed.name)) : BEDS;
  if (opts.only && beds.length !== opts.only.length) {
    const known = BEDS.map((b) => b.name).join(', ');
    console.warn(`Unknown bed name in --only. Known beds: ${known}`);
  }

  const loopSeconds = ff.bin ? opts.seconds : Math.min(opts.seconds, 30);
  const sr = ff.bin ? SR : FALLBACK_SR;
  const n = Math.round(loopSeconds * SR);
  const xf = Math.round(CROSSFADE_SECONDS * SR);

  const entries = [];
  let totalBytes = 0;
  const warnings = [];

  for (const bed of beds) {
    const rng = makeRng(seedFor(bed.name));
    process.stdout.write(`  ${bed.name.padEnd(12)}`);
    const samples = bed.render(n, xf, rng, loopSeconds);

    const wavPath = path.join(opts.out, `${bed.name}.wav`);
    const wavSamples = ff.bin ? samples : resample(samples.subarray(0, Math.round(loopSeconds * SR)), SR, sr);
    writeWav(wavPath, wavSamples, sr);

    const files = {};
    if (ff.bin) {
      const ogg = encodeOne(ff, wavPath, path.join(opts.out, `${bed.name}.ogg`), 'ogg', [opts.bitrate, 40, 32, 24], MAX_ENCODED_BYTES);
      const m4a = encodeOne(ff, wavPath, path.join(opts.out, `${bed.name}.m4a`), 'm4a', [opts.bitrate, 40, 32, 24], MAX_ENCODED_BYTES);
      files.ogg = `/audio/${bed.name}.ogg`;
      files.m4a = `/audio/${bed.name}.m4a`;
      totalBytes += ogg.size + m4a.size;
      console.log(`ogg ${humanBytes(ogg.size)} @${ogg.kbps}k   m4a ${humanBytes(m4a.size)} @${m4a.kbps}k`);
      if (ogg.size > MAX_ENCODED_BYTES) warnings.push(`${bed.name}.ogg is ${humanBytes(ogg.size)} (over ${humanBytes(MAX_ENCODED_BYTES)})`);
      if (m4a.size > MAX_ENCODED_BYTES) warnings.push(`${bed.name}.m4a is ${humanBytes(m4a.size)} (over ${humanBytes(MAX_ENCODED_BYTES)})`);
      if (!opts.keepWav) fs.unlinkSync(wavPath);
    } else {
      const size = fs.statSync(wavPath).size;
      files.wav = `/audio/${bed.name}.wav`;
      totalBytes += size;
      console.log(`wav ${humanBytes(size)} (no ffmpeg)`);
      warnings.push(`${bed.name} is WAV only — no ffmpeg with Opus + AAC was found`);
    }

    entries.push({
      name: bed.name,
      label: bed.label,
      description: bed.description,
      files,
      durationSec: loopSeconds,
      loop: true,
      license: LICENSE,
    });
  }

  const cueEntries = [];
  for (const cue of CUES) {
    process.stdout.write(`  ${cue.name.padEnd(12)}`);
    const samples = renderCue(cue.name, SR);
    const wavPath = path.join(opts.out, `${cue.name}.wav`);
    writeWav(wavPath, samples, SR);

    const files = {};
    if (ff.bin) {
      const ogg = encodeOne(ff, wavPath, path.join(opts.out, `${cue.name}.ogg`), 'ogg', [32, 24], MAX_ENCODED_BYTES);
      const m4a = encodeOne(ff, wavPath, path.join(opts.out, `${cue.name}.m4a`), 'm4a', [48, 32], MAX_ENCODED_BYTES);
      files.ogg = `/audio/${cue.name}.ogg`;
      files.m4a = `/audio/${cue.name}.m4a`;
      totalBytes += ogg.size + m4a.size;
      console.log(`ogg ${humanBytes(ogg.size)}   m4a ${humanBytes(m4a.size)}`);
      if (!opts.keepWav) fs.unlinkSync(wavPath);
    } else {
      const size = fs.statSync(wavPath).size;
      files.wav = `/audio/${cue.name}.wav`;
      totalBytes += size;
      console.log(`wav ${humanBytes(size)} (no ffmpeg)`);
    }

    cueEntries.push({
      name: cue.name,
      label: cue.label,
      description: cue.description,
      files,
      durationSec: Number((samples.length / SR).toFixed(3)),
      loop: false,
      license: LICENSE,
    });
  }

  // Only rewrite the manifest when a full build ran; a --only run must not drop
  // the beds it did not touch.
  const manifestPath = path.join(opts.out, 'manifest.json');
  let manifest = {
    version: 1,
    generated: new Date().toISOString().slice(0, 10),
    generator: 'tools/make-soundscapes.mjs',
    license: LICENSE,
    beds: entries,
    cues: cueEntries,
  };

  if (opts.only && fs.existsSync(manifestPath)) {
    try {
      const previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const merged = Array.isArray(previous.beds) ? [...previous.beds] : [];
      for (const entry of entries) {
        const index = merged.findIndex((bed) => bed.name === entry.name);
        if (index === -1) merged.push(entry);
        else merged[index] = entry;
      }
      // Keep the canonical order.
      const order = BEDS.map((bed) => bed.name);
      merged.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
      manifest.beds = merged;
    } catch {
      console.warn('  (could not read the previous manifest; writing a fresh one)');
    }
  }

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(`Wrote ${entries.length} bed(s) and ${cueEntries.length} cue(s) to ${path.relative(REPO_ROOT, opts.out) || '.'}`);
  console.log(`Total encoded size: ${humanBytes(totalBytes)}`);
  if (totalBytes > 8 * 1024 * 1024) {
    warnings.push(`the pack is ${humanBytes(totalBytes)}, over the 8 MB budget`);
  }
  for (const warning of warnings) console.warn(`WARNING: ${warning}`);

  // Always 0. A warning (WAV-only fallback, an oversized file) is something a
  // human has to look at, but it is not a reason to break a build script that
  // other tooling may chain onto.
  return 0;
}

process.exit(main());
