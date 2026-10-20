# Baby Monitor (Stream Studio)

A private, never-recording baby monitor inside Stream Studio (`/live#/monitor`).
One device in the nursery is the **camera**; any device the family signs in on can
**watch**. Video and sound go peer-to-peer (WebRTC, DTLS-SRTP); the server only
relays signaling, status numbers and events.

## Pieces

| Piece | Where | What it does |
|---|---|---|
| Nurseries, people, roles | Supabase RPCs (`server/sql/live_accounts_and_monitor.sql`) | Members only; Parent / Caregiver / Viewer with labels ("Grandma"). |
| MonitorRoom | `live-worker/src/monitorRoom.ts` (Durable Object per nursery) | Socket auth via `monitor_my_role`, signaling relay, status fan-out, log + 7-day timeline, camera heartbeat/offline alerts, Web Push. |
| Camera screen | `live/views/MonitorCamera.tsx` | Setup wizard (browser check, permissions, lens picker, zoom, live checks), FaceTime-style running screen, auto-dim, privacy pause, interruption recovery. |
| Device plumbing | `live/monitor/camera.ts` | In-app browser detection, friendly lens names, constraint ladder, human error text, zoom, iOS `audioSession` for speaker playback. |
| Peer links | `live/monitor/rtc.ts` | Viewer offers `video sendrecv` + `audio sendrecv`; outgoing tracks swapped with `replaceTrack` (talk / video call on & off with no renegotiation). |
| Sound engine | `live/monitor/soundEngine.ts` | Mic → analyser (cry analyser 10 Hz, alarm pattern 20 Hz) and PCM tap → 16 kHz resampler → YAMNet worker every 0.48 s → `SoundBrain`. |
| AI sound model | `live/monitor/yamnet.worker.ts`, `public/models/yamnet/` | Google YAMNet (Apache-2.0, 521 AudioSet classes) via onnxruntime-web WASM, single-threaded, SHA-256 verified, cached. |
| Categories | `live/monitor/soundClasses.ts` | cry, fuss, cough, alarm, crash, loud, babble, laugh, voices, music, dog — YAMNet class weights, thresholds, severities. |
| Fusion | `live/monitor/soundBrain.ts` | Persistence, hysteresis, loudness gating, priority masking, cooldowns → start/end events + mood. |
| Alarm detector | `live/monitor/alarmTone.ts` | Smoke (T3) / CO (T4) beep patterns from the spectrum — independent of the model. |
| Viewer screen | `live/views/MonitorViewer.tsx` | Listen / talk (tap or hold) / video call / soothe, alert stack + stage glow + alarm takeover, "Hearing now", filterable log, alert settings. |
| Alert cues | `live/monitor/alerts.ts` | Per-category synthesized sounds, speech, vibration, repeat-until-answered, title flashing, snooze, per-device prefs. |
| Guidance | `live/components/Guide.tsx`, `MonitorHome.tsx` | Tours per screen, 10 how-to guides, nursery "Get set up" checklist (`live/monitor/setupProgress.ts`). |

## Sound detection — measured

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

## Alerts

- Camera → `event {kind:'sound', cat, phase, conf, secs}` → MonitorRoom logs
  (per-category flood guard) → every viewer + Web Push (per-category prefs:
  cry, alarm (always), cough, crash, fuss, loud, offline, battery).
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

## Limits (stated in the UI)

Not a medical device: it does not monitor breathing, temperature or safe sleep.
Phones pause cameras in the background — the camera page must stay open (the
screen dims itself); an offline camera alerts everyone within about a minute.
