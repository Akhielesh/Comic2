# DreamStream Comic Studio — Overhaul & Launch Plan

_Authored from a full pass over the codebase (frontend, Express backend, ComicForge async pipeline, billing, SQL) plus the OpenRouter API surface. Decisions below reflect the product owner's choices: hybrid/parallel delivery, OpenRouter as the single control plane (Gemini included **via** OpenRouter), BYOK-only free tier, and engine consolidation onto the ComicForge async base._

---

## 0. TL;DR / Strategy

We run **two tracks in parallel**:

- **Track A — Launch-blocking, user-facing (ship in weeks):** Migrate every model call to an **OpenRouter gateway**, build the **Model Library** ("movie-site" catalog with product-POV notes), turn on a **BYOK free tier**, fix the **Library + Stream** (they're wired to DB tables/RPCs that don't exist), and replace the clumsy wizard with an **adaptive flow** (Quick mode for casual users, Studio mode for power users).
- **Track B — Engine consolidation (parallel, behind a flag):** Collapse the two competing generation engines into **one** async engine built on ComicForge's schema, with the classic engine's continuity/reference strengths ported in. Classic stays live until the new engine is at parity, then we delete it.

The single most important strategic constraint: **OpenRouter has abundant *free text* models but virtually no *free image* models.** A comic is mostly images, so "free" means the *brain* (script → panels → dialogue → continuity) runs free; the *pictures* cost money. BYOK-only free tier (chosen) means free users pay OpenRouter directly with their own key, and the platform funds nothing — clean and abuse-proof.

---

## 1. Current-State Diagnosis (the mess)

### 1.1 Two competing generation engines
- **Classic:** `components/ComicEditor.tsx` + client-side orchestrator `services/generationManager.ts` (synchronous; the browser drives the loop) → Express routes `server/src/routes/{text,image}.ts` → Gemini/Pixazo. **This is the live engine.**
- **ComicForge:** `components/comicforge/ComicForgeStudio.tsx` + server-side async pipeline `server/src/comicforge/*` (BullMQ + Redis worker, `pipelineService.ts`, `modelRouter.ts`). Better architecture, normalized DB schema — but **half-wired**: the UI never polls job status (fire-and-forget), no continuity port, no reference auto-injection.
- Chosen at runtime by `project.state.pipelineMode` (`App.tsx:533`). They **duplicate** prompt building, model routing, continuity, and image persistence.

### 1.2 Providers hardcoded everywhere (the OpenRouter blocker)
Gemini (`@google/genai`) and Pixazo/Flux are baked into 30+ locations:
- `server/src/config.ts:77-95` (`GEMINI_TEXT_MODEL`, `GEMINI_IMAGE_MODEL`, `PIXAZO_ENDPOINT`, `FLUX_MODEL_ID`)
- `services/modelPolicy.ts`, `services/imageModels.ts` (hardcoded model arrays)
- `server/src/services/modelAccessPolicy.ts` (PRO/free model lists, 5/day Nano-Banana cap)
- `server/src/services/pricingCatalog.ts` (fallback prices), `server/src/comicforge/modelRouter.ts` (task→model table)
- Provider-specific key headers `X-Gemini-Key` / `X-Pixazo-Key` (`server/src/middleware/keys.ts`), injected in `services/apiClient.ts`
- Two invocation styles: Gemini via SDK (`generateContent` / `generateImages` with `responseSchema`), Pixazo via raw `fetch` (`server/src/ai/flux.ts`).
- **No provider abstraction exists** — OpenRouter cannot "drop in."

### 1.3 Library & Stream depend on a database that isn't there
Code calls Supabase tables `comments`, `comment_likes`, `follows`, `notifications`, `reviews`, `project_likes` and RPCs `increment_project_view`, `increment_project_like`, `decrement_project_like` — **none have migrations in the repo.** Plus:
- `getCommentLikes()` in `services/db.ts` is stubbed (`return {}`).
- Reviews are submitted but never displayed; gallery rating/`review_count` are hardcoded to `0` (`components/PublicGallery.tsx`).
- Share-revoke is broken: client calls `POST /shares/:id/revoke` (`components/modals/ShareModal.tsx`) but server only implements `DELETE /shares/:id` (`server/src/routes/sharing.ts`).
- No RLS for the social tables; dual Supabase+IndexedDB storage can drift.

### 1.4 Flow is both too clicky and too shallow
- Classic: 9 forced steps, ~16–21 clicks happy-path (`types.ts` `AppStep`).
- ComicForge: 11 stages, **submit-then-approve on every stage**, ~30 clicks, no backward editing (`services/comicforge/store.ts`).
- Power users still **can't** set per-panel model, per-panel prompt/negative prompt, or per-panel style; continuity is only audited **after** a long generation.

### 1.5 Fragile glue
- Routing is a hand-rolled `currentView` state machine + ~10 auth/reader-gating `useEffect`s in `App.tsx` (race-prone), even though `react-router-dom` is already a dependency.
- Repo hygiene: a committed `dreamstream-comic-studio (1).zip`, `.DS_Store`, and scratch files (`analyze_comic.ts`, `tarkan_analysis.json`) sit at root.

### 1.6 What's actually good (keep it)
- A real **token-credit billing system**: wallets, plan tiers, reservations/settlement, a daily pricing sync job, Stripe (`server/src/services/{billingLedger,pricingCatalog,costEstimator,usageEnforcer,stripe}.ts`).
- ComicForge's **normalized schema** (`server/sql/comicforge_v1_full_pipeline.sql`): `scripts`, `asset_cards`, `layout_templates`, `pages`, `panels`, `panel_lettering`, `generation_jobs`, all with owner RLS.
- A solid **reader** and **sharing token** model.

---

## 2. Target Architecture

```
                         ┌──────────────────────────────────────────┐
   React (one entry)     │  Quick mode  ·  Studio mode  ·  Library   │
   proper router         │  Model Library (catalog)  ·  Reader/Stream│
                         └───────────────┬──────────────────────────┘
                                         │  /api/*
                         ┌───────────────▼──────────────────────────┐
   Express               │  routes → AI Gateway (provider-agnostic)  │
                         │     ├─ generateText()                     │
                         │     ├─ generateImage()                    │
                         │     └─ listModels()/catalog               │
                         │  Billing (reserve/settle) · Key resolver  │
                         └───────────────┬──────────────────────────┘
                                         │  one provider today
                         ┌───────────────▼──────────────────────────┐
   Providers             │  OpenRouterProvider                       │
                         │  (text + image + image-input/refs)        │
                         │  → openrouter.ai/api/v1                    │
                         │    incl. Gemini, Seedream, GPT-Image, etc │
                         └───────────────────────────────────────────┘

   Generation engine (Track B): single async pipeline on ComicForge
   schema (BullMQ worker) + ported continuity/reference logic.
```

Key principles:
- **One gateway, one pricing/control plane.** Every model call (text and image, including Gemini-family models) goes through OpenRouter via a single abstraction, so model choice and cost live in one place.
- **The model registry is data, not code.** Sourced live from OpenRouter `/api/v1/models`, cached, and augmented with a small editorial layer.
- **BYOK first for free; credits for paid.** Free users supply an OpenRouter key (platform funds nothing); paid users spend platform credits metered from real OpenRouter usage cost.

---

## 3. Track A — Launch-Blocking Workstreams

### A1. OpenRouter Provider Gateway (text + image)

**New files**
- `server/src/ai/providers/types.ts` — `AIProvider` interface: `generateText`, `generateImage`, `listModels`; shared request/result types; `ProviderCtx { userId, apiKey, byok }`.
- `server/src/ai/providers/openrouter.ts` — implements the interface against `https://openrouter.ai/api/v1`.
  - **Text:** `POST /chat/completions`, OpenAI-style messages. Headers: `Authorization: Bearer <key>`, `HTTP-Referer`, `X-Title`.
  - **Image:** `POST /chat/completions` with `modalities: ["image","text"]`; output images in `choices[0].message.images[]` as base64 data URLs; input/reference images passed as `image_url` content parts (Gemini-family image models on OpenRouter accept multiple input images — required for character consistency).
  - **Models:** `GET /models` → normalize to a `CatalogModel`.
- `server/src/ai/gateway.ts` — thin façade the routes call (`generateText`/`generateImage`); picks the provider (OpenRouter today), resolves key, records usage.

**Critical migration nuance — structured JSON output.** The current `server/src/ai/text.ts` leans on Gemini's `responseMimeType:'application/json'` + `responseSchema` for `analyzeScript`, `extractWorldDetails`, `generatePanelBreakdown`, etc. On OpenRouter, structured-output support **varies by model**. The gateway must:
1. Use `response_format: { type: "json_schema", json_schema: … }` when the model's `supported_parameters` include it; else fall back to a strict "return JSON only" prompt.
2. Run every response through a **validate-and-repair** layer (schema validation + one corrective retry). This protects the whole planning pipeline.

**Key flow changes**
- New client storage key `dreamstream_openrouter_key`; new header `X-OpenRouter-Key`.
- `server/src/middleware/keys.ts`: resolve OpenRouter key = BYOK header (free) or platform `OPENROUTER_API_KEY` env (paid). Keep a back-compat shim for the old headers during transition.
- `services/apiClient.ts`: inject `X-OpenRouter-Key` instead of `X-Gemini-Key`/`X-Pixazo-Key`.

**Billing integration (reuse existing infra)**
- Extend `server/src/jobs/dailyPricingSync.ts` to pull OpenRouter `/models` pricing into `model_pricing_snapshots` (provider `openrouter`).
- `costEstimator.ts`: map OpenRouter pricing (prompt/completion per-token, `image` per-image) → CT with markup.
- **Settlement on actuals:** request `usage: { include: true }` and read `usage.cost` (or `GET /generation?id=`), apply markup, settle the reservation.
- **BYOK = no platform billing:** when the request carries a user OpenRouter key, skip reserve/settle entirely (mirrors today's `hasByokForProvider`).

**What gets retired (after the gateway is stable)**
- `server/src/ai/{client,flux}.ts` (Google SDK + Pixazo), the `@google/genai` dependency, `services/fluxService.ts`, the Pixazo env/config, and the hardcoded model arrays in `imageModels.ts` / `modelPolicy.ts` / `modelAccessPolicy.ts` / `modelRouter.ts` (replaced by the catalog).

**Env**: add `OPENROUTER_API_KEY` (server-only, never bundled), `OPENROUTER_BASE_URL`, `OPENROUTER_APP_TITLE`, `OPENROUTER_APP_URL`.

### A2. The Model Library ("movie-site" catalog)

**Goal:** a browsable catalog of OpenRouter models, presented like a streaming-service grid, with **DreamStream's own annotations**: what each model is good for, what's possible, and the drawbacks.

**Backend**
- `server/src/services/modelCatalog.ts`: fetch + cache `/models` (TTL ~1h); expose `getCatalog()`, `getModel(id)`, `getFreeModels()`, `getDefaultForTask(task, planTier)`.
- `server/src/ai/catalogAnnotations.ts` (or a `model_annotations` table): editorial layer keyed by model id/family:
  - `dreamstreamRole`: `text-brain` | `panel-art` | `dialogue` | `cover` | `qc`
  - `recommendedFor`, `qualityBand`, `speedBand`, `costBand`
  - `freeBadge` (pricing all `0` / `:free`)
  - `supportsImageOutput`, `supportsImageInput` (**reference images → character consistency**)
  - `supportsJsonMode` (planning reliability)
  - `drawbacks` (free-text, product POV), `possibilities` (free-text)
- Route `GET /api/models/catalog?modality=&free=&supportsRefs=` → normalized catalog + annotations.

**Frontend**
- `components/ModelLibrary.tsx`: responsive card grid (poster-style), filters (Free · Image · Text · Supports references · Cheap/Fast/Quality), search, sort. Detail drawer per model: role in DreamStream, price per image / per 1k tokens, **drawbacks** (e.g., _"text→image only — can't hold a character's face across panels"_, _"no JSON mode — slower, less reliable planning"_, _"free but heavily rate-limited"_, _"premium cost"_), and a "Use for this task" CTA.
- Replaces `components/ModelSelector.tsx` and feeds the per-task pickers in Studio mode.

**Editorial seed (examples to ship with):**
| Model (via OpenRouter) | Role | Possible | Drawback |
|---|---|---|---|
| Free text models (Gemma/DeepSeek/Nemotron `:free`) | text-brain, dialogue | Free script analysis, panel breakdown, dialogue | Quality/JSON-mode varies; rate limits |
| Gemini 2.5 Flash Image ("Nano Banana") | panel-art, cover | Reference images → strong character consistency | Paid (~$0.01–0.04/img) |
| Seedream 4.5 | panel-art | High-quality stills | Paid ~$0.04/img; weaker multi-image consistency |
| GPT-Image | panel-art, cover | Good prompt adherence | Paid; limited reference control |

### A3. Free Tier (BYOK) + Entitlements

- **Free = BYOK.** Free users must add an OpenRouter key (one-screen setup with a "How to get a free OpenRouter key" guide). All their calls use their key; platform spends nothing.
- **Paid tiers = platform credits**, metered on real OpenRouter usage cost (existing billing). No BYOK needed.
- Rework `modelAccessPolicy.ts`/`modelPolicy.ts`: entitlements become _"free users may use any model their OpenRouter key allows; certain premium models/quality presets gated to paid plans on the platform-funded path."_
- Retire the time-based "free model rollover" and 5/day Nano-Banana cap logic (no longer needed under BYOK), or keep a thin abuse guard on the platform-funded path only.
- Onboarding: surface BYOK setup in Quick mode the first time a free user generates an image, with the cost reality stated plainly.

### A4. UX Overhaul — Adaptive Flow

**One entry point** (`Create`) replaces the confusing two-studios split. Engine is chosen by a flag (Track B), not by the user.

**Quick mode (default — casual users, ~3 clicks):**
- Single screen: large script box (or one-line idea → auto-expand), Style picker (12 presets + **Auto**), Format preset (Webtoon / Page / Square; default Webtoon), **Generate**.
- Auto-runs analyze → world → layout → breakdown with smart defaults; streams progress; lands in the reader.
- Approvals auto-on; no submit-then-approve.

**Studio mode (power users — full depth):**
- Everything Quick has, plus the missing controls: **per-panel model** (from catalog), **per-panel prompt + negative prompt**, **per-panel/scene style override**, **inline single-panel regenerate**, **seed**.
- **Pre-generation continuity audit** (move `runContinuityAudit` earlier so drift is caught before a long run).
- **Editable layout after preview.**
- Non-linear step navigation; "Approve all"; progress persisted.

**Mechanics:** collapse the classic `AppStep` reset gates and the ComicForge submit-then-approve double clicks into a single optional "review" surface. Default everything; reveal depth on demand (progressive disclosure).

### A5. Library + Stream Fixes (DB foundations + social)

- **New migration `server/sql/social_foundation.sql`:** create `comments`, `comment_likes`, `follows`, `notifications`, `reviews`, `project_likes` with **RLS** + indexes; ensure `projects.likes_count` / `projects.views_count` exist; add atomic RPCs `increment_project_view`, `increment_project_like`, `decrement_project_like`. Apply via Supabase; then run **security advisors** to confirm RLS.
- **Fix share-revoke:** align client/server on `DELETE /shares/:id` (update `ShareModal`), or add the `POST /revoke` route — pick one.
- Implement `getCommentLikes()` properly; add a **review display** component; compute **aggregate rating/review_count** in the gallery (replace hardcoded `0`s).
- **Cursor pagination** for gallery, comments, notifications.
- **Storage contract:** Supabase is the source of truth; IndexedDB is a cache; add a reconcile path (newer `updated_at` wins) to stop drift.
- **Phase 0 verification:** re-run `list_tables` / `list_migrations` / `get_advisors` against the live "Comic" Supabase project once it's resumed, to confirm exactly which of the above already exist.

---

## 4. Track B — Engine Consolidation (parallel, behind a flag)

Make **ComicForge the one async engine** and finish what's missing:
- **Job progress:** add an SSE endpoint (or a polling hook) so `ComicForgeStudio`/`GenerationScreen` show live status (today it's fire-and-forget).
- **Port continuity:** move the continuity bible + reference-pack logic from `services/continuity.ts` into `pipelineService.ts`; auto-inject reference images from `asset_cards`.
- **Unify duplicated logic:** one `buildImagePrompt`, one catalog-driven model router, one image-persistence path.
- **Drive both Quick and Studio UX off this single engine.**
- **Migrate + retire:** keep `pipelineMode` to migrate existing projects; once at parity, delete `services/generationManager.ts`, the duplicate routes, and the classic step components.

---

## 5. Cross-Cutting Cleanup

- **Routing:** replace the hand-rolled `currentView` + 10 `useEffect`s with `react-router-dom` (already a dependency): real routes, guard wrappers, fewer auth/reader races.
- **Observability:** end-to-end generation timing, per-call OpenRouter latency + cost metrics, structured logs.
- **Security:** turn on `STRICT_ENV_VALIDATION`; keep the platform OpenRouter key server-only; RLS advisors after every migration.
- **Repo hygiene:** remove `dreamstream-comic-studio (1).zip`, `.DS_Store`; review/remove scratch files `analyze_comic.ts`, `tarkan_analysis.json`.

---

## 6. Sequenced Roadmap

| Phase | Scope | Blocks launch? |
|---|---|---|
| **0 — Foundations (days)** | Verify live DB; repo hygiene; provider interface + feature flags; add OpenRouter env | Enables everything |
| **1 — OpenRouter text (1–2 wks)** | Gateway (text) + BYOK key flow + JSON validate/repair; route `text.ts` through gateway; billing from usage | **Yes** |
| **2 — OpenRouter image + Catalog (1–1.5 wks)** | Image via gateway (with reference-image support); Model Library catalog + per-task selection + free badges | **Yes** |
| **3 — Library/Stream (1 wk)** | `social_foundation.sql` + RPCs + RLS; sharing fix; reviews/likes display; pagination | **Yes** |
| **4 — Adaptive UX (1–2 wks)** | Quick mode (one entry, ~3 clicks) + Studio depth (per-panel control, early continuity audit) | **Yes** |
| **→ LAUNCH CANDIDATE** | After Phases 1–4 | — |
| **B — Engine merge (parallel/after)** | Single ComicForge async engine; continuity ported; classic retired | No (flagged) |

---

## 7. Risks & Mitigations

- **OpenRouter structured-output variance** → JSON validate-and-repair layer; pin known-good models for planning tasks; surface `supportsJsonMode` in the catalog.
- **Image consistency** (only some image models accept reference images) → default comic image model must support multi-image input (Gemini image family via OpenRouter); annotate clearly; graceful fallback.
- **Free-image scarcity** → handled by BYOK-only free tier; mitigate onboarding friction with a smooth one-screen key setup + guide.
- **Billing accuracy through a proxy** → settle on actual `usage.cost`, not estimates.
- **Engine migration** → keep `pipelineMode`, backfill script, flip the flag only at parity.

---

## 8. First Concrete PRs (start here)

1. **Phase 0:** repo hygiene + `AIProvider` interface stubs + feature flags + OpenRouter env (+ live DB verification).
2. **Text gateway behind a flag:** OpenRouter text + JSON hardening; route `server/src/routes/text.ts` through `gateway.generateText`; BYOK key flow end-to-end.
3. **Image gateway + catalog:** OpenRouter image (with reference images) + `modelCatalog.ts` + `GET /api/models/catalog` + `ModelLibrary.tsx` (replacing `ModelSelector`).
4. **Social foundation:** `social_foundation.sql` + RPCs + RLS + sharing-revoke fix + reviews/likes display.
5. **Quick mode:** single-entry creation screen with smart defaults and streamed progress.

---

## Appendix: OpenRouter API quick reference

- **List models:** `GET https://openrouter.ai/api/v1/models` → `data[]` with `id`, `name`, `description`, `context_length`, `architecture.{input_modalities,output_modalities}`, `pricing.{prompt,completion,image,request}` (USD strings; `"0"` = free), `supported_parameters[]`, `top_provider`. Free models: pricing all `0`, often `:free` id suffix. Filter images via `output_modalities=image`.
- **Text:** `POST /chat/completions` (OpenAI-compatible). Headers `Authorization: Bearer <key>`, `HTTP-Referer`, `X-Title`. Structured output via `response_format: { type: "json_schema", json_schema }` where supported.
- **Image:** `POST /chat/completions` with `modalities: ["image","text"]`; outputs in `choices[0].message.images[]` as base64 data URLs; inputs/references as `image_url` content parts.
- **Cost actuals:** set `usage: { include: true }` and read `usage.cost`, or `GET /generation?id=<id>`.
