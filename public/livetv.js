// Live TV: the TiviMate-style guide from NuvioPlusIPTV, for the browser.
//
//   header     poster, show info (channel line with LIVE / CATCH-UP tags,
//              title, time · minutes left · episode · category, progress,
//              description) and the preview window
//   groups     slides in from the left: Search, Favorites, Recently
//              watched, All channels, then each playlist's categories with
//              their counts, under a foldable playlist heading
//   ruler      the day, half-hour marks, the clock, a tag at midnight
//   grid       a row per channel (number, logo, name, catch-up, favourite,
//              playing dot) and its shows over a two-hour window, with the
//              "now" line
//
// OK (Enter, or a click) on a channel previews it in the header; OK again
// goes full screen. On a show that has aired, on a channel with catch-up, it
// plays the replay. Right-click, long-press or M opens the channel menu.
//
// The data lives on the server (src/iptv.js), shared by every device on the
// account. Playlists and guides refresh there every three hours.

import * as platform from './platform.js?v=113';

const $ = (s, root = document) => root.querySelector(s);
const SLOT = 30 * 60_000;
const HOUR = 3_600_000;
const LIVE_MARK = /^\s*live\s*[:\-–|]\s*/i;
const NEW_MARK = /^\s*new\s*[:\-–|]\s*|\s*[([]\s*new\s*[)\]]\s*/i;

const SPECIAL = { SEARCH: '__search__', FAVORITES: '__fav__', RECENT: '__recent__', ALL: '__all__' };

const st = {
  ctx: null,                 // { api, post, toast, playWatch, openSettings, transcode }
  data: null,                // /api/iptv/channels
  byKey: new Map(),
  groupId: null,
  list: [],                  // channels in the group on screen
  row: 0,
  block: null,               // { s, e, p } under the cursor
  windowStart: 0,
  programs: new Map(),       // key -> sorted list
  loadedFor: new Map(),      // key -> [from, to] already asked for
  pending: new Set(),
  archiveAsked: new Set(),
  groupsOpen: false,
  playingKey: null,
  preview: null,             // { key, sid, hls, hb }
  searchQuery: '',
  searchHits: null,
  bound: false,
  visible: false,
  timer: null,
  lastClick: { key: null, at: 0 },
};

const settings = () => st.data?.settings || {};

// --------------------------------------------------------------- formatting

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], settings().use24HourClock
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { hour: 'numeric', minute: '2-digit' });
}
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
function dayClock(ms, now = Date.now()) {
  return sameDay(ms, now) ? clock(ms) : `${new Date(ms).toLocaleDateString([], { weekday: 'short' })} ${clock(ms)}`;
}
function minutesLeft(stop, now = Date.now()) {
  const m = Math.max(0, Math.floor((stop - now) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
}
function dayLabel(start, now = Date.now()) {
  if (sameDay(start, now)) return 'Today';
  if (sameDay(start, now + 86_400_000)) return 'Tomorrow';
  if (sameDay(start, now - 86_400_000)) return 'Yesterday';
  return new Date(start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function nextMidnight(ms) {
  const d = new Date(ms); d.setHours(24, 0, 0, 0); return d.getTime();
}
function marks(title) {
  let t = String(title || '');
  const live = LIVE_MARK.test(t);
  if (live) t = t.replace(LIVE_MARK, '');
  const isNew = NEW_MARK.test(t);
  if (isNew) t = t.replace(NEW_MARK, ' ').trim();
  return { title: t || title, live, isNew };
}
const pos = (a, b, ws, W) => `left:calc(${((a - ws) / W) * 100}% + 3px);width:calc(${((b - a) / W) * 100}% - 6px)`;
const floorSlot = (ms) => ms - (((ms % SLOT) + SLOT) % SLOT);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A channel's logo: the playlist's (or the guide's, per playlist), the other
// one if that fails to load, and the channel's initials if neither does.
function initials(name) {
  const words = String(name || '').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 3)).toUpperCase();
}
window.__ltvLogoFail = (img) => {
  const alt = img.dataset.alt;
  if (alt) { img.dataset.alt = ''; img.src = alt; return; }
  const box = img.parentElement;
  if (box) box.innerHTML = `<span class="ltv-initials">${esc(box.dataset.initials || '')}</span>`;
};
function logoHtml(ch, cls = 'ltv-logo') {
  const ini = esc(initials(ch.name));
  if (!ch.logo) return `<span class="${cls}" data-initials="${ini}"><span class="ltv-initials">${ini}</span></span>`;
  return `<span class="${cls}" data-initials="${ini}"><img src="${esc(ch.logo)}" data-alt="${esc(ch.logoAlt || '')}" alt="" loading="lazy" decoding="async" onerror="__ltvLogoFail(this)"></span>`;
}

function sizeOf() {
  switch (settings().guideSize) {
    case 'COMPACT': return { row: settings().showProgramTimes ? 44 : 32, scale: 0.93 };
    case 'LARGE': return { row: settings().showProgramTimes ? 64 : 47, scale: 1.2 };
    case 'XLARGE': return { row: settings().showProgramTimes ? 76 : 56, scale: 1.4 };
    default: return { row: settings().showProgramTimes ? 52 : 38, scale: 1 };
  }
}
// Phones show an hour across, so titles have room; TVs and desktops two.
const windowMs = () => (window.innerWidth < 900 ? HOUR : settings().guideSize === 'XLARGE' ? 90 * 60_000 : 2 * HOUR);

function catchupAvailable(ch, startMs, now = Date.now()) {
  if (!ch?.catchup || startMs >= now) return false;
  return now - startMs <= Math.max(1, ch.catchup.days || 1) * 86_400_000;
}

// --------------------------------------------------------------- setup

export function init(ctx) {
  st.ctx = ctx;
  if (st.bound) return;
  st.bound = true;
  bindGrid();
  $('#ltv-groups-toggle').addEventListener('click', () => toggleGroups());
  $('#ltv-earlier').addEventListener('click', () => shiftWindow(-SLOT));
  $('#ltv-later').addEventListener('click', () => shiftWindow(SLOT));
  $('#ltv-now').addEventListener('click', () => { resetToNow(); render(); });
  $('#ltv-empty-action').addEventListener('click', () => st.ctx.openSettings());
  $('#ltv-preview').addEventListener('click', () => {
    const ch = current();
    if (ch && st.preview?.key === ch.key) fullscreen(ch);
    else if (ch) previewChannel(ch);
  });
  $('#ltv-menu-backdrop').addEventListener('click', closeMenu);
  window.addEventListener('resize', () => { if (st.visible) render(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopPreview(); });
}

export async function show() {
  st.visible = true;
  document.body.classList.add('ltv-on');
  clearInterval(st.timer);
  // The clock, the now line and what's on move along by themselves.
  st.timer = setInterval(() => { if (st.visible) { renderHeader(); renderRuler(); renderNowLine(); renderRows(true); } }, 30_000);
  if (!st.windowStart) resetToNow();
  await load();
  setTimeout(() => $('#ltv-grid')?.focus({ preventScroll: true }), 50);
}

export function hide() {
  st.visible = false;
  document.body.classList.remove('ltv-on');
  clearInterval(st.timer);
  stopPreview();
  closeMenu();
}

export async function load({ quiet = false } = {}) {
  try {
    const data = await st.ctx.api('/api/iptv/channels');
    st.data = data;
    st.byKey = new Map(data.channels.map((c) => [c.key, c]));
    if (!st.groupId || !groupExists(st.groupId)) st.groupId = rememberedGroup() || defaultGroup();
    selectGroup(st.groupId, { keepRow: true });
    applyScale();
    render();
    if (data.status?.loading) {
      clearTimeout(st.statusPoll);
      st.statusPoll = setTimeout(() => { if (st.visible) load({ quiet: true }); }, 4000);
    } else if (quiet) {
      // An update just finished: listings may have changed.
      st.programs.clear(); st.loadedFor.clear();
      renderRows();
    }
  } catch (err) {
    if (!quiet) st.ctx.toast(err.message);
  }
}

function applyScale() {
  const ltv = $('#ltv');
  const { row, scale } = sizeOf();
  ltv.style.setProperty('--ltv-row', `${row}px`);
  ltv.style.setProperty('--ltv-scale', String(scale));
  const s = settings();
  let w = 16;
  if (s.showChannelNumbers) w += 52 * Math.max(1, scale);
  if (s.showChannelLogos) w += 72 * Math.max(1, scale);
  if (s.showChannelNames) w += 150 * Math.max(1, scale);
  ltv.style.setProperty('--ltv-chan-w', `${Math.max(80, w)}px`);
  ltv.classList.toggle('solid-highlight', Boolean(s.solidHighlight));
  ltv.classList.toggle('small-header', Boolean(s.smallHeader));
  ltv.classList.toggle('no-header', !s.showProgramDetails && !s.showPreview);
  ltv.classList.toggle('no-preview', !s.showPreview);
  ltv.classList.toggle('no-details', !s.showProgramDetails);
  ltv.classList.toggle('no-stripes', !s.stripeMissingGuide);
}

// --------------------------------------------------------------- groups

function groupList() {
  const d = st.data;
  if (!d) return [];
  const s = d.settings;
  const out = [{ id: SPECIAL.SEARCH, title: 'Search', special: true }];
  if (s.showFavoritesGroup) out.push({ id: SPECIAL.FAVORITES, title: 'Favorites', count: d.favorites.filter((k) => st.byKey.has(k)).length, special: true });
  if (s.showRecentGroup) out.push({ id: SPECIAL.RECENT, title: 'Recently watched', count: d.recent.filter((k) => st.byKey.has(k)).length, special: true });
  if (s.showAllChannelsGroup) out.push({ id: SPECIAL.ALL, title: 'All channels', count: d.channels.length, special: true });
  return out.concat(d.groups);
}

function groupExists(id) {
  return groupList().some((g) => g.id === id);
}

function defaultGroup() {
  const g = groupList().find((x) => x.id !== SPECIAL.SEARCH && (x.count || 0) > 0 && x.id !== SPECIAL.RECENT && x.id !== SPECIAL.FAVORITES);
  return g?.id || SPECIAL.ALL;
}

function rememberedGroup() {
  try { const id = localStorage.getItem('nuvio.ltv.group'); return id && groupExists(id) && id !== SPECIAL.SEARCH ? id : null; } catch { return null; }
}

function channelsFor(id) {
  const d = st.data;
  if (!d) return [];
  if (id === SPECIAL.ALL) return d.channels;
  if (id === SPECIAL.FAVORITES) return d.favorites.map((k) => st.byKey.get(k)).filter(Boolean);
  if (id === SPECIAL.RECENT) return d.recent.map((k) => st.byKey.get(k)).filter(Boolean);
  if (id === SPECIAL.SEARCH) return (st.searchHits || []).map((k) => st.byKey.get(k)).filter(Boolean);
  return d.channels.filter((c) => c.groupId === id);
}

function selectGroup(id, { keepRow = false } = {}) {
  const changed = id !== st.groupId;
  st.groupId = id;
  if (id !== SPECIAL.SEARCH) { try { localStorage.setItem('nuvio.ltv.group', id); } catch { /* private */ } }
  const playing = st.list[st.row]?.key;
  st.list = channelsFor(id);
  if (!keepRow || changed) st.row = 0;
  else if (playing) st.row = Math.max(0, st.list.findIndex((c) => c.key === playing));
  st.row = Math.min(st.row, Math.max(0, st.list.length - 1));
  if (changed) $('#ltv-grid').scrollTop = 0;
}

function renderGroups() {
  const box = $('#ltv-group-list');
  const d = st.data;
  if (!d) { box.innerHTML = ''; return; }
  const showCounts = settings().showGroupCounts;
  const playlists = Object.keys(d.playlists || {});
  const headings = settings().groupPlaylistHeadings && playlists.length > 1;
  const collapsed = new Set(d.collapsed || []);
  const html = [];
  let lastSource = null;
  for (const g of groupList()) {
    if (headings && !g.special && g.sourceId !== lastSource) {
      lastSource = g.sourceId;
      const n = d.groups.filter((x) => x.sourceId === g.sourceId).length;
      html.push(`<button class="ltv-pl-head" data-source="${esc(g.sourceId)}">
        <span class="ltv-fold">${collapsed.has(g.sourceId) ? '▸' : '▾'}</span>
        <span class="ltv-pl-name">${esc(d.playlists[g.sourceId] || 'Playlist')}</span>
        <span class="ltv-pl-count">${n}</span></button>`);
    }
    if (headings && !g.special && collapsed.has(g.sourceId)) continue;
    if (g.id === SPECIAL.SEARCH) {
      html.push(`<button class="ltv-group-search${st.groupId === g.id ? ' selected' : ''}" data-group="${g.id}">
        <svg viewBox="0 0 24 24"><path d="M11 3a8 8 0 1 0 4.9 14.3l4.4 4.4 1.4-1.4-4.4-4.4A8 8 0 0 0 11 3m0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12"/></svg><span>Search</span></button>`);
      continue;
    }
    html.push(`<button class="ltv-group${st.groupId === g.id ? ' selected' : ''}${g.special ? ' special' : ''}" data-group="${esc(g.id)}">
      <span class="ltv-group-name">${esc(g.title)}</span>
      ${showCounts && g.count != null ? `<span class="ltv-group-count">${g.count}</span>` : ''}</button>`);
  }
  box.innerHTML = html.join('');
  box.querySelectorAll('[data-group]').forEach((el) => el.addEventListener('click', () => {
    const id = el.dataset.group;
    if (id === SPECIAL.SEARCH) { openSearch(); return; }
    selectGroup(id);
    resetToNow();
    toggleGroups(false);
    render();
    $('#ltv-grid').focus({ preventScroll: true });
  }));
  box.querySelectorAll('[data-group]').forEach((el) => onLongPress(el));
  box.querySelectorAll('[data-group]').forEach((el) => el.addEventListener('contextmenu', (e) => {
    const g = d.groups.find((x) => x.id === el.dataset.group);
    if (!g) return;
    e.preventDefault();
    openMenu(`“${g.title}”`, [
      ['Hide group', async () => { await st.ctx.post('/api/iptv/hidden', { group: g.id, hidden: true }); await load(); }],
    ]);
  }));
  box.querySelectorAll('.ltv-pl-head').forEach((el) => el.addEventListener('click', async () => {
    const id = el.dataset.source;
    const now = !(d.collapsed || []).includes(id);
    d.collapsed = now ? [...(d.collapsed || []), id] : (d.collapsed || []).filter((x) => x !== id);
    renderGroups();
    st.ctx.post('/api/iptv/collapsed', { sourceId: id, collapsed: now }).catch(() => {});
  }));
}

function toggleGroups(open = !st.groupsOpen) {
  st.groupsOpen = open;
  $('#ltv').classList.toggle('groups-open', open);
  if (open) {
    renderGroups();
    setTimeout(() => $('#ltv-group-list .selected')?.scrollIntoView({ block: 'nearest' }), 30);
  }
}

function openSearch() {
  const q = prompt('Search channels and shows', st.searchQuery || '');
  if (q === null) return;
  runSearch(q.trim());
}

async function runSearch(q) {
  st.searchQuery = q;
  if (!q) return;
  try {
    const res = await st.ctx.api(`/api/iptv/search?q=${encodeURIComponent(q)}`);
    const keys = [...new Set([...res.channels, ...res.programs.map((p) => p.key)])];
    st.searchHits = keys;
    selectGroup(SPECIAL.SEARCH);
    resetToNow();
    toggleGroups(false);
    render();
    if (!keys.length) st.ctx.toast(`Nothing found for “${q}”`);
  } catch (err) { st.ctx.toast(err.message); }
}

// --------------------------------------------------------------- window

function resetToNow() {
  st.windowStart = floorSlot(Date.now());
  st.block = null;
}

function shiftWindow(delta) {
  const min = floorSlot(Date.now() - 7 * 86_400_000);
  const max = floorSlot(Date.now() + (settings().epgFutureDays || 3) * 86_400_000);
  st.windowStart = Math.max(min, Math.min(max, st.windowStart + delta));
  render();
}

// --------------------------------------------------------------- render

function render() {
  if (!st.data) return;
  const empty = !st.data.channels.length;
  $('#ltv-empty').hidden = !empty;
  $('#ltv-body').hidden = empty;
  if (empty) {
    const loading = st.data.status?.loading;
    $('#ltv-empty-title').textContent = loading ? 'Loading channels…' : (st.data.sourceCount ? 'No channels yet' : 'No playlists yet');
    $('#ltv-empty-body').textContent = loading ? (st.data.status.message || '')
      : 'Add an Xtream Codes login or an M3U playlist in Settings → Live TV. Its TV guide comes with it.';
    $('#ltv-empty-action').hidden = Boolean(loading);
    renderHeader();
    return;
  }
  if (st.groupsOpen) renderGroups();
  $('#ltv-group-title').textContent = groupList().find((g) => g.id === st.groupId)?.title || 'Channels';
  renderRuler();
  renderRows();
  renderHeader();
}

function current() { return st.list[st.row] || null; }

function programsOf(key) { return st.programs.get(key) || []; }

function blockAt(key, t) {
  const p = programsOf(key).find((x) => t >= x.s && t < x.e);
  if (p) return { s: p.s, e: p.e, p };
  const s = floorSlot(t);
  return { s, e: s + SLOT, p: null };
}

function focusedBlock() {
  const ch = current();
  if (!ch) return null;
  if (st.block) {
    // Listings may have arrived since: snap to the real show there.
    const at = Math.max(st.block.s, st.windowStart);
    const real = blockAt(ch.key, at);
    if (real.p || !st.block.p) st.block = real;
    return st.block;
  }
  const now = Date.now();
  const t = now >= st.windowStart && now < st.windowStart + windowMs() ? now : st.windowStart;
  return blockAt(ch.key, t);
}

function renderRuler() {
  const now = Date.now();
  const ws = st.windowStart;
  const W = windowMs();
  $('#ltv-day').textContent = dayLabel(ws, now);
  const times = $('#ltv-times');
  const midnight = nextMidnight(ws);
  const showMidnight = midnight < ws + W;
  const parts = [];
  for (let t = ws; t < ws + W; t += SLOT) {
    if (showMidnight && t === midnight) continue;
    parts.push(`<span class="ltv-tick" style="left:${((t - ws) / W) * 100}%">${esc(dayClock(t, now))}</span>`);
  }
  if (showMidnight) {
    const isTomorrow = midnight - now >= 0 && midnight - now <= 86_400_000;
    const name = new Date(midnight).toLocaleDateString([], { weekday: 'short' }).toUpperCase();
    parts.push(`<span class="ltv-tag ltv-tag-midnight" style="left:calc(${((midnight - ws) / W) * 100}% + 4px)">${isTomorrow ? `TOMORROW · ${name}` : name}</span>`);
  }
  parts.push(`<span class="ltv-clock">${esc(clock(now))}</span>`);
  times.innerHTML = parts.join('');
  $('#ltv-now').hidden = ws === floorSlot(now);
}

function renderNowLine() {
  const line = $('#ltv-nowline');
  const now = Date.now();
  const W = windowMs();
  const on = settings().showNowLine && now >= st.windowStart && now < st.windowStart + W;
  const progs = document.querySelector('#ltv-rows .ltv-progs');
  line.hidden = !on || !progs;
  if (line.hidden) return;
  const wrap = line.parentElement.getBoundingClientRect();
  const r = progs.getBoundingClientRect();
  line.style.left = `${r.left - wrap.left + ((now - st.windowStart) / W) * r.width - 1}px`;
  // The ruler's times line up with the shows, whatever the scrollbar takes.
  const grid = $('#ltv-grid');
  $('#ltv-times').style.marginRight = `${grid.offsetWidth - grid.clientWidth}px`;
}

// Rows are drawn only around what's on screen; the rest is a spacer, so a
// group of thousands of channels scrolls as lightly as one of ten.
function renderRows(soft = false) {
  const grid = $('#ltv-grid');
  const inner = $('#ltv-rows');
  const rowH = sizeOf().row;
  const total = st.list.length;
  inner.style.height = `${total * rowH}px`;
  const top = grid.scrollTop;
  const h = grid.clientHeight || 600;
  const first = Math.max(0, Math.floor(top / rowH) - 6);
  const last = Math.min(total, Math.ceil((top + h) / rowH) + 6);
  const now = Date.now();
  const ws = st.windowStart;
  const W = windowMs();
  const we = ws + W;
  const s = settings();
  const fb = focusedBlock();
  const favs = new Set(st.data.favorites);
  const html = [];
  const want = [];
  for (let i = first; i < last; i += 1) {
    const ch = st.list[i];
    want.push(ch.key);
    const focusedRow = i === st.row;
    const progs = programsOf(ch.key).filter((p) => p.e > ws && p.s < we);
    const cells = [];
    if (!progs.length) {
      const f = focusedRow;
      cells.push(`<div class="ltv-prog ltv-empty-row${f ? ' focused' : ''}" style="${pos(ws, we, ws, W)}"><span class="ltv-prog-title">${esc(ch.name)}</span></div>`);
    } else {
      // Gaps in the listings: the striped "No information" tile.
      let cursor = ws;
      const pushGap = (a, b) => {
        if (b - a <= 60_000) return;
        cells.push(`<div class="ltv-prog ltv-gap" style="${pos(a, b, ws, W)}"><span class="ltv-prog-title">${s.stripeMissingGuide ? 'No information' : esc(ch.name)}</span></div>`);
      };
      for (const p of progs) {
        if (p.s > cursor) pushGap(cursor, p.s);
        cursor = Math.max(cursor, p.e);
        const a = Math.max(p.s, ws);
        const b = Math.min(p.e, we);
        const live = now >= p.s && now < p.e;
        const past = p.e <= now;
        const isF = focusedRow && fb && fb.p && fb.p.s === p.s;
        const m = marks(p.t);
        const cls = ['ltv-prog', live && 'live', past && 'past', isF && 'focused'].filter(Boolean).join(' ');
        const extras = [];
        if (m.live && !past) extras.push('<span class="ltv-tag ltv-tag-live">LIVE</span>');
        const title = `<span class="ltv-prog-title">${p.s < ws ? '‹ ' : ''}${esc(m.title)}</span>`;
        const after = [];
        if (p.ep && s.showEpisodeNumbers && p.ep.length <= 12) after.push(`<span class="ltv-ep">${esc(p.ep)}</span>`);
        if (m.isNew) after.push('<span class="ltv-tag ltv-tag-new">NEW</span>');
        if (past && ch.catchup) after.push('<svg class="ltv-ico ltv-replay" viewBox="0 0 24 24" aria-label="Catch-up"><path d="M13 3a9 9 0 0 0-9 9H1l3.9 3.9.1.1L9 12H6a7 7 0 1 1 2.1 5l-1.4 1.4A9 9 0 1 0 13 3zm-1 5v5l4.3 2.5.7-1.2-3.5-2.1V8z"/></svg>');
        const times = s.showProgramTimes ? `<span class="ltv-prog-times">${esc(clock(p.s))} – ${esc(clock(p.e))}</span>` : '';
        const prog = live ? `<span class="ltv-prog-bar" style="width:${((now - p.s) / (p.e - p.s)) * 100}%"></span>` : '';
        cells.push(`<div class="${cls}" data-s="${p.s}" style="${pos(a, b, ws, W)}">
          <div class="ltv-prog-line">${extras.join('')}${title}<span class="ltv-prog-after">${after.join('')}</span></div>${times}${prog}</div>`);
      }
      if (cursor < we) pushGap(cursor, we);
      // An empty slot under the cursor.
      if (focusedRow && fb && !fb.p) {
        const a = Math.max(fb.s, ws); const b = Math.min(fb.e, we);
        if (b > a) cells.push(`<div class="ltv-prog focused" style="${pos(a, b, ws, W)}"><span class="ltv-prog-title">${s.stripeMissingGuide ? 'No information' : esc(ch.name)}</span></div>`);
      }
    }
    const playing = ch.key === st.playingKey;
    html.push(`<div class="ltv-row${focusedRow ? ' row-focused' : ''}" data-i="${i}" style="top:${i * rowH}px">
      <div class="ltv-chan${playing ? ' playing' : ''}">
        ${s.showChannelNumbers ? `<span class="ltv-num">${ch.number}</span>` : ''}
        ${s.showChannelLogos ? logoHtml(ch) : ''}
        ${s.showChannelNames ? `<span class="ltv-name">${esc(ch.name)}</span>` : '<span class="ltv-name"></span>'}
        ${ch.catchup ? '<svg class="ltv-ico" viewBox="0 0 24 24" aria-label="Catch-up"><path d="M13 3a9 9 0 0 0-9 9H1l3.9 3.9.1.1L9 12H6a7 7 0 1 1 2.1 5l-1.4 1.4A9 9 0 1 0 13 3zm-1 5v5l4.3 2.5.7-1.2-3.5-2.1V8z"/></svg>' : ''}
        ${favs.has(ch.key) ? '<svg class="ltv-ico ltv-star" viewBox="0 0 24 24" aria-label="Favorite"><path d="M12 17.3 18.2 21l-1.6-7L22 9.2l-7.2-.6L12 2 9.2 8.6 2 9.2 7.5 14l-1.7 7z"/></svg>' : ''}
        ${playing ? '<span class="ltv-playing-dot"></span>' : ''}
      </div>
      <div class="ltv-progs">${cells.join('')}</div>
    </div>`);
  }
  inner.innerHTML = html.join('');
  renderNowLine();
  if (!soft) requestGuide(want);
}

// --------------------------------------------------------------- guide data

let guideTimer = null;
function requestGuide(keys) {
  const from = st.windowStart - 2 * HOUR;
  const to = st.windowStart + windowMs() + 6 * HOUR;
  const need = keys.filter((k) => {
    const r = st.loadedFor.get(k);
    return !st.pending.has(k) && (!r || from < r[0] || to > r[1]);
  });
  // Shows already aired, on catch-up channels: the provider's archive
  // listings go back further than the guide file.
  if (st.windowStart < Date.now() - HOUR) {
    const arch = keys.filter((k) => st.byKey.get(k)?.catchup && !st.archiveAsked.has(k));
    if (arch.length) {
      arch.forEach((k) => st.archiveAsked.add(k));
      st.ctx.post('/api/iptv/archive', { keys: arch }).then((r) => {
        const changed = Object.keys(r.updated || {});
        changed.forEach((k) => st.loadedFor.delete(k));
        if (changed.length) requestGuide(changed);
      }).catch(() => {});
    }
  }
  if (!need.length) return;
  clearTimeout(guideTimer);
  need.forEach((k) => st.pending.add(k));
  guideTimer = setTimeout(async () => {
    const batch = [...st.pending];
    st.pending.clear();
    const pf = st.windowStart - 12 * HOUR;
    const pt = st.windowStart + windowMs() + 18 * HOUR;
    try {
      const res = await st.ctx.post('/api/iptv/guide', { keys: batch, from: pf, to: pt });
      for (const k of batch) {
        const fresh = res.programs[k] || [];
        const old = st.programs.get(k) || [];
        const merged = [...old.filter((p) => p.e <= pf || p.s >= pt), ...fresh].sort((a, b) => a.s - b.s);
        st.programs.set(k, merged);
        const r = st.loadedFor.get(k);
        st.loadedFor.set(k, r ? [Math.min(r[0], pf), Math.max(r[1], pt)] : [pf, pt]);
      }
      if (st.visible) { renderRows(true); renderHeader(); }
    } catch { /* next scroll asks again */ }
  }, 60);
}

// --------------------------------------------------------------- header

function renderHeader() {
  const s = settings();
  const ch = current();
  const now = Date.now();
  const fb = ch ? focusedBlock() : null;
  const p = fb?.p || null;
  const ltv = $('#ltv');
  $('#ltv-slim-clock').textContent = clock(now);
  $('#ltv-slim-status').textContent = st.data?.status?.loading ? (st.data.status.message || 'Updating…') : '';
  const poster = $('#ltv-poster');
  poster.hidden = !s.showProgramDetails || !ch;
  if (ch) {
    // The show's own picture from the guide; the channel logo when it has none.
    poster.classList.toggle('is-logo', !p?.i);
    poster.innerHTML = p?.i
      ? `<img src="${esc(p.i)}" alt="" onerror="this.parentElement.classList.add('is-logo');this.outerHTML=${esc(JSON.stringify(logoHtml(ch, 'ltv-poster-logo')))}">`
      : logoHtml(ch, 'ltv-poster-logo');
  }
  const info = $('#ltv-info');
  if (!s.showProgramDetails || !ch) {
    info.innerHTML = st.data?.status?.loading ? `<p class="ltv-sub">${esc(st.data.status.message || 'Updating…')}</p>` : '';
  } else {
    const live = fb && now >= fb.s && now < fb.e;
    const playlist = Object.keys(st.data.playlists || {}).length > 1 ? st.data.playlists[ch.sourceId] : null;
    const label = `${s.showChannelNumbers ? `${ch.number}  ` : ''}${ch.name}${playlist ? `  ·  ${playlist}` : ''}`;
    const meta = [];
    if (fb) {
      meta.push(`${dayClock(fb.s, now)} – ${clock(fb.e)}`);
      if (live) meta.push(minutesLeft(fb.e, now));
      if (p?.ep && s.showEpisodeNumbers) meta.push(p.ep);
      if (p?.c) meta.push(p.c);
      if (p?.y) meta.push(String(p.y));
      if (ltv.classList.contains('small-header') && ch.catchup) meta.push('Catch-up');
    }
    info.innerHTML = `
      <div class="ltv-chline">
        ${s.showChannelLogos ? logoHtml(ch, 'ltv-chline-logo') : ''}
        <span class="ltv-chline-name">${esc(label)}</span>
        ${live ? '<span class="ltv-tag ltv-tag-live">LIVE</span>' : ''}
        ${ch.catchup ? '<span class="ltv-tag ltv-tag-outline">CATCH-UP</span>' : ''}
      </div>
      <h2 class="ltv-title">${esc(p ? marks(p.t).title : ch.name)}</h2>
      ${fb ? `<p class="ltv-meta">${esc(meta.join('  ·  '))}</p>` : ''}
      ${live ? `<div class="ltv-progress"><span style="width:${Math.min(100, ((now - fb.s) / Math.max(1, fb.e - fb.s)) * 100)}%"></span></div>` : ''}
      <p class="ltv-desc">${esc(p?.d || (p ? '' : 'No program information'))}</p>`;
    fitTitle(info.querySelector('.ltv-title'));
  }
  const pv = $('#ltv-preview-msg');
  if (!st.preview) pv.textContent = st.ctx?.transcode() ? 'Press OK on a channel to preview' : 'Preview needs the server’s converter (ffmpeg)';
}

// --------------------------------------------------------------- input

function bindGrid() {
  const grid = $('#ltv-grid');
  let scrollRaf = 0;
  grid.addEventListener('scroll', () => {
    cancelAnimationFrame(scrollRaf);
    scrollRaf = requestAnimationFrame(() => renderRows());
  }, { passive: true });

  // Shift+wheel or a sideways swipe on a trackpad moves through time.
  let wheelAcc = 0;
  grid.addEventListener('wheel', (e) => {
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
    if (!dx) return;
    e.preventDefault();
    wheelAcc += dx;
    if (Math.abs(wheelAcc) > 120) { shiftWindow(wheelAcc > 0 ? SLOT : -SLOT); wheelAcc = 0; }
  }, { passive: false });

  // Touch: a sideways swipe moves through time.
  let touch = null;
  grid.addEventListener('touchstart', (e) => { const t = e.touches[0]; touch = { x: t.clientX, y: t.clientY }; }, { passive: true });
  grid.addEventListener('touchend', (e) => {
    if (!touch) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.x; const dy = t.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftWindow(dx < 0 ? SLOT : -SLOT);
  }, { passive: true });

  const hit = (e) => {
    const rowEl = e.target.closest('.ltv-row');
    if (!rowEl) return null;
    const i = Number(rowEl.dataset.i);
    const ch = st.list[i];
    const progs = rowEl.querySelector('.ltv-progs');
    const rect = progs.getBoundingClientRect();
    const onChannel = e.clientX < rect.left;
    const t = st.windowStart + ((e.clientX - rect.left) / rect.width) * windowMs();
    return { i, ch, onChannel, t };
  };

  grid.addEventListener('click', (e) => {
    const h = hit(e);
    if (!h) return;
    const sameRow = h.i === st.row;
    st.row = h.i;
    st.block = h.onChannel ? null : blockAt(h.ch.key, Math.max(h.t, st.windowStart));
    const target = h.onChannel ? `ch:${h.ch.key}` : `${h.ch.key}:${st.block.s}`;
    const again = sameRow && st.lastClick.key === target && Date.now() - st.lastClick.at < 4000;
    st.lastClick = { key: target, at: Date.now() };
    renderRows(true); renderHeader();
    // Preview off (or not possible here): one click on a channel, or on
    // what's on now, opens it straight away.
    const previewing = settings().showPreview && st.ctx.transcode();
    const now = Date.now();
    const onNow = h.onChannel || (st.block && now >= st.block.s && now < st.block.e);
    if (!previewing && onNow) { fullscreen(h.ch); return; }
    if (again || h.onChannel) activate(); else maybePreviewOnTap();
  });

  grid.addEventListener('contextmenu', (e) => {
    const h = hit(e);
    if (!h) return;
    e.preventDefault();
    st.row = h.i;
    st.block = h.onChannel ? null : blockAt(h.ch.key, Math.max(h.t, st.windowStart));
    renderRows(true); renderHeader();
    channelMenu();
  });

  // Long press on touch screens opens the channel / programme menu.
  onLongPress(grid);

  document.addEventListener('keydown', (e) => {
    if (!st.visible || $('#ltv-menu').hidden === false || e.target.matches?.('input, textarea, select')) {
      if (st.visible && !$('#ltv-menu').hidden && e.key === 'Escape') closeMenu();
      return;
    }
    if (!document.body.classList.contains('ltv-on') || !$('#screen-watch').hidden) return;
    const k = e.key;
    if (st.groupsOpen && ['ArrowUp', 'ArrowDown', 'Enter', 'ArrowRight', 'Escape'].includes(k)) {
      groupKeys(e); return;
    }
    switch (k) {
      case 'ArrowDown': move(1); break;
      case 'ArrowUp': move(-1); break;
      case 'PageDown': move(Math.max(1, Math.floor($('#ltv-grid').clientHeight / sizeOf().row) - 1)); break;
      case 'PageUp': move(-Math.max(1, Math.floor($('#ltv-grid').clientHeight / sizeOf().row) - 1)); break;
      case 'ArrowRight': stepBlock(1); break;
      case 'ArrowLeft': stepBlock(-1); break;
      case 'Enter': case ' ': activate(); break;
      case 'm': case 'M': case 'ContextMenu': channelMenu(); break;
      case 'i': case 'I': programInfo(); break;
      case 'f': case 'F': { const ch = current(); if (ch) toggleFav(ch); break; }
      case '/': openSearch(); break;
      case 'g': case 'G': toggleGroups(); break;
      case 'Escape': if (st.preview) stopPreview(); else return; break;
      default: return;
    }
    e.preventDefault();
  });
}

function groupKeys(e) {
  const items = [...document.querySelectorAll('#ltv-group-list [data-group]')];
  let i = items.findIndex((el) => el.classList.contains('kb'));
  if (i < 0) i = items.findIndex((el) => el.classList.contains('selected'));
  if (e.key === 'ArrowDown') i = Math.min(items.length - 1, i + 1);
  else if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
  else if (e.key === 'Enter') { items[i]?.click(); e.preventDefault(); return; }
  else { toggleGroups(false); e.preventDefault(); return; }
  items.forEach((el, j) => el.classList.toggle('kb', j === i));
  items[i]?.scrollIntoView({ block: 'nearest' });
  e.preventDefault();
}

function move(delta) {
  if (!st.list.length) return;
  const t = st.block ? Math.max(st.block.s, st.windowStart) : null;
  st.row = Math.max(0, Math.min(st.list.length - 1, st.row + delta));
  st.block = t != null ? blockAt(st.list[st.row].key, t) : null;
  scrollRowIntoView();
  renderRows(); renderHeader();
}

function scrollRowIntoView() {
  const grid = $('#ltv-grid');
  const rowH = sizeOf().row;
  const top = st.row * rowH;
  if (top < grid.scrollTop) grid.scrollTop = top;
  else if (top + rowH > grid.scrollTop + grid.clientHeight) grid.scrollTop = top + rowH - grid.clientHeight;
}

function stepBlock(dir) {
  const ch = current();
  if (!ch) return;
  const fb = focusedBlock();
  const W = windowMs();
  if (dir > 0) {
    const nb = blockAt(ch.key, fb.e);
    st.block = nb;
    if (nb.s >= st.windowStart + W - 1) st.windowStart = floorSlot(nb.s);
  } else {
    // At the start of the window, at "now": the group list slides in.
    if (fb.s <= st.windowStart && st.windowStart <= floorSlot(Date.now()) && !catchupAvailable(ch, st.windowStart - 1)) {
      toggleGroups(true); return;
    }
    const nb = blockAt(ch.key, fb.s - 1);
    st.block = nb;
    if (nb.s < st.windowStart) st.windowStart = floorSlot(Math.max(nb.s, st.windowStart - W + SLOT));
  }
  render();
}

// Tap on a phone: the first tap on a live show previews the channel, like
// moving the highlight onto it on a TV.
function maybePreviewOnTap() {
  const ch = current();
  const fb = focusedBlock();
  const now = Date.now();
  if (ch && fb && now >= fb.s && now < fb.e && settings().showPreview && st.ctx.transcode()) previewChannel(ch);
}

// OK: what the TV app does with it.
function activate() {
  const ch = current();
  if (!ch) return;
  const fb = focusedBlock();
  const now = Date.now();
  if (fb && fb.e <= now) {
    if (catchupAvailable(ch, fb.s, now)) playCatchup(ch, fb);
    else programInfo();
    return;
  }
  if (fb && fb.s > now) { programInfo(); return; }
  // Live: preview first, full screen on the second OK.
  if (settings().showPreview && st.ctx.transcode() && st.preview?.key !== ch.key) { previewChannel(ch); return; }
  fullscreen(ch);
}

// --------------------------------------------------------------- playback

function playLink(params) {
  const q = new URLSearchParams({ ...params, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '' });
  return platform.playLink(`/api/iptv/play?${q}`, { format: 'json' });
}

async function fullscreen(ch, catchup = null, onNow = null) {
  const now = Date.now();
  const p = catchup || onNow || programsOf(ch.key).find((x) => now >= x.s && now < x.e);
  const params = { key: ch.key, title: p ? marks(p.t).title : '' };
  if (catchup) { params.start = String(catchup.s); params.stop = String(catchup.e); }
  stopPreview();
  st.playingKey = ch.key;
  if (st.data && !st.data.recent.includes(ch.key)) st.data.recent.unshift(ch.key);
  if (st.data && st.visible) renderRows(true);
  if (platform.resolve() !== 'browser') {
    location.href = playLink(params).replace(/([?&])format=json&?/, '$1');
    return;
  }
  await st.ctx.playWatch(playLink(params), catchup ? 'Opening the replay…' : 'Tuning in…');
}

function playCatchup(ch, block) {
  if (!block?.p && !block) return;
  fullscreen(ch, { s: block.s, e: block.e, t: block.p?.t || ch.name });
}

function watchFromStart(ch) {
  const now = Date.now();
  const p = programsOf(ch.key).find((x) => now >= x.s && now < x.e);
  if (p && catchupAvailable(ch, p.s, now)) fullscreen(ch, p);
}

let hlsPromise = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  hlsPromise ||= new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = '/vendor/hls.light.min.js';
    s.onload = () => resolve(window.Hls || null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return hlsPromise;
}

// The preview window: the channel converted live by the server, like the
// full-screen player does, but small and muted until clicked.
async function previewChannel(ch) {
  if (!settings().showPreview || !st.ctx.transcode()) return;
  stopPreview();
  const gen = (st.previewGen = (st.previewGen || 0) + 1);
  const video = $('#ltv-preview-video');
  const msg = $('#ltv-preview-msg');
  msg.textContent = 'Loading…';
  st.preview = { key: ch.key, sid: null, hls: null, hb: null };
  st.playingKey = ch.key;
  renderRows(true);
  try {
    const res = await fetch(platform.playLink(`/api/iptv/play?${new URLSearchParams({ key: ch.key, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '' })}`, { format: 'json', target: 'browser' }), { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.watch) throw new Error(data.error || 'This channel won’t play.');
    const token = new URLSearchParams(data.watch.split('?')[1]).get('t');
    const ticket = await st.ctx.api(`/api/ticket/${encodeURIComponent(token)}`);
    const item = ticket.items?.[0];
    if (!item?.transcodeKey) throw new Error('Preview needs the server’s converter.');
    if (gen !== st.previewGen) return;
    const reply = await st.ctx.post('/api/transcode/start', {
      u: item.transcodeKey.u, s: item.transcodeKey.s, live: true, quality: 'original',
      caps: platform.capabilities(video),
    });
    if (gen !== st.previewGen) { if (reply.sid) st.ctx.post(`/api/transcode/stop/${reply.sid}`).catch(() => {}); return; }
    st.preview.sid = reply.sid || null;
    st.preview.token = token;
    if (reply.sid) st.preview.hb = setInterval(() => st.ctx.post(`/api/transcode/heartbeat/${reply.sid}`).catch(() => {}), 10_000);
    video.muted = true;
    if (reply.mode === 'direct') {
      video.src = reply.url;
    } else {
      const Hls = await loadHls();
      if (Hls?.isSupported()) {
        const hls = new Hls({ liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 8, maxLiveSyncPlaybackRate: 1.1 });
        st.preview.hls = hls;
        hls.on(Hls.Events.ERROR, (_, d) => {
          if (d.fatal && gen === st.previewGen) msg.textContent = d.type === 'mediaError' ? 'This browser can’t play the preview' : 'The channel stopped. Press OK to try again.';
        });
        hls.loadSource(reply.url);
        hls.attachMedia(video);
      } else {
        video.src = reply.url;
      }
    }
    video.play().catch(() => {});
    video.onplaying = () => { if (gen === st.previewGen) msg.textContent = ''; };
  } catch (err) {
    if (gen !== st.previewGen) return;
    msg.textContent = err.message;
    st.preview = null;
  }
}

function stopPreview() {
  const p = st.preview;
  st.previewGen = (st.previewGen || 0) + 1;
  st.preview = null;
  const video = $('#ltv-preview-video');
  if (!p) return;
  clearInterval(p.hb);
  try { p.hls?.destroy(); } catch { /* gone */ }
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  if (p.sid) st.ctx.post(`/api/transcode/stop/${p.sid}`).catch(() => {});
  const msg = $('#ltv-preview-msg');
  if (msg) msg.textContent = 'Press OK on a channel to preview';
}

// --------------------------------------------------------------- menus

function openMenu(title, actions) {
  const menu = $('#ltv-menu');
  menu.innerHTML = `<h3 class="ltv-menu-title">${esc(title)}</h3>${actions.map(([label], i) => `<button class="ltv-menu-item" data-i="${i}">${esc(label)}</button>`).join('')}`;
  menu.querySelectorAll('.ltv-menu-item').forEach((el) => el.addEventListener('click', () => {
    const action = actions[Number(el.dataset.i)][1];
    closeMenu();
    action();
  }));
  menu.hidden = false;
  $('#ltv-menu-backdrop').hidden = false;
  lockPage();
  menu.querySelector('button')?.focus({ preventScroll: true });
  menu.onkeydown = (e) => {
    const items = [...menu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { items[Math.min(items.length - 1, i + 1)]?.focus({ preventScroll: true }); e.preventDefault(); }
    if (e.key === 'ArrowUp') { items[Math.max(0, i - 1)]?.focus({ preventScroll: true }); e.preventDefault(); }
    if (e.key === 'Escape' || e.key === 'Backspace') { closeMenu(); e.preventDefault(); }
  };
}

function closeMenu() {
  const menu = $('#ltv-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $('#ltv-menu-backdrop').hidden = true;
  unlockPage();
  $('#ltv-grid')?.focus({ preventScroll: true });
}

async function toggleFav(ch) {
  try {
    const { favorite } = await st.ctx.post('/api/iptv/favorite', { key: ch.key });
    st.data.favorites = favorite ? [...st.data.favorites, ch.key] : st.data.favorites.filter((k) => k !== ch.key);
    if (st.groupId === SPECIAL.FAVORITES) selectGroup(SPECIAL.FAVORITES, { keepRow: true });
    render();
    st.ctx.toast(favorite ? `Added ${ch.name} to Favorites` : `Removed ${ch.name} from Favorites`);
  } catch (err) { st.ctx.toast(err.message); }
}

function channelMenu() {
  const ch = current();
  if (!ch) return;
  const fb = focusedBlock();
  const now = Date.now();
  const p = fb?.p;
  const isFav = st.data.favorites.includes(ch.key);
  const actions = [];
  actions.push(['Watch', () => fullscreen(ch)]);
  if (fb && fb.e <= now && catchupAvailable(ch, fb.s, now)) actions.push([`Play catch-up${p ? `: ${marks(p.t).title}` : ''}`, () => playCatchup(ch, fb)]);
  const onNow = programsOf(ch.key).find((x) => now >= x.s && now < x.e);
  if (onNow && catchupAvailable(ch, onNow.s, now)) actions.push(['Watch from start', () => watchFromStart(ch)]);
  if (p) actions.push(['Show info', () => programInfo()]);
  actions.push([isFav ? 'Remove from Favorites' : 'Add to Favorites', () => toggleFav(ch)]);
  if (isFav && st.groupId === SPECIAL.FAVORITES) {
    actions.push(['Move up', () => moveFav(ch, -1)]);
    actions.push(['Move down', () => moveFav(ch, 1)]);
  }
  actions.push(['Hide channel', async () => { await st.ctx.post('/api/iptv/hidden', { channel: ch.key, hidden: true }); await load(); }]);
  if (ch.groupId) actions.push(['Hide group', async () => { await st.ctx.post('/api/iptv/hidden', { group: ch.groupId, hidden: true }); await load(); }]);
  actions.push(['Search', () => openSearch()]);
  actions.push(['Update playlists and guides', async () => { await st.ctx.post('/api/iptv/refresh'); st.ctx.toast('Updating…'); setTimeout(() => load({ quiet: true }), 1500); }]);
  actions.push(['Live TV settings', () => st.ctx.openSettings()]);
  openMenu(`${settings().showChannelNumbers ? `${ch.number}  ` : ''}${ch.name}`, actions);
}

async function moveFav(ch, delta) {
  await st.ctx.post('/api/iptv/favorite/move', { key: ch.key, delta });
  const list = st.data.favorites;
  const i = list.indexOf(ch.key); const j = i + delta;
  if (i >= 0 && j >= 0 && j < list.length) { list.splice(j, 0, list.splice(i, 1)[0]); st.row = j; }
  selectGroup(SPECIAL.FAVORITES, { keepRow: true });
  st.row = Math.max(0, Math.min(st.list.length - 1, j));
  render();
}

function programInfo() {
  const ch = current();
  const fb = focusedBlock();
  if (!ch || !fb) return;
  const p = fb.p;
  const now = Date.now();
  const menu = $('#ltv-menu');
  const live = now >= fb.s && now < fb.e;
  const past = fb.e <= now;
  const buttons = [];
  if (live) buttons.push(['Watch', () => fullscreen(ch)]);
  if (live && catchupAvailable(ch, fb.s, now)) buttons.push(['Watch from start', () => watchFromStart(ch)]);
  if (past && catchupAvailable(ch, fb.s, now)) buttons.push(['Play catch-up', () => playCatchup(ch, fb)]);
  buttons.push(['Close', () => {}]);
  const m = p ? marks(p.t) : null;
  menu.innerHTML = `
    <div class="ltv-info-dialog">
      <p class="ltv-sub">${esc(`${ch.number}  ${ch.name}`)}</p>
      <h3 class="ltv-title">${esc(m ? m.title : ch.name)}</h3>
      <p class="ltv-meta">${esc([`${dayClock(fb.s, now)} – ${clock(fb.e)}`, live && minutesLeft(fb.e, now), p?.ep, p?.c, p?.y].filter(Boolean).join('  ·  '))}</p>
      ${p?.d ? `<p class="ltv-desc full">${esc(p.d)}</p>` : '<p class="ltv-desc">No program information</p>'}
      <div class="ltv-info-actions">${buttons.map(([l], i) => `<button class="${i === 0 ? 'btn-primary' : 'btn-ghost'}" data-i="${i}">${esc(l)}</button>`).join('')}</div>
    </div>`;
  menu.querySelectorAll('[data-i]').forEach((el) => el.addEventListener('click', () => {
    const fn = buttons[Number(el.dataset.i)][1];
    closeMenu(); fn();
  }));
  menu.hidden = false;
  $('#ltv-menu-backdrop').hidden = false;
  lockPage();
  menu.querySelector('button')?.focus({ preventScroll: true });
  menu.onkeydown = (e) => { if (e.key === 'Escape') { closeMenu(); e.preventDefault(); } };
}

// --------------------------------------------------------------- settings (Settings → Live TV)

export async function renderSettings(ctx) {
  st.ctx ||= ctx;
  const box = $('#ltv-settings');
  if (!box) return;
  let ov;
  try { ov = await ctx.api('/api/iptv/sources'); } catch (err) { box.innerHTML = `<p class="settings-note">${esc(err.message)}</p>`; return; }
  const s = ov.settings;
  const ago = (ms) => {
    if (!ms) return 'never updated';
    const m = Math.round((Date.now() - ms) / 60_000);
    return m < 1 ? 'updated just now' : m < 60 ? `updated ${m} min ago` : m < 1440 ? `updated ${Math.round(m / 60)} h ago` : `updated ${Math.round(m / 1440)} d ago`;
  };
  const expiry = (a) => {
    if (!a?.expiresAtMs) return '';
    const days = Math.max(0, Math.floor((a.expiresAtMs - Date.now()) / 86_400_000));
    const date = new Date(a.expiresAtMs).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
    const left = a.expiresAtMs <= Date.now() ? 'expired' : days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;
    return ` · Expires ${date} (${left})`;
  };
  const sourceRows = ov.sources.map((p) => {
    const expiring = p.enabled && p.account?.expiresAtMs && p.account.expiresAtMs - Date.now() < 7 * 86_400_000;
    const sub = p.kind === 'xtream' && p.enabled && !p.importLive ? 'TV channels off'
      : !p.enabled ? 'Off' : p.lastError ? `Error: ${p.lastError}` : `${p.channelCount} channels · ${ago(p.lastUpdatedMs)}`;
    return `<button class="ltv-set-row" data-source="${esc(p.id)}">
      <span><b>${esc(p.name)}${p.kind === 'xtream' ? ' (Xtream)' : ''}</b><small>${esc(sub + expiry(p.account))}</small></span>
      <span class="ltv-set-value${expiring ? ' warn' : ''}">${!p.enabled ? 'Off' : expiring ? (p.account.expiresAtMs <= Date.now() ? 'Expired' : 'Expires soon') : 'On'}</span></button>`;
  }).join('');
  const epgRows = ov.epgs.map((e) => `<button class="ltv-set-row" data-epg="${esc(e.id)}">
      <span><b>${esc(e.name)}</b><small>${esc(!e.enabled ? 'Off' : e.lastError ? `Error: ${e.lastError}` : `${e.programCount || 0} programs matched · ${ago(e.lastUpdatedMs)}`)}</small></span>
      <span class="ltv-set-value">${e.enabled ? 'On' : 'Off'}</span></button>`).join('');
  const sw = (key, title, sub) => `<label class="switch-row ltv-switch"><span><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span><input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''}></label>`;
  const sel = (key, title, sub, options) => `<label class="ltv-select-row"><span><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
    <select class="lang-select" data-set="${key}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(s[key]) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  const shifts = [];
  for (let m = -720; m <= 720; m += 30) shifts.push([m, m === 0 ? 'Off' : `${m > 0 ? '+' : '−'}${Math.floor(Math.abs(m) / 60)}${Math.abs(m) % 60 ? ':30' : ''} h`]);
  box.innerHTML = `
    <h3 class="ltv-set-sub">Playlists</h3>
    ${ov.status?.loading ? `<p class="settings-note">${esc(ov.status.message || 'Updating…')}</p>` : ''}
    <div class="settings-group ltv-set-group">${sourceRows || '<p class="ltv-set-empty">No playlists yet</p>'}
      <button class="ltv-set-row" id="ltv-add-xtream"><span><b>+ Add Xtream Codes Login</b><small>Sign in with the server, username and password from your provider. Its TV guide comes with it.</small></span></button>
      <button class="ltv-set-row" id="ltv-add-m3u"><span><b>+ Add M3U Playlist</b><small>A channel list from the M3U link your provider gave you</small></span></button>
    </div>
    <h3 class="ltv-set-sub">TV Guides (EPG)</h3>
    <div class="settings-group ltv-set-group">${epgRows}
      <button class="ltv-set-row" id="ltv-add-epg"><span><b>+ Add EPG Source</b><small>Extra TV listings from an XMLTV link (ending in .xml or .xml.gz). Guides linked in your playlists load by themselves.</small></span></button>
    </div>
    <h3 class="ltv-set-sub">Updates</h3>
    <div class="settings-group ltv-set-group">
      <button class="ltv-set-row" id="ltv-update-all"><span><b>Update Everything Now</b><small>Downloads the latest channels and listings instead of waiting for the next automatic update</small></span></button>
    </div>
    <p class="settings-note">Playlists and guides update by themselves every ${ov.refreshHours} hours, on the server, for your account.${ov.lastRefreshAt ? ` Last update: ${new Date(ov.lastRefreshAt).toLocaleString()}.` : ''}</p>
    <h3 class="ltv-set-sub">Guide layout</h3>
    <div class="settings-group ltv-set-group">
      ${sw('showProgramDetails', 'Show Info Panel', 'The panel with the highlighted show’s poster, title, time and description')}
      ${sw('showPreview', 'Show Preview', 'The highlighted channel plays in a small window at the top')}
      ${sw('smallHeader', 'Small Info & Preview', 'A smaller panel at the top, so more channels fit')}
      ${sw('showChannelNumbers', 'Show Channel Numbers', '')}
      ${sw('showChannelLogos', 'Show Channel Logos', '')}
      ${sw('showChannelNames', 'Show Channel Names', '')}
      ${sel('guideSize', 'Guide Size', 'How big the text and rows in the guide are', [['COMPACT', 'Compact'], ['STANDARD', 'Standard'], ['LARGE', 'Large'], ['XLARGE', 'Extra large']])}
      ${sw('showProgramTimes', 'Show Times in the Guide', 'Each show’s start and end time under its title (rows get a little taller)')}
      ${sw('showEpisodeNumbers', 'Show Episode Numbers', 'Episode numbers like “S2 E5” after show titles')}
      ${sw('stripeMissingGuide', 'Mark Channels Without Guide Info', 'Diagonal stripes where the guide has nothing')}
      ${sw('showNowLine', 'Show the Now Line', 'The line marking the current time')}
      ${sw('solidHighlight', 'Solid Highlight', 'Fill the selected show with your theme color instead of outlining it')}
      ${sw('use24HourClock', '24-Hour Clock', '')}
    </div>
    <h3 class="ltv-set-sub">Groups & channels</h3>
    <div class="settings-group ltv-set-group">
      ${sw('showFavoritesGroup', 'Favorites Group', '')}
      ${sw('showRecentGroup', 'Recently Watched Group', '')}
      ${sw('showAllChannelsGroup', 'All Channels Group', '')}
      ${sw('showGroupCounts', 'Show Group Counts', 'How many channels each group has')}
      ${sw('groupPlaylistHeadings', 'Playlist Headings', 'With several playlists, list each one’s groups under a foldable heading')}
      ${sel('channelSort', 'Channel Order', 'How channels are sorted in every group', [['PLAYLIST', 'Playlist order'], ['NUMBER', 'Channel number'], ['NAME', 'Name (A–Z)']])}
      <label class="ltv-select-row"><span><b>Channel Name Cleanup</b><small>Words to take off the start or end of channel names, like USA, 24/7 or FHD, separated by commas</small></span>
        <input type="text" class="ltv-text" data-set="nameRemovals" value="${esc(s.nameRemovals)}" placeholder="USA, US, UK, 24/7, FHD, HD"></label>
      <button class="ltv-set-row" id="ltv-unhide"><span><b>Show Hidden Channels & Groups</b><small>Brings back everything you hid from the guide</small></span></button>
    </div>
    <h3 class="ltv-set-sub">Catch-up & listings</h3>
    <div class="settings-group ltv-set-group">
      ${sw('catchupPreferHls', 'Catch-Up as HLS', 'Asks Xtream providers for replays in HLS (m3u8) first, so the seek bar works. Falls back to TS if the provider doesn’t offer it.')}
      ${sel('catchupShiftMinutes', 'Catch-Up Time Shift', 'If replays start the show before (or after) the one you picked, move the time asked for by that much', shifts)}
      ${sel('epgOffsetMinutes', 'Guide Time Shift', 'Moves all listings earlier or later, for a guide that’s out of step with what’s playing', shifts)}
      ${sel('epgFutureDays', 'Guide Days Ahead', 'How far ahead listings are kept', [1, 2, 3, 4, 5, 7, 10, 14].map((d) => [d, `${d} day${d > 1 ? 's' : ''}`]))}
    </div>`;

  const save = async (changes) => {
    try {
      await ctx.post('/api/iptv/settings', changes);
      if (st.data) { st.data.settings = { ...st.data.settings, ...changes }; applyScale(); if (st.visible) render(); }
      if ('nameRemovals' in changes || 'channelSort' in changes || 'epgOffsetMinutes' in changes) {
        st.programs.clear(); st.loadedFor.clear(); if (st.data) load({ quiet: true });
      }
    } catch (err) { ctx.toast(err.message); }
  };
  box.querySelectorAll('input[type="checkbox"][data-set]').forEach((el) => el.addEventListener('change', () => save({ [el.dataset.set]: el.checked })));
  box.querySelectorAll('select[data-set]').forEach((el) => el.addEventListener('change', () => save({ [el.dataset.set]: isNaN(Number(el.value)) ? el.value : Number(el.value) })));
  box.querySelectorAll('input.ltv-text[data-set]').forEach((el) => el.addEventListener('change', () => save({ [el.dataset.set]: el.value })));

  const again = () => renderSettings(ctx);
  const afterChange = () => { again(); setTimeout(again, 4000); setTimeout(again, 12000); st.programs.clear(); st.loadedFor.clear(); st.data = null; };

  $('#ltv-add-xtream').addEventListener('click', () => form('Add Xtream Codes login', [
    ['name', 'Name', 'My provider'], ['server', 'Server', 'http://host:port'], ['username', 'Username', ''], ['password', 'Password', '', 'password'],
  ], [['importLive', 'Include TV channels', 'Adds the provider’s live channels to the TV guide', true]], async (v) => {
    await ctx.post('/api/iptv/xtream', v); ctx.toast('Signing in and loading channels…'); afterChange();
  }));
  $('#ltv-add-m3u').addEventListener('click', () => form('Add M3U playlist', [
    ['name', 'Name', 'My provider'], ['url', 'Playlist URL', 'http://…/playlist.m3u'], ['userAgent', 'User agent (optional)', 'Leave empty for default'],
  ], [], async (v) => { await ctx.post('/api/iptv/m3u', v); ctx.toast('Loading channels…'); afterChange(); }));
  $('#ltv-add-epg').addEventListener('click', () => form('Add EPG source', [
    ['name', 'Name', 'Guide'], ['url', 'XMLTV URL', 'http://…/epg.xml.gz'],
  ], [], async (v) => { await ctx.post('/api/iptv/epgs', v); ctx.toast('Reading the guide…'); afterChange(); }));
  $('#ltv-update-all').addEventListener('click', async () => { await ctx.post('/api/iptv/refresh'); ctx.toast('Updating playlists and guides…'); afterChange(); });
  $('#ltv-unhide').addEventListener('click', async () => {
    const data = await ctx.api('/api/iptv/channels');
    for (const g of data.hiddenGroups) await ctx.post('/api/iptv/hidden', { group: g.id, hidden: false });
    // Channels: the server clears them all at once.
    await ctx.post('/api/iptv/hidden', { channel: '__all__', hidden: false, all: true });
    ctx.toast('Hidden channels and groups are back'); st.data = null;
  });

  box.querySelectorAll('[data-source]').forEach((el) => el.addEventListener('click', () => {
    const p = ov.sources.find((x) => x.id === el.dataset.source);
    const acc = p.account;
    const actions = [];
    if (acc) actions.push([`Account: ${[acc.status, acc.expiresAtMs ? `Expires ${new Date(acc.expiresAtMs).toLocaleDateString()}` : 'No expiry date', acc.maxConnections ? `${acc.activeConnections} of ${acc.maxConnections} connections in use` : null].filter(Boolean).join(' · ')}`, async () => { await ctx.post(`/api/iptv/sources/${p.id}`, {}); afterChange(); }]);
    actions.push(['Edit', () => {
      if (p.kind === 'xtream') {
        form('Edit Xtream login', [
          ['name', 'Name', '', 'text', p.name], ['server', 'Server', '', 'text', p.server], ['username', 'Username', '', 'text', p.username],
          ['password', 'Password', 'Leave empty to keep the current one', 'password'], ['userAgent', 'User agent (optional)', '', 'text', p.userAgent],
        ], [['importLive', 'Include TV channels', 'Adds the provider’s live channels to the TV guide', p.importLive], ['useEmbeddedEpg', 'Load built-in guide', '', p.useEmbeddedEpg]],
        async (v) => { await ctx.post(`/api/iptv/sources/${p.id}`, v); afterChange(); });
      } else {
        form('Edit playlist', [['name', 'Name', '', 'text', p.name], ['url', 'Playlist URL', '', 'text', p.url], ['userAgent', 'User agent (optional)', '', 'text', p.userAgent]],
          [['useEmbeddedEpg', 'Load the guide linked in the playlist', '', p.useEmbeddedEpg]],
          async (v) => { await ctx.post(`/api/iptv/sources/${p.id}`, v); afterChange(); });
      }
    }]);
    actions.push(['Update now', async () => { await ctx.post(`/api/iptv/sources/${p.id}`, {}); ctx.toast('Updating…'); afterChange(); }]);
    actions.push([p.enabled ? 'Disable' : 'Enable', async () => { await ctx.post(`/api/iptv/sources/${p.id}`, { enabled: !p.enabled }); afterChange(); }]);
    if (p.kind === 'xtream') {
      const next = { auto: 'ts', ts: 'm3u8', m3u8: 'auto' }[p.streamFormat] || 'auto';
      actions.push([`Stream format: ${{ ts: 'TS', m3u8: 'HLS (m3u8)' }[p.streamFormat] || 'Auto'}`, async () => { await ctx.post(`/api/iptv/sources/${p.id}`, { streamFormat: next }); afterChange(); }]);
    }
    actions.push([p.logoSource === 'epg' ? 'Logos: Prefer logos from EPG' : 'Logos: Prefer logos from playlist', async () => {
      await ctx.post(`/api/iptv/sources/${p.id}/logos`, { logoSource: p.logoSource === 'epg' ? 'playlist' : 'epg' }); afterChange();
    }]);
    actions.push(['Move up', async () => { await ctx.post(`/api/iptv/sources/${p.id}/move`, { delta: -1 }); afterChange(); }]);
    actions.push(['Move down', async () => { await ctx.post(`/api/iptv/sources/${p.id}/move`, { delta: 1 }); afterChange(); }]);
    actions.push(['Delete playlist', async () => {
      if (!confirm(`Delete “${p.name}”?`)) return;
      await ctx.api(`/api/iptv/sources/${p.id}`, { method: 'DELETE' }); afterChange();
    }]);
    openMenu(p.name, actions);
  }));
  box.querySelectorAll('[data-epg]').forEach((el) => el.addEventListener('click', () => {
    const e = ov.epgs.find((x) => x.id === el.dataset.epg);
    openMenu(e.name, [
      ['Edit', () => form('Edit EPG source', [['name', 'Name', '', 'text', e.name], ['url', 'XMLTV URL', '', 'text', e.url]], [],
        async (v) => { await ctx.post(`/api/iptv/epgs/${e.id}`, v); afterChange(); })],
      [e.enabled ? 'Disable' : 'Enable', async () => { await ctx.post(`/api/iptv/epgs/${e.id}`, { enabled: !e.enabled }); afterChange(); }],
      ['Delete guide', async () => { if (!confirm(`Delete “${e.name}”?`)) return; await ctx.api(`/api/iptv/epgs/${e.id}`, { method: 'DELETE' }); afterChange(); }],
    ]);
  }));
}

// A form dialog: text fields, then switches. Save and Cancel stay in view.
function form(title, fields, toggles, onSave) {
  const menu = $('#ltv-menu');
  menu.innerHTML = `<form class="ltv-form" autocomplete="off">
    <h3 class="ltv-menu-title">${esc(title)}</h3>
    <div class="ltv-form-fields">
      ${fields.map(([k, label, hint, type = 'text', value = '']) => `<label class="ltv-field"><span>${esc(label)}</span>
        <input name="${k}" type="${type}" placeholder="${esc(hint)}" value="${esc(value)}" ${type === 'password' ? 'autocomplete="new-password"' : ''}></label>`).join('')}
      ${toggles.map(([k, label, sub, on]) => `<label class="switch-row"><span><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span><input type="checkbox" name="${k}" ${on ? 'checked' : ''}></label>`).join('')}
    </div>
    <p class="form-error" hidden></p>
    <div class="ltv-form-actions"><button type="button" class="btn-ghost" data-cancel>Cancel</button><button type="submit" class="btn-primary">Save</button></div>
  </form>`;
  const f = menu.querySelector('form');
  f.querySelector('[data-cancel]').addEventListener('click', closeMenu);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = {};
    for (const [k] of fields) { const val = f.elements[k].value.trim(); if (val || k !== 'password') v[k] = val; }
    for (const [k] of toggles) v[k] = f.elements[k].checked;
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    try { await onSave(v); closeMenu(); } catch (err) {
      const p = f.querySelector('.form-error'); p.textContent = err.message; p.hidden = false; btn.disabled = false;
    }
  });
  menu.onkeydown = (e) => { if (e.key === 'Escape') closeMenu(); };
  menu.hidden = false;
  $('#ltv-menu-backdrop').hidden = false;
  lockPage();
  setTimeout(() => f.querySelector('input')?.focus(), 30);
}


// --------------------------------------------------------------- home row

// Your Live TV favorites on the home screen, first, like the TV app's Live
// TV row: a card per channel with its logo, what's on and how far in, and
// the channel. A click plays it.
export async function homeRow(ctx) {
  st.ctx ||= ctx;
  let data;
  try { data = await ctx.api('/api/iptv/home'); } catch { return null; }
  if (!data.entries?.length) return null;
  const section = document.createElement('section');
  section.className = 'row ltv-home-row';
  section.innerHTML = `<div class="row-head"><h2 class="row-title"><span class="ltv-home-dot"></span>${esc(data.title)}</h2>
      <button class="row-source" aria-label="Open the guide"><svg viewBox="0 0 24 24"><path d="M9 5.5 15.5 12 9 18.5 7.6 17.1 12.7 12 7.6 6.9z"/></svg></button></div>
    <div class="rail-wrap"><div class="rail ltv-home-rail"></div></div>`;
  section.querySelector('.row-head').addEventListener('click', () => ctx.openGuide());
  const rail = section.querySelector('.rail');
  const now = Date.now();
  for (const e of data.entries) {
    const ch = e.channel;
    const card = document.createElement('button');
    card.className = 'ltv-home-card';
    const left = e.now ? minutesLeft(e.now.e, now) : '';
    card.innerHTML = `${logoHtml(ch, 'ltv-home-logo')}
      <span class="ltv-home-text">
        <b>${esc(e.now ? marks(e.now.t).title : ch.name)}</b>
        ${e.now ? `<span class="ltv-home-bar"><span style="width:${Math.min(100, ((now - e.now.s) / Math.max(1, e.now.e - e.now.s)) * 100)}%"></span></span>` : ''}
        <small><span class="ltv-home-ch">${esc(`${ch.number}  ${ch.name}`)}</span>${left ? `<span class="ltv-home-left"> · ${esc(left)}</span>` : ''}</small>
      </span>`;
    card.title = e.next ? `Next: ${clock(e.next.s)} ${e.next.t}` : '';
    card.addEventListener('click', () => {
      st.byKey.set(ch.key, ch);
      fullscreen(ch, null, e.now);
    });
    rail.append(card);
  }
  return section;
}

// Touch long press → contextmenu on the element under the finger. iOS Safari
// never fires contextmenu itself, and Android fires one we may already have
// sent, so dedupe; also swallow the click that follows lifting the finger.
// The target is looked up when the timer fires, since the guide may have
// re-rendered its rows while the finger was down.
function onLongPress(el, ms = 500) {
  let timer = null, sx = 0, sy = 0, fired = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('touchstart', (e) => {
    cancel();
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    timer = setTimeout(() => {
      timer = null;
      const target = document.elementFromPoint(sx, sy);
      if (!target || !el.contains(target)) return;
      fired = Date.now();
      try { navigator.vibrate?.(15); } catch { /* not supported */ }
      target.dispatchEvent(new MouseEvent('contextmenu', { clientX: sx, clientY: sy, bubbles: true, cancelable: true }));
    }, ms);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (timer && t && Math.hypot(t.clientX - sx, t.clientY - sy) > 10) cancel();
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    cancel();
    // Lifting after a long press: no click, no text selection.
    if (Date.now() - fired < 1000 && e.cancelable) e.preventDefault();
  });
  ['touchcancel', 'scroll'].forEach((t) => el.addEventListener(t, cancel, { passive: true }));
  el.addEventListener('contextmenu', (e) => {
    if (!e.isTrusted) return;
    // Android's own long-press menu event beat our timer: let it through.
    if (timer) { cancel(); fired = Date.now(); return; }
    if (Date.now() - fired < 1000) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  el.addEventListener('click', (e) => {
    if (Date.now() - fired < 1000) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}

// Shrinks a one-line title until it fits its box (down to 60% of its normal
// size); anything still too long ends in an ellipsis.
function fitTitle(el) {
  if (!el) return;
  el.style.fontSize = ''; el.style.lineHeight = '';
  const base = parseFloat(getComputedStyle(el).fontSize);
  if (!el.clientWidth || el.scrollWidth <= el.clientWidth) return;
  let size = base * Math.max(0.6, el.clientWidth / el.scrollWidth);
  el.style.fontSize = `${size}px`; el.style.lineHeight = '1.2';
  while (el.scrollWidth > el.clientWidth && size > base * 0.6) {
    size -= 1; el.style.fontSize = `${size}px`;
  }
}

// While a menu is open, nothing behind it may move. In an iOS home-screen app
// a drag (or the end of a long press) otherwise rubber-bands the whole page,
// fixed menu included. Only a menu that actually has more to show scrolls.
let pageLock = null;
function lockPage() {
  if (pageLock) return;
  const y = window.scrollY;
  const onMove = (e) => {
    const menu = e.target.closest?.('.ltv-menu');
    if (menu && menu.scrollHeight > menu.clientHeight) return;
    if (e.cancelable) e.preventDefault();
  };
  const onScroll = () => { if (window.scrollY !== y) window.scrollTo(0, y); };
  document.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('scroll', onScroll);
  document.documentElement.classList.add('ltv-locked');
  pageLock = () => {
    document.removeEventListener('touchmove', onMove);
    window.removeEventListener('scroll', onScroll);
    document.documentElement.classList.remove('ltv-locked');
  };
}
function unlockPage() { pageLock?.(); pageLock = null; }
