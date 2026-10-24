// Live TV: Xtream Codes logins and M3U playlists, their categories, the TV
// guide (XMLTV) and catch-up. A port of NuvioPlusIPTV's Live TV repository
// to the server, so every device signed in to the same Nuvio account sees the
// same playlists, guide, favourites and settings.
//
// Everything is per Nuvio user (userId), never global. Logins hold provider
// passwords, so the store and the channel cache (whose links carry them) are
// encrypted with the same key as the sessions. The guide is not secret and is
// kept as plain gzip.
//
// Playlists and guides are downloaded again every REFRESH_HOURS (3) for each
// user, by a scheduler that runs whether or not anyone has the app open.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';

import { encryptJson, decryptJson, ready } from './sessions.js';
import * as xmltv from './xmltv.js';
import * as catchupLib from './catchup.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const STATE_DIR = process.env.STATE_DIR || '/data';
const STORE_FILE = path.join(STATE_DIR, 'iptv.json.enc');
const CACHE_DIR = path.join(STATE_DIR, 'iptv');
export const REFRESH_HOURS = Number(process.env.IPTV_REFRESH_HOURS || 3);
const REFRESH_MS = REFRESH_HOURS * 3_600_000;
const HTTP_TIMEOUT_MS = Number(process.env.IPTV_HTTP_TIMEOUT_MS || 60_000);
export const DEFAULT_UA = 'Mozilla/5.0 (Linux; Android 12; Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const HOUR = 3_600_000;

export const DEFAULT_SETTINGS = {
  showChannelNames: true,
  showChannelNumbers: true,
  showChannelLogos: true,
  showPreview: true,
  showProgramDetails: true,
  showFavoritesGroup: true,
  showRecentGroup: true,
  showAllChannelsGroup: true,
  showGroupCounts: true,
  groupPlaylistHeadings: true,
  showProgramTimes: false,
  showEpisodeNumbers: true,
  guideSize: 'STANDARD',      // COMPACT, STANDARD, LARGE, XLARGE
  stripeMissingGuide: true,
  showNowLine: true,
  solidHighlight: false,
  smallHeader: false,
  use24HourClock: false,
  epgOffsetMinutes: 0,
  epgPastHours: 24,
  epgFutureDays: 3,
  catchupPreferHls: true,
  catchupShiftMinutes: 0,
  channelSort: 'PLAYLIST',     // PLAYLIST, NUMBER, NAME
  nameRemovals: '',
};

// ------------------------------------------------------------------ store

/** @type {Map<string, object>} userId -> { sources, epgs, favorites, recent, hiddenChannels, hiddenGroups, settings, accounts, lastRefreshAt } */
const users = new Map();
/** @type {Map<string, object>} userId -> loaded channels/guide in memory */
const runtime = new Map();

let saveTimer = null;

export async function init() {
  await ready();
  await fs.mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
  try {
    const stored = decryptJson(await fs.readFile(STORE_FILE, 'utf8'));
    for (const [id, rec] of Object.entries(stored || {})) users.set(id, normalizeRecord(rec));
  } catch { /* nothing stored yet */ }
  startScheduler();
}

function normalizeRecord(rec = {}) {
  return {
    sources: rec.sources || [],
    epgs: rec.epgs || [],
    favorites: rec.favorites || [],
    recent: rec.recent || [],
    hiddenChannels: rec.hiddenChannels || [],
    hiddenGroups: rec.hiddenGroups || [],
    collapsed: rec.collapsed || [],
    settings: { ...DEFAULT_SETTINGS, ...(rec.settings || {}) },
    accounts: rec.accounts || {},
    lastRefreshAt: rec.lastRefreshAt || 0,
  };
}

function record(userId) {
  if (!users.has(userId)) users.set(userId, normalizeRecord());
  return users.get(userId);
}

function persistSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 300);
}

async function persistNow() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const all = Object.fromEntries(users);
  await fs.writeFile(STORE_FILE, encryptJson(all), { mode: 0o600 });
}

const fileId = (userId) => crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 24);
const channelsFile = (userId) => path.join(CACHE_DIR, `${fileId(userId)}.channels.enc`);
const guideFile = (userId) => path.join(CACHE_DIR, `${fileId(userId)}.guide.json.gz`);

function rt(userId) {
  if (!runtime.has(userId)) {
    runtime.set(userId, {
      channels: [], byKey: new Map(), groups: [], programs: new Map(), epgLogos: new Map(),
      status: { loading: false, message: null }, loaded: false, refreshing: null,
      archiveFetched: new Set(), archivePausedUntil: 0,
    });
  }
  return runtime.get(userId);
}

// ------------------------------------------------------------------ public: sources

export function cleanServer(raw) {
  let s = String(raw || '').trim();
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return s.replace(/\/+$/, '');
  }
}

export function credentialsFromLink(raw) {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    const user = u.searchParams.get('username');
    const pass = u.searchParams.get('password');
    return user && pass ? { user, pass } : null;
  } catch { return null; }
}

function publicSource(s, accounts) {
  return {
    id: s.id, name: s.name, kind: s.kind, enabled: s.enabled,
    url: s.kind === 'm3u' ? s.url : undefined,
    server: s.kind === 'xtream' ? s.server : undefined,
    username: s.kind === 'xtream' ? s.username : undefined,
    hasPassword: s.kind === 'xtream' ? Boolean(s.password) : undefined,
    userAgent: s.userAgent || '',
    useEmbeddedEpg: s.useEmbeddedEpg !== false,
    importLive: s.importLive !== false,
    streamFormat: s.streamFormat || 'auto',
    logoSource: s.logoSource || 'playlist',
    serverTimezone: s.serverTimezone || '',
    lastUpdatedMs: s.lastUpdatedMs || 0,
    lastError: s.lastError || null,
    channelCount: s.channelCount || 0,
    account: accounts[s.id] || null,
  };
}

/**
 * Playlist logins with their passwords, for the Android TV app's sync (it
 * already signed in as this account). Never sent to the web pages.
 */
export function exportSources(userId) {
  return {
    sources: record(userId).sources.map((s) => ({
      id: s.id, kind: s.kind, name: s.name, enabled: s.enabled !== false,
      server: s.kind === 'xtream' ? s.server : undefined,
      username: s.kind === 'xtream' ? s.username : undefined,
      password: s.kind === 'xtream' ? s.password : undefined,
      url: s.kind === 'm3u' ? s.url : undefined,
      userAgent: s.userAgent || '',
    })),
  };
}

export function overview(userId) {
  const rec = record(userId);
  const state = rt(userId);
  return {
    sources: rec.sources.map((s) => publicSource(s, rec.accounts)),
    epgs: rec.epgs.map((e) => ({ ...e })),
    settings: rec.settings,
    status: state.status,
    refreshHours: REFRESH_HOURS,
    lastRefreshAt: rec.lastRefreshAt,
  };
}

export function addXtream(userId, { name, server, username, password, importLive = true, userAgent = '' }) {
  const fromLink = credentialsFromLink(server || '');
  const user = String(username || '').trim() || fromLink?.user || '';
  const pass = String(password || '').trim() || fromLink?.pass || '';
  const srv = cleanServer(server);
  if (!srv) throw httpError(400, 'Enter the server address.');
  if (!user || !pass) throw httpError(400, 'Enter the username and password.');
  const source = {
    id: crypto.randomUUID(), kind: 'xtream', name: String(name || '').trim() || 'Xtream',
    server: srv, username: user, password: pass, enabled: true,
    importLive: importLive !== false, useEmbeddedEpg: true, streamFormat: 'auto',
    userAgent: String(userAgent || '').trim(),
  };
  record(userId).sources.push(source);
  persistSoon();
  refresh(userId, { only: [source.id] }).catch(() => {});
  return source.id;
}

export function addM3u(userId, { name, url, userAgent = '' }) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) throw httpError(400, 'Enter the playlist link (http… or https…).');
  const source = {
    id: crypto.randomUUID(), kind: 'm3u', name: String(name || '').trim() || 'Playlist',
    url: u, enabled: true, useEmbeddedEpg: true, userAgent: String(userAgent || '').trim(),
  };
  record(userId).sources.push(source);
  persistSoon();
  refresh(userId, { only: [source.id] }).catch(() => {});
  return source.id;
}

export function updateSource(userId, id, changes = {}) {
  const rec = record(userId);
  const s = rec.sources.find((x) => x.id === id);
  if (!s) throw httpError(404, 'No such playlist.');
  const allowed = ['name', 'enabled', 'userAgent', 'useEmbeddedEpg', 'importLive', 'streamFormat'];
  for (const k of allowed) if (k in changes) s[k] = changes[k];
  if (s.kind === 'xtream') {
    if (changes.server) {
      const fromLink = credentialsFromLink(changes.server);
      s.server = cleanServer(changes.server);
      if (fromLink && !changes.username) { s.username = fromLink.user; s.password = fromLink.pass; }
    }
    if (changes.username) s.username = String(changes.username).trim();
    if (changes.password) s.password = String(changes.password).trim();
  } else if (changes.url) {
    s.url = String(changes.url).trim();
  }
  if (!['auto', 'ts', 'm3u8'].includes(s.streamFormat)) s.streamFormat = 'auto';
  persistSoon();
  refresh(userId, { only: [id] }).catch(() => {});
}

export function removeSource(userId, id) {
  const rec = record(userId);
  rec.sources = rec.sources.filter((s) => s.id !== id);
  delete rec.accounts[id];
  persistSoon();
  refresh(userId, { only: [] }).catch(() => {});
}

export function moveSource(userId, id, delta) {
  const list = record(userId).sources;
  const i = list.findIndex((s) => s.id === id);
  const j = i + Number(delta);
  if (i < 0 || j < 0 || j >= list.length) return;
  list.splice(j, 0, list.splice(i, 1)[0]);
  persistSoon();
  rebuildGroups(userId);
}

export function addEpg(userId, { name, url }) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) throw httpError(400, 'Enter the XMLTV link (http… or https…).');
  const epg = { id: crypto.randomUUID(), name: String(name || '').trim() || 'Guide', url: u, enabled: true };
  record(userId).epgs.push(epg);
  persistSoon();
  refreshGuide(userId).catch(() => {});
  return epg.id;
}

export function updateEpg(userId, id, changes = {}) {
  const e = record(userId).epgs.find((x) => x.id === id);
  if (!e) throw httpError(404, 'No such guide.');
  for (const k of ['name', 'url', 'enabled']) if (k in changes) e[k] = changes[k];
  persistSoon();
  refreshGuide(userId).catch(() => {});
}

export function removeEpg(userId, id) {
  const rec = record(userId);
  rec.epgs = rec.epgs.filter((e) => e.id !== id);
  persistSoon();
  refreshGuide(userId).catch(() => {});
}

export function saveSettings(userId, changes = {}) {
  const rec = record(userId);
  for (const [k, v] of Object.entries(changes)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[k];
    if (typeof def === 'boolean') rec.settings[k] = Boolean(v);
    else if (typeof def === 'number') rec.settings[k] = Number.isFinite(Number(v)) ? Number(v) : def;
    else rec.settings[k] = String(v ?? '');
  }
  rec.settings.epgFutureDays = Math.min(14, Math.max(1, rec.settings.epgFutureDays));
  persistSoon();
  if ('nameRemovals' in changes || 'channelSort' in changes) rebuildGroups(userId);
  return rec.settings;
}

// ------------------------------------------------------------------ public: user state

export function toggleFavorite(userId, key) {
  const rec = record(userId);
  const i = rec.favorites.indexOf(key);
  if (i >= 0) rec.favorites.splice(i, 1); else rec.favorites.push(key);
  persistSoon();
  return i < 0;
}

/** Puts favorites in the given order (the TV app's sync). Ones not listed keep their place at the end. */
export function setFavoriteOrder(userId, keys) {
  const rec = record(userId);
  const want = (Array.isArray(keys) ? keys : []).map(String);
  const have = new Set(rec.favorites);
  const ordered = want.filter((k, i) => have.has(k) && want.indexOf(k) === i);
  const rest = rec.favorites.filter((k) => !ordered.includes(k));
  rec.favorites = [...ordered, ...rest];
  persistSoon();
}

export function moveFavorite(userId, key, delta) {
  const list = record(userId).favorites;
  const i = list.indexOf(key);
  const j = i + Number(delta);
  if (i < 0 || j < 0 || j >= list.length) return;
  list.splice(j, 0, list.splice(i, 1)[0]);
  persistSoon();
}

export function setHidden(userId, { channel, group, hidden, all }) {
  const rec = record(userId);
  if (all && !hidden) { rec.hiddenChannels = []; persistSoon(); return; }
  const listName = channel ? 'hiddenChannels' : 'hiddenGroups';
  const id = channel || group;
  if (!id) return;
  const set = new Set(rec[listName]);
  if (hidden) set.add(id); else set.delete(id);
  rec[listName] = [...set];
  persistSoon();
}

export function setCollapsed(userId, sourceId, collapsed) {
  const rec = record(userId);
  const set = new Set(rec.collapsed);
  if (collapsed) set.add(sourceId); else set.delete(sourceId);
  rec.collapsed = [...set];
  persistSoon();
}

function remember(userId, key) {
  const rec = record(userId);
  rec.recent = [key, ...rec.recent.filter((k) => k !== key)].slice(0, 50);
  persistSoon();
}

// ------------------------------------------------------------------ logos

// Channel logos go through this server. Provider logo links are very often
// plain http (blocked on an https page), slow, or on hosts that refuse
// browsers; here they are fetched once, kept, and served with long caching.
// Links are signed so the route can't be used to fetch anything else, and
// the signature is stable so the browser's cache keeps working.
let logoKey = null;
async function logoMac(url) {
  logoKey ||= crypto.createHash('sha256').update(Buffer.concat([await ready(), Buffer.from('logos')])).digest();
  return crypto.createHmac('sha256', logoKey).update(url).digest('base64url').slice(0, 22);
}
const logoMacSync = (url) => crypto.createHmac('sha256', logoKey).update(url).digest('base64url').slice(0, 22);

function logoPath(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return `/api/iptv/logo?u=${Buffer.from(url).toString('base64url')}&s=${logoMacSync(url)}`;
}

const logoCache = new Map(); // url -> { type, body, at } | { missing: true, at }
let logoBytes = 0;
const LOGO_CACHE_BYTES = 64 * 1024 * 1024;

export async function logo(u, sig) {
  let url;
  try { url = Buffer.from(String(u || ''), 'base64url').toString('utf8'); } catch { return null; }
  if (!/^https?:\/\//i.test(url) || (await logoMac(url)) !== sig) return { status: 403 };
  const hit = logoCache.get(url);
  if (hit && (hit.body || Date.now() - hit.at < HOUR)) {
    logoCache.delete(url); logoCache.set(url, hit); // most recently used last
    return hit.body ? { status: 200, type: hit.type, body: hit.body } : { status: 404 };
  }
  try {
    const res = await fetchWithTimeout(url, DEFAULT_UA, 15_000);
    const type = res.headers.get('content-type') || '';
    const body = Buffer.from(await res.arrayBuffer());
    res.cancelTimer?.();
    if (!res.ok || !/^image\//i.test(type) || !body.length || body.length > 2 * 1024 * 1024) throw new Error('not an image');
    logoCache.set(url, { type, body, at: Date.now() });
    logoBytes += body.length;
    for (const [k, v] of logoCache) {
      if (logoBytes <= LOGO_CACHE_BYTES) break;
      logoBytes -= v.body?.length || 0; logoCache.delete(k);
    }
    return { status: 200, type, body };
  } catch {
    logoCache.set(url, { missing: true, at: Date.now() });
    return { status: 404 };
  }
}

export function setLogoSource(userId, id, logoSource) {
  const src = record(userId).sources.find((x) => x.id === id);
  if (!src) throw httpError(404, 'No such playlist.');
  src.logoSource = logoSource === 'epg' ? 'epg' : 'playlist';
  persistSoon();
}

// ------------------------------------------------------------------ public: channels & guide

export async function channels(userId) {
  await ensureLoaded(userId);
  const rec = record(userId);
  const state = rt(userId);
  const hiddenCh = new Set(rec.hiddenChannels);
  const hiddenGr = new Set(rec.hiddenGroups);
  const visible = state.channels.filter((c) => !hiddenCh.has(c.key) && !hiddenGr.has(c.groupId));
  const names = Object.fromEntries(rec.sources.map((s) => [s.id, s.name]));
  await logoMac('');
  const preferEpg = new Set(rec.sources.filter((s) => s.logoSource === 'epg').map((s) => s.id));
  return {
    channels: visible.map((c) => {
      // Whose logo leads: the playlist's or the guide's (Edit playlist →
      // Logos), each falling back to the other.
      const own = c.logo || null;
      const guideLogo = state.epgLogos.get(c.key) || null;
      const [first, second] = preferEpg.has(c.sourceId) ? [guideLogo, own] : [own, guideLogo];
      return {
      key: c.key, sourceId: c.sourceId, name: c.name, number: c.number,
      logo: logoPath(first || second),
      logoAlt: first && second && first !== second ? logoPath(second) : null,
      groupId: c.groupId, group: c.group,
      catchup: c.catchup ? { days: c.catchup.days } : null,
      };
    }),
    groups: state.groups.filter((g) => !hiddenGr.has(g.id)).map((g) => ({
      ...g, count: g.keys.filter((k) => !hiddenCh.has(k)).length, keys: undefined,
    })),
    hiddenGroups: state.groups.filter((g) => hiddenGr.has(g.id)).map((g) => ({ id: g.id, title: g.title, sourceId: g.sourceId })),
    hiddenChannels: rec.hiddenChannels.length,
    playlists: names,
    favorites: rec.favorites,
    recent: rec.recent,
    collapsed: rec.collapsed,
    settings: rec.settings,
    status: state.status,
    sourceCount: rec.sources.filter((s) => s.enabled).length,
  };
}

// Listings for some channels between two times. The guide time shift is
// applied here, so every device sees the same corrected times.
export async function guide(userId, keys, from, to) {
  await ensureLoaded(userId);
  const state = rt(userId);
  const shift = (record(userId).settings.epgOffsetMinutes || 0) * 60_000;
  const out = {};
  for (const key of (keys || []).slice(0, 2000)) {
    const list = state.programs.get(key);
    if (!list) continue;
    const slice = [];
    for (const p of list) {
      const s = p.s + shift; const e = p.e + shift;
      if (e > from && s < to) slice.push(shift ? { ...p, s, e } : p);
    }
    if (slice.length) out[key] = slice;
  }
  return out;
}

// Favorites for the home screen row, as the TV app shows them: logo, what's
// on now with its progress, and the channel. In your Favorites order.
export async function homeRow(userId) {
  await ensureLoaded(userId);
  const rec = record(userId);
  const all = await channels(userId);
  const byKey = new Map(all.channels.map((c) => [c.key, c]));
  const keys = rec.favorites.filter((k) => byKey.has(k));
  if (!keys.length) return { title: 'Live TV', entries: [] };
  const now = Date.now();
  const progs = await guide(userId, keys, now - 6 * HOUR, now + 12 * HOUR);
  return {
    title: 'Live TV',
    entries: keys.map((k) => {
      const list = progs[k] || [];
      const i = list.findIndex((p) => now >= p.s && now < p.e);
      const cur = i >= 0 ? list[i] : null;
      const next = (i >= 0 ? list[i + 1] : list.find((p) => p.s > now)) || null;
      return {
        channel: byKey.get(k),
        now: cur ? { t: cur.t, s: cur.s, e: cur.e } : null,
        next: next ? { t: next.t, s: next.s } : null,
      };
    }),
  };
}

export async function search(userId, query) {
  await ensureLoaded(userId);
  const q = normalize(query);
  if (!q) return { channels: [], programs: [] };
  const state = rt(userId);
  const hidden = new Set(record(userId).hiddenChannels);
  const now = Date.now();
  const chans = state.channels.filter((c) => !hidden.has(c.key) && normalize(c.name).includes(q)).slice(0, 60).map((c) => c.key);
  const programs = [];
  for (const [key, list] of state.programs) {
    if (hidden.has(key)) continue;
    for (const p of list) {
      if (p.e > now && normalize(p.t).includes(q)) { programs.push({ key, ...p }); break; }
    }
    if (programs.length >= 60) break;
  }
  programs.sort((a, b) => a.s - b.s);
  return { channels: chans, programs };
}

// ------------------------------------------------------------------ playback

// The URL to play: the channel live, or a replay from the archive.
export async function playable(userId, key, { start, stop, offset = 0, clientTimezone = '' } = {}) {
  await ensureLoaded(userId);
  const state = rt(userId);
  const rec = record(userId);
  const ch = state.byKey.get(key);
  if (!ch) throw httpError(404, 'That channel is no longer in your playlists.');
  const source = rec.sources.find((s) => s.id === ch.sourceId);
  const liveUrl = liveUrlFor(ch, source, rec);
  remember(userId, key);

  if (!start) return { url: liveUrl, live: true, channel: ch, userAgent: source?.userAgent || '' };

  const now = Date.now();
  const s = rec.settings;
  const showStart = Number(start);
  const stopMs = Number(stop) || showStart + HOUR;
  if (!ch.catchup || !catchupLib.isAvailable(ch.catchup, showStart, now)) {
    throw httpError(400, 'This channel has no catch-up for that time.');
  }
  // Skipping inside a replay asks the archive again from that point.
  const latest = Math.max(0, Math.min(stopMs + catchupLib.CONTINUE_MS, now - 15_000) - showStart);
  const offsetMs = Math.max(0, Math.min(Number(offset) || 0, latest));
  const startMs = showStart + offsetMs;
  // The guide's time shift is taken back off (the archive goes by the
  // guide's own times), then the catch-up time shift added.
  const shift = (s.epgOffsetMinutes || 0) * 60_000 - (s.catchupShiftMinutes || 0) * 60_000;
  // Ask for up to three hours past the show, so a show that runs over keeps
  // playing and the next one follows on.
  const windowStop = Math.max(stopMs, Math.min(now - 30_000, stopMs + catchupLib.CONTINUE_MS));
  const preferHls = s.catchupPreferHls && now - (source?.catchupNoHlsSince || 0) > catchupLib.HLS_RETRY_MS;
  const serverTimezone = source?.serverTimezone || '';
  const primary = catchupLib.build(liveUrl, ch.catchup, startMs - shift, windowStop - shift, {
    nowMs: now, preferHls, serverTimezone, clientTimezone,
  });
  if (!primary) throw httpError(400, 'This channel’s catch-up format isn’t supported.');
  const candidates = [primary, ...catchupLib.alternatives(primary, {
    serverTimezone, clientTimezone,
    showMinutes: Math.round((stopMs - startMs) / 60_000),
    airedMinutes: now < stopMs ? Math.round((now - startMs) / 60_000) : null,
  })];
  const ua = source?.userAgent || DEFAULT_UA;
  let chosen = null;
  for (const url of candidates.slice(0, 8)) {
    if (await probe(url, ua)) { chosen = url; break; }
  }
  if (!chosen) throw httpError(502, 'The provider has no replay for this show.');
  // HLS refused but TS worked: ask for TS straight away for a week.
  if (source && /\.m3u8(\?|$)/i.test(primary) && !/\.m3u8(\?|$)/i.test(chosen) && chosen.includes('/timeshift/')) {
    source.catchupNoHlsSince = now;
    persistSoon();
  }
  return { url: chosen, live: false, channel: ch, userAgent: source?.userAgent || '', offsetMs, showStart, showStop: stopMs };
}

function liveUrlFor(ch, source, rec) {
  if (ch.url) return ch.url;
  if (!source || source.kind !== 'xtream') throw httpError(404, 'That playlist is gone.');
  const acc = rec.accounts[source.id] || {};
  const allowed = acc.allowedFormats || [];
  let ext = source.streamFormat;
  if (!ext || ext === 'auto') ext = allowed.length && !allowed.includes('ts') && allowed.includes('m3u8') ? 'm3u8' : 'ts';
  const u = encodeURIComponent(source.username);
  const p = encodeURIComponent(source.password);
  return `${source.server}/live/${u}/${p}/${ch.streamId}.${ext}`;
}

// Does this link answer with video (or a playlist)? Reads a couple of KB and
// lets go, so it doesn't hold one of the account's few connections.
async function probe(url, userAgent) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(url, { headers: { 'user-agent': userAgent }, redirect: 'follow', signal: ac.signal });
    if (!res.ok || !res.body) return false;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (/text\/html|application\/json/.test(type)) return false;
    const reader = res.body.getReader();
    let got = Buffer.alloc(0);
    while (got.length < 1024) {
      const { value, done } = await reader.read();
      if (done) break;
      got = Buffer.concat([got, Buffer.from(value)]);
    }
    const head = got.toString('latin1', 0, 256).trimStart();
    if (/\.m3u8(\?|$)/i.test(url) || /mpegurl/.test(type)) return head.startsWith('#EXTM3U');
    if (!got.length) return false;
    return !head.startsWith('<') && !head.startsWith('{');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

// ------------------------------------------------------------------ catch-up archive (Xtream)

// Xtream panels keep listings for the archive (up to a week) that the guide
// file doesn't: fetched for the channels being looked at, once per session.
export async function archive(userId, keys) {
  await ensureLoaded(userId);
  const state = rt(userId);
  const rec = record(userId);
  const wanted = keys.map((k) => state.byKey.get(k)).filter((c) => c?.catchup && c.streamId && !state.archiveFetched.has(c.key));
  if (!wanted.length || Date.now() < state.archivePausedUntil) return {};
  const out = {};
  const queue = wanted.slice(0, 40);
  queue.forEach((c) => state.archiveFetched.add(c.key));
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      if (Date.now() < state.archivePausedUntil) { state.archiveFetched.delete(c.key); continue; }
      const source = rec.sources.find((s) => s.id === c.sourceId);
      if (!source || source.kind !== 'xtream') continue;
      try {
        const data = await getJson(`${apiUrl(source)}&action=get_simple_data_table&stream_id=${c.streamId}`, source.userAgent);
        const list = (data?.epg_listings || []).map((o) => {
          const s = Number(o.start_timestamp) * 1000;
          const e = Number(o.stop_timestamp || o.end_timestamp) * 1000;
          const t = b64(o.title).trim();
          if (!s || !e || e <= s || !t) return null;
          const p = { s, e, t };
          const d = b64(o.description).trim();
          if (d) p.d = d.slice(0, 1200);
          return p;
        }).filter(Boolean).sort((a, b) => a.s - b.s);
        if (!list.length) continue;
        const now = Date.now();
        const existing = state.programs.get(c.key) || [];
        const pastEnd = Math.min(now, list[list.length - 1].e);
        const past = list.filter((p) => p.s < pastEnd);
        const existingEnd = existing.reduce((m, p) => Math.max(m, p.e), now);
        const later = list.filter((p) => p.s >= Math.max(existingEnd, now));
        if (!past.length && !later.length) continue;
        const from = past[0]?.s ?? pastEnd;
        const keep = existing.filter((p) => p.s >= pastEnd || p.s < from);
        const merged = [];
        for (const p of [...past, ...keep, ...later].sort((a, b) => a.s - b.s)) {
          if (!merged.length || p.s >= merged[merged.length - 1].e - 60_000) merged.push(p);
        }
        state.programs.set(c.key, merged);
        out[c.key] = true;
      } catch (err) {
        if (/429/.test(err.message)) {
          state.archivePausedUntil = Date.now() + 5 * 60_000;
          state.archiveFetched.delete(c.key);
        }
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return out;
}

function b64(v) {
  if (!v) return '';
  try {
    const s = Buffer.from(String(v), 'base64').toString('utf8');
    return /�/.test(s) ? String(v) : s;
  } catch { return String(v); }
}

// ------------------------------------------------------------------ loading

async function ensureLoaded(userId) {
  const state = rt(userId);
  if (state.loaded) return;
  if (!state.loading) {
    state.loading = (async () => {
      const okChannels = await loadChannelsCache(userId);
      if (okChannels) await loadGuideCache(userId);
      state.loaded = true;
      const rec = record(userId);
      if (rec.sources.length && (!okChannels || Date.now() - rec.lastRefreshAt > REFRESH_MS)) {
        refresh(userId).catch(() => {});
      }
    })().finally(() => { state.loading = null; });
  }
  await state.loading;
}

async function loadChannelsCache(userId) {
  try {
    const data = decryptJson(await fs.readFile(channelsFile(userId), 'utf8'));
    setChannels(userId, data.channels || []);
    return true;
  } catch { return false; }
}

async function saveChannelsCache(userId) {
  const state = rt(userId);
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(channelsFile(userId), encryptJson({ channels: state.channels }), { mode: 0o600 });
}

async function loadGuideCache(userId) {
  try {
    const data = JSON.parse((await gunzip(await fs.readFile(guideFile(userId)))).toString('utf8'));
    const state = rt(userId);
    state.programs = new Map(Object.entries(data.programs || {}));
    state.epgLogos = new Map(Object.entries(data.logos || {}));
  } catch { /* no guide yet */ }
}

async function saveGuideCache(userId) {
  const state = rt(userId);
  const body = JSON.stringify({ programs: Object.fromEntries(state.programs), logos: Object.fromEntries(state.epgLogos) });
  await fs.writeFile(guideFile(userId), await gzip(body));
}

function setStatus(userId, loading, message) {
  rt(userId).status = { loading, message: message || null, at: Date.now() };
}

// Downloads the playlists (all, or `only` those ids — the rest are kept from
// what's loaded), then the guides. One refresh per user at a time.
export function refresh(userId, { only = null } = {}) {
  const state = rt(userId);
  if (state.refreshing) {
    state.refreshing.then(() => { if (only) refresh(userId, { only }); }).catch(() => {});
    return state.refreshing;
  }
  state.refreshing = (async () => {
    if (!state.loaded) {
      if (await loadChannelsCache(userId)) await loadGuideCache(userId);
      state.loaded = true;
    }
    const rec = record(userId);
    const previous = state.channels;
    const next = [];
    for (const source of rec.sources) {
      const keepOld = only && !only.includes(source.id);
      if (!source.enabled) continue;
      if (keepOld) { next.push(...previous.filter((c) => c.sourceId === source.id)); continue; }
      setStatus(userId, true, `Loading channels from ${source.name}…`);
      try {
        const list = source.kind === 'xtream' ? await loadXtream(userId, source) : await loadM3u(userId, source);
        source.lastUpdatedMs = Date.now();
        source.lastError = null;
        source.channelCount = list.length;
        next.push(...list);
      } catch (err) {
        source.lastError = err.message;
        // Keep what this playlist had, rather than emptying the guide.
        next.push(...previous.filter((c) => c.sourceId === source.id));
      }
    }
    setChannels(userId, next);
    await saveChannelsCache(userId).catch(() => {});
    if (!only || !rec.lastRefreshAt) rec.lastRefreshAt = Date.now();
    persistSoon();
    await buildGuide(userId);
    setStatus(userId, false, null);
  })().catch((err) => {
    setStatus(userId, false, `Update failed: ${err.message}`);
  }).finally(() => { state.refreshing = null; });
  return state.refreshing;
}

export function refreshGuide(userId) {
  const state = rt(userId);
  if (state.refreshing) return state.refreshing;
  state.refreshing = (async () => {
    await ensureLoaded(userId);
    await buildGuide(userId);
    setStatus(userId, false, null);
  })().catch((err) => setStatus(userId, false, `Guide update failed: ${err.message}`))
    .finally(() => { state.refreshing = null; });
  return state.refreshing;
}

function setChannels(userId, list) {
  const state = rt(userId);
  state.channels = list;
  state.byKey = new Map(list.map((c) => [c.key, c]));
  rebuildGroups(userId);
}

// Groups in the order the playlists list them, playlists in your order.
function rebuildGroups(userId) {
  const state = rt(userId);
  const rec = record(userId);
  const order = new Map(rec.sources.map((s, i) => [s.id, i]));
  const removals = terms(rec.settings.nameRemovals);
  for (const c of state.channels) c.name = cleanName(c.rawName || c.name, removals);
  const groups = new Map();
  const sorted = [...state.channels].sort((a, b) => (order.get(a.sourceId) ?? 99) - (order.get(b.sourceId) ?? 99));
  for (const c of sorted) {
    if (!groups.has(c.groupId)) groups.set(c.groupId, { id: c.groupId, title: c.group, sourceId: c.sourceId, keys: [], order: c.groupOrder ?? 0 });
    groups.get(c.groupId).keys.push(c.key);
  }
  const sortChannels = (keys) => {
    if (rec.settings.channelSort === 'NUMBER') keys.sort((a, b) => (state.byKey.get(a).number || 0) - (state.byKey.get(b).number || 0));
    else if (rec.settings.channelSort === 'NAME') keys.sort((a, b) => state.byKey.get(a).name.localeCompare(state.byKey.get(b).name));
  };
  state.groups = [...groups.values()].sort((a, b) => (order.get(a.sourceId) ?? 99) - (order.get(b.sourceId) ?? 99) || a.order - b.order);
  state.groups.forEach((g) => sortChannels(g.keys));
  // The channel order every client uses: group by group.
  const pos = new Map();
  state.groups.forEach((g) => g.keys.forEach((k) => { if (!pos.has(k)) pos.set(k, pos.size); }));
  state.channels.sort((a, b) => pos.get(a.key) - pos.get(b.key));
}

// ---------------------------------------------------------------- Xtream

function apiUrl(source) {
  return `${source.server}/player_api.php?username=${encodeURIComponent(source.username)}&password=${encodeURIComponent(source.password)}`;
}

function xtreamGuideUrl(source) {
  return `${source.server}/xmltv.php?username=${encodeURIComponent(source.username)}&password=${encodeURIComponent(source.password)}`;
}

// The way TiviMate does it: account check, categories, then the streams.
// Lighter on the provider than the one-shot get.php, which many panels time
// out on; that is the fallback.
async function loadXtream(userId, source) {
  if (source.importLive === false) return [];
  const rec = record(userId);
  let info;
  try {
    info = await getJson(apiUrl(source), source.userAgent);
  } catch (err) {
    return loadM3uText(userId, source, await getText(
      `${source.server}/get.php?username=${encodeURIComponent(source.username)}&password=${encodeURIComponent(source.password)}&type=m3u_plus&output=ts`,
      source.userAgent,
    ), err);
  }
  const ui = info?.user_info;
  if (!ui) throw new Error('Not an Xtream Codes server (no account details came back).');
  if (String(ui.auth) === '0') throw new Error('Login failed: check the username and password');
  const status = String(ui.status || '');
  const exp = Number(ui.exp_date) || 0;
  rec.accounts[source.id] = {
    status,
    expiresAtMs: exp > 0 ? exp * 1000 : 0,
    maxConnections: Number(ui.max_connections) || 0,
    activeConnections: Number(ui.active_cons) || 0,
    allowedFormats: (ui.allowed_output_formats || []).map((f) => String(f).toLowerCase()),
    checkedAtMs: Date.now(),
  };
  if (status && !/^active$/i.test(status)) throw new Error(`Account ${status}`);
  if (exp > 0 && exp * 1000 < Date.now()) throw new Error(`Account expired on ${new Date(exp * 1000).toDateString()}`);
  const tz = info?.server_info?.timezone;
  if (tz) source.serverTimezone = tz;

  const categories = new Map();
  try {
    const cats = await getJson(`${apiUrl(source)}&action=get_live_categories`, source.userAgent);
    (Array.isArray(cats) ? cats : []).forEach((c, i) => categories.set(String(c.category_id), { name: c.category_name, order: i }));
  } catch { /* streams still say their category id */ }

  const streams = await getJson(`${apiUrl(source)}&action=get_live_streams`, source.userAgent);
  if (!Array.isArray(streams) || !streams.length) throw new Error('The provider returned no live channels');
  const out = [];
  for (const f of streams) {
    const streamId = f.stream_id != null ? String(f.stream_id) : '';
    if (!streamId) continue;
    const cat = categories.get(String(f.category_id ?? ''));
    const name = String(f.name || `Channel ${streamId}`).replace(/\s+/g, ' ').trim();
    out.push({
      key: `${source.id}:${streamId}`,
      sourceId: source.id,
      streamId,
      rawName: name,
      name,
      tvgId: f.epg_channel_id || null,
      tvgName: name,
      logo: f.stream_icon || null,
      groupId: `${source.id}:${cat ? f.category_id : 'none'}`,
      group: cat?.name || 'Uncategorized',
      groupOrder: cat ? cat.order : 1e6,
      number: Number(f.num) || out.length + 1,
      catchup: String(f.tv_archive) === '1'
        ? { type: 'xc', source: null, days: Number(f.tv_archive_duration) || 1, correctionHours: 0 }
        : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- M3U

async function loadM3u(userId, source) {
  return loadM3uText(userId, source, await getText(source.url, source.userAgent));
}

const VOD_PATH = /\/(movie|movies|series|vod)\//i;
const VOD_EXT = /\.(mp4|mkv|avi|mov|wmv|m4v|webm|flv)(\?|$)/i;

function loadM3uText(userId, source, text, apiError) {
  if (!/#EXTM3U|#EXTINF/i.test(text.slice(0, 4096))) {
    throw apiError || new Error('That link didn’t return an M3U playlist');
  }
  const header = /^#EXTM3U([^\n]*)/m.exec(text)?.[1] || '';
  const tvgUrls = [];
  for (const m of header.matchAll(/(?:url-tvg|x-tvg-url)\s*=\s*"([^"]+)"/gi)) tvgUrls.push(...m[1].split(',').map((u) => u.trim()).filter(Boolean));
  source.embeddedEpg = tvgUrls;
  const out = [];
  const groupOrder = new Map();
  let info = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const comma = findTitleComma(line);
      const attrsPart = line.slice(0, comma);
      const a = {};
      for (const m of attrsPart.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) a[m[1].toLowerCase()] = m[2];
      info = { a, title: line.slice(comma + 1).trim() };
    } else if (line.startsWith('#EXTGRP:') && info) {
      info.a['group-title'] ||= line.slice(8).trim();
    } else if (!line.startsWith('#') && info) {
      if (!VOD_PATH.test(line) && !VOD_EXT.test(line)) {
        const a = info.a;
        const group = a['group-title'] || 'Uncategorized';
        if (!groupOrder.has(group)) groupOrder.set(group, groupOrder.size);
        const name = (info.title || a['tvg-name'] || 'Channel').trim();
        const id = crypto.createHash('sha1').update(`${line}|${name}`).digest('hex').slice(0, 16);
        const days = Number(a['catchup-days'] || a.timeshift || 0);
        const ctype = (a.catchup || a['catchup-type'] || (a.timeshift ? 'default' : '')).toLowerCase();
        const xtreamId = /\/(?:live\/)?[^/]+\/[^/]+\/(\d+)(?:\.[a-z0-9]+)?$/i.exec(line)?.[1];
        out.push({
          key: `${source.id}:${id}`,
          sourceId: source.id,
          url: line,
          streamId: xtreamId || null,
          rawName: name,
          name,
          tvgId: a['tvg-id'] || null,
          tvgName: a['tvg-name'] || null,
          logo: a['tvg-logo'] || null,
          groupId: `${source.id}:${crypto.createHash('sha1').update(group).digest('hex').slice(0, 10)}`,
          group,
          groupOrder: groupOrder.get(group),
          number: Number(a['tvg-chno']) || out.length + 1,
          catchup: ctype || days ? {
            type: ctype || 'default',
            source: a['catchup-source'] || null,
            days: days || 1,
            correctionHours: Number(a['catchup-correction']) || 0,
          } : null,
        });
      }
      info = null;
    }
  }
  if (!out.length) throw new Error('The playlist has no live channels');
  return out;
}

// The comma that starts the title: the first one outside quotes.
function findTitleComma(line) {
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') q = !q;
    else if (line[i] === ',' && !q) return i;
  }
  return line.length;
}

// ---------------------------------------------------------------- guide

const PLACEHOLDER = /^(programming|program|programme|no information|no info|no program information|no programme information|to be announced|tba|tbd|n\/?a|off air|no data|no epg|not available|information not available|regular programming|scheduled programming|paid programming|coming soon)\.?$/;
const isPlaceholder = (t) => PLACEHOLDER.test(String(t || '').trim().toLowerCase());

export function normalize(name) {
  let n = String(name || '').toLowerCase().trim();
  n = n.replace(/^[a-z]{2,3}\s*[:|]\s*/, '');
  n = n.replace(/\[.*?]|\(.*?\)/g, ' ');
  n = n.replace(/\b(fhd|uhd|hd|sd|4k|8k|hevc|h265|h264|1080p|720p|backup|raw)\b/g, ' ');
  return n.replace(/[^\p{L}\p{N}]/gu, '');
}

function guideTargets(userId) {
  const rec = record(userId);
  const targets = [];
  const seen = new Set();
  const add = (id, name, url, ua) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    targets.push({ id, name, url, ua });
  };
  for (const s of rec.sources) {
    if (!s.enabled || s.useEmbeddedEpg === false) continue;
    if (s.kind === 'xtream' && s.importLive !== false) add(`pl:${s.id}`, s.name, xtreamGuideUrl(s), s.userAgent);
    for (const u of s.embeddedEpg || []) add(`pl:${s.id}:${u}`, s.name, u, s.userAgent);
  }
  for (const e of rec.epgs) if (e.enabled) add(`epg:${e.id}`, e.name, e.url, '');
  return targets;
}

async function buildGuide(userId) {
  const state = rt(userId);
  const rec = record(userId);
  const s = rec.settings;
  const now = Date.now();
  const windowStart = now - Math.max(3, s.epgPastHours || 24) * HOUR;
  const windowEnd = now + Math.max(1, s.epgFutureDays || 3) * 24 * HOUR;

  const byTvgId = new Map();
  const byName = new Map();
  const push = (map, k, c) => { if (!k) return; if (!map.has(k)) map.set(k, []); map.get(k).push(c); };
  for (const c of state.channels) {
    if (c.tvgId) push(byTvgId, String(c.tvgId).toLowerCase(), c);
    push(byName, normalize(c.rawName || c.name), c);
    if (c.tvgName) push(byName, normalize(c.tvgName), c);
  }
  if (!state.channels.length) {
    state.programs = new Map(); state.epgLogos = new Map();
    await saveGuideCache(userId).catch(() => {});
    return;
  }

  const best = new Map(); // key -> { score, list, icon }
  const targets = guideTargets(userId);
  for (const [order, target] of targets.entries()) {
    setStatus(userId, true, `Reading guide “${target.name}”…`);
    let parsed;
    try {
      const res = await fetchWithTimeout(target.url, target.ua, 10 * 60_000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      parsed = await xmltv.parse(Readable.fromWeb(res.body), {
        windowStart, windowEnd,
        keep: (id, ch) => byTvgId.has(id.toLowerCase()) || byName.has(normalize(id))
          || Boolean(ch?.names?.some((n) => byName.has(normalize(n)))),
      });
      const e = rec.epgs.find((x) => `epg:${x.id}` === target.id);
      if (e) { e.lastUpdatedMs = Date.now(); e.lastError = parsed.error; }
    } catch (err) {
      const e = rec.epgs.find((x) => `epg:${x.id}` === target.id);
      if (e) e.lastError = err.message;
      continue;
    }
    let count = 0;
    const offer = (xmlId, chans, idMatch) => {
      const raw = parsed.programs.get(xmlId);
      if (!raw?.length || !chans?.length) return;
      const list = cleanListings(raw);
      if (!list.length) return;
      count += list.length;
      const real = list.filter((p) => isPlaceholder(p.t)).length * 10 < list.length * 8;
      const lastStop = list[list.length - 1].e;
      const halfDays = Math.min(999, Math.floor(Math.max(0, lastStop - now) / (12 * HOUR)));
      const score = (real ? 4e6 : 0) + (idMatch ? 2e6 : 0) + halfDays * 1000 - order;
      const icon = parsed.channels.get(xmlId)?.icon || null;
      for (const c of chans) {
        const cur = best.get(c.key);
        if (!cur || score > cur.score) best.set(c.key, { score, list, icon });
      }
    };
    const ids = new Set([...parsed.programs.keys()]);
    for (const id of ids) {
      offer(id, byTvgId.get(id.toLowerCase()), true);
      const names = [...(parsed.channels.get(id)?.names || []), id];
      const hits = new Set();
      for (const n of names) for (const c of byName.get(normalize(n)) || []) hits.add(c);
      offer(id, [...hits], false);
    }
    const e = rec.epgs.find((x) => `epg:${x.id}` === target.id);
    if (e) e.programCount = count;
  }
  const programs = new Map();
  const logos = new Map();
  for (const [key, b] of best) {
    programs.set(key, b.list);
    if (b.icon) logos.set(key, b.icon);
  }
  // Keep catch-up archive listings already fetched this session.
  for (const key of state.archiveFetched) if (!programs.has(key) && state.programs.has(key)) programs.set(key, state.programs.get(key));
  state.programs = programs;
  state.epgLogos = logos;
  persistSoon();
  await saveGuideCache(userId).catch(() => {});
}

// Placeholder listings ("Programming") that overlap real ones go, and only
// one show covers any moment: a long filler is cut where the next starts.
function cleanListings(list) {
  let kept = list;
  if (list.length > 1) {
    const real = list.filter((p) => !isPlaceholder(p.t));
    if (real.length && real.length !== list.length) {
      kept = list.filter((p) => !isPlaceholder(p.t) || !real.some((r) => r.s < p.e && r.e > p.s));
    }
  }
  const sorted = [...kept].sort((a, b) => a.s - b.s || isPlaceholder(a.t) - isPlaceholder(b.t) || (a.e - a.s) - (b.e - b.s));
  const out = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && last.e > p.s) {
      if (last.s === p.s) continue;
      out[out.length - 1] = { ...last, e: p.s };
    }
    if (p.e > p.s) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- channel name cleanup

function terms(raw) {
  return [...new Set(String(raw || '').split(',').map((t) => t.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function cleanName(name, list) {
  if (!list.length) return name.trim();
  let out = name.trim();
  for (let guard = 0; guard < 6; guard += 1) {
    const before = out;
    for (const t of list) {
      const q = esc(t);
      const prefix = /^\p{L}+$/u.test(t)
        ? new RegExp(`^(?:[\\[(|]${q}[\\])|]|${q}\\s*[:|\\-–—/.•*]+)\\s*`, 'i')
        : new RegExp(`^[\\[(|]?${q}[\\])|]?[\\s:|\\-–—/.•*]*`, 'i');
      const p = out.replace(prefix, '').trim();
      if (p && p !== out) out = p;
      if (new RegExp(`(^|[\\s:|\\-–—/.•*\\[(])[\\[(|]?${q}[\\])|]?$`, 'i').test(out)) {
        const sfx = out.replace(new RegExp(`[\\s:|\\-–—/.•*]*[\\[(|]?${q}[\\])|]?$`, 'i'), '').trim();
        if (sfx && sfx !== out) out = sfx;
      }
    }
    if (out === before) break;
  }
  return out;
}

// ---------------------------------------------------------------- http

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function plainHttpError(code) {
  if (code === 401 || code === 403) return `HTTP ${code}: the provider refused the request (wrong login, or it blocks this app; try setting a user agent)`;
  if (code === 404) return 'HTTP 404: nothing at that address (check the server, port and link)';
  if (code === 429) return 'HTTP 429: too many requests, try again in a few minutes';
  if (code === 512 || code === 513 || code === 884) return `HTTP ${code}: the account is over its connection limit, expired or blocked for now`;
  return `HTTP ${code}`;
}

async function fetchWithTimeout(url, userAgent, ms = HTTP_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { headers: { 'user-agent': userAgent || DEFAULT_UA, accept: '*/*' }, redirect: 'follow', signal: ac.signal });
    res.cancelTimer = () => clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === 'AbortError' ? 'The provider took too long to answer' : `Couldn’t reach the provider (${err.cause?.code || err.message})`);
  }
}

async function getText(url, userAgent) {
  const res = await fetchWithTimeout(url, userAgent);
  try {
    if (!res.ok) throw new Error(plainHttpError(res.status));
    const buf = Buffer.from(await res.arrayBuffer());
    return (buf[0] === 0x1f && buf[1] === 0x8b ? await gunzip(buf) : buf).toString('utf8');
  } finally { res.cancelTimer?.(); }
}

async function getJson(url, userAgent) {
  const text = await getText(url, userAgent);
  try { return JSON.parse(text); } catch { throw new Error('The provider answered with something that isn’t JSON'); }
}

// ---------------------------------------------------------------- scheduler

// Every user's playlists and guides, every REFRESH_HOURS. Checked every few
// minutes; users are refreshed one after another so a server with many
// accounts doesn't hit every provider at once.
let schedulerRunning = false;
function startScheduler() {
  const tick = async () => {
    if (schedulerRunning) return;
    schedulerRunning = true;
    try {
      for (const [userId, rec] of users) {
        if (!rec.sources.some((s) => s.enabled)) continue;
        if (Date.now() - (rec.lastRefreshAt || 0) < REFRESH_MS) continue;
        await ensureLoaded(userId).catch(() => {});
        await refresh(userId).catch(() => {});
      }
    } finally { schedulerRunning = false; }
  };
  setTimeout(tick, 30_000).unref?.();
  setInterval(tick, 5 * 60_000).unref?.();
}

export const _test = { loadM3uText, cleanListings, cleanName, terms, rt, record, setChannels, buildGuide };
