# DreamStream on Apple Watch and Wear OS: a calm, clutter-free baby-monitor design

Scope: platform facts as of October 2026, a screen-by-screen design, the data contract, delivery paths, the backend work, security, cost, and the platform limits stated plainly. I only read the repo; nothing was edited. Repo facts come from `/home/user/Comic2/dreamstreamcomicstudio/live/views/monitor/MoodGlyph.tsx`, `/home/user/Comic2/dreamstreamcomicstudio/live/styles/features.css` (lines 1270–1301), `/home/user/Comic2/dreamstreamcomicstudio/live/monitor/protocol.ts`, `/home/user/Comic2/dreamstreamcomicstudio/live-worker/src/monitorRoom.ts`, `/home/user/Comic2/dreamstreamcomicstudio/live-worker/src/webpush.ts`, `/home/user/Comic2/dreamstreamcomicstudio/live/views/MonitorCamera.tsx` and `/home/user/Comic2/dreamstreamcomicstudio/public/live-sw.js`.

---

## 0. Decisions

1. **The watch answers one question: "Is the baby OK?"** The home screen has the mood glyph, one word, a duration that ticks on the device, and one line of room level. It has one button. More buttons appear only during an alert.
2. **Apple Watch gets live state through push, not a socket.**
   - On watchOS, WebSocket and Network.framework count as "low-level networking". They are only allowed during an audio-streaming session (TN3135).
   - Developers on watchOS 26.5 and 26.6 report the connection dropping about 35–38 s into such a session (Apple bug FB24377808).
   - So the background path is: iPhone push (forwarded to the watch by the system), plus a Live Activity in the Smart Stack, plus complications.
   - In the foreground, the watch uses plain HTTPS: either the phone relays over WatchConnectivity, or the watch makes a URLSession GET to `/glance`.
3. **Wear OS can hold a WebSocket**, so in standalone mode it gets glance frames directly. When paired with an Android phone it uses the Data Layer (no cloud). Alerts come through FCM, which Google recommends for watches.
4. **One compact "Glance" contract (about 300 bytes) runs everywhere:** MonitorRoom, the phone apps, both watches, the push payloads and the LAN camera. The camera should send the cloud only glance-level *changes*. Rich telemetry (dB curve, motion, AI confidence) stays peer-to-peer or on the LAN. That one change also fixes the largest cloud-cost leak (§12).
5. **Alerts carry encrypted payloads.** Reuse the RFC 8291 encryption already in `webpush.ts` on top of native transports (FCM data messages, and APNs alerts with `mutable-content`).
   - On iOS and watchOS, a Notification Service Extension (available on watchOS 6+) decrypts.
   - On Android and Wear OS, the app decrypts the data message and builds the notification itself.
   - Apple and Google only ever see "DreamStream: Nursery alert".
6. **Push egress is FCM HTTP v1 for every platform, including iPhone Live Activities** (FCM supports `apns.live_activity_token`).
   - Calling APNs directly from a Worker is unproven. APNs requires HTTP/2, and Workers' HTTP/2 to origins is unclear (workerd#6455 is open; a Cloudflare maintainer says production does speak HTTP/2 to origins). This is one spike in §13.
   - If that spike passes, direct APNs unlocks WidgetKit pushes, pushes sent straight to the watch, and broadcast channels.
7. **Watches never hold Supabase tokens.** Each watch gets a revocable *device grant* tied to a Secure Enclave key (watchOS) or an Android Keystore key (Wear OS). From it the watch gets 10-minute tokens limited to one nursery and named actions, and every request carries a signed proof. The Worker verifies these itself, with no Supabase round trip.
8. **Media on the watch is short and end-to-end encrypted:**
   - **Listen**: 5-minute sessions, extendable.
   - **Peek**: a 240 px snapshot at 1 fps for at most 30 s.
   - **Hold to talk**: a voice clip of up to 10 s, played through the camera's existing loudness limiter.
   - There is no video and no WebRTC on the watch.
   - Each tries the home network first and falls back to relaying through MonitorRoom. The server only ever handles ciphertext.
9. **Local / home-only toggle.** When the internet is down, the phone becomes the hub.
   - An iPhone in Bedside mode (kept alive by background audio) posts *local* notifications, which iOS forwards to the watch.
   - An Android phone in a `connectedDevice` foreground service posts notifications, which are bridged to Wear OS. Google Play's policy names baby monitors as an example for this service type.
   - Apple Watch cannot keep its own socket open, so it needs either the internet or the phone hub.
10. **"I'm on it" is the first notification action**, so the system double tap triggers it (the `primaryAction` API exists since watchOS 11). When anyone acknowledges, everyone else's alert is quietly replaced with "Dad's on it ✓": same APNs collapse ID on Apple, same Wear dismissal ID on Android.
11. **Minimum versions:**
    - watchOS 26. Live Activities on the watch, WidgetKit push, Controls and RelevanceKit all exist there. watchOS 27 runs only on Series 9 and later, so 26 keeps older watches.
    - Wear OS 4+ (Credential Manager). Tiles via ProtoLayout 1.4 / Tiles 1.6. On Wear OS 7, also add Wear Widgets and Live Updates.

---

## 1. Platform facts that shape the design (2026, cited)

### watchOS 26 / 27

| Fact | Consequence |
|---|---|
| WebSocket, NWConnection and URLSessionStreamTask are "low-level networking". They are only allowed during an active audio-streaming session or a CallKit call (TN3135; Apple engineer on the forums). | No socket in the background. Glance uses HTTPS, push and WatchConnectivity. |
| On 26.5 and 26.6, the network path is revoked about 35–38 s into the audio session (forum threads 841590 and 841760; FB24377808). URLSession streaming ran for 64 s without a stall. | Listen must use **URLSession** (a chunked HTTP stream or short segments), never NWConnection. |
| `longFormAudio` normally requires Bluetooth, but on watchOS 11+ the **built-in speaker satisfies it** on supported models. Background audio needs the `audio` background mode. | Listen works on the speaker or AirPods and keeps going with the wrist down. |
| iPhone remote notifications go to the watch when the iPhone is locked and the watch is on the wrist and unlocked. Background pushes are never forwarded. Pushes sent directly to the watch (watchOS 6+) appear only on the watch. | v1 relies on forwarding. Pushes straight to the watch are phase 2 and must use the **same notification identifier** so the system de-duplicates them. Otherwise the watch waits for the phone and alerts late. |
| Local notifications from the iOS app are forwarded to the watch the same way. | Gives a zero-cloud alert path in local mode. |
| UNNotificationServiceExtension exists on watchOS 6+. CryptoKit SecureEnclave on watchOS 6+. App Attest (DCAppAttestService) on watchOS 9+. | Encrypted pushes, hardware-bound device keys and app attestation all work on the watch. |
| iPhone Live Activities appear in the Smart Stack automatically (watchOS 11+). The `.small` layout is opt-in via `supplementalActivityFamilies`. An alerting update shows `title`/`body` on the watch. Limits: 8 h active, 12 h on the Lock Screen, 4 KB of data. Priority-5 updates don't count against the budget. `NSSupportsLiveActivitiesFrequentUpdates` raises the budget. The UI can't animate in Always On. | The "Monitoring" Live Activity is the real-time surface while the wrist is down. Night sessions need a restart at about 7 h 50 m. |
| WidgetKit push (`apns-push-type: widgets`) is "budgeted and delivered opportunistically" and can't be sent on broadcast channels. | Complications are "accurate within minutes", not real-time. Duration text ticks on the device. |
| watchOS 26 added Controls (Control Center, Action Button, Smart Stack) and RelevanceKit relevant widgets (Smart Stack only). | Add a "Listen" control (Action Button on Ultra = instant listen), and a relevant widget that surfaces at bedtime. |
| watchOS 27 adds a one-pinch tap to select a Smart Stack widget and runs on Series 9 and later. | Keep watchOS 26 as the minimum. |
| `transferCurrentComplicationUserInfo` and `sendMessage` exist. A `sendMessage` from the watch **wakes the iPhone app in the background**. A send from the iPhone does not wake the watch app. | When the watch app opens, it asks the phone first (free). |
| Critical Alerts need an Apple entitlement, granted on request (available on watchOS 5+). | Apply now. Use Time Sensitive until it is granted. |
| Firebase on watchOS is community-supported, not official. | Don't build v1 on FCM running on the watch. |

### Wear OS 5 / 6 / 7

| Fact | Consequence |
|---|---|
| Watch traffic goes through the phone over Bluetooth, otherwise Wi-Fi or LTE. HTTP, TCP and UDP are allowed. Request Wi-Fi explicitly for high bandwidth. FCM is "the recommended way to send notifications to a watch". | WebSocket glance while the app is visible. FCM high-priority *data* messages for alerts. Request Wi-Fi only for Listen and Peek. |
| Bridging: phone notifications are bridged by default and cause duplicates. Fix with a runtime `BridgingConfig` plus `setBridgeTag`, and sync dismissals with `setDismissalId`. A manifest-level NO_BRIDGING setting can lose notifications before sign-in. | Turn bridging off only *after* the watch holds a grant. Use the incident ID as the dismissal ID. |
| Media audio should only play on a Bluetooth output. From Wear OS 5 there is a system output switcher, and apps targeting API 35+ can offer the built-in speaker there on supported devices. | Listen checks the output and opens the switcher (Horologist `launchOutputSelection()`). Target API 35+. |
| Complication `UPDATE_PERIOD_SECONDS` is at least 300 s, or 0 for push-only updates. Updates are less frequent in ambient mode. | Set 0 and push updates from the FCM and Data Layer handlers. Use time-difference text so it ticks. |
| Wear OS 6 is based on Android 16, with Material 3 Expressive and `EdgeButton` for apps and tiles. | Use the EdgeButton as the single primary action. |
| Wear OS 7 is based on Android 17 and is still Canary; stable comes later this year. Wear Widgets (`glance-wear` + `compose-remote`, 2x1/2x2 cards) are evolving out of Tiles, but Tiles remain supported. Live Updates (`setShortCriticalText`, `setUsesChronometer`) replace Ongoing Activities for local use. Phone-to-watch bridging of Live Updates depends on the OEM. Frequent updates may be hidden. | Ship a Tile now and move its `mainSlot` into a 2x2 widget later. Use an Ongoing Activity on 5/6 and a Live Update on 7, with the `when` timestamp so the timer ticks without updates. |
| Credential Manager is the recommended Wear OS sign-in (Wear OS 4+). Data Layer token sharing works only on Android-paired watches, and another sign-in method must also be offered. Check `isWristDetectionAutoLockingEnabled()` before showing private data. | Pair through the phone, or a device code as the fallback. Never ship long-lived account tokens to the watch. |
| Play's `connectedDevice` foreground-service type lists **baby monitors** as an example. | An optional "Night watch" mode on Wear OS can keep a socket open with screen-off haptics. |

---

## 2. Experience principles

- **3-second rule.** Raise the wrist and know the state without reading a number: glyph shape and colour plus one word.
- **Never colour alone.** Shape (moon, eyes, rings, bars), a word, and colour, so it works in Always On, in red Night Mode on Ultra, for colour-blind users and with VoiceOver.
- **Actions follow state.** Calm shows one button (Listen). An alert shows "I'm on it" as primary (double tap), plus Listen, Soothe and Hold to talk. After someone acknowledges, it goes back to one button.
- **Same glyph language as the web.** Port `MoodGlyph` path data verbatim (48×48 viewBox) and the CSS keyframes (§5).
- **Duty-aware.** The person on duty gets the buzz first; the others see "Dad's on it". This mirrors the existing `audience: 'duty'` and escalation rules in `monitorRoom.ts`.
- **Role-aware.** Viewers can't acknowledge or soothe (`onAck` and `onCmd` already reject viewers), so their alert shows Listen only. Share-link guests get no watch access.
- **Always On / dimmed:** no animation; show the static glyph, the word, and "since 02:47". Never reorganise the layout between active and dimmed.

---

## 3. Apple Watch screens

**W1 Home (calm).** Vertical TabView pages: Home, Tonight, Log.
```
╭────────────────────────╮
│ 10:09   Maya's room  ● │  ● live · ○ stale (as-of > 90 s, no link)
│                        │
│        ( moon  z )     │  MoodGlyph 72pt, indigo, breathing 4 s, z's drift
│                        │
│         Asleep         │  SF Rounded 28, state colour
│         1:42:10        │  Text(timerInterval:) — ticks locally, no updates
│    ▂▃▂ 34 dB · quiet   │  one secondary line
│ ╭────────────────────╮ │
│ │       Listen       │ │  only button; .handGestureShortcut(.primaryAction)
│ ╰────────────────────╯ │
╰────────────────────────╯
```
Other states use the same layout:
- Stirring: amber sway, "Stirring · 2m".
- Awake & happy: amber blink.
- Noisy room: blue bars, "Noisy room — not the baby".
- Fussing: amber wobble.
- Camera offline: grey dashed orb, "Camera offline · 4m", plus one hint line "Check the nursery phone's power & Wi-Fi".
- Waiting for camera: grey dashed orb.

**W1 Home (alert takeover).** Shown when an incident is open or the mood is crying.
```
╭────────────────────────╮
│ 02:47   Maya's room  ● │
│     ((( ( >< ) )))     │  red, two rings pulse 1.6 s (0.8 s offset)
│         Crying         │
│          0:42          │
│   ▅▆▇ 68 dB · loud     │
│ ╭────────────────────╮ │
│ │     I'm on it      │ │  primary (double tap) → POST /act ack
│ ╰────────────────────╯ │
│ [ Listen ] [ Soothe ]  │
│ [    Hold to talk    ] │
╰────────────────────────╯
```
- After *I* acknowledge: a large check mark, "You're on it · Mom notified". "Resolved" sits below, one Crown scroll away.
- When *someone else* acknowledges: a chip "Dad's on it ✓" under the state; the in-app haptic loop stops and the screen goes back to the single Listen button.

**W2 Tonight (Crown page 2):**
```
╭────────────────────────╮
│ Tonight                │
│ Asleep 1h 42m · woke 1 │
│ Longest 3h 10m         │
│────────────────────────│
│ On duty  Dad (you)     │
│          [ Hand over ] │  or [ Take duty · 12 h ]
│ Camera   72% · charging│
│ Last     Cough 12:41   │
│          Mom on it     │
╰────────────────────────╯
```

**W3 Log (parents and caregivers only; turn off in settings):**
```
╭────────────────────────╮
│ ╭─────────╮╭─────────╮ │
│ │ Feed  L ││ Feed  R │ │  tap = start timer (tracker 'breast'), tap again = stop
│ ╰─────────╯╰─────────╯ │
│ ╭────────────────────╮ │
│ │       Diaper       │ │  → Wet | Dirty | Both
│ ╰────────────────────╯ │
│ Last feed 2h 10m · L   │
╰────────────────────────╯
```

**W4 Listen:**
```
╭────────────────────────╮
│ < Listening       4:18 │  auto-stop countdown (5:00 default, +5 by Crown press)
│    ~~~((  ))~~~        │  ring driven by decoded audio level (local)
│  Home Wi-Fi · speaker  │  route + path badge (Home Wi-Fi | Internet)
│ [ Stop ]   [ Peek ]    │  Digital Crown = volume
│ [    Hold to talk    ] │
╰────────────────────────╯
```

**W5 Peek.** 240 px JPEG, 1 fps, 30 s cap, end-to-end encrypted.
```
╭────────────────────────╮
│ ┌────────────────────┐ │
│ │     snapshot       │ │
│ └────────────────────┘ │
│  1 s ago · ends in 24 s│
╰────────────────────────╯
```
If `light` is below the threshold: "Too dark for a picture — Listen tells you more", with a [Listen] button.

**W6 Hold to talk:** a ring fills over 10 s; release sends. The result is "Played in Maya's room ✓", or "Camera offline — not sent".

**W7 Soothe:** White noise / Shush / Lullaby, and 15 / **30** / 60 min. While playing, Home shows "White noise · 23 min left" with [Stop].

**W0 Pair:** "On your iPhone: Settings › Watch › Add this watch", or "dreamstreamstudio.ai/watch, code K7Q-4MP", then "Waiting…".

**Notification long look** (custom `WKUserNotificationHostingController`, which can show the animated glyph):
```
╭────────────────────────╮
│ DreamStream       now  │
│ ((( >< )))  Crying     │
│ Maya's room · 0:40     │
│ 68 dB · Dad on duty    │
│ ┌────────────────────┐ │
│ │ I'm on it          │ │  action 1 → double tap
│ │ Listen             │ │  .foreground → opens W4
│ │ Soothe             │ │  background → last-used sound, 30 min
│ └────────────────────┘ │
╰────────────────────────╯
```
Short look: glyph plus "Crying · Maya's room".

**Smart Stack Live Activity (`.small`):**
```
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ (moon) Asleep   1:42:10      │   │ ((><)) Crying 0:42           │
│        34 dB · Dad on duty   │   │        Dad's on it ✓          │
└──────────────────────────────┘   └──────────────────────────────┘
```
Tapping opens the watch app at the alert screen.

**Complications** (WidgetKit accessory families). Each uses a static glyph frame per state; animation isn't possible there.
- `accessoryCircular`: the glyph, with a ring tinted by state (dashed when offline).
- `accessoryCorner`: the glyph plus curved text "Asleep 1:42".
- `accessoryRectangular`: "Maya · Asleep" / "1h 42m" / "34 dB · Dad on duty".
- `accessoryInline`: "Asleep 1:42 · 34 dB".

Durations use `Text(date, style: .timer)`. The widget is configured per nursery with an `AppIntentConfiguration`.

**Control:** "Listen to nursery" (watchOS 26 ControlWidget, Action Button on Ultra).

---

## 4. Wear OS screens

Built with Compose for Wear OS 1.6 and Material 3 Expressive: `AppScaffold`, `ScreenScaffold`, curved `TimeText`, and an `EdgeButton`.

```
        .-""""""""-.                    .-""""""""-.
     .'    10:09     '.              .'    02:47     '.
    /    ( moon  z )   \            /  ((( ( >< ) )))  \
   |       Asleep       |          |      Crying 0:42   |
   |       1:42:10      |          |    68 dB · loud    |
    \   34 dB · quiet  /            \ [Listen] [Soothe]/
     '.  [ Listen ]  .'              '. [ I'm on it ] .'   EdgeButton = ack
        '-........-'                    '-........-'
```
- **Pages:** swipe to Tonight and Log, same content as Apple's W2 and W3. Listen, Peek, Talk and Soothe mirror W4–W7.
- **Tile** (`Material3TileService`, ProtoLayout 1.4, inline image resources). The glyph is a static image per state. The duration ticks through ProtoLayout dynamic time, with no updates. One `EdgeButton`, "Listen", deep-links into the app. The tile is refreshed with `TileService.getUpdater().requestUpdate()` from the FCM and Data Layer handlers. On Wear OS 7, the same `mainSlot` becomes a 2x2 Wear Widget.
- **Complications** (`SuspendingComplicationDataSourceService`, `UPDATE_PERIOD_SECONDS=0`, pushed through `ComplicationDataSourceUpdateRequester`):
  - SMALL_IMAGE: the glyph.
  - SHORT_TEXT: "1:42", using `TimeDifferenceComplicationText` with a monochrome glyph icon.
  - RANGED_VALUE: room dB on a 30–80 scale.
  - LONG_TEXT: "Asleep 1h42 · 34 dB".
- **Alert notification.** Built locally from the FCM data message:
  - Channel `ds_urgent` at IMPORTANCE_HIGH, vibration waveform `[0,500,150,500,150,900]`, and the user is prompted once to allow it to override Do Not Disturb.
  - Actions: I'm on it / Listen / Soothe.
  - `WearableExtender.setDismissalId("inc_<id>")` and `setBridgeTag("urgent")`.
- **Ongoing / Live Update** while listening or while an incident is open: an `OngoingActivity` on 5/6, a Live Update on 7 (`setShortCriticalText("Crying")`, `setUsesChronometer`), with chips like "Listening 0:42" and "Crying · Dad on it".
- **Optional "Night watch" mode** (off by default): a `connectedDevice` foreground service holds a glance WebSocket (LAN-first) and loops haptics until someone acknowledges. Battery cost is shown up front.

---

## 5. Shared glyph spec (from `features.css` 1270–1301)

| Mood | Shape | Colour token | Animation (port exactly) |
|---|---|---|---|
| calm | moon + two z's | indigo | orb breathes, scale 1.06 at 50%, 4 s; z drifts (0,4) to (4,−6), 3.2 s, 1.6 s stagger |
| stirring | half-closed eyes, flat mouth | amber | face sways −7°, 2.6 s, pivot (24,30) |
| awake | open eyes, smile | amber | blink: scaleY 0.1 at 95%, 4.5 s |
| fussing | eyes, frown | amber | wobble ±6°, 0.9 s |
| noisy | 4 bars | blue | bars scaleY 0.35, 1 s, 0.15 s stagger |
| crying | squeezed eyes, open mouth, 2 rings | live red | rings scale 1 to 1.55, opacity 0.7 to 0, 1.6 s, second ring offset 0.8 s |
| offline / unknown | flat line, dashed orb (3/3) | faint grey | none |

- **SwiftUI:** `Path` built from the same `d` strings; `TimelineView(.animation)` when active; static when `isLuminanceReduced` or Reduce Motion is on.
- **Compose:** `PathParser().parsePathString(d)`; `rememberInfiniteTransition`; static in ambient mode (`LocalAmbientModeManager`).
- **Complication, Tile and Live Activity assets:** one static frame per mood, exported from the same SVG (custom SF Symbol templates or monochrome vector drawables).
- **VoiceOver / TalkBack label:** "Maya's room. Asleep for 1 hour 42 minutes. Room quiet, 34 decibels."

## 6. Alert and haptic ladder

| Severity (existing) | iPhone push | Apple Watch | Wear OS |
|---|---|---|---|
| urgent (cry, alarm, glass, zone, crib_out, offline, noise) | `interruption-level: critical` once entitled, otherwise `time-sensitive`; category `DS_URGENT` (viewers: `DS_URGENT_VIEW`, Listen only); repeats per the existing HAZARD `repeatMs`/`escalateMs` until acknowledged | system notification haptic and sound. In-app: `WKHapticType.notification` every 2 s until acknowledged or dismissed (max 60 s) | `ds_urgent` waveform; same in-app loop |
| warn (fuss, cough, crash, loud, battery, camera) | `active`, category `DS_WARN` (I'm on it, Listen) | single haptic | `ds_warn`, single pulse |
| info (report, insight) | `passive`, no sound | no haptic; Smart Stack and app only | `ds_info`, silent |
| acknowledged or resolved by someone else | `passive` replacement with the same `apns-collapse-id` = incident ID: "Dad's on it ✓" | quiet replacement | update with the same ID, `setOnlyAlertOnce(true)`; dismissal-ID sync |

The iPhone app and the watch app both implement the action handler, and both call the same idempotent `/act` endpoint. Which device handles a background action on a forwarded notification is not documented clearly, so we don't depend on it.

## 7. What NOT to show on a watch

- Video playback.
- History charts, the minute curves, night reports (one "Longest 3h 10m" line is enough).
- AI sound lists, confidence percentages, `top[]`, scene posture.
- Encoder, P2P and relay telemetry.
- Raw motion and light values.
- Zone editors, sensitivity or settings, beyond two things: "alerts on this watch" and the nursery choice.
- People, roles, share links and guests.
- Tracker history, growth charts and sleep-prediction prose.
- Family video calls. At most a "Call from Mom — answer on phone" notification.
- More than one primary button at a time.

---

## 8. Data contract

### 8.1 Glance v1

The same JSON is used over HTTP, WebSocket, WatchConnectivity (`applicationContext["g"]`), the Data Layer (`/glance/<nid>` DataItem), the LAN camera, and inside encrypted push payloads.

```ts
export type Mood = 'calm'|'stirring'|'awake'|'noisy'|'fussing'|'crying'|'offline'|'unknown';
export interface Glance {
  v: 1;
  n: string;            // nursery id
  nm?: string;          // display name ≤24 chars — OMITTED from push payloads; cached on device
  q: number;            // seq, monotonic per nursery; bumps only on visible change (§8.2)
  at: number;           // server ms; client shows "as of" if stale and no live link
  m: Mood; ms: number;  // mood + since (ms)
  sl?: { p: 'idle'|'settling'|'asleep'|'awake'; s: number|null; min: number; w: number }; // SleepStatus subset
  db?: number|null;     // LAeq dB(A), integer (CamStatus.spl.leq)
  dbb?: 0|1|2|3;        // quiet <40 · normal <55 · loud <70 · very loud
  cam: { on: number; bat?: number|null; chg?: boolean|null; pz?: 'privacy'|'interrupted'|'hidden'|null; ls: number };
  al?: { id: string; k: string; sev: 'urgent'|'warn'|'info'|'care'; at: number; st: 'open'|'acked'|'resolved'; by?: string|null } | null; // worst open, else last ≤30 min
  du?: { nm: string; me: boolean; u: number } | null;  // Duty, `me` computed per requesting device
  so?: string|null;     // soothing now
  tk?: string|null;     // who is talking into the nursery
  can: number;          // bitmask for THIS device: 1 ack · 2 soothe · 4 listen · 8 talk · 16 peek · 32 duty · 64 log
}
```
Example: `{"v":1,"n":"…","q":812,"at":1761100020000,"m":"crying","ms":1761099978000,"sl":{"p":"awake","s":1761099978000,"min":102,"w":1},"db":68,"dbb":2,"cam":{"on":1,"bat":72,"chg":true,"pz":null,"ls":1761100019000},"al":{"id":"i9","k":"cry","sev":"urgent","at":1761099990000,"st":"open"},"du":{"nm":"Dad","me":true,"u":1761130000000},"can":127}` is about 330 bytes. Encrypted with aes128gcm and base64url-encoded, it is about 480 bytes, well under the 4 KB push limit.

### 8.2 When the sequence number bumps (keeps push counts at about 20–60 per night)

- Mood: immediate if it rises to fussing or above, or to offline. Otherwise after 15 s of stability.
- Sleep phase: immediate.
- dB band (`dbb`): after 30 s sustained. A change in the `db` number alone never bumps it.
- Alert opened, acknowledged or resolved; duty; soothing; talk; cameras online or paused: immediate. Battery: when crossing 20% or 10%.
- `composeGlance(state)` is a **pure function** in a shared TypeScript module with golden JSON fixtures. The Swift and Kotlin decoders and the LAN camera must pass the same fixtures.

### 8.3 Actions, media, devices (new HTTP surface)

```
GET  /api/monitor/:nid/glance            If-None-Match: "<q>" → 304 | 200 {g}
POST /api/monitor/:nid/act               {a:'ack'|'resolve'|'soothe'|'soothe_stop'|'duty_on'|'duty_off'|'log', inc?, v?, id:<uuid>} → {ok, g}
POST /api/monitor/:nid/clip              ≤96 KB E2E ciphertext (AAC-LC m4a ≤10 s) → forwarded to camera socket, never stored; 409 if no camera
GET  /api/monitor/:nid/listen?dev=…      chunked stream: [u32 seq][u16 len][AES-GCM(200 ms audio)]…; 15-min cap per request
GET  /api/monitor/:nid/peek?dev=…        E2E-encrypted 240 px JPEG ≤16 KB (camera renders on demand; DO keeps one ≤3 s)
WS   /api/monitor/:nid/ws  mode:'glance' receives only {t:'glance', g}; hibernation-friendly
POST /api/devices/enroll   (phone, Supabase JWT) {pub, platform, name, nurseries:[{id,cap}], attest?} → {grant}
POST /api/devices/code     (watch) {pub, platform} → {user_code, poll_id, exp}; POST /api/devices/approve (any signed-in member)
POST /api/devices/token    (watch) {grant, ts, sig} → {access: ES256 JWT 10 min, scp, nid[], cnf.jkt}
POST /api/devices/push     {fcm, la?, la_start?, widget?, enc:{p256dh, auth}}
DELETE /api/devices/:grant (owner or parent) → immediate revoke (MonitorRoom keeps a revoked set)
```

- **Audio for Listen:** v1 is 16 kHz mono IMA-ADPCM (64 kbps; a 30-line decoder; no codec dependency on the web camera or the watch). v2 moves to Opus once the cameras are native.
- **Starting the camera's audio:** the camera begins its lightweight audio encoder only when MonitorRoom sends `{t:'listen_want', n}`, the same pattern as the existing `relay_want`. It stops 10 s after the last listener leaves.
- **LAN first:** members' presence includes the camera's `lan:[{ip,port,spki}]`. The watch tries `https://ip:port/...` first, pinning the camera's certificate key (URLSession trust delegate; OkHttp `CertificatePinner`), then falls back to the cloud URL.

### 8.4 Push payloads

```jsonc
// Android / Wear OS — data-only so the app decrypts and builds the notification
{"message":{"token":"…","android":{"priority":"HIGH","ttl":"300s","collapse_key":"inc_i9"},
  "data":{"e":"<RFC8291 aes128gcm b64url of {g, title, body}>","s":"u","i":"i9","q":"812"}}}
// iPhone alert (forwarded to the watch) — NSE decrypts and rewrites title and body
{"message":{"token":"…","apns":{"headers":{"apns-priority":"10","apns-collapse-id":"i9","apns-push-type":"alert"},
  "payload":{"aps":{"alert":{"title":"DreamStream","body":"Nursery alert"},"mutable-content":1,
  "interruption-level":"time-sensitive","category":"DS_URGENT","thread-id":"<nid>","sound":"cry.caf"},"e":"…"}}}}
// Live Activity update via FCM
{"message":{"token":"…","apns":{"live_activity_token":"…","headers":{"apns-priority":"5"},
  "payload":{"aps":{"timestamp":1761100020,"event":"update","stale-date":1761100920,
  "content-state":{"e":"<per-device ciphertext of compact glance>"}}}}}}
```
- **Live Activity content state:** the iPhone widget extension decrypts it in the view, using a key in the app group's Keychain. If spike #3 fails, fall back to a plaintext enum only (`m`, `ms`, `sl.p`, `al.st`; no names, no IDs).
- **Live Activity lifecycle:** push-to-start when the camera starts or the baby falls asleep (iOS 17.2+, with an alert but no sound). End and re-start at about 7 h 50 m because of the 8 h cap.

## 9. Delivery matrix

| Situation | Apple Watch | Wear OS |
|---|---|---|
| App on screen, phone app alive | WCSession `sendMessage` / `applicationContext` from the phone (no cloud) | Data Layer `MessageClient` + `/glance` DataItem (no cloud) |
| App on screen, phone app asleep | `sendMessage` wakes the iPhone app to refresh, **or** the watch does a URLSession GET `/glance` with ETag every 3 s while active; stops when dimmed | WebSocket `mode:'glance'` (LAN camera first, then cloud) |
| Wrist down | Live Activity in Smart Stack (FCM-relayed APNs) + complication (watch app reload / WidgetKit push once direct APNs works) | Tile and complication updates from the FCM data handler; Ongoing / Live Update during incidents |
| Alert | iPhone APNs alert, forwarded by the system; NSE decrypts. Phase 2: also sent straight to the watch with the same identifier | FCM high-priority data message, then a local notification; bridging off once a grant exists |
| Internet down (local toggle) | iPhone in Bedside mode (background audio) holds the LAN link, runs the local alert rules, posts *local* notifications, which are forwarded to the watch; WCSession glance | Android phone foreground service, notifications bridged; or the watch's own Night-watch LAN socket |
| Phone dead or away, watch on Wi-Fi or LTE | Forwarded alerts still work if the iPhone is on and online (Apple routes forwarded notifications over Wi-Fi or cellular). If the iPhone is off: needs pushes straight to the watch (phase 2) | Fully standalone (FCM + WebSocket) |

## 10. Backend work (concrete)

1. **`live-worker/src/glance.ts`:** a pure `composeGlance()` function and a bump/debounce state machine. Unit-tested with fixtures.
2. **`monitorRoom.ts`:**
   - Keep `glance` and `q` in memory and persist them on bump.
   - Add a `'glance'` socket mode, and send `{t:'glance'}` on bump.
   - Serve `/glance`, `/act`, `/clip`, `/listen` and `/peek`.
   - Refactor `onAck`, `onResolve`, `onCmd`, `onDuty` and track writes to take an actor `{uid, role, label, deviceId}` instead of a WebSocket attachment, so HTTP and WS share them.
   - Add `listen_want` / `peek_want` / `clip` frames to the camera protocol.
3. **Liveness and cost fix:**
   - The camera currently sends its full status every 2 s (`MonitorCamera.tsx`, `startTicker(2000…)`), which stops the Durable Object from ever hibernating.
   - Move to: send status only on glance-relevant change, plus a full status every 60 s.
   - Liveness comes from the existing `setWebSocketAutoResponse` ping, read with `getWebSocketAutoResponseTimestamp` from a 60 s alarm. Auto-response pings don't wake the object.
   - Rich `st` keeps flowing directly to viewers (it already uses `hub.direct`).
4. **`push/fcm.ts`:**
   - FCM HTTP v1 sender: a service-account JWT exchanged for an OAuth token cached for 55 min; the key is a Worker secret.
   - Reuse `webpush.ts` encryption for the `e` field.
   - Generalise `pushAlert` to send per device over the right transport: `webpush | fcm-android | fcm-apns | fcm-liveactivity`.
   - The category is chosen by recipient role.
   - Add the passive "acknowledged" replacement push.
5. **`devices.ts` + Supabase `device_grants` table:**
   - Columns: owner, public-key thumbprint, platform, name, nurseries+caps, created, last_seen, revoked.
   - Row-level security: owner and parents.
   - Token-signing key held in the KEY_HOLDER pattern; the public key is cached per isolate.
   - The Worker verifies the JWT and the proof, then forwards to the Durable Object with an `x-ds-actor` header.
6. **Web:** a Settings › Devices list with revoke, "Pair a watch" code entry, and an "I'm on it" action in `public/live-sw.js` (today it only has "Watch now").

## 11. Security model for watches

- **Device key.** watchOS: Secure Enclave P-256, plus App Attest on watchOS 9+. Wear OS: Android Keystore EC P-256 (StrongBox where present), plus Play Integrity on the phone at enrollment.
- **Grant.** Issued by a signed-in parent or caregiver device, either over WatchConnectivity / Data Layer, or with an RFC 8628-style user code (6 characters, 10 min expiry, 5 attempts).
- **Capability cap.** A watch's capabilities are at most `min(user role, caregiver)`. Viewer watches get glance and listen only.
- **Requests.** Each request carries `DS-Proof`, an ES256 signature over `method\npath\nts\nsha256(body)`, with a ±60 s window and a nonce cache in the Durable Object. A stolen access token without the hardware key is useless. The worst a fully stolen *unlocked* watch can do is read one nursery's glance and acknowledge or soothe, until it is revoked from any device.
- **Media.** Listen, Peek and Talk use a nursery media key (NMK) that the server never holds.
  - The approving device wraps the NMK to the watch's public key (ECDH + HKDF + AES-GCM). MonitorRoom stores only opaque wrapped blobs.
  - Removing a device rotates the NMK; a parent device re-wraps it for the remaining devices.
  - Per-session keys = HKDF(NMK, "listen"|"peek"|"clip" ‖ session), with a 96-bit counter nonce.
- **Push privacy.** Payloads are encrypted per device, as in §8.4. Push providers see a generic title only. Live Activity content state is encrypted as well, pending spike #3.
- **On the device.**
  - Wear OS: if wrist-detection auto-lock is off, require the watch lock before showing names.
  - Both: the tokens' Keychain/Keystore entries are this-device-only (`ThisDeviceOnly` accessibility on Apple), never synced or backed up.
  - Always-On view marked `.privacySensitive()` for the nursery name.
- **Honest scope.** The glance is composed on the server, so MonitorRoom sees state (not media). Moving all logic to end-to-end encryption is out of scope here.

## 12. Cost (Workers Paid; Durable Object pricing: 1M requests + 400k GB-s included, then $0.15/M requests and $12.50/M GB-s; incoming WebSocket messages billed 20:1; hibernating objects are not billed for duration)

| Item per family-month | Estimate |
|---|---|
| Glance polls (2 min/day of screen time, 3 s interval) | ~1.2k requests: < $0.001 |
| Alert + Live Activity pushes (FCM free) | ~7k Worker subrequests, ~90 GB-s: ~$0.001 |
| Listen 10 min/day (64 kbps through the DO, egress free) | ~2.3k GB-s: ~$0.03 |
| Peek / clips | negligible |
| **Existing leak (not watch-related):** the 2 s camera status keeps the DO awake about 10 h a night | ~4.6k GB-s/night ≈ 138k GB-s/month. About 3 families use up the included 400k; after that it's about $1.70 per family-month. The fix in §10.3 should bring it to about $0.01 |

The local paths (home Wi-Fi, phone hub) cost nothing.

## 13. Platform limits and spikes to run on hardware first

1. **Direct APNs from a Worker `fetch()`** (APNs needs HTTP/2; workerd#6455). If it works: WidgetKit pushes, pushes straight to the watch, broadcast channels, and no Google in the Apple path. If not: stay on FCM.
2. **watchOS 26.x and 27, URLSession chunked Listen for 15 min** on the speaker and on AirPods. Pass = no stall over 2 s. Never use NWConnection (FB24377808).
3. **Encrypted Live Activity content state** decrypted in the iPhone extension still renders in the watch Smart Stack.
4. **Apple Watch reaching the camera's LAN IP** with URLSession: once while proxied through the iPhone over Bluetooth, once on Wi-Fi. If it fails, Apple local mode is phone-hub only.
5. **Double tap triggers the first notification action** ("I'm on it") on Series 9+ / Ultra 2+.
6. **Critical Alerts entitlement request:** outcome unknown. Time Sensitive needs the user to allow it through Sleep Focus; prompt for that during onboarding.
7. **Wear OS Listen routing:** Pixel Watch and Galaxy Watch (One UI 8 Watch), targeting API 35, speaker offered in the output switcher; Play review of the `connectedDevice` Night-watch service.
8. **Hard limits to state in the UI:**
   - No continuous background monitoring on Apple Watch.
   - Live Activity lasts 8 h and needs a restart.
   - Complications lag by minutes.
   - No video.
   - Peek is useless in a dark room (phones have no infrared).
   - Wear OS Live Updates exist only on Wear OS 7, and phone-to-watch bridging of them depends on the OEM.

## 14. Build and CI (no Xcode or Android SDK locally, so GitHub Actions)

- **Apple:**
  - Targets: `DreamStream` (iOS) with the NSE, a WidgetKit + Live Activity extension and an App Intents extension; `DreamWatch` (watchOS 26, SwiftUI) with its own NSE and widget extension.
  - Shared Swift package `DreamCore`: Glance codec, crypto, device auth, API client, glyph paths.
  - CI on `macos-15`: `xcodebuild test -scheme DreamWatch -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)'`, plus snapshot tests for 8 moods × {active, luminance-reduced, reduce-motion}.
- **Android:**
  - Gradle modules `:core` (Kotlin Glance codec + crypto), `:app`, `:wear`.
  - `:wear` uses Compose for Wear OS 1.6 with M3 Expressive, Tiles 1.6 / ProtoLayout 1.4, `watchface-complications-data-source-ktx`, Horologist audio, and `play-services-wearable`.
  - CI on `ubuntu-latest`: `:wear:testDebugUnitTest` with Roborazzi round/square screenshots, plus Wear emulator runs via `reactivecircus/android-emulator-runner`.
- **Cross-platform contract tests:** the same `glance/*.json` golden fixtures run in vitest (`live-worker`), XCTest and JUnit.
- **Phases:**
  - **P0 (web + worker only):** glance composer, endpoints, device grants, FCM sender, change-only camera status with hibernation, "I'm on it" in the web service worker.
  - **P1:** iOS + watchOS MVP: pairing, glance, encrypted notifications with actions, complications, Live Activity.
  - **P2:** Listen, Peek, Talk; Wear OS MVP (Data Layer / WebSocket, FCM, Tile, complications).
  - **P3:** local-mode hubs, Wear Widgets and Live Updates (Wear OS 7), direct-to-watch pushes, critical alerts.

---

### Sources
- [TN3135 discussion: low-level networking on watchOS](https://developer.apple.com/forums/thread/717615) · [URLSessionWebSocketTask docs](https://developer.apple.com/documentation/foundation/urlsessionwebsockettask.md) · [Audio-session exception ~38 s revoke (watchOS 26.5, FB24377808)](https://developer.apple.com/forums/thread/841590) · [NWConnection WebSocket drops ~35 s, URLSession OK (watchOS 26.6)](https://developer.apple.com/forums/thread/841760)
- [AVAudioSession activate: watchOS 11 speaker satisfies longFormAudio](https://developer.apple.com/documentation/avfaudio/avaudiosession/activate(options:completionhandler:).md) · [Playing background audio (watchOS)](https://developer.apple.com/documentation/watchkit/playing-background-audio.md)
- [Taking advantage of notification forwarding](https://developer.apple.com/documentation/watchos-apps/taking-advantage-of-notification-forwarding.md) · [Apple engineer on watch/iPhone notification dedupe](https://developer.apple.com/forums/thread/737026)
- [UNNotificationServiceExtension (watchOS 6+)](https://developer.apple.com/documentation/usernotifications/unnotificationserviceextension) · [CryptoKit SecureEnclave (watchOS 6+)](https://developer.apple.com/documentation/cryptokit/secureenclave) · [DCAppAttestService (watchOS 9+)](https://developer.apple.com/documentation/devicecheck/dcappattestservice) · [Critical Alerts entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.usernotifications.critical-alerts)
- [Displaying live data with Live Activities (8 h/12 h, 4 KB, watch alert behaviour)](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities) · [ActivityKit push notifications (priority 5/10, frequent updates, channels)](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications) · [WWDC24 "Bring your Live Activity to Apple Watch" notes](https://wwdcnotes.com/documentation/wwdc24-10068-bring-your-live-activity-to-apple-watch/) · [ActivityFamily `.small`](https://developer.apple.com/documentation/widgetkit/activityfamily.md)
- [Updating widgets with WidgetKit push notifications](https://developer.apple.com/documentation/widgetkit/updating-widgets-with-widgetkit-push-notifications) · [WWDC25 widgets notes](https://wwdcnotes.com/documentation/wwdc25-278-whats-new-in-widgets/) · [What's new in watchOS 26](https://developer.apple.com/watchos/whats-new) · [WWDC25 watchOS group lab Part 2](https://developer.apple.com/forums/thread/791562)
- [WCSession sendMessage (watch wakes iPhone app)](https://developer.apple.com/documentation/watchconnectivity/wcsession/sendmessage(_:replyhandler:errorhandler:)) · [transferCurrentComplicationUserInfo](https://developer.apple.com/documentation/watchconnectivity/wcsession/transfercurrentcomplicationuserinfo(_:))
- [Enabling double tap / primaryAction](https://developer.apple.com/documentation/watchos-apps/enabling-double-tap.md) · [Always On state design](https://developer.apple.com/documentation/watchos-apps/designing-your-app-for-the-always-on-state.md) · [Return to Clock setting](https://support.apple.com/guide/watch/apd748b87e2a/watchos)
- [watchOS 27 features (MacRumors)](https://www.macrumors.com/2026/06/08/watchos-27-features-dynamic-app-grid-new-and-more/) · [watchOS 27 WWDC coverage (IT之家)](https://www.ithome.com/0/961/701.htm)
- [What's new in Wear OS 7](https://android-developers.googleblog.com/2026/05/whats-new-wear-os-7.html) · [Wear OS 7 features](https://developer.android.com/training/wearables/versions/7/features) · [Wear OS Live Updates](https://developer.android.com/training/wearables/notifications/live-updates) · [What's new in Wear OS 6](https://android-developers.googleblog.com/2025/05/whats-new-in-wear-os-6.html)
- [Wear OS network access + FCM](https://developer.android.com/training/wearables/data/network-access) · [Wear OS notification bridging](https://developer.android.com/training/wearables/notifications/bridger) · [Data Layer client types](https://developer.android.com/training/wearables/data/client-types) · [Wear OS audio](https://developer.android.com/training/wearables/apps/audio) · [Wear OS authentication](https://developer.android.com/training/wearables/apps/auth-wear) · [Expose data to complications](https://developer.android.com/training/wearables/complications/exposing-data)
- [Play foreground service types (connectedDevice lists baby monitors)](https://support.google.com/googleplay/android-developer/answer/16965181) · [Android 14 FGS types](https://developer.android.com/about/versions/14/changes/fgs-types-required)
- [FCM Live Activity support](https://firebase.google.com/docs/cloud-messaging/customize-messages/live-activity) · [Firebase watchOS community support](https://cdn.jsdelivr.net/gh/firebase/firebase-ios-sdk@main/README.md) · [workerd#6455 HTTP/2 from Workers](https://github.com/cloudflare/workerd/issues/6455) · [cloudflare-apns2 (unverified)](https://jsr.io/@fivesheepco/cloudflare-apns2) · [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)