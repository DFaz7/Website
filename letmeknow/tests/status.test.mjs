// node --test letmeknow/tests
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as S from "../lib/status.mjs";
import * as store from "../lib/store.mjs";
import {
  GROUP_LABELS, agoText, appNote, b64urlToBytes, buildGroups, clockText, guessDeviceName, leftText, needsYouCount,
  normalizeAddress, normalizeCode, normalizeStatus, parsePairing, reachText, rowTime, secondsLeft, sortTasks,
  tailnetSuffix, timeLine,
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
  assert.deepEqual(store.load(), { v: 1, deviceName: "", theme: "dark", pcs: [] }); // no localStorage here: empty, no throw
});

test("app and service worker carry the same version, and the worker caches every lib file", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  const v = (s) => /VERSION = "([^"]+)"/.exec(s)[1];
  assert.equal(v(app), v(sw));
  for (const f of ["lib/api.mjs", "lib/nav.mjs", "lib/patch.mjs", "lib/push.mjs", "lib/scan.mjs", "lib/status.mjs", "lib/store.mjs",
    "lib/tokens.mjs", "app.js", "app.css", "theme.js", "index.html"]) {
    assert.ok(sw.includes(`"${f}"`), `${f} in the shell list`);
  }
});

// ---------- The home screen: one card per PC ----------

const NOW = Date.parse("2026-11-01T03:00:00Z");
const task = (id, name, extra = {}) => ({ id, name, done: 1, failed: 0, left: 5, running: false, needs_you: false,
  needs_you_reason: null, learned: true, eta_seconds: null, eta_at: null, ...extra });
const running = (id, name, mins, extra = {}) => task(id, name, { running: true, eta_seconds: mins * 60,
  eta_at: new Date(NOW + mins * 60_000).toISOString(), ...extra });
const entry = (key, app, device, tasks, extra = {}) => ({ key, app, device, pcId: key.split(":")[1], fetchedAt: NOW,
  okAt: 0, error: "", status: normalizeStatus({ app, device: { name: device, active: tasks.some((t) => t.running) }, tasks }), ...extra });

function board() {
  return buildGroups([
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
    entry("smu:stale", "smu", "Old PC", [running("s1", "Stale run", 5)], { error: "offline", okAt: NOW - 3 * 60_000 }),
  ], NOW);
}

test("one card per PC: SMU and TabGod on one PC share it, SMU first", () => {
  const zb = board().find((g) => g.name === "ZBook");
  assert.deepEqual(zb.apps.map((a) => a.key), ["smu:zb", "tabgod:zb"]);
  assert.deepEqual(zb.apps.map((a) => a.rows.map((r) => r.task.name)), [["Gym list"], ["Profiles A"]]);
  assert.equal(zb.needs, 1);
  assert.equal(zb.running, 2);
  assert.equal(zb.state, "needs");
});

test("card order: needs you, then running by least time left, then problems, checking, idle; ties by name", () => {
  assert.deepEqual(board().map((g) => `${g.state} ${g.name}`), [
    "needs Mini 2", // needs you, by name ("Mini 2" before "ZBook")
    "needs ZBook",
    "running Alpha", // 140 min, tie: by name
    "running Mini 1",
    "running Mini 10", // only learning the form: no time yet
    "token Laptop 2",
    "offline Desktop",
    "offline Old PC",
    "connecting Mini 3",
  ]);
});

test("rows in a PC: needs you first, then least time left, then learning by name", () => {
  const g = buildGroups([
    entry("smu:x", "smu", "X", [running("a", "Slow", 90), running("b", "Fast", 5),
      running("c", "Zed", 0, { learned: false, eta_seconds: null, eta_at: null }),
      running("d", "Asks", 50, { needs_you: true, needs_you_reason: "A question" }),
      task("e", "Waits", { needs_you: true, needs_you_reason: "IWM needs you" })]),
  ], NOW)[0];
  assert.deepEqual(g.apps[0].rows.map((r) => r.task.name), ["Asks", "Waits", "Fast", "Slow", "Zed"]);
  assert.equal(g.minSecs, 5 * 60);
});

test("nothing silently disappears: every PC/app has its place, problems keep their last known rows", () => {
  const b = board();
  assert.equal(b.flatMap((g) => g.apps).length, 12);
  const old = b.find((g) => g.name === "Old PC");
  assert.equal(old.apps[0].state, "offline");
  assert.deepEqual(old.apps[0].rows.map((r) => [r.task.name, r.stale]), [["Stale run", true]]);
  assert.equal(appNote(old.apps[0], "Old PC", NOW), "Can't reach Old PC · last known 3 min ago");
  const dt = b.find((g) => g.name === "Desktop");
  assert.equal(appNote(dt.apps[0], "Desktop", NOW), "Can't reach Desktop · no answer yet");
  const l2 = b.find((g) => g.name === "Laptop 2");
  assert.match(appNote(l2.apps[0], "Laptop 2", NOW), /^No longer paired/);
  const m1 = b.find((g) => g.name === "Mini 1");
  assert.equal(appNote(m1.apps[1], "Mini 1", NOW), "Nothing running · 12 left");
});

test("a PC kept from before shows its rows but counts as checking until it answers", () => {
  const g = buildGroups([entry("smu:z", "smu", "ZBook", [running("a", "A", 5)], { fresh: false, okAt: NOW - 60_000 })], NOW)[0];
  assert.equal(g.apps[0].state, "connecting");
  assert.equal(g.apps[0].rows[0].stale, true);
  assert.equal(g.state, "connecting");
  assert.equal(buildGroups([entry("smu:z", "smu", "ZBook", [running("a", "A", 5)])], NOW)[0].state, "running");
});

test("PCs without an id are told apart by name; a needs-you task that isn't running still shows", () => {
  const b = buildGroups([
    entry("smu:a", "smu", "ZBook", [task("t", "Gym", { needs_you: true, needs_you_reason: "IWM needs you" })], { pcId: "" }),
    entry("tabgod:b", "tabgod", "zbook", [], { pcId: "" }),
  ], NOW);
  assert.equal(b.length, 1);
  assert.equal(b[0].state, "needs");
  assert.equal(b[0].apps[0].rows.length, 1);
});

test("can't reach words and every card label", () => {
  assert.equal(reachText("ZBook", NOW - 5 * 60_000, NOW), "Can't reach ZBook · last known 5 min ago");
  assert.equal(reachText("", 0, NOW), "Can't reach the PC · no answer yet");
  for (const s of ["needs", "running", "offline", "token", "error", "connecting", "idle"]) assert.ok(GROUP_LABELS[s], s);
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
  const b = buildGroups([
    entry("smu:a", "smu", "A", [running("1", "One", 10)]),
    entry("smu:b", "smu", "B", [running("2", "Two", 9, { eta_at: new Date(NOW + 20 * 60_000).toISOString() })]),
  ], NOW);
  assert.deepEqual(b.map((g) => g.name), ["A", "B"]);
});

test("the main screen has no app tabs any more", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(!html.includes('role="tablist"'));
  assert.ok(html.includes('id="list"'));
});

// ---------- Detail view ----------

const T0 = Date.parse("2026-11-01T03:00:00Z");
const one = (t) => S.normalizeStatus({ tasks: [t] }).tasks[0];

test("detail parses: kind, step, page, since, what to do, newest 5 problems", () => {
  const recent = Array.from({ length: 7 }, (_, i) => ({ at: new Date(T0 - i * 60_000).toISOString(), reason: `r${i}`, result: i === 1 ? "skipped" : "odd" }));
  const t = one({ needs_you: true, needs_you_reason: "Needs attention", detail: { kind: "attention", step: "Date of birth",
    page: "Step 2 of 4", since: "2026-11-01T02:54:00Z", what_to_do: "Do it.", recent: [...recent].reverse(), extra: 1 } });
  assert.equal(t.detail.kind, "attention");
  assert.equal(t.detail.step, "Date of birth");
  assert.equal(t.detail.page, "Step 2 of 4");
  assert.equal(t.detail.since, Date.parse("2026-11-01T02:54:00Z"));
  assert.equal(t.detail.whatToDo, "Do it.");
  assert.deepEqual(t.detail.recent.map((r) => r.reason), ["r0", "r1", "r2", "r3", "r4"]);
  assert.deepEqual(t.detail.recent.map((r) => r.result), ["failed", "skipped", "failed", "failed", "failed"]);
  assert.equal("extra" in t.detail, false);
});

test("a missing or broken detail is null, odd parts are dropped, never an error", () => {
  assert.equal(one({}).detail, null);
  assert.equal(one({ detail: "x" }).detail, null);
  assert.equal(one({ detail: [] }).detail, null);
  const d = one({ detail: { kind: "<script>", step: 5, since: "later", recent: [null, 3, { reason: "" }, { at: "x", reason: "ok" }] } }).detail;
  assert.deepEqual(d, { kind: "", step: "", page: "", since: null, whatToDo: "", recent: [{ at: null, result: "failed", reason: "ok" }] });
});

test("emails and IP addresses are masked as a second guard", () => {
  const t = one({ needs_you: true, needs_you_reason: "Sent to jo.bloggs+x@mail.example.co.uk from 192.168.1.20",
    detail: { step: "fe80:0:0:0:1:2:3:4", recent: [{ reason: "a@b.io bounced" }] } });
  assert.equal(t.reason, "Sent to [email] from [address]");
  assert.equal(t.detail.step, "[address]");
  assert.equal(t.detail.recent[0].reason, "[email] bounced");
  assert.equal(S.scrub("Step 2 of 4, version 1.2.0"), "Step 2 of 4, version 1.2.0");
});

test("kind: from the detail, else from SMU's own reasons; other SMU reasons are IWM's; TabGod waits are stuck", () => {
  const smu = (reason, detail) => S.kindOf("smu", one({ needs_you: true, needs_you_reason: reason, detail }));
  assert.equal(smu("Needs attention"), "attention");
  assert.equal(smu("A question"), "question");
  assert.equal(smu("Is this the form's email?"), "email_check");
  assert.equal(smu("Watching you fill the form"), "watching");
  assert.equal(smu("Finish your own sign-up"), "finish");
  assert.equal(smu("IWM can't find the browser window"), "iwm");
  assert.equal(smu("A question", { kind: "attention" }), "attention");
  assert.equal(S.kindOf("tabgod", one({ needs_you: true, needs_you_reason: "Both AIs couldn't do a step" })), "stuck");
  assert.equal(S.kindOf("smu", one({ running: true })), "");
});

test("what to do: plain words naming the PC, for each app and kind", () => {
  const todo = (app, reason, device = "ZBook", detail) => S.whatToDo(app, one({ needs_you: true, needs_you_reason: reason, detail }), device);
  assert.equal(todo("smu", "Needs attention"), "On ZBook, open SMU, press Show SMU, do the step yourself, then press Carry on.");
  assert.equal(todo("smu", "A question"), "Answer SMU's question on ZBook.");
  assert.equal(todo("smu", "IWM lost the page"), "Fix it in IWM on ZBook; SMU carries on when IWM moves on.");
  assert.equal(todo("smu", "Is this the form's email?"), "On ZBook, open SMU and say whether this is the form's email.");
  assert.equal(todo("smu", "Finish your own sign-up"), "On ZBook, finish your own sign-up in the browser, then press I've finished in SMU.");
  assert.equal(todo("tabgod", "Both AIs couldn't do a step", "Mini 2"), "Open TabGod on Mini 2, the window was left for you on that profile.");
  assert.equal(todo("smu", "", "ZBook", { kind: "new_kind" }), "Open SMU on ZBook to see what it needs.");
  assert.equal(todo("smu", "A question", "ZBook", { what_to_do: "Press Yes on ZBook." }), "Press Yes on ZBook.");
  assert.equal(todo("smu", "A question", ""), "Answer SMU's question on the PC.");
  assert.equal(S.whatToDo("smu", one({ running: true }), "ZBook"), "");
});

test("what's wrong: the full reason and the known facts; never blank", () => {
  const t = one({ needs_you: true, needs_you_reason: "Needs attention",
    detail: { kind: "attention", step: "Date of birth", page: "Step 2 of 4", since: new Date(T0 - 12 * 60_000).toISOString() } });
  assert.deepEqual(S.whatsWrong("smu", t, T0), { title: "Needs attention", kind: "Stuck on a step",
    facts: [["Step", "Date of birth"], ["Page", "Step 2 of 4"], ["Waiting", "12 min"]] });
  const bare = one({ needs_you: true });
  assert.deepEqual(S.whatsWrong("tabgod", bare, T0), { title: "Stuck on a step", kind: "Stuck on a step", facts: [] });
  assert.equal(S.whatsWrong("smu", one({ needs_you: true, detail: { since: new Date(T0 - 5000).toISOString() } }), T0).facts[0][1], "under a minute");
  assert.equal(S.whatsWrong("smu", one({ running: true }), T0), null);
});

test("per-person time, problem times and the task's state line", () => {
  assert.equal(S.perPersonText(95), "1 min 35 s");
  assert.equal(S.perPersonText(120), "2 min");
  assert.equal(S.perPersonText(45), "45 s");
  assert.equal(S.perPersonText(7500), "2 h 5 min");
  assert.equal(S.perPersonText(null), "");
  assert.equal(S.whenText(T0 - 15 * 60_000, T0, "UTC"), "02:45");
  assert.equal(S.whenText(T0 - 26 * 3600_000, T0, "UTC"), "31 Oct 01:00");
  assert.equal(S.taskState(one({ needs_you: true, running: true })), "Needs you");
  assert.equal(S.taskState(one({ running: true, learned: false })), "Running · learning the form");
  assert.equal(S.taskState(one({ running: true })), "Running");
  assert.equal(S.taskState(one({ left: 0 })), "Finished");
  assert.equal(S.taskState(one({ left: 3 })), "Not running");
});

test("per-person and gap seconds are kept for the detail view", () => {
  const t = one({ per_person_seconds: 95, gap_seconds: "20" });
  assert.equal(t.perPersonSeconds, 95);
  assert.equal(t.gapSeconds, 20);
});

test("version 2.1.0 in both app and service worker; the detail view is in the page", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  assert.match(app, /VERSION = "2\.1\.0"/);
  assert.match(sw, /VERSION = "2\.1\.0"/);
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(html.includes('id="detail"') && html.includes('id="detail-back"'));
});
