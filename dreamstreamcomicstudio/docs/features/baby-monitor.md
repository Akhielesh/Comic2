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
| Peer links | `live/monitor/rtc.ts` | Viewer offers `video sendrecv` + `audio sendrecv`; outgoing tracks swapped with `replaceTrack` (talk / video call on & off with no renegotiation). |
| Sound engine | `live/monitor/soundEngine.ts` | Mic → analyser (cry analyser 10 Hz, alarm pattern 20 Hz) and PCM tap → 16 kHz resampler → YAMNet worker every 0.48 s → `SoundBrain`. |
| AI sound model | `live/monitor/yamnet.worker.ts`, `public/models/yamnet/` | Google YAMNet (Apache-2.0, 521 AudioSet classes) via onnxruntime-web WASM, single-threaded, SHA-256 verified, cached. |
| Categories | `live/monitor/soundClasses.ts` | cry, fuss, cough, sneeze, snore, babble, laugh, alarm, glass, crash, loud, voices, music, dog, cat, knocking, footsteps, running water — YAMNet class weights, rival classes, thresholds, severities. |
| Fusion | `live/monitor/soundBrain.ts` | Persistence, hysteresis, loudness gating, priority masking, the cat-vs-cry guard, cooldowns → start/end events + mood. `ongoing()` replays what's happening for a room that missed the start. |
| Sound level meter | `live/monitor/soundLevel.ts` | IEC 61672 A-weighting (bilinear biquads) + Fast (125 ms) time weighting in an AudioWorklet; live dB(A), per-minute LAeq / Lmax / L10 / L50 / L90 / peak; two-step calibration (quiet room ≈ 30 dB, or match a meter); never reads below the mic's floor. |
| Vision | `live/monitor/vision.ts` | 64×48 frames at 4 fps: exposure-normalised cell differences, crib + danger zones, climb-out, visits, lights on/off, dark/covered lens, camera moved (scene signature + phone tilt). |
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
