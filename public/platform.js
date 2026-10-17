// What this device is, and how it wants to be handed a stream.
//
// The server makes the same guess from the User-Agent, but only this side can
// tell an iPad from a Mac — iPadOS has reported itself as "Macintosh" since
// 13, and the only reliable tell is that it has a touchscreen. So the client
// decides and sends its answer along with every play request.
//
// The choice is kept in localStorage rather than on the account, because it is
// a property of the device, not the person: the same account wants VLC on the
// phone and the browser player on the desktop, and syncing that would make one
// of the two wrong.

const STORAGE_KEY = 'nuvio.playerTarget';

export const device = detect();

// What the server can do, from /api/session.
const server = { transcode: false };


function detect() {
  const ua = navigator.userAgent;
  const touch = (navigator.maxTouchPoints || 0) > 1;

  let os = 'unknown';
  if (/iPhone|iPod/.test(ua)) os = 'ios';
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) os = 'ios';
  else if (/Android/.test(ua)) os = 'android';
  else if (/Windows/.test(ua)) os = 'windows';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'macos';
  else if (/CrOS/.test(ua)) os = 'chromeos';
  else if (/Linux/.test(ua)) os = 'linux';

  const mobile = os === 'ios' || os === 'android';
  return {
    os,
    touch,
    mobile,
    desktop: !mobile,
    // Intent URLs are a Chromium feature. Firefox on Android ignores them, so
    // it gets the same treatment as a desktop: play here, or download the file.
    intents: os === 'android' && /Chrome|SamsungBrowser|Edg/.test(ua),
    standalone: window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true,
  };
}

// Every option this device can actually carry out, in the order they should be
// offered. There is no point showing an Android intent on a Mac or a .m3u
// download on an iPhone, where nothing can open it.
export function targets() {
  // The built-in player is the default everywhere. VLC and the others are
  // opt-in: choose one here and it becomes this device's default.
  const auto = {
    value: 'auto',
    label: 'Built-in player',
    hint: server.transcode
      ? 'Plays everything here, with audio and subtitle choices. The server converts what the browser can’t.'
      : 'Plays here. MP4 and WebM work; MKV usually needs VLC.',
  };
  const list = [auto];

  if (device.os === 'ios') {
    list.push({
      value: 'vlc',
      label: 'VLC',
      hint: 'Plays anything, including MKV. VLC returns here when it finishes.',
    });
  } else if (device.os === 'android') {
    list.push({
      value: 'vlc',
      label: 'VLC',
      hint: device.intents
        ? 'Opens VLC directly. Plays anything, including MKV.'
        : 'This browser ignores app links, so VLC is reached through a .m3u file.',
    });
    list.push({
      value: 'player-chooser',
      label: 'Ask which app',
      hint: 'Android offers every video player installed — MX Player, Just Player, Kodi.',
    });
    list.push({
      value: 'download',
      label: 'VLC (.m3u file)',
      hint: 'Downloads a one-line playlist. Works in every Android browser.',
    });
  } else {
    if (hasLauncher()) {
      list.push({
        value: 'vlc',
        label: 'VLC',
        hint: launcherInstalled()
          ? 'Opens a vlc:// link with the stream. Nothing is downloaded.'
          : 'Opens a vlc:// link with the stream. Needs a one-time launcher setup.',
      });
    }
    list.push({
      value: 'download',
      label: 'VLC (.m3u file)',
      hint: 'Downloads a one-line playlist. VLC opens it — no setup needed.',
    });
  }

  return list;
}

export function describe(target) {
  switch (target) {
    case 'vlc': return 'VLC';
    case 'player-chooser': return 'your chosen app';
    case 'download': return 'VLC via a .m3u file';
    case 'browser': return 'the built-in player';
    default: return 'the default';
  }
}

export function stored() {
  const value = localStorage.getItem(STORAGE_KEY);
  return targets().some((t) => t.value === value) ? value : 'auto';
}

export function choose(value) {
  localStorage.setItem(STORAGE_KEY, value);
}

// What `auto` means here. Phones go to VLC because it plays the MKV files most
// releases actually are — and on iOS it is the only thing that can play them
// at all. Desktops open the browser player, which needs no app and no file
// association; when the codec defeats it the page says so and offers the file.
// What the server can do, from /api/session. With Lumen (ffmpeg) there, the
// page plays everything, so Automatic means the browser on every device and
// VLC is the fallback.
export function setServerCaps(caps = {}) {
  server.transcode = Boolean(caps.transcode);
}
export function serverConverts() {
  return server.transcode;
}

export function resolve(target = stored()) {
  if (target !== 'auto') return target;
  return 'browser';
}

// `vlc` doesn't mean the same mechanism on every device, and the difference
// matters when something goes wrong — so the settings screen can say which.
export function mechanism() {
  const target = resolve();
  if (target === 'vlc') {
    if (device.os === 'ios') return 'vlc-x-callback://';
    if (device.os === 'android') return 'Android app link';
    return 'vlc:// link';
  }
  if (target === 'player-chooser') return 'Android app chooser';
  if (target === 'download') return '.m3u file';
  return 'in-page player';
}

// Adds the two parameters every play route wants: what to open it with, and
// what this device is.
export function playLink(path, params = {}) {
  const query = new URLSearchParams(params);
  query.set('target', resolve());
  query.set('os', device.os);
  return `${path}${path.includes('?') ? '&' : '?'}${query}`;
}

// Handing off to another app is a navigation we never find out the result of:
// if the app is missing, the browser either shows its own error or silently
// does nothing, and there is no event either way. So we watch the clock — if
// this page is still in front of the person a couple of seconds later, the
// hand-off didn't happen, and it's time to offer something else.
const HANDOFF_GRACE_MS = 2500;

// Everything worth trying when the first attempt did nothing, in the order
// worth trying it, for this device.
export function alternatives() {
  if (device.os === 'ios') {
    return [
      { target: 'vlc-legacy', label: "Try VLC's older link", primary: true },
      { target: 'browser', label: 'Play in this browser' },
    ];
  }
  if (device.os === 'android') {
    return [
      { target: 'player-chooser', label: 'Choose an app', primary: true },
      { target: 'download', label: 'Download .m3u for VLC' },
      { target: 'browser', label: 'Play in this browser' },
    ];
  }
  if (hasLauncher()) {
    return [
      { href: '/vlc-setup', label: launcherInstalled() ? 'Set up the VLC launcher again' : 'Set up VLC', primary: true },
      { target: 'download', label: 'Download .m3u instead' },
      { target: 'browser', label: 'Play in this browser' },
    ];
  }
  return [
    { target: 'download', label: 'Download .m3u for VLC', primary: true },
    { target: 'browser', label: 'Play in this browser' },
  ];
}

export function watchHandoff(onFailure) {
  if (resolve() === 'browser') return;

  let settled = false;
  const stop = () => { settled = true; cleanup(); };
  const cleanup = () => {
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', stop);
    window.removeEventListener('blur', stop);
  };
  const onHide = () => { if (document.hidden) stop(); };

  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', stop);
  window.addEventListener('blur', stop);

  setTimeout(() => {
    cleanup();
    if (!settled && !document.hidden) onFailure();
  }, HANDOFF_GRACE_MS);
}

// ------------------------------------------------------------ VLC launcher
//
// Desktop VLC can only be started from a page once the Nuvio launcher is
// installed (see /vlc-setup). There's no way to ask the OS whether it is, so
// the setup page records that the person says it is, and a hand-off that
// leaves this page in front is treated as the launcher missing.

const LAUNCHER_KEY = 'nuvio.vlcLauncher';

export function hasLauncher() {
  return ['windows', 'macos', 'linux'].includes(device.os);
}

export function launcherInstalled() {
  try { return localStorage.getItem(LAUNCHER_KEY) === '1'; } catch { return false; }
}

// vlc://<stream>, with anything outside the launcher's accepted character
// set percent-encoded (it must match STREAM_PATTERN in src/vlclauncher.js).
export function vlcLink(url) {
  const href = new URL(url, location.origin).href;
  const safe = href.replace(/[^A-Za-z0-9._~:/?#@!$&()*+,;=%-]/g,
    (ch) => (ch === "'" ? '%27' : encodeURIComponent(ch)));
  return `vlc://${safe}`;
}

// Open a vlc:// link. `onFailure` runs if this page is still in front after
// the grace period, which is what happens when nothing handles vlc:.
export function openInVlc(streamUrl, onFailure) {
  let settled = false;
  const stop = () => { settled = true; cleanup(); };
  const onHide = () => { if (document.hidden) stop(); };
  const cleanup = () => {
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('blur', stop);
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('blur', stop);
  const link = vlcLink(streamUrl);
  // Chromium leaves the page alone on an external-scheme navigation, handled
  // or not. Firefox and Safari replace it with an error page when nothing is
  // registered, so they get a hidden iframe, which fails quietly.
  let frame = null;
  if (/Chrome|Edg/.test(navigator.userAgent)) {
    location.href = link;
  } else {
    frame = document.createElement('iframe');
    frame.style.display = 'none';
    frame.src = link;
    document.body.append(frame);
  }
  setTimeout(() => {
    cleanup();
    frame?.remove();
    if (!settled && !document.hidden) onFailure?.();
  }, HANDOFF_GRACE_MS + 1500);
}
