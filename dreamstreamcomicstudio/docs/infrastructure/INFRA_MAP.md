# Infrastructure & Dependency Map — DreamStream Comic Studio

**Status:** Authoritative. This is the single source of truth for what cloud
infrastructure exists, what depends on what, and where money is spent.
**Last verified:** 2026-06-16 (against live Railway / Supabase / Cloudflare APIs +
repo config). **Maintain this:** whenever you add/remove a service, worker, binding,
external API, or MCP server, update this file and `ENV_MATRIX.md` in the same PR.
See `COST_RUNBOOK.md` for the optimization playbook.

> **Provenance:** every row below was cross-checked against the live cloud APIs
> (not just the docs) on the verify date. Anything that is *target design, not
> current state* is called out explicitly in §10.

---

## 0. Topology in one line

```
Browser
  → Cloudflare Pages (comic2.pages.dev / dreamstreamstudio.ai)            [frontend, ~free]
  → /api/*  →  dreamstream-api Worker  →  Railway Express backend          [the only paid always-on box]
                  backend → Supabase  (Postgres + Auth + Storage)          [free tier]
                  backend → LLM providers (OpenRouter / NVIDIA / Gemini / BYOK)
                  backend → data-connector APIs (budget-metered)
                       ↳ Yahoo / Stooq / FiscalData → dreamstream-data-egress Worker
                  backend → dreamstream-studio Worker (HMAC) → container sandboxes
                  backend → dreamstream-email Worker (HMAC) → Cloudflare Email
  /live-api/* → dreamstream-live Worker → EventRoom Durable Object + R2 (dreamstream-live)
  Supabase Auth "Send Email Hook" → dreamstream-email /auth-hook
```

**The Railway Express backend is the only paid always-on service.** Cloudflare
Pages + the 5 Workers + Supabase are effectively free at single-user scale. **100% of
the historically "insane" bills traced to Railway compute** (memory held 24/7 — see
`COST_RUNBOOK.md` §1).

---

## 1. Live cloud inventory (verified 2026-06-16)

### Railway (account: Akhielesh, personal workspace — 7 projects)

| Project | Service(s) | State | Notes |
|---|---|---|---|
| **hospitable-enthusiasm** | **Comic2** (backend) | ✅ running, App-Sleeping **ON** | The DreamStream backend. Domain `comic2-production.up.railway.app` (port 8080), custom `dreamstreamstudio.ai`. |
| hospitable-enthusiasm | **SearXNG** | ✅ running, App-Sleeping **ON** | Optional private search backend; Comic2 degrades to public instances without it. |
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
| Workers (DreamStream) | **5**: `dreamstream-api`, `dreamstream-data-egress`, `dreamstream-live`, `dreamstream-email`, `dreamstream-studio` |
| Workers (other, NOT in this repo) | `akhieleshpersonalwebsite`, `atlasd` — separate projects on the same account |
| R2 buckets | **1**: `dreamstream-live` (ENAM, Standard) — live-stream segments only |
| D1 | **1**: `akhielesh-portfolio-analytics` (12 tables, ~2 MB) — **unrelated to DreamStream** |
| KV namespaces | **0** |
| Durable Objects | `EventRoom` (live-worker), `Sandbox` (studio-worker) — both SQLite |
| Pages | `comic2.pages.dev` + `dreamstreamstudio.ai` (frontend) |

---

## 2. Cloudflare Workers — detail (routes + bindings)

All 5 are `compatibility_date: 2026-01-01`. Routes are carved out of the
`dreamstreamstudio.ai` zone (a Worker route beats Pages on matching paths).
**No Workers cron triggers, no Queues, no service bindings anywhere.**

| Worker | Repo dir | Route | Bindings | Purpose |
|---|---|---|---|---|
| **dreamstream-api** | `api-proxy/` | `dreamstreamstudio.ai/api/*` | var `BACKEND_ORIGIN` → Railway | Same-origin reverse proxy to the Railway backend; sets `X-Forwarded-For` from `CF-Connecting-IP`; pass-through (no auth); 502 if backend down. **This is what makes the Pages frontend talk to Railway same-origin.** |
| **dreamstream-live** | `live-worker/` | `dreamstreamstudio.ai/live-api/*` | DO `EVENT_ROOM` (`EventRoom`), R2 `LIVE_BUCKET` (`dreamstream-live`), var `ALLOWED_ORIGINS` | Live-stream API. R2 segment rail (zero egress). EventRoom DO = chat/presence/lobby/moderation/WebRTC signaling. DO **alarm** janitor purges segments @24h, recordings @7d (keeps R2 bounded). |
| **dreamstream-studio** | `studio-worker/` | `*.dreamstreamstudio.ai/*` (wildcard previews) | DO `Sandbox` (`@cloudflare/sandbox`), **Container `standard-3` = 2 vCPU / 8 GiB, max 3** (capped from 50 on 2026-06-16), secret `STUDIO_HMAC_SECRET`, var `STUDIO_PREVIEW_DOMAIN`, optional `CLOUDFLARE_API_TOKEN`/`VERCEL_TOKEN` | Per-user code sandbox/container. HMAC-signed control POSTs from the backend (`STUDIO_WORKER_URL`): `launch`/`deploy`/`logs`/`stop`. ⚠️ **Containers are the one Cloudflare cost that is NOT free** — see `COST_RUNBOOK.md` §3. |
| **dreamstream-email** | `email-worker/` | none (`*.workers.dev`) | `send_email` binding `EMAIL`, secrets `EMAIL_HMAC_SECRET` + `SUPABASE_AUTH_HOOK_SECRET`, vars `EMAIL_FROM`/`SUPABASE_VERIFY_URL`/brand | Transactional email. `POST /send` (HMAC `x-email-signature`); `POST /auth-hook` = Supabase Send Email Hook (Standard Webhooks sig). Caps live in backend config (200/day, 2500/mo). |
| **dreamstream-data-egress** | `data-egress/` | `dreamstreamstudio.ai/egress/*` | optional secret `EGRESS_SHARED_SECRET` | HTTPS GET relay for **exactly 3 allowlisted hosts** (Yahoo Finance, Stooq, Treasury FiscalData) when the backend's datacenter IP is blocked. `x-egress-key` equality gate. Load-bearing for finance widgets. |

> **`dreamstream-live` `ALLOWED_ORIGINS`** was tightened from `"*"` to the known
> frontends (`https://dreamstreamstudio.ai,https://comic2.pages.dev`) on 2026-06-16
> (security finding H4). Append any new custom/preview origin that needs the live API.

---

## 3. Railway backend — what it is and why it costs

- **Build/deploy** (`railway.json` + root `Dockerfile`): `DOCKERFILE` builder; `node:20-slim`;
  `npm ci` + `npm run build:server`; start `npm run start:server`; **EXPOSE 7071** (served
  on 8080 via Railway), healthcheck `/api/health`, restart on-failure max 5.
- **Memory cap:** `NODE_OPTIONS=--max-old-space-size=512` (Dockerfile) bounds the V8 heap.
- **What holds memory 24/7 (= the dominant cost):**
  - **Pyodide** (`server/src/services/pyodideRunner.ts`) — CPython-in-WASM, one reused
    instance, packages loaded **on demand** (`loadPackagesFromImports`). WASM linear memory
    never shrinks → eager preloading pandas/numpy would permanently pin ~500 MB. **Never
    re-add eager preload.**
  - `sharp` (image processing), in-process model catalog (~440 KB JSON), Express + routers.
- **Cost posture:** App-Sleeping **ON** (scales to zero when idle); **no Redis** on the
  backend (`REDIS_URL` unset — a live Redis adds an always-on charge *and* keeps the box
  awake); background timers (`providerUsage` flush, `modelCatalog` refresh) are `.unref()`'d
  and idle-silent so the box can actually sleep.
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
- Optional self-hosted studio-tools sidecars (`deploy/studio-tools/docker-compose.yml`):
  Nango + shadcn/Magic UI MCPs over supergateway.

---

## 7. Internal data flows

See the diagram in §0. Notable cross-service calls:
- Pages → `dreamstream-api` proxy → Railway (same-origin `/api/*`).
- Backend → Supabase (service-role) for tables/auth/storage.
- Backend → finance APIs, with Yahoo/Stooq/FiscalData failover via `data-egress`.
- Backend → `studio-worker` (HMAC) for container previews; → `email-worker` (HMAC) for mail.
- `live-worker` → EventRoom DO + R2 for live segments.
- Supabase Auth "Send Email Hook" → `email-worker` `/auth-hook`.

---

## 8. Deploy topology

Production branch **`Dreamstrream-v1`** (note the triple-r — it is the real branch name).
- **Frontend** → Cloudflare Pages builds from `Dreamstrream-v1` (`vite build`).
  `vercel.json` SPA rewrite present (legacy/alt host).
- **Backend** → Railway builds from `Dreamstrream-v1` via root Dockerfile.
- **5 Workers** → GitHub Actions in **root** `.github/workflows/deploy-*.yml`, triggered on
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

- **Ventures/Autopilot** — OFF by default (`VENTURES_ENABLED=false`). Large inert code
  surface (`server/src/ventures/`, 8 SQL files).
- **Email worker, Turnstile, every data-connector key, Nango, MCP outbound** — dormant
  until their env is set. Check Railway env to see what's actually configured.
- **SearXNG** — optional; Comic2 works without it.
- `atlasd` / `akhieleshpersonalwebsite` Cloudflare workers — **not in this repo.**

---

## 10. What does NOT exist (counter the aspirational docs)

The `docs/studio/autopilot/**` specs describe a rich Workers + Workflows + KV + D1 +
Hyperdrive + Queues platform and a migration off Railway. **None of that is live.** As of
2026-06-16 DreamStream uses: **5 Workers, 1 R2 bucket, 2 Durable Objects, Supabase Postgres,
1 Railway backend.** There is **no KV, no DreamStream D1, no Hyperdrive, no Queues, no
Workflows, no Supabase Edge Functions.** Treat the autopilot specs as target design only.

---

## 11. Change log

| Date | Change |
|---|---|
| 2026-06-16 | Initial authoritative map created from live-infra audit. App-Sleeping enabled on Comic2 + SearXNG. |
