// Subtitle sync: lining a subtitle file up with the film's own dialogue.
//
// A subtitle made for another release of the same film is off by a constant
// (a different intro or studio logo), drifts (23.976 vs 25 fps), or both.
// This finds the correction by listening:
//
//   1. A few short stretches of the soundtrack, spread across the film, are
//      read and turned into "someone is talking / nobody is" every 100 ms
//      (speech-band energy, against a threshold set per stretch, so loud
//      action and quiet drama are judged alike).
//   2. The subtitle gives the same thing for free: a line is up, or isn't.
//   3. Every speed in COMMON_SCALES and every offset within ±MAX_OFFSET is
//      tried, and the one where the two agree best wins.
//
// The agreement is a correlation, so it also says how sure it is. A
// correction is only applied when it is clearly better than leaving the file
// alone — a wrong "fix" would be worse than none.

import { spawn } from 'node:child_process';

const WINDOWS = Number(process.env.SUBSYNC_WINDOWS || 8);
const WINDOW_SECS = Number(process.env.SUBSYNC_WINDOW_SECS || 45);
const PARALLEL = 4;
const BIN = 0.1;
const MAX_OFFSET = Number(process.env.SUBSYNC_MAX_OFFSET || 90);
const STEP = 0.1;
// Frame-rate conversions between the release a subtitle was made for and
// this one: 23.976 <-> 25 (PAL speed-up), 23.976 <-> 24.
const COMMON_SCALES = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24];
const MIN_SCORE = 0.12;
const MIN_GAIN = 0.03;

const INPUT = [
  '-hide_banner', '-loglevel', 'error', '-nostdin',
  '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
  '-rw_timeout', '15000000', '-user_agent', 'Mozilla/5.0',
];

// ------------------------------------------------------------- the audio

// 100 ms speech/no-speech flags for one stretch of the film.
function speechWindow(url, audio, start, length) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', [
      ...INPUT, '-ss', start.toFixed(2), '-i', url, '-t', String(length),
      '-map', `0:a:${audio}?`, '-vn', '-sn', '-ac', '1', '-ar', '8000',
      // Voices live here; most music and explosions mostly don't.
      '-af', 'highpass=f=250,lowpass=f=3200',
      '-f', 's16le', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('close', () => {
      clearTimeout(timer);
      const pcm = Buffer.concat(chunks);
      const perBin = Math.round(8000 * BIN);
      const energy = [];
      for (let i = 0; i + perBin * 2 <= pcm.length; i += perBin * 2) {
        let sum = 0;
        for (let j = 0; j < perBin; j += 1) {
          const v = pcm.readInt16LE(i + j * 2);
          sum += v * v;
        }
        energy.push(Math.log10(1 + sum / perBin));
      }
      if (energy.length < 50) { resolve(null); return; }
      const sorted = [...energy].sort((a, b) => a - b);
      const low = sorted[Math.floor(sorted.length * 0.2)];
      const high = sorted[Math.floor(sorted.length * 0.9)];
      if (high - low < 0.3) { resolve(null); return; } // silence or flat noise
      const threshold = low + (high - low) * 0.45;
      // A short smoothing, so breaths between words don't count as silence.
      const raw = energy.map((e) => (e > threshold ? 1 : 0));
      const flags = raw.map((_, i) => (raw[i] || (raw[i - 1] && raw[i + 1]) ? 1 : 0));
      resolve({ start, flags });
    });
  });
}

async function speech(url, audio, duration) {
  const length = Math.min(WINDOW_SECS, duration / (WINDOWS + 1));
  const starts = [];
  for (let i = 0; i < WINDOWS; i += 1) {
    // Evenly through the film, skipping the very start and end (logos,
    // credits), where there's rarely dialogue to go on.
    starts.push(duration * (0.06 + (0.88 * i) / Math.max(1, WINDOWS - 1)) - length / 2);
  }
  const out = [];
  for (let i = 0; i < starts.length; i += PARALLEL) {
    const batch = await Promise.all(starts.slice(i, i + PARALLEL)
      .map((s) => speechWindow(url, audio, Math.max(0, s), length)));
    out.push(...batch.filter(Boolean));
  }
  return out;
}

// ------------------------------------------------------------ the subtitle

function stamp(text) {
  const parts = text.trim().split(':').map(Number);
  return parts.reduce((total, n) => total * 60 + n, 0);
}

export function parseCues(vtt) {
  const cues = [];
  for (const line of String(vtt).replace(/\r/g, '').split('\n')) {
    if (!line.includes('-->')) continue;
    const [a, rest] = line.split('-->');
    const start = stamp(a);
    const end = stamp(rest.trim().split(/\s+/)[0]);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) cues.push([start, end]);
  }
  return cues;
}

// Lookup table: is a line up at subtitle time t? 50 ms resolution.
function subtitleMask(cues) {
  const RES = 0.05;
  const last = cues.reduce((m, c) => Math.max(m, c[1]), 0);
  const mask = new Uint8Array(Math.ceil(last / RES) + 2);
  for (const [a, b] of cues) mask.fill(1, Math.floor(a / RES), Math.ceil(b / RES));
  return (t) => (t < 0 ? 0 : mask[Math.floor(t / RES)] || 0);
}

// ---------------------------------------------------------------- matching

// Correlation between "someone is talking" and "a line is up" when the
// subtitle is shown at time = t * scale + offset.
function score(windows, active, scale, offset) {
  let n = 0; let sx = 0; let sy = 0; let sxy = 0;
  for (const w of windows) {
    for (let i = 0; i < w.flags.length; i += 1) {
      const t = w.start + (i + 0.5) * BIN;
      const x = w.flags[i];
      const y = active((t - offset) / scale);
      n += 1; sx += x; sy += y; sxy += x * y;
    }
  }
  if (!n) return 0;
  const px = sx / n; const py = sy / n;
  const denom = Math.sqrt(px * (1 - px) * py * (1 - py));
  return denom ? (sxy / n - px * py) / denom : 0;
}

/**
 * Find the correction for a subtitle against a film's audio.
 *
 * @param {object} opts
 * @param {string} opts.url       the film
 * @param {number} opts.audio     audio track index (as in 0:a:N)
 * @param {number} opts.duration  seconds
 * @param {string} opts.vtt       the subtitle, as WebVTT
 * @returns {Promise<{ offset: number, scale: number, score: number, before: number, applied: boolean, reason?: string }>}
 */
export async function sync({ url, audio = 0, duration, vtt }) {
  const cues = parseCues(vtt);
  if (cues.length < 20) return { offset: 0, scale: 1, score: 0, before: 0, applied: false, reason: 'too few lines' };
  if (!duration) return { offset: 0, scale: 1, score: 0, before: 0, applied: false, reason: 'no duration' };

  const windows = await speech(url, audio, duration);
  if (windows.length < 3) return { offset: 0, scale: 1, score: 0, before: 0, applied: false, reason: 'no usable audio' };

  const active = subtitleMask(cues);
  const before = score(windows, active, 1, 0);
  let best = { scale: 1, offset: 0, score: before };
  for (const scale of COMMON_SCALES) {
    // Coarse pass every 0.5 s, then refine around the best at 0.1 s.
    let local = { offset: 0, score: -1 };
    for (let off = -MAX_OFFSET; off <= MAX_OFFSET; off += 0.5) {
      const s = score(windows, active, scale, off);
      if (s > local.score) local = { offset: off, score: s };
    }
    for (let off = local.offset - 0.5; off <= local.offset + 0.5; off += STEP) {
      const s = score(windows, active, scale, off);
      if (s > local.score) local = { offset: off, score: s };
    }
    if (local.score > best.score) best = { scale, offset: local.offset, score: local.score };
  }

  const result = {
    offset: Math.round(best.offset * 10) / 10,
    scale: best.scale,
    score: Math.round(best.score * 1000) / 1000,
    before: Math.round(before * 1000) / 1000,
  };
  const changed = Math.abs(result.offset) >= 0.2 || result.scale !== 1;
  if (!changed) return { ...result, offset: 0, scale: 1, applied: false, reason: 'already in sync' };
  if (best.score < MIN_SCORE) return { ...result, applied: false, reason: 'not confident' };
  if (best.score - before < MIN_GAIN) return { ...result, applied: false, reason: 'no clear improvement' };
  return { ...result, applied: true };
}

/** Rewrite a WebVTT file's times: t' = t * scale + offset. */
export function retime(vtt, { offset = 0, scale = 1 }) {
  const fmt = (t) => {
    const v = Math.max(0, t);
    const h = Math.floor(v / 3600);
    const m = Math.floor((v % 3600) / 60);
    const s = (v % 60).toFixed(3).padStart(6, '0');
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s}`;
  };
  return String(vtt).replace(/^([\d:.]+)\s*-->\s*([\d:.]+)/gm,
    (_, a, b) => `${fmt(stamp(a) * scale + offset)} --> ${fmt(stamp(b) * scale + offset)}`);
}
