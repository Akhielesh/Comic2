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
| **Cloudflare Workers Paid** | Flat plan fee (already required by the studio container) | **$5** | Includes 25 GiB-h memory, 375 vCPU-min, 200 GB-h disk of Containers per month |
| **Railway** | Nothing — trial expired, deployments removed | **$0** | Dormant fallback; don't upgrade the plan unless returning (`INFRA_MAP.md` §3a) |
| **Railway dead projects** | Idle volumes only (~1.4 GB total) | **~$0** while the account is on an expired trial | Delete dead services/volumes (§4) |
| **Cloudflare Pages** | — | **$0** | Free |
| **Cloudflare Workers** | Requests (10M/mo included on Paid) | **$0** beyond the plan | — |
| **Cloudflare Containers (studio-worker)** | vCPU + memory **per running instance** (`standard-3` = 2 vCPU/8 GiB, max 50) | **$0 idle → can spike** | ⚠️ Real cost landmine — see §3 |
| **Cloudflare R2 (dreamstream-live)** | Storage + ops (10 GB free) | **~$0** | Janitor purges segments @24h, recordings @7d |
| **Supabase** | Free plan | **$0** | Stay under 500 MB DB / 1 GB storage / 2 active projects |
| **LLM / AI providers** | Per-token; platform-funded capped at **$5/user/mo** | **variable, capped** | Platform allowance + per-provider budgets (well-architected) |
| **CoinGecko Basic** | Only if `COINGECKO_API_PLAN` = paid | **$35** if enabled | Keep on free/demo unless commercial crypto display is needed |
| **Magic MCP (21st.dev)** | Dev tool subscription | n/a (dev only) | — |

**Net (since 2026-10-19):** **$5 Workers Paid + ~$0–1 container usage + $0 Supabase + $0
Railway** ≈ **$5–6/mo**, with a hard worst case around $12/mo even if something kept the
backend awake all month.

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

## 3. Cloudflare — watch the Containers, the rest is free (studio sandboxes)

- **studio-worker Containers** (`standard-3` = 2 vCPU / 8 GiB, max 50 instances) are the
  **only Cloudflare resource that is not free.** They cost per running instance.
  - Ensure sandboxes **stop** when done (the worker has `stop`; confirm idle auto-stop).
  - ✅ **`max_instances` lowered 50 → 3** (`studio-worker/wrangler.jsonc`, 2026-06-16) to
    cap the worst-case Container bill for single-user scale. Raise only if concurrent
    Studio usage needs it.
  - If the Studio feature isn't in active use, consider not deploying studio-worker.
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
**estimated** (Code Studio sandbox from `studio_runs` awake time × standard-3 prices,
25% CPU assumed; backend container ~$0.50) or **fixed** (Workers Paid $5, spread per day).
Revenue counts only paid tiers with a Stripe subscription (admin-comped accounts are
shown as "comped", not MRR). Per-Worker requests/CPU and R2 size appear once
`CF_ANALYTICS_API_TOKEN` (Account › Account Analytics › Read) and `CLOUDFLARE_ACCOUNT_ID`
are set on the `dreamstream-api` Worker or in D1 `backend_env`.

Then run this once a month (or when a bill looks off):

- [ ] Cloudflare: backend container (`dreamstream-api-backend`) shows 0 running instances
      when idle; Containers usage in Billing stays near the included amounts.
- [ ] Backend: `REDIS_URL` **unset** (no D1 row / var for it); nothing pings `/api/*` on a timer.
- [ ] Railway: still dormant (no surprise plan upgrade); no services in `RUNNING` state.
- [ ] Cloudflare: studio-worker Containers idle/stopped; `max_instances` sane.
- [ ] Cloudflare: R2 `dreamstream-live` size near zero (janitor working).
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
