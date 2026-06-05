// Service Worker: アプリシェルをキャッシュしオフライン閲覧を可能にする。
// データの正は Google Drive。ここがキャッシュするのはアプリのコードと銘柄リストのみ。
const CACHE = "tradebook-shell-v23";
const ASSETS = [
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/pnl.js",
  "./js/store.js",
  "./js/indicators.js",
  "./js/drive.js",
  "./js/stocks.js",
  "./js/prices.js",
  "./js/charts.js",
  "./js/config.js",
  "./js/vendor/chart.umd.min.js",
  "./data/stocks.json",
  "./data/latest_prices.json",
  "./manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Google API / 認証はキャッシュせず常にネットワーク
  if (url.hostname.endsWith("googleapis.com") || url.hostname.endsWith("google.com")) {
    return;
  }
  // 最新終値はネットワーク優先（オンライン時は最新を取得、失敗時はキャッシュへフォールバック）。
  // 日次で更新されるため、SW再インストールを待たずに新しい価格を反映できる。
  if (url.pathname.endsWith("/data/latest_prices.json")) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  // エントリー・スナップショットの指標JSONはネットワーク優先＋取得分をキャッシュ（オフライン保険）。
  if (url.pathname.includes("/data/indicators/")) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  // アプリシェルはキャッシュ優先
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
