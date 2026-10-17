// Per-user session storage.
//
// One record per signed-in *device*, addressed by an opaque cookie id, plus
// one record per account holding the settings that should follow a person
// between their devices. Several devices per account is the normal case.
//
// Records hold Supabase refresh tokens, which are long-lived credentials for
// someone else's account, so they are encrypted at rest with AES-256-GCM. The
// key comes from SESSION_SECRET, or is generated once into the data volume.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_DIR = process.env.STATE_DIR || '/data';
const STORE_FILE = path.join(STATE_DIR, 'sessions.json.enc');
const KEY_FILE = path.join(STATE_DIR, 'secret.key');
const IDLE_EXPIRY_MS = Number(process.env.SESSION_IDLE_DAYS || 60) * 86400_000;

let key = null;

async function loadKey() {
  if (process.env.SESSION_SECRET) {
    return crypto.createHash('sha256').update(process.env.SESSION_SECRET).digest();
  }
  try {
    return Buffer.from(await fs.readFile(KEY_FILE, 'utf8'), 'hex');
  } catch {
    const generated = crypto.randomBytes(32);
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(KEY_FILE, generated.toString('hex'), { mode: 0o600 });
    return generated;
  }
}

// Idempotent, and safe to call from anywhere that needs the key. The playlist
// store shares this key, and having it depend on session init having already
// run was an ordering trap waiting to be tripped.
export async function ready() {
  if (!key) key = await loadKey();
  return key;
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function decrypt(payload) {
  const raw = Buffer.from(payload, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// Two things are stored, and conflating them was the bug that kicked people
// off their other devices.
//
//   devices  — one per signed-in browser, holding that device's Supabase
//              tokens. Several per account is normal.
//   accounts — one per Nuvio user, holding the settings that should follow
//              the person around: profile, theme, playback prefs. Signing in
//              on a phone shouldn't reset the laptop.
/** @type {Map<string, object>} sid -> device */
const devices = new Map();
/** @type {Map<string, object>} userId -> account */
const accounts = new Map();

export async function init() {
  await ready();
  try {
    const stored = decryptJson(await fs.readFile(STORE_FILE, 'utf8'));
    load(stored);
    prune();
    // Shortcuts are retired. Drop any token left on an account record from an
    // older build and rewrite the store, so a retired credential doesn't sit
    // in the volume indefinitely.
    let dropped = false;
    for (const account of accounts.values()) {
      if ('shortcutToken' in account) {
        delete account.shortcutToken;
        dropped = true;
      }
    }
    if (dropped) await persist();
  } catch {
    // No store yet, or the secret changed. Everyone signs in again.
  }
}

// Accepts the old flat shape as well as the current one, so an upgrade
// doesn't sign everybody out.
function load(stored) {
  if (Array.isArray(stored)) {
    for (const record of stored) {
      accounts.set(record.userId, {
        userId: record.userId,
        email: record.email,
        profileIndex: record.profileIndex ?? null,
        theme: record.theme || 'White',
        prefs: record.prefs || {},
        createdAt: record.createdAt || Date.now(),
      });
      devices.set(record.sid, {
        sid: record.sid,
        userId: record.userId,
        session: record.session,
        createdAt: record.createdAt || Date.now(),
        lastSeen: record.lastSeen || Date.now(),
      });
    }
  } else {
    for (const account of stored.accounts || []) accounts.set(account.userId, account);
    for (const device of stored.devices || []) devices.set(device.sid, device);
  }
}

async function persist() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STORE_FILE, encryptJson({
    accounts: [...accounts.values()],
    devices: [...devices.values()],
  }), { mode: 0o600 });
}

// Only devices expire. An account outlives them, so the last device going
// idle doesn't wipe the settings for a person who comes back next month.
function prune() {
  const cutoff = Date.now() - IDLE_EXPIRY_MS;
  for (const [sid, device] of devices) {
    if ((device.lastSeen || 0) < cutoff) devices.delete(sid);
  }
}

// The view the rest of the app works with: this device's tokens merged with
// the account's settings.
function view(device) {
  const account = accounts.get(device.userId) || {};
  return {
    sid: device.sid,
    userId: device.userId,
    session: device.session,
    email: account.email,
    // The profile belongs to the device, not the account: someone switching
    // to their profile on the TV mustn't switch the phone in the next room.
    // Devices signed in before this change start on the profile the account
    // had, then go their own way.
    profileIndex: device.profileIndex !== undefined ? device.profileIndex : (account.profileIndex ?? null),
    theme: account.theme || 'White',
    prefs: account.prefs || {},
  };
}

// ------------------------------------------------------------------- api

export async function create(session) {
  const userId = session.user.id;

  // Settings are kept; only this device's tokens are new. Signing in again on
  // a device that is already signed in reuses its account row rather than
  // resetting anything.
  if (!accounts.has(userId)) {
    accounts.set(userId, {
      userId,
      email: session.user.email,
      profileIndex: null,
      theme: 'White',
      prefs: {},
      createdAt: Date.now(),
    });
  } else {
    accounts.get(userId).email = session.user.email;
  }

  const sid = crypto.randomBytes(24).toString('hex');
  // A new sign-in picks its own profile.
  devices.set(sid, { sid, userId, session, profileIndex: null, createdAt: Date.now(), lastSeen: Date.now() });
  await persist();
  return view(devices.get(sid));
}

export function get(sid) {
  if (!sid) return null;
  const device = devices.get(sid);
  if (!device) return null;
  device.lastSeen = Date.now();
  // lastSeen decides when an idle device is pruned, so it has to reach disk.
  // Otherwise a restart reloads the sign-in day's value and a device used
  // every day for two months is pruned as if it had been idle all along.
  if (Date.now() - (device.savedSeen || 0) > 6 * 3_600_000) {
    device.savedSeen = Date.now();
    persist().catch(() => {});
  }
  return view(device);
}

// Session tokens and the chosen profile belong to the device; everything
// else to the account. The
// passed-in view is updated too, so callers can read back what they just set.
export async function update(user, changes) {
  const device = devices.get(user.sid);
  const account = accounts.get(user.userId);

  if (changes.session && device) {
    device.session = changes.session;
    device.lastSeen = Date.now();
  }
  if ('profileIndex' in changes && device) device.profileIndex = changes.profileIndex;
  if (account) {
    for (const field of ['theme', 'prefs', 'email']) {
      if (field in changes) account[field] = changes[field];
    }
  }

  Object.assign(user, changes);
  await persist();
  return user;
}

// Signs out one device. The account and its other devices are untouched.
export async function destroy(sid) {
  devices.delete(sid);
  await persist();
}

// Every device belonging to an account — for a "sign out everywhere" action.
export function devicesFor(userId) {
  return [...devices.values()]
    .filter((d) => d.userId === userId)
    .map((d) => ({ sid: d.sid, createdAt: d.createdAt, lastSeen: d.lastSeen }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

export async function destroyAll(userId) {
  for (const [sid, device] of devices) {
    if (device.userId === userId) devices.delete(sid);
  }
  await persist();
}

export function count() {
  return devices.size;
}

export function accountCount() {
  return accounts.size;
}

// Shared with the playlist store, which holds resolved stream URLs — often
// debrid links tied to the account — and wants the same protection at rest.
export function encryptJson(value) {
  if (!key) throw new Error('Encryption key not loaded — call ready() first.');
  return encrypt(JSON.stringify(value));
}

export function decryptJson(payload) {
  if (!key) throw new Error('Encryption key not loaded — call ready() first.');
  return JSON.parse(decrypt(payload));
}
