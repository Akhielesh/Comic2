# Infrastructure & Dependency Map — DreamStream Comic Studio

**Status:** Authoritative. This is the single source of truth for what cloud
infrastructure exists, what depends on what, and where money is spent.
**Last verified:** 2026-10-19 (against live Railway / Supabase / Cloudflare APIs +
repo config; backend moved Railway → Cloudflare Containers that day). **Maintain this:** whenever you add/remove a service, worker, binding,
external API, or MCP server, update this file and `ENV_MATRIX.md` in the same PR.
See `COST_RUNBOOK.md` for the optimization playbook.

> **Provenance:** every row below was cross-checked against the live cloud APIs
> (not just the docs) on the verify date. Anything that is *target design, not
> current state* is called out explicitly in §10.

---

## 0. Topology in one line

```
Browser
  → Cloudflare Pages: dreamstreamstudio.ai                                 [frontend, ~free]
      (comic2.pages.dev + www 301 to it; previews <hash>.comic2.pages.dev serve)
  → /api/*  →  dreamstream-api Worker  →  Backend Container (Express)     [billed only while awake]
                  (BACKEND_TARGET=origin → Railway instead: dormant fallback)
                  backend → Supabase  (Postgres + Auth + Storage)          [free tier]
                  backend → LLM providers (OpenRouter / NVIDIA / Gemini / BYOK)
                  backend → data-connector APIs (budget-metered)
                       ↳ Yahoo / Stooq / FiscalData → dreamstream-data-egress Worker
                  backend → dreamstream-email Worker (HMAC) → Cloudflare Email
  /live-api/* → dreamstream-live Worker → EventRoom DO + R2 (dreamstream-live)
                                       → MonitorRoom DO (baby monitor: signaling, alerts, Web Push)
                                       → Supabase RPCs (member check, nursery roles)
  Supabase Auth "Send Email Hook" → dreamstream-email /auth-hook
```

**There is no paid always-on service any more.** Since 2026-10-19 the Express backend
runs as a Cloudflare Container that boots on the first request and sleeps 15 min after
the last one (billed only while awake, against the Workers Paid plan's included usage).
**100% of the historically "insane" bills traced to Railway compute** (memory held 24/7 —
see `COST_RUNBOOK.md` §1); Railway's trial expired on 2026-10-16 and its deployment was
removed, which is what prompted the move. Railway stays configured as a dormant fallback
(§3a).

---

## 1. Live cloud inventory (verified 2026-06-16; Railway + Cloudflare rows 2026-10-19)

### Railway (account: Akhielesh, personal workspace — 7 projects)

| Project | Service(s) | State | Notes |
|---|---|---|---|
| **hospitable-enthusiasm** | **Comic2** (backend) | ⛔ **dormant** — trial expired, deployment removed 2026-10-16 | Former DreamStream backend, replaced by the Cloudflare `Backend` container. Config, variables, `railway.json` + root `Dockerfile` kept for a possible return (§3a). Domain `comic2-production.up.railway.app`. |
| hospitable-enthusiasm | **SearXNG** | ⛔ dormant (trial expired) | Optional private search backend; was never wired (`SEARXNG_URL` unset). |
| autojobapply | Postgres, applypilot | ⛔ stopped / failed | Dead since May. 0.81 GB Postgres volume remains. |
| mineral-atlas | web | ❌ failed | Dead since Apr. |
| oil-intelligence-platform | web | ❌ failed | Dead since Mar. |
| sourcevault-data-brain-ui | ui | ❌ failed | Dead since May. |
| joyful-flow | AtlasD, AtlasD-beta, Redis, Redis-PcL_, Redis-f8qS | ⛔ stopped / failed | **AtlasD = keep.** 3 stray Redis (0.15 GB each) + duplicate AtlasD-beta. |
| observant-bravery | AtlasD | ❌ failed | Duplicate AtlasD copy. |

> ⚠️ **Gotcha (corrects a common mistake):** the backend's Railway **project is named
> `hospitable-enthusiasm`**, and the **service** inside it is named `Comic2`. There is no
> project literally called "comic2". The cost-control runbook (`update_service
> sleep_application=true`) **does** work against it — it was executed successfully on
> 2026-06-16. Project ID `c3320fd3-b01e-4d59-95ec-3408a65446c9`, env `production`
> (`3283480e-…`), service `dccc0663-…`.

### Supabase (org plan: **free** → $0)

| Item | Value |
|---|---|
| Active project | **"Comic"** ref `bdjfmxfmhqhzvgrhbbzm`, region `us-west-2`, `ACTIVE_HEALTHY` |
| Tables | ~90 (public schema), all RLS-enabled. Heaviest rows: `token_ledger_entries` 2392, `artifacts` 1000, `connector_items` 987, `image_assets` 602, `model_catalog_cache` 479, `provider_usage_log` 454. |
| Storage bucket | `comic-assets` (public; WebP via sharp; service-role writes) |
| Edge functions | **none** (email runs on the Cloudflare email-worker) |
| Other projects | 9 more, all `INACTIVE` (free-tier auto-pause) — D&D, NovaPDF, Desk, Data Profiler, Global Financial, Sudoku, Budget, **AtlasD**, Comic. |

### Cloudflare (account: akhielesh)

| Item | Value |
|---|---|
| Plan | **Workers Paid** ($5/mo) — required for Containers (the `Backend` container in `dreamstream-api`). |
| Workers (DreamStream) | **4**: `dreamstream-api` (+ the backend container), `dreamstream-data-egress`, `dreamstream-live`, `dreamstream-email` (`dreamstream-studio` retired 2026-10-22, see §2) |
| Containers | `Backend` (dreamstream-api, `basic` 1/4 vCPU · 1 GiB · 4 GB, max 2) — the Express backend |
| Workers (other, NOT in this repo) | `akhieleshpersonalwebsite`, `atlasd` — separate projects on the same account |
| R2 buckets | **1**: `dreamstream-live` (ENAM, Standard) — live-stream segments only |
| D1 | **2**: `dreamstream-backend-env` (id `16181ceb-…`, WNAM) — the backend's secrets, table `backend_env(name, value, source, updated_at)`, read by the `Backend` container at start (binding `BACKEND_ENV`); and `akhielesh-portfolio-analytics` (owner's portfolio analytics), of which DreamStream uses only the `agent_visits` / `agent_checkins` tables (AI-agent gate log, shared across the owner's sites via a `site` column) through the `dreamstream-api` binding `AGENT_DB`. |
| KV namespaces | **0** |
| Durable Objects | `EventRoom` + `MonitorRoom` (live-worker), `Backend` (api-proxy, container-backed) — all SQLite |
| Pages | `dreamstreamstudio.ai` (frontend). `comic2.pages.dev` (the production alias) and `www.` only **301** to it, keeping path + query (2026-10-22: one host, one sign-in — sessions are per host); preview/branch deploys (`<hash>.comic2.pages.dev`) still serve. **Pages Functions:** one middleware (`functions/_middleware.ts`) — those host redirects, then the page half of the AI-agent gate; `public/_routes.json` keeps it off static assets so it only runs on page loads. **Static AI model:** `/models/yamnet/yamnet-v1.onnx` (16 MB, Apache-2.0, cached `immutable`) + ONNX Runtime WASM in `/assets` (13 MB / 24 MB, under Pages' 25 MiB file limit) — the baby monitor's on-device sound model (`docs/features/baby-monitor.md`). |

---

## 2. Cloudflare Workers — detail (routes + bindings)

All 4 are `compatibility_date: 2026-01-01`. Routes are carved out of the
`dreamstreamstudio.ai` zone (a Worker route beats Pages on matching paths).
**No Workers cron triggers, no Queues, no service bindings anywhere.**

| Worker | Repo dir | Route | Bindings | Purpose |
|---|---|---|---|---|
| **dreamstream-api** | `api-proxy/` | `dreamstreamstudio.ai/api/*` (+ `dreamstream-api.akhieleshsrirangam.workers.dev`) | **Container** `Backend` via DO `BACKEND`; D1 `BACKEND_ENV` → `dreamstream-backend-env` (secrets); D1 `AGENT_DB` → `akhielesh-portfolio-analytics` (agent log only); vars `BACKEND_TARGET` (`container`\|`origin`), `BACKEND_ORIGIN` (Railway, dormant) + the backend's non-secret config | Same-origin front door **and host** of the Express backend: forwards `/api/*` to the single `Backend` container instance (`src/backend.ts`; boots on demand, sleeps after 15 min idle); sets `X-Forwarded-For` from `CF-Connecting-IP`; pass-through (no auth); retryable 503 JSON while the container starts or if it can't. Every string var/secret on the Worker (except `BACKEND_*`) becomes container env, merged over the D1 rows (`src/backendEnv.ts`). Also the **AI-agent gate** (2026-10): answers `/api/agent-gate` (check-in page) and `/api/agent-gate/checkin` (50 questions / answers) itself, and returns 403 to known AI agents on every other `/api/*` — so agents never reach or wake the backend. Visits + answers are logged to `agent_visits` / `agent_checkins` with `site = dreamstreamstudio.ai`. |
| **dreamstream-live** | `live-worker/` | `dreamstreamstudio.ai/live-api/*` | DO `EVENT_ROOM` (`EventRoom`), DO `MONITOR_ROOM` (`MonitorRoom`), R2 `LIVE_BUCKET` (`dreamstream-live`), vars `ALLOWED_ORIGINS`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`; optional secrets `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` | Live-stream API. R2 segment rail (zero egress). EventRoom DO = chat/presence/lobby/moderation/WebRTC signaling; creating an event requires a signed-in Live member (Supabase RPC check). MonitorRoom DO = the **baby monitor** (2026-10): P2P WebRTC signaling between a camera device and viewers (video never touches the server and is never recorded), sound/vision/offline alerts, incidents with on-duty routing + escalation, sleep tracking, Web Push (VAPID keys generated and kept in the DO), history in the DO's own SQLite (events 90 d, per-minute sound/motion rows 31 d, incidents, sleep sessions) and `GET /api/monitor/:nid/export` (CSV, bearer token); every socket is authorised against `monitor_my_role` in Supabase. DO **alarm** janitor purges segments @24h, recordings @7d (keeps R2 bounded). |
| **dreamstream-email** | `email-worker/` | none (`*.workers.dev`) | `send_email` binding `EMAIL`, secrets `EMAIL_HMAC_SECRET` + `SUPABASE_AUTH_HOOK_SECRET`, vars `EMAIL_FROM`/`SUPABASE_VERIFY_URL`/brand | Transactional email. `POST /send` (HMAC `x-email-signature`); `POST /auth-hook` = Supabase Send Email Hook (Standard Webhooks sig). Caps live in backend config (200/day, 2500/mo). |
| **dreamstream-data-egress** | `data-egress/` | `dreamstreamstudio.ai/egress/*` | optional secret `EGRESS_SHARED_SECRET` | HTTPS GET relay for **exactly 3 allowlisted hosts** (Yahoo Finance, Stooq, Treasury FiscalData) when the backend's datacenter IP is blocked. `x-egress-key` equality gate. Load-bearing for finance widgets. |

> **`dreamstream-studio` is retired** (Code Studio's sandbox Worker: `*.dreamstreamstudio.ai/*`
> previews, Container `Sandbox` on `standard-3`). Its code (`studio-worker/`) and deploy workflow
> were removed with ADR 0005 on 2026-10-22. Owner step: delete the deployed Worker and its route in
> Cloudflare if they still exist, and the `STUDIO_HMAC_SECRET` Worker secret / D1 `backend_env` row.
> The `studio_*` Supabase tables stay as history (the Cost centre still reads `studio_runs`).

> **`dreamstream-live` `ALLOWED_ORIGINS`** was tightened from `"*"` to the known
> frontends (`https://dreamstreamstudio.ai,https://comic2.pages.dev`) on 2026-06-16
> (security finding H4). Append any new custom/preview origin that needs the live API.
> `comic2.pages.dev` stays only for tabs opened before that host started redirecting
> (2026-10-22); drop it in a later cleanup.

---

## 3. The backend — Cloudflare Container (since 2026-10-19)

- **Image** (`Dockerfile.cloudflare`, built and pushed by `wrangler deploy` in
  `.github/workflows/deploy-api-proxy.yml`): the Express server is **bundled with esbuild into
  one `server.mjs`**; only `sharp`, `pyodide` and `sql.js` (native / WASM assets) are installed
  in the runtime stage. ≈450 MB image, ~50 MB of dependencies (vs 1.2 GB for the repo-wide
  `npm ci`), boots in ~1 s at ~90 MB RSS. Runs as the `node` user on port 8080.
- **Instance:** `basic` (1/4 vCPU, 1 GiB, 4 GB disk), placed near its Durable Object, one instance (the proxy
  always addresses `primary`), `max_instances: 2` for rollouts. `sleepAfter: 15m`.
- **Env:** non-secret config = `vars` in `api-proxy/wrangler.jsonc`; secrets = rows in D1
  `dreamstream-backend-env` (copied from Railway on 2026-10-19) or Worker secrets (which
  override D1). Read once per container start — a secret change applies at the next cold start
  (or redeploy). Promote a D1 secret to a real Worker secret any time: set it in the dashboard
  (Workers → dreamstream-api → Settings → Variables and Secrets), then delete its D1 row.
- **Deploy:** push to `Dreamstrream-v1` touching `api-proxy/**`, `server/**`, `shared/**`,
  `apiTypes.ts`, `toolCatalog.ts`, `types.ts`, root `package*.json`, `Dockerfile.cloudflare` or
  `.dockerignore`. The workflow polls `/api/health` on workers.dev for up to ~5 min.
- **Memory cap:** `NODE_OPTIONS=--max-old-space-size=512` bounds the V8 heap (both Dockerfiles).

### 3a. Returning to Railway (kept dormant on purpose)

Nothing Railway-specific was deleted: `railway.json`, the root `Dockerfile`, the Comic2 service
and all its variables still exist. To switch back: (1) get the Railway plan active and redeploy
the Comic2 service (it auto-deploys from `Dreamstrream-v1`); (2) set `"BACKEND_TARGET": "origin"`
in `api-proxy/wrangler.jsonc` (`BACKEND_ORIGIN` already points at
`comic2-production.up.railway.app`) and push. Also restore `EMAIL_PUBLIC_BASE_URL` /
`GOOGLE_OAUTH_REDIRECT_URL` on Railway if you want them on the Railway domain (both work
through `dreamstreamstudio.ai` either way). Switching back to Cloudflare is the reverse var.

**Before you lift Railway's usage limit for any reason** (for example to download the old Adminak
database from its volume), know that Railway then restarts everything it was running, and the old
Comic2 service is still wired to build from `Dreamstrream-v1`: it would rebuild on every push and
bill next to the Cloudflare container even though no traffic reaches it. To keep Railway parked,
first, in the Railway dashboard (menu names may differ slightly), for each of `Comic2` and
`SearXNG` (project `hospitable-enthusiasm`) and `adminak` (project `adminak`): open the service and
either **Settings → Source → Disconnect** (stops building from GitHub) or **Deployments → ⋯ → Remove**
on the latest deployment (stops running it). Then lift the limit. Adminak itself moved to a Cloudflare
Container in 2026-10 (`adminak/` in `Akhielesh/Akhielesh`); the site Worker falls back to
`ADMINAK_ORIGIN` if its service binding is removed, which is how it would point back at Railway.

### What holds memory while awake (unchanged from the Railway era)
- **What holds memory 24/7 (= the dominant cost):**
  - **Pyodide** (`server/src/services/pyodideRunner.ts`) — CPython-in-WASM, one reused
    instance, packages loaded **on demand** (`loadPackagesFromImports`). WASM linear memory
    never shrinks → eager preloading pandas/numpy would permanently pin ~500 MB. **Never
    re-add eager preload.**
  - `sharp` (image processing), in-process model catalog (~440 KB JSON), Express + routers.
- **Cost posture:** the container sleeps 15 min after the last *request* (outbound traffic
  doesn't keep it awake, unlike Railway App-Sleeping); **no Redis** on the backend
  (`REDIS_URL` unset — a live Redis is an extra always-on bill); background timers
  (`providerUsage` flush, `modelCatalog` refresh) are `.unref()`'d and idle-silent.
- **Ephemeral disk:** like Railway (no volume), nothing on local disk survives a sleep — all
  durable state is in Supabase.
- **Optional separate processes** (`ventures:worker`, `connectors:worker`) — these *do*
  need Redis (BullMQ). **They are not run by default** and must never be folded into the
  always-on backend (that would defeat App-Sleeping). This reconciles the apparent
  "No Redis" vs "REDIS_URL optional" contradiction in the older docs: **Redis is forbidden
  on the always-on backend; it is required only if you separately run the worker processes.**

---

## 4. Supabase usage

- **Client split** (`server/src/services/supabase.ts`): the **anon** client is used *only*
  for JWT validation (`auth.getUser`); the **service-role** client (`getSupabaseAdmin()`,
  `SUPABASE_SERVICE_ROLE_KEY`) is the workhorse (~43 call sites). Frontend uses the anon
  client for Auth + owner-scoped tables only.
- **Auth:** `requireAuth` validates Bearer JWT; `optionalAuth` fails open. Username login via
  DB triggers (`resolve_email_from_username`).
- **Schema:** 40 idempotent `server/sql/*.sql` files, applied **manually** (no runner).
  Several tables predate their SQL files (`user_settings`, `projects`, `profiles`,
  `studio_runs`, `user_api_keys`) — reconcile against live, don't assume a blank slate.
- **Storage:** single `comic-assets` bucket via **service-role only** (`imageStorage.ts`).
  The backend uses **Supabase Storage** for assets, **not R2** (R2 is live-worker only).
- **RLS:** every table has RLS on, in three tiers — owner-scoped (client-direct OK),
  public-read, and service-role-only (`revoke all from anon, authenticated`).

---

## 5. External API / provider dependency map

Central env map: `server/src/config.ts`. Provider registry: `server/src/ai/gateway.ts`,
`shared/providers.ts`. BYOK resolution: a user-supplied key wins (flagged `byok:true`);
otherwise the platform env key funds the call. Full var→consumer table in `ENV_MATRIX.md`.

### LLM / text
OpenRouter (`OPENROUTER_API_KEY` ← `DREAMSTREAMSTUDIO_ALL`) is the effective default
gateway and reports per-call USD. Also NVIDIA (`NVIDIA_API_KEY`), OpenAI, Anthropic,
Gemini (`GEMINI_API_KEY`/`ASSISTANT_GEMINI_API_KEY`), DeepSeek, Z.AI, MiniMax, Tencent
Hunyuan, xAI — all optional / BYOK. Key-pooling + circuit breaker for OpenRouter/NVIDIA.

### Image generation
Pixazo/Flux (`PIXAZO_API_KEY`), Ideogram (`IDEOGRAM_API_KEY`), Gemini image, NVIDIA image.

### Data connectors (all optional; degrade honestly)
- **Web search chain** (`ai/tools/search.ts`): Tavily → Brave → Serper → Google CSE →
  **SearXNG** (`SEARXNG_URL`) → DuckDuckGo → Bing → Wikipedia. **Works with zero keys.**
- **Finance:** US equities Yahoo → Alpaca IEX → Stooq; crypto CoinGecko
  (`COINGECKO_API_KEY` + `COINGECKO_API_PLAN` — **Basic is $35/mo** for commercial display);
  FX Frankfurter/ECB (keyless); macro Treasury FiscalData (keyless), FRED (`FRED_API_KEY`),
  Finnhub (`FINNHUB_API_KEY`).
- **Weather/geo/places/travel:** MET Norway → Open-Meteo; Nominatim; Foursquare → OSM
  Overpass; Amadeus flights; OSRM; IPinfo → ip-api; Jina Reader.
- **Other keys in code (not yet in the 58-var set):** `NASA_API_KEY`, `GITHUB_TOKEN`,
  `YOUTUBE_API_KEY`, `NANGO_SECRET_KEY`/`NANGO_HOST`.

### Cost guardrails (well-architected — keep these)
- **Per-provider budgets** (`lib/providerUsage.ts`): per-minute + per-day caps under each
  free tier; breach → `ProviderBudgetError` → tool degrades to the next provider, never
  burning quota. Override via `PROVIDER_BUDGETS` JSON.
- **Platform USD allowance** (`services/platformAllowance.ts`):
  `PLATFORM_MONTHLY_ALLOWANCE_USD` (default **$5/user/mo**) caps only platform-funded
  providers (`openrouter`, `gemini`, `nvidia`); BYOK never counts; fails open.
- Account-wise usage logged to Supabase `provider_usage_log` (60 s flush);
  `GET /api/usage/providers`.

### Data-egress relay
`fetchDirectThenEgress` retries the 3 allowlisted finance hosts through
`dreamstream-data-egress` (gated by `DATA_EGRESS_URL` + `DATA_EGRESS_SECRET`).
Frankfurter/CoinGecko do **not** route through it.

---

## 6. MCP servers

**Repo dev/agent harness** (`.mcp.json`) — only 2:
- **magic** — `npx @21st-dev/magic@latest`, needs `MAGIC_API_KEY` (21st.dev UI builder).
- **railway** — `npx @railway/cli mcp`, needs `RAILWAY_API_TOKEN` (must be an
  **Account/Team** token, not a project token).

> The Supabase / Cloudflare / GitHub / Figma MCP servers you may see in a Claude Code
> session come from the **web environment**, not this repo's `.mcp.json`.

**App runtime MCP layer** (different thing — the product's own feature):
- MCP **client** (`ai/tools/mcpClient.ts`) with ~13 curated servers (`mcpCatalog.ts`:
  Context7, HuggingFace, Cloudflare, DeepWiki, …).
- Outbound MCP **endpoint** `/api/connect`, gated by `MCP_OUTBOUND_TOKEN`.
- Optional self-hosted agent-tool sidecars for chat (`deploy/studio-tools/docker-compose.yml`):
  Nango + shadcn/Magic UI MCPs over supergateway.

---

## 7. Internal data flows

See the diagram in §0. Notable cross-service calls:
- Pages → `dreamstream-api` Worker → `Backend` container (same-origin `/api/*`).
- Backend → Supabase (service-role) for tables/auth/storage.
- Backend → finance APIs, with Yahoo/Stooq/FiscalData failover via `data-egress`.
- Backend → `email-worker` (HMAC) for mail.
- `live-worker` → EventRoom DO + R2 for live segments; → MonitorRoom DO for the baby monitor;
  → Supabase RPCs (`live_me`, `monitor_my_role`) with the caller's JWT.
- Supabase Auth "Send Email Hook" → `email-worker` `/auth-hook`.

---

## 8. Deploy topology

Production branch **`Dreamstrream-v1`** (note the triple-r — it is the real branch name).
- **Frontend** → Cloudflare Pages builds from `Dreamstrream-v1` (`vite build`).
  `vercel.json` SPA rewrite present (legacy/alt host).
- **Backend** → `deploy-api-proxy.yml` builds `Dockerfile.cloudflare` and deploys it with the
  `dreamstream-api` Worker. (Railway's auto-deploy from `Dreamstrream-v1` is dormant — trial
  expired; see §3a.)
- **4 Workers** → GitHub Actions in **root** `.github/workflows/deploy-*.yml`, triggered on
  push to `Dreamstrream-v1` (path-filtered) + `workflow_dispatch`; secrets
  `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.
- **CI** (`ci.yml`): PR typecheck + build + tests (fake Supabase env).
- **Scheduled (GitHub cron, not Railway):** root mirrors `refresh-model-catalog` (hourly :30)
  + `probe-nvidia-availability` (daily 06:15).

> ⚠️ **CI gotcha:** GitHub only scans **root** `.github/workflows/`. The extra scheduled
> jobs defined under `dreamstreamcomicstudio/.github/workflows/` (daily-pricing,
> daily-billing, verification, auto-fix, post-merge-verify) **do not run** unless mirrored
> to root. Today only `refresh-model-catalog` + `probe-nvidia-availability` are mirrored.

---

## 9. Dormant / off-by-default (verify before assuming it runs)

- **Ventures/Autopilot** — admin-only (`VENTURES_ENABLED=false` in `wrangler.jsonc`; admins
  still get in) and no tick loop (`VENTURES_PILOT_INLINE=false`). Its build stage was retired
  with Code Studio (ADR 0005): a tick only pauses a venture. `server/src/ventures/`, 8 SQL files,
  all venture tables empty. See `docs/ventures/README.md`.
- **Email worker, Turnstile, every data-connector key, Nango, MCP outbound** — dormant
  until their env is set. Check `api-proxy/wrangler.jsonc` vars + the D1 `backend_env` rows to
  see what's actually configured.
- **SearXNG** — optional; the backend works without it (`SEARXNG_URL` unset).
- **Railway** — dormant fallback host (§3a); not serving traffic.
- `atlasd` / `akhieleshpersonalwebsite` Cloudflare workers — **not in this repo.**

---

## 10. What does NOT exist (counter the aspirational docs)

The `docs/ventures/**` specs describe a rich Workers + Workflows + KV + D1 +
Hyperdrive + Queues platform. **None of that is live** (the move off Railway happened, but
as a straight container lift, not that redesign). As of 2026-10-22 DreamStream uses: **4
Workers, 1 Container (`Backend`), 1 R2 bucket, 3 Durable Object classes, 1
DreamStream-owned D1 (`dreamstream-backend-env`, secrets only), Supabase Postgres** (plus the
shared agent-log D1 tables above). There is **no KV, no Hyperdrive, no Queues, no Workflows,
no Supabase Edge Functions.** Treat the autopilot specs as target design only.

---

## 11. Change log

| Date | Change |
|---|---|
| 2026-06-16 | Initial authoritative map created from live-infra audit. App-Sleeping enabled on Comic2 + SearXNG. |
| 2026-10-02 | AI-agent gate: Pages middleware (`functions/_middleware.ts`, `public/_routes.json`) + `dreamstream-api` handles `/api/agent-gate*` and 403s AI agents at the edge; D1 binding `AGENT_DB` (shared agent log). `robots.txt` (Content-Signal: search=yes, ai-train=no, ai-input=no) + `llms.txt`. |
| 2026-10-19 | **Backend moved Railway → Cloudflare Containers** (`Backend` class in `dreamstream-api`, `Dockerfile.cloudflare`, D1 `dreamstream-backend-env` for secrets, `BACKEND_TARGET` switch; Railway kept dormant). Live worker gained `MonitorRoom` (baby monitor) + Supabase member checks. |
| 2026-10-20 | Baby monitor v2: on-device AI sound model served from Pages (`/models/*`, excluded from Pages Functions), MonitorRoom sound events / video-call commands / per-category push kinds. No new paid resources. |
| 2026-10-21 | Baby monitor guests + tracker: MonitorRoom SQLite gains `mon_shares` / `mon_guests` (share link + PBKDF2 passcode, hashed guest passes) and `mon_track` (baby tracker, 3-year retention); new public route `POST /api/monitor/:nid/guest` (rate-limited, lockouts inside the room). No new paid resources. |
| 2026-10-21 | Baby monitor v3: MonitorRoom moved its log from KV-style storage to its SQLite (`monitorStore.ts`: events, minutes, incidents, sleep; one-time migration of the old log), DO alarm drives incident escalation + retention purge, new `/api/monitor/:nid/export` route, `public/keep-awake.mp4` (2 KB) for the screen-on fallback. No new paid resources (DO SQLite storage is within the plan's included storage). |
| 2026-10-22 | **Code Studio retired** (ADR 0005): `dreamstream-studio` Worker (Container `Sandbox`, `standard-3`, `*.dreamstreamstudio.ai/*`) removed from the repo with its deploy workflow and `STUDIO_WORKER_URL`; owner deletes the deployed Worker + route + `STUDIO_HMAC_SECRET`. Ventures set admin-only with no tick loop (`VENTURES_ENABLED`/`VENTURES_PILOT_INLINE` = `false`). Workers Paid stays (backend container). |
