// The in-app QR scanner: the back camera in a <video>, read a few times a second. Decoder: BarcodeDetector where the
// browser has it, else jsQR from vendor/jsqr.js when that file is there. Safari has no BarcodeDetector.

let jsqrLoad = null;

function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!jsqrLoad) {
    jsqrLoad = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "vendor/jsqr.js";
      s.onload = () => resolve(window.jsQR || null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  }
  return jsqrLoad;
}

async function makeDecoder() {
  if ("BarcodeDetector" in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes("qr_code")) {
        const det = new window.BarcodeDetector({ formats: ["qr_code"] });
        return async (video) => {
          const found = await det.detect(video);
          return found.length ? found[0].rawValue : null;
        };
      }
    } catch {
      // fall through to jsQR
    }
  }
  const jsQR = await loadJsQR();
  if (!jsQR) return null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return async (video) => {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return null;
    const scale = Math.min(1, 720 / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
    return code ? code.data : null;
  };
}

export async function canScan() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && !!(await makeDecoder());
}

// Starts the camera in `video`; onText(text) for every code read (it returns true to stop). Throws "camera" when the
// camera can't be used, "decoder" when there is nothing to read codes with.
export async function startScan(video, onText) {
  const decode = await makeDecoder();
  if (!decode) throw new Error("decoder");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
  } catch {
    throw new Error("camera");
  }
  video.setAttribute("playsinline", "");
  video.muted = true;
  video.srcObject = stream;
  await video.play().catch(() => {});
  let stopped = false, busy = false;
  const timer = setInterval(async () => {
    if (stopped || busy || video.readyState < 2) return;
    busy = true;
    try {
      const text = await decode(video);
      if (text && !stopped && onText(text)) stop();
    } catch {
      // a frame that can't be read: try the next one
    } finally {
      busy = false;
    }
  }, 250);
  function stop() {
    stopped = true;
    clearInterval(timer);
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
  }
  return { stop };
}
