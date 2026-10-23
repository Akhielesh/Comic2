# Stream Studio costs: what we spend, who sees it, and how we keep it near $0

- **Status:** Proposed design. Nothing here is implemented yet. The decision record is
  [ADR 0007](../decisions/0007-stream-studio-cost-transparency-and-frugality.md).
- **Date:** 2026-10-22.
- **Code refs:** branch `claude/dreams-streaming-baby-monitor-z2kkae` at `ad30d1c`. Every line ref was checked at `b6bf72e`;
  the later merge touched none of the referenced files. Paths are relative to `dreamstreamcomicstudio/`.
- **Prices:** checked on 2026-10-22 against developers.cloudflare.com and supabase.com/pricing. Sources are in §9.
- **Counterpart of:** Comic Studio's costing. That covers the estimate before spending, the running total, the receipts, and
  Admin → Costs. The code is in `server/src/comic/billing.ts`, `components/comicstudio/ComicStudio.tsx:199` (`SpendBreakdown`),
  `components/comicstudio/conversation/cards/GateCard.tsx` and `components/admin/CostCentre.tsx`.
- **Related:**
  - ADR 0006: the cost model and the Phase 0 cost cuts.
  - `docs/features/baby-monitor.md`.
  - `docs/features/stream-studio.md` §10.
  - `docs/infrastructure/COST_RUNBOOK.md`.

---

## 0. Summary

**What Stream Studio costs today:** about **$0 on top of the $5/month Workers Paid plan**, which the backend container
already needs. At today's handful of families and events, everything fits inside the included allowances.

**TURN is switched on in production** — the owner set `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` on `dreamstream-live` on
2026-10-22 (they're Worker secrets, so the repo's `wrangler.jsonc` doesn't show them). That fixes calls and guests behind
carrier NAT, and makes TURN the stack's only per-byte cost — and today's code hands **one shared 24-hour credential**
to every socket (`live-worker/src/ice.ts`), so the TURN guardrails (§6, win 2) are the first thing to ship, together with
a Cloudflare account budget alert.

**What it will cost as it grows.** The meter that grows fastest is not video. It is two things:

1. **Rows that `MonitorRoom` writes to Durable Object storage.**
   - ≈ 9,850 per 10 h night, which is **≈ $0.32 per nursery-month** at list price. That is 93% of a nursery's cost.
   - ADR 0006 measures ≈ 12,180 per 12 h day, or $0.44 per nursery-month at 1k nurseries.
2. **TURN (switched on 2026-10-22).**
   - $0.05/GB after a free 1 TB, which is shared by the whole Cloudflare account.
   - One viewer watching all night through TURN costs **≈ $4.66 a month**.
   - The free terabyte covers only ~10.7 such viewers.

**What we will build.** Three phases (§7):
- **A: metering and an owner view.** Admin → Costs gets a real Stream Studio tab.
- **B: what users see.** A cost or "free" line before an action, path pills while live, receipts after, and a calm monthly
  Usage card.
- **C: frugality changes.** Ranked by saving, effort and risk in §5.

**Principles**

1. **Meter always, charge never (for now).**
   - Comic Studio's ledger went blind in production when `BILLING_ENABLED` was turned off
     (`api-proxy/wrangler.jsonc:61`; `billing.ts:113-114` returns no-op hooks).
   - Stream Studio's cost telemetry never depends on a billing switch.
2. **The cheapest byte is the one that never touches our servers.** Every product prefers this order:
   1. Home Wi-Fi
   2. direct peer-to-peer
   3. a relay that bills us the least
   4. our server
3. **Say who pays: before, during and after.** "Free · your devices", "Free · your Google Drive",
   "Through our servers", using the same words everywhere.
4. **Never cut baby-monitor sound or alerts to save money.** Limits step the picture down. They never silence the room.
5. **Metering must cost less than 2% of what it measures.**
   - No write per video frame, per segment GET or per message.
   - Counters live in memory and in WebSocket attachments, and are flushed at most hourly.

---

## 1. How Stream Studio's costs differ from Comic Studio's

| | Comic Studio | Stream Studio |
|---|---|---|
| What is spent | AI tokens and images, priced per call (`shared/comic/models.ts`) | Infrastructure: TURN bytes, Durable Object (DO) requests, rows and time, R2 storage and operations, Worker requests, email, container wake-ups |
| Who pays | Platform key (×1.3 markup) or the user's own key (BYOK) | DreamStream's servers, **or nobody**: the user's devices, the user's Google Drive, or the user's home Wi-Fi |
| Who decides the cost | The user approves a quoted spend (`GateCard`: "Approve · $0.55") | The **connection path**, chosen automatically. Recording destination and going live are the user's choices |
| Typical size of one action | $0.05–$0.55 | $0 on direct paths; $0.0001–$0.16 per session on server paths |
| Unit users understand | Dollars | Path ("Home Wi-Fi", "Direct", "Through our server"), gigabytes and hours. Dollars are secondary |
| Ledger | Per comic, inside the doc (`doc.spend`), plus `generation_cost_events` | Per nursery, per account and per event: monthly counters in the DOs, plus Workers Analytics Engine for the owner |

**Reused from Comic Studio:**
- Owner side: provenance badges, delta versus the prior period and CSV export. These come from `components/admin/costs/*` and
  `costFormat.ts`.
- `ProductId 'stream'`, which already exists in `shared/types/costCentre.ts:98`.
- User side:
  - the "estimate on the verb" pattern;
  - `≈` for estimates and no `≈` for actuals;
  - the "est." tag;
  - the who-pays chip;
  - the honest empty state ("Nothing spent yet…");
  - the percent notices with a reset date (`platformAllowance.ts`);
  - `CountUp` (`components/studio/kit/streamMotion.tsx`).

**Not reused:** `billing.ts`, `estimateJobs` and the CT credit ledger, which are built for AI calls.

---

## 2. The cost model

### 2.1 Unit prices (Workers Paid account; checked 2026-10-22)

| Service | Included per month | Beyond | Source |
|---|---|---|---|
| Workers Paid | $5 flat · 10M requests · 30M CPU-ms | $0.30/M requests. No bandwidth charge | developers.cloudflare.com/workers/platform/pricing |
| DO requests | 1M | $0.15/M. Incoming WebSocket (WS) messages count 20:1. Alarms count 1:1. **Outgoing WS messages and auto-responses are free** | /durable-objects/platform/pricing (updated 2026-10-18) |
| DO duration | 400k GB-s | $12.50/M GB-s, at 128 MB per object. **"Durable Objects that are idle and eligible for hibernation are not billed for duration, even before the runtime has hibernated them"** | same page (re-read 2026-10-22) |
| DO SQLite rows written | 50M | $1.00/M. **"Each `setAlarm()` is billed as a single row written"**. KV `put`/`delete` count as rows. Deletes count as writes | same page (re-read 2026-10-22) |
| DO stored data | 5 GB-month | $0.20/GB-month | same |
| R2 Standard | 10 GB-month · 1M Class A · 10M Class B | $0.015/GB-month · $4.50/M A (including each UploadPart) · $0.36/M B. **Egress $0** | /r2/pricing (updated 2026-10-01) |
| Realtime TURN and SFU | **1,000 GB, shared by TURN and SFU** | $0.05/GB. **Only edge → TURN-client bytes are billed. Client → edge is free. Server ↔ peer is "not part of billing"** | /realtime/turn/faq; /realtime/sfu/platform/pricing (updated 2026-09-22; re-read 2026-10-22) |
| Cloudflare STUN | free, unlimited | — | /realtime/turn/faq |
| Email Sending | 3,000 a month, **shared by every DreamStream app** | $0.35 per 1,000 | /email-service/platform/pricing |
| Backend container (`basic`) | about 25 GiB-h of memory (≈ 100 wake-ups of 15 min) | ≈ $0.0027 per wake-up | Workers pricing; `api-proxy/src/backend.ts:22` |
| Workers Analytics Engine | 10M data points · 1M reads | $0.25/M · $1/M. **Not billed yet**, per the docs | /analytics/analytics-engine/pricing |
| Supabase | Free: 500 MB DB, 5 GB egress, 50k MAU. **Pauses after 1 week of inactivity** | Pro $25 | supabase.com/pricing |

**Two facts shape the whole design:**
1. Bytes that pass through Workers, DOs and R2 cost nothing as bandwidth. We pay only for requests, rows and storage.
2. **TURN is the only path where we pay per byte**, and only for the bytes Cloudflare *sends to* the TURN client.

### 2.2 Cost by path

"Per session" means at list price beyond the free tiers; today all of it is inside them. Arithmetic is in
`model.py` (§9). Line refs are at `ad30d1c`.

| # | Path | What triggers it (code) | Unit price | Typical per-session cost | Free alternative |
|---|---|---|---|---|---|
| 1 | **Monitor on Home Wi-Fi** (LAN P2P) | Camera and viewer on the same network; `classifyPath` → `lan` (`live/monitor/rtc.ts:47-52`) | Media $0 | Media **$0**. Room bookkeeping is #5 | — (already free) |
| 2 | **Monitor, direct over the internet** (P2P via STUN) | `rtc.ts` ICE with STUN only (`ice.ts:10`); up to `DIRECT_CAP = 4` internet viewers (`rtc.ts:97`) | Media $0 | **$0**. The family's upload carries up to 1.6 Mbps per viewer (`rtc.ts:112`) | — |
| 3 | **Monitor through our server** (DO relay picture) | P2P blocked, still connecting (instant picture after `INSTANT_DELAY_MS = 1000`, `linkFallback.ts:77`), or camera full. Camera WebCodecs at 450 kbps / 15 fps (`relay.ts:64`); room handler `onRelayFrame` (`monitorRoom.ts:1849`) | DO requests $0.15/M (540k incoming frames per 10 h = 27k billed); bytes and fan-out free | **≈ $0.0055 per all-night relay viewer-night** (requests plus ≈ 69 GB-s). Up to $0.06 if active time were billed wall-clock (unverified; §8 item 2). One camera upload serves every relay viewer | Direct or Home Wi-Fi; camera-side TURN (#4b); audio only when the screen is hidden |
| 4a | **Monitor through TURN, viewer is the TURN client** | Only once TURN secrets are set (`ice.ts:29`). Relay cap 650 kbps / 20 fps (`rtc.ts:119`) | $0.05/GB after 1 TB | 0.69 Mbps → **3.1 GB per 10 h night ≈ $0.16** (≈ $4.66 per viewer-month) | #4b; the encrypted server relay (#3 after E2E); audio only when hidden (0.18 GB/night ≈ $0.009) |
| 4b | **Monitor through TURN, camera is the TURN client** (proposed, P3) | The camera receives TURN first; the viewer gets STUN | Same | Only what the camera *receives*: RTCP, talk-back. **≈ $0.005–0.01/night** (unverified until metered, §8 item 1) | — |
| 5 | **Monitor room bookkeeping** (status, alarms, history rows) | Camera `status` every 2 s (`MonitorCamera.tsx:707-742`); 15 s alarm `ALARM_MS` (`monitorRoom.ts:318`) with `setAlarm` (`:2826`) and `saveBucket` (`:2815` → `:1110`); minute stats (`onStats :1332`) | Rows $1/M after 50M; DO requests $0.15/M | ≈ 9,850 rows and 3,415 requests per 10 h night → **≈ $0.011/night, $0.32/nursery-month**. After ADR 0006 Phase 0: **≈ $0.0015/night, $0.044/month** | Status only on change; 60 s watchdog; no `tl` blob; packed minute blocks (ADR 0006 Phase 0); later, history on the hub (ADR 0006 Phase 4) |
| 6 | **Family or direct call, P2P** | `live/calls/callMesh.ts` mesh of 4 or fewer | $0 | **$0**. Signaling is ~70 DO requests and ~120 rows ≈ $0.0001 | — |
| 7 | **Call through TURN** | TURN on a blocked side; bitrate 1.5 / 0.9 / 0.6 Mbps by party size (`callMesh.ts:111`), **no relay-path cap** | $0.05/GB | 1:1, 30 min, one side on TURN ≈ 0.34 GB → **$0.017**. Both sides: $0.034. Group of 3, one on TURN: $0.020 | TURN only for the blocked side; an 800 kbps cap on relay paths → $0.009 |
| 8 | **Meeting** (host and up to 4 guests, `MAX_GUESTS`, `eventRoom.ts:137`) | Host-centric mesh (`live/studio/rtc.ts`); return feed 1.2 / 0.9 / 0.7 Mbps (`:75`); guest uplinks uncapped | $0.05/GB only on TURN | P2P **$0**. A guest on TURN: $0.016–0.027/h. **The host on TURN: ≈ $0.18/h** (receives 4 uncapped cameras) | Guest-side TURN; guest camera cap of 600 kbps on relay (≈ $0.056/h) |
| 9 | **Broadcast** (R2 segment rail) | 6 s segments (`config.ts:34`); per segment `authHost` + R2 put + `/ingest` (`index.ts:342-354`) + `putMeta` (`eventRoom.ts:427`); every viewer GET runs the Worker (`index.ts:367-384`) | Workers $0.30/M; DO $0.15/M; rows $1/M; R2 A/B; storage $0.015/GB-month; **egress $0** | 1 h, 720p, 20 viewers: **$0.009–0.014**. 100 viewers ≈ **$0.03**. The same bytes over TURN or SFU would cost $1.17; Cloudflare Stream would cost $1.20 | Under ~4 viewers: direct from the host phone (P12). At scale: an R2 custom domain (no Worker per GET) |
| 10 | **Cloud copy of a recording** (7 days) | **On by default**: `cloudRecordings: true` (`live/prefs.ts:71`); auto-starts when the save sheet opens (`SaveSheet.tsx:165-166`); master at 2.5× bitrate (`config.ts:38`); 16 MiB parts (`api.ts:238`) | R2 $0.015/GB-month + $4.50/M Class A; 1 Worker + 1 DO request per part | 1 h 720p master **2.9 GB → $0.011**. 1080p60: 7.7 GB → $0.029. The free 10 GB-month covers only ≈ 15 recorded hours a month | Google Drive (browser → Google; bytes $0 to us); this device ($0) |
| 11 | **Save to Google Drive** | `driveUpload.ts:431` opens the session; the browser uploads straight to Google | 1 container wake ≈ $0.0027 beyond ≈ 100 free wakes | **≈ $0** | — (this *is* the free option) |
| 12 | **Push** (alerts, rings) | `live-worker/src/webpush.ts` | Subrequests not billed | **$0** (≈ 1 GB-s for 20 pushes a night) | — |
| 13 | **Auth emails** | `live/account.ts` → backend → email Worker | $0.35/1k after 3,000 a month (shared) | **$0** today; also wakes the container | Fewer emails (magic link only when needed) |
| 14 | **Invite-page polling** | `EventPage.tsx:47` every 30 s, even hours before the start | 1 Worker + 1 DO request per poll | ≈ $0.00005 per waiting tab-hour (240 requests) | Room socket push, or poll only within ±10 min of the start time |
| 15 | **History cards polling** | `SoundLevelCard.tsx:61` (60 s), `WeekCard.tsx:64` (10 min); they keep running while the tab is hidden | 1/20 DO request each | Tiny | Pause while hidden; append the `minutes` rows the room already pushes |
| 16 | **Socket (re)connects** | `handleUpgrade` → `monitor_my_role` RPC (`monitorRoom.ts:634`) + `ensureAlarm` (`:678`); call lines to every nursery (`callCenter.ts`) | Worker + DO request, 2–3 rows, 1 Supabase RPC | Idle sockets **$0** (auto-responded pings). ~55 reconnects a day per nursery | Local JWT verification (ADR 0006 #9) |
| 17 | **Fixed** | Workers Paid $5 (shared with the backend container) · Supabase Free $0 (Pro $25 is the ADR 0006 production budget) | — | — | — |

### 2.3 What the family pays (data, battery, storage)

Users pay real costs that are not on our bill. The Usage card shows them (§4.5):

| Activity | User's cost |
|---|---|
| Each internet viewer of the monitor | Up to 1.6 Mbps of the **home's upload** ≈ 0.72 GB/h |
| A viewer on cellular through a relay | ≈ 0.3 GB/h of **their data plan** (≈ 3 GB per 10 h night) |
| Home Wi-Fi viewing | **No internet data at all** |
| Broadcasting at 720p | The host uploads ≈ 1.17 GB/h |
| A 720p cloud copy | Uploads another ≈ 2.9 GB/h, possibly on mobile data |
| On-device ML (YAMNet, MediaPipe), encoding, local recording | Battery and disk on the user's devices |

### 2.4 Free-tier headroom (pooled per Cloudflare account) and projections

The included allowances are **account-wide**. The DreamStream backend container and the other `dreamstream-*` Workers share them,
and so do the non-DreamStream Workers on the same account (`atlasd`, `akhieleshpersonalwebsite`; see CLAUDE.md). One
noisy neighbour can use up our free tier.

| Allowance | Covers about |
|---|---|
| 50M DO rows | 169 nursery-months today (10 h nights); ≈ 1,070 after Phase 0 |
| 1M DO requests | ≈ 10 nursery-months today (overage only ≈ $0.015/nursery) |
| 400k GB-s DO duration | ≈ 31,000 nursery-nights at 12.8 GB-s, *if hibernation keeps working* |
| 1 TB TURN | ≈ 322 viewer-side relayed nights, or ≈ 2,800 one-sided 30-min calls |
| 10M Workers requests | ≈ 790 twenty-viewer stream-hours, or ≈ 165 hundred-viewer hours |
| 10 GB-month R2 | ≈ 15 recorded 720p hours (7-day copies), or ≈ 250 stream-hours (24 h replay) |
| 3,000 emails | shared by every DreamStream app |
| 25 GiB-h container | ≈ 100 wake-ups a month |

**Projection (ADR 0006 cost model, 12 h camera-days, 25% cellular viewing):**

| Monthly cost | 1k nurseries | 10k | 100k |
|---|---|---|---|
| Today | $439 | $4,974 | $50,821 (rows $36,490, TURN $11,200) |
| After Phase 0 | $34 | $916 | $10,326 |
| Phase 4 + coturn | $33 | $399 | $4,080 |

**Sensitivity:**
- If hibernation breaks (a stray `setTimeout` or pending I/O in a DO), the worst case is 5,400 GB-s per nursery-day ≈
  **$20k/month at 10k nurseries**.
- A leaked TURN credential used as a 100 Mbps relay costs ≈ **$54 a day**. Today's credential is shared, lives 24 h and is
  cached for up to 1 h per isolate (`ice.ts:23-27, 43`).

---

## 3. Owner view: Admin → Costs → Stream Studio

### 3.1 What exists today, and the gap

**What exists today:**
- `server/src/services/costCentre.ts:756-769` hard-codes the Stream Studio product row to `costUsd: 0` with the verdict "No
  metered cost — covered by the $5 Workers Paid plan".
- The GraphQL fetch reads only two things, and only when `CF_ANALYTICS_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set
  (`:921`):
  - Workers invocations (`workersInvocationsAdaptive`, `:893`);
  - R2 bucket size (`r2StorageAdaptiveGroups`, `:906`).
- `live-worker/wrangler.jsonc` has **no** `observability` block and **no** Analytics Engine binding.
- `call_stats` (path, TURN flag, time to connect) goes only to `console.log` (`monitorRoom.ts:2664`).
- Each viewer knows its `netPath` but never reports it.

**What's missing:**
- Durable Object requests, rows and GB-s.
- R2 operations.
- TURN GB.
- Container wake-ups.
- Any per-feature, per-nursery, per-account or per-event attribution.
- Any alert.

ADR 0006 WS-8 already plans the DO datasets and per-nursery-day KPIs in `costCentre.ts`. **Phase A below is that work plus
attribution**, done once, not twice.

### 3.2 What to add

A new main tab, `Stream Studio`, in `components/admin/CostCentre.tsx:35` (`MAIN_TABS`), rendered by a new
`components/admin/costs/StreamCard.tsx` built from the existing kit (`KpiTile`, `SourceBadge`, `BudgetMeter`, `SortableTable`,
`StackedDailyChart`, `costFormat`). Every figure carries a provenance badge, as everywhere else in the Cost centre:
- **measured:** Cloudflare GraphQL;
- **estimated:** in-room counters × list price;
- **fixed:** the plan fee.

**1. Product row (Products tab).** Replace the hard-coded `$0` with:
- `costUsd`: this product's share of the account's **overage** (marginal $, usually $0 today);
- a new optional `listValueUsd`: what the same usage would cost at list price with no free tier. This is the planning number;
- a verdict such as "$0.00 marginal (inside free tiers) · $0.41 at list price · 12 nurseries, 3 events".

**2. KPI tiles:**
- Stream cost this period (marginal and list value).
- Cost per active nursery-month.
- Cost per broadcast-hour.
- Share of viewer-minutes on free paths.
- Delta versus the prior period.

**3. By feature** (one row each): Baby monitor · Family calls · Meetings · Broadcasts · Cloud copies · Drive saves · Push · Email ·
Container. For each:
- units (DO requests, rows, GB-s, TURN GB, R2 GB-month and ops, Worker requests);
- list-price $;
- source badge.

**4. Path mix:**
- A stacked bar of monitor and call **minutes by path**: Home Wi-Fi / Direct / TURN / Our server.
- The same for **bytes on paid paths**.
- This is the frugality scoreboard.

**5. Top consumers** (top 10 each; sortable; CSV):
- nurseries (by estimated $, relay minutes, TURN GB, rows);
- accounts (calls, meetings, broadcasts, cloud copies);
- events (stream-hours × viewers).

Names resolve to an email **in the admin view only**, through the lookup the AI "By user" tab already uses. Guests are never
listed; they are counted inside their nursery or event.

**6. Free-tier headroom.** One `BudgetMeter` per allowance in §2.4:
- month-to-date use;
- a linear projection to month end;
- "crosses the free tier around <date>".

The meters are labelled **account-wide** and list the non-DreamStream Workers that share them.

**7. Scale projection.** "At today's per-nursery cost: 1k nurseries ≈ $X/month; 10k ≈ $Y". This uses the measured per-active-nursery-day
KPIs, in the shape of the ADR 0006 table.

**8. ADR 0006 KPIs**, per active nursery-day, with status colours:

| KPI | Threshold |
|---|---|
| DO requests | ≤ 1,000 |
| Rows written | ≤ 1,800 |
| DO duration | ≤ 40 GB-s |
| Relay and TURN share of viewer-minutes | reported |

The KPIs apply after Phase 0 ships. Before that, the panel shows the baseline.

**9. Alerts.** Each has a threshold and a plain-words cause:

| Alert | Fires when |
|---|---|
| Free tier filling | Any allowance projected ≥ 80% (amber) or ≥ 100% (red) by month end |
| Hibernation broken | DO GB-s per active nursery-day > 40 for 2 days in a row |
| Write diet regressed | Rows per active nursery-day > 1,800 (after Phase 0) |
| TURN leak | Any one TURN identifier > 20 GB in a day, or account TURN > 500 GB before the 15th |
| Relay creep | Our-server share of monitor viewer-minutes > 10% over 7 days |
| R2 near free | R2 stored > 8 GB-month |
| Email near free | > 2,400 emails this month (80% of the shared 3,000) |
| Container awake | > 20 awake hours this month |

**10. Notes:** every assumption in plain words, in the style of `costCentre.ts:797-830`. Examples:
- "Estimates use list prices checked 2026-10-22."
- "TURN per-identifier figures are sampled."
- "Allowances are shared with non-DreamStream Workers."

**Alert delivery that costs nothing and does not wake the container:**
- **(a)** The admin badge, computed on demand when the Cost centre loads. That load is already cached for 60 s.
- **(b)** A daily GitHub Actions job (free for this public repo), `.github/workflows/stream-cost-watch.yml` running
  `scripts/ops/streamCostWatch.mjs`:
  - It queries Cloudflare GraphQL with a read-only token stored as a GitHub secret.
  - When an alert changes state, it opens or comments on a GitHub issue. The owner gets GitHub's own notification email.
  - No container wake-up, no email-quota use.
- **(c)** **The owner sets Cloudflare's account-level budget alert** (Billing → budget alerts, added June 2026) at, for example,
  $10. It is a backstop that still fires if our metering is broken.

### 3.3 How it is measured cheaply

Three sources. Each costs almost nothing, and none of them writes per frame, per segment GET or per message.

**Source 1: Cloudflare GraphQL (measured; the control total).** It is read only when an admin opens the Cost centre (60 s cache,
`&fresh=1` to bypass) and in the daily GitHub job. Add these datasets to `fetchCloudflareAnalytics` (`costCentre.ts:1016`):
- `durableObjectsInvocationsAdaptiveGroups`: requests per namespace (MonitorRoom, EventRoom, UserLine, CallRoom);
- `durableObjectsPeriodicGroups`: active time / GB-s and WebSocket messages;
- `durableObjectsStorageGroups`: stored bytes;
- R2 operations per bucket (Class A/B);
- `callsTurnUsageAdaptiveGroups { sum { egressBytes } }`: the account total.

Confirm the exact field names against the schema in Phase A. They are named in ADR 0006 and the Cloudflare docs but not yet
queried by our code.

**Source 2: in-room usage counters (estimated; attribution).** A small helper, `live-worker/src/usageMeter.ts` (new), is used
by every DO.

- **Increment in memory on code paths that already run:**
  - a relay frame arriving;
  - a relay subscription starting or stopping;
  - a segment ingested (pass `bytes.byteLength`, which the Worker already has at `index.ts:347`, into `/ingest`);
  - a recording completing;
  - a call ending (the existing `call_stats`).

  Incrementing a number is free. **No `await`** and no storage call on the hot path.
- **Survive hibernation without writes.** In-memory state is lost when a DO hibernates. Long-lived per-socket totals therefore
  sit in that socket's WebSocket attachment, which `MonitorRoom` already uses: `serializeAttachment`, `monitorRoom.ts:677`.
  - An attachment is not a storage write.
  - When the DO wakes, it re-derives the pending deltas from the attachments.
  - The relay keeps the object awake while frames flow (a frame every ~67 ms). So relay counters are folded into the camera
    socket's attachment when the relay stops.
- **Flush at most once an hour per object.** Each flush does two things:
  - one KV `put` of `use:YYYY-MM` (1 row);
  - one Workers Analytics Engine data point (`env.STREAM_USAGE?.writeDataPoint`). This is non-blocking, uses no storage row
    and is skipped when the binding is absent.

  Flush moments, with no new alarms:
  - inside an alarm that already runs, when `now − lastFlush ≥ 1 h`: the monitor watchdog, the EventRoom janitor
    (`eventRoom.ts:438`) or the call line check;
  - when the last camera or host disconnects;
  - when an event or call ends.
- **What it costs:**

  | Object | Cost |
  |---|---|
  | `MonitorRoom` | ≤ 12 rows and ≤ 12 data points per 10 h night (≈ 0.8% of the Phase 0 budget of ~1,554 rows/day; ≈ 0.1% of today's 9,850). **0 extra DO requests** |
  | `EventRoom` | ≤ 1 row + 1 point per live hour; segment bytes ride the existing `putMeta` |
  | Calls | 1 point at the end |
  | `UserLine` | 1 row per session summary (rare) |

  In Analytics Engine: < 50 points per active nursery-day, against 10M included per month.

**Source 3: client session summaries (display only).** The viewer, the caller and the meeting guest already know their path
(`netPath`, `rtc.ts:78`). They can also read TURN bytes from `getStats` (the candidate pair whose local candidate is `relay`, its
`bytesReceived`; that is exactly what Cloudflare bills).

- A new `live/usage/sessionMeter.ts` keeps minutes per path and TURN bytes received.
- It sends **cumulative** totals as `{t:'use', …}` over the existing socket:
  - when the path changes;
  - every 15 minutes;
  - on `pagehide`.
- That is at most ~4 messages an hour, or 1/20 of a DO request each.
- The room stores "last reported" in the socket attachment, so a resend never double counts.
- **These numbers drive the user's Usage card and the path mix. They never enforce a limit.** Enforcement uses server truth:
  - the room's own relay counters;
  - Cloudflare `egressBytes` per TURN `customIdentifier` (§5 P2), queried once a day and **only for identifiers whose clients
    reported TURN use**.

  Because of that last rule, there are no queries for the 95%+ of identifiers that never touch TURN. Cloudflare advises one
  identifier per query because of adaptive sampling.

**Rules (enforced by tests in Phase A):**
- Nothing writes storage per relay frame, per segment GET or per WS message (a spy test on `onRelayFrame`).
- Metering never `await`s on a hot path, and it **fails open**.
- It is independent of `BILLING_ENABLED`.
- Prices live in **one** table, `STREAM_UNIT_PRICES` in `shared/stream/usage.ts`, with a `checkedOn` date. That is the same
  idea as `shared/comic/models.ts:10-12`.

### 3.4 Data shapes (sketch)

```ts
// shared/stream/usage.ts (new). Pure, unit-tested, shared by worker, server and client.
export type StreamPath = 'lan' | 'direct' | 'turn' | 'server';            // Home Wi-Fi · Direct · Relay · Through our server
export type UsageKind = 'monitor' | 'call' | 'meeting' | 'broadcast' | 'cloud_copy' | 'drive_save';
export interface UsageCounters {
  minutes: Record<StreamPath, number>;     // participant/viewer minutes by path
  turnBytes: number;                       // edge → client bytes (what Cloudflare bills)
  relayFrames: number;                     // monitor server relay, incoming frames
  segBytes: number; segCount: number;      // broadcast: what we stored
  viewerMinutes: number;                   // broadcast: from the existing viewer curve
  cloudCopyBytes: number; driveBytes: number; deviceBytes: number;
  doRequestsEst: number; rowsWrittenEst: number;
}
export interface UsageMonth {
  month: string;                                   // 'YYYY-MM'
  scope: 'nursery' | 'account' | 'event';
  counters: Partial<Record<UsageKind, UsageCounters>>;
  updatedAt: number;
}
export const STREAM_UNIT_PRICES = { checkedOn: '2026-10-22', turnPerGb: 0.05, doReqPerM: 0.15, rowsPerM: 1, gbSecPerM: 12.5,
  r2GbMonth: 0.015, r2APerM: 4.5, r2BPerM: 0.36, workerReqPerM: 0.3, emailPer1k: 0.35 } as const;
export function listValueUsd(c: UsageCounters): { usd: number; lines: { label: string; usd: number }[]; estimated: true };
```

Analytics Engine data point: `indexes: [kind]`, `blobs: [scope, scopeId, accountUid | '', path]`, `doubles: [counters…]`.

**Privacy:**
- `scopeId` is the internal nursery or event UUID. Never a name, email, IP or guest identity (§6).
- A guest's usage is folded into its nursery or event.
- The Cost centre type `shared/types/costCentre.ts` gains only **optional** fields (`stream?: StreamCostSection`,
  `ProductRow.listValueUsd?`), following that file's "add optional fields rather than renaming" rule.

---

## 4. User view

### 4.1 Principles (Comic Studio's patterns, translated)

| Comic Studio | Stream Studio |
|---|---|
| Price on the verb: "Render ≈ $0.07", "Approve · $0.55" | **Path and cost on the verb:** "Go live · free", "Keep a 7-day copy · 2.9 GB" |
| `≈` for estimates, exact for actuals ("Done — 6 pages ($0.53)") | `≈` before ("≈ 2.9 GB an hour"); exact after ("Stored 2.84 GB") |
| "your key" chip: who pays | **Who-pays chip:** "your devices" · "your Wi-Fi" · "your Google Drive" · "our servers" |
| "est." tag with a tooltip | Same, on any list-price $ figure |
| "Nothing is drawn until you approve." | "Nothing leaves your home on Home Wi-Fi." / "Nothing is stored unless you choose a cloud copy." |
| Platform allowance: percent with a reset date (30/70/90%) | Fair-use allowances as GB and percent, with a reset date (80/100%) |
| Budget bar, amber at 90% | Allowance bar, amber at 80% |

**What dollars mean to users.** Users see **"What this costs DreamStream"** in an expander, labelled as **our** cost, never as a
charge. The default display is paths, GB and hours, which are things a user can act on. Whether to show dollars at all is
owner question 1 (§8).

### 4.2 Before an action

All strings live in one module, `live/costCopy.ts` (new), with tests (§4.8).

| Where (file) | Today | Proposed |
|---|---|---|
| Quick start, **Instant meeting** (`live/views/create/QuickStart.tsx:26`) | "Invite up to 4 people on camera. Private — nothing is broadcast unless you go live." | Add the line **"Direct between you and your guests — free."** Tooltip: "If someone's network blocks direct video, an encrypted relay carries it for them." |
| Quick start, **Go live now** (`QuickStart.tsx:34`) | "Broadcast to up to N viewers. They join with just a name." | Add **"Free · through our servers · replay kept 24 h."** After P12, small audiences show **"Go live: direct to your viewers — free, nothing stored."** |
| Studio ready check (`StudioView.tsx:645`) | 3-2-1 countdown | One line under the check: **"Your viewers: through our servers, ≈ 1.2 GB an hour at 720p, free for you."** |
| Save sheet (`live/components/SaveSheet.tsx:572-574`) | "7-day cloud copy … auto-deleted after 7 days", **uploaded automatically** | Three choices, Drive or device first: **"Google Drive · free, yours to keep"** · **"This device · free"** · **"7-day link · 2.84 GB · kept 7 days · 3.1 of 10 GB used"**. The size is exact: the recording blob is known. No upload starts until the user taps. |
| Settings → Recording (`live/views/SettingsView.tsx:383`) | "Also keep a 7-day cloud copy … Uploads in the background after each recording" | **Off** by default. "Uses ≈ 2.9 GB of your upload per recorded hour at 720p, and our storage. Google Drive is free and keeps it." |
| Monitor camera setup (`MonitorCamera.tsx`) | Privacy copy (guarded by `privacyCopy.unit.test.ts`) | Keep that copy word for word. Add **"Your family watches directly — free. Phones on the same Wi-Fi use no internet at all."** |
| Join a nursery or call | — | No pre-action prompt. These are free unless a relay is needed; the live pill (§4.3) says so. |

### 4.3 While live: path indicators

Today the pills read "Home Wi-Fi" / "Encrypted · P2P" / "Encrypted · relay" / "Via our server · 12 fps"
(`MonitorViewer.tsx:1279, 1291-1292`) and "· Home Wi-Fi" / "· via relay" in calls (`live/views/calls/CallScreen.tsx:282`).
Three user words cover them: **Home Wi-Fi**, **Direct** and **Through our server**. The tooltip carries cost and privacy.

| Path | Pill | Tooltip |
|---|---|---|
| LAN P2P | **Home Wi-Fi · free** | "Straight between your devices. Nothing leaves your home, and it keeps working if the internet drops." |
| Internet P2P | **Direct · free** | "Device to device, end-to-end encrypted. No server in between." |
| TURN | **Through our relay · encrypted** | "Your network blocks direct links, so an encrypted relay forwards it. It can't see your video. Uses relay data: 2.1 of 10 GB this month." |
| DO relay, today | **Through our server** (keeps the fps suffix) | "In memory only, never stored, not end-to-end encrypted." (the wording `privacyCopy.unit.test.ts` requires) |
| DO relay, after E2E (P7) | **Through our server · encrypted** | Updated once the relay is end-to-end encrypted |
| Broadcast | **Live · through our servers · free** | "Free for up to 200 viewers. Replay for 24 h." |

On the camera, the existing "N through the server" count (`baby-monitor.md`) gets the same words.

### 4.4 After: receipts

| Where | Receipt |
|---|---|
| Event recap (`live/views/SummaryView.tsx`, next to the BigStats at `:108-113`) | A **Delivery** block: "1 h 02 m · peak 20 viewers · 1.2 GB stored for 24 h · ≈ 23 GB delivered · Cost to DreamStream: ≈ $0.01 at list price (inside our free allowance)." |
| Call end (`CallHost.tsx` toast) | "12 min · direct · free" or "12 min · encrypted relay · 0.14 GB of your relay data" |
| Nursery, Usage section | "Last night: 10 h · 98% direct · free." **Not in the morning push**: pushes stay about the baby |

### 4.5 Settings → Usage (monthly, calm)

A new section `usage` in `live/views/SettingsView.tsx:32-39`, with the same `Row` layout. Each parent also sees a per-nursery
version in `live/views/monitor/NurserySettings.tsx`.

- **Data source:**
  - `UserLine` for the account;
  - `MonitorRoom` (role-gated to parents) for each nursery.
- **When it loads:** once, when the section opens, over the sockets that are already open.
- **No polling** (a test checks this).

```
Usage · October                                         resets November 1

FREE: on your devices and direct links
  Home Wi-Fi monitoring        212 h      nothing left your home
  Direct (monitor and calls)    41 h
  Saved to Google Drive        6.2 GB     yours to keep
  Saved to this device         3.0 GB

THROUGH OUR SERVERS
  Relay data                   2.1 of 10 GB    ███░░░░░░░  21%
  Picture through our server   3 h 10 m       (sound stays free and unlimited)
  Broadcasts                   4 h · 63 viewers · ≈ 74 GB delivered
  7-day cloud copies           3.1 of 10 GB    ███░░░░░░░  31%

▸ What this costs DreamStream           ≈ $0.06 this month at list price, est.
    You aren't charged. Most of this fits inside our free allowance.
    Relay $0.00 · Server relay $0.02 · Broadcasts $0.03 · Cloud copies $0.01

Tips to stay free
  · Put the camera phone on the same Wi-Fi as your phone — Home Wi-Fi uses no internet.
  · Save recordings to Google Drive instead of a 7-day copy.
  · Hidden screens switch to sound only — no video is sent while you're not looking.
  · Allow the microphone once (for Talk) so phones can find each other on Wi-Fi.
```

**Empty state:** "Nothing went through our servers this month — everything stayed on your devices. That's the goal."

### 4.6 Tips to stay free (shown in context, at most one at a time)

| Trigger | Tip |
|---|---|
| A viewer is on "Through our server" while the camera is on the same public IP (hint from P8) | "You're on the same network as the camera — reconnect to Wi-Fi for a free, direct picture." |
| The relay was in use more than 30 min last night | "Last night's picture went through our server for 2 h. Check that the camera phone is on Wi-Fi, not mobile data." |
| A cloud copy was chosen while Drive is connected | "Google Drive keeps it free and forever; the 7-day copy uses our storage." |
| The tab is hidden on the relay | (automatic) audio only after 20 s, with a one-line notice when the user returns |

### 4.7 Fair-use limits, with honest copy

Proposed numbers. The owner decides (§8, question 2).

| Resource | Allowance | At 80% | At 100% | Basis |
|---|---|---|---|---|
| **Relay data** (TURN bytes your devices *receive*) | **10 GB per account per month**, and 10 GB per nursery for monitor viewers | "You've used 8 of your 10 GB of relay data this month. Direct and Home Wi-Fi don't count. Resets November 1." | **Monitor:** the parents' choice. Default: "Sound only" ("Relay data is used up, so the picture pauses on networks that block direct video. Sound and alerts are unchanged."). Option: "Picture through our server" (honestly labelled not end-to-end encrypted until P7). **Calls:** sound only on relay. **Meetings:** relayed guests at 360p | 100 heavy accounts × 10 GB = the 1 TB free pool |
| **Picture through our server** | Sound unlimited. Picture up to 16 h a day per nursery | — | Picture drops to 1 frame a second; sound continues | Mostly abuse protection: ≈ $0.0055 per relay viewer-night |
| **7-day cloud copies** | **10 GB rolling per account** | Meter in the save sheet | "Your 10 GB of 7-day copies is full. Save to Google Drive (free, yours to keep) or this device, or delete an older copy." | R2's 10 GB-month free tier |
| Broadcast | 200 viewers per event (exists: `HARD_VIEWER_CAP`, `eventRoom.ts:128`); 1 live event at a time; ~100 broadcast hours a month fair use | Soft notice | Owner review, not a hard stop | ≈ $0.03 per 100-viewer hour |
| Meetings and calls | 4 guests / 4 parties (exist: `eventRoom.ts:137`, `callMesh.ts`) | — | "Bigger rooms need a server (coming later)" | The mesh is free |
| Retention | Replay 24 h, copies 7 days (exist: `eventRoom.ts:131,133`) | — | — | Bounded storage |

**Rules:**
- **Never cut baby-monitor sound or alerts.**
- **Never silently downgrade privacy.** Moving to the not-yet-E2E server relay because of a limit is the parents' explicit choice.
- Notices appear in the app only; no emails, so no cost and no noise.
- Limits are evaluated on server truth, never on client reports (§3.3).

### 4.8 Copy rules (tests)

A new `live/costCopy.unit.test.ts`, alongside the existing `privacyCopy.unit.test.ts`, checks that:
- "free" is never attached to the `turn` or `server` paths;
- "end-to-end" is never used for the server relay until the room advertises `e2e1`;
- every server-paid action in `QuickStart`, `SaveSheet` and `StudioView` has a path line before it starts;
- dollar figures appear only inside "What this costs DreamStream", with "est.".

---

## 5. Frugality plan (ranked)

Saving is at scale beyond free tiers (§2) unless noted. Effort: S < 3 days, M 1–2 weeks, L 3+ weeks.

| Rank | Change | Saving | Effort | Risk | Owner / workstream | Users see |
|---|---|---|---|---|---|---|
| 1 | **P6 Recordings Drive or device first.** `cloudRecordings` defaults to `false` (`prefs.ts:71`); no automatic R2 upload (`SaveSheet.tsx:165-166`), especially when Drive is the target; 10 GB rolling quota checked at `op=init` (`index.ts:281`); `LIMITS` copy (`config.ts:48`) | $0.011–0.029 per recorded hour; removes the ≈ $2.4/month heavy-recorder tail; **saves the user 2.9–7.7 GB/h of upload**; the R2 free tier stops being eaten by duplicates | S | L | this plan, Phase C1 | "Google Drive · free, yours to keep" |
| 2 | **P2 TURN guardrails, before the TURN secrets are set.** Mint per socket, on demand (`iceFor(env, who)`), `customIdentifier = HMAC(nursery / uid / event)`, TTL ≤ 4 h (guests ≤ 2 h), revoke on removal, STUN at hello and TURN only on request or for the TURN-first side | Removes the ≈ **$54/day per leaked credential** tail. Makes switching TURN on safe, which **fixes calls and guests on carrier NAT**, a reliability gain | S–M | L | ADR 0006 WS-4 (`ice.ts`) | "Through our relay · encrypted" |
| 3 | **P1 MonitorRoom write and message diet** (ADR 0006 Phase 0): 60 s watchdog on auto-response timestamps; no `tl`/`saveBucket`; status on change plus a 60 s keepalive; `stats` every 5 min as packed hourly blocks; `sleepSm` only on transitions | Rows 12,180 → ~1,554 per nursery-day; **$0.44 → $0.034 per nursery-month at 1k** ($439 → $34/month); $4,974 → $916 at 10k | M | M (offline alert ≤ ~105 s worst case; viewers still detect a freeze locally in 6 s) | ADR 0006 WS-6 + WS-9 | nothing |
| 4 | **P5 Hidden viewers switch to sound only** after 20 s; relay video unsubscribed; relay cap 400 kbps / 15 fps | TURN 2.25 → ~0.9 GB per nursery-month (ADR); fewer relay frames; camera heat and battery | S | L–M (iOS PWA background audio) | ADR 0006 WS-6 | "Screen off · listening only" |
| 5 | **P8 LAN first and ICE correctness:** IPv6 fix (`isPrivateIp`, `rtc.ts:43-52`: a global IPv6 host candidate is wrongly "Home Wi-Fi"); same-network hint (a boolean from the DO; IPs never stored); `iceCandidatePoolSize: 1` on monitor peers; immediate ICE restart on `online` | Less relay during cold LAN connects; correct upload budget; small $ | S | L | this plan, C3 (touches `rtc.ts` → coordinate with WS-6) | "Home Wi-Fi · free" sooner |
| 6 | **P10 Push, not poll:** the invite page (`EventPage.tsx:47`) uses the room socket or polls only within ±10 min of the start; history cards pause when hidden | 240 → ≤ 12 requests per waiting tab-hour; 0 while hidden | S | L | this plan, C2 | — |
| 7 | **P3 TURN on the side that receives less:** camera first (monitor), guests first (meetings), only the blocked side (calls, via `classifyFailure`, `callMesh.ts:165`) | Monitor relayed night $0.16 → ~$0.005–0.01 (**verify with a 1 h metered test first**); meeting host-on-TURN $0.18 → ≤ $0.03/h; calls about half | M | M (UDP-blocked receivers need TURN over TLS 443 on retry) | after P2 | same pill |
| 8 | **P4 Relay-path caps:** 1:1 calls ≤ 800 kbps, groups ≤ 450 kbps (`callMesh.ts:111`); guest cameras ≤ 600 kbps and screens ≤ 1 Mbps on relay (`studio/rtc.ts`) | 45–70% of TURN GB on those paths | S | L | calls and meeting owners | "Relay · lower quality to save data" |
| 9 | **P7 End-to-end encrypted relay frames**, then the server relay goes *before* viewer-side TURN for one-way monitor video | Viewer TURN $0.16 → relay $0.0055 per night, for any number of viewers | L | M | ADR 0006 Phase 0 (E2E) | "Through our server · encrypted" |
| 10 | **P9 Broadcast rail trims:** one DO call per segment (`index.ts:342, 354`); `putMeta` every N segments; chat/emoji `stats` batched (`eventRoom.ts:730`); EventRoom `deleteAll()` after the 7-day sweep; **R2 lifecycle** (`events/` 9 days, abort multipart after 1 day); later an R2 custom domain for segments (no Worker per GET) | ≈ $0.02–0.04 per 100–200-viewer hour once past free tiers; no zombie storage | S–M | L | ADR 0006 WS-11 (`eventRoom.ts`), WS-7 (`index.ts`) | — |
| 11 | **P11 Keep the container asleep:** Drive status cache 60 s → 10 min (`driveUpload.ts:29`) with invalidate-on-error | ≈ $0.0027 per avoided wake; protects the 25 GiB-h | S | L | this plan, C11 | — |
| 12 | **P12 "Family live":** direct P2P broadcast from the host phone to ≤ 4 viewers who connect without TURN; others on the R2 rail | ≈ $0 saving (the rail is already ≈ $0.01–0.03/h), but < 1 s latency and **no 24 h copy on our servers** | L | M | later | "Go live: direct to your viewers — free" |
| 13 | **Native hub + port mapping** (ADR 0006 Phase 4): the camera phone app opens a mapped port (NAT-PMP/PCP/UPnP), so remote viewers behind carrier NAT can reach home directly. History lives on the hub. coturn only past ~1 TB/month | ADR: $0.092 → $0.040 per nursery at 10k; most remaining TURN disappears | XL | M | ADR 0006 Phase 4 | "Direct · free" for nearly everyone |

**Do this week (all S, low risk, no dependency on Phase A):** 1, 6, 11. **Before anyone sets `TURN_KEY_ID`:** 2, then 8.
**With ADR 0006 Phase 0:** 3, 4, 9. **Then:** 5, 7, 10, 12, 13.

**Not doing:**

| Idea | Why not |
|---|---|
| Realtime SFU or Cloudflare Stream for meetings, calls or small broadcasts | $0.05/GB or $1 per 1,000 minutes, versus a free mesh |
| Viewer-to-viewer segment mesh | Saves R2 egress, which is already $0 |
| Live through Google Drive | Rate limits; against Drive's terms |
| Self-hosted coturn now | Ops burden; worth it only past ~1 TB/month |
| An uptime ping on `/api/*` | Keeps the container awake 24/7 ≈ $7/month |
| Any `setTimeout` or held-open fetch in a DO | Breaks hibernation: ≈ $20k/month at 10k nurseries |

---

## 6. Data and privacy

**What is recorded**
- Aggregates only: minutes by path, bytes, frame and segment counts, request and row estimates, per nursery, account or event
  per month, and per session in Analytics Engine.
- **No per-viewer tracking:**
  - guests are never identified in usage data;
  - members appear only as their internal account UUID, and only for their own calls, meetings, broadcasts and copies.

**What is never recorded**
- IP addresses. The same-network hint compares `CF-Connecting-IP` in memory and sends a boolean.
- ICE candidates, SDP, names, emails, media, chat text.
- TURN `customIdentifier` is an HMAC with a server secret, never a readable id.

**Who sees it**

| Viewer | Sees |
|---|---|
| A member | Their own account usage |
| Parents | Their nursery's usage (role-gated like `q` history queries); caregivers and viewers don't |
| The admin (owner) | Aggregates, plus top consumers resolved to an email **in the admin console only** |

There is no cross-user comparison, ranking or leaderboard for users.

**Retention**
- Monthly rows are kept 13 months in the DOs (tiny; for a year-on-year view), then pruned by the existing 6-hour purge.
- Analytics Engine keeps its own limited retention. The owner view needs at most 90 days.

**Honesty:** every estimate is labelled; list prices carry their date; privacy wording stays bound to `privacyCopy.unit.test.ts`.

---

## 7. Phased implementation plan

Each phase ships on its own and is reversible. "Owns" means the file's workstream in ADR 0006's ownership matrix
(`0006…md`, §4 of its checklist). Coordinate or sequence rather than edit the same file twice in a wave.

**In-flight work this plan depends on:**
- **Monitor relay fixes** in `live/monitor/relay*.ts` and `live-worker/src/monitorRoom.ts`. The latest merged is `b63d8f4` /
  `9f7115e`; more may be in progress. Phase A's MonitorRoom hooks are a small diff (≤ 40 lines calling `usageMeter.ts`) and land
  **after** the relay fixes, rebased on them.
- **ADR 0006 Phase 0:**
  - WS-8 owns `server/src/services/costCentre.ts`, so Phase A *is* WS-8's cost-telemetry task.
  - WS-7 owns `live-worker/src/index.ts` and `wrangler.jsonc`.
  - WS-4 owns `ice.ts`.
  - WS-5 owns `SettingsView.tsx`.
  - WS-6 owns `MonitorViewer.tsx`, `MonitorCamera.tsx`, `rtc.ts`, `PeopleCard.tsx` and `NurserySettings.tsx`.
  - WS-9 owns `monitorRoom.ts` and `monitorStore.ts` (Wave 2).
  - WS-11 owns `eventRoom.ts`.
- **Calls and meeting work** (just finished): `callMesh.ts`, `studio/rtc.ts`, `CallScreen.tsx`, `QuickStart.tsx`. Rebase on it;
  later changes to these files go through whoever owns them next.

### Phase A: metering and the owner view (≈ 1–1.5 weeks)

| Step | Files | Notes |
|---|---|---|
| A1 | `shared/stream/usage.ts` + `usage.test.ts` (new) | Types, `STREAM_UNIT_PRICES` (`checkedOn`), `listValueUsd`, `allocateOverage(accountTotals, allowances, productShares)`, `projectMonthEnd` |
| A2 | `live-worker/src/usageMeter.ts` + test (new) | In-memory counters plus attachment-backed per-socket totals; `flush(now)` at most hourly → 1 KV row + 1 Analytics Engine point; fails open |
| A3 | Hooks: `monitorRoom.ts` (relay frames and relay minutes, the `use` message, flush in the existing alarm and on the last camera close, `call_stats` → point), `eventRoom.ts` (`/ingest` takes `bytes`; viewer-minutes from the existing curve; flush in the janitor alarm and at the end), `callRoom.ts`, `userLine.ts` (account month row), `index.ts` (pass `bytes.byteLength` to `/ingest`; recording bytes on `complete`) | Minimal diffs. After the relay fixes. Coordinate with WS-7/9/10/11 |
| A4 | `live-worker/wrangler.jsonc` | `"analytics_engine_datasets": [{ "binding": "STREAM_USAGE", "dataset": "stream_usage" }]`. The binding is optional in code |
| A5 | `server/src/services/costCentre.ts` + `costCentre.test.ts`; `shared/types/costCentre.ts` (optional fields only) | GraphQL DO/R2-ops/TURN datasets; the Analytics Engine SQL API (same read-only token, plus the Account Analytics Read scope); the stream product row from data; per-feature, top consumers, headroom, projections, KPIs, alerts (pure functions). **= WS-8** |
| A6 | `components/admin/costs/StreamCard.tsx` (new); `components/admin/CostCentre.tsx` (`MAIN_TABS` + tab) | Built from the existing kit only |
| A7 | `/home/user/Comic2/.github/workflows/stream-cost-watch.yml` + `scripts/ops/streamCostWatch.mjs` (new) | Daily, jittered cron (for example `17 6 * * *`); GitHub issue on alert state change; never wakes the container. ADR 0006 WS-1 owns `.github/**` in Wave 1: sequence after it |
| A8 | `docs/infrastructure/COST_RUNBOOK.md` §1; `docs/features/baby-monitor.md` relay cost paragraph | Add DO rows, TURN and server relay lines; fix the "~4.6k GB-s per relayed night ≈ $1.7" claim (§8 item 2). The baby-monitor doc is WS-8's |

**Verification:**
- **Unit:**
  - `usageMeter` survives simulated hibernation (memory dropped, rebuilt from attachments: totals exact, no double count);
  - ≤ 1 row per hour per object;
  - a spy proves `onRelayFrame` and the segment GET path never touch storage.
- **Unit:** `costCentre` fixtures check provenance labels, overage allocation (the free tier is consumed account-wide first),
  projection maths and each alert threshold.
- **Production, 7 days after deploy:**
  - metering overhead ≤ **1% of DO rows** and ≤ **0.5% of DO requests**, comparing GraphQL before and after;
  - estimated `MonitorRoom` requests within **±15%** of the GraphQL namespace total (calibration);
  - a Cost centre load adds ≤ 4 GraphQL queries and 1 Analytics Engine query.
- **Owner check:** the Stream Studio row shows real units with badges, and the headroom meters match the Cloudflare dashboard
  within 5%.

### Phase B: what users see (≈ 1–1.5 weeks; needs A2/A3)

| Step | Files | Notes |
|---|---|---|
| B1 | `live/usage/sessionMeter.ts` + unit test (new) | Minutes per path and TURN `bytesReceived` from the `getStats` reads that already run (`rtc.ts:80` `netPath`, `rtc.ts:639`, `callMesh.ts:701`); add one for `studio/rtc.ts`; cumulative `{t:'use'}` on path change, every 15 min and on `pagehide` |
| B2 | `live/costCopy.ts` + `live/costCopy.unit.test.ts` (new) | Every user string from §4; the rules in §4.8 |
| B3 | Pre-action: `live/views/create/QuickStart.tsx`, `live/views/StudioView.tsx`, `live/components/SaveSheet.tsx`, `live/views/MonitorCamera.tsx` (privacy copy unchanged), `live/views/SettingsView.tsx:383` | Path line before every server-paid action |
| B4 | Indicators: `live/views/MonitorViewer.tsx:1279, 1291-1292`, `live/views/calls/CallScreen.tsx:282`, `live/views/monitor/PeopleCard.tsx`, Studio guest tiles | §4.3 table |
| B5 | Receipts: `live/views/SummaryView.tsx` (Delivery block), `live/views/calls/CallHost.tsx` (end toast), `live/views/monitor/NurserySettings.tsx` ("Last night…") | Exact actuals; list-price $ marked "est." |
| B6 | Usage card: `live/views/settings/UsageCard.tsx` (new); `SettingsView.tsx` section `usage`; the nursery section in `NurserySettings.tsx`; socket reads: UserLine `{t:'usage_get'}`, MonitorRoom `q` kind `usage` (parents only) | Loads on open; no timers |
| B7 | Allowance notices at 80/100% (toasts plus the meter) | In-app only |

Dependencies: WS-5 (`SettingsView.tsx`) and WS-6 (monitor views) in Wave 1, plus the recent calls and meeting work. Sequence
B3–B6 after those merge, or hand the copy module to those workstreams.

**Verification:**
- Copy tests, `privacyCopy.unit.test.ts` and the existing view tests (`SettingsView.test.tsx`, `SaveSheet.test.tsx`,
  `CreateView.test.tsx`) stay green.
- A fixture test shows the Usage card equals the server's month counters.
- A test asserts no `setInterval` in `UsageCard`.
- A Playwright pass: P2P blocked → the pill reads "Through our server" and the Usage card's server-relay minutes rise.
- **Targets:**
  - 100% of server-paid actions show a path line before they start;
  - user-reported path minutes within ±5% of server-side relay minutes for relay sessions.

### Phase C: frugality changes (ordered; each with a measurable target)

Baselines come from Phase A. Targets are provisional until 7 days of data exist.

| Step | Change (rank in §5) | Files | Target |
|---|---|---|---|
| C1 | Recordings Drive or device first (1) | `live/prefs.ts:71` (default `false`; bump the prefs version so existing explicit choices are kept), `SaveSheet.tsx:165-166`, `live/config.ts:48`, `live-worker/src/index.ts` `op=init` quota (WS-7), `userLine.ts` rolling 10 GB | Automatic R2 uploads = **0**; R2 recording storage ≤ 2 GB-month at current scale |
| C2 | Push, not poll (6) | `live/views/EventPage.tsx:47`, `SoundLevelCard.tsx:61`, `WeekCard.tsx:64` | Invite page ≤ **12 requests per waiting tab-hour** (from 240); **0** history queries while hidden |
| C3 | LAN first and ICE fixes (5) | `live/monitor/rtc.ts:43-52` + peers (WS-6), `linkFallback.ts:77`, a `monitorRoom.ts` same-network boolean (WS-9) | ≥ **95%** of same-Wi-Fi viewer sessions on `lan` within 5 s; **0** instant-relay frames to same-network viewers |
| C4 | MonitorRoom diet (3) | ADR 0006 WS-6 / WS-9 | Per active nursery-day: DO requests ≤ **1,000**, rows ≤ **1,800**, DO duration ≤ **40 GB-s** (ADR acceptance, 7-day median) |
| C5 | Hidden → sound only, relay cap 400 kbps (4) | ADR 0006 WS-6 | **0** video minutes sent to hidden viewers. **Server-relayed video minutes per monitored night: median ≤ 5, p90 ≤ 60.** Our-server share of monitor viewer-minutes ≤ **10%** |
| C6 | TURN guardrails (2), then set the TURN secrets | `live-worker/src/ice.ts` (WS-4), `monitorRoom.ts`, `callRoom.ts`, `eventRoom.ts` callers | **0** credentials shared across rooms (test); ≥ **95%** of TURN egress attributable to an identifier; credential TTL ≤ 4 h |
| C7 | Relay-path caps (8) | `live/calls/callMesh.ts:111`, `live/studio/rtc.ts` | TURN GB per relayed 1:1 call-hour ≤ **0.4** (from ≈ 0.68) |
| C8 | TURN on the side that receives less (7) | `ice.ts` + room "who gets TURN first" | After a 1 h lab test: TURN egress per relayed monitor viewer-hour ≤ **15 MB** (from ≈ 310 MB) |
| C9 | E2E relay, then relay before viewer-side TURN (9) | ADR 0006 Phase 0 E2E | Viewer-side TURN ≤ **2%** of monitor viewer-minutes |
| C10 | Broadcast trims + R2 lifecycle (10) | `index.ts` (WS-7), `eventRoom.ts` (WS-11); the owner runs `wrangler r2 bucket lifecycle add` | DO requests per stream-hour ≤ **800** (from ≈ 1,371: drops the 600 `authHost` calls); rows ≤ **1,000** (from ≈ 1,920: `putMeta` every 10 segments, batched chat `stats`); dead-event DO storage **0** after 9 days |
| C11 | Container asleep (11) | `live/driveUpload.ts:29` | ≤ **1** container wake per Drive save session |
| C12 | Family live (12), native hub + port mapping (13), coturn past 1 TB/month | later | Separate ADRs |

#### Status: C1, C2 and C11 (implemented on `impl/costs-frugal`, 2026-10-22)

**C1 — recordings Drive or device first. Done.**
- `cloudRecordings` defaults to `false` (`live/prefs.ts`). Prefs now carry `prefsVersion: 2`, and `migratePrefs` runs on
  every load and on prefs synced from the account:
  - a version-1 `false` was a real choice (the old default was `true`), so it is kept;
  - a version-1 `true` can't be told apart from the old default, so it is turned off once, and the save sheet says so once
    ("7-day copies are now made only when you choose one…") so anyone who did choose it can turn it back on;
  - from version 2 on, whatever is saved was chosen, and is kept (including an explicit "on").
- The save sheet (`live/components/SaveSheet.tsx`) lists Google Drive and this device first, each marked
  **"Free · yours to keep"** or **"Free · on this device"**. The 7-day copy sits below them under "Or a 7-day copy ·
  through our servers": its exact size, "Uses our storage and N of your upload", and **"kept 7 days · X of 10 GB used"** with a
  meter. Nothing uploads until the host taps "Keep a 7-day copy". A host who turned on "Also keep a 7-day cloud copy" in
  Customize still gets it right away, and the sheet says why. The word "free" is never on the copy.
- Server quota: **10 GB rolling per account**, on server truth (§4.7 rules), in `live-worker/src/cloudCopyQuota.ts` (a small
  hunk per route in `index.ts`):
  - **At `op=init`:** one R2 list of the account's ledger. If the copy fits, its size is reserved and the multipart upload is
    created at `events/<eventId>/rec/<startedAt>-<bytes>/<file>`. R2 ties the uploadId to that key, so the reservation can't be
    raised by the app.
  - **Every `op=part`:** must fit inside the reservation. Every part but the last is the server's part size (16 MiB, returned
    as `partBytes`), so part *n* may hold at most `min(16 MiB, reserved − (n − 1) × 16 MiB)` bytes. That costs no R2 call, and
    an upload can never hold more than the ledger counts for it, finished or not.
  - **At `op=complete`:** R2's own size of the finished object is checked against the reservation again (an over-size object
    is deleted, `cloud_copy_mismatch`) and is the size registered with the event, not the app's number.
  - The ledger is one empty R2 marker per upload, `quota/rec/<accountId>/<eventId>-<startedAt>-<bytes>`, with the copy's key
    and uploadId in its metadata. It is aged out after 7 days and cleaned up on the account's next check. Two uploads never
    share an entry: a second copy of the same recording is a second object, and counts. Starting the same recording again
    (same event, same size) replaces an earlier try that never finished: that upload is aborted first, so its parts can't be
    finished later, and then it stops counting. A retry never counts twice. If the abort can't be confirmed, the old try
    keeps counting (over, never under).
  - Cost: 1 R2 list + 1 marker write per cloud copy (+ 1 head for each unfinished earlier try of the same recording). Nothing
    extra per part.
  - The init needs the host's own Supabase token (the Worker still holds no secrets). It refuses with an honest reason the
    sheet shows as-is: `cloud_copy_full` (with the GB used and the day space frees up), `cloud_copy_too_big`,
    `sign_in_required` (no token, or Supabase says the token is invalid / not a member), or `quota_unavailable`. That last one
    fails closed (nothing is stored) when the ledger can't be read in full, *or Supabase doesn't answer*. A Supabase outage
    says "try again in a moment", never "sign in again".
  - `GET …/recordings?op=quota&bytes=N` feeds the meter: numbers only, never keys or the account id. With the recording's
    size it also returns `retryBytes`, the part of "used" held by an unfinished try of this recording, so the sheet decides
    "fits" the same way `op=init` will. The sheet says so ("… of that is an unfinished try of this recording. Starting it
    again replaces that try, so it isn't counted twice.").
  - An upload that is started, abandoned and never retried still counts for its 7 days. That is accurate: R2 keeps its parts
    until it aborts unfinished uploads (7 days by default).
  - **Deploy step (owner, once):** markers of an account that never checks again are removed by an R2 lifecycle rule, so no
    per-copy record (account UUID + event + size) outlives its copy:
    `npx wrangler r2 bucket lifecycle add dreamstream-live quota-rec-expiry quota/rec/ --expire-days 8`
    (also in `live-worker/README.md`). It must stay longer than 7 days, or copies past the allowance would get through.
- Copy: `live/config.ts` `LIMITS` ("Saved to this device or your Google Drive — free, and yours to keep. Nothing is kept on our
  servers unless you choose a 7-day copy…") and the two Help entries in `live/components/Guide.tsx`.
- Tests: `live/prefs.unit.test.ts` (default off, every migration path, cloud sync, notice once), `SaveSheet.test.tsx` (free
  labels, no upload by default, explicit opt-in, no room, server "full", retry, reopened after an unfinished try, notice),
  `live/cloudCopy.unit.test.ts` (including the server's part size), `live-worker/src/cloudCopyQuota.test.ts` (fits, full,
  retry replaces an unfinished try and aborts it, two finished copies both count, a declared 1 byte can't upload more,
  parts past the reservation, pre-quota keys, R2's size registered, over-size deleted, ageing out, too big, sign-in vs
  Supabase outage, host-key gate first, fail closed on an unreadable or overlong ledger).
- Not done here: Settings → Recording's toggle copy (`SettingsView.tsx:383`, WS-5) still says "Uploads in the background after
  each recording" without the cost line from §4.2; `SummaryView.tsx:200` still points to "Customize → Quality & encoding".
  The "What this costs DreamStream (est.)" expander waits for `STREAM_UNIT_PRICES` (A1), so prices live in one table.

**C2 — push, not poll. Done.**
- Invite page (`live/views/EventPage.tsx` + `live/invitePoll.ts`): a sliding-window cap of **6 looks per tab-hour (12
  requests: each look is a Worker + a Durable Object request)**, from 120 looks (240 requests). Inside it: every 30 min far from
  the start, a look 1 min before the start, then 2, 6 and 12 min later and every 20 min after. No start time: the same backoff.
  Ended: never again, on a timer or on coming back to the tab (`stillWaiting`, shared by both). Hidden tab: no timer at all;
  coming back looks once if the last look is a minute old and the budget allows. A failed look after the page has loaded no longer replaces it with "Event not found". The countdown re-renders every
  5 s while visible, never while hidden.
- `SoundLevelCard.tsx` and `WeekCard.tsx`: no timers. History is asked for when the card is shown, when the range changes, and
  when it is stale (one chart bucket: 5/5/15 min for 1 h/6 h/24 h; 10 min for the week) and something new happens: the room's
  pushed `minutes`, the page coming back into view or focus, or a socket reconnect. **0 history queries while hidden.**
- Tests: `live/invitePoll.unit.test.ts` (budget over 6-hour waits for 8 schedules, with and without tab-switching),
  `live/views/EventPage.test.tsx` (≤ 6 looks an hour, flips within 2 min, hidden = 0 requests and 0 timers, ended — including
  an hour of tab-switching: 1 request —, blips), `SoundLevelCard.test.tsx` (also: a quick range switch away and back never
  leaves "Loading…" on screen) and `WeekCard.test.tsx` (0 queries and 0 timers while hidden, refresh rules).

**C11 — container asleep. Done.** `live/driveUpload.ts`: a good Drive status is reused for 10 min (`STATUS_TTL_MS`); a
failed check is never cached; the cache is dropped when Google refuses the grant mid-upload or the backend says signed out.
The save sheet reads the account email from the known status after an upload instead of asking again, so one save session
is the status check plus the upload-session call: ≤ 1 container wake.

**C3's IPv6 fix is not in this change.** `classifyPath` (`live/monitor/rtc.ts:47-52`, WS-6) treats any `host` candidate as
Home Wi-Fi, so two phones on carrier IPv6 (global addresses, host candidates) show "Home Wi-Fi" and get the LAN upload budget.
The fix: a host candidate counts as local only when its address is private (RFC 1918, `fc00::/7`, `fe80::/10`, an mDNS
`.local` name); a global IPv6 host candidate is `internet`. It needs a `rtc.unit.test.ts` case for each.

**Overall Phase C success measures** (Cost centre, 30 days):
- Stream Studio marginal cost $0 at current scale.
- List-price value per active nursery-month ≤ **$0.05**.
- ≥ **90%** of monitor viewer-minutes on Home Wi-Fi or Direct.

---

## 8. Open questions for the owner

1. **Dollars for users.** Show "What this costs DreamStream" in USD to users, labelled as our cost and in an expander
   (recommended)? Or percent and GB only, as Comic Studio's platform allowance does? Or nothing?
2. **Fair-use numbers.** Relay data 10 GB per account-month (plus 10 GB per nursery)? Picture through our server 16 h a day?
   Cloud copies 10 GB rolling? At 100% relay data, the monitor defaults to *sound only*, not the not-yet-encrypted server
   relay. Agreed?
3. **TURN in production.** Switch it on (it fixes calls and guests on carrier NAT) only after P2 guardrails? What monthly TURN
   ceiling triggers an alert: $10?
4. **Cloud copy default off.** This changes the promise in `live/config.ts:48` ("Saved to your device AND kept on the server for
   7 days"). Agreed?
5. **Analytics access.**
   - Set `CF_ANALYTICS_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for the backend (read-only, with the Account Analytics Read scope
     for Analytics Engine).
   - Add the same read-only token as a GitHub Actions secret for the daily watch.
   - Set a Cloudflare account budget alert (for example $10).
6. **Charging later?** If yes, which unit: a relay-data pack, more cloud-copy storage, larger meetings (SFU)? This decides whether
   counters must be billing-grade (signed, reconciled) or are fine as estimates.
7. **Allowance attribution.** Monitor relay data counts against the **nursery** (the parents control who watches), and calls
   against the caller's **account**. Agreed?
8. **Shared Cloudflare account.** The non-DreamStream Workers (`atlasd`, the personal website) draw on the same free allowances.
   Move them to a separate free account?
9. **Cloudflare terms** for video relayed through Workers/DOs. R2 via the CDN is explicitly allowed; the DO relay is not named.
   Check before marketing "free relay".
10. **Supabase plan.** Free pauses after 7 days without activity; ADR 0006 budgets Pro at $25. Decide before launch.

---

## 9. Sources

**Cloudflare docs** (fetched 2026-10-22):
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) (updated 2026-10-18). Hibernation-eligible idle objects are not billed for duration; `setAlarm` = 1 row written.
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/) (updated 2026-10-01).
- [Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/) (updated 2026-09-22).
- [TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/): edge → client billed, ingress free, server ↔ peer not part of billing.
- [TURN custom identifiers and analytics](https://developers.cloudflare.com/realtime/turn/replacing-existing/): one identifier per query because of adaptive sampling.
- [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) and [WebSockets / hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
- [Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/).
- Cloudflare changelog, June 2026: billable usage widget and account budget alerts.

**Supabase:** [supabase.com/pricing](https://supabase.com/pricing).

**Repo:**
- ADR 0006 (cost model; Phase 0; WS ownership).
- `docs/features/baby-monitor.md`, `docs/features/stream-studio.md` §10, `docs/infrastructure/COST_RUNBOOK.md`.
- `server/src/services/costCentre.ts`; `shared/types/costCentre.ts`; `components/admin/CostCentre.tsx`.
- Comic Studio: `server/src/comic/billing.ts`, `shared/comic/models.ts`, `components/comicstudio/ComicStudio.tsx`, `GateCard.tsx`,
  `server/src/services/platformAllowance.ts`, `server/src/lib/providerUsage.ts`.

**Arithmetic:** the session working notes `comic-costing.md`, `stream-cost-model.md`, `frugal-tech.md` and `model.py`. Those
notes are not in the repo; every figure they gave that is used here is restated above with its inputs.

### Doc inconsistencies found (fix in Phase A8)

- `docs/features/baby-monitor.md` (relay "Cost" paragraph) says that while relay frames flow "the object stays awake: up to ~4.6k
  GB-s per relayed night … ≈ $1.7 per nursery per month". Under current pricing, an idle object that is eligible to hibernate is
  not billed, so the real adder is ≈ $0.16 per all-night relay viewer-month (requests). Confirm with
  `durableObjectsPeriodicGroups` in Phase A.
- `docs/infrastructure/COST_RUNBOOK.md` §1 and `FIXED_COSTS` in `costCentre.ts` have no lines for DO rows written, TURN or the
  server relay.
- The `costCentre.ts:756-769` verdict "No metered cost" is no longer true at scale (SQLite rows written have been billed since
  January 2026; Cloudflare's target date was 2026-01-07).
