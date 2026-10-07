/* オフライン対応の Service Worker（ネットワーク優先・オフライン時はキャッシュ）
   静的ファイルを触ったら CACHE_NAME を必ず上げること。
   試聴 MP3 は先読みせず、聞いたときにキャッシュする（145本・約2MB を初回に全部落とさないため）。 */
const CACHE_NAME = "koe-studio-v4";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./audio.js",
  "./gemini.js",
  "./store.js",
  "./subs.js",
  "./yomi.js",
  "./manifest.json",
  "./icon.svg",
  "./data/voices.json",
  "./data/samples.json"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  // API へのリクエストには触らない（キー付きのリクエストをキャッシュに残さない）
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
