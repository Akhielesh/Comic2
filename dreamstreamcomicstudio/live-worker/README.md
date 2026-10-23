# dreamstream-live — Stream Studio's live worker

The backend for **Stream Studio** (`stream.dreamstreamstudio.ai`): one Durable Object per event
(chat, lobby, presence, moderation, stream state) plus the R2 segment rail —
the streamer's browser uploads short self-contained media segments, viewers pull
them back through the Cloudflare cache. R2 has **zero egress fees**, so a
100-viewer hour costs roughly **$0.10** regardless of audience size.

The frontend lives in `../live/` and is served as `/live.html` by the main app.

## Test locally (no Cloudflare account needed)

```sh
# 1. install worker deps once
cd live-worker && npm install && cd ..

# 2. run worker (miniflare, port 8788) + vite together
npm run dev:live

# 3. open http://localhost:7000/live.html → Create event → Open Studio
#    open the viewer link in a second tab/device. Camera needs localhost or HTTPS.
```

To test from a phone on your LAN, the page must be served over HTTPS (camera
permission). Easiest: `npx vite --host` + a tunnel (e.g. `cloudflared tunnel`)
pointing at both ports, with `VITE_LIVE_WORKER_URL` set to the worker tunnel URL.

## Deploy

```sh
npx wrangler r2 bucket create dreamstream-live   # once
# once: the 7-day copy ledger (quota/rec/<account>/…, cloudCopyQuota.ts) expires on its own,
# so no per-copy record outlives its copy, even for an account that never checks again
npx wrangler r2 bucket lifecycle add dreamstream-live quota-rec-expiry quota/rec/ --expire-days 8
# once: backstops for each event room's own janitor (eventRoom.ts) — a sweep that failed, a room
# that never ended — and unfinished 7-day-copy uploads (R2's default keeps their parts 7 days)
npx wrangler r2 bucket lifecycle add dreamstream-live events-expiry events/ --expire-days 9
npx wrangler r2 bucket lifecycle add dreamstream-live events-abort-multipart events/ --abort-multipart-days 1
npx wrangler r2 bucket lifecycle list dreamstream-live
cd live-worker && npx wrangler deploy
```

The `quota/rec/` rule must stay **longer than 7 days**: a marker counts for 7 days from its
upload, and deleting one sooner would let copies past the 10 GB allowance. The `events/` rule
must stay longer than every promise (replay 24 h, copies 7 days); the rooms themselves purge on
time and then delete their own storage, so it only catches what they missed.

The worker is also exposed on workers.dev (used by the old Pages launch domain):

```
https://dreamstream-live.akhieleshsrirangam.workers.dev
```

**Legacy:** `comic2.pages.dev` used that workers.dev base automatically from
`live/config.ts`. Since 2026-10-22 that host only 301s to `dreamstreamstudio.ai`
(`functions/_middleware.ts`), so the fallback serves just tabs opened before the switch;
`ALLOWED_ORIGINS` keeps `https://comic2.pages.dev` for them until a later cleanup.
Custom domains use same-origin `/live-api`: `stream.dreamstreamstudio.ai/live-api/*` (Stream Studio's own host) and `dreamstreamstudio.ai/live-api/*` (the old address, kept for installed apps and open tabs).

If you move accounts or workers.dev subdomains, either update
`FALLBACK_PAGES_LIVE_WORKER_BASE` in `live/config.ts` or set this in the frontend
build environment (Cloudflare Pages):

```
VITE_LIVE_WORKER_URL=https://dreamstream-live.<your-subdomain>.workers.dev
```

Keep `ALLOWED_ORIGINS` in `wrangler.jsonc` tightened to the site origins that should
call the worker.

## API

| Route | Purpose |
| --- | --- |
| `POST /api/events` | create event → `{ id, hostKey }` |
| `GET /api/events/:id` | public meta (status, latestSeq, viewers, …) |
| `GET /api/events/:id/ws` | WebSocket into the EventRoom (chat/lobby/state/segments) |
| `POST /api/events/:id/segments?seq&ms` | host uploads one segment (binary, `x-host-key`) |
| `GET /api/events/:id/segments/:seq` | viewer fetches a segment (immutable, CDN-cached) |

Costs at 100 viewers: segments are written once (free ingress), read through
`caches.default` (≈1 R2 read per segment per colo), and stored at R2's
$0.015/GB-month. Chat/presence ride one Durable Object. There is no per-minute
delivery billing on this rail.

## On-air guests (v5)

The room doubles as the **WebRTC signaling relay** for up to 4 on-air guests:

- The host mints a `guestKey` over the socket (`{t:'guestkey'}`, `rotate:true`
  invalidates every previously shared link). Guests connect to `/ws?g=<key>`
  and take a `guest` role — they bypass the lobby (the key IS the seat pass),
  don't count against the viewer cap, and cap at `MAX_GUESTS = 4`.
- `{t:'rtc', to?, d}` frames relay SDP/ICE between host and guests only
  (guest→host, host→named guest; 64 KB ceiling for SDP, all other frames stay
  at 4 KB). The DO never inspects payloads. Media is peer-to-peer (STUN only);
  the host mixes guests into the program canvas, so the R2 rail is unchanged.

## Cost guardrails

- `POST /api/events/:id/exit?k=hostKey` — pagehide beacon from the studio tab:
  ends the stream immediately (restartable; going live again clears `endedAt`).
- Host websocket drop while live → `paused` + 2-minute grace → auto-end.
- 2 h without segment ingest while "live" → auto-end.
- Segments purge 24 h after end; server recordings purge after 7 days, and then the room sets no
  further alarm. The event itself is never deleted: an ended event can go live again from the same
  studio link, and its invite page, RSVPs and host/guest keys keep working. What stays is a few KB of
  rows with no R2, no alarm and no requests. A host who goes live again mid-purge stops it.
- While live, a chat line not yet written rides its poster's socket attachment and the counters ride
  the host's, so a room that hibernates in an upload stall loses neither; a delete always reaches
  every screen.
- One DO request per segment: the Worker remembers a host key the room confirmed (a per-isolate
  pass); the room still checks the key on every `/ingest`. While live the room writes its meta every
  10 segments and its stats/chat at most once a minute (deletes, strikes and timeouts at once).
