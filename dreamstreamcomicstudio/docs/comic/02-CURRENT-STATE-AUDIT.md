# 02 — Current-State Audit (the honest map)

> Synthesized 2026-06-05 from direct reads of `App.tsx`, `types.ts`, the OpenRouter
> gateway, and two evidence-based sub-agent audits (editing ceiling; model/cost
> machinery). File:line citations are approximate anchors — verify before editing.

## TL;DR

The comic studio works, but it's **three half-products fighting under one roof**,
the **cost-controlled provider path isn't even the default**, and **there is no
region/layer/inpaint editing at all**. None of this is fatal — the data model,
billing ledger, reader, and OpenRouter gateway are real assets. We consolidate, not
rewrite.

## A. Three competing comic engines (chosen by `project.state.pipelineMode`)

| Engine | Entry | Reality |
|---|---|---|
| **Classic** | `components/ComicEditor.tsx` + `services/generationManager.ts` | **The only engine truly wired to live models.** A 9-step wizard (`AppStep`: SCRIPT_INPUT→…→REVIEW_EXPORT). Generates panels **one at a time, synchronously in the browser tab** (a 12-panel comic ≈ 16 sequential calls, 60–120s+, tab must stay open). Has the real continuity bible + reference injection. |
| **ComicForge** | `components/comicforge/*` + `server/src/comicforge/*` | **Dormant stub.** Nice architecture (BullMQ async worker, normalized DB schema in `server/sql/comicforge_v1_full_pipeline.sql`, staged approvals) but workers no-op, feature-flagged off, UI dead-ends. Produces nothing. |
| **PageStudio** | `components/pagestudio/PageStudio.tsx` + `services/pageStudio.ts` | **Newest, partial.** Generates **one full page image**, then "edits" via a **whole-page text-instruction regeneration** (no mask). Labeled "the new default." Closest to the page-first vision but shallow. |

They **duplicate** prompt-building, model routing, continuity, and image persistence.
`App.tsx:542-574` routes create/open by `pipelineMode`.

## B. The editing ceiling (what a user can actually change)

**Can edit today:** script text + creative direction; per-scene synopsis/setting/cast;
story-planning params; style selection (presets/custom/sample variants/aspect ratio);
world entities (add/edit/upload or AI-generate each reference image; character library);
cover; layout (grid template, custom prompt, text layout, dialogue mode); per-panel
**prompt/description** and **dialogue blocks** (in `CombinedPreview`); **regenerate a
single panel (whole image)** with free-text change notes; **speech bubbles** —
add/delete/edit + **drag to reposition** (overlay only) in `BubbleEditorModal`;
project versioning; continuity audit; export (PDF/HTML/ZIP).

**Cannot edit today (the gaps vs. the vision):**
- ❌ **No region / mask / inpaint.** `ENABLE_INPAINTING = false` (`services/modelPolicy.ts:114`).
  The image route (`server/src/routes/image.ts`) accepts only `prompt / aspectRatio /
  resolution / referenceImages` — **no mask/region/bbox param**.
- ❌ **No object/element selection** ("circle this", "select that"). Regeneration is
  always whole-panel or whole-page.
- ❌ **No interactive crop / zoom-pan / freeform canvas.** Crop is automatic center-only
  (`services/imageUtils.ts:56`). `DraggablePanel.tsx` exists but is **unused**.
- ❌ **No layers / compositing UI.** `ENABLE_SERVER_COMPOSITING = false`. Bubbles are an
  HTML/SVG overlay in the panel pipeline (good — editable) but **baked into the image**
  in PageStudio (bad — only changeable by full-page regen).
- ❌ **No panel drag-resize on the page** (placement fixed by template slots).

**Smallest regeneration unit = one full panel image** (or one full PageStudio page).
The single spatial affordance is dragging overlay bubbles in `BubbleEditorModal`
(`:54-78`). **Everything Adobe-like is net-new** — but `ENABLE_INPAINTING` /
`services/imageService.ts` → `server/src/routes/image.ts` is the known insertion point.

## C. Model routing + provider reality

- **Unified gateway exists** (`server/src/ai/gateway.ts`) over two providers:
  `openrouter` + `nvidia`. Routes call `getProvider(id)`; BYOK key wins and bypasses
  billing (`gateway.ts:47-51`).
- **…but the default provider is `gemini`, not openrouter** (`config.ts:147`;
  `isOpenRouterEnabled()` = `AI_PROVIDER === 'openrouter'`). The **legacy Gemini SDK
  (`ai/client.ts`, `ai/image.ts`) and Pixazo/Flux (`ai/flux.ts`) + Ideogram are still
  live and default.** Which model runs depends on which key the user has — not one
  control plane.
- **Per-stage, capability-gated, free-first routing is solid:** `STAGE_REQUIREMENTS`
  (`stageModels.ts:31-45`) gates by capability (`structuredJson`, `imageOutput`,
  `imageInput`); `resolveStageModel` honors a requested model or downgrades + reports;
  `autoRouter.ts` picks free-first (`CostPref = free|cheap|quality|free-only`). Users
  **can pin per-stage** models (`services/modelSelection.ts`, `appSettings.modelRouting`).
- **Default image models:** OpenRouter `google/gemini-2.5-flash-image` ("Nano Banana");
  NVIDIA `flux.1-schnell`; legacy Gemini `gemini-2.5-flash-image`; client default
  provider `flux` (Pixazo). Nano Banana is **free up to 5/day** (`modelAccessPolicy.ts`).
- **Consistency primitives that exist:** reference/multi-image input on the OpenRouter
  path (`openrouter.ts:468-471`) and legacy Gemini (`image.ts:142-170`); editorial
  annotations flag which models hold a face (`catalogAnnotations.ts`).
- **Consistency primitives that DON'T:** **no seed** on the unified OpenRouter/NVIDIA
  path (`GenerateImageRequest` has no `seed` — `providers/types.ts:98-107`). Seeds only
  exist on legacy Flux/Ideogram. No LoRA/IP-adapter/ControlNet anywhere.
- **Model catalog is good:** live from OpenRouter `/models`, normalized + annotated,
  stale-while-revalidate cache backed by Supabase `model_catalog_cache`
  (`modelCatalog.ts`, `modelCatalogStore.ts`).

## D. Cost + context machinery

- **Real reserve→settle→release ledger** (CT credits, 1 CT = $0.0001): pre-flight
  estimate (`costEstimator.ts`), reservation (`billingLedger.ts`), settlement that
  **trusts OpenRouter's real `usage.cost`** when present. BYOK bypasses the wallet.
  Free-only mode is **default-on client-side** and returns **HTTP 402** instead of
  silently using a paid model.
- **Token/context optimization is thin:** full script untruncated; **every**
  character/item/location injected into **every** panel prompt
  (`generationManager.ts:213-215`); only a **2-panel** context window; the one real
  optimization is a 120-word continuity-summary cap.
- **No generation/result cache or prompt dedup.** Identical prompts re-bill in full.
  The only cache is a 15-min in-memory **idempotency** map (`routes/image.ts`) keyed by
  `Idempotency-Key` — single-instance, lost on restart.
- **Cost-control bugs to know:** image settles run **fire-and-forget** (`void
  settleReservedOperation…`), and the "daily reconciliation repairs failed settles"
  claim is **false** — `dailyBillingReconciliation.ts` only reconciles Stripe vs
  ledger, so failed async settles **leak reserved credits**. (Moot under BYOK v1, but
  fix before re-enabling billing.)

## E. What's genuinely good — keep it

- The **normalized comic schema** in `server/sql/comicforge_v1_full_pipeline.sql`
  (`scripts, asset_cards, layout_templates, pages, panels, panel_lettering,
  generation_jobs`, owner RLS) — a strong basis for the Comic Document persistence.
- The **OpenRouter gateway + capability registry + annotated catalog** — exactly the
  multi-model substrate we want; we just make it the default and extend it.
- The **billing ledger** (dormant in v1, but ready for multi-tenant later).
- The **reader, sharing tokens, project versioning** — reusable as-is.
- The `docs/studio/` **doc discipline** — we mirror it here.

## F. Cross-cutting debt

- **Routing** is a hand-rolled `currentView` state machine + ~10 auth/reader
  `useEffect`s in `App.tsx` even though `react-router-dom` is a dependency (race-prone).
- **Repo hygiene:** committed `dreamstream-comic-studio (1).zip`, `.DS_Store`, root
  scratch file `analyze_comic.ts`.
- **Dual storage drift:** Supabase + IndexedDB can diverge; need a clear
  source-of-truth + reconcile (newer `updated_at` wins).

## G. Implication for the plan

We are **consolidating onto one document + one engine + one editor**, making the
**OpenRouter path the default**, adding the **missing primitives** (seed, mask/inpaint,
result cache, scoped prompts, layers), and **fencing off** the non-comic products —
while *reusing* the schema, gateway, catalog, reader, and billing-when-needed. See
`03-ARCHITECTURE.md`.
