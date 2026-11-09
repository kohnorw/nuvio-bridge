// Profile pictures, kept on this server's disk.
//
// Left to the browser, each picture comes from Nuvio's storage, and a supporter
// avatar's signed link is different every time, so nothing ever caches. Here a
// picture gets one address for good (/avatar/<key>, from its path without the
// signature), is downloaded once and is served from /data after that.
//
// Only pictures in the Nuvio backend's own storage come through here. An
// address that points anywhere else stays as it is, so a profile can't make
// this server fetch a URL of its choosing.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = path.join(process.env.STATE_DIR || '/data', 'avatars');
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const REFRESH_AFTER_MS = 7 * 24 * 3600 * 1000;
const MAX_SOURCES = 2000;

const sources = new Map(); // key -> the address to download it from
const downloads = new Map(); // key -> the download under way

const fileOf = (key) => path.join(DIR, key);

// One file per picture: its content type, a newline, then the image.
async function download(key) {
  const url = sources.get(key);
  if (!url) return false;
  if (downloads.has(key)) return downloads.get(key);

  const job = (async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!res.ok || !type.startsWith('image/')) return false;
    const body = Buffer.from(await res.arrayBuffer());
    if (!body.length || body.length > MAX_BYTES) return false;

    await fs.mkdir(DIR, { recursive: true });
    const partial = `${fileOf(key)}.${process.pid}.tmp`;
    await fs.writeFile(partial, Buffer.concat([Buffer.from(`${type}\n`), body]));
    await fs.rename(partial, fileOf(key));
    return true;
  })().catch(() => false).finally(() => downloads.delete(key));

  downloads.set(key, job);
  return job;
}

// Starts fetching in the background if there's no copy or an old one, so the
// picture is usually already here by the time a browser asks for it.
async function warm(key) {
  const info = await fs.stat(fileOf(key)).catch(() => null);
  if (!info || Date.now() - info.mtimeMs > REFRESH_AFTER_MS) await download(key);
}

// The address to give the browser for a picture.
export function localUrl(upstream, backendUrl) {
  if (!upstream || !String(upstream).startsWith(`${backendUrl}/storage/v1/object/`)) return upstream;
  const key = crypto.createHash('sha256').update(String(upstream).split('?')[0]).digest('hex').slice(0, 32);
  if (sources.size >= MAX_SOURCES) sources.delete(sources.keys().next().value);
  // Always the newest address: a signed one expires.
  sources.set(key, upstream);
  warm(key).catch(() => {});
  return `/avatar/${key}`;
}

function parse(file) {
  const end = file.indexOf(0x0a);
  return end > 0 ? { type: file.subarray(0, end).toString(), body: file.subarray(end + 1) } : null;
}

export async function read(key) {
  if (!/^[a-f0-9]{32}$/.test(key)) return null;
  const file = await fs.readFile(fileOf(key)).catch(() => null);
  if (file) return parse(file);
  if (!await download(key)) return null;
  return parse(await fs.readFile(fileOf(key)));
}
