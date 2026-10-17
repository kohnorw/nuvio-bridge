// The player that runs in the page: a plain <video> with the browser's own
// controls.
//
// The server decides how a file arrives and answers with a mode:
//
//   direct   an MP4 of H.264 and AAC, restreamed whole. Native seeking.
//   hls      everything else, through Lumen (src/transcode.js): remuxed or
//            re-encoded on the server into a full-length VOD playlist, so
//            the whole film is seekable from the start. Safari plays it
//            natively; elsewhere hls.js feeds the <video>.
//
// VLC is the fallback. When Lumen can't take a file — no ffmpeg, the server
// busy, a source it can't open — desktops hand the stream to VLC through the
// launcher, and phones offer VLC on the fallback screen.
//
// Every load is tagged with a generation number. Anything asynchronous — a
// start request, a metadata event, a stall timer — checks it before acting,
// so a reply that arrives after the person has moved on is thrown away (and
// its ffmpeg stopped) instead of taking over the screen.

import { device, playLink, hasLauncher, launcherInstalled, openInVlc, vlcLink } from './platform.js?v=90';
import * as controls from './controls.js?v=90';

const $ = (s, root = document) => root.querySelector(s);

const HEARTBEAT_MS = 10000;
const SILENCE_MS = 25000;
const SAVE_EVERY_MS = 5000;
const MIN_RESUME_S = 30;
const END_MARGIN_S = 60;
const EXTERNAL_PLAYER = 'https://onlineplayer.app/en/player';

// ------------------------------------------------------------------ state

const state = {
  token: null,
  ticket: null,
  index: 0,
  gen: 0,             // bumped on every load; stale work checks it
  video: null,       // the <video> element
  hls: null,         // hls.js instance, when one is in use
  session: null,      // { mode, sid?, tracks, audio }
  heartbeat: null,
  silence: null,
  lastSave: 0,
  subtitle: null,     // { url, label } chosen from the menu, or null for the item's own
  subtitlesOff: false,
  subtitleTouched: false, // the person picked from the subtitle menu this session
  addonSubs: [],      // subtitles from addons, for this title
  embeddedSubs: [],   // subtitles inside the file, from the last start reply
  initialised: false,
  onExit: () => { location.replace('/'); },
};

const trace = [];
function note(what) {
  trace.push(`${(performance.now() / 1000).toFixed(1).padStart(6)}s  ${what}`);
  if (trace.length > 40) trace.shift();
}

// ---------------------------------------------------------------- helpers

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const post = (path, body = {}) => request(path, { method: 'POST', body });

const storage = {
  key: (i) => `nuvio.pos.${state.token}.${i}`,
  get(i) {
    try {
      const n = Number(localStorage.getItem(this.key(i)));
      return Number.isFinite(n) && n > MIN_RESUME_S ? n : 0;
    } catch { return 0; }
  },
  set(i, seconds) {
    try { localStorage.setItem(this.key(i), String(Math.floor(seconds))); } catch { /* private mode */ }
  },
  clear(i) {
    try { localStorage.removeItem(this.key(i)); } catch { /* private mode */ }
  },
};

const current = () => state.ticket?.items[state.index];
const isStale = (gen) => gen !== state.gen;

function setStatus(text) {
  const el = $('#watch-status');
  el.textContent = text || '';
  el.hidden = !text;
}

// ------------------------------------------------------------ public API

export function isWatchRoute() {
  return location.pathname === '/watch';
}

// Sound needs a tap. Browsers only let a video play with sound if it was
// started from a real tap or click — a simulated one doesn't count, they are
// marked as untrusted and ignored for exactly this purpose. So the tap on
// Play is used: this runs inside it, and plays a fraction of a second of
// silence on the player's own <video>. That marks the element (iOS) and the
// page (Chrome, Firefox) as started by the person, and the film that loads
// into the same element a moment later is allowed to play with sound.
const SILENCE = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

export function unlock() {
  const video = $('#watch-video');
  if (!video || video.dataset.unlocked === '1') return;
  try {
    video.muted = false;
    video.src = SILENCE;
    const attempt = video.play();
    // Only tidy up if the silence is still what's loaded; by the time this
    // runs the film may already be going into the same element.
    const done = () => {
      if (!String(video.getAttribute('src') || '').startsWith('data:audio')) return;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
    if (attempt?.then) attempt.then(() => { video.dataset.unlocked = '1'; done(); }).catch(done);
    else done();
  } catch { /* nothing to unlock */ }
}

// The player screen, up straight away with a spinner, while the server finds
// a stream — so a tap on Play gets an instant response.
export function opening(message = 'Finding the best stream…') {
  show();
  controls.enterFullscreenForPlayback(); // inside the tap: allows the portrait hold
  controls.holdPortrait(true);
  $('#watch-spinner').hidden = false;
  setStatus(message);
}

export async function mount(options = {}) {
  if (options.onExit) state.onExit = options.onExit;
  state.inPage = Boolean(options.inPage);
  // A fresh film: forget the last one's subtitle choices.
  state.subtitle = null;
  state.subtitleTouched = false;
  state.subDelay = 0;
  state.index = 0;
  state.loadedIndex = null;
  if (!options.keepChoices) {
    state.subLangChoice = null;
    state.subtitlesOff = false;
  }
  const params = new URLSearchParams(location.search);
  state.token = params.get('t');

  show();
  if (!state.token) return fail('No playlist token in that link.');
  setStatus('Resolving streams…');

  try {
    state.ticket = await request(`/api/ticket/${encodeURIComponent(state.token)}`);
  } catch (err) {
    return fail(err.message);
  }
  if (!state.ticket.items?.length) return fail('That playlist came back empty.');


  await createPlayer();

  renderQueue();
  if (params.get('copy') === '1') copyLink();
  await play(0);
  return undefined;
}

export function unmount() {
  state.gen += 1;
  // Back to the app: portrait again (installed app), and out of fullscreen.
  controls.holdPortrait(true);
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  rememberPosition();
  stopSession();
  closeExternalPlayer();
  resetVideo();
  document.body.classList.remove('watching');
  $('#screen-watch').hidden = true;
  document.title = 'Nuvio';
}

// Back to wherever the player was opened from. Cleaning up must never stop
// the exit, so it is guarded: before, anything that threw in unmount() left
// the button doing nothing. When the player was opened from this app, going
// back in history returns to that page as it was (the details page, not a
// fresh home screen); opened any other way, it goes home.
function leave() {
  try { unmount(); } catch (err) { console.error(err); }
  // Opened inside the app (see openInPage): the app knows how to go back.
  if (state.inPage) { state.inPage = false; state.onExit(); return; }
  let fromHere = false;
  try { fromHere = Boolean(document.referrer) && new URL(document.referrer).origin === location.origin; } catch { /* no referrer */ }
  if (fromHere && history.length > 1) {
    history.back();
    // If nothing happened (history empty in a new window or PWA), go home.
    setTimeout(() => { if (isWatchRoute()) state.onExit(); }, 600);
    return;
  }
  state.onExit();
}

export function init() {
  if (state.initialised) return;
  state.initialised = true;

  $('#watch-back').addEventListener('click', (event) => { event.preventDefault(); leave(); });

  if (location.protocol === 'https:') {
    const toggle = $('#watch-external-toggle');
    toggle.hidden = false;
    toggle.addEventListener('click', () => {
      if ($('#watch-external').hidden) useExternalPlayer();
      else play(state.index);
    });
  }

  // A closed tab takes its ffmpeg with it rather than waiting for a timeout.
  window.addEventListener('pagehide', () => {
    rememberPosition();
    const sid = state.session?.sid;
    if (sid) navigator.sendBeacon?.(`/api/transcode/stop/${sid}`);
  });

  document.addEventListener('keydown', onKey);
}

// ---------------------------------------------------------------- the video

let hlsPromise = null;

// Only fetched the first time a converted stream needs it, and only in
// browsers that can't play HLS themselves.
function loadHlsJs() {
  if (window.Hls) return Promise.resolve(window.Hls);
  hlsPromise ??= new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = '/vendor/hls.light.min.js';
    script.onload = () => resolve(window.Hls || null);
    script.onerror = () => { hlsPromise = null; resolve(null); };
    document.head.append(script);
  });
  return hlsPromise;
}

function nativeHls(video) {
  return Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
}

async function createPlayer() {
  if (state.video) return true;
  const video = $('#watch-video');
  controls.attach(video, {
    subtitleDelay: { get: subtitleDelay, set: setSubtitleDelay },
    // While the seek bar is dragged, tell the server where it's heading.
    prepare: (seconds) => {
      const sid = state.session?.mode === 'hls' ? state.session.sid : null;
      if (sid) post(`/api/transcode/prepare/${sid}`, { t: seconds }).catch(() => {});
    },
    prev: () => { if (state.index > 0) play(state.index - 1); },
    next: () => {
      if (state.ticket && state.index < state.ticket.items.length - 1) play(state.index + 1);
      else nextEpisode();
    },
  });
  video.playsInline = true;
  video.preload = 'auto';
  state.video = video;

  video.addEventListener('error', () => {
    // An empty src after a reset raises an error too; ignore that one.
    if (!video.getAttribute('src') && !state.hls) return;
    const err = video.error;
    note(`video error ${err?.code}: ${err?.message || ''}`);
    onPlaybackError(err);
  });
  video.addEventListener('waiting', () => note('waiting for data'));
  video.addEventListener('playing', () => { note('playing'); setStatus(''); clearSilence(); });
  video.addEventListener('timeupdate', () => {
    if (Date.now() - state.lastSave < SAVE_EVERY_MS) return;
    state.lastSave = Date.now();
    rememberPosition();
  });
  // Continue watching: report where we are every 15 s of playback, on pause,
  // and at the end (which the server treats as finished).
  let lastReport = 0;
  video.addEventListener('timeupdate', () => {
    if (Date.now() - lastReport > 15000 && !video.paused) { lastReport = Date.now(); reportProgress(); }
  });
  video.addEventListener('pause', () => reportProgress());
  video.addEventListener('ended', () => {
    reportProgress({ finished: true });
    storage.clear(state.index);
    if (state.index < state.ticket.items.length - 1) play(state.index + 1);
    else nextEpisode();
  });

  return true;
}

function resetVideo() {
  const { video } = state;
  if (state.hls) {
    try { state.hls.destroy(); } catch { /* already gone */ }
    state.hls = null;
  }
  if (!video) return;
  video.pause();
  // iPhone's own fullscreen player closes if the video is emptied. Leave the
  // old source in place; the next episode's replaces it directly, and the
  // phone stays fullscreen across the change.
  if (video.webkitDisplayingFullscreen) {
    video.querySelectorAll('track').forEach((t) => t.remove());
    return;
  }
  video.removeAttribute('src');
  video.querySelectorAll('track').forEach((t) => t.remove());
  video.load();
}

// --------------------------------------------------------------- playback

// Load item `next`. `opts.resumeAt` overrides the saved position (an audio
// switch carries on from here); `opts.forceTranscode` skips direct mode after
// the browser has refused the file as it stands.
async function play(next, opts = {}) {
  const { ticket, video } = state;
  if (!ticket || !video) return;

  rememberPosition();
  const gen = ++state.gen;
  const previous = state.loadedIndex;
  state.index = Math.max(0, Math.min(next, ticket.items.length - 1));
  const item = current();
  const newItem = previous !== state.index;
  state.loadedIndex = state.index;
  trace.length = 0;

  stopSession();
  closeExternalPlayer();
  hideFallback();
  $('#watch-audio-wrap').hidden = true;
  renderHeading(item);
  markQueue();
  updateNav();
  loadSources(gen);
  resetVideo();
  if (newItem) startItemSubtitles(gen);
  setStatus('Preparing the stream…');

  // Where to start: an explicit position, else this tab's own memory, else
  // where this profile left off on any device (Continue watching).
  const resumeAt = opts.resumeAt ?? (storage.get(state.index) || item?.resume || 0);
  // Subtitles are never burned in any more (it cost a full re-encode); PGS
  // is drawn by the player instead. Kept only so old callers are harmless.
  const burn = null;
  state.embeddedSubs = [];
  renderSubtitleMenu();

  if (!item.transcodeKey) {
    note('no ffmpeg — playing the source directly');
    state.session = { mode: 'source', tracks: [], audio: 0 };
    load(gen, { src: item.url, type: 'video/mp4', resumeAt });
    return;
  }

  let reply;
  try {
    reply = await post('/api/transcode/start', {
      u: item.transcodeKey.u,
      s: item.transcodeKey.s,
      // No index on a first start: the server picks the track in the
      // default language from Settings.
      audio: Number.isInteger(opts.audio) ? opts.audio : undefined,
      // Start ffmpeg where playback will resume, so the first segment made
      // is the one that's needed.
      seek: resumeAt || 0,
      burn: burn ?? undefined,
      forceTranscode: opts.forceTranscode === true || undefined,
    });
  } catch (err) {
    if (isStale(gen)) return;
    // Lumen couldn't take it. VLC is the fallback: straight to it on a
    // desktop with the launcher, offered first everywhere else.
    note(`conversion refused: ${err.message}`);
    showFallback(`The server couldn’t convert this: ${err.message}`);
    return;
  }

  // The person moved on while we waited: don't leave that ffmpeg running.
  if (isStale(gen)) {
    if (reply.sid) post(`/api/transcode/stop/${reply.sid}`).catch(() => {});
    return;
  }

  note(`server chose: ${reply.mode}`);

  if (reply.mode === 'external') {
    state.session = { mode: 'external', tracks: [], audio: 0 };
    handToVlc(describeFile(reply));
    return;
  }
  state.session = {
    mode: reply.mode,
    sid: reply.sid || null,
    tracks: reply.audioTracks || [],
    audio: reply.audio ?? opts.audio ?? 0,
    burn: reply.burn ?? null,
    forcedTranscode: opts.forceTranscode === true,
  };
  state.embeddedSubs = reply.subtitleTracks || [];
  state.embeddedDefault = reply.preferredSubtitle ?? null;
  renderSubtitleMenu();
  chooseDefaultSubtitle();

  if (reply.mode === 'direct') {
    $('#watch-stage').classList.remove('is-live');
    load(gen, { src: reply.url, type: 'video/mp4', resumeAt });
    return;
  }

  startHeartbeat(gen);
  // What the server is doing goes in the trace, not on screen.
  note(describeConversion(reply));
  setStatus('');
  // Live TV: nothing to resume, no timeline — the player shows LIVE instead
  // of a seek bar and joins at "now".
  $('#watch-stage').classList.toggle('is-live', Boolean(reply.live));
  // Live channels go on Continue watching as "recently watched".
  if (reply.live && current()?.id) post('/api/progress', { type: 'tv', id: current().id }).catch(() => {});
  load(gen, { src: reply.url, type: 'application/x-mpegURL', resumeAt: reply.live ? 0 : resumeAt, live: Boolean(reply.live) });
  if (reply.live) watchLive(gen);
  watchForSilence(gen);
}

// Start playing without waiting for a tap. Phones only allow a video to
// start by itself if it's muted, so when playing with sound is refused it
// starts muted instead, and the first touch or key anywhere turns the sound
// back on. Nothing is shown and nothing waits on the person.
function autoplay(gen) {
  const { video } = state;
  video.autoplay = true;
  const attempt = video.play();
  if (!attempt?.catch) return;
  attempt.catch((err) => {
    if (isStale(gen) || err?.name === 'AbortError') return;
    video.muted = true;
    video.play()?.catch?.(() => {});
    const unmute = () => {
      video.muted = false;
      if (video.paused) video.play()?.catch?.(() => {});
      for (const type of ['pointerdown', 'keydown', 'touchend']) document.removeEventListener(type, unmute, true);
    };
    for (const type of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(type, unmute, true);
  });
}

function describeConversion(reply) {
  if (reply.videoCopy) return `Remuxing ${reply.videoCodec}, ${reply.audioCodec} audio.`;
  const where = reply.encoder && reply.encoder !== 'software' ? ` on the GPU (${reply.encoder})` : ' on the CPU';
  const extras = [
    reply.hdr && (reply.toneMapped ? 'HDR tone mapped' : 'HDR, colours may look flat'),
    reply.burn !== null && reply.burn !== undefined && 'subtitles burned in',
  ].filter(Boolean);
  return `Converting ${reply.videoCodec}${where}${extras.length ? ` · ${extras.join(' · ')}` : ''}.`;
}

async function load(gen, { src, type, resumeAt, live = false }) {
  const { video } = state;
  note(`source ${type} ${src.slice(0, 60)}`);

  video.addEventListener('loadedmetadata', () => {
    if (isStale(gen)) return;
    note(`metadata: ${Math.round(video.duration || 0)}s`);
    if (resumeAt) seekWithin(resumeAt);
    renderAudioMenu(gen);
    autoplay(gen);
  }, { once: true });

  const isHls = type === 'application/x-mpegURL';
  if (!isHls || nativeHls(video)) {
    video.src = src;
    syncSubtitles();
    return;
  }

  const Hls = await loadHlsJs();
  if (isStale(gen)) return;
  if (!Hls?.isSupported()) {
    showFallback('This browser can’t play a converted stream.');
    return;
  }

  const hls = new Hls(live ? {
    // Live TV: play about three segments behind the newest, and if the
    // player falls further back than that (a stall, a backgrounded tab),
    // speed up a little to catch up rather than drifting minutes behind.
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 8,
    maxLiveSyncPlaybackRate: 1.1,
    maxBufferLength: 20,
    backBufferLength: 30,
    maxBufferHole: 1,
    // A channel reconnecting on the server leaves a short gap in segments;
    // keep asking rather than declaring the stream dead.
    manifestLoadingMaxRetry: 6,
    levelLoadingMaxRetry: 8,
    fragLoadingMaxRetry: 8,
    fragLoadingTimeOut: 20000,
  } : {
    // Ask for the resume point's segment first. Starting at 0 and seeking
    // once the metadata arrived made the server restart ffmpeg twice — at 0,
    // then back where it had already been — before anything played.
    startPosition: resumeAt > 0 ? resumeAt : -1,
    maxBufferLength: 30,
    maxMaxBufferLength: 120,
    // Keep three minutes behind the playhead in memory, so scrubbing back a
    // little doesn't fetch anything at all.
    backBufferLength: 180,
    startFragPrefetch: true,
    // A remux's first segment after a seek can start a little before or
    // after where the playlist says (it has to begin on a keyframe). Let the
    // player step over small gaps instead of waiting at them.
    maxBufferHole: 2.5,
    nudgeMaxRetry: 10,
    // Segments are made on demand, so the first one after a seek can take a
    // few seconds; don't treat that as a failure.
    fragLoadingTimeOut: 60000,
    fragLoadingMaxRetry: 4,
  });
  state.hls = hls;
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (isStale(gen) || !data.fatal) return;
    note(`hls fatal: ${data.type} ${data.details}`);
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
    // Live: the server reconnects to the channel on its own. Try again for
    // a while before giving up on it.
    if (live && data.type === Hls.ErrorTypes.NETWORK_ERROR && (state.liveRetries = (state.liveRetries || 0) + 1) <= 6) {
      setStatus('Reconnecting to the channel…');
      setTimeout(() => { if (!isStale(gen)) hls.startLoad(); }, 2000);
      return;
    }
    showFallback(data.type === Hls.ErrorTypes.NETWORK_ERROR
      ? 'The stream stopped arriving.'
      : `Playback failed: ${data.details}`);
  });
  hls.loadSource(src);
  hls.attachMedia(video);
  syncSubtitles();
}

// Live TV, in any player (hls.js or Safari's own): if the picture has been
// stuck for a few seconds while meant to be playing, jump back to just
// behind the newest segment. Without this, a hiccup on the channel left an
// iPhone frozen on the last frame until the person reloaded.
function watchLive(gen) {
  const { video } = state;
  let lastTime = -1;
  let stuckSince = 0;
  const timer = setInterval(() => {
    if (isStale(gen)) { clearInterval(timer); return; }
    if (video.paused || video.readyState === 0) { stuckSince = 0; return; }
    if (video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      stuckSince = 0;
      state.liveRetries = 0;
      return;
    }
    stuckSince ||= Date.now();
    if (Date.now() - stuckSince < 6000) return;
    stuckSince = 0;
    const { seekable } = video;
    const edge = state.hls?.liveSyncPosition
      ?? (seekable?.length ? seekable.end(seekable.length - 1) - 6 : null);
    note(`live stalled — jumping to the edge (${Math.round(edge || 0)}s)`);
    if (state.hls) state.hls.startLoad();
    if (Number.isFinite(edge) && edge > video.currentTime) video.currentTime = edge;
    video.play()?.catch?.(() => {});
  }, 1000);
}

// A growing HLS playlist can only seek into what ffmpeg has written, so clamp
// to the seekable range rather than jumping into a stall.
function seekWithin(seconds) {
  const { video } = state;
  const { seekable } = video;
  let limit = Number.isFinite(video.duration) ? video.duration : Infinity;
  if (seekable?.length) limit = Math.min(limit, seekable.end(seekable.length - 1) - 2);
  const target = Math.max(0, Math.min(seconds, limit));
  // Already there (hls.js started at it): a seek would only flush the buffer.
  if (target > 0 && Math.abs(video.currentTime - target) > 1) video.currentTime = target;
}

function onPlaybackError(err) {
  const { session } = state;
  // MEDIA_ERR_DECODE / SRC_NOT_SUPPORTED on a restream: the codecs looked
  // playable but this browser disagrees. Convert it instead, once.
  const undecodable = err?.code === 3 || err?.code === 4;
  // A file the browser refuses goes through Lumen first. Only when that
  // fails too does VLC come into it (see showFallback).
  if (['direct', 'source'].includes(session?.mode) && !session.forcedTranscode && undecodable
      && current()?.transcodeKey) {
    note('direct playback refused — converting instead');
    play(state.index, { forceTranscode: true, resumeAt: state.video.currentTime || undefined });
    return;
  }
  if (undecodable) { retryDecode(err); return; }
  showFallback(describeError(err));
}

// A decode error is very often momentary — a corrupt segment, a seek that
// landed badly, the first segment of a restarted conversion — and the next
// attempt plays. So "This browser can't decode that file" only appears after
// DECODE_GRACE_MS of failing without a single frame playing in between.
// Until then the player keeps retrying from where it was.
const DECODE_GRACE_MS = 45_000;
let decodeTrouble = null;

function retryDecode(err) {
  const { video } = state;
  const gen = state.gen;
  if (!decodeTrouble || decodeTrouble.gen !== gen) {
    decodeTrouble = { gen, since: Date.now(), attempts: 0 };
    // Any progress at all ends the trouble.
    const clear = () => { if (decodeTrouble?.gen === gen) decodeTrouble = null; };
    video.addEventListener('playing', clear, { once: true });
  }
  const t = decodeTrouble;
  if (Date.now() - t.since >= DECODE_GRACE_MS) {
    decodeTrouble = null;
    showFallback(describeError(err));
    return;
  }
  t.attempts += 1;
  setStatus('Having trouble decoding this — retrying…');
  note(`decode error ${err?.code}, retry ${t.attempts}`);
  const at = video.currentTime || 0;
  setTimeout(() => {
    if (isStale(gen) || decodeTrouble !== t) return;
    if (state.hls) {
      // hls.js: rebuild the decoder; every other time, also try swapping the
      // audio codec setup, the usual cure for an AAC/HE-AAC mismatch.
      if (t.attempts % 2 === 0) state.hls.swapAudioCodec();
      state.hls.recoverMediaError();
    } else {
      const src = video.currentSrc || video.getAttribute('src');
      if (src) {
        video.src = src;
        video.addEventListener('loadedmetadata', () => { if (at) video.currentTime = at + 0.5; }, { once: true });
      }
    }
    video.play()?.catch?.(() => {});
    // If nothing has played by the end of the grace period, say so.
    setTimeout(() => {
      if (!isStale(gen) && decodeTrouble === t && Date.now() - t.since >= DECODE_GRACE_MS - 100) {
        decodeTrouble = null;
        showFallback(describeError(err));
      }
    }, Math.max(0, DECODE_GRACE_MS - (Date.now() - t.since)));
  }, Math.min(5000, 1000 * t.attempts));
}

function describeError(err) {
  const mixed = location.protocol === 'https:' && /^http:/.test(current()?.url || '');
  if (state.session?.mode === 'source' && mixed) {
    return 'This stream is plain HTTP and this page is HTTPS, so the browser blocked it.';
  }
  if (err?.code === 4 || err?.code === 3) return 'This browser can’t decode that file.';
  if (err?.code === 2) return 'The stream stopped arriving.';
  return `Playback failed: ${err?.message || 'unknown error'}`;
}

function updateNav() {
  const count = state.ticket.items.length;
  const series = state.ticket.type === 'series';
  // A film has no episodes to step through, so those controls go. A series
  // always has Next: past the end of the queue it fetches the next episode.
  $('#watch-prev').hidden = count < 2;
  $('#watch-next').hidden = count < 2 && !series;
  $('#watch-prev').disabled = state.index === 0;
  $('#watch-next').disabled = state.index >= count - 1 && !series;
  $('#watch-queue-btn').hidden = count < 2;
}

function show() {
  document.body.classList.add('watching');
  $('#screen-watch').hidden = false;
}

function fail(message) {
  show();
  setStatus('');
  $('#watch-fallback-message').textContent = message;
  $('#watch-fallback-note').hidden = true;
  $('#watch-fallback-actions').replaceChildren();
  $('#watch-fallback').hidden = false;
}

// ------------------------------------------------------------ conversion

function startHeartbeat(gen) {
  clearInterval(state.heartbeat);
  state.heartbeat = setInterval(async () => {
    const sid = state.session?.sid;
    if (isStale(gen) || !sid) { clearInterval(state.heartbeat); return; }
    try {
      await post(`/api/transcode/heartbeat/${sid}`);
    } catch {
      if (isStale(gen)) return;
      clearInterval(state.heartbeat);
      note('heartbeat refused — session gone');
      showFallback('The conversion ended on the server.');
    }
  }, HEARTBEAT_MS);
}

function stopSession() {
  clearInterval(state.heartbeat);
  clearSilence();
  const sid = state.session?.sid;
  if (sid) post(`/api/transcode/stop/${sid}`).catch(() => {});
  state.session = null;
}

function clearSilence() {
  clearTimeout(state.silence);
  state.silence = null;
}

// An HLS stall raises nothing, so if nothing has played after a while, say
// what is known rather than showing a clock that never moves.
function watchForSilence(gen) {
  clearSilence();
  const startedAt = state.video?.currentTime || 0;
  state.silence = setTimeout(async () => {
    const { video, session } = state;
    if (isStale(gen) || !session?.sid || !video) return;
    // It's playing (the clock has moved), or it's only waiting on a press of
    // play: not a failure, and not something to put a panel over the film.
    if (video.currentTime > startedAt + 0.5 && !video.paused) return;
    if (video.paused && video.readyState >= 2) { autoplay(gen); return; }
    // Still loading but getting somewhere: give it longer.
    if (video.readyState >= 2 && video.buffered?.length) { watchForSilence(gen); return; }
    // Mid-way through decode retries: those have their own 45 s deadline.
    if (decodeTrouble?.gen === gen) { watchForSilence(gen); return; }

    let server = null;
    try { server = await request(`/api/transcode/debug/${session.sid}`); } catch { /* best effort */ }
    if (isStale(gen)) return;

    const lines = [
      `readyState ${video.readyState}, duration ${Math.round(Number.isFinite(video.duration) ? video.duration : 0)}s${state.hls ? ' (hls.js)' : ''}`,
      server
        ? `server: ${server.segments} segment(s), ffmpeg ${server.running ? 'running' : 'stopped'}${server.restarts ? `, ${server.restarts} restart(s)` : ''}`
        : 'server: no report',
      server?.plan && `file: ${server.plan.container} ${server.plan.videoCodec}/${server.plan.audioCodec} (copy ${server.plan.videoCopy ? 'yes' : 'no'})`,
      server?.lastError && `ffmpeg: ${server.lastError}`,
      '',
      ...trace.slice(-14),
    ].filter((l) => l !== null && l !== undefined && l !== false);

    showFallback(`Nothing has played after ${SILENCE_MS / 1000} seconds. What happened:`);
    const panel = $('#watch-fallback-note');
    panel.classList.add('watch-trace');
    Object.assign(panel.style, { whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace', fontSize: '11px' });
    panel.textContent = lines.join('\n');
    panel.hidden = false;
  }, SILENCE_MS);
}

// The subtitle language from Settings, applied to a file's own tracks when
// nothing else has been chosen: not by the person in the menu, and not by the
// addon subtitle the server already attached for that language.
// The heading at the top of the player: the film, or the show with season,
// episode and episode title.
function renderHeading(item) {
  const heading = item?.heading || {};
  $('#watch-heading-title').textContent = heading.title || '';
  $('#watch-heading-detail').textContent = heading.detail || '';
  document.title = [heading.title, heading.detail].filter(Boolean).join(' · ') || 'Nuvio';
}

// A new episode (or film): everything about the last one's subtitles goes —
// the track on screen, the choice made for that file, the lists — and this
// one's are fetched. What carries over is the person's intent: the language
// they picked, or that they turned subtitles off.
function startItemSubtitles(gen) {
  state.subtitle = null;
  state.subtitleTouched = false;
  state.addonSubs = [];
  state.addonLoaded = false;
  state.embeddedSubs = [];
  state.embeddedDefault = null;
  state.subDelay = 0;
  state.video?.querySelectorAll('track').forEach((t) => t.remove());
  disposePgs();
  renderSubtitleMenu();
  loadSubtitleMenu(gen);
}

// Subtitles are on by default, from OpenSubtitles, in the person's language
// (the one picked in the player this session, else Settings, else the audio
// language, else English — the server ranks the list). Failing that, the
// subtitle the playlist came with, then a matching track inside the file.
function chooseDefaultSubtitle() {
  if (state.subtitlesOff || state.subtitleTouched || state.subtitle) return;
  if (!state.addonLoaded) return; // decided once the addon list is in

  const addons = state.addonSubs || [];
  const index = addons.findIndex((sub) => sub.matches && sub.openSubtitles);
  const pick = index >= 0 ? index : addons.findIndex((sub) => sub.matches);
  if (pick >= 0) {
    const sub = addons[pick];
    state.subtitle = { key: `a${pick}`, url: sub.url, label: sub.label, lang: sub.lang };
  } else if (!current()?.subtitle && Number.isInteger(state.embeddedDefault)) {
    const track = (state.embeddedSubs || []).find((t) => t.stream === state.embeddedDefault && t.url);
    if (track) {
      state.subtitle = { key: `e${track.stream}`, url: track.url, label: track.label, lang: track.lang, pgs: track.render === 'pgs' };
    }
  }
  renderSubtitleMenu();
  syncSubtitles();
}

// The next episode, when the queue has run out (or there was never more than
// one). The server names it, the server picks its best stream, and it loads
// into this same player — same <video>, same fullscreen — carrying over the
// subtitle language and whether subtitles are off.
let fetchingNext = false;
async function nextEpisode() {
  const id = current()?.id;
  if (fetchingNext || state.ticket?.type !== 'series' || !id) return;
  fetchingNext = true;
  const gen = state.gen;
  setStatus('Loading the next episode…');
  try {
    const upcoming = await request(`/api/next/${encodeURIComponent(id)}`);
    const link = playLink(`/play/auto/series/${encodeURIComponent(upcoming.id)}`, { format: 'json' });
    const res = await fetch(link, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.watch) throw new Error(data.error || 'No playable stream for the next episode.');
    if (gen !== state.gen) return;
    history.replaceState(history.state, '', data.watch);
    await mount({ inPage: state.inPage, onExit: state.onExit, keepChoices: true });
  } catch (err) {
    setStatus(err.message || 'That was the last episode.');
  } finally {
    fetchingNext = false;
  }
}

function reportProgress({ finished = false } = {}) {
  const { video, ticket } = state;
  const item = current();
  if (!video || !item?.id || !['movie', 'series'].includes(ticket?.type)) return;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const position = finished ? duration : (video.currentTime || 0);
  if (!duration || (!finished && position < 5)) return;
  post('/api/progress', {
    type: ticket.type, id: item.id, position, duration,
    episodeTitle: item.heading?.detail || null,
  }).catch(() => {});
}

// ---------------------------------------------------------------- sources

// Every stream the addons returned for what's on screen, for the options
// menu's Source section. Choosing one swaps it in and carries on from the
// same position. Kept per title, so episodes and repeat visits are instant.
const sourceCache = new Map();

async function loadSources(gen) {
  const wrap = $('#watch-source-wrap');
  const select = $('#watch-source');
  const item = current();
  const type = state.ticket?.type;
  const id = item?.id || state.ticket?.id;
  wrap.hidden = true;
  if (!item || !type || !id) return;

  let list = sourceCache.get(`${type}/${id}`);
  if (!list) {
    try {
      const data = await request(`/api/streams/${encodeURIComponent(type)}/${encodeURIComponent(id)}?keys=1`);
      list = Array.isArray(data?.streams) ? data.streams : [];
      sourceCache.set(`${type}/${id}`, list);
    } catch { return; }
  }
  if (isStale(gen) || !list.length) return;

  select.replaceChildren();
  let chosen = null;
  list.forEach((stream, i) => {
    const el = option(String(i), stream.headline || stream.label || `Source ${i + 1}`);
    const usable = stream.playable && stream.url;
    el.dataset.detail = [stream.addon, ...(stream.badges || []), usable ? null : 'needs debrid']
      .filter(Boolean).join(' · ');
    el.disabled = !usable;
    if (usable && stream.url === item.url && chosen === null) chosen = String(i);
    select.append(el);
  });
  // The one playing came from a playlist and isn't in this list verbatim.
  if (chosen === null) {
    const el = option('current', 'Current stream');
    select.prepend(el);
    chosen = 'current';
  }
  select.value = chosen;
  wrap.hidden = false;

  select.onchange = () => {
    const stream = list[Number(select.value)];
    if (!stream?.url) return;
    const resumeAt = state.video?.currentTime || 0;
    state.ticket.items[state.index] = {
      ...current(),
      url: stream.url,
      transcodeKey: stream.transcodeKey || null,
    };
    // A subtitle from inside the old file doesn't exist in the new one.
    if (state.subtitle?.key?.startsWith('e')) state.subtitle = null;
    setStatus('Switching source…');
    play(state.index, { resumeAt });
  };
}

// ----------------------------------------------------------- audio tracks

function renderAudioMenu(gen) {
  const wrap = $('#watch-audio-wrap');
  const select = $('#watch-audio');
  const { session, video } = state;
  select.replaceChildren();
  select.onchange = null;
  wrap.hidden = true;
  if (isStale(gen)) return;

  // Converting: ffmpeg maps whichever stream we ask for.
  if (session?.mode === 'hls' && session.tracks.length > 1) {
    for (const track of session.tracks) select.append(option(String(track.index), track.label));
    select.value = String(session.audio);
    select.onchange = () => {
      setStatus('Switching audio track…');
      play(state.index, { audio: Number(select.value), resumeAt: video.currentTime || 0 });
    };
    wrap.hidden = false;
    return;
  }

  // Restreaming: only offer what the browser genuinely exposes (Safari).
  const tracks = video.audioTracks;
  if (tracks && tracks.length > 1) {
    for (let i = 0; i < tracks.length; i += 1) {
      select.append(option(String(i), tracks[i].label || tracks[i].language || `Track ${i + 1}`));
      if (tracks[i].enabled) select.value = String(i);
    }
    select.onchange = () => {
      for (let i = 0; i < tracks.length; i += 1) tracks[i].enabled = String(i) === select.value;
    };
    wrap.hidden = false;
  }
}

function option(value, label) {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = label;
  return el;
}

// -------------------------------------------------------------- subtitles

// One subtitle track at a time: the menu's choice if there is one, else the
// item's own, else nothing. Called after every source change so tracks never
// pile up across episodes or audio switches.
// Subtitle timing, in seconds: positive shows them later, negative earlier.
// Set from the Subtitles menu, for a subtitle file made for a slightly
// different release. Starts at zero for each film.
let pgsRenderer = null;
let pgsModule = null;

function disposePgs() {
  try { pgsRenderer?.dispose(); } catch { /* already gone */ }
  pgsRenderer = null;
  const canvas = $('#watch-pgs');
  if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
}

// Shift every cue of a loaded text track by `by` seconds.
function shiftCues(textTrack, by) {
  if (!by || !textTrack?.cues) return;
  for (const cue of Array.from(textTrack.cues)) {
    cue.startTime = Math.max(0, cue.startTime + by);
    cue.endTime = Math.max(cue.startTime + 0.05, cue.endTime + by);
  }
}

export function subtitleDelay() {
  return state.subDelay || 0;
}

export function setSubtitleDelay(seconds) {
  const next = Math.round(Math.max(-30, Math.min(30, seconds)) * 10) / 10;
  const by = next - (state.subDelay || 0);
  state.subDelay = next;
  // Text: move the cues of whatever is loaded. A track still loading picks
  // the delay up when it arrives.
  const el = state.video?.querySelector('track');
  if (el?.readyState === 2) {
    shiftCues(el.track, by);
    el.dataset.shifted = String(next);
  }
  if (liveTrack && by) shiftCues(liveTrack, by);
  // PGS: the renderer has its own offset (positive draws earlier).
  if (pgsRenderer) pgsRenderer.timeOffset = -next;
  return next;
}

function syncSubtitles() {
  const { video } = state;
  if (!video) return;
  video.querySelectorAll('track').forEach((t) => t.remove());
  disposePgs();
  stopLiveSubs();
  if (state.subtitlesOff) return;

  const chosen = state.subtitle || (current()?.subtitle && { url: current().subtitle, label: 'Addon subtitles' });
  if (!chosen) return;

  if (chosen.pgs) {
    loadPgs(chosen);
    return;
  }
  // A text track inside the file: shown cue by cue as the server reads it.
  if (chosen.key?.startsWith('e')) {
    loadLiveSubs(chosen);
    return;
  }

  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = chosen.label;
  track.src = chosen.url;
  track.default = true;
  video.append(track);
  track.addEventListener('load', () => {
    // Apply the current timing to the freshly loaded cues.
    shiftCues(track.track, state.subDelay || 0);
    track.dataset.shifted = String(state.subDelay || 0);
    track.track.mode = 'showing';
    if (/Loading subtitles/.test($('#watch-status')?.textContent || '')) setStatus('');
  }, { once: true });
  track.addEventListener('error', () => setStatus('Those subtitles couldn’t be loaded.'), { once: true });
  track.track.mode = 'showing';
}

// Subtitles inside the file used to wait for the server to read the whole
// film before a single line appeared. Now the server reads from where the
// viewer is first and hands back what it has; cues go onto a text track the
// page owns (addTextTrack — shown by Safari's fullscreen player too) as they
// arrive, and the page asks again every couple of seconds until it's all
// there.
let liveTrack = null;
let liveRun = 0;

function stopLiveSubs() {
  liveRun += 1;
  if (!liveTrack) return;
  for (const cue of Array.from(liveTrack.cues || [])) liveTrack.removeCue(cue);
  liveTrack.mode = 'disabled';
}

function parseVtt(text) {
  const stamp = (v) => {
    const parts = v.trim().split(':').map(Number);
    return parts.reduce((total, n) => total * 60 + n, 0);
  };
  const cues = [];
  for (const block of String(text).replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [a, rest] = lines[at].split('-->');
    const b = rest.trim().split(/\s+/)[0];
    const start = stamp(a);
    const end = stamp(b);
    const body = lines.slice(at + 1).join('\n');
    if (Number.isFinite(start) && Number.isFinite(end) && body) cues.push({ key: `${start}|${end}|${body}`, start, end, body });
  }
  return cues;
}

async function loadLiveSubs(chosen) {
  const { video } = state;
  const run = liveRun;
  if (!liveTrack) liveTrack = video.addTextTrack('subtitles', 'Subtitles');
  liveTrack.mode = 'showing';
  const seen = new Set();
  let first = true;
  for (;;) {
    if (run !== liveRun) return;
    const from = Math.floor(video.currentTime || 0);
    let complete = false;
    try {
      const res = await fetch(`${chosen.url}&partial=1&from=${from}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(await res.text());
      complete = res.headers.get('x-subtitle-complete') === '1';
      const text = await res.text();
      if (run !== liveRun) return;
      const delay = state.subDelay || 0;
      for (const cue of parseVtt(text)) {
        if (seen.has(cue.key)) continue;
        seen.add(cue.key);
        const start = Math.max(0, cue.start + delay);
        liveTrack.addCue(new VTTCue(start, Math.max(start + 0.05, cue.end + delay), cue.body));
      }
      if (first && /Loading subtitles/.test($('#watch-status')?.textContent || '')) setStatus('');
      first = false;
    } catch (err) {
      note(`subtitles: ${err?.message || err}`);
      if (first) setStatus('Those subtitles couldn’t be loaded.');
      return;
    }
    if (complete) return;
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
  }
}

// Blu-ray (PGS) subtitles are pictures. Rather than burning them into the
// video on the server — a full re-encode — the track is copied out as-is and
// drawn over the picture here, in a worker, by libpgs.
async function loadPgs(chosen) {
  const gen = state.gen;
  try {
    pgsModule ??= await import('/vendor/libpgs.js');
    if (gen !== state.gen || state.subtitle?.key !== chosen.key) return;
    pgsRenderer = new pgsModule.PgsRenderer({
      video: state.video,
      canvas: $('#watch-pgs'),
      workerUrl: '/vendor/libpgs.worker.js',
      subUrl: chosen.url,
      aspectRatio: 'contain',
      timeOffset: -(state.subDelay || 0),
    });
    await pgsRenderer.ready;
    if (/Loading subtitles/.test($('#watch-status')?.textContent || '')) setStatus('');
  } catch (err) {
    note(`pgs: ${err?.message || err}`);
    setStatus('Those subtitles couldn’t be loaded.');
  }
}

async function loadSubtitleMenu(gen = state.gen) {
  const { type } = state.ticket || {};
  const id = current()?.id || state.ticket?.id;
  if (!type || !id) { state.addonLoaded = true; chooseDefaultSubtitle(); return; }
  try {
    const lang = state.subLangChoice ? `?lang=${encodeURIComponent(state.subLangChoice)}` : '';
    const list = await request(`/api/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}${lang}`);
    if (gen !== state.gen && state.loadedIndex !== state.index) return;
    if (current()?.id && current().id !== id) return; // moved on to another episode
    state.addonSubs = Array.isArray(list) ? list : [];
  } catch {
    state.addonSubs = [];
  }
  state.addonLoaded = true;
  renderSubtitleMenu();
  chooseDefaultSubtitle();
}

// One menu: subtitles inside the file (text, and Blu-ray PGS drawn by the
// player) and subtitles from addons. Switching never restarts the video.
function renderSubtitleMenu() {
  const wrap = $('#watch-subs-wrap');
  const select = $('#watch-subs');
  // Only tracks the browser can show: text, and PGS (drawn by the player).
  const embedded = (state.embeddedSubs || []).filter((t) => t.url);
  const addons = state.addonSubs || [];

  select.replaceChildren(option('', 'Off'));
  if (current()?.subtitle) select.append(option('__item', 'Default'));
  embedded.forEach((sub) => select.append(option(`e${sub.stream}`, sub.label)));
  addons.forEach((sub, i) => select.append(option(`a${i}`, `${sub.label}${sub.addon ? ` · ${sub.addon}` : ''}`)));
  wrap.hidden = select.options.length < 2;

  if (state.subtitlesOff) select.value = '';
  else if (state.subtitle?.key && [...select.options].some((o) => o.value === state.subtitle.key)) select.value = state.subtitle.key;
  else select.value = current()?.subtitle ? '__item' : '';

  select.onchange = () => {
    state.subtitleTouched = true;
    const value = select.value;
    const label = select.selectedOptions[0]?.textContent || '';
    const sub = value.startsWith('e') ? embedded.find((t) => `e${t.stream}` === value) : null;

    state.subtitlesOff = value === '';
    state.subtitle = null;
    if (sub) state.subtitle = { key: value, url: sub.url, label, lang: sub.lang, pgs: sub.render === 'pgs' };
    if (value.startsWith('a')) {
      const chosen = addons[Number(value.slice(1))];
      state.subtitle = { key: value, url: chosen.url, label, lang: chosen.lang };
    }
    // Carried to the next episode: the language, or that they're off.
    if (state.subtitle?.lang) state.subLangChoice = state.subtitle.lang;

    if (sub && sub.render === 'pgs') setStatus('Loading subtitles from the file… the first time can take a little while.');
    syncSubtitles();
  };
}

// ----------------------------------------------------------------- queue

function renderQueue() {
  const list = $('#watch-queue');
  list.replaceChildren(...state.ticket.items.map((item, i) => {
    const row = document.createElement('button');
    row.className = 'queue-item';
    const num = document.createElement('span');
    num.className = 'queue-num';
    num.textContent = String(i + 1);
    const title = document.createElement('span');
    title.className = 'queue-title';
    title.textContent = item.title;
    row.append(num, title);
    row.addEventListener('click', () => play(i));
    return row;
  }));
  markQueue();
}

function markQueue() {
  [...$('#watch-queue').children].forEach((row, i) => {
    row.setAttribute('aria-current', String(i === state.index));
  });
}

// -------------------------------------------------------- external player

async function useExternalPlayer() {
  const item = current();
  if (!item?.transcodeKey) {
    showFallback('This server has no restreaming for that file, so it can’t be handed to another player.');
    return;
  }
  const gen = ++state.gen;
  setStatus('Handing the stream to OnlinePlayer…');

  let reply;
  try {
    reply = await post('/api/transcode/start', { u: item.transcodeKey.u, s: item.transcodeKey.s, forceDirect: true });
  } catch (err) {
    if (!isStale(gen)) showFallback(err.message);
    return;
  }
  if (isStale(gen)) return;
  if (reply.mode !== 'direct') {
    if (reply.sid) post(`/api/transcode/stop/${reply.sid}`).catch(() => {});
    showFallback('This file has to be converted first, and a converted stream can only be played here.');
    return;
  }

  rememberPosition();
  resetVideo();
  stopSession();
  hideFallback();
  setStatus('Playing in OnlinePlayer. The stream link has been shared with that site.');

  const frame = $('#watch-external');
  const absolute = new URL(reply.url, location.origin).href;
  frame.src = `${EXTERNAL_PLAYER}?${new URLSearchParams({ autoload: absolute, theme: 'dark' })}`;
  frame.hidden = false;
}

function closeExternalPlayer() {
  const frame = $('#watch-external');
  if (frame.hidden) return;
  frame.hidden = true;
  frame.removeAttribute('src');
}

// --------------------------------------------------------- when it fails

function hideFallback() {
  $('#watch-fallback').hidden = true;
  $('#watch-fallback-note').hidden = true;
}

function showFallback(message) {
  clearSilence();
  setStatus('');
  $('#watch-fallback-message').textContent = message;
  $('#watch-fallback-note').hidden = true;
  const actions = $('#watch-fallback-actions');
  actions.replaceChildren();

  const item = current();
  // When the browser can't decode the file, VLC is the likeliest thing to work.
  const vlcFirst = hasLauncher();
  if (vlcFirst) action(actions, 'Open in VLC', () => openVlc(), true);
  action(actions, 'Try again', () => play(state.index), !vlcFirst);
  if (item?.transcodeKey && state.session?.mode !== 'hls') {
    action(actions, 'Convert it', () => play(state.index, { forceTranscode: true }));
  }
  if (!vlcFirst && item && ['ios', 'android'].includes(device.os)) {
    action(actions, 'Open in VLC', () => {
      const link = new URL(playLink('/play', { url: item.url, title: item.title }), location.origin);
      link.searchParams.set('target', 'vlc');
      location.href = link.pathname + link.search;
    }, true);
  }
  if (device.os !== 'ios') {
    action(actions, vlcFirst ? 'VLC (.m3u file)' : 'Download for VLC (.m3u)', () => { location.href = `/playlist/${state.token}.m3u?dl=1`; });
  }
  if (device.os === 'android' && item) {
    action(actions, 'Choose an app', () => {
      const link = new URL(playLink('/play', { url: item.url, title: item.title }), location.origin);
      link.searchParams.set('target', 'player-chooser');
      location.href = link.pathname + link.search;
    });
  }
  if (location.protocol === 'https:' && item?.transcodeKey) action(actions, 'Try OnlinePlayer', useExternalPlayer);
  action(actions, 'Copy stream link', copyLink);

  $('#watch-fallback').hidden = false;
}

function describeFile(reply) {
  const codecs = [reply.videoCodec, reply.audioCodec].filter(Boolean).join(' / ');
  return codecs
    ? `This file (${codecs}) won’t play in the browser.`
    : 'This file won’t play in the browser.';
}

// The desktop path for anything the browser can't play: say so, and open a
// vlc:// link carrying the stream. Converting here stays a choice.
function handToVlc(reason) {
  setStatus('');
  resetVideo();
  stopSession();
  $('#watch-fallback-message').textContent = `${reason} Opening it in VLC…`;
  $('#watch-fallback-note').hidden = true;
  renderVlcActions();
  $('#watch-fallback').hidden = false;
  openVlc();
}

function renderVlcActions() {
  const item = current();
  const actions = $('#watch-fallback-actions');
  actions.replaceChildren();
  if (!item) return;

  // A real link, so it can be middle-clicked, dragged or copied as well.
  const open = document.createElement('a');
  open.className = 'btn-primary';
  open.textContent = 'Open in VLC';
  open.href = vlcLink(item.url);
  open.addEventListener('click', (event) => { event.preventDefault(); openVlc(); });
  actions.append(open);

  if (state.ticket.items.length > 1) {
    action(actions, 'Open the whole queue in VLC', () => openVlc(playlistUrl()));
  }
  action(actions, 'Copy VLC link', () => copyText(vlcLink(item.url), 'VLC link copied.'));
  if (item.transcodeKey) {
    action(actions, 'Convert and play here', () => play(state.index, { forceTranscode: true }));
  }
  action(actions, 'Download .m3u', () => { location.href = `${playlistUrl()}?dl=1`; });
}

function playlistUrl() {
  return `/playlist/${state.token}.m3u`;
}

// Open a stream in desktop VLC with a vlc:// link: this item's stream by
// default, or any URL given (the queue's playlist). If VLC doesn't take over,
// say how to set up the launcher that handles vlc:// links.
function openVlc(url = current()?.url) {
  if (!url) return;
  rememberPosition();
  state.video?.pause();
  stopSession();
  openInVlc(url, () => {
    const message = $('#watch-fallback-message');
    message.textContent = message.textContent.replace(' Opening it in VLC…', '');
    const note = $('#watch-fallback-note');
    note.classList.remove('watch-trace');
    note.removeAttribute('style');
    note.replaceChildren(
      launcherInstalled()
        ? 'VLC didn’t open. If your browser asked, allow vlc links and try again. Otherwise '
        : 'Desktop VLC can’t open vlc:// links until the one-time launcher is set up on this computer. ',
      Object.assign(document.createElement('a'), {
        href: '/vlc-setup', target: '_blank', rel: 'noopener',
        textContent: launcherInstalled() ? 'set up the launcher again' : 'Set up VLC',
      }),
      '.',
    );
    note.hidden = false;
    // Opened from the keyboard during playback: there are no actions showing yet.
    if ($('#watch-fallback').hidden) {
      message.textContent = 'VLC didn’t open.';
      renderVlcActions();
    }
    $('#watch-fallback').hidden = false;
  });
}

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(done);
  } catch {
    setStatus(text);
  }
}

function action(parent, label, handler, primary = false) {
  const button = document.createElement('button');
  button.className = primary ? 'btn-primary' : 'btn-ghost';
  button.textContent = label;
  button.addEventListener('click', handler);
  parent.append(button);
}

async function copyLink() {
  const url = current()?.url;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    setStatus('Stream link copied. In VLC: File → Open Network Stream.');
  } catch {
    setStatus(url);
  }
}

// ------------------------------------------------------------- positions

function rememberPosition() {
  reportProgress();
  const { video, ticket } = state;
  if (!video || !ticket) return;
  const at = video.currentTime || 0;
  const total = Number.isFinite(video.duration) ? video.duration : 0;
  if (at < MIN_RESUME_S) return;
  if (total && Number.isFinite(total) && at > total - END_MARGIN_S) storage.clear(state.index);
  else storage.set(state.index, at);
}

// -------------------------------------------------------------- keyboard

function onKey(event) {
  const { video, ticket } = state;
  if ($('#screen-watch').hidden || !ticket || !video) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) return;
  if (event.key === ' ' && document.activeElement?.tagName === 'BUTTON') return;
  // The native controls already answer these keys while the video has focus.
  if (document.activeElement === video && [' ', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;

  const step = event.shiftKey ? 30 : 10;
  const seekBy = (d) => seekWithin(Math.max(0, (video.currentTime || 0) + d));
  const last = ticket.items.length - 1;
  const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;

  switch (event.key) {
    case ' ':
    case 'k':
      if (video.paused) video.play()?.catch?.(() => {}); else video.pause();
      break;
    case 'j': case 'ArrowLeft': seekBy(-step); break;
    case 'l': case 'ArrowRight': seekBy(step); break;
    case 'f':
      controls.toggleFullscreen();
      break;
    case 'm': video.muted = !video.muted; break;
    case 'v': if (hasLauncher()) openVlc(); break;
    case 'n': if (state.index < last) play(state.index + 1); break;
    case 'p': if (state.index > 0) play(state.index - 1); break;
    case 'Escape':
      if (fullscreen) return;
      $('#watch-back').click();
      break;
    default: return;
  }
  event.preventDefault();
}
