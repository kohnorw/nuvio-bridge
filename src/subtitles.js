import zlib from 'node:zlib';

// Subtitles for the browser player.
//
// VLC reads SubRip happily; <track> does not — browsers want WebVTT and
// nothing else. Since almost every subtitle addon returns .srt, a subtitle
// menu in the web player means converting on the way through.
//
// Going through the server also solves a second problem: <track> is subject
// to CORS, and subtitle hosts rarely send the header. Served from our own
// origin, it's same-origin and the question doesn't arise.

// Subtitle files come in whatever encoding their author's editor used. Most
// are UTF-8; many older ones are Windows-1252 (Western European) or another
// legacy code page. Decoding strictly as UTF-8 first tells them apart: a
// legacy file is almost never valid UTF-8.
export function decode(bytes, url = '') {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Some hosts gzip the file itself.
  if (input[0] === 0x1f && input[1] === 0x8b) {
    try {
      // eslint-disable-next-line global-require
      return decode(new Uint8Array(zlib.gunzipSync(input)), url);
    } catch { /* not really gzip */ }
  }
  if (input[0] === 0xff && input[1] === 0xfe) return new TextDecoder('utf-16le').decode(input);
  if (input[0] === 0xfe && input[1] === 0xff) return new TextDecoder('utf-16be').decode(input);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    const cyrillic = /(rus|ukr|bul|srp|mkd|bel)|[._-](ru|uk|bg|sr)[._-]/i.test(url);
    const greek = /(gre|ell)|[._-]el[._-]/i.test(url);
    const encoding = cyrillic ? 'windows-1251' : greek ? 'windows-1253' : 'windows-1252';
    return new TextDecoder(encoding).decode(input);
  }
}

// SubRip to WebVTT, tidied:
//   - comma decimal separators become dots (the one real format difference)
//   - ASS-style override tags left in SRT files ({\an8}, {\i1}) are removed,
//     since a browser shows them as literal text
//   - cue numbers and blank-line noise are normalised
//   - timestamps with one- or two-digit milliseconds are padded to three,
//     which some browsers otherwise reject, dropping the cue
export function srtToVtt(text) {
  const body = String(text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{1,2}:\d{2}:\d{2})[,.](\d{1,3})/g, (_, hms, ms) => {
      const [h, m, sec] = hms.split(':');
      return `${h.padStart(2, '0')}:${m}:${sec}.${ms.padEnd(3, '0')}`;
    })
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `WEBVTT\n\n${body}\n`;
}

export function looksLikeVtt(text) {
  return /^\uFEFF?WEBVTT/.test(String(text).slice(0, 32));
}

// Anything we can turn into text. Archives and image-based formats (.sub/.idx,
// PGS) can't be shown by a browser at all, so they're filtered out of the menu
// rather than converted into something broken.
export function convertible(url) {
  return !/\.(zip|gz|rar|7z|sub|idx|sup)(\?|$)/i.test(String(url));
}

export function convert(text) {
  return looksLikeVtt(text) ? String(text).replace(/^\uFEFF/, '') : srtToVtt(text);
}

// The M3U carries the chosen subtitle as `input-slave=<url>`; the web player
// needs that same URL back out to build a <track>.
export function slaveUrlFrom(options = []) {
  for (const option of options) {
    const match = /^input-slave=(.+)$/.exec(option);
    if (match) return match[1];
  }
  return null;
}
