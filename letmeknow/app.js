// Let Me Know: the status of SMU and TabGod on each paired PC, and alerts when one needs you.
import * as api from "./lib/api.mjs";
import * as push from "./lib/push.mjs";
import * as store from "./lib/store.mjs";
import * as tokens from "./lib/tokens.mjs";
import { patchChildren } from "./lib/patch.mjs";
import { startScan } from "./lib/scan.mjs";
import {
  APP_NAMES, GROUP_LABELS, agoText, appNote, buildGroups, guessDeviceName, needsYouCount, normalizeAddress,
  normalizeCode, normalizeStatus, outOfOrderRow, pairText, parsePairing, perPersonText, profileNumber, quefixLine,
  reachText, rowTime, scannedText, tailnetSuffix, taskState, whatToDo, whatsWrong, whenText,
} from "./lib/status.mjs";

export const VERSION = "2.1.0";
const POLL_MS = 10_000;
const RESYNC_MS = 60_000; // a PC that missed the alert subscription is offered it again at most this often

const $ = (id) => document.getElementById(id);
let state = store.load();
if (!state.deviceName) state.deviceName = guessDeviceName(navigator.userAgent, navigator.maxTouchPoints || 0);
if (state.theme !== "light") state.theme = "dark";
const live = new Map(); // pc key -> { status, fetchedAt, okAt, error, fresh }
let pollTimer = 0;
let scanner = null;
let swReg = null;
let swReady = null; // resolves to the registration (or null) once the worker is set up
let updating = false;
let lastRefresh = 0; // when every PC was last asked
let rowsById = new Map(); // task row id -> row, for the countdowns between refreshes
let otherKeys = new Set(); // PCs whose alert key isn't this device's (their alerts can't reach it)
let lastNeeds = 0;

// Alerts
const supported = push.support({
  ua: navigator.userAgent,
  touchPoints: navigator.maxTouchPoints || 0,
  standalone: navigator.standalone === true || matchMedia("(display-mode: standalone)").matches,
  hasPush: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
});
let alertsNow = "nopc"; // push.alertsState
let alertError = ""; // "subscribe" when the browser refused
let knownEndpoint = "";
let lastSync = 0;
let syncing = null;

// What the PCs said last time, so the list shows at once on open.
for (const [key, v] of Object.entries(store.loadLast())) {
  if (v && v.status && Array.isArray(v.status.tasks) && v.status.device && state.pcs.some((p) => p.key === key)) {
    live.set(key, { status: v.status, fetchedAt: v.okAt || 0, okAt: v.okAt || 0, error: "", fresh: false });
  }
}

function persist() {
  store.save(state);
}

function persistLast() {
  const last = {};
  for (const pc of state.pcs) {
    const l = live.get(pc.key);
    if (l && l.status && l.okAt) last[pc.key] = { status: l.status, okAt: l.okAt };
  }
  store.saveLast(last);
}

// DOM helper: text only, never HTML from a PC.
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function button(text, cls, onClick) {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function svg(paths, cls) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  if (cls) s.setAttribute("class", cls);
  for (const d of paths) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    s.append(p);
  }
  return s;
}

function pcName(pc) {
  const l = live.get(pc.key);
  return (l && l.status && l.status.device.name) || pc.name || pc.url.replace(/^https?:\/\//, "").split(".")[0];
}

// ---------- Theme ----------

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute("content", state.theme === "light" ? "#f5f5f7" : "#0b0c0f");
  for (const b of document.querySelectorAll("[data-theme-pick]")) {
    b.setAttribute("aria-pressed", String(b.dataset.themePick === state.theme));
  }
}

// ---------- Home ----------

const GLYPH = {
  smu: ["M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z", "M14.5 6.5l3 3"],
  tabgod: ["M3 9.5A2.5 2.5 0 0 1 5.5 7h13A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z",
    "M3 12h18M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7"],
};
const PC_GLYPH = ["M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 14.5z",
  "M9 20h6M12 16v4"];
const CHEVRON = ["M9 5l7 7-7 7"];
const BELL = ["M6 9a6 6 0 1 1 12 0c0 4.5 1.8 6.3 2.5 7H3.5C4.2 15.3 6 13.5 6 9z", "M10 19.5a2 2 0 0 0 4 0"];
const SHARE = ["M12 3v12", "M8 7l4-4 4 4", "M6 11H5v9h14v-9h-1"];

// The app's badge: its own colour and glyph, so SMU and TabGod tell apart at a glance.
function appBadge(app) {
  const b = el("span", `app-badge app-${APP_NAMES[app] ? app : "other"}`);
  b.append(svg(GLYPH[app] || []), el("span", null, APP_NAMES[app] || "App"));
  return b;
}

function entries() {
  return state.pcs.map((pc) => {
    const l = live.get(pc.key) || {};
    return {
      key: pc.key, app: pc.app, pcId: pc.pc || (l.status && l.status.device.id) || "", device: pcName(pc),
      status: l.status || null, error: l.error || "", fetchedAt: l.fetchedAt || 0, okAt: l.okAt || 0, fresh: !!l.fresh,
    };
  });
}

function openRow(node, r) {
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.addEventListener("click", () => openDetail(r.pcKey, r.task.id));
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDetail(r.pcKey, r.task.id);
    }
  });
}

// done / failed / left as one bar: done in green, failed in red, the rest still to do.
function progressBar(t) {
  const bar = el("div", "bar-track");
  bar.setAttribute("aria-hidden", "true");
  const total = (t.done || 0) + (t.failed || 0) + (t.left || 0);
  if (total) {
    const done = el("span", "bar-done");
    done.style.width = `${(100 * (t.done || 0)) / total}%`;
    const failed = el("span", "bar-failed");
    failed.style.width = `${(100 * (t.failed || 0)) / total}%`;
    bar.append(done, failed);
  }
  return bar;
}

function taskRow(r) {
  const t = r.task;
  const row = el("div", `task${t.needsYou ? " needs-row" : ""}${r.stale ? " stale" : ""}`);
  row.dataset.row = r.id;
  row.setAttribute("aria-label", `${APP_NAMES[r.app] || "App"} on ${r.device}, ${t.name}`
    + `${t.needsYou ? `, needs you: ${t.reason || "open the app on the PC"}` : ""}. Show details`);
  openRow(row, r);
  const top = el("div", "task-top");
  const time = el("span", "task-left");
  time.dataset.left = "1";
  top.append(el("span", "task-name", t.name), time, svg(CHEVRON, "chev"));
  const nums = el("div", "task-nums");
  for (const [v, label, bad] of [[t.done, "done"], [t.failed, "failed", true], [t.left, "left"]]) {
    const s = el("span", bad && v ? "bad" : null);
    s.append(el("b", null, v == null ? "–" : String(v)), document.createTextNode(` ${label}`));
    nums.append(s);
  }
  const by = el("span", "task-by");
  by.dataset.by = "1";
  nums.append(by);
  row.append(top, progressBar(t), nums);
  if (t.needsYou) {
    const n = el("div", "needs");
    const txt = el("div", "needs-text");
    txt.append(el("b", null, t.reason || "It needs you"), el("span", null, whatToDo(r.app, t, r.device)));
    n.append(txt);
    row.append(n);
  }
  return row;
}

function appSection(g, a, now) {
  const sec = el("div", "app-sec");
  const line = el("div", "app-line");
  line.append(appBadge(a.app));
  const problem = a.state === "offline" || a.state === "error" || a.state === "token";
  if (!a.rows.length || problem) line.append(el("span", problem ? "app-note warn" : "app-note", appNote(a, g.name, now)));
  sec.append(line);
  // What to do about it, in a line under the app.
  if (a.state === "offline") sec.append(el("p", "app-hint", `Check that Tailscale is on, here and on ${g.name}, and that ${APP_NAMES[a.app] || "the app"} is open there.`));
  if (a.state === "token") sec.append(el("p", "app-hint", `On ${g.name}, open ${APP_NAMES[a.app] || "the app"}'s Settings, Pair a phone, then tap Pair again here.`));
  if (otherKeys.has(a.key)) sec.append(el("p", "app-hint warn", `Its alerts can't reach this device: ${g.name} uses a different alert key from your other PCs.`));
  if (a.state === "token") sec.append(button("Pair again", "btn small ghost fit", openAdd));
  for (const r of a.rows) {
    rowsById.set(r.id, r);
    sec.append(taskRow(r));
  }
  if (a.quefix) sec.append(quefixRow(a, now));
  return sec;
}

// TabGod's QueFix line: live or scanned, how many windows, in order or not. Opens the ranked list.
function quefixRow(a, now) {
  const q = a.quefix;
  const look = !q.inOrder ? " warn-row" : q.nearCount ? " near-row" : "";
  const row = el("div", `quefix-row${look}${a.state !== "ok" ? " stale" : ""}`);
  row.dataset.qf = a.key;
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  const open = () => openDetail(a.key, "", "quefix");
  row.addEventListener("click", open);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });
  const mark = el("span", !q.inOrder ? "qf-mark bad" : q.nearCount ? "qf-mark near" : "qf-mark ok", !q.inOrder ? "!" : q.nearCount ? "↑" : "✓");
  mark.setAttribute("aria-hidden", "true");
  const txt = el("div", "qf-text");
  const line = quefixLine(q);
  txt.append(el("span", "qf-line", `QueFix${q.live ? " live" : ""} · ${q.windows} ${q.windows === 1 ? "window" : "windows"}`));
  const tags = el("div", "qf-tags");
  if (q.nearCount) tags.append(el("span", "qf-tag near", `${q.nearCount} near front`));
  if (!q.inOrder) tags.append(el("span", "qf-tag bad", `${q.outOfOrderCount || q.outOfOrder.length || "some"} out of order`));
  if (q.inOrder && !q.nearCount) tags.append(el("span", "qf-tag ok", "all in order"));
  const ago = el("span", "qf-ago", scannedText(q, now));
  ago.dataset.scanned = q.scannedAt ?? "";
  tags.append(ago);
  txt.append(tags);
  row.setAttribute("aria-label", `${line}. Show the order`);
  row.append(mark, txt, svg(CHEVRON, "chev"));
  return row;
}

const CHIP = { needs: "red", running: "on", offline: "warn", token: "warn", error: "warn", connecting: "", idle: "" };

function pcCard(g, now) {
  const card = el("section", `card pc pc-${g.state}`);
  card.dataset.group = g.id;
  const head = el("header", "pc-head");
  const icon = el("span", "pc-icon");
  icon.append(svg(PC_GLYPH));
  const name = el("h2", "pc-name", g.name || "PC");
  const label = g.state === "needs" && g.needs > 1 ? `${g.needs} need you` : GROUP_LABELS[g.state];
  head.append(icon, name, el("span", `pill ${CHIP[g.state]}`.trim(), label));
  card.setAttribute("aria-label", `${g.name}: ${label}`);
  card.append(head);
  for (const a of g.apps) card.append(appSection(g, a, now));
  return card;
}

function emptyState() {
  const node = $("empty-tpl").content.cloneNode(true);
  node.querySelector("[data-add]").addEventListener("click", openAdd);
  return node;
}

function renderList() {
  const list = $("list");
  const had = document.activeElement && list.contains(document.activeElement) ? document.activeElement.dataset.row : null;
  rowsById = new Map();
  const now = Date.now();
  if (!state.pcs.length) {
    list.replaceChildren(emptyState());
    $("summary").hidden = true;
    tick();
    return;
  }
  otherKeys = new Set(push.otherKeyPcs(state.pcs).map((p) => p.key));
  const nodes = buildGroups(entries(), now).map((g) => pcCard(g, now));
  nodes.push(button("Add a PC", "btn ghost wide add-more", openAdd));
  list.replaceChildren(...nodes);
  $("summary").hidden = false;
  if (had) {
    const again = [...list.querySelectorAll("[data-row]")].find((n) => n.dataset.row === had);
    if (again) again.focus({ preventScroll: true });
  }
  tick();
}

function render() {
  renderList();
  if (detailOf) renderDetail();
  badge();
  tryOpen();
}

// Every second: the countdowns and "updated ... ago", without rebuilding the rows.
function tick() {
  const now = Date.now();
  const sum = $("summary");
  if (!sum.hidden) {
    const n = new Set(entries().map((e) => e.pcId || e.device)).size;
    sum.textContent = `${n} ${n === 1 ? "PC" : "PCs"} · ${lastRefresh ? `updated ${agoText(now - lastRefresh)}` : "checking…"}`;
  }
  for (const node of document.querySelectorAll("#list [data-row]")) {
    const r = rowsById.get(node.dataset.row);
    if (!r) continue;
    const t = rowTime(r.task, now, r.fetchedAt);
    const left = node.querySelector("[data-left]");
    left.textContent = t.left;
    left.classList.toggle("learning", r.task.learned === false);
    node.querySelector("[data-by]").textContent = t.by;
  }
  for (const n of document.querySelectorAll("#list [data-scanned]")) {
    if (n.dataset.scanned) n.textContent = scannedText({ scannedAt: Number(n.dataset.scanned) }, now);
  }
  if (detailOf) renderDetail();
}

// ---------- Detail view: what the issue is and what to do ----------

let detailOf = null; // { key, taskId } of the open detail view
let homeScroll = 0;

function factRow(label, value, cls = "") {
  const row = el("div", `fact ${cls}`.trim());
  row.append(el("span", "fact-label", label), el("span", "fact-value", value));
  return row;
}

function group(title) {
  return el("h3", "group", title);
}

// QueFix: the out-of-order pairs first, then every window by rank with its position.
function renderQuefix() {
  const body = $("detail-body");
  const pc = state.pcs.find((p) => p.key === detailOf.key);
  const l = (pc && live.get(pc.key)) || {};
  const q = l.status && l.status.quefix;
  const now = Date.now();
  if (!pc || !q) {
    const box = el("div", "card nothing");
    box.append(el("b", null, "QueFix isn't on any more"),
      el("span", null, pc ? `TabGod on ${pcName(pc)} shows it while live mode is on, or for 10 minutes after a scan.` : "That PC was removed."));
    patchChildren(body, [box]);
    return;
  }
  const device = pcName(pc);
  const nodes = [];
  const top = el("div", "card detail-top");
  const line = el("div", "detail-line");
  line.append(appBadge(pc.app), el("span", "detail-device", device));
  const meta = el("div", "detail-meta");
  if (q.nearCount) meta.append(el("span", "pill near", `${q.nearCount} near front`));
  meta.append(el("span", q.inOrder ? "pill on" : "pill warn", q.inOrder ? "All in order" : `${q.outOfOrderCount || q.outOfOrder.length} out of order`),
    el("span", l.error ? "updated warn" : "updated", l.error ? reachText(device, l.okAt, now) : [q.live ? "Live" : "", scannedText(q, now)].filter(Boolean).join(" · ")));
  const sum = `${q.windows} ${q.windows === 1 ? "window" : "windows"}${q.desktops ? ` on ${q.desktops} ${q.desktops === 1 ? "desktop" : "desktops"}` : ""}`;
  top.append(line, el("h2", "detail-task", "QueFix"), el("p", "muted", sum), meta);
  nodes.push(top);

  if (q.outOfOrder.length) {
    nodes.push(group("Out of order"));
    const box = el("div", "card qf-pairs");
    for (const p of q.outOfOrder) box.append(el("div", "qf-pair", pairText(p)));
    const more = (q.outOfOrderCount || 0) - q.outOfOrder.length;
    if (more > 0) box.append(el("div", "qf-pair more", `and ${more} more`));
    nodes.push(box);
  }

  // A plain list in rank order: the profile (its number first and large) and its queue position.
  const head = el("div", "qf-head");
  head.append(el("span", null, "Profile"), el("span", null, "Queue position"));
  nodes.push(head);
  const list = el("div", "card qf-list");
  list.setAttribute("role", "list");
  if (!q.rows.length) list.append(el("p", "muted pad", "No windows listed."));
  for (const r of q.rows) {
    const bad = outOfOrderRow(q, r);
    const row = el("div", `qf-item${r.near ? " near" : ""}${bad ? " bad" : ""}`);
    row.setAttribute("role", "listitem");
    const num = profileNumber(r.name);
    const rest = num ? r.name.replace(/\s*\(\d+\)\s*$/, "").replace(/^\s*\d+\s*$/, "") : r.name;
    const who = el("div", "qf-who");
    who.append(el("span", "qf-num", num || r.name));
    if (num && rest) who.append(el("span", "qf-name", rest));
    if (!r.sure) {
      const dot = el("span", "qf-unsure");
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", "not sure");
      dot.title = "not sure";
      who.append(dot);
    }
    const pos = el("div", "qf-right");
    if (r.near) pos.append(el("span", "qf-near", "near front"));
    pos.append(el("span", "qf-pos", r.position || "–"));
    row.append(who, pos);
    row.setAttribute("aria-label", `Profile ${r.name}, queue position ${r.position || "unknown"}${r.near ? ", near the front" : ""}`
      + `${r.sure ? "" : ", not sure"}${bad ? ", out of order" : ""}`);
    list.append(row);
  }
  nodes.push(list);
  patchChildren(body, nodes);
}

function renderDetail() {
  if (detailOf.view === "quefix") return renderQuefix();
  const body = $("detail-body");
  const pc = state.pcs.find((p) => p.key === detailOf.key);
  const l = (pc && live.get(pc.key)) || {};
  const t = l.status && l.status.tasks.find((x) => x.id === detailOf.taskId);
  const now = Date.now();
  const nodes = [];
  if (!pc || !t) {
    const box = el("div", "card nothing");
    box.append(el("b", null, "This task isn't on the list any more"),
      el("span", null, pc ? `${pcName(pc)} no longer shows it. It may have finished or been removed.` : "That PC was removed."));
    patchChildren(body, [box]);
    return;
  }
  const device = pcName(pc);

  const top = el("div", "card detail-top");
  const line = el("div", "detail-line");
  line.append(appBadge(pc.app), el("span", "detail-device", device));
  const st = taskState(t);
  const pill = el("span", t.needsYou ? "pill red" : t.running ? "pill on" : "pill", st);
  const name = el("h2", "detail-task", t.name);
  const upd = el("span", l.error ? "updated warn" : "updated", l.error ? reachText(device, l.okAt, now)
    : l.okAt ? `${l.fresh ? "Updated" : "Last known"} ${agoText(now - l.okAt)}` : "");
  top.append(line, name);
  const meta = el("div", "detail-meta");
  meta.append(pill, upd);
  top.append(meta);
  nodes.push(top);

  const wrong = whatsWrong(pc.app, t, now);
  if (wrong) {
    nodes.push(group("What's wrong"));
    const box = el("div", "card wrong");
    box.append(el("p", "wrong-title", wrong.title));
    if (wrong.kind && wrong.kind.toLowerCase() !== wrong.title.toLowerCase()) box.append(el("p", "wrong-kind", wrong.kind));
    for (const [k, v] of wrong.facts) box.append(factRow(k, v));
    nodes.push(box);
    nodes.push(group("What to do"));
    const todo = el("div", "card todo");
    todo.append(el("p", null, whatToDo(pc.app, t, device)));
    nodes.push(todo);
  } else {
    const ok = el("div", "card todo calm");
    ok.append(el("p", null, t.running ? "Nothing needed from you right now. It carries on by itself." : "Nothing needed from you right now."));
    nodes.push(ok);
  }

  nodes.push(group("Progress"));
  const prog = el("div", "card progress");
  const tiles = el("div", "tiles");
  for (const [label, v, bad] of [["Done", t.done], ["Failed", t.failed, true], ["Left", t.left]]) {
    const tile = el("div", bad && v ? "tile bad" : "tile");
    tile.append(el("b", null, v == null ? "–" : String(v)), el("span", null, label));
    tiles.append(tile);
  }
  prog.append(tiles, progressBar(t));
  const rt = rowTime(t, now, l.fetchedAt);
  prog.append(factRow("Time left", rt.left ? (rt.left === "learning the form" ? rt.left : `about ${rt.left}`) : t.left === 0 ? "none: everyone is done" : "not known yet"));
  if (rt.by) prog.append(factRow("Finish", rt.by.replace(/^done by /, "about ")));
  prog.append(factRow("Per person", t.perPersonSeconds != null ? `about ${perPersonText(t.perPersonSeconds)}` : "not known yet"));
  nodes.push(prog);

  nodes.push(group("Recent problems"));
  const rec = el("div", "card recent");
  const recent = (t.detail && t.detail.recent) || [];
  if (!recent.length) {
    rec.append(el("p", "muted pad", t.detail ? "None reported." : `None reported. ${APP_NAMES[pc.app] || "The app"} on ${device} doesn't send them yet.`));
  }
  for (const p of recent) {
    const row = el("div", "problem");
    const head = el("div", "problem-head");
    head.append(el("span", p.result === "skipped" ? "chip" : "chip red", p.result === "skipped" ? "Skipped" : "Failed"),
      el("span", "problem-at", p.at != null ? whenText(p.at, now) : ""));
    row.append(head, el("p", null, p.reason || "No reason given."));
    rec.append(row);
  }
  nodes.push(rec);
  // Rebuilt every second for the countdowns, but only changed text reaches the page (lib/patch.mjs).
  patchChildren(body, nodes);
}

function openDetail(key, taskId, view = "task") {
  detailOf = { key, taskId, view };
  const pc = state.pcs.find((p) => p.key === key);
  $("detail-title").textContent = pc ? pcName(pc) : view === "quefix" ? "QueFix" : "Details"; // which PC, always
  renderDetail();
  show("detail");
  remember("detail");
  $("detail-back").focus({ preventScroll: true });
}

function closeDetail() {
  if (!detailOf) return;
  const id = `${detailOf.key}/${detailOf.taskId}`;
  const qf = detailOf.view === "quefix" ? detailOf.key : "";
  detailOf = null;
  show("home", true);
  const row = [...document.querySelectorAll("#list [data-row], #list [data-qf]")]
    .find((n) => (qf ? n.dataset.qf === qf : n.dataset.row === id));
  if (row) row.focus({ preventScroll: true });
}

// Every screen but home is a history entry, so the phone's back gesture or button goes back a screen instead of
// leaving the app, and each Back/Cancel/Done goes back through history too.
function remember(id) {
  try {
    if (history.state && history.state.lmk === id) history.replaceState({ lmk: id }, "");
    else history.pushState({ lmk: id }, "");
  } catch {
    // no history here: the on-screen buttons still work
  }
}

function goBack() {
  if (history.state && history.state.lmk) history.back(); // the screen closes through popstate
  else toHome();
}

function toHome() {
  if (detailOf) closeDetail();
  else if ($("home").hidden) closeSheet();
}

function setupDetail() {
  $("detail-back").addEventListener("click", goBack);
  addEventListener("popstate", (e) => {
    const to = e.state && e.state.lmk;
    if (to === "settings" && $("settings").hidden) {
      detailOf = null;
      stopScan();
      openSettings(false, true);
    } else if (!to) toHome();
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("home").hidden) goBack();
  });
}

// ---------- Opening a PC or task from an alert ----------

// An alert's tap opens ./?pc=<pc id>&app=<app>&task=<task id> (or tells the open app the same by message).
let pendingOpen = readOpenParams();

function readOpenParams() {
  const q = new URLSearchParams(location.search);
  if (!q.get("pc")) return null;
  try {
    history.replaceState(null, "", location.pathname);
  } catch {
    // the address keeps its query: harmless
  }
  return { pc: q.get("pc") || "", app: q.get("app") || "", task: q.get("task") || "", until: Date.now() + 30_000 };
}

function tryOpen() {
  const o = pendingOpen;
  if (!o) return;
  const pc = state.pcs.find((p) => p.pc === o.pc && p.app === o.app) || state.pcs.find((p) => p.pc === o.pc);
  if (!pc) {
    pendingOpen = null;
    return;
  }
  const l = live.get(pc.key);
  // A QueFix alert (task "quefix") opens the QueFix list while TabGod still shows it.
  if (o.task === "quefix" && l && l.status && l.status.quefix) {
    pendingOpen = null;
    if (!detailOf || detailOf.key !== pc.key || detailOf.view !== "quefix") openDetail(pc.key, "", "quefix");
    return;
  }
  const t = o.task && l && l.status && l.status.tasks.find((x) => x.id === o.task);
  if (t) {
    pendingOpen = null;
    if (!detailOf || detailOf.key !== pc.key || detailOf.taskId !== t.id) openDetail(pc.key, t.id);
    return;
  }
  // No such task (or none named): show the PC's card once it has answered, or failed to.
  if ((l && (l.fresh || l.error)) || Date.now() > o.until) {
    pendingOpen = null;
    if (detailOf) closeDetail();
    const card = [...document.querySelectorAll("#list [data-group]")].find((n) => n.dataset.group === `id:${pc.pc}`);
    if (card) {
      card.scrollIntoView({ block: "start", behavior: "smooth" });
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 1600);
    }
  }
}

function badge() {
  const n = needsYouCount(state.pcs.map((p) => {
    const l = live.get(p.key);
    return l && !l.error ? l.status : null;
  }));
  try {
    if (n && navigator.setAppBadge) navigator.setAppBadge(n);
    else if (navigator.clearAppBadge) navigator.clearAppBadge();
  } catch {
    // no badge support
  }
  if (n !== lastNeeds) {
    $("announce").textContent = n ? `${n} ${n === 1 ? "task needs" : "tasks need"} you` : "";
    lastNeeds = n;
  }
}

// ---------- Fetching ----------

// An API call with the PC's token as it is now in the store, falling back to the old token while a rotation is
// unconfirmed (lib/tokens.mjs). Whatever that settles is kept.
function authed(fn) {
  return async (pc0, ...args) => {
    const pc = state.pcs.find((p) => p.key === pc0.key) || pc0;
    const { result, patch } = await tokens.callWithToken(pc, (token) => fn({ ...pc, token }, ...args));
    if (patch) {
      state = store.updatePc(state, pc.key, patch);
      persist();
    }
    return result;
  };
}
const pcApi = {
  status: authed(api.status), setMe: authed(api.setMe), devices: authed(api.devices),
  removeDevice: authed(api.removeDevice), testPush: authed(api.testPush),
};

async function fetchPc(pc) {
  const prev = live.get(pc.key) || {};
  try {
    const raw = await pcApi.status(pc);
    const now = Date.now();
    const status = normalizeStatus(raw);
    live.set(pc.key, { status, fetchedAt: now, okAt: now, error: "", fresh: true });
    const patch = {};
    if (status.device.name && status.device.name !== pc.name) patch.name = status.device.name;
    if (!pc.pc && status.device.id) patch.pc = status.device.id;
    if (Object.keys(patch).length) {
      state = store.updatePc(state, pc.key, patch);
      persist();
    }
    const cur = state.pcs.find((p) => p.key === pc.key);
    if (cur && tokens.shouldRotate(cur, now)) rotateToken(cur);
  } catch (e) {
    live.set(pc.key, { ...prev, error: e.kind || "http" });
  }
}

// Asked with the token that just worked. A lost answer leaves the old token in use; it is asked again later.
async function rotateToken(pc) {
  const now = Date.now();
  state = store.updatePc(state, pc.key, { rotateTriedAt: now });
  try {
    const r = await api.rotate(pc);
    state = store.updatePc(state, pc.key, tokens.afterRotate(pc, r, Date.now()));
  } catch (e) {
    if (e.kind === "http" && e.status === 404) state = store.updatePc(state, pc.key, tokens.afterRotate(pc, null, Date.now()));
  }
  persist();
}

let refreshing = null;
async function refresh() {
  if (!refreshing) {
    refreshing = Promise.all(state.pcs.map(fetchPc)).then(() => {
      refreshing = null;
      lastRefresh = Date.now();
      persistLast();
      render();
      if (alertsNow === "on" && Date.now() - lastSync > RESYNC_MS && needsResync()) syncAlerts();
    });
  }
  return refreshing;
}

function startPolling() {
  stopPolling();
  refresh();
  pollTimer = setInterval(refresh, POLL_MS);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = 0;
}

// Pull to refresh: drag down from the top of the list; the spinner follows the finger.
function setupPull() {
  const pull = $("pull");
  const ARM = 90;
  let y0 = null, dy = 0;
  addEventListener("touchstart", (e) => {
    y0 = scrollY <= 0 && !$("home").hidden && e.touches.length === 1 && state.pcs.length ? e.touches[0].clientY : null;
    dy = 0;
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    pull.classList.add("drag");
    pull.style.height = `${Math.min(56, dy * 0.5)}px`;
    pull.style.setProperty("--turn", `${Math.min(dy, ARM) * 3}deg`);
    pull.classList.toggle("armed", dy > ARM);
  }, { passive: true });
  addEventListener("touchend", async () => {
    if (y0 == null) return;
    y0 = null;
    pull.classList.remove("drag");
    if (dy <= ARM) {
      pull.style.height = "";
      pull.classList.remove("armed");
      return;
    }
    pull.classList.add("busy");
    pull.style.height = "48px";
    await refresh();
    pull.classList.remove("busy", "armed");
    pull.style.height = "";
  });
}

// ---------- Views ----------

// Shows one screen with a short slide (from the right going in, from the left coming back). The list's scroll
// position is kept while away and put back on return.
function show(id, back = false) {
  const cur = [...document.querySelectorAll(".view")].find((v) => !v.hidden);
  if (cur && cur.id === "home" && id !== "home") homeScroll = scrollY;
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== id;
  const v = $(id);
  if (cur && cur !== v) {
    v.classList.remove("enter", "enter-back");
    void v.offsetWidth; // restart the animation
    v.classList.add(back ? "enter-back" : "enter");
  }
  scrollTo(0, id === "home" ? homeScroll : 0);
  if (id !== "add") stopScan();
}

function closeSheet() {
  show("home", true);
  render();
}

function message(text, ok = false) {
  const m = $("add-msg");
  m.textContent = text;
  m.classList.toggle("ok", ok);
  m.hidden = !text;
}

// ---------- Alerts ----------

function permission() {
  return "Notification" in window ? Notification.permission : "denied";
}

function ios() {
  return /iPhone|iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

async function registration() {
  if (!swReady) return null;
  const reg = await swReady;
  if (!reg) return null;
  // subscribe() needs an active worker: on the very first open it may still be installing.
  return Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(reg), 8000))]);
}

function needsResync() {
  if (!knownEndpoint) return false;
  const key = push.alertKey(state.pcs);
  return state.pcs.some((p) => p.vapid && push.keysEqual(p.vapid, key) && p.pushEndpoint !== knownEndpoint);
}

// Keeps alerts on (see push.keepAlertsOn) and shows the result. One at a time. Options: `again` waits for one
// already going and then runs once more (a new pairing or a tap must not be answered by a run that started before
// it); `check` also asks each PC whether it still has the subscription (on open); `fromTap` shows a failure (a quiet
// run that couldn't subscribe just leaves the Turn on alerts button).
function syncAlerts({ again = false, check = false, fromTap = false } = {}) {
  if (syncing && again) return syncing.then(() => syncAlerts({ again: true, check, fromTap }));
  if (!syncing) {
    syncing = (async () => {
      const reg = supported === "ok" ? await registration() : null;
      const r = await push.keepAlertsOn({ permission: permission(), reg, pcs: state.pcs, setMe: pcApi.setMe,
        devices: check ? pcApi.devices : null });
      for (const [key, patch] of r.patches) state = store.updatePc(state, key, patch);
      if (r.patches.length) persist();
      alertError = fromTap || !r.error ? r.error : alertError;
      lastSync = Date.now();
      await refreshAlerts(reg, r.sub);
      return r;
    })().finally(() => {
      syncing = null;
    });
  }
  return syncing;
}

async function refreshAlerts(reg = swReg, sub) {
  if (sub === undefined || (sub === null && !alertError)) {
    sub = null;
    try {
      if (reg && supported === "ok") sub = await reg.pushManager.getSubscription();
    } catch {
      sub = null;
    }
  }
  knownEndpoint = sub ? sub.endpoint : "";
  alertsNow = push.alertsState({ supported, permission: permission(), sub, pcs: state.pcs });
  renderAlertStep();
  renderAlertSettings();
}

// The tap on any "Turn on alerts" button: asks and subscribes straight away (inside the tap), then tells every PC.
function turnOnAlerts(btn) {
  const { asked, subscribed } = push.startInTap({ N: window.Notification, reg: swReg, key: push.alertKey(state.pcs) });
  if (btn) {
    btn.disabled = true;
    btn.dataset.text = btn.textContent;
    btn.textContent = "Turning on…";
  }
  return Promise.all([asked, subscribed]).then(() => syncAlerts({ again: true, fromTap: true })).finally(() => {
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.textContent = btn.dataset.text;
    }
  });
}

function steps(items) {
  const ol = el("ol", "steps");
  for (const parts of items) {
    const li = el("li");
    for (const p of parts) li.append(typeof p === "string" ? document.createTextNode(p) : p);
    ol.append(li);
  }
  return ol;
}

// The full-width step shown while alerts are off, saying exactly what to do. null when there's nothing to do.
function alertStep(st) {
  const device = guessDeviceName(navigator.userAgent, navigator.maxTouchPoints || 0);
  const here = device === "This device" ? "this device" : `this ${device}`;
  const box = el("div", "card alert-step");
  const head = el("div", "alert-head");
  const icon = el("span", "alert-icon");
  icon.append(svg(BELL));
  head.append(icon);
  const title = el("h2", null);
  head.append(title);
  box.append(head);
  if (st === "install") {
    title.textContent = `Get alerts on ${here}`;
    const share = el("span", "inline-icon");
    share.append(svg(SHARE));
    share.setAttribute("aria-label", "the Share button");
    share.setAttribute("role", "img");
    box.append(steps([
      ["Tap Share ", share, device === "iPad" ? " at the top of Safari." : " at the bottom of Safari."],
      ["Choose ", el("b", null, "Add to Home Screen"), ", then ", el("b", null, "Add"), "."],
      ["Open Let Me Know from your Home Screen, pair your PCs there and tap ", el("b", null, "Allow"),
        " when it asks about alerts."],
    ]));
    box.append(el("p", "alert-note", "Alerts only work in the Home Screen app. It keeps its own list of PCs, apart from Safari's."));
    return box;
  }
  if (st === "off") {
    title.textContent = "Turn on alerts";
    box.append(el("p", "alert-text", "Get an alert when a PC needs you, or a run finishes or stops."));
    if (alertError) {
      box.append(el("p", "alert-error", "Alerts didn't turn on. Try again. If it keeps failing, remove the app from the Home Screen, add it again and pair once more."));
    }
    const b = button("Turn on alerts", "btn wide big", () => turnOnAlerts(b));
    box.append(b);
    return box;
  }
  if (st === "blocked") {
    title.textContent = "Alerts are blocked";
    box.append(el("p", "alert-text", ios()
      ? `Open the ${device === "iPad" ? "iPad" : "iPhone"}'s Settings, then Notifications, then Let Me Know, and turn on Allow Notifications. Then come back here.`
      : "Allow notifications for this site in the browser's site settings, then come back here."));
    return box;
  }
  if (st === "old") {
    title.textContent = "Alerts need a newer iOS";
    box.append(el("p", "alert-text", `Alerts need iOS 16.4 or later. Update ${here} in Settings, General, Software Update.`));
    return box;
  }
  if (st === "none") {
    title.textContent = "No alerts in this browser";
    box.append(el("p", "alert-text", "This browser can't get alerts. On an iPhone or iPad, open this page in Safari and add it to the Home Screen."));
    return box;
  }
  return null;
}

function renderAlertStep() {
  const slot = $("alert-step");
  const box = state.pcs.length || alertsNow === "install" ? alertStep(alertsNow) : null;
  slot.replaceChildren(...(box ? [box] : []));
  slot.hidden = !box;
}

// ---------- Add a PC ----------

function knownSuffix() {
  for (const p of state.pcs) {
    const s = tailnetSuffix(p.url);
    if (s) return s;
  }
  return "";
}

let typedFrom = false; // the pairing came from the typed form (errors go back there)

function addStep(name) {
  for (const id of ["scan-step", "type-form", "confirm-step", "done-step"]) $(id).hidden = id !== name;
  document.querySelector("#add [data-close]").textContent = name === "done-step" ? "Close" : "Cancel";
}

async function openAdd() {
  if (detailOf) detailOf = null;
  show("add");
  remember("add");
  message("");
  $("add-tip").hidden = supported !== "install";
  addStep("scan-step");
  $("scan-note").textContent = "Point the camera at the QR code in SMU or TabGod: Settings, Pair a phone.";
  const run = ++scanRun;
  // The camera can take a moment to start (or fail): by then the sheet may be closed or on another step.
  const current = () => run === scanRun && !$("add").hidden && !$("scan-step").hidden;
  try {
    const s = await startScan($("scan-video"), (text) => {
      const p = parsePairing(text);
      if (!p) {
        $("scan-note").textContent = "That isn't a Let Me Know code. Use the QR code in SMU or TabGod's Settings.";
        return false;
      }
      confirmPair(p);
      return true;
    });
    if (current()) scanner = s;
    else s.stop();
  } catch (e) {
    if (!current()) return;
    showTyped(e.message === "camera"
      ? "The camera isn't available. Allow it in Settings, or type the address and code shown under the QR code."
      : "Type the address and code shown under the QR code on the PC.");
  }
}

let scanRun = 0; // the latest camera start; an older one that finishes late is dropped

function stopScan() {
  scanRun++;
  if (scanner) scanner.stop();
  scanner = null;
}

function showTyped(note) {
  stopScan();
  addStep("type-form");
  $("type-note").textContent = note || "Type the address and code shown under the QR code on the PC.";
}

// After a scan: which PC this is, and one tap to pair (that tap also asks for alerts).
let scanned = null;
function confirmPair(p) {
  stopScan();
  scanned = p;
  const who = $("confirm-who");
  const line = el("div", "detail-line");
  line.append(appBadge(p.app || (/:8443$/.test(p.url) ? "tabgod" : "smu")), el("span", "detail-device", p.name || "This PC"));
  who.replaceChildren(line, el("span", "sub", p.url.replace(/^https?:\/\//, "")));
  message("");
  $("confirm-btn").dataset.label = p.name ? `Pair with ${p.name}` : "Pair";
  $("confirm-btn").textContent = $("confirm-btn").dataset.label;
  addStep("confirm-step");
  $("confirm-btn").focus();
}

function pairTap(p, fromTyped) {
  // The tap itself asks for alerts and, when the shared key is known from a PC paired before, subscribes: iOS does
  // both only inside a tap, and the pairing's network call comes first. The new PC gets the subscription after.
  const key = push.alertKey(state.pcs);
  const start = supported === "ok" ? push.startInTap({ N: window.Notification, reg: swReg, key })
    : { asked: Promise.resolve(permission()), subscribed: Promise.resolve(null) };
  start.inTap = supported === "ok" && !!swReg && !!key;
  typedFrom = fromTyped;
  doPair(p, start);
}

function pairBusy(on) {
  for (const id of ["pair-btn", "confirm-btn"]) {
    const b = $(id);
    b.disabled = on;
    b.textContent = on ? "Pairing…" : b.dataset.label || "Pair";
  }
}

async function doPair(p, start) {
  message("");
  pairBusy(true);
  try {
    const r = await api.pair(p.url, p.code, state.deviceName);
    if (!r || typeof r.token !== "string" || !r.token) throw new api.ApiError("http", 200);
    const app = APP_NAMES[r.app] ? r.app : p.app || (/:8443$/.test(p.url) ? "tabgod" : "smu");
    const vapid = typeof r.vapid_public_key === "string" ? r.vapid_public_key : "";
    const pc = {
      app, url: p.url, pc: (r.pc && r.pc.id) || p.pc || "", name: (r.pc && r.pc.name) || p.name || "",
      token: r.token, deviceId: r.device_id || "", vapid, pushEndpoint: "", pairedAt: Date.now(), rotatedAt: Date.now(),
    };
    state = store.upsertPc(state, pc);
    persist();
    pairBusy(false);
    const name = pc.name || "the PC";
    const otherKey = push.otherKeyPcs(state.pcs).some((x) => x.key === pcKeyOf(pc));
    $("done-title").textContent = `Paired with ${name}`;
    $("done-text").textContent = `${APP_NAMES[app]} on ${name} now shows here.`;
    $("done-alerts").replaceChildren(el("p", "muted", supported === "ok" ? "Turning on alerts…" : ""));
    addStep("done-step");
    $("done-btn").focus();
    if (!pollTimer) startPolling();
    else refresh();
    await Promise.all([start.asked, start.subscribed]);
    if (supported === "ok") await syncAlerts({ again: true, fromTap: start.inTap });
    else await refreshAlerts();
    const out = [];
    if (alertsNow === "on") out.push(el("p", "msg ok", otherKey
      ? `Alerts are on, but ${name} uses a different alert key from your other PCs, so its alerts can't reach this device.`
      : `Alerts are on. ${name} will let you know when it needs you.`));
    else {
      const step = alertStep(alertsNow);
      if (step) out.push(step);
    }
    $("done-alerts").replaceChildren(...out);
  } catch (e) {
    pairBusy(false);
    const text = {
      offline: "Can't reach that PC. Check the address, and that Tailscale is on here and on the PC.",
      code: "That code didn't work: it was used already, or it's over 10 minutes old. On the PC, open Pair a phone again for a new one.",
      slow: "Too many tries. Wait a minute, then try again.",
      full: "That PC already has 10 devices. Remove one in its Settings first.",
    }[e.kind] || "Pairing didn't work. Make a new code on the PC and try again.";
    if (typedFrom || !scanned) {
      showTyped();
      // A code problem: straight back to the code, ready to type a new one.
      const f = e.kind === "code" ? $("f-code") : e.kind === "offline" ? $("f-address") : null;
      if (f) {
        f.focus({ preventScroll: true });
        f.select();
      }
    } else addStep("confirm-step");
    message(text);
  }
}

function pcKeyOf(pc) {
  return store.pcKey(pc.app, pc.pc, pc.url);
}

function setupAdd() {
  $("show-type").addEventListener("click", () => showTyped());
  $("type-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const url = normalizeAddress($("f-address").value, knownSuffix());
    const code = normalizeCode($("f-code").value);
    if (!url) return message("Type the PC's address as shown on the PC, like zbook.tail1234.ts.net.");
    if (!code) return message("The code has 8 letters and numbers, like K7Q2-9XMP.");
    scanned = null;
    pairTap({ url, code, app: null, pc: "", name: "" }, true);
  });
  $("confirm-btn").addEventListener("click", () => scanned && pairTap(scanned, false));
  $("rescan-btn").addEventListener("click", () => openAdd());
  $("done-btn").addEventListener("click", goBack);
  $("f-code").addEventListener("input", (e) => {
    // XXXX-XXXX as it's typed
    const raw = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 8);
    const v = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
    if (v !== e.target.value) e.target.value = v;
  });
}

// ---------- Settings ----------

function renderAlertSettings() {
  const st = $("push-state"), btn = $("push-btn"), foot = $("push-foot"), test = $("test-row");
  btn.hidden = true;
  test.hidden = true;
  btn.disabled = false;
  const words = {
    on: "Alerts are on", off: "Alerts are off", blocked: "Alerts are blocked", install: "Alerts need the Home Screen app",
    old: "Alerts need iOS 16.4 or later", none: "No alerts in this browser", nopc: "Alerts are off", nokey: "Alerts are off",
  };
  st.textContent = words[alertsNow] || "Alerts are off";
  let note = "You get an alert when a PC needs you, or a run finishes or stops.";
  if (alertsNow === "off") btn.hidden = false;
  if (alertsNow === "on") test.hidden = false;
  if (alertsNow === "nopc") note = "Pair a PC first: alerts turn on as you pair.";
  if (alertsNow === "nokey") note = "Your PCs don't send alerts yet. Update SMU or TabGod on them.";
  if (alertsNow === "install") note = "In Safari tap Share, then Add to Home Screen, and open Let Me Know from there.";
  if (alertsNow === "blocked") note = ios() ? "Turn them on in Settings, Notifications, Let Me Know." : "Allow notifications for this site in the browser's settings.";
  const other = push.otherKeyPcs(state.pcs).map(pcName);
  if (other.length && alertsNow === "on") {
    note += ` ${[...new Set(other)].join(", ")} ${other.length === 1 ? "uses" : "use"} a different alert key, so ${other.length === 1 ? "its" : "their"} alerts can't reach this device.`;
  }
  foot.textContent = note;
}

function renderPcList() {
  const box = $("pc-list");
  box.replaceChildren();
  if (!state.pcs.length) {
    box.append(el("div", "row muted", "No PCs paired yet."));
    return;
  }
  const other = new Set(push.otherKeyPcs(state.pcs).map((p) => p.key));
  // One heading per PC, then each app on it with its address and buttons.
  const sorted = [...state.pcs].sort((a, b) => pcName(a).localeCompare(pcName(b), "en", { numeric: true })
    || (a.pc || "").localeCompare(b.pc || "") || (a.app === "smu" ? -1 : 1));
  let lastPc = null;
  for (const pc of sorted) {
    const id = pc.pc || pcName(pc);
    if (id !== lastPc) {
      lastPc = id;
      const head = el("div", "row pc-list-head");
      const icon = el("span", "pc-icon");
      icon.append(svg(PC_GLYPH));
      head.append(icon, el("span", "row-name", pcName(pc)));
      box.append(head);
    }
    const row = el("div", "row pc-row");
    const txt = el("div", "row-text");
    const line = el("div", "detail-line");
    line.append(appBadge(pc.app), el("span", "sub", pc.url.replace(/^https?:\/\//, "")));
    txt.append(line);
    if (other.has(pc.key)) txt.append(el("span", "sub warn", "Different alert key: its alerts can't reach this device"));
    const actions = el("div", "row-actions");
    actions.append(
      button("Devices", "btn small ghost", (e) => toggleDevices(pc, row, e.currentTarget)),
      button("Remove", "btn small danger", () => removePc(pc)),
    );
    row.append(txt, actions);
    box.append(row);
  }
}

async function toggleDevices(pc, row, btn) {
  const next = row.nextElementSibling;
  if (next && next.classList.contains("devs")) {
    btn.setAttribute("aria-expanded", "false");
    return next.remove();
  }
  btn.setAttribute("aria-expanded", "true");
  const box = el("div", "devs");
  box.append(el("p", "muted", "Loading…"));
  row.after(box);
  try {
    const r = await pcApi.devices(pc);
    box.replaceChildren();
    for (const d of Array.isArray(r.devices) ? r.devices : []) {
      const line = el("div", "row");
      const name = typeof d.name === "string" ? d.name.slice(0, 40) : "Device";
      const label = el("span", null, d.me ? `${name} (this one)` : name);
      label.append(el("span", "sub", d.push ? "Gets alerts" : "No alerts"));
      line.append(label);
      if (!d.me) {
        line.append(button("Remove", "btn small danger", async () => {
          if (!confirm(`Remove ${name} from ${pcName(pc)}? It stops getting status and alerts from this PC.`)) return;
          try {
            await pcApi.removeDevice(pc, String(d.id));
            line.remove();
          } catch {
            alert(`Couldn't remove ${name}. Check that ${pcName(pc)} is reachable.`);
          }
        }));
      }
      box.append(line);
    }
    if (!box.children.length) box.append(el("p", "muted", "No devices."));
  } catch {
    box.replaceChildren(el("p", "muted", `Can't reach ${pcName(pc)} right now.`));
  }
}

async function removePc(pc) {
  const name = pcName(pc);
  if (!confirm(`Remove ${name} (${APP_NAMES[pc.app]})? This device stops showing it and getting its alerts.`)) return;
  let told = true;
  try {
    await pcApi.removeDevice(pc, "me");
  } catch (e) {
    told = e.kind === "token";
  }
  state = store.removePc(state, pc.key);
  live.delete(pc.key);
  persist();
  persistLast();
  renderPcList();
  refreshAlerts();
  if (!told) alert(`${name} couldn't be reached. Also remove ${state.deviceName} in ${APP_NAMES[pc.app]}'s Settings on that PC.`);
}

function openSettings(push = true, back = false) {
  $("device-name").value = state.deviceName;
  $("about").textContent = `Let Me Know ${VERSION}`;
  renderPcList();
  refreshAlerts();
  applyTheme();
  show("settings", back);
  if (push) remember("settings");
}

function setupSettings() {
  $("open-settings").addEventListener("click", () => openSettings());
  $("open-add").addEventListener("click", openAdd);
  $("push-btn").addEventListener("click", (e) => turnOnAlerts(e.currentTarget));
  $("test-btn").addEventListener("click", async () => {
    const b = $("test-btn");
    b.disabled = true;
    const ready = state.pcs.filter((p) => p.pushEndpoint && p.pushEndpoint === knownEndpoint);
    const pc = ready.find((p) => !live.get(p.key)?.error) || ready[0] || state.pcs[0];
    try {
      await pcApi.testPush(pc);
      b.textContent = "Sent";
    } catch {
      b.textContent = "Failed";
    }
    setTimeout(() => {
      b.textContent = "Send";
      b.disabled = false;
    }, 2500);
  });
  $("device-name").addEventListener("change", async (e) => {
    const name = e.target.value.trim().slice(0, 40);
    if (!name) {
      e.target.value = state.deviceName;
      return;
    }
    state = { ...state, deviceName: name };
    persist();
    await Promise.all(state.pcs.map((pc) => pcApi.setMe(pc, { name }).catch(() => {})));
  });
  for (const b of document.querySelectorAll("[data-theme-pick]")) {
    b.addEventListener("click", () => {
      state = { ...state, theme: b.dataset.themePick };
      persist();
      applyTheme();
    });
  }
}

// ---------- Service worker, updates ----------

async function setupWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    swReg = await navigator.serviceWorker.register("sw.js", { scope: "./", updateViaCache: "none" });
  } catch {
    return null;
  }
  const offer = (w) => {
    if (!w) return;
    $("update").hidden = false;
    $("update-btn").onclick = () => {
      updating = true;
      w.postMessage("skip-waiting");
    };
  };
  if (swReg.waiting && navigator.serviceWorker.controller) offer(swReg.waiting);
  swReg.addEventListener("updatefound", () => {
    const w = swReg.installing;
    w?.addEventListener("statechange", () => {
      if (w.state === "installed" && navigator.serviceWorker.controller) offer(w);
    });
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!updating) return; // the first install taking over: nothing to reload
    updating = false;
    location.reload();
  });
  // From the worker: an alert was tapped (open that PC/task), or one arrived (refresh now).
  navigator.serviceWorker.addEventListener("message", (e) => {
    const d = e.data || {};
    if (d.type === "open" && typeof d.pc === "string") {
      pendingOpen = { pc: d.pc, app: String(d.app || ""), task: String(d.task || ""), until: Date.now() + 30_000 };
      if (!$("add").hidden || !$("settings").hidden) show("home");
      refresh();
    } else if (d.type === "refresh" && state.pcs.length) refresh();
  });
  setInterval(() => swReg.update().catch(() => {}), 30 * 60 * 1000);
  swReg.update().catch(() => {});
  return swReg;
}

function onOpen() {
  if (state.pcs.length) startPolling();
  swReg?.update().catch(() => {});
  // Every open: permission may have changed in Settings, the subscription may have gone or moved, or a PC may have
  // dropped it. Subscribing here happens only where permission is already granted.
  syncAlerts({ check: true });
}

function init() {
  persist();
  // A reload starts on the list: forget a screen the page was on before it. The app puts the list's scroll back
  // itself (show), so the browser's own restoring on back must not undo it.
  try {
    history.scrollRestoration = "manual";
    if (history.state && history.state.lmk) history.replaceState(null, "", location.pathname + location.search);
  } catch {
    // no history here
  }
  applyTheme();
  setupAdd();
  setupSettings();
  setupPull();
  for (const b of document.querySelectorAll("[data-close]")) b.addEventListener("click", goBack);
  setupDetail();
  document.addEventListener("click", (e) => {
    if (e.target.closest("#settings [data-add]")) openAdd();
  });
  try {
    navigator.storage?.persist?.();
  } catch {
    // best effort
  }
  render();
  // With permission granted, whether alerts are on depends on the subscription: wait for syncAlerts rather than
  // flash a "Turn on alerts" step that goes away a moment later.
  if (!(supported === "ok" && permission() === "granted")) refreshAlerts(null, null);
  setInterval(tick, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPolling();
    else onOpen();
  });
  swReady = setupWorker();
  onOpen();
}

init();
