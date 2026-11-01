// Screenshots of the app against dev/mock_pc.py, in headless Edge: iPhone and iPad sizes, light and dark.
//   python letmeknow/dev/mock_pc.py          (in another terminal)
//   node letmeknow/dev/screens.mjs <out dir>
// Also checks the service worker installs and caches the app shell. The Edge profile is a temp folder, removed after.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = process.env.EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const SITE = "http://localhost:8765/letmeknow/";
const PCS = [8791, 8792, 8793];
const PORT = 9333;
const out = process.argv[2] || "lmk_shots";
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "lmk-edge-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });

let ws, id = 0;
const waiting = new Map();
function send(method, params = {}) {
  const n = ++id;
  ws.send(JSON.stringify({ id: n, method, params }));
  return new Promise((resolve, reject) => waiting.set(n, { resolve, reject }));
}
async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate failed");
  return r.result.value;
}
async function go(url) {
  await send("Page.navigate", { url });
  await sleep(2500);
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Edge still starting
    }
    await sleep(250);
  }
  throw new Error("Edge did not start");
}

async function view(name, w, h, ua, scheme, script = "") {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: true });
  await send("Emulation.setUserAgentOverride", { userAgent: ua });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await go(SITE);
  if (script) {
    await evaluate(script);
    await sleep(800);
  }
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(out, `${name}.png`), Buffer.from(shot.data, "base64"));
  console.log("saved", name);
}

try {
  ws = new WebSocket(await connect());
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
    }
  });
  await send("Page.enable");
  await send("Runtime.enable");

  await view("iphone-empty-light", 390, 844, IPHONE_UA, "light");

  // Pair the three test PCs through the app's own typed-code form.
  for (const port of PCS) {
    const { code } = await (await fetch(`http://localhost:${port}/dev/code`)).json();
    const msg = await evaluate(`(async () => {
      document.querySelector("[data-add]").click();
      await new Promise((r) => setTimeout(r, 400));
      document.getElementById("f-address").value = "http://localhost:${port}";
      document.getElementById("f-code").value = ${JSON.stringify(code)};
      document.getElementById("type-form").requestSubmit();
      await new Promise((r) => setTimeout(r, 2000));
      return document.getElementById("add-msg").textContent;
    })()`);
    console.log(`pair :${port}:`, msg);
  }

  const sw = await evaluate(`(async () => {
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 5000))]);
    const keys = await caches.keys();
    const n = keys.length ? (await (await caches.open(keys[0])).keys()).length : 0;
    return { active: !!(reg && reg.active), caches: keys, entries: n };
  })()`);
  console.log("service worker:", JSON.stringify(sw));

  const smu = `document.getElementById("tab-smu").click()`;
  const tg = `document.getElementById("tab-tabgod").click()`;
  const settings = `document.getElementById("open-settings").click()`;
  const add = `document.querySelector(".add-more").click()`;
  for (const scheme of ["light", "dark"]) {
    await view(`iphone-smu-${scheme}`, 390, 844, IPHONE_UA, scheme, smu);
    await view(`ipad-smu-${scheme}`, 820, 1180, IPAD_UA, scheme, smu);
  }
  await view("iphone-tabgod-light", 390, 844, IPHONE_UA, "light", tg);
  await view("iphone-settings-light", 390, 844, IPHONE_UA, "light", settings);
  await view("iphone-settings-dark", 390, 844, IPHONE_UA, "dark", settings);
  await view("iphone-add-dark", 390, 844, IPHONE_UA, "dark", add);
} finally {
  try {
    ws?.close();
  } catch {
    // already closed
  }
  edge.kill();
  await sleep(1500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
