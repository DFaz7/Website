// Alerts: whether this browser can get them, the one push subscription, and which PCs know it. The browser objects
// (Notification, the service worker registration) come in as arguments, so node --test covers it with fakes.
import { b64urlToBytes } from "./status.mjs";

// What this browser can do about alerts:
//   "ok"      web push works here;
//   "install" an iPhone/iPad Safari tab: web push works only in the Home Screen app;
//   "old"     the Home Screen app on an iOS older than 16.4;
//   "none"    a browser without web push.
export function support({ ua = "", touchPoints = 0, standalone = false, hasPush = false } = {}) {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
  if (ios && !standalone) return "install";
  if (hasPush) return "ok";
  return ios ? "old" : "none";
}

function bytes(key) {
  try {
    return b64urlToBytes(key);
  } catch {
    return null;
  }
}

export function keysEqual(a, b) {
  const x = typeof a === "string" ? bytes(a) : a ? new Uint8Array(a) : null;
  const y = typeof b === "string" ? bytes(b) : b ? new Uint8Array(b) : null;
  return !!x && !!y && x.length > 0 && x.length === y.length && x.every((v, i) => v === y[i]);
}

// The alert key this device subscribes with: the one most paired PCs share (ties: the PC paired first). Every PC
// should send the same one (PROTOCOL.md, Push); a PC with another key can't reach this device.
export function alertKey(pcs) {
  const n = new Map();
  for (const p of pcs) if (p.vapid) n.set(p.vapid, (n.get(p.vapid) || 0) + 1);
  let best = "", most = 0;
  for (const [k, c] of n) {
    if (c > most) {
      best = k;
      most = c;
    }
  }
  return best;
}

// PCs whose alerts can't reach this device: their key isn't the one it subscribes with.
export function otherKeyPcs(pcs) {
  const key = alertKey(pcs);
  return pcs.filter((p) => p.vapid && !keysEqual(p.vapid, key));
}

// true / false, or null when the browser doesn't say which key a subscription was made with.
export function subKeyMatches(sub, key) {
  const k = sub && sub.options && sub.options.applicationServerKey;
  if (!k) return null;
  return keysEqual(k, key);
}

// Asks for permission. Call it straight from a tap, before any await: browsers only ask inside a user gesture.
export function askPermission(N) {
  if (!N) return Promise.resolve("denied");
  if (N.permission !== "default") return Promise.resolve(N.permission);
  try {
    let done;
    const viaCallback = new Promise((resolve) => {
      done = resolve;
    });
    const r = N.requestPermission(done); // old Safari answers through the callback only
    return r && typeof r.then === "function" ? r.then((x) => x || N.permission, () => N.permission) : viaCallback;
  } catch {
    return Promise.resolve(N.permission);
  }
}

// The subscription for `key`: the current one when it fits, else a new one (an old one made with another key is
// dropped first: one registration holds one subscription, bound to one key). Throws when subscribe() fails.
export async function ensureSubscription(reg, key) {
  let sub = null;
  try {
    sub = await reg.pushManager.getSubscription();
  } catch {
    sub = null;
  }
  if (sub && subKeyMatches(sub, key) !== false) return { sub, fresh: false };
  if (sub) {
    try {
      await sub.unsubscribe();
    } catch {
      // subscribe() below replaces it or says why not
    }
  }
  sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });
  return { sub, fresh: true };
}

// Tells every PC what it needs to know, in parallel: PCs with this device's alert key get the subscription when its
// endpoint isn't the one they were last given; PCs with another key, or all of them when `sub` is null (alerts
// blocked), are told to stop when they had one. Returns the store patches to keep and the PCs that didn't answer
// (tried again later).
export async function syncPcs(pcs, sub, key, setMe) {
  const endpoint = sub ? sub.endpoint : "";
  const json = sub ? (typeof sub.toJSON === "function" ? sub.toJSON() : sub) : null;
  const patches = [], failed = [];
  await Promise.all(pcs.map(async (pc) => {
    const ours = !!sub && !!pc.vapid && keysEqual(pc.vapid, key);
    const want = ours ? endpoint : "";
    if ((pc.pushEndpoint || "") === want) return;
    try {
      await setMe(pc, { push: ours ? json : null });
      patches.push([pc.key, { pushEndpoint: want }]);
    } catch (e) {
      failed.push([pc.key, (e && e.kind) || "http"]);
    }
  }));
  return { patches, failed };
}

// Keeps alerts on without asking: with permission granted, makes sure the subscription is there and fits the key,
// and every PC has it. With permission denied, PCs that had it are told to stop. Otherwise nothing is done.
// { sub, patches, failed, error }: error is "subscribe" when the browser refused a new subscription.
export async function keepAlertsOn({ permission, reg, pcs, setMe }) {
  const key = alertKey(pcs);
  const none = { sub: null, patches: [], failed: [], error: "" };
  if (!reg || !key) return none;
  if (permission === "denied") return { ...none, ...(await syncPcs(pcs, null, key, setMe)) };
  if (permission !== "granted") return none;
  let sub;
  try {
    ({ sub } = await ensureSubscription(reg, key));
  } catch {
    return { ...none, error: "subscribe" };
  }
  return { sub, ...(await syncPcs(pcs, sub, key, setMe)), error: "" };
}

// What the alerts card says: "on" | "off" | "blocked" | "install" | "old" | "none" | "nopc" | "nokey".
export function alertsState({ supported, permission, sub, pcs }) {
  if (supported !== "ok") return supported;
  if (!pcs.length) return "nopc";
  if (!alertKey(pcs)) return "nokey";
  if (permission === "denied") return "blocked";
  if (permission === "granted" && sub) return "on";
  return "off";
}
