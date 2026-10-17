import * as platform from './platform.js?v=90';
import * as player from './player.js?v=90';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const THEMES = ['White', 'Gold', 'Jade', 'RoseGold', 'ArcticBlue', 'Graphite',
                'Crimson', 'Ocean', 'Violet', 'Emerald', 'Amber', 'Rose'];

const state = { profiles: [], profile: null, session: null, homeLoaded: false, libraryLoaded: false };
let prefs = { autoplay: false, binge: false, quality: 'any', audioLang: '', subLang: '' };
let languageOptions = [];
const QUALITIES = [['any', 'Any'], ['2160p', '4K'], ['1080p', '1080p'], ['720p', '720p']];

// ------------------------------------------------------------------ util

async function api(path, options) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function post(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

// Opening a title, backing out and opening it again shouldn't re-ask every
// addon. The promise is cached rather than the result, so two things asking
// at once make one request between them; a failure drops out so a retry is a
// real retry.
const metaCache = new Map();

function fetchMeta(type, id) {
  const key = `${type}:${id}`;
  if (metaCache.has(key)) return metaCache.get(key);

  const pending = api(`/api/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}`)
    .catch((err) => { metaCache.delete(key); throw err; });
  metaCache.set(key, pending);
  return pending;
}

// Grey blocks in the shape of what's coming, rather than the word "Loading".
// The page stops moving underneath you when the real content lands, because
// it was already the right size.
function skeleton(container, { kind = 'poster', count = 8 } = {}) {
  container.innerHTML = '';
  const holder = document.createElement('div');
  holder.className = kind === 'poster' ? 'skeleton-grid' : 'skeleton-list';
  for (let i = 0; i < count; i += 1) {
    const block = document.createElement('div');
    block.className = `skeleton skeleton-${kind}`;
    holder.append(block);
  }
  container.append(holder);
}

function toast(message, ms = 3000) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, ms);
}

// The details page, the catalog and the sheets are screens as far as anyone
// using the app is concerned, so the browser's back button should close them
// rather than leave the app. Each one pushes a history entry on the way in;
// back pops it and runs the matching close.
//
// Anything that closes an overlay by other means — its own back button, the
// escape key, tapping the backdrop — goes through history.back() too, so the
// stack never drifts out of step with what is on screen.
const overlays = [];

function pushOverlay(close) {
  overlays.push(close);
  // No URL change: the entry exists purely so there is something to pop.
  history.pushState({ nuvio: overlays.length }, '');
}

function closeTopOverlay() {
  const close = overlays.pop();
  if (close) close();
}

window.addEventListener('popstate', () => {
  if (skipNextPop) { skipNextPop = false; return; }
  // The phone's back gesture while the in-page player is open closes it.
  if (inPagePlayer) {
    inPagePlayer = false;
    player.unmount();
    refreshContinueRow();
    document.title = 'Nuvio';
    return;
  }
  // Opened as its own page (/watch): leaving is an ordinary navigation.
  if (!$('#screen-watch').hidden) return;
  closeTopOverlay();
});

function screen(which) {
  $('#screen-watch').hidden = which !== 'watch';
  $('#screen-auth').hidden = which !== 'auth';
  $('#screen-profiles').hidden = which !== 'profiles';
  $('#screen-details').hidden = which !== 'details';
  $('#screen-catalog').hidden = which !== 'catalog';
  $('#shell').hidden = which !== 'shell';
  window.scrollTo(0, 0);
}

function setTheme(name) {
  document.body.dataset.theme = THEMES.includes(name) ? name : 'White';
}

// ------------------------------------------------------------------ auth

let mode = 'login';

$('#signup-toggle').addEventListener('click', () => {
  mode = mode === 'login' ? 'signup' : 'login';
  $('#login-form button[type=submit]').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('#signup-toggle').textContent = mode === 'login' ? 'Create an account' : 'I already have an account';
  $('#login-error').hidden = true;
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = new FormData(e.target);
  const button = e.target.querySelector('button[type=submit]');
  const error = $('#login-error');
  const label = button.textContent;

  error.hidden = true;
  button.disabled = true;
  button.textContent = mode === 'login' ? 'Signing in…' : 'Creating…';

  try {
    const body = {
      email: data.get('email'),
      password: data.get('password'),
      // Unchecked means a cookie with no expiry: closing the browser ends it.
      remember: $('#stay-signed-in').checked,
    };
    const result = await post(mode === 'login' ? '/api/login' : '/api/signup', body);
    // Offer the password to the browser's own manager. A form submitted over
    // fetch never navigates, and without a navigation Chrome's heuristics
    // often don't notice a sign-in happened — so it is told outright. Storing
    // it here rather than ourselves is the point: the browser has a keychain
    // built for this, and an app holding onto passwords does not.
    await offerToRemember(e.target);

    if (result.confirmationRequired) {
      toast('Check your email to confirm the account, then sign in.', 7000);
      return;
    }
    await boot();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});

$('#signout').addEventListener('click', async () => {
  await post('/api/logout');
  location.reload();
});

$('#switch-profile').addEventListener('click', () => showProfiles());

// -------------------------------------------------------------- profiles

async function showProfiles() {
  state.profiles = await takeProfiles().catch(() => []);

  // One profile and nothing to choose: don't make them tap through a picker.
  if (state.profiles.length <= 1) return selectProfile(state.profiles[0] || { index: 1, name: 'Profile' });

  const grid = $('#profile-grid');
  grid.innerHTML = '';
  for (const p of state.profiles) {
    const card = document.createElement('button');
    card.className = 'profile-card';
    card.innerHTML = `<span class="avatar"></span><span class="profile-name"></span>`;
    const avatar = card.querySelector('.avatar');
    if (p.avatarUrl) avatar.style.backgroundImage = `url("${p.avatarUrl}")`;
    else { avatar.style.background = p.avatarColor; avatar.textContent = p.name.charAt(0).toUpperCase(); }
    card.querySelector('.profile-name').textContent = p.name;
    card.addEventListener('click', () => selectProfile(p));
    grid.append(card);
  }
  screen('profiles');
}

const VISIT_KEY = 'nuvio.profileChosen';
function profileChosenThisVisit() {
  try { return sessionStorage.getItem(VISIT_KEY) === '1'; } catch { return false; }
}

async function selectProfile(profile) {
  state.profile = profile;
  try { sessionStorage.setItem(VISIT_KEY, '1'); } catch { /* private mode */ }
  await post('/api/profile', { index: profile.index });
  state.homeLoaded = false;
  state.libraryLoaded = false;

  paintProfile(profile);
  screen('shell');
  goto('Home');
}

// The avatar and the name, wherever they appear. Shared with boot, which
// restores a profile that was chosen on an earlier visit and so never goes
// through selectProfile.
function paintProfile(profile) {
  if (!profile) return;

  const avatar = $('#tab-avatar');
  if (profile.avatarUrl) {
    avatar.style.backgroundImage = `url("${profile.avatarUrl}")`;
  } else {
    avatar.style.background = profile.avatarColor || '#1E88E5';
    avatar.textContent = (profile.name || '?').charAt(0).toUpperCase();
  }

  $('#settings-profile').textContent = profile.name || `Profile ${profile.index}`;
}

// ------------------------------------------------------------------ tabs

function goto(tab) {
  $$('.tab').forEach((el) => { el.hidden = el.dataset.tab !== tab; });
  $$('.tab-item').forEach((el) => el.setAttribute('aria-selected', String(el.dataset.goto === tab)));
  window.scrollTo(0, 0);

  if (tab === 'Home' && !state.homeLoaded) loadHome();
  if (tab === 'Library' && !state.libraryLoaded) loadLibrary();
  if (tab === 'Search') $('#search-form input').focus();
}

$$('.tab-item').forEach((el) => el.addEventListener('click', () => goto(el.dataset.goto)));

// ------------------------------------------------------------------ home

async function loadHome() {
  const rows = $('#home-rows');
  skeleton(rows, { count: 12 });

  try {
    // Boot may already have asked for these, alongside the session.
    const early = prefetched.home;
    prefetched.home = null;
    const [data, watching] = await (early || Promise.all([
      api('/api/home'),
      api('/api/progress').catch(() => []),
    ]));
    state.homeLoaded = true;
    rows.innerHTML = '';

    renderHero(data.hero);
    if (watching.length) rows.append(renderContinueRow(watching));

    // Collections sit above catalog rows, as they do in the app.
    for (const collection of data.collections || []) {
      rows.append(renderCollectionRow(collection));
    }
    for (const row of data.rows) rows.append(renderRow(row, row.items));

    if (!data.rows.length && !(data.collections || []).length) {
      rows.innerHTML = '<p class="empty">No addons returned anything. Check that this profile has addons installed in Nuvio.</p>';
    }
  } catch (err) {
    rows.innerHTML = `<p class="empty">${err.message}</p>`;
  }
}

// The banner is a swipeable pager over eight titles pooled from the catalog
// rows, auto-advancing every 8 seconds — matching HomeHeroSection.kt. Native
// scroll-snap does the paging, so the gesture feels right on iOS without any
// touch handling of our own.
const HERO_INTERVAL_MS = 8000;
let heroTimer = null;
let heroItems = [];

function renderHero(items) {
  const hero = $('#hero');
  const track = $('#hero-track');
  const dots = $('#hero-dots');

  clearInterval(heroTimer);
  heroItems = (items || []).filter((i) => i.background || i.poster);
  track.innerHTML = '';
  dots.innerHTML = '';

  if (!heroItems.length) { hero.hidden = true; return; }
  hero.hidden = false;

  for (const item of heroItems) track.append(heroSlide(item));

  if (heroItems.length > 1) {
    heroItems.forEach((_, i) => {
      const dot = document.createElement('button');
      dot.className = 'hero-dot';
      dot.setAttribute('aria-label', `Go to item ${i + 1}`);
      dot.addEventListener('click', () => scrollHeroTo(i));
      dots.append(dot);
    });
    startHeroTimer();
  }

  markHeroActive(0);

  // Paging by hand should reset the clock, not fight it.
  track.addEventListener('scroll', () => {
    const index = Math.round(track.scrollLeft / track.clientWidth);
    markHeroActive(index);
    collapseHeroPanels();
    startHeroTimer();
  }, { passive: true });
}

function heroSlide(item) {
  const slide = document.createElement('div');
  slide.className = 'hero-slide';
  slide.style.backgroundImage = `url("${item.background || item.poster}")`;
  slide.innerHTML = `
    <div class="hero-content">
      <p class="hero-source"></p>
      <h2 class="hero-title"></h2>
      <div class="hero-meta"></div>
      <div class="hero-more" hidden>
        <p class="hero-desc"></p>
        <p class="hero-genres"></p>
      </div>
      <div class="hero-actions">
        <button class="hero-play">View Details</button>
        <button class="hero-toggle" aria-expanded="false" aria-label="More info">
          <svg viewBox="0 0 24 24"><path d="M12 15.4 5.6 9l1.4-1.4 5 5 5-5L18.4 9z"/></svg>
        </button>
      </div>
    </div>`;

  // Says which row this came from — "Popular - Movies", "Top Rated - Series".
  const source = slide.querySelector('.hero-source');
  source.textContent = item.source || '';
  source.hidden = !item.source;

  slide.querySelector('.hero-title').textContent = item.name;

  const meta = slide.querySelector('.hero-meta');
  const facts = [
    item.type ? item.type.charAt(0).toUpperCase() + item.type.slice(1) : null,
    item.year,
    item.imdbRating ? `★ ${item.imdbRating}` : null,
  ].filter(Boolean);
  facts.forEach((text, i) => {
    if (i) meta.insertAdjacentHTML('beforeend', '<span class="dot"></span>');
    const span = document.createElement('span');
    span.textContent = text;
    meta.append(span);
  });

  // The whole slide is tappable, not just the button.
  const open = () => openDetails(item);
  slide.querySelector('.hero-play').addEventListener('click', open);
  slide.querySelector('.hero-title').addEventListener('click', open);

  slide.querySelector('.hero-toggle').addEventListener('click', (e) => {
    toggleHeroMore(slide, item, e.currentTarget);
  });

  return slide;
}

// Expanding shows the synopsis in place rather than making you open the
// details page to find out what something is. Catalog responses often omit
// the description, so it's fetched on first expand and kept on the item.
async function toggleHeroMore(slide, item, button) {
  const panel = slide.querySelector('.hero-more');
  const expanded = button.getAttribute('aria-expanded') === 'true';

  if (expanded) {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    startHeroTimer();
    return;
  }

  // Collapse any other slide that's open, so the pager keeps one height.
  for (const other of $$('.hero-slide')) {
    if (other === slide) continue;
    other.querySelector('.hero-more').hidden = true;
    other.querySelector('.hero-toggle').setAttribute('aria-expanded', 'false');
  }

  panel.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  // Reading shouldn't be interrupted by the banner sliding away.
  clearInterval(heroTimer);

  const desc = slide.querySelector('.hero-desc');
  const genres = slide.querySelector('.hero-genres');

  if (item.description || item.genres?.length) {
    desc.textContent = item.description || '';
    genres.textContent = (item.genres || []).slice(0, 4).join(' · ');
    genres.hidden = !genres.textContent;
    return;
  }

  desc.textContent = 'Loading…';
  genres.hidden = true;
  try {
    const baseId = String(item.id).split(':')[0];
    const meta = await fetchMeta(item.type, baseId);
    item.description = meta.description || 'No description available.';
    item.genres = meta.genres || [];
    desc.textContent = item.description;
    genres.textContent = item.genres.slice(0, 4).join(' · ');
    genres.hidden = !genres.textContent;
  } catch {
    desc.textContent = 'No description available.';
  }
}

function collapseHeroPanels() {
  for (const slide of $$('.hero-slide')) {
    const panel = slide.querySelector('.hero-more');
    if (panel.hidden) continue;
    panel.hidden = true;
    slide.querySelector('.hero-toggle').setAttribute('aria-expanded', 'false');
  }
}

function scrollHeroTo(index) {
  const track = $('#hero-track');
  track.scrollTo({ left: index * track.clientWidth, behavior: 'smooth' });
}

function markHeroActive(index) {
  const dots = [...$('#hero-dots').children];
  dots.forEach((dot, i) => dot.setAttribute('aria-current', String(i === index)));
}

function startHeroTimer() {
  clearInterval(heroTimer);
  if (heroItems.length <= 1) return;
  heroTimer = setInterval(() => {
    // Don't yank the banner while the person is reading something else.
    if (document.hidden || $('#screen-details').hidden === false) return;
    const track = $('#hero-track');
    const current = Math.round(track.scrollLeft / track.clientWidth);
    scrollHeroTo((current + 1) % heroItems.length);
  }, HERO_INTERVAL_MS);
}

// ------------------------------------------------- continue watching

// Where this profile left off, newest first: films part-watched, and for
// shows the episode in progress or the next one up. One tap resumes.
function renderContinueRow(entries) {
  const section = document.createElement('section');
  section.className = 'row row-continue';
  section.innerHTML = `<div class="row-head"><h2 class="row-title">Continue watching</h2></div>
    <div class="rail-wrap"><div class="rail"></div>${railArrows()}</div>`;
  const rail = section.querySelector('.rail');
  for (const entry of entries) rail.append(continueCard(entry, section));
  wireRailArrows(section);
  return section;
}

function continueCard(entry, section) {
  const card = document.createElement('div');
  card.className = 'cw-card';
  const art = entry.background || entry.poster || '';
  const code = entry.season != null && entry.episode != null ? `S${entry.season} · E${entry.episode}` : '';
  const left = entry.duration ? Math.max(0, Math.round((entry.duration - entry.position) / 60)) : 0;
  const detail = entry.live ? 'Live TV'
    : entry.upNext ? `Next · ${code}`
      : [code, left ? `${left} min left` : ''].filter(Boolean).join(' · ');
  card.innerHTML = `
    <button class="cw-play" aria-label="Resume">
      <span class="cw-art"></span>
      <span class="cw-shade"></span>
      <span class="cw-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.6-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z"/></svg></span>
      <span class="cw-bar"><span class="cw-fill"></span></span>
    </button>
    <button class="cw-remove" aria-label="Remove from Continue watching"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/></svg></button>
    <p class="cw-title"></p>
    <p class="cw-detail"></p>`;
  if (art) card.querySelector('.cw-art').style.backgroundImage = `url("${art}")`;
  card.querySelector('.cw-fill').style.width = entry.upNext || !entry.duration
    ? '0%' : `${Math.min(100, (entry.position / entry.duration) * 100)}%`;
  card.querySelector('.cw-title').textContent = entry.name || 'Untitled';
  card.querySelector('.cw-detail').textContent = detail;
  if (entry.live) {
    card.classList.add('cw-live');
    card.querySelector('.cw-bar').replaceWith(Object.assign(document.createElement('span'), {
      className: 'cw-live-badge', innerHTML: '<span class="watch-live-dot"></span>LIVE',
    }));
  }

  card.querySelector('.cw-play').addEventListener('click', () => {
    if (platform.resolve() === 'browser') openInPage(entry.type, entry.id);
    else start(entry.type, entry.id, entry.name || '');
  });
  card.querySelector('.cw-remove').addEventListener('click', async () => {
    card.remove();
    if (!section.querySelector('.cw-card')) section.remove();
    await fetch(`/api/progress/${encodeURIComponent(entry.id)}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
  });
  return card;
}

function renderRow(row, items) {
  const section = document.createElement('section');
  section.className = 'row';
  // The app puts a circular chevron pill here, not the addon name. It opens
  // the full catalog — and is hidden when the row has no catalog behind it,
  // which is what the app does with an alpha-0 placeholder.
  section.innerHTML = `<div class="row-head">
      <h2 class="row-title"></h2>
      <button class="row-source" aria-label="View all"><svg viewBox="0 0 24 24"><path d="M9 5.5 15.5 12 9 18.5 7.6 17.1 12.7 12 7.6 6.9z"/></svg></button>
    </div><div class="rail-wrap"><div class="rail"></div>${railArrows()}</div>`;
  section.querySelector('.row-title').textContent = row.name;

  const pill = section.querySelector('.row-source');
  if (row.collection) pill.hidden = true;
  if (row.transportUrl) {
    pill.addEventListener('click', () => openCatalog(row));
    section.querySelector('.row-head').addEventListener('click', (e) => {
      if (e.target.closest('.row-source')) return;
      openCatalog(row);
    });
  } else {
    pill.hidden = true;
  }
  const rail = section.querySelector('.rail');
  for (const item of items) rail.append(poster(item));
  wireRailArrows(section);
  return section;
}

// A finger flicks a rail; a mouse has nothing to flick with. These are hidden
// on touch devices, where they would just cover two posters.
function railArrows() {
  return `<button class="rail-arrow left" aria-label="Scroll left"><svg viewBox="0 0 24 24"><path d="M15.4 4.6 14 3.2 5.2 12l8.8 8.8 1.4-1.4L8 12z"/></svg></button>
    <button class="rail-arrow right" aria-label="Scroll right"><svg viewBox="0 0 24 24"><path d="M9 5.5 15.5 12 9 18.5 7.6 17.1 12.7 12 7.6 6.9z"/></svg></button>`;
}

function wireRailArrows(section) {
  const rail = section.querySelector('.rail');
  const wrap = section.querySelector('.rail-wrap');
  if (!rail || !wrap) return;

  // Paging by a fraction of the width leaves a card sliced down the middle at
  // the edge. Stepping by a whole number of cards lands cleanly every time.
  const page = (direction) => {
    const card = rail.firstElementChild;
    const step = card
      ? card.getBoundingClientRect().width + parseFloat(getComputedStyle(rail).gap || 0)
      : rail.clientWidth * 0.8;
    const cards = Math.max(1, Math.floor((rail.clientWidth / step) - 0.4));
    rail.scrollBy({ left: direction * step * cards, behavior: 'smooth' });
  };
  wrap.querySelector('.rail-arrow.left').addEventListener('click', () => page(-1));
  wrap.querySelector('.rail-arrow.right').addEventListener('click', () => page(1));

  // An arrow pointing at nothing is worse than no arrow.
  const update = () => {
    wrap.classList.toggle('at-start', rail.scrollLeft < 8);
    wrap.classList.toggle('at-end', rail.scrollLeft > rail.scrollWidth - rail.clientWidth - 8);
  };
  rail.addEventListener('scroll', update, { passive: true });
  requestAnimationFrame(update);
}

// A collection row shows its folders as cover tiles — the "Streaming" and
// "Genres" rows. Tapping one opens what's inside.
function renderCollectionRow(collection) {
  const section = document.createElement('section');
  section.className = 'row';
  section.innerHTML = `<div class="row-head"><h2 class="row-title"></h2></div>
    <div class="rail-wrap"><div class="rail folders"></div>${railArrows()}</div>`;
  section.querySelector('.row-title').textContent = collection.name;

  const rail = section.querySelector('.rail');
  for (const folder of collection.folders) rail.append(folderTile(collection, folder));
  wireRailArrows(section);
  return section;
}

function folderTile(collection, folder) {
  const b = document.createElement('button');
  const shape = ['poster', 'landscape', 'square'].includes(folder.tileShape) ? folder.tileShape : 'poster';
  b.className = `poster folder shape-${shape}`;
  b.innerHTML = `<div class="art"></div>${folder.hideTitle ? '' : '<div class="label"></div>'}`;

  const art = b.querySelector('.art');
  if (folder.cover) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = folder.cover;
    img.addEventListener('error', () => img.replaceWith(folderFallback(folder)), { once: true });
    art.append(img);
  } else {
    art.append(folderFallback(folder));
  }

  if (!folder.hideTitle) b.querySelector('.label').textContent = folder.title;
  b.addEventListener('click', () => openFolder(collection, folder));
  return b;
}

// The app falls back to the folder's emoji, then its first two letters.
function folderFallback(folder) {
  const span = document.createElement('span');
  span.className = 'art-fallback';
  span.textContent = folder.coverEmoji || folder.title.slice(0, 2).toUpperCase();
  return span;
}

async function openFolder(collection, folder) {
  catalogCursor = null;
  $('#catalog-title').textContent = folder.title;
  $('#catalog-genres').hidden = true;
  $('#catalog-more').hidden = true;
  skeleton($('#catalog-grid'), { count: 12 });
  pushOverlay(() => screen('shell'));
  screen('catalog');

  try {
    const data = await api(`/api/collection/${encodeURIComponent(collection.id)}/${encodeURIComponent(folder.id)}`);
    $('#catalog-grid').innerHTML = '';
    if (!data.items.length) {
      $('#catalog-grid').innerHTML = '<p class="empty">Nothing in this folder right now.</p>';
      return;
    }
    for (const item of data.items) $('#catalog-grid').append(poster(item));
  } catch (err) {
    const box = $('#catalog-grid');
    box.innerHTML = '';
    const msg = Object.assign(document.createElement('p'), { className: 'empty', textContent: err.message });
    const retry = Object.assign(document.createElement('button'), { className: 'btn-ghost', textContent: 'Try again' });
    retry.addEventListener('click', () => { closeTopOverlay?.(); openFolder(collection, folder); });
    box.append(msg, retry);
  }
}

function poster(item) {
  const b = document.createElement('button');
  b.className = 'poster';
  // Addons say what shape their artwork is. Live TV channels are square
  // station logos; cropping them to a movie poster would cut the logo off.
  const shape = String(item.posterShape || 'poster').toLowerCase();
  if (shape === 'square' || shape === 'landscape') b.classList.add(`shape-${shape}`);
  const art = item.poster || item.background;

  b.innerHTML = `<div class="art">${art ? '<img loading="lazy" alt="">' : '<span class="art-fallback"></span>'}</div><div class="label"></div>`;

  const title = item.name || item.parentId || item.id;
  b.querySelector('.label').textContent = title;

  if (art) {
    // A dead poster URL should leave initials behind, not a broken-image icon.
    const img = b.querySelector('img');
    img.src = art;
    img.addEventListener('error', () => {
      img.replaceWith(Object.assign(document.createElement('span'), {
        className: 'art-fallback', textContent: initialsOf(title),
      }));
    }, { once: true });
  } else {
    b.querySelector('.art-fallback').textContent = initialsOf(title);
  }

  b.addEventListener('click', () => openDetails(item));
  return b;
}

function initialsOf(text) {
  return String(text).replace(/^tt\d+$/, '?')
    .split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('');
}

// --------------------------------------------------------------- library

async function loadLibrary() {
  const grid = $('#library-grid');
  skeleton(grid, { count: 12 });
  try {
    const items = await api('/api/library');
    state.libraryLoaded = true;
    grid.innerHTML = '';
    if (!items.length) { grid.innerHTML = '<p class="empty">Your library is empty.</p>'; return; }
    for (const item of items) grid.append(poster(item));
  } catch (err) {
    grid.innerHTML = `<p class="empty">${err.message}</p>`;
  }
}

// ---------------------------------------------------------------- search

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = new FormData(e.target).get('q').trim();
  if (!q) return;
  document.activeElement?.blur();

  const grid = $('#search-results');
  skeleton(grid, { count: 12 });
  try {
    const items = await api(`/api/search?q=${encodeURIComponent(q)}`);
    grid.innerHTML = '';
    if (!items.length) { grid.innerHTML = '<p class="empty">Nothing found.</p>'; return; }
    for (const item of items) grid.append(poster(item));
  } catch (err) {
    grid.innerHTML = `<p class="empty">${err.message}</p>`;
  }
});

// ---------------------------------------------------------------- catalog

// "View all" opens the catalog as a paged grid. Addons return one page at a
// time, so `skip` walks forward and the button retires once a page comes
// back short of a full batch.
let catalogCursor = null;

async function openCatalog(row) {
  catalogCursor = { row, skip: 0, genre: row.genreRequired ? (row.genres || [])[0] : null };
  $('#catalog-title').textContent = row.name;
  skeleton($('#catalog-grid'), { count: 12 });
  $('#catalog-more').hidden = true;
  renderGenres(row);
  pushOverlay(() => screen('shell'));
  screen('catalog');
  await loadCatalogPage(true);
}

// Some catalogs advertise genres, and a few refuse to answer without one.
function renderGenres(row) {
  const bar = $('#catalog-genres');
  bar.innerHTML = '';
  const genres = row.genres || [];
  bar.hidden = genres.length === 0;
  if (!genres.length) return;

  const options = row.genreRequired ? genres : [null, ...genres];
  for (const genre of options) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = genre || 'All';
    chip.setAttribute('aria-pressed', String(catalogCursor.genre === genre));
    chip.addEventListener('click', () => {
      catalogCursor.genre = genre;
      catalogCursor.skip = 0;
      bar.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
      loadCatalogPage(true);
    });
    bar.append(chip);
  }
}

async function loadCatalogPage(replace = false) {
  const { row, skip } = catalogCursor;
  const grid = $('#catalog-grid');
  const more = $('#catalog-more');
  more.disabled = true;

  try {
    const query = new URLSearchParams({
      transportUrl: row.transportUrl, type: row.type, id: row.id, skip: String(skip),
    });
    if (catalogCursor.genre) query.set('genre', catalogCursor.genre);
    const items = await api(`/api/catalog?${query}`);
    if (replace) grid.innerHTML = '';
    if (!items.length) {
      if (replace) grid.innerHTML = '<p class="empty">This catalog came back empty.</p>';
      more.hidden = true;
      return;
    }
    for (const item of items) grid.append(poster(item));

    catalogCursor.skip = skip + items.length;
    more.hidden = items.length < 20;
  } catch (err) {
    if (replace) grid.innerHTML = `<p class="empty">${err.message}</p>`;
    else toast(err.message);
  } finally {
    more.disabled = false;
  }
}

$('#catalog-back').addEventListener('click', () => history.back());
$('#catalog-more').addEventListener('click', () => loadCatalogPage(false));

// --------------------------------------------------------------- details

$('#details-back').addEventListener('click', () => history.back());
$('#details-desc').addEventListener('click', (e) => e.currentTarget.classList.toggle('open'));

async function openDetails(item) {
  const type = item.type || 'movie';
  const baseId = (item.parentId || item.id).split(':')[0];

  pushOverlay(() => screen('shell'));
  screen('details');
  setBackdrop(item.background, item.poster);
  $('#details-title').textContent = item.name || baseId;
  $('#details-meta').textContent = '';
  $('#details-desc').textContent = '';
  $('#details-genres').hidden = true;
  $('#details-credits').hidden = true;
  $('#season-picker').innerHTML = '';
  $('#details-actions').innerHTML = '';
  $('#season-summary').textContent = '';
  if (type === 'series') skeleton($('#episode-list'), { kind: 'episode', count: 6 });
  else $('#episode-list').innerHTML = '';
  setupLibraryButton(item, type);

  // A movie has one thing to play, so it gets a Play button. A series shows
  // its episode list instead — except when a continue-watching card handed
  // us an exact episode id, which is already playable on its own.
  const isEpisode = type === 'series' && item.id.split(':').length >= 3;
  if (type !== 'series' || isEpisode) {
    const play = document.createElement('button');
    play.className = 'play-button';
    play.textContent = 'Play';
    play.addEventListener('click', () => start(type, item.id, item.name));
    $('#details-actions').append(play);
  }

  try {
    const meta = await fetchMeta(type, baseId);

    // `partial` means no addon could identify this id. Keep whatever the
    // catalog card already gave us rather than blanking the page.
    if (!meta.partial) {
      $('#details-title').textContent = meta.name;
      $('#details-meta').textContent = [
        typeLabel(meta.type || type),
        meta.year,
        runtimeOf(meta.runtime),
        meta.imdbRating ? `★ ${meta.imdbRating}` : null,
        meta.status && meta.status !== 'Ended' ? meta.status : null,
      ].filter(Boolean).join('  ·  ');
      $('#details-desc').textContent = meta.description || '';
      $('#details-desc').classList.remove('open');
      renderGenreChips(meta.genres);
      renderCredits(meta);
    }
    if (libraryItem) {
      libraryItem.description = meta.description || null;
      libraryItem.genres = meta.genres || [];
      libraryItem.poster = libraryItem.poster || meta.poster || null;
      libraryItem.background = libraryItem.background || meta.background || null;
      libraryItem.year = libraryItem.year || meta.year || null;
      libraryItem.imdbRating = libraryItem.imdbRating || meta.imdbRating || null;
    }
    setBackdrop(meta.background, meta.poster || item.poster);
    if (meta.videos?.length) renderSeasons(meta.videos, item.id);
    else $('#episode-list').innerHTML = type === 'series'
      ? '<p class="empty">No addon has an episode list for this one.</p>' : '';
  } catch {
    // Details are a nicety; playing the thing is the point — but leaving
    // placeholders standing would say "still loading" forever.
    $('#episode-list').innerHTML = '';
  }
}

function typeLabel(type) {
  if (!type) return null;
  return { movie: 'Film', series: 'Series', anime: 'Anime', tv: 'TV' }[type]
    || type.charAt(0).toUpperCase() + type.slice(1);
}

// Genres as chips rather than another run-on line of text: they are the one
// piece of metadata people scan rather than read.
function renderGenreChips(genres) {
  const row = $('#details-genres');
  row.innerHTML = '';
  const list = (genres || []).slice(0, 6);
  row.hidden = !list.length;

  for (const genre of list) {
    const chip = document.createElement('span');
    chip.className = 'genre-chip';
    chip.textContent = genre;
    row.append(chip);
  }
}

function renderCredits(meta) {
  const list = $('#details-credits');
  list.innerHTML = '';

  const rows = [
    ['Director', (meta.director || []).join(', ')],
    ['Cast', (meta.cast || []).join(', ')],
  ].filter(([, value]) => value);

  list.hidden = !rows.length;
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }
}

// The library button is a toggle over one endpoint. It starts disabled while
// the current state is fetched, so it can't be tapped into disagreeing with
// the server.
let libraryItem = null;

async function setupLibraryButton(item, type) {
  const button = $('#library-toggle');
  const baseId = (item.parentId || item.id).split(':')[0];

  // Series are saved as the show, not the episode you happened to open.
  libraryItem = { id: baseId, type, name: item.name, poster: item.poster,
                  background: item.background, year: item.year,
                  imdbRating: item.imdbRating, genres: item.genres || [] };

  button.hidden = false;
  button.disabled = true;
  setLibraryState(false, 'Checking…');

  try {
    const { inLibrary } = await api(`/api/library/${encodeURIComponent(type)}/${encodeURIComponent(baseId)}`);
    setLibraryState(inLibrary);
  } catch {
    // Can't tell — offer the add, and let the server be the judge on tap.
    setLibraryState(false);
  } finally {
    button.disabled = false;
  }
}

function setLibraryState(inLibrary, labelOverride) {
  const button = $('#library-toggle');
  button.setAttribute('aria-pressed', String(inLibrary));
  button.querySelector('.library-label').textContent =
    labelOverride || (inLibrary ? 'In Library' : 'Add to Library');
}

$('#library-toggle').addEventListener('click', async () => {
  const button = $('#library-toggle');
  if (!libraryItem || button.disabled) return;

  const adding = button.getAttribute('aria-pressed') !== 'true';
  button.disabled = true;
  // Flip immediately; a failure puts it back.
  setLibraryState(adding);

  try {
    const { inLibrary } = await post('/api/library', { ...libraryItem, remove: !adding });
    setLibraryState(inLibrary);
    toast(inLibrary ? 'Added to your Nuvio library' : 'Removed from your library');
    state.libraryLoaded = false;
  } catch (err) {
    setLibraryState(!adding);
    toast(err.message);
  } finally {
    button.disabled = false;
  }
});

// A portrait poster stretched to a landscape box looks wrong, so flag it and
// let CSS fill the sides with a blurred copy instead.
function setBackdrop(background, poster) {
  const el = $('#details-backdrop');
  const src = background || poster || '';
  el.style.backgroundImage = src ? `url("${src}")` : '';
  el.classList.toggle('poster-only', !background && Boolean(poster));
}

function renderSeasons(videos, activeId) {
  // Season 1 first, Specials (season 0) last.
  const seasons = [...new Set(videos.map((v) => v.season).filter((s) => s != null))]
    .sort((a, b) => (a === 0) - (b === 0) || a - b);
  const picker = $('#season-picker');
  picker.innerHTML = '';

  // Opens on the lowest real season — Season 1 — never on Specials. The one
  // exception is arriving from a particular episode (Continue watching, a
  // link), which opens on that episode's season unless it's a special.
  const activeVideo = videos.find((v) => v.id === activeId);
  const firstRegular = seasons.find((s) => s > 0) ?? seasons[0];
  let currentSeason = activeVideo?.season > 0 ? activeVideo.season : firstRegular;

  const showSeason = (season) => {
    const episodes = videos.filter((v) => v.season === season);
    renderSeasonSummary(season, episodes);
    renderEpisodes(episodes, activeId);
  };

  for (const season of seasons) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = season === 0 ? 'Specials' : `Season ${season}`;
    chip.setAttribute('aria-pressed', String(season === currentSeason));
    chip.addEventListener('click', () => {
      currentSeason = season;
      picker.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
      showSeason(season);
    });
    picker.append(chip);
  }
  showSeason(currentSeason);
}

// How many episodes and over what span — the two things you want to know
// before deciding whether to start a season.
function renderSeasonSummary(season, episodes) {
  const el = $('#season-summary');
  const years = episodes.map((v) => yearOf(v.released)).filter(Boolean);
  const span = years.length
    ? [...new Set([Math.min(...years), Math.max(...years)])].join('–')
    : null;

  el.textContent = [
    season === 0 ? 'Specials' : `Season ${season}`,
    `${episodes.length} ${episodes.length === 1 ? 'episode' : 'episodes'}`,
    span,
  ].filter(Boolean).join('  ·  ');
}

function renderEpisodes(videos, activeId) {
  const list = $('#episode-list');
  list.innerHTML = '';

  for (const v of videos) {
    const row = document.createElement('button');
    row.className = 'episode';
    row.setAttribute('aria-current', String(v.id === activeId));
    row.innerHTML = `
      <span class="ep-thumb"><span class="num"></span></span>
      <span class="ep-info">
        <span class="ep-head"><span class="ep-title"></span></span>
        <span class="ep-facts"></span>
        <span class="ep-overview"></span>
      </span>`;

    row.querySelector('.num').textContent = v.episode ?? '';
    row.querySelector('.ep-title').textContent = v.title || `Episode ${v.episode ?? ''}`.trim();

    // The still, where there is one. A dead URL leaves the episode number
    // behind rather than a broken-image icon, same as posters do.
    if (v.thumbnail) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = v.thumbnail;
      img.addEventListener('error', () => img.remove(), { once: true });
      row.querySelector('.ep-thumb').prepend(img);
    }

    const facts = [airDate(v.released), runtimeOf(v.runtime), v.rating ? `★ ${v.rating}` : null]
      .filter(Boolean).join('  ·  ');
    const factsEl = row.querySelector('.ep-facts');
    factsEl.textContent = facts;
    factsEl.hidden = !facts;

    // Synopses run long and there are twenty of them on a page, so it sits
    // clamped to two lines and opens on a tap of its own.
    const overview = row.querySelector('.ep-overview');
    overview.textContent = v.overview || '';
    overview.hidden = !v.overview;
    if (v.overview) {
      overview.addEventListener('click', (event) => {
        event.stopPropagation();
        overview.classList.toggle('open');
      });
    }

    row.addEventListener('click', () => {
      list.querySelectorAll('.episode').forEach((e) => e.setAttribute('aria-current', String(e === row)));
      start('series', v.id, episodeLabel(v));
    });
    list.append(row);
  }
}

function episodeLabel(v) {
  const code = v.season != null && v.episode != null ? `S${v.season} E${v.episode}` : '';
  return [code, v.title].filter(Boolean).join(' · ');
}

// Addons send dates as ISO strings, bare years, or something else entirely.
// Anything unparseable is shown as it arrived rather than as "Invalid Date".
function airDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  if (date.getTime() > Date.now()) {
    return `Airs ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function yearOf(value) {
  const year = new Date(value).getFullYear();
  return Number.isFinite(year) ? year : null;
}

function runtimeOf(value) {
  if (!value) return null;
  // Some addons send "45 min", others the bare number of minutes.
  const minutes = Number(String(value).replace(/[^0-9]/g, ''));
  if (!minutes) return String(value);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes} min`;
}

// Every play action funnels through here: straight to VLC when auto-play is
// on, otherwise the stream picker sheet.
function start(type, id, label = '') {
  // The built-in player starts straight away with the best stream; every
  // other source is in the player's own options menu.
  if (platform.resolve() === 'browser') return autoPlay(type, id);
  if (prefs.autoplay) return autoPlay(type, id);
  openStreamSheet(type, id, label);
}

function openStreamSheet(type, id, label) {
  sheetContext = { type, id };
  showEverything = false;
  $('#stream-sheet-sub').textContent = label || '';
  $('#sheet-backdrop').hidden = false;
  pushOverlay(closeStreamSheet);
  $('#stream-sheet').hidden = false;
  loadStreams(type, id);
}

function closeStreamSheet() {
  $('#stream-sheet').hidden = true;
  if ($('#playback-sheet').hidden) $('#sheet-backdrop').hidden = true;
}

// Playing in the browser means most results are useless: an MKV or an AC3
// track is something no browser will touch. Rather than listing twenty
// options and letting you find that out one at a time, the ones that will
// play are shown and the rest are a press away.
let showEverything = false;

async function loadStreams(type, id) {
  const box = $('#stream-list');
  skeleton(box, { kind: 'stream', count: 5 });

  // Only the browser player is fussy. VLC plays everything, so filtering for
  // it would be hiding results for no reason.
  // With Lumen converting on the server, nothing needs hiding.
  // Every stream the addons returned, always.
  const filtering = false;
  const query = filtering ? '?browser=1' : '';

  try {
    const data = await api(`/api/streams/${encodeURIComponent(type)}/${encodeURIComponent(id)}${query}`);
    const { streams: list, queueLength, hidden = 0 } = data;
    box.innerHTML = '';

    if (!list.length) {
      box.innerHTML = filtering && hidden
        ? `<p class="empty">None of the ${hidden} results will play in a browser as they are.</p>`
        : '<p class="empty">No addon returned a stream for this.</p>';
      if (filtering && hidden) box.append(showAllButton(type, id, hidden));
      return;
    }

    const queued = prefs.binge && queueLength > 0;
    if (queued) {
      const note = document.createElement('p');
      note.className = 'autoplay-note';
      note.textContent = `Binge is on — the player gets the whole season as a playlist (${queueLength + 1} episodes), starting here.`;
      box.append(note);
    }

    for (const s of list) box.append(streamRow(s, queued));
    if (filtering && hidden) box.append(showAllButton(type, id, hidden));
  } catch (err) {
    box.innerHTML = `<p class="empty">${err.message}</p>`;
  }
}

// The guess comes from a release name and is sometimes wrong in both
// directions, so the rest are never actually unavailable — and with ffmpeg in
// the build they will play anyway, just by way of a conversion.
function showAllButton(type, id, hidden) {
  const button = document.createElement('button');
  button.className = 'btn-ghost wide';
  button.textContent = `Show everything (${hidden} more)`;
  button.addEventListener('click', () => {
    showEverything = true;
    loadStreams(type, id);
  });
  return button;
}

let sheetContext = { type: null, id: null };

function streamRow(s, queued) {
  const el = document.createElement(s.playable ? 'a' : 'div');
  el.className = `stream${s.playable ? '' : ' unplayable'}`;
  el.innerHTML = `
    <div class="info">
      <div class="stream-name"></div>
      <div class="badges"></div>
      <div class="from"></div>
    </div>
    <div class="go">${s.playable ? 'Play' : 'Torrent'}</div>`;

  el.querySelector('.stream-name').textContent = s.headline || s.label;

  const badges = el.querySelector('.badges');
  for (const text of s.badges || []) {
    const chip = document.createElement('span');
    chip.className = 'badge';
    chip.textContent = text;
    badges.append(chip);
  }
  if (!badges.childElementCount) badges.remove();

  el.querySelector('.from').textContent = s.playable ? s.addon : `${s.addon} — needs debrid`;

  // Only worth saying when the list is showing things the browser can't take
  // as they are; in VLC it makes no difference at all.
  if (s.playable && s.browser === 'no' && platform.resolve() === 'browser') {
    const note = document.createElement('div');
    note.className = 'stream-warn';
    note.textContent = 'Will be converted by the server';
    el.querySelector('.info').append(note);
  }

  // The full release name is long and rarely what you're scanning for, so it
  // sits behind a tap rather than taking six lines in every row.
  if (s.detail) {
    const detail = document.createElement('div');
    detail.className = 'stream-detail';
    detail.textContent = s.detail;
    el.querySelector('.info').append(detail);
    el.querySelector('.stream-name').addEventListener('click', (e) => {
      e.preventDefault();
      detail.classList.toggle('open');
    });
  }

  if (s.playable) {
    // Everything goes through /play rather than straight at the stream URL:
    // that is where binge turns the pick into a season playlist, where a
    // language preference becomes an M3U, and where the device's chosen
    // player decides what kind of link comes back.
    el.href = playHref(s);
    el.addEventListener('click', () => {
      // Going through history keeps the stack in step; the navigation that
      // follows happens either way.
      if (overlays.length) history.back();
      toast(handoffMessage(queued));
      platform.watchHandoff(() => offerAlternatives(s));
    });

  }
  return el;
}

function playHref(stream) {
  const params = { url: stream.url };
  if (stream.filename) params.filename = stream.filename;
  if (stream.headline) params.title = stream.headline;
  if (sheetContext.type) params.type = sheetContext.type;
  if (sheetContext.id) params.id = sheetContext.id;
  return platform.playLink('/play', params);
}

function handoffMessage(queued) {
  const where = platform.describe(platform.resolve());
  if (platform.resolve() === 'download') return 'Downloading the playlist — open it to start VLC.';
  if (queued) return `Opening in ${where} — rest of the season queued`;
  return `Opening in ${where}…`;
}

// The hand-off to another app is a navigation nothing reports back on. If this
// page is still in front of the person afterwards, the app isn't installed or
// the browser refused the scheme — so offer the two things that always work.
function offerAlternatives(stream) {
  const bar = $('#handoff-bar');
  const actions = $('#handoff-actions');
  $('#handoff-message').textContent =
    `${platform.describe(platform.resolve())} didn't open. It may not be installed on this device.`;
  actions.innerHTML = '';

  const link = (label, href, primary) => {
    const a = document.createElement('a');
    a.className = primary ? 'btn-primary' : 'btn-ghost';
    a.textContent = label;
    a.href = href;
    actions.append(a);
  };

  const base = { url: stream.url, filename: stream.filename, title: stream.headline,
                 type: sheetContext.type, id: sheetContext.id };
  for (const alt of platform.alternatives()) {
    link(alt.label, alt.href || withTarget(base, alt.target), alt.primary);
  }

  bar.hidden = false;
}

function withTarget(params, target) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value),
  );
  query.set('target', target);
  query.set('os', platform.device.os);
  return `/play?${query}`;
}

$('#handoff-dismiss').addEventListener('click', () => { $('#handoff-bar').hidden = true; });

// The server resolves the best stream and redirects to whatever this device
// plays with, so this is a plain navigation rather than a fetch — a browser
// has to follow the 302 itself for an app scheme to fire.
function autoPlay(type, id) {
  // The built-in player opens inside the page rather than as a navigation:
  // the tap on Play is still "live" then, which is what lets the film play
  // with sound on a phone.
  if (platform.resolve() === 'browser') return openInPage(type, id);
  toast('Finding the best stream…');
  location.href = platform.playLink(
    `/play/auto/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
  );
}

let inPagePlayer = false;

// After watching, the row should reflect it straight away.
async function refreshContinueRow() {
  const rows = $('#home-rows');
  if (!rows || !state.homeLoaded) return;
  // Give the player's last report a moment to land.
  await new Promise((r) => { setTimeout(r, 600); });
  const watching = await api('/api/progress').catch(() => null);
  if (!watching) return;
  rows.querySelector('.row-continue')?.remove();
  if (watching.length) rows.prepend(renderContinueRow(watching));
}
let skipNextPop = false;

async function openInPage(type, id) {
  player.unlock();          // must run inside the tap, before any await
  player.init();
  player.opening();
  inPagePlayer = true;

  try {
    const link = platform.playLink(
      `/play/auto/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, { format: 'json' },
    );
    const res = await fetch(link, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.watch) throw new Error(data.error || 'No playable stream for this one.');
    if (!inPagePlayer) return; // closed while we waited

    // A history entry of its own, so the phone's back gesture leaves the
    // player rather than the app.
    history.pushState({ nuvioWatch: true }, '', data.watch);
    await player.mount({ inPage: true, onExit: closeInPage });
  } catch (err) {
    inPagePlayer = false;
    player.unmount();
    toast(err.message, 4000);
  }
}

// Leaving from the player's own back button: take its history entry off.
function closeInPage() {
  if (!inPagePlayer) return;
  inPagePlayer = false;
  refreshContinueRow();
  if (history.state?.nuvioWatch) { skipNextPop = true; history.back(); }
  document.title = 'Nuvio';
}

// ------------------------------------------------------- playback sheet

function openSheet() {
  // Opening this from the stream sheet replaces it rather than stacking on
  // top, so the history entry is reused instead of a second one being pushed
  // for what is, from the outside, still one layer deep.
  const replacing = !$('#stream-sheet').hidden;
  closeStreamSheet();
  $('#pref-autoplay').checked = prefs.autoplay;
  $('#pref-binge').checked = prefs.binge;
  renderQualityChips();
  renderLanguageSelect('#pref-audio-lang', 'audioLang', 'Whatever the file defaults to');
  renderLanguageSelect('#pref-sub-lang', 'subLang', 'No subtitles');
  $('#sheet-backdrop').hidden = false;
  $('#playback-sheet').hidden = false;

  if (replacing && overlays.length) overlays[overlays.length - 1] = closeSheet;
  else pushOverlay(closeSheet);
}

function closeSheet() {
  $('#playback-sheet').hidden = true;
  if ($('#stream-sheet').hidden) $('#sheet-backdrop').hidden = true;
}

function renderQualityChips() {
  const row = $('#pref-quality');
  row.innerHTML = '';
  for (const [value, label] of QUALITIES) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(prefs.quality === value));
    chip.addEventListener('click', () => {
      prefs.quality = value;
      renderQualityChips();
      savePrefs();
    });
    row.append(chip);
  }
}

// A native <select> rather than chips: two dozen languages is a list, not a
// row, and iOS gives a select its own wheel picker for free.
function renderLanguageSelect(selector, key, noneLabel) {
  const select = $(selector);
  select.innerHTML = '';

  const none = document.createElement('option');
  none.value = '';
  none.textContent = noneLabel;
  select.append(none);

  for (const { code, name } of languageOptions) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = name;
    select.append(option);
  }

  select.value = prefs[key] || '';
  select.onchange = () => {
    prefs[key] = select.value;
    savePrefs();
  };
}

// Settings → Default languages. The same prefs as the playback sheet, so
// changing one updates the other the next time it's opened.
function renderSettingsLanguages() {
  if (!$('#settings-audio-lang')) return;
  renderLanguageSelect('#settings-audio-lang', 'audioLang', 'File default');
  renderLanguageSelect('#settings-sub-lang', 'subLang', 'Off');
}

async function savePrefs() {
  try {
    prefs = await post('/api/prefs', prefs);
  } catch (err) {
    toast(err.message);
  }
}

$('#playback-gear').addEventListener('click', openSheet);
$('#sheet-done').addEventListener('click', () => history.back());
$('#sheet-backdrop').addEventListener('click', () => history.back());
$('#pref-autoplay').addEventListener('change', (e) => { prefs.autoplay = e.target.checked; savePrefs(); });
$('#pref-binge').addEventListener('change', (e) => { prefs.binge = e.target.checked; savePrefs(); });

// -------------------------------------------------------------- settings

function renderThemes(active) {
  const grid = $('#theme-grid');
  grid.innerHTML = '';
  for (const name of THEMES) {
    const probe = document.createElement('body');
    const swatch = document.createElement('button');
    swatch.className = 'swatch';
    swatch.dataset.theme = name;
    swatch.setAttribute('aria-label', name);
    swatch.setAttribute('aria-pressed', String(name === active));
    // Read the palette's accent straight from the stylesheet rather than
    // duplicating twelve hex values in here.
    probe.dataset.theme = name;
    probe.style.display = 'none';
    document.documentElement.append(probe);
    swatch.style.background = getComputedStyle(probe).getPropertyValue('--accent') || '#F5F5F5';
    probe.remove();

    swatch.addEventListener('click', async () => {
      setTheme(name);
      grid.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-pressed', String(s === swatch)));
      await post('/api/theme', { theme: name });
    });
    grid.append(swatch);
  }
}

// --------------------------------------------------------- player choice

const DEVICE_NAMES = {
  ios: 'iPhone or iPad', android: 'Android', windows: 'Windows',
  macos: 'macOS', linux: 'Linux', chromeos: 'ChromeOS', unknown: 'This browser',
};

// Notes worth having on screen, because each platform fails differently and
// the fix is never guessable from the error.
const PLAYER_NOTES = {
  ios: 'Everything plays in the built-in player. Choose VLC to open streams in VLC for iOS instead — it becomes the default on this device.',
  android: 'Everything plays in the built-in player. Choose VLC, or “Ask which app” for MX Player or Just Player, to make that the default on this device.',
  desktop: 'Everything plays in the built-in player. Choose VLC to make it the default on this computer; the .m3u option works without the one-time launcher.',
};

function renderPlayerTargets() {
  const box = $('#player-targets');
  if (!box) return;

  const active = platform.stored();
  box.innerHTML = '';

  for (const target of platform.targets()) {
    const row = document.createElement('button');
    row.className = 'option';
    row.setAttribute('aria-pressed', String(target.value === active));
    row.innerHTML = '<span class="option-label"></span><span class="option-hint"></span>';
    row.querySelector('.option-label').textContent = target.label;
    row.querySelector('.option-hint').textContent = target.hint;
    row.addEventListener('click', () => {
      platform.choose(target.value);
      renderPlayerTargets();
      toast(`Streams will open in ${platform.describe(platform.resolve())}.`);
    });
    box.append(row);
  }

  $('#settings-device').textContent =
    `${DEVICE_NAMES[platform.device.os] || DEVICE_NAMES.unknown} · ${platform.mechanism()}`;
  $('#player-note').textContent = PLAYER_NOTES[platform.device.os] || PLAYER_NOTES.desktop;
}

// -------------------------------------------------------------- sidebar

// Hidden, the sidebar is gone entirely and the content takes the whole
// window. The only way back is the floating button, which is why it lives
// outside the bar it reopens. The state is remembered per device.
const NAV_KEY = 'nuvio.navHidden';

function applyNavState(hidden) {
  document.body.classList.toggle('nav-hidden', hidden);
  $('#nav-toggle').setAttribute('aria-expanded', String(!hidden));
  $('#nav-show').hidden = !hidden;

  // Focus follows the control that replaced the one just used, so a keyboard
  // doesn't get dropped back at the top of the page.
  const next = hidden ? $('#nav-show') : $('#nav-toggle');
  if (document.activeElement === $('#nav-toggle') || document.activeElement === $('#nav-show')) {
    next.focus();
  }
}

function setNav(hidden) {
  localStorage.setItem(NAV_KEY, hidden ? '1' : '0');
  applyNavState(hidden);
}

$('#nav-toggle').addEventListener('click', () => setNav(true));
$('#nav-show').addEventListener('click', () => setNav(false));

applyNavState(localStorage.getItem(NAV_KEY) === '1');

// -------------------------------------------------------------- passwords

// Hands the credentials to the browser's password manager, which then offers
// to save them the way it would for any other site.
//
// Two things to know if nothing appears. This needs a secure context, so over
// plain http on a LAN address the browser disables password saving entirely —
// that is the browser's rule, not ours, and the fix is HTTPS. And Firefox and
// Safari don't implement this API at all; they fall back to their own
// heuristics, which the form's autocomplete attributes are already written
// for.
async function offerToRemember(form) {
  if (!window.PasswordCredential || !navigator.credentials) return;
  try {
    await navigator.credentials.store(new window.PasswordCredential(form));
  } catch {
    // Declining to save is a normal outcome, not a failure.
  }
}

// On a later visit, fill the form back in from whatever was saved. Nothing is
// submitted automatically — the fields are filled and the person presses the
// button, so a shared machine doesn't sign someone in behind their back.
async function fillFromSavedPassword() {
  if (!window.PasswordCredential || !navigator.credentials) return;
  try {
    const credential = await navigator.credentials.get({
      password: true,
      mediation: 'optional',
    });
    if (!credential?.password) return;
    $('#login-form input[name=email]').value = credential.id || '';
    $('#login-form input[name=password]').value = credential.password;
  } catch {
    // No stored credential, or the person dismissed the picker.
  }
}

// ------------------------------------------------------------- keyboard

// A desktop has keys, and nothing here used them. These are the two that are
// missed immediately: escape to back out, and slash to search.
document.addEventListener('keydown', (event) => {
  if (!$('#screen-watch').hidden) return;
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');

  if (event.key === 'Escape') {
    // One path out, so the history stack and the screen agree.
    if (overlays.length) { history.back(); return undefined; }
    return undefined;
  }

  if (event.key === '/' && !typing) {
    event.preventDefault();
    if (!$('#shell').hidden) { goto('Search'); $('#search-form input').focus(); }
  }
  return undefined;
});

// ------------------------------------------------------------------ boot

// Requests boot starts before it knows it needs them, so they run alongside
// /api/session rather than one after another. Each is used once at most.
const prefetched = { home: null, profiles: null };

function takeProfiles() {
  const early = prefetched.profiles;
  prefetched.profiles = null;
  return early || api('/api/profiles');
}

async function boot() {
  registerServiceWorker();

  // Returning within the same visit goes straight to Home with the profile
  // already chosen: ask for everything that screen needs at once. Opening
  // the app afresh shows the profile picker, so only the profiles.
  const sessionRequest = api('/api/session').catch(() => ({ signedIn: false }));
  if (!player.isWatchRoute()) {
    prefetched.profiles = api('/api/profiles');
    prefetched.profiles.catch(() => {});
    if (profileChosenThisVisit()) {
      prefetched.home = Promise.all([api('/api/home'), api('/api/progress').catch(() => [])]);
      prefetched.home.catch(() => {});
    }
  }

  const session = await sessionRequest;
  if (!session.signedIn) { prefetched.home = null; prefetched.profiles = null; }
  state.session = session;
  platform.setServerCaps?.({ transcode: session.transcode });
  setTheme(session.theme);
  $('#auth-foot').textContent =
    `Plays in ${platform.describe(platform.resolve())} on this device. Your account, addons and library come from Nuvio.`;

  if (!session.signedIn) {
    $('#signup-toggle').hidden = !session.signupAllowed;
    screen('auth');
    fillFromSavedPassword();
    return;
  }

  $('#signup-toggle').hidden = !session.signupAllowed;
  prefs = { ...prefs, ...(session.prefs || {}) };
  languageOptions = session.languages || [];
  $('#settings-email').textContent = session.email || '';
  $('#settings-backend').textContent = session.backendUrl.replace(/^https?:\/\//, '');
  renderThemes(session.theme);
  renderPlayerTargets();
  renderSettingsLanguages();

  // Arriving at /watch is the browser player, not the catalog — no point
  // loading a home screen nobody asked for behind it.
  if (player.isWatchRoute()) {
    screen('watch');
    player.init();
    await player.mount();
    return;
  }

  // The profile is remembered on the account, so asking again on every load
  // is asking a question already answered. This is what made the browser's
  // back button land on the picker: coming back to "/" from the player
  // re-ran boot, and boot always started at the beginning.
  // The picker opens every time the site is opened, so whoever picks it up
  // chooses who they are. "Opened" means a new tab or window, or launching
  // the home-screen app: within one tab, a reload or coming back from the
  // player keeps the profile already chosen there.
  if (session.profileIndex != null && profileChosenThisVisit()) {
    state.profiles = await takeProfiles().catch(() => []);
    state.profile = state.profiles.find((p) => p.index === session.profileIndex)
      || state.profiles[0] || null;
    paintProfile(state.profile);
    screen('shell');
    goto('Home');
    return;
  }

  prefetched.home = null;
  await showProfiles();
}

// Installing the app is what makes this feel native on Android and on the
// desktop, and it needs a service worker to be offered at all. This one only
// caches the shell — never an API response, and never a resolved stream.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Not being installable is a missing nicety, not a broken app.
  });
}

boot();
