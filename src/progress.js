// Continue watching: where each profile got to in what it was watching.
//
// Nuvio's own sync API has no endpoint for playback positions, so they are
// kept here, on the bridge, one list per account *and* profile — the kids'
// profile doesn't see what the grown-ups were halfway through. Every device
// signed in to that profile shares the list, so a film paused on the TV
// resumes from the same point on the phone.

import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_DIR = process.env.STATE_DIR || '/data';
const FILE = path.join(STATE_DIR, 'progress.json');
const MAX_PER_PROFILE = 40;
// Watched this much: done. A film drops off the row; an episode is replaced
// by the next one, ready to start.
export const FINISHED = 0.92;
// Less than this watched: not worth a "continue" — they only peeked.
const MIN_SECONDS = 60;
// A channel stays on the row for a week after it was last watched.
const LIVE_DAYS = 7;

let lists = null; // key -> [entry]
let saving = null;

async function load() {
  if (lists) return lists;
  try {
    lists = new Map(Object.entries(JSON.parse(await fs.readFile(FILE, 'utf8'))));
  } catch {
    lists = new Map();
  }
  return lists;
}

function save() {
  // Writes are coalesced: the player reports every few seconds.
  if (saving) return saving;
  saving = new Promise((resolve) => {
    setTimeout(async () => {
      saving = null;
      try {
        await fs.mkdir(STATE_DIR, { recursive: true });
        const tmp = `${FILE}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(lists)), { mode: 0o600 });
        await fs.rename(tmp, FILE);
      } catch (err) {
        console.error(`progress: could not save (${err.message})`);
      }
      resolve();
    }, 2000);
  });
  return saving;
}

const keyFor = (user, profileIndex) => `${user.userId}:${profileIndex}`;

// The title an entry belongs to: an episode "tt123:2:5" belongs to "tt123".
export const baseId = (id) => String(id || '').split(':')[0];

// What one card on the row stands for. A show's episodes share a card; a
// live channel is its own card (channel ids contain ":" too — "iptv:fox-…" —
// so splitting them would lump every channel into one).
export const titleKey = (entry) => (entry.type === 'tv' ? String(entry.id) : baseId(entry.id));

export async function list(user, profileIndex) {
  const all = (await load()).get(keyFor(user, profileIndex)) || [];
  return [...all].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function get(user, profileIndex, id) {
  return (await list(user, profileIndex)).find((e) => e.id === id) || null;
}

/**
 * Record a position. One entry per title: a newer episode of a show replaces
 * the older one, so the row shows "the show", not every episode of it.
 */
export async function record(user, profileIndex, entry) {
  const map = await load();
  const key = keyFor(user, profileIndex);
  const all = map.get(key) || [];
  const rest = all.filter((e) => titleKey(e) !== titleKey(entry));
  const previous = all.find((e) => e.id === entry.id) || all.find((e) => titleKey(e) === titleKey(entry));
  const next = { ...previous, ...entry, updatedAt: Date.now() };
  map.set(key, [next, ...rest].slice(0, MAX_PER_PROFILE));
  save();
  return next;
}

export async function remove(user, profileIndex, id) {
  const map = await load();
  const key = keyFor(user, profileIndex);
  const all = map.get(key) || [];
  map.set(key, all.filter((e) => e.id !== id && (e.type === 'tv' || baseId(e.id) !== baseId(id))));
  save();
}

// Worth showing in the row: started properly, not finished — or an episode
// queued up next (position 0, marked upNext).
export function showable(entry) {
  // Live channels have no position: watched recently is enough.
  if (entry.live) return Date.now() - entry.updatedAt < LIVE_DAYS * 86400000;
  if (entry.upNext) return true;
  if (!entry.duration || entry.position < MIN_SECONDS) return false;
  return entry.position / entry.duration < FINISHED;
}
