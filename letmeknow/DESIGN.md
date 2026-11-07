# Let Me Know - design

A phone/iPad web app (PWA) showing SMU and TabGod status on each of the owner's PCs, with push alerts when the
owner is needed. Served by GitHub Pages at `https://dmftrading.co.uk/letmeknow/`. The PC side is specified in
`PROTOCOL.md`.

## Requirements

- Installable on iPhone/iPad (iOS 16.4+) from Safari: Share -> Add to Home Screen. No App Store. Listed on the
  Downloads page next to the Vault app. Updates itself; nothing to reinstall.
- One card per PC (ZBook, Mini 1, ...): SMU and TabGod on one PC share its id and name from pairing, so each card
  is one machine, with its state (Needs you, Running, Can't reach, Not paired, Checking, Idle). Inside, each app
  (SMU or TabGod badge, each in its own colour) lists its tasks that run or need the owner: task name, time left
  with the finish time (or "learning the form"), a done / failed / left bar and counts, and when it needs the owner,
  the reason and what to do. An app with nothing running says so ("Nothing running · 12 left"); one that doesn't
  answer says "Can't reach ZBook · last known 3 min ago" and keeps its last known tasks, greyed. Cards: needs you
  first, then running by least time left, then problems, then checking, then idle; ties by name. Two columns on a
  wide iPad.
- Tapping a row opens its detail view: "What's wrong" (the full reason, the step and page it's stuck on, how long
  it has waited), "What to do" in plain words (the PC's own sentence, else one for the app and the kind of wait),
  progress (done / failed / left, time left, finish, per person) and the last few problems. Works with today's
  /v1/status and fills in more when a PC sends the optional `detail` (PROTOCOL.md).
- Answering from the phone: when SMU stops on a wait the phone can answer, its alert carries buttons (Skip this
  person, I'll do it, and Retry where it fits) on Android and desktop, and the task's "What to do" card shows the
  same buttons everywhere (iPhone/iPad alerts have no buttons). A tap sends the answer once (`POST /v1/answer`), and
  the card says what came of it: "Skipped", "SMU is waiting for you at the PC", or the PC's plain reason why not.
- Each PC's last answer is kept, so the list shows at once on open (as "Checking…" until the PC answers).
- Push alerts whenever an app needs the owner (both AIs couldn't do a step, a question, a stuck profile, IWM's own
  problems via SMU), and when a run finishes or stops or a PC goes quiet mid-run. Alerts turn on as a phone pairs:
  the pair tap asks for permission. While they are off the home screen shows one full-width step saying exactly what
  to do (on an iPhone/iPad Safari tab: Share, Add to Home Screen, then open it and tap Turn on alerts), with a big
  "Turn on alerts" button. Tapping an alert opens the app on that PC and task.
- PCs are named in their apps' Settings (SMU: "Which device this is"; TabGod gets the same; one name per PC, shared
  by both apps, following the hardware-scan host list IWM uses, with a Mini 1 / Mini 2 choice when the scan matches
  both minis).
- Private: the app alone shows nothing. It is paired with each PC by a QR code (one-time code) shown in SMU/TabGod
  Settings, scanned inside the installed app (typed code as fallback); each pairing gives that device its own token.
  Many devices per PC (iPhone, iPad, ...), each removable without affecting the others; one device can pair many
  PCs. Only paired devices get alerts. Reached only over the owner's Tailscale network. Only counts, task names
  (owner-chosen labels) and device names leave the PC, never a person's details or passwords.
- Name "Let Me Know"; icon "alert pulse, classic" (red gradient tile #FF5F5F -> #D3141C, two soft white rings,
  white disc, red "!"); clean UI, even spacing, no big gaps. Dark by default; Settings, Look switches to light.

## Decisions

1. **Transport: `tailscale serve` on each PC, phone on Tailscale.** An HTTPS page cannot fetch `http://100.x...`
   (mixed content is blocked: MDN "Mixed content"). `tailscale serve` gives each PC a real HTTPS certificate on its
   MagicDNS name (`https://zbook.tailXXXX.ts.net`), reachable only inside the tailnet (not Funnel), and proxies to a
   plain local port (Tailscale KB 1312 "serve", KB 1153 "Enabling HTTPS"). SMU: `127.0.0.1:8791` on HTTPS 443;
   TabGod: `127.0.0.1:8792` on HTTPS 8443. Rejected: the PC terminating TLS itself with `tailscale cert` (renewal
   every 90 days, more code); relaying status through the Cloudflare worker (status would leave the tailnet).
   Certificate names go into public Certificate Transparency logs (KB 1153): machine names and the tailnet's
   random name become public, no person data; keep machine names neutral.
2. **A separate phone listener, not SMU's IWM link** (which refuses browser requests on purpose). Only the
   endpoints in PROTOCOL.md, CORS for the site origin only.
3. **Push: Web Push straight from each PC to Apple, VAPID, one key pair shared by all the owner's PCs.** iOS 16.4+
   home-screen web apps get standard Web Push (RFC 8030/8291/8292); no Apple developer account; permission only
   from a user tap; every push must show a notification (WebKit blog 13878; Apple "Sending web push notifications
   in web apps and browsers"). A service worker registration holds one push subscription bound to one
   `applicationServerKey`; `subscribe()` with another key rejects with `InvalidStateError` (W3C Push API). So one
   phone paired with several PCs needs every PC to sign with the same key: `%LOCALAPPDATA%\LetMeKnow-signing\`,
   backed up to `Signing Keys\LetMeKnow\` with `SOURCE.txt`, never committed or printed. The phone learns the
   public key at pairing and refuses alerts from a PC with a different key, with a plain message.
4. **Pairing:** QR text `{"lmk":1,"app","url","pc","name","code"}`; 8-character one-use code (10 min, 5 tries);
   `POST /v1/pair` gives a per-device token (the PC stores only its hash). Camera via `getUserMedia` (works in iOS
   home-screen apps). Safari has no `BarcodeDetector`, so on iPhone/iPad the scanner needs `vendor/jsqr.js`
   (jsQR 1.4.0, Apache-2.0); without it the app shows the typed-code form.
5. **Storage:** `localStorage` key `lmk.v1`. Home-screen apps keep their own storage, separate from Safari, and are
   not subject to Safari's 7-day script-storage cap (WebKit blogs 10218, 14403); the app also asks
   `navigator.storage.persist()`. If iOS clears it (app removed, website data cleared), re-pair each PC and remove
   the old entry in the PC's Settings (PCs also drop devices unseen for 30 days with a dead subscription).
6. **Privacy:** nothing is fetched or shown until paired; a stranger's install is an empty app. Rendering uses
   `textContent` only; a Content-Security-Policy limits connections to `*.ts.net` (and localhost for testing).
7. **Self-update:** `sw.js` carries `VERSION`, caches `lmk-<VERSION>`; on open (and every 30 min) the app calls
   `registration.update()`; a waiting worker shows "A new version is ready - Update". `updateViaCache: "none"`.
8. **Refresh:** every 10 s while visible, pull to refresh, 1 s countdown from `eta_at` between refreshes.
9. **Badge:** `navigator.setAppBadge(n)` = tasks that need the owner.

## Owner's one-time setup

1. Tailscale admin console -> DNS: MagicDNS on, **HTTPS Certificates: Enable**.
2. Each PC: Tailscale signed in. The apps run `tailscale serve --bg` themselves once the PC side is built.
3. iPhone and iPad: Tailscale app, signed in to the same tailnet, VPN on (On Demand is fine).
4. iPhone/iPad: Safari -> `https://dmftrading.co.uk/letmeknow/` -> Share -> Add to Home Screen; open it from the
   Home Screen; pair each PC (the pair tap turns alerts on).
5. First PC makes the shared alert key; it reaches the other PCs through the Signing Keys folder on OneDrive.
6. Vendor jsQR once (`letmeknow/vendor/jsqr.js` from npm `jsqr@1.4.0`, the `dist/jsQR.js` file) for the camera
   scanner on iPhone/iPad.

## Sources

- MDN, Mixed content: https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content
- Tailscale serve: https://tailscale.com/kb/1312/serve ; HTTPS: https://tailscale.com/kb/1153/enabling-https
- WebKit, Web Push for Web Apps on iOS and iPadOS: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- Apple, Sending web push notifications: https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
- W3C Push API, subscribe(): https://www.w3.org/TR/push-api/#subscribe-method
- RFC 8030, RFC 8291, RFC 8292
- WebKit storage: https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ ,
  https://webkit.org/blog/14403/updates-to-storage-policy/
