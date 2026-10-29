# 0006 — Native apps, watch companions, local-first, and security

- **Status:** Proposed
- **Date:** 2026-10-22
- **File:** `docs/decisions/0006-native-apps-watch-local-first-security.md` (add the row `| 0006 | Native apps, watch companions, local-first, and security | Proposed |` to `docs/decisions/README.md`)
- **Related:** `docs/features/baby-monitor.md`, `docs/infrastructure/`. ADRs 0001–0005 are unaffected.
- **Inputs:** four studies made on 2026-10-22 (native app architecture; local-first and cost; STRIDE security; Apple Watch and Wear OS design). Every disagreement between them is settled in D9. Platform facts are as of October 2026 and are listed under Sources. Paths are relative to `dreamstreamcomicstudio/` unless they start with `/home/user/Comic2/`.

---

## Summary

| # | Area | Decision |
|---|---|---|
| D1 | Phone apps | We build **Expo SDK 58 (React Native 0.88)** apps for iOS and Android. They share one TypeScript core with the web app and the Worker. Media, alerts, keys and the watch bridge are native Swift/Kotlin **Expo modules**. The PWA stays for desktop, guests and as a fallback. |
| D2 | Shared core | `packages/monitor-core` holds the pure TypeScript: protocol, Glance v1, sealing crypto and the alert/sleep engines. Golden fixtures are checked in vitest, XCTest and JUnit. |
| D3 | Push | One router in the Worker: Web Push (as today), **APNs sent directly** (production `fetch` speaks HTTP/2; a probe gates it), and **FCM HTTP v1** for Android and Wear (also the iOS fallback). Payloads are end-to-end encrypted to each device, so Apple and Google see only that an alert arrived. |
| D4 | Watches | **Fully native.** A SwiftUI app for watchOS 26 with WidgetKit complications and the Smart Stack Live Activity. A Kotlin/Compose Wear OS app with a Tile and complications. The Apple Watch has no sockets and no WebRTC. One small **Glance v1** contract (under 512 B) is used everywhere. Watches hold scoped, hardware-bound **device grants**, never account tokens. |
| D5 | Local-first | The camera phone becomes the **Nursery Hub** (native apps). The Connection setting offers **Automatic** (default) and **Home Wi-Fi only**, plus **Internet only** under Advanced. LAN and cloud use the same protocol. Whichever path delivers an alert first raises it; events are de-duplicated by `eid`. |
| D6 | Security | Defence in depth, centred on a **Nursery Media Key (NMK)** our servers never hold. Phase 0 brings end-to-end relay frames and sealed signaling; Phase 1 adds verified device admission. Session lifecycle, MFA, new-device alerts, CSP and least privilege ship now. Every public claim is tied to the phase that makes it true (D6.4). |
| D7 | Cost | Phase 0 makes cloud cost per nursery about **5 times lower**; rows written to Durable Object storage are the main lever. Phase 4 plus coturn reaches about **$0.04 per nursery-month at 100k nurseries**. |
| D8 | Build | **GitHub Actions only**, which is free for this public repo: ubuntu runners for TypeScript, Android and Wear; `macos-26` for iOS and watchOS. Signing secrets live only in protected Environments. No EAS. |

---

## Context

### What exists today
- **Stream Studio** is a PWA at `/live`. Its baby monitor (`live/monitor/**`, `live/views/Monitor*.tsx`) works like this:
  - A spare phone is the camera.
  - Family members watch from other devices over WebRTC, peer to peer (DTLS-SRTP), with Cloudflare TURN when needed.
  - When P2P fails, a JPEG relay picture goes through the `MonitorRoom` Durable Object (DO).
  - Sound AI runs on the device (YAMNet ONNX plus heuristics), along with vision (MediaPipe, motion), sleep tracking and a baby tracker.
  - Other features: family calls (`UserLine` and `CallRoom` DOs), Web Push (VAPID keys in the `KEY_HOLDER` DO), guest links with passcodes, and the roles parent, caregiver and viewer.
- **Backend:**
  - Cloudflare Workers and Durable Objects (`live-worker/`), with SQLite inside the DOs.
  - R2 for stream segments.
  - Supabase for auth, Postgres RPCs and row-level security.
  - An Express backend in a Cloudflare Container that sleeps when idle.
  - An email Worker.
  - Workers Paid plan ($5/month).

### What the owner wants
- iOS and Android apps.
- An Apple Watch view that is **clutter-free and genuinely good**. This is very important.
- A Wear OS version.
- Backends that are smooth on the right devices and networks.
- Less cloud dependency, ideally with a seamless **local toggle**.
- **Almost no cloud cost** for us, even though the product is online, so it can scale.
- **Top-notch security**: the monitor is never intercepted, the feed never leaks, accounts are never hijacked.

### Constraints
- This container has no Xcode, Swift, Android SDK or Kotlin compiler. GitHub Actions has them and is free for this public repo, including macOS runners.
- The repo is **public**: no secret may ever enter the tree.
- One small team. Reusing the roughly 4k lines of browser-free TypeScript (protocol, soundBrain, trackerScience, videoBudget, rtc logic, linkFallback and others) matters a lot.
- Store deadlines:
  - Apple uploads must be built with Xcode 26 / SDK 26 (since 2026-04-28).
  - Play requires target API 36 for new apps and updates from 2026-08-31.
  - Wear OS requires API 35, and 64-bit support from 2026-09-15.

### Findings that drive these decisions

**1. Cost is dominated by SQLite rows written, not video.** One active nursery writes about **12,180 rows a day**:

| Source of writes | Rows per day |
|---|---|
| 15 s watchdog `alarm()` that calls `setAlarm` and rewrites the 7-day `tl` blob each time | ~6,100 |
| Minute rows (with indexes) | 2,160 |
| Sleep KV puts | 1,440 |
| Purge deletes | 2,160 |

That comes to $315 of the $439/month bill at 1k nurseries. TURN egress is second. The 2 s camera `status` is 80% of WebSocket messages.

**2. Five security gaps matter for "never intercepted, never leaked, never hijacked":**

| # | Gap | Where |
|---|---|---|
| F1 | Sockets are authorised once and never re-checked | `monitorRoom.ts` `onAuth`, `userLine.ts` |
| F2 | Removed members keep getting pushes | `onMembersChanged` prunes `callPush` but not `push` |
| F3 | A removed guest can rejoin with the same link and passcode | `monitorGuests.ts` |
| F4 | Relay JPEGs pass through DO memory in plaintext, and the DO can read and modify SDP, so whoever runs the Worker could swap DTLS fingerprints | `monitorRoom.ts` binary relay branch, `onRtc` |
| F5 | No CSP or security headers, with the Supabase refresh token in `localStorage` on an origin shared with the AI chat app; no MFA; "sign out everywhere" is local-only | `public/_headers`, `functions/_middleware.ts`, `live/sync.ts` `signOut({scope:'local'})`, `live/account.ts` `signOutEverywhereLocal` |

Other findings (F7 to F18: camera spoofing, unauthenticated socket exhaustion, a shared 24 h TURN credential, missing least privilege, supply chain, keys in URLs) are covered in D6.

**3. Platform limits that rule options in or out:**
- **watchOS** forbids WebSocket, Network.framework and Bonjour except while streaming audio or in a CallKit call (TN3135). The simulator does not enforce this.
- **iOS** interrupts the camera when an app goes to the background.
- **Android 14+** must start camera and microphone foreground services while an activity is visible, or from a notification tap.
- **Browsers** cannot discover or listen on the LAN: there is no mDNS, mixed content is blocked, and Chrome's Local Network Access prompt gates private addresses.

---

## Decision

### D1. App architecture: Expo apps with native modules

| Layer | Choice |
|---|---|
| Phone apps | `expo@58.0.x` (latest 58.0.17, 2026-10-21) with `react-native@0.88.0` and expo-router. Continuous Native Generation: **no `ios/` or `android/` folders committed**; `expo prebuild` runs in CI. `apps/mobile` has **its own** lockfile and `node_modules` and is not a root npm workspace, so the web build's React version is never disturbed. It consumes `packages/monitor-core` through Metro `watchFolders`. |
| WebRTC | `react-native-webrtc` **155.0.x** (libwebrtc M155; 155.0.0 released 2026-10-14) with `@config-plugins/react-native-webrtc` 15.0.2. **Release gate:** a version ships only after it is 30+ days old and passes the CI loopback job. Fallback is 124.0.8 (2026-07-21), with codec order set by SDP munging. The native audio hook (`WebRTCModuleOptions.audioDevice` on iOS, `audioDeviceModule` on Android) gives capture with **noise suppression and AGC off** and a raw-audio tap for YAMNet. |
| Expo modules (Swift + Kotlin) | `ds-media`: audio device, YAMNet via ONNX Runtime Mobile (Core ML on iOS), A-weighted dB, frame tap to JPEG, thermal/battery, keep-awake and night screen. `ds-alerts`: notification categories, time-sensitive/critical alerts, alarm playback, Live Activity, push tokens, the NSE keychain group, and later CallKit/PushKit and Android Telecom. `ds-keys`: Secure Enclave / StrongBox device keys, Keychain/Keystore token storage. `ds-watch`: WatchConnectivity and the Wear Data Layer. `ds-local` (Phase 4): Bonjour/NSD, LAN mTLS, Local Push Connectivity. |
| Apple extra targets | `@bacons/apple-targets` 5.0.0: `watch`, `watch-widget`, `widget` (Live Activity), `notification-service` (iOS and watch). Shared Swift lives in `apps/mobile/targets/_shared/`, mirrored by `packages/DreamCoreSwift/Package.swift` so `swift test` can run without an Xcode project. |
| Wear OS | A separate Gradle project, `apps/wearos`, in Kotlin with Compose for Wear OS 1.6 (M3 Expressive). It uses the **same applicationId and signing key** as the phone app, which the Data Layer requires. |
| Long-tail screens | Tracker, reports, people and guides reuse existing React DOM components as Expo DOM components (`'use dom'`), bundled offline. Arrives in Phase 1.1. |
| Minimum OS | iOS **17.2** (push-to-start Live Activities). Android **minSdk 29**, targetSdk 36. watchOS **26**. Wear OS **4** (API 33), target 35+. |

**Why not Capacitor.**
- WebRTC would run inside WKWebView or Android WebView, where we cannot inject an audio device module.
- WebKit pauses capture in the background, which is today's PWA `paused:'hidden'` problem.
- CallKit, Live Activities, the watch bridge and foreground services need native code anyway, so we would end up with two media stacks.

**Why not fully native phone apps.** We would need two UI codebases plus ports of about 4k lines of tested TypeScript into both Swift and Kotlin. That is too much for this team. Any hot path can still move into a native module later.

**The iOS camera phone runs in the foreground.** This is a deliberate product choice:
- Guided Access prompt, idle timer off, OLED-safe night screen, must be on the charger.
- If it is backgrounded, audio and AI keep running under the `audio` background mode and video shows "paused".
- We do **not** abuse the VoIP background mode or play silence (App Review guideline 2.5.4).

**The parent app has two modes:**
- **Sound on**: plays nursery audio and stays alive, so it can sound its own alarm even with the silent switch on.
- **Sound off**: the app is suspended and relies on push.

### D2. Shared core and contracts

- **`packages/monitor-core/`** (pure TypeScript, no DOM). Phase 0 seeds it with **new files only**: `glance.ts`, `glanceBump.ts`, `sealed.ts`, `eid.ts`, `wire.ts` and fixtures.
  - Phase 1 week 1 moves the browser-free files out of `live/monitor` and `live/calls`: `protocol.ts`, `calls/types.ts`, `soundBrain.ts`, `soundClasses.ts`, `trackerScience.ts`, `videoBudget.ts`, `scene.ts`, `vision.ts`, `motion.ts`, `linkFallback.ts`, `resample.ts`, `trackTypes.ts`, `whoGrowth.ts`, and the pure ladder/codec/path parts of `rtc.ts`.
  - `live-worker` imports the same module, which ends the hand-kept mirror noted at the top of `protocol.ts`.
  - Phase 4 week 1 extracts the alert engine (SOUND/HAZARD tables, raise/escalate/ack) and `sleepTracker.ts`, with golden JSON vectors.
- **Golden fixtures** (`packages/monitor-core/fixtures/{glance,sealed,alerts}/*.json`) run in vitest, XCTest (Codable plus CryptoKit) and JUnit (kotlinx.serialization plus Tink/JCA). No platform may ship a decoder that fails them.

**Glance v1** is the single watch, complication, Live Activity and push contract. It is under 512 B as JSON and about 480 B once encrypted and base64url-encoded.

```ts
export type Mood = 'calm'|'stirring'|'awake'|'noisy'|'fussing'|'crying'|'offline'|'unknown';
export interface GlanceV1 {
  v: 1;
  n: string;                    // nursery id
  nm?: string;                  // display name ≤24 chars — NEVER in push payloads (cached on device)
  q: number;                    // per-nursery sequence; bumps only on a visible change
  at: number;                   // server ms when composed
  m: Mood; ms: number;          // mood + since
  sl?: { p: 'idle'|'settling'|'asleep'|'awake'; s: number|null; min: number; w: number };
  db?: number|null;             // LAeq dB(A), integer
  dbb?: 0|1|2|3;                // quiet <40 · normal <55 · loud <70 · very loud
  cam: { on: number; bat?: number|null; chg?: boolean|null; pz?: 'privacy'|'interrupted'|'hidden'|null; ls: number };
  al?: { id: string; k: string; sev: 'urgent'|'warn'|'info'|'care'; at: number; st: 'open'|'acked'|'resolved'; by?: string|null } | null;
  du?: { nm: string; me: boolean; u: number } | null;   // duty; `me` computed per requesting device
  so?: string|null;             // soothing sound playing
  tk?: string|null;             // who is talking into the nursery
  can: number;                  // per device: 1 ack · 2 soothe · 4 listen · 8 talk · 16 peek · 32 duty · 64 log
  src?: 'cloud'|'lan'|'phone';  // added by the delivering client, never by the server
}
```

**When `q` bumps.** These rules keep it to at most about 60 bumps a night.

| Change | Bump timing |
|---|---|
| Mood rises to fussing or above, or goes offline | Immediately |
| Any other mood change | After 15 s of stability |
| Sleep phase | Immediately |
| dB band (`dbb`) | After 30 s sustained. The raw dB number alone never bumps. |
| Alert opened, acknowledged or resolved; duty; soothing; talk; camera on/off/paused | Immediately |
| Battery | When crossing 20% or 10% |

`composeGlance(state, viewer)` and `nextBump(prev, next, now)` are pure functions.

### D3. Push and alert delivery

| Recipient | Transport | Payload | Notes |
|---|---|---|---|
| Browser / PWA | Web Push, RFC 8291, VAPID (as today) | Already encrypted | Adds `act`: a single-use, HMAC-signed action token (incident, uid, 30 min). It lets the service-worker **"I'm on it"** action acknowledge without opening the app. |
| iPhone alert | **APNs direct**, push type `alert`. `mutable-content:1`; `interruption-level: time-sensitive`, or `critical` once entitled; `apns-collapse-id` = incident id; categories `DS_URGENT`, `DS_URGENT_VIEW`, `DS_WARN` | aes128gcm to the device's own `p256dh`/`auth`. The Notification Service Extension decrypts using an App Group keychain key. | Visible fallback text is "DreamStream: Nursery alert". |
| iPhone Live Activity | APNs `liveactivity`: push-to-start plus updates. Priority 5 for routine updates, 10 for alerts. | `content-state` encrypted if spike S3 passes; otherwise a coarse enum only (`m`, `ms`, `sl.p`, `al.st`; no names or IDs) | Ended and restarted at 7 h 50 m because of the 8 h cap. Also appears in the Apple Watch Smart Stack (`.small`). |
| iPhone calls (Phase 1.1) | APNs `voip` → PushKit → CallKit | Call id only | Must be direct APNs; FCM cannot send VoIP. |
| Android phone and Wear OS | **FCM HTTP v1**, high-priority, data-only | aes128gcm | The app builds the notification itself. Channels: `ds_urgent`, `ds_calls`, `ds_status`, `ds_info`. The incident id is both the Wear dismissal id and the collapse key. |
| iPhone, if the probe fails | FCM HTTP v1 with an `apns` block | Same | Only then does the iOS app include Firebase Messaging. VoIP falls back to the Express Container, which runs Node `http2`. |
| Apple Watch direct (Phase 2.2) | APNs to the watch token, same notification identifier | Encrypted | Only for the case where the iPhone is off. The system de-duplicates by identifier. |

- **Credentials:**
  - APNs: an ES256 provider JWT, reusing the ES256 code in `webpush.ts`, cached for 50 minutes.
  - FCM: an RS256 service-account JWT exchanged for an OAuth token, cached for 55 minutes.
  - Both are Worker secrets. APNs and FCM cost nothing to use.
- **Why APNs direct.** APNs requires HTTP/2, and workerd itself has no HTTP/2. In production, Worker `fetch` goes through Cloudflare's proxy, and a user reports APNs working from production (workerd#4841, open; a Cloudflare engineer said the proxy "apparently" upgrades to HTTP/2).
  - **Phase 0 probe:** from production, POST `https://api.sandbox.push.apple.com/3/device/<64 hex>` with no token.
    - **Pass** = an APNs JSON error (`MissingProviderToken`) **with an `apns-id` header**, which only an HTTP/2 APNs response carries. No Apple account is needed for this.
    - **Fail** = use the FCM-for-iOS row above.
- **The acknowledgement loop.** The first action on every urgent alert is **I'm on it**.
  - On Apple Watch the system double tap runs it.
  - `POST /act` is idempotent: it uses a client UUID as the `id`.
  - On acknowledgement, every other recipient gets a quiet replacement such as "Dad's on it": the same `apns-collapse-id` on Apple, the same id with `setOnlyAlertOnce` on Android, and the same Web Push tag.
- **Escalation stays as it is today.** The HAZARD `repeatMs`/`escalateMs` rules, duty routing, and `PUSH_COOLDOWN_MS` are unchanged.
- **Critical Alerts entitlement:** we request it, but **plan as if it will be denied**. The fallbacks are time-sensitive alerts, Sound-on in-app alarms, repeats and escalation to the next family member.

### D4. Watch architecture: clutter-free, native, glanceable

#### D4.1 Experience rules
- **Three-second rule.** Raise the wrist and know the state without reading a number. The state is carried by **glyph shape, one word and colour**, never colour alone. It must work in Always On, in red Night Mode on Ultra, for colour-blind users and with VoiceOver.
- **One primary action at a time.**
  - Calm: **Listen** (from Phase 2.1; in v1 the calm button is **Peek**).
  - Alert: **I'm on it** as the primary action (double tap), with Soothe below it and Listen in 2.1.
  - After anyone acknowledges, the screen goes back to a single button.
- **Same glyph language as the web.** Port the `MoodGlyph.tsx` path data (48×48 viewBox) and the `features.css` keyframes exactly. Animate only when active. Use a static frame when luminance is reduced, Reduce Motion is on, or on Tiles, complications and Live Activities.
- **Duty-aware and role-aware.** The person on duty gets the buzz first; others see "Dad's on it". Viewers get Listen and Peek only. Share-link guests get **no** watch access.
- **Never on a watch:** video, history charts, AI class lists or confidence values, network telemetry, settings beyond "alerts on this watch" and choosing the nursery, people/roles/guests, growth charts, or calls (at most a "Call from Mom — answer on phone" notification).

Home screen, calm and alert (Apple Watch; Wear OS uses the same content on a round layout with an `EdgeButton`):

```
 ╭────────────────────────╮        ╭────────────────────────╮
 │ 10:09   Maya's room  ● │        │ 02:47   Maya's room  ● │
 │       ( moon  z )      │        │     ((( ( >< ) )))     │
 │         Asleep         │        │         Crying         │
 │         1:42:10        │        │          0:42          │
 │    34 dB · quiet       │        │    68 dB · loud        │
 │ ╭────────────────────╮ │        │ ╭────────────────────╮ │
 │ │        Peek        │ │        │ │     I'm on it      │ │ ← double tap
 │ ╰────────────────────╯ │        │ ╰────────────────────╯ │
 ╰────────────────────────╯        │       [ Soothe ]       │
                                   ╰────────────────────────╯
```

- Pages, scrolled with the Crown:
  - **Home**
  - **Tonight**: asleep time, wakings, longest stretch, who is on duty with Take/Hand over, camera battery, last event
  - **Log** (feed L/R and diaper; Phase 2.1)
- Durations tick on the device (`Text(timerInterval:)`, ProtoLayout dynamic time), so they need no updates.
- The `●`/`○` indicator shows live or stale (the "as of" time is older than 90 s with no live link).

#### D4.2 Apple Watch data paths

| Situation | Path | Cloud cost |
|---|---|---|
| App open, iPhone reachable | `WCSession.sendMessage` asks the iPhone app; a watch-initiated message **wakes the iPhone app**. The phone answers from its cache or from GET `/glance`. While the phone app runs, `applicationContext["g"]` streams Glance. | None or one request |
| App open, iPhone not reachable | `URLSession` GET `/glance` with `If-None-Match: "<q>"` every 3 s while active; stops when dimmed | About 1.2k requests per family-month |
| Wrist down | **Live Activity in the Smart Stack** (`supplementalActivityFamilies([.small])`), complications reloaded from WatchConnectivity complication transfers (WidgetKit push only if direct APNs works), forwarded iPhone notifications | APNs is free |
| Alert | iPhone APNs alert → the system forwards it to the watch, which shows our custom long look (animated glyph, I'm on it / Soothe) | Free |
| Peek | If the iPhone is viewing, it downscales its WebRTC frames and sends them with `sendMessageData`. Otherwise GET `/peek` → the DO sends `peek_want` → the camera sends one **NMK-encrypted 240 px JPEG** of at most 16 KB → the watch decrypts it. Maximum 1 fps for 30 s. | A few requests |
| Home Wi-Fi only (Phase 4) | The iPhone's hub link produces local notifications, which iOS forwards to the watch; Glance arrives over WatchConnectivity | None |
| Listen / Talk (Phase 2.1) | `URLSession` chunked stream (IMA-ADPCM 16 kHz, NMK-encrypted 200 ms chunks), **never NWConnection** (FB24377808: the path is revoked after about 35–38 s on watchOS 26.5/26.6). Long-form audio route; the built-in speaker on watchOS 11+ models. | About $0.03 per family-month at 10 min/day |

#### D4.3 Wear OS data paths
- **Paired with an Android phone:** the Data Layer (a `/glance/<nid>` DataItem plus `MessageClient`), with no cloud involved.
- **Standalone** (phone away, Wi-Fi or LTE): HTTPS and a WebSocket in `mode:'glance'` while the app is visible.
- **Alerts:** FCM high-priority data messages, decrypted on the watch, which builds the notification locally. Phone bridging is turned off **only after** the watch holds a grant (`BridgingConfig`, `setBridgeTag`, dismissal id = `inc_<id>`).
- **Tile:** `Material3TileService`, a single `EdgeButton`, refreshed with `requestUpdate()` from the FCM and Data Layer handlers. Its `mainSlot` becomes a 2x2 Wear Widget on Wear OS 7.
- **Complications** (`UPDATE_PERIOD_SECONDS=0`, updated by push):
  - SMALL_IMAGE glyph
  - SHORT_TEXT, as `TimeDifferenceComplicationText`
  - RANGED_VALUE for dB
  - LONG_TEXT
- **During an incident:** an Ongoing Activity on Wear OS 5/6, a Live Update on Wear OS 7.
- **Optional "Night watch"** (Phase 3.1, off by default): a `connectedDevice` foreground service holds a LAN-first glance socket and repeats haptics until someone acknowledges. Play's policy names baby monitors as an example for this service type. The battery cost is shown before it is turned on.

#### D4.4 Watch identity and authorisation
- The watch generates a P-256 key: Secure Enclave on watchOS, Android Keystore (StrongBox where present) on Wear OS.
- **Pairing:**
  - Apple: the paired iPhone sends the watch's public key over WatchConnectivity.
  - Wear OS: over the Data Layer.
  - The phone, signed in as a parent or caregiver, calls `POST /api/devices/enroll` and receives a **device grant** bound to the key thumbprint. The phone also wraps the NMK to the watch's key.
  - Wear OS fallback: an RFC 8628-style device code (6 characters, 10 minutes, 5 attempts), approved by any signed-in member.
- **Tokens:** the watch exchanges its grant for **10-minute ES256 access tokens** (`scp`, `nid[]`, `cnf.jkt`).
  - Every request carries `DS-Proof`: an ES256 signature over `method\npath\nts\nsha256(body)`, with a ±60 s window and a nonce cache in the DO.
  - A stolen token without the hardware key is useless.
- **Capability cap:** at most the user's own role, and never above caregiver. Viewer watches get glance, peek and listen.
- **Revocation:** from any parent device. DO-executed actions are refused immediately; the access-token lifetime bounds everything else to 10 minutes.
- **On the device:**
  - Keychain/Keystore entries are this-device-only and never synced or backed up.
  - The nursery name is `.privacySensitive()` in Always On.
  - Wear OS requires the watch lock before it shows names.

#### D4.5 Limits we state in the UI (honestly)
- Apple Watch cannot monitor continuously in the background. Alerts come from the iPhone; live state comes from the Smart Stack Live Activity, which lasts 8 hours and restarts automatically.
- Complications can lag by minutes. There is no video on the watch. Peek is useless in a dark room because phones have no infrared.
- Wear OS Live Updates exist only on Wear OS 7, and bridging them from the phone depends on the watch maker.

### D5. Local-first and the Connection setting

#### D5.1 The camera phone as Nursery Hub (native, Phase 4)

| Hub (on the camera phone) | Cloud (only what needs a server) |
|---|---|
| Sound and vision detection (already), alert engine, local signaling, live status, minute history, sleep tracker, roster cache, outbox | Accounts and membership, remote rendezvous (DO, mostly hibernated), push fan-out to locked or away phones, dead-camera watchdog, encrypted nightly history backup, roster distribution |

- **One engine, two hosts.** The DO stays authoritative for incidents and escalation in Automatic mode, because it must work when the camera dies. The hub runs the **same extracted engine** (shared module, golden vectors). It is authoritative in Home Wi-Fi only mode and while the internet is down.
- **Event ids.** The hub (and the web camera from Phase 0) mints `eid = <dev>:<seq>`. Every path inserts with `ON CONFLICT DO NOTHING`; viewers alert on the **first arrival** and drop duplicates.
- **Outbox.** Events, incidents, acknowledgements and sessions are appended locally and synced with a `since` cursor when the cloud is reachable. This generalises the existing `stats_ok` handling.
- **History.** Minute rows stay on the hub and are uploaded **once a night as one NMK-encrypted blob to R2**: one Class A operation and about 50 KB, instead of about 1,400 DO rows. Remote charts decrypt on the client. The DO keeps only incidents, sleep sessions and the morning summary.

#### D5.2 The setting (parents only; mirrored into DO `settings`)

| UI | Stored value | Behaviour |
|---|---|---|
| **Automatic** (default, recommended): "Uses your home Wi-Fi when you're home and the internet when you're away." | `auto` | LAN hub and cloud room connect **in parallel**. ICE prefers host, then srflx, then relay. While every viewer is on the LAN, the hub uploads summaries only. Nothing is ever asked of the user. |
| **Home Wi-Fi only**: "Nothing leaves your home. Watch and get alerts only on this Wi-Fi." | `home` | Native camera only. The confirmation sheet states two consequences: phones away from home can't watch or get alerts, and history stays on the camera phone. Before going quiet the hub sends one final push ("Monitoring set to Home Wi-Fi only by Mom"). The DO stops its watchdog and pushes; remote devices show that sentence instead of an error; guests can't join. Viewers raise "Camera stopped" locally after about 6 s without data-channel status. |
| Advanced → Troubleshooting → **Internet only** | `internet` | Skips the LAN path, for hostile or AP-isolated Wi-Fi. Reverts to `auto` after 24 h. "Force relay" (`?relay=1`) stays a per-viewer diagnostic, not a mode. |

- **The status pill** is the only network UI. Its states are "Home Wi-Fi", "Internet", "Relay", "Internet down: still monitoring at home", and "Home Wi-Fi only".
- One toast when the internet returns: "Back online, synced 42 min of history."
- No dialogs and no network names.
- **Web today:** Automatic behaviour only. Browsers are **LAN-resilient** (an established call survives an internet outage) but not **LAN-native** (they cannot connect from scratch on the LAN). The UI says this plainly.
- **Web improvements in Phase 0:** first-arrival alerts, ICE restarts and quality commands sent over the open data channel, and hidden viewers switched to audio only.

#### D5.3 LAN transport and security (Phase 4)
- **Discovery order:**
  1. Cached last address.
  2. Bonjour/NSD `_dsnursery._tcp`.
  3. A LAN-address hint the hub publishes to the DO, **NMK-sealed**. It helps where mesh networks drop multicast. AP-isolated networks fall back to the cloud.
- **mDNS reveals nothing.** The instance name is `HMAC(NMK,"lan")[0:8]`: no baby name and no nursery id.
- **Transport:** TLS 1.3 with **mutual authentication pinned to the roster**.
  - Each device's TLS key is certified by its hardware signing key in the roster.
  - The listener binds only to RFC1918/ULA addresses and has **no unauthenticated endpoint**.
  - "Same Wi-Fi" is never treated as trust.
  - The socket carries the existing MonitorRoom protocol. Clients implement one `RoomTransport` interface with `LanHub` and `CloudRoom` implementations.
- **Alerts on a locked iPhone with the internet down:** **Local Push Connectivity** (`NEAppPushProvider`, `app-push-provider` entitlement, matched by home SSID). Fallback is Sound on.
- **Android:** a foreground service holds the hub socket. The permission is `ACCESS_LOCAL_NETWORK` when targeting API 37, `NEARBY_WIFI_DEVICES` at 36, plus `NSLocalNetworkUsageDescription` and `NSBonjourServices` on iOS.

#### D5.4 What stays in the cloud, and how it stays cheap
- **The DO hibernates between messages.** Duration is billed only while JavaScript runs or while the object is idle but **not** eligible to hibernate. `MonitorRoom` uses `acceptWebSocket` and has no `setTimeout`, so today's 2 s status costs requests and rows, not duration. A guard KPI catches any regression (Cost model).
- Pings stay as free auto-responses. Native clients never hold cloud sockets in the background; they rely on push.
- **Supabase is touched only on membership changes.** JWTs are verified locally against JWKS, and the DO caches `{uid → role, label}`, re-checked every 6 h.
- **TURN:** Cloudflare (1 TB free) until egress passes about 1 TB/month. Then **coturn** on flat-rate hosts becomes the primary, with Cloudflare as fallback. coturn hardening:
  - `use-auth-secret`
  - `denied-peer-ip` for every RFC1918, link-local and metadata range
  - `no-multicast-peers`
  - `turns:` on 443

### D6. Security model

#### D6.1 Assets, principals and adversaries
- **Assets:** live video and audio, the relay picture, signaling (DTLS fingerprints, home IPs), alerts and their content, history, account sessions, and the ability to act (acknowledge, soothe, talk into the nursery).
- **Principals:**

| Principal | Credential |
|---|---|
| Account user | Supabase session |
| Device | Hardware key |
| Camera | Pairing credential from Phase 1; the web camera keeps an account session until then |
| Guest | Per-guest invite from Phase 1 |
| Watch | Device grant |

- **Adversaries:**
  - Network eavesdropper (Wi-Fi, ISP, carrier)
  - Malicious LAN neighbour
  - TURN or infrastructure operator
  - Leaked database or logs
  - XSS or stolen token
  - Credential stuffing or phishing
  - Removed member or ex-guest
  - Stolen phone, camera phone or watch
  - **Compromised deploy pipeline or Worker code**
  - DoS griefer

#### D6.2 Controls

| Adversary | Control | Phase |
|---|---|---|
| Network eavesdropper | TLS everywhere; DTLS-SRTP media; LAN mTLS | today / 4 |
| TURN or infrastructure operator | DTLS-SRTP; **NMK-encrypted relay frames**; NMK-encrypted Peek, Listen and Talk | today / **0** / 2 |
| Database or log leak | Nothing recorded; NMK only stored as wraps; tokens and passcodes hashed; no tokens, SDP or IPs in logs; host and guest keys moved out of URLs (F16) | today / 0 |
| XSS or stolen token | **CSP and headers**; JWT expiry 20 min with socket **re-auth and expiry enforcement**; MFA step-up for admin actions; new-session alerts; from Phase 1, socket auth also needs a device-key signature over the room nonce | **0** / 1 |
| Credential stuffing or phishing | TOTP MFA (`aal2` enforced once enrolled); Turnstile on sign-in and recovery; breached-password check; rate limits; passkeys (native first, behind a flag, after Supabase marks them stable; enrolment requires `aal2`) | 0 / 1 |
| Removed member or guest | Membership changes go **through the Worker** → kick sockets, prune `push` and `callPush`, revoke TURN, **rotate the NMK**, alert every parent. Guest removal **rotates link and passcode** (Phase 0), replaced by **single-use, device-bound per-guest invites** (Phase 1). Least-privilege gates on `onQuery`, `onLog`, `onRtc` (camera to viewer only) and guest acknowledgements of `everyone` hazards. | **0** / 1 |
| Stolen device | One-tap device revocation; camera pairing credential (no account on the spare phone); watch grant; Keychain/Keystore this-device-only; optional biometric lock; `FLAG_SECURE`, `setRecentsScreenshotEnabled(false)`, blurred app-switcher snapshot, `UIScreen.isCaptured` handling | 0 / 1 / 2 |
| Compromised Worker or deploy | Phase 0: sealed signaling plus E2E relay defeat **passive** compromise; an active attacker could still enrol a phantom device, which is announced to parents. **Phase 1: verified admission** (D6.3) means a compromised server **cannot** add a device and so cannot get the NMK. Hardware-key 2FA, one API token per Worker, protected Environments, CODEOWNERS on workflows, SHA-pinned actions. | 0 / **1** |
| Malicious LAN neighbour | No unauthenticated endpoint; roster-pinned mTLS; anonymised mDNS | 4 |
| DoS griefer | Unauthenticated sockets get their own cap (8, oldest evicted first) and do not count toward the 42-slot or 10-slot caps; `AUTH_TIMEOUT_MS` 5 s; Workers Rate Limiting binding (WebSocket upgrades 60/60 s per IP; guest join 10/60 s per IP and 30/60 s per nursery); per-guest lockout instead of a link-wide lockout; WebSocket `Origin` allowlist (allowed origins, or no Origin for native) | **0** |

#### D6.3 Key hierarchy

```
Device (per install):  sig = ECDSA P-256, ecdh = ECDH P-256
                       web: non-extractable WebCrypto in IndexedDB · iOS/watchOS: Secure Enclave
                       Android/Wear: Keystore (StrongBox if present)
                       devId = b64url(SHA-256(sigPub))[0:22]
Nursery Media Key:     NMK_e = 32 random bytes per epoch e; server stores only wraps
  wrap(devId)  = AES-256-GCM( HKDF-SHA256(ECDH(eph, ecdhPub), info="ds-nmk|nid|e|devId"), NMK_e )
  frameKey     = HKDF(NMK_e, "frame|"+camDev)    nonce = salt_e(4) ‖ seq(8)
  sigKey       = HKDF(NMK_e, "sig")              AAD = nid|fromDev|toDev
  peek/listen/clip = HKDF(NMK_e, kind‖session)   96-bit counter nonce
  lanName      = HMAC(NMK_e, "lan")[0:8]
Push key (per device): RFC 8291 p256dh/auth generated on device (web: browser; native: ds-keys)
```

- **Relay frame v1:**
  - Header: `ver u8 | epoch u32 | cam u16 | seq u64 | ts u48 | key u8`, 22 bytes, authenticated as AAD together with `nid`.
  - Body: AES-256-GCM ciphertext plus a 16-byte tag.
  - Viewers drop frames whose sequence number is not higher than the last one seen, or that are more than 10 s old.
  - Works the same for JPEG today and WebCodecs chunks next. The DO forwards bytes it cannot read; its existing binary branch already does that.
- **Sealed signaling:** `rtc.d = {e, iv, ct}`, where `ct` seals `{sdp|cand, fromDev, toDev, ts}`.
  - **Sticky E2E:** a device that holds an NMK for a nursery refuses unsealed signaling from that nursery. This blocks downgrade by stripping capabilities.
  - From Phase 1 the inner payload is also signed with the sender's device key, so one key holder cannot impersonate the camera.
- **Distribution (Phase 0, TOFU):**
  - When a device is admitted, the DO sends `key_req` to an online key holder (the camera while it is monitoring, otherwise any parent device), which wraps the NMK.
  - When no epoch exists, the first parent or camera device sends `key_init`; the DO accepts it with compare-and-set.
  - Every admission produces a visible "New device" entry and notice.
  - **Rotation:** on any removal the holder creates epoch e+1 for the remaining devices. The old epoch is accepted for 60 s.
  - **Losing every device is harmless**, because nothing is recorded; a parent starts a new epoch.
- **Verified admission (Phase 1, web and native):** an append-only **roster log**.
  - Each entry is `{seq, op, devId, sigPub, ecdhPub, tlsSpki?, principal, role, caps, by, sig}`, signed by a parent device key and chained back to the creator's first device.
  - Key holders wrap only to devices in the verified roster.
  - **Admission paths:**
    - (a) The user's own new device: approve on an existing parent device with a 6-digit SAS shown on both screens.
    - (b) Co-located devices (camera QR, watch over WatchConnectivity or the Data Layer): the key travels over the trusted channel.
    - (c) An invited member or guest: the invite secret lives in the link **fragment** (never sent to us). The joiner proves `HMAC(inviteSecret, sigPub)`, and a parent device or the camera (holding the secret NMK-sealed) verifies it and signs automatically.

#### D6.4 Claims we can make honestly

| Claim (product copy) | True from | Holds against | Does not hold against |
|---|---|---|---|
| "The monitor never records. No video or audio is stored on our servers." | Today | Database or storage leaks | — |
| "Video and audio are encrypted between your devices; our TURN relay forwards data it can't read." | Today | Eavesdroppers, TURN operator | An active server-side signaling MITM (until Phase 0) |
| "Even when your network forces us to relay the picture, our servers can't see it." | **Phase 0** | Passive server, CDN or log compromise | Active compromise of our code before Phase 1; web clients always trust the code we serve |
| "Removing someone takes effect immediately on every device." / "Sign out everywhere ends every session." | **Phase 0** | Ex-members, stolen sessions | — |
| "Every new sign-in, device, member or guest is announced to you." | **Phase 0** (email plus in-app), Phase 1 (push plus signed roster) | Account takeover going unnoticed | — |
| "Our servers cannot add a device to your nursery or read your video, even if they were compromised." | **Phase 1, native apps** | Compromised Worker, deploy pipeline or database | A compromised app store binary; web clients |
| "Alert content is encrypted; Apple and Google only see that an alert arrived." | Phase 1 (web: today) | Push providers | Our own server, which composes alert text |
| "Keys live in your phone's and watch's secure hardware." | Phase 1 / 2 | Device-level key extraction | An unlocked, stolen device until revoked |
| "Works with no internet at home." | Phase 4 (native) | ISP or cloud outage | Power loss; AP-isolated Wi-Fi |

- **What our servers still see, and we say so:** account email, nursery and baby names, membership, alert and incident metadata, sleep and tracker summaries, IP addresses at connect time, and timing.
- **Never say:** "unhackable", "military-grade", "zero-knowledge", unqualified "end-to-end encrypted" before Phase 0, "no one can ever intercept", HIPAA or COPPA compliance.

#### D6.5 Native and web hardening (no certificate pinning)
- **No leaf or edge certificate pinning.** Cloudflare rotates certificates and advises against pinning. Instead:
  - iOS: ATS.
  - Android: cleartext off, no user CAs, `certificateTransparency` (API 36), Cloudflare CT monitoring.
  - The NMK makes a TLS MITM useless against media and signaling anyway.
- **Token storage:**
  - iOS: Keychain `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
  - Android: DataStore plus Tink AEAD with a Keystore key (EncryptedSharedPreferences is deprecated), excluded from backup via `dataExtractionRules`.
- **App Attest / Play Integrity** at enrolment moments only: sign-in, adding a device, camera pairing, guest join from the app. It is a risk signal, not authentication. Play Integrity's default quota is 10k requests/day per app.
- **Web:** keep first-frame socket auth, RPC-only row-level security with `search_path=''`, PBKDF2 passcodes, hashed tickets, hash-pinned models and CSV escaping. Add CSP (Phase 0 checklist WS-1). Move the chat artifact runner to its own sandbox origin before enforcing CSP on `/`, because `srcdoc` iframes inherit the parent page's CSP.

### D7. Repo layout and CI

```
packages/monitor-core/        pure TS + fixtures (Phase 0 seeds; Phase 1 moves files in)
packages/DreamCoreSwift/      Package.swift pointing at apps/mobile/targets/_shared (swift test on macos-26)
packages/glance-kotlin/       kotlinx.serialization + crypto; included by apps/wearos and the Expo Android module (includeBuild)
apps/mobile/                  Expo SDK 58: app/ (expo-router), modules/ds-*/, targets/{watch,watch-widget,widget,notification-service,_shared}/, plugins/, maestro/
apps/wearos/                  Gradle: :app (Compose for Wear), :tile, :complication
/home/user/Comic2/.github/workflows/mobile-*.yml   (only the git-root .github runs; dreamstreamcomicstudio/.github never does)
```

| Job | Runner | Gate |
|---|---|---|
| `monitor-core` vitest, glance/sealed fixtures, `tsc` | ubuntu (and this container) | every PR |
| jest-expo, `expo-doctor`, `expo prebuild` config-plugin checks | ubuntu | every PR touching `apps/mobile` |
| Android assemble, Robolectric, lint; **emulator WebRTC loopback** (two peer connections, synthetic camera, H.264 plus data channel), foreground service start/stop, Maestro smoke | ubuntu with KVM, `reactivecircus/android-emulator-runner` | every PR touching mobile |
| Wear assemble, unit tests, Roborazzi (round, square, ambient) | ubuntu | every PR touching `apps/wearos` |
| iOS simulator build, XCTest (YAMNet golden WAVs, dB parity, Codable, CryptoKit fixtures), Maestro iOS | `macos-26` | PRs labelled `mobile`, plus nightly |
| watchOS build, XCTest, swift-snapshot-testing (8 moods × sizes × always-on × large Dynamic Type; complications; Live Activity `.small`) | `macos-26` | same |
| Signed archive → TestFlight; AAB → Play internal and Wear tracks | `macos-26` / ubuntu, in the protected `ios-release` / `android-release` Environments with a required reviewer | manual dispatch |

- Pin actions by SHA. Default `permissions: contents: read`.
- **Never use `pull_request_target`.** Fork PRs need approval before they can use macOS minutes.
- Play API access through **Workload Identity Federation**, with no stored JSON key.

**Needs real hardware, so it is never claimed from CI:**
- Camera and encoder heat; a 10 h overnight soak.
- Backgrounding and locking; Doze and OEM battery killers.
- Real APNs/FCM delivery; Live Activity in the Smart Stack.
- **Watch networking limits**, since the simulator allows everything.
- Local Network permission prompts and mDNS on real Wi-Fi.
- Carrier NAT and TURN.
- Bluetooth and AirPods audio routes; Wear phone-proxy behaviour.

### D8. Out of scope for this ADR
- An SFU, SFrame or `RTCRtpScriptTransform`. These only matter if we ever add an SFU.
- Cloud recording of any kind.
- WebRTC on any watch.
- Leaf-certificate pinning.
- An auth system native to Workers (reconsider above about 500k MAU).

### D9. Disagreements between the studies, resolved

| # | Topic | Positions | Resolution and why |
|---|---|---|---|
| 1 | Phone stack | Native study: Expo plus modules. Watch study: implied native Xcode and Gradle apps. | **Expo plus native modules.** Watch, widget and NSE targets are native via apple-targets; Wear OS is a separate native Gradle project. Reasons: the TypeScript reuse and team size. |
| 2 | iOS push egress | Native: direct APNs from the DO. Watch: FCM for every platform. | **Direct APNs is primary**, gated by the Phase 0 HTTP/2 probe (passes without an Apple account). FCM-for-iOS is the automatic fallback. VoIP is always direct, or via the Container if the probe fails. Android and Wear use FCM. |
| 3 | watchOS minimum | 10+ vs 26 | **watchOS 26.** It supports the same hardware as 11 (Series 6 and later, SE 2/3, Ultra 1–3) and brings Controls, RelevanceKit and primaryAction. Xcode 26 is required for uploads anyway. watchOS 27 drops models before Series 9, so it is not the floor. |
| 4 | Watch v1 media | Peek in v1 vs Listen, Peek and Talk in a later phase | **Phase 2 ships Glance, alerts and actions, Peek and complications.** Listen and Talk come in **2.1**, after the URLSession streaming spike passes on hardware. |
| 5 | Watch credential | 12 h token signed by the DO vs a hardware-bound grant with 10 min tokens and DS-Proof | **Hardware-bound grant, 10 min tokens, DS-Proof.** A stolen token is useless without the Secure Enclave or Keystore key. |
| 6 | Glance schema | Verbose `GlanceV1` vs a compact schema with `q` sequence and `can` bitmask | **Compact schema** (D2), plus the native study's network path as a client-only `src` field. |
| 7 | Toggle | Two choices vs Auto/Local/Cloud | **Stored as three states** (`auto`, `home`, `internet`). The UI shows Automatic and Home Wi-Fi only; Internet only sits under Advanced and auto-reverts. |
| 8 | Duration cost of the 2 s status | Watch: about $1.70 per family-month. Local-first: about 120 s/day. | **Local-first is right.** Cloudflare: idle objects that are eligible to hibernate are not billed for duration, and MonitorRoom uses `acceptWebSocket` with no timers. The status cut is still needed (requests and CPU). Guard KPI: 40 GB-s per nursery-day or less. |
| 9 | Device registry | Supabase `device_grants` vs DO `mon_devices` | **Both, with clear roles.** Supabase `live_devices` is the account-level list (phones, browsers, watches) for "Your devices" and sign-out everywhere. DO `mon_devices` and `mon_keywraps` are the per-nursery roster, including cameras, which have no account. |
| 10 | Where signing keys live | VAPID moved to Worker secrets vs never leaving `KEY_HOLDER` | **VAPID stays in `KEY_HOLDER`**, with an isolate-level cache. Exporting it would mean extracting a live private key, and existing push subscriptions are bound to it. **New keys** (APNs, FCM, device tokens, security hook) are Worker secrets. |
| 11 | Who owns alerts and history | Hub in Phase 1 vs DO | The **DO stays authoritative** in Automatic mode. The hub runs the same engine and is authoritative in Home Wi-Fi only mode and during outages. Hub-owned minutes come in **Phase 4**, because web cameras cannot be hubs. |
| 12 | Phase 0 rows target | Local-first: about 4,300 rows/day after Phase 0 | **About 1,550.** Adds **packed hourly minute blocks** (`WITHOUT ROWID`, upserted every 5 min) on top of the local-first list. Rows written are still the largest cost. |
| 13 | When to extract monitor-core | Phase 0 vs later | **Phase 0 adds new files only.** Moving existing files waits for Phase 1 week 1, so Phase 0's parallel workstreams don't collide. |
| 14 | CI runner | `macos-15` vs `macos-26` | **`macos-26`** (Xcode 26.x required for uploads). |
| 15 | Watch "Night watch" foreground service | Proposed vs not mentioned | **Phase 3.1**, off by default, with the battery cost shown. |
| 16 | TURN credential lifetime | Members 6 h / guests 2 h vs 4 h maximum | **Members 4 h; guests the shorter of 2 h and the pass expiry.** Refreshed in place with `setConfiguration`; revoked on kick or removal; cached per (uid, nid) for half the TTL to limit API calls. |
| 17 | Re-auth cost | RPC on every re-auth vs fewer RPCs | **Local JWKS verification on re-auth** (no RPC). Revoked sessions cannot refresh, so the DO closes the socket at `exp + 120 s`. Membership changes come through `/x/members`. An RPC re-check runs every 6 h. |

---

## Consequences

**Easier**
- One TypeScript core across web, native and Worker. Behaviour stays identical through golden fixtures.
- Watch apps that are fully native and good, with one small contract.
- The cost floor drops 5–12 times, and the dominant cost driver becomes measurable.
- The security claims become true and can be defended.
- Alerts survive internet outages (native).

**Harder**
- Three native surfaces to maintain: the Expo app with its Swift and Kotlin modules, the SwiftUI watch app, and the Compose Wear OS app.
- Two Expo SDK upgrades a year.
- App Store and Play review overhead.
- macOS runner queue times.
- Key management adds failure modes: lost keys need re-keying, epochs can race, and roster bugs can lock out devices. Mitigations: compare-and-set epochs, a recovery flow ("start a new key epoch" from any parent device, by design harmless), and exhaustive fixtures.
- **Web E2E is bounded by trust in the code we serve.** Native apps are the high-assurance clients.

**Product constraints we accept**
- The iOS camera phone must stay in the foreground.
- The Apple Watch cannot monitor continuously in the background.
- A Live Activity lasts 8 hours and must be restarted.
- Critical alerts may be denied.
- Home Wi-Fi only mode needs a native camera.

**Ruled out:** Capacitor; fully native phone apps; an SFU or cloud recording; WebRTC or sockets on the Apple Watch; certificate pinning; VoIP-mode or silent-audio background hacks; "unhackable" marketing.

**Follow-ups**
- ADR 0007 for the roster-log wire format (Phase 1). *(0007 has since been taken by Stream Studio cost transparency; the roster log takes the next free number.)*
- Update `docs/features/baby-monitor.md` (security and connection sections) and `docs/infrastructure/` (secrets, rate limits, R2 lifecycle). *(Done 2026-10-29, WS-8: `live-security-runbook.md`, `phase0-owner-checklist.md`.)*
- A privacy policy that matches D6.4. *(Draft paragraph for the owner's approval in `phase0-owner-checklist.md` §18; `components/PrivacyPolicy.tsx` doesn't mention the monitor yet.)*
- `/.well-known/security.txt`. *(Done, WS-1.)*

---

## Cost model

**Assumptions** (per *active* nursery):
- Camera on 12 h/day, 2 parent devices, about 55 socket connects a day.
- 25% of nurseries watch over cellular about 1 h/day at 650 kbps or less, which gives **TURN ≈ 2.25 GB per nursery-month today**. This is the least certain input; measure it.
- 2.5 MAU per nursery.

**Prices** (October 2026):

| Service | Included | Beyond |
|---|---|---|
| Workers Paid | $5 base, 10M requests | $0.30/M |
| DO requests | 1M | $0.15/M (WebSocket messages counted 20:1, alarms 1:1) |
| DO duration | 400k GB-s | $12.50/M GB-s |
| DO rows written | 50M | $1/M |
| DO storage | 5 GB | $0.20/GB-month |
| Cloudflare TURN | 1 TB/month | $0.05/GB |
| Supabase Pro | $25 with 100k MAU | $0.00325/MAU |
| R2 Class A | 1M | $4.50/M |

| Per active nursery-day | Today | After Phase 0 | After Phase 4 |
|---|---|---|---|
| DO requests | 4,141 | ~915 | ~671 |
| Rows written | 12,180 | ~1,554 | ~936 |
| Active DO seconds | ~118 | ~30 | ~12 |
| TURN GB/month | 2.25 | ~0.9 (hidden viewers audio-only; relay cap 400 kbps) | ~0.9 |

| Monthly cost | 1k nurseries | 10k | 100k |
|---|---|---|---|
| **Today** | $439 ($0.44/nursery) | $4,974 ($0.50) | $50,821 ($0.51), of which rows $36,490 and TURN $11,200 |
| **After Phase 0** | $34 ($0.034; $30 of it is the fixed Workers and Supabase base) | $916 ($0.092) | $10,326 ($0.103): rows $4,612, TURN $4,450, Supabase $512 |
| **After Phase 4** (hub-owned history, LAN signaling) | $33 | $709 ($0.071) | $8,195 ($0.082) |
| **Phase 4 + coturn** (two flat-rate boxes of about 20 TB each, then about $5/TB) | $33 | $399 ($0.040) | $4,080 ($0.041) |

- **Fixed costs outside the model:**
  - Apple Developer $99/year.
  - Google Play $25 once.
  - D-U-N-S free.
  - GitHub Actions, APNs and FCM free.
  - coturn hosts are included in the last row.
- **Sensitivity:**
  - If cellular viewing is twice the assumption, TURN doubles ($8.9k at 100k after Phase 0). coturn removes about 90% of that.
  - **If hibernation breaks** (a stray timer or pending I/O), the worst case is 5,400 GB-s per nursery-day, which is **about $20k/month at 10k nurseries**. The Phase 0 duration KPI exists to catch this.
- **KPIs to measure** (WS-8 adds these to the cost centre — Admin → Costs → Stream Studio → *Baby monitor health*, built 2026-10-29; acceptance requires 7 days of data):
  - DO requests, rows, GB-s and storage per active nursery-day, from the GraphQL datasets `durableObjectsInvocationsAdaptiveGroups`, `durableObjectsPeriodicGroups` and `durableObjectsStorageGroups`.
  - TURN GB.
  - The share of viewer minutes on relay or TURN paths.
  - Glance bumps per night.
  - Pushes per night.

---

## Phased roadmap

| Phase | Weeks (from approval) | Estimate (AI build), as of 2026-10-29 | Depends on |
|---|---|---|---|
| 0: harden, cut cost, glance and push channel (web and Worker) | 1–3 | Wave 1 in production. Wave 2 built on branches; deploy ~Nov 2–5, then 7 days of KPIs (~Nov 12) | Supabase settings (owner) |
| 1: iOS and Android MVP with CI | 3–12 | ≈ 580–890 agent-hours (Gate B ≈ 455–690, then 1.1 ≈ 125–205). First native night (Gate A) ~Nov 13–19; **Phase 1 accepted (Gate B) ~Dec 4–15**; 1.1 ~Dec 22 – Jan 8, risk-adjusted mid-January. Detail: Phase 1 checklist §11 | Phase 0 wave 1 merged; Apple and Play accounts by week 4 (Apple enrolment is the critical path) |
| 2: Apple Watch | 8–14 (2.1: 14–16; 2.2 after) | ≈ 110–170 agent-hours; watch UI starts now; done ~Dec 18–30, risk-adjusted mid-January (2.1: +1.5–2 weeks after its hardware spike) | Phase 1 milestone "push + Glance on iPhone"; Peek after the roster room work (P1-WS-20a) |
| 3: Wear OS | 12–17 (3.1: 18) | ≈ 80–130 agent-hours; skeleton starts now; done ~Dec 10–22, risk-adjusted early January (3.1: +1 week) | Phase 1 Android push; FCM; the device-token socket after P1-WS-20a |
| 4: LAN hub mode | 16–24 | ≈ 120–200 agent-hours; after Gate B; ~late January – February 2027, risk-adjusted early March | Phase 1 camera mode; Local Push Connectivity entitlement |

Estimates assume 6–8 AI engineers in parallel on free GitHub runners. Calendar dates are set by Apple enrolment, devices, the owner's test nights and store review, not by engineering. Phases 1–3 together, including 1.1: ≈ 770–1,190 agent-hours, landing late December 2026 (risk-adjusted ~Jan 15, 2027). Everything in "What the owner wants", Phase 4's local mode included: ≈ 890–1,390 agent-hours, ~February 2027 (risk-adjusted early March). *(Re-estimated 2026-10-29 after a critic review of the Phase 1 checklist; the first version said 425–645 and 615–945, which was too low for Phase 1.1 and the verified-admission work.)*

### Phase 0: what we ship now (web and Worker)

**Deliverables** (file-level detail in the checklist at the end)
- **Security:**
  - CSP and headers: enforced on `/live`, Report-Only on `/`.
  - Session lifecycle: socket re-auth, expiry enforcement, real "Sign out everywhere" via `/api/me/kick`.
  - Membership changes routed through the Worker, with push pruning and parent alerts.
  - Guest removal rotates the link and passcode.
  - DoS caps and rate limits; the camera-spoofing rule (only the same uid may replace a `dev`); least-privilege gates; per-socket TURN credentials with revocation.
  - TOTP MFA with `aal2` enforcement and step-up for admin actions; new-session emails with "Not you?"; a per-nursery security log.
  - Supply chain: npm audit fixes, `onnxruntime-web` 1.30.0 stable, `supabase-js` ≥ 2.118, SHA-pinned actions, Dependabot cooldown, CODEOWNERS.
- **E2E:** web device keys, NMK epochs and wraps, **encrypted relay frames**, **sealed signaling** with sticky E2E, rotation on removal.
- **Cost:**
  - 60 s watchdog using auto-response timestamps; `saveBucket` and the `tl` blob removed.
  - Status only on change, plus a 60 s keepalive and `live_want`.
  - `stats` batched every 5 minutes; **packed hourly minute blocks**.
  - Hidden viewers audio-only with relay off; relay cap 400 kbps at 15 fps.
  - ICE batching; `eid` idempotency; local JWT verification with a role cache; VAPID isolate cache.
  - R2 lifecycle backstop; cost telemetry.
- **Watch and native readiness:**
  - Glance composer and bump rules; WebSocket `mode:'glance'`; GET `/glance` with ETag; idempotent, role-gated POST `/act` (actor refactor).
  - Device registry, grants and DS-Proof tokens.
  - Push router (webpush, apns, apns-la, fcm) in place but dormant until native tokens exist, with E2E native envelopes.
  - **APNs HTTP/2 probe.**
  - "I'm on it" in the web service worker; the acknowledgement replacement push.

**Acceptance criteria**
- [ ] `/live` responses carry an enforced CSP, HSTS (2 years, includeSubDomains), nosniff, Referrer-Policy, Permissions-Policy, COOP and `frame-ancestors 'none'`. `/` carries CSP Report-Only. Seven days of reports show **zero** violations from first-party code on `/live`.
- [ ] Removing a member from any client closes all their monitor and line sockets within **5 s**. An integration test with a fake push endpoint proves **no push** reaches them afterwards. Every parent gets a "member changed" notice.
- [ ] Sign out everywhere closes all of the user's DO sockets within **5 s**. A revoked session's sockets close at **token `exp` + 120 s** or sooner. *(Client side done 2026-10-29 (WS-5: kick, then global sign-out, honest copy; `ds:token` re-auth). The 5 s needs WS-7's `/api/me/kick` and the rooms' `/x/kick` and expiry checks (WS-9/WS-10).)*
- [ ] A removed guest cannot rejoin with the old link and passcode. 50 unauthenticated sockets do not stop a member from connecting.
- [ ] A user with a verified TOTP factor presenting an `aal1` token is refused (close code 4003). Creating share links, adding members, export and device approval all require `aal2`.
- [ ] A sign-in from a new browser produces an email within **2 minutes**. "Not you?" revokes all sessions, kicks all sockets and starts a password reset.
- [ ] Relay binary frames seen by the DO contain no JPEG SOI marker (`FF D8`) (test). Replayed or stale frames are dropped. After removal plus 60 s, a removed device cannot decrypt new frames. *(Client side built 2026-10-29 (WS-6): `live/monitor/e2e.unit.test.ts` runs the room's header reader and sound-only cut on sealed bytes. The rotation goes live with WS-9's roster.)*
- [ ] Between E2E-capable peers, forwarded `rtc.d` contains no plaintext `sdp` or `candidate` (test), and an unsealed offer to a key-holding camera is refused. *(Client side built 2026-10-29 (WS-6): `rtc.unit.test.ts` and `e2e.unit.test.ts`. Goes live when WS-9's room lists `e2e1`.)*
- [ ] 7-day production median per active nursery-day: **DO requests ≤ 1,000, rows written ≤ 1,800, DO duration ≤ 40 GB-s**. Relay share is reported in the cost centre. *(Built 2026-10-23; a simulated 12 h night gives 542 / 1,040 / 3.6 GB-s — `live-worker/src/monitorRoom.night.test.ts`. Production median still to be read: Admin → Costs → Stream Studio → Baby monitor health shows the three 7-day medians, how many days they cover, and ok / over against these budgets, with the relay share beside them (WS-8, 2026-10-29). Units: the 1,000 is **billed** requests (incoming WebSocket messages 20:1). Cloudflare's analytics count *invocations* — alarms, upgrades and every incoming message once — and can't split messages from alarms, so the cost centre judges the measured median against **2,600 invocations**, the 1,000 billed at the simulated night's mix (1,434 invocations for 542 billed; `PHASE0_DO_INVOCATIONS` in `shared/stream/usage.ts`). The night test asserts the simulated night stays inside both.)*
- [ ] GET `/glance` returns 200 with an ETag, then 304 when unchanged (p95 ≤ 150 ms when warm). `{t:'glance'}` frames are sent only on a bump. Replaying the fixture of a recorded night gives **60 bumps or fewer**. *(Bump rules and the night fixture built 2026-10-28 in `packages/monitor-core`: 57 bumps for a night with a second camera from 22:00, fed at the room's real cadence. The endpoint and the frames are WS-9's.)*
- [ ] POST `/act` with the same `id` twice gives one acknowledgement. It is role-gated and writes the same log as a WebSocket acknowledgement.
- [ ] The production APNs probe returns an APNs error body **with `apns-id`**, or the FCM-for-iOS fallback is recorded as the decision. The FCM sender passes against recorded fixtures. The service-worker "I'm on it" action acknowledges without opening the app. *(The service-worker half is built and tested (WS-5, 2026-10-29); it goes live when the room puts `act` in alert pushes and serves `/act` (WS-9).)*
- [ ] `npm audit --omit=dev`: 0 critical and 0 high. All workflow actions are SHA-pinned. `vitest`, `live-worker` typecheck and `vite build` are green.

### Phase 1: native iOS and Android MVP

**Deliverables**
- [ ] `monitor-core` file moves (D2). `apps/mobile` on Expo SDK 58 with screens: Sign-in (email/password plus TOTP; passkeys behind a flag), Nurseries, **Viewer** (bedside layout, P2P/TURN/relay, PiP, talk, Sound on/off), **Camera mode**, Alerts inbox, Settings (Connection: Automatic only until Phase 4; Devices; Security).
- [ ] Modules `ds-media` (native audio device, YAMNet, dB/Leq, frame tap, thermal/battery, night screen), `ds-alerts` (APNs/FCM tokens, categories, time-sensitive alerts, Live Activity start/update/restart, Android channels and ongoing Live Update), `ds-keys`, and a `ds-watch` stub.
- [ ] iOS NSE (decrypts the push) and the Live Activity widget with `.small`. Android: `FirebaseMessagingService` decrypts and posts locally.
- [ ] Camera mode:
  - Android: a `camera|microphone` foreground service started by a tap; a persistent "Nursery camera is on" notification; a partial wake lock; a "Tap to resume" notification after reboot.
  - iOS: foreground with night screen, Guided Access prompt, idle timer off, charging required (parents alerted if unplugged); audio and AI continue when backgrounded.
- [ ] **Verified device admission** (roster log, SAS, invite secret in the fragment) for web and native. **Camera pairing credential** (QR; no account on the spare phone). **Single-use, device-bound per-guest invites.** Socket auth = token plus a device signature over the room nonce.
- [ ] App Attest and Play Integrity at enrolment. `FLAG_SECURE`, capture blur and the optional biometric lock.
- [ ] CI workflows (D7). TestFlight external beta and Play closed test. `/.well-known/apple-app-site-association` and `assetlinks.json` served so `/join/...` links open the app.

**Acceptance criteria**
- [ ] Every PR runs monitor-core, jest, Robolectric, the **emulator WebRTC loopback**, the iOS simulator build and XCTest. The release workflow uploads to TestFlight and Play internal only from protected Environments.
- [ ] Time to first frame: median ≤ 2 s on the same Wi-Fi; ≤ 4 s over TURN on LTE.
- [ ] Phone locked, Sound off: from cry incident to notification, **p95 ≤ 5 s** on iOS and Android. The raw APNs/FCM payload contains no names or kinds (captured in a test). "I'm on it" from the notification acknowledges without opening the app, and others receive "X is on it".
- [ ] Sound on: the backgrounded iOS app plays nursery audio and sounds its alarm with the silent switch on. App Review passes, with the review notes and video.
- [ ] The Live Activity appears on the Lock Screen and in the Apple Watch Smart Stack throughout a night longer than 8 h (restarted at 7 h 50 m).
- [ ] **10 h overnight soak** on iPhone (night screen, on charger) and Android (foreground service, screen off, Doze): no crash, no gap over 2 min, thermal state "fair" or better.
- [ ] Native YAMNet parity with TypeScript on golden WAVs: class scores within ±0.02; cry-detection latency ≤ 2 s.
- [ ] Tokens are this-device-only and not backed up. Device keys are hardware-backed (with an attestation check). A server-injected phantom device is **not** given an NMK wrap (adversarial test).

### Phase 2: Apple Watch (2.1 Listen/Talk/Log/Control; 2.2 direct-to-watch push and critical alerts if granted)

**Deliverables**
- [ ] SwiftUI watchOS 26 app with the pages Home (calm and alert takeover), Tonight, Peek and Soothe (15/30/60 min).
- [ ] Custom notification long look with the animated glyph; categories with **I'm on it** first (double tap).
- [ ] Complications: `accessoryCircular`, `accessoryCorner`, `accessoryRectangular`, `accessoryInline` (static glyph per mood; `Text(date, style: .timer)`; `AppIntentConfiguration` per nursery).
- [ ] Smart Stack `.small` Live Activity layout.
- [ ] Pairing over WatchConnectivity (grant plus NMK wrap); Settings › Devices shows the watch with Revoke.
- [ ] Haptic ladder: urgent → `.notification` every 2 s until acknowledged or dismissed (60 s maximum); warn → a single haptic; info → none.
- [ ] Always On: static, no image. VoiceOver labels ("Maya's room. Asleep for 1 hour 42 minutes. Room quiet, 34 decibels."). Reduce Motion honoured.

**Acceptance criteria**
- [ ] **3-second test:** in a moderated test with 5 parents across all 8 mood states, every parent identifies the state within 3 s of raising the wrist.
- [ ] Cold open to current state: ≤ 1.0 s with the iPhone nearby; ≤ 2.5 s on Wi-Fi without the iPhone.
- [ ] Alert on the wrist **p95 ≤ 6 s** after the incident opens (iPhone locked, watch on wrist). Double tap acknowledges on Series 9+ and Ultra 2+, with a round trip ≤ 2 s; other parents' alerts are replaced.
- [ ] No WebSocket or NWConnection anywhere in the watch target (static check). Verified on hardware with the iPhone's Bluetooth and Wi-Fi off.
- [ ] Snapshot suites green: 8 moods × {41, 45/46, 49 mm} × {active, luminance-reduced} × {default, accessibility Dynamic Type}; all complication families; the Live Activity `.small`.
- [ ] Peek shows a decrypted frame ≤ 3 s after the tap, with the dark-room message when `light` is low.
- [ ] The watch never stores account tokens. Revocation: DO actions are refused immediately; HTTP access ends within 10 minutes or less.
- [ ] Battery target: 8 h night with the Live Activity and 10 alerts uses **≤ 10%** of a Series 9 battery.
- [ ] 2.1 gate: URLSession Listen streams 15 minutes on the speaker and on AirPods with no stall over 2 s (watchOS 26.x and 27).

### Phase 3: Wear OS (3.1: Night watch, Wear Widget, Live Update on Wear OS 7)

**Deliverables**
- [ ] Compose for Wear OS 1.6 app: Home, Tonight, Peek, Soothe; `EdgeButton` as the primary action.
- [ ] `Material3TileService` Tile, complication data source, and an Ongoing Activity during incidents.
- [ ] FCM data alerts with dismissal sync and bridging off after the grant.
- [ ] Data Layer when the Android phone app runs; standalone HTTPS and `mode:'glance'` WebSocket otherwise.
- [ ] Device-code pairing fallback; checks `isWristDetectionAutoLockingEnabled()`.
- [ ] Same applicationId and signing key as the phone app; target API 35+; 64-bit.

**Acceptance criteria**
- [ ] Pixel Watch and Galaxy Watch: from FCM alert to watch notification **p95 ≤ 6 s**; **no duplicate** with the phone notification; dismissing on one dismisses on the other.
- [ ] Tile and complication update ≤ 10 s after a Glance bump; durations tick without updates.
- [ ] Standalone (phone off, watch on Wi-Fi): Glance and alerts work.
- [ ] Roborazzi round, square and ambient suites green. Play Wear review passed.

### Phase 4: LAN hub mode

**Deliverables**
- [ ] Extract the alert engine and `sleepTracker` with golden vectors.
- [ ] `ds-local`: Bonjour/NSD, roster-pinned mTLS listener on the camera (`NWListener` / an Android TLS server), `RoomTransport` (`LanHub` and `CloudRoom`), outbox with cursor sync.
- [ ] **Local Push Connectivity** provider extension on iOS; hub socket in an Android foreground service.
- [ ] Connection setting with Automatic and Home Wi-Fi only (Internet only under Advanced).
- [ ] Hub-owned minutes and sleep, with the nightly NMK-encrypted R2 blob and a restore path on a new parent device.
- [ ] coturn fleet when TURN egress exceeds 1 TB/month.

**Acceptance criteria**
- [ ] With the WAN cable pulled at the router: a locked iPhone on the LAN (via Local Push Connectivity) and an Android phone (via the foreground service) get a cry alert in **≤ 3 s**. The Apple Watch gets the forwarded local notification. Video continues. The pill reads "Internet down: still monitoring at home".
- [ ] Home Wi-Fi only mode: a one-hour packet capture shows **no traffic from the hub or viewers to our cloud** (OS traffic excepted). Remote devices show the explanatory sentence.
- [ ] When the internet returns, the outbox syncs within 30 s with no duplicate incidents.
- [ ] The hub refuses unauthenticated TLS, and the mDNS instance name reveals nothing.
- [ ] DO rows ≤ 1,000 per nursery-day for hub nurseries.

---

## Owner actions (and when each is needed)

Exact clicks and commands for every Phase 0 action, in order: `docs/infrastructure/phase0-owner-checklist.md`.

| # | Action | Needed by | Lead time | Output, and where it goes |
|---|---|---|---|---|
| 1 | Hardware-key or passkey 2FA on Cloudflare, GitHub, Supabase, Google and Apple; remove SMS fallbacks | **Now** (Phase 0 week 1) | 1 h | — (until Phase 1, a compromised deploy account is the biggest single path to the feed) |
| 2 | **Decide the legal entity, then get a D-U-N-S number.** Enrol in the Apple Developer Program and Google Play Console as an **Organization**. With no entity, enrol as an individual now (apps can be transferred later) and plan Play's **12 testers for 14 days**. | **Start now**; required by Phase 1 week 4 | D-U-N-S 1–2 weeks; Apple review days to weeks | Team ID; Play developer account |
| 3 | Supabase Auth: switch to **asymmetric (ES256) JWT signing keys**, later revoking legacy HS256 and the legacy anon/service keys; **JWT expiry 20 min**; enable **TOTP MFA**; secure email change and secure password change; minimum password length 12; **Turnstile CAPTCHA** on sign-in, sign-up and recovery; security notification emails through the existing Send Email Hook; decide **Pro** (leaked-password protection, session limits) | Phase 0 week 1–2 | 1 h | Dashboard settings |
| 4 | Apply `server/sql/live_security_v2.sql` (WS-4), then enable the **Custom Access Token hook** → `public.live_access_token_hook`; store `SECURITY_HOOK_SECRET` in Vault. Leave the email Worker's `SECURE_ACCOUNT_PAGE` unset until WS-5's `#/secure` page ships (alerts point to Settings → Security until then), then set it to `on` *(2026-10-29: WS-5 set it in `email-worker/wrangler.jsonc` with the page — nothing to do in the dashboard, where `wrangler deploy` would overwrite it anyway. WS-5's review fixes add two-step sign-in tables and RPCs (`live_mfa_*`) to the same file: apply it **before** switching on TOTP MFA (#3) — until it is applied, Stream Studio offers no way to turn two-step sign-in on, so nobody can enrol without recovery codes and the camera grace)* | Phase 0 week 2 | 30 min | SQL editor or MCP |
| 5 | Worker secrets: `SECURITY_HOOK_SECRET`, `DEVICE_TOKEN_JWK` (generated with `scripts/ops/genDeviceTokenKey.mjs`), `ACT_TOKEN_KEY`; later `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `FCM_SA_JSON` | Phase 0 week 2 / Phase 1 week 2 | 15 min | `wrangler secret put` on `dreamstream-live` (and the email Worker for the hook secret). *(2026-10-29, WS-5 review: the backend needs the same `SECURITY_HOOK_SECRET` too — a row in D1 `dreamstream-backend-env` or a secret on `dreamstream-api` — so "Not you? Secure my account" can sign its server-side kick (`server/src/services/liveKick.ts`). Without it the account is still secured and the page says open monitors may stay connected.)* |
| 6 | Cloudflare: **one least-privilege API token per Worker or Pages project**, replacing the shared `CLOUDFLARE_API_TOKEN`; CT monitoring on; **HSTS preload** after confirming every subdomain serves HTTPS; R2 lifecycle rules (runbook from WS-8) | Phase 0 | 1 h | GitHub Environment secrets |
| 7 | GitHub: branch protection on `main`; CODEOWNERS for `.github/workflows`; Environments (`production-deploy`, `ios-release`, `android-release`) with a required reviewer; CodeQL default setup; secret scanning with push protection; private vulnerability reporting | Phase 0 | 30 min | Repo settings |
| 8 | Apple identifiers: `ai.dreamstreamstudio.streamstudio` plus `.watchkitapp`, `.widgets`, `.notifications`, `.watchkitapp.notifications`; App Group `group.ai.dreamstreamstudio.streamstudio`; Keychain sharing group. Capabilities: Push, **Time Sensitive Notifications**, App Groups, Associated Domains (applinks, webcredentials), Background Modes (audio, remote-notification; voip in Phase 1.1), **App Attest**. Reserve the App Store name. | Phase 1 week 1 | 1 h | Developer portal |
| 9 | **APNs auth key (.p8)** | Phase 1 week 2 (the probe doesn't need it) | 10 min | Worker secrets (#5) |
| 10 | **App Store Connect API key** (Admin for the first certificate, then App Manager) | Phase 1 week 3 | 10 min | `ios-release` Environment secrets |
| 11 | **Critical Alerts entitlement request** (Account Holder). Cases: unanswered infant cry that escalates, smoke/CO alarm heard in the nursery, nursery camera offline overnight, baby leaving the crib zone. | Phase 1 week 1 | Weeks; assume denied | Entitlement |
| 12 | **Local Push Connectivity (`app-push-provider`) entitlement request** | Phase 1 (for Phase 4) | Weeks | Entitlement |
| 13 | Firebase project (free Spark plan): Android app `ai.dreamstreamstudio.streamstudio`; a service account with only the FCM sender role | Phase 1 week 2 | 30 min | `FCM_SA_JSON` Worker secret; `google-services.json` in an Environment secret |
| 14 | Play Console: create the app; **Play App Signing**; generate the upload key on your own machine; **Workload Identity Federation** for the Play Developer API; foreground-service declarations (camera, microphone, mediaPlayback; connectedDevice in 3.1) **with demo videos**; Data safety; content rating; full-screen intent (calling) only when calls ship; add the **Wear OS form factor** in Phase 3 | Phase 1 weeks 3–8 | Review days | `android-release` Environment |
| 15 | Give us the Apple Team ID and the Android SHA-256 certificate fingerprints | Phase 1 week 4 | 5 min | AASA and `assetlinks.json` |
| 16 | Test hardware: spare iPhone (iOS 17.2+, camera); daily iPhone on iOS 26 plus **Apple Watch Series 9+ or Ultra 2** on watchOS 26; Android phone (14+); **Wear OS 5+ watch** (Pixel Watch 2/3 or Galaxy Watch 6+) | Phase 1 week 4 / Phase 2 / Phase 3 | Purchase | — |
| 17 | 5 parents for the moderated 3-second watch test; 12 Play testers if the account is personal | Phase 1 week 6 / Phase 2 | Recruiting | — |
| 18 | Approve `security.txt`, the disclosure policy and the privacy policy matching D6.4 | Phase 0 / Phase 1 store listing | 1 h | Pages |
| 19 | Flat-rate host account for coturn (EU and US) when TURN egress exceeds 1 TB/month | Scale trigger | 1 day | Hosts |

---

## Sources

- Cloudflare DO pricing (duration billing, hibernation eligibility, rows, 20:1 WebSocket ratio): https://developers.cloudflare.com/durable-objects/platform/pricing/ · DO lifecycle: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ · DO WebSockets: https://developers.cloudflare.com/durable-objects/best-practices/websockets/ · DO metrics: https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/ · Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare TURN FAQ and pricing: https://developers.cloudflare.com/realtime/turn/faq/ · https://developers.cloudflare.com/realtime/pricing/ · per-user credentials and revoke: https://developers.cloudflare.com/realtime/turn/generate-credentials/ · Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ · Pages `_headers` not applied to Functions: https://developers.cloudflare.com/pages/configuration/headers/ · Turnstile CSP: https://developers.cloudflare.com/turnstile/reference/content-security-policy/ · Certificate pinning: https://developers.cloudflare.com/ssl/reference/certificate-pinning/
- APNs over HTTP/2 from Workers: https://github.com/cloudflare/workerd/issues/4841 (open; production goes through the proxy) · https://github.com/cloudflare/workerd/issues/6455 · https://jsr.io/@fivesheepco/cloudflare-apns2 · APNs connection: https://developer.apple.com/documentation/usernotifications/establishing-a-connection-to-apns · FCM Live Activity: https://firebase.google.com/docs/cloud-messaging/customize-messages/live-activity
- npm registry, checked 2026-10-22: `expo` latest 58.0.17 (2026-10-21); `react-native` 0.88.0; `react-native-webrtc` 155.0.1 (2026-10-20), 155.0.0 (2026-10-14), 124.0.8 (2026-07-21); `@config-plugins/react-native-webrtc` 15.0.2; `@bacons/apple-targets` 5.0.0 · Expo DOM components: https://docs.expo.dev/guides/dom-components/ · apple-targets watch: https://mintlify.wiki/EvanBacon/expo-apple-targets/targets/watch-apps
- watchOS networking: https://developer.apple.com/documentation/technotes/tn3135-low-level-networking-on-watchos · audio-session revoke (FB24377808): https://developer.apple.com/forums/thread/841590 · https://developer.apple.com/forums/thread/841760 · notification forwarding: https://developer.apple.com/documentation/watchos-apps/taking-advantage-of-notification-forwarding · Live Activities: https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities · ActivityKit push: https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications · WidgetKit push: https://developer.apple.com/documentation/widgetkit/updating-widgets-with-widgetkit-push-notifications · double tap: https://developer.apple.com/documentation/watchos-apps/enabling-double-tap · Always On: https://developer.apple.com/documentation/watchos-apps/designing-your-app-for-the-always-on-state · watchOS 26 devices: https://www.tomsguide.com/wellness/smartwatches/watchos-26-is-here-and-these-apple-watch-models-are-eligible-for-an-upgrade
- iOS: multitasking camera: https://developer.apple.com/documentation/avfoundation/avcapturesession/ismultitaskingcameraaccessenabled · Local Push Connectivity: https://developer.apple.com/documentation/networkextension/local-push-connectivity · TN3179 local network privacy: https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy · App Attest: https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity · NSE: https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications · Critical Alerts: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.usernotifications.critical-alerts · SDK requirements: https://developer.apple.com/news/upcoming-requirements/
- Android and Wear OS: foreground-service background-start limits: https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start · foreground service types on Play (connectedDevice lists baby monitors): https://support.google.com/googleplay/android-developer/answer/16965181 · local network permission: https://developer.android.com/privacy-and-security/local-network-permission · Wear network access and FCM: https://developer.android.com/training/wearables/data/network-access · bridging: https://developer.android.com/training/wearables/notifications/bridger · Wear OS 7: https://android-developers.googleblog.com/2026/05/whats-new-wear-os-7.html · Live Updates: https://developer.android.com/training/wearables/notifications/live-updates · target SDK: https://developer.android.com/google/play/requirements/target-sdk · Play Integrity quotas: https://developer.android.com/google/play/integrity/setup · Network Security Config (CT): https://developer.android.com/privacy-and-security/security-config
- Supabase: MFA and `aal`: https://supabase.com/docs/guides/auth/auth-mfa · sessions: https://supabase.com/docs/guides/auth/sessions · signing keys: https://supabase.com/docs/guides/auth/signing-keys · auth hooks: https://supabase.com/docs/guides/auth/auth-hooks · passkeys (experimental): https://supabase.com/docs/guides/auth/passkeys · pricing: https://supabase.com/pricing
- Browser LAN limits: https://developer.chrome.com/blog/local-network-access · Let's Encrypt rate limits: https://letsencrypt.org/docs/rate-limits/ · RFC 8291: https://www.rfc-editor.org/rfc/rfc8291
- CI: macOS 26 runners: https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/ · Android emulator acceleration: https://github.blog/changelog/2024-04-02-github-actions-hardware-accelerated-android-virtualization-now-available/ · Play 12-tester rule: https://extendsclass.com/blog/google-plays-closed-testing-requirement-what-developers-need-to-know-in-2026

---

## Phase 0 implementation checklist

### Ground rules
1. **Two waves.** Wave 1 workstreams (WS-1 to WS-8) run in parallel and own disjoint files. Wave 2 (WS-9 to WS-11) starts after Wave 1 merges and also owns disjoint files. No file is owned by two workstreams in the same wave (see the matrix in section 4).
2. **Capability-gated.** The server advertises `caps` in `hello`. Clients use a feature only when the server lists it, so Wave 1 client changes can merge and deploy before Wave 2 server changes and stay dormant.
3. **The contract below is frozen** for Phase 0. Changing it needs a note in this ADR.
4. Every workstream adds tests in its own files and must keep `npx vitest run`, `npm --prefix live-worker run typecheck` and `npx vite build` green.
5. SQL is idempotent and applied by the owner (`CLAUDE.md` rule). No production deploy until the wave's acceptance subset passes.

### 1. Shared contract: protocol v2 delta

| Direction | Message or route | Shape | Notes |
|---|---|---|---|
| room → client | `hello` (extended) | `caps: ('reauth'\|'view'\|'eid'\|'e2e1'\|'glance1'\|'stats5')[]`, `exp?` | Existing `hello` plus `caps` |
| client → room | `reauth` | `{t:'reauth', token}` → `{t:'reauth_ok', exp}` | Sent on the window event `ds:token` (detail = access token), dispatched by WS-5 |
| room close codes | — | `4001` expired, `4003` mfa_required, `4004` removed or revoked, `4005` replaced (existing), `4008` rate limited | MonitorRoom also closes a role refusal with `4004` `forbidden`: clients read the reason first (`closeKind`) |
| viewer → room | `view` | `{t:'view', vis: boolean, dc: boolean}` | Sent on change only |
| room → camera | `live_want` | `{t:'live_want', on: boolean}` | `on` when any visible viewer lacks an open data channel, or is a relay viewer |
| camera → room | `status` | Unchanged shape; sent **on material change** plus every 60 s | Material: state, sound, model, paused, awake, talk/call, soothing, 5% battery steps, visit, posture, `enc.lim` |
| camera → room | `stats` | `{t:'stats', rows: MinuteRow[]}` every 5 min; flushed at once on hello or reconnect | Replaces per-minute messages when `stats5` is listed |
| camera → room | `event` (and sound/vision) | Adds `eid: "<dev>:<seq>"` | Idempotent insert; viewers dedupe the data channel against the room by `eid` |
| any → room | `dev_hello` | `{t:'dev_hello', devId, sigPub, ecdhPub, pushKey?, name, platform, sig}`, with `sig` over `nid\|nonce\|ts` | Room nonce comes in `hello.nonce` |
| room ↔ holder | `key_req` / `key_wrap` / `key_init` / `key_rotate` | `{devId, e}` / `{devId, e, blob}` / `{e:1, wraps}` / `{e, wraps[]}` | DO stores wraps in `mon_keywraps`; compare-and-set on epoch |
| client ↔ client via room | `rtc` | `d: {e, iv, ct}` when both peers list `e2e1` | DO forwards unchanged (it already does); sticky E2E enforced by clients |
| camera → room (binary) | relay frame v1 | 22-byte header plus AES-GCM ciphertext; total ≤ `SNAPSHOT_MAX` | Camera keeps the JPEG ≤ `SNAPSHOT_MAX − 64` |
| room → glance socket | `glance` | `{t:'glance', g: GlanceV1}` | Socket `mode:'glance'`; nothing else is sent to it |
| room → client | `ice_refresh` | `{t:'ice_refresh', iceServers, ttl}` | At 80% of the TTL |
| HTTP | `GET /api/monitor/:nid/glance` | Bearer (Supabase JWT, or device token plus `DS-Proof`); `If-None-Match` → 304 or 200 `{g}` | |
| HTTP | `POST /api/monitor/:nid/act` | `{a:'ack'\|'resolve'\|'soothe'\|'soothe_stop'\|'duty_on'\|'duty_off', inc?, v?, id}` → `{ok, g}`; or `Authorization: DS-Act <act token>` from the service worker | |
| HTTP | `POST /api/monitor/:nid/members` | `{op:'add'\|'remove'\|'role', user, role?, label?}` with Bearer; Worker → RPC → DO `/x/members` | Requires `aal2` |
| HTTP | `POST /api/me/kick` | Bearer → for each nursery from `monitor_list`: DO `/x/kick {uid}`; UserLine `/x/kick` | Then the client calls `signOut({scope:'global'})` |
| HTTP | `POST /api/devices/enroll` · `/token` · `/push` · `DELETE /api/devices/:id` | As in D4.4 | `code` and `approve` arrive in Phase 3 |
| HTTP (admin) | `POST /api/ops/apns-probe` | Header `x-ops-key` = secret | Returns status, `apns-id` and body |
| Push payload (web) | adds `act`, `inc`, `q` | `act` = base64url(HMAC(`ACT_TOKEN_KEY`, `nid\|inc\|uid\|exp`)) | Service-worker action "I'm on it" |

### 2. Wave 1 (parallel)

#### WS-1 Edge headers and supply chain
**Owns:**
- `functions/_middleware.ts`
- `functions/csp-report.ts` (new)
- `public/_headers`
- `index.html`
- `live.html`
- `public/.well-known/security.txt` (new)
- `package.json`, `package-lock.json`
- `live/monitor/yamnet.worker.ts`
- `/home/user/Comic2/.github/workflows/*.yml` (existing files)
- `/home/user/Comic2/.github/dependabot.yml` (new)
- `/home/user/Comic2/.github/CODEOWNERS` (new)
- `/home/user/Comic2/.github/workflows/scorecard.yml` (new)

**Tasks:**
- [x] `_middleware.ts`: wrap every `next()` response and set the security headers.
  - For `/live*`, an **enforced** CSP (the D6.5 policy as listed in the security study, adding `worker-src 'self' blob:` and the `report-to csp` endpoint).
  - For every other page, `Content-Security-Policy-Report-Only`.
  - Keep the redirect and agent-gate behaviour byte-for-byte.
  - Ship as Report-Only everywhere for 48 h behind `const ENFORCE_LIVE = false`, then flip it. *(The flip is §5 step 4, after 48 h of clean reports.)*
- [x] `functions/csp-report.ts`: accept `application/reports+json` and `csp-report` bodies, count by directive and blocked origin, log no URLs with query strings, return 204.
- [x] `public/_headers`: under `/*`, add HSTS, `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy` for static assets and `live-sw.js`.
- [x] `index.html`:
  - Delete the `aistudiocdn.com` importmap.
  - Add `integrity` and `crossorigin` to the jsPDF 2.5.1 and html2canvas 1.4.1 cdnjs tags (bundling is a later task).
  - Hash the inline splash watchdog script into the CSP.
- [x] `live.html`: no inline scripts left without a CSP hash.
- [x] `yamnet.worker.ts`: remove `FALLBACK_URL` (Hugging Face). Keep the self-hosted, hash-checked model.
- [x] `package.json`:
  - `onnxruntime-web` → 1.30.0.
  - `@supabase/supabase-js` → ≥ 2.118 (needed by WS-5's MFA APIs).
  - `npm audit fix` for proxy-addr, react-router, sharp and adm-zip.
  - Commit the lockfile.
- [x] Workflows: pin every action by SHA; add top-level `permissions: contents: read`; reference Environments for deploy secrets. Add Dependabot with a 7-day cooldown, CODEOWNERS (`.github/workflows/** @owner`), and the Scorecard workflow.
- [x] `security.txt`: contact address and policy URL.

**Done when:** headers are verified with `curl -I` on a preview deploy, the 48 h report log is clean, and `npm audit --omit=dev` shows 0 critical and 0 high.

*Status 2026-10-28 (WS-1 built; branch `impl/p0-ws1`):*
- *The live policy adds two sources the security study's draft lacked, both found in the built bundle: `script-src blob:` (the sound engine's and the relay player's AudioWorklets load from `blob:` URLs, and `addModule` is governed by `script-src` — without it the enforced policy would have cut off cry detection) and `connect-src` for both of our hosts. `tests/edge/liveCsp.built.test.ts` serves `dist/` through the real middleware with the policy enforced and checks every tag, every reachable chunk's external origins, workers, worklets, WebAssembly and the live Worker, Supabase and Drive endpoints against the header. HSTS, nosniff, `Referrer-Policy: strict-origin`, Permissions-Policy, COOP and `X-Frame-Options: DENY` are enforced on Stream Studio from the first deploy; only the CSP waits for `ENFORCE_LIVE`. `/` stays Report-Only (no COOP or framing change there yet).*
- *Counts land in an Analytics Engine dataset bound as `CSP_REPORTS` once the owner binds it; until then, bounded log lines (1st, 10th, 100th … of each kind).*
- *`npm audit --omit=dev`: 0 vulnerabilities. `@huggingface/transformers` stays on 4.2.0 (with `overrides` lifting its Node-only `sharp` and `onnxruntime-node` past their advisories): 4.3.x bundles an ONNX Runtime whose asyncify `.wasm` is 25.6 MiB, over Pages' 25 MiB file limit. The built-page test fails any build with a file over the limit.*
- *Headers verified with `curl -I` against `wrangler pages dev dist` (local); the preview-deploy check and the 48 h report window need a deploy.*
- *`@supabase/supabase-js` 2.118 requires Node ≥ 22: on Node 20 realtime-js throws "native WebSocket not found" when the server creates its Supabase client at import, so the container (then `node:20-slim`) and the hourly catalog / daily NVIDIA jobs would have crashed on deploy. Every server runtime moved to Node 22 in the same change: `Dockerfile.cloudflare` (both stages, esbuild `--target=node22`), the Railway `Dockerfile`, `.nvmrc` / `.node-version` (22.22.0), `engines` (`>=22.13.0`, pdfjs-dist's floor) and every workflow. The new `server-boot` job (`.github/workflows/server-boot.yml`, no secrets) bundles the server with the Dockerfile's own esbuild command and boots it on the Dockerfile's Node major until `GET /api/health` answers; `ci.yml` runs it on every PR and push, and `deploy-api-proxy.yml`'s rollout waits for it. `tests/edge/nodeRuntime.test.ts` keeps the pins in step and checks every locked package's `engines` against that Node.*

#### WS-2 Shared contracts (seed `packages/monitor-core`)
**Owns:** all of it is new:
- `packages/monitor-core/package.json`, `tsconfig.json`
- `src/index.ts`
- `src/glance.ts` (types plus `composeGlance`)
- `src/glanceBump.ts` (`nextBump`)
- `src/sealed.ts` (wrap/unwrap, frame seal/open, signaling seal/open, HKDF labels; WebCrypto only)
- `src/eid.ts`
- `src/wire.ts` (the section 1 types, caps, close codes)
- `src/*.test.ts`
- `fixtures/glance/*.json`, `fixtures/sealed/*.json`

**Tasks:**
- [x] `composeGlance(state, viewer)` exactly as in D2, with the `can` bitmask from role and device caps, and `nm` omitted when `forPush`. *(Done 2026-10-28. `can`: parents and caregivers 127, viewers 20 (listen, peek), viewer guests 20, caregiver guests 31 (no duty, no logging); a device grant only narrows it, never above a caregiver. A glance never exceeds 512 B: long names are shortened to fit, ids never. Also `glanceFacts` (what a room or an app knows → the nursery-wide facts, so the room and the phone apps compose alike), `parseGlance`, `glanceEtag` (`q` plus this device's `can` and whether it is on duty, so a role change isn't hidden behind a 304) and `coarseGlance` (the Live Activity fallback).)*
- [x] `nextBump` implements the bump rules. Add a night-replay fixture (`fixtures/glance/night-*.json`) asserting **60 bumps or fewer**. *(Done: a recorded-style night — two cries answered by different parents, a fuss, stirs, a Wi-Fi blip, an unplugged then charged camera phone, a duty hand-over — gives **53** bumps, golden for every port. Refinements: between bumps the glance is frozen and a bump publishes every current fact, so one `q` is one content; 2 dB of hysteresis on the dB band edges and 3 points on the battery going back up, so a fan at 55 dB or a phone at 20 % doesn't flap; a resolved alert ageing out waits for the next bump; entering or leaving offline/waiting is immediate; a rename bumps. Crying, fussing, alerts and a camera going offline are never delayed. Review fixes, 2026-10-28: (1) with several cameras the mood is dated from when `nextBump` saw it begin, never from a calmer camera's `since` (`BumpState.seen`), and `glanceFacts` dates it from the last camera to reach it — a twin stirring 20 s / settled 5 s for an hour was 288 bumps, now one, as with one camera; a shown mood keeps its start. (2) "30 s sustained" is measured: `GlanceFacts.dbt` says when each level was taken, a band moves only when a level taken 30 s or more after the first one in it still shows it, and a re-check is no measurement — a single loud second at a 2-minute keepalive was a bump each way; the level is the camera's minute LAeq while fresh (`GlanceCamInput.minute`), the status's 1-second Leq otherwise. (3) A battery first seen under 20 % bumps (an Android phone joining at 8 % beside an iPhone camera with no reading). (4) A bump for something else holds a mood still in its 15 s and an unconfirmed band as shown, so an alert opening in a breath between cries shows "crying". The night fixture is now simulated as the room hears it (statuses on change and every 2 minutes, minute rows every minute) with a second camera from 22:00: a restless half hour on one camera, the 04:00 cry in bursts over the other seeing her stir, the second phone joining at 17 %. It gives **57** bumps; the earlier rules give 79 on the same facts.)*
- [x] `sealed.ts`: `wrapNmk(nmk, ecdhPub, ctx)`, `unwrapNmk`, `sealFrame(nmk, camDev, hdr, bytes)`, `openFrame` (with sequence and age checks), `sealSignal`, `openSignal`. Fixtures carry fixed test keys and vectors, so Swift and Kotlin can reproduce them byte for byte. *(Done. Reconciled with the relay wire that shipped after this ADR (`live/monitor/relayWire.ts`): the room keeps reading its 11-byte relay header in clear (kind, key flag, seq, codec) — that is how hidden viewers get the sound only — and each part (picture, sound) is sealed on its own as frame v1 = the 22-byte header (`ver|e|cam|seq|ts|flags`) ‖ AES-GCM. `cam` is the stream within the camera (0 picture, 1 sound) with one seq counter per camera across streams, seeded from the clock so a nonce never repeats across restarts. `sealFrame(nmk, {nid, camDev}, hdr, bytes)` takes `nid` for the AAD. A frame's age is measured against the camera's own clock, so a phone whose clock is off still works while frames held back over 10 s are dropped. Sealed signaling also names its sender in clear (`f`). The `dev_hello` signature covers the ECDH key too (`ds-hello|nid|nonce|ts|ecdhPub`), so the server can't swap the key the NMK is wrapped to.)*
- [x] `wire.ts`: export `CAPS`, `CLOSE`, and the message types from section 1. No runtime dependencies. *(Done. Close codes reconciled with what the rooms already send: 4003 also means `full`/`forbidden` and 4008 also a retired `stale` line; the reason string tells them apart (`closeKind`, `CLOSE_ADVICE`). MonitorRoom closes a role refusal (a viewer opening camera mode, a caregiver demoted while running it) with 4004 `forbidden`, so `closeKind` reads `forbidden` before the code: it is never "removed", which would forget the nursery. `ice_refresh` is the shipped `{t:'ice', servers, iceMs}`. `dev_hello` carries the `ts` it signs; `key_req` carries the device's `ecdhPub`; the room's rotation request carries `devs`; `key_conflict` answers a lost compare-and-set. Validators for act (with `ACT_NEEDS`: the same `can` bit the glance shows), members, reauth, view, `dev_hello` and the key messages; `rtcPolicy` for sticky E2E; the native push envelope.)*

**Done when:** vitest is green, fixtures exist, and both `live-worker` and `live/` can import the package by relative path (`tsc` checks). *(Met 2026-10-28: `packages/monitor-core` has 107 tests over every fixture, including a purity test that compiles it against the ECMAScript library alone (no DOM, no Node) in CI; `npm run check:consumers` there also compiles it as the live Worker and the web app do.)*

#### WS-3 Push transports (Worker, mostly new files)
**Owns:**
- `live-worker/src/webpush.ts` and `webpush.test.ts`
- `live-worker/src/push/apns.ts`, `fcm.ts`, `envelope.ts`, `router.ts`, `probe.ts`, `vapidCache.ts`, `*.test.ts` (all new)

**Tasks:**
- [x] `webpush.ts`: export the aes128gcm `encryptPayload(p256dh, auth, bytes)` and the ES256 JWT signer for reuse. Behaviour unchanged. *(Done 2026-10-28: `encryptPayload` (with optional RFC 8188 padding) and `signJwtES256`; the RFC 8291 vector still matches byte for byte and `sendWebPush` is tested unchanged.)*
- [x] `apns.ts`: provider JWT (ES256, cached for 50 min), `sendApns({token, type: 'alert'|'liveactivity'|'voip'|'widgets', topic, priority, collapseId, expiration, payload})`. Map APNs reasons to `gone | retry | fatal`. *(Done 2026-10-28: `iat` aligned to a 50-minute window so isolates agree; one fresh-token retry on `ExpiredProviderToken`; a 410 dated before the token's registration doesn't prune it. Only an answer about the token itself prunes (`Unregistered`, `ExpiredToken`, `BadDeviceToken`); a topic mismatch (`DeviceTokenNotForTopic`, `TopicDisallowed`, `BadTopic`, `MissingTopic`) is a fourth outcome, `config`: a wrong bundle id would get it for every token, so the token is kept and the router logs `push_config`.)*
- [x] `fcm.ts`: service-account RS256 JWT → OAuth token (cached 55 min); `sendFcm({token, data, androidPriority, ttl, collapseKey, apns?})`; map `UNREGISTERED` to `gone`. *(Done 2026-10-28: also an `INVALID_ARGUMENT` naming `message.token`; a payload error never prunes; a 401 retries once with a fresh OAuth token. `SENDER_ID_MISMATCH` is `config`, not `gone`: a service account from the wrong Firebase project would get it for every token, so the token is kept and the router logs `push_config`.)*
- [x] `envelope.ts`: `sealForDevice(sub, json)` → `{e}` using RFC 8291 for both web and native; ciphertext ≤ 1 KB. *(Done 2026-10-28: padded to 128-byte steps; reference decoder `openEnvelope`; golden vector `live-worker/src/push/fixtures/envelope-v1.json` for the NSE and Android decoders.)*
- [x] `router.ts`: `type PushSub = {kind:'webpush'|'apns'|'apns-la'|'apns-voip'|'fcm', dev, uid, token|sub, enc?}`; `deliver(sub, msg)` returns `ok | gone | retry`; `msg.replace` for the acknowledgement replacement push (collapse ID / tag). *(Done 2026-10-28: dormant — native kinds make no request until their secrets and tokens exist; `apns-voip` waits for `PUSH_VOIP=1`; Live Activity state in clear is cut to the coarse enum; `replacementOf`, `deliverAll`, `parsePushSub`, `routerFromEnv`. WS-9/WS-10 wire it in. Failures on our side (`fatal`, `config`, and a call message without a call id) keep the token and log one `push_config` / `push_fatal` JSON line with no token, uid or names.)*
- [x] `probe.ts`: the sandbox probe described in D3; returns `{status, apnsId, body}`. *(Done 2026-10-28: plus verdict, decision and the D3 line; `handleApnsProbe` for WS-7's ops route. Runnable now without WS-7: the manual "APNs HTTP/2 probe" workflow deploys a throwaway Worker (`push/probeWorker.ts`), runs `live-worker/scripts/apnsProbe.mjs` against it, records the result in the job summary and an `apns-probe` artifact, and deletes the Worker (pinned wrangler, `production-deploy` Environment; a test keeps it to that one throwaway Worker). A Node HTTP/2 control from the build container passed on 2026-10-28 (403 `MissingProviderToken` with `apns-id`); the production result is still to be recorded in D3.)*
- [x] `vapidCache.ts`: module-scope cache for `KEY_HOLDER` keys, so a DO only refetches when its isolate is cold. *(Done 2026-10-28: concurrent callers share one fetch; a failure is never cached.)*

**Done when:** tests pass against recorded APNs and FCM HTTP fixtures, including the 410 and `UNREGISTERED` paths. *(2026-10-28: green. The no-credential responses were recorded from Apple and Google; the 410, `UNREGISTERED` and other paths that need a real key and device follow the providers' documented bodies and are marked `documented` in `push/fixtures/` — re-record them with the owner's keys in Phase 1.)*

#### WS-4 Identity, SQL and email
**Owns:**
- `server/sql/live_security_v2.sql` (new)
- `live-worker/src/supabaseAuth.ts`
- `live-worker/src/auth/jwks.ts`, `auth/deviceToken.ts`, `auth/actToken.ts`, `auth/*.test.ts` (new)
- `live-worker/src/ice.ts`, `ice.test.ts`
- `live-worker/src/monitorGuests.ts`, `monitorGuests.test.ts`
- `email-worker/src/securityAlert.ts` (new), `email-worker/src/index.ts`, `email-worker/src/index.test.ts`
- `server/src/routes/authEmail.ts`
- `scripts/ops/genDeviceTokenKey.mjs` (new)

**Tasks:**
- [x] SQL (idempotent): *(Done 2026-10-28 in `server/sql/live_security_v2.sql` — not applied; owner action #4. Applied twice in a row, and again after re-applying `live_accounts_and_monitor.sql` with data present, on Postgres 16 with a stand-in for Supabase's `auth`/`vault`/`net` schemas; a behaviour script checked every bullet below. It redefines every member RPC of `live_accounts_and_monitor.sql` (all but `live_welcome_check`), so it must be re-applied whenever that file is. Review fix 2026-10-28: the session and `aal2` check now guards all of them — `live_join`, `live_update_profile`, `live_search_people`, `monitor_list`, `monitor_create`, `monitor_update`, `monitor_delete`, `monitor_people`, `monitor_member_ids` as well as the four first done — so a phished password or a token whose session was ended can't delete, rename or list a nursery. The psql harness (`node server/sql/tests/harness.mjs`, also run by vitest as `server/sql/tests/sqlHarness.test.ts`, skipped without Postgres) applies the file twice on a Supabase stand-in and fails if any `live_*`/`monitor_*` function callable by signed-in clients skips the check.)*
  - `monitor_my_role` and `live_me` return `session_revoked` when `auth.jwt()->>'session_id'` is missing from `auth.sessions`, and `mfa_required` when a verified factor exists and `aal` is not `aal2`. *(One helper, `live__session_problem()`; a session past `not_after` counts as revoked. The same check guards every member RPC (each returns `{ok:false, error}`) and the new device and security RPCs. Success answers add `mfa` and `aal`, which the room's role cache uses.)*
  - Table `live_devices(id, user_id, thumb, platform, name, created_at, last_seen, revoked_at)` with owner-only RLS and RPCs `live_device_enroll`, `live_device_list`, `live_device_revoke`. *(`thumb` = RFC 7638 thumbprint of the device's P-256 key; one live row per key per account, 20 at most; enrol and revoke need `aal2` once MFA is on and write `security_events`. Plus `live_device_active(id, thumb)`, callable without a session, for the Worker's grant → access-token exchange (WS-7 `devices.ts`), and `live_security_events()` for WS-5's "recent security events".)*
  - Table `security_events(user_id, session_id, kind, ua, ip_masked, at)` with a unique index on `(user_id, session_id)`. *(Partial: `where kind = 'sign_in'`, so account events — `secured`, `device_added`, `device_revoked` — share the table. Also `method`, `notified`, `secure_hash` (sha256 of the "Not you?" token, never the token), `secure_used_at`, `detail`. pg_cron sweeps after 180 days.)*
  - `public.live_access_token_hook(event)`:
    - adds the claim `ds_mfa` (has a verified factor);
    - for a session id it hasn't seen, reads `auth.sessions` (UA, IP), inserts into `security_events`, and calls `net.http_post` to the email Worker `/security` with an HMAC header using the Vault secret; *(Emails only genuine new sign-ins: not token refreshes — so switching the hook on doesn't mail every existing session — not anonymous sign-ins, not an account's first session, at most 5 an hour. The URL is `live_private_config.security_hook_url`; IPs are masked to /24 or /48 in the database. Header `x-ds-signature: t=<s>,v1=<hex HMAC-SHA256("<t>.<p>")>` over body `{"p": "<payload JSON as a string>"}`, so the signed bytes survive pg_net's jsonb handling — checked end to end against the Worker's verifier.)*
    - grant execute to `supabase_auth_admin` only. *(It never blocks a sign-in: every side effect is wrapped; a failure only costs the email.)*
  - `live_secure_account(p_token)` revokes all of the user's sessions and starts a recovery email; `monitor_list` is used by the kick route. *(Single use, 7 days. Also revokes devices enrolled since that sign-in and returns them (id, thumb) for the Worker's revoke fan-out. The recovery email is sent by the backend: `POST /api/auth/email/secure {token}` calls this RPC with the service role — the only caller that gets the address back — and mails the reset link, so WS-5's landing page posts there; calling the RPC directly still ends the sessions but sends no email.)*
  - Membership RPCs return the changed user ids. *(`monitor_set_member` → `changed`, `role`, `previous_role`, `added`; `monitor_remove_member` → `removed`, `changed`, `left`.)*
- [x] `supabaseAuth.ts`: `verifyAccessToken(token, env)` → `{uid, sid, exp, aal, mfa}`. ES256 via JWKS (`auth/jwks.ts`, cached 15 min), with fallback to the existing RPC when no JWKS or HS256 is in use. Keep `callRpc`. *(Done 2026-10-28. Also RS256; `iss`/`aud`/`role`/`exp`/`iat` checked; an unknown `kid` triggers one refetch at most every 30 s; JWKS outage → the RPC path, never acceptance. `mfa` is the `ds_mfa` claim, or null when the hook is off. For WS-9: `auth/roleCache.ts` — `admitMember()` combines it with the `{uid → role, label, name, mfa}` cache (`SqlRoleStore`, table `mon_roles`, re-asked every 6 h, on `recheck`, or after `drop()`), enforces `aal2` for anyone with a factor (from the claim or from `monitor_my_role` when the hook is off) — a cached "has a factor" never refuses on its own: a fresh `ds_mfa` claim wins, and a cached factor against an aal1 token re-asks Supabase (during an outage, the claim decides; with no claim, 1013), so turning two-step sign-in off can't lock anyone out for the cache's 6 hours — keeps known members on a stale entry through a Supabase outage, and returns the close code (4001/4003/4004, 1013 to retry) and `closeAt = exp + 120 s`. `mfaProblem`/`stepUpNeeded` for WS-7's `members.ts`.)*
- [x] `auth/deviceToken.ts`: grant and access JWT (ES256, `DEVICE_TOKEN_JWK`); `verifyDsProof(req, jkt, nonceStore)` with ±60 s and nonce dedupe through an injected interface. *(Done 2026-10-28. Grants 30 days (`aud` ds-device-grant, `typ` ds-grant+jwt), access tokens 10 min (ds-device / ds-access+jwt) — neither passes as the other; `scopesForRole` caps at caregiver, viewers get glance/peek/listen; `{"keys":[new, old]}` rotation. Contract note: the proof is `DS-Proof: v1.<ts>.<nonce>.<P-256 point>.<sig>`, signing `"ds-proof-v1\n" METHOD "\n" path "\n" ts "\n" nonce "\n" b64url(sha256(body))` — the nonce has to be inside the signature or a replay could swap it; path as the Worker routes it (`/api/…`, query included). Golden vector for Swift/Kotlin: `live-worker/src/auth/fixtures/ds-proof-v1.json`. Only correctly signed proofs reach the nonce store.)*
- [x] `auth/actToken.ts`: mint and verify single-use service-worker action tokens (`ACT_TOKEN_KEY`). *(Done 2026-10-28. Contract note: the token is `a1.<uid>.<exp>.<mac>`, mac = base64url(HMAC-SHA256(key, "ds-act-v1|nid|inc|uid|exp")) — the uid and expiry have to travel with the MAC for it to be checkable. 30 minutes, spent on first use (same `NonceStore`), `actFrom()` reads `Authorization: DS-Act`; the room accepts only `ack` with it.)*
- [x] `ice.ts`: remove the module-level shared credential. `mintIce({principal, ttlSec})` (members 4 h, guests the shorter of 2 h and the pass expiry) returns `{iceServers, username, exp}`; `revokeIce(username)`; a `(uid, nid)` cache for half the TTL. *(Shipped before this checklist ran, with the TURN guardrails (2026-10-22/23): `iceFor(env, {room, who, bill, guest, until})` mints per room + person + payer with these lifetimes and returns the servers plus `iceMs` (ask again ahead of expiry); `revokeIce(env, room, match)` revokes by person; reuse is capped at min(5 min, a quarter of the TTL) rather than half, so a leaked credential is shared by fewer reconnects. Covered by `ice.test.ts`.)*
- [x] `monitorGuests.ts`: `removeGuest` also rotates the link code and passcode and returns `{newLink}`; lockout is per guest, not per link; export a `guestCaps(role)` least-privilege table (viewer guest: live view, listen, live alerts only); add a rate-limit hook interface. *(Done 2026-10-28; review fix the same day. `removeGuest(id, now, {rotate?, pass?})` → `{id, name, newLink}` (null if no such guest). By default only that guest's pass ends — the link, its passcode and everyone else's passes keep working, so family who hold the link but haven't opened it yet aren't told it was "turned off", and making a guest a member never changes the link; `newLink` is null and `removalNotice()` gives the parents' log line, which says the removed person still knows the link and to set a new passcode if they shouldn't rejoin. With `rotate: true` the link gets a new code (the old one answers "turned off"; guests already watching move to it), and with `pass` from `preparePasscode('auto' | chosen)` (implies `rotate`) the passcode changes too and `newLink.pass` is shown to the parent once — opt-in, only together with a UI that shows the parents the new link to pass on: WS-9 passes `{rotate: true, pass: preparePasscode('auto')}` when WS-6's PeopleCard shows "Link and passcode changed". Per-guest lockout is `new GuestAccess(sql, {lockout: 'guest'})`: 5 wrong lock that address (hashed, per link) for 15 min, 20 wrong in all lock the link for an hour instead of turning it off — the room opts in with WS-9, together with its "link locked" copy. `guestCaps`/`guestCan`/`guestAckEnds` (never ends an `everyone` hazard)/`guestCanBits`; `GuestLimits` takes the `RL_GUEST`/`RL_GUEST_NID` bindings as they are (fails open).)*
- [x] `email-worker`: `POST /security` verifies the HMAC, renders "New sign-in to your DreamStream account" (device, time, masked IP, **Not you? Secure my account** link carrying a one-time token), and sends it. Tests included. *(Done 2026-10-28, `email-worker/src/securityAlert.ts`: ±5 min timestamp, `|`-separated secrets for rotation, plain-words device ("Safari on iPhone"), UTC time, IP re-masked, how they signed in. The link is `<live app>/live#/secure/<token>` — a hash route, because `/live/secure` falls to the main app's SPA fallback on the apex; it follows the Stream Studio host when it moves. WS-5's page reads the token from there. Review fix 2026-10-28: the button is only sent once that page exists — the Worker var `SECURE_ACCOUNT_PAGE=on`, which WS-5 sets when `#/secure` ships; until then the email sends people to the main site's Settings → Security (change password, Sign out everywhere; "Forgot password?" if locked out). And it says "there was a new sign-in", not "a device we haven't seen": the hook emails every genuinely new session and deliberately doesn't skip a familiar browser and network, which would silence an intruder on the same Wi-Fi.)*
- [x] `authEmail.ts`: k-anonymity Pwned Passwords check at sign-up (first 5 characters of the SHA-1 hash, padding header). Fails open with a log line. *(Done 2026-10-28: before the captcha, so a refused password doesn't spend the token; 2.5 s timeout; `PWNED_PASSWORDS_CHECK=off` switches it off. Plus `POST /api/auth/email/secure` (see the SQL note) — tests in `authEmail.security.test.ts`.)*
- [x] `genDeviceTokenKey.mjs`: prints a P-256 private JWK for `wrangler secret put`. *(Done 2026-10-28: `kid` = thumbprint; `--previous <file>` prints `{"keys":[new, …old]}` for rotation; the key goes to stdout only.)*

**Done when:** the SQL applies cleanly twice; the auth, ice and guest tests pass; the email Worker test passes.

#### WS-5 Web account security
**Owns:**
- `live/account.ts`, `live/sync.ts`
- `live/views/SettingsView.tsx`, `SettingsView.test.tsx`
- `live/LiveApp.tsx`
- `live/views/account/SecurityPanel.tsx`, `StepUp.tsx`, `SecureAccount.tsx`, `*.test.tsx` (new)
- `public/live-sw.js`
- `live/monitor/push.ts`

**Tasks:**
- [x] `account.ts`: in `onAuthStateChange`, on `TOKEN_REFRESHED` or `SIGNED_IN`, dispatch `window.dispatchEvent(new CustomEvent('ds:token', {detail: accessToken}))`.
  - Add `signOutEverywhere()`: `POST /live-api/api/me/kick`, then `supabase.auth.signOut({scope:'global'})`, then `purgeLiveAccountData()`.
  - Rename `signOutEverywhereLocal` to `signOutThisDevice`.
  - Add MFA helpers (`enrollTotp`, `verifyTotp`, `unenroll`, `stepUp()` → `aal2`).
  *(Done 2026-10-29. `ds:token` also fires on `MFA_CHALLENGE_VERIFIED` — a step-up reaches sockets already open — and never twice for one token (`TOKEN_EVENT`, `announceToken`). **Kick contract as WS-5 reads it** (WS-7 `kick.ts`): `POST /live-api/api/me/kick`, Bearer, body `{}`; 2xx JSON `{ok: true}` only when every nursery room and the call line confirmed — anything else, a timeout (8 s) or a missing route counts as not kicked. The global sign-out happens whatever the kick says, and the message never claims more than happened (`signOutEverywhereMessage`: offline → "only this device"; not kicked → "a monitor already open elsewhere stays connected until it next reconnects"). New status `needs_mfa` (password given, code owed: from `live_me`'s `mfa_required` only — never the session's own AAL, which would shut a camera the server still lets watch; see the review fixes below), and `session_revoked` signs this device out with a one-time "signed out on every device" notice. MFA helpers are `enrollTotp` (clears half-done set-ups first), `verifyTotp`, `cancelTotpEnrollment`, `unenrollTotp` (needs aal2), `stepUp`, `mfaStatus`, `stepUpNeeded`; Supabase errors become words a parent can act on (`mfaFailure`). Also `listMyDevices`, `listSecurityEvents`, `revokeMyDevice` (WS-7's `DELETE /api/devices/:id`; the plain `live_device_revoke` only where the route is missing, 404/405/501 — see the review fixes) and `secureAccount` — every one says "not switched on yet" instead of failing until the SQL is applied. Tests: `live/accountSecurity.unit.test.ts`.)*
- [x] `sync.ts`: `signOut(scope)` takes `'local'|'global'`. *(Done 2026-10-29: returns `{ok}` — a global sign-out that couldn't reach Supabase still drops this device's session and says so. On Stream Studio's own host it also ends the old `dreamstreamstudio.ai/live` alert subscription and that account's data there (the flip blocker below).)*
- [x] `SettingsView.tsx` and `LiveApp.tsx`:
  - Two buttons: "Sign out of this device" and "Sign out everywhere".
  - A Security section that mounts `SecurityPanel` (TOTP enrol with QR and recovery guidance, "Your devices" from `live_device_list` with Revoke, recent security events).
  - A nudge to turn on MFA after creating a nursery.
  *(Done 2026-10-29: Settings → Account has both buttons, Settings → Security (`#/settings?s=security`, also in the account menu) mounts `SecurityPanel`; "Sign out everywhere" confirms first. Recovery: ten single-use recovery codes shown once when two-step sign-in is turned on, and the setup key saved in a password manager works too (review fixes below). The nudge (`MfaNudge.tsx`) shows to a parent without two-step sign-in on the monitor list and hub (where creating a nursery lands), never over a camera or watch screen; "Not now" snoozes 30 days. Tests: `SettingsView.test.tsx`, `SecurityPanel.test.tsx`, `MfaNudge.test.tsx`, `live/LiveApp.security.unit.test.tsx`.)*
- [x] `StepUp.tsx`: a modal used before admin actions. Exported for WS-6 to call. *(Done 2026-10-29: `if (!(await ensureStepUp('Adding someone to the nursery'))) return;` — resolves true at once when no code is needed (no authenticator, or aal2 already), false on cancel; one sheet serves every caller. `StepUpHost` (mounted once in `LiveApp`) also finishes a sign-in that still owes the code, and every "Sign in" button does the same while `needs_mfa`. Tests: `StepUp.test.tsx`.)*
- [x] `SecureAccount.tsx`: the `/live/secure#t=...` landing page that calls `live_secure_account`. *(Done 2026-10-29 at `#/secure/<token>` — the link WS-4's email sends (a hash route: `/live/secure` would fall to the main app's SPA fallback). The token is read once and taken out of the address bar and history; one tap posts it to `POST /api/auth/email/secure` (WS-4: calls `live_secure_account` with the service role and mails the reset link — calling the RPC from the browser would end the sessions but send no email). If this browser was signed in to that account (the auth server says its session is gone — no guessing from the email hint) it kicks its sockets and signs out too. **The flip:** `SECURE_ACCOUNT_PAGE = "on"` is now in `email-worker/wrangler.jsonc` `vars`, so it ships with the page from the same push (a dashboard var would be replaced by the next `wrangler deploy`); no email carries a token before the owner applies the SQL and enables the hook (owner action #4). Documented in `docs/features/accounts-and-access.md`. Tests: `SecureAccount.test.tsx`, `live/LiveApp.security.unit.test.tsx` (the email's link → this route, on either address).)*
- [x] `live-sw.js`: when the payload has `act`, add an "I'm on it" action that POSTs `/live-api/api/monitor/<nid>/act` with `Authorization: DS-Act <act>`, then shows "You're on it". Replace a notification when one arrives with the same `tag` (the acknowledgement replacement). *(Done 2026-10-29: body `{a:'ack', inc, id}` (`id` made once per alert when the push arrives and reused by every retry, so a retry after a lost answer is the same acknowledgement — review fix), `credentials: 'omit'`; only alert kinds with a well-formed `act` (`a1.<uid>.<exp>.<mac>`), `nid` and `inc` get the button. **If the acknowledgement fails, the alert comes straight back** with the reason — a tap must never make an alert disappear unhandled; only a connection failure offers "I'm on it" again (the token is single use). The replacement (`kind: 'ack'` or `replace: true`, tag of the original via `of`) is silent and never held on screen. Tests: `live/monitor/liveSw.onit.unit.test.ts`.)*
- [x] `push.ts`: include `devId` (read from IndexedDB `ds-keys`, written by WS-6) when registering subscriptions. *(Done 2026-10-29: `sub.dev`, read-only from `ds-keys` → store `device` → record `self` (WS-6's layout); the database is never created from here. Also `sub.was`, below. Rooms that don't know the fields ignore them. Tests: `live/monitor/pushLegacy.unit.test.ts`.)*
- [x] **Review fixes (2026-10-29, wave 1b review of WS-5).** A parent must never be locked out, or lose the nursery camera, because of a security feature:
  - *Any authenticator works.* `stepUp` tries the code on every verified authenticator (newest first, stopping on rate limits or a dead connection), so a second phone or a password manager is a real backup.
  - *Turning it on needs a fresh sign-in, and only counts when switched on here.* An authenticator counts for two-step sign-in only once `live_mfa_activate` switched it on; for the first one that needs a password (or email link) used in the last 30 minutes (`live__recent_sign_in`, from the token's `amr`), so a stolen session can't turn it on and shut the parent out. The UI explains first, lists the devices signed in right now, asks for the password again (`confirmPassword`; "Forgot password" for anyone without one), then shows **ten single-use recovery codes** that must be saved before it's done. One added any other way (a stolen session calling the auth API) is ignored and tidied away after an hour (`live__mfa_tidy`); one the server won't switch on is removed again, never left half-on. Switched on, another added, and switched off with a recovery code are security events with their own email and "Not you?" link (`email-worker/src/securityAlert.ts` `renderMfaAlert`).
  - *Lost phone.* "Lost your phone? → Use a recovery code" on the code sheet (`live_mfa_recover`: single use, 5 wrong codes per 15 minutes, emailed) switches two-step sign-in off so the parent gets in and sets it up again; no codes and no setup key → support, said plainly.
  - *The camera stays on air.* Sessions signed in before it was switched on keep **watching** on aal1 (`live_mfa_on.since`; `mfa_grace` from `live_me`/`monitor_my_role`, `ds_mfa_grace` in the access token; the Worker's `watchProblem`), until they sign out; anything that changes who can see a nursery still asks for the code on every session (`live__step_up_problem`). The client never decides `needs_mfa` by itself, and a request that fails while already in never takes a running monitor off its screen.
  - *"Not you?" undoes it.* `live_secure_account` removes authenticators added or switched on since the reported sign-in (or by its session) and recovery codes made since; the parent's own earlier authenticators stay. It also returns the account's nurseries to the backend, which asks the live Worker to close every socket and drop the push targets **with its own signed credential** (`POST /live-api/x/user/<uid>/kick`, HMAC over `<t>.<p>` with `SECURITY_HOOK_SECRET`, the `/x/user/<uid>/notify` signing) — the account's tokens all died a moment before. `kicked` is the Worker's confirmation only, and the page says what to do when it isn't.
  - *Device sign-out is honest.* Only a Worker without the route falls back to the plain RPC; any other failure changes nothing and says "try again". Success counts as confirmed only when every room heard (`told === rooms`); otherwise the list keeps **Finish signing out** for it.
  - *Fresh answers.* Two-step decisions (`stepUpNeeded`, `mfaStatus`) come from the server each time, not the session's cached factors; `refreshAccount` re-runs on `TOKEN_REFRESHED` and `MFA_CHALLENGE_VERIFIED`; a code sheet with nothing to verify against refreshes the session and leaves `needs_mfa`.
  - *Service worker.* Signing out (or another account taking the device) closes the alerts on screen and tells the service worker, so "I'm on it" on an alert that arrived before can't act for the person who left (`ds-signed-out`, kept in Cache Storage).
  Tests: `server/sql/tests/mfa_lifecycle.test.sql` (psql harness), `live/accountSecurity.unit.test.ts`, `views/account/*.test.tsx`, `live/monitor/liveSw.onit.unit.test.ts`, `live-worker/src/auth/accessToken.test.ts`, `server/src/routes/authEmail.security.test.ts`, `email-worker/src/index.test.ts`. **For other workstreams:** WS-7 serves the signed `POST /x/user/:uid/kick` (2xx `{ok:true}` only when every named nursery room and the call line confirmed; single use within ±5 min) and makes a repeat `DELETE /api/devices/:id` for an already-revoked device tell the rooms again (`{ok, rooms, told}`, not `not_found`); WS-9's `/act` answers a repeated `id` as the same acknowledgement even after the act token is spent, and refuses act tokens minted before the account's last kick.
- [x] **Stream Studio host flip blocker** (`docs/infrastructure/INFRA_MAP.md` §2a; assigned with WS-5): a device that turned alerts on at `dreamstreamstudio.ai/live` and again at `stream.dreamstreamstudio.ai` must get each alert once, and signing out on the new host must end both. *(Done 2026-10-29. An apex page outside `/live`, `public/stream-alerts-bridge.html` + `.js`, loaded in a hidden frame by the new host only (origin and source checked, never another account's data — `ds-live-owner` must match). It reports the old subscription and the nurseries it alerts for; the new host sends that endpoint with its own subscription as `sub.was`, and MonitorRoom (alerts, nursery call rings) and UserLine (direct-call rings) drop it **for the same account only** (`live-worker/src/pushReplace.ts`). The old subscription is unsubscribed only once the new host covers every nursery and ringing it served — no nursery goes quiet mid-move — and on any sign-out there; an unsubscribed endpoint answers 410 and every room prunes it. Start-up checks skip the frame for a week once the old address is empty. Headers: the bridge gets its own enforced CSP (`frame-ancestors https://stream.dreamstreamstudio.ai`, one same-origin script), Stream Studio's CSP may frame exactly that URL, and its script is off Pages Functions (`_routes.json`) — so it keeps working when either policy is enforced. Tests: `live/monitor/streamAlertsBridge.unit.test.ts`, `pushLegacy*.unit.test.ts`, `live-worker/src/pushReplace.test.ts`, `tests/edge/alertsBridge.test.ts`. **Outside the matrix, on purpose and small:** `functions/_middleware.ts` (WS-1, merged), `public/_routes.json`, the `storeReplacing` call sites in `monitorRoom.ts` / `userLine.ts` (Wave 2's WS-9 / WS-10 rebase over three lines), `email-worker/wrangler.jsonc`.)*

**Done when:** component tests cover both sign-out paths, the MFA enrol/verify flows (mocked) and the service-worker action handler (a unit test of the fetch built from a sample payload). *(Met 2026-10-29 — the test files named above.)*

#### WS-6 Monitor clients: cost and E2E
**Owns:**
- `live/views/MonitorCamera.tsx`, `live/views/MonitorViewer.tsx`
- `live/monitor/rtc.ts`, `rtc.unit.test.ts`
- `live/monitor/client.ts`, `socket.unit.test.ts`
- `live/monitor/protocol.ts`
- `live/monitor/keys.ts` (new), `live/monitor/relayCrypto.ts` (new), `live/monitor/e2e.unit.test.ts` (new)
- `live/views/monitor/PeopleCard.tsx`, `live/views/monitor/NurserySettings.tsx`

**Tasks:** *(All done 2026-10-29 on `impl/p0-ws6`. Everything is capability-gated: against today's rooms, which list none of `reauth`/`eid`/`e2e1`, the clients behave exactly as before.)*
- [x] `protocol.ts`: re-export the `wire.ts` types; parse `hello.caps`. *(`helloCaps()`; `hello` gains `exp`, `nonce`, `e`; presence gains `devId`; the key, `reauth_ok` and `share_rotated` messages; `MonLog.eid`.)*
- [x] `client.ts`: *(Tests in `socket.unit.test.ts`.)*
  - [x] Every socket (monitor, line, admin) listens for `ds:token` and sends `reauth` when `caps` includes it. *(Members only — guests and call rooms hold no token. It also re-auths on its own 45 s before `hello.exp`/`reauth_ok.exp`, so a tab whose token refresh is late never hits the 4001.)*
  - [x] Handle close codes 4001, 4003 (open StepUp), 4004 ("You were removed") and 4008 (back off), through `closeKind`: 4004 `forbidden` is a role refusal, not a removal. *(4004 `revoked` is "this device was signed out"; only `removed`/`revoked` forget a guest pass. 4008 waits ≥ 20 s. `mfa_required` is never final — a camera that stopped there would go quiet: it asks once, then retries every 30 s and at once on a fresh token, and both screens show "Enter code".)*
  - [x] Membership helpers (`removeMember` and the add/role helpers) call `POST /api/monitor/:nid/members` when `caps` includes `reauth`, otherwise the old RPC plus `members_changed`. *(Asks for the step-up and retries once on `mfa_required`. Each nursery's caps are remembered on the device, so the nursery list knows them before a socket opens.)*
  - [x] Remove the `members_changed` admin-socket dance once the server lists the capability. *(Skipped after a change that went through the Worker; still used after an RPC change.)*
- [x] `keys.ts`: device keys (non-extractable ECDSA and ECDH P-256) in IndexedDB `ds-keys`; NMK store per `(nid, e)`; handle `key_req` (wrap with `sealed.wrapNmk`), `key_wrap`, `key_init`, `key_rotate`; send `dev_hello` after `hello`. *(Stores `device` (record `self`, which WS-5's push.ts reads) and `nmk` (only this device's own wraps). The opened keys stay in memory. Page-only keys when IndexedDB fails. `key_init` and `key_rotate` count as accepted when the room hands back our wrap, refuses with `key_conflict`, or says nothing for 3 s. An older epoch opens for 60 s after a newer one. A device never seals with an epoch older than the room's. A camera that gets no wrap within 10 s starts the next epoch itself.)*
- [x] `relayCrypto.ts`: thin wrappers over `sealed.sealFrame`/`openFrame` with sequence state. *(`RelaySealer` keeps relay.ts's synchronous send contract and back-pressure. `RelayOpener` checks replay and age with `FrameReplay`. A Web Lock keeps one camera per nursery per browser, so two tabs never share a sequence under one key. See the contract notes below.)*
- [x] `MonitorCamera.tsx`:
  - [x] The 2 s `startTicker(2000…)` status sender becomes **change-detected plus a keepalive**, and keeps sending every 2 s only while `live_want` is on. Data-channel `st` stays at 2 s. *(Done 2026-10-23, `live/monitor/statusCadence.ts`: urgent news at once, other news within 10 s, keepalive every 2 min so idle is ≤ 30 an hour as the done-when below asks.)*
  - Batch `stats` every 5 min (`stats5`). *(Replaced 2026-10-23 by server-side batching: the room writes the minutes the phone sends every minute in batches, so `stats5` isn't needed — feature doc §7, C3–C5 status.)*
  - [x] Mint `eid` in `sendSound`/`sendVision`. *(Every camera event gets one, and the data-channel copy has the same one. The sequence persists across reloads. A sound replayed after the room was away reuses the id the viewers already got directly.)*
  - [x] Encrypt relay frames when `e2e1` is listed, with JPEG ≤ `SNAPSHOT_MAX − 64`. *(A camera that seals but has no current key waits for it before sending a picture through the server — for 15 s at most, then it sends plain and says so (review fixes below). Sound alerts are unaffected. A part too big for the room once sealed (+38 bytes) is dropped like an oversize frame. The camera says when the server path is sealed, both on setup and while running.)*
  - [x] Refuse unsealed `rtc` once it holds an NMK.
- [x] `MonitorViewer.tsx`:
  - [x] On `visibilitychange`, send `view`. When hidden, the picture goes (`replaceTrack(null)`) and the relay is sound only; restored when visible. *(Done 2026-10-23: `view` at once, the camera and room apply a 20 s grace; the camera hears it on the data channel, `{t:'vis'}`, not as a quality command, so the viewer's own quality choice stands.)*
  - [x] Dedupe alerts in `onDirect` against room events by `eid` and alert on first arrival. *(`FirstArrival` in rtc.ts: whichever copy is first alerts, the other folds in quietly, and events without an eid always count. With the room up and no `eid` cap, the room's line alerts as before.)*
  - [x] Decrypt relay frames. *(A camera that seals is taken sealed — plain only once nothing sealed from it has opened for 6 s, said on screen (review fixes below). Which cameras seal is remembered per nursery, so a room that stops saying so can't quietly downgrade it. The relay pill shows a lock and "end-to-end encrypted" only while sealed frames actually open. A device still waiting for the key says so, and its direct call waits up to 6 s for the key, then is set up without it (`nk`), and is sealed from the next call once the key is here. Signaling waits at most 3 s for keys to load from storage, so a storage that hangs can't stop direct video.)*
- [x] `rtc.ts`:
  - [x] `RELAY_CAP` → `{maxBitrate: 400_000, maxFramerate: 15, scaleResolutionDownBy: 2}`. *(Done 2026-10-23; the server relay's encoder also tops out at 400 kbps.)*
  - [x] Batch ICE candidates in 75 ms windows. *(`IceBatch`: one `ices` message per window to a peer that said `ib`, one message per candidate to older peers.)*
  - [x] Seal and open signaling when both sides list `e2e1`. *(Sticky: a camera that holds the key refuses every unsealed offer. A viewer refuses plain signaling from a camera that seals. Opens run in parallel but are handled in arrival order, so a candidate never overtakes its offer.)*
  - [x] Send ICE restarts and quality commands over the open `mon` data channel when it is available. *(Quality: done 2026-10-23 for cameras that say `dcc`. ICE restarts 2026-10-29: `{t:'sig', d}` on the channel to peers that said `dcr`. If no answer comes within 4 s, the same offer goes through the room. A data-channel offer for a different call is ignored.)*
  - [x] Apply `ice_refresh` with `pc.setConfiguration`. *(Done by the TURN guardrails, 2026-10-22: `{t:'ice'}` + `applyIce`.)*
- [x] `PeopleCard.tsx`: after a guest is removed, show "Link and passcode changed" with a one-tap "Share the new link". Admin actions call WS-5's `StepUp` first. *(On `share_rotated`. The new passcode is shown once and never stored or shared with the link. Invite and "End other sessions" step up first.)*
- [x] `NurserySettings.tsx`: a Devices list per nursery (`mon_devices`, Revoke) and a Security log tab (events of kind `security`). *(Parents, rooms that list `e2e1` (devices) or `reauth` (log). Revoke needs a confirm and the step-up. Export steps up first and retries once on `mfa_required`. Tests in `NurserySettings.test.tsx` and `PeopleCard.test.tsx`.)*

**Contract notes (WS-6 → WS-9; additive, nothing frozen changes):**
- **Relay frame v1 on the existing relay wire.** The 11-byte relayWire header stays in clear, so the room can still route, resync and cut sound for a hidden viewer.
  - Each part is sealed on its own (`sealFrame`): picture on stream 0, sound on stream 1, one counter across both.
  - The header's flags bit 1 marks a sealed message. `audioOnly` still works, because it only slices by the u16 length.
  - A sealed part starts `0x01`, never `FF D8`. The test runs the room's own cut on sealed bytes.
- **Step-up.** WS-5's sheet is found with `import.meta.glob('../views/account/StepUp.tsx')` and called through its `ensureStepUp(reason)`. Before WS-5 merges the match is empty and actions go ahead, because the server enforces `aal2` anyway. `registerStepUp()` overrides it (tests).
- **Signaling flags.** In an offer or answer, `ib: 1` means "send me `ices` batches" and `dcr: 1` means "ICE restarts on the data channel". Those restarts arrive as `{t:'sig', d}` on `mon`. Sealed `rtc.d` carries the sender in `f` (wire.ts).
- **Parents' devices.**
  - `{t:'q', q:'devices'}` → `{devices: [{devId, name, platform, who, added, last_seen, keyed?}]}`.
  - `{t:'q', q:'dev_revoke', devId}` → `{ok}` or `{ok:false, error:'mfa_required'|…}`. The room drops the device and its wraps, closes its sockets (4004 `revoked`), asks a holder to `key_rotate`, and logs a `security` event.
  - The log itself is the existing `{q:'events', kinds:['security']}`.
- **`share_rotated`** goes to parents' sockets after a guest removal that rotated the link: `{t:'share_rotated', link:{code, pass?}, removed?}`. It is shown once, so WS-9 can pass `{rotate: true, pass: preparePasscode('auto')}` to `removeGuest`.
- **Mixed versions (for WS-9).**
  - A room should forward sealed relay messages (flags bit 1) only to sockets whose `dev_hello` verified. A page from before Phase 0 can't open them and would try to decode noise.
  - The room should tell such a page to reload: a camera holding the key refuses its plain offer, as the sticky rule requires.
  - It should keep accepting `members_changed` from parents, for changes a client made through the RPC before it learnt the room's caps.

**Review fixes (2026-10-29, `impl/p0-ws6`; safety first: a parent never loses the picture or sound because of a security feature):**
- **Revoke and removal end live calls.** A direct call on the home Wi-Fi needs nothing from the room, so signing a device out alone never ended it. The camera now ends a viewer's call at once, connected or not, when the room says why its socket left, and ends calls sealed by any device a rotation leaves out (`key_rotate` + `devs`). A removed or revoked viewer closes its own call too. The Revoke notice says "disconnected" only when the room confirms it told the camera (`ended`); otherwise it says how to end a live view.
- **No device is left without a key.** A device without a current key asks again (`dev_hello` on the same socket, backoff 2 s → 60 s with jitter) and re-reads its stored wraps (another tab may have the key), after a lost race (`key_conflict`) as after anything else. The camera starts the next epoch itself 10 s after it began waiting, also after a conflict or with `e: 0`.
- **The sticky rule, with a safety fallback.** Phase 0 defends against a server that reads, not one that lies (the threat model above). A device still without a current key after 15 s is `fallback`. The camera's server picture then goes plain, and the camera says it isn't end-to-end encrypted right now. A viewer calls with `nk: 1` ("no key"), and the camera takes that plain offer. The camera also takes plain offers from a viewer that never showed device keys (an app from before Phase 0). The camera counts and shows such calls. They stay DTLS-encrypted phone to phone. A plain offer never replaces a sealed call that's up. A camera that can't open a sealed offer, or can't seal its answer, replies `nok: 1` in plain, and the viewer calls again at once with `nk`. A viewer takes a sealing camera's plain picture only after 6 s with no sealed frame opening, and says so. A plain frame mixed into a working sealed picture is still dropped.
- **Sealed signaling and wrong clocks.** Signals aren't refused for a phone whose clock is hours or days off. The window is a year: anything that reaches the room over TLS is within its certificate's lifetime. Replays are refused by their nonce, forgotten oldest first, never all at once. An old epoch stops opening 60 s after a rotation. DTLS fingerprints bind a call to the devices that made it.
- **Relay nonces across reloads.** The camera's part counter reserves blocks of about a minute ahead in `localStorage` (`ds-relay-seq-<nid>`), written before use. A reload, even after the phone's clock steps back, never reuses a number under the same key. The camera lock is held while the camera runs, not at setup. A tab that finds another tab holding it queues and takes over when that tab goes. It says "another tab is the camera" meanwhile. With the counter written down, sealing no longer depends on the lock.
- **Alerts dedupe true duplicates only.** An event's id counts as seen only when the data-channel copy actually alerted, so the room's line for a non-sharp object (a cup, the remote, a pet) still sounds. A direct copy is folded in quietly only when it repeats an alert still sounding: same category, camera and zone, not acknowledged, under 30 s old. Another zone, another camera, or the same kind after "I'm on it" always sounds.
- **ICE restarts on the data channel are idempotent.** A viewer ignores an answer when no offer of its own is waiting, so a second answer to the same restart doesn't mark a working call failed. A camera answers a repeated identical offer again as before, through the path that copy came by, rather than negotiating twice.

**More for WS-9 (additive):**
- `peer_gone` to cameras gains `why: 'revoked' | 'removed'` (and `devId` when known) when a socket closes because its device was revoked or its person or guest pass removed. `dev_revoke` answers `{ok: true, ended: true}` once it has told the cameras.
- A `dev_hello` repeated on the same socket (same nonce, new `ts` and signature) is a device asking again for its wrap. Answer each one like the first: its stored wrap, or a `key_req` to an online holder. After accepting `key_init` or `key_rotate`, ask the new holder to wrap the epoch to every verified online device without a wrap.
- `rtc.d` may carry `nk: 1` (viewer → camera, with a plain offer) and `nok: 1` (camera → viewer, plain). Forward them unchanged, as now.

#### WS-7 Edge router and config
**Owns:**
- `live-worker/src/index.ts`, `index.test.ts`
- `live-worker/wrangler.jsonc`
- `live-worker/src/devices.ts`, `kick.ts`, `members.ts`, `origin.ts`, `ops.ts`, `*.test.ts` (all new)

**Tasks:**
- [x] `index.ts`:
  - Extend the monitor regex to `(ws|export|guest|glance|act|peek|members)`, forwarding all of them to the DO except `members` (→ `members.ts`).
  - Add `/api/me/kick` (→ `kick.ts`), `/api/devices/*` (→ `devices.ts`) and `/api/ops/apns-probe` (→ `ops.ts`, which calls WS-3's `probe.ts`).
  - Add `/x/user/:uid/notify`, forwarded to UserLine (for the new-device push mirror).
  - Check `RL_WS` before every upgrade and `RL_GUEST` on guest routes.
  - Enforce the `origin.ts` allowlist on upgrades (allowed origins, or no Origin).
  *(Done 2026-10-29. `glance`, `act` and `peek` go to the room with only `authorization`, `ds-proof`, `if-none-match` and `content-type` — never cookies — plus `x-ds-path`, the path a DS-Proof signs (as routed, without `/live-api`), which the Worker always sets itself; `act` forwards the exact bytes the client sent, since the proof signs them. Checked at the edge so junk never costs a DO request: the body (`parseActRequest`, ≤ 2 KB), that some credential is present, and a DS-Act token's MAC, nursery, incident and action (it only ever acknowledges, and only its own incident) — verified without spending it; the room spends it. Idempotency by `id` and the role gate stay in the room (WS-9), tested here against a fake room: the same `id` twice acts once and the second answer is the first, marked `dup`; a viewer's act is refused. A room that doesn't serve a route yet answers its catch-all 404, which the Worker turns into 501 `not_enabled`, so a watch never takes "not available yet" for "this nursery is gone". The glance keeps the room's ETag (304 passes through, `private, no-cache`); every other answer is `no-store`. Wrong methods are 405. `/api/ops/*` and `/x/user/:uid/notify` get no CORS; every other `/x/*` path is 404 from outside. Rate limits: `RL_WS` on every monitor and call socket, refused by accepting and closing at once with 4008 `rate_limited` and an error frame (a plain 429 reaches a browser only as close code 1006); `RL_GUEST` per address and `RL_GUEST_NID` per nursery on share-link joins, refused with 429 and the app's own `slow_down` reason, so the existing "Too many tries — wait until …" copy shows; plus `RL_EVENT`, per account, on Stream Studio event creation (each event is a new DO; the security study's §4.8). Stream Studio broadcast sockets get the origin check but no per-address limit: venue Wi-Fi or a carrier NAT puts a whole audience behind one address, and the EventRoom caps its own viewers. Origin rule: our sites, no Origin (native code), the API's own origin — React Native's WebSocket on iOS and Android sends the socket URL's origin, so without it the native apps would be refused — and localhost only while the Worker itself runs on localhost (`wrangler dev`); everything else, `null` included, is a 403 before any room is asked, with a bounded log line per refused origin so a forgotten site shows up in `wrangler tail`. CORS adds `DELETE` (device revoke) and `If-None-Match`, and exposes `ETag`; never `x-ops-key` or `DS-Proof`.)*
- [x] `devices.ts`:
  - `enroll` verifies the Supabase JWT (`verifyAccessToken`), calls `live_device_enroll`, and issues a grant.
  - `token` verifies the grant and `DS-Proof`, then issues a 10-minute access token.
  - `push` stores the push target through the DO (`/x/push-reg`).
  - `DELETE` revokes in Supabase and fans out `/x/device-revoked` to the user's nurseries.
  *(Done 2026-10-29; dormant until the owner sets `DEVICE_TOKEN_JWK` and applies `live_security_v2.sql` — until then enrol and token answer 501 `not_enabled`, as does any RPC PostgREST doesn't know yet. Enrol needs `aal2` from anyone with a factor (device approval is an admin action); each nursery is checked with the caller's own token (`monitor_my_role`) and the grant holds only what was asked (`can`) and what the person may (`scopesForRole`: never above caregiver); the per-nursery cut to the person's current role happens at use (`effectiveScopes`). A new device is announced on the person's other devices through their call line's `/x/notify` (WS-10). Token exchange asks `live_device_active` every time with the publishable key alone (a legacy anon JWT would also ride as the bearer; an `sb_publishable_` key never does), and mints nothing when Supabase can't be asked. Push takes a device access token with a DS-Proof or a Supabase token (that person's nurseries, optionally narrowed by `nids`), validates with WS-3's `parsePushSub`, and answers 501 `not_enabled` while no room takes `/x/push-reg`. DELETE needs `aal2` too, then tells every nursery `/x/device-revoked {uid, dev, thumb}` — the thumbprint lets a room match sockets by key; a room that didn't hear is told again in the background. **Review fix (2026-10-29):** push registration with a device token asks `live_device_active` too (fail closed), like the exchange — a revoked watch's access token is unexpired for up to 10 minutes, and a push target stored with it would outlive it. `/api/devices/code` and `/approve` (the RFC 8628 fallback) answer 501 until Phase 3. The DS-Proof nonce memory here is per isolate: replaying a captured token exchange elsewhere only returns a token bound to the same hardware key, useless without a fresh proof; the rooms keep theirs in SQLite.)*
- [x] `kick.ts`: verify the caller; `monitor_list`; for each nursery, the DO `/x/kick {uid}`; UserLine `/x/kick`; revoke TURN usernames returned by the DOs.
  *(Done 2026-10-29. Every room and the line are told at once, each given 4 s, so the answer lands inside the 5 s budget even when a room hangs (tested with fake timers); TURN usernames the rooms hand back are revoked at Cloudflare after answering (`waitUntil`). The answer is honest: `ok` only when every room and the line confirmed, which is what WS-5's "open monitors and calls were disconnected" relies on — a room or line without `/x/kick` yet (before WS-9/WS-10) is `unconfirmed`. A token whose session was already ended is accepted (kicking yourself only takes access away) — that's WS-5's "Not you?" page, which calls this after the backend ended every session; such a token can't list nurseries once the SQL is applied, so then only the call line is reached and the answer says `session_revoked`. An `aal1` token from someone with a factor is refused, so a phished password alone can't switch a family's monitors off. Braked per account with `RL_WS` (each kick wakes every room). **Review fixes (2026-10-29):** "Not you?" now reaches every nursery: the backend (WS-5 `server/src/services/liveKick.ts`) posts the signed `POST /x/user/:uid/kick` naming the nurseries from the membership table, and the Worker runs the same fan-out (`kickEverywhere`) — the account's own tokens can't list them any more. The fan-out also reaches the account's direct calls: the call line's `/x/kick` answer names them (`calls`) and each CallRoom hears `/x/kick` with what's left of a 4.5 s budget (`KICK_BUDGET_MS`), counted in `ok`. A room reset by a deploy is asked again at once inside the budget; requests still in flight at the deadline are kept alive so a slow room still hears it; nurseries past the 50-room cap are reported unconfirmed, never dropped silently. Every `/x/kick` carries `at`.)*
- [x] `members.ts`: require `aal2`; call the membership RPC with the caller's token; then the DO `/x/members {ids}`.
  *(Done 2026-10-29. The body is checked with `parseMembersRequest` before anything is asked; `aal2` is checked before Supabase is; Supabase still decides who may (parents; anyone may leave or relabel themselves). Before the SQL is applied the old RPCs answer just `{ok: true}`, so the person in the request is the one who changed; a role change without a `label` keeps the person's label (the RPC alone would clear it). The answer is `{ok, changed, removed, told}`. **Review fixes (2026-10-29):** a change that takes access away (a removal, a lower role) is `ok` only once the room confirmed it; otherwise 202 `{ok: false, error: 'unconfirmed', committed: true, told: false}` — the membership change is saved, and the Worker tells the room again in the background (2 s, 6 s; before re-sending a removal it asks Supabase who's in the nursery now, so someone added back since is never cut off). Asking again is safe: a removal of someone already gone still tells the room. An addition stays `ok` with `told` saying whether the room heard (the room asks Supabase on the person's first socket anyway). Tested end to end with a fake room and a fake push endpoint: after a removal the person's monitor and line sockets are closed and a later alert reaches only the people still in the nursery; refusals reach no room.)*
- [x] `wrangler.jsonc`:
  - `ratelimits` bindings: `RL_WS` (60/60 s), `RL_GUEST` (10/60 s), `RL_GUEST_NID` (30/60 s).
  - Comments listing the new secrets (no values).
  - An R2 lifecycle comment pointing to the WS-8 runbook.
  *(Done 2026-10-29, plus `RL_EVENT` (10/60 s). Namespace ids 60601–60604 (any integers unique in the account). Limits are keyed `edge:` + the client's IPv4 address or IPv6 /64 (one subscriber's prefix: keying one v6 address would let anyone rotate through 2^64), the nursery or the account, so a room given the same binding counts separately instead of halving the allowance. Every limit fails open — no binding, no `cf-connecting-ip`, a limiter error — because the rooms' caps and lockouts stand behind them and a monitor must never stop connecting because a limiter hiccuped. Secrets listed: `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`, `TURN_TAG_SALT`, `DEVICE_TOKEN_JWK`, `ACT_TOKEN_KEY`, `SECURITY_HOOK_SECRET`, `OPS_KEY`, `APNS_*`, `FCM_SA_JSON`, and the push switches. A test parses the file and fails if the bindings drift from these limits or a var or anything key-shaped appears; `wrangler deploy --dry-run` lists the four bindings.)*

**Done when:** `index.test.ts` covers routing, the rate-limit refusal (4008/429), Origin refusal, and the kick and members fan-out against stub DOs. *(Met 2026-10-29: `index.test.ts` (routing, 4008 and 429 refusals, Origin refusal on every socket route, kick and members through the router against stub rooms, the `/x/` boundary, and "50 unauthenticated sockets from one address don't stop a member": a 70-socket flood from one IPv6 /64 is cut at 60 while the family's phone still reaches the room), plus `kick.test.ts`, `members.test.ts`, `devices.test.ts`, `ops.test.ts` and `origin.test.ts`. The rooms' side of `/x/kick`, `/x/members`, `/x/push-reg`, `/x/device-revoked`, `/x/notify`, `/glance`, `/act` and `/peek` is WS-9's and WS-10's; until they deploy, kick answers `unconfirmed` and the watch routes 501.)*

*Contract notes (2026-10-29, WS-7), for WS-9, WS-10 and the native apps:*
- *`POST /api/me/kick` → `{ok, rooms, calls, closed, unconfirmed, error?}`; optional body `{why: 'secure'}` (default `signout`). Worker → room, line and call `/x/kick` `{uid, why, at}`; they answer `{closed, turn}` (wire.ts `XKickResult`), `turn` being TURN usernames to revoke. The line also answers `calls`: the CallRoom ids (16 hex) its person is in, being rung into or just placed; the Worker sends each of those CallRooms the same `/x/kick`. `at` (ms) is when the kick was asked for: close the person's sockets admitted before it, drop their push targets, and refuse their tokens issued before it (`iat < at`, account and device access tokens alike) until those expire — never a sign-in after it, so a late or repeated message can't cut off a parent who signed straight back in (a watch that's still enrolled just exchanges its grant for a fresh token; one revoked by "Not you?" can't).*
- *`POST /x/user/:uid/kick` (the backend's "Not you?", WS-5 `liveKick.ts`): signed like `/x/user/:uid/notify`, payload `{v: 1, kind: 'kick', uid, why: 'secured', nids, at}`; the same fan-out to the named nurseries, the line and its calls; → `{ok, rooms, calls, closed, unconfirmed}`.*
- *Worker → room `/x/members` `{ids, removed, by, op, role, at, previous?, added?, left?}`: `ids` everyone whose access changed (re-check them), `removed` those to close and prune, `by` the actor's **user id** (the room has names; a name from the Worker would be one more thing to trust), `at` when the change was made — apply a person's changes in `at` order, so a background retry never undoes a newer one. The room answers `{closed, turn}` like a kick. `POST /api/monitor/:nid/members` → `{ok, changed, removed, told}`, or 202 `{ok: false, error: 'unconfirmed', committed: true, …}` for a change that takes access away which the room hasn't confirmed.*
- *Worker → room `/x/push-reg` `{uid, dev, via: 'device'|'account', sub, scp?}` (`sub` as `parsePushSub` makes it; the room checks the person is still a member before storing, and refuses a `dev` it has heard `/x/device-revoked` for — the Worker already refuses a revoked device's token, this is the room's own belt). `/x/device-revoked` `{uid, dev, thumb}`. Worker → line `/x/notify` `{uid, kind: 'sign_in'|'device_added'|'device_revoked'|'secured', at, device?, name?, platform?}`.*
- *`/glance`, `/act`, `/peek` reach the room as `https://monitor.internal/<route>?nid=<nid>` with `x-ds-path` set by the Worker; the room verifies DS-Proof against it (`verifyDsProof(req, jkt, nonces, {path})`).*
- *`POST /api/devices/token`: the device's signature is the `DS-Proof` header (WS-4's format, which signs the body and so the grant), not `ts`/`sig` fields in the body; the answer is `{ok, access, exp (ms), nid, scp}`. Enrol answers `{ok, grant, devId, exp, nid, scp, created}` where `devId` is the registry id (`live_devices.id`, what `DELETE /api/devices/:id` takes) — not the D6.3 key hash, which the device computes itself.*
- *`POST /x/user/:uid/notify` is signed exactly like the Supabase hook's call to the email Worker (`x-ds-signature: t=…,v1=…` over `{"p": "<payload>"}`, `SECURITY_HOOK_SECRET`), ±5 min, each signature once per isolate, and the payload's `uid` must be the path's.*
- *The ops key is the Worker secret `OPS_KEY` (as for WS-3's throwaway probe Worker).*

#### WS-8 Observability and docs
**Owns:**
- `server/src/services/costCentre.ts` (+ its test)
- `docs/infrastructure/live-security-runbook.md` (new)
- `docs/features/baby-monitor.md`
- `docs/features/glance-contract.md` (new)
- `docs/decisions/README.md`
- `docs/decisions/0006-native-apps-watch-local-first-security.md`

**Tasks:**
- [x] `costCentre.ts`:
  - Query `durableObjectsInvocationsAdaptiveGroups`, `durableObjectsPeriodicGroups` (rows, GB-s) and `durableObjectsStorageGroups`.
  - Compute per-active-nursery-day KPIs (requests, rows, GB-s) with alert thresholds (1,000 / 1,800 / 40).
  - Add TURN GB and the relay-share field.
  *(Done 2026-10-29. Extended, not duplicated: the Stream Studio cost work (ADR 0007 Phase A) had already put the first two datasets, the per-active-nursery-day KPIs (over the rooms' daily activity marks) and the hibernation / write-diet alerts in `server/src/services/streamCosts.ts`, which `costCentre.ts` calls — so they grew there. Added: `durableObjectsStorageGroups` as its own sixth dataset (`storage`: a level, its own headroom row and `free_tier:doStoredGb` alert, MB per nursery as an upper bound); the **7-day median** per active nursery-day over the last complete days with marks — what this ADR's acceptance reads — with `budgets` and `status` (ok / over / unknown) beside the month-to-date averages; a `request_diet` alert (after Phase 0; > 2,600 measured invocations ≈ 1,000 billed requests — the analytics count each incoming WebSocket message once, the bill 20:1) and `write_diet` on the median; the Durable Object datasets reach back 7 days before the 1st (`kpiWindowStartMs`) while monthly totals still start on the 1st, so neither the medians nor the hibernation check go blind early in a month; `turnGbMonthToDate`, `relayShare` (TURN + our server, of monitor viewer-minutes, once viewers report paths), and Glance bumps and pushes per nursery-night. Admin → Costs → Stream Studio → *Baby monitor health* shows them; the daily `stream-cost-watch` reads the sixth dataset too.)*
  *Security observability (the same Cost centre, new **Security** tab; `server/src/services/securitySignals.ts`): CSP report counts from the Pages function's `CSP_REPORTS` Analytics Engine dataset (`csp_live_violations` warns while Stream Studio isn't clean for 48 h — counting only the policy `ENFORCE_LIVE` will enforce, not the Trusted Types policy that stays report-only for good, whose reports are a separate inventory; `csp_live_blocked` is critical when an enforced policy blocks our own code there), sign-in alert counts from `security_events` (HEAD counts only; "not measured" until `live_security_v2.sql` is applied; `not_you_used` flags every "Not you?"), and the live Worker's refusal / disconnect counts. Everything is a count: no account, nursery, device, IP, token, email or URL is read for it.)*
  *Contract note — room and edge signals (`shared/stream/signals.ts`, writer `live-worker/src/signals.ts`): `signal(env, name, surface?)` counts one of a fixed list — `kick`, `kick_closed`, `removed_closed`, `device_revoked_closed`, `mfa_refused`, `session_expired`, `session_revoked`, `reauth_ok`, `rate_limited`, `origin_refused`, `preauth_evicted`, `guest_lockout`, `camera_spoof_refused`, `glance_bump`, `push_sent`, `push_gone`, `push_failed` — with a surface word from a fixed list (`monitor`, `camera`, `line`, `call`, `glance`, `admin`, `guest`, `edge`, `account`, `device`, or a push kind). It writes into the existing `stream_usage` dataset (`STREAM_USAGE`, index `sig`; no new binding), coalesced to ≤ 1 point per minute per isolate per signal, never throws, never awaits; `flushSignals(env)` writes what is left (call it from the rooms' hourly usage flush). Producers to wire: WS-7 (`rate_limited`, `origin_refused`, `kick`, `mfa_refused`, `session_revoked` at the edge), WS-9 (`kick_closed`, `removed_closed`, `device_revoked_closed`, `session_expired`, `reauth_ok`, `mfa_refused`, `preauth_evicted`, `guest_lockout`, `camera_spoof_refused`, `glance_bump`, `push_*` with the transport as surface), WS-10 (the line and call-room equivalents). Until they do, the Security tab and the bumps/pushes KPIs say "not counted yet", never zero.)*
- [x] Runbook:
  - Secrets list and rotation.
  - `wrangler r2 bucket lifecycle add`: `events/` expires after 9 days; incomplete multipart uploads aborted after 1 day.
  - Rate-limit settings.
  - The Supabase settings checklist (owner actions #3 and #4).
  - How to run the APNs probe.
  - Incident playbook for "suspected account takeover".
  *(Done 2026-10-29: `docs/infrastructure/live-security-runbook.md` — every secret with where it lives, how to make it and the order to rotate it without an outage (`ACT_TOKEN_KEY` has one key, so never during an open incident; VAPID never); the three R2 lifecycle rules (`events/` 9 days, its unfinished multipart uploads 1 day, and the existing `quota/rec/` 8 days) with why each must outlast what we promise; edge and in-room limits; the Supabase checklist; the APNs probe (the manual workflow now, `POST /api/ops/apns-probe` after WS-7); what each Admin → Costs security / Phase 0 alert means and what to do; CSP flip and undo; the account-takeover playbook and a platform-compromise one. Every owner step, with exact clicks and commands in order, is in `docs/infrastructure/phase0-owner-checklist.md`, including a privacy-policy paragraph matching D6.4 for owner action #18.)*
- [x] Docs: the Glance contract (copied from D2), the security and connection sections of the baby-monitor feature doc, and the ADR index row.
  *(Done 2026-10-29: `docs/features/glance-contract.md` (D2 plus what WS-2 settled: `can` per role and guest, the 512 B budget and how it is kept, decoder rules, the ETag, the bump rules and the night fixture's 57 bumps, every transport and its status, privacy, how to change it); `baby-monitor.md` gains *Connection* and *Security and privacy* (true today / what our servers see / each Phase 0 change and when it goes live) and no longer contradicts the code (no Hugging Face fallback, TURN is on, liveness is the watchdog, a silent camera alerts within two minutes — the in-app guide said "a minute" and now says the same). The ADR index gains the missing 0004 row and 0003's real status. `docs/infrastructure/` (README, ENV_MATRIX, INFRA_MAP, COST_RUNBOOK, SECURITY_FINDINGS with F1–F18 and their status) and `docs/email/SECURITY.md` are brought up to date.)*

### 3. Wave 2 (parallel, after Wave 1 merges)

#### WS-9 MonitorRoom integration
**Owns:**
- `live-worker/src/monitorRoom.ts`, `monitorStore.ts`
- `monitorRoom.test.ts`, `monitorRoom.calls.test.ts`
- `live-worker/src/room/glanceState.ts`, `room/actor.ts`, `room/roster.ts`, `room/*.test.ts` (all new)

**Tasks:**
- [ ] **Cost:** *(Done 2026-10-23 on `impl/costs-monitor-diet` except the last two bullets; a simulated night: 542 requests, 1,040 rows, 216 alarms — feature doc §7, C3–C5 status.)*
  - [x] Liveness = `max(last camera message, getWebSocketAutoResponseTimestamp(cameraWs))`, stale after 75 s. *(Built as a dead man's switch rather than a 60 s alarm: the alarm sits 105 s after the last proof of life and the camera's messages push it later — ≈ 17 alarm wakes an hour, reported 75–105 s after the last sign of life.)*
  - [x] **Remove `saveBucket` from `alarm()`** and delete `trackBucket`/`saveBucket`/the `tl` blob. `timeline()` is computed from minute blocks plus `sounds.cry` in 5-minute buckets.
  - [x] Accept change-only `status`. Add `onView` and `live_want` (same pattern as `updateRelayWant`).
  - [x] Batched `stats` write `sleepDev`/`sleepSm` once per batch. *(`sleepSm` once per batch, `sleepDev` only on a takeover.)*
  - [x] **Packed minute blocks** in `monitorStore.ts`: `mon_blocks(dev TEXT, h INTEGER, d TEXT, PRIMARY KEY(dev,h)) WITHOUT ROWID`, upserted per batch with `ON CONFLICT DO UPDATE`. Reads decode blocks; retention deletes whole blocks. *(The legacy `mon_minutes` is converted into blocks once and dropped, instead of 31 days of reading both.)*
  - [x] Gate `migrate()` behind a schema number. Keep the camera's proof of life in its socket's `serializeAttachment` (≤ 2 KB). No floating storage promises. *(A KV `schema` key rather than `PRAGMA user_version`; `lastStatus` stays a memory cache — the camera resends it within 2 s whenever someone needs it.)*
  - Idempotent `eid` insert in `onCamEvent`/`addLog`.
  - VAPID through `push/vapidCache.ts`.
- [ ] **Auth and session:**
  - `onAuth` uses `verifyAccessToken`, plus the `{uid → role, label}` cache in DO SQLite (RPC on first sight, on `/x/members`, and every 6 h). Enforce `aal2` when `mfa` is set (close 4003).
  - Store `exp` in the attachment. `reauth` handler. The alarm closes sockets at `exp + 120 s` (4001).
  - Internal `/x/kick` and `/x/members`: kick, prune `push` **and** `callPush`, revoke TURN usernames, ask the holder to rotate the NMK, notify every parent, log a `security` event. Honour `at` (WS-7 contract notes): `/x/kick` closes only what was admitted before it and refuses that person's tokens issued before it until they expire; `/x/members` applies a person's changes in `at` order (the Worker retries in the background). Both are idempotent.
  - The pre-auth cap is separate (8, oldest evicted first) and unauthenticated sockets do not count toward the 42-slot cap. `AUTH_TIMEOUT_MS` = 5 s.
  - Camera `dev` takeover allowed only for the same uid (F7).
  - `onQuery` and `onLog` gated by role and `guestCaps`; `onRtc` only camera ↔ viewer; a guest's acknowledgement never cancels an `everyone` hazard.
  - Per-socket `mintIce` in `admit`; `ice_refresh` at 80% of the TTL.
- [ ] **E2E:** `room/roster.ts` with `mon_devices` and `mon_keywraps`; `dev_hello` verification (signature over the nonce); routing of `key_req`/`key_wrap`/`key_init`/`key_rotate` with compare-and-set epochs; device-added notices to parents. The binary relay branch is unchanged (opaque).
- [ ] **Glance and actions:**
  - `room/glanceState.ts` holds `glance` and `q` (persisted only on a bump) and uses `composeGlance`/`nextBump`. It gives `glanceFacts` each camera's `since` (when its state began), `at` (when its last status arrived) and `minute` (its latest minute row's LAeq and arrival), and runs `nextBump` on every status, minute row and room change, and at `recheckAt`.
  - Socket `mode:'glance'` with `{t:'glance'}` on each bump.
  - `fetch` handles `/glance` (ETag) and `/act` (Supabase JWT, device token with `DS-Proof`, or a `DS-Act` token).
  - `room/actor.ts` refactors `onAck`, `onResolve`, `onCmd` and `onDuty` to take `{uid, role, label, devId}` so WebSocket and HTTP share one code path.
  - `/peek` returns 501 until Phase 2.
- [ ] **Push:**
  - `pushAlert` builds one message, then `router.deliver` per subscription kind; `envelope.sealForDevice` for native; adds `act`, `inc` and `q` for web.
  - Sends the replacement on acknowledgement.
  - Prunes on `gone`.
  - `/x/push-reg` stores native push targets in `push_sub {kind, token, dev, enc}`.

**Done when:**
- Unit tests cover: alarm cadence (≤ 60 alarms/hour), rows-per-batch accounting, the full kick/member lifecycle (sockets closed, push pruned, NMK rotation requested), a pre-auth flood, re-auth expiry, the camera-spoof refusal, role gates, glance ETag/304 and the bump count on the night fixture, `/act` idempotency, and router dispatch.
- The existing MonitorRoom tests are green.

#### WS-10 UserLine and CallRoom
**Owns:** `live-worker/src/userLine.ts`, `userLine.test.ts`, `callRoom.ts`, `callRoom.test.ts`, `directCalls.ts`, `directCalls.test.ts`

**Tasks:**
- [ ] `reauth` handler and expiry enforcement (4001); separate pre-auth cap and `AUTH_TIMEOUT_MS` = 5 s.
- [ ] `/x/kick {uid, why, at}` closes the line socket and prunes call push targets, and answers `{closed, turn, calls}` — `calls` the CallRoom ids the person is in, being rung into or just placed (the line must remember calls answered, not only placed or ringing). The Worker kicks each of those CallRooms (WS-7 `kick.ts`).
- [ ] CallRoom `/x/kick {uid, why, at}`: close that person's sockets in the call, void their ticket, answer `{closed, turn}` (or revoke their TURN credential itself and answer `turn: []`).
- [ ] `/x/user/:uid/notify` sends the new-device push mirror to the user's other devices.
- [ ] Call pushes go through `router.deliver` (the `apns-voip` kind is accepted but stays dormant until Phase 1.1).
- [ ] VAPID through `vapidCache`.

**Done when:** tests cover kick, re-auth expiry and the notify fan-out.

#### WS-11 Stream Studio keys out of URLs (F16)
**Owns:**
- `live-worker/src/eventRoom.ts`, `eventRoom.test.ts`
- `live-worker/src/index.ts` (Wave 2 owner; only the `/api/events` branch)
- `live/api.ts`, `live/views/DashboardView.tsx`, `live/nav.ts`
- `live/LiveApp.tsx` (Wave 2 owner; only the event-key plumbing)

**Tasks:**
- [ ] Move host and guest keys from query strings (`?k=`, `&g=`, `token=`) to first-frame auth on sockets and an `Authorization: DS-Event <key>` header on `/stats`, `/exit` and `/recordings`.
- [ ] Compare keys in constant time.
- [ ] Keep accepting the query form for 14 days behind a deprecation log, then remove it.

**Done when:** the event tests cover both forms and the constant-time compare.

### 4. File ownership matrix (no file appears twice within a wave)

| File or path | Wave 1 owner | Wave 2 owner |
|---|---|---|
| `functions/_middleware.ts`, `functions/csp-report.ts`, `public/_headers`, `index.html`, `live.html`, `public/.well-known/security.txt`, `package.json`, `package-lock.json`, `live/monitor/yamnet.worker.ts`, `/home/user/Comic2/.github/**` | WS-1 | — |
| `packages/monitor-core/**` | WS-2 | — |
| `live-worker/src/webpush.ts` (+ test), `live-worker/src/push/**` | WS-3 | — |
| `server/sql/live_security_v2.sql`, `live-worker/src/supabaseAuth.ts`, `live-worker/src/auth/**`, `live-worker/src/ice.ts` (+ test), `live-worker/src/monitorGuests.ts` (+ test), `email-worker/src/**`, `server/src/routes/authEmail.ts`, `scripts/ops/genDeviceTokenKey.mjs` | WS-4 | — |
| `live/account.ts`, `live/sync.ts`, `live/views/SettingsView.tsx` (+ test), `live/views/account/**`, `public/live-sw.js`, `live/monitor/push.ts` | WS-5 | — |
| `live/LiveApp.tsx` | WS-5 | WS-11 |
| `live/views/MonitorCamera.tsx`, `live/views/MonitorViewer.tsx`, `live/monitor/rtc.ts` (+ test), `live/monitor/client.ts`, `live/monitor/socket.unit.test.ts`, `live/monitor/protocol.ts`, `live/monitor/keys.ts`, `live/monitor/relayCrypto.ts`, `live/monitor/e2e.unit.test.ts`, `live/views/monitor/PeopleCard.tsx`, `live/views/monitor/NurserySettings.tsx` | WS-6 | — |
| `live-worker/src/index.ts` (+ test) | WS-7 | WS-11 |
| `live-worker/wrangler.jsonc`, `live-worker/src/{devices,kick,members,origin,ops}.ts` (+ tests) | WS-7 | — |
| `server/src/services/costCentre.ts` (+ test), `docs/**` listed in WS-8 | WS-8 | — |
| `live-worker/src/monitorRoom.ts`, `monitorStore.ts`, `monitorRoom*.test.ts`, `live-worker/src/room/**` | — | WS-9 |
| `live-worker/src/userLine.ts`, `callRoom.ts`, `directCalls.ts` (+ tests) | — | WS-10 |
| `live-worker/src/eventRoom.ts` (+ test), `live/api.ts`, `live/views/DashboardView.tsx`, `live/nav.ts` | — | WS-11 |

### 5. Merge and release order
1. Merge Wave 1 in any order. Deploy it: the Pages headers start as Report-Only, and the Worker features stay dormant behind capabilities. The owner applies SQL action #4 and the Supabase settings in #3.
2. Run the APNs probe (`POST /api/ops/apns-probe`) and record the result in this ADR's D3.
3. Merge Wave 2 (WS-9, WS-10, WS-11), then deploy the Worker. The server now lists `reauth, view, eid, e2e1, glance1, stats5`, and the already-deployed clients turn the features on.
4. After 48 h of clean CSP reports, set `ENFORCE_LIVE = true` (WS-1).
5. Run the Phase 0 acceptance checklist on 7 days of production KPIs (WS-8: Admin → Costs → Stream Studio → *Baby monitor health* and the Security tab; owner checklist §R) before Phase 1 cuts its first TestFlight build. Set `STREAM_PHASE0_SHIPPED=1` on the backend and as a GitHub Actions variable when Wave 2 deploys, so the budget alerts apply.

---

## Phase 1 implementation checklist

*Written 2026-10-29 from three independent plans (speed first, safety first, CI and testability first). §0 says where they disagreed and which way we went. Day 0 is Thu 2026-10-29. Paths are relative to `dreamstreamcomicstudio/` unless they start with `/home/user/Comic2/`. Package versions were checked on npm the same day.*

*Revised the same day after a critic review. All 20 findings were checked against the code, npm and the vendors' documentation, and all 20 hold. Rows 15–25 of §0 record the decisions that changed, and the rest went straight into the workstreams. Checking them turned up four more facts:
- Phase 0 wave 2 also edits `live/monitor/client.ts`, `live-worker/src/{members,watchGate}.ts` and `docs/features/baby-monitor.md`, which the first in-flight list missed.
- The sign-in gate has merged (`3cab98a8`).
- Stream Studio's web sign-in sends no captcha token, so the Phase 0 CAPTCHA step would lock users out.
- react-native-webrtc's own manifest declares a `mediaProjection` service. The estimates in §11 went up by about a third.*

### 0. Decisions taken in this checklist

| # | Question | Positions | Decision and why |
|---|---|---|---|
| 1 | When does a parent first use a native app? | Speed: a "First Night" gate on the web camera. Safety and CI: one gate at the end. | **Two gates.** **Gate A, "First Night"**: the native parent app (viewer, end-to-end encrypted push with "I'm on it", Sound on with its alarm) watching **today's web camera** on the spare phone. **Gate B, "Phase 1 accepted"**: every Phase 1 acceptance criterion, including the native camera. Parents get value weeks earlier, and the native camera, the riskiest piece for a baby monitor, ships only after it has proved itself. |
| 2 | D2's "Phase 1 week 1" file moves into `monitor-core` | Speed: no move; compile `live/monitor` in place. Safety and CI: move now. | **Move the browser-free files now behind re-export shims, and compile the stateful browser modules in place.** D2's list gains `cryDetector.ts`, which `soundBrain.ts` imports and which is pure, and `LinkState` moves from `rtc.ts` into `rtcPolicy.ts`, because `linkFallback.ts` imports it; without both, the purity test would keep those two files behind. No branch in flight touches the files D2 moves (`git diff --name-only` of `impl/p0-ws9`, `impl/p0-ws10`, `impl/p0-ws11` and `fix/stream-studio-sign-in-gate` against `f67a1150`), and the shims mean no importer changes. `client.ts`, `keys.ts`, `rtc.ts` and `relayCrypto.ts` are not pure (they import `../account`, `../config`, `./guest`, `./voice`). The app compiles them unchanged through a Metro resolver map, so the code the web runs every night is the code the app runs. They move in 1.1. The Worker's switch to monitor-core waits for wave 3, because it edits `monitorRoom.ts`. |
| 3 | iOS CI image | `xcode-27` (GA 2026-10-15) vs `macos-26` | **`macos-26` (Xcode 26.6) gates merges; `xcode-27` runs nightly and does not block.** This matches D9 #14. Xcode 26.6 meets Apple's upload floor (Xcode 26) and Expo 58's (Xcode 26.4), and the image has the watchOS 26 simulators. Spike S1 builds on both on day 1. If 26.6 can't build SDK 58, `xcode-27` becomes the gate and D9 #14 gets a note. The paid `-xlarge` labels are never used. |
| 4 | Live Activity widget | `expo-widgets` vs a Swift widget through apple-targets | **Swift widget through `@bacons/apple-targets`**, as in D1. It shares `targets/_shared` (Glance, coarse state) with the NSE and the watch, it can be snapshot-tested, and it can decrypt the content-state if S3 passes. `expo-widgets` lays out in an isolated JS runtime with no imports or async, so it can't decrypt. It stays the fallback if apple-targets fails on SDK 58. |
| 5 | Where YAMNet runs on the phone | `onnxruntime-react-native` in JS vs native ONNX Runtime Mobile | **Native**, as in D1. The 16 kHz tap is native, so PCM never crosses the bridge. Native code sends class scores (about one a second) to the TypeScript `soundBrain`, which is reused unchanged. **fp32 on the CPU on both platforms** (on iOS, the Core ML EP with `MLComputeUnits=CPUOnly`, or ORT's CPU EP if S8 shows they match). The Core ML EP's default, `ALL`, may place the model on the GPU or Neural Engine in fp16, and the simulator, which runs Core ML on the CPU, can't show that drift. One YAMNet inference a second is cheap on any phone CPU. The GPU or Neural Engine comes in only if a parity run on the owner's iPhone passes. D1's "Core ML on iOS" gets a note (§9 step 8). |
| 6 | Hermes has no WebCrypto | `react-native-quick-crypto` vs a native SubtleCrypto in `ds-keys` | **quick-crypto behind `sealed.ts` `setCryptoProvider`**, with device keys behind `keys.ts` `setKeyStore`: software keys in Keychain/Keystore at Gate A, Secure Enclave/StrongBox at Gate B. Pinned to **1.1.8** (2026-10-08), not 1.1.9 (2026-10-26, three days old), under the same 7-day cooldown as everything else; 1.1.9 only if S2 needs it. Spike S2 runs every sealed vector and times a 60 KB relay frame. If it fails, frame open and seal move into `ds-keys`. |
| 7 | First builds before Phase 0's 7 days of KPIs (Phase 0 §5 step 5) | Speed and safety want device answers in weeks 1–2. | **Builds for the owner's own phones against a test nursery may go first** (TestFlight internal, a sideloaded debug APK). The family's real nursery waits for the 7-day window. This amends Phase 0 §5 step 5 and needs the owner's approval. |
| 8 | Deliverables no acceptance criterion tests: camera QR pairing, per-guest invites with app links, App Attest / Play Integrity as a risk signal, passkeys, PiP, Talk, biometric lock, Android Live Update, native Devices and Security screens, the DOM long tail | Speed: Phase 1.1. Safety and CI: Phase 1. | **Phase 1.1, straight after Gate B. Nothing is dropped**, and §11 estimates it item by item. Until camera pairing ships, the native camera signs in with a parent account, as the web camera does today, so Supabase's session controls must stay off (row 21). Until per-guest invites ship, a guest's or new member's device gets in by a parent approving it on a parent device (row 15). |
| 9 | Emulator loopback codec (D7 says H.264) | — | **VP8 on the emulator, H.264 on hardware.** The emulator has no H.264 encoder. D7's job wording changes with the ADR update in §9 step 8. |
| 10 | Store blockers the ADR doesn't list | — | **Add in-app account deletion** (App Store guideline 5.1.1(v), Play's account-deletion policy). No deletion route exists today: `server/src/routes/account.ts` has none, and the privacy policy points to the support contact. |
| 11 | APNs `BadDeviceToken` | — | `push/apns.ts` maps it to `gone`, which prunes the token, but Apple also returns it for a token from the other environment. A TestFlight/debug mix-up would quietly stop a parent's alerts. **The router retries the other host once before pruning.** This is wave 1 work, because no branch in flight touches `push/**`. |
| 12 | Supabase outage at night | Safety: a new "auth grace" contract | **WS-9 part A already covers it** (on `impl/p0-ws9`). A known member keeps the cached role while Supabase is unreachable, and the expiry close waits while Supabase's auth service is down. Phase 1 adds the native test ("Supabase down 1 h: the camera stays on air, alerts flow, a revoked device is still refused") and nothing on the wire. |
| 13 | Release tooling | fastlane vs `xcodebuild` plus a Node script | **`xcodebuild -allowProvisioningUpdates` and a small `play-upload.mjs`** (Play Developer API through WIF). There is no Ruby toolchain to pin and audit. |
| 14 | When camera mode and native sound AI start | Speed: last wave. CI: first wave. | **Wave 2.** They are new files with no server dependency, and native YAMNet is the longest task in Phase 1, so starting early takes it off the critical path. They still ship only at Gate B. |
| 15 | The plain-call fallback once a nursery has a verified roster | Review: a phantom that sends `nk:1`, or that the room lists without a `devId`, gets a plain call today (`rtc.ts` `plainTaken`, `MonitorCamera.tsx` `plainOk`). A viewer falls back to plain after 15 s (`KEY_FALLBACK_MS`) when the server withholds its wrap. Either way the server relays SDP it can rewrite, so D6.4's Phase 1 claim would be false while the phantom test still passed. | **In a nursery that lists `roster1`, every `rtc.d` is signed by the sender's device key and checked against the verified roster. Nothing unsigned is sent or taken.**<ul><li>A camera answers only verified roster devices. `nk:1` and `plainOk` no longer open a call for a socket outside the roster.</li><li>A verified viewer that gets no wrap within 15 s calls **signed but not sealed**. The DTLS fingerprints are authenticated end to end, so the server can read the SDP but cannot swap them, and the media stays end-to-end encrypted. The relay picture stays off, because it needs the NMK. The pill says "Waiting for the family key".</li><li>A device outside the roster (a new member, a guest, an old app) can't call. It shows "Ask a parent to approve this device", and parents get a push with **Approve**. Approve opens admission path (a)'s SAS screen, with the code compared in person or over a call. Until per-guest invites ship in 1.1, guests and new members get in this way.</li><li>The web shares this code and gets the same rules. The claim still covers native apps only, because a web client trusts the code we serve.</li><li>P1-WS-20b owns `rtc.ts`, `MonitorCamera.tsx` and `MonitorViewer.tsx` in wave 3, and its done-when gains two adversarial tests: a phantom sending `nk:1` gets no media, and withheld wraps never produce an unsigned call.</li></ul> |
| 16 | Turnstile CAPTCHA (Phase 0 owner step #3) | Review: once Supabase's CAPTCHA protection is on, password sign-in, sign-up and recovery need a token ([Supabase](https://supabase.com/docs/guides/auth/auth-captcha)). Turnstile has no native SDK; Cloudflare's supported route is a WebView ([Cloudflare](https://developers.cloudflare.com/turnstile/get-started/mobile-implementation/)). | **The native app gets its token from a Turnstile WebView** (P1-WS-7) on `https://dreamstreamstudio.ai/turnstile-native.html`, and `react-native-webview` joins the dependency set.<br>**Stream Studio's web sign-in has the same gap today.** `live/account.ts` `signIn` and `confirmPassword` (the password check before turning on two-step sign-in) both call `signInWithPassword` without a `captchaToken`. Turning CAPTCHA on now would lock every Stream Studio user out, camera phones included. A new wave 1 workstream, **P1-WS-23**, fixes the web. The owner turns CAPTCHA on only after it deploys, and the Phase 0 checklist now says so. |
| 17 | What proves a native camera is alive (SI-3) | Review: the room counts any message, and the runtime-answered `{"t":"ping"}` (`getWebSocketAutoResponseTimestamp`), as proof of life, and `client.ts` pings every 25 s on its own timer. A native camera whose audio tap or YAMNet stalls while JS still runs would stay "alive". | **Two layers.**<ul><li>`client.ts` gains `pingGate?: () => boolean`. The native camera wires it to `pipelineFresh` and also holds back its 60 s status keepalive while the pipeline is stale. Without `deg1`, the watchdog then raises "Camera offline" within 105 s of the camera's last real message.</li><li>`hb` is computed **in JS**, from when native audio frames and scores last *arrived*, never from the native watchdog's own report. A stalled native watchdog therefore can't hide a stall. Under `deg1` the room raises "The nursery camera can't hear" at 120 s from `hb` alone.</li><li>`client.ts` is in flight on `impl/p0-ws9`, so `pingGate` lands in wave 3 (P1-WS-20b). The native camera ships only at Gate B, after wave 3.</li><li>A new T1 selftest, `audiostall`, stalls the tap while JS keeps running.</li></ul> |
| 18 | Where Sound on and the alarm play, and the microphone | Review: react-native-webrtc's iOS session is `playAndRecord`/`voiceChat`, which plays through the earpiece without `.defaultToSpeaker`. Android's default playout is `USAGE_VOICE_COMMUNICATION`, which phone routing also sends to the earpiece. iOS's default audio device opens the mic even when only receiving, which means a prompt and an orange dot all night ([forum](https://react-native-webrtc.discourse.group/t/ios-avoid-microphone-permission-when-only-receiving-and-not-sending-anything/1952)). | **Output routing is part of Sound on, and a viewer never opens the microphone.** The injected audio device has two modes.<ul><li>**Listen** (P1-WS-13's `ListenDevice`). iOS renders output only, under the `.playback` category: speaker by default, plays through the silent switch, never opens the mic, works with mic permission denied, no orange dot. Android uses media and alarm audio attributes and never starts `AudioRecord`.</li><li>**Camera** (P1-WS-16). Capture runs with AEC on and NS/AGC off.</li></ul>Talk (1.1) switches to `.playAndRecord` with `.defaultToSpeaker`, re-asserted after every interruption and route change. The active route shows in "Alerts on this phone". S1 and Gate A check A5 test "plays on the speaker, no mic indicator". Gate A may fall back to the stock device with `.defaultToSpeaker`, because TestFlight internal has no review. Gate B may not. |
| 19 | What "hardware-backed" means on iOS | Review: App Attest attests only its own `DCAppAttestService` key, never a separate Secure Enclave key, so `hw:true` for `sig`/`ecdh` would be an inference, which SI-9 forbids. `sealed.ts` `signHello` and `unwrapNmk` pass the stored key straight to `subtle`. | **Bind the keys; don't infer.**<ul><li>iOS: an App Attest attestation (the first time) or assertion (later) whose `clientDataHash` is SHA-256(`devId`‖`sigPub`‖`ecdhPub`). It proves that a genuine copy of our app, whose code makes only Secure Enclave keys, registered these keys. Provenance `ios-se-app-attested`. Copy: "keys made in your iPhone's Secure Enclave by a verified copy of our app".</li><li>Android: Key Attestation of the key itself (`android-keystore-attested`, plus `strongbox` where present).</li><li>The crypto provider gets a `subtle` wrapper that sends `sign` and `deriveBits` for hardware handles to `ds-keys`. P1-WS-5 builds the hook in wave 1; P1-WS-21 owns `src/boot/{globals,subtle}.ts` in wave 3.</li></ul> |
| 20 | Existing nurseries and Gate A keys at Gate B | Review: nothing said who signs the first roster entries for today's `mon_devices`, or how a Gate A phone gets its wraps once its key moves to hardware (a new `devId`). The first rotation could leave family devices without a key or push them onto the fallback. | **Three rules in ADR 0008, frozen before wave 3 starts.**<ul><li>**Genesis.** A room lists `roster1` only once the nursery's genesis is signed. The first parent device online with roster-capable code signs `add` entries for the devices in `mon_devices`. Every parent sees the list ("These devices can watch Maya's room"), with Remove beside each. Until genesis the room keeps Phase 0's TOFU behaviour.</li><li>**`replace`.** An entry signed by the old key moves a device to its new key (software to hardware at Gate B) with no SAS. Verifiers accept it only while the old entry is current.</li><li>**Upgrade test.** A Phase 0 nursery with a web viewer, a Gate A phone and a camera goes through genesis, a hardware swap and a rotation, and every device still opens frames.</li></ul> |
| 21 | Supabase Pro session controls while cameras use account sessions | Review: "single session per user" ends the camera's session the moment a parent signs in elsewhere. A time-box or inactivity timeout ends it overnight. The refresh fails, the socket closes with 4001, and the nursery is unmonitored. | **Off until QR camera pairing (1.1).** Single session, time-box and inactivity timeout stay off while any camera runs on an account session. The Phase 0 checklist and `phase1-owner-checklist.md` say so. Drill D3 adds "a parent signs in on a new device; the camera stays on air". |
| 22 | CI when the web files the app compiles change | Review: the app compiles `live/monitor/{client,keys,rtc,relayCrypto}.ts` from the web tree, but the emulator loopback ran only when the Android fingerprint changed, which a JS edit never does. That contradicts acceptance criterion #1. | **The Android emulator's `fixtures` and `loopback` selftests also run on every PR touching `live/monitor/**`, `live/calls/**`, `live/rtcIce.ts` or `packages/monitor-core/**`.** Ubuntu runners are free. The job reuses a fingerprint-keyed cached APK and re-bundles only the JS. The macOS jobs stay fingerprint-gated. Criterion #1 is reworded in the ADR PR (§9 step 8). |
| 23 | The empty watch targets in Phase 1 releases | Review: they would install on users' watches from TestFlight external and the App Store, and invite a rejection under guidelines 2.1 and 4.2. | **`watch` and `watch-widget` build only with `DS_WATCH=1`** (CI, nightly and Phase 2 builds). `assert-release-clean` fails any Phase 1 release archive that contains `Watch/*.app`. The rule lifts when Phase 2 is approved. |
| 24 | Push targets after sign-out, and in nurseries joined later | Review: there is no unregister route (only `POST /api/devices/push` and a full device revoke), and registration reaches only the nurseries the user is in at that moment. | **A `DELETE /api/devices/push {sub}` contract** (P1-WS-9, wave 1) forwards to the rooms' and UserLine's `/x/push-unreg` (P1-WS-20a and P1-WS-19, wave 3). Until the rooms take it, sign-out also deletes the push key pair and calls FCM `deleteToken` / `unregisterForRemoteNotifications`, so the provider answers `gone` and the room prunes the target. The app re-registers on every foreground and whenever `monitor_list` changes. |
| 25 | Early escalation from receipts | Review: browsers and older app builds never post receipts, so "no receipt within 10 s" would escalate every alert and wake the other parent every night. | **Escalate early only when the duty person has at least one target that was sent an `rt` and none of those targets posted a receipt within 10 s.** Everyone else keeps today's `escalateMs`. The web service worker posts `via:'sw'` receipts from wave 3 (P1-WS-19 owns `public/live-sw.js`). |

### 1. Ground rules
1. **Three build waves and two device gates.**
   - Wave 1 (P1-WS-1 to P1-WS-11, plus P1-WS-23) starts today.
   - Wave 2 (P1-WS-12 to P1-WS-18) starts as the wave 1 pieces it needs merge, and ends at **Gate A**.
   - Wave 3 (P1-WS-19, P1-WS-20a, P1-WS-20b, P1-WS-21, P1-WS-22) starts when Phase 0 wave 2 has merged and deployed and the owner has approved ADR 0008. The sign-in gate has already merged and deployed (`3cab98a8`, 2026-10-29). Wave 3 ends at **Gate B**.
   - No file has two owners in the same wave (matrix in §8).
2. **Hands off the files in flight until their branches merge.** (Lists from `git diff --name-only` against `f67a1150`, 2026-10-29, re-run after the review.)
   - Phase 0 wave 2 (`impl/p0-ws9`, `impl/p0-ws9-ack`, `impl/p0-ws10`, `impl/p0-ws11`):
     - `live-worker/src/{monitorRoom,monitorStore,userLine,callRoom,directCalls,directTestKit,eventRoom,eventKeys,index,members,watchGate}.ts` and their tests;
     - `live-worker/src/room/**`;
     - `live/monitor/client.ts` and `live/monitor/socket.unit.test.ts`, plus `docs/features/baby-monitor.md` (`impl/p0-ws9`; the first version of this list missed them, and `members.ts` and `watchGate.ts`);
     - `live/{LiveApp.tsx,api.ts,nav.ts,eventTicket.ts}` and `live/views/DashboardView.tsx`.
   - WS-11's follow-up: once 14 days have passed, a small PR removes the query-string event keys from `live-worker/src/{index,eventRoom}.ts`. That falls inside P1-WS-19's ownership of `index.ts` (about Nov 16–19), so P1-WS-19 carries it.
   - **Comic Studio v5, `origin/claude/gifted-volta-qdhhor`** (another session; 903 files, CI running on 2026-10-29):
     - `vite.config.ts`, `package.json`, `server/src/index.ts`, `server/src/routes/account.ts`, `live/views/monitor/InviteSheet.test.tsx`;
     - `/home/user/Comic2/.github/workflows/ci.yml` and the deploy workflows, plus a new `e2e-mobile.yml` (a Playwright device matrix for the web, unrelated to the native apps; our new workflows are named `mobile-*.yml` and don't collide).
     - P1-WS-1 therefore no longer edits `vite.config.ts` (rule 6). P1-WS-10's one `app.use` line sits beside `/api/account` (line ~299), far from that branch's edit (line ~203), and is rebased onto it if it merges first.
   - The sign-in gate is no longer in flight. Its files (`live/{account.ts,accessGate.ts}`, `live/components/{AuthSheet,Guide}.tsx`, `live/views/SettingsView.tsx`, `live/views/account/**`) are free for branches cut from `3cab98a8` or later. P1-WS-23 takes the sign-in ones in wave 1. The web deletion button still waits for wave 3, because it needs the deletion route deployed first.
   - **This ADR file**, which all three wave 2 branches edit. Phase 1 status lives in `docs/features/native-apps.md` until they merge, and the ticks come back here in one PR.
3. **Native apps speak only shipped contracts.**
   - That means Phase 0's `wire.ts`, caps, routes and push envelopes. New server behaviour is a new cap, dormant until a room lists it.
   - Native sockets announce `caps:['reauth']` in their first frame (WS-9 and WS-10 contract notes).
   - `/act` ids are UUIDs, because the edge's `parseActRequest` takes nothing else.
4. **Fixtures are the contract.**
   - TypeScript, Swift and Kotlin pass the same files, read in place and never copied: `packages/monitor-core/fixtures/**`, `live-worker/src/push/fixtures/envelope-v1.json` and `live-worker/src/auth/fixtures/ds-proof-v1.json`.
   - Changing one needs a note here and a CODEOWNERS review.
5. **Every claim names the tier that proves it.**

   | Tier | Where | What it proves |
   |---|---|---|
   | T0 | This container: Node 22, JDK 21, Gradle; Swift 6.3.3 for Linux and the Android SDK install through the proxy. No `/dev/kvm`, no Docker daemon, about 16 GB free. | `tsc`, vitest, jest-expo; `expo prebuild` for both platforms plus assertions on the generated projects; `swift test` with swift-crypto; JUnit, Robolectric, Roborazzi; Wear builds |
   | T1 | GitHub `ubuntu-latest`: 4 vCPU, 16 GB, KVM | The full Expo Android build; the emulator (API 35 on PRs, API 36 nightly) for WebRTC loopback, foreground service, Doze, reboot and Maestro; the local Worker stack |
   | T2 | GitHub `macos-26`: 3 vCPU M1, 7 GB, Xcode 26.6; at most 5 macOS jobs at once for the repo | Simulator builds of the app, widget, NSE and watch; XCTest on CryptoKit; snapshots; iOS selftests; the release archive (protected Environments only) |
   | T3 | The owner's devices and accounts | Real APNs/FCM delivery; background and lock; Doze and OEM battery killers; camera heat and the 10 h soak; the Live Activity in the Smart Stack; hardware keys; LTE and TURN; App Review |

   - A workstream is "done" at T0–T2. **A T3 box is ticked only from a device run, never from CI** (D7).
   - Known T2 gaps:
     - `simctl push` doesn't run an NSE, so NSE logic lives in DreamCore and its tests call it directly.
     - The simulator has no camera, and on watchOS it allows every socket.
     - The simulator has no Secure Enclave and the emulator no StrongBox, so the app reports key provenance and never claims hardware it can't prove.
6. **One owner for shared mobile files.**
   - P1-WS-1 owns `apps/mobile/package.json`, its lockfile, `app.config.ts`, `metro.config.js` and `app/_layout.tsx`. It installs the **whole Phase 1 dependency set** in wave 1.
   - `app.config.ts` loads `plugins/*.plugin.ts` and every `modules/*/app.plugin.js` by directory scan, and expo-router routes are per folder, so no other workstream edits a shared file.
   - A missing dependency is a one-line PR to that wave's owner of the shared files.
   - **Test file names keep the root vitest out of the app without editing `vite.config.ts`:** mobile jest suites are `*.jest.ts(x)` (jest `testMatch`), and P1-WS-9's local-stack contract tests are `*.e2e.ts`. vitest's default include matches only `*.test.*` and `*.spec.*`. The root `tsconfig.json` still gets its one `apps` exclude line, because no branch in flight touches it.
   - Each workstream that adds a Maestro flow owns its own file in `apps/mobile/maestro/` (named in its **Owns**).
7. **Test hooks never ship.**
   - `DS_TEST_HOOKS` is true only in the Android `ci` build type and the iOS `Ci` configuration.
   - `scripts/ci/assert-release-clean.mjs` fails any release build that contains a hook symbol, the `__selftest` route, a test push origin or the synthetic capturer. A test pattern shown instead of the nursery would be a safety failure.
8. **Keep the web green.**
   - Every workstream keeps these green, plus its own native suites: `npx vitest run`, `npm run typecheck`, `npm --prefix live-worker run typecheck`, `npx vite build`, and `check:consumers` in `packages/monitor-core`.
   - Any PR touching `live/monitor/**`, `live/calls/**`, `live/rtcIce.ts` or `packages/**` also runs the mobile `tsc` and jest jobs **and the Android emulator's `fixtures` and `loopback` selftests** (§0 #22), so a web edit can't silently break the app's WebRTC or end-to-end crypto.
9. **Frugal, safe CI.**
   - No EAS, no paid runners, no Maestro Cloud, no paid SDKs.
   - macOS jobs run only when the iOS native fingerprint changed, a PR is labelled `mobile-ios`, or nightly, with `concurrency: cancel-in-progress`. A web-path PR that passes on the emulator but breaks iOS is caught by the nightly run, and the ADR says so (§9 step 8).
   - The emulator job on web-path PRs reuses the APK cached under the Android fingerprint and rebuilds only the JS: the `ci` build type loads its bundle from Metro on the runner, as Expo's development builds do. It costs about 10–15 minutes of a free runner.
   - Actions are SHA-pinned with `permissions: contents: read`, never `pull_request_target`; fork PRs need approval.
   - Signing happens only in the protected `ios-release` and `android-release` Environments, by `workflow_dispatch`.
10. **SQL** is idempotent and the owner applies it (`CLAUDE.md`).
11. **Phase 4 stays hidden.** Connection shows Automatic only, there is no `ds-local`, and there is no `voip` background mode until 1.1.
12. **No watch app ships in Phase 1.** The `watch` and `watch-widget` targets build only with `DS_WATCH=1` (CI, nightly, Phase 2), and `assert-release-clean` fails any Phase 1 release archive that contains `Watch/*.app` (§0 #23).
13. **Dependency cooldown applies to the first pins too.** A version is installed only once it is at least 7 days old (Dependabot's cooldown), and react-native-webrtc only once it is 30 days old and green on loopback (D1), for anything a family uses at night. Owner-only builds against a test nursery may run newer versions.

### 2. Safety invariants (they override any task)
- **SI-1 The server watchdog is the floor.**
  - A camera that stops proving it is alive raises an urgent "Camera offline" within 105 s (the shipped dead man's switch).
  - Live Activities, complications and Tiles are never the alert path.
- **SI-2 Never suppress a push because a phone is listening.** Sound-on phones still get every push and de-duplicate by incident id or `eid`.
- **SI-3 Liveness proves the pipeline, not the socket.** The room counts any camera message, and the runtime-answered `{"t":"ping"}`, as proof of life (`seenAt` = max(last message, `getWebSocketAutoResponseTimestamp`)). So a camera must stay quiet when its pipeline isn't working:
  - The native camera sends its 25 s ping (through `client.ts` `pingGate`) and its 60 s status keepalive only while `pipelineFresh` holds: the last audio frame and the last YAMNet score each **arrived in JS** ≤ 5 s ago.
  - Without `deg1`, a hung detector then looks like a dead camera, and the watchdog raises "Camera offline" within 105 s of the last real message.
  - With `deg1` (every room from wave 3), `hb` carries those ages. The room warns at 30 s and raises the urgent "The nursery camera can't hear" at 120 s, even while other messages keep the socket alive.
  - `hb` is measured in JS from arrival times, never taken from the native watchdog, so a stalled native watchdog can't vouch for itself.
- **SI-4 Undecryptable never means silent.**
  - Every APNs alert carries a safe outer `aps`: title "DreamStream", body "Nursery alert", sound, interruption level and category.
  - If the NSE fails, times out or finds the keychain still locked before first unlock, it delivers the original.
  - Android posts the fallback on `ds_urgent` when decryption fails.
- **SI-5 High priority only for a visible notification.**
  - APNs priority 10 and FCM `high` go only to messages that show a notification.
  - Routine Live Activity, glance and replacement pushes use priority 5 / `normal`, so the budget is never spent and urgent alerts are never deprioritised.
- **SI-6 Security never takes the monitor off the air, and never hands it to the server.**
  - Admitted sockets ride out an auth outage (WS-9).
  - Before a nursery's roster genesis, a missing key falls back to plain and says so (Phase 0).
  - In a `roster1` nursery, a missing key falls back to **signed, not sealed** signaling between verified devices: the video still plays, end to end, without the relay picture, and the pill says why. An unsigned call never happens there (§0 #15).
  - A device outside the roster is told "Ask a parent to approve this device", and parents get an Approve push. That is a visible wait, never a silent failure.
  - App Attest and Play Integrity are signals, never gates on monitoring.
- **SI-7 Every state that can't monitor is visible**, in plain words, on the camera and in parents' apps: mic or camera interrupted, thermal step-down, unplugged, low battery, stopped by an update, background-restricted, and "this phone won't make a sound".
- **SI-8 Delivery is measured, not assumed.** Every phone keeps delivery records from Gate A, and server receipts arrive in wave 3, so production p95 is known.
- **SI-9 Honest claims only** (D6.4, App Review 1.4.1).
  - Not a medical device; no breathing or SIDS claims.
  - "Keys in secure hardware" only where attested, in the words the attestation supports. On iOS that is "keys made in your iPhone's Secure Enclave by a verified copy of our app" (App Attest binds the keys; it can't attest them, §0 #19). On Android it is Key Attestation of the key itself.
  - "Our servers can't add a device" only for a nursery whose roster genesis is signed, and only on native apps.
- **SI-10 An alert is loud on purpose.** Sound on audio and the in-app alarm play on the loudspeaker (or the headset the parent chose), never the earpiece. A viewer never opens the microphone. The route in use is shown in "Alerts on this phone" (§0 #18).
- **First nights.**
  - For the first three Gate A nights, the family keeps its current alert path running on a second device and exports diagnostics each morning.
  - A missed or late alert is fixed before night 4.
  - A duplicate alert is acceptable in beta; a missed one never is.

**3 a.m. failures and the test that retires each.** The full register, with drills D1–D9, lives in `docs/qa/native-night-drills.md` (P1-WS-8).

| Failure | How a parent finds out | Retired by |
|---|---|---|
| Camera app dies (crash, OEM killer, force-quit) | Watchdog, ≤ 105 s | Emulator `am kill` (T1); drill D3 |
| Detector hangs while the socket stays up (JS frozen) | The ping and keepalive stop; the watchdog, ≤ 105 s | `pipelineFresh` unit test; emulator JS-freeze hook (T1) |
| Audio tap or YAMNet stalls while JS keeps running | `hb` ages: a warning at 30 s, the urgent "can't hear" at 120 s (`deg1`); without `deg1`, the ping and keepalive stop and the watchdog fires | `__selftest/audiostall` on the emulator (T1): stall the tap, keep JS running, assert the room raises "can't hear" or "Camera offline" within 120 s |
| Sound on plays into the earpiece, or the alarm is too quiet to wake anyone | Route shown in "Alerts on this phone"; SI-10 | Route state-machine tests (XCTest, Robolectric); S1 and Gate A A5 on devices |
| A parent signs in on a new device and Supabase ends the camera's session (single session, time-box, inactivity) | Watchdog; socket closes 4001 | Owner checklist keeps those controls off (§0 #21); drill D3 "sign in elsewhere" |
| A signed-out or handed-down phone still gets alerts | — (privacy, not safety) | `DELETE /api/devices/push` contract test (T0); sign-out test that the provider token is gone |
| Camera mic taken (a call, Siri, another app, Android capture silencing) | `deg:'mic'`: a warning at 30 s, urgent at 120 s | XCTest and Robolectric state machines; drill D3 |
| Heat stops capture (`systemPressureState .shutdown`, Android `SEVERE`) | `deg:'thermal'`; `videoBudget` steps down to audio only | Injected-state unit tests; 10 h soak D4 |
| Reboot or overnight OS/app update | Watchdog; "Tap to resume" on Android; the setup checklist turns auto-updates off | Emulator `adb reboot` with `FGS_BOOT_COMPLETED_RESTRICTIONS` (T1); drill D8 |
| Doze or standby buckets on an Android camera | Watchdog | Emulator `deviceidle force-idle`, `set-standby-bucket rare`, 10 min screen off (T1) |
| A parent's phone gets the alert but won't wake them (time-sensitive off, Focus, DND, muted channel, permission denied) | "Alerts on this phone" readiness, with one-tap fixes | Readiness unit tests; drill D2 matrix (T3) |
| A push is lost silently (wrong APNs environment, pruned token, force-stopped Android app) | Delivery records; "Send test alert"; receipts from wave 3 | Router environment-retry test (T0); drill D1, 50 pushes per platform (T3) |
| The NSE fails (memory, 30 s cap, locked keychain) | The SI-4 fallback is still shown and audible | XCTest garbage and missing-key paths (T2); drill D3 (reboot, don't unlock, send an alert) |
| iOS Sound on stops (interruption, route change, media services reset) | Local notice "Listening stopped — alerts still come by push"; SI-2 | XCTest state machine (T2); drill D3 |
| The Live Activity reaches its 8 h cap | `staleDate` and the live/stale dot; restart at 7 h 50 m | Drill D4 (a night over 8 h) |

### 3. Spikes (they run first; each can change the plan)

| Spike | Question | Where | Pass → | Fail → | When |
|---|---|---|---|---|---|
| S0 | Does production reach APNs over HTTP/2? | The owner runs the **APNs HTTP/2 probe** workflow (it has never been run) | Direct APNs (D3) | `PUSH_IOS_VIA=fcm`; Firebase Messaging joins the iOS app (+1 day) | Today |
| S1 | Do Expo 58 (the newest patch ≥ 7 days old), RN 0.88, react-native-webrtc 155.0.1 **and** 155.0.0 **and** 124.0.8, config plugin 15.0.2 and apple-targets 5.0.0 prebuild, build and loop back? Does a receive-only viewer play **on the speaker with no mic indicator** (stock device with `.defaultToSpeaker`, then the listen device)? | T1 emulator API 35/36; T2 `macos-26` and `xcode-27`; the speaker and mic-indicator check on the owner's iPhone (T3) once TestFlight internal exists | Record the pairing, the route and the build times in `docs/features/native-apps.md` | 124.0.8 with SDP codec munging; a local config plugin for the NSE and widget targets; `xcode-27` as the gate | Days 1–3 (route on device: week 2) |
| S2 | Does sealed code run under Hermes with quick-crypto? | Selftest screen on emulator and simulator | Every sealed, envelope and DS-Proof vector passes; a 60 KB frame opens in ≤ 5 ms on the emulator | Frame open and seal in `ds-keys` native code, with JS only orchestrating | Days 2–5 |
| S3 | Does an encrypted Live Activity content-state render in the Smart Stack? (the ADR's spike S3) | Device | `PUSH_LA_SEALED=1` | Coarse enum (`coarseGlance`) | Week 3 |
| S4 | Can one Swift tree serve SwiftPM, the CocoaPods pod and apple-targets `_shared`, with vectors agreeing on Linux Swift, macOS CryptoKit and the JVM? | T0 and T2 | Record the layout | Consume through the podspec only | Days 1–2 |
| S5 | Does an Android foreground service survive Doze, standby, battery saver, screen off and reboot? | T1 | A heartbeat at least every 30 s over 10 min of forced idle; "Tap to resume" after reboot | Record the gap; add the battery-settings fix to readiness | Days 2–4 |
| S6 | Real Android push on the owner's phone (sideloaded debug APK; no store account needed) | T3 | p95 ≤ 5 s over 50 pushes | Investigate before Gate A | Once Firebase exists |
| S7 | iOS device matrix: APNs latency; ring/silent × Sleep Focus × Sound on/off; NSE before first unlock | T3, TestFlight internal, owner only | Matrix recorded; readiness copy follows it | The copy and acceptance numbers follow what the matrix shows | Once the Apple account exists |
| S8 | Native YAMNet parity | ORT for Java on the JVM (T0); the T1/T2 selftest at fp32 on the CPU; **the owner's iPhone (T3)**, through Diagnostics → "Check the sound detector", because the simulator runs Core ML on the CPU and can't show GPU or Neural Engine fp16 drift | Class scores within ±0.02 on golden WAVs, on the phone too | Port the TypeScript preprocessing line by line; stay CPU-only on iOS | Wave 2 (T3 at Gate B) |
| S9 | Opt-in AlarmKit (iOS 26+) escalation from the NSE when an urgent alert goes unanswered | Device, then TestFlight external | Rings ≤ 5 s through Silent and Focus; Beta App Review passes | Drop it | Decided in 1.1 |

### 4. Contracts (Phase 1 additions; frozen when wave 2 starts)

**Toolchain pins** (checked on npm, 2026-10-29)

| Item | Pin | Gate |
|---|---|---|
| Expo / React Native / React | `expo@58.0.x`, `react-native@0.88.x`, `react@19.3.0` (2026-09-09): **the newest patch at least 7 days old on the day P1-WS-1 installs**, aligned by `expo install --fix`. On Oct 29 that is `expo@58.0.17` (Oct 21) with `react-native@0.88.0` (Oct 15). `expo@58.0.21` (Oct 28) and `react-native@0.88.1` (Oct 27) qualify on Nov 4, and Dependabot moves them after that | SDK 58: Xcode 26.4+, compileSdk 37, targetSdk 36, Node 22.13+ |
| WebRTC | Develop on `react-native-webrtc@155.0.1` with `@config-plugins/react-native-webrtc@15.0.2` (2026-08-15) | **Anything a family uses at night runs a version that is 30+ days old and green on loopback**: 155.0.0 qualifies on 2026-11-13, 155.0.1 on 2026-11-19. **Gate A family builds** use 124.0.8 (2026-07-21), or 155.0.0 from Nov 13 if S1 passed on it. Owner-only builds against a test nursery may run 155.0.1. Fallback 124.0.8 with SDP codec munging. The plugin's compatibility table stops at SDK 56, so S1 is the proof. |
| Apple targets | `@bacons/apple-targets@5.0.0` (2026-07-17, before SDK 58) | S1. A prebuild test pins `IPHONEOS_DEPLOYMENT_TARGET` 17.2 in every target (a probe produced 16.4, 17.2 and 18.0 mixed) and watchOS 26.0. |
| Crypto | `react-native-quick-crypto@1.1.8` (2026-10-08). 1.1.9 (2026-10-26) only if S2 needs it, and not before Nov 2 | S2 |
| WebView (Turnstile only) | `react-native-webview@14.0.1` (2026-06-20), the version Expo 58 bundles | P1-WS-7's Turnstile page; nothing else loads web content |
| Storage | `react-native-mmkv@4.3.x` (behind the synchronous `localStorage` shim); `expo-secure-store` | — |
| Auth | `@supabase/supabase-js@2.118.x` | — |
| On-device AI | ONNX Runtime Mobile (`onnxruntime-objc`; `onnxruntime-android`) running the web's pinned YAMNet model, same SHA-256, **fp32 on the CPU**: on iOS the Core ML EP with `MLComputeUnits=CPUOnly` and `AllowLowPrecisionAccumulationOnGPU=0`, or ORT's CPU EP. The choice is recorded in `native-apps.md` (§0 #5) | S8, including the run on the owner's iPhone |
| Swift on Linux | 6.3.3 (Ubuntu 24.04 tarball, SHA-256 and GPG checked). A job asserts the minor version matches the runner's Xcode Swift. | — |
| Android | minSdk 29, targetSdk 36, compileSdk 37; R8 on, with keep rules for webrtc and quick-crypto | — |
| Not used | `expo-notifications` (`ds-alerts` owns the single notification delegate), EAS, fastlane | — |

**Identifiers** (owner action #8):
- App: `ai.dreamstreamstudio.streamstudio`, with the suffixes `.notifications`, `.widgets`, `.watchkitapp` and `.watchkitapp.notifications`.
- App Group `group.ai.dreamstreamstudio.streamstudio`; keychain group `$(AppIdentifierPrefix)ai.dreamstreamstudio.streamstudio.shared`.
- The Team ID is the repo **variable** `APPLE_TEAM_ID`, a placeholder until the owner gives it. Simulator builds don't need it.

| Contract | Shape | Defined by | Used by |
|---|---|---|---|
| Resolver map | `apps/mobile/metro.resolve.js` sends `live/account` → `src/shims/account.ts` (the native session), `live/config` → `src/shims/config.ts` (`WORKER_BASE` from `extra.workerBase`), `live/monitor/guest` → `src/shims/guest.ts` (MMKV), `live/monitor/voice` → `src/shims/voice.ts` (no Talk until 1.1) | P1-WS-5 | everyone |
| Globals | `src/boot/globals.ts` is the first import of `_layout.tsx`. It runs quick-crypto `install()` and `setCryptoProvider`, and installs a synchronous `localStorage` on MMKV, `window.addEventListener/dispatchEvent` (so `ds:token` works), `document.visibilityState` from AppState, and react-native-webrtc `registerGlobals()`. The provider's `subtle` comes from `src/boot/subtle.ts`, which passes everything to quick-crypto except `sign` and `deriveBits` on a hardware handle; those go to a handler registered with `registerHandleCrypto()` (P1-WS-21 registers `ds-keys`) | P1-WS-5 (wave 1); P1-WS-21 (wave 3) | everyone |
| KeyStore | `src/keys/nativeKeyStore.ts` implements `keys.ts` `KeyStore` (`setKeyStore`). Gate A: P-256 keys in SecureStore / Keystore, `AfterFirstUnlockThisDeviceOnly`, never backed up, provenance `software`. Gate B: Secure Enclave / StrongBox handles behind the same interface (P1-WS-21), provenance `ios-se-app-attested`, `android-keystore-attested` or `android-strongbox-attested`, and never inferred. The move to the new keys is a roster `replace` (§0 #20). Android 10–11 have no Keystore ECDH (API 31+): a software ECDH key wrapped by a Keystore AES key, labelled as such | P1-WS-5 | P1-WS-12, 17, 20b, 21 |
| Account API | `src/account/index.ts`: `supa`, `accessToken()`, `status: 'signed_out'\|'needs_mfa'\|'ready'\|'session_revoked'`, `onToken(cb)` (also dispatches `ds:token`), `signIn(email, password, captchaToken)`, `verifyTotp`, `confirmPassword(password, captchaToken)`, `signOutThisDevice()`, `signOutEverywhere()` (`POST /api/me/kick`, then global sign-out), `deleteAccount()`, `serverNow()` (offset from the `Date` header, for DS-Proof's ±60 s window) | P1-WS-7 | the shim, P1-WS-12, 14, 20b |
| Turnstile token (native) | `https://dreamstreamstudio.ai/turnstile-native.html` (static, `public/`) renders the existing widget (`VITE_TURNSTILE_SITE_KEY`) with an `action` of `native_signin`, `native_reset` or `native_confirm`, then posts `{t:'turnstile', token}` or `{t:'turnstile', error}` with `window.ReactNativeWebView.postMessage`. The WebView allows only that origin, `challenges.cloudflare.com`, `about:blank` and `about:srcdoc`, and accepts messages only from that origin. Tokens are single-use: a failed sign-in fetches a fresh one. The token goes in `options.captchaToken` on sign-in, and in `captchaToken` on the backend's recovery route | P1-WS-7 (native), P1-WS-23 (web) | sign-in, recovery, password checks |
| `ds-alerts` JS API | `ensurePermission()`; `pushTarget(): {kind:'apns'\|'fcm', token, enc:{p256dh, auth}, env?, plat}` (what `parsePushSub` accepts); `onTargetChange(cb)`; `readiness(): Readiness`; `deliveryLog(): {inc, q, gAt, recvAt, decrypted, acted}[]`; `liveActivity.{start, update, end, tokens}`; `configure({workerBase})`. `Readiness = {notif, sound, timeSensitive?, critical?, dndBypass?, channelUrgent?, bgRestricted?, bucket?, batteryOpt?, deprioritised?, route?}`, where `route` (`'speaker'\|'headset'\|'bluetooth'\|'earpiece'`) is reported by P1-WS-13's listen session and `earpiece` is a red row | P1-WS-6 | P1-WS-14 |
| Native alert handling | <ul><li>Decrypt `PushEnvelope.e` → `PushInner`. Title and body come from it; keep the nursery (`g.n`), the incident (the envelope's `i`) and `act`. The envelope's clear `s` (`u`/`w`/`i`) picks the category and channel, so a failed decrypt still alerts at the right level.</li><li>Categories: `DS_URGENT` (**I'm on it** first as a background action, then Soothe and Listen), `DS_URGENT_VIEW` (Listen), `DS_WARN`.</li><li>Android channels: `ds_urgent` (`USAGE_ALARM`, `CATEGORY_ALARM`), `ds_calls` (dormant), `ds_status`, `ds_info`. The notification id comes from `inc` (tag `inc_<id>`); the acknowledgement replacement is silent (`setOnlyAlertOnce`).</li><li>**"I'm on it" runs natively**: `POST {base}/api/monitor/{nid}/act` with `Authorization: DS-Act {act}` and body `{a:'ack', inc, id}`, reusing one UUID per alert on retries. If it fails, the alert comes back with the reason (the service worker's rule).</li></ul> | P1-WS-6 | everyone after |
| Test alert | `POST /api/devices/push-test` with a Supabase Bearer and body `{sub}` (as `parsePushSub`). Seals `PushInner{g, title:'Test alert', body:'Alerts reach this phone'}` (`g` a test glance naming no nursery) with the router to **that one target**. **At most 5 per 60 s per account**, through a new Rate Limiting binding `PUSH_TEST_RL` (one stanza in `live-worker/wrangler.jsonc`, owned by P1-WS-9). The binding's `period` can only be 10 or 60 s ([Cloudflare](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)), so the first version's "5 an hour" couldn't be built on it. Returns `{ok, outcome, at}` and stores nothing. Answers 501 until the APNs/FCM secrets exist. Lives in `devices.ts`, which `index.ts` already routes `/api/devices/<sub>` to | P1-WS-9 | P1-WS-14 |
| Push unregister | `DELETE /api/devices/push` with a Supabase Bearer, or a device token plus DS-Proof, and body `{sub}` (as `parsePushSub`). It tells every room the user belongs to, and the user's UserLine, `POST /x/push-unreg {uid, dev, sub}`, then answers `{ok, told, pending}`. A room that doesn't know the route yet (before wave 3) counts as `pending` and is told again by the next registration. Idempotent | P1-WS-9 (route, wave 1); P1-WS-20a (room) and P1-WS-19 (UserLine), wave 3 | P1-WS-14 sign-out |
| APNs environment | Each target already keeps its `env`. On `BadDeviceToken` the router tries the other host once. On success it reports **`outcome: 'ok'` plus `movedEnv: 'sandbox'\|'production'`** on `DeliverReport`, and the room or line that holds the target updates it (wave 3). A fourth outcome would have dropped those pushes from WS-9's `countPushes` and WS-10's `deliver` counts, which count only `ok`. Only a second failure prunes | P1-WS-9 | rooms, the line |
| Receipts (cap `rcpt1`) | `PushInner.rt?` = `r1.<exp>.<mac>`, where mac = HMAC(`ACT_TOKEN_KEY`, `ds-rcpt-v1\|nid\|inc\|dev\|exp`), valid 30 min. `POST /api/monitor/:nid/rcpt {i, rt, via:'nse'\|'fcm'\|'app'\|'sw'}` → 204; the token is the only credential, and the room keeps the first receipt per `(inc, dev)`. KPI = receipt time − incident-open time, both on the server clock. **Early escalation** happens only when the duty person has at least one target that was sent an `rt` and none of those targets posted a receipt within 10 s. A duty person on web push only, or on builds without receipts, keeps today's `escalateMs` (§0 #25) | P1-WS-2 (types), P1-WS-6 (the NSE and FCM post when `rt` is present), P1-WS-19 (room and `public/live-sw.js`) | the cost centre |
| Camera pipeline status (cap `deg1`) | Camera `status` adds `deg?: ('mic'\|'cam'\|'thermal'\|'power'\|'ai'\|'update')[]` and `hb?: {a, y}`: ms since the last audio frame and the last score **arrived in JS**, measured by the TypeScript side, never reported by the native watchdog. The room warns ("camera") after 30 s of `mic` or `ai`, or of `hb.a`/`hb.y` over 30 s, and raises an urgent "The nursery camera can't hear" at 120 s. Glance is unchanged (`cam.pz='interrupted'`). `pipelineFresh(now, lastAudio, lastScore)` gates the ping (`client.ts` `pingGate`) and the 60 s status keepalive (SI-3) | P1-WS-2 (types, `pipeline.ts`), P1-WS-16/17/18 (camera), P1-WS-19 (room rule), P1-WS-20b (`pingGate`) | parents |
| Live Activity | Attributes `{n}` (nursery id only). Content-state = `coarseGlance(g)`, with no names and no ids, unless S3 passes. Gate A: started locally when a Sound-on viewer opens, `staleDate` = now + 90 s. From wave 3 the room pushes it: push-to-start when the camera turns on, an update on each bump at priority 5 (10 with an alert), a restart at 7 h 50 m, and an end when the camera turns off | P1-WS-11 (views), P1-WS-6 (bridge), P1-WS-14 (app), P1-WS-19 (room) | Phase 2 Smart Stack |
| Roster log (ADR 0008, cap `roster1`) | <ul><li>Entry `{seq, op:'genesis'\|'add'\|'remove'\|'role'\|'replace', devId, sigPub, ecdhPub, principal, role, caps, by, prev, sig}`, hash-chained to the creator's first device.</li><li>**Genesis:** signed by the first parent device online with roster-capable code. It lists `add` entries for the devices already in `mon_devices`, and every parent is shown that list with Remove beside each. A room lists `roster1` for a nursery only once its genesis exists; before that, Phase 0 TOFU applies.</li><li>**`replace`:** signed by the device's current key, naming its new keys (software to hardware at Gate B). No SAS. Valid only while the old entry is current.</li><li>SAS = 6 digits from HKDF over both devices' ECDH. Invite proof `HMAC(inviteSecret, sigPub)` (used from 1.1).</li><li>Room messages `roster_get`, `roster_append`, `roster`, plus `admit_req {devId, name}`, which pushes parents an Approve that opens the SAS screen.</li><li>Key holders wrap only to verified entries, and socket auth adds a device signature over `hello.nonce`.</li><li>**Signaling:** in a `roster1` nursery every `rtc.d` carries `s = ECDSA(sender sigKey, nid‖fromDev‖toDev‖pcId‖ts‖body)`. A camera takes signaling only from a verified entry with a valid `s`. A verified viewer without the current wrap sends signed-only (`{body, s}`, not sealed), so the DTLS fingerprints are authenticated end to end. Unsigned signaling is dropped both ways (§0 #15).</li><li>Frozen, with the owner's approval, **before** wave 3 starts.</li></ul> | P1-WS-8 drafts, P1-WS-20a (room) and P1-WS-20b (clients) ship | web, native, Phases 2 and 3 |
| Account deletion | `POST /api/account/delete` on the backend → `{ok, nurseriesLeft, nurseriesDeleted}`. It needs a sign-in within the last 30 minutes, and **`aal2` only when the user has a verified factor**, the same rule WS-5 and WS-9 use. Without a factor, the app has the user re-enter their password, which is a fresh sign-in (with a Turnstile token), before it calls. Most users have no second factor and can only reach `aal1`, so an unconditional `aal2` would leave them unable to delete, failing App Store 5.1.1(v) and Play's deletion policy. Web page `/account-deletion` for Play | P1-WS-10 | P1-WS-7, the store forms |
| Test hooks | `streamstudio://__selftest/<name>` (CI builds only) prints one line, `DS_SELFTEST {"v":1,"name":…,"ok":…,…}`, to logcat or `os_log`. Names: `fixtures`, `loopback`, `channels`, `fgs`, `yamnet`, `audiostall` (stalls the native tap while JS runs, §0 #17) | P1-WS-5 (`audiostall`: P1-WS-16) | CI |
| Diagnostics / Night report | JSON with no tokens, names or IPs: app version, platform, target kind, the last 50 delivery records, readiness (including the audio route), TTFF samples, socket close codes, gaps over 2 min, a thermal and battery log, and the previous run's crash or exit reason. Exported through the share sheet | P1-WS-14 | the owner; Gate A and B evidence |

**Phase 1 caps** (`rcpt1`, `deg1`, `roster1`) are added to `wire.ts` as types and constants in wave 1, dormant. Rooms serve `rcpt1` and `deg1` from wave 3. `roster1` appears per nursery, once that nursery's genesis is signed.

### 5. Wave 1 (starts today; touches no file in flight)

"In flight" means Phase 0 wave 2 and the Comic Studio v5 branch (§1 rule 2). The sign-in gate has merged.

#### P1-WS-1 CI spine, app shell and dependency set
**Owns:**
- `apps/mobile/{package.json, package-lock.json, app.config.ts, babel.config.js, metro.config.js, tsconfig.json, jest.config.js, index.ts, .gitignore, README.md}`
- `apps/mobile/app/_layout.tsx` and `app/index.tsx`
- `apps/mobile/plugins/base.plugin.ts`
- `apps/mobile/__tests__/prebuild/**`
- `scripts/ci/assert-release-clean.mjs` and `scripts/dev/{setup-swift-linux,setup-android-sdk}.sh` (new)
- `/home/user/Comic2/.github/workflows/mobile-{core,android,ios,ios-quick,canary}.yml` and `/home/user/Comic2/.github/actions/{swift-linux,android-sdk,xcresult-summary,fingerprint}/**` (all new)
- The new entries in `/home/user/Comic2/.github/{dependabot.yml,CODEOWNERS}`
- One line in the root `tsconfig.json` (exclude `apps`). **Not** `vite.config.ts`, which the Comic Studio v5 branch edits: the test-name rule in §1 rule 6 keeps vitest out of the app instead.
- `docs/infrastructure/mobile-ci.md` (new)

**Tasks:**
- [ ] Scaffold with expo-router.
  - Own lockfile; not a root workspace; no `ios/` or `android/` folders committed.
  - Metro `watchFolders`: `packages/monitor-core` and `live/`. A lint rule lets the app import only `live/monitor/**`, `live/calls/**` and `live/rtcIce.ts`.
  - Public `extra`: `workerBase`, `supabaseUrl`, the publishable key and `turnstileUrl`.
  - jest `testMatch` is `**/*.jest.ts?(x)`. The scripts include `e2e:local` → `node e2e/run.mjs`, which P1-WS-9 writes.
- [ ] Install the whole Phase 1 set from §4 once, under the cooldown in §1 rule 13. Add `expo-keep-awake`, `expo-battery`, `expo-screen-capture`, `expo-device`, `expo-application`, `expo-haptics`, `expo-build-properties`, `expo-dev-client` (debug only), `react-native-webview` (Turnstile only), jest-expo, `@testing-library/react-native`, and the metro `event-target-shim` redirect that the WebRTC plugin's README requires.
- [ ] `base.plugin.ts`:
  - iOS: 17.2, `UIBackgroundModes` exactly `[audio, remote-notification]`, ATS on, `PrivacyInfo.xcprivacy`.
  - iOS export compliance: `ITSAppUsesNonExemptEncryption` set to the owner's answer (§10). Without the key, every CI upload waits in TestFlight as "Missing Compliance" until someone answers by hand. The app ships its own encryption: WebRTC's BoringSSL, quick-crypto's OpenSSL, and the AES-GCM/ECDH end-to-end layer.
  - **Android permissions, as an allowlist checked on the merged manifest:**
    - Ours: `CAMERA`, `RECORD_AUDIO`, `FOREGROUND_SERVICE` (without it `startForeground` throws), `FOREGROUND_SERVICE_{CAMERA,MICROPHONE,MEDIA_PLAYBACK}`, `POST_NOTIFICATIONS`, `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED`.
    - WebRTC's, from `@config-plugins/react-native-webrtc@15.0.2` (tarball checked): `INTERNET`, `ACCESS_NETWORK_STATE`, `MODIFY_AUDIO_SETTINGS`.
    - Libraries': `VIBRATE` (expo-haptics), `com.google.android.c2dm.permission.RECEIVE` (FCM), `<appId>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` (androidx).
    - Allowed only if S1 shows headset routing needs it: `BLUETOOTH_CONNECT` (API 31+).
    - **Removed** through `android.blockedPermissions` (`tools:node="remove"`): `SYSTEM_ALERT_WINDOW` (Play questions it), the legacy `BLUETOOTH`, and Expo's template `READ_/WRITE_EXTERNAL_STORAGE`. Also removed: react-native-webrtc's own `.MediaProjectionService` (`foregroundServiceType="mediaProjection"`, in its library manifest), because we never share a screen and Play asks about every declared service type.
    - Never `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, which Play restricts.
  - Android network and backup: cleartext off, no user CAs, `certificateTransparency`, `allowBackup=false`, and `dataExtractionRules` that exclude token storage.
  - **Watch targets only with `DS_WATCH=1`.** `app.config.ts` passes the flag to apple-targets, and without it `watch` and `watch-widget` aren't generated (§0 #23).
- [ ] Prebuild assertions (T0): prebuild both platforms into a temp dir, then assert:
  - everything above;
  - every target's deployment target;
  - the App Group and keychain group on the app, NSE and widget;
  - the push and time-sensitive entitlements;
  - `ITSAppUsesNonExemptEncryption` is present;
  - no `voip` and no `NSAllowsArbitraryLoads`;
  - the purpose strings;
  - no watch target when `DS_WATCH` is unset;
  - no silent or looping audio asset (guideline 2.5.4).
- [ ] The merged-manifest assertion (T1): the permission allowlist and the removed service, checked on `assembleDebug`'s merged `AndroidManifest.xml`, because library manifests merge after prebuild.
- [ ] `assert-release-clean.mjs` also fails a Phase 1 release archive that contains `Watch/*.app`.
- [ ] Setup scripts: pinned and checksummed. The NDK installs only with `--ndk`; full Expo Android builds belong on T1, given this container's disk.
- [ ] Workflows:
  - `mobile-core.yml` (ubuntu; every PR touching `apps/**`, `packages/**`, `live/monitor/**`, `live/calls/**`, `live/rtcIce.ts` or a fixture):
    - monitor-core, glance-kotlin `check`, and DreamCoreSwift `swift test` on Linux;
    - the mobile jest, `tsc`, `expo-doctor` and prebuild assertions; the policy greps;
    - `@expo/fingerprint` outputs `ios_changed` and `android_changed`, plus `web_core_changed` for `live/monitor/**`, `live/calls/**`, `live/rtcIce.ts` and `packages/monitor-core/**`.
  - `mobile-android.yml` (`android_changed`, the `mobile-android` label, or nightly):
    - `assembleDebug`, `assembleCi`, unit tests, lint, the merged-manifest assertion;
    - the emulator job (`reactivecircus/android-emulator-runner`, KVM udev rule, cached AVD snapshot) runs the selftests and Maestro;
    - uploads the APK, logcat and recordings.
    - **On `web_core_changed` alone**, the emulator job runs `fixtures` and `loopback` against the APK cached under the current Android fingerprint, with only the JS rebuilt (§1 rule 9). This is what makes acceptance criterion #1 true for web edits (§0 #22).
  - `mobile-ios.yml` (`macos-26`; `ios_changed`, the `mobile-ios` label, or nightly; always with `DS_WATCH=1`):
    - prebuild; Pods and ccache cached and keyed by the fingerprint;
    - a simulator build of every target with `CODE_SIGNING_ALLOWED=NO`; XCTest; the selftests;
    - xcresult turned into JUnit, a job summary and failing-snapshot PNGs.
  - `mobile-ios-quick.yml`: the Swift packages and targets only, ≤ 12 min warm. Also `workflow_dispatch` with an `only` input.
  - `mobile-canary.yml` (nightly, never blocking): the `xcode-27` image, the next react-native-webrtc and Expo `next`. Opens an issue on failure.
- [ ] Repo config:
  - Dependabot: npm for `apps/mobile`, ignoring Expo and React Native majors; gradle for `packages/glance-kotlin` and `apps/wearos`; swift for `packages/DreamCoreSwift`; the 7-day cooldown.
  - CODEOWNERS on `apps/mobile/{app.config.ts,plugins/}`, `**/*.entitlements`, `apps/mobile/targets/**/expo-target.config.js`, `packages/monitor-core/fixtures/`, `apps/*/package-lock.json` and the release workflows.
- [ ] `mobile-ci.md`:
  - the tiers;
  - how an engineer reads results from the container (`gh run list -w mobile-ios`, `gh run view --log-failed`, `gh run download -n snapshots`);
  - the time budgets;
  - the cache plan for the 10 GB cap: Pods, ccache, Gradle (read-only on PRs) and one AVD snapshot, never DerivedData.

**Done when:**
- An empty Expo 58 app with widget, NSE, watch and watch-widget targets (`DS_WATCH=1`) builds green at T1 and T2. The same app without the flag has no watch target.
- A JS-only change skips macOS. A change to `live/monitor/rtc.ts` alone still runs the emulator loopback.
- The prebuild assertions are green at T0, the merged-manifest assertion at T1, and the root checks are unchanged. Root `npx vitest run` collects no file under `apps/`.
- Warm times are recorded against these targets: core ≤ 6 min, Android build ≤ 18, emulator ≤ 15, the web-path emulator run ≤ 15, iOS full ≤ 35, iOS quick ≤ 12.

#### P1-WS-2 monitor-core moves, fixtures and pipeline rules
**Owns:**
- New files in `packages/monitor-core/src/`: `{protocol,callTypes,soundBrain,soundClasses,cryDetector,trackerScience,videoBudget,scene,vision,motion,linkFallback,resample,trackTypes,whoGrowth,rtcPolicy,pipeline}.ts` and their tests
- `packages/monitor-core/{package.json,README.md,src/index.ts,scripts/gen-fixtures.ts}`
- `packages/monitor-core/src/wire.ts` (Phase 1 additions only)
- `packages/monitor-core/fixtures/{sound,presentation}/**`
- The re-export shims at the old paths: `live/monitor/{protocol,soundBrain,soundClasses,cryDetector,trackerScience,videoBudget,scene,vision,motion,linkFallback,resample,trackTypes,whoGrowth}.ts` and `live/calls/types.ts`
- The pure-logic import lines in `live/monitor/rtc.ts`, and its `LinkState` line (wave 1 only; P1-WS-20b owns the file in wave 3)

**Not owned:** anything in `live-worker/**`.

**Tasks:**
- [ ] Move each browser-free file unchanged. The old path becomes `export * from '…/packages/monitor-core/src/<x>'`, so no importer changes.
  - Export each moved file as a package subpath (`@dreamstream/monitor-core/protocol`, …), plus `./roster` for P1-WS-8, and not from `index.ts`, so names never collide with `wire.ts`.
  - The purity test covers every moved file. A file that fails it stays behind, with a note.
- [ ] `cryDetector.ts` moves with `soundBrain.ts`, which imports it. It is pure: no imports, no DOM.
- [ ] `rtcPolicy.ts`: the quality ladder, codec order and `classifyPath` from `rtc.ts`, plus the `LinkState` type, which `linkFallback.ts` imports. `rtc.ts` keeps the browser code and re-exports them, so `import type { LinkState } from './rtc'` still works everywhere else.
- [ ] `videoBudget` gains a `thermal: 'nominal'|'fair'|'serious'|'critical'` input, which steps down and then drops to audio only.
- [ ] `pipeline.ts`: `pipelineFresh(now, lastAudio, lastScore)` and the `hb` builder (SI-3).
- [ ] `wire.ts`: the caps `rcpt1`, `deg1` and `roster1`; `PushInner.rt?`; status `deg?` and `hb?`; the push-registration `app?: {v, build}`. All dormant, all additive.
- [ ] `fixtures/sound/*.wav` plus expected YAMNet scores and `soundBrain` output from the TypeScript pipeline, generated with onnxruntime-node and the pinned model.
  - Clips must be CC0 or our own recordings (ESC-50 is CC BY-NC), ≤ 2 MB in total.
- [ ] `fixtures/presentation/mood.json`: per Mood, the glyph id, the word, the colour token and the VoiceOver template, with `MoodGlyph.tsx` as the source.
- [ ] `gen-fixtures.ts --check` runs in CI and is deterministic.

**Done when (T0):**
- Every existing `live/monitor/*.unit.test.ts` passes unchanged through the shims.
- The built-page tests pass and the `vite build` output differs only in module ids.
- `check:consumers` passes, and the app bundles monitor-core under Hermes (T1).

#### P1-WS-3 DreamCoreSwift (Swift core that tests on Linux)
**Owns:** `packages/DreamCoreSwift/**` (`Package.swift`, `DreamCore.podspec`, `Sources/`, `Tests/`) and `apps/mobile/targets/_shared/**`.

**Tasks:**
- [ ] Spike S4 on day 1: one source tree consumed three ways:
  - SwiftPM (Linux and macOS);
  - the pod for the Expo modules;
  - apple-targets `_shared` for the NSE, widget and watch.

  Record the layout.
- [ ] `#if canImport(CryptoKit)`, otherwise swift-crypto (a Linux-only dependency; the podspec has none).
- [ ] `GlanceV1` Codable: passes `glance/*.json`, ignores unknown fields, and treats absent and null alike. `coarseGlance`; `can` bits.
- [ ] `Sealed`: `devId`, NMK unwrap, frame open (with replay and age checks), signal open, `dev_hello` signing. Passes `sealed/*.json`.
- [ ] `PushOpener`: opens RFC 8291 aes128gcm and **always** returns displayable content, either the decrypted `PushInner` or the fallback with the urgent category. Passes `envelope-v1.json`, including its reject cases.
- [ ] `DeviceSigner`:
  - `SoftwareP256Signer` (tests, Linux) and `SecureEnclaveSigner` (`#if os(iOS) || os(watchOS)`).
  - `provenance` is explicit and never inferred.
  - The DS-Proof v1 canonical string matches `ds-proof-v1.json`.
- [ ] `MoodPresentation` (from `presentation/mood.json`), `Staleness` (90 s), `LiveActivityPlan` (restart at 7 h 50 m; priority 5 vs 10; fake clock), `HapticLadder` (used in Phase 2), and the `ActRequest` builder.

**Done when:**
- `swift test` is green in this container (T0) and on `macos-26` (T2) against the same fixtures.
- A policy test finds no Apple-only import outside `#if` guards.

#### P1-WS-4 glance-kotlin (JVM Kotlin core)
**Owns:** `packages/glance-kotlin/**`.

**Tasks:**
- [ ] Ports of P1-WS-3's functions:
  - `GlanceV1` with kotlinx.serialization;
  - the sealed operations on Tink/JCA (empty HKDF salt), with DER ↔ P1363 signature conversion;
  - the RFC 8291 opener, with the same never-silent fallback;
  - the DS-Proof signer interface;
  - `MoodPresentation`, `Staleness` and `ActRequest`.
- [ ] Pure JVM with no Android dependency, so it runs here and is `includeBuild`-able from the `ds-*` Android modules and `apps/wearos`.

**Done when (T0, T1):** `./gradlew check` is green over every fixture.

#### P1-WS-5 React Native bridge, WebRTC loopback and selftests (spikes S1, S2)
**Owns:**
- `apps/mobile/metro.resolve.js`
- `apps/mobile/src/{boot,shims,keys,rtc,selftest}/**`
- `apps/mobile/app/__selftest.tsx`
- `apps/mobile/modules/ds-testhooks/**` (`TestPatternCapturer`, `ToneSource`; linked only when `DS_TEST_HOOKS` is set)
- `apps/mobile/maestro/{loopback,selftest}.yaml`

**Tasks:**
- [ ] **Day 1, spike S1:** Expo 58 + RN 0.88 with react-native-webrtc 155.0.1, then 155.0.0 and 124.0.8: prebuild, build both platforms, run the loopback. Write the result and build times into the S1 section of `docs/features/native-apps.md` (P1-WS-8 gives this section to this workstream).
- [ ] The resolver map, shims, globals and `NativeKeyStore` from §4.
- [ ] `src/boot/subtle.ts`: the `subtle` that `setCryptoProvider` gets. It passes calls to quick-crypto, except `sign` and `deriveBits` on a key that is a hardware handle (`{hw: id}`), which go to the handler registered with `registerHandleCrypto()`. `sealed.ts` `signHello` and `unwrapNmk` pass the stored key straight to `subtle`, so this hook is how hardware keys work without touching monitor-core (§0 #19). Tested with a fake handler.
- [ ] `__selftest/fixtures` (spike S2) runs every sealed, glance, envelope and DS-Proof vector through quick-crypto under Hermes, and times opening a 60 KB frame.
- [ ] `__selftest/loopback`:
  - Two `RTCPeerConnection`s in one JS context, using the web's `CameraHub` / `ViewerLink` compiled in place, with sealed signaling between two `NurseryKeys`.
  - A test-pattern track and a data-channel echo.
  - Assert at least 150 frames decoded in 10 s, data-channel round trip < 200 ms, and a codec from the preferred list: VP8 on the emulator, H.264 on hardware.

**Done when:**
- The `fixtures` and `loopback` selftests print `ok:true` on the API 35 emulator (T1) and the iOS 26.5 simulator (T2).
- `assert-release-clean` passes on a release build.
- This is the ship gate for the react-native-webrtc version.

#### P1-WS-6 `ds-alerts`, the iOS NSE and the Android message service
**Owns:** `apps/mobile/modules/ds-alerts/**` (Swift, Kotlin, TypeScript and its `app.plugin.js`) and `apps/mobile/targets/notification-service/**`.

**Tasks:**
- [ ] iOS app side:
  - Authorization (alert, sound, badge, time-sensitive; `.criticalAlert` only once entitled) and the APNs token with its `env`.
  - The categories from §4.
  - The push key pair (P-256 plus a 16-byte auth secret) is generated **natively** into the App Group keychain (`AfterFirstUnlockThisDeviceOnly`); only the public half reaches JS.
  - The action handler posts `/act` from Swift, so JS needn't boot.
  - A delivery log in App Group defaults.
- [ ] NSE:
  - Open with DreamCore `PushOpener`; set title, body, `threadIdentifier` and `interruptionLevel`.
  - Post the receipt when `rt` is present (dormant until `rcpt1`).
  - Write the delivery record.
  - Internal budget 5 s. **Any failure calls `contentHandler(original)`** (SI-4).
- [ ] Android:
  - A data-only, high-priority `FirebaseMessagingService` that decrypts with glance-kotlin and posts on the §4 channels. An undecryptable envelope with `s=='u'` still posts the fallback on `ds_urgent`.
  - Escalations update in place and alert again; the acknowledgement replacement is silent.
  - Count `originalPriority != priority` (deprioritised) into readiness.
  - An action receiver posts `/act` through WorkManager with retry.
  - The `POST_NOTIFICATIONS` flow and token refresh.
  - `google-services.json` is injected at build time from an Environment secret; debug CI uses a placeholder project.
- [ ] The readiness evaluator (§4), with a deep link to each settings screen.
- [ ] The Live Activity bridge: start, update, end, and the push-to-start and update token streams.
- [ ] The plugin:
  - entitlements: `aps-environment`, time-sensitive, the App Group, the keychain group;
  - the NSE target pinned to iOS 17.2;
  - the Android manifest entries.
- [ ] Tests:
  - XCTest calls the NSE's `didReceive` directly with valid, corrupt and missing-key requests, and checks the `/act` builder.
  - Robolectric: a fixture data message gives the right channel, text and actions; a tampered envelope gives the fallback; a repeat updates in place; the replacement is quiet; the readiness mapping; the action receiver against MockWebServer, sending the same `id` twice.
  - `__selftest/channels` on the emulator.

**Done when:** Robolectric is green at T0/T1, and XCTest and the NSE build are green at T2. Real delivery is checked at Gate A (T3).

#### P1-WS-7 Native account and session
**Owns:** `apps/mobile/src/{account,turnstile}/**`, `apps/mobile/app/(auth)/**`, `apps/mobile/app/(app)/settings/account.tsx`, `apps/mobile/maestro/signin.yaml`, and `public/turnstile-native.html` (new).

**Tasks:**
- [ ] supabase-js with a SecureStore adapter (this device only, never backed up).
- [ ] **Turnstile in a WebView** (§0 #16, the §4 contract):
  - `public/turnstile-native.html` renders the existing widget, using the main site's hostname (already in the widget's list; the owner confirms, §10). It posts the token back. Its CSP allows `challenges.cloudflare.com` for scripts, frames and connections.
  - A small sheet in the app hosts the WebView, locked to that origin and Cloudflare's. A token is fetched for each attempt, and expiry or an error offers "Try again".
  - The token goes in `options.captchaToken` on `signInWithPassword` and `confirmPassword`, and in `captchaToken` on the backend recovery route ("Forgot password").
- [ ] Email and password sign-in, then the TOTP (`aal2`) challenge.
  - "Use a recovery code" opens the web.
  - `needs_mfa` is decided only from the server (WS-5's rule).
  - No social login, so Sign in with Apple isn't required (guideline 4.8).
- [ ] The `session_revoked` notice, `ds:token` on refresh, `serverNow()`, and both sign-outs with WS-5's honest copy. Sign-out also runs P1-WS-14's push unregister (§0 #24) before the session goes.
- [ ] Delete account: a confirmation that names the nurseries that will be deleted (where the user is the last parent), then `POST /api/account/delete`, which is dormant until P1-WS-10 deploys. Without a verified factor, the confirmation first asks for the password again (a fresh sign-in, with a Turnstile token).
- [ ] Written fresh. It does **not** import `live/account.ts` (P1-WS-23 is changing it); the shim points `live/account` here.

**Done when (T0, T1/T2):**
- jest covers sign-in (with and without a token), MFA, both sign-outs, a revoked session and deletion through both `aal` paths.
- The Maestro `signin.yaml` flow passes on both simulators against P1-WS-9's local stack, whose fake Supabase **refuses a password sign-in without a `captchaToken`**. CI uses Turnstile's always-pass test site key.

#### P1-WS-8 Roster contract (ADR 0008) and Phase 1 docs
**Owns:**
- `packages/monitor-core/src/{roster.ts,roster.test.ts}` and `fixtures/roster/**`
- `docs/decisions/0008-roster-log-wire-format.md` (new, Proposed) and its row in `docs/decisions/README.md`
- `docs/features/native-apps.md` (new; its S1 section belongs to P1-WS-5)
- `docs/qa/native-night-drills.md` (new)
- `docs/release/{app-review-notes,play-declarations}.md` (new)
- `docs/infrastructure/phase1-owner-checklist.md` (new)

**Tasks:**
- [ ] Pure roster code: entry encoding and signature, chain verification (including `genesis` and `replace`), SAS derivation, the invite proof, the signaling signature `s`, and golden fixtures for the Swift and Kotlin ports. It stays inside the purity test.
- [ ] ADR 0008 states the §4 roster contract in full, including the parts the review added (§0 #15, #20):
  - genesis, and who signs it;
  - `replace`;
  - signed and signed-only signaling, and what a device outside the roster sees;
  - parent approval of a guest or new member until per-guest invites (1.1);
  - the upgrade path from a Phase 0 nursery;
  - mixed versions.
  It is **frozen before wave 3 starts**.
- [ ] `native-apps.md`:
  - the gates;
  - which D6.4 claim is true at each gate, in SI-9's words: "alert content is encrypted" from Gate A; the hardware-key wording and "our servers can't add a device" only from Gate B, and the latter only for nurseries whose genesis is signed;
  - the first-night protocol;
  - Phase 1 status until this ADR is free.
- [ ] `native-night-drills.md`:
  - drills D1–D9 with exact steps, the expected alert and time, and a results table (listed in §7's Gate B checklist). D3 adds "a parent signs in on a new device; the camera stays on air" and "Sound on plays on the speaker";
  - the camera-phone setup checklist: automatic OS and app updates off, Do Not Disturb or airplane mode plus Wi-Fi, on the charger with the optimised-charging advice, Guided Access or screen pinning.
- [ ] App Review notes and video script:
  - two phones;
  - Sound on plays real nursery audio (2.5.4) on the speaker with no microphone in use; the camera indicator; time-sensitive use;
  - no medical claims (1.4.1);
  - the demo account (it signs in through the Turnstile sheet) and the test-alert path.
- [ ] Play text: the foreground-service declarations and video scripts (mediaPlayback for Gate A; camera and microphone for Gate B), Data safety, and the deletion URL.
- [ ] App Store text: the App Privacy answers (data types: email, user ID, device ID, diagnostics; nothing used for tracking), the age-rating answers, and the export-compliance summary for the owner to confirm (§10).
- [ ] Copy for every degraded state (SI-7), the "Ask a parent to approve this device" and "Waiting for the family key" states, and the genesis review screen.
- [ ] `phase1-owner-checklist.md`: the exact clicks for every owner step in §10, in order, including two plain warnings:
  - do not enable Supabase single session, time-box or inactivity timeout while any camera runs on an account session (§0 #21);
  - do not enable Supabase CAPTCHA until P1-WS-23 has deployed (§0 #16).

**Done when:** vitest is green (including the purity test), and the owner has approved ADR 0008 and the copy.

#### P1-WS-9 Push hardening, test alert, push unregister and local Worker harness
**Owns:**
- `live-worker/src/push/{router,apns}.ts` and their tests
- `live-worker/src/devices.ts` and `devices.test.ts` (the `push-test` sub-route and the `DELETE push` method only)
- The one `PUSH_TEST_RL` Rate Limiting stanza in `live-worker/wrangler.jsonc` (no branch in flight touches the file)
- `apps/mobile/e2e/**` (contract tests named `*.e2e.ts`; the runner `e2e/run.mjs`)
- `/home/user/Comic2/.github/workflows/mobile-localstack.yml` (new)

**Tasks:**
- [ ] The `BadDeviceToken` retry on the other host, reporting `outcome: 'ok'` with `movedEnv` (§4), so existing `ok` counters keep counting it.
- [ ] A router test asserting SI-5: no priority-10 or `high` message without a visible notification.
- [ ] `push-test` (§4), with a fake APNs/FCM test and a rate-limit test (5 per 60 s on `PUSH_TEST_RL`).
- [ ] `DELETE /api/devices/push` (§4): tells each room and the UserLine `/x/push-unreg`, and reports `pending` for any that answer 404 (every room until wave 3). Tests: idempotent; a revoked device token is refused; the body must parse as `parsePushSub`.
- [ ] The local stack:
  - `wrangler dev` for `live-worker`, with `SUPABASE_URL` pointing at a fake Supabase (JWKS plus the RPCs the room calls, ES256 test keys made at start). `auth/jwks.ts` derives its URL from `SUPABASE_URL`, so the Worker isn't edited.
  - The fake Supabase's password grant **refuses a request without a `captchaToken`**, as the real one will once the owner enables CAPTCHA, so P1-WS-7's Maestro flow catches a regression.
  - Node contract tests through the app's own clients: socket auth and `hello.caps`, `reauth`, a glance bump, `/glance` 200 then 304, `/act` idempotency, a kick closing with 4004, and push register then unregister.
  - Each test runs only when the deployed code lists the cap, so the suite passes before and after Phase 0 wave 2.

**Done when:** vitest, the Worker typecheck and `npm --prefix apps/mobile run e2e:local` are green (T0, T1). The test-alert route answers 501 while the secrets are unset.

#### P1-WS-10 Account deletion (store blocker), server and web page
**Owns:**
- `server/sql/live_account_delete.sql` (new)
- `server/src/routes/accountDelete.ts` and its test (new), plus its one `app.use` line in `server/src/index.ts`
- `public/account-deletion.html` (new)

**Tasks:**
- [ ] Require a sign-in within the last 30 minutes, and `aal2` **only when the user has a verified factor** (WS-5 and WS-9's rule; §4). A user without two-step sign-in re-enters their password in the app or on the web page, which is the fresh sign-in.
- [ ] Leave each nursery through the members path: kick, prune push, request NMK rotation.
- [ ] A nursery where the user is the last parent needs explicit confirmation. Its camera then shows "This nursery was deleted" and stops, never silently.
- [ ] Then the signed kick everywhere (`server/src/services/liveKick.ts`), then delete the auth user with the service role, then send a confirmation email.
- [ ] Disclose what we keep: `security_events` for 180 days.
- [ ] The web Settings button waits for wave 3 (P1-WS-22), because the sign-in gate edits `SettingsView.tsx`.

**Done when:**
- Tests cover a shared nursery and a last-parent nursery.
- Tests cover both `aal` paths: a user with a factor at `aal1` is refused; a user without one, signed in 10 minutes ago, is accepted, and the same user signed in 40 minutes ago is refused.
- A deleted user's sockets close, and a fake push endpoint receives nothing afterwards.
- The SQL applies cleanly twice.
- The route's `app.use` line sits beside `/api/account` in `server/src/index.ts` and is rebased onto the Comic Studio v5 branch if that branch merges first.

#### P1-WS-11 Apple targets, DreamUISwift and the `ds-watch` stub
**Owns:** `apps/mobile/targets/{widget,watch,watch-widget}/**`, `packages/DreamUISwift/**` and `apps/mobile/modules/ds-watch/**` (new).

**Tasks:**
- [ ] `DreamUISwift` (iOS 17.2, watchOS 26):
  - `MoodGlyph`, from the exact path data in `MoodGlyph.tsx`, with a static frame when reduced.
  - The Live Activity Lock Screen, Dynamic Island and `.small` (Smart Stack) layouts.
  - The watch Home calm and alert states and the complication views (used in Phase 2).
  - The views read only `GlanceV1` and `MoodPresentation`.
- [ ] Snapshot tests on an iOS simulator host at Lock Screen, Dynamic Island and watch 41/45/46/49 mm sizes: 8 moods × `isLuminanceReduced` × Dynamic Type (default, AX3) × Reduce Motion.
  - swift-snapshot-testing doesn't support watchOS, so a watchOS `ImageRenderer` smoke test also attaches PNGs, without pixel gating.
- [ ] `widget`: an `ActivityConfiguration` for `MonitorActivityAttributes`, with coarse content-state unless S3 passes.
- [ ] `watch` and `watch-widget`: empty shells that build, **only with `DS_WATCH=1`**. Their `expo-target.config.js` returns nothing without it, so no Phase 1 release contains a watch app (§0 #23).
  - A static policy test fails on `URLSessionWebSocketTask`, `NWConnection`, `import Network` or Starscream under `targets/watch*/**` (TN3135).
- [ ] The `ds-watch` stub (a Phase 1 deliverable): the JS API Phase 2 will fill (`isPaired()`, `isAvailable()`, `sendGlance()`, `onMessage()`), returning "not available" on every platform, with no-op Swift and Kotlin and no entitlements.
- [ ] Every `expo-target.config.js` pins its deployment target.

**Done when:** snapshots are green at T2 with the reference PNGs committed, the policy grep passes at T0, and a build without `DS_WATCH` has no watch target.

#### P1-WS-23 Turnstile on Stream Studio's web sign-in (unblocks Phase 0 owner step #3)
**Branch from** `3cab98a8` or later (the sign-in gate's merge).

**Owns:** `live/account.ts` (`signIn` and `confirmPassword` only), `live/components/AuthSheet.tsx` and `live/views/account/SignInGate.tsx`, with their tests.

**Tasks:**
- [ ] `signIn(email, password, captchaToken?)` and `confirmPassword(password, captchaToken?)` pass `options.captchaToken` to `signInWithPassword`.
- [ ] The sign-in sheet and the "type your password again" step show the existing `Turnstile` component when `turnstileEnabled()`, as the reset step already does. A failed attempt spends the token, so the form calls `resetTurnstile()` and waits for a new one.
- [ ] The error Supabase returns for a missing or failed captcha reads "Please complete the check and try again", never the raw message.

**Done when:** unit tests cover sign-in and the password check with and without a token. A manual check on `stream.dreamstreamstudio.ai` against a Supabase project with CAPTCHA on passes before the owner turns it on in production.

### 6. Wave 2 and Gate A, "First Night"
**Starts** as the wave 1 pieces each workstream needs merge (P1-WS-1, 5, 6 and 7 for most).
- `/act`, `/glance`, push and receipts are live only after Phase 0 wave 2 deploys and the owner sets the Phase 0 secrets (#4, #5) and the APNs/FCM keys (#9, #13). Until then everything is built against fixtures and the local stack.
- Store accounts are needed only for P1-WS-15's last step.

#### P1-WS-12 Parent viewer
**Owns:** `apps/mobile/app/(app)/{_layout.tsx,nurseries.tsx,viewer/**,inbox.tsx}`, `apps/mobile/src/{viewer,inbox,status}/**`, `apps/mobile/plugins/viewer.plugin.ts`, `apps/mobile/maestro/viewer.yaml`.

**Tasks:**
- [ ] Nursery list (`monitor_list`), remembering each nursery's caps. A change in the list (a nursery joined or left) emits `nurseries:changed`, which P1-WS-14 uses to re-register push targets (§0 #24).
- [ ] Socket through the shimmed `live/monitor/client.ts`: `caps:['reauth']` in the first frame, re-auth, close codes through `closeKind`.
- [ ] Video:
  - `ViewerLink` plus `NurseryKeys` (`dev_hello`, `key_req`, sticky E2E and the 15 s fallback exactly as on the web). That is Phase 0 behaviour and right for Gate A. In a `roster1` nursery the shared code changes in wave 3 (P1-WS-20b): signed-only instead of plain, and "Ask a parent to approve this device" outside the roster. The app picks it up unchanged, and its states get native copy here.
  - Sealed signaling.
  - Relay frames through `RelayOpener` into an `Image`; the lock shows only while sealed frames open.
  - `FirstArrival` dedupe, `view` on AppState changes, `ice` refresh.
- [ ] The bedside layout from `{t:'glance'}`: glyph, one word, dB band, sleep.
- [ ] Status pill: Home Wi-Fi / Internet / Relay / Camera offline / Alerts off on this phone.
- [ ] Alerts inbox with acknowledge. Pushes and socket events are de-duplicated by `inc` / `eid` (SI-2).
- [ ] `FLAG_SECURE` on the viewer, a blurred app-switcher snapshot, and `UIScreen.isCaptured` handling.
- [ ] TTFF from `getStats` `framesDecoded`, written to diagnostics.

**Done when:** jest covers the pill and state logic, and the Maestro `viewer.yaml` flow passes on the emulator against the local stack and the test-pattern camera (T1).

#### P1-WS-13 Sound on / Sound off, the in-app alarm and the listen device
**Owns:** `apps/mobile/modules/ds-listen/**` (new module: the playback session, Android `mediaPlayback` service, alarm), `apps/mobile/modules/ds-media/{ios,android}/ListenDevice.*` (the output-only audio device), and `apps/mobile/src/sound/**`.

**Tasks:**
- [ ] **The listen device** (§0 #18), selected by P1-WS-16's `AudioDevice` whenever this phone isn't a camera:
  - iOS: output only, under the `.playback` category. It plays on the speaker by default, sounds through the silent switch, never opens the microphone (no prompt, no orange dot) and works with mic permission denied.
  - Android: `JavaAudioDeviceModule` playout with `USAGE_MEDIA` attributes (the alarm uses `USAGE_ALARM`), so phone routing never sends it to the earpiece. No `AudioRecord` is ever started.
  - Gate A fallback, if the listen device isn't ready: the stock device with `.defaultToSpeaker` on iOS, and `setCommunicationDevice(TYPE_BUILTIN_SPEAKER)` on Android. The mic indicator is then disclosed in the TestFlight notes. Gate B does not accept the fallback.
- [ ] iOS:
  - `UIBackgroundModes: audio`; WebRTC playout continues in the background while Sound is on.
  - The alarm plays in the same `.playback` session, so it sounds with the silent switch on.
  - A state machine for interruptions, route changes and media-services resets. It re-asserts the route after each one, and reports the route (`speaker`, `headset`, `bluetooth`, `earpiece`) to readiness. If listening stops, a local notice says "Listening stopped — alerts still come by push".
  - **Never** play silence (guideline 2.5.4).
- [ ] Android: a `mediaPlayback` foreground service ("Listening to the nursery") started from the Sound on tap; the alarm on `USAGE_ALARM`; the route reported the same way.
- [ ] Sound off: the socket and peer connection close 20 s after the app goes to the background, and push takes over.
- [ ] The alarm fires on urgent events from the socket or the glance `al`, and stops on any acknowledgement.

**Done when:** XCTest and Robolectric cover the state machine and route re-assertion, and the service starts and stops on the emulator (T1). Real audio, the speaker route and the absence of a mic indicator are checked at Gate A (A5).

#### P1-WS-14 Alerts on this phone, test alert, diagnostics and Live Activity wiring
**Owns:** `apps/mobile/src/{push,diagnostics,liveActivity}/**` and `apps/mobile/app/(app)/settings/{alerts,diagnostics}.tsx`.

**Tasks:**
- [ ] Register `pushTarget()` and the Live Activity tokens (`apns-la`) through `POST /api/devices/push`:
  - on sign-in, on every token change, **on every app foreground** (throttled to once an hour unless something changed), and **whenever `nurseries:changed` fires**. Rooms store a target only for people who are members when it is registered, so a nursery joined later would otherwise never alert this phone.
- [ ] Unregister on sign-out (§0 #24):
  - `DELETE /api/devices/push` for each target;
  - then delete the push key pair, call FCM `deleteToken()` (Android) or `unregisterForRemoteNotifications()` (iOS), and end any Live Activity.
  - The provider then answers `gone` and the room prunes the target, even before the rooms understand `/x/push-unreg` (wave 3).
- [ ] "Alerts on this phone":
  - readiness, with one-tap fixes, including the audio route (an earpiece route is a red row);
  - the last delivery;
  - p50 and p95 of `recvAt − g.at`;
  - **Send test alert** (`push-test`), showing when it arrived and whether it made a sound.
- [ ] The Night report recorder and its export (§4).
- [ ] Live Activity: start when a Sound-on viewer opens, update from glance frames while the app is alive, `staleDate` now + 90 s.

**Done when:** jest covers the readiness-to-copy mapping for every row of the D2 matrix, the export, and the registration lifecycle: register, re-register on foreground and on a joined nursery, and unregister on sign-out, with the provider token gone afterwards.

#### P1-WS-15 Release pipeline and store plumbing
**Owns:** `/home/user/Comic2/.github/workflows/mobile-release-{ios,android}.yml` (new), `scripts/release/**`, `apps/mobile/store/**`.

**Tasks:**
- [ ] The build number is the run number. `assert-release-clean` runs on every artifact, which includes the no-watch-app check on Phase 1 archives. Release builds never set `DS_WATCH`.
- [ ] The upload step fails early if `Info.plist` lacks `ITSAppUsesNonExemptEncryption`, so no build sits in TestFlight as "Missing Compliance".
- [ ] iOS, in Environment `ios-release`, by `workflow_dispatch` only:
  - write the App Store Connect API key into `$RUNNER_TEMP`;
  - `xcodebuild archive` and `-exportArchive -allowProvisioningUpdates` (cloud-managed signing: no certificates stored);
  - upload to **TestFlight internal**, which has no Beta App Review;
  - delete the key in an `always()` step; never `set -x`.
- [ ] Android, in Environment `android-release`, with `id-token: write`:
  - `bundleRelease` signed with the owner's upload key;
  - `google-github-actions/auth` through WIF, then `play-upload.mjs` (Edits API) to the **internal** track.
  - The first AAB is an artifact for the owner's **manual** first upload, because the API can't upload to an app that has never had a build.
- [ ] `store/**`: the listing, review notes and Data safety answers from P1-WS-8's drafts.

**Done when:** a reviewer-approved dispatch puts a build in TestFlight internal and Play internal (needs owner actions #8–#10, #13 and #14).

#### P1-WS-16 Native sound AI (`ds-media` module definitions and audio half)
**Owns:**
- `apps/mobile/modules/ds-media/{expo-module.config.json,app.plugin.js,index.ts,src/**}`: the module scaffold, with the full JS API stubbed, camera functions included
- **The module definitions:** `ds-media/ios/{DsMediaModule.swift,DsMedia.podspec}` and `ds-media/android/{build.gradle,src/main/AndroidManifest.xml}` plus `DsMediaModule.kt`. Every function is defined here and calls classes that live in P1-WS-13's, 17's and 18's own files; each of those workstreams commits its classes as stubs on day 1. The camera service's and boot receiver's manifest entries go through P1-WS-17's `camera.plugin.ts`, not this manifest.
- `apps/mobile/modules/ds-media/{ios,android}/{AudioDevice,AudioTap,Yamnet,Level,Pipeline}.*`
- `apps/mobile/assets/models/yamnet.onnx`
- `apps/mobile/src/sound-ai/**`

**Tasks:**
- [ ] **First PR, day 1 of wave 2:** the module definitions with every function stubbed, and `AudioDevice`, the one device injected into WebRTC (iOS `WebRTCModuleOptions.audioDevice`, Android `audioDeviceModule`). It has two modes: **listen**, which delegates to P1-WS-13's `ListenDevice`, and **camera**. P1-WS-13, 17 and 18 build against this PR, and Gate A's Sound on depends on it.
- [ ] Camera mode: echo cancellation on, noise suppression and AGC **off**, plus a 16 kHz mono tap.
- [ ] YAMNet on ONNX Runtime Mobile, using the same waveform-input model the web worker runs (15,360 samples), with its SHA-256 checked at load. **fp32 on the CPU** (§0 #5, §4).
- [ ] A-weighted dB and Leq ported from `soundLevel.ts`. Scores go to the TypeScript `soundBrain` unchanged.
- [ ] Liveness (SI-3, §0 #17):
  - `src/sound-ai/` stamps the arrival time of every audio-level event and score in JS, and builds `hb` and `pipelineFresh` from those stamps.
  - The native watchdog only adds the reason (`deg:'ai'` or `'mic'`). It is never the source of `hb`.
- [ ] `__selftest/yamnet`: the golden WAVs through the native pipeline, with scores within ±0.02 of the TypeScript JSON and cry onset within 2 s. This is S8. It proves Phase 1 acceptance #7 at T1/T2, and on the owner's iPhone at Gate B (T3).
- [ ] **"Check the sound detector"** in Diagnostics (a product feature, not a test hook, so it ships). It runs three bundled golden clips (≤ 300 KB) through the same native pipeline and shows pass or fail with the largest score difference. A test-hook build can't be installed on the owner's iPhone without a Mac, so this is how acceptance #7 is proved on the hardware parents use (T3). P1-WS-14 hosts the button.
- [ ] `__selftest/audiostall`: stalls the native tap (and, separately, YAMNet) while JS keeps running, and asserts that `pipelineFresh` turns false within 5 s and `hb` grows.

**Done when:** `yamnet` and `audiostall` print `ok:true` on the emulator (T1) and the simulator (T2). A JS-freeze test stops the keepalive. The room half of `audiostall` ("can't hear" within 120 s) runs at T1 once P1-WS-19 and P1-WS-20b merge.

#### P1-WS-17 Camera mode: the screen and Android native
**Owns:** `apps/mobile/app/(app)/camera/**`, `apps/mobile/src/camera/**`, `apps/mobile/modules/ds-media/android/{CameraService,FrameTap,Thermal,BootReceiver}.kt`, `apps/mobile/plugins/camera.plugin.ts`.

**Tasks:**
- [ ] Day 1: stubs of `CameraService`, `FrameTap`, `Thermal` and `BootReceiver`, so P1-WS-16's module definitions compile.
- [ ] `camera.plugin.ts` adds the `CameraService` (`foregroundServiceType="camera|microphone"`) and `BootReceiver` entries to the app manifest.
- [ ] Reuse the web camera's logic: `CameraHub`, `statusCadence`, `eid`, `RelaySealer` (JPEG from `FrameTap` ≤ `SNAPSHOT_MAX − 64`), and `dev_hello` as a camera. In a `roster1` nursery the camera inherits P1-WS-20b's rules: it answers only verified devices with signed signaling.
- [ ] Hold the 60 s status keepalive (`statusCadence`) while `pipelineFresh` is false (SI-3). The ping gate needs `client.ts`, which is in flight, so in wave 3 P1-WS-20b adds `pingGate` and its one wiring line in `src/camera/`.
- [ ] Android service:
  - a `camera|microphone` foreground service started from the tap;
  - a persistent "Nursery camera is on" notification and a partial wake lock;
  - `AudioRecordingCallback` silencing detection (`deg:'mic'`);
  - "Tap to resume" after a reboot or an app update;
  - `ApplicationExitInfo` read at the next launch and reported (`deg:'update'`).
- [ ] Thermal (`PowerManager` status and headroom) and battery feed `videoBudget`.
- [ ] Night screen, a charging-required banner and keep-awake on both platforms.
- [ ] Hidden behind a flag until Gate B. The web camera stays the camera until then.

**Done when:** `__selftest/fgs` and S5 pass on the emulator (T1), and thermal-injection tests pass.

#### P1-WS-18 Camera mode: iOS native
**Owns:** `apps/mobile/modules/ds-media/ios/{FrameTap,Thermal,GuidedAccess,CameraState}.swift`.

**Tasks:**
- [ ] Day 1: stubs of the four classes, so P1-WS-16's module definitions compile.
- [ ] `RTCVideoRenderer` frames → JPEG.
- [ ] `thermalState` and `systemPressureState` feed `videoBudget`.
- [ ] Guided Access status and guide; idle timer off.
- [ ] Interruption handling (`deg:'mic'` and `deg:'cam'`).
- [ ] When backgrounded, audio and AI continue under the `audio` mode and the status says `interrupted`.
- [ ] Unplugged reports `chg:false`.

**Done when:** the XCTest state machines and thermal injection pass at T2.

#### Gate A checklist (on the family's devices; T3)
- [ ] A1. Both builds install from TestFlight internal and Play internal. Owner-only builds against a test nursery may come earlier (§0 #7). The family's builds use a react-native-webrtc version that is 30+ days old (124.0.8, or 155.0.0 from Nov 13; §4) and contain no watch app.
- [ ] A2. Sign-in works with password, the Turnstile check and TOTP, with Supabase CAPTCHA on. The session survives a reboot (after first unlock) and is absent from a backup.
- [ ] A3. Live video from the **web camera** on home Wi-Fi and on LTE. The relay picture shows the lock while sealed.
- [ ] A4. Phone locked, Sound off: 10 test alerts and 5 staged cries all arrive, with **p95 ≤ 5 s** on the diagnostics screen. "I'm on it" on the Lock Screen acknowledges without opening the app, and the other parent sees "X is on it".
- [ ] A5. Sound on: 1 h in the background with the silent switch on. A staged cry sounds the in-app alarm **on the loudspeaker**, the nursery audio plays on the loudspeaker, and readiness shows the route. iOS shows no microphone indicator (or, on the Gate A fallback, the indicator is disclosed).
- [ ] A6. Nights 1–3 with the old alert path on a second device, diagnostics exported each morning. Any miss is fixed before night 4.
- [ ] A7. Signing out on one phone: within a minute it stops getting test alerts, and the other parent's phone still gets them.

### 7. Wave 3 and Gate B, "Phase 1 accepted"
**Starts when** Phase 0 wave 2 has merged and deployed, so the server files and `client.ts` are free again, and the owner has approved ADR 0008, frozen with the genesis, `replace` and signed-signaling rules. The sign-in gate has already merged.

The first plan gave all of verified admission to one workstream (P1-WS-20, 36–50 h). It also had to cover `monitorRoom.ts`, the web and native admission UI, `keys.ts`/`client.ts`, the Worker's switch to monitor-core, and the adversarial and mixed-version tests, while Phase 2's Peek and Phase 3's device-token socket waited behind it. **It is now split into P1-WS-20a (the room) and P1-WS-20b (the clients)**, which work in parallel to the frozen ADR 0008.

#### P1-WS-19 Room delivery modules, UserLine and the service worker
**Owns:**
- `live-worker/src/room/{receipts,degraded,liveActivity,pushTargets}.ts` and their tests (new)
- `live-worker/src/index.ts` and its test: adds `rcpt` to the monitor routes, and carries WS-11's day-14 removal of the query-string event keys (with that one change in `eventRoom.ts`)
- `live-worker/src/userLine.ts` and its tests (wave 3 owner): `/x/push-unreg`, and `movedEnv` updates
- `public/live-sw.js` (wave 3 owner): `via:'sw'` receipts
- `server/src/services/costCentre.ts` and its test (the receipt-latency KPIs)

**Tasks:**
- [ ] Receipts (`rcpt1`): mint `rt` per (incident, device); store the first receipt.
  - **Early escalation only when the duty person has at least one target that was sent an `rt`, and none of those targets posted a receipt within 10 s** (§0 #25). Everyone else keeps today's `escalateMs`.
  - The service worker posts `POST /api/monitor/:nid/rcpt {i, rt, via:'sw'}` when a push carries `rt`, so a parent on the web counts too.
  - KPIs: receipt p50 and p95 per platform, the deprioritised count.
- [ ] Degraded pipeline (`deg1`): the warn and urgent rules in §4, **including the `hb`-only rule**: `hb.a` or `hb.y` over 30 s warns, and over 120 s is urgent, even when `deg` is empty (§0 #17).
- [ ] `pushTargets.ts`: `unregister(uid, dev, sub)` for `/x/push-unreg`, and `applyMoved(report)` for `movedEnv`.
- [ ] Live Activity pushes:
  - push-to-start when the camera turns on, and again at 7 h 50 m (on the room's existing alarm, keeping alarms ≤ 60 an hour);
  - updates on bumps at priority 5 (10 with an alert);
  - end when the camera turns off; prune `gone` targets.
- [ ] Every module exposes plain functions with the signatures in §4. P1-WS-20a adds their call sites in `monitorRoom.ts`.

**Done when:**
- vitest covers each module with fake APNs and FCM.
- Tests cover the escalation rule both ways:
  - a duty parent on web push alone, or on a build without receipts, isn't escalated early;
  - a duty parent whose `rt` targets all stay silent is escalated at 10 s.
- UserLine drops a target on `/x/push-unreg`.
- The night simulation stays within Phase 0's budgets: billed requests ≤ 1,000, rows ≤ 1,800, ≤ 40 GB-s.

#### P1-WS-20a Verified admission in the room (owner of `monitorRoom.ts` in wave 3)
**Owns:** `live-worker/src/{monitorRoom,monitorStore}.ts`, `live-worker/src/room/{rosterLog,roster}.ts` and their tests, and `monitorRoom*.test.ts`.

**Tasks:**
- [ ] First PR, half a day: the Worker imports monitor-core `protocol.ts`, ending the hand-kept mirror (D2).
- [ ] The append-only roster log (ADR 0008), stored by the room, which never signs anything:
  - store and serve `genesis`, `add`, `remove`, `role` and `replace`, checking each signature and chain link;
  - **list `roster1` per nursery only once its genesis is stored**;
  - `admit_req`, which pushes parents an Approve;
  - `key_req` goes only to holders for verified entries;
  - socket auth checks the device signature over `hello.nonce`.
- [ ] Recovery stays harmless: "start a new key epoch" from any parent device.
- [ ] Call sites for P1-WS-19's modules, including `/x/push-unreg` and `movedEnv`.
- [ ] Tell the room when a nursery is deleted (WS-9 follow-up: its members could otherwise reconnect from the role cache for up to 6 h).
- [ ] The test "Supabase down 1 h overnight: the camera stays on air, alerts flow, a revoked device is still refused".

**Done when:**
- Roster fixtures pass in vitest.
- A room without genesis behaves exactly as Phase 0.
- An older client works in mixed versions.
- The night simulation stays within Phase 0's budgets.

#### P1-WS-20b Verified admission in the clients: web and native
**Owns:**
- `live/monitor/{keys,client,rtc}.ts` and their tests (`rtc.ts` in full from wave 3; P1-WS-2's import lines have merged by then)
- `live/views/{MonitorCamera,MonitorViewer}.tsx`
- `live/views/monitor/{PeopleCard,NurserySettings,AdmitDevice,GenesisReview}.tsx`
- `apps/mobile/src/admission/**`, `apps/mobile/app/(app)/approve/**`, and the one `pingGate` wiring line in `apps/mobile/src/camera/`

**Tasks:**
- [ ] `keys.ts`: verify the roster chain before any wrap or unwrap; wrap only to verified entries; sign `genesis`, `add`, `role`, `remove` and `replace`.
- [ ] **Genesis** (§0 #20). The first parent device online with this code builds the genesis from `mon_devices` and shows the review screen: "These devices can watch Maya's room", with Remove beside each. Every other parent sees the same list on their next open.
- [ ] **`replace`.** A Gate A phone, or any device whose keys move, signs its move with the old key. No SAS.
- [ ] SAS approval on both screens, for a parent's own new device and, until 1.1, for a guest's or new member's device, after an Approve push or from Nursery settings.
- [ ] **Signaling in a `roster1` nursery** (§0 #15):
  - `CameraHub` takes an offer, a candidate or a bye only from a verified entry with a valid `s`. `nk:1` and `plainOk` no longer open a call for a socket outside the roster.
  - `ViewerLink` signs everything. After `KEY_FALLBACK_MS` without a wrap, it calls signed-only, never unsigned. The relay picture stays off, and the pill says "Waiting for the family key".
  - A device outside the roster shows "Ask a parent to approve this device" and sends `admit_req`.
  - Before genesis, Phase 0's behaviour is unchanged.
- [ ] `client.ts` `pingGate?: () => boolean` (§0 #17); the native camera wires it to `pipelineFresh`.

**Done when:**
- **Adversarial tests**, run against the real `keys.ts`/`rtc.ts` and a hostile room:
  - (a) a server-injected phantom device never receives an NMK wrap;
  - (b) a phantom that sends `nk:1`, an unsigned offer or a forged `s` gets no answer and no media from the camera;
  - (c) with the server withholding every wrap, the viewer's call is signed-only, a fingerprint swapped by the server makes the call fail rather than connect to the server, and no unsigned offer ever leaves the viewer.
- **Upgrade test.** A Phase 0 nursery with a web viewer, a Gate A phone and a camera goes through genesis, a hardware `replace` and a rotation, and every device still opens frames.
- With `pingGate` false, no ping leaves the socket.
- Roster fixtures pass in vitest, XCTest and JUnit.
- No path leaves an admitted device without a key or the honest, signed fallback (SI-6).

#### P1-WS-21 Hardware keys and attestation
**Owns:**
- `apps/mobile/modules/ds-keys/**` (including its `app.plugin.js`: the App Attest entitlement) and `apps/mobile/src/keys/hardware.ts`
- `apps/mobile/src/boot/{globals,subtle}.ts` (wave 3 owner; P1-WS-5 wrote them)
- `live-worker/src/devices.ts` and `devices.test.ts` (wave 3 owner)
- `live-worker/src/auth/attest/**` (new)

**Tasks:**
- [ ] Secure Enclave P-256 for signing and ECDH. Android Keystore, with StrongBox where present; on API 29–30, the wrapped software ECDH key, labelled.
- [ ] The `KeyStore` swaps to hardware handles behind P1-WS-5's interface. `registerHandleCrypto()` sends `sign` and `deriveBits` on those handles to `ds-keys`. The move is a roster `replace` signed by the old key.
- [ ] Phones enrol through `POST /api/devices/enroll`, so they show in "Your devices".
- [ ] **iOS: bind, don't infer** (§0 #19). The enrolment carries an App Attest attestation (the first time) or assertion (later) over `clientDataHash` = SHA-256(`devId`‖`sigPub`‖`ecdhPub`). The Worker verifies the CBOR attestation (or the assertion counter) and records provenance `ios-se-app-attested`, never a bare `hw:true`.
- [ ] Android: the Worker verifies the Key Attestation chain of the signing and ECDH keys themselves and records `android-keystore-attested` or `android-strongbox-attested`.

**Done when:** tests pass on recorded attestation fixtures (iOS attestation and assertion, Android chains with and without StrongBox) and on an API 29 emulator (T1). Hardware is checked at Gate B.

#### P1-WS-22 Gate B kit, store submission and the web deletion button
**Owns:**
- `apps/mobile/maestro/**` (beyond the flows named by P1-WS-5, 7 and 12) and `apps/mobile/store/**` (wave 3 owner)
- `docs/features/native-apps.md` and `docs/qa/native-night-drills.md` (wave 3 owner)
- `live/views/SettingsView.tsx` (the Delete account button only)

**Tasks:**
- [ ] The soak protocol, the Live Activity 8 h check, TTFF runs on LTE, and the p95 report from diagnostics and receipts.
- [ ] "Check the sound detector" on the owner's iPhone (from a TestFlight build), filed as the evidence for acceptance #7 (§0 #5).
- [ ] App Review submission with notes and video; a TestFlight external group; the Play closed-testing track. Every archive passes `assert-release-clean`, so it contains no watch app.
- [ ] Web deletion button and page link.

**Done when:** the Gate B evidence is filed and the submissions are in.

#### Gate B checklist = the Phase 1 acceptance criteria above, plus safety
- [ ] #1–#8 of Phase 1's acceptance criteria, each ticked from its tier:
  - CI: #1 (as reworded, §9 step 8), the phantom and adversarial tests, and the upgrade test;
  - the owner's iPhone: #7 parity;
  - devices: the rest.
- [ ] Drills D1–D9 recorded in `docs/qa/native-night-drills.md`:
  - D1: 50 urgent pushes per platform, locked, on Wi-Fi and LTE.
  - D2: the ring/silent × Focus × Sound on/off matrix (Android: DND × bypass × cooldown).
  - D3: fault drills:
    - call the camera phone, play music on it, home button and lock, unplug, force-quit, airplane mode, router reboot;
    - Siri or a call on the Sound-on phone, then check that Sound on is back on the speaker;
    - a reboot without unlocking;
    - **a parent signs in on a new device and the camera stays on air**;
    - **stall the camera's audio** (the `audiostall` hook on a sideloaded Android CI build; iOS is covered at T2) and see "can't hear" within 120 s.
  - D4: two 10 h soaks per platform.
  - D5: an old spare phone (Android 10/11, iOS 17/18 class).
  - D6: an OEM battery killer (a Samsung, if available).
  - D7: AlarmKit, if S9 runs.
  - D8: an update installed overnight.
  - D9: review.
- [ ] Receipt p95 ≤ 5 s per platform over at least 200 beta alerts, with a deprioritised count of 0.
- [ ] A `BadDeviceToken` from an environment mismatch never prunes a valid token.
- [ ] Account deletion works in the app and on the web, with and without two-step sign-in.
- [ ] The family nursery's genesis is signed, and every device the family uses is in its roster with hardware provenance.
- [ ] Release archives contain no watch app and declare export compliance.

### 8. File ownership matrix (no file appears twice within a wave)

| Path | Wave 1 | Wave 2 | Wave 3 |
|---|---|---|---|
| `apps/mobile/{package.json, package-lock.json, app.config.ts, babel, metro, jest, tsconfig, index.ts}`, `app/_layout.tsx`, `app/index.tsx`, `plugins/base.plugin.ts`, `__tests__/prebuild/**`; `scripts/ci/assert-release-clean.mjs`, `scripts/dev/**`; `mobile-{core,android,ios,ios-quick,canary}.yml`, `.github/actions/**`; the dependabot and CODEOWNERS entries; the `apps` exclude line in the root `tsconfig.json` (not `vite.config.ts`); `docs/infrastructure/mobile-ci.md` | P1-WS-1 | P1-WS-1 stays owner (dependency PRs only) | same |
| `packages/monitor-core/src/{moved files incl. cryDetector, rtcPolicy, pipeline, wire, index}.ts`, `package.json`, `scripts/gen-fixtures.ts`, `fixtures/{sound,presentation}/**`; the shims in `live/monitor/*` and `live/calls/types.ts`; the import and `LinkState` lines in `live/monitor/rtc.ts` | P1-WS-2 | — | — (`rtc.ts`: P1-WS-20b) |
| `packages/DreamCoreSwift/**`, `apps/mobile/targets/_shared/**` | P1-WS-3 | — | — |
| `packages/glance-kotlin/**` | P1-WS-4 | — | — |
| `apps/mobile/metro.resolve.js`, `src/{boot,shims,keys,rtc,selftest}/**`, `app/__selftest.tsx`, `modules/ds-testhooks/**`, `maestro/{loopback,selftest}.yaml` | P1-WS-5 | — | — (P1-WS-21 takes `src/boot/{globals,subtle}.ts` and adds `src/keys/hardware.ts`) |
| `apps/mobile/modules/ds-alerts/**`, `targets/notification-service/**` | P1-WS-6 | — | — |
| `apps/mobile/src/{account,turnstile}/**`, `app/(auth)/**`, `app/(app)/settings/account.tsx`, `maestro/signin.yaml`, `public/turnstile-native.html` | P1-WS-7 | — | — |
| `packages/monitor-core/src/roster*.ts`, `fixtures/roster/**`, `docs/decisions/0008-*.md` and its README row, `docs/release/**`, `docs/infrastructure/phase1-owner-checklist.md` | P1-WS-8 | — | — |
| `docs/features/native-apps.md`, `docs/qa/native-night-drills.md` | P1-WS-8 (S1 section: P1-WS-5) | — | P1-WS-22 |
| `live-worker/src/push/{router,apns}.ts` (+ tests), the `PUSH_TEST_RL` stanza in `live-worker/wrangler.jsonc`, `apps/mobile/e2e/**`, `mobile-localstack.yml` | P1-WS-9 | — | — |
| `live-worker/src/devices.ts` (+ test) | P1-WS-9 (`push-test` and `DELETE push` only) | — | P1-WS-21 |
| `server/sql/live_account_delete.sql`, `server/src/routes/accountDelete.ts` (+ test) and its line in `server/src/index.ts`, `public/account-deletion.html` | P1-WS-10 | — | — |
| `apps/mobile/targets/{widget,watch,watch-widget}/**`, `packages/DreamUISwift/**`, `apps/mobile/modules/ds-watch/**` | P1-WS-11 | — | — (Phase 2 takes the watch targets and `ds-watch`) |
| `live/account.ts` (`signIn`, `confirmPassword`), `live/components/AuthSheet.tsx`, `live/views/account/SignInGate.tsx` (branched from `3cab98a8`+) | P1-WS-23 | — | — |
| `apps/mobile/app/(app)/{_layout.tsx,nurseries.tsx,viewer/**,inbox.tsx}`, `src/{viewer,inbox,status}/**`, `plugins/viewer.plugin.ts`, `maestro/viewer.yaml` | — | P1-WS-12 | — |
| `apps/mobile/modules/ds-listen/**`, `ds-media/{ios,android}/ListenDevice.*`, `src/sound/**` | — | P1-WS-13 | — |
| `apps/mobile/src/{push,diagnostics,liveActivity}/**`, `app/(app)/settings/{alerts,diagnostics}.tsx` | — | P1-WS-14 | — |
| `mobile-release-{ios,android}.yml`, `scripts/release/**` | — | P1-WS-15 | — |
| `apps/mobile/store/**` | — | P1-WS-15 | P1-WS-22 |
| `apps/mobile/modules/ds-media/{expo-module.config.json,app.plugin.js,index.ts,src/**}`, the module definitions (`ios/{DsMediaModule.swift,DsMedia.podspec}`, `android/{build.gradle,src/main/AndroidManifest.xml}`, `DsMediaModule.kt`), `ds-media/*/{AudioDevice,AudioTap,Yamnet,Level,Pipeline}.*`, `assets/models/**`, `src/sound-ai/**` | — | P1-WS-16 | — |
| `apps/mobile/app/(app)/camera/**`, `src/camera/**`, `ds-media/android/{CameraService,FrameTap,Thermal,BootReceiver}.kt`, `plugins/camera.plugin.ts` | — | P1-WS-17 | — (P1-WS-20b: the one `pingGate` line in `src/camera/`) |
| `ds-media/ios/{FrameTap,Thermal,GuidedAccess,CameraState}.swift` | — | P1-WS-18 | — |
| `live-worker/src/room/{receipts,degraded,liveActivity,pushTargets}.ts`, `live-worker/src/index.ts`, `userLine.ts`, `public/live-sw.js`, `server/src/services/costCentre.ts` (+ tests) | — (in flight / free) | — | P1-WS-19 |
| `live-worker/src/{monitorRoom,monitorStore}.ts`, `room/{rosterLog,roster}.ts`, `monitorRoom*.test.ts` | — (in flight) | — | P1-WS-20a |
| `live/monitor/{keys,client,rtc}.ts`, `live/views/{MonitorCamera,MonitorViewer}.tsx`, `live/views/monitor/{PeopleCard,NurserySettings,AdmitDevice,GenesisReview}.tsx`, `apps/mobile/src/admission/**`, `app/(app)/approve/**` | — (`client.ts` in flight) | — | P1-WS-20b |
| `apps/mobile/modules/ds-keys/**`, `src/keys/hardware.ts`, `src/boot/{globals,subtle}.ts`, `live-worker/src/auth/attest/**` | — | — | P1-WS-21 |
| `apps/mobile/maestro/**` (others), `live/views/SettingsView.tsx` (deletion button) | — | — | P1-WS-22 |
| **Never before their branches merge:** `live/{LiveApp.tsx,api.ts,nav.ts,eventTicket.ts}`, `live/monitor/{client.ts,socket.unit.test.ts}`, `live/views/DashboardView.tsx`, `live-worker/src/{monitorRoom,monitorStore,userLine,callRoom,directCalls,eventRoom,eventKeys,index,members,watchGate}.ts`, `live-worker/src/room/**`, `docs/features/baby-monitor.md`, this ADR file; and, from the Comic Studio v5 branch, `vite.config.ts`, `package.json`, `server/src/routes/account.ts`, `live/views/monitor/InviteSheet.test.tsx`, `.github/workflows/{ci,deploy-*}.yml` | — | — | Wave 3 takes the rows above only after the branches merge |

### 9. Merge and release order
1. **Day 1.** P1-WS-1's workflow skeleton merges first, so every other PR gets CI; the owner reviews the workflow files in one batched PR (CODEOWNERS). Then wave 1 merges in any order once green.
   - None of it changes production behaviour. `apps/` isn't deployed. The monitor-core shims leave the web build identical. The router retry, `push-test` and `DELETE push` deploy with the next live Worker deploy and stay dormant until the APNs/FCM secrets exist. The deletion route deploys with the backend, with no button yet.
   - **P1-WS-23 deploys with the next Pages build. Only then does the owner turn on Supabase CAPTCHA** (Phase 0 step #3); the Phase 0 checklist says so.
2. **Owner, today:** S0, the store enrolments, Firebase, the Environments and the devices (§10).
3. **Phase 0 wave 2 merges and deploys** (other sessions; the sign-in gate already has, `3cab98a8`).
   - The owner applies `live_security_v2.sql` and the Phase 0 secrets (#4, #5).
   - The 7-day KPI window starts (Phase 0 §5 step 5).
4. **Wave 2 merges** as each workstream goes green. P1-WS-16's module-definition PR goes first.
   - The owner sideloads the Android debug APK (S6) as soon as the viewer and alerts merge.
   - TestFlight internal (S7) follows once the Apple account and #9/#10 exist. Both run against a test nursery.
5. **Gate A nights 1–3** on the family's nursery, after the 7-day window passes, on a react-native-webrtc build that is 30+ days old (§4). If Apple enrolment lags, Android goes first.
6. **Wave 3,** once the owner has approved ADR 0008.
   - P1-WS-20a's mirror PR goes first.
   - Then P1-WS-19, P1-WS-20a, P1-WS-20b and P1-WS-21 merge, and the Worker deploys with `rcpt1` and `deg1` listed.
   - `roster1` appears nursery by nursery, as each signs its genesis. Web verified admission turns on in the same way.
7. **Gate B** on the owner's devices. TestFlight external, the Play closed test and App Review run in parallel.
   - The react-native-webrtc pin is decided on or after 2026-11-19: 155.0.1 if it passed, otherwise 155.0.0 or 124.0.8.
8. **One ADR PR** once the file is free:
   - the Phase 1 ticks;
   - notes on D1 (YAMNet at fp32 on the CPU, not the Core ML GPU/Neural Engine), D2 (`cryDetector` moved; stateful modules move in 1.1), D7 (VP8 on the emulator) and D9 #14 (the runner, if S1 changed it);
   - **acceptance criterion #1 reworded:** "Every PR runs monitor-core, jest and Robolectric. Every PR touching mobile code or the web files the app compiles runs the emulator WebRTC loopback. PRs that change the iOS fingerprint, or carry the `mobile-ios` label, run the iOS simulator build and XCTest, and every iOS check runs nightly. The release workflow uploads to TestFlight and Play internal only from protected Environments";
   - **D6.4 reworded:** "Our servers cannot add a device…" is true from Gate B for nurseries whose roster genesis is signed. The hardware-keys row reads "keys made in your phone's secure hardware by a verified copy of our app (iPhone); hardware-attested keys (Android)";
   - D6.3 path (c) notes that, until 1.1, guests and new members are admitted by a parent's approval with a SAS;
   - the Phase 0 §5 step 5 amendment;
   - the D3 probe result.
9. **Phase 1.1** (§11).

### 10. Owner actions for Phase 1 (lead times decide the calendar)

| When | Action (ADR owner action #) | Your time | Lead time | Unblocks |
|---|---|---|---|---|
| **Today** | Run the **APNs HTTP/2 probe** workflow (Actions → "APNs HTTP/2 probe" → Run) and paste the line under D3 | 10 min | none | S0: direct APNs or FCM-for-iOS |
| **Today** | **Apple Developer Program** (#2). If the D-U-N-S number isn't in hand, enrol as an **Individual** now: Organization needs D-U-N-S (Apple says up to 5 business days) plus Apple's review, which 2026 forum reports put at 1–3+ weeks. Converting later goes through Apple Support, and the Team ID isn't guaranteed to survive. **Don't convert Individual → Organization during the Phase 1–3 betas.** A developer reported in August 2026 that a pending migration blocked new TestFlight uploads for more than a month ([Apple forums 840600](https://developer.apple.com/forums/thread/840600)), which would block safety fixes mid-beta. Convert between phases, or enrol as an Organization from the start if the D-U-N-S number arrives first | 30 min | 1 day – 3 weeks | Everything iOS: TestFlight, APNs key, entitlements. **The critical path** |
| **Today** | **Google Play Console** (#2): create the app, turn on Play App Signing, set up the internal track with the family's emails. A personal account must also recruit **12 testers for 14 days** before production (not before internal testing) | 30 min | days | Android Gate A; production later |
| **Today** | **Firebase** (#13, free Spark plan): Android app, a service account with only the FCM sender role → `FCM_SA_JSON`; `google-services.json` into `android-release`, plus a debug copy | 30 min | none | S6, Android push |
| **Today** | Finish Phase 0's steps #3–#5 (`docs/infrastructure/phase0-owner-checklist.md`), **with two exceptions**: (a) leave Supabase **CAPTCHA off until P1-WS-23 has deployed**, because Stream Studio's web sign-in doesn't send a token yet and every Stream Studio sign-in, camera phones included, would fail (if it is already on, turn it off until then); (b) if you take Supabase Pro, leave **single session, time-box and inactivity timeout off** while any camera signs in with a parent account (until QR camera pairing, 1.1), or a parent signing in elsewhere, or the night itself, takes the camera off the air | 1 h | none | `/act`, `/glance`, push in production |
| **After P1-WS-23 deploys (~Oct 31)** | Turn on Supabase CAPTCHA (Turnstile), then sign in on `stream.dreamstreamstudio.ai` and `dreamstreamstudio.ai` to check. Confirm `dreamstreamstudio.ai` is in the Turnstile widget's hostname list (Cloudflare → Turnstile → the widget → Hostname Management), which the native app's Turnstile page uses | 10 min | none | Phase 0 step #3; native sign-in (Gate A A2) |
| **Today** | GitHub (#7): Environments `ios-release` and `android-release` (you as required reviewer, branch `Dreamstrream-v1` only); approval for fork PRs; review the batched workflow PR | 20 min | none | CI and releases |
| **This week** | **Devices** (#16): an Android 14+ phone (a Pixel is best; a Samsung too for the battery-killer drill), your iPhone on iOS 26, a spare iPhone on iOS 17.2+ and a spare Android as native cameras. By ~Nov 24: an Apple Watch Series 9+ or Ultra 2, and a Wear OS 5+ watch | purchase | delivery | Gate A, Gate B, Phases 2–3 |
| **Once Apple approves** | Identifiers, App Group, keychain group, capabilities (#8); APNs `.p8` → `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID` (#9); App Store Connect API key (Admin for the first certificate, then App Manager) → `ios-release` (#10); the Team ID into the `APPLE_TEAM_ID` variable; request **Critical Alerts** (#11, plan as denied) and **Local Push Connectivity** (#12, for Phase 4: weeks) | 1 h | entitlements: weeks | iOS builds, iOS push |
| **Before Android release** | Upload key made on your own machine → `android-release`; WIF for the Play Developer API; the **first AAB uploaded by hand** from the CI artifact; SHA-256 fingerprints to us (#14, #15) | 30 min | none | Play internal |
| **Before Play review** | Data safety, content rating, foreground-service declarations with demo videos: mediaPlayback for Gate A, camera and microphone for Gate B (#14) | 1 h | review: days | Play tracks |
| **Before the first TestFlight upload** | **Export compliance.** The app ships its own encryption (WebRTC's BoringSSL, quick-crypto's OpenSSL, the AES-GCM/ECDH end-to-end layer), not only Apple's. Answer App Store Connect's encryption questions once. The likely answer is standard algorithms under the mass-market exemption, which in the US means an annual self-classification report to BIS, due Feb 1. Decide whether to distribute in France, which has its own declaration. P1-WS-1 then sets `ITSAppUsesNonExemptEncryption` to match, so CI uploads don't stall as "Missing Compliance". (This is the plan's reading, not legal advice; check with counsel if unsure.) | 30 min | none | Every TestFlight build |
| **Before TestFlight external** | **App Privacy** labels (from P1-WS-8's draft: email, user ID, device ID and diagnostics, none used for tracking) and the **age-rating** questionnaire, both in App Store Connect | 30 min | none | TestFlight external, App Review |
| **When asked** | Apply `server/sql/live_account_delete.sql`; approve ADR 0008 (**before wave 3 starts, ~Nov 10**: genesis, `replace`, signed signaling and parent approval of guests), the store copy, the App Review notes and video, the privacy policy paragraph (#18), and the §0 #7 amendment | 1 h | none | Waves 1 and 3 |
| **Gate A** | Three nights with the old alert path on a second device; "Send test alert" before bed; export diagnostics each morning; report any miss at once | 15 min a night | — | Gate A |
| **Gate B** | Sign the family nursery's roster genesis from your phone and check the device list. Run Diagnostics → "Check the sound detector" on your iPhone. Drills D1–D9: about 4 short evenings and 5 nights (≈ 15 min to set up each, plus a morning readout). Keep the demo camera on air during App Review (48–72 h) | ≈ 11–15 h over 2 weeks | — | Phase 1 accepted |
| **By ~Dec 1** | Recruit 5 parents for the moderated 3-second watch test (#17) | — | recruiting | Phase 2 |

### 11. Estimate (AI build)

Agent-hours are focused engineering time, including CI round trips and one review-fix round per workstream (as Phase 0 needed). The calendar assumes 6–8 agents in parallel, which finish about 20–30 agent-hours of merged work a day once CI waits and reviews are counted. An iOS CI loop takes 15–40 minutes, and the repo shares 5 macOS slots, so each agent gets roughly 6–10 iOS iterations a day. More than about 8 agents doesn't shorten anything: the macOS slots, the owner's nights and App Review set the pace.

**The end dates are set by Apple enrolment, devices, the owner's nights and App Review, not by engineering.** Each week the Apple account slips moves the iOS dates by about a week.

*Revised 2026-10-29 after the review: Phase 1 was 425–645 h and is now 580–890 h. The two big moves are Phase 1.1 (40–60 → 125–205 h, now costed item by item) and verified admission (36–50 → 64–95 h, split into a room half and a client half). The review's other fixes add about 40–60 h across waves 1–3 and Gate B.*

| Item | What it delivers | Agent work (h) | Calendar (from Thu 2026-10-29) | Gated by |
|---|---|---|---|---|
| Wave 1 (P1-WS-1–11, 23) | CI on every PR (the emulator loopback on web-path PRs too); app shell; Swift and Kotlin cores; the alert path; account with Turnstile; roster contract with migration rules; push hardening and unregister; local Worker harness; account deletion (server); **Stream Studio's web sign-in captcha** | 157–231 | Oct 29 – ~Nov 6 (P1-WS-23 by ~Oct 31) | Nothing (the owner reviews the workflow PR) |
| Wave 2 (P1-WS-12–18) | The Gate A app: viewer, Sound on with the listen device on the speaker, alerts on this phone with register and unregister, release pipeline. The native camera and YAMNet (fp32) built and tested, not shipped; "Check the sound detector" | 141–211 | ~Nov 3 – ~Nov 15 | Wave 1 merges |
| Gate A, "First Night" | The native parent app on a real night, with the web camera | 10–20 (fixes) | Owner-only builds ~Nov 7–12; family nights ~Nov 13–19 (Android may go first) | Phase 0 wave 2 deployed plus 7 clean KPI days; owner SQL and secrets; CAPTCHA on after P1-WS-23; APNs/FCM keys; Apple and Play accounts; react-native-webrtc 155.0.0 qualifies Nov 13 (124.0.8 before) |
| Wave 3 (P1-WS-19, 20a, 20b, 21, 22) | Receipts with the fair escalation rule, degraded-pipeline alerts, Live Activity pushes, push unregister on the server, verified admission (genesis, `replace`, signed signaling, parent approval), `pingGate`, hardware keys bound by attestation, the Gate B kit | 120–180 | ~Nov 10 – ~Nov 25 | Phase 0 wave 2 merged and deployed; ADR 0008 approved |
| Gate B, "Phase 1 accepted" | All eight Phase 1 acceptance criteria and the safety additions | 25–45 (fixes) | Device runs ~Nov 23 – Dec 6; App Review ~Nov 30 – Dec 12; **accepted ~Dec 4–15** | Owner devices and nights; the webrtc 30-day rule (Nov 19); App Review 1–3 days (+3–5 if rejected once); TestFlight external and Play closed-test reviews |
| *Phase 1 to Gate B* | | *≈ 455–690* | *~5–7 weeks* | |
| Phase 1.1 (itemised below) | Everything §0 #8 deferred, CallKit included | 125–205 | Engineering from ~Dec 1, when wave 3's agents are free; **lands ~Dec 22 – Jan 8**, risk-adjusted mid-January | Gate B; the Team ID and SHA-256 fingerprints; the `voip` background mode; App Review over the holidays |
| **Phase 1 total** | | **≈ 580–890** | **Gate B ~Dec 4–15; 1.1 by ~Jan 8 (the ADR said 10 weeks: ~Jan 7)** | |
| Phase 2, Apple Watch | See the outline below | 110–170 | UI from wave 1; integration from ~Nov 16; Peek after P1-WS-20a (~Nov 25); **done ~Dec 18–30**, risk-adjusted mid-January | Gate A on iPhone; a Series 9+/Ultra 2; 5 parents; App Review over the holidays |
| Phase 3, Wear OS | See the outline below | 80–130 | Skeleton from today; the device-token socket after P1-WS-20a; **done ~Dec 10–22**, risk-adjusted early January | Android push at Gate A; Firebase; a Wear OS 5+ watch; Play Wear review |
| **Phases 1–3, with 1.1** | iOS and Android apps, Apple Watch and Wear OS in testers' hands | **≈ 770–1,190** | **Late December 2026; risk-adjusted ~Jan 15, 2027** | Apple enrolment, devices, owner nights, App Review |
| Phase 4, LAN hub | As in the roadmap: the local toggle, alerts with the internet down | 120–200 | After Gate B; ~late January – February 2027, risk-adjusted early March | The Local Push Connectivity entitlement (weeks); Gate B's native camera |
| **Everything the owner asked for (Phases 1–4)** | | **≈ 890–1,390** | **~February 2027; risk-adjusted early March 2027** | As above |

Per workstream (agent-hours):
- **Wave 1:** P1-WS-1 16–23, P1-WS-2 10–15, P1-WS-3 14–20, P1-WS-4 8–12, P1-WS-5 19–29, P1-WS-6 22–32, P1-WS-7 14–20, P1-WS-8 15–22, P1-WS-9 12–18, P1-WS-10 9–13, P1-WS-11 15–21, P1-WS-23 3–6.
- **Wave 2:** P1-WS-12 26–38, P1-WS-13 19–27, P1-WS-14 18–27, P1-WS-15 10–16, P1-WS-16 34–54 (the long pole), P1-WS-17 20–28, P1-WS-18 14–21.
- **Wave 3:** P1-WS-19 24–36, P1-WS-20a 30–45, P1-WS-20b 34–50 (wave 3's critical path), P1-WS-21 22–33, P1-WS-22 10–16.
- **Phase 1.1**, by item:

  | Item | h |
  |---|---|
  | QR camera pairing: a camera principal in the room, `devices.ts` and the camera; no account on the spare phone | 14–22 |
  | Single-use, device-bound per-guest invites with app links (AASA, `assetlinks.json`), the invite secret in the fragment, auto-signing by a parent device or the camera | 16–24 |
  | **CallKit/PushKit and Android Telecom**: iOS terminates an app that doesn't report every VoIP push to CallKit, so this needs its own tests and a device matrix | 20–32 |
  | App Attest / Play Integrity as a risk signal at sign-in and enrolment, including the Play Integrity verdict API | 8–14 |
  | Talk: a mic audio device with echo control, which moves the listen device to `playAndRecord` + `.defaultToSpeaker` | 10–16 |
  | PiP (iOS sample-buffer PiP; Android PiP) | 8–14 |
  | Biometric lock | 3–5 |
  | Passkeys behind a flag | 6–10 |
  | Android Live Update | 4–8 |
  | Native Devices and Security screens | 8–12 |
  | The family Night check | 4–8 |
  | Stateful modules (`client`, `keys`, `rtc`, `relayCrypto`) into monitor-core, with their browser imports injected | 12–20 |
  | The DOM long tail (tracker, reports, people, guides) as Expo DOM components | 12–20 |
  | **Total** | **125–205** |

Owner time: about 7–9 hours of console work in the first two weeks (now including export compliance, App Privacy, the age rating and the CAPTCHA switch), ADR 0008's approval by ~Nov 10, three Gate A nights, about 11–15 hours of Gate B drills (mostly while asleep), and the 3-second test sessions.

**What shortens the calendar** (none of it is engineering):
1. Apple enrolment today. It is the critical path for everything on iOS.
2. Phase 0 wave 2 merged and deployed. It starts both the 7-day KPI window that Gate A waits for and wave 3.
3. ADR 0008 approved by ~Nov 10. Wave 3 can't start without it.
4. The devices ordered this week.
5. Answering export compliance before the first upload, so no build waits in TestFlight.

**Can start today without touching any file Phase 0 wave 2 or the Comic Studio v5 branch is changing** (re-checked with `git diff --name-only` against `f67a1150` after the review; the sign-in gate has merged):
1. All of wave 1, P1-WS-1 to P1-WS-11 and P1-WS-23. They touch:
   - new paths: `apps/mobile/**` (including `modules/ds-watch`), `packages/{DreamCoreSwift,DreamUISwift,glance-kotlin}/**`, new workflows and actions, `scripts/dev/**`, new docs, `public/turnstile-native.html`;
   - `packages/monitor-core/**` and the `live/monitor` shims (now including `cryDetector.ts`), plus `rtc.ts`'s import and `LinkState` lines. No in-flight branch touches them. `client.ts` *is* in flight (`impl/p0-ws9`), so nothing in wave 1 edits it;
   - `live-worker/src/push/{router,apns}.ts`, `devices.ts` and one new stanza in `live-worker/wrangler.jsonc`, which no in-flight branch touches;
   - the backend's deletion route, with one `app.use` line beside `/api/account`, away from the v5 branch's edit;
   - one exclude line in the root `tsconfig.json` (not `vite.config.ts`, which the v5 branch edits);
   - P1-WS-23's `live/account.ts`, `AuthSheet.tsx` and `SignInGate.tsx`, free since the sign-in gate merged (branch from `3cab98a8` or later).
2. Phase 2 wave 1 (watch views and snapshots, in `packages/DreamUISwift`, built with `DS_WATCH=1`) and Phase 3 wave 1 (`apps/wearos`). Both are new paths.
3. Wave 2's sound AI (P1-WS-16) and camera mode (P1-WS-17, P1-WS-18) can begin on day 2, as soon as P1-WS-1's dependency set lands, because they need no server work. P1-WS-16's module-definition PR goes first.

**Waits for the in-flight branches:** the Worker's switch to monitor-core; everything that edits `monitorRoom.ts`, `index.ts`, `userLine.ts`, `room/**` or `client.ts` (P1-WS-19, P1-WS-20a, P1-WS-20b), and with them `pingGate`, the signed-signaling rules and the web admission UI; and the web deletion button.

## Phase 2 and Phase 3 outline

### Phase 2: Apple Watch (2.0; 2.1 Listen/Talk/Log; 2.2 direct-to-watch push)
- **Wave 1: CI only, can start today** (in `packages/DreamUISwift`, alongside P1-WS-11). The watch targets build only with `DS_WATCH=1` until Phase 2 is approved, so no Phase 1 release carries an empty watch app.
  - Watch pages: Home (calm and alert takeover), Tonight, Peek, Soothe.
  - Complications: `accessoryCircular`, `accessoryCorner`, `accessoryRectangular`, `accessoryInline` with `AppIntentConfiguration`.
  - The haptic ladder (DreamCore, fake clock); VoiceOver labels from `presentation/mood.json`.
  - The full snapshot matrix: 8 moods × {41, 45/46, 49 mm} × {active, luminance-reduced} × {default, accessibility Dynamic Type}, on the iOS host at T2, plus the watchOS `ImageRenderer` smoke.
  - The static check plus an `nm` symbol check on the watch binary that nothing links `URLSessionWebSocketTask` or `nw_connection`.
- **Wave 2: after Gate A on iPhone ("push + Glance on iPhone").**
  - `ds-watch` WatchConnectivity (`sendMessage` wakes the phone; `applicationContext["g"]`).
  - `ds-watch` replaces P1-WS-11's stub.
  - Pairing: the watch's P-256 key goes over WatchConnectivity (admission path (b)). The phone signs its roster `add` entry, then `/api/devices/enroll`, the grant and the NMK wrap.
  - The watch's own `GET /glance` with DS-Proof, polled every 3 s while active.
  - The custom long look with "I'm on it" first (double tap through `primaryAction`).
  - Peek: the room's `/peek` (now 501) returns an NMK-sealed 240 px JPEG ≤ 16 KB. This edits `monitorRoom.ts`, so it is sequenced after P1-WS-20a.
  - Paired iPhone and Watch simulators exercise WatchConnectivity and pairing (T2).
- **Wave 3: devices (T3).**
  - The moderated 3-second test with 5 parents.
  - Cold open ≤ 1.0 s with the iPhone near and ≤ 2.5 s on Wi-Fi only.
  - Wrist alert p95 ≤ 6 s; double tap round trip ≤ 2 s.
  - The networking check with the iPhone's Bluetooth and Wi-Fi off.
  - Battery ≤ 10% over an 8 h night.
  - App Review.
- **2.1** starts with a hardware-only spike: URLSession streaming for 15 min on the speaker and on AirPods with no stall over 2 s (watchOS 26.x and 27). About 1.5–2 weeks after it passes.
- **2.2** depends on direct APNs to the watch token, and on critical alerts if granted.
- **Estimate:** 110–170 agent-hours; done ~Dec 18–30, risk-adjusted mid-January.

### Phase 3: Wear OS (3.0; 3.1 Night watch, Wear Widget, Live Update)
- **Wave 1: fully testable in this container (T0) and on ubuntu (T1), can start today.**
  - `apps/wearos` Gradle project with `:app` (Compose for Wear OS, latest stable at start; `EdgeButton` as the primary action), `:tile` (`Material3TileService`, ProtoLayout screenshot tests) and `:complication` (`UPDATE_PERIOD_SECONDS=0`).
  - Roborazzi round, square and ambient suites; all glance logic from `glance-kotlin` through `includeBuild`.
  - `/home/user/Comic2/.github/workflows/mobile-wear.yml`.
- **Wave 2: after Android push at Gate A.**
  - FCM data alerts decrypted on the watch (Robolectric, plus a nightly real-FCM run to a Wear emulator).
  - Bridging turned off only after the watch holds a grant; dismissal id `inc_<id>`.
  - Data Layer `/glance/<nid>` and `MessageClient` when the phone app runs; otherwise standalone HTTPS and the `mode:'glance'` socket with a device token (a room change, sequenced after P1-WS-20a; the watch is a roster entry the phone signs).
  - An Ongoing Activity during incidents.
  - Device-code pairing: `/api/devices/code` and `/approve` (now 501) in `devices.ts`.
  - The same applicationId and signing key as the phone; target API 35+; 64-bit.
  - The Wear form-factor track through P1-WS-15's script.
- **Wave 3: devices (T3).**
  - Pixel Watch and Galaxy Watch: FCM-to-wrist p95 ≤ 6 s, no duplicates, dismissal synced.
  - Tile and complication ≤ 10 s after a bump.
  - Standalone on Wi-Fi.
  - Play Wear review.
- **3.1:** a `connectedDevice` foreground service ("Night watch"), off by default with the battery cost shown, plus the Wear OS 7 Widget and Live Update. About one more week.
- **Estimate:** 80–130 agent-hours; done ~Dec 10–22, risk-adjusted early January.
