# Environment Variable Matrix

**Status:** Authoritative env-var → consumer map. **Last verified:** 2026-06-16 (hosting section 2026-10-19; Stream Studio security and observability rows 2026-10-29, ADR 0006 Phase 0).
**Companion:** `INFRA_MAP.md`, `COST_RUNBOOK.md`. Central definition: `server/src/config.ts`.
**Maintain this:** add a row when code starts reading a new env var; mark cost impact.

Legend — **Req?**: ✅ required (in the stated condition) · ⭕ optional (feature degrades/
off) · 🔐 secret. **Cost**: 💸 can drive spend · — negligible.

> ⚠️ The vars marked **"missing from `.env.example`"** are read by code but were not in the
> canonical example file as of the audit. They are added to `.env.example` in the same PR
> as this doc.

## Where the backend's env lives (since 2026-10-19)

The backend runs as the `Backend` Cloudflare Container inside the `dreamstream-api` Worker
(`api-proxy/`). At each container start the Worker builds the process env from:

| Source | Holds | How to change |
|---|---|---|
| `api-proxy/wrangler.jsonc` → `vars` | Non-secret config (URLs, flags, rate limits, public keys) | Edit + push to `Dreamstrream-v1` |
| D1 `dreamstream-backend-env`, table `backend_env(name, value)` | Secrets copied from Railway (20 rows on 2026-10-19: provider keys, `SUPABASE_SERVICE_ROLE_KEY`, HMAC secrets, OAuth client, `TURNSTILE_SECRET_KEY`, …) | Cloudflare dashboard → D1 → console (`INSERT … ON CONFLICT(name) DO UPDATE`); applies at the next cold start |
| Worker secrets on `dreamstream-api` | Optional; **override** D1 and vars of the same name | Dashboard → Workers → dreamstream-api → Settings → Variables and Secrets, or `wrangler secret put` |

Everything string-valued on the Worker is forwarded except the proxy's own `BACKEND_TARGET` /
`BACKEND_ORIGIN` (`api-proxy/src/backendEnv.ts`). `PORT=8080` and `NODE_ENV=production` come
from `Dockerfile.cloudflare`. Railway-injected `RAILWAY_*` vars were deliberately **not** copied
(except `RAILWAY_API_TOKEN`, which the system dashboard uses). `EMAIL_PUBLIC_BASE_URL` and
`GOOGLE_OAUTH_REDIRECT_URL` moved from the Railway domain to `https://dreamstreamstudio.ai`
(the OAuth redirect must also be allow-listed on the Google Cloud OAuth client).

---

## Core platform / hosting

| Var | Consumer | Req? | Cost | Notes |
|---|---|---|---|---|
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | frontend + backend JWT validation | ✅ | — | Anon client; JWT-only on backend |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | backend | ✅ | — | |
| `SUPABASE_SERVICE_ROLE_KEY` | `services/supabase.ts` (admin client) | ✅ 🔐 | — | The workhorse client (~43 sites) |
| `VITE_API_BASE_URL` | frontend | ✅ | — | Unset in production → same-origin `/api` (the `dreamstream-api` Worker → backend container) |
| `VITE_AUTH_REDIRECT_URL` | frontend auth | ✅ | — | |
| `VITE_DS_SKIN_EVERYWHERE` | build only (`vite.config.ts` `dsSkinEverywherePlugin`; docs/design/atlas-skin.md "Wave 9 (bridge)") | ⭕ | — | Cloudflare Pages **build** var, the kill switch for the Atlas design language on every host. Unset (the default) or any value but exactly `off` keeps the `data-ds-skin="atlas"` attribute that `index.html` (and every page entry that carries it, such as `live.html`) ships on `<html>`. `off` strips the skin attribute (the Atlas token block) from every HTML entry at build time; the comics host still boots the skin at runtime (`services/dsSkin.ts`). It is not a full rollback: dark on every page from first paint (`public/theme-boot.js` plus the root `initTheme()` in `index.tsx`) and the bridge D4 token moves stay, so a saved dark theme still opens the legacy pages in dark. Reverting the theme change needs a code revert of the `<script src="/theme-boot.js">` tag in `index.html` and of that `initTheme()` call. Only the exact value `off` strips the attribute; `OFF`, `false`, `0` keep the skin, and the build logs a warning for them. Setting `off` takes a rebuild |
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
| `SEARXNG_URL` | self-hosted search | ⭕ | — | Unset (the Railway SearXNG service is dormant); public fallback exists |
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
| `TURNSTILE_SECRET_KEY` / `VITE_TURNSTILE_SITE_KEY` | bot protection | ⭕ 🔐 | — | No-op until both set. The same Turnstile widget's secret also goes into Supabase → Attack Protection (ADR 0006 owner action #3) |
| `PWNED_PASSWORDS_CHECK` | `routes/authEmail.ts` (sign-up) | ⭕ | — | k-anonymity Pwned Passwords check at sign-up (first 5 SHA-1 hex characters only, padded; 2.5 s timeout, fails open). On unless `off` (ADR 0006 WS-4) |
| `ADMIN_EMAILS` | `middleware/rbac.ts` | ✅ 🔐 | — | **Security-critical; missing from .env.example** — controls bootstrap admin |
| `MCP_OUTBOUND_TOKEN` | `/api/connect` | ⭕ 🔐 | — | **missing from .env.example** |
| `CONNECTORS_WEBHOOK_TOKEN` / `CONNECTORS_SYNC_COLOR` / `CONNECTORS_APP_RETURN_URL` | connectors | ⭕ 🔐 | — | |
| `NANGO_SECRET_KEY` / `NANGO_HOST` | connector SaaS | ⭕ 🔐 | 💸 | In code, not in 58-var set |
| `CONNECTOR_PROVIDERS_CONFIRMED` | `ai/privacy/providerPolicies.ts` (`routes/chat.ts`, `services/userMemory.ts`) | ⭕ | — | Comma-separated direct providers (e.g. `gemini,nvidia`) whose **platform** key the owner confirmed for connected-account content (a paid, no-training tier). Unset = none: those providers get no connector tools, connector context or memory distilled from connected content on the platform key, and that memory is stored without a Gemini embedding until `gemini` is listed. OpenAI and Anthropic need no entry; BYOK keys are never gated. See `docs/DATA_CONNECTORS.md` |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `_REDIRECT_URL` | Google connectors | ⭕ 🔐 | — | |

## Shared platform (wave 1: Word, PowerPoint, email drafts)

Both switches are on only when exactly `on`, and then only for the people the rollout stage admits
(`PLATFORM_DOCS_STAGE` in `shared/platform/flags.ts`: `'admins'` in wave 1). See `docs/platform/README.md`.

| Var | Consumer | Req? | Cost | Notes |
|---|---|---|---|---|
| `PLATFORM_DOCS` | `server/src/ai/tools/platformDocs.ts` (`platformDocsFor(req)`: the chat tools `email_draft` and `deck_create`) | ⭕ | — | Backend env: a `vars` entry in `api-proxy/wrangler.jsonc` or a D1 `backend_env` row. Default unset = off. `off` rolls back the chat tools |
| `VITE_PLATFORM_DOCS` | frontend (`services/platformFlags.ts`: the Word button on chat documents, the comic pitch deck, the draft cards, their rows in Settings → Tools) | ⭕ | — | Cloudflare Pages **build** var. Default unset = off, for admins too. Rolling back means unsetting it and rebuilding. Pairs with `PLATFORM_DOCS` |

## Comic Studio: live agent, dialogue, Pro editor v2 (agent-editor plan §5)

Each flag is a rollout **stage**, read once per request by `server/src/comic/access.ts` (`studioCapsFor` →
`liveCapsFromEnv`, `shared/comic/capabilities.ts`) into the studio caps (`caps.liveAgent.{queue,steer,conflicts}`,
`caps.dialogueFast`, `caps.proEditorV2`). The client reads the caps only, never env. Values: `off` | `admins` | `all`
(case and spaces ignored; `everyone` = `all`; a bare switch `on` / `true` / `1` / `yes` means **admins only**, so
everyone always needs an explicit `all`; `false` / `0` / `no` = `off`; unset or anything else = the default below).
"Admins" is the studio's admin check (bootstrap `ADMIN_EMAILS` + `user_roles`), which fails closed. All of these are
free software: none adds a model or image call of its own, and nothing here bypasses the spend gate. Backend env: a
`vars` entry in `api-proxy/wrangler.jsonc` or a D1 `backend_env` row. Rolling back = set `off`.

| Var | Turns on | Default | Cost | Safe to go to `all` when |
|---|---|---|---|---|
| `COMIC_LIVE_QUEUE` | `caps.liveAgent.queue`: the visible "Up next" message queue while the director works (A1, built in S1; client only; queued notes drain as one combined message, D1; saved per tab in `sessionStorage`, never auto-sent after a reload). The `admins` default means admins see it once S1 ships | `admins` | — | A1 tests pass, plus one week of admin use with no lost notes |
| `COMIC_STEER` | `caps.liveAgent.steer`: gates `POST /api/comic/projects/:id/steer` (A2, built in S1), which adds a note to the running director turn, and with it "Send now" steering (A1's client already calls it when the cap is on). Off: the route answers **501 `NOT_AVAILABLE` whatever the body** (checked before anything else), and "Send now" = Stop the director, then send (D2). On: refusals are 400 `BAD_REQUEST`, 409 `LIMIT` (> 6000 characters), 409 `NOT_RUNNING`, 409 `BUSY` (3 notes waiting or being screened), 429 `COOLDOWN`, 422 `CONTENT_POLICY`, and each keeps the note (`docs/features/live-agent.md` §3) | `off` | — (the capped safety screen per note, at most 3 at once per session, plus a few hundred tokens inside the same turn) | The steer screen passes the safety tests; no stranded steers in the logs (`comic_steer_unread` stays rare) |
| `COMIC_CONFLICT_GUARD` | `caps.liveAgent.conflicts`: the conflict guard (A3, built in S1; D3). The creator's mid-turn edits win, the director asks with one conflict card, and "Use the director's" answers it (`resolve_conflict`, refused `NOT_AVAILABLE` while off). It also adds the DECIDED line, the ask-once prompt rule and the four contradiction questions. Off, the director behaves exactly as before. The director's line, balloon and style writers call the guard from wave 2 (B-TOOL). The `admins` default means admins get it once S1 ships | `admins` | — | Conflict cards seen and answered without false positives on two-balloon pages |
| `COMIC_DIALOGUE_FAST` | `caps.dialogueFast`: clear dialogue edits ("make it a whisper") answered with no model call (B3 fast path; D4). The engine is built (`dialogueFastPath`, B-RESOLVE in S1) but nothing calls it until wave 2 B-TOOL wires `intents.ts`, so the flag changes nothing yet | `off` | — (saves a model call) | The phrase corpus passes and the Undo-after-fast-edit rate is low |
| `COMIC_PRO_EDITOR_V2` | `caps.proEditorV2`: docked inspector, numeric fields, Layers, rotation, named styles (C-*) | `admins` | — | Layout smoke at 320, 360, 768, 1024 and 1280 px; reader/export parity with rotation |

`dialogue_edit` (a reserved core director tool), the `GROUP_HINTS` fix and the `read_pages` line ids need no flag: they
only make the existing director more accurate.

## Comic Studio: Pro Edit (master plan §2.10)

Read once per request by `server/src/comic/access.ts` (`studioCapsFor` → `proCapsFromEnv`,
`shared/comic/capabilities.ts`) into `caps.proMotion`, `caps.proStickers` and `caps.readerMotion`; the client reads the
caps only (`proMotionOn`, `proStickersOn`, `readerMotionOn`), never env. `COMIC_PRO_MOTION` and `COMIC_PRO_STICKERS`
take the stages above (`off` | `admins` | `all`, same synonyms; a bare `on` means admins only).
`COMIC_READER_MOTION` is `off` | `all` only (`readerMotionStage`, lead decision S1).
- A bare `on`, `true` or `1`, and `all` / `everyone` (any case, spaces ignored), turn it on for **everyone**.
- `admins` stays `off`, because the public reader serves signed-out readers whose admin status cannot be checked.
- Any other value is `off`.

Every one of these defaults to `off`, so leaving them unset changes nothing. All Pro Edit work is free software: no
flag here adds a model or image call. The client reads the three caps through `studioApi.asCaps` (S1), and no Pro UI
reads them yet. The workspace itself stays behind `COMIC_PRO_EDITOR_V2` (above).
`PRO_EDIT_OPS_PATCHABLE` is a code constant in `shared/comic/ops.ts`, not env: it lets clients send the `motion` /
`page_motion` ops and is flipped only after the PE-SERVER sanitizer is deployed. Backend env: a `vars` entry in
`api-proxy/wrangler.jsonc` or a D1 `backend_env` row. Rolling back = set `off`.

| Var | Turns on | Default | Cost | Safe to go to `all` when |
|---|---|---|---|---|
| `COMIC_PRO_MOTION` | `caps.proMotion`: the Easy Animate row, the Animate timeline, motion edits in the editor and "Export this page as video" | `off` (then `admins` after S3) | — | Frame-determinism and flash (≤ 3 Hz) tests pass; the phone playback budget is met |
| `COMIC_PRO_STICKERS` | `caps.proStickers`: the Stickers tab in Assets | `off` | — | D6 approved, the licence gate (PE-LICENCE) merged, the credits block live |
| `COMIC_READER_MOTION` | `caps.readerMotion`: readers play the creator's motion (guided view; loops only on screen). `off` \| `all` only: `on` / `true` / `1` / `all` / `everyone` = everyone, `admins` = off (signed-out readers cannot be checked), anything else = off | `off` | — | Reduced-motion and Calm motion checks pass on the public reader |
| *(not an env var)* `PRO_EDIT_OPS_PATCHABLE` | `shared/comic/ops.ts`: a **code constant**, `false`. While false, the `motion` / `page_motion` ops (`PRO_EDIT_OPS`) are not in `CLIENT_PATCHABLE_OPS`, so no client can write motion, and the server sanitizer refuses them | `false` | — | Flipped only by the S2 integration, and only after the PE-SERVER sanitizer is in production and the dangling-motion prune is settled (`docs/features/pro-edit.md` §7). PE-0 itself must be in production one deploy before that |

## Admin cost centre (optional live Cloudflare usage)

| Var | Consumer | Req? | Cost | Notes |
|---|---|---|---|---|
| `CF_ANALYTICS_API_TOKEN` | `services/costCentre.ts`, `streamCosts.ts`, `securitySignals.ts` → `GET /api/admin/costs` | ⭕ 🔐 | — | **Read-only** token with *Account › Account Analytics › Read*. Queries the GraphQL Analytics API (Workers invocations per script, R2 storage; Durable Object requests, duration, rows written and storage; TURN) and Analytics Engine SQL (`stream_usage`: usage points, activity marks, the live Worker's signals; `csp_reports`: CSP violation counts). Never logged or returned to the client. Unset ⇒ Admin → Costs shows a setup card; all Supabase-based figures still work. Also a GitHub repository secret for `stream-cost-watch.yml` |
| `CLOUDFLARE_ACCOUNT_ID` | `services/costCentre.ts` | ⭕ | — | The account tag for the analytics query; both vars must be set (as `dreamstream-api` Worker secrets or D1 `backend_env` rows) |
| `STREAM_DO_NAMESPACES` | `services/streamCosts.ts` (Admin → Costs → Stream Studio) | ⭕ | — | Non-secret. `MonitorRoom=<id>,EventRoom=<id>,UserLine=<id>,CallRoom=<id>` (32-hex Durable Object namespace ids) — splits measured DO requests / rows / GB-s by room and gives exact per-nursery-day KPIs. Unset ⇒ DO figures are account-wide (labelled so). The same token above also reads the `stream_usage` Analytics Engine dataset. Also a GitHub Actions *variable* for `stream-cost-watch.yml` |
| `STREAM_PHASE0_SHIPPED` | `services/streamCosts.ts` | ⭕ | — | `1` once ADR 0006 Phase 0 ships (Wave 2 deployed): applies the per-nursery-day budget alerts — ≤ 1,800 rows (`write_diet`) and ≤ 2,600 DO invocations as Cloudflare counts them ≈ 1,000 billed requests (`request_diet`), both on the 7-day median. Also a GitHub Actions *variable* for `stream-cost-watch.yml` |
| `CSP_REPORTS_DATASET` | `services/securitySignals.ts` (Admin → Costs → Security) | ⭕ | — | Non-secret. The Analytics Engine dataset the Pages binding `CSP_REPORTS` writes to; default `csp_reports`. Set only if the binding uses another name (a plain identifier; anything else falls back to the default) |

## Live / email workers (set on the workers, mirrored on backend)

| Var | Consumer | Req? | Cost | Notes |
|---|---|---|---|---|
| `EMAIL_WORKER_URL` / `EMAIL_HMAC_SECRET` / `EMAIL_PUBLIC_BASE_URL` | backend → email-worker | ⭕ 🔐 | — | |
| `SECURITY_HOOK_SECRET` (email Worker) | `email-worker` `POST /security` | ⭕ 🔐 | — | New-sign-in alerts from the Supabase access-token hook (`x-ds-signature`, ±5 min). The same value is the Supabase Vault secret `SECURITY_HOOK_SECRET` and the live Worker secret of that name; `old\|new` while rotating. Unset ⇒ `/security` answers 503 and no alert is sent (sign-ins are unaffected). Runbook §1 |
| `SECURE_ACCOUNT_PAGE` (email Worker var) | `email-worker` sign-in alert template | ⭕ | — | `on` ⇒ the alert carries the one-time "Not you? Secure my account" button (`/live#/secure/<token>`); anything else ⇒ it points to Settings → Security. Set in `email-worker/wrangler.jsonc` when the `#/secure` page ships (ADR 0006 WS-5) |
| `AUTH_LINK_ORIGINS` | `services/authEmailLinks.ts` (backend auth emails) | ⭕ | — | Comma-separated **exact** origins auth-email links may point at besides `APP_PUBLIC_URL` (e.g. `http://localhost:3000,http://localhost:7000` for local dev). Default empty. Never wildcards — see `docs/email/SETUP.md` |
| *(not an env var)* `STREAM_HOST_ON` | `shared/streamHost.ts` — Pages middleware, both apps, backend, email Worker | — | — | **Code constant on purpose** (one switch shipped in one push to every consumer). Moves Stream Studio to `https://stream.dreamstreamstudio.ai`; Stream Studio links in auth emails, the sign-in handoff (`POST /api/auth/handoff`) and the apex `/live*` 301 follow it. See `INFRA_MAP.md` §2a. |
| `VITE_LIVE_WORKER_URL` | frontend (Stream Studio) | ⭕ | — | |
| `SECURITY_HOOK_SECRET` | `services/liveKick.ts` (backend → live Worker) | ⭕ 🔐 | — | The same secret the database (Vault) and the email Worker share; `old\|new` while rotating (the newest signs). "Not you? Secure my account" signs its server-side kick with it (`POST /live-api/x/user/<uid>/kick`) — the account's own tokens are dead by then. Unset: the account is still secured, and the page says open monitors may stay connected. D1 `backend_env` row or a `dreamstream-api` secret, never `wrangler.jsonc` |
| `LIVE_API_ORIGIN` | `services/liveKick.ts` | ⭕ | — | Where the live Worker's `/live-api` is served. Default `https://dreamstreamstudio.ai`; only `https://` (or localhost for dev) is accepted |
| `VENTURES_ENABLED` / `VENTURES_KILL` / `VENTURES_*` | autopilot | ⭕ | 💸 (Redis, only for `ventures:worker`) | `false` in `wrangler.jsonc` (admins still get in); `VENTURES_PILOT_INLINE=false`. Build stage retired (ADR 0005). `VENTURES_INTAKE_TIMEOUT_MS` (default 120000) bounds the intake model call |

### Retired with Code Studio (ADR 0005, 2026-10-22) — remove wherever still set

| Var | Where it may still live | Notes |
|---|---|---|
| `STUDIO_WORKER_URL` | was a var in `api-proxy/wrangler.jsonc` (removed) | Backend → `dreamstream-studio` Worker |
| `STUDIO_HMAC_SECRET` | `dreamstream-studio` Worker secret + D1 `backend_env` row | Delete both |
| `STUDIO_MAX_CONCURRENT_PER_USER` / `STUDIO_DAILY_BUILD_MINUTES` / `STUDIO_REQUEST_TIMEOUT_MS` / `STUDIO_COST_PER_AWAKE_SEC` | backend env, if ever set | No longer read |
| `VENTURES_BUILD_COST_ESTIMATE_USD` | backend env, if ever set | No longer read (no build stage) |
| `VITE_STUDIO_LIVE_ENABLED` / `VITE_LEGACY_STUDIO_ENABLED` | Cloudflare Pages env, if set | No longer read |

The `STUDIO_*_MCP_URL`, `STUDIO_VIDEO_RENDER_URL` and `NANGO_*` vars are **not** retired: they wire
the chat agent-tool sidecars (`deploy/studio-tools/`) and keep their names.

## Proxy / live-worker settings (Worker-only, never reach the backend)

| Var | Worker | Req? | Cost | Notes |
|---|---|---|---|---|
| `BACKEND_TARGET` | dreamstream-api | ⭕ | — | `container` (default) or `origin` (proxy to `BACKEND_ORIGIN`) |
| `BACKEND_ORIGIN` | dreamstream-api | ⭕ | — | Dormant Railway origin, used only when `BACKEND_TARGET=origin` |
| `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` | dreamstream-live | ✅ | — | Member checks for creating events + every baby-monitor socket (RPCs run as the caller's JWT) |
| `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` | dreamstream-live | ⭕ 🔐 | 💸 (Cloudflare TURN: $0.05/GB on what Cloudflare sends to the relaying device, after 1 TB/mo free shared by the account) | **Set in production since 2026-10-22.** Relay for baby-monitor video, family/direct calls and Stream Studio guests on strict networks (carrier / symmetric NAT, blocked UDP); STUN-only without them, and those connections fail (with a clear reason). Guardrails (`live-worker/src/ice.ts`, costs doc §7 C6): a credential per room + person + payer (never shared), members ≤ 4 h, guests ≤ 2 h and never past their pass, refreshed by clients before expiry (`iceMs` → `{t:'ice'}` / `{t:'call_ice'}`), revoked when a guest or member is removed, a studio guest is kicked or a direct call ends; each tagged with Cloudflare's `customIdentifier` (`n-`/`a-`/`e-` + HMAC of the nursery / caller account / event) so TURN analytics attribute every byte. Relayed video is capped (calls 700/450 kbps, studio 700/600 kbps/1 Mbps, monitor 650 kbps). Check: a monitor hello / `call_joined` lists `turn.cloudflare.com` plus an `iceMs`; `wrangler tail` shows one `turn_mint` line per credential (tag, scope, ttl — no ids); a `?relay=1` call connects. **Owner:** set a Cloudflare account budget alert at **$10/month** (Billing → budget alerts) as the backstop |
| `TURN_TAG_SALT` | dreamstream-live | ⭕ 🔐 | — | Optional secret that keys the TURN `customIdentifier` HMAC. Unset: the TURN API token keys it (still non-reversible). Set it before Phase A's per-identifier analytics so tags stay stable if the API token is rotated (a new salt or token changes every tag) |
| `STREAM_USAGE` (binding) | dreamstream-live | ⭕ | — (10M points/mo included) | Workers Analytics Engine dataset `stream_usage` (`wrangler.jsonc` `analytics_engine_datasets`): ≤ 1 usage point per room per hour (`src/usageMeter.ts`), plus the privacy-safe signal counts (`src/signals.ts`: a name, a surface word and a count; ≤ 1 point per minute per isolate per signal; ADR 0006 WS-8). Optional in code — absent ⇒ no points, the rooms' monthly `use:YYYY-MM` rows still count. Read by Admin → Costs (Stream Studio and Security) and the daily `stream-cost-watch` job |
| `CSP_REPORTS` (binding, **Pages**) | Pages Functions `functions/csp-report.ts` | ⭕ | — | Analytics Engine dataset (default name `csp_reports`) for CSP violation counts — by app, directive and blocked origin, never a URL. Added by the owner in the Pages project's Bindings (owner checklist §6c). Absent ⇒ counts only in bounded log lines |
| `ALLOWED_ORIGINS` | dreamstream-live | ✅ | — | CORS allow-list (includes `https://stream.dreamstreamstudio.ai`, Stream Studio's own host); from ADR 0006 WS-7 also the WebSocket `Origin` allowlist (an upgrade with no `Origin` — a native app — is allowed) |
| `DEVICE_TOKEN_JWK` | dreamstream-live | ⭕ 🔐 | — | P-256 private JWK from `scripts/ops/genDeviceTokenKey.mjs` (`{"keys":[new, old]}` while rotating): device grants (30 days) and 10-minute device access tokens with `DS-Proof` (watches, native apps; `src/auth/deviceToken.ts`). Unset ⇒ device enrolment answers 501 |
| `ACT_TOKEN_KEY` | dreamstream-live | ⭕ 🔐 | — | 32+ characters: single-use "I'm on it" tokens in web pushes (`src/auth/actToken.ts`, 30 min). Unset ⇒ pushes offer no action. One key, no overlap: rotating breaks the last 30 minutes' actions |
| `SECURITY_HOOK_SECRET` (live Worker) | dreamstream-live | ⭕ 🔐 | — | Same value as the email Worker's: verifies `/x/user/:uid/notify` (the new-device push mirror, ADR 0006 WS-7/WS-10) |
| `OPS_KEY` | dreamstream-live | ⭕ 🔐 | — | 16+ characters: `POST /api/ops/apns-probe` (`x-ops-key`). Unset ⇒ the route refuses everything |
| `APNS_KEY_P8` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE` / `FCM_SA_JSON` | dreamstream-live | ⭕ 🔐 | — (APNs and FCM are free) | Native push (`src/push/*`, Phase 1). Unset ⇒ native kinds make no request (the router is dormant) |
| `PUSH_IOS_VIA` / `PUSH_CRITICAL_ALERTS` / `PUSH_LA_SEALED` / `PUSH_VOIP` | dreamstream-live (vars) | ⭕ | — | Non-secret switches (`src/push/router.ts`): `PUSH_IOS_VIA=fcm` if the APNs HTTP/2 probe fails; the others `1` only once Critical Alerts are granted, sealed Live Activity state is proven, and VoIP push ships (Phase 1.1) |
| `RL_WS` / `RL_GUEST` / `RL_GUEST_NID` / `RL_EVENT` (bindings) | dreamstream-live | ⭕ | — | Workers Rate Limiting (`ratelimits` in `wrangler.jsonc`, ADR 0006 WS-7): 60 upgrades/60 s per address, 10 share-link joins/60 s per address, 30 per nursery, 10 events/60 s per account. Every check fails open. Runbook §3 |

**Supabase-side configuration (not env vars, but set by the owner — `server/sql/live_security_v2.sql`):**
Vault secret `SECURITY_HOOK_SECRET`; `public.live_private_config` row `security_hook_url` =
`https://dreamstream-email.akhieleshsrirangam.workers.dev/security`; the *Customize Access Token
(JWT) Claims* hook → `public.live_access_token_hook`. Owner checklist §4.

---

## Quick remediation list (from the 2026-06 audit)

Add to `.env.example` (read by code, were absent): `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `FINNHUB_API_KEY`, `FRED_API_KEY`, `ADMIN_EMAILS`,
`VENTURES_ENABLED`, `MCP_OUTBOUND_TOKEN`,
`AMADEUS_PRODUCTION`, `OPENROUTER_SMART_TEXT_MODEL`, `NVIDIA_TEXT_MODEL`.
