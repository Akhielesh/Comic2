# DECISIONS — Comic Studio (ADR log)

One entry per non-obvious decision. Newest first. Keep them short: context →
decision → consequences. When a decision is reversed, add a new entry that
supersedes the old (don't delete history).

---

## D4 — Editing v1 = a layer-based canvas (bubbles, region-edit, regen)
**Date:** 2026-06-05 · **Status:** ✅ accepted (owner)
**Context:** The owner wants "Adobe but AI" editing — drag/drop/resize speech
bubbles of many designs, layer-on-layer compositing, circle-to-edit, single-panel
regen+variations. Today the smallest edit unit is a whole panel/page; no
canvas/mask/layers exist.
**Decision:** v1 editing centers on a **layer-based comic canvas**. Must-haves:
(1) draggable/resizable/restylable bubbles from a parametric library, layer-on-layer;
(2) circle/region-to-edit via masked inpaint; (3) single-panel regen + variations;
(4) on-canvas dialogue. **Deferred to fast-follow:** object/character pose-swap.
**Consequences:** Net-new canvas surface (Sprint 3), bubble system (4), inpaint
mask pipeline (5). Drives the layer-native Comic Document model (D2).

## D3 — Cost model v1 = BYOK / personal-first
**Date:** 2026-06-05 · **Status:** ✅ accepted (owner)
**Context:** Owner needs to *use* the product soon and doesn't want to burn API
spend. Image generation is expensive + inconsistent.
**Decision:** v1 is **bring-your-own-key**, personal-first. **No platform billing**
(CT credits / Stripe) in the v1 user path — keep that code but flag its UI off. Invest
instead in **token-optimization, result caching, scoped prompts, and cost preview**
so the owner's own keys aren't wasted.
**Consequences:** First-run BYOK key screen (Sprint 0). Billing UI behind
`VITE_BILLING_UI_ENABLED=false`. Re-activating platform credits is a post-v1
multi-tenant task. See `06-COST-AND-CONTEXT.md`.

## D2 — Engine = page-first hybrid on one Comic Document model
**Date:** 2026-06-05 · **Status:** ✅ accepted (owner)
**Context:** Three engines coexist (Classic per-panel = live; ComicForge staged =
dormant stub; PageStudio single-sheet = newest). They duplicate prompt-building,
routing, continuity, persistence. Owner wants: quick input → AI aggregates a comic
book → user can dive deeper; a "solid base template" custom features extend.
**Decision:** Standardize on a **page-first hybrid**: default to **page-composite**
rendering (fast, fewer image calls) and allow **explode-to-panels** for precision
edits — all on **one canonical Comic Document** (book → pages → panels → layers +
shared Style Bible / Cast / Continuity). Classic + PageStudio collapse into this;
ComicForge's async worker + normalized schema are kept as an optional batch-render
backend, not the v1 path.
**Consequences:** Sprint 1 builds the document model + migrator; Sprint 2 the
quick engine; legacy `pipelineMode` retained only for migration. See
`03-ARCHITECTURE.md`.

## D1 — Scope = Comic Studio only
**Date:** 2026-06-05 · **Status:** ✅ accepted (owner)
**Context:** The repo ships four products (Comic, AI Chat, Code Studio, Model
Library) in one codebase, diluting focus and causing the "confusing" feel.
**Decision:** Invest **only** in the Comic Studio. AI Chat (`components/chat/*`) and
Code Studio (`server/src/ai/studio/*`, `studio-worker/`, `docs/studio/*`) become
**frozen legacy** — not deleted, but no new features; hidden from the default nav;
eventually extractable into their own repos.
**Consequences:** Sprint 0 fences them behind `VITE_SHOW_LEGACY_PRODUCTS` (default
off) and makes Comic the default landing. Don't refactor frozen code.

---

## Technical decisions still OPEN (decide in the noted sprint)

| ID | Question | Leaning | Decide in |
|---|---|---|---|
| T1 | Canvas library for the layer editor | `react-konva` (raster+vector layers, good export control); evaluate `tldraw` as a faster-to-stand-up alternative | Sprint 3 |
| T2 | Inpaint/region-edit provider + mask transport | OpenRouter image-edit model w/ image+mask parts; add `mask` (data URL) to `POST /api/image/*` and `services/imageService.ts`; flip `ENABLE_INPAINTING` | Sprint 5 |
| T3 | Seed transport on the unified path | Add `seed` to `GenerateImageRequest` (`server/src/ai/providers/types.ts`) and forward in the OpenRouter provider (currently dropped) | Sprint 2/6 |
| T4 | Result cache store | Content-hash key `(promptHash + refsHash + seed + model + size)` → persisted (Supabase table or KV); start with a durable table, add Redis/KV if a worker returns | Sprint 2 |
| T5 | Keep ComicForge async worker for batch page renders? | Yes for "render whole book" jobs; not v1 quick path | Sprint 6 |
