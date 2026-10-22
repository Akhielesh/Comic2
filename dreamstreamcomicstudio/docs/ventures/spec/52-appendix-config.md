# 52 — Appendix A: Configuration & Environment Reference

> Part V · Delivery · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Owner Actions & External Dependencies](./49-owner-actions.md) (who provisions each secret) ·
> [Data Model & Schema](./26-data-model-schema.md) (`venture_budgets`, `user_settings` — the
> DB-side defaults these env vars seed) · [Model Gateway](./29-model-gateway.md) (provider keys) ·
> [Integrations Framework](./30-integrations-framework.md) (Nango + studio-tools MCPs) ·
> [Deploy Adapters](./31-deploy-adapters.md) (adapter tokens) ·
> [Billing & Metering](./41-billing-metering.md) (Stripe) ·
> [Observability](./38-observability.md) (`SENTRY_DSN`, `/metrics`) ·
> [CI/CD & Release](./44-cicd-release.md) (where these are set per environment).
> Ground truth in-repo: `.env.example`, `.env.studio-tools.example`, `server/.env.example`,
> `server/src/config.ts`, `vite.config.ts`.
>
> **What this section owns.** A single, authoritative catalogue of *every* environment
> variable the platform reads — client, server, and worker — grouped by area, with scope,
> required-ness, purpose, default, and where it is set. It is the operator's checklist for
> standing up an environment and the auditor's map of where secrets live. It does **not**
> re-derive the *reasons* behind each value (those live in the linked sections); it is the
> reference table they all point back to.

## 52.1 How to read this appendix

**Honesty markers.** Every variable is tagged **[today]** (read by code that ships in the
repo right now — verifiable in `server/src/config.ts` or `vite.config.ts`) or **[new]**
(introduced by the Autopilot/Foundations work and not yet wired). Mixing the two without
marking them would be dishonest; the goal is that an operator can tell, at a glance, what
they can set *today* versus what is forward-looking.

**Columns.** Each table uses the same shape:

| Column | Meaning |
|---|---|
| **Name** | The exact variable name. `VITE_*` names are inlined into the client bundle at build time and are therefore **public**. |
| **Scope** | `client` (browser bundle, public), `server` (the Express API), `worker` (studio-worker / ventures-worker / queue worker), or combinations. |
| **Req?** | **Yes** (boot or feature fails without it), **Cond.** (required only when its feature is enabled), or **No** (optional / has a safe default). |
| **Purpose** | One line: what it controls. |
| **Default** | The value used when unset, as implemented (`server/src/config.ts`) or documented. `—` means no default (empty/disabled). |
| **Where set** | dev: `.env` files · prod server: Railway · prod client: Cloudflare Pages build env · worker: `wrangler secret` / Pages. |

**Scope discipline.** A variable's *name prefix* is load-bearing: anything starting with
`VITE_` is compiled into the browser bundle by Vite (`loadEnv` in `vite.config.ts`) and must
**never** hold a secret. Everything else is server/worker-only and must **never** appear in
the client bundle, in client-readable responses, or in logs. See [§52.8](#528-secrets-handling-rules-non-negotiable).

---

## 52.2 Client configuration (`VITE_*`) — public, build-time

These are inlined into the static bundle and are visible to anyone who opens DevTools. They
are **public by design**: only the anon Supabase key, public URLs, and feature flags belong
here.

| Name | Scope | Req? | Purpose | Default | Where set |
|---|---|---|---|---|---|
| `VITE_SUPABASE_URL` | client | **Yes** | Supabase project URL for the browser SDK (auth + RLS-scoped reads). | — | CF Pages build env; `.env` |
| `VITE_SUPABASE_ANON_KEY` | client | **Yes** | Supabase anon/publishable key (RLS-gated; safe to ship). | — | CF Pages build env; `.env` |
| `VITE_API_BASE_URL` | client | No | Absolute base URL of the API. Empty ⇒ same-origin `/api` (dev proxies to `:7071`, prod via Pages → Railway). | `''` (same-origin) | CF Pages build env; `.env` |
| `VITE_AUTH_REDIRECT_URL` | client | No | OAuth/magic-link redirect target after Supabase auth. | provider default | CF Pages build env; `.env` |
| `VITE_STUDIO_LIVE_ENABLED` | client | No | Feature flag: expose the live (cloud-container) Code Studio to **non-admins**. Admins are never gated. | `false` | CF Pages build env; `.env` |
| `VITE_LEGACY_STUDIO_ENABLED` | client | No | Feature flag: revive the retired WebContainer page + Sandpack chat panel for non-admins. | `false` | CF Pages build env; `.env` |
| `VITE_PORT` | client (dev) | No | Vite dev-server port (read by `vite.config.ts`). | `7000` | `.env` (dev only) |
| `VITE_OPERATOR_CONSOLE_ENABLED` **[new]** | client | Cond. | Feature flag: surface the 24/7 Operator Console (§14) to non-admins. | `false` | CF Pages build env |
| `VITE_SENTRY_DSN` **[new]** | client | No | Browser Sentry DSN (a *client* DSN, distinct from server `SENTRY_DSN`). Absent ⇒ no client error reporting. | — | CF Pages build env |

> **Rule:** because these are public, a leaked `VITE_*` value is not an incident *by itself*
> — but it means nothing secret may ever be given a `VITE_` name. The Supabase **service-role**
> key (below) is the inverse: server-only, never `VITE_`.

---

## 52.3 Server core (runtime, CORS, rate limits) — all [today]

The API process (`server/`) reads these at boot via `server/src/config.ts`, which validates
and falls back rather than crashing (except where noted). `STRICT_ENV_VALIDATION` flips
missing-required from a warning to a hard failure (defaults to strict in production).

| Name | Scope | Req? | Purpose | Default | Where set |
|---|---|---|---|---|---|
| `NODE_ENV` | server | No | `production` enables strict validation + prod CORS behavior. | `development` | Railway |
| `PORT` | server | No | Listen port. | `7071` | Railway / `.env` |
| `CORS_ORIGIN` | server | **Yes**¹ | Comma-separated allowed browser origins. Brand domains (`dreamstreamstudio.ai/.com`, `comic2.pages.dev`) are always trusted in addition. | `http://localhost:7000` | Railway / `.env` |
| `MAX_BODY_SIZE` | server | No | Express body-parser limit. | `10mb` | Railway / `.env` |
| `TRUST_PROXY` | server | No | Express `trust proxy` (bool / hop-count / subnet). Needed behind Railway's proxy for correct client IPs. | `true` in prod, else `false` | Railway / `.env` |
| `STRICT_ENV_VALIDATION` | server | No | If `true`, missing required vars throw at boot instead of warning. | `true` in prod, else `false` | Railway / `.env` |
| `RATE_LIMIT_WINDOW_MS` | server | No | Sliding-window length for rate limiting. | `60000` | Railway / `.env` |
| `RATE_LIMIT_MAX_REQUESTS` | server | No | Global per-window request cap (other buckets default off this). | `120` | Railway / `.env` |
| `RATE_LIMIT_TEXT_MAX_REQUESTS` | server | No | Text-generation bucket cap. | `120` | Railway / `.env` |
| `RATE_LIMIT_IMAGE_MAX_REQUESTS` | server | No | Image-generation bucket cap. | `max(20, global/2)` | Railway / `.env` |
| `RATE_LIMIT_VISION_MAX_REQUESTS` | server | No | Vision bucket cap. | = text cap | Railway / `.env` |
| `RATE_LIMIT_SYSTEM_MAX_REQUESTS` | server | No | System/utility bucket cap. | `global × 2` | Railway / `.env` |
| `IDEMPOTENCY_TTL_MS` | server | No | Idempotency-key retention window. | `900000` (15 min) | Railway / `.env` |
| `CLIENT_URL` | server | No | Canonical client URL for redirects/links (billing portal return, etc.). | `http://localhost:5173` | Railway / `.env` |

¹ Listed in `REQUIRED_RUNTIME_ENV_VARS`; in non-strict mode a missing value degrades to the
localhost default with a warning rather than failing boot.

---

## 52.4 Supabase (system-of-record) — all [today]

The platform's own Supabase project (auth, RLS data, storage). Distinct from a *venture's*
provisioned Supabase project (§52.10, `SUPABASE_MANAGEMENT_TOKEN`).

| Name | Scope | Req? | Purpose | Default | Where set |
|---|---|---|---|---|---|
| `VITE_SUPABASE_URL` | client + server | **Yes** | Project URL (also read server-side for admin SDK base). | — | both build/runtime envs |
| `VITE_SUPABASE_ANON_KEY` | client + server | **Yes** | Anon key (RLS-gated). | — | both build/runtime envs |
| `SUPABASE_SERVICE_ROLE_KEY` | server | Cond. | **Secret.** Service-role key bypassing RLS — server-side persistence, storage writes, admin ops. Absent ⇒ those paths degrade/disable. | — | Railway only |
| `STORAGE_BUCKET` | server | No | Storage bucket name for generated assets. | `comic-assets` | Railway / `.env` |
| `IMAGE_INCLUDE_DATA_URL_LEGACY` | server | No | Compatibility: include base64 data URLs in image responses for legacy clients. | `false` | Railway / `.env` |

> `SUPABASE_SERVICE_ROLE_KEY` is the single most sensitive platform secret: it bypasses all
> RLS. It is server-only, never logged, never returned to a client, and never given a `VITE_`
> name. See [§35 threat model](./35-security-threat-model.md).

---

## 52.5 Model providers & keys — [today]

Provider routing is gated by `AI_PROVIDER`. Most user-facing generation supports **BYOK**
(users send their own key via request headers — e.g. `X-OpenRouter-Key`), so the *platform*
keys below are optional and fund only the paid/managed tier and the shared model catalog.

| Name | Scope | Req? | Purpose | Default | Where set |
|---|---|---|---|---|---|
| `AI_PROVIDER` | server | No | `gemini` (legacy Google SDK + Pixazo) or `openrouter` (unified gateway). | `gemini` | Railway / `.env` |
| `GEMINI_API_KEY` | server | No | **Secret.** Google Gemini key (legacy path). Falls back to `ASSISTANT_GEMINI_API_KEY`. | — | Railway only |
| `ASSISTANT_GEMINI_API_KEY` | server | No | **Secret.** Gemini key for the in-app assistant; primary source for `ASSISTANT_GEMINI_API_KEY`. | — | Railway only |
| `GEMINI_TEXT_MODEL` / `GEMINI_IMAGE_MODEL` | server | No | Default Gemini model IDs. | `gemini-2.5-flash` / `gemini-2.5-flash-image` | Railway / `.env` |
| `GEMINI_BASE_URL` | server | No | Gemini API base. | `generativelanguage.googleapis.com` | Railway / `.env` |
| `PIXAZO_API_KEY` | server | No | **Secret.** Pixazo FLUX image key (legacy image path). | — | Railway only |
| `PIXAZO_ENDPOINT` / `FLUX_MODEL_ID` | server | No | Pixazo endpoint + FLUX model id. | hosted defaults | Railway / `.env` |
| `OPENROUTER_API_KEY` | server | Cond. | **Secret.** Platform OpenRouter key (funds paid-tier text+image). Free tier uses user BYOK header instead. Required if `AI_PROVIDER=openrouter` and no BYOK. | — | Railway only |
| `OPENROUTER_BASE_URL` | server | No | OpenRouter API base. | `https://openrouter.ai/api/v1` | Railway / `.env` |
| `OPENROUTER_APP_URL` / `OPENROUTER_APP_TITLE` | server | No | Attribution headers sent to OpenRouter. | brand defaults | Railway / `.env` |
| `OPENROUTER_TEXT_MODEL` / `OPENROUTER_IMAGE_MODEL` / `OPENROUTER_FREE_TEXT_MODEL` | server | No | Default model IDs (incl. free-tier). | Gemini-family via OpenRouter | Railway / `.env` |
| `OPENROUTER_REQUEST_TIMEOUT_MS` | server | No | Per-request timeout for the gateway. | `60000` (example sets `120000`) | Railway / `.env` |
| `REASONING_EFFORT` | server | No | Reasoning effort for capable models: `off`/`low`/`medium`/`high`. | `medium` | Railway / `.env` |
| `NVIDIA_API_KEY` | server | No | **Secret.** Platform NVIDIA NIM (`nvapi-…`) key; optional — only populates the shared catalog when no user BYOK key is present. | — | Railway only |
| `NVIDIA_BASE_URL` | server | No | NVIDIA NIM base (OpenAI-compatible). | `https://integrate.api.nvidia.com/v1` | Railway / `.env` |
| `NVIDIA_TEXT_MODEL` / `NVIDIA_IMAGE_MODEL` | server | No | Default NVIDIA model IDs. | `llama-3.3-70b-instruct` / `flux.1-schnell` | Railway / `.env` |
| `NVIDIA_REQUEST_TIMEOUT_MS` | server | No | NVIDIA request timeout. | `60000` | Railway / `.env` |
| `IDEOGRAM_ENDPOINT` / `IDEOGRAM_MODEL_ID` / `IDEOGRAM_MODEL_VERSION` | server | No | Ideogram BYOK image config (user supplies key). | hosted defaults / `V_2` | Railway / `.env` |
| `FOURSQUARE_API_KEY` | server | No | **Secret.** Optional Foursquare Places key; absent ⇒ `find_places` falls back to keyless OSM. | — | Railway only |
| `FOURSQUARE_API_VERSION` | server | No | Foursquare API version date. | `2025-06-17` | Railway / `.env` |
| `TEXT_REQUEST_TIMEOUT_MS` / `IMAGE_REQUEST_TIMEOUT_MS` / `ASSISTANT_REQUEST_TIMEOUT_MS` | server | No | Per-modality request timeouts. | `60000` / `60000` / `30000` | Railway / `.env` |
| `FLUX_REQUEST_TIMEOUT_MS` / `FLUX_FETCH_IMAGE_TIMEOUT_MS` / `IDEOGRAM_*_TIMEOUT_MS` | server | No | Image-pipeline timeouts. | `120000` / `30000` | Railway / `.env` |

---

## 52.6 Redis / queue & workers — [today]

The ComicForge queue (BullMQ on Redis) and its worker. `validateRuntimeConfig()` warns if
`COMICFORGE_ENABLED` is on but `REDIS_URL` is missing (routes then return
`COMICFORGE_QUEUE_UNAVAILABLE`).

| Name | Scope | Req? | Purpose | Default | Where set |
|---|---|---|---|---|---|
| `REDIS_URL` | server + worker | Cond. | **Secret.** Redis connection string (BullMQ broker). Required when ComicForge is enabled. | — | Railway only |
| `COMICFORGE_ENABLED` | server + worker | No | Enable the ComicForge async queue/worker. | `false` (`.env.example` ships `true`) | Railway / `.env` |
| `COMICFORGE_QUEUE_PREFIX` | server + worker | No | BullMQ key namespace prefix. | `comicforge` | Railway / `.env` |
| `COMICFORGE_WORKER_CONCURRENCY` | worker | No | Parallel jobs per worker. | `4` | Railway / `.env` |
| `COMICFORGE_JOB_RETENTION_DAYS` | worker | No | Completed/failed job retention. | `14` | Railway / `.env` |

---

## 52.7 Studio worker + HMAC, Nango + studio-tools MCPs, Stripe — [today]

### Studio v2 (Cloudflare container live previews)

The control plane (`/api/studio/*`) brokers HMAC-signed requests to the studio-worker. Both
`STUDIO_WORKER_URL` and `STUDIO_HMAC_SECRET` must be set or `/api/studio` returns
`503 STUDIO_NOT_CONFIGURED`.

| Name | Scope | Req? | Purpose | Default | Where set |
|---|---|---|---|---|---|
| `STUDIO_WORKER_URL` | server | Cond. | Base URL of the deployed studio-worker. | — | Railway |
| `STUDIO_HMAC_SECRET` | server + worker | Cond. | **Secret.** Shared HMAC key signing control-plane → worker requests. Must match on both sides. | — | Railway + `wrangler secret` |
| `STUDIO_MAX_CONCURRENT_PER_USER` | server | No | Per-user concurrent live containers (cost safety). | `2` | Railway / `.env` |
| `STUDIO_DAILY_BUILD_MINUTES` | server | No | Per-user daily container-minute cap. | `120` | Railway / `.env` |
| `STUDIO_REQUEST_TIMEOUT_MS` | server | No | Control-plane → worker timeout. | `120000` | Railway / `.env` |
| `STUDIO_COST_PER_AWAKE_SEC` | server | No | Advisory $/awake-second for cost display. | `0.00003` | Railway / `.env` |
| `JSON_TOOL_PROTOCOL_ENABLED` | server | No | Enable JSON tool-protocol fallback for non-OpenRouter models. | `false` | Railway / `.env` |
| `MCP_OUTBOUND_TOKEN` | server | Cond. | **Secret.** Bearer token authenticating the outbound MCP endpoint (`/api/connect/mcp`). Empty ⇒ endpoint **disabled** (503). | — | Railway |

### Nango + self-hosted studio-tools MCPs (`.env.studio-tools.example`)

Split between the docker-compose (`deploy/studio-tools/.env`) and the app server. The MCP
URLs are HTTP-allowed because they are treated as **trusted** self-hosted endpoints.

| Name | Scope | Req? | Purpose | Default | Where set |
|---|---|---|---|---|---|
| `NANGO_ENCRYPTION_KEY` | compose | **Yes** | **Secret.** Nango at-rest encryption key — generate once (`openssl rand -base64 32`), **never rotate**. | — | compose `.env` |
| `NANGO_DB_USER` / `NANGO_DB_PASSWORD` / `NANGO_DB_NAME` | compose | No | Nango Postgres credentials. | `nango`/`nango`/`nango` | compose `.env` |
| `NANGO_SERVER_URL` / `NANGO_PUBLIC_SERVER_URL` | compose | No | Nango internal/public base URLs. | `http://localhost:3003` | compose `.env` |
| `NANGO_FLAG_AUTH_ENABLED` | compose | No | Toggle Nango dashboard auth. | `false` | compose `.env` |
| `NANGO_DASHBOARD_USERNAME` / `NANGO_DASHBOARD_PASSWORD` | compose | No | Dashboard login (set real values in prod). | `admin`/`admin` | compose `.env` |
| `NANGO_HOST` | server | Cond. | Nango base URL the app calls server-to-server. | `http://localhost:3003` | Railway / `.env` |
| `NANGO_SECRET_KEY` | server | Cond. | **Secret.** Nango environment secret (from dashboard) — enables the connector tools. | — | Railway |
| `NANGO_DEFAULT_CONNECTION_ID` | server | No | Optional test connection so agents can inspect real response shapes at build time. | — | Railway / `.env` |
| `STUDIO_SHADCN_MCP_URL` | server | No | shadcn design MCP endpoint. | `http://localhost:8001/mcp` | Railway / `.env` |
| `STUDIO_MAGICUI_MCP_URL` | server | No | Magic UI MCP endpoint. | `http://localhost:8002/mcp` | Railway / `.env` |
| `STUDIO_MAGIC_MCP_URL` | server | No | Optional 21st.dev Magic MCP endpoint. | — | Railway / `.env` |
| `STUDIO_NANGO_MCP_URL` (+ `_HEADERS`) | server | No | Optional connection-scoped Nango MCP + JSON auth headers. | — | Railway / `.env` |
| `SHADCN_GITHUB_TOKEN` | server/compose | No | **Secret.** Raises shadcn MCP GitHub rate limit (60→5000/hr). | — | Railway / compose |

### Stripe (billing) — `server/.env.example`

`validateRuntimeConfig()` hard-fails in production when `BILLING_ENABLED` and the required
Stripe vars are missing.

| Name | Scope | Req? | Purpose | Default | Where set |
|---|---|---|---|---|---|
| `BILLING_ENABLED` | server | No | Master switch for billing. | `true` | Railway / `.env` |
| `STRIPE_SECRET_KEY` | server | Cond. | **Secret.** Stripe API key. Required when billing on in prod. | — | Railway |
| `STRIPE_WEBHOOK_SECRET` | server | Cond. | **Secret.** Verifies inbound Stripe webhooks. Required when billing on in prod. | — | Railway |
| `STRIPE_WEBHOOK_MAX_AGE_SECONDS` | server | No | Reject webhooks older than this (replay defense). | `86400` | Railway / `.env` |
| `STRIPE_PRICE_ID*` (plans + credit packs) | server | No | Price IDs for Creator/Studio (monthly+annual) and credit packs 10/25/100. | — | Railway / `.env` |
| `STRIPE_BILLING_PORTAL_RETURN_URL` | server | No | Return URL from the Stripe billing portal. | local settings URL | Railway / `.env` |
| `BILLING_PLATFORM_MARKUP` | server | No | Markup multiplier on metered token cost. | `1.30` | Railway / `.env` |
| `GEMINI_PRICING_SOURCE_URL` / `PIXAZO_PRICING_SOURCE_URL` | server | No | Pricing-source URLs for the cost refresher. | vendor docs | Railway / `.env` |
| `PRICING_MAJOR_DELTA_THRESHOLD` | server | No | Alert threshold for a major upstream price change. | `0.35` | Railway / `.env` |

---

## 52.8 New Autopilot variables — [new]

Introduced by the autonomy work (A0 brakes, A2 scheduler, A7 budgets). **None are wired
today**; they are documented here so operators can pre-plan and so the build loop has a
naming contract. Defaults mirror the conservative DB defaults in
[`venture_budgets` / `user_settings`](./26-data-model-schema.md) so env-seeded and DB-seeded
values agree.

| Name | Scope | Req? | Purpose | Default | Where set |
|---|---|---|---|---|---|
| `VENTURES_ENABLED` | server + worker | No | Master switch for the autonomous engine. Off ⇒ ventures are read-only; scheduler does not tick. | `false` | Railway / `wrangler` |
| `VENTURES_KILL` | server + worker | No | **Global kill switch** — halts every venture instantly (last-resort COGS circuit breaker, A0). Re-checked at schedule **and** at the DECIDE gate. Flipped via admin route; change is audited. | `false` | Railway / `wrangler` / admin route |
| `VENTURES_WORKER_CONCURRENCY` | worker | No | Max ventures ticking in parallel (global concurrency cap). | `4` | `wrangler` / Railway |
| `VENTURES_MAX_TICKS_PER_RUN` | worker | No | Hard ceiling on ticks in one Run (loop-cost brake). | `25` | `wrangler` / Railway |
| `VENTURES_TICK_WALL_CLOCK_MS` | worker | No | Per-tick wall-clock timeout. | `120000` | `wrangler` / Railway |
| `VENTURES_DEFAULT_USD_PER_DAY` | server | No | Seed for `venture_budgets.usd_per_day` / `user_settings.default_usd_per_day`. | `5` | Railway / `.env` |
| `VENTURES_DEFAULT_USD_TOTAL` | server | No | Seed for `venture_budgets.usd_total`. | `50` | Railway / `.env` |
| `VENTURES_DEFAULT_MAX_TOKENS` | server | No | Seed for `venture_budgets.max_tokens`. | `5000000` | Railway / `.env` |
| `VENTURES_DEFAULT_MAX_CONTAINER_MINUTES` | server | No | Seed for `venture_budgets.max_container_minutes`. | `600` | Railway / `.env` |
| `VENTURES_BUDGET_ALERT_PCT` | server | No | Spend-alert threshold (fraction of cap) — dedup via `alert_80_sent_at`. | `0.80` | Railway / `.env` |
| `VENTURES_DEFAULT_AUTONOMY_LEVEL` | server | No | Seed for `user_settings.default_autonomy_level`. | `balanced` | Railway / `.env` |

> The budget defaults are **safety rails, not pricing.** They bound COGS from below per
> [§24 autonomous engine](./24-autonomous-engine.md) and [§40 cost & FinOps](./40-cost-finops.md);
> the DECIDE gate refuses spend that would breach them regardless of the env value.

---

## 52.9 Observability — [new] (gated, no-op when unset)

All optional; absent ⇒ feature is a silent no-op, never a hard dependency
([§38 observability](./38-observability.md)).

| Name | Scope | Req? | Purpose | Default | Where set |
|---|---|---|---|---|---|
| `SENTRY_DSN` | server | No | **Secret-ish.** Server Sentry DSN. Absent ⇒ Sentry middleware is a no-op. | — | Railway |
| `SENTRY_RELEASE` | server | No | Release tag (git SHA) attached to events. | build-time SHA | Railway / CI |
| `SENTRY_ENVIRONMENT` | server | No | Environment label (`production`/`staging`/…). | `NODE_ENV` | Railway |
| `SENTRY_TRACES_SAMPLE_RATE` | server | No | APM trace sampling fraction. | `0.0` | Railway |
| `VITE_SENTRY_DSN` | client | No | Browser Sentry DSN (public client DSN; see §52.2). | — | CF Pages build env |
| `METRICS_ENABLED` | server | No | Expose `prom-client` `/metrics` (admin-guarded — leaks topology/volume if public). | `false` | Railway |
| `METRICS_AUTH_TOKEN` | server | Cond. | **Secret.** Bearer token guarding `/metrics` for the scraper. Required when metrics on. | — | Railway |

---

## 52.10 Deploy adapter tokens (BYO / managed) — [new]

Per [§31 deploy adapters](./31-deploy-adapters.md): in the **managed** path these are the
*platform-owned* deploy credentials; in the **BYO** path each venture's credential is a
per-venture Nango `ConnectionRef` and these PAT env vars are the fallback/bootstrap. All are
provisioned via [§49 owner actions](./49-owner-actions.md) (P1) and scoped least-privilege.

| Name | Scope | Req? | Purpose | Default | Where set |
|---|---|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | server | Cond. | **Secret.** Scoped CF token (`Pages:edit`, `Account:read`; `DNS:edit` only for custom domains). | — | Railway |
| `CLOUDFLARE_ACCOUNT_ID` | server | Cond. | CF account id targeted by the adapter. | — | Railway / `.env` |
| `VERCEL_TOKEN` | server | Cond. | **Secret.** Scoped Vercel token (`deployments:write`, `projects:read`; `domains:write` only for custom domains); single team/project. | — | Railway |
| `RAILWAY_TOKEN` | server | Cond. | **Secret.** Scoped Railway token (`project.deploy` on one project; not workspace-admin). | — | Railway |
| `SUPABASE_MANAGEMENT_TOKEN` | server | Cond. | **Secret.** Supabase **Management** PAT to provision a *user's* project (project-create/read in one org). Distinct from the platform `SUPABASE_SERVICE_ROLE_KEY`. | — | Railway |

> "Cond." = required only for the adapter(s) you enable. A platform that ships managed
> Cloudflare Pages previews needs `CLOUDFLARE_*`; the others light up as those targets are
> enabled. Per-venture BYO connections supersede these PATs at runtime.

---

## 52.11 Feature flags — consolidated

| Flag | Scope | Default | Effect when `true` | Status |
|---|---|---|---|---|
| `VITE_STUDIO_LIVE_ENABLED` | client | `false` | Live Code Studio exposed to non-admins. | today |
| `VITE_LEGACY_STUDIO_ENABLED` | client | `false` | Legacy WebContainer + Sandpack revived. | today |
| `VITE_OPERATOR_CONSOLE_ENABLED` | client | `false` | Operator Console visible to non-admins. | new |
| `COMICFORGE_ENABLED` | server | `false` | ComicForge async queue/worker active. | today |
| `BILLING_ENABLED` | server | `true` | Stripe billing + metering enforced. | today |
| `AI_PROVIDER` | server | `gemini` | Selects model path (`gemini`/`openrouter`). | today |
| `JSON_TOOL_PROTOCOL_ENABLED` | server | `false` | JSON tool fallback for non-OpenRouter models. | today |
| `VENTURES_ENABLED` | server/worker | `false` | Autonomous engine ticks ventures. | new |
| `VENTURES_KILL` | server/worker | `false` | Global halt of all ventures. | new |
| `METRICS_ENABLED` | server | `false` | `/metrics` exporter exposed (guarded). | new |

> **Admin override.** Admins are never gated by `VITE_STUDIO_*` flags (per `.env.example`),
> so those flags affect non-admins only.

---

## 52.12 Per-environment matrix

Recommended posture per environment. `req` = must be set; `opt` = optional; `off`/`on` =
recommended flag state; `—` = not applicable / should be empty.

| Variable / group | dev | preview | staging | prod |
|---|---|---|---|---|
| `NODE_ENV` | `development` | `production` | `production` | `production` |
| `STRICT_ENV_VALIDATION` | off | on | on | on |
| `VITE_SUPABASE_URL` / `_ANON_KEY` | req (local proj) | req (preview proj) | req (staging proj) | req (prod proj) |
| `SUPABASE_SERVICE_ROLE_KEY` | opt | req | req | req |
| `CORS_ORIGIN` | localhost | preview origin | staging origin | brand domains |
| `OPENROUTER_API_KEY` / provider keys | opt (BYOK) | opt | req (paid tier) | req |
| `REDIS_URL` + `COMICFORGE_ENABLED` | opt / off | on | on | on |
| `STUDIO_WORKER_URL` + `STUDIO_HMAC_SECRET` | opt | req | req | req |
| `NANGO_HOST` / `NANGO_SECRET_KEY` | local compose | preview Nango | staging Nango | prod Nango |
| `STRIPE_*` (test vs live) | test keys | test keys | test keys | **live keys** |
| `SENTRY_DSN` / `METRICS_ENABLED` | off | opt | on | on |
| `VENTURES_ENABLED` | off (until A2) | off | canary on | gated on |
| `VENTURES_KILL` | off | off | off | off (armed) |
| Deploy adapter tokens (§52.10) | opt | sandbox/scoped | scoped | scoped least-priv |

> **Key rotation boundary.** Each environment uses *distinct* projects/keys (Supabase,
> Stripe, Nango, provider keys). A leaked staging key must never grant prod access. The one
> documented exception is `NANGO_ENCRYPTION_KEY`, which is generate-once-never-rotate **within**
> an environment.

---

## 52.13 Secrets-handling rules (non-negotiable)

These are invariants, not guidelines. They are enforced by review and by the supply-chain
checks in [§44 CI/CD](./44-cicd-release.md) (gitleaks / secret scanning) and the threat model
in [§35](./35-security-threat-model.md).

1. **Never client.** A secret never carries a `VITE_` prefix and is never read by client
   code. The only browser-visible Supabase key is the **anon** key; the **service-role** key
   is server-only. Build tooling (`vite.config.ts` `loadEnv`) only inlines `VITE_*`.
2. **Never logged.** Secrets are never written to logs, error messages, traces, or telemetry.
   `server/src/config.ts` reads keys into module constants and the app does not print them
   (the studio-tools note states "Secrets are never printed by the app"). Redact in any
   structured logger before shipping to Sentry.
3. **Never in responses.** No API response, error payload, or debug endpoint echoes a secret
   (including partial/truncated). The presence of a feature is exposed; its key is not.
4. **Per-environment isolation.** Distinct keys/projects per env (§52.12). No prod secret in
   a preview/staging store; no shared secret across tenants.
5. **Least privilege + scoping.** Deploy/management tokens (§52.10), MCP tokens, and Nango
   secrets are scoped to the minimum needed and, where possible, per-venture via Nango rather
   than a broad platform PAT.
6. **Store in the platform secret manager, not the repo.** `.env*` files in the repo are
   **examples** (`.env.example`, `.env.studio-tools.example`, `server/.env.example`) and ship
   with empty/placeholder values. Real values live in Railway (server/worker), Cloudflare
   Pages build env (`VITE_*`), `wrangler secret put` (worker), and the compose `.env`
   (studio-tools) — never committed.
7. **Validation, not silent default, for security-critical vars.** Production boot **fails**
   on missing required runtime vars and on missing Stripe vars when billing is on
   (`validateRuntimeConfig()`); it does not silently run insecure. `MCP_OUTBOUND_TOKEN` and
   metrics auth **disable** their endpoints when unset rather than opening them.
8. **Rotation.** Rotate provider/Stripe/Supabase/Nango secret keys on suspected exposure and
   on a periodic schedule; `NANGO_ENCRYPTION_KEY` is the explicit no-rotate exception (rotating
   it orphans all stored connection credentials).

---

## 52.14 Cross-references

- **Owner provisioning & priority (who gets which key, when):** [§49 owner actions](./49-owner-actions.md).
- **DB-side defaults these vars seed:** [§26 data model](./26-data-model-schema.md)
  (`venture_budgets`, `user_settings`).
- **Where each is set per environment & CI:** [§44 CI/CD & release](./44-cicd-release.md).
- **Why provider keys / BYOK behave this way:** [§29 model gateway](./29-model-gateway.md).
- **Nango + MCP architecture:** [§30 integrations framework](./30-integrations-framework.md).
- **Deploy adapter credential model (managed vs BYO):** [§31 deploy adapters](./31-deploy-adapters.md).
- **Stripe pipeline:** [§41 billing & metering](./41-billing-metering.md).
- **Sentry / metrics:** [§38 observability](./38-observability.md).
- **Secret threat model:** [§35 security & threat model](./35-security-threat-model.md).
