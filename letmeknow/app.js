// Let Me Know: the status of SMU and TabGod on each paired PC, and alerts when one needs you.
import * as api from "./lib/api.mjs";
import * as store from "./lib/store.mjs";
import { startScan } from "./lib/scan.mjs";
import {
  APP_NAMES, agoText, b64urlToBytes, guessDeviceName, needsYouCount, normalizeAddress, normalizeCode,
  normalizeStatus, parsePairing, sortTasks, tailnetSuffix, timeLine,
} from "./lib/status.mjs";

export const VERSION = "1.0.0";
const POLL_MS = 10_000;
const ROTATE_MS = 30 * 24 * 3600 * 1000;

const $ = (id) => document.getElementById(id);
let state = store.load();
if (!state.deviceName) state.deviceName = guessDeviceName(navigator.userAgent, navigator.maxTouchPoints || 0);
const live = new Map(); // pc key -> { status, fetchedAt, okAt, error }
let tab = new URLSearchParams(location.search).get("tab") || readTab();
if (!APP_NAMES[tab]) tab = "smu";
let pollTimer = 0;
let scanner = null;
let swReg = null;
let updating = false;

function readTab() {
  try {
    return localStorage.getItem("lmk.tab") || "smu";
  } catch {
    return "smu";
  }
}

function persist() {
  store.save(state);
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

function pcName(pc) {
  const l = live.get(pc.key);
  return (l && l.status && l.status.device.name) || pc.name || pc.url.replace(/^https?:\/\//, "").split(".")[0];
}

// ---------- Home ----------

function renderTabs() {
  for (const b of document.querySelectorAll(".tabs button")) {
    const app = b.dataset.app;
    b.setAttribute("aria-selected", String(app === tab));
    const n = needsYouCount(state.pcs.filter((p) => p.app === app).map((p) => live.get(p.key)?.status));
    b.querySelector(".dot").hidden = n === 0;
  }
}

function emptyState(title, text) {
  const node = $("empty-tpl").content.cloneNode(true);
  node.querySelector("h2").textContent = title;
  node.querySelector("p").textContent = text;
  node.querySelector("[data-add]").addEventListener("click", openAdd);
  return node;
}

function taskNode(t, fetchedAt) {
  const finished = t.left === 0 && !t.running && !t.needsYou;
  const n = el("div", finished ? "task finished" : "task");
  const head = el("div", "task-head");
  head.append(el("span", "task-name", t.name));
  if (t.needsYou) head.append(el("span", "chip red", "Needs you"));
  else if (t.running) head.append(el("span", "chip", "Running now"));
  else if (finished) head.append(el("span", "done-line", `${t.done ?? 0} done${t.failed ? `, ${t.failed} failed` : ""}`));
  n.append(head);
  const nums = el("div", "nums");
  for (const [label, v, bad] of [["Done", t.done], ["Failed", t.failed, true], ["Left", t.left]]) {
    const box = el("div", bad && v ? "num bad" : "num");
    box.append(el("b", null, v == null ? "–" : String(v)), el("span", null, label));
    nums.append(box);
  }
  n.append(nums);
  const eta = el("p", "eta", timeLine(t, Date.now(), fetchedAt));
  eta.dataset.task = t.id;
  n.append(eta);
  return n;
}

function pcCard(pc) {
  const l = live.get(pc.key) || {};
  const s = l.status;
  const card = el("article", "card pc");
  card.dataset.key = pc.key;
  const head = el("div", "pc-head");
  head.append(el("h2", "pc-name", pcName(pc)));
  let pill;
  if (l.error === "offline") pill = el("span", "pill warn", "Can't reach");
  else if (l.error === "token") pill = el("span", "pill warn", "Not paired");
  else if (s && s.device.active) pill = el("span", "pill on", "Active now");
  else if (s) pill = el("span", "pill", "Idle");
  else pill = el("span", "pill", "Loading");
  head.append(pill);
  card.append(head);
  const sub = el("p", "pc-sub", "");
  sub.dataset.ago = "1";
  card.append(sub);

  if (l.error === "token") {
    const w = el("div", "warnbox", `This device is no longer paired with ${pcName(pc)}.`);
    w.append(el("br"), button("Pair again", "btn small ghost", openAdd));
    card.append(w);
    return card;
  }
  if (l.error === "offline") {
    card.append(el("div", "warnbox", `Can't reach ${pcName(pc)}. Check that Tailscale is on, here and on the PC.`));
    if (s) card.classList.add("stale");
  } else if (l.error) {
    card.append(el("div", "warnbox", `${pcName(pc)} answered with an error. Trying again.`));
    if (s) card.classList.add("stale");
  }
  if (!s) return card;

  for (const t of s.tasks.filter((x) => x.needsYou)) {
    const b = el("div", "needs");
    const txt = el("div", null, `Needs you: ${t.reason || "open the app on the PC"}`);
    txt.append(el("small", null, t.name));
    b.append(txt);
    card.append(b);
  }
  if (!s.tasks.length) card.append(el("p", "eta", "No tasks on this PC."));
  for (const t of sortTasks(s.tasks)) card.append(taskNode(t, l.fetchedAt));
  return card;
}

function renderList() {
  const list = $("list");
  list.replaceChildren();
  const pcs = state.pcs.filter((p) => p.app === tab);
  if (!state.pcs.length) {
    list.append(emptyState("No PCs yet", "Pair Let Me Know with SMU or TabGod on your PC to see its status here."));
  } else if (!pcs.length) {
    list.append(emptyState(`No PCs with ${APP_NAMES[tab]} yet`, `On the PC, open ${APP_NAMES[tab]}'s Settings and choose Pair a phone.`));
  } else {
    const order = (p) => {
      const s = live.get(p.key)?.status;
      return s ? (needsYouCount([s]) ? 0 : s.device.active ? 1 : 2) : 3;
    };
    for (const pc of [...pcs].sort((a, b) => order(a) - order(b))) list.append(pcCard(pc));
    const more = button("Add a PC", "btn ghost wide add-more", openAdd);
    list.append(more);
  }
  tick();
}

function render() {
  renderTabs();
  renderList();
  badge();
}

// Every second: the countdowns and "updated ... ago", without rebuilding the cards.
function tick() {
  const now = Date.now();
  for (const card of document.querySelectorAll(".pc")) {
    const l = live.get(card.dataset.key);
    const sub = card.querySelector("[data-ago]");
    if (sub) sub.textContent = l && l.okAt ? `Updated ${agoText(now - l.okAt)}` : l && l.error ? "Not updated yet" : "Connecting…";
    if (!l || !l.status) continue;
    for (const p of card.querySelectorAll(".eta[data-task]")) {
      const t = l.status.tasks.find((x) => x.id === p.dataset.task);
      if (t) p.textContent = timeLine(t, now, l.fetchedAt);
    }
  }
}

function badge() {
  const n = needsYouCount(state.pcs.map((p) => live.get(p.key)?.status));
  try {
    if (n && navigator.setAppBadge) navigator.setAppBadge(n);
    else if (navigator.clearAppBadge) navigator.clearAppBadge();
  } catch {
    // no badge support
  }
}

// ---------- Fetching ----------

async function fetchPc(pc) {
  const prev = live.get(pc.key) || {};
  try {
    const raw = await api.status(pc);
    const now = Date.now();
    const status = normalizeStatus(raw);
    live.set(pc.key, { status, fetchedAt: now, okAt: now, error: "" });
    if (status.device.name && status.device.name !== pc.name) {
      state = store.updatePc(state, pc.key, { name: status.device.name });
      persist();
    }
    if (!pc.rotatedAt || now - pc.rotatedAt > ROTATE_MS) rotateToken(pc);
  } catch (e) {
    live.set(pc.key, { ...prev, error: e.kind || "http" });
  }
}

async function rotateToken(pc) {
  try {
    const r = await api.rotate(pc);
    if (r && typeof r.token === "string" && r.token) {
      state = store.updatePc(state, pc.key, { token: r.token, rotatedAt: Date.now() });
    } else {
      state = store.updatePc(state, pc.key, { rotatedAt: Date.now() });
    }
  } catch (e) {
    if (e.kind === "http" && e.status === 404) state = store.updatePc(state, pc.key, { rotatedAt: Date.now() });
  }
  persist();
}

let refreshing = null;
async function refresh() {
  if (!refreshing) {
    refreshing = Promise.all(state.pcs.map(fetchPc)).then(() => {
      refreshing = null;
      render();
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

// Pull to refresh: drag down from the top of the page.
function setupPull() {
  const pull = $("pull");
  let y0 = null, armed = false;
  addEventListener("touchstart", (e) => {
    y0 = scrollY <= 0 && !$("home").hidden ? e.touches[0].clientY : null;
    armed = false;
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (y0 == null) return;
    const dy = e.touches[0].clientY - y0;
    armed = dy > 70;
    pull.classList.toggle("on", dy > 20);
  }, { passive: true });
  addEventListener("touchend", async () => {
    if (y0 == null) return;
    y0 = null;
    if (!armed) {
      pull.classList.remove("on");
      return;
    }
    pull.classList.add("on", "busy");
    await refresh();
    pull.classList.remove("on", "busy");
  });
}

// ---------- Views ----------

function show(id) {
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== id;
  scrollTo(0, 0);
  if (id !== "add") stopScan();
}

function closeSheet() {
  show("home");
  render();
}

function message(text, ok = false) {
  const m = $("add-msg");
  m.textContent = text;
  m.classList.toggle("ok", ok);
  m.hidden = !text;
}

// ---------- Add a PC ----------

function knownSuffix() {
  for (const p of state.pcs) {
    const s = tailnetSuffix(p.url);
    if (s) return s;
  }
  return "";
}

async function openAdd() {
  show("add");
  message("");
  $("pair-btn").disabled = false;
  $("type-form").hidden = true;
  $("show-type").hidden = false;
  $("scan-box").hidden = false;
  $("scan-note").textContent = "Point the camera at the QR code in SMU or TabGod: Settings, Pair a phone.";
  try {
    scanner = await startScan($("scan-video"), (text) => {
      const p = parsePairing(text);
      if (!p) {
        $("scan-note").textContent = "That isn't a Let Me Know code. Use the QR code in SMU or TabGod's Settings.";
        return false;
      }
      doPair(p);
      return true;
    });
  } catch (e) {
    showTyped(e.message === "camera"
      ? "The camera isn't available. Allow it in Settings, or type the address and code shown under the QR code."
      : "Type the address and code shown under the QR code on the PC.");
  }
}

function stopScan() {
  if (scanner) scanner.stop();
  scanner = null;
}

function showTyped(note) {
  stopScan();
  $("scan-box").hidden = true;
  $("show-type").hidden = true;
  $("type-form").hidden = false;
  if (note) $("type-note").textContent = note;
}

async function doPair(p) {
  stopScan();
  message("Pairing…", true);
  $("pair-btn").disabled = true;
  try {
    const r = await api.pair(p.url, p.code, state.deviceName);
    if (!r || typeof r.token !== "string" || !r.token) throw new api.ApiError("http", 200);
    const app = APP_NAMES[r.app] ? r.app : p.app || (/:8443$/.test(p.url) ? "tabgod" : "smu");
    const vapid = typeof r.vapid_public_key === "string" ? r.vapid_public_key : "";
    const others = state.pcs.map((x) => x.vapid).filter(Boolean);
    const pc = {
      app, url: p.url, pc: (r.pc && r.pc.id) || p.pc || "", name: (r.pc && r.pc.name) || p.name || "",
      token: r.token, deviceId: r.device_id || "", vapid, pushEndpoint: "", pairedAt: Date.now(), rotatedAt: Date.now(),
    };
    state = store.upsertPc(state, pc);
    persist();
    tab = app;
    saveTab();
    const name = pc.name || "the PC";
    let note = `Paired with ${name}.`;
    if (vapid && others.length && !others.includes(vapid)) {
      note += ` Alerts from ${name} can't reach this device: it uses a different alert key from your other PCs.`;
    }
    message(note, true);
    syncPush();
    if (!pollTimer) startPolling();
    await refresh();
    setTimeout(() => {
      if (!$("add").hidden) closeSheet();
    }, 900);
  } catch (e) {
    $("pair-btn").disabled = false;
    const text = {
      offline: "Can't reach that PC. Check the address, and that Tailscale is on here and on the PC.",
      code: "That code didn't work. It may have been used or be out of date: make a new one on the PC.",
      slow: "Too many tries. Wait a minute, then try again.",
      full: "That PC already has 10 devices. Remove one in its Settings first.",
    }[e.kind] || "Pairing didn't work. Make a new code on the PC and try again.";
    showTyped();
    message(text);
  }
}

function setupAdd() {
  $("show-type").addEventListener("click", () => showTyped());
  $("type-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const url = normalizeAddress($("f-address").value, knownSuffix());
    const code = normalizeCode($("f-code").value);
    if (!url) return message("Type the PC's address as shown on the PC, like zbook.tail1234.ts.net.");
    if (!code) return message("The code has 8 letters and numbers, like K7Q2-9XMP.");
    doPair({ url, code, app: null, pc: "", name: "" });
  });
}

// ---------- Settings ----------

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function currentSub() {
  if (!swReg || !pushSupported()) return null;
  try {
    return await swReg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

function alertKey() {
  const p = state.pcs.find((x) => x.vapid);
  return p ? p.vapid : "";
}

function sameKey(sub, vapid) {
  try {
    const a = new Uint8Array(sub.options.applicationServerKey || []);
    const b = b64urlToBytes(vapid);
    return a.length === b.length && a.every((v, i) => v === b[i]);
  } catch {
    return false;
  }
}

// Gives every PC that signs with this device's alert key the current subscription, when it changed.
async function syncPush() {
  const sub = await currentSub();
  if (!sub) return;
  const json = sub.toJSON();
  for (const pc of state.pcs) {
    if (!pc.vapid || !sameKey(sub, pc.vapid) || pc.pushEndpoint === sub.endpoint) continue;
    try {
      await api.setMe(pc, { push: json });
      state = store.updatePc(state, pc.key, { pushEndpoint: sub.endpoint });
      persist();
    } catch {
      // tried again next time the app opens
    }
  }
}

async function turnOnAlerts() {
  const vapid = alertKey();
  if (!vapid || !swReg) return;
  $("push-btn").disabled = true;
  try {
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      let sub = await currentSub();
      if (sub && !sameKey(sub, vapid)) {
        await sub.unsubscribe();
        sub = null;
      }
      if (!sub) await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(vapid) });
      state = { ...state, pcs: state.pcs.map((p) => ({ ...p, pushEndpoint: "" })) };
      persist();
      await syncPush();
    }
  } catch {
    // shown by renderAlerts below
  }
  $("push-btn").disabled = false;
  renderAlerts();
}

async function renderAlerts() {
  const st = $("push-state"), btn = $("push-btn"), foot = $("push-foot"), test = $("test-row");
  btn.hidden = false;
  test.hidden = true;
  btn.disabled = false;
  foot.textContent = "You get an alert when a PC needs you, or a run finishes or stops.";
  if (!pushSupported()) {
    st.textContent = "Alerts need the Home Screen app";
    btn.hidden = true;
    foot.textContent = "In Safari tap Share, then Add to Home Screen, and open Let Me Know from there.";
    return;
  }
  if (Notification.permission === "denied") {
    st.textContent = "Alerts are blocked";
    btn.hidden = true;
    foot.textContent = "Turn them on in the device's Settings, Notifications, Let Me Know.";
    return;
  }
  const sub = await currentSub();
  if (Notification.permission === "granted" && sub) {
    st.textContent = "Alerts are on";
    btn.hidden = true;
    test.hidden = !state.pcs.length;
    return;
  }
  st.textContent = "Alerts are off";
  if (!alertKey()) {
    btn.disabled = true;
    foot.textContent = "Pair a PC first, then turn alerts on.";
  }
}

function renderPcList() {
  const box = $("pc-list");
  box.replaceChildren();
  if (!state.pcs.length) {
    box.append(el("div", "row", "No PCs paired yet."));
    return;
  }
  for (const pc of state.pcs) {
    const row = el("div", "row");
    const txt = el("div", null, pcName(pc));
    txt.append(el("span", "sub", `${APP_NAMES[pc.app] || "App"} · ${pc.url.replace(/^https?:\/\//, "")}`));
    const actions = el("div", "row-actions");
    actions.append(
      button("Devices", "btn small ghost", () => toggleDevices(pc, row)),
      button("Remove", "btn small danger", () => removePc(pc)),
    );
    row.append(txt, actions);
    box.append(row);
  }
}

async function toggleDevices(pc, row) {
  const next = row.nextElementSibling;
  if (next && next.classList.contains("devs")) return next.remove();
  const box = el("div", "devs");
  box.append(el("p", "muted", "Loading…"));
  row.after(box);
  try {
    const r = await api.devices(pc);
    box.replaceChildren();
    for (const d of Array.isArray(r.devices) ? r.devices : []) {
      const line = el("div", "row");
      const name = typeof d.name === "string" ? d.name.slice(0, 40) : "Device";
      line.append(el("span", null, d.me ? `${name} (this one)` : name));
      if (!d.me) {
        line.append(button("Remove", "btn small danger", async () => {
          if (!confirm(`Remove ${name} from ${pcName(pc)}? It stops getting status and alerts from this PC.`)) return;
          try {
            await api.removeDevice(pc, String(d.id));
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
    await api.removeDevice(pc, "me");
  } catch (e) {
    told = e.kind === "token";
  }
  state = store.removePc(state, pc.key);
  live.delete(pc.key);
  persist();
  renderPcList();
  renderAlerts();
  if (!told) alert(`${name} couldn't be reached. Also remove ${state.deviceName} in ${APP_NAMES[pc.app]}'s Settings on that PC.`);
}

function openSettings() {
  $("device-name").value = state.deviceName;
  $("about").textContent = `Let Me Know ${VERSION}`;
  renderPcList();
  renderAlerts();
  show("settings");
}

function setupSettings() {
  $("open-settings").addEventListener("click", openSettings);
  $("push-btn").addEventListener("click", turnOnAlerts);
  $("test-btn").addEventListener("click", async () => {
    const b = $("test-btn");
    b.disabled = true;
    const pc = state.pcs.find((p) => p.vapid && p.pushEndpoint) || state.pcs[0];
    try {
      await api.testPush(pc);
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
    await Promise.all(state.pcs.map((pc) => api.setMe(pc, { name }).catch(() => {})));
  });
}

// ---------- Service worker, updates ----------

async function setupWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    swReg = await navigator.serviceWorker.register("sw.js", { scope: "./", updateViaCache: "none" });
  } catch {
    return;
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
  setInterval(() => swReg.update().catch(() => {}), 30 * 60 * 1000);
  swReg.update().catch(() => {});
  syncPush();
}

function saveTab() {
  try {
    localStorage.setItem("lmk.tab", tab);
  } catch {
    // remembered for this session only
  }
}

function setupTabs() {
  for (const b of document.querySelectorAll(".tabs button")) {
    b.addEventListener("click", () => {
      tab = b.dataset.app;
      saveTab();
      render();
    });
  }
}

function isIosSafariTab() {
  const ios = /iPhone|iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return ios && !navigator.standalone && !matchMedia("(display-mode: standalone)").matches;
}

function init() {
  persist();
  setupTabs();
  setupAdd();
  setupSettings();
  setupPull();
  for (const b of document.querySelectorAll("[data-close]")) b.addEventListener("click", closeSheet);
  document.addEventListener("click", (e) => {
    if (e.target.closest("#settings [data-add]")) openAdd();
  });
  $("install-hint").hidden = !isIosSafariTab();
  try {
    navigator.storage?.persist?.();
  } catch {
    // best effort
  }
  render();
  if (state.pcs.length) startPolling();
  setInterval(tick, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPolling();
    else {
      if (state.pcs.length) startPolling();
      swReg?.update().catch(() => {});
    }
  });
  setupWorker();
}

init();
