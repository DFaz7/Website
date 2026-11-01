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

// A status answer as the app uses it. Anything missing or odd becomes null/""/false; unknown fields are dropped.
export function normalizeStatus(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const d = r.device && typeof r.device === "object" ? r.device : {};
  const tasks = (Array.isArray(r.tasks) ? r.tasks : [])
    .filter((t) => t && typeof t === "object")
    .map((t, i) => {
      const reason = str(t.needs_you_reason, 160);
      return {
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
  return {
    app: APPS.includes(r.app) ? r.app : null,
    device: { name: str(d.name, 40), id: str(d.id, 64), active: d.active === true },
    tasks,
  };
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
