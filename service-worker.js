/* Der Wortschatzkasten — service worker.
   Regola: l'app deve aprirsi anche in aereo. Tutto il guscio sta in cache,
   il lessico pure, ma in background si aggiorna appena c'è rete. */

const CACHE = "wortschatz-v2";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./vocab-data.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll fallisce in blocco se un file manca: meglio uno alla volta.
      .then((cache) => Promise.all(SHELL.map((f) => cache.add(f).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Lessico: mostro subito la copia salvata e intanto scarico quella nuova.
  if (url.pathname.endsWith("vocab-data.json")) {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        fetch(req, { cache: "no-store" })
          .then((res) => {
            if (res && res.ok) cache.put("./vocab-data.json", res.clone());
            return res;
          })
          .catch(() => cache.match("./vocab-data.json"))
      )
    );
    return;
  }

  // Navigazione: rete se c'è, altrimenti la pagina salvata.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Tutto il resto: cache prima, rete come riserva.
  event.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
    )
  );
});
