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

const CACHE = 'nuvio-shell-v116';

const SHELL = [
  '/',
  '/index.html',
  '/style.css?v=115',
  '/app.js?v=115',
  '/platform.js?v=115',
  '/player.js?v=115',
  '/controls.js?v=115',
  '/livetv.js?v=115',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  // The player library. Worth caching: it is the largest thing the app
  // loads, and it is needed every time anything is played.
  '/vendor/hls.light.min.js',
  '/vendor/libpgs.js',
  '/vendor/libpgs.worker.js',
];

// How long a launch waits on the network for the page before using the
// cached one.
const NAVIGATE_TIMEOUT_MS = 2500;

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
  // next load. On a slow or flaky connection, though, waiting the whole way
  // for a timeout before falling back is what made the home-screen app sit
  // on a blank screen: after a moment the cached shell is used instead, and
  // the network copy still refreshes the cache for next time.
  if (request.mode === 'navigate' && !['/', '/index.html'].includes(url.pathname)) {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }
  if (request.mode === 'navigate') {
    const network = fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put('/index.html', copy));
      }
      return response;
    });
    event.waitUntil(network.catch(() => {}));
    event.respondWith(new Promise((resolve) => {
      let settled = false;
      const fallback = () => caches.match('/index.html').then((hit) => {
        if (hit && !settled) { settled = true; resolve(hit); }
        return hit;
      });
      const timer = setTimeout(fallback, NAVIGATE_TIMEOUT_MS);
      network.then((response) => {
        clearTimeout(timer);
        if (!settled) { settled = true; resolve(response); }
      }).catch(() => {
        clearTimeout(timer);
        fallback().then((hit) => { if (!hit && !settled) { settled = true; resolve(Response.error()); } });
      });
    }));
    return;
  }

  // A versioned file (/app.js?v=115) is that build's copy and never changes,
  // and index.html names every one by version, so all the modules always
  // come from one build. Those are served straight from the cache: no
  // network round trip at all on launch.
  if (url.searchParams.has('v') && /\.(js|css)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })),
    );
    return;
  }

  // Anything else of the app's own code: network first, so every module
  // comes from the same build. The cache is only for when there's no network.
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
