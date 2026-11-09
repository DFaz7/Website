// node --test letmeknow/tests/answer.test.mjs
// Answering a PC's question from the phone: the question in /v1/status, the buttons and the words of the result, an
// alert's answer buttons in the service worker (run in a sandbox) and the address its tap opens.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { DONE, LABELS, answerFromParams, answerView, resultOf } from "../lib/answer.mjs";
import { ApiError } from "../lib/api.mjs";
import { ANSWERS, normalizeQuestion, normalizeStatus } from "../lib/status.mjs";

const Q = "q_0123456789ab";

test("a question: known answers only, each once, in the PC's order; anything odd is no question", () => {
  assert.deepEqual(normalizeQuestion({ id: Q, answers: ["do_it", "skip", "do_it", "explode", 7] }), { id: Q, answers: ["do_it", "skip"] });
  for (const bad of [null, "q", [], { id: "nope", answers: ["skip"] }, { id: Q }, { id: Q, answers: [] },
    { id: Q, answers: ["later"] }, { id: Q, answers: "skip" }, { id: 5, answers: ["skip"] }, { id: "q_<b>", answers: ["skip"] }]) {
    assert.equal(normalizeQuestion(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(ANSWERS, ["skip", "do_it", "retry"]);
});

test("/v1/status carries a task's question in its detail; a task without one has null", () => {
  const s = normalizeStatus({ device: { name: "ZBook", id: "a1" }, tasks: [
    { id: "t1", name: "Gym list", needs_you: true, needs_you_reason: "Needs attention",
      detail: { kind: "attention", question: { id: Q, answers: ["skip", "do_it", "retry"] } } },
    { id: "t2", name: "Book club", detail: { kind: "attention" } },
  ] });
  assert.deepEqual(s.tasks[0].detail.question, { id: Q, answers: ["skip", "do_it", "retry"] });
  assert.equal(s.tasks[1].detail.question, null);
});

test("the buttons' words and what each answer says when it went through", () => {
  assert.deepEqual(LABELS, { skip: "Skip this person", do_it: "I'll do it", retry: "Retry" });
  assert.equal(DONE.skip, "Skipped");
  assert.equal(DONE.do_it, "SMU is waiting for you at the PC");
  assert.equal(resultOf("skip", { data: { ok: true } }).text, "Skipped");
  assert.deepEqual(resultOf("do_it", { data: { ok: true, message: "SMU is waiting for you at the PC" } }),
    { ok: true, text: "SMU is waiting for you at the PC" });
  assert.equal(resultOf("retry", { data: {} }).text, "Trying again");
});

test("a refusal shows the PC's own words, masked; otherwise plain words for what went wrong", () => {
  const stale = new ApiError("http", 409, { error: "stale", message: "That question is over: SMU isn't waiting on it any more." });
  assert.deepEqual(resultOf("skip", { error: stale }), { ok: false, text: "That question is over: SMU isn't waiting on it any more." });
  const leak = new ApiError("http", 409, { error: "refused", message: "Not for jo@example.com at 10.0.0.2" });
  assert.equal(resultOf("skip", { error: leak }).text, "Not for [email] at [address]");
  assert.match(resultOf("skip", { error: new ApiError("offline") }, "ZBook").text, /^Couldn't reach ZBook/);
  assert.match(resultOf("skip", { error: new ApiError("token", 401) }, "ZBook").text, /Pair it again/);
  assert.match(resultOf("skip", { error: new ApiError("slow", 429) }).text, /Wait a moment/);
  assert.match(resultOf("skip", { error: new ApiError("http", 404, { error: "not found" }) }).text, /can't take answers/);
  assert.match(resultOf("skip", { error: new ApiError("http", 500, null) }).text, /Answer it on the PC/);
});

test("the detail view: buttons for an open question; none while one is on its way or once it went through", () => {
  const q = { id: Q, answers: ["skip", "do_it"] };
  assert.deepEqual(answerView(q, null), { buttons: [{ answer: "skip", label: "Skip this person" }, { answer: "do_it", label: "I'll do it" }], result: null });
  assert.deepEqual(answerView(q, { question: Q, state: "sending", text: "Sending…" }), { buttons: [], result: { state: "sending", text: "Sending…" } });
  assert.deepEqual(answerView(q, { question: Q, state: "ok", text: "Skipped" }).buttons, []);
  // refused: the buttons again, with why
  const err = answerView(q, { question: Q, state: "error", text: "Pause first" });
  assert.equal(err.buttons.length, 2);
  assert.deepEqual(err.result, { state: "error", text: "Pause first" });
  // the question is gone from the status after the answer: the result stays
  assert.deepEqual(answerView(null, { question: Q, state: "ok", text: "Skipped" }), { buttons: [], result: { state: "ok", text: "Skipped" } });
  // a new question: its buttons, and the old answer's result no longer shown
  assert.deepEqual(answerView({ id: "q_ffffffffffff", answers: ["retry"] }, { question: Q, state: "ok", text: "Skipped" }),
    { buttons: [{ answer: "retry", label: "Retry" }], result: null });
  assert.deepEqual(answerView(null, null), { buttons: [], result: null });
});

test("an alert button's answer is read from the address only when well formed", () => {
  const p = (s) => answerFromParams(new URLSearchParams(s));
  assert.deepEqual(p(`pc=a1&task=t1&q=${Q}&answer=skip`), { question: Q, answer: "skip" });
  assert.equal(p("pc=a1&task=t1"), null);
  assert.equal(p(`q=${Q}&answer=delete`), null);
  assert.equal(p("q=x&answer=skip"), null);
});

// ---------- The service worker ----------

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
    clients: { matchAll: async () => windows, openWindow: async (url) => opened.push(url), claim: async () => {} },
    skipWaiting: () => {},
  };
  vm.runInNewContext(readFileSync(new URL("../sw.js", import.meta.url), "utf8"), { self, URL, console, Date, Number });
  const fire = async (type, event) => {
    const waits = [];
    handlers[type]({ ...event, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  return { shown, opened, fire };
}

const base = { v: 1, app: "smu", pc: "a1b2c3d4e5f60718", pc_name: "ZBook", task: "t1", task_name: "Gym list",
  kind: "needs_you", title: "ZBook needs you", body: "Gym list: Needs attention", at: "2026-11-07T22:00:00+00:00" };
const pushEvent = (p) => ({ data: { json: () => p } });
const plain = (x) => JSON.parse(JSON.stringify(x));

test("worker: a needs_you with a question gets the answer buttons, in the PC's order, and remembers the question", async () => {
  const w = loadWorker();
  await w.fire("push", pushEvent({ ...base, question: Q, answers: ["skip", "do_it", "retry", "skip", "nope"] }));
  const [n] = w.shown;
  assert.deepEqual(plain(n.options.actions), [
    { action: "skip", title: "Skip this person" }, { action: "do_it", title: "I'll do it" }, { action: "retry", title: "Retry" },
  ]);
  assert.deepEqual(plain(n.options.data), { app: "smu", pc: base.pc, task: "t1", kind: "needs_you", question: Q, answers: ["skip", "do_it", "retry"] });
});

test("worker: no buttons without a usable question, on other kinds, or from TabGod's plain alerts", async () => {
  const w = loadWorker();
  await w.fire("push", pushEvent(base));
  await w.fire("push", pushEvent({ ...base, question: "bad id", answers: ["skip"] }));
  await w.fire("push", pushEvent({ ...base, question: Q, answers: [] }));
  await w.fire("push", pushEvent({ ...base, kind: "finished", question: Q, answers: ["skip"] }));
  await w.fire("push", pushEvent({ ...base, app: "tabgod", task: "quefix", task_name: "QueFix" }));
  for (const n of w.shown) {
    assert.equal(n.options.actions, undefined);
    assert.equal(n.options.data.question, undefined);
  }
});

test("worker: an answer button opens the app with the answer; the alert's own tap opens it without", async () => {
  const data = { app: "smu", pc: base.pc, task: "t1", kind: "needs_you", question: Q, answers: ["skip", "do_it"] };
  const w = loadWorker();
  await w.fire("notificationclick", { action: "do_it", notification: { close() {}, data } });
  await w.fire("notificationclick", { action: "", notification: { close() {}, data } });
  await w.fire("notificationclick", { action: "retry", notification: { close() {}, data } }); // not offered: no answer
  assert.deepEqual(w.opened, [
    `https://dmftrading.co.uk/letmeknow/?pc=${base.pc}&app=smu&task=t1&q=${Q}&answer=do_it`,
    `https://dmftrading.co.uk/letmeknow/?pc=${base.pc}&app=smu&task=t1`,
    `https://dmftrading.co.uk/letmeknow/?pc=${base.pc}&app=smu&task=t1`,
  ]);
  const opened = new URL(w.opened[0]);
  assert.deepEqual(answerFromParams(opened.searchParams), { question: Q, answer: "do_it" });
});

test("worker: with the app open, an answer button tells that window, which sends it", async () => {
  const posted = [];
  const win = { focus: async () => {}, postMessage: (m) => posted.push(plain(m)) };
  const w = loadWorker({ windows: [win] });
  const data = { app: "smu", pc: base.pc, task: "t1", kind: "needs_you", question: Q, answers: ["skip"] };
  await w.fire("notificationclick", { action: "skip", notification: { close() {}, data } });
  await w.fire("notificationclick", { notification: { close() {}, data } });
  assert.deepEqual(w.opened, []);
  assert.deepEqual(posted, [
    { type: "open", pc: base.pc, app: "smu", task: "t1", question: Q, answer: "skip" },
    { type: "open", pc: base.pc, app: "smu", task: "t1" },
  ]);
});

test("worker and app: the same button words", () => {
  const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  const labels = /const ANSWER_LABELS = (\{[^}]*\});/.exec(sw)[1];
  assert.deepEqual(plain(vm.runInNewContext(`(${labels})`)), LABELS);
});
