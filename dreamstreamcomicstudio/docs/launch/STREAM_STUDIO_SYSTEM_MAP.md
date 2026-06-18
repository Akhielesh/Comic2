# Stream Studio System Map

> Status: launch-readiness map for the June 25 Stream Studio MVP.
> Last updated: 2026-06-18 from repo evidence and live smoke probes.

This map exists so the launch council, sprint engine, and humans reason from the same architecture instead of rediscovering it each run.

## 1. Launch wedge

Stream Studio is the June 25 MVP wedge:

> Private creator live events from browser setup to viewer link to recording/replay.

Chat and Comic Studio are support surfaces. Code Studio / container-heavy workflows are out of the launch funnel until Stream Studio is proven.

## 2. Public routes and current launch status

| Surface | URL | Expected owner | Current status |
|---|---|---|---|
| Primary marketing/app domain | `https://dreamstreamstudio.ai/` | Cloudflare Pages (`comic2`) | Blocked by Cloudflare security verification for automation; must be manually verified/fixed before canonical launch. |
| Temporary launch app domain | `https://comic2.pages.dev/` | Cloudflare Pages (`comic2`) | Returns app shell. Current temporary marketing/app URL. |
| Temporary Stream Studio app | `https://comic2.pages.dev/live.html` | Cloudflare Pages (`comic2`) | Returns app shell. |
| Temporary Stream Studio API | `https://comic2.pages.dev/live-api/api/events/...` | Should reach `dreamstream-live` | **Blocked:** currently returns the static website/app shell, not live-worker JSON. |
| Configured live-worker route | `https://dreamstreamstudio.ai/live-api/api/events/...` | `dreamstream-live` Worker | **Blocked:** currently returns Cloudflare challenge HTML, not live-worker JSON. |
| Railway backend health | `https://comic2-production.up.railway.app/api/health` | Railway service `Comic2` | Returns health JSON. |

## 3. High-level topology

```mermaid
flowchart LR
  U[Creator / Viewer Browser]
  Pages[Cloudflare Pages\ncomic2.pages.dev / dreamstreamstudio.ai]
  LiveHtml[/live.html\nStream Studio shell]
  LiveClient[live/* React app]
  LiveAPI[dreamstream-live Worker\n/live-api/*]
  DO[(EventRoom Durable Object\n1 per event)]
  R2[(R2 bucket\ndreamstream-live)]
  Supabase[(Supabase Comic\nAuth + owner-scoped tables)]
  Railway[Railway Express backend\nComic2]

  U --> Pages
  Pages --> LiveHtml
  LiveHtml --> LiveClient
  LiveClient -->|create/get/stats/rsvp/recording/segments| LiveAPI
  LiveClient -->|account sync / product access| Supabase
  LiveClient -->|main app APIs outside live| Railway
  LiveAPI --> DO
  LiveAPI --> R2
  DO -->|chat, lobby, presence, stream state, stats, janitor| DO
  R2 -->|segments + server recordings| U
```

## 4. Frontend Stream Studio app graph

| File | Responsibility | Launch relevance |
|---|---|---|
| `live.html` | Entry HTML with `#live-root`; loads `/live/main.tsx`. | App shell smoke target. |
| `live/LiveApp.tsx` | URL/router shell. `?e=ID&k=KEY` = host studio, `?e=ID` = invite/watch, hash routes for dashboard/create/settings/summary. | Defines first-session flow. |
| `live/config.ts` | Quality limits, platform limits, and `WORKER_BASE`. Default production base is same-origin `${location.origin}/live-api`; localhost uses `127.0.0.1:8788`; optional `VITE_LIVE_WORKER_URL` override. | Current temporary-domain API blocker lives here + deployment config. |
| `live/api.ts` | REST/WebSocket client for live-worker; includes `probeLiveWorker`, Cloudflare/app-shell detection, event create/get/stats/rsvp/recordings/segments. | Prevents users from entering dead flows when backend route is miswired. |
| `live/events.ts` | Local event registry in `localStorage`; hostKey is a capability credential stored with local event history. | Host-key handling / shared-device risk. |
| `live/sync.ts` | Supabase account sync for events/settings and `product_access`/legacy access gate. Signed-out users degrade to local-only mode. | Cross-device dashboard + access-gated onboarding. |
| `live/views/CreateView.tsx` | Event creation UX and backend preflight. | First success moment; blocked if live-worker route fails. |
| `live/views/DashboardView.tsx` | Event list/status hydration and backend readiness surfacing. | Creator control center. |
| `live/views/StudioView.tsx` | Host studio, stream control, upload, guest management, recordings. | Core paid-value workflow. |
| `live/views/ViewerView.tsx` | Viewer join/playback/chat/reactions. | User-facing quality proof. |
| `live/views/EventPage.tsx` | Invite/RSVP/scheduled event page. | Share-link funnel. |
| `live/views/SummaryView.tsx` | Post-event recap/stats/recordings. | Retention value / repeat intent. |

## 5. Live-worker API graph

Source: `live-worker/src/index.ts` and `live-worker/src/eventRoom.ts`.

```mermaid
sequenceDiagram
  participant Host as Host browser
  participant Viewer as Viewer browser
  participant Worker as dreamstream-live Worker
  participant Room as EventRoom Durable Object
  participant R2 as R2 dreamstream-live

  Host->>Worker: POST /api/events
  Worker->>Room: POST /init
  Room-->>Worker: { hostKey }
  Worker-->>Host: { id, hostKey }

  Viewer->>Worker: GET /api/events/:id
  Worker->>Room: GET /meta
  Room-->>Viewer: public event meta

  Host->>Worker: WS /api/events/:id/ws?k=hostKey
  Viewer->>Worker: WS /api/events/:id/ws?name=...
  Worker->>Room: WebSocket handoff

  Host->>Worker: POST /api/events/:id/segments?seq&ms + x-host-key
  Worker->>R2: put events/:id/seg/:seq
  Worker->>Room: POST /ingest
  Room-->>Viewer: websocket segment notification
  Viewer->>Worker: GET /api/events/:id/segments/:seq
  Worker->>R2: get segment via cacheable response

  Host->>Worker: /api/events/:id/recordings multipart upload
  Worker->>R2: multipart upload recording
  Worker->>Room: /rec/register
  Host->>Worker: GET /recordings?k=hostKey
```

### Worker routes implemented

| Method/path | Purpose | Auth model |
|---|---|---|
| `POST /api/events` | Create event and hostKey. | No account auth; hostKey generated by DO. |
| `GET /api/events/:id` | Public event metadata. | Public. |
| `GET /api/events/:id/ws` | WebSocket to EventRoom for host/mod/guest/viewer. | Query keys / role-specific secrets. |
| `POST /api/events/:id/segments?seq&ms` | Host uploads stream segment. | `x-host-key`. |
| `GET /api/events/:id/segments/:seq` | Viewer fetches CDN-cached segment from R2. | Public by event link. |
| `GET /api/events/:id/stats?k=hostKey` | Host analytics/activity log. | Host key in query. |
| `POST /api/events/:id/rsvp` | Name-only RSVP from invite page. | Public. |
| `/api/events/:id/recordings` | Multipart server-side recording store/list/download. | `x-host-key` or `k=hostKey`. |
| `POST /api/events/:id/exit?k=hostKey` | Host pagehide beacon to auto-end stream. | Host key in query because `sendBeacon` cannot set headers. |

## 6. Durable Object responsibilities

`EventRoom` owns the live event state:

- stream status: `idle`, `live`, `paused`, `ended`;
- chat ring buffer and moderation state;
- lobby/approval, presence, viewer cap, roles;
- guest signaling frames;
- segment fan-out notifications;
- stats curves and host health telemetry;
- RSVP list;
- server recording registry;
- cleanup alarms: 24-hour replay segment purge, 7-day recording purge;
- host-gone grace window and cost guardrail.

Launch-critical constants from `eventRoom.ts`:

| Constant | Value | Meaning |
|---|---:|---|
| `HARD_VIEWER_CAP` | 200 | Hard concurrent viewer ceiling. Do not market as proven until load-tested. |
| `MAX_GUESTS` | 4 | On-air guest limit. |
| `REPLAY_WINDOW_MS` | 24h | Segment replay window. |
| `RECORDING_RETENTION_MS` | 7d | Server recording retention. |
| `HOST_GONE_GRACE_MS` | 2m | Auto-end after host disappears. |

## 7. Account and data model

| Layer | Table/storage | Data | Security model |
|---|---|---|---|
| Browser local | `localStorage: ds-live-my-events` | Event IDs + hostKeys + cached metadata. | Device-local; hostKey is a capability secret. |
| Browser local | `localStorage: ds-live-viewer-name` | Viewer display name. | Device-local convenience. |
| Supabase | `stream_studio_events` | Signed-in creator event history including hostKey. | RLS owner-only. Anon table privileges revoked. |
| Supabase | `stream_studio_settings` | Signed-in creator preferences. | Owner-scoped in app code; verify live RLS before broad launch. |
| Supabase | `product_access` | Product onboarding / standalone access gate. | Admin-managed. |
| Supabase legacy | `stream_studio_access` | Legacy stream access gate. | User read own grant; writes revoked from anon/authenticated. |
| Cloudflare R2 | `dreamstream-live` | Stream segments + server recordings. | Worker-mediated; retention bounded by DO alarm. |

## 8. Deployment/config map

| Component | Repo config | Live dependency | Current issue |
|---|---|---|---|
| Frontend Pages | Cloudflare Pages project `comic2` from `Dreamstrream-v1` | `comic2.pages.dev`, `dreamstreamstudio.ai` | Fallback domain works; custom domain challenged. |
| Live worker | `live-worker/wrangler.jsonc` | Route `dreamstreamstudio.ai/live-api/*`, DO `EVENT_ROOM`, R2 `dreamstream-live`, `ALLOWED_ORIGINS` includes both domains | No route for `comic2.pages.dev/live-api/*`; configured custom route is challenged. |
| Main backend | Railway project `hospitable-enthusiasm`, service `Comic2` | `https://comic2-production.up.railway.app` | Health works; app-sleeping cost control should stay on. |
| Supabase | `server/sql/stream_studio.sql` + related access tables | Project `Comic` ref `bdjfmxfmhqhzvgrhbbzm` | Advisors still have warnings; launch-relevant RLS/security needs triage. |

## 9. Current P0: live API cannot be used from temporary launch domain

Evidence:

- `live/config.ts` defaults production `WORKER_BASE` to `${location.origin}/live-api`.
- `live-worker/wrangler.jsonc` only routes `dreamstreamstudio.ai/live-api/*`.
- `npm run ops:live-smoke` checks `https://comic2.pages.dev/live-api/api/events/smokeprobe`.
- Current result recorded in the launch plan: fallback route returns website HTML instead of worker JSON.
- Direct probe of `https://dreamstreamstudio.ai/live-api/api/events/smokeprobe` returns Cloudflare challenge HTML.

Impact:

- `https://comic2.pages.dev/live.html` can load the Stream Studio shell, but event creation/watch flows cannot reach the live-worker unless the backend base is changed or Cloudflare routing/security is fixed.
- This blocks the actual June 25 core workflow: create → share → join → stream → replay.

Safe solution options, in approval order:

1. **Best production fix:** scoped Cloudflare WAF/ruleset fix for `dreamstreamstudio.ai` and `dreamstreamstudio.ai/live-api/*`; keep security, skip/relax challenge only for app/API paths. Requires Cloudflare WAF/ruleset edit access.
2. **Temporary Pages-domain API fix:** add a Cloudflare-accessible route/base for live-worker that `comic2.pages.dev` can call, then set `VITE_LIVE_WORKER_URL` for Pages. Requires Cloudflare Pages env/deploy or Worker route/subdomain config.
3. **Manual beta workaround:** use local/dev worker for controlled demos only. Not acceptable for inviting real users.

Do **not** claim Stream Studio launch readiness until one of these is verified by `npm run ops:live-smoke` and a browser create-event test.

## 10. Minimum launch smoke path

The next launch-proof gate should be:

1. `npm run typecheck`
2. `npm run build:server`
3. `npm run build`
4. `npm run ops:live-smoke`
5. Browser: open `https://comic2.pages.dev/live.html`
6. Create event
7. Open host studio link
8. Open viewer link in second browser/profile
9. Join with name
10. Send chat/reaction
11. Start stream
12. Verify viewer playback
13. End stream
14. Verify summary/replay/recording path

The smoke script currently catches routing blockers before a human wastes time on the browser flow.

## 11. Council role implications

- **CEO/Product:** do not market/invite until live API routing is fixed; landing page can continue focusing Stream Studio.
- **CTO/Architect:** make the live-worker route/base a single explicit launch contract, not tribal knowledge.
- **SRE:** live smoke should remain a hard gate; add route coverage for every API path the browser uses.
- **CISO:** hostKey-as-capability is acceptable for beta only with honest copy and tight route logging/referrer awareness.
- **Backend/Data:** Supabase sync is additive; the stream itself does not depend on Supabase account state for signed-out beta.
- **UI/UX:** show backend readiness before create so users do not fill the event form into a dead route.
- **CFO:** the R2/DO architecture is cost-conscious; container-heavy Code Studio must remain out of launch.
- **Marketing:** temporary-domain messaging is acceptable for controlled beta, but `dreamstreamstudio.ai` should be fixed before broader public launch.
