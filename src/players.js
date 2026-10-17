// Handing a stream URL to a player, on whatever the person is holding.
//
// There is no single mechanism that works everywhere, because the platforms
// disagree about what a web page is allowed to do:
//
//   iOS / iPadOS   VLC registers vlc-x-callback://, which takes an encoded url
//                  parameter and can bounce back to the page afterwards.
//   Android        Chrome supports intent:// URLs, which is the documented way
//                  to reach VLC (or any player, via a chooser).
//   Desktop        Nothing registers a scheme a browser will follow. What does
//                  work everywhere is a downloaded .m3u: VLC is the default
//                  handler for it on a normal install, so opening the file
//                  opens the stream.
//   Anywhere       The browser can often just play it — <video> handles MP4 and
//                  WebM natively, and HLS on Safari. No app needed.
//
// Each builder below returns a plain string. Deciding *which* one to use is
// the caller's job, because the answer depends on the device and on what the
// person chose in Settings.

export const TARGETS = ['auto', 'vlc', 'vlc-legacy', 'player-chooser', 'browser', 'download', 'copy'];

// ------------------------------------------------------------------- iOS

// The good one: properly encoded, and x-success brings Safari back here when
// playback ends.
export function iosVlc(mediaUrl, { filename, successUrl } = {}) {
  const params = new URLSearchParams({ url: mediaUrl });
  if (filename) params.set('filename', filename);
  if (successUrl) params.set('x-success', successUrl);
  return `vlc-x-callback://x-callback-url/stream?${params.toString()}`;
}

// The crude fallback: strip the scheme off the media URL and glue what's left
// onto vlc://. It breaks on URLs containing a query string, so it exists only
// for the rare build where x-callback misbehaves.
export function legacyVlc(mediaUrl) {
  return `vlc://${mediaUrl.replace(/^https?:\/\//i, '')}`;
}

// --------------------------------------------------------------- Android

// An intent: URL is scheme + host + path in front of the fragment, and the
// fragment carries the Intent description. Characters that would end the URL
// early or be read as an Intent separator have to be escaped, which is why
// this isn't just string concatenation: a debrid link with a query string full
// of semicolons would otherwise produce an Intent that means something else
// entirely.
function intentUrl(mediaUrl, { pkg, title, fallbackUrl } = {}) {
  const parsed = new URL(mediaUrl);
  const scheme = parsed.protocol.replace(':', '');
  const rest = `${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`
    .replace(/#/g, '%23')
    .replace(/;/g, '%3B');

  const parts = [
    'Intent',
    `scheme=${scheme}`,
    'action=android.intent.action.VIEW',
    `type=${mimeFor(parsed.pathname)}`,
  ];
  if (pkg) parts.push(`package=${pkg}`);
  // S. prefixes a string extra. VLC reads title as the name to display.
  if (title) parts.push(`S.title=${encodeURIComponent(sanitizeExtra(title))}`);
  // Chrome's own safety net: when the named package isn't installed it goes
  // here instead of showing an error. Without it, a phone without VLC gets a
  // dead tap and no explanation. Only set it when a package is named — with
  // a chooser there is nothing to fall back from.
  if (pkg && fallbackUrl) parts.push(`S.browser_fallback_url=${encodeURIComponent(fallbackUrl)}`);
  parts.push('end');

  return `intent://${rest}#${parts.join(';')}`;
}

// Android resolves an intent against the target app's own intent filters, so
// the type has to be one VLC actually declares. A binge playlist is an .m3u,
// and announcing that as video/* asks VLC to match a filter meant for video
// files — which is how a playlist ends up opening as nothing at all.
function mimeFor(pathname) {
  return /\.m3u8?$/i.test(pathname) ? 'audio/x-mpegurl' : 'video/*';
}

// Straight to VLC, no chooser.
export function androidVlc(mediaUrl, options = {}) {
  return intentUrl(mediaUrl, { ...options, pkg: 'org.videolan.vlc' });
}

// No package, so Android shows every installed video player — MX Player, Just
// Player, Kodi, whatever they use. Worth having: VLC is not the only option on
// Android the way it is on iOS.
export function androidAny(mediaUrl, options = {}) {
  return intentUrl(mediaUrl, options);
}

// Semicolons and hashes inside an extra would end it early.
function sanitizeExtra(text) {
  return String(text).replace(/[;#]/g, ' ').trim().slice(0, 120);
}

// ---------------------------------------------------------- what to use

// A rough guess at the device from the User-Agent, good enough to pick a
// default. The client overrides it with ?target= once it has run, because it
// can ask questions a UA string can't answer — but a bare navigation to /play
// with no target still has to do something sensible.
export function detect(userAgent = '') {
  const ua = String(userAgent);

  // iPadOS reports itself as a Mac. The giveaway is touch support, which the
  // server can't see — so a Mac UA with "Mobile" in it is the only hint here,
  // and the client corrects this properly on first load.
  if (/iPhone|iPod/i.test(ua)) return { os: 'ios', form: 'mobile' };
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile/i.test(ua))) {
    return { os: 'ios', form: 'tablet' };
  }
  if (/Android/i.test(ua)) {
    return { os: 'android', form: /Mobile/i.test(ua) ? 'mobile' : 'tablet' };
  }
  if (/Windows/i.test(ua)) return { os: 'windows', form: 'desktop' };
  if (/Macintosh|Mac OS X/i.test(ua)) return { os: 'macos', form: 'desktop' };
  if (/CrOS/i.test(ua)) return { os: 'chromeos', form: 'desktop' };
  if (/Linux/i.test(ua)) return { os: 'linux', form: 'desktop' };
  return { os: 'unknown', form: 'desktop' };
}

// What `auto` means on each platform.
//
// Phones and tablets go to VLC: it plays everything, including the MKV files
// most releases actually are, and on iOS it is the only way to play anything
// at all. Desktops open the browser player first — it needs no app and no
// file association, and when the codec isn't one the browser knows, the page
// says so and offers the .m3u instead.
export function defaultTarget(platform, { preferBrowser = false } = {}) {
  // With the server able to convert anything, the page plays everything
  // and VLC is the fallback rather than the default.
  // The built-in player on every platform. VLC is only used when a device
  // has chosen it in Settings, which sends target=vlc explicitly.
  void platform; void preferBrowser;
  return 'browser';
}

// Given a target and a device, the actual thing to do. `kind` tells the caller
// how to deliver it: a redirect into a scheme, a file to download, or a page
// of ours to open.
export function handoff(target, platform, mediaUrl, options = {}) {
  const chosen = target === 'auto' || !TARGETS.includes(target)
    ? defaultTarget(platform, options)
    : target;

  switch (chosen) {
    case 'vlc':
      if (platform.os === 'ios') return { kind: 'scheme', url: iosVlc(mediaUrl, options) };
      if (platform.os === 'android') return { kind: 'scheme', url: androidVlc(mediaUrl, options) };
      // Desktop VLC registers no scheme of its own. The Nuvio launcher adds
      // one (see vlclauncher.js); the page offers setup if nothing answers.
      return { kind: 'launcher', url: null };

    // The older scheme, offered by hand when x-callback does nothing. Some
    // VLC for iOS builds have shipped with it broken; this one has no query
    // string handling, so it only suits plain URLs, but it costs nothing to
    // have as a second thing to try.
    case 'vlc-legacy':
      return { kind: 'scheme', url: legacyVlc(mediaUrl) };

    case 'player-chooser':
      if (platform.os === 'android') return { kind: 'scheme', url: androidAny(mediaUrl, options) };
      if (platform.os === 'ios') return { kind: 'scheme', url: iosVlc(mediaUrl, options) };
      return { kind: 'download', url: null };

    case 'download':
      return { kind: 'download', url: null };

    case 'copy':
      return { kind: 'copy', url: mediaUrl };

    case 'browser':
    default:
      return { kind: 'browser', url: mediaUrl };
  }
}
