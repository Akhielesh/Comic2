# Cloud Cost Optimization — Runbook & Playbook

**Status:** Authoritative cost runbook. **Last verified:** 2026-10-19 (backend moved to Cloudflare Containers).
**Companion:** `INFRA_MAP.md` (what exists) · `ENV_MATRIX.md` (env vars).
**Maintain this:** update the per-service cost model whenever a service, plan tier, or
paid provider changes.

> **The one-sentence diagnosis from the 2026-06 audit:** *100% of the historically large
> bills were **Railway compute** — always-on backends holding memory 24/7 without
> App-Sleeping, multiplied across the Feb–May era when AtlasD ×3, applypilot, and 3 web
> apps all ran at once. Supabase is on the **free** plan ($0) and Cloudflare is within
> free tier. Fix Railway and the problem is structurally solved.*
>
> **2026-10-19:** structurally solved — the backend left Railway (trial expired 2026-10-16)
> and now runs as a Cloudflare Container that is billed only while awake, inside the
> Workers Paid plan the account already pays for. See §2.

---

## 1. Per-service cost model (single-user scale)

| Service | What you pay for | Est. monthly | Lever |
|---|---|---|---|
| **Backend container** (`Backend`, `basic` 1/4 vCPU · 1 GiB · 4 GB) | Memory + disk per awake second, CPU per *active* second | **~$0–1** at a few hours/day awake; **~$7 worst case** if kept awake 24/7 | Sleeps 15 min after the last request; one instance; Node heap cap, no Redis, lazy Pyodide |
| **Cloudflare Workers Paid** | Flat plan fee (required by the backend container) | **$5** | Includes 25 GiB-h memory, 375 vCPU-min, 200 GB-h disk of Containers per month |
| **Railway** | Nothing — trial expired, deployments removed | **$0** | Dormant fallback; don't upgrade the plan unless returning (`INFRA_MAP.md` §3a) |
| **Railway dead projects** | Idle volumes only (~1.4 GB total) | **~$0** while the account is on an expired trial | Delete dead services/volumes (§4) |
| **Cloudflare Pages** | — | **$0** | Free |
| **Cloudflare Workers** | Requests (10M/mo included on Paid) | **$0** beyond the plan | — |
| **Cloudflare R2 (dreamstream-live)** | Storage + ops (10 GB free) | **~$0** | Janitor purges segments @24h, recordings @7d |
| **Durable Objects — Stream Studio rooms** (`MonitorRoom`, `EventRoom`, `UserLine`, `CallRoom`) | Requests (incoming WebSocket messages 20:1, alarms), **rows written** (every KV put/delete and every `setAlarm`), duration only while busy (hibernation-eligible rooms aren't billed) | **$0** inside 1M requests · 50M rows · 400k GB-s a month (**account-wide**, shared with every Worker). At list price a monitored nursery is ≈ $0.32/month today, 93% of it `MonitorRoom` rows (≈ $0.044 after ADR 0006 Phase 0) | ADR 0006 Phase 0 write diet; never a timer or held-open fetch in a DO; Admin → Costs → Stream Studio per-nursery-day KPIs |
| **Baby monitor server relay** (picture through our server) | DO requests (each camera frame = 1/20 request) + room duration while frames flow — no bandwidth charge | **≈ $0.0055 per all-night relay viewer-night** (≈ $0.16/month), $0 inside the free tiers | Direct / Home Wi-Fi first; hidden viewers → sound only; counted per nursery (`usageMeter.ts`) |
| **Cloudflare Realtime TURN** (switched on 2026-10-22) | Edge → client egress bytes only | **$0** inside the first 1,000 GB a month (account-wide), then $0.05/GB. One all-night TURN viewer ≈ $4.66/month at list price | Per-socket, short-TTL credentials (P2 guardrails); TURN for the side that receives less; **alert at $10/month** (daily `stream-cost-watch` + Cloudflare budget alert) |
| **Stream Studio metering** | Workers Analytics Engine points (≤ 1 per room per hour, plus the security / watch-readiness signal counts: ≤ 1 per minute per isolate per signal) | **$0** (10M points/month included; not billed yet) | Optional binding `STREAM_USAGE`; fails open; signals coalesce in memory, so a flood is a point a minute, not a point a request |
| **Durable Object storage** | GB-month stored by every DO on the account | **$0** inside 5 GB, then $0.20/GB-month | Rooms keep 90 days of events and packed minute blocks only; Admin → Costs → Stream Studio shows the level and its headroom (ADR 0006 WS-8) |
| **CSP report counts** | Analytics Engine points from the Pages function (one per browser report) | **$0** (same 10M included) | Optional Pages binding `CSP_REPORTS`; reports are counts by origin only |
| **Supabase** | Free plan | **$0** | Stay under 500 MB DB / 1 GB storage / 2 active projects |
| **LLM / AI providers** | Per-token; platform-funded capped at **$5/user/mo** | **variable, capped** | Platform allowance + per-provider budgets (well-architected) |
| **CoinGecko Basic** | Only if `COINGECKO_API_PLAN` = paid | **$35** if enabled | Keep on free/demo unless commercial crypto display is needed |
| **Magic MCP (21st.dev)** | Dev tool subscription | n/a (dev only) | — |

**Net (since 2026-10-19):** **$5 Workers Paid + ~$0–1 container usage + $0 Supabase + $0
Railway** ≈ **$5–6/mo**, with a hard worst case around $12/mo even if something kept the
backend awake all month. Stream Studio (rooms, relay, TURN, R2) adds **$0** while the account
stays inside the free allowances — see Admin → Costs → Stream Studio for the marginal $ next to
the list-price value, the headroom left in each allowance and the month-end projection
(design: `docs/features/stream-studio-costs.md`, ADR 0007).

---

## 2. The backend — now a Cloudflare Container

### 2.0 How it bills (Workers Paid, verified pricing 2026-10)
- **Memory** $0.0000025 per GiB-second (= $0.009 per GiB-hour) and **disk** $0.00000007 per
  GB-second while the container is **running**; **CPU** $0.00002 per vCPU-second, only while
  actually busy. Monthly included: 25 GiB-h memory, 375 vCPU-min, 200 GB-h disk.
- `basic` = 1 GiB / 4 GB, so the first ~25 awake hours a month are free, then ≈ $0.01 per
  awake hour. **Billing stops when it sleeps** (`sleepAfter: '15m'` in
  `api-proxy/src/backend.ts`).
- Levers: keep `sleepAfter` short; keep `max_instances` at 2 (the proxy only ever uses one);
  don't add anything that pings `/api/*` on a schedule (an uptime monitor every 10 min would
  keep it awake 24/7 ≈ $7/mo). `basic` → `standard-1` (4 GiB) only if Pyodide-heavy work hits
  the 1 GiB ceiling (watch for exit code 137 in Workers → dreamstream-api → logs).
- **Verify:** Cloudflare dashboard → Workers & Pages → Containers → `dreamstream-api-backend`
  → instances should read 0 running when nobody is using the app.

### 2.0b Railway (dormant)
The Railway trial expired on 2026-10-16 and the Comic2 deployment was removed; nothing bills.
§2.1–2.4 below are kept as the playbook **if you ever return to Railway**.

### 2.1 App-Sleeping (the #1 control) ✅ done 2026-06-16
Scales the service to **zero** memory when idle; wakes on the next request (cold-start
latency on first hit). **Already enabled** on `Comic2` and `SearXNG`.

- **Verify (MCP):** `service_metrics` for the service — if memory has a non-zero floor that
  never drops to 0 during idle hours, sleeping isn't taking effect (or it's getting pinged).
- **Set (MCP):** `update_service sleep_application=true`
  (project `hospitable-enthusiasm` / env `production` / service `Comic2`).
- **Set (dashboard):** Service → Settings → Serverless → enable.
- ⚠️ Not a `railway.json` field — it's a service setting that persists across deploys.

### 2.2 No Redis on the always-on backend
`REDIS_URL` must stay **unset** on Comic2. A live Redis connection adds an always-on charge
**and** emits constant traffic that blocks App-Sleeping from ever engaging. Redis is only
for the separate `ventures:worker` / `connectors:worker` processes, which are **not run by
default** — keep it that way.

### 2.3 Memory baseline
- Keep `NODE_OPTIONS=--max-old-space-size=512` (Dockerfile).
- **Never** re-add eager Pyodide package preloading — WASM memory never shrinks and would
  pin ~500 MB permanently. Keep `loadPackagesFromImports` (on-demand).
- Keep background timers `.unref()`'d and idle-silent.

### 2.4 Verify the plan tier
Hobby ($5/mo, includes $5 usage) vs Pro ($20/seat/mo). At single-user scale, **Hobby is
correct.** Check Railway → Account → Usage/Billing. This can't be read via the MCP; do it
in the dashboard. **This fixed fee is probably your largest remaining Railway cost.**

---

## 3. Cloudflare — watch the Container, the rest is free

- **The backend container** (`Backend` in `dreamstream-api`, `basic`, one instance) is the only
  Container left. It bills only while awake; keep it sleepable (§1, `CLAUDE.md`).
- ✅ **Code Studio's sandbox Containers are gone** (2026-10-22, ADR 0005). `studio-worker`
  (`standard-3` = 2 vCPU / 8 GiB, capped at 3 instances) was the biggest Cloudflare cost
  landmine; it was removed from the repo with its deploy workflow. Owner step: delete the
  deployed `dreamstream-studio` Worker and its `*.dreamstreamstudio.ai/*` route if they still
  exist. **Keep Workers Paid** — the backend container needs it.
- **R2** (`dreamstream-live`): confirm the DO alarm janitor is actually purging (segments
  @24h, recordings @7d) so storage stays near zero. 10 GB free.
- **Workers/DO**: covered by Workers Paid at single-user scale.

---

## 4. Dead-resource cleanup (Railway)

These are stopped (so **$0 compute**) but keep ~1.4 GB of volumes and clutter the account.
Per the owner's decision (keep **Comic2** + **AtlasD**), the rest can be removed once
confirmed. **Destructive — preview each before deleting.**

| Candidate | Action | Reversible? |
|---|---|---|
| `autojobapply` (Postgres 0.81 GB + applypilot) | Delete project if autojob is abandoned | No (data loss) |
| `mineral-atlas`, `oil-intelligence-platform`, `sourcevault-data-brain-ui` | Delete projects | No |
| `joyful-flow` Redis-PcL_, Redis-f8qS, AtlasD-beta | Delete duplicates; keep one AtlasD (+ at most one Redis if AtlasD needs it) | No |
| `observant-bravery` AtlasD | Delete (duplicate of joyful-flow AtlasD) | No |

> The owner asked to **preserve** rather than delete by default, so these are left asleep.
> They cost ~$0.20/mo total. Delete only on explicit confirmation.

---

## 5. AI / provider spend (variable cost — already well-guarded)

The codebase is genuinely well-architected here; **do not weaken these guardrails**:
- **Platform allowance** `$5/user/mo` caps platform-funded providers; BYOK is free to you.
- **Per-provider budgets** keep every connector under its free tier.
- To use the cheapest LLM routing, set `AI_PROVIDER=openrouter` and fund
  `DREAMSTREAMSTUDIO_ALL`; OpenRouter reports per-call USD so spend is observable at
  `GET /api/usage/providers`.
- Keep `COINGECKO_API_PLAN` on the free/demo tier unless you truly need commercial crypto
  display ($35/mo Basic).

---

## 6. Storage hygiene

- **Supabase free tier ceilings:** 500 MB DB, 1 GB storage, 2 active projects. You have 1
  active + 9 paused — fine. Watch `comic-assets` storage and the big tables
  (`token_ledger_entries`, `artifacts`, `connector_items`) as usage grows; add retention/
  rollup pruning before you approach 500 MB to avoid being forced onto Pro ($25/mo).
- **R2:** janitor must keep live segments bounded (§3).
- Periodically prune orphaned `image_assets` / `comic-assets` objects with no parent row.

---

## 7. Monthly cost-control checklist

**Start with the admin Cost centre** (DreamStream → Account → Admin → Costs; API
`GET /api/admin/costs?days=7|30|90`, `server/src/services/costCentre.ts`): every figure
is labelled **measured** (AI spend from `generation_cost_events` — settled, platform-paid
only; users' own-key calls shown apart; email and connector counts × list price),
**estimated** (the retired Code Studio sandbox, history from `studio_runs` awake time ×
standard-3 prices, 25% CPU assumed; backend container ~$0.50) or **fixed** (Workers Paid $5, spread per day).
Revenue counts only paid tiers with a Stripe subscription (admin-comped accounts are
shown as "comped", not MRR). Per-Worker requests/CPU and R2 size appear once
`CF_ANALYTICS_API_TOKEN` (Account › Account Analytics › Read) and `CLOUDFLARE_ACCOUNT_ID`
are set on the `dreamstream-api` Worker or in D1 `backend_env`.

Then run this once a month (or when a bill looks off):

- [ ] Cloudflare: backend container (`dreamstream-api-backend`) shows 0 running instances
      when idle; Containers usage in Billing stays near the included amounts.
- [ ] Backend: `REDIS_URL` **unset** (no D1 row / var for it); nothing pings `/api/*` on a timer.
- [ ] Railway: still dormant (no surprise plan upgrade); no services in `RUNNING` state.
- [ ] Cloudflare: no `dreamstream-studio` Worker left (Code Studio retired; delete it if it reappears).
- [ ] Cloudflare: R2 `dreamstream-live` size near zero (janitor working).
- [ ] Admin → Costs → **Stream Studio**: no alerts; every headroom meter projects < 80% of its
      allowance (they are account-wide, DO storage included); *Baby monitor health* shows the
      **7-day medians** within the ADR 0006 budgets — DO invocations ≤ 2,600 (Cloudflare counts
      each incoming WebSocket message once; that is ≈ 1,000 billed requests), rows written ≤ 1,800,
      DO GB-s ≤ 40 per active nursery-day (hibernation working) — with all 7 days counted;
      our-server share of monitor minutes ≤ 10% (shown once viewers report their paths, Phase B);
      Glance bumps ≤ 60 a night once the rooms count them.
- [ ] Admin → Costs → **Security**: no alerts (CSP clean on Stream Studio, no unexplained “Not
      you?” uses, no refusal floods). What each one means and what to do:
      [`live-security-runbook.md`](./live-security-runbook.md) §6.
      The GitHub issue labelled `stream-cost-watch` is closed (the daily job opens it when an alert
      starts and closes it only when every dataset answered and nothing fires) and its last run is
      green. A red run or an open issue saying **"Couldn't measure"** means a Cloudflare dataset
      didn't answer (token revoked or out of scope, wrong account id, renamed field): the alerts it
      feeds kept their last state — fix the read, don't assume all clear.
- [ ] Cloudflare: an account budget alert (Billing → budget alerts) is set at **$10** — the
      backstop that still fires if metering breaks. TURN is on in production since 2026-10-22.
- [ ] Supabase: still on free plan; DB < 500 MB; storage < 1 GB.
- [ ] AI: `GET /api/usage/providers` shows spend within the $5 allowance; no provider
      pinned at its budget cap (which would mean a degraded/looping caller).
- [ ] CoinGecko plan not silently bumped to paid.

---

## 8. Known observability gaps

- **Billing dollars aren't readable via MCP.** Railway/Supabase/Cloudflare MCP expose
  metrics, not invoices. The actual $ figures live in each dashboard's Usage/Billing page.
  When diagnosing a bill, start there and map line items back to §1.
- The (dormant) Railway backend lives in project **`hospitable-enthusiasm`** (service
  `Comic2`), not a project named "comic2" (see `INFRA_MAP.md` §1 gotcha).

---

## 9. Change log

| Date | Change |
|---|---|
| 2026-06-16 | Runbook created. App-Sleeping enabled on Comic2 + SearXNG; dead projects identified; Container cost landmine flagged. |
| 2026-10-19 | Backend moved to a Cloudflare Container (`basic`, sleeps after 15 min). Railway dormant (trial expired). Cost model rewritten. |
| 2026-10-21 | Admin Cost centre (real data, measured / estimated / fixed, cost-benefit per product, optional live Cloudflare analytics). |
| 2026-10-22 | Stream Studio cost metering (ADR 0007 Phase A): rooms count usage in memory + WebSocket attachments and write ≤ 1 `use:YYYY-MM` row + 1 Analytics Engine point per room per hour; Admin → Costs gets a Stream Studio tab (measured DO / R2 / TURN month to date + estimated per-feature, per-path, top consumers, headroom, alerts); daily `stream-cost-watch` GitHub job (needs the read-only `CF_ANALYTICS_API_TOKEN` secret). §1 gains the DO rows, server relay and TURN lines. |
| 2026-10-22 | Code Studio retired (ADR 0005): the `studio-worker` sandbox Containers (`standard-3`) — the old cost landmine — removed from the repo; Workers Paid stays for the backend container. Cost centre labels the sandbox line "(retired)" and keeps reading `studio_runs` as history. |
| 2026-10-29 | ADR 0006 WS-8: the Stream Studio tab judges Phase 0 on **7-day medians** per active nursery-day (invocations / rows / GB-s vs 2,600 / 1,800 / 40 — the request budget in the unit Cloudflare's analytics count, ≈ 1,000 billed; new `request_diet` alert), reads Durable Object **storage** (`durableObjectsStorageGroups`, its own headroom row), and shows TURN GB, relay share, Glance bumps and pushes per night. The DO datasets reach back 7 days before the 1st so the medians and the hibernation check work early in a month. New **Security** tab (CSP counts, sign-in alerts, the live Worker's refusal / disconnect signals). The daily watch reads six datasets (storage added). |
