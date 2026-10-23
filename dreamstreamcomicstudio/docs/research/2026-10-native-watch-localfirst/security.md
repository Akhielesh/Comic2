# DreamStream baby monitor: STRIDE threat model and security hardening plan

Repo root for every path below: `/home/user/Comic2/dreamstreamcomicstudio/`. I only read the code and made no edits. Platform facts are as of October 2026, with sources at the end.

---

## 0. Verdict

The base is better than most consumer monitors:
- Tokens are never put in URLs for the monitor or calls; auth happens in the first socket frame.
- Supabase tables are locked down and only reachable through RPCs.
- Guest passcodes are hashed with PBKDF2 and lock out after wrong tries.
- Call tickets are stored only as hashes.
- Web Push payloads are encrypted.
- On-device AI models are checked against a SHA-256 hash before use.
- CSV exports already neutralise spreadsheet formulas.

There are **five gaps that matter for "never intercepted, never leaked, never hijacked"**:
1. **Open sessions are never re-checked.** A WebSocket keeps whatever role it had when it connected, for its whole life. That survives being removed, being demoted, "sign out everywhere", and a password reset after an account takeover.
2. **Removed people keep getting alerts**, and **a removed guest can just rejoin** with the same link and passcode.
3. **Our server can see and steer media.** Relay JPEG frames are readable in the Durable Object. Signaling is not authenticated end to end, so whoever controls the Worker could swap DTLS fingerprints and sit in the middle of the "peer-to-peer" video.
4. **There is no CSP or any security header on `/` or `/live`.** The Supabase refresh token sits in localStorage on an origin shared with the large AI-chat app, so one XSS anywhere becomes a full account takeover, monitor included.
5. **No MFA, no passkeys, no new-device alerts.** In `/live`, "sign out" only signs out the current device.

All five can be fixed with no recurring cloud cost.

---

## 1. Who can see what today

| Data | Camera/viewer devices | Our Durable Object (Cloudflare memory) | Cloudflare TURN | Apple/Google/Mozilla push | Supabase |
|---|---|---|---|---|---|
| P2P/TURN video and audio | yes | **no** (DTLS-SRTP) | no (sees ciphertext only) | – | – |
| Relay picture (JPEG, sent when P2P fails) | yes | **yes, plaintext** (`monitorRoom.ts:622-635`) | – | – | – |
| SDP and ICE (DTLS fingerprints, home and LAN IPs) | yes | **yes, and can modify them** (`onRtc` `:908`) | – | – | – |
| Status, sound classes, sleep, tracker, logs, baby name | yes | yes (needed for the alert engine) | – | Web Push: no (RFC 8291 encryption) | names, membership |
| Account session | localStorage (`services/supabase.ts:115`) | token in transit only | – | – | yes |

---

## 2. STRIDE by component (current code)

| Component | S – Spoofing | T – Tampering | R – Repudiation | I – Information disclosure | D – Denial of service | E – Elevation of privilege |
|---|---|---|---|---|---|---|
| MonitorRoom auth (`monitorRoom.ts:771-808`) | Any caregiver or parent can take over a camera's `dev` id; the real camera is closed with 4005 (`:839-846`) | Signaling relayed in plaintext, so whoever runs the Worker can rewrite `a=fingerprint` | Logs exist, but there is no per-device identity | Relay frames; removed members' push subscriptions | Unauthenticated sockets count toward the 42-slot cap (`:553`) | Role cached at auth time, so a demoted parent keeps admin powers until reconnect |
| Guests (`monitorGuests.ts`) | Guest pass is a 90-day bearer token in localStorage (`live/monitor/guest.ts:79`), not tied to a device | Viewer guests can write logs and steer the sleep tracker (`onLog` `:1424`, no role check) | – | Viewer guests can query history, tracker, reports and weeks (`onQuery`, no role gate) | 20 wrong passcodes turn the link off for everyone (griefing); per-IP limiter lives in DO memory (`:168`) | Removed guest rejoins with the same link and passcode |
| UserLine and CallRoom | Tickets OK | `call_rtc` limited to call members (OK) | – | – | 10-slot cap counts unauthenticated sockets (`userLine.ts:193`); user UUIDs come back from `live_search_people` | – |
| TURN (`ice.ts:27-59`) | One 24-hour credential, cached per isolate, handed to every member, guest and caller | – | Can't be revoked per person | – | Cost abuse by removed guests for up to 24 hours | – |
| Web front end | – | – | – | **No CSP or headers** (`public/_headers` only has cache rules); third-party importmap (`index.html:26`) | – | XSS gives the refresh token, which gives full account takeover |
| Supabase (`server/sql/live_accounts_and_monitor.sql`) | No MFA or `aal` checks | A hijacked parent can silently add a second account as parent, which survives the victim's password reset | – | – | – | Membership changes produce no alert |
| Push (`:1824`) | – | – | – | Baby and nursery names in the payload (fine for Web Push, **not** acceptable for APNs/FCM) | – | – |

---

## 3. Verified findings (severity first)

| # | Sev | Finding | Pointer | Fix |
|---|---|---|---|---|
| F1 | **High** | Sockets are authorised once and never again. Not ended by: token expiry, `signOut({scope:'global'})`, password reset, role demotion, or a removal made from another client. | `live-worker/src/monitorRoom.ts:771-808` (role stored in the attachment), `userLine.ts:293`, `live/monitor/client.ts` (re-auth only on reconnect) | §4.2 |
| F2 | **High** | A removed member keeps getting monitor pushes ("Baby is crying", morning report, guest notices). `onMembersChanged` prunes `callPush` but not `push`, and `pushAlert` never re-checks membership. | `monitorRoom.ts:2001` vs `:1820-1841` | Prune `push` by the member id set; prune again on every re-auth failure |
| F3 | **High** | "Remove guest" only revokes that guest's session. The link and passcode stay valid, so the removed person rejoins immediately. Parents are notified, but the access works. | `monitorGuests.ts` `removeGuest`, `join` | Now: removal also rotates the link and passcode. Next: per-guest single-use invites (§4.3) |
| F4 | **High (design)** | Relay frames pass through the DO as plaintext JPEG. SDP and ICE are relayed readable and modifiable, so a compromised deploy token or Worker can view the relay picture or MITM DTLS. | `monitorRoom.ts:622-635`, `:908-918` | Nursery key (§4.1) |
| F5 | **High** | No CSP, HSTS, `frame-ancestors`, Permissions-Policy or nosniff on the pages. The refresh token is in localStorage on the same origin as the AI chat, comics and connectors. | `public/_headers`, `functions/_middleware.ts`, `services/supabase.ts:115` | §4.6 |
| F6 | Med | Removal only takes effect if the *removing client* sends `members_changed`. Old clients, the main app, or "leave" don't kick anyone. | `live/monitor/client.ts:462`, SQL `monitor_remove_member` | Route membership changes through the Worker (§4.2) |
| F7 | Med | Camera spoofing: any caregiver or parent socket can claim an existing camera `dev`, replacing the real camera and suppressing its offline alerts. | `monitorRoom.ts:839-846` | Now: only the same uid may replace it. Next: camera pairing credential (§4.4) |
| F8 | Med | Pre-auth socket exhaustion: anyone who knows a nursery UUID (it is in every guest link) or a user UUID (people search) can block the family for 10 s at a time, repeatedly. | `monitorRoom.ts:553`, `userLine.ts:193` | Don't count unauthenticated sockets; small separate unauthenticated cap with oldest-first eviction; `AUTH_TIMEOUT` 5 s; per-IP rate limit (§4.8) |
| F9 | Med | No MFA or passkeys and no `aal` enforcement. `/live` "sign out" is `scope:'local'` (`live/sync.ts:162`, `signOutEverywhereLocal`, which is misnamed). No new-device or membership alerts. | – | §4.5 |
| F10 | Med | One shared 24-hour TURN credential per isolate (Cloudflare says to mint per user). Can't be revoked when a guest is removed. | `live-worker/src/ice.ts:27-59` | §4.9 |
| F11 | Med | Guest pass is a bearer token, stored for 90 days, not bound to a device. | `live/monitor/guest.ts:79` | Device-bound key (§4.3) |
| F12 | Low–Med | Least privilege is missing in several handlers: `onQuery` has no role gate; `onLog` lets viewers write logs and steer the sleep tracker; caregiver guests can acknowledge alarm and glass hazards, which stops escalation. | `:1424`, `onQuery`, `:1530` | Gate viewer guests to live view and live alerts; hazards marked `everyone` keep escalating unless a member acknowledges |
| F13 | Low–Med | Guest per-IP limiter is in-memory and per DO. Anyone holding the link can disable it with 20 wrong tries. | `monitorGuests.ts:168,234` | Rate Limiting binding; per-guest invites remove the shared-link target |
| F14 | Low | `onRtc` only blocks same-mode pairs, so admin and line sockets can signal viewers. | `monitorRoom.ts:914` | Allow camera↔viewer only |
| F15 | Low | No `Origin` allowlist on WebSocket upgrades. Not exploitable today because tokens come in the first frame; this is defence in depth. | `live-worker/src/index.ts:144,209` | Allow the listed origins or no Origin (native apps) |
| F16 | Low (Stream Studio) | Host and guest keys in query strings (`/stats?k=`, `/exit?k=`, `recordings?k=`, WebSocket `?k=&g=&token=`), which land in logs; compared non-constant-time. | `index.ts`, `eventRoom.ts:516-526` | First-frame auth like the monitor; constant-time compare |
| F17 | Med | Supply chain: see the list below. | `index.html:24-35`, `package.json` | §4.11 |
| F18 | Info | Push payloads carry baby and nursery names. | `monitorRoom.ts:1824` | Keep for Web Push; minimise for APNs/FCM (§4.7) |

F17 supply-chain details:
- `index.html` has an importmap pointing at `aistudiocdn.com` with caret ranges (`^19.2.0`). It is dead code but still a third-party, unpinned source.
- jsPDF 2.5.1 and html2canvas load from cdnjs without SRI.
- `onnxruntime-web` is on a dev nightly (`1.26.0-dev.20260416`); stable 1.30.0 exists.
- `npm audit --omit=dev`: **1 critical** (proxy-addr, which makes `req.ip` spoofable and so weakens the auth-email per-IP limits) and **8 high** (react-router, sharp/libvips, adm-zip, and others).
- GitHub Actions are pinned by tag, not by SHA.
- One shared `CLOUDFLARE_API_TOKEN` is used by every deploy workflow.

**Keep as they are:** first-frame auth; RPC-only RLS with `search_path=''`; PBKDF2 passcodes, lockouts and parent notices; hashed tickets; CSV escaping; hash-pinned models; `token_hash` auth links with an origin allowlist and masked logs; the VAPID private key never leaving the KEY_HOLDER DO.

---

## 4. Designs

### 4.1 Nursery key: E2E relay frames, sealed signaling, and support for watches and a local mode

**Device keys.** Each install generates two key pairs:
- an ECDSA P-256 signing key, and
- an ECDH P-256 key-agreement key.

Where they live:
- Web: non-extractable WebCrypto keys in IndexedDB.
- iOS and watchOS: Secure Enclave (CryptoKit `SecureEnclave.P256`).
- Android and Wear OS: Keystore, using StrongBox when available.

The device record `{devId = hash(sigPub), principal (uid | guestId | camera), sigPub, ecdhPub}` is stored in a new DO table `mon_devices`.

**Nursery Media Key (NMK).**
- 32 random bytes per epoch `e`, created by the first parent device. **The server only ever stores wrapped copies.**
- Wrapping: ECDH(ephemeral key, device's ecdhPub) → HKDF-SHA256 (info `ds-nmk|nid|e|devId`) → AES-256-GCM. The result goes in table `mon_keywraps(e, devId, blob)`.
- **Who hands out keys:** an online key-holding device. The camera is always online while monitoring; otherwise any parent device. When a new device is admitted, the DO sends `key_req` and the holder wraps NMK to that device's public key. Every new device triggers a push to all parents ("Grandma's iPhone was added"). An optional "Require approval for new devices" setting adds a tap to approve on a parent's phone.
- **Rotation:** when a member, guest or device is removed, the camera creates epoch `e+1` and wraps it only to the remaining devices. The old epoch is accepted for 60 s.
- **Losing every device is harmless**, because nothing is recorded. A parent simply creates a new NMK.

**Relay frames.**
- Header (all authenticated as AAD, together with `nid`):
  - version: u8
  - epoch: u32
  - camera index: u16
  - sequence number: u64
  - timestamp: u48
  - keyframe flag
- Encryption: AES-256-GCM with key `HKDF(NMK_e, "frame|"+camDev)`. Nonce = 4-byte salt for the epoch + the 8-byte sequence number.
- The viewer drops a frame if its sequence number is not higher than the last one seen, or if it is more than 10 s old.
- Works the same for JPEG today and for WebCodecs chunks next. The CPU cost is well under 1 ms per frame.
- **The DO forwards bytes it cannot read.**

**Sealed signaling.**
- `rtc.d` becomes `{e, iv, ct}`, where `ct = AES-GCM(HKDF(NMK,"sig"), {sdp|cand, fromDev, toDev, ts})` and the AAD is `nid|fromDev|toDev`.
- The DO still routes by `sid`, but can no longer read or forge offers, answers or ICE candidates. That authenticates the DTLS fingerprints, so P2P and TURN media become truly end to end, and home IPs disappear from what the server sees.
- Phase 2 (optional): also sign the inner payload with the device signing key, so one key holder can't impersonate the camera to another.
- Do **not** build SFrame or `RTCRtpScriptTransform` now. It is only needed if an SFU is ever added. It is supported from Chrome 141 and Firefox 117; Safari support is unconfirmed.

**Watches.** The Apple Watch and the Wear OS watch are enrolled devices with their own keys. The paired phone wraps NMK to them over WatchConnectivity or the Wearable Data Layer, both of which are encrypted pairing channels. A watch decrypts relay snapshots with CryptoKit or Tink.

**Local mode (native only).** The same NMK-sealed messages run over a LAN socket, so no cloud is needed once a device is enrolled. Bonjour/NSD instance names are `HMAC(NMK,"lan")[:8]`, never the baby's name.

### 4.2 Session lifecycle: re-auth, revocation, role changes

**Client.** On Supabase `TOKEN_REFRESHED`, send `{t:'reauth', token}` on every open DO socket (monitor, line, admin).

**DO.**
- On re-auth, call `monitor_my_role` (or `live_me`). Update `role` and `label` in the attachment; if `!ok`, close with 4004 and prune that uid's `push` and `callPush`.
- Store the JWT `exp` (decoded for scheduling only, because the RPC already verified it). The alarm closes any socket where `now > exp + 5 min` with 4001.

**SQL** (inside `monitor_my_role` and `live_me`; SECURITY DEFINER can read `auth.*`):
```sql
if not exists (select 1 from auth.sessions s where s.id = nullif(auth.jwt()->>'session_id','')::uuid)
  then return jsonb_build_object('ok', false, 'error', 'session_revoked'); end if;
if exists (select 1 from auth.mfa_factors f where f.user_id = v_uid and f.status = 'verified')
   and coalesce(auth.jwt()->>'aal','aal1') <> 'aal2'
  then return jsonb_build_object('ok', false, 'error', 'mfa_required'); end if;
```
Result: a global sign-out or a revoked session ends every DO socket within one token lifetime. Set the JWT expiry to 15–30 min; Supabase advises against values under 5 min.

**Immediate kick.**
- New `POST /api/me/kick` (bearer token). The Worker verifies the caller, lists their nurseries with `monitor_list`, sends `/x/kick {uid}` to each MonitorRoom and the UserLine, and deletes that uid's push and callPush records. The client then calls `signOut({scope:'global'})`.
- Make this the real "Sign out everywhere" in `/live`, and rename the current local one.

**Server-side membership changes.**
- New `POST /api/monitor/:nid/members {op, user, role, label}`. The Worker calls the RPC with the parent's token, then sends `/x/members {ids}` to the DO.
- The DO then:
  - kicks removed members,
  - prunes their push records,
  - rotates the NMK,
  - pushes to every parent: "Alex added Sam as a parent".
- This fixes F2, F6 and the "persistent co-parent backdoor" scenario.

### 4.3 Guest access v2

- **Per-guest, single-use invites.** Each invite has a 128-bit code, a passcode, a role, an expiry, and `max_uses=1`. Joining consumes the invite and binds it to the guest's device key (non-extractable WebCrypto or native). Socket auth is a signature over the room's pre-auth nonce: `sign(nid|nonce|ts)`. A stolen localStorage token alone becomes useless. A leaked link that has already been used is dead, and there is no shared target to grief.
- **On removal:** revoke the device, rotate the NMK, and revoke the guest's TURN username.
- **Least privilege:**
  - Viewer guests get live view, listening and live alerts only.
  - History, tracker and reports become opt-in per guest.
  - A guest's acknowledgement never cancels an `everyone` hazard.
- **Keep:** PBKDF2 with 100k rounds, the 5-try lock, parent notices, the token stored only as a hash. Add the Rate Limiting binding (10 per IP per 60 s, 30 per nursery per 60 s).

### 4.4 Camera pairing credential for the spare phone

- The parent's phone shows a QR code containing the nursery id and a one-time code that expires in 2 min.
- The spare phone generates a device key and calls `/api/monitor/:nid/pair`. It receives a **camera-only credential bound to that key**, and its `dev` id is the hash of the public key.
- There is **no Supabase session on the spare phone**. If it is stolen or left unlocked, it can only act as a camera for that nursery, and parents can revoke it in one tap.
- This removes F7 and keeps the parent's account off an old, rarely updated device.

### 4.5 Account takeover program

**MFA**
- TOTP enrolment UI in `/live` and on native.
- Enforce aal2 for every user who has a verified factor (SQL in §4.2).
- Parents must step up to aal2 before: creating share links, adding members, export, adding a device, enrolling a passkey.
- Prompt for MFA when a nursery is created.

**Passkeys**
- Supabase passkeys are **experimental** (beta announced 28 May 2026). They need `supabase-js ≥ 2.105.0` with `auth.experimental.passkey`; the repo has 2.95.3. `supabase-swift ≥ 2.48` supports them on iOS 16+.
- Adopt them in the native apps first, behind a flag. Require aal2 or a recent re-auth **before enrolling a passkey**: an unconfirmed static-analysis report says registration does not require step-up. Send an alert email whenever a passkey is added.

**Passwords**
- Follow NIST 800-63B-4: at least 15 characters if the password is the only factor, at least 8 with MFA, no composition rules, check against breached passwords.
- Practical setting: minimum 12, plus Supabase leaked-password protection (Pro plan, per third-party sources). On the Free plan, run a k-anonymity Pwned Passwords check in `server/src/routes/authEmail.ts` at sign-up and in the client before password change.
- Turn on Supabase's secure email change and secure password change.

**New-device sign-in alerts**
- Use a Custom Access Token hook (available on Free and Pro). It sees `session_id` on every token issue; on a session id it hasn't seen before, it inserts into `security_events` and calls `pg_net` to post to the email Worker (HMAC-signed with a secret in Vault).
- The email gives device, time and masked IP, plus **"Not you? Secure my account"**. That link signs out every session, revokes TURN credentials, kicks DO sockets and starts a password reset.
- Mirror the alert as a push to the user's other devices, reusing the UserLine push subscriptions.

**Supabase security notifications** (password changed, email changed, MFA added or removed, identity linked)
- Enable them. Route them through the **Send Email Hook** to our email Worker so they are not stuck behind the default mailer's rate limit.

### 4.6 CSP and security headers

Cloudflare `_headers` rules do **not** apply to Functions responses, so set the headers in `functions/_middleware.ts` on the response from `next()`. Also add them to `public/_headers` under `/*` for static assets and `live-sw.js`.

**`/live` — enforce now:**
```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com;
 worker-src 'self'; connect-src 'self' wss://dreamstreamstudio.ai https://bdjfmxfmhqhzvgrhbbzm.supabase.co
 wss://bdjfmxfmhqhzvgrhbbzm.supabase.co https://dreamstream-live.akhieleshsrirangam.workers.dev
 wss://dreamstream-live.akhieleshsrirangam.workers.dev https://www.googleapis.com;
 img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
 font-src 'self' https://fonts.gstatic.com; frame-src https://challenges.cloudflare.com; manifest-src 'self';
 object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests; report-to csp
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(self), microphone=(self), display-capture=(self), screen-wake-lock=(self), fullscreen=(self), geolocation=(), payment=(), usb=()
Cross-Origin-Opener-Policy: same-origin-allow-popups
```
Notes on this policy:
- `same-origin-allow-popups` keeps the Drive OAuth popup working.
- Turnstile needs `challenges.cloudflare.com` in both `script-src` and `frame-src`; a nonce works too.
- `'wasm-unsafe-eval'` is for ONNX and MediaPipe WASM.
- Drop the Hugging Face YAMNet fallback (`live/monitor/yamnet.worker.ts:13`). The model is self-hosted and hash-checked, so `connect-src` stays tight.
- Ship as Report-Only for 48 h first to confirm MediaPipe's loader needs nothing more.
- Add `require-trusted-types-for 'script'` in report-only mode; MediaPipe's script loading would break if it were enforced.

**`/` — Report-Only only.** The chat artifacts use `srcdoc` iframes, and **`srcdoc` iframes inherit the parent page's CSP**, so a strict `script-src` would break them. Move the artifact runner to a separate sandbox domain (a free Pages project), then enforce. Also:
- delete the importmap (`index.html:26-35`);
- bundle jsPDF (current version) and html2canvas through npm with lazy import, or pin them with SRI;
- add a hash for the splash watchdog inline script.

**Report endpoint:** `POST /live-api/csp` keeps counts only; CSP reports never contain URL fragments.

### 4.7 Push privacy

- **Web Push:** already RFC 8291 end-to-end to the browser. Keep it; prune on removal (F2).
- **APNs:**
  - Payload is generic plus `mutable-content:1` plus `e = AES-GCM(devicePushKey, {kind,title,body,ref,at})`.
  - A Notification Service Extension decrypts using a shared App Group Keychain. It has about 30 s; on failure it shows generic text.
  - Use `interruption-level: time-sensitive`. Use critical alerts for smoke/CO, glass and crib exit once the entitlement is granted.
- **FCM:** data-only, high priority, carrying `{n, e}`. `FirebaseMessagingService` decrypts and posts the notification locally, with one channel per alert kind.
- **devicePushKey:** generated on the device and registered over the authenticated socket. Apple and Google then see only ciphertext and timing.
- Prune APNs and FCM tokens on removal or kick, exactly like push subscriptions.

### 4.8 Rate limits and DoS

- Add a Workers **Rate Limiting binding** (`ratelimits` in `live-worker/wrangler.jsonc`; period 10 or 60 s; eventually consistent):
  - `RL_GUEST`: 10 per 60 s per IP, plus 30 per 60 s per nursery, on `/api/monitor/*/guest`.
  - `RL_WS`: 60 per 60 s per IP across every WebSocket upgrade.
  - Event creation: per uid.
- Unauthenticated sockets get a separate cap of 8 per DO with oldest-first eviction; `AUTH_TIMEOUT_MS` goes from 10 s to 5 s, in both MonitorRoom and UserLine.

### 4.9 TURN credentials

- Mint per authenticated socket with a TTL of at most 4 h. For guests, use the shorter of 4 h and the pass expiry.
- Refresh in place with `pc.setConfiguration()`.
- Store the issued `username` per principal and call `POST …/credentials/{username}/revoke` on removal or kick.
- Remove the module-level shared cache (`ice.ts:27`).

### 4.10 Logging and PII

- The monitor and calls already log no tokens, SDP or IPs (for example `call_stats`), which is good.
- Fix F16 so host and guest keys stop appearing in Worker or analytics URLs.
- Add a per-nursery **Security log** that parents can see: sign-ins, devices added or removed, member or role changes, share links, guest joins, kicks. Most of the hooks already exist through `addLog` with kind `people`.

### 4.11 Supply chain

- `npm audit fix` for proxy-addr (critical), react-router, sharp and adm-zip.
- `onnxruntime-web` → 1.30.0 stable.
- `supabase-js` → 2.118.
- Pin GitHub Actions by SHA; workflow default `permissions: contents: read`.
- **GitHub Environments with required reviewers** for every deploy and signing secret.
- **One least-privilege Cloudflare token per Worker.**
- `npm ci --ignore-scripts` where the build allows it.
- Dependabot with a cooldown window. npm 11.10+ also has `min-release-age`, measured in days; pnpm's `minimumReleaseAge` is in minutes.
- Turn on CodeQL default setup, secret scanning with push protection, and the OpenSSF Scorecard action (all free on public repos).
- The repo is public, so treat `wrangler.jsonc` vars as public (they are), and later migrate the legacy anon JWT in `api-proxy/wrangler.jsonc:57` to the publishable key.

### 4.12 Native specifics

- **Secret storage:**
  - iOS: Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so the camera can reconnect while locked and nothing syncs to iCloud; device keys in the Secure Enclave.
  - Android: `EncryptedSharedPreferences` is deprecated. Use DataStore with Tink AEAD and a Keystore key (StrongBox if present). Exclude tokens from backup with `dataExtractionRules`.
- **No certificate pinning.** Cloudflare rotates edge certificates and does not support pinning them; pinning causes outages. Instead:
  - rely on OS TLS (ATS on iOS);
  - on Android, set cleartext off, trust no user CAs, and turn on `certificateTransparency` (API 36);
  - enable Cloudflare CT monitoring.
  
  The NMK makes a TLS MITM useless against media and signaling anyway.
- **App Attest and Play Integrity:**
  - Use them only at enrolment-type moments: sign-in, adding a device, camera pairing, guest join from the app, minting TURN for non-members. Treat them as a **risk signal**, not as authentication.
  - Play Integrity's default quota is **10,000 requests/day per app**, so never call it per socket.
  - Verify App Attest attestations in a Worker with WebCrypto plus a small CBOR parser.
- **Watches:** each watch gets its own scoped viewer credential from the paired phone and never holds the account refresh token. Complications show state only, never images. Snapshots are hidden when wrist detection is off.
- **Other app hardening:**
  - Blur the app-switcher snapshot.
  - Android: `setRecentsScreenshotEnabled(false)` on viewer screens.
  - Optional Face ID / biometric lock to open the viewer.
  - Camera mode prompts for Guided Access or screen pinning and warns about outdated OS versions.

---

## 5. Prioritised fix list

**(A) Ship now, web and Worker** (S = small, M = medium, L = large):
1. **S — Stop alerts and access after removal.** Prune `push` on membership changes; add the Worker-mediated `/api/monitor/:nid/members` route; alert all parents on member or role changes. (F2, F6)
2. **M — Socket re-auth, expiry enforcement and role refresh.** Add the session and `aal` checks to `monitor_my_role` and `live_me`; add a real "Sign out everywhere" with `/api/me/kick`. (F1, F9)
3. **S — Make guest removal stick.** `removeGuest` rotates the link and passcode; parents get a one-tap "share the new link". (F3)
4. **S — Headers and CSP.** Enforce on `/live`, Report-Only on `/` (in `functions/_middleware.ts` and `public/_headers`); delete the importmap; bundle or SRI the CDN scripts; drop the Hugging Face fallback. (F5, F17)
5. **S — DoS hardening.** Unauthenticated sockets get their own cap; Rate Limiting binding on WebSocket upgrades and guest join; `AUTH_TIMEOUT` 5 s. (F8, F13)
6. **S — Camera spoofing.** Only the same uid may replace a camera's `dev`. (F7)
7. **S — TURN.** Per-socket credentials with a TTL of at most 4 h, plus revoke on removal. (F10)
8. **S — Least privilege.** Gate `onQuery` and `onLog` for viewers and guests; hazard acknowledgement rules for guests; `onRtc` camera↔viewer only; WebSocket Origin allowlist. (F12, F14, F15)
9. **S — Supply chain.** npm audit fixes, stable ORT, SHA-pinned actions, Dependabot cooldown, CodeQL and secret scanning, per-Worker tokens, Environments. (F17)
10. **L — Nursery key.** E2E relay frames and sealed signaling, plus device enrolment and new-device notices. (F4)
11. **M — Device binding.** Camera pairing credential and device-bound per-guest invites. (F7, F11, F3)
12. **M — MFA and alerts.** TOTP UI and aal2 step-up for admin actions; new-device and security alerts through the Custom Access Token hook and the Send Email Hook. (F9)
13. **S — Stream Studio keys.** Move keys out of URLs and compare in constant time. (F16)

**(B) Needs the native apps:**
- Keychain/Keystore and Secure Enclave/StrongBox storage, with no backup.
- No pinning, plus CT on Android.
- App Attest and Play Integrity at enrolment.
- Encrypted APNs (Notification Service Extension) and FCM data payloads; critical alerts.
- Passkeys (once Supabase marks them stable) with Face ID or fingerprint.
- Watch and Wear OS as separately scoped, enrolled devices.
- LAN local mode on NMK-sealed signaling.
- Camera-device hardening (pinning prompts, OS checks).

**(C) Owner actions:**
- **2FA with a hardware key or passkey on Cloudflare, GitHub, Supabase, Apple and Google.** A compromised deploy token is today's biggest single path to the feed, until item A10 ships.
- Supabase:
  - switch to asymmetric (ES256) JWT signing keys, then revoke the legacy HS256 secret and the legacy anon/service keys;
  - JWT expiry 15–30 min;
  - enable TOTP MFA;
  - enable security notification emails through the Send Email Hook;
  - secure email change and secure password change;
  - minimum password length 12 or more;
  - CAPTCHA on sign-in and recovery;
  - decide whether to buy **Pro** for leaked-password protection and session time-box/inactivity limits.
- Cloudflare:
  - HSTS preload (after confirming every subdomain serves HTTPS);
  - CT monitoring;
  - optional WAF rate-limit rule on `/live-api/api/monitor/*/guest`;
  - one API token per Worker.
- GitHub: branch protection on `main`, CODEOWNERS for `.github/workflows`, Environments holding the APNs `.p8`, signing certificates, Play upload key and FCM service account.
- Apple: App Attest capability, Critical Alerts entitlement request, Associated Domains (`webcredentials`) for passkeys.
- Google: link the Play Integrity Cloud project; FCM v1 service account stored as a Worker secret.
- Publish `/.well-known/security.txt` and a disclosure policy, and update the privacy policy to match §6.

---

## 6. Security claims for product copy

**True today:**
- "The baby monitor never records. No video or audio is stored on our servers."
- "When your devices connect directly, or through our TURN relay service, video and audio are encrypted between your devices with the WebRTC standard (DTLS-SRTP). The relay forwards encrypted data it can't read."
- "Sound and video analysis runs on the camera phone. Only results like 'crying, 92%' are shared with your family."
- "Share links need a passcode. 5 wrong tries lock the link, and parents are notified whenever someone joins."
- "Web alerts are encrypted to your device."

**True after A1–A10:**
- "Our servers can't see your video, even when the network forces us to relay it."
- "Removing someone takes effect immediately on every device."
- "Signing out everywhere ends every session."
- "Every new device, member or guest is announced to all parents."

**True after B:**
- "Notification content is encrypted. Apple and Google only see that an alert arrived."
- "Keys are kept in your phone's secure hardware."
- "Local mode works without the internet."

**Never say:**
- "unhackable", "military-grade", "zero-knowledge" (the server processes alerts, sleep, tracker data and names);
- "end-to-end encrypted" without qualification, before A10;
- "no one can ever intercept";
- HIPAA or COPPA compliance claims.

---

## Sources

- Supabase passkeys docs (experimental): https://supabase.com/docs/guides/auth/passkeys
- Supabase passkeys beta changelog: https://supabase.com/changelog/46458-passkeys-for-supabase-auth-beta
- Unconfirmed report on passkey registration without step-up: https://red.anthropic.com/2026/cvd/findings/ANT-2026-0JJXMV3G
- Supabase MFA and `aal`: https://supabase.com/docs/guides/auth/auth-mfa
- Supabase sessions (rotation, Pro-only limits, JWT expiry): https://supabase.com/docs/guides/auth/sessions
- Supabase JWT signing keys: https://supabase.com/blog/jwt-signing-keys and https://supabase.com/docs/guides/auth/jwts
- Supabase auth hooks (plan availability): https://supabase.com/docs/guides/auth/auth-hooks
- Supabase security notifications: https://supabase.com/changelog/40349-notify-users-about-security-sensitive-actions-on-their-accounts and https://supabase.com/blog/introducing-seven-new-email-templates-for-auth
- Leaked-password protection on Pro (third-party source): https://www.guardlayer.io/blog/supabase-leaked-password-protection
- Cloudflare Workers Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Cloudflare TURN per-user credentials and revoke: https://developers.cloudflare.com/realtime/turn/generate-credentials/
- Turnstile CSP: https://developers.cloudflare.com/turnstile/reference/content-security-policy/
- Pages `_headers` not applied to Functions: https://developers.cloudflare.com/pages/configuration/headers/
- Cloudflare on certificate pinning: https://developers.cloudflare.com/ssl/reference/certificate-pinning/ and https://blog.cloudflare.com/why-certificate-pinning-is-outdated
- `RTCRtpScriptTransform` support: https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpScriptTransform
- Android Network Security Config (CT): https://developer.android.com/privacy-and-security/security-config
- EncryptedSharedPreferences replacement: https://mas.owasp.org/MASTG/best-practices/MASTG-BEST-0050/ and https://proandroiddev.com/goodbye-encryptedsharedpreferences-a-2026-migration-guide-4b819b4a537a
- Play Integrity quotas: https://developer.android.com/google/play/integrity/setup
- App Attest: https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity
- Notification Service Extension: https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications
- NIST 800-63B-4 summary: https://www.enzoic.com/blog/nist-sp-800-63b-rev4/
- npm release-age cooldowns: https://github.com/npm/cli/pull/8825 and https://cloudsmith.com/blog/how-to-configure-time-for-cooldown-policies
- Web Push encryption: https://www.rfc-editor.org/rfc/rfc8291

## Key files (absolute paths)

- /home/user/Comic2/dreamstreamcomicstudio/live-worker/src/monitorRoom.ts
- /home/user/Comic2/dreamstreamcomicstudio/live-worker/src/monitorGuests.ts
- /home/user/Comic2/dreamstreamcomicstudio/live-worker/src/userLine.ts
- /home/user/Comic2/dreamstreamcomicstudio/live-worker/src/callRoom.ts
- /home/user/Comic2/dreamstreamcomicstudio/live-worker/src/ice.ts
- /home/user/Comic2/dreamstreamcomicstudio/live-worker/src/index.ts
- /home/user/Comic2/dreamstreamcomicstudio/live-worker/src/supabaseAuth.ts
- /home/user/Comic2/dreamstreamcomicstudio/live-worker/wrangler.jsonc
- /home/user/Comic2/dreamstreamcomicstudio/live/monitor/client.ts
- /home/user/Comic2/dreamstreamcomicstudio/live/monitor/guest.ts
- /home/user/Comic2/dreamstreamcomicstudio/live/monitor/yamnet.worker.ts
- /home/user/Comic2/dreamstreamcomicstudio/live/sync.ts
- /home/user/Comic2/dreamstreamcomicstudio/services/supabase.ts
- /home/user/Comic2/dreamstreamcomicstudio/server/sql/live_accounts_and_monitor.sql
- /home/user/Comic2/dreamstreamcomicstudio/server/src/routes/authEmail.ts
- /home/user/Comic2/dreamstreamcomicstudio/functions/_middleware.ts
- /home/user/Comic2/dreamstreamcomicstudio/public/_headers
- /home/user/Comic2/dreamstreamcomicstudio/public/live-sw.js
- /home/user/Comic2/dreamstreamcomicstudio/index.html
- /home/user/Comic2/.github/workflows/