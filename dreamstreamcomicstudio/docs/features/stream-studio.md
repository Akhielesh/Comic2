# Stream Studio — Live Streaming for DreamStream

Status: **v2 implemented on the R2 rail** — see §9 for what shipped and how to test.
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

### Cheaper rails — same or better quality

Stream bills per **viewer-minute, not per pixel** — 1080p costs the same as 480p — so
cost is cut by changing the delivery rail, never by lowering quality:

| Rail | Cost per 100-viewer event-hour | Trade-off |
|---|---|---|
| Stream WebRTC beta (Path A, the v1 plan) | **$0 today** — docs: pricing applies "once generally available"; budget $6/hr at GA | Beta pricing will end eventually |
| Realtime SFU (WHIP/WHEP via session API) | **$0 within 1 TB/mo free tier** (~5 event-hours at 4 Mbps), then ~$9 | More integration code; confirm current WHIP/WHEP surface in a spike |
| **R2-served HLS (DIY packager)** | **~$0.10 at any viewer count** — R2 has zero egress, viewers hit CDN cache; segments ARE the recording (free VOD) | ~6–15 s latency, single rendition (no ABR), most engineering |
| Stream Live HLS (Path B) | $6 + recording | The managed, zero-engineering ceiling |

Additional standing savings:
- **Store recordings in R2, not Stream storage:** a 1080p hour ≈ 2.7 GB ≈ **$0.04/month**
  in R2 vs $0.30 + delivery fees in Stream. Only re-ingest into Stream the recordings
  that need polished VOD playback.
- On-device recording (already the plan) costs nothing and beats any cloud transcode.
- Not viable: running a media server in Cloudflare Containers (no non-HTTP/UDP ingress).
  Self-hosting MediaMTX on a ~€6/mo VPS is the absolute floor (~70 event-hours/mo, WHIP
  in / WHEP + HLS out / disk recording) but adds ops burden and a single region —
  only worth it if events become very frequent.

**Net:** v1 as planned costs ≈ $0/month today. The long-term hedge is the R2-HLS rail
(near-zero at any scale) with Stream as the premium ABR tier.

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

---

## 9.2 v4 additions (shipped — brand, accounts, onboarding, guardrails)

- **Brand:** new `StreamStudioMark`/`StreamStudioLogo` component (on-air tile:
  rounded square, broadcast arcs, live dot) used across the rail/topbars, with
  `public/stream-studio.svg` as the favicon/asset.
- **Camera honesty:** the burned-in digital zoom is gone — zoom appears only
  when the device exposes NATIVE camera zoom on the track (Chrome Android /
  Safari 17+). Front/rear flip uses `facingMode: { exact }`; the host's
  self-view is mirrored on the front camera (the program/viewers stay
  unmirrored, like every camera app).
- **Screen + cam layouts:** PiP corner (↖↗↙↘) + size (S/M/L) + a side-by-side
  mode, switchable live from the camera bar and remembered. (True multi-guest
  scenes still need WebRTC guest ingest — next big rock.)
- **Host-exit guardrail:** if the host's tab closes mid-stream the room pauses
  instantly (viewers see BRB) and **auto-ends after 2 minutes** unless the host
  returns; restarting after an auto-end works. Saves storage + strands nobody.
- **Account & settings sync:** Stream Studio now has an Account & sync panel —
  signed-in users (shared DreamStream Studio session) get events AND settings
  synced via `stream_studio_settings` (newer-wins). Signed-out stays local.
  "Import event" on the dashboard adds an event from its private studio link
  (phone→laptop without an account).
- **Per-product access (`server/sql/product_access.sql`):** generic
  `product_access` table — admins onboard users to exactly one studio
  (stream/comic/chat) standalone or revoke one. New admin API:
  `POST/GET /api/admin/product-access` (requireAdmin), optional branded invite.
- **Invite email:** new `studio-invite` template ("X invited you to Stream
  Studio") with a feature tour and a "more studios coming soon" note;
  `sendStudioInvite()` in the mailer.
- **Misc:** emoji library grown to 72; the dashboard's history-delete button
  was removed (history is durable); cloud prefs adopt on app start.

## 9.1 v3 additions (shipped — performance, retention, moderation, accounts)

Product name is now **Stream Studio** everywhere user-facing (the worker keeps
its deployed `dreamstream-live` name/route — infra, not branding).

- **Performance:** 6 s segments (half the encoder rotations → smoother audio,
  fewer seams; deliberate ~10 s glass-to-glass buffer), frame-skip compositor
  (draws only when a source frame advances; opaque desynchronized 2D context).
- **Mobile camera fixed:** the program canvas follows the camera's real
  orientation/aspect (portrait phones stream portrait — no more "zoomed in"
  center-crop), aspect-mismatched sources letterbox instead of cropping
  (>25% crop guard), camera flip uses `facingMode: { exact }` with fallback,
  and a lens cycler steps through every physical camera (0.5×/1×/tele).
- **Fullscreen that works:** real Fullscreen API on the stage (landscape lock
  for landscape streams) with a CSS viewport-takeover fallback for iPhone
  Safari; chat stays usable in fullscreen (message peek + slide-up chat sheet).
- **Recordings:** still always saved to the device, now ALSO uploaded (16 MB
  R2 multipart parts, retried) to a host-only server store — list/download in
  the recap — **kept 7 days then auto-purged** by the room's alarm janitor.
- **24 h replay window:** viewers can rewatch from the same link for 24 hours
  after the end; segments purge automatically afterwards. Abandoned rooms
  auto-end after 2 h without segments.
- **Hard viewer cap:** host sets 25–200 per event (platform ceiling 200,
  enforced at the socket — over-cap joins get a clear "stream is full").
- **Moderation:** profanity wordlist (with leet normalization) + repeat-spam
  detection auto-hide messages, strike → 5-minute timeout, everything logged
  to the durable activity log; slow mode unchanged.
- **Emoji library:** 48-reaction library behind a "+" picker everywhere
  (quick bar stays 6); the room allowlist mirrors it (tested in sync).
- **Telemetry:** the studio reports uplink/encoded-bitrate/failures every 30 s
  → durable `healthCurve` → "Network health" chart in the recap.
- **Accounts & cross-device sync:** `server/sql/stream_studio.sql` adds
  `stream_studio_events` (RLS owner-locked: id + hostKey travel with the
  account, so past sessions appear on every device) and `stream_studio_access`
  (admin/service-role managed: revoke streaming with `active=false`, or
  onboard streaming-only users with `scope='studio_only'` — the main app can
  read this to confine such accounts to /live.html). Signed-out users keep
  the localStorage-only flow.

## 9. v2 implementation (shipped — full redesign)

The whole surface was rebuilt around the warm, paper-clean "calm studio" design
system (cream canvas, clay accent, hairline borders; light + warm-espresso dark,
four accent choices, persisted per device).

**Frontend (`live/` + `live.html`, hash/query-routed SPA):**

- **Dashboard** — live-now hero, honest lifetime stats, your streams (hydrated
  from the worker = cloud truth; id+hostKey live only in your browser), recording
  downloads, tabs for live/scheduled/past.
- **Create / schedule** — title, host name, go-live-now vs date+time, description,
  cover theme, quality preset, open vs approval access, auto-record; produces the
  viewer/invite link + private studio link, with .ics add-to-calendar.
- **Invite page** (Luma-style, fully cloud-backed) — cover, date block, host,
  description, RSVP ("save my spot", name only), countdown, share; flips to the
  watch page the moment the host goes live.
- **Host Studio** (the hero) — real camera through a **canvas program mixer**
  (`live/studio/compositor.ts`): scenes (Solo / Screen+cam PiP / BRB slate) cut
  seamlessly because the encoder records the canvas, never restarting; camera
  looks (soften/warm/mono) and **digital zoom burned into the program**; hardware
  zoom + lens switching where the device exposes them; transport bar; hotkeys
  (G/Space/V/R/B/1–3/M//); collapsible four-tab right rail — **Chat** (pin,
  delete, slow-mode aware), **People** (lobby admit/deny, viewer list,
  promote-to-mod, kick), **Activity** (durable server-side log, filterable),
  **Health** (uplink meter, encoded bitrate, failures, latency estimate, viewer
  curve); metrics overlay; **phone broadcaster mode** (auto on small viewports,
  desktop preview toggle) with thumb rail (mic/cam/flip/zoom/scene), chat peek +
  sheet, go-live/end.
- **Viewer** — name-only join gate (no account), desktop layout with chat rail +
  **Theater** declutter, true mobile layout with fullscreen mode + one-thumb
  reactions; status slates (starting-soon countdown, branded BRB, ended + replay);
  reconnecting indicator; playback metrics overlay (incl. which player engine).
- **Post-stream Summary** — peak/unique viewers, chat + reaction totals, RSVPs,
  watch-time + chat/min curves, the full durable event log (filterable), top
  chatters, recordings, export-as-JSON, replay link.
- **Customize** — scenes & host name, camera looks, chat & reactions (slow mode),
  quality & encoding (preset, bitrate override, MP4-vs-WebM preference, master
  recording bitrate, auto-record), alerts (lobby knocks, milestones, chime),
  hotkeys reference. Persisted in `localStorage`, applied when the studio opens.

**Playback compatibility (the "viewers can't watch on mobile" fix):**

- `live/player.ts` now picks per device: classic **MSE** → **ManagedMediaSource**
  (iPhone Safari 17.1+) → **blob queue** (no MSE at all: each self-contained
  segment plays back-to-back as an object URL) → a *specific* error naming the
  codec when nothing can decode it.
- Two start-up bugs fixed: the player used to be started before the `<video>`
  element mounted (playback silently never began), and viewers who joined before
  the host's first segment got a player initialized with the wrong container.
  Player starts are now deferred until the element exists and the real mime is
  known.
- `WORKER_BASE` defaults to same-origin `/live-api` (not a hardcoded domain), and
  the studio warns when it's running on localhost (links that can't work off-box).

**Worker (`live-worker/`):** `EventRoom` now also stores event details (host,
description, cover), RSVPs, a capped **activity log** (state changes, admits,
kicks, milestones, segment-gap warnings — streamed live to the host and served in
the recap), and **stats** (peak/unique viewers, chat + emoji totals, per-minute
chat curve, 30-second viewer-curve samples via the DO alarm while live). New
routes: `GET /api/events/:id/stats?k=hostKey` (host-gated recap) and
`POST /api/events/:id/rsvp`. Hosts can set slow mode / toggle reactions over the
socket (`config`), report production events into the log (`log`), and receive a
live `people` roster for moderation.

- Delivery encoding (unchanged rail): the studio rotates MediaRecorder instances
  every 3 s so each segment is independently playable; MP4/H.264 preferred (plays
  everywhere), WebM opt-in. ~4–10 s glass-to-glass latency.
- Tests: `live/live.unit.test.ts` (presets/codec/playback-fallback/schedule/theme
  logic) runs in CI.

**Test locally:** `cd live-worker && npm install` once, then `npm run dev:live`
from the app root and open `http://localhost:7000/live.html`. Deploy: see
`live-worker/README.md` (R2 bucket + `wrangler deploy` + `VITE_LIVE_WORKER_URL`).

Not yet built (next): multi-guest scenes (interview/grid — needs WebRTC ingest
for guests), recording upload to R2/Drive, sub-second mode.

---

## 10. Creative cost strategies (evaluated)

The guiding fact: on this rail the marginal cost of a viewer is ~zero, so
"cheaper" comes from storage and from who pays for it.

| Idea | Verdict |
|---|---|
| **Route the live stream through the user's Google Drive** | Not viable for *live*: Drive's API rate limits and propagation latency can't serve 3-second segments to a fan-out audience, and using it as a CDN violates its ToS. |
| **Google Drive as bring-your-own-storage for recordings** | The legit version of the same idea, and worth building: after the stream, the master recording (and optionally the segment VOD) uploads to the *creator's* connected Drive. Our storage cost: $0. The user owns their masters. Works for Dropbox too. |
| **Audience-tiered rails** | <8 viewers: direct P2P WebRTC from the host (cost $0, sub-second). 8–100+: R2 rail (~$0.10/hr). Premium tier: Cloudflare Stream ABR ($6/hr). The event API is rail-agnostic so this is a routing decision, not a rewrite. |
| **P2P segment mesh between viewers** | Legit (WebRTC data channels), but it only saves egress — and R2 egress is already $0. Skip. |
| **Free-tier surfing** | Stream's WebRTC beta is currently unbilled and Realtime includes 1 TB/mo — both usable as overflow/low-latency modes while they last. |
| **Restream to YouTube unlisted** | $0 escape hatch for very large one-off audiences; costs you branding, data and control. Offer as an output, not the default. |

---

## 10. v5 — on-air guests & cost guardrails (2026-06-11)

- **Guest seats (≤4):** host mints a guest link in the studio (People → Invite guests on
  air; the `g` key is the seat pass, host can rotate it via the `guestkey` room message).
  Guests connect over a host-centric WebRTC mesh — signaling rides the room socket as
  `{t:'rtc'}` envelopes (host=impolite, guest=polite perfect negotiation; STUN only, so
  symmetric-NAT⇄symmetric-NAT pairs surface a clear "link failed" state). The host mixes
  guest cams/mics/screens into the program canvas + a WebAudio mixer, so the R2 delivery
  rail and recordings are unchanged. Guests hear the host's return feed in real time;
  viewers hear everyone via the program. Multiple simultaneous screen shares are
  supported — each share is its own tile.
- **Scenes:** Grid / Spotlight / Sidebar joined Solo / Screen+cam / BRB (hotkeys 1–6),
  with a featured-tile picker and name-tag chips burned into the program.
- **Tab-close = end:** `pagehide` beacon → `POST /api/events/:id/exit?k=hostKey` ends the
  stream instantly (restartable — "Go live again"). Silent drops keep pause → 2-min
  auto-end; 2 h ingest silence still hard-ends. Guests/viewer caps: guests don't count
  against the 200-viewer ceiling; guest seats cap at 4.
- **Account attach:** Settings → Account → Sign in round-trips the main app via
  `/?next=/live.html#/settings` (App.tsx honors same-origin `next` for 15 minutes).
