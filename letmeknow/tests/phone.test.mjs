// node --test letmeknow/tests/phone.test.mjs
// Token rotation that never unpairs the phone, and the detail view changing only what changed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { patchChildren } from "../lib/patch.mjs";
import * as tokens from "../lib/tokens.mjs";

const NOW = Date.parse("2026-11-04T01:00:00Z");
const DAY = 24 * 3600 * 1000;

// A PC that accepts a set of tokens, as the PC side keeps the old one until the new one is used.
function fakePc(accepts) {
  const seen = [];
  const call = async (token) => {
    seen.push(token);
    if (!accepts.has(token)) throw Object.assign(new Error("token"), { kind: "token" });
    return { ok: true, token };
  };
  return { seen, call };
}

test("rotation is due every 30 days, never while one waits to be confirmed, and not again right after a try", () => {
  assert.equal(tokens.shouldRotate({ rotatedAt: NOW - 31 * DAY }, NOW), true);
  assert.equal(tokens.shouldRotate({ rotatedAt: NOW - 29 * DAY }, NOW), false);
  assert.equal(tokens.shouldRotate({}, NOW), true);
  assert.equal(tokens.shouldRotate({ rotatedAt: 0, oldToken: "old" }, NOW), false);
  assert.equal(tokens.shouldRotate({ rotatedAt: 0, rotateTriedAt: NOW - 60_000 }, NOW), false);
  assert.equal(tokens.shouldRotate({ rotatedAt: 0, rotateTriedAt: NOW - 11 * 60_000 }, NOW), true);
});

test("a rotate answer: the new token is used, the old one kept until the new one has worked", async () => {
  let pc = { key: "smu:a", token: "old", rotatedAt: NOW - 31 * DAY };
  pc = { ...pc, ...tokens.afterRotate(pc, { token: "new" }, NOW) };
  assert.deepEqual([pc.token, pc.oldToken, pc.rotatedAt], ["new", "old", NOW]);
  const { seen, call } = fakePc(new Set(["old", "new"]));
  const r = await tokens.callWithToken(pc, call);
  assert.equal(r.result.token, "new");
  assert.deepEqual(r.patch, { oldToken: "" }); // confirmed: the old one can go
  assert.deepEqual(seen, ["new"]);
  pc = { ...pc, ...r.patch };
  assert.equal((await tokens.callWithToken(pc, call)).patch, null); // nothing more to keep
});

test("the new token refused (the PC never took it): the old one is used again and kept, nothing unpairs", async () => {
  const pc = { key: "smu:a", token: "new", oldToken: "old", rotatedAt: NOW };
  const { seen, call } = fakePc(new Set(["old"]));
  const r = await tokens.callWithToken(pc, call, NOW);
  assert.equal(r.result.token, "old");
  assert.deepEqual(seen, ["new", "old"]);
  assert.deepEqual(r.patch, { token: "old", oldToken: "", rotatedAt: 0, rotateTriedAt: NOW });
  const after = { ...pc, ...r.patch };
  assert.equal(tokens.shouldRotate(after, NOW + 60_000), false); // not straight away again
  assert.equal(tokens.shouldRotate(after, NOW + 11 * 60_000), true);
});

test("a lost rotate answer: the old token stays in use and is used to ask again later", async () => {
  // The phone sent POST /v1/token/rotate and was suspended before the answer: nothing was stored but the try time.
  const pc = { key: "smu:a", token: "old", rotatedAt: NOW - 31 * DAY, rotateTriedAt: NOW };
  const { call } = fakePc(new Set(["old", "lost-new"])); // the PC keeps the old one until the new one is used
  const r = await tokens.callWithToken(pc, call);
  assert.equal(r.result.token, "old");
  assert.equal(r.patch, null);
  assert.equal(tokens.shouldRotate(pc, NOW + 60_000), false);
  assert.equal(tokens.shouldRotate(pc, NOW + 11 * 60_000), true); // asked again, with the old token
  const next = { ...pc, ...tokens.afterRotate(pc, { token: "newer" }, NOW + 11 * 60_000) };
  assert.deepEqual([next.token, next.oldToken], ["newer", "old"]);
});

test("a refusal with no rotation waiting, or any other error, is passed on as it is", async () => {
  const { call } = fakePc(new Set());
  await assert.rejects(tokens.callWithToken({ token: "t" }, call), (e) => e.kind === "token");
  const offline = async () => {
    throw Object.assign(new Error("offline"), { kind: "offline" });
  };
  let tried = 0;
  await assert.rejects(tokens.callWithToken({ token: "new", oldToken: "old" }, async (t) => (tried++, offline(t))),
    (e) => e.kind === "offline");
  assert.equal(tried, 1); // offline is not a token problem: the old token isn't tried
  assert.deepEqual(tokens.afterRotate({ token: "t" }, null, NOW), { rotatedAt: NOW, rotateTriedAt: 0 }); // 404
});

// ---------- Patching: only what changed reaches the page ----------

// Just enough of the DOM for lib/patch.mjs.
class Node {
  constructor(type, name, data = "") {
    this.nodeType = type;
    this.nodeName = name;
    this.data = data;
    this.childNodes = [];
    this.attrs = new Map();
    this.writes = 0;
  }
  get attributes() {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }
  getAttribute(n) {
    return this.attrs.has(n) ? this.attrs.get(n) : null;
  }
  hasAttribute(n) {
    return this.attrs.has(n);
  }
  setAttribute(n, v) {
    this.attrs.set(n, String(v));
    this.writes++;
  }
  removeAttribute(n) {
    this.attrs.delete(n);
    this.writes++;
  }
  replaceChild(b, a) {
    this.childNodes[this.childNodes.indexOf(a)] = b;
  }
  replaceChildren(...n) {
    this.childNodes = n;
  }
  get text() {
    return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.text).join("");
  }
}
const txt = (s) => new Node(3, "#text", s);
function h(tag, attrs, ...kids) {
  const n = new Node(1, tag.toUpperCase());
  for (const [k, v] of Object.entries(attrs || {})) n.attrs.set(k, v);
  n.childNodes = kids.map((k) => (typeof k === "string" ? txt(k) : k));
  return n;
}
const facts = (left, by) => [
  h("div", { class: "card" }, h("h2", null, "Gym list"), h("span", { class: "updated" }, "Updated just now")),
  h("div", { class: "card progress" }, h("div", { class: "fact" }, h("span", null, "Time left"), h("span", null, left)),
    h("div", { class: "fact" }, h("span", null, "Finish"), h("span", null, by)),
    h("div", { class: "bar-track" }, h("span", { class: "bar-done", style: "width: 30%;" }))),
];

test("the same screen a second later: the same nodes stay, only the changed text is written", () => {
  const body = h("div", null);
  patchChildren(body, facts("43 min", "about 01:43"));
  const card = body.childNodes[1], left = card.childNodes[0].childNodes[1].childNodes[0], title = body.childNodes[0].childNodes[0];
  patchChildren(body, facts("42 min", "about 01:43"));
  assert.equal(body.childNodes[1], card); // kept, so a screen reader stays where it was
  assert.equal(body.childNodes[0].childNodes[0], title);
  assert.equal(card.childNodes[0].childNodes[1].childNodes[0], left);
  assert.equal(left.data, "42 min");
  assert.equal(card.writes, 0);
  assert.match(body.text, /Time left42 minFinishabout 01:43/);
});

test("changed attributes are updated in place; a different shape is replaced", () => {
  const body = h("div", null);
  patchChildren(body, facts("5 min", "about 01:05"));
  const bar = body.childNodes[1].childNodes[2].childNodes[0];
  const next = facts("4 min", "about 01:05");
  next[1].childNodes[2].childNodes[0].attrs.set("style", "width: 40%;");
  next[0].attrs.delete("class");
  patchChildren(body, next);
  assert.equal(body.childNodes[1].childNodes[2].childNodes[0], bar);
  assert.equal(bar.getAttribute("style"), "width: 40%;");
  assert.equal(body.childNodes[0].hasAttribute("class"), false);
  // Another screen (fewer cards, or another element): replaced, not merged.
  const other = [h("p", { class: "nothing" }, "This task isn't on the list any more")];
  patchChildren(body, other);
  assert.equal(body.childNodes[0], other[0]);
  const swapped = [h("section", null, "a"), h("div", { class: "card progress" })];
  const keep = h("div", null);
  patchChildren(keep, [h("div", null, "a"), h("div", { class: "card progress" })]);
  patchChildren(keep, swapped);
  assert.equal(keep.childNodes[0], swapped[0]);
});

test("no focus ring is switched off: every field and button shows where the focus is", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /outline:\s*(none|0)\b/);
  assert.match(css, /\.row-input input:focus \{ outline: 3px solid var\(--accent\)/);
});
