// Where the keyframes are in a Matroska file, without reading the file.
//
// A remux copies the video untouched, so it can only cut a segment where the
// source has a keyframe. With a playlist of equal two-second segments, that
// meant every segment was cut somewhere other than where the playlist said it
// started — off by up to a whole segment, by a different amount after every
// seek, and starting on a frame that can't be decoded on its own. hls.js
// papers over it by trusting the timestamps; Safari's own player (every
// iPhone and iPad) trusts the playlist, so on iOS the picture stalled after
// seeks and the subtitles ran early or late by whatever the error was.
//
// The cure is a playlist built from the real keyframes. Matroska lists them
// in its Cues element — the index players use to seek — which is a few tens of
// kilobytes even for a long film. It is found through the SeekHead at the
// start of the file and fetched with two or three range requests.
//
// Anything unexpected (not Matroska, no Cues, a host that ignores Range)
// returns null and the caller keeps the fixed grid.

const TIMEOUT_MS = Number(process.env.TRANSCODE_KEYFRAME_TIMEOUT_MS || 8000);
const HEAD_BYTES = 256 * 1024;
const MAX_CUES_BYTES = 16 * 1024 * 1024;

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  Cluster: 0x1f43b675,
};

async function range(url, start, length, signal) {
  const res = await fetch(url, {
    headers: { range: `bytes=${start}-${start + length - 1}`, 'user-agent': 'Mozilla/5.0' },
    redirect: 'follow',
    signal,
  });
  // A 200 is the whole file on its way. Don't read it.
  if (res.status !== 206) {
    res.body?.cancel().catch(() => {});
    throw new Error(`range request answered ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// EBML variable-length integers. An ID keeps its length marker; a size
// doesn't. A size of all ones means "unknown" (a live-written Segment).
function vint(buf, pos, keepMarker) {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len += 1;
  if (len > 8 || pos + len > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let i = 1; i < len; i += 1) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

function header(buf, pos) {
  const id = vint(buf, pos, true);
  if (!id) return null;
  const size = vint(buf, pos + id.len, false);
  if (!size) return null;
  return { id: id.value, size: size.unknown ? Infinity : size.value, start: pos, data: pos + id.len + size.len };
}

function uint(buf, start, size) {
  let value = 0;
  for (let i = 0; i < size; i += 1) value = value * 256 + buf[start + i];
  return value;
}

// Children of the element whose data runs [start, end).
function* children(buf, start, end) {
  let pos = start;
  while (pos < end) {
    const h = header(buf, pos);
    if (!h) return;
    yield h;
    if (!Number.isFinite(h.size)) return;
    pos = h.data + h.size;
  }
}

function parseSeekHead(buf, h, into) {
  for (const seek of children(buf, h.data, Math.min(buf.length, h.data + h.size))) {
    if (seek.id !== ID.Seek) continue;
    let id = null;
    let position = null;
    for (const field of children(buf, seek.data, seek.data + seek.size)) {
      if (field.id === ID.SeekID) id = uint(buf, field.data, field.size);
      if (field.id === ID.SeekPosition) position = uint(buf, field.data, field.size);
    }
    if (id !== null && position !== null && !into.has(id)) into.set(id, position);
  }
}

function parseInfo(buf, h) {
  for (const field of children(buf, h.data, h.data + h.size)) {
    if (field.id === ID.TimestampScale) return uint(buf, field.data, field.size);
  }
  return 1_000_000;
}

function parseTracks(buf, h) {
  for (const entry of children(buf, h.data, h.data + h.size)) {
    if (entry.id !== ID.TrackEntry) continue;
    let number = null;
    let type = null;
    for (const field of children(buf, entry.data, entry.data + entry.size)) {
      if (field.id === ID.TrackNumber) number = uint(buf, field.data, field.size);
      if (field.id === ID.TrackType) type = uint(buf, field.data, field.size);
    }
    if (type === 1 && number !== null) return number;
  }
  return null;
}

function parseCues(buf, start, end, videoTrack) {
  const times = [];
  for (const point of children(buf, start, end)) {
    if (point.id !== ID.CuePoint) continue;
    let time = null;
    let video = videoTrack === null;
    for (const field of children(buf, point.data, point.data + point.size)) {
      if (field.id === ID.CueTime) time = uint(buf, field.data, field.size);
      if (field.id === ID.CueTrackPositions && !video) {
        for (const pos of children(buf, field.data, field.data + field.size)) {
          if (pos.id === ID.CueTrack && uint(buf, pos.data, pos.size) === videoTrack) video = true;
        }
      }
    }
    if (video && time !== null) times.push(time);
  }
  return times;
}

// Fetch one top-level element at an absolute offset, whole.
async function element(url, offset, signal, limit) {
  const head = await range(url, offset, 16, signal);
  const h = header(head, 0);
  if (!h || !Number.isFinite(h.size) || h.size > limit) return null;
  const buf = await range(url, offset, (h.data) + h.size, signal);
  return { buf, h: header(buf, 0) };
}

/**
 * Keyframe times of the video track, in seconds from the start of the file's
 * timeline, sorted. null when they can't be had cheaply.
 *
 * @param {string} url
 * @returns {Promise<number[]|null>}
 */
export async function matroska(url) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const buf = await range(url, 0, HEAD_BYTES, signal);
    const ebml = header(buf, 0);
    if (!ebml || ebml.id !== ID.EBML) return null;
    const segment = header(buf, ebml.data + ebml.size);
    if (!segment || segment.id !== ID.Segment) return null;
    const base = segment.data;

    const seeks = new Map();
    let scale = null;
    let videoTrack;
    let cues = null;

    for (const h of children(buf, base, buf.length)) {
      if (h.id === ID.Cluster) break;
      if (h.data + h.size > buf.length) {
        // Runs past what was read. Fine for Cues (fetched below by offset).
        if (h.id === ID.Cues) seeks.set(ID.Cues, h.start - base);
        break;
      }
      if (h.id === ID.SeekHead) parseSeekHead(buf, h, seeks);
      else if (h.id === ID.Info) scale = parseInfo(buf, h);
      else if (h.id === ID.Tracks) videoTrack = parseTracks(buf, h);
      else if (h.id === ID.Cues) cues = { buf, start: h.data, end: h.data + h.size };
    }

    if (scale === null && seeks.has(ID.Info)) {
      const info = await element(url, base + seeks.get(ID.Info), signal, 64 * 1024);
      if (info?.h?.id === ID.Info) scale = parseInfo(info.buf, info.h);
    }
    if (videoTrack === undefined && seeks.has(ID.Tracks)) {
      const tracks = await element(url, base + seeks.get(ID.Tracks), signal, 1024 * 1024);
      if (tracks?.h?.id === ID.Tracks) videoTrack = parseTracks(tracks.buf, tracks.h);
    }
    if (!cues) {
      if (!seeks.has(ID.Cues)) return null;
      const found = await element(url, base + seeks.get(ID.Cues), signal, MAX_CUES_BYTES);
      if (found?.h?.id !== ID.Cues) return null;
      cues = { buf: found.buf, start: found.h.data, end: found.h.data + found.h.size };
    }

    const ticks = parseCues(cues.buf, cues.start, cues.end, videoTrack ?? null);
    if (ticks.length < 2) return null;
    const seconds = (scale || 1_000_000) / 1e9;
    const times = [...new Set(ticks)].sort((a, b) => a - b).map((t) => t * seconds);
    return times;
  } catch {
    return null;
  }
}

/**
 * Segment start times for a remux: keyframes, merged so no segment is
 * shorter than `target` seconds. The first always starts at 0 — whatever
 * precedes the first keyframe belongs to it.
 *
 * @param {number[]} keyframes  film-time seconds, sorted
 * @param {number} duration
 * @param {number} target
 */
export function boundaries(keyframes, duration, target) {
  const out = [0];
  for (const t of keyframes) {
    if (t <= 0 || t >= duration - 0.5) continue;
    if (t - out[out.length - 1] >= target) out.push(t);
  }
  return out;
}
