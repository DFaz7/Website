# Let Me Know - PC protocol (version 1)

What SMU and TabGod implement on each PC so the Let Me Know web app (`https://dmftrading.co.uk/letmeknow/`) can
show their status and get alerts. `dev/mock_pc.py` implements all of it with fake data.

## Listener and transport

| App    | Local listener     | Reached by the phone as (via `tailscale serve`)  |
| ------ | ------------------ | ------------------------------------------------ |
| SMU    | `127.0.0.1:8791`   | `https://<machine>.<tailnet>.ts.net` (port 443)  |
| TabGod | `127.0.0.1:8792`   | `https://<machine>.<tailnet>.ts.net:8443`        |

- Plain HTTP on 127.0.0.1 only. `tailscale serve --bg --https=443 http://127.0.0.1:8791` (TabGod: `--https=8443`
  and `8792`) gives it HTTPS inside the tailnet. Never Funnel. The app may run that command itself at start when
  `tailscale` is on PATH and the serve config is missing; `tailscale serve status --json` shows what is set.
- This is **not** SMU's IWM link (that one refuses any request with `Origin`/`Sec-Fetch-*` on purpose): a separate
  listener, only the endpoints below, JSON in and out, bodies at most 16 KB, `Cache-Control: no-store` on every
  answer.
- The PC's base URL is `https://` + Tailscale's MagicDNS name for this machine (`tailscale status --json` ->
  `Self.DNSName`, trailing dot removed), plus `:8443` for TabGod.

## CORS

- Allowed origins, exact match: `https://dmftrading.co.uk`, `https://www.dmftrading.co.uk`. A dev switch (off by
  default) may add `http://localhost:8765` and `http://127.0.0.1:8765`.
- A request with any other `Origin` gets 403 `{"error":"origin"}`. A request without `Origin` is allowed (curl,
  tests): the token still guards it.
- `OPTIONS` preflight from an allowed origin: 204 with
  `Access-Control-Allow-Origin: <that origin>`, `Access-Control-Allow-Methods: GET, POST, PUT, DELETE`,
  `Access-Control-Allow-Headers: Authorization, Content-Type`, `Access-Control-Max-Age: 600`, `Vary: Origin`.
- Every answer to an allowed origin carries `Access-Control-Allow-Origin: <origin>` and `Vary: Origin`. No cookies,
  no `Allow-Credentials`.

## Auth

- `Authorization: Bearer <token>` on everything but `GET /v1/hello` and `POST /v1/pair`.
- Token: 32 random bytes, base64url, made at pairing. The PC stores only `sha256(token)` (hex) per device and
  compares with `hmac.compare_digest`. Wrong or missing token: 401 `{"error":"token"}` (the app then shows
  "Pair again").

## Endpoints

### `GET /v1/hello` (no auth)
`{"app":"smu","protocol":1,"version":"2.7.0"}`. Nothing else: no names, no ids.

### `POST /v1/pair` (no auth)
Request `{"code":"K7Q2-9XMP","device_name":"iPhone"}`. The code is matched case-insensitively with `-`, spaces,
`O`->`0`, `I`/`L`->`1` normalised. Answer 200:
```json
{"token":"<base64url>","device_id":"d_3f9a1c","app":"smu",
 "pc":{"id":"<16 hex, same as /v1/status device.id>","name":"ZBook"},
 "vapid_public_key":"<base64url, uncompressed P-256 point, 65 bytes>"}
```
Errors: 400 `{"error":"bad request"}`, 403 `{"error":"code"}` (wrong, used or expired), 429 `{"error":"slow down"}`,
409 `{"error":"full"}`.

Pairing codes: the PC's Settings "Pair a phone" makes a new code each time it opens: 8 characters from
`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, shown `XXXX-XXXX`, one use, valid 10 minutes, dead after 5 wrong tries.
The Settings screen shows a QR whose text is exactly:
```json
{"lmk":1,"app":"smu","url":"https://zbook.tail1234.ts.net","pc":"<pc id>","name":"ZBook","code":"K7Q2-9XMP"}
```
and under it, for typing: the address (`zbook.tail1234.ts.net`, or `...:8443` for TabGod) and the code.
`device_name`: 1-40 characters, trimmed; the PC keeps it as a label only.

### `PUT /v1/devices/me`
Request `{"push": <PushSubscription.toJSON()> | null, "name": "iPad"}` (each key optional). `push` is
`{"endpoint":"https://web.push.apple.com/...","keys":{"p256dh":"...","auth":"..."}}`. The endpoint must be
`https://` on a known push service host (`*.push.apple.com`, `fcm.googleapis.com`,
`updates.push.services.mozilla.com`, `*.notify.windows.com`), else 400. Answer `{"ok":true}`.

### `GET /v1/devices`
```json
{"devices":[{"id":"d_3f9a1c","name":"iPhone","paired_at":"2026-11-01T00:10:00+00:00",
             "last_seen":"2026-11-01T00:12:31+00:00","push":true,"me":true}]}
```

### `DELETE /v1/devices/<id>` and `DELETE /v1/devices/me`
Removes that device: token and push subscription gone at once. Any paired device may remove any other (a lost iPad
is removed from the iPhone too). Answer `{"ok":true}`; unknown id 404. The PC's own Settings lists the same devices
with a Remove button each.

### `POST /v1/devices/me/test`
Sends one test push to the calling device now (`kind: "test"`). `{"ok":true}`, or 409 `{"error":"no push"}` when
it has no subscription, 502 `{"error":"push failed","status":<push service status>}`.

### `POST /v1/token/rotate`
Answers `{"token":"<new>"}`; the old token stops working once the new one has been used once.
The app rotates every 30 days; a 404 here (not built yet) is ignored. The phone keeps the old token until a call with
the new one has worked (a 401 with the new one is retried with the old one), and when the answer is lost (the phone
suspended mid-call) it asks again later with the old token, so the PC must keep accepting it.

### `GET /v1/status`
SMU's existing `status_view()` plus `"app"` and `"protocol"`:
```json
{"app":"smu","protocol":1,
 "device":{"name":"ZBook","id":"a1b2c3d4e5f60718","active":true},
 "tasks":[{"id":"t1","name":"Gym list","done":12,"failed":1,"left":30,"running":true,
           "needs_you":false,"needs_you_reason":null,"learned":true,
           "per_person_seconds":95,"gap_seconds":20,"eta_seconds":2830,"eta_at":"2026-11-01T00:58:10+00:00"}]}
```
- `device.active`: a run is on right now on this PC. `eta_at`: ISO 8601 with offset, `null` until learned.
- TabGod answers the same shape with `"app":"tabgod"`; fields it has no meaning for are `null` or left out.
- The app ignores unknown fields and treats a missing one as unknown; new fields can be added at any time.
- `needs_you_reason`: a few words (e.g. "A question", "Needs attention", IWM's notice sentence). Never a
  person's value.

#### Optional `detail` per task (for the phone's detail view)

```json
"detail": {"kind": "attention", "step": "Date of birth", "page": "Step 2 of 4",
           "since": "2026-11-01T02:41:00+00:00",
           "what_to_do": "On ZBook, open SMU, press Show SMU, do the step yourself, then press Carry on.",
           "recent": [{"at": "2026-11-01T02:30:12+00:00", "result": "failed",
                       "reason": "The form said the email is already in use"}]}
```
- Every key is optional; send `detail` whenever there is something in it (also on running tasks without a wait,
  for `recent`). The phone shows what is there and falls back to its own words for the rest.
- `kind`: what the wait is. `attention` (stuck on a step, Show SMU), `question` (SMU asks something),
  `email_check` ("Is this the form's email?"), `watching` (the owner fills while SMU watches), `finish` (the owner's
  own sign-up to finish), `iwm` (IWM's own notice), `stuck` (TabGod left a profile window for the owner). Lower
  case letters and `_`, at most 24; new kinds may be added (the phone shows the reason and a generic step).
- `step`: the label of the field or step it's stuck on (at most 80 characters). `page`: the page title, or
  "step n of m" (at most 80). `since`: ISO 8601 with offset, when the wait began.
- `what_to_do`: one plain sentence naming the PC and the buttons to press (at most 240). Missing: the phone uses its
  own sentence for the app and kind.
- `recent`: the last problems on this task, newest first, **at most 5**: `{"at": ISO, "result": "failed" |
  "skipped", "reason": "<sentence, at most 200>"}`.

#### Optional top-level `quefix` (TabGod only)

TabGod's window order check (QueFix), for `"app":"tabgod"` only (the phone ignores it from any other app):
```json
"quefix": {"live": true, "scanned_at": "2026-11-04T01:12:31+00:00", "windows": 24, "desktops": 3,
           "in_order": false, "out_of_order_count": 2, "out_of_order": [{"first": "7", "then": "3"}], "near_count": 1,
           "rows": [{"rank": 1, "name": "Milo (10)", "position": "842", "bar": false, "sure": true, "near": true,
                     "desktop": 2}]}
```
- Present only while live mode is on, or for 10 minutes after a manual scan; absent otherwise (the phone then shows
  no QueFix line).
- `rows`: sorted by `rank`, at most 100. `name`: the profile, already privacy-scrubbed by the PC, never a window
  title; `"Window <rank>"` when unknown. `position`: display text, `"1,204"` or `"64%"` when `bar` is true.
  `sure`: false when the read is uncertain. `near`: true when the profile is near the front (above 90 %, or under
  1,000 in the queue); `near_count` counts them. `desktop`: the virtual desktop number, or null.
- `out_of_order`: at most 5 pairs, `first` should be before `then`; `out_of_order_count` is the full count.
- The phone shows a line on that PC's card ("QueFix live · 24 windows · all in order", "2 near front" in green,
  "2 out of order" as a warning, with "scanned N s ago" from `scanned_at`); tapping it shows the pairs ("7 should be
  before 3") and then the plain list: profile and queue position per window, in rank order, near-front rows marked
  "near front" in green. It masks email and IP addresses again.
- Push: a QueFix problem is a `needs_you` push with `"task":"quefix"`, `"task_name":"QueFix"`,
  body `"QueFix: 7 should be before 3"`; tapping it opens the QueFix list.
- Push: profiles that newly crossed into near the front send one `queue` push per scan (see Push), e.g. title
  `"Profile 10 is near the front"`, body `"Queue 842 · QueFix on Mini 1"`, or for several: title
  `"3 profiles near the front"`, body `"10: 842 · 7: 93% · 3: 990"`; tapping it opens the QueFix list.

#### Privacy rule for every text field (`needs_you_reason`, `detail.*`, `quefix.rows[].name`)

Before anything leaves the PC, every text is stripped of the person's own values: their names, email addresses,
phone numbers, date of birth, postal address and passwords, matched against the person's record being filled
(case-insensitive, also with spaces and separators removed), and then, by pattern, any email address and any IP
address (v4 and v6). A step label that is a field's name ("Date of birth") is fine; the value typed into it never
is. A page title that contains any such value is replaced by "page n" (n = its position in the form). The phone
masks email and IP patterns again as a second guard, but the PC's rule is what keeps people's details private.

## Push

- Web Push (RFC 8030) with VAPID (RFC 8292), payload encrypted `aes128gcm` (RFC 8291). Python: `pywebpush` (or
  `cryptography` + ~120 lines); Node/Electron: the `web-push` package.
- VAPID JWT: `aud` = the endpoint's origin, `exp` <= 12 h, `sub` = `mailto:info@dmftrading.co.uk`.
- Key: **one P-256 pair for all of the owner's PCs and both apps** (a phone's one push subscription is bound to one
  key; `subscribe()` with another key fails). Kept in `%LOCALAPPDATA%\LetMeKnow-signing\vapid_private.pem`
  (PKCS#8 PEM). Backup: `C:\Users\danie\OneDrive\Desktop\App's\Signing Keys\LetMeKnow\vapid_private.pem` +
  `SOURCE.txt`. On start: if one side is missing copy it from the other; if both are missing make it once (and
  write both); if they differ, stop pushing and say so in Settings. Never commit, log or print it.
- Headers: `TTL: 3600` (needs_you), `600` (queue: a near-front alert older than 10 minutes is stale) or `86400`
  (others), `Urgency: high` for needs_you, queue and a
  went-quiet stop (`kind: "stopped"`, `reason: "quiet"`) else `normal`, `Topic: <app>-<task id>`
  (`tabgod-qf-near` for queue; newest replaces an undelivered older one; Topic allows only URL-safe base64
  characters, at most 32).
- Payload (JSON, UTF-8, under 1 KB):
```json
{"v":1,"app":"smu","kind":"needs_you","pc":"a1b2c3d4e5f60718","pc_name":"ZBook",
 "task":"t1","task_name":"Gym list","title":"ZBook needs you","body":"Gym list: A question",
 "at":"2026-11-01T00:12:31+00:00"}
```
  `kind`: `needs_you` | `finished` | `failed` | `stopped` | `queue` | `test`. `queue` is TabGod's QueFix near-front
  alert (`"Topic":"tabgod-qf-near"`, no `task` needed: the phone opens the QueFix list). `title`/`body` are what the phone shows; the
  phone falls back to its own words when they are missing. Optional `reason`: `"quiet"` on a `stopped` push sent
  when a PC went quiet mid-run (it may be off or crashed), e.g. title `ZBook went quiet`, body
  `Gym list: no word from ZBook since 01:52 (it may be off or crashed)`; other reasons are ignored. Tapping an alert
  opens the app on `pc` (and `task` when given).
- When a push fires (per task):
  - `needs_you`: `needs_you` turns true, or its reason changes while true. Body `<task>: <reason>`.
  - `finished`: a run ends with nobody left. Body `<task>: done - <done> done, <failed> failed`.
  - `failed`: a run ends on an error that stops it (not one person failing and the run going on). Body
    `<task>: stopped - <reason>`.
  - `stopped`: the run stopped without the owner pressing Pause/Stop on that PC (e.g. the AI went away).
  - Not on the owner's own Pause/Stop, not for each person done.
- At most one push per task per 60 s. Inside the window keep only the newest event (needs_you beats the others) and
  send it when the window ends, if it still holds.
- Push service answers: 201 ok; 404/410 drop that device's subscription (keep the pairing); 413 shorten the body;
  429/5xx retry once after `Retry-After` (default 60 s), then drop that one push.

## Limits

- `POST /v1/pair`: 5 a minute per PC in all; a code is dead after 5 wrong tries.
- Everything else: 120 a minute per token; `/v1/status` may be answered from a 2 s cache.
- At most 10 paired devices per app per PC; pairing an 11th answers 409 `{"error":"full"}`.
- A device unseen for 30 days whose push subscription is dead (404/410) is removed.

## Phone side (for reference)

Stores per PC: `{app, url, pc, name, token, deviceId, vapid, pushEndpoint}` in `localStorage` (`lmk.v1`), and each
PC's last answer (`lmk.v1.last`). Polls `/v1/status` every 10 s while open. Alerts: the pair tap (and a "Turn on
alerts" tap) asks for notification permission and, when the shared key is known from a PC paired before, calls
`pushManager.subscribe()` in the same tap, before the pairing's network call (iOS allows both only inside a tap).
The first PC's key comes with its pairing answer, so that subscribe follows the pairing, or the next "Turn on alerts"
tap if the browser refuses it outside a tap. The phone then sends `PUT /v1/devices/me` with its subscription to every
paired PC with that key. On every open, only where permission is already granted, it re-subscribes silently when the
subscription is missing or was made with another key, asks each PC `GET /v1/devices` and sends it again to any PC
whose last known endpoint differs or whose list shows `push: false` for this phone (a PC that didn't answer is tried
again at most once a minute). A PC with a different key is sent `{"push": null}`, as are all
PCs when notifications are blocked. `DELETE /v1/devices/me` on Remove.
