// Pure helpers: reading a PC's /v1/status, the time-left words, pairing text. No DOM, so node --test covers them.

const APPS = ["smu", "tabgod"];
export const APP_NAMES = { smu: "SMU", tabgod: "TabGod" };

function str(v, max) {
  if (typeof v !== "string") return "";
  const s = v.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function count(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function when(v) {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// A second guard after the PC's own: email addresses and IP addresses never reach the screen.
export function scrub(s) {
  return s
    .replace(/[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[address]")
    .replace(/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, "[address]");
}

const text = (v, max) => scrub(str(v, max));

const RESULTS = ["failed", "skipped"];

// The optional `detail` of a task (PROTOCOL.md): null when missing or unusable; at most 5 recent problems, newest first.
export function normalizeDetail(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const recent = (Array.isArray(raw.recent) ? raw.recent : [])
    .filter((x) => x && typeof x === "object")
    .map((x) => ({ at: when(x.at), result: RESULTS.includes(x.result) ? x.result : "failed", reason: text(x.reason, 200) }))
    .filter((x) => x.reason || x.at != null)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, 5);
  return {
    kind: /^[a-z_]{1,24}$/.test(raw.kind || "") ? raw.kind : "",
    step: text(raw.step, 80),
    page: text(raw.page, 80),
    since: when(raw.since),
    whatToDo: text(raw.what_to_do, 240),
    recent,
  };
}

// A status answer as the app uses it. Anything missing or odd becomes null/""/false; unknown fields are dropped.
export function normalizeStatus(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const d = r.device && typeof r.device === "object" ? r.device : {};
  const tasks = (Array.isArray(r.tasks) ? r.tasks : [])
    .filter((t) => t && typeof t === "object")
    .map((t, i) => {
      const reason = text(t.needs_you_reason, 300);
      return {
        perPersonSeconds: count(t.per_person_seconds),
        gapSeconds: count(t.gap_seconds),
        detail: normalizeDetail(t.detail),
        id: str(String(t.id ?? i), 64) || String(i),
        name: str(t.name, 80) || "Task",
        done: count(t.done),
        failed: count(t.failed),
        left: count(t.left),
        running: t.running === true,
        needsYou: t.needs_you === true || (t.needs_you == null && reason !== ""),
        reason,
        learned: t.learned === true ? true : t.learned === false ? false : null,
        etaSeconds: count(t.eta_seconds),
        etaAt: when(t.eta_at),
      };
    });
  const app = APPS.includes(r.app) ? r.app : null;
  return {
    app,
    device: { name: str(d.name, 40), id: str(d.id, 64), active: d.active === true },
    tasks,
    quefix: app === "tabgod" ? normalizeQuefix(r.quefix) : null,
  };
}

// ---------- QueFix (TabGod's window order, PROTOCOL.md) ----------

// TabGod's optional `quefix`: null when missing or unusable. Rows by rank, at most 100; names masked again here and
// "Window <rank>" when blank; at most 5 out-of-order pairs.
export function normalizeQuefix(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rows = (Array.isArray(raw.rows) ? raw.rows : [])
    .filter((x) => x && typeof x === "object")
    .map((x, i) => {
      const rank = count(x.rank) || i + 1;
      return {
        rank,
        name: text(x.name, 80) || `Window ${rank}`,
        position: text(x.position, 16),
        bar: x.bar === true,
        sure: x.sure !== false,
        near: x.near === true,
        desktop: count(x.desktop),
      };
    })
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 100);
  const pairs = (Array.isArray(raw.out_of_order) ? raw.out_of_order : [])
    .filter((x) => x && typeof x === "object")
    .map((x) => ({ first: text(String(x.first ?? ""), 80), then: text(String(x.then ?? ""), 80) }))
    .filter((x) => x.first && x.then)
    .slice(0, 5);
  const outCount = count(raw.out_of_order_count);
  const out = outCount ?? pairs.length;
  return {
    live: raw.live === true,
    scannedAt: when(raw.scanned_at),
    windows: count(raw.windows) ?? rows.length,
    desktops: count(raw.desktops),
    inOrder: raw.in_order === true || (raw.in_order == null && out === 0),
    outOfOrderCount: out,
    outOfOrder: pairs,
    nearCount: count(raw.near_count) ?? rows.filter((r) => r.near).length,
    rows,
  };
}

// "QueFix live · 24 windows · all in order", "QueFix · 24 windows · 2 out of order" (a manual scan),
// "QueFix live · 24 windows · 2 near front" (profiles above 90% or under 1,000 in the queue), or both.
export function quefixLine(q) {
  const n = q.windows;
  const parts = [`QueFix${q.live ? " live" : ""}`, `${n} ${n === 1 ? "window" : "windows"}`];
  if (q.nearCount) parts.push(`${q.nearCount} near front`);
  if (!q.inOrder) parts.push(`${q.outOfOrderCount || q.outOfOrder.length || "some"} out of order`);
  else if (!q.nearCount) parts.push("all in order");
  return parts.join(" · ");
}

// The profile number in a QueFix name: "Milo (10)" -> "10", "10" -> "10"; "" when there isn't one.
export function profileNumber(name) {
  const m = /^\s*(\d+)\s*$/.exec(name) || /\((\d+)\)\s*$/.exec(name);
  return m ? m[1] : "";
}

// Whether a QueFix row is in one of the out-of-order pairs (matched by profile number or by name).
export function outOfOrderRow(q, row) {
  const n = profileNumber(row.name);
  return q.outOfOrder.some((p) => [p.first, p.then].some((x) => x === row.name || (n && (x === n || profileNumber(x) === n))));
}

// "7 should be before 3".
export function pairText(p) {
  return `${p.first} should be before ${p.then}`;
}

// "scanned 12 s ago", "scanned just now"; "" when the PC didn't say.
export function scannedText(q, now) {
  return q.scannedAt == null ? "" : `scanned ${agoText(now - q.scannedAt)}`;
}

// Tasks in the order they are shown: needs you, running, with people left, then finished ones.
export function sortTasks(tasks) {
  const rank = (t) => (t.needsYou ? 0 : t.running ? 1 : t.left ? 2 : 3);
  return [...tasks].sort((a, b) => rank(a) - rank(b));
}

export function needsYouCount(statuses) {
  let n = 0;
  for (const s of statuses) if (s) for (const t of s.tasks) if (t.needsYou) n++;
  return n;
}

// "under a minute", "52 min", "1 h", "1 h 20 min" (the same words as SMU's own task page).
export function leftText(secs) {
  if (secs < 60) return "under a minute";
  const mins = Math.max(1, Math.round(secs / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function clockText(ms, timeZone) {
  const opts = { hour: "2-digit", minute: "2-digit", hour12: false };
  if (timeZone) opts.timeZone = timeZone;
  return new Intl.DateTimeFormat("en-GB", opts).format(new Date(ms));
}

// Seconds left now. While a run is on, counted down from eta_at (or from eta_seconds at fetch time); otherwise the
// PC's own figure, which doesn't move while nothing runs.
export function secondsLeft(task, now, fetchedAt) {
  if (task.running) {
    if (task.etaAt != null) return Math.max(0, Math.round((task.etaAt - now) / 1000));
    if (task.etaSeconds != null) return Math.max(0, task.etaSeconds - Math.round((now - fetchedAt) / 1000));
    return null;
  }
  return task.etaSeconds;
}

// The task's time line: "about 52 min left · done by 00:41" while it runs, "about 1 h 10 min left" otherwise,
// "learning the form" before it is learned, "" when nobody is left or there is nothing to go on.
export function timeLine(task, now, fetchedAt, timeZone) {
  if (task.left === 0) return "";
  if (task.learned === false) return "learning the form";
  const secs = secondsLeft(task, now, fetchedAt);
  if (secs == null) return "";
  let s = `about ${leftText(secs)} left`;
  if (task.running) s += ` · done by ${clockText(now + secs * 1000, timeZone)}`;
  return s;
}

// The time part of an Active row: { left: "43 min" | "learning the form" | "", by: "done by 01:08" | "" }.
export function rowTime(task, now, fetchedAt, timeZone) {
  if (task.learned === false) return { left: "learning the form", by: "" };
  const secs = task.left === 0 ? null : secondsLeft(task, now, fetchedAt);
  if (secs == null) return { left: "", by: "" };
  return { left: leftText(secs), by: task.running ? `done by ${clockText(now + secs * 1000, timeZone)}` : "" };
}

const byName = (a, b) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true });

// ---------- The home screen: one card per PC ----------

// "Can't reach ZBook · last known 3 min ago", or "· no answer yet" when it never answered.
export function reachText(device, okAt, now) {
  return `Can't reach ${device || "the PC"} · ${okAt ? `last known ${agoText(now - okAt)}` : "no answer yet"}`;
}

const APP_ORDER = (app) => (APPS.includes(app) ? APPS.indexOf(app) : APPS.length);

// One card per PC: SMU and TabGod on one PC share its id and name, so each card is one machine.
// entries: [{ key, app, pcId, device, status | null, error, fetchedAt, okAt, fresh }]; `fresh` false means the
// status is the one kept from before (the PC hasn't answered since the app opened).
// Each app on a PC: { key, app, state, rows, left, okAt, fresh }, state "ok" | "offline" | "token" | "error" |
// "connecting"; rows are its tasks that need you or run, needs you first, then least time left, then the ones
// still learning, by name. A PC that doesn't answer keeps its last known rows, marked stale.
// Cards: needs you first, then running (least time left first), then a problem, then checking, then idle; ties by
// name. A card's state: "needs" | "running" | "offline" | "token" | "error" | "connecting" | "idle".
export function buildGroups(entries, now) {
  const groups = new Map();
  for (const e of entries) {
    const id = e.pcId ? `id:${e.pcId}` : `name:${(e.device || e.key).toLowerCase()}`;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { id, name: e.device, apps: [] }));
    const state = e.error === "token" ? "token" : e.error === "offline" ? "offline" : e.error ? "error"
      : e.status ? (e.fresh === false ? "connecting" : "ok") : "connecting";
    const tasks = e.status ? e.status.tasks : [];
    const rows = tasks.filter((t) => t.needsYou || t.running).map((t) => {
      const secs = t.running && t.learned !== false ? secondsLeft(t, now, e.fetchedAt) : null;
      return { id: `${e.key}/${t.id}`, pcKey: e.key, app: e.app, device: e.device, task: t, secs, fetchedAt: e.fetchedAt,
        stale: state !== "ok", rank: t.needsYou ? 0 : secs != null ? 1 : 2 };
    });
    rows.sort((a, b) => a.rank - b.rank || (a.rank === 1 ? a.secs - b.secs : 0) || byName(a.task.name, b.task.name));
    const left = e.status ? tasks.reduce((n, t) => n + (t.left || 0), 0) : null;
    g.apps.push({ key: e.key, app: e.app, state, rows, left, okAt: e.okAt || 0, fresh: e.fresh !== false,
      quefix: (e.status && e.status.quefix) || null });
  }
  const out = [];
  for (const g of groups.values()) {
    g.apps.sort((a, b) => APP_ORDER(a.app) - APP_ORDER(b.app) || byName(a.key, b.key));
    const rows = g.apps.flatMap((a) => a.rows);
    g.needs = rows.filter((r) => r.task.needsYou).length;
    g.running = rows.filter((r) => r.task.running).length;
    const timed = rows.filter((r) => r.secs != null).map((r) => r.secs);
    g.minSecs = timed.length ? Math.min(...timed) : null;
    const states = g.apps.map((a) => a.state);
    const problem = ["token", "offline", "error"].find((s) => states.includes(s));
    g.state = g.needs ? "needs" : g.running && states.includes("ok") ? "running" : problem || (states.includes("connecting") ? "connecting" : "idle");
    out.push(g);
  }
  const rank = { needs: 0, running: 1, token: 2, offline: 3, error: 4, connecting: 5, idle: 6 };
  out.sort((a, b) => rank[a.state] - rank[b.state]
    || (a.state === "running" ? (a.minSecs ?? Infinity) - (b.minSecs ?? Infinity) : 0)
    || byName(a.name || "", b.name || ""));
  return out;
}

export const GROUP_LABELS = { needs: "Needs you", running: "Running", offline: "Can't reach", token: "Not paired",
  error: "Error", connecting: "Checking…", idle: "Idle" };

// The line for an app with nothing to show as a row.
export function appNote(a, device, now) {
  if (a.state === "offline" || a.state === "error") {
    return a.state === "error" && a.okAt ? `It answered with an error · last known ${agoText(now - a.okAt)}` : reachText(device, a.okAt, now);
  }
  if (a.state === "token") return "No longer paired with this device";
  if (a.state === "connecting" && !a.okAt) return "Checking…";
  return a.left ? `Nothing running · ${a.left} left` : "Nothing running";
}

// ---------- The detail view ----------

// SMU's own wait reasons (smu_app.pyw wait_reason) and the kind each one means.
const SMU_REASONS = {
  "needs attention": "attention",
  "a question": "question",
  "is this the form's email?": "email_check",
  "watching you fill the form": "watching",
  "finish your own sign-up": "finish",
};

// What kind of wait this is: the PC's detail.kind when sent, else read from the reason. For SMU any other reason is
// IWM's notice; for TabGod every wait is a profile left open for the owner.
export function kindOf(app, task) {
  if (task.detail && task.detail.kind) return task.detail.kind;
  if (!task.needsYou) return "";
  if (app === "tabgod") return "stuck";
  if (app === "smu") return SMU_REASONS[task.reason.toLowerCase()] || (task.reason ? "iwm" : "attention");
  return "stuck";
}

export const KIND_TITLES = {
  attention: "Stuck on a step",
  question: "A question for you",
  email_check: "Checking the form's email",
  watching: "Waiting for you to fill the form",
  finish: "Your own sign-up to finish",
  iwm: "IWM needs you",
  stuck: "Stuck on a step",
};

// "What to do", in plain words. The PC's own sentence wins; otherwise one for the app and the kind of wait.
export function whatToDo(app, task, device) {
  if (!task.needsYou) return "";
  if (task.detail && task.detail.whatToDo) return task.detail.whatToDo;
  const on = device || "the PC";
  if (app === "tabgod") return `Open TabGod on ${on}, the window was left for you on that profile.`;
  if (app !== "smu") return `Open the app on ${on} to see what it needs.`;
  switch (kindOf(app, task)) {
    case "attention":
      return `On ${on}, open SMU, press Show SMU, do the step yourself, then press Carry on.`;
    case "question":
      return `Answer SMU's question on ${on}.`;
    case "email_check":
      return `On ${on}, open SMU and say whether this is the form's email.`;
    case "watching":
      return `On ${on}, fill the form yourself while SMU watches, then press Done.`;
    case "finish":
      return `On ${on}, finish your own sign-up in the browser, then press I've finished in SMU.`;
    case "iwm":
      return `Fix it in IWM on ${on}; SMU carries on when IWM moves on.`;
    default:
      return `Open SMU on ${on} to see what it needs.`;
  }
}

// "What's wrong": the headline and the facts that are known. Never empty for a task that needs the owner.
export function whatsWrong(app, task, now) {
  if (!task.needsYou) return null;
  const d = task.detail || {};
  const kind = kindOf(app, task);
  const facts = [];
  if (d.step) facts.push(["Step", d.step]);
  if (d.page) facts.push(["Page", d.page]);
  if (d.since != null) facts.push(["Waiting", now - d.since < 60_000 ? "under a minute" : leftText((now - d.since) / 1000)]);
  return { title: task.reason || KIND_TITLES[kind] || "It needs you", kind: KIND_TITLES[kind] || "", facts };
}

// "1 min 35 s", "45 s", "2 h 5 min": time per person.
export function perPersonText(secs) {
  if (secs == null) return "";
  if (secs < 60) return `${Math.max(1, Math.round(secs))} s`;
  if (secs < 3600) {
    const m = Math.floor(secs / 60), s = Math.round(secs % 60);
    return s ? `${m} min ${s} s` : `${m} min`;
  }
  return leftText(secs);
}

// "14:05" today, "31 Oct 14:05" on another day.
export function whenText(ms, now, timeZone) {
  const day = (t) => new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).format(new Date(t));
  if (day(ms) === day(now)) return clockText(ms, timeZone);
  const d = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" }).format(new Date(ms));
  return `${d} ${clockText(ms, timeZone)}`;
}

// The status line at the top of the detail view.
export function taskState(task) {
  if (task.needsYou) return "Needs you";
  if (task.running) return task.learned === false ? "Running · learning the form" : "Running";
  if (task.left === 0) return "Finished";
  return "Not running";
}

// "just now", "12 s ago", "3 min ago", "2 h ago".
export function agoText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

// Pairing codes as the PC makes them: Crockford base32, shown XXXX-XXXX. Typed codes forgive case, spaces, dashes
// and the letters that look like digits.
export function normalizeCode(text) {
  const s = String(text || "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(s)) return "";
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

// A typed PC address as an https base URL. "zbook" alone uses the tailnet of a PC paired before ("tail1234.ts.net").
// http is kept only for this computer itself (the test PC in dev/mock_pc.py).
export function normalizeAddress(text, knownSuffix = "") {
  const raw = String(text || "").trim();
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/?$/i.exec(raw);
  if (local) return `http://${local[1].toLowerCase()}${local[2] || ""}`;
  const s = raw.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  if (!s) return "";
  const [host0, port] = s.split(":");
  let host = host0;
  if (!/^[a-z0-9.-]+$/.test(host) || (port !== undefined && !/^\d{1,5}$/.test(port))) return "";
  if (!host.includes(".") && knownSuffix) host = `${host}.${knownSuffix}`;
  if (!host.includes(".")) return "";
  return `https://${host}${port && port !== "443" ? `:${port}` : ""}`;
}

// The tailnet part of a paired PC's address: "https://zbook.tail1234.ts.net" -> "tail1234.ts.net".
export function tailnetSuffix(url) {
  const m = /^https:\/\/[^./:]+\.([^/:]+\.ts\.net)(?::\d+)?$/i.exec(String(url || ""));
  return m ? m[1].toLowerCase() : "";
}

// The QR code's text: {"lmk":1,"app","url","pc","name","code"}. null when it isn't a Let Me Know code.
export function parsePairing(text) {
  let o;
  try {
    o = JSON.parse(String(text || "").trim());
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || o.lmk !== 1) return null;
  const url = normalizeAddress(o.url);
  const code = normalizeCode(o.code);
  if (!url || !code) return null;
  return { app: APPS.includes(o.app) ? o.app : null, url, pc: str(o.pc, 64), name: str(o.name, 40), code };
}

// A default name for this device: iPadOS says "Macintosh" but has touch.
export function guessDeviceName(ua = "", touchPoints = 0) {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  return "This device";
}

// base64url (VAPID public key) -> bytes, for pushManager.subscribe.
export function b64urlToBytes(s) {
  const t = String(s);
  const b64 = t.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((t.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
