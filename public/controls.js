// The player's own controls, drawn over the picture on every device.
//
// Everything a viewer touches lives here: play/pause, the seek bar, skip,
// volume, fullscreen, picture-in-picture, and the audio, subtitle and episode
// menus. player.js still owns *what* plays; this only drives the <video> and
// the two hidden <select>s player.js keeps as the source of truth for tracks
// (choosing from a menu sets the select and fires its onchange, exactly as the
// old dropdowns did).

const $ = (s, root = document) => root.querySelector(s);
const HIDE_AFTER_MS = 3000;
const SKIP_S = 10;

let video;
let stage;
let hideTimer = null;
let seeking = false;
let hooks = { prev: () => {}, next: () => {} };

function fmt(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

// --------------------------------------------------------- visibility

function menuOpen() {
  return !$('#watch-menu').hidden || !$('#watch-queue-wrap').hidden;
}

export function showUi() {
  stage.classList.add('show-ui');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!video.paused && !seeking && !menuOpen()) {
      stage.classList.remove('show-ui');
    }
  }, HIDE_AFTER_MS);
}

function hideUi() {
  if (video.paused || menuOpen()) return;
  clearTimeout(hideTimer);
  stage.classList.remove('show-ui');
}

// ------------------------------------------------------------ playback

function togglePlay() {
  if (video.paused) video.play()?.catch?.(() => {});
  else video.pause();
}

function syncPlayState() {
  const paused = video.paused;
  stage.classList.toggle('is-paused', paused);
  $('#watch-play').setAttribute('aria-label', paused ? 'Play' : 'Pause');
  $('#watch-center-play').setAttribute('aria-label', paused ? 'Play' : 'Pause');
  // Show on every change; when playing, this also starts the idle timer, so
  // the controls fade even if the mouse never moves again.
  showUi();
}

function syncTime() {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  $('#watch-duration').textContent = fmt(duration);
  if (seeking) return;
  const at = video.currentTime || 0;
  $('#watch-time').textContent = fmt(at);
  const seek = $('#watch-seek');
  seek.value = duration ? String(Math.round((at / duration) * 1000)) : '0';
  paintSeek();
}

// Played portion and buffered portion, painted as one gradient.
function paintSeek() {
  const seek = $('#watch-seek');
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const played = (Number(seek.value) / 10);
  let buffered = played;
  if (duration && video.buffered?.length) {
    for (let i = 0; i < video.buffered.length; i += 1) {
      if (video.buffered.start(i) <= video.currentTime + 0.5) {
        buffered = Math.max(buffered, (video.buffered.end(i) / duration) * 100);
      }
    }
  }
  seek.style.setProperty('--played', `${played}%`);
  seek.style.setProperty('--buffered', `${Math.min(100, buffered)}%`);
}

function skip(seconds) {
  const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
  video.currentTime = Math.max(0, Math.min(duration - 1, (video.currentTime || 0) + seconds));
  showUi();
}

function syncVolume() {
  $('#watch-mute').classList.toggle('is-muted', video.muted || video.volume === 0);
  $('#watch-volume').value = String(video.muted ? 0 : video.volume);
}

// ----------------------------------------------------------- fullscreen

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement;
}

export function toggleFullscreen() {
  if (fullscreenElement()) {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    return;
  }
  // The stage, not the video, so the controls and menus come along.
  const request = stage.requestFullscreen || stage.webkitRequestFullscreen;
  if (request) {
    // No orientation lock here: once the film is playing the phone is free
    // to turn either way (see orientation.js-style handling in attach()).
    Promise.resolve(request.call(stage)).catch(() => video.webkitEnterFullscreen?.());
  } else {
    // iPhone Safari only allows the video itself to go fullscreen.
    video.webkitEnterFullscreen?.();
  }
}

// ----------------------------------------------------------------- menus

function closeMenus() {
  $('#watch-menu').hidden = true;
  $('#watch-queue-wrap').hidden = true;
  for (const id of ['#watch-source-btn', '#watch-audio-btn', '#watch-subs-btn', '#watch-quality-btn', '#watch-queue-btn']) {
    $(id).setAttribute('aria-expanded', 'false');
  }
}

// The options menu: one panel with a section per hidden select player.js
// keeps — Source, Audio, Subtitles — each a list of choices. Picking one sets
// that select and fires its onchange, which is where player.js acts on it.
const SECTIONS = [
  ['#watch-source-wrap', '#watch-source', 'Source', 'Looking for other sources…'],
  ['#watch-audio-wrap', '#watch-audio', 'Audio', 'This file has one audio track.'],
  ['#watch-subs-wrap', '#watch-subs', 'Subtitles', 'No subtitles found for this one.'],
  ['#watch-quality-wrap', '#watch-quality', 'Quality', 'Quality can be changed once the video starts.'],
];

// Each button opens its own section. The buttons are always there, so the
// controls never move around; a section with nothing to pick says so.
function openOptionsMenu(button, only) {
  const menu = $('#watch-menu');
  const wasOpen = !menu.hidden && menu.dataset.for === only;
  closeMenus();
  if (wasOpen) return;

  const parts = [];
  for (const [wrap, selectId, title, empty] of SECTIONS) {
    if (only && title !== only) continue;
    const select = $(selectId);
    if ($(wrap).hidden || !select.options.length) {
      const heading = document.createElement('h2');
      heading.className = 'watch-menu-title';
      heading.textContent = title;
      const note = document.createElement('p');
      note.className = 'watch-menu-empty';
      note.textContent = title === 'Audio' && $('#watch-audio').options.length === 0 && !$('#watch-video').currentSrc
        ? 'Tracks appear once the video starts.' : empty;
      parts.push(heading, note);
      continue;
    }

    const heading = document.createElement('h2');
    heading.className = 'watch-menu-title';
    heading.textContent = title;
    const list = document.createElement('div');
    list.className = 'watch-menu-list';

    for (const option of select.options) {
      const item = document.createElement('button');
      item.className = 'watch-menu-item';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(option.value === select.value));
      item.disabled = option.disabled;
      const label = document.createElement('span');
      label.className = 'watch-menu-label';
      label.textContent = option.textContent;
      item.append(label);
      if (option.dataset.detail) {
        const detail = document.createElement('span');
        detail.className = 'watch-menu-detail';
        detail.textContent = option.dataset.detail;
        item.append(detail);
      }
      item.addEventListener('click', () => {
        closeMenus();
        if (select.value === option.value) return;
        select.value = option.value;
        select.onchange?.();
      });
      list.append(item);
    }
    parts.push(heading, list);
    if (title === 'Subtitles') parts.push(timingRow());
  }

  if (!parts.length) {
    const empty = document.createElement('p');
    empty.className = 'watch-menu-empty';
    empty.textContent = 'Nothing to choose for this one.';
    parts.push(empty);
  }

  menu.replaceChildren(...parts);
  menu.dataset.for = only || '';
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  menu.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
  showUi();
}

// Subtitle timing: nudge the subtitles earlier or later in half-second steps,
// for a subtitle file made for a slightly different cut or release.
function timingRow() {
  const row = document.createElement('div');
  row.className = 'watch-timing';
  const label = document.createElement('span');
  label.className = 'watch-timing-label';
  const value = document.createElement('span');
  value.className = 'watch-timing-value';
  const paint = () => {
    const d = hooks.subtitleDelay?.get?.() || 0;
    value.textContent = d === 0 ? 'In sync' : `${d > 0 ? '+' : ''}${d.toFixed(1)} s`;
  };
  label.textContent = 'Timing';
  const button = (text, aria, by) => {
    const b = document.createElement('button');
    b.className = 'watch-timing-btn';
    b.textContent = text;
    b.setAttribute('aria-label', aria);
    b.addEventListener('click', () => {
      const d = hooks.subtitleDelay?.get?.() || 0;
      hooks.subtitleDelay?.set?.(by === null ? 0 : d + by);
      paint();
      showUi();
    });
    return b;
  };
  row.append(
    label,
    button('−0.5', 'Show subtitles half a second earlier', -0.5),
    value,
    button('+0.5', 'Show subtitles half a second later', 0.5),
    button('Reset', 'Reset subtitle timing', null),
  );
  paint();
  return row;
}

function toggleQueue() {
  const panel = $('#watch-queue-wrap');
  const opening = panel.hidden;
  closeMenus();
  if (!opening) return;
  panel.hidden = false;
  $('#watch-queue-btn').setAttribute('aria-expanded', 'true');
  panel.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'center' });
  showUi();
}

// The options button lights up while subtitles are on.
function watchAvailability() {
  const sync = () => {
    $('#watch-subs-btn').classList.toggle('is-on', Boolean($('#watch-subs').value) && !$('#watch-subs-wrap').hidden);
  };
  const observer = new MutationObserver(sync);
  observer.observe($('#watch-subs'), { childList: true });
  observer.observe($('#watch-subs-wrap'), { attributes: true, attributeFilter: ['hidden'] });
  $('#watch-subs').addEventListener('change', sync);
  sync();
  return sync;
}

// ------------------------------------------------------------------ setup

/**
 * @param {HTMLVideoElement} el
 * @param {{ prev: () => void, next: () => void }} navigation
 */
export function attach(el, navigation) {
  video = el;
  stage = $('#watch-stage');
  hooks = { ...hooks, ...navigation };
  video.controls = false;

  // Playback
  $('#watch-play').addEventListener('click', togglePlay);
  $('#watch-center-play').addEventListener('click', (event) => {
    event.stopPropagation();
    togglePlay();
    showUi();
  });
  $('#watch-rew').addEventListener('click', () => skip(-SKIP_S));
  $('#watch-fwd').addEventListener('click', () => skip(SKIP_S));
  $('#watch-prev').addEventListener('click', () => hooks.prev());
  $('#watch-next').addEventListener('click', () => hooks.next());

  // The picture: a click plays or pauses; on touch the first tap brings the
  // controls up and a tap while they're up plays or pauses. Double-click is
  // fullscreen, as in every desktop player.
  const tap = $('#watch-tap');
  tap.addEventListener('click', (event) => {
    if (menuOpen()) { closeMenus(); return; }
    if (event.pointerType === 'touch' || matchMedia('(hover: none)').matches) {
      if (!stage.classList.contains('show-ui')) { showUi(); return; }
    }
    togglePlay();
    showUi();
  });
  tap.addEventListener('dblclick', toggleFullscreen);

  // Seeking: preview the time while dragging, seek on release.
  const seek = $('#watch-seek');
  const tip = $('#watch-seek-tip');
  let prepareTimer = null;
  // Where on the bar a position is, for the time bubble.
  const placeTip = (fraction) => {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!duration) return;
    const rect = seek.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    tip.textContent = fmt(fraction * duration);
    tip.style.left = `${rect.left - stageRect.left + fraction * rect.width}px`;
    tip.style.top = `${rect.top - stageRect.top}px`;
    tip.hidden = false;
  };
  seek.addEventListener('input', () => {
    seeking = true;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const target = (Number(seek.value) / 1000) * duration;
    $('#watch-time').textContent = fmt(target);
    placeTip(Number(seek.value) / 1000);
    paintSeek();
    showUi();
    // Let the server start converting where the drag is heading, once it
    // settles for a moment — not on every pixel.
    clearTimeout(prepareTimer);
    prepareTimer = setTimeout(() => hooks.prepare?.(target), 250);
  });
  // Hovering the bar with a mouse shows the time under the pointer.
  seek.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse' || seeking) return;
    const rect = seek.getBoundingClientRect();
    placeTip(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
  });
  seek.addEventListener('pointerleave', () => { if (!seeking) tip.hidden = true; });
  seek.addEventListener('change', () => {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration) video.currentTime = (Number(seek.value) / 1000) * duration;
    seeking = false;
    tip.hidden = true;
    showUi();
  });

  // Volume
  $('#watch-mute').addEventListener('click', () => {
    if (video.muted || video.volume === 0) {
      video.muted = false;
      if (video.volume === 0) video.volume = 0.5;
    } else {
      video.muted = true;
    }
  });
  $('#watch-volume').addEventListener('input', (event) => {
    video.volume = Number(event.target.value);
    video.muted = video.volume === 0;
  });

  // Menus
  $('#watch-source-btn').addEventListener('click', (e) => openOptionsMenu(e.currentTarget, 'Source'));
  $('#watch-audio-btn').addEventListener('click', (e) => openOptionsMenu(e.currentTarget, 'Audio'));
  $('#watch-subs-btn').addEventListener('click', (e) => openOptionsMenu(e.currentTarget, 'Subtitles'));
  $('#watch-quality-btn').addEventListener('click', (e) => openOptionsMenu(e.currentTarget, 'Quality'));
  $('#watch-queue-btn').addEventListener('click', toggleQueue);
  $('#watch-queue').addEventListener('click', () => closeMenus());
  watchAvailability();

  // Fullscreen and picture-in-picture
  $('#watch-fullscreen').addEventListener('click', toggleFullscreen);
  const onFullscreen = () => stage.classList.toggle('is-fullscreen', Boolean(fullscreenElement()));
  document.addEventListener('fullscreenchange', onFullscreen);
  document.addEventListener('webkitfullscreenchange', onFullscreen);
  if (document.pictureInPictureEnabled || video.webkitSupportsPresentationMode) {
    const pip = $('#watch-pip');
    pip.hidden = false;
    pip.addEventListener('click', () => {
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
      else if (video.requestPictureInPicture) video.requestPictureInPicture().catch(() => {});
      else video.webkitSetPresentationMode?.('picture-in-picture');
    });
  }

  // State from the video itself
  video.addEventListener('play', syncPlayState);
  video.addEventListener('pause', syncPlayState);
  video.addEventListener('timeupdate', syncTime);
  video.addEventListener('durationchange', syncTime);
  video.addEventListener('progress', paintSeek);
  video.addEventListener('volumechange', syncVolume);
  video.addEventListener('emptied', () => { syncTime(); syncPlayState(); });
  const spinner = $('#watch-spinner');
  video.addEventListener('waiting', () => { spinner.hidden = false; });
  video.addEventListener('loadstart', () => { spinner.hidden = false; });
  for (const done of ['playing', 'canplay', 'pause', 'error', 'emptied']) {
    video.addEventListener(done, () => { spinner.hidden = true; });
  }

  // Controls come up with any movement and fade after a few idle seconds.
  // Only real movement counts: some browsers fire mousemove with no change
  // after a repaint, which would keep the controls up forever.
  let lastX = -1;
  let lastY = -1;
  stage.addEventListener('mousemove', (event) => {
    if (event.clientX === lastX && event.clientY === lastY) return;
    lastX = event.clientX; lastY = event.clientY;
    showUi();
  });
  stage.addEventListener('touchstart', showUi, { passive: true });
  // A mouse click on a control shouldn't leave it focused, or the focus
  // would count as "in use". Keyboard focus is untouched.
  stage.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse') event.target.closest?.('button')?.blur();
  });
  stage.addEventListener('mouseleave', hideUi);
  stage.addEventListener('focusin', () => {
    let keyboard = true;
    try { keyboard = stage.matches(':has(:focus-visible)'); } catch { /* old browser: assume keyboard */ }
    if (keyboard) showUi();
  });
  document.addEventListener('keydown', (event) => {
    if ($('#screen-watch').hidden) return;
    if (event.key === 'Escape' && menuOpen()) {
      event.stopImmediatePropagation();
      closeMenus();
      return;
    }
    showUi();
  }, true);

  // Portrait until there's something to watch. While the player is finding
  // and loading a stream the phone stays upright; the moment the film is
  // actually playing it's released, so turning sideways goes landscape.
  // Browsers only honour a lock in fullscreen or an installed home-screen
  // app; elsewhere this does nothing and the phone turns freely as always.
  video.addEventListener('loadstart', () => holdPortrait(true));
  video.addEventListener('playing', () => holdPortrait(false));
  video.addEventListener('emptied', () => holdPortrait(true));

  syncPlayState();
  syncVolume();
  syncTime();
}

// Portrait until the film plays. The browser only lets a page set the
// orientation in two situations, and both are used:
//   - the app installed to the home screen: its manifest says portrait, and
//     the player switches that to "any" while a film is playing;
//   - fullscreen: on phones the player goes fullscreen from the tap on Play,
//     locks portrait while loading and frees it once the film starts.
// iPhones offer neither (no orientation API at all), so there the phone's
// own rotation lock is the only control.
let portraitHeld = false;
export function holdPortrait(hold) {
  const orientation = screen.orientation;
  if (!orientation?.lock) return;
  portraitHeld = hold;
  orientation.lock(hold ? 'portrait' : 'any').catch(() => {
    // Not allowed here (a plain browser tab). Nothing else to do.
  });
}

// Phones: go fullscreen straight from the tap on Play, which is what allows
// the orientation to be held. Must be called inside that tap.
export function enterFullscreenForPlayback() {
  if (!matchMedia('(pointer: coarse)').matches) return;
  const request = stage?.requestFullscreen || $('#watch-stage')?.requestFullscreen;
  const el = stage || $('#watch-stage');
  if (!request || !el) return;
  try {
    Promise.resolve(request.call(el, { navigationUI: 'hide' }))
      .then(() => holdPortrait(true))
      .catch(() => {});
  } catch { /* not allowed */ }
}

export { closeMenus };
