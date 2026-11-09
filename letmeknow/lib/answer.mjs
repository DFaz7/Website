// Answering a PC's question from the phone (PROTOCOL.md, Answers): the buttons' words, the answer an alert's
// button asked for, and what the phone says came of it. Pure, so node --test covers it.
import { ANSWERS, scrub } from "./status.mjs";

export const LABELS = { skip: "Skip this person", do_it: "I'll do it", retry: "Retry" };
// What the phone says when the PC took the answer and sent no words of its own.
export const DONE = { skip: "Skipped", do_it: "SMU is waiting for you at the PC", retry: "Trying again" };

function words(v, max = 200) {
  if (typeof v !== "string") return "";
  const s = scrub(v.replace(/\s+/g, " ").trim());
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// An alert button's answer from the address the app was opened at (?pc=..&task=..&q=..&answer=..), or null.
export function answerFromParams(q) {
  const question = q.get("q") || "";
  const answer = q.get("answer") || "";
  if (!/^q_[0-9A-Za-z_-]{4,40}$/.test(question) || !ANSWERS.includes(answer)) return null;
  return { question, answer };
}

// What came of an answer: { ok, text }. `data` is the PC's answer; `error` an ApiError (lib/api.mjs). The PC's own
// message wins; otherwise the phone's words for what happened.
export function resultOf(answer, { data = null, error = null } = {}, device = "the PC") {
  if (!error) return { ok: true, text: words(data && data.message) || DONE[answer] || "Done" };
  const said = words(error.data && error.data.message);
  if (said) return { ok: false, text: said };
  switch (error.kind) {
    case "offline":
      return { ok: false, text: `Couldn't reach ${device}. Check Tailscale is on, or answer it on the PC.` };
    case "token":
      return { ok: false, text: `${device} doesn't know this phone any more. Pair it again in Settings.` };
    case "slow":
      return { ok: false, text: "Too many tries at once. Wait a moment and try again." };
    default:
      if (error.status === 404) return { ok: false, text: "This app can't take answers from the phone yet. Answer it on the PC." };
      return { ok: false, text: "That didn't go through. Answer it on the PC." };
  }
}

// What the detail view shows for a task's question: the buttons (none while one is being sent, or once one went
// through) and the result line. `q` is the task's detail.question (or null), `r` the last answer sent for this task
// ({ question, answer, state: "sending" | "ok" | "error", text }) or null.
export function answerView(q, r) {
  const mine = r && q && r.question === q.id;
  const result = r && (mine || !q) ? { state: r.state, text: r.text } : null;
  const buttons = q && !(mine && (r.state === "sending" || r.state === "ok")) ? q.answers.map((a) => ({ answer: a, label: LABELS[a] })) : [];
  return { buttons, result };
}
