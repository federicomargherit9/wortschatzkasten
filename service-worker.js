/* Wortschatzkasten — service worker: cache dell'app + notifiche */

const CACHE_NAME = "wortschatzkasten-shell-v4";
const SHELL_FILES = ["./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];
const TITLE = "Der Wortschatzkasten";

/* ------------------------------ cache ------------------------------ */

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // il lessico arriva sempre dalla rete, così le parole nuove compaiono subito
  if (url.pathname.endsWith("vocab-data.json")) {
    event.respondWith(fetch(req, { cache: "no-store" }).catch(() => caches.match(req)));
    return;
  }

  // la pagina: prima la rete (così gli aggiornamenti arrivano), se manca la connessione la copia salvata
  if (req.mode === "navigate" || url.pathname.endsWith("index.html")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match(req)))
    );
    return;
  }

  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});

/* ------------------------------ stato condiviso con l'app ------------------------------ */
// L'app salva in IndexedDB l'ultimo giorno in cui hai fatto un'azione valida per la streak
// e quanti giorni di fila hai. Qui lo leggo per scegliere il testo della notifica.

function idbOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("wk-sw", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function idbGet(key) {
  return idbOpen().then(
    (db) => new Promise((resolve, reject) => {
      const q = db.transaction("kv").objectStore("kv").get(key);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    })
  );
}
function idbSet(key, value) {
  return idbOpen().then(
    (db) => new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    })
  );
}

function dayString(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/* ------------------------------ testi predefiniti ------------------------------ */
// {n} = giorni di fila. I testi con {n} escono solo se la streak è di almeno 2 giorni.

// oggi NON hai ancora fatto nessuna azione che conta per la streak
const POOL_TODO = [
  "📚 Ricordati di ripassare!",
  "🔥 Continua la tua streak di {n} giorni!",
  "💪 FORZA UOMOOO! IL TEDESCO NON ASPETTA!",
  "⏰ Bastano 5 minuti: una scheda e la giornata è salva!",
  "🚨 La tua streak di {n} giorni è in pericolo! Fai almeno un ripasso.",
  "🇩🇪 Oggi niente scuse: apri il Kasten e ripassa un po'.",
  "😤 Non lasciare che il tedesco vinca oggi!",
  "🧠 Una parola al giorno toglie il Nichtverstehen di torno!",
  "📖 Der, die o das? Vieni a scoprirlo!",
  "⭐ Un ripasso veloce adesso e poi sei libero/a!",
  "🥨 Il Kasten ha fame di ripassi. Dagli da mangiare!",
  "🎯 Una sessione piccola oggi vale più di una grande mai."
];
// oggi hai GIÀ fatto un'azione valida: la notifica arriva comunque, ma ti invita a fare di più
const POOL_DONE = [
  "🌟 Che ne dici di imparare altre parole nuove?",
  "💪 FORZA UOMOOO! DIVENTA UN TEDESCO NATIVO! Ripassa ancoraaaa",
  "🎉 Streak al sicuro per oggi! Un altro ripasso per fare il pieno?",
  "🧩 Il tuo l'hai già fatto: un quiz per divertirti?",
  "🚀 Sei in forma: perché non aggiungi qualche parola nuova?",
  "🏆 Oggi sei già a posto. Un ripasso bonus non fa mai male!",
  "🔥 {n} giorni di fila: continua così, campione!",
  "🍀 Bravo/a! Ancora cinque schede e domani sarà tutto più facile.",
  "🗣️ Prova a dire una frase in tedesco ad alta voce, adesso!",
  "📈 Ogni parola in più è un passo verso la certificazione!"
];

function shuffleIdx(n) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pesca a caso senza ripetere finché non sono usciti tutti i testi disponibili.
async function pickDefault(state) {
  const now = new Date();
  const todayStr = dayString(now);
  const y = new Date(now); y.setDate(y.getDate() - 1);
  const yesterdayStr = dayString(y);

  const done = state.lastDay === todayStr;
  const alive = done || state.lastDay === yesterdayStr; // streak ancora viva?
  const n = alive ? Number(state.streak) || 0 : 0;

  const poolName = done ? "done" : "todo";
  const pool = done ? POOL_DONE : POOL_TODO;
  const usable = pool.map((t, i) => i).filter((i) => !pool[i].includes("{n}") || n >= 2);

  const memKey = "bag:" + poolName;
  let mem = (await idbGet(memKey).catch(() => null)) || { bag: [], last: -1 };
  let bag = mem.bag.filter((i) => usable.includes(i));
  if (!bag.length) {
    bag = shuffleIdx(pool.length).filter((i) => usable.includes(i));
    if (bag.length > 1 && bag[0] === mem.last) bag.push(bag.shift()); // non riproporre subito l'ultimo
  }
  const idx = bag.shift();
  await idbSet(memKey, { bag, last: idx }).catch(() => {});
  return pool[idx].replace(/\{n\}/g, String(n));
}

/* ------------------------------ notifiche push ------------------------------ */

async function handlePush(event) {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }

  let body;
  if (data.kind === "test") {
    body = "✅ Notifica di prova: tutto funziona!";
  } else if (data.kind === "custom" && data.text) {
    body = data.text;
  } else {
    const state = (await idbGet("state").catch(() => null)) || {};
    body = await pickDefault(state);
  }

  await self.registration.showNotification(TITLE, {
    body,
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: data.id || "wk",
    data: { url: "#ripasso" },
  });
}

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = self.registration.scope + ((event.notification.data && event.notification.data.url) || "");
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.registration.scope) && "focus" in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
