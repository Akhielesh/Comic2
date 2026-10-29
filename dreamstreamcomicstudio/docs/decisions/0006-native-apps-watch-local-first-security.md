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
- ADR 0007 for the roster-log wire format (Phase 1).
- Update `docs/features/baby-monitor.md` (security and connection sections) and `docs/infrastructure/` (secrets, rate limits, R2 lifecycle).
- A privacy policy that matches D6.4.
- `/.well-known/security.txt`.

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
- **KPIs to measure** (WS-8 adds these to the cost centre; acceptance requires 7 days of data):
  - DO requests, rows, GB-s and storage per active nursery-day, from the GraphQL datasets `durableObjectsInvocationsAdaptiveGroups`, `durableObjectsPeriodicGroups` and `durableObjectsStorageGroups`.
  - TURN GB.
  - The share of viewer minutes on relay or TURN paths.
  - Glance bumps per night.
  - Pushes per night.

---

## Phased roadmap

| Phase | Weeks (from approval) | Depends on |
|---|---|---|
| 0: harden, cut cost, glance and push channel (web and Worker) | 1–3 | Supabase settings (owner) |
| 1: iOS and Android MVP with CI | 3–12 | Phase 0 wave 1 merged; Apple and Play accounts by week 4 |
| 2: Apple Watch | 8–14 (2.1: 14–16; 2.2 after) | Phase 1 milestone "push + Glance on iPhone" |
| 3: Wear OS | 12–17 (3.1: 18) | Phase 1 Android push; FCM |
| 4: LAN hub mode | 16–24 | Phase 1 camera mode; Local Push Connectivity entitlement |

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
- [ ] 7-day production median per active nursery-day: **DO requests ≤ 1,000, rows written ≤ 1,800, DO duration ≤ 40 GB-s**. Relay share is reported in the cost centre. *(Built 2026-10-23; a simulated 12 h night gives 542 / 1,040 / 3.6 GB-s — `live-worker/src/monitorRoom.night.test.ts`. Production median still to be read.)*
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
- [ ] `index.ts`:
  - Extend the monitor regex to `(ws|export|guest|glance|act|peek|members)`, forwarding all of them to the DO except `members` (→ `members.ts`).
  - Add `/api/me/kick` (→ `kick.ts`), `/api/devices/*` (→ `devices.ts`) and `/api/ops/apns-probe` (→ `ops.ts`, which calls WS-3's `probe.ts`).
  - Add `/x/user/:uid/notify`, forwarded to UserLine (for the new-device push mirror).
  - Check `RL_WS` before every upgrade and `RL_GUEST` on guest routes.
  - Enforce the `origin.ts` allowlist on upgrades (allowed origins, or no Origin).
- [ ] `devices.ts`:
  - `enroll` verifies the Supabase JWT (`verifyAccessToken`), calls `live_device_enroll`, and issues a grant.
  - `token` verifies the grant and `DS-Proof`, then issues a 10-minute access token.
  - `push` stores the push target through the DO (`/x/push-reg`).
  - `DELETE` revokes in Supabase and fans out `/x/device-revoked` to the user's nurseries.
- [ ] `kick.ts`: verify the caller; `monitor_list`; for each nursery, the DO `/x/kick {uid}`; UserLine `/x/kick`; revoke TURN usernames returned by the DOs.
- [ ] `members.ts`: require `aal2`; call the membership RPC with the caller's token; then the DO `/x/members {ids}`.
- [ ] `wrangler.jsonc`:
  - `ratelimits` bindings: `RL_WS` (60/60 s), `RL_GUEST` (10/60 s), `RL_GUEST_NID` (30/60 s).
  - Comments listing the new secrets (no values).
  - An R2 lifecycle comment pointing to the WS-8 runbook.

**Done when:** `index.test.ts` covers routing, the rate-limit refusal (4008/429), Origin refusal, and the kick and members fan-out against stub DOs.

#### WS-8 Observability and docs
**Owns:**
- `server/src/services/costCentre.ts` (+ its test)
- `docs/infrastructure/live-security-runbook.md` (new)
- `docs/features/baby-monitor.md`
- `docs/features/glance-contract.md` (new)
- `docs/decisions/README.md`
- `docs/decisions/0006-native-apps-watch-local-first-security.md`

**Tasks:**
- [ ] `costCentre.ts`:
  - Query `durableObjectsInvocationsAdaptiveGroups`, `durableObjectsPeriodicGroups` (rows, GB-s) and `durableObjectsStorageGroups`.
  - Compute per-active-nursery-day KPIs (requests, rows, GB-s) with alert thresholds (1,000 / 1,800 / 40).
  - Add TURN GB and the relay-share field.
- [ ] Runbook:
  - Secrets list and rotation.
  - `wrangler r2 bucket lifecycle add`: `events/` expires after 9 days; incomplete multipart uploads aborted after 1 day.
  - Rate-limit settings.
  - The Supabase settings checklist (owner actions #3 and #4).
  - How to run the APNs probe.
  - Incident playbook for "suspected account takeover".
- [ ] Docs: the Glance contract (copied from D2), the security and connection sections of the baby-monitor feature doc, and the ADR index row.

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
  - Internal `/x/kick` and `/x/members`: kick, prune `push` **and** `callPush`, revoke TURN usernames, ask the holder to rotate the NMK, notify every parent, log a `security` event.
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
- [ ] `/x/kick` closes the line socket and prunes call push targets.
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
5. Run the Phase 0 acceptance checklist on 7 days of production KPIs (WS-8) before Phase 1 cuts its first TestFlight build.