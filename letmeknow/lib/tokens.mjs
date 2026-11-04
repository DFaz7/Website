// Token rotation (PROTOCOL.md, POST /v1/token/rotate) without ever unpairing the phone: the old token is kept until a
// call with the new one has worked, and a rotate whose answer was lost is simply asked again with the old token.

export const ROTATE_MS = 30 * 24 * 3600 * 1000; // rotate every 30 days
export const RETRY_MS = 10 * 60 * 1000; // a rotate that got no answer is tried again after this

// Whether to ask for a new token now: due, no rotation still waiting to be confirmed, and not tried just now.
export function shouldRotate(pc, now) {
  if (pc.oldToken) return false;
  if (pc.rotateTriedAt && now - pc.rotateTriedAt < RETRY_MS) return false;
  return !pc.rotatedAt || now - pc.rotatedAt > ROTATE_MS;
}

// The store patch for a rotate answer: the new token is used from now on, the old one kept as `oldToken` until a call
// with the new one works. An answer without a token (or 404: not built on that PC) just waits 30 days again.
export function afterRotate(pc, answer, now) {
  if (answer && typeof answer.token === "string" && answer.token) {
    return { token: answer.token, oldToken: pc.oldToken || pc.token, rotatedAt: now, rotateTriedAt: 0 };
  }
  return { rotatedAt: now, rotateTriedAt: 0 };
}

// Calls fn(token) with the PC's token. While a rotation is unconfirmed, a "token" refusal with the new token is
// tried once more with the old one. { result, patch }: patch (or null) is what to keep in the store:
//   the new token worked -> forget the old one;
//   only the old one worked -> the rotation didn't take on the PC: back to the old token, rotate again in a while.
export async function callWithToken(pc, fn, now = Date.now()) {
  try {
    const result = await fn(pc.token);
    return { result, patch: pc.oldToken ? { oldToken: "" } : null };
  } catch (e) {
    if (!(e && e.kind === "token" && pc.oldToken)) throw e;
    const result = await fn(pc.oldToken);
    return { result, patch: { token: pc.oldToken, oldToken: "", rotatedAt: 0, rotateTriedAt: now } };
  }
}
