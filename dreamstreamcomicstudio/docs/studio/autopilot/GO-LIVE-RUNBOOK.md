# Autopilot — Go-Live & Validation Runbook

> The chosen path: **turn it on and validate against live infra.** Everything is built,
> tested (768 passing), and flag-gated OFF (`VENTURES_ENABLED=false`), so it's inert until
> you flip the flag. This runbook is the exact, ordered path to a working autonomous venture,
> plus how we validate each layer. Owner steps are marked **[OWNER]**; steps Claude drives are
> marked **[CLAUDE]**.

## 0. Prerequisite — the code must be where Railway/Pages build from
The whole ventures layer lives on `claude/gracious-albattani-bDL8T` (draft PR #116). Railway
(backend) + Cloudflare Pages (frontend) build from **`Dreamstrream-v1`**. Because the layer is
**additive + flag-gated OFF** (768 tests green, no regressions, frontend build green), merging it
to production is safe — it does nothing until `VENTURES_ENABLED=true`.

- **[OWNER decision]** Approve merging the inert, flag-gated code into `Dreamstrream-v1`
  (Claude can do the merge — additive, no force-push), **or** point Railway/Pages at the feature
  branch for a first test.

## 1. [OWNER] Environment — set on Railway (backend)

### Option A — Inline pilot (RECOMMENDED, simplest: no second service, no Redis)
Set these three Variables on the **existing backend service** and redeploy:
| Var | Value |
|---|---|
| `OPENROUTER_API_KEY` | a NEW, credit-capped OpenRouter key (server-side only; never sent to browsers) |
| `VENTURES_ENABLED` | `true` |
| `VENTURES_PILOT_INLINE` | `true` |
The API process then ticks active ventures on a timer (`VENTURES_TICK_INTERVAL_MS`, default 60s).
To stop instantly: set `VENTURES_ENABLED=false` (or `VENTURES_KILL=true`) and redeploy. That's it
for validation — skip Option B below.

### Option B — Dedicated worker + Redis (for scale, later)
| Var | Where | Why |
|---|---|---|
| `OPENROUTER_API_KEY` (and/or `NVIDIA_API_KEY`) | Railway | The model key the loop builds with (intake + builds). BYOK pools via `OPENROUTER_API_KEYS`/`NVIDIA_API_KEYS` optional. |
| `REDIS_URL` | Railway | The ventures queue + the shared rate limiter. |
| `VENTURES_ENABLED` | Railway | `true` to turn the loop on (default off). |
| `SUPABASE_SERVICE_ROLE_KEY` | Railway | Already set in prod (image pipeline) — confirm. |
| `STUDIO_WORKER_URL` + `STUDIO_HMAC_SECRET` | Railway | Only needed later for **A5 deploy** (live preview/run). Not needed to validate build (A2–A4). |

- **[OWNER]** Add a **`ventures:worker`** service on Railway running `npm run ventures:worker`
  (separate from the API). It needs the same env (`REDIS_URL`, model key, `VENTURES_ENABLED=true`,
  `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`).

> Migrations are already applied to the Comic Supabase project (ventures_foundation,
> ventures_control_plane, audit_log, increment_venture_spend) — nothing to do there.

## 2. Validation — layer by layer

### 2a. [CLAUDE] Loop smoke test via a seeded venture (no UI/API auth needed)
Once the worker is running with a key, Claude (via the Supabase tools) will:
1. `INSERT` a test venture (`status='active'`) + a `venture_budgets` row (small cap, e.g. $1/day)
   + 2–3 `venture_goals` (`status='proposed'`, e.g. "Build a landing page", "Add an about page").
2. Wait one tick interval, then read back:
   - `venture_events` → expect `tick.started → goal.selected → goal.shipped` (+ `cost_usd`).
   - `venture_goals` → the goal flips `proposed → shipped`, gets a `project_id`.
   - `studio_projects` (`v_<ventureId>`) + `studio_versions` → real generated files saved.
   - `venture_budgets` → `spent_usd_total` incremented atomically.
3. Set the budget cap below spend → confirm the next tick **pauses** the venture
   (`pause_reason='budget'`, `budget.exceeded` event). Flip `VENTURES_KILL`/the admin route →
   confirm the scheduler halts.
**This validates A2 (loop) + A4 (real build) + A0 (brakes) end-to-end against live infra.**

### 2b. [OWNER+CLAUDE] Full UX round-trip
Sign in as an admin at `https://dreamstreamstudio.ai/?view=ventures` → "Draft a venture" from an
idea → confirm the roadmap appears (validates **A3** intake) → Approve roadmap → watch the
activity feed stream builds (validates **A8** console + the live loop) → check the budget meter +
approval queue. Claude cross-checks the DB while you click.

### 2c. [CLAUDE] Reliability + observability
With a key configured, confirm `GET /api/ventures/admin/metrics` shows `ai_request/ai_success`
counters climbing and `venture_tick` outcomes; confirm `/admin/audit` logs the kill/approve actions.

## 3. After validation — finish A5 + A9
- **A5 deploy adapters:** with `STUDIO_WORKER_URL` live, wire SHIP → managed preview (and BYO via
  Nango), gated by the prod-deploy checkpoint. Validate a real preview URL on `*.dreamstreamstudio.ai`.
- **A9 security/GA:** code-safety scan before ship, tenant-isolation audit (`get_advisors` + RLS
  cross-tenant test), abuse/spend-spike auto-pause, then flip GA gating from admin-only → plan-gated.

## 4. Rollback
Everything is reversible: set `VENTURES_ENABLED=false` (or `VENTURES_KILL=true`) to stop the loop
instantly; the layer is additive so nothing else is affected. No data is ever deleted by the loop
(it only inserts/updates its own tables + the per-venture studio project).
