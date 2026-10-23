// Nuvio's backend is Supabase, not a Stremio-style JSON-RPC API.
//
// Read from composeApp/.../core/network/SupabaseProvider.kt in the app source:
// the client is built with createSupabaseClient(backendUrl, publishableKey) and
// installs Auth, Postgrest, Functions and Storage. So:
//
//   auth      POST <backend>/auth/v1/token?grant_type=password
//   tables    GET  <backend>/rest/v1/addons?profile_id=eq.N
//   rpc       POST <backend>/rest/v1/rpc/<name>
//
// Every request carries an `apikey` header holding the publishable (anon) key,
// and authenticated ones also carry `Authorization: Bearer <access_token>`.
// Without the apikey Supabase rejects the call before it ever looks at your
// credentials — which is exactly why signing in didn't work before.

const TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 15000);

// Nuvio's publishable (anon) key. This is not a secret — Supabase anon keys
// are designed to ship inside every client, they carry the `anon` role and
// nothing else, and all real authorisation happens through row-level security
// against the signed-in user's token. Having it here is what makes sign-in
// "just work" instead of asking each person to go extract it from an APK.
// Override it if you point this at a different backend.
const PUBLISHABLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI';

export const config = {
  backendUrl: (process.env.NUVIO_BACKEND_URL || 'https://api.nuvio.tv').replace(/\/+$/, ''),
  anonKey: process.env.NUVIO_ANON_KEY || PUBLISHABLE_KEY,
};

// Self-hosted Nuvio servers publish their own backend and key at a well-known
// path (ServerDiscovery.kt). If NUVIO_SERVER is set we read it at boot, which
// saves you copying the key by hand. The official server does not serve this.
export async function discover(serverUrl) {
  const origin = serverUrl.includes('://') ? serverUrl : `https://${serverUrl}`;
  const url = `${origin.replace(/\/+$/, '')}/.well-known/nuvio`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Discovery failed: ${res.status} from ${url}`);

  const doc = await res.json();
  if (doc.version !== 1) throw new Error(`Unsupported discovery version ${doc.version}.`);
  if (String(doc.service).toLowerCase() !== 'nuvio') throw new Error('That server is not a Nuvio server.');
  if (!doc.capabilities?.email_password_auth) throw new Error('That server does not accept email and password sign-in.');

  config.backendUrl = String(doc.backend_url).replace(/\/+$/, '');
  config.anonKey = String(doc.publishable_key).trim();
  return { backendUrl: config.backendUrl };
}

async function request(path, { method = 'GET', body, accessToken, headers = {} } = {}) {
  const res = await fetch(`${config.backendUrl}${path}`, {
    method,
    headers: {
      apikey: config.anonKey,
      'content-type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // A proxy, captive portal or blocked egress returns HTML or plain text.
      // Surface that as what it is instead of a JSON parse error.
      payload = { message: text.slice(0, 200).trim() };
    }
  }

  if (!res.ok) {
    const message =
      payload?.error_description || payload?.msg || payload?.message || payload?.error || res.statusText;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  if (text && payload?.message !== undefined && Object.keys(payload).length === 1 && !res.headers.get('content-type')?.includes('json')) {
    throw new Error(`Backend returned a non-JSON response: ${payload.message}`);
  }
  return payload;
}

// ------------------------------------------------------------------- auth

export async function signIn(email, password) {
  const session = await request('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password },
  });
  return shapeSession(session);
}

/** The account an access token belongs to (checks the token with the backend). */
export async function getUser(accessToken) {
  return request('/auth/v1/user', { accessToken });
}

export async function signUp(email, password) {
  const result = await request('/auth/v1/signup', {
    method: 'POST',
    body: { email, password },
  });
  // When email confirmation is on, Supabase returns the user with no session.
  return {
    session: result.access_token ? shapeSession(result) : null,
    user: { id: result.id || result.user?.id, email: result.email || result.user?.email },
  };
}

export async function refresh(refreshToken) {
  const session = await request('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    body: { refresh_token: refreshToken },
  });
  return shapeSession(session);
}

export async function signOut(accessToken) {
  try {
    // scope=local revokes only this device's refresh token. GoTrue's default
    // is global, which would sign the account out everywhere — so signing out
    // on a phone would silently kick the same person off their laptop.
    await request('/auth/v1/logout?scope=local', { method: 'POST', accessToken, body: {} });
  } catch {
    // An expired token is already signed out as far as we care.
  }
}

function shapeSession(s) {
  return {
    accessToken: s.access_token,
    refreshToken: s.refresh_token,
    // expires_at is seconds since epoch; keep milliseconds internally.
    expiresAt: (s.expires_at ? s.expires_at * 1000 : Date.now() + (s.expires_in || 3600) * 1000),
    user: { id: s.user?.id, email: s.user?.email },
  };
}

// ----------------------------------------------------------------- tables

// Profiles are the Netflix-style sub-accounts. Everything else is scoped by
// profile_index, so this has to load before anything can be fetched.
export async function profiles(accessToken) {
  const rows = await request('/rest/v1/rpc/sync_pull_profiles', {
    method: 'POST',
    accessToken,
    body: {},
  });
  return (rows || [])
    .map((p) => ({
      id: p.id,
      index: p.profile_index ?? 1,
      name: p.name || 'Profile',
      avatarUrl: p.avatar_url || null,
      avatarColor: p.avatar_color_hex || '#1E88E5',
      pinEnabled: Boolean(p.pin_enabled),
    }))
    .sort((a, b) => a.index - b.index);
}

export async function addons(accessToken, profileIndex) {
  const query = new URLSearchParams({
    select: '*',
    profile_id: `eq.${profileIndex}`,
    order: 'sort_order.asc',
  });
  const rows = await request(`/rest/v1/addons?${query}`, { accessToken });

  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (row.enabled === false) continue;
    const transportUrl = ensureManifest(row.url);
    if (seen.has(transportUrl)) continue;
    seen.add(transportUrl);
    out.push({ transportUrl, name: row.name || null, sortOrder: row.sort_order ?? 0 });
  }
  return out;
}

function ensureManifest(url) {
  const trimmed = String(url).trim().replace(/\/+$/, '');
  return trimmed.endsWith('/manifest.json') ? trimmed : `${trimmed}/manifest.json`;
}

export async function library(accessToken, profileIndex, { limit = 200, offset = 0 } = {}) {
  const rows = await request('/rest/v1/rpc/sync_pull_library', {
    method: 'POST',
    accessToken,
    body: { p_profile_id: profileIndex, p_limit: limit, p_offset: offset },
  });
  return (rows || []).map((r) => ({
    id: r.content_id,
    type: r.content_type,
    name: r.name || r.content_id,
    poster: r.poster,
    background: r.background,
    description: r.description,
    year: r.release_info,
    imdbRating: r.imdb_rating,
    addedAt: r.added_at || 0,
  }));
}

// sync_push_library_items / sync_delete_library_items, matching
// SupabaseLibrarySyncAdapter.kt. This is the only thing the app writes to your
// account, and only when you tap the button — nothing here happens as a side
// effect of playing something.
export async function addToLibrary(accessToken, profileIndex, item) {
  await request('/rest/v1/rpc/sync_push_library_items', {
    method: 'POST',
    accessToken,
    body: {
      p_profile_id: profileIndex,
      p_items: [{
        content_id: item.id,
        content_type: item.type,
        name: item.name || '',
        poster: item.poster || null,
        poster_shape: (item.posterShape || 'poster').toUpperCase(),
        background: item.background || null,
        description: item.description || null,
        release_info: item.year ? String(item.year) : null,
        // imdb_rating is a float server-side; addons hand it over as text.
        imdb_rating: item.imdbRating != null ? (Number(item.imdbRating) || null) : null,
        genres: item.genres || [],
        addon_base_url: item.addonBaseUrl || null,
        added_at: Date.now(),
      }],
    },
  });
}

export async function removeFromLibrary(accessToken, profileIndex, { id, type }) {
  await request('/rest/v1/rpc/sync_delete_library_items', {
    method: 'POST',
    accessToken,
    body: {
      p_profile_id: profileIndex,
      p_keys: [{ content_id: id, content_type: type }],
    },
  });
}

// Collections are user-built rows of catalog sources, stored as one JSON blob
// per profile (CollectionModels.kt). A collection holds folders; a folder
// holds catalogSources, each naming an addon id, type, catalog id and
// optional genre.
// CollectionFolder.posterShape: "landscape" and "wide" both mean landscape,
// "square" means square, and anything else falls back to poster. Normalising
// here means the UI only ever sees three values — miss the "wide" alias and a
// row of wide logos gets cropped into portrait tiles.
function tileShapeOf(raw) {
  switch (String(raw || '').toLowerCase()) {
    case 'landscape':
    case 'wide':
      return 'landscape';
    case 'square':
      return 'square';
    default:
      return 'poster';
  }
}

export async function collections(accessToken, profileIndex) {
  const rows = await request('/rest/v1/rpc/sync_pull_collections', {
    method: 'POST',
    accessToken,
    body: { p_profile_id: profileIndex },
  });

  const blob = (rows || [])[0]?.collections_json;
  const parsed = typeof blob === 'string' ? JSON.parse(blob) : blob;
  if (!Array.isArray(parsed)) return [];

  return parsed.map((c) => ({
    id: c.id,
    title: c.title,
    pinToTop: Boolean(c.pinToTop),
    backdrop: c.backdropImageUrl || null,
    folders: (c.folders || []).map((f) => ({
      id: f.id,
      title: f.title,
      cover: f.coverImageUrl || null,
      coverEmoji: f.coverEmoji || null,
      hideTitle: Boolean(f.hideTitle),
      tileShape: tileShapeOf(f.tileShape),
      // resolvedSources: `sources` wins outright when present, with
      // `catalogSources` as the fallback — not a merge of the two, which
      // would double up every folder that has both.
      sources: resolveSources(f),
    })),
  })).filter((c) => c.title);
}

function resolveSources(folder) {
  const primary = (folder.sources || [])
    .filter((s) => (s.provider || 'addon') === 'addon' && s.catalogId);
  const chosen = primary.length ? primary : (folder.catalogSources || []);

  return chosen.map((s) => ({
    addonId: s.addonId,
    type: s.type,
    catalogId: s.catalogId,
    genre: s.genre || null,
  })).filter((s) => s.addonId && s.type && s.catalogId);
}

// Which catalogs the person has enabled on home and in what order. Absent or
// empty means "show everything", which is what the app falls back to.
export async function homeCatalogSettings(accessToken, profileIndex) {
  const rows = await request('/rest/v1/rpc/sync_pull_home_catalog_settings', {
    method: 'POST',
    accessToken,
    body: { p_profile_id: profileIndex },
  });

  const blob = (rows || [])[0]?.settings_json ?? (rows || [])[0]?.catalogs_json;
  const parsed = typeof blob === 'string' ? JSON.parse(blob) : blob;
  if (!parsed) return null;

  const entries = Array.isArray(parsed) ? parsed : parsed.catalogs;
  if (!Array.isArray(entries)) return null;

  return entries.map((e, i) => ({
    addonId: e.addonId ?? e.addon_id,
    type: e.type,
    catalogId: e.catalogId ?? e.catalog_id ?? e.id,
    enabled: e.enabled !== false,
    order: e.order ?? e.sortOrder ?? i,
  })).filter((e) => e.type && e.catalogId);
}


// ------------------------------------------------------- watch progress
//
// Continue Watching, shared with the Nuvio apps. Same RPCs and shapes as
// NuvioTV's WatchProgressSyncService.kt:
//   sync_pull_watch_progress   { p_profile_id, p_limit? }
//   sync_push_watch_progress   { p_profile_id, p_entries: [...] }   (merge)
//   sync_delete_watch_progress { p_profile_id, p_keys: [...] }
// Positions and durations are milliseconds; last_watched is epoch ms. The
// key is the content id for a film and "<id>_s<S>e<E>" for an episode.

export function progressKey({ contentId, season, episode }) {
  return season != null && episode != null ? `${contentId}_s${season}e${episode}` : contentId;
}

export async function pullProgress(accessToken, profileIndex, { limit = 100 } = {}) {
  const rows = await request('/rest/v1/rpc/sync_pull_watch_progress', {
    method: 'POST',
    accessToken,
    body: { p_profile_id: profileIndex, p_limit: limit },
  });
  return (rows || []).map((r) => ({
    key: r.progress_key,
    contentId: r.content_id,
    // 'tv' is a live channel (the IPTV addon's iptv:… ids) and stays one —
    // it was folded into 'series', which lost every channel.
    type: r.content_type === 'tv' ? 'tv' : r.content_type === 'series' ? 'series' : 'movie',
    // The id the player and the addons use: the episode's id for a show.
    id: r.video_id || r.content_id,
    season: r.season ?? null,
    episode: r.episode ?? null,
    position: (Number(r.position) || 0) / 1000,
    duration: (Number(r.duration) || 0) / 1000,
    updatedAt: Number(r.last_watched) || 0,
  }));
}

export async function pushProgress(accessToken, profileIndex, entry) {
  await request('/rest/v1/rpc/sync_push_watch_progress', {
    method: 'POST',
    accessToken,
    body: {
      p_profile_id: profileIndex,
      p_entries: [{
        content_id: entry.contentId,
        content_type: entry.type,
        video_id: entry.id,
        ...(entry.season != null ? { season: entry.season } : {}),
        ...(entry.episode != null ? { episode: entry.episode } : {}),
        position: Math.round(entry.position * 1000),
        duration: Math.round(entry.duration * 1000),
        last_watched: Date.now(),
        progress_key: progressKey(entry),
      }],
    },
  });
}

export async function deleteProgress(accessToken, profileIndex, keys) {
  if (!keys.length) return;
  await request('/rest/v1/rpc/sync_delete_watch_progress', {
    method: 'POST',
    accessToken,
    body: { p_profile_id: profileIndex, p_keys: keys },
  });
}
