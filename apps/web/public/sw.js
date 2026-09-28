// DubRoom service worker (§11.5): cache-first for content-hashed media, so replaying a clip is
// instant. Keys are immutable (hash in the name), so no revalidation is needed.
const CACHE = "dubroom-media-v1";
const MAX_ENTRIES = 400; // ≈ 300 MB at typical clip sizes; oldest entries are evicted first
const HASHED = /^\/media\/clips\/.+\.[0-9a-f]{8}\.\w+$/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== location.origin ||
    !HASHED.test(url.pathname)
  )
    return;
  // let range requests (preloading) go to the network; full responses are cached
  if (event.request.headers.has("range")) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(event.request);
      if (hit) {
        // refresh LRU position
        cache.put(event.request, hit.clone()).catch(() => {});
        return hit;
      }
      const res = await fetch(event.request);
      if (res.ok && res.status === 200) {
        cache
          .put(event.request, res.clone())
          .then(() => trim(cache))
          .catch(() => {});
      }
      return res;
    }),
  );
});
