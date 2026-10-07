/* オフライン対応の Service Worker（ネットワーク優先・オフライン時はキャッシュ）
   静的ファイルを触ったら CACHE_NAME を必ず上げること。
   試聴 MP3 は先読みせず、聞いたときにキャッシュする（145本・約2MB を初回に全部落とさないため）。

   画面のファイル（HTML・JS・CSS・JSON）は、ブラウザの HTTP キャッシュを使わず、毎回サーバーに「変わっていないか」を確かめる
   （cache: "no-cache"。変わっていなければ 304 で中身は送られない）。GitHub Pages は max-age=600 を付けて返すので、
   ただ fetch すると公開した直後の10分間、新しい index.html と HTTP キャッシュに残った古い app.js が混ざって動く
   （2026-10-08、公開版で「Google 側の記録」の切り替えが効かなかった）。先読み（install）も同じ理由でキャッシュを通さない。 */
const CACHE_NAME = "koe-studio-v7";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./player.js",
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
  e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" })))));
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
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // API へのリクエストには触らない（キー付きのリクエストをキャッシュに残さない）
  if (url.origin !== self.location.origin) return;
  const appFile = req.mode === "navigate" || url.pathname.endsWith("/") || /\.(html|js|css|json)$/.test(url.pathname);
  // 画面のファイルは毎回サーバーに確かめる。試聴 MP3 などは今までどおり（Range などのヘッダーを保つため e.request のまま）
  const net = appFile ? fetch(url.href, { cache: "no-cache", credentials: "same-origin" }) : fetch(req);
  e.respondWith(
    net
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
