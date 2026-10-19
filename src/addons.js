// Stremio addon protocol, as the Nuvio clients implement it.
//
//   <base>/manifest.json
//   <base>/catalog/<type>/<id>.json
//   <base>/catalog/<type>/<id>/<extras>.json     extras joined with &
//   <base>/meta/<type>/<id>.json
//   <base>/stream/<type>/<id>.json
//
// Two rules from the app source that matter more than they look:
//
//  * Extras go in a *path segment*, not a query string, in the fixed order
//    search, genre, skip (buildCatalogUrl in features/catalog/CatalogData.kt).
//    Get the order wrong and some addons quietly return the wrong page.
//  * Resources declare their own types and idPrefixes, which override the
//    manifest-level ones. An addon is only asked for a resource it claims to
//    handle for that id (StreamsRepository.kt) — otherwise a Kitsu addon gets
//    asked about IMDb ids all day and every page waits on its timeouts.

const TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 15000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);
export const CATALOG_PAGE_SIZE = 100;
export const SLOW_TIMEOUT = Number(process.env.ADDON_SLOW_TIMEOUT_MS || 60000);

const cache = new Map();

function baseOf(transportUrl) {
  return transportUrl.replace(/\/manifest\.json.*$/, '').replace(/\/+$/, '');
}

// Addons that load a big list before answering their first request — Live
// TV downloads the whole IPTV playlist and guide — can take well over the
// usual 15 s the first time. Manifests and catalogs get longer; once the
// addon has loaded, it answers in milliseconds.
const SLOW_TIMEOUT_MS = Number(process.env.ADDON_SLOW_TIMEOUT_MS || 60000);

// How long an old answer may stand in when an addon is down or slow.
const STALE_MS = Number(process.env.ADDON_STALE_MS || 24 * 3600 * 1000);
const inflight = new Map();

// One request per URL at a time: the home screen asks for the same catalogs
// from several places at once, and a slow addon shouldn't be hit five times
// for the same thing. A failure falls back to the last good answer (up to a
// day old) — a row from an hour ago beats an empty one.
async function getJson(url, { timeout = TIMEOUT_MS } = {}) {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (inflight.has(url)) return inflight.get(url);

  const job = (async () => {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`${res.status} from ${redact(url)}`);
      const value = await res.json();
      cache.set(url, { value, expires: Date.now() + CACHE_TTL_MS, at: Date.now() });
      if (cache.size > 2000) cache.delete(cache.keys().next().value);
      return value;
    } catch (err) {
      if (hit && Date.now() - hit.at < STALE_MS) return hit.value;
      throw err;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, job);
  return job;
}

// Addon URLs often carry a login or key in the path; keep them out of logs.
function redact(url) {
  return String(url).replace(/\/[A-Za-z0-9_\-=%.]{24,}\//g, '/…/');
}

// ------------------------------------------------------------- manifests

// Nuvio's addons table stores only a URL, so manifests are fetched and cached.
// An addon whose manifest won't parse is dropped rather than allowed to break
// the page, and one that still needs configuring is skipped — it would answer
// every request with an error.
// Manifests, kept for as long as the server runs. Shown at once from what's
// kept, refreshed in the background when it's older than CACHE_TTL_MS — so a
// slow or briefly-down addon never holds up a page that already knows it.
const manifests = new Map(); // url -> { manifest, at, pending }

// A first-ever load gets this long before the page goes ahead without that
// addon. The request carries on in the background (up to SLOW_TIMEOUT_MS)
// and the addon appears on the next load once it has answered. Live TV, which
// downloads a whole IPTV playlist before its first answer, is the case this
// is for.
const FIRST_LOAD_BUDGET_MS = Number(process.env.ADDON_FIRST_LOAD_MS || 8000);

function loadManifest(url) {
  const entry = manifests.get(url) || {};
  if (entry.pending) return entry.pending;
  entry.pending = getJson(url, { timeout: SLOW_TIMEOUT_MS })
    .then((raw) => {
      entry.manifest = normalizeManifest(raw);
      entry.at = Date.now();
      entry.error = null;
      return entry.manifest;
    })
    .catch((err) => {
      entry.error = err.message;
      console.error(`addon ${redact(url)}: manifest failed (${err.name === 'TimeoutError' ? 'timed out' : err.message})`);
      if (entry.manifest) return entry.manifest;
      throw err;
    })
    .finally(() => { entry.pending = null; });
  manifests.set(url, entry);
  return entry.pending;
}

async function manifestFor(url) {
  const entry = manifests.get(url);
  if (entry?.manifest) {
    if (Date.now() - entry.at > CACHE_TTL_MS) loadManifest(url).catch(() => {});
    return entry.manifest;
  }
  const pending = loadManifest(url);
  const budget = new Promise((resolve) => { setTimeout(() => resolve(null), FIRST_LOAD_BUDGET_MS); });
  return Promise.race([pending.catch(() => null), budget]);
}

// Nuvio's addons table stores only a URL, so manifests are fetched and cached.
// An addon whose manifest won't parse is dropped rather than allowed to break
// the page, and one that still needs configuring is skipped — it would answer
// every request with an error.
export async function hydrate(rows, { wait = false } = {}) {
  const loaded = await Promise.all(rows.map(async (row) => ({
    transportUrl: row.transportUrl,
    name: row.name,
    // `wait`: a deliberate action (opening a folder, pressing play) waits for
    // every addon however slow, instead of going ahead without it.
    manifest: wait
      ? await (manifests.get(row.transportUrl)?.manifest || loadManifest(row.transportUrl).catch(() => null))
      : await manifestFor(row.transportUrl),
  })));
  return loaded
    .filter((addon) => addon.manifest?.id)
    .filter((addon) => !addon.manifest.behaviorHints?.configurationRequired);
}

// Resources come in two shapes: a bare string ("catalog") or an object with
// its own types and idPrefixes. Flatten both into one form so callers don't
// have to care which an addon used.
function normalizeManifest(raw) {
  const defaultTypes = raw.types || [];
  const defaultPrefixes = raw.idPrefixes || [];

  const resources = (raw.resources || []).map((entry) => {
    if (typeof entry === 'string') {
      return { name: entry, types: defaultTypes, idPrefixes: defaultPrefixes };
    }
    return {
      name: entry.name,
      types: entry.types?.length ? entry.types : defaultTypes,
      idPrefixes: entry.idPrefixes?.length ? entry.idPrefixes : defaultPrefixes,
    };
  }).filter((r) => r.name);

  return {
    id: raw.id,
    name: raw.name || raw.id,
    types: defaultTypes,
    idPrefixes: defaultPrefixes,
    resources,
    catalogs: (raw.catalogs || []).map((c) => ({
      type: c.type,
      id: c.id,
      name: c.name || c.id,
      extra: normalizeExtra(c),
    })).filter((c) => c.type && c.id),
    behaviorHints: raw.behaviorHints || {},
  };
}

// Older addons use extraSupported/extraRequired arrays; newer ones use a
// single extra array of objects. Normalize to the object form.
function normalizeExtra(catalog) {
  if (Array.isArray(catalog.extra) && catalog.extra.length) {
    return catalog.extra
      .filter((e) => e?.name)
      .map((e) => ({
        name: e.name,
        isRequired: Boolean(e.isRequired),
        options: e.options || [],
        optionsLimit: e.optionsLimit,
      }));
  }

  const supported = catalog.extraSupported || [];
  const required = catalog.extraRequired || [];
  return [...new Set([...supported, ...required])].map((name) => ({
    name,
    isRequired: required.includes(name),
    options: name === 'genre' ? (catalog.genres || []) : [],
  }));
}

function supports(addon, resourceName, type, id) {
  return addon.manifest.resources.some((r) =>
    r.name === resourceName
    && (!type || !r.types.length || r.types.includes(type))
    && (!id || !r.idPrefixes.length || r.idPrefixes.some((p) => id.startsWith(p))));
}

// The addon a title belongs to, as the base URL the Nuvio apps record in a
// library entry (addon_base_url). Titles with an IMDb id are found by any
// metadata addon; anything else — an IPTV channel, a Kitsu anime, an addon's
// own ids — can only be opened through the addon that issued the id, and an
// entry without it is one the Android TV and mobile apps can't play.
// Preference: the addon claiming the id's prefix for metadata, then for
// streams, then any metadata addon for that type.
export function ownerOf(addons, type, id) {
  const claims = (addon, resource) => addon.manifest.resources.some((r) => r.name === resource
    && (!r.types.length || r.types.includes(type))
    && r.idPrefixes.length && r.idPrefixes.some((p) => String(id).startsWith(p)));
  const owner = addons.find((a) => claims(a, 'meta'))
    || addons.find((a) => claims(a, 'stream'))
    || addons.find((a) => supports(a, 'meta', type));
  return owner ? baseOf(owner.transportUrl) : null;
}

async function fanOut(addons, predicate, build) {
  const eligible = addons.filter(predicate);
  const settled = await Promise.allSettled(
    eligible.map(async (addon) => ({ addon, data: await getJson(build(addon)) })),
  );
  return settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
}

// --------------------------------------------------------------- catalogs

// A catalog with a required extra other than genre can't be shown on the home
// screen — there's no value to supply. The app applies the same filter
// (HomeCatalogDefinitions.kt), which is why some installed catalogs never
// appear as rows there either.
export function catalogList(addons, { includeRequiredExtras = false, home = false } = {}) {
  const out = [];
  for (const addon of addons) {
    for (const catalog of addon.manifest.catalogs) {
      const blocking = catalog.extra.filter((e) => e.isRequired && e.name !== 'genre');
      if (blocking.length && !includeRequiredExtras) continue;
      // Not a home row either: a catalog that insists on a genre. Live TV
      // uses this on purpose — its channels catalog is only meant to be
      // opened through its collection's category tiles, never as a row.
      if (home && catalog.extra.some((e) => e.name === 'genre' && e.isRequired)) continue;

      const genre = catalog.extra.find((e) => e.name === 'genre');
      out.push({
        addonId: addon.manifest.id,
        addonName: addon.name || addon.manifest.name,
        transportUrl: addon.transportUrl,
        type: catalog.type,
        id: catalog.id,
        name: catalog.name,
        genres: genre?.options || [],
        genreRequired: Boolean(genre?.isRequired),
      });
    }
  }
  return out;
}

// buildCatalogUrl, ported: extras are a path segment in a fixed order.
function catalogUrl(transportUrl, { type, id, genre, search, skip }) {
  const parts = [];
  if (search) parts.push(`search=${encodeURIComponent(search)}`);
  if (genre) parts.push(`genre=${encodeURIComponent(genre)}`);
  if (skip) parts.push(`skip=${skip}`);

  const tail = parts.length ? `/${parts.join('&')}.json` : '.json';
  return `${baseOf(transportUrl)}/catalog/${encodeURIComponent(type)}/${encodeURIComponent(id)}${tail}`;
}

export async function catalog(addons, { transportUrl, type, id, genre, skip = 0, timeout = TIMEOUT_MS }) {
  const addon = addons.find((a) => a.transportUrl === transportUrl);
  if (!addon) throw new Error('That addon is not installed on this account.');

  // A catalog that requires a genre needs one picked before it will answer.
  const definition = addon.manifest.catalogs.find((c) => c.type === type && c.id === id);
  const genreExtra = definition?.extra.find((e) => e.name === 'genre');
  const chosenGenre = genre || (genreExtra?.isRequired ? genreExtra.options[0] : null);

  const data = await getJson(catalogUrl(transportUrl, { type, id, genre: chosenGenre, skip }), { timeout });
  return (data.metas || []).map(normalizeMeta).filter((m) => m.id && m.name);
}

// ---------------------------------------------------------------- search

export async function search(addons, query, { type } = {}) {
  const targets = [];
  for (const addon of addons) {
    if (!supports(addon, 'catalog')) continue;
    for (const definition of addon.manifest.catalogs) {
      if (type && definition.type !== type) continue;
      if (!definition.extra.some((e) => e.name === 'search')) continue;
      // Anything else it insists on, we can't supply from a search box.
      if (definition.extra.some((e) => e.isRequired && e.name !== 'search')) continue;
      targets.push({ addon, definition });
    }
  }

  const settled = await Promise.allSettled(targets.map(async ({ addon, definition }) => ({
    addon,
    data: await getJson(catalogUrl(addon.transportUrl, {
      type: definition.type, id: definition.id, search: query,
    })),
  })));

  const seen = new Set();
  const merged = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const meta of result.value.data.metas || []) {
      const key = `${meta.type}:${meta.id}`;
      if (!meta.id || !meta.name || seen.has(key)) continue;
      seen.add(key);
      merged.push(normalizeMeta(meta));
    }
  }
  return merged;
}

// ------------------------------------------------------------------ meta

// Meta lookups are best-effort. Two passes: first only addons that claim this
// type and id prefix, then — if nobody claimed it — every addon offering meta
// for the type at all.
//
// The second pass matters because plenty of addons declare a narrow
// idPrefixes list and still answer for ids outside it, and because a catalog
// can hand back an id whose prefix no installed addon advertises. Refusing to
// ask was turning "no synopsis" into a hard error.
//
// Returns null rather than throwing: callers have a poster and a title
// already, and a missing description shouldn't take the page down with it.
export async function meta(addons, type, id) {
  const strict = await fanOut(
    addons,
    (addon) => supports(addon, 'meta', type, id),
    (addon) => metaUrl(addon, type, id),
  );

  let found = strict.find((r) => r.data?.meta);

  if (!found) {
    const claimed = new Set(addons.filter((a) => supports(a, 'meta', type, id)));
    const relaxed = await fanOut(
      addons,
      (addon) => !claimed.has(addon) && supports(addon, 'meta', type),
      (addon) => metaUrl(addon, type, id),
    );
    found = relaxed.find((r) => r.data?.meta);
  }

  if (!found) return null;

  const m = found.data.meta;
  const videos = (m.videos || []).map(normalizeVideo).sort(byEpisodeOrder);
  if (type === 'series' && /^tt\d+$/.test(String(m.imdb_id || m.id || id).split(':')[0])) {
    await fillEpisodeRatings(String(m.imdb_id || m.id || id).split(':')[0], videos);
  }
  return {
    ...normalizeMeta(m),
    description: m.description,
    background: m.background,
    logo: m.logo,
    genres: m.genres || [],
    // Series-level facts the details page can show without a second lookup.
    runtime: m.runtime || null,
    status: m.status || null,
    cast: (m.cast || []).slice(0, 6),
    director: (m.director || []).slice(0, 3),
    videos,
  };
}

// Episode ratings. Cinemeta has them for older shows but sends "0" for every
// episode of most recent ones (Andor, Severance, The Bear…), which showed as
// "★ 0". Missing ones are filled from TVmaze — free, no key, looked up by
// IMDb id — and cached for a day. If TVmaze doesn't know the show either,
// the episodes simply show no rating.
const episodeRatings = new Map();
const RATINGS_TTL_MS = 24 * 60 * 60_000;

async function tvmazeRatings(imdbId) {
  const hit = episodeRatings.get(imdbId);
  if (hit && Date.now() - hit.at < RATINGS_TTL_MS) return hit.ratings;
  const ratings = new Map();
  try {
    const signal = AbortSignal.timeout(5000);
    const show = await fetch(`https://api.tvmaze.com/lookup/shows?imdb=${imdbId}`, { redirect: 'follow', signal });
    if (show.ok) {
      const { id } = await show.json();
      const res = await fetch(`https://api.tvmaze.com/shows/${id}/episodes?specials=1`, { signal });
      if (res.ok) {
        for (const e of await res.json()) {
          const value = Number(e.rating?.average);
          if (value > 0) ratings.set(`${e.season}:${e.number}`, value);
        }
      }
    }
  } catch { /* no ratings is fine */ }
  if (episodeRatings.size > 500) episodeRatings.clear();
  episodeRatings.set(imdbId, { at: Date.now(), ratings });
  return ratings;
}

async function fillEpisodeRatings(imdbId, videos) {
  if (!videos.some((v) => v.rating == null && v.season != null)) return;
  const ratings = await tvmazeRatings(imdbId);
  for (const v of videos) {
    if (v.rating == null) v.rating = ratings.get(`${v.season}:${v.episode}`)?.toFixed(1) ?? null;
  }
}

// A rating as shown: one decimal, or null when there isn't a real one.
// Addons use 0 (or "0") to mean "not rated".
function ratingOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n.toFixed(1) : null;
}

// Addons disagree about what an episode's fields are called — Cinemeta says
// `released`, some say `firstAired`, others put the date in `releaseInfo`;
// the synopsis is `overview` or `description`; the still is `thumbnail` or
// `poster`. Normalising here means the client asks for one name.
function normalizeVideo(v) {
  return {
    id: v.id,
    title: v.title || v.name || null,
    season: v.season ?? v.seasonNumber ?? null,
    episode: v.episode ?? v.number ?? v.episodeNumber ?? null,
    released: v.released || v.firstAired || v.releaseInfo || null,
    thumbnail: v.thumbnail || v.poster || v.still || null,
    overview: v.overview || v.description || null,
    runtime: v.runtime || null,
    rating: ratingOf(v.rating) ?? ratingOf(v.imdbRating),
  };
}

// Addons return videos in whatever order their source happened to use, and a
// season list out of order is worse than no season list. Unnumbered episodes
// keep their relative position at the end rather than being dropped.
function byEpisodeOrder(a, b) {
  if (a.season !== b.season) return (a.season ?? 9999) - (b.season ?? 9999);
  return (a.episode ?? 9999) - (b.episode ?? 9999);
}

function metaUrl(addon, type, id) {
  return `${baseOf(addon.transportUrl)}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
}

// --------------------------------------------------------------- streams

export async function streams(addons, type, id) {
  const results = await fanOut(
    addons,
    (addon) => supports(addon, 'stream', type, id),
    (addon) => `${baseOf(addon.transportUrl)}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`,
  );

  const out = [];
  for (const { addon, data } of results) {
    for (const s of data.streams || []) {
      out.push(normalizeStream(s, addon.name || addon.manifest.name));
    }
  }
  // Live TV is exempt: a channel called "Sports 4K" is still the channel
  // you asked for, and there's no other copy of it to fall back to.
  return out.filter((s) => type === 'tv' || withinResolution(s)).sort((a, b) => b.score - a.score);
}

// Streams above MAX_STREAM_RESOLUTION (1080 by default) are left out
// everywhere: the stream list, the player's Source menu, auto-play and binge
// playlists. 4K costs far more to fetch and convert and looks no better at
// 1080p output. A release that names no resolution is kept. 0 shows all.
const MAX_RESOLUTION = Number(process.env.MAX_STREAM_RESOLUTION ?? 1080);

function resolutionOf(stream) {
  const text = `${stream.headline || ''} ${stream.label || ''} ${stream.detail || ''} ${(stream.badges || []).join(' ')}`;
  if (/\b(2160p|4k|uhd)\b/i.test(text)) return 2160;
  if (/\b1440p\b/i.test(text)) return 1440;
  const match = text.match(/\b(1080|720|576|480|360)p\b/i);
  return match ? Number(match[1]) : null;
}

function withinResolution(stream) {
  if (!MAX_RESOLUTION) return true;
  const height = resolutionOf(stream);
  return height === null || height <= MAX_RESOLUTION;
}

// -------------------------------------------------------------- subtitles

// Subtitle addons expose <base>/subtitles/<type>/<id>.json, returning entries
// with a `lang` code and a URL to a subtitle file. Handing VLC one of these
// is the only way to get subtitles onto a stream that has none embedded.
export async function subtitles(addons, type, id) {
  const results = await fanOut(
    addons,
    (addon) => supports(addon, 'subtitles', type, id),
    (addon) => `${baseOf(addon.transportUrl)}/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`,
  );

  const out = [];
  for (const { addon, data } of results) {
    for (const sub of data.subtitles || []) {
      if (!sub.url) continue;
      out.push({
        id: sub.id || sub.url,
        url: sub.url,
        lang: String(sub.lang || '').toLowerCase(),
        addon: addon.name || addon.manifest.name,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------- normalisation

function normalizeMeta(m) {
  return {
    id: m.id,
    type: m.type,
    name: m.name,
    poster: m.poster || null,
    // HomeCatalogParser treats banner and background as the same slot.
    background: m.banner || m.background || null,
    logo: m.logo || null,
    posterShape: m.posterShape || 'poster',
    year: m.year || m.releaseInfo || null,
    imdbRating: m.imdbRating || null,
    description: m.description || null,
  };
}

export function normalizeStream(s, addonName) {
  const headline = (s.name || '').replace(/\s+/g, ' ').trim();
  const detail = [s.title, s.description].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const label = [headline, detail].filter(Boolean).join(' • ');

  // Addons express playable media three ways: a direct url, an externalUrl to
  // open elsewhere, or a torrent infoHash. Only the first is something VLC
  // can be handed.
  const url = s.url || null;
  const playable = Boolean(url) && /^https?:/i.test(url);

  const filename = s.behaviorHints?.filename || null;

  return {
    addon: addonName,
    headline: headline || detail.slice(0, 60) || 'Stream',
    detail,
    badges: badgesFor(label),
    label: label || 'Untitled stream',
    url,
    externalUrl: s.externalUrl || null,
    infoHash: s.infoHash || null,
    playable,
    filename,
    // Whether a browser could play this one as it stands, guessed from the
    // release name. See browserVerdict for what that guess is worth.
    browser: playable ? browserVerdict(`${label} ${filename || ''}`, url) : 'no',
    // A file the browser can play as it stands needs no work at all.
    score: scoreStream(label, playable, filename)
      + (playable && browserVerdict(`${label} ${filename || ''}`, url) === 'yes' ? 6 : 0),
  };
}

// Would a browser play this file without help?
//
// This is a guess from a release name, not a fact — nothing here has opened
// the file. Release names are, however, unusually informative: they nearly
// always carry the container and the video codec, and the ones that don't are
// the ones worth being cautious about. So the answer has three values rather
// than two, and "maybe" is a real answer.
//
//   yes    an MP4 or WebM with a codec browsers decode
//   no     a container or codec no browser will touch — MKV, HEVC, AC3, DTS
//   maybe  nothing in the name says either way
//
// The bar for `yes` is deliberately high: telling someone a file will play
// and having it fail is worse than making them press "show everything".
export function browserVerdict(text, url) {
  const haystack = `${text} ${String(url || '').split('?')[0]}`.toLowerCase();

  // Audio is what usually spoils an otherwise fine file, so it is checked
  // first — an MP4 carrying AC3 plays with no sound at all.
  if (/\b(ac-?3|eac-?3|e-ac3|dts(-?hd)?|truehd|atmos|dd\+?5\.?1|ddp)\b/.test(haystack)) return 'no';
  if (/\b(x265|h\.?265|hevc|av1|vp9|xvid|divx|mpeg-?2)\b/.test(haystack)) return 'no';
  if (/\.(mkv|avi|ts|m2ts|wmv|flv|mov|iso)\b/.test(haystack)) return 'no';
  if (/\b(mkv|matroska)\b/.test(haystack)) return 'no';

  const goodContainer = /\.(mp4|m4v|webm)\b/.test(haystack) || /\b(mp4|webm)\b/.test(haystack);
  const goodVideo = /\b(x264|h\.?264|avc)\b/.test(haystack);

  // An MP4 almost always carries AAC, so the container alone is enough when
  // nothing contradicts it.
  if (goodContainer) return 'yes';
  if (goodVideo) return 'maybe';
  return 'maybe';
}

function badgesFor(text) {
  const out = [];
  const push = (v) => { if (v && !out.includes(v)) out.push(v); };

  const res = text.match(/\b(2160p|4k|1080p|720p|480p)\b/i);
  push(res && (res[1].toLowerCase() === '4k' ? '2160p' : res[1].toLowerCase()));

  if (/dolby.?vision|\bDV\b/i.test(text)) push('DV');
  if (/\bHDR(?:10)?\+?\b/i.test(text)) push('HDR');
  if (/remux/i.test(text)) push('REMUX');
  else if (/blu-?ray/i.test(text)) push('BluRay');
  else if (/web-?dl|webrip/i.test(text)) push('WEB-DL');

  if (/atmos/i.test(text)) push('Atmos');
  else if (/truehd/i.test(text)) push('TrueHD');
  else if (/dts-?hd/i.test(text)) push('DTS-HD');

  const size = text.match(/(\d+(?:\.\d+)?)\s?(GB|MB)\b/i);
  push(size && `${size[1]} ${size[2].toUpperCase()}`);

  return out.slice(0, 6);
}

// How good a stream is to *play*, not to collect. The old score rewarded
// what looks best on paper — REMUX, HDR, Dolby Vision — which are exactly the
// files that play worst here: REMUXes run 25–40 Mbps and choke a phone
// connection, HDR needs tone mapping on the way through, and Dolby Vision
// without an HDR10 base comes out purple and green on anything but a DV
// screen. This ranks for what plays smoothly everywhere, as Plex would pick:
//
//   1. it will actually start: a cached debrid link, not one that triggers a
//      download (Torrentio, Comet, MediaFusion and friends mark them)
//   2. 1080p, then 720p; 4K only if allowed and nothing better
//   3. cheap to deliver: H.264 (remuxed for almost nothing) over HEVC/AV1
//      (a full conversion), SDR over HDR, MP4 the browser plays as it is
//   4. a sensible size for its resolution — WEB-DLs and good encodes over
//      40 GB discs and 300 MB squashes
//   5. never CAMs, telesyncs, samples or hard-coded subtitles
function scoreStream(label, playable, filename = '') {
  if (!playable) return -1000;
  const text = `${label} ${filename || ''}`.toLowerCase();
  let score = 0;

  // 1. Will it start?
  if (/\[(rd|ad|pm|dl|tb|ed|oc|pkp|en)\+\]|⚡|\bcached\b|\binstant\b/.test(text)) score += 40;
  if (/\[(rd|ad|pm|dl|tb|ed|oc|pkp|en) ?download\]|⏳|\buncached\b|\bnot cached\b/.test(text)) score -= 90;

  // 2. Resolution.
  const height = /2160|\b4k\b|uhd/.test(text) ? 2160
    : /1080/.test(text) ? 1080 : /720/.test(text) ? 720 : /\b(576|480)p?\b/.test(text) ? 480 : null;
  score += { 2160: 22, 1080: 30, 720: 18, 480: 6 }[height] ?? 12;

  // 3. Cost to deliver.
  if (/\b(x264|h\.?264|avc)\b/.test(text)) score += 12;
  else if (/\b(x265|h\.?265|hevc)\b/.test(text)) score += 0;
  else if (/\bav1\b/.test(text)) score -= 8;
  if (/\b10.?bit\b|\bhi10p?\b/.test(text)) score -= 6;
  const dv = /dolby.?vision|\bdovi\b|\bdv\b/.test(text);
  const hdr = /\bhdr(10)?\+?\b/.test(text);
  if (dv && !hdr) score -= 25;
  else if (dv || hdr) score -= 6;
  if (/\.(mp4|m4v)\b|\bmp4\b/.test(text)) score += 4;
  if (/\baac\b/.test(text)) score += 4;
  if (/truehd|atmos|dts-?hd|dts-?x/.test(text)) score -= 4;

  // 4. Source and size.
  if (/remux/.test(text)) score -= 10;
  else if (/web-?dl|webrip|\bweb\b/.test(text)) score += 8;
  else if (/blu-?ray|bdrip|brrip/.test(text)) score += 5;
  const size = text.match(/(\d+(?:\.\d+)?)\s?(gb|mb)\b/);
  if (size) {
    const gb = Number(size[1]) / (size[2] === 'mb' ? 1024 : 1);
    const big = height === 2160 ? 40 : height === 720 ? 6 : 15;
    if (gb > big * 1.6) score -= 15;
    else if (gb > big) score -= 6;
    if (height >= 1080 && gb < 0.5) score -= 6;
  }

  // 5. Never these.
  if (/\bcam(rip)?\b|telesync|\bhdts\b|\bts(rip)?\b|\bhdcam\b|\btc\b|telecine/.test(text)) score -= 80;
  if (/\bsample\b|\btrailer\b/.test(text)) score -= 100;
  if (/\bhc\b|hard.?coded|hardsub/.test(text)) score -= 10;
  return score;
}

export function clearCache() {
  cache.clear();
}
