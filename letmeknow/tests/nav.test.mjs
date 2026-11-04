// node --test letmeknow/tests/nav.test.mjs
// Screens as history entries: every entry brings back the screen it names, so back always goes back one screen.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { entryFor, sameEntry, screenFor } from "../lib/nav.mjs";

const PCS = ["smu:zb", "tabgod:zb"];

// A history like the browser's: push, replace, back, forward; each move lands on the screen screenFor names.
function fakeHistory() {
  const stack = [null]; // the list (home) is the first entry
  let at = 0;
  return {
    get state() {
      return stack[at];
    },
    push(e) {
      stack.splice(at + 1, Infinity, e);
      at++;
    },
    replace(e) {
      stack[at] = e;
    },
    // What app.js's remember() does.
    remember(screen, args) {
      const e = entryFor(screen, args);
      if (sameEntry(this.state, e)) this.replace(e);
      else this.push(e);
    },
    back() {
      at = Math.max(0, at - 1);
      return screenFor(stack[at], PCS);
    },
    forward() {
      at = Math.min(stack.length - 1, at + 1);
      return screenFor(stack[at], PCS);
    },
  };
}

test("each screen's entry brings that screen back: home, add, settings, a task, the QueFix list", () => {
  assert.deepEqual(screenFor(null, PCS), { screen: "home" });
  assert.deepEqual(screenFor(entryFor("add"), PCS), { screen: "add" });
  assert.deepEqual(screenFor(entryFor("settings"), PCS), { screen: "settings" });
  assert.deepEqual(screenFor(entryFor("detail", { key: "smu:zb", taskId: "t1", view: "task" }), PCS),
    { screen: "detail", key: "smu:zb", taskId: "t1", view: "task" });
  assert.deepEqual(screenFor(entryFor("detail", { key: "tabgod:zb", taskId: "", view: "quefix" }), PCS),
    { screen: "detail", key: "tabgod:zb", taskId: "", view: "quefix" });
});

test("an alert tapped while adding a PC: back returns to Add a PC, then to the list", () => {
  const h = fakeHistory();
  h.remember("add");
  h.remember("detail", { key: "tabgod:zb", taskId: "", view: "quefix" }); // the alert opens the QueFix list
  assert.deepEqual(h.back(), { screen: "add" }); // the first back does something
  assert.deepEqual(h.back(), { screen: "home" });
  assert.deepEqual(h.forward(), { screen: "add" });
  assert.deepEqual(h.forward(), { screen: "detail", key: "tabgod:zb", taskId: "", view: "quefix" });
});

test("settings, then add, then a task: back walks the same way", () => {
  const h = fakeHistory();
  h.remember("settings");
  h.remember("add");
  h.remember("add"); // a rescan: the same entry, not another
  h.remember("detail", { key: "smu:zb", taskId: "t1" });
  h.remember("detail", { key: "smu:zb", taskId: "t1" }); // the same task again: replaced
  h.remember("detail", { key: "smu:zb", taskId: "t2" }); // another task: its own entry
  assert.deepEqual(h.back(), { screen: "detail", key: "smu:zb", taskId: "t1", view: "task" });
  assert.deepEqual(h.back(), { screen: "add" });
  assert.deepEqual(h.back(), { screen: "settings" });
  assert.deepEqual(h.back(), { screen: "home" });
});

test("an entry for a PC removed since, or anything unknown, goes to the list", () => {
  assert.deepEqual(screenFor(entryFor("detail", { key: "smu:gone", taskId: "t1" }), PCS), { screen: "home" });
  for (const e of [{ lmk: "nope" }, { lmk: "detail" }, "detail", 5, undefined]) assert.deepEqual(screenFor(e, PCS), { screen: "home" });
  assert.equal(entryFor("home"), null);
  assert.equal(entryFor("detail", { key: "k", view: "odd" }).view, "task");
});

test("app.js follows every entry back: detail (task and QueFix), add, settings and home", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const pop = /addEventListener\("popstate", \(e\) => \{([\s\S]*?)\n {2}\}\);/.exec(app)[1];
  assert.match(pop, /nav\.screenFor\(e\.state/);
  for (const s of ['"detail"', '"settings"', '"add"']) assert.ok(pop.includes(`to.screen === ${s}`), s);
  assert.match(pop, /openDetail\(to\.key, to\.taskId, to\.view, false, true\)/);
  assert.match(pop, /else toHome\(\)/);
  assert.match(app, /remember\("detail", \{ key, taskId, view \}\)/);
});
