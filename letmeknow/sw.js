// Let Me Know service worker: the app shell offline, updates, and alerts.
// VERSION must match app.js; a change here is what makes phones pick up a new version.
const VERSION = "2.2.0";
const CACHE = `lmk-${VERSION}`;
const LOCAL = ["localhost", "127.0.0.1"].includes(self.location.hostname);
const SHELL = [
  "./",
  "index.html",
  "app.css",
  "app.js",
  "theme.js",
  "lib/answer.mjs",
  "lib/api.mjs",
  "lib/nav.mjs",
  "lib/patch.mjs",
  "lib/push.mjs",
  "lib/scan.mjs",
  "lib/status.mjs",
  "lib/store.mjs",
  "lib/tokens.mjs",
  "vendor/jsqr.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/badge-96.png",
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
    const p = event.data ? event.data.json() : {};
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

const APP = { smu: "SMU", tabgod: "TabGod" };
// A needs_you the PC can take an answer to shows these as the alert's buttons (where the browser shows buttons:
// not on iPhone or iPad, where the app's own page for that alert has them). The same words as lib/answer.mjs.
const ANSWER_LABELS = { skip: "Skip this person", do_it: "I'll do it", retry: "Retry" };

// The same second guard as the app's own (lib/status.mjs scrub): email and IP addresses never reach the screen.
function scrub(s) {
  return s
    .replace(/[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[address]")
    .replace(/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, "[address]");
}

function cut(s, n) {
  s = typeof s === "string" ? scrub(s.replace(/\s+/g, " ").trim()) : "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// The phone's own words when a push has no title or body (PROTOCOL.md, Push). A "stopped" push with reason
// "quiet" is a PC that went quiet mid-run (it may be off or crashed).
function words(p) {
  const pc = cut(p.pc_name, 40) || "A PC";
  const task = cut(p.task_name, 80);
  const on = (s) => (task ? `${task}: ${s}` : s.charAt(0).toUpperCase() + s.slice(1));
  switch (p.kind) {
    case "finished":
      return [`${pc} finished`, on("done")];
    case "failed":
      return [`${pc}: a run stopped`, on("stopped on an error")];
    case "stopped":
      if (p.reason === "quiet") return [`${pc} went quiet`, on(`no word from ${pc} (it may be off or crashed)`)];
      return [`${pc}: a run stopped`, on("stopped")];
    case "test":
      return [`Test alert from ${pc}`, "Alerts work on this device."];
    case "needs_you":
      return [`${pc} needs you`, on("open Let Me Know to see why")];
    case "queue": // TabGod's QueFix: profiles that just got near the front of their queue
      return ["A profile is near the front", `QueFix on ${pc}`];
    default: // a kind this version doesn't know, or an unreadable push: say nothing it can't know
      return [p.pc_name ? `News from ${pc}` : "Let Me Know", on("open Let Me Know to see what's new")];
  }
}

// What a push shows: { title, options }. Kept apart from the event so tests can check it.
function notice(p) {
  const [t, b] = words(p);
  const app = APP[p.app] ? p.app : p.kind === "queue" ? "tabgod" : "";
  const pc = typeof p.pc === "string" && /^[0-9A-Za-z_-]{1,64}$/.test(p.pc) ? p.pc : "";
  // A queue alert always opens the QueFix list, and keeps its own place on the lock screen (one per PC).
  const task = p.kind === "queue" ? "quefix" : typeof p.task === "string" ? p.task.slice(0, 64) : "";
  const tagTask = p.kind === "queue" ? "qf-near" : task;
  const at = Date.parse(p.at);
  const options = {
    body: cut(p.body, 200) || b,
    tag: `${app || "app"}-${pc || "pc"}-${tagTask || p.kind || "task"}`,
    renotify: true,
    icon: "icons/icon-192.png",
    badge: "icons/badge-96.png", // one colour: Android draws only its shape in the status bar
    data: { app, pc, task, kind: typeof p.kind === "string" ? p.kind : "" },
  };
  if (Number.isFinite(at)) options.timestamp = at;
  const answers = Array.isArray(p.answers) ? [...new Set(p.answers)].filter((a) => ANSWER_LABELS[a]) : [];
  if (p.kind === "needs_you" && task && typeof p.question === "string" && /^q_[0-9A-Za-z_-]{4,40}$/.test(p.question) && answers.length) {
    options.actions = answers.map((a) => ({ action: a, title: ANSWER_LABELS[a] })); // the browser shows as many as it can
    options.data.question = p.question;
    options.data.answers = answers;
  }
  return { title: cut(p.title, 80) || t, options };
}

self.addEventListener("push", (event) => {
  const n = notice(readPush(event));
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(n.title, n.options);
      // An open app refreshes at once instead of at its next poll.
      for (const w of await self.clients.matchAll({ type: "window" })) w.postMessage({ type: "refresh" });
    })(),
  );
});

// Tapping an alert opens the app on that PC and task: an open window is told by message, else a new one opens at
// ./?pc=..&app=..&task=.. One of its answer buttons does the same and adds the answer (&q=..&answer=..), which the
// app sends to the PC once and shows what came of it on that task's page.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const reply = d.question && Array.isArray(d.answers) && d.answers.includes(event.action) ? event.action : "";
  const target = new URL("./", self.location);
  if (d.pc) {
    target.searchParams.set("pc", d.pc);
    if (d.app) target.searchParams.set("app", d.app);
    if (d.task) target.searchParams.set("task", d.task);
    if (reply) {
      target.searchParams.set("q", d.question);
      target.searchParams.set("answer", reply);
    }
  }
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) {
          await w.focus();
          if (d.pc) {
            const m = { type: "open", pc: d.pc, app: d.app || "", task: d.task || "" };
            if (reply) Object.assign(m, { question: d.question, answer: reply });
            w.postMessage(m);
          }
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
