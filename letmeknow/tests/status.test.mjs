// node --test letmeknow/tests
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as store from "../lib/store.mjs";
import {
  agoText, b64urlToBytes, clockText, guessDeviceName, leftText, needsYouCount, normalizeAddress, normalizeCode,
  normalizeStatus, parsePairing, secondsLeft, sortTasks, tailnetSuffix, timeLine,
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
