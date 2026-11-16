/**
 * Offline support, deliberately narrow.
 *
 * A service worker is the one piece of a web app that can break a site
 * permanently: it sits in front of every request and survives reloads, so a
 * bad cache can serve a broken page forever with no obvious way out. This one
 * is written to fail open rather than fail stuck.
 *
 * The rules:
 *
 *  - **Only same-origin GETs are touched.** Tiles, Overpass and Nominatim go
 *    straight to the network, always. Caching a tile server would break the
 *    map's own cache headers and quietly hoard megabytes.
 *  - **The page is network-first.** A stale app shell is how you ship a fix
 *    nobody receives; the cache is the fallback for being offline, not the
 *    default source.
 *  - **`deals.json` is network-first too**, because a week-old happy hour is
 *    worse than a slow one. Falling back to the cached copy is still better
 *    than an empty map on the subway.
 *  - **Bumping VERSION drops every old cache**, so a deploy cannot leave a
 *    mixture of old and new files behind.
 */

const VERSION = "clocktails-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", (event) => {
  // Take over promptly; the alternative is a new worker idling behind the old
  // one until every tab closes, which for a home-screen app can be days.
  self.skipWaiting();
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      // Individually, so one 404 does not abort the whole install.
      Promise.allSettled(SHELL.map((url) => cache.add(url))),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** Network first, cache as the safety net. */
async function freshest(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const copy = response.clone();
      void caches.open(VERSION).then((cache) => cache.put(request, copy));
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Anything off-origin — tiles, Overpass, Nominatim — is none of our business.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    freshest(request).catch(async () => {
      // Offline and never cached: for a navigation, the shell is a better
      // answer than the browser's dinosaur.
      if (request.mode === "navigate") {
        const shell = await caches.match("./index.html");
        if (shell) return shell;
      }
      return new Response("Offline and not cached yet.", {
        status: 503,
        headers: { "content-type": "text/plain" },
      });
    }),
  );
});

// An escape hatch: the page can tell a wedged worker to stand down.
self.addEventListener("message", (event) => {
  if (event.data === "unregister") {
    void self.registration.unregister().then(() =>
      caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))),
    );
  }
});
