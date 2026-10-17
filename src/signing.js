// Short-lived signatures for URLs the browser has to fetch through us.
//
// The subtitle converter and the optional media proxy both take a URL as a
// query parameter and go and fetch it. Left unsigned that is an open relay:
// anyone who finds the endpoint can make the server fetch anything, from
// inside whatever network it is running on. Signing means the only URLs it
// will fetch are ones it chose itself a few hours earlier.
//
// The key is the same AES key the session store uses, so there is nothing
// extra to configure.

import crypto from 'node:crypto';
import { ready } from './sessions.js';

const DEFAULT_TTL_MS = 12 * 3_600_000;

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

export async function sign(url, ttlMs = DEFAULT_TTL_MS) {
  const key = await ready();
  const expires = Date.now() + ttlMs;
  const payload = base64url(`${expires}:${url}`);
  const mac = base64url(crypto.createHmac('sha256', key).update(payload).digest()).slice(0, 27);
  return { u: payload, s: mac };
}

// Returns the URL, or null. Never throws — a bad signature is a 403, not a
// stack trace.
export async function verify(payload, mac) {
  try {
    const key = await ready();
    const expected = base64url(crypto.createHmac('sha256', key).update(String(payload)).digest()).slice(0, 27);
    const given = Buffer.from(String(mac || ''));
    if (given.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(given, Buffer.from(expected))) return null;

    const decoded = Buffer.from(String(payload), 'base64url').toString('utf8');
    const separator = decoded.indexOf(':');
    const expires = Number(decoded.slice(0, separator));
    const url = decoded.slice(separator + 1);

    if (!Number.isFinite(expires) || Date.now() > expires) return null;
    if (!/^https?:\/\//i.test(url)) return null;
    return url;
  } catch {
    return null;
  }
}

// Convenience: a ready-to-use path for one of our proxy routes.
export async function signedPath(route, url, ttlMs) {
  const { u, s } = await sign(url, ttlMs);
  return `${route}?u=${u}&s=${s}`;
}
