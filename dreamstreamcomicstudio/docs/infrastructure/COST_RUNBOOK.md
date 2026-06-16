# Cloud Cost Optimization — Runbook & Playbook

**Status:** Authoritative cost runbook. **Last verified:** 2026-06-16.
**Companion:** `INFRA_MAP.md` (what exists) · `ENV_MATRIX.md` (env vars).
**Maintain this:** update the per-service cost model whenever a service, plan tier, or
paid provider changes.

> **The one-sentence diagnosis from the 2026-06 audit:** *100% of the historically large
> bills were **Railway compute** — always-on backends holding memory 24/7 without
> App-Sleeping, multiplied across the Feb–May era when AtlasD ×3, applypilot, and 3 web
> apps all ran at once. Supabase is on the **free** plan ($0) and Cloudflare is within
> free tier. Fix Railway and the problem is structurally solved.*

---

## 1. Per-service cost model (single-user scale)

| Service | What you pay for | Est. monthly | Lever |
|---|---|---|---|
| **Railway backend (Comic2)** | Memory + CPU held while awake; volume | **~$2–5** with App-Sleeping ON (was $10–30+ when awake 24/7 at 0.5–2.8 GB) | App-Sleeping, Node heap cap, no Redis, lazy Pyodide |
| **Railway plan/seat fee** | Fixed subscription | **$5 (Hobby) or $20 (Pro)** | ⚠️ **Verify your tier** — single-user should be Hobby. This is now likely your *biggest* Railway line item. |
| **Railway dead projects** | Idle volumes only (~1.4 GB total) | **~$0.20** | Delete dead services/volumes (§4) |
| **Cloudflare Pages** | — | **$0** | Free |
| **Cloudflare Workers** | Requests (100k/day free) | **$0–5** | Free tier covers single-user; Workers Paid is $5 if exceeded |
| **Cloudflare Containers (studio-worker)** | vCPU + memory **per running instance** (`standard-3` = 2 vCPU/8 GiB, max 50) | **$0 idle → can spike** | ⚠️ Real cost landmine — see §3 |
| **Cloudflare R2 (dreamstream-live)** | Storage + ops (10 GB free) | **~$0** | Janitor purges segments @24h, recordings @7d |
| **Supabase** | Free plan | **$0** | Stay under 500 MB DB / 1 GB storage / 2 active projects |
| **LLM / AI providers** | Per-token; platform-funded capped at **$5/user/mo** | **variable, capped** | Platform allowance + per-provider budgets (well-architected) |
| **CoinGecko Basic** | Only if `COINGECKO_API_PLAN` = paid | **$35** if enabled | Keep on free/demo unless commercial crypto display is needed |
| **Magic MCP (21st.dev)** | Dev tool subscription | n/a (dev only) | — |

**Net:** with the fixes below, the live monthly cloud bill should be roughly
**Railway plan fee + ~$2–5 usage + $0 Supabase + ~$0 Cloudflare** ≈ **under $25/mo**, and
under ~$10/mo if on Railway Hobby and Cloudflare free tier.

---

## 2. Railway — the only thing that ever cost real money

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

## 3. Cloudflare — watch the Containers, the rest is free

- **studio-worker Containers** (`standard-3` = 2 vCPU / 8 GiB, max 50 instances) are the
  **only Cloudflare resource that is not free.** They cost per running instance.
  - Ensure sandboxes **stop** when done (the worker has `stop`; confirm idle auto-stop).
  - Lower `max_instances` from 50 to a small number (e.g. 2–3) for single-user.
  - If the Studio feature isn't in active use, consider not deploying studio-worker.
- **R2** (`dreamstream-live`): confirm the DO alarm janitor is actually purging (segments
  @24h, recordings @7d) so storage stays near zero. 10 GB free.
- **Workers/DO**: free tier (100k req/day) covers single-user. Workers Paid is a flat $5 if
  you exceed it or need higher DO limits.

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

Run this once a month (or when a bill looks off):

- [ ] Railway: App-Sleeping still **ON** for Comic2 (and SearXNG). `service_metrics` shows
      memory hitting 0 during idle hours.
- [ ] Railway: `REDIS_URL` **unset** on Comic2; no extra always-on services running.
- [ ] Railway: plan tier is the intended one (Hobby for single-user).
- [ ] Railway: no unexpected services in `RUNNING` state (`environment_status` per project).
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
- The Railway backend lives in project **`hospitable-enthusiasm`** (service `Comic2`), not a
  project named "comic2" — don't conclude "the backend is missing" just because the project
  name differs (see `INFRA_MAP.md` §1 gotcha).

---

## 9. Change log

| Date | Change |
|---|---|
| 2026-06-16 | Runbook created. App-Sleeping enabled on Comic2 + SearXNG; dead projects identified; Container cost landmine flagged. |
