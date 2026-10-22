// Streaming XMLTV reader, ported from NuvioPlusIPTV's XmltvParser.
//
// Provider guides run to hundreds of megabytes, so the file is read as a
// stream and only programmes inside the time window, for channels that match
// the playlist, are kept. Forgiving like the app's: stray entities, unclosed
// <programme> tags and a file cut off half way all keep what was read.

import zlib from 'node:zlib';
import { Readable } from 'node:stream';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  if (!s || !s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return ''; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const strip = (s) => decode(String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')).trim();

function attrs(tag) {
  const out = {};
  const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? '');
  return out;
}

function firstText(body, name) {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(body);
  return m ? strip(m[1]) : null;
}

// "YYYYMMDDhhmmss +zzzz" (seconds and offset optional).
export function parseTime(v) {
  if (!v) return null;
  const m = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(v);
  if (!m) return null;
  let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (m[7]) {
    const sign = m[7][0] === '-' ? -1 : 1;
    ms -= sign * (Number(m[7].slice(1, 3)) * 3_600_000 + Number(m[7].slice(3, 5)) * 60_000);
  }
  return ms;
}

export function cleanEpisode(raw) {
  const t = String(raw || '').trim();
  if (!t || t.length > 24) return null;
  const letters = (t.match(/\p{L}/gu) || []).length;
  const digits = (t.match(/\d/g) || []).length;
  if (!digits) return t;
  if (!letters && digits > 4) return null;
  if (/\d{5,}/.test(t)) return null;
  const s = /\bS(?:eason)?\s*(\d+)/i.exec(t);
  if (s && Number(s[1]) >= 100) return null;
  return t;
}

function formatEpisode(system, raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (system === 'xmltv_ns') {
    const parts = text.split('.');
    const season = parseInt(parts[0]?.split('/')[0], 10);
    const ep = parseInt(parts[1]?.split('/')[0], 10);
    if (Number.isFinite(season) && season >= 100) return null;
    if (Number.isFinite(season) && Number.isFinite(ep)) return `S${season + 1} E${ep + 1}`;
    if (Number.isFinite(ep)) return `E${ep + 1}`;
    return null;
  }
  if (system && system !== 'onscreen') return null;
  return cleanEpisode(text);
}

function readProgramme(open, body, winStart, winEnd) {
  const a = attrs(open);
  const start = parseTime(a.start);
  const stop = parseTime(a.stop);
  if (start == null || stop == null || stop <= winStart || start >= winEnd || stop <= start) return null;
  const title = firstText(body, 'title');
  const sub = firstText(body, 'sub-title');
  const desc = firstText(body, 'desc');
  const category = firstText(body, 'category');
  let episode = null;
  const epRe = /<episode-num\b([^>]*)>([\s\S]*?)<\/episode-num>/gi;
  let m;
  while ((m = epRe.exec(body))) {
    const sys = attrs(m[1])['system'];
    if (sys === 'onscreen' || !episode) episode = formatEpisode(sys, strip(m[2])) || episode;
  }
  const icon = /<icon\b[^>]*\bsrc\s*=\s*"([^"]*)"/i.exec(body)?.[1] || null;
  const date = firstText(body, 'date');
  let year = /^\d{4}$/.test(date || '') ? Number(date) : null;
  if (!year) year = Number(/\((19\d{2}|20\d{2})\)/.exec(`${title} ${desc}`)?.[1]) || null;
  const fullDesc = [sub, desc].filter(Boolean).join('\n') || null;
  const p = { s: start, e: stop, t: (title || '').trim() || 'No information' };
  if (fullDesc) p.d = fullDesc.slice(0, 1200);
  if (category) p.c = category.slice(0, 80);
  if (episode) p.ep = episode;
  if (icon) p.i = decode(icon);
  if (year) p.y = year;
  return p;
}

// input: a Node readable of the raw (possibly gzipped) bytes.
// keep(id, channel): whether to keep programmes for that guide channel id;
// asked once per id (channel is the <channel> entry, when one was listed).
export async function parse(input, { windowStart, windowEnd, keep }) {
  const channels = new Map();
  const programs = new Map();
  const answers = new Map();
  let error = null;
  let buf = '';

  const source = await maybeGunzip(input);
  source.setEncoding('utf8');

  const want = (id) => {
    if (!answers.has(id)) answers.set(id, Boolean(keep(id, channels.get(id))));
    return answers.get(id);
  };

  const consume = (final) => {
    let pos = 0;
    for (;;) {
      const lt = buf.indexOf('<', pos);
      if (lt < 0) { pos = buf.length; break; }
      if (buf.startsWith('<programme', lt)) {
        const gt = buf.indexOf('>', lt);
        if (gt < 0) break;
        const open = buf.slice(lt, gt + 1);
        if (open.endsWith('/>')) { pos = gt + 1; continue; }
        let close = buf.indexOf('</programme>', gt);
        const next = buf.indexOf('<programme', gt);
        let endAt;
        if (close >= 0 && (next < 0 || close < next)) endAt = close + 12;
        else if (next >= 0) { close = next; endAt = next; } // never closed: ends at the next one
        else if (final) { close = buf.length; endAt = buf.length; } else break;
        const id = attrs(open).channel;
        if (id && want(id)) {
          const p = readProgramme(open, buf.slice(gt + 1, close), windowStart, windowEnd);
          if (p) { if (!programs.has(id)) programs.set(id, []); programs.get(id).push(p); }
        }
        pos = endAt;
      } else if (buf.startsWith('<channel', lt) && /^<channel[\s>]/.test(buf.slice(lt, lt + 9))) {
        const close = buf.indexOf('</channel>', lt);
        if (close < 0) { if (final) { pos = buf.length; } break; }
        const block = buf.slice(lt, close);
        const gt = block.indexOf('>');
        const id = attrs(block.slice(0, gt + 1)).id;
        if (id) {
          const names = [];
          const re = /<display-name\b[^>]*>([\s\S]*?)<\/display-name>/gi;
          let m;
          while ((m = re.exec(block))) { const n = strip(m[1]); if (n) names.push(n); }
          const icon = /<icon\b[^>]*\bsrc\s*=\s*"([^"]*)"/i.exec(block)?.[1];
          channels.set(id, { id, names, icon: icon ? decode(icon) : null });
        }
        pos = close + 10;
      } else {
        pos = lt + 1;
      }
    }
    buf = buf.slice(pos);
  };

  try {
    for await (const chunk of source) {
      buf += chunk;
      if (buf.length > 256 * 1024) consume(false);
      if (buf.length > 32 * 1024 * 1024) throw new Error('A single guide entry is too large');
    }
    consume(true);
  } catch (err) {
    error = err.message;
  }
  for (const list of programs.values()) list.sort((x, y) => x.s - y.s);
  return { channels, programs, error };
}

async function maybeGunzip(input) {
  const it = input[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return Readable.from([]);
  const head = Buffer.from(first.value);
  const rest = Readable.from((async function* () {
    yield head;
    for (;;) { const n = await it.next(); if (n.done) return; yield n.value; }
  })());
  if (head[0] === 0x1f && head[1] === 0x8b) return rest.pipe(zlib.createGunzip());
  return rest;
}
