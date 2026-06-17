# Environment Variable Matrix

**Status:** Authoritative env-var → consumer map. **Last verified:** 2026-06-16.
**Companion:** `INFRA_MAP.md`, `COST_RUNBOOK.md`. Central definition: `server/src/config.ts`.
**Maintain this:** add a row when code starts reading a new env var; mark cost impact.

Legend — **Req?**: ✅ required (in the stated condition) · ⭕ optional (feature degrades/
off) · 🔐 secret. **Cost**: 💸 can drive spend · — negligible.

> ⚠️ The vars marked **"missing from `.env.example`"** are read by code but were not in the
> canonical example file as of the audit. They are added to `.env.example` in the same PR
> as this doc.

---

## Core platform / hosting

| Var | Consumer | Req? | Cost | Notes |
|---|---|---|---|---|
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | frontend + backend JWT validation | ✅ | — | Anon client; JWT-only on backend |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | backend | ✅ | — | |
| `SUPABASE_SERVICE_ROLE_KEY` | `services/supabase.ts` (admin client) | ✅ 🔐 | — | The workhorse client (~43 sites) |
| `VITE_API_BASE_URL` | frontend | ✅ | — | Points at `/api` (proxied to Railway) |
| `VITE_AUTH_REDIRECT_URL` | frontend auth | ✅ | — | |
| `STORAGE_BUCKET` | `imageStorage.ts` | ⭕ | — | Defaults `comic-assets` |
| `DATA_EGRESS_URL` / `DATA_EGRESS_SECRET` | `lib/egressProxy.ts` | ⭕ 🔐 | — | Finance host failover via data-egress worker |
| `REDIS_URL` | `ventures:worker` / `connectors:worker` only | ⭕ | 💸 | **Keep UNSET on the always-on backend** (blocks App-Sleeping) |

## LLM / AI providers

| Var | Consumer | Req? | Cost | Notes |
|---|---|---|---|---|
| `DREAMSTREAMSTUDIO_ALL` → `OPENROUTER_API_KEY` | `ai/gateway.ts` | ⭕ 🔐 | 💸 | Effective default gateway; per-call USD |
| `DREAMSTREAMSTUDIO_MODELTEST` | model-test only | ⭕ 🔐 | 💸 | Kept out of user-serving pool |
| `OPENROUTER_API_KEYS` / `NVIDIA_API_KEYS` | `ai/reliability/keyPool.ts` | ⭕ 🔐 | 💸 | Key-pool + circuit breaker |
| `NVIDIA_API_KEY`, `NVIDIA_TEXT_MODEL` | NVIDIA NIM | ⭕ 🔐 | 💸 | `NVIDIA_TEXT_MODEL` **missing from .env.example** |
| `OPENAI_API_KEY` | OpenAI | ⭕ 🔐 | 💸 | BYOK |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_VERSION` | Anthropic | ⭕ 🔐 | 💸 | BYOK |
| `GEMINI_API_KEY`, `ASSISTANT_GEMINI_API_KEY` | Gemini | ⭕ 🔐 | 💸 | Platform-served |
| `DEEPSEEK_API_KEY`, `ZAI_API_KEY`, `MINIMAX_API_KEY`, `TENCENT_API_KEY`, `XAI_API_KEY` | respective providers | ⭕ 🔐 | 💸 | BYOK |
| `OPENROUTER_SMART_TEXT_MODEL` | routing | ⭕ | — | **missing from .env.example** |
| `AI_PROVIDER` | `config.ts` | ⭕ | — | Default `gemini`; set `openrouter` for the gateway cost model |
| `PLATFORM_MONTHLY_ALLOWANCE_USD` | `services/platformAllowance.ts` | ⭕ | 💸 | Default $5/user/mo cap |
| `PROVIDER_BUDGETS` | `lib/providerUsage.ts` | ⭕ | — | JSON override of per-provider caps |

## Image generation

| Var | Consumer | Req? | Cost | Notes |
|---|---|---|---|---|
| `PIXAZO_API_KEY` | Flux/Pixazo | ⭕ 🔐 | 💸 | |
| `IDEOGRAM_API_KEY` | Ideogram | ⭕ 🔐 | 💸 | |

## Data connectors (all optional; degrade honestly)

| Var | Provider | Req? | Cost | Notes |
|---|---|---|---|---|
| `TAVILY_API_KEY` / `BRAVE_API_KEY` / `SERPER_API_KEY` / `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX` | web search chain | ⭕ 🔐 | 💸 free tiers | First key present wins; works with none |
| `SEARXNG_URL` | self-hosted search | ⭕ | 💸 (Railway) | The Railway SearXNG service; public fallback exists |
| `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` | equities (IEX) | ⭕ 🔐 | — | Must not preempt Yahoo |
| `COINGECKO_API_KEY` / `COINGECKO_API_PLAN` | crypto | ⭕ 🔐 | 💸 **$35/mo if Basic** | Keep free/demo unless commercial |
| `FRED_API_KEY` / `FINNHUB_API_KEY` | macro/finance | ⭕ 🔐 | — | **missing from .env.example** |
| `OPEN_METEO_API_KEY` / `OPEN_METEO_BASE_URL` / `MET_USER_AGENT` | weather | ⭕ | — | |
| `FOURSQUARE_API_KEY` | places | ⭕ 🔐 | — | |
| `AMADEUS_API_KEY` / `AMADEUS_API_SECRET` / `AMADEUS_PRODUCTION` | flights | ⭕ 🔐 | — | `AMADEUS_PRODUCTION` **missing from .env.example** |
| `OSRM_BASE_URL` | directions | ⭕ | — | |
| `IPINFO_TOKEN` | IP geo | ⭕ 🔐 | — | |
| `JINA_API_KEY` | article reader | ⭕ 🔐 | — | |
| `NASA_API_KEY` / `GITHUB_TOKEN` / `YOUTUBE_API_KEY` | misc tools | ⭕ 🔐 | — | In code, not in 58-var set |
| `GOOGLE_MAPS_API_KEY` | maps | ⭕ 🔐 | 💸 | |

## Billing / security / connectors

| Var | Consumer | Req? | Cost | Notes |
|---|---|---|---|---|
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | billing | ✅ when `BILLING_ENABLED=true` 🔐 | — | **missing from .env.example** |
| `STRIPE_PRICE_ID*` (×10) | billing | ⭕ | — | Fall back to DB configs |
| `TURNSTILE_SECRET_KEY` / `VITE_TURNSTILE_SITE_KEY` | bot protection | ⭕ 🔐 | — | No-op until both set |
| `ADMIN_EMAILS` | `middleware/rbac.ts` | ✅ 🔐 | — | **Security-critical; missing from .env.example** — controls bootstrap admin |
| `MCP_OUTBOUND_TOKEN` | `/api/connect` | ⭕ 🔐 | — | **missing from .env.example** |
| `CONNECTORS_WEBHOOK_TOKEN` / `CONNECTORS_SYNC_COLOR` / `CONNECTORS_APP_RETURN_URL` | connectors | ⭕ 🔐 | — | |
| `NANGO_SECRET_KEY` / `NANGO_HOST` | connector SaaS | ⭕ 🔐 | 💸 | In code, not in 58-var set |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `_REDIRECT_URL` | Google connectors | ⭕ 🔐 | — | |

## Studio / live / email workers (set on the workers, mirrored on backend)

| Var | Consumer | Req? | Cost | Notes |
|---|---|---|---|---|
| `STUDIO_WORKER_URL` / `STUDIO_HMAC_SECRET` | backend → studio-worker | ⭕ 🔐 | 💸 (Containers) | **missing from .env.example** |
| `EMAIL_WORKER_URL` / `EMAIL_HMAC_SECRET` / `EMAIL_PUBLIC_BASE_URL` | backend → email-worker | ⭕ 🔐 | — | |
| `VITE_LIVE_WORKER_URL` / `VITE_STUDIO_LIVE_ENABLED` / `VITE_LEGACY_STUDIO_ENABLED` | frontend feature flags | ⭕ | — | |
| `VENTURES_ENABLED` / `VENTURES_KILL` / `VENTURES_*` | autopilot | ⭕ | 💸 (Redis) | OFF by default; **missing from .env.example** |

---

## Quick remediation list (from the 2026-06 audit)

Add to `.env.example` (read by code, were absent): `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `FINNHUB_API_KEY`, `FRED_API_KEY`, `ADMIN_EMAILS`,
`STUDIO_WORKER_URL`, `STUDIO_HMAC_SECRET`, `VENTURES_ENABLED`, `MCP_OUTBOUND_TOKEN`,
`AMADEUS_PRODUCTION`, `OPENROUTER_SMART_TEXT_MODEL`, `NVIDIA_TEXT_MODEL`.
