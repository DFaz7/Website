// Calls to a PC's Let Me Know API (PROTOCOL.md). Every call has a time limit: a PC that's off or off the tailnet
// must not hang the screen.

export class ApiError extends Error {
  constructor(kind, status = 0, data = null) {
    super(kind);
    this.kind = kind; // "offline" | "token" | "code" | "slow" | "full" | "http"
    this.status = status;
    this.data = data;
  }
}

async function call(base, path, { method = "GET", token = "", body, ms = 7000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
    });
  } catch {
    throw new ApiError("offline");
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.ok) return data || {};
  const err = data && data.error;
  if (res.status === 401) throw new ApiError("token", 401, data);
  if (res.status === 403 && err === "code") throw new ApiError("code", 403, data);
  if (res.status === 429) throw new ApiError("slow", 429, data);
  if (res.status === 409 && err === "full") throw new ApiError("full", 409, data);
  throw new ApiError("http", res.status, data);
}

export const pair = (base, code, deviceName) =>
  call(base, "/v1/pair", { method: "POST", body: { code, device_name: deviceName }, ms: 10000 });
export const status = (pc) => call(pc.url, "/v1/status", { token: pc.token });
export const setMe = (pc, body) => call(pc.url, "/v1/devices/me", { method: "PUT", token: pc.token, body });
export const devices = (pc) => call(pc.url, "/v1/devices", { token: pc.token });
export const removeDevice = (pc, id) =>
  call(pc.url, `/v1/devices/${encodeURIComponent(id)}`, { method: "DELETE", token: pc.token });
export const testPush = (pc) => call(pc.url, "/v1/devices/me/test", { method: "POST", token: pc.token, body: {} });
export const rotate = (pc) => call(pc.url, "/v1/token/rotate", { method: "POST", token: pc.token, body: {} });
