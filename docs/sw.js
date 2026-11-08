// Caches the app shell so it opens instantly and works without signal.
const CACHE = "slabscan-v8";
const SHELL = ["./", "index.html", "styles.css", "app.js", "sync.js", "parse.js", "manifest.webmanifest",
  "icon.svg", "icon-180.png", "scanner.js", "vendor/zxing-reader.js", "vendor/zxing_reader.wasm", "vendor/xlsx.mini.min.js"];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return; // never cache lookups
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
