// node --test letmeknow/tests/quefix.test.mjs
// TabGod's QueFix in /v1/status: reading it, its words, and where it shows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildGroups, normalizeQuefix, normalizeStatus, outOfOrderRow, pairText, profileNumber, quefixLine, scannedText,
} from "../lib/status.mjs";

const NOW = Date.parse("2026-11-04T01:00:00Z");
const QF = {
  live: true, scanned_at: "2026-11-04T00:59:48+00:00", windows: 24, desktops: 3, in_order: false,
  out_of_order_count: 2, out_of_order: [{ first: "7", then: "3" }, { first: "12", then: "Jo (5)" }],
  rows: [
    { rank: 2, name: "3", position: "1,515", bar: false, sure: true, desktop: 1 },
    { rank: 1, name: "Milo (10)", position: "1,204", bar: false, sure: true, desktop: 2 },
    { rank: 3, name: "", position: "64%", bar: true, sure: false, desktop: null },
  ],
};

test("TabGod's quefix reads as sent: rows by rank, blank names become Window <rank>, desktop may be null", () => {
  const q = normalizeStatus({ app: "tabgod", tasks: [], quefix: QF }).quefix;
  assert.equal(q.live, true);
  assert.equal(q.scannedAt, Date.parse("2026-11-04T00:59:48Z"));
  assert.deepEqual([q.windows, q.desktops, q.inOrder, q.outOfOrderCount], [24, 3, false, 2]);
  assert.deepEqual(q.rows.map((r) => [r.rank, r.name, r.position, r.bar, r.sure, r.desktop]), [
    [1, "Milo (10)", "1,204", false, true, 2],
    [2, "3", "1,515", false, true, 1],
    [3, "Window 3", "64%", true, false, null],
  ]);
  assert.deepEqual(q.outOfOrder, [{ first: "7", then: "3" }, { first: "12", then: "Jo (5)" }]);
});

test("only from TabGod, and only when there: absent, odd or from SMU is no QueFix at all", () => {
  assert.equal(normalizeStatus({ app: "tabgod", tasks: [] }).quefix, null);
  assert.equal(normalizeStatus({ app: "smu", tasks: [], quefix: QF }).quefix, null);
  assert.equal(normalizeStatus({ tasks: [], quefix: QF }).quefix, null);
  assert.equal(normalizeQuefix("on"), null);
  assert.equal(normalizeQuefix([QF]), null);
  const q = normalizeQuefix({ rows: [null, 5, { name: "A" }] });
  assert.deepEqual([q.live, q.windows, q.inOrder, q.outOfOrderCount, q.scannedAt], [false, 1, true, 0, null]);
  assert.equal(q.rows[0].sure, true); // missing sure is sure
});

test("at most 100 rows and 5 pairs; names and pairs are masked again on the phone", () => {
  const rows = Array.from({ length: 140 }, (_, i) => ({ rank: 140 - i, name: `P ${140 - i}`, position: "1" }));
  const pairs = Array.from({ length: 9 }, (_, i) => ({ first: String(i + 2), then: String(i + 1) }));
  const q = normalizeQuefix({ rows, out_of_order: pairs, out_of_order_count: 9,
    windows: 140 });
  assert.equal(q.rows.length, 100);
  assert.deepEqual([q.rows[0].rank, q.rows[99].rank], [1, 100]);
  assert.equal(q.outOfOrder.length, 5);
  assert.equal(q.outOfOrderCount, 9);
  const m = normalizeQuefix({ rows: [{ rank: 1, name: "jo@example.com (4)", position: "10.0.0.1" }],
    out_of_order: [{ first: "a@b.co", then: "3" }] });
  assert.equal(m.rows[0].name, "[email] (4)");
  assert.equal(m.rows[0].position, "[address]");
  assert.equal(m.outOfOrder[0].first, "[email]");
});

test("the card's line, the pair words and how long ago it was scanned", () => {
  const q = normalizeQuefix(QF);
  assert.equal(quefixLine(q), "QueFix live · 24 windows · 2 out of order");
  assert.equal(quefixLine({ ...q, inOrder: true }), "QueFix live · 24 windows · all in order");
  assert.equal(quefixLine({ ...q, live: false, inOrder: true, windows: 1 }), "QueFix · 1 window · all in order");
  assert.equal(pairText(q.outOfOrder[0]), "7 should be before 3");
  assert.equal(scannedText(q, NOW), "scanned 12 s ago");
  assert.equal(scannedText({ scannedAt: null }, NOW), "");
});

test("the profile number stands out, and out-of-order rows are found by number or name", () => {
  assert.equal(profileNumber("Milo (10)"), "10");
  assert.equal(profileNumber(" 10 "), "10");
  assert.equal(profileNumber("Window 3"), "");
  const q = normalizeQuefix({ ...QF, rows: [
    { rank: 1, name: "Ava (7)" }, { rank: 2, name: "3" }, { rank: 3, name: "Milo (10)" }, { rank: 4, name: "Jo (5)" },
  ] });
  assert.deepEqual(q.rows.map((r) => outOfOrderRow(q, r)), [true, true, false, true]);
});

test("the QueFix line belongs to that PC's TabGod, and stays (greyed) while the PC can't be reached", () => {
  const entry = (key, app, extra = {}) => ({ key, app, pcId: "zb", device: "ZBook", fetchedAt: NOW, okAt: NOW,
    error: "", status: normalizeStatus({ app, device: { name: "ZBook" }, tasks: [], quefix: QF }), ...extra });
  const [g] = buildGroups([entry("smu:zb", "smu"), entry("tabgod:zb", "tabgod")], NOW);
  assert.deepEqual(g.apps.map((a) => [a.app, !!a.quefix]), [["smu", false], ["tabgod", true]]);
  const [off] = buildGroups([entry("tabgod:zb", "tabgod", { error: "offline" })], NOW);
  assert.equal(off.apps[0].state, "offline");
  assert.equal(off.apps[0].quefix.windows, 24);
  const [none] = buildGroups([entry("tabgod:zb", "tabgod", { status: normalizeStatus({ app: "tabgod", tasks: [] }) })], NOW);
  assert.equal(none.apps[0].quefix, null);
});

test("the app has the QueFix line and view, and opens it from a QueFix alert", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /function quefixRow\(/);
  assert.match(app, /function renderQuefix\(/);
  assert.match(app, /o\.task === "quefix"/);
});

// ---------- Near the front (above 90 %, or under 1,000 in the queue) ----------

test("near-front rows are read and counted; the card's line says how many", () => {
  const q = normalizeQuefix({ ...QF, in_order: true, out_of_order_count: 0, out_of_order: [], near_count: 2, rows: [
    { rank: 1, name: "Milo (10)", position: "842", near: true }, { rank: 2, name: "7", position: "93%", bar: true, near: true },
    { rank: 3, name: "3", position: "1,515" },
  ] });
  assert.deepEqual(q.rows.map((r) => r.near), [true, true, false]);
  assert.equal(q.nearCount, 2);
  assert.equal(quefixLine(q), "QueFix live · 24 windows · 2 near front");
  assert.equal(quefixLine({ ...q, inOrder: false, outOfOrderCount: 2 }), "QueFix live · 24 windows · 2 near front · 2 out of order");
  assert.equal(normalizeQuefix({ rows: [{ near: true }, { near: "yes" }] }).nearCount, 1); // counted when not sent
  assert.equal(normalizeQuefix({ rows: [] }).nearCount, 0);
});

test("the QueFix list marks near-front rows in green and counts them at the top", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  assert.match(app, /"qf-near", "near front"/);
  assert.match(app, /near front`\)\)/);
  assert.match(css, /\.qf-item\.near \{[^}]*var\(--green\)/);
});
