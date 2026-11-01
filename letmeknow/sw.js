// Let Me Know service worker: the app shell offline, updates, and alerts.
// VERSION must match app.js; a change here is what makes phones pick up a new version.
const VERSION = "1.0.0";
const CACHE = `lmk-${VERSION}`;
const LOCAL = ["localhost", "127.0.0.1"].includes(self.location.hostname);
const SHELL = [
  "./",
  "index.html",
  "app.css",
  "app.js",
  "lib/api.mjs",
  "lib/scan.mjs",
  "lib/status.mjs",
  "lib/store.mjs",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: "reload" }))))),
  );
  // No skipWaiting here: the app offers the update and the user taps it.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith("lmk-") && k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

// Only this app's own files come from the cache; calls to the PCs always go to the network.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(new URL("./", self.location).pathname)) return;
  if (LOCAL) return; // testing on this computer: always the files on disk
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const key = req.mode === "navigate" ? "index.html" : req;
      const hit = await cache.match(key, { ignoreSearch: req.mode === "navigate" });
      if (hit) return hit;
      try {
        return await fetch(req);
      } catch {
        return (await cache.match("index.html")) || Response.error();
      }
    })(),
  );
});

// Alerts. iOS needs every push to show a notification, so an unreadable one still shows something.
function readPush(event) {
  try {
    return event.data ? event.data.json() : {};
  } catch {
    return {};
  }
}

const KIND_TITLE = { needs_you: "needs you", finished: "finished", failed: "stopped", stopped: "stopped", test: "test alert" };
const APP = { smu: "SMU", tabgod: "TabGod" };

function cut(s, n) {
  s = typeof s === "string" ? s.trim() : "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

self.addEventListener("push", (event) => {
  const p = readPush(event);
  const pcName = cut(p.pc_name, 40) || "A PC";
  const title = cut(p.title, 80) || `${pcName} ${KIND_TITLE[p.kind] || "needs you"}`;
  const body = cut(p.body, 200) || [APP[p.app], cut(p.task_name, 80)].filter(Boolean).join(" · ") || "Open Let Me Know to see why.";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: `${p.app || "app"}-${p.pc || "pc"}-${p.task || "task"}`,
      renotify: true,
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      data: { app: APP[p.app] ? p.app : "" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const app = event.notification.data && event.notification.data.app;
  const target = new URL(app ? `./?tab=${app}` : "./", self.location).href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) {
          await w.focus();
          if ("navigate" in w) await w.navigate(target).catch(() => {});
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
