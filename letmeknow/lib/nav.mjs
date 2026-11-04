// Screens as history entries: what each entry holds, and which screen an entry brings back (on the phone's back
// gesture or button, or forward). Pure, so node --test covers it.

// The history state for a screen: { lmk: "add" | "settings" } or { lmk: "detail", key, taskId, view }.
export function entryFor(screen, args = {}) {
  if (screen === "detail") {
    return { lmk: "detail", key: String(args.key || ""), taskId: String(args.taskId || ""), view: args.view === "quefix" ? "quefix" : "task" };
  }
  return screen === "add" || screen === "settings" ? { lmk: screen } : null;
}

// The screen an entry names: { screen: "home" | "add" | "settings" } or
// { screen: "detail", key, taskId, view }. A detail for a PC that is no longer paired, or anything unknown, is home.
export function screenFor(entry, pcKeys) {
  const s = entry && typeof entry === "object" ? entry : {};
  if (s.lmk === "detail" && typeof s.key === "string" && pcKeys.includes(s.key)) {
    return { screen: "detail", key: s.key, taskId: typeof s.taskId === "string" ? s.taskId : "", view: s.view === "quefix" ? "quefix" : "task" };
  }
  if (s.lmk === "add" || s.lmk === "settings") return { screen: s.lmk };
  return { screen: "home" };
}

// Whether showing `next` replaces the current entry rather than adding one: the same screen again (a rescan, a
// refresh of the same detail).
export function sameEntry(current, next) {
  if (!current || !next || current.lmk !== next.lmk) return false;
  if (next.lmk !== "detail") return true;
  return current.key === next.key && current.taskId === next.taskId && current.view === next.view;
}
