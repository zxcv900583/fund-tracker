/* 基金追蹤 Service Worker — 只快取靜態資源（頁面本體與圖表函式庫）。
   API 與帶查詢參數的請求一律交給網路，避免一次性 URL（_fresh=…）與
   no-store 回應堆進 Cache Storage 造成無限膨脹、離線時誤供舊資料。 */
const CACHE_NAME = "fund-tracker-v10";

function isCacheableStatic(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    return url.search === ""; // 同源靜態檔（index.html、sw.js…）；帶參數的請求不快取
  }
  return url.hostname === "cdnjs.cloudflare.com"; // Chart.js CDN
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then((names) => Promise.all(
      names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
    )),
  ]));
});

self.addEventListener("fetch", (event) => {
  if (!isCacheableStatic(event.request)) return; // API 與動態請求走瀏覽器原生路徑
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(
          caches.open(CACHE_NAME)
            .then((cache) => cache.put(event.request, copy))
            .catch((error) => console.warn("Service Worker 快取寫入失敗", error)),
        );
      }
      return response;
    }).catch((networkError) => caches.match(event.request).then((cached) => {
      if (cached) return cached;
      console.warn("Service Worker 網路與快取皆無資料", networkError);
      return Response.error();
    }))
  );
});
