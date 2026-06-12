/* 基金追蹤 Service Worker — 網路優先、失敗時回退快取（離線可看最後資料） */
const CACHE_NAME = "fund-tracker-v8";

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
  if (event.request.method !== "GET") return;
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
