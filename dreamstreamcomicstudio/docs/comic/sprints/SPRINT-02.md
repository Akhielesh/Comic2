# SPRINT-02 — Quick-generate engine (page-first)

**Status:** 📋 planned
**Goal:** From one screen (idea/script + style + format + length), the app **aggregates a
full comic book** — page-composite renders with consistent cast — and lands in the
reader, with **cost preview**, **result caching**, **scoped prompts**, and **seeds**.
**Depends on:** Sprints 0–1.
**Flags:** `VITE_QUICK_ENGINE_ENABLED`. Auto-approve on by default (Quick mode).

## Why
This is the value path (`01-VISION`). Build it on `ComicDoc` and the role orchestrator so
the editor (Sprint 3+) edits exactly what this produces. Cost discipline is mandatory
(`06-COST-AND-CONTEXT.md`).

## Tasks

### 02.1 — Role orchestrator wrapper
- **Do:** `server/src/ai/roles.ts` — `ROLE_REGISTRY` (text-brain, panel-artist, stylist,
  cover-artist) + `resolveRole(role, ctx)` over `resolveStageModel`/`autoRouter`,
  returning `{modelId, provider, downgraded, warnings}`. Free-first; capability-gated.
- **Files:** `server/src/ai/roles.ts`, tests.
- **Accept:** `resolveRole('panel-artist')` returns an `imageOutput`+`imageInput` model
  or a flagged downgrade; `text-brain` returns a free JSON-capable model.
- [ ] done

### 02.2 — Seed end-to-end on the unified path
- **Do:** Add `seed?: number` to `GenerateImageRequest` (`providers/types.ts`); forward it
  in the OpenRouter provider body (`openrouter.ts`); thread from engine → gateway → route.
- **Files:** `server/src/ai/providers/types.ts`, `providers/openrouter.ts`,
  `server/src/routes/image.ts`, `server/src/ai/gateway.ts`.
- **Accept:** Same prompt + same seed → materially more similar outputs than no seed
  (smoke-verify); seed recorded in provenance.
- [ ] done

### 02.3 — Aggregation pipeline (text, free-tier)
- **Do:** `services/comicDoc/generate/aggregate.ts` — `idea/script → outline → script →
  pagePlan → panelPlan`, each a structured (JSON validate-and-repair) call via text-brain.
  Reuse/move logic from `ai/text.ts` (analyze/world/breakdown) but **scene-scoped** and
  writing into `ComicDoc` (pages/panels/cast/continuity), not the legacy shape.
- **Files:** `services/comicDoc/generate/aggregate.ts`, server `routes/text.ts` reuse,
  `server/src/ai/scriptSegmentation.ts`.
- **Accept:** A 1-paragraph idea produces a coherent `ComicDoc` with pages→panels→briefs
  + a cast list + per-scene continuity bindings; all on free models; JSON always valid.
- [ ] done

### 02.4 — Style Bible + cast (generate-once anchors)
- **Do:** `generate/anchors.ts` — generate ONE Style Bible keyframe (stylist role, capture
  `seed`) and ONE reference sheet per `AssetCard` (panel-artist, capture per-asset `seed`),
  persisted as images + into the doc. Skip if already present (idempotent).
- **Files:** `services/comicDoc/generate/anchors.ts`.
- **Accept:** Re-running doesn't regenerate existing anchors; anchors stored with seeds.
- [ ] done

### 02.5 — Scoped ReferencePack builder
- **Do:** `generate/referencePack.ts` — per panel, assemble Style Bible keyframe + only
  the **bound cast** reference sheets + 1–2 neighbor panel images. Replaces the
  "all entities every prompt" waste.
- **Files:** `services/comicDoc/generate/referencePack.ts`.
- **Accept:** A panel with 2 of 6 characters references exactly those 2 (+ style +
  neighbors), not all 6.
- [ ] done

### 02.6 — Page-composite renderer
- **Do:** `generate/render.ts` — for each page, build the composite prompt (layout +
  panel briefs + ReferencePack + Style Bible + derived `page.seed`), call panel-artist,
  store the page `RasterLayer`. **Check the result cache first (02.8).** Draft resolution;
  "render final" per page deferred to editor.
- **Files:** `services/comicDoc/generate/render.ts`.
- **Accept:** A 6-page book renders ≈ 6 image calls (+ anchors); pages show consistent
  cast; identical re-render hits cache ($0).
- [ ] done

### 02.7 — Auto-lettering as editable layers
- **Do:** `generate/letter.ts` — place `BubbleLayer`s per panel dialogue plan using the
  existing auto-layout heuristic (`services/bubbleLayout.ts`), **not baked** into art.
- **Files:** `services/comicDoc/generate/letter.ts`.
- **Accept:** Rendered pages carry editable bubble layers positioned sensibly; no text
  baked into the raster.
- [ ] done

### 02.8 — Result cache population + cost preview
- **Do:** Wire the Sprint-01 result cache into render/anchor calls (get→hit returns
  cached image; miss→generate→put). Extend `services/costProjection.ts` to a pre-run
  estimate ("≈ X image calls ≈ $Y, Z cached/free") shown on the Create button and a
  per-op estimate.
- **Files:** `services/comicDoc/resultCache.ts`, `services/costProjection.ts`,
  `components/CostChip.tsx`.
- **Accept:** Cost preview shows before Create; re-running a book is mostly cache hits;
  spend chip reflects real settled cost.
- [ ] done

### 02.9 — Create screen + run + reader
- **Do:** `components/create/CreateComic.tsx` — one screen (script/idea box, style picker
  +Auto, format preset, length), **Create** runs aggregate→anchors→render→letter→assemble
  with streamed progress, lands in the existing reader. Replaces the multi-engine entry.
- **Files:** `components/create/CreateComic.tsx`, `App.tsx` routing (`/create`),
  `components/ComicReader.tsx` (read the `ComicDoc`).
- **Accept:** Idea → finished readable book in one flow, under a previewed cost, with
  consistent characters; no wizard, no engine choice.
- [ ] done

## Out of scope
- Editing anything (Sprint 3+). Region edit, variations (5/6). Final upscaling (later).

## Definition of done (sprint)
- [ ] 02.1–02.9 checked
- [ ] Owner can take an idea → readable 6–12 page book on their OpenRouter key, cost
      previewed + confirmed, characters recognizably consistent
- [ ] Re-open / re-run is cache-cheap; no "all entities" prompt waste; seeds recorded
- [ ] Typecheck/build/tests clean; four docs updated; branch pushed; draft PR
