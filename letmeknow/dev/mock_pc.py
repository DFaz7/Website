"""Test PCs for Let Me Know: PROTOCOL.md with fake data, plus the site itself, so the app can be clicked through.

    python letmeknow/dev/mock_pc.py            # site on http://localhost:8765/letmeknow/, PCs on 8791-8798
    python letmeknow/dev/mock_pc.py --port 8765 --quiet

Each fake PC prints its pairing code. In the app: Add a PC, Type code instead, address http://localhost:8791 (or
8792 to 8798) and the code. GET /dev/code on a PC (no Origin header) answers its current code and QR text.
Nothing is written to disk; pushes are printed, not sent (the alert key is a throwaway made at start).
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import functools
import hashlib
import hmac
import http.server
import json
import os
import secrets
import threading
import time

ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
LOCK = threading.Lock()
QUIET = False


def log(*a) -> None:
    if not QUIET:
        print(*a, flush=True)


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def vapid_public_key() -> str:
    """A real P-256 public point when `cryptography` is there (so subscribe() accepts it), else 65 random bytes."""
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        pub = ec.generate_private_key(ec.SECP256R1()).public_key()
        return b64url(pub.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
    except ImportError:
        return b64url(b"\x04" + secrets.token_bytes(64))


VAPID = vapid_public_key()


def now_iso(t: float | None = None) -> str:
    return dt.datetime.fromtimestamp(t or time.time()).astimezone().isoformat(timespec="seconds")


def new_code() -> str:
    s = "".join(secrets.choice(ALPHABET) for _ in range(8))
    return f"{s[:4]}-{s[4:]}"


def norm_code(text: str) -> str:
    s = str(text or "").upper().replace("-", "").replace(" ", "").replace("O", "0").replace("I", "1").replace("L", "1")
    return f"{s[:4]}-{s[4:]}" if len(s) == 8 else ""


class FakePC:
    def __init__(self, name: str, app: str, port: int, tasks: list[dict], busy: bool, down: bool = False,
                 revoked: bool = False):
        self.name, self.app, self.port, self.busy = name, app, port, busy
        self.down = down  # pairs, then never answers /v1/status: the phone shows "Can't reach"
        self.revoked = revoked  # pairs, then refuses the token: the phone shows "Not paired"
        self.id = hashlib.sha256(name.encode()).hexdigest()[:16]  # one id per PC, shared by SMU and TabGod
        self.tasks = tasks
        self.start = time.time()
        self.devices: dict[str, dict] = {}  # device id -> {name, hash, push, paired_at, last_seen}
        self.code, self.code_until, self.code_tries = new_code(), time.time() + 600, 0
        self.pair_times: list[float] = []
        self.last_push: dict[str, float] = {}
        self.was_needed: dict[str, bool] = {}

    def url(self) -> str:
        return f"http://localhost:{self.port}"

    def qr_text(self) -> str:
        return json.dumps({"lmk": 1, "app": self.app, "url": self.url(), "pc": self.id, "name": self.name,
                           "code": self.code}, separators=(",", ":"))

    def fresh_code(self) -> None:
        self.code, self.code_until, self.code_tries = new_code(), time.time() + 600, 0
        log(f"[{self.name} {self.app} :{self.port}] pairing code {self.code}")

    def status(self) -> dict:
        """Fake progress: a running task gains a person every minute; a task with "asks" needs the owner while it
        runs."""
        el = time.time() - self.start
        out = []
        for t in self.tasks:
            done, left = t["done"], t["left"]
            running = self.busy and t.get("run", False)
            if running:
                step = min(left, int(el // 60))
                done, left = done + step, left - step
                running = left > 0
            why = ""
            if t.get("asks") and running:
                why = t["asks"]
            per = t.get("per")
            eta = None if per is None or not left else int(per * left - (el % 60 if running else 0))
            out.append({"id": t["id"], "name": t["name"], "done": done, "failed": t["failed"], "left": left,
                        "running": running, "needs_you": bool(why), "needs_you_reason": why or None,
                        "learned": per is not None, "per_person_seconds": per, "gap_seconds": t.get("gap"),
                        "eta_seconds": eta, "eta_at": now_iso(time.time() + eta) if eta is not None else None})
            if t.get("detail"):
                out[-1]["detail"] = self.detail(t["detail"])
            self.maybe_push(t["id"], t["name"], bool(why), why)
        return {"app": self.app, "protocol": 1,
                "device": {"name": self.name, "id": self.id, "active": any(x["running"] for x in out)},
                "tasks": out}

    def detail(self, d: dict) -> dict:
        """A task's detail (PROTOCOL.md), with "since" and each problem's time given as seconds before start."""
        out = {k: v for k, v in d.items() if k in ("kind", "step", "page", "what_to_do")}
        if "since_ago" in d:
            out["since"] = now_iso(self.start - d["since_ago"])
        out["recent"] = [{"at": now_iso(self.start - r["ago"]), "result": r.get("result", "failed"), "reason": r["reason"]}
                         for r in d.get("recent", [])]
        return out

    def maybe_push(self, tid: str, tname: str, needed: bool, why: str) -> None:
        was = self.was_needed.get(tid, False)
        self.was_needed[tid] = needed
        if not needed or was:
            return
        if time.time() - self.last_push.get(tid, 0) < 60:
            return
        self.last_push[tid] = time.time()
        payload = {"v": 1, "app": self.app, "kind": "needs_you", "pc": self.id, "pc_name": self.name, "task": tid,
                   "task_name": tname, "title": f"{self.name} needs you", "body": f"{tname}: {why}", "at": now_iso()}
        for d in self.devices.values():
            if d["push"]:
                log(f"[{self.name} {self.app}] push to {d['name']}: {json.dumps(payload)}")


def make_handler(pc: FakePC, origins: set[str]):
    class H(http.server.BaseHTTPRequestHandler):
        server_version, sys_version = "LMK-mock", ""

        def log_message(self, *_a) -> None:
            pass

        def origin_ok(self) -> tuple[bool, str]:
            o = self.headers.get("Origin")
            return (o is None or o in origins), (o or "")

        def send(self, code: int, data: dict | None = None) -> None:
            body = b"" if data is None else json.dumps(data).encode()
            self.send_response(code)
            ok, o = self.origin_ok()
            if ok and o:
                self.send_header("Access-Control-Allow-Origin", o)
                self.send_header("Vary", "Origin")
            if self.command == "OPTIONS":
                self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE")
                self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
                self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Cache-Control", "no-store")
            if data is not None:
                self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def body(self) -> dict | None:
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if not 0 <= n <= 16384:
                    return None
                v = json.loads(self.rfile.read(n) or b"{}") if n else {}
                return v if isinstance(v, dict) else None
            except (ValueError, OSError):
                return None

        def me(self) -> str | None:
            auth = self.headers.get("Authorization") or ""
            if not auth.startswith("Bearer ") or pc.revoked:
                return None
            h = hashlib.sha256(auth[7:].encode()).hexdigest()
            for did, d in pc.devices.items():
                if hmac.compare_digest(d["hash"], h):
                    d["last_seen"] = now_iso()
                    return did
            return None

        def do_OPTIONS(self) -> None:
            ok, _ = self.origin_ok()
            self.send(204 if ok else 403)

        def do_GET(self) -> None:
            self.route("GET")

        def do_POST(self) -> None:
            self.route("POST")

        def do_PUT(self) -> None:
            self.route("PUT")

        def do_DELETE(self) -> None:
            self.route("DELETE")

        def route(self, method: str) -> None:
            ok, _ = self.origin_ok()
            body = self.body() if method in ("POST", "PUT") else {}
            if not ok:
                return self.send(403, {"error": "origin"})
            if body is None:
                return self.send(400, {"error": "bad request"})
            path = self.path.split("?")[0]
            with LOCK:
                if method == "GET" and path == "/v1/hello":
                    return self.send(200, {"app": pc.app, "protocol": 1, "version": "mock"})
                if method == "GET" and path == "/dev/code" and not self.headers.get("Origin"):
                    return self.send(200, {"code": pc.code, "qr": pc.qr_text()})
                if method == "POST" and path == "/v1/pair":
                    return self.pair(body)
                did = self.me()
                if not did:
                    return self.send(401, {"error": "token"})
                if method == "GET" and path == "/v1/status":
                    if pc.down:  # no answer at all, like a PC that's off the tailnet
                        self.close_connection = True
                        return None
                    return self.send(200, pc.status())
                if method == "GET" and path == "/v1/devices":
                    return self.send(200, {"devices": [
                        {"id": i, "name": d["name"], "paired_at": d["paired_at"], "last_seen": d["last_seen"],
                         "push": bool(d["push"]), "me": i == did} for i, d in pc.devices.items()]})
                if method == "PUT" and path == "/v1/devices/me":
                    d = pc.devices[did]
                    if "name" in body and isinstance(body["name"], str) and body["name"].strip():
                        d["name"] = body["name"].strip()[:40]
                    if "push" in body:
                        d["push"] = body["push"] if isinstance(body["push"], dict) else None
                    log(f"[{pc.name} {pc.app}] device {d['name']}: push {'on' if d['push'] else 'off'}")
                    return self.send(200, {"ok": True})
                if method == "POST" and path == "/v1/devices/me/test":
                    d = pc.devices[did]
                    if not d["push"]:
                        return self.send(409, {"error": "no push"})
                    log(f"[{pc.name} {pc.app}] test push to {d['name']}")
                    return self.send(200, {"ok": True})
                if method == "POST" and path == "/v1/token/rotate":
                    tok = b64url(secrets.token_bytes(32))
                    pc.devices[did]["hash"] = hashlib.sha256(tok.encode()).hexdigest()
                    return self.send(200, {"token": tok})
                if method == "DELETE" and path.startswith("/v1/devices/"):
                    target = path.rsplit("/", 1)[1]
                    target = did if target == "me" else target
                    if target not in pc.devices:
                        return self.send(404, {"error": "unknown device"})
                    log(f"[{pc.name} {pc.app}] removed {pc.devices.pop(target)['name']}")
                    return self.send(200, {"ok": True})
                return self.send(404, {"error": "not found"})

        def pair(self, body: dict) -> None:
            t = time.time()
            pc.pair_times = [x for x in pc.pair_times if t - x < 60] + [t]
            if len(pc.pair_times) > 5:
                return self.send(429, {"error": "slow down"})
            code, name = norm_code(body.get("code", "")), str(body.get("device_name") or "").strip()[:40]
            if not name:
                return self.send(400, {"error": "bad request"})
            if t > pc.code_until or code != pc.code:
                pc.code_tries += 1
                if pc.code_tries >= 5 or t > pc.code_until:
                    pc.fresh_code()
                return self.send(403, {"error": "code"})
            if len(pc.devices) >= 10:
                return self.send(409, {"error": "full"})
            tok = b64url(secrets.token_bytes(32))
            did = "d_" + secrets.token_hex(3)
            pc.devices[did] = {"name": name, "hash": hashlib.sha256(tok.encode()).hexdigest(), "push": None,
                               "paired_at": now_iso(), "last_seen": now_iso()}
            log(f"[{pc.name} {pc.app}] paired {name}")
            pc.fresh_code()
            return self.send(200, {"token": tok, "device_id": did, "app": pc.app,
                                   "pc": {"id": pc.id, "name": pc.name}, "vapid_public_key": VAPID})

    return H


def site_handler(root: str):
    class Site(http.server.SimpleHTTPRequestHandler):
        extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript",
                          ".mjs": "text/javascript", ".webmanifest": "application/manifest+json",
                          ".svg": "image/svg+xml", ".png": "image/png", ".css": "text/css", ".html": "text/html"}

        def log_message(self, *_a) -> None:
            pass

        def end_headers(self) -> None:
            self.send_header("Cache-Control", "no-cache")
            super().end_headers()

    return functools.partial(Site, directory=root)


def fake_pcs() -> list[FakePC]:
    """Several PCs with both apps, in every state the phone shows: needs you, short and long runs, learning the form,
    idle, can't reach and not paired."""
    return [
        FakePC("ZBook", "smu", 8791, [
            {"id": "t1", "name": "Gym list", "done": 12, "failed": 1, "left": 30, "run": True, "per": 95, "gap": 20,
             "asks": "Needs attention",
             "detail": {"kind": "attention", "step": "Date of birth", "page": "Step 2 of 4", "since_ago": 360,
                        "recent": [
                            {"ago": 900, "reason": "The form said the email is already in use"},
                            {"ago": 2400, "result": "skipped", "reason": "No email arrived within 10 minutes"},
                        ]}},
            {"id": "t2", "name": "Newsletter sign-ups", "done": 0, "failed": 0, "left": 18, "per": None},
            {"id": "t3", "name": "Spring offers", "done": 40, "failed": 2, "left": 0, "per": 80, "gap": 15},
        ], busy=True),
        FakePC("ZBook", "tabgod", 8792, [
            {"id": "g1", "name": "Profiles batch A", "done": 7, "failed": 0, "left": 6, "run": True, "per": 45,
             "gap": 10},
        ], busy=True),
        FakePC("Mini 1", "smu", 8793, [
            {"id": "m1", "name": "Club members", "done": 3, "failed": 0, "left": 70, "run": True, "per": 120,
             "gap": 25, "detail": {"recent": [{"ago": 1500, "reason": "The page didn't load in time"}]}},
        ], busy=True),
        FakePC("Mini 1", "tabgod", 8794, [
            {"id": "g2", "name": "Profiles batch B", "done": 20, "failed": 1, "left": 12, "per": 240, "gap": 30},
        ], busy=False),
        FakePC("Mini 2", "smu", 8795, [
            {"id": "n1", "name": "Book club", "done": 0, "failed": 0, "left": 25, "run": True, "per": None},
        ], busy=True),
        FakePC("Mini 2", "tabgod", 8796, [
            {"id": "g3", "name": "Profiles batch C", "done": 4, "failed": 2, "left": 9, "run": True, "per": 200,
             "gap": 30, "asks": "Both AIs couldn't do a step"},
        ], busy=True),
        FakePC("Desktop", "smu", 8797, [
            {"id": "d1", "name": "Winter offers", "done": 1, "failed": 0, "left": 50, "run": True, "per": 90},
        ], busy=True, down=True),
        FakePC("Laptop 2", "tabgod", 8798, [], busy=False, revoked=True),
    ]


def below_normal_priority() -> None:
    """A test tool stays out of the way of real work on this PC."""
    if os.name == "nt":
        import ctypes
        k = ctypes.windll.kernel32
        k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)  # BELOW_NORMAL_PRIORITY_CLASS
    else:
        os.nice(5)


def main() -> None:
    global QUIET
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8765, help="the site's port (0: don't serve the site)")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()
    QUIET = a.quiet
    below_normal_priority()
    origins = {f"http://localhost:{a.port}", f"http://127.0.0.1:{a.port}"}
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    servers = []
    if a.port:
        servers.append(http.server.ThreadingHTTPServer(("127.0.0.1", a.port), site_handler(root)))
        log(f"site: http://localhost:{a.port}/letmeknow/")
    for pc in fake_pcs():
        servers.append(http.server.ThreadingHTTPServer(("127.0.0.1", pc.port), make_handler(pc, origins)))
        log(f"[{pc.name} {pc.app} :{pc.port}] address {pc.url()}  pairing code {pc.code}")
    for s in servers:
        s.daemon_threads = True
        threading.Thread(target=s.serve_forever, daemon=True).start()
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        for s in servers:
            s.shutdown()
            s.server_close()


if __name__ == "__main__":
    main()
