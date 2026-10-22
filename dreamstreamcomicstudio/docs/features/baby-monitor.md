# Baby Monitor (Stream Studio)

A private, never-recording baby monitor inside Stream Studio (`/live#/monitor`).
One device in the nursery is the **camera**; any device the family signs in on can
**watch**. Video and sound go peer-to-peer (WebRTC, DTLS-SRTP, end-to-end
encrypted); the server relays signaling, status numbers and events — and, only for
a viewer the direct picture can't reach (or while it connects), the relay picture
and sound, passed through its memory and never stored (see *Relay picture* below).

## Pieces

| Piece | Where | What it does |
|---|---|---|
| Nurseries, people, roles | Supabase RPCs (`server/sql/live_accounts_and_monitor.sql`) | Members only; Parent / Caregiver / Viewer with labels ("Grandma"). |
| MonitorRoom | `live-worker/src/monitorRoom.ts` (Durable Object per nursery) | Socket auth via `monitor_my_role`, signaling relay, status fan-out, log, incidents + escalation, on-duty routing, sleep tracking + morning report, history queries, CSV export, camera heartbeat/offline alerts, Web Push. |
| Room database | `live-worker/src/monitorStore.ts` (the DO's own SQLite) | `events`, `minutes` (one row per camera-minute), `incidents`, `sleep` — 90 days of events, 31 days of minutes. Unit-tested against sql.js. |
| Sleep tracker | `live-worker/src/sleepTracker.ts` | Actigraphy-style state machine over minute rows (crib movement, sound, lights, visits): settling → asleep → stirring → awake, wakings, self-settles, naps vs night by local time. |
| Camera screen | `live/views/MonitorCamera.tsx` | Setup wizard (browser check, permissions, lens picker, zoom, live checks), FaceTime-style running screen, auto-dim, privacy pause, interruption recovery. |
| Device plumbing | `live/monitor/camera.ts` | In-app browser detection, friendly lens names, constraint ladder, human error text, zoom, iOS `audioSession` for speaker playback. |
| Peer links | `live/monitor/rtc.ts` | Viewer offers `video sendrecv` + `audio sendrecv`; outgoing tracks swapped with `replaceTrack` (talk / video call on & off with no renegotiation). One camera connection per viewer *session* (call id + viewer id), H.264 preferred, an encoding ladder by audience and phone load — see “Video with many viewers” below. |
| Relay picture | `live/monitor/relay.ts` (WebCodecs encoder / decoder), `relayWire.ts` (wire format), `relayAudio.ts` (μ-law + AudioWorklet), `linkFallback.ts` (viewer state machine), `live-worker/src/relayWire.ts` (room's header reader) | When P2P can't connect (no TURN), while it connects (instant picture), or when the camera's direct slots are full: real video through the room (H.264 / VP8 / VP9, 640 px, 10–15 fps, with sound), JPEG for browsers without WebCodecs. Not end-to-end encrypted; never stored. |
| Sound engine | `live/monitor/soundEngine.ts` | Mic → analyser (cry analyser 10 Hz, alarm pattern 20 Hz) and PCM tap → 16 kHz resampler → YAMNet worker every 0.48 s → `SoundBrain`. |
| AI sound model | `live/monitor/yamnet.worker.ts`, `public/models/yamnet/` | Google YAMNet (Apache-2.0, 521 AudioSet classes) via onnxruntime-web WASM, single-threaded, SHA-256 verified, cached. |
| Categories | `live/monitor/soundClasses.ts` | cry, fuss, cough, sneeze, snore, babble, laugh, alarm, glass, crash, loud, voices, music, dog, cat, knocking, footsteps, running water — YAMNet class weights, rival classes, thresholds, severities. |
| Fusion | `live/monitor/soundBrain.ts` | Persistence, hysteresis, loudness gating, priority masking, the cat-vs-cry guard, cooldowns → start/end events + mood. `ongoing()` replays what's happening for a room that missed the start. |
| Sound level meter | `live/monitor/soundLevel.ts` | IEC 61672 A-weighting (bilinear biquads) + Fast (125 ms) time weighting in an AudioWorklet; live dB(A), per-minute LAeq / Lmax / L10 / L50 / L90 / peak; two-step calibration (quiet room ≈ 30 dB, or match a meter); never reads below the mic's floor. |
| Vision | `live/monitor/vision.ts` | 64×48 frames at 4 fps: exposure-normalised cell differences, crib + danger zones, climb-out, visits, lights on/off, dark/covered lens, camera moved (scene signature + phone tilt). |
| Smart vision (beta) | `live/monitor/scene.ts`, `live/monitor/sceneAi.ts`, `public/models/mediapipe/` | On the camera phone, ~1 fps: Google MediaPipe object detector (EfficientDet-Lite0 int8, 80 COCO classes, CPU) + pose landmarker (BlazePose lite, 33 points, GPU with CPU fallback), both Apache-2.0, SHA-256 verified. `SceneWatch` turns frames into held, cooled-down events: posture, stood in crib, rolled, holding, risky object within reach, soft toy near a lying baby, in/left a play area. |
| Family calls | `live-worker/src/familyCalls.ts` (rules), `monitorRoom.ts` (switchboard), `directCalls.ts` + `userLine.ts` + `callRoom.ts` (direct calls), `live/calls/*` (app), `live/views/calls/*`, `live/views/CallsView.tsx` | FaceTime-style video / voice calls between a nursery's members — or with anyone on Stream Studio, found by name — see “Family calls” below. |
| Two-way audio safety | `live/monitor/voice.ts` | Parent's mic: high-pass → compressor → soft fade-in. Camera: howl (feedback) detector mutes the speaker and switches the parent's phone to walkie-talkie; a closed-loop governor holds talk ≤ 65 dB and soothing sounds ≤ 50 dB at the crib. |
| Screen-on | `live/wakeLock.ts`, `public/keep-awake.mp4` | Wake Lock re-acquired on release + 15 s watchdog; looping-video fallback where it's refused; state shown to the family. |
| Alarm detector | `live/monitor/alarmTone.ts` | Smoke (T3) / CO (T4) beep patterns from the spectrum — independent of the model. |
| Viewer screen | `live/views/MonitorViewer.tsx` + `live/views/monitor/*` | Listen / talk (tap or hold) / video call / soothe, alert stack + stage glow + alarm takeover, Safety card (incidents, guards, duty), Sleep card + morning report, Sound level card (live + 1/6/24 h history), "Hearing now", filterable log, alert + nursery settings, zone editor. Frozen-video detection. |
| Alert cues | `live/monitor/alerts.ts` | Per-category synthesized sounds, speech, vibration, repeat-until-answered, title flashing, snooze, per-device prefs. |
| Guidance | `live/components/Guide.tsx`, `MonitorHome.tsx` | Tours per screen, 10 how-to guides, nursery "Get set up" checklist (`live/monitor/setupProgress.ts`). |
| Invite | `live/views/monitor/InviteSheet.tsx`, `live/monitor/invite.ts`, `live/monitor/qr.ts` | One sheet to add someone with an account or share a link + passcode (on-device QR), and who has access — see “Invite” below. |

## Sound categories — ESC-50 study (2026-10-21)

All 2 000 ESC-50 clips through the production front end (resampler → YAMNet),
Medium sensitivity, clip-level persistence rule (share of target clips caught /
share of the other 49 classes' clips that fire):

| Category | Caught / false | Notes |
|---|---|---|
| Crying | 91 % / 0.6 % | Unchanged recall; false "crying" on cat clips 8.8 % → 2.5 % with the cat-vs-cry guard |
| Coughing | 79 % / 0.4 % | Sneezes no longer count as coughs (26 % → 9 %) |
| Glass breaking (new, alerts) | 74 % / 0.5 % | Split out of bang/crash; glass masks crash |
| Cat (new, alerts) | 81 % / 0.1 % | Meow + Caterwaul only |
| Snoring (new, log) | 93 % / 0.3 % | Must out-score plain breathing |
| Sneezing (new, log) | 74 % / 1.2 % | Loud close-mic breathing is the main confuser |
| Knocking (new, log) | 75 % of knocks / 0.7 % | YAMNet can't hear creaking doors — we don't claim "door opened" |
| Footsteps (new, log) | 57 % / 0.2 % | Precise, misses ~40 % |
| Running water (new, log) | 70 % / 0.2 % | Taps, pouring, toilet flush |

Not shipped: fire/crackling (fires more on footsteps than on fire) and hiccups
(no validation data). Known gaps: the smoke-alarm beep detector also matches some
bell alarm clocks; YAMNet is level-dependent, so very quiet sounds (35 dB down)
other than crying and cats are mostly missed. Full study:
the method and per-class numbers are in the comments of `soundClasses.ts`.

## Sound detection — measured (v2)

Evaluated offline with the production code path (resampler → YAMNet → SoundBrain,
plus the cry analyser and alarm detector on real FFTs) on ESC-50 clips padded with
room noise, Medium sensitivity:

| Clips | Fused system | Cry analyser alone (old) |
|---|---|---|
| Real infant crying (40) | **88 %** detected (90 % High) | 68 % |
| Dogs, laughter, alarm clocks, sirens, rain, vacuum, … | **0 %** false "crying" | 8–38 % false "crying" |
| Coughing (40 short clips) | 43 % as coughing fits (single coughs are ignored by design) | — |
| Glass breaking | 88 % bang/crash | — |
| Dog barking | 100 % | — |
| Smoke alarm T3 (near and far, synthetic) | 100 % | — |

Model inference: ~6 ms per 0.96 s window (Node/ONNX CPU); one window every 0.48 s
on the camera phone. Without the model (old browsers, failed download) the cry
analyser + alarm detector keep working ("Basic ears").

## Alerts and incidents

- Camera → `event {kind:'sound', cat, phase, conf, secs}` → MonitorRoom logs
  (per-category flood guard) → every viewer + Web Push (per-category prefs).
  Events only go out after the room's `hello`; on every (re)connect the camera
  replays what's still going on (`SoundBrain.ongoing()`), so a cry that started
  during setup or a network drop alerts exactly once.
- **Choosing alerts (viewer):** `live/views/monitor/AlertsCard.tsx`. One card: a
  background-alerts switch, presets (Essentials · Recommended · Everything) and topic
  tiles grouped Baby / Safety / Room / Camera & family. Each topic maps to Web Push
  categories *and* on-screen cue categories, so a tile switches both together; the
  smoke/CO alarm is locked on. The preset shown is derived from the current prefs (any
  other mix reads "Custom"), so nothing new is stored.
- **Incidents** (cry, alarm, glass, crash, danger zone, climb-out, very loud,
  camera moved, video paused, offline) carry who answered and how fast. A cry
  goes to whoever is **on duty** first and escalates to everyone after
  `cryEscalateMin` (default 5 min) without an answer; hazards reach everyone at
  once and repeat until someone taps "I'm on it".
- Viewers: colour by category (red act now / amber check / blue-green good
  news), distinct sounds, optional speech, vibration, stage glow, full-screen
  takeover for alarms, "I'm on it" (silences everyone), Snooze 5m (this device).

## Operations

- **Model file** is served from Pages at `/models/yamnet/yamnet-v1.onnx` (16 MB,
  cached forever via `public/_headers`); the worker falls back to the pinned
  Hugging Face copy, and refuses any bytes that don't match the SHA-256.
  Replacing it: add `yamnet-v2.onnx`, update `MODEL_URL` + `MODEL_SHA256`.
- **ONNX Runtime WASM** (`ort-wasm-simd-threaded*.wasm`, 13 MB / 24 MB) is emitted
  by `vite build` into `/assets` — under Pages' 25 MiB per-file limit.
- **Thresholds** live in `soundClasses.ts` (`ON`, `HITS_NEEDED`) and
  `soundBrain.ts` (`MIN_LEVEL`, `HOLD_MS`). Re-run an evaluation before
  changing them.
- **Schema**: `monitor_delete` / `monitor_remove_member` / the nightly sweep are
  part of `server/sql/live_accounts_and_monitor.sql`.

## When the internet drops (home Wi-Fi resilience)

- Devices on the same Wi-Fi connect over host candidates, so media never leaves the
  house; `netPath()` (rtc.ts) reads the selected ICE pair and the stage shows **Home Wi-Fi**,
  **Encrypted · P2P** (internet) or **relay**.
- Each call carries a data channel `mon`: the camera sends its 2-second status and every
  sound / vision / noise event straight to viewers (`CameraHub.direct`). While the room is
  reachable that's only a fresher status; when it isn't, the viewer raises alerts from it
  (`onDirect` in MonitorViewer).
- A connected call is never torn down by room bookkeeping: `peer_gone` → `release()` keeps
  a connected peer; a camera that reconnects under a new session id is re-addressed
  (`ViewerLink.retarget`) rather than renegotiated; a viewer keeps showing a camera the
  room lost while the call is up.
- Limits: push notifications and devices away from home need the internet; browsers can't
  use Bluetooth or Wi-Fi Direct, so two phones with no shared network can't connect; sound
  events that start and end entirely during an outage reach the log only through the
  "ongoing" replay on reconnect.

## Video with many viewers and on strict networks

Every viewer is its own encoder on the camera phone (a mesh), and without a TURN
server a viewer whose network blocks peer-to-peer (often a guest on mobile data)
can't connect directly at all. Production is **STUN-only until the owner sets
`TURN_KEY_ID` / `TURN_KEY_API_TOKEN`** on `dreamstream-live` (`live-worker/src/ice.ts`);
everything below works with or without it.

**Direct (P2P) picture — `rtc.ts`:**
- *One connection per viewer session.* Each `ViewerLink.connect()` mints a call id
  (`MonRtc.pc`); the viewer also sends `vid` (its device id + tab). The camera keys
  its peer by `vid`, builds a fresh `RTCPeerConnection` for a new call id (an ICE
  restart keeps the id), ignores late candidates / byes from older calls, and
  follows the viewer to a new room socket — so Data saver, talk and video-call
  commands still find the call after a reconnect. A reconnect says `bye` for the
  previous call first. Older viewers without ids are keyed by socket, as before.
- *Encoding ladder* (`encodingFor`), per viewer: 1 internet viewer 1.6 Mbps 720p
  24 fps · 2 → 1.1 Mbps · 3 → 800 kbps ÷1.5 20 fps · 4+ → 500 kbps ÷2 15 fps
  (floor rung 320 kbps ÷3 12 fps). Home Wi-Fi viewers don't count against the upload;
  every viewer counts against the processor (4–6 encoders → ÷1.5, 7+ → ÷2). A TURN
  path is capped at 650 kbps ÷2 (pay-per-GB); Data saver at 450 kbps ÷2 15 fps.
- `degradationPreference: 'maintain-framerate'` and `contentHint: 'motion'`: under
  pressure the picture gets smaller, not choppier.
- *H.264 first* (`orderCodecs` / `setCodecPreferences`, keeping rtx/red/fec): hardware
  on iPhones and most Android phones, where VP8 is software. The viewer's offer order
  is what makes the camera send it (SDP order = what you want to receive); the camera
  sets it on its answer too.
- *Stats every 5 s* (`adapt`): CPU-limited twice in a row → everyone one rung down
  (at most two); 30 s calm → one back up. Bandwidth-limited over the internet → that
  viewer −25 % (floor 300 kbps), restored after 30 s clean.
- *Telemetry*: the camera's status carries `enc = {peers, fps, lim, impl, w, p, relay}`
  (sanitized by the room, `sanitizeEnc`). Viewers show **“Camera phone is busy — showing
  a smaller picture”** when the phone stepped down; the camera screen offers to turn
  Smart vision off.

**Relay picture — real video through the room (`relay.ts`):** used when P2P can't
connect (no TURN; often a guest on mobile data), while a viewer's P2P takes longer than
a second to connect (the *instant picture*), and when the camera's direct slots are full
(the *overflow tier*). The camera encodes **once** for every relay viewer.
- *Wire* (`relayWire.ts`, mirrored by `live-worker/src/relayWire.ts`; a parity test
  checks both): `u8 kind` (1 JPEG · 2 video · 3 video + sound · 4 sound only) · `u8 flags`
  (bit 0 key) · `u32 seq` (wraps) · `u32 ts` ms · `u8 codec` (1 H.264 · 2 VP8 · 3 VP9) ·
  payload (kind 3: `u16` sound length, sound, video). Older cameras' bare JPEGs still work.
- *Camera* (`RelayEncoder`): draws the live picture into a canvas at 640 on the long side
  (640×360, 360×640 upright, never upscaled), `new VideoFrame(canvas)`, and encodes with
  the first codec the phone can encode (`isConfigSupported`: `avc1.42E01E` Annex B — every
  key frame carries SPS/PPS — then `vp8`, then `vp09.00.10.08`) that most relay viewers
  decode; `latencyMode: 'realtime'`, 450 kbit/s at 15 fps, a key frame every 2 s and on
  `relay_key`. No encoder → JPEG (2–5 fps, `RelayPacer`); JPEG also goes alongside the
  video for viewers that can't decode it. More than 64 KB queued on the socket → skip
  frames (nothing queued) and restart on a key frame, stepping down to 300 / 200 kbit/s
  and 12 / 10 fps (`RelayRate`; 20 s clear → back up); a frame that couldn't be sent
  holds back every frame after it until a key frame; an encoder that keeps failing is
  dropped for the next codec. Nothing at all is sent during a privacy pause (and sound
  captured then is discarded).
- *Sound* (`relayAudio.ts`): the sound engine's microphone tap (only while someone is on
  the relay) → 8 kHz band-limited resample → G.711 μ-law (64 kbit/s), bundled into the
  next video message (so no extra billed messages); alone only when no frame went out for
  150 ms (or the camera has no encoder). Viewer: an AudioWorklet with a ~300 ms jitter
  buffer (±3 % speed to hold it, re-buffer after a gap, skip ahead when half a second
  behind) → a MediaStream track. Browsers without AudioWorklet get the picture without
  sound, and say so.
- *Viewer* (`RelayDecoder`): subscribes with the codecs it decodes
  (`{t:'relay', on, dev, codecs, instant?}`); VideoDecoder → canvas, every frame closed;
  waits for a key frame after joining, a codec change or an error (asking with
  `{t:'rx', s, k:1}`); three decoder errors in 20 s → JPEG. Acknowledges `{t:'rx', s}`
  every 500 ms. The canvas is captured (`captureStream`) together with the sound into the
  watch screen's `<video>`, so picture-in-picture, Listen and the bedside view work on the
  relay too; the canvas itself stays on top until the direct picture has *drawn* a frame
  (requestVideoFrameCallback, at most 5 s), so the swap is seamless.
- *Instant picture* (`linkFallback.ts`): P2P gets a one-second head start
  (`INSTANT_DELAY_MS`) — on the home Wi-Fi it's usually rendering by then, so nothing
  passes through the server — then the viewer subscribes until P2P has rendered a frame.
  The relay picture arrives ~0.2 s after subscribing (measured), so a remote viewer sees
  the nursery in about 1.2 s instead of after the handshake or the 10 s give-up. Also
  bridges an ICE reconnect. Audio-only viewers skip it. If P2P fails, the same
  subscription becomes the fallback (re-sent without `instant`; parents then see “via
  our server”). P2P is retried after 30 s, 1, 2, 4, then every 5 min; re-subscribed after
  every room reconnect and camera switch.
- *Overflow tier* (`rtc.ts` `DIRECT_CAP` = 4): at most four viewers get their own
  encoder over the internet; home Wi-Fi viewers and audio-only viewers don't count. A
  viewer arriving when the slots are full (and that sent `ov: 1` with its offer) gets no
  video until its path is known: on the home Wi-Fi it's let in; otherwise the camera
  answers `{bye, full}` and it goes straight to the relay (“Camera full · via server”).
  Older viewers are never turned away.
- *Room*: relay messages from cameras only, validated (header, kind, codec; video ≤ 128
  KB, JPEG ≤ 256 KB, sound ≤ 16 KB), a token bucket per camera (25 messages/s, burst 8,
  ~1.5 MB/s). Routed by codec: video to viewers that decode it, JPEG to the rest (bare
  for viewers from before the framed format), sound-only with the video.
  `relay_want {n, avc, vp8, vp9, jpeg}` tells the camera who wants what. A key frame is
  requested (≤ 1/s per camera) when someone subscribes, falls behind or reports a
  decoder error; new subscribers start on a key frame. Per-viewer window: more than 30
  messages unacknowledged (~2 s) → that viewer skips video until a key frame arrives
  with ≤ 15 in flight, and keeps getting its **sound** meanwhile (the room rewrites the
  video + sound message into sound only); a dropped frame (bucket) resyncs everyone on
  the next key frame. A privacy pause (the camera's event or status) stops every relay
  message. Viewers only bridging while P2P connects aren't listed as “on the relay”.
- *Privacy*: relay video and sound pass through the Durable Object's memory — **not
  end-to-end encrypted** (only P2P, direct or through TURN, is) and never stored. The
  pill (“Via our server · 12 fps”, “Quick preview”) and its tooltip say so.
- *Cost*: 15 fps with sound is ~540k incoming WebSocket messages per 10 h night (≈ $0.12
  per nursery per month at the 20:1 request ratio) plus ~2 acks/s per relay viewer;
  outgoing messages are free. While frames flow the object stays awake: up to ~4.6k
  GB-s per relayed night (inside the 400k GB-s monthly allowance for a few nurseries,
  ≈ $1.7 per nursery per month beyond it) — only while someone is on the relay.
- *Verified* in Chromium (Playwright, fake camera, P2P blocked): VP8 decoded at 11–12 fps,
  ~250 kbit/s with sound, picture 0.2 s after subscribing, PiP, jitter-buffered sound,
  JPEG + “no sound” without WebCodecs, privacy pause, camera restart.

## Invite (add people or share a link)

One sheet, `openInvite(nid, tab?)` from anywhere (mounted once by `LiveApp`
like the sign-in sheet; the sheet and its QR encoder load on demand):
watch-screen header (`mv-invite`, with a "watching now" count), nursery hub
header (`hub-invite`), People & roles (`people-invite` + an "It's just you so
far" empty state), the setup checklist's "Invite family", the nursery card
when you're its only member, the watch screen's People card and Nursery
settings, and `#/monitor/<nid>/invite`.

- **Add by name** (Supabase `monitor_set_member`, the authority): people you
  share another nursery with first (`knownPeople()` — no directory search, no
  wrong "Sarah"), then a 250 ms debounced name search (12 results, names only).
  Role chips default to **Viewer** (least access), label chips, a "check it's
  the right Jo" line for search results, then "Let them know" — the native
  share sheet with the (non-secret) watch link. `not_member` reads "Jo hasn't
  finished setting up Stream Studio yet — share a link instead".
- **Share a link**: the passcode is pre-filled (`suggestPasscode()`, re-rolled
  if it trips the nursery-name rule), so it's one tap to a link. Then a QR code
  drawn on the device (`live/monitor/qr.ts`: byte mode, level M, versions
  1–10, penalty-chosen mask, ported from Project Nayuki's MIT encoder — the
  107-character link is version 7, 45×45; **never** an online QR service, which
  would see the link's secret), Send (`navigator.share`, falling back to copy;
  the text never includes the passcode), Copy, the passcode shown once,
  "Set a new passcode" (same link; guests stay unless "also sign them out"),
  +7 days, New link and Turn off — both confirmed in place, not `window.confirm`
  (blocked in some in-app browsers).
- **Who has access**: members (edit role/name, remove), guests (remove), and
  guests who have an account — "Make member" / "Keep as guest".
- **Plumbing**: on the watch screen the sheet borrows its socket (a registered
  `ShareChannel`); anywhere else a parent's sheet opens an `admin` socket while
  it's open — slim hello (`you`, `nursery`) + `share`, no monitor broadcasts,
  never in presence, and only `members_changed`, `share_*`, `guest_remove`,
  `request_dismiss`, `ping`. `members_changed` may name the `uids` whose access
  changed: only they get `roles_changed`, so adding Grandma doesn't restart
  everyone's live picture (no `uids` = everyone, as before).
- **Role changes reach sockets already open**: a socket's role is read when it
  signs in, so on `members_changed` the room re-reads everyone's role
  (`monitor_people`) and updates every open socket in every mode — Invite
  sheet, watch screen, camera, call line — before anything else runs. A parent
  made a Caregiver or Viewer can't send `share_*`, `guest_remove`,
  `request_dismiss` or `members_changed` any more and stops getting `share`
  (new link codes); their Invite sheet's `admin` socket is ended with
  `forbidden` (the sheet re-reads and shows what they can do now); a camera
  run by someone now a Viewer stops at once, saying why (parents get the usual
  offline alert) rather than at some later reconnect. If Supabase can't list
  the roles, the sockets concerned keep watching but with no parent-only power
  until they sign in again (an Invite sheet reconnects at once, close 4009) —
  a Supabase hiccup never stops anyone watching.
- **Accessibility**: `role="dialog"` + `aria-modal`, Esc closes, focus starts in
  the sheet (the search field with a mouse/keyboard) and returns to the button
  that opened it, the page behind is `inert`, tabs are a real tablist (arrow
  keys, Home/End), role chips a radiogroup, a `role="status"` live region for
  "added" / "passcode shown", 44 px targets on touch, reduced motion honoured.
- **Nothing fails silently**: the app's toasts sit under the sheet's scrim (and
  the page behind is inert), so the sheet says everything itself — a problem as
  a `role="alert"` next to what was tapped (a failed "Make member" or role
  change under that person, "Couldn't copy", "Not connected"), anything else as
  a short line its live region reads ("Link copied", "+7 days" once the room has
  moved the end). A change the room doesn't answer within 8 s (no new `share`,
  no `share_err`) says "The nursery didn't answer, so this may not have
  changed".
- **Members never become guests by accident**: the join page sends a signed-in
  member straight to watching ("You're already in …"), the watch screen drops a
  stale guest pass once the account is a member, and the room answers
  `reason: 'member'` to a member's join. In-app browsers get a note that the
  guest pass stays inside that app. Guests count toward the checklist's
  "Invite family".

## Guest access (share link + passcode)

For family or a sitter without an account (accounts need the welcome code).
The nursery's MonitorRoom is the authority; nothing about guests lives in Supabase.

- **Link** `/live#/monitor/join/<nursery>/<code>` — 128-bit code kept by the room
  so parents can copy it again; it sits in the URL fragment, which browsers
  never send to a server. The join page reveals nothing about the nursery until
  the passcode is right.
- **Passcode** chosen by a parent (≥ 8 characters, not a sequence, not built from
  the baby's or nursery's name; the app and the room share the rule and a test
  keeps them equal). Stored only as PBKDF2-SHA256, 100 000 rounds (the Workers
  maximum), per-link salt. Shown to the parent once after creation.
- **Guessing**: 5 wrong passcodes lock the link for 15 min, 20 since the last
  success turn it off and sign every guest out; 12 tries per address per 15 min.
  Parents get a push (`guest` category) for each new guest, a lock, and a
  shutdown.
- **Guest pass**: a 256-bit token stored only as SHA-256, kept on the guest's
  device, sent in the socket's first frame. It ends with the link (1 / 7 / 30
  days or until turned off; at most 90 days), when a parent removes the guest,
  or when the link is replaced or turned off. Up to 10 guests per link.
  The room is the authority on when it ends: a guest's `hello` carries
  `you.until`, and `{t:'guest_pass', until}` reaches connected guests after
  `share_extend` / `share_pass`; the device keeps its saved copy in step and
  never drops a pass because that copy has passed (the link may have been
  extended while it was away) — only the room's refusal (4004) clears it, or a
  saved end more than 90 days old.
- **Roles**: "Watch & listen" (viewer) or "Also talk, soothe & answer alerts"
  (caregiver). Guests can never run a camera, change settings, manage people or
  download history; Supabase member re-checks never touch them.
- **New passcode, same link** (`share_pass {pass, signOut?}`): new salt + hash
  on the active link, wrong-guess counters and any lock cleared, `pass_at`
  updated (added to `mon_shares` with a guarded `ALTER TABLE`); guests stay
  signed in unless `signOut`. **Extend** (`share_extend {days: 1|7|30|null}`):
  adds to the link's current end (an absent value is never "forever") and moves
  its guests' passes with it — never past 90 days from their join.
- **Joining is checked twice**: the passcode is checked (`check`), then a
  signed-in joiner's account is looked up in Supabase, during which the room
  handles other messages. `issue` re-reads the link in the same synchronous step
  as the insert: turned off, replaced, ended, or given a new passcode since
  (`pass_hash` changed — "set a new passcode and sign out guests") and nobody
  gets a pass with the old one.
  `ShareInfo` also carries `max_guests` and `pass_at`.
- **Guests who have an account** (`mon_requests` in the room's SQLite — no
  Supabase migration): a signed-in person's join sends their own bearer token
  (`index.ts` forwards `authorization` to the room). After the passcode is
  accepted the room asks Supabase who they are (`verifyMember` → `live_me`;
  the uid is **never** read from the body). Already a member of this nursery →
  `409 {reason:'member'}`, no guest pass. Otherwise a guest pass as usual, a
  request for the parents ("has a Stream Studio account") and a push saying so.
  "Make member" calls `monitor_set_member` (Supabase stays the authority), then
  `members_changed`: the room resolves the request, sends `{t:'promoted'}` to
  that guest's sockets (closed with 4007), ends the guest pass, and the app
  reconnects with the account.
- Code: `live-worker/src/monitorGuests.ts` (+ tests), `MonitorRoom` (`/guest`
  join, `share_set` / `share_off` / `share_pass` / `share_extend` /
  `guest_remove` / `request_dismiss`), `live/monitor/guest.ts`,
  `live/monitor/invite.ts`, `live/monitor/qr.ts`, `live/views/MonitorJoin.tsx`,
  `live/views/monitor/InviteSheet.tsx`, `live/views/monitor/PeopleCard.tsx`.

## This week (monitor analytics)

`q: 'weeks'` rolls up 14 local days in the room (`MonitorRoom.weeks`): camera sleep (total,
night, naps, longest stretch), night wakings, crying minutes and episodes, alerts and the
average time to "I'm on it", the energy-averaged LAeq while asleep, and loud events.
`live/views/monitor/WeekCard.tsx` shows this week vs last (averages over days with data),
marks a change only past a per-metric threshold, colours it by whether lower or higher is
better, and writes one headline. The tracker's own Trends cover logged feeds/diapers.

## Baby tracker (feeds, diapers, sleep, growth…)

The watch screen's **Tracker** layout — Huckleberry-style logging shared live by the
family, in the same room connection as the monitor.

**2026-10-21 — compared with finnberry** (an open-source Huckleberry-style tracker,
github.com/bckenstler/finnberry): it models the classic entries but nothing about
movement or surroundings (no posture, rolling, objects or room data — our camera's
smart vision and sound engine go well beyond it). From its data model we adopted:
sleep **nap / night** set by the family (overrides the clock in every nap/night
calculation) and **how well** (1 restless … 5 great, with a week-over-week insight);
diaper **how much** (a little / normal / a lot); a **skipped dose** flag (kept in the
log, never counted as given — dose timing runs from the last real dose); **foods as a
list** with each food's first try remembered, "new" badges while logging, quick-picks
of foods tried before, and a weekly **new foods** insight that turns into a watch
(with when to call) if a reaction is noted; more activities (**brushing teeth,
screen time** — with the AAP's under-18-months note — and other); and the
**week view**: seven 24-hour strips (sleep blocks, feed and diaper ticks, camera
sleep hatched) — tap a day to open it. Not adopted yet: several children per
nursery, a configurable day start, email invites with expiry.

- **Log**: breastfeeds (timer with left/right switching), bottles (ml/oz, formula /
  breast milk), solids, pumping, diapers (wet/dirty/both/dry, colour, texture, rash),
  sleep (timer or after the fact), medicine (name, dose as entered, interval), temperature
  (°C/°F, method), growth, activities (tummy time, bath…), notes. Any phone can stop a
  timer another started. The camera's automatic sleep sessions appear alongside manual
  sleep (manual wins where they overlap).
- **What's next**: nap "sweet spot" from age-based wake windows blended with the baby's
  own recent rhythm; next feed from their median interval (start-to-start) and which side
  to start on; when the next medicine dose is allowed by the interval the parent entered.
- **Gentle checks**: wet-diaper counts by age (only once the log covers ≥ 8 h), concerning
  stool colours, AAP fever thresholds by age and method, doses logged sooner than the
  interval. All worded as guidance with "call your pediatrician" for red flags — never a
  diagnosis, and no dose calculations.
- **Trends & growth**: 7/14/30-day sleep (night + naps), feeds, bottle volume and
  diapers, plus up to four plain-language insights (week over week). Weight, length and
  head circumference on the **WHO Child Growth Standards** (0–24 months; LMS tables from
  the CDC-hosted WHO files) with percentiles and a chart.
- **Sync**: entries are saved optimistically, queued in `localStorage` while offline and
  sent on the next connection; the room clamps every field (`trackerStore.ts`), soft-deletes
  so offline phones learn about deletions, and closes timers left running for a day.
  CSV export for the pediatrician (`/export?what=track`).
- Code: `live-worker/src/trackerStore.ts` (+ tests), MonitorRoom `track_put` /
  `track_del` / queries `track`, `track_sync`; `live/monitor/trackTypes.ts`,
  `trackerSync.ts`, `trackerScience.ts`, `whoGrowth.ts` (+ tests); `live/views/tracker/*`.

## Smart vision (beta)

Turned on in the camera's setup ("Make it smarter"; on by default on phones with 4+
cores). Frames never leave the camera phone — only conclusions do (`{t:'event',
kind:'scene'}` to the room, mirrored over the Wi-Fi data channel, and a `scene`
summary in the camera's status). The models are fetched from our own site and
refused unless their SHA-256 matches; the WebAssembly runtime is bundled from the
pinned `@mediapipe/tasks-vision` package. Measured in a headless desktop browser on the CPU: ~1 s for
the first frame, then ~250–320 ms; the loop backs off to one every 1.5 s or 3 s on slower phones and pauses while the
video is privacy-paused or the page is hidden. It also yields to the live picture
(`sceneIntervalMs` in `videoBudget.ts`): half the rate with two or more viewers (the relay counts as one), a third
when the encoder reports the phone's processor as the limit, never slower than one frame per 6 s. Sound and cry
detection never slow down.

**What it reports** (each finding must hold for 3–8 s; each kind has a cooldown):
posture (lying / sitting / standing, with where), standing in the crib (climb-out
risk), rolled over (face seen, then turned away while lying), holding a toy, a risky
object within reach (scissors, knife, fork → urgent incident; cup, glass, phone,
remote, hair dryer, plant, cat/dog → warning), a soft toy in the crib or within reach
of a lying baby (AAP: keep the sleep space bare), and entering / leaving a play area
(activity zones: play gym, bouncer, play mat).

**Finding the baby.** The person in the crib or a play area; with no zones, the
smallest person (a lone person is the baby — an overhead shot fills the frame);
bigger people are "someone is with them". The detector often misses small or
swaddled babies, so when it finds no one the pose model's box is used.

**Posture needs context.** From straight above, a baby on their back projects
exactly like a person standing facing the camera, so an image-angle rule alone gets
overhead shots wrong. Lying is decided first from:
- the **baby's age** — the Tracker's birthday reaches the camera with the nursery
  settings; under 150 days only lying is reported (CDC: sits without support around
  9 months — 5 months is a deliberately early cut-off), and never "standing in the
  crib";
- the **camera's pitch** from the phone's tilt sensor (`downAngle(β, γ)`; the front
  camera looks the other way) — 50° or more below horizontal is an overhead view;
- the **head on a detected bed or couch**.

Otherwise the pose decides: torso across the image → lying; upright with legs
extended to **feet inside the frame** → standing; upright with the thighs
foreshortened → sitting; legs extended but feet out of frame → unknown. A baby with
no pose who is too young to sit, and isn't inside an adult's box (being held), is
reported lying.

**Calibrated on real infant photos (2026-10-21).** The owner shared nine photos of
their baby: tummy time from the side, awake on a changing pad from straight above
(one with the phone close enough that the baby fills the frame), and asleep swaddled
from the side and from above among plush toys with a grown-up lying beside. The
photos stay private and are not in the repo; the models' output on them — boxes,
scores and rounded pose points only — is the regression set
`live/monitor/infantScenes.fixture.ts`, tested in `scene.unit.test.ts`.

| On the nine photos | Before | Now |
|---|---|---|
| Baby found | 3 / 9 (detector only) | 9 / 9 (pose fallback) |
| Called sitting or standing (all were lying) | 6 / 9 where a pose was used | 0 / 9 with no context |
| Reported lying | — | 7 / 9 with no context · 9 / 9 with the age or the tilt known |
| Plush toys near the sleeping baby flagged | 0 / 2 | 2 / 2 (side view always; overhead with age or tilt) |
| Grown-up beside the baby | — | seen as an adult, not the baby |

The full camera → room → viewer path was also run in a browser on two of the photos
(fed as the camera): the viewer showed "Lying down", the log "Aria is lying down"
and, for the sleeping baby, the soft-toy warning — and nothing for tummy time.

**Limits (stated in the app).** A beta. Both models were trained mostly on older
children and adults; nine photos of one baby are an evaluation set, not enough to
retrain a network. It can miss a baby under a blanket, can't see blankets or
pillows (only teddy bears among soft things), and does not watch breathing, sleep
position or face covering. Not a medical device.

## Family calls (2026-10-21)

FaceTime-style video and voice calls between the people in a nursery — one
person or a group of up to four — from the **Calls** tab (or the call buttons
next to each person). Device to device (WebRTC, DTLS-SRTP), never recorded.
Since 2026-10-22 Calls also reaches **anyone on Stream Studio**, found by name
(see “Direct calls” below).

**Switchboard.** Each nursery's MonitorRoom is that family's switchboard. While a
member is signed in, the app keeps a light `line` socket to each of their
nurseries (`mode: 'line'` — authenticated like any member socket via
`monitor_my_role`, a short hello with no monitor data, never in presence, never
sent monitor broadcasts; up to 24 per nursery, separate from the 14 monitor
devices). Share-link guests can't open a line, and a device running as the
nursery camera closes its lines so the baby's phone never rings.

**Ringing.** `call_start {to, video}` → the room's `CallBook`
(`familyCalls.ts`, pure and unit-tested) records the call and sends its state to
the lines of the caller and everyone asked; their app rings full-screen with a
synthesized ringtone (quiet — it's a home with a baby), vibration and a flashing
tab title, plus a local notification when the tab is hidden. Devices that turned
on **Ring this device** also get a Web Push (`call`, urgency high, TTL 45 s,
topic per call). A call rings for 45 s (the room's alarm ends it as `no_answer`);
everyone asked can decline; the caller hanging up first is `cancelled`. Those who
never picked up (and didn't decline) get a **missed call** push that replaces the
ring (same tag and topic), and a red entry + badge on the Calls tab.

**Media.** A mesh: one RTCPeerConnection per pair (`max-bundle`, a one-entry
candidate pool), audio + video transceivers from the start, so mute / camera off
/ flip / turning the camera on in a voice call are `replaceTrack` or `enabled` —
no renegotiation. Of any two people, the one who joined later makes the offer
(`joinedAfter`); if their offer hasn't arrived after 4 s the other side offers
instead. Every signal carries a connection id (`cid`, chosen by the offerer): a
new cid is a new connection, the current cid an ICE restart of it, and two
simultaneous new connections are settled by socket id. One person's signals are
handled strictly in order. Signaling (`call_rtc`) is relayed only between two
devices in the same call. Peers are keyed by person, not socket, and a line that
drops keeps its place for 20 s (`LINE_GRACE_MS`) — longer (up to 2 min) while
someone still in the call says its media still reaches them (`call_up`, sent only
while a person is away) — and the app rejoins from its new connection, mute and
camera as they were, and the media carries on. Video is shared across the uplink
*and the phone's encoder*: 1.5 / 0.9 / 0.6 Mbps for 1 / 2 / 3 others, each copy
at 360p with two or more others and 24 fps with three, `maintain-framerate`,
H.264 first when the phone can encode it (the hardware encoder on iPhones), and a
further step down when WebRTC reports the CPU as the limit ("Your phone is busy —
sending smaller video"). Each person keeps one stable MediaStream, so the video
element never reloads. Tiles show a weak-connection hint from packet loss and
round-trip time, "Home Wi-Fi" when everyone is on the local network and "via
relay" when TURN carries it. On iPhone the call declares a play-and-record audio
session (`preferSpeaker`) so it plays on the loudspeaker, not the earpiece.

**Connecting — fast, and honest when it can't** (2026-10-22). Answering sends
`call_join` and the offer back to back (the room handles one socket's messages
in order and saves the join before awaiting anything else), while the camera
opens in parallel and slots in by `replaceTrack`; a connection is made ahead of
time while the call rings, so its candidates are gathered before Accept. Locally
(two browsers, one loaded machine) Accept → connected went from a median of
~1.3–1.5 s to ~0.6–0.7 s. Each call gets fresh ICE servers (`call_started` /
`call_joined` carry them; `live-worker/src/ice.ts`). Nothing spins forever: after
8 s the screen says "Still connecting…", and after 15 s (20 s with a relay on
offer) it says why, from the candidate types each side found
(`classifyFailure`): your network blocks calls, theirs does, the two networks
can't reach each other directly (no relay), the relay failed too, or their phone
isn't responding — with **Try again** and **Audio only**. A dropped connection
is ICE-restarted after 3 s (the offerer restarts; the other side asks it to);
unanswered offers are resent every 2 s, at most 5 a minute, and go to the other
phone's new room connection the moment it's back. Failed connections are rebuilt
on "Try again", on `online` / network-type changes and when either app rejoins.
`?relay=1` (or `ds-calls-relay=1` in local storage) forces relay-only for testing
TURN — "Relay test" shows in the call. Each call's history keeps a small
`call_stats` per person (time to connect, LAN / internet / relay, failure reason,
relay on offer — no names or addresses), also logged as one line for
`wrangler tail`. "Answer" on a call notification opens
`#/call/<nursery>/<call>?answer=<proof>`, which picks up as soon as the app is
back in the room. The proof is a one-time random token the service worker
writes to Cache Storage (`ds-sw-state`, `/__ds/answer/<proof>`) only when
"Answer" is really tapped, bound to that call and good for 90 s; the app
(`takeAnswerProof`) uses it up before answering. Any other address — a link
someone sends while a call rings, `?answer=1`, a reload — only opens the app on
the ringing call; it never picks up. Someone outside your family is always
answered by voice first, even from "Answer".

**Line liveness.** Line sockets ping every 25 s (every 10 s while ringing or in a
call) and treat a ping that hears nothing for 10 s as a dead socket: dropped and
reopened at once (backoff capped at 2 s while ringing / in a call). Placing or
answering a call first checks a line that's been quiet for 30 s. In the room,
`{"t":"ping"}` is answered by the runtime (`setWebSocketAutoResponse`) without
waking the Durable Object — nothing depends on pings reaching it (camera
liveness is the camera's 2-s status, presence is the socket list, a guest's
"last seen" is set at sign-in). While a call is up the alarm checks its lines
every 30 s and drops one that hasn't pinged or spoken for a minute (a phone that
died mid-call), so the call can end instead of hanging.

**Screen.** Remote video full-bleed (a grid for groups), your picture in a
draggable corner, controls that fade while you talk (mute, camera, flip, add
someone from the nursery, end), a call timer, minimize to a floating window
while using the app, "Camera off" faces, "Reconnecting…" veils, and a clear end
state ("Grandpa can’t talk right now", "Call again"). The screen stays awake
during a call. Calls history (last 60 per nursery) shows who, which way, how long
and missed calls; tap to call back.

**Direct calls — anyone on Stream Studio** (2026-10-22). Calls opens with a
search box (`live_search_people` via `searchPeople`, 250 ms debounce — names
only, never emails). Each result says **In Aria’s family** (from your own
nurseries' people) or **Stream Studio member**, with voice, video and a star;
stars become a Favourites row of faces at the top. Recents merge family and
direct calls. A member with no nursery gets search instead of a dead end.
Family members are still called through their nursery (unchanged); anyone else
through two new Durable Objects — no SQL:

- `UserLine` (`userLine.ts`, one per member, `idFromName('u:'+uid)`, socket
  `GET /api/calls/u/<uid>/ws`) — your personal line. The first frame carries
  your own token; `live_me` must say you're a member with that very uid (else
  4003), which **claims** the line. Only a claimed line rings; a claim nobody
  renews for 30 days lapses, and a ring to an unclaimed line writes nothing.
  Only authenticated apps count towards its 10 devices; sockets still waiting
  to authenticate have their own pool of 6 (the oldest is let go first), and a
  closed socket stops counting at once, so knowing a member's id isn't enough
  to crowd their apps off the line. The app keeps this line open through "too
  many devices", sign-in hiccups and a phone waking up offline (backing off up
  to 30 s), and reopens it when back online, on every refresh and when you
  place a call — only a real "forbidden" stops it.
  Hello: `{you, vapid, ringing (with tickets), log, favs, blocked, prefs}` —
  VAPID from the monitor's `KEY_HOLDER` (the **same** key pair, so nursery
  alerts keep working). It works out your family (`monitor_list` +
  `monitor_people` with your token, after the hello, re-read when older than
  10 min). It places calls (`dcall_start`, `dcall_invite`) — each one checks
  your token again (`verifyMember`, cached a minute: a membership revoked while
  a socket stays open stops calls at once) and re-reads your family unless that
  was under a minute ago — rings you (`dcall_ring` to open apps + Web Push
  `{direct:true}` → `#/call/d/<id>`, sent behind the reply so a ring and a
  silenced ring take the same time), takes `dcall_decline {block?}`,
  `dcall_cancel {ref, id?}` (you hung up before the call got going — it ends at
  once, even while its room is still being made), `fav`, `block`,
  `prefs {who}`, `call_push(_off)`, and keeps your direct-call history (60,
  missed-call push). Favourite, block and "who can call me" changes made while
  the line is down are kept on the device (also across a reload) and replayed
  after its next hello, so a hello never quietly undoes them.
- `CallRoom` (`callRoom.ts`, one per call, 16-hex id, socket
  `GET /api/calls/c/<id>/ws`) speaks the nursery line protocol, so the call
  mesh and call screen are the same. It's made by the caller's line
  (`/x/init`): the call starts with the caller *pending* (`CallBook.start(…,
  {pending:true})` — nobody offers or relays to them; they're cancelled after
  20 s if they never arrive), and everyone asked is rung through their line
  (`/x/ring`). Sockets authenticate with a **ticket** (24 random bytes per
  person, only their SHA-256 kept, handed out only through that person's
  authenticated line) — no Supabase round trip on answer. The hello carries
  fresh ICE. Picking up tells the person's other devices to stop ringing
  (`/x/update`); at the end every line gets the history line (`/x/log`,
  missed calls marked), and the room wipes itself 2 minutes later. Someone in
  the call adding a person (`/x/invite`) rings them with `by` (who added them)
  and `with` (who's in the call), and the caller hanging up before reaching
  the room (`/x/cancel`, from their line) cancels it there and then. As on the
  personal line, only ticket holders count towards its 16 devices.
- The worker routes only those two sockets (`/api/calls/u/<uuid>/ws`,
  `/api/calls/c/<16 hex>/ws`); the objects' `/x/*` endpoints are never routed.
  Migration `v3` adds both classes (`wrangler.jsonc`).

Privacy and abuse controls (`directCalls.ts`, pure and unit-tested): the
caller's name comes from `live_me`, never the app; "Grandma · Aria’s family"
appears only when you share a nursery (`judgeRing`: your own family map and the
ringing side's map, re-read for the call, are compared and the newer one
decides — someone just removed from a nursery stops counting at once; neither
counts past 10 minutes; a side whose map couldn't be read vouches for nobody,
and then only a map of your own read under a minute ago counts), otherwise the ring says **Stream Studio member · not
in your family**, answers with the camera off unless you pick video, and offers
**Decline & block**. Added to a call by someone else, the ring is judged as the
call (the caller) *and* as the person who added you: a block of either — or of
anyone already in the call — silences it, the rate limits count against
whoever added you, it's family only when both are (the adder's side vouches
only for themselves; the caller's own line vouched for the caller when the call
was placed, and the call's room keeps that word), a caller you silenced stays
silenced, the ring says "Added by Bob", and Decline & block blocks
a stranger who added you rather than the caller. **Who can call you**: everyone on Stream Studio (default)
or only people in your nurseries (`restricted` is the honest reply). A
**blocked** caller — or one silenced for ringing a non-family member 3 times in
an hour, or after 2 declines in a day — gets exactly the reply anyone else
would, just as fast (it rings out as "no answer") while nothing reaches you: no
ring, no push, no history; the checks a caller can observe all come before the
block. Whether you have Stream Studio open is never part of the reply: with no
app open and no push it simply rings out as "no answer" (and an app opened
while it rings picks it up), like a phone that's switched off — otherwise a
blocked caller could watch you come online. You get the missed call.
"Unavailable" now only means a line that was never claimed or lapsed. Caller limits: 8 calls per 10 minutes, 40 a
day, 15 different people outside the family a day (`slow_down`). The first call
to someone outside your family asks first ("Sam isn’t in any of your nurseries
— they’ll see your name"), since two people can share a name. A device running
as the nursery camera closes your line too, and the service worker shows call
pushes silently on it (the app tells it; an open camera screen counts too).

**Limits.** Four people per call (each phone uploads a copy per person). Ringing
with the app closed needs notifications (on iPhone, the Home Screen app). Family
calls reach members of a nursery you share; direct calls reach any Stream Studio
member whose app has been open in the last 30 days (unless they take calls only
from their family, or blocked you). Without a TURN relay (production has
none until the owner sets `TURN_KEY_ID` / `TURN_KEY_API_TOKEN`), phones behind
carrier or symmetric NAT can't reach each other — the call now says so within
15 s instead of spinning, but only the relay makes those calls connect.

## Sound level, sleep and history

- The camera sends one row per minute (LAeq, Lmax, L10/50/90, peak, motion,
  crib movement, light, visit, sounds heard). Rows wait on the phone
  (`localStorage`) until the room acknowledges them (`stats_ok`), so a dropped
  connection doesn't leave holes.
- Guidance bands: under 50 dB is the infant-sleep guideline (Hugh et al.,
  *Pediatrics* 2014, for sound machines); 85 dB+ is "very loud" and always
  alerts. The meter is approximate (≈) until calibrated on that phone.
- Sound machine check: a steady sound averaging over 50 dB for an hour is
  flagged once a night with how to fix it.
- Export: `GET /api/monitor/:nid/export` (token in the `Authorization` header,
  never the URL) → CSV of events, sleep sessions or minutes, with spreadsheet
  formula injection neutralised.

## Why the video used to stop after a few minutes

A phone that auto-locks stops its camera; iPhones keep the microphone running,
so families heard the room over a frozen picture. Fixes: the screen wake lock is
re-acquired whenever the OS drops it, a looping-video fallback covers Low Power
Mode, the camera reports `awake` state and a `paused` event (raised as an
incident) when it's hidden, and viewers detect a frozen frame
(`requestVideoFrameCallback`) and say so. The service worker (`live-sw.js`) only
handles push — it never caches or intercepts media.

## Limits (stated in the UI)

Not a medical device and not FDA-cleared: it does not monitor breathing,
heart rate, oxygen, temperature or sleep position, and nothing here replaces
safe-sleep practice. Phones pause cameras in the background — the camera page
must stay open (the screen dims itself); an offline or locked camera alerts
everyone within about a minute.
