# Stream Studio — Live Streaming for DreamStream

Status: proposal / design doc (no code yet)
Scope: minimalist live streaming for up to ~100 concurrent viewers, hosted inside the
DreamStream website, built entirely on the Cloudflare stack we already run
(Workers, Durable Objects, R2) plus Supabase (auth, metadata) and Cloudflare Stream.

---

## 1. Product summary

A creator opens **Stream Studio** on their phone or laptop, schedules an event, shares a
link, and goes live from their camera. Anyone with the link (or anyone the streamer /
moderator lets in through the lobby) watches in high quality on mobile or desktop, and
chats with emoji. The streamer can pause the broadcast and record the program feed in
full clarity. Recordings contain only the stream video — chat is never burned in
(chat is logged separately like any normal app data).

Design: minimalist, clean, light + dark mode. See `stream-studio-mockup.html` next to
this file for the interactive design mockup (Studio, Viewer, Lobby, Schedule screens).

---

## 2. Architecture decision

Two viable paths on Cloudflare, used together in phases:

### Path A — Realtime mode (v1, pure web, ships first)
- **Ingest:** browser `getUserMedia` → **WHIP** (WebRTC) → Cloudflare Stream Live WebRTC.
- **Playback:** **WHEP** (WebRTC) → sub-second latency, no practical viewer limit.
- **Recording:** Cloudflare's WebRTC beta does **not** generate cloud recordings yet, so
  we record **on-device** with `MediaRecorder` at full source quality (this is actually
  *higher* fidelity than any cloud recording — no second transcode) and background-upload
  to **R2** via multipart; optionally re-ingest into Stream for VOD playback.
- **Pause:** `RTCRtpSender.replaceTrack()` with a generated "Be right back" slate track —
  the session stays up; local recording pauses or continues per the streamer's choice.
- Caveat: WHEP is pass-through (one quality for all viewers, no ABR ladder). Fine for
  ≤100 viewers on reasonable networks; Quality mode (Path B) covers the rest.

### Path B — Quality mode (v1.5)
- **Ingest:** RTMPS or SRT (OBS, Larix/Moblin on mobile, our future native app) →
  **Cloudflare Stream Live**.
- **Playback:** LL-HLS / DASH with an adaptive ladder up to **1080p**; latency ~3–15 s.
- **Recording:** automatic cloud recording (ready ≤60 s after end), DVR mode available
  (`dvrEnabled=true`), recordings billed as stored minutes.
- Stream Live ingest facts (verified against CF docs, 2026): H.264 + AAC, bitrate
  "typically well under 12 Mbps", GOP 2–8 s (1–2 s for low latency), reconnect-tolerant,
  recordings truncated at 7 days, live inputs can be disabled via API (`enabled: false`)
  — which doubles as a kill switch per event.

### The resolution answer (asked: "absolute best we can support")
| Path | Ceiling | Notes |
|---|---|---|
| Stream Live (RTMPS/SRT → LL-HLS) | **1080p60 @ ~8 Mbps** | CF's encoding table tops out at 1080p; higher inputs are downscaled. Full ABR ladder + cloud recording + DVR. |
| WHIP/WHEP (WebRTC) | ~**1080p** from browsers; 4K technically possible from native WHIP clients | Pass-through, no ABR, no cloud recording (beta). |
| Realtime SFU (build-your-own) | **4K pass-through** | $0.05/GB egress after 1 TB free/mo; we'd build recording, ABR, and playback glue ourselves. Not worth it for v1. |

**Product answer:** ship **1080p60 as "Full quality"**, and let the device record
**locally at up to 4K** while streaming 1080p — viewers get the best deliverable
quality, the creator keeps a master copy better than anything the audience saw.

### Cost at 100 viewers (Stream path)
- Delivery: $1 / 1,000 min → 100 viewers × 60 min = 6,000 min ≈ **$6 per event-hour**.
- Recording storage: $5 / 1,000 min → 60-min recording ≈ **$0.30**.
- Ingest + encoding: **free**. Chat/presence on a Durable Object: pennies.
- Realtime/TURN egress (if used): first 1 TB/mo free, then $0.05/GB (~$9/event-hour at 4 Mbps).

---

## 3. System components (maps onto existing infra)

```
Browser/phone Studio ──WHIP──▶ Cloudflare Stream Live ──WHEP/LL-HLS──▶ Viewers
        │                                  │
        │ local MediaRecorder (full res)   └─ auto recordings (Path B)
        ▼
       R2 (multipart upload) ──▶ Stream VOD (optional re-ingest)

dreamstream-live Worker (new, or extend studio-worker)
  ├─ REST: create/schedule/start/stop event, mint live inputs (CF API),
  │        sign playback tokens, issue ICS, OG share cards
  └─ Durable Object per event ("EventRoom"):
       chat (WebSocket hibernation), presence + viewer count,
       lobby knock → admit/deny, mod actions (delete msg, kick, ban, slow mode),
       emoji reactions fan-out

Supabase (existing): events, participants, roles, recordings metadata, chat log
  (chat is logged normally per product decision — just never rendered into video)
Turnstile (already in repo): join-gate anti-abuse for anonymous viewers
email-worker (existing): invites, "starting soon" reminders for scheduled events
```

Auth: reuse Supabase sessions. Roles per event: `host`, `moderator`, `viewer`
(+ `pending` in lobby). Access modes: *Anyone with link* / *Approval required (lobby)* /
*Invited only*. Playback protected with Stream signed URLs (supported on WebRTC beta too).

---

## 4. iOS camera lenses (telephoto / wide / ultra-wide)

- **Web today (Safari 17+):** `enumerateDevices()` exposes the discrete back cameras
  (Ultra Wide, Wide, Telephoto) on recent iPhones, and the `zoom`/`torch` constraints are
  supported — so the web Studio gets real **0.5× / 1× / 2-5× lens chips on day one**.
  Limitations: switching lenses swaps tracks (a brief cut, not Apple's seamless blend),
  capture realistically tops out ~1080p, no backgrounding, limited thermal control.
- **Native iOS (Phase 2):** a small capture app ("DreamStream Capture", Swift +
  AVFoundation `builtInTripleCamera` virtual device) gives seamless mid-stream lens
  switching, 4K HDR sensor capture, cinematic stabilization, proper thermal/battery
  handling, and an RTMPS/WHIP encoder (e.g. HaishinKit). It records the **camera program
  feed only — explicitly not screen recording** (ReplayKit not used).

---

## 5. Feature spec (v1 unless marked)

- **Schedule + share:** event page with title/cover/time, short link `/live/<slug>`,
  copy link, ICS download, OG card for social previews; email reminders via email-worker.
- **Lobby / gatekeeper:** waiting room; host and moderators see knock requests and
  admit/deny; kick + ban; promote viewer to moderator.
- **Chat:** minimal, emoji picker + inline emoji, floating emoji reactions, pinned
  message, slow mode, mod delete. Logged to Supabase; never part of the recording.
- **Studio controls:** go live / end, pause (slate), REC toggle ("Records the program
  feed, not your screen"), mic/cam mute, lens chips, quality selector (720p / 1080p),
  health row (bitrate, fps, dropped frames, network meter).
- **Viewer:** clean player, live badge + viewer count, DVR scrub (Path B), chat panel,
  reactions, theater mode.
- v1.5: Quality mode (RTMPS + LL-HLS + cloud DVR), restream to YouTube/Twitch
  (Stream Live outputs), clips ("last 30 s" → shareable), chat replay overlay on VOD
  (client-side overlay from the chat log — never burned in).
- v2: native iOS capture app; bring-a-guest co-streaming via Realtime SFU; paid/ticketed
  events.

---

## 6. Design language (see mockup)

Minimalist and quiet: Inter, hairline borders, 12 px radii, generous whitespace, one
accent per state (red = live/record, brand yellow reserved for primary CTAs), true
light + dark themes via CSS variables (`data-theme`), no chrome that competes with the
video. The mockup file is self-contained HTML with a working theme toggle and all four
screens (Studio / Viewer / Lobby / Schedule).

---

## 7. Standalone product potential ("DreamStream Live")

The same Worker + DO + Stream architecture is multi-tenant by construction (an event is
just a row + a DO + a live input). Expansion ladder:

1. **Embed SDK / white-label:** `<dreamstream-live event="...">` web component + signed
   playback for other sites. Marginal cost ≈ $0.06 per viewer-hour, so even modest
   per-event pricing has healthy margins.
2. **Ticketed + subscriber events:** Stripe checkout gates the lobby; the
   approval-required flow already models entitlement checks.
3. **Comics-native differentiation:** draw-along streams from the comic editor (canvas
   as a second WHIP source), comic launch premieres, panel overlays — no competitor
   (StreamYard / Crowdcast / Livestorm) has a creation tool attached to the stage.
4. **API tier:** the REST surface (create event, mint tokens, webhooks for
   started/ended/recording-ready) is the product for developers.

Suggested rollout: ship inside DreamStream → separate `live.dreamstream*` subdomain →
embeds/API → billing.

---

## 8. Build phases

- **Phase 0 (≤1 day):** Supabase tables (`live_events`, `live_participants`,
  `live_chat_log`, `live_recordings`) + `dreamstream-live` Worker scaffold + EventRoom DO.
- **Phase 1 — MVP (~1–2 weeks):** web Studio (WHIP publish, lens chips, pause slate,
  local REC → R2), viewer page (WHEP + signed URLs), chat/lobby/presence DO, schedule +
  share + ICS, light/dark UI per mockup. Feature flag: `VITE_STREAM_LIVE_ENABLED`.
- **Phase 1.5:** Quality mode (RTMPS/LL-HLS, cloud recording + DVR), restream outputs,
  clips, chat replay overlay.
- **Phase 2:** native iOS capture app (lens-perfect, 4K local masters).
- **Phase 3:** guests via Realtime SFU, ticketing, embeds/API.
