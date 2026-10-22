# Baby Monitor (Stream Studio)

A private, never-recording baby monitor inside Stream Studio (`/live#/monitor`).
One device in the nursery is the **camera**; any device the family signs in on can
**watch**. Video and sound go peer-to-peer (WebRTC, DTLS-SRTP); the server only
relays signaling, status numbers and events.

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
| Relay fallback | `live/monitor/linkFallback.ts` (viewer state machine), `live/monitor/videoBudget.ts` (pacing) | When P2P can't connect: the room's low-bandwidth picture (640 px JPEG, 2–5 fps, no sound), P2P retried in the background with back-off, dropped the moment P2P connects. |
| Sound engine | `live/monitor/soundEngine.ts` | Mic → analyser (cry analyser 10 Hz, alarm pattern 20 Hz) and PCM tap → 16 kHz resampler → YAMNet worker every 0.48 s → `SoundBrain`. |
| AI sound model | `live/monitor/yamnet.worker.ts`, `public/models/yamnet/` | Google YAMNet (Apache-2.0, 521 AudioSet classes) via onnxruntime-web WASM, single-threaded, SHA-256 verified, cached. |
| Categories | `live/monitor/soundClasses.ts` | cry, fuss, cough, sneeze, snore, babble, laugh, alarm, glass, crash, loud, voices, music, dog, cat, knocking, footsteps, running water — YAMNet class weights, rival classes, thresholds, severities. |
| Fusion | `live/monitor/soundBrain.ts` | Persistence, hysteresis, loudness gating, priority masking, the cat-vs-cry guard, cooldowns → start/end events + mood. `ongoing()` replays what's happening for a room that missed the start. |
| Sound level meter | `live/monitor/soundLevel.ts` | IEC 61672 A-weighting (bilinear biquads) + Fast (125 ms) time weighting in an AudioWorklet; live dB(A), per-minute LAeq / Lmax / L10 / L50 / L90 / peak; two-step calibration (quiet room ≈ 30 dB, or match a meter); never reads below the mic's floor. |
| Vision | `live/monitor/vision.ts` | 64×48 frames at 4 fps: exposure-normalised cell differences, crib + danger zones, climb-out, visits, lights on/off, dark/covered lens, camera moved (scene signature + phone tilt). |
| Smart vision (beta) | `live/monitor/scene.ts`, `live/monitor/sceneAi.ts`, `public/models/mediapipe/` | On the camera phone, ~1 fps: Google MediaPipe object detector (EfficientDet-Lite0 int8, 80 COCO classes, CPU) + pose landmarker (BlazePose lite, 33 points, GPU with CPU fallback), both Apache-2.0, SHA-256 verified. `SceneWatch` turns frames into held, cooled-down events: posture, stood in crib, rolled, holding, risky object within reach, soft toy near a lying baby, in/left a play area. |
| Family calls | `live-worker/src/familyCalls.ts` (rules), `monitorRoom.ts` (switchboard), `live/calls/*` (app), `live/views/calls/*`, `live/views/CallsView.tsx` | FaceTime-style video / voice calls between a nursery's members — see “Family calls” below. |
| Two-way audio safety | `live/monitor/voice.ts` | Parent's mic: high-pass → compressor → soft fade-in. Camera: howl (feedback) detector mutes the speaker and switches the parent's phone to walkie-talkie; a closed-loop governor holds talk ≤ 65 dB and soothing sounds ≤ 50 dB at the crib. |
| Screen-on | `live/wakeLock.ts`, `public/keep-awake.mp4` | Wake Lock re-acquired on release + 15 s watchdog; looping-video fallback where it's refused; state shown to the family. |
| Alarm detector | `live/monitor/alarmTone.ts` | Smoke (T3) / CO (T4) beep patterns from the spectrum — independent of the model. |
| Viewer screen | `live/views/MonitorViewer.tsx` + `live/views/monitor/*` | Listen / talk (tap or hold) / video call / soothe, alert stack + stage glow + alarm takeover, Safety card (incidents, guards, duty), Sleep card + morning report, Sound level card (live + 1/6/24 h history), "Hearing now", filterable log, alert + nursery settings, zone editor. Frozen-video detection. |
| Alert cues | `live/monitor/alerts.ts` | Per-category synthesized sounds, speech, vibration, repeat-until-answered, title flashing, snooze, per-device prefs. |
| Guidance | `live/components/Guide.tsx`, `MonitorHome.tsx` | Tours per screen, 10 how-to guides, nursery "Get set up" checklist (`live/monitor/setupProgress.ts`). |

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

**Relay picture (P2P can't connect):**
- Viewer (`linkFallback.ts`): gives P2P 10 s, then subscribes to the relay and retries
  P2P after 30 s, 1, 2, 4, then every 5 min; a late connect cancels the retry instead
  of being torn down by it. The subscription is re-sent after every room reconnect and
  when switching cameras. Frames draw straight onto a canvas (no re-render per frame);
  the pill shows the fps actually arriving; no frame for 5 s → “Picture paused”.
- Camera (`setRelay` + `RelayPacer`): 640 px JPEG, 2–5 fps by the socket's
  `bufferedAmount` (backlog over 80 KB → skip and step down; 2 s clear → step up),
  quality 0.35–0.6 by frame size, never queued behind more than 128 KB
  (`client.sendBinary(data, maxBuffered)`). A camera that (re)joins is told at once
  how many viewers want its relay.
- Room: frames from cameras only, to viewers relaying that camera only; a token
  bucket per camera (25 fps sustained, burst 8, ~1.5 MB/s) instead of the old hard
  250 ms gap that dropped jittery frames. Frames pass through the Durable Object's
  memory — **not end-to-end encrypted** like P2P, never stored (the pill's tooltip
  says so). No sound in relay mode; alerts are unaffected.
- Cost: a 4 fps relay is ~144k incoming WebSocket messages per 10 h night (≈ $0.03 per
  nursery per month at the 20:1 request ratio); outgoing messages are free.

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
- **Roles**: "Watch & listen" (viewer) or "Also talk, soothe & answer alerts"
  (caregiver). Guests can never run a camera, change settings, manage people or
  download history; Supabase member re-checks never touch them.
- Code: `live-worker/src/monitorGuests.ts` (+ tests), `MonitorRoom` (`/guest`
  join, `share_set` / `share_off` / `guest_remove`), `live/monitor/guest.ts`,
  `live/views/MonitorJoin.tsx`, `live/views/monitor/PeopleCard.tsx`.

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

**Media.** A mesh: one RTCPeerConnection per pair, audio + video transceivers
from the start, so mute / camera off / flip / turning the camera on in a voice
call are `replaceTrack` or `enabled` — no renegotiation. Of any two people, the
one who joined later makes the offer (`joinedAfter`), so there's no glare; the
offerer restarts ICE on failure (three tries). Signaling (`call_rtc`) is relayed
only between two devices in the same call. Peers are keyed by person, not
socket, and a line that drops keeps its place for 20 s (`LINE_GRACE_MS`) — the
app rejoins from its new connection and the media carries on. Video bitrate is
shared across the uplink (1.5 / 0.9 / 0.6 Mbps for 1 / 2 / 3 others); each
tile shows a weak-connection hint from packet loss and round-trip time, and
"Home Wi-Fi" when everyone is on the local network.

**Screen.** Remote video full-bleed (a grid for groups), your picture in a
draggable corner, controls that fade while you talk (mute, camera, flip, add
someone from the nursery, end), a call timer, minimize to a floating window
while using the app, "Camera off" faces, "Reconnecting…" veils, and a clear end
state ("Grandpa can’t talk right now", "Call again"). The screen stays awake
during a call. Calls history (last 60 per nursery) shows who, which way, how long
and missed calls; tap to call back.

**Limits.** Four people per call (each phone uploads a copy per person). Ringing
with the app closed needs notifications (on iPhone, the Home Screen app). Calls
reach only members of a nursery you share.

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
