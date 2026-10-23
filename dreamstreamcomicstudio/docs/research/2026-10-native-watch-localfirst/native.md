# Native app architecture: DreamStream / Stream Studio on iOS, Android, Apple Watch and Wear OS

## 1. Decision

**Option (a), with a native core.** Build the phone apps with **Expo (React Native)**. Write the watch apps **fully native**, and put the parts that must be native into Expo modules.

| Layer | Choice |
|---|---|
| Phone apps (iOS + Android) | **Expo SDK 58 / React Native 0.88 / React 19.3** (current `expo@58.0.17`, Oct 2026). Expo regenerates the native projects; no `ios/` or `android/` folders are committed. Navigation with expo-router. |
| WebRTC | **`react-native-webrtc` 155.0.x** (libwebrtc M155, released 2026‑10‑20) plus `@config-plugins/react-native-webrtc` 15.x. Fallback pin is 124.0.8. It has `setCodecPreferences`, data channels, Unified Plan, simulcast and iOS PiP. **Native hook for audio:** `WebRTCModuleOptions.audioDevice` (iOS `RTCAudioDevice`) and `.audioDeviceModule` (Android `JavaAudioDeviceModule`). This one hook lets the camera capture without noise suppression and taps raw audio for the AI. Do not use `@livekit/react-native-webrtc`: its README says not to use it on its own. |
| Native Expo modules (Swift + Kotlin) | `ds-media` (audio device, YAMNet, dB meter, frame tap to JPEG, thermal/battery, keep-awake/dim); `ds-alerts` (notification categories, time-sensitive/critical alerts, alarm playback, Live Activity, CallKit/PushKit, Android Telecom, push tokens); `ds-local` (Bonjour/NSD, local signaling, Secure Enclave/StrongBox device keys); `ds-watch` (WatchConnectivity / Wear Data Layer). |
| Apple Watch | **SwiftUI watch app** (watchOS 10+) through **`@bacons/apple-targets` 5.0** (`watch`, `watch-widget`, `widget` for Live Activities, `notification-service`), with `targets/_shared` for Swift models shared between the iPhone app and the extensions. |
| Wear OS | **Separate Gradle project, Kotlin + Compose for Wear OS 1.6.** Same applicationId and signing key as the phone app (required for the Data Layer). Tile now, Wear Widget later, plus a complication and Live Updates. |
| Web PWA | Stays as is, for desktop, share-link guests and as a fallback. All clients use the same WebSocket protocol. |

**Why not (b) Capacitor.**
- WebRTC would run inside WKWebView or Android WebView. There we cannot inject an audio device module (needed for capture without noise suppression and for the raw-audio tap).
- WebKit pauses camera and mic capture when the app goes to the background, so the iOS camera phone would stop hearing cries. This is the same problem the PWA has today (`CamStatus.paused: 'hidden'`).
- CallKit/PushKit, Live Activities, the watch bridge and Android foreground services all need native code anyway. We would end up with two media stacks.

**Why not (c) fully native phones.**
- Two UI codebases plus rewriting about 4k lines of pure TypeScript logic in both Swift and Kotlin (protocol, soundBrain, soundClasses, trackerScience, videoBudget, scene/vision/motion, linkFallback, whoGrowth, calls/types and their tests). That is too much for one person.
- Option (a) still allows moving any hot path into Swift/Kotlin modules one piece at a time.

**What the repo shows.** These files use no browser APIs and port as they are: `protocol.ts`, `calls/types.ts`, `soundBrain.ts`, `soundClasses.ts`, `videoBudget.ts`, `scene.ts`, `vision.ts`, `motion.ts`, `linkFallback.ts`, `resample.ts`, `trackTypes.ts`, `whoGrowth.ts`, and `trackerScience.ts` (two browser-API mentions). `rtc.ts`, `callMesh.ts` and `callCenter.ts` use the standard `RTCPeerConnection` API, which `react-native-webrtc` provides through `registerGlobals()`. Only the getUserMedia, WebAudio (`voice.ts`, `soundLevel.ts`, `soundEngine.ts`) and storage parts need adapters.

## 2. Platform facts behind the design (2026)

- **watchOS networking (TN3135).**
  - Normal HTTP(S) through `URLSession` is allowed for every app.
  - **`URLSessionWebSocketTask`, Network.framework and Bonjour are blocked.** The exceptions are an app actively streaming audio, a CallKit VoIP call, or a tvOS DeviceDiscoveryUI connection.
  - **The simulator always allows low-level networking**, so CI cannot catch this.
  - Consequence: no WebSocket and no WebRTC on the watch. The watch reads status over HTTPS or from the iPhone via WatchConnectivity.
- **Live Activities.**
  - They appear automatically in the Apple Watch Smart Stack; add `supplementalActivityFamilies([.small])` for a watch layout.
  - Limits: 8 hours active, then up to 4 more hours on the Lock Screen; 4 KB of data.
  - Starting one needs the app in the foreground, unless it uses `LiveActivityIntent` or a push-to-start notification (iOS 17.2+).
  - An `AlertConfiguration` shows its title and body on the paired watch.
- **iOS camera in the background.**
  - The camera is interrupted when the app goes to the background.
  - `isMultitaskingCameraAccessEnabled` only covers multitasking (PiP / Split View). It defaults to on for VoIP apps linked against iOS 18+.
  - Apple's technical support advises against declaring the VoIP background mode in an app that isn't really a VoIP app.
  - Decision: **the iOS camera phone runs in the foreground** (Guided Access, idle timer off, black "night screen", must be on the charger). If it is backgrounded, **audio + AI keep running** under the `audio` background mode and video shows as paused.
- **Background audio on iOS (Guideline 2.5.4)** is for audible content. Playing silence to stay alive gets rejected. So the parent app has two modes:
  - **"Sound on"**: plays nursery audio, stays alive, and can sound its own alarm even with the silent switch on.
  - **"Sound off"**: suspended; relies on push.
- **Android foreground services.**
  - Since Android 14, camera and microphone services must be **created while an activity is visible**, or from a notification or widget tap. Starting them from the background throws.
  - Starting from `BOOT_COMPLETED` is restricted, so after a reboot we post a "Tap to resume nursery camera" notification. A notification tap is an allowed exception.
  - Each service type needs its matching `FOREGROUND_SERVICE_*` permission and a Play Console declaration.
- **Full-screen intents** (Android 14+) are granted by default only to calling or alarm apps. We qualify because of family calls; declare it.
- **Android local network.**
  - Mandatory for apps targeting **API 37 (Android 17)**: `ACCESS_LOCAL_NETWORK`, or NSD with `FLAG_SHOW_PICKER` (no permission needed).
  - At target 36 during the opt-in period, the permission is `NEARBY_WIFI_DEVICES`.
  - iOS needs `NSLocalNetworkUsageDescription` and `NSBonjourServices`.
- **Store requirements.**
  - Apple: since **28 Apr 2026**, uploads must be built with Xcode 26 and the iOS/watchOS 26 SDKs.
  - Google Play: **API 36 for new apps and updates from 31 Aug 2026** (extension possible to 1 Nov). Wear OS needs **API 35**, and Wear apps must support **64-bit devices from 15 Sep 2026**.
- **APNs from Cloudflare Workers.** APNs needs HTTP/2, and the Workers runtime itself (workerd) doesn't speak it. A Cloudflare engineer said in Aug 2025 that production requests go through Cloudflare's proxy, which "apparently" upgrades them to HTTP/2, but this is not guaranteed.
  - Decision: **send to APNs directly from the Durable Objects.** Add a probe in Phase 0 that checks for a 200 response and an `apns-id` header.
  - Fallbacks: FCM HTTP v1 for iOS alerts and Live Activities (supported), or the Container. VoIP pushes have to go directly to APNs because FCM can't send them.
- **Critical alerts.** Request form: `developer.apple.com/contact/request/notifications-critical-alerts-entitlement/`, submitted by the Account Holder. Apple reviews by hand and approves health, safety and security cases only; rejections are common. **Assume we won't get it.**
- **Wear OS.**
  - Network traffic goes through the phone over Bluetooth when connected; for heavy traffic, request Wi-Fi with `requestNetwork`.
  - FCM is the recommended way to send notifications to a watch.
  - **Wear OS 7** (Android 17): Live Updates replace Ongoing Activities. Phone Live Updates bridge to the watch only on OEMs that support it. Wear Widgets (Glance + RemoteCompose) are the successor to Tiles; Tiles remain supported for now.
- **CI.**
  - `macos-26` runners have been generally available since Feb 2026, with Xcode 26.6 and watchOS simulators; Xcode 27 is on a separate image.
  - Hosted runners are free for public repos.
  - Hardware-accelerated Android emulators run on hosted Linux runners with 2 or more vCPUs (needs a KVM udev rule step).
  - Note: workflows under `dreamstreamcomicstudio/.github/` never run; only `/home/user/Comic2/.github/workflows` counts.
- **Google Play testing rule.** Personal accounts created after 13 Nov 2023 must run a closed test with **12 testers for 14 days** before going to production. **Organization accounts are exempt.**

## 3. Capability design

**WebRTC + TURN**
- Reuse the logic in `rtc.ts` unchanged: offer/answer roles, the per-viewer quality ladder, `orderCodecs` (H.264 first, which is hardware-encoded on both platforms), `classifyPath`, and the relay fallback (`linkFallback.ts`).
- TURN credentials come from `live-worker/src/ice.ts` as today.
- Platform extras: viewer PiP on iOS (built into `react-native-webrtc`) and Android.

**Parent phone listening in the background**
- iOS "Sound on": `UIBackgroundModes: audio`, audio session set to playAndRecord/videoChat, the WebSocket and peer connection stay alive.
  - The app plays the alarm itself, so it is heard even on silent.
  - The app updates the Live Activity locally, so no push is needed.
- Android "Sound on": `mediaPlayback` foreground service.
- "Sound off" on both platforms: push only.

**The camera phone**
- iOS: foreground plus Guided Access guide (users enable it with a triple-click), idle timer off, OLED-safe night screen (brightness down, black overlay with a slowly moving clock).
  - Watch `ProcessInfo.thermalState` and feed it into the existing `videoBudget` ladder.
  - Require charging and push an alert to parents if it is unplugged.
  - When interrupted, keep capturing audio and run AI in the background, and set `paused`.
- Android: `foregroundServiceType="camera|microphone"` started from the "Start camera" tap.
  - A permanent "Nursery camera is on" notification, which is also a privacy signal.
  - Partial wake lock, optional screen pinning, resume after reboot through the notification tap.

**On-device sound AI**
- Run the **same pinned YAMNet ONNX** model natively with ONNX Runtime Mobile (Core ML acceleration on iOS).
- Bundle the 16 MB model in the app: no CDN download, and the Hugging Face fallback goes away. Keep the SHA-256 check when loading.
- Audio comes from the injected audio device, configured like the web app's `camera.ts`: echo cancellation on, noise suppression off, auto gain off.
- Native code computes A-weighted dB / Leq (port `soundLevel.ts`) and sends YAMNet scores at about 1 Hz to JavaScript. The fusion logic (`soundBrain` + `scoreRows`) stays shared TypeScript.
- A native watchdog reports "monitoring degraded" if JavaScript stops responding.
- Keep behaviour identical across platforms with golden fixtures: WAV files run through the TypeScript pipeline produce JSON that XCTest and JUnit then check against.

**Push**
- iOS:
  - Direct APNs with an ES256 JWT. The worker already does ES256 signing for VAPID in `webpush.ts`.
  - Push types: `alert` (time-sensitive, plus critical if approved), `liveactivity` (update and push-to-start, to restart the 8-hour Activity overnight), and `voip` (PushKit → CallKit, for family calls only).
  - Encrypt payloads end to end: the Notification Service Extension decrypts them with a per-device key kept in a shared Keychain group, so Apple/Google never see "Aria is crying". Only the critical-sound flag stays readable.
- Android and Wear OS:
  - FCM HTTP v1 with a service-account JWT cached in the Durable Object.
  - High-priority, encrypted data messages; the app builds the notification itself.
  - Channels: "Urgent" (alarm-usage sound), "Calls" (CallStyle notification + full-screen intent), "Status" (promoted Live Update; needs `POST_PROMOTED_NOTIFICATIONS` + `requestPromotedOngoing`).
- Backend change:
  - Extend `push_sub` in the MonitorRoom and UserLine Durable Objects with `{kind: 'webpush' | 'apns' | 'apns-voip' | 'apns-la' | 'fcm', token, dev}`.
  - APNs and FCM cost nothing.

**Local option ("Home only" toggle, plus local-first by default)**
- Pair once with a QR code containing the camera's device public key and a one-time secret.
- Discovery: Bonjour/NSD `_dsmonitor._tcp`.
- Signaling: a local listener on the camera (iOS `NWListener`; Android NSD + socket) over an authenticated channel (Noise or TLS-PSK).
- Media: WebRTC with `iceServers: []`; alerts go over the data channel.
- "Auto" mode uses local signaling whenever both devices see each other on the LAN, and the cloud otherwise. This saves Durable Object traffic.
- "Home only" turns off the cloud completely. iOS alerts while suspended then need **Local Push Connectivity** (`NEAppPushProvider`, app-push-provider entitlement, Wi-Fi networks matched by SSID).

**Security hooks for native**
- Session tokens in Keychain (`AfterFirstUnlockThisDeviceOnly`) or Android Keystore.
- Device keys that cannot be exported (Secure Enclave / StrongBox), registered per nursery.
  - Socket authentication = Supabase token **plus** a signed challenge, so a stolen token alone is useless.
  - The DTLS fingerprints in the SDP are signed by device keys, so even a compromised server cannot sit in the middle of the video.
- App Attest / Play Integrity checked once, when a device enrolls.
- `FLAG_SECURE` on Android video screens and `UIScreen.isCaptured` handling on iOS, to stop screenshots and screen recording of the feed.
- No leaf-certificate pinning on HTTPS.

## 4. Watch apps (clutter-free)

**One small payload everywhere: GlanceV1, under 1 KB.** The same shape feeds the Live Activity state, the WatchConnectivity context, the Wear Data Layer, push payloads and the HTTPS glance endpoint:

```
{v:1, nid, baby, state:'calm'|'stirring'|'awake'|'noisy'|'fussing'|'crying'|'offline', since,
 sleep:{phase, asleepMin, wakings}, db, cam:{on, batt, charging, paused},
 inc:{id, kind, sev, title, status, at}|null, duty, snapAt, net:'local'|'lan'|'internet'|'relay'}
```

Fixtures live in `packages/monitor-core/fixtures/glance/*.json` and are tested in vitest, XCTest (Codable) and JUnit (kotlinx.serialization).

**Apple Watch**
- **Screen 1:** a full-bleed ring in the state colour, one large word ("Calm" / "Crying"), and one line ("Asleep 2h 14m · 34 dB"). Nothing else.
- **Crown scroll to "Peek":** a 320 px JPEG at up to 1 fps, labelled "2 s ago".
- **Bottom actions:** **I'm on it** (acknowledge) and **Soothe**. Double-tap is mapped to the primary action.
- **Complications** in circular, corner and inline sizes, plus the Smart Stack Live Activity.
- **Actionable notifications:** acknowledge and soothe straight from the notification, with haptics.
- **Data path:**
  1. WatchConnectivity from the iPhone app: state about once a second, and snapshots via `sendMessageData` only while the watch app is open. The iPhone app downscales frames from its WebRTC track.
  2. Otherwise HTTPS with `URLSession`: `GET /api/monitor/:nid/glance` and `GET /snap`. The camera uploads small JPEGs to the Durable Object only while someone is asking (reuses the relay-JPEG path and `relay_want`).
  3. In "Home only" mode, WatchConnectivity only.
- **Auth:** the watch never holds a Supabase refresh token. The phone gets a **watch token** from `POST /api/monitor/:nid/watch-token`: scopes glance/ack/soothe/snap, 12-hour lifetime, signed by the Durable Object, refreshed via `transferUserInfo`.
- **Not in v1:** listening on the watch. It would need long-form audio and an eligible output route, which is Bluetooth, and possibly the Series 10 / Ultra 2 speaker (unverified for third-party apps).

**Wear OS**
- Same screens, built with Compose M3 Expressive.
- A Tile now, migrating to a Wear Widget for Wear OS 7.
- A complication data source and a Live Update while monitoring.
- Data: from the phone app via the Data Layer when it is running; otherwise direct OkHttp HTTPS/WebSocket (Wear OS allows it) with its own FCM token.
- Use bridging tags so phone and watch don't show duplicate notifications.

## 5. Repo layout

Paths are under `/home/user/Comic2/dreamstreamcomicstudio/`.

```
packages/monitor-core/      # pure TS moved from live/monitor + live/calls (protocol, calls/types, soundBrain,
                            # soundClasses, trackerScience, videoBudget, rtc ladder/codec/path logic, glance.ts)
                            # + fixtures/ ; imported by live/ (web), apps/mobile AND live-worker
                            # (ends the manual "keep in sync" mirror in protocol.ts)
packages/glance-kotlin/     # kotlinx.serialization models; included in apps/wearos + the Expo Android
                            # module via includeBuild
apps/mobile/                # Expo SDK 58
  app/                      # expo-router screens: Nurseries, Viewer, Camera, Alerts, Settings
  modules/ds-media|ds-alerts|ds-local|ds-watch/   # Expo modules (Swift/Kotlin)
  targets/_shared/          # GlanceV1.swift, MonitorActivityAttributes.swift
  targets/watch/ watch-widget/ widget/ notification-service/
  plugins/                  # local config plugins (foreground services, entitlements, Info.plist, NSE keychain group)
  maestro/                  # E2E flows
apps/wearos/                # Gradle: app (Compose for Wear), tile, complication
```

**Long-tail screens** (Tracker, reports, analytics, people, share links, guides): reuse the existing React DOM components through **Expo DOM components** (`'use dom'`; `@expo/dom-webview` is the default from SDK 56). They are bundled offline in the app. Don't count on updating them over the air.

## 6. Releases

| Release | Contents |
|---|---|
| **R1** (about 8–10 weeks) | iOS + Android phone apps: email/password sign-in (no social login, so Sign in with Apple is not required), nursery list, **Viewer** (P2P + TURN + relay, PiP, talk), **Sound on / Sound off**, APNs/FCM alerts (time-sensitive, critical if approved) with acknowledge, **Live Activity** (and the watch Smart Stack) and an Android Live Update, **Camera mode** (Android foreground service, iOS night screen), native YAMNet + dB. **Apple Watch app v1**: glance, complications, actionable notifications, Peek. Shipped via TestFlight and Play internal testing. |
| **R1.1** | Wear OS app (tile, complication, glance, actions), plus DOM-component tracker and reports. |
| **R2** | "Home only" local mode (pairing, mDNS, local signaling, Local Push Connectivity), family calls with CallKit/PushKit and Android Telecom, native vision (MediaPipe Tasks, same `.task` models). |

**Phase 0** (1–2 weeks, web and worker, before R1):
- Extract `monitor-core`.
- Glance and watch-token endpoints.
- APNs and FCM senders plus the APNs HTTP/2 probe.
- Push-token registry and device-key groundwork.
- CI skeleton building an empty Expo app with the watch target, and the Wear project.

## 7. CI vs real device

Workflows go in `/home/user/Comic2/.github/workflows/mobile-*.yml`.
- Pin actions by SHA.
- Release secrets live only in protected `ios-release` / `android-release` environments that require a reviewer.
- Never use `pull_request_target`.
- Require approval before fork PRs can use macOS minutes.

| What | Where | Device needed? |
|---|---|---|
| `monitor-core` vitest, glance fixtures, tsc | ubuntu (and this container) | No |
| jest-expo unit tests, expo-doctor, `expo prebuild` config-plugin checks | ubuntu (prebuild also runs in this container) | No |
| Android debug/release AAB, Kotlin module unit tests (Robolectric), lint | ubuntu | No |
| Android emulator (API 35/36, KVM): **WebRTC loopback** (two peer connections in one process, synthetic camera, H.264 + data channel), foreground service start/stop, notification channels, Maestro smoke tests | ubuntu + android-emulator-runner | No |
| Wear OS assemble, unit tests, Roborazzi screenshot tests (round and square) | ubuntu (JVM) | No |
| iOS simulator build, XCTest (YAMNet golden WAVs, dB parity, Codable), Maestro iOS (synthetic camera, since the simulator has none) | macos-26 | No |
| watchOS build, XCTest, swift-snapshot-testing of watch, complication and Live Activity views (all case sizes, always-on dimming, large Dynamic Type) | macos-26 | No |
| Signed archive → TestFlight (App Store Connect API key, `-allowProvisioningUpdates`, upload with fastlane/altool); AAB → Play internal and Wear tracks | macos-26 / ubuntu, protected environments | No |

**Needs a real device:**
- Real camera and hardware encoder, heat, and an overnight 10-hour soak.
- Surviving in the background when locked; Android Doze and OEM battery killers.
- Real APNs/FCM delivery, critical alerts, Live Activity in the watch Smart Stack.
- **Watch networking restrictions** (the simulator allows everything).
- The Local Network permission prompt and mDNS on real Wi-Fi.
- Carrier NAT and TURN.
- AirPods / Bluetooth audio routes.
- Wear phone-proxy behaviour.

Without a Mac: install via TestFlight (the watch app comes with the iPhone app), Play internal testing, and Wear sideloading over `adb`. Crash reports are free through Xcode Organizer and Android vitals.

## 8. Owner actions (in order of lead time)

1. **Legal entity → D-U-N-S number** (free, about 1–2 weeks). Then **Apple Developer Program as an Organization** ($99/yr) and **Google Play Console as an Organization** ($25). The organization account skips the 12-testers-for-14-days rule. If you enroll as an individual instead, recruit 12 testers.
2. Apple identifiers. Suggested: `ai.dreamstreamstudio.streamstudio` with `.watchkitapp`, `.widgets`, `.notifications`; App Group `group.ai.dreamstreamstudio.streamstudio`; a Keychain sharing group. Capabilities: Push, **Time Sensitive Notifications** (self-serve), App Groups, Associated Domains, Background Modes (audio, voip, remote-notification). Later: Network Extension app-push-provider. Reserve the App Store name early ("Stream Studio" may be taken).
3. **APNs auth key (.p8)**: give Key ID and Team ID → Worker secrets `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`.
4. **App Store Connect API key** (Admin role for the first certificate) → GitHub environment secrets.
5. **Critical alerts request** (Account Holder, after the bundle ID exists). Justification: an unanswered infant cry that escalates, a smoke/CO alarm sound detected in the nursery, the nursery camera going offline overnight, the baby leaving the crib zone.
6. **Firebase project** (free plan): add the Android app (Wear shares the package), `google-services.json`, a service account with the FCM role → Worker secret `FCM_SA_JSON`.
7. **Play Console:** Play App Signing; generate the upload key on your own machine; declarations for foreground services (camera, microphone, mediaPlayback, plus a call type) **with demo videos**, full-screen intent (calling), Data safety, add the Wear OS form factor. Play Developer API access for CI through **Workload Identity Federation** (no JSON key stored).
8. Serve `/.well-known/apple-app-site-association` and `assetlinks.json` on dreamstreamstudio.ai so `/join/<nursery>/<code>` links open the app.
9. Test devices: a spare iPhone on iOS 17+ (camera), an iPhone and an Android phone (viewers), an Apple Watch on watchOS 10+ (ideally a Series 10 or Ultra 2), a Wear OS 5/6 watch (Pixel Watch or Galaxy Watch).
10. GitHub: create the `ios-release` and `android-release` environments with a required reviewer.

## 9. Main risks and mitigations

| Risk | Mitigation |
|---|---|
| `react-native-webrtc` 155 is a week old; the config plugin's compatibility table only lists Expo 56 + 124.0.7 | Pin versions; the CI loopback test gates upgrades; fall back to 124.0.8. |
| APNs over Workers HTTP/2 not guaranteed | Phase 0 probe, with fallbacks to FCM-for-iOS or the Container. |
| Critical alerts denied | "Sound on" in-app alarm, time-sensitive pushes, repeat pushes and escalation to the next family member (incidents/duty already exist). |
| App Review on background audio | Never play silence; include a review video and notes. |
| iOS camera has to stay in the foreground | Make this an explicit product choice (night screen + Guided Access), with audio continuing as the fallback. |
| Expo SDK churn | Two SDK upgrades a year, each validated in CI. |

## Sources

- [Expo SDK 58 beta changelog](https://expo.dev/changelog/sdk-58-beta) · [Expo SDK 55](https://expo.dev/changelog/sdk-55) · [Expo DOM components](https://docs.expo.dev/guides/dom-components/) · npm registry (`expo@58.0.17` bundledNativeModules, `react-native-webrtc@155.0.1`, `@config-plugins/react-native-webrtc@15.0.2`, `@bacons/apple-targets@5.0.0`)
- [react-native-webrtc](https://github.com/react-native-webrtc/react-native-webrtc) · [expo-apple-targets watch apps](https://mintlify.wiki/EvanBacon/expo-apple-targets/targets/watch-apps)
- [TN3135: Low-level networking on watchOS](https://developer.apple.com/documentation/technotes/tn3135-low-level-networking-on-watchos) · [longFormAudio route policy](https://developer.apple.com/documentation/avfaudio/avaudiosession/routesharingpolicy-swift.enum/longformaudio) · [Apple Watch audio destinations](https://support.apple.com/guide/watch/apd0110baf0e/watchos)
- [Displaying live data with Live Activities](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities) · [WWDC24: Bring your Live Activity to Apple Watch](https://developer.apple.com/videos/play/wwdc2024/10068) · [ActivityFamily](https://developer.apple.com/documentation/widgetkit/activityfamily)
- [isMultitaskingCameraAccessEnabled](https://developer.apple.com/documentation/avfoundation/avcapturesession/ismultitaskingcameraaccessenabled) · [Multitasking camera / PiP forum thread](https://developer.apple.com/forums/thread/850209) · [Background Modes (Stream)](https://getstream.io/video/docs/ios/advanced/background-modes/)
- [Critical alerts entitlement guide](https://newly.app/articles/critical-alerts-entitlement) · [Critical alerts forum thread](https://developer.apple.com/forums/thread/690030) · [Guideline 2.5.4 audio thread](https://developer.apple.com/forums/thread/95216)
- [Local Push Connectivity on iOS 26 thread](https://developer.apple.com/forums/thread/801051) · [Watch remote notifications](https://developer.apple.com/documentation/watchos-apps/enabling-and-receiving-notifications)
- [workerd issue #4841 (APNs HTTP/2)](https://github.com/cloudflare/workerd/issues/4841) · [cloudflare-apns2](https://github.com/FiveSheepCo/cloudflare-apns2) · [FCM Live Activity](https://firebase.google.com/docs/cloud-messaging/customize-messages/live-activity)
- [Android foreground service background-start restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) · [Declare foreground services](https://developer.android.com/develop/background-work/services/fgs/declare) · [Foreground service / full-screen intent Play requirements](https://support.google.com/googleplay/android-developer/answer/13392821) · [Full-screen intent limits](https://source.android.com/docs/core/permissions/fsi-limits)
- [Android local network permission](https://developer.android.com/privacy/local-network-permission) · [Live Update notifications](https://developer.android.com/develop/ui/views/notifications/live-update)
- [Wear OS network access](https://developer.android.com/training/wearables/data/network-access) · [Wear OS 6 features](https://developer.android.com/training/wearables/versions/6/features) · [What's new in Wear OS 7](https://android-developers.googleblog.com/2026/05/whats-new-wear-os-7.html)
- [Play target SDK requirements](https://developer.android.com/google/play/requirements/target-sdk) · [Apple SDK minimum requirements](https://developer.apple.com/news/upcoming-requirements/) · [Play 12-tester rule (2026)](https://extendsclass.com/blog/google-plays-closed-testing-requirement-what-developers-need-to-know-in-2026)
- [macOS 26 runners GA](https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/) · [runner-images macos-26 release notes](https://newreleases.io/project/github/actions/runner-images/release/macos-26%2F20260805.0449) · [Android emulator acceleration on hosted runners](https://github.blog/changelog/2024-04-02-github-actions-hardware-accelerated-android-virtualization-now-available/) · [android-emulator-runner](https://github.com/ReactiveCircus/android-emulator-runner) · [GitHub Actions pricing update](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/) · [xcodebuild CI signing thread](https://developer.apple.com/forums/thread/764554)

Repo files read: `/home/user/Comic2/dreamstreamcomicstudio/live/monitor/protocol.ts`, `/home/user/Comic2/dreamstreamcomicstudio/live/calls/types.ts`, `/home/user/Comic2/dreamstreamcomicstudio/live/monitor/rtc.ts`, `/home/user/Comic2/dreamstreamcomicstudio/live/monitor/client.ts`, `/home/user/Comic2/dreamstreamcomicstudio/live/monitor/yamnet.worker.ts`, `/home/user/Comic2/dreamstreamcomicstudio/live/monitor/push.ts`, `/home/user/Comic2/dreamstreamcomicstudio/live/monitor/camera.ts`, `/home/user/Comic2/dreamstreamcomicstudio/live-worker/src/index.ts`, `/home/user/Comic2/dreamstreamcomicstudio/live-worker/src/webpush.ts`, `/home/user/Comic2/dreamstreamcomicstudio/live-worker/src/ice.ts`, `/home/user/Comic2/.github/workflows/ci.yml`.