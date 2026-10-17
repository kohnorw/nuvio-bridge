// Restreaming: the debrid link, passed through this server to the browser.
//
// This is the fast path, and where possible it is the right one. A file that
// is already an MP4 of H.264 and AAC is something every browser plays as it
// stands — there is nothing to convert, and converting it would burn CPU and
// disk to produce what the file already was. All it actually needs is to
// arrive from an origin the browser will accept.
//
// That is what this does, and it fixes three things at once:
//
//   Mixed content   The page is on https and the addon returned an http link.
//                   Every browser blocks that outright.
//   Hotlinking      Some hosts check Referer or Origin and refuse anything
//                   that didn't come from their own page.
//   Expiry          A debrid link can be tied to the IP that resolved it,
//                   which is the server, not the person watching.
//
// Range requests are forwarded verbatim in both directions. That is the whole
// trick: it means the browser seeks the file natively, with its own scrubber
// and no segments, which is something the HLS path cannot offer.
//
// The cost is real — every byte of video crosses this container — but it is
// the same bytes ffmpeg would have read anyway, minus the conversion.

import { Readable } from 'node:stream';

// On by default now: this is a normal playback path rather than a rescue.
// MEDIA_PROXY=false forces everything through ffmpeg instead.
export const enabled = process.env.MEDIA_PROXY !== 'false';

const PASS_TO_ORIGIN = ['range', 'if-range', 'user-agent'];
const PASS_TO_CLIENT = [
  'content-type', 'content-length', 'content-range', 'accept-ranges',
  'last-modified', 'etag',
];

export async function pipe(url, req, res) {
  const headers = {};
  for (const name of PASS_TO_ORIGIN) {
    const value = req.get(name);
    if (value) headers[name] = value;
  }

  const upstream = await fetch(url, {
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers,
    redirect: 'follow',
  });

  res.status(upstream.status);
  for (const name of PASS_TO_CLIENT) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  // Resolved links are per-session and shouldn't be held by an intermediary.
  res.setHeader('cache-control', 'private, no-store');

  if (req.method === 'HEAD' || !upstream.body) return res.end();

  const body = Readable.fromWeb(upstream.body);
  // The browser aborts the request on every seek, which lands here as an
  // error on a pipe nobody is reading any more. It is normal, not a fault.
  body.on('error', () => res.destroy());
  res.on('close', () => body.destroy());
  body.pipe(res);
  return undefined;
}
