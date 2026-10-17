// Binge playlists.
//
// Chaining episodes through VLC's x-success works, but it makes every episode
// a round trip out to Safari and back, and VLC has no idea the queue exists —
// no next/previous, no "up next", and backing out ends the run. Handing VLC an
// M3U instead gives it a real playlist it can page through on its own.
//
// A record is created when playback starts and holds only the episode ids.
// The streams are resolved when VLC actually fetches the file, then cached for
// the life of the record, so building a playlist costs nothing until it's used.
//
// Records expire after 24 hours. That's not arbitrary: the URLs inside are
// usually debrid links, which go stale on roughly that timescale anyway, so a
// longer-lived playlist would just be a list of dead links.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { encryptJson, decryptJson, ready } from './sessions.js';

const STATE_DIR = process.env.STATE_DIR || '/data';
const STORE_FILE = path.join(STATE_DIR, 'playlists.json.enc');
export const TTL_MS = Number(process.env.PLAYLIST_TTL_HOURS || 24) * 3_600_000;

/** @type {Map<string, object>} token -> record */
const byToken = new Map();

export async function init() {
  await ready();
  try {
    const records = decryptJson(await fs.readFile(STORE_FILE, 'utf8'));
    for (const record of records) byToken.set(record.token, record);
    prune();
  } catch {
    // No store yet, or the secret changed. Playlists are disposable.
  }
}

async function persist() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STORE_FILE, encryptJson([...byToken.values()]), { mode: 0o600 });
}

function prune() {
  const now = Date.now();
  for (const [token, record] of byToken) {
    if (record.expiresAt <= now) byToken.delete(token);
  }
}

export async function create({
  sid, type, seriesId, episodes, quality, audioLang, subLang, subsOff = false, firstStream, label,
}) {
  await ready();
  prune();
  const token = crypto.randomBytes(24).toString('hex');
  byToken.set(token, {
    token,
    sid,
    type,
    seriesId,
    episodes,          // [{ id, season, episode, title }]
    quality,
    audioLang,         // ISO 639-1, or empty for no preference
    subLang,
    subsOff,           // Settings → Subtitles off: VLC shows none, not even the file's default
    firstStream,       // a hand-picked stream for episode one, if there was one
    label,             // what to call this in a player's title bar
    rendered: null,
    report: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
  });
  await persist();
  return token;
}

export function get(token) {
  const record = byToken.get(token);
  if (!record) return null;
  if (record.expiresAt <= Date.now()) {
    byToken.delete(token);
    return null;
  }
  return record;
}

export async function setRendered(token, rendered) {
  const record = byToken.get(token);
  if (!record) return;
  record.rendered = rendered;
  await persist();
}

// What happened to each episode while the playlist was built. Kept so a short
// playlist can be explained after the fact rather than guessed at.
export async function setReport(token, report) {
  const record = byToken.get(token);
  if (!record) return;
  record.report = report;
  await persist();
}

export function count() {
  prune();
  return byToken.size;
}

// M3U with #EXTINF titles, so VLC's playlist view shows "S1E3 - Spoonful"
// rather than a column of opaque CDN filenames.
//
// Order matters: #EXTVLCOPT lines belong *between* the #EXTINF and the URL.
// libvlc accumulates options until it sees a URL, so putting them before the
// #EXTINF can attach them to the previous entry instead of this one — which
// looks exactly like VLC randomly skipping items.
export function render(entries) {
  const lines = ['#EXTM3U'];
  for (const entry of entries) {
    lines.push(`#EXTINF:-1,${sanitize(entry.title)}`);
    for (const option of entry.options || []) lines.push(`#EXTVLCOPT:${sanitize(option)}`);
    lines.push(entry.url);
  }
  return `${lines.join('\n')}\n`;
}

// The options VLC needs for one entry, given the resolved preferences.
//
// Only `name=value` options go here. A bare flag with no value is not valid in
// an #EXTVLCOPT line, and an option VLC can't parse can make it reject the
// whole item and move to the next one.
export function optionsFor({ audioLang, subLang, subtitleUrl, subsOff = false }) {
  const options = [];
  if (audioLang) options.push(`audio-language=${audioLang}`);
  // Off means off: VLC otherwise turns on whatever track the file marks as
  // default, which is why subtitles appeared with the setting switched off.
  // ('none' is VLC's word for "no subtitle track, and no fallback".)
  if (subsOff) options.push('sub-language=none', 'no-sub-autodetect-file');
  else if (subLang) options.push(`sub-language=${subLang}`);
  // input-slave is how libvlc side-loads a subtitle track onto a stream. Only
  // ever set this to a URL that has been checked — an unreachable slave can
  // fail the item it's attached to.
  if (subtitleUrl) options.push(`input-slave=${subtitleUrl}`);
  return options;
}

// The reverse of render(). The browser player needs the same queue VLC gets,
// and rendering to text and reading it back keeps one source of truth: if an
// episode is in VLC's playlist it is in the web player's, with the same title
// and the same subtitle attached.
export function parse(text) {
  const entries = [];
  let title = null;
  let options = [];

  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line === '#EXTM3U') continue;

    if (line.startsWith('#EXTINF:')) {
      title = line.slice(line.indexOf(',') + 1);
      options = [];
    } else if (line.startsWith('#EXTVLCOPT:')) {
      options.push(line.slice('#EXTVLCOPT:'.length));
    } else if (!line.startsWith('#')) {
      entries.push({ url: line, title: title || 'Nuvio', options });
      title = null;
      options = [];
    }
  }
  return entries;
}

// Newlines would end the directive early and corrupt the playlist; commas are
// fine after the first one, but control characters are not.
function sanitize(text) {
  return String(text).replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u001f]/g, '').trim();
}
