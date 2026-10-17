// The service worker exists so the app can be installed — Android and desktop
// Chrome will not offer "Install" without one. What it does deliberately is
// very little.
//
// Only the shell is cached: the HTML, the scripts, the stylesheet, the icons.
// Nothing under /api is ever stored, because it is somebody's library and
// their sign-in state. Nothing under /play, /playlist, /media or /sub.vtt is
// ever stored either, because those resolve to debrid links that are
// single-use as often as not — a cached one is a link that has already been
// spent.

const CACHE = 'nuvio-shell-v85';

const SHELL = [
  '/',
  '/index.html',
  '/style.css?v=85',
  '/app.js?v=85',
  '/platform.js?v=85',
  '/player.js?v=85',
  '/controls.js?v=85',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  // The player library. Worth caching: it is the largest thing the app
  // loads, and it is needed every time anything is played.
  '/vendor/hls.light.min.js',
  '/vendor/libpgs.js',
  '/vendor/libpgs.worker.js',
];

const NEVER_CACHE = /^\/(api|play|playlist|media|hls|sub\.vtt|healthz|watch)/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // One missing file shouldn't fail the whole install, so they're added
      // individually rather than with addAll.
      // cache: 'reload' skips the browser's HTTP cache, so a new version
      // can't be installed with stale copies of the files it replaces.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (NEVER_CACHE.test(url.pathname)) return;

  // Navigations go to the network first so a new build is picked up on the
  // next load; the cached shell is only there for when the network isn't.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html')),
    );
    return;
  }

  // The app's own code: network first, so every module comes from the same
  // build. Serving some from cache and some fresh is how a new app.js ends up
  // calling a function an old platform.js doesn't have. The cache is only for
  // when there's no network.
  if (/\.(js|css)$/.test(url.pathname) && !url.pathname.startsWith('/vendor/')) {
    event.respondWith(
      fetch(request, { cache: 'no-cache' }).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => caches.match(request)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    })),
  );
});
