// What this device remembers, in localStorage on the site's origin (an installed Home Screen app has its own copy).
// { v: 1, deviceName, pcs: [{ key, app, url, pc, name, token, deviceId, vapid, pushEndpoint, pairedAt, rotatedAt }] }

const KEY = "lmk.v1";

function blank() {
  return { v: 1, deviceName: "", pcs: [] };
}

export function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && s.v === 1 && Array.isArray(s.pcs)) return { ...blank(), ...s };
  } catch {
    // unreadable or blocked storage: start empty
  }
  return blank();
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

// One entry per PC and app: pairing the same PC's SMU again replaces the old entry.
export function pcKey(app, pcId, url) {
  return `${app || "?"}:${pcId || url}`;
}

export function upsertPc(state, pc) {
  const key = pcKey(pc.app, pc.pc, pc.url);
  const pcs = state.pcs.filter((p) => p.key !== key);
  pcs.push({ ...pc, key });
  return { ...state, pcs };
}

export function removePc(state, key) {
  return { ...state, pcs: state.pcs.filter((p) => p.key !== key) };
}

export function updatePc(state, key, patch) {
  return { ...state, pcs: state.pcs.map((p) => (p.key === key ? { ...p, ...patch } : p)) };
}
