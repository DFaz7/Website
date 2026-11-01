// node --test letmeknow/tests
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as store from "../lib/store.mjs";
import {
  STATE_LABELS, agoText, b64urlToBytes, buildBoard, clockText, guessDeviceName, leftText, needsYouCount,
  normalizeAddress, normalizeCode, normalizeStatus, notRunningTitle, parsePairing, rowTime, secondsLeft, sortTasks,
  stateNote, tailnetSuffix, timeLine,
} from "../lib/status.mjs";

const SMU = {
  device: { name: "ZBook", id: "a1b2c3d4e5f60718", active: true },
  tasks: [
    { id: "t1", name: "Gym list", done: 12, failed: 1, left: 30, running: true, needs_you: false,
      needs_you_reason: null, learned: true, per_person_seconds: 95, gap_seconds: 20, eta_seconds: 2830,
      eta_at: "2026-11-01T00:58:10+00:00" },
    { id: "t2", name: "Newsletter", done: 0, failed: 0, left: 18, running: false, needs_you: true,
      needs_you_reason: "A question", learned: false, per_person_seconds: null, eta_seconds: null, eta_at: null },
  ],
};

test("SMU's status reads as it is built", () => {
  const s = normalizeStatus(SMU);
  assert.equal(s.device.name, "ZBook");
  assert.equal(s.device.active, true);
  assert.equal(s.tasks.length, 2);
  const [a, b] = s.tasks;
  assert.deepEqual([a.done, a.failed, a.left, a.running, a.learned, a.etaSeconds], [12, 1, 30, true, true, 2830]);
  assert.equal(a.etaAt, Date.parse("2026-11-01T00:58:10Z"));
  assert.equal(b.needsYou, true);
  assert.equal(b.reason, "A question");
  assert.equal(b.learned, false);
  assert.equal(b.etaAt, null);
});

test("missing and odd fields are unknown, not errors", () => {
  const s = normalizeStatus({ tasks: [{ name: 5, done: "7", left: -2, failed: "x", eta_at: "soon", extra: {} }, null, 3] });
  assert.equal(s.app, null);
  assert.deepEqual(s.device, { name: "", id: "", active: false });
  assert.equal(s.tasks.length, 1);
  const t = s.tasks[0];
  assert.deepEqual([t.name, t.done, t.left, t.failed, t.etaAt, t.learned, t.running], ["Task", 7, null, null, null, null, false]);
  assert.deepEqual(normalizeStatus(null).tasks, []);
  assert.deepEqual(normalizeStatus("nope").tasks, []);
  assert.equal(normalizeStatus({ app: "tabgod" }).app, "tabgod");
  assert.equal(normalizeStatus({ app: "<b>" }).app, null);
});

test("a reason without needs_you still counts; needs_you false wins", () => {
  const s = normalizeStatus({ tasks: [{ needs_you_reason: "Stuck" }, { needs_you: false, needs_you_reason: "old" }] });
  assert.equal(s.tasks[0].needsYou, true);
  assert.equal(s.tasks[1].needsYou, false);
});

test("long names are cut and whitespace folded", () => {
  const s = normalizeStatus({ tasks: [{ name: "a  b\n" + "x".repeat(200) }] });
  assert.equal(s.tasks[0].name.length, 80);
  assert.ok(s.tasks[0].name.startsWith("a b x"));
});

test("time left words match SMU's", () => {
  assert.equal(leftText(30), "under a minute");
  assert.equal(leftText(60), "1 min");
  assert.equal(leftText(52 * 60), "52 min");
  assert.equal(leftText(3600), "1 h");
  assert.equal(leftText(4800), "1 h 20 min");
  assert.equal(leftText(3599), "1 h");
});

test("countdown runs from eta_at while a task runs", () => {
  const t = normalizeStatus(SMU).tasks[0];
  const at = Date.parse("2026-11-01T00:58:10Z");
  assert.equal(secondsLeft(t, at - 600_000, 0), 600);
  assert.equal(secondsLeft(t, at + 5000, 0), 0);
  assert.equal(timeLine(t, at - 52 * 60_000, 0, "Europe/London"), "about 52 min left · done by 00:58");
});

test("without eta_at the countdown uses eta_seconds from fetch time", () => {
  const t = { ...normalizeStatus(SMU).tasks[0], etaAt: null };
  assert.equal(secondsLeft(t, 100_000, 40_000), 2770);
});

test("a task that isn't running shows its time left without a finish time", () => {
  const t = { ...normalizeStatus(SMU).tasks[0], running: false, etaSeconds: 4200 };
  assert.equal(timeLine(t, 0, 0, "UTC"), "about 1 h 10 min left");
});

test("learning the form, nobody left, nothing to go on", () => {
  const [, b] = normalizeStatus(SMU).tasks;
  assert.equal(timeLine(b, 0, 0), "learning the form");
  assert.equal(timeLine({ ...b, learned: true, left: 0 }, 0, 0), "");
  assert.equal(timeLine({ ...b, learned: null }, 0, 0), "");
});

test("finish clock in the given time zone", () => {
  assert.equal(clockText(Date.parse("2026-07-01T23:41:00Z"), "Europe/London"), "00:41");
  assert.equal(clockText(Date.parse("2026-12-01T23:41:00Z"), "Europe/London"), "23:41");
});

test("order: needs you, running, left, finished", () => {
  const ts = [{ id: "f", left: 0 }, { id: "l", left: 3 }, { id: "r", running: true, left: 2 }, { id: "n", needsYou: true }];
  assert.deepEqual(sortTasks(ts).map((t) => t.id), ["n", "r", "l", "f"]);
});

test("needs-you count over PCs, skipping unknown ones", () => {
  assert.equal(needsYouCount([normalizeStatus(SMU), undefined, normalizeStatus({})]), 1);
});

test("ago words", () => {
  assert.equal(agoText(2000), "just now");
  assert.equal(agoText(12_000), "12 s ago");
  assert.equal(agoText(3 * 60_000), "3 min ago");
  assert.equal(agoText(2 * 3600_000), "2 h ago");
});

test("typed codes are forgiving", () => {
  assert.equal(normalizeCode("k7q2 9xmp"), "K7Q2-9XMP");
  assert.equal(normalizeCode("K7Q2-9XMP"), "K7Q2-9XMP");
  assert.equal(normalizeCode("abcd-efgo"), "ABCD-EFG0");
  assert.equal(normalizeCode("il00-0000"), "1100-0000");
  assert.equal(normalizeCode("K7Q2-9XM"), "");
  assert.equal(normalizeCode("K7Q2-9XMU"), ""); // U is not in the alphabet
});

test("typed addresses become https base URLs", () => {
  assert.equal(normalizeAddress("zbook.tail1234.ts.net"), "https://zbook.tail1234.ts.net");
  assert.equal(normalizeAddress("https://ZBook.tail1234.ts.net/"), "https://zbook.tail1234.ts.net");
  assert.equal(normalizeAddress("zbook.tail1234.ts.net:8443"), "https://zbook.tail1234.ts.net:8443");
  assert.equal(normalizeAddress("zbook.tail1234.ts.net:443"), "https://zbook.tail1234.ts.net");
  assert.equal(normalizeAddress("mini1", "tail1234.ts.net"), "https://mini1.tail1234.ts.net");
  assert.equal(normalizeAddress("mini1"), "");
  assert.equal(normalizeAddress("http://localhost:8791"), "http://localhost:8791");
  assert.equal(normalizeAddress("http://zbook.tail1234.ts.net"), "https://zbook.tail1234.ts.net");
  assert.equal(normalizeAddress("bad host!"), "");
  assert.equal(tailnetSuffix("https://zbook.tail1234.ts.net:8443"), "tail1234.ts.net");
  assert.equal(tailnetSuffix("http://localhost:8791"), "");
});

test("QR text parses; anything else is refused", () => {
  const qr = '{"lmk":1,"app":"smu","url":"https://zbook.tail1234.ts.net","pc":"a1b2","name":"ZBook","code":"k7q2-9xmp"}';
  assert.deepEqual(parsePairing(qr), { app: "smu", url: "https://zbook.tail1234.ts.net", pc: "a1b2", name: "ZBook", code: "K7Q2-9XMP" });
  assert.equal(parsePairing("https://example.com"), null);
  assert.equal(parsePairing('{"lmk":2,"url":"a.b","code":"K7Q2-9XMP"}'), null);
  assert.equal(parsePairing('{"lmk":1,"url":"a.b","code":"short"}'), null);
  assert.equal(parsePairing('{"lmk":1,"app":"x","url":"a.b","code":"K7Q2-9XMP"}').app, null);
});

test("device name guess", () => {
  assert.equal(guessDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), "iPhone");
  assert.equal(guessDeviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5), "iPad");
  assert.equal(guessDeviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0), "This device");
});

test("VAPID key decoding", () => {
  const bytes = b64urlToBytes("BAEC_-8");
  assert.deepEqual([...bytes], [4, 1, 2, 255, 239]);
});

test("store: one entry per PC and app", () => {
  let s = { v: 1, deviceName: "iPhone", pcs: [] };
  s = store.upsertPc(s, { app: "smu", pc: "a1", url: "https://z", token: "1" });
  s = store.upsertPc(s, { app: "tabgod", pc: "a1", url: "https://z:8443", token: "2" });
  s = store.upsertPc(s, { app: "smu", pc: "a1", url: "https://z", token: "3" });
  assert.equal(s.pcs.length, 2);
  assert.equal(s.pcs.find((p) => p.app === "smu").token, "3");
  s = store.updatePc(s, "smu:a1", { token: "4" });
  assert.equal(s.pcs.find((p) => p.key === "smu:a1").token, "4");
  s = store.removePc(s, "smu:a1");
  assert.deepEqual(s.pcs.map((p) => p.key), ["tabgod:a1"]);
  assert.deepEqual(store.load(), { v: 1, deviceName: "", pcs: [] }); // no localStorage here: empty, no throw
});

test("app and service worker carry the same version, and the worker caches every lib file", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  const v = (s) => /VERSION = "([^"]+)"/.exec(s)[1];
  assert.equal(v(app), v(sw));
  for (const f of ["lib/api.mjs", "lib/scan.mjs", "lib/status.mjs", "lib/store.mjs", "app.js", "app.css", "index.html"]) {
    assert.ok(sw.includes(`"${f}"`), `${f} in the shell list`);
  }
});

// ---------- The one Active list ----------

const NOW = Date.parse("2026-11-01T03:00:00Z");
const task = (id, name, extra = {}) => ({ id, name, done: 1, failed: 0, left: 5, running: false, needs_you: false,
  needs_you_reason: null, learned: true, eta_seconds: null, eta_at: null, ...extra });
const running = (id, name, mins, extra = {}) => task(id, name, { running: true, eta_seconds: mins * 60,
  eta_at: new Date(NOW + mins * 60_000).toISOString(), ...extra });
const entry = (key, app, device, tasks, extra = {}) => ({ key, app, device, fetchedAt: NOW, error: "",
  status: normalizeStatus({ app, device: { name: device, active: tasks.some((t) => t.running) }, tasks }), ...extra });

function board() {
  return buildBoard([
    entry("smu:zb", "smu", "ZBook", [running("t1", "Gym list", 55, { needs_you: true, needs_you_reason: "A question" }),
      task("t3", "Spring offers", { left: 0 })]),
    entry("tabgod:zb", "tabgod", "ZBook", [running("g1", "Profiles A", 4)]),
    entry("smu:m1", "smu", "Mini 1", [running("m1", "Club members", 140)]),
    entry("tabgod:m1", "tabgod", "Mini 1", [task("g2", "Profiles B", { left: 12 })]),
    entry("smu:m2", "smu", "Mini 2", [running("n1", "Book club", 0, { learned: false, eta_seconds: null, eta_at: null })]),
    entry("tabgod:m2", "tabgod", "Mini 2", [running("g3", "Profiles C", 30, { needs_you: true, needs_you_reason: "Both AIs couldn't do a step" })]),
    entry("smu:m10", "smu", "Mini 10", [running("x1", "Address book", 0, { learned: false, eta_seconds: null, eta_at: null })]),
    entry("smu:a2", "smu", "Alpha", [running("a1", "Club members", 140)]),
    entry("smu:dt", "smu", "Desktop", [], { status: null, error: "offline" }),
    entry("tabgod:l2", "tabgod", "Laptop 2", [], { status: null, error: "token" }),
    entry("smu:new", "smu", "Mini 3", [], { status: null }),
    entry("smu:stale", "smu", "Old PC", [running("s1", "Stale run", 5)], { error: "offline" }),
  ], NOW);
}

test("active order: needs you, then least time left, then learning by task name; ties by device", () => {
  const rows = board().active.map((r) => `${r.app} ${r.device} ${r.task.name}`);
  assert.deepEqual(rows, [
    "tabgod Mini 2 Profiles C", // needs you, by device name ("Mini 2" before "ZBook")
    "smu ZBook Gym list",
    "tabgod ZBook Profiles A", // 4 min
    "smu Alpha Club members", // 140 min, tie: by device name
    "smu Mini 1 Club members",
    "smu Mini 10 Address book", // learning the form: by task name ("Address book" before "Book club")
    "smu Mini 2 Book club",
  ]);
});

test("each active row carries its app, device and task, and a needs-you row keeps its reason", () => {
  const r = board().active[0];
  assert.equal(r.app, "tabgod");
  assert.equal(r.device, "Mini 2");
  assert.equal(r.task.name, "Profiles C");
  assert.equal(r.task.reason, "Both AIs couldn't do a step");
  assert.equal(r.group, 0);
});

test("a needs-you task that isn't running is still in the list", () => {
  const b = buildBoard([entry("smu:a", "smu", "ZBook", [task("t", "Gym", { needs_you: true, needs_you_reason: "IWM needs you" })])], NOW);
  assert.equal(b.active.length, 1);
  assert.equal(b.notRunning.length, 0);
});

test("not running: problems first, then connecting, then idle; nothing silently disappears", () => {
  const b = board();
  assert.deepEqual(b.notRunning.map((r) => `${r.state} ${r.app} ${r.device}`), [
    "token tabgod Laptop 2",
    "offline smu Desktop",
    "offline smu Old PC", // its last known run is not shown as running: the PC can't be reached
    "connecting smu Mini 3",
    "idle tabgod Mini 1",
  ]);
  const all = new Set([...b.active.map((r) => r.pcKey), ...b.notRunning.map((r) => r.key)]);
  assert.equal(all.size, 12);
});

test("a PC/app with only finished tasks is idle, with the people left counted", () => {
  const b = buildBoard([entry("x", "smu", "ZBook", [task("a", "A", { left: 0 }), task("b", "B", { left: 7 })])], NOW);
  assert.deepEqual(b.notRunning, [{ key: "x", app: "smu", device: "ZBook", state: "idle", left: 7 }]);
  assert.equal(stateNote(b.notRunning[0]), "Nothing running · 7 left");
  assert.equal(stateNote({ state: "idle", left: 0 }), "Nothing running");
});

test("labels and notes for every state", () => {
  assert.deepEqual(STATE_LABELS, { idle: "Idle", offline: "Can't reach", token: "Not paired", error: "Error", connecting: "Connecting" });
  for (const s of Object.keys(STATE_LABELS)) assert.ok(stateNote({ state: s, left: 0 }).length > 5, s);
  assert.match(stateNote({ state: "offline" }), /Tailscale/);
  assert.match(stateNote({ state: "token" }), /^Not paired: pair it again/);
});

test("the collapsed section's title counts pairs and flags the ones to look at", () => {
  assert.deepEqual(notRunningTitle(board().notRunning), { title: "Not running · 5", note: "3 need a look" });
  assert.deepEqual(notRunningTitle([{ state: "offline" }]), { title: "Not running · 1", note: "1 needs a look" });
  assert.deepEqual(notRunningTitle([{ state: "idle" }, { state: "connecting" }]), { title: "Not running · 2", note: "" });
});

test("row time: short time left and finish, learning, nothing", () => {
  const t = normalizeStatus({ tasks: [running("a", "A", 43)] }).tasks[0];
  assert.deepEqual(rowTime(t, NOW, NOW, "UTC"), { left: "43 min", by: "done by 03:43" });
  assert.deepEqual(rowTime(t, NOW + 60_000, NOW, "UTC"), { left: "42 min", by: "done by 03:43" });
  const l = normalizeStatus({ tasks: [{ running: true, learned: false, left: 5 }] }).tasks[0];
  assert.deepEqual(rowTime(l, NOW, NOW), { left: "learning the form", by: "" });
  const n = normalizeStatus({ tasks: [{ running: true, left: 5 }] }).tasks[0];
  assert.deepEqual(rowTime(n, NOW, NOW), { left: "", by: "" });
});

test("ordering by time left follows the countdown, not the PC's old figure", () => {
  const b = buildBoard([
    entry("a", "smu", "A", [running("1", "One", 10)]),
    entry("b", "smu", "B", [running("2", "Two", 9, { eta_at: new Date(NOW + 20 * 60_000).toISOString() })]),
  ], NOW);
  assert.deepEqual(b.active.map((r) => r.device), ["A", "B"]);
});

test("the main screen has no app tabs any more", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(!html.includes('role="tablist"'));
  assert.ok(html.includes('id="list"'));
});
