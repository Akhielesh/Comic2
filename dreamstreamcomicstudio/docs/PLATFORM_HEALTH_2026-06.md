# Platform health pass — June 2026

Three workstreams from one investigation: (1) why bench run `6d0b89f2` reported
73% of models unhealthy, (2) capability-aware model access per product, and
(3) the cross-product memory (RAG) foundation + a security audit.

## 1. Bench run 6d0b89f2 — what was actually wrong

338 models tested, 91 reported healthy, 400 anomalies. Re-analysis of the raw
results shows most "failures" were the **harness**, not the models:

| Root cause | Models affected | Evidence | Fix shipped |
|---|---|---|---|
| `maxTokens: 120` starved hidden-reasoning models | ~78 (o1/o3, gpt-5.x, deepseek-r1, qwen-thinking, GLM, minimax…) | `empty_response, finish_reason=length`; Gemini rows show `completionTokens=116` with text cut at "BENCH-" | Reasoning headroom (+1.5k/+3k tokens), `reasoning: {effort:'low'}`, new `reasoning_overflow`/`truncated` anomaly classes, default maxTokens 256 |
| Strict reasoning check (`/394/` exact, "only the final number") | ~106 wrong_answer rows | Frontier models obey "only the number" and flub no-CoT arithmetic; "= 394." failed the regex | Probe now allows working + `ANSWER: <n>` sentinel; lenient numeric extraction |
| "Vault code" needle + single repeated filler sentence | Claude/GPT-5.x refusals; small-model repetition loops | "This is a prompt injection attempt…" | Neutral needle ("reference ID for shipment 7"), varied filler sentences |
| Shared `free-models-per-min` quota (16–20/min) hammered at concurrency 6 | 21 models, 52 anomalies | HTTP 429 `free-models-per-min` | Global free-pool pacing (1 req / 4.2s) + 3-attempt retry honoring `Retry-After`/`X-RateLimit-Reset` |
| Non-chat models probed as chat | 14 (llama-guard, content-safety, lyria, gpt-audio, relace-apply, morph, bodybuilder, deep-research…) | "User Safety: safe", music-gen 502s, `expected <code>…</code> tags` | Taxonomy exclusion (modalities + `supported_parameters` + id rules), surfaced as one info line |
| `temperature` sent to models that reject it | o-series, gpt-5-image, deep-research | HTTP 400 "'temperature' is not supported" | Sent only when `supported_parameters` includes it |
| All-skipped models counted "healthy" | healthy=91 vs 90 actual | — | Healthy now requires ≥1 passed phase and 0 failed |

Genuinely broken/unavailable models in that run were a small minority
(e.g. `allenai/olmo-3-32b-think` 404 "No endpoints", arcee non-serverless,
small models that legitimately fail echo). Re-run the bench after this deploy
to get a truthful healthy count; expect free-model runs to take longer (the
pacing is the cost of accuracy).

Both harnesses updated in lockstep: `server/src/services/modelBenchRunner.ts`
(in-app) and `scripts/model-bench.mjs` (CI).

## 2. Capability-aware model access per product

New single source of truth: **`shared/modelCapabilities.ts`** — model `kind`
(chat / safety-classifier / code-apply / request-router / deep-research /
media), capability flags (vision, tools, reasoning, json, longContext,
temperature), and per-product profiles:

- **chat_studio** — any chat-kind model; tools/json recommended (widgets degrade without).
- **stream_studio (Code Studio)** — chat kind + tool calling required; json + 32k context recommended.
- **comic_studio** — chat kind; json + vision recommended (panel art gated separately by image output).

Enforced in three layers:
1. **Catalog** — `AnnotatedModel` now carries `kind` + `capabilities`;
   `GET /api/models/catalog?product=chat_studio|stream_studio|comic_studio`
   returns only product-fit models (client `fetchModelCatalog({ product })`).
2. **Request time** — `/api/chat` rejects pinned special-purpose models
   (`MODEL_NOT_CHAT_CAPABLE`) and vision-less models when images are attached
   (`MODEL_NO_VISION`) with actionable messages.
3. **Bench** — same taxonomy excludes non-chat models from probes.

## 3. Cross-product memory (RAG foundation)

User context now follows the user across products, sessions, devices and
models. Pipeline (all best-effort; the chat path is never blocked):

- **Store**: `user_memories` (Supabase + pgvector, 768-d Gemini embeddings,
  HNSW + FTS indexes) and `user_memory_prefs` (opt-out toggle). Migration:
  `server/sql/user_memory_rag.sql` — **must be applied to the production
  Supabase project**; until then the feature silently no-ops.
- **Write**: distilled bullets from the existing `/api/chat/memory` endpoint
  now also persist server-side; plus automatic post-chat distillation
  (`maybeAutoRemember`, throttled to one cheap model call / 5 min / user).
- **Retrieve**: `buildUserMemoryBlock()` — vector search → FTS fallback →
  recency fallback, ~1.4k-char budget, 2.5s time-box — injected into the
  system prompt inside `runChat()` for ANY provider/model via the
  `userId` + `userMemory` params. Wired into `/api/chat` (all chat traffic)
  and Code Studio `/api/studio/generate`.
- **Privacy surface**: `GET /api/chat/memory/list`, `DELETE
  /api/chat/memory/:id`, `DELETE /api/chat/memory/all`, `PUT
  /api/chat/memory/prefs` (enable/disable). RLS owner policies +
  service-role queries always scoped by the authenticated user id.

Follow-ups: settings UI for the memory list/toggle; ComicForge style-preference
injection in `buildPagePrompt`; per-stage retrieval for studio sub-agents.

## 4. Security audit — 2026-06-12

Full read-only audit of RLS (all 64 tables verified RLS-enabled), route auth
(no cross-user IDOR found; admin/bench routes correctly gated), secrets (BYOK
AES-256-GCM solid), SSRF, XSS, rate limiting, workers, CORS/headers.

**Fixed in this pass:**
- **H1** Bootstrap-admin fallback `admin@test.com` removed — `ADMIN_EMAILS`
  unset now means *no* bootstrap admins (`server/src/services/rbac.ts`).
- **H2** SSRF: pre-auth `/api/chat/read-url` + `/unfurl` now verify resolved
  IPs (DNS-rebinding) and re-validate every redirect hop
  (`fetchPublicUrl` in `mcpClient.ts`; `readArticle.ts`, `unfurl.ts`).
- **M1** `TRUST_PROXY` production default `true` → `1` hop — stops
  X-Forwarded-For spoofing of IP-keyed rate limits (`config.ts`).
- **M3** `/api/models/verify` now requires auth (was leaking platform-key
  usage/credits to anonymous callers).
- **M4** `safeHref()` scheme validation on LLM/tool-supplied link URLs in
  DataTableCard, DashboardCard, VideoResults (blocks `javascript:` payloads).
- **L5** Auth middleware no longer echoes upstream error detail.

**Open items (need coordinated deploys or ops action — do these next):**
1. **H3** studio-worker HMAC has no replay protection — add a signed
   timestamp (±5 min window); requires server+worker deploy together.
2. **H4** live-worker ships `ALLOWED_ORIGINS: "*"` and non-constant-time
   host-key compares — pin origins, reuse the constant-time compare.
3. **M8** email-worker `/send`: add the same replay window as `/auth-hook`
   and a recipient-domain allowlist.
4. **M2** data-egress: make `EGRESS_SHARED_SECRET` mandatory; `redirect:
   'error'` on upstream fetches.
5. **M5** Encrypt `mcp_servers.headers` with the existing `secureStore`
   wrapper (parity with BYOK keys).
6. **M6** Rate-limit/Turnstile the `resolve_email_from_username` RPC
   (username→email enumeration).
7. **M7** Verify the commented-out `user_settings`/`user_api_keys` client
   REVOKEs actually ran in production; add explicit REVOKEs on the
   Stripe/coupon tables (L2).
8. **Ops**: set `ADMIN_EMAILS` and (if topology differs from one proxy hop)
   `TRUST_PROXY` explicitly in Railway env.
