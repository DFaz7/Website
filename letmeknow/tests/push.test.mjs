// node --test letmeknow/tests/push.test.mjs
// Alerts with fake browser objects: permission, subscribe and re-subscribe, telling every PC; and the service
// worker's alerts and taps, run in a sandbox.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import * as push from "../lib/push.mjs";
import { scrub } from "../lib/status.mjs";

const keyOf = (fill) => Buffer.from([4, ...new Array(64).fill(fill)]).toString("base64url");
const KEY_A = keyOf(1);
const KEY_B = keyOf(2);

function fakeReg({ sub = null, failSubscribe = false } = {}) {
  const reg = { subscribed: 0, unsubscribed: 0 };
  const makeSub = (endpoint, key) => ({
    endpoint,
    options: { applicationServerKey: key === undefined ? null : new Uint8Array(key).buffer },
    async unsubscribe() {
      reg.unsubscribed++;
      if (reg.pushManager.current === this) reg.pushManager.current = null;
      return true;
    },
    toJSON() {
      return { endpoint, keys: { p256dh: "p", auth: "a" } };
    },
  });
  reg.makeSub = makeSub;
  reg.pushManager = {
    current: sub ? makeSub(sub.endpoint, sub.key) : null,
    async getSubscription() {
      return this.current;
    },
    async subscribe(opts) {
      assert.equal(opts.userVisibleOnly, true);
      if (failSubscribe) throw new Error("NotAllowedError");
      reg.subscribed++;
      this.current = makeSub(`https://web.push.apple.com/sub${reg.subscribed}`, opts.applicationServerKey);
      return this.current;
    },
  };
  return reg;
}

function fakePcs(...vapids) {
  return vapids.map((vapid, i) => ({ key: `smu:pc${i}`, app: "smu", pc: `pc${i}`, url: `https://pc${i}.tail1.ts.net`,
    vapid, pushEndpoint: "" }));
}

function recorder({ failFor = [] } = {}) {
  const calls = [];
  const setMe = async (pc, body) => {
    calls.push([pc.key, body.push ? body.push.endpoint : null]);
    if (failFor.includes(pc.key)) throw Object.assign(new Error("offline"), { kind: "offline" });
    return { ok: true };
  };
  return { calls, setMe };
}

const apply = (pcs, patches) => pcs.map((p) => {
  const hit = patches.find(([k]) => k === p.key);
  return hit ? { ...p, ...hit[1] } : p;
});

test("support: iPhone and iPad Safari tabs must install first; old iOS and push-less browsers are told so", () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
  const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";
  assert.equal(push.support({ ua: iphone, standalone: false, hasPush: false }), "install");
  assert.equal(push.support({ ua: iphone, standalone: false, hasPush: true }), "install");
  assert.equal(push.support({ ua: ipad, touchPoints: 5, standalone: false, hasPush: true }), "install");
  assert.equal(push.support({ ua: iphone, standalone: true, hasPush: true }), "ok");
  assert.equal(push.support({ ua: iphone, standalone: true, hasPush: false }), "old");
  assert.equal(push.support({ ua: ipad, touchPoints: 0, hasPush: true }), "ok"); // a real Mac
  assert.equal(push.support({ ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/130", hasPush: true }), "ok");
  assert.equal(push.support({ ua: "Mozilla/5.0 (Windows NT 10.0)", hasPush: false }), "none");
});

test("the alert key is the one most PCs share; ties go to the PC paired first; the rest are named", () => {
  assert.equal(push.alertKey(fakePcs(KEY_B, KEY_A, KEY_A)), KEY_A);
  assert.equal(push.alertKey(fakePcs(KEY_B, KEY_A)), KEY_B);
  assert.equal(push.alertKey(fakePcs("", "")), "");
  assert.deepEqual(push.otherKeyPcs(fakePcs(KEY_B, KEY_A, KEY_A)).map((p) => p.key), ["smu:pc0"]);
  assert.ok(push.keysEqual(KEY_A, Buffer.from(KEY_A, "base64url")));
  assert.ok(!push.keysEqual(KEY_A, KEY_B));
  assert.ok(!push.keysEqual(KEY_A, ""));
});

test("asking: only when not asked before, promise or old callback style, never throws", async () => {
  let asked = 0;
  const N = { permission: "default", requestPermission: () => (asked++, Promise.resolve("granted")) };
  assert.equal(await push.askPermission(N), "granted");
  assert.equal(asked, 1);
  assert.equal(await push.askPermission({ permission: "granted", requestPermission: () => assert.fail("asked") }), "granted");
  assert.equal(await push.askPermission({ permission: "denied", requestPermission: () => assert.fail("asked") }), "denied");
  const old = { permission: "default", requestPermission: (cb) => setTimeout(() => cb("granted"), 1) };
  assert.equal(await push.askPermission(old), "granted");
  assert.equal(await push.askPermission({ permission: "default", requestPermission: () => { throw new Error("x"); } }), "default");
  assert.equal(await push.askPermission(undefined), "denied");
});

test("first time: subscribes with the shared key and gives every PC with that key the subscription", async () => {
  const reg = fakeReg();
  const pcs = fakePcs(KEY_A, KEY_A, KEY_B);
  const { calls, setMe } = recorder();
  const r = await push.keepAlertsOn({ permission: "granted", reg, pcs, setMe });
  assert.equal(reg.subscribed, 1);
  assert.ok(push.keysEqual(reg.pushManager.current.options.applicationServerKey, KEY_A));
  assert.deepEqual(calls.sort(), [["smu:pc0", "https://web.push.apple.com/sub1"], ["smu:pc1", "https://web.push.apple.com/sub1"]]);
  assert.equal(r.error, "");
  assert.equal(r.sub.endpoint, "https://web.push.apple.com/sub1");
  const after = apply(pcs, r.patches);
  assert.deepEqual(after.map((p) => p.pushEndpoint), ["https://web.push.apple.com/sub1", "https://web.push.apple.com/sub1", ""]);

  // Every later open: nothing changed, so nothing is sent and nothing re-subscribes.
  const again = recorder();
  const r2 = await push.keepAlertsOn({ permission: "granted", reg, pcs: after, setMe: again.setMe });
  assert.equal(reg.subscribed, 1);
  assert.deepEqual(again.calls, []);
  assert.deepEqual(r2.patches, []);
});

test("a newly paired PC gets the subscription the others already have, without a new one", async () => {
  const reg = fakeReg({ sub: { endpoint: "https://web.push.apple.com/old", key: Buffer.from(KEY_A, "base64url") } });
  const pcs = fakePcs(KEY_A, KEY_A).map((p, i) => (i === 0 ? { ...p, pushEndpoint: "https://web.push.apple.com/old" } : p));
  const { calls, setMe } = recorder();
  await push.keepAlertsOn({ permission: "granted", reg, pcs, setMe });
  assert.equal(reg.subscribed, 0);
  assert.deepEqual(calls, [["smu:pc1", "https://web.push.apple.com/old"]]);
});

test("the subscription went missing or moved: re-subscribes silently and updates every PC", async () => {
  const pcs = fakePcs(KEY_A, KEY_A).map((p) => ({ ...p, pushEndpoint: "https://web.push.apple.com/gone" }));
  const reg = fakeReg(); // the browser lost it
  const { calls, setMe } = recorder();
  const r = await push.keepAlertsOn({ permission: "granted", reg, pcs, setMe });
  assert.equal(reg.subscribed, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([, e]) => e === "https://web.push.apple.com/sub1"));

  // The browser moved it to a new endpoint by itself (same key): every PC hears about the new one.
  const moved = fakeReg({ sub: { endpoint: "https://web.push.apple.com/moved", key: Buffer.from(KEY_A, "base64url") } });
  const rec = recorder();
  await push.keepAlertsOn({ permission: "granted", reg: moved, pcs: apply(pcs, r.patches), setMe: rec.setMe });
  assert.equal(moved.subscribed, 0);
  assert.deepEqual(rec.calls.map(([, e]) => e), ["https://web.push.apple.com/moved", "https://web.push.apple.com/moved"]);
});

test("a subscription made with another key is dropped and made again with the shared one", async () => {
  const reg = fakeReg({ sub: { endpoint: "https://web.push.apple.com/b", key: Buffer.from(KEY_B, "base64url") } });
  const { calls, setMe } = recorder();
  await push.keepAlertsOn({ permission: "granted", reg, pcs: fakePcs(KEY_A), setMe });
  assert.equal(reg.unsubscribed, 1);
  assert.equal(reg.subscribed, 1);
  assert.deepEqual(calls, [["smu:pc0", "https://web.push.apple.com/sub1"]]);
});

test("a browser that doesn't say a subscription's key keeps it (no churn on every open)", async () => {
  const reg = fakeReg({ sub: { endpoint: "https://web.push.apple.com/k" } }); // options.applicationServerKey null
  const { setMe } = recorder();
  await push.keepAlertsOn({ permission: "granted", reg, pcs: fakePcs(KEY_A), setMe });
  assert.equal(reg.subscribed, 0);
  assert.equal(reg.unsubscribed, 0);
});

test("a PC that doesn't answer is tried again next time; the others are done", async () => {
  const reg = fakeReg();
  const pcs = fakePcs(KEY_A, KEY_A);
  const first = recorder({ failFor: ["smu:pc1"] });
  const r = await push.keepAlertsOn({ permission: "granted", reg, pcs, setMe: first.setMe });
  assert.deepEqual(r.failed, [["smu:pc1", "offline"]]);
  assert.deepEqual(r.patches.map(([k]) => k), ["smu:pc0"]);
  const second = recorder();
  await push.keepAlertsOn({ permission: "granted", reg, pcs: apply(pcs, r.patches), setMe: second.setMe });
  assert.deepEqual(second.calls, [["smu:pc1", "https://web.push.apple.com/sub1"]]);
});

test("a PC with another key that had the subscription is told to stop", async () => {
  const reg = fakeReg({ sub: { endpoint: "https://web.push.apple.com/a", key: Buffer.from(KEY_A, "base64url") } });
  const pcs = fakePcs(KEY_A, KEY_A, KEY_B).map((p) => ({ ...p, pushEndpoint: "https://web.push.apple.com/a" }));
  const { calls, setMe } = recorder();
  const r = await push.keepAlertsOn({ permission: "granted", reg, pcs, setMe });
  assert.deepEqual(calls, [["smu:pc2", null]]);
  assert.deepEqual(r.patches, [["smu:pc2", { pushEndpoint: "" }]]);
});

test("blocked: PCs that had it are told to stop, nothing subscribes; not asked yet: nothing at all", async () => {
  const reg = fakeReg();
  const pcs = fakePcs(KEY_A, KEY_A).map((p, i) => ({ ...p, pushEndpoint: i ? "" : "https://web.push.apple.com/x" }));
  const blocked = recorder();
  const r = await push.keepAlertsOn({ permission: "denied", reg, pcs, setMe: blocked.setMe });
  assert.deepEqual(blocked.calls, [["smu:pc0", null]]);
  assert.deepEqual(r.patches, [["smu:pc0", { pushEndpoint: "" }]]);
  assert.equal(reg.subscribed, 0);
  const notYet = recorder();
  await push.keepAlertsOn({ permission: "default", reg, pcs, setMe: notYet.setMe });
  assert.deepEqual(notYet.calls, []);
  assert.equal(reg.subscribed, 0);
});

test("subscribe refused: says so, tells no PC; no worker or no key: does nothing", async () => {
  const { calls, setMe } = recorder();
  const r = await push.keepAlertsOn({ permission: "granted", reg: fakeReg({ failSubscribe: true }), pcs: fakePcs(KEY_A), setMe });
  assert.equal(r.error, "subscribe");
  assert.deepEqual(calls, []);
  assert.equal((await push.keepAlertsOn({ permission: "granted", reg: null, pcs: fakePcs(KEY_A), setMe })).sub, null);
  assert.equal((await push.keepAlertsOn({ permission: "granted", reg: fakeReg(), pcs: fakePcs(""), setMe })).sub, null);
});

test("the pair tap: permission asked in the tap, then the new PC gets the subscription", async () => {
  // As app.js does it: ask first (inside the tap), pair over the network, then keep alerts on.
  let asked = 0;
  const N = { permission: "default", requestPermission() {
    asked++;
    this.permission = "granted";
    return Promise.resolve("granted");
  } };
  const permission = push.askPermission(N); // synchronously, before any await
  assert.equal(asked, 1);
  const paired = await Promise.resolve(fakePcs(KEY_A)); // the pairing answer
  const reg = fakeReg();
  const { calls, setMe } = recorder();
  await push.keepAlertsOn({ permission: await permission, reg, pcs: paired, setMe });
  assert.deepEqual(calls, [["smu:pc0", "https://web.push.apple.com/sub1"]]);
});

test("the alerts card's state", () => {
  const pcs = fakePcs(KEY_A);
  const sub = { endpoint: "e" };
  assert.equal(push.alertsState({ supported: "install", permission: "default", sub: null, pcs }), "install");
  assert.equal(push.alertsState({ supported: "old", permission: "default", sub: null, pcs }), "old");
  assert.equal(push.alertsState({ supported: "ok", permission: "default", sub: null, pcs: [] }), "nopc");
  assert.equal(push.alertsState({ supported: "ok", permission: "granted", sub, pcs: fakePcs("") }), "nokey");
  assert.equal(push.alertsState({ supported: "ok", permission: "denied", sub: null, pcs }), "blocked");
  assert.equal(push.alertsState({ supported: "ok", permission: "granted", sub, pcs }), "on");
  assert.equal(push.alertsState({ supported: "ok", permission: "granted", sub: null, pcs }), "off");
  assert.equal(push.alertsState({ supported: "ok", permission: "default", sub: null, pcs }), "off");
});

// ---------- The service worker's alerts ----------

function loadWorker({ windows = [] } = {}) {
  const handlers = {};
  const shown = [];
  const opened = [];
  const self = {
    location: new URL("https://dmftrading.co.uk/letmeknow/sw.js"),
    addEventListener: (type, fn) => {
      handlers[type] = fn;
    },
    registration: { showNotification: async (title, options) => shown.push({ title, options }) },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url) => opened.push(url),
      claim: async () => {},
    },
    skipWaiting: () => {},
  };
  const code = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  vm.runInNewContext(code, { self, URL, console, Date, Number });
  const fire = async (type, event) => {
    const waits = [];
    handlers[type]({ ...event, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  return { shown, opened, fire };
}

const pushEvent = (payload) => ({ data: { json: () => (typeof payload === "string" ? JSON.parse(payload) : payload) } });
const base = { v: 1, app: "smu", pc: "a1b2c3d4e5f60718", pc_name: "ZBook", task: "t1", task_name: "Gym list",
  at: "2026-11-01T00:12:31+00:00" };

test("worker: the PC's own title and body are shown, tagged per PC and task, with where a tap goes", async () => {
  const w = loadWorker();
  await w.fire("push", pushEvent({ ...base, kind: "needs_you", title: "ZBook needs you", body: "Gym list: A question" }));
  const [n] = w.shown;
  assert.equal(n.title, "ZBook needs you");
  assert.equal(n.options.body, "Gym list: A question");
  assert.equal(n.options.tag, "smu-a1b2c3d4e5f60718-t1");
  assert.equal(n.options.renotify, true);
  assert.equal(n.options.timestamp, Date.parse(base.at));
  assert.deepEqual({ ...n.options.data }, { app: "smu", pc: "a1b2c3d4e5f60718", task: "t1", kind: "needs_you" });
});

test("worker: its own words for every kind when title and body are missing, including went quiet", async () => {
  const w = loadWorker();
  for (const kind of ["needs_you", "finished", "failed", "stopped", "test"]) await w.fire("push", pushEvent({ ...base, kind }));
  await w.fire("push", pushEvent({ ...base, kind: "stopped", reason: "quiet" }));
  await w.fire("push", pushEvent({ v: 1, kind: "stopped", reason: "quiet", pc_name: "ZBook" }));
  assert.deepEqual(w.shown.map((n) => [n.title, n.options.body]), [
    ["ZBook needs you", "Gym list: open Let Me Know to see why"],
    ["ZBook finished", "Gym list: done"],
    ["ZBook: a run stopped", "Gym list: stopped on an error"],
    ["ZBook: a run stopped", "Gym list: stopped"],
    ["Test alert from ZBook", "Alerts work on this device."],
    ["ZBook went quiet", "Gym list: no word from ZBook (it may be off or crashed)"],
    ["ZBook went quiet", "No word from ZBook (it may be off or crashed)"],
  ]);
});

test("worker: the went-quiet push as the PCs send it shows as sent", async () => {
  const w = loadWorker();
  await w.fire("push", pushEvent({ ...base, kind: "stopped", reason: "quiet", title: "ZBook went quiet",
    body: "Gym list: no word from ZBook since 01:52 (it may be off or crashed)" }));
  assert.equal(w.shown[0].title, "ZBook went quiet");
  assert.equal(w.shown[0].options.body, "Gym list: no word from ZBook since 01:52 (it may be off or crashed)");
});

test("worker: an unreadable push, or a kind it doesn't know, still shows something but never says needs you", async () => {
  const w = loadWorker();
  await w.fire("push", { data: { json: () => { throw new Error("bad"); } } });
  await w.fire("push", { data: null });
  await w.fire("push", pushEvent({ ...base, kind: "paused" }));
  assert.deepEqual(w.shown.map((n) => [n.title, n.options.body]), [
    ["Let Me Know", "Open Let Me Know to see what's new"],
    ["Let Me Know", "Open Let Me Know to see what's new"],
    ["News from ZBook", "Gym list: open Let Me Know to see what's new"],
  ]);
  assert.ok(w.shown.every((n) => !/needs you/i.test(n.title + n.options.body)));
});

test("worker: email and IP addresses are masked in what an alert shows, as in the app", async () => {
  const w = loadWorker();
  await w.fire("push", pushEvent({ ...base, kind: "needs_you", title: "ZBook needs you (jo.bloggs@example.com)",
    body: "Gym list: the form said ann.lee@mail.co.uk is in use, from 192.168.1.20 and fe80:0:0:0:1:2:3:4",
    task_name: "x@y.com list" }));
  await w.fire("push", pushEvent({ ...base, kind: "finished", task_name: "Mail sam@ex.org" }));
  const [a, b] = w.shown;
  assert.equal(a.title, "ZBook needs you ([email])");
  assert.equal(a.options.body, "Gym list: the form said [email] is in use, from [address] and [address]");
  assert.equal(b.options.body, "Mail [email]: done");
});

test("worker: a tap opens the app on that PC and task, or tells the open window", async () => {
  const closed = [];
  const data = { app: "smu", pc: "a1b2c3d4e5f60718", task: "t1", kind: "needs_you" };
  const note = { close: () => closed.push(1), data };
  const none = loadWorker();
  await none.fire("notificationclick", { notification: note });
  assert.deepEqual(none.opened, ["https://dmftrading.co.uk/letmeknow/?pc=a1b2c3d4e5f60718&app=smu&task=t1"]);
  assert.equal(closed.length, 1);

  const posted = [];
  const win = { focus: async () => {}, postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) };
  const open = loadWorker({ windows: [win] });
  await open.fire("notificationclick", { notification: note });
  assert.deepEqual(open.opened, []);
  assert.deepEqual(posted, [{ type: "open", pc: "a1b2c3d4e5f60718", app: "smu", task: "t1" }]);
});

test("worker: an alert arriving tells an open app to refresh", async () => {
  const posted = [];
  const w = loadWorker({ windows: [{ postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) }] });
  await w.fire("push", pushEvent({ ...base, kind: "finished" }));
  assert.deepEqual(posted, [{ type: "refresh" }]);
});

test("worker: its mask is the app's own, character for character", () => {
  const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  const st = readFileSync(new URL("../lib/status.mjs", import.meta.url), "utf8");
  const body = (s) => /function scrub\(s\) \{([\s\S]*?)\n\}/.exec(s)[1].trim();
  assert.equal(body(sw), body(st));
  assert.equal(scrub("a@b.co 10.0.0.1"), "[email] [address]");
});

// ---------- Inside the tap, and PCs that dropped the subscription ----------

test("the tap asks for permission and subscribes before any await when the key is known", () => {
  let asked = 0;
  const N = { permission: "default", requestPermission: () => (asked++, Promise.resolve("granted")) };
  const reg = fakeReg();
  const t = push.startInTap({ N, reg, key: KEY_A });
  assert.equal(asked, 1); // both started synchronously, inside the tap
  assert.equal(reg.subscribed, 1);
  assert.ok(t.asked instanceof Promise && t.subscribed instanceof Promise);
});

test("the very first PC's tap only asks (its key comes with the pairing); blocked or refused never throws", async () => {
  let asked = 0;
  const N = { permission: "default", requestPermission: () => (asked++, Promise.resolve("granted")) };
  const reg = fakeReg();
  const t = push.startInTap({ N, reg, key: "" });
  assert.equal(asked, 1);
  assert.equal(reg.subscribed, 0);
  assert.equal(await t.subscribed, null);
  const blocked = push.startInTap({ N: { permission: "denied" }, reg, key: KEY_A });
  assert.equal(reg.subscribed, 0);
  assert.equal(await blocked.asked, "denied");
  const refused = push.startInTap({ N: { permission: "granted" }, reg: fakeReg({ failSubscribe: true }), key: KEY_A });
  assert.equal(await refused.subscribed, null);
  const throws = { pushManager: { subscribe() { throw new Error("sync"); } } };
  assert.equal(await push.startInTap({ N: { permission: "granted" }, reg: throws, key: KEY_A }).subscribed, null);
});

test("after a tap-time subscribe, pairing sends that same subscription without making another", async () => {
  const reg = fakeReg();
  const t = push.startInTap({ N: { permission: "granted" }, reg, key: KEY_A });
  await t.subscribed;
  const { calls, setMe } = recorder();
  await push.keepAlertsOn({ permission: "granted", reg, pcs: fakePcs(KEY_A, KEY_A), setMe });
  assert.equal(reg.subscribed, 1);
  assert.deepEqual(calls.map(([, e]) => e), ["https://web.push.apple.com/sub1", "https://web.push.apple.com/sub1"]);
});

test("on open, a PC whose device list shows push:false for this phone is sent the subscription again", async () => {
  const sub = { endpoint: "https://web.push.apple.com/s", key: Buffer.from(KEY_A, "base64url") };
  const reg = fakeReg({ sub });
  const pcs = fakePcs(KEY_A, KEY_A, KEY_A).map((p) => ({ ...p, pushEndpoint: sub.endpoint }));
  const lists = {
    "smu:pc0": { devices: [{ id: "d1", me: true, push: false }, { id: "d2", me: false, push: true }] }, // dropped
    "smu:pc1": { devices: [{ id: "d3", me: true, push: true }] }, // still has it
  };
  const devices = async (pc) => {
    if (!lists[pc.key]) throw Object.assign(new Error("offline"), { kind: "offline" }); // pc2 doesn't answer
    return lists[pc.key];
  };
  const { calls, setMe } = recorder();
  const r = await push.keepAlertsOn({ permission: "granted", reg, pcs, setMe, devices });
  assert.deepEqual(calls, [["smu:pc0", sub.endpoint]]);
  assert.deepEqual(r.patches, [["smu:pc0", { pushEndpoint: sub.endpoint }]]);
  assert.equal(reg.subscribed, 0);
  // Without the check (the once-a-minute resync passes no `devices`), no PC is asked and nothing is sent.
  const quiet = recorder();
  await push.keepAlertsOn({ permission: "granted", reg, pcs, setMe: quiet.setMe });
  assert.deepEqual(quiet.calls, []);
  assert.deepEqual(await push.forgotten(pcs, "", devices), []);
  assert.deepEqual(await push.forgotten(pcs, sub.endpoint, null), []);
});

test("not granted: the open-time check doesn't subscribe or ask the PCs", async () => {
  const reg = fakeReg();
  let asked = 0;
  const devices = async () => (asked++, { devices: [] });
  const { calls, setMe } = recorder();
  await push.keepAlertsOn({ permission: "default", reg, pcs: fakePcs(KEY_A), setMe, devices });
  assert.equal(reg.subscribed, 0);
  assert.equal(asked, 0);
  assert.deepEqual(calls, []);
});

test("worker: a QueFix alert shows as sent and its tap opens the QueFix list on that PC", async () => {
  const w = loadWorker();
  const qf = { v: 1, app: "tabgod", kind: "needs_you", pc: "a1b2c3d4e5f60718", pc_name: "ZBook", task: "quefix",
    task_name: "QueFix", title: "ZBook needs you", body: "QueFix: 7 should be before 3", at: base.at };
  await w.fire("push", pushEvent(qf));
  const [n] = w.shown;
  assert.equal(n.options.body, "QueFix: 7 should be before 3");
  assert.equal(n.options.tag, "tabgod-a1b2c3d4e5f60718-quefix");
  await w.fire("notificationclick", { notification: { close() {}, data: n.options.data } });
  assert.deepEqual(w.opened, ["https://dmftrading.co.uk/letmeknow/?pc=a1b2c3d4e5f60718&app=tabgod&task=quefix"]);
});

test("worker: a queue alert reads cleanly on the lock screen, keeps its own place and opens the QueFix list", async () => {
  const w = loadWorker();
  const one = { v: 1, app: "tabgod", kind: "queue", pc: "a1b2c3d4e5f60718", pc_name: "Mini 1",
    title: "Profile 10 is near the front", body: "Queue 842 · QueFix on Mini 1", at: base.at };
  await w.fire("push", pushEvent(one));
  await w.fire("push", pushEvent({ ...one, title: "3 profiles near the front", body: "10: 842 · 7: 93% · 3: 990" }));
  await w.fire("push", pushEvent({ v: 1, kind: "queue", pc: "a1b2c3d4e5f60718", pc_name: "Mini 1" }));
  const [a, b, c] = w.shown;
  assert.deepEqual([a.title, a.options.body], ["Profile 10 is near the front", "Queue 842 · QueFix on Mini 1"]);
  assert.deepEqual([b.title, b.options.body], ["3 profiles near the front", "10: 842 · 7: 93% · 3: 990"]);
  assert.deepEqual([c.title, c.options.body], ["A profile is near the front", "QueFix on Mini 1"]);
  for (const n of [a, b, c]) {
    assert.equal(n.options.tag, "tabgod-a1b2c3d4e5f60718-qf-near"); // apart from a QueFix needs-you alert
    assert.equal(n.options.icon, "icons/icon-192.png");
    assert.equal(n.options.badge, "icons/badge-96.png");
    assert.equal(n.options.renotify, true);
    assert.ok(!/needs you/i.test(n.title));
  }
  await w.fire("notificationclick", { notification: { close() {}, data: c.options.data } });
  assert.deepEqual(w.opened, ["https://dmftrading.co.uk/letmeknow/?pc=a1b2c3d4e5f60718&app=tabgod&task=quefix"]);
});
