# dreamstream-live — DreamStream Live worker

The backend for **DreamStream Live** (Stream Studio): one Durable Object per event
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
cd live-worker && npx wrangler deploy
```

The worker is also exposed on workers.dev for the temporary Pages launch domain:

```
https://dreamstream-live.akhieleshsrirangam.workers.dev
```

`comic2.pages.dev` uses that workers.dev base automatically from `live/config.ts`.
Custom domains keep using same-origin `/live-api` so `dreamstreamstudio.ai/live-api/*`
continues to work after the Cloudflare challenge/routing issue is fixed.

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
- Segments purge 24 h after end; server recordings purge after 7 days.
