import { createApp, staticFiles, jsonBody } from './http.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as nuvio from './nuvio.js';
import * as addonsApi from './addons.js';
import * as players from './players.js';
import * as signing from './signing.js';
import * as subtitlesLib from './subtitles.js';
import * as proxy from './proxy.js';
import * as transcode from './transcode.js';
import * as store from './sessions.js';
import * as playlists from './playlist.js';
import * as languages from './languages.js';
import * as progress from './progress.js';
import * as vlcLauncher from './vlclauncher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP === 'true';
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 15000);

const app = createApp();
app.use(jsonBody());
app.set('trust proxy', true);

// ---------------------------------------------------------------- auth

// Every request resolves to a user record or none. Nothing is global any
// more: two people on the same container each get their own Nuvio session,
// profile selection and theme.
function currentUser(req) {
  return store.get(req.cookies?.nib_sid);
}

function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in to your Nuvio account.' });
  req.user = user;
  next();
}

// Supabase access tokens last an hour; refresh a minute early so a request
// doesn't fail and need retrying.
//
// One refresh per device at a time. Supabase rotates refresh tokens and treats
// a reused one as theft, revoking the whole session. The home screen fires a
// dozen requests at once, so after an hour away they all found the token
// stale and all refreshed with it — the first succeeded, the rest reused the
// old token, and the device was signed out. That was "Keep me signed in" not
// working. Now the others wait for the first refresh and share its result.
const refreshing = new Map();
async function accessToken(user) {
  // The view a request holds can be stale; the store has the latest tokens.
  const live = store.get(user.sid) || user;
  if (Date.now() < live.session.expiresAt - 5 * 60_000) {
    user.session = live.session;
    return live.session.accessToken;
  }
  if (!refreshing.has(user.sid)) {
    refreshing.set(user.sid, (async () => {
      const refreshed = await nuvio.refresh(live.session.refreshToken);
      await store.update(live, { session: refreshed });
      return refreshed;
    })().finally(() => refreshing.delete(user.sid)));
  }
  const refreshed = await refreshing.get(user.sid);
  user.session = refreshed;
  return refreshed.accessToken;
}

// Failed sign-ins are rate limited per IP. This endpoint proxies to someone
// else's auth server, so it shouldn't be usable as a password oracle.
const attempts = new Map();
function throttle(req, res, next) {
  const ip = req.ip || 'unknown';
  const record = attempts.get(ip) || { count: 0, resetAt: Date.now() + 900_000 };
  if (Date.now() > record.resetAt) { record.count = 0; record.resetAt = Date.now() + 900_000; }
  if (record.count >= 10) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  attempts.set(ip, record);
  req.failedAttempt = () => { record.count += 1; };
  next();
}

app.post('/api/login', throttle, async (req, res) => {
  const { email, password, remember } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });

  try {
    const session = await nuvio.signIn(email, password);
    const user = await store.create(session);
    setSessionCookie(res, req, user.sid, remember !== false);
    res.json({ email: session.user.email });
  } catch (err) {
    req.failedAttempt();
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/signup', throttle, async (req, res) => {
  if (!ALLOW_SIGNUP) return res.status(403).json({ error: 'Sign-up is off on this server.' });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Enter an email and password.' });

  try {
    const result = await nuvio.signUp(email, password);
    // Nuvio may require email confirmation, in which case there's no session
    // to hand back yet and the person needs to check their inbox.
    if (!result.session) return res.json({ confirmationRequired: true, email });
    const user = await store.create(result.session);
    setSessionCookie(res, req, user.sid);
    res.json({ email: result.session.user.email });
  } catch (err) {
    req.failedAttempt();
    res.status(400).json({ error: err.message });
  }
});

// Each device holds its own session, so signing in on a phone, a laptop and a
// desktop gives three independent ones — none of them disturbs the others, and
// signing out of one leaves the rest alone.
//
// `remember` decides whether this one survives the browser closing. Without
// it the cookie has no expiry at all, which is what a shared or borrowed
// machine wants: close the window and the session is gone.
function setSessionCookie(res, req, sid, remember = true) {
  res.cookie('nib_sid', sid, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    ...(remember ? { maxAge: 1000 * 60 * 60 * 24 * 365 } : {}),
  });
}

app.post('/api/logout', async (req, res) => {
  const user = currentUser(req);
  if (user) {
    // Only this device, unless asked otherwise — signing out on a phone
    // shouldn't end the session on a laptop.
    await nuvio.signOut(user.session.accessToken);
    if (req.body?.everywhere) await store.destroyAll(user.userId);
    else await store.destroy(user.sid);
  }
  res.clearCookie('nib_sid');
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  const user = currentUser(req);
  res.json({
    signedIn: Boolean(user),
    email: user?.email || null,
    backendUrl: nuvio.config.backendUrl,
    profileIndex: user?.profileIndex ?? null,
    theme: user?.theme || 'White',
    prefs: { ...DEFAULT_PREFS, ...(user?.prefs || {}) },
    languages: languages.options,
    devices: user ? store.devicesFor(user.userId).length : 0,
    signupAllowed: ALLOW_SIGNUP,
    // What this server can do for a browser player, so the client doesn't
    // have to probe for it.
    mediaProxy: proxy.enabled,
    transcode: transcode.isAvailable(),
    secureOrigin: (PUBLIC_URL || '').startsWith('https://'),
  });
});

// ------------------------------------------------------------- profiles

app.get('/api/profiles', requireUser, async (req, res, next) => {
  try {
    res.json(await nuvio.profiles(await accessToken(req.user)));
  } catch (err) { next(err); }
});

app.post('/api/profile', requireUser, async (req, res, next) => {
  try {
    await store.update(req.user, { profileIndex: Number(req.body?.index) });
    addonsApi.clearCache();
    for (const key of homeCache.keys()) if (key.startsWith(`${req.user.userId}:`)) homeCache.delete(key);
    res.json({ profileIndex: req.user.profileIndex });
  } catch (err) { next(err); }
});

app.post('/api/theme', requireUser, async (req, res, next) => {
  try {
    await store.update(req.user, { theme: String(req.body?.theme || 'White') });
    res.json({ theme: req.user.theme });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------- browsing

// Profile numbering is decided by the server, not by us — the provisioner
// treats profile_index as 0-based while the app's default is 1, so never
// assume. If nothing is selected yet, use whichever profile comes back first.
async function profileIndex(user) {
  if (user.profileIndex != null) return user.profileIndex;
  const list = await nuvio.profiles(await accessToken(user));
  const first = list[0]?.index ?? 1;
  await store.update(user, { profileIndex: first });
  return first;
}

async function installedAddons(user, { wait = false } = {}) {
  return addonsApi.hydrate(await nuvio.addons(await accessToken(user), await profileIndex(user)), { wait });
}

app.get('/api/catalogs', requireUser, async (req, res, next) => {
  try {
    res.json(addonsApi.catalogList(await installedAddons(req.user), { includeRequiredExtras: true }));
  } catch (err) { next(err); }
});

app.get('/api/collections', requireUser, async (req, res, next) => {
  try {
    const token = await accessToken(req.user);
    res.json(await nuvio.collections(token, await profileIndex(req.user)));
  } catch (err) { next(err); }
});

app.get('/api/catalog', requireUser, async (req, res, next) => {
  try {
    const { transportUrl, type, id, skip, genre } = req.query;
    res.json(await addonsApi.catalog(await installedAddons(req.user, { wait: true }), {
      transportUrl, type, id, genre: genre || null, skip: Number(skip || 0),
    }));
  } catch (err) { next(err); }
});

// The home screen is a dozen addon catalogs fetched in parallel, so it is as
// slow as the slowest addon — every time the app is opened. It is kept per
// profile and served at once while a fresh copy is fetched behind it
// (stale-while-revalidate): opening the app shows the last home instantly and
// the next open has the new one.
const HOME_FRESH_MS = 60_000;
const HOME_STALE_MS = 30 * 60_000;
const homeCache = new Map();

app.get('/api/home', requireUser, async (req, res, next) => {
  try {
    const index = await profileIndex(req.user);
    const key = `${req.user.userId}:${index}`;
    const hit = homeCache.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit?.body && age < HOME_STALE_MS) {
      if (age > HOME_FRESH_MS && !hit.pending) {
        hit.pending = buildHome(req.user, index)
          .then((body) => { homeCache.set(key, { at: Date.now(), body }); })
          .catch(() => { hit.pending = null; });
      }
      return res.json(hit.body);
    }
    const body = await buildHome(req.user, index);
    if (homeCache.size > 500) homeCache.clear();
    homeCache.set(key, { at: Date.now(), body });
    return res.json(body);
  } catch (err) { next(err); }
});

async function buildHome(user, index) {
  const token = await accessToken(user);

  const [addons, settings, userCollections] = await Promise.all([
    installedAddons(user),
    nuvio.homeCatalogSettings(token, index).catch(() => null),
    nuvio.collections(token, index).catch(() => []),
  ]);

  const rows = orderCatalogs(addonsApi.catalogList(addons, { home: true }), settings).slice(0, ROW_LIMIT);

  const catalogRows = await Promise.all(rows.map(async (row) => ({
    ...row,
    items: await addonsApi.catalog(addons, row).catch(() => []),
  })));

  return {
    hero: buildHeroPool(catalogRows),
    collections: collectionRows(userCollections),
    rows: catalogRows.filter((row) => row.items.length),
  };
}

const HERO_ITEM_LIMIT = 8;

// localizedMediaTypeLabel, ported from core/i18n. Anything not listed falls
// back to the raw type with an initial capital, as the app does.
const TYPE_LABELS = {
  movie: 'Movies',
  series: 'Series',
  anime: 'Anime',
  channel: 'Channels',
  tv: 'TV',
};

function typeLabel(type) {
  if (!type) return null;
  return TYPE_LABELS[type.trim().toLowerCase()]
    || type.charAt(0).toUpperCase() + type.slice(1);
}

// home_catalog_default_title is "%1$s - %2$s" — catalog name, then media type.
// "Popular - Movies", "Top Rated - Series".
function catalogLabel(row) {
  // A collection folder is named by the person, so say where it lives rather
  // than guessing a media type it may not have.
  if (row.isCollection) return row.collection ? `${row.collection} - ${row.name}` : row.name;

  const label = typeLabel(row.type);
  if (!label) return row.name;
  // Don't produce "Popular Movies - Movies" when the name already says it.
  if (row.name.toLowerCase().includes(label.toLowerCase())) return row.name;
  return `${row.name} - ${label}`;
}

// HomeRepository pools items across every catalog row, dedupes on type:id,
// shuffles, and takes eight. The shuffle is seeded per request there; here a
// day-stable seed keeps the banner from reshuffling on every pull-to-refresh
// while still changing over time. Each item keeps the row it came from so the
// banner can say what it is showing.
function buildHeroPool(rows) {
  const seen = new Set();
  const pool = [];

  for (const row of rows) {
    for (const item of row.items) {
      const key = `${item.type}:${item.id}`;
      // A banner needs artwork; a card with no backdrop looks broken at
      // full-bleed size.
      if (seen.has(key) || !(item.background || item.poster)) continue;
      seen.add(key);
      pool.push({
        ...item,
        source: catalogLabel(row),
        sourceAddon: row.addonName || null,
      });
    }
  }

  return shuffle(pool, dailySeed()).slice(0, HERO_ITEM_LIMIT);
}

function dailySeed() {
  return Math.floor(Date.now() / 86_400_000);
}

// Deterministic Fisher-Yates so the same seed gives the same order.
function shuffle(items, seed) {
  const out = [...items];
  let state = seed || 1;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const ROW_LIMIT = Number(process.env.HOME_ROW_LIMIT || 10);

// Applies the account's home catalog settings: drop what's disabled, order by
// what's left. No settings means show everything in install order, which is
// the app's own fallback.
function orderCatalogs(catalogs, settings) {
  if (!settings?.length) return catalogs;

  const key = (addonId, type, catalogId) => `${addonId}|${type}|${catalogId}`;
  const rules = new Map(settings.map((s) => [key(s.addonId, s.type, s.catalogId), s]));

  return catalogs
    .map((c) => ({ catalog: c, rule: rules.get(key(c.addonId, c.type, c.id)) }))
    .filter(({ rule }) => !rule || rule.enabled)
    .sort((a, b) => (a.rule?.order ?? 999) - (b.rule?.order ?? 999))
    .map(({ catalog }) => catalog);
}

// A collection row's tiles are its *folders*, not the titles inside them —
// HomeCollectionRowSection.kt renders `entries = collection.folders`, each as
// a cover image with the folder name under it. That's the "Streaming" and
// "Genres" rows on desktop. Tapping a folder opens what's inside.
//
// Nothing is fetched from addons here, so collection rows cost one RPC for
// the whole home screen rather than one request per source.
function collectionRows(userCollections) {
  return userCollections
    .filter((collection) => collection.folders.length)
    .map((collection) => ({
      id: collection.id,
      name: collection.title,
      folders: collection.folders.map((folder) => ({
        id: folder.id,
        title: folder.title,
        cover: folder.cover,
        coverEmoji: folder.coverEmoji,
        tileShape: folder.tileShape,
        hideTitle: folder.hideTitle,
      })),
    }));
}

// Opening a folder merges every catalog source it names, deduped. Sources
// often overlap, and one dead addon shouldn't empty the folder.
app.get('/api/collection/:collectionId/:folderId', requireUser, async (req, res, next) => {
  try {
    const token = await accessToken(req.user);
    const index = await profileIndex(req.user);
    const [addons, all] = await Promise.all([
      installedAddons(req.user, { wait: true }),
      nuvio.collections(token, index),
    ]);

    const collection = all.find((c) => c.id === req.params.collectionId);
    const folder = collection?.folders.find((f) => f.id === req.params.folderId);
    if (!folder) return res.status(404).json({ error: 'That folder is no longer in your collections.' });

    // Which installed addon a source means: the exact id, or failing that one
    // that has this very catalog. A Live TV addon's id carries a suffix from
    // its login, so a reinstall or a second link can leave the collection
    // naming an id that's no longer installed while the same catalog is.
    const addonFor = (source) => addons.find((a) => a.manifest.id === source.addonId)
      || addons.find((a) => a.manifest.catalogs.some((c) => c.type === source.type && c.id === source.catalogId)
        && a.manifest.id.split('.').slice(0, -1).join('.') === String(source.addonId).split('.').slice(0, -1).join('.'))
      || addons.find((a) => a.manifest.catalogs.some((c) => c.type === source.type && c.id === source.catalogId));

    const problems = [];
    const results = await Promise.all(folder.sources.map(async (source) => {
      const addon = addonFor(source);
      if (!addon) {
        problems.push(`the addon this folder uses (${source.addonId}) isn't installed on this profile`);
        return [];
      }
      return addonsApi.catalog(addons, {
        transportUrl: addon.transportUrl,
        type: source.type,
        id: source.catalogId,
        genre: source.genre,
        skip: Number(req.query.skip || 0),
        // Opening a folder is a deliberate tap: worth waiting for a slow addon.
        timeout: addonsApi.SLOW_TIMEOUT,
      }).catch((err) => {
        problems.push(`${addon.name || addon.manifest.name} didn't answer (${err.name === 'TimeoutError' ? 'timed out' : err.message})`);
        return [];
      });
    }));
    if (problems.length) console.error(`folder "${folder.title}": ${problems.join('; ')}`);

    const seen = new Set();
    const items = [];
    for (const item of results.flat()) {
      const key = `${item.type}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }

    // Empty because something failed is not the same as genuinely empty: say why.
    if (!items.length && problems.length) {
      return res.status(502).json({ error: `Couldn't load this folder: ${problems[0]}. Try again in a moment.` });
    }
    res.json({ title: folder.title, collection: collection.title, items });
  } catch (err) { next(err); }
});

app.get('/api/library', requireUser, async (req, res, next) => {
  try {
    res.json(await nuvio.library(await accessToken(req.user), await profileIndex(req.user)));
  } catch (err) { next(err); }
});

// Whether a title is already saved, so the button can show the right state
// without the client having to pull the whole library itself.
app.get('/api/library/:type/:id', requireUser, async (req, res, next) => {
  try {
    const { type, id } = req.params;
    const items = await nuvio.library(await accessToken(req.user), await profileIndex(req.user));
    res.json({ inLibrary: items.some((i) => i.id === id && i.type === type) });
  } catch (err) { next(err); }
});

app.post('/api/library', requireUser, async (req, res, next) => {
  try {
    const item = req.body || {};
    if (!item.id || !item.type) return res.status(400).json({ error: 'Need an id and a type.' });

    const token = await accessToken(req.user);
    const index = await profileIndex(req.user);

    if (item.remove) {
      await nuvio.removeFromLibrary(token, index, item);
      return res.json({ inLibrary: false });
    }
    await nuvio.addToLibrary(token, index, item);
    res.json({ inLibrary: true });
  } catch (err) { next(err); }
});

app.get('/api/search', requireUser, async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    res.json(await addonsApi.search(await installedAddons(req.user), q, { type: req.query.type }));
  } catch (err) { next(err); }
});

app.get('/api/meta/:type/:id', requireUser, async (req, res, next) => {
  try {
    const { type, id } = req.params;
    const details = await addonsApi.meta(await installedAddons(req.user, { wait: true }), type, id);

    // Nobody could identify it. The client already has a poster and a title
    // from the catalog, so answer with what is true rather than erroring:
    // `partial` tells it to keep what it has and skip the synopsis.
    if (!details) {
      return res.json({ id, type, partial: true, videos: [], genres: [] });
    }
    // Metadata barely changes and the details page is opened repeatedly, so
    // let the browser keep it for a few minutes rather than re-asking every
    // addon. Private: it is behind a sign-in and shouldn't sit in a shared
    // cache along the way.
    res.setHeader('cache-control', 'private, max-age=300');
    return res.json(details);
  } catch (err) { next(err); }
});

app.get('/api/streams/:type/:id', requireUser, async (req, res, next) => {
  try {
    const { type, id } = req.params;
    const [list, upcoming] = await Promise.all([
      addonsApi.streams(await installedAddons(req.user, { wait: true }), type, id),
      type === 'series' ? seasonPlaylist(req.user, id).catch(() => []) : [],
    ]);
    // The browser player asks for the ones it can actually play. Everything
    // else is still there behind "show everything", because the guess is made
    // from a release name and is sometimes wrong in both directions.
    const playableOnly = req.query.browser === '1';
    let streams = playableOnly ? list.filter((s) => s.browser === 'yes') : list;
    // The player's Source menu switches between these in place, so it needs
    // each one's conversion key, signed here rather than on request.
    if (req.query.keys === '1' && transcode.isAvailable()) {
      streams = await Promise.all(streams.map(async (s) => (
        s.playable && s.url ? { ...s, transcodeKey: await signing.sign(s.url) } : s)));
    }

    res.json({
      // How many episodes a playlist would cover, so the sheet can say so.
      queueLength: Math.max(upcoming.length - 1, 0),
      total: list.length,
      hidden: list.length - streams.length,
      streams,
    });
  } catch (err) { next(err); }
});

// -------------------------------------------------------------- handoff

// Which device is asking. The User-Agent is a guess; the client sends ?os=
// once it has run, because it can tell an iPad from a Mac and a UA string
// can't. A bare navigation with no hint still has to do something sensible,
// which is what the guess is for.
const KNOWN_OS = ['ios', 'android', 'windows', 'macos', 'linux', 'chromeos'];

function platformOf(req) {
  const hinted = String(req.query.os || '').toLowerCase();
  if (KNOWN_OS.includes(hinted)) {
    return { os: hinted, form: ['ios', 'android'].includes(hinted) ? 'mobile' : 'desktop' };
  }
  return players.detect(req.get('user-agent'));
}

// Every play route ends here. It takes what is to be played — a single stream
// or a playlist token — and answers in whatever way the target platform needs:
// a redirect into an app scheme, a file to download, or our own player page.
async function deliver(req, res, plan) {
  const target = String(req.query.target || 'auto');
  const platform = platformOf(req);

  // With a playlist, the URL handed to an external player is the .m3u itself.
  const url = plan.playlistToken ? playlistUrl(req, plan.playlistToken) : plan.mediaUrl;
  const decision = players.handoff(target, platform, url, {
    // With Lumen (ffmpeg) available, Automatic plays in the page everywhere
    // and VLC becomes the fallback.
    preferBrowser: transcode.isAvailable(),
    filename: plan.playlistToken ? `${safeFilename(plan.title)}.m3u` : plan.filename,
    title: plan.title,
    successUrl: originOf(req),
    // Where Android sends someone whose phone has no VLC. With a playlist
    // already made, point straight at the player rather than at the .m3u —
    // a browser handed an .m3u as a video source can only fail.
    fallbackUrl: plan.playlistToken
      ? `${originOf(req)}/watch?t=${plan.playlistToken}`
      : retarget(req, 'browser'),
  });

  if (decision.kind === 'scheme') return res.redirect(302, decision.url);

  // Desktop VLC: a vlc:// link carrying the stream itself (or, for a queue,
  // the playlist URL), opened by the Nuvio launcher.
  if (decision.kind === 'launcher') return res.redirect(302, vlcLauncher.vlcLink(url));

  // The other three all need something to point at, so a single stream gets a
  // one-entry record made for it here rather than for every play on every
  // platform.
  const token = await ensureRecord(req, plan);

  if (decision.kind === 'download') {
    return res.redirect(302, `${originOf(req)}/playlist/${token}.m3u?dl=1`);
  }
  const watch = `/watch?t=${token}${decision.kind === 'copy' ? '&copy=1' : ''}`;
  // The app opens the built-in player inside the page and asks for JSON, so
  // no navigation happens between the tap on Play and the film starting.
  if (req.query.format === 'json') return res.json({ watch });
  return res.redirect(302, `${originOf(req)}${watch}`);
}

// A pre-rendered one-entry record, so the browser player and the .m3u download
// read the same thing a playlist would give them.
async function ensureRecord(req, plan) {
  if (plan.playlistToken) return plan.playlistToken;

  const user = currentUser(req);
  const title = plan.title || plan.filename || 'Nuvio';
  const token = await playlists.create({
    sid: user?.sid || null,
    type: plan.type || 'movie',
    seriesId: plan.id || null,
    episodes: [],
    quality: 'any',
    audioLang: '',
    subLang: '',
    label: title,
  });
  await playlists.setRendered(token, playlists.render([
    { url: plan.mediaUrl, title, options: [] },
  ]));
  return token;
}

// This same request, asking for a different player. Used for Android's
// browser_fallback_url, and by the client when a hand-off goes nowhere.
function retarget(req, target) {
  const url = new URL(req.originalUrl, originOf(req));
  url.searchParams.set('target', target);
  return url.toString();
}

function safeFilename(text) {
  return String(text || 'nuvio')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .slice(0, 60) || 'nuvio';
}

app.get('/play', async (req, res, next) => {
  try {
    const mediaUrl = req.query.url;
    if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
      return res.status(400).send('Give me an http(s) stream URL to hand over.');
    }

    const user = currentUser(req);
    const { type, id } = req.query;
    const prefs = { ...DEFAULT_PREFS, ...(user?.prefs || {}) };
    const plan = {
      mediaUrl,
      type,
      id,
      filename: req.query.filename,
      title: req.query.title || req.query.filename || 'Nuvio',
    };

    // Picking a stream by hand shouldn't cost you the queue: that file becomes
    // track one and the rest of the season is resolved automatically.
    if (user && prefs.binge && type === 'series' && id) {
      const episodes = await seasonPlaylist(user, id).catch(() => []);
      if (episodes.length > 1) {
        plan.title = episodes[0].show || plan.title;
        plan.playlistToken = await playlists.create({
          sid: user.sid,
          type,
          seriesId: id,
          episodes,
          quality: prefs.quality,
          audioLang: prefs.audioLang,
          subLang: prefs.subLang,
          firstStream: { url: mediaUrl },
          label: plan.title,
        });
      }
    }

    // vlc-x-callback has no parameters for track languages, so anything with a
    // language preference goes through a one-entry playlist instead — that's
    // the only channel that carries #EXTVLCOPT.
    if (!plan.playlistToken && user && (prefs.audioLang || prefs.subLang) && type && id) {
      plan.playlistToken = await singleTrackPlaylist(user, {
        type, id, prefs,
        stream: { url: mediaUrl, filename: req.query.filename },
        addons: await installedAddons(user),
      });
    }

    await deliver(req, res, plan);
  } catch (err) { next(err); }
});

app.post('/api/prefs', requireUser, async (req, res, next) => {
  try {
    const lang = (value) => (languages.find(value) ? String(value).toLowerCase() : '');
    const prefs = {
      autoplay: Boolean(req.body?.autoplay),
      binge: Boolean(req.body?.binge),
      quality: ['any', '2160p', '1080p', '720p'].includes(req.body?.quality) ? req.body.quality : 'any',
      audioLang: lang(req.body?.audioLang),
      subLang: lang(req.body?.subLang),
    };
    await store.update(req.user, { prefs });
    res.json(prefs);
  } catch (err) { next(err); }
});

// -------------------------------------------------------------- autoplay

const DEFAULT_PREFS = {
  autoplay: false,
  binge: false,
  quality: 'any',
  audioLang: '',   // '' means leave it to VLC
  subLang: '',     // '' means no subtitle preference
};

// Everything playable, best first: the quality preference floats to the top,
// then the addons' own ranking. Returning the whole list rather than one pick
// is what lets a dead link fall through to the next one.
function rankStreams(list, { quality = 'any', audioLang = '' } = {}) {
  let playable = list.filter((s) => s.playable);

  if (quality !== 'any') {
    const matching = playable.filter((s) => (s.badges || []).includes(quality));
    playable = [...matching, ...playable.filter((s) => !(s.badges || []).includes(quality))];
  }

  // A release name saying "VOSTFR" or "Dual Audio" is a hint about the audio
  // track, so float those up — but never drop the others, since most releases
  // say nothing about language at all and would vanish.
  if (audioLang) {
    const mentions = (s) => languages.streamMentions(`${s.headline} ${s.detail}`, audioLang);
    playable = [...playable.filter(mentions), ...playable.filter((s) => !mentions(s))];
  }

  return playable;
}

// How hard to check a candidate before putting it in a playlist.
//
//   head  (default) — a HEAD request only. Safe with every provider.
//   off             — trust the addon's ranking, check nothing.
//   full            — HEAD, then a one-byte range GET if HEAD is refused.
//
// `full` is deliberately not the default. Several debrid providers issue
// single-use or concurrency-limited links, and a range GET can consume one —
// making the probe itself the reason the episode won't play later. That
// failure looks exactly like VLC skipping episodes at random.
const PROBE_MODE = process.env.STREAM_PROBE || 'head';
const PROBE_LIMIT = Number(process.env.STREAM_PROBE_LIMIT || 3);
const PROBE_TIMEOUT_MS = Number(process.env.STREAM_PROBE_TIMEOUT_MS || 6000);

// Returns 'ok' when something answered, 'dead' on a definite refusal, and
// 'unknown' when the check couldn't tell. Only a definite refusal moves on to
// the next candidate — treating "can't tell" as dead is how good links get
// discarded.
async function probe(url) {
  if (PROBE_MODE === 'off') return 'unknown';

  const attempts = PROBE_MODE === 'full'
    ? [{ method: 'HEAD' }, { method: 'GET', headers: { range: 'bytes=0-0' } }]
    : [{ method: 'HEAD' }];

  for (const init of attempts) {
    try {
      const res = await fetch(url, {
        ...init,
        redirect: 'follow',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.ok || res.status === 206) return 'ok';
      // 403/405/501 mean the method or the bare request was refused, not that
      // the file is missing. Plenty of CDNs answer HEAD with 403 and serve the
      // GET happily.
      if ([403, 405, 501].includes(res.status)) continue;
      return 'dead';
    } catch {
      return 'unknown';
    }
  }
  return 'unknown';
}

// Walks the candidates, stopping at the first that isn't definitely dead. If
// every one is dead, the best is used anyway — a doubtful link still beats an
// episode missing from the playlist.
async function resolvePlayable(candidates) {
  if (!candidates.length) return null;

  for (const candidate of candidates.slice(0, PROBE_LIMIT)) {
    const result = await probe(candidate.url);
    if (result !== 'dead') return { stream: candidate, probe: result };
  }
  return { stream: candidates[0], probe: 'dead' };
}

function originOf(req) {
  return PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

// The whole binge mechanism: hand VLC this episode, and set x-success to the
// *next* episode's copy of this same route. When VLC finishes and bounces
// back, Safari hits that URL, which redirects straight into VLC again. No
// queue state on the server — each link only needs to know its successor.
const BINGE_EPISODE_LIMIT = Number(process.env.BINGE_EPISODE_LIMIT || 60);

// The whole season the chosen episode belongs to, in the meta addon's own
// order — so season boundaries and gaps in numbering come out right rather
// than being guessed at by incrementing the episode number.
//
// The chosen episode leads, the rest of the season follows, and the episodes
// before it are appended at the end. VLC always starts an M3U at track one and
// gives no way to set a start index, so leading with the chosen episode is the
// only way to start where you asked. Putting the earlier ones at the end keeps
// them in the playlist, so you can still reach any episode of the season from
// VLC's playlist view instead of only being able to go forwards.
async function seasonPlaylist(user, seriesId) {
  const baseId = seriesId.split(':')[0];
  const meta = await addonsApi.meta(await installedAddons(user), 'series', baseId);
  if (!meta) return [];
  const videos = meta.videos || [];

  const current = videos.find((v) => v.id === seriesId);
  if (!current) return [];

  // Specials (season 0) and anything unnumbered stay with their own group.
  const season = videos.filter((v) => v.season === current.season);
  const ordered = season.length ? season : videos;

  const at = ordered.findIndex((v) => v.id === seriesId);
  const rotated = [...ordered.slice(at), ...ordered.slice(0, at)];

  return rotated.slice(0, BINGE_EPISODE_LIMIT).map((v) => ({
    id: v.id,
    season: v.season,
    episode: v.episode,
    title: v.title || null,
    show: meta.name,
  }));
}

function playlistUrl(req, token) {
  return `${originOf(req)}/playlist/${token}.m3u`;
}

// VLC bounces back into Safari, so a dead end needs to be a readable page
// rather than a JSON blob or a blank screen.
function noStreamPage(origin, message) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nuvio</title>
<style>body{background:#0D0D0D;color:#fff;font:15px/22px -apple-system,system-ui;padding:48px 24px;text-align:center}
a{display:inline-block;margin-top:20px;padding:13px 28px;border-radius:40px;background:#fff;color:#0D0D0D;font-weight:700;text-decoration:none}</style>
<p>${message}</p><a href="${origin}">Back to Nuvio</a>`;
}

app.get('/play/auto/:type/:id', requireUser, async (req, res, next) => {
  try {
    const { type, id } = req.params;
    const prefs = { ...DEFAULT_PREFS, ...(req.user.prefs || {}) };

    // With binge on, hand the player a playlist of what's coming rather than
    // a single file — it gets a real queue with next/previous of its own.
    if (prefs.binge && type === 'series') {
      const episodes = await seasonPlaylist(req.user, id).catch(() => []);
      if (episodes.length > 1) {
        const label = episodes[0].show || 'Nuvio';
        const token = await playlists.create({
          sid: req.user.sid, type, seriesId: id, episodes, quality: prefs.quality,
          audioLang: prefs.audioLang, subLang: prefs.subLang, label,
        });
        return deliver(req, res, { playlistToken: token, type, id, title: label });
      }
    }

    const addons = await installedAddons(req.user, { wait: true });
    const list = await addonsApi.streams(addons, type, id);
    // Live TV: don't probe. IPTV plans allow one or two connections, and a
    // probe can hold one long enough that the real stream is then refused.
    const ranked = rankStreams(list, prefs);
    const chosen = type === 'tv'
      ? (ranked.length ? { stream: ranked[0], probe: 'unknown' } : null)
      : await resolvePlayable(ranked);
    if (!chosen) {
      if (req.query.format === 'json') return res.status(404).json({ error: 'No playable stream for this one.' });
      return res.status(404).send(noStreamPage(originOf(req), 'No playable stream for this one.'));
    }

    // vlc-x-callback has no parameters for track languages, so anything with a
    // language preference goes through a one-entry playlist instead — that's
    // the only channel that carries #EXTVLCOPT.
    if (prefs.audioLang || prefs.subLang) {
      const token = await singleTrackPlaylist(req.user, {
        type, id, prefs, stream: chosen.stream, addons,
      });
      return deliver(req, res, {
        playlistToken: token, type, id,
        title: chosen.stream.headline || chosen.stream.filename || 'Nuvio',
      });
    }

    return deliver(req, res, {
      mediaUrl: chosen.stream.url,
      type,
      id,
      filename: chosen.stream.filename,
      title: chosen.stream.headline || chosen.stream.filename || 'Nuvio',
    });
  } catch (err) { next(err); }
});

// One entry, pre-rendered: the stream is already resolved, so there is nothing
// to look up when VLC fetches it.
async function singleTrackPlaylist(user, { type, id, prefs, stream, addons }) {
  const subtitleUrl = await findSubtitle(addons, type, id, prefs.subLang);
  const options = playlists.optionsFor({
    audioLang: languages.toVlc(prefs.audioLang),
    subLang: languages.toVlc(prefs.subLang),
    subtitleUrl,
  });

  const token = await playlists.create({
    sid: user.sid, type, seriesId: id, episodes: [], quality: prefs.quality,
    audioLang: prefs.audioLang, subLang: prefs.subLang,
    label: stream.filename || stream.headline || 'Nuvio',
  });
  await playlists.setRendered(token, playlists.render([{
    url: stream.url,
    title: stream.filename || stream.headline || 'Nuvio',
    options,
  }]));
  return token;
}

// Resolving a record into a playlist. Streams are looked up here rather than
// when the record was created, so nothing is spent on episodes that are never
// watched — and the result is cached, because a player re-reads the file as
// it advances.
//
// Both the .m3u VLC fetches and the queue the browser player shows come
// through this one function, so the two can never disagree about what is in
// the season.
class PlaylistError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function materialize(record) {
  if (record.rendered) return record.rendered;

  const user = record.sid ? store.get(record.sid) : null;
  if (!user) throw new PlaylistError('SIGNED_OUT', 'Sign in again to rebuild this playlist.');

  {
    const addons = await installedAddons(user);

    // Resolve every episode at once. A single dead addon shouldn't hold up the
    // playlist, and an episode nobody has a stream for is simply left out.
    const audioLang = languages.toVlc(record.audioLang);
    const subLang = languages.toVlc(record.subLang);

    // Every episode's outcome is recorded, including the ones that produced
    // nothing, so /playlist/<token>/report can explain a short playlist
    // instead of leaving you guessing which episodes went missing and why.
    const resolved = await Promise.all(record.episodes.map(async (ep, index) => {
      const label = episodeTitle(ep);
      const subtitleUrl = await findSubtitle(addons, 'series', ep.id, record.subLang);
      const options = playlists.optionsFor({ audioLang, subLang, subtitleUrl });

      // The stream picked by hand leads, untouched — no second-guessing it.
      if (index === 0 && record.firstStream) {
        return { entry: { url: record.firstStream.url, title: label, options },
                 report: { episode: ep.id, title: label, outcome: 'hand-picked' } };
      }

      try {
        const all = await addonsApi.streams(addons, 'series', ep.id);
        const candidates = rankStreams(all, { quality: record.quality, audioLang: record.audioLang });

        if (!candidates.length) {
          return { entry: null, report: { episode: ep.id, title: label,
            outcome: 'no direct stream',
            detail: all.length ? `${all.length} result(s), all torrent-only` : 'no addon returned anything' } };
        }

        const chosen = await resolvePlayable(candidates);
        return { entry: { url: chosen.stream.url, title: label, options },
                 report: { episode: ep.id, title: label, outcome: 'ok',
                           probe: chosen.probe, source: chosen.stream.addon,
                           candidates: candidates.length } };
      } catch (err) {
        return { entry: null, report: { episode: ep.id, title: label,
          outcome: 'lookup failed', detail: err.message } };
      }
    }));

    // Only episodes with no http stream at all drop out — there is nothing to
    // hand VLC for a torrent-only episode. Everything else stays, even if its
    // link looked doubtful.
    const entries = resolved.map((r) => r.entry).filter(Boolean);
    await playlists.setReport(record.token, resolved.map((r) => r.report));
    if (!entries.length) {
      throw new PlaylistError('NO_STREAMS', 'No playable streams for these episodes.');
    }

    record.rendered = playlists.render(entries);
    await playlists.setRendered(record.token, record.rendered);
    return record.rendered;
  }
}

// What VLC — on any platform — actually fetches. ?dl=1 sends it as a download
// instead of inline, which is the hand-off on desktop: VLC is the default
// handler for .m3u on a normal install, so opening the file opens the stream.
app.get('/playlist/:token.m3u', async (req, res, next) => {
  try {
    const record = playlists.get(req.params.token);
    if (!record) {
      return res.status(404).type('text/plain').send('This playlist has expired. Start it again from the app.');
    }

    const rendered = await materialize(record);
    return sendPlaylist(res, rendered, {
      download: req.query.dl === '1',
      name: safeFilename(record.label || 'nuvio'),
    });
  } catch (err) {
    if (err instanceof PlaylistError) {
      return res.status(err.code === 'SIGNED_OUT' ? 401 : 404).type('text/plain').send(err.message);
    }
    return next(err);
  }
});

// Open this in a browser after a binge misbehaves: it names every episode the
// playlist was built from and what became of it.
app.get('/playlist/:token/report', requireUser, (req, res) => {
  const record = playlists.get(req.params.token);
  if (!record) return res.status(404).json({ error: 'No such playlist, or it has expired.' });
  if (record.sid !== req.user.sid) return res.status(403).json({ error: 'Not your playlist.' });

  const report = record.report || [];
  res.json({
    series: record.seriesId,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    probeMode: PROBE_MODE,
    episodesRequested: record.episodes.length,
    episodesIncluded: report.filter((r) => r.outcome === 'ok' || r.outcome === 'hand-picked').length,
    episodes: report,
  });
});

function sendPlaylist(res, rendered, { download = false, name = 'nuvio' } = {}) {
  res.type('audio/x-mpegurl');
  res.setHeader(
    'content-disposition',
    `${download ? 'attachment' : 'inline'}; filename="${name}.m3u"`,
  );
  res.setHeader('cache-control', 'no-store');
  res.send(rendered);
}

// A subtitle addon's best match for the preferred language, if any. Failure
// is silent: subtitles are a nicety and shouldn't stop a playlist rendering.
async function findSubtitle(addons, type, id, code) {
  if (!code) return null;
  try {
    const all = await addonsApi.subtitles(addons, type, id);
    const match = all.find((sub) => languages.subtitleMatches(sub.lang, code));
    if (!match) return null;

    // An unreachable input-slave can fail the item it's attached to, which
    // would make VLC skip an episode over a missing subtitle file. Only
    // attach one that answers.
    return (await probe(match.url)) === 'dead' ? null : match.url;
  } catch {
    return null;
  }
}

// The episode after this one, for the built-in player: at the end of an
// episode (or on Next) it asks for this and plays it, without building a
// whole season playlist up front. Specials (season 0) are skipped.
// The episode after `id` in its show (specials skipped, nothing unaired).
async function episodeAfter(user, id) {
  const meta = await addonsApi.meta(await installedAddons(user), 'series', progress.baseId(id));
  const videos = (meta?.videos || [])
    .filter((v) => v.id && Number(v.season) > 0)
    .sort((a, b) => (Number(a.season) - Number(b.season)) || (Number(a.episode ?? a.number) - Number(b.episode ?? b.number)));
  const at = videos.findIndex((v) => v.id === id);
  const upcoming = at >= 0 ? videos[at + 1] : null;
  if (!upcoming || (upcoming.released && Date.parse(upcoming.released) > Date.now())) return null;
  return { id: upcoming.id, season: upcoming.season, episode: upcoming.episode ?? upcoming.number, title: upcoming.title || upcoming.name || null };
}

app.get('/api/next/:id', requireUser, async (req, res, next) => {
  try {
    const upcoming = await episodeAfter(req.user, String(req.params.id));
    if (!upcoming) return res.status(404).json({ error: 'That was the last episode.' });
    return res.json(upcoming);
  } catch (err) { return next(err); }
});

// ------------------------------------------------------- continue watching

// What a title looks like on the row: name and artwork from its metadata,
// fetched once when it first appears and kept with the entry.
async function artworkFor(user, type, id) {
  try {
    const meta = await addonsApi.meta(await installedAddons(user), type, type === 'tv' ? id : progress.baseId(id));
    return { name: meta?.name || null, poster: meta?.poster || null, background: meta?.background || null };
  } catch { return {}; }
}

function episodeParts(id) {
  const [, season, episode] = String(id).split(':');
  return season && episode ? { season: Number(season), episode: Number(episode) } : {};
}

// Continue watching comes from Nuvio itself (sync_pull_watch_progress), so it
// matches the Nuvio apps on the phone and TV, and what's watched here shows
// up there. The bridge's own little store only adds what Nuvio doesn't keep:
// artwork for the row, and "next episode" cards after one finishes. If the
// Nuvio call fails, the local store stands in so the row still works.
const artCache = new Map();
async function artFor(user, entry, local) {
  const base = progress.titleKey(entry);
  const mine = local.find((e) => progress.titleKey(e) === base && (e.poster || e.background));
  if (mine) return { name: mine.name, poster: mine.poster, background: mine.background };
  if (!artCache.has(base)) artCache.set(base, await artworkFor(user, entry.type, entry.id));
  return artCache.get(base);
}

function remoteShowable(e) {
  return e.duration > 0 && e.position >= 30 && e.position / e.duration < progress.FINISHED;
}

async function continueWatching(user, index) {
  const local = await progress.list(user, index);
  let remote;
  try {
    remote = await nuvio.pullProgress(await accessToken(user), index);
  } catch (err) {
    console.error(`continue watching: Nuvio pull failed (${err.message}), using local`);
    return local.filter(progress.showable).slice(0, 20);
  }

  // One card per title: its most recent episode.
  const latest = new Map();
  for (const e of remote) {
    const prev = latest.get(e.contentId);
    if (!prev || e.updatedAt > prev.updatedAt) latest.set(e.contentId, e);
  }
  const cards = [...latest.values()].filter(remoteShowable);
  // "Next episode" cards from here, unless Nuvio has something newer for that show.
  for (const e of local.filter((l) => l.upNext)) {
    const there = latest.get(progress.baseId(e.id));
    if (!there || there.updatedAt < e.updatedAt) {
      if (!cards.some((c) => progress.baseId(c.id) === progress.baseId(e.id))) cards.push(e);
    }
  }
  // Live channels watched here: Nuvio's progress sync has no place for them
  // (it needs a position and a length), so they come from the bridge's store.
  for (const e of local.filter((l) => l.live && progress.showable(l))) cards.push(e);
  cards.sort((a, b) => b.updatedAt - a.updatedAt);
  const top = cards.slice(0, 20);
  return Promise.all(top.map(async (e) => ({ ...e, ...(e.upNext || e.live ? {} : await artFor(user, e, local)) })));
}

app.get('/api/progress', requireUser, async (req, res, next) => {
  try {
    res.json(await continueWatching(req.user, await profileIndex(req.user)));
  } catch (err) { next(err); }
});

// The player reports where it is every so often, and when it stops. Pushed to
// Nuvio straight away, so the other apps can resume from here.
app.post('/api/progress', requireUser, async (req, res, next) => {
  try {
    const { type, id } = req.body || {};
    const position = Math.max(0, Number(req.body?.position) || 0);
    const duration = Math.max(0, Number(req.body?.duration) || 0);
    if (!['movie', 'series', 'tv'].includes(type) || !id) return res.status(400).json({ error: 'type and id, please.' });

    // A live channel: remember that it was watched, with its logo and name,
    // for the Continue watching row. Kept on the bridge only.
    if (type === 'tv') {
      const index = await profileIndex(req.user);
      const known = (await progress.list(req.user, index)).find((e) => e.type === 'tv' && e.id === String(id));
      const art = known?.poster ? {} : await artworkFor(req.user, 'tv', String(id));
      await progress.record(req.user, index, {
        type: 'tv', id: String(id), live: true, position: 0, duration: 0,
        ...art, ...(known?.poster ? {} : { background: null }),
      });
      return res.json({ ok: true });
    }

    const user = req.user;
    const index = await profileIndex(user);
    const token = await accessToken(user);
    const parts = episodeParts(id);
    const contentId = progress.baseId(id);
    const known = (await progress.list(user, index)).find((e) => progress.baseId(e.id) === contentId);
    const art = known?.poster || known?.background ? {} : await artworkFor(user, type, id);

    // Finished: off Continue watching everywhere; a show moves on a step.
    if (duration && position / duration >= progress.FINISHED) {
      await nuvio.deleteProgress(token, index, [nuvio.progressKey({ contentId, ...parts })]).catch(() => {});
      const upcoming = type === 'series' ? await episodeAfter(user, String(id)).catch(() => null) : null;
      if (upcoming) {
        await progress.record(user, index, {
          type, id: upcoming.id, position: 0, duration: 0, upNext: true,
          season: upcoming.season, episode: upcoming.episode, episodeTitle: upcoming.title, ...art,
        });
      } else {
        await progress.remove(user, index, String(id));
      }
      return res.json({ ok: true, finished: true });
    }

    await progress.record(user, index, {
      type, id: String(id), position, duration, upNext: false, ...parts, ...art,
    });
    try {
      await nuvio.pushProgress(token, index, { contentId, type, id: String(id), position, duration, ...parts });
    } catch (err) {
      console.error(`continue watching: Nuvio push failed (${err.message})`);
    }
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

app.delete('/api/progress/:id', requireUser, async (req, res, next) => {
  try {
    const user = req.user;
    const index = await profileIndex(user);
    const id = String(req.params.id);
    await progress.remove(user, index, id);
    // Every entry Nuvio has for that title, so it doesn't come straight back.
    try {
      const token = await accessToken(user);
      const remote = await nuvio.pullProgress(token, index);
      const keys = remote.filter((e) => e.contentId === progress.baseId(id)).map((e) => e.key).filter(Boolean);
      await nuvio.deleteProgress(token, index, keys);
    } catch (err) {
      console.error(`continue watching: Nuvio delete failed (${err.message})`);
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Where this profile left off in `id`, from Nuvio (so a film paused in the
// Nuvio app resumes here), falling back to the bridge's own record.
async function resumeAt(user, id, memo = {}) {
  try {
    const index = await profileIndex(user);
    let entry = null;
    try {
      // One pull per ticket, however many episodes it has.
      memo.remote ??= accessToken(user).then((t) => nuvio.pullProgress(t, index));
      const remote = await memo.remote;
      entry = remote.find((e) => e.id === id) || null;
    } catch { /* fall back */ }
    if (!entry) {
      const local = await progress.get(user, index, id);
      if (local && !local.upNext) entry = local;
    }
    return entry && entry.duration && entry.position / entry.duration < progress.FINISHED ? Math.floor(entry.position) : 0;
  } catch { return 0; }
}

// Names for the player's heading, from the title's metadata. Looked up once
// per ticket; any failure just means a plainer heading.
async function headings(record, user) {
  const type = record.type === 'series' ? 'series' : (record.type || 'movie');
  const baseId = String(record.seriesId || '').split(':')[0];
  let meta = null;
  if (baseId && user) {
    try { meta = await addonsApi.meta(await installedAddons(user), type, baseId); } catch { /* plainer */ }
  }
  const episodes = new Map((record.episodes || []).map((ep) => [ep.id, ep]));
  const videos = new Map((meta?.videos || []).map((v) => [v.id, v]));

  return (id) => {
    if (type === 'series') {
      const ep = episodes.get(id) || videos.get(id);
      const [, season, episode] = String(id || '').split(':');
      const s = ep?.season ?? (season ? Number(season) : null);
      const e = ep?.episode ?? ep?.number ?? (episode ? Number(episode) : null);
      const name = ep?.title || ep?.name || null;
      const code = s != null && e != null ? `S${s} · E${e}` : null;
      return {
        title: meta?.name || ep?.show || record.label || 'Now playing',
        detail: [code, name && !/^episode \d+$/i.test(name) ? name : null].filter(Boolean).join(' · '),
      };
    }
    const year = meta?.releaseInfo || meta?.year || null;
    return { title: meta?.name || record.label || 'Now playing', detail: year ? String(year) : '' };
  };
}

function episodeTitle(ep) {
  const code = ep.season != null ? `S${ep.season}E${ep.episode}` : null;
  return [ep.show, code, ep.title].filter(Boolean).join(' - ');
}

// ------------------------------------------------------- browser player

// The queue, for the player built into the page. Same record VLC would get,
// read out as JSON rather than M3U: the subtitle VLC would side-load with
// input-slave comes back as a converted WebVTT track, because that is the
// only subtitle format a browser will display.
app.get('/api/ticket/:token', async (req, res, next) => {
  try {
    const record = playlists.get(req.params.token);
    if (!record) return res.status(404).json({ error: 'This playlist has expired. Start it again.' });

    // A record made while signed in belongs to that device.
    const user = currentUser(req);
    if (record.sid && record.sid !== user?.sid) {
      return res.status(403).json({ error: 'Not your playlist.' });
    }

    const rendered = await materialize(record);
    const entries = playlists.parse(rendered);
    // Which title each entry is, so the player can list the other sources
    // for the one on screen. Episodes are matched by the label they were
    // rendered with; a single item is the record's own id.
    const idByTitle = new Map((record.episodes || []).map((ep) => [episodeTitle(ep), ep.id]));

    // What the player shows at the top: the film's name, or the show with
    // the season, episode and episode title — never the stream's file name.
    const headingFor = await headings(record, user);
    const resumeMemo = {};

    res.json({
      title: record.label || 'Nuvio',
      type: record.type,
      id: record.seriesId,
      proxyAvailable: proxy.enabled,
      transcodeAvailable: transcode.isAvailable(),
      items: await Promise.all(entries.map(async (entry) => {
        const slave = subtitlesLib.slaveUrlFrom(entry.options);
        const itemId = idByTitle.get(entry.title) || record.seriesId || null;
        // Where this profile left off in it, on any device.
        const resume = itemId && user ? await resumeAt(user, itemId, resumeMemo) : 0;
        return {
          title: entry.title,
          id: itemId,
          heading: headingFor(itemId),
          resume,
          url: entry.url,
          // Only offered, never used unless direct playback fails.
          // Offered, never used unless the browser has already refused the
          // file — converting is the most expensive thing this server does.
          // This is the signature to start a session with, not a playable URL.
          transcodeKey: transcode.isAvailable() ? await signing.sign(entry.url) : null,
          subtitle: slave && subtitlesLib.convertible(slave)
            ? await signing.signedPath('/sub.vtt', slave)
            : null,
        };
      })),
    });
  } catch (err) {
    if (err instanceof PlaylistError) {
      return res.status(err.code === 'SIGNED_OUT' ? 401 : 404).json({ error: err.message });
    }
    return next(err);
  }
});

// Every subtitle an addon has for this title, for the player's subtitle menu.
// Formats a browser can't render — archives, and the image-based ones — are
// left out rather than offered and then failing.
app.get('/api/subtitles/:type/:id', requireUser, async (req, res, next) => {
  try {
    const { type, id } = req.params;
    const all = await addonsApi.subtitles(await installedAddons(req.user), type, id);

    // The language to match: the player's own choice for this session if it
    // sent one, else the default from Settings, else the audio language,
    // else English — subtitles are on by default.
    const prefs = { ...DEFAULT_PREFS, ...(req.user.prefs || {}) };
    const want = String(req.query.lang || prefs.subLang || prefs.audioLang || 'en');
    const openSubs = (sub) => /opensubtitles/i.test(String(sub.addon || ''));

    const usable = all.filter((sub) => subtitlesLib.convertible(sub.url));
    // In the wanted language first, OpenSubtitles first within that.
    usable.sort((a, b) => {
      const la = languages.trackMatches(a.lang, want) ? 0 : 1;
      const lb = languages.trackMatches(b.lang, want) ? 0 : 1;
      if (la !== lb) return la - lb;
      return (openSubs(a) ? 0 : 1) - (openSubs(b) ? 0 : 1);
    });
    res.json(await Promise.all(usable.slice(0, 40).map(async (sub) => ({
      id: sub.id,
      lang: sub.lang,
      label: languages.nameOf(sub.lang) || sub.lang || 'Unknown',
      addon: sub.addon,
      matches: languages.trackMatches(sub.lang, want),
      openSubtitles: openSubs(sub),
      url: await signing.signedPath('/sub.vtt', sub.url),
    }))));
  } catch (err) { next(err); }
});

// SubRip in, WebVTT out. Signed, so this can't be used to make the server
// fetch arbitrary URLs from inside whatever network it sits on.
app.get('/sub.vtt', async (req, res) => {
  const url = await signing.verify(req.query.u, req.query.s);
  if (!url) return res.status(403).type('text/plain').send('Expired or invalid subtitle link.');

  try {
    const upstream = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!upstream.ok) return res.status(502).type('text/plain').send('The subtitle host refused that.');

    res.type('text/vtt; charset=utf-8');
    res.setHeader('cache-control', 'private, max-age=3600');
    // Bytes, not text: many subtitle files aren't UTF-8, and decoding them as
    // if they were turns every accented letter into garbage.
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    return res.send(subtitlesLib.convert(subtitlesLib.decode(bytes, url)));
  } catch {
    return res.status(504).type('text/plain').send('The subtitle host did not answer.');
  }
});

// Video through the server. Off unless MEDIA_PROXY=true — see src/proxy.js
// for why you might want it and what it costs.
// A restreamed file. Range requests pass through in both directions, which is
// what lets the browser seek it natively.
app.get('/media', async (req, res, next) => {
  if (!proxy.enabled) return res.status(404).type('text/plain').send('Restreaming is off on this server.');

  const url = await signing.verify(req.query.u, req.query.s);
  if (!url) return res.status(403).type('text/plain').send('Expired or invalid link.');

  try {
    return await proxy.pipe(url, req, res);
  } catch (err) { return next(err); }
});

// Starting a conversion. Returns an HLS playlist URL once there is enough
// converted to play without stalling on the first segment.
app.post('/api/transcode/start', requireUser, async (req, res) => {
  if (!transcode.isAvailable()) return res.status(404).json({ error: 'ffmpeg is not in this build.' });

  const url = await signing.verify(req.body?.u, req.body?.s);
  if (!url) return res.status(403).json({ error: 'Expired or invalid link.' });

  // Switching audio track or seeking outside what has been converted replaces
  // the old session rather than leaving a second ffmpeg running.
  if (req.body?.replace) transcode.stop(String(req.body.replace));

  try {
    const plan = await transcode.inspect(url);
    // An image subtitle to burn in (ffmpeg stream index), or none.
    const burn = Number.isInteger(req.body?.burn) ? req.body.burn : null;
    const prefs = { ...DEFAULT_PREFS, ...(req.user.prefs || {}) };

    // Default languages from Settings. The player sends no audio index on a
    // first start, so the track in the preferred language is picked here;
    // an explicit choice from the player's menu always wins.
    let audioIndex = Number.isInteger(req.body?.audio) ? req.body.audio : null;
    if (audioIndex === null && prefs.audioLang) {
      const match = (plan?.audioTracks || []).find((t) => languages.trackMatches(t.lang, prefs.audioLang));
      if (match) audioIndex = match.index;
    }
    // The subtitle track inside the file to turn on by default: text first
    // (drawn by the browser, free), an image track only if nothing else.
    let preferredSubtitle = null;
    if (prefs.subLang) {
      const inLang = (plan?.subtitleTracks || [])
        .filter((t) => t.render && languages.trackMatches(t.lang, prefs.subLang));
      const pick = inLang.find((t) => t.render === 'text' && !t.forced)
        || inLang.find((t) => !t.forced) || inLang[0];
      if (pick) preferredSubtitle = pick.stream;
    }
    const subtitleTracks = await subtitleLinks(plan?.subtitleTracks, url);

    // If the browser can play the file as it stands, restream it instead of
    // converting it. Nothing is gained by rebuilding an MP4 of H.264 and AAC
    // into an MP4 of H.264 and AAC, and a great deal is lost: the browser
    // seeks a restreamed file natively, instantly, anywhere in it, while a
    // converted one can only seek within what ffmpeg has produced so far.
    //
    // The audio-track picker is the one casualty — choosing a track means
    // ffmpeg mapping it — so a file with more than one goes the long way.
    // More than one audio track goes through Lumen so the player can offer
    // them; a browser only ever plays a file's first track on its own.
    const multiTrack = (plan?.audioTracks?.length || 0) > 1;
    // forceDirect: an external player is being handed the file, so restream
    // it if the codecs allow at all, even where we'd normally convert for the
    // sake of an audio-track picker we can't offer it anyway.
    const wantsDirect = plan?.direct
      || (req.body?.forceDirect === true && plan?.directStreamsOnly);

    if (wantsDirect && proxy.enabled && !req.body?.forceTranscode && burn === null
        && (!multiTrack || req.body?.forceDirect === true)) {
      return res.json({
        mode: 'direct',
        url: await signing.signedPath('/media', url),
        duration: plan.duration,
        videoCodec: plan.videoCodec,
        audioCodec: plan.audioCodec,
        subtitleTracks,
        preferredSubtitle,
      });
    }

    // A desktop with the VLC launcher sends preferExternal. A file the browser
    // can't play as it stands goes to VLC as a stream instead of being
    // converted here, so no ffmpeg is started for it. forceTranscode (the
    // person chose to play it here anyway) still converts.
    if (req.body?.preferExternal === true && !plan?.direct && !req.body?.forceTranscode && burn === null) {
      return res.json({
        mode: 'external',
        duration: plan?.duration,
        videoCodec: plan?.videoCodec,
        audioCodec: plan?.audioCodec,
        container: plan?.container,
      });
    }

    const session = await transcode.start(url, {
      audio: Math.max(0, audioIndex || 0),
      seek: Math.max(0, Math.floor(Number(req.body?.seek) || 0)),
      burn,
      plan,
    });
    return res.json({ mode: 'hls', ...session, subtitleTracks, preferredSubtitle });
  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
});

// Subtitles inside the file, for the player's menu. Text ones get a signed
// link to their WebVTT; image ones are listed so they can be burned in.
async function subtitleLinks(tracks, url) {
  return Promise.all((tracks || []).map(async (track) => ({
    ...track,
    url: track.render ? `${await signing.signedPath('/api/transcode/subtitle', url)}&i=${track.stream}` : null,
  })));
}

// A text subtitle track from inside the file, converted to WebVTT.
app.get('/api/transcode/subtitle', requireUser, async (req, res) => {
  if (!transcode.isAvailable()) return res.status(404).type('text/plain').send('ffmpeg is not in this build.');
  const url = await signing.verify(req.query.u, req.query.s);
  if (!url) return res.status(403).type('text/plain').send('Expired or invalid subtitle link.');
  const stream = Number(req.query.i);
  if (!Number.isInteger(stream)) return res.status(400).type('text/plain').send('Which track?');
  try {
    const file = await transcode.subtitle(url, stream);
    res.setHeader('cache-control', 'private, max-age=86400');
    return res.sendFile(file);
  } catch (err) {
    return res.status(502).type('text/plain').send(err.message);
  }
});

// The player beats while it plays, so a closed tab doesn't leave ffmpeg
// running and a directory of segments behind.
app.post('/api/transcode/heartbeat/:sid', (req, res) => {
  if (!transcode.heartbeat(req.params.sid)) return res.status(404).json({ error: 'That session is gone.' });
  return res.json({ ok: true });
});

// Scrubbing: the player says where the seek bar is heading, so conversion can
// start there before the drag ends.
app.post('/api/transcode/prepare/:sid', (req, res) => {
  const ok = transcode.prepare(req.params.sid, Number(req.body?.t));
  return res.status(ok ? 200 : 404).json({ ok });
});

// What a session is actually doing, for when playback fails and the logs are
// in a container. Safe to expose: it names codecs and counts, nothing more.
app.get('/api/transcode/debug/:sid', requireUser, (req, res) => {
  const report = transcode.diagnose(req.params.sid);
  if (!report) return res.status(404).json({ error: 'No such session.' });
  return res.json(report);
});

app.post('/api/transcode/stop/:sid', (req, res) => {
  transcode.stop(req.params.sid);
  res.json({ ok: true });
});

// The playlist and its segments. No signing here: the session id is the
// credential, it is random, and it dies with the session.
app.get('/hls/:sid/:file', (req, res) => {
  const { sid, file } = req.params;

  if (file.endsWith('.m3u8')) {
    const playlist = transcode.readPlaylist(sid);
    if (!playlist) return res.status(404).type('text/plain').send('That conversion has ended.');
    res.type('application/vnd.apple.mpegurl');
    // A growing playlist that gets cached is a playlist that stops growing.
    res.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
    return res.send(playlist);
  }

  // Segments are made on demand: a seek to one that doesn't exist yet
  // restarts ffmpeg right there and this waits for it.
  return transcode.segment(sid, file).then((found) => {
    if (!found.path) return res.status(found.status || 404).type('text/plain').send(found.error || 'No such segment.');
    res.type('video/mp2t');
    res.setHeader('cache-control', 'private, max-age=60');
    return res.sendFile(found.path);
  });
});

// ------------------------------------------------------- VLC launcher
//
// Desktop VLC can't be started from a web page until a small per-user handler
// for nuvio-vlc: links is installed. These serve that handler, generated for
// this server's origin, and a page explaining how to run it.

app.get('/vlc-launcher/:os', (req, res) => {
  const { os } = req.params;
  const file = vlcLauncher.FILES[os];
  if (!file) return res.status(404).type('text/plain').send('No launcher for that system.');
  let body;
  try {
    body = vlcLauncher.installer(os, originOf(req), { remove: req.query.remove === '1' });
  } catch (err) {
    return res.status(500).type('text/plain').send(err.message);
  }
  const name = req.query.remove === '1' ? file.name.replace('nuvio-vlc-', 'nuvio-vlc-remove-') : file.name;
  res.setHeader('cache-control', 'no-store');
  res.type(file.type);
  // curl | sh wants plain text; a browser click wants a file to save.
  if (req.query.dl === '1') res.setHeader('content-disposition', `attachment; filename="${name}"`);
  return res.send(body);
});

app.get('/vlc-setup', (req, res) => {
  const origin = originOf(req);
  const os = players.detect(req.get('user-agent')).os;
  res.setHeader('cache-control', 'no-store');
  res.type('text/html').send(vlcSetupPage(origin, os));
});

function htmlEscape(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function vlcSetupPage(origin, os) {
  const o = htmlEscape(origin);
  const section = (id, title, body) => `<section id="${id}"${id === os ? ' class="mine"' : ''}><h2>${title}</h2>${body}</section>`;
  const cmd = (text) => `<div class="cmd"><code>${htmlEscape(text)}</code><button type="button" data-copy="${htmlEscape(text)}">Copy</button></div>`;
  const order = ['windows', 'macos', 'linux'].sort((a, b) => (b === os) - (a === os));
  const sections = {
    windows: section('windows', 'Windows', `
      <ol><li>Install <a href="https://www.videolan.org/vlc/">VLC</a> if you haven't.</li>
      <li><a class="btn" href="/vlc-launcher/windows?dl=1">Download the launcher</a> and open it. If Windows warns about the file, choose <b>Run</b> (SmartScreen: <b>More info → Run anyway</b>).</li>
      <li>The first time you use Open in VLC, your browser asks to open PowerShell. Allow it and tick “always allow” for this site.</li></ol>
      <p class="small"><a href="/vlc-launcher/windows?dl=1&amp;remove=1">Download the remover</a></p>`),
    macos: section('macos', 'macOS', `
      <ol><li>Install <a href="https://www.videolan.org/vlc/">VLC</a> in Applications.</li>
      <li>Open Terminal and run:</li></ol>${cmd(`curl -fsSL ${origin}/vlc-launcher/macos | sh`)}
      <p>It adds a hidden “Nuvio VLC Launcher” app to ~/Applications. Your browser asks once before opening it.</p>
      <p class="small">To remove it: ${cmd(`curl -fsSL "${origin}/vlc-launcher/macos?remove=1" | sh`)}</p>`),
    linux: section('linux', 'Linux', `
      <ol><li>Install VLC (package, Flatpak or Snap all work).</li>
      <li>In a terminal, run:</li></ol>${cmd(`curl -fsSL ${origin}/vlc-launcher/linux | sh`)}
      <p>It installs for your user only, in ~/.local. Your browser asks once before opening it.</p>
      <p class="small">To remove it: ${cmd(`curl -fsSL "${origin}/vlc-launcher/linux?remove=1" | sh`)}</p>`),
  };
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Set up VLC — Nuvio</title>
<style>
:root{color-scheme:dark;--bg:#0D0D0D;--card:#1a1a1a;--line:#2c2c2c;--fg:#fff;--dim:#a3a3a3}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,system-ui,sans-serif}
main{max-width:680px;margin:0 auto;padding:40px 20px 64px}
h1{font-size:26px;margin:0 0 8px}h2{font-size:18px;margin:0 0 8px}
p,li{color:var(--dim)}b{color:var(--fg)}a{color:var(--fg)}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin:16px 0}
section.mine{border-color:#fff}
.btn,button.done{display:inline-block;background:#fff;color:#0D0D0D;font-weight:700;border:0;border-radius:40px;padding:10px 20px;text-decoration:none;cursor:pointer;font:inherit;font-weight:700}
.cmd{display:flex;gap:8px;align-items:center;background:#000;border:1px solid var(--line);border-radius:10px;padding:8px 8px 8px 12px;margin:8px 0;overflow-x:auto}
.cmd code{flex:1;white-space:nowrap;font:13px ui-monospace,monospace;color:var(--fg)}
.cmd button{background:transparent;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:4px 10px;cursor:pointer}
.small{font-size:13px}
</style>
<main>
<h1>Open Nuvio streams in VLC</h1>
<p>Desktop VLC doesn't open <b>vlc://</b> links by itself. This one-time setup adds a small launcher for your user account, so a vlc:// link starts VLC and streams the file it carries. Nothing is downloaded. It only passes plain http(s) stream URLs to VLC, plus playlists from <b>${o}</b>.</p>
${order.map((k) => sections[k]).join('\n')}
<p><button type="button" class="done" id="done">I've set it up</button></p>
<p class="small">VLC opens the stream itself, so this computer needs to reach it. Queues are streamed from the address above. If it uses a self-signed HTTPS certificate, VLC may refuse the connection.</p>
</main>
<script>
document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
  navigator.clipboard?.writeText(b.dataset.copy).then(() => { b.textContent = 'Copied'; });
}));
document.getElementById('done').addEventListener('click', () => {
  try { localStorage.setItem('nuvio.vlcLauncher', '1'); } catch (e) {}
  if (window.opener) window.close(); else location.href = '/';
});
</script></html>`;
}

// The player is a screen in the same single-page app, so this is index.html
// under a path the app can read a token from.
app.get('/watch', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ---------------------------------------------------------------- misc

app.get('/healthz', (req, res) => res.json({
  ok: true,
  accounts: store.accountCount(),
  devices: store.count(),
  playlists: playlists.count(),
  conversions: transcode.count(),
  acceleration: transcode.isAvailable() ? transcode.acceleration().name : null,
}));

// index.html must never be cached or a stale copy keeps pointing at old
// asset versions; the versioned assets themselves can cache hard.
app.use(staticFiles(path.join(__dirname, '..', 'public'), {
  setHeaders(res, filePath, req) {
    // A file asked for by version (/app.js?v=86) is that build's copy for
    // ever: index.html names the version, so a new build asks for a new URL.
    // Those can be held without even a revalidation round trip, which is
    // most of what made opening the home-screen app slow over a phone
    // connection — five 304s in series before anything could run.
    if (req?.query?.v && /\.(js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return;
    }
    // The app's own code must be revalidated on every load. It was cached for
    // a day, so after an update the new app.js ran against yesterday's
    // platform.js and failed ("setServerCaps is not a function"). no-cache
    // still uses the cached copy — it just checks it's current first (a
    // cheap 304). Only icons and the vendored library, which never change
    // under the same name, are held for a day.
    if (/\.(html|js|css|webmanifest)$/.test(filePath) && !filePath.includes(`${path.sep}vendor${path.sep}`)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));

app.use((err, req, res, _next) => {
  console.error(err);
  // A refresh token that Nuvio has revoked shouldn't look like a server fault.
  if (/refresh|invalid|expired|JWT/i.test(err.message)) {
    return res.status(401).json({ error: 'Your Nuvio session expired. Sign in again.' });
  }
  res.status(502).json({ error: err.message });
});

await store.init();
await playlists.init();

if (await transcode.detect()) {
  console.log(`ffmpeg found — converting for the browser with ${transcode.acceleration().label}`);
}

if (process.env.NUVIO_SERVER) {
  try {
    const found = await nuvio.discover(process.env.NUVIO_SERVER);
    console.log(`Discovered self-hosted backend at ${found.backendUrl}`);
  } catch (err) {
    console.warn(`Server discovery failed, using configured values: ${err.message}`);
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    transcode.stopAll();
    process.exit(0);
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Nuvio bridge on :${PORT} — backend ${nuvio.config.backendUrl}, ${store.count()} saved session(s)`);
});
