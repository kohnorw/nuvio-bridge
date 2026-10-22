// Catch-up (archive) links, ported from NuvioPlusIPTV's CatchupUrlBuilder.
//
// Covers the formats providers actually use: default / append (a template in
// catchup-source), shift, flussonic and Xtream Codes (/timeshift/). Xtream
// links are written in the *server's* clock, so the server's time zone (from
// player_api.php) is used; without it, the viewer's own.

const MIN = 60_000;

export function isAvailable(catchup, programStartMs, nowMs = Date.now()) {
  if (!catchup) return false;
  if (programStartMs >= nowMs) return false;
  const maxAge = Math.max(1, catchup.days || 1) * 24 * 3_600_000;
  return nowMs - programStartMs <= maxAge;
}

// "yyyy-MM-dd:HH-mm" in a time zone (IANA name, or the given fallback).
function stamp(ms, zone) {
  const parts = {};
  try {
    for (const p of new Intl.DateTimeFormat('en-US', {
      timeZone: zone || 'UTC', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(ms))) parts[p.type] = p.value;
  } catch {
    return stamp(ms, 'UTC');
  }
  return `${parts.year}-${parts.month}-${parts.day}:${parts.hour}-${parts.minute}`;
}

function zoneOk(zone) {
  if (!zone) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

const XTREAM_LIVE = /^(https?:\/\/[^/]+)\/(?:live\/)?([^/]+)\/([^/]+)\/(\d+)(\.[a-z0-9]+)?(\?.*)?$/i;

export function build(liveUrl, catchup, startMs, stopMs, {
  nowMs = Date.now(), preferHls = false, serverTimezone = '', clientTimezone = '',
} = {}) {
  const correction = Math.round((catchup.correctionHours || 0) * 3_600_000);
  const startC = startMs + correction;
  const start = Math.floor(startC / 1000);
  const end = Math.floor((stopMs + correction) / 1000);
  const now = Math.floor(nowMs / 1000);
  const duration = Math.max(60, end - start);
  const zone = zoneOk(serverTimezone) ? serverTimezone : (zoneOk(clientTimezone) ? clientTimezone : 'UTC');
  const xtreamGuess = () => xtream(liveUrl, startC, duration, preferHls, zone);
  const src = catchup.source;
  switch (catchup.type) {
    case 'append': return src ? liveUrl + fill(src, start, end, now, duration, zone) : null;
    case 'default':
      if (!src) return xtreamGuess() || shift(liveUrl, start, now);
      if (/^http/i.test(src)) return fill(src, start, end, now, duration, zone);
      return liveUrl + fill(src, start, end, now, duration, zone);
    case 'shift': case 'timeshift':
      return src ? shift(liveUrl, start, now) : (xtreamGuess() || shift(liveUrl, start, now));
    case 'flussonic': case 'flussonic-hls': case 'flussonic-ts': case 'fs':
      return flussonic(liveUrl, start, duration);
    case 'xc': case 'xtream':
      return xtream(liveUrl, startC, duration, preferHls, zone);
    default:
      return src ? fill(src, start, end, now, duration, zone) : null;
  }
}

function shift(url, start, now) {
  return `${url}${url.includes('?') ? '&' : '?'}utc=${start}&lutc=${now}`;
}

function flussonic(url, start, duration) {
  const m = /^(https?:\/\/[^/]+)\/(.*)\/([^/?]*)(\?.*)?$/.exec(url);
  if (!m) return null;
  const [, host, stream, file, query = ''] = m;
  if (file.endsWith('.m3u8') || !file) {
    const base = file.replace(/\.m3u8$/, '') || 'index';
    return `${host}/${stream}/${base}-${start}-${duration}.m3u8${query}`;
  }
  return `${host}/${stream}/timeshift_abs-${start}.ts${query}`;
}

function xtream(url, startMs, duration, preferHls, zone) {
  const m = XTREAM_LIVE.exec(url);
  if (!m) return null;
  const [, host, user, pass, id, origExt, query = ''] = m;
  const ext = preferHls ? '.m3u8' : (origExt || '.ts');
  const minutes = Math.max(1, Math.floor(duration / 60));
  return `${host}/timeshift/${user}/${pass}/${minutes}/${stamp(startMs, zone)}/${id}${ext}${query}`;
}

// Other ways to ask for the same replay, tried in turn when the first fails:
// TS instead of HLS, only what has aired, just the show's length, the older
// timeshift.php form, and the time in the other clock.
export function alternatives(url, { serverTimezone = '', clientTimezone = '', showMinutes = null, airedMinutes = null } = {}) {
  const qi = url.indexOf('?');
  const path = qi >= 0 ? url.slice(0, qi) : url;
  const query = qi >= 0 ? url.slice(qi) : '';
  const m = /^(https?:\/\/[^/]+)\/timeshift\/([^/]+)\/([^/]+)\/(\d+)\/([0-9-]+:[0-9-]+)\/(\d+)(\.[a-z0-9]+)?$/i.exec(path);
  if (!m) { const ts = tsFallback(url); return ts ? [ts] : []; }
  const [, host, user, pass, minutes, st, id, ext = ''] = m;
  const isHls = ext.toLowerCase() === '.m3u8';
  const other = isHls ? '.ts' : '.m3u8';
  const same = ext || '.ts';
  const out = new Set();
  out.add(`${host}/timeshift/${user}/${pass}/${minutes}/${st}/${id}${other}${query}`);
  const mins = Number(minutes);
  const aired = airedMinutes != null ? Math.max(1, airedMinutes) : null;
  if (aired != null && aired < mins) {
    out.add(`${host}/timeshift/${user}/${pass}/${aired}/${st}/${id}${same}${query}`);
    out.add(`${host}/timeshift/${user}/${pass}/${aired}/${st}/${id}${other}${query}`);
  }
  const short = showMinutes != null ? Math.max(1, showMinutes) : null;
  if (short != null && short < mins) {
    out.add(`${host}/timeshift/${user}/${pass}/${short}/${st}/${id}${same}${query}`);
    out.add(`${host}/timeshift/${user}/${pass}/${short}/${st}/${id}${other}${query}`);
  }
  out.add(`${host}/streaming/timeshift.php?username=${user}&password=${pass}&stream=${id}&start=${st}&duration=${minutes}`);
  // The same time written in the other clock (server vs viewer).
  const used = zoneOk(serverTimezone) ? serverTimezone : (zoneOk(clientTimezone) ? clientTimezone : 'UTC');
  const startMs = parseStamp(st, used);
  if (startMs != null) {
    const alt = stamp(startMs, zoneOk(serverTimezone) ? (zoneOk(clientTimezone) ? clientTimezone : 'UTC') : 'UTC');
    if (alt !== st) out.add(`${host}/timeshift/${user}/${pass}/${minutes}/${alt}/${id}${same}${query}`);
  }
  out.delete(url);
  return [...out];
}

// Inverse of stamp(): the instant a "yyyy-MM-dd:HH-mm" means in a zone.
function parseStamp(st, zone) {
  const m = /^(\d{4})-(\d{2})-(\d{2}):(\d{2})-(\d{2})$/.exec(st);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Correct by the zone's offset at that moment (twice, for DST edges).
  let t = guess;
  for (let i = 0; i < 2; i += 1) {
    const s = stamp(t, zone);
    const n = /^(\d{4})-(\d{2})-(\d{2}):(\d{2})-(\d{2})$/.exec(s);
    const shown = Date.UTC(+n[1], +n[2] - 1, +n[3], +n[4], +n[5]);
    t += guess - shown;
  }
  return t;
}

export function tsFallback(url) {
  const qi = url.indexOf('?');
  const path = qi >= 0 ? url.slice(0, qi) : url;
  if (!path.includes('/timeshift/') || !/\.m3u8$/i.test(path)) return null;
  return path.slice(0, -5) + '.ts' + (qi >= 0 ? url.slice(qi) : '');
}

export function fill(template, start, end, now, duration, zone = 'UTC') {
  let out = template;
  out = out.replace(/\$?\{(utc|start|utcend|end|lutc|now|timestamp):([^}]+)\}/g, (_, k, pattern) => {
    const epoch = (k === 'utcend' || k === 'end') ? end : (k === 'lutc' || k === 'now' || k === 'timestamp') ? now : start;
    return formatPattern(pattern, epoch);
  });
  out = out.replace(/\$?\{duration:(\d+)\}/g, (_, d) => String(Math.floor(duration / Math.max(1, Number(d) || 1))));
  out = out.replace(/\$?\{offset:(\d+)\}/g, (_, d) => String(Math.floor((now - start) / Math.max(1, Number(d) || 1))));
  const simple = { utc: start, start, timestamp: now, utcend: end, end, lutc: now, now, duration, offset: now - start };
  for (const [k, v] of Object.entries(simple)) out = out.split(`\${${k}}`).join(String(v)).split(`{${k}}`).join(String(v));
  // Bare {Y}{m}{d}{H}{M}{S}: the programme start in local (server/viewer) time.
  const s = stamp(start * 1000, zone);
  const [date, time] = s.split(':');
  const [Y, mo, d] = date.split('-');
  const [H, Mi] = time.split('-');
  return out.replace(/\{Y\}/g, Y).replace(/\{m\}/g, mo).replace(/\{d\}/g, d)
    .replace(/\{H\}/g, H).replace(/\{M\}/g, Mi).replace(/\{S\}/g, '00');
}

function formatPattern(pattern, epochSec) {
  const d = new Date(epochSec * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  const map = {
    Y: String(d.getUTCFullYear()), m: p2(d.getUTCMonth() + 1), d: p2(d.getUTCDate()),
    H: p2(d.getUTCHours()), M: p2(d.getUTCMinutes()), S: p2(d.getUTCSeconds()),
  };
  return [...pattern].map((c) => map[c] ?? c).join('');
}

export const HLS_RETRY_MS = 7 * 24 * 3_600_000;
export const CONTINUE_MS = 3 * 3_600_000;
export { MIN };
